import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import('playwright-core').catch((error) => {
  if (!process.env.PDF_EDITOR_PLAYWRIGHT_CORE_PATH) throw error;
  return import(pathToFileURL(process.env.PDF_EDITOR_PLAYWRIGHT_CORE_PATH).href);
});
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${process.env.PDF_EDITOR_TEST_URL || 'http://127.0.0.1:8123'}/?testHarness=1`);
  await page.waitForFunction(() => window.__PDF_WORKSHOP_TEST__);
  await page.evaluate(() => window.__PDF_WORKSHOP_TEST__.ready);
  assert.equal(await page.locator('#exportImagesButton').isDisabled(), true);
  await page.evaluate(async () => {
    const app = window.__PDF_WORKSHOP_TEST__.app;
    const doc = await window.PDFLib.PDFDocument.create();
    for (let i = 0; i < 3; i++) {
      const p = doc.addPage([144, 72]);
      p.drawRectangle({ x: 0, y: 0, width: 20, height: 20, color: window.PDFLib.rgb(1, 0, 0) });
    }
    await app.loadFiles([new File([await doc.save()], 'test.pdf', { type: 'application/pdf' })], { replace: true, remember: false });
    app.pages[0].annotations.push({ id: 'annotation', type: 'rect', points: [[40, 10], [60, 30]], color: '#0000ff', width: 4 });
    app.dirty = true;
    app.capturedImages = [];
    app.downloadBlob = (blob, fileName) => { app.capturedImages.push({ blob, fileName }); return true; };
    window.showSaveFilePicker = undefined;
  });
  await page.locator('#exportImagesButton').click();
  await page.locator('#imageExportFormat').selectOption('png');
  await page.locator('#imageExportDpi').selectOption('72');
  assert.equal(await page.locator('#imageExportQualityField').isHidden(), true);
  await page.locator('#startImageExportButton').click();
  await page.waitForFunction(() => !window.__PDF_WORKSHOP_TEST__.app.imageExportRunning);
  const png = await page.evaluate(async () => {
    const app = window.__PDF_WORKSHOP_TEST__.app;
    const { blob, fileName } = app.capturedImages[0];
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    return { type: blob.type, fileName, width: bitmap.width, height: bitmap.height, dirty: app.dirty,
      white: [...ctx.getImageData(100, 30, 1, 1).data], red: [...ctx.getImageData(10, 62, 1, 1).data], blue: [...ctx.getImageData(40, 52, 1, 1).data] };
  });
  assert.equal(png.type, 'image/png'); assert.equal(png.fileName, 'test-images-page-001.png');
  assert.equal(png.width, 144); assert.equal(png.height, 72); assert.equal(png.dirty, true);
  assert.deepEqual(png.white, [255,255,255,255]); assert.deepEqual(png.red, [255,0,0,255]); assert.deepEqual(png.blue, [0,0,255,255]);
  console.log('PASS PNG dimensions, white background, PDF content, annotations, draft state');

  // Compare every pixel against an independently rotated unrotated image.
  for (const rotation of [90, 180, 270]) {
    const matched = await page.evaluate(async (rotation) => {
      const app = window.__PDF_WORKSHOP_TEST__.app;
      const record = app.pages[0];
      const options = { dpi: 72, mimeType: 'image/png', quality: 1 };
      record.rotation = 0;
      const base = await createImageBitmap((await app.renderPageAsImage(record, options)).blob);
      record.rotation = rotation;
      const actual = await createImageBitmap((await app.renderPageAsImage(record, options)).blob);
      const expected = document.createElement('canvas'); expected.width = actual.width; expected.height = actual.height;
      const ctx = expected.getContext('2d');
      ctx.translate(actual.width / 2, actual.height / 2); ctx.rotate(rotation * Math.PI / 180); ctx.drawImage(base, -base.width / 2, -base.height / 2);
      const got = document.createElement('canvas'); got.width = actual.width; got.height = actual.height;
      const gotCtx = got.getContext('2d'); gotCtx.drawImage(actual, 0, 0);
      const a = ctx.getImageData(0,0,expected.width,expected.height).data;
      const b = gotCtx.getImageData(0,0,got.width,got.height).data;
      record.rotation = 0;
      return a.every((value, index) => value === b[index]);
    }, rotation);
    assert.equal(matched, true, `rotation ${rotation}`);
  }
  console.log('PASS 90/180/270 degree page and annotation rotations');

  await page.locator('#exportImagesButton').click();
  await page.locator('#imageExportFormat').selectOption('jpg');
  await page.locator('#imageExportDpi').selectOption('150');
  assert.equal(await page.locator('#imageExportQualityField').isVisible(), true);
  await page.locator('#startImageExportButton').click();
  await page.waitForFunction(() => !window.__PDF_WORKSHOP_TEST__.app.imageExportRunning);
  const jpg = await page.evaluate(async () => {
    const { blob, fileName } = window.__PDF_WORKSHOP_TEST__.app.capturedImages.at(-1);
    const bitmap = await createImageBitmap(blob);
    return { type: blob.type, fileName, width: bitmap.width, height: bitmap.height, signature: [...new Uint8Array(await blob.arrayBuffer()).slice(0,3)] };
  });
  assert.equal(jpg.type, 'image/jpeg'); assert.equal(jpg.width, 300); assert.equal(jpg.height, 150);
  assert.deepEqual(jpg.signature, [255,216,255]);
  console.log('PASS JPG encoding and 150 DPI resolution');

  await page.evaluate(() => {
    const app = window.__PDF_WORKSHOP_TEST__.app;
    app.pages.reverse();
    app.selectedPageIds = new Set([app.pages[2].id, app.pages[0].id]);
  });
  await page.locator('#exportImagesButton').click();
  assert.equal(await page.locator('#imageExportScope').inputValue(), 'selected');
  await page.locator('#imageExportFormat').selectOption('png');
  await page.locator('#startImageExportButton').click();
  await page.waitForFunction(() => !window.__PDF_WORKSHOP_TEST__.app.imageExportRunning);
  const archive = await page.evaluate(async () => {
    const { blob, fileName } = window.__PDF_WORKSHOP_TEST__.app.capturedImages.at(-1);
    const files = window.fflate.unzipSync(new Uint8Array(await blob.arrayBuffer()));
    return { type: blob.type, fileName, names: Object.keys(files), signatures: Object.values(files).map((bytes) => [...bytes.slice(0,8)]) };
  });
  assert.equal(archive.type, 'application/zip');
  assert.deepEqual(archive.names, ['test-images-page-001.png', 'test-images-page-003.png']);
  for (const signature of archive.signatures) assert.deepEqual(signature, [137,80,78,71,13,10,26,10]);
  console.log('PASS selected pages ZIP, current document order and PNG file signatures');

  await page.evaluate(async () => {
    const app = window.__PDF_WORKSHOP_TEST__.app;
    app.elements.imageExportScope.value = 'all';
    await app.exportImages();
  });
  assert.equal(await page.evaluate(async () => Object.keys(window.fflate.unzipSync(new Uint8Array(await window.__PDF_WORKSHOP_TEST__.app.capturedImages.at(-1).blob.arrayBuffer()))).length), 3);
  console.log('PASS all pages ZIP');

  const failureCases = await page.evaluate(async () => {
    const app = window.__PDF_WORKSHOP_TEST__.app;
    const before = app.capturedImages.length;
    app.selectedPageIds.clear(); app.elements.imageExportScope.value = 'selected';
    await app.exportImages();
    const emptyDisabled = app.elements.startImageExportButton.disabled;
    app.elements.imageExportScope.value = 'active';
    window.showSaveFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
    await app.exportImages();
    window.showSaveFilePicker = undefined;
    const original = app.renderPageAsImage;
    app.renderPageAsImage = async () => { throw new Error('Expected test render failure'); };
    await app.exportImages();
    app.renderPageAsImage = original;
    return { emptyDisabled, noDownload: before === app.capturedImages.length, running: app.imageExportRunning, busy: !app.elements.busyOverlay.hidden };
  });
  assert.deepEqual(failureCases, { emptyDisabled: true, noDownload: true, running: false, busy: false });
  console.log('PASS empty selection, picker cancellation, render failure cleanup');

  const saved = await page.evaluate(async () => {
    const app = window.__PDF_WORKSHOP_TEST__.app;
    let options, written, closed = false;
    window.showSaveFilePicker = async (value) => {
      options = value;
      return { createWritable: async () => ({
        write: async (blob) => { written = blob; },
        close: async () => { closed = true; },
      }) };
    };
    await app.exportImages();
    window.showSaveFilePicker = undefined;
    await app.exportPages(app.pages.map((record) => record.id));
    const pdf = app.capturedImages.at(-1).blob;
    const document = await window.PDFLib.PDFDocument.load(await pdf.arrayBuffer());
    return { accepted: options.types[0].accept, imageType: written.type, closed,
      pdfType: pdf.type, pdfPages: document.getPageCount() };
  });
  assert.deepEqual(saved, { accepted: { 'image/png': ['.png'] }, imageType: 'image/png', closed: true,
    pdfType: 'application/pdf', pdfPages: 3 });
  console.log('PASS desktop save picker writes image and existing PDF export still opens');

  const share = await page.evaluate(async () => {
    const app = window.__PDF_WORKSHOP_TEST__.app;
    const originalEnv = app.getExportEnvironment;
    const originalShare = app.sharePdfFile;
    const originalCanShare = app.canSharePdfFile;
    app.getExportEnvironment = () => ({ mobile: true, ios: true, standalone: true });
    app.canSharePdfFile = () => true;
    const types = [];
    app.sharePdfFile = async (file) => { types.push(file.type); return 'file-share'; };
    for (const [type, name] of [['image/jpeg','test.jpg'], ['image/png','test.png'], ['application/zip','test.zip'], ['application/pdf','test.pdf']]) {
      await app.deliverExportedPdf({ blob: new Blob(['test'], { type }), fileName: name });
    }
    const promise = app.queuePreparedExportShare(new File(['test'], 'images.zip', { type: 'application/zip' }));
    const title = app.elements.exportReadyTitle.textContent;
    app.closeDialog(app.elements.exportReadyDialog, 'cancel');
    await promise;
    app.getExportEnvironment = originalEnv; app.sharePdfFile = originalShare; app.canSharePdfFile = originalCanShare;
    return { types, title };
  });
  assert.deepEqual(share.types, ['image/jpeg','image/png','application/zip','application/pdf']);
  assert.equal(share.title, 'ZIP 已建立');
  console.log('PASS mobile share MIME types and prepared ZIP dialog');

  for (const width of [320, 390, 768, 900, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const fits = await page.evaluate(() => {
      const brand = document.querySelector('.brand-mark').getBoundingClientRect();
      const controls = [...document.querySelector('.header-actions').children]
        .map((element) => element.getBoundingClientRect()).filter((rect) => rect.width);
      return controls.every((rect) => rect.left >= 0 && rect.right <= innerWidth &&
        (rect.top >= brand.bottom || rect.left >= brand.right));
    });
    assert.equal(fits, true, `header fits at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#exportImagesButton').click();
  await page.screenshot({ path: '/private/tmp/pdf-image-export-mobile.png' });
  const layout = await page.evaluate(() => {
    const rect = document.querySelector('#imageExportDialog').getBoundingClientRect();
    const button = document.querySelector('#exportImagesButton').getBoundingClientRect();
    return { dialogFits: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      buttonFits: button.left >= 0 && button.right <= innerWidth };
  });
  assert.deepEqual(layout, { dialogFits: true, buttonFits: true });
  assert.deepEqual(errors, []);
  console.log('PASS mobile layout and no uncaught browser errors');
} finally {
  await browser.close();
}
