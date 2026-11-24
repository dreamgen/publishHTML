// 全站影片上傳至指定 Google 雲端硬碟（支援共用雲端硬碟）：
// - 預設資料夾 ID：GOOGLE_DRIVE_FOLDER_ID（wrangler.toml），預設為 1JVE139tWgdCi7jBb5NV3tIW5CSTxoERr
// - 影片位元組不經過 Worker、不存進 R2；由手機端直接以 Resumable Upload 串流上傳至 Google 雲端硬碟
// - R2 只存 ~15KB 封面縮圖（events/{id}/t/{hash}.jpg）與 0-byte 索引（events/{id}/p/{hash}.{ext}）
// - 共用現有 OAuth Client 與回呼路徑（/oauth/gphotos/callback），由 state.e === '_gdrive' 區分
import {
  HttpError, json, readJson, safeEqual, randomCode, clip, HASH_RE, VIDEO_MIME_EXT, b64uToStr,
} from './util.js';
import { getConfig, derive, mutateConfig } from './config.js';
import { requireRole } from './auth.js';
import { loadPhotos, noteUploaded } from './stats.js';
import { readJsonObj, updateJson } from './store.js';
import { googleClientId, getSession } from './session.js';
import { recordUploadSafe } from './account.js';
import { resolveUpload, checkRate, cleanGroups, cleanSegment, cleanText, buildMetadata, fitMetadata } from './upload.js';
import {
  gphotosEnabled, makeState, readState, encryptToken, decryptToken, NONCE_COOKIE, CALLBACK_PATH,
} from './gphotos.js';

export const DEFAULT_FOLDER_ID = '1JVE139tWgdCi7jBb5NV3tIW5CSTxoERr';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPES = ['openid', 'email', DRIVE_SCOPE];
const SITE_KEY = 'site/gdrive.json';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const ALLOWED_HOSTS = new Set(['oauth2.googleapis.com', 'www.googleapis.com']);
const STATE_TTL_S = 600;
const SITE_TTL_MS = 15_000;
const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,80}$/;

const disabled = () => new HttpError(404, 'gdrive_disabled', '伺服器尚未設定 Google OAuth（需要 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、SESSION_SECRET）。');

function testOrigin(env) {
  return env && env.DEV_MODE === '1' && typeof env.IMPORT_TEST_ORIGIN === 'string' && env.IMPORT_TEST_ORIGIN
    ? env.IMPORT_TEST_ORIGIN.replace(/\/+$/, '') : '';
}

async function dfetch(env, url, init = {}, timeoutMs = 30_000) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error('host not allowed');
  const origin = testOrigin(env);
  const target = origin ? `${origin}/${u.hostname}${u.pathname}${u.search}` : url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(target, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new HttpError(504, 'gdrive_timeout', '連線 Google 雲端硬碟逾時，請稍後再試。');
    throw new HttpError(502, 'gdrive_fetch_failed', '無法連線 Google 雲端硬碟，請稍後再試。');
  } finally {
    clearTimeout(timer);
  }
}

export function gdriveEnabled(env) {
  return gphotosEnabled(env);
}

export function defaultRootFolderId(env) {
  const v = typeof env?.GOOGLE_DRIVE_FOLDER_ID === 'string' ? env.GOOGLE_DRIVE_FOLDER_ID.trim() : '';
  return v || DEFAULT_FOLDER_ID;
}

export function rootFolderId(env, st) {
  return (st && typeof st.root_folder_id === 'string' && st.root_folder_id.trim()) || defaultRootFolderId(env);
}

// ---------- 全站狀態（site/gdrive.json，isolate 快取 15 秒） ----------
const emptySite = () => ({
  v: 1,
  enc_rt: '',
  account_email: '',
  root_folder_id: '',
  root_folder_name: '',
  connected_at: null,
  connected_by: '',
  need_reconnect: false,
  last_error: '',
  event_folders: {},
});

function normalizeSite(s) {
  const st = s && typeof s === 'object' ? s : emptySite();
  const def = emptySite();
  for (const k of Object.keys(def)) if (st[k] === undefined) st[k] = def[k];
  if (!st.event_folders || typeof st.event_folders !== 'object' || Array.isArray(st.event_folders)) st.event_folders = {};
  return st;
}

let siteCache = { t: 0, st: null };
export async function loadSiteState(env, { fresh = false } = {}) {
  if (!fresh && siteCache.st && Date.now() - siteCache.t < SITE_TTL_MS) return siteCache.st;
  const cur = await readJsonObj(env, SITE_KEY);
  const st = cur && cur.data ? normalizeSite(cur.data) : null;
  siteCache = { t: Date.now(), st };
  return st;
}

async function mutateSite(env, fn) {
  const saved = await updateJson(env, SITE_KEY, emptySite, (d) => fn(normalizeSite(d)));
  siteCache = { t: Date.now(), st: normalizeSite(saved) };
  return siteCache.st;
}

export async function isReady(env) {
  if (!gdriveEnabled(env)) return false;
  const st = await loadSiteState(env);
  return !!(st && st.enc_rt && !st.need_reconnect);
}

// ---------- Access token（isolate 快取） ----------
let tokCache = { enc: '', token: '', exp: 0 };

async function getAccessToken(env, st) {
  if (tokCache.enc === st.enc_rt && tokCache.token && tokCache.exp > Date.now() + 60_000) return tokCache.token;
  const rt = await decryptToken(env, st.enc_rt);
  if (!rt) {
    await markReconnect(env, '雲端硬碟授權無法解開（伺服器金鑰已更換），請重新連結。');
    throw new HttpError(409, 'gdrive_reconnect', '需要重新連結影片雲端硬碟。');
  }
  const res = await dfetch(env, TOKEN_URL, {
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
      await markReconnect(env, 'Google 雲端硬碟授權已失效，請重新連結。');
      throw new HttpError(409, 'gdrive_reconnect', '需要重新連結影片雲端硬碟。');
    }
    throw new HttpError(502, 'gdrive_token_failed', '向 Google 取得雲端硬碟授權失敗，請稍後再試。');
  }
  tokCache = { enc: st.enc_rt, token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tokCache.token;
}

async function markReconnect(env, msg) {
  tokCache = { enc: '', token: '', exp: 0 };
  await mutateSite(env, (s) => { s.need_reconnect = true; s.last_error = msg; });
}

async function driveJson(env, token, path, init = {}, timeoutMs = 20_000) {
  const url = path.startsWith('https://') ? path : `${DRIVE_API}${path}`;
  const res = await dfetch(env, url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
  }, timeoutMs);
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON */ }
  return { res, j };
}

async function verifyFolder(env, token, folderId) {
  const q = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,mimeType,driveId' });
  const { res, j } = await driveJson(env, token, `/files/${encodeURIComponent(folderId)}?${q}`);
  if (!res.ok || !j || !j.id) return { ok: false, status: res.status, j };
  if (j.mimeType && j.mimeType !== 'application/vnd.google-apps.folder') return { ok: false, status: 400, notFolder: true, j };
  return { ok: true, id: j.id, name: j.name || '' };
}

// ---------- OAuth & 管理 API ----------
function cookieOf(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const cookieAttrs = (url, maxAge) => `Path=${CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;

function redirectAdmin(url, id, result, extra = '') {
  const frag = `e=${encodeURIComponent(id || '')}&gd=${encodeURIComponent(result)}${extra}`;
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

function statusView(env, st, eventId) {
  const fid = rootFolderId(env, st);
  const ef = st && eventId && st.event_folders ? st.event_folders[eventId] : null;
  const evFolderId = typeof ef === 'string' ? ef : (ef && ef.id) || null;
  return {
    enabled: gdriveEnabled(env),
    connected: !!(st && st.enc_rt && !st.need_reconnect),
    need_reconnect: !!(st && st.need_reconnect),
    account_email: (st && st.account_email) || '',
    root_folder_id: fid,
    root_folder_name: (st && st.root_folder_name) || '',
    root_folder_url: fid ? `https://drive.google.com/drive/folders/${fid}` : '',
    event_folder_id: evFolderId,
    event_folder_url: evFolderId ? `https://drive.google.com/drive/folders/${evFolderId}` : null,
    connected_at: (st && st.connected_at) || null,
    connected_by: (st && st.connected_by) || '',
    last_error: (st && st.last_error) || '',
  };
}

// GET /api/admin/{id}/gdrive
export async function status(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'viewer');
  const st = await loadSiteState(env, { fresh: true });
  return json(statusView(env, st, cfg.id));
}

// POST /api/admin/{id}/gdrive/connect
export async function connect(env, req, id) {
  if (!gdriveEnabled(env)) throw disabled();
  const ac = await requireRole(env, req, id, 'manager');
  const url = new URL(req.url);
  const nonce = randomCode(16);
  const state = await makeState(env, {
    e: '_gdrive',
    ret: ac.cfg.id,
    n: nonce,
    x: Math.floor(Date.now() / 1000) + STATE_TTL_S,
    by: ac.user ? ac.user.email : 'admin-key',
  });
  const p = new URLSearchParams({
    client_id: googleClientId(env),
    redirect_uri: url.origin + CALLBACK_PATH,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'false',
    state,
  });
  return json({ auth_url: `${AUTH_URL}?${p}`, redirect_uri: url.origin + CALLBACK_PATH }, 200, {
    'set-cookie': `${NONCE_COOKIE}=${nonce}; ${cookieAttrs(url, STATE_TTL_S)}`,
  });
}

// GET /oauth/gphotos/callback 當 state.e === '_gdrive' 時轉由這裡處理
export async function callback(env, req, st) {
  const url = new URL(req.url);
  const ret = typeof st.ret === 'string' ? st.ret : '';
  if (!gdriveEnabled(env)) return redirectAdmin(url, ret, 'err', '&why=disabled');
  if (!safeEqual(cookieOf(req, NONCE_COOKIE), st.n)) return redirectAdmin(url, ret, 'err', '&why=nonce');
  if (url.searchParams.get('error')) return redirectAdmin(url, ret, 'denied');
  const code = url.searchParams.get('code') || '';
  if (!code) return redirectAdmin(url, ret, 'err', '&why=code');

  const res = await dfetch(env, TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(env),
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: url.origin + CALLBACK_PATH,
      grant_type: 'authorization_code',
    }),
  }).catch(() => null);
  let tok = null;
  try { tok = res ? await res.json() : null; } catch { /* 非 JSON */ }
  if (!res || !res.ok || !tok || !tok.access_token) {
    const ge = !res ? 'network' : (tok && typeof tok.error === 'string' && /^[a-z_]{1,40}$/.test(tok.error) ? tok.error : `http_${res.status}`);
    return redirectAdmin(url, ret, 'err', `&why=token&ge=${ge}`);
  }
  const granted = String(tok.scope || '').split(/\s+/);
  if (!granted.includes(DRIVE_SCOPE) && !granted.includes(DRIVE_FILE_SCOPE)) {
    return redirectAdmin(url, ret, 'err', '&why=scope');
  }
  if (!tok.refresh_token) return redirectAdmin(url, ret, 'err', '&why=refresh');

  const cur = await loadSiteState(env, { fresh: true });
  const fid = rootFolderId(env, cur);
  const check = await verifyFolder(env, tok.access_token, fid).catch(() => null);
  if (!check || !check.ok) {
    const ge = !check ? 'network' : `http_${check.status || 0}`;
    return redirectAdmin(url, ret, 'err', `&why=folder&ge=${ge}`);
  }

  const email = String(decodeIdToken(tok.id_token).email || '');
  const encRt = await encryptToken(env, tok.refresh_token);
  await mutateSite(env, (s) => {
    s.enc_rt = encRt;
    s.account_email = email;
    if (!s.root_folder_id) s.root_folder_id = fid;
    s.root_folder_name = check.name || s.root_folder_name || '';
    s.connected_at = new Date().toISOString();
    s.connected_by = typeof st.by === 'string' ? st.by : '';
    s.need_reconnect = false;
    s.last_error = '';
  });
  tokCache = { enc: encRt, token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) || 3600) * 1000 };
  return redirectAdmin(url, ret, 'ok');
}

function extractFolderId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = /\/folders\/([A-Za-z0-9_-]{10,80})/.exec(s);
  return m ? m[1] : s;
}

// PATCH /api/admin/{id}/gdrive  { root_folder_id }
export async function patch(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'manager');
  const body = await readJson(req);
  if (body.root_folder_id === undefined) throw new HttpError(400, 'invalid', '缺少 root_folder_id。');
  const fid = extractFolderId(body.root_folder_id);
  if (!FOLDER_ID_RE.test(fid)) throw new HttpError(400, 'invalid', '資料夾 ID 格式不正確，請貼上資料夾連結或 ID。');

  const cur = await loadSiteState(env, { fresh: true });
  let folderName = '';
  if (cur && cur.enc_rt && !cur.need_reconnect) {
    const token = await getAccessToken(env, cur);
    const v = await verifyFolder(env, token, fid);
    if (!v.ok) {
      throw new HttpError(400, 'bad_folder', '找不到這個雲端硬碟資料夾，或目前連結的帳號沒有存取權限。');
    }
    folderName = v.name;
  }
  const saved = await mutateSite(env, (s) => {
    const changed = s.root_folder_id !== fid;
    s.root_folder_id = fid;
    s.root_folder_name = folderName || (changed ? '' : s.root_folder_name);
    if (changed) s.event_folders = {};
  });
  return json(statusView(env, saved, cfg.id));
}

// POST /api/admin/{id}/gdrive/disconnect
export async function disconnect(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'manager');
  const cur = await loadSiteState(env, { fresh: true });
  const rt = cur && cur.enc_rt ? await decryptToken(env, cur.enc_rt) : null;
  if (rt) {
    try {
      await dfetch(env, REVOKE_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }),
      }, 10_000);
    } catch (e) { console.error('gdrive revoke failed', e && e.message); }
  }
  tokCache = { enc: '', token: '', exp: 0 };
  const saved = await mutateSite(env, (s) => {
    s.enc_rt = '';
    s.connected_at = null;
    s.need_reconnect = false;
    s.last_error = '';
  });
  return json(statusView(env, saved, cfg.id));
}

// ---------- 建立／取得活動子資料夾 ----------
async function ensureEventFolder(env, token, st, cfg) {
  const existing = st.event_folders && st.event_folders[cfg.id];
  if (typeof existing === 'string' && existing) return existing;
  if (existing && typeof existing.id === 'string' && existing.id) return existing.id;

  const rootId = rootFolderId(env, st);
  const name = clip(`${cfg.basic.date ? `${cfg.basic.date}_` : ''}${cfg.basic.name || cfg.id}`, 120);
  const { res, j } = await driveJson(env, token, '/files?supportsAllDrives=true&fields=id,name', {
    method: 'POST',
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootId],
    }),
  });
  if (!res.ok || !j || !j.id) {
    if (res.status === 401) tokCache = { enc: '', token: '', exp: 0 };
    throw new HttpError(502, 'gdrive_folder_failed', '無法在雲端硬碟建立活動資料夾，請確認資料夾權限。');
  }
  const saved = await mutateSite(env, (s) => {
    if (!s.event_folders[cfg.id]) s.event_folders[cfg.id] = j.id;
  });
  if (saved.event_folders[cfg.id] !== j.id) {
    dfetch(env, `${DRIVE_API}/files/${encodeURIComponent(j.id)}?supportsAllDrives=true`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }, 10_000).catch(() => {});
  }
  return saved.event_folders[cfg.id];
}

export async function deleteDriveFile(env, driveId) {
  if (!driveId || !FOLDER_ID_RE.test(driveId) || !gdriveEnabled(env)) return false;
  const st = await loadSiteState(env);
  if (!st || !st.enc_rt || st.need_reconnect) return false;
  try {
    const token = await getAccessToken(env, st);
    const res = await dfetch(env, `${DRIVE_API}/files/${encodeURIComponent(driveId)}?supportsAllDrives=true`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }, 15_000);
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// ---------- 影片上傳：Init + Complete + 雲端硬碟轉存 ----------
function videoFileName(meta, hash, ext, cfg) {
  const exif = typeof meta.exif_time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(meta.exif_time)
    ? meta.exif_time.replace(/:/g, '-') : '';
  const seg = cleanSegment(meta.segment, cfg);
  const groups = cleanGroups(meta.groups, cfg);
  const uploader = cleanText(meta.uploader, 24);
  const orig = cleanText(meta.orig_name, 60).replace(/[\\/:*?"<>|]/g, '_');
  const tail = orig || `${hash.slice(0, 10)}.${ext}`;
  return clip([exif, seg !== 'auto' ? seg : '', groups.join('-'), uploader, tail].filter(Boolean).join('_'), 180);
}

function videoDescription(meta, hash, cfg, extraLine = '') {
  return [
    meta.uploader ? `上傳者：${cleanText(meta.uploader, 24)}` : '',
    Array.isArray(meta.groups) && meta.groups.length ? `小隊：${cleanGroups(meta.groups, cfg).join('、')}` : '',
    meta.exif_time ? `拍攝時間：${String(meta.exif_time).slice(0, 19)}` : '',
    `SHA-256: ${hash}`,
    extraLine,
  ].filter(Boolean).join('\n');
}

const validSha256Hex = (v) => (typeof v === 'string' && HASH_RE.test(v.toLowerCase()) ? v.toLowerCase() : '');

// 把公開分享的 Google 雲端硬碟影片複製（或串流轉存）到活動專用雲端硬碟資料夾
export async function copyPublicVideoToDrive(env, cfg, { sourceId, rk = '', hash, mime, ext, size = 0, meta = {}, apiKey = '' }) {
  const st = await loadSiteState(env);
  if (!gdriveEnabled(env) || !st || !st.enc_rt || st.need_reconnect) {
    throw new HttpError(503, 'gdrive_not_connected', '主辦單位尚未連結影片雲端硬碟。');
  }
  let token = await getAccessToken(env, st);
  const folderId = await ensureEventFolder(env, token, st, cfg);
  const fileName = videoFileName(meta, hash, ext, cfg);
  const desc = videoDescription(meta, hash, cfg, `來源：gd:${sourceId}`);
  const rkHdr = rk ? { 'X-Goog-Drive-Resource-Keys': `${sourceId}/${rk}` } : {};
  const copyPath = `/files/${encodeURIComponent(sourceId)}/copy?supportsAllDrives=true&fields=id,name,size,mimeType,sha256Checksum`;
  const copyInit = () => ({
    method: 'POST',
    headers: rkHdr,
    body: JSON.stringify({ name: fileName, parents: [folderId], description: desc }),
  });

  let { res, j } = await driveJson(env, token, copyPath, copyInit(), 60_000);
  if (res.status === 401) {
    tokCache = { enc: '', token: '', exp: 0 };
    token = await getAccessToken(env, st);
    ({ res, j } = await driveJson(env, token, copyPath, copyInit(), 60_000));
  }
  if (res.ok && j && j.id) {
    return { driveId: j.id, size: Number(j.size) || size, sha256: validSha256Hex(j.sha256Checksum) };
  }

  const reason = (j && j.error && Array.isArray(j.error.errors) && j.error.errors[0] && j.error.errors[0].reason) || '';
  if (res.status === 403 && (reason === 'cannotCopyFile' || reason === 'copyRequiresWriterPermission')) {
    throw new HttpError(410, 'source_gone', '這支影片的擁有者關閉了下載與複製權限，無法匯入。');
  }
  if (res.status === 429) {
    throw new HttpError(429, 'drive_rate_limited', 'Google 雲端硬碟暫時限制存取，請稍後再試。');
  }

  if (apiKey && (res.status === 400 || res.status === 403 || res.status === 404)) {
    const srcUrl = `${DRIVE_API}/files/${encodeURIComponent(sourceId)}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(apiKey)}`;
    const srcRes = await dfetch(env, srcUrl, { headers: rkHdr }, 60_000);
    if (srcRes.status === 403 || srcRes.status === 404) {
      await srcRes.body?.cancel?.().catch(() => {});
      throw new HttpError(410, 'source_gone', '這支影片已無法存取（可能已取消分享或刪除）。');
    }
    if (srcRes.status === 429) {
      await srcRes.body?.cancel?.().catch(() => {});
      throw new HttpError(429, 'drive_rate_limited', 'Google 雲端硬碟暫時限制存取，請稍後再試。');
    }
    if (!srcRes.ok || !srcRes.body) {
      await srcRes.body?.cancel?.().catch(() => {});
      throw new HttpError(502, 'source_fetch_failed', `從 Google 下載影片失敗（${srcRes.status}）。`);
    }

    const maxBytes = (cfg.upload.video_max_mb || 200) * 1024 * 1024;
    const streamLen = Number(srcRes.headers.get('content-length')) || size;
    if (streamLen > maxBytes) {
      await srcRes.body.cancel().catch(() => {});
      throw new HttpError(413, 'too_large', `影片超過 ${cfg.upload.video_max_mb || 200} MB 上限。`);
    }

    const initHeaders = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': mime,
    };
    if (streamLen > 0) initHeaders['x-upload-content-length'] = String(Math.floor(streamLen));
    const initRes = await dfetch(env, `${UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,mimeType,sha256Checksum`, {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify({ name: fileName, parents: [folderId], description: desc }),
    });
    if (!initRes.ok) {
      if (initRes.status === 401) tokCache = { enc: '', token: '', exp: 0 };
      await srcRes.body.cancel().catch(() => {});
      throw new HttpError(502, 'gdrive_init_failed', '無法建立雲端硬碟上傳工作階段，請稍後再試。');
    }
    const uploadUrl = initRes.headers.get('location') || '';
    if (!uploadUrl) {
      await srcRes.body.cancel().catch(() => {});
      throw new HttpError(502, 'gdrive_init_failed', '雲端硬碟未回傳上傳網址。');
    }

    const putHeaders = { 'content-type': mime };
    if (streamLen > 0) putHeaders['content-length'] = String(Math.floor(streamLen));
    const putInit = { method: 'PUT', headers: putHeaders, body: srcRes.body, duplex: 'half' };
    const originTest = testOrigin(env);
    let putRes;
    if (originTest && uploadUrl.startsWith(`${originTest}/`)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      try {
        putRes = await fetch(uploadUrl, { ...putInit, signal: ctrl.signal });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new HttpError(504, 'gdrive_timeout', '連線 Google 雲端硬碟逾時，請稍後再試。');
        throw new HttpError(502, 'gdrive_fetch_failed', '無法連線 Google 雲端硬碟，請稍後再試。');
      } finally {
        clearTimeout(timer);
      }
    } else {
      putRes = await dfetch(env, uploadUrl, putInit, 120_000);
    }
    let pj = null;
    try { pj = await putRes.json(); } catch { /* 非 JSON */ }
    if (putRes.ok && pj && pj.id) {
      return { driveId: pj.id, size: Number(pj.size) || streamLen || size, sha256: validSha256Hex(pj.sha256Checksum) };
    }
  }
  throw new HttpError(502, 'gdrive_copy_failed', '將影片轉存到雲端硬碟失敗，請稍後再試。');
}

// POST /api/u/{code}/video/init
// body: { hash, mime, size, orig_name?, uploader?, device?, groups?, segment?, exif_time?, time_src?, w?, h?, duration?, note? }
export async function videoInit(env, code, req) {
  checkRate(req);
  const cfg = await resolveUpload(env, code);
  if (!derive(cfg).is_open) throw new HttpError(403, 'upload_closed', '目前不開放上傳。');
  if (cfg.upload.video_enabled === false) throw new HttpError(403, 'video_disabled', '這個活動未開放上傳影片。');

  const st = await loadSiteState(env);
  if (!gdriveEnabled(env) || !st || !st.enc_rt || st.need_reconnect) {
    throw new HttpError(503, 'gdrive_not_connected', '主辦單位尚未連結影片雲端硬碟。');
  }

  const body = await readJson(req, 32 * 1024);
  const hash = typeof body.hash === 'string' ? body.hash.toLowerCase() : '';
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid', 'hash 必須是 64 位十六進位字串。');
  const mime = String(body.mime || '').split(';')[0].trim().toLowerCase();
  const ext = VIDEO_MIME_EXT[mime];
  if (!ext) throw new HttpError(415, 'bad_type', '只接受 MP4、MOV、WebM、3GP 影片。');
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'invalid', 'size 必須為正整數。');
  const maxMb = cfg.upload.video_max_mb || 200;
  if (size > maxMb * 1024 * 1024) throw new HttpError(413, 'too_large', `影片超過 ${maxMb} MB 上限。`);

  // 去重：同一 hash 已存在
  const prefix = `events/${cfg.id}/p/${hash}.`;
  const exist = await env.PHOTOS.list({ prefix, limit: 1 });
  if (exist.objects.length) {
    await recordUploadSafe(env, req, cfg, code);
    return json({ ok: true, hash, duplicate: true });
  }

  const { photos } = await loadPhotos(env, cfg.id);
  if (photos.length >= cfg.upload.max_photos) {
    throw new HttpError(409, 'event_full', '這個活動的照片與影片數量已達上限。');
  }

  const token = await getAccessToken(env, st);
  const folderId = await ensureEventFolder(env, token, st, cfg);
  const fileName = videoFileName(body, hash, ext, cfg);
  const origin = req.headers.get('origin') || new URL(req.url).origin;
  const desc = videoDescription(body, hash, cfg);

  const initRes = await dfetch(env, `${UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,mimeType`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': mime,
      'x-upload-content-length': String(Math.floor(size)),
      origin,
    },
    body: JSON.stringify({
      name: fileName,
      parents: [folderId],
      description: desc,
    }),
  });
  if (!initRes.ok) {
    if (initRes.status === 401) { tokCache = { enc: '', token: '', exp: 0 }; }
    throw new HttpError(502, 'gdrive_init_failed', '無法建立雲端硬碟上傳工作階段，請稍後再試。');
  }
  const uploadUrl = initRes.headers.get('location') || '';
  if (!uploadUrl) throw new HttpError(502, 'gdrive_init_failed', '雲端硬碟未回傳上傳網址。');

  const durRaw = Number(body.duration);
  const dur = Number.isFinite(durRaw) && durRaw > 0 && durRaw < 86400 ? Math.round(durRaw) : 0;
  const cleanedMeta = {
    orig_name: cleanText(body.orig_name, 80),
    uploader: cleanText(body.uploader, 24),
    device: cleanText(body.device, 64),
    groups: cleanGroups(body.groups, cfg),
    segment: cleanSegment(body.segment, cfg),
    exif_time: typeof body.exif_time === 'string' ? body.exif_time : '',
    time_src: body.time_src === 'mtime' ? 'mtime' : 'exif',
    w: Number(body.w) || 0,
    h: Number(body.h) || 0,
    original: body.original ? '1' : '',
    note: cleanText(body.note, 200),
  };
  const uploadToken = await makeState(env, {
    e: cfg.id,
    n: code,
    c: code,
    h: hash,
    m: mime,
    ext,
    sz: Math.floor(size),
    dur,
    f: folderId,
    u: uploadUrl,
    meta: cleanedMeta,
    x: Math.floor(Date.now() / 1000) + 3600,
  });
  return json({ ok: true, hash, duplicate: false, upload_url: uploadUrl, upload_token: uploadToken });
}

// POST /api/u/{code}/video/complete
// 接受 multipart/form-data（upload_token, drive_id?, thumb?）或 application/json（{ upload_token, drive_id? }）
export async function videoComplete(env, code, req) {
  checkRate(req);
  const cfg = await resolveUpload(env, code);
  if (!derive(cfg).is_open) throw new HttpError(403, 'upload_closed', '目前不開放上傳。');
  if (cfg.upload.video_enabled === false) throw new HttpError(403, 'video_disabled', '這個活動未開放上傳影片。');

  let uploadToken = '';
  let driveIdInput = '';
  let thumbBuf = null;
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    let form;
    try { form = await req.formData(); } catch { throw new HttpError(400, 'invalid', '表單格式錯誤。'); }
    uploadToken = String(form.get('upload_token') || '');
    driveIdInput = String(form.get('drive_id') || '').trim();
    const th = form.get('thumb');
    if (th && typeof th === 'object' && typeof th.arrayBuffer === 'function'
      && String(th.type).split(';')[0].trim().toLowerCase() === 'image/jpeg' && th.size > 0 && th.size <= 512 * 1024) {
      thumbBuf = await th.arrayBuffer();
    }
  } else {
    const body = await readJson(req, 64 * 1024);
    uploadToken = String(body.upload_token || '');
    driveIdInput = String(body.drive_id || '').trim();
  }

  const stTok = await readState(env, uploadToken);
  if (!stTok || stTok.c !== code || stTok.e !== cfg.id || !HASH_RE.test(stTok.h || '')) {
    throw new HttpError(400, 'invalid_token', '上傳憑證無效或已過期，請重新上傳影片。');
  }
  const hash = stTok.h;

  // 去重：若在完成前已經寫入過，直接回 duplicate
  const prefix = `events/${cfg.id}/p/${hash}.`;
  const exist = await env.PHOTOS.list({ prefix, limit: 1 });
  if (exist.objects.length) {
    await recordUploadSafe(env, req, cfg, code);
    return json({ ok: true, hash, duplicate: true });
  }

  const site = await loadSiteState(env);
  if (!gdriveEnabled(env) || !site || !site.enc_rt || site.need_reconnect) {
    throw new HttpError(503, 'gdrive_not_connected', '主辦單位尚未連結影片雲端硬碟。');
  }
  const token = await getAccessToken(env, site);

  let driveId = '';
  const originTest = testOrigin(env);
  if (driveIdInput && FOLDER_ID_RE.test(driveIdInput)) {
    const { res, j } = await driveJson(
      env,
      token,
      `/files/${encodeURIComponent(driveIdInput)}?supportsAllDrives=true&fields=id,size,mimeType,parents,description,trashed`,
    );
    const expectedFolder = stTok.f || (site.event_folders && site.event_folders[cfg.id]) || '';
    const matchParent = !expectedFolder || (Array.isArray(j?.parents) && j.parents.includes(expectedFolder));
    const matchDesc = typeof j?.description === 'string' && j.description.includes(`SHA-256: ${hash}`);
    const matchSize = Number(j?.size) === stTok.sz;
    if (res.ok && j && j.id && !j.trashed && matchParent && matchDesc && matchSize) {
      driveId = j.id;
    }
  } else if (typeof stTok.u === 'string' && (stTok.u.startsWith('https://www.googleapis.com/') || (originTest && stTok.u.startsWith(`${originTest}/`)))) {
    const finInit = { method: 'PUT', headers: { 'content-length': '0', 'content-range': `bytes */${stTok.sz}` } };
    const fin = originTest && stTok.u.startsWith(`${originTest}/`)
      ? await fetch(stTok.u, finInit).catch(() => null)
      : await dfetch(env, stTok.u, finInit).catch(() => null);
    if (fin && (fin.status === 200 || fin.status === 201)) {
      let fj = null;
      try { fj = await fin.json(); } catch { /* 非 JSON */ }
      if (fj && fj.id) driveId = fj.id;
    }
  }
  if (!driveId) throw new HttpError(400, 'upload_incomplete', '雲端硬碟尚未收到完整影片檔案。');

  if (thumbBuf) {
    await env.PHOTOS.put(`events/${cfg.id}/t/${hash}.jpg`, thumbBuf, { httpMetadata: { contentType: 'image/jpeg' } });
  }
  const sess = await getSession(env, req);
  const md = buildMetadata(stTok.meta || {}, hash, { size: stTok.sz }, !!thumbBuf, cfg, { sub: sess ? sess.sub : '' });
  md.media = 'video';
  md.drive_id = driveId;
  md.video_size = String(stTok.sz);
  if (stTok.dur > 0) md.duration = String(stTok.dur);
  fitMetadata(md);

  // R2 只寫 0-byte 索引物件（影片位元組全在 Google 雲端硬碟）
  const res = await env.PHOTOS.put(`${prefix}${stTok.ext}`, new Uint8Array(0), {
    httpMetadata: { contentType: stTok.m },
    customMetadata: md,
    onlyIf: { etagDoesNotMatch: '*' },
  });
  if (res === null) {
    await recordUploadSafe(env, req, cfg, code);
    return json({ ok: true, hash, duplicate: true });
  }

  const latest = await getConfig(env, cfg.id);
  if (!latest || latest.deleted_at) {
    await env.PHOTOS.delete([`${prefix}${stTok.ext}`, `events/${cfg.id}/t/${hash}.jpg`]);
    deleteDriveFile(env, driveId).catch(() => {});
    throw new HttpError(403, 'upload_closed', '目前不開放上傳。');
  }
  if ((latest.removed || []).includes(hash)) {
    try {
      await mutateConfig(env, latest, async () => getConfig(env, cfg.id), (c) => { c.removed = (c.removed || []).filter((h) => h !== hash); });
    } catch (e) { console.error('unremove failed', e && e.message); }
  }

  noteUploaded(cfg.id, {
    hash,
    ext: stTok.ext,
    size: stTok.sz,
    r2_size: 0,
    media: 'video',
    drive_id: driveId,
    duration: stTok.dur || 0,
    uploader: md.uploader || '',
    device: md.device || '',
    groups: JSON.parse(md.groups || '[]'),
    segment: md.segment || 'auto',
    exif_time: md.exif_time || '',
    time_src: md.time_src || '',
    w: Number(md.w) || 0,
    h: Number(md.h) || 0,
    uploaded_at: md.uploaded_at,
    original: md.original === '1',
    has_thumb: md.thumb === '1',
    note: md.note || '',
    sub: md.sub || '',
    replaced_from: '',
    edited_at: '',
  });
  await recordUploadSafe(env, req, cfg, code);
  return json({ ok: true, hash, drive_id: driveId, duplicate: false }, 201);
}

// ---------- 影片讀取串流與代理（支援 HTTP Range，給相簿／管理下載／MV 同步／Google 相簿同步使用） ----------
export async function openDriveReadStream(env, driveId, range = '') {
  const st = await loadSiteState(env);
  if (!gdriveEnabled(env) || !st || !st.enc_rt || st.need_reconnect) {
    throw new HttpError(503, 'gdrive_not_connected', '尚未連結影片雲端硬碟。');
  }
  const fetchOnce = async () => {
    const token = await getAccessToken(env, st);
    const headers = { authorization: `Bearer ${token}` };
    if (range) headers.range = range;
    return dfetch(env, `${DRIVE_API}/files/${encodeURIComponent(driveId)}?alt=media&supportsAllDrives=true`, { headers }, 60_000);
  };
  let res = await fetchOnce();
  if (res.status === 401) {
    tokCache = { enc: '', token: '', exp: 0 };
    res = await fetchOnce();
  }
  return res;
}

export async function streamDriveVideo(env, driveId, req, { mime = '', filename = '' } = {}) {
  const res = await openDriveReadStream(env, driveId, req.headers.get('range') || '');
  if (res.status === 404) throw new HttpError(404, 'not_found', '在雲端硬碟找不到這支影片。');
  if (!res.ok && res.status !== 206) {
    throw new HttpError(502, 'gdrive_stream_failed', `讀取雲端硬碟影片失敗（HTTP ${res.status}）。`);
  }
  const headers = {
    'content-type': res.headers.get('content-type') || mime || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=600',
    'content-security-policy': "default-src 'none'; sandbox",
  };
  if (res.headers.get('content-length')) headers['content-length'] = res.headers.get('content-length');
  if (res.headers.get('content-range')) headers['content-range'] = res.headers.get('content-range');
  if (filename) headers['content-disposition'] = `attachment; filename="${filename}"`;
  return new Response(res.body, { status: res.status, headers });
}
