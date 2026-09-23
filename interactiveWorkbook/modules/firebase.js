import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getDatabase, ref, get, set, update, remove, onValue, runTransaction,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';

// 其他模組共用的 RTDB 函式，統一從這裡取得，不要各自 import firebase-database.js。
export {
  ref, get, set, update, remove, onValue, runTransaction,
};

// ──────────────────────────────────────────────────────────────────────────────
// 1. Firebase 初始化（沿用 liveInteraction 的 pwa-boardgame 專案設定）
// ──────────────────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: 'AIzaSyAi2QYt_Cnl7X9wC3h-IUfOkUli7qMLrIM',
  authDomain: 'pwa-boardgame.firebaseapp.com',
  databaseURL: 'https://pwa-boardgame-default-rtdb.asia-southeast1.firebasedatabase.app/',
  projectId: 'pwa-boardgame',
  storageBucket: 'pwa-boardgame.firebasestorage.app',
  messagingSenderId: '1079279430768',
  appId: '1:1079279430768:web:644823331e777e10b018b5',
};

export const DB_ROOT = 'artifacts/interactiveWorkbook/public/data';
export const COURSES = `${DB_ROOT}/courses`;

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

/**
 * 匿名登入。務必要有「會失敗」的出口：若登入被拒仍讓 Promise 永遠 pending，
 * 畫面就會停在「載入中…」而使用者不知道發生什麼事。
 * 逾時不在這裡處理 —— 逾時只用來「先顯示訊息」，登入本身繼續嘗試，
 * 這樣教室網路慢一點或短暫斷線時，連上後可以自動恢復，不必要求學員重新整理。
 */
export const AUTH_SLOW_MS = 12000;
export const authReady = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => { if (user) resolve(user); });
  signInAnonymously(auth).catch((e) => reject(Error('無法登入資料庫：' + (e && e.message ? e.message : e))));
});

export const courseRef = (code, sub = '') => ref(db, `${COURSES}/${code}${sub ? '/' + sub : ''}`);
export const liveRef = (code, sub = '') => ref(db, `${DB_ROOT}/live/${code}${sub ? '/' + sub : ''}`);
