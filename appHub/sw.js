/**
 * Service Worker for PWA 總覽 (appHub)
 *
 * Strategy:
 * - 一般資源：Stale-While-Revalidate（先回快取，背景更新）
 * - apps.json：Network First（優先取得最新工具清單，離線時才退回快取）
 * - Scope: /appHub/
 */

const SW_VERSION = 'v1';
const CACHE_NAME = `appHub-${SW_VERSION}`;
const SHARED_CACHE = `appHub-shared-${SW_VERSION}`;
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
          .filter((k) => k.startsWith('appHub-') && !ALL_CACHES.includes(k))
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

  const isOwnOrigin = url.origin === self.location.origin;
  const cacheName = isOwnOrigin ? CACHE_NAME : SHARED_CACHE;
  const isAppsJson = isOwnOrigin && url.pathname.endsWith('/apps.json');

  if (isAppsJson) {
    // Network First：確保新增/修改工具後，清單能盡快反映最新狀態
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) caches.open(cacheName).then((cache) => cache.put(request, res.clone()));
          return res;
        })
        .catch(() => caches.open(cacheName).then((cache) => cache.match(request)))
    );
    return;
  }

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
