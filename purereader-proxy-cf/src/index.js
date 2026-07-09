/**
 * PureReader CORS Proxy — Cloudflare Workers
 *
 * 部署在 Cloudflare Workers 上的代理伺服器，用於繞過小說網站的 CORS 限制。
 * 優勢：
 *   1. Cloudflare 內部網路「同族信任」— 對受 CF 保護的網站穿透率遠高於外部代理
 *   2. 偽裝完整瀏覽器 Headers（UA、Referer、Client Hints）以繞過 Bot 偵測
 *   3. Cloudflare Cache API 快取成功回應 10 分鐘，減少重複請求
 *   4. 每日 10 萬次免費額度，足夠個人使用
 */

// ─── CORS Headers ────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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

// ─── Main Handler ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. 只允許 GET / HEAD
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse('Only GET and HEAD methods are allowed', 405);
    }

    // 3. 解析目標 URL
    const reqUrl = new URL(request.url);
    const targetUrlRaw = reqUrl.searchParams.get('url');

    if (!targetUrlRaw) {
      return errorResponse('Missing required parameter: url');
    }

    let targetUrl;
    try {
      targetUrl = normalizeUrl(targetUrlRaw);
      const parsed = new URL(targetUrl);
      // 安全限制：僅允許 http / https
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return errorResponse('Only http and https URLs are supported');
      }
    } catch {
      return errorResponse('Invalid URL');
    }

    // 4. 檢查 Cloudflare Cache（以正規化後的 targetUrl 作為 key）
    const cache = caches.default;
    const cacheKey = new Request(targetUrl, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCors(cached, { 'X-Cache': 'HIT' });
    }

    // 5. 向目標網站發起請求
    try {
      const headers = buildBrowserHeaders(targetUrl);
      const originResponse = await fetch(targetUrl, {
        method: 'GET',
        headers,
        redirect: 'follow',
      });

      // 讀取完整 body（以便快取與重新建構 Response）
      const body = await originResponse.arrayBuffer();

      // 偵測內容類型，確保 charset
      let contentType = originResponse.headers.get('Content-Type') || 'text/html; charset=utf-8';
      if (contentType.includes('text/html') && !contentType.includes('charset')) {
        contentType += '; charset=utf-8';
      }

      // 建立可快取的回應
      const responseToCache = new Response(body, {
        status: originResponse.status,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 's-maxage=600', // 快取在 CF 邊緣節點 10 分鐘
        },
      });

      // 僅快取成功的回應
      if (originResponse.status === 200) {
        ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
      }

      return withCors(responseToCache, { 'X-Cache': 'MISS' });

    } catch (e) {
      return errorResponse(`Fetch failed: ${e.message}`, 502);
    }
  },
};
