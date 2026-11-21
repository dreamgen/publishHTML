/**
 * 圖片壓縮、快取與本機 IndexedDB 儲存
 *
 * - 瀏覽器端自動轉正 EXIF 方向、縮放至長邊 1280px 以內、JPEG 壓縮至 <= 250KB
 * - 記憶體快取 + inflight 去重，避免同一張照片重複下載
 * - 本機模式使用 IndexedDB 儲存圖片，避免塞爆 localStorage 5MB 上限
 */

export const MAX_EDGE = 1280;
export const MAX_DATAURL = 250 * 1024;
const QUALITY_START = 0.82;
const QUALITY_MIN = 0.48;
const QUALITY_STEP = 0.08;
const SHRINK = 0.8;
const MIN_EDGE = 320;

const memCache = new Map();
const inflight = new Map();

const IDB_NAME = 'itemInventory_images';
const IDB_STORE = 'images';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPutImage(key, dataUrl) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(dataUrl, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGetImage(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || '');
    req.onerror = () => reject(req.error);
  });
}

export async function idbDeleteImage(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function looksLikeImage(file) {
  if (!file) return false;
  if (file.type) return file.type.startsWith('image/');
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(file.name || '');
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close && bmp.close() };
    } catch {
      // fallback to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('無法讀取圖片格式，請改用 JPG 或 PNG'));
      el.src = url;
    });
    return { source: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height, done: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 將 File 壓縮為適合即時同步的 JPEG dataURL
 * @param {File} file
 * @returns {Promise<{ dataUrl: string, w: number, h: number, bytes: number }>}
 */
export async function compressImageFile(file) {
  if (!looksLikeImage(file)) {
    throw new Error('這個檔案不是圖片，請選取 JPG、PNG 或拍照。');
  }
  const decoded = await decodeImage(file);
  try {
    let { w, h } = decoded;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('瀏覽器不支援 Canvas 圖片處理');

    let dataUrl = '';
    while (true) {
      canvas.width = w;
      canvas.height = h;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(decoded.source, 0, 0, w, h);

      let q = QUALITY_START;
      while (q >= QUALITY_MIN) {
        dataUrl = canvas.toDataURL('image/jpeg', q);
        if (dataUrl.length <= MAX_DATAURL) break;
        q -= QUALITY_STEP;
      }
      if (dataUrl.length <= MAX_DATAURL || Math.max(w, h) <= MIN_EDGE) break;

      w = Math.max(MIN_EDGE, Math.round(w * SHRINK));
      h = Math.max(MIN_EDGE, Math.round(h * SHRINK));
    }

    const bytes = Math.round((dataUrl.length * 3) / 4);
    return { dataUrl, w, h, bytes };
  } finally {
    decoded.done();
  }
}

export function getCachedImage(cacheKey) {
  return memCache.get(cacheKey) || '';
}

export function setCachedImage(cacheKey, dataUrl) {
  if (cacheKey && dataUrl) memCache.set(cacheKey, dataUrl);
}

export function deleteCachedImage(cacheKey) {
  memCache.delete(cacheKey);
}

/**
 * 帶快取與並發去重的圖片載入器
 * @param {string} cacheKey
 * @param {() => Promise<string>} fetcher
 */
export async function loadImageWithCache(cacheKey, fetcher) {
  if (!cacheKey) return '';
  if (memCache.has(cacheKey)) return memCache.get(cacheKey);
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const p = (async () => {
    try {
      const dataUrl = await fetcher();
      if (dataUrl) memCache.set(cacheKey, dataUrl);
      return dataUrl || '';
    } finally {
      inflight.delete(cacheKey);
    }
  })();
  inflight.set(cacheKey, p);
  return p;
}
