const SW_VERSION = "v14";
const CACHE_NAME = `pdfEditor-${SW_VERSION}`;
const SHARE_CACHE_NAME = "pdfEditor-share-inbox";
const AUXILIARY_MANIFESTS = [
  "./vendor/pdfjs/offline-assets.json",
  "./vendor/tesseract/offline-assets.json",
];
const NETWORK_FIRST_ASSETS = [
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest",
];
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/pdfEditor-192.svg",
  "./icons/pdfEditor-512.svg",
  "./icons/pdfEditor-192.png",
  "./icons/pdfEditor-512.png",
  "./icons/pdfEditor-512-maskable.png",
  "./vendor/pdfjs/pdf.mjs",
  "./vendor/pdfjs/pdf.worker.mjs",
  ...AUXILIARY_MANIFESTS,
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
      for (const manifestUrl of AUXILIARY_MANIFESTS) {
        const manifestResponse = await fetch(manifestUrl);
        if (!manifestResponse.ok) {
          throw new Error(`Unable to load offline asset manifest: ${manifestUrl}`);
        }
        const auxiliaryAssets = await manifestResponse.json();
        await cache.addAll(auxiliaryAssets);
      }
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
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(
      (async () => {
        const formData = await request.formData();
        const files = formData
          .getAll("pdf")
          .filter((value) => value instanceof Blob)
          .filter((file) => {
            const name = String(file.name || "");
            return (
              name.toLowerCase().endsWith(".pdf") ||
              /pdf|octet-stream/i.test(file.type || "")
            );
          });
        if (!files.length) {
          return Response.redirect(new URL("./", request.url).href, 303);
        }
        const cache = await caches.open(SHARE_CACHE_NAME);
        const existingKeys = await cache.keys();
        await Promise.all(
          existingKeys
            .filter((cachedRequest) =>
              cachedRequest.url.includes("/shared-pdf")
            )
            .map((cachedRequest) => cache.delete(cachedRequest))
        );
        await Promise.all(
          files.map((file, index) => {
            const key = new URL(
              `./shared-pdf-${index}`,
              self.registration.scope
            ).href;
            return cache.put(
              key,
              new Response(file, {
                headers: {
                  "Content-Type": "application/pdf",
                  "X-PDF-File-Name": encodeURIComponent(
                    file.name || `分享的文件-${index + 1}.pdf`
                  ),
                },
              })
            );
          })
        );
        return Response.redirect(
          new URL(
            `./?shared=1&count=${files.length}`,
            self.registration.scope
          ).href,
          303
        );
      })()
    );
    return;
  }

  if (request.method !== "GET") return;
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

  if (NETWORK_FIRST_ASSETS.some((suffix) => url.pathname.endsWith(suffix))) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response?.ok) {
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(request))
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
