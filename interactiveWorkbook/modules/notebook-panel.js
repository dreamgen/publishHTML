import { S, myGroup } from './state.js';
import { E, notify } from './util.js';
import { askConfirm } from './dialog.js';
import { Notebook } from './notebook.js';
import { paragraphs, addParagraph, setScope, deleteParagraph, splitParagraph, plainText } from './notebook-model.js';
import { EditorView, EditorState, Compartment, keymap, placeholder, defaultKeymap, insertNewline, yCollab, yUndoManagerKeymap } from '../vendor/notebook-editor.js';

let panel, queued = false, rows = new Map(), viewDoc;
const state = () => S.notebook;
function changed() {
  if (queued) return;
  queued = true; queueMicrotask(() => { queued = false; render(); });
}
function questionLabel(scope) {
  if (!scope?.qid) return '全局';
  const ex = S.course?.byQid[scope.qid];
  if (!ex) return `${scope.label || '原題目'}（已移除）`;
  const index = S.course.exercises.findIndex((q) => q.qid === scope.qid);
  return index >= 0 ? `練習 ${index + 1}｜${ex.title}` : `${ex.title}（已封存）`;
}
function availableScopes() {
  return [{ qid: null, label: '全局' }, ...(S.course?.exercises || []).map((ex, i) => ({ qid: ex.qid, label: `練習 ${i + 1}｜${ex.title}` }))];
}
function scopesWithHistory(doc) {
  const choices = new Map(availableScopes().map((s) => [s.qid || '', s]));
  for (const { value } of paragraphs(doc)) {
    const scope = value.get('scope');
    if (scope?.qid && !choices.has(scope.qid)) choices.set(scope.qid, { ...scope, label: questionLabel(scope), historical: true });
  }
  return [...choices.values()];
}
function options(scopes, filter = false) {
  return `${filter ? '<option value="*">全部</option>' : ''}${scopes.map((s) => `<option value="${E(s.qid || '')}"${!filter && s.historical ? ' disabled' : ''}>${E(s.label)}</option>`).join('')}`;
}
function newScope() {
  const filter = state().filter;
  if (filter === '*' || !filter) return { qid: null, label: '全局' };
  const scope = availableScopes().find((s) => s.qid === filter);
  if (!scope) throw Error('原題目已移除或封存，請先選擇其他題目或全局再新增。');
  return scope;
}
function editable() { const n = state()?.controller; return n && n.ready && !n.frozen; }
function saveText(text, name = '小組記事本') {
  const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${name}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function destroyRows() { rows.forEach((r) => r.view.destroy()); rows.clear(); viewDoc = null; }
function syncBackground() {
  const app = document.querySelector('#app');
  if (app) app.inert = !!state()?.open && matchMedia('(max-width:760px)').matches;
}
window.addEventListener('resize', syncBackground);
function hide() {
  if (!state()) return;
  state().open = false; state().controller.setVisible(false);
  panel.hidden = true; document.body.classList.remove('notebook-open'); syncBackground();
  document.querySelector('#open-notebook')?.focus();
}
function mount() {
  if (panel) return;
  panel = document.createElement('aside'); panel.id = 'notebook-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', '小組共編記事本');
  panel.innerHTML = `<div class="nb-heading"><div><strong id="nb-title">小組記事本</strong><small>同組共用・自動同步</small></div><button id="nb-close">收合</button></div>
    <div class="nb-toolbar"><label for="nb-filter">題目篩選</label><select id="nb-filter"></select><button id="nb-add">＋新增段落</button></div>
    <div class="nb-info"><span id="nb-status" role="status" aria-live="polite"></span><button id="nb-retry">重試同步</button><small id="nb-members"></small></div>
    <div id="nb-recovery" hidden><span>有先前版本的未同步內容。</span><button id="nb-download-recovery">下載保留內容</button></div>
    <div id="nb-rows"></div><p id="nb-empty">目前沒有段落，新增一段記下討論重點。</p>
    <div class="nb-footer"><button id="nb-copy">複製目前篩選內容</button><button id="nb-download">下載目前內容</button>
    <details><summary>更多</summary><button id="nb-download-all">下載整本</button><button id="nb-clear">清空整本</button><button id="nb-restore">復原上次清空</button><button id="nb-deleted">復原已刪段落</button></details>
    <small>討論紀錄不會自動成為正式答案，也不包含在答案匯出檔。</small></div>`;
  document.body.appendChild(panel);
  panel.querySelector('#nb-close').onclick = hide;
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); hide(); }
    if (e.key === 'Tab' && matchMedia('(max-width:760px)').matches) {
      const controls = [...panel.querySelectorAll('button,select,summary,[contenteditable=true]')].filter((el) => !el.disabled && el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  panel.querySelector('#nb-filter').onchange = (e) => { state().filter = e.target.value; changed(); };
  panel.querySelector('#nb-add').onclick = () => {
    if (!editable()) return;
    try {
      const scope = newScope();
      const visible = paragraphs(state().controller.doc).filter(({ value }) => matches(value));
      const id = addParagraph(state().controller.doc, scope, visible.at(-1)?.id);
      changed(); queueMicrotask(() => rows.get(id)?.view.focus());
    } catch (e) { notify(e.message); }
  };
  const text = (all = false) => plainText(state().controller.doc, all ? '*' : state().filter, questionLabel);
  panel.querySelector('#nb-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(text()); notify('已複製目前篩選內容。'); }
    catch { notify('無法自動複製，請使用「下載目前內容」保留文字。'); }
  };
  panel.querySelector('#nb-download').onclick = () => saveText(text());
  panel.querySelector('#nb-download-all').onclick = () => saveText(text(true));
  panel.querySelector('#nb-download-recovery').onclick = () => saveText(state().controller.recovery, '未同步的記事本內容');
  panel.querySelector('#nb-retry').onclick = () => state().controller.retry();
  for (const [id, restore] of [['nb-clear', false], ['nb-restore', true]]) {
    panel.querySelector('#' + id).onclick = async () => {
      const n = state()?.controller;
      if (!n) return;
      if (!(await askConfirm(restore ? '將以清空前的內容取代目前整本記事本。目前內容會先保留為下一份復原快照。' : '將清空整組記事本，包含篩選隱藏的所有段落。清空前的內容會保留供復原。', { title: restore ? '復原記事本' : '清空整本記事本', danger: true }))) return;
      if (state()?.controller !== n) return;
      try { await n.replace(restore); } catch (e) { notify(e.message); }
    };
  }
  panel.querySelector('#nb-deleted').onclick = async () => {
    const n = state()?.controller;
    if (!n || !editable()) return;
    const deleted = paragraphs(n.doc, true).filter(({ value }) => value.get('deleted'));
    if (!deleted.length) { notify('沒有已刪除的段落。'); return; }
    if (!(await askConfirm(`將復原 ${deleted.length} 個已刪段落（包含他人刪除的段落），確定繼續？`, { title: '復原已刪段落' }))) return;
    if (state()?.controller !== n || !editable()) return;
    n.doc.transact(() => deleted.forEach(({ value }) => value.set('deleted', false)), 'notebook-local');
  };
}
function matches(value) { return state().filter === '*' || (value.get('scope')?.qid || '') === state().filter; }
function rowFor(id, value, n) {
  const element = document.createElement('section'); element.className = 'nb-paragraph'; element.dataset.paragraphId = id;
  element.innerHTML = `<div class="nb-paragraph-head"><label><span>所屬題目</span> <select aria-label="段落所屬題目"></select></label><button class="nb-delete" title="刪除此段落">刪除</button></div><small class="nb-origin"></small><div class="nb-moved" role="status"></div><div class="nb-editor"></div>`;
  const select = element.querySelector('select');
  select.onchange = () => {
    if (!editable()) return;
    const scope = availableScopes().find((s) => (s.qid || '') === select.value);
    if (!scope) return;
    setScope(n.doc, id, scope);
    if (!matches(value)) notify(`已移至${scope.label}；可切換上方篩選查看。`);
  };
  element.querySelector('.nb-delete').onclick = async () => {
    if (!(await askConfirm('刪除此段落會影響整組，可從「更多」復原。', { title: '刪除段落', danger: true }))) return;
    if (state()?.controller === n && editable()) deleteParagraph(n.doc, id);
  };
  const ytext = value.get('text');
  const access = new Compartment();
  const view = new EditorView({ parent: element.querySelector('.nb-editor'), state: EditorState.create({
    doc: ytext.toString(),
    extensions: [
      EditorView.lineWrapping, placeholder('記下想法、共識或待確認事項…'),
      EditorView.contentAttributes.of({ 'aria-label': '段落內容', role: 'textbox', 'aria-multiline': 'true' }),
      access.of([EditorView.editable.of(editable()), EditorState.readOnly.of(!editable())]),
      keymap.of([
        { key: 'Enter', run: (v) => {
          if (v.composing || !editable()) return true;
          try {
            const { from, to } = v.state.selection.main;
            const next = splitParagraph(n.doc, id, from, to, newScope());
            changed(); queueMicrotask(() => rows.get(next)?.view.focus());
          } catch (e) { notify(e.message); }
          return true;
        } },
        { key: 'Shift-Enter', run: insertNewline },
        ...yUndoManagerKeymap, ...defaultKeymap,
      ]), yCollab(ytext, null),
      EditorView.domEventHandlers({ blur: () => { setTimeout(changed, 0); }, compositionend: () => { setTimeout(changed, 0); } }),
    ],
  }) });
  return { element, select, view, value, access, writable: editable() };
}
function render() {
  const st = state(); if (!st || !panel) return;
  const n = st.controller;
  panel.hidden = !st.open; document.body.classList.toggle('notebook-open', st.open); syncBackground();
  panel.querySelector('#nb-title').textContent = `${myGroup()?.name || ''}｜小組記事本`;
  panel.querySelector('#nb-status').textContent = n.status();
  panel.querySelector('#nb-members').textContent = n.onlineNames.length ? `記事本在線上：${n.onlineNames.join('、')}` : '';
  panel.querySelector('#nb-retry').hidden = !n.error;
  panel.querySelector('#nb-recovery').hidden = !n.recovery;
  if (viewDoc !== n.doc) { destroyRows(); panel.querySelector('#nb-rows').replaceChildren(); viewDoc = n.doc; }
  const scopes = scopesWithHistory(n.doc);
  if (st.filter !== '*' && !scopes.some((s) => (s.qid || '') === st.filter)) st.filter = '*';
  const filter = panel.querySelector('#nb-filter');
  const html = options(scopes, true); if (filter.innerHTML !== html) filter.innerHTML = html;
  filter.value = st.filter;
  panel.querySelector('#nb-add').disabled = !editable() || (st.filter !== '*' && !availableScopes().some((s) => (s.qid || '') === st.filter));
  for (const id of ['nb-clear', 'nb-restore']) panel.querySelector('#' + id).disabled = !editable() || !n.connected || !!n.pending.size || (id === 'nb-restore' && !n.roomRecovery);
  const list = panel.querySelector('#nb-rows'); const keep = new Set();
  let visible = 0;
  for (const { id, value } of paragraphs(n.doc, true)) {
    let row = rows.get(id);
    const active = row && (row.view.hasFocus || row.view.composing);
    const deleted = value.get('deleted');
    const show = !deleted && matches(value);
    if (!show && !active) continue;
    keep.add(id); visible++;
    if (!row) { row = rowFor(id, value, n); rows.set(id, row); list.appendChild(row.element); }
    const scopeHtml = options(scopes); if (row.select.innerHTML !== scopeHtml) row.select.innerHTML = scopeHtml;
    row.select.value = value.get('scope')?.qid || '';
    row.element.querySelector('.nb-origin').textContent = value.get('sourceGroup') ? `合併自「${value.get('sourceGroup')}」` : '';
    const writable = editable() && !deleted;
    if (row.writable !== writable) { row.view.dispatch({ effects: row.access.reconfigure([EditorView.editable.of(writable), EditorState.readOnly.of(!writable)]) }); row.writable = writable; }
    row.select.disabled = !writable;
    row.element.querySelector('.nb-delete').disabled = !editable() || !!deleted;
    row.element.querySelector('.nb-moved').textContent = deleted ? '此段已被刪除，內容已保留，可從更多選單復原。' : !show ? `已改為${questionLabel(value.get('scope'))}，結束編輯後會移出目前篩選。` : '';
    // Do not move focused CodeMirror DOM: reparenting loses selection/IME on some browsers.
    row.element.style.order = String(paragraphs(n.doc, true).findIndex((p) => p.id === id));
  }
  for (const [id, row] of rows) if (!keep.has(id)) { row.view.destroy(); row.element.remove(); rows.delete(id); }
  panel.querySelector('#nb-empty').hidden = visible > 0 || !n.ready;
}
export function refreshNotebook() { changed(); }
export function openNotebook() {
  if (!S.session?.gid || S.session.role !== 'student') return;
  mount();
  if (!state()) {
    const controller = new Notebook(S.session, changed);
    S.notebook = { controller, open: true, filter: '*' };
    controller.start().catch((e) => controller.fail(e));
  }
  state().open = true; state().controller.setVisible(true); render();
  panel.querySelector('#nb-filter').focus();
}
export async function confirmNotebookLeave() {
  const n = state()?.controller;
  if (!n || !n.pending.size) return true;
  return askConfirm('記事本還有未同步的內容，將保留在此裝置供重新加入後同步。若顯示本機儲存失敗，請先下載內容再離開。', { title: '離開記事本', okLabel: '離開', danger: true });
}
export function closeNotebook() {
  const n = state()?.controller;
  if (n?.pending.size) saveText(plainText(n.doc), '離開前未同步的記事本');
  destroyRows(); n?.close(); S.notebook = null;
  panel?.remove(); panel = null; document.body.classList.remove('notebook-open'); syncBackground();
}
