// API 路由：把 /api/* 分派到各模組
import {
  HttpError, json, readJson, safeEqual, newEventId, newUploadCode, newSecretKey, sha256Hex, isValidDate,
} from './util.js';
import { newConfig, saveConfig } from './config.js';
import * as upload from './upload.js';
import * as admin from './admin.js';
import * as sync from './sync.js';
import * as account from './account.js';
import * as mine from './mine.js';
import * as importer from './importer.js';
import * as album from './album.js';
import * as gphotos from './gphotos.js';
import { assertSameOrigin, getSession } from './session.js';

const methodNotAllowed = () => new HttpError(405, 'method_not_allowed', '不支援的請求方法。');
const notFound = () => new HttpError(404, 'not_found', '找不到這個 API。');

async function createEvent(env, req, url) {
  // 已登入（有效 cookie）時，依 §8.7：可建立者（can_create 或 CREATOR_EMAILS）免密碼；cookie 驗證的 POST 要檢查 Origin
  const sess = await getSession(env, req);
  if (sess) assertSameOrigin(req, url);
  const secret = req.headers.get('x-create-secret') || '';
  const secretOk = !!env.CREATE_SECRET && safeEqual(secret, env.CREATE_SECRET);
  if (!secretOk && !(sess && await account.canCreate(env, sess))) {
    throw new HttpError(401, 'bad_create_secret', '建立密碼不正確。');
  }
  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || Array.from(name).length > 60) throw new HttpError(400, 'invalid', '活動名稱需 1–60 字。');
  const date = body.date ?? null;
  if (date !== null && !isValidDate(date)) throw new HttpError(400, 'invalid', '日期格式需為 YYYY-MM-DD。');
  const endDate = body.end_date || null;
  if (endDate !== null && (!isValidDate(endDate) || !date || endDate < date)) throw new HttpError(400, 'invalid', '結束日期需為 YYYY-MM-DD，且不早於開始日期。');

  const id = newEventId();
  const adminCode = newSecretKey();
  const uploadCode = newUploadCode();
  const cfg = newConfig(id, { name, date, end_date: endDate }, { adminHash: await sha256Hex(adminCode), uploadCode, owner: sess });
  await env.PHOTOS.put(`codes/u/${uploadCode}`, id); // 先寫索引再寫設定；設定缺失時索引只會 404
  await saveConfig(env, cfg);
  if (sess) {
    // 活動已建立；加到使用者名下失敗時只記 log（回應仍有 admin_code，之後可用 claim 補上）
    try { await account.addOwnedEvent(env, sess, id, { secretOk }); } catch (e) { console.error('add owned event failed', e && e.message); }
  }
  return json({
    event_id: id,
    admin_code: adminCode,
    upload_code: uploadCode,
    admin_url: `/admin#e=${id}&k=${adminCode}`,
    upload_url: `/u/${uploadCode}`,
  }, 201);
}

export async function handleApi(req, env, url) {
  const parts = url.pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  }); // ['api', ...]
  const m = req.method;
  const [, a, b, c, d, e] = parts;

  if (a === 'health' && parts.length === 2) {
    if (m !== 'GET') throw methodNotAllowed();
    return json({ ok: true, version: '1' });
  }

  // Google 帳號（§8）
  if (a === 'auth' && parts.length === 3) {
    if (b === 'config') { if (m !== 'GET') throw methodNotAllowed(); return account.authConfig(env); }
    if (b === 'google') { if (m !== 'POST') throw methodNotAllowed(); return account.authGoogle(env, req, url); }
    if (b === 'logout') { if (m !== 'POST') throw methodNotAllowed(); return account.logout(env, req, url); }
    throw notFound();
  }
  if (a === 'me') {
    if (parts.length === 2) { if (m !== 'GET') throw methodNotAllowed(); return account.me(env, req); }
    if (parts.length === 4 && (b === 'events' || b === 'uploads')) {
      if (m !== 'DELETE') throw methodNotAllowed();
      return account.deleteMine(env, req, b, c);
    }
    throw notFound();
  }

  // 建立活動：主要路徑 /api/create；/api/events 保留相容
  // （/api/events 這類路徑常被廣告／追蹤阻擋清單擋下，瀏覽器會出現 ERR_BLOCKED_BY_CONTENT_BLOCKER）
  if ((a === 'create' || a === 'events') && parts.length === 2) {
    if (m !== 'POST') throw methodNotAllowed();
    return createEvent(env, req, url);
  }

  // /api/u/{code}/import/{list|photo|thumb/{aid}/{uid}}：貼 Google 相簿／雲端硬碟連結匯入
  if (a === 'u' && b && c === 'import') {
    if (parts.length === 5 && d === 'list') { if (m !== 'POST') throw methodNotAllowed(); return importer.list(env, b, req); }
    if (parts.length === 5 && d === 'photo') { if (m !== 'POST') throw methodNotAllowed(); return importer.photo(env, b, req); }
    if (parts.length === 7 && d === 'thumb') { if (m !== 'GET') throw methodNotAllowed(); return importer.thumb(env, b, e, parts[6]); }
    throw notFound();
  }

  // /api/u/{code}/mine[/{hash}[/thumb|replace]]：我上傳的照片
  if (a === 'u' && b && c === 'mine') {
    if (parts.length === 4) { if (m !== 'GET') throw methodNotAllowed(); return mine.list(env, b, req, url); }
    if (parts.length === 5) {
      if (m === 'PATCH') return mine.patch(env, b, d, req, url);
      if (m === 'DELETE') return mine.remove(env, b, d, req, url);
      throw methodNotAllowed();
    }
    if (parts.length === 6 && e === 'thumb') { if (m !== 'GET') throw methodNotAllowed(); return mine.thumb(env, b, d, req, url); }
    if (parts.length === 6 && e === 'replace') { if (m !== 'POST') throw methodNotAllowed(); return mine.replace(env, b, d, req, url); }
    throw notFound();
  }

  // /api/a/{code}/info|me|vote|optout|thumb/{hash}|photo/{hash}：參與者相簿
  if (a === 'a' && b) {
    if (parts.length === 4) {
      if (c === 'info') { if (m !== 'GET') throw methodNotAllowed(); return album.info(env, b, req, url); }
      const post = { me: album.setMe, vote: album.vote, optout: album.optout };
      if (post[c]) { if (m !== 'POST') throw methodNotAllowed(); return post[c](env, b, req, url); }
    }
    if (parts.length === 5 && (c === 'thumb' || c === 'photo')) {
      if (m !== 'GET') throw methodNotAllowed();
      return album.image(env, b, d, c, req, url);
    }
    throw notFound();
  }

  // /api/u/{code}/info|check|photo
  if (a === 'u' && b && parts.length === 4) {
    if (c === 'info') { if (m !== 'GET') throw methodNotAllowed(); return upload.info(env, b, url, req); }
    if (c === 'check') { if (m !== 'POST') throw methodNotAllowed(); return upload.check(env, b, req); }
    if (c === 'photo') { if (m !== 'POST') throw methodNotAllowed(); return upload.photo(env, b, req); }
    throw notFound();
  }

  // /api/admin/{id}[/action[/arg]]
  if (a === 'admin' && b) {
    // /api/admin/{id}/gphotos[/connect|sync|disconnect]：匯出到 Google 相簿
    if (c === 'gphotos') {
      if (parts.length === 4) {
        if (m === 'GET') return gphotos.status(env, req, b);
        if (m === 'PATCH') return gphotos.patch(env, req, b);
        throw methodNotAllowed();
      }
      const post = { connect: gphotos.connect, sync: gphotos.sync, disconnect: gphotos.disconnect };
      if (parts.length === 5 && post[d]) { if (m !== 'POST') throw methodNotAllowed(); return post[d](env, req, b); }
      throw notFound();
    }
    if (parts.length === 3) {
      if (m === 'GET') return admin.get(env, req, b);
      if (m === 'PATCH') return admin.patch(env, req, b);
      throw methodNotAllowed();
    }
    if (parts.length === 4) {
      const post = { exclude: admin.exclude, purge: admin.purge, 'rotate-upload-code': admin.rotateUploadCode };
      if (c === 'og-card') { if (m !== 'PUT') throw methodNotAllowed(); return admin.putOgCard(env, req, b, url); }
      if (c === 'sync-key') { if (m !== 'POST') throw methodNotAllowed(); return admin.syncKey(env, req, b, url); }
      if (post[c]) { if (m !== 'POST') throw methodNotAllowed(); return post[c](env, req, b); }
      if (c === 'members') {
        if (m === 'GET') return account.membersGet(env, req, b);
        if (m === 'POST') return account.membersAdd(env, req, b);
        throw methodNotAllowed();
      }
      if (c === 'claim') { if (m !== 'POST') throw methodNotAllowed(); return account.claim(env, req, b); }
      if (c === 'photos') { if (m !== 'GET') throw methodNotAllowed(); return admin.photos(env, req, b, url); }
      if (c === 'album') { if (m !== 'GET') throw methodNotAllowed(); return album.adminGet(env, req, b); }
      throw notFound();
    }
    if (parts.length === 5 && c === 'album') {
      const post = { code: album.rotateCode, optout: album.resolveOptout, priority: album.priority, pick: album.pick };
      if (!post[d]) throw notFound();
      if (m !== 'POST') throw methodNotAllowed();
      return post[d](env, req, b);
    }
    if (parts.length === 5 && c === 'members') {
      if (m !== 'DELETE') throw methodNotAllowed();
      return account.membersRemove(env, req, b, d);
    }
    if (parts.length === 5 && c === 'thumb') {
      if (m !== 'GET') throw methodNotAllowed();
      return admin.thumb(env, req, b, d);
    }
    if (parts.length === 5 && c === 'original') {
      if (m !== 'GET') throw methodNotAllowed();
      return admin.original(env, req, b, d);
    }
    throw notFound();
  }

  // /api/sync/{id}/manifest | photo/{hash} | requirements
  if (a === 'sync' && b) {
    if (parts.length === 4 && c === 'manifest') { if (m !== 'GET') throw methodNotAllowed(); return sync.manifest(env, req, b, url); }
    if (parts.length === 4 && c === 'requirements') { if (m !== 'POST') throw methodNotAllowed(); return sync.requirements(env, req, b); }
    if (parts.length === 5 && c === 'photo') { if (m !== 'GET') throw methodNotAllowed(); return sync.photo(env, req, b, d); }
    throw notFound();
  }
  void e;
  throw notFound();
}
