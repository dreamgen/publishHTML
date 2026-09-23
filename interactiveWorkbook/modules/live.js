// ──────────────────────────────────────────────────────────────────────────────
// 易變資料（活動標記與組內編輯鎖）的獨立訂閱
// ──────────────────────────────────────────────────────────────────────────────
/**
 * 為什麼要獨立一層：活動標記（投影的橘點）與編輯鎖每隔幾秒就會變動。
 * 如果把它們放在 courses/<CODE> 底下，主監聽（session.js 的 onValue）會被它們不斷觸發，
 * 講師畫面就會整頁重畫——規劃文件明確要求「只更新點、不觸發主畫面重繪」。
 * 因此這些資料放在同層的 live/<CODE>，由這裡用另一條 onValue 訂閱，
 * 變動時只通知有登記的訂閱者，各自做最小幅度的局部更新。
 *
 * 訂閱者不要在回呼裡呼叫 rerender()：那就違背了這個模組存在的理由。
 * 需要整頁重畫的情況（例如編輯權易主）由訂閱者自己判斷後再決定。
 */
import { S } from './state.js';
import { liveRef, onValue, update, get } from './firebase.js';

const subscribers = new Set();

/** 已經寫過的活動標記，避免同一個欄位重複寫入（寫入量因此被「欄位數 × 組數」封頂） */
const markedCache = new Set();

function notifySubscribers() {
  subscribers.forEach((fn) => {
    try { fn(S.live); } catch (e) { console.error('live 訂閱者出錯：', e); }
  });
}

/**
 * 開始訂閱 live/<CODE>。重複呼叫會先取消上一條訂閱，切換課程時不會留下殭屍監聽。
 */
export function watchLive(code) {
  stopWatchLive();
  markedCache.clear();
  S.unwatchLive = onValue(liveRef(code), (snap) => {
    const raw = (snap.exists() ? snap.val() : null) || {};
    S.live = { activity: raw.activity || {}, editLocks: raw.editLocks || {} };
    notifySubscribers();
  }, () => {
    // live 資料是輔助性的：讀不到時畫面仍要能用，不要為了它打斷課程，也不要洗版通知。
  });
}

export function stopWatchLive() {
  if (S.unwatchLive) { S.unwatchLive(); S.unwatchLive = null; }
  S.live = { activity: {}, editLocks: {} };
  markedCache.clear();
}

/**
 * 登記一個訂閱者，回傳取消函式。
 * 畫面重畫後請重新登記（或在重畫前呼叫取消），避免對已被移除的 DOM 做更新。
 */
export function onLiveChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 某組在某題某欄位是否留下過活動標記（投影的橘點） */
export function hasActivity(gid, qid, fieldKey) {
  const byGroup = S.live.activity[gid];
  if (!byGroup) return false;
  const byQuestion = byGroup[qid];
  return !!(byQuestion && byQuestion[fieldKey]);
}

/**
 * 寫入活動標記。同一個欄位只寫一次：
 * 本機先用 markedCache 擋掉重複，遠端已經有標記時也直接跳過。
 * 失敗不提示——這只是投影用的輔助訊號，不值得打斷學員作答。
 */
export async function markActivity(code, gid, qid, fieldKey) {
  if (!code || !gid || !qid || !fieldKey) return;
  const cacheKey = `${gid}/${qid}/${fieldKey}`;
  if (markedCache.has(cacheKey)) return;
  if (hasActivity(gid, qid, fieldKey)) { markedCache.add(cacheKey); return; }
  markedCache.add(cacheKey);
  try {
    await update(liveRef(code), { [`activity/${gid}/${qid}/${fieldKey}`]: true });
  } catch {
    markedCache.delete(cacheKey); // 寫失敗就讓下一次動作再試一次
  }
}

/**
 * 清掉某一題的全部活動標記。講師清除本題答案時要一併清掉，
 * 否則橘點會留在一個已經沒有答案的欄位上，變成假訊號。
 */
export async function clearActivityForQuestion(code, qid) {
  if (!code || !qid) return;
  try {
    const snap = await get(liveRef(code, 'activity'));
    if (!snap.exists()) return;
    const updates = {};
    Object.keys(snap.val() || {}).forEach((gid) => { updates[`activity/${gid}/${qid}`] = null; });
    if (Object.keys(updates).length) await update(liveRef(code), updates);
    [...markedCache].forEach((key) => { if (key.includes(`/${qid}/`)) markedCache.delete(key); });
  } catch { /* 輔助資料，清不掉就算了 */ }
}
