// 匯出到 Google 相簿（方案 A）：主辦者用自己的 Google 帳號授權 → Worker 建立「App 建立的相簿」
// → 主辦者在 Google 相簿 App 手動開啟共用 → R2 的照片分批上傳到這本相簿。
//
// 背景：2025/3/31 起 Photos Library API 只能把照片加入「同一個 Google Cloud 專案建立的相簿」，
//      也不能再用 API 共用／加入相簿，所以無法寫入使用者既有的共用相簿。
//
// 資料：events/{id}/gphotos.json（不放 config，避免 refresh token 隨設定外流）
//   { v, enc_rt, account_email, scope, album_id, album_title, album_url, share_url, auto,
//     connected_at, connected_by, need_reconnect, last_sync_at, last_error, lock_until,
//     items: { hash: mediaItemId }, failed: { hash: { n, msg } } }
// 自動同步索引：gphotos/auto/{id}（排程只掃這個前綴）
// refresh token 以 AES-GCM 加密，金鑰由 SESSION_SECRET 經 HKDF 衍生（更換 SESSION_SECRET ＝ 需要重新連結）
import {
  HttpError, json, readJson, bytesToB64u, b64uToBytes, strToB64u, b64uToStr, safeEqual, randomCode, EXT_MIME, clip,
} from './util.js';
import { getConfig } from './config.js';
import { requireRole } from './auth.js';
import { loadPhotos } from './stats.js';
import { updateJson, readJsonObj } from './store.js';
import { googleClientId, sessionSecret } from './session.js';

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
];
const APPEND_SCOPE = 'https://www.googleapis.com/auth/photoslibrary.appendonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://photoslibrary.googleapis.com/v1';
const ALLOWED_HOSTS = new Set(['oauth2.googleapis.com', 'photoslibrary.googleapis.com']);
const STATE_TTL_S = 600;
const LOCK_MS = 90_000;
const MAX_FAIL = 3;
const BATCH_MAX = 15;      // 每次同步請求最多幾張（Worker 子請求數限制，前端會一直呼叫到做完）
const CRON_BUDGET = 30;    // 每次排程最多同步幾張（所有活動合計）
const CRON_PER_EVENT = 10;
export const NONCE_COOKIE = 'gpn';
export const CALLBACK_PATH = '/oauth/gphotos/callback';
const stateKey = (id) => `events/${id}/gphotos.json`;
const autoKey = (id) => `gphotos/auto/${id}`;
const SHARE_RE = /^https:\/\/(photos\.app\.goo\.gl\/[A-Za-z0-9_-]+|photos\.google\.com\/share\/[A-Za-z0-9_-]+(\?key=[A-Za-z0-9_-]+)?)\/?$/;
const enc = new TextEncoder();

// 功能開關：需要 Client ID、Client Secret、SESSION_SECRET（≥32，用來簽 state 與加密 token）
export function gphotosEnabled(env) {
  return !!googleClientId(env) && typeof env.GOOGLE_CLIENT_SECRET === 'string' && !!env.GOOGLE_CLIENT_SECRET.trim()
    && sessionSecret(env).length >= 32;
}
const disabled = () => new HttpError(404, 'gphotos_disabled', '伺服器尚未設定 Google 相簿匯出（需要 GOOGLE_CLIENT_SECRET）。');

// ---------- 抓取：只連 Google 網域；本機測試導向假伺服器（與 importer.js 同一個機制） ----------
function testOrigin(env) {
  return env && env.DEV_MODE === '1' && typeof env.IMPORT_TEST_ORIGIN === 'string' && env.IMPORT_TEST_ORIGIN ? env.IMPORT_TEST_ORIGIN.replace(/\/+$/, '') : '';
}
async function gfetch(env, url, init = {}, timeoutMs = 30_000) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error('host not allowed');
  const origin = testOrigin(env);
  const target = origin ? `${origin}/${u.hostname}${u.pathname}${u.search}` : url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(target, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new HttpError(504, 'gphotos_timeout', '連線 Google 逾時，請稍後再試。');
    throw new HttpError(502, 'gphotos_fetch_failed', '無法連線 Google，請稍後再試。');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 簽章與加密 ----------
const keyCache = new Map();
async function hmacKey(env) {
  const s = sessionSecret(env);
  const k = 'h:' + s;
  if (!keyCache.has(k)) keyCache.set(k, await crypto.subtle.importKey('raw', enc.encode('gphotos-state:' + s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  return keyCache.get(k);
}
async function hmac(env, text) {
  return bytesToB64u(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(text))));
}
async function aesKey(env) {
  const s = sessionSecret(env);
  const k = 'a:' + s;
  if (!keyCache.has(k)) {
    const base = await crypto.subtle.importKey('raw', enc.encode(s), 'HKDF', false, ['deriveKey']);
    keyCache.set(k, await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('mv-photo-collect'), info: enc.encode('gphotos-refresh-token') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    ));
  }
  return keyCache.get(k);
}
export async function encryptToken(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(plain)));
  return `${bytesToB64u(iv)}.${bytesToB64u(ct)}`;
}
export async function decryptToken(env, s) {
  try {
    const [iv, ct] = String(s || '').split('.');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uToBytes(iv) }, await aesKey(env), b64uToBytes(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function makeState(env, data) {
  const payload = strToB64u(JSON.stringify(data));
  return `${payload}.${await hmac(env, payload)}`;
}
export async function readState(env, s, now = Date.now()) {
  const str = String(s || '');
  const dot = str.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = str.slice(0, dot);
  if (!safeEqual(str.slice(dot + 1), await hmac(env, payload))) return null;
  let p;
  try { p = JSON.parse(b64uToStr(payload)); } catch { return null; }
  if (!p || typeof p.e !== 'string' || typeof p.n !== 'string' || typeof p.x !== 'number' || p.x * 1000 < now) return null;
  return p;
}

function cookieOf(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const cookieAttrs = (url, maxAge) => `Path=${CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;

// ---------- 狀態檔 ----------
const emptyState = () => ({ v: 1, items: {}, failed: {}, auto: false });
function normalize(s) {
  const st = s && typeof s === 'object' ? s : emptyState();
  if (!st.items || typeof st.items !== 'object') st.items = {};
  if (!st.failed || typeof st.failed !== 'object') st.failed = {};
  return st;
}
export async function loadState(env, id) {
  const cur = await readJsonObj(env, stateKey(id));
  return cur && cur.data ? normalize(cur.data) : null;
}
const mutateState = (env, id, fn) => updateJson(env, stateKey(id), emptyState, (d) => fn(normalize(d)));

async function setAutoIndex(env, id, on) {
  if (on) await env.PHOTOS.put(autoKey(id), '1');
  else await env.PHOTOS.delete(autoKey(id));
}

// ---------- Access token（isolate 快取） ----------
const tokenCache = new Map(); // id -> { enc, token, exp }
async function accessToken(env, id, st) {
  const hit = tokenCache.get(id);
  if (hit && hit.enc === st.enc_rt && hit.exp > Date.now() + 60_000) return hit.token;
  const rt = await decryptToken(env, st.enc_rt);
  if (!rt) {
    await markReconnect(env, id, '授權資料無法解開（伺服器金鑰已更換），請重新連結。');
    throw new HttpError(409, 'gphotos_reconnect', '需要重新連結 Google 相簿。');
  }
  const res = await gfetch(env, TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleClientId(env), client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token',
    }),
  });
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || !j || !j.access_token) {
    if (j && (j.error === 'invalid_grant' || j.error === 'unauthorized_client')) {
      await markReconnect(env, id, 'Google 授權已失效（可能被撤銷或超過期限），請重新連結。');
      throw new HttpError(409, 'gphotos_reconnect', '需要重新連結 Google 相簿。');
    }
    throw new HttpError(502, 'gphotos_token_failed', '向 Google 取得授權失敗，請稍後再試。');
  }
  tokenCache.set(id, { enc: st.enc_rt, token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}
async function markReconnect(env, id, msg) {
  tokenCache.delete(id);
  await mutateState(env, id, (s) => { s.need_reconnect = true; s.last_error = msg; s.lock_until = 0; });
}

// ---------- 狀態摘要 ----------
function excludedSet(cfg) {
  return new Set([...(cfg.excluded || []), ...(cfg.removed || [])]);
}
async function counts(env, cfg, st) {
  const { photos } = await loadPhotos(env, cfg.id);
  const ex = excludedSet(cfg);
  const eligible = photos.filter((p) => !ex.has(p.hash));
  let synced = 0;
  let failed = 0;
  for (const p of eligible) {
    if (st && st.items[p.hash]) synced++;
    else if (st && st.failed[p.hash] && st.failed[p.hash].n >= MAX_FAIL) failed++;
  }
  return { eligible: eligible.length, synced, failed, remaining: eligible.length - synced - failed, eligibleList: eligible };
}

async function statusView(env, cfg, st) {
  const base = { enabled: gphotosEnabled(env) };
  if (!st || !st.album_id) {
    const c = await counts(env, cfg, null);
    return { ...base, connected: false, eligible: c.eligible, synced: 0, remaining: c.eligible, failed: 0 };
  }
  const c = await counts(env, cfg, st);
  const failedList = Object.entries(st.failed)
    .filter(([, v]) => v && v.n >= MAX_FAIL)
    .slice(0, 20)
    .map(([hash, v]) => ({ hash, msg: v.msg || '' }));
  return {
    ...base,
    connected: !!st.enc_rt && !st.need_reconnect,
    need_reconnect: !!st.need_reconnect || !st.enc_rt,
    account_email: st.account_email || '',
    album_title: st.album_title || '',
    album_url: st.album_url || '',
    share_url: st.share_url || '',
    auto: !!st.auto,
    connected_at: st.connected_at || null,
    connected_by: st.connected_by || '',
    last_sync_at: st.last_sync_at || null,
    last_error: st.last_error || '',
    syncing: (st.lock_until || 0) > Date.now(),
    eligible: c.eligible,
    synced: c.synced,
    remaining: c.remaining,
    failed: c.failed,
    failed_list: failedList,
  };
}

// ---------- API ----------
export async function status(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'viewer');
  return json(await statusView(env, cfg, await loadState(env, cfg.id)));
}

// POST /api/admin/{id}/gphotos/connect → { auth_url }，並設定一次性 nonce cookie（防止別人把他的授權結果塞給你）
export async function connect(env, req, id) {
  if (!gphotosEnabled(env)) throw disabled();
  const ac = await requireRole(env, req, id, 'manager');
  if (ac.cfg.deleted_at) throw new HttpError(409, 'archived', '活動已封存。');
  const url = new URL(req.url);
  const nonce = randomCode(16);
  const state = await makeState(env, {
    e: ac.cfg.id, n: nonce, x: Math.floor(Date.now() / 1000) + STATE_TTL_S,
    by: ac.user ? ac.user.email : 'admin-key',
  });
  const p = new URLSearchParams({
    client_id: googleClientId(env),
    redirect_uri: url.origin + CALLBACK_PATH,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  });
  if (ac.user && ac.user.email) p.set('login_hint', ac.user.email);
  return json({ auth_url: `${AUTH_URL}?${p}`, redirect_uri: url.origin + CALLBACK_PATH }, 200, {
    'set-cookie': `${NONCE_COOKIE}=${nonce}; ${cookieAttrs(url, STATE_TTL_S)}`,
  });
}

function redirectAdmin(url, id, result, extra = '') {
  const frag = `e=${encodeURIComponent(id || '')}&gp=${encodeURIComponent(result)}${extra}`;
  return new Response(null, {
    status: 302,
    headers: {
      location: `${url.origin}/admin#${frag}`,
      'set-cookie': `${NONCE_COOKIE}=; ${cookieAttrs(url, 0)}`,
      'cache-control': 'no-store',
    },
  });
}

function decodeIdToken(t) {
  try {
    const p = JSON.parse(b64uToStr(String(t).split('.')[1]));
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

async function apiJson(env, token, path, init = {}, timeoutMs = 30_000) {
  const res = await gfetch(env, API + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
  }, timeoutMs);
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON */ }
  return { res, j };
}

function albumTitle(cfg) {
  const b = cfg.basic || {};
  return clip(`${b.name || '活動'}${b.date ? ` ${b.date}` : ''}（活動照片）`, 200);
}

// GET /oauth/gphotos/callback?code&state
export async function callback(env, req) {
  const url = new URL(req.url);
  if (!gphotosEnabled(env)) return redirectAdmin(url, '', 'err', '&why=disabled');
  const st = await readState(env, url.searchParams.get('state'));
  if (!st) return redirectAdmin(url, '', 'err', '&why=state');
  const id = st.e;
  if (!safeEqual(cookieOf(req, NONCE_COOKIE), st.n)) return redirectAdmin(url, id, 'err', '&why=nonce');
  if (url.searchParams.get('error')) return redirectAdmin(url, id, 'denied');
  const code = url.searchParams.get('code') || '';
  if (!code) return redirectAdmin(url, id, 'err', '&why=code');
  const cfg = await getConfig(env, id);
  if (!cfg || cfg.deleted_at) return redirectAdmin(url, id, 'err', '&why=event');

  const res = await gfetch(env, TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: googleClientId(env), client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: url.origin + CALLBACK_PATH, grant_type: 'authorization_code',
    }),
  }).catch(() => null);
  let tok = null;
  try { tok = res ? await res.json() : null; } catch { /* 非 JSON */ }
  if (!res || !res.ok || !tok || !tok.access_token) return redirectAdmin(url, id, 'err', '&why=token');
  const granted = String(tok.scope || '').split(/\s+/);
  if (!granted.includes(APPEND_SCOPE)) return redirectAdmin(url, id, 'err', '&why=scope');
  if (!tok.refresh_token) return redirectAdmin(url, id, 'err', '&why=refresh');
  const email = String(decodeIdToken(tok.id_token).email || '');

  // 相簿：之前連結過且仍可讀（同一個帳號重新連結）→ 沿用，已同步紀錄保留；否則建立新相簿
  const prev = await loadState(env, id);
  let album = null;
  if (prev && prev.album_id) {
    const g = await apiJson(env, tok.access_token, `/albums/${encodeURIComponent(prev.album_id)}`).catch(() => null);
    if (g && g.res.ok && g.j && g.j.id) album = { id: g.j.id, title: g.j.title || prev.album_title, url: g.j.productUrl || prev.album_url, reused: true };
  }
  if (!album) {
    const title = albumTitle(cfg);
    const c = await apiJson(env, tok.access_token, '/albums', { method: 'POST', body: JSON.stringify({ album: { title } }) }).catch(() => null);
    if (!c || !c.res.ok || !c.j || !c.j.id) return redirectAdmin(url, id, 'err', '&why=album');
    album = { id: c.j.id, title: c.j.title || title, url: c.j.productUrl || '', reused: false };
  }
  const encRt = await encryptToken(env, tok.refresh_token);
  const saved = await mutateState(env, id, (s) => {
    s.enc_rt = encRt;
    s.scope = tok.scope || '';
    s.account_email = email;
    s.connected_at = new Date().toISOString();
    s.connected_by = typeof st.by === 'string' ? st.by : '';
    s.need_reconnect = false;
    s.last_error = '';
    s.lock_until = 0;
    if (!album.reused) {
      s.items = {};
      s.failed = {};
      s.share_url = '';
    }
    s.album_id = album.id;
    s.album_title = album.title;
    s.album_url = album.url;
  });
  tokenCache.set(id, { enc: encRt, token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60_000 });
  if (saved.auto) await setAutoIndex(env, id, true);
  return redirectAdmin(url, id, 'ok', album.reused ? '&reused=1' : '');
}

// PATCH /api/admin/{id}/gphotos { share_url?, auto? }
export async function patch(env, req, id) {
  const ac = await requireRole(env, req, id, 'manager');
  const body = await readJson(req);
  const cur = await loadState(env, ac.cfg.id);
  if (!cur || !cur.album_id) throw new HttpError(409, 'gphotos_not_connected', '尚未連結 Google 相簿。');
  if (body.share_url !== undefined) {
    const v = typeof body.share_url === 'string' ? body.share_url.trim() : '';
    if (v && !SHARE_RE.test(v)) throw new HttpError(400, 'invalid', '共用連結需為 https://photos.app.goo.gl/… 或 https://photos.google.com/share/…');
  }
  if (body.auto !== undefined && typeof body.auto !== 'boolean') throw new HttpError(400, 'invalid', 'auto 需為布林值。');
  const st = await mutateState(env, ac.cfg.id, (s) => {
    if (body.share_url !== undefined) s.share_url = String(body.share_url || '').trim();
    if (body.auto !== undefined) s.auto = body.auto;
  });
  await setAutoIndex(env, ac.cfg.id, !!st.auto && !!st.enc_rt);
  return json(await statusView(env, ac.cfg, st));
}

async function revoke(env, st) {
  const rt = st && st.enc_rt ? await decryptToken(env, st.enc_rt) : null;
  if (!rt) return;
  try {
    await gfetch(env, REVOKE_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }),
    }, 10_000);
  } catch (e) { console.error('gphotos revoke failed', e && e.message); }
}

// POST /api/admin/{id}/gphotos/disconnect：撤銷授權；相簿與已同步紀錄保留（同一帳號重新連結可接續）
export async function disconnect(env, req, id) {
  const ac = await requireRole(env, req, id, 'manager');
  const cur = await loadState(env, ac.cfg.id);
  if (!cur || !cur.album_id) throw new HttpError(409, 'gphotos_not_connected', '尚未連結 Google 相簿。');
  await revoke(env, cur);
  tokenCache.delete(ac.cfg.id);
  const st = await mutateState(env, ac.cfg.id, (s) => {
    delete s.enc_rt;
    s.need_reconnect = false;
    s.lock_until = 0;
    s.last_error = '';
  });
  await setAutoIndex(env, ac.cfg.id, false);
  return json(await statusView(env, ac.cfg, st));
}

// 排程刪除活動時：撤銷授權、刪狀態與索引（Google 相簿裡的照片不會被刪）
export async function onEventPurged(env, id) {
  const cur = await loadState(env, id);
  if (cur) await revoke(env, cur);
  tokenCache.delete(id);
  await env.PHOTOS.delete([stateKey(id), autoKey(id)]);
}

// ---------- 同步核心 ----------
function errMsg(j, res) {
  const m = j && j.error && (j.error.message || j.error.status);
  return clip(m ? String(m) : `HTTP ${res.status}`, 200);
}

// 同步一批：回傳 { added, failed_now, stopped? }
export async function runSync(env, cfg, { limit = 8, retryFailed = false, now = Date.now() } = {}) {
  const id = cfg.id;
  const n = Math.max(1, Math.min(BATCH_MAX, Number(limit) || 8));
  let st = await loadState(env, id);
  if (!st || !st.album_id) throw new HttpError(409, 'gphotos_not_connected', '尚未連結 Google 相簿。');
  if (!st.enc_rt || st.need_reconnect) throw new HttpError(409, 'gphotos_reconnect', '需要重新連結 Google 相簿。');
  // 取得鎖（同一時間只有一個同步；逾時 90 秒自動釋放）
  st = await mutateState(env, id, (s) => {
    if ((s.lock_until || 0) > now) throw new HttpError(409, 'gphotos_busy', '另一個同步正在進行，請稍候。');
    s.lock_until = now + LOCK_MS;
    if (retryFailed) s.failed = {};
  });
  const added = {};
  const failed = {};
  let lastError = '';
  let fatal = null;
  try {
    const token = await accessToken(env, id, st);
    const c = await counts(env, cfg, st);
    const todo = c.eligibleList
      .filter((p) => !st.items[p.hash] && !((st.failed[p.hash] || {}).n >= MAX_FAIL))
      .sort((a, b) => String(a.uploaded_at).localeCompare(String(b.uploaded_at)))
      .slice(0, n);
    const uploads = [];
    for (const p of todo) {
      const obj = await env.PHOTOS.get(`events/${id}/p/${p.hash}.${p.ext}`);
      if (!obj) { failed[p.hash] = '雲端找不到這張照片'; continue; }
      const bytes = await obj.arrayBuffer();
      const res = await gfetch(env, `${API}/uploads`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'x-goog-upload-content-type': EXT_MIME[p.ext] || 'application/octet-stream',
          'x-goog-upload-protocol': 'raw',
          'x-goog-upload-file-name': `${p.hash.slice(0, 10)}.${p.ext}`,
        },
        body: bytes,
      }, 60_000);
      const text = await res.text();
      if (res.status === 401) { tokenCache.delete(id); fatal = new HttpError(502, 'gphotos_token_failed', 'Google 授權逾時，請再按一次同步。'); break; }
      if (res.status === 429) { fatal = new HttpError(429, 'gphotos_rate_limited', 'Google 相簿今日用量已達上限，請明天再試。'); break; }
      if (!res.ok || !text) { failed[p.hash] = `上傳失敗（HTTP ${res.status}）`; continue; }
      uploads.push({ p, token: text.trim() });
    }
    if (uploads.length) {
      const desc = (p) => clip([p.uploader && `上傳者：${p.uploader}`, p.groups.length && p.groups.join('、'), p.note].filter(Boolean).join('｜'), 900);
      const { res, j } = await apiJson(env, token, '/mediaItems:batchCreate', {
        method: 'POST',
        body: JSON.stringify({
          albumId: st.album_id,
          newMediaItems: uploads.map((u) => ({
            description: desc(u.p) || undefined,
            simpleMediaItem: { uploadToken: u.token, fileName: `${u.p.hash.slice(0, 10)}.${u.p.ext}` },
          })),
        }),
      }, 60_000);
      if (!res.ok && res.status !== 207) {
        lastError = errMsg(j, res);
        if (res.status === 429) fatal = new HttpError(429, 'gphotos_rate_limited', 'Google 相簿今日用量已達上限，請明天再試。');
        else if (res.status === 400 || res.status === 403 || res.status === 404) {
          // 相簿被刪除、或不是這個 App 建立的 → 無法再加入
          fatal = new HttpError(409, 'gphotos_album_unavailable', `無法加入相簿（${lastError}）。相簿可能已被刪除，請中斷連結後重新連結以建立新相簿。`);
        } else fatal = new HttpError(502, 'gphotos_batch_failed', `Google 相簿建立項目失敗（${lastError}），請稍後再試。`);
      } else {
        const results = (j && j.newMediaItemResults) || [];
        const byToken = new Map(results.map((r) => [r.uploadToken, r]));
        uploads.forEach((u, i) => {
          const r = byToken.get(u.token) || results[i];
          const ok = r && r.mediaItem && r.mediaItem.id && (!r.status || !r.status.code);
          if (ok) added[u.p.hash] = r.mediaItem.id;
          else failed[u.p.hash] = clip((r && r.status && r.status.message) || '建立項目失敗', 200);
        });
      }
    }
  } catch (e) {
    fatal = e;
  }
  // 寫回結果並解鎖
  let saved;
  try {
    saved = await mutateState(env, id, (s) => {
      Object.assign(s.items, added);
      for (const [h, msg] of Object.entries(failed)) {
        const f = s.failed[h] || { n: 0 };
        s.failed[h] = { n: (f.n || 0) + 1, msg };
      }
      for (const h of Object.keys(added)) delete s.failed[h];
      s.lock_until = 0;
      s.last_sync_at = new Date().toISOString();
      if (fatal && !(fatal instanceof HttpError && fatal.code === 'gphotos_reconnect')) s.last_error = fatal.message || lastError || '同步失敗';
      else if (!fatal && Object.keys(added).length) s.last_error = '';
    });
  } catch (e) {
    console.error('gphotos save failed', e && e.message);
  }
  if (fatal) throw fatal;
  return { added: Object.keys(added).length, failed_now: Object.keys(failed).length, state: saved };
}

// POST /api/admin/{id}/gphotos/sync { limit?, retry_failed? }
export async function sync(env, req, id) {
  if (!gphotosEnabled(env)) throw disabled();
  const ac = await requireRole(env, req, id, 'manager');
  const text = (await req.text()).slice(0, 4096);
  let body = {};
  if (text.trim()) {
    try { body = JSON.parse(text); } catch { throw new HttpError(400, 'invalid', '請求內容不是有效的 JSON 物件。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  }
  const r = await runSync(env, ac.cfg, { limit: body.limit, retryFailed: body.retry_failed === true });
  const view = await statusView(env, ac.cfg, r.state || await loadState(env, ac.cfg.id));
  return json({ added: r.added, failed_now: r.failed_now, ...view });
}

// 排程：每小時替開啟「自動同步」的活動補傳新照片
export async function runAutoSync(env) {
  const summary = { events: 0, added: 0, errors: 0 };
  if (!gphotosEnabled(env)) return summary;
  let budget = CRON_BUDGET;
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: 'gphotos/auto/', cursor, limit: 1000 });
    for (const o of page.objects) {
      if (budget <= 0) break;
      const id = o.key.slice('gphotos/auto/'.length);
      try {
        const cfg = await getConfig(env, id);
        if (!cfg || cfg.deleted_at) { await env.PHOTOS.delete(o.key); continue; }
        const st = await loadState(env, id);
        if (!st || !st.auto || !st.enc_rt) { await env.PHOTOS.delete(o.key); continue; }
        if (st.need_reconnect) continue;
        const c = await counts(env, cfg, st);
        if (!c.remaining) continue;
        summary.events++;
        const r = await runSync(env, cfg, { limit: Math.min(CRON_PER_EVENT, budget) });
        summary.added += r.added;
        budget -= Math.max(1, r.added + r.failed_now);
      } catch (e) {
        summary.errors++;
        console.error('gphotos auto sync failed', id, e && e.message);
      }
    }
    cursor = page.truncated && budget > 0 ? page.cursor : undefined;
  } while (cursor);
  console.log('gphotos auto sync', JSON.stringify(summary));
  return summary;
}
