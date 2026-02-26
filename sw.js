/**
 * Service Worker for publishHTML PWA apps
 *
 * Strategy: Stale-While-Revalidate for all resources
 * - Serve from cache immediately if available
 * - Update cache in background for fresh content next time
 * - Each app uses its own named cache so updates are isolated
 */

const SW_VERSION = 'v1';
const CACHE_PREFIX = 'publishHTML';

// App-specific cache names — add new apps here
const APP_CACHE_MAP = {
  'playDices':   `${CACHE_PREFIX}-playDices-${SW_VERSION}`,
  'scoreBoard':  `${CACHE_PREFIX}-scoreBoard-${SW_VERSION}`,
};
const DEFAULT_CACHE = `${CACHE_PREFIX}-shared-${SW_VERSION}`;

// All known cache names (used for cleanup)
const ALL_KNOWN_CACHES = [...Object.values(APP_CACHE_MAP), DEFAULT_CACHE];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  // Skip waiting so the new SW activates immediately
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => {
            // Delete old caches from this SW that are no longer in use
            return (
              name.startsWith(CACHE_PREFIX) &&
              !ALL_KNOWN_CACHES.includes(name)
            );
          })
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests from our origin or trusted CDNs
  if (request.method !== 'GET') return;

  // Skip non-http(s) requests (e.g. chrome-extension://)
  if (!url.protocol.startsWith('http')) return;

  const cacheName = resolveCacheName(url);

  event.respondWith(
    caches.open(cacheName).then((cache) => {
      return cache.match(request).then((cachedResponse) => {
        // Always kick off a background network fetch to keep cache fresh
        const networkFetch = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => null); // Swallow network errors silently

        // Return cached version right away; fall back to network if no cache
        return cachedResponse || networkFetch;
      });
    })
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine which cache to use based on the request URL.
 * Own-origin HTML/assets are filed under the matching app cache;
 * CDN resources are stored in the shared cache.
 */
function resolveCacheName(url) {
  const path = url.pathname;

  // Match own-origin app files
  for (const [appKey, appCache] of Object.entries(APP_CACHE_MAP)) {
    if (path.includes(appKey)) {
      return appCache;
    }
  }

  return DEFAULT_CACHE;
}
