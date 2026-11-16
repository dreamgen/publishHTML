/* 講師愿力表系統 — 連線與 LINE 整合設定
 *
 * 1. firebase 為 null 時，系統自動以「本機試用模式 (localStorage)」運行，免登入即可完整測試所有功能。
 * 2. 若要啟用多人雲端同步：請於 Firebase 主控台建立全新專案（選擇 Realtime Database），
 *    並將「專案設定 → 您的應用程式 → SDK 設定」物件貼至下方 firebase 欄位。
 * 3. 若要啟用 LINE Login + Messaging API (單人 Push)：請填入 lineChannelId、lineWorkerUrl（及選填 liffId）。
 */
window.VOW_CONFIG = {
  // 全新 Firebase 專案設定（lecturervow）
  firebase: {
    apiKey: 'AIzaSyD7oC78mTUl81AF-62ByUxBzFYxNRAxgKM',
    authDomain: 'lecturervow.firebaseapp.com',
    databaseURL: 'https://lecturervow-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'lecturervow',
    storageBucket: 'lecturervow.firebasestorage.app',
    messagingSenderId: '511690346127',
    appId: '1:511690346127:web:245dd8f42e43e064cd2afa'
  },

  // Realtime Database 根節點名稱（建議依年度區分）
  root: 'vow2026',

  // LINE Login Channel ID（LINE Developers）
  lineChannelId: '2000819175',

  // 選填：若從 LINE 官方帳號圖文選單以 LIFF 開啟，填入 LIFF ID
  liffId: '',

  // Cloudflare Worker 後端網址（負責 LINE Login Token 交換、Firebase Custom Token 簽發與單人 Push API）
  lineWorkerUrl: 'https://lecturer-vow-line-worker.dreamgen-dev.workers.dev',

  // 預設年度
  year: 2026
};
