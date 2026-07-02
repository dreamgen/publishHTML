/**
 * Service Worker for 即時互動大廳 (liveInteraction) PWA
 *
 * Strategy:
 * - Firebase & external API requests: Network-only (real-time data must be fresh)
 * - Own-origin static assets: Stale-While-Revalidate
 * - CDN resources (Tailwind, Phosphor Icons): Cache-first with network fallback
 */

const SW_VERSION = 'v1';
const CACHE_NAME = `liveInteraction-${SW_VERSION}`;
const SHARED_CACHE = `liveInteraction-shared-${SW_VERSION}`;
const ALL_CACHES = [CACHE_NAME, SHARED_CACHE];

// Patterns that should NOT be cached (Firebase real-time endpoints)
const NETWORK_ONLY_PATTERNS = [
  /firebaseio\.com/,
  /googleapis\.com\/identitytoolkit/,
  /gstatic\.com\/firebasejs/,
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
          .filter((k) => k.startsWith('liveInteraction-') && !ALL_CACHES.includes(k))
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

  // Firebase & real-time resources: always network-only
  if (NETWORK_ONLY_PATTERNS.some((pattern) => pattern.test(request.url))) {
    return; // let the browser handle it directly
  }

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
