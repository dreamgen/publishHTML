// ──────────────────────────────────────────────────────────────────────────────
// 投影視窗：控制台與「另開的投影視窗」之間的同步
//
// 延伸螢幕的用法：講師在控制台按「另開投影視窗」，把那個視窗拖到投影機並全螢幕，
// 控制台這邊繼續切模式、換欄位、調字級，投影視窗即時跟著變。
//
// 只同步「投影要怎麼呈現」（題目、模式、欄位、組別、捲到第幾屏、字級、底色、只顯示已作答）與學員加入 QR 的開關，
// 不同步任何答案：兩個視窗各自訂閱同一個課程，答案本來就會即時更新。
// 走 BroadcastChannel，只在同一台電腦、同一個瀏覽器內傳遞，不寫資料庫。
// 投影視窗由 window.open 開啟，會複製控制台這個分頁的 sessionStorage，因此不必再登入一次。
// ──────────────────────────────────────────────────────────────────────────────
import { S } from './state.js';

const CHANNEL = 'iw-projector';
/** 投影視窗每隔幾毫秒回報一次「我還在」；超過兩倍時間沒聲音就當作已關閉。 */
const BEAT_MS = 4000;

export const isProjectorWindow = new URLSearchParams(location.search).get('view') === 'projector';

let channel = null;
let lastBeat = 0;
let beatTimer = null;
let staleTimer = null;
let stateHandler = null;
let qrHandler = null;
let screensHandler = null;
let snapshotProvider = null;
let winRef = null;

function code() { return S.session ? S.session.code : ''; }

function post(msg) {
  const ch = ensureChannel();
  if (ch) ch.postMessage({ ...msg, code: code() });
}

function ensureChannel() {
  if (channel || !('BroadcastChannel' in window)) return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (ev) => {
    const msg = ev.data || {};
    if (!msg.code || msg.code !== code()) return;
    if (msg.type === 'state' && stateHandler) stateHandler(msg.state || {});
    if (msg.type === 'qr' && qrHandler) qrHandler(!!msg.open);
    if (isProjectorWindow) return;
    // 以下是控制台端
    if (msg.type === 'screens' && screensHandler) screensHandler(Number(msg.at) || 0, Number(msg.total) || 1);
    if (msg.type === 'hello' || msg.type === 'beat') {
      lastBeat = Date.now();
      paintStatus();
      // 新開的投影視窗先要一份目前狀態，否則它會停在預設的「狀態點」。
      if (msg.type === 'hello' && snapshotProvider) post({ type: 'state', state: snapshotProvider() });
    }
    if (msg.type === 'bye') {
      lastBeat = 0;
      paintStatus();
      // 投影視窗關了，上面的 QR 自然也不在了
      if (qrHandler) qrHandler(false);
    }
  };
  return channel;
}

/** 對方傳來呈現狀態時要做什麼（由 projection.js 登記：套用後重畫） */
export function onProjState(fn) { stateHandler = fn; ensureChannel(); }

/** 目前呈現狀態的取得方式（由 projection.js 登記），用來回應新開的投影視窗 */
export function setSnapshotProvider(fn) { snapshotProvider = fn; }

/** 講師在任一端改了呈現方式：廣播給另一端 */
export function publishProjState(state) { post({ type: 'state', state }); }

/**
 * 學員加入 QR Code：控制台送 open=true 叫投影視窗顯示、false 收起；
 * 投影視窗那邊被講師直接關掉時，也送 false 回來讓控制台更新按鈕。
 */
export function publishJoinQR(open) { post({ type: 'qr', open: !!open }); }

/** 收到對方的 QR 開關時要做什麼（由 teacher.js 登記） */
export function onJoinQR(fn) { qrHandler = fn; ensureChannel(); }

/**
 * 分屏：投影視窗的內容比畫面高時，切成好幾「屏」往下捲。
 * 屏數只有投影視窗量得出來（控制台的預覽字級不同），所以由投影視窗回報給控制台。
 */
export function publishScreens(at, total) { if (isProjectorWindow) post({ type: 'screens', at, total }); }

/** 控制台收到投影視窗回報的「第幾屏／共幾屏」時要做什麼（由 projection.js 登記） */
export function onScreens(fn) { screensHandler = fn; ensureChannel(); }

export function projectorConnected() {
  return !!lastBeat && Date.now() - lastBeat < BEAT_MS * 2;
}

/** 只改狀態徽章的字與 class，不重畫控制台 */
function paintStatus() {
  const el = document.querySelector('#proj-win-status');
  if (!el) return;
  const on = projectorConnected();
  el.textContent = on ? '投影視窗已連線' : '投影視窗未開啟';
  el.classList.toggle('is-on', on);
}

export function bindProjectorStatus() {
  ensureChannel();
  paintStatus();
  if (!staleTimer) staleTimer = setInterval(paintStatus, BEAT_MS);
}

export function openProjectorWindow() {
  ensureChannel();
  if (winRef && !winRef.closed) { winRef.focus(); return; }
  const url = `${location.pathname}?view=projector`;
  winRef = window.open(url, 'iw-projector', 'popup,width=1280,height=720');
  if (!winRef) return false;
  return true;
}

/** 投影視窗端：開機時打招呼，之後定時回報 */
export function startProjectorBeacon() {
  if (!isProjectorWindow || beatTimer) return;
  ensureChannel();
  post({ type: 'hello' });
  beatTimer = setInterval(() => post({ type: 'beat' }), BEAT_MS);
  window.addEventListener('pagehide', () => post({ type: 'bye' }));
}
