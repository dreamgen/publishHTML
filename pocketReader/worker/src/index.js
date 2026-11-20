/**
 * 隨身閱讀 PocketReader — Cloudflare Worker + R2 雲端同步與分享訂閱後端
 *
 * R2 儲存配置：
 *   vaults/<vaultKey>/meta.json
 *   vaults/<vaultKey>/manifest.json
 *   vaults/<vaultKey>/books/<bookId>.json
 *   vaults/<vaultKey>/blobs/<sha256>
 *   shares/<shareId>/meta.json
 *   shares/<shareId>/bundle.json
 *   shares/<shareId>/blobs/<sha256>
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Vault-Code, X-Vault-Token, X-Edit-Token',
  'Access-Control-Max-Age': '86400',
};

const MAX_BOOK_BYTES = 10 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_SHARE_BUNDLE_BYTES = 15 * 1024 * 1024;
const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const MAX_FETCH_URL_BYTES = 3 * 1024 * 1024;

const SHARE_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const BOOK_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const BLOB_HASH_RE = /^[a-f0-9]{64}$/;
const SHARE_ID_RE = /^[a-zA-Z0-9]{6,16}$/;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}

function randomFromAlphabet(alphabet, len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

async function readBodyLimited(request, maxBytes) {
  const contentLen = Number(request.headers.get('content-length') || 0);
  if (contentLen > maxBytes) {
    return { ok: false, status: 413, error: `內容超過上限（${Math.round(maxBytes / 1024 / 1024)} MB）` };
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    return { ok: false, status: 413, error: `內容超過上限（${Math.round(maxBytes / 1024 / 1024)} MB）` };
  }
  return { ok: true, buf };
}

function validateVaultHeaders(request) {
  const code = String(request.headers.get('X-Vault-Code') || '').trim();
  const token = String(request.headers.get('X-Vault-Token') || '').trim();
  if (code.length < 3 || code.length > 64) {
    return { ok: false, status: 400, error: '同步碼長度須為 3～64 字元' };
  }
  if (token.length < 16 || token.length > 128) {
    return { ok: false, status: 401, error: '缺少或無效的同步密碼權杖' };
  }
  return { ok: true, code, token };
}

async function authenticateVault(request, bucket) {
  const hdr = validateVaultHeaders(request);
  if (!hdr.ok) return hdr;
  const vaultKey = await sha256Hex(`vault:${hdr.code}`);
  const tokenHash = await sha256Hex(`token:${hdr.token}`);

  const metaObj = await bucket.get(`vaults/${vaultKey}/meta.json`);
  if (!metaObj) {
    return { ok: false, status: 404, error: '此同步碼尚未在雲端建立書庫' };
  }
  const meta = JSON.parse(await metaObj.text());
  if (!timingSafeEqualStr(meta.tokenHash, tokenHash)) {
    return { ok: false, status: 401, error: '同步密碼不正確' };
  }
  return { ok: true, vaultKey, tokenHash, meta };
}

async function handleVaultInit(request, bucket) {
  const hdr = validateVaultHeaders(request);
  if (!hdr.ok) return errorResponse(hdr.error, hdr.status);

  const vaultKey = await sha256Hex(`vault:${hdr.code}`);
  const tokenHash = await sha256Hex(`token:${hdr.token}`);
  const metaPath = `vaults/${vaultKey}/meta.json`;
  const manifestPath = `vaults/${vaultKey}/manifest.json`;

  const existing = await bucket.get(metaPath);
  if (existing) {
    const meta = JSON.parse(await existing.text());
    if (!timingSafeEqualStr(meta.tokenHash, tokenHash)) {
      return errorResponse('此同步碼已存在且密碼不符', 401);
    }
    return jsonResponse({ ok: true, status: 'verified', createdAt: meta.createdAt });
  }

  const now = Date.now();
  await bucket.put(metaPath, JSON.stringify({ tokenHash, createdAt: now, updatedAt: now }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  await bucket.put(manifestPath, JSON.stringify({ version: 1, updatedAt: now, books: {}, categories: [] }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

  return jsonResponse({ ok: true, status: 'created', createdAt: now }, 201);
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::'
  ) {
    return true;
  }
  // IPv4 private / loopback / link-local / CGNAT
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  // IPv6 ULA / link-local
  if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(host)) return true;
  return false;
}

async function handleFetchUrl(url) {
  const targetParam = url.searchParams.get('url');
  if (!targetParam) return errorResponse('缺少 url 參數', 400);

  let targetUrl;
  try {
    targetUrl = new URL(targetParam);
    if (!/^https?:$/.test(targetUrl.protocol)) {
      return errorResponse('僅允許 http / https 協定', 400);
    }
  } catch {
    return errorResponse('無效的目標網址', 400);
  }

  if (isBlockedHostname(targetUrl.hostname)) {
    return errorResponse('禁止存取內部或區域網路位址', 403);
  }

  try {
    const res = await fetch(targetUrl.href, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) {
      return errorResponse(`來源網站回應 HTTP ${res.status}`, 502);
    }
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_FETCH_URL_BYTES) {
      return errorResponse('目標網頁過大', 413);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FETCH_URL_BYTES) {
      return errorResponse('目標網頁超過 3MB 上限', 413);
    }
    const ct = res.headers.get('content-type') || 'text/html; charset=utf-8';
    return new Response(buf, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': ct,
      },
    });
  } catch (err) {
    return errorResponse(`擷取網頁失敗：${err?.message || '連線逾時'}`, 502);
  }
}

export async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const bucket = env?.READER_BUCKET;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/health' && request.method === 'GET') {
    return jsonResponse({ ok: true, service: 'pocket-reader-sync', timestamp: Date.now() });
  }

  if (path === '/api/fetch-url' && request.method === 'GET') {
    return handleFetchUrl(url);
  }

  if (!bucket) {
    return errorResponse('伺服器尚未綁定 R2 READER_BUCKET', 500);
  }

  // ── Vault Routes ────────────────────────────────────────────────────────────
  if (path === '/api/vault/init' && request.method === 'POST') {
    return handleVaultInit(request, bucket);
  }

  if (path === '/api/vault/manifest') {
    const auth = await authenticateVault(request, bucket);
    if (!auth.ok) return errorResponse(auth.error, auth.status);
    const key = `vaults/${auth.vaultKey}/manifest.json`;

    if (request.method === 'GET') {
      const obj = await bucket.get(key);
      if (!obj) {
        return jsonResponse({ version: 1, updatedAt: 0, books: {}, categories: [] });
      }
      return new Response(obj.body, {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (request.method === 'PUT') {
      const read = await readBodyLimited(request, MAX_MANIFEST_BYTES);
      if (!read.ok) return errorResponse(read.error, read.status);
      try {
        JSON.parse(new TextDecoder().decode(read.buf));
      } catch {
        return errorResponse('Manifest 必須是合法 JSON', 400);
      }
      await bucket.put(key, read.buf, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
      return jsonResponse({ ok: true, updatedAt: Date.now() });
    }
  }

  const vaultBookMatch = path.match(/^\/api\/vault\/books\/([^/]+)$/);
  if (vaultBookMatch) {
    const bookId = decodeURIComponent(vaultBookMatch[1]);
    if (!BOOK_ID_RE.test(bookId)) return errorResponse('無效的書籍識別碼', 400);
    const auth = await authenticateVault(request, bucket);
    if (!auth.ok) return errorResponse(auth.error, auth.status);
    const key = `vaults/${auth.vaultKey}/books/${bookId}.json`;

    if (request.method === 'GET') {
      const obj = await bucket.get(key);
      if (!obj) return errorResponse('雲端找不到此書', 404);
      return new Response(obj.body, {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (request.method === 'PUT') {
      const read = await readBodyLimited(request, MAX_BOOK_BYTES);
      if (!read.ok) return errorResponse(read.error, read.status);
      try {
        JSON.parse(new TextDecoder().decode(read.buf));
      } catch {
        return errorResponse('書籍內容必須是合法 JSON', 400);
      }
      await bucket.put(key, read.buf, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
      return jsonResponse({ ok: true, id: bookId });
    }
    if (request.method === 'DELETE') {
      await bucket.delete(key);
      return jsonResponse({ ok: true, deleted: bookId });
    }
  }

  const vaultBlobMatch = path.match(/^\/api\/vault\/blobs\/([^/]+)$/);
  if (vaultBlobMatch) {
    const hash = vaultBlobMatch[1];
    if (!BLOB_HASH_RE.test(hash)) return errorResponse('無效的檔案雜湊值', 400);
    const auth = await authenticateVault(request, bucket);
    if (!auth.ok) return errorResponse(auth.error, auth.status);
    const key = `vaults/${auth.vaultKey}/blobs/${hash}`;

    if (request.method === 'HEAD') {
      const head = await bucket.head(key);
      if (!head) return new Response(null, { status: 404, headers: CORS_HEADERS });
      return new Response(null, {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Length': String(head.size || 0) },
      });
    }
    if (request.method === 'GET') {
      const obj = await bucket.get(key);
      if (!obj) return errorResponse('雲端找不到此原始檔', 404);
      return new Response(obj.body, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': obj.httpMetadata?.contentType || 'application/pdf',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }
    if (request.method === 'PUT') {
      const read = await readBodyLimited(request, MAX_BLOB_BYTES);
      if (!read.ok) return errorResponse(read.error, read.status);
      await bucket.put(key, read.buf, {
        httpMetadata: { contentType: request.headers.get('content-type') || 'application/pdf' },
      });
      return jsonResponse({ ok: true, hash, size: read.buf.byteLength });
    }
  }

  // ── Share & Subscribe Routes ────────────────────────────────────────────────
  if (path === '/api/shares' && request.method === 'POST') {
    const read = await readBodyLimited(request, MAX_SHARE_BUNDLE_BYTES);
    if (!read.ok) return errorResponse(read.error, read.status);

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(read.buf));
    } catch {
      return errorResponse('分享資料必須是合法 JSON', 400);
    }
    if (!payload || !Array.isArray(payload.books) || payload.books.length === 0) {
      return errorResponse('分享書單至少需包含一本書', 400);
    }

    let shareId = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = randomFromAlphabet(SHARE_ID_ALPHABET, 8);
      const exists = await bucket.head(`shares/${candidate}/meta.json`);
      if (!exists) {
        shareId = candidate;
        break;
      }
    }
    if (!shareId) return errorResponse('產生分享代碼失敗，請重試', 500);

    const editToken = randomFromAlphabet(TOKEN_ALPHABET, 32);
    const editTokenHash = await sha256Hex(`edit:${editToken}`);
    const now = Date.now();
    const version = 1;

    const bundle = {
      shareId,
      title: String(payload.title || payload.books[0]?.title || '分享書單').slice(0, 120),
      description: String(payload.description || '').slice(0, 300),
      kind: payload.kind === 'category' ? 'category' : 'book',
      version,
      updatedAt: now,
      createdAt: now,
      books: payload.books,
    };

    const meta = {
      shareId,
      title: bundle.title,
      description: bundle.description,
      kind: bundle.kind,
      bookCount: bundle.books.length,
      version,
      createdAt: now,
      updatedAt: now,
      editTokenHash,
    };

    await bucket.put(`shares/${shareId}/bundle.json`, JSON.stringify(bundle), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    await bucket.put(`shares/${shareId}/meta.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    return jsonResponse(
      {
        ok: true,
        shareId,
        editToken,
        version,
        title: bundle.title,
        bookCount: bundle.books.length,
        updatedAt: now,
      },
      201
    );
  }

  const shareMetaMatch = path.match(/^\/api\/shares\/([^/]+)\/meta$/);
  if (shareMetaMatch && request.method === 'GET') {
    const shareId = shareMetaMatch[1];
    if (!SHARE_ID_RE.test(shareId)) return errorResponse('無效的分享代碼', 400);
    const obj = await bucket.get(`shares/${shareId}/meta.json`);
    if (!obj) return errorResponse('找不到此分享碼', 404);
    const meta = JSON.parse(await obj.text());
    return jsonResponse({
      ok: true,
      shareId: meta.shareId,
      title: meta.title,
      description: meta.description,
      kind: meta.kind,
      bookCount: meta.bookCount,
      version: meta.version,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    });
  }

  const shareBlobMatch = path.match(/^\/api\/shares\/([^/]+)\/blobs\/([^/]+)$/);
  if (shareBlobMatch) {
    const shareId = shareBlobMatch[1];
    const hash = shareBlobMatch[2];
    if (!SHARE_ID_RE.test(shareId) || !BLOB_HASH_RE.test(hash)) {
      return errorResponse('無效的分享或檔案參數', 400);
    }
    const blobKey = `shares/${shareId}/blobs/${hash}`;

    if (request.method === 'GET') {
      const obj = await bucket.get(blobKey);
      if (!obj) return errorResponse('分享中找不到此原檔 PDF', 404);
      return new Response(obj.body, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': obj.httpMetadata?.contentType || 'application/pdf',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    if (request.method === 'PUT') {
      const editToken = String(request.headers.get('X-Edit-Token') || '');
      if (!editToken) return errorResponse('缺少編輯權杖', 401);
      const metaObj = await bucket.get(`shares/${shareId}/meta.json`);
      if (!metaObj) return errorResponse('找不到此分享碼', 404);
      const meta = JSON.parse(await metaObj.text());
      const tokenHash = await sha256Hex(`edit:${editToken}`);
      if (!timingSafeEqualStr(meta.editTokenHash, tokenHash)) {
        return errorResponse('編輯權杖不正確', 403);
      }
      const read = await readBodyLimited(request, MAX_BLOB_BYTES);
      if (!read.ok) return errorResponse(read.error, read.status);
      await bucket.put(blobKey, read.buf, {
        httpMetadata: { contentType: 'application/pdf' },
      });
      return jsonResponse({ ok: true, hash, size: read.buf.byteLength });
    }
  }

  const shareMatch = path.match(/^\/api\/shares\/([^/]+)$/);
  if (shareMatch) {
    const shareId = shareMatch[1];
    if (!SHARE_ID_RE.test(shareId)) return errorResponse('無效的分享代碼', 400);

    if (request.method === 'GET') {
      const obj = await bucket.get(`shares/${shareId}/bundle.json`);
      if (!obj) return errorResponse('找不到此分享碼', 404);
      return new Response(obj.body, {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (request.method === 'PUT') {
      const editToken = String(request.headers.get('X-Edit-Token') || '');
      if (!editToken) return errorResponse('缺少編輯權杖', 401);

      const metaObj = await bucket.get(`shares/${shareId}/meta.json`);
      if (!metaObj) return errorResponse('找不到此分享碼', 404);
      const meta = JSON.parse(await metaObj.text());
      const tokenHash = await sha256Hex(`edit:${editToken}`);
      if (!timingSafeEqualStr(meta.editTokenHash, tokenHash)) {
        return errorResponse('編輯權杖不正確，無法更新此分享', 403);
      }

      const read = await readBodyLimited(request, MAX_SHARE_BUNDLE_BYTES);
      if (!read.ok) return errorResponse(read.error, read.status);
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(read.buf));
      } catch {
        return errorResponse('更新資料必須是合法 JSON', 400);
      }
      if (!payload || !Array.isArray(payload.books) || payload.books.length === 0) {
        return errorResponse('分享書單至少需包含一本書', 400);
      }

      const now = Date.now();
      const nextVersion = Number(meta.version || 1) + 1;
      const bundle = {
        shareId,
        title: String(payload.title || meta.title || '分享書單').slice(0, 120),
        description: String(payload.description ?? meta.description ?? '').slice(0, 300),
        kind: payload.kind === 'category' ? 'category' : meta.kind || 'book',
        version: nextVersion,
        createdAt: meta.createdAt || now,
        updatedAt: now,
        books: payload.books,
      };

      const nextMeta = {
        ...meta,
        title: bundle.title,
        description: bundle.description,
        kind: bundle.kind,
        bookCount: bundle.books.length,
        version: nextVersion,
        updatedAt: now,
      };

      await bucket.put(`shares/${shareId}/bundle.json`, JSON.stringify(bundle), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
      await bucket.put(`shares/${shareId}/meta.json`, JSON.stringify(nextMeta), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });

      return jsonResponse({
        ok: true,
        shareId,
        version: nextVersion,
        title: bundle.title,
        bookCount: bundle.books.length,
        updatedAt: now,
      });
    }
  }

  return errorResponse('找不到對應的 API 路徑', 404);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
