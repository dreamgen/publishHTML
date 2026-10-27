// Firebase Realtime Database（沿用 pwa-boardgame 專案）。只在連線模式動態載入，離線模式完全不需要網路。
const SDK = 'https://www.gstatic.com/firebasejs/11.6.1/';
const firebaseConfig = {
  apiKey: 'AIzaSyAi2QYt_Cnl7X9wC3h-IUfOkUli7qMLrIM',
  authDomain: 'pwa-boardgame.firebaseapp.com',
  databaseURL: 'https://pwa-boardgame-default-rtdb.asia-southeast1.firebasedatabase.app/',
  projectId: 'pwa-boardgame',
  storageBucket: 'pwa-boardgame.firebasestorage.app',
  messagingSenderId: '1079279430768',
  appId: '1:1079279430768:web:644823331e777e10b018b5',
};
export const DB_ROOT = 'artifacts/undercoverGame/public/data';

let ready = null;
/** 回傳 { ref, get, set, update, remove, onValue, evRef } */
export function connect() {
  if (ready) return ready;
  // 測試用：test/smoke.mjs 會注入記憶體版資料庫
  if (typeof window !== 'undefined' && window.__UG_FAKE_FB) return (ready = Promise.resolve(window.__UG_FAKE_FB));
  ready = (async () => {
    const [{ initializeApp }, dbm, authm] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-database.js'),
      import(SDK + 'firebase-auth.js'),
    ]);
    const app = initializeApp(firebaseConfig);
    const db = dbm.getDatabase(app);
    const auth = authm.getAuth(app);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('連線逾時，請確認網路後重試，或改用離線模式')), 15000);
      authm.onAuthStateChanged(auth, (u) => { if (u) { clearTimeout(t); resolve(u); } });
      authm.signInAnonymously(auth).catch((e) => { clearTimeout(t); reject(new Error('無法登入資料庫：' + e.message)); });
    });
    const evRef = (ev, sub = '') => dbm.ref(db, `${DB_ROOT}/events/${ev}${sub ? '/' + sub : ''}`);
    return {
      ref: (p) => dbm.ref(db, p), get: dbm.get, set: dbm.set, update: dbm.update, remove: dbm.remove,
      onValue: dbm.onValue, serverTimestamp: dbm.serverTimestamp, evRef,
      connectedRef: () => dbm.ref(db, '.info/connected'),
      offsetRef: () => dbm.ref(db, '.info/serverTimeOffset'),
    };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}
