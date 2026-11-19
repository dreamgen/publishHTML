/**
 * Service Worker for 天達排班協作 (tdAssign)
 *
 * 部署新版時必須同時做兩件事（兩處要一致）：
 *   1. 本檔 SW_VERSION 遞增（例 v6 → v7）
 *   2. index.html 內所有 script／link 的 ?v= 參數改成同一個數字，ASSETS 的網址也跟著改
 *
 * 更新策略：
 * - HTML（導覽請求）：網路優先（no-cache 繞過 HTTP 快取），3 秒內沒回應或離線時用安裝時的快取 index.html。
 * - 其他同源檔案：只從「同一版本安裝時」的快取供應；網址帶版本參數，所以不會新舊混用。
 * - 安裝時以 cache:'reload' 逐一抓取（不吃瀏覽器 HTTP 快取），任何一檔失敗就整組不安裝，維持舊版。
 * - 快取只在安裝時寫入；導覽請求的回應不寫入快取，避免把新版 HTML 混進舊版快取。
 * - 排班資料走 Firebase（或本機 localStorage），不經過 SW。
 */
const SW_VERSION = 'v20';
const CACHE_PREFIX = 'tdAssign-';
const CACHE_NAME = `${CACHE_PREFIX}${SW_VERSION}`;
const NAV_TIMEOUT_MS = 3000;
// 與 index.html 的 script／link 網址完全相同（含 ?v=）
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=20',
  './config.js?v=20',
  './data.js?v=20',
  './engine.js?v=20',
  './store.js?v=20',
  './console.js?v=20',
  './app.js?v=20',
  './manifest.webmanifest?v=20',
  './icons/tdAssign.svg',
  './icons/tdAssign-192.png',
  './icons/tdAssign-512.png',
  './icons/tdAssign-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function navigate(req) {
  const cache = await caches.open(CACHE_NAME);
  const fallback = () => cache.match('./index.html');
  try {
    const res = await withTimeout(fetch(req, { cache: 'no-cache' }), NAV_TIMEOUT_MS);
    if (res && res.ok) return res;
    return (await fallback()) || res;
  } catch (e) {
    const hit = await fallback();
    return hit || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req);
  return hit || fetch(req);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(navigate(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});
