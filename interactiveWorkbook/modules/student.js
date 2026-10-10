import {
  S, myGroup, fieldsOf, currentEx, exNumber, firstQid,
} from './state.js';
import { E, exLabel, notify } from './util.js';
import {
  shell, tabs, bindTabs, identityBar, bindIdentityBar, noQuestionsNotice, archiveWindow,
} from './ui.js';
import { validateAnswer } from './schema.js';
import { saveAnswer, archivesFor } from './data.js';
import { markActivity, markEntered } from './live.js';
import {
  canEdit, myEditLock, editLockBanner, mountEditLock, unmountEditLock,
  touchLock, releaseLock, resetEditLock,
} from './editlock.js';
// 循環 import（student → teacher → ui → student）：只在函式體內使用，不在模組頂層執行期取值。
import { answerText } from './teacher.js';
import { askConfirm } from './dialog.js';
import {
  uploadImage, deleteImage, imageIdsIn, thumbHTML, hydrateImages,
} from './images.js';

// ──────────────────────────────────────────────────────────────────────────────
// 8. 學員作答畫面
// ──────────────────────────────────────────────────────────────────────────────
export function applyDefaults() {
  fieldsOf(S.qid).forEach((f) => {
    if (f.type === 'checkbox' && !Array.isArray(S.draft[f.key])) S.draft[f.key] = [];
    if (f.type === 'radio' && S.draft[f.key] == null) S.draft[f.key] = '';
    if (f.type === 'list' && !Array.isArray(S.draft[f.key])) {
      S.draft[f.key] = Array.from({ length: Math.max(1, f.minItems || 0) }, () => '');
    }
    if (f.type === 'table' && !Array.isArray(S.draft[f.key])) {
      const n = Math.max(1, Math.min(f.minRows || 1, 12));
      S.draft[f.key] = Array.from({ length: n }, () => Object.fromEntries(f.columns.map((c) => [c.key, ''])));
    }
    if (['text', 'textarea', 'number', 'date'].includes(f.type) && S.draft[f.key] == null) S.draft[f.key] = '';
    if (f.type === 'image' && typeof S.draft[f.key] !== 'string') S.draft[f.key] = '';
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 圖片欄位（每個欄位 1 張）
//
// 上傳只是先把圖片放進 images/<CODE>/<gid>/<qid>/<imgId>，答案仍要按「儲存」才算數（與其他欄位一致）。
// 「已上傳、還沒儲存」的圖記在 pendingUploads：它從未被任何已存答案引用，所以
//   - 存檔前又換一張或按移除 → 立即刪掉前一張；
//   - 草稿被捨棄（切題確認捨棄、重新載入本題、離開本組）→ 在下一次畫面重畫／離開時刪掉。
// 已存答案裡的舊圖，要等新答案存檔成功之後才刪（見 saveDraft），而且封存紀錄還引用它時不刪。
// ──────────────────────────────────────────────────────────────────────────────
/** `${qid}|${key}` → { code, gid, qid, key, imgId }：已上傳但還沒存進答案的圖片 */
const pendingUploads = new Map();
/** `${qid}|${key}` → 目前狀態文字（壓縮中…／上傳中…）；放模組層級，重畫也不會掉 */
const uploadState = new Map();

const imgSlot = (qid, key) => `${qid}|${key}`;

function dropPending(p) {
  pendingUploads.delete(imgSlot(p.qid, p.key));
  deleteImage(p.code, p.gid, p.qid, p.imgId).catch(() => { /* 清不掉只是留下該組底下的垃圾，刪組／重置時會一併清 */ });
}

/** 草稿已經不再引用的未儲存上傳（切題、重新載入、換組）一律刪掉 */
function prunePending() {
  pendingUploads.forEach((p) => {
    const stillHere = S.session && S.session.code === p.code && S.session.gid === p.gid
      && S.qid === p.qid && S.draft[p.key] === p.imgId;
    if (!stillHere) dropPending(p);
  });
}

/** 離開本組（或更正身分）時：這台裝置所有未儲存的上傳都不會再被引用 */
function flushPending(session) {
  pendingUploads.forEach((p) => { if (!session || (p.code === session.code && p.gid === session.gid)) dropPending(p); });
}

function paintImageStatus(key, text) {
  const el = document.querySelector(`[data-image-status="${CSS.escape(key)}"]`);
  if (el) el.textContent = text;
}

export function renderImageField(f) {
  const imgId = S.draft[f.key] || '';
  const slot = imgSlot(S.qid, f.key);
  const busy = uploadState.get(slot) || '';
  const pending = pendingUploads.get(slot);
  const statusText = busy || (pending && pending.imgId === imgId ? '已上傳，請記得按「儲存」才算數。' : '');
  const id = 'img-' + f.key.replace(/[^\w-]/g, '_');
  return `<div class="form-field image-field" data-image-field="${E(f.key)}"><label for="${id}">${E(f.label)}${
    f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
    f.hint ? `<p class="muted">${E(f.hint)}</p>` : ''
  }<div class="img-field-body">${
    imgId
      ? thumbHTML({
        code: S.session.code, gid: S.session.gid, qid: S.qid, imgId, title: f.label, cls: 'img-thumb-student',
      })
      : '<div class="img-empty">尚未上傳圖片</div>'
  }<div class="img-actions"><label class="img-pick${busy ? ' is-busy' : ''}"><input id="${id}" type="file" accept="image/*" data-image-input="${E(f.key)}"${busy ? ' disabled' : ''}><span>${
    imgId ? '更換' : '上傳圖片'
  }</span></label>${
    imgId ? `<button type="button" class="danger small" data-image-remove="${E(f.key)}"${busy ? ' disabled' : ''}>移除</button>` : ''
  }</div></div><p class="muted img-status" role="status" data-image-status="${E(f.key)}">${E(statusText)}</p></div>`;
}

async function onImagePicked(input) {
  const key = input.dataset.imageInput;
  const file = input.files && input.files[0];
  input.value = ''; // 同一個檔案再選一次也要觸發 change
  if (!file || !S.session || !S.session.gid) return;
  if (!canEdit(S.session.gid) || S.course.locks[S.qid]) {
    notify('你目前沒有編輯權（或這一題已關閉），沒辦法上傳圖片。');
    return;
  }
  const { code, gid } = S.session;
  const qid = S.qid;
  const slot = imgSlot(qid, key);
  if (uploadState.has(slot)) return;
  touchMine();
  markActivity(code, gid, qid, key);
  uploadState.set(slot, '壓縮中…');
  renderStudent();
  try {
    const imgId = await uploadImage(code, gid, qid, key, file, (stage) => {
      const text = stage === 'upload' ? '上傳中…' : '壓縮中…';
      uploadState.set(slot, text);
      paintImageStatus(key, text);
    });
    // 上傳期間已經離開這一題／這一組：這張圖不會再被引用，直接刪掉。
    if (!S.session || S.session.code !== code || S.session.gid !== gid || S.qid !== qid) {
      deleteImage(code, gid, qid, imgId).catch(() => {});
      return;
    }
    const prev = pendingUploads.get(slot);
    if (prev && prev.imgId !== imgId) dropPending(prev); // 存檔前又換了一張：前一張從未被引用，立即刪
    pendingUploads.set(slot, {
      code, gid, qid, key, imgId,
    });
    S.draft[key] = imgId;
    markDirty();
  } catch (e) {
    notify((e && e.message) || '圖片上傳失敗，請再試一次。');
  } finally {
    uploadState.delete(slot);
    if (S.session && S.session.role === 'student' && S.qid === qid) renderStudent();
  }
}

function bindImageFields() {
  document.querySelectorAll('[data-image-input]').forEach((el) => el.addEventListener('change', () => onImagePicked(el)));
  document.querySelectorAll('[data-image-remove]').forEach((el) => el.addEventListener('click', () => {
    const key = el.dataset.imageRemove;
    const slot = imgSlot(S.qid, key);
    const pending = pendingUploads.get(slot);
    if (pending && pending.imgId === S.draft[key]) dropPending(pending); // 還沒存過的那張直接刪
    // 已存答案裡的那張要等存檔成功才刪（不按儲存就等於沒移除）
    S.draft[key] = '';
    markDirty();
    renderStudent();
  }));
  hydrateImages(document.querySelector('#fields'));
}

export function fieldBox(key, label, type, value, opts = {}) {
  const id = 'f-' + key.replace(/[^\w-]/g, '_');
  const star = opts.required ? ' <span aria-hidden="true">＊</span>' : '';
  const control = type === 'textarea'
    ? `<textarea id="${id}" data-field="${E(key)}">${E(value ?? '')}</textarea>`
    : `<input id="${id}" data-field="${E(key)}" type="${type}" ${type === 'number' ? 'min="0" step="1"' : ''} value="${E(value ?? '')}">`;
  return `<div class="form-field"><label for="${id}">${E(label)}${star}</label>${
    opts.hint ? `<p class="muted">${E(opts.hint)}</p>` : ''}${control}</div>`;
}

export function renderReference(refDef) {
  if (!refDef) return '';
  return `<div class="table-scroll"><table class="data-table">${
    refDef.caption ? `<caption>${E(refDef.caption)}</caption>` : ''
  }<thead><tr>${(refDef.columns || []).map((c) => `<th>${E(c)}</th>`).join('')}</tr></thead><tbody>${
    (refDef.rows || []).map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th>${E(c)}</th>` : `<td>${E(c)}</td>`)).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

export function renderListField(f) {
  const items = S.draft[f.key] || [];
  return `<div class="form-field"><label>${E(f.label)}${f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
    f.minItems ? `<p class="muted">至少填 ${f.minItems} 項。</p>` : ''
  }${items.map((v, i) => `<div class="row-card list-item"><div class="toolbar"><h3>${E(f.itemLabel || '項目')} ${i + 1}</h3>${
    items.length > 1 ? `<button type="button" class="danger small" data-list-remove="${E(f.key)}" data-idx="${i}">移除</button>` : ''
  }</div>${
    f.itemType === 'text'
      ? `<input data-list="${E(f.key)}" data-idx="${i}" type="text" value="${E(v)}">`
      : `<textarea data-list="${E(f.key)}" data-idx="${i}">${E(v)}</textarea>`
  }</div>`).join('')}<button type="button" data-list-add="${E(f.key)}">＋ 新增${E(f.itemLabel || '項目')}</button></div>`;
}

export function renderTableField(f) {
  const rows = S.draft[f.key] || [];
  return `<div class="form-field"><label>${E(f.label)}${f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
    f.minRows ? `<p class="muted">至少填 ${f.minRows} 列。</p>` : ''
  }${rows.map((row, i) => `<section class="row-card"><div class="toolbar"><h3>${E(f.itemLabel || '項目')} ${i + 1}</h3>${
    rows.length > 1 ? `<button type="button" class="danger small" data-table-remove="${E(f.key)}" data-idx="${i}">移除</button>` : ''
  }</div><div class="row-grid" style="grid-template-columns:repeat(${f.columns.length},minmax(0,1fr))">${
    f.columns.map((c) => `<div class="form-field"><label>${E(c.label)}</label><input data-table="${E(f.key)}" data-col="${E(c.key)}" data-idx="${i}" type="${
      c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text'
    }" ${c.type === 'number' ? 'min="0" step="1"' : ''} value="${E(row[c.key] || '')}"></div>`).join('')
  }</div></section>`).join('')}<button type="button" data-table-add="${E(f.key)}">＋ 新增${E(f.itemLabel || '項目')}</button></div>`;
}

export function renderChoiceField(f) {
  if (f.type === 'radio') {
    return `<div class="form-field"><label>${E(f.label)}${f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
      f.options.map((o, i) => `<label class="choice"><input type="radio" name="radio-${E(f.key)}" data-radio="${E(f.key)}" value="${E(o)}" ${
        S.draft[f.key] === o ? 'checked' : ''
      }><span>${i + 1}．${E(o)}</span></label>`).join('')
    }</div>`;
  }
  const selected = S.draft[f.key] || [];
  const limitHit = f.maxSelect != null && selected.length >= f.maxSelect;
  return `<div class="form-field"><label>${E(f.label)}${f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
    f.maxSelect != null ? `<p class="muted">已選 ${selected.length}／${f.maxSelect} 項${
      f.minSelect != null && f.minSelect !== f.maxSelect ? `（至少 ${f.minSelect} 項）` : ''
    }</p>` : ''
  }${f.options.map((o, i) => `<label class="choice"><input type="checkbox" data-checkbox="${E(f.key)}" data-idx="${i}" ${
    selected.includes(i) ? 'checked' : ''
  } ${limitHit && !selected.includes(i) ? 'disabled' : ''}><span>${E(o)}</span></label>`).join('')}</div>`;
}

export function renderField(f) {
  if (f.type === 'radio' || f.type === 'checkbox') return renderChoiceField(f);
  if (f.type === 'list') return renderListField(f);
  if (f.type === 'table') return renderTableField(f);
  if (f.type === 'image') return renderImageField(f);
  const inputType = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'text' ? 'text' : 'textarea';
  return fieldBox(f.key, f.label, inputType, S.draft[f.key], { required: f.required, hint: f.hint });
}

/**
 * 封存內容提示。來源有兩種，共用同一個節點與同一個浮動視窗：
 * （1）講師合併小組時選了「兩者皆保留」的那一份；
 * （2）講師修改題目時，原題連同各組答案被封存，封存的那一份會掛在**新題**的 qid 上，
 *      所以學員一進到新題就看得到入口，可以把舊答案複製回來。
 * 封存只有該組自己看得到，也不進匯出檔——這一點要寫在畫面上，避免學員以為講師已經收到。
 */
export function archiveNotice() {
  const group = myGroup();
  const records = archivesFor(group, S.qid);
  if (!records.length) return '';
  return `<div class="notice archive-notice"><b>這一題有 ${records.length} 筆封存內容。</b>這是過去保留下來的答案，只有你們這一組看得到，不會出現在講師的匯出檔裡。需要的話可以複製回目前的作答欄位。<div class="toolbar"><button type="button" id="open-archives">看封存內容</button></div></div>`;
}

export function bindArchiveNotice() {
  const button = document.querySelector('#open-archives');
  if (!button) return;
  button.onclick = () => {
    const exDef = currentEx();
    const group = myGroup();
    const records = archivesFor(group, S.qid).map((rec) => {
      let parsed = {};
      try { parsed = JSON.parse(rec.json) || {}; } catch { parsed = {}; }
      return {
        id: rec.id,
        label: rec.label || '封存內容',
        savedAt: rec.savedAt,
        text: exDef ? answerText(exDef, parsed) : '',
      };
    });
    const n = exNumber(S.qid);
    const where = exDef ? `${n >= 0 ? `${exLabel(n)}｜` : ''}${exDef.title || ''}` : '這一題';
    archiveWindow(records, { title: `${where}｜封存內容` });
  };
}

/**
 * 編輯權變動的處理。
 *
 * 為什麼可以直接重畫：學員打的字在每一個 input 事件就寫進 S.draft 了，renderStudent() 是從 S.draft
 * 畫出來的，所以重畫不會讓畫面上的文字消失——只是欄位變成唯讀，內容留在那裡讓他自己複製。
 * 依規劃文件，被接手者未儲存的內容不做額外保護，但一定要讓他知道發生了什麼事。
 */
function handleEditLockChange(event) {
  if (!S.session || S.session.role !== 'student') return;
  if (event && event.kind === 'takenOver') {
    const who = event.holderName ? `「${event.holderName}」` : '同組的其他裝置';
    notify(`${who}已接手本組的編輯權，你的畫面已切換為唯讀。畫面上的文字會留著讓你複製，但沒辦法再儲存；要繼續填寫請跟對方講一聲，或等對方閒置 5 分鐘之後接手。`);
  }
  renderStudent();
}

/** 任何動作都讓閒置計時歸零。節流由 editlock.js 負責，這裡不必自己節流。 */
export function touchMine() {
  if (!S.session || S.session.role !== 'student' || !S.session.gid) return;
  touchLock(S.session.code, S.session.gid);
}

/**
 * 「離開本組」與身分列的「更正」都要釋放編輯權。
 * 這兩顆按鈕分別由 shell() 與 bindIdentityBar() 綁定（都在 ui.js），所以這裡用包一層的方式處理：
 * 兩者都是「真的離開了才把 S.session 清成 null」，用這一點就能分辨使用者有沒有在提示窗按取消。
 * 原 handler 是 async（要等使用者在自製提示窗按下確定，S.session 才會被清掉），
 * 所以這裡必須 await 它的回傳值之後再檢查，不能呼叫完就同步檢查。
 */
function bindLeaveRelease() {
  ['#logout', '#fix-identity'].forEach((selector) => {
    const button = document.querySelector(selector);
    if (!button || button.dataset.editlockWrapped) return;
    const original = button.onclick;
    if (typeof original !== 'function') return;
    button.dataset.editlockWrapped = '1';
    button.onclick = async (ev) => {
      const before = S.session;
      const result = await original.call(button, ev);
      if (before && before.gid && !S.session) {
        flushPending(before);
        releaseLock(before.code, before.gid);
        resetEditLock();
      }
      return result;
    };
  });
}

/**
 * 切換題目也算動作。bindTabs() 在 ui.js，這裡同樣用包一層的方式補上 touch。
 * 原 handler 是 async，這裡只是先 touch 再把它的 Promise 原樣回傳，不需要等它。
 */
function bindTabTouch() {
  document.querySelectorAll('[data-qid]').forEach((button) => {
    const original = button.onclick;
    if (typeof original !== 'function' || button.dataset.editlockWrapped) return;
    button.dataset.editlockWrapped = '1';
    button.onclick = (ev) => { touchMine(); return original.call(button, ev); };
  });
}

export function renderStudent() {
  const group = myGroup();
  if (!group) return;
  prunePending();
  if (!S.course.exercises.length) {
    unmountEditLock();
    shell(`${identityBar()}${noQuestionsNotice()}`);
    bindIdentityBar();
    bindLeaveRelease();
    return;
  }
  // qid 指不到任何已開放題目時（例如講師剛把這一題刪掉）先回到第一題，不要把畫面停在空白。
  if (exNumber(S.qid) < 0) S.qid = firstQid();
  const exDef = currentEx();
  if (!exDef) {
    unmountEditLock();
    shell(`${identityBar()}${noQuestionsNotice()}`);
    bindIdentityBar();
    bindLeaveRelease();
    return;
  }
  const n = exNumber(S.qid);
  if (S.course.locks[S.qid]) {
    // 鎖是**整組共用、不綁題目**，所以未開放畫面也要留著編輯權橫幅：
    // 講師關掉這一題時，持有者才還能主動交出、同組其他人才看得到狀態。
    // 橫幅拿掉的話，課程只有一題時這段空窗會整堂課存在，同組只能等閒置 5 分鐘。
    shell(`${editLockBanner(S.session.gid)}${identityBar()}${tabs()}<section class="card waiting">
      <div class="eyebrow">依課程進度開放</div><h1>${exLabel(n)}尚未開放</h1>
      <p>請等候講師開放，再進入本題作答。</p><p>其他已開放的練習，可從上方按鈕進入。</p>
      ${S.dirty ? '<div class="notice warn">本題未儲存的修改暫留在此頁；請勿重新整理或離開，待講師重新開放後儲存。</div>' : ''}
      ${archiveNotice()}
      <p id="save-state" role="status" class="muted">開放狀態會即時更新，不需重新整理。</p></section>`);
    bindTabs();
    bindIdentityBar();
    bindArchiveNotice();
    bindLeaveRelease();
    bindTabTouch();
    mountEditLock(S.session.code, S.session.gid, { onChange: handleEditLockChange });
    return;
  }
  // 「已進入」標記：規劃文件的判準是「進入即視為正在作答，不論有沒有輸入」，
  // 所以寫在這裡（真的看到作答畫面）而不是在欄位 focus 時。同一組同一題只會寫一次（live.js 自己去重）。
  markEntered(S.session.code, S.session.gid, S.qid);
  const editable = canEdit(S.session.gid);
  shell(`${editLockBanner(S.session.gid)}${identityBar()}${tabs()}
    <div class="card">
      <span class="badge">${exLabel(n)}${exDef.time ? ' · ' + E(exDef.time) : ''}</span>
      <h1>${E(exDef.title)}</h1>
      ${exDef.goal ? `<p>${E(exDef.goal)}</p>` : ''}
      ${archiveNotice()}
      <fieldset id="fields"${editable ? '' : ' disabled'} style="border:0;padding:0;margin:0;min-width:0">
        ${exDef.notice ? `<div class="notice">${E(exDef.notice)}</div>` : ''}
        ${renderReference(exDef.reference)}
        ${exDef.fields.map(renderField).join('')}
      </fieldset>
    </div>
    <div class="savebar">
      <span id="save-state">${S.dirty ? '尚未儲存' : (group.updated[S.qid] ? '已儲存 ' + new Date(group.updated[S.qid]).toLocaleString('zh-TW') : '尚未作答')}${
    group.complete[S.qid] ? ' · 已完成' : ''
  }</span>
      <button id="reload">重新載入本題</button>
      <button id="save"${editable ? '' : ' disabled'}>儲存草稿</button>
      <button class="primary" id="complete"${editable ? '' : ' disabled'}>標記完成並儲存</button>
    </div>`);
  bindTabs();
  bindIdentityBar();
  bindArchiveNotice();
  bindFieldEvents();
  bindLeaveRelease();
  bindTabTouch();
  mountEditLock(S.session.code, S.session.gid, { onChange: handleEditLockChange });
  document.querySelector('#save').onclick = () => saveDraft(false);
  document.querySelector('#complete').onclick = () => saveDraft(true);
  document.querySelector('#reload').onclick = async () => {
    if (S.busy) return;
    if (S.dirty && !(await askConfirm('重新載入會捨棄畫面上未儲存的修改，確定繼續？', {
      title: '重新載入', okLabel: '捨棄並重新載入', danger: true,
    }))) return;
    // 提示窗開著的期間可能已經離開本組（或組別被講師刪除）。
    if (!S.session || S.session.role !== 'student') return;
    const g = myGroup();
    if (!g) return;
    S.draft = structuredClone(g.answers[S.qid] || {});
    S.revision = g.revision[S.qid] || 0;
    S.dirty = false;
    applyDefaults();
    renderStudent();
  };
}

export function bindFieldEvents() {
  document.querySelectorAll('[data-field]').forEach((el) => el.addEventListener('input', () => {
    S.draft[el.dataset.field] = el.value; markDirty();
  }));
  document.querySelectorAll('[data-radio]').forEach((el) => el.addEventListener('change', () => {
    S.draft[el.dataset.radio] = el.value; markDirty();
  }));
  document.querySelectorAll('[data-checkbox]').forEach((el) => el.addEventListener('change', () => {
    const key = el.dataset.checkbox;
    const i = Number(el.dataset.idx);
    const current = S.draft[key] || [];
    S.draft[key] = el.checked ? [...current, i] : current.filter((x) => x !== i);
    markDirty(); renderStudent();
  }));
  document.querySelectorAll('[data-list]').forEach((el) => el.addEventListener('input', () => {
    S.draft[el.dataset.list][Number(el.dataset.idx)] = el.value; markDirty();
  }));
  document.querySelectorAll('[data-list-add]').forEach((el) => el.addEventListener('click', () => {
    S.draft[el.dataset.listAdd].push(''); markDirty(); renderStudent();
  }));
  document.querySelectorAll('[data-list-remove]').forEach((el) => el.addEventListener('click', () => {
    S.draft[el.dataset.listRemove].splice(Number(el.dataset.idx), 1); markDirty(); renderStudent();
  }));
  document.querySelectorAll('[data-table]').forEach((el) => el.addEventListener('input', () => {
    S.draft[el.dataset.table][Number(el.dataset.idx)][el.dataset.col] = el.value; markDirty();
  }));
  document.querySelectorAll('[data-table-add]').forEach((el) => el.addEventListener('click', () => {
    const key = el.dataset.tableAdd;
    const f = fieldsOf(S.qid).find((x) => x.key === key);
    S.draft[key].push(Object.fromEntries(f.columns.map((c) => [c.key, ''])));
    markDirty(); renderStudent();
  }));
  document.querySelectorAll('[data-table-remove]').forEach((el) => el.addEventListener('click', () => {
    S.draft[el.dataset.tableRemove].splice(Number(el.dataset.idx), 1); markDirty(); renderStudent();
  }));
  bindImageFields();
  bindActivityMarks();
}

/**
 * 投影的橘點：欄位 focus 時寫入一次活動標記。
 *
 * 傳給 markActivity 的 key 一律是**題目定義裡 field 的 key**（renderField 把它放進
 * data-field／data-radio／data-checkbox／data-list／data-table），與 projection.js 產生
 * 點 id（`dot-<gid>-<qid>-<f.key>`）用的是同一個值——對不上的話橘點會亮在別的欄位。
 * 表格欄位的 data-col 是欄的 key，不是欄位 key，這裡刻意不取它。
 *
 * 只有握有編輯權的裝置才寫：唯讀的人只是在看，不該在投影上留下「已被點過」的訊號。
 * 去重（同一欄位只寫一次）由 live.js 自己處理；fire-and-forget，寫失敗不提示、不擋輸入。
 */
function bindActivityMarks() {
  if (!S.session || !S.session.gid) return;
  const mark = (key) => {
    if (!key || !canEdit(S.session.gid)) return;
    markActivity(S.session.code, S.session.gid, S.qid, key);
  };
  [
    ['[data-field]', 'field'],
    ['[data-radio]', 'radio'],
    ['[data-checkbox]', 'checkbox'],
    ['[data-list]', 'list'],
    ['[data-table]', 'table'],
    ['[data-image-input]', 'imageInput'],
  ].forEach(([selector, prop]) => {
    document.querySelectorAll(selector).forEach((el) => {
      el.addEventListener('focus', () => mark(el.dataset[prop]));
    });
  });
  // 圖片欄位的檔案選擇框藏在「上傳圖片」按鈕（label）裡，點按鈕時不一定會先 focus，所以 click 也算。
  document.querySelectorAll('[data-image-input]').forEach((el) => {
    el.addEventListener('click', () => mark(el.dataset.imageInput));
  });
}

export function markDirty() {
  S.dirty = true;
  // 欄位輸入、新增／移除清單列或表格列，全部都會先走到這裡，所以閒置歸零放這裡一次就夠。
  touchMine();
  const el = document.querySelector('#save-state');
  if (el) el.textContent = '尚未儲存，請按儲存草稿';
}

/**
 * 存檔成功後的圖片清理：
 * - 這一題的未儲存上傳：已被新答案引用的轉為正式（從 pending 移除）；沒被引用的（例如格式不對被清掉）刪掉。
 * - 原本已存答案裡、新答案不再引用的舊圖：刪掉——但本組封存紀錄（archives）的 json 還引用它時保留，
 *   封存紀錄要能看到當時的圖。失敗不提示：答案已經存好，留下的只是該組底下的垃圾，刪組／重置時會一併清。
 */
function cleanupImagesAfterSave(qid, previousIds, cleaned) {
  const { code, gid } = S.session;
  const nowIds = imageIdsIn(cleaned);
  pendingUploads.forEach((p) => {
    if (p.qid !== qid || p.code !== code || p.gid !== gid) return;
    if (nowIds.has(p.imgId)) pendingUploads.delete(imgSlot(p.qid, p.key));
    else dropPending(p);
  });
  const group = myGroup();
  const archived = Object.values((group && group.archives) || {}).map((rec) => String(rec.json || ''));
  previousIds.forEach((id) => {
    if (nowIds.has(id)) return;
    if (archived.some((json) => json.includes(id))) return;
    deleteImage(code, gid, qid, id).catch(() => {});
  });
}

export async function saveDraft(complete) {
  if (S.busy || S.course.locks[S.qid]) return;
  // 唯讀狀態直接擋下，不送出任何寫入，並且講清楚為什麼與怎麼辦。
  if (!canEdit(S.session.gid)) {
    const info = myEditLock(S.session.gid);
    notify(info.exists
      ? `本組目前由${info.holderName ? `「${info.holderName}」` : '同組的另一台裝置'}填寫，你的畫面是唯讀的，沒辦法儲存。要換你填請按畫面上方的「接手編輯」，或請對方按「交出編輯權」。`
      : '你還沒有取得本組的編輯權，沒辦法儲存。請按畫面上方的「開始填寫（取得編輯權）」。');
    return;
  }
  touchMine();
  S.busy = true;
  const fields = document.querySelector('#fields');
  const saveBtn = document.querySelector('#save');
  const completeBtn = document.querySelector('#complete');
  if (fields) fields.disabled = true;
  if (saveBtn) saveBtn.disabled = true;
  if (completeBtn) completeBtn.disabled = true;
  try {
    const cleaned = validateAnswer(currentEx(), S.draft, complete);
    const group = myGroup();
    // 存檔成功後要比對：原本已存的答案裡有哪些圖被換掉／移除了（見下方清理）。
    const savedQid = S.qid;
    const previousIds = imageIdsIn(group.answers[savedQid] || {});
    // 記下「這次是誰存的」：同組多人輪流操作時，講師匯出才看得出最後由誰送出。
    const savedBy = (S.session && S.session.author) || group.author;
    const newRevision = await saveAnswer(S.session.code, S.session.gid, S.qid, cleaned, S.revision, complete, savedBy);
    S.revision = newRevision;
    cleanupImagesAfterSave(savedQid, previousIds, cleaned);
    S.draft = structuredClone(cleaned);
    applyDefaults();
    S.dirty = false;
    S.lastStudentSignature = '';
    notify(complete ? '已完成並交給講師。' : '草稿已儲存。');
    renderStudent();
  } catch (e) {
    notify(e.message);
  } finally {
    S.busy = false;
    // 存檔期間可能剛好被接手，所以不是無條件解除停用，而是回到「現在到底能不能編輯」的狀態。
    const stillEditable = canEdit(S.session.gid);
    if (fields) fields.disabled = !stillEditable;
    if (saveBtn) saveBtn.disabled = !stillEditable;
    if (completeBtn) completeBtn.disabled = !stillEditable;
  }
}
