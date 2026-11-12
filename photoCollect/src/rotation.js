// 輪站課程：同一時段多個關卡同時上課，各小隊依輪站表換關卡（可輪空）
// 設定存在 cfg.rotations：
//   [{ id, title, day: 第N天|null, slots: [{start,end}], stations: [{name, place}],
//      rows: [{ group, cells: [關卡索引 | -1(輪空)] }], bye_mode: 'free' | 'skip' }]
// 每個關卡（以及有輪空、bye_mode=free 時的「自由活動」）會展開成 cfg.segments 裡的環節（kind: 'station' | 'free'），
// 讓上傳頁、拍攝清單、MV 主題、同步都能沿用既有的環節機制。
import { HttpError, clip } from './util.js';

const bad = (msg) => new HttpError(400, 'invalid', msg);
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const FREE_NAME = '自由活動';
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const cleanName = (v, n) => clip(String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim(), n);

// 驗證並正規化 PATCH 的 rotations；groups 只接受活動設定中存在的小隊
export function normalizeRotations(list, cfg) {
  if (!Array.isArray(list) || list.length > 6) throw bad('rotations 需為陣列（最多 6 個輪站區塊）。');
  const allowed = new Set(cfg.groups || []);
  const ids = new Set();
  return list.map((r, ri) => {
    if (!r || typeof r !== 'object') throw bad('輪站區塊格式錯誤。');
    let id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(r.id) ? r.id : `r${ri + 1}`;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    const title = cleanName(r.title, 20) || '輪站課程';
    let day = null;
    if (r.day !== undefined && r.day !== null) {
      if (!Number.isInteger(r.day) || r.day < 1 || r.day > 60) throw bad('輪站區塊的 day 需為 1–60。');
      day = r.day;
    }
    if (!Array.isArray(r.slots) || r.slots.length < 1 || r.slots.length > 12) throw bad(`「${title}」需要 1–12 個時段。`);
    const slots = r.slots.map((s) => {
      if (!s || !HM_RE.test(s.start) || !HM_RE.test(s.end) || s.start >= s.end) throw bad(`「${title}」的時段需為 HH:MM，且開始早於結束。`);
      // seg：這一段取自流程表的哪個環節（流程表改時間時，輪站時段跟著改）
      const seg = typeof s.seg === 'string' ? cleanName(s.seg, 30) : '';
      // day：這一段在第幾天（跨日輪站每段可在不同天；沒填沿用區塊的 day）
      let sday = day;
      if (s.day !== undefined && s.day !== null) {
        if (!Number.isInteger(s.day) || s.day < 1 || s.day > 60) throw bad(`「${title}」時段的 day 需為 1–60。`);
        sday = s.day;
      }
      const o = { start: s.start, end: s.end };
      if (sday) o.day = sday;
      if (seg) o.seg = seg;
      return o;
    });
    for (let i = 1; i < slots.length; i++) {
      const a = slots[i - 1], b = slots[i];
      if ((b.day || 0) < (a.day || 0) || ((b.day || 0) === (a.day || 0) && b.start < a.end)) throw bad(`「${title}」的時段需依日期、時間排列且不重疊。`);
    }
    // 所有時段都在同一天 → 區塊的 day 就是那天；跨日 → 區塊 day 為 null
    const days = new Set(slots.map((x) => x.day || 0));
    day = days.size === 1 ? (slots[0].day || null) : null;
    if (!Array.isArray(r.stations) || r.stations.length < 1 || r.stations.length > 12) throw bad(`「${title}」需要 1–12 個關卡。`);
    const names = new Set();
    const stations = r.stations.map((s) => {
      const name = cleanName(s && s.name, 20);
      if (!name) throw bad(`「${title}」的關卡名稱不能空白。`);
      if (name === FREE_NAME) throw bad(`關卡名稱不能叫「${FREE_NAME}」。`);
      if (names.has(name)) throw bad(`「${title}」有重複的關卡名稱「${name}」。`);
      names.add(name);
      return { name, place: cleanName(s.place, 20) };
    });
    if (!Array.isArray(r.rows) || r.rows.length > 30) throw bad(`「${title}」的輪站表格式錯誤。`);
    const seen = new Set();
    const rows = [];
    for (const row of r.rows) {
      if (!row || typeof row.group !== 'string' || !allowed.has(row.group) || seen.has(row.group)) continue; // 不存在或重複的小隊略過
      seen.add(row.group);
      if (!Array.isArray(row.cells) || row.cells.length !== slots.length) throw bad(`「${title}」的「${row.group}」需要 ${slots.length} 格。`);
      const cells = row.cells.map((c) => {
        if (!Number.isInteger(c) || c < -1 || c >= stations.length) throw bad(`「${title}」的輪站表有不存在的關卡。`);
        return c;
      });
      rows.push({ group: row.group, cells });
    }
    const bye_mode = r.bye_mode === 'skip' ? 'skip' : 'free';
    return { id, title, day, slots, stations, rows, bye_mode };
  });
}

// 小隊改名或刪除時：輪站表裡已不存在的小隊列略過（保留資料，改回來會恢復）
const liveRows = (rot, cfg) => {
  const g = new Set(cfg.groups || []);
  return rot.rows.filter((r) => g.has(r.group));
};

const slotDay = (rot, sl) => sl.day || rot.day || null;
function slotDate(rot, sl, cfg) {
  const d = slotDay(rot, sl);
  return d && cfg.basic.date ? addDays(cfg.basic.date, d - 1) : null;
}
// 區塊的天數：同一天的輪站在多日活動中名稱加「第N天・」；跨日輪站各關卡跨天共用，不加
export const rotDays = (rot) => [...new Set(rot.slots.map((sl) => slotDay(rot, sl)).filter(Boolean))].sort((a, b) => a - b);
const singleDay = (rot) => { const ds = rotDays(rot); return ds.length === 1 && rot.slots.every((sl) => slotDay(rot, sl)) ? ds[0] : null; };
function rotDate(rot, cfg) {
  const d = singleDay(rot);
  return d && cfg.basic.date ? addDays(cfg.basic.date, d - 1) : null;
}
const prefix = (rot) => { const d = singleDay(rot); return d ? `第${d}天・` : ''; };
export const stationSegName = (rot, i) => `${prefix(rot)}${rot.stations[i].name}`;
export const freeSegName = (rot) => `${prefix(rot)}${FREE_NAME}`;

// 時段取自流程表的輪站：依最新流程表更新時間；並標記被當成輪站時段的流程表環節（rotation_slot）
// 這些環節保留下來當作「判斷不了是哪一關」的收容環節，但不另產生拍攝清單、上傳頁不單獨列出
export function linkScheduleSlots(cfg, scheduleSegs) {
  const used = new Map();
  for (const rot of cfg.rotations || []) {
    for (const sl of rot.slots) {
      if (!sl.seg) continue;
      const d = slotDay(rot, sl);
      const s = scheduleSegs.find((x) => x.name === sl.seg && (!d || !x.day || x.day === d));
      if (!s) continue; // 流程表已刪除這個環節：沿用上次的時間
      if (s.start < s.end) { sl.start = s.start; sl.end = s.end; }
      used.set(s.name, rot.id);
    }
  }
  return scheduleSegs.map((s) => (used.has(s.name) ? { ...s, rotation_slot: used.get(s.name) } : s));
}

// 由輪站設定展開成環節；hasBye 時才產生「自由活動」
export function rotationSegments(cfg) {
  const out = [];
  for (const rot of cfg.rotations || []) {
    const date = rotDate(rot, cfg);
    const day = singleDay(rot);
    const start = rot.slots.map((x) => x.start).sort()[0];
    const end = rot.slots.map((x) => x.end).sort().pop();
    const days = rotDays(rot);
    rot.stations.forEach((s, i) => {
      out.push({ start, end, name: stationSegName(rot, i), title: s.name, day, date, days, kind: 'station', rotation: rot.id, place: s.place });
    });
    const hasBye = liveRows(rot, cfg).some((r) => r.cells.includes(-1));
    if (hasBye && rot.bye_mode === 'free') {
      out.push({ start, end, name: freeSegName(rot), title: FREE_NAME, day, date, days, kind: 'free', rotation: rot.id, place: '' });
    }
  }
  return out;
}

// 合併流程表環節與輪站環節（名稱相同只留第一個），依日期、開始時間排序
export function mergeSegments(scheduleSegs, rotSegs) {
  const seen = new Set();
  const all = [];
  for (const s of [...scheduleSegs, ...rotSegs]) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    all.push(s);
  }
  return all.map((s, i) => [s, i])
    .sort(([a, ia], [b, ib]) => (a.date || '').localeCompare(b.date || '') || (a.day || 0) - (b.day || 0) || a.start.localeCompare(b.start) || ia - ib)
    .map(([s]) => s);
}

// 拍攝時間落在哪個輪站區塊的第幾段：每段涵蓋「本段開始～下一段開始」（換站時間算前一段），最後一段到結束
export function slotAt(cfg, exifTime) {
  if (!exifTime || exifTime.length < 16) return null;
  const t = toMin(exifTime.slice(11, 16));
  const day = exifTime.slice(0, 10);
  for (const rot of cfg.rotations || []) {
    const s = rot.slots;
    for (let i = s.length - 1; i >= 0; i--) {
      const date = slotDate(rot, s[i], cfg);
      if (date && date !== day) continue;
      // 同一天的下一段開始前都算這一段（換站時間）；當天最後一段到它的結束時間
      const next = s[i + 1] && slotDay(rot, s[i + 1]) === slotDay(rot, s[i]) ? s[i + 1] : null;
      const until = next ? toMin(next.start) : toMin(s[i].end);
      if (t >= toMin(s[i].start) && t < until) return { rot, slot: i };
    }
  }
  return null;
}

// 依小隊＋時段判斷關卡。回傳 { name } 或 null（判斷不了）；skip 模式的輪空回 { name: null, bye: true }
export function rotationSegmentOf(photo, cfg) {
  const hit = slotAt(cfg, photo.exif_time);
  if (!hit) return undefined; // 不在輪站時段
  const { rot, slot } = hit;
  const rows = liveRows(rot, cfg);
  const results = new Set();
  for (const g of photo.groups || []) {
    const row = rows.find((r) => r.group === g);
    if (row) results.add(row.cells[slot]);
  }
  if (results.size !== 1) return null; // 沒勾小隊、或勾了多隊而且各在不同關卡
  const c = [...results][0];
  if (c === -1) return rot.bye_mode === 'free' ? { name: freeSegName(rot), bye: true } : { name: null, bye: true };
  return { name: stationSegName(rot, c) };
}

// 固定在某一關的攝影師：選了關卡、沒勾小隊 → 依時段反推是哪一隊
export function inferGroups(segment, exifTime, cfg) {
  const hit = slotAt(cfg, exifTime);
  if (!hit) return [];
  const { rot, slot } = hit;
  const idx = rot.stations.findIndex((_, i) => stationSegName(rot, i) === segment);
  if (idx < 0) return [];
  return liveRows(rot, cfg).filter((r) => r.cells[slot] === idx).map((r) => r.group);
}

// 管理頁「每隊在每一關的照片」：counts[g][s]、free[g]、pending（輪站時段內判斷不了的照片）
export function rotationStats(cfg, photos, segOf) {
  return (cfg.rotations || []).map((rot) => {
    const rows = liveRows(rot, cfg);
    const groups = rows.map((r) => r.group);
    const counts = groups.map(() => rot.stations.map(() => 0));
    const free = groups.map(() => 0);
    let pending = 0;
    let unknownGroup = 0;
    const stationIdx = new Map(rot.stations.map((_, i) => [stationSegName(rot, i), i]));
    for (const p of photos) {
      const hit = slotAt(cfg, p.exif_time);
      const seg = segOf(p);
      const si = stationIdx.has(seg) ? stationIdx.get(seg) : -2;
      const inRot = hit && hit.rot.id === rot.id;
      if (si === -2 && seg !== freeSegName(rot)) {
        if (inRot) pending++;
        continue;
      }
      let gs = (p.groups || []).filter((g) => groups.includes(g));
      if (!gs.length && si >= 0) gs = inferGroups(seg, p.exif_time, cfg);
      if (!gs.length) { unknownGroup++; continue; }
      for (const g of gs) {
        const gi = groups.indexOf(g);
        if (si >= 0) counts[gi][si]++;
        else free[gi]++;
      }
    }
    return {
      id: rot.id, title: rot.title, day: singleDay(rot), date: rotDate(rot, cfg), days: rotDays(rot),
      slots: rot.slots.map((sl) => ({ ...sl, day: slotDay(rot, sl), date: slotDate(rot, sl, cfg) })), stations: rot.stations, groups, rows: rows.map((r) => r.cells),
      counts, free, pending, unknown_group: unknownGroup, bye_mode: rot.bye_mode,
    };
  });
}

// 給上傳頁、我上傳的照片的精簡版（含日期）
export function rotationsPublic(cfg) {
  return (cfg.rotations || []).map((rot) => ({
    id: rot.id, title: rot.title, day: singleDay(rot), date: rotDate(rot, cfg), days: rotDays(rot),
    slots: rot.slots.map((sl) => ({ ...sl, day: slotDay(rot, sl), date: slotDate(rot, sl, cfg) })),
    stations: rot.stations.map((s, i) => ({ name: s.name, place: s.place, segment: stationSegName(rot, i) })),
    rows: liveRows(rot, cfg), bye_mode: rot.bye_mode,
    free_segment: rot.bye_mode === 'free' && liveRows(rot, cfg).some((r) => r.cells.includes(-1)) ? freeSegName(rot) : null,
  }));
}
