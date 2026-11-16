/**
 * Service Worker for 講師愿力表系統 (lecturerVow)
 * - 僅管理 lecturerVow-* 快取；採用 Stale-While-Revalidate 快取同源靜態資源
 * - 業務資料走 Firebase Realtime Database（或本機 localStorage），不經 SW 快取
 */
const SW_VERSION = 'v3';
const CACHE_PREFIX = 'lecturerVow-';
const CACHE_NAME = `${CACHE_PREFIX}${SW_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './pwa.html',
  './styles.css',
  './config.js',
  './engine.js',
  './store.js',
  './app.js',
  './pwa.js',
  './manifest.webmanifest',
  './icons/lecturerVow.svg',
  './icons/lecturerVow-192.png',
  './icons/lecturerVow-512.png',
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
