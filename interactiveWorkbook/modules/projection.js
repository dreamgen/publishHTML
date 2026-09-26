// ──────────────────────────────────────────────────────────────────────────────
// 功能三：投影呈現（狀態點 ＋ 四個固定分享模式）
//
// 這個模組只負責「讀取與呈現」：活動標記（橘點）的寫入端在 student.js，
// 訂閱生命週期由 session.js 的 watchLive / stopWatchLive 管。
//
// 兩條鐵律（規約第五節第 3、4 條）：
//   1. 投影字數：1920×1080、28px 以上、每組只有 150～200 字就滿版。截斷是必要條件，不是美化。
//   2. 狀態點只做局部更新：每顆點有固定 id，onLiveChange 進來時只改 class，不重畫頁面。
//      答案儲存造成的整頁重繪是可接受的，刻意不把局部更新推廣到答案儲存格。
// ──────────────────────────────────────────────────────────────────────────────
import { S, fieldsOf, currentEx } from './state.js';
import { E, notify } from './util.js';
import { expandDialog, truncate } from './ui.js';
import { onLiveChange, hasActivity } from './live.js';
import { loadJSON, saveJSON } from './storage.js';
import { rerender } from './render.js';
import { answerRows, hasContent, sortedGroups } from './teacher.js';

// ──────────────────────────────────────────────────────────────────────────────
// 截斷字數的具名常數
//
// 推算基準：整個投影畫面約容納 900～1200 個中文字。以下每個數字都是
// 「1000 字 ÷ 這個模式同時出現的儲存格數」再往下取整，留一點給欄位標題與組名。
// 一題大約 3～5 個欄位、一場課大約 6 組，都以這個規模估算。
// ──────────────────────────────────────────────────────────────────────────────

/** 單組模式：1 組獨佔整個畫面，最多 4 個欄位分 1200 字 → 每欄 280。這是四個模式裡最寬鬆的。 */
const MAX_ONE_GROUP = 280;

/** 單題模式：1 個欄位 × 6 組 → 1000 ÷ 6 ≈ 166。取 160，留空間給組名與狀態。 */
const MAX_ONE_FIELD = 160;

/** 比較模式：4 欄位 × 3 組 = 12 格 → 1000 ÷ 12 ≈ 83。取 90（比較模式刻意不久留）。 */
const MAX_COMPARE = 90;

/**
 * 全覽模式：4 欄位 × 6 組 = 24 格 → 1000 ÷ 24 ≈ 41。
 * 實測（6 組 × 4 欄位的練習一）取 40 時整頁約 1216 字，剛好越過 1200 的上限，
 * 因此收到 34：整頁約 1070 字、每組約 180 字，落在「每組 150～200 字」之內。
 * 全覽是用來「發現特殊」，不是用來讀完。
 */
const MAX_OVERVIEW = 34;

/** 單題模式的清單題：合併後最多約 24 條（6 組 × 4 條）→ 1000 ÷ 24 ≈ 41。取 44。 */
const MAX_LIST_ITEM = 44;

/** 複選題矩陣的選項標籤：選項是題目自己的文字，只需要能認得出來。 */
const MAX_OPTION_LABEL = 40;

/** 狀態點展開的行內預覽：這是講師「臨時想看一眼」，不是投影內容，可以比分享模式寬鬆。 */
const MAX_DOT_PREVIEW = 200;

// 字級倍率（App 內字級，不是瀏覽器縮放）。
// 下限 0.8：再小就比 App 預設還小，投影已經沒有意義；
// 上限 2.4：以 28px 基準放大到約 67px，一個 160 字的儲存格剛好還塞得進 1080p。
const SCALE_KEY = 'iw_projScale';
const SCALE_MIN = 0.8;
const SCALE_MAX = 2.4;
const SCALE_STEP = 0.1;

// 五顆並排按鈕的順序：狀態點在最左（時間上先發生），接著依「欄位範圍 × 組別範圍」由窄到寬排列，
// 順序與規劃文件第四節的表格一致，講師看文件與看畫面不用換一套心智模型。
const MODES = [
  { key: 'dots', label: '狀態點', hint: '作答進行中：只看誰動了哪個欄位' },
  { key: 'single', label: '單題', hint: '一個欄位 × 全部組別' },
  { key: 'group', label: '單組', hint: '全部欄位 × 一組' },
  { key: 'compare', label: '比較', hint: '全部欄位 × 2～3 組' },
  { key: 'all', label: '全覽', hint: '全部欄位 × 全部組別' },
];

const COMPARE_MAX_GROUPS = 3;

const DOT_FILLED = 'proj-dot is-filled';
const DOT_TOUCHED = 'proj-dot is-touched';
const DOT_IDLE = 'proj-dot is-idle';
const DOT_TEXT = {
  [DOT_FILLED]: '已有內容',
  [DOT_TOUCHED]: '已被點過，尚未儲存',
  [DOT_IDLE]: '未填',
};

// ──────────────────────────────────────────────────────────────────────────────
// 模組內狀態
// ──────────────────────────────────────────────────────────────────────────────
/** 每次重畫後重建：{ id, gid, qid, key, filled } */
let dotRegistry = [];
/** 展開視窗要用的完整文字。放在這裡而不是塞進 data-* 屬性，避免把整篇答案編碼進 HTML。 */
let expandStore = [];
/** onLiveChange 的取消函式；重畫前一定要呼叫，否則殭屍訂閱會對已移除的 DOM 做更新。 */
let liveUnsub = null;
let keyBound = false;
/** 「只顯示已作答的組別」。刻意留在模組內而不進 state.js：它是投影當下的臨時開關。 */
let onlyAnswered = false;
let scaleLoaded = false;

/**
 * 預設 1.2 而不是 1：投影字級要 28px 以上才看得到，
 * 「簡潔投影」的基準是 24px，1.2 倍剛好到 28.8px，第一次投影就已經合格。
 * 講師調過之後存進 localStorage，下次開課沿用。
 */
const SCALE_DEFAULT = 1.2;

function ensureScale() {
  if (scaleLoaded) return;
  scaleLoaded = true;
  S.projScale = clampScale(Number(loadJSON(SCALE_KEY, SCALE_DEFAULT)) || SCALE_DEFAULT);
}

function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n * 10) / 10));
}

// ──────────────────────────────────────────────────────────────────────────────
// 資料整理
// ──────────────────────────────────────────────────────────────────────────────
function groupHasAnswer(g, qid) {
  return Object.values((g.answers || {})[qid] || {}).some(hasContent);
}

function groupStatus(g, qid) {
  if (g.complete && g.complete[qid]) return '✓ 已完成';
  if (g.updated && g.updated[qid]) return '草稿';
  return '尚未作答';
}

/**
 * 可見組別：先套用工具列原本的「組別」下拉（維持既有行為，等於一個前置過濾），
 * 再套用「只顯示已作答的組別」。各模式再從這個清單裡取自己要的組。
 */
function baseGroups() {
  const qid = S.qid;
  return sortedGroups()
    .filter(([gid]) => S.groupFilter === 'all' || gid === S.groupFilter)
    .filter(([, g]) => !onlyAnswered || groupHasAnswer(g, qid));
}

/** 一個欄位在一組的純文字值（沿用 answerRows，題型的文字化規則只有一套） */
function fieldText(field, answer) {
  return answerRows([field], answer || {})[0][1] || '';
}

/** 把選擇狀態修正到合法範圍：題目換了、組別被刪了都會走到這裡 */
function normalizeSelection(fields, list) {
  if (!fields.some((f) => f.key === S.projField)) S.projField = fields.length ? fields[0].key : null;
  const alive = list.map(([gid]) => gid);
  S.projGroups = (S.projGroups || []).filter((gid) => alive.includes(gid));
  if (S.projMode === 'group' && !S.projGroups.length && alive.length) S.projGroups = [alive[0]];
  if (S.projMode === 'group' && S.projGroups.length > 1) S.projGroups = [S.projGroups[0]];
  if (S.projMode === 'compare') {
    if (!S.projGroups.length) S.projGroups = alive.slice(0, Math.min(2, alive.length));
    if (S.projGroups.length > COMPARE_MAX_GROUPS) S.projGroups = S.projGroups.slice(0, COMPARE_MAX_GROUPS);
  }
}

function selectedGroups(list) {
  if (S.projMode === 'group' || S.projMode === 'compare') {
    return list.filter(([gid]) => S.projGroups.includes(gid));
  }
  return list;
}

function dotId(gid, qid, key) {
  return `dot-${gid}-${qid}-${key}`;
}

/** 登記一段完整文字，回傳「展開」按鈕的 HTML（沒被截斷就回傳空字串） */
function expandButton(truncated, title, text) {
  if (!truncated) return '';
  const idx = expandStore.push({ title, text }) - 1;
  // 按鈕字樣刻意只有兩個字：全覽模式同時會出現二十幾顆，四個字就吃掉近百字的畫面預算。
  return `<button type="button" class="link proj-expand" data-proj-expand="${idx}">展開</button>`;
}

function cellHTML(title, text, max, extraClass = '') {
  const value = String(text || '');
  if (!value.trim()) return `<td class="answer empty ${extraClass}">— 尚未填寫</td>`;
  const cut = truncate(value, max);
  return `<td class="answer ${extraClass}">${E(cut.shown)}${expandButton(cut.truncated, title, value)}</td>`;
}

function groupHeadHTML(g) {
  // 完成狀態放在組名下方，不另外用顏色表示：投影距離下四色難辨。
  return `<th scope="col"><span class="proj-group-name">${E(g.name)}</span><span class="proj-group-state">${E(groupStatus(g, S.qid))}</span></th>`;
}

function emptyNotice(text) {
  return `<div class="notice">${E(text)}</div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 監看階段：狀態點
// ──────────────────────────────────────────────────────────────────────────────
function renderDots(list, fields) {
  if (!list.length) return emptyNotice('目前沒有可顯示的組別。學員加入後，這裡會出現每一組的作答狀態。');
  if (!fields.length) return emptyNotice('這一題沒有作答欄位。');
  const qid = S.qid;
  const body = fields.map((f) => `<tr><th scope="row">${E(f.label)}</th>${
    list.map(([gid, g]) => {
      const filled = hasContent((g.answers[qid] || {})[f.key]);
      const cls = filled ? DOT_FILLED : (hasActivity(gid, qid, f.key) ? DOT_TOUCHED : DOT_IDLE);
      const id = dotId(gid, qid, f.key);
      const prefix = `${g.name}｜${f.label}：`;
      dotRegistry.push({ id, gid, qid, key: f.key, filled, prefix });
      return `<td class="proj-dot-cell" data-dot-gid="${E(gid)}" data-dot-key="${E(f.key)}" tabindex="0" role="button" aria-expanded="false"><span class="${cls}" id="${E(id)}" aria-label="${E(prefix + DOT_TEXT[cls])}"></span></td>`;
    }).join('')
  }</tr>`).join('');
  return `<p class="proj-legend"><span class="proj-dot is-filled"></span>已有內容
      <span class="proj-dot is-touched"></span>已被點過，尚未儲存
      <span class="proj-dot is-idle"></span>未填
      <span class="proj-legend-note">橘點不會自動熄滅，儲存後會變成綠點。點任一格可以看內容，再點一次收合。</span></p>
    <div class="table-scroll"><table class="data-table proj-table proj-dots"><thead><tr><th scope="col">作答欄位</th>${
  list.map(([, g]) => groupHeadHTML(g)).join('')
}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 分享階段：欄位 × 組別的表格（單組／比較／全覽共用）
// ──────────────────────────────────────────────────────────────────────────────
function renderRowsTable(list, fields, max, modeClass) {
  if (!list.length) return emptyNotice('目前沒有可顯示的組別。');
  if (!fields.length) return emptyNotice('這一題沒有作答欄位。');
  const qid = S.qid;
  const cache = new Map(list.map(([gid, g]) => [gid, answerRows(fields, g.answers[qid] || {})]));
  const body = fields.map((f, i) => `<tr><th scope="row">${E(f.label)}</th>${
    list.map(([gid, g]) => cellHTML(`${g.name}｜${f.label}`, cache.get(gid)[i][1], max)).join('')
  }</tr>`).join('');
  return `<div class="table-scroll"><table class="data-table proj-table ${modeClass}"><thead><tr><th scope="col">作答欄位</th>${
    list.map(([, g]) => groupHeadHTML(g)).join('')
  }</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 分享階段：單題（1 個欄位 × 全部組別），依題型換渲染方式
// ──────────────────────────────────────────────────────────────────────────────
function renderCheckboxMatrix(list, field) {
  // 打勾矩陣只在單題模式出現：唯有這個模式的橫軸是組別，矩陣才排得出來。
  const qid = S.qid;
  const picks = list.map(([gid, g]) => [gid, new Set((((g.answers[qid] || {})[field.key]) || []).map(Number))]);
  const rows = (field.options || []).map((opt, i) => {
    const count = picks.filter(([, set]) => set.has(i)).length;
    const label = truncate(opt, MAX_OPTION_LABEL);
    return `<tr><th scope="row">${E(label.shown)}</th>${
      picks.map(([, set]) => `<td class="proj-tick ${set.has(i) ? 'on' : ''}">${set.has(i) ? '<span aria-label="已選">✓</span>' : '<span aria-label="未選">·</span>'}</td>`).join('')
    }<td class="proj-tick-count">${count} 組</td></tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="data-table proj-table proj-matrix"><thead><tr><th scope="col">${E(field.label)}</th>${
    list.map(([, g]) => groupHeadHTML(g)).join('')
  }<th scope="col">合計</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderMergedList(list, field) {
  const qid = S.qid;
  const items = [];
  list.forEach(([, g]) => {
    (((g.answers[qid] || {})[field.key]) || []).forEach((raw) => {
      const text = String(raw || '').trim();
      if (text) items.push({ text, from: g.name });
    });
  });
  if (!items.length) return emptyNotice('目前還沒有任何一組在這個欄位填入內容。');
  return `<ol class="proj-merged">${items.map((it) => {
    const cut = truncate(it.text, MAX_LIST_ITEM);
    return `<li><span class="proj-merged-text">${E(cut.shown)}</span>${
      expandButton(cut.truncated, `${it.from}｜${field.label}`, it.text)
    }<span class="proj-source">${E(it.from)}</span></li>`;
  }).join('')}</ol>`;
}

function renderSingleField(list, fields) {
  if (!list.length) return emptyNotice('目前沒有可顯示的組別。');
  const field = fields.find((f) => f.key === S.projField);
  if (!field) return emptyNotice('這一題沒有作答欄位。');
  if (field.type === 'checkbox') return renderCheckboxMatrix(list, field);
  if (field.type === 'list') return renderMergedList(list, field);
  // 表格題在這裡也走這條文字路徑：「工作項目」是各組自由輸入的文字，列與列之間無法對齊，
  // 強行攤平成矩陣只會排出一張對不起來的表；字數必然超額，因此依賴截斷加展開。
  const qid = S.qid;
  return `<div class="proj-cards">${list.map(([, g]) => {
    const text = fieldText(field, g.answers[qid] || {});
    const cut = truncate(text, MAX_ONE_FIELD);
    return `<article class="proj-card"><h3>${E(g.name)}<span class="proj-group-state">${E(groupStatus(g, qid))}</span></h3>${
      text.trim() ? `<div class="answer">${E(cut.shown)}</div>${expandButton(cut.truncated, `${g.name}｜${field.label}`, text)}`
        : '<div class="answer empty">— 尚未填寫</div>'
    }</article>`;
  }).join('')}</div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 工具列
// ──────────────────────────────────────────────────────────────────────────────
function modeBar() {
  return `<div class="toolbar proj-bar proj-mode-bar">
      <span class="proj-bar-label">投影模式</span>
      <div class="proj-mode-row" role="group" aria-label="投影模式">${
  MODES.map((m) => `<button type="button" data-proj-mode="${m.key}" class="${S.projMode === m.key ? 'primary' : ''}" aria-pressed="${S.projMode === m.key}" title="${E(m.hint)}">${E(m.label)}</button>`).join('')
}</div>
      <span class="proj-bar-label">投影字級</span>
      <div class="proj-scale" role="group" aria-label="投影字級">
        <button type="button" data-proj-scale="-1" aria-label="縮小投影字級">－</button>
        <output id="proj-scale-value">${Math.round(S.projScale * 100)}%</output>
        <button type="button" data-proj-scale="1" aria-label="放大投影字級">＋</button>
      </div>
      <label class="proj-check"><input type="checkbox" id="proj-only-answered" ${onlyAnswered ? 'checked' : ''}>只顯示已作答的組別</label>
    </div>`;
}

function pickerBar(fields, list) {
  if (S.projMode === 'single') {
    if (!fields.length) return '';
    return `<div class="toolbar proj-bar proj-picker">
        <span class="proj-bar-label">顯示欄位</span>
        <div class="proj-chip-row" role="group" aria-label="顯示欄位">${
  fields.map((f) => `<button type="button" data-proj-field="${E(f.key)}" class="${S.projField === f.key ? 'primary' : ''}" aria-pressed="${S.projField === f.key}">${E(f.label)}</button>`).join('')
}</div>
        <span class="muted">也可以按鍵盤左右鍵（或簡報筆的上下頁）切換欄位。</span>
      </div>`;
  }
  if (S.projMode === 'group' || S.projMode === 'compare') {
    if (!list.length) return '';
    const isCompare = S.projMode === 'compare';
    return `<div class="toolbar proj-bar proj-picker">
        <span class="proj-bar-label">${isCompare ? `顯示組別（最多 ${COMPARE_MAX_GROUPS} 組）` : '顯示組別'}</span>
        <div class="proj-chip-row" role="group" aria-label="顯示組別">${
  list.map(([gid, g]) => `<button type="button" data-proj-group="${E(gid)}" class="${S.projGroups.includes(gid) ? 'primary' : ''}" aria-pressed="${S.projGroups.includes(gid)}">${E(g.name)}</button>`).join('')
}</div>
        <span class="muted">${isCompare ? '再按一次可取消選取。' : '也可以按鍵盤左右鍵切換組別。'}</span>
      </div>`;
  }
  return '';
}

// ──────────────────────────────────────────────────────────────────────────────
// 對外：整段 HTML
// ──────────────────────────────────────────────────────────────────────────────
export function projectionSection() {
  ensureScale();
  dotRegistry = [];
  expandStore = [];
  if (!MODES.some((m) => m.key === S.projMode)) S.projMode = 'dots';
  const fields = fieldsOf(S.qid);
  const list = baseGroups();
  normalizeSelection(fields, list);
  const shown = selectedGroups(list);
  let body;
  if (S.projMode === 'dots') body = renderDots(list, fields);
  else if (S.projMode === 'single') body = renderSingleField(list, fields);
  else if (S.projMode === 'group') body = renderRowsTable(shown, fields, MAX_ONE_GROUP, 'proj-one-group');
  else if (S.projMode === 'compare') body = renderRowsTable(shown, fields, MAX_COMPARE, 'proj-compare');
  else body = renderRowsTable(shown, fields, MAX_OVERVIEW, 'proj-overview');
  const ex = currentEx();
  const hint = (MODES.find((m) => m.key === S.projMode) || {}).hint || '';
  return `<section class="proj-root" id="proj-root">
      ${modeBar()}
      ${pickerBar(fields, list)}
      <p class="status-line proj-hint">${E(hint)}${
  onlyAnswered ? '｜已隱藏尚未作答的組別' : ''
}${ex ? `｜${E(ex.title)}` : ''}</p>
      <div class="proj-area" id="proj-area" style="--proj-scale:${S.projScale}">${body}</div>
    </section>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 局部更新：只改 class，不重畫頁面
// ──────────────────────────────────────────────────────────────────────────────
function updateDots() {
  dotRegistry.forEach((d) => {
    // 綠點（已有內容）只有答案儲存才會變，而那會整頁重繪，不必在這裡處理。
    if (d.filled) return;
    const el = document.getElementById(d.id);
    if (!el) return;
    const cls = hasActivity(d.gid, d.qid, d.key) ? DOT_TOUCHED : DOT_IDLE;
    if (el.className === cls) return;
    el.className = cls;
    el.setAttribute('aria-label', d.prefix + DOT_TEXT[cls]);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 事件綁定
// ──────────────────────────────────────────────────────────────────────────────
function applyScale(step) {
  const next = clampScale(S.projScale + step * SCALE_STEP);
  if (next === S.projScale) return;
  S.projScale = next;
  saveJSON(SCALE_KEY, next);
  // 字級只動一個 CSS 變數，不必重畫：重畫會讓捲動位置跳掉，投影中最不該發生。
  const area = document.querySelector('#proj-area');
  if (area) area.style.setProperty('--proj-scale', String(next));
  const out = document.querySelector('#proj-scale-value');
  if (out) out.textContent = `${Math.round(next * 100)}%`;
}

function cycleField(step) {
  const fields = fieldsOf(S.qid);
  if (fields.length < 2) return false;
  const i = fields.findIndex((f) => f.key === S.projField);
  S.projField = fields[((i < 0 ? 0 : i) + step + fields.length) % fields.length].key;
  return true;
}

function cycleGroup(step) {
  const list = baseGroups();
  if (list.length < 2) return false;
  const ids = list.map(([gid]) => gid);
  const i = ids.indexOf(S.projGroups[0]);
  S.projGroups = [ids[((i < 0 ? 0 : i) + step + ids.length) % ids.length]];
  return true;
}

function onKeyDown(e) {
  if (!S.session || S.session.role !== 'teacher') return;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select')) return;
  let step = 0;
  if (e.key === 'ArrowLeft') step = -1;
  else if (e.key === 'ArrowRight') step = 1;
  else if (S.projMode === 'single' && e.key === 'PageUp') step = -1;
  else if (S.projMode === 'single' && e.key === 'PageDown') step = 1;
  if (!step) return;
  let moved = false;
  if (S.projMode === 'single') moved = cycleField(step);
  else if (S.projMode === 'group') moved = cycleGroup(step);
  if (!moved) return;
  e.preventDefault();
  rerender();
}

function bindDotCells(root) {
  root.querySelectorAll('.proj-dot-cell').forEach((cell) => {
    const toggle = () => {
      const open = cell.querySelector('.proj-dot-detail');
      if (open) { open.remove(); cell.setAttribute('aria-expanded', 'false'); return; }
      const gid = cell.dataset.dotGid;
      const key = cell.dataset.dotKey;
      const g = S.course.groups[gid];
      const field = fieldsOf(S.qid).find((f) => f.key === key);
      if (!g || !field) return;
      const text = fieldText(field, g.answers[S.qid] || {});
      const box = document.createElement('div');
      box.className = 'proj-dot-detail';
      if (!String(text).trim()) {
        box.innerHTML = '<span class="empty">— 尚未填寫</span>';
      } else {
        const cut = truncate(text, MAX_DOT_PREVIEW);
        box.innerHTML = `<span class="answer">${E(cut.shown)}</span>`;
        if (cut.truncated) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'link';
          b.textContent = '展開全文';
          b.onclick = (ev) => { ev.stopPropagation(); expandDialog(`${g.name}｜${field.label}`, text); };
          box.appendChild(b);
        }
      }
      cell.appendChild(box);
      cell.setAttribute('aria-expanded', 'true');
    };
    cell.onclick = toggle;
    cell.onkeydown = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      toggle();
    };
  });
}

export function bindProjection() {
  disposeProjection();
  const root = document.querySelector('#proj-root');
  if (!root) return;

  root.querySelectorAll('[data-proj-mode]').forEach((b) => {
    b.onclick = () => { S.projMode = b.dataset.projMode; rerender(); };
  });
  root.querySelectorAll('[data-proj-scale]').forEach((b) => {
    b.onclick = () => applyScale(Number(b.dataset.projScale));
  });
  const only = root.querySelector('#proj-only-answered');
  if (only) only.onchange = () => { onlyAnswered = only.checked; rerender(); };
  root.querySelectorAll('[data-proj-field]').forEach((b) => {
    b.onclick = () => { S.projField = b.dataset.projField; rerender(); };
  });
  root.querySelectorAll('[data-proj-group]').forEach((b) => {
    b.onclick = () => {
      const gid = b.dataset.projGroup;
      if (S.projMode === 'group') { S.projGroups = [gid]; rerender(); return; }
      if (S.projGroups.includes(gid)) {
        if (S.projGroups.length === 1) { notify('比較模式至少要選一組。'); return; }
        S.projGroups = S.projGroups.filter((x) => x !== gid);
      } else {
        if (S.projGroups.length >= COMPARE_MAX_GROUPS) {
          notify(`比較模式最多同時顯示 ${COMPARE_MAX_GROUPS} 組。請先取消一組再選。`);
          return;
        }
        S.projGroups = [...S.projGroups, gid];
      }
      rerender();
    };
  });
  root.querySelectorAll('[data-proj-expand]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const rec = expandStore[Number(b.dataset.projExpand)];
      if (rec) expandDialog(rec.title, rec.text);
    };
  });
  bindDotCells(root);

  // 活動標記的訂閱：回呼裡只改狀態點的 class，絕不 rerender()。
  // root 已經不在文件裡（畫面被其他模組重畫過）就自己解除訂閱，避免殭屍訂閱對已移除的 DOM 動手。
  liveUnsub = onLiveChange(() => {
    if (!root.isConnected) { disposeProjection(); return; }
    updateDots();
  });

  document.addEventListener('keydown', onKeyDown);
  keyBound = true;
}

/** 重畫前務必呼叫：解除 live 訂閱與鍵盤監聽，避免殭屍訂閱。 */
export function disposeProjection() {
  if (liveUnsub) { liveUnsub(); liveUnsub = null; }
  if (keyBound) { document.removeEventListener('keydown', onKeyDown); keyBound = false; }
  dotRegistry = [];
}
