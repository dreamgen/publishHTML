// 共用工具：回應、錯誤、隨機碼、雜湊、常數時間比較、格式驗證

export const ID_RE = /^ev_[A-Za-z0-9_-]{12}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
export const UPLOAD_CODE_RE = /^[A-Za-z0-9_-]{22}$/;

// 合約 §6 的 CSP
export const CSP =
  "default-src 'self'; img-src 'self' blob: data:; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
  "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// 合約 §8.8：有 Google 登入的頁面（/、/admin、/u/*）的 CSP，在 §6 基礎上加入 Google Identity Services 網域
export const LOGIN_CSP =
  "default-src 'self'; img-src 'self' blob: data: https://lh3.googleusercontent.com; " +
  "style-src 'self' https://fonts.googleapis.com https://accounts.google.com/gsi/style 'unsafe-inline'; " +
  "font-src https://fonts.gstatic.com; script-src 'self' https://accounts.google.com/gsi/client; " +
  "connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// 可預期的錯誤：由路由層轉成 {"error","message"} JSON
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(status, code, message) {
  return json({ error: code, message }, status);
}

// 邊讀邊計算位元組數的 body：超過 maxBytes 就中止串流（不信任可省略或謊報的 Content-Length）
// 回傳 { body, exceeded() }，body 可交給 new Request/Response 再解析
export function limitedBody(req, maxBytes) {
  let n = 0;
  let over = false;
  const ts = new TransformStream({
    transform(chunk, ctrl) {
      n += chunk.byteLength;
      if (n > maxBytes) { over = true; ctrl.error(new HttpError(413, 'too_large', '內容過大。')); return; }
      ctrl.enqueue(chunk);
    },
  });
  return { body: req.body ? req.body.pipeThrough(ts) : null, exceeded: () => over };
}

// 讀整個 body 成文字（上限 maxBytes 位元組）
export async function readTextLimited(req, maxBytes) {
  const cl = Number(req.headers.get('content-length') || 0);
  if (cl > maxBytes) throw new HttpError(413, 'too_large', '內容過大。');
  const lb = limitedBody(req, maxBytes);
  try {
    return await new Response(lb.body).text();
  } catch (e) {
    if (lb.exceeded()) throw new HttpError(413, 'too_large', '內容過大。');
    throw new HttpError(400, 'invalid', '無法讀取請求內容。');
  }
}

// 讀 JSON body（上限 1MB），格式錯誤丟 400 invalid
export async function readJson(req, maxBytes = 1024 * 1024) {
  const text = await readTextLimited(req, maxBytes);
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, 'invalid', '請求內容不是有效的 JSON 物件。');
  }
}

const enc = new TextEncoder();

// 隨機碼：n 個隨機位元組 → base64url（不含 padding）
export function randomCode(nBytes) {
  const buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const newEventId = () => 'ev_' + randomCode(9); // 12 字元
export const newUploadCode = () => randomCode(16); // 22 字元
export const newSecretKey = () => randomCode(24); // 32 字元

export async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 常數時間字串比較（長度不同也走完整迴圈）
export function safeEqual(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// 取 Authorization: Bearer 的值，沒有則回 ''
export function bearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S{1,256})$/i.exec(h);
  return m ? m[1] : '';
}

// base64url ↔ 位元組／字串（不含 padding）
export function bytesToB64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uToBytes(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
export const strToB64u = (s) => bytesToB64u(enc.encode(s));
export const b64uToStr = (s) => new TextDecoder('utf-8', { fatal: true }).decode(b64uToBytes(s));

export const clip = (s, n) => Array.from(String(s ?? '')).slice(0, n).join('');

// 判斷字串是否為合法的「YYYY-MM-DD」日期
export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// 副檔名 ↔ MIME（白名單）
export const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
};
export const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));

// 分享預覽圖：副檔名 ↔ MIME，以及 R2 key（events/{id}/og.png | og.jpg）
export const OG_EXT_MIME = { png: 'image/png', jpg: 'image/jpeg' };
export const ogKey = (id, ext) => `events/${id}/og.${ext}`;
export const OG_KEYS = (id) => Object.keys(OG_EXT_MIME).map((e) => ogKey(id, e));
