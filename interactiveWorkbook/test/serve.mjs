#!/usr/bin/env node
/**
 * serve.mjs — 給無頭煙霧測試用的極小靜態伺服器。
 *
 * - 把 IW_SRC（預設 /tmp/iw）當根目錄原樣送出，不修改任何原始碼。
 * - 對 `./modules/firebase.js` 的請求改回傳同目錄下 fake-firebase.js 的內容，
 *   這樣不必改動 app 原始碼就能把後端換成假 RTDB。
 * - 攔掉 `./sw.js`（回傳一個什麼都不做的假 service worker），避免真的
 *   Service Worker 快取行為干擾測試、或註冊失敗在主控台留下錯誤訊息。
 * - 補上 /tmp/iw 這份程式碼副本本來就缺的 manifest.webmanifest 與
 *   icons/*.svg：這些只是 <link> 參照到的靜態資產遺漏，回傳最小可用的
 *   佔位內容，避免與「App 本身邏輯」無關的資源 404 混進測試雜訊。
 *   （QRious CDN 的攔截放在 smoke.mjs 用 Playwright 的網路路由做，因為
 *   那是完整外部網域的請求，這台伺服器看不到、也攔不到。）
 * - 提供 /__fakedb/* 這一組小小的 HTTP + SSE API，作為「共用後端」讓
 *   fake-firebase.js 在不同 BrowserContext（模擬不同裝置）之間真的共享
 *   同一份資料樹——這點細節見 fake-firebase.js 檔頭注解。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IW_SRC = path.resolve(process.env.IW_SRC || '/tmp/iw');
const FAKE_FIREBASE_PATH = path.join(HERE, 'fake-firebase.js');

const args = process.argv.slice(2);
const portArgIdx = args.indexOf('--port');
const PORT = Number(process.env.PORT || (portArgIdx >= 0 ? args[portArgIdx + 1] : 8791));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const NOOP_SW = `// harness 用的空白 service worker：不快取、不攔截 fetch，只是避免
// 註冊失敗在瀏覽器主控台留下訊息干擾測試。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
`;

const STUB_MANIFEST = JSON.stringify({
  name: '互動題本（測試用佔位 manifest）',
  short_name: '互動題本',
  start_url: '.',
  display: 'standalone',
  icons: [],
});

const STUB_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192"><rect width="192" height="192" fill="#123c58"/></svg>';

// ────────────────────────────────────────────────────────────────────────────
// 1. 假 RTDB：資料樹 + 路徑讀寫（含 RTDB「空物件不存在」「null 代表刪除」語義）
// ────────────────────────────────────────────────────────────────────────────
let dbRoot = {};
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

function splitPath(p) {
  return String(p || '').split('/').filter(Boolean);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 遞迴清理一個即將寫入的值：
 * - null / undefined → undefined（代表「這個節點不存在」，也就是刪除）
 * - 物件：遞迴清理每個 key，清完若沒有任何 key 留下（空物件）也視為 undefined
 *   —— 這就是「RTDB 不存空物件，等同刪除該節點」。
 * - 陣列：這個 App 寫進 RTDB 的值一律是物件或原始型別（見架構注解），
 *   陣列只是保守起見用 structuredClone 整份複製、不遞迴清理內容。
 */
function pruneValue(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return structuredClone(v);
  if (isPlainObject(v)) {
    const out = {};
    let any = false;
    Object.keys(v).forEach((k) => {
      const pv = pruneValue(v[k]);
      if (pv !== undefined) { out[k] = pv; any = true; }
    });
    return any ? out : undefined;
  }
  return v;
}

function readAtParts(parts, root = dbRoot) {
  let node = root;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[p];
  }
  return node;
}

/** 寫入後往上檢查：任何因為刪除而變成空物件的祖先節點，一併移除（RTDB 的真實行為）。 */
function pruneEmptyAncestors(parts) {
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const ancestorParts = parts.slice(0, i);
    const node = readAtParts(ancestorParts);
    if (isPlainObject(node) && Object.keys(node).length === 0) {
      const grandParentParts = ancestorParts.slice(0, -1);
      const grandParent = grandParentParts.length ? readAtParts(grandParentParts) : dbRoot;
      if (isPlainObject(grandParent)) delete grandParent[ancestorParts[ancestorParts.length - 1]];
    } else {
      break; // 這一層還有東西，往上的祖先一定也還有東西，不必再檢查
    }
  }
}

function writeAtParts(parts, rawValue) {
  const cleaned = pruneValue(rawValue);
  if (parts.length === 0) {
    dbRoot = cleaned === undefined ? {} : cleaned;
    return;
  }
  if (cleaned === undefined) {
    const parentParts = parts.slice(0, -1);
    const parent = parentParts.length ? readAtParts(parentParts) : dbRoot;
    if (isPlainObject(parent)) delete parent[parts[parts.length - 1]];
  } else {
    let node = dbRoot;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i];
      if (!isPlainObject(node[k])) node[k] = {};
      node = node[k];
    }
    node[parts[parts.length - 1]] = cleaned;
  }
  pruneEmptyAncestors(parts);
}

function broadcast(changedPaths) {
  const payload = `data: ${JSON.stringify({ paths: changedPaths })}\n\n`;
  sseClients.forEach((res) => { try { res.write(payload); } catch { /* client 已斷線 */ } });
}

function performWrites(writes) {
  writes.forEach(({ parts, value }) => writeAtParts(parts, value));
  broadcast(writes.map((w) => w.parts.join('/')));
}

// ────────────────────────────────────────────────────────────────────────────
// 2. /__fakedb/* API
// ────────────────────────────────────────────────────────────────────────────
function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleFakeDb(req, res, url) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET' && url.pathname === '/__fakedb/get') {
    const p = url.searchParams.get('path') || '';
    const v = readAtParts(splitPath(p));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ value: v === undefined ? null : structuredClone(v) }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/__fakedb/dump') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ tree: structuredClone(dbRoot) }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/__fakedb/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/__fakedb/set') {
    const body = await readJSONBody(req);
    performWrites([{ parts: splitPath(body.path), value: body.value }]);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/__fakedb/update') {
    const body = await readJSONBody(req);
    const base = String(body.path || '');
    const updates = body.updates || {};
    const writes = Object.entries(updates).map(([key, value]) => ({
      parts: splitPath(base ? `${base}/${key}` : key),
      value,
    }));
    performWrites(writes);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/__fakedb/seed') {
    const body = await readJSONBody(req);
    dbRoot = pruneValue(body.tree) || {};
    broadcast(['']); // 空字串路徑 = 根節點，對所有監聽者都算「受影響」
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 靜態檔案
// ────────────────────────────────────────────────────────────────────────────
function safeResolve(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, normalized);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw Error('路徑不合法');
  }
  return full;
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/modules/firebase.js') {
    const content = await fsp.readFile(FAKE_FIREBASE_PATH, 'utf8');
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(content);
    return;
  }
  if (pathname === '/sw.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(NOOP_SW);
    return;
  }

  const filePath = pathname === '/' ? path.join(IW_SRC, 'index.html') : safeResolve(IW_SRC, pathname);
  const ext = path.extname(filePath).toLowerCase();

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      const idx = path.join(filePath, 'index.html');
      const content = await fsp.readFile(idx);
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(content);
      return;
    }
    const content = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    // /tmp/iw 這份程式碼副本本來就缺 manifest.webmanifest 與 icons/*.svg，
    // 這兩種只是 index.html <link> 參照到的靜態資產、與 App 邏輯無關，
    // 補一個最小佔位內容，避免無關的 404 混進測試雜訊。
    if (ext === '.webmanifest') {
      res.writeHead(200, { 'Content-Type': MIME['.webmanifest'] });
      res.end(STUB_MANIFEST);
      return;
    }
    if (ext === '.svg' && pathname.startsWith('/icons/')) {
      res.writeHead(200, { 'Content-Type': MIME['.svg'] });
      res.end(STUB_ICON_SVG);
      return;
    }
    if (ext === '.css') {
      // /tmp/iw 這份程式碼副本沒有附 styles/*.css（base.css、group.css…）。
      // 缺少樣式不影響功能測試，但 404 會被 Chromium 記成 console.error，
      // 混進「任何一筆 console error 都算測試失敗」的判斷——回一份空白樣式表避免雜訊。
      res.writeHead(200, { 'Content-Type': MIME['.css'] });
      res.end('/* harness stub: 找不到原始 CSS，回傳空白樣式表 */\n');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + pathname);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4. HTTP 伺服器
// ────────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/__fakedb/')) {
    handleFakeDb(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
      }
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500: ' + (e && e.message ? e.message : e));
    });
    return;
  }
  serveStatic(req, res, url.pathname).catch((e) => {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500: ' + (e && e.message ? e.message : e));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve.mjs] 監聽 http://127.0.0.1:${PORT} ，IW_SRC=${IW_SRC}`);
});

// 存在的話就存在，不需要 fs 直接檢查 —— 找不到 IW_SRC 時第一次靜態檔案請求就會 404，
// 這裡先做一次友善提示。
if (!fs.existsSync(IW_SRC)) {
  console.error(`[serve.mjs] 警告：IW_SRC 目錄不存在：${IW_SRC}`);
}
