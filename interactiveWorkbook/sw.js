/**
 * Service Worker for interactiveWorkbook PWA
 *
 * Strategy: Stale-While-Revalidate
 * - 自家檔案（index.html / app.js / manifest / icons）與 CDN 函式庫（Firebase SDK、qrious）都會快取
 * - Firebase Realtime Database 的即時連線（*.firebasedatabase.app / googleapis）一律不快取，直接放行
 * - Scope: /interactiveWorkbook/
 */

const SW_VERSION = 'v1';
const CACHE_NAME = `interactiveWorkbook-${SW_VERSION}`;
const SHARED_CACHE = `interactiveWorkbook-shared-${SW_VERSION}`;
const ALL_CACHES = [CACHE_NAME, SHARED_CACHE];

// 不可快取的即時資料來源
const LIVE_HOSTS = [
  'firebasedatabase.app',
  'firebaseio.com',
  'googleapis.com',
  'firebaseinstallations',
];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', () => {
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('interactiveWorkbook-') && !ALL_CACHES.includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;
  if (LIVE_HOSTS.some((h) => url.hostname.includes(h))) return; // 即時資料不快取

  const isOwnOrigin = url.origin === self.location.origin;
  const cacheName = isOwnOrigin ? CACHE_NAME : SHARED_CACHE;

  event.respondWith(
    caches.open(cacheName).then((cache) =>
      cache.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || networkFetch;
      })
    )
  );
});
