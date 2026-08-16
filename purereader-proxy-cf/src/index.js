/**
 * publishHTML 共用 Worker — Cloudflare Workers
 *
 * 這個 Worker 現在身兼兩個用途（沿用同一次部署，不用另外開新 Worker）：
 *
 * 1. PureReader CORS Proxy（原本的功能，路徑：GET /?url=...）
 *    繞過小說網站的 CORS 限制。優勢：
 *      - Cloudflare 內部網路「同族信任」— 對受 CF 保護的網站穿透率遠高於外部代理
 *      - 偽裝完整瀏覽器 Headers（UA、Referer、Client Hints）以繞過 Bot 偵測
 *      - Cloudflare Cache API 快取成功回應 10 分鐘，減少重複請求
 *      - 每日 10 萬次免費額度，足夠個人使用
 *
 * 2. htmlShare 上傳／分享後端（新增功能）
 *    - POST /api/upload   接收 { html, title }，存進 R2，回傳短網址
 *    - GET  /s/:id         讀取並顯示已上傳的 HTML（就是分享出去的網址）
 *    需要 wrangler.toml 有 R2 binding：HTML_BUCKET
 */

// ─── CORS Headers ────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// ─── 域名正規化映射（與客戶端 normalizeUrl 保持一致）─────────────────────────
const DOMAIN_MAP = {
  'look.twword.com':  'www.novel543.com',
  'look.thisiscm.com': 'www.novel543.com',
};

/**
 * 正規化目標 URL（域名置換）
 */
function normalizeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (DOMAIN_MAP[u.hostname]) {
      u.hostname = DOMAIN_MAP[u.hostname];
    }
    return u.href;
  } catch {
    return urlStr;
  }
}

/**
 * 產生偽裝瀏覽器請求的 Headers
 */
function buildBrowserHeaders(targetUrl) {
  const u = new URL(targetUrl);
  return {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': `${u.protocol}//${u.hostname}/`,
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
  };
}

/**
 * 建立帶 CORS 的錯誤回應
 */
function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 為既有 Response 附加 CORS Headers（不可直接修改 immutable headers）
 */
function withCors(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...extraHeaders })) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─── htmlShare：上傳與分享 ────────────────────────────────────────────────────

const HTML_SHARE_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const HTML_SHARE_ID_LENGTH = 8;
const HTML_SHARE_ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'; // 移除易混淆字元 0/O/1/l/i

function htmlShareErrorPage(title, message, status) {
  const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#f8fafc;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px;box-sizing:border-box}
  .box{max-width:420px}
  h1{font-size:1.5rem;margin-bottom:.5rem}
  p{color:#94a3b8}
</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
  });
}

function generateHtmlShareId() {
  const bytes = new Uint8Array(HTML_SHARE_ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < HTML_SHARE_ID_LENGTH; i++) {
    id += HTML_SHARE_ID_ALPHABET[bytes[i] % HTML_SHARE_ID_ALPHABET.length];
  }
  return id;
}

async function handleHtmlShareUpload(request, env) {
  if (!env.HTML_BUCKET) {
    return errorResponse('後端尚未設定 R2 bucket（HTML_BUCKET），請檢查 wrangler.toml 並重新部署', 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('請求格式錯誤，需為 JSON', 400);
  }

  const html = typeof body?.html === 'string' ? body.html : null;
  const title = typeof body?.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 200)
    : '未命名分享';

  if (!html || !html.trim()) {
    return errorResponse('沒有收到 HTML 內容', 400);
  }

  const byteLength = new TextEncoder().encode(html).length;
  if (byteLength > HTML_SHARE_MAX_BYTES) {
    return errorResponse(
      `檔案過大（${(byteLength / 1024 / 1024).toFixed(2)}MB），上限為 ${HTML_SHARE_MAX_BYTES / 1024 / 1024}MB`,
      413
    );
  }

  if (!/<\s*html|<!doctype\s+html|<\s*body|<\s*head/i.test(html)) {
    return errorResponse('內容看起來不是 HTML，請確認上傳的檔案', 400);
  }

  let id = generateHtmlShareId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await env.HTML_BUCKET.head(`${id}.html`);
    if (!existing) break;
    id = generateHtmlShareId();
  }

  const uploadedAt = new Date().toISOString();

  await env.HTML_BUCKET.put(`${id}.html`, html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: { title, uploadedAt, size: String(byteLength) },
  });

  const url = new URL(request.url);
  const shareUrl = `${url.origin}/s/${id}`;

  return new Response(
    JSON.stringify({ id, url: shareUrl, title, size: byteLength, uploadedAt }),
    { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
  );
}

async function handleHtmlShareServe(id, env) {
  if (!env.HTML_BUCKET) {
    return htmlShareErrorPage('尚未設定後端', '後端尚未設定 R2 bucket，請檢查 wrangler.toml 並重新部署。', 500);
  }

  const object = await env.HTML_BUCKET.get(`${id}.html`);
  if (!object) {
    return htmlShareErrorPage('找不到這個分享', '連結可能已失效，或內容已被移除。', 404);
  }

  const html = await object.text();

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      ...CORS_HEADERS,
    },
  });
}

// ─── PureReader Proxy ────────────────────────────────────────────────────────

async function handlePureReaderProxy(request) {
  // 只允許 GET / HEAD
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Only GET and HEAD methods are allowed', 405);
  }

  const reqUrl = new URL(request.url);
  const targetUrlRaw = reqUrl.searchParams.get('url');

  if (!targetUrlRaw) {
    return errorResponse('Missing required parameter: url');
  }

  let targetUrl;
  try {
    targetUrl = normalizeUrl(targetUrlRaw);
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return errorResponse('Only http and https URLs are supported');
    }
  } catch {
    return errorResponse('Invalid URL');
  }

  const cache = caches.default;
  const cacheKey = new Request(targetUrl, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(cached, { 'X-Cache': 'HIT' });
  }

  try {
    const headers = buildBrowserHeaders(targetUrl);
    const originResponse = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });

    const body = await originResponse.arrayBuffer();

    let contentType = originResponse.headers.get('Content-Type') || 'text/html; charset=utf-8';
    if (contentType.includes('text/html') && !contentType.includes('charset')) {
      contentType += '; charset=utf-8';
    }

    const responseToCache = new Response(body, {
      status: originResponse.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 's-maxage=600',
      },
    });

    return { responseToCache, cache, cacheKey, originStatus: originResponse.status };
  } catch (e) {
    return errorResponse(`Fetch failed: ${e.message}`, 502);
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // 1. CORS Preflight（所有路徑共用）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. htmlShare：上傳
    if (pathname === '/api/upload' && request.method === 'POST') {
      return handleHtmlShareUpload(request, env);
    }

    // 3. htmlShare：讀取分享頁面
    const serveMatch = pathname.match(/^\/s\/([A-Za-z0-9]+)$/);
    if (serveMatch && request.method === 'GET') {
      return handleHtmlShareServe(serveMatch[1], env);
    }

    // 4. 其餘路徑：維持原本的 PureReader CORS 代理行為（GET/HEAD + ?url=）
    const result = await handlePureReaderProxy(request);
    if (result instanceof Response) {
      return result; // 錯誤回應（errorResponse 已內含 CORS）
    }

    const { responseToCache, cache, cacheKey, originStatus } = result;
    if (originStatus === 200) {
      ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
    }
    return withCors(responseToCache, { 'X-Cache': 'MISS' });
  },
};
