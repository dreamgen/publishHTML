/**
 * 活動控場 (eventControl) — 主程式
 *
 * 同步模型：
 *  Firebase RTDB  artifacts/eventControl/public/data/events/{CODE}
 *    title, plannedStart('HH:MM'), plannedDate('YYYY-MM-DD'，空白＝當天), createdAt, updatedAt
 *    clock: { start: ms|null, pausedAt: ms|null }      ← 所有時間都由 start + 各單元分鐘數推算
 *    items: [{ id, title, subtitle, owner, duration, rounds }]
 *    broadcast: { id, text, by, at }
 *    log/{pushId}: { at, by, text }
 *    presence/{uid}: { name, me, at }
 *  任何知道代碼的人都能調整（使用者決定）。時間以 Firebase 伺服器時間校正，避免各手機時鐘不準。
 *
 *  網址加 ?mock=1 會改用本機記憶體後端（BroadcastChannel 跨分頁同步），供離線測試。
 */
import { parseFlowText, parseRows, parseCSV, toExportJSON, AI_PROMPT, newId } from './modules/flowParser.js';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAi2QYt_Cnl7X9wC3h-IUfOkUli7qMLrIM',
  authDomain: 'pwa-boardgame.firebaseapp.com',
  databaseURL: 'https://pwa-boardgame-default-rtdb.asia-southeast1.firebasedatabase.app/',
  projectId: 'pwa-boardgame',
  storageBucket: 'pwa-boardgame.firebasestorage.app',
  messagingSenderId: '1079279430768',
  appId: '1:1079279430768:web:644823331e777e10b018b5',
};
const DB_ROOT = 'artifacts/eventControl/public/data/events';
const FB = 'https://www.gstatic.com/firebasejs/11.6.1/';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const QUICK_MSGS = ['請加快 ⏩', '再 2 分鐘 ✌️', '準備下一位 🙋', '時間到 ⏰', '可以慢一點 🐢', '請到台前 🎤'];

// ═════════════════════════ 後端 ═════════════════════════
async function createFirebaseBackend() {
  const [{ initializeApp }, dbm, authm] = await Promise.all([
    import(FB + 'firebase-app.js'),
    import(FB + 'firebase-database.js'),
    import(FB + 'firebase-auth.js'),
  ]);
  const { getDatabase, ref, get, set, update, push, remove, onValue, runTransaction, onDisconnect, serverTimestamp } = dbm;
  const app = initializeApp(FIREBASE_CONFIG, 'eventControl');
  const db = getDatabase(app);
  const auth = authm.getAuth(app);
  let offset = 0;
  onValue(ref(db, '.info/serverTimeOffset'), (s) => (offset = s.val() || 0));
  const p = (code, sub) => ref(db, `${DB_ROOT}/${code}${sub ? '/' + sub : ''}`);
  const uid = await new Promise((resolve, reject) => {
    const off = authm.onAuthStateChanged(auth, (u) => {
      if (u) { off(); resolve(u.uid); }
    });
    authm.signInAnonymously(auth).catch(reject);
  });
  return {
    kind: 'firebase',
    uid,
    now: () => Date.now() + offset,
    ts: () => serverTimestamp(),
    onConn: (cb) => onValue(ref(db, '.info/connected'), (s) => cb(!!s.val())),
    exists: async (code) => (await get(p(code, 'title'))).exists(),
    create: (code, data) => set(p(code), data),
    watch: (code, cb) => onValue(p(code), (s) => cb(s.val())),
    set: (code, sub, v) => set(p(code, sub), v),
    update: (code, obj) => update(p(code), obj),
    push: (code, sub, v) => push(p(code, sub), v),
    tx: (code, sub, fn) => runTransaction(p(code, sub), fn),
    remove: (code) => remove(p(code)),
    presence: async (code, info) => {
      const r = p(code, 'presence/' + uid);
      await set(r, { ...info, at: serverTimestamp() });
      onDisconnect(r).remove();
      return () => remove(r);
    },
  };
}

function createMockBackend() {
  const KEY = 'ec_mock_db';
  let data = {};
  try { data = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  const ch = 'BroadcastChannel' in window ? new BroadcastChannel('ec_mock') : null;
  const watchers = new Map();
  const uid = 'mock_' + Math.random().toString(36).slice(2, 8);
  const emit = (code) => (watchers.get(code) || []).forEach((cb) => cb(structuredClone(data[code] ?? null)));
  const persist = (code) => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    ch?.postMessage({ code, val: data[code] ?? null });
    setTimeout(() => emit(code), 0);
  };
  ch && (ch.onmessage = (e) => { data[e.data.code] = e.data.val; if (e.data.val == null) delete data[e.data.code]; emit(e.data.code); });
  const getP = (code, sub) => (sub ? sub.split('/') : []).reduce((o, k) => (o == null ? undefined : o[k]), data[code]);
  const setP = (code, sub, v) => {
    if (!sub) { if (v == null) delete data[code]; else data[code] = structuredClone(v); return; }
    data[code] ??= {};
    const ks = sub.split('/');
    let o = data[code];
    ks.slice(0, -1).forEach((k) => { if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(k) ? [] : {}; o = o[k]; });
    if (v == null) delete o[ks.at(-1)]; else o[ks.at(-1)] = structuredClone(v);
  };
  return {
    kind: 'mock',
    uid,
    now: () => Date.now(),
    ts: () => Date.now(),
    onConn: (cb) => cb(true),
    exists: async (code) => data[code] != null,
    create: async (code, v) => { setP(code, '', v); persist(code); },
    watch: (code, cb) => {
      watchers.set(code, [...(watchers.get(code) || []), cb]);
      setTimeout(() => cb(structuredClone(data[code] ?? null)), 0);
      return () => watchers.set(code, (watchers.get(code) || []).filter((x) => x !== cb));
    },
    set: async (code, sub, v) => { setP(code, sub, v); persist(code); },
    update: async (code, obj) => { Object.entries(obj).forEach(([k, v]) => setP(code, k, v)); persist(code); },
    push: async (code, sub, v) => { setP(code, sub + '/' + newId(), v); persist(code); },
    tx: async (code, sub, fn) => { const r = fn(structuredClone(getP(code, sub) ?? null)); if (r !== undefined) { setP(code, sub, r); persist(code); } },
    remove: async (code) => { setP(code, '', null); persist(code); },
    presence: async (code, info) => {
      setP(code, 'presence/' + uid, { ...info, at: Date.now() }); persist(code);
      const bye = () => { setP(code, 'presence/' + uid, null); persist(code); };
      window.addEventListener('pagehide', bye);
      return bye;
    },
  };
}

// ═════════════════════════ 狀態與偏好 ═════════════════════════
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

const prefs = Object.assign({ name: '', lead: 3, remindAll: false, sound: true, vibrate: true, wake: false }, lsGet('ec_prefs', {}));
const savePrefs = () => lsSet('ec_prefs', prefs);
const meFor = (code) => lsGet('ec_me_' + code, []);
const setMeFor = (code, arr) => lsSet('ec_me_' + code, arr);

const S = {
  be: null,
  code: null,
  ev: null,
  connected: false,
  unwatch: null,
  leavePresence: null,
  fired: new Set(),
  listSig: '',
  activeIdx: -2,
  tab: 'flow',
  editIdx: -1,
  imp: null,
  impMode: 'create',
  lastBcId: null,
  stage: false,
  wakeLock: null,
};

const now = () => (S.be ? S.be.now() : Date.now());
const items = () => (Array.isArray(S.ev?.items) ? S.ev.items.filter(Boolean) : Object.values(S.ev?.items || {}));
const clock = () => S.ev?.clock || {};

// ═════════════════════════ 時間計算 ═════════════════════════
const fmtHM = (ms, sec = false) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? ':' + pad(d.getSeconds()) : ''}`; };
const fmtCd = (ms) => {
  const neg = ms < 0;
  let t = Math.ceil(Math.abs(ms) / 1000);
  if (t >= 86400) {
    // 一天以上：「1天 03:20:05」
    const days = Math.floor(t / 86400); t %= 86400;
    const s1 = `${days}天 ${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
    return neg ? '-' + s1 : s1;
  }
  const h = Math.floor(t / 3600); t %= 3600;
  const s = `${h ? h + ':' + pad(Math.floor(t / 60)) : pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  return neg ? '-' + s : s;
};
function todayAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now());
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const todayYmd = () => ymd(now());
/** 指定日期（YYYY-MM-DD，空白＝今天）的 HH:MM */
function dateAt(dateStr, hhmm) {
  if (!dateStr) return todayAt(hhmm);
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
}
/** 比原定開始晚幾分（正）／早幾分（負）；沒有原定時間或差太多（>12 小時）回傳 null */
function driftMin(r) {
  const p = plannedAt();
  if (p == null || r.start == null || !r.started) return null;
  // 原定時間只到「分」，實際開始取到同一位數再比，按一次 −1／+1 就剛好差 1 分
  const ms = Math.floor(r.start / 60000) * 60000 - p;
  if (Math.abs(ms) >= 12 * 3600000) return null;
  return Math.round(ms / 60000);
}
/** 原定開始時刻（plannedStart + plannedDate） */
const plannedAt = () => (S.ev?.plannedStart ? dateAt(S.ev.plannedDate || '', S.ev.plannedStart) : null);
/** 不是今天時回傳「明天」「11/9（週一）」等；今天回傳空字串 */
function dayLabel(ms) {
  if (ms == null) return '';
  const a = new Date(ms); a.setHours(0, 0, 0, 0);
  const b = new Date(now()); b.setHours(0, 0, 0, 0);
  const diff = Math.round((a - b) / 86400000);
  if (diff === 0) return '';
  const md = `${a.getMonth() + 1}/${a.getDate()}（週${'日一二三四五六'[a.getDay()]}）`;
  return diff === 1 ? `明天 ${md}` : diff === 2 ? `後天 ${md}` : diff === -1 ? `昨天 ${md}` : md;
}
/** 「明天 11/9（週一） 09:00」或今天只顯示「09:00」 */
const fmtWhen = (ms) => { const l = dayLabel(ms); return l ? `${l} ${fmtHM(ms)}` : fmtHM(ms); };

/** 回傳 { units, start, end, effNow, activeIdx, state } */
function compute() {
  const list = items();
  const c = clock();
  let base = c.start ?? plannedAt();
  const started = c.start != null;
  let cur = base;
  const units = list.map((it, i) => {
    const durMs = Math.max(1, Number(it.duration) || 1) * 60000;
    const u = { ...it, idx: i, durMs, rounds: Math.max(1, parseInt(it.rounds, 10) || 1), startMs: cur, endMs: cur == null ? null : cur + durMs };
    if (cur != null) cur += durMs;
    return u;
  });
  const effNow = c.pausedAt ?? now();
  let activeIdx = -1;
  let state = 'idle';
  if (started && units.length) {
    if (effNow < units[0].startMs) state = 'countdown';
    else if (effNow >= units.at(-1).endMs) state = 'done';
    else {
      state = c.pausedAt ? 'paused' : 'running';
      activeIdx = units.findIndex((u) => effNow >= u.startMs && effNow < u.endMs);
    }
  }
  return { units, start: base, end: cur, started, effNow, activeIdx, state, total: units.reduce((a, u) => a + u.durMs, 0) };
}

const ownersOf = (owner) => String(owner || '').split(/\s*[、,，/／&＆]\s*|\s+/).map((s) => s.trim()).filter(Boolean);
const allOwners = () => [...new Set(items().flatMap((it) => ownersOf(it.owner)))];
const isMine = (u) => { const me = meFor(S.code); return me.length && ownersOf(u.owner).some((o) => me.includes(o)); };

// ═════════════════════════ 寫入操作 ═════════════════════════
function log(text) {
  if (!S.code) return;
  S.be.push(S.code, 'log', { at: S.be.ts(), by: prefs.name || '建立者', text }).catch(() => {});
  S.be.set(S.code, 'updatedAt', S.be.ts()).catch(() => {});
}
const txClock = (fn) => S.be.tx(S.code, 'clock', (c) => fn(c || { start: null, pausedAt: null }));

async function startNow() {
  const t = now();
  await txClock(() => ({ start: t, pausedAt: null }));
  // 沒有原定時間時，以第一次開始的時刻當作「原定」，之後的延後／提前才有比較基準
  if (!S.ev?.plannedStart) await S.be.set(S.code, 'plannedStart', fmtHM(t)).catch(() => {});
  log('▶ 活動開始');
}
/** dateStr：YYYY-MM-DD，空白＝今天 */
async function setStartTime(hhmm, dateStr = '') {
  if (!hhmm) return;
  if (dateStr === todayYmd()) dateStr = '';
  const t = dateAt(dateStr, hhmm);
  await txClock((c) => ({ start: t, pausedAt: c.pausedAt ? now() : null }));
  // 原定日期跟著更新，「比原定晚／早幾分」才會以同一天比較
  if ((S.ev?.plannedDate || '') !== dateStr) await S.be.set(S.code, 'plannedDate', dateStr || null);
  if (!S.ev?.plannedStart) await S.be.set(S.code, 'plannedStart', hhmm).catch(() => {});
  log(`設定開始時間 ${fmtWhen(t)}`);
}
const startDateVal = () => $('startDate').value || '';
async function shift(min) {
  if (clock().start == null) return toast('請先開始活動或設定開始時間');
  await txClock((c) => (c.start == null ? c : { ...c, start: c.start + min * 60000 }));
  log(min > 0 ? `⏩ 後續延後 ${min} 分鐘` : `⏪ 後續提前 ${-min} 分鐘`);
  toast(min > 0 ? `已延後 ${min} 分鐘` : `已提前 ${-min} 分鐘`);
}
async function jumpTo(i, silent) {
  const list = items();
  const before = list.slice(0, i).reduce((a, it) => a + Math.max(1, Number(it.duration) || 1) * 60000, 0);
  await txClock((c) => { const base = c.pausedAt ?? now(); return { start: base - before, pausedAt: c.pausedAt ? base : null }; });
  if (!silent) log(i >= list.length ? '⏹ 結束活動' : `⏭ 從「${list[i]?.title}」開始`);
}
async function nextUnit() {
  const r = compute();
  if (!r.units.length) return;
  if (!r.started || r.state === 'countdown') { await jumpTo(0, true); log(`⏭ 提前開始「${r.units[0].title}」`); return; }
  if (r.state === 'done') return toast('活動已結束');
  const i = r.activeIdx;
  if (i >= r.units.length - 1 && !confirm('這是最後一個單元，要結束活動嗎？')) return;
  await jumpTo(i + 1);
}
async function togglePause() {
  const c = clock();
  if (c.start == null) return toast('活動還沒開始');
  if (c.pausedAt) {
    await txClock((x) => (x.pausedAt ? { start: x.start + (now() - x.pausedAt), pausedAt: null } : x));
    log('▶ 繼續');
  } else {
    await txClock((x) => (x.pausedAt || x.start == null ? x : { ...x, pausedAt: now() }));
    log('⏸ 暫停計時');
  }
}
async function resetClock() {
  if (!confirm('要回到「準備」階段嗎？（計時會重設為未開始）')) return;
  await S.be.set(S.code, 'clock', { start: null, pausedAt: null });
  log('↺ 計時重設');
}
async function adjustDur(i, delta) {
  const it = items()[i];
  if (!it) return;
  await S.be.tx(S.code, `items/${i}/duration`, (d) => Math.max(1, (Number(d) || 1) + delta));
  log(`「${it.title}」${delta > 0 ? '+' : ''}${delta} 分鐘`);
}
async function saveItems(list, msg) {
  await S.be.set(S.code, 'items', list.map(({ id, title, subtitle, owner, duration, rounds }) => ({
    id: id || newId(), title: title || '未命名', subtitle: subtitle || '', owner: owner || '', duration: Math.max(1, Math.round(Number(duration) || 1)), rounds: Math.max(1, parseInt(rounds, 10) || 1),
  })));
  if (msg) log(msg);
}
async function broadcast(text) {
  text = String(text || '').trim();
  if (!text) return;
  await S.be.set(S.code, 'broadcast', { id: newId(), text, by: prefs.name || '匿名', at: S.be.ts() });
  log(`📣 ${text}`);
  toast('已廣播');
}

// ═════════════════════════ 提醒：音效、震動、通知 ═════════════════════════
let audioCtx = null;
function unlockAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  audioCtx?.state === 'suspended' && audioCtx.resume();
}
function beep(pattern = [880, 0, 880]) {
  if (!prefs.sound || !audioCtx) return;
  let t = audioCtx.currentTime;
  pattern.forEach((f) => {
    if (f) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.25);
    }
    t += 0.28;
  });
}
function alertUser(text, { kind = 'remind', meta = '', sound } = {}) {
  showBanner(text, kind, meta);
  beep(sound || (kind === 'broadcast' ? [660, 880, 0, 660, 880] : kind === 'urgent' ? [988, 0, 988, 0, 988] : [784, 988]));
  if (prefs.vibrate && navigator.vibrate) navigator.vibrate(kind === 'urgent' ? [300, 120, 300, 120, 300] : [200, 100, 200]);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      navigator.serviceWorker?.ready.then((reg) => reg.showNotification('活動控場', { body: text, tag: 'ec', renotify: true, icon: 'icons/eventControl-192.png' }))
        .catch(() => new Notification('活動控場', { body: text }));
    } catch (e) {}
  }
}
let bannerTimer = null;
function showBanner(text, kind, meta) {
  const box = $('bannerBox');
  const styles = {
    broadcast: ['bg-indigo-600 text-white', 'ph-megaphone'],
    urgent: ['bg-rose-600 text-white', 'ph-alarm'],
    remind: ['bg-amber-400 text-slate-900', 'ph-bell-ringing'],
  }[kind] || ['bg-emerald-600 text-white', 'ph-info'];
  box.className = `slide-down max-w-xl mx-auto rounded-2xl shadow-2xl p-4 flex items-start gap-3 cursor-pointer ${styles[0]}`;
  $('bannerIcon').className = `ph-fill ${styles[1]} text-3xl`;
  $('bannerText').textContent = text;
  $('bannerMeta').textContent = meta;
  $('banner').classList.remove('hidden');
  void box.offsetWidth; box.classList.remove('slide-down'); void box.offsetWidth; box.classList.add('slide-down');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.add('hidden'), kind === 'broadcast' ? 12000 : 9000);
}

function checkReminders(r) {
  if (!r.started || clock().pausedAt) return;
  const t = r.effNow;
  const lead = Number(prefs.lead) || 3;
  for (const u of r.units) {
    const mine = isMine(u);
    const pts = [];
    if (mine) {
      if (u.idx > 0 || lead) pts.push([u.startMs - lead * 60000, 'pre', `${lead} 分鐘後輪到你：${u.title}`, 'remind']);
      pts.push([u.startMs, 'start', `現在開始：${u.title}（你負責）`, 'remind']);
      if (u.durMs > 90000) pts.push([u.endMs - 60000, 'end1', `剩 1 分鐘：${u.title}`, 'urgent']);
      pts.push([u.endMs, 'end', `時間到：${u.title}`, 'urgent']);
    } else if (prefs.remindAll) {
      if (u.durMs > 90000) pts.push([u.endMs - 60000, 'end1', `剩 1 分鐘：${u.title}（${u.owner || '未指定'}）`, 'remind']);
      pts.push([u.endMs, 'end', `時間到：${u.title}`, 'remind']);
    }
    for (const [at, k, msg, kind] of pts) {
      const key = `${S.code}|${u.id}|${k}|${at}`;
      if (t >= at && t - at < 8000 && !S.fired.has(key)) {
        S.fired.add(key);
        alertUser(msg, { kind, meta: fmtHM(at) });
      }
    }
  }
}

async function setWake(on) {
  try {
    if (on) {
      if (!('wakeLock' in navigator)) { toast('這個瀏覽器不支援保持恆亮，請到手機設定調長「自動鎖定」時間'); return false; }
      if (!S.wakeLock || S.wakeLock.released) {
        S.wakeLock = await navigator.wakeLock.request('screen');
        S.wakeLock.addEventListener('release', () => {
          updateWakeUI();
          // 被系統釋放（例如省電模式）但頁面還在前景時，再要一次
          if (prefs.wake && S.code && !document.hidden) setTimeout(() => prefs.wake && !document.hidden && setWake(true), 1000);
        });
      }
    } else if (S.wakeLock) {
      const l = S.wakeLock; S.wakeLock = null;
      await l.release().catch(() => {});
    }
    return true;
  } catch (e) {
    if (on) toast('此裝置目前無法保持恆亮（可能是省電模式）');
    return false;
  } finally { updateWakeUI(); }
}
const wakeOn = () => !!(S.wakeLock && !S.wakeLock.released);
function updateWakeUI() {
  const b = document.getElementById('wakeBtn');
  if (!b) return;
  const on = wakeOn();
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? '螢幕保持恆亮中（點一下關閉）' : '點一下讓螢幕保持恆亮';
  b.classList.toggle('dock-on', on);
  b.innerHTML = on ? '<i class="ph-fill ph-sun text-2xl"></i><span class="text-[10px] font-bold leading-none">恆亮中</span>'
    : '<i class="ph-bold ph-sun-dim text-2xl"></i><span class="text-[10px] font-medium leading-none">恆亮</span>';
  const cb = document.getElementById('setWake');
  if (cb) cb.checked = prefs.wake;
}
async function toggleWake() {
  const turnOn = !wakeOn();
  prefs.wake = turnOn; savePrefs();
  const ok = await setWake(turnOn);
  if (turnOn && !ok) { prefs.wake = false; savePrefs(); updateWakeUI(); return; }
  toast(turnOn ? '螢幕會保持恆亮，不會自動變暗' : '已關閉恆亮，螢幕會依手機設定變暗');
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && prefs.wake && S.code) setWake(true); });

// ═════════════════════════ 渲染 ═════════════════════════
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'px-4 py-2 rounded-xl bg-slate-900/90 text-white text-sm shadow-lg dark:bg-white/90 dark:text-slate-900';
  el.textContent = msg;
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function ownerChips(owner, big) {
  const me = meFor(S.code);
  return ownersOf(owner).map((o) => `<span class="inline-flex items-center gap-1 ${big ? 'text-sm px-2.5 py-1' : 'text-xs px-2 py-0.5'} rounded-full font-semibold ${me.includes(o) ? 'bg-amber-400 text-slate-900' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}"><i class="ph-bold ph-user"></i>${esc(o)}</span>`).join('');
}

function renderFlow(r) {
  const sig = JSON.stringify([items(), clock(), S.ev?.plannedStart, meFor(S.code)]);
  if (sig === S.listSig && r.activeIdx === S.activeIdx) return;
  S.listSig = sig;
  S.activeIdx = r.activeIdx;
  const list = $('flowList');
  if (!r.units.length) {
    list.innerHTML = `<div class="text-center text-sm text-slate-500 dark:text-slate-400 py-10 bg-white dark:bg-slate-900 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700">還沒有流程。按下方「匯入流程」或「新增單元」。</div>`;
    return;
  }
  list.innerHTML = r.units.map((u) => {
    const time = u.startMs != null ? `${fmtHM(u.startMs)}–${fmtHM(u.endMs)}` : `${u.duration} 分`;
    const rounds = u.rounds > 1 ? `<div class="mt-2 flex flex-wrap gap-1" data-rounds="${u.idx}">${Array.from({ length: u.rounds }, (_, k) => `<span data-round="${k}" class="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono">R${k + 1}${u.startMs != null ? ' ' + fmtHM(u.startMs + (u.durMs / u.rounds) * k) : ''}</span>`).join('')}</div>` : '';
    return `<article id="row-${u.idx}" class="row rounded-2xl border bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 p-3 sm:p-4 transition">
      <div class="flex gap-3">
        <div class="flex flex-col items-center gap-1 w-9 shrink-0">
          <span class="row-num w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold bg-slate-100 dark:bg-slate-800">${u.idx + 1}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="font-mono text-xs text-slate-500 dark:text-slate-400 tnum">${time}</span>
            <span class="row-badge text-[11px] font-bold px-2 py-0.5 rounded-full"></span>
          </div>
          <h3 class="row-title font-bold text-base leading-snug mt-0.5 break-words">${esc(u.title)}</h3>
          ${u.subtitle ? `<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${esc(u.subtitle)}</p>` : ''}
          <div class="mt-1.5 flex flex-wrap gap-1">${ownerChips(u.owner)}</div>
          ${rounds}
          <div class="row-bar-wrap hidden mt-2 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"><div class="row-bar h-full bg-emerald-500" style="width:0%"></div></div>
        </div>
        <div class="flex flex-col items-end gap-1.5 shrink-0">
          <div class="flex items-center rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
            <button class="px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800" data-act="dur" data-i="${u.idx}" data-d="-1"><i class="ph-bold ph-minus"></i></button>
            <span class="font-mono text-sm font-bold w-9 text-center tnum">${u.duration}</span>
            <button class="px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800" data-act="dur" data-i="${u.idx}" data-d="1"><i class="ph-bold ph-plus"></i></button>
          </div>
          <div class="flex gap-1">
            <button class="btn btn-ghost !px-2 !py-1 text-xs" data-act="jump" data-i="${u.idx}" title="從這裡開始"><i class="ph-bold ph-play"></i></button>
            <button class="btn btn-ghost !px-2 !py-1 text-xs" data-act="edit" data-i="${u.idx}" title="編輯"><i class="ph-bold ph-pencil-simple"></i></button>
          </div>
        </div>
      </div>
    </article>`;
  }).join('');
}

function paintRows(r) {
  r.units.forEach((u) => {
    const row = $('row-' + u.idx);
    if (!row) return;
    const badge = row.querySelector('.row-badge');
    const num = row.querySelector('.row-num');
    const bw = row.querySelector('.row-bar-wrap');
    let st = 'plan';
    if (r.started && u.startMs != null) st = r.effNow >= u.endMs ? 'done' : r.effNow >= u.startMs ? 'active' : 'up';
    const mine = isMine(u);
    row.className = 'row rounded-2xl border p-3 sm:p-4 transition ' + (
      st === 'active' ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-400 dark:border-emerald-500/60 active-glow'
        : st === 'done' ? 'bg-white/60 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 opacity-60'
          : 'bg-white dark:bg-slate-900 ' + (mine ? 'border-amber-300 dark:border-amber-500/40' : 'border-slate-200 dark:border-slate-800'));
    const [txt, cls] = {
      active: [clock().pausedAt ? '暫停中' : '進行中', 'bg-emerald-500 text-white'],
      done: ['已結束', 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400'],
      up: [u.startMs - r.effNow < 3600000 ? `${Math.ceil((u.startMs - r.effNow) / 60000)} 分後` : '稍後', 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'],
      plan: [mine ? '我負責' : '', mine ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' : ''],
    }[st];
    badge.textContent = mine && st === 'up' ? `我負責・${txt}` : txt;
    badge.className = 'row-badge text-[11px] font-bold px-2 py-0.5 rounded-full ' + cls;
    num.className = 'row-num w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' + (st === 'active' ? 'bg-emerald-500 text-white' : st === 'done' ? 'bg-slate-200 dark:bg-slate-800 text-slate-400' : 'bg-slate-100 dark:bg-slate-800');
    if (st === 'active') {
      bw.classList.remove('hidden');
      row.querySelector('.row-bar').style.width = Math.min(100, ((r.effNow - u.startMs) / u.durMs) * 100) + '%';
    } else bw.classList.add('hidden');
    if (u.rounds > 1) {
      const rd = u.durMs / u.rounds;
      row.querySelectorAll('[data-round]').forEach((el) => {
        const k = +el.dataset.round, s = u.startMs + rd * k, e = s + rd;
        const on = r.started && r.effNow >= s && r.effNow < e, past = r.started && r.effNow >= e;
        el.className = 'text-[11px] px-2 py-0.5 rounded-md font-mono ' + (on ? 'bg-emerald-500 text-white font-bold' : past ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 line-through' : 'bg-slate-100 dark:bg-slate-800 text-slate-500');
      });
    }
  });
}

function renderFocus(r) {
  const c = clock();
  const card = $('focusCard');
  const u = r.activeIdx >= 0 ? r.units[r.activeIdx] : null;
  const next = u ? r.units[r.activeIdx + 1] : r.state === 'countdown' || r.state === 'idle' ? r.units[0] : null;
  let status = '未開始', statusCls = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  let title = '', idx = '', sub = '', range = '', cd = '--:--', cdLabel = '', bar = 0, owner = '';
  let warn = false;

  if (!r.units.length) { title = '尚無流程'; sub = '請先匯入或新增單元'; }
  else if (r.state === 'idle') {
    title = '尚未開始'; sub = r.start ? `預定 ${fmtWhen(r.start)} 開始，共 ${Math.round(r.total / 60000)} 分鐘` : '按「現在開始」或設定開始時間';
    cdLabel = r.start ? '距預定開始' : ''; cd = r.start ? fmtCd(r.start - now()) : '--:--';
  } else if (r.state === 'countdown') {
    status = '倒數開始'; statusCls = 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300';
    title = '即將開始'; sub = `${fmtWhen(r.start)} 開始`; cdLabel = '距離開始'; cd = fmtCd(r.start - r.effNow);
  } else if (r.state === 'done') {
    status = '已結束'; title = '活動結束 🎉'; sub = `${fmtWhen(r.start)}–${fmtHM(r.end)}，共 ${Math.round(r.total / 60000)} 分鐘`; bar = 100;
  } else if (u) {
    const remain = u.endMs - r.effNow;
    warn = remain <= 60000;
    status = c.pausedAt ? '⏸ 暫停中' : warn ? '最後 1 分鐘' : '進行中';
    statusCls = c.pausedAt ? 'bg-slate-500 text-white' : warn ? 'bg-rose-500 text-white animate-pulse' : 'bg-emerald-500 text-white';
    idx = `第 ${u.idx + 1} / ${r.units.length} 單元`;
    status += `・${u.idx + 1} / ${r.units.length}`;
    title = u.title; sub = u.subtitle || ''; owner = ownerChips(u.owner, true);
    range = `${fmtHM(u.startMs)}–${fmtHM(u.endMs)}`;
    cdLabel = '剩餘時間'; cd = fmtCd(remain);
    bar = ((r.effNow - u.startMs) / u.durMs) * 100;
  }
  card.className = 'rounded-3xl border-2 p-4 sm:p-6 transition-all ' + (u && warn ? 'border-rose-400 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/60 warn-glow' : u ? 'border-emerald-400 bg-white dark:bg-slate-900 dark:border-emerald-500/50 active-glow' : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900');
  $('fStatus').textContent = status; $('fStatus').className = 'px-2.5 py-1 rounded-full text-xs font-bold ' + statusCls;
  $('fRange').textContent = range ? `・${range}` : ''; $('fTitle').textContent = title; $('fSub').textContent = sub;
  if ($('fOwner').dataset.v !== owner) { $('fOwner').innerHTML = owner; $('fOwner').dataset.v = owner; }
  $('fCdLabel').textContent = cdLabel; $('fCountdown').textContent = cd;
  $('fCountdown').className = 'mt-4 font-mono font-extrabold tnum leading-none tracking-tight ' + (cd.length > 9 ? 'text-[44px] sm:text-[72px] ' : 'text-[84px] sm:text-[104px] ') + (u && warn ? 'text-rose-600 dark:text-rose-400' : c.pausedAt ? 'text-slate-400' : '');
  $('fCountdown').classList.toggle('hidden', cd === '--:--');
  // 與原定時間的差距（方案 C）：延後／提前、暫停後繼續都會反映在 clock.start
  const dm = r.state === 'running' || r.state === 'paused' ? driftMin(r) : null;
  const dEl = $('fDrift');
  if (dm == null) dEl.classList.add('hidden');
  else {
    const [txt, cls] = dm > 0 ? [`比原定晚 ${dm} 分`, 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200']
      : dm < 0 ? [`比原定早 ${-dm} 分`, 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200']
        : ['準時', 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'];
    dEl.textContent = txt;
    dEl.title = `原定 ${fmtHM(plannedAt())} 開始，實際（含延後、暫停）${fmtHM(r.start)}`;
    dEl.className = 'px-3 py-1 rounded-full text-sm font-bold tnum shrink-0 ' + cls;
  }
  $('fBar').style.width = Math.max(0, Math.min(100, bar)) + '%';
  $('fBar').className = 'h-full transition-[width] duration-500 ' + (warn ? 'bg-rose-500' : 'bg-emerald-500');
  // 回合
  let rh = '';
  if (u && u.rounds > 1) {
    const rd = u.durMs / u.rounds, k = Math.min(u.rounds - 1, Math.floor((r.effNow - u.startMs) / rd));
    rh = `<span class="text-xs font-bold px-2.5 py-1 rounded-full bg-indigo-500 text-white">第 ${k + 1} / ${u.rounds} 回合・剩 ${fmtCd(u.startMs + rd * (k + 1) - r.effNow)}</span>`;
  }
  $('fRounds').innerHTML = rh;
  // 接下來
  if (next && r.state !== 'idle' && r.state !== 'countdown') {
    $('nextCard').classList.remove('hidden');
    $('nTitle').textContent = next.title;
    $('nMeta').textContent = [next.owner, `${next.duration} 分`].filter(Boolean).join('・');
    $('nTime').textContent = next.startMs != null ? fmtHM(next.startMs) : '';
  } else $('nextCard').classList.add('hidden');
  $('fTotal').textContent = r.started && r.state !== 'countdown' ? `全場 ${Math.min(100, Math.max(0, Math.round(((r.effNow - r.start) / r.total) * 100)))}%・預計 ${fmtHM(r.end)} 結束` : '';
  $('totalInfo').textContent = r.units.length ? `${r.units.length} 個單元・${Math.round(r.total / 60000)} 分鐘${r.start ? `・${fmtWhen(r.start)}–${fmtHM(r.end)}` : ''}` : '';

  // 底部按鈕
  $('pauseBtn').innerHTML = c.pausedAt ? '<i class="ph-fill ph-play text-xl"></i>繼續' : '<i class="ph-fill ph-pause text-xl"></i>暫停';
  $('nextBtn').innerHTML = !r.started || r.state === 'countdown' ? '<i class="ph-fill ph-play text-xl"></i>立刻開始第 1 個'
    : r.activeIdx === r.units.length - 1 ? '<i class="ph-bold ph-flag-checkered text-xl"></i>結束活動'
      : '<i class="ph-bold ph-skip-forward text-xl"></i>下一單元';

  // 控場面板
  if ($('controlModal').classList.contains('open')) {
    $('cNow').innerHTML = u ? `目前：${esc(u.title)}・剩 <span class="font-mono font-semibold text-slate-900 dark:text-white tnum">${cd}</span>${c.pausedAt ? '（暫停中）' : ''}${dm ? `・${dm > 0 ? '晚' : '早'} ${Math.abs(dm)} 分` : ''}`
      : r.state === 'countdown' ? `${fmtWhen(r.start)} 開始・還有 <span class="font-mono font-semibold tnum">${cd}</span>`
        : r.state === 'done' ? '活動已結束' : r.units.length ? '尚未開始' : '還沒有流程';
    $('cRunBox').classList.toggle('hidden', !r.started);
    $('cDurBox').classList.toggle('hidden', !u);
    if (u) $('cDur').textContent = `${u.duration} 分`;
  }

  // 我的提醒摘要
  const me = meFor(S.code);
  const nextMine = r.units.find((x) => isMine(x) && (x.startMs == null || x.endMs > r.effNow));
  if (me.length && nextMine) {
    $('mineCard').classList.remove('hidden');
    const live = nextMine.startMs != null && r.effNow >= nextMine.startMs;
    $('mineTitle').textContent = live ? `你負責的單元進行中：${nextMine.title}` : `輪到你：${nextMine.title}`;
    $('mineMeta').textContent = nextMine.startMs == null ? `${nextMine.duration} 分・開始後會提前 ${prefs.lead} 分提醒`
      : live ? `到 ${fmtHM(nextMine.endMs)}・結束前 1 分提醒`
        : `約 ${Math.max(1, Math.ceil((nextMine.startMs - r.effNow) / 60000))} 分鐘後（${fmtHM(nextMine.startMs)}）・提前 ${prefs.lead} 分提醒`;
  } else $('mineCard').classList.add('hidden');

  // 大字卡
  if (S.stage) {
    $('sClock').textContent = fmtHM(now(), true);
    $('sIndex').textContent = idx || status;
    $('sTitle').textContent = title;
    $('sOwner').textContent = u ? u.owner || '' : sub;
    $('sCountdown').textContent = cd;
    $('sCountdown').style.color = u && warn ? '#fb7185' : c.pausedAt ? '#94a3b8' : '';
    $('sNext').textContent = next ? `下一個：${next.title}${next.owner ? '・' + next.owner : ''}` : '';
  }
}

// ═════════════════════════ 三階段：準備 → 進行 → 結束 ═════════════════════════
const phaseOf = (r) => (r.state === 'running' || r.state === 'paused' ? 'live' : r.state === 'done' ? 'done' : 'prep');
const PHASES = ['prep', 'live', 'done'];

function syncBars() {
  const w = S.tab === 'watch';
  $('bottomBar').classList.toggle('hidden', !(w && S.phase === 'live'));
  $('prepBar').classList.toggle('hidden', !(w && S.phase === 'prep'));
}

/**
 * 舊活動（v8 以前建立、沒有原定時間）補上比較基準：
 * 以最後一次「▶ 活動開始／⏭ 提前開始」紀錄的時刻當原定；找不到就以目前的開始時間當原定（之後的延後／提前才開始累計）
 */
function ensureBaseline(r) {
  if (!r.started || S.ev?.plannedStart || S.baselineFor === S.code) return;
  S.baselineFor = S.code;
  const starts = Object.values(S.ev?.log || {}).filter((l) => l && typeof l.at === 'number' && /^(▶ 活動開始|⏭ 提前開始)/.test(l.text || '')).sort((a, b) => b.at - a.at);
  const t = starts.length ? starts[0].at : r.start;
  if (t == null) return;
  const day = ymd(t) === todayYmd() ? null : ymd(t);
  S.be.set(S.code, 'plannedStart', fmtHM(t)).catch(() => {});
  if ((S.ev?.plannedDate || null) !== day) S.be.set(S.code, 'plannedDate', day).catch(() => {});
}

function renderPhase(r) {
  ensureBaseline(r);
  const ph = phaseOf(r);
  if (ph !== S.phase) {
    S.phase = ph;
    $('phPrep').classList.toggle('hidden', ph !== 'prep');
    $('phLive').classList.toggle('hidden', ph !== 'live');
    $('phDone').classList.toggle('hidden', ph !== 'done');
    const at = PHASES.indexOf(ph);
    document.querySelectorAll('#phaseBar li').forEach((li) => {
      const k = PHASES.indexOf(li.dataset.phase);
      li.querySelector('.ph-seg').className = 'ph-seg h-[5px] rounded-full ' + (k === at ? 'bg-emerald-500' : k < at ? 'bg-slate-400 dark:bg-slate-600' : 'bg-slate-200 dark:bg-slate-800');
      li.querySelector('.ph-lbl').className = 'ph-lbl text-xs ' + (k === at ? 'font-bold text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400');
      if (k === at) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    if (ph !== 'live' && $('controlModal').classList.contains('open')) closeModals();
    S.doneSig = '';
    syncBars();
  }
  if (ph === 'prep') renderPrep(r);
  else if (ph === 'done') renderDone(r);
}

function setChk(id, ok, n) {
  const el = $(id);
  const v = ok ? 'ok' : String(n);
  if (el.dataset.v === v) return ok;
  el.dataset.v = v;
  el.classList.toggle('ok', ok);
  el.innerHTML = ok ? '<i class="ph-bold ph-check"></i>' : String(n);
  return ok;
}

function renderPrep(r) {
  const n = r.units.length;
  const counting = r.state === 'countdown';
  const me = meFor(S.code);
  const owners = allOwners();
  const ppl = Object.entries(S.ev?.presence || {});
  const others = ppl.filter(([uid]) => uid !== S.be.uid).map(([, p]) => p.name || '匿名');
  let ok = 0;
  // 1 流程
  ok += setChk('pk1', n > 0, 1);
  $('pt1').textContent = n ? `${n} 個單元・共 ${Math.round(r.total / 60000)} 分・負責人 ${owners.length} 位` : '還沒有流程';
  $('pb1').textContent = n ? '編輯' : '匯入';
  if (n) { $('pb1').dataset.act = 'tab'; $('pb1').dataset.tab = 'flow'; } else $('pb1').dataset.act = 'import';
  // 2 開始時間
  ok += setChk('pk2', counting, 2);
  $('pt2').textContent = counting ? `${fmtWhen(r.start)} 自動開始・還有 ${fmtCd(r.start - r.effNow)}` : '選好時間按「設定」，到點自動開始（預設今天，可改日期）';
  $('pb2').textContent = counting ? '更新' : '設定';
  // 3 邀請
  ok += setChk('pk3', others.length > 0, 3);
  $('pt3').textContent = others.length ? `已加入 ${others.length} 人：${others.join('、')}` : '把代碼或 QR Code 傳給一起控場的夥伴';
  if ($('prepCode').textContent !== S.code) {
    $('prepCode').textContent = S.code;
    try { window.QRious && new window.QRious({ element: $('prepQR'), value: shareUrl(), size: 128, level: 'M' }); } catch (e) {}
  }
  // 4 我是誰
  ok += setChk('pk4', !!prefs.name && (me.length > 0 || !owners.length), 4);
  $('pt4a').textContent = prefs.name ? `我是 ${prefs.name}` : '我是誰';
  const mine = r.units.filter(isMine).map((u) => u.title);
  $('pt4').textContent = me.length ? (mine.length ? `負責「${mine.join('」「')}」・提前 ${prefs.lead} 分提醒` : `負責人：${me.join('、')}`)
    : owners.length ? '還沒選你負責的人名，選了才會提醒你' : '流程表裡沒有負責人，可略過';
  // 5 測試提醒
  ok += setChk('pk5', !!lsGet('ec_tested_' + S.code, false), 5);

  $('prepHint').textContent = n ? `準備清單完成 ${ok} / 5・不必全部完成也能開始` : '先匯入流程表，其他步驟可以之後再補';
  $('prepStartText').textContent = counting ? '提前，現在開始' : '現在開始';
  $('prepBarHint').textContent = !n ? '' : counting ? `或等 ${fmtCd(r.start - r.effNow)} 後自動進入「進行」` : '設定開始時間就會到點自動開始，也可以直接開始';
}

function renderDone(r) {
  const sig = JSON.stringify([S.listSig, r.start]);
  if (sig === S.doneSig) return;
  S.doneSig = sig;
  $('dRange').textContent = r.start != null ? `${fmtWhen(r.start)} – ${fmtHM(r.end)}・共 ${Math.round(r.total / 60000)} 分` : '';
  let drift = '';
  const d = driftMin(r);
  if (d != null) drift = d > 0 ? `比原定時間晚 ${d} 分` : d < 0 ? `比原定時間早 ${-d} 分` : '與原定時間一致';
  $('dDrift').textContent = drift;
  $('dCount').textContent = `${r.units.length} 個單元`;
  $('dList').innerHTML = r.units.map((u) => `<div class="flex items-center gap-3 py-2 text-sm"><span class="font-mono text-xs text-slate-500 dark:text-slate-400 tnum shrink-0">${fmtHM(u.startMs)}–${fmtHM(u.endMs)}</span><span class="flex-1 truncate">${esc(u.title)}</span><span class="text-xs text-slate-500 dark:text-slate-400 shrink-0">${esc(u.owner || '')}</span></div>`).join('');
}

/** 看時間畫面的「今日流程」：已完成收成一行，之後只列 4 個 */
function renderPreview(r) {
  const sig = JSON.stringify([S.listSig, r.activeIdx, r.state, r.started && r.units.map((u) => u.startMs)]);
  if (sig === S.previewSig) return;
  S.previewSig = sig;
  $('previewAll').textContent = `全部 ${r.units.length} 個 ›`;
  if (!r.units.length) {
    $('previewList').innerHTML = `<button data-act="import" class="w-full py-5 text-sm text-emerald-700 dark:text-emerald-400 font-medium">還沒有流程，點這裡匯入</button>`;
    return;
  }
  const doneCount = r.started ? r.units.filter((u) => r.effNow >= u.endMs).length : 0;
  const from = r.state === 'done' ? Math.max(0, r.units.length - 4) : doneCount;
  const rows = [];
  if (doneCount && r.state !== 'done') {
    const d = r.units.slice(0, doneCount);
    rows.push(`<div class="flex items-center gap-3 py-2 text-sm text-slate-500 dark:text-slate-400"><span class="font-mono text-xs w-10 tnum">${fmtHM(d[0].startMs)}</span><span class="flex-1 truncate line-through">${esc(d.map((x) => x.title).join('・'))}</span><span class="text-xs shrink-0">已完成 ${doneCount}</span></div>`);
  }
  r.units.slice(from, from + 4).forEach((u) => {
    const active = u.idx === r.activeIdx;
    const done = r.started && r.effNow >= u.endMs;
    const mine = isMine(u);
    const t = u.startMs != null ? fmtHM(u.startMs) : `${u.duration}分`;
    rows.push(`<div class="flex items-center gap-3 py-2 text-sm ${active ? 'font-bold text-emerald-700 dark:text-emerald-400' : done ? 'text-slate-400 line-through' : ''}"><span class="font-mono text-xs w-10 tnum ${active ? '' : 'text-slate-500 dark:text-slate-400'}">${t}</span><span class="flex-1 truncate">${esc(u.title)}</span>${mine ? '<span class="text-[11px] font-bold text-amber-800 bg-amber-100 dark:bg-amber-500/20 dark:text-amber-200 px-2 py-0.5 rounded-full shrink-0">你</span>' : ''}${active ? '<span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>' : ''}</div>`);
  });
  $('previewList').innerHTML = rows.join('');
}

function renderPeople() {
  const ppl = Object.entries(S.ev?.presence || {});
  $('onlineCount').textContent = `${ppl.length} 人在線`;
  $('peopleList').innerHTML = ppl.length ? ppl.map(([uid, p]) => `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm ${uid === S.be.uid ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200' : 'bg-slate-100 dark:bg-slate-800'}"><span class="w-2 h-2 rounded-full bg-emerald-500"></span>${esc(p.name || '匿名')}${p.me ? `<span class="text-xs opacity-70">（${esc(p.me)}）</span>` : ''}</span>`).join('') : '<span class="text-sm text-slate-500">沒有人</span>';
  const logs = Object.values(S.ev?.log || {}).filter((x) => x && typeof x.at === 'number').sort((a, b) => b.at - a.at).slice(0, 40);
  $('logList').innerHTML = logs.length ? logs.map((l) => `<li class="flex gap-2"><span class="font-mono text-xs text-slate-400 shrink-0 pt-0.5 tnum">${fmtHM(l.at)}</span><span class="font-semibold shrink-0">${esc(l.by)}</span><span class="text-slate-600 dark:text-slate-300 break-words min-w-0">${esc(l.text)}</span></li>`).join('') : '<li class="text-slate-500">尚無紀錄</li>';
}

function renderMePicker(el, code) {
  const me = meFor(code);
  const names = allOwners();
  el.innerHTML = names.length ? names.map((n) => `<button type="button" data-act="toggle-me" data-name="${esc(n)}" class="px-3 py-1.5 rounded-full text-sm font-semibold border ${me.includes(n) ? 'bg-amber-400 text-slate-900 border-amber-400' : 'border-slate-300 dark:border-slate-700'}">${esc(n)}</button>`).join('') : '<span class="text-xs text-slate-500">流程表裡還沒有負責人</span>';
}

function renderSettings() {
  if (document.activeElement !== $('setName')) $('setName').value = prefs.name;
  if (document.activeElement !== $('setTitle')) $('setTitle').value = S.ev?.title || '';
  $('setLead').value = String(prefs.lead);
  $('setAll').checked = prefs.remindAll;
  $('setSound').checked = prefs.sound;
  $('setVibrate').checked = prefs.vibrate;
  $('setWake').checked = prefs.wake;
  renderMePicker($('setMe'), S.code);
  const np = 'Notification' in window ? Notification.permission : 'unsupported';
  $('notifyBtn').classList.toggle('hidden', np === 'granted' || np === 'unsupported');
}

/** 日期按鈕：今天＝「今天」；別天＝「明天 11/9（週一）」並顯示「改回今天」 */
function renderDateCtl() {
  const v = startDateVal();
  const other = v && v !== todayYmd();
  $('dateLbl').textContent = other ? dayLabel(dateAt(v, '12:00')) : '今天';
  $('dateBtn').className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full border ' + (other ? 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/50 font-semibold' : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300');
  $('dateReset').classList.toggle('hidden', !other);
  $('startDate').min = todayYmd();
}

function renderAll() {
  if (!S.ev) return;
  $('evTitle').textContent = S.ev.title || '活動';
  document.title = `${S.ev.title || '活動'}・活動控場`;
  $('evCode').textContent = S.code;
  const c = clock();
  const st = c.start ?? plannedAt();
  if (document.activeElement !== $('startInput')) $('startInput').value = st ? fmtHM(st) : '';
  if (document.activeElement !== $('startDate')) $('startDate').value = st && ymd(st) !== todayYmd() ? ymd(st) : '';
  renderDateCtl();
  renderPeople();
  renderSettings();
  tick();
}

function tick() {
  $('nowClock') && ($('nowClock').textContent = fmtHM(now(), true));
  if (!S.ev) return;
  const r = compute();
  renderFlow(r);
  paintRows(r);
  renderFocus(r);
  renderPreview(r);
  renderPhase(r);
  checkReminders(r);
}

// ═════════════════════════ 活動進出 ═════════════════════════
function recent() { return lsGet('ec_recent', []); }
function addRecent(code, title) { lsSet('ec_recent', [{ code, title, at: Date.now() }, ...recent().filter((x) => x.code !== code)].slice(0, 8)); }
function renderRecent() {
  const list = recent();
  $('recentSection').classList.toggle('hidden', !list.length);
  $('recentList').innerHTML = list.map((x) => `<div class="flex items-center gap-2 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
    <button class="flex-1 text-left min-w-0" data-act="open-recent" data-code="${x.code}"><div class="font-semibold truncate">${esc(x.title || '未命名活動')}</div><div class="text-xs text-slate-500 font-mono">${x.code}・${new Date(x.at).toLocaleDateString()}</div></button>
    <button class="btn btn-ghost !p-2" data-act="forget-recent" data-code="${x.code}" title="從清單移除"><i class="ph-bold ph-x"></i></button></div>`).join('');
}

async function genCode() {
  for (let n = 0; n < 20; n++) {
    let c = '';
    const b = crypto.getRandomValues(new Uint8Array(4));
    b.forEach((x) => (c += CODE_CHARS[x % CODE_CHARS.length]));
    if (!(await S.be.exists(c))) return c;
  }
  throw new Error('無法產生代碼');
}

async function enterEvent(code, { fresh = false } = {}) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) return toast('代碼是 4 碼英數字');
  if (!S.be) return toast('尚未連線，請稍候');
  if (!fresh && !(await S.be.exists(code))) return toast(`找不到活動 ${code}`);
  leaveEvent(true);
  S.code = code;
  S.ev = null;
  S.listSig = '';
  S.phase = null;
  S.lastBcId = lsGet('ec_bc_' + code, null);
  let first = true;
  S.unwatch = S.be.watch(code, (val) => {
    if (!val) {
      if (!first || !fresh) { toast('這場活動已被刪除'); leaveEvent(); }
      return;
    }
    S.ev = val;
    addRecent(code, val.title);
    handleBroadcast(val.broadcast, first);
    renderAll();
    if (first) {
      first = false;
      if (!prefs.name || (!meFor(code).length && allOwners().length && !lsGet('ec_asked_' + code, false))) openWho();
      else if (S.justCreated) { S.justCreated = false; openShare(); }
    }
  });
  // 活動代碼放在 #e=XXXX（不用 ?e=），網址的路徑與查詢字串維持乾淨，Android Chrome 才能正常「安裝」
  history.replaceState(null, '', `${location.pathname}${S.be.kind === 'mock' ? '?mock=1' : ''}#e=${code}`);
  $('homeView').classList.add('hidden');
  $('eventView').classList.remove('hidden');
  setTab('watch');
  updatePresence();
  if (prefs.wake) setWake(true);
}

function leaveEvent(silent) {
  S.unwatch?.(); S.unwatch = null;
  S.leavePresence?.(); S.leavePresence = null;
  S.code = null; S.ev = null;
  setWake(false);
  if (!silent) {
    history.replaceState(null, '', location.pathname + (S.be?.kind === 'mock' ? '?mock=1' : ''));
    $('eventView').classList.add('hidden');
    $('homeView').classList.remove('hidden');
    document.title = '活動控場';
    renderRecent();
  }
}

async function updatePresence() {
  if (!S.code) return;
  S.leavePresence?.();
  S.leavePresence = await S.be.presence(S.code, { name: prefs.name || '匿名', me: meFor(S.code).join('、') }).catch(() => null);
}

function handleBroadcast(bc, initial) {
  if (!bc || !bc.id || bc.id === S.lastBcId) return;
  S.lastBcId = bc.id;
  lsSet('ec_bc_' + S.code, bc.id);
  const age = typeof bc.at === 'number' ? now() - bc.at : 0;
  if (initial && age > 90000) return;
  alertUser(bc.text, { kind: 'broadcast', meta: `${bc.by} 廣播・${typeof bc.at === 'number' ? fmtHM(bc.at) : ''}` });
}

// ═════════════════════════ Modal ═════════════════════════
const openModal = (id) => $(id).classList.add('open');
const closeModals = () => document.querySelectorAll('.modal.open').forEach((m) => m.id !== 'stageModal' && m.classList.remove('open'));

function openWho() {
  $('whoTitle').textContent = S.ev?.title || '';
  $('whoName').value = prefs.name;
  renderMePicker($('whoMe'), S.code);
  openModal('whoModal');
}

function openItem(i) {
  S.editIdx = i;
  const it = i >= 0 ? items()[i] : { title: '', subtitle: '', owner: '', duration: 5, rounds: 1 };
  $('itemModalTitle').textContent = i >= 0 ? `編輯第 ${i + 1} 單元` : '新增單元';
  $('itTitle').value = it.title || '';
  $('itSub').value = it.subtitle || '';
  $('itOwner').value = it.owner || '';
  $('itDur').value = it.duration || 5;
  $('itRounds').value = it.rounds || 1;
  document.querySelectorAll('[data-act=item-move],[data-act=item-delete]').forEach((b) => b.classList.toggle('hidden', i < 0));
  openModal('itemModal');
  setTimeout(() => $('itTitle').focus(), 50);
}

function openImport(mode) {
  S.impMode = mode;
  S.imp = null;
  $('pasteInput').value = '';
  $('fileInput').value = '';
  $('impPreview').classList.add('hidden');
  $('impFooter').classList.add('hidden');
  $('impAppendBtn').classList.toggle('hidden', mode === 'create' || !items().length);
  $('impApplyText').textContent = mode === 'create' ? '建立活動' : items().length ? '取代現有流程' : '套用流程';
  $('aiPrompt').textContent = AI_PROMPT;
  impTab('paste');
  openModal('importModal');
}

function impTab(t) {
  ['paste', 'file', 'ai'].forEach((k) => $('imp-' + k).classList.toggle('hidden', k !== t));
  document.querySelectorAll('.imp-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
}

function showImport(res) {
  if (!res.items.length) return toast('沒有解析出任何單元');
  S.imp = res;
  $('impTitle').value = res.title || (S.impMode === 'create' ? $('newTitleInput').value.trim() : S.ev?.title || '');
  $('impStart').value = res.startTime || '';
  $('impDate').value = res.startDate && res.startDate !== todayYmd() ? res.startDate : (S.impMode === 'create' ? '' : S.ev?.plannedDate || '');
  $('impWarn').innerHTML = res.warnings.map((w) => `⚠ ${esc(w)}`).join('<br>');
  renderImpRows();
  $('impPreview').classList.remove('hidden');
  $('impFooter').classList.remove('hidden');
  $('impPreview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderImpRows() {
  const its = S.imp.items;
  $('impSum').textContent = `${its.length} 個單元・共 ${its.reduce((a, x) => a + (Number(x.duration) || 0), 0)} 分鐘`;
  $('impRows').innerHTML = its.map((it, i) => `<div class="grid grid-cols-[1.5rem_1fr_6rem_3.5rem_1.75rem] gap-1.5 items-center">
    <span class="text-xs text-slate-400 text-right">${i + 1}</span>
    <input class="field !py-1.5 !px-2 text-sm" data-imp="${i}" data-f="title" value="${esc(it.title)}" title="${esc(it.subtitle)}">
    <input class="field !py-1.5 !px-2 text-sm" data-imp="${i}" data-f="owner" value="${esc(it.owner)}" placeholder="負責人">
    <input class="field !py-1.5 !px-2 text-sm font-mono text-center" type="number" min="1" data-imp="${i}" data-f="duration" value="${it.duration}">
    <button class="text-slate-400 hover:text-rose-500" data-act="imp-del" data-i="${i}"><i class="ph-bold ph-x"></i></button>
  </div>`).join('');
}

async function applyImport(mode) {
  const res = S.imp;
  if (!res?.items.length) return;
  const title = $('impTitle').value.trim() || '未命名活動';
  const plannedStart = $('impStart').value || '';
  const plannedDate = $('impDate').value && $('impDate').value !== todayYmd() ? $('impDate').value : '';
  if (S.impMode === 'create') {
    try {
      const code = await genCode();
      await S.be.create(code, {
        title, plannedStart, plannedDate, createdAt: S.be.ts(), updatedAt: S.be.ts(),
        clock: { start: null, pausedAt: null },
        items: res.items,
      });
      closeModals();
      $('newTitleInput').value = '';
      S.justCreated = true;
      await enterEvent(code, { fresh: true });
      log(`建立活動（${res.items.length} 個單元）`);
    } catch (e) {
      console.error(e);
      toast('建立失敗：' + e.message);
    }
    return;
  }
  if (mode === 'replace' && items().length && !confirm('確定取代目前整份流程？（計時不變）')) return;
  const list = mode === 'append' ? [...items(), ...res.items] : res.items;
  await saveItems(list, mode === 'append' ? `匯入並接上 ${res.items.length} 個單元` : `匯入新流程（${res.items.length} 個單元）`);
  const upd = {};
  if (title && title !== S.ev.title && mode === 'replace') upd.title = title;
  if (plannedStart && plannedStart !== S.ev.plannedStart) upd.plannedStart = plannedStart;
  if (plannedStart && plannedDate !== (S.ev.plannedDate || '')) upd.plannedDate = plannedDate || null;
  if (Object.keys(upd).length) await S.be.update(S.code, upd);
  closeModals();
  toast('流程已更新');
}

async function readFile(file) {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.xlsx')) {
      if (!window.ExcelJS) await loadScript('vendor/exceljs.min.js');
      const wb = new window.ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.worksheets.find((w) => w.actualRowCount > 0) || wb.worksheets[0];
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1)));
      const res = parseRows(rows);
      if (!res.title) res.title = ws.name && !/^(sheet|工作表)\s*\d*$/i.test(ws.name) ? ws.name : '';
      return showImport(res);
    }
    const text = await file.text();
    if (name.endsWith('.csv')) return showImport(parseRows(parseCSV(text.replace(/^﻿/, ''))));
    return showImport(parseFlowText(text));
  } catch (e) {
    console.error(e);
    toast('讀取失敗：' + e.message);
  }
}

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('載入 ' + src + ' 失敗')); document.head.appendChild(s); });
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportFlow(fmt) {
  const r = compute();
  const json = toExportJSON(S.ev);
  const csv = '﻿' + [['開始', '結束', '單元', '說明', '負責人', '分鐘', '回合'], ...r.units.map((u) => [u.startMs ? fmtHM(u.startMs) : '', u.endMs ? fmtHM(u.endMs) : '', u.title, u.subtitle || '', u.owner || '', u.duration, u.rounds])]
    .map((row) => row.map((c) => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\r\n');
  const base = (S.ev.title || 'event').replace(/[\\/:*?"<>|]/g, '_');
  if (fmt === 'json') download(base + '.json', JSON.stringify(json, null, 2), 'application/json');
  else download(base + '.csv', csv, 'text/csv');
}

function shareUrl() { return `${location.origin}${location.pathname}#e=${S.code}`; }
function openShare() {
  if (!S.code) return;
  $('shareCode').textContent = S.code;
  $('shareUrl').textContent = shareUrl();
  try { window.QRious && new window.QRious({ element: $('shareQR'), value: shareUrl(), size: 220, level: 'M' }); } catch (e) {}
  openModal('shareModal');
}

async function copyText(t, ok = '已複製') {
  try { await navigator.clipboard.writeText(t); toast(ok); }
  catch (e) { prompt('請手動複製：', t); }
}

function setTab(t) {
  const prev = S.tab;
  S.tab = t || 'watch';
  ['watch', 'flow', 'people', 'settings'].forEach((k) => $('tab-' + k).classList.toggle('hidden', k !== S.tab));
  syncBars();
  if (prev !== S.tab) window.scrollTo(0, 0);
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('ec_theme', dark ? 'dark' : 'light'); } catch (e) {}
}

// ═════════════════════════ 事件 ═════════════════════════
document.addEventListener('click', async (e) => {
  unlockAudio();
  if (e.target.closest('#bannerBox')) { $('banner').classList.add('hidden'); return; }
  const modalBg = e.target.classList?.contains('modal') && e.target.id !== 'whoModal' && e.target.id !== 'stageModal';
  if (modalBg) { closeModals(); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  const i = b.dataset.i != null ? +b.dataset.i : -1;
  try {
    switch (a) {
      case 'theme': return toggleTheme();
      case 'join-code': return enterEvent($('joinCodeInput').value);
      case 'create': return openImport('create');
      case 'open-recent': return enterEvent(b.dataset.code);
      case 'forget-recent': lsSet('ec_recent', recent().filter((x) => x.code !== b.dataset.code)); return renderRecent();
      case 'back': return S.tab && S.tab !== 'watch' ? setTab('watch') : leaveEvent();
      case 'home': case 'leave': return leaveEvent();
      case 'control': openModal('controlModal'); return tick();
      case 'wake-toggle': return toggleWake();
      case 'goto-flow': closeModals(); return setTab('flow');
      case 'dur-cur': { const r = compute(); if (r.activeIdx < 0) return; return adjustDur(r.activeIdx, +b.dataset.d); }
      case 'share': return openShare();
      case 'copy-link': return copyText(shareUrl(), '連結已複製');
      case 'native-share':
        if (navigator.share) return navigator.share({ title: S.ev?.title || '活動控場', text: `一起控場：${S.ev?.title || ''}（代碼 ${S.code}）`, url: shareUrl() }).catch(() => {});
        return copyText(shareUrl(), '連結已複製');
      case 'stage': S.stage = true; openModal('stageModal'); document.documentElement.requestFullscreen?.().catch(() => {}); return tick();
      case 'close-stage': S.stage = false; $('stageModal').classList.remove('open'); document.fullscreenElement && document.exitFullscreen?.().catch(() => {}); return;
      case 'tab': return setTab(b.dataset.tab);
      case 'confirm-start':
        if (!$('startInput').value) return toast('請先選擇開始時間');
        if (startDateVal() && dateAt(startDateVal(), $('startInput').value) < now() - 60000 && !confirm('這個時間已經過了，確定要設定嗎？')) return;
        return setStartTime($('startInput').value, startDateVal());
      case 'date-today':
        $('startDate').value = '';
        renderDateCtl();
        if ($('startInput').value && (clock().start != null || S.ev?.plannedDate)) {
          // 改回今天後若時間已過，不自動套用（避免活動直接被判定開始或結束）
          if (todayAt($('startInput').value) < now()) return toast('已改回今天；這個時間已過，請重新選時間後按「設定」');
          return setStartTime($('startInput').value, '');
        }
        return;
      case 'who': return openWho();
      case 'start-now':
        if (compute().state === 'countdown') return startNow();
        if (clock().start != null && !confirm('活動已在計時中，要從「現在」重新開始第 1 單元嗎？')) return;
        return startNow();
      case 'reset-clock': return resetClock();
      case 'shift': return shift(+b.dataset.min);
      case 'pause': return togglePause();
      case 'next': return nextUnit();
      case 'dur': return adjustDur(i, +b.dataset.d);
      case 'jump':
        if (!confirm(`從第 ${i + 1} 單元「${items()[i]?.title}」現在開始？`)) return;
        return jumpTo(i);
      case 'edit': return openItem(i);
      case 'add-item': return openItem(-1);
      case 'item-save': {
        const it = { title: $('itTitle').value.trim() || '未命名', subtitle: $('itSub').value.trim(), owner: $('itOwner').value.trim().replace(/\s*[,，/／]\s*/g, '、'), duration: Math.max(1, parseInt($('itDur').value, 10) || 1), rounds: Math.max(1, Math.min(20, parseInt($('itRounds').value, 10) || 1)) };
        const list = items().map((x) => ({ ...x }));
        if (S.editIdx >= 0) { list[S.editIdx] = { ...list[S.editIdx], ...it }; await saveItems(list, `編輯「${it.title}」`); }
        else { list.push({ id: newId(), ...it }); await saveItems(list, `新增「${it.title}」`); }
        return closeModals();
      }
      case 'item-move': {
        const list = items().map((x) => ({ ...x }));
        const j = S.editIdx + +b.dataset.dir;
        if (j < 0 || j >= list.length) return;
        [list[S.editIdx], list[j]] = [list[j], list[S.editIdx]];
        await saveItems(list, `移動「${list[j].title}」到第 ${j + 1}`);
        S.editIdx = j; $('itemModalTitle').textContent = `編輯第 ${j + 1} 單元`;
        return;
      }
      case 'item-delete': {
        const list = items().map((x) => ({ ...x }));
        const [rm] = list.splice(S.editIdx, 1);
        if (!confirm(`刪除「${rm.title}」？`)) return;
        await saveItems(list, `刪除「${rm.title}」`);
        return closeModals();
      }
      case 'import': closeModals(); return openImport('edit');
      case 'export': return exportFlow(b.dataset.fmt);
      case 'close-modal': return closeModals();
      case 'imp-tab': return impTab(b.dataset.tab);
      case 'parse-paste': return showImport(parseFlowText($('pasteInput').value));
      case 'copy-prompt': return copyText(AI_PROMPT, '提示詞已複製，貼到 AI 對話吧');
      case 'download-template':
        return download('流程表範本.csv', '﻿單元,說明,負責人,分鐘,回合\r\n開場,,修德、曉慈,5,1\r\n遊戲,每回合 5 分鐘,修德、曉慈,20,4\r\n正課,,嘉伸,15,1\r\n', 'text/csv');
      case 'imp-del': S.imp.items.splice(i, 1); return renderImpRows();
      case 'imp-apply': return applyImport(b.dataset.mode);
      case 'toggle-me': {
        const n = b.dataset.name;
        const box = b.parentElement;
        const me = meFor(S.code);
        setMeFor(S.code, me.includes(n) ? me.filter((x) => x !== n) : [...me, n]);
        renderMePicker(box, S.code);
        S.listSig = '';
        if (box.id === 'setMe') { updatePresence(); tick(); }
        return;
      }
      case 'who-ok':
        prefs.name = $('whoName').value.trim() || prefs.name || '夥伴';
        savePrefs();
        lsSet('ec_asked_' + S.code, true);
        $('whoModal').classList.remove('open');
        S.listSig = '';
        updatePresence();
        renderAll();
        if (S.justCreated) { S.justCreated = false; openShare(); }
        return;
      case 'bc-send': { const t = $('bcInput').value; $('bcInput').value = ''; return broadcast(t); }
      case 'bc-quick': return broadcast(b.dataset.msg);
      case 'test-alert': if (S.code) lsSet('ec_tested_' + S.code, true); return alertUser('這是測試提醒 🔔', { kind: 'remind' });
      case 'notify-perm':
        if ('Notification' in window) await Notification.requestPermission();
        return renderSettings();
      case 'delete-event':
        if (prompt(`刪除後所有人都看不到這場活動。請輸入代碼 ${S.code} 確認：`)?.trim().toUpperCase() !== S.code) return;
        lsSet('ec_recent', recent().filter((x) => x.code !== S.code));
        { const c = S.code; leaveEvent(); await S.be.remove(c); }
        return toast('已刪除');
    }
  } catch (err) {
    console.error(err);
    toast('操作失敗：' + (err.message || err));
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.imp != null && S.imp) {
    const it = S.imp.items[+t.dataset.imp];
    it[t.dataset.f] = t.dataset.f === 'duration' ? Math.max(1, parseInt(t.value, 10) || 1) : t.value;
    if (t.dataset.f === 'duration') $('impSum').textContent = `${S.imp.items.length} 個單元・共 ${S.imp.items.reduce((a, x) => a + (Number(x.duration) || 0), 0)} 分鐘`;
  }
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'startDate') { try { e.target.showPicker?.(); } catch (err) {} }
});

document.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'startInput') setStartTime(e.target.value, startDateVal());
  else if (id === 'startDate') { renderDateCtl(); if ($('startInput').value) setStartTime($('startInput').value, startDateVal()); }
  else if (id === 'fileInput' && e.target.files[0]) readFile(e.target.files[0]);
  else if (id === 'setName') { prefs.name = e.target.value.trim(); savePrefs(); updatePresence(); }
  else if (id === 'setTitle') { const v = e.target.value.trim(); if (v && v !== S.ev?.title) { S.be.set(S.code, 'title', v); log(`活動名稱改為「${v}」`); } }
  else if (id === 'setLead') { prefs.lead = +e.target.value; savePrefs(); }
  else if (id === 'setAll') { prefs.remindAll = e.target.checked; savePrefs(); }
  else if (id === 'setSound') { prefs.sound = e.target.checked; savePrefs(); }
  else if (id === 'setVibrate') { prefs.vibrate = e.target.checked; savePrefs(); }
  else if (id === 'setWake') { prefs.wake = e.target.checked; savePrefs(); setWake(prefs.wake); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'joinCodeInput') enterEvent(e.target.value);
  if (e.key === 'Enter' && e.target.id === 'bcInput') { broadcast(e.target.value); e.target.value = ''; }
  if (e.key === 'Escape') { if (S.stage) { S.stage = false; $('stageModal').classList.remove('open'); } else if (document.querySelector('.modal.open')) closeModals(); else if (S.tab && S.tab !== 'watch' && S.code) setTab('watch'); }
});

// ═════════════════════════ 啟動 ═════════════════════════
$('quickMsgs').innerHTML = QUICK_MSGS.map((m) => `<button class="btn btn-ghost !py-1.5 !px-3 text-sm" data-act="bc-quick" data-msg="${esc(m)}">${esc(m)}</button>`).join('');
renderRecent();
setInterval(tick, 250);

function codeFromHash() {
  const m = location.hash.match(/^#(?:e=)?([A-Za-z0-9]{4})$/);
  return m ? m[1].toUpperCase() : '';
}
window.addEventListener('hashchange', () => {
  const c = codeFromHash();
  if (c && c !== S.code && S.be) enterEvent(c);
});

(async function boot() {
  const params = new URLSearchParams(location.search);
  try {
    S.be = params.has('mock') ? createMockBackend() : await createFirebaseBackend();
    $('authStatus').textContent = S.be.kind === 'mock' ? '本機測試模式（不連線）' : '已連線，可建立或加入活動';
    S.be.onConn((ok) => {
      S.connected = ok;
      $('connDot').className = 'w-2 h-2 rounded-full ' + (ok ? 'bg-emerald-500' : 'bg-rose-500 animate-pulse');
      $('connText').textContent = ok ? '即時同步中' : '離線（恢復後自動同步）';
    });
    // 相容舊連結 ?e=XXXX：轉成 #e=XXXX 並清掉查詢字串
    const code = codeFromHash() || params.get('e');
    if (params.has('e')) history.replaceState(null, '', `${location.pathname}${S.be.kind === 'mock' ? '?mock=1' : ''}${code ? '#e=' + code : ''}`);
    if (code) enterEvent(code);
  } catch (e) {
    console.error(e);
    $('authStatus').textContent = '無法連線到同步伺服器：' + (e.message || e) + '（請檢查網路後重新整理）';
  }
})();

// Service Worker 註冊移到 index.html 內嵌腳本，app.js 載入失敗也不影響安裝
