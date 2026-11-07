/**
 * Service Worker for 活動控場 (eventControl) PWA
 *
 * - 安裝時預先快取 App 外殼（含 QRious；ExcelJS 用到時才快取）
 * - 本站檔案：Stale-While-Revalidate
 * - CDN（Tailwind、Phosphor Icons、Firebase SDK、Google Fonts）：執行時快取，離線時仍可開啟介面
 * - Firebase 即時資料走 WebSocket，不經過 SW
 */
const SW_VERSION = 'v2';
const CACHE_NAME = `eventControl-${SW_VERSION}`;
const CDN_CACHE = 'eventControl-cdn-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './modules/flowParser.js',
  './vendor/qrious.min.js',
  './manifest.webmanifest',
  './icons/eventControl-192.png',
  './icons/eventControl-512.png',
  './icons/eventControl-192.svg',
];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'unpkg.com', 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  // 逐檔快取、單檔失敗不讓整個安裝失敗（手機網路不穩時 addAll 一失敗就裝不起來，Chrome 也就不提供「安裝」）
  // ExcelJS（約 1MB）不預載，第一次匯入 xlsx 時再由 fetch handler 快取
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.allSettled(ASSETS.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('eventControl-') && k !== CACHE_NAME && k !== CDN_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request, { ignoreSearch: true }).then((cached) => {
          const network = fetch(request)
            .then((res) => { if (res && res.ok) cache.put(request, res.clone()); return res; })
            .catch(() => null);
          return cached || network.then((res) => res || (request.mode === 'navigate' ? cache.match('./index.html') : Response.error()));
        })
      )
    );
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CDN_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()); return res; })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const c = list.find((x) => x.url.includes('/eventControl/'));
      return c ? c.focus() : self.clients.openWindow('./');
    })
  );
});
