// Google ID token（JWT, RS256）驗證：只用 crypto.subtle，無外部套件
import { HttpError, b64uToBytes, b64uToStr } from './util.js';
import { googleClientId } from './session.js';

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const DEFAULT_TTL_S = 3600; // 取不到 Cache-Control max-age 時的預設快取時間
const MIN_TTL_S = 60;
const MAX_TTL_S = 86400;
const REFETCH_GAP_MS = 60_000; // 遇到不認得的 kid 時，距離上次抓取至少隔這麼久才重抓（避免被拿來放大請求）
const SKEW_S = 60; // 容許時差
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// 只有本機（localhost / 127.0.0.1）請求、且明確設定 DEV_MODE=1 時才會採用 DEV_TEST_JWKS；其餘一律忽略
// （雙重保險：避免 wrangler dev 開放到區網或經改寫 Host 的通道時，被人用版控裡的測試私鑰登入）
export function devJwksAllowed(env, hostname) {
  return !!(env && env.DEV_TEST_JWKS) && env.DEV_MODE === '1' && (hostname === 'localhost' || hostname === '127.0.0.1');
}

function parseKeys(text) {
  try {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    return j && Array.isArray(j.keys) ? j.keys.filter((k) => k && typeof k === 'object') : [];
  } catch {
    return [];
  }
}

// ---- Google JWKS：isolate 記憶體快取，依 Cache-Control max-age ----
let cache = null; // { keys, exp, at }
let inflight = null;
export function resetJwksCache() { cache = null; inflight = null; }

export function ttlFromCacheControl(h) {
  const m = /max-age\s*=\s*(\d+)/i.exec(h || '');
  const s = m ? Number(m[1]) : DEFAULT_TTL_S;
  return Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, s));
}

async function loadGoogleKeys(fetchFn, now, force) {
  if (cache && now < cache.exp && !force) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetchFn(GOOGLE_CERTS_URL);
      if (!res.ok) throw new Error('certs http ' + res.status);
      const keys = parseKeys(await res.text());
      if (!keys.length) throw new Error('certs empty');
      cache = { keys, at: now, exp: now + ttlFromCacheControl(res.headers.get('cache-control')) * 1000 };
      return cache;
    } catch (e) {
      console.error('jwks fetch failed', e && e.message);
      if (cache) { // 取不到就先沿用舊的，一分鐘後再試
        cache.exp = now + 60_000;
        return cache;
      }
      throw new HttpError(503, 'auth_unavailable', '暫時無法向 Google 取得驗證金鑰，請稍後再試。');
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const invalid = (reason, message = '登入憑證無效，請重新登入。') => {
  const e = new HttpError(401, 'invalid_token', message);
  e.reason = reason;
  return e;
};

async function importJwk(jwk) {
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw invalid('bad_key');
  return crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, ALG, false, ['verify']);
}

// 驗證 ID token，回傳 { sub, email, name, picture }。失敗丟 401 invalid_token（email 未驗證為 401 email_unverified）
// opts：hostname（請求主機，決定是否採用 DEV_TEST_JWKS）、now（毫秒）、fetchFn（測試注入）
export async function verifyIdToken(env, token, opts = {}) {
  const now = opts.now ?? Date.now();
  const fetchFn = opts.fetchFn ?? ((u) => fetch(u));
  const clientId = googleClientId(env);
  if (!clientId) throw new HttpError(404, 'not_found', '尚未啟用 Google 登入。');
  if (typeof token !== 'string' || token.length > 4096) throw invalid('format');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('format');

  let header, payload, sig;
  try {
    header = JSON.parse(b64uToStr(parts[0]));
    payload = JSON.parse(b64uToStr(parts[1]));
    sig = b64uToBytes(parts[2]);
  } catch {
    throw invalid('format');
  }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid('alg');
  if (!payload || typeof payload !== 'object') throw invalid('format');

  // 找金鑰：本機測試金鑰（僅 localhost）優先，其次 Google 公開金鑰
  let jwk = null;
  if (devJwksAllowed(env, opts.hostname)) jwk = parseKeys(env.DEV_TEST_JWKS).find((k) => k.kid === header.kid) || null;
  if (!jwk) {
    let c = await loadGoogleKeys(fetchFn, now, false);
    jwk = c.keys.find((k) => k.kid === header.kid) || null;
    if (!jwk && now - c.at >= REFETCH_GAP_MS) { // Google 輪替金鑰後，快取裡可能還沒有新 kid
      c = await loadGoogleKeys(fetchFn, now, true);
      jwk = c.keys.find((k) => k.kid === header.kid) || null;
    }
  }
  if (!jwk) throw invalid('unknown_kid');

  let okSig = false;
  try {
    okSig = await crypto.subtle.verify(ALG.name, await importJwk(jwk), sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!okSig) throw invalid('signature');

  // 聲明檢查
  if (payload.aud !== clientId) throw invalid('aud');
  if (!ISSUERS.has(payload.iss)) throw invalid('iss');
  const nowS = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || !(payload.exp > nowS - SKEW_S)) throw invalid('expired', '登入憑證已過期，請重新登入。');
  if (typeof payload.nbf === 'number' && payload.nbf > nowS + SKEW_S) throw invalid('nbf');
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    const e = new HttpError(401, 'email_unverified', '這個 Google 帳號的 Email 尚未驗證。');
    e.reason = 'email_unverified';
    throw e;
  }
  const sub = payload.sub;
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (typeof sub !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(sub) || !email || email.length > 254) throw invalid('claims');
  const picture = typeof payload.picture === 'string' && /^https:\/\//.test(payload.picture) ? payload.picture.slice(0, 300) : '';
  return {
    sub,
    email,
    name: typeof payload.name === 'string' ? Array.from(payload.name.trim()).slice(0, 80).join('') : '',
    picture,
  };
}
