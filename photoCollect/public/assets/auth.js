// Google 帳號登入共用模組（起點頁、管理頁、上傳頁共用）
// - 登入功能是否開啟，一律以 GET /api/auth/config 的 google_client_id 為準；null 就完全不顯示任何登入 UI。
// - cookie（mvs）是 HttpOnly，前端讀不到，登入狀態只能靠 GET /api/me 判斷。
// - 所有伺服器資料一律以 textContent 寫入，不使用 innerHTML。

const GSI_URL = 'https://accounts.google.com/gsi/client';
const GSI_TIMEOUT_MS = 10000;

let clientId = null;          // 啟用時為字串
let me = { user: null };      // 最近一次 /api/me 結果
let readyP = null;            // initAuth() 的 Promise（只跑一次）
let gsiP = null;              // loadGsi() 的 Promise（只跑一次）
const listeners = new Set();
const errBoxes = new Set();   // 各登入鈕旁的錯誤訊息容器
let lastErr = '';

// ---------- 小工具 ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 登入相關錯誤碼 → 繁體中文說明 */
function errMessage(status, code) {
  if (code === 'invalid_token') return '登入驗證沒有通過，請再試一次。';
  if (code === 'email_unverified') return '這個 Google 帳號的 Email 還沒驗證，無法登入。';
  if (code === 'auth_unavailable') return '登入服務暫時無法使用，請稍後再試。';
  if (code === 'bad_origin') return '連線來源不符，請重新整理頁面後再試。';
  if (status === 0) return '無法連線，請檢查網路後再試。';
  return `登入失敗（${status}），請稍後再試。`;
}
function showErr(msg) {
  lastErr = msg || '';
  for (const b of errBoxes) {
    if (!b.isConnected) { errBoxes.delete(b); continue; }
    b.textContent = lastErr;
    b.hidden = !lastErr;
  }
}

// ---------- 設定與狀態 ----------
/** 取得 google_client_id；失敗或 null 都視為未啟用 */
export function loadConfig() {
  return fetch('/api/auth/config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && typeof j.google_client_id === 'string' && j.google_client_id.trim() ? j.google_client_id.trim() : null))
    .catch(() => null);
}

async function fetchMe() {
  try {
    const r = await fetch('/api/me', { cache: 'no-store' });
    if (!r.ok) return { user: null };
    const j = await r.json();
    return j && j.user ? j : { user: null };
  } catch { return { user: null }; }
}

function notify() {
  for (const cb of [...listeners]) { try { cb(me); } catch (e) { console.error(e); } }
}

/** 初始化：讀 config，啟用時順便讀目前登入狀態。回傳是否啟用。 */
export function initAuth() {
  readyP ||= (async () => {
    clientId = await loadConfig();
    if (clientId) me = await fetchMe();
    return !!clientId;
  })();
  return readyP;
}
export async function isEnabled() { return initAuth(); }

/** 目前登入狀態（未啟用或未登入時 {user:null}） */
export async function getMe() { await initAuth(); return me; }
/** 同步取得最近一次狀態（initAuth 完成後才有意義） */
export function currentMe() { return me; }

/** 重新讀取 /api/me 並通知所有監聽者 */
export async function refreshMe() {
  if (!(await initAuth())) return me;
  me = await fetchMe();
  notify();
  return me;
}

/** 監聽登入狀態變化（登入、登出、refreshMe）；回傳取消函式 */
export function onAuthChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* 網路失敗：下面重新讀狀態 */ }
  me = await fetchMe();
  notify();
}

// ---------- Google Identity Services ----------
async function onCredential(resp) {
  if (!resp || !resp.credential) return;
  showErr('');
  let res;
  try {
    res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: resp.credential }),
    });
  } catch { showErr(errMessage(0)); return; }
  if (!res.ok) {
    let code = '';
    try { code = (await res.json()).error || ''; } catch { /* 非 JSON */ }
    showErr(errMessage(res.status, code));
    return;
  }
  await refreshMe();
}

/** 動態載入 gsi/client；被擋、離線、逾時或載入後沒有 google.accounts.id 都回 false */
function loadGsi() {
  gsiP ||= new Promise((resolve) => {
    if (window.google?.accounts?.id) { resolve(true); return; }
    const s = document.createElement('script');
    s.src = GSI_URL;
    s.async = true;
    s.defer = true;
    const timer = setTimeout(() => resolve(false), GSI_TIMEOUT_MS);
    s.addEventListener('load', () => { clearTimeout(timer); resolve(!!window.google?.accounts?.id); });
    s.addEventListener('error', () => { clearTimeout(timer); resolve(false); });
    document.head.append(s);
  }).then((ok) => {
    if (!ok) return false;
    try {
      window.google.accounts.id.initialize({ client_id: clientId, callback: onCredential, ux_mode: 'popup', auto_select: false });
      return true;
    } catch { return false; }
  });
  return gsiP;
}

/**
 * 建立「使用 Google 登入」按鈕容器。
 * 載入 gsi 失敗時，同一位置顯示「Google 登入暫時無法使用」，其他功能照常。
 */
export function googleButton({ size = 'large' } = {}) {
  const wrap = el('div', 'ac-gwrap');
  const slot = el('div', 'ac-gslot');
  const err = el('div', 'ac-gerr');
  err.setAttribute('role', 'alert');
  err.hidden = !lastErr;
  err.textContent = lastErr;
  errBoxes.add(err);
  wrap.append(slot, err);
  initAuth().then(async (enabled) => {
    if (!enabled) { wrap.remove(); return; }
    const ok = await loadGsi();
    if (!ok) {
      slot.replaceChildren(el('span', 'ac-gfail', 'Google 登入暫時無法使用'));
      return;
    }
    try {
      window.google.accounts.id.renderButton(slot, { type: 'standard', theme: 'outline', size, text: 'signin_with', shape: 'pill', locale: 'zh-TW' });
    } catch {
      slot.replaceChildren(el('span', 'ac-gfail', 'Google 登入暫時無法使用'));
    }
  });
  return wrap;
}

// ---------- 頭像與帳號區 ----------
export function displayName(user) { return (user && (user.name || user.email)) || ''; }

/** 大頭貼：載入失敗（或沒有網址）就顯示姓名首字圓圈 */
export function avatar(user) {
  const wrap = el('span', 'ac-av');
  wrap.setAttribute('aria-hidden', 'true');
  const initial = Array.from(displayName(user).trim())[0]?.toUpperCase() || '?';
  const fallback = () => { wrap.replaceChildren(); wrap.classList.add('ac-av-init'); wrap.textContent = initial; };
  if (user && typeof user.picture === 'string' && /^https:\/\//.test(user.picture)) {
    const img = document.createElement('img');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.alt = '';
    img.width = 32;
    img.height = 32;
    img.addEventListener('error', fallback);
    img.src = user.picture;
    wrap.append(img);
  } else {
    fallback();
  }
  return wrap;
}

/** 在頁首放帳號區：未登入＝Google 按鈕；已登入＝大頭貼＋名字＋登出。未啟用時整個隱藏。 */
export function mountAccount(host) {
  host.hidden = true;
  let shown = null;
  const draw = () => {
    const key = me.user ? `u:${me.user.sub}:${me.user.name}` : 'anon';
    if (key === shown) return;
    shown = key;
    if (me.user) {
      const out = el('button', 'ac-link', '登出');
      out.type = 'button';
      out.addEventListener('click', () => { out.disabled = true; logout(); });
      const box = el('div', 'ac-user');
      const nm = el('span', 'ac-name', displayName(me.user));
      nm.title = me.user.email || '';
      box.append(avatar(me.user), nm, out);
      host.replaceChildren(box);
    } else {
      host.replaceChildren(googleButton({ size: 'medium' }));
    }
  };
  initAuth().then((enabled) => {
    if (!enabled) return;
    host.hidden = false;
    draw();
    onAuthChange(draw);
  });
}

// 本機測試用：只在 localhost 掛上，方便 Playwright 在 cookie 設好後觸發畫面重新整理
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__mvAuthRefresh = () => refreshMe();
}
