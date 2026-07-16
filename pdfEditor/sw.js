const SW_VERSION = "v5";
const CACHE_NAME = `pdfEditor-${SW_VERSION}`;
const AUXILIARY_MANIFEST = "./vendor/pdfjs/offline-assets.json";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/pdfEditor-192.svg",
  "./icons/pdfEditor-512.svg",
  "./vendor/pdfjs/pdf.mjs",
  "./vendor/pdfjs/pdf.worker.mjs",
  AUXILIARY_MANIFEST,
  "./vendor/pdfjs/standard_fonts/FoxitDingbats.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitFixed.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSerif.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSymbol.pfb",
  "./vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf",
  "./vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf",
  "./vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf",
  "./vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
  "./vendor/pdf-lib/pdf-lib.min.js",
  "./vendor/pdf-lib/fontkit.umd.min.js",
  "./vendor/pdf-lib/NotoSansCJKtc-Regular.otf"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      const manifestResponse = await fetch(AUXILIARY_MANIFEST);
      if (!manifestResponse.ok) {
        throw new Error("Unable to load PDF.js offline asset manifest");
      }
      const auxiliaryAssets = await manifestResponse.json();
      await cache.addAll(auxiliaryAssets);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("pdfEditor-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response?.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => null);
      return cached || network;
    })
  );
});
