// 驗證：管理碼、同步金鑰（只存 SHA-256，常數時間比較）
import { HttpError, ID_RE, bearer, safeEqual, sha256Hex } from './util.js';
import { getConfig } from './config.js';
import { assertSameOrigin, getSession } from './session.js';

const unauthorized = () => new HttpError(401, 'unauthorized', '金鑰不正確或已失效。');

function checkId(id) {
  if (!ID_RE.test(id)) throw new HttpError(400, 'invalid', '活動編號格式不正確。');
}

export const ROLE_RANK = { viewer: 1, manager: 2, owner: 3 };

// 這個 Email 在活動中的角色（比對不分大小寫）；owner 以 sub 判斷
export function roleOf(cfg, session) {
  if (cfg.owner && cfg.owner.sub === session.sub) return 'owner';
  const email = String(session.email || '').toLowerCase();
  const m = (cfg.members || []).find((x) => String(x.email).toLowerCase() === email);
  return m && ROLE_RANK[m.role] ? m.role : null;
}

// 管理端授權的唯一入口（合約 §8.6）。回傳 { cfg, role, auth: 'key'|'account', user }
// 順序：id 格式 400 →
//   有 Bearer：活動不存在 404 → 管理碼錯誤 401 → 視為 owner（舊行為完全不變）
//   無 Bearer：沒有有效登入 cookie 401 → Origin 非同源（非 GET）403 bad_origin → 活動不存在 404
//             → 不是 owner/成員 403 → 權限低於 minRole 403
export async function requireRole(env, req, id, minRole = 'viewer') {
  checkId(id);
  const token = bearer(req);
  if (token) {
    const cfg = await getConfig(env, id);
    if (!cfg) throw new HttpError(404, 'not_found', '找不到這個活動。');
    if (!safeEqual(await sha256Hex(token), cfg.admin_hash)) throw unauthorized();
    return { cfg, role: 'owner', auth: 'key', user: null };
  }
  const user = await getSession(env, req);
  if (!user) throw unauthorized();
  assertSameOrigin(req);
  const cfg = await getConfig(env, id);
  if (!cfg) throw new HttpError(404, 'not_found', '找不到這個活動。');
  const role = roleOf(cfg, user);
  if (!role || ROLE_RANK[role] < (ROLE_RANK[minRole] || 1)) {
    throw new HttpError(403, 'forbidden', role ? '你的角色沒有這個操作的權限。' : '你不是這個活動的成員。');
  }
  return { cfg, role, auth: 'account', user };
}

// 同步端：回傳 config
export async function requireSync(env, req, id) {
  checkId(id);
  const token = bearer(req);
  if (!token) throw unauthorized();
  const cfg = await getConfig(env, id);
  if (!cfg) throw new HttpError(404, 'not_found', '找不到這個活動。');
  // 沒有同步金鑰時仍做一次雜湊比較，避免時間差洩漏狀態
  const hash = cfg.sync?.hash || '0'.repeat(64);
  const ok = safeEqual(await sha256Hex(token), hash);
  if (!ok || !cfg.sync?.hash) throw unauthorized();
  return cfg;
}
