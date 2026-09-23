// ──────────────────────────────────────────────────────────────────────────────
// 組內編輯權（一組同時只有一台裝置可編輯）
// ──────────────────────────────────────────────────────────────────────────────
/**
 * 為什麼要有這一層：預先命名小組之後，「整組的人都點進自己那組」變得非常容易，
 * 一組四、五台裝置同時開著同一份答案，既有的 revision 衝突保護會變成課堂噪音。
 * 因此一組同時只有一台裝置可以填寫，其餘唯讀。
 *
 * 規劃文件確定的行為（不要自行加碼）：
 *  - 編輯者可以主動退出，讓給別人。
 *  - 閒置 5 分鐘之後同組其他人可以「接手」。**不是自動釋放**：沒人接手就繼續由原編輯者持有。
 *  - 原編輯者只要有任何動作，閒置計時就歸零。
 *  - 接手要先確認，並且明講「可能造成對方未儲存的內容遺失」。
 *  - 被接手者未儲存的內容不做額外保護（社交管道原則：同桌的人可以互相講）。
 *  - 不做線上偵測、心跳保活、斷線清理——那整套子系統是刻意避開的。
 *
 * 已知限制：閒置判斷用的是**客戶端時鐘**（`Date.now() - lastActive`）。
 * `lastActive` 由持有者的裝置寫入，由其他裝置的時鐘來比對，所以兩台裝置的時間差會直接
 * 加減到「閒置了多久」上：對方的時鐘快 2 分鐘，接手就會晚 2 分鐘才開放。
 * 這是刻意接受的取捨——改用伺服器時間戳（ServerValue.TIMESTAMP）要多一次讀回、
 * 還要處理「本機樂觀值與伺服器值不一致」的中間狀態，複雜度不值得。
 * 真的差到離譜時，最壞情況也只是多等幾分鐘或早幾分鐘接手，不會弄丟資料。
 *
 * 資料位置（規約 3.2，一定要在 live/<CODE> 底下，不能放進 courses，否則主監聽會被它不斷觸發）：
 *   live/<CODE>/editLocks/<gid> = { holder, name, lastActive }
 *   holder    = deviceId()（localStorage 的裝置 ID）
 *   name      = 這台裝置加入時填的姓名（S.session.author），只用來顯示
 *   lastActive= 毫秒時間戳
 */
import { S } from './state.js';
import {
  authReady, liveRef, get, update, runTransaction,
} from './firebase.js';
import { deviceId } from './storage.js';
import { E, notify } from './util.js';
import { onLiveChange } from './live.js';

/** 閒置多久之後，同組其他人可以接手 */
export const IDLE_TAKEOVER_MS = 5 * 60 * 1000;
/** 有動作就歸零，但最多每 20 秒真的寫一次資料庫 */
export const TOUCH_THROTTLE_MS = 20 * 1000;
/** 橫幅自我更新的間隔：閒置時間會跑，不能只在重畫時算一次 */
export const BANNER_TICK_MS = 15 * 1000;

// ──────────────────────────────────────────────────────────────────────────────
// 讀取（純函式，只看 live.js 訂閱回來的 S.live）
// ──────────────────────────────────────────────────────────────────────────────

/** 取出某組的鎖；沒有 holder 的殘骸一律當成「沒有人持有」 */
function rawLock(gid) {
  const locks = (S.live && S.live.editLocks) || {};
  const entry = gid ? locks[gid] : null;
  return (entry && typeof entry === 'object' && entry.holder) ? entry : null;
}

function myName() {
  const session = S.session || {};
  const group = (S.course && session.gid) ? (S.course.groups || {})[session.gid] : null;
  return String(session.author || (group && group.author) || '');
}

/**
 * 目前這台裝置對某組的編輯權狀態。
 * exists=false 代表沒有人持有（這時要走 acquireLock，不是 takeoverLock）。
 * canTakeover 只在「別人持有、而且已經閒置滿 5 分鐘」時為 true。
 */
export function myEditLock(gid) {
  const me = deviceId();
  const entry = rawLock(gid);
  if (!entry) {
    return {
      mine: false, holder: null, holderName: '', idleMs: 0, canTakeover: false, exists: false,
    };
  }
  const mine = entry.holder === me;
  const idleMs = Math.max(0, Date.now() - Number(entry.lastActive || 0));
  return {
    mine,
    holder: entry.holder,
    holderName: String(entry.name || ''),
    idleMs,
    canTakeover: !mine && idleMs >= IDLE_TAKEOVER_MS,
    exists: true,
  };
}

/** 這台裝置現在可不可以填寫這一組的答案 */
export function canEdit(gid) {
  return myEditLock(gid).mine;
}

// ──────────────────────────────────────────────────────────────────────────────
// 寫入（一律走 runTransaction，兩台裝置同時動作只會有一個贏家）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * editLocks/<gid> 的 transaction 包裝。
 * apply(current) 回傳 { value } 表示要寫入（value 為 null 代表刪除節點），
 * 回傳不含 value 的物件表示中止，並可帶 reason 讓呼叫端說明原因。
 *
 * RTDB 第一次呼叫回呼時可能給 null（本機還沒有快取）。
 * 「寫入」的分支不受影響：伺服器上的值不同時 RTDB 會帶著真正的值再跑一次回呼、再決定要不要提交。
 * 會出事的是「因為看到 null 而中止」——中止是最終結果，不會重跑，
 * 於是本來持有鎖的人會誤以為自己沒有鎖。所以標記 fromNull，中止後再向伺服器確認一次
 * （做法與 data.js 的 saveAnswerOnce／groupsTransaction 相同）。
 */
async function lockTransaction(code, gid, apply) {
  await authReady;
  const node = liveRef(code, `editLocks/${gid}`);
  const once = async () => {
    let outcome = {};
    const result = await runTransaction(node, (current) => {
      outcome = apply(current) || {};
      return Object.prototype.hasOwnProperty.call(outcome, 'value') ? outcome.value : undefined;
    });
    return { ...outcome, committed: !!(result && result.committed) };
  };
  let outcome = await once();
  if (outcome.fromNull) {
    const snap = await get(node);
    if (snap.exists()) outcome = await once();
  }
  return outcome;
}

/** 記住「剛剛已經把 lastActive 寫成現在」，省掉緊接著的一次 touch 寫入 */
const touchedAt = new Map();
const touchKey = (code, gid) => `${code}/${gid}`;

/**
 * 取得編輯權：沒有人持有（或持有者就是自己）時取得；已經被別人持有就不搶。
 * 回傳 { ok, reason, holderName }；reason='held' 表示被別人持有。
 */
export async function acquireLock(code, gid) {
  if (!code || !gid) return { ok: false, reason: 'invalid' };
  const me = deviceId();
  const name = myName();
  const outcome = await lockTransaction(code, gid, (current) => {
    if (current && current.holder && current.holder !== me) {
      // 別人持有：不搶。要拿只能等閒置滿 5 分鐘之後走 takeoverLock。
      return { reason: 'held', holderName: String(current.name || '') };
    }
    return { value: { holder: me, name, lastActive: Date.now() } };
  });
  if (outcome.committed) {
    touchedAt.set(touchKey(code, gid), Date.now());
    return { ok: true };
  }
  return { ok: false, reason: outcome.reason || 'failed', holderName: outcome.holderName || '' };
}

/**
 * 主動退出。只有持有者本人能釋放——自己已經不是持有者（例如剛剛被接手）就什麼都不做，
 * 絕對不可以把別人的鎖刪掉。
 */
export async function releaseLock(code, gid) {
  if (!code || !gid) return { ok: false, reason: 'invalid' };
  const me = deviceId();
  const outcome = await lockTransaction(code, gid, (current) => {
    if (current === null) return { fromNull: true, reason: 'none' };
    if (current.holder !== me) return { reason: 'notMine' };
    return { value: null };
  });
  touchedAt.delete(touchKey(code, gid));
  if (outcome.committed) return { ok: true };
  // 本來就沒有鎖、或鎖已經是別人的：對使用者而言結果一樣（這台裝置沒有編輯權），不算失敗。
  if (outcome.reason === 'none' || outcome.reason === 'notMine') return { ok: true, reason: outcome.reason };
  return { ok: false, reason: outcome.reason || 'failed' };
}

/**
 * 接手。閒置不滿 5 分鐘就不給接（reason='notIdle'）。
 * 一定要用 transaction：兩台裝置同時在鎖過期後按「接手」時，只有先到的那一次會提交，
 * 後到的那一次會帶著新的資料重跑回呼，看到「持有者已經換成對方、而且 lastActive 是剛剛」，於是中止。
 */
export async function takeoverLock(code, gid) {
  if (!code || !gid) return { ok: false, reason: 'invalid' };
  const me = deviceId();
  const name = myName();
  const outcome = await lockTransaction(code, gid, (current) => {
    if (current && current.holder && current.holder !== me) {
      const idleMs = Date.now() - Number(current.lastActive || 0);
      if (idleMs < IDLE_TAKEOVER_MS) {
        return { reason: 'notIdle', idleMs, holderName: String(current.name || '') };
      }
    }
    // current 為 null（沒人持有，可能是對方剛好交出來了）或已經閒置夠久 → 直接接手。
    return { value: { holder: me, name, lastActive: Date.now() } };
  });
  if (outcome.committed) {
    touchedAt.set(touchKey(code, gid), Date.now());
    return { ok: true };
  }
  return { ok: false, reason: outcome.reason || 'failed', holderName: outcome.holderName || '' };
}

/**
 * 有動作就把閒置計時歸零。節流：最多每 20 秒寫一次，呼叫端不必自己節流。
 * 不是持有者就直接返回，而且不消耗節流額度（否則等一下真的拿到鎖時會白白等 20 秒）。
 * 用 transaction 而不是 update：萬一剛好被接手，不可以把別人的計時歸零，
 * 也不可以在沒有鎖的地方憑空生出一個只有 lastActive 的節點。
 * 失敗不提示——下一個動作會再試一次，不值得為它打斷學員作答。
 */
export async function touchLock(code, gid) {
  if (!code || !gid) return;
  if (!myEditLock(gid).mine) return;
  const key = touchKey(code, gid);
  const now = Date.now();
  if (now - (touchedAt.get(key) || 0) < TOUCH_THROTTLE_MS) return;
  touchedAt.set(key, now);
  const me = deviceId();
  try {
    await lockTransaction(code, gid, (current) => {
      if (!current || current.holder !== me) return {};
      return { value: { ...current, lastActive: Date.now() } };
    });
  } catch {
    touchedAt.delete(key); // 寫失敗就讓下一個動作再試一次
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 畫面：橫幅
//
// 橫幅要會自己更新（閒置時間是會跑的），但**只更新橫幅這一塊 DOM**：
// 改文字與按鈕的 disabled 狀態，不呼叫 rerender()——整頁重畫會清掉學員正在打的字。
// 只有「模式」改變（我持有／別人持有／沒有人持有）才需要重畫，因為按鈕本身換了。
// ──────────────────────────────────────────────────────────────────────────────

function idleText(idleMs) {
  const minutes = Math.floor(idleMs / 60000);
  return minutes < 1 ? '不到 1 分鐘前' : `${minutes} 分鐘前`;
}

function lockedStatusText(info) {
  if (info.canTakeover) {
    return `對方最後一次動作是 ${idleText(info.idleMs)}，已經閒置超過 5 分鐘，你現在可以接手。`;
  }
  const left = Math.max(1, Math.ceil((IDLE_TAKEOVER_MS - info.idleMs) / 60000));
  return `對方最後一次動作是 ${idleText(info.idleMs)}。閒置滿 5 分鐘之後才能接手，還要 ${left} 分鐘才能接手。`;
}

/** 由目前鎖狀態算出橫幅要呈現的內容。mode 改變＝按鈕換了＝需要重畫。 */
function lockView(gid) {
  const info = myEditLock(gid);
  if (info.mine) {
    return {
      mode: 'mine',
      headline: '本組目前由你填寫，同組其他裝置是唯讀的。',
      status: '要換人填寫時請按「交出編輯權」。忘了交也沒關係：這台裝置閒置滿 5 分鐘之後，同組其他人可以自己接手。',
      action: 'release',
      label: '交出編輯權',
      disabled: false,
    };
  }
  if (!info.exists) {
    return {
      mode: 'open',
      headline: '本組目前沒有人在填寫，你的畫面是唯讀的。',
      status: '一組同時只有一台裝置可以填寫。按下按鈕之後，這台裝置就是本組的填寫者。',
      action: 'acquire',
      label: '開始填寫（取得編輯權）',
      disabled: false,
    };
  }
  const who = info.holderName ? `「${info.holderName}」` : '同組的另一台裝置';
  return {
    mode: 'locked',
    headline: `本組目前由${who}填寫，你的畫面是唯讀的。`,
    status: lockedStatusText(info),
    action: 'takeover',
    label: '接手編輯',
    disabled: !info.canTakeover,
  };
}

/** 橫幅的 HTML。放在畫面最上方，由 student.js 插進去。 */
export function editLockBanner(gid) {
  const view = lockView(gid);
  return `<div class="editlock editlock-${view.mode}" id="editlock-banner" data-mode="${view.mode}" role="status">
      <p class="editlock-headline" id="editlock-headline">${E(view.headline)}</p>
      <p class="editlock-status" id="editlock-status">${E(view.status)}</p>
      <div class="toolbar"><button type="button" id="editlock-action" data-action="${view.action}"${view.disabled ? ' disabled' : ''}>${E(view.label)}</button></div>
    </div>`;
}

/**
 * 只改橫幅裡的文字與按鈕 disabled。
 * 回傳 true 表示模式變了、需要呼叫端重畫；找不到橫幅表示畫面已經換掉，順手把自己收乾淨。
 */
function refreshBanner(gid) {
  const box = document.querySelector('#editlock-banner');
  if (!box) { unmountEditLock(); return false; }
  const view = lockView(gid);
  if (box.dataset.mode !== view.mode) return true;
  const headline = box.querySelector('#editlock-headline');
  const status = box.querySelector('#editlock-status');
  const button = box.querySelector('#editlock-action');
  if (headline) headline.textContent = view.headline;
  if (status) status.textContent = view.status;
  if (button) button.disabled = view.disabled;
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// 生命週期
// ──────────────────────────────────────────────────────────────────────────────

let watching = null;      // { code, gid, onChange, holder, timer, unsub }
let autoAcquireKey = null; // 每個 (code, gid) 只在「第一次進入作答畫面」自動取得一次
let acquiring = false;
let unloadHooked = false;

/**
 * 自動取得編輯權只發生在「這台裝置第一次進入這一組的作答畫面」。
 * 刻意不在每次重畫都試：持有者按下「交出編輯權」之後，如果同組每台裝置都自動搶，
 * 會變成隨機一台拿到，真正想接手的人反而拿不到。交接一律由人按按鈕決定。
 */
async function maybeAutoAcquire(state) {
  const key = touchKey(state.code, state.gid);
  if (autoAcquireKey === key || acquiring) return;
  autoAcquireKey = key;
  if (myEditLock(state.gid).exists) return; // 已經有人持有（也可能就是自己）：不動它
  acquiring = true;
  try {
    const outcome = await acquireLock(state.code, state.gid);
    if (watching !== state) return;
    if (!outcome.ok && outcome.reason !== 'held') {
      notify('沒能取得本組的編輯權，請按畫面上方的「開始填寫（取得編輯權）」再試一次。');
    }
    if (outcome.ok) state.onChange({ kind: 'acquired' });
  } finally {
    acquiring = false;
  }
}

async function handleAction(state, action) {
  const button = document.querySelector('#editlock-action');
  if (button) button.disabled = true;
  try {
    if (action === 'takeover') {
      const info = myEditLock(state.gid);
      const who = info.holderName ? `「${info.holderName}」` : '目前的填寫者';
      const ok = confirm(`接手之後，${who}的畫面會變成唯讀。對方正在打、還沒儲存的內容可能會因此遺失，系統不會替他保留，請先跟同組的人講一聲。\n\n確定要接手本組的編輯權嗎？`);
      if (!ok) { if (button) button.disabled = false; return; }
      const outcome = await takeoverLock(state.code, state.gid);
      notify(outcome.ok
        ? '你已接手本組的編輯權，現在可以填寫。'
        : (outcome.reason === 'notIdle'
          ? '對方剛剛又有動作，閒置時間已經重新計算，暫時還不能接手。'
          : '接手沒有成功，可能剛好被同組其他裝置接走了。請看畫面上方最新的狀態。'));
    } else if (action === 'release') {
      if (S.dirty && !confirm('畫面上還有沒儲存的內容。交出編輯權之後這台裝置就是唯讀的，沒辦法再儲存這些內容。確定要交出嗎？')) {
        if (button) button.disabled = false;
        return;
      }
      const outcome = await releaseLock(state.code, state.gid);
      if (!outcome.ok) notify('交出編輯權沒有成功，請再試一次。');
      else if (outcome.reason === 'notMine') notify('本組的編輯權已經不在這台裝置上了（剛剛被同組其他人接手），你的畫面仍是唯讀的。');
      else if (outcome.reason === 'none') notify('本組目前本來就沒有人持有編輯權。');
      else notify('你已交出本組的編輯權，畫面轉為唯讀。同組其他人現在可以按「開始填寫（取得編輯權）」接手。');
    } else if (action === 'acquire') {
      const outcome = await acquireLock(state.code, state.gid);
      notify(outcome.ok
        ? '你已取得本組的編輯權，現在可以填寫。'
        : `本組剛剛已經被${outcome.holderName ? `「${outcome.holderName}」` : '同組其他裝置'}取得，你的畫面仍是唯讀的。`);
    }
  } catch (e) {
    notify('編輯權操作失敗：' + ((e && e.message) || e));
  }
  if (watching === state) state.onChange({ kind: 'action' });
}

/**
 * 盡力釋放：關掉分頁時把鎖清掉，讓同組的人不必等 5 分鐘。
 * beforeunload 期間不保證寫得出去（規劃文件也接受做不到），所以這裡不用 transaction、也不 await，
 * 真正的後盾是「閒置 5 分鐘可接手」。
 */
function hookUnload() {
  if (unloadHooked || typeof window === 'undefined') return;
  unloadHooked = true;
  window.addEventListener('beforeunload', () => {
    const session = S.session;
    if (!session || session.role !== 'student' || !session.gid) return;
    if (!myEditLock(session.gid).mine) return;
    try {
      update(liveRef(session.code), { [`editLocks/${session.gid}`]: null });
    } catch { /* 盡力而為 */ }
  });
}

/**
 * 掛上橫幅的按鈕、live 訂閱與自我更新的計時器。
 * 每次重畫作答畫面都要呼叫（會先把上一次的收乾淨），離開作答畫面要呼叫 unmountEditLock()。
 *
 * options.onChange(event) 由呼叫端決定要不要重畫：
 *   { kind:'takenOver', holderName } 自己被接手了 → 畫面必須轉唯讀
 *   { kind:'holder', mine, holderName } 持有者換人（包含沒有人持有）
 *   { kind:'mode' } 橫幅模式變了（按鈕不一樣）
 *   { kind:'acquired' } 自動取得成功
 *   { kind:'action' } 使用者按了橫幅上的按鈕
 */
export function mountEditLock(code, gid, options = {}) {
  unmountEditLock();
  if (!code || !gid) return;
  hookUnload();
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const me = deviceId();
  const state = {
    code, gid, onChange, holder: myEditLock(gid).holder, timer: null, unsub: null,
  };
  watching = state;

  const button = document.querySelector('#editlock-action');
  if (button) button.onclick = () => handleAction(state, button.dataset.action);

  // live 資料變動：先看持有者有沒有換人，沒換人就只更新橫幅那一塊。
  state.unsub = onLiveChange(() => {
    if (watching !== state) return;
    const info = myEditLock(gid);
    if (info.holder !== state.holder) {
      const previous = state.holder;
      state.holder = info.holder;
      if (previous === me && info.holder && info.holder !== me) {
        onChange({ kind: 'takenOver', holderName: info.holderName });
      } else {
        onChange({ kind: 'holder', mine: info.mine, holderName: info.holderName });
      }
      return;
    }
    if (refreshBanner(gid)) onChange({ kind: 'mode' });
  });

  // 閒置時間會跑：沒有任何資料變動時也要讓「還要 N 分鐘才能接手」自己往下走。
  state.timer = setInterval(() => {
    if (watching !== state) return;
    if (refreshBanner(gid)) onChange({ kind: 'mode' });
  }, BANNER_TICK_MS);

  maybeAutoAcquire(state);
}

/** 清掉計時器與 live 訂閱。畫面重畫或離開作答畫面時一定要呼叫，不要留殭屍計時器。 */
export function unmountEditLock() {
  if (!watching) return;
  if (watching.timer) clearInterval(watching.timer);
  if (watching.unsub) watching.unsub();
  watching = null;
}

/**
 * 離開本組／重新填寫身分時呼叫：讓下一次進入作答畫面可以重新自動取得編輯權。
 * 「按了交出編輯權」刻意不呼叫這個——不然交出去之後自己又馬上搶回來。
 */
export function resetEditLock() {
  unmountEditLock();
  autoAcquireKey = null;
  touchedAt.clear();
}
