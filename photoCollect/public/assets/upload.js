// 攝影師手機上傳頁：單頁三狀態（選擇 → 上傳中 → 完成）
// 所有伺服器／使用者字串一律用 textContent 插入，不使用 innerHTML。
import { readExifTime, mtimeToLocalIso } from './upload-exif.js';
import { sha256Hex, guessMime, processImage } from './upload-image.js';
import { putPending, delPending, listPending, clearPending } from './upload-db.js';
import { dateRangeText, groupByDay } from './days.js';

const CONCURRENCY = 2; // 同時上傳張數
const RETRY_DELAYS = [2000, 5000, 10000]; // 失敗自動重試的間隔
const CHECK_CHUNK = 40; // 每批計算雜湊並呼叫 /check 的張數
const NO_CODE = new Set(['', '_app']);

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 其餘畫面（訊息、選擇、上傳中、完成）預先放在 <template>，爬蟲讀不到這些 UI 字樣；這裡先載入，後面的程式才抓得到元素
{
  const tpl = $('tpl-views');
  if (tpl && tpl.content) $('app').append(tpl.content);
}

// ---------- localStorage（可能不可用，全部包 try） ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 忽略 */ } },
};
function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
let deviceId = store.get('mv.device');
if (!deviceId) { deviceId = randomId(); store.set('mv.device', deviceId); }

// ---------- DOM 小工具 ----------
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}
const VIEWS = ['loading', 'msg', 'pick', 'import', 'upload', 'done'];
function show(name) {
  for (const v of VIEWS) $('view-' + v).hidden = v !== name;
  const focusId = { msg: 'msg-title', pick: 'pick-event', upload: 'up-title', done: 'ok-h' }[name];
  if (focusId) $(focusId).focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
function say(text) { // aria-live 播報
  const live = $('live');
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 50);
}
const pad = (n) => String(n).padStart(2, '0');
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDay(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------- 取得上傳碼 ----------
const path = location.pathname.replace(/\/+$/, '');
const code = decodeURIComponent(path.split('/')[2] || '');
const API = `/api/u/${encodeURIComponent(code)}`;
let info = null;

if (NO_CODE.has(code)) {
  // 從主畫面圖示（start_url=/u/）進來：導向最後一次使用的上傳碼
  const last = store.get('mv.lastCode');
  if (last && !NO_CODE.has(last)) location.replace('/u/' + encodeURIComponent(last));
  else showMsg('找不到上傳連結', '請從主辦者提供的連結或 QR Code 開啟這個頁面。');
} else {
  boot();
}

// PWA：註冊 service worker（scope '/' 涵蓋 /u/）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* 不支援或被封鎖就算了 */ });
}

function showMsg(title, text, retry) {
  $('msg-title').textContent = title;
  $('msg-text').textContent = text;
  $('msg-event').textContent = info?.event?.name || '活動照片上傳';
  $('msg-retry').hidden = !retry;
  show('msg');
}
$('msg-retry').addEventListener('click', () => { show('loading'); boot(); });

async function fetchInfo() {
  const r = await fetch(`${API}/info?device=${encodeURIComponent(deviceId)}`, { cache: 'no-store' });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error('http ' + r.status);
  return { data: await r.json() };
}

async function boot() {
  let res;
  try {
    res = await fetchInfo();
  } catch (_) {
    return showMsg('無法連線', '目前連不上伺服器，請檢查網路後再試一次。', true);
  }
  if (res.notFound) return showMsg('連結無效或已更換', '連結無效或已更換，請向主辦者索取新連結。');
  info = res.data;
  store.set('mv.lastCode', code);
  if (!info.is_open) {
    if (info.stage === 'planning') {
      const when = info.opens_at ? fmtDateTime(info.opens_at) : '';
      return showMsg('尚未開放', when ? `尚未開放，將於 ${when} 開放。` : '尚未開放，請等主辦者通知。');
    }
    return showMsg('上傳已結束', '上傳已結束，謝謝你的參與。');
  }
  initPick();
  show('pick');
  checkPending();
  initAuthBlock();
}

// ============ 狀態一：選擇 ============
const P = { groups: new Set(), segment: 'auto', files: [], inited: false, rotMode: 'follow', rotStation: '' };
const groupBtns = new Map(); // 小隊名稱 → 上方小隊 chip（輪站「跟著小隊走」會同步）

function initPick() {
  const ev = info.event || {};
  $('pick-event').textContent = ev.name || '活動照片上傳';
  document.title = (ev.name ? ev.name + '｜' : '') + '活動照片上傳';
  const sub = [];
  if (ev.date) sub.push(dateRangeText(ev));
  if (ev.location) sub.push(ev.location);
  if (info.closes_at) sub.push('開放上傳至 ' + fmtDay(info.closes_at));
  $('pick-sub').textContent = sub.join(' · ');
  // 回頭看：這支手機（或帳號）上傳過照片時，提供「我上傳的照片」入口
  const mineN = Math.max(info.device_count || 0, info.me?.count || 0);
  $('pick-mine').hidden = !mineN;
  $('pick-mine').href = `/u/${encodeURIComponent(code)}/mine`;
  $('pick-mine').textContent = `查看、修改我上傳的 ${mineN} 張照片`;
  // 同意說明改成一行文字：選照片即表示同意；太長時收合，可展開完整說明
  const notice = (info.notice || '').trim();
  const short = Array.from(notice).length > 60 ? Array.from(notice).slice(0, 58).join('') + '…' : notice;
  $('notice-short').textContent = short;
  $('notice-text').textContent = notice;
  $('notice-more').hidden = short === notice;
  if (P.inited) { paintWho(); return refreshPick(); }
  P.inited = true;

  const saved = store.get('mv.name');
  if (saved) $('uploader').value = saved;
  prefillName();
  $('uploader').addEventListener('input', () => { store.set('mv.name', $('uploader').value.trim()); paintWho(); refreshPick(); });
  $('notice-more').addEventListener('click', () => {
    const open = $('notice-text').hidden;
    $('notice-text').hidden = !open;
    $('notice-more').setAttribute('aria-expanded', String(open));
    $('notice-more').textContent = open ? '收合' : '完整說明';
  });
  // 快速上傳（預設）／分批分類上傳，記在這支手機
  $('to-batch').addEventListener('click', () => setMode('batch', true));
  $('to-quick').addEventListener('click', () => setMode('quick', true));
  $('who-edit').addEventListener('click', () => { $('who-sec').hidden = !$('who-sec').hidden; if (!$('who-sec').hidden) $('uploader').focus(); });
  $('quick-btn').addEventListener('click', () => { P.quickPick = true; $('file-input').click(); });
  paintWho();
  $('original').addEventListener('change', () => {
    $('pick-sub2').textContent = $('original').checked ? '會傳送原始檔案，檔案較大、需要較多時間' : '會自動壓縮到 2560 像素，保留拍攝時間';
  });

  // 小隊（可複選；空則整區隱藏）
  const groups = info.groups || [];
  $('sec-groups').hidden = !groups.length;
  for (const g of groups) {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, g);
    b.addEventListener('click', () => {
      if (P.groups.has(g)) P.groups.delete(g); else P.groups.add(g);
      b.setAttribute('aria-pressed', P.groups.has(g) ? 'true' : 'false');
      paintRot();
      refreshPick();
    });
    groupBtns.set(g, b);
    $('group-list').append(b);
  }

  // 環節：自動判斷＋info.segments
  const segs = info.segments || [];
  $('sec-segments').hidden = !segs.length;
  // 多日活動：依天分組，每組前面放「第N天 11/21（六）」標題，今天那組標「今天」
  const opts = [{ value: 'auto', name: '依拍攝時間自動判斷', time: '建議' }];
  // 輪站課程：關卡不直接列出，改成一個「輪站課程」選項，再問攝影師怎麼拍（跟著小隊／守在某一關）
  const rots = info.rotations || [];
  const listSegs = segs.filter((s) => !s.kind && !s.rotation_slot); // 被當成輪站時段的流程環節由「輪站課程」選項涵蓋
  for (const r of rots) {
    // 跨日輪站：每一天各列一次（同一個選項），時間是當天的時段範圍
    const days = r.days && r.days.length > 1 ? r.days : [r.day];
    for (const d of days) {
      const sl = r.slots.filter((x) => !d || x.day === d);
      listSegs.push({ name: `rot:${r.id}`, title: days.length > 1 ? `${r.title}（跨日）` : r.title, day: d, date: (sl[0] && sl[0].date) || r.date, start: sl[0].start, end: sl[sl.length - 1].end, rot: r });
    }
  }
  listSegs.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.day || 0) - (b.day || 0) || a.start.localeCompare(b.start));
  for (const g of groupByDay(listSegs)) {
    if (g.label) opts.push({ head: g.label + (g.today ? ' · 今天' : ''), today: g.today });
    opts.push(...g.items.map((s) => ({
      value: s.name, name: g.label || s.rot ? s.title || s.name : s.name, time: `${s.start}–${s.end}`, aria: s.rot ? `${s.title}，${s.rot.stations.length} 個關卡同時進行` : s.name,
      sub: s.rot ? `${s.rot.stations.length} 個關卡同時進行${s.rot.rows.some((x) => x.cells.includes(-1)) ? '，有輪空' : ''}` : '',
    })));
  }
  const btns = [];
  for (const o of opts) {
    if (o.head) {
      $('segment-list').append(el('div', { class: 'seg-day' + (o.today ? ' is-today' : '') }, o.head));
      btns.push(null);
      continue;
    }
    const b = el('button', { type: 'button', class: 'seg', role: 'radio', 'aria-checked': o.value === P.segment ? 'true' : 'false', 'aria-label': o.aria ? `${o.aria} ${o.time}` : null },
      el('span', { class: 'seg-dot' }),
      o.sub ? el('span', { class: 'seg-name' }, el('b', {}, o.name), el('span', { class: 'seg-sub' }, o.sub)) : el('span', { class: 'seg-name' }, o.name),
      el('span', { class: 'seg-time' }, o.time));
    b.addEventListener('click', () => {
      P.segment = o.value;
      btns.forEach((x, i) => { if (x) x.setAttribute('aria-checked', opts[i].value === P.segment ? 'true' : 'false'); });
      paintRot();
      refreshPick();
    });
    btns.push(b);
    $('segment-list').append(b);
  }
  paintRot();

  $('pick-btn').addEventListener('click', () => { P.quickPick = false; $('file-input').click(); });
  $('file-input').addEventListener('change', () => {
    P.files = Array.from($('file-input').files || []);
    if (P.quickPick && P.files.length) { P.quickPick = false; startUpload(null, true); return; } // 快速上傳：選完立刻開始
    refreshPick();
    say(`已選 ${P.files.length} 張照片`);
  });
  $('start-btn').addEventListener('click', () => { if (readyToStart()) startUpload(); });
  $('back-btn').addEventListener('click', onBack);
  $('again-btn').addEventListener('click', backToPick);
  setMode(store.get('mv.uploadMode') === 'batch' ? 'batch' : 'quick');
  initImport();
}

// ---------- 輪站課程（選了「輪站課程」時顯示） ----------
const curRot = () => (P.segment.startsWith('rot:') ? (info.rotations || []).find((r) => `rot:${r.id}` === P.segment) : null);
// 實際送出的環節：跟著小隊走＝auto（依小隊＋時間判斷）；守在某一關＝那一關
function segmentValue() {
  const r = curRot();
  if (!r) return P.segment;
  return P.rotMode === 'fixed' && P.rotStation ? P.rotStation : 'auto';
}
function setOnlyGroup(g) {
  P.groups = new Set([g]);
  for (const [name, b] of groupBtns) b.setAttribute('aria-pressed', name === g ? 'true' : 'false');
}
function paintRot() {
  const box = $('rot-panel');
  const r = curRot();
  box.hidden = !r;
  if (!r) return;
  const radio = (v, label, hint) => el('button', {
    type: 'button', role: 'radio', class: 'rot-mode', 'aria-checked': String(P.rotMode === v),
    onclick: () => { P.rotMode = v; paintRot(); },
  }, el('b', {}, label), el('span', {}, hint));
  const kids = [
    el('h2', { class: 'sec-h', id: 'rot-h' }, `你是怎麼拍「${r.title}」的？`),
    el('div', { class: 'rot-modes', role: 'radiogroup', 'aria-labelledby': 'rot-h' },
      radio('follow', '跟著小隊走', '例如帶隊老師、家長'), radio('fixed', '固定在某一關', '例如關主、駐點攝影')),
  ];
  const groupsInRot = r.rows.map((x) => x.group);
  if (P.rotMode === 'follow') {
    kids.push(el('div', { class: 'rot-q' }, '跟著哪一隊？'), el('div', { class: 'chips' }, ...groupsInRot.map((g) => el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(P.groups.has(g)), onclick: () => { setOnlyGroup(g); paintRot(); },
    }, g))));
  } else {
    kids.push(el('div', { class: 'rot-q' }, '守在哪一關？'), el('div', { class: 'rot-stations' }, ...r.stations.map((s) => el('button', {
      type: 'button', class: 'rot-station', 'aria-pressed': String(P.rotStation === s.segment), onclick: () => { P.rotStation = s.segment; paintRot(); },
    }, el('span', { class: 'rot-name' }, s.name), el('span', { class: 'rot-place' }, s.place || '')))));
  }
  // 預覽：每段時間的照片會歸到哪裡
  const rows = [];
  const follow = P.rotMode === 'follow';
  const picked = groupsInRot.filter((g) => P.groups.has(g));
  r.slots.forEach((sl, t) => {
    let text = '';
    let muted = false;
    if (follow) {
      if (picked.length !== 1) { text = picked.length ? '勾了多隊，無法判斷' : '請先選小隊'; muted = true; }
      else {
        const c = r.rows.find((x) => x.group === picked[0]).cells[t];
        if (c < 0) { text = r.free_segment ? '輪空 → 自由活動' : '輪空'; muted = true; } else text = r.stations[c].name;
      }
    } else {
      const si = r.stations.findIndex((s) => s.segment === P.rotStation);
      if (si < 0) { text = '請先選關卡'; muted = true; }
      else {
        const gs = r.rows.filter((x) => x.cells[t] === si).map((x) => x.group);
        if (gs.length) text = `${r.stations[si].name} · ${gs.join('、')}`; else { text = '本段無隊伍（空檔）'; muted = true; }
      }
    }
    const dayTag = r.days && r.days.length > 1 && sl.day ? `第${sl.day}天 ` : '';
    rows.push(el('div', { class: 'rot-row' }, el('span', { class: 'rot-t' }, `${dayTag}${sl.start}–${sl.end}`), el('span', { class: muted ? 'rot-v muted' : 'rot-v' }, text)));
  });
  kids.push(el('div', { class: 'rot-preview', role: 'status' }, el('div', { class: 'rot-pt' }, '照片會這樣歸類'), ...rows));
  box.replaceChildren(...kids);
}

// ---------- Google 登入（選用；整段失敗也不能影響上傳） ----------
let authMod = null;
let authStarted = false;
let acctKey = '';

/** 已登入且稱呼欄為空時，預設填入 Google 名字（仍可修改；不會寫進 localStorage） */
function prefillName() {
  const n = info?.me?.name;
  const inp = $('uploader');
  if (n && inp && !inp.value.trim()) { inp.value = String(n).slice(0, 24); if (P.inited) { paintWho(); refreshPick(); } }
}

async function initAuthBlock() {
  if (authStarted) return;
  authStarted = true;
  try {
    authMod = await import('./auth.js');     // 動態載入：離線或檔案載入失敗時，上傳頁照常運作
    if (!(await authMod.initAuth())) return;
    authMod.onAuthChange(onAuthChanged);
    $('acct-sec').hidden = false;
    paintAcct();
  } catch (_) { authMod = null; }
}

/** 登入／登出後重新取得 info（含 info.me），更新稱呼與登入區 */
async function onAuthChanged() {
  try {
    const r = await fetchInfo();
    if (r.data) info = r.data;
  } catch (_) { /* 用舊資料 */ }
  prefillName();
  paintAcct();
}

function paintAcct() {
  if (!authMod) return;
  const box = $('acct-sec');
  const user = authMod.currentMe().user;
  const key = user ? `u:${user.sub}:${info?.me?.count ?? 0}` : 'anon';
  if (key === acctKey) return;
  acctKey = key;
  if (!user) {
    box.replaceChildren(el('div', { class: 'ac-up-line' }, '登入 Google 可記錄你上傳過的活動（選用）'), authMod.googleButton({ size: 'medium' }));
    return;
  }
  const name = info?.me?.name || user.name || user.email || '';
  const count = info?.me?.count ?? 0;
  const out = el('button', { type: 'button', class: 'ac-link' }, '登出');
  out.addEventListener('click', () => { out.disabled = true; authMod.logout(); });
  box.replaceChildren(el('div', { class: 'ac-up-line' }, `已登入：${name}，你在這個活動上傳了 ${count} 張`, out));
}

function missingHint() {
  if (!P.files.length) return '請先選擇照片';
  return '';
}

function setMode(m, user) {
  P.mode = m;
  if (user) store.set('mv.uploadMode', m);
  $('quick').hidden = m !== 'quick';
  $('batch').hidden = m !== 'batch';
  $('batch-foot').hidden = m !== 'batch';
  $('who-sec').hidden = m !== 'batch';
  if (user) { say(m === 'batch' ? '已切換到分批分類上傳' : '已切換到快速上傳'); (m === 'batch' ? $('pick-btn') : $('quick-btn')).focus(); }
  refreshPick();
}
function paintWho() {
  const n = $('uploader').value.trim();
  $('who-text').textContent = n ? `${n}（記在這支手機）` : '未填（可之後補）';
}
// 分批模式底部「套用」摘要
function applySummary() {
  const parts = [];
  const r = curRot();
  if (P.groups.size) parts.push([...P.groups].join('、'));
  if (r) parts.push(P.rotMode === 'fixed' && P.rotStation ? `關卡：${r.stations.find((x) => x.segment === P.rotStation)?.name || ''}` : `${r.title}（依小隊判斷關卡）`);
  else parts.push(P.segment === 'auto' ? '環節：自動' : `環節：${(info.segments || []).find((x) => x.name === P.segment)?.title || P.segment}`);
  return parts;
}
const readyToStart = () => !missingHint();

function refreshPick() {
  const n = P.files.length;
  $('pick-label').textContent = n ? `已選 ${n} 張，點此重選` : '從相簿選擇（可多選）';
  const hint = missingHint();
  const b = $('start-btn');
  b.disabled = !!hint;
  b.setAttribute('aria-disabled', hint ? 'true' : 'false');
  b.textContent = hint || `上傳 ${n} 張 ↑`;
  if (!info) return;
  const parts = applySummary();
  $('more-sum').textContent = parts.join(' · ');
  const line = $('apply-line');
  line.replaceChildren(...(n ? [el('span', {}, '套用：'), ...parts.map((t, i) => el('span', { class: i === parts.length - 1 && !P.groups.size ? 'apply-chip muted' : 'apply-chip' }, t))] : []));
}

// ---------- 斷線續傳提示 ----------
async function checkPending() {
  const list = await listPending(code);
  const box = $('resume-box');
  if (!list.length) { box.hidden = true; return; }
  $('resume-text').textContent = `有 ${list.length} 張尚未傳完，繼續上傳？`;
  box.hidden = false;
  $('resume-go').onclick = () => { box.hidden = true; startUpload(list); };
  $('resume-drop').onclick = async () => {
    if (!confirm('確定捨棄這些尚未傳完的照片嗎？')) return;
    await clearPending(code);
    box.hidden = true;
    say('已捨棄未傳完的照片');
  };
}

// ============ 狀態二：上傳 ============
let S = null; // 目前的上傳工作階段
const CANCEL = Symbol('cancel');
const TONES = ['#9DB8B3', '#C7B299', '#A8B5C9', '#B9C7A3', '#C9A9A6', '#A3BFC2'];
const MAX_BYTES = () => (info.max_mb || 30) * 1024 * 1024;

function newSession(opts) {
  return {
    opts, items: [], paused: false, cancelled: false, active: 0, prepDone: false,
    finished: false, startedAt: 0, dirty: new Set(), flushTimer: 0, gate: [], seen: new Set(), xhrs: new Set(),
  };
}

function makeItem(file, i) {
  return { id: i, file, name: (file && file.name) || '照片', status: 'queued', text: '等待中', tone: 'muted', pct: 0, el: null, thumbUrl: '' };
}

async function startUpload(resumed, quick = false, imports = null) {
  const opts = resumed
    ? { uploader: '', groups: [], segment: 'auto', original: false }
    : quick
      ? { uploader: $('uploader').value.trim(), groups: [], segment: 'auto', original: false, quick: true }
      : { uploader: $('uploader').value.trim(), groups: [...P.groups], segment: segmentValue(), original: $('original').checked };
  S = newSession(opts);
  $('up-event').textContent = info.event?.name || '';
  $('up-list').replaceChildren();
  $('finish-btn').hidden = true;
  $('retry-btn').hidden = true;
  $('pause-btn').hidden = false;
  $('stay-warn').hidden = false;
  setPauseLabel();
  S.startedAt = performance.now();

  if (resumed) {
    // 從 IndexedDB 還原：blob 已壓縮好，直接排隊
    resumed.forEach((rec, i) => {
      const it = makeItem(null, i);
      Object.assign(it, { name: rec.name || '照片', status: 'wait', blob: rec.blob, thumb: rec.thumb, meta: rec.meta, hash: rec.hash });
      if (rec.thumb) it.thumbUrl = URL.createObjectURL(rec.thumb);
      S.items.push(it);
    });
    S.prepDone = true;
    // 續傳的 meta 已含稱呼與小隊；摘要用第一筆顯示
    const m0 = resumed[0]?.meta || {};
    S.opts.groups = m0.groups || [];
    S.opts.segment = m0.segment || 'auto';
  } else if (imports) {
    // 連結匯入：不用壓縮、算雜湊，伺服器直接向 Google 取檔；hash 先放佔位，傳完換成真的
    imports.forEach((x, i) => {
      const it = makeItem(null, i);
      Object.assign(it, { name: x.name, status: 'wait', imp: x, hash: `imp:${x.uid}`, exifTime: x.taken || '', thumbUrl: x.thumb });
      S.items.push(it);
    });
    S.prepDone = true;
  } else {
    P.files.forEach((f, i) => S.items.push(makeItem(f, i)));
  }
  S.items.forEach(buildRow);
  $('tag-panel').hidden = !(opts.quick && (info.groups || []).length);
  $('tag-groups').replaceChildren();
  show('upload');
  updateNet();
  acquireWakeLock();
  paintAll();
  say(`開始上傳 ${S.items.length} 張`);
  if (!resumed && !imports) prepare(S).catch(() => {});
  pump();
}

// 準備階段：分批計算雜湊 → /check 排除已存在 → 轉為待傳
async function prepare(sess) {
  const items = sess.items;
  for (let i = 0; i < items.length; i += CHECK_CHUNK) {
    const chunk = items.slice(i, i + CHECK_CHUNK);
    for (const it of chunk) {
      if (sess.cancelled) return;
      setItem(it, { status: 'hash', text: '檢查中', tone: 'muted' });
      try {
        const mime = guessMime(it.file);
        if (!mime) { failItem(it, '不支援的檔案格式'); continue; }
        it.mime = mime;
        const buf = await it.file.arrayBuffer();
        it.hash = await sha256Hex(buf);
        it.exifTime = readExifTime(buf); // 只有 JPEG 會有值；HEIC 不解析
        it.timeSrc = it.exifTime ? 'exif' : 'mtime';
        if (!it.exifTime) it.exifTime = mtimeToLocalIso(it.file.lastModified);
      } catch (_) {
        failItem(it, '讀取檔案失敗');
      }
    }
    if (sess.cancelled) return;
    const cand = chunk.filter((it) => it.status === 'hash');
    // 同一批選取中重複的檔案
    for (const it of cand) {
      if (sess.seen.has(it.hash)) skipItem(it); else sess.seen.add(it.hash);
    }
    const hashes = cand.filter((it) => it.status === 'hash').map((it) => it.hash);
    let existing = new Set();
    if (hashes.length) {
      try {
        const r = await fetch(`${API}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes }) });
        if (r.ok) existing = new Set((await r.json()).existing || []);
      } catch (_) { /* 檢查失敗就直接傳，伺服器端也會去重 */ }
    }
    for (const it of cand) {
      if (it.status !== 'hash') continue;
      if (existing.has(it.hash)) skipItem(it);
      else setItem(it, { status: 'wait', text: '等待中', tone: 'muted' });
    }
    pump();
  }
  sess.prepDone = true;
  checkFinished();
}

// ---------- 排程 ----------
function wake() { S?.gate.splice(0).forEach((f) => f()); }
async function gate() { // 暫停或離線時在此等待
  while (S && !S.cancelled && (S.paused || !navigator.onLine)) await new Promise((r) => S.gate.push(r));
  if (!S || S.cancelled) throw CANCEL;
}

function pump() {
  const sess = S;
  if (!sess || sess.cancelled || sess.paused || !navigator.onLine) return;
  while (sess.active < CONCURRENCY) {
    const it = sess.items.find((x) => x.status === 'wait');
    if (!it) break;
    it.status = 'busy';
    sess.active++;
    runItem(sess, it).catch(() => {}).finally(() => {
      sess.active--;
      if (S === sess) { pump(); checkFinished(); }
    });
  }
}

async function runItem(sess, it) {
  try {
    if (it.imp) { await uploadWithRetry(sess, it); return; }
    if (!it.blob) {
      setItem(it, { text: '壓縮中', tone: 'active', pct: 5 });
      const r = await processImage(it.file, it.mime, sess.opts.original);
      it.blob = r.blob;
      it.thumb = r.thumb;
      if (r.thumb) { it.thumbUrl = URL.createObjectURL(r.thumb); setItem(it, {}); }
      it.meta = {
        hash: it.hash,
        orig_name: it.name,
        uploader: sess.opts.uploader,
        device: deviceId,
        groups: it.groups || sess.opts.groups,
        segment: sess.opts.segment,
        exif_time: it.exifTime || '',
        time_src: it.timeSrc,
        w: r.w || '',
        h: r.h || '',
        original: sess.opts.original ? '1' : '',
      };
      it.file = null; // 放掉原檔參照
      // 超過上限（以實際要送出的檔案為準）前端先擋下
      if (it.blob.size > MAX_BYTES()) {
        setItem(it, { status: 'toobig', text: `超過 ${info.max_mb} MB 上限`, tone: 'err', pct: 100 });
        it.blob = it.thumb = null;
        return;
      }
      await putPending({ code, hash: it.hash, blob: it.blob, thumb: it.thumb, meta: it.meta, name: it.name, size: it.blob.size });
    }
    await uploadWithRetry(sess, it);
  } catch (e) {
    if (e !== CANCEL) failItem(it, '發生錯誤，請稍後重試', true);
  }
}

const REASONS = {
  upload_closed: '上傳已結束',
  import_daily_limit: '今天的連結匯入已達上限',
  import_disabled: '主辦者已關閉連結匯入',
  list_expired: '清單已過期，請重新貼連結',
  source_gone: 'Google 上已無法存取這張',
  too_large: '檔案太大，超過上限',
  bad_type: '不支援的檔案格式',
  event_full: '本活動照片數已達上限',
  invalid: '檔案資料有誤',
  not_found: '連結已失效',
};

async function uploadWithRetry(sess, it) {
  let tries = 0; // 已重試次數
  for (;;) {
    await gate();
    setItem(it, { text: tries ? `重試中（第 ${tries} 次）` : '上傳中', tone: tries ? 'warn' : 'active', pct: 2 });
    const res = await postPhoto(sess, it);
    if (sess.cancelled) throw CANCEL;
    if (res.ok) {
      if (it.imp && res.body && res.body.hash) it.hash = res.body.hash;
      if (res.body && res.body.duplicate) skipItem(it);
      else doneItem(it);
      return;
    }
    const st = res.status;
    if (st >= 400 && st < 500 && st !== 429) { // 不重試的錯誤
      const code4 = res.body && res.body.error;
      failItem(it, REASONS[code4] || (res.body && res.body.message) || `上傳失敗（${st}）`, false, true);
      return;
    }
    if (st === 0 && !navigator.onLine) { // 離線造成的失敗不算重試次數，等網路回來
      setItem(it, { text: '等待網路', tone: 'warn', pct: 0 });
      continue;
    }
    if (tries >= RETRY_DELAYS.length) {
      failItem(it, st === 429 ? '上傳太頻繁，稍後可重試' : '網路不穩，稍後可重試', true);
      return;
    }
    setItem(it, { text: `重試中（第 ${tries + 1} 次）`, tone: 'warn', pct: 15 });
    await sleep(RETRY_DELAYS[tries]);
    tries++;
  }
}

// 以 XHR 上傳以取得進度；回傳 {ok,status,body}，網路錯誤 status=0
function postPhoto(sess, it) {
  if (it.imp) return postImport(sess, it);
  return new Promise((resolve) => {
    const fd = new FormData();
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif' }[it.blob.type] || 'jpg';
    fd.append('photo', it.blob, `${it.hash.slice(0, 12)}.${ext}`);
    if (it.thumb) fd.append('thumb', it.thumb, 'thumb.jpg');
    fd.append('meta', JSON.stringify(it.meta));
    const x = new XMLHttpRequest();
    sess.xhrs.add(x);
    x.open('POST', `${API}/photo`);
    x.timeout = 180000;
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) setItem(it, { pct: Math.max(2, Math.min(98, Math.round((e.loaded / e.total) * 100))) });
    };
    const end = (status, text) => {
      sess.xhrs.delete(x);
      let body = null;
      try { body = JSON.parse(text); } catch (_) { /* 非 JSON */ }
      resolve({ ok: status >= 200 && status < 300, status, body });
    };
    x.onload = () => end(x.status, x.responseText);
    x.onerror = () => end(0, '');
    x.ontimeout = () => end(0, '');
    x.onabort = () => end(0, '');
    x.send(fd);
  });
}

// 連結匯入一張：伺服器向 Google 取檔，沒有上傳進度，用假進度條表示「處理中」
async function postImport(sess, it) {
  const ctrl = new AbortController();
  const fake = { abort: () => ctrl.abort() };
  sess.xhrs.add(fake);
  setItem(it, { text: '從 Google 取得中', pct: 30 });
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const x = it.imp;
    const r = await fetch(`${API}/import/photo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ aid: x.aid, uid: x.uid, original: !!x.original, uploader: sess.opts.uploader, device: deviceId, groups: it.groups || sess.opts.groups, segment: sess.opts.segment }),
    });
    let body = null;
    try { body = await r.json(); } catch (_) { /* 非 JSON */ }
    return { ok: r.ok, status: r.status, body };
  } catch (_) {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(t);
    sess.xhrs.delete(fake);
  }
}

function releaseBlobs(it) { it.blob = null; it.thumb = null; }
function doneItem(it) {
  setItem(it, { status: 'done', text: '完成', tone: 'ok', pct: 100 });
  if (it.patchAfter) { it.patchAfter = false; patchGroups(it); } // 上傳途中補的小隊，傳完再寫回
  if (!it.imp) delPending(code, it.hash);
  releaseBlobs(it);
}
function skipItem(it) {
  setItem(it, { status: 'skip', text: '已存在，略過', tone: 'muted', pct: 100 });
  if (it.hash && !it.imp) delPending(code, it.hash);
  releaseBlobs(it);
}
function failItem(it, text, retryable, drop) {
  setItem(it, { status: 'fail', text, tone: 'err', pct: 100 });
  it.retryable = !!retryable;
  if (drop && it.hash && !it.imp) delPending(code, it.hash); // 4xx 再試也不會成功，不留在續傳佇列
  if (drop) releaseBlobs(it);
}

// ---------- 快速上傳：上傳中依拍攝時間自動分組，順手補小隊 ----------
const toMinute = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
// 依拍攝時間猜環節（與伺服器 segmentOf 同精神的簡化版，只用來分組顯示）
function autoGroupOf(t) {
  if (!t || t.length < 16) return { key: '_none', label: '沒有拍攝時間', sub: '' };
  const hm = t.slice(11, 16);
  const day = t.slice(0, 10);
  const m = toMinute(hm);
  for (const r of info.rotations || []) {
    const sl = r.slots.find((x) => (!x.date || x.date === day) && m >= toMinute(x.start) && m < toMinute(x.end) + 10);
    if (sl) return { key: `rot:${r.id}`, label: r.title, sub: '選小隊後會自動對到當時的關卡', rot: true };
  }
  const hits = (info.segments || []).filter((x) => !x.kind && x.start <= hm && hm < x.end && (!x.date || x.date === day));
  if (hits.length) return { key: hits[0].name, label: hits[0].name, sub: `${hits[0].start}–${hits[0].end}` };
  return { key: '_other', label: '其他時間', sub: '不在流程表的時段內' };
}
let tagTimer = 0;
function scheduleTags() {
  if (tagTimer) return;
  tagTimer = setTimeout(() => { tagTimer = 0; paintTags(); }, 400);
}
const TAG_OK = new Set(['wait', 'busy', 'done']);
function paintTags() {
  if (!S || !S.opts.quick || $('tag-panel').hidden) return;
  const box = $('tag-groups');
  const groups = new Map();
  for (const it of S.items) {
    if (!it.hash || !TAG_OK.has(it.status)) continue; // 還在檢查、略過、失敗的不列
    const g = autoGroupOf(it.exifTime);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
    groups.get(g.key).items.push(it);
  }
  // 焦點在面板內時不整個重畫，避免點到一半跳掉
  if (box.contains(document.activeElement) && box.dataset.sig === [...groups.keys()].join('|') + [...groups.values()].map((g) => g.items.length).join(',')) return;
  box.dataset.sig = [...groups.keys()].join('|') + [...groups.values()].map((g) => g.items.length).join(',');
  const teams = info.groups || [];
  box.replaceChildren(...[...groups.values()].map((g) => {
    const cur = new Set(g.items[0].groups || []);
    const thumbs = el('div', { class: 'tag-thumbs', 'aria-hidden': 'true' }, ...g.items.slice(0, 3).map((it) => (it.thumbUrl ? el('img', { src: it.thumbUrl, alt: '' }) : el('span', {}))));
    const times = g.items.map((it) => (it.exifTime || '').slice(11, 16)).filter(Boolean).sort();
    const sub = g.rot ? g.sub : times.length ? `${times[0]}–${times[times.length - 1]}` : g.sub;
    return el('section', { class: 'tag-card', 'aria-label': `${g.label}，${g.items.length} 張` },
      el('div', { class: 'tag-top' }, thumbs, el('div', { class: 'tag-name' }, el('b', {}, `${g.label} · ${g.items.length} 張`), el('span', {}, sub))),
      el('div', { class: 'chips' }, ...teams.map((name) => el('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(cur.has(name)),
        onclick: () => {
          const next = new Set(g.items[0].groups || []);
          if (g.rot) { next.clear(); if (!cur.has(name)) next.add(name); } // 輪站：一次一隊才能對到關卡
          else if (next.has(name)) next.delete(name); else next.add(name);
          applyTags(g.items, [...next]);
          box.dataset.sig = '';
          paintTags();
          say(next.size ? `${g.label}已標記：${[...next].join('、')}` : `${g.label}已清除小隊`);
        },
      }, name))));
  }));
}
// 把小隊套用到一組照片：還沒送出的改 meta；已傳完的呼叫「我上傳的照片」API；正在傳的等傳完再補
function applyTags(items, groups) {
  for (const it of items) {
    it.groups = groups;
    if (it.meta && it.status === 'wait') it.meta.groups = groups;
    if (it.status === 'busy') { if (it.meta) it.meta.groups = groups; it.patchAfter = true; }
    if (it.status === 'done') patchGroups(it);
  }
}
async function patchGroups(it) {
  try {
    await fetch(`${API}/mine/${it.hash}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-device': deviceId }, body: JSON.stringify({ groups: it.groups || [] }) });
  } catch (_) { /* 網路斷了就算了，之後可在「我上傳的照片」改 */ }
}

// ---------- 畫面更新（節流） ----------
function setItem(it, patch) {
  Object.assign(it, patch);
  if (!S) return;
  if (S.opts.quick) scheduleTags();
  S.dirty.add(it);
  if (!S.flushTimer) S.flushTimer = setTimeout(flush, 80);
}
function flush() {
  if (!S) return;
  S.flushTimer = 0;
  for (const it of S.dirty) paintRow(it);
  S.dirty.clear();
  paintOverall();
}
function paintAll() { S.items.forEach(paintRow); paintOverall(); }

function buildRow(it) {
  const img = el('img', { class: 'row-thumb', alt: '', width: '48', height: '48' });
  img.style.background = TONES[it.id % TONES.length];
  const name = el('span', { class: 'row-name' });
  name.textContent = it.name;
  const status = el('span', { class: 'row-status' });
  const fill = el('span', {});
  const li = el('li', { class: 'row' }, img,
    el('div', { class: 'row-body' }, el('div', { class: 'row-top' }, name, status), el('div', { class: 'row-bar' }, fill)));
  it.el = { li, img, status, fill };
  $('up-list').append(li);
}
function paintRow(it) {
  if (!it.el) return;
  const { li, img, status, fill } = it.el;
  status.textContent = it.text;
  status.className = 'row-status st-' + (it.tone === 'active' ? 'ink' : it.tone);
  li.className = 'row' + (it.tone === 'warn' ? ' is-warn' : it.tone === 'muted' ? ' is-muted' : it.tone === 'err' ? ' is-err' : '');
  fill.style.width = it.pct + '%';
  if (it.thumbUrl && img.getAttribute('src') !== it.thumbUrl) img.src = it.thumbUrl;
}

function counts() {
  const c = { done: 0, skip: 0, fail: 0, toobig: 0, open: 0, total: 0 };
  for (const it of S.items) {
    if (it.status === 'done') c.done++;
    else if (it.status === 'skip') c.skip++;
    else if (it.status === 'fail') c.fail++;
    else if (it.status === 'toobig') c.toobig++;
    else c.open++;
  }
  c.total = S.items.length - c.skip - c.toobig;
  return c;
}

function paintOverall() {
  if (!S) return;
  const c = counts();
  $('up-done').textContent = c.done;
  $('up-total').textContent = c.total;
  const bar = $('up-bar');
  bar.setAttribute('aria-valuemax', c.total);
  bar.setAttribute('aria-valuenow', c.done);
  $('up-bar-fill').style.width = (c.total ? Math.round((c.done / c.total) * 100) : 0) + '%';
  const left = c.total - c.done - c.fail;
  let eta = '';
  if (S.finished) eta = c.fail ? `${c.fail} 張未成功` : '全部完成';
  else if (S.paused) eta = '已暫停';
  else if (!navigator.onLine) eta = '等待網路';
  else if (c.done > 0 && left > 0) {
    const perItem = (performance.now() - S.startedAt) / c.done;
    eta = `約剩 ${Math.max(1, Math.ceil((perItem * left) / 60000))} 分鐘`;
  }
  $('up-eta').textContent = eta;
  const parts = [];
  const extra = c.skip ? `已略過 ${c.skip} 張重複照片` : '已略過 0 張重複照片';
  parts.push(extra);
  if (c.toobig) parts.push(`${c.toobig} 張超過大小上限`);
  if (S.opts.groups.length) parts.push(S.opts.groups.join('、'));
  parts.push(S.opts.segment === 'auto' ? '依拍攝時間自動判斷環節' : S.opts.segment);
  $('up-summary').textContent = parts.join(' · ');
}

function checkFinished() {
  if (!S || S.finished || !S.prepDone) return;
  const c = counts();
  if (c.open > 0) return;
  S.finished = true;
  flush(); // 先把列的狀態畫完，避免按鈕出現時列表還是舊字
  releaseWakeLock();
  $('pause-btn').hidden = true;
  $('stay-warn').hidden = true;
  $('finish-btn').hidden = false;
  $('retry-btn').hidden = !S.items.some((it) => it.status === 'fail' && it.retryable && (it.blob || it.imp));
  paintOverall();
  say(c.fail ? `上傳結束，有 ${c.fail} 張沒有成功` : `全部完成，已上傳 ${c.done} 張`);
}

// ---------- 按鈕 ----------
function setPauseLabel() { $('pause-btn').textContent = S && S.paused ? '繼續上傳' : '暫停'; }
$('pause-btn').addEventListener('click', () => {
  if (!S) return;
  S.paused = !S.paused;
  setPauseLabel();
  paintOverall();
  say(S.paused ? '已暫停上傳' : '繼續上傳');
  if (!S.paused) { wake(); pump(); }
});
$('retry-btn').addEventListener('click', () => {
  if (!S) return;
  S.finished = false;
  for (const it of S.items) {
    if (it.status === 'fail' && it.retryable && (it.blob || it.imp)) setItem(it, { status: 'wait', text: '等待中', tone: 'muted', pct: 0 });
  }
  $('retry-btn').hidden = true;
  $('finish-btn').hidden = true;
  $('pause-btn').hidden = false;
  $('stay-warn').hidden = false;
  acquireWakeLock();
  pump();
});
$('finish-btn').addEventListener('click', showDone);

function onBack() {
  if (S && !S.finished && !confirm('要離開上傳畫面嗎？已壓縮好、尚未傳完的照片會保留，下次打開可以繼續。')) return;
  backToPick();
}

function endSession() {
  if (!S) return;
  S.cancelled = true;
  for (const x of S.xhrs) { try { x.abort(); } catch (_) { /* 忽略 */ } }
  wake();
  for (const it of S.items) if (it.thumbUrl && it.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(it.thumbUrl);
  clearTimeout(S.flushTimer);
  S = null;
  releaseWakeLock();
}
function backToPick() {
  endSession();
  P.files = [];
  $('file-input').value = '';
  refreshPick();
  show('pick');
  checkPending();
}

// ---------- 網路狀態 ----------
function updateNet() {
  const on = navigator.onLine;
  $('net-tag').className = 'net ' + (on ? 'net-ok' : 'net-off');
  $('net-text').textContent = on ? '網路正常' : '離線，已暫停';
  if (S) paintOverall();
}
window.addEventListener('offline', () => { updateNet(); if (S && !S.finished) say('網路已中斷，已暫停上傳，恢復後會自動繼續'); });
window.addEventListener('online', () => { updateNet(); if (S && !S.finished) say('網路已恢復，繼續上傳'); wake(); pump(); });

// 上傳中關閉頁面前提醒
window.addEventListener('beforeunload', (e) => {
  if (S && !S.finished) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- Screen Wake Lock（支援才用） ----------
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator) || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) { wakeLock = null; }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (_) { /* 忽略 */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S && !S.finished) acquireWakeLock();
});

// ============ 狀態三：完成 ============
async function showDone() {
  const c = counts();
  const prevDevice = info.device_count || 0;
  const prevMe = info.me?.count || 0;
  const uploaded = c.done;
  const skipped = c.skip;
  const failed = c.fail + c.toobig;
  let fresh = null;
  try { fresh = (await fetchInfo()).data || null; } catch (_) { /* 用舊資料 */ }
  if (fresh) info = fresh;
  // 伺服器統計可能有約 30 秒快取：取「回報值」與「舊值＋本次」較大者
  const deviceTotal = Math.max(info.device_count || 0, prevDevice + uploaded);
  info.device_count = deviceTotal;

  $('ok-h').textContent = uploaded ? `謝謝你，已上傳 ${uploaded} 張` : '沒有新的照片需要上傳';
  const sub = $('ok-sub');
  sub.replaceChildren();
  const lines = [];
  if (skipped) lines.push(`另有 ${skipped} 張已經有人傳過，自動略過。`);
  if (failed) lines.push(`有 ${failed} 張沒有傳成功，之後可以再試一次。`);
  lines.push(`這支手機累計上傳 ${deviceTotal} 張。`);
  if (info.me) {
    // 帳號累計同樣取「回報值」與「舊值＋本次」較大者
    info.me.count = Math.max(info.me.count || 0, prevMe + uploaded);
    lines.push(`你的帳號累計上傳 ${info.me.count} 張。`);
    paintAcct();
  }
  lines.forEach((t, i) => { if (i) sub.append(document.createElement('br')); sub.append(t); });

  $('mine-link').href = `/u/${encodeURIComponent(code)}/mine`;
  paintNeed();
  show('done');
  say($('ok-h').textContent);
}

function paintNeed() {
  const list = (info.progress?.by_segment || []).filter((s) => s.target > 0);
  $('need-sec').hidden = !list.length;
  const box = $('need-list');
  box.replaceChildren();
  const missing = [];
  for (const s of list) {
    const ok = s.have >= s.target;
    if (!ok) missing.push(s.name);
    const pct = Math.min(100, Math.round((s.have / s.target) * 100));
    const note = el('span', { class: 'need-note ' + (ok ? 'ok' : 'low') });
    note.textContent = ok ? `${s.have} 張 · 足夠` : `${s.have} / ${s.target} 張 · 還缺`;
    const name = el('span', { class: 'need-name' });
    name.textContent = s.name;
    const fill = el('span', {});
    fill.style.width = pct + '%';
    box.append(el('div', { class: 'need-item' },
      el('div', { class: 'need-top' }, name, note),
      el('div', { class: 'need-bar' + (ok ? '' : ' low'), role: 'progressbar', 'aria-label': s.name, 'aria-valuemin': '0', 'aria-valuemax': String(s.target), 'aria-valuenow': String(Math.min(s.have, s.target)) }, fill)));
  }
  const warn = $('need-warn');
  if (missing.length) {
    const q = missing.map((n) => `「${n}」`);
    const joined = q.length > 1 ? q.slice(0, -1).join('、') + '與' + q[q.length - 1] : q[0];
    warn.textContent = `還缺${joined}的照片，有拍到的話歡迎補傳。`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

// ============ 貼共用連結匯入（Google 相簿／雲端硬碟） ============
const I = { albums: [], inited: false, busy: false };
const SRC_NAME = { gphotos: 'Google 相簿', gdrive: '雲端硬碟' };
const IMP_ERR = {
  bad_source: '這不是可以匯入的連結。請貼 Google 相簿的分享連結（photos.app.goo.gl/…），或雲端硬碟資料夾連結（drive.google.com/drive/folders/…）。',
  album_not_public: '這個相簿沒有公開分享。請在 Google 相簿按「分享 → 建立連結」後，貼上新的連結。',
  drive_not_public: '讀不到這個雲端硬碟連結。請把一般存取權改成「知道連結的任何人」後再試。',
  drive_disabled: '這個活動還沒開放雲端硬碟匯入，請改貼 Google 相簿連結或直接上傳。',
  rate_limited: '操作太頻繁，請等一分鐘再試。',
};

function initImport() {
  const on = info.import !== false;
  $('imp-open').hidden = !on;
  $('imp-open2').hidden = !on;
  if (!on || I.inited) return;
  I.inited = true;
  $('imp-help-drive').hidden = !info.import_drive;
  $('imp-url').placeholder = info.import_drive ? 'https://photos.app.goo.gl/…\nhttps://drive.google.com/drive/folders/…' : 'https://photos.app.goo.gl/…';
  const open = () => {
    $('imp-event').textContent = info.event?.name || '';
    show('import');
    paintImpFoot();
    $('imp-title').focus();
  };
  $('imp-open').addEventListener('click', () => { I.batch = false; open(); });
  $('imp-open2').addEventListener('click', () => { I.batch = true; open(); });
  $('imp-back').addEventListener('click', () => { show('pick'); });
  $('imp-read').addEventListener('click', readLinks);
  $('imp-url').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) readLinks(); });
  if (navigator.clipboard && navigator.clipboard.readText) {
    $('imp-paste').hidden = false;
    $('imp-paste').addEventListener('click', async () => {
      try { const t = await navigator.clipboard.readText(); if (t) { $('imp-url').value = t.trim(); readLinks(); } } catch (_) { $('imp-url').focus(); }
    });
  }
  $('imp-start').addEventListener('click', startImport);
}

function impError(text) {
  $('imp-err').hidden = !text;
  $('imp-err').textContent = text || '';
}

async function readLinks() {
  if (I.busy) return;
  const urls = [...new Set(($('imp-url').value.match(/https:\/\/[^\s<>"']+/g) || []))];
  if (!urls.length) { impError('請先貼上分享連結。'); $('imp-url').focus(); return; }
  impError('');
  I.busy = true;
  $('imp-read').disabled = true;
  const errs = [];
  for (const url of urls.slice(0, 10)) {
    if (I.albums.some((a) => a.url === url)) continue;
    const ph = el('div', { class: 'imp-card imp-loading' }, `正在讀取 ${url.length > 48 ? url.slice(0, 46) + '…' : url}`);
    $('imp-albums').append(ph);
    $('imp-read').textContent = '讀取中…';
    try {
      const r = await fetch(`${API}/import/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(IMP_ERR[d.error] || d.message || `讀取失敗（${r.status}）`);
      const a = { ...d, url, original: false, sel: new Set(d.items.filter((x) => !x.have).map((x) => x.uid)) };
      I.albums.push(a);
      ph.replaceWith(albumCard(a));
      say(`${a.title}：${a.count} 張照片`);
    } catch (e) {
      ph.remove();
      errs.push(urls.length > 1 ? `${url}\n→ ${e.message}` : e.message);
    }
  }
  I.busy = false;
  $('imp-read').disabled = false;
  $('imp-read').textContent = '讀取照片';
  if (errs.length) impError(errs.join('\n\n'));
  else $('imp-url').value = '';
  paintImpFoot();
}

const THUMB_PAGE = 120; // 一次畫幾格（其餘捲到底再補）
function albumCard(a) {
  const haveN = a.items.filter((x) => x.have).length;
  const meta = [`${SRC_NAME[a.source] || ''} · ${a.count} 張`];
  if (haveN) meta.push(`${haveN} 張已匯入過`);
  if (a.truncated) meta.push('只列出前 1000 張');
  const grid = el('div', { class: 'imp-grid', role: 'group', 'aria-label': `${a.title} 的照片` });
  const all = el('input', { type: 'checkbox' });
  const count = el('span', {});
  const cells = new Map();
  const paintSel = () => {
    const pick = a.items.filter((x) => !x.have);
    all.checked = pick.length > 0 && pick.every((x) => a.sel.has(x.uid));
    all.indeterminate = !all.checked && pick.some((x) => a.sel.has(x.uid));
    count.textContent = `全選（已勾 ${a.sel.size} 張）`;
    for (const [uid, b] of cells) if (!b.disabled) b.setAttribute('aria-pressed', String(a.sel.has(uid)));
    paintImpFoot();
  };
  let drawn = 0;
  const drawMore = () => {
    const next = a.items.slice(drawn, drawn + THUMB_PAGE);
    drawn += next.length;
    for (const x of next) {
      const t = x.taken ? `${x.taken.slice(5, 10).replace('-', '/')} ${x.taken.slice(11, 16)}` : '沒有拍攝時間';
      const b = el('button', { type: 'button', class: 'imp-cell', 'aria-pressed': String(a.sel.has(x.uid)), 'aria-label': `${x.name || '照片'}，${t}${x.have ? '，已匯入過' : ''}`, title: t },
        el('img', { src: `${API}/import/thumb/${a.aid}/${encodeURIComponent(x.uid)}`, alt: '', loading: 'lazy', decoding: 'async' }));
      if (x.have) { b.disabled = true; b.append(el('span', { class: 'imp-have' }, '已匯入')); }
      b.addEventListener('click', () => { if (a.sel.has(x.uid)) a.sel.delete(x.uid); else a.sel.add(x.uid); paintSel(); });
      cells.set(x.uid, b);
      grid.append(b);
    }
  };
  drawMore();
  grid.addEventListener('scroll', () => { if (drawn < a.items.length && grid.scrollTop + grid.clientHeight > grid.scrollHeight - 200) drawMore(); });
  all.addEventListener('change', () => {
    for (const x of a.items) if (!x.have) { if (all.checked) a.sel.add(x.uid); else a.sel.delete(x.uid); }
    paintSel();
  });
  const kids = [
    el('div', { class: 'imp-card-top' },
      el('div', { class: 'imp-card-name' }, el('b', {}, a.title), el('span', {}, meta.join(' · '))),
      el('button', { type: 'button', class: 'imp-card-x', onclick: () => { I.albums = I.albums.filter((y) => y !== a); card.remove(); paintImpFoot(); } }, '移除')),
    el('label', { class: 'check' }, all, count),
  ];
  if (a.source === 'gphotos') {
    const orig = el('input', { type: 'checkbox' });
    orig.addEventListener('change', () => { a.original = orig.checked; });
    kids.push(el('label', { class: 'check' }, orig, el('span', {}, '取原始檔（攝影師用；預設長邊 2560 像素）')));
  }
  kids.push(grid);
  if (a.daily_left < a.count) kids.push(el('div', { class: 'imp-more' }, `這個活動今天還能匯入 ${a.daily_left} 張`));
  const card = el('section', { class: 'imp-card', 'aria-label': a.title }, ...kids);
  setTimeout(paintSel, 0);
  return card;
}

function impSelected() {
  const out = [];
  for (const a of I.albums) {
    for (const x of a.items) {
      if (!a.sel.has(x.uid) || x.have) continue;
      out.push({ aid: a.aid, uid: x.uid, taken: x.taken, original: a.original, name: x.name || `${a.title}・${out.length + 1}`, thumb: `${API}/import/thumb/${a.aid}/${encodeURIComponent(x.uid)}` });
    }
  }
  return out;
}

function paintImpFoot() {
  const n = impSelected().length;
  $('imp-foot').hidden = !I.albums.length;
  const b = $('imp-start');
  b.disabled = !n;
  b.setAttribute('aria-disabled', n ? 'false' : 'true');
  b.textContent = n ? `匯入 ${n} 張 ↓` : '請先勾選照片';
  const parts = I.batch ? applySummary() : ['環節：依拍攝時間自動判斷', '小隊可在匯入時補'];
  const who = $('uploader').value.trim();
  $('imp-line').replaceChildren(...(n ? [el('span', {}, '套用：'), ...(who ? [el('span', { class: 'apply-chip' }, who)] : []), ...parts.map((t) => el('span', { class: 'apply-chip' }, t))] : []));
}

function startImport() {
  const sel = impSelected();
  if (!sel.length) return;
  // 匯入過的標成 have，回來再看不會重複勾
  for (const a of I.albums) for (const x of a.items) if (a.sel.has(x.uid)) { x.have = true; a.sel.delete(x.uid); }
  I.albums = [];
  $('imp-albums').replaceChildren();
  startUpload(null, !I.batch, sel);
}
