// 參與者相簿：一起挑最佳照片（公開端 /api/a/{code}/*）與主辦者的相簿管理（/api/admin/{id}/album*）
// 選票存在 events/{id}/votes/{voter}.json：{ kind, name, picks:[hash], self:[hash], updated_at }
//   voter = g_{Google sub} 或 d_{sha256(裝置碼) 前 32 碼}；self 是「選自己拍的照片」，不佔名額
import {
  HttpError, json, readJson, safeEqual, sha256Hex, HASH_RE, UPLOAD_CODE_RE, ID_RE, EXT_MIME, newUploadCode,
} from './util.js';
import { getConfig, mutateConfig, albumVotingOpen, segmentOf } from './config.js';
import { loadPhotos } from './stats.js';
import { getSession, assertSameOrigin } from './session.js';
import { updateJson, NO_CHANGE } from './store.js';
import { requireRole } from './auth.js';
import { cleanText } from './upload.js';

const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const notFound = () => new HttpError(404, 'not_found', '相簿未開放，或連結已失效。');
const votesPrefix = (id) => `events/${id}/votes/`;
const MAX_OPTOUT_PER_VOTER = 10;

// ---------- 選票彙整（isolate 快取 15 秒） ----------
const TTL = 15_000;
const vcache = new Map(); // id -> { t, voters: Map(key -> data), counts: Map(hash -> {votes, self}) }

function countsOf(voters) {
  const counts = new Map();
  const bump = (h, k) => {
    const c = counts.get(h) || { votes: 0, self: 0 };
    c[k]++;
    counts.set(h, c);
  };
  for (const v of voters.values()) {
    for (const h of v.picks || []) bump(h, 'votes');
    for (const h of v.self || []) bump(h, 'self');
  }
  return counts;
}

export async function loadVotes(env, id) {
  const hit = vcache.get(id);
  if (hit && Date.now() - hit.t < TTL) return hit;
  const voters = new Map();
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: votesPrefix(id), limit: 1000, cursor });
    await Promise.all(page.objects.map(async (o) => {
      const r = await env.PHOTOS.get(o.key);
      if (!r) return;
      try {
        const d = await r.json();
        if (d && typeof d === 'object') voters.set(o.key.slice(votesPrefix(id).length).replace(/\.json$/, ''), d);
      } catch { /* 損壞的檔案略過 */ }
    }));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const entry = { t: Date.now(), voters, counts: countsOf(voters) };
  vcache.set(id, entry);
  return entry;
}

function noteVoter(id, key, data) {
  const e = vcache.get(id);
  if (!e) return;
  e.voters.set(key, data);
  e.counts = countsOf(e.voters);
}

// ---------- 相簿解析與存取權 ----------
export async function resolveAlbum(env, code) {
  if (!UPLOAD_CODE_RE.test(code)) throw notFound();
  const idx = await env.PHOTOS.get(`codes/a/${code}`);
  if (!idx) throw notFound();
  const id = (await idx.text()).trim();
  if (!ID_RE.test(id)) throw notFound();
  const cfg = await getConfig(env, id);
  if (!cfg || cfg.deleted_at || !cfg.album.enabled || !safeEqual(cfg.album.code || '', code)) throw notFound();
  return cfg;
}

// 相簿密碼通過後發的鑰匙（API 用 x-album-key，圖片用 ?k=）；換密碼或換連結就失效
const albumKey = async (cfg) => (await sha256Hex(`${cfg.album.code}:${cfg.album.password_hash}`)).slice(0, 32);

// 檢查存取權並取得身分；回傳 { sess, device, voter, kind }
async function access(env, req, url, cfg, { needIdentity = false, mutating = false } = {}) {
  const a = cfg.album;
  const sess = await getSession(env, req);
  if (a.access === 'google' && !sess) throw new HttpError(401, 'login_required', '這個相簿需要用 Google 登入才能看。');
  if (a.access === 'password') {
    const k = req.headers.get('x-album-key') || url.searchParams.get('k') || '';
    const pw = req.headers.get('x-album-pass');
    let ok = !!k && safeEqual(k, await albumKey(cfg));
    if (!ok && pw) ok = safeEqual(await sha256Hex(`${cfg.id}:${pw}`), a.password_hash || '');
    if (!ok) throw new HttpError(401, 'album_password', pw ? '相簿密碼不正確。' : '請輸入相簿密碼。');
  }
  const raw = req.headers.get('x-device') || url.searchParams.get('d') || '';
  const device = DEVICE_RE.test(raw) ? raw : '';
  let voter = null;
  let kind = null;
  if (sess) { voter = `g_${sess.sub}`; kind = 'google'; if (mutating) assertSameOrigin(req); }
  else if (device) { voter = `d_${(await sha256Hex(device)).slice(0, 32)}`; kind = 'device'; }
  if (needIdentity && !voter) throw new HttpError(400, 'invalid', '需要裝置碼（x-device）或登入。');
  return { sess, device, voter, kind };
}

// 相簿裡的照片：未排除、未被回報不想入鏡（待處理）、source=picked 時只放精選
function albumPhotos(cfg, photos) {
  const ex = new Set(cfg.excluded || []);
  const hidden = new Set((cfg.optouts || []).map((o) => o.hash));
  const picked = cfg.album.source === 'picked' ? new Set(cfg.album_picked || []) : null;
  return photos
    .filter((p) => !ex.has(p.hash) && !hidden.has(p.hash) && (!picked || picked.has(p.hash)))
    .sort((a, b) => ((a.exif_time || a.uploaded_at) < (b.exif_time || b.uploaded_at) ? -1 : 1));
}

const isMine = (p, who) => (!!who.device && !!p.device && safeEqual(p.device, who.device)) || (!!who.sess && !!p.sub && p.sub === who.sess.sub);

function votesVisible(cfg) {
  const m = cfg.album.show_votes;
  return m === 'live' || (m === 'after' && !albumVotingOpen(cfg));
}

async function readVoter(env, cfg, voter) {
  if (!voter) return null;
  const r = await env.PHOTOS.get(`${votesPrefix(cfg.id)}${voter}.json`);
  if (!r) return null;
  try { return await r.json(); } catch { return null; }
}

function meView(who, v, cfg) {
  const name = who.kind === 'google' ? (v && v.name) || who.sess.name || '' : (v && v.name) || '';
  return {
    kind: who.kind, // google | device | null
    name,
    needs_name: who.kind === 'device' && !name,
    picks: (v && v.picks) || [],
    self: (v && v.self) || [],
    optouts: (v && v.optouts) || [],
  };
}

// GET /api/a/{code}/info
export async function info(env, code, req, url) {
  const cfg = await resolveAlbum(env, code);
  const who = await access(env, req, url, cfg);
  const { photos } = await loadPhotos(env, cfg.id);
  const list = albumPhotos(cfg, photos);
  const show = votesVisible(cfg);
  const counts = show ? (await loadVotes(env, cfg.id)).counts : new Map();
  const v = await readVoter(env, cfg, who.voter);
  const out = {
    event: { name: cfg.basic.name, date: cfg.basic.date, end_date: cfg.basic.end_date || null, location: cfg.basic.location },
    album: {
      limit: cfg.album.limit, show_votes: cfg.album.show_votes, votes_visible: show, closes_at: cfg.album.closes_at,
      voting_open: albumVotingOpen(cfg), allow_download: cfg.album.allow_download, access: cfg.album.access,
    },
    segments: cfg.segments.map((s) => s.name),
    me: meView(who, v, cfg),
    login: who.sess ? { name: who.sess.name, email: who.sess.email } : null,
    photos: list.map((p) => {
      const c = counts.get(p.hash);
      const o = {
        hash: p.hash, segment: segmentOf(p, cfg.segments, cfg), uploader: p.uploader, exif_time: p.exif_time,
        mine: isMine(p, who), has_thumb: p.has_thumb, viewable: ['jpg', 'png', 'webp', 'gif'].includes(p.ext),
      };
      if (show) o.votes = c ? c.votes + c.self : 0;
      return o;
    }),
  };
  if (cfg.album.access === 'password') out.key = await albumKey(cfg);
  return json(out);
}

async function albumPhoto(env, cfg, hash) {
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid', '照片編號格式不正確。');
  const { photos } = await loadPhotos(env, cfg.id);
  const p = albumPhotos(cfg, photos).find((x) => x.hash === hash);
  if (!p) throw new HttpError(404, 'not_found', '這張照片不在相簿裡。');
  return p;
}

const IMG_HEADERS = { 'cache-control': 'private, max-age=600', 'content-security-policy': "default-src 'none'; sandbox" };

// GET /api/a/{code}/thumb/{hash}、/photo/{hash}（大圖；download=1 時附檔名下載，需主辦者允許）
export async function image(env, code, hash, kind, req, url) {
  const cfg = await resolveAlbum(env, code);
  await access(env, req, url, cfg);
  const p = await albumPhoto(env, cfg, hash);
  let obj = null;
  let type = 'image/jpeg';
  if (kind === 'thumb' && p.has_thumb) obj = await env.PHOTOS.get(`events/${cfg.id}/t/${hash}.jpg`);
  if (!obj) {
    if (kind === 'thumb' && !['jpg', 'png', 'webp', 'gif'].includes(p.ext)) throw new HttpError(404, 'not_found', '沒有預覽圖。');
    obj = await env.PHOTOS.get(`events/${cfg.id}/p/${hash}.${p.ext}`);
    type = EXT_MIME[p.ext] || 'application/octet-stream';
  }
  if (!obj) throw new HttpError(404, 'not_found', '找不到這張照片。');
  const headers = { ...IMG_HEADERS, 'content-type': type };
  if (kind === 'photo' && url.searchParams.get('download') === '1') {
    if (!cfg.album.allow_download) throw new HttpError(403, 'forbidden', '主辦者沒有開放下載原檔。');
    headers['content-disposition'] = `attachment; filename="photo-${hash.slice(0, 10)}.${p.ext}"`;
  }
  return new Response(obj.body, { headers });
}

function cleanName(v) {
  return cleanText(v, 24);
}

async function editVoter(env, cfg, who, mutate) {
  const key = `${votesPrefix(cfg.id)}${who.voter}.json`;
  const data = await updateJson(env, key, () => ({ kind: who.kind, name: '', picks: [], self: [], optouts: [], updated_at: null }), (d) => {
    for (const k of ['picks', 'self', 'optouts']) if (!Array.isArray(d[k])) d[k] = [];
    const r = mutate(d);
    if (r === NO_CHANGE) return NO_CHANGE;
    d.updated_at = new Date().toISOString();
    return undefined;
  });
  noteVoter(cfg.id, who.voter, data);
  return data;
}

// POST /api/a/{code}/me  { name }：設定暱稱（未登入者第一次挑選前必填）
export async function setMe(env, code, req, url) {
  const cfg = await resolveAlbum(env, code);
  const who = await access(env, req, url, cfg, { needIdentity: true, mutating: true });
  const body = await readJson(req, 4096);
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, 'invalid', '請輸入暱稱（1–24 字）。');
  const v = await editVoter(env, cfg, who, (d) => { d.name = name; });
  return json({ me: meView(who, v, cfg) });
}

// POST /api/a/{code}/vote  { hash, on, name? }
export async function vote(env, code, req, url) {
  const cfg = await resolveAlbum(env, code);
  const who = await access(env, req, url, cfg, { needIdentity: true, mutating: true });
  if (!albumVotingOpen(cfg)) throw new HttpError(403, 'voting_closed', '票選已截止。');
  const body = await readJson(req, 4096);
  if (typeof body.on !== 'boolean') throw new HttpError(400, 'invalid', '需要 on（布林）。');
  const p = await albumPhoto(env, cfg, String(body.hash || ''));
  const mine = isMine(p, who);
  const name = cleanName(body.name);
  const v = await editVoter(env, cfg, who, (d) => {
    if (name) d.name = name;
    if (who.kind === 'google' && !d.name) d.name = cleanName(who.sess.name) || '已登入使用者';
    if (who.kind === 'device' && !d.name) throw new HttpError(400, 'name_required', '請先輸入暱稱。');
    const list = mine ? 'self' : 'picks';
    const has = d[list].includes(p.hash);
    if (body.on === has) return name ? undefined : NO_CHANGE;
    if (!body.on) { d[list] = d[list].filter((h) => h !== p.hash); return undefined; }
    if (!mine && d.picks.length >= cfg.album.limit) {
      throw new HttpError(409, 'limit_reached', `每人最多選 ${cfg.album.limit} 張，請先取消一張。`);
    }
    d[list].push(p.hash);
    return undefined;
  });
  return json({ ok: true, mine, me: meView(who, v, cfg) });
}

// POST /api/a/{code}/optout  { hash }：照片先從相簿隱藏，等主辦者處理；不告訴攝影者是誰提出
export async function optout(env, code, req, url) {
  const cfg = await resolveAlbum(env, code);
  const who = await access(env, req, url, cfg, { needIdentity: true, mutating: true });
  const body = await readJson(req, 4096);
  const p = await albumPhoto(env, cfg, String(body.hash || ''));
  const v = await editVoter(env, cfg, who, (d) => {
    if (d.optouts.includes(p.hash)) return NO_CHANGE;
    if (d.optouts.length >= MAX_OPTOUT_PER_VOTER) throw new HttpError(429, 'too_many', '回報次數已達上限，請直接聯絡主辦者。');
    d.optouts.push(p.hash);
    return undefined;
  });
  await mutateConfig(env, cfg, async () => getConfig(env, cfg.id), (c) => {
    if ((c.optouts || []).some((o) => o.hash === p.hash)) return;
    c.optouts = [...(c.optouts || []), { hash: p.hash, at: new Date().toISOString(), voter: who.voter, name: (v && v.name) || '' }].slice(-500);
  });
  return json({ ok: true });
}

// ---------- 主辦者 ----------
// GET /api/admin/{id}/album：設定、統計、排行、不想入鏡待處理
export async function adminGet(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'viewer');
  const { photos } = await loadPhotos(env, cfg.id);
  const { voters, counts } = await loadVotes(env, cfg.id);
  const byHash = new Map(photos.map((p) => [p.hash, p]));
  const inAlbum = albumPhotos(cfg, photos);
  const prio = new Set(cfg.mv_priority || []);
  const picked = new Set(cfg.album_picked || []);
  const ex = new Set(cfg.excluded || []);
  let total = 0;
  let self = 0;
  let google = 0;
  let active = 0;
  for (const v of voters.values()) {
    const n = (v.picks || []).length + (v.self || []).length;
    if (n) active++;
    if (v.kind === 'google' && n) google++;
  }
  const ranking = [];
  for (const [h, c] of counts) {
    const p = byHash.get(h);
    if (!p || ex.has(h)) continue; // 已刪除、已排除的不列入
    total += c.votes + c.self;
    self += c.self;
    ranking.push({
      hash: h, segment: segmentOf(p, cfg.segments, cfg), uploader: p.uploader, exif_time: p.exif_time,
      votes: c.votes + c.self, self: c.self, priority: prio.has(h), picked: picked.has(h), has_thumb: p.has_thumb,
    });
  }
  ranking.sort((a, b) => b.votes - a.votes || a.self - b.self || (a.exif_time < b.exif_time ? -1 : 1));
  const { password_hash, ...album } = cfg.album;
  return json({
    album: { ...album, has_password: !!password_hash },
    album_url: cfg.album.code ? `/a/${cfg.album.code}` : null,
    voting_open: albumVotingOpen(cfg),
    stats: {
      voters: active, google_voters: google, total_votes: total, self_votes: self,
      photos_in_album: inAlbum.length, hidden: (cfg.optouts || []).length,
      eligible: photos.filter((p) => !ex.has(p.hash)).length,
    },
    ranking: ranking.slice(0, 300),
    optouts: (cfg.optouts || []).map((o) => {
      const p = byHash.get(o.hash);
      return { hash: o.hash, at: o.at, name: o.name || '', segment: p ? segmentOf(p, cfg.segments, cfg) : null, uploader: p ? p.uploader : '' };
    }),
    mv_priority: cfg.mv_priority || [],
    album_picked: cfg.album_picked || [],
  });
}

const reload = (env, req, id) => async () => (await requireRole(env, req, id, 'manager')).cfg;

// POST /api/admin/{id}/album/code：重設相簿連結（舊連結立即失效）
export async function rotateCode(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'manager');
  const code = newUploadCode();
  await env.PHOTOS.put(`codes/a/${code}`, cfg.id);
  let old = null;
  try {
    await mutateConfig(env, cfg, reload(env, req, id), (c) => { old = c.album.code; c.album.code = code; });
  } catch (e) {
    await env.PHOTOS.delete(`codes/a/${code}`);
    throw e;
  }
  if (old && old !== code) await env.PHOTOS.delete(`codes/a/${old}`);
  return json({ album_url: `/a/${code}` });
}

// POST /api/admin/{id}/album/optout  { hash, action: 'exclude' | 'keep' }
export async function resolveOptout(env, req, id) {
  const { cfg } = await requireRole(env, req, id, 'manager');
  const body = await readJson(req, 4096);
  if (!HASH_RE.test(String(body.hash || '')) || !['exclude', 'keep'].includes(body.action)) {
    throw new HttpError(400, 'invalid', '需要 hash 與 action（exclude 或 keep）。');
  }
  const saved = await mutateConfig(env, cfg, reload(env, req, id), (c) => {
    c.optouts = (c.optouts || []).filter((o) => o.hash !== body.hash);
    if (body.action === 'exclude') {
      const s = new Set(c.excluded || []);
      s.add(body.hash);
      c.excluded = [...s];
      c.mv_priority = (c.mv_priority || []).filter((h) => h !== body.hash);
    }
  });
  return json({ ok: true, optouts: saved.optouts.length });
}

// 共用：把 hashes 加入或移出設定中的某個清單
async function toggleList(env, req, id, field, max) {
  const { cfg } = await requireRole(env, req, id, 'manager');
  const body = await readJson(req, 64 * 1024);
  const hashes = body.hashes;
  if (!Array.isArray(hashes) || hashes.length > 1000 || !hashes.every((h) => typeof h === 'string' && HASH_RE.test(h)) || typeof body.on !== 'boolean') {
    throw new HttpError(400, 'invalid', '需要 hashes（陣列）與 on（布林）。');
  }
  const saved = await mutateConfig(env, cfg, reload(env, req, id), (c) => {
    const s = new Set(c[field] || []);
    for (const h of hashes) (body.on ? s.add(h) : s.delete(h));
    if (s.size > max) throw new HttpError(400, 'invalid', '清單過長。');
    c[field] = [...s];
  });
  return json({ ok: true, [field]: saved[field] });
}

// POST /api/admin/{id}/album/priority  { hashes, on } 或 { top_per_segment: N }（每個環節前 N 名標為 MV 優先）
export async function priority(env, req, id) {
  const peek = req.clone();
  let body = {};
  try { body = await peek.json(); } catch { /* 交給 toggleList 回 400 */ }
  if (body && Number.isInteger(body.top_per_segment)) {
    const { cfg } = await requireRole(env, req, id, 'manager');
    const n = body.top_per_segment;
    if (n < 1 || n > 20) throw new HttpError(400, 'invalid', 'top_per_segment 需為 1–20。');
    const { photos } = await loadPhotos(env, cfg.id);
    const { counts } = await loadVotes(env, cfg.id);
    const ex = new Set(cfg.excluded || []);
    const groups = new Map();
    for (const p of photos) {
      const c = counts.get(p.hash);
      if (!c || ex.has(p.hash) || c.votes + c.self === 0) continue;
      const seg = segmentOf(p, cfg.segments, cfg) || '（未分類）';
      if (!groups.has(seg)) groups.set(seg, []);
      groups.get(seg).push({ h: p.hash, v: c.votes + c.self, s: c.self });
    }
    const add = [];
    for (const list of groups.values()) {
      list.sort((a, b) => b.v - a.v || a.s - b.s);
      add.push(...list.slice(0, n).map((x) => x.h));
    }
    const saved = await mutateConfig(env, cfg, reload(env, req, id), (c) => {
      c.mv_priority = [...new Set([...(c.mv_priority || []), ...add])].slice(0, 5000);
    });
    return json({ ok: true, added: add.length, mv_priority: saved.mv_priority });
  }
  return toggleList(env, req, id, 'mv_priority', 5000);
}

// POST /api/admin/{id}/album/pick  { hashes, on }：source=picked 時放進／移出相簿
export async function pick(env, req, id) {
  return toggleList(env, req, id, 'album_picked', 20000);
}
