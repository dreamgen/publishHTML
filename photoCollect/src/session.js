// 登入 session：cookie `mvs` = base64url(JSON{sub,email,name,picture,exp}) + "." + base64url(HMAC-SHA256)
// exp 為 Unix 秒。無狀態：登出只是清除 cookie。
import { HttpError, bytesToB64u, safeEqual, strToB64u, b64uToStr } from './util.js';

export const COOKIE_NAME = 'mvs';
export const SESSION_MAX_AGE = 30 * 24 * 3600; // 30 天
const enc = new TextEncoder();

// GOOGLE_CLIENT_ID 為空字串或只有空白 ＝ 未設定（功能關閉）
export function googleClientId(env) {
  const v = typeof env?.GOOGLE_CLIENT_ID === 'string' ? env.GOOGLE_CLIENT_ID.trim() : '';
  return v || null;
}

export const sessionSecret = (env) => (typeof env?.SESSION_SECRET === 'string' ? env.SESSION_SECRET : '');

// 登入功能可用 ＝ 有 Client ID 且 SESSION_SECRET 至少 32 字元（否則 cookie 簽章不安全，視同關閉）
export function loginEnabled(env) {
  return !!googleClientId(env) && sessionSecret(env).length >= 32;
}

let keyCache = { secret: '', key: null };
async function hmacKey(secret) {
  if (keyCache.secret === secret && keyCache.key) return keyCache.key;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { secret, key };
  return key;
}

async function sign(secret, text) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text));
  return bytesToB64u(new Uint8Array(sig));
}

// 產生 cookie 值；exp 預設為現在 + 30 天
export async function makeSessionValue(env, user, nowMs = Date.now()) {
  const payload = strToB64u(JSON.stringify({
    sub: user.sub,
    email: user.email,
    name: user.name || '',
    picture: user.picture || '',
    exp: Math.floor(nowMs / 1000) + SESSION_MAX_AGE,
  }));
  return `${payload}.${await sign(sessionSecret(env), payload)}`;
}

// 本機 http 時不加 Secure
function cookieAttrs(url, maxAge) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;
}
export const sessionCookie = (value, url) => `${COOKIE_NAME}=${value}; ${cookieAttrs(url, SESSION_MAX_AGE)}`;
export const clearCookie = (url) => `${COOKIE_NAME}=; ${cookieAttrs(url, 0)}`;

function cookieValue(req) {
  const h = req.headers.get('cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
  }
  return '';
}

export const hasSessionCookie = (req) => !!cookieValue(req);

// 驗證 cookie：簽章（常數時間比較）與 exp。無效、過期、功能未啟用 → null
export async function getSession(env, req, nowMs = Date.now()) {
  if (!loginEnabled(env)) return null;
  const v = cookieValue(req);
  const dot = v.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = v.slice(0, dot);
  const expect = await sign(sessionSecret(env), payload);
  if (!safeEqual(v.slice(dot + 1), expect)) return null;
  let p;
  try { p = JSON.parse(b64uToStr(payload)); } catch { return null; }
  if (!p || typeof p.sub !== 'string' || typeof p.email !== 'string' || !p.sub || !p.email) return null;
  if (typeof p.exp !== 'number' || !(p.exp * 1000 > nowMs)) return null;
  return {
    sub: p.sub, email: p.email, name: typeof p.name === 'string' ? p.name : '',
    picture: typeof p.picture === 'string' ? p.picture : '', exp: p.exp,
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// 是否同源：Origin 必須存在且等於請求網址的 origin
export function isSameOrigin(req, url = new URL(req.url)) {
  const o = req.headers.get('origin');
  return !!o && o === url.origin;
}

// CSRF（合約 §8.3）：cookie 驗證的非 GET 請求，Origin 必須同源，否則 403 bad_origin
export function assertSameOrigin(req, url = new URL(req.url)) {
  if (SAFE_METHODS.has(req.method)) return;
  if (!isSameOrigin(req, url)) throw new HttpError(403, 'bad_origin', '請求來源不符，請從本站頁面操作。');
}

// 需要登入：沒有有效 session → 401
export async function requireSession(env, req) {
  const s = await getSession(env, req);
  if (!s) throw new HttpError(401, 'unauthorized', '請先登入。');
  return s;
}
