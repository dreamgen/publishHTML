// 活動設定：讀寫、預設值、衍生值（stage 等）、流程表解析、PATCH 驗證
import { HttpError, clip, isValidDate } from './util.js';
import { normalizeRotations, rotationSegments, mergeSegments, rotationSegmentOf, linkScheduleSlots } from './rotation.js';

export const configKey = (id) => `events/${id}/config.json`;

export const DEFAULT_NOTICE =
  '照片只用於製作本活動回顧 MV，將於 {delete_date} 自動刪除。上傳的照片只有主辦者看得到。';

// ---------- 邀請與預覽卡（invite） ----------
// title / message 留空 = 自動產生；card_ext 為預覽圖副檔名（png|jpg，沒有卡片為 null）；
// card_auto = true 表示卡片是系統用「無照片」樣式自動產生的（基本資料改變時管理頁會自動重產）
export const defaultInvite = () => ({
  title: '', message: '', card_updated_at: null, card_ext: null, card_auto: false,
});

export function ensureInvite(cfg) {
  const d = defaultInvite();
  if (!cfg.invite || typeof cfg.invite !== 'object') cfg.invite = d;
  else for (const k of Object.keys(d)) if (cfg.invite[k] === undefined) cfg.invite[k] = d[k];
  return cfg.invite;
}

// 台灣時間（UTC+8）的 M/D；開放截止日以台灣日期顯示，避免瀏覽器送來的 UTC 時間差一天
function taipeiMD(iso) {
  const ms = Date.parse(iso);
  if (isNaN(ms)) return '';
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// 自動產生的邀請文字；空欄位省略、不留多餘符號
export function inviteAuto(cfg) {
  const b = cfg.basic || {};
  const name = b.name || '';
  const where = [dateRangeText(b), b.location || ''].filter(Boolean).join(' ');
  const until = cfg.upload && cfg.upload.closes_at ? taipeiMD(cfg.upload.closes_at) : '';
  const tail = [where, until ? `開放至 ${until}` : ''].filter(Boolean).join('・');
  const head = `邀請你上傳【${name}】拍到的照片，我們會一起做成回顧 MV。`;
  return { title: name, message: tail ? `${head}${tail}` : head };
}

// 預覽圖網址的版本參數：有卡片用卡片時間，否則用設定更新時間（換圖或改設定後 LINE 較容易重抓）
export function cardVersion(cfg) {
  const t = Date.parse((cfg.invite && cfg.invite.card_updated_at) || cfg.updated_at || cfg.created_at || '');
  return isNaN(t) ? 0 : t;
}

export function inviteEffective(cfg, origin) {
  const auto = inviteAuto(cfg);
  const inv = cfg.invite || defaultInvite();
  return {
    title: inv.title || auto.title,
    message: inv.message || auto.message,
    image_url: `${origin}/og/${cfg.upload_code}?v=${cardVersion(cfg)}`,
  };
}

// ---------- 參與者相簿（album） ----------
// enabled 預設關閉；code 為相簿連結碼（與上傳碼分開）；password_hash 只在 access='password' 時使用
export const defaultAlbum = () => ({
  enabled: false, code: null, source: 'all', access: 'link', password_hash: null,
  limit: 10, show_votes: 'after', closes_at: null, allow_download: false,
});

// 舊活動沒有相簿相關欄位時補上預設值
export function ensureAlbum(cfg) {
  const d = defaultAlbum();
  if (!cfg.album || typeof cfg.album !== 'object') cfg.album = d;
  else for (const k of Object.keys(d)) if (cfg.album[k] === undefined) cfg.album[k] = d[k];
  for (const k of ['album_picked', 'optouts', 'mv_priority', 'removed']) if (!Array.isArray(cfg[k])) cfg[k] = [];
  return cfg.album;
}

// 相簿可否投票：開啟、活動未刪除、未過票選截止
export function albumVotingOpen(cfg, now = Date.now()) {
  const a = cfg.album || {};
  if (!a.enabled || cfg.deleted_at) return false;
  const c = a.closes_at ? Date.parse(a.closes_at) : Infinity;
  return now < c;
}

// 讀到的 config 帶一個不可列舉的 _etag（不會被 JSON.stringify／展開複製帶出去），供條件寫入使用
export async function getConfig(env, id) {
  const o = await env.PHOTOS.get(configKey(id));
  if (!o) return null;
  const cfg = await o.json();
  ensureInvite(cfg); // 舊活動沒有 invite 欄位時補預設值
  if (cfg.owner === undefined) cfg.owner = null; // 舊活動沒有 owner／members（v1），視為無擁有者
  if (!Array.isArray(cfg.members)) cfg.members = [];
  ensureAlbum(cfg);
  if (!Array.isArray(cfg.rotations)) cfg.rotations = []; // v5 以前沒有輪站課程
  if (cfg.checklist_done && cfg.checklist_done.rotation === undefined) cfg.checklist_done.rotation = false;
  if (cfg.basic && cfg.basic.end_date === undefined) cfg.basic.end_date = null; // v3 以前沒有結束日期
  Object.defineProperty(cfg, '_etag', { value: o.etag, writable: true, enumerable: false });
  return cfg;
}

// 讀-改-寫用樂觀鎖：只有 R2 上的版本仍是當初讀到的那一份才寫入，否則丟 409 conflict。
// 避免並行請求把「重發的同步金鑰／更換的上傳碼／排除清單」用舊資料蓋回去。
export async function saveConfig(env, cfg) {
  cfg.updated_at = new Date().toISOString();
  const opts = { httpMetadata: { contentType: 'application/json; charset=utf-8' } };
  if (cfg._etag) opts.onlyIf = { etagMatches: cfg._etag };
  const res = await env.PHOTOS.put(configKey(cfg.id), JSON.stringify(cfg), opts);
  if (res === null) throw new HttpError(409, 'conflict', '設定剛被其他操作修改，請重新整理後再試。');
  if ('_etag' in cfg) cfg._etag = res.etag;
  else Object.defineProperty(cfg, '_etag', { value: res.etag, writable: true, enumerable: false });
}

// 套用修改並條件寫入；版本衝突時用 reload() 重新讀取（並重新驗證金鑰）後重試
export async function mutateConfig(env, cfg, reload, mutate, tries = 4) {
  for (let i = 0; ; i++) {
    await mutate(cfg);
    try {
      await saveConfig(env, cfg);
      return cfg;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 409 || i >= tries - 1) throw e;
      cfg = await reload();
    }
  }
}

export function newConfig(id, { name, date, end_date = null }, { adminHash, uploadCode, owner = null }) {
  const now = new Date().toISOString();
  return {
    id,
    version: 1,
    created_at: now,
    updated_at: now,
    basic: { name, date: date || null, end_date: date && end_date && end_date > date ? end_date : null, location: '', organizer: '' },
    schedule_text: '',
    segments: [],
    rotations: [], // 輪站課程（見 rotation.js）
    groups: [],
    shots: [],
    upload: {
      mode: 'auto',
      opens_at: null,
      closes_at: null,
      retention_days: 30,
      max_mb: 30,
      notice: DEFAULT_NOTICE,
      max_photos: 5000,
      import_enabled: true, // 允許貼 Google 相簿／雲端硬碟連結匯入
      import_daily: 1500, // 每活動每天最多匯入張數
    },
    mv: { maker: '', song: '' },
    invite: defaultInvite(),
    checklist_done: { basic: true, schedule: false, rotation: false, groups: false, shots: false, upload: false, invite: false, mv: false },
    excluded: [],
    upload_code: uploadCode,
    admin_hash: adminHash,
    sync: null,
    owner: owner ? { sub: owner.sub, email: owner.email } : null, // Google 登入的擁有者；null＝只有管理碼
    members: [],
    album: defaultAlbum(),
    album_picked: [], // source='picked' 時放進相簿的照片
    optouts: [], // 參與者回報「我不想入鏡」，待主辦者處理（處理前先從相簿隱藏）
    mv_priority: [], // 主辦者標記的 MV 優先照片（同步給 MV Studio）
    removed: [], // 上傳者自行刪除或更換掉的照片（同步時讓本地移到 _excluded）
    deleted_at: null,
  };
}

// ---------- 日期顯示 ----------
// 單日「2026/11/20」；多日「2026/11/20–11/22」（跨年時兩端都寫年份）
export function dateRangeText(b) {
  const s = b && b.date;
  if (!s) return '';
  const e = b.end_date && b.end_date > s ? b.end_date : null;
  const f = (d) => d.replace(/-/g, '/');
  if (!e) return f(s);
  return e.slice(0, 4) === s.slice(0, 4) ? `${f(s)}–${Number(e.slice(5, 7))}/${Number(e.slice(8, 10))}` : `${f(s)}–${f(e)}`;
}

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 活動最後一天：結束日期、開始日期、流程表各天日期取最晚者
export function lastDay(cfg) {
  const ds = [cfg.basic.date, cfg.basic.end_date, ...(cfg.segments || []).map((s) => s.date)].filter(Boolean);
  return ds.length ? ds.sort().pop() : null;
}

// ---------- 流程表解析（合約 §4） ----------
// 每行「09:00-10:00 環節名稱」；多日活動在每天前面放一行日期標題：
//   「11/20」「2026/11/20」「11月20日（六）」「Day 1」「第一天」「D2 戶外日」…
// 有兩天以上時，環節名稱自動加上「第N天・」，各天的同名環節互不相干。
const LINE_RE = /^(\d{1,2}):(\d{2})\s*[-–~～至到]\s*(\d{1,2}):(\d{2})\s+(.+)$/;
const EDGE_RE = /^[\s\p{P}]+|[\s\p{P}]+$/gu;
// 有年份時「2026/11/20」「2026-11-20」「2026年11月20日」；沒年份只認「11/20」「11月20日」（避免把「1.5 公里」當日期）
const DATE_HEAD_RE = /^(?:(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})|(\d{1,2})\s*\/\s*(\d{1,2})|(\d{1,2})\s*月\s*(\d{1,2}))\s*日?(?![\d:./])(.{0,30})$/;
const DAY_HEAD_RE = /^(?:day\s*(\d{1,2})|d(\d{1,2})|第\s*([一二三四五六七八九十\d]{1,3})\s*[天日])(?![\d:])(.{0,30})$/i;
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = /^(?:([一二三四五六七八九])?十)?([一二三四五六七八九])?$/.exec(s);
  if (!m) return NaN;
  return (s.includes('十') ? (m[1] ? CN_NUM[m[1]] : 1) * 10 : 0) + (m[2] ? CN_NUM[m[2]] : 0);
}

// 判斷一行是不是日期標題；是的話回 { date: 'YYYY-MM-DD'|null, n: 第幾天|null }
export function parseDayHeader(line, startDate) {
  const t = String(line || '').trim().replace(/^[#*\s【\[（(]+/, '').replace(/[】\]）)]/, ' ').trim();
  if (!t || LINE_RE.test(t)) return null;
  let m = DATE_HEAD_RE.exec(t);
  if (m) {
    const mo = Number(m[2] || m[4] || m[6]);
    const da = Number(m[3] || m[5] || m[7]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    let y = m[1] ? Number(m[1]) : startDate ? Number(startDate.slice(0, 4)) : new Date().getUTCFullYear();
    const mk = (yy) => `${yy}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    // 沒寫年份、而月份比開始日期早很多（例如 12/31 → 1/1 跨年）：算下一年
    if (!m[1] && startDate && mk(y) < addDays(startDate, -180)) y += 1;
    const date = mk(y);
    return isValidDate(date) ? { date, n: null } : null;
  }
  m = DAY_HEAD_RE.exec(t);
  if (m) {
    const n = m[1] ? Number(m[1]) : m[2] ? Number(m[2]) : cnToInt(m[3]);
    if (!Number.isInteger(n) || n < 1 || n > 60) return null;
    return { date: startDate ? addDays(startDate, n - 1) : null, n };
  }
  return null;
}

// 回傳環節陣列 [{start, end, name, title, day, date}]；單日活動 day、date 為 null、name＝title
export function parseSchedule(text, startDate = null) {
  const blocks = []; // [{ n, date, items: [] }]
  let cur = null;
  const lines = String(text || '').split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const hd = parseDayHeader(line, startDate);
    if (hd) {
      const n = hd.n || (cur && cur.items.length ? cur.n + 1 : cur ? cur.n : 1);
      const date = hd.date || (startDate ? addDays(startDate, n - 1) : null);
      if (cur && !cur.items.length) { cur.n = n; cur.date = date; } // 連續標題或標題前沒有環節：沿用同一天
      else { cur = { n, date, items: [] }; blocks.push(cur); }
      continue;
    }
    const m = LINE_RE.exec(line);
    if (!m) continue;
    if (!cur) { cur = { n: 1, date: startDate, items: [] }; blocks.push(cur); }
    const pad = (h, mi) => h.padStart(2, '0') + ':' + mi;
    const title = clip(m[5].replace(EDGE_RE, ''), 20);
    if (title) cur.items.push({ start: pad(m[1], m[2]), end: pad(m[3], m[4]), title });
  }
  const used = blocks.filter((b) => b.items.length);
  const multi = used.length >= 2;
  const segments = [];
  const seen = new Set();
  for (const b of used) {
    for (const it of b.items) {
      const name = multi ? `第${b.n}天・${it.title}` : it.title;
      if (seen.has(name)) continue;
      seen.add(name);
      segments.push({ start: it.start, end: it.end, name, title: it.title, day: multi ? b.n : null, date: multi ? b.date : null });
    }
  }
  return segments;
}

// 依環節同步 auto 拍攝清單：補缺的、刪除已消失環節的 auto 項目
export function syncAutoShots(shots, segments) {
  const names = new Set(segments.filter((s) => !s.rotation_slot).map((s) => s.name));
  const out = shots.filter((s) => s.source !== 'auto' || names.has(s.segment));
  for (const seg of segments) {
    if (seg.rotation_slot) continue; // 被當成輪站時段的流程表環節：拍攝清單改由各關卡負責
    if (!out.some((s) => s.segment === seg.name)) {
      out.push({ segment: seg.name, target: seg.kind === 'free' ? 3 : 8, tip: '', source: 'auto' });
    }
  }
  return out;
}

// 流程表＋輪站課程 → cfg.segments，並同步自動拍攝清單
export function rebuildSegments(cfg) {
  const sched = linkScheduleSlots(cfg, parseSchedule(cfg.schedule_text, cfg.basic.date));
  cfg.segments = mergeSegments(sched, rotationSegments(cfg));
  cfg.shots = syncAutoShots(cfg.shots, cfg.segments);
}

// ---------- 環節判斷 ----------
// cfg 有輪站課程時：拍攝時間在輪站時段內 → 依小隊查輪站表；判斷不了才退回一般時段（例如流程表的「輪站課程」整段）
export function segmentOf(photo, segments, cfg = null) {
  if (photo.segment && photo.segment !== 'auto' && segments.some((s) => s.name === photo.segment)) {
    return photo.segment;
  }
  if (cfg && cfg.rotations && cfg.rotations.length) {
    const r = rotationSegmentOf(photo, cfg);
    if (r && r.name) return r.name;
    if (r && r.bye) return null; // 輪空、且設定為不歸類
  }
  const t = photo.exif_time && photo.exif_time.length >= 16 ? photo.exif_time.slice(11, 16) : '';
  if (!/^\d{2}:\d{2}$/.test(t)) return null;
  const hits = segments.filter((s) => !s.kind && s.start <= t && t < s.end);
  if (!hits.length) return null;
  // 多日活動：流程表有日期時，拍攝日期也要對上；沒有日期又有多天同時段 → 無法判斷，交給上傳者自己選
  const day = photo.exif_time.slice(0, 10);
  if (hits.some((s) => s.date)) {
    const same = hits.find((s) => s.date === day);
    return same ? same.name : null;
  }
  if (new Set(hits.map((s) => s.day)).size > 1) return null;
  return hits[0].name;
}

// ---------- 時間與衍生值 ----------
const TZ_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

// 取時間字串「自己時區」的本地日期（YYYY-MM-DD），可加天數
function localDatePlus(iso, days) {
  const ms = Date.parse(iso);
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  const off = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(ms + off * 60000 + days * 86400000).toISOString().slice(0, 10);
}

export function deleteAt(cfg) {
  const c = cfg.upload.closes_at;
  if (!c || isNaN(Date.parse(c))) return null;
  return new Date(Date.parse(c) + cfg.upload.retention_days * 86400000).toISOString();
}

export function deleteDateText(cfg) {
  const c = cfg.upload.closes_at;
  if (!c || isNaN(Date.parse(c))) return '活動結束後一段時間';
  return localDatePlus(c, cfg.upload.retention_days);
}

export function isOpenNow(cfg, now = Date.now()) {
  if (cfg.deleted_at) return false;
  const u = cfg.upload;
  if (u.mode === 'closed') return false;
  if (u.mode === 'open') return true;
  if (!u.opens_at) return false;
  const o = Date.parse(u.opens_at);
  if (isNaN(o) || o > now) return false;
  const c = u.closes_at ? Date.parse(u.closes_at) : Infinity;
  return now < c;
}

export function derive(cfg, now = Date.now()) {
  const u = cfg.upload;
  const is_open = isOpenNow(cfg, now);
  let stage;
  if (cfg.deleted_at) stage = 'purged';
  else if (u.mode === 'closed') stage = 'closed';
  else if (is_open) {
    const today = new Date(now).toISOString().slice(0, 10);
    const last = lastDay(cfg);
    stage = last && today > last ? 'grace' : 'open';
  } else if (u.closes_at && now >= Date.parse(u.closes_at)) stage = 'closed';
  else stage = 'planning';
  const must_missing = [];
  if (!(u.opens_at && u.notice)) must_missing.push('upload');
  return { stage, is_open, delete_at: deleteAt(cfg), must_missing };
}

export function renderNotice(cfg) {
  return String(cfg.upload.notice || '').replaceAll('{delete_date}', deleteDateText(cfg));
}

// 回傳給管理端的 config（去掉 admin_hash 與 sync.hash）
export function publicConfig(cfg) {
  const { admin_hash, ...rest } = cfg;
  if (rest.sync) {
    const { hash, ...s } = rest.sync;
    rest.sync = s;
  }
  if (rest.album) {
    const { password_hash, ...a } = rest.album;
    rest.album = { ...a, has_password: !!password_hash };
  }
  return rest;
}

// ---------- PATCH 驗證 ----------
const bad = (msg) => new HttpError(400, 'invalid', msg);
const isStr = (v) => typeof v === 'string';
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

function checkTime(v, field) {
  if (v === null) return null;
  if (!isStr(v) || !TZ_ISO_RE.test(v) || isNaN(Date.parse(v))) throw bad(`${field} 必須是帶時區的 ISO 時間或 null。`);
  return v;
}

// 就地把 body 的合法欄位套用到 cfg；不合法拋 400
export function applyPatch(cfg, body, opts = {}) {
  if (body.basic !== undefined) {
    const b = body.basic;
    if (!b || typeof b !== 'object') throw bad('basic 格式錯誤。');
    if (b.name !== undefined) {
      if (!isStr(b.name) || !b.name.trim() || Array.from(b.name.trim()).length > 60) throw bad('活動名稱需 1–60 字。');
      cfg.basic.name = b.name.trim();
    }
    if (b.date !== undefined) {
      if (b.date !== null && b.date !== '' && !isValidDate(b.date)) throw bad('日期格式需為 YYYY-MM-DD。');
      cfg.basic.date = b.date || null;
    }
    if (b.end_date !== undefined) {
      if (b.end_date !== null && b.end_date !== '' && !isValidDate(b.end_date)) throw bad('結束日期格式需為 YYYY-MM-DD。');
      cfg.basic.end_date = b.end_date || null;
    }
    if (cfg.basic.end_date) {
      if (!cfg.basic.date) throw bad('請先填開始日期。');
      if (cfg.basic.end_date < cfg.basic.date) throw bad('結束日期不能早於開始日期。');
      if (cfg.basic.end_date === cfg.basic.date) cfg.basic.end_date = null; // 同一天＝單日活動
      else if (cfg.basic.end_date > addDays(cfg.basic.date, 60)) throw bad('活動最長 60 天。');
    }
    // 改了開始日期：重新解析流程表，讓「Day 2」這類標題換算出新日期（統一在最後 rebuildSegments）
    if (b.location !== undefined) {
      if (!isStr(b.location)) throw bad('location 格式錯誤。');
      cfg.basic.location = clip(b.location.trim(), 100);
    }
    if (b.organizer !== undefined) {
      if (!isStr(b.organizer)) throw bad('organizer 格式錯誤。');
      cfg.basic.organizer = clip(b.organizer.trim(), 60);
    }
  }

  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups)) throw bad('groups 需為陣列。');
    const out = [];
    for (const g of body.groups) {
      if (!isStr(g)) throw bad('groups 內容需為字串。');
      const t = clip(g.trim(), 20);
      if (t && !out.includes(t)) out.push(t);
    }
    cfg.groups = out.slice(0, 30);
  }

  if (body.shots !== undefined) {
    if (!Array.isArray(body.shots) || body.shots.length > 100) throw bad('shots 需為陣列（最多 100 項）。');
    cfg.shots = body.shots.map((s) => {
      if (!s || !isStr(s.segment) || !s.segment.trim()) throw bad('shots 每項需有 segment。');
      const target = s.target === undefined ? 8 : s.target;
      if (!isInt(target) || target < 0 || target > 9999) throw bad('shots.target 需為 0–9999 的整數。');
      const source = ['auto', 'manual', 'mv'].includes(s.source) ? s.source : 'manual';
      return { segment: clip(s.segment.trim(), 20), target, tip: clip(isStr(s.tip) ? s.tip.trim() : '', 100), source };
    });
  }

  // 流程表：重新解析環節並同步 auto 拍攝清單
  if (body.schedule_text !== undefined) {
    if (!isStr(body.schedule_text) || body.schedule_text.length > 5000) throw bad('schedule_text 需為 5000 字內的字串。');
    cfg.schedule_text = body.schedule_text;
  }

  if (body.rotations !== undefined) cfg.rotations = normalizeRotations(body.rotations, cfg);

  // 會影響環節的欄位：流程表、輪站課程、小隊（輪空列）、開始日期
  if (body.schedule_text !== undefined || body.rotations !== undefined || body.groups !== undefined || (body.basic && body.basic.date !== undefined)) {
    rebuildSegments(cfg);
  }

  if (body.upload !== undefined) {
    const u = body.upload;
    if (!u || typeof u !== 'object') throw bad('upload 格式錯誤。');
    if (u.mode !== undefined) {
      if (!['auto', 'open', 'closed'].includes(u.mode)) throw bad('mode 只能是 auto / open / closed。');
      cfg.upload.mode = u.mode;
    }
    if (u.opens_at !== undefined) cfg.upload.opens_at = checkTime(u.opens_at, 'opens_at');
    if (u.closes_at !== undefined) cfg.upload.closes_at = checkTime(u.closes_at, 'closes_at');
    if (u.retention_days !== undefined) {
      if (!isInt(u.retention_days) || u.retention_days < 7 || u.retention_days > 180) throw bad('retention_days 需為 7–180。');
      cfg.upload.retention_days = u.retention_days;
    }
    if (u.max_mb !== undefined) {
      if (!isInt(u.max_mb) || u.max_mb < 5 || u.max_mb > 50) throw bad('max_mb 需為 5–50。');
      cfg.upload.max_mb = u.max_mb;
    }
    if (u.notice !== undefined) {
      if (!isStr(u.notice) || Array.from(u.notice).length > 300) throw bad('notice 需為 300 字內的字串。');
      cfg.upload.notice = u.notice;
    }
    if (u.max_photos !== undefined) {
      if (!isInt(u.max_photos) || u.max_photos < 1 || u.max_photos > 20000) throw bad('max_photos 需為 1–20000。');
      cfg.upload.max_photos = u.max_photos;
    }
    if (u.import_enabled !== undefined) {
      if (typeof u.import_enabled !== 'boolean') throw bad('import_enabled 需為 true / false。');
      cfg.upload.import_enabled = u.import_enabled;
    }
    if (u.import_daily !== undefined) {
      if (!isInt(u.import_daily) || u.import_daily < 0 || u.import_daily > 5000) throw bad('import_daily 需為 0–5000。');
      cfg.upload.import_daily = u.import_daily;
    }
  }

  if (body.mv !== undefined) {
    const m = body.mv;
    if (!m || typeof m !== 'object') throw bad('mv 格式錯誤。');
    if (m.maker !== undefined) {
      if (!isStr(m.maker)) throw bad('mv.maker 格式錯誤。');
      cfg.mv.maker = clip(m.maker.trim(), 100);
    }
    if (m.song !== undefined) {
      if (!isStr(m.song)) throw bad('mv.song 格式錯誤。');
      cfg.mv.song = clip(m.song.trim(), 100);
    }
  }

  if (body.invite !== undefined) {
    const v = body.invite;
    if (!v || typeof v !== 'object') throw bad('invite 格式錯誤。');
    const inv = ensureInvite(cfg);
    // 控制字元（含換行）換成空白再修剪；留空 = 回到自動產生
    const clean = (x) => x.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
    if (v.title !== undefined) {
      if (!isStr(v.title)) throw bad('invite.title 格式錯誤。');
      const t = clean(v.title);
      if (Array.from(t).length > 40) throw bad('預覽標題最多 40 字。');
      inv.title = t;
    }
    if (v.message !== undefined) {
      if (!isStr(v.message)) throw bad('invite.message 格式錯誤。');
      const t = clean(v.message);
      if (Array.from(t).length > 120) throw bad('邀請文字最多 120 字。');
      inv.message = t;
    }
    if (v.card_auto !== undefined) {
      if (typeof v.card_auto !== 'boolean') throw bad('invite.card_auto 需為布林。');
      inv.card_auto = v.card_auto;
    }
  }

  if (body.album !== undefined) applyAlbumPatch(cfg, body.album, opts.albumPwHash);

  if (body.checklist_done !== undefined) {
    const c = body.checklist_done;
    if (!c || typeof c !== 'object') throw bad('checklist_done 格式錯誤。');
    for (const k of Object.keys(cfg.checklist_done)) {
      if (c[k] !== undefined) {
        if (typeof c[k] !== 'boolean') throw bad('checklist_done 的值需為布林。');
        cfg.checklist_done[k] = c[k];
      }
    }
  }
}

// 相簿設定 PATCH；password 為明碼（4–32 字），存 SHA-256(活動編號:密碼)；傳 null 清除
export async function hashAlbumPassword(id, pw) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${id}:${pw}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function applyAlbumPatch(cfg, a, pwHash) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad('album 格式錯誤。');
  const al = ensureAlbum(cfg);
  if (a.enabled !== undefined) {
    if (typeof a.enabled !== 'boolean') throw bad('album.enabled 需為布林。');
    al.enabled = a.enabled;
  }
  if (a.source !== undefined) {
    if (!['all', 'picked'].includes(a.source)) throw bad('album.source 只能是 all / picked。');
    al.source = a.source;
  }
  if (a.access !== undefined) {
    if (!['link', 'google', 'password'].includes(a.access)) throw bad('album.access 只能是 link / google / password。');
    al.access = a.access;
  }
  if (a.limit !== undefined) {
    if (!isInt(a.limit) || a.limit < 1 || a.limit > 50) throw bad('album.limit 需為 1–50。');
    al.limit = a.limit;
  }
  if (a.show_votes !== undefined) {
    if (!['live', 'after', 'never'].includes(a.show_votes)) throw bad('album.show_votes 只能是 live / after / never。');
    al.show_votes = a.show_votes;
  }
  if (a.closes_at !== undefined) al.closes_at = checkTime(a.closes_at, 'album.closes_at');
  if (a.allow_download !== undefined) {
    if (typeof a.allow_download !== 'boolean') throw bad('album.allow_download 需為布林。');
    al.allow_download = a.allow_download;
  }
  if (a.password !== undefined) {
    if (a.password === null) al.password_hash = null;
    else if (!isStr(a.password) || Array.from(a.password).length < 4 || Array.from(a.password).length > 32) throw bad('相簿密碼需 4–32 字。');
    else if (typeof pwHash === 'string') al.password_hash = pwHash; // 呼叫端（admin.patch）先算好雜湊
    else throw bad('相簿密碼處理失敗。');
  }
  if (al.access === 'password' && !al.password_hash) throw bad('選擇「需輸入相簿密碼」時請設定密碼。');
}
