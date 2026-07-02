/**
 * Service Worker for 台灣麻將練習 (mahjongPractice) PWA
 *
 * Strategy: Stale-While-Revalidate
 * - Serve from cache immediately if available
 * - Update cache in background for fresh content next time
 * - Scope: /mahjongPractice/
 */

const SW_VERSION = 'v1';
const CACHE_NAME = `mahjongPractice-${SW_VERSION}`;
const SHARED_CACHE = `mahjongPractice-shared-${SW_VERSION}`;
const ALL_CACHES = [CACHE_NAME, SHARED_CACHE];

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
          .filter((k) => k.startsWith('mahjongPractice-') && !ALL_CACHES.includes(k))
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

  // Own-origin resources use app cache; CDN resources use shared cache
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
