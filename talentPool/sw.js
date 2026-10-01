/**
 * Service Worker for 人才庫查詢 (talentPool) PWA
 * - 安裝時預先快取 App 外殼（含 ExcelJS），之後可完全離線使用
 * - Stale-While-Revalidate；人才庫資料存在 IndexedDB，不經過 SW
 */
const SW_VERSION = 'v2';
const CACHE_NAME = `talentPool-${SW_VERSION}`;
const ASSETS = [
  './', './index.html', './app.js', './filter.js', './vendor/exceljs.min.js', './manifest.webmanifest',
  './icons/talentPool-192.png', './icons/talentPool-512.png', './icons/talentPool-192.svg',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('talentPool-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(req, { ignoreSearch: true }).then((cached) => {
    const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || net.then((res) => res || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error()));
  })));
});
