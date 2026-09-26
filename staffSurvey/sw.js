/**
 * Service Worker for 服務人員調查 (staffSurvey) PWA
 *
 * - 安裝時預先快取 App 外殼（含 ExcelJS），之後可完全離線使用
 * - Stale-While-Revalidate：先回快取，背景更新
 * - 只處理本站檔案；名冊與問卷存在 IndexedDB（加密），不經過 SW
 */

const SW_VERSION = 'v1';
const CACHE_NAME = `staffSurvey-${SW_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './survey.js',
  './vendor/exceljs.min.js',
  './manifest.webmanifest',
  './icons/staffSurvey-192.png',
  './icons/staffSurvey-512.png',
  './icons/staffSurvey-192.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('staffSurvey-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

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
});
