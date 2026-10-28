/**
 * Service Worker for undercoverGame PWA
 * 策略：Stale-While-Revalidate。安裝時預先快取自家檔案，讓離線單機模式第一次就能用。
 * Firebase 即時連線一律不快取。Scope: /undercoverGame/
 */
const SW_VERSION = 'v2';
const CACHE_NAME = `undercoverGame-${SW_VERSION}`;
const SHARED_CACHE = `undercoverGame-shared-${SW_VERSION}`;
const ALL_CACHES = [CACHE_NAME, SHARED_CACHE];
const PRECACHE = [
  './', './index.html', './app.js', './styles.css', './manifest.webmanifest',
  './modules/rules.js', './modules/ui.js', './modules/session.js', './modules/fb.js', './modules/nav.js',
  './modules/dashboard.js', './modules/spypick.js', './modules/phone.js', './modules/print.js',
  './vendor/jsQR.js', './vendor/qrious.min.js',
  './icons/undercoverGame-192.svg', './icons/undercoverGame-512.svg',
];
const LIVE_HOSTS = ['firebasedatabase.app', 'firebaseio.com', 'googleapis.com', 'firebaseinstallations', 'identitytoolkit', 'securetoken'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('undercoverGame-') && !ALL_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;
  if (LIVE_HOSTS.some((h) => url.hostname.includes(h)) && !url.hostname.includes('fonts.googleapis.com')) return;
  const isOwn = url.origin === self.location.origin;
  const cacheName = isOwn ? CACHE_NAME : SHARED_CACHE;
  event.respondWith(
    caches.open(cacheName).then((cache) =>
      cache.match(request, { ignoreSearch: isOwn && request.mode === 'navigate' }).then((cached) => {
        const net = fetch(request).then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()); return res; }).catch(() => null);
        return cached || net.then((r) => r || (request.mode === 'navigate' ? cache.match('./index.html') : Response.error()));
      })));
});
