// 「我上傳的照片」：上傳者回頭檢視、修改註記、更換、刪除自己的照片
// 身分：這支手機的裝置碼（x-device 標頭；縮圖用 ?d=）或上傳時登入的 Google 帳號（md.sub）
import { HttpError, json, readJson, safeEqual, HASH_RE, EXT_MIME } from './util.js';
import { derive, mutateConfig, getConfig, segmentOf } from './config.js';
import {
  resolveUpload, readUploadForm, checkRate, cleanGroups, cleanSegment, cleanText, fitMetadata,
} from './upload.js';
import { loadPhotos, invalidate } from './stats.js';
import { getSession, assertSameOrigin } from './session.js';
import { loadVotes } from './album.js';
import { inferGroups, rotationsPublic } from './rotation.js';

export const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const notMine = () => new HttpError(404, 'not_found', '找不到這張照片，或不是由你上傳的。');

// 取得呼叫者身分：{ device, sess }；兩者皆無 → 400
export async function callerOf(env, req, url, { mutating = false } = {}) {
  const raw = req.headers.get('x-device') || url.searchParams.get('d') || '';
  const device = DEVICE_RE.test(raw) ? raw : '';
  const sess = await getSession(env, req);
  if (sess && mutating && !device) assertSameOrigin(req); // 只靠 cookie 的修改要檢查來源
  if (!device && !sess) throw new HttpError(400, 'invalid', '需要裝置碼（x-device）或登入。');
  return { device, sess };
}

export const ownsPhoto = (p, { device, sess }) =>
  (!!device && !!p.device && safeEqual(p.device, device)) || (!!sess && !!p.sub && p.sub === sess.sub);

async function findMine(env, cfg, hash, who) {
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid', '照片編號格式不正確。');
  invalidate(cfg.id); // 修改前讀最新狀態
  const { photos } = await loadPhotos(env, cfg.id);
  const p = photos.find((x) => x.hash === hash);
  if (!p || !ownsPhoto(p, who)) throw notMine();
  return p;
}

function assertEditable(cfg, p) {
  if ((cfg.excluded || []).includes(p.hash)) throw new HttpError(403, 'excluded', '主辦者已排除這張照片，無法修改。');
  if (!derive(cfg).is_open) throw new HttpError(403, 'upload_closed', '已過開放修改時間。');
}

function mineView(p, cfg, ex, counts) {
  const c = counts.get(p.hash);
  return {
    hash: p.hash,
    groups: p.groups,
    segment: p.segment, // 上傳者選的（auto＝依時間）
    segment_effective: segmentOf(p, cfg.segments, cfg), // 實際歸類；null＝待標環節
    note: p.note,
    exif_time: p.exif_time,
    uploaded_at: p.uploaded_at,
    edited_at: p.edited_at || null,
    replaced: !!p.replaced_from,
    excluded: ex.has(p.hash),
    has_thumb: p.has_thumb,
    votes: c ? c.votes + c.self : 0,
    priority: (cfg.mv_priority || []).includes(p.hash),
  };
}

// GET /api/u/{code}/mine
export async function list(env, code, req, url) {
  const cfg = await resolveUpload(env, code);
  const who = await callerOf(env, req, url);
  const { photos } = await loadPhotos(env, cfg.id);
  const ex = new Set(cfg.excluded || []);
  const counts = cfg.album && cfg.album.enabled ? (await loadVotes(env, cfg.id)).counts : new Map();
  const mine = photos
    .filter((p) => ownsPhoto(p, who))
    .sort((a, b) => ((a.exif_time || a.uploaded_at) < (b.exif_time || b.uploaded_at) ? -1 : 1))
    .map((p) => mineView(p, cfg, ex, counts));
  const d = derive(cfg);
  return json({
    event: { name: cfg.basic.name, date: cfg.basic.date, end_date: cfg.basic.end_date || null },
    editable: d.is_open,
    closes_at: cfg.upload.closes_at,
    groups: cfg.groups,
    segments: cfg.segments,
    rotations: rotationsPublic(cfg),
    album_url: cfg.album && cfg.album.enabled && cfg.album.code ? `/a/${cfg.album.code}` : null,
    login: sessView(who.sess),
    photos: mine,
  });
}
const sessView = (s) => (s ? { name: s.name, email: s.email } : null);

// GET /api/u/{code}/mine/{hash}/thumb?d=
export async function thumb(env, code, hash, req, url) {
  const cfg = await resolveUpload(env, code);
  const who = await callerOf(env, req, url);
  const p = await findMine(env, cfg, hash, who);
  let obj = p.has_thumb ? await env.PHOTOS.get(`events/${cfg.id}/t/${hash}.jpg`) : null;
  let type = 'image/jpeg';
  if (!obj) {
    obj = await env.PHOTOS.get(`events/${cfg.id}/p/${hash}.${p.ext}`);
    type = EXT_MIME[p.ext] || 'application/octet-stream';
  }
  if (!obj) throw notMine();
  return new Response(obj.body, {
    headers: { 'content-type': type, 'cache-control': 'private, max-age=600', 'content-security-policy': "default-src 'none'; sandbox" },
  });
}

// 改 R2 物件的 customMetadata（R2 沒有只改 metadata 的 API：讀出內容後以 etag 條件重寫）
async function rewriteMeta(env, key, mutate) {
  for (let i = 0; i < 4; i++) {
    const obj = await env.PHOTOS.get(key);
    if (!obj) throw notMine();
    const md = { ...(obj.customMetadata || {}) };
    mutate(md);
    const res = await env.PHOTOS.put(key, await obj.arrayBuffer(), {
      httpMetadata: obj.httpMetadata, customMetadata: fitMetadata(md), onlyIf: { etagMatches: obj.etag },
    });
    if (res !== null) return md;
  }
  throw new HttpError(409, 'conflict', '這張照片剛被修改，請重新整理後再試。');
}

// PATCH /api/u/{code}/mine/{hash}  body: { groups?, segment?, note? }
export async function patch(env, code, hash, req, url) {
  const cfg = await resolveUpload(env, code);
  const who = await callerOf(env, req, url, { mutating: true });
  const p = await findMine(env, cfg, hash, who);
  assertEditable(cfg, p);
  const body = await readJson(req, 16 * 1024);
  if (body.groups !== undefined && !Array.isArray(body.groups)) throw new HttpError(400, 'invalid', 'groups 需為陣列。');
  if (body.segment !== undefined && typeof body.segment !== 'string') throw new HttpError(400, 'invalid', 'segment 需為字串。');
  if (body.note !== undefined && typeof body.note !== 'string') throw new HttpError(400, 'invalid', 'note 需為字串。');
  const md = await rewriteMeta(env, `events/${cfg.id}/p/${hash}.${p.ext}`, (m) => {
    if (body.groups !== undefined) m.groups = JSON.stringify(cleanGroups(body.groups, cfg));
    if (body.segment !== undefined) m.segment = cleanSegment(body.segment, cfg);
    // 改成某個關卡、又沒有小隊：依輪站表反推
    if (body.segment !== undefined && JSON.parse(m.groups || '[]').length === 0) {
      const inferred = inferGroups(m.segment, m.exif_time || '', cfg);
      if (inferred.length) m.groups = JSON.stringify(inferred);
    }
    if (body.note !== undefined) m.note = cleanText(body.note, 200);
    m.edited_at = new Date().toISOString();
  });
  invalidate(cfg.id);
  let groups = [];
  try { groups = JSON.parse(md.groups || '[]'); } catch { /* 保持空陣列 */ }
  return json({ ok: true, hash, groups, segment: md.segment || 'auto', note: md.note || '', edited_at: md.edited_at });
}

// 照片離開活動時（刪除、被更換）：記到 removed，並從相簿精選／MV 優先移除
async function markRemoved(env, cfg, hash, { keepPickAs = null } = {}) {
  await mutateConfig(env, cfg, async () => getConfig(env, cfg.id), (c) => {
    const rm = new Set(c.removed || []);
    rm.add(hash);
    c.removed = [...rm].slice(-20000);
    const picked = (c.album_picked || []).includes(hash);
    c.album_picked = (c.album_picked || []).filter((h) => h !== hash);
    if (picked && keepPickAs) c.album_picked.push(keepPickAs);
    c.mv_priority = (c.mv_priority || []).filter((h) => h !== hash);
    c.optouts = (c.optouts || []).filter((o) => o.hash !== hash);
  });
}

// DELETE /api/u/{code}/mine/{hash}：隨時可刪（隱私優先），主辦者已排除的也可刪
export async function remove(env, code, hash, req, url) {
  const cfg = await resolveUpload(env, code);
  const who = await callerOf(env, req, url, { mutating: true });
  const p = await findMine(env, cfg, hash, who);
  await env.PHOTOS.delete([`events/${cfg.id}/p/${hash}.${p.ext}`, `events/${cfg.id}/t/${hash}.jpg`]);
  await markRemoved(env, cfg, hash);
  invalidate(cfg.id);
  return json({ ok: true, hash });
}

// POST /api/u/{code}/mine/{hash}/replace（multipart，同上傳）：小隊、環節、備註沿用；相簿票數歸零
export async function replace(env, code, hash, req, url) {
  checkRate(req);
  const cfg = await resolveUpload(env, code);
  const who = await callerOf(env, req, url, { mutating: true });
  const old = await findMine(env, cfg, hash, who);
  assertEditable(cfg, old);
  const { file, meta, hash: nh, mime, ext, thumbBuf } = await readUploadForm(req, cfg);
  if (nh === hash) throw new HttpError(400, 'same_photo', '選到的是同一張照片。');
  const exist = await env.PHOTOS.list({ prefix: `events/${cfg.id}/p/${nh}.`, limit: 1 });
  if (exist.objects.length) throw new HttpError(409, 'duplicate', '這張照片已經有人上傳過了。');

  const oldObj = await env.PHOTOS.head(`events/${cfg.id}/p/${hash}.${old.ext}`);
  const prev = (oldObj && oldObj.customMetadata) || {};
  const exif = typeof meta.exif_time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(meta.exif_time) ? meta.exif_time : '';
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 100000 ? String(Math.floor(Number(v))) : '');
  const md = fitMetadata({
    hash: nh,
    orig_name: cleanText(meta.orig_name, 80),
    uploader: prev.uploader || '',
    device: prev.device || '',
    sub: prev.sub || '',
    groups: prev.groups || '[]',
    segment: prev.segment || 'auto',
    note: prev.note || '',
    exif_time: exif,
    time_src: exif ? (meta.time_src === 'mtime' ? 'mtime' : 'exif') : '',
    w: num(meta.w),
    h: num(meta.h),
    original: meta.original === '1' || meta.original === true ? '1' : '',
    uploaded_at: prev.uploaded_at || new Date().toISOString(),
    edited_at: new Date().toISOString(),
    replaced_from: hash,
    thumb: thumbBuf ? '1' : '',
  });
  if (thumbBuf) await env.PHOTOS.put(`events/${cfg.id}/t/${nh}.jpg`, thumbBuf, { httpMetadata: { contentType: 'image/jpeg' } });
  const res = await env.PHOTOS.put(`events/${cfg.id}/p/${nh}.${ext}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: mime }, customMetadata: md, onlyIf: { etagDoesNotMatch: '*' },
  });
  if (res === null) throw new HttpError(409, 'duplicate', '這張照片已經有人上傳過了。');
  await env.PHOTOS.delete([`events/${cfg.id}/p/${hash}.${old.ext}`, `events/${cfg.id}/t/${hash}.jpg`]);
  await markRemoved(env, cfg, hash, { keepPickAs: nh });
  invalidate(cfg.id);
  return json({ ok: true, old_hash: hash, hash: nh }, 201);
}
