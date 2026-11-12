// Service Worker：只快取 app shell；API 一律走網路、不快取。
const CACHE = 'mv-upload-v5';
const SHELL_URL = '/u/_app'; // 後端對 /u/* 回 upload.html（無轉址），拿來當離線外殼
const SHELL = [
  SHELL_URL,
  '/assets/base.css',
  '/assets/upload.css',
  '/assets/upload.js',
  '/assets/auth.js',
  '/assets/auth.css',
  '/assets/upload-exif.js',
  '/assets/upload-image.js',
  '/assets/upload-db.js',
  '/assets/days.js',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 網路優先，失敗退回快取（資源更新後下次連線就會拿到新版）
async function networkFirst(req, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && cacheKey) cache.put(cacheKey, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey || req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 字型等跨來源資源交給瀏覽器
  if (url.pathname.startsWith('/api/')) return; // API 一律走網路
  // 上傳頁導覽：/u/{code} 網路優先，離線時用外殼；/u/ 本身（主畫面圖示）一律給外殼
  if (req.mode === 'navigate' && url.pathname.startsWith('/u')) {
    if (/^\/u\/?$/.test(url.pathname)) {
      e.respondWith(networkFirst(new Request(SHELL_URL), SHELL_URL));
    } else {
      e.respondWith(fetch(req).catch(() => caches.match(SHELL_URL)));
    }
    return;
  }
  if (SHELL.includes(url.pathname)) e.respondWith(networkFirst(req, url.pathname));
});
