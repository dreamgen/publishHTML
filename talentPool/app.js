/* 人才庫查詢 (talentPool) — 純前端，資料只存在本機 IndexedDB */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROC_NOW = new Date().getFullYear() - 1911;
const YEARS = ['2026', '2025', '2024', '2023', '2022'];
const PAGE = 60;

/* ---------------- storage ---------------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('talentPool', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
  };
})();
const LS = {
  get(k, d) { try { const v = localStorage.getItem('talentPool.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('talentPool.' + k, JSON.stringify(v)); } catch {} },
};

/* ---------------- state ---------------- */
const S = {
  data: null,            // {fileName, importedAt, people:[]}
  q: '',
  sort: LS.get('sort', 'att'),
  f: emptyFilter(),
  sel: new Set(LS.get('sel', [])),
  shown: PAGE,
  results: [],
};
function emptyFilter() {
  return { src: [], gender: [], region: [], rank: [], unit: [], groups: [], groupsMode: 'any', act: [], actYear: '2026', attMin: 0, spanMin: 0, ageMin: '', ageMax: '' };
}

/* ---------------- xlsx parsing ---------------- */
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if (v.text) return String(v.text);
    if (v.hyperlink) return String(v.text || v.hyperlink);
    return '';
  }
  return String(v);
}
function fmtDate(d) { return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }
const normRegion = (r) => { r = (r || '').trim(); if (!r || r === '-') return ''; return r.replace(/區$/, ''); };
const normSrc = (s) => s.replace(/\s+/g, ' ').trim().replace(/\s*20\d\d$/, '').replace(/^20\d\d\s*/, '').trim() || s.trim();

function parseRoles(str) {
  if (!str) return [];
  return String(str).split('；').map((x) => x.replace(/\s*\n\s*/g, '').trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(.*?)\s*\(([^()]*)\)$/);
    let val = m ? m[1].trim() : x, src = m ? normSrc(m[2]) : '';
    val = val.replace(/^(\d{4})-(\d{2})-(\d{2})(?: 00:00:00)?$/, (_, y, mo, d) => `${y}/${+mo}/${+d}`);
    return { v: val, s: src };
  });
}
function groupRoles(list) {
  const map = new Map();
  for (const { v, s } of list) {
    const k = s || '其他';
    if (!map.has(k)) map.set(k, []);
    if (v && v !== '幹部/班員' && !map.get(k).includes(v)) map.get(k).push(v);
  }
  return [...map].map(([s, vals]) => ({ s, vals }));
}

function findSheet(wb, kw) { return wb.worksheets.find((w) => w.name.includes(kw)); }
function headerMap(ws) {
  for (let r = 1; r <= 5; r++) {
    const row = ws.getRow(r), map = {};
    row.eachCell((c, i) => { const t = cellText(c.value).trim(); if (t) map[t] = i; });
    if (map['姓名'] || map['提取名(無姓)']) return { row: r, map };
  }
  return null;
}
function col(map, ...names) {
  for (const n of names) { if (map[n]) return map[n]; }
  const k = Object.keys(map).find((h) => names.some((n) => h.startsWith(n)));
  return k ? map[k] : 0;
}

function readSheet(ws, src) {
  const hm = headerMap(ws); if (!hm) return [];
  const m = hm.map;
  const c = {
    name: col(m, '姓名'), code: col(m, '官方編碼'), gender: col(m, '性別'), year: col(m, '年次'),
    rank: col(m, '官方道職'), region: col(m, '官方區域', '主要區域'), unit: col(m, '主要處室/單位'),
    groups: col(m, '推薦組別'), att: col(m, '2026出席次數'), latest: col(m, '最新職務'),
    span: col(m, '服務跨越年份數'), total: col(m, '歷練紀錄總數'), note: col(m, '校核與評語', '姓氏檢核判定與補登建議'),
  };
  const yc = Object.fromEntries(YEARS.map((y) => [y, col(m, `${y}年職務與班別`)]));
  const out = [];
  ws.eachRow((row, r) => {
    if (r <= hm.row) return;
    const g = (i) => (i ? cellText(row.getCell(i).value).trim() : '');
    const name = g(c.name); if (!name) return;
    const yearNum = parseInt(g(c.year), 10);
    const years = {}; const allText = [];
    for (const y of YEARS) { const t = g(yc[y]); allText.push(t); years[y] = groupRoles(parseRoles(t)); }
    const gender = g(c.gender);
    out.push({
      id: g(c.code) || `${src}:${name}`,
      src, name, code: g(c.code),
      gender: gender === '乾' || gender === '坤' ? gender : '',
      roc: Number.isFinite(yearNum) && yearNum > 0 ? yearNum : null,
      rank: g(c.rank), region: normRegion(g(c.region)), unit: g(c.unit),
      groups: g(c.groups).split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
      att: parseInt(g(c.att), 10) || 0,
      span: parseInt(g(c.span), 10) || 0,
      total: parseInt(g(c.total), 10) || 0,
      note: g(c.note),
      years,
      hay: [name, g(c.code), g(c.rank), g(c.region), g(c.unit), g(c.groups), g(c.latest), ...allText].join(' ').replace(/\s+/g, ' ').toLowerCase(),
    });
  });
  return out;
}

async function loadExcelJS() {
  if (window.ExcelJS) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = './vendor/exceljs.min.js';
    s.onload = res; s.onerror = () => rej(new Error('無法載入 ExcelJS')); document.head.appendChild(s);
  });
}

async function importFile(file) {
  showLoading(true);
  try {
    await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const wsC = findSheet(wb, '確定的姓名'), wsP = findSheet(wb, '姓名疑似可用');
    if (!wsC && !wsP) throw new Error('找不到〈確定的姓名〉或〈姓名疑似可用〉工作表，請確認是人才庫總名冊');
    const people = [...(wsC ? readSheet(wsC, 'c') : []), ...(wsP ? readSheet(wsP, 'p') : [])];
    // 確保 id 唯一
    const seen = new Set();
    for (const p of people) { let id = p.id, n = 2; while (seen.has(id)) id = `${p.id}#${n++}`; p.id = id; seen.add(id); }
    if (!people.length) throw new Error('工作表中沒有讀到任何姓名');
    S.data = { fileName: file.name, importedAt: Date.now(), people };
    await DB.set('data', S.data);
    // 保留仍存在的已選
    const ids = new Set(people.map((p) => p.id));
    S.sel = new Set([...S.sel].filter((id) => ids.has(id))); saveSel();
    toast(`已匯入 ${people.length} 人（確定 ${people.filter((p) => p.src === 'c').length}／待校核 ${people.filter((p) => p.src === 'p').length}）`);
    boot();
  } catch (e) {
    console.error(e); toast('匯入失敗：' + e.message, 4000);
  } finally { showLoading(false); }
}

/* ---------------- derived ---------------- */
const age = (p) => (p.roc ? ROC_NOW - p.roc : null);
function counts(key, list) {
  const m = new Map();
  for (const p of list) { const vs = Array.isArray(p[key]) ? p[key] : [p[key]]; for (const v of vs) if (v) m.set(v, (m.get(v) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
}
function actOf(p, year) {
  if (year === 'any') return new Set(YEARS.flatMap((y) => p.years[y].map((r) => r.s)));
  return new Set(p.years[year].map((r) => r.s));
}

function matches(p, f, terms) {
  if (f.src.length && !f.src.includes(p.src)) return false;
  if (f.gender.length && !f.gender.includes(p.gender)) return false;
  if (f.region.length && !f.region.includes(p.region)) return false;
  if (f.rank.length && !f.rank.includes(p.rank || '（未填）')) return false;
  if (f.unit.length && !f.unit.includes(p.unit)) return false;
  if (f.groups.length) {
    const ok = f.groupsMode === 'all' ? f.groups.every((g) => p.groups.includes(g)) : f.groups.some((g) => p.groups.includes(g));
    if (!ok) return false;
  }
  if (f.act.length) { const a = actOf(p, f.actYear); if (!f.act.some((x) => a.has(x))) return false; }
  if (f.attMin && p.att < f.attMin) return false;
  if (f.spanMin && p.span < f.spanMin) return false;
  if (f.ageMin !== '' || f.ageMax !== '') {
    const a = age(p); if (a == null) return false;
    if (f.ageMin !== '' && a < +f.ageMin) return false;
    if (f.ageMax !== '' && a > +f.ageMax) return false;
  }
  for (const t of terms) if (!p.hay.includes(t)) return false;
  return true;
}
const SORTS = {
  att: (a, b) => b.att - a.att || b.total - a.total,
  total: (a, b) => b.total - a.total || b.att - a.att,
  span: (a, b) => b.span - a.span || b.att - a.att,
  ageAsc: (a, b) => (age(a) ?? 999) - (age(b) ?? 999),
  ageDesc: (a, b) => (age(b) ?? -1) - (age(a) ?? -1),
  name: (a, b) => a.name.localeCompare(b.name, 'zh-Hant-TW-u-co-stroke'),
};
function filterCount(f = S.f) {
  let n = 0;
  for (const k of ['src', 'gender', 'region', 'rank', 'unit', 'groups', 'act']) if (f[k].length) n++;
  if (f.attMin) n++; if (f.spanMin) n++; if (f.ageMin !== '' || f.ageMax !== '') n++;
  return n;
}

/* ---------------- render: list ---------------- */
function compute() {
  const terms = S.q.toLowerCase().split(/\s+/).filter(Boolean);
  S.results = S.data.people.filter((p) => matches(p, S.f, terms)).sort(SORTS[S.sort] || SORTS.att);
}
function cardHTML(p) {
  const a = age(p), on = S.sel.has(p.id);
  const tags = [
    p.src === 'p' ? '<span class="tag warn">待校核</span>' : '',
    p.gender ? `<span class="tag">${p.gender}</span>` : '',
    a != null ? `<span class="tag">${a} 歲</span>` : '',
    p.rank ? `<span class="tag acc">${esc(p.rank)}</span>` : '',
  ].join('');
  const l2 = [p.region, p.unit].filter(Boolean).map(esc).join('・');
  const gr = p.groups.slice(0, 6).map((g) => `<span class="tag">${esc(g)}</span>`).join('') + (p.groups.length > 6 ? `<span class="tag">+${p.groups.length - 6}</span>` : '');
  return `<div class="card${on ? ' sel' : ''}" data-id="${esc(p.id)}">
    <button class="ck" data-act="toggle" aria-label="勾選 ${esc(p.name)}" aria-pressed="${on}"><span></span></button>
    <button class="body" data-act="detail">
      <div class="nm"><b>${esc(p.name)}</b>${tags}</div>
      ${l2 ? `<div class="l2">${l2}</div>` : ''}
      ${gr ? `<div class="l3">${gr}</div>` : ''}
      <div class="stats"><span>2026 出席 <b>${p.att}</b></span><span>服務 <b>${p.span}</b> 年</span><span>歷練 <b>${p.total}</b></span></div>
    </button>
  </div>`;
}
function renderList(reset = true) {
  if (reset) S.shown = PAGE;
  compute();
  const list = $('#list'), r = S.results;
  const nSel = r.filter((p) => S.sel.has(p.id)).length;
  $('#resultInfo').textContent = `${r.length} / ${S.data.people.length} 人` + (nSel ? `・已選 ${nSel}` : '');
  $('#btnSelAll').textContent = r.length && nSel === r.length ? '取消全選' : '全選結果';
  if (!r.length) { list.innerHTML = '<div class="empty">沒有符合條件的人選<br><span class="tiny">試試放寬篩選或換個關鍵字</span></div>'; }
  else {
    list.innerHTML = r.slice(0, S.shown).map(cardHTML).join('') +
      (r.length > S.shown ? `<button class="more" id="btnMore">再顯示 ${Math.min(PAGE, r.length - S.shown)} 人（剩 ${r.length - S.shown}）</button>` : '');
  }
  const n = filterCount(); $('#fCount').textContent = n; $('#fCount').classList.toggle('hidden', !n); $('#btnFilter').classList.toggle('on', !!n);
  renderActiveF();
  renderSelBar();
}
function renderActiveF() {
  const f = S.f, out = [];
  const lab = { src: { c: '確定名冊', p: '待校核' } };
  for (const k of ['src', 'gender', 'region', 'rank', 'unit', 'groups', 'act']) for (const v of f[k]) out.push([k, v, (lab[k]?.[v]) || v]);
  if (f.attMin) out.push(['attMin', 0, `2026出席≥${f.attMin}`]);
  if (f.spanMin) out.push(['spanMin', 0, `服務≥${f.spanMin}年`]);
  if (f.ageMin !== '' || f.ageMax !== '') out.push(['age', 0, `年齡 ${f.ageMin || '?'}–${f.ageMax || '?'}`]);
  $('#activeF').innerHTML = out.map(([k, v, t]) => `<button data-k="${k}" data-v="${esc(v)}">${esc(t)} ✕</button>`).join('');
  $('#activeF').classList.toggle('hidden', !out.length);
}
function renderSelBar() {
  $('#selN').textContent = S.sel.size;
  $('#selbar').classList.toggle('hidden', !S.sel.size);
}
function refreshCard(id) {
  const el = $(`.card[data-id="${CSS.escape(id)}"]`); if (!el) return;
  const p = byId(id); if (p) el.outerHTML = cardHTML(p);
}
const byId = (id) => S.data.people.find((p) => p.id === id);
function saveSel() { LS.set('sel', [...S.sel]); }
function toggleSel(id) {
  S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); saveSel();
  refreshCard(id); renderSelBar();
  const r = S.results, nSel = r.filter((p) => S.sel.has(p.id)).length;
  $('#resultInfo').textContent = `${r.length} / ${S.data.people.length} 人` + (nSel ? `・已選 ${nSel}` : '');
  $('#btnSelAll').textContent = r.length && nSel === r.length ? '取消全選' : '全選結果';
}

/* ---------------- detail ---------------- */
let detailId = null;
function openDetail(id) {
  const p = byId(id); if (!p) return; detailId = id;
  const a = age(p);
  $('#dTitle').textContent = p.name;
  const kv = [
    ['名冊', p.src === 'c' ? '確定（已登錄官方名冊）' : '待校核（不在官方名冊）'],
    ['官方編碼', p.code], ['乾坤', p.gender], ['年次／年齡', p.roc ? `${p.roc} 年次・${a} 歲` : ''],
    ['官方道職', p.rank], ['區域', p.region], ['主要單位', p.unit], ['推薦組別', p.groups.join('、')],
    ['2026 出席', `${p.att} 次`], ['服務年數', `${p.span} 年`], ['歷練紀錄', `${p.total} 筆`],
  ].filter(([, v]) => v);
  const yrs = YEARS.filter((y) => p.years[y].length).map((y) => `<div class="yr"><h5>${y} 年</h5>${p.years[y].map((g) => `<div class="row"><span>${esc(g.s)}</span>${g.vals.length ? '：' + esc(g.vals.join('、')) : ''}</div>`).join('')}</div>`).join('');
  $('#dBody').innerHTML = `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${yrs || '<p class="muted">沒有歷年職務紀錄</p>'}${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}`;
  updateDetailBtn();
  openSheet('#sheetDetail');
}
function updateDetailBtn() { $('#dSel').textContent = S.sel.has(detailId) ? '移出已選' : '加入已選'; }

/* ---------------- share ---------------- */
const FIELDS = [
  ['gender', '乾坤', true], ['age', '年齡', true], ['region', '區域', true], ['rank', '道職', true],
  ['unit', '主要單位', false], ['groups', '推薦組別', false], ['att', '2026出席', true], ['span', '服務年數', false],
  ['roles', '2026 職務', false], ['code', '官方編碼', false], ['pending', '待校核標記', true],
];
let shareCfg = LS.get('share', null) || { style: 'line', on: Object.fromEntries(FIELDS.map(([k, , d]) => [k, d])) };
function rolesBrief(p) {
  return p.years['2026'].map((g) => g.s).filter((s) => s !== '其他').slice(0, 6).join('、');
}
function personLine(p, i, cfg) {
  const on = cfg.on, a = age(p);
  const basic = [], stat = [];
  if (on.gender && p.gender) basic.push(p.gender);
  if (on.age && a != null) basic.push(`${a}歲`);
  if (on.region && p.region) basic.push(p.region);
  if (on.rank && p.rank) basic.push(p.rank);
  if (on.unit && p.unit) basic.push(p.unit);
  if (on.code && p.code) basic.push(p.code);
  if (on.att) stat.push(`2026出席${p.att}次`);
  if (on.span) stat.push(`服務${p.span}年`);
  const groups = on.groups && p.groups.length ? '推薦：' + p.groups.join('、') : '';
  const r = on.roles ? rolesBrief(p) : '', roles = r ? '2026：' + r : '';
  const nm = `${i + 1}. ${p.name}` + (on.pending && p.src === 'p' ? '（待校核）' : '');
  if (cfg.style === 'block') {
    return [nm, [...basic, ...stat].join('・'), groups, roles].filter(Boolean).join('\n   ');
  }
  const parts = [...basic, ...stat, groups, roles].filter(Boolean);
  return nm + (parts.length ? '｜' + parts.join('｜') : '');
}
function selectedPeople() {
  const order = [...S.sel];
  return order.map(byId).filter(Boolean);
}
function buildText(list = selectedPeople(), cfg = shareCfg, title = $('#shTitle').value.trim()) {
  const head = (title ? `【${title}】` : '【人選名單】') + `共 ${list.length} 人`;
  return [head, ...list.map((p, i) => personLine(p, i, cfg))].join(cfg.style === 'block' ? '\n\n' : '\n').replace(/^(.*?)\n\n/, '$1\n');
}
function renderShare() {
  $('#shFields').innerHTML = FIELDS.map(([k, label]) => `<label><input type="checkbox" data-sf="${k}"${shareCfg.on[k] ? ' checked' : ''}>${label}</label>`).join('');
  $$('#shStyle button').forEach((b) => b.classList.toggle('on', b.dataset.v === shareCfg.style));
  $('#shText').value = buildText();
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('已複製，可貼到 LINE 或其他 App');
}
function shareLine(t) {
  const url = 'https://line.me/R/share?text=' + encodeURIComponent(t);
  window.open(url, '_blank', 'noopener') || (location.href = url);
}
async function shareSys(t) {
  if (navigator.share) { try { await navigator.share({ text: t }); } catch (e) { if (e.name !== 'AbortError') copyText(t); } }
  else copyText(t);
}
function quickText() { const t = $('#shTitle').value.trim(); return buildText(selectedPeople(), shareCfg, t); }

/* ---------------- selected list ---------------- */
function renderSelList() {
  const list = selectedPeople();
  $('#selBody').innerHTML = list.length ? list.map((p) => `<div class="selitem" data-id="${esc(p.id)}"><div class="grow"><b>${esc(p.name)}</b> <span class="tiny muted">${esc([p.gender, age(p) != null ? age(p) + '歲' : '', p.region, p.rank].filter(Boolean).join('・'))}</span></div><button data-act="rm" aria-label="移除">✕</button></div>`).join('') : '<div class="empty">尚未勾選任何人</div>';
}

/* ---------------- sheets / ui helpers ---------------- */
let openSheetSel = null;
function openSheet(sel) {
  if (openSheetSel && openSheetSel !== sel) $(openSheetSel).classList.add('hidden');
  openSheetSel = sel; $(sel).classList.remove('hidden'); $('#scrim').classList.remove('hidden');
  $(sel + ' .sh-b').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  if (!openSheetSel) return;
  const was = openSheetSel; $(was).classList.add('hidden'); $('#scrim').classList.add('hidden'); openSheetSel = null;
  document.body.style.overflow = '';
  if (was === '#sheetFilter' || was === '#sheetSel' || was === '#sheetDetail') renderList(was === '#sheetFilter');
}
let toastT;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms); }
function showLoading(on) { $('#loading').classList.toggle('hidden', !on); }

/* ---------------- events ---------------- */
function bind() {
  $('#file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
  $('#btnImport1').onclick = $('#mImport').onclick = () => { $('#menu').classList.add('hidden'); $('#file').click(); };
  $('#btnMenu').onclick = (e) => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').classList.add('hidden'); });
  $('#mClearSel').onclick = () => { S.sel.clear(); saveSel(); $('#menu').classList.add('hidden'); if (S.data) renderList(false); };
  $('#mWipe').onclick = async () => {
    $('#menu').classList.add('hidden');
    if (!confirm('確定刪除這支手機上的人才庫資料？（不影響原 xlsx 檔）')) return;
    await DB.del('data'); S.data = null; S.sel.clear(); saveSel(); boot(); toast('已刪除本機資料');
  };

  let qt;
  $('#q').addEventListener('input', (e) => {
    $('#qClear').classList.toggle('hidden', !e.target.value);
    clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value.trim(); renderList(); window.scrollTo({ top: 0 }); }, 150);
  });
  $('#qClear').onclick = () => { $('#q').value = ''; S.q = ''; $('#qClear').classList.add('hidden'); renderList(); $('#q').focus(); };
  $('#sort').value = S.sort;
  $('#sort').onchange = (e) => { S.sort = e.target.value; LS.set('sort', S.sort); renderList(); };
  $('#btnSelAll').onclick = () => {
    const r = S.results, all = r.length && r.every((p) => S.sel.has(p.id));
    if (!all && r.length > 100 && !confirm(`要勾選全部 ${r.length} 人嗎？`)) return;
    r.forEach((p) => (all ? S.sel.delete(p.id) : S.sel.add(p.id))); saveSel(); renderList(false);
  };

  $('#list').addEventListener('click', (e) => {
    if (e.target.id === 'btnMore') { S.shown += PAGE; renderList(false); return; }
    const card = e.target.closest('.card'); if (!card) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle') toggleSel(card.dataset.id); else if (act === 'detail') openDetail(card.dataset.id);
  });
  $('#activeF').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k, v = b.dataset.v;
    if (k === 'attMin' || k === 'spanMin') S.f[k] = 0;
    else if (k === 'age') { S.f.ageMin = ''; S.f.ageMax = ''; }
    else S.f[k] = S.f[k].filter((x) => x !== v);
    renderList();
  });

  // filter page
  $('#btnFilter').onclick = () => FP.openPage();
  FP.bind();

  // font size
  $('#mFont').onclick = (e) => { e.stopPropagation(); setFont((LS.get('fs', 1) + 1) % FONTS.length); };

  // close sheets
  $('#scrim').onclick = closeSheet;
  $$('[data-close]').forEach((b) => (b.onclick = closeSheet));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // detail
  $('#dSel').onclick = () => { toggleSel(detailId); updateDetailBtn(); };
  $('#dCopy').onclick = () => { const p = byId(detailId); copyText(personLine(p, 0, shareCfg).replace(/^1\. /, '')); };

  // selection bar
  $('#btnSelList').onclick = () => { renderSelList(); openSheet('#sheetSel'); };
  $('#btnCopy').onclick = () => copyText(quickText());
  $('#btnShare').onclick = () => { renderShare(); openSheet('#sheetShare'); };
  $('#selShare').onclick = () => { renderShare(); openSheet('#sheetShare'); };
  $('#selClear').onclick = () => { if (!confirm('清除全部已選人選？')) return; S.sel.clear(); saveSel(); renderSelList(); renderSelBar(); };
  $('#selBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="rm"]'); if (!b) return;
    const id = b.closest('.selitem').dataset.id; S.sel.delete(id); saveSel(); renderSelList(); renderSelBar();
    if (!S.sel.size) closeSheet();
  });

  // share sheet
  $('#shFields').addEventListener('change', (e) => { const k = e.target.dataset.sf; if (!k) return; shareCfg.on[k] = e.target.checked; LS.set('share', shareCfg); $('#shText').value = buildText(); });
  $('#shStyle').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; shareCfg.style = b.dataset.v; LS.set('share', shareCfg); renderShare(); });
  $('#shTitle').addEventListener('input', () => { LS.set('title', $('#shTitle').value); $('#shText').value = buildText(); });
  $('#shCopy').onclick = () => copyText($('#shText').value);
  $('#shLine').onclick = () => shareLine($('#shText').value);
  $('#shSys').onclick = () => shareSys($('#shText').value);
}

/* ---------------- boot ---------------- */
const FONTS = [['標準', 16], ['大', 18], ['特大', 20]];
function setFont(i) {
  LS.set('fs', i);
  document.documentElement.style.fontSize = FONTS[i][1] + 'px';
  $('#mFont').textContent = `字級：${FONTS[i][0]}（點一下切換）`;
}
function boot() {
  const has = !!S.data;
  $('#welcome').classList.toggle('hidden', has);
  $('#toolbar').classList.toggle('hidden', !has);
  $('#list').classList.toggle('hidden', !has);
  $('#dataInfo').textContent = has
    ? `${S.data.fileName}｜${S.data.people.length} 人｜${new Date(S.data.importedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })} 匯入`
    : '尚未匯入人才庫';
  FP.renderPresetRow();
  if (has) renderList(); else { $('#list').innerHTML = ''; renderSelBar(); }
}

window.addEventListener('DOMContentLoaded', async function init() {
  $('#shTitle').value = LS.get('title', '');
  setFont(LS.get('fs', 1));
  bind();
  try { S.data = (await DB.get('data')) || null; } catch (e) { console.error(e); }
  boot();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
});
