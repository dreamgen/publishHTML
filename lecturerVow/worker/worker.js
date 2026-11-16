/**
 * 講師愿力表系統 — LINE Login × Messaging API (單人 Push / Webhook) Cloudflare Worker
 *
 * 環境變數（透過 `wrangler secret put` 設定）：
 *   LINE_CHANNEL_ID            LINE Login Channel ID
 *   LINE_CHANNEL_SECRET        LINE Login Channel Secret
 *   LINE_MESSAGING_TOKEN       LINE Official Account Messaging API Channel Access Token
 *   LINE_MESSAGING_SECRET      LINE Official Account Channel Secret（選填，Webhook 簽章驗證）
 *   FIREBASE_CLIENT_EMAIL      新 Firebase 專案服務帳戶 client_email
 *   FIREBASE_PRIVATE_KEY       新 Firebase 專案服務帳戶 private_key（PEM 格式）
 *   ALLOWED_ORIGIN             前端網域 origin，例如 https://dreamgen.github.io
 */
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function createFirebaseCustomToken(env, uid) {
  const pem = env.FIREBASE_PRIVATE_KEY
    .replace(/\\n/g, '\n')
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const body =
    enc({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    enc({
      iss: env.FIREBASE_CLIENT_EMAIL,
      sub: env.FIREBASE_CLIENT_EMAIL,
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: now,
      exp: now + 3600,
      uid,
    });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body));
  return body + '.' + b64url(sig);
}

async function verifyLineIdToken(idToken, channelId) {
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  return res.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    // 1. LINE Official Account Webhook (由 LINE 平台呼叫，不檢查瀏覽器 Origin)
    if (url.pathname === '/line/webhook') {
      try {
        const payload = await request.json();
        const events = Array.isArray(payload.events) ? payload.events : [];
        for (const ev of events) {
          if (ev.type === 'message' && ev.message?.type === 'text' && ev.replyToken) {
            const txt = String(ev.message.text || '').trim();
            if (txt.includes('星級') || txt.includes('愿力')) {
              await fetch('https://api.line.me/v2/bot/message/reply', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${env.LINE_MESSAGING_TOKEN}`,
                },
                body: JSON.stringify({
                  replyToken: ev.replyToken,
                  messages: [
                    {
                      type: 'text',
                      text: `🙏 您好！請點開圖文選單「我的愿力表」或開啟講師愿力表 PWA，即可查看即時五星評比與更新本月進度：${env.ALLOWED_ORIGIN}/lecturerVow/`,
                    },
                  ],
                }),
              });
            }
          }
        }
        return json({ ok: true });
      } catch {
        return json({ error: 'webhook error' }, 500);
      }
    }

    // 其餘端點限允許的前端 Origin 呼叫
    if (origin !== env.ALLOWED_ORIGIN) return json({ error: 'origin not allowed' }, 403);

    // 2. LINE Login OAuth / LIFF 換取 Firebase Custom Token
    if (url.pathname === '/auth/line' || url.pathname === '/') {
      try {
        const { code, redirectUri, idToken: directIdToken } = await request.json();
        let idToken = directIdToken;

        if (!idToken) {
          if (!code || !redirectUri || !String(redirectUri).startsWith(env.ALLOWED_ORIGIN)) {
            return json({ error: 'bad request' }, 400);
          }
          const tok = await fetch('https://api.line.me/oauth2/v2.1/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: redirectUri,
              client_id: env.LINE_CHANNEL_ID,
              client_secret: env.LINE_CHANNEL_SECRET,
            }),
          }).then((r) => r.json());
          idToken = tok.id_token;
        }

        if (!idToken) return json({ error: 'LINE 沒有回傳身分，請重新登入' }, 401);
        const who = await verifyLineIdToken(idToken, env.LINE_CHANNEL_ID);
        if (!who.sub) return json({ error: 'LINE 身分驗證失敗' }, 401);

        const token = await createFirebaseCustomToken(env, `line:${who.sub}`);
        return json({ token, lineUserId: who.sub, name: who.name || '' });
      } catch {
        return json({ error: '登入後端發生錯誤' }, 500);
      }
    }

    // 3. 單人 Push API（僅發送給單一指定 LINE User ID，不使用群發推播）
    if (url.pathname === '/line/push') {
      try {
        const { toLineUserId, messageText } = await request.json();
        if (!toLineUserId || !messageText) return json({ error: 'missing parameters' }, 400);
        if (!env.LINE_MESSAGING_TOKEN) return json({ error: 'LINE_MESSAGING_TOKEN not configured' }, 501);

        const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.LINE_MESSAGING_TOKEN}`,
          },
          body: JSON.stringify({
            to: toLineUserId,
            messages: [{ type: 'text', text: String(messageText).slice(0, 1000) }],
          }),
        });
        if (!pushRes.ok) {
          const errBody = await pushRes.text();
          return json({ error: 'LINE Push 失敗', detail: errBody }, pushRes.status);
        }
        return json({ ok: true });
      } catch {
        return json({ error: 'Push 後端發生錯誤' }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
