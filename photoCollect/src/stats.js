// 統計：逐頁列出 R2 照片物件彙整，isolate 記憶體快取 30 秒（以 event_id 為 key）
import { segmentOf } from './config.js';
import { rotationStats } from './rotation.js';
import { OG_KEYS } from './util.js';

const TTL_MS = 30_000;
const cache = new Map(); // id -> { t, photos: [], hashes: Set }

// 把 R2 物件轉成照片紀錄
export function parsePhoto(obj) {
  const md = obj.customMetadata || {};
  const m = /\/p\/([0-9a-f]{64})\.([a-z0-9]+)$/.exec(obj.key);
  if (!m) return null;
  let groups = [];
  try {
    const g = JSON.parse(md.groups || '[]');
    if (Array.isArray(g)) groups = g.filter((x) => typeof x === 'string');
  } catch {}
  return {
    hash: m[1],
    ext: m[2],
    size: obj.size || 0,
    uploader: md.uploader || '',
    device: md.device || '',
    groups,
    segment: md.segment || 'auto',
    exif_time: md.exif_time || '',
    time_src: md.time_src || '',
    w: Number(md.w) || 0,
    h: Number(md.h) || 0,
    uploaded_at: md.uploaded_at || (obj.uploaded ? new Date(obj.uploaded).toISOString() : ''),
    original: md.original === '1',
    has_thumb: md.thumb === '1',
    note: md.note || '',
    sub: md.sub || '', // 上傳時登入的 Google 帳號（只用於「我上傳的照片」權限判斷，不對外回傳）
    replaced_from: md.replaced_from || '',
    edited_at: md.edited_at || '',
    src: md.src || '', // 連結匯入來源（gp:… / gd:…），避免重複匯入
  };
}

// 取得某活動的全部照片（快取 30 秒）
export async function loadPhotos(env, id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < TTL_MS) return hit;
  const photos = [];
  let cursor;
  do {
    const page = await env.PHOTOS.list({
      prefix: `events/${id}/p/`,
      include: ['customMetadata'],
      limit: 1000,
      cursor,
    });
    for (const o of page.objects) {
      const p = parsePhoto(o);
      if (p) photos.push(p);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const entry = { t: Date.now(), photos, hashes: new Set(photos.map((p) => p.hash)) };
  cache.set(id, entry);
  return entry;
}

// 上傳成功後直接補進快取（若已有快取），讓同一 isolate 立即看得到
export function noteUploaded(id, photo) {
  const e = cache.get(id);
  if (!e || e.hashes.has(photo.hash)) return;
  e.photos.push(photo);
  e.hashes.add(photo.hash);
}

export function invalidate(id) {
  cache.delete(id);
}

// 回傳給前端的單張照片摘要（recent / photos 共用）
export function photoView(p, cfg, excludedSet) {
  return {
    hash: p.hash,
    uploader: p.uploader,
    groups: p.groups,
    segment: segmentOf(p, cfg.segments, cfg),
    exif_time: p.exif_time,
    uploaded_at: p.uploaded_at,
    excluded: excludedSet.has(p.hash),
    has_thumb: p.has_thumb,
  };
}

// 各環節進度（目標張數 = 同名 shots 的 target 加總）
function progressOf(cfg, counted) {
  const by = new Map(cfg.segments.map((s) => [s.name, 0]));
  let unclassified = 0;
  for (const p of counted) {
    const s = segmentOf(p, cfg.segments, cfg);
    if (s === null) unclassified++;
    else by.set(s, (by.get(s) || 0) + 1);
  }
  const by_segment = cfg.segments.map((s) => ({
    name: s.name,
    have: by.get(s.name) || 0,
    target: cfg.shots.filter((x) => x.segment === s.name).reduce((a, x) => a + (x.target || 0), 0),
  }));
  return { by_segment, unclassified };
}

// 上傳頁用：total（不含已排除）、by_segment、unclassified、device_count
export async function uploadProgress(env, cfg, device) {
  const { photos } = await loadPhotos(env, cfg.id);
  const ex = new Set(cfg.excluded || []);
  const counted = photos.filter((p) => !ex.has(p.hash));
  const { by_segment, unclassified } = progressOf(cfg, counted);
  const out = { progress: { total: counted.length, by_segment, unclassified } };
  if (device) out.device_count = photos.filter((p) => p.device === device).length;
  return out;
}

// 管理頁用：完整統計。total / by_segment / by_group / bytes / uploaders 都不含已排除的照片
export async function adminStats(env, cfg) {
  const { photos } = await loadPhotos(env, cfg.id);
  const ex = new Set(cfg.excluded || []);
  const counted = photos.filter((p) => !ex.has(p.hash));
  const { by_segment, unclassified } = progressOf(cfg, counted);
  const groupCount = new Map(cfg.groups.map((g) => [g, 0]));
  for (const p of counted) for (const g of p.groups) if (groupCount.has(g)) groupCount.set(g, groupCount.get(g) + 1);
  const recent = [...photos]
    .sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : a.uploaded_at > b.uploaded_at ? -1 : 0))
    .slice(0, 24)
    .map((p) => photoView(p, cfg, ex));
  const last = photos.reduce((m, p) => (p.uploaded_at > m ? p.uploaded_at : m), '');
  return {
    total: counted.length,
    bytes: counted.reduce((a, p) => a + p.size, 0),
    uploaders: new Set(counted.map((p) => p.device).filter(Boolean)).size,
    last_upload_at: last || null,
    excluded_count: photos.filter((p) => ex.has(p.hash)).length,
    by_segment,
    unclassified,
    by_group: [...groupCount].map(([name, have]) => ({ name, have })),
    rotations: rotationStats(cfg, counted, (p) => segmentOf(p, cfg.segments, cfg)),
    recent,
  };
}

// 刪除活動的 p/ 與 t/ 物件（分頁，每批 ≤1000）；回傳刪掉的照片張數
export async function purgePhotos(env, id) {
  let photos = 0;
  for (const sub of ['p', 't', 'votes']) {
    for (;;) {
      const page = await env.PHOTOS.list({ prefix: `events/${id}/${sub}/`, limit: 1000 });
      if (!page.objects.length) break;
      await env.PHOTOS.delete(page.objects.map((o) => o.key));
      if (sub === 'p') photos += page.objects.length;
    }
  }
  await env.PHOTOS.delete(OG_KEYS(id)); // 分享預覽圖一併刪除（不存在也沒關係）
  invalidate(id);
  return photos;
}
