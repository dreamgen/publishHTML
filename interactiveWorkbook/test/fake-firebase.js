/**
 * fake-firebase.js — 供無頭煙霧測試使用的假 RTDB 用戶端。
 *
 * 這個檔案由 serve.mjs 在收到對 `./modules/firebase.js` 的請求時原樣頂替送出，
 * 不需要修改 /tmp/iw 底下的任何原始碼。匯出的名稱與語義刻意對齊
 * modules/firebase.js：authReady、AUTH_SLOW_MS、courseRef、liveRef、DB_ROOT、COURSES，
 * 以及 re-export 的 ref/get/set/update/remove/onValue/runTransaction。
 *
 * 重要設計決定：真正的資料樹「不」存在這個瀏覽器分頁的記憶體裡，而是存在
 * serve.mjs（Node）行程內、經由同源的 /__fakedb/* HTTP + SSE API 存取。
 * 這是因為測試情境需要開兩個獨立的 BrowserContext 模擬「兩台裝置」，而
 * BrowserContext 之間的 JS 堆疊、儲存分割區完全隔離，純瀏覽器端內存物件
 * 無法在兩台「裝置」之間共享——必須有一個裝置以外的共用後端，這裡就是
 * serve.mjs 進程內的那份記憶體資料樹。
 */

const API = '/__fakedb';

function splitPath(p) {
  return String(p || '').split('/').filter(Boolean);
}
function joinParts(parts) {
  return parts.join('/');
}
function isPrefix(a, b) {
  return a.length <= b.length && a.every((seg, i) => b[i] === seg);
}
function overlaps(a, b) {
  return isPrefix(a, b) || isPrefix(b, a);
}

async function apiGet(pathStr) {
  const res = await fetch(`${API}/get?path=${encodeURIComponent(pathStr)}`);
  if (!res.ok) throw Error('假資料庫讀取失敗：HTTP ' + res.status);
  const data = await res.json();
  return data.value === undefined ? null : data.value;
}
async function apiSet(pathStr, value) {
  const res = await fetch(`${API}/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: pathStr, value: value === undefined ? null : value }),
  });
  if (!res.ok) throw Error('假資料庫寫入失敗：HTTP ' + res.status);
}
async function apiUpdate(pathStr, updates) {
  const res = await fetch(`${API}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: pathStr, updates }),
  });
  if (!res.ok) throw Error('假資料庫寫入失敗：HTTP ' + res.status);
}

// ──────────────────────────────────────────────────────────────────────────────
// 對齊 modules/firebase.js 的輸出
// ──────────────────────────────────────────────────────────────────────────────
export const DB_ROOT = 'artifacts/interactiveWorkbook/public/data';
export const COURSES = `${DB_ROOT}/courses`;
export const AUTH_SLOW_MS = 12000;
export const authReady = Promise.resolve({ uid: 'fake-test-uid' });

export function ref(_db, pathStr) {
  return { _path: String(pathStr || '') };
}
export const courseRef = (code, sub = '') => ref(null, `${COURSES}/${code}${sub ? '/' + sub : ''}`);
export const liveRef = (code, sub = '') => ref(null, `${DB_ROOT}/live/${code}${sub ? '/' + sub : ''}`);

function makeSnapshot(value) {
  const v = value === undefined ? null : value;
  return { exists: () => v !== null, val: () => v };
}

export async function get(refObj) {
  const v = await apiGet(refObj._path);
  return makeSnapshot(v);
}

export async function set(refObj, value) {
  await apiSet(refObj._path, value);
}

export async function update(_refObjOrRoot, updates) {
  // 與真正的 firebase-database 一致：update(ref, updates) 以 ref 的路徑為基準，
  // updates 的 key 可以包含 '/'，值為 null 代表刪除該節點。
  await apiUpdate(_refObjOrRoot._path, updates);
}

export async function remove(refObj) {
  await apiSet(refObj._path, null);
}

// ──────────────────────────────────────────────────────────────────────────────
// 即時訂閱：單一 SSE 連線廣播「哪些路徑變動了」，每個 onValue 監聽收到通知後
// 重新 GET 一次自己的路徑，值不論是否真的改變都會呼叫 cb（簡化，見 README 說明）。
// ──────────────────────────────────────────────────────────────────────────────
let es = null;
const listeners = new Set();

function ensureStream() {
  if (es) return;
  es = new EventSource(`${API}/events`);
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const changed = (msg.paths || []).map(splitPath);
    listeners.forEach((l) => {
      if (changed.length === 0 || changed.some((c) => overlaps(c, l.parts))) refresh(l);
    });
  };
  es.onerror = () => { /* 讓瀏覽器自動重連；測試環境不需要額外處理 */ };
}

async function refresh(listener) {
  // 注意：只有「讀取假資料庫失敗」（網路 / fetch 例外）才餵給 errCb，
  // 這對應真正的 RTDB SDK 只在連線／權限出問題時才呼叫 onValue 的第二個參數。
  // 如果是 App 自己的 cb（例如 session.js 的 applySnapshot）丟例外，
  // 就讓它照 JS 正常規則往外傳播（變成 uncaught exception / unhandled rejection，
  // 也就是 Playwright 看得到的 pageerror），不可以在這裡吞掉、
  // 更不可以誤導成「連線中斷」——不然真正的 App bug 會被這層假後端蓋住。
  let v;
  try {
    v = await apiGet(joinParts(listener.parts));
  } catch (e) {
    if (listener.errCb) listener.errCb(e instanceof Error ? e : Error(String(e)));
    return;
  }
  listener.cb(makeSnapshot(v));
}

export function onValue(refObj, cb, errCb) {
  ensureStream();
  const listener = { parts: splitPath(refObj._path), cb, errCb };
  listeners.add(listener);
  refresh(listener); // spec: 註冊後立刻以目前值呼叫一次
  return () => { listeners.delete(listener); };
}

// ──────────────────────────────────────────────────────────────────────────────
// runTransaction：先取得真實值、呼叫 updater，undefined 代表中止。
// nullFirstTransaction（見 window.__fakedb）打開時，模擬 RTDB 常見的
// 「第一次以 null 呼叫、之後才用真正的值重跑一次」路徑。
// ──────────────────────────────────────────────────────────────────────────────
export async function runTransaction(refObj, updater) {
  const pathStr = refObj._path;
  let current = await apiGet(pathStr);

  if (window.__fakedb && window.__fakedb.nullFirstTransaction) {
    const firstResult = updater(null);
    if (firstResult === undefined) {
      return { committed: false, snapshot: makeSnapshot(current === undefined ? null : current) };
    }
    current = await apiGet(pathStr); // 用真正的值重跑一次
  }

  const result = updater(current === undefined ? null : current);
  if (result === undefined) {
    return { committed: false, snapshot: makeSnapshot(current === undefined ? null : current) };
  }
  await apiSet(pathStr, result);
  const after = await apiGet(pathStr);
  return { committed: true, snapshot: makeSnapshot(after) };
}

// ──────────────────────────────────────────────────────────────────────────────
// 測試用鉤子：window.__fakedb
// 注意：因為真正的資料樹存在 serve.mjs（見上方說明），dump()/seed() 都是
// 非同步（回傳 Promise），呼叫端需要 await（或在 page.evaluate 內 await）。
// ──────────────────────────────────────────────────────────────────────────────
window.__fakedb = Object.assign(window.__fakedb || {}, {
  nullFirstTransaction: false,
  async dump() {
    const res = await fetch(`${API}/dump`);
    const data = await res.json();
    return data.tree;
  },
  async seed(tree) {
    const res = await fetch(`${API}/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: tree || {} }),
    });
    if (!res.ok) throw Error('假資料庫 seed 失敗：HTTP ' + res.status);
  },
});
