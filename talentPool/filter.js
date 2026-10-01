/* 人才庫查詢 — 篩選設定頁（全螢幕、大字、即時人數、常用條件） */
'use strict';

const FP = (() => {
  const SECTIONS = [
    { key: 'gender', title: '乾坤', type: 'single', opts: [['乾', '乾道'], ['坤', '坤道']] },
    { key: 'region', title: '區域', type: 'multi', cols: 3 },
    { key: 'age', title: '年齡', type: 'age', hint: '依年次推算；設定後，沒填年次的人不會出現' },
    { key: 'attMin', title: '2026 出席次數', type: 'min', unit: '次', presets: [1, 3, 5, 7, 9], max: 11 },
    { key: 'groups', title: '推薦組別', type: 'multi', cols: 2, mode: true },
    { key: 'spanMin', title: '服務年數', type: 'min', unit: '年', presets: [2, 3, 4, 5], max: 5, hint: '2022–2026 之間有服務紀錄的年份數' },
    { key: 'rank', title: '官方道職', type: 'multi', cols: 2 },
    { key: 'unit', title: '主要處室／單位', type: 'multi', cols: 2 },
    { key: 'act', title: '參與過的項目', type: 'multi', cols: 2, year: true, hint: '例如禮節辦道、忠恕輪值、服務分組' },
    { key: 'src', title: '名冊來源', type: 'single', opts: [['c', '確定名冊'], ['p', '待校核']] },
  ];
  const AGE_PRESETS = [['40 歲以下', '', '40'], ['41–50', '41', '50'], ['51–60', '51', '60'], ['61–70', '61', '70'], ['71 歲以上', '71', '']];
  const DEFAULT_OPEN = ['gender', 'region', 'age', 'attMin', 'groups'];
  const COLLAPSE_AT = 12;
  let open = new Set(LS.get('fpOpen', DEFAULT_OPEN));
  let showAll = new Set();

  const terms = () => S.q.toLowerCase().split(/\s+/).filter(Boolean);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const without = (key) => {
    const f = clone(S.f), e = emptyFilter();
    if (key === 'age') { f.ageMin = ''; f.ageMax = ''; } else f[key] = e[key];
    return f;
  };
  const valuesOf = (key, p) => {
    switch (key) {
      case 'rank': return [p.rank || '（未填）'];
      case 'groups': return p.groups;
      case 'act': return [...actOf(p, S.f.actYear)].filter((s) => s !== '其他');
      default: return [p[key]];
    }
  };
  const countWith = (f) => { const t = terms(); return S.data.people.reduce((n, p) => n + (matches(p, f, t) ? 1 : 0), 0); };

  /* 某欄位所有選項：順序依全體人數，數字＝在「其他條件」下選了它會有幾人 */
  function facet(key) {
    const all = new Map(), cur = new Map(), f = without(key), t = terms();
    for (const p of S.data.people) {
      const vs = valuesOf(key, p).filter(Boolean), ok = matches(p, f, t);
      for (const v of vs) { all.set(v, (all.get(v) || 0) + 1); if (ok) cur.set(v, (cur.get(v) || 0) + 1); }
    }
    return [...all].sort((a, b) => b[1] - a[1]).map(([v]) => [v, cur.get(v) || 0]);
  }

  function summary(sec) {
    const f = S.f;
    switch (sec.type) {
      case 'single': case 'multi': {
        const v = f[sec.key]; if (!v.length) return '';
        const lab = (x) => (sec.opts ? (sec.opts.find((o) => o[0] === x) || [x, x])[1] : x);
        const s = v.map(lab);
        return (s.length > 3 ? s.slice(0, 3).join('、') + ` 等 ${s.length} 項` : s.join('、')) + (sec.mode && v.length > 1 ? (f.groupsMode === 'all' ? '（全部）' : '（任一）') : '');
      }
      case 'age': return ageLabel(f.ageMin, f.ageMax);
      case 'min': return f[sec.key] ? `${f[sec.key]} ${sec.unit}以上` : '';
    }
    return '';
  }
  function ageLabel(a, b) {
    if (a === '' && b === '') return '';
    if (a === '') return `${b} 歲以下`;
    if (b === '') return `${a} 歲以上`;
    return `${a}–${b} 歲`;
  }

  /* ---------- render ---------- */
  function btn(label, on, attrs, n) {
    const zero = n === 0 && !on;
    return `<button class="opt${on ? ' on' : ''}${zero ? ' zero' : ''}" ${attrs} aria-pressed="${on}"><span class="ol">${esc(label)}</span>${n != null ? `<span class="on-n">${n}</span>` : ''}</button>`;
  }
  function stepper(id, val, ph) {
    return `<div class="stp"><button class="sb" data-step="${id}" data-d="-1" aria-label="減少">−</button><input id="${id}" type="number" inputmode="numeric" value="${esc(val)}" placeholder="${ph}"><button class="sb" data-step="${id}" data-d="1" aria-label="增加">＋</button></div>`;
  }
  function body(sec) {
    const f = S.f;
    if (sec.type === 'single') {
      const fc = new Map(facet(sec.key));
      return `<div class="opts c3">${btn('不限', !f[sec.key].length, `data-single="${sec.key}" data-v=""`)}${sec.opts.map(([v, l]) => btn(l, f[sec.key][0] === v, `data-single="${sec.key}" data-v="${esc(v)}"`, fc.get(v) || 0)).join('')}</div>`;
    }
    if (sec.type === 'multi') {
      let items = facet(sec.key);
      const sel = f[sec.key];
      const more = items.length > COLLAPSE_AT && !showAll.has(sec.key);
      const shown = more ? items.filter(([v], i) => i < COLLAPSE_AT || sel.includes(v)) : items;
      let head = '';
      if (sec.year) head += `<div class="row-y"><span>年度</span>${['2026', '2025', '2024', '2023', '2022', 'any'].map((y) => `<button class="yb${f.actYear === y ? ' on' : ''}" data-year="${y}">${y === 'any' ? '任一年' : y}</button>`).join('')}</div>`;
      if (sec.mode) head += `<div class="row-y"><span>多選時</span><button class="yb${f.groupsMode === 'any' ? ' on' : ''}" data-gmode="any">有其中一組即可</button><button class="yb${f.groupsMode === 'all' ? ' on' : ''}" data-gmode="all">每一組都要有</button></div>`;
      return head + `<div class="opts c${sec.cols}">${shown.map(([v, n]) => btn(v, sel.includes(v), `data-multi="${sec.key}" data-v="${esc(v)}"`, n)).join('')}</div>` +
        (items.length > COLLAPSE_AT ? `<button class="morebtn" data-more="${sec.key}">${more ? `顯示全部 ${items.length} 項 ▾` : '收合 ▴'}</button>` : '') +
        (sel.length ? `<button class="morebtn" data-clear="${sec.key}">清除此項（${sel.length}）</button>` : '');
    }
    if (sec.type === 'age') {
      const cur = [f.ageMin, f.ageMax];
      return `<div class="opts c3">${btn('不限', cur[0] === '' && cur[1] === '', 'data-age="" data-a="" data-b=""')}${AGE_PRESETS.map(([l, a, b]) => btn(l, cur[0] === a && cur[1] === b, `data-age="1" data-a="${a}" data-b="${b}"`, countWith({ ...S.f, ageMin: a, ageMax: b }))).join('')}</div>
        <div class="custom age"><span class="cl">自訂年齡（歲，可按 −／＋ 或直接輸入）</span>${stepper('ageMin', f.ageMin, '不限')}<span>到</span>${stepper('ageMax', f.ageMax, '不限')}</div>`;
    }
    if (sec.type === 'min') {
      const v = f[sec.key];
      return `<div class="opts c3">${btn('不限', !v, `data-min="${sec.key}" data-v="0"`)}${sec.presets.map((n) => btn(`${n} ${sec.unit}以上`, v === n, `data-min="${sec.key}" data-v="${n}"`, countWith({ ...S.f, [sec.key]: n }))).join('')}</div>
        <div class="custom"><span class="cl">至少</span>${stepper(sec.key, v || '', '不限')}<span>${sec.unit}</span></div>`;
    }
    return '';
  }
  function presetsHTML() {
    const ps = LS.get('presets', []);
    if (!ps.length) return '';
    return `<section class="fsec pre"><div class="fsh static"><span class="ft">★ 常用條件</span><span class="fv muted">點一下套用</span></div><div class="fsb"><div class="plist">${ps.map((p, i) => `<div class="pitem"><button class="papply" data-preset="${i}"><b>${esc(p.name)}</b><small>${esc(describe(p.f))}</small></button><button class="pdel" data-pdel="${i}" aria-label="刪除 ${esc(p.name)}">✕</button></div>`).join('')}</div></div></section>`;
  }
  function describe(f) {
    const save = S.f; S.f = { ...emptyFilter(), ...f };
    const s = SECTIONS.map((sec) => { const t = summary(sec); return t ? `${sec.title}：${t}` : ''; }).filter(Boolean).join('；');
    S.f = save; return s || '不限';
  }
  function render() {
    const bodyEl = $('#fpBody'), st = bodyEl.scrollTop;
    bodyEl.innerHTML = presetsHTML() + SECTIONS.map((sec) => {
      const isOpen = open.has(sec.key), sum = summary(sec);
      return `<section class="fsec${sum ? ' set' : ''}">
        <button class="fsh" data-toggle="${sec.key}" aria-expanded="${isOpen}"><span class="ft">${sec.title}</span><span class="fv">${sum ? esc(sum) : '<span class="muted">不限</span>'}</span><span class="car">${isOpen ? '▴' : '▾'}</span></button>
        ${isOpen ? `<div class="fsb">${sec.hint ? `<p class="hint">${sec.hint}</p>` : ''}${body(sec)}</div>` : ''}
      </section>`;
    }).join('');
    bodyEl.scrollTop = st;
    updateCount();
  }
  function updateCount() {
    const n = countWith(S.f), fc = filterCount();
    $('#fpCount').textContent = n;
    $('#fpOf').textContent = `/ ${S.data.people.length} 人`;
    $('#fpApply').textContent = n ? `查看 ${n} 位人選` : '沒有符合的人選';
    $('#fpApply').disabled = !n;
    $('#fpReset').disabled = !fc;
    $('#fpSave').disabled = !fc;
    $('#fpSearch').textContent = S.q ? `（含搜尋「${S.q}」）` : '';
  }

  /* ---------- actions ---------- */
  function set(fn) { fn(S.f); render(); }
  function toNum(v) { v = String(v).trim(); if (v === '') return ''; const n = Math.max(0, Math.min(120, parseInt(v, 10) || 0)); return String(n); }

  function onClick(e) {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.toggle) { open.has(d.toggle) ? open.delete(d.toggle) : open.add(d.toggle); LS.set('fpOpen', [...open]); render(); return; }
    if (d.single !== undefined) return set((f) => { f[d.single] = d.v ? [d.v] : []; });
    if (d.multi) return set((f) => { const a = f[d.multi]; f[d.multi] = a.includes(d.v) ? a.filter((x) => x !== d.v) : [...a, d.v]; });
    if (d.clear) return set((f) => { f[d.clear] = []; });
    if (d.more) { showAll.has(d.more) ? showAll.delete(d.more) : showAll.add(d.more); render(); return; }
    if (d.year) return set((f) => { f.actYear = d.year; f.act = []; });
    if (d.gmode) return set((f) => { f.groupsMode = d.gmode; });
    if (d.age !== undefined) return set((f) => { f.ageMin = d.a; f.ageMax = d.b; });
    if (d.min) return set((f) => { f[d.min] = +d.v; });
    if (d.step) {
      const id = d.step, dir = +d.d;
      return set((f) => {
        if (id === 'ageMin' || id === 'ageMax') {
          const cur = f[id] === '' ? (id === 'ageMin' ? 40 : 60) - dir : +f[id];
          let n = Math.max(1, Math.min(110, cur + dir));
          if (id === 'ageMin' && f.ageMax !== '' && n > +f.ageMax) n = +f.ageMax;
          if (id === 'ageMax' && f.ageMin !== '' && n < +f.ageMin) n = +f.ageMin;
          f[id] = String(n);
        } else {
          const sec = SECTIONS.find((s) => s.key === id);
          f[id] = Math.max(0, Math.min(sec.max, (f[id] || 0) + dir));
        }
      });
    }
    if (d.preset !== undefined) { const p = LS.get('presets', [])[+d.preset]; if (p) { applyPreset(p); toast(`已套用「${p.name}」`); render(); } return; }
    if (d.pdel !== undefined) {
      const ps = LS.get('presets', []); const p = ps[+d.pdel];
      if (p && confirm(`刪除常用條件「${p.name}」？`)) { ps.splice(+d.pdel, 1); LS.set('presets', ps); render(); renderPresetRow(); }
    }
  }
  function onChange(e) {
    const id = e.target.id; if (!id) return;
    if (id === 'ageMin' || id === 'ageMax') set((f) => { f[id] = toNum(e.target.value); });
    else if (id === 'attMin' || id === 'spanMin') { const sec = SECTIONS.find((s) => s.key === id); set((f) => { f[id] = Math.min(sec.max, +toNum(e.target.value) || 0); }); }
  }
  function applyPreset(p) { S.f = { ...emptyFilter(), ...clone(p.f) }; }
  function savePreset() {
    const name = (prompt('幫這組條件取個名字（例：內湖坤道 40–60 歲）', '') || '').trim();
    if (!name) return;
    const ps = LS.get('presets', []).filter((p) => p.name !== name);
    ps.unshift({ name, f: clone(S.f) }); LS.set('presets', ps.slice(0, 12));
    toast(`已存成常用條件「${name}」`); render(); renderPresetRow();
  }

  /* ---------- page open / close ---------- */
  function openPage() {
    showAll = new Set();
    $('#filterPage').classList.remove('hidden'); document.body.style.overflow = 'hidden';
    history.pushState({ fp: 1 }, '');
    render(); $('#fpBody').scrollTop = 0;
  }
  function closePage(fromPop) {
    if ($('#filterPage').classList.contains('hidden')) return;
    $('#filterPage').classList.add('hidden'); document.body.style.overflow = '';
    if (!fromPop && history.state && history.state.fp) history.back();
    renderList(); window.scrollTo({ top: 0 });
  }

  /* 主畫面的常用條件列 */
  function renderPresetRow() {
    const row = $('#presetRow'); if (!row) return;
    const ps = LS.get('presets', []);
    row.innerHTML = ps.map((p, i) => `<button data-mpreset="${i}">★ ${esc(p.name)}</button>`).join('');
    row.classList.toggle('hidden', !ps.length);
  }

  function bind() {
    $('#fpBody').addEventListener('click', onClick);
    $('#fpBody').addEventListener('change', onChange);
    $('#fpBody').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });
    $('#fpBack').onclick = () => closePage();
    $('#fpApply').onclick = () => closePage();
    $('#fpReset').onclick = () => { const keep = S.f.actYear; S.f = emptyFilter(); S.f.actYear = keep; render(); };
    $('#fpSave').onclick = savePreset;
    window.addEventListener('popstate', () => closePage(true));
    $('#presetRow').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mpreset]'); if (!b) return;
      const p = LS.get('presets', [])[+b.dataset.mpreset]; if (!p) return;
      applyPreset(p); renderList(); toast(`已套用「${p.name}」`);
    });
  }
  return { bind, openPage, closePage, renderPresetRow };
})();
