// ──────────────────────────────────────────────────────────────────────────────
// 2. 基本工具
// ──────────────────────────────────────────────────────────────────────────────
export const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const CH = '一二三四五六七八九十'.split('');
export const exLabel = (i) => `練習${CH[i] || (i + 1)}`;
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉容易看錯的 0O1I
export const CODE_LENGTH = 6;
export const PBKDF2_ITERATIONS = 150000;

let messageTimer;
export function notify(text) {
  const el = document.querySelector('#message');
  if (!el) return;
  el.textContent = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { el.textContent = ''; }, 8000);
}

/** RTDB 可能把索引物件或陣列混用；一律轉回保留索引位置的陣列 */
export function toArr(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'object') {
    const keys = Object.keys(value).map(Number).filter((k) => !Number.isNaN(k));
    const len = keys.length ? Math.max(...keys) + 1 : 0;
    const out = new Array(len);
    keys.forEach((k) => { out[k] = value[k]; });
    return out;
  }
  return [];
}

export function pad(arr, n, fill) {
  const out = toArr(arr).slice(0, n);
  for (let i = 0; i < n; i += 1) if (out[i] === undefined || out[i] === null) out[i] = fill();
  return out;
}

export function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function randomId(bytes = 8) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export const toHex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

/** PBKDF2-SHA256；需要安全連線（https 或 localhost）才有 crypto.subtle */
export async function derivePassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  if (!crypto.subtle) throw Error('這個瀏覽器環境不支援密碼加密，請改用 https 網址開啟。');
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}
