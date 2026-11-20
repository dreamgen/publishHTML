const SW_VERSION = 'v2';
const CACHE_PREFIX = 'pocketReader-';
const CACHE_NAME = `${CACHE_PREFIX}${SW_VERSION}`;
const SHARE_CACHE_NAME = 'pocketReader-share-inbox';

const CORE_MANIFESTS = ['../pdfEditor/vendor/pdfjs/offline-assets.json'];
const LAZY_MANIFESTS = ['../pdfEditor/vendor/tesseract/offline-assets.json'];

const NETWORK_FIRST_SUFFIXES = [
  '/index.html',
  '/styles.css',
  '/config.js',
  '/manifest.webmanifest',
  '/modules/textEngine.js',
  '/modules/db.js',
  '/modules/parsers.js',
  '/modules/tts.js',
  '/modules/reader.js',
  '/modules/sync.js',
  '/modules/app.js',
];

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './manifest.webmanifest',
  './icons/pocketReader-192.svg',
  './icons/pocketReader-512.svg',
  './icons/pocketReader-192.png',
  './icons/pocketReader-512.png',
  './icons/pocketReader-512-maskable.png',
  './icons/apple-touch-icon.png',
  './vendor/pdfjs-worker-bridge.mjs',
  './vendor/tesseract-worker-bridge.js',
  './modules/textEngine.js',
  './modules/db.js',
  './modules/parsers.js',
  './modules/tts.js',
  './modules/reader.js',
  './modules/sync.js',
  './modules/app.js',
  '../pdfEditor/vendor/fflate/fflate.min.js',
  '../eventControl/vendor/qrious.min.js',
  '../pdfEditor/vendor/pdfjs/pdf.mjs',
  '../pdfEditor/vendor/pdfjs/pdf.worker.mjs',
  '../pdfEditor/vendor/pdfjs/offline-assets.json',
  '../pdfEditor/vendor/tesseract/offline-assets.json',
];

function rewriteVendorManifestEntry(entry) {
  return String(entry || '').replace(/^\.\/vendor\//, '../pdfEditor/vendor/');
}

async function readAssetManifest(cache, manifestUrl) {
  const response = (await cache.match(manifestUrl)) || (await fetch(manifestUrl));
  if (!response || !response.ok) {
    throw new Error(`Unable to load offline asset manifest: ${manifestUrl}`);
  }
  const items = await response.json();
  return Array.isArray(items) ? items.map(rewriteVendorManifestEntry) : [];
}

async function cacheBatch(cache, urls, { optional = false } = {}) {
  for (const url of urls) {
    if (!url) continue;
    try {
      const existing = await cache.match(url);
      if (existing) continue;
      const res = await fetch(url);
      if (res && res.ok) {
        await cache.put(url, res);
      }
    } catch (err) {
      if (!optional) throw err;
    }
  }
}

async function warmLazyAssets() {
  const cache = await caches.open(CACHE_NAME);
  for (const manifestUrl of LAZY_MANIFESTS) {
    try {
      const assets = await readAssetManifest(cache, manifestUrl);
      await cacheBatch(cache, assets, { optional: true });
    } catch {
      // OCR assets remain lazily cached on demand.
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      for (const manifestUrl of CORE_MANIFESTS) {
        try {
          const auxAssets = await readAssetManifest(cache, manifestUrl);
          await cacheBatch(cache, auxAssets, { optional: true });
        } catch {
          // Best effort for auxiliary PDF.js cmaps/wasm when offline during re-install
        }
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME && key !== SHARE_CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'warm-ocr-cache') {
    event.waitUntil(warmLazyAssets().catch(() => {}));
  } else if (event.data?.type === 'get-sw-version') {
    event.ports?.[0]?.postMessage({ version: SW_VERSION, cacheName: CACHE_NAME });
  }
});

async function handleShareTarget(request) {
  const formData = await request.formData();
  const title = String(formData.get('title') || '').trim();
  const text = String(formData.get('text') || '').trim();
  const sharedUrl = String(formData.get('url') || '').trim();
  const rawFiles = formData.getAll('files').filter((item) => item instanceof Blob && item.size > 0);

  const cache = await caches.open(SHARE_CACHE_NAME);
  const existingKeys = await cache.keys();
  await Promise.all(existingKeys.map((k) => cache.delete(k)));

  const meta = {
    title,
    text,
    url: sharedUrl,
    fileCount: rawFiles.length,
    receivedAt: Date.now(),
  };

  await cache.put(
    new URL('./__share-meta__.json', self.registration.scope).href,
    new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  );

  await Promise.all(
    rawFiles.map((file, idx) => {
      const fileUrl = new URL(`./__share-file__-${idx}`, self.registration.scope).href;
      return cache.put(
        fileUrl,
        new Response(file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Share-File-Name': encodeURIComponent(file.name || `分享檔案-${idx + 1}`),
          },
        })
      );
    })
  );

  return Response.redirect(new URL('./?share-inbox=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method === 'POST' &&
    url.origin === self.location.origin &&
    (url.searchParams.has('share-target') || url.pathname.endsWith('/share-target'))
  ) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (NETWORK_FIRST_SUFFIXES.some((suffix) => url.pathname.endsWith(suffix))) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request, { ignoreSearch: true }))
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          if (res && res.ok && (url.pathname.includes('/pocketReader/') || url.pathname.includes('/vendor/'))) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
