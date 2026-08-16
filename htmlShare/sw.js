/**
 * Service Worker for htmlShare PWA
 *
 * Strategy: Stale-While-Revalidate
 * - Serve from cache immediately if available
 * - Update cache in background for fresh content next time
 * - Scope: /htmlShare/
 * - 注意：上傳 API 請求（POST /api/upload）一律不快取，直接放行給網路
 */

const SW_VERSION = 'v1';
const CACHE_NAME = `htmlShare-${SW_VERSION}`;
const SHARED_CACHE = `htmlShare-shared-${SW_VERSION}`;
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
          .filter((k) => k.startsWith('htmlShare-') && !ALL_CACHES.includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return; // 上傳等 POST 一律不經過快取
  if (!url.protocol.startsWith('http')) return;

  // 不快取後端 API / 分享頁面本身（那些是動態且屬於使用者自己的 Worker 網域）
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) return;

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
