// 端對端測試（Node 22、原生 fetch、無測試框架）
// 含 Google 登入（§8）測試：用 test/fixtures/test-jwk-private.json 簽假的 ID token，伺服器端靠 .dev.vars 的 DEV_TEST_JWKS 驗證
// 用法：BASE_URL=http://localhost:8787 node test/e2e.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:8787';
const SECRET = process.env.CREATE_SECRET || 'local-dev-secret';
let pass = 0;
let fail = 0;

function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra)); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

async function api(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = raw;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) data = JSON.parse(buf.toString('utf8'));
  return { status: res.status, headers: res.headers, data, buf };
}

// 1x1 JPEG，結尾附上唯一字串讓每張位元組不同
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const makeJpeg = (tag) => Buffer.concat([JPEG, Buffer.from(tag)]);
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function uploadPhoto(code, { bytes, type = 'image/jpeg', meta = {}, thumb = true, hash }) {
  const h = hash || sha(bytes);
  const fd = new FormData();
  fd.set('photo', new File([bytes], 'x.jpg', { type }));
  if (thumb) fd.set('thumb', new File([JPEG], 't.jpg', { type: 'image/jpeg' }));
  fd.set('meta', JSON.stringify({ hash: h, ...meta }));
  const res = await fetch(`${BASE}/api/u/${code}/photo`, { method: 'POST', body: fd });
  return { status: res.status, data: await res.json(), hash: h };
}

async function createEvent(name, date) {
  const r = await api('POST', '/api/create', { headers: { 'x-create-secret': SECRET }, body: { name, date } });
  if (r.status !== 201) throw new Error('建立活動失敗 ' + JSON.stringify(r.data));
  return r.data;
}

// ---- 分享預覽測試用工具 ----
const DEFAULT_PNG = readFileSync(new URL('../public/assets/og-default.png', import.meta.url));
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TINY_JPG = makeJpeg('og-card');
const pngSize = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];
const BOT = { 'user-agent': 'facebookexternalhit/1.1' };
// 取 <meta property|name="key" content="..."> 的 content（還原 HTML 跳脫）
function metaOf(html, key) {
  const m = new RegExp(`<meta\\s+(?:property|name)="${key}"\\s+content="([^"]*)"`).exec(html);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
}
const titleOf = (html) => (/<title>([^<]*)<\/title>/.exec(html) || [])[1] ?? null;
const tpeMD = (isoStr) => { const d = new Date(Date.parse(isoStr) + 8 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
async function getPage(path) {
  const res = await fetch(BASE + path, { headers: BOT });
  return { status: res.status, html: await res.text() };
}
// 讀 wrangler 本機 R2 的 sqlite，列出 key（讀不到回 null，測試改為略過並提示）
async function localR2Keys() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const base = new URL('../.wrangler/state/v3/r2/', import.meta.url);
    const keys = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const full = new URL(f.name + (f.isDirectory() ? '/' : ''), dir);
        if (f.isDirectory()) walk(full);
        else if (f.name.endsWith('.sqlite')) {
          const db = new DatabaseSync(full.pathname, { readOnly: true });
          try { for (const r of db.prepare('SELECT key FROM _mf_objects').all()) keys.push(r.key); } catch { /* 不是物件表 */ }
          db.close();
        }
      }
    };
    if (!existsSync(base)) return null;
    walk(base);
    return keys;
  } catch { return null; }
}

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString();


// ================= Google 登入測試用工具 =================
import { createPrivateKey, createHmac, randomBytes, sign as rsaSign, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';

const PRIV_JWK = JSON.parse(readFileSync(new URL('./fixtures/test-jwk-private.json', import.meta.url), 'utf8'));
const PRIV_KEY = createPrivateKey({ key: PRIV_JWK, format: 'jwk' });
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client.apps.googleusercontent.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'local-dev-session-secret-0123456789abcdef';
const ORIGIN = new URL(BASE).origin;
const RUN = randomBytes(3).toString('hex'); // 每次執行不同，重跑不會撞到舊帳號
const b64u = (b) => Buffer.from(b).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);

// 用測試私鑰簽 ID token（RS256）；overrides 可改聲明，opts 可改 header／金鑰
function mintIdToken(user, overrides = {}, opts = {}) {
  const claims = {
    iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID,
    sub: user.sub, email: user.email, email_verified: true, name: user.name, picture: user.picture || 'https://lh3.googleusercontent.com/a/test',
    iat: nowS(), exp: nowS() + 3600, ...overrides,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  const header = { alg: opts.alg || 'RS256', typ: 'JWT', kid: opts.kid === undefined ? PRIV_JWK.kid : opts.kid };
  if (opts.kid === null) delete header.kid;
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  if (opts.alg === 'none') return data + '.';
  const sig = rsaSign('RSA-SHA256', Buffer.from(data), opts.key || PRIV_KEY);
  return `${data}.${b64u(sig)}`;
}

// 測試用帳號
const mkUser = (tag, domain = 'example.org') => ({
  sub: `t-${RUN}-${tag}`, email: `${tag}-${RUN}@${domain}`, name: `User ${tag}`, picture: `https://lh3.googleusercontent.com/a/${tag}`,
});

// 簡易 cookie jar（模擬一個瀏覽器）；預設每次請求帶同源 Origin
class Jar {
  constructor() { this.c = new Map(); this.setCookies = []; }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, { body, headers = {}, origin = ORIGIN, token, raw } = {}) {
    const h = { ...headers };
    if (origin) h.origin = origin;
    const ck = this.header();
    if (ck) h.cookie = ck;
    if (token) h.authorization = `Bearer ${token}`;
    let payload = raw;
    if (body !== undefined) { h['content-type'] = h['content-type'] || 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers: h, body: payload });
    const buf = Buffer.from(await res.arrayBuffer());
    let data = null;
    if ((res.headers.get('content-type') || '').includes('json')) data = JSON.parse(buf.toString('utf8'));
    this.setCookies = res.headers.getSetCookie();
    for (const sc of this.setCookies) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      const name = kv.slice(0, i).trim();
      const val = kv.slice(i + 1).trim();
      if (/;\s*Max-Age=0/i.test(sc) || val === '') this.c.delete(name);
      else this.c.set(name, val);
    }
    return { status: res.status, headers: res.headers, data, buf, text: buf.toString('utf8') };
  }
  get(path, o) { return this.req('GET', path, o); }
  post(path, body, o = {}) { return this.req('POST', path, { body, ...o }); }
  patch(path, body, o = {}) { return this.req('PATCH', path, { body, ...o }); }
  del(path, o) { return this.req('DELETE', path, o); }
}

async function loginAs(jar, user, overrides, opts) {
  return jar.post('/api/auth/google', { credential: mintIdToken(user, overrides, opts) });
}
// 自行簽發 session cookie（驗證格式相容、過期判斷）
function forgeSession(payload, secret = SESSION_SECRET) {
  const p = b64u(JSON.stringify(payload));
  return `${p}.${createHmac('sha256', secret).update(p).digest('base64url')}`;
}

// 直接讀 wrangler 本機 R2 的物件內容（用來確認 shares 索引）；讀不到回 undefined
async function localR2Text(key) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const root = new URL('../.wrangler/state/v3/r2/', import.meta.url);
    const dir = new URL('miniflare-R2BucketObject/', root);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue;
      const db = new DatabaseSync(new URL(f, dir).pathname, { readOnly: true });
      let row;
      try { row = db.prepare('SELECT blob_id FROM _mf_objects WHERE key = ?').get(key); } catch { /* 不是物件表 */ }
      db.close();
      if (row) return readFileSync(new URL(`mv-photo-collect/blobs/${row.blob_id}`, root), 'utf8');
    }
    return null; // 找不到這個 key
  } catch { return undefined; }
}
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// 以 node:http 送出可自訂 Host 的請求（fetch 不能改 Host）
function rawRequest(method, path, { host, headers = {}, body } = {}) {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path, method, headers: { host, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, data, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 記憶體版 R2（單元測試用）：支援 get/put(onlyIf)/delete/list，put 前後有 await 讓並行交錯
class MemR2 {
  constructor() { this.m = new Map(); this.n = 0; this.failPut = false; }
  async get(key) {
    await null;
    const o = this.m.get(key);
    if (!o) return null;
    return { key, etag: o.etag, size: o.body.length, text: async () => o.body, json: async () => JSON.parse(o.body) };
  }
  async put(key, value, opts = {}) {
    if (this.failPut) throw new Error('R2 put failed (測試注入)');
    await null;
    const cur = this.m.get(key);
    const c = opts.onlyIf || {};
    if (c.etagMatches && (!cur || cur.etag !== c.etagMatches)) return null;
    if (c.etagDoesNotMatch === '*' && cur) return null;
    const etag = 'e' + ++this.n;
    this.m.set(key, { body: typeof value === 'string' ? value : String(value), etag });
    return { etag };
  }
  async delete(key) { for (const k of [].concat(key)) this.m.delete(k); }
  async list() { return { objects: [], truncated: false }; }
  json(key) { const o = this.m.get(key); return o ? JSON.parse(o.body) : null; }
}

// ================= 單元測試（直接呼叫 src 模組，不經 wrangler） =================
async function unitTests() {
  const { verifyIdToken, resetJwksCache, devJwksAllowed, ttlFromCacheControl, GOOGLE_CERTS_URL } = await import('../src/auth-google.js');
  const sess = await import('../src/session.js');
  const { updateJson, NO_CHANGE } = await import('../src/store.js');
  const acct = await import('../src/account.js');
  const { handleApi } = await import('../src/router.js');
  const { CSP, LOGIN_CSP } = await import('../src/util.js');

  const pubOf = (jwk, kid) => ({ kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e });
  const devJwks = JSON.stringify({ keys: [pubOf(PRIV_JWK, PRIV_JWK.kid)] });
  const baseEnv = { GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET, DEV_TEST_JWKS: devJwks, DEV_MODE: '1' };
  const u = mkUser('unit');

  console.log('[單元：GOOGLE_CLIENT_ID 空值 = 功能關閉]');
  for (const [label, v] of [['空字串', ''], ['只有空白', '   '], ['未設定', undefined]]) {
    const env = { GOOGLE_CLIENT_ID: v, SESSION_SECRET };
    const res = await handleApi(new Request('http://localhost/api/auth/config'), env, new URL('http://localhost/api/auth/config'));
    eq([res.status, await res.json()], [200, { google_client_id: null }], `GOOGLE_CLIENT_ID ${label} → /api/auth/config 回 null`);
  }
  {
    const env = { GOOGLE_CLIENT_ID: '', SESSION_SECRET, DEV_TEST_JWKS: devJwks, DEV_MODE: '1' };
    const url = new URL('http://localhost/api/auth/google');
    let st = 0;
    try {
      await handleApi(new Request(url, { method: 'POST', body: JSON.stringify({ credential: mintIdToken(u) }), headers: { 'content-type': 'application/json' } }), env, url);
    } catch (e) { st = e.status; }
    eq(st, 404, '功能關閉時 POST /api/auth/google 404');
    const good = await sess.makeSessionValue({ ...baseEnv }, u);
    const meRes = await handleApi(new Request('http://localhost/api/me', { headers: { cookie: `mvs=${good}` } }), env, new URL('http://localhost/api/me'));
    eq(await meRes.json(), { user: null }, '功能關閉時即使 cookie 簽章有效也視同未登入');
  }
  {
    const env = { GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET: 'short' };
    const res = await handleApi(new Request('http://localhost/api/auth/config'), env, new URL('http://localhost/api/auth/config'));
    eq((await res.json()).google_client_id, null, 'SESSION_SECRET 不足 32 字元 → 視同關閉（config 回 null）');
  }

  console.log('[單元：DEV_TEST_JWKS 只在 localhost / 127.0.0.1 採用]');
  eq([devJwksAllowed(baseEnv, 'localhost'), devJwksAllowed(baseEnv, '127.0.0.1')], [true, true], 'localhost 與 127.0.0.1 允許');
  eq([devJwksAllowed(baseEnv, 'example.com'), devJwksAllowed(baseEnv, 'x.workers.dev'), devJwksAllowed(baseEnv, 'localhost.evil.com'), devJwksAllowed(baseEnv, '0.0.0.0'), devJwksAllowed(baseEnv, '')],
    [false, false, false, false, false], '其他主機名稱一律不允許');
  eq(devJwksAllowed({ GOOGLE_CLIENT_ID: CLIENT_ID }, 'localhost'), false, '沒設 DEV_TEST_JWKS 時不允許');
  eq(devJwksAllowed({ GOOGLE_CLIENT_ID: CLIENT_ID, DEV_TEST_JWKS: devJwks }, 'localhost'), false, '沒設 DEV_MODE=1 時不允許');
  {
    resetJwksCache();
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return new Response(JSON.stringify({ keys: [{ ...pubOf(PRIV_JWK, 'some-other-google-kid') }] }), { status: 200 }); };
    const tok = mintIdToken(u);
    let err;
    try { await verifyIdToken(baseEnv, tok, { hostname: 'example.com', fetchFn }); } catch (e) { err = e; }
    ok(err && err.status === 401 && err.code === 'invalid_token', '非 localhost：測試金鑰簽的 token 被拒（401 invalid_token）', err && err.code);
    ok(calls.length >= 1 && calls[0] === GOOGLE_CERTS_URL, '非 localhost：改向 Google 取金鑰', calls);
    resetJwksCache();
    calls.length = 0;
    const r1 = await verifyIdToken(baseEnv, tok, { hostname: 'localhost', fetchFn });
    const r2 = await verifyIdToken(baseEnv, tok, { hostname: '127.0.0.1', fetchFn });
    ok(r1.sub === u.sub && r2.email === u.email.toLowerCase() && calls.length === 0, 'localhost / 127.0.0.1：採用測試金鑰且不需連 Google');
  }

  console.log('[單元：Google JWKS 快取]');
  {
    const gk = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const gPriv = gk.privateKey;
    const gJwk = gk.publicKey.export({ format: 'jwk' });
    const tok = mintIdToken(u, { exp: nowS() + 7 * 86400 }, { kid: 'g-key-1', key: gPriv });
    const env = { GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET };
    let n = 0;
    let cc = 'public, max-age=100, must-revalidate';
    const fetchFn = async () => { n++; return new Response(JSON.stringify({ keys: [pubOf(gJwk, 'g-key-1')] }), { status: 200, headers: cc ? { 'cache-control': cc } : {} }); };
    resetJwksCache();
    const t0 = Date.now();
    const r = await verifyIdToken(env, tok, { hostname: 'x.workers.dev', fetchFn, now: t0 });
    ok(r.sub === u.sub && n === 1, 'Google 金鑰驗證通過、抓取 1 次');
    await verifyIdToken(env, tok, { hostname: 'x.workers.dev', fetchFn, now: t0 + 99_000 });
    eq(n, 1, 'max-age 內不重抓');
    await verifyIdToken(env, tok, { hostname: 'x.workers.dev', fetchFn, now: t0 + 101_000 });
    eq(n, 2, '超過 max-age 重抓');
    cc = '';
    resetJwksCache();
    n = 0;
    await verifyIdToken(env, tok, { hostname: 'x.workers.dev', fetchFn, now: t0 });
    await verifyIdToken(env, tok, { hostname: 'x.workers.dev', fetchFn, now: t0 + 3_599_000 });
    eq(n, 1, '沒有 Cache-Control：預設 1 小時內不重抓');
    await verifyIdToken(env, tok, { hostname: 'x.workers.dev', fetchFn, now: t0 + 3_601_000 });
    eq(n, 2, '沒有 Cache-Control：超過 1 小時重抓');
    eq([ttlFromCacheControl('public, max-age=19000'), ttlFromCacheControl(''), ttlFromCacheControl('no-cache')], [19000, 3600, 3600], 'ttlFromCacheControl');
    // 抓取失敗：有舊快取就沿用；沒有快取則 503
    const failing = async () => { throw new Error('network down'); };
    const r3 = await verifyIdToken(env, tok, { hostname: 'x.workers.dev', fetchFn: failing, now: t0 + 9_000_000 });
    ok(r3.sub === u.sub, '重抓失敗時沿用舊快取');
    resetJwksCache();
    let e2;
    try { await verifyIdToken(env, tok, { hostname: 'x.workers.dev', fetchFn: failing, now: t0 }); } catch (e) { e2 = e; }
    ok(e2 && e2.status === 503, '無快取且抓取失敗 → 503 auth_unavailable', e2 && e2.status);
    resetJwksCache();
  }

  console.log('[單元：session cookie]');
  {
    const v = await sess.makeSessionValue(baseEnv, u);
    const reqOf = (val) => new Request('http://localhost/api/me', { headers: { cookie: `a=1; mvs=${val}; b=2` } });
    const s = await sess.getSession(baseEnv, reqOf(v));
    ok(s && s.sub === u.sub && s.exp > nowS() + 29 * 86400, 'makeSessionValue → getSession 往返，exp 約 30 天');
    eq(await sess.getSession(baseEnv, reqOf(v + 'x')), null, '簽章被改 → null');
    eq(await sess.getSession(baseEnv, reqOf(v), Date.now() + 31 * 86400_000), null, '超過 30 天 → null');
    eq(await sess.getSession({ ...baseEnv, SESSION_SECRET: SESSION_SECRET + 'z' }, reqOf(v)), null, 'SESSION_SECRET 不同 → null');
  }

  console.log('[單元：CREATOR_EMAILS 比對]');
  {
    const env = { CREATOR_EMAILS: ' A@B.com , @corp.example.com;\n@x.org ' };
    const m = (e) => acct.creatorEmailMatch(env, e);
    eq([m('a@b.com'), m('A@B.COM'), m('z@corp.example.com'), m('q@x.org')], [true, true, true, true], '完整 Email（不分大小寫）與 @網域');
    eq([m('z@sub.corp.example.com'), m('z@evilcorp.example.com'), m('b.com'), m(''), m('xa@b.com')], [false, false, false, false, false], '子網域、相似網域、殘缺字串不符');
    eq(acct.creatorEmailMatch({ CREATOR_EMAILS: '' }, 'a@b.com'), false, '空名單不符');
  }

  console.log('[單元：updateJson 樂觀鎖]');
  {
    const env = { PHOTOS: new MemR2() };
    await Promise.all(Array.from({ length: 12 }, () => updateJson(env, 'users/x.json', () => ({ n: 0 }), (d) => { d.n++; })));
    eq(env.PHOTOS.json('users/x.json').n, 12, '12 個並行讀改寫全部生效（衝突時重試）');
    const before = env.PHOTOS.m.get('users/x.json').etag;
    await updateJson(env, 'users/x.json', () => ({ n: 0 }), () => NO_CHANGE);
    eq(env.PHOTOS.m.get('users/x.json').etag, before, 'NO_CHANGE 不寫入');
  }

  console.log('[單元：/api/me 清掉過期索引、上傳記錄寫入失敗不影響]');
  {
    const R2 = new MemR2();
    const env = { ...baseEnv, PHOTOS: R2 };
    const me = mkUser('ghost');
    const cookie = `mvs=${await sess.makeSessionValue(env, me)}`;
    await R2.put(`users/${me.sub}.json`, JSON.stringify({
      sub: me.sub, email: me.email, events: [{ event_id: 'ev_aaaaaaaaaaaa', added_at: 'x' }],
      uploads: [{ event_id: 'ev_bbbbbbbbbbbb', upload_code: 'c'.repeat(22), name: '舊活動', count: 3, last_at: '2026-01-01T00:00:00Z' }],
    }));
    await R2.put(await acct.sharesKey(me.email), JSON.stringify({ events: [{ event_id: 'ev_cccccccccccc', role: 'viewer' }] }));
    const url = new URL('http://localhost/api/me');
    const res = await handleApi(new Request(url, { headers: { cookie } }), env, url);
    const d = await res.json();
    eq([d.events, d.shared], [[], []], '活動已不存在 → events / shared 略過');
    eq(d.uploads, [{ event_id: 'ev_bbbbbbbbbbbb', name: '舊活動', upload_url: `/u/${'c'.repeat(22)}`, count: 3, last_at: '2026-01-01T00:00:00Z', valid: false }], '活動不存在的上傳記錄保留但 valid=false');
    eq(R2.json(`users/${me.sub}.json`).events, [], '順手清掉 users.events 的過期索引');
    eq(R2.json(await acct.sharesKey(me.email)).events, [], '順手清掉 shares 的過期索引');
    R2.failPut = true;
    let threw = false;
    const orig = console.error;
    console.error = () => {};
    try {
      await acct.recordUploadSafe(env, new Request('http://localhost/api/u/x/photo', { method: 'POST', headers: { cookie, origin: 'http://localhost' } }), { id: 'ev_dddddddddddd', basic: { name: 'n' } }, 'c'.repeat(22));
    } catch { threw = true; }
    console.error = orig;
    ok(!threw, 'recordUploadSafe：R2 寫入失敗只記 log、不丟例外');
  }

  console.log('[單元：CSP]');
  ok(LOGIN_CSP.includes("script-src 'self' https://accounts.google.com/gsi/client") && LOGIN_CSP.includes('frame-src https://accounts.google.com/gsi/')
    && LOGIN_CSP.includes("connect-src 'self' https://accounts.google.com/gsi/") && LOGIN_CSP.includes('https://accounts.google.com/gsi/style'), 'LOGIN_CSP 含 §8.8 的四項');
  ok(!CSP.includes('google.com'), '基本 CSP 不含 Google');
}

// ================= Google 登入整合測試 =================
async function authTests() {
  const { CSP } = await import('../src/util.js');
  const A = mkUser('alice');
  const B = { ...mkUser('bob'), email: 'creator@example.com' }; // 在 CREATOR_EMAILS 名單
  const C = mkUser('carol', 'corp.example.com'); // @corp.example.com 網域
  const D = mkUser('dave');
  const jA = new Jar(); const jB = new Jar(); const jC = new Jar(); const jD = new Jar();
  const anon = new Jar();
  let r;

  console.log('[登入：設定與驗證失敗]');
  r = await anon.get('/api/auth/config');
  eq([r.status, r.data], [200, { google_client_id: CLIENT_ID }], 'GET /api/auth/config');
  r = await anon.get('/api/me');
  eq([r.status, r.data], [200, { user: null }], '未登入 /api/me → user:null');
  const bads = [
    ['錯誤 aud', mintIdToken(A, { aud: 'other-client.apps.googleusercontent.com' }), 'invalid_token'],
    ['已過期（exp 在 2 分鐘前）', mintIdToken(A, { exp: nowS() - 120 }), 'invalid_token'],
    ['iss 不是 Google', mintIdToken(A, { iss: 'https://evil.example.com' }), 'invalid_token'],
    ['email_verified=false', mintIdToken(A, { email_verified: false }), 'email_unverified'],
    ['缺 email_verified', mintIdToken(A, { email_verified: undefined }), 'email_unverified'],
    ['缺 sub', mintIdToken(A, { sub: undefined }), 'invalid_token'],
    ['alg=none', mintIdToken(A, {}, { alg: 'none' }), 'invalid_token'],
    ['alg=HS256', mintIdToken(A, {}, { alg: 'HS256' }), 'invalid_token'],
    ['缺 kid', mintIdToken(A, {}, { kid: null }), 'invalid_token'],
    ['非 JWT 字串', 'not.a.jwt', 'invalid_token'],
    ['非 JWT 字串（無點）', 'abc', 'invalid_token'],
  ];
  {
    const good = mintIdToken(A);
    const [h, p, s] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), email: 'admin@evil.example', sub: 'victim' })).toString('base64url');
    bads.push(['payload 被竄改（簽章沒重簽）', `${h}.${forged}.${s}`, 'invalid_token']);
    const sb = Buffer.from(s, 'base64url');
    sb[sb.length - 1] ^= 0x01;
    bads.push(['簽章被竄改', `${h}.${p}.${sb.toString('base64url')}`, 'invalid_token']);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    bads.push(['用別把私鑰簽（kid 相同）', mintIdToken(A, {}, { key: other }), 'invalid_token']);
  }
  for (const [label, cred, code] of bads) {
    const j = new Jar();
    r = await j.post('/api/auth/google', { credential: cred });
    ok(r.status === 401 && r.data.error === code && !r.headers.get('set-cookie'), `登入失敗：${label} → 401 ${code} 且無 Set-Cookie`, { s: r.status, d: r.data });
  }
  {
    const j = new Jar();
    r = await j.post('/api/auth/google', { credential: mintIdToken(A, {}, { kid: 'unknown-kid' }) });
    ok([401, 503].includes(r.status) && !r.headers.get('set-cookie'), '登入失敗：未知 kid → 401/503（改向 Google 取金鑰）且無 Set-Cookie', r.status);
    r = await j.post('/api/auth/google', {});
    ok(r.status === 401 && r.data.error === 'invalid_token', '缺 credential → 401');
    r = await j.req('POST', '/api/auth/google', { raw: '{oops', headers: { 'content-type': 'application/json' } });
    ok(r.status === 400, '壞 JSON → 400');
    r = await j.req('POST', '/api/auth/google', { body: { credential: mintIdToken(A) }, origin: 'https://evil.example' });
    ok(r.status === 403 && r.data.error === 'bad_origin' && !r.headers.get('set-cookie'), '/api/auth/google 帶不同源 Origin → 403');
    r = await j.req('GET', '/api/auth/google');
    ok(r.status === 405, 'GET /api/auth/google 405');
  }

  console.log('[登入：成功、cookie、/api/me、登出]');
  {
    const z = mkUser('skew');
    const j = new Jar();
    r = await loginAs(j, z, { exp: nowS() - 30 });
    ok(r.status === 200 && r.data.user.email === z.email.toLowerCase(), 'exp 過期 30 秒仍在 60 秒容許時差內 → 登入成功');
  }
  r = await loginAs(jA, A);
  ok(r.status === 200 && r.data.user.sub === A.sub && r.data.user.email === A.email && r.data.user.name === A.name && r.data.user.picture === A.picture && r.data.user.can_create === false, '登入成功回 user', r.data);
  const sc = r.headers.get('set-cookie') || '';
  ok(/^mvs=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/.test(sc), 'Set-Cookie 名稱 mvs，值為 payload.hmac');
  ok(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Path=\//.test(sc) && /Max-Age=2592000/.test(sc) && !/Secure/i.test(sc), 'cookie 屬性：HttpOnly、SameSite=Lax、Path=/、Max-Age=2592000、本機 http 無 Secure', sc);
  {
    const val = sc.split(';')[0].slice(4);
    const pay = JSON.parse(Buffer.from(val.split('.')[0], 'base64url'));
    ok(pay.sub === A.sub && pay.email === A.email && pay.name === A.name && Math.abs(pay.exp - (nowS() + 2592000)) < 30, 'cookie payload 含 sub/email/name/picture/exp(秒，約 30 天後)', pay);
  }
  r = await jA.get('/api/me');
  eq([r.status, r.data], [200, { user: { sub: A.sub, email: A.email, name: A.name, picture: A.picture, can_create: false }, events: [], shared: [], uploads: [] }], '登入後 /api/me');
  ok(r.headers.get('cache-control') === 'no-store', '/api/me no-store');
  {
    const val = jA.c.get('mvs');
    const t = new Jar();
    t.c.set('mvs', val.slice(0, 5) + (val[5] === 'A' ? 'B' : 'A') + val.slice(6));
    r = await t.get('/api/me');
    eq(r.data, { user: null }, 'cookie payload 被改 → 視同未登入');
    t.c.set('mvs', val.slice(0, -2) + (val.endsWith('AA') ? 'BB' : 'AA'));
    r = await t.get('/api/me');
    eq(r.data, { user: null }, 'cookie 簽章被改 → 視同未登入');
    t.c.set('mvs', forgeSession({ sub: A.sub, email: A.email, name: 'x', picture: '', exp: nowS() - 5 }));
    r = await t.get('/api/me');
    eq(r.data, { user: null }, '簽章正確但 exp 已過期 → 視同未登入');
    t.c.set('mvs', forgeSession({ sub: A.sub, email: A.email, name: 'x', picture: '', exp: nowS() + 600 }, 'a-different-secret-0123456789abcdefgh'));
    r = await t.get('/api/me');
    eq(r.data, { user: null }, '用別的密鑰簽的 cookie → 視同未登入');
    t.c.set('mvs', forgeSession({ sub: A.sub, email: A.email, name: 'x', picture: '', exp: nowS() + 600 }));
    r = await t.get('/api/me');
    ok(r.data.user && r.data.user.sub === A.sub, '自簽的有效 cookie（格式相容）→ 已登入');
  }
  // 登出
  {
    const t = new Jar();
    await loginAs(t, A);
    r = await t.post('/api/auth/logout', {}, { origin: null });
    ok(r.status === 403 && r.data.error === 'bad_origin', '有 cookie 的登出缺 Origin → 403');
    r = await t.post('/api/auth/logout', {}, { origin: 'https://evil.example' });
    ok(r.status === 403, '有 cookie 的登出 Origin 不同 → 403');
    r = await t.post('/api/auth/logout', {});
    const out = r.headers.get('set-cookie') || '';
    ok(r.status === 200 && r.data.ok === true && /^mvs=;/.test(out) && /Max-Age=0/.test(out), '登出 → 200 並清除 cookie');
    r = await t.get('/api/me');
    eq(r.data, { user: null }, '登出後 /api/me → user:null');
    r = await anon.post('/api/auth/logout', {}, { origin: null });
    ok(r.status === 200, '沒登入時登出也是 200（冪等）');
    r = await anon.get('/api/auth/logout');
    ok(r.status === 405, 'GET /api/auth/logout 405');
  }
  // 同一個人重新登入：沿用 can_create 等狀態、更新姓名
  r = await loginAs(new Jar(), { ...A, name: 'Alice Renamed' });
  ok(r.status === 200 && r.data.user.name === 'Alice Renamed', '重新登入更新姓名');
  r = await loginAs(jA, A);

  console.log('[已登入建立活動]');
  r = await jA.post('/api/create', { name: '無資格' });
  ok(r.status === 401 && r.data.error === 'bad_create_secret', '沒 can_create 也不在 CREATOR_EMAILS、無密碼 → 401');
  r = await jA.post('/api/create', { name: '無資格' }, { headers: { 'x-create-secret': 'wrong' } });
  ok(r.status === 401 && r.data.error === 'bad_create_secret', '錯誤密碼 → 401');
  r = await jA.post('/api/create', { name: 'A 的活動', date: '2026-11-08' }, { headers: { 'x-create-secret': SECRET }, origin: null });
  ok(r.status === 403 && r.data.error === 'bad_origin', '登入狀態建立活動缺 Origin → 403');
  r = await jA.post('/api/create', { name: 'A 的活動', date: '2026-11-08' }, { headers: { 'x-create-secret': SECRET }, origin: 'https://evil.example' });
  ok(r.status === 403 && r.data.error === 'bad_origin', '登入狀態建立活動 Origin 不同 → 403');
  r = await jA.post('/api/create', { name: 'A 的活動', date: '2026-11-08' }, { headers: { 'x-create-secret': SECRET } });
  ok(r.status === 201 && r.data.admin_code && r.data.upload_code, '登入 + 正確建立密碼 → 201（仍回 admin_code）');
  const evA = r.data;
  r = await jA.get('/api/me');
  ok(r.data.user.can_create === true, '帶正確密碼後 can_create = true');
  eq(r.data.events, [{ event_id: evA.event_id, name: 'A 的活動', date: '2026-11-08', end_date: null, stage: 'planning', role: 'owner' }], 'me.events 出現新活動，role=owner');
  r = await jA.post('/api/create', { name: 'A 的第二場' });
  ok(r.status === 201, '之後免密碼可建立');
  const evA2 = r.data;
  r = await jA.get('/api/me');
  eq(r.data.events.map((e) => e.event_id), [evA2.event_id, evA.event_id], 'me.events 新到舊');
  r = await jA.post('/api/create', { name: '' });
  ok(r.status === 400, '已登入可建立者：空名稱仍 400');
  r = await jA.get(`/api/admin/${evA.event_id}`);
  ok(r.status === 200 && r.data.role === 'owner' && r.data.auth === 'account' && r.data.config.owner.sub === A.sub && r.data.config.owner.email === A.email && Array.isArray(r.data.config.members) && !('admin_hash' in r.data.config), '建立者以 cookie 管理：role=owner、auth=account、config.owner 正確');
  // CREATOR_EMAILS
  r = await loginAs(jB, B);
  eq(r.data.user.can_create, true, 'CREATOR_EMAILS 完整 Email → can_create 有效值為 true');
  r = await jB.post('/api/create', { name: 'B 的活動' });
  ok(r.status === 201, 'CREATOR_EMAILS 內的 Email 免密碼建立');
  const evB = r.data;
  r = await jB.get(`/api/admin/${evB.event_id}`);
  eq([r.data.role, r.data.config.owner.email], ['owner', 'creator@example.com'], 'B 是自己活動的 owner');
  await loginAs(jC, C);
  r = await jC.post('/api/create', { name: 'C 的活動' });
  ok(r.status === 201, 'CREATOR_EMAILS 的 @網域 免密碼建立');
  const evC = r.data;
  for (const em of ['x@evilcorp.example.com', 'x@sub.corp.example.com', 'x@corp.example.com.evil.org']) {
    const j = new Jar();
    await loginAs(j, { sub: `t-${RUN}-n-${em}`, email: em, name: 'n' });
    r = await j.post('/api/create', { name: 'X' });
    ok(r.status === 401, `非名單網域 ${em} → 401`);
  }
  await loginAs(jD, D);
  r = await jD.post('/api/create', { name: 'D' });
  ok(r.status === 401, 'D（一般使用者）無法免密碼建立');
  // 未登入行為不變
  r = await anon.post('/api/create', { name: 'legacy' }, { headers: { 'x-create-secret': SECRET }, origin: null });
  ok(r.status === 201, '未登入 + 建立密碼（不帶 Origin）行為不變');
  const evL = r.data;
  r = await anon.post('/api/create', { name: 'legacy' }, { origin: null });
  ok(r.status === 401, '未登入、沒密碼 → 401');
  r = await anon.get(`/api/admin/${evL.event_id}`, { token: evL.admin_code });
  ok(r.status === 200 && r.data.role === 'owner' && r.data.auth === 'key' && r.data.config.owner === null && Array.isArray(r.data.config.members), '舊管理碼：role=owner、auth=key、config.owner=null');
  r = await anon.get(`/api/admin/${evL.event_id}`);
  ok(r.status === 401 && r.data.error === 'unauthorized', '無 Bearer 無 cookie → 401');
  r = await anon.get(`/api/admin/ev_aaaaaaaaaaaa`);
  ok(r.status === 401, '無任何憑證、活動不存在 → 401（維持原順序）');
  r = await jA.get(`/api/admin/ev_aaaaaaaaaaaa`);
  ok(r.status === 404, '登入、活動不存在 → 404');
  r = await jA.get(`/api/admin/bad-id`);
  ok(r.status === 400, '壞 id → 400（先於授權）');

  console.log('[認領 claim]');
  r = await anon.post(`/api/admin/${evL.event_id}/claim`, {}, { token: evL.admin_code, origin: null });
  ok(r.status === 401, 'claim 只有管理碼沒登入 → 401');
  r = await jA.post(`/api/admin/${evL.event_id}/claim`, {});
  ok(r.status === 401, 'claim 只有登入沒管理碼 → 401');
  r = await jA.post(`/api/admin/${evL.event_id}/claim`, {}, { token: 'x'.repeat(32) });
  ok(r.status === 401, 'claim 管理碼錯誤 → 401');
  r = await jA.post(`/api/admin/${evL.event_id}/claim`, {}, { token: evL.admin_code, origin: null });
  ok(r.status === 403 && r.data.error === 'bad_origin', 'claim 缺 Origin → 403');
  r = await jA.post(`/api/admin/ev_aaaaaaaaaaaa/claim`, {}, { token: evL.admin_code });
  ok(r.status === 404, 'claim 活動不存在 → 404');
  r = await jA.post(`/api/admin/${evL.event_id}/claim`, {}, { token: evL.admin_code });
  ok(r.status === 200 && r.data.ok === true && r.data.owner.email === A.email, 'claim 成功');
  r = await jA.get('/api/me');
  ok(r.data.events.some((e) => e.event_id === evL.event_id && e.role === 'owner'), '認領後出現在 me.events');
  r = await anon.get(`/api/admin/${evL.event_id}`, { token: evL.admin_code });
  eq(r.data.config.owner, { sub: A.sub, email: A.email }, '認領後 config.owner 正確');
  r = await jB.post(`/api/admin/${evL.event_id}/claim`, {}, { token: evL.admin_code });
  ok(r.status === 409 && r.data.error === 'has_owner', '別人再認領 → 409 has_owner');
  r = await jB.post(`/api/admin/${evA.event_id}/claim`, {}, { token: evA.admin_code });
  ok(r.status === 409 && r.data.error === 'has_owner', '登入建立的活動被別人拿管理碼認領 → 409');
  r = await jA.post(`/api/admin/${evL.event_id}/claim`, {}, { token: evL.admin_code });
  ok(r.status === 200, '自己重複認領 → 200（冪等）');
  r = await jA.get('/api/me');
  eq(r.data.events.filter((e) => e.event_id === evL.event_id).length, 1, '重複認領不會出現兩筆');

  console.log('[成員管理：owner]');
  const E = evA.event_id;
  const mem = (jar, m, path, body, o) => jar.req(m, `/api/admin/${E}${path}`, { body, ...o });
  r = await mem(jA, 'POST', '/members', { email: 'not-an-email', role: 'viewer' });
  ok(r.status === 400, '壞 Email → 400');
  r = await mem(jA, 'POST', '/members', { email: 'x@example.org', role: 'owner' });
  ok(r.status === 400, 'role=owner → 400');
  r = await mem(jA, 'POST', '/members', { email: 'x@example.org' });
  ok(r.status === 400, '缺 role → 400');
  r = await mem(jA, 'POST', '/members', { email: A.email.toUpperCase(), role: 'viewer' });
  ok(r.status === 400, '不可加 owner 自己（不分大小寫）→ 400');
  r = await mem(jA, 'POST', '/members', { email: B.email, role: 'viewer' });
  ok(r.status === 200 && r.data.owner.email === A.email && r.data.members.length === 1 && r.data.members[0].role === 'viewer' && r.data.members[0].added_by === A.email, '新增 bob 為 viewer');
  r = await mem(jA, 'POST', '/members', { email: B.email.toUpperCase(), role: 'manager' });
  ok(r.status === 200 && r.data.members.length === 1 && r.data.members[0].role === 'manager' && r.data.members[0].email === B.email, '同一 Email（大小寫不同）改角色為 manager，不會重複');
  r = await mem(jA, 'POST', '/members', { email: C.email, role: 'viewer' });
  ok(r.status === 200 && r.data.members.length === 2, '新增 carol 為 viewer');
  r = await mem(jA, 'GET', '/members');
  ok(r.status === 200 && r.data.owner.email === A.email && r.data.members.map((m) => m.email).join() === `${B.email},${C.email}`, 'GET members');
  r = await mem(jA, 'POST', '/members', { email: 'k@example.org', role: 'viewer' }, { origin: null });
  ok(r.status === 403 && r.data.error === 'bad_origin', 'cookie 的 POST members 缺 Origin → 403');
  // 對方看得到
  r = await jB.get('/api/me');
  eq(r.data.shared, [{ event_id: E, name: 'A 的活動', date: '2026-11-08', end_date: null, stage: 'planning', role: 'manager' }], 'bob 的 me.shared 看得到（manager）');
  r = await jC.get('/api/me');
  eq(r.data.shared.map((s) => [s.event_id, s.role]), [[E, 'viewer']], 'carol 的 me.shared 看得到（viewer）');
  {
    const txt = await localR2Text(`shares/${sha256hex(B.email.toLowerCase())}.json`);
    if (txt === undefined) console.log('  略過 shares 索引直讀（讀不到本機 R2）');
    else {
      const idx = JSON.parse(txt);
      ok(idx.events.length === 1 && idx.events[0].event_id === E && idx.events[0].role === 'manager' && idx.events[0].added_by === A.email && idx.events[0].added_at, 'shares/{sha256(email)}.json 已寫入（event_id、role、added_by、added_at）', idx);
    }
  }
  // 舊管理碼也能管成員
  r = await anon.post(`/api/admin/${E}/members`, { email: 'KeyAdded@Example.org', role: 'viewer' }, { token: evA.admin_code, origin: null });
  ok(r.status === 200 && r.data.members.some((m) => m.email === 'keyadded@example.org'), '管理碼新增成員（Email 轉小寫）');
  r = await anon.del(`/api/admin/${E}/members/${encodeURIComponent('keyadded@example.org')}`, { token: evA.admin_code, origin: null });
  ok(r.status === 200 && r.data.members.length === 2, '管理碼移除成員');
  r = await anon.del(`/api/admin/${E}/members/${encodeURIComponent('nobody@example.org')}`, { token: evA.admin_code, origin: null });
  ok(r.status === 404, '移除不存在的成員 → 404');

  console.log('[manager（bob）]');
  r = await jB.get(`/api/admin/${E}`);
  ok(r.status === 200 && r.data.role === 'manager' && r.data.auth === 'account', 'manager GET：role=manager、auth=account');
  r = await jB.patch(`/api/admin/${E}`, { basic: { location: '大禮堂' } });
  ok(r.status === 200 && r.data.config.basic.location === '大禮堂' && r.data.role === 'manager', 'manager 可 PATCH');
  r = await jB.post(`/api/admin/${E}/sync-key`, {});
  ok(r.status === 200 && r.data.sync_key.length === 32, 'manager 可產生同步金鑰');
  const SYNC_KEY_A = r.data.sync_key;
  r = await jB.get(`/api/admin/${E}`);
  eq(r.data.config.sync.key, SYNC_KEY_A, 'manager 看得到同步金鑰明碼');
  r = await jB.post(`/api/admin/${E}/exclude`, { hash: 'a'.repeat(64), excluded: true });
  ok(r.status === 200, 'manager 可排除照片');
  r = await jB.req('PUT', `/api/admin/${E}/og-card?auto=1`, { raw: TINY_PNG, headers: { 'content-type': 'image/png' } });
  ok(r.status === 200 && r.data.config.invite.card_ext === 'png', 'manager 可上傳預覽卡');
  r = await jB.post(`/api/admin/${E}/purge`, { confirm: '刪除' });
  ok(r.status === 403 && r.data.error === 'forbidden', 'manager purge → 403');
  r = await jB.post(`/api/admin/${E}/rotate-upload-code`, {});
  ok(r.status === 403 && r.data.error === 'forbidden', 'manager rotate-upload-code → 403');
  r = await mem(jB, 'POST', '/members', { email: 'q@example.org', role: 'viewer' });
  ok(r.status === 403, 'manager 新增成員 → 403');
  r = await mem(jB, 'DELETE', `/members/${encodeURIComponent(C.email)}`);
  ok(r.status === 403, 'manager 移除成員 → 403');
  r = await mem(jB, 'GET', '/members');
  ok(r.status === 200 && r.data.members.length === 2, 'manager 可讀成員');
  r = await jB.get(`/api/admin/${E}/photos`);
  ok(r.status === 200 && Array.isArray(r.data.photos), 'manager 可讀照片清單');
  // 管理碼 / owner 看得到
  r = await jA.get(`/api/admin/${E}`);
  eq([r.data.role, r.data.config.sync.key], ['owner', SYNC_KEY_A], 'owner 看得到同步金鑰');
  // 同步金鑰實際可用
  r = await anon.get(`/api/sync/${E}/manifest`, { token: SYNC_KEY_A, origin: null });
  ok(r.status === 200, 'manager 產生的同步金鑰可用於 sync API');

  console.log('[viewer（carol）]');
  r = await jC.get(`/api/admin/${E}`);
  ok(r.status === 200 && r.data.role === 'viewer' && r.data.auth === 'account', 'viewer GET：role=viewer');
  ok(r.data.config.sync && !('key' in r.data.config.sync) && !r.text.includes(SYNC_KEY_A), 'viewer 的回應沒有 sync.key（整份回應也不含明碼）');
  ok(!('hash' in r.data.config.sync) && !('admin_hash' in r.data.config), 'viewer 回應沒有 hash');
  r = await jC.get(`/api/admin/${E}/photos`);
  ok(r.status === 200, 'viewer 可讀照片清單');
  r = await jC.get(`/api/admin/${E}/thumb/${'b'.repeat(64)}`);
  ok(r.status === 404, 'viewer 讀縮圖通過授權（照片不存在 → 404 而非 403）');
  r = await mem(jC, 'GET', '/members');
  ok(r.status === 200, 'viewer 可讀成員');
  for (const [label, m, path, body, o] of [
    ['PATCH', 'PATCH', '', { basic: { location: 'x' } }],
    ['exclude', 'POST', '/exclude', { hash: 'a'.repeat(64), excluded: false }],
    ['sync-key', 'POST', '/sync-key', {}],
    ['og-card', 'PUT', '/og-card', undefined, { raw: TINY_PNG, headers: { 'content-type': 'image/png' } }],
    ['purge', 'POST', '/purge', { confirm: '刪除' }],
    ['rotate', 'POST', '/rotate-upload-code', {}],
    ['members POST', 'POST', '/members', { email: 'q@example.org', role: 'viewer' }],
    ['members DELETE', 'DELETE', `/members/${encodeURIComponent(B.email)}`],
  ]) {
    r = await mem(jC, m, path, body, o);
    ok(r.status === 403 && r.data.error === 'forbidden', `viewer ${label} → 403`, r.status);
  }
  r = await jB.get(`/api/admin/${E}`);
  eq(r.data.config.basic.location, '大禮堂', 'viewer 的嘗試沒有改到資料');

  console.log('[非成員、未登入、Origin、憑證優先順序]');
  r = await jD.get(`/api/admin/${E}`);
  ok(r.status === 403 && r.data.error === 'forbidden', '非成員 GET → 403');
  r = await jD.patch(`/api/admin/${E}`, { basic: { location: 'x' } });
  ok(r.status === 403, '非成員 PATCH → 403');
  r = await mem(jD, 'GET', '/members');
  ok(r.status === 403, '非成員讀成員 → 403');
  r = await anon.get(`/api/admin/${E}`);
  ok(r.status === 401, '未登入 GET → 401');
  r = await anon.patch(`/api/admin/${E}`, { basic: { location: 'x' } }, { origin: null });
  ok(r.status === 401, '未登入 PATCH → 401');
  r = await mem(anon, 'GET', '/members', undefined, { origin: null });
  ok(r.status === 401, '未登入讀成員 → 401');
  r = await jB.patch(`/api/admin/${E}`, { basic: { location: 'x' } }, { origin: null });
  ok(r.status === 403 && r.data.error === 'bad_origin', 'cookie PATCH 缺 Origin → 403 bad_origin');
  r = await jB.patch(`/api/admin/${E}`, { basic: { location: 'x' } }, { origin: 'https://evil.example' });
  ok(r.status === 403 && r.data.error === 'bad_origin', 'cookie PATCH Origin 不同 → 403 bad_origin');
  r = await jB.patch(`/api/admin/${E}`, { basic: { location: 'x' } }, { origin: 'null' });
  ok(r.status === 403 && r.data.error === 'bad_origin', 'cookie PATCH Origin: null → 403 bad_origin');
  r = await jB.post(`/api/admin/${E}/sync-key`, {}, { origin: null });
  ok(r.status === 403, 'cookie POST sync-key 缺 Origin → 403');
  r = await jB.get(`/api/admin/${E}`, { origin: null });
  ok(r.status === 200, 'GET 不需要 Origin');
  r = await jB.get(`/api/admin/${E}`, { origin: 'https://evil.example' });
  ok(r.status === 200, 'GET 即使 Origin 不同也不擋（不改資料）');
  r = await jB.get(`/api/admin/${E}`);
  eq(r.data.config.basic.location, '大禮堂', 'Origin 被擋的 PATCH 沒有生效');
  r = await jB.patch(`/api/admin/${E}`, { basic: { location: '大禮堂' } }, { token: 'wrong-key-wrong-key-wrong-key-12' });
  ok(r.status === 401, '有 cookie 但 Bearer 錯誤 → 401（Bearer 優先，不退回 cookie）');
  r = await jD.get(`/api/admin/${E}`, { token: evA.admin_code });
  ok(r.status === 200 && r.data.role === 'owner' && r.data.auth === 'key', '非成員帶正確管理碼 → 以管理碼為準（owner / key）');
  r = await jB.patch(`/api/admin/${E}`, { basic: { location: '大禮堂2' } }, { token: evA.admin_code, origin: null });
  ok(r.status === 200, 'Bearer 管理碼的 PATCH 不受 Origin 規則影響');
  r = await jB.patch(`/api/admin/${E}`, { basic: { location: '大禮堂' } });
  r = await anon.get(`/api/sync/${E}/manifest`, { token: evA.admin_code, origin: null });
  ok(r.status === 401, '管理碼不能當同步金鑰（既有行為）');

  console.log('[已登入上傳記錄]');
  r = await jA.patch(`/api/admin/${E}`, { upload: { mode: 'open' } });
  eq(r.data.is_open, true, 'owner 開放上傳');
  r = await jA.patch(`/api/admin/${evA2.event_id}`, { upload: { mode: 'open' } });
  const up = async (jar, code, tag, o = {}) => {
    const bytes = makeJpeg(tag);
    const fd = new FormData();
    fd.set('photo', new File([bytes], 'x.jpg', { type: 'image/jpeg' }));
    fd.set('meta', JSON.stringify({ hash: sha(bytes), device: 'dev-' + tag }));
    const h = {};
    if (jar.header()) h.cookie = jar.header();
    if (o.origin !== null) h.origin = o.origin || ORIGIN;
    const res = await fetch(`${BASE}/api/u/${code}/photo`, { method: 'POST', body: fd, headers: h });
    return { status: res.status, data: await res.json(), bytes };
  };
  let u1 = await up(jA, evA.upload_code, `ua-${RUN}-1`);
  const u2 = await up(jA, evA.upload_code, `ua-${RUN}-2`);
  ok(u1.status === 201 && u2.status === 201, '登入者上傳 2 張');
  const dup = await fetch(`${BASE}/api/u/${evA.upload_code}/photo`, (() => {
    const fd = new FormData();
    fd.set('photo', new File([u1.bytes], 'x.jpg', { type: 'image/jpeg' }));
    fd.set('meta', JSON.stringify({ hash: sha(u1.bytes) }));
    return { method: 'POST', body: fd, headers: { cookie: jA.header(), origin: ORIGIN } };
  })());
  const dupJson = await dup.json();
  ok(dup.status === 200 && dupJson.duplicate === true, '重複上傳 → duplicate:true');
  r = await jA.get('/api/me');
  ok(r.data.uploads.length === 1 && r.data.uploads[0].event_id === E && r.data.uploads[0].count === 3 && r.data.uploads[0].valid === true
    && r.data.uploads[0].upload_url === `/u/${evA.upload_code}` && r.data.uploads[0].name === 'A 的活動' && r.data.uploads[0].last_at, '含 duplicate 在內 count=3（合併同一活動）', r.data.uploads);
  const lastAt1 = r.data.uploads[0].last_at;
  const anonUp = await up(anon, evA.upload_code, `anon-${RUN}-1`);
  ok(anonUp.status === 201, '匿名上傳照常運作');
  const noOrigin = await up(jA, evA.upload_code, `ua-${RUN}-noorigin`, { origin: null });
  const evilOrigin = await up(jA, evA.upload_code, `ua-${RUN}-evil`, { origin: 'https://evil.example' });
  ok(noOrigin.status === 201 && evilOrigin.status === 201, 'cookie 上傳缺 Origin／Origin 不同：上傳本身不受影響（201）');
  r = await jA.get('/api/me');
  eq(r.data.uploads[0].count, 3, '缺 Origin／Origin 不同的上傳不記到帳號（count 不變）');
  const u3 = await up(jB, evA.upload_code, `ub-${RUN}-1`);
  ok(u3.status === 201, 'bob 上傳');
  r = await jB.get('/api/me');
  eq(r.data.uploads.map((x) => [x.event_id, x.count]), [[E, 1]], 'bob 的 me.uploads count=1');
  r = await jA.get(`/api/u/${evA.upload_code}/info`);
  eq(r.data.me, { name: A.name, email: A.email, count: 3 }, 'info 已登入多回 me（name, email, count）');
  ok(r.data.progress.total === 6, 'info.progress.total 含所有人的照片（6 張）', r.data.progress);
  r = await jB.get(`/api/u/${evA.upload_code}/info`);
  eq(r.data.me.count, 1, 'bob 的 info.me.count=1');
  r = await jD.get(`/api/u/${evA.upload_code}/info`);
  eq(r.data.me, { name: D.name, email: D.email, count: 0 }, '登入但沒傳過 → me.count=0');
  r = await anon.get(`/api/u/${evA.upload_code}/info`);
  ok(!('me' in r.data), '未登入 info 沒有 me');
  await new Promise((res) => setTimeout(res, 20));
  await up(jA, evA2.upload_code, `ua2-${RUN}-1`);
  r = await jA.get('/api/me');
  eq(r.data.uploads.map((x) => [x.event_id, x.count]), [[evA2.event_id, 1], [E, 3]], 'me.uploads 新到舊（剛上傳的活動排最前）');
  ok(r.data.uploads[1].last_at === lastAt1, '另一個活動的 last_at 不變');
  // 並行上傳：count 不遺失
  const par = await Promise.all([1, 2, 3, 4, 5].map((i) => up(jD, evA2.upload_code, `ud-${RUN}-p${i}`)));
  ok(par.every((x) => x.status === 201), '並行 5 張上傳');
  r = await jD.get('/api/me');
  eq(r.data.uploads.map((x) => [x.event_id, x.count]), [[evA2.event_id, 5]], '並行上傳 5 張 → count=5（樂觀鎖重試不遺失）');
  // 照片 metadata 不含帳號資訊
  r = await jA.get(`/api/admin/${E}/photos`);
  ok(!r.text.includes(A.email) && !r.text.includes(A.sub), '照片清單不含上傳者帳號資訊');
  // 換上傳碼 → 該筆 valid:false
  r = await jA.post(`/api/admin/${E}/rotate-upload-code`, {});
  ok(r.status === 200, 'owner 可 rotate-upload-code');
  const newCode = r.data.upload_code;
  r = await jA.get('/api/me');
  ok(r.data.uploads.find((x) => x.event_id === E).valid === false, '換碼後該筆 valid=false');
  const up4 = await up(jA, newCode, `ua-${RUN}-4`);
  r = await jA.get('/api/me');
  const ent = r.data.uploads.find((x) => x.event_id === E);
  ok(up4.status === 201 && ent.valid === true && ent.count === 4 && ent.upload_url === `/u/${newCode}`, '用新碼上傳：upload_code 更新、count 累計、valid=true', ent);

  console.log('[DELETE /api/me/...]');
  r = await anon.del(`/api/me/uploads/${E}`, { origin: null });
  ok(r.status === 401, '未登入 DELETE me/uploads → 401');
  r = await jA.del(`/api/me/uploads/${E}`, { origin: null });
  ok(r.status === 403 && r.data.error === 'bad_origin', 'DELETE me/uploads 缺 Origin → 403');
  r = await jA.del(`/api/me/uploads/not-an-id`);
  ok(r.status === 400, 'DELETE me/uploads 壞 id → 400');
  r = await jA.del(`/api/me/uploads/${E}`);
  ok(r.status === 200 && r.data.ok === true, 'DELETE me/uploads/{id} → 200');
  r = await jA.get('/api/me');
  eq(r.data.uploads.map((x) => x.event_id), [evA2.event_id], '上傳記錄已移除，其他保留');
  r = await jA.get(`/api/u/${newCode}/info`);
  eq([r.status, r.data.progress.total], [200, 7], '移除記錄不影響活動與照片');
  r = await jA.del(`/api/me/uploads/${E}`);
  ok(r.status === 200, '重複移除 → 200（冪等）');
  r = await anon.del(`/api/me/events/${evA2.event_id}`, { origin: null });
  ok(r.status === 401, '未登入 DELETE me/events → 401');
  r = await jA.del(`/api/me/events/${evA2.event_id}`, { origin: null });
  ok(r.status === 403, 'DELETE me/events 缺 Origin → 403');
  r = await jA.del(`/api/me/events/${evA2.event_id}`);
  ok(r.status === 200, 'DELETE me/events/{id} → 200');
  r = await jA.get('/api/me');
  ok(!r.data.events.some((e) => e.event_id === evA2.event_id) && r.data.events.some((e) => e.event_id === E), 'me.events 已移除該筆，其他保留');
  r = await jA.get(`/api/admin/${evA2.event_id}`);
  ok(r.status === 200 && r.data.role === 'owner', '活動本身不受影響（仍可用 cookie 管理）');
  r = await jA.req('GET', `/api/me/events/${E}`);
  ok(r.status === 405, 'GET /api/me/events/{id} 405');
  r = await jA.req('DELETE', `/api/me`);
  ok(r.status === 405, 'DELETE /api/me 405');

  console.log('[移除成員]');
  r = await mem(jA, 'DELETE', `/members/${encodeURIComponent(B.email)}`, undefined, { origin: null });
  ok(r.status === 403 && r.data.error === 'bad_origin', 'cookie DELETE member 缺 Origin → 403');
  r = await mem(jA, 'DELETE', `/members/${encodeURIComponent(B.email.toUpperCase())}`);
  ok(r.status === 200 && r.data.members.length === 1 && r.data.members[0].email === C.email, 'owner 移除 bob（Email 不分大小寫）');
  r = await jB.get(`/api/admin/${E}`);
  ok(r.status === 403, '被移除後 bob GET → 403');
  r = await jB.patch(`/api/admin/${E}`, { basic: { location: 'x' } });
  ok(r.status === 403, '被移除後 bob PATCH → 403');
  r = await jB.get('/api/me');
  eq(r.data.shared, [], '被移除後 bob 的 me.shared 為空');
  {
    const txt = await localR2Text(`shares/${sha256hex(B.email.toLowerCase())}.json`);
    if (txt === undefined) console.log('  略過 shares 索引直讀（讀不到本機 R2）');
    else ok(txt !== null && JSON.parse(txt).events.length === 0, 'bob 的 shares 索引已同步移除', txt);
    const txtC = await localR2Text(`shares/${sha256hex(C.email.toLowerCase())}.json`);
    if (txtC !== undefined) ok(txtC !== null && JSON.parse(txtC).events.some((e) => e.event_id === E), 'carol 的 shares 索引仍在', txtC);
  }
  r = await jC.get(`/api/admin/${E}`);
  ok(r.status === 200 && r.data.role === 'viewer', 'carol 不受影響');
  r = await mem(jA, 'DELETE', `/members/${encodeURIComponent(B.email)}`);
  ok(r.status === 404, '重複移除 → 404');
  // 改角色後權限立即改變
  r = await mem(jA, 'POST', '/members', { email: C.email, role: 'manager' });
  ok(r.status === 200, 'carol 升為 manager');
  r = await jC.patch(`/api/admin/${E}`, { basic: { location: '大禮堂' } });
  ok(r.status === 200, 'carol 升級後可 PATCH');
  r = await mem(jA, 'POST', '/members', { email: C.email, role: 'viewer' });
  r = await jC.patch(`/api/admin/${E}`, { basic: { location: 'y' } });
  ok(r.status === 403, 'carol 降級後 PATCH → 403');
  // 大小寫：以大寫 Email 加入，登入者小寫 Email 也能使用
  r = await mem(jA, 'POST', '/members', { email: D.email.toUpperCase(), role: 'viewer' });
  ok(r.status === 200 && r.data.members.some((m) => m.email === D.email.toLowerCase()), '以大寫 Email 新增，儲存為小寫');
  r = await jD.get(`/api/admin/${E}`);
  ok(r.status === 200 && r.data.role === 'viewer', '成員比對不分大小寫');
  r = await jD.get('/api/me');
  ok(r.data.shared.length === 1 && r.data.shared[0].role === 'viewer', 'dave 的 me.shared 看得到（索引以小寫 Email 雜湊）');
  // 成員上限
  {
    const E2 = evA2.event_id;
    let last;
    for (let i = 1; i <= 20; i++) {
      last = await jA.post(`/api/admin/${E2}/members`, { email: `m${i}-${RUN}@example.org`, role: 'viewer' });
      if (last.status !== 200) break;
    }
    ok(last.status === 200 && last.data.members.length === 20, '成員可加到 20 位');
    r = await jA.post(`/api/admin/${E2}/members`, { email: `m21-${RUN}@example.org`, role: 'viewer' });
    ok(r.status === 400 && r.data.error === 'invalid', '第 21 位 → 400');
    r = await jA.post(`/api/admin/${E2}/members`, { email: `m1-${RUN}@example.org`, role: 'manager' });
    ok(r.status === 200, '已滿時仍可改既有成員角色');
    // 刪除活動後 me.shared 略過
    r = await jA.post(`/api/admin/${E2}/purge`, { confirm: '刪除' });
    ok(r.status === 200, 'owner purge（cookie）→ 200');
  }

  console.log('[CSP（§8.8）]');
  for (const path of ['/', '/admin', '/u/xxxxxxxxxxxxxxxxxxxxxx', `/u/${newCode}`]) {
    const res = await fetch(BASE + path);
    const csp = res.headers.get('content-security-policy') || '';
    ok(csp.includes("script-src 'self' https://accounts.google.com/gsi/client") && csp.includes('frame-src https://accounts.google.com/gsi/')
      && csp.includes("connect-src 'self' https://accounts.google.com/gsi/") && csp.includes('style-src \'self\' https://fonts.googleapis.com https://accounts.google.com/gsi/style')
      && csp.includes("frame-ancestors 'none'") && csp.includes("base-uri 'none'"), `${path} 的 CSP 含 Google 網域`, csp);
  }
  for (const path of ['/download', '/download/']) {
    const res = await fetch(BASE + path);
    eq(res.headers.get('content-security-policy'), CSP, `${path} 的 CSP 維持原樣`);
  }
  {
    const res = await fetch(BASE + '/api/health');
    ok(!res.headers.get('content-security-policy'), 'API 回應不加 CSP');
  }

  console.log('[DEV_TEST_JWKS 只在 localhost / 127.0.0.1 採用（實際請求）]');
  {
    const tok = mintIdToken(mkUser('hostcheck'));
    const body = JSON.stringify({ credential: tok });
    const hdr = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
    const u = new URL(BASE);
    for (const host of [`localhost:${u.port}`, `127.0.0.1:${u.port}`]) {
      const res = await rawRequest('POST', '/api/auth/google', { host, headers: hdr, body });
      ok(res.status === 200 && res.data && res.data.user && res.headers['set-cookie'], `Host: ${host} → 採用測試金鑰，登入成功`, { s: res.status, d: res.data });
    }
    for (const host of ['example.com', 'mv-photo-collect.example.workers.dev']) {
      const res = await rawRequest('POST', '/api/auth/google', { host, headers: hdr, body });
      ok([401, 503].includes(res.status) && !res.headers['set-cookie'] && !(res.data && res.data.user), `Host: ${host} → 忽略 DEV_TEST_JWKS，登入失敗（${res.status} ${res.data && res.data.error}）`, { s: res.status, d: res.data });
    }
    // 對照：非本機 host 上 /api/auth/config 仍照常回傳
    const res = await rawRequest('GET', '/api/auth/config', { host: 'example.com' });
    ok(res.status === 200 && res.data.google_client_id === CLIENT_ID, '非本機 host 的 /api/auth/config 照常');
  }
}

async function main() {
  console.log(`BASE_URL = ${BASE}`);

  console.log('[health]');
  let r = await api('GET', '/api/health');
  eq([r.status, r.data], [200, { ok: true, version: '1' }], 'GET /api/health');
  ok(r.headers.get('x-robots-tag') === 'noindex', 'health 有 X-Robots-Tag');
  ok(r.headers.get('cache-control') === 'no-store', 'health Cache-Control: no-store');
  r = await api('OPTIONS', '/api/health');
  ok(r.status === 204 && !r.headers.get('access-control-allow-origin'), 'OPTIONS 204 且無 CORS');

  console.log('[建立活動]');
  r = await api('POST', '/api/events', { headers: { 'x-create-secret': 'wrong' }, body: { name: 'X', date: null } });
  ok(r.status === 401 && r.data.error === 'bad_create_secret', '錯誤建立密碼 401');
  r = await api('POST', '/api/events', { headers: { 'x-create-secret': SECRET }, body: { name: '', date: null } });
  ok(r.status === 400 && r.data.error === 'invalid', '空名稱 400');
  r = await api('POST', '/api/events', { headers: { 'x-create-secret': SECRET }, body: { name: 'X', date: '2026-13-40' } });
  ok(r.status === 400, '壞日期 400');
  const today = new Date().toISOString().slice(0, 10);
  const ev = await createEvent('測試活動', today);
  ok(/^ev_[A-Za-z0-9_-]{12}$/.test(ev.event_id), 'event_id 格式');
  ok(ev.admin_code.length === 32 && ev.upload_code.length === 22, '管理碼 32 字、上傳碼 22 字');
  ok(ev.admin_url === `/admin#e=${ev.event_id}&k=${ev.admin_code}` && ev.upload_url === `/u/${ev.upload_code}`, 'admin_url / upload_url');
  const { event_id: id, admin_code: AK, upload_code: UC } = ev;

  console.log('[管理 GET / 驗證]');
  r = await api('GET', `/api/admin/${id}`, { token: AK });
  ok(r.status === 201 || r.status === 200, 'GET 管理 200');
  ok(r.data.config && !('admin_hash' in r.data.config) && !('hash' in (r.data.config.sync || {})), 'config 不含 admin_hash / sync.hash');
  eq(r.data.stage, 'planning', '初始 stage=planning');
  eq(r.data.must_missing, ['upload'], 'must_missing=[upload]');
  eq(r.data.stats.total, 0, '初始 total=0');
  eq(r.data.config.invite, { title: '', message: '', card_updated_at: null, card_ext: null, card_auto: false }, '初始 config.invite');
  eq(r.data.invite_effective.title, '測試活動', '預設 invite_effective.title = 活動名稱');
  eq(r.data.invite_effective.message, `邀請你上傳【測試活動】拍到的照片，我們會一起做成回顧 MV。${today.replace(/-/g, '/')}`,
    '預設 invite_effective.message 只留有值的欄位（無地點、無截止日）');
  ok(r.data.invite_effective.image_url.startsWith(`${BASE}/og/${UC}?v=`), 'invite_effective.image_url 為絕對網址 /og/{code}?v=');
  r = await api('GET', `/api/admin/${id}`, { token: 'x'.repeat(32) });
  ok(r.status === 401, '錯誤 bearer 401');
  r = await api('GET', `/api/admin/${id}`);
  ok(r.status === 401, '無 bearer 401');
  r = await api('GET', `/api/admin/ev_notexist1234`, { token: AK });
  ok(r.status === 404, '不存在活動 404');
  r = await api('GET', `/api/admin/bad-id`, { token: AK });
  ok(r.status === 400, '壞 id 400');

  console.log('[PATCH]');
  const schedule = '09:00-09:30 報到相見歡\n09:30～10:30 闖關遊戲\n10:30至11:00 。午餐!\n11：00 無效行\n11:00到12:00 閉幕式\n09:00-09:30 報到相見歡\n垃圾行';
  const opens = iso(-1);
  const closes = iso(30);
  r = await api('PATCH', `/api/admin/${id}`, {
    token: AK,
    body: {
      basic: { location: '台北', organizer: '天達堂' },
      schedule_text: schedule,
      groups: [' 第一小隊 ', '第二小隊', '第一小隊', ''],
      upload: { opens_at: opens, closes_at: closes, max_mb: 5, retention_days: 30 },
      upload_code: 'hack',
    },
  });
  eq(r.status, 200, 'PATCH 200');
  eq(r.data.config.segments, [
    { start: '09:00', end: '09:30', name: '報到相見歡', title: '報到相見歡', day: null, date: null },
    { start: '09:30', end: '10:30', name: '闖關遊戲', title: '闖關遊戲', day: null, date: null },
    { start: '10:30', end: '11:00', name: '午餐', title: '午餐', day: null, date: null },
    { start: '11:00', end: '12:00', name: '閉幕式', title: '閉幕式', day: null, date: null },
  ], 'segments 解析（全形～、至、到、去重、忽略壞行）');
  eq(r.data.config.shots.map((s) => [s.segment, s.target, s.source]), [
    ['報到相見歡', 8, 'auto'], ['闖關遊戲', 8, 'auto'], ['午餐', 8, 'auto'], ['閉幕式', 8, 'auto'],
  ], 'auto 拍攝清單');
  eq(r.data.config.groups, ['第一小隊', '第二小隊'], 'groups 去空白去重');
  eq(r.data.config.upload_code, UC, 'upload_code 不可被 PATCH 改');
  eq(r.data.stage, 'open', '開放後 stage=open（活動日=今天）');
  eq(r.data.must_missing, [], 'must_missing 已空');
  ok(!!r.data.delete_at, 'delete_at 有值');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { upload: { max_mb: 1 } } });
  ok(r.status === 400, 'max_mb 超出範圍 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { upload: { opens_at: '2026-01-01' } } });
  ok(r.status === 400, 'opens_at 無時區 400');
  // 手動新增一項 shot 並刪除/保留測試
  r = await api('PATCH', `/api/admin/${id}`, {
    token: AK,
    body: { shots: [
      { segment: '報到相見歡', target: 2, tip: '入場笑臉', source: 'manual' },
      { segment: '闖關遊戲', target: 3, tip: '', source: 'auto' },
      { segment: '午餐', target: 8, tip: '', source: 'auto' },
      { segment: '閉幕式', target: 8, tip: '', source: 'auto' },
      { segment: '額外鏡頭', target: 1, tip: '', source: 'manual' },
    ] },
  });
  eq(r.status, 200, 'PATCH shots');
  // 移除「午餐」環節：auto 項目被刪、manual 保留
  r = await api('PATCH', `/api/admin/${id}`, {
    token: AK,
    body: { schedule_text: '09:00-09:30 報到相見歡\n09:30-10:30 闖關遊戲\n11:00-12:00 閉幕式' },
  });
  eq(r.data.config.shots.map((s) => s.segment), ['報到相見歡', '闖關遊戲', '閉幕式', '額外鏡頭'], '環節刪除時 auto shot 一併刪除、manual 保留');
  // 還原成含午餐的流程表（午餐重新產生 auto）
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { schedule_text: schedule } });
  ok(r.data.config.shots.some((s) => s.segment === '午餐' && s.source === 'auto'), '午餐 auto shot 重新產生');

  console.log('[邀請與預覽卡]');
  r = await api('GET', `/api/admin/${id}`, { token: AK });
  eq(r.data.invite_effective.message,
    `邀請你上傳【測試活動】拍到的照片，我們會一起做成回顧 MV。${today.replace(/-/g, '/')} 台北・開放至 ${tpeMD(closes)}`,
    '有地點與截止日時 message 完整（日期 地點・開放至 M/D）');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { invite: { title: 'x'.repeat(41) } } });
  ok(r.status === 400, 'invite.title 超過 40 字 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { invite: { message: '字'.repeat(121) } } });
  ok(r.status === 400, 'invite.message 超過 120 字 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { invite: { title: 5 } } });
  ok(r.status === 400, 'invite.title 非字串 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { invite: { title: '  自訂\u0000標題 ', message: '第一行\n第二行\t\u0007結尾' } } });
  eq([r.status, r.data.config.invite.title, r.data.config.invite.message], [200, '自訂 標題', '第一行 第二行 結尾'], 'PATCH invite 去控制字元並修剪');
  eq([r.data.invite_effective.title, r.data.invite_effective.message], ['自訂 標題', '第一行 第二行 結尾'], '自訂值覆蓋 invite_effective');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { invite: { title: '', message: '' } } });
  eq([r.data.invite_effective.title, r.data.config.invite.title], ['測試活動', ''], '留空回到自動產生');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { invite: { card_updated_at: 'x', card_ext: 'exe' } } });
  eq([r.data.config.invite.card_updated_at, r.data.config.invite.card_ext], [null, null], 'card_updated_at / card_ext 不可由 PATCH 改');

  // og 預覽圖：尚無卡片 → 預設圖
  r = await fetch(`${BASE}/og/${UC}`);
  let ogBuf = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && ogBuf.equals(DEFAULT_PNG), '無卡片時 /og/{code} 回預設 PNG');
  eq(pngSize(ogBuf), [1200, 630], '預設圖為 1200×630');
  ok(r.headers.get('cache-control') === 'public, max-age=300', '/og Cache-Control: public, max-age=300');
  r = await fetch(`${BASE}/og/${'z'.repeat(22)}`);
  ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(DEFAULT_PNG), '無效碼 /og 回預設 PNG');
  r = await fetch(`${BASE}/og/bad`);
  ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(DEFAULT_PNG), '格式錯誤的碼 /og 回預設 PNG');

  // PUT og-card 驗證
  const putCard = (body, type, { token = AK, query = '' } = {}) => api('PUT', `/api/admin/${id}/og-card${query}`, { token, raw: body, headers: type ? { 'content-type': type } : {} });
  r = await putCard(TINY_PNG, 'image/png', { token: '' });
  ok(r.status === 401, 'og-card 無金鑰 401');
  r = await putCard(TINY_PNG, 'text/plain');
  ok(r.status === 415 && r.data.error === 'bad_type', 'og-card 錯 MIME 415');
  r = await putCard(TINY_PNG, 'image/gif');
  ok(r.status === 415, 'og-card image/gif 415');
  r = await putCard(TINY_JPG, 'image/png');
  ok(r.status === 415, 'og-card 內容與 MIME 不符 415');
  r = await putCard(Buffer.concat([TINY_PNG, Buffer.alloc(2 * 1024 * 1024)]), 'image/png');
  ok(r.status === 413 && r.data.error === 'too_large', 'og-card 超過 1.5MB 回 413');
  r = await api('POST', `/api/admin/${id}/og-card`, { token: AK, raw: TINY_PNG });
  ok(r.status === 405, 'og-card 非 PUT 405');
  r = await fetch(`${BASE}/og/${UC}`);
  ok(Buffer.from(await r.arrayBuffer()).equals(DEFAULT_PNG), '失敗的 PUT 不改變預覽圖');

  r = await putCard(TINY_PNG, 'image/png', { query: '?auto=1' });
  ok(r.status === 200 && r.data.config.invite.card_ext === 'png' && r.data.config.invite.card_auto === true, 'PUT og-card PNG 200（auto=1）');
  const cardAt = r.data.config.invite.card_updated_at;
  ok(!!cardAt && !isNaN(Date.parse(cardAt)), 'card_updated_at 已更新');
  eq(r.data.invite_effective.image_url, `${BASE}/og/${UC}?v=${Date.parse(cardAt)}`, 'image_url 的 v = card_updated_at 時間戳');
  r = await fetch(`${BASE}/og/${UC}?v=1`);
  ogBuf = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && ogBuf.equals(TINY_PNG), '有卡片時 /og/{code} 回自訂 PNG');
  ok(r.headers.get('cache-control') === 'public, max-age=300', '自訂圖 Cache-Control: public, max-age=300');

  // 換成 JPEG：副檔名依 MIME，舊 PNG 不再被使用
  await new Promise((res) => setTimeout(res, 5));
  r = await putCard(TINY_JPG, 'image/jpeg', { query: '?auto=0' });
  ok(r.status === 200 && r.data.config.invite.card_ext === 'jpg' && r.data.config.invite.card_auto === false, 'PUT og-card JPEG（auto=0）');
  ok(r.data.config.invite.card_updated_at > cardAt, '換圖後 card_updated_at 變新');
  r = await fetch(`${BASE}/og/${UC}`);
  ogBuf = Buffer.from(await r.arrayBuffer());
  ok(r.headers.get('content-type') === 'image/jpeg' && ogBuf.equals(TINY_JPG), '/og 回自訂 JPEG');
  r = await putCard(TINY_PNG, 'image/png; charset=binary', { query: '?auto=1' });
  eq([r.status, r.data.config.invite.card_ext], [200, 'png'], '換回 PNG（Content-Type 帶參數也可）');
  const card1 = r.data.config.invite;

  // 上傳頁 meta（以社群爬蟲 UA 抓取）
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { invite: { title: '自訂標題', message: '歡迎來上傳 "照片" & <b>回憶</b>' } } });
  let pg = await getPage(`/u/${UC}`);
  ok(pg.status === 200, '/u/{code} 200');
  eq(titleOf(pg.html), '自訂標題｜照片募集', '<title> = {title}｜照片募集');
  eq(metaOf(pg.html, 'og:title'), '自訂標題', 'og:title');
  eq(metaOf(pg.html, 'og:description'), '歡迎來上傳 "照片" & <b>回憶</b>', 'og:description（HTML 已跳脫、可還原）');
  eq(metaOf(pg.html, 'description'), '歡迎來上傳 "照片" & <b>回憶</b>', 'meta description');
  eq(metaOf(pg.html, 'og:image'), `${BASE}/og/${UC}?v=${Date.parse(card1.card_updated_at)}`, 'og:image 為絕對網址 /og/{code}?v=卡片時間戳');
  eq(metaOf(pg.html, 'og:url'), `${BASE}/u/${UC}`, 'og:url 絕對網址');
  eq([metaOf(pg.html, 'og:type'), metaOf(pg.html, 'og:site_name'), metaOf(pg.html, 'twitter:card')], ['website', '活動照片募集', 'summary_large_image'], 'og:type / site_name / twitter:card');
  eq([metaOf(pg.html, 'og:image:width'), metaOf(pg.html, 'og:image:height')], ['1200', '630'], 'og:image 寬高');
  eq(metaOf(pg.html, 'og:image:alt'), '自訂標題｜活動照片募集', 'og:image:alt');
  ok((pg.html.match(/property="og:title"/g) || []).length === 1 && (pg.html.match(/<title>/g) || []).length === 1, 'meta 與 title 沒有重複');
  const bodyBeforeTpl = pg.html.split('<template')[0].split('<body')[1] || '';
  ok(bodyBeforeTpl.includes('活動照片上傳頁') && !/載入中|重新載入|繼續上傳|捨棄/.test(bodyBeforeTpl), '初始 body 只有簡短說明，沒有載入中／重新載入／繼續上傳等 UI 字');
  r = await fetch(`${BASE}/u/${UC}`, { method: 'HEAD' });
  ok(r.status === 200 && (r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"), 'HEAD /u/{code} 200 且有 CSP');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { invite: { title: '', message: '' } } });
  pg = await getPage(`/u/${UC}/`);
  eq([titleOf(pg.html), metaOf(pg.html, 'og:title')], ['測試活動｜照片募集', '測試活動'], '留空 → 預設用活動名稱（網址尾端斜線也可）');
  ok(metaOf(pg.html, 'og:description').startsWith('邀請你上傳【測試活動】拍到的照片'), '留空 → og:description 為自動文字');
  // 無效碼：通用文字，不洩露活動資訊
  for (const bad of ['a'.repeat(22), 'bad', '_app']) {
    pg = await getPage(`/u/${bad}`);
    ok(pg.status === 200 && titleOf(pg.html) === '活動照片募集' && metaOf(pg.html, 'og:title') === '活動照片募集'
      && metaOf(pg.html, 'og:image') === `${BASE}/assets/og-default.png` && !pg.html.includes('測試活動'), `/u/${bad} 用通用文字`);
  }

  console.log('[info / check]');
  r = await api('GET', `/api/u/${UC}/info?device=dev-1`);
  eq(r.status, 200, 'info 200');
  ok(r.data.is_open === true && r.data.stage === 'open', 'info is_open=true');
  ok(r.data.notice.includes('照片只用於') && !r.data.notice.includes('{delete_date}'), 'notice 已代入 delete_date');
  eq(r.data.progress.total, 0, '初始 progress.total=0');
  eq(r.data.device_count, 0, 'device_count=0');
  eq(r.data.max_mb, 5, 'max_mb');
  r = await api('GET', `/api/u/${'a'.repeat(22)}/info`);
  ok(r.status === 404 && r.data.error === 'not_found', '不存在上傳碼 404');
  r = await api('POST', `/api/u/${UC}/check`, { body: { hashes: ['0'.repeat(64)] } });
  eq(r.data, { existing: [] }, 'check 空');
  r = await api('POST', `/api/u/${UC}/check`, { body: { hashes: ['zz'] } });
  ok(r.status === 400, 'check 壞 hash 400');
  r = await api('POST', `/api/u/${UC}/check`, { body: { hashes: Array(201).fill('0'.repeat(64)) } });
  ok(r.status === 400, 'check 超過 200 個 400');

  console.log('[上傳]');
  const b1 = makeJpeg('photo-one');
  const b2 = makeJpeg('photo-two');
  const day = today;
  let u = await uploadPhoto(UC, { bytes: b1, meta: {
    orig_name: 'a.jpg', uploader: '小明', device: 'dev-1', groups: ['第一小隊'], segment: 'auto',
    exif_time: `${day}T09:10:00`, time_src: 'exif', w: 1, h: 1,
  } });
  ok(u.status === 201 && u.data.duplicate === false, '上傳第 1 張 201');
  u = await uploadPhoto(UC, { bytes: b2, meta: {
    orig_name: 'b.jpg', uploader: '小華', device: 'dev-2', groups: ['第二小隊'], segment: 'auto',
    exif_time: `${day}T10:00:00`, time_src: 'exif', w: 1, h: 1,
  } });
  ok(u.status === 201, '上傳第 2 張 201');
  const h1 = sha(b1);
  const h2 = sha(b2);
  u = await uploadPhoto(UC, { bytes: b1, meta: { device: 'dev-1' } });
  ok(u.status === 200 && u.data.duplicate === true, '重複上傳回 duplicate');
  u = await uploadPhoto(UC, { bytes: Buffer.alloc(6 * 1024 * 1024, 1), type: 'image/jpeg', meta: {}, thumb: false });
  ok(u.status === 413 && u.data.error === 'too_large', '過大回 413');
  u = await uploadPhoto(UC, { bytes: makeJpeg('txt'), type: 'text/html', meta: {} });
  ok(u.status === 415 && u.data.error === 'bad_type', '錯 MIME 回 415');
  u = await uploadPhoto(UC, { bytes: makeJpeg('nohash'), hash: 'xyz', meta: {} });
  ok(u.status === 400, '壞 meta.hash 回 400');
  {
    const fd = new FormData();
    fd.set('meta', JSON.stringify({ hash: '1'.repeat(64) }));
    const res = await fetch(`${BASE}/api/u/${UC}/photo`, { method: 'POST', body: fd });
    ok(res.status === 400, '缺 photo 回 400');
  }
  r = await api('POST', `/api/u/${UC}/check`, { body: { hashes: [h1, h2, '0'.repeat(64)] } });
  eq(r.data.existing.sort(), [h1, h2].sort(), 'check 回傳已存在');

  console.log('[info progress]');
  r = await api('GET', `/api/u/${UC}/info?device=dev-1`);
  eq(r.data.progress.total, 2, 'progress.total=2');
  eq(r.data.progress.by_segment.find((s) => s.name === '報到相見歡').have, 1, '09:10 歸「報到相見歡」');
  eq(r.data.progress.by_segment.find((s) => s.name === '闖關遊戲').have, 1, '10:00 歸「闖關遊戲」');
  eq(r.data.progress.unclassified, 0, 'unclassified=0');
  eq(r.data.device_count, 1, 'device_count(dev-1)=1');

  console.log('[管理統計]');
  r = await api('GET', `/api/admin/${id}`, { token: AK });
  const st = r.data.stats;
  eq([st.total, st.uploaders, st.excluded_count], [2, 2, 0], 'stats total/uploaders/excluded');
  ok(st.bytes > 0 && !!st.last_upload_at, 'bytes / last_upload_at');
  eq(Object.fromEntries(st.by_group.map((g) => [g.name, g.have])), { 第一小隊: 1, 第二小隊: 1 }, 'by_group');
  eq(st.recent.length, 2, 'recent 兩張');
  ok(st.recent.every((p) => p.has_thumb === true && p.excluded === false), 'recent has_thumb / excluded');
  eq(st.recent.find((p) => p.hash === h1).segment, '報到相見歡', 'recent segment 為生效環節');
  eq(st.recent.find((p) => p.hash === h1).groups, ['第一小隊'], 'recent groups');

  console.log('[排除 / 縮圖 / photos]');
  r = await api('POST', `/api/admin/${id}/exclude`, { token: AK, body: { hash: h2, excluded: true } });
  eq(r.data, { ok: true, excluded_count: 1 }, 'exclude');
  r = await api('POST', `/api/admin/${id}/exclude`, { token: AK, body: { hash: 'bad', excluded: true } });
  ok(r.status === 400, 'exclude 壞 hash 400');
  r = await api('GET', `/api/admin/${id}`, { token: AK });
  eq([r.data.stats.total, r.data.stats.excluded_count], [1, 1], '排除後 total=1、excluded_count=1');
  ok(r.data.stats.recent.find((p) => p.hash === h2).excluded === true, 'recent 標示 excluded');
  r = await api('GET', `/api/admin/${id}/thumb/${h1}`, { token: AK });
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && r.buf.equals(JPEG), 'thumb 回 JPEG');
  ok(r.headers.get('cache-control') === 'private, max-age=3600', 'thumb Cache-Control');
  r = await api('GET', `/api/admin/${id}/thumb/${'0'.repeat(64)}`, { token: AK });
  ok(r.status === 404, 'thumb 不存在 404');
  r = await api('GET', `/api/admin/${id}/thumb/xyz`, { token: AK });
  ok(r.status === 400, 'thumb 壞 hash 400');
  r = await api('GET', `/api/admin/${id}/photos`, { token: AK });
  eq([r.data.photos.length, r.data.cursor], [2, null], 'photos 列表');

  console.log('[同步]');
  r = await api('POST', `/api/admin/${id}/sync-key`, { token: AK });
  ok(r.status === 200 && r.data.sync_key.length === 32 && r.data.sync_url === `${BASE}/api/sync/${id}`, 'sync-key');
  const SK1 = r.data.sync_key;
  r = await api('POST', `/api/admin/${id}/sync-key`, { token: AK });
  const SK = r.data.sync_key;
  ok(SK !== SK1, '重發 sync-key 不同');
  r = await api('GET', `/api/sync/${id}/manifest`, { token: SK1 });
  ok(r.status === 401, '舊 sync_key 失效 401');
  r = await api('GET', `/api/sync/${id}/manifest`, { token: AK });
  ok(r.status === 401, '管理碼不能當同步金鑰');
  r = await api('GET', `/api/sync/${id}/manifest`, { token: SK });
  eq(r.status, 200, 'manifest 200');
  eq(r.data.photos.length, 1, 'manifest 不含已排除');
  const mp = r.data.photos[0];
  eq([mp.hash, mp.ext, mp.uploader, mp.device, mp.groups, mp.segment, mp.time_src, mp.original], [h1, 'jpg', '小明', 'dev-1', ['第一小隊'], 'auto', 'exif', false], 'manifest 欄位');
  eq(r.data.excluded, [h2], 'manifest.excluded');
  eq(r.data.event.id, id, 'manifest.event.id');
  eq(r.data.cursor, null, 'manifest.cursor=null');
  r = await api('GET', `/api/sync/${id}/photo/${h1}`, { token: SK });
  ok(r.status === 200 && r.buf.equals(b1), 'sync photo 位元組相同');
  ok(r.headers.get('content-type') === 'image/jpeg' && r.headers.get('etag') === `"${h1}"`, 'sync photo Content-Type / ETag');
  r = await api('GET', `/api/sync/${id}/photo/xyz`, { token: SK });
  ok(r.status === 400, 'sync photo 壞 hash 400');
  r = await api('GET', `/api/sync/${id}/photo/${'0'.repeat(64)}`, { token: SK });
  ok(r.status === 404, 'sync photo 不存在 404');
  r = await api('POST', `/api/sync/${id}/requirements`, { token: SK, body: { requirements: { 闖關遊戲: { photos_needed: 15 }, 不存在: { photos_needed: 3 } } } });
  eq(r.data, { ok: true, updated: 1 }, 'requirements 回寫');
  r = await api('GET', `/api/admin/${id}`, { token: AK });
  eq(r.data.config.shots.filter((s) => s.segment === '闖關遊戲').map((s) => [s.target, s.source]), [[15, 'mv']], 'shots target=15 source=mv');

  console.log('[換上傳碼]');
  r = await api('POST', `/api/admin/${id}/rotate-upload-code`, { token: AK });
  ok(r.status === 200 && r.data.upload_code.length === 22 && r.data.upload_url === `/u/${r.data.upload_code}`, 'rotate-upload-code');
  const UC2 = r.data.upload_code;
  r = await api('GET', `/api/u/${UC}/info`);
  ok(r.status === 404, '舊上傳碼 404');
  r = await api('GET', `/api/u/${UC2}/info`);
  ok(r.status === 200, '新上傳碼 200');
  u = await uploadPhoto(UC, { bytes: makeJpeg('old-code'), meta: {} });
  ok(u.status === 404, '舊碼上傳 404');
  r = await fetch(`${BASE}/og/${UC}`);
  ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(DEFAULT_PNG), '換上傳碼後舊碼 /og 回預設圖');
  r = await fetch(`${BASE}/og/${UC2}`);
  ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(TINY_PNG), '新碼 /og 回自訂圖');
  pg = await getPage(`/u/${UC}`);
  ok(titleOf(pg.html) === '活動照片募集' && !pg.html.includes('測試活動'), '舊碼 /u 頁面用通用文字');
  pg = await getPage(`/u/${UC2}`);
  eq(metaOf(pg.html, 'og:image'), `${BASE}/og/${UC2}?v=${Date.parse(card1.card_updated_at)}`, '新碼 og:image 指向新碼');

  console.log('[mode=closed]');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { upload: { mode: 'closed' } } });
  eq([r.data.stage, r.data.is_open], ['closed', false], 'mode=closed → stage closed');
  u = await uploadPhoto(UC2, { bytes: makeJpeg('closed'), meta: {} });
  ok(u.status === 403 && u.data.error === 'upload_closed', 'closed 時上傳 403');
  r = await api('PATCH', `/api/admin/${id}`, { token: AK, body: { upload: { mode: 'auto' } } });
  eq(r.data.is_open, true, 'mode=auto 恢復開放');

  console.log('[purge]');
  {
    const keys = await localR2Keys();
    if (keys !== null) {
      ok(keys.includes(`events/${id}/og.png`) && !keys.includes(`events/${id}/og.jpg`), 'purge 前 R2 只有 og.png（換格式時舊 og.jpg 已清掉）', keys.filter((k) => k.includes(id)));
    }
  }
  r = await api('POST', `/api/admin/${id}/purge`, { token: AK, body: { confirm: 'no' } });
  ok(r.status === 400, 'purge 未確認 400');
  r = await api('POST', `/api/admin/${id}/purge`, { token: AK, body: { confirm: '刪除' } });
  ok(r.status === 200 && r.data.ok === true && r.data.deleted === 2, 'purge 刪除 2 張', r.data);
  r = await api('GET', `/api/admin/${id}`, { token: AK });
  eq([r.data.stats.total, r.data.stage, r.data.is_open], [0, 'purged', false], 'purge 後照片清空、stage=purged');
  ok(!!r.data.config.deleted_at, 'deleted_at 已設');
  r = await api('GET', `/api/admin/${id}/thumb/${h1}`, { token: AK });
  ok(r.status === 404, 'purge 後縮圖也沒了');
  r = await fetch(`${BASE}/og/${UC2}`);
  ok(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(DEFAULT_PNG), 'purge 後 /og 回預設圖');
  pg = await getPage(`/u/${UC2}`);
  ok(titleOf(pg.html) === '活動照片募集' && !pg.html.includes('測試活動'), 'purge 後 /u 頁面用通用文字');
  r = await putCard(TINY_PNG, 'image/png');
  ok(r.status === 409, 'purge 後不能再上傳預覽圖 409');
  {
    const keys = await localR2Keys();
    if (keys === null) console.log('  skip 讀不到本機 R2 sqlite，略過「og 物件已刪除」檢查');
    else {
      ok(keys.some((k) => k === `events/${id}/config.json`), '（對照）本機 R2 讀得到 config.json');
      ok(!keys.some((k) => k.startsWith(`events/${id}/og.`)), 'purge 後 R2 的 og.png / og.jpg 已刪除', keys.filter((k) => k.includes(id)));
    }
  }

  console.log('[靜態路由]');
  for (const [path, label] of [['/u/xxxxxxxxxxxxxxxxxxxxxx', '/u/xxx'], ['/admin', '/admin'], ['/download', '/download'], ['/download/', '/download/']]) {
    r = await fetch(BASE + path);
    const text = await r.text();
    const csp = r.headers.get('content-security-policy') || '';
    ok(r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'), `${label} 200 HTML`, r.status);
    ok(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'"), `${label} 有 CSP`);
    ok(r.headers.get('x-robots-tag') === 'noindex' && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('referrer-policy') === 'no-referrer', `${label} 安全標頭`);
    ok(text.length > 0, `${label} 有內容`);
  }
  r = await fetch(BASE + '/u/abc');
  ok((await r.text()).includes('<'), '/u/abc 為 HTML');
  r = await fetch(BASE + '/assets/base.css');
  ok(r.status === 200 && r.headers.get('x-robots-tag') === 'noindex', '/assets/base.css 靜態檔 200');
  r = await api('GET', '/api/nothing');
  ok(r.status === 404 && r.data.error === 'not_found', '未知 API 404');

  console.log('[排程]');
  const ev2 = await createEvent('過期活動', null);
  const id2 = ev2.event_id;
  r = await api('PATCH', `/api/admin/${id2}`, { token: ev2.admin_code, body: { upload: { opens_at: iso(-300), closes_at: iso(30), retention_days: 30 } } });
  eq(r.status, 200, '排程活動設定開放');
  const sb = makeJpeg('sched');
  u = await uploadPhoto(ev2.upload_code, { bytes: sb, meta: { device: 'd' } });
  ok(u.status === 201, '排程活動上傳 1 張');
  // 一個未過期的對照活動，確認不會被誤刪
  const ev3 = await createEvent('未過期活動', null);
  await api('PATCH', `/api/admin/${ev3.event_id}`, { token: ev3.admin_code, body: { upload: { opens_at: iso(-1), closes_at: iso(5), retention_days: 30 } } });
  u = await uploadPhoto(ev3.upload_code, { bytes: makeJpeg('keep'), meta: {} });
  ok(u.status === 201, '對照活動上傳 1 張');
  // 把 closes_at 改到 200 天前
  r = await api('PATCH', `/api/admin/${id2}`, { token: ev2.admin_code, body: { upload: { closes_at: iso(-200) } } });
  eq(r.data.stage, 'closed', 'closes_at 已過 → stage=closed');
  r = await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
  ok(r.status === 200, '觸發 scheduled', r.status);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    r = await api('GET', `/api/admin/${id2}`, { token: ev2.admin_code });
    gone = r.data && r.data.stage === 'purged';
    if (!gone) await new Promise((res) => setTimeout(res, 250));
  }
  ok(gone, 'scheduled 後活動 stage=purged');
  eq(r.data.stats.total, 0, 'scheduled 後照片已刪');
  r = await api('GET', `/api/u/${ev2.upload_code}/info`);
  ok(r.status === 404, 'scheduled 後上傳碼失效 404');
  r = await api('GET', `/api/u/${ev3.upload_code}/info`);
  ok(r.status === 200 && r.data.progress.total === 1, '未過期活動不受影響');
  r = await fetch(`${BASE}/og/${ev3.upload_code}`);
  ok(Buffer.from(await r.arrayBuffer()).equals(DEFAULT_PNG), '沒有卡片的活動 /og 回預設圖');
  pg = await getPage(`/u/${ev3.upload_code}`);
  ok(metaOf(pg.html, 'og:title') === '未過期活動' && /\/og\/[A-Za-z0-9_-]{22}\?v=\d+$/.test(metaOf(pg.html, 'og:image')), '沒有卡片的活動 og:image 用 updated_at 當版本');
  r = await fetch(`${BASE}/og/${ev2.upload_code}`);
  ok(Buffer.from(await r.arrayBuffer()).equals(DEFAULT_PNG), '排程刪除後 /og 回預設圖');
  pg = await getPage(`/u/${ev2.upload_code}`);
  ok(titleOf(pg.html) === '活動照片募集' && !pg.html.includes('過期活動'), '排程刪除後 /u 用通用文字');

  await unitTests();
  await authTests();
  await mineAlbumTests();
  await multiDayTests();
  await rotationTests();
  await importTests();

  console.log(`\n結果：通過 ${pass} 項，失敗 ${fail} 項`);
  process.exit(fail ? 1 : 0);
}

// ================= 我上傳的照片 ／ 參與者相簿 =================
async function mineAlbumTests() {
  let r;
  let pg;
  const D1 = 'dev-aaaaaaaaaaaaaaaa-1';
  const D2 = 'dev-bbbbbbbbbbbbbbbb-2';
  const ev = await createEvent('相簿測試', '2026-11-20');
  const id = ev.event_id; const tok = ev.admin_code; const up = ev.upload_code;
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { groups: ['一小隊', '二小隊'], schedule_text: '09:00-10:00 報到\n10:00-12:00 闖關', upload: { mode: 'open' } } });
  ok(r.status === 200, '相簿測試活動設定');
  const sk = (await api('POST', `/api/admin/${id}/sync-key`, { token: tok })).data.sync_key;
  const manifest = async () => (await api('GET', `/api/sync/${id}/manifest`, { token: sk })).data;
  const mineApi = (method, path, dev, body, headers = {}) => api(method, `/api/u/${up}/mine${path}`, { body, headers: { ...(dev ? { 'x-device': dev } : {}), ...headers } });

  console.log('[我上傳的照片]');
  const a = await uploadPhoto(up, { bytes: makeJpeg('mine-a'), meta: { device: D1, uploader: '小林', groups: ['一小隊'], exif_time: '2026-11-20T10:30:00' } });
  const b = await uploadPhoto(up, { bytes: makeJpeg('mine-b'), meta: { device: D1, uploader: '小林', exif_time: '2026-11-20T13:00:00' } });
  const c = await uploadPhoto(up, { bytes: makeJpeg('mine-c'), meta: { device: D2, uploader: '阿哲', exif_time: '2026-11-20T09:10:00' } });
  ok([a, b, c].every((x) => x.status === 201), '三張上傳成功');
  r = await mineApi('GET', '', null);
  ok(r.status === 400, '沒有裝置碼也沒登入 → 400');
  r = await mineApi('GET', '', 'short');
  ok(r.status === 400, '裝置碼格式不對 → 400');
  r = await mineApi('GET', '', D1);
  eq([r.status, r.data.photos.map((p) => p.hash).sort()], [200, [a.hash, b.hash].sort()], 'D1 只看到自己的兩張');
  ok(r.data.editable === true && r.data.groups.length === 2 && r.data.segments.length === 2, 'mine 回傳 editable、groups、segments');
  const pb = r.data.photos.find((p) => p.hash === b.hash);
  ok(pb.segment_effective === null && r.data.photos.find((p) => p.hash === a.hash).segment_effective === '闖關', '待標環節判斷（13:00 不在任何環節）');
  ok(!JSON.stringify(r.data).includes(D1) && !('sub' in pb) && !('device' in pb), 'mine 不回傳裝置碼與帳號');
  r = await mineApi('GET', '', D2);
  eq(r.data.photos.map((p) => p.hash), [c.hash], 'D2 只看到自己的一張');
  r = await fetch(`${BASE}/api/u/${up}/mine/${a.hash}/thumb?d=${D1}`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', '自己的縮圖 200');
  r = await fetch(`${BASE}/api/u/${up}/mine/${c.hash}/thumb?d=${D1}`);
  ok(r.status === 404, '別人的縮圖 404');

  r = await mineApi('PATCH', `/${a.hash}`, D1, { groups: ['二小隊', '不存在'], segment: '報到', note: '隊長\n抱起獎盃' });
  eq([r.status, r.data.groups, r.data.segment, r.data.note], [200, ['二小隊'], '報到', '隊長 抱起獎盃'], 'PATCH 小隊（過濾不存在）、環節、備註（去換行）');
  r = await mineApi('PATCH', `/${b.hash}`, D1, { segment: '亂寫' });
  eq(r.data.segment, 'auto', '不存在的環節改成 auto');
  r = await mineApi('PATCH', `/${c.hash}`, D1, { note: 'x' });
  ok(r.status === 404, '改別人的照片 → 404');
  r = await mineApi('PATCH', `/${a.hash}`, D1, { groups: 'x' });
  ok(r.status === 400, 'groups 不是陣列 → 400');
  let m = await manifest();
  const ma = m.photos.find((p) => p.hash === a.hash);
  eq([ma.note, ma.groups, ma.segment, !!ma.edited_at, ma.priority, ma.votes], ['隊長 抱起獎盃', ['二小隊'], '報到', true, false, 0], 'manifest 帶備註與修改後的小隊環節');
  r = await mineApi('GET', '', D1);
  ok(r.data.photos.find((p) => p.hash === a.hash).segment_effective === '報到', '修改後 mine 反映新環節');

  // 更換
  const fdRep = (bytes, extra = {}) => {
    const fd = new FormData();
    fd.set('photo', new File([bytes], 'new.jpg', { type: 'image/jpeg' }));
    fd.set('thumb', new File([JPEG], 't.jpg', { type: 'image/jpeg' }));
    fd.set('meta', JSON.stringify({ hash: sha(bytes), exif_time: '2026-11-20T09:20:00', orig_name: 'new.jpg', ...extra }));
    return fd;
  };
  const newBytes = makeJpeg('mine-a2');
  let res = await fetch(`${BASE}/api/u/${up}/mine/${a.hash}/replace`, { method: 'POST', headers: { 'x-device': D2 }, body: fdRep(newBytes) });
  ok(res.status === 404, '更換別人的照片 → 404');
  res = await fetch(`${BASE}/api/u/${up}/mine/${a.hash}/replace`, { method: 'POST', headers: { 'x-device': D1 }, body: fdRep(makeJpeg('mine-c')) });
  ok(res.status === 409, '換成已存在的照片 → 409 duplicate');
  res = await fetch(`${BASE}/api/u/${up}/mine/${a.hash}/replace`, { method: 'POST', headers: { 'x-device': D1 }, body: fdRep(newBytes) });
  const rep = await res.json();
  eq([res.status, rep.old_hash, rep.hash], [201, a.hash, sha(newBytes)], '更換成功回新舊 hash');
  r = await mineApi('GET', '', D1);
  const pa2 = r.data.photos.find((p) => p.hash === sha(newBytes));
  ok(pa2 && pa2.note === '隊長 抱起獎盃' && pa2.groups.join() === '二小隊' && pa2.segment === '報到' && pa2.replaced, '更換後保留小隊、環節、備註');
  ok(!r.data.photos.some((p) => p.hash === a.hash), '舊照片已不在清單');
  m = await manifest();
  ok(m.excluded.includes(a.hash) && m.removed.includes(a.hash) && m.photos.some((p) => p.hash === sha(newBytes)), 'manifest：舊照片進 excluded／removed，新照片在 photos');

  // 排除後不能改
  r = await api('POST', `/api/admin/${id}/exclude`, { token: tok, body: { hash: b.hash, excluded: true } });
  r = await mineApi('PATCH', `/${b.hash}`, D1, { note: 'x' });
  eq([r.status, r.data.error], [403, 'excluded'], '主辦者排除後修改 → 403 excluded');
  r = await mineApi('GET', '', D1);
  ok(r.data.photos.find((p) => p.hash === b.hash).excluded === true, 'mine 顯示已排除');
  r = await api('POST', `/api/admin/${id}/exclude`, { token: tok, body: { hash: b.hash, excluded: false } });

  // 關閉上傳後不能改，但可刪
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { upload: { mode: 'closed' } } });
  r = await mineApi('PATCH', `/${b.hash}`, D1, { note: 'x' });
  eq([r.status, r.data.error], [403, 'upload_closed'], '關閉上傳後修改 → 403');
  r = await mineApi('GET', '', D1);
  ok(r.data.editable === false, '關閉後 editable=false');
  r = await mineApi('DELETE', `/${b.hash}`, D2);
  ok(r.status === 404, '刪別人的照片 → 404');
  r = await mineApi('DELETE', `/${b.hash}`, D1);
  ok(r.status === 200, '關閉後仍可刪除自己的照片');
  r = await mineApi('GET', '', D1);
  eq(r.data.photos.length, 1, '刪除後剩一張');
  m = await manifest();
  ok(m.excluded.includes(b.hash) && !m.photos.some((p) => p.hash === b.hash), '刪除的照片進 manifest excluded');
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { upload: { mode: 'open' } } });
  const reup = await uploadPhoto(up, { bytes: makeJpeg('mine-b'), meta: { device: D2 } });
  m = await manifest();
  ok(reup.status === 201 && !m.excluded.includes(b.hash) && m.photos.some((p) => p.hash === b.hash), '同一張照片重新上傳後從 removed 移除');

  // 登入帳號：別支手機也看得到
  const U = mkUser('mine');
  const jU = new Jar();
  await loginAs(jU, U);
  {
    const bytes = makeJpeg('mine-login');
    const fd = new FormData();
    fd.set('photo', new File([bytes], 'x.jpg', { type: 'image/jpeg' }));
    fd.set('meta', JSON.stringify({ hash: sha(bytes), device: 'dev-cccccccccccccccc-3' }));
    res = await fetch(`${BASE}/api/u/${up}/photo`, { method: 'POST', body: fd, headers: { cookie: jU.header(), origin: ORIGIN } });
    ok(res.status === 201, '登入後上傳');
    r = await jU.get(`/api/u/${up}/mine`);
    ok(r.status === 200 && r.data.photos.some((p) => p.hash === sha(bytes)) && r.data.login && r.data.login.email === U.email, '同帳號（不帶裝置碼）看得到自己上傳的照片');
    r = await jU.patch(`/api/u/${up}/mine/${sha(bytes)}`, { note: '帳號改' }, { origin: 'https://evil.example' });
    ok(r.status === 403, '只靠 cookie 的修改需同源 → 403');
    r = await jU.patch(`/api/u/${up}/mine/${sha(bytes)}`, { note: '帳號改' });
    ok(r.status === 200 && r.data.note === '帳號改', '同帳號可修改');
  }
  r = await fetch(`${BASE}/u/${up}/mine`);
  ok(r.status === 200 && (await r.text()).includes('我上傳的照片'), '/u/{code}/mine 頁面');

  console.log('[參與者相簿]');
  r = await api('GET', '/api/a/AAAAAAAAAAAAAAAAAAAAAA/info');
  ok(r.status === 404, '不存在的相簿 → 404');
  r = await api('GET', `/api/admin/${id}/album`, { token: tok });
  ok(r.status === 200 && r.data.album.enabled === false && r.data.album_url === null, '相簿預設關閉、沒有連結');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { enabled: true, limit: 1, show_votes: 'live' } } });
  ok(r.status === 200 && /^\/a\/[A-Za-z0-9_-]{22}$/.test(r.data.album_url) && r.data.config.album.has_password === false && !('password_hash' in r.data.config.album), '開啟相簿產生連結，不外露密碼雜湊');
  let aurl = r.data.album_url;
  let acode = aurl.split('/')[2];
  ok(acode !== up, '相簿碼與上傳碼不同');
  const albumApi = (method, path, { dev, body, headers = {} } = {}) => api(method, `/api/a/${acode}${path}`, { body, headers: { ...(dev ? { 'x-device': dev } : {}), ...headers } });
  r = await albumApi('GET', '/info');
  ok(r.status === 200 && r.data.me.kind === null && r.data.photos.length === 4, '匿名可看相簿（4 張）');
  ok(!JSON.stringify(r.data).includes(up), '相簿資料不含上傳碼');
  r = await albumApi('GET', '/info', { dev: D1 });
  ok(r.data.me.kind === 'device' && r.data.me.needs_name === true, '裝置身分需要暱稱');
  const ownHash = sha(newBytes); // D1 拍的
  const otherHash = c.hash; // D2 拍的
  ok(r.data.photos.find((p) => p.hash === ownHash).mine === true && r.data.photos.find((p) => p.hash === otherHash).mine === false, 'mine 標記自己拍的');
  r = await albumApi('POST', '/vote', { dev: D1, body: { hash: otherHash, on: true } });
  eq([r.status, r.data.error], [400, 'name_required'], '沒有暱稱不能投票');
  r = await albumApi('POST', '/vote', { body: { hash: otherHash, on: true } });
  ok(r.status === 400, '沒有身分不能投票');
  r = await albumApi('POST', '/me', { dev: D1, body: { name: '  小林\n' } });
  eq([r.status, r.data.me.name, r.data.me.needs_name], [200, '小林', false], '設定暱稱（去空白換行）');
  r = await albumApi('POST', '/vote', { dev: D1, body: { hash: otherHash, on: true } });
  ok(r.status === 200 && r.data.me.picks.includes(otherHash) && r.data.mine === false, '投票成功');
  r = await albumApi('POST', '/vote', { dev: D1, body: { hash: b.hash, on: true } });
  eq([r.status, r.data.error], [409, 'limit_reached'], '超過每人上限（1 張）→ 409');
  r = await albumApi('POST', '/vote', { dev: D1, body: { hash: ownHash, on: true } });
  ok(r.status === 200 && r.data.mine === true && r.data.me.self.includes(ownHash) && r.data.me.picks.length === 1, '選自己拍的不佔名額');
  r = await albumApi('POST', '/vote', { dev: D2, body: { hash: ownHash, on: true, name: '阿哲' } });
  ok(r.status === 200 && r.data.me.name === '阿哲', '投票時一起帶暱稱');
  r = await albumApi('GET', '/info', { dev: D2 });
  eq([r.data.album.votes_visible, r.data.photos.find((p) => p.hash === ownHash).votes], [true, 2], 'show_votes=live 顯示票數（含自選）');
  r = await albumApi('POST', '/vote', { dev: D2, body: { hash: 'f'.repeat(64), on: true } });
  ok(r.status === 404, '不在相簿的照片不能投');
  r = await api('GET', `/api/admin/${id}/album`, { token: tok });
  const row = r.data.ranking.find((x) => x.hash === ownHash);
  eq([row.votes, row.self, r.data.stats.voters, r.data.stats.total_votes, r.data.stats.self_votes], [2, 1, 2, 3, 1], '主辦者排行：票數、自選、統計');
  r = await mineApi('GET', '', D1);
  eq(r.data.photos.find((p) => p.hash === ownHash).votes, 2, '攝影師在「我上傳的照片」看到票數');

  // 票數顯示時機
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { show_votes: 'after' } } });
  r = await albumApi('GET', '/info', { dev: D2 });
  ok(r.data.album.votes_visible === false && !('votes' in r.data.photos[0]), 'show_votes=after 投票中不顯示票數');

  // 不想入鏡
  r = await albumApi('POST', '/optout', { dev: D2, body: { hash: otherHash } });
  ok(r.status === 200, '回報不想入鏡');
  r = await albumApi('GET', '/info', { dev: D2 });
  ok(!r.data.photos.some((p) => p.hash === otherHash), '回報後先從相簿隱藏');
  r = await fetch(`${BASE}/api/a/${acode}/thumb/${otherHash}`);
  ok(r.status === 404, '隱藏的照片縮圖 404');
  r = await api('GET', `/api/admin/${id}/album`, { token: tok });
  ok(r.data.optouts.length === 1 && r.data.optouts[0].name === '阿哲' && r.data.stats.hidden === 1, '主辦者看到待處理（含提出者暱稱）');
  r = await api('POST', `/api/admin/${id}/album/optout`, { token: tok, body: { hash: otherHash, action: 'keep' } });
  r = await albumApi('GET', '/info');
  ok(r.data.photos.some((p) => p.hash === otherHash), '保留後恢復顯示');
  await albumApi('POST', '/optout', { dev: D2, body: { hash: reup.hash } });
  r = await api('POST', `/api/admin/${id}/album/optout`, { token: tok, body: { hash: reup.hash, action: 'exclude' } });
  m = await manifest();
  ok(m.excluded.includes(reup.hash), '選「排除這張」後同步時排除');

  // MV 優先
  r = await api('POST', `/api/admin/${id}/album/priority`, { token: tok, body: { top_per_segment: 3 } });
  ok(r.status === 200 && r.data.mv_priority.includes(ownHash) && r.data.mv_priority.includes(otherHash), '每個環節前 N 名一鍵標記');
  r = await api('POST', `/api/admin/${id}/album/priority`, { token: tok, body: { hashes: [otherHash], on: false } });
  ok(!r.data.mv_priority.includes(otherHash), '取消單張 MV 優先');
  m = await manifest();
  const mo = m.photos.find((p) => p.hash === ownHash);
  eq([mo.priority, mo.votes], [true, 1], 'manifest 帶 MV 優先與票數（不含自選）');
  r = await api('POST', `/api/admin/${id}/album/priority`, { token: tok, body: { hashes: ['xyz'], on: true } });
  ok(r.status === 400, 'priority 參數錯誤 → 400');

  // 圖片
  r = await fetch(`${BASE}/api/a/${acode}/thumb/${ownHash}`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', '相簿縮圖');
  r = await fetch(`${BASE}/api/a/${acode}/photo/${ownHash}?download=1`);
  ok(r.status === 403, '未開放下載 → 403');
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { allow_download: true } } });
  r = await fetch(`${BASE}/api/a/${acode}/photo/${ownHash}?download=1`);
  ok(r.status === 200 && /attachment/.test(r.headers.get('content-disposition') || ''), '開放後可下載原檔');

  // 頁面與預覽
  pg = await getPage(aurl);
  ok(pg.status === 200 && metaOf(pg.html, 'og:title') === '相簿測試 活動相簿' && metaOf(pg.html, 'og:image').endsWith(`/og/a/${acode}`), '/a/{code} 預覽 meta');
  ok(!pg.html.includes(up), '相簿頁不含上傳碼');
  r = await fetch(`${BASE}/og/a/${acode}`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', '/og/a/{code} 回預覽圖');

  // 密碼
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { access: 'password' } } });
  ok(r.status === 400, '選密碼但沒設密碼 → 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { access: 'password', password: 'abc' } } });
  ok(r.status === 400, '密碼太短 → 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { access: 'password', password: 'tree1234' } } });
  ok(r.status === 200 && r.data.config.album.has_password === true, '設定相簿密碼');
  r = await albumApi('GET', '/info');
  eq([r.status, r.data.error], [401, 'album_password'], '沒密碼 → 401');
  r = await albumApi('GET', '/info', { headers: { 'x-album-pass': 'wrong' } });
  ok(r.status === 401, '密碼錯 → 401');
  r = await albumApi('GET', '/info', { headers: { 'x-album-pass': 'tree1234' } });
  ok(r.status === 200 && /^[0-9a-f]{32}$/.test(r.data.key), '密碼對 → 200 並發鑰匙');
  const key = r.data.key;
  r = await albumApi('GET', '/info', { headers: { 'x-album-key': key } });
  ok(r.status === 200, '鑰匙可用');
  r = await fetch(`${BASE}/api/a/${acode}/thumb/${ownHash}?k=${key}`);
  ok(r.status === 200, '縮圖用 ?k= 鑰匙');
  r = await fetch(`${BASE}/api/a/${acode}/thumb/${ownHash}`);
  ok(r.status === 401, '縮圖沒鑰匙 → 401');
  pg = await getPage(aurl);
  ok(metaOf(pg.html, 'og:title') === '活動相簿', '非公開相簿的預覽不帶活動名稱');

  // Google 登入
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { access: 'google' } } });
  r = await albumApi('GET', '/info');
  eq([r.status, r.data.error], [401, 'login_required'], '需登入 → 401');
  r = await jU.get(`/api/a/${acode}/info`);
  ok(r.status === 200 && r.data.me.kind === 'google' && r.data.me.needs_name === false, '登入後可看，身分為 google');
  r = await jU.post(`/api/a/${acode}/vote`, { hash: otherHash, on: true }, { origin: 'https://evil.example' });
  ok(r.status === 403, '登入投票需同源');
  r = await jU.post(`/api/a/${acode}/vote`, { hash: otherHash, on: true });
  ok(r.status === 200 && r.data.me.name === U.name, '登入投票用 Google 名字');

  // 截止、精選、換連結、關閉
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { access: 'link', closes_at: new Date(Date.now() - 60000).toISOString() } } });
  r = await albumApi('POST', '/vote', { dev: D2, body: { hash: otherHash, on: true } });
  eq([r.status, r.data.error], [403, 'voting_closed'], '截止後不能投票');
  r = await albumApi('GET', '/info');
  ok(r.data.album.voting_open === false && r.data.album.votes_visible === true && typeof r.data.photos[0].votes === 'number', '截止後顯示票數（after）');
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { source: 'picked', closes_at: null } } });
  r = await albumApi('GET', '/info');
  eq(r.data.photos.length, 0, '只放精選時預設沒有照片');
  r = await api('POST', `/api/admin/${id}/album/pick`, { token: tok, body: { hashes: [ownHash], on: true } });
  r = await albumApi('GET', '/info');
  eq(r.data.photos.map((p) => p.hash), [ownHash], '放進相簿後出現');
  r = await api('POST', `/api/admin/${id}/album/code`, { token: tok });
  ok(r.status === 200 && r.data.album_url !== aurl, '重設相簿連結');
  r = await albumApi('GET', '/info');
  ok(r.status === 404, '舊相簿連結失效');
  aurl = (await api('GET', `/api/admin/${id}`, { token: tok })).data.album_url;
  acode = aurl.split('/')[2];
  r = await albumApi('GET', '/info');
  ok(r.status === 200, '新連結可用');
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { enabled: false } } });
  r = await albumApi('GET', '/info');
  ok(r.status === 404, '關閉相簿後連結 404');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { album: { limit: 99 } } });
  ok(r.status === 400, 'limit 超出範圍 → 400');
  r = await api('POST', `/api/admin/${id}/album/code`, {});
  ok(r.status === 401, '沒有管理權限不能重設相簿連結');
}

// ================= 多日活動 =================
async function multiDayTests() {
  const { parseSchedule, segmentOf, parseDayHeader, dateRangeText, derive } = await import('../src/config.js');
  let r;
  console.log('[多日活動：解析（單元）]');
  const segs = parseSchedule('11/20（六）\n09:00-10:00 報到\n10:00-12:00 闖關\n\n11/21（日）\n09:00-10:00 早操\n10:00-11:00 闖關', '2026-11-20');
  eq(segs.map((s) => [s.name, s.title, s.day, s.date]), [
    ['第1天・報到', '報到', 1, '2026-11-20'], ['第1天・闖關', '闖關', 1, '2026-11-20'],
    ['第2天・早操', '早操', 2, '2026-11-21'], ['第2天・闖關', '闖關', 2, '2026-11-21'],
  ], '日期標題分天、名稱加「第N天・」、同名環節各天分開');
  eq(parseSchedule('Day 1\n09:00-10:00 報到\nDay 2\n09:00-10:00 報到', '2026-12-31').map((s) => s.date), ['2026-12-31', '2027-01-01'], 'Day N 依開始日期換算（跨年）');
  eq(parseSchedule('Day 1\n09:00-10:00 報到\n第二天\n09:00-10:00 報到').map((s) => [s.name, s.date]), [['第1天・報到', null], ['第2天・報到', null]], '沒有開始日期時 date=null');
  eq(parseSchedule('09:00-10:00 報到\n11/21\n09:00-10:00 報到', '2026-11-20').map((s) => s.name), ['第1天・報到', '第2天・報到'], '標題前的環節算第 1 天');
  eq(parseSchedule('11/20\n09:00-10:00 報到\n10:00-11:00 闖關').map((s) => [s.name, s.day, s.date]), [['報到', null, null], ['闖關', null, null]], '只有一天時維持單日格式');
  eq(parseSchedule('Day 1\nDay 2\n09:00-10:00 報到\nDay 3\n09:00-10:00 報到').map((s) => s.day), [2, 3], '連續標題沿用最後一個');
  eq(['1.5 公里', '3.2 注意事項', '11-20', '12:00-13:00 午餐'].map((l) => parseDayHeader(l, '2026-11-20')), [null, null, null, null], '不把小數、時段當成日期標題');
  eq(['2026年11月20日 星期五', 'D3 戶外日', '第十二天', '【11/21】'].map((l) => parseDayHeader(l, '2026-11-20')?.date), ['2026-11-20', '2026-11-22', '2026-12-01', '2026-11-21'], '各種日期標題寫法');
  eq([
    segmentOf({ exif_time: '2026-11-21T10:30:00' }, segs), segmentOf({ exif_time: '2026-11-20T10:30:00' }, segs),
    segmentOf({ exif_time: '2026-11-22T10:30:00' }, segs), segmentOf({ segment: '第1天・報到', exif_time: '2026-11-21T10:30:00' }, segs),
  ], ['第2天・闖關', '第1天・闖關', null, '第1天・報到'], '依拍攝日期＋時間分到正確的天；不在活動日 → 未分類；手動選的優先');
  const noDate = parseSchedule('Day 1\n09:00-10:00 報到\nDay 2\n09:00-10:00 早操\n13:00-14:00 午後');
  eq([segmentOf({ exif_time: '2026-11-21T09:30:00' }, noDate), segmentOf({ exif_time: '2026-11-21T13:30:00' }, noDate)], [null, '第2天・午後'], '沒有日期：多天同時段無法判斷，唯一時段仍可判斷');
  eq([dateRangeText({ date: '2026-11-20', end_date: '2026-11-22' }), dateRangeText({ date: '2026-12-31', end_date: '2027-01-02' }), dateRangeText({ date: '2026-11-20', end_date: null })],
    ['2026/11/20–11/22', '2026/12/31–2027/01/02', '2026/11/20'], '日期區間顯示');

  console.log('[多日活動：API]');
  r = await api('POST', '/api/create', { headers: { 'x-create-secret': SECRET }, body: { name: '三天兩夜營', date: '2026-11-20', end_date: '2026-11-18' } });
  ok(r.status === 400, '結束日期早於開始 → 400');
  r = await api('POST', '/api/create', { headers: { 'x-create-secret': SECRET }, body: { name: '三天兩夜營', end_date: '2026-11-22' } });
  ok(r.status === 400, '有結束日期沒有開始日期 → 400');
  const ev = (await api('POST', '/api/create', { headers: { 'x-create-secret': SECRET }, body: { name: '三天兩夜營', date: '2026-11-20', end_date: '2026-11-22' } })).data;
  const id = ev.event_id; const tok = ev.admin_code;
  r = await api('GET', `/api/admin/${id}`, { token: tok });
  eq([r.data.config.basic.date, r.data.config.basic.end_date], ['2026-11-20', '2026-11-22'], '建立時保存結束日期');
  ok(r.data.invite_effective.message.includes('2026/11/20–11/22'), '自動邀請文字顯示日期區間');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { basic: { end_date: '2026-11-19' } } });
  ok(r.status === 400, 'PATCH 結束日期早於開始 → 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { basic: { end_date: '2027-03-01' } } });
  ok(r.status === 400, '超過 60 天 → 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: {
    groups: ['A隊'], upload: { mode: 'open' },
    schedule_text: 'Day 1\n09:00-10:00 報到\n10:00-12:00 闖關\nDay 2\n09:00-10:00 晨操\n10:00-12:00 闖關\nDay 3\n09:00-10:00 成果發表',
  } });
  eq(r.data.config.segments.map((s) => [s.name, s.date]), [['第1天・報到', '2026-11-20'], ['第1天・闖關', '2026-11-20'], ['第2天・晨操', '2026-11-21'], ['第2天・闖關', '2026-11-21'], ['第3天・成果發表', '2026-11-22']], 'PATCH 流程表依開始日期算出每天日期');
  ok(r.data.config.shots.length === 5 && r.data.config.shots.some((s) => s.segment === '第2天・闖關'), '拍攝清單每天各自一項');
  const up = r.data.config.upload_code;
  for (const [tag, t] of [['d1', '2026-11-20T10:30:00'], ['d2', '2026-11-21T10:30:00'], ['d2b', '2026-11-21T11:00:00'], ['out', '2026-11-25T10:30:00']]) {
    await uploadPhoto(up, { bytes: makeJpeg('multi-' + tag), meta: { exif_time: t, device: 'dev-multiday-000000001' } });
  }
  r = await api('GET', `/api/u/${up}/info`);
  const bs = Object.fromEntries(r.data.progress.by_segment.map((s) => [s.name, s.have]));
  eq([bs['第1天・闖關'], bs['第2天・闖關'], r.data.progress.unclassified], [1, 2, 1], '照片依拍攝日期分到各天（活動外日期 → 未分類）');
  ok(r.data.event.end_date === '2026-11-22' && r.data.segments[2].day === 2 && r.data.segments[2].title === '晨操', '上傳頁 info 帶結束日期與每天分組資料');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { basic: { date: '2026-11-21', end_date: '2026-11-23' } } });
  eq(r.data.config.segments.map((s) => s.date), ['2026-11-21', '2026-11-21', '2026-11-22', '2026-11-22', '2026-11-23'], '改開始日期後 Day N 的日期跟著變');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { basic: { end_date: '2026-11-21' } } });
  ok(r.data.config.basic.end_date === null, '結束日期＝開始日期 → 視為單日');
  const sk = (await api('POST', `/api/admin/${id}/sync-key`, { token: tok })).data.sync_key;
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { basic: { end_date: '2026-11-23' } } });
  r = await api('GET', `/api/sync/${id}/manifest`, { token: sk });
  ok(r.data.event.end_date === '2026-11-23' && r.data.segments.every((s) => s.day && s.date && s.title), 'manifest 帶結束日期與每天的環節資料');

  // 補傳期以最後一天判斷
  const base = { basic: { date: '2026-11-20', end_date: '2026-11-22' }, upload: { mode: 'open', opens_at: null, closes_at: null }, segments: [], deleted_at: null };
  eq([derive(base, Date.parse('2026-11-21T12:00:00Z')).stage, derive(base, Date.parse('2026-11-23T12:00:00Z')).stage], ['open', 'grace'], '多日活動進行中是募集中，最後一天之後才是補傳期');
}

// ================= 輪站課程 =================
async function rotationTests() {
  let r;
  console.log('[輪站課程]');
  const ev = await createEvent('輪站營', '2026-11-20');
  const id = ev.event_id; const tok = ev.admin_code; const up = ev.upload_code;
  const G = ['一小隊', '二小隊', '三小隊', '四小隊', '五小隊', '六小隊'];
  const f = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const slots = [0, 1, 2, 3, 4, 5].map((i) => ({ start: f(570 + i * 30), end: f(595 + i * 30) })); // 09:30 起每段 25 分、換站 5 分
  const stations = ['水火箭', '木工', '科學魔術', '植物拓印', '團隊默契'].map((name) => ({ name, place: '操場' }));
  const rows = G.map((group, g) => ({ group, cells: slots.map((_, t) => { const k = (g + t) % 6; return k < 5 ? k : -1; }) }));
  const rot = { title: '上午輪站', slots, stations, rows, bye_mode: 'free' };
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { groups: G, upload: { mode: 'open' }, schedule_text: '09:00-09:30 報到\n09:30-12:25 輪站時間\n12:25-13:30 午餐' } });
  const bad = async (patch, name) => { const x = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { rotations: [{ ...rot, ...patch }] } }); ok(x.status === 400, name, x.data); };
  await bad({ stations: [{ name: 'A' }, { name: 'A' }] }, '關卡名稱重複 → 400');
  await bad({ stations: [{ name: '自由活動' }, { name: 'B' }] }, '關卡不能叫自由活動 → 400');
  await bad({ slots: [{ start: '10:00', end: '09:00' }] }, '時段開始晚於結束 → 400');
  await bad({ slots: [{ start: '09:00', end: '10:00' }, { start: '09:30', end: '10:30' }] }, '時段重疊 → 400');
  await bad({ rows: [{ group: '一小隊', cells: [0, 1] }] }, '格數與時段數不符 → 400');
  await bad({ rows: [{ group: '一小隊', cells: [9, 0, 0, 0, 0, 0] }] }, '不存在的關卡索引 → 400');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { rotations: [{ ...rot, rows: [...rows, { group: '外星隊', cells: [0, 0, 0, 0, 0, 0] }] }] } });
  ok(r.status === 200 && r.data.config.rotations[0].rows.length === 6 && r.data.config.rotations[0].id, '儲存輪站表（不存在的小隊列略過、自動給 id）');
  const segs = r.data.config.segments;
  eq(segs.map((s) => [s.name, s.kind || '']), [['報到', ''], ['輪站時間', ''], ['水火箭', 'station'], ['木工', 'station'], ['科學魔術', 'station'], ['植物拓印', 'station'], ['團隊默契', 'station'], ['自由活動', 'free'], ['午餐', '']], '關卡與自由活動展開成環節');
  ok(r.data.config.shots.some((x) => x.segment === '木工' && x.target === 8) && r.data.config.shots.some((x) => x.segment === '自由活動' && x.target === 3), '拍攝清單：每個關卡一項、自由活動 3 張');
  r = await api('GET', `/api/u/${up}/info`);
  ok(r.data.rotations.length === 1 && r.data.rotations[0].free_segment === '自由活動' && r.data.rotations[0].stations[1].segment === '木工', '上傳頁 info 帶輪站表');

  const D = 'dev-rotation-0000000001';
  const shot = async (tag, t, meta) => (await uploadPhoto(up, { bytes: makeJpeg('rot-' + tag), meta: { device: D, exif_time: `2026-11-20T${t}:00`, ...meta } })).hash;
  await shot('a', '10:05', { groups: ['二小隊'] }); // 第 2 段：二小隊 (1+1)%6=2 → 科學魔術
  await shot('b', '10:27', { groups: ['二小隊'] }); // 換站時間算前一段 → 科學魔術
  await shot('c', '09:35', { groups: ['六小隊'] }); // 第 1 段：六小隊 k=5 → 輪空 → 自由活動
  const hFixed = await shot('d', '10:10', { segment: '木工' }); // 守在木工、沒勾小隊 → 反推 第 2 段 (g+1)%6=1 → 一小隊
  await shot('e', '10:10', {}); // 沒小隊沒關卡 → 退回「輪站時間」
  await shot('f', '10:10', { groups: ['一小隊', '二小隊'] }); // 兩隊不同關 → 退回「輪站時間」
  await shot('g', '09:10', {}); // 報到
  r = await api('GET', `/api/admin/${id}`, { token: tok });
  const bs = Object.fromEntries(r.data.stats.by_segment.map((x) => [x.name, x.have]));
  eq([bs['科學魔術'], bs['自由活動'], bs['木工'], bs['輪站時間'], bs['報到']], [2, 1, 1, 2, 1], '依小隊＋時段歸到關卡（含換站時間、輪空、無法判斷退回整段環節）');
  const rs = r.data.stats.rotations[0];
  ok(rs.counts[1][2] === 2 && rs.counts[0][1] === 1 && rs.free[5] === 1 && rs.pending === 2, '管理頁輪站熱度表：counts、自由活動、待分關卡', rs);
  const ph = (await api('GET', `/api/admin/${id}/photos`, { token: tok })).data.photos.find((x) => x.hash === hFixed);
  eq(ph.groups, ['一小隊'], '守在某一關：依時段反推小隊並記錄');
  let m = (await api('GET', `/api/sync/${id}/manifest`, { token: (await api('POST', `/api/admin/${id}/sync-key`, { token: tok })).data.sync_key })).data;
  ok(m.rotations.length === 1 && m.rotations[0].rows.length === 6 && m.segments.some((x) => x.kind === 'station'), 'manifest 帶輪站表與關卡環節');

  // 我上傳的照片：改成某一關、沒有小隊 → 反推
  const hE = sha(makeJpeg('rot-e'));
  r = await api('PATCH', `/api/u/${up}/mine/${hE}`, { headers: { 'x-device': D }, body: { segment: '植物拓印' } });
  eq([r.status, r.data.groups], [200, ['三小隊']], '修改環節為關卡時反推小隊（第 2 段植物拓印＝三小隊）');

  // 輪空改為不歸類
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { rotations: [{ ...rot, bye_mode: 'skip' }] } });
  ok(!r.data.config.segments.some((x) => x.kind === 'free'), 'bye_mode=skip 時沒有自由活動環節');
  ok(!r.data.stats.by_segment.some((x) => x.name === '自由活動') && r.data.stats.unclassified >= 1, '輪空照片改為未分類');

  // 小隊刪除：該列忽略
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { groups: G.slice(0, 5) } });
  ok(r.data.config.rotations[0].rows.length === 6 && r.data.stats.rotations[0].groups.length === 5, '刪除小隊後輪站表保留資料，但統計只算現有小隊');
  ok(!r.data.config.segments.some((x) => x.kind === 'free'), '五隊五關沒有輪空');

  // 多日：第 2 天的輪站不影響第 1 天
  await api('PATCH', `/api/admin/${id}`, { token: tok, body: { groups: G, basic: { end_date: '2026-11-21' }, rotations: [{ ...rot, day: 2 }] } });
  r = await api('GET', `/api/admin/${id}`, { token: tok });
  ok(r.data.config.segments.some((x) => x.name === '第2天・水火箭' && x.date === '2026-11-21'), '多日活動的輪站關卡加「第N天・」與日期');
  ok(!r.data.stats.by_segment.some((x) => x.name === '第2天・科學魔術' && x.have > 0), '第 1 天的照片不會歸到第 2 天的輪站');
  r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { rotations: [] } });
  ok(!r.data.config.segments.some((x) => x.kind), '刪除輪站後關卡環節移除');

  console.log('[輪站課程：時段取自流程表]');
  const ev2 = await createEvent('節次營', '2026-11-20');
  const id2 = ev2.event_id; const tok2 = ev2.admin_code;
  await api('PATCH', `/api/admin/${id2}`, { token: tok2, body: { groups: ['A隊', 'B隊'], upload: { mode: 'open' }, schedule_text: '09:00-09:50 第一節\n10:00-10:50 第二節\n12:00-13:00 午餐' } });
  const linked = { title: '節次輪站', slots: [{ start: '09:00', end: '09:50', seg: '第一節' }, { start: '10:00', end: '10:50', seg: '第二節' }], stations: [{ name: '甲' }, { name: '乙' }], rows: [{ group: 'A隊', cells: [0, 1] }, { group: 'B隊', cells: [1, 0] }] };
  r = await api('PATCH', `/api/admin/${id2}`, { token: tok2, body: { rotations: [linked] } });
  eq(r.data.config.rotations[0].slots.map((x) => x.seg), ['第一節', '第二節'], '保存時段來源（流程表環節）');
  ok(r.data.config.segments.find((x) => x.name === '第一節').rotation_slot === r.data.config.rotations[0].id, '被選用的流程環節標記 rotation_slot');
  ok(!r.data.config.shots.some((x) => x.segment === '第一節') && r.data.config.shots.some((x) => x.segment === '甲'), '被選用的流程環節不另產生拍攝清單，由關卡負責');
  r = await api('PATCH', `/api/admin/${id2}`, { token: tok2, body: { schedule_text: '09:10-10:00 第一節\n10:10-11:00 第二節\n12:00-13:00 午餐' } });
  eq(r.data.config.rotations[0].slots.map((x) => `${x.start}-${x.end}`), ['09:10-10:00', '10:10-11:00'], '改流程表時間，輪站時段跟著更新');
  ok(r.data.config.segments.find((x) => x.name === '甲').start === '09:10', '關卡環節的時間範圍也更新');
  const up2 = ev2.upload_code;
  await uploadPhoto(up2, { bytes: makeJpeg('link-a'), meta: { groups: ['A隊'], exif_time: '2026-11-20T10:30:00' } });
  await uploadPhoto(up2, { bytes: makeJpeg('link-b'), meta: { exif_time: '2026-11-20T10:30:00' } });
  r = await api('GET', `/api/admin/${id2}`, { token: tok2 });
  const b2 = Object.fromEntries(r.data.stats.by_segment.map((x) => [x.name, x.have]));
  eq([b2['乙'], b2['第二節']], [1, 1], '有小隊歸到關卡；沒小隊歸到那一節（收容）');
  r = await api('PATCH', `/api/admin/${id2}`, { token: tok2, body: { schedule_text: '12:00-13:00 午餐' } });
  eq(r.data.config.rotations[0].slots.map((x) => `${x.start}-${x.end}`), ['09:10-10:00', '10:10-11:00'], '流程表刪掉該環節時沿用上次時間');

  console.log('[輪站課程：跨日]');
  const ev3 = (await api('POST', '/api/create', { headers: { 'x-create-secret': SECRET }, body: { name: '兩天營', date: '2026-11-20', end_date: '2026-11-21' } })).data;
  const id3 = ev3.event_id; const tok3 = ev3.admin_code;
  await api('PATCH', `/api/admin/${id3}`, { token: tok3, body: { groups: ['A隊', 'B隊', 'C隊'], upload: { mode: 'open' }, schedule_text: '11/20\n09:00-10:00 報到\n14:00-14:50 下午第一節\n15:00-15:50 下午第二節\n11/21\n09:00-09:50 上午第一節\n10:00-11:00 閉幕' } });
  const cross = {
    title: '兩天輪站',
    slots: [{ start: '14:00', end: '14:50', day: 1, seg: '第1天・下午第一節' }, { start: '15:00', end: '15:50', day: 1, seg: '第1天・下午第二節' }, { start: '09:00', end: '09:50', day: 2, seg: '第2天・上午第一節' }],
    stations: [{ name: '甲' }, { name: '乙' }, { name: '丙' }],
    rows: [{ group: 'A隊', cells: [0, 1, 2] }, { group: 'B隊', cells: [1, 2, 0] }, { group: 'C隊', cells: [2, 0, 1] }],
  };
  r = await api('PATCH', `/api/admin/${id3}`, { token: tok3, body: { rotations: [{ ...cross, slots: [cross.slots[2], cross.slots[0]] }] } });
  ok(r.status === 400, '跨日時段需依日期排列 → 400');
  r = await api('PATCH', `/api/admin/${id3}`, { token: tok3, body: { rotations: [cross] } });
  ok(r.status === 200 && r.data.config.rotations[0].day === null, '跨日輪站：區塊 day 為 null、每段各有 day');
  const st3 = r.data.config.segments.filter((x) => x.kind === 'station');
  eq([st3.map((x) => x.name), st3[0].days, st3[0].date], [['甲', '乙', '丙'], [1, 2], null], '跨日輪站的關卡不加「第N天・」，跨天共用');
  const up3 = ev3.upload_code;
  await uploadPhoto(up3, { bytes: makeJpeg('x-d1'), meta: { groups: ['A隊'], exif_time: '2026-11-20T14:30:00' } }); // 第 1 天第 1 段 → 甲
  await uploadPhoto(up3, { bytes: makeJpeg('x-d2'), meta: { groups: ['A隊'], exif_time: '2026-11-21T09:30:00' } }); // 第 2 天第 3 段 → 丙
  await uploadPhoto(up3, { bytes: makeJpeg('x-d2b'), meta: { groups: ['A隊'], exif_time: '2026-11-21T14:30:00' } }); // 第 2 天下午沒有輪站 → 未分類
  r = await api('GET', `/api/admin/${id3}`, { token: tok3 });
  const b3 = Object.fromEntries(r.data.stats.by_segment.map((x) => [x.name, x.have]));
  eq([b3['甲'], b3['丙'], r.data.stats.unclassified], [1, 1, 1], '依拍攝日期找到跨日輪站的那一段');
  ok(r.data.stats.rotations[0].days.join() === '1,2' && r.data.stats.rotations[0].slots[2].date === '2026-11-21', '統計帶每段日期');
  r = await api('GET', `/api/u/${up3}/info`);
  ok(r.data.rotations[0].days.join() === '1,2' && r.data.rotations[0].slots[0].date === '2026-11-20', '上傳頁 info 帶跨日時段');
  r = await api('PATCH', `/api/admin/${id3}`, { token: tok3, body: { rotations: [{ ...cross, slots: cross.slots.map((x) => ({ ...x, day: 2, seg: undefined, start: x.start === '09:00' ? '16:00' : x.start, end: x.end === '09:50' ? '16:50' : x.end })) }] } });
  ok(r.data.config.segments.some((x) => x.name === '第2天・甲'), '全部時段在同一天時，關卡加「第N天・」');
}

main().catch((e) => { console.error('測試異常', e); process.exit(1); });

// ================= 貼共用連結匯入（Google 相簿／雲端硬碟）=================
// 用本機假伺服器模擬 Google（.dev.vars 的 IMPORT_TEST_ORIGIN 讓 Worker 把 https://{google 網域}/… 改連 http://127.0.0.1:8799/{網域}/…）
async function importTests() {
  const http = await import('node:http');
  const { classifyUrl, parseAlbumHtml } = await import('../src/importer.js');
  console.log('[連結匯入]');
  // ---- 單元：連結辨識 ----
  eq(classifyUrl('https://photos.app.goo.gl/AbCdEf123')?.source, 'gphotos', '短網址 → Google 相簿');
  eq(classifyUrl('https://photos.google.com/share/AF1QipX?key=abc')?.source, 'gphotos', 'share 網址 → Google 相簿');
  eq(classifyUrl('https://photos.google.com/photo/AF1QipX'), null, '個人相片網址（非分享）→ 不支援');
  eq(classifyUrl('https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing&resourcekey=0-xyz'), { source: 'gdrive', kind: 'folder', id: '1AbCdEfGhIjK', rk: '0-xyz' }, '雲端硬碟資料夾（含 resourcekey）');
  eq(classifyUrl('https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjK')?.kind, 'folder', '雲端硬碟資料夾（/u/1/）');
  eq(classifyUrl('https://drive.google.com/file/d/1ZyXwVuTsRqP/view?usp=drive_link')?.kind, 'file', '雲端硬碟單檔');
  eq(classifyUrl('https://drive.google.com/open?id=1ZyXwVuTsRqP')?.kind, 'unknown', 'open?id= 舊格式');
  eq(classifyUrl('http://photos.app.goo.gl/x'), null, '非 https → 拒絕');
  eq(classifyUrl('https://evil.example.com/share/x'), null, '非 Google 網域 → 拒絕');

  const T0 = Date.UTC(2026, 10, 20, 1, 30, 0); // = 台灣 09:30
  const lh = (k) => `https://lh3.googleusercontent.com/pw/${k}`;
  const item = (uid, k, t, video) => [uid, [lh(k), 4000, 3000], t, 'x', null, t + 1000, ...(video ? [{ 76647426: [[1]] }] : [{}])];
  const page1 = [null, [item('U1', 'K1', T0), item('U2', 'K2', T0 + 600000), item('UV', 'KV', T0, true)], 'TOKEN2', ['ALB1', '營隊精選']];
  const albumHtml = `<html><head><meta property="og:title" content="營隊精選 · 2026年11月20日"><link rel="canonical" href="https://photos.google.com/share/ALB1?key=KEY1"></head><body>`
    + `<script nonce="n">AF_initDataCallback({key: 'ds:0', hash: '1', data:[1,"a]b\\"c"], sideChannel: {}});</script>`
    + `<script nonce="n">AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify(page1)}, sideChannel: {}});</script></body></html>`;
  // ---- 單元：相簿頁解析 ----
  const pa = parseAlbumHtml(albumHtml, 'https://photos.google.com/share/ALB1?key=KEY1');
  ok(pa.albumId === 'ALB1' && pa.key === 'KEY1' && pa.token === 'TOKEN2' && pa.title === '營隊精選' && pa.items.length === 3 && pa.items[2].isVideo && pa.items[0].base === lh('K1'), '解析相簿頁：id、key、續頁 token、標題、影片標記');
  let threw = null;
  try { parseAlbumHtml('<html>nothing</html>', 'https://photos.google.com/share/x'); } catch (e) { threw = e.code; }
  eq(threw, 'album_parse_failed', '格式不符 → album_parse_failed');

  const page2 = JSON.stringify([null, [item('U3', 'K3', T0 + 1200000), item('U1', 'K1', T0)], null]);
  const batchBody = `)]}'\n\n[["wrb.fr","snAcKc",${JSON.stringify(page2)},null,null,null,"generic"]]\n`;
  const imgFor = (k) => makeJpeg('import-' + k);
  const stats = { batch: 0, media: 0, lh3: [], keys: new Set(), rk: [] };
  const driveFiles = {
    FOLDER0001: { id: 'FOLDER0001', name: '攝影組上傳', mimeType: 'application/vnd.google-apps.folder' },
    SUBFOLD001: { id: 'SUBFOLD001', name: '第二天', mimeType: 'application/vnd.google-apps.folder' },
    FILE000001: { id: 'FILE000001', name: 'DSC_0001.JPG', mimeType: 'image/jpeg', size: '1200', imageMediaMetadata: { time: '2026:11:20 10:15:00', width: 6000, height: 4000 }, thumbnailLink: 'https://lh3.googleusercontent.com/pw/DTHUMB1=s220' },
    FILE000002: { id: 'FILE000002', name: 'DSC_0002.JPG', mimeType: 'image/jpeg', size: String(80 * 1024 * 1024), imageMediaMetadata: { time: '2026:11:20 10:20:00' } },
    FILE000003: { id: 'FILE000003', name: 'IMG_9.JPG', mimeType: 'image/jpeg', size: '900', resourceKey: '0-sub' },
    PRIVATE001: null,
  };
  const children = { FOLDER0001: ['FILE000001', 'FILE000002', 'SUBFOLD001'], SUBFOLD001: ['FILE000003'] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body, h = {}) => { res.writeHead(code, { 'content-type': type, ...h }); res.end(body); };
    const p = u.pathname;
    if (p === '/photos.app.goo.gl/SHORT1') {
      if (u.searchParams.get('_imcp') !== '1') return send(200, 'text/html', '<html>interstitial</html>');
      return send(302, 'text/html', '', { location: 'https://photos.google.com/share/ALB1?key=KEY1' });
    }
    if (p === '/photos.app.goo.gl/EVIL1') return send(302, 'text/html', '', { location: 'https://accounts.google.com/ServiceLogin' });
    if (p === '/photos.google.com/share/ALB1') return send(200, 'text/html; charset=utf-8', albumHtml);
    if (p === '/photos.google.com/share/GONE') return send(404, 'text/html', 'no');
    if (p === '/photos.google.com/_/PhotosUi/data/batchexecute') {
      stats.batch++;
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const f = JSON.parse(new URLSearchParams(b).get('f.req'));
        const args = JSON.parse(f[0][0][1]);
        if (args[0] !== 'ALB1' || args[1] !== 'TOKEN2' || args[3] !== 'KEY1') return send(400, 'text/plain', 'bad');
        send(200, 'application/json', batchBody);
      });
      return;
    }
    if (p.startsWith('/lh3.googleusercontent.com/pw/')) {
      const [k, size] = p.slice('/lh3.googleusercontent.com/pw/'.length).split('=');
      stats.lh3.push(`${k}=${size}`);
      if (k === 'KGONE') return send(403, 'text/html', 'no');
      return send(200, 'image/jpeg', /^(w320|s320)/.test(size || '') ? makeJpeg('thumb-' + k) : imgFor(k));
    }
    if (p.startsWith('/www.googleapis.com/drive/v3/files')) {
      stats.keys.add(u.searchParams.get('key'));
      if (req.headers['x-goog-drive-resource-keys']) stats.rk.push(req.headers['x-goog-drive-resource-keys']);
      const id = p.split('/')[5];
      if (!id) {
        const pid = /'([^']+)' in parents/.exec(u.searchParams.get('q') || '')[1];
        const files = (children[pid] || []).map((x) => driveFiles[x]).concat(pid === 'FOLDER0001' ? [{ id: 'PDF0000001', name: 'x.pdf', mimeType: 'application/pdf' }] : []);
        return send(200, 'application/json', JSON.stringify({ files }));
      }
      if (!(id in driveFiles) || !driveFiles[id]) return send(404, 'application/json', '{"error":{"code":404}}');
      if (u.searchParams.get('alt') === 'media') { stats.media++; return send(200, 'image/jpeg', imgFor('drive-' + id)); }
      return send(200, 'application/json', JSON.stringify(driveFiles[id]));
    }
    if (p === '/drive.google.com/thumbnail') {
      const sz = u.searchParams.get('sz');
      return send(200, 'image/jpeg', sz === 'w320' ? makeJpeg('dthumb-' + u.searchParams.get('id')) : imgFor('drive-big-' + u.searchParams.get('id')));
    }
    send(404, 'text/plain', 'not found');
  });
  await new Promise((r) => srv.listen(8799, '127.0.0.1', r));
  try {
    const ev = await createEvent('匯入營', '2026-11-20');
    const tok = ev.admin_code; const up = ev.upload_code; const id = ev.event_id;
    await api('PATCH', `/api/admin/${id}`, { token: tok, body: { groups: ['一小隊', '二小隊'], upload: { mode: 'open' }, schedule_text: '09:00-10:00 開幕\n10:00-12:00 闖關' } });
    let r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://example.com/x' } });
    ok(r.status === 400 && r.data.error === 'bad_source', '非 Google 連結 → 400 bad_source', r.data);
    r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://photos.app.goo.gl/EVIL1' } });
    ok(r.status === 422 && r.data.error === 'album_not_public', '短網址轉到登入頁 → 422 album_not_public', r.data);
    r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://photos.google.com/share/GONE?key=z' } });
    ok(r.status === 404 && r.data.error === 'album_not_found', '相簿不存在 → 404', r.data);

    r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://photos.app.goo.gl/SHORT1' } });
    ok(r.status === 200 && r.data.source === 'gphotos' && r.data.title === '營隊精選' && r.data.count === 3 && /^[0-9a-f]{16}$/.test(r.data.aid), '相簿短網址 → 清單（續頁合併、影片略過、重複 uid 去掉）', r.data);
    eq(r.data.items.map((x) => [x.uid, x.taken, x.have]), [['gp:U1', '2026-11-20T09:30:00', false], ['gp:U2', '2026-11-20T09:40:00', false], ['gp:U3', '2026-11-20T09:50:00', false]], '拍攝時間換成台灣時間');
    ok(stats.batch === 1 && r.data.daily_left === 1500, '有續頁 token 才呼叫 batchexecute；每日額度 1500');
    const aid = r.data.aid;
    let t = await fetch(`${BASE}/api/u/${up}/import/thumb/${aid}/gp:U2`);
    ok(t.status === 200 && Buffer.from(await t.arrayBuffer()).equals(makeJpeg('thumb-K2')), '縮圖代理（=w320-h320）');
    t = await fetch(`${BASE}/api/u/${up}/import/thumb/${aid}/gp:NOPE`);
    ok(t.status === 404, '清單外的 uid 縮圖 → 404');
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid, uid: 'gp:NOPE' } });
    ok(r.status === 404, '清單外的 uid 匯入 → 404（不能拿來代抓任意網址）');
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid: '0123456789abcdef', uid: 'gp:U1' } });
    ok(r.status === 410 && r.data.error === 'list_expired', '不存在的匯入代碼 → 410');

    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid, uid: 'gp:U1', uploader: '阿明', device: 'dev-import-1', groups: ['一小隊'] } });
    ok(r.status === 201 && r.data.hash === sha(imgFor('K1')) && r.data.duplicate === false, '匯入一張（預設長邊 2560）', r.data);
    ok(stats.lh3.includes('K1=w2560-h2560') && stats.lh3.includes('K1=w320-h320'), '取 2560 主圖＋320 縮圖');
    const h1 = r.data.hash;
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid, uid: 'gp:U2', original: true, device: 'dev-import-1' } });
    ok(r.status === 201 && stats.lh3.includes('K2=d'), '勾原圖 → =d');
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid, uid: 'gp:U1', device: 'dev-import-1' } });
    ok(r.status === 200 && r.data.duplicate === true && r.data.hash === h1, '同一張再匯入 → duplicate（依來源 uid）');
    r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://photos.app.goo.gl/SHORT1' } });
    eq(r.data.items.map((x) => x.have), [true, true, false], '重新貼同一連結：已匯入的標 have');
    const sk = (await api('POST', `/api/admin/${id}/sync-key`, { token: tok })).data.sync_key;
    r = await api('GET', `/api/sync/${id}/manifest`, { token: sk });
    const ph = r.status === 200 ? (r.data.photos || []).find((x) => x.hash === h1) : null;
    ok(ph && ph.uploader === '阿明' && ph.exif_time === '2026-11-20T09:30:00' && JSON.stringify(ph.groups) === '["一小隊"]', '同步清單含匯入的照片（上傳者、拍攝時間、小隊）', ph || r.data);
    // 每日上限
    await api('PATCH', `/api/admin/${id}`, { token: tok, body: { upload: { import_daily: 2 } } });
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid, uid: 'gp:U3', device: 'dev-import-1' } });
    ok(r.status === 429 && r.data.error === 'import_daily_limit', '超過每日匯入上限 → 429', r.data);
    r = await api('PATCH', `/api/admin/${id}`, { token: tok, body: { upload: { import_daily: 'x' } } });
    ok(r.status === 400, 'import_daily 格式錯 → 400');
    await api('PATCH', `/api/admin/${id}`, { token: tok, body: { upload: { import_daily: 1500, import_enabled: false } } });
    r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://photos.app.goo.gl/SHORT1' } });
    ok(r.status === 403 && r.data.error === 'import_disabled', '主辦關閉連結匯入 → 403');
    r = await api('GET', `/api/u/${up}/info`);
    ok(r.data.import === false, 'info 回報 import=false');
    await api('PATCH', `/api/admin/${id}`, { token: tok, body: { upload: { import_enabled: true } } });
    r = await api('GET', `/api/u/${up}/info`);
    ok(r.data.import === true && r.data.import_drive === true, 'info 回報 import=true、雲端硬碟可用');

    // ---- 雲端硬碟 ----
    r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://drive.google.com/drive/folders/PRIVATE001' } });
    ok(r.status === 422 && r.data.error === 'drive_not_public', '非公開資料夾 → 422 drive_not_public', r.data);
    r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://drive.google.com/drive/folders/FOLDER0001?usp=sharing' } });
    ok(r.status === 200 && r.data.source === 'gdrive' && r.data.title === '攝影組上傳' && r.data.count === 3, '雲端硬碟資料夾（含一層子資料夾、略過 PDF）', r.data);
    eq(r.data.items.map((x) => [x.uid, x.taken]), [['gd:FILE000001', '2026-11-20T10:15:00'], ['gd:FILE000002', '2026-11-20T10:20:00'], ['gd:FILE000003', '']], '依拍攝時間排序、EXIF 時間轉 ISO');
    ok([...stats.keys].every((k) => k === 'local-test-key'), 'Drive API 帶伺服器端金鑰');
    const daid = r.data.aid;
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid: daid, uid: 'gd:FILE000001', device: 'dev-import-1' } });
    ok(r.status === 201 && r.data.hash === sha(imgFor('drive-FILE000001')) && stats.media === 1, '小檔 → 下載原檔（alt=media）', r.data);
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid: daid, uid: 'gd:FILE000002', device: 'dev-import-1' } });
    ok(r.status === 201 && r.data.hash === sha(imgFor('drive-big-FILE000002')) && stats.media === 1, '超過大小上限 → 改取 2560 預覽', r.data);
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid: daid, uid: 'gd:FILE000003', device: 'dev-import-1' } });
    ok(r.status === 201 && stats.rk.some((x) => x.includes('FILE000003/0-sub')), '子資料夾檔案帶 resourceKey 標頭', stats.rk);
    r = await api('POST', `/api/u/${up}/import/list`, { body: { url: 'https://drive.google.com/file/d/FILE000001/view' } });
    ok(r.status === 200 && r.data.count === 1 && r.data.items[0].have === true, '雲端硬碟單檔連結、已匯入標 have');

    await api('PATCH', `/api/admin/${id}`, { token: tok, body: { upload: { mode: 'closed' } } });
    r = await api('POST', `/api/u/${up}/import/photo`, { body: { aid: daid, uid: 'gd:FILE000001' } });
    ok(r.status === 403, '關閉上傳後不能匯入');
  } finally {
    srv.close();
  }
}
