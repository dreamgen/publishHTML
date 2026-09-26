import { S, myGroup } from './state.js';
import { E, exLabel, notify } from './util.js';
import { clearSession } from './storage.js';
import { leaveSession } from './session.js';
import { stopWatchLive } from './live.js';
import { renderStudentEntry } from './entry.js';
import { rerender } from './render.js';
import { applyDefaults } from './student.js';

// shell()：畫面外殼，沿用現有行為（原屬「5. 畫面狀態」一節）。
export function shell(body, options = {}) {
  window.__iwBooted = true; // 告訴 index.html 的看門狗：程式已經正常啟動
  document.body.classList.toggle('projection', S.projection);
  const subtitle = options.subtitle ?? (S.course ? S.course.name : '線上小組練習');
  document.querySelector('#app').innerHTML = `<header><div><b>互動題本</b><small>${E(subtitle)}</small></div>${
    S.session ? `<button id="logout">離開${S.session.role === 'teacher' ? '講師模式' : '本組'}</button>` : ''
  }</header><main class="wrap">${body}</main>`;
  const logout = document.querySelector('#logout');
  if (logout) {
    logout.onclick = () => {
      if (S.busy) return;
      if (S.dirty && !confirm('尚有未儲存的答案，確定離開？')) return;
      leaveSession();
    };
  }
}

// tabs()、noQuestionsNotice()、identityBar()、bindIdentityBar()、bindTabs() 原屬「8. 學員作答畫面」一節，
// 因為講師端也共用（tabs、bindTabs），移到共用的 ui.js。
export function tabs() {
  if (!S.course.exercises.length) return '';
  const group = myGroup();
  // 按鈕帶的是 qid（穩定 ID），畫面上的「練習一／二／三」才是隨 active 陣列現算的題號。
  return `<nav class="tabs" aria-label="切換練習">${S.course.exercises.map((t, i) => `<button data-qid="${E(t.qid)}" class="${
    S.qid === t.qid ? 'active' : ''
  }" ${S.qid === t.qid ? 'aria-current="step"' : ''} ${S.session.role === 'student' && S.course.locks[t.qid] ? 'disabled' : ''}>${exLabel(i)}<span>${E(t.title)}</span>${
    S.course.locks[t.qid] ? ' · 未開放' : ' · 已開放'
  }${S.session.role === 'student' && group && group.complete[t.qid] ? ' ✓' : ''}</button>`).join('')}</nav>`;
}

export function noQuestionsNotice() {
  return `<section class="card waiting"><div class="eyebrow">尚未匯入題目</div><h1>這個課程還沒有題目</h1><p>${
    S.session.role === 'teacher' ? '請使用上方的「匯入題目 JSON」新增練習內容，或先下載範本編輯。' : '請等候講師匯入題目後再進入。'
  }</p></section>`;
}

/**
 * 學員身分列：清楚顯示「我在哪一組、我是誰」，方便當場確認有沒有打錯字。
 * 姓名取自這台裝置加入時輸入的值（session.author），而不是組別上最後一位操作者，
 * 這樣同組多人各自看到的都是自己的名字。
 */
export function identityBar() {
  const group = myGroup();
  const myName = (S.session && S.session.author) || (group && group.author) || '';
  return `<div class="identity">
      <div class="identity-item"><span class="identity-label">組別</span><b>${E(group ? group.name : '')}</b></div>
      <div class="identity-item"><span class="identity-label">我的姓名</span><b>${E(myName)}</b></div>
      <button type="button" class="small" id="fix-identity">更正</button>
    </div>`;
}

export function bindIdentityBar() {
  const button = document.querySelector('#fix-identity');
  if (!button) return;
  button.onclick = () => {
    if (S.busy) return;
    if (S.dirty && !confirm('尚有未儲存的答案，確定離開並重新填寫組別／姓名？')) return;
    const { code } = S.session;
    if (S.unwatch) { S.unwatch(); S.unwatch = null; }
    // 跟 leaveSession 一樣：live/<CODE> 是另一條訂閱，不解就會留著僵尸監聽與上一個身分的緩存。
    stopWatchLive();
    S.session = null; S.course = null; S.draft = {}; S.dirty = false; S.qid = null; S.lastStudentSignature = '';
    clearSession();
    renderStudentEntry({ code });
  };
}

export function bindTabs() {
  document.querySelectorAll('[data-qid]').forEach((b) => {
    b.onclick = () => {
      if (S.busy) return;
      const target = b.dataset.qid;
      if (!S.course.byQid[target]) { notify('這一題已被講師刪除，請改選其他練習。'); return; }
      if (S.session.role === 'student' && S.course.locks[target]) { notify('本題尚未開放。'); return; }
      if (S.dirty && !confirm('本題還沒儲存。確定捨棄修改並切換題目？')) return;
      S.qid = target;
      S.dirty = false;
      if (S.session.role === 'teacher') { rerender(); return; }
      const g = myGroup();
      S.draft = structuredClone(g.answers[S.qid] || {});
      S.revision = g.revision[S.qid] || 0;
      applyDefaults();
      rerender();
    };
  });
}


// ──────────────────────────────────────────────────────────────────────────────
// 浮動視窗（截斷展開、封存答案）
//
// 這一段是刻意做成共用的：功能一「合併小組／兩者皆保留」的落選答案、
// 功能二「因修改題目而封存」的答案、功能三投影的截斷展開，三者的呈現需求相同。
// 介面只收「已經整理好的純文字」，不碰題目結構——怎麼把一份答案轉成文字是呼叫端的事。
// ──────────────────────────────────────────────────────────────────────────────

/** 截斷長文字。回傳 {shown, truncated}，呼叫端自行決定要不要顯示「展開」按鈕。 */
export function truncate(text, max = 120) {
  const value = String(text ?? '');
  if (value.length <= max) return { shown: value, truncated: false };
  return { shown: value.slice(0, max).trimEnd() + '…', truncated: true };
}

function openFloat(className, inner) {
  const dialog = document.createElement('dialog');
  dialog.className = className;
  dialog.innerHTML = inner;
  document.body.appendChild(dialog);
  dialog.showModal();
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  return { dialog, close };
}

/**
 * 複製到剪貼簿。非安全連線或使用者拒絕權限時 clipboard API 會失敗，
 * 這時改成幫使用者把文字選起來，並說清楚接下來要自己按什麼，不要只丟一句「複製失敗」。
 */
async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    notify('已複製到剪貼簿。');
  } catch {
    if (fallbackEl) {
      const range = document.createRange();
      range.selectNodeContents(fallbackEl);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    notify('這個瀏覽器不允許自動複製，已經幫你把文字選起來了，請自行按 Ctrl + C（Mac 是 ⌘ + C）複製。');
  }
}

/** 展開浮動視窗：顯示完整內容並可複製。截斷後的「展開」與封存答案的「看完整內容」共用。 */
export function expandDialog(title, text) {
  const { dialog, close } = openFloat('float-window', `<div class="float-top"><strong>${E(title)}</strong><button type="button" data-close>關閉</button></div>
    <div class="float-body"><pre class="float-text">${E(text)}</pre></div>
    <div class="float-actions"><button type="button" class="primary" data-copy>複製全部文字</button></div>`);
  dialog.querySelector('[data-copy]').onclick = () => copyText(text, dialog.querySelector('.float-text'));
  return close;
}

/**
 * 封存答案浮動視窗。
 * records: [{ id, label, savedAt, text }]；text 是已經整理好的純文字。
 * options: { title, intro }。
 * 封存內容只有該組自己看得到，不進匯出檔——這一點寫在視窗裡，避免學員以為講師已經收到。
 */
export function archiveWindow(records, options = {}) {
  const list = (records || []).filter(Boolean);
  if (!list.length) { notify('這一題目前沒有封存的內容。'); return null; }
  const title = options.title || '這一題的封存內容';
  const intro = options.intro || '以下內容是過去保留下來的答案，不會出現在講師的匯出檔裡。需要的話請自行複製，再貼回目前的作答欄位。';
  const { dialog, close } = openFloat('float-window archive-window', `<div class="float-top"><strong>${E(title)}</strong><button type="button" data-close>關閉</button></div>
    <div class="float-body"><p class="muted">${E(intro)}</p>${list.map((rec, i) => {
    const cut = truncate(rec.text, 240);
    return `<section class="archive-record"><div class="toolbar"><h3>${E(rec.label || '封存內容')}</h3><span class="muted">${
      rec.savedAt ? E(new Date(rec.savedAt).toLocaleString('zh-TW')) : ''
    }</span></div><pre class="float-text">${E(cut.shown || '（這一份是空白的）')}</pre><div class="toolbar"><button type="button" data-expand="${i}">看完整內容</button><button type="button" data-copy="${i}">複製這一份</button></div></section>`;
  }).join('')}</div>`);
  dialog.querySelectorAll('[data-expand]').forEach((b) => {
    b.onclick = () => {
      const rec = list[Number(b.dataset.expand)];
      expandDialog(rec.label || '封存內容', rec.text || '');
    };
  });
  dialog.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => {
      const rec = list[Number(b.dataset.copy)];
      copyText(rec.text || '', b.closest('.archive-record').querySelector('.float-text'));
    };
  });
  return close;
}
