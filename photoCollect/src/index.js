// Worker 進入點：API、頁面路由、安全標頭、排程
import { CSP, LOGIN_CSP, HttpError, errorResponse } from './util.js';
import { googleClientId } from './session.js';
import { handleApi } from './router.js';
import { runPurge } from './schedule.js';
import {
  eventForPage, pageMeta, rewriteUploadHead, serveOg, albumForPage, albumMeta, serveAlbumOg,
} from './og.js';

// 所有回應都加的標頭
// login=true 時改用含 Google 網域的 CSP（§8.8）；有設定 GOOGLE_CLIENT_ID 才會是 true
function finalize(res, { html = false, login = false } = {}) {
  const r = new Response(res.body, res);
  r.headers.set('X-Robots-Tag', 'noindex');
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Referrer-Policy', 'no-referrer');
  if (html) {
    r.headers.set('Content-Security-Policy', login ? LOGIN_CSP : CSP);
    r.headers.set('Content-Type', 'text/html; charset=utf-8');
    r.headers.set('Cache-Control', 'no-cache');
  }
  return r;
}

// 取靜態檔；Assets 對 .html 會 307 轉到無副檔名路徑，這裡自行追蹤轉址（最多 4 次）
async function fetchAsset(env, req, path) {
  let u = new URL(path, req.url);
  for (let i = 0; i < 4; i++) {
    const r = await env.ASSETS.fetch(new Request(u, { method: 'GET' }));
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      u = new URL(r.headers.get('location'), u);
      continue;
    }
    return r;
  }
  return new Response('Not Found', { status: 404 });
}

async function servePage(env, req, path, login = false) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return finalize(errorResponse(405, 'method_not_allowed', '不支援的請求方法。'));
  }
  const r = await fetchAsset(env, req, path);
  if (r.status !== 200) return finalize(errorResponse(404, 'not_found', '找不到頁面。'));
  return finalize(new Response(req.method === 'HEAD' ? null : r.body, { status: 200, headers: r.headers }), { html: true, login });
}

// /u/{code}：回上傳頁外殼，並依活動設定改寫 head 的分享預覽 meta（LINE、FB 等爬蟲不執行 JS）
async function serveUploadPage(env, req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return finalize(errorResponse(405, 'method_not_allowed', '不支援的請求方法。'));
  }
  const r = await fetchAsset(env, req, '/upload.html');
  if (r.status !== 200) return finalize(errorResponse(404, 'not_found', '找不到頁面。'));
  let code = '';
  try { code = decodeURIComponent(url.pathname.split('/')[2] || ''); } catch { /* 壞編碼當作無碼 */ }
  const cfg = await eventForPage(env, code); // 無效碼、已換碼、已刪除 → null → 通用文字
  const base = new Response(r.body, { status: 200, headers: r.headers });
  const out = rewriteUploadHead(base, pageMeta(cfg, url.origin, code));
  return finalize(new Response(req.method === 'HEAD' ? null : out.body, { status: 200, headers: out.headers }), { html: true, login: !!googleClientId(env) });
}

// /a/{code}：參與者相簿頁
async function serveAlbumPage(env, req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return finalize(errorResponse(405, 'method_not_allowed', '不支援的請求方法。'));
  }
  const r = await fetchAsset(env, req, '/album.html');
  if (r.status !== 200) return finalize(errorResponse(404, 'not_found', '找不到頁面。'));
  let code = '';
  try { code = decodeURIComponent(url.pathname.split('/')[2] || ''); } catch { /* 壞編碼當作無碼 */ }
  const cfg = await albumForPage(env, code);
  const base = new Response(r.body, { status: 200, headers: r.headers });
  const out = rewriteUploadHead(base, await albumMeta(env, cfg, url.origin, code));
  return finalize(new Response(req.method === 'HEAD' ? null : out.body, { status: 200, headers: out.headers }), { html: true, login: !!googleClientId(env) });
}

// GET /og/{code}：公開的分享預覽圖
async function serveOgRoute(env, req, code) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return finalize(errorResponse(405, 'method_not_allowed', '不支援的請求方法。'));
  }
  return finalize(await serveOg(env, req, code));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      // OPTIONS 一律 204、不帶 CORS 標頭
      if (req.method === 'OPTIONS') return finalize(new Response(null, { status: 204 }));

      if (p === '/api' || p.startsWith('/api/')) return finalize(await handleApi(req, env, url));

      if (/^\/u\/([^/]+\/?)?$/.test(p)) return serveUploadPage(env, req, url);
      if (/^\/u\/[^/]+\/mine\/?$/.test(p)) return servePage(env, req, '/mine.html', !!googleClientId(env));
      if (/^\/a\/([^/]+\/?)?$/.test(p)) return serveAlbumPage(env, req, url);
      const oga = /^\/og\/a\/([^/]+)\/?$/.exec(p);
      if (oga) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return finalize(errorResponse(405, 'method_not_allowed', '不支援的請求方法。'));
        let code = oga[1];
        try { code = decodeURIComponent(code); } catch { /* 無效碼 */ }
        return finalize(await serveAlbumOg(env, req, code));
      }
      const og = /^\/og\/([^/]+)\/?$/.exec(p);
      if (og) {
        let code = og[1];
        try { code = decodeURIComponent(code); } catch { /* 保持原樣，之後會被當成無效碼 */ }
        return serveOgRoute(env, req, code);
      }
      if (p === '/admin' || p === '/admin/') return servePage(env, req, '/admin.html', !!googleClientId(env));
      if (p === '/download' || p === '/download/') return servePage(env, req, '/download/index.html');

      // 其他交給靜態資源；HTML 同樣加 CSP
      const r = await env.ASSETS.fetch(req);
      const isHtml = (r.headers.get('content-type') || '').includes('text/html') && r.status === 200;
      // 首頁（/）有登入按鈕，用含 Google 網域的 CSP；其餘靜態頁維持原樣
      const login = isHtml && (p === '/' || p === '/index.html') && !!googleClientId(env);
      return finalize(r, { html: isHtml, login });
    } catch (e) {
      if (e instanceof HttpError) return finalize(errorResponse(e.status, e.code, e.message));
      console.error('unhandled', e && e.stack);
      return finalize(errorResponse(500, 'internal', '伺服器發生錯誤，請稍後再試。'));
    }
  },

  async scheduled(_event, env, _ctx) {
    await runPurge(env);
  },
};
