/**
 * Service Worker for 物品盤點 (itemInventory) PWA
 *
 * - 安裝時預先快取 App 外殼（HTML、CSS、JS、圖示、QRious）
 * - 本站檔案：Stale-While-Revalidate
 * - Firebase SDK (www.gstatic.com)：執行時快取
 */
const SW_VERSION = 'v1';
const CACHE_NAME = `itemInventory-${SW_VERSION}`;
const CDN_CACHE = 'itemInventory-cdn-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './modules/store.js',
  './modules/images.js',
  './modules/export.js',
  './vendor/qrious.min.js',
  './manifest.webmanifest',
  './icons/itemInventory-192.svg',
  './icons/itemInventory-512.svg',
];
const CDN_HOSTS = ['www.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.allSettled(ASSETS.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('itemInventory-') && k !== CACHE_NAME && k !== CDN_CACHE)
          .map((k) => caches.delete(k))
      ))
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
