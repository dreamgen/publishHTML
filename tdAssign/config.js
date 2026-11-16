/* 天達排班協作 — 連線設定
 *
 * firebase 為 null 時是「本機試用模式」：資料只存在這台裝置的瀏覽器，可切換身分試用，不需要登入。
 * 填入 Firebase 專案設定後即改為多人連線模式（設定步驟見 README.md）。
 */
window.TD_CONFIG = {
  // 從 Firebase 主控台「專案設定 → 您的應用程式 → SDK 設定和配置」複製整段物件貼在這裡
  firebase: {
    apiKey: 'AIzaSyBE5QMMpNjiJsdb8dczDpSth_4-m6Uuvyw',
    authDomain: 'td-assign.firebaseapp.com',
    databaseURL: 'https://td-assign-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'td-assign',
    appId: '1:937340953606:web:eaec62987dc3f5afa84f87'
  },
  /* 例：
  firebase: {
    apiKey: '…',
    authDomain: '你的專案.firebaseapp.com',
    databaseURL: 'https://你的專案-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: '你的專案',
    appId: '…'
  },
  */

  // 資料在 Realtime Database 的根路徑（每個年度一個）
  root: 'td116',

  // 草案版號（決議套用提案時會遞增）
  draftVersion: 'v9.3',

  // 測試開關：true 時，M8 姓名綁定、代管家人與新名冊申請立即生效；正式上線完工後請改為 false（須由區長／小組長確認）
  autoApproveBind: true,

  // LINE 登入：LINE Developers 的 Channel ID，以及 worker/ 部署後的網址（兩個都填才會出現 LINE 登入按鈕）
  lineChannelId: '2012639715',
  lineWorkerUrl: 'https://tdassign-line-login.ikt-checkin.workers.dev'
};
