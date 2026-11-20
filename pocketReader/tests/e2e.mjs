/**
 * 隨身閱讀 PocketReader — 端對端真實瀏覽器 + 本機 Worker 驗證
 * 使用 Node 22 原生 http + WebSocket (CDP) 驅動 Headless Chrome 與 wrangler dev --local
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POCKET_DIR = path.resolve(__dirname, '..');
const WORKER_DIR = path.join(POCKET_DIR, 'worker');
const PUBLISH_ROOT = path.resolve(POCKET_DIR, '..');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
};

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      let rel = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
      if (!rel || rel.endsWith('/')) rel += 'index.html';
      const filePath = path.resolve(rootDir, rel);
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        const indexFallback = path.join(filePath, 'index.html');
        if (fs.existsSync(indexFallback)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          fs.createReadStream(indexFallback).pipe(res);
          return;
        }
        res.writeHead(404).end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function startWranglerLocal(port = 8799) {
  const proc = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(port)], {
    cwd: WORKER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d.toString()));
  proc.stderr.on('data', (d) => (logs += d.toString()));

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        const j = await r.json();
        if (j.ok) return proc;
      }
    } catch {
      // waiting
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  proc.kill('SIGTERM');
  throw new Error(`wrangler dev 啟動逾時:\n${logs}`);
}

async function launchChrome() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-chrome-'));
  const proc = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsBrowserUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome 啟動逾時:\n${stderr}`)), 15000);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}):\n${stderr}`));
    });
  });

  const baseHttp = wsBrowserUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
  const targets = await (await fetch(`${baseHttp}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('找不到 Chrome Page Target');
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      const fns = listeners.get(msg.method) || [];
      for (const fn of fns) fn(msg.params);
    }
  });

  const cdp = {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    async eval(expression) {
      const res = await this.send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result?.value;
    },
    async close() {
      try { ws.close(); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
      await new Promise((r) => setTimeout(r, 300));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    },
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  return cdp;
}

/**
 * 產生包含真實文字物件的合法單頁 PDF（供測試 PDF.js 抽字與原版 PDF Canvas 渲染）
 */
function buildMinimalPdfBytes(text = 'PocketReader PDF Test') {
  const objects = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objects.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  );
  const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Array.from(Buffer.from(pdf, 'utf8'));
}

async function run() {
  const { server, port } = await startStaticServer(PUBLISH_ROOT);
  const workerPort = 8799;
  const workerProc = await startWranglerLocal(workerPort);
  const cdp = await launchChrome();

  const consoleErrors = [];
  const failedRequests = [];

  cdp.on('Runtime.exceptionThrown', (params) => {
    consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Exception');
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      consoleErrors.push(params.args.map((a) => a.value || a.description).join(' '));
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    if (params.response.status >= 400 && params.response.url.startsWith(`http://127.0.0.1:${port}`)) {
      failedRequests.push(`${params.response.status} ${params.response.url}`);
    }
  });

  try {
    await Promise.resolve();
  } catch {}
  try {
    const appUrl = `http://127.0.0.1:${port}/pocketReader/`;
    await cdp.send('Page.navigate', { url: appUrl });
    await cdp.eval(`
      for (let i = 0; i < 40; i++) {
        if (document.querySelectorAll('.book-card').length >= 2) return true;
        await new Promise(r => setTimeout(r, 150));
      }
      throw new Error('Starter books did not render');
    `);
    console.log('PASS  App loaded & starter books rendered');

    // 1. Check Service Worker registered
    const swScope = await cdp.eval(`
      const reg = await navigator.serviceWorker.ready;
      return reg?.scope || '';
    `);
    assert.ok(swScope.includes('/pocketReader/'), `Expected SW scope to include /pocketReader/, got ${swScope}`);
    console.log('PASS  Service Worker registered:', swScope);

    // 2. Full-library search & jump into reader
    const searchResCount = await cdp.eval(`
      const inp = document.getElementById('librarySearchInput');
      inp.value = '明明德';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const hits = document.querySelectorAll('#searchResultsPanel .search-hit-item');
      if (hits.length === 0) throw new Error('No search hits');
      hits[0].click();
      for (let i = 0; i < 20; i++) {
        if (!document.getElementById('readerView').hidden && document.getElementById('readerArticle').textContent.includes('大學')) {
          return hits.length;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('Reader did not open from search result');
    `);
    assert.ok(searchResCount >= 1);
    console.log('PASS  Full-library search & jump to paragraph');

    // 3. Font zoom, vertical-rl toggle, recite mask/cloze
    const readerCheck = await cdp.eval(`
      const stage = document.getElementById('readerStage');
      const beforeSize = parseInt(getComputedStyle(stage).getPropertyValue('--reader-font-size'), 10);
      document.getElementById('btnFontPlus').click();
      const afterSize = parseInt(getComputedStyle(stage).getPropertyValue('--reader-font-size'), 10);

      const wasVertical = document.getElementById('readerScrollArea').classList.contains('is-vertical');
      document.getElementById('btnToggleVertical').click();
      const isVertical = document.getElementById('readerScrollArea').classList.contains('is-vertical');

      document.getElementById('btnToggleRecite').click();
      document.querySelector('#reciteModeSwitch [data-recite="mask"]').click();
      const maskedCount = document.querySelectorAll('.recite-unit.is-masked').length;
      document.getElementById('btnRevealNext').click();
      const revealedCount = document.querySelectorAll('.recite-unit.is-revealed').length;

      document.querySelector('#reciteModeSwitch [data-recite="cloze"]').click();
      const clozeCount = document.querySelectorAll('.cloze-blank').length;

      document.getElementById('btnBackLibrary').click();
      return { beforeSize, afterSize, wasVertical, isVertical, maskedCount, revealedCount, clozeCount };
    `);
    assert.equal(readerCheck.afterSize, readerCheck.beforeSize + 2);
    assert.equal(readerCheck.wasVertical, true);
    assert.equal(readerCheck.isVertical, false);
    assert.ok(readerCheck.maskedCount > 0);
    assert.equal(readerCheck.revealedCount, 1);
    assert.ok(readerCheck.clozeCount >= 1);
    console.log('PASS  Reader zoom, vertical-rl, recite mask & cloze interactions');

    // 4. Import a real PDF via File input (exercises PDF.js + pdfjs-worker-bridge.mjs + dual text/PDF view)
    const pdfBytes = buildMinimalPdfBytes('PocketReader E2E PDF Content');
    const pdfCheck = await cdp.eval(`
      document.getElementById('btnOpenAdd').click();
      document.querySelector('#addTabs [data-tab="file"]').click();
      const bytes = new Uint8Array(${JSON.stringify(pdfBytes)});
      const file = new File([bytes], 'e2e-sample.pdf', { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      for (let i = 0; i < 50; i++) {
        if (!document.getElementById('readerView').hidden && document.getElementById('readerDocTitle').textContent === 'e2e-sample') {
          break;
        }
        await new Promise(r => setTimeout(r, 150));
      }
      const importStatus = document.getElementById('fileImportStatus')?.textContent;
      const toastMsg = document.getElementById('toastStack')?.textContent;
      const text = document.getElementById('readerArticle').textContent;
      const hasSwitch = !document.getElementById('viewModeSwitch').hidden;
      document.getElementById('btnModePdf').click();
      await new Promise(r => setTimeout(r, 600));
      const canvasW = document.getElementById('pdfCanvas').width;
      document.getElementById('btnBackLibrary').click();
      return { text, hasSwitch, canvasW, importStatus, toastMsg };
    `);
    console.log('PDF check details:', pdfCheck);
    assert.ok(pdfCheck.text.includes('PocketReader E2E PDF Content'));
    assert.equal(pdfCheck.hasSwitch, true);
    assert.ok(pdfCheck.canvasW > 0);
    console.log('PASS  PDF extraction via pdfjs-worker-bridge.mjs & original PDF canvas render');

    // 5. Real Cloudflare Worker Vault Sync + Share Publish + Subscribe check
    const syncCheck = await cdp.eval(`
      document.getElementById('btnOpenSync').click();
      document.getElementById('syncWorkerUrl').value = 'http://127.0.0.1:${workerPort}';
      document.getElementById('syncVaultCode').value = 'E2E-VAULT-88';
      document.getElementById('syncPassphrase').value = 'secret-pass-999';
      document.getElementById('btnRunSyncNow').click();

      for (let i = 0; i < 60; i++) {
        const msg = document.getElementById('syncProgressBox').textContent;
        if (msg.includes('同步完成')) {
          document.querySelector('#syncModal .icon-close').click();
          return msg;
        }
        await new Promise(r => setTimeout(r, 150));
      }
      throw new Error('Sync failed or timed out: ' + document.getElementById('syncProgressBox').textContent);
    `);
    assert.match(syncCheck, /同步完成/);
    console.log('PASS  Cloudflare Worker local R2 bidirectional sync:', syncCheck);

    // 6. Publish share & generate QR Code, then preview/subscribe
    const shareCheck = await cdp.eval(`
      const firstShareBtn = document.querySelector('.book-card [data-book-action="share"]');
      firstShareBtn.click();
      for (let i = 0; i < 30; i++) {
        if (!document.getElementById('shareModal').hidden) break;
        await new Promise(r => setTimeout(r, 80));
      }
      document.getElementById('btnCreateNewShare').click();
      for (let i = 0; i < 40; i++) {
        if (!document.getElementById('shareResultArea').hidden) break;
        await new Promise(r => setTimeout(r, 120));
      }
      const shareCode = document.getElementById('shareResultCode').textContent.trim();
      const shareUrl = document.getElementById('shareResultUrl').value;
      const qrW = document.getElementById('shareQrCanvas').width;
      document.querySelector('#shareModal .icon-close').click();

      // Test subscribing to that share code
      document.getElementById('btnOpenAdd').click();
      document.querySelector('#addTabs [data-tab="subscribe"]').click();
      document.getElementById('subCodeInput').value = shareCode;
      document.getElementById('btnPreviewSub').click();
      for (let i = 0; i < 30; i++) {
        if (document.getElementById('btnConfirmSubscribe')) break;
        await new Promise(r => setTimeout(r, 120));
      }
      document.getElementById('btnConfirmSubscribe').click();
      await new Promise(r => setTimeout(r, 500));
      return { shareCode, shareUrl, qrW };
    `);
    assert.equal(shareCheck.shareCode.length, 8);
    assert.ok(shareCheck.shareUrl.includes(`#sub=${shareCheck.shareCode}`));
    assert.ok(shareCheck.qrW > 0);
    console.log('PASS  Share publish, QR render & subscribe flow:', shareCheck.shareCode);

    // 7. Mobile back-button navigation: overlay -> reader -> home -> exit prompt -> stay in app
    await cdp.eval(`await new Promise(r => setTimeout(r, 200));`);
    const backNavCheck = await cdp.eval(`
      // Open modal from home and go back
      document.getElementById('btnOpenAdd').click();
      await new Promise(r => setTimeout(r, 80));
      const modalOpened = !document.getElementById('addModal').hidden;
      history.back();
      await new Promise(r => setTimeout(r, 120));
      const modalClosedByBack = document.getElementById('addModal').hidden && !document.getElementById('libraryView').hidden;

      // Open a book -> open TOC drawer -> Back closes TOC -> Back returns to home -> Back shows exit prompt -> Stay restores home
      document.querySelector('.book-card [data-book-action="open"]').click();
      for (let i = 0; i < 20; i++) {
        if (!document.getElementById('readerView').hidden) break;
        await new Promise(r => setTimeout(r, 80));
      }
      const inReader = !document.getElementById('readerView').hidden && history.state?.prNav === 'reader';

      document.getElementById('btnToggleToc').click();
      await new Promise(r => setTimeout(r, 80));
      const tocOpened = !document.getElementById('tocDrawer').hidden && history.state?.prNav === 'overlay';

      history.back();
      await new Promise(r => setTimeout(r, 150));
      const backClosedToc = document.getElementById('tocDrawer').hidden && !document.getElementById('readerView').hidden && history.state?.prNav === 'reader';

      history.back();
      await new Promise(r => setTimeout(r, 150));
      const backReturnedHome = document.getElementById('readerView').hidden && !document.getElementById('libraryView').hidden && history.state?.prNav === 'home';

      history.back();
      await new Promise(r => setTimeout(r, 150));
      const backClearedSearch = document.getElementById('librarySearchInput').value === '' && document.getElementById('searchResultsPanel').hidden && history.state?.prNav === 'home';

      history.back();
      await new Promise(r => setTimeout(r, 150));
      const exitPromptShown = !document.getElementById('exitPromptBar').hidden && history.state?.prNav === 'exit-guard';

      document.getElementById('btnStayInApp').click();
      await new Promise(r => setTimeout(r, 80));
      const stayRestoredHome = document.getElementById('exitPromptBar').hidden && history.state?.prNav === 'home';

      return { modalOpened, modalClosedByBack, inReader, tocOpened, backClosedToc, backReturnedHome, backClearedSearch, exitPromptShown, stayRestoredHome };
    `);
    assert.equal(backNavCheck.modalOpened, true);
    assert.equal(backNavCheck.modalClosedByBack, true);
    assert.equal(backNavCheck.inReader, true);
    assert.equal(backNavCheck.tocOpened, true);
    assert.equal(backNavCheck.backClosedToc, true);
    assert.equal(backNavCheck.backReturnedHome, true);
    assert.equal(backNavCheck.backClearedSearch, true);
    assert.equal(backNavCheck.exitPromptShown, true);
    assert.equal(backNavCheck.stayRestoredHome, true);
    console.log('PASS  Back navigation (overlay -> reader -> home -> clear search -> exit prompt -> stay)');

    // 8. Gesture page turn & chapter switch (swipe page-chapter, edge protection, swipe chapter-only, tap zones)
    const dispatchSwipe = async (startX, endX, y) => {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y }],
      });
      const steps = 6;
      for (let s = 1; s <= steps; s++) {
        const x = Math.round(startX + ((endX - startX) * s) / steps);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y }],
        });
        await new Promise((r) => setTimeout(r, 15));
      }
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await new Promise((r) => setTimeout(r, 300));
    };

    const dispatchTap = async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 200));
    };

    const dims = await cdp.eval(`
      const guideCard = [...document.querySelectorAll('.book-card')].find(c => c.dataset.bookId === 'starter-guide');
      guideCard.querySelector('[data-book-action="open"]').click();
      for (let i = 0; i < 20; i++) {
        if (!document.getElementById('readerView').hidden && document.getElementById('readerDocTitle').textContent.includes('隨身閱讀使用指南')) break;
        await new Promise(r => setTimeout(r, 80));
      }
      // Make font large so chapter 1 overflows vertically for intra-chapter page turn test
      document.getElementById('rangeFontSize').value = '40';
      document.getElementById('rangeFontSize').dispatchEvent(new Event('input', { bubbles: true }));
      const sa = document.getElementById('readerScrollArea');
      sa.scrollTop = 0;
      await new Promise(r => setTimeout(r, 100));
      const rect = sa.getBoundingClientRect();
      return {
        w: window.innerWidth,
        h: window.innerHeight,
        cx: Math.round(rect.left + rect.width * 0.5),
        cy: Math.round(rect.top + rect.height * 0.5),
        rx: Math.round(rect.left + rect.width * 0.9),
        canScroll: sa.scrollHeight > sa.clientHeight + 30,
        indicatorStart: document.querySelector('.chapter-indicator')?.textContent?.trim(),
      };
    `);
    assert.equal(dims.indicatorStart, '1 / 3');
    assert.equal(dims.canScroll, true);

    // Swipe left inside chapter 1 -> scrolls page down (stays on 1 / 3)
    await dispatchSwipe(Math.round(dims.w * 0.72), Math.round(dims.w * 0.25), dims.cy);
    const afterIntraTurn = await cdp.eval(`
      return {
        scrollTop: document.getElementById('readerScrollArea').scrollTop,
        indicator: document.querySelector('.chapter-indicator')?.textContent?.trim(),
      };
    `);
    assert.ok(afterIntraTurn.scrollTop > 20, `Expected scrollTop > 20, got ${afterIntraTurn.scrollTop}`);
    assert.equal(afterIntraTurn.indicator, '1 / 3');

    // Scroll to bottom of chapter 1 and swipe left -> turns to chapter 2
    await cdp.eval(`
      const sa = document.getElementById('readerScrollArea');
      sa.scrollTop = sa.scrollHeight - sa.clientHeight;
    `);
    await dispatchSwipe(Math.round(dims.w * 0.72), Math.round(dims.w * 0.25), dims.cy);
    const ch2Indicator = await cdp.eval(`return document.querySelector('.chapter-indicator')?.textContent?.trim();`);
    assert.equal(ch2Indicator, '2 / 3');

    // Edge guard: swipe from x=10 (OS back gesture zone) must NOT turn back to chapter 1
    await dispatchSwipe(10, 220, dims.cy);
    const stillCh2 = await cdp.eval(`return document.querySelector('.chapter-indicator')?.textContent?.trim();`);
    assert.equal(stillCh2, '2 / 3');

    // Swipe right at top of chapter 2 -> returns to chapter 1 (landAt end)
    await cdp.eval(`document.getElementById('readerScrollArea').scrollTop = 0;`);
    await dispatchSwipe(Math.round(dims.w * 0.25), Math.round(dims.w * 0.75), dims.cy);
    const backToCh1 = await cdp.eval(`return document.querySelector('.chapter-indicator')?.textContent?.trim();`);
    assert.equal(backToCh1, '1 / 3');

    // Switch swipe mode to 'chapter' (direct chapter turn anywhere) -> swipe left goes directly to chapter 2
    await cdp.eval(`
      document.getElementById('readerScrollArea').scrollTop = 0;
      document.getElementById('btnToggleAppearance').click();
      document.querySelector('#appearancePanel [data-swipe="chapter"]').click();
      document.getElementById('btnCloseAppearance').click();
    `);
    await new Promise((r) => setTimeout(r, 150));
    await dispatchSwipe(Math.round(dims.w * 0.72), Math.round(dims.w * 0.25), dims.cy);
    const directCh2 = await cdp.eval(`return document.querySelector('.chapter-indicator')?.textContent?.trim();`);
    assert.equal(directCh2, '2 / 3');

    // Tap center toggles immersive bars
    await dispatchTap(dims.cx, dims.cy);
    const immersiveOn = await cdp.eval(`return document.getElementById('readerView').classList.contains('is-immersive');`);
    assert.equal(immersiveOn, true);
    await dispatchTap(dims.cx, dims.cy);

    // Tap right zone turns forward (page or chapter 3)
    await cdp.eval(`
      const sa = document.getElementById('readerScrollArea');
      sa.scrollTop = sa.scrollHeight - sa.clientHeight;
    `);
    await dispatchTap(dims.rx, dims.cy);
    const tapCh3 = await cdp.eval(`
      const ind = document.querySelector('.chapter-indicator')?.textContent?.trim();
      document.getElementById('btnBackLibrary').click();
      return ind;
    `);
    assert.equal(tapCh3, '3 / 3');
    console.log('PASS  Gesture page turn, boundary cross-chapter, edge guard, chapter mode & tap zones');

    assert.equal(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join(' | ')}`);
    assert.equal(failedRequests.length, 0, `Unexpected HTTP >=400 requests: ${failedRequests.join(' | ')}`);
    console.log('PASS  Zero console errors & zero failed same-origin requests');
  } catch (err) {
    console.error('Console errors:', consoleErrors);
    console.error('Failed requests:', failedRequests);
    try {
      const snap = await cdp.eval(`return { url: location.href, cards: document.querySelectorAll('.book-card').length, toast: document.getElementById('toastStack')?.textContent };`);
      console.error('Page snapshot:', snap);
    } catch {}
    throw err;
  } finally {
    await cdp.close();
    workerProc.kill('SIGTERM');
    server.close();
  }
}

run().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
