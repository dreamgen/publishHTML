/**
 * Service Worker for Suno 錄音轉 MP3 (sunoRecorder) PWA
 *
 * Strategy: Stale-While-Revalidate
 * - 安裝時預先快取 App 外殼（含 MP3 編碼器與錄音 worklet），離線也能轉檔
 * - Scope: /sunoRecorder/
 * - Suno 播放器 iframe 屬於 suno.com，不經過本 SW
 */

const SW_VERSION = 'v2';
const CACHE_NAME = `sunoRecorder-${SW_VERSION}`;
const SHARED_CACHE = `sunoRecorder-shared-${SW_VERSION}`;
const ALL_CACHES = [CACHE_NAME, SHARED_CACHE];
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './capture-worklet.js',
  './mp3-worker.js',
  './vendor/lame.min.js',
  './icons/sunoRecorder-192.svg',
  './icons/sunoRecorder-192.png'
];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('sunoRecorder-') && !ALL_CACHES.includes(k))
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
  if (url.hostname.endsWith('suno.com') || url.hostname.endsWith('suno.ai')) return;

  const isOwnOrigin = url.origin === self.location.origin;
  const cacheName = isOwnOrigin ? CACHE_NAME : SHARED_CACHE;

  event.respondWith(
    caches.open(cacheName).then((cache) =>
      cache.match(request, { ignoreSearch: isOwnOrigin }).then((cached) => {
        const networkFetch = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || networkFetch.then((res) => res || Response.error());
      })
    )
  );
});
