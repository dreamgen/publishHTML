// 主辦者端共用工具：DOM 小幫手、API、localStorage 活動清單、流程表解析、toast
// 所有伺服器／使用者資料一律以 textContent 寫入，不使用 innerHTML。

/** 建立 DOM 元素：h('div', {class:'x', onclick:fn}, '文字', child) */
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

/** 清空並放入子節點 */
export function mount(parent, ...kids) {
  parent.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  return parent;
}

// ---------- localStorage（全部包 try/catch，私密視窗也能運作） ----------
const LS_EVENTS = 'mv.events.v1';
const LS_SECRET = 'mv.createSecret.v1';
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }

export function loadEvents() {
  try {
    const a = JSON.parse(lsGet(LS_EVENTS) || '[]');
    return Array.isArray(a) ? a.filter((x) => x && x.event_id && x.admin_code) : [];
  } catch { return []; }
}
function saveEvents(list) { lsSet(LS_EVENTS, JSON.stringify(list)); }
/** 加入或更新「我的活動」；同一 event_id 只保留一筆 */
export function upsertEvent(rec) {
  const list = loadEvents();
  const i = list.findIndex((x) => x.event_id === rec.event_id);
  const merged = { created_at: new Date().toISOString(), ...(i >= 0 ? list[i] : {}), ...rec };
  if (i >= 0) list[i] = merged; else list.unshift(merged);
  saveEvents(list);
  return merged;
}
export function removeEvent(id) { saveEvents(loadEvents().filter((x) => x.event_id !== id)); }
export const getCreateSecret = () => lsGet(LS_SECRET) || '';
export const setCreateSecret = (s) => lsSet(LS_SECRET, s);

/** 管理網址 */
export function adminHref(id, k) { return `/admin#e=${encodeURIComponent(id)}${k ? `&k=${encodeURIComponent(k)}` : ''}`; }
export function adminFullUrl(id, k) { return location.origin + adminHref(id, k); }

/** 從貼上的文字解析管理連結（完整網址、#e=..&k=.. 或 e=..&k=..） */
export function parseAdminLink(text) {
  const s = String(text || '');
  const e = s.match(/[#&?\s]e=(ev_[A-Za-z0-9_-]{12})/) || s.match(/^e=(ev_[A-Za-z0-9_-]{12})/);
  const k = s.match(/[#&?\s]k=([A-Za-z0-9_-]{8,})/) || s.match(/&k=([A-Za-z0-9_-]{8,})/);
  return e && k ? { e: e[1], k: k[1] } : null;
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
/** 權限／登入相關錯誤碼的友善訊息（後端已強制權限，前端只負責講人話） */
const FRIENDLY = {
  forbidden: '你沒有權限執行這個動作',
  bad_origin: '連線來源不符，請重新整理頁面後再試',
  has_owner: '此活動已由其他帳號管理',
  auth_unavailable: '登入服務暫時無法使用，請稍後再試',
};
/** 呼叫 API；status 0 代表網路失敗 */
export async function apiFetch(path, { method = 'GET', headers = {}, body, raw = false } = {}) {
  let res;
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob; // 圖片等二進位內容直接送，不轉 JSON
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': isBlob ? body.type : 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', '無法連線，請檢查網路後再試');
  }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const code = data?.error || 'error';
    throw new ApiError(res.status, code, FRIENDLY[code] || data?.message || `發生錯誤（${res.status}）`);
  }
  return data;
}
/** 管理 API 包裝：api(id,k)(path, opts)。沒有 k 時不帶 Authorization，改靠登入 cookie 驗證 */
export function adminApi(id, k) {
  return (sub = '', opts = {}) => apiFetch(`/api/admin/${id}${sub}`, { ...opts, headers: { ...(k ? { Authorization: `Bearer ${k}` } : {}), ...(opts.headers || {}) } });
}

// ---------- 邀請文字（與後端 config.js 的 inviteAuto 一致，供輸入框 placeholder 與即時預覽） ----------
/** 台灣時間（UTC+8）的 M/D */
function taipeiMD(iso) {
  const ms = Date.parse(iso);
  if (isNaN(ms)) return '';
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
export function autoInvite(cfg) {
  const b = cfg.basic || {};
  const name = b.name || '';
  const where = [dateRangeText(b), b.location || ''].filter(Boolean).join(' ');
  const until = cfg.upload?.closes_at ? taipeiMD(cfg.upload.closes_at) : '';
  const tail = [where, until ? `開放至 ${until}` : ''].filter(Boolean).join('・');
  const head = `邀請你上傳【${name}】拍到的照片，我們會一起做成回顧 MV。`;
  return { title: name, message: tail ? `${head}${tail}` : head };
}

// ---------- 階段 ----------
export const STAGES = [
  { key: 'planning', name: '規劃中', desc: '建立活動，陸續補流程、小隊、拍攝清單', tag: '' },
  { key: 'open', name: '募集中', desc: '到了開放時間自動開放上傳，管理頁看即時進度', tag: 'tag-ok' },
  { key: 'grace', name: '補傳期', desc: '活動結束後仍可補傳，直到截止', tag: 'tag-warn' },
  { key: 'closed', name: '製作 MV', desc: '製作者用提示詞讓 AI 同步照片、完成影片', tag: 'tag-warn' },
  { key: 'purged', name: '封存刪除', desc: '到期自動刪除雲端照片', tag: '' },
];
export const stageOf = (key) => STAGES.find((s) => s.key === key) || STAGES[0];

// ---------- 格式化 ----------
export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
const pad = (n) => String(n).padStart(2, '0');
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}
export function relTime(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (isNaN(s)) return '';
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}
/** ISO（帶時區）→ datetime-local 值（使用者本地時間） */
export function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** datetime-local 值 → 帶時區 ISO；空值回 null */
export function localInputToIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}
/** 距今天數描述（日期為 YYYY-MM-DD） */
export function daysFromNow(dateStr, endStr = null) {
  if (!dateStr) return '日期未定';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y) return dateStr;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffOf = (s) => { const [a, b, c] = s.split('-').map(Number); return Math.round((new Date(a, b - 1, c) - today) / 86400000); };
  const diff = diffOf(dateStr);
  const end = endStr && endStr > dateStr ? endStr : null;
  if (end) {
    const total = diffOf(end) - diff + 1;
    const label = `${dateRangeText({ date: dateStr, end_date: end })}（${total} 天）`;
    if (diff > 0) return `${label} · 距今 ${diff} 天`;
    if (diffOf(end) >= 0) return `${label} · 進行中（第 ${1 - diff} 天）`;
    return `${label} · 已結束 ${-diffOf(end)} 天`;
  }
  const rel = diff === 0 ? '今天' : diff > 0 ? `距今 ${diff} 天` : `已過 ${-diff} 天`;
  return `${dateStr} · ${rel}`;
}

// ---------- 日期顯示（與後端 config.js 一致） ----------
/** 單日「2026/11/20」；多日「2026/11/20–11/22」 */
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
const WD = '日一二三四五六';
/** 「第2天 11/21（六）」；沒有日期只回「第2天」 */
export function dayLabel(day, date) {
  const d = date ? new Date(date + 'T00:00:00Z') : null;
  return [`第${day}天`, d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）` : ''].filter(Boolean).join(' ');
}

// ---------- 流程表解析（合約 §4，與後端 config.js 一致） ----------
const SCHED_RE = /^(\d{1,2}):(\d{2})\s*[-–~～至到]\s*(\d{1,2}):(\d{2})\s+(.+)$/;
const PUNCT_EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
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
const validDate = (d) => { const x = new Date(d + 'T00:00:00Z'); return !isNaN(x) && x.toISOString().slice(0, 10) === d; };
export function parseDayHeader(line, startDate) {
  const t = String(line || '').trim().replace(/^[#*\s【[（(]+/, '').replace(/[】\]）)]/, ' ').trim();
  if (!t || SCHED_RE.test(t)) return null;
  let m = DATE_HEAD_RE.exec(t);
  if (m) {
    const mo = Number(m[2] || m[4] || m[6]);
    const da = Number(m[3] || m[5] || m[7]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    let y = m[1] ? Number(m[1]) : startDate ? Number(startDate.slice(0, 4)) : new Date().getUTCFullYear();
    const mk = (yy) => `${yy}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    if (!m[1] && startDate && mk(y) < addDays(startDate, -180)) y += 1;
    const date = mk(y);
    return validDate(date) ? { date, n: null } : null;
  }
  m = DAY_HEAD_RE.exec(t);
  if (m) {
    const n = m[1] ? Number(m[1]) : m[2] ? Number(m[2]) : cnToInt(m[3]);
    if (!Number.isInteger(n) || n < 1 || n > 60) return null;
    return { date: startDate ? addDays(startDate, n - 1) : null, n };
  }
  return null;
}
/** 回傳 { segments:[{start,end,name,title,day,date}], ignored:[行], multi } */
export function parseSchedule(text, startDate = null) {
  const blocks = [];
  const ignored = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const hd = parseDayHeader(line, startDate);
    if (hd) {
      const n = hd.n || (cur && cur.items.length ? cur.n + 1 : cur ? cur.n : 1);
      const date = hd.date || (startDate ? addDays(startDate, n - 1) : null);
      if (cur && !cur.items.length) { cur.n = n; cur.date = date; } else { cur = { n, date, items: [] }; blocks.push(cur); }
      continue;
    }
    const m = line.match(SCHED_RE);
    if (!m) { ignored.push(line); continue; }
    if (!cur) { cur = { n: 1, date: startDate, items: [] }; blocks.push(cur); }
    const title = Array.from(m[5].replace(PUNCT_EDGE, '')).slice(0, 20).join('');
    if (title) cur.items.push({ start: `${m[1].padStart(2, '0')}:${m[2]}`, end: `${m[3].padStart(2, '0')}:${m[4]}`, title, line });
  }
  const used = blocks.filter((b) => b.items.length);
  const multi = used.length >= 2;
  const segments = [];
  const seen = new Set();
  for (const b of used) {
    for (const it of b.items) {
      const name = multi ? `第${b.n}天・${it.title}` : it.title;
      if (seen.has(name)) { ignored.push(it.line); continue; }
      seen.add(name);
      segments.push({ start: it.start, end: it.end, name, title: it.title, day: multi ? b.n : null, date: multi ? b.date : null });
    }
  }
  return { segments, ignored, multi };
}

/** 把環節依天分組：[{ day, date, label, items }]；單日活動回一組（label 空字串） */
export function groupByDay(segments) {
  const out = [];
  for (const s of segments || []) {
    const key = s.day || 0;
    let g = out.find((x) => x.day === key);
    if (!g) { g = { day: key, date: s.date || null, label: key ? dayLabel(key, s.date) : '', items: [] }; out.push(g); }
    g.items.push(s);
  }
  return out;
}

// ---------- 剪貼簿 ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 後備：暫時 textarea + execCommand
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// ---------- toast（aria-live） ----------
let toastTimer;
export function toast(msg, kind = '') {
  let box = document.getElementById('toast');
  if (!box) {
    box = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  box.classList.toggle('toast-err', kind === 'err');
  box.textContent = msg;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, kind === 'err' ? 5000 : 2200);
}

/** 按鈕按下後暫時顯示「已複製」之類的標籤 */
export function flashLabel(btn, text, ms = 1600) {
  const old = btn.dataset.label ?? btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  clearTimeout(btn._ft);
  btn._ft = setTimeout(() => { btn.textContent = old; }, ms);
}
