/**
 * Service Worker for 淨讀器 (pureReader) PWA — v13
 *
 * 1. App Shell : Pre-cache core files + Stale-While-Revalidate
 * 2. Background Sync  : 網路恢復時自動重試失敗的擷取（使用 CF Proxy + Bot 驗證過濾 + 編碼解碼）
 * 3. Background Fetch : 關掉 App 後仍可繼續下載
 */

const SW_VERSION   = 'v13';
const CACHE_NAME   = `pureReader-${SW_VERSION}`;
const SHARED_CACHE = `pureReader-shared-${SW_VERSION}`;
const ALL_CACHES   = [CACHE_NAME, SHARED_CACHE];
const APP_SHELL    = ['./', './index.html', './extractor.js', './manifest.webmanifest'];

// ─── IDB helpers ───────────────────────────────────────────────────────────────
const IDB_NAME    = 'pureReader-db';
const IDB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains('sync-queue'))
        db.createObjectStore('sync-queue', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('raw-html'))
        db.createObjectStore('raw-html', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('novel-pages'))
        db.createObjectStore('novel-pages', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('novel-sessions'))
        db.createObjectStore('novel-sessions', { keyPath: 'id' });
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

// ─── Fetch raw HTML via CORS proxies (never cached by SW fetch handler) ───────
const PROXY_HOSTNAMES = [
  'purereader-proxy-cf.dreamgen-dev.workers.dev',
  'purereader-proxy.vercel.app',
  'api.allorigins.win',
  'api.codetabs.com',
  'r.jina.ai',
];

function isBotChallengePage(html) {
  if (!html) return false;
  if (
    html.includes('cf-browser-verification') ||
    html.includes('Just a moment...') ||
    html.includes('Checking if the site connection is secure') ||
    html.includes('_cf_chl_opt') ||
    html.includes('cf_chl_') ||
    html.includes('Attention Required! | Cloudflare') ||
    html.includes('_Incapsula_Resource') ||
    html.includes('px-captcha')
  ) {
    return true;
  }
  return html.length < 25000 && html.includes('Cloudflare') && html.includes('Ray ID');
}

function isUsableHtml(html) {
  return Boolean(html && html.length >= 400 && !isBotChallengePage(html));
}

function decodeResponseBytes(buffer, contentType = '') {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // 非 UTF-8 時掃描 <meta charset> 與 Content-Type
    let head = '';
    for (let i = 0; i < Math.min(bytes.length, 4096); i++) head += String.fromCharCode(bytes[i]);
    const m =
      contentType.match(/charset\s*=\s*([^\s;]+)/i) ||
      head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i) ||
      head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i);
    let cs = (m?.[1] || '').toLowerCase();
    if (['gb2312', 'gbk', 'x-gbk'].includes(cs)) cs = 'gb18030';
    if (['big5-hkscs', 'cp950'].includes(cs)) cs = 'big5';
    if (cs) {
      try { return new TextDecoder(cs, { fatal: false }).decode(bytes); } catch {}
    }
    try { return new TextDecoder('gb18030', { fatal: false }).decode(bytes); } catch {}
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

async function fetchWithTimeout(src, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(src, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRawHtml(url) {
  const proxies = [
    {
      src: `https://purereader-proxy-cf.dreamgen-dev.workers.dev/?url=${encodeURIComponent(url)}`,
      timeout: 12000,
      parse: async r => decodeResponseBytes(await r.arrayBuffer(), r.headers.get('content-type') || '')
    },
    {
      src: `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
      timeout: 12000,
      parse: async r => { const d = await r.json(); return d.contents || null; }
    },
    {
      src: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
      timeout: 12000,
      parse: async r => decodeResponseBytes(await r.arrayBuffer(), r.headers.get('content-type') || '')
    },
    {
      src: `https://r.jina.ai/${url}`,
      timeout: 25000,
      parse: async r => {
        const md = await r.text();
        if (!md || md.length < 100) return null;
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const titleMatch = md.match(/^Title:\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '';
        const idx = md.indexOf('Markdown Content:');
        const body = idx >= 0 ? md.slice(idx + 'Markdown Content:'.length) : md;
        const paras = body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('\n');
        return `<!DOCTYPE html><html><head><title>${esc(title)}</title><meta name="pr-source" content="jina-markdown"></head><body><article>${paras}</article></body></html>`;
      }
    }
  ];
  for (const { src, timeout, parse } of proxies) {
    try {
      const res = await fetchWithTimeout(src, timeout);
      if (res.ok) {
        const html = await parse(res);
        if (isUsableHtml(html)) return html;
      }
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
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(APP_SHELL.map(asset => cache.add(asset).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

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
        const res  = await record.responseReady;
        const ct   = res.headers.get('content-type') || '';
        const html = ct.includes('json')
          ? (await res.json()).contents
          : decodeResponseBytes(await res.arrayBuffer(), ct);
        if (isUsableHtml(html)) {
          await idbOp(db, 'raw-html', 'readwrite', s => s.put({ url, html, fetchedAt: Date.now() }));
          await notifyClients({ type: 'SYNC_COMPLETE', url });
        } else {
          await notifyClients({ type: 'SYNC_FAILED', url });
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
  if (request.method !== 'GET')                return;
  if (!url.protocol.startsWith('http'))        return;
  if (PROXY_HOSTNAMES.includes(url.hostname))  return;

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
