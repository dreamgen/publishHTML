/**
 * Service Worker for 天達排班協作 (tdAssign)
 * - 只管理 tdAssign-* 快取；Stale-While-Revalidate，僅快取同源 GET
 * - 排班資料走 Firebase（或本機 localStorage），不經過 SW
 */
const SW_VERSION = 'v2';
const CACHE_PREFIX = 'tdAssign-';
const CACHE_NAME = `${CACHE_PREFIX}${SW_VERSION}`;
const ASSETS = ['./', './index.html', './styles.css', './config.js', './data.js', './engine.js', './store.js', './app.js', './manifest.webmanifest', './icons/tdAssign.svg', './icons/tdAssign-192.png', './icons/tdAssign-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
