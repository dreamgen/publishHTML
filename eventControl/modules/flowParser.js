/**
 * 流程表解析（純函式，無 DOM 依賴，可用 node 測試）
 *
 * 支援輸入：
 *  - JSON（本工具範本、AI 產生的 JSON、或單純陣列；可包在 ```json 區塊內）
 *  - 表格列（Excel / CSV / 從試算表複製貼上的 Tab 分隔文字）
 *  - 自由文字（每行一個單元，自動抓起迄時間、分鐘數、負責人、回合數）
 *
 * 統一輸出：{ title, startTime: 'HH:MM' | '', startDate: 'YYYY-MM-DD' | ''（空白＝當天）, items: [{id,title,subtitle,owner,duration,rounds}], warnings: [] }
 */

const DUR_RE = /(\d+(?:\.\d+)?)\s*(?:分鐘|分|mins?\b|minutes?\b|m\b|['’′])/i;
const RANGE_RE = /(\d{1,2})[:：](\d{2})\s*(?:[-~～–—至到]|to)\s*(\d{1,2})[:：](\d{2})/i;
const TIME_RE = /(?<![\d:])(\d{1,2})[:：](\d{2})(?![\d])/;
const OWNER_RE = /(?:負責人?|主持人?|講師|帶領人?|主講人?|owner)\s*[:：]\s*([^|｜\t()（）]+)/i;
const ROUNDS_RE = /(\d+)\s*(?:回合|輪|rounds?\b)/i;
const NUMBERING_RE = /^\s*(?:[(（]?\d{1,2}[.)）、．]|[一二三四五六七八九十]+[、.．]|[-*•●▪・◆■□○]|第[一二三四五六七八九十\d]+[節段部分]?[:：、\s])\s*/;

export const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const toMin = (h, m) => Number(h) * 60 + Number(m);

let idSeq = 0;
export const newId = () => 'u' + Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 5);

function normTime(v) {
  if (v == null) return '';
  const m = String(v).match(TIME_RE);
  return m && +m[1] < 24 ? hm(+m[1], +m[2]) : '';
}

function numOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const d = s.match(DUR_RE);
  if (d) return parseFloat(d[1]);
  const n = s.match(/^(\d+(?:\.\d+)?)$/);
  return n ? parseFloat(n[1]) : null;
}

function makeItem({ title = '', subtitle = '', owner = '', duration = null, rounds = 1, startMin = null }) {
  let t = String(title || '').trim();
  let r = parseInt(rounds, 10) || 1;
  if (r <= 1) {
    const rm = t.match(ROUNDS_RE);
    if (rm && +rm[1] > 1 && +rm[1] <= 20) r = +rm[1];
  }
  return {
    id: newId(),
    title: t,
    subtitle: String(subtitle || '').trim(),
    owner: String(owner || '').trim().replace(/\s*[,，/／&＆]\s*/g, '、'),
    duration: duration == null || isNaN(duration) ? null : Number(duration),
    rounds: Math.min(20, Math.max(1, r)),
    _start: startMin,
  };
}

/** 補齊缺漏分鐘數、整理輸出 */
export function normDate(v) {
  if (v == null || v === '') return '';
  const m = String(v).match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function finalize(items, { title = '', startTime = '', startDate = '' } = {}, warnings = []) {
  items = items.filter((it) => it.title || it.duration);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.duration == null && it._start != null && items[i + 1] && items[i + 1]._start != null) {
      let d = items[i + 1]._start - it._start;
      if (d < 0) d += 1440;
      if (d > 0) it.duration = d;
    }
    if (it.duration == null || !(it.duration > 0)) {
      warnings.push(`「${it.title || '第 ' + (i + 1) + ' 項'}」沒有分鐘數，先設為 5 分鐘`);
      it.duration = 5;
    }
    it.duration = Math.max(1, Math.round(it.duration));
    if (!it.title) it.title = `單元 ${i + 1}`;
  }
  if (!startTime) {
    const first = items.find((it) => it._start != null);
    if (first && items.indexOf(first) === 0) startTime = hm(Math.floor(first._start / 60) % 24, first._start % 60);
  }
  return {
    title: String(title || '').trim(),
    startTime: normTime(startTime),
    startDate: normDate(startDate),
    items: items.map(({ _start, ...rest }) => rest),
    warnings,
  };
}

// ───────────────────────── JSON ─────────────────────────
const pick = (o, keys) => {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
};

export function normalizeFlowJSON(obj) {
  const warnings = [];
  const list = Array.isArray(obj)
    ? obj
    : pick(obj, ['items', 'flow', 'schedule', 'units', 'agenda', '流程', '單元']) || [];
  if (!Array.isArray(list)) throw new Error('JSON 裡找不到 items 陣列');
  const items = list.map((it) => {
    if (typeof it === 'string') return parseLine(it);
    let owner = pick(it, ['owner', 'owners', 'host', 'speaker', '負責人', '負責', '主持人']);
    if (Array.isArray(owner)) owner = owner.join('、');
    let duration = numOf(pick(it, ['duration', 'minutes', 'mins', 'min', '分鐘', '時長', '分鐘數']));
    const st = normTime(pick(it, ['start', 'startTime', '開始', '開始時間']));
    const et = normTime(pick(it, ['end', 'endTime', '結束', '結束時間']));
    const range = String(pick(it, ['time', '時間', '時段']) || '').match(RANGE_RE);
    let startMin = null;
    if (range) {
      startMin = toMin(range[1], range[2]);
      if (duration == null) duration = (toMin(range[3], range[4]) - startMin + 1440) % 1440;
    } else if (st) {
      startMin = toMin(...st.split(':'));
      if (duration == null && et) duration = (toMin(...et.split(':')) - startMin + 1440) % 1440;
    }
    return makeItem({
      title: pick(it, ['title', 'name', 'unit', 'item', '單元', '項目', '名稱', '內容']),
      subtitle: pick(it, ['subtitle', 'note', 'notes', 'description', 'desc', '說明', '備註']),
      owner,
      duration,
      rounds: pick(it, ['rounds', 'roundsCount', '回合', '回合數']),
      startMin,
    });
  });
  return finalize(
    items,
    {
      title: Array.isArray(obj) ? '' : pick(obj, ['title', 'name', 'event', '活動名稱', '活動']),
      startTime: Array.isArray(obj) ? '' : pick(obj, ['startTime', 'start', '開始時間']),
      startDate: Array.isArray(obj) ? '' : pick(obj, ['startDate', 'date', '日期', '活動日期']),
    },
    warnings
  );
}

// ───────────────────────── 自由文字 ─────────────────────────
function looksLikeNames(s) {
  return s.length <= 16 && /^[\p{L}·．.]+(?:\s*[、,，/／&＆]\s*[\p{L}·．.]+)*$/u.test(s) && !/\d/.test(s);
}

export function parseLine(line) {
  let s = String(line).trim();
  let duration = null;
  let startMin = null;
  let owner = '';
  let subtitle = '';

  const range = s.match(RANGE_RE);
  if (range) {
    startMin = toMin(range[1], range[2]);
    duration = (toMin(range[3], range[4]) - startMin + 1440) % 1440;
    s = s.replace(range[0], ' ');
  } else {
    const t = s.match(/^\s*(\d{1,2})[:：](\d{2})(?!\d)/);
    if (t) {
      startMin = toMin(t[1], t[2]);
      s = s.replace(t[0], ' ');
    }
  }
  const d = s.match(DUR_RE);
  if (d) {
    if (duration == null) duration = parseFloat(d[1]);
    s = s.replace(d[0], ' ');
  }
  const o = s.match(OWNER_RE);
  if (o) {
    owner = o[1].trim();
    s = s.replace(o[0], ' ');
  }
  s = s.replace(NUMBERING_RE, '');

  // 以 | ｜ Tab 或 2 個以上空白切段，找出負責人欄
  let segs = s.split(/\s*[|｜\t]\s*|\s{2,}/).map((x) => x.trim()).filter(Boolean);
  segs = segs.map((x) => x.replace(/^[(（]\s*[)）]$/, '')).filter(Boolean);
  if (!owner && segs.length > 1) {
    const idx = segs.findIndex((x, i) => i > 0 && looksLikeNames(x));
    if (idx > 0) owner = segs.splice(idx, 1)[0];
  }
  s = segs.join(' ');
  // 結尾以單一空白接著「甲、乙」這種多人名單 → 視為負責人
  if (!owner) {
    const tail = s.match(/\s([\p{L}·．.]{1,6}(?:\s*[、,，/／&＆]\s*[\p{L}·．.]{1,6})+)\s*$/u);
    if (tail && looksLikeNames(tail[1]) && s.slice(0, tail.index).trim()) {
      owner = tail[1];
      s = s.slice(0, tail.index);
    }
  }

  // 括號內容當補充說明
  const subs = [];
  s = s.replace(/[(（]([^()（）]*)[)）]/g, (_, inner) => {
    if (inner.trim()) subs.push(inner.trim());
    return ' ';
  });
  subtitle = subs.join('；');
  const title = s.replace(/\s+/g, ' ').replace(/^[\s\-–—:：|｜、,，]+|[\s\-–—:：|｜、,，]+$/g, '');
  return makeItem({ title, subtitle, owner, duration, startMin });
}

function parseLines(lines) {
  let title = '';
  const items = [];
  lines.forEach((ln, i) => {
    const hasTiming = RANGE_RE.test(ln) || DUR_RE.test(ln) || /^\s*\d{1,2}[:：]\d{2}/.test(ln);
    if (i === 0 && !hasTiming && lines.length > 1 && lines.slice(1).some((l) => RANGE_RE.test(l) || DUR_RE.test(l))) {
      title = ln.trim().replace(/^[#\s]+/, '');
      return;
    }
    // 純標題行（例如「上午」「下午場」）略過
    if (!hasTiming && ln.trim().length <= 4 && /^[上下中午晚早場段一二三四五：:\s]+$/.test(ln.trim())) return;
    items.push(parseLine(ln));
  });
  return finalize(items, { title });
}

// ───────────────────────── 表格 ─────────────────────────
const COL_RULES = [
  ['duration', /分鐘|時長|時間長|長度|duration|mins?\b|minutes/i],
  ['start', /開始|起始|^起$|start/i],
  ['end', /結束|^迄$|end/i],
  ['rounds', /回合|輪數|rounds?/i],
  ['owner', /負責|主持|講師|帶領|人員|主講|owner|who|host|speaker/i],
  ['subtitle', /說明|備註|細節|描述|note|desc|subtitle|補充/i],
  ['time', /時間|時段|time/i],
  ['title', /單元|項目|流程|內容|議程|活動|名稱|主題|環節|title|item|agenda|program/i],
];

function cellStr(v) {
  if (v == null) return '';
  if (v instanceof Date) return hm(v.getUTCHours(), v.getUTCMinutes());
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text) return String(v.text);
    if (v.result != null) return cellStr(v.result);
  }
  return String(v).trim();
}

const isTimeCell = (s) => /^\d{1,2}[:：]\d{2}(?::\d{2})?$/.test(s);
const isNumCell = (s) => /^\d+(?:\.\d+)?\s*(?:分鐘|分|min|mins)?$/i.test(s);

export function parseRows(rawRows) {
  const rows = rawRows.map((r) => (r || []).map(cellStr)).filter((r) => r.some((c) => c));
  if (!rows.length) return finalize([]);
  const width = Math.max(...rows.map((r) => r.length));

  // 1) 標題列偵測
  let map = {};
  let body = rows;
  const head = rows[0];
  const headLooksData = head.some((c) => isTimeCell(c) || RANGE_RE.test(c) || /^\d+(\.\d+)?$/.test(c));
  if (!headLooksData) {
    const m = {};
    head.forEach((c, i) => {
      if (!c) return;
      for (const [key, re] of COL_RULES) {
        if (re.test(c) && m[key] == null) {
          m[key] = i;
          break;
        }
      }
    });
    if (Object.keys(m).length >= 1 && (m.title != null || m.duration != null || m.time != null || m.owner != null)) {
      map = m;
      body = rows.slice(1);
    }
  }

  // 2) 沒有標題列：依內容推斷
  if (!Object.keys(map).length) {
    const textCols = [];
    for (let c = 0; c < width; c++) {
      const vals = body.map((r) => r[c] || '').filter(Boolean);
      if (!vals.length) continue;
      if (vals.every((v) => RANGE_RE.test(v))) map.time ??= c;
      else if (vals.every(isTimeCell)) map.start == null ? (map.start = c) : (map.end ??= c);
      else if (vals.every(isNumCell)) map.duration ??= c;
      else textCols.push({ c, avg: vals.reduce((a, v) => a + v.length, 0) / vals.length });
    }
    if (textCols.length) {
      map.title = textCols[0].c;
      const rest = textCols.slice(1);
      if (rest.length) {
        const shortest = rest.reduce((a, b) => (b.avg < a.avg ? b : a));
        if (shortest.avg <= 12) map.owner = shortest.c;
        const sub = rest.find((x) => x.c !== map.owner);
        if (sub) map.subtitle = sub.c;
      }
    }
  }

  const g = (r, k) => (map[k] != null ? r[map[k]] || '' : '');
  const items = body.map((r) => {
    let duration = numOf(g(r, 'duration'));
    let startMin = null;
    const tr = g(r, 'time').match(RANGE_RE) || g(r, 'start').match(RANGE_RE);
    if (tr) {
      startMin = toMin(tr[1], tr[2]);
      if (duration == null) duration = (toMin(tr[3], tr[4]) - startMin + 1440) % 1440;
    } else {
      const st = normTime(g(r, 'start') || g(r, 'time'));
      const et = normTime(g(r, 'end'));
      if (st) startMin = toMin(...st.split(':'));
      if (st && et && duration == null) duration = (toMin(...et.split(':')) - startMin + 1440) % 1440;
    }
    let title = g(r, 'title');
    if (!title) {
      // 沒有對應到標題欄時，取第一個非時間非數字的格子
      title = r.find((c, i) => c && !Object.values(map).includes(i) && !isTimeCell(c) && !isNumCell(c)) || '';
    }
    if (duration == null && DUR_RE.test(title)) {
      const li = parseLine(title);
      return { ...li, owner: g(r, 'owner') || li.owner, subtitle: g(r, 'subtitle') || li.subtitle, _start: startMin ?? li._start };
    }
    return makeItem({ title, subtitle: g(r, 'subtitle'), owner: g(r, 'owner'), duration, rounds: g(r, 'rounds'), startMin });
  });
  return finalize(items);
}

// ───────────────────────── CSV ─────────────────────────
export function parseCSV(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t'
    : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ───────────────────────── 入口 ─────────────────────────
export function parseFlowText(text) {
  let t = String(text || '').replace(/^﻿/, '').trim();
  if (!t) throw new Error('沒有內容');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (/^[\[{]/.test(t)) {
    let obj;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      throw new Error('JSON 格式有誤：' + e.message);
    }
    return normalizeFlowJSON(obj);
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const tabbed = lines.filter((l) => l.includes('\t')).length;
  if (tabbed >= Math.max(2, Math.ceil(lines.length * 0.5))) return parseRows(lines.map((l) => l.split('\t')));
  return parseLines(lines);
}

export function toExportJSON(ev) {
  return {
    title: ev.title || '',
    startTime: ev.plannedStart || '',
    startDate: ev.plannedDate || '',
    items: (ev.items || []).map(({ title, subtitle, owner, duration, rounds }) => ({
      title, subtitle: subtitle || '', owner: owner || '', duration, rounds: rounds || 1,
    })),
  };
}

export const AI_PROMPT = `請把我下面提供的活動流程，整理成以下 JSON 格式。只輸出 JSON 本身，不要任何說明文字。

{
  "title": "活動名稱",
  "startTime": "HH:MM（活動開始時間，不知道就留空字串）",
  "startDate": "YYYY-MM-DD（活動日期；就是今天或不知道就留空字串）",
  "items": [
    {
      "title": "單元名稱",
      "subtitle": "補充說明（可留空）",
      "owner": "負責人，多人用「、」分隔（可留空）",
      "duration": 分鐘數（整數）,
      "rounds": 回合數（沒有分回合就填 1）
    }
  ]
}

規則：
1. 依時間先後排列，每個環節一個 item，報到、休息、合照也要列出。
2. 流程只寫起迄時間（例如 09:00-09:20）時，換算成分鐘數填入 duration。
3. 單元內有固定回合（例如「遊戲 4 回合」）時，rounds 填回合數，duration 填整個單元的總分鐘數。
4. 負責人只填人名，不要加「負責：」等字樣。

我的流程如下：
（把流程表、會議記錄或截圖文字貼在這裡）`;
