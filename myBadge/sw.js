/**
 * Service Worker for 我的名牌 (myBadge) PWA — v1
 * Stale-While-Revalidate caching strategy
 */

const SW_VERSION = 'v1';
const CACHE_NAME = `myBadge-${SW_VERSION}`;
const SHARED_CACHE = `myBadge-shared-${SW_VERSION}`;
const ALL_CACHES = [CACHE_NAME, SHARED_CACHE];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('myBadge-') && !ALL_CACHES.includes(k))
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Message from main thread ─────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ─── Fetch (Stale-While-Revalidate) ──────────────────────────────────────────
const CDN_HOSTNAMES = [
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  const cacheName = (url.origin === self.location.origin || CDN_HOSTNAMES.includes(url.hostname))
    ? (url.origin === self.location.origin ? CACHE_NAME : SHARED_CACHE)
    : null;

  if (!cacheName) return;

  event.respondWith(
    caches.open(cacheName).then(cache =>
      cache.match(request).then(cached => {
        const net = fetch(request)
          .then(res => {
            if (res?.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || net;
      })
    )
  );
});
