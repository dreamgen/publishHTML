// 管理 API（Bearer 管理碼）
import {
  HttpError, json, readJson, HASH_RE, newUploadCode, newSecretKey, sha256Hex, limitedBody,
  OG_EXT_MIME, ogKey,
} from './util.js';
import { requireRole } from './auth.js';
import {
  applyPatch, derive, publicConfig, mutateConfig, ensureInvite, inviteEffective, hashAlbumPassword,
} from './config.js';
import {
  adminStats, invalidate, parsePhoto, photoView, purgePhotos,
} from './stats.js';
import { EXT_MIME } from './util.js';

// ac = requireRole 的結果：{ role, auth }。viewer 看不到同步金鑰明碼（§8.6）
async function view(env, cfg, origin, ac) {
  const d = derive(cfg);
  const config = publicConfig(cfg);
  if (ac.role === 'viewer' && config.sync) delete config.sync.key;
  return {
    config,
    role: ac.role,
    auth: ac.auth,
    stage: d.stage,
    is_open: d.is_open,
    delete_at: d.delete_at,
    must_missing: d.must_missing,
    upload_url: `/u/${cfg.upload_code}`,
    album_url: cfg.album && cfg.album.code ? `/a/${cfg.album.code}` : null,
    invite_effective: inviteEffective(cfg, origin),
    stats: await adminStats(env, cfg),
  };
}

export async function get(env, req, id) {
  const ac = await requireRole(env, req, id, 'viewer');
  return json(await view(env, ac.cfg, new URL(req.url).origin, ac));
}

// 版本衝突時重新讀取，並重新驗證身分與角色（成員剛被移除時，重試會被擋下，不會把修改寫回）
export const reloadAdmin = (env, req, id, minRole) => async () => (await requireRole(env, req, id, minRole)).cfg;

export async function patch(env, req, id) {
  const ac = await requireRole(env, req, id, 'manager');
  const body = await readJson(req);
  const opts = {};
  if (body.album && typeof body.album === 'object' && typeof body.album.password === 'string') {
    opts.albumPwHash = await hashAlbumPassword(ac.cfg.id, body.album.password);
  }
  // 第一次開啟相簿時產生相簿連結碼（先寫索引再寫設定，與建立活動相同）
  let newCode = null;
  if (body.album && body.album.enabled === true && !(ac.cfg.album && ac.cfg.album.code)) {
    newCode = newUploadCode();
    await env.PHOTOS.put(`codes/a/${newCode}`, ac.cfg.id);
  }
  const cfg = await mutateConfig(env, ac.cfg, reloadAdmin(env, req, id, 'manager'), (c) => {
    applyPatch(c, body, opts);
    if (newCode && !c.album.code) c.album.code = newCode;
  });
  if (newCode && cfg.album.code !== newCode) await env.PHOTOS.delete(`codes/a/${newCode}`);
  return json(await view(env, cfg, new URL(req.url).origin, ac));
}

export async function exclude(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'manager');
  const body = await readJson(req);
  if (typeof body.hash !== 'string' || !HASH_RE.test(body.hash) || typeof body.excluded !== 'boolean') {
    throw new HttpError(400, 'invalid', '需要 hash（64 位十六進位）與 excluded（布林）。');
  }
  const saved = await mutateConfig(env, cfg, reloadAdmin(env, req, id, 'manager'), (c) => {
    const set = new Set(c.excluded || []);
    if (body.excluded) set.add(body.hash);
    else set.delete(body.hash);
    if (set.size > 20000) throw new HttpError(400, 'invalid', '排除清單過長。');
    c.excluded = [...set];
  });
  return json({ ok: true, excluded_count: saved.excluded.length });
}

// 找照片物件（不知道副檔名時用前綴搜尋）
async function findPhotoKey(env, id, hash) {
  const page = await env.PHOTOS.list({ prefix: `events/${id}/p/${hash}.`, limit: 1 });
  return page.objects[0]?.key || null;
}

export async function thumb(env, req, id, hash) {
  const { cfg } = await requireRole(env, req, id, 'viewer');
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid', '照片編號格式不正確。');
  let obj = await env.PHOTOS.get(`events/${cfg.id}/t/${hash}.jpg`);
  let type = 'image/jpeg';
  if (!obj) {
    const key = await findPhotoKey(env, cfg.id, hash);
    if (key) {
      obj = await env.PHOTOS.get(key);
      type = EXT_MIME[key.split('.').pop()] || 'application/octet-stream';
    }
  }
  if (!obj) throw new HttpError(404, 'not_found', '找不到這張照片。');
  return new Response(obj.body, {
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=3600',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}

// 原圖下載（方案 B：管理頁「下載全部照片」後手動拖進 Google 相簿）
export async function original(env, req, id, hash) {
  const { cfg } = await requireRole(env, req, id, 'manager');
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid', '照片編號格式不正確。');
  const key = await findPhotoKey(env, cfg.id, hash);
  const obj = key ? await env.PHOTOS.get(key) : null;
  if (!obj) throw new HttpError(404, 'not_found', '找不到這張照片。');
  const ext = key.split('.').pop();
  return new Response(obj.body, {
    headers: {
      'content-type': EXT_MIME[ext] || 'application/octet-stream',
      'content-length': String(obj.size),
      'content-disposition': `attachment; filename="${hash.slice(0, 10)}.${ext}"`,
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}

export async function photos(env, req, id, url) {
  const { cfg } = await requireRole(env, req, id, 'viewer');
  const cursor = url.searchParams.get('cursor') || undefined;
  const page = await env.PHOTOS.list({
    prefix: `events/${cfg.id}/p/`, include: ['customMetadata'], limit: 200, cursor,
  });
  const ex = new Set(cfg.excluded || []);
  const list = page.objects.map(parsePhoto).filter(Boolean).map((p) => ({ ...photoView(p, cfg, ex), ext: p.ext, size: p.size }));
  return json({ photos: list, cursor: page.truncated ? page.cursor : null });
}

export async function rotateUploadCode(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'owner');
  const code = newUploadCode();
  await env.PHOTOS.put(`codes/u/${code}`, cfg.id);
  let old = null;
  try {
    await mutateConfig(env, cfg, reloadAdmin(env, req, id, 'owner'), (c) => { old = c.upload_code; c.upload_code = code; });
  } catch (e) {
    await env.PHOTOS.delete(`codes/u/${code}`); // 沒換成功就收回新索引
    throw e;
  }
  if (old && old !== code) await env.PHOTOS.delete(`codes/u/${old}`); // 舊碼立即失效（resolveUpload 另外比對 config，索引殘留也無效）
  return json({ upload_code: code, upload_url: `/u/${code}` });
}

export async function syncKey(env, req, id, url) {
  const { cfg } = await requireRole(env, req, id, 'manager');
  const key = newSecretKey();
  const sync = { key, hash: await sha256Hex(key), created_at: new Date().toISOString() };
  await mutateConfig(env, cfg, reloadAdmin(env, req, id, 'manager'), (c) => { c.sync = { ...sync }; });
  return json({ sync_key: key, sync_url: `${url.origin}/api/sync/${cfg.id}` });
}

export async function purge(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'owner');
  const body = await readJson(req);
  if (body.confirm !== '刪除') throw new HttpError(400, 'invalid', '請在 confirm 填入「刪除」以確認。');
  // 先標記 deleted_at（上傳立即關閉），再刪 p/ 與 t/；中途失敗時排程會再補刪
  await mutateConfig(env, cfg, reloadAdmin(env, req, id, 'owner'), (c) => { c.deleted_at = c.deleted_at || new Date().toISOString(); });
  const deleted = await purgePhotos(env, cfg.id);
  invalidate(cfg.id);
  return json({ ok: true, deleted });
}


// ---------- 分享預覽圖 ----------
const OG_MAX_BYTES = 1.5 * 1024 * 1024;
const OG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };

// 檔頭魔術字串，避免宣稱 PNG 實際卻是別的東西
function sniffOk(ext, b) {
  if (ext === 'png') return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

// PUT /api/admin/{id}/og-card[?auto=1|0]：body 為 image/png 或 image/jpeg（≤1.5MB）
export async function putOgCard(env, req, id, url) {
  const ac = await requireRole(env, req, id, 'manager');
  const cfg = ac.cfg;
  if (cfg.deleted_at) throw new HttpError(409, 'purged', '這個活動的照片已刪除，無法再更新預覽圖。');
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = OG_TYPES[type];
  if (!ext) throw new HttpError(415, 'bad_type', '預覽圖只接受 image/png 或 image/jpeg。');
  if (Number(req.headers.get('content-length') || 0) > OG_MAX_BYTES) {
    throw new HttpError(413, 'too_large', '預覽圖最大 1.5MB。');
  }
  // 以串流計數，不信任 Content-Length
  const lb = limitedBody(req, OG_MAX_BYTES);
  let bytes;
  try {
    bytes = new Uint8Array(await new Response(lb.body).arrayBuffer());
  } catch {
    if (lb.exceeded()) throw new HttpError(413, 'too_large', '預覽圖最大 1.5MB。');
    throw new HttpError(400, 'invalid', '無法讀取請求內容。');
  }
  if (!sniffOk(ext, bytes)) throw new HttpError(415, 'bad_type', '檔案內容不是有效的 PNG 或 JPEG。');

  const autoQ = url.searchParams.get('auto');
  const auto = autoQ === '1' ? true : autoQ === '0' ? false : null;
  const other = ext === 'png' ? 'jpg' : 'png';
  await env.PHOTOS.put(ogKey(cfg.id, ext), bytes, { httpMetadata: { contentType: OG_EXT_MIME[ext] } });
  const saved = await mutateConfig(env, cfg, reloadAdmin(env, req, id, 'manager'), (c) => {
    const inv = ensureInvite(c);
    inv.card_ext = ext;
    inv.card_updated_at = new Date().toISOString();
    if (auto !== null) inv.card_auto = auto;
  });
  await env.PHOTOS.delete(ogKey(cfg.id, other)); // 換了格式時清掉舊檔
  return json(await view(env, saved, new URL(req.url).origin, ac));
}
