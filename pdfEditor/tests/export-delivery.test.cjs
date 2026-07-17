const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const moduleUrl = pathToFileURL(
  path.join(__dirname, "..", "export-delivery.mjs")
).href;

test("desktop download keeps the selected file handle", async () => {
  const { chooseExportDelivery } = await import(moduleUrl);
  assert.equal(
    chooseExportDelivery({
      requestedMode: "download",
      hasFileHandle: true,
      canShareFile: true,
      environment: { mobile: false, standalone: false },
    }),
    "file-picker"
  );
});

test("Android without a picker uses file sharing", async () => {
  const { chooseExportDelivery } = await import(moduleUrl);
  assert.equal(
    chooseExportDelivery({
      requestedMode: "download",
      canShareFile: true,
      environment: { android: true, mobile: true, standalone: true },
    }),
    "file-share"
  );
});

test("Android browser tab also uses file sharing when available", async () => {
  const { chooseExportDelivery } = await import(moduleUrl);
  assert.equal(
    chooseExportDelivery({
      requestedMode: "download",
      canShareFile: true,
      environment: { android: true, mobile: true, standalone: false },
    }),
    "file-share"
  );
});

test("iOS Safari and standalone use file sharing when available", async () => {
  const { chooseExportDelivery } = await import(moduleUrl);
  for (const standalone of [false, true]) {
    assert.equal(
      chooseExportDelivery({
        requestedMode: "download",
        canShareFile: true,
        environment: { ios: true, mobile: true, standalone },
      }),
      "file-share"
    );
  }
});

test("iOS standalone never falls through to a blob navigation", async () => {
  const { chooseExportDelivery } = await import(moduleUrl);
  assert.equal(
    chooseExportDelivery({
      requestedMode: "download",
      canShareFile: false,
      environment: { ios: true, mobile: true, standalone: true },
    }),
    "ios-standalone-unsupported"
  );
});

test("mobile browser download uses blob only as the final fallback", async () => {
  const { chooseExportDelivery } = await import(moduleUrl);
  assert.equal(
    chooseExportDelivery({
      requestedMode: "download",
      canShareFile: false,
      environment: { android: true, mobile: true, standalone: false },
    }),
    "blob-download"
  );
});

test("standalone Android without file sharing avoids blob download", async () => {
  const { chooseExportDelivery } = await import(moduleUrl);
  assert.equal(
    chooseExportDelivery({
      requestedMode: "download",
      canShareFile: false,
      environment: { android: true, mobile: true, standalone: true },
    }),
    "standalone-unsupported"
  );
});

test("explicit sharing reports unsupported instead of downloading", async () => {
  const { chooseExportDelivery } = await import(moduleUrl);
  assert.equal(
    chooseExportDelivery({
      requestedMode: "share",
      canShareFile: false,
      environment: { mobile: false, standalone: false },
    }),
    "share-unsupported"
  );
});

test("iPadOS desktop user agent is detected as iOS mobile", async () => {
  const { detectExportEnvironment } = await import(moduleUrl);
  assert.deepEqual(
    detectExportEnvironment({
      navigatorLike: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      },
      standalone: true,
    }),
    { android: false, ios: true, mobile: true, standalone: true }
  );
});
