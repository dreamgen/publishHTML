/**
 * Service Worker for 淨讀器 (pureReader) PWA — v2
 *
 * 1. App Shell : Stale-While-Revalidate
 * 2. Background Sync  : 網路恢復時自動重試失敗的擷取
 * 3. Background Fetch : 關掉 App 後仍可繼續下載
 */

const SW_VERSION   = 'v2';
const CACHE_NAME   = `pureReader-${SW_VERSION}`;
const SHARED_CACHE = `pureReader-shared-${SW_VERSION}`;
const ALL_CACHES   = [CACHE_NAME, SHARED_CACHE];

// ─── IDB helpers ───────────────────────────────────────────────────────────────
const IDB_NAME    = 'pureReader-db';
const IDB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains('sync-queue'))
        db.createObjectStore('sync-queue', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('raw-html'))
        db.createObjectStore('raw-html', { keyPath: 'url' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function idbOp(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Notify all window clients ─────────────────────────────────────────────────
async function notifyClients(msg) {
  const cs = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  cs.forEach(c => c.postMessage(msg));
}

// ─── Fetch raw HTML via CORS proxies ──────────────────────────────────────────
const PROXY_HOSTNAMES = ['purereader-proxy.vercel.app', 'api.allorigins.win', 'api.codetabs.com'];

async function fetchRawHtml(url) {
  const proxies = [
    {
      src: `https://purereader-proxy.vercel.app/api/proxy?url=${encodeURIComponent(url)}`,
      parse: async r => await r.text()
    },
    {
      src: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
      parse: async r => await r.text()
    },
    {
      src: `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
      parse: async r => { const d = await r.json(); return d.contents || null; }
    }
  ];
  for (const { src, parse } of proxies) {
    try {
      const res = await fetch(src);
      if (res.ok) { const html = await parse(res); if (html) return html; }
    } catch (e) { /* try next */ }
  }
  return null;
}

// ─── Process Background Sync queue ────────────────────────────────────────────
async function processSyncQueue() {
  const db    = await openDb();
  const items = await idbOp(db, 'sync-queue', 'readonly', s => s.getAll());
  for (const { url } of items) {
    try {
      const html = await fetchRawHtml(url);
      if (html) {
        await idbOp(db, 'raw-html',   'readwrite', s => s.put({ url, html, fetchedAt: Date.now() }));
        await idbOp(db, 'sync-queue', 'readwrite', s => s.delete(url));
        await notifyClients({ type: 'SYNC_COMPLETE', url });
      }
    } catch (e) { console.warn('[SW] Sync failed for', url, e); }
  }
}

// ─── Install / Activate ────────────────────────────────────────────────────────
self.addEventListener('install',  ()     => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('pureReader-') && !ALL_CACHES.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Message from main thread ──────────────────────────────────────────────────
// Sent when user submits a URL that fails to fetch in the foreground
self.addEventListener('message', async event => {
  const { type, url } = event.data || {};
  if (type !== 'REGISTER_SYNC' || !url) return;
  const db = await openDb();
  await idbOp(db, 'sync-queue', 'readwrite', s => s.put({ url, queuedAt: Date.now() }));
  // Try immediately; register sync tag as safety net
  const html = await fetchRawHtml(url);
  if (html) {
    await idbOp(db, 'raw-html',   'readwrite', s => s.put({ url, html, fetchedAt: Date.now() }));
    await idbOp(db, 'sync-queue', 'readwrite', s => s.delete(url));
    await notifyClients({ type: 'SYNC_COMPLETE', url });
  } else if (self.registration.sync) {
    self.registration.sync.register('pureReader-fetch').catch(() => {});
  }
});

// ─── Background Sync ──────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'pureReader-fetch') event.waitUntil(processSyncQueue());
});

// ─── Background Fetch ─────────────────────────────────────────────────────────
self.addEventListener('backgroundfetchsuccess', event => {
  event.waitUntil((async () => {
    const bgFetch = event.registration;
    const url     = decodeURIComponent(bgFetch.id);
    const db      = await openDb();
    for (const record of await bgFetch.matchAll()) {
      try {
        const res = await record.responseReady;
        const ct  = res.headers.get('content-type') || '';
        const html = ct.includes('json') ? (await res.json()).contents : await res.text();
        if (html) {
          await idbOp(db, 'raw-html', 'readwrite', s => s.put({ url, html, fetchedAt: Date.now() }));
          await notifyClients({ type: 'SYNC_COMPLETE', url });
        }
      } catch (e) { await notifyClients({ type: 'SYNC_FAILED', url }); }
    }
  })());
});

self.addEventListener('backgroundfetchfail', event => {
  notifyClients({ type: 'SYNC_FAILED', url: decodeURIComponent(event.registration.id) });
});

self.addEventListener('backgroundfetchclick', event => {
  event.waitUntil(clients.openWindow('./'));
});

// ─── Fetch (Stale-While-Revalidate) ───────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET')                                          return;
  if (!url.protocol.startsWith('http'))                                  return;
  if (PROXY_HOSTNAMES.includes(url.hostname))                            return;

  const cacheName = url.origin === self.location.origin ? CACHE_NAME : SHARED_CACHE;
  event.respondWith(
    caches.open(cacheName).then(cache =>
      cache.match(request).then(cached => {
        const net = fetch(request)
          .then(res => { if (res?.ok) cache.put(request, res.clone()); return res; })
          .catch(() => null);
        return cached || net;
      })
    )
  );
});
