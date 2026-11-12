// 上傳頁 API：info / check / photo
import {
  HttpError, json, readJson, safeEqual, clip, limitedBody, HASH_RE, ID_RE, UPLOAD_CODE_RE, MIME_EXT,
} from './util.js';
import { getConfig, derive, renderNotice, mutateConfig } from './config.js';
import { loadPhotos, noteUploaded, uploadProgress } from './stats.js';
import { recordUploadSafe, uploadMe, uploadSession } from './account.js';
import { inferGroups, rotationsPublic } from './rotation.js';

const notFound = () => new HttpError(404, 'not_found', '找不到這個上傳連結，可能已失效。');

// 由上傳碼找出活動設定；碼不存在、已換碼或活動已刪除都回 404
export async function resolveUpload(env, code) {
  if (!UPLOAD_CODE_RE.test(code)) throw notFound();
  const idx = await env.PHOTOS.get(`codes/u/${code}`);
  if (!idx) throw notFound();
  const id = (await idx.text()).trim();
  if (!ID_RE.test(id)) throw notFound();
  const cfg = await getConfig(env, id);
  if (!cfg || !safeEqual(cfg.upload_code, code)) throw notFound();
  return cfg;
}

export async function info(env, code, url, req) {
  const cfg = await resolveUpload(env, code);
  const d = derive(cfg);
  const device = url.searchParams.get('device') || '';
  const prog = await uploadProgress(env, cfg, device ? clip(device, 64) : '');
  const out = {
    event: {
      name: cfg.basic.name, date: cfg.basic.date, end_date: cfg.basic.end_date || null, location: cfg.basic.location, organizer: cfg.basic.organizer,
    },
    stage: d.stage,
    is_open: d.is_open,
    opens_at: cfg.upload.opens_at,
    closes_at: cfg.upload.closes_at,
    delete_at: d.delete_at,
    notice: renderNotice(cfg),
    max_mb: cfg.upload.max_mb,
    groups: cfg.groups,
    segments: cfg.segments,
    rotations: rotationsPublic(cfg),
    import: cfg.upload.import_enabled !== false, // 可貼 Google 相簿／雲端硬碟連結匯入
    import_drive: cfg.upload.import_enabled !== false && !!(typeof env.GOOGLE_API_KEY === 'string' && env.GOOGLE_API_KEY.trim()),
    progress: prog.progress,
  };
  if (device) out.device_count = prog.device_count;
  // 已登入：多回此帳號在本活動的累計張數（§8.7）
  const mine = await uploadMe(env, req, cfg);
  if (mine) out.me = mine;
  return json(out);
}

export async function check(env, code, req) {
  const cfg = await resolveUpload(env, code);
  const body = await readJson(req);
  const hashes = body.hashes;
  if (!Array.isArray(hashes) || hashes.length > 200 || !hashes.every((h) => typeof h === 'string' && HASH_RE.test(h))) {
    throw new HttpError(400, 'invalid', 'hashes 需為最多 200 個 64 位十六進位字串。');
  }
  const { hashes: have } = await loadPhotos(env, cfg.id);
  return json({ existing: [...new Set(hashes)].filter((h) => have.has(h)) });
}

// ---- 速率限制：每 IP 每分鐘 120 次（單一 isolate 內的軟性防護） ----
const rate = new Map(); // ip -> {start, n}
function rateLimited(ip) {
  const now = Date.now();
  if (rate.size > 2000) for (const [k, v] of rate) if (now - v.start > 60_000) rate.delete(k);
  let r = rate.get(ip);
  if (!r || now - r.start > 60_000) {
    r = { start: now, n: 0 };
    rate.set(ip, r);
  }
  r.n++;
  return r.n > 120;
}

const isFile = (v) => v && typeof v === 'object' && typeof v.arrayBuffer === 'function';

// 去除換行與控制字元：這些字串之後會經 manifest 交給使用者的 AI，避免夾帶多行指令
export const cleanText = (v, n) => clip(String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim(), n);

// 只接受活動設定中存在的小隊／環節（auto 代表依拍攝時間自動判斷）
export function cleanGroups(groups, cfg) {
  if (!Array.isArray(groups)) return [];
  const allowed = new Set((cfg && cfg.groups) || []);
  return [...new Set(groups.filter((g) => typeof g === 'string' && allowed.has(g)))].slice(0, 10);
}
export function cleanSegment(segment, cfg) {
  const segNames = new Set(((cfg && cfg.segments) || []).map((x) => x.name));
  return typeof segment === 'string' && segNames.has(segment) ? segment : 'auto';
}

// customMetadata 總長要 < 2KB；過長時依序縮短檔名、備註、小隊
export function fitMetadata(md) {
  for (const k of Object.keys(md)) if (md[k] === '' || md[k] === undefined || md[k] === null) delete md[k];
  const size = () => new TextEncoder().encode(JSON.stringify(md)).length;
  if (size() > 1900) md.orig_name = clip(md.orig_name || '', 20);
  if (size() > 1900) delete md.orig_name;
  if (size() > 1900 && md.note) md.note = clip(md.note, 60);
  if (size() > 1900) md.groups = '[]';
  return md;
}

// 整理 meta 成 customMetadata（全字串、總長 < 2KB）；extra 可帶 sub（登入帳號）
export function buildMetadata(meta, hash, file, hasThumb, cfg, extra = {}) {
  const clean = cleanText;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 100000 ? String(Math.floor(Number(v))) : '');
  let groups = cleanGroups(meta.groups, cfg);
  const segment = cleanSegment(meta.segment, cfg);
  const exif = typeof meta.exif_time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(meta.exif_time) ? meta.exif_time : '';
  // 固定在某一關的攝影師（選了關卡、沒勾小隊）：依輪站表反推是哪一隊
  if (!groups.length && segment !== 'auto' && cfg) groups = inferGroups(segment, exif, cfg);
  const md = {
    hash,
    orig_name: clean(meta.orig_name, 80),
    uploader: clean(meta.uploader, 24),
    device: clean(meta.device, 64),
    groups: JSON.stringify(groups),
    segment,
    exif_time: exif,
    time_src: exif ? (meta.time_src === 'mtime' ? 'mtime' : 'exif') : '',
    w: num(meta.w),
    h: num(meta.h),
    original: meta.original === '1' || meta.original === 1 || meta.original === true ? '1' : '',
    uploaded_at: new Date().toISOString(),
    thumb: hasThumb ? '1' : '',
    note: clean(meta.note, 200),
    sub: typeof extra.sub === 'string' ? extra.sub.slice(0, 64) : '',
  };
  return fitMetadata(md);
}

// 每個活動的張數計數（用來擋 max_photos），沿用照片列表快取
async function currentCount(env, id) {
  return (await loadPhotos(env, id)).photos.length;
}

export function checkRate(req) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) throw new HttpError(429, 'rate_limited', '上傳太頻繁，請稍候一分鐘再試。');
}

// 解析上傳表單（photo、thumb、meta），上傳與更換照片共用
export async function readUploadForm(req, cfg) {
  const maxBytes = cfg.upload.max_mb * 1024 * 1024;
  // 先看 Content-Length，過大直接拒絕（留 2MB 給縮圖與欄位）
  const cl = Number(req.headers.get('content-length') || 0);
  if (cl > maxBytes + 2 * 1024 * 1024) throw new HttpError(413, 'too_large', `檔案超過 ${cfg.upload.max_mb} MB 上限。`);

  // 讀 body 時邊讀邊計數：Content-Length 可省略（chunked）或與實際不符，不能只靠上面的檢查
  const lb = limitedBody(req, maxBytes + 2 * 1024 * 1024);
  let form;
  try {
    form = await new Request(req.url, { method: 'POST', headers: req.headers, body: lb.body }).formData();
  } catch {
    if (lb.exceeded()) throw new HttpError(413, 'too_large', `檔案超過 ${cfg.upload.max_mb} MB 上限。`);
    throw new HttpError(400, 'invalid', '請以 multipart/form-data 上傳。');
  }
  const file = form.get('photo');
  if (!isFile(file)) throw new HttpError(400, 'invalid', '缺少 photo 檔案。');

  let meta;
  try {
    meta = JSON.parse(String(form.get('meta') || ''));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw 0;
  } catch {
    throw new HttpError(400, 'invalid', 'meta 必須是 JSON 物件。');
  }
  const hash = typeof meta.hash === 'string' ? meta.hash.toLowerCase() : '';
  if (!HASH_RE.test(hash)) throw new HttpError(400, 'invalid', 'meta.hash 必須是 64 位十六進位字串。');

  // MIME 白名單；副檔名由 MIME 決定
  const mime = String(file.type || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw new HttpError(415, 'bad_type', '只接受 JPEG、PNG、WebP、HEIC、HEIF、GIF 圖片。');
  if (file.size > maxBytes) throw new HttpError(413, 'too_large', `檔案超過 ${cfg.upload.max_mb} MB 上限。`);
  if (file.size === 0) throw new HttpError(400, 'invalid', '檔案是空的。');

  // 縮圖（選填）：必須是 JPEG 且 ≤ 512KB，不合格就忽略
  let thumbBuf = null;
  const th = form.get('thumb');
  if (isFile(th) && String(th.type).split(';')[0].trim().toLowerCase() === 'image/jpeg' && th.size > 0 && th.size <= 512 * 1024) {
    thumbBuf = await th.arrayBuffer();
  }
  return { file, meta, hash, mime, ext, thumbBuf };
}

export async function photo(env, code, req) {
  checkRate(req);
  const cfg = await resolveUpload(env, code);
  if (!derive(cfg).is_open) throw new HttpError(403, 'upload_closed', '目前不開放上傳。');
  const { file, meta, hash, mime, ext, thumbBuf } = await readUploadForm(req, cfg);

  // 去重：同一 hash 已存在（任何副檔名）就不覆寫
  const prefix = `events/${cfg.id}/p/${hash}.`;
  const exist = await env.PHOTOS.list({ prefix, limit: 1 });
  if (exist.objects.length) {
    await recordUploadSafe(env, req, cfg, code);
    return json({ ok: true, hash, duplicate: true });
  }

  if ((await currentCount(env, cfg.id)) >= cfg.upload.max_photos) {
    throw new HttpError(409, 'event_full', '這個活動的照片數量已達上限。');
  }

  if (thumbBuf) {
    await env.PHOTOS.put(`events/${cfg.id}/t/${hash}.jpg`, thumbBuf, { httpMetadata: { contentType: 'image/jpeg' } });
  }
  const sess = await uploadSession(env, req);
  const md = buildMetadata(meta, hash, file, !!thumbBuf, cfg, { sub: sess ? sess.sub : '' });
  const res = await env.PHOTOS.put(`${prefix}${ext}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: mime },
    customMetadata: md,
    onlyIf: { etagDoesNotMatch: '*' }, // 同鍵已存在則不覆寫
  });
  if (res === null) {
    await recordUploadSafe(env, req, cfg, code);
    return json({ ok: true, hash, duplicate: true });
  }

  // 上傳途中活動被刪除（purge 先設 deleted_at 再刪檔）：把剛寫入的檔案收回，避免留下孤兒照片
  const latest = await getConfig(env, cfg.id);
  if (!latest || latest.deleted_at) {
    await env.PHOTOS.delete([`${prefix}${ext}`, `events/${cfg.id}/t/${hash}.jpg`]);
    throw new HttpError(403, 'upload_closed', '目前不開放上傳。');
  }

  // 先前被上傳者刪掉（或更換掉）的同一張照片又被上傳：從 removed 拿掉，同步時才不會被當成已排除
  if ((latest.removed || []).includes(hash)) {
    try {
      await mutateConfig(env, latest, async () => getConfig(env, cfg.id), (c) => { c.removed = (c.removed || []).filter((h) => h !== hash); });
    } catch (e) { console.error('unremove failed', e && e.message); }
  }

  // 補進快取，讓同一 isolate 的統計立即反映
  noteUploaded(cfg.id, {
    hash, ext, size: file.size, uploader: md.uploader || '', device: md.device || '',
    groups: JSON.parse(md.groups || '[]'), segment: md.segment || 'auto', exif_time: md.exif_time || '',
    time_src: md.time_src || '', w: Number(md.w) || 0, h: Number(md.h) || 0, uploaded_at: md.uploaded_at,
    original: md.original === '1', has_thumb: md.thumb === '1', note: md.note || '', sub: md.sub || '',
    replaced_from: '', edited_at: '',
  });
  await recordUploadSafe(env, req, cfg, code); // 記到登入帳號的「我上傳過的活動」；失敗只記 log
  return json({ ok: true, hash, duplicate: false }, 201);
}
