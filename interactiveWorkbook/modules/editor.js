import { S, exNumber } from './state.js';
import { E, exLabel, notify } from './util.js';
import {
  validateExercise, FIELD_TYPES, COLUMN_TYPES, MAX_FIELDS, MAX_OPTIONS, MAX_EXERCISES,
} from './schema.js';
import {
  saveExercise, addExercise, archiveForEdit, cancelEdit, restoreExercise,
  deleteExercise, answerHasContent,
} from './data.js';
import { enteredGroups, clearActivityForQuestion, clearEnteredForQuestion } from './live.js';
// 循環 import（editor → render → teacher → editor）：只在函式體內使用，不在模組頂層執行期取值。
import { rerender } from './render.js';

// ──────────────────────────────────────────────────────────────────────────────
// 12. 題目編輯器與封存／還原（功能二）
//
// 定位：輕量修正與少量新增。題目量大時仍然用 AI 產生 JSON 再匯入，
// 但編輯器本身**支援完整 schema**（複選的 minSelect／maxSelect、表格的 columns、
// 清單的 minItems／itemType／itemLabel、參考資料表），「簡單」指的是講師手打的數量，不是功能閹割。
//
// 存檔一律走 schema.js 既有的 validateExercise，不另寫一套驗證：
// 匯入的題目與這裡編出來的題目必須是同一種東西，兩套驗證遲早會分岔。
// ──────────────────────────────────────────────────────────────────────────────

const TYPE_LABEL = {
  text: '單行文字',
  textarea: '多行文字',
  number: '數字',
  date: '日期',
  radio: '單選（radio）',
  checkbox: '複選（checkbox）',
  list: '清單（可自行增列）',
  table: '表格（可自行增列）',
};

const COLUMN_TYPE_LABEL = { text: '文字', number: '數字', date: '日期' };

/** 某一題目前有幾組填了內容（含封存題：封存題的答案還在原處） */
export function groupsAnswered(qid) {
  if (!S.course) return 0;
  return Object.values(S.course.groups).filter((g) => answerHasContent(g.answers[qid])).length;
}

// ──────────────────────────────────────────────────────────────────────────────
// 12.1 草稿模型
//
// 編輯器有自己的草稿（不放進 S）：講師編到一半時 snapshot 隨時可能進來重畫控制台，
// 草稿掛在 S 上會被那些重畫波及。浮動視窗掛在 document.body，控制台重畫不會動到它。
// 數字欄位一律以字串保存，送出時才轉數字，讓「清空」與「填 0」是兩件不同的事。
// ──────────────────────────────────────────────────────────────────────────────
function toFieldDraft(field) {
  const src = field || {};
  return {
    key: src.key || '',
    label: src.label || '',
    type: FIELD_TYPES.includes(src.type) ? src.type : 'textarea',
    required: !!src.required,
    hint: src.hint || '',
    options: (src.options || []).map((o) => String(o ?? '')),
    minSelect: src.minSelect == null ? '' : String(src.minSelect),
    maxSelect: src.maxSelect == null ? '' : String(src.maxSelect),
    itemType: src.itemType === 'text' ? 'text' : 'textarea',
    itemLabel: src.itemLabel || '',
    minItems: src.minItems == null ? '' : String(src.minItems),
    minRows: src.minRows == null ? '' : String(src.minRows),
    columns: (src.columns || []).map((c) => ({
      key: (c && c.key) || '',
      label: (c && c.label) || '',
      type: COLUMN_TYPES.includes(c && c.type) ? c.type : 'text',
    })),
  };
}

function toDraft(exDef) {
  const src = exDef || {};
  const ref = src.reference || null;
  return {
    title: src.title || '',
    time: src.time || '',
    goal: src.goal || '',
    notice: src.notice || '',
    reference: {
      enabled: !!(ref && ((ref.columns || []).length || (ref.rows || []).length || ref.caption)),
      caption: (ref && ref.caption) || '',
      columns: ((ref && ref.columns) || []).map((c) => String(c ?? '')),
      rows: ((ref && ref.rows) || []).map((r) => (r || []).map((c) => String(c ?? ''))),
    },
    fields: (src.fields || []).map(toFieldDraft),
  };
}

/** 空白新題的起手式：至少要有一個欄位，validateExercise 不接受 0 個 fields。 */
function blankDraft() {
  const draft = toDraft({ title: '', fields: [] });
  draft.fields.push(toFieldDraft({ key: 'answer', label: '', type: 'textarea', required: true }));
  return draft;
}

/** 空字串代表「不設定」；填了非整數就讓 NaN 進去，由 schema.js 丟出精確的錯誤訊息 */
function optionalInt(value) {
  const s = String(value ?? '').trim();
  if (!s) return undefined;
  return /^-?\d+$/.test(s) ? Number(s) : NaN;
}

function buildField(field) {
  const out = {
    key: field.key, label: field.label, type: field.type, required: !!field.required,
  };
  if (String(field.hint || '').trim()) out.hint = field.hint;
  if (field.type === 'radio' || field.type === 'checkbox') {
    out.options = field.options.map((o) => String(o ?? ''));
    if (field.type === 'checkbox') {
      const min = optionalInt(field.minSelect);
      const max = optionalInt(field.maxSelect);
      if (min !== undefined) out.minSelect = min;
      if (max !== undefined) out.maxSelect = max;
    }
  }
  if (field.type === 'list') {
    out.itemType = field.itemType;
    out.itemLabel = field.itemLabel || '項目';
    const min = optionalInt(field.minItems);
    if (min !== undefined) out.minItems = min;
  }
  if (field.type === 'table') {
    out.columns = field.columns.map((c) => ({ key: c.key, label: c.label, type: c.type }));
    out.itemLabel = field.itemLabel || '項目';
    const min = optionalInt(field.minRows);
    if (min !== undefined) out.minRows = min;
  }
  return out;
}

export function buildContent(draft) {
  const out = { title: draft.title };
  ['time', 'goal', 'notice'].forEach((k) => { if (String(draft[k] || '').trim()) out[k] = draft[k]; });
  const ref = draft.reference;
  // 勾了參考資料表卻一欄一列都沒有時視同沒有：留一張空表格在學員畫面上只會讓人以為東西沒載出來。
  if (ref.enabled && (ref.columns.length || ref.rows.length)) {
    const built = {};
    if (String(ref.caption || '').trim()) built.caption = ref.caption;
    built.columns = ref.columns.map((c) => String(c ?? ''));
    built.rows = ref.rows.map((r) => ref.columns.map((_, i) => String((r || [])[i] ?? '')));
    out.reference = built;
  }
  out.fields = draft.fields.map(buildField);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// 12.2 編輯器畫面
//
// 文字輸入只寫進草稿、不重畫（重畫會讓游標跳掉）；
// 只有「結構有變」的動作（新增／移除／搬動欄位、換型別、增減選項與列）才重畫整個 body，
// 重畫前後保留捲動位置，避免講師編到一半被彈回最上面。
// ──────────────────────────────────────────────────────────────────────────────
let editor = null;

function markDirty() { if (editor) editor.dirty = true; }

function fieldTypeBlock(field, i) {
  if (field.type === 'radio' || field.type === 'checkbox') {
    return `<div class="form-field"><label>選項（1–${MAX_OPTIONS} 個，順序即畫面順序）</label>
      ${field.options.map((o, oi) => `<div class="editor-inline"><input data-opt="${i}" data-oi="${oi}" type="text" value="${E(o)}" aria-label="第 ${oi + 1} 個選項">${
  field.options.length > 1 ? `<button type="button" class="small danger" data-opt-remove="${i}" data-oi="${oi}">移除</button>` : ''
}</div>`).join('')}
      <div class="toolbar"><button type="button" class="small" data-opt-add="${i}">＋ 新增選項</button></div>
      ${field.type === 'checkbox' ? `<div class="row-grid editor-grid2">
        <div class="form-field"><label>至少選幾項（minSelect，可不填）</label><input data-f="minSelect" data-idx="${i}" type="text" inputmode="numeric" value="${E(field.minSelect)}"></div>
        <div class="form-field"><label>最多選幾項（maxSelect，可不填）</label><input data-f="maxSelect" data-idx="${i}" type="text" inputmode="numeric" value="${E(field.maxSelect)}"></div>
      </div>` : ''}</div>`;
  }
  if (field.type === 'list') {
    return `<div class="row-grid editor-grid3">
      <div class="form-field"><label>每一項的輸入格式</label><select data-f="itemType" data-idx="${i}">
        <option value="textarea" ${field.itemType === 'textarea' ? 'selected' : ''}>多行文字</option>
        <option value="text" ${field.itemType === 'text' ? 'selected' : ''}>單行文字</option></select></div>
      <div class="form-field"><label>每一項的稱呼（itemLabel）</label><input data-f="itemLabel" data-idx="${i}" type="text" value="${E(field.itemLabel)}" placeholder="項目"></div>
      <div class="form-field"><label>至少填幾項（minItems，可不填）</label><input data-f="minItems" data-idx="${i}" type="text" inputmode="numeric" value="${E(field.minItems)}"></div>
    </div>`;
  }
  if (field.type === 'table') {
    return `<div class="form-field"><label>表格欄位（1–12 欄）</label>
      ${field.columns.map((c, ci) => `<div class="editor-inline editor-col-row">
        <input data-col="label" data-idx="${i}" data-ci="${ci}" type="text" value="${E(c.label)}" aria-label="第 ${ci + 1} 欄的標題" placeholder="欄位標題">
        <input data-col="key" data-idx="${i}" data-ci="${ci}" type="text" value="${E(c.key)}" aria-label="第 ${ci + 1} 欄的代碼" placeholder="key（英數字）">
        <select data-col="type" data-idx="${i}" data-ci="${ci}" aria-label="第 ${ci + 1} 欄的型別">${
  COLUMN_TYPES.map((t) => `<option value="${t}" ${c.type === t ? 'selected' : ''}>${E(COLUMN_TYPE_LABEL[t])}</option>`).join('')
}</select>
        ${field.columns.length > 1 ? `<button type="button" class="small danger" data-col-remove="${i}" data-ci="${ci}">移除</button>` : ''}
      </div>`).join('')}
      <div class="toolbar"><button type="button" class="small" data-col-add="${i}">＋ 新增一欄</button></div>
      <div class="row-grid editor-grid2">
        <div class="form-field"><label>每一列的稱呼（itemLabel）</label><input data-f="itemLabel" data-idx="${i}" type="text" value="${E(field.itemLabel)}" placeholder="項目"></div>
        <div class="form-field"><label>至少填幾列（minRows，可不填）</label><input data-f="minRows" data-idx="${i}" type="text" inputmode="numeric" value="${E(field.minRows)}"></div>
      </div></div>`;
  }
  return '';
}

function fieldCard(field, i, total) {
  return `<section class="row-card editor-field">
    <div class="toolbar editor-field-top">
      <h3>欄位 ${i + 1}｜${E(TYPE_LABEL[field.type] || field.type)}</h3>
      <div class="toolbar">
        <button type="button" class="small" data-field-up="${i}" ${i === 0 ? 'disabled' : ''}>上移</button>
        <button type="button" class="small" data-field-down="${i}" ${i === total - 1 ? 'disabled' : ''}>下移</button>
        <button type="button" class="small danger" data-field-remove="${i}" ${total <= 1 ? 'disabled' : ''}>移除欄位</button>
      </div>
    </div>
    <div class="row-grid editor-grid3">
      <div class="form-field"><label>題目文字（學員看到的）＊</label><input data-f="label" data-idx="${i}" type="text" value="${E(field.label)}"></div>
      <div class="form-field"><label>欄位代碼 key（英數字或底線）＊</label><input data-f="key" data-idx="${i}" type="text" value="${E(field.key)}"></div>
      <div class="form-field"><label>型別</label><select data-ftype="${i}">${
  FIELD_TYPES.map((t) => `<option value="${t}" ${field.type === t ? 'selected' : ''}>${E(TYPE_LABEL[t])}</option>`).join('')
}</select></div>
    </div>
    <div class="form-field"><label>補充說明 hint（可不填）</label><input data-f="hint" data-idx="${i}" type="text" value="${E(field.hint)}"></div>
    <label class="choice"><input type="checkbox" data-freq="${i}" ${field.required ? 'checked' : ''}><span>必填（學員按「標記完成並儲存」時才會檢查）</span></label>
    ${fieldTypeBlock(field, i)}
  </section>`;
}

function referenceBlock(ref) {
  if (!ref.enabled) return '';
  return `<div class="form-field"><label for="ed-ref-caption">表格標題 caption（可不填）</label><input id="ed-ref-caption" data-ref="caption" type="text" value="${E(ref.caption)}"></div>
    <div class="form-field"><label>欄位名稱</label>
      ${ref.columns.map((c, ci) => `<div class="editor-inline"><input data-refcol="${ci}" type="text" value="${E(c)}" aria-label="參考資料第 ${ci + 1} 欄名稱"><button type="button" class="small danger" data-refcol-remove="${ci}">移除這一欄</button></div>`).join('')
  || '<p class="muted">還沒有欄位。先新增欄位，才能填資料列。</p>'}
      <div class="toolbar"><button type="button" class="small" data-refcol-add>＋ 新增一欄</button></div>
    </div>
    ${ref.columns.length ? `<div class="form-field"><label>資料列</label>
      ${ref.rows.map((row, ri) => `<div class="editor-inline editor-ref-row">${
    ref.columns.map((_, ci) => `<input data-refcell-r="${ri}" data-refcell-c="${ci}" type="text" value="${E((row || [])[ci] ?? '')}" aria-label="第 ${ri + 1} 列第 ${ci + 1} 欄">`).join('')
  }<button type="button" class="small danger" data-refrow-remove="${ri}">移除</button></div>`).join('')
  || '<p class="muted">還沒有資料列。</p>'}
      <div class="toolbar"><button type="button" class="small" data-refrow-add>＋ 新增一列</button></div>
    </div>` : ''}`;
}

function editorBody() {
  const d = editor.draft;
  return `${editor.intro ? `<div class="notice ${editor.introWarn ? 'warn' : ''}">${editor.intro}</div>` : ''}
    <section class="editor-section">
      <h3>題目基本資料</h3>
      <div class="form-field"><label for="ed-title">標題 ＊</label><input id="ed-title" data-ed="title" type="text" value="${E(d.title)}"></div>
      <div class="row-grid editor-grid2">
        <div class="form-field"><label for="ed-time">時間配置（可不填）</label><input id="ed-time" data-ed="time" type="text" value="${E(d.time)}" placeholder="例：8 分鐘｜小組 5 分鐘 ＋ 回報 3 分鐘"></div>
        <div class="form-field"><label for="ed-goal">這一題的目標（可不填）</label><input id="ed-goal" data-ed="goal" type="text" value="${E(d.goal)}"></div>
      </div>
      <div class="form-field"><label for="ed-notice">作答提醒（可不填，顯示成藍底提示框）</label><textarea id="ed-notice" data-ed="notice">${E(d.notice)}</textarea></div>
    </section>
    <section class="editor-section">
      <h3>參考資料表</h3>
      <label class="choice"><input type="checkbox" data-ref-enabled ${d.reference.enabled ? 'checked' : ''}><span>這一題要附一張參考資料表（學員只能看，不能改）</span></label>
      ${referenceBlock(d.reference)}
    </section>
    <section class="editor-section">
      <h3>作答欄位（目前 ${d.fields.length}／${MAX_FIELDS} 個）</h3>
      <p class="muted">每個欄位的 key 是答案的存放位置：改動 key 等於換一個新欄位，已儲存的答案會對不上而顯示為空白（原答案不會被刪除，改回原本的 key 就會再出現）。</p>
      ${d.fields.map((f, i) => fieldCard(f, i, d.fields.length)).join('')}
      <div class="toolbar"><button type="button" data-field-add ${d.fields.length >= MAX_FIELDS ? 'disabled' : ''}>＋ 新增作答欄位</button></div>
    </section>`;
}

function initFieldForType(field) {
  if ((field.type === 'radio' || field.type === 'checkbox') && !field.options.length) field.options = ['選項一', '選項二'];
  if (field.type !== 'checkbox') { field.minSelect = ''; field.maxSelect = ''; }
  if (field.type === 'table' && !field.columns.length) {
    field.columns = [{ key: 'item', label: '項目', type: 'text' }];
  }
  if ((field.type === 'list' || field.type === 'table') && !field.itemLabel) field.itemLabel = '項目';
}

function nextFieldKey(fields) {
  const used = new Set(fields.map((f) => f.key));
  let i = fields.length + 1;
  while (used.has('f' + i)) i += 1;
  return 'f' + i;
}

function renderEditorBody() {
  const body = editor.dialog.querySelector('.editor-body');
  const keep = body.scrollTop;
  body.innerHTML = editorBody();
  bindEditorBody();
  body.scrollTop = keep;
}

function bindEditorBody() {
  const d = editor.draft;
  const body = editor.dialog.querySelector('.editor-body');
  const on = (selector, handler, event = 'input') => {
    body.querySelectorAll(selector).forEach((el) => el.addEventListener(event, () => { handler(el); markDirty(); }));
  };
  const onClick = (selector, handler) => {
    body.querySelectorAll(selector).forEach((el) => { el.onclick = () => { handler(el); markDirty(); renderEditorBody(); }; });
  };

  on('[data-ed]', (el) => { d[el.dataset.ed] = el.value; });
  on('[data-ref="caption"]', (el) => { d.reference.caption = el.value; });
  on('[data-refcol]', (el) => { d.reference.columns[Number(el.dataset.refcol)] = el.value; });
  on('[data-refcell-r]', (el) => {
    const r = Number(el.dataset.refcellR);
    if (!Array.isArray(d.reference.rows[r])) d.reference.rows[r] = [];
    d.reference.rows[r][Number(el.dataset.refcellC)] = el.value;
  });
  on('[data-f]', (el) => { d.fields[Number(el.dataset.idx)][el.dataset.f] = el.value; }, 'input');
  on('[data-f]', (el) => { d.fields[Number(el.dataset.idx)][el.dataset.f] = el.value; }, 'change');
  on('[data-opt]', (el) => { d.fields[Number(el.dataset.opt)].options[Number(el.dataset.oi)] = el.value; });
  on('[data-col]', (el) => { d.fields[Number(el.dataset.idx)].columns[Number(el.dataset.ci)][el.dataset.col] = el.value; }, 'input');
  on('[data-col]', (el) => { d.fields[Number(el.dataset.idx)].columns[Number(el.dataset.ci)][el.dataset.col] = el.value; }, 'change');
  on('[data-freq]', (el) => { d.fields[Number(el.dataset.freq)].required = el.checked; }, 'change');

  const refEnabled = body.querySelector('[data-ref-enabled]');
  if (refEnabled) {
    refEnabled.onchange = () => {
      d.reference.enabled = refEnabled.checked;
      if (d.reference.enabled && !d.reference.columns.length) d.reference.columns = ['欄位一', '欄位二'];
      markDirty(); renderEditorBody();
    };
  }
  onClick('[data-refcol-add]', () => {
    d.reference.columns.push('');
    d.reference.rows.forEach((r) => r.push(''));
  });
  onClick('[data-refcol-remove]', (el) => {
    const ci = Number(el.dataset.refcolRemove);
    d.reference.columns.splice(ci, 1);
    d.reference.rows.forEach((r) => r.splice(ci, 1));
  });
  onClick('[data-refrow-add]', () => { d.reference.rows.push(d.reference.columns.map(() => '')); });
  onClick('[data-refrow-remove]', (el) => { d.reference.rows.splice(Number(el.dataset.refrowRemove), 1); });

  body.querySelectorAll('[data-ftype]').forEach((el) => {
    el.onchange = () => {
      const field = d.fields[Number(el.dataset.ftype)];
      field.type = el.value;
      initFieldForType(field);
      markDirty(); renderEditorBody();
    };
  });
  onClick('[data-opt-add]', (el) => {
    const field = d.fields[Number(el.dataset.optAdd)];
    if (field.options.length >= MAX_OPTIONS) { notify(`選項最多 ${MAX_OPTIONS} 個。`); return; }
    field.options.push('');
  });
  onClick('[data-opt-remove]', (el) => {
    d.fields[Number(el.dataset.optRemove)].options.splice(Number(el.dataset.oi), 1);
  });
  onClick('[data-col-add]', (el) => {
    const field = d.fields[Number(el.dataset.colAdd)];
    if (field.columns.length >= 12) { notify('表格最多 12 欄。'); return; }
    field.columns.push({ key: 'c' + (field.columns.length + 1), label: '', type: 'text' });
  });
  onClick('[data-col-remove]', (el) => {
    d.fields[Number(el.dataset.colRemove)].columns.splice(Number(el.dataset.ci), 1);
  });
  onClick('[data-field-add]', () => {
    if (d.fields.length >= MAX_FIELDS) { notify(`一題最多 ${MAX_FIELDS} 個作答欄位。`); return; }
    d.fields.push(toFieldDraft({ key: nextFieldKey(d.fields), label: '', type: 'textarea' }));
  });
  onClick('[data-field-remove]', (el) => {
    const i = Number(el.dataset.fieldRemove);
    // 這裡不另外 confirm：欄位還沒存檔，關掉編輯器本來就等於沒發生；連問兩次只會讓人不看訊息就按確定。
    d.fields.splice(i, 1);
  });
  onClick('[data-field-up]', (el) => {
    const i = Number(el.dataset.fieldUp);
    if (i > 0) d.fields.splice(i - 1, 0, d.fields.splice(i, 1)[0]);
  });
  onClick('[data-field-down]', (el) => {
    const i = Number(el.dataset.fieldDown);
    if (i < d.fields.length - 1) d.fields.splice(i + 1, 0, d.fields.splice(i, 1)[0]);
  });
}

function setEditorBusy(busy) {
  editor.busy = busy;
  editor.dialog.querySelectorAll('.float-actions button, .float-top button').forEach((b) => { b.disabled = busy; });
}

function closeEditor() {
  if (!editor) return;
  const { dialog } = editor;
  editor = null;
  dialog.close();
  dialog.remove();
}

async function doSave() {
  if (!editor || editor.busy) return;
  let content;
  try {
    content = validateExercise(buildContent(editor.draft), editor.numberHint || 0);
  } catch (e) {
    notify(e.message);
    return;
  }
  setEditorBusy(true);
  try {
    if (editor.mode === 'create') {
      const qid = await addExercise(editor.code, content);
      S.qid = qid;
      notify('已新增一題，目前是未開放狀態。確認內容沒問題後，再到「課程進度｜練習開關」按開放。');
    } else {
      await saveExercise(editor.code, editor.qid, content, editor.expectedRev);
      S.qid = editor.qid;
      notify(editor.mode === 'replace'
        ? '修改已儲存。原題已封存（各組答案保留，只有該組自己看得到），這一題目前是未開放狀態。'
        : '題目已儲存。這一題目前是未開放狀態，確認內容後再開放。');
    }
    closeEditor();
    rerender();
  } catch (e) {
    // 存檔失敗（例如撞到樂觀鎖）時**不關閉編輯器**：講師畫面上的文字要留著讓他複製。
    notify(e.message);
    setEditorBusy(false);
  }
}

async function doCancel() {
  if (!editor || editor.busy) return;
  if (editor.mode === 'replace') {
    if (!confirm('取消修改會：解除原題的封存、刪掉這一份修改中的複本，以及剛剛為它產生的封存紀錄，等同這次修改沒有發生過。確定取消？')) return;
    setEditorBusy(true);
    try {
      const outcome = await cancelEdit(editor.code, editor.qid);
      closeEditor();
      notify(outcome.orphaned
        ? '已刪除這份修改中的複本。原題在這段期間已被其他裝置刪除，因此沒有可以解除封存的題目。'
        : '已取消修改，原題已解除封存，回到修改前的狀態。');
      rerender();
    } catch (e) {
      notify(e.message);
      setEditorBusy(false);
    }
    return;
  }
  if (editor.dirty && !confirm('尚未儲存的題目修改會被捨棄，確定關閉編輯器？')) return;
  closeEditor();
}

function openEditor(config) {
  if (editor) { notify('已經有一個題目編輯器開著，請先完成或取消那一份。'); return; }
  editor = { dirty: false, busy: false, ...config };
  const dialog = document.createElement('dialog');
  dialog.className = 'float-window editor-window';
  dialog.innerHTML = `<div class="float-top"><strong>${E(config.heading)}</strong><button type="button" data-close>關閉</button></div>
    <div class="float-body editor-body"></div>
    <div class="float-actions"><span class="muted editor-foot">${E(config.footNote || '')}</span>
      <button type="button" data-cancel>${E(config.cancelLabel || '取消')}</button>
      <button type="button" class="primary" data-save>${E(config.saveLabel || '儲存題目')}</button></div>`;
  document.body.appendChild(dialog);
  editor.dialog = dialog;
  dialog.showModal();
  renderEditorBody();
  dialog.querySelector('[data-close]').onclick = () => doCancel();
  dialog.querySelector('[data-cancel]').onclick = () => doCancel();
  dialog.querySelector('[data-save]').onclick = () => doSave();
  dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); doCancel(); });
}

// ──────────────────────────────────────────────────────────────────────────────
// 12.3 講師端的入口
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 關閉題目前的確認。
 *
 * 規劃文件的判準是「進入即視為正在作答，不論有沒有輸入」，所以依據是 live 的「已進入」標記
 * （live/<CODE>/entered/<gid>/<qid>），不是活動標記——活動標記只在欄位被碰過時才寫，
 * 學員可能進了題目卻一個字都還沒打，那也算正在作答。
 * 回傳 true 表示可以繼續關閉。
 */
export function confirmLockQuestion(qid) {
  const exDef = S.course.byQid[qid];
  if (!exDef) return false;
  const names = enteredGroups(qid)
    .map((gid) => (S.course.groups[gid] ? S.course.groups[gid].name : ''))
    .filter(Boolean);
  if (!names.length) return true;
  const answered = groupsAnswered(qid);
  return confirm(`已經有 ${names.length} 組進入這一題：${names.join('、')}${
    answered ? `（其中 ${answered} 組已有儲存的內容）` : '（尚無人按過儲存）'
  }。

關閉之後他們會立刻被切成「本題尚未開放」的畫面，**畫面上還沒按儲存的內容會留在他們的裝置上，但沒辦法再儲存**；已儲存的答案不受影響。

如果你接下來要修改這一題：原題與各組已儲存的答案會被封存，各組只看得到自己那一份、可以複製到新題，匯出檔則不會包含它們。

確定現在關閉？`);
}

/**
 * 編輯某一題。前置條件是「這一題必須先關閉」——用流程約束取代技術鎖，
 * 消除「講師編輯到一半、學員剛好存檔」的競態（題目關閉時 student.js 的 saveDraft 會直接擋下）。
 *
 * 沒有任何一組填過內容時直接就地修改，不封存也不複製：
 * 封存的意義是保住既有答案，一題都還沒人作答時封存只會留下一份需要講師回頭清理的重複題目。
 * 只要有任何一組有內容，就一律走「封存原題 → 複製新題」那條路。
 */
export async function beginEditQuestion(code, qid) {
  const exDef = S.course.byQid[qid];
  if (!exDef) { notify('找不到這一題，可能已被其他裝置刪除。'); return; }
  if (exDef.status !== 'active') { notify('這一題目前是封存狀態。請先在「已封存的題目」區塊按還原，再編輯。'); return; }
  const n = exNumber(qid);
  const label = `${n >= 0 ? exLabel(n) + '｜' : ''}${exDef.title || ''}`;
  if (!S.course.locks[qid]) {
    notify(`要編輯「${label}」必須先關閉這一題：關閉之後學員無法進入本題，已儲存的答案不會消失。請按這一列的「關閉${n >= 0 ? exLabel(n) : '本題'}」，再按一次「編輯」。`);
    return;
  }
  const answered = groupsAnswered(qid);
  if (!answered) {
    openEditor({
      mode: 'edit',
      code,
      qid,
      expectedRev: Number(exDef.rev) || 0,
      draft: toDraft(exDef),
      numberHint: n < 0 ? 0 : n,
      heading: `編輯題目｜${label}`,
      intro: `目前沒有任何一組在這一題填過內容，因此<b>直接就地修改</b>，不封存、也不複製出新題。取消就是什麼都沒發生。`,
      footNote: '存檔前會先檢查格式，格式不對會直接說明哪裡不對。',
    });
    return;
  }
  if (!confirm(`「${label}」已經有 ${answered} 組填過內容，因此會用「修改」的方式處理：

1. 原題連同各組答案一起封存（封存題不佔題號，也不會出現在匯出檔）。
2. 以原題內容複製出一題新的，由你編輯。
3. 各組在新題上會看到自己那一份封存內容，可以複製回來；別組看不到。

在編輯器裡按「取消修改」即可解除封存、刪掉新題，等同沒發生。之後若後悔，也可以在「已封存的題目」區塊把原題還原回來。

要開始修改嗎？`)) return;
  try {
    const newQid = await archiveForEdit(code, qid);
    openEditor({
      mode: 'replace',
      code,
      qid: newQid,
      origQid: qid,
      expectedRev: 0,
      draft: toDraft(exDef),
      numberHint: n < 0 ? 0 : n,
      heading: `修改題目｜${label}`,
      intro: `原題已封存，各組的答案都留著（只有該組自己看得到）。你現在編輯的是<b>複製出來的新題</b>，存檔後它會接在原本的題號上，預設為未開放。`,
      introWarn: true,
      cancelLabel: '取消修改（還原成沒發生）',
      footNote: '中途關掉整個頁面不會自動取消：那樣會留下一題未編輯的複本，可到「已封存的題目」區塊把原題還原、再刪掉不要的那一題。',
    });
  } catch (e) {
    notify(e.message);
  }
}

/** 新增一題（空白題目，走同一個編輯器）。沿用既有的 30 題上限。 */
export function beginNewQuestion(code) {
  const count = S.course.exercises.length;
  if (count >= MAX_EXERCISES) {
    notify(`練習數量已達上限 ${MAX_EXERCISES} 題，無法再新增。請先刪除不需要的練習（含「已封存的題目」裡不再需要的舊版本）。`);
    return;
  }
  openEditor({
    mode: 'create',
    code,
    draft: blankDraft(),
    numberHint: count,
    heading: '新增一題',
    intro: `新題預設為<b>未開放</b>：先把內容編好、存檔，再到「課程進度｜練習開關」按開放。取消就是什麼都沒發生（還沒有任何東西被寫進課程）。`,
    footNote: `目前 ${count} 題，上限 ${MAX_EXERCISES} 題。`,
    saveLabel: '新增這一題',
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 12.4 已封存的題目
//
// 只列出「因修改而封存」的題目。封存題的答案講師看不到（設計意圖是「講師不需要看到」，
// 不是權限管制——還原之後講師自然就看得到），所以這裡只顯示「幾組有答案」當作判斷依據。
// ──────────────────────────────────────────────────────────────────────────────
export function archivedSection() {
  const list = (S.course.archived || []).filter((exDef) => exDef.archiveReason === 'edit');
  if (!list.length) return '';
  return `<section class="manage card archived-card">
    <h2>已封存的題目（${list.length}）</h2>
    <p>這些是因為「修改」而封存的舊版本。封存題不佔題號、不出現在學員的題目切換列，答案也不會進匯出檔。
      還原之後就是一般題目（預設關閉、標題會加上「${E('（修改前版本）')}」以便分辨），可以再修改，也可以直接刪除。
      課程裡同時留著原版與修改版時，最後請自行刪掉不需要的那一題。</p>
    <div class="archived-list">${list.map((exDef) => {
    const replacement = exDef.replacedBy ? S.course.byQid[exDef.replacedBy] : null;
    const answered = groupsAnswered(exDef.qid);
    return `<div class="gate-row archived-row">
        <div><b>${E(exDef.title || '')}</b><div class="muted">已封存${
  replacement ? ` · 由「${E(replacement.title || '')}」取代` : ' · 取代它的題目已被刪除'
}${answered ? ` · ${answered} 組有答案` : ' · 沒有任何一組填過'}</div></div>
        <div class="toolbar">
          <button type="button" data-restore-ex="${E(exDef.qid)}">還原</button>
          <button type="button" class="danger" data-del-archived="${E(exDef.qid)}">刪除</button>
        </div>
      </div>`;
  }).join('')}</div>
  </section>`;
}

export function bindArchivedSection(code) {
  document.querySelectorAll('[data-restore-ex]').forEach((button) => {
    button.onclick = async () => {
      const qid = button.dataset.restoreEx;
      const exDef = S.course.byQid[qid];
      if (!exDef) return;
      if (!confirm(`還原「${exDef.title || ''}」？

還原後它會回到題目清單的原本位置、標題加上「（修改前版本）」，各組在這一題的答案都會回來。
還原的題目預設是<未開放>狀態，避免有人在一個即將被刪掉的題目上白做工。
課程裡會同時存在原版與修改版，請自行刪掉不需要的那一題。`)) return;
      button.disabled = true;
      try {
        const title = await restoreExercise(code, qid);
        S.qid = qid;
        notify(`已還原「${title}」，目前是未開放狀態。`);
      } catch (e) { notify(e.message); button.disabled = false; }
    };
  });
  document.querySelectorAll('[data-del-archived]').forEach((button) => {
    button.onclick = async () => {
      const qid = button.dataset.delArchived;
      const exDef = S.course.byQid[qid];
      if (!exDef) return;
      const answered = groupsAnswered(qid);
      if (!confirm(`確定永久刪除已封存的「${exDef.title || ''}」？${
        answered ? `\n\n這一題有 ${answered} 組的答案會一併永久刪除。` : ''
      }\n\n刪除是唯一讓資料真正消失的動作，無法復原。學員已經在新題上看到的封存內容不受影響。`)) return;
      button.disabled = true;
      try {
        await deleteExercise(code, S.course, qid);
        // 跟刪除一般題目一樣：題目沒了，掛在它身上的 live 輔助標記（橘點、已進入）
        // 留著只是永遠不會被讀到的垃圾。
        await clearActivityForQuestion(code, qid);
        await clearEnteredForQuestion(code, qid);
        notify(`已刪除已封存的「${exDef.title || ''}」。`);
      } catch (e) { notify(e.message); button.disabled = false; }
    };
  });
}
