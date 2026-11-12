// Google 帳號：登入／登出、/api/me、成員管理、認領、上傳記錄（合約 §8）
import {
  HttpError, ID_RE, json, readJson, safeEqual, sha256Hex,
} from './util.js';
import { verifyIdToken } from './auth-google.js';
import {
  assertSameOrigin, clearCookie, getSession, googleClientId, hasSessionCookie, isSameOrigin,
  loginEnabled, makeSessionValue, requireSession, sessionCookie,
} from './session.js';
import { NO_CHANGE, readJsonObj, updateJson } from './store.js';
import { derive, getConfig, mutateConfig } from './config.js';
import { reloadAdmin } from './admin.js';
import { requireRole } from './auth.js';

const MAX_MEMBERS = 20;
const MAX_UPLOADS = 100; // users.uploads 最多幾筆
const MAX_SHARES = 200; // shares/{hash}.events 最多幾筆
const MAX_OWNED = 500; // users.events 最多幾筆
const ME_POOL = 6; // /api/me 展開活動設定時的並行數

export const usersKey = (sub) => `users/${sub}.json`;
export const sharesKey = async (email) => `shares/${await sha256Hex(normEmail(email))}.json`;
export const normEmail = (s) => String(s ?? '').trim().toLowerCase();
const nowIso = () => new Date().toISOString();

// ---------- 建立活動的資格（CREATOR_EMAILS） ----------
// 逗號（或分號、空白）分隔；每項是完整 Email，或 @網域（只比對該網域本身，不含子網域）
export function creatorEmailMatch(env, email) {
  const e = normEmail(email);
  if (!e) return false;
  const domain = e.slice(e.lastIndexOf('@'));
  return String(env?.CREATOR_EMAILS || '')
    .split(/[,;\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .some((x) => (x.startsWith('@') ? x === domain : x === e));
}

// ---------- users/{sub}.json ----------
const newUser = (u) => ({
  sub: u.sub, email: u.email, name: u.name || '', picture: u.picture || '',
  created_at: nowIso(), last_login_at: nowIso(), can_create: false, events: [], uploads: [],
});
function fixUser(d) { // 補齊缺漏欄位，避免舊檔／損壞檔造成例外
  if (!Array.isArray(d.events)) d.events = [];
  if (!Array.isArray(d.uploads)) d.uploads = [];
  if (typeof d.can_create !== 'boolean') d.can_create = false;
  return d;
}

// 登入時建立或更新使用者
async function upsertUser(env, claims) {
  return updateJson(env, usersKey(claims.sub), () => newUser(claims), (d) => {
    fixUser(d);
    Object.assign(d, { email: claims.email, name: claims.name, picture: claims.picture, last_login_at: nowIso() });
  });
}

// 修改某使用者的檔案（不存在時用 session 資料建立）
const editUser = (env, sess, fn) => updateJson(env, usersKey(sess.sub), () => newUser(sess), (d) => fn(fixUser(d)));

async function loadUser(env, sub) {
  const r = await readJsonObj(env, usersKey(sub));
  return r && r.data ? fixUser(r.data) : null;
}

// 對外的使用者資料；can_create 是「有效值」＝ 檔案裡的旗標 或 Email 符合 CREATOR_EMAILS
const publicUser = (env, sess, stored) => ({
  sub: sess.sub, email: sess.email, name: sess.name, picture: sess.picture,
  can_create: !!(stored && stored.can_create) || creatorEmailMatch(env, sess.email),
});

// 是否可免密碼建立活動
export async function canCreate(env, sess) {
  if (creatorEmailMatch(env, sess.email)) return true;
  const u = await loadUser(env, sess.sub);
  return !!(u && u.can_create);
}

// 活動建立成功後，把活動加到建立者名下；secretOk 時順便把 can_create 設為 true
export async function addOwnedEvent(env, sess, eventId, { secretOk = false } = {}) {
  await editUser(env, sess, (u) => {
    if (!u.events.some((e) => e.event_id === eventId)) u.events.unshift({ event_id: eventId, added_at: nowIso() });
    u.events = u.events.slice(0, MAX_OWNED);
    if (secretOk) u.can_create = true;
  });
}

// ---------- shares/{sha256(lower(email))}.json ----------
async function setShare(env, email, entry) {
  await updateJson(env, await sharesKey(email), () => ({ events: [] }), (d) => {
    if (!Array.isArray(d.events)) d.events = [];
    d.events = d.events.filter((e) => e.event_id !== entry.event_id);
    d.events.unshift(entry);
    d.events = d.events.slice(0, MAX_SHARES);
  });
}
async function dropShare(env, email, eventId) {
  await updateJson(env, await sharesKey(email), () => ({ events: [] }), (d) => {
    const before = Array.isArray(d.events) ? d.events : [];
    const after = before.filter((e) => e.event_id !== eventId);
    if (after.length === before.length) return NO_CHANGE;
    d.events = after;
  });
}

// ---------- 登入／登出／設定 ----------
export function authConfig(env) {
  return json({ google_client_id: loginEnabled(env) ? googleClientId(env) : null });
}

export async function authGoogle(env, req, url) {
  if (!loginEnabled(env)) throw new HttpError(404, 'not_found', '尚未啟用 Google 登入。');
  // 防登入 CSRF：若帶了 Origin 就必須同源（瀏覽器的 fetch POST 一定會帶）
  if (req.headers.get('origin') && !isSameOrigin(req, url)) throw new HttpError(403, 'bad_origin', '請求來源不符，請從本站頁面操作。');
  const body = await readJson(req, 16 * 1024);
  const claims = await verifyIdToken(env, body.credential, { hostname: url.hostname });
  const stored = await upsertUser(env, claims);
  const sess = { sub: claims.sub, email: claims.email, name: claims.name || claims.email, picture: claims.picture };
  const cookie = sessionCookie(await makeSessionValue(env, sess), url);
  return json({ user: publicUser(env, sess, stored) }, 200, { 'set-cookie': cookie });
}

export async function logout(env, req, url) {
  // 帶有效 cookie 時依 §8.3 要求同源；cookie 已無效／過期則照樣清除
  if (await getSession(env, req)) assertSameOrigin(req, url);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(url) });
}

// ---------- /api/me ----------
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

export async function me(env, req) {
  const sess = await getSession(env, req);
  if (!sess) return json({ user: null });
  let user = await loadUser(env, sess.sub);
  if (!user) user = await editUser(env, sess, () => {});

  // 同一請求內每個活動設定只讀一次
  const cfgs = new Map();
  const loadCfg = (id) => {
    if (!cfgs.has(id)) cfgs.set(id, ID_RE.test(id) ? getConfig(env, id).catch(() => undefined) : Promise.resolve(null));
    return cfgs.get(id);
  };
  const ids = new Set();
  for (const e of user.events.slice(0, MAX_OWNED)) ids.add(e.event_id);
  const shareDoc = (await readJsonObj(env, await sharesKey(sess.email)))?.data;
  const shareEntries = shareDoc && Array.isArray(shareDoc.events) ? shareDoc.events.slice(0, MAX_SHARES) : [];
  for (const e of shareEntries) ids.add(e.event_id);
  for (const e of user.uploads.slice(0, MAX_UPLOADS)) ids.add(e.event_id);
  await pool([...ids], ME_POOL, loadCfg);

  const brief = (cfg, role) => ({
    event_id: cfg.id, name: cfg.basic.name, date: cfg.basic.date, end_date: cfg.basic.end_date || null, stage: derive(cfg).stage, role,
  });

  // 自己的活動：設定存在且 owner 確實是自己；否則視為過期索引，順手清掉
  const events = [];
  const staleOwned = [];
  for (const e of user.events) {
    const cfg = await loadCfg(e.event_id);
    if (cfg === undefined) continue; // 暫時讀不到（R2 錯誤）：不顯示也不清
    if (cfg && cfg.owner && cfg.owner.sub === sess.sub) events.push(brief(cfg, 'owner'));
    else staleOwned.push(e.event_id);
  }

  // 別人分享給我的：以活動設定裡的 members 為準（索引只用來找到活動）
  const shared = [];
  const staleShared = [];
  for (const e of shareEntries) {
    const cfg = await loadCfg(e.event_id);
    if (cfg === undefined) continue;
    const m = cfg && (cfg.members || []).find((x) => normEmail(x.email) === normEmail(sess.email));
    if (m && !(cfg.owner && cfg.owner.sub === sess.sub)) shared.push(brief(cfg, m.role));
    else staleShared.push(e.event_id);
  }

  const uploads = [];
  for (const u of user.uploads.slice(0, MAX_UPLOADS)) {
    const cfg = await loadCfg(u.event_id);
    const valid = !!(cfg && !cfg.deleted_at && cfg.upload_code === u.upload_code);
    uploads.push({
      event_id: u.event_id,
      name: (cfg && cfg.basic.name) || u.name || '',
      upload_url: `/u/${u.upload_code}`,
      count: u.count || 0,
      last_at: u.last_at || null,
      valid,
    });
  }

  // 順手清索引（失敗不影響回應）
  try {
    if (staleOwned.length) await editUser(env, sess, (u) => { u.events = u.events.filter((e) => !staleOwned.includes(e.event_id)); });
    if (staleShared.length) {
      await updateJson(env, await sharesKey(sess.email), () => ({ events: [] }), (d) => {
        d.events = (d.events || []).filter((e) => !staleShared.includes(e.event_id));
      });
    }
  } catch (e) {
    console.error('me: 清除過期索引失敗', e && e.message);
  }

  return json({ user: publicUser(env, sess, user), events, shared, uploads });
}

// DELETE /api/me/events/{id}、/api/me/uploads/{id}：只從自己的清單移除，不影響活動
export async function deleteMine(env, req, kind, id) {
  const sess = await requireSession(env, req);
  assertSameOrigin(req);
  if (!ID_RE.test(id)) throw new HttpError(400, 'invalid', '活動編號格式不正確。');
  await editUser(env, sess, (u) => {
    const key = kind === 'events' ? 'events' : 'uploads';
    const before = u[key].length;
    u[key] = u[key].filter((e) => e.event_id !== id);
    if (u[key].length === before) return NO_CHANGE;
  });
  return json({ ok: true });
}

// ---------- 上傳記錄 ----------
// 上傳 API 的身分：只有 Origin 同源時才採用 cookie（不同源或缺 Origin 就當匿名，上傳本身照常進行，不回 403）
export async function uploadSession(env, req) {
  const s = await getSession(env, req);
  return s && isSameOrigin(req) ? s : null;
}

// 成功上傳後記到帳號：同活動合併、count + 1。任何失敗只記 log，不影響上傳結果
export async function recordUploadSafe(env, req, cfg, code) {
  try {
    const s = await uploadSession(env, req);
    if (!s) return;
    await editUser(env, s, (u) => {
      const i = u.uploads.findIndex((x) => x.event_id === cfg.id);
      const prev = i >= 0 ? u.uploads[i] : null;
      const entry = {
        event_id: cfg.id, upload_code: code, name: cfg.basic.name,
        count: (prev ? prev.count || 0 : 0) + 1, last_at: nowIso(),
      };
      if (i >= 0) u.uploads.splice(i, 1);
      u.uploads.unshift(entry);
      u.uploads = u.uploads.slice(0, MAX_UPLOADS);
    });
  } catch (e) {
    console.error('record upload failed', e && e.message);
  }
}

// 上傳頁 info 的 me 欄位；未登入回 undefined
export async function uploadMe(env, req, cfg) {
  const s = await getSession(env, req);
  if (!s) return undefined;
  let count = 0;
  try {
    const u = await loadUser(env, s.sub);
    count = (u && u.uploads.find((x) => x.event_id === cfg.id)?.count) || 0;
  } catch (e) {
    console.error('uploadMe failed', e && e.message);
  }
  return { name: s.name, email: s.email, count };
}

// ---------- 成員 ----------
const EMAIL_RE = /^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+\.[^\s@<>()"',;:\\]+$/;
const membersView = (cfg) => ({
  owner: cfg.owner ? { email: cfg.owner.email } : null,
  members: (cfg.members || []).map((m) => ({ email: m.email, role: m.role, added_by: m.added_by, added_at: m.added_at })),
});

export async function membersGet(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'viewer');
  return json(membersView(cfg));
}

export async function membersAdd(env, req, id) {
  const ac = await requireRole(env, req, id, 'owner');
  const body = await readJson(req);
  const email = normEmail(body.email);
  if (typeof body.email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new HttpError(400, 'invalid', 'Email 格式不正確。');
  }
  if (body.role !== 'manager' && body.role !== 'viewer') throw new HttpError(400, 'invalid', 'role 只能是 manager 或 viewer。');
  const addedBy = ac.user ? ac.user.email : (ac.cfg.owner ? ac.cfg.owner.email : '(管理碼)');
  if (ac.cfg.owner && normEmail(ac.cfg.owner.email) === email) throw new HttpError(400, 'invalid', '不能把擁有者加成成員。');
  if (!ac.cfg.members.some((m) => normEmail(m.email) === email) && ac.cfg.members.length >= MAX_MEMBERS) {
    throw new HttpError(400, 'invalid', `成員最多 ${MAX_MEMBERS} 位。`);
  }
  const at = nowIso();
  // 新增：先寫索引再寫活動設定（設定才是權威；索引寫了但設定失敗時，/api/me 會忽略並清掉它）
  await setShare(env, email, { event_id: ac.cfg.id, role: body.role, added_at: at, added_by: addedBy });
  const saved = await mutateConfig(env, ac.cfg, reloadAdmin(env, req, id, 'owner'), (c) => {
    const i = c.members.findIndex((m) => normEmail(m.email) === email);
    if (i >= 0) c.members[i] = { ...c.members[i], role: body.role };
    else {
      if (c.members.length >= MAX_MEMBERS) throw new HttpError(400, 'invalid', `成員最多 ${MAX_MEMBERS} 位。`);
      if (c.owner && normEmail(c.owner.email) === email) throw new HttpError(400, 'invalid', '不能把擁有者加成成員。');
      c.members.push({ email, role: body.role, added_by: addedBy, added_at: at });
    }
  });
  return json(membersView(saved));
}

export async function membersRemove(env, req, id, emailParam) {
  const ac = await requireRole(env, req, id, 'owner');
  const email = normEmail(emailParam);
  if (!ac.cfg.members.some((m) => normEmail(m.email) === email)) throw new HttpError(404, 'not_found', '找不到這位成員。');
  // 移除：先改活動設定（立即撤銷權限），再清索引
  const saved = await mutateConfig(env, ac.cfg, reloadAdmin(env, req, id, 'owner'), (c) => {
    c.members = c.members.filter((m) => normEmail(m.email) !== email);
  });
  try {
    await dropShare(env, email, saved.id);
  } catch (e) {
    console.error('drop share failed', e && e.message); // 權限已撤銷；殘留索引會被 /api/me 忽略並清掉
  }
  return json(membersView(saved));
}

// ---------- 認領 ----------
// POST /api/admin/{id}/claim：Bearer 管理碼 ＋ 登入 cookie。活動沒有 owner 時設為目前使用者
export async function claim(env, req, id) {
  if (!ID_RE.test(id)) throw new HttpError(400, 'invalid', '活動編號格式不正確。');
  const hdr = req.headers.get('authorization') || '';
  const token = /^Bearer\s+(\S{1,256})$/i.exec(hdr)?.[1];
  if (!token) throw new HttpError(401, 'unauthorized', '認領需要管理碼。');
  const sess = await requireSession(env, req);
  assertSameOrigin(req);
  const cfg = await getConfig(env, id);
  if (!cfg) throw new HttpError(404, 'not_found', '找不到這個活動。');
  if (!safeEqual(await sha256Hex(token), cfg.admin_hash)) throw new HttpError(401, 'unauthorized', '金鑰不正確或已失效。');
  if (cfg.owner && cfg.owner.sub !== sess.sub) throw new HttpError(409, 'has_owner', '這個活動已經有擁有者了。');
  const reload = async () => {
    const c = await getConfig(env, id);
    if (!c) throw new HttpError(404, 'not_found', '找不到這個活動。');
    return c;
  };
  let wasMember = false;
  const saved = await mutateConfig(env, cfg, reload, (c) => {
    if (c.owner && c.owner.sub !== sess.sub) throw new HttpError(409, 'has_owner', '這個活動已經有擁有者了。');
    c.owner = { sub: sess.sub, email: sess.email };
    const before = c.members.length;
    c.members = c.members.filter((m) => normEmail(m.email) !== normEmail(sess.email)); // 成為 owner 後不再是成員
    wasMember = c.members.length !== before;
  });
  await addOwnedEvent(env, sess, id);
  if (wasMember) {
    try { await dropShare(env, sess.email, id); } catch (e) { console.error('drop share failed', e && e.message); }
  }
  return json({ ok: true, event_id: saved.id, owner: { email: saved.owner.email } });
}
