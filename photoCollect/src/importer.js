// 貼共用連結匯入：Google 相簿公開分享相簿（非官方解析，參考 PPTPlayer-V2 googlePhotosAlbum.js）
// 與 Google 雲端硬碟「知道連結的任何人」資料夾／檔案（Drive API v3＋伺服器端 API 金鑰）。
//
// 流程：POST import/list 解析連結 → 清單存 R2（events/{id}/imports/{aid}.json，1 天）
//      → GET import/thumb/{aid}/{uid} 代理縮圖 → POST import/photo 一次匯入一張（Worker 直接向 Google 取檔寫入 R2）
// 安全：只連 Google 網域、每一跳轉址都檢查；只下載清單內的項目；上傳碼驗證＋速率限制＋每日上限。
import { HttpError, json, readJson, sha256Hex, MIME_EXT, clip } from './util.js';
import { derive, getConfig, mutateConfig } from './config.js';
import { resolveUpload, buildMetadata, checkRate } from './upload.js';
import { loadPhotos, noteUploaded } from './stats.js';
import { recordUploadSafe, uploadSession } from './account.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_PAGES = 10;
const MAX_ITEMS = 1000;
const LIST_TTL_MS = 24 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' };
const ALBUM_HOSTS = new Set(['photos.app.goo.gl', 'goo.gl', 'photos.google.com']);
const LH3_RE = /^https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]+/;
const BATCH_URL = 'https://photos.google.com/_/PhotosUi/data/batchexecute';
const RPC_ALBUM_PAGE = 'snAcKc';
const VIDEO_META_KEY = '76647426';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_THUMB = 'https://drive.google.com/thumbnail';
const ALLOWED_FETCH_HOSTS = new Set([...ALBUM_HOSTS, 'lh3.googleusercontent.com', 'www.googleapis.com', 'drive.google.com']);

const importError = (status, code, message) => new HttpError(status, code, message);

// ---------- 抓取（僅 Google 網域；本機測試可導向假伺服器） ----------
// 本機測試：DEV_MODE=1 且設定 IMPORT_TEST_ORIGIN 時，https://{host}/{path} 改成 {origin}/{host}/{path}
function testOrigin(env) {
  return env && env.DEV_MODE === '1' && typeof env.IMPORT_TEST_ORIGIN === 'string' && env.IMPORT_TEST_ORIGIN ? env.IMPORT_TEST_ORIGIN.replace(/\/+$/, '') : '';
}
async function gfetch(env, url, init = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_FETCH_HOSTS.has(u.hostname)) throw importError(400, 'bad_source', '只支援 Google 相簿與 Google 雲端硬碟的連結。');
  const origin = testOrigin(env);
  const target = origin ? `${origin}/${u.hostname}${u.pathname}${u.search}` : url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(target, { ...init, headers: { ...HEADERS, ...(init.headers || {}) }, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw importError(504, 'source_timeout', '讀取 Google 逾時，請稍後再試。');
    throw importError(502, 'source_fetch_failed', '無法連線 Google，請稍後再試。');
  } finally {
    clearTimeout(timer);
  }
}

// 時間：Google 相簿給 UTC 毫秒；活動照片一律記「當地時間」字串（預設 UTC+8，可用 IMPORT_TZ_OFFSET_MIN 調整）
function localIsoFromMs(ms, env) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const off = Number.isFinite(Number(env && env.IMPORT_TZ_OFFSET_MIN)) && env.IMPORT_TZ_OFFSET_MIN !== undefined ? Number(env.IMPORT_TZ_OFFSET_MIN) : 480;
  return new Date(ms + off * 60000).toISOString().slice(0, 19);
}
// Drive 的 EXIF 時間「2026:11:09 10:15:00」→「2026-11-09T10:15:00」
function isoFromExif(s) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : '';
}

// ---------- 連結辨識 ----------
export function classifyUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (ALBUM_HOSTS.has(u.hostname)) {
    if (u.hostname === 'goo.gl' && !u.pathname.startsWith('/photos/')) return null;
    if (u.hostname === 'photos.google.com' && !/\/share\//.test(u.pathname)) return null;
    if (u.pathname.length <= 1) return null;
    return { source: 'gphotos', url: u.toString() };
  }
  if (u.hostname === 'drive.google.com') {
    const rk = u.searchParams.get('resourcekey') || '';
    let m = /\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
    if (m) return { source: 'gdrive', kind: 'folder', id: m[1], rk };
    m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
    if (m) return { source: 'gdrive', kind: 'file', id: m[1], rk };
    const id = u.searchParams.get('id');
    if ((u.pathname === '/open' || u.pathname === '/uc') && id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return { source: 'gdrive', kind: 'unknown', id, rk };
  }
  return null;
}

// ---------- Google 相簿：公開分享相簿解析 ----------
const isShortHost = (url) => { try { return ['photos.app.goo.gl', 'goo.gl'].includes(new URL(url).hostname); } catch { return false; } };
// 短網址一般請求只回 200 的中繼頁，要帶 ?_imcp=1 才會 302 到 photos.google.com/share/…（PPTPlayer-V2 2026-10-21 實測）
function withImcp(url) {
  try {
    const u = new URL(url);
    if (isShortHost(url) && !u.searchParams.has('_imcp')) { u.searchParams.set('_imcp', '1'); return u.toString(); }
  } catch { /* 保持原樣 */ }
  return url;
}
async function fetchAlbumHtml(env, inputUrl) {
  let url = withImcp(inputUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await gfetch(env, url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw importError(502, 'source_fetch_failed', '相簿網址轉址失敗。');
      const next = new URL(loc, url).toString();
      const c = classifyUrl(next);
      if (!(c && c.source === 'gphotos') && !isShortHost(next)) {
        throw importError(422, 'album_not_public', '這個相簿不是公開分享。請在 Google 相簿按「分享 → 建立連結」後再貼上。');
      }
      url = withImcp(next);
      continue;
    }
    if (res.status === 404) throw importError(404, 'album_not_found', '找不到這個相簿，請確認連結是否完整。');
    if (!res.ok) throw importError(502, 'source_fetch_failed', `Google 相簿回應錯誤（${res.status}）。`);
    if (isShortHost(url)) throw importError(422, 'short_link_unresolved', '無法解析這個短網址。請在瀏覽器打開相簿，改貼網址列的 photos.google.com/share/… 完整網址。');
    return { html: await res.text(), finalUrl: url };
  }
  throw importError(502, 'source_fetch_failed', '相簿網址轉址次數過多。');
}

// 從 `{key: 'ds:1', …, data:[...]}` 取出 data 陣列（括號配對，略過字串內容）
function extractDataArray(block) {
  const start = block.indexOf('data:');
  if (start < 0) return null;
  const i = block.indexOf('[', start);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < block.length; j++) {
    const c = block[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { try { return JSON.parse(block.slice(i, j + 1)); } catch { return null; } }
    }
  }
  return null;
}
const lh3Base = (url) => { const m = String(url).match(LH3_RE); return m ? m[0] : null; };
function parseAlbumItem(e) {
  if (!Array.isArray(e) || typeof e[0] !== 'string' || !Array.isArray(e[1])) return null;
  const [url, w, h] = e[1];
  const base = typeof url === 'string' ? lh3Base(url) : null;
  if (!base) return null;
  const meta = e.find((x) => x && typeof x === 'object' && !Array.isArray(x));
  return {
    uid: e[0], base, w: typeof w === 'number' ? w : 0, h: typeof h === 'number' ? h : 0,
    takenAt: typeof e[2] === 'number' ? e[2] : null, addedAt: typeof e[5] === 'number' ? e[5] : null,
    isVideo: !!(meta && Object.prototype.hasOwnProperty.call(meta, VIDEO_META_KEY)),
  };
}
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
export function parseAlbumHtml(html, finalUrl) {
  const blocks = [...html.matchAll(/AF_initDataCallback\((\{[\s\S]*?)\);<\/script>/g)].map((m) => m[1]);
  let data = null;
  for (const b of blocks) {
    const d = extractDataArray(b);
    if (Array.isArray(d) && Array.isArray(d[1]) && d[1].some((e) => parseAlbumItem(e))) {
      if (!data || d[1].length > data[1].length) data = d;
    }
  }
  if (!data) {
    if (/og:title/.test(html) && blocks.length) throw importError(422, 'album_empty', '相簿裡沒有可匯入的照片。');
    throw importError(502, 'album_parse_failed', '無法解析這個相簿（Google 可能改了頁面格式），請改用手機直接上傳。');
  }
  const details = Array.isArray(data[3]) ? data[3] : [];
  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1];
  const canonical = decodeEntities((html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || finalUrl);
  let key = null;
  try { key = new URL(canonical).searchParams.get('key'); } catch { /* 略過 */ }
  if (!key) { try { key = new URL(finalUrl).searchParams.get('key'); } catch { /* 略過 */ } }
  const title = (typeof details[1] === 'string' && details[1].trim()) || (ogTitle ? decodeEntities(ogTitle).split(' · ')[0].trim() : '') || 'Google 相簿';
  return {
    albumId: typeof details[0] === 'string' ? details[0] : null, title, key,
    token: typeof data[2] === 'string' && data[2] ? data[2] : null,
    items: data[1].map(parseAlbumItem).filter(Boolean),
  };
}
async function fetchNextAlbumPage(env, albumId, token, key) {
  const fReq = JSON.stringify([[[RPC_ALBUM_PAGE, JSON.stringify([albumId, token, null, key]), null, 'generic']]]);
  const res = await gfetch(env, BATCH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  if (!res.ok) return null;
  const text = (await res.text()).replace(/^\)\]\}'/, '');
  for (const line of text.split('\n')) {
    if (!line.includes(RPC_ALBUM_PAGE)) continue;
    try {
      const outer = JSON.parse(line);
      const hit = outer.find((x) => Array.isArray(x) && x[1] === RPC_ALBUM_PAGE);
      if (!hit || typeof hit[2] !== 'string') continue;
      const inner = JSON.parse(hit[2]);
      return { items: Array.isArray(inner[1]) ? inner[1].map(parseAlbumItem).filter(Boolean) : [], token: typeof inner[2] === 'string' && inner[2] ? inner[2] : null };
    } catch { /* 下一行 */ }
  }
  return null;
}
async function listGooglePhotos(env, url) {
  const { html, finalUrl } = await fetchAlbumHtml(env, url);
  const first = parseAlbumHtml(html, finalUrl);
  const items = [...first.items];
  let token = first.token;
  let pages = 1;
  while (token && first.albumId && first.key && items.length < MAX_ITEMS && pages < MAX_PAGES) {
    const next = await fetchNextAlbumPage(env, first.albumId, token, first.key).catch(() => null);
    if (!next || !next.items.length) break;
    items.push(...next.items);
    token = next.token;
    pages++;
  }
  const seen = new Set();
  const photos = items.filter((x) => !x.isVideo && !seen.has(x.uid) && seen.add(x.uid)).slice(0, MAX_ITEMS);
  if (!photos.length) throw importError(422, 'album_empty', '相簿裡沒有可匯入的照片。');
  return {
    source: 'gphotos', title: first.title, truncated: !!token || items.length > MAX_ITEMS,
    items: photos.map((p) => ({ uid: `gp:${p.uid}`, src: p.base, w: p.w, h: p.h, taken: localIsoFromMs(p.takenAt ?? p.addedAt, env), mime: 'image/jpeg' })),
  };
}

// ---------- Google 雲端硬碟：公開資料夾／檔案 ----------
const DRIVE_FIELDS = 'id,name,mimeType,size,resourceKey,thumbnailLink,imageMediaMetadata(time,width,height)';
function driveKey(env) {
  const k = typeof env.GOOGLE_API_KEY === 'string' ? env.GOOGLE_API_KEY.trim() : '';
  if (!k) throw importError(503, 'drive_disabled', '主辦單位還沒設定雲端硬碟匯入，請改貼 Google 相簿連結或直接上傳。');
  return k;
}
const rkHeader = (pairs) => {
  const v = pairs.filter(([, rk]) => rk).map(([id, rk]) => `${id}/${rk}`).join(',');
  return v ? { 'X-Goog-Drive-Resource-Keys': v } : {};
};
async function driveJson(env, url, headers) {
  const res = await gfetch(env, url, { headers });
  if (res.status === 404 || res.status === 403) {
    throw importError(422, 'drive_not_public', '讀不到這個雲端硬碟連結。請在雲端硬碟按「共用 → 一般存取權：知道連結的任何人」後再貼上。');
  }
  if (res.status === 400) throw importError(400, 'drive_bad_link', '雲端硬碟連結格式不正確。');
  if (res.status === 429) throw importError(429, 'drive_rate_limited', 'Google 雲端硬碟暫時限制存取，請稍後再試。');
  if (!res.ok) throw importError(502, 'source_fetch_failed', `Google 雲端硬碟回應錯誤（${res.status}）。`);
  return res.json();
}
const isImageMime = (m) => typeof m === 'string' && m.startsWith('image/');
function driveItem(f) {
  const md = f.imageMediaMetadata || {};
  return {
    uid: `gd:${f.id}`, src: f.id, rk: f.resourceKey || '', name: clip(f.name || '', 80), mime: f.mimeType,
    size: Number(f.size) || 0, w: Number(md.width) || 0, h: Number(md.height) || 0, taken: isoFromExif(md.time),
    thumb: typeof f.thumbnailLink === 'string' ? f.thumbnailLink : '',
  };
}
async function listDrive(env, c) {
  const key = driveKey(env);
  const meta = await driveJson(env, `${DRIVE_API}/${c.id}?fields=${encodeURIComponent(`${DRIVE_FIELDS}`)}&supportsAllDrives=true&key=${key}`, rkHeader([[c.id, c.rk]]));
  if (meta.mimeType !== 'application/vnd.google-apps.folder') {
    if (!isImageMime(meta.mimeType)) throw importError(422, 'album_empty', '這個雲端硬碟檔案不是照片。');
    return { source: 'gdrive', title: meta.name || '雲端硬碟檔案', truncated: false, items: [driveItem(meta)] };
  }
  // 資料夾：本層照片＋第一層子資料夾的照片（最多 20 個子資料夾）
  const items = [];
  const folders = [[c.id, c.rk]];
  let truncated = false;
  const listFolder = async (fid, frk, collectFolders) => {
    let pageToken = '';
    for (let p = 0; p < MAX_PAGES; p++) {
      const q = `'${fid}' in parents and trashed=false and (mimeType contains 'image/'${collectFolders ? " or mimeType='application/vnd.google-apps.folder'" : ''})`;
      const url = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${DRIVE_FIELDS})`)}&pageSize=1000&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${key}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await driveJson(env, url, rkHeader([[fid, frk]]));
      for (const f of r.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') { if (collectFolders && folders.length < 21) folders.push([f.id, f.resourceKey || '']); else if (collectFolders) truncated = true; }
        else if (isImageMime(f.mimeType) && items.length < MAX_ITEMS) items.push(driveItem(f));
        else if (isImageMime(f.mimeType)) truncated = true;
      }
      pageToken = r.nextPageToken || '';
      if (!pageToken || items.length >= MAX_ITEMS) break;
    }
    if (pageToken) truncated = true;
  };
  await listFolder(c.id, c.rk, true);
  for (const [fid, frk] of folders.slice(1)) {
    if (items.length >= MAX_ITEMS) { truncated = true; break; }
    await listFolder(fid, frk, false);
  }
  if (!items.length) throw importError(422, 'album_empty', '資料夾裡沒有照片（或子資料夾超過一層）。');
  items.sort((a, b) => (a.taken || '9').localeCompare(b.taken || '9') || a.name.localeCompare(b.name));
  return { source: 'gdrive', title: meta.name || '雲端硬碟資料夾', truncated, items };
}

// ---------- 清單快取（R2） ----------
const listKey = (id, aid) => `events/${id}/imports/${aid}.json`;
async function saveList(env, cfg, aid, list) {
  await env.PHOTOS.put(listKey(cfg.id, aid), JSON.stringify({ ...list, at: Date.now() }), { httpMetadata: { contentType: 'application/json' } });
}
async function loadList(env, cfg, aid) {
  if (!/^[0-9a-f]{16}$/.test(aid)) throw importError(400, 'invalid', '匯入代碼格式不正確。');
  const o = await env.PHOTOS.get(listKey(cfg.id, aid));
  if (!o) throw importError(410, 'list_expired', '匯入清單已過期，請重新貼上連結。');
  const d = await o.json();
  if (!d || Date.now() - (d.at || 0) > LIST_TTL_MS) throw importError(410, 'list_expired', '匯入清單已過期，請重新貼上連結。');
  return d;
}

function importSettings(cfg) {
  const u = cfg.upload || {};
  return { enabled: u.import_enabled !== false, daily: Number.isInteger(u.import_daily) ? u.import_daily : 1500 };
}
async function resolveForImport(env, code) {
  const cfg = await resolveUpload(env, code);
  if (!derive(cfg).is_open) throw importError(403, 'upload_closed', '目前不開放上傳。');
  if (!importSettings(cfg).enabled) throw importError(403, 'import_disabled', '主辦者關閉了連結匯入，請直接上傳照片。');
  return cfg;
}
// 今天（UTC+8）已匯入幾張：以照片 metadata 的 src 與上傳時間計算（統計快取 30 秒）
function todayImported(photos) {
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return photos.filter((p) => p.src && p.uploaded_at && new Date(Date.parse(p.uploaded_at) + 8 * 3600000).toISOString().slice(0, 10) === day).length;
}

// POST /api/u/{code}/import/list  { url }
export async function list(env, code, req) {
  checkRate(req);
  const cfg = await resolveForImport(env, code);
  const body = await readJson(req, 8 * 1024);
  const c = classifyUrl(body.url);
  if (!c) throw importError(400, 'bad_source', '請貼上 Google 相簿分享連結（photos.app.goo.gl/… 或 photos.google.com/share/…）或雲端硬碟資料夾／檔案連結。');
  const data = c.source === 'gphotos' ? await listGooglePhotos(env, c.url) : await listDrive(env, c);
  const aid = (await sha256Hex(`${cfg.id}|${String(body.url).trim()}`)).slice(0, 16);
  await saveList(env, cfg, aid, data);
  const { photos } = await loadPhotos(env, cfg.id);
  const have = new Set(photos.map((p) => p.src).filter(Boolean));
  const st = importSettings(cfg);
  return json({
    aid, source: data.source, title: data.title, truncated: data.truncated, count: data.items.length,
    daily_limit: st.daily, daily_left: Math.max(0, st.daily - todayImported(photos)),
    items: data.items.map((it) => ({ uid: it.uid, w: it.w, h: it.h, taken: it.taken, name: it.name || '', have: have.has(it.uid) })),
  });
}

// GET /api/u/{code}/import/thumb/{aid}/{uid}
export async function thumb(env, code, aid, uid) {
  const cfg = await resolveUpload(env, code);
  const d = await loadList(env, cfg, aid);
  const it = d.items.find((x) => x.uid === uid);
  if (!it) throw importError(404, 'not_found', '清單裡沒有這張照片。');
  const res = await fetchThumb(env, d.source, it, 320);
  if (!res) throw importError(404, 'not_found', '沒有預覽圖。');
  return new Response(res.body, {
    headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=3600', 'content-security-policy': "default-src 'none'; sandbox" },
  });
}
async function fetchThumb(env, source, it, size) {
  const urls = source === 'gphotos'
    ? [`${it.src}=w${size}-h${size}`]
    : [...(it.thumb ? [it.thumb.replace(/=s\d+$/, `=s${size}`)] : []), `${DRIVE_THUMB}?id=${it.src}&sz=w${size}`];
  for (const u of urls) {
    try {
      const r = await gfetch(env, u, it.rk ? { headers: rkHeader([[it.src, it.rk]]) } : {});
      if (r.ok && String(r.headers.get('content-type') || '').startsWith('image/')) return r;
    } catch { /* 試下一個 */ }
  }
  return null;
}

// POST /api/u/{code}/import/photo  { aid, uid, original?, groups?, segment?, uploader?, device? }
export async function photo(env, code, req) {
  checkRate(req);
  const cfg = await resolveForImport(env, code);
  const body = await readJson(req, 8 * 1024);
  const d = await loadList(env, cfg, String(body.aid || ''));
  const it = d.items.find((x) => x.uid === body.uid);
  if (!it) throw importError(404, 'not_found', '清單裡沒有這張照片。');
  const { photos } = await loadPhotos(env, cfg.id);
  const dupBySrc = photos.find((p) => p.src === it.uid);
  if (dupBySrc) return json({ ok: true, duplicate: true, hash: dupBySrc.hash });
  const st = importSettings(cfg);
  if (todayImported(photos) >= st.daily) throw importError(429, 'import_daily_limit', `這個活動今天的連結匯入已達 ${st.daily} 張上限，明天再試或直接上傳。`);
  if (photos.length >= cfg.upload.max_photos) throw importError(409, 'event_full', '這個活動的照片數量已達上限。');

  // 取檔：相簿預設長邊 2560（勾原圖改 =d）；雲端硬碟原檔不超過上限就取原檔，否則取 2560 預覽
  const maxBytes = cfg.upload.max_mb * 1024 * 1024;
  const original = body.original === true;
  let res = null;
  if (d.source === 'gphotos') {
    res = await gfetch(env, `${it.src}${original ? '=d' : '=w2560-h2560'}`);
  } else {
    const key = driveKey(env);
    if (it.size && it.size <= maxBytes && MIME_EXT[it.mime]) {
      res = await gfetch(env, `${DRIVE_API}/${it.src}?alt=media&supportsAllDrives=true&key=${key}`, { headers: rkHeader([[it.src, it.rk]]) });
    }
    if (!res || !res.ok) res = await fetchThumb(env, 'gdrive', it, 2560);
  }
  if (!res || res.status === 403 || res.status === 404) throw importError(410, 'source_gone', '這張照片已無法存取（可能已取消分享或刪除）。');
  if (!res.ok) throw importError(502, 'source_fetch_failed', `從 Google 下載失敗（${res.status}）。`);
  const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw importError(415, 'bad_type', '只接受 JPEG、PNG、WebP、HEIC、GIF 圖片。');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw importError(413, 'too_large', `檔案超過 ${cfg.upload.max_mb} MB 上限。`);
  if (!buf.byteLength) throw importError(502, 'source_fetch_failed', '下載到空檔案。');
  const h = await hashBytes(buf);

  const prefix = `events/${cfg.id}/p/${h}.`;
  const exist = await env.PHOTOS.list({ prefix, limit: 1 });
  if (exist.objects.length) return json({ ok: true, duplicate: true, hash: h });

  // 縮圖：向 Google 再取 320px 版
  let thumbBuf = null;
  try {
    const t = await fetchThumb(env, d.source, it, 320);
    if (t && String(t.headers.get('content-type') || '').startsWith('image/jpeg')) {
      const tb = await t.arrayBuffer();
      if (tb.byteLength > 0 && tb.byteLength <= 512 * 1024) thumbBuf = tb;
    }
  } catch { /* 沒縮圖也可以 */ }
  if (thumbBuf) await env.PHOTOS.put(`events/${cfg.id}/t/${h}.jpg`, thumbBuf, { httpMetadata: { contentType: 'image/jpeg' } });

  const sess = await uploadSession(env, req);
  const meta = {
    hash: h, orig_name: it.name || `${d.source === 'gphotos' ? 'Google 相簿' : '雲端硬碟'}照片`,
    uploader: body.uploader, device: body.device, groups: body.groups, segment: body.segment,
    exif_time: it.taken || '', time_src: it.taken ? 'exif' : '', w: it.w, h: it.h, original: original ? '1' : '',
  };
  const md = buildMetadata(meta, h, null, !!thumbBuf, cfg, { sub: sess ? sess.sub : '' });
  md.src = it.uid; // 來源：gp:{相簿照片 uid}／gd:{雲端硬碟檔案 id}，用來避免重複匯入
  const put = await env.PHOTOS.put(`${prefix}${ext}`, buf, { httpMetadata: { contentType: mime }, customMetadata: md, onlyIf: { etagDoesNotMatch: '*' } });
  if (put === null) return json({ ok: true, duplicate: true, hash: h });
  const latest = await getConfig(env, cfg.id);
  if (!latest || latest.deleted_at) {
    await env.PHOTOS.delete([`${prefix}${ext}`, `events/${cfg.id}/t/${h}.jpg`]);
    throw importError(403, 'upload_closed', '目前不開放上傳。');
  }
  if ((latest.removed || []).includes(h)) {
    try { await mutateConfig(env, latest, async () => getConfig(env, cfg.id), (c) => { c.removed = (c.removed || []).filter((x) => x !== h); }); } catch (e) { console.error('unremove failed', e && e.message); }
  }
  noteUploaded(cfg.id, {
    hash: h, ext, size: buf.byteLength, uploader: md.uploader || '', device: md.device || '',
    groups: JSON.parse(md.groups || '[]'), segment: md.segment || 'auto', exif_time: md.exif_time || '',
    time_src: md.time_src || '', w: Number(md.w) || 0, h: Number(md.h) || 0, uploaded_at: md.uploaded_at,
    original: md.original === '1', has_thumb: !!thumbBuf, note: '', sub: md.sub || '', replaced_from: '', edited_at: '', src: it.uid,
  });
  await recordUploadSafe(env, req, cfg, code);
  return json({ ok: true, duplicate: false, hash: h, segment: md.segment || 'auto', taken: md.exif_time || '' }, 201);
}

async function hashBytes(buf) {
  const dg = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(dg)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
