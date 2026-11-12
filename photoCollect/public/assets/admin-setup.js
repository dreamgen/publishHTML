// 「準備中心」分頁：五階段、必填提醒、七個項目與編輯區
import {
  h, mount, STAGES, parseSchedule, isoToLocalInput, localInputToIso, fmtDateTime,
  copyText, flashLabel, toast, autoInvite, dateRangeText, groupByDay,
} from './admin-common.js';
import { generateCard } from './admin-card.js';
import { edRotation } from './admin-rotation.js';

const ITEMS = [
  { key: 'basic', title: '基本資料', sub: '名稱、日期、地點', kind: '基本', affects: '上傳頁標題、片頭片尾圖卡' },
  { key: 'schedule', title: '活動流程表', sub: '時段與環節', kind: '建議補上', affects: '上傳頁的環節選項、照片依拍攝時間分類、MV 主題' },
  { key: 'rotation', title: '輪站課程', sub: '多場地同時上課、小隊換關卡', kind: '選填', affects: '同一時段多個課程時，照片依小隊＋時段歸到正確的課程；課程成為 MV 主題' },
  { key: 'groups', title: '小隊與人員名單', sub: '分組確定後再補', kind: '選填', affects: '上傳頁的小隊勾選、入鏡平均度檢查' },
  { key: 'shots', title: '拍攝清單', sub: '每個環節要拍什麼、幾張', kind: '建議補上', affects: '上傳完成頁的「還缺什麼」提示' },
  { key: 'upload', title: '上傳設定與告知', sub: '開放時間、保存期限、告知文字', kind: '開放前必填', affects: '上傳頁何時開放、何時自動刪除' },
  { key: 'invite', title: '邀請與宣傳', sub: 'QR Code、海報、LINE 公告', kind: '選填', affects: '大家怎麼找到上傳頁' },
  { key: 'mv', title: 'MV 製作者與歌曲', sub: '可提早安裝與對齊歌詞', kind: '選填', affects: '活動後多快能出片' },
];
const TITLE_OF = Object.fromEntries(ITEMS.map((i) => [i.key, i.title]));

/** 欄位：外層 label 包住輸入元件 */
function field(label, control, cls = '') {
  return h('label', { class: `field ${cls}` }, label, control);
}
const input = (type, value, attrs = {}) => {
  const e = h('input', { class: 'input', type, ...attrs });
  e.value = value ?? '';
  return e;
};

// ---------- QR Code ----------
function qrObj(url) {
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr;
}
/** 以 DOMParser 解析函式庫產生的 SVG（不經 innerHTML） */
export function qrSvgNode(url, label) {
  const svgText = qrObj(url).createSvgTag({ cellSize: 8, margin: 4, scalable: true, alt: label || '上傳頁 QR Code' });
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}
function qrPngBlob(url) {
  const qr = qrObj(url);
  const n = qr.getModuleCount();
  const cell = 12, margin = cell * 4, size = n * cell + margin * 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect(margin + c * cell, margin + r * cell, cell, cell);
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

/** 取代告知文字中的 {delete_date} */
function noticeText(cfg, deleteAt) {
  const n = cfg.upload?.notice || '';
  const date = deleteAt ? fmtDateTime(deleteAt).slice(0, 10) : '（刪除日）';
  return n.replaceAll('{delete_date}', date);
}

/** LINE 公告文案：開頭用邀請文字（可傳入輸入中的文字即時更新），接著上傳連結與開放／刪除時間 */
export function lineMessage(ctx, message) {
  const c = ctx.cfg, d = ctx.data;
  const head = message || d.invite_effective?.message || autoInvite(c).message;
  const lines = [head, ctx.uploadUrl()];
  if (c.upload?.closes_at) {
    lines.push(`開放到 ${fmtDateTime(c.upload.closes_at)}${d.delete_at ? `，照片會在 ${fmtDateTime(d.delete_at).slice(0, 10)} 刪除` : ''}。`);
  } else if (c.upload?.opens_at) {
    lines.push(`${fmtDateTime(c.upload.opens_at)} 開放上傳。`);
  }
  return lines.join('\n');
}

export function renderSetup(ctx, panel) {
  let cur = 0;
  let dirty = false;
  let editor = null; // { key, node, collect(), noSave }

  const stageBox = h('section', { class: 'card scroll-x', 'aria-label': '活動階段' });
  const mustBox = h('div');
  const nav = h('nav', { class: 'item-nav', 'aria-label': '準備項目' });
  const detail = h('section', { class: 'card editor', 'aria-labelledby': 'detail-h' });
  mount(panel, stageBox, mustBox, h('div', { class: 'setup-grid' }, nav, detail));

  // ---- 階段、必填提醒、項目清單 ----
  function renderStages() {
    const idx = Math.max(0, STAGES.findIndex((s) => s.key === ctx.data.stage));
    mount(stageBox, h('ol', { class: 'stages' }, STAGES.map((s, i) =>
      h('li', { class: i < idx ? 'past' : i === idx ? 'now' : '', ...(i === idx ? { 'aria-current': 'step' } : {}) },
        h('div', { class: 'sbar' }),
        h('div', { class: 'sname' }, h('span', { text: s.name }), i === idx ? h('span', { class: 'now-badge', text: '現在' }) : null),
        h('div', { class: 'sdesc', text: s.desc })))));
  }
  function renderMust() {
    const miss = ctx.data.must_missing || [];
    if (!miss.length) {
      mount(mustBox, h('div', { class: 'note', text: '開放上傳前的必填項目都完成了。其他項目隨時都能補，補了會立刻反映在上傳頁。' }));
      return;
    }
    mount(mustBox, h('div', { class: 'warn must-bar' },
      h('div', {}, '開放上傳前還有 ', h('b', { text: `${miss.length} 項必填` }), `：${miss.map((k) => TITLE_OF[k] || k).join('、')}。其他項目隨時都能補，補了會立刻反映在上傳頁。`)));
  }
  function renderNav() {
    const done = ctx.cfg.checklist_done || {};
    const miss = ctx.data.must_missing || [];
    mount(nav, ITEMS.map((it, i) => {
      let tag = [it.kind, ''];
      if (done[it.key]) tag = ['已完成', 'tag-ok'];
      else if (miss.includes(it.key)) tag = ['開放前必填', 'tag-warn'];
      else if (it.key === 'upload') tag = ['已設定', 'tag-ok'];
      else if (it.kind === '建議補上') tag = [it.kind, 'tag-ok'];
      const b = h('button', { type: 'button', class: 'item-btn', 'aria-current': String(i === cur) },
        h('span', { class: `item-dot${done[it.key] ? ' done' : ''}`, 'aria-hidden': 'true', text: done[it.key] ? '✓' : '' }),
        h('span', { class: 'item-text' }, h('b', { text: it.title }), h('small', { text: it.sub })),
        h('span', { class: `tag ${tag[1]}`, text: tag[0] }));
      b.addEventListener('click', () => go(i));
      return b;
    }));
  }

  // ---- 儲存／切換 ----
  async function save(extra = {}) {
    const ed = editor;
    const patch = { ...(ed.collect ? ed.collect() : {}), ...extra };
    const err = ed.validate?.();
    if (err) { toast(err, 'err'); throw new Error(err); }
    // 預覽圖要先上傳（此時 dirty 仍為 true，回應不會重建編輯區）；失敗就整個中止
    try { await ed.beforeSave?.(); } catch (e) { toast(`預覽圖儲存失敗：${e.message}`, 'err'); throw e; }
    const oldBasic = { ...(ctx.cfg.basic || {}) };
    const prev = dirty;
    dirty = false;
    try { await ctx.patch(patch); } catch (e) { dirty = prev; throw e; }
    // 基本資料改了，而且卡片是自動產生的（不是使用者的封面照片）→ 重產並上傳
    const nb = ctx.cfg.basic || {};
    if (ed.key === 'basic' && ctx.cfg.invite?.card_auto
      && (nb.name !== oldBasic.name || nb.date !== oldBasic.date || nb.end_date !== oldBasic.end_date || nb.location !== oldBasic.location)) {
      try { await putCard(await generateCard({ name: nb.name, date: dateRangeText(nb), location: nb.location }), true); toast('預覽圖已依新的基本資料更新'); } catch (e) { toast(`預覽圖更新失敗：${e.message}`, 'err'); }
    }
  }
  /** 上傳預覽圖（auto = 系統自動產生的無照片樣式）；回應是完整的管理資料 */
  async function putCard({ blob }, auto) {
    const d = await ctx.api(`/og-card?auto=${auto ? 1 : 0}`, { method: 'PUT', body: blob });
    ctx.apply(d, 'card');
  }
  async function go(i) {
    if (i === cur) return;
    if (dirty) {
      try { await save(); } catch { return; }
    }
    cur = i;
    dirty = false;
    renderNav();
    buildEditor(true);
  }

  function buildEditor(focus = false) {
    const it = ITEMS[cur];
    const builders = { basic: edBasic, schedule: edSchedule, rotation: () => edRotation(ctx, { markDirty }), groups: edGroups, shots: edShots, upload: edUpload, invite: edInvite, mv: edMv };
    editor = builders[it.key]();
    editor.key = it.key;
    const done = !!ctx.cfg.checklist_done?.[it.key];
    const heading = h('h2', { id: 'detail-h', class: 'h2', tabindex: '-1', text: it.title });
    const actions = h('div', { class: 'editor-actions' },
      editor.noSave ? null : h('button', { type: 'button', class: 'btn btn-primary', text: '儲存', onclick: () => save().catch(() => {}) }),
      h('button', { type: 'button', class: editor.noSave ? 'btn btn-primary' : 'btn', text: done ? '已完成（點此取消）' : '標記為完成',
        onclick: () => save({ checklist_done: { ...ctx.cfg.checklist_done, [it.key]: !done } }).catch(() => {}) }),
      h('button', { type: 'button', class: 'btn', text: '之後再補，看下一項', onclick: () => go((cur + 1) % ITEMS.length) }));
    mount(detail, h('div', { class: 'stack', style: 'gap:4px' }, heading, h('div', { class: 'muted small', text: `影響：${it.affects}` })), editor.node, actions);
    if (focus) heading.focus();
  }
  function markDirty() { dirty = true; }
  // 只有可儲存的編輯器才追蹤未儲存的修改
  detail.addEventListener('input', () => { if (editor && !editor.noSave) markDirty(); });

  // ============ 各項目編輯器 ============
  function edBasic() {
    const b = ctx.cfg.basic || {};
    const name = input('text', b.name, { maxlength: 60, required: true });
    const date = input('date', b.date || '');
    const end = input('date', b.end_date || '', { 'aria-describedby': 'end-hint' });
    const loc = input('text', b.location, { placeholder: '可之後再填', maxlength: 80 });
    const org = input('text', b.organizer, { placeholder: '可之後再填', maxlength: 60 });
    const syncMin = () => { end.min = date.value || ''; };
    date.addEventListener('input', syncMin);
    syncMin();
    return {
      node: h('div', { class: 'grid2' }, field('活動名稱', name), field('地點', loc),
        field('開始日期', date),
        h('label', { class: 'field' }, '結束日期', end, h('span', { id: 'end-hint', class: 'small muted', style: 'font-weight:400', text: '單日活動留空；多日活動填最後一天' })),
        field('主辦單位', org)),
      collect: () => ({ basic: { ...b, name: name.value.trim(), date: date.value || null, end_date: end.value && end.value !== date.value ? end.value : null, location: loc.value.trim(), organizer: org.value.trim() } }),
      validate: () => {
        if (!name.value.trim()) return '活動名稱不能空白';
        if (end.value && !date.value) return '請先填開始日期';
        if (end.value && date.value && end.value < date.value) return '結束日期不能早於開始日期';
        return '';
      },
    };
  }

  function edSchedule() {
    const c = ctx.cfg;
    const multiDay = !!c.basic?.end_date;
    const ta = h('textarea', {
      class: 'textarea mono-area', id: 'sched', rows: multiDay ? '12' : '8',
      placeholder: multiDay ? '11/20（六）\n09:00-09:30 報到相見歡\n10:30-12:00 闖關遊戲\n\n11/21（日）\n09:00-10:00 晨間活動\n10:00-11:30 成果發表' : '09:00-09:30 報到相見歡\n10:30-12:00 闖關遊戲',
    });
    ta.value = c.schedule_text || '';
    const chips = h('div', { class: 'stack', style: 'gap:10px', 'aria-live': 'polite' });
    const count = h('span', { class: 'small muted' });
    const bad = h('div', { class: 'warn', role: 'status', hidden: true });
    const dayWarn = h('div', { class: 'warn', role: 'status', hidden: true });
    const chip = (s) => h('span', { class: 'seg-chip' }, h('span', { class: 't', text: `${s.start}-${s.end}` }), ` ${s.title || s.name}`, s.rotation_slot ? h('span', { class: 'small muted', text: '（輪站時段）' }) : null);
    function paintSegs(segments) {
      const groups = groupByDay(segments);
      const days = groups.filter((g) => g.day).length;
      count.textContent = `已辨識 ${segments.length} 個環節${days ? `（${days} 天）` : ''}，會成為上傳頁的選項與 MV 主題`;
      mount(chips, groups.map((g) => (g.label
        ? h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'small', style: 'font-weight:700', text: g.label }), h('div', { class: 'chips' }, g.items.map(chip)))
        : h('div', { class: 'chips' }, g.items.map(chip)))));
      // 多日流程表卻沒有日期：照片只能靠時間判斷，同時段的不同天會分不出來
      const noDate = days > 1 && segments.some((s) => s.day && !s.date);
      dayWarn.hidden = !noDate && !(multiDay && days < 2 && segments.length);
      dayWarn.textContent = noDate
        ? '流程表用「Day 1／第一天」標示，但還沒填活動開始日期，照片無法依拍攝日期分到正確的那一天。請到「基本資料」填開始日期。'
        : '基本資料是多日活動，但流程表還沒分天。請在每天的流程前加一行日期（例如「11/20」或「Day 1」）。';
    }
    function preview() {
      const { segments, ignored } = parseSchedule(ta.value, c.basic?.date || null);
      paintSegs(segments);
      bad.hidden = !ignored.length;
      bad.textContent = ignored.length ? `有 ${ignored.length} 行格式不符或名稱重複，儲存時會被忽略：${ignored.map((x) => `「${x}」`).join(' ')}。正確格式如「09:00-09:30 報到相見歡」；多日活動的日期標題如「11/20」「Day 2」「第二天」。` : '';
    }
    // 初次顯示以伺服器確認的環節為準（輪站課程的關卡另在「輪站課程」設定）
    paintSegs((c.segments || []).filter((s) => !s.kind));
    ta.addEventListener('input', preview);

    // 貼上手冊文字的輔助
    const hb = h('textarea', { class: 'textarea', rows: '6', id: 'handbook', placeholder: '把活動手冊裡的流程文字貼在這裡' });
    const sugBox = h('div', { class: 'chips' });
    const sugWrap = h('div', { class: 'stack', hidden: true }, h('div', { class: 'small muted', text: '偵測到可能的小隊名稱，要加入名單嗎？（儲存到「小隊與人員名單」）' }), sugBox);
    const hbMsg = h('div', { class: 'small muted', role: 'status' });
    let suggestions = [];
    function renderSug() {
      sugWrap.hidden = !suggestions.length;
      mount(sugBox, suggestions.map((g) => h('button', { type: 'button', class: 'chip', text: `加入「${g}」`, onclick: async () => {
        const next = [...(ctx.cfg.groups || []), g];
        try { await ctx.patch({ groups: next }, { quiet: true }); toast(`已加入小隊：${g}`); suggestions = suggestions.filter((x) => x !== g); renderSug(); } catch { /* 已 toast */ }
      } })));
    }
    const parseBtn = h('button', { type: 'button', class: 'btn', text: '抓出時段與小隊，加入流程表', onclick: () => {
      const text = hb.value;
      const start = c.basic?.date || null;
      const found = parseSchedule(text, start).segments;
      const have = new Set(parseSchedule(ta.value, start).segments.map((s) => s.name));
      const add = found.filter((s) => !have.has(s.name));
      if (add.length) {
        const sep = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
        // 多日手冊：保留日期標題（有日期寫 M/D，否則寫「第N天」）
        const lines = [];
        for (const g of groupByDay(add)) {
          if (g.day) lines.push(g.date ? `${Number(g.date.slice(5, 7))}/${Number(g.date.slice(8, 10))}` : `第${g.day}天`);
          lines.push(...g.items.map((s) => `${s.start}-${s.end} ${s.title || s.name}`));
        }
        ta.value += sep + lines.join('\n') + '\n';
        markDirty(); preview();
      }
      const re = /第[一二三四五六七八九十百零〇\d]+(?:小隊|組|隊)|[一二三四五六七八九十\d]+(?:組|隊)/g;
      const names = [...new Set(text.match(re) || [])];
      const exist = new Set(ctx.cfg.groups || []);
      suggestions = names.filter((n) => !exist.has(n));
      renderSug();
      hbMsg.textContent = `找到 ${found.length} 行時段（新增 ${add.length} 行到流程表，重複的已略過），${names.length} 個可能的小隊名稱。記得按「儲存」。`;
    } });
    const hbBox = h('details', { class: 'pv' },
      h('summary', { text: '從活動手冊貼上文字（輔助）' }),
      h('div', { class: 'stack', style: 'padding-bottom:12px' },
        h('div', { class: 'small muted', text: '直接複製手冊（Word／PDF）裡的流程文字貼上，會挑出符合「時間-時間 名稱」的行加進上方流程表。' }),
        hb, h('div', {}, parseBtn), hbMsg, sugWrap));

    return {
      node: h('div', { class: 'stack' },
        h('label', { for: 'sched', class: 'field' }, '貼上流程表（每行「時間 環節名稱」）'),
        h('div', { class: 'small muted', text: '多日活動：每天的流程前加一行日期，例如「11/20（六）」「Day 2」「第二天」；環節會自動變成「第1天・報到」「第2天・報到」，各天分開計算。' }),
        ta, count, chips, dayWarn, bad, hbBox,
        h('div', { class: 'note', text: '流程改了也沒關係：照片只記錄拍攝時間，環節是在 MV Studio 同步時才依最新流程表判斷，所以活動當天臨時調整時段，事後改流程表即可。' })),
      collect: () => ({ schedule_text: ta.value }),
    };
  }

  function edGroups() {
    let list = [...(ctx.cfg.groups || [])];
    const box = h('div', { class: 'chips' });
    const add = input('text', '', { maxlength: 20, placeholder: '例如：第一小隊', 'aria-label': '新增小隊名稱' });
    function draw() {
      mount(box, list.map((g, i) => h('span', { class: 'grp-chip' }, h('span', { text: g }),
        h('button', { type: 'button', 'aria-label': `刪除 ${g}`, text: '×', onclick: () => { list.splice(i, 1); markDirty(); draw(); } }))),
        list.length ? null : h('span', { class: 'muted', text: '還沒有小隊。' }));
    }
    function addOne() {
      const v = add.value.trim().slice(0, 20);
      if (!v) return;
      if (list.includes(v)) { toast('已經有這個小隊了', 'err'); return; }
      if (list.length >= 30) { toast('最多 30 個小隊', 'err'); return; }
      list.push(v); add.value = ''; markDirty(); draw(); add.focus();
    }
    add.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } });
    draw();
    return {
      node: h('div', { class: 'stack' }, box,
        h('div', { class: 'row' }, add, h('button', { type: 'button', class: 'btn', text: '新增小隊', onclick: addOne })),
        h('div', { class: 'muted small', text: '小隊名單會出現在上傳頁讓攝影師勾選，也用來檢查每隊入鏡是否平均。分組確定前可以先空著，上傳頁就不顯示這一題。' })),
      collect: () => ({ groups: list }),
    };
  }

  function edShots() {
    const shots = (ctx.cfg.shots || []).map((s) => ({ ...s }));
    const rows = shots.map((s) => {
      const tip = input('text', s.tip, { maxlength: 60, placeholder: '重點畫面（選填）', 'aria-label': `${s.segment} 的重點畫面` });
      const tgt = input('number', s.target, { min: '0', max: '999', inputmode: 'numeric', 'aria-label': `${s.segment} 的目標張數` });
      s._tip = tip; s._tgt = tgt;
      return h('div', { class: 'shot-row' },
        h('div', { class: 'name' }, h('span', { text: s.segment }), s.source === 'mv' ? h('span', { class: 'tag tag-ok', text: 'MV 需求' }) : null),
        h('label', { class: 'shot-target' }, '目標', tgt, '張'),
        h('div', { class: 'tip' }, tip));
    });
    return {
      node: h('div', { class: 'stack' },
        rows.length ? rows : h('div', { class: 'card muted', text: '還沒有拍攝清單。先到「活動流程表」輸入流程，這裡會依環節自動產生。' }),
        h('div', { class: 'muted small', text: '依流程表自動產生。MV 製作者選定歌曲、完成內容規劃後，目標張數會改成 MV 實際需要的數量（標示「MV 需求」）。' })),
      collect: () => ({ shots: shots.map((s) => ({ segment: s.segment, source: s.source, tip: s._tip.value.trim(), target: Math.max(0, Math.round(Number(s._tgt.value) || 0)) })) }),
      noSave: !rows.length,
    };
  }

  function edUpload() {
    const u = ctx.cfg.upload || {};
    const opens = input('datetime-local', isoToLocalInput(u.opens_at));
    const closes = input('datetime-local', isoToLocalInput(u.closes_at));
    const ret = h('select', { class: 'select' });
    const rets = [...new Set([30, 60, 90, u.retention_days].filter(Boolean))].sort((a, b) => a - b);
    for (const n of rets) ret.append(h('option', { value: String(n), text: `活動結束後 ${n} 天刪除` }));
    ret.value = String(u.retention_days || 30);
    const mb = h('select', { class: 'select' });
    for (const n of [...new Set([30, 15, u.max_mb].filter(Boolean))].sort((a, b) => b - a)) mb.append(h('option', { value: String(n), text: `${n} MB` }));
    mb.value = String(u.max_mb || 30);
    const mode = h('select', { class: 'select' },
      h('option', { value: 'auto', text: '自動（依開放時間與截止時間）' }),
      h('option', { value: 'open', text: '手動開放（立刻開放，不看時間）' }),
      h('option', { value: 'closed', text: '手動關閉（停止上傳）' }));
    mode.value = u.mode || 'auto';
    const notice = h('textarea', { class: 'textarea', rows: '4', maxlength: '300' });
    notice.value = u.notice || '';
    const cnt = h('span', { class: 'small muted' });
    const upd = () => { cnt.textContent = `${notice.value.length} / 300 字`; };
    notice.addEventListener('input', upd); upd();
    const imp = h('input', { type: 'checkbox' });
    imp.checked = u.import_enabled !== false;
    const impRow = h('label', { class: 'field full', style: 'flex-direction:row;align-items:center;gap:10px' }, imp,
      h('span', {}, '允許貼 Google 相簿／雲端硬碟分享連結匯入', h('br'), h('span', { class: 'small muted', text: '攝影師的照片若已在雲端，貼連結就能整批匯入，不用先下載到手機。' })));
    const info = h('div', { class: 'note' });
    const d = ctx.data;
    info.textContent = d.delete_at ? `目前設定下，照片會在 ${fmtDateTime(d.delete_at).slice(0, 10)} 自動刪除。` : '還沒設定截止時間，照片不會自動刪除（可到「安全與保存」手動刪除）。';
    return {
      node: h('div', { class: 'stack' },
        h('div', { class: 'grid2' },
          field('開始開放', opens), field('截止', closes), field('照片保存', ret), field('單張上限', mb),
          field('上傳模式', mode, 'full'),
          impRow,
          h('label', { class: 'field full' }, '上傳前告知文字（需主辦單位確認）', notice,
            h('span', { class: 'small muted' }, '文字中的 {delete_date} 會自動代入實際刪除日期。 ', cnt))),
        info,
        h('div', { class: 'small muted', text: '時間以你目前瀏覽器的時區為準。開始開放設在過去的時間，儲存後（自動模式）就會立刻開放上傳。' })),
      collect: () => ({ upload: { ...u, opens_at: localInputToIso(opens.value), closes_at: localInputToIso(closes.value), retention_days: Number(ret.value), max_mb: Number(mb.value), notice: notice.value.trim(), mode: mode.value, import_enabled: imp.checked } }),
      validate: () => {
        if (opens.value && closes.value && new Date(closes.value) <= new Date(opens.value)) return '截止時間必須晚於開始開放時間';
        return '';
      },
    };
  }

  function edInvite() {
    const url = ctx.uploadUrl();
    const inv = ctx.cfg.invite || {};
    const auto = autoInvite(ctx.cfg);
    const eff = ctx.data.invite_effective || {};
    const b = ctx.cfg.basic || {};

    // ---- 連結預覽（仿 LINE 聊天室的預覽卡） ----
    // 兩種樣式：大圖（1.91:1）與小縮圖（右側正方形，LINE 常見；用 object-fit: cover 置中裁切模擬）
    const lcUrl = h('div', { class: 'lc-bubble' });
    const lcImg = h('img', { class: 'lc-img', alt: '分享預覽圖（大圖）' });
    const lcTitle = h('div', { class: 'lc-title' });
    const lcDesc = h('div', { class: 'lc-desc' });
    const card = h('div', { class: 'lc-card' }, lcImg, h('div', { class: 'lc-body' }, lcTitle, lcDesc, h('div', { class: 'lc-host', text: location.host })));
    const stage = h('div', { class: 'lc-stage', role: 'group', 'aria-label': '大圖預覽（模擬 LINE）' }, lcUrl, card);
    const lcUrl2 = h('div', { class: 'lc-bubble' });
    const lcImg2 = h('img', { class: 'lc-thumb', alt: '分享預覽圖（小縮圖）' });
    const lcTitle2 = h('div', { class: 'lc-title' });
    const lcDesc2 = h('div', { class: 'lc-desc' });
    const card2 = h('div', { class: 'lc-card lc-card-row' },
      h('div', { class: 'lc-body' }, lcTitle2, lcDesc2, h('div', { class: 'lc-host', text: location.host })), lcImg2);
    const stage2 = h('div', { class: 'lc-stage', role: 'group', 'aria-label': '小縮圖預覽（模擬 LINE）' }, lcUrl2, card2);

    // 伺服器上的預覽圖（同源相對路徑，符合 CSP img-src 'self'）
    let serverImg = '';
    try { const u = new URL(eff.image_url, location.href); serverImg = u.pathname + u.search; } catch { serverImg = '/assets/og-default.png'; }
    let pending = null; // { blob, auto, file, url }：已產生、尚未儲存的預覽圖

    const title = input('text', inv.title, { maxlength: 40, placeholder: auto.title, id: 'inv-title' });
    const msg = h('textarea', { class: 'textarea', rows: '3', maxlength: '120', id: 'inv-msg', placeholder: auto.message });
    msg.value = inv.message || '';
    const cnt = h('span', { class: 'small muted' });
    const file = h('input', { type: 'file', accept: 'image/*', class: 'input', id: 'inv-photo' });
    const clearBtn = h('button', { type: 'button', class: 'btn', text: '清除照片', hidden: true });
    const genBtn = h('button', { type: 'button', class: 'btn btn-primary', text: '產生預覽圖' });
    const status = h('div', { class: 'small muted', role: 'status' });

    function refresh() {
      const t = title.value.trim() || auto.title;
      const m = msg.value.trim() || auto.message;
      lcUrl.textContent = url;
      lcTitle.textContent = t;
      lcDesc.textContent = m;
      lcImg.src = pending ? pending.url : serverImg;
      lcImg2.src = lcImg.src;
      lcUrl2.textContent = url; lcTitle2.textContent = t; lcDesc2.textContent = m;
      cnt.textContent = `${Array.from(msg.value).length} / 120 字`;
    }
    async function make(photo) {
      const r = await generateCard({ name: b.name, date: dateRangeText(b), location: b.location, photo });
      if (pending) URL.revokeObjectURL(pending.url);
      pending = { blob: r.blob, auto: !photo, file: photo || null, url: URL.createObjectURL(r.blob) };
      refresh();
      return pending;
    }
    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      status.textContent = '產生中…';
      try {
        const p = await make(file.files[0] || null);
        status.textContent = `已產生預覽圖（${p.blob.type === 'image/png' ? 'PNG' : 'JPEG'}，${Math.round(p.blob.size / 1024)} KB）。按「儲存」後才會生效。`;
        markDirty();
      } catch (e) {
        status.textContent = '';
        toast(e.message || '產生預覽圖失敗', 'err');
      } finally { genBtn.disabled = false; }
    });
    file.addEventListener('change', () => {
      clearBtn.hidden = !file.files.length;
      status.textContent = file.files.length ? '已選擇封面照片，按「產生預覽圖」合成（直接儲存也會自動合成）。' : '';
    });
    clearBtn.addEventListener('click', () => { file.value = ''; clearBtn.hidden = true; status.textContent = '已清除照片；按「產生預覽圖」會改用純色樣式。'; });

    // ---- 上傳連結、QR Code ----
    const urlIn = input('text', url, { readonly: true, id: 'up-url', class: 'input link-input' });
    urlIn.className = 'input link-input';
    const copyBtn = h('button', { type: 'button', class: 'btn btn-primary', text: '複製', onclick: async () => {
      if (await copyText(url)) flashLabel(copyBtn, '已複製'); else toast('無法複製，請手動選取網址', 'err');
    } });
    const qrBox = h('div', { class: 'qr-box', role: 'img', 'aria-label': '上傳頁 QR Code' });
    try { qrBox.append(qrSvgNode(url, '上傳頁 QR Code')); } catch { qrBox.textContent = 'QR Code 產生失敗'; }
    const dl = h('button', { type: 'button', class: 'btn', text: '下載 QR 圖檔（PNG）', onclick: async () => {
      try {
        const blob = await qrPngBlob(url);
        const a = h('a', { href: URL.createObjectURL(blob), download: `${ctx.cfg.basic?.name || 'qrcode'}-上傳QR.png` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } catch { toast('下載失敗', 'err'); }
    } });
    const print = h('button', { type: 'button', class: 'btn', text: '列印海報（A4）', onclick: () => {
      const p = document.getElementById('poster');
      mount(p, h('h1', { text: ctx.cfg.basic?.name || '' }), h('div', { class: 'p-sub', text: '用手機掃描 QR Code，上傳你拍的活動照片' }),
        h('div', { class: 'p-qr' }, qrSvgNode(url, '上傳頁 QR Code')), h('div', { class: 'p-url', text: url }),
        h('div', { class: 'p-note', text: noticeText(ctx.cfg, ctx.data.delete_at) }));
      document.body.classList.add('printing-poster');
      const off = () => { document.body.classList.remove('printing-poster'); window.removeEventListener('afterprint', off); };
      window.addEventListener('afterprint', off);
      window.print();
    } });

    // ---- LINE 公告文案：開頭用邀請文字；使用者手動改過文案後就不再自動覆蓋 ----
    const lineBox = h('textarea', { class: 'textarea', rows: '6', id: 'line-msg' });
    lineBox.value = lineMessage(ctx);
    let lineTouched = false;
    lineBox.addEventListener('input', (e) => { lineTouched = true; e.stopPropagation(); }); // 公告文案不算「未儲存的修改」
    const msgBtn = h('button', { type: 'button', class: 'btn', text: '複製 LINE 公告文案', onclick: async () => {
      if (await copyText(lineBox.value)) flashLabel(msgBtn, '已複製公告'); else toast('無法複製', 'err');
    } });
    function onText() {
      refresh();
      if (!lineTouched) lineBox.value = lineMessage(ctx, msg.value.trim() || auto.message);
    }
    title.addEventListener('input', onText);
    msg.addEventListener('input', onText);
    refresh();

    return {
      node: h('div', { class: 'stack' },
        h('div', { class: 'muted', text: '上傳連結與 QR Code 在建立活動時就固定了，可以提早印進手冊、海報或名牌背面。' }),
        ctx.data.stage === 'planning' ? h('div', { class: 'note', text: '目前還在規劃中：在你設定開放時間之前，掃碼只會看到「尚未開放」。' }) : null,

        h('h3', { class: 'sub-h', text: '連結預覽' }),
        h('div', { class: 'muted small', text: '把上傳連結貼到 LINE 時，對方看到的預覽長這樣。LINE 有時顯示大圖、有時只把圖片中央裁成正方形小縮圖，所以預覽圖的重要文字都放在中央。實際外觀依 LINE 版本略有不同。' }),
        h('div', { class: 'lc-pair' },
          h('div', { class: 'lc-col' }, h('div', { class: 'small', style: 'font-weight:700', text: '大圖預覽' }), stage),
          h('div', { class: 'lc-col' }, h('div', { class: 'small', style: 'font-weight:700', text: '小縮圖預覽' }), stage2)),
        h('div', { class: 'grid2' },
          field('預覽標題', title),
          h('label', { class: 'field full', for: 'inv-msg' }, '邀請文字', msg, h('span', { class: 'small muted' }, '留空會自動產生（淡色字就是目前的自動內容）。 ', cnt)),
          h('label', { class: 'field full', for: 'inv-photo' }, '封面照片（選填）', file)),
        h('div', { class: 'row' }, genBtn, clearBtn),
        status,
        h('div', { class: 'note', text: '有封面照片時，照片會當整張背景、中央放文字面板；沒有照片就用深青綠底加相機圖示。照片只在你的瀏覽器裡處理，上傳的是合成後的 1200×630 圖片。按下方「儲存」才會套用到分享連結。基本資料（名稱、日期、地點）修改後，自動產生的預覽圖會跟著更新；使用封面照片的則不會。' }),
        h('div', { class: 'note', text: 'LINE 會快取預覽約數天；改了之後若舊預覽還在，可換一個新上傳碼，或在網址後加 ?v=2 再分享。' }),

        h('h3', { class: 'sub-h', text: 'QR Code 與連結' }),
        h('div', { class: 'qr-row' }, qrBox, h('div', { class: 'stack', style: 'gap:8px' }, dl, print)),
        h('label', { class: 'field', for: 'up-url' }, '上傳連結'),
        h('div', { class: 'row' }, urlIn, copyBtn),
        h('label', { class: 'field', for: 'line-msg' }, 'LINE 群組公告文案（可直接修改）'), lineBox, h('div', {}, msgBtn)),
      collect: () => ({ invite: { title: title.value.trim(), message: msg.value.trim() } }),
      // 儲存前：有選照片就合成並上傳；已產生的預覽圖上傳；第一次儲存且還沒有卡片時，自動產生「無照片」樣式
      async beforeSave() {
        const f = file.files[0] || null;
        let p = pending;
        if (f && (!p || p.file !== f)) p = await make(f);
        if (!p && !ctx.cfg.invite?.card_updated_at) {
          try { p = await make(null); } catch (e) { toast(`自動產生預覽圖失敗：${e.message}`, 'err'); return; }
        }
        if (!p) return;
        await putCard(p, p.auto);
        URL.revokeObjectURL(p.url);
        pending = null;
      },
    };
  }

  function edMv() {
    const m = ctx.cfg.mv || {};
    const maker = input('text', m.maker, { placeholder: '姓名或 Email，可之後再指定', maxlength: 80 });
    const song = input('text', m.song, { placeholder: '歌名，可之後再決定', maxlength: 80 });
    return {
      node: h('div', { class: 'stack' }, field('MV 製作者', maker), field('歌曲', song),
        h('div', { class: 'muted small', text: '製作者可以在活動前就先安裝 MV Studio、對齊歌詞，活動當天邊收照片邊分析，結束後很快就能出片。' }),
        h('div', {}, h('button', { type: 'button', class: 'btn', text: '前往「交給 MV 製作者」複製提示詞', onclick: () => ctx.switchTab('handoff') }))),
      collect: () => ({ mv: { ...m, maker: maker.value.trim(), song: song.value.trim() } }),
    };
  }

  // ---- 資料更新 ----
  ctx.on((d, src) => {
    renderStages(); renderMust(); renderNav();
    // 自動更新不重建編輯區（避免蓋掉輸入與焦點）；初次載入與自己儲存後才重建
    if (src === 'init' || (src === 'patch' && !dirty)) buildEditor();
  });
}
