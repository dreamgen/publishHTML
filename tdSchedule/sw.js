/**
 * Service Worker for 天達堂 116 年排班台 (tdSchedule) PWA
 *
 * - 只管理 tdSchedule-* 快取，不影響同 origin 下 publishHTML 的其他工具
 * - Stale-While-Revalidate：先回快取，背景更新；僅快取同源 GET 請求
 * - 排班資料存在瀏覽器 localStorage，不經過 SW
 */

const SW_VERSION = 'v2';
const CACHE_PREFIX = 'tdSchedule-';
const CACHE_NAME = `${CACHE_PREFIX}${SW_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './data.js',
  './app.js',
  './manifest.webmanifest',
  './icons/tdSchedule-192.svg',
  './icons/tdSchedule-512.svg',
  './icons/tdSchedule-192.png',
  './icons/tdSchedule-512.png',
  './icons/tdSchedule-512-maskable.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
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
        const networkFetch = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || networkFetch.then((res) => res || (request.mode === 'navigate' ? cache.match('./index.html') : Response.error()));
      })
    )
  );
});
