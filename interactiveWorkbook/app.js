/**
 * 互動題本 — 線上小組練習 PWA
 *
 * 後端：Firebase Realtime Database（與 liveInteraction 共用 pwa-boardgame 專案）
 * 資料路徑：artifacts/interactiveWorkbook/public/data/courses/<六碼加入代碼>
 *
 * 設計重點
 * - 講師建立課程時自訂名稱與密碼，系統產生六碼加入代碼；密碼以 PBKDF2-SHA256 雜湊後才寫入資料庫。
 * - 題目由講師以 JSON 匯入（可先下載範本），存成單一 JSON 字串，避免 RTDB 對巢狀陣列／空物件的處理差異。
 * - 學員以加入代碼進入，選（或新增）組別、填姓名即可作答；同組共用一份答案。
 * - 以 onValue 即時同步，講師端答案、題目開關變動都會立即反映，不需輪詢。
 * - 存檔採 runTransaction 比對 revision，避免兩台裝置互相覆蓋。
 *
 * 本檔案只做 boot / enterApp / 組裝；實際邏輯拆分在 modules/ 底下（見 架構與模組規約.md）。
 */
import { authReady, AUTH_SLOW_MS } from './modules/firebase.js';
import { S } from './modules/state.js';
import { shell } from './modules/ui.js';
import { renderEntry } from './modules/entry.js';
import { loadSession } from './modules/storage.js';
import { startSession } from './modules/session.js';
import { E } from './modules/util.js';

// ──────────────────────────────────────────────────────────────────────────────
// 12. 啟動
// ──────────────────────────────────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

function renderBootError(message) {
  shell(`<div class="login"><div class="card">
      <div class="eyebrow">載入失敗</div>
      <h1>沒辦法連上即時資料庫</h1>
      <p>${E(message)}</p>
      <p>常見原因：目前沒有網路；校內／公司網路或擋廣告擴充功能封鎖了 <code>gstatic.com</code>、<code>googleapis.com</code>；或之前存下的舊版快取壞掉。</p>
      <div class="toolbar">
        <button class="primary" id="boot-retry">重新整理</button>
        <button id="boot-reset">清除快取並重新載入</button>
      </div>
      <p class="muted">若在教室 Wi-Fi 下反覆失敗，請改用手機網路，或請網管放行 Google 服務網域。</p>
    </div></div>`, { subtitle: '線上小組練習' });
  document.querySelector('#boot-retry').onclick = () => location.reload();
  document.querySelector('#boot-reset').onclick = () => {
    if (window.__iwReset) window.__iwReset(); else location.reload();
  };
}

function enterApp() {
  const saved = loadSession();
  if (saved && saved.code && saved.role) startSession(saved);
  else renderEntry('student');
}

(async function boot() {
  const slow = new Promise((_, rejectSlow) => setTimeout(
    () => rejectSlow(Error('連線逾時。可能是網路不通，或有擴充功能／網路政策封鎖了 Google 服務。')),
    AUTH_SLOW_MS,
  ));
  try {
    await Promise.race([authReady, slow]);
  } catch (e) {
    renderBootError(e && e.message ? e.message : '連線失敗。');
    // 只是慢或暫時斷線的話，登入仍在背景進行；連上後自動進入，不必請使用者重新整理。
    authReady.then(() => { if (!S.session) enterApp(); }).catch(() => { /* 已顯示錯誤畫面 */ });
    return;
  }
  enterApp();
}());
