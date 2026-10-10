// ──────────────────────────────────────────────────────────────────────────────
// 圖片欄位（type: "image"，每個欄位固定 1 張）
//
// 所有圖片邏輯集中在這裡：瀏覽器端壓縮、上傳、讀取（含記憶體快取）、各種刪除路徑、
// 合併小組時的複製，以及畫面上「縮圖佔位 → 進入畫面才載入」的共用處理。
//
// 資料位置：artifacts/interactiveWorkbook/public/data/images/<CODE>/<gid>/<qid>/<imgId>
//   值：{ data: "data:image/jpeg;base64,...", w, h, bytes, key, createdAt }
// 答案裡該欄位只存 imgId（字串，空字串＝未上傳）。
//
// 為什麼不放在 courses/<CODE> 底下：主監聽（session.js 的 onValue）訂閱整個 courses/<CODE>，
// 圖片若放在裡面，每台裝置在**任何人**存檔時都會把全部圖片重新下載一次（一張約 200KB，
// 30 組 × 數題就是好幾 MB，教室網路撐不住）。獨立子樹只在畫面真的要顯示時用 get() 單張讀取，
// 讀過的放進記憶體快取，同一張不重複下載。
//
// 規約第二節第 5 條原本要求「寫入資料庫的函式集中在 data.js／editlock.js」；圖片是獨立子樹、
// 與課程節點沒有交易關係，所以寫入集中在這個模組（data.js 的刪除／合併路徑會呼叫這裡的清理函式）。
// ──────────────────────────────────────────────────────────────────────────────
import {
  authReady, imageRef, courseRef, get, set, remove,
} from './firebase.js';
import { E, randomId } from './util.js';
import { IMAGE_ID_PATTERN } from './schema.js';
// 循環 import（images → ui → student → images）：只在函式體內使用。
import { imageViewer } from './ui.js';

/** 長邊上限（px） */
export const MAX_EDGE = 1600;
/** dataURL（base64）長度上限：約 300KB 字元 ≈ 220KB 二進位。規則端的硬上限是 700000，這裡留足餘裕。 */
export const MAX_DATAURL = 300 * 1024;
const QUALITY_START = 0.82;
const QUALITY_MIN = 0.5;
const QUALITY_STEP = 0.08;
/** 最低品質仍超過上限時，每次把尺寸再縮成幾倍 */
const SHRINK = 0.8;
/** 縮到這麼小還是超過就不再縮（實務上不會發生：320px 的 JPEG 遠小於上限） */
const MIN_EDGE = 320;

const NOT_IMAGE = '這個檔案不是可讀取的圖片，請改用 JPG 或 PNG。';

/** imgId → dataUrl（讀過的圖片） */
const cache = new Map();
/** imgId → Promise<dataUrl>（讀取中，避免同一張同時發出好幾個 get） */
const inflight = new Map();

const path = (gid, qid, imgId) => [gid, qid, imgId].filter(Boolean).join('/');

/** 是不是合法的圖片 ID（randomId 產生的十六進位字串） */
export const isImageId = (v) => typeof v === 'string' && IMAGE_ID_PATTERN.test(v);

/**
 * 找出一份答案（JSON 字串或物件）裡所有看起來像圖片 ID 的字串值。
 * 只用在「刪除前比對還有沒有人引用」與「存檔後找出被換掉的舊圖」：
 * 誤判一個剛好長得像 ID 的文字值，頂多是對一個不存在的路徑做 remove（無害），不會刪錯圖。
 */
export function imageIdsIn(value) {
  const out = new Set();
  let parsed = value;
  if (typeof value === 'string') {
    if (isImageId(value)) { out.add(value); return out; }
    try { parsed = JSON.parse(value); } catch { return out; }
  }
  const walk = (v) => {
    if (typeof v === 'string') { if (isImageId(v)) out.add(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(parsed);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// 壓縮
// ──────────────────────────────────────────────────────────────────────────────
function looksLikeImage(file) {
  if (!file) return false;
  if (file.type) return file.type.startsWith('image/');
  // 部分 Android 檔案選擇器不給 MIME type，退回看副檔名
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(file.name || '');
}

/**
 * 解碼並套用 EXIF 方向。優先用 createImageBitmap（可明確要求 from-image），
 * 不支援或失敗時退回 <img>：現代瀏覽器的 img 預設 image-orientation: from-image，會自動轉正。
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close && bmp.close() };
    } catch { /* 退回 <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(Error('decode'));
      el.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw Error('decode');
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/**
 * 在瀏覽器端縮圖：長邊最多 1600px、輸出 JPEG，品質從 0.82 往下調直到 dataURL ≤ 約 300KB；
 * 最低品質仍超過就再縮尺寸。透明背景（PNG）先鋪白底，否則轉 JPEG 會變黑。
 * 回傳 { dataUrl, w, h, bytes }（bytes 是解碼後的二進位大小估計）。
 */
export async function compressImage(file) {
  if (!looksLikeImage(file)) throw Error(NOT_IMAGE);
  const decoded = await decode(file);
  if (!decoded) {
    const heic = /heic|heif/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
    throw Error(heic
      ? '這個瀏覽器讀不了 HEIC 格式的照片。請在手機的相機設定改用「最相容」格式，或先轉成 JPG 再上傳。'
      : NOT_IMAGE);
  }
  try {
    const { source, w: srcW, h: srcH } = decoded;
    let edge = Math.min(MAX_EDGE, Math.max(srcW, srcH));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('這個瀏覽器無法處理圖片，請改用較新版本的 Chrome 或 Safari。');
    let last = null;
    for (;;) {
      const scale = edge / Math.max(srcW, srcH);
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      canvas.width = w;
      canvas.height = h;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(source, 0, 0, w, h);
      for (let q = QUALITY_START; q >= QUALITY_MIN - 1e-9; q -= QUALITY_STEP) {
        const dataUrl = canvas.toDataURL('image/jpeg', q);
        if (!dataUrl.startsWith('data:image/jpeg')) throw Error('這個瀏覽器無法把圖片轉成 JPG，請改用較新版本的 Chrome 或 Safari。');
        last = { dataUrl, w, h };
        if (dataUrl.length <= MAX_DATAURL) break;
      }
      if (last.dataUrl.length <= MAX_DATAURL || edge <= MIN_EDGE) break;
      edge = Math.max(MIN_EDGE, Math.floor(edge * SHRINK));
    }
    const comma = last.dataUrl.indexOf(',');
    const bytes = Math.round(((last.dataUrl.length - comma - 1) * 3) / 4);
    return { ...last, bytes };
  } finally {
    decoded.done();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 上傳／讀取／刪除
// ──────────────────────────────────────────────────────────────────────────────
/**
 * 壓縮後寫入 images/<CODE>/<gid>/<qid>/<imgId>，回傳 imgId。答案要按「儲存」才會引用它。
 * onStage（選填）：'compress'／'upload'，給畫面顯示「壓縮中…」「上傳中…」。
 */
export async function uploadImage(code, gid, qid, key, file, onStage) {
  const stage = (s) => { try { if (onStage) onStage(s); } catch { /* 畫面回呼出錯不影響上傳 */ } };
  stage('compress');
  const { dataUrl, w, h, bytes } = await compressImage(file);
  stage('upload');
  await authReady;
  const imgId = randomId(10);
  await set(imageRef(code, path(gid, qid, imgId)), {
    data: dataUrl, w, h, bytes, key: String(key || ''), createdAt: Date.now(),
  });
  cache.set(imgId, dataUrl);
  return imgId;
}

/** 讀一張圖（dataUrl）。讀過的放快取；同一張同時被要求多次只發一次 get。 */
export async function loadImage(code, gid, qid, imgId) {
  if (!isImageId(imgId)) throw Error('圖片 ID 不正確。');
  if (cache.has(imgId)) return cache.get(imgId);
  if (inflight.has(imgId)) return inflight.get(imgId);
  const job = (async () => {
    await authReady;
    const snap = await get(imageRef(code, path(gid, qid, imgId)));
    const val = snap.exists() ? snap.val() : null;
    const data = val && typeof val.data === 'string' && val.data.startsWith('data:image/') ? val.data : '';
    if (!data) throw Error('找不到這張圖片。');
    cache.set(imgId, data);
    return data;
  })();
  inflight.set(imgId, job);
  try { return await job; } finally { inflight.delete(imgId); }
}

/** 快取裡已有的圖（同步），沒有就回傳空字串 */
export const cachedImage = (imgId) => cache.get(imgId) || '';

export async function deleteImage(code, gid, qid, imgId) {
  if (!code || !gid || !qid || !isImageId(imgId)) return;
  await authReady;
  await remove(imageRef(code, path(gid, qid, imgId)));
  cache.delete(imgId);
}

/** 刪除小組時：整組的圖片子樹 */
export async function deleteImagesForGroup(code, gid) {
  if (!code || !gid) return;
  await authReady;
  await remove(imageRef(code, gid));
}

/**
 * 刪除題目／清除本題答案時：逐組刪 images/<CODE>/<gid>/<qid>。
 * opts.gids：要處理的組別（省略時讀課程的 groups 取得）。
 * opts.keep：仍被其他地方引用（例如別題上的封存紀錄）而必須留著的 imgId。
 *   沒有 keep 的組直接刪整個子樹（不必下載圖片）；有 keep 的組才讀出該題的圖逐張判斷。
 */
export async function deleteImagesForQuestion(code, qid, opts = {}) {
  if (!code || !qid) return;
  await authReady;
  let gids = opts.gids;
  if (!gids) {
    const snap = await get(courseRef(code, 'groups'));
    gids = Object.keys((snap.exists() && snap.val()) || {});
  }
  const keep = opts.keep instanceof Set ? opts.keep : new Set(opts.keep || []);
  await Promise.all(gids.map(async (gid) => {
    if (!keep.size) { await remove(imageRef(code, path(gid, qid))); return; }
    const snap = await get(imageRef(code, path(gid, qid)));
    const ids = Object.keys((snap.exists() && snap.val()) || {});
    await Promise.all(ids.filter((id) => !keep.has(id)).map((id) => remove(imageRef(code, path(gid, qid, id)))));
  }));
}

/** 重置課程、刪除整個課程時：整個 images/<CODE> */
export async function deleteImagesForCourse(code) {
  if (!code) return;
  await authReady;
  await remove(imageRef(code));
  cache.clear();
}

/**
 * 合併小組用：把 fromGid 的全部圖片複製到 toGid 底下（同一個 imgId、同一個 qid）。
 * 答案裡只存 imgId、路徑由「答案所在的組」決定，所以複製後被採用的答案不必改寫引用就看得到圖。
 * 回傳複製了哪些 [{ qid, imgId }]，呼叫端在合併完成後刪掉沒被引用的那些。
 */
export async function copyGroupImages(code, fromGid, toGid) {
  await authReady;
  const snap = await get(imageRef(code, fromGid));
  const tree = (snap.exists() && snap.val()) || {};
  const copied = [];
  const writes = [];
  Object.entries(tree).forEach(([qid, byId]) => {
    Object.entries(byId || {}).forEach(([imgId, val]) => {
      if (!isImageId(imgId) || !val || typeof val.data !== 'string') return;
      writes.push(set(imageRef(code, path(toGid, qid, imgId)), val));
      copied.push({ qid, imgId });
    });
  });
  await Promise.all(writes);
  return copied;
}

// ──────────────────────────────────────────────────────────────────────────────
// 畫面：縮圖佔位與延遲載入（學員作答畫面與投影共用）
// ──────────────────────────────────────────────────────────────────────────────
/**
 * 縮圖佔位的 HTML。真正的圖片由 hydrateImages() 在元素進入畫面時才讀。
 * 所有屬性值都經過 E() 跳脫；src 是 dataURL（只含 base64 字元），可直接放進屬性。
 */
export function thumbHTML({ code, gid, qid, imgId, title, cls = '' }) {
  const esc = E;
  const src = cachedImage(imgId);
  // 刻意不用 <button>：學員唯讀時整個 <fieldset> 是 disabled，裡面的按鈕都會失效，但縮圖仍要能點開放大。
  return `<div role="button" tabindex="0" class="img-thumb ${esc(cls)}${src ? ' is-loaded' : ''}" data-img-code="${esc(code)}" data-img-gid="${esc(gid)}" data-img-qid="${esc(qid)}" data-img-id="${esc(imgId)}" data-img-title="${esc(title)}" aria-label="${esc(title)}（按一下放大）">${
    src ? `<img src="${esc(src)}" alt="${esc(title)}">` : '<span class="img-thumb-wait">圖片載入中…</span>'
  }</div>`;
}

let observer = null;
const observed = new Set();

function fill(el) {
  if (el.dataset.imgState) return;
  el.dataset.imgState = 'loading';
  const { imgCode, imgGid, imgQid, imgId, imgTitle } = el.dataset;
  loadImage(imgCode, imgGid, imgQid, imgId).then((src) => {
    if (!el.isConnected) return;
    el.dataset.imgState = 'ok';
    el.classList.add('is-loaded');
    el.innerHTML = '';
    const img = document.createElement('img');
    img.src = src;
    img.alt = imgTitle || '';
    el.appendChild(img);
  }).catch(() => {
    if (!el.isConnected) return;
    el.dataset.imgState = 'error';
    el.classList.add('is-error');
    el.innerHTML = '<span class="img-thumb-wait">圖片讀取失敗</span>';
  });
}

/**
 * 找出 root 底下的縮圖佔位：已在快取的直接顯示，其他的進入畫面才讀（IntersectionObserver），
 * 不支援 IntersectionObserver 的舊瀏覽器直接讀。點縮圖開圖片檢視視窗。
 * 每次重畫後呼叫一次；已從文件移除的舊元素會在這裡被解除觀察。
 */
export function hydrateImages(root) {
  if (!root) return;
  observed.forEach((el) => {
    if (!el.isConnected) { if (observer) observer.unobserve(el); observed.delete(el); }
  });
  root.querySelectorAll('.img-thumb[data-img-id]').forEach((el) => {
    if (el.dataset.imgBound) return;
    el.dataset.imgBound = '1';
    const open = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const src = cachedImage(el.dataset.imgId);
      if (src) imageViewer(el.dataset.imgTitle || '圖片', src);
      else if (el.dataset.imgState !== 'loading') { delete el.dataset.imgState; el.classList.remove('is-error'); fill(el); }
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') open(ev); });
    if (el.classList.contains('is-loaded')) { el.dataset.imgState = 'ok'; return; }
    if (typeof IntersectionObserver !== 'function') { fill(el); return; }
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          observed.delete(entry.target);
          fill(entry.target);
        });
      }, { rootMargin: '200px' });
    }
    observer.observe(el);
    observed.add(el);
  });
}
