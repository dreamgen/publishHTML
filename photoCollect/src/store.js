// R2 上的小型 JSON 文件（users/{sub}.json、shares/{hash}.json）：用 etag 樂觀鎖讀-改-寫
// 與 config 的做法一致（見 config.js saveConfig／mutateConfig），但可重用於任何 key。
import { HttpError } from './util.js';

// mutate 回傳這個值代表「不需要寫入」
export const NO_CHANGE = Symbol('no-change');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 讀取 JSON 物件；不存在回 null。回傳 { data, etag }
export async function readJsonObj(env, key) {
  const o = await env.PHOTOS.get(key);
  if (!o) return null;
  let data;
  try { data = await o.json(); } catch { data = null; }
  return { data: data && typeof data === 'object' ? data : null, etag: o.etag };
}

// 讀-改-寫：
//  - defaults()：檔案不存在（或內容損壞）時的初始內容
//  - mutate(data)：就地修改 data；回傳 NO_CHANGE 表示不寫入；也可回傳新物件取代
//  - 以 etagMatches（已存在）或 etagDoesNotMatch:'*'（尚未存在）條件寫入；
//    衝突時重新讀取、重新套用 mutate，最多 tries 次，仍失敗丟 409 conflict
// 回傳最後的內容（NO_CHANGE 時回傳目前內容）
export async function updateJson(env, key, defaults, mutate, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const cur = await readJsonObj(env, key);
    let data = cur && cur.data ? cur.data : defaults();
    const out = await mutate(data);
    if (out === NO_CHANGE) return data;
    if (out && typeof out === 'object') data = out;
    const opts = { httpMetadata: { contentType: 'application/json; charset=utf-8' } };
    opts.onlyIf = cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: '*' };
    const res = await env.PHOTOS.put(key, JSON.stringify(data), opts);
    if (res !== null) return data;
    // 並行寫入造成衝突：稍等一下（隨機抖動避免同時重試）再來
    await sleep(10 + Math.random() * 40);
  }
  throw new HttpError(409, 'conflict', '資料剛被其他操作修改，請稍後再試。');
}
