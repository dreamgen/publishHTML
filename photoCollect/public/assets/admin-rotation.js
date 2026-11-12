// 準備中心「輪站課程」編輯器：時段 × 關卡 × 小隊的輪站表（含輪空）
// 依 Claude Design 畫板「10 輪站課程設定」。資料格式見 src/rotation.js。
import { h, mount, addDays, dayLabel, toast } from './admin-common.js';

const COLORS = ['#0E6F6A', '#B5651D', '#3D6FB6', '#6B8E23', '#8E4585', '#A0522D', '#2F7F9E', '#7A6A00', '#5E5E9E', '#9E3B3B', '#3B7D5E', '#80602E'];
const SOFTS = ['#E3F1EF', '#F8EBDD', '#E3EBF7', '#ECF2DF', '#F3E4F0', '#F5E6DC', '#DFEFF5', '#F2EED6', '#E8E8F5', '#F5E1E1', '#E0F0E8', '#F2EADD'];
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

/** 依序輪轉：虛擬關卡補到 N = max(隊數, 關卡數)，超出實際關卡的就是輪空 */
export function autoGrid(nG, nS, nT) {
  const N = Math.max(nG, nS);
  return Array.from({ length: nG }, (_, g) => Array.from({ length: nT }, (_, t) => { const k = (g + t) % N; return k < nS ? k : -1; }));
}
// 依天分組流程表環節：[[day|0, segs]]
function groupDays(segs) {
  const m = new Map();
  for (const x of segs) { const d = x.day || 0; if (!m.has(d)) m.set(d, []); m.get(d).push(x); }
  return [...m.entries()].sort(([a], [b]) => a - b);
}
function makeSlots(start, len, gap, count) {
  const s0 = toMin(start);
  return Array.from({ length: count }, (_, i) => ({ start: fmt(s0 + i * (len + gap)), end: fmt(s0 + i * (len + gap) + len) }));
}

/** 檢查：同段同關重複、某隊沒走完全部關卡；關卡空檔；輪空次數 */
export function checkRotation(rot) {
  const issues = [];
  const dup = new Set();
  const nT = rot.slots.length;
  for (let t = 0; t < nT; t++) {
    const seen = {};
    rot.rows.forEach((r, g) => {
      const s = r.cells[t];
      if (s < 0) return;
      if (seen[s] !== undefined) {
        dup.add(`${g},${t}`); dup.add(`${seen[s]},${t}`);
        issues.push(`第 ${t + 1} 段：${rot.rows[seen[s]].group}和${r.group}都在「${rot.stations[s].name}」`);
      } else seen[s] = g;
    });
  }
  for (const r of rot.rows) {
    const miss = rot.stations.filter((_, i) => !r.cells.includes(i)).map((x) => `「${x.name}」`);
    if (miss.length && nT >= rot.stations.length) issues.push(`${r.group}沒排到${miss.join('、')}`);
  }
  const idle = [];
  for (let t = 0; t < nT; t++) {
    const used = new Set(rot.rows.map((r) => r.cells[t]));
    const free = rot.stations.filter((_, i) => !used.has(i)).map((x) => x.name);
    if (free.length && rot.rows.length) idle.push(`第 ${t + 1} 段（${rot.slots[t].start}–${rot.slots[t].end}）：${free.join('、')}`);
  }
  const byes = rot.rows.reduce((a, r) => a + r.cells.filter((x) => x < 0).length, 0);
  return { issues, dup, idle, byes };
}

export function edRotation(ctx, { markDirty }) {
  const c = ctx.cfg;
  const groupsAll = c.groups || [];
  let list = clone(c.rotations || []);
  let cur = 0;
  const gen = { start: '09:30', len: 25, gap: 5, count: 5 };
  const slotModes = new Map(); // 輪站區塊 id → 時段來源（pick／split／custom），只影響編輯畫面
  const box = h('div', { class: 'stack rot' });
  const changed = () => { markDirty(); draw(); };
  const multiDay = !!c.basic?.end_date;
  const nDays = multiDay ? Math.round((Date.parse(c.basic.end_date) - Date.parse(c.basic.date)) / 86400000) + 1 : 0;

  const dayTxt = (d) => (d ? dayLabel(d, c.basic?.date ? addDays(c.basic.date, d - 1) : null) : '');
  // 跨日輪站：每一段各自帶 day；舊資料（區塊層級 day）轉成每段的 day
  if (multiDay) for (const r of list) { for (const sl of r.slots) if (!sl.day) sl.day = r.day || 1; r.day = null; }
  const daysOf = (r) => [...new Set(r.slots.map((x) => x.day).filter(Boolean))].sort((a, b) => a - b);
  const daysLabel = (r) => { const d = daysOf(r); return !multiDay || !d.length ? '' : d.length === 1 ? `（第${d[0]}天）` : `（第${d[0]}–${d[d.length - 1]}天，跨日）`; };
  // 依「天、開始時間」重排時段，輪站表的欄跟著移動
  function resortSlots(r) {
    const order = r.slots.map((x, i) => [x, i]).sort(([a], [b]) => (a.day || 0) - (b.day || 0) || a.start.localeCompare(b.start)).map(([, i]) => i);
    r.slots = order.map((i) => r.slots[i]);
    r.rows.forEach((row) => { row.cells = order.map((i) => (row.cells[i] === undefined ? -1 : row.cells[i])); });
  }

  function newRotation() {
    const stations = [{ name: '關卡一', place: '' }, { name: '關卡二', place: '' }, { name: '關卡三', place: '' }];
    const groups = [...groupsAll];
    const nT = Math.max(groups.length, stations.length) || 3;
    const slots = makeSlots(gen.start, gen.len, gen.gap, nT).map((x) => (multiDay ? { ...x, day: 1 } : x));
    const grid = autoGrid(groups.length, stations.length, nT);
    return { id: `r${Date.now().toString(36).slice(-5)}`, title: list.length ? `輪站課程 ${list.length + 1}` : '輪站課程', slots, stations, rows: groups.map((g, i) => ({ group: g, cells: grid[i] })), bye_mode: 'free', day: null };
  }
  // 結構改變後讓每列的格數與時段一致、索引不超出關卡數
  function fit(rot) {
    const nT = rot.slots.length, nS = rot.stations.length;
    rot.rows.forEach((r) => {
      r.cells = r.cells.slice(0, nT).map((x) => (x >= nS ? -1 : x));
      while (r.cells.length < nT) r.cells.push(-1);
    });
  }
  function reAuto(rot) {
    const g = autoGrid(rot.rows.length, rot.stations.length, rot.slots.length);
    rot.rows.forEach((r, i) => { r.cells = g[i]; });
  }

  let drawing = false;
  function draw() {
    if (drawing) return; // 重繪移除焦點元素時會觸發 change，避免重入
    drawing = true;
    try { drawInner(); } finally { drawing = false; }
  }
  function drawInner() {
    if (!groupsAll.length) {
      const n = h('input', { class: 'input', type: 'number', min: '2', max: '20', value: '5', style: 'max-width:100px', 'aria-label': '小隊數' });
      mount(box,
        h('div', { class: 'warn', text: '輪站表是「小隊 × 時段」，請先在「小隊與人員名單」建立小隊。' }),
        h('div', { class: 'row' }, '快速建立', n, ' 個小隊（一小隊、二小隊…）',
          h('button', { type: 'button', class: 'btn', text: '建立', onclick: async () => {
            const k = Math.max(2, Math.min(20, Number(n.value) || 5));
            const cn = '一二三四五六七八九十';
            const names = Array.from({ length: k }, (_, i) => `${i < 10 ? cn[i] : i + 1}小隊`);
            try { await ctx.patch({ groups: names }, { quiet: true }); toast(`已建立 ${k} 個小隊`); } catch { /* 已 toast */ }
          } })));
      return;
    }
    const tabs = h('div', { class: 'chips', role: 'tablist', 'aria-label': '輪站區塊' },
      list.map((r, i) => h('button', { type: 'button', role: 'tab', class: 'chip', 'aria-selected': String(i === cur), 'aria-pressed': String(i === cur), onclick: () => { cur = i; draw(); } }, r.title + daysLabel(r))),
      list.length < 6 ? h('button', { type: 'button', class: 'chip', text: '＋ 新增輪站區塊', onclick: () => { list.push(newRotation()); cur = list.length - 1; changed(); } }) : null);
    if (!list.length) {
      mount(box, h('div', { class: 'note', text: '同一時段多個場地同時上課、各小隊依序換關卡時使用。照片會依「小隊＋時段」自動歸到正確的課程；人數不足時可以安排輪空。' }), tabs);
      return;
    }
    if (cur >= list.length) cur = list.length - 1;
    const rot = list[cur];
    fit(rot);
    const chk = checkRotation(rot);

    // ---- 基本 ----
    const title = h('input', { class: 'input', value: rot.title, maxlength: '20', oninput: (e) => { rot.title = e.target.value; markDirty(); } });
    const daySelect = (val, onPick, label) => h('select', { class: 'select', 'aria-label': label, onchange: (e) => onPick(Number(e.target.value)) },
      Array.from({ length: nDays }, (_, i) => { const o = h('option', { value: String(i + 1), text: dayTxt(i + 1) }); if (val === i + 1) o.selected = true; return o; }));
    const head = h('div', { class: 'grid2' },
      h('label', { class: 'field' }, '區塊名稱', title),
      h('div', { class: 'field' }, h('span', { class: 'muted small', text: multiDay ? '輪站可以跨日：每一段各自選哪一天，例如第 1 天下午兩段、第 2 天上午三段。' : ' ' }),
        h('button', { type: 'button', class: 'btn btn-link-danger', text: '刪除這個輪站區塊', onclick: () => remove() })));

    // ---- 1 時段 ----
    const gi = (k, attrs) => { const e = h('input', { class: 'input', ...attrs }); e.value = gen[k]; e.addEventListener('input', () => { gen[k] = attrs.type === 'time' ? e.value : Number(e.value); }); return e; };
    const slotList = h('div', { class: 'chips' }, rot.slots.map((s, i) => {
      const a = h('input', { class: 'input rot-time', type: 'time', 'aria-label': `第 ${i + 1} 段開始` }); a.value = s.start;
      const b = h('input', { class: 'input rot-time', type: 'time', 'aria-label': `第 ${i + 1} 段結束` }); b.value = s.end;
      // 手動改時間就不再跟著流程表
      a.addEventListener('change', () => { s.start = a.value; delete s.seg; markDirty(); setTimeout(draw); });
      b.addEventListener('change', () => { s.end = b.value; delete s.seg; markDirty(); setTimeout(draw); });
      const dsel = multiDay ? daySelect(s.day || 1, (d) => { s.day = d; delete s.seg; resortSlots(rot); changed(); }, `第 ${i + 1} 段在哪一天`) : null;
      if (dsel) dsel.classList.add('rot-day');
      return h('span', { class: 'rot-slot' }, h('b', { text: `第 ${i + 1} 段` }), dsel, a, '–', b, s.seg ? h('span', { class: 'rot-link', title: '取自流程表，改流程表時間會跟著更新', text: `↔ ${s.seg}` }) : null);
    }));
    // 流程表裡的一般環節（多日活動列出每一天，可跨日勾選）：可直接勾選當作輪站時段
    const schedSegs = (c.segments || []).filter((x) => !x.kind);
    const modeOf = (r) => slotModes.get(r.id) || (r.slots.some((x) => x.seg) || (schedSegs.length && !c.rotations?.some((o) => o.id === r.id)) ? 'pick' : 'custom');
    const mode = schedSegs.length ? modeOf(rot) : 'custom';
    const modeBtn = (v, label) => h('button', { type: 'button', role: 'tab', class: 'chip', 'aria-selected': String(mode === v), 'aria-pressed': String(mode === v), onclick: () => { slotModes.set(rot.id, v); draw(); } }, label);
    const picked = new Set(rot.slots.map((x) => x.seg).filter(Boolean));
    const usedElsewhere = new Set(list.filter((o) => o !== rot).flatMap((o) => o.slots.map((x) => x.seg).filter(Boolean)));
    let body;
    if (mode === 'pick') {
      body = h('div', { class: 'stack' },
        h('div', { class: 'muted small', text: '勾選流程表中屬於輪站課程的時段（例如「第一節課」「第二節課」），每個勾選的環節就是一段。之後改流程表的時間，輪站時段會跟著更新。' }),
        ...groupDays(schedSegs).map(([d, segsOfDay]) => h('div', { class: 'stack', style: 'gap:6px' }, d ? h('div', { class: 'small', style: 'font-weight:700', text: dayTxt(d) }) : null,
        h('div', { class: 'rot-picks' }, segsOfDay.map((x) => {
          const on = picked.has(x.name);
          const busy = usedElsewhere.has(x.name);
          return h('button', {
            type: 'button', class: 'rot-pick', 'aria-pressed': String(on), disabled: busy && !on,
            title: busy ? '已用在其他輪站區塊' : '',
            onclick: () => {
              const nextNames = on ? [...picked].filter((n) => n !== x.name) : [...picked, x.name];
              const segs = schedSegs.filter((y) => nextNames.includes(y.name)).sort((a, b) => (a.day || 0) - (b.day || 0) || a.start.localeCompare(b.start));
              if (!segs.length) { toast('至少要選一個時段', 'err'); return; }
              rot.slots = segs.map((y) => (y.day ? { start: y.start, end: y.end, day: y.day, seg: y.name } : { start: y.start, end: y.end, seg: y.name }));
              reAuto(rot); changed();
            },
          }, h('span', { class: 'rot-pick-t', text: `${x.start}–${x.end}` }), h('span', { text: x.title || x.name }), busy && !on ? h('span', { class: 'muted small', text: '（其他區塊）' }) : null);
        })))));
    } else if (mode === 'split') {
      const sel = h('select', { class: 'select', 'aria-label': '要切分的流程表環節' }, schedSegs.map((x) => h('option', { value: x.name, text: `${x.day ? `第${x.day}天 ` : ''}${x.start}–${x.end} ${x.title || x.name}` })));
      const addOn = h('input', { type: 'checkbox' });
      const cnt = h('input', { class: 'input', type: 'number', min: '2', max: '12', value: String(Math.max(rot.rows.length, rot.stations.length) || 5), 'aria-label': '切成幾段' });
      const gp = h('input', { class: 'input', type: 'number', min: '0', max: '60', value: String(gen.gap), 'aria-label': '換站分鐘' });
      body = h('div', { class: 'stack' },
        h('div', { class: 'muted small', text: '流程表只寫了一整段（例如「09:30-12:25 輪站時間」）時，把它平均切成幾段。' }),
        h('div', { class: 'rot-gen' },
          h('label', { class: 'field' }, '流程表環節', sel),
          h('label', { class: 'field' }, '切成幾段', cnt),
          h('label', { class: 'field' }, '換站（分）', gp),
          h('span'),
          h('button', { type: 'button', class: 'btn', text: '切分', onclick: () => {
            const x = schedSegs.find((y) => y.name === sel.value);
            const n = Math.max(1, Math.min(12, Number(cnt.value) || 1));
            const g = Math.max(0, Number(gp.value) || 0);
            const total = toMin(x.end) - toMin(x.start);
            const len = Math.floor((total - g * (n - 1)) / n);
            if (len < 5) { toast('時間不夠切這麼多段', 'err'); return; }
            gen.gap = g;
            const made = makeSlots(x.start, len, g, n).map((y) => (x.day ? { ...y, day: x.day } : y));
            if (addOn.checked) { const k = rot.slots.length; rot.slots = rot.slots.concat(made); rot.rows.forEach((row) => { while (row.cells.length < k) row.cells.push(-1); }); resortSlots(rot); reAuto(rot); }
            else { rot.slots = made; reAuto(rot); }
            changed();
          } })),
        multiDay ? h('label', { class: 'al-check' }, addOn, '接在現有時段後面（跨日：例如先切第 1 天下午，再切第 2 天上午）') : null);
    } else {
      const addOn = h('input', { type: 'checkbox' });
      if (!gen.day) gen.day = 1;
      body = h('div', { class: 'stack' }, h('div', { class: 'rot-gen' },
        multiDay ? h('label', { class: 'field' }, '哪一天', daySelect(gen.day, (d) => { gen.day = d; }, '產生在哪一天')) : null,
        h('label', { class: 'field' }, '開始', gi('start', { type: 'time' })),
        h('label', { class: 'field' }, '每段（分）', gi('len', { type: 'number', min: '5', max: '180' })),
        h('label', { class: 'field' }, '換站（分）', gi('gap', { type: 'number', min: '0', max: '60' })),
        h('label', { class: 'field' }, '段數', gi('count', { type: 'number', min: '1', max: '12' })),
        h('button', { type: 'button', class: 'btn', text: '產生時段', onclick: () => {
          const n = Math.max(1, Math.min(12, gen.count || 1));
          const made = makeSlots(gen.start || '09:30', Math.max(5, gen.len || 25), Math.max(0, gen.gap || 0), n).map((y) => (multiDay ? { ...y, day: gen.day || 1 } : y));
          if (addOn.checked) { rot.slots = rot.slots.concat(made); resortSlots(rot); } else rot.slots = made;
          reAuto(rot); changed();
        } })),
        multiDay ? h('label', { class: 'al-check' }, addOn, '接在現有時段後面（跨日：先產生第 1 天，再選第 2 天產生）') : null);
    }
    const slotSec = h('section', { class: 'stack', 'aria-labelledby': 'rot-slot-h' },
      h('h3', { id: 'rot-slot-h', class: 'h3', text: '1 · 時段' }),
      schedSegs.length ? h('div', { class: 'chips', role: 'tablist', 'aria-label': '時段來源' },
        modeBtn('pick', '從流程表選時段'), modeBtn('split', '切分流程中的一段'), modeBtn('custom', '自訂時段')) : h('div', { class: 'muted small', text: '流程表還沒有時段；先在「活動流程表」輸入流程，就能直接選用。也可以在這裡自訂時段。' }),
      body,
      h('div', { class: 'muted small', text: `建議段數 ${Math.max(rot.rows.length, rot.stations.length)}（＝隊數與關卡數較大者），每隊才能走完全部關卡。換站時間拍的照片算前一段。` }),
      h('div', { class: 'muted small', text: `目前 ${rot.slots.length} 段：` }),
      slotList);

    // ---- 2 關卡 ----
    const stSec = h('section', { class: 'stack', 'aria-labelledby': 'rot-st-h' },
      h('div', { class: 'sec-head' }, h('h3', { id: 'rot-st-h', class: 'h3', text: '2 · 關卡（課程）' }), h('span', { class: 'muted small', text: '課程名稱會成為上傳頁選項與 MV 主題' })),
      rot.stations.map((s, i) => {
        const nm = h('input', { class: 'input', value: s.name, maxlength: '20', 'aria-label': `關卡 ${i + 1} 名稱`, oninput: (e) => { s.name = e.target.value; markDirty(); }, onchange: () => setTimeout(draw) });
        const pl = h('input', { class: 'input', value: s.place, maxlength: '20', placeholder: '場地（選填）', 'aria-label': `關卡 ${i + 1} 場地`, oninput: (e) => { s.place = e.target.value; markDirty(); } });
        return h('div', { class: 'rot-st' }, h('span', { class: 'rot-no', style: `background:${COLORS[i % COLORS.length]}`, text: String(i + 1) }), nm, pl);
      }),
      h('div', { class: 'row' },
        rot.stations.length < 12 ? h('button', { type: 'button', class: 'btn btn-sm', text: '＋ 新增關卡', onclick: () => { rot.stations.push({ name: `關卡${rot.stations.length + 1}`, place: '' }); reAuto(rot); changed(); } }) : null,
        rot.stations.length > 1 ? h('button', { type: 'button', class: 'btn btn-sm', text: '移除最後一個', onclick: () => { rot.stations.pop(); fit(rot); changed(); } }) : null));

    // ---- 3 輪站表 ----
    const inRot = new Set(rot.rows.map((r) => r.group));
    const teamPick = h('div', { class: 'chips', 'aria-label': '參加的小隊' }, groupsAll.map((g) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(inRot.has(g)),
      onclick: () => {
        if (inRot.has(g)) rot.rows = rot.rows.filter((r) => r.group !== g);
        else rot.rows = groupsAll.filter((x) => inRot.has(x) || x === g).map((x) => rot.rows.find((r) => r.group === x) || { group: x, cells: [] });
        reAuto(rot); changed();
      },
    }, g)));
    const nG = rot.rows.length, nS = rot.stations.length;
    const byeLine = nG > nS ? `隊伍比關卡多 ${nG - nS} 隊：每段有 ${nG - nS} 隊輪空，排 ${nG} 段才能讓每隊走完全部關卡。`
      : nG < nS ? `隊伍比關卡少 ${nS - nG} 隊：每段有 ${nS - nG} 個關卡空檔，排 ${nS} 段讓每隊走完全部關卡。`
        : '隊伍數＝關卡數：每段每關剛好一隊。';
    const table = h('table', { class: 'rot-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '小隊 ＼ 時段' }), rot.slots.map((s, i) => h('th', { scope: 'col' }, multiDay && s.day ? [h('span', { class: 'rot-thday', text: `第${s.day}天` }), h('br')] : null, h('b', { text: `第 ${i + 1} 段` }), h('br'), `${s.start}–${s.end}`)))),
      h('tbody', {}, rot.rows.map((r, g) => h('tr', {}, h('th', { scope: 'row', text: r.group }), r.cells.map((v, t) => {
        const bye = v < 0;
        const bad = chk.dup.has(`${g},${t}`);
        const b = h('button', {
          type: 'button', class: `rot-cell${bye ? ' bye' : ''}${bad ? ' bad' : ''}`,
          'aria-label': `${r.group} 第 ${t + 1} 段：${bye ? '輪空' : rot.stations[v].name}，按一下換下一個選項`,
          onclick: () => { r.cells[t] = v === nS - 1 ? -1 : v + 1; changed(); },
        }, bye ? null : h('i', { style: `background:${COLORS[v % COLORS.length]}` }), bye ? '輪空' : rot.stations[v].name);
        if (!bye) b.style.background = SOFTS[v % SOFTS.length];
        return h('td', {}, b);
      })))));
    const pasteBox = h('details', { class: 'pv' }, h('summary', { text: '從 Excel 貼上輪站表' }),
      (() => {
        const ta = h('textarea', { class: 'textarea mono-area', rows: '6', placeholder: '第一欄是小隊、之後每欄一個時段，格子填關卡名稱（空白或「輪空」＝輪空）\n一小隊\t水火箭\t木工\t輪空\n二小隊\t木工\t輪空\t水火箭' });
        return h('div', { class: 'stack', style: 'padding-bottom:12px' }, ta, h('div', {}, h('button', { type: 'button', class: 'btn', text: '套用', onclick: () => {
          const lines = ta.value.split(/\r?\n/).map((l) => l.split('\t').map((x) => x.trim())).filter((x) => x.length > 1 && x[0]);
          const rows = [];
          let missing = [];
          for (const [g, ...cells] of lines) {
            if (!groupsAll.includes(g)) { missing.push(g); continue; }
            const idx = cells.slice(0, rot.slots.length).map((name) => {
              if (!name || name === '輪空') return -1;
              let k = rot.stations.findIndex((s) => s.name === name);
              if (k < 0 && rot.stations.length < 12) { rot.stations.push({ name: name.slice(0, 20), place: '' }); k = rot.stations.length - 1; }
              return k;
            });
            rows.push({ group: g, cells: idx });
          }
          if (!rows.length) { toast('沒有讀到小隊列；第一欄需是小隊名稱，欄位用 Tab 分隔（直接從 Excel 複製即可）', 'err'); return; }
          const maxCols = Math.max(...rows.map((r) => r.cells.length));
          if (maxCols > rot.slots.length) {
            const last = rot.slots[rot.slots.length - 1];
            const len = toMin(last.end) - toMin(last.start);
            for (let i = rot.slots.length; i < maxCols && i < 12; i++) rot.slots.push({ start: fmt(toMin(rot.slots[i - 1].end) + 5), end: fmt(toMin(rot.slots[i - 1].end) + 5 + len) });
          }
          rot.rows = rows;
          fit(rot);
          if (missing.length) toast(`找不到這些小隊，已略過：${missing.join('、')}`, 'err'); else toast(`已套用 ${rows.length} 隊`);
          changed();
        } })));
      })());
    const gridSec = h('section', { class: 'stack', 'aria-labelledby': 'rot-grid-h' },
      h('div', { class: 'sec-head' }, h('h3', { id: 'rot-grid-h', class: 'h3', text: '3 · 輪站表' }),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '依序輪轉自動排', onclick: () => { reAuto(rot); changed(); } })),
      h('div', { class: 'muted small', text: '參加的小隊（點一下加入或移除）：' }), teamPick,
      h('div', { class: 'note', text: byeLine }),
      nG ? h('div', { class: 'scroll-x' }, table) : h('div', { class: 'warn', text: '請至少選一個小隊。' }),
      h('div', { class: 'muted small', text: '點格子換成下一個關卡，最後一個選項是「輪空」。' }),
      chk.issues.length ? h('div', { class: 'warn', role: 'status' }, h('b', { text: '請檢查：' }), chk.issues.map((t) => h('div', { text: `· ${t}` })))
        : nG ? h('div', { class: 'note ok-note', role: 'status', text: '每個時段每個關卡最多一隊，每隊都走過全部關卡。' }) : null,
      chk.idle.length ? h('div', { class: 'note' }, h('b', { text: '關卡空檔' }), '（該段沒有隊伍，關主可休息或支援）：', chk.idle.map((t) => h('div', { text: `· ${t}` }))) : null,
      pasteBox);

    // ---- 輪空照片 ----
    const byeSec = chk.byes ? h('fieldset', { class: 'al-fs rot-bye' }, h('legend', { text: `輪空時段的照片（共 ${chk.byes} 格輪空）` }),
      [['free', '歸到「自由活動」主題', '輪空的隊伍多在休息、拍團體照，MV 可當作過場'], ['skip', '不歸類，交給 AI 判斷', '照片照樣收，MV Studio 看內容決定放在哪裡']].map(([v, label, hint]) => h('label', { class: `al-opt${rot.bye_mode === v ? ' on' : ''}` },
        h('input', { type: 'radio', name: `bye-${rot.id}`, value: v, checked: rot.bye_mode === v, onchange: () => { rot.bye_mode = v; changed(); } }),
        h('span', { class: 'stack', style: 'gap:2px' }, h('b', { text: label }), h('span', { class: 'muted small', text: hint }))))) : null;

    const howSec = h('div', { class: 'grid2 rot-how' },
      h('div', { class: 'note' }, h('b', { text: '跟著小隊走的攝影師' }), h('br'), '上傳時勾小隊：拍攝時間落在哪一段，就依輪站表歸到那一隊當時的課程。'),
      h('div', { class: 'note' }, h('b', { text: '固定守在某一關的攝影師' }), h('br'), '上傳時選關卡：小隊由時段反推。'),
      h('div', { class: 'note full' }, h('b', { text: '沒勾小隊、也沒選關卡' }), h('br'), '同時段有多個課程，無法判斷：先歸到流程表中涵蓋這段時間的環節（例如勾選的「第二節課」，或一整段的「輪站時間」），沒有的話列為未分類，交給 MV Studio 的 AI 看照片內容判斷。'));

    mount(box, tabs, head, slotSec, stSec, gridSec, byeSec, howSec);
  }
  async function remove() {
    const ok = await ctx.ask({ title: '刪除輪站區塊', body: `確定刪除「${list[cur].title}」？按「儲存」後才會生效。`, okLabel: '刪除', danger: true });
    if (!ok) return;
    list.splice(cur, 1);
    cur = Math.max(0, cur - 1);
    changed();
  }

  draw();
  return {
    node: box,
    collect: () => ({ rotations: list.map((r) => ({ ...r, title: r.title.trim() || '輪站課程', stations: r.stations.map((s) => ({ name: s.name.trim(), place: s.place.trim() })) })) }),
    validate: () => {
      for (const r of list) {
        if (r.stations.some((s) => !s.name.trim())) return `「${r.title}」有關卡沒有名稱`;
        const names = r.stations.map((s) => s.name.trim());
        if (new Set(names).size !== names.length) return `「${r.title}」有重複的關卡名稱`;
        if (names.includes('自由活動')) return '關卡名稱不能叫「自由活動」';
        for (let i = 0; i < r.slots.length; i++) {
          const s = r.slots[i];
          if (!s.start || !s.end || s.start >= s.end) return `「${r.title}」第 ${i + 1} 段的時間不正確`;
          const p = r.slots[i - 1];
          if (i && (s.day || 0) === (p.day || 0) && s.start < p.end) return `「${r.title}」第 ${i + 1} 段和前一段重疊`;
          if (i && (s.day || 0) < (p.day || 0)) return `「${r.title}」第 ${i + 1} 段的日期早於前一段`;
        }
      }
      return '';
    },
  };
}
