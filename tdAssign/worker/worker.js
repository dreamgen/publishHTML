/**
 * 天達排班協作 — LINE 登入後端（Cloudflare Worker）
 *
 * 前端把 LINE 回傳的 code 送來，這裡向 LINE 換取並驗證身分，再簽發 Firebase 自訂憑證（custom token），
 * 前端用它登入 Firebase。uid 會是 "line:<LINE userId>"。
 *
 * 需要的環境變數（wrangler secret put …）：
 *   LINE_CHANNEL_ID        LINE Login channel 的 Channel ID
 *   LINE_CHANNEL_SECRET    Channel secret
 *   FIREBASE_CLIENT_EMAIL  Firebase 服務帳戶的 client_email
 *   FIREBASE_PRIVATE_KEY   服務帳戶的 private_key（整段 PEM，含 BEGIN/END）
 *   ALLOWED_ORIGIN         前端網址的 origin，例如 https://dreamgen.github.io
 */
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function customToken(env, uid) {
  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const body = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600, uid
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body));
  return body + '.' + b64url(sig);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
    const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (origin !== env.ALLOWED_ORIGIN) return json({ error: 'origin not allowed' }, 403);
    try {
      const { code, redirectUri } = await request.json();
      if (!code || !redirectUri || !String(redirectUri).startsWith(env.ALLOWED_ORIGIN)) return json({ error: 'bad request' }, 400);
      const tok = await fetch('https://api.line.me/oauth2/v2.1/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET })
      }).then((r) => r.json());
      if (!tok.id_token) return json({ error: 'LINE 沒有回傳身分，請重新登入' }, 401);
      const who = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: tok.id_token, client_id: env.LINE_CHANNEL_ID })
      }).then((r) => r.json());
      if (!who.sub) return json({ error: 'LINE 身分驗證失敗' }, 401);
      return json({ token: await customToken(env, 'line:' + who.sub), name: who.name || '' });
    } catch (e) {
      return json({ error: '登入後端發生錯誤' }, 500);
    }
  }
};
