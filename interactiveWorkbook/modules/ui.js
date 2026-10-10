import { S, myGroup } from './state.js';
import { E, exLabel, notify } from './util.js';
import { clearSession } from './storage.js';
import { leaveSession } from './session.js';
import { stopWatchLive } from './live.js';
import { renderStudentEntry } from './entry.js';
import { rerender } from './render.js';
import { applyDefaults } from './student.js';
import { askConfirm } from './dialog.js';

// shell()：畫面外殼，沿用現有行為（原屬「5. 畫面狀態」一節）。
export function shell(body, options = {}) {
  window.__iwBooted = true; // 告訴 index.html 的看門狗：程式已經正常啟動
  document.body.classList.toggle('projection', S.projection);
  // layout：'console' 是講師控制台的滿版三欄、'stage' 是投影舞台（不顯示頁首），其他畫面維持置中窄版。
  const layout = options.layout || '';
  document.body.classList.toggle('teacher-console', layout === 'console');
  document.body.classList.toggle('proj-stage-mode', layout === 'stage');
  document.body.classList.toggle('student-mode', !!(S.session && S.session.role === 'student'));
  const subtitle = options.subtitle ?? (S.course ? S.course.name : '線上小組練習');
  const header = layout === 'stage' ? '' : `<header><div class="header-title"><b>互動題本</b><small>${E(subtitle)}</small></div>${
    options.headerExtra || ''
  }${
    S.session ? `<button id="logout">離開${S.session.role === 'teacher' ? '講師模式' : '本組'}</button>` : ''
  }</header>`;
  document.querySelector('#app').innerHTML = `${header}<main class="${layout ? layout : 'wrap'}">${body}</main>`;
  const logout = document.querySelector('#logout');
  if (logout) {
    // async：student.js 的 bindLeaveRelease() 會 await 這個 handler，再看 S.session 是否被清掉來決定要不要釋放編輯權。
    logout.onclick = async () => {
      if (S.busy) return;
      if (S.dirty) {
        const title = S.session.role === 'teacher' ? '離開講師模式' : '離開本組';
        if (!(await askConfirm('尚有未儲存的答案，確定離開？', { title, okLabel: '確定離開', danger: true }))) return;
        if (!S.session) return; // 提示窗開著的期間已經被其他原因登出
      }
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
  // 外層 .tabs-bar 放左右箭頭：練習很多時是一條橫向捲動列，滑鼠使用者沒有手指可滑，需要按鈕與滾輪。
  return `<div class="tabs-bar"><button type="button" class="tabs-arrow" data-tabs-step="-1" aria-label="往前捲動練習清單" tabindex="-1">‹</button><nav class="tabs" aria-label="切換練習">${S.course.exercises.map((t, i) => `<button data-qid="${E(t.qid)}" class="${
    S.qid === t.qid ? 'active' : ''
  }" ${S.qid === t.qid ? 'aria-current="step"' : ''} ${S.session.role === 'student' && S.course.locks[t.qid] ? 'disabled' : ''}>${exLabel(i)}<span>${E(t.title)}</span>${
    S.course.locks[t.qid] ? ' · 未開放' : ' · 已開放'
  }${S.session.role === 'student' && group && group.complete[t.qid] ? ' ✓' : ''}</button>`).join('')}</nav><button type="button" class="tabs-arrow" data-tabs-step="1" aria-label="往後捲動練習清單" tabindex="-1">›</button></div>`;
}

/*
 * 練習切換列的捲動行為。
 * 整頁重畫（innerHTML）會把橫向捲動位置歸零：選到第六題之後的練習，重畫後就被捲出畫面，
 * 看起來像「跳回練習一」。所以每次畫完：先回到上一次的捲動位置，若目前這一題仍不在可視範圍，就把它捲到中間。
 * 滑鼠操作：左右箭頭、垂直滾輪轉成橫向捲動、按住拖曳。拖曳超過門檻後放開不算點擊，避免誤切題目。
 */
let tabsScrollLeft = 0;
let tabsSync = null;
let tabsReveal = null;
let tabsResizeBound = false;

function setupTabStrip() {
  const nav = document.querySelector('.tabs-bar .tabs');
  if (!nav) { tabsSync = null; return; }
  const bar = nav.parentElement;
  const prev = bar.querySelector('[data-tabs-step="-1"]');
  const next = bar.querySelector('[data-tabs-step="1"]');
  const maxScroll = () => Math.max(0, nav.scrollWidth - nav.clientWidth);
  const sync = () => {
    if (!nav.isConnected) return;
    const max = maxScroll();
    const overflow = max > 2;
    bar.classList.toggle('is-overflow', overflow);
    if (prev) prev.disabled = !overflow || nav.scrollLeft <= 2;
    if (next) next.disabled = !overflow || nav.scrollLeft >= max - 2;
  };
  // 目前這一題若不在可視範圍，就把它捲到中間
  const reveal = () => {
    if (!nav.isConnected) return;
    const active = nav.querySelector('button.active');
    if (!active) return;
    const navBox = nav.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    if (box.left < navBox.left || box.right > navBox.right) {
      const offset = box.left - navBox.left + nav.scrollLeft;
      nav.scrollLeft = Math.max(0, Math.min(maxScroll(), offset - (nav.clientWidth - box.width) / 2));
    }
    tabsScrollLeft = nav.scrollLeft;
  };
  tabsSync = sync;
  tabsReveal = reveal;
  if (!tabsResizeBound) {
    tabsResizeBound = true;
    // 視窗寬度改變（手機轉向、拖拉視窗）時，可視範圍跟著變，目前這一題可能被擠出畫面
    window.addEventListener('resize', () => { if (tabsReveal) tabsReveal(); if (tabsSync) tabsSync(); });
  }

  nav.scrollLeft = Math.min(tabsScrollLeft, maxScroll());
  reveal();
  sync();

  nav.addEventListener('scroll', () => { tabsScrollLeft = nav.scrollLeft; sync(); }, { passive: true });
  [prev, next].forEach((btn) => {
    if (!btn) return;
    btn.onclick = () => nav.scrollBy({ left: Number(btn.dataset.tabsStep) * Math.max(120, nav.clientWidth * 0.7), behavior: 'smooth' });
  });
  // 滑鼠滾輪：只有可以橫向捲動、而且使用者是上下滾時才接手，不然維持整頁上下捲。
  nav.addEventListener('wheel', (e) => {
    if (maxScroll() <= 2 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const before = nav.scrollLeft;
    nav.scrollLeft += e.deltaY;
    if (nav.scrollLeft !== before) e.preventDefault(); // 捲到底就放行，讓頁面繼續上下捲
  }, { passive: false });
  // 按住拖曳（只處理滑鼠；觸控本來就能滑）
  let drag = null;
  let suppressClick = false;
  nav.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = { x: e.clientX, left: nav.scrollLeft, moved: false, id: e.pointerId };
  });
  nav.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 6) {
      drag.moved = true;
      bar.classList.add('is-dragging');
      try { nav.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    if (drag.moved) nav.scrollLeft = drag.left - dx;
  });
  const endDrag = () => {
    if (drag && drag.moved) suppressClick = true;
    drag = null;
    bar.classList.remove('is-dragging');
  };
  nav.addEventListener('pointerup', endDrag);
  nav.addEventListener('pointercancel', endDrag);
  // 捕獲階段攔下拖曳結束時那一次 click，不讓它傳到題目按鈕
  nav.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
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
  // async：同上，bindLeaveRelease() 會 await 這個 handler。
  button.onclick = async () => {
    if (S.busy) return;
    if (S.dirty) {
      if (!(await askConfirm('尚有未儲存的答案，確定離開並重新填寫組別／姓名？', {
        title: '更正組別／姓名', okLabel: '離開並重新填寫', danger: true,
      }))) return;
      if (!S.session) return;
    }
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
  setupTabStrip();
  document.querySelectorAll('.tabs [data-qid]').forEach((b) => {
    b.onclick = async () => {
      if (S.busy) return;
      const target = b.dataset.qid;
      if (!S.course.byQid[target]) { notify('這一題已被講師刪除，請改選其他練習。'); return; }
      if (S.session.role === 'student' && S.course.locks[target]) { notify('本題尚未開放。'); return; }
      if (S.dirty) {
        if (!(await askConfirm('本題還沒儲存。確定捨棄修改並切換題目？', {
          title: '切換題目', okLabel: '捨棄並切換', cancelLabel: '留在本題', danger: true,
        }))) return;
        // 提示窗開著的期間，講師可能剛好刪掉或關閉了目標題目，或這台裝置已經離開。
        if (!S.session || !S.course || !S.course.byQid[target]) return;
        if (S.session.role === 'student' && S.course.locks[target]) { notify('本題尚未開放。'); return; }
      }
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

/**
 * 圖片檢視浮動視窗：點縮圖放大（學員作答畫面與投影共用，呼叫端在 images.js 的 hydrateImages）。
 * 外框沿用 .float-window，圖片依視窗大小等比縮放（樣式在 styles/image.css）。
 */
export function imageViewer(title, dataUrl) {
  const { close } = openFloat('float-window image-viewer', `<div class="float-top"><strong>${E(title)}</strong><button type="button" data-close>關閉</button></div>
    <div class="float-body image-viewer-body"><img src="${E(dataUrl)}" alt="${E(title)}"></div>`);
  return close;
}
