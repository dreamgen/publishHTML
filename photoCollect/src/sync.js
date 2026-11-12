// 同步 API（Bearer 同步金鑰）：給本地 mvctl sync 使用
import { HttpError, json, readJson, HASH_RE, EXT_MIME } from './util.js';
import { requireSync } from './auth.js';
import { parsePhoto } from './stats.js';
import { mutateConfig } from './config.js';
import { loadVotes } from './album.js';
import { rotationsPublic } from './rotation.js';

const NOTHING = Symbol('nothing-to-update');

export async function manifest(env, req, id, url) {
  const cfg = await requireSync(env, req, id);
  const cursor = url.searchParams.get('cursor') || undefined;
  const page = await env.PHOTOS.list({
    prefix: `events/${cfg.id}/p/`, include: ['customMetadata'], limit: 1000, cursor,
  });
  const ex = new Set(cfg.excluded || []);
  const prio = new Set(cfg.mv_priority || []);
  const counts = cfg.album && cfg.album.enabled ? (await loadVotes(env, cfg.id)).counts : new Map();
  const photos = page.objects
    .map(parsePhoto)
    .filter((p) => p && !ex.has(p.hash))
    .map((p) => ({
      hash: p.hash, ext: p.ext, size: p.size, uploader: p.uploader, device: p.device, groups: p.groups,
      segment: p.segment, exif_time: p.exif_time, time_src: p.time_src, w: p.w, h: p.h,
      uploaded_at: p.uploaded_at, original: p.original,
      note: p.note, edited_at: p.edited_at || '',
      priority: prio.has(p.hash), // 主辦者標的 MV 優先
      votes: (counts.get(p.hash) || { votes: 0 }).votes, // 相簿票數（不含攝影者自選）
    }));
  return json({
    event: {
      id: cfg.id, name: cfg.basic.name, date: cfg.basic.date, end_date: cfg.basic.end_date || null, location: cfg.basic.location, organizer: cfg.basic.organizer,
    },
    segments: cfg.segments,
    rotations: rotationsPublic(cfg),
    groups: cfg.groups,
    shots: cfg.shots,
    // 上傳者刪除、更換掉的照片也放進 excluded，讓舊版 mvctl 一樣會移到 _excluded/
    excluded: [...new Set([...(cfg.excluded || []), ...(cfg.removed || [])])],
    removed: cfg.removed || [],
    photos,
    cursor: page.truncated ? page.cursor : null,
  });
}

export async function photo(env, req, id, hash) {
  const cfg = await requireSync(env, req, id);
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid', '照片編號格式不正確。');
  if ((cfg.excluded || []).includes(hash)) throw new HttpError(404, 'not_found', '找不到這張照片。');
  const page = await env.PHOTOS.list({ prefix: `events/${cfg.id}/p/${hash}.`, limit: 1 });
  const key = page.objects[0]?.key;
  const etag = `"${hash}"`;
  if (!key) throw new HttpError(404, 'not_found', '找不到這張照片。');
  const headers = {
    etag,
    'cache-control': 'private, max-age=3600',
    'content-security-policy': "default-src 'none'; sandbox",
  };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const obj = await env.PHOTOS.get(key);
  if (!obj) throw new HttpError(404, 'not_found', '找不到這張照片。');
  headers['content-type'] = EXT_MIME[key.split('.').pop()] || 'application/octet-stream';
  headers['content-length'] = String(obj.size);
  return new Response(obj.body, { headers });
}

// MV Studio 回寫各主題需要的張數：同名環節的 shots.target 改成 photos_needed、source 設為 mv
export async function requirements(env, req, id) {
  const cfg = await requireSync(env, req, id);
  const body = await readJson(req);
  const reqs = body.requirements;
  if (!reqs || typeof reqs !== 'object' || Array.isArray(reqs)) {
    throw new HttpError(400, 'invalid', 'requirements 需為物件。');
  }
  // 讀-改-寫用條件寫入；衝突時重新讀取並重新驗證同步金鑰（金鑰若剛被重發，舊金鑰在此被擋下，不會把舊 hash 寫回）
  let updated = 0;
  const apply = (c) => {
    updated = 0;
    for (const [name, v] of Object.entries(reqs)) {
      const n = v && v.photos_needed;
      if (!Number.isInteger(n) || n < 0 || n > 9999) continue;
      for (const s of c.shots) {
        if (s.segment === name) {
          s.target = n;
          s.source = 'mv';
          updated++;
        }
      }
    }
    if (!updated) throw NOTHING;
  };
  try {
    await mutateConfig(env, cfg, () => requireSync(env, req, id), apply);
  } catch (e) {
    if (e !== NOTHING) throw e;
  }
  return json({ ok: true, updated });
}
