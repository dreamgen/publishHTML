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
 *    - POST /api/upload          接收 { html, title, ogImage?, shareMeta? }，存進 R2，回傳短網址與 editToken
 *    - POST /api/upload/:id      接收 { html, title?, editToken, ogImage?, shareMeta? }，更新同一個分享（要對得上 editToken）
 *    - GET  /s/:id               讀取並顯示已上傳的 HTML（就是分享出去的網址）
 *    - GET  /s/:id/og.jpg        讀取分享的 Open Graph 預覽圖片（支援 /og、/og.jpg、/og.png、/og.webp）
 *    需要 wrangler.toml 有 R2 binding：HTML_BUCKET
 */

// ─── CORS Headers ────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Cache, X-Final-URL, X-Detected-Charset, X-Bot-Challenge',
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
 * 阻擋內網／本機位址，避免 SSRF
 */
function isBlockedHostname(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

/**
 * 產生偽裝瀏覽器請求的 Headers（支援桌面直接造訪與行動端 Google 轉址雙配置）
 */
function buildBrowserHeaders(targetUrl, profile = 'desktop') {
  const u = new URL(targetUrl);
  const isMobile = profile === 'mobile';
  const headers = isMobile
    ? {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.google.com/',
        'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      }
    : {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      };

  // PTT 網頁版自動帶入 over18=1，避免卡在滿 18 歲確認頁
  if (u.hostname === 'www.ptt.cc' || u.hostname === 'ptt.cc') {
    headers['Cookie'] = 'over18=1';
  }
  return headers;
}

/**
 * 正規化字元編碼名稱
 */
function normalizeCharsetName(raw) {
  if (!raw) return '';
  const c = String(raw).trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!c) return '';
  if (c === 'utf8' || c === 'utf-8') return 'utf-8';
  if (['gb2312', 'gbk', 'gb_2312', 'gb_2312-80', 'x-gbk', 'csgb2312', 'gb18030'].includes(c)) return 'gb18030';
  if (['big5', 'big5-hkscs', 'cp950', 'csbig5', 'x-x-big5'].includes(c)) return 'big5';
  if (['shift_jis', 'shift-jis', 'sjis', 'x-sjis', 'ms932', 'windows-31j'].includes(c)) return 'shift-jis';
  if (['euc-jp', 'eucjp'].includes(c)) return 'euc-jp';
  if (['euc-kr', 'euckr', 'ks_c_5601-1987', 'cp949'].includes(c)) return 'euc-kr';
  if (['iso-8859-1', 'latin1', 'windows-1252'].includes(c)) return 'windows-1252';
  return c;
}

/**
 * 偵測 HTML 位元組的真實字元編碼（避免 GBK / Big5 / Shift_JIS 亂碼）
 */
function detectHtmlCharset(bytes, headerContentType) {
  // 1. 優先讀取 HTTP Content-Type 的明確宣告
  const headerMatch = (headerContentType || '').match(/charset\s*=\s*([^\s;]+)/i);
  const headerCharset = normalizeCharsetName(headerMatch?.[1]);
  if (headerCharset && headerCharset !== 'utf-8') {
    return headerCharset;
  }

  // 2. 檢查 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8';
  }

  // 3. 掃描前 4KB HTML 標頭中的 <meta charset> / <meta http-equiv="Content-Type">
  const headSlice = bytes.subarray(0, Math.min(bytes.length, 4096));
  let asciiHead = '';
  for (let i = 0; i < headSlice.length; i++) {
    asciiHead += String.fromCharCode(headSlice[i]);
  }
  const metaMatch =
    asciiHead.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i) ||
    asciiHead.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i) ||
    asciiHead.match(/<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9._-]+)/i);
  const metaCharset = normalizeCharsetName(metaMatch?.[1]);
  if (metaCharset) return metaCharset;

  return headerCharset || 'utf-8';
}

/**
 * 判斷是否為 Cloudflare / WAF 真人驗證頁（不應寫入 Worker 快取）
 */
function isBotChallengeText(text) {
  if (!text) return false;
  if (
    text.includes('cf-browser-verification') ||
    text.includes('Just a moment...') ||
    text.includes('Checking if the site connection is secure') ||
    text.includes('_cf_chl_opt') ||
    text.includes('cf_chl_') ||
    text.includes('Attention Required! | Cloudflare') ||
    text.includes('_Incapsula_Resource') ||
    text.includes('px-captcha')
  ) {
    return true;
  }
  if (text.length < 25000 && text.includes('Cloudflare') && text.includes('Ray ID')) {
    return true;
  }
  return false;
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
const HTML_SHARE_MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB
const HTML_SHARE_ID_LENGTH = 8;
const HTML_SHARE_ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'; // 移除易混淆字元 0/O/1/l/i
const HTML_SHARE_EDIT_TOKEN_LENGTH = 32;
const HTML_SHARE_EDIT_TOKEN_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

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

/**
 * 產生「編輯權杖」：只有上傳當下拿到這組權杖的人，之後才能用它更新同一個分享。
 * 不會出現在分享網址（/s/:id）裡，只在上傳／更新成功的回應中回傳一次，
 * 前端會把它存進本機的上傳紀錄（localStorage），所以只有原本上傳的那個瀏覽器能更新。
 */
function generateHtmlShareEditToken() {
  const bytes = new Uint8Array(HTML_SHARE_EDIT_TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let token = '';
  for (let i = 0; i < HTML_SHARE_EDIT_TOKEN_LENGTH; i++) {
    token += HTML_SHARE_EDIT_TOKEN_ALPHABET[bytes[i] % HTML_SHARE_EDIT_TOKEN_ALPHABET.length];
  }
  return token;
}

/**
 * 解析並驗證 Base64 Data URL 圖片（僅允許 jpeg / png / webp / gif，上限 2MB）。
 */
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    return { ok: false, error: '預覽圖片格式錯誤', status: 400 };
  }
  const match = dataUrl.trim().match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return { ok: false, error: '預覽圖片僅支援 JPEG / PNG / WebP / GIF 的 Base64 Data URL', status: 400 };
  }
  const rawType = match[1].toLowerCase();
  const contentType = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
  const cleanBase64 = match[2].replace(/\s+/g, '');

  let binary;
  try {
    binary = atob(cleanBase64);
  } catch {
    return { ok: false, error: '預覽圖片 Base64 編碼無效', status: 400 };
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  if (bytes.length === 0) {
    return { ok: false, error: '預覽圖片內容為空', status: 400 };
  }
  if (bytes.length > HTML_SHARE_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `預覽圖片過大（${(bytes.length / 1024 / 1024).toFixed(2)}MB），上限為 ${HTML_SHARE_MAX_IMAGE_BYTES / 1024 / 1024}MB`,
      status: 413,
    };
  }
  return { ok: true, contentType, bytes };
}

/**
 * 清理並限制 shareMeta 大小，以符合 Cloudflare R2 customMetadata 容量上限。
 */
function sanitizeShareMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const meta = {};
  const stringLimits = {
    type: 32,
    targetUrl: 500,
    description: 240,
    redirectMode: 32,
    badgeText: 40,
    themeKey: 32,
    ogImageMode: 32,
    ogImageUrl: 300,
    imageFit: 24,
  };
  for (const [key, maxLen] of Object.entries(stringLimits)) {
    if (typeof raw[key] === 'string' && raw[key].trim()) {
      meta[key] = raw[key].trim().slice(0, maxLen);
    }
  }
  if (typeof raw.openExternalInLine === 'boolean') {
    meta.openExternalInLine = raw.openExternalInLine;
  }
  if (Object.keys(meta).length === 0) return null;

  // 若序列化後超過 R2 customMetadata 安全配額（1200 bytes），優先保留關鍵欄位
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(meta)).length > 1200) {
    if (meta.description) meta.description = meta.description.slice(0, 100);
    if (meta.targetUrl) meta.targetUrl = meta.targetUrl.slice(0, 350);
    if (meta.ogImageUrl) meta.ogImageUrl = meta.ogImageUrl.slice(0, 200);
  }
  return encoder.encode(JSON.stringify(meta)).length <= 1400 ? meta : null;
}

/**
 * 替換 HTML 內的分享網址與預覽圖佔位符，讓新建分享時不必先知道 id 也能寫入正確 og:url / og:image。
 */
function applyHtmlSharePlaceholders(html, shareUrl, ogImageUrl) {
  return html
    .replaceAll('__HTMLSHARE_URL__', shareUrl)
    .replaceAll('__HTMLSHARE_OG_IMAGE__', ogImageUrl || '');
}

/**
 * 共用上傳與更新 payload 驗證，避免重複邏輯。
 */
function validateHtmlSharePayload(body, { requireEditToken }) {
  const html = typeof body?.html === 'string' ? body.html : null;
  const editToken = typeof body?.editToken === 'string' ? body.editToken : null;
  const titleInput = typeof body?.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 200)
    : null;

  if (requireEditToken && !editToken) {
    return { error: errorResponse('缺少編輯權杖，無法更新', 401) };
  }
  if (!html || !html.trim()) {
    return { error: errorResponse('沒有收到 HTML 內容', 400) };
  }

  const byteLength = new TextEncoder().encode(html).length;
  if (byteLength > HTML_SHARE_MAX_BYTES) {
    return {
      error: errorResponse(
        `檔案過大（${(byteLength / 1024 / 1024).toFixed(2)}MB），上限為 ${HTML_SHARE_MAX_BYTES / 1024 / 1024}MB`,
        413
      ),
    };
  }

  if (!/<\s*html|<!doctype\s+html|<\s*body|<\s*head/i.test(html)) {
    return { error: errorResponse('內容看起來不是 HTML，請確認上傳的檔案', 400) };
  }

  let parsedImage = null;
  const hasOgImageField = Object.prototype.hasOwnProperty.call(body || {}, 'ogImage');
  if (typeof body?.ogImage === 'string' && body.ogImage.trim()) {
    const imgResult = parseImageDataUrl(body.ogImage);
    if (!imgResult.ok) {
      return { error: errorResponse(imgResult.error, imgResult.status) };
    }
    parsedImage = { contentType: imgResult.contentType, bytes: imgResult.bytes };
  }

  const clearOgImage = hasOgImageField && body.ogImage === null;
  const shareMeta = sanitizeShareMeta(body?.shareMeta);

  return { html, editToken, titleInput, parsedImage, clearOgImage, shareMeta };
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

  const validated = validateHtmlSharePayload(body, { requireEditToken: false });
  if (validated.error) return validated.error;

  const { html, titleInput, parsedImage, shareMeta } = validated;
  const title = titleInput || '未命名分享';

  let id = generateHtmlShareId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await env.HTML_BUCKET.head(`${id}.html`);
    if (!existing) break;
    id = generateHtmlShareId();
  }

  const url = new URL(request.url);
  const shareUrl = `${url.origin}/s/${id}`;
  const ogImageUrl = parsedImage ? `${url.origin}/s/${id}/og.jpg?v=${Date.now()}` : null;
  const finalHtml = applyHtmlSharePlaceholders(html, shareUrl, ogImageUrl);
  const byteLength = new TextEncoder().encode(finalHtml).length;
  const uploadedAt = new Date().toISOString();
  const editToken = generateHtmlShareEditToken();

  const customMetadata = { title, uploadedAt, size: String(byteLength), editToken };
  if (shareMeta) {
    customMetadata.shareMeta = JSON.stringify(shareMeta);
  }

  if (parsedImage) {
    await env.HTML_BUCKET.put(`${id}.og`, parsedImage.bytes, {
      httpMetadata: { contentType: parsedImage.contentType },
      customMetadata: { uploadedAt },
    });
  }

  await env.HTML_BUCKET.put(`${id}.html`, finalHtml, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata,
  });

  const payload = { id, url: shareUrl, title, size: byteLength, uploadedAt, editToken };
  if (ogImageUrl) payload.ogImageUrl = ogImageUrl;
  if (shareMeta) payload.shareMeta = shareMeta;

  return new Response(JSON.stringify(payload), {
    status: 201,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 更新已上傳的分享內容（同一個 id、同一個網址，換掉裡面的 HTML 與選填的預覽圖）。
 * 必須帶上當初上傳時拿到的 editToken 才能更新，防止其他知道分享網址的人亂改內容。
 */
async function handleHtmlShareUpdate(id, request, env) {
  if (!env.HTML_BUCKET) {
    return errorResponse('後端尚未設定 R2 bucket（HTML_BUCKET），請檢查 wrangler.toml 並重新部署', 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('請求格式錯誤，需為 JSON', 400);
  }

  const validated = validateHtmlSharePayload(body, { requireEditToken: true });
  if (validated.error) return validated.error;

  const { html, editToken, titleInput, parsedImage, clearOgImage, shareMeta } = validated;

  const key = `${id}.html`;
  const existing = await env.HTML_BUCKET.head(key);
  if (!existing) {
    return errorResponse('找不到這個分享，無法更新（可能已被刪除）', 404);
  }

  const existingMeta = existing.customMetadata || {};
  if (!existingMeta.editToken || existingMeta.editToken !== editToken) {
    return errorResponse('編輯權杖不正確，無法更新這個分享', 403);
  }

  const url = new URL(request.url);
  const shareUrl = `${url.origin}/s/${id}`;
  const updatedAt = new Date().toISOString();
  const finalTitle = titleInput || existingMeta.title || '未命名分享';
  const ogKey = `${id}.og`;

  let hasOgImage = false;
  if (parsedImage) {
    await env.HTML_BUCKET.put(ogKey, parsedImage.bytes, {
      httpMetadata: { contentType: parsedImage.contentType },
      customMetadata: { updatedAt },
    });
    hasOgImage = true;
  } else if (clearOgImage) {
    await env.HTML_BUCKET.delete(ogKey);
    hasOgImage = false;
  } else if (html.includes('__HTMLSHARE_OG_IMAGE__')) {
    hasOgImage = Boolean(await env.HTML_BUCKET.head(ogKey));
  }

  const ogImageUrl = hasOgImage ? `${url.origin}/s/${id}/og.jpg?v=${Date.now()}` : null;
  const finalHtml = applyHtmlSharePlaceholders(html, shareUrl, ogImageUrl);
  const byteLength = new TextEncoder().encode(finalHtml).length;

  const customMetadata = {
    title: finalTitle,
    uploadedAt: existingMeta.uploadedAt || updatedAt,
    updatedAt,
    size: String(byteLength),
    editToken: existingMeta.editToken,
  };
  if (shareMeta) {
    customMetadata.shareMeta = JSON.stringify(shareMeta);
  }

  await env.HTML_BUCKET.put(key, finalHtml, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata,
  });

  const payload = {
    id,
    url: shareUrl,
    title: finalTitle,
    size: byteLength,
    uploadedAt: existingMeta.uploadedAt || updatedAt,
    updatedAt,
    editToken: existingMeta.editToken,
  };
  if (ogImageUrl) payload.ogImageUrl = ogImageUrl;
  if (shareMeta) payload.shareMeta = shareMeta;

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function handleHtmlShareServe(id, env, method = 'GET') {
  if (!env.HTML_BUCKET) {
    return htmlShareErrorPage('尚未設定後端', '後端尚未設定 R2 bucket，請檢查 wrangler.toml 並重新部署。', 500);
  }

  const object = await env.HTML_BUCKET.get(`${id}.html`);
  if (!object) {
    return htmlShareErrorPage('找不到這個分享', '連結可能已失效，或內容已被移除。', 404);
  }

  const html = method === 'HEAD' ? null : await object.text();

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      ...CORS_HEADERS,
    },
  });
}

async function handleHtmlShareOgImage(id, env, method = 'GET') {
  if (!env.HTML_BUCKET) {
    return errorResponse('後端尚未設定 R2 bucket（HTML_BUCKET）', 500);
  }

  const object = await env.HTML_BUCKET.get(`${id}.og`);
  if (!object) {
    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }

  const contentType = object.httpMetadata?.contentType || 'image/jpeg';
  return new Response(method === 'HEAD' ? null : object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      ...CORS_HEADERS,
    },
  });
}

// ─── PureReader Proxy ────────────────────────────────────────────────────────

async function fetchOriginWithProfile(targetUrl, profile, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: buildBrowserHeaders(targetUrl, profile),
      redirect: 'follow',
      signal: controller.signal,
    });
    const buffer = await res.arrayBuffer();
    return { res, bytes: new Uint8Array(buffer) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 將 HTML 位元組轉為 UTF-8（若原始編碼為 GBK/Big5/Shift_JIS 等則自動轉碼，避免前端亂碼）
 */
function normalizeHtmlPayload(bytes, rawContentType) {
  const isHtml = !rawContentType || /html|xml|text\/plain/i.test(rawContentType);
  if (!isHtml) {
    return {
      body: bytes,
      contentType: rawContentType || 'application/octet-stream',
      detectedCharset: '',
      sampleText: '',
    };
  }

  const detected = detectHtmlCharset(bytes, rawContentType);

  // 先確認是否原本就是合法 UTF-8（部分網站 HTML 寫舊 meta charset，實際已輸出 UTF-8）
  let decodedText = '';
  let effectiveCharset = detected;
  if (detected !== 'utf-8') {
    let isValidUtf8 = false;
    try {
      const utf8Strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // 若含非 ASCII 字元且完全合法 UTF-8，以 UTF-8 為準
      if (/[\u0080-\uffff]/.test(utf8Strict)) {
        decodedText = utf8Strict;
        effectiveCharset = 'utf-8';
        isValidUtf8 = true;
      }
    } catch {
      isValidUtf8 = false;
    }

    if (!isValidUtf8) {
      try {
        decodedText = new TextDecoder(detected, { fatal: false }).decode(bytes);
      } catch {
        decodedText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        effectiveCharset = 'utf-8';
      }
    }
  } else {
    decodedText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  const baseMime = (rawContentType || 'text/html').split(';')[0].trim() || 'text/html';
  return {
    body: decodedText,
    contentType: `${baseMime}; charset=utf-8`,
    detectedCharset: effectiveCharset,
    sampleText: decodedText,
  };
}

async function handlePureReaderProxy(request) {
  // 只允許 GET / HEAD
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Only GET and HEAD methods are allowed', 405);
  }

  const reqUrl = new URL(request.url);
  const targetUrlRaw = reqUrl.searchParams.get('url');
  const forceFresh = reqUrl.searchParams.get('fresh') === '1';

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
    if (isBlockedHostname(parsed.hostname)) {
      return errorResponse('Target host is not allowed', 403);
    }
  } catch {
    return errorResponse('Invalid URL');
  }

  const cache = caches.default;
  const cacheKey = new Request(targetUrl, { method: 'GET' });
  if (!forceFresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCors(cached, { 'X-Cache': 'HIT' });
    }
  }

  try {
    let attempt = await fetchOriginWithProfile(targetUrl, 'desktop', 11000);
    let payload = normalizeHtmlPayload(attempt.bytes, attempt.res.headers.get('Content-Type') || '');
    let challenge = isBotChallengeText(payload.sampleText);

    // 若桌面配置遭遇 403/406/429/503、Bot 驗證頁或極短內容，自動改用行動端 + Google Referer 再試一次
    const needsRetry =
      challenge ||
      [403, 406, 429, 503].includes(attempt.res.status) ||
      (attempt.res.status === 200 && attempt.bytes.length < 400);

    if (needsRetry) {
      try {
        const mobileAttempt = await fetchOriginWithProfile(targetUrl, 'mobile', 8000);
        const mobilePayload = normalizeHtmlPayload(
          mobileAttempt.bytes,
          mobileAttempt.res.headers.get('Content-Type') || ''
        );
        const mobileChallenge = isBotChallengeText(mobilePayload.sampleText);

        const mobileBetter =
          (mobileAttempt.res.status === 200 && !mobileChallenge && mobileAttempt.bytes.length >= 400) &&
          (attempt.res.status !== 200 || challenge || mobileAttempt.bytes.length > attempt.bytes.length);

        if (mobileBetter) {
          attempt = mobileAttempt;
          payload = mobilePayload;
          challenge = mobileChallenge;
        }
      } catch {
        // 保留第一次回應供客戶端判斷／切換下一個策略
      }
    }

    const finalUrl = attempt.res.url || targetUrl;
    const responseHeaders = {
      'Content-Type': payload.contentType,
      'Cache-Control': 's-maxage=600',
      'X-Final-URL': finalUrl,
    };
    if (payload.detectedCharset) {
      responseHeaders['X-Detected-Charset'] = payload.detectedCharset;
    }
    if (challenge) {
      responseHeaders['X-Bot-Challenge'] = '1';
      responseHeaders['Cache-Control'] = 'no-store';
    }

    const responseToCache = new Response(payload.body, {
      status: attempt.res.status,
      headers: responseHeaders,
    });

    const shouldCache =
      attempt.res.status === 200 &&
      !challenge &&
      attempt.bytes.length >= 500;

    return {
      responseToCache,
      cache,
      cacheKey,
      originStatus: attempt.res.status,
      shouldCache,
    };
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

    // 2. htmlShare：上傳（建立新分享）
    if (pathname === '/api/upload' && request.method === 'POST') {
      return handleHtmlShareUpload(request, env);
    }

    // 3. htmlShare：更新既有分享的內容（同一個 id、同一個網址，換掉裡面的 HTML）
    const updateMatch = pathname.match(/^\/api\/upload\/([A-Za-z0-9]+)$/);
    if (updateMatch && request.method === 'POST') {
      return handleHtmlShareUpdate(updateMatch[1], request, env);
    }

    // 4. htmlShare：讀取分享預覽圖片（Open Graph / Twitter Card）
    const ogMatch = pathname.match(/^\/s\/([A-Za-z0-9]+)\/og(?:\.(?:jpg|jpeg|png|webp))?$/);
    if (ogMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleHtmlShareOgImage(ogMatch[1], env, request.method);
    }

    // 5. htmlShare：讀取分享頁面
    const serveMatch = pathname.match(/^\/s\/([A-Za-z0-9]+)$/);
    if (serveMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleHtmlShareServe(serveMatch[1], env, request.method);
    }

    // 6. 其餘路徑：維持原本的 PureReader CORS 代理行為（GET/HEAD + ?url=）
    const result = await handlePureReaderProxy(request);
    if (result instanceof Response) {
      return result; // 錯誤回應（errorResponse 已內含 CORS）
    }

    const { responseToCache, cache, cacheKey, shouldCache } = result;
    if (shouldCache) {
      ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
    }
    return withCors(responseToCache, { 'X-Cache': 'MISS' });
  },
};
