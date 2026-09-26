/**
 * 服務人員調查 (staffSurvey) PWA
 *
 * - 名冊 xlsx 匯入後，名冊、原始 xlsx、問卷答案都以 PIN 衍生的 AES-GCM 金鑰加密後存在 IndexedDB
 * - 全部在手機端處理，不連任何伺服器（index.html 的 CSP 禁止對外連線）
 * - 寫回名冊：以原始 xlsx 為底（ExcelJS，保留格式／公式／下拉選單），填入黃底摘要欄並新增〈問卷明細〉工作表
 */
'use strict';

const APP_VERSION = '1.0.0';
const PBKDF2_ITER = 310000;
const SUMCOLS = ['工作狀態', '平日可請假天數/年', '會開車/可載人', '出發地點(行政區)', '一年願意服務次數', '可支援項目', '116年意願備註'];
const DEFAULT_SET = { interviewer: '', lockMin: 5, lastExportAt: 0 };

// ───────────────────────── 小工具 ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc8 = new TextEncoder(), dec8 = new TextDecoder();
const pad2 = n => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtTime = t => { if (!t) return ''; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtFull = t => { if (!t) return ''; const d = new Date(t); return `${isoDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const clone = o => JSON.parse(JSON.stringify(o));
const n2l = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const l2n = l => [...l].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

const I = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.6c2.6.1 4.4 1.8 5 4.4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M8.5 12l2 2 4-4"/><path d="M8.5 17h7"/></svg>',
  tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V9M7 14l5-5 5 5M5 4h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
};

function toast(t, ms = 2600) {
  const m = $('#msg'); m.textContent = t; m.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => m.classList.remove('show'), ms);
}
function busy(text) {
  $('.busy')?.remove();
  if (!text) return;
  const d = document.createElement('div'); d.className = 'busy'; d.innerHTML = `<div>${esc(text)}</div>`;
  document.body.appendChild(d);
}
const tick = () => new Promise(r => setTimeout(r, 30));

/** 對話框（取代 alert/confirm/prompt）；回傳 null＝取消，否則為各輸入值陣列 */
function dialog({ title, body = '', inputs = [], ok = '確定', cancel = '取消', danger = false, validate }) {
  return new Promise(resolve => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3>${body ? `<div class="body">${esc(body)}</div>` : ''}
      ${inputs.map((f, i) => `<label class="lbl" for="dlg${i}">${esc(f.label || '')}</label><input id="dlg${i}" class="field${f.pin ? ' pin' : ''}" type="${f.type || 'text'}" ${f.pin ? 'inputmode="numeric" autocomplete="off"' : ''} value="${esc(f.value || '')}" placeholder="${esc(f.ph || '')}">`).join('')}
      <div class="err" data-err></div>
      <div class="btns">${cancel ? `<button class="btn" data-x="0">${esc(cancel)}</button>` : ''}<button class="btn ${danger ? 'danger' : 'primary'}" data-x="1">${esc(ok)}</button></div></div>`;
    document.body.appendChild(m);
    const close = v => { m.remove(); resolve(v); };
    const submit = async () => {
      const vals = inputs.map((_, i) => $('#dlg' + i, m).value);
      if (validate) { const e = await validate(vals); if (e) { $('[data-err]', m).textContent = e; return; } }
      close(vals);
    };
    m.addEventListener('click', e => {
      if (e.target === m) return close(null);
      const x = e.target.closest('[data-x]'); if (!x) return;
      x.dataset.x === '1' ? submit() : close(null);
    });
    m.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit(); if (e.key === 'Escape') close(null); });
    setTimeout(() => ($('input', m) || $('[data-x="1"]', m)).focus(), 50);
  });
}

// ───────────────────────── IndexedDB ─────────────────────────
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('staffSurvey', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', mode); const st = t.objectStore('kv');
    const q = fn(st); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error);
  }));
  return {
    get: k => run('readonly', s => s.get(k)),
    set: (k, v) => run('readwrite', s => s.put(v, k)),
    del: k => run('readwrite', s => s.delete(k)),
    async wipe() { const db = await open(); db.close(); p = null; await new Promise(r => { const q = indexedDB.deleteDatabase('staffSurvey'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); },
  };
})();

// ───────────────────────── 加密 ─────────────────────────
async function deriveKey(pin, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc8.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
}
async function decBytes(key, rec) { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct)); }
const putJ = async (k, obj, key = KEY) => DB.set(k, await encBytes(key, enc8.encode(JSON.stringify(obj))));
const getJ = async (k, key = KEY) => { const r = await DB.get(k); return r ? JSON.parse(dec8.decode(await decBytes(key, r))) : null; };
const putB = async (k, u8, key = KEY) => DB.set(k, await encBytes(key, u8));
const getB = async (k, key = KEY) => { const r = await DB.get(k); return r ? decBytes(key, r) : null; };

// ───────────────────────── 狀態 ─────────────────────────
let KEY = null, META = null;
let R = null;          // 名冊 { fileName, importedAt, mainName, refName, headers, people:[{id,sheet,row,f}] }
let SURV = {};         // 問卷 id → { answers, updatedAt, done, total, name, region, gender, isNew }
let SET = { ...DEFAULT_SET };
let PEOPLE = [], BYID = new Map();
const UI = { q: '', region: '', status: '', src: '', limit: 150, scroll: 0 };
let hiddenAt = 0, keepUnlocked = false; // 選檔／分享時畫面會暫時切走，不要因此上鎖
let lastFrom = '';

function personName(p) { return p?.f?.['姓名'] || '（未填姓名）'; }
function srcOf(p) {
  if (p.sheet === 'ref') return 'ref';
  if (p.sheet === 'new') return 'new';
  return p.f['來源'] === '高出席未服務' ? 'green' : 'main';
}
function statusOf(id) {
  const r = SURV[id];
  if (!r) return 'none';
  return r.updatedAt > (r.exportedAt || 0) ? 'pending' : 'exported';
}

function rebuildPeople() {
  PEOPLE = (R?.people || []).slice();
  for (const [id, rec] of Object.entries(SURV)) {
    if (rec.isNew) PEOPLE.push({ id, sheet: 'new', row: 0, f: { '姓名': rec.name || '', '區域': rec.region || '', '乾坤': rec.gender || '', '來源': '問卷新增' } });
  }
  BYID = new Map(PEOPLE.map(p => [p.id, p]));
  const HAY = ['姓名', '編號', '區域', '參班', '帶隊角色', '登記班級', '社團', '廚務角色', '禮節崗位', '忠恕角色', '交通角色', '忠恕強搭檔'];
  PEOPLE.forEach(p => { p.hay = HAY.map(h => p.f[h] ?? '').join(' ').toLowerCase() + ' ' + (SURV[p.id]?.name || '').toLowerCase(); });
}

function findPerson(name, region) {
  name = String(name || '').trim(); if (!name) return null;
  const byName = PEOPLE.filter(p => p.sheet !== 'new' && String(p.f['姓名'] || '').trim() === name);
  if (region) { const r = byName.filter(p => p.f['區域'] === region); if (r.length === 1) return r[0]; if (r.length > 1) return null; }
  return byName.length === 1 ? byName[0] : null;
}

const persistT = {};
function persist(what, delay = 400) {
  const job = persistT[what] || (persistT[what] = { res: [] });
  clearTimeout(job.t);
  return new Promise(res => {
    job.res.push(res);
    job.t = setTimeout(async () => {
      delete persistT[what];
      try {
        if (KEY) {
          if (what === 'surveys') await putJ('surveys', SURV);
          else if (what === 'settings') await putJ('settings', SET);
          else if (what === 'roster') await putJ('roster', R);
        }
      } catch (err) { toast('儲存失敗：' + err.message); }
      job.res.forEach(r => r());
    }, delay);
  });
}
async function flush() { await Promise.all(Object.keys(persistT).map(k => persist(k, 0))); }

// ───────────────────────── 路由 ─────────────────────────
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [v, ...rest] = h.split('/');
  return { v: v || 'list', id: rest.join('/') };
}
function go(hash) {
  flushSurvey();
  lastFrom = decodeURIComponent(location.hash);
  const d = (history.state?.d || 0) + 1;
  history.pushState({ d }, '', hash);
  render();
}
function back(fallback = '#/') {
  flushSurvey();
  if ((history.state?.d || 0) > 0) history.back();
  else { history.replaceState({ d: 0 }, '', fallback); render(); }
}
window.addEventListener('popstate', () => { flushSurvey(); render(); });

// ───────────────────────── 鎖定／設定 PIN ─────────────────────────
function lockScreen(mode) {
  const setup = mode === 'setup';
  $('#app').innerHTML = `<div class="lock">
    <img class="logo" src="./icons/staffSurvey-192.png" alt="">
    <h1>服務人員調查</h1>
    <p class="muted small">${setup ? '第一次使用：請設定 PIN 碼（至少 4 碼）。名冊與問卷會用這組 PIN 加密後存在這支手機。' : '請輸入 PIN 碼解鎖'}</p>
    <form class="pinbox" id="pinForm" autocomplete="off">
      <input class="field pin" id="pin1" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" aria-label="PIN 碼">
      ${setup ? '<input class="field pin" id="pin2" type="password" inputmode="numeric" autocomplete="off" placeholder="再輸入一次" aria-label="再輸入一次 PIN 碼" style="margin-top:8px">' : ''}
      <div class="err" id="pinErr"></div>
      <button class="btn primary block" type="submit">${setup ? '設定並開始' : '解鎖'}</button>
    </form>
    ${setup ? '' : '<button class="btn" id="forgot" style="margin-top:14px;border:0;background:transparent;color:var(--muted);font-weight:400">忘記 PIN？</button>'}
    <div class="shield">${I.shield}<div>資料只存在這支手機、以 AES-256 加密，不會上傳到任何伺服器。忘記 PIN 無法救回，只能清除後重新匯入名冊。</div></div>
  </div>`;
  const p1 = $('#pin1'); setTimeout(() => p1.focus(), 50);
  $('#pinForm').onsubmit = async e => {
    e.preventDefault();
    const err = $('#pinErr'); err.textContent = '';
    const pin = p1.value.trim();
    if (setup) {
      if (pin.length < 4) { err.textContent = 'PIN 至少 4 碼'; return; }
      if (pin !== $('#pin2').value.trim()) { err.textContent = '兩次輸入不一樣'; return; }
      busy('建立加密金鑰…'); await tick();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      KEY = await deriveKey(pin, salt, PBKDF2_ITER);
      META = { v: 1, salt, iter: PBKDF2_ITER, check: await encBytes(KEY, enc8.encode('staffSurvey-ok')), fails: 0, until: 0, createdAt: Date.now() };
      await DB.set('meta', META);
      R = null; SURV = {}; SET = { ...DEFAULT_SET };
      await putJ('surveys', SURV); await putJ('settings', SET);
      busy();
      navigator.storage?.persist?.().catch(() => {});
      rebuildPeople(); history.replaceState({ d: 0 }, '', '#/'); render();
      return;
    }
    const wait = (META.until || 0) - Date.now();
    if (wait > 0) { err.textContent = `錯誤次數過多，請 ${Math.ceil(wait / 1000)} 秒後再試`; return; }
    busy('解鎖中…'); await tick();
    try {
      const k = await deriveKey(pin, META.salt, META.iter);
      await decBytes(k, META.check);
      KEY = k;
      META.fails = 0; META.until = 0; await DB.set('meta', META);
      R = await getJ('roster'); SURV = (await getJ('surveys')) || {}; SET = { ...DEFAULT_SET, ...((await getJ('settings')) || {}) };
      busy(); rebuildPeople();
      if (!history.state) history.replaceState({ d: 0 }, '', location.hash || '#/');
      render();
    } catch {
      busy();
      META.fails = (META.fails || 0) + 1;
      if (META.fails >= 5) META.until = Date.now() + 30000 * 2 ** (META.fails - 5);
      await DB.set('meta', META);
      err.textContent = META.fails >= 5 ? `PIN 錯誤（第 ${META.fails} 次），請 ${Math.ceil((META.until - Date.now()) / 1000)} 秒後再試` : `PIN 錯誤（第 ${META.fails} 次）`;
      p1.value = ''; p1.focus();
    }
  };
  $('#forgot')?.addEventListener('click', wipeAll);
}

async function wipeAll() {
  const r = await dialog({ title: '清除所有資料', body: '會刪除這支手機上的名冊、所有問卷答案與 PIN，無法復原。\n若還沒匯出名冊或備份，請先取消。\n\n確定要清除，請輸入「清除」：', inputs: [{ ph: '清除' }], ok: '永久清除', danger: true, validate: v => v[0].trim() === '清除' ? '' : '請輸入「清除」兩個字' });
  if (!r) return;
  KEY = null; R = null; SURV = {}; SET = { ...DEFAULT_SET };
  await DB.wipe(); META = null;
  history.replaceState({ d: 0 }, '', '#/');
  toast('已清除'); lockScreen('setup');
}

function lock() {
  flushSurvey();
  flush().finally(() => {
    KEY = null; R = null; SURV = {}; PEOPLE = []; BYID = new Map(); CUR = null;
    lockScreen('unlock');
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); flushSurvey(); flush(); return; }
  if (keepUnlocked) { keepUnlocked = false; return; }
  if (KEY && hiddenAt && Date.now() - hiddenAt >= (Number(SET.lockMin) || 0) * 60000) lock();
});

// ───────────────────────── 畫面：外框 ─────────────────────────
function shell(title, content, { backBtn = false, nav = null, right = '' } = {}) {
  return `<header class="top"><div class="top-in">
      ${backBtn ? `<button class="iconbtn" data-act="back" aria-label="返回">${I.back}</button>` : ''}
      <h1>${title}</h1>${right}
    </div></header>
    <main class="wrap ${nav ? 'has-nav' : ''}">${content}</main>
    ${nav ? `<nav class="nav">
      <button data-go="#/" class="${nav === 'list' ? 'on' : ''}">${I.people}名冊</button>
      <button data-go="#/new">${I.plus}新增問卷</button>
      <button data-go="#/tools" class="${nav === 'tools' ? 'on' : ''}">${I.tools}匯入匯出</button>
    </nav>` : ''}`;
}

function render() {
  if (!META) return lockScreen('setup');
  if (!KEY) return lockScreen('unlock');
  const { v, id } = route();
  CUR = v === 's' ? CUR : null;
  if (v === 'p') return renderPerson(id);
  if (v === 's') return renderSurvey(id);
  if (v === 'new') return startNew();
  if (v === 'tools') return renderTools();
  renderList();
}

// ───────────────────────── 畫面：名冊清單 ─────────────────────────
function renderList() {
  if (!R && !PEOPLE.length) {
    $('#app').innerHTML = shell('服務人員調查', `
      <div class="empty">${I.clip}<p><b>還沒有名冊</b></p><p class="small">匯入〈服務人員名冊〉xlsx 後，名冊會加密記在這支手機，之後不用再找檔案。</p></div>
      <button class="btn primary block" data-act="importXlsx">${I.up}匯入名冊 xlsx</button>
      <div class="btns" style="margin-top:10px"><button class="btn" data-act="restore">從加密備份還原</button><button class="btn" data-go="#/new">不匯入，直接填問卷</button></div>
      <div class="notice" style="margin-top:18px">建議先把這個網頁「加入主畫面」安裝成 App，iPhone 的 Safari 對沒安裝的網站可能在 7 天沒使用後清掉資料。</div>`, { nav: 'list' });
    return;
  }
  const regions = [...new Set(PEOPLE.map(p => p.f['區域']).filter(Boolean))];
  const cnt = r => PEOPLE.filter(p => p.f['區域'] === r).length;
  const nDone = PEOPLE.filter(p => SURV[p.id]).length;
  $('#app').innerHTML = shell('服務人員調查', `
    <div class="search">${I.search}<input class="field" id="q" type="search" placeholder="搜尋姓名、編號、區、班別、角色…" value="${esc(UI.q)}" autocomplete="off" enterkeyhint="search"><button class="iconbtn clear" data-act="clearQ" aria-label="清除搜尋" ${UI.q ? '' : 'hidden'}>${I.x}</button></div>
    <div class="chips" id="regionChips">
      <button class="chip ${UI.region ? '' : 'on'}" data-region="">全部區<span class="n">${PEOPLE.length}</span></button>
      ${regions.map(r => `<button class="chip ${UI.region === r ? 'on' : ''}" data-region="${esc(r)}">${esc(r)}<span class="n">${cnt(r)}</span></button>`).join('')}
    </div>
    <div class="chips" id="statusChips">
      ${[['', '全部'], ['none', '未填問卷'], ['done', '已填'], ['pending', '待寫回']].map(([k, t]) => `<button class="chip ${UI.status === k ? 'on' : ''}" data-status="${k}">${t}</button>`).join('')}
      <span style="width:8px;flex:none"></span>
      ${[['', '全部來源'], ['main', '115有服務'], ['green', '高出席未服務'], ['ref', '參考名冊'], ['new', '問卷新增']].map(([k, t]) => `<button class="chip ${UI.src === k ? 'on' : ''}" data-src="${k}">${t}</button>`).join('')}
    </div>
    <div class="stat-line"><span id="statTxt"></span><span>已填問卷 <b>${nDone}</b> / ${PEOPLE.length}</span></div>
    <ul class="list" id="list"></ul>`, { nav: 'list', right: `<button class="iconbtn" data-act="lock" aria-label="鎖定">${I.lock}</button>` });
  const q = $('#q');
  q.addEventListener('input', () => { UI.q = q.value; UI.limit = 150; $('[data-act="clearQ"]').hidden = !UI.q; renderRows(); });
  renderRows();
  if (UI.scroll) { window.scrollTo(0, UI.scroll); UI.scroll = 0; }
}

function filtered() {
  const toks = UI.q.toLowerCase().split(/\s+/).filter(Boolean);
  let arr = PEOPLE.filter(p => {
    if (UI.region && p.f['區域'] !== UI.region) return false;
    if (UI.src && srcOf(p) !== UI.src) return false;
    const st = statusOf(p.id);
    if (UI.status === 'none' && st !== 'none') return false;
    if (UI.status === 'done' && st === 'none') return false;
    if (UI.status === 'pending' && st !== 'pending') return false;
    return toks.every(t => p.hay.includes(t));
  });
  if (toks.length) {
    const q0 = toks[0];
    const score = p => { const n = String(p.f['姓名'] || '').toLowerCase(); return n === q0 ? 0 : n.startsWith(q0) ? 1 : n.includes(q0) ? 2 : 3; };
    arr = arr.map((p, i) => [score(p), i, p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
  }
  return arr;
}

function rowHtml(p) {
  const f = p.f, src = srcOf(p), rec = SURV[p.id], st = statusOf(p.id);
  const name = personName(p);
  const sub = [f['區域'], f['乾坤'], f['116年年紀'] ? `${f['116年年紀']}歲` : '', f['帶隊角色'] || f['參班'] || ''].filter(Boolean).join(' · ');
  const tag = src === 'green' ? '<span class="pill green">未服務</span>' : src === 'ref' ? '<span class="pill">參考</span>' : src === 'new' ? '<span class="pill info">新增</span>' : '';
  const stat = st === 'none' ? '<span class="pill">未填</span>'
    : `<span class="pill ${st === 'pending' ? 'warn' : 'ok'}">${rec.done}/${rec.total}${st === 'pending' ? ' 待寫回' : ' ✓'}</span>`;
  return `<li><button class="row src-${src}" data-go="#/p/${encodeURIComponent(p.id)}">
    <span class="avatar ${f['乾坤'] === '乾' ? 'k' : ''}">${esc(name.slice(0, 1))}</span>
    <span class="main"><span class="nm">${esc(name)} ${tag}</span><span class="sub">${esc(sub) || '&nbsp;'}</span></span>
    <span class="right">${stat}</span></button></li>`;
}

function renderRows() {
  const arr = filtered();
  const list = $('#list'); if (!list) return;
  list.innerHTML = arr.length
    ? arr.slice(0, UI.limit).map(rowHtml).join('') + (arr.length > UI.limit ? `<li><button class="btn block" data-act="more">再顯示 ${Math.min(150, arr.length - UI.limit)} 人（共 ${arr.length}）</button></li>` : '')
    : (() => {
      const filtered = UI.region || UI.status || UI.src;
      const toks = UI.q.toLowerCase().split(/\s+/).filter(Boolean);
      const anyone = toks.length && PEOPLE.some(p => toks.every(t => p.hay.includes(t)));
      return `<li class="empty">找不到符合的人員${filtered ? '<p class="small">（目前有篩選條件，可點「全部」放寬）</p>' : ''}${UI.q && !anyone ? `<p><button class="btn" data-act="newWithName">以「${esc(UI.q)}」新增問卷</button></p>` : ''}</li>`;
    })();
  $('#statTxt').textContent = `顯示 ${arr.length} 人`;
}

// ───────────────────────── 畫面：人員資料 ─────────────────────────
function kvRows(pairs) {
  const rows = pairs.filter(([, v]) => v !== '' && v !== undefined && v !== null);
  return rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v && v.__html ? v.__html : esc(v)}</dd>`).join('')}</dl>` : '';
}
const pct = v => (v === '' || v === undefined || Number.isNaN(Number(v))) ? v : Math.round(Number(v) * 100) + '%';

function renderPerson(id) {
  const p = BYID.get(id);
  if (!p) { $('#app').innerHTML = shell('找不到人員', '<div class="empty">這位人員不在名冊中（可能名冊已更新）。</div>', { backBtn: true }); return; }
  const f = p.f, rec = SURV[id], src = srcOf(p), H = R?.headers || [];
  const name = personName(p);
  const tags = [
    f['區域'] && `<span class="pill">${esc(f['區域'])}</span>`,
    f['乾坤'] && `<span class="pill ${f['乾坤'] === '乾' ? 'info' : ''}">${esc(f['乾坤'])}</span>`,
    src === 'green' ? '<span class="pill green">高出席未服務</span>' : src === 'ref' ? `<span class="pill">參考名冊${f['排除原因'] ? '・' + esc(f['排除原因']) : ''}</span>` : src === 'new' ? '<span class="pill info">問卷新增（名冊外）</span>' : f['來源'] ? `<span class="pill">${esc(f['來源'])}</span>` : '',
    f['狀態'] && f['狀態'] !== '在籍' ? `<span class="pill warn">${esc(f['狀態'])}</span>` : '',
  ].filter(Boolean).join('');

  // 基本
  const age = f['116年年紀'];
  const basic = kvRows([
    ['編號', f['編號']], ['年次', f['年次'] ? `民國 ${f['年次']} 年` : ''], ['116 年年紀', age ? `${age} 歲（${SV.ageBand(age)}）` : ''],
    ['狀態', f['狀態']], ['登記班級', f['登記班級']], ['社團', f['社團']],
  ]);
  // 出席
  const ATT = ['第一週日', '第三週日', '明德班', '明德班-新莊', '金門金聲'];
  const att = ATT.filter(k => f[k]).map(k => {
    const [a, b] = String(f[k]).split('/').map(Number); const w = b ? Math.round(a / b * 100) : 0;
    return `<div class="tile"><b>${esc(f[k])}</b><span>${esc(k)}</span><div class="bar-in"><i style="width:${w}%"></i></div></div>`;
  }).join('');
  const attCard = (att || f['參班'] || f['最高出席率'] !== undefined) && src !== 'new' ? `<div class="card"><h2>115 年參班出席</h2>
    ${kvRows([['參班', f['參班'] || '（無 ≥60% 的班）'], ['最高出席率', pct(f['最高出席率'])]])}
    ${att ? `<div class="att" style="margin-top:10px">${att}</div>` : ''}</div>` : '';
  // 服務
  const NUMS = [['115服務場次', '服務場次'], ['平日服務天數', '平日天數'], ['7天內重複_嚴重', '7天內重複'], ['廚務場次(天達堂)', '天達廚務'], ['外場輪廚(道院/會館/德光)', '外場輪廚'], ['服務組場次', '服務組'], ['禮節場次', '禮節'], ['忠恕輪值天數', '忠恕輪值'], ['交通場次', '交通']];
  const hasSvc = NUMS.some(([k]) => H.includes(k) && f[k] !== undefined);
  const tiles = NUMS.filter(([k]) => f[k] !== undefined).map(([k, t]) => `<div class="tile ${Number(f[k]) ? '' : 'zero'}"><b>${esc(f[k])}</b><span>${t}</span></div>`).join('');
  const svcCard = hasSvc && src !== 'new' ? `<div class="card"><h2>115 年服務紀錄</h2>
    ${tiles ? `<div class="tiles">${tiles}</div>` : ''}
    <div style="margin-top:10px">${kvRows([['帶隊角色', f['帶隊角色']], ['廚務', [f['廚務角色'], f['廚務組'] && `廚務組 ${f['廚務組']}`].filter(Boolean).join('・')], ['服務組', f['服務組']], ['禮節崗位', f['禮節崗位']], ['忠恕角色', f['忠恕角色']], ['交通角色', f['交通角色']], ['忠恕強搭檔', f['忠恕強搭檔']]])}</div></div>` : '';
  // 問卷
  let svCard;
  if (rec) {
    const S = rec.answers, sum = SV.rosterSummary(S);
    const tel = v => v ? { __html: `<a href="tel:${esc(String(v).replace(/[^\d+#]/g, ''))}">${esc(v)}</a>` } : '';
    svCard = `<div class="card"><h2>問卷（${rec.done}/${rec.total}）</h2>
      <p class="small muted" style="margin:0 0 8px">最後更新 ${fmtFull(rec.updatedAt)}　${statusOf(id) === 'pending' ? '<span class="pill warn">尚未寫回名冊</span>' : '<span class="pill ok">已寫回</span>'}</p>
      ${kvRows([
        ['電話', tel(S['G2.本人電話'])],
        ['代接家人', [S['G2.代接家人稱謂'], S['G2.代接家人電話']].filter(Boolean).length ? { __html: `${esc(S['G2.代接家人稱謂'] || '')} ${tel(S['G2.代接家人電話']).__html || ''}` } : ''],
        ['所屬佛堂', S['A1.所屬佛堂']],
        ...SUMCOLS.map(k => [k, sum[k] ?? '']),
      ])}</div>`;
  } else {
    const old = SUMCOLS.filter(k => f[k] !== undefined && f[k] !== '');
    svCard = `<div class="card"><h2>問卷</h2><p class="muted small" style="margin:0">尚未填寫。${old.length ? '名冊裡已有以下回填資料：' : ''}</p>${old.length ? kvRows(old.map(k => [k, f[k]])) : ''}</div>`;
  }
  const note = f['資料備註'] ? `<div class="notice warn">${esc(f['資料備註'])}</div>` : '';
  const known = new Set(['序', '來源', '區域', '編號', '姓名', '乾坤', '年次', '116年年紀', '狀態', '參班', '最高出席率', '登記班級', '社團', '帶隊角色', '廚務組', '廚務角色', '服務組', '禮節崗位', '忠恕角色', '交通角色', '忠恕強搭檔', '資料備註', '年齡層', '排除原因', ...ATT, ...NUMS.map(n => n[0]), ...SUMCOLS]);
  const others = Object.keys(f).filter(k => !known.has(k));
  const otherCard = others.length ? `<div class="card"><h2>其他欄位</h2>${kvRows(others.map(k => [k, f[k]]))}</div>` : '';

  $('#app').innerHTML = shell(esc(name), `
    <div class="hero"><span class="avatar ${f['乾坤'] === '乾' ? 'k' : ''}">${esc(name.slice(0, 1))}</span>
      <div><h2>${esc(name)}</h2><div class="tags">${tags}</div></div></div>
    ${note}
    ${basic ? `<div class="card"><h2>基本資料</h2>${basic}</div>` : ''}
    ${svCard}${attCard}${svcCard}${otherCard}
    <div class="btns" style="margin:4px 0 12px">${rec ? `<button class="btn danger" data-act="delSurvey" data-id="${esc(id)}">${src === 'new' ? '刪除此人與問卷' : '刪除問卷答案'}</button>` : ''}</div>
    <div class="sticky-bar"><div class="in"><button class="btn primary" data-go="#/s/${encodeURIComponent(id)}">${I.edit}${rec ? `繼續／修改問卷（${rec.done}/${rec.total}）` : '開始問卷調查'}</button></div></div>`,
    { backBtn: true });
  $('main').classList.add('has-bar');
}

// ───────────────────────── 畫面：問卷 ─────────────────────────
let CUR = null; // { id, S, isNew, saveT }

function prefill(p) {
  const S = { 'meta.填寫日期': isoDate() };
  if (SET.interviewer) { S['meta.填寫方式'] = '代填'; S['meta.代填人'] = SET.interviewer; }
  if (!p) return S;
  const f = p.f;
  if (f['姓名']) S['A1.姓名'] = f['姓名'];
  const areaQ = SURVEY.SECTIONS[0].qs.find(q => q.id === 'A2');
  if (f['區域']) {
    if (areaQ.opts.map(SV.ov).includes(f['區域'])) S.A2 = f['區域'];
    else { S.A2 = '其他'; S['A2.其他.fill'] = f['區域']; }
  }
  if (f['乾坤'] === '乾') S.A3 = '乾道'; else if (f['乾坤'] === '坤') S.A3 = '坤道';
  const ao = SV.ageOption(f['116年年紀']); if (ao) S.A4 = ao;
  return S;
}

function startNew(name = '') {
  const id = 'N' + Date.now().toString(36);
  const S = prefill(null);
  if (name) S['A1.姓名'] = name;
  CUR = { id, S, isNew: true, from: '#/' };
  history.replaceState({ d: history.state?.d || 0 }, '', '#/s/' + encodeURIComponent(id));
  renderSurvey(id);
}

function renderSurvey(id) {
  const p = BYID.get(id);
  if (!CUR || CUR.id !== id) {
    if (SURV[id]) CUR = { id, S: clone(SURV[id].answers), isNew: !!SURV[id].isNew };
    else if (p) CUR = { id, S: prefill(p), isNew: false };
    else { CUR = { id, S: prefill(null), isNew: true }; }
    CUR.from = lastFrom;
  }
  const title = CUR.isNew ? (CUR.S['A1.姓名'] ? `問卷・${CUR.S['A1.姓名']}` : '新增問卷（名冊外）') : `問卷・${personName(p)}`;
  const fresh = !SURV[id];
  $('#app').innerHTML = shell(esc(title), `
    <div class="secnav chips">${SURVEY.SECTIONS.map(s => `<button class="chip" data-jump="${s.id}">${s.id} ${esc(s.title)}</button>`).join('')}</div>
    ${fresh && !CUR.isNew ? '<div class="notice">已從名冊帶入姓名、所屬區、乾坤與年齡，請跟對方確認。答案會自動加密存在手機。</div>' : ''}
    ${CUR.isNew ? '<div class="notice">名冊裡找不到的人（新人、從沒服務過的道親）用這裡填。填了 A1 姓名後，若名冊有同名的人會提示你改記在他名下。</div><div id="dupHint"></div>' : ''}
    <div class="card" id="metaCard">
      <label class="fld"><span>填寫日期</span><input class="field" type="date" data-k="meta.填寫日期"></label>
      <div class="part-l">填寫方式</div><div id="metaWay"></div>
      <div class="fill" id="proxyFill"><input class="field" type="text" data-k="meta.代填人" placeholder="代填人姓名"></div>
    </div>
    <div id="form"></div>
    <p class="muted small" style="text-align:center;margin:26px 0 10px">— 問卷到此結束，感恩您撥空填寫 —</p>
    <div class="sticky-bar"><div class="in"><span class="saved" id="savedTxt">${SURV[id] ? '已儲存' : '尚未儲存'}</span><button class="btn primary" data-act="doneSurvey">完成</button></div></div>`,
    { backBtn: true, right: `<div class="prog"><div class="meter"><i id="meter"></i></div><span id="progTxt"></span></div>` });
  $('main').classList.add('has-bar');
  buildSurveyForm();
  syncSurvey();
  if (CUR.isNew) dupCheck();
  window.scrollTo(0, 0);
}

function buildSurveyForm() {
  $('#metaWay').replaceWith(Object.assign(optGroup('meta.填寫方式', ['本人', '代填'], false), { id: 'metaWay' }));
  const form = $('#form');
  SURVEY.SECTIONS.forEach(s => {
    const sec = document.createElement('section'); sec.className = 'sec'; sec.id = 'sec-' + s.id;
    sec.innerHTML = `<h2 class="sec-h"><span class="l">${s.id}</span><span class="t">${esc(s.title)}</span></h2>${s.note ? `<p class="sec-note">${esc(s.note)}</p>` : ''}`;
    s.qs.forEach(q => sec.appendChild(renderQ(q)));
    form.appendChild(sec);
  });
  const root = $('main');
  root.addEventListener('input', e => {
    const k = e.target.dataset?.k; if (!k || !CUR) return;
    CUR.S[k] = e.target.value; surveyChanged(false);
  });
  root.addEventListener('change', e => { if (e.target.dataset?.k === 'A1.姓名' && CUR?.isNew) dupCheck(); });
  root.addEventListener('click', e => {
    const b = e.target.closest('.seg[data-gk]'); if (b && CUR) { CUR.S[b.dataset.gk] = CUR.S[b.dataset.gk] === b.dataset.gv ? '' : b.dataset.gv; surveyChanged(true); return; }
    const j = e.target.closest('[data-jump]'); if (j) { $('#sec-' + j.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
}

function optGroup(key, opts, multi, extraCls = '') {
  const wrap = document.createElement('div');
  const box = document.createElement('div');
  box.className = 'opts ' + extraCls;
  box.dataset.key = key;
  const fills = document.createElement('div');
  opts.forEach(o => {
    const v = SV.ov(o);
    const lab = document.createElement('label');
    lab.className = 'opt' + (multi ? '' : ' radio');
    lab.dataset.v = v;
    lab.innerHTML = `<input type="${multi ? 'checkbox' : 'radio'}" name="${esc(key)}"><span class="box"></span><span>${esc(v)}</span>`;
    lab.querySelector('input').addEventListener('click', e => {
      e.preventDefault();
      const cur = CUR.S[key];
      if (multi) {
        let arr = Array.isArray(cur) ? [...cur] : [];
        if (arr.includes(v)) arr = arr.filter(x => x !== v);
        else {
          const ex = typeof o === 'object' && o.excl;
          arr = ex ? [] : arr.filter(x => !opts.some(p => typeof p === 'object' && p.excl && p.v === x));
          arr.push(v);
        }
        CUR.S[key] = arr;
      } else CUR.S[key] = cur === v ? '' : v; // 再點一次可取消
      surveyChanged(true);
    });
    box.appendChild(lab);
    if (typeof o === 'object' && o.fill) {
      const f = document.createElement('div');
      f.className = 'fill'; f.dataset.for = v;
      f.innerHTML = `<span class="small muted">${esc(o.fill)}</span><input class="field" type="${o.num ? 'number' : 'text'}" ${o.num ? 'min="0" inputmode="numeric"' : ''} data-k="${esc(`${key}.${v}.fill`)}">${o.unit ? `<span>${esc(o.unit)}</span>` : ''}`;
      fills.appendChild(f);
    }
  });
  wrap.append(box, fills);
  return wrap;
}

function textInput(key, f = {}) {
  const lab = document.createElement('label');
  lab.className = 'fld';
  const t = f.long ? `<textarea class="field" data-k="${esc(key)}" placeholder="${esc(f.ph || '')}"></textarea>`
    : `<input class="field" type="${f.tel ? 'tel' : 'text'}" ${f.tel ? 'inputmode="tel" autocomplete="off"' : ''} data-k="${esc(key)}" placeholder="${esc(f.ph || '')}">`;
  lab.innerHTML = `${f.k && !f.long ? `<span>${esc(f.k)}${f.req ? ' <b class="req">*</b>' : ''}</span>` : ''}${t}`;
  return lab;
}

function gridTable(q) {
  const t = document.createElement('table');
  t.className = 'grid';
  t.innerHTML = `<thead><tr><th>項目</th>${SURVEY.SKILL_COLS.map(c => `<th class="c">${esc(c)}</th>`).join('')}</tr></thead>`;
  const tb = document.createElement('tbody');
  const addRow = (name, key, isOther) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${isOther ? `<input class="field" type="text" data-k="${esc(q.id)}.其他名稱" placeholder="其他專長" style="min-height:38px;padding:6px 8px">` : esc(name)}</td>` +
      ['can', 'learn'].map(v => `<td class="c"><button type="button" class="seg" data-gk="${esc(key)}" data-gv="${v}" aria-pressed="false">${GRIDV[v]}</button></td>`).join('');
    tb.appendChild(tr);
  };
  q.rows.forEach(r => addRow(r, `${q.id}.${r}`));
  if (q.other) addRow('', `${q.id}.其他`, true);
  t.appendChild(tb);
  return t;
}

function renderQ(q) {
  const el = document.createElement('div');
  el.className = 'q'; el.id = 'q-' + q.id;
  el.innerHTML = `<div class="q-h"><span class="q-id">${q.id}</span><span class="q-t">${esc(q.t)}${q.cond ? `<span class="q-cond">（${esc(q.cond)}）</span>` : ''}</span></div>`;
  const body = document.createElement('div');
  if (q.type === 'single' || q.type === 'multi') body.appendChild(optGroup(q.id, q.opts, q.type === 'multi'));
  else if (q.type === 'text') q.fields.forEach(f => body.appendChild(textInput(`${q.id}.${f.k}`, f)));
  else if (q.type === 'grid') body.appendChild(gridTable(q));
  else if (q.type === 'compound') {
    let row3 = null;
    q.parts.forEach(p => {
      if (p.inline) { if (!row3) { row3 = document.createElement('div'); row3.className = 'row3'; body.appendChild(row3); } row3.appendChild(textInput(`${q.id}.${p.k}`, { k: p.k })); return; }
      const key = `${q.id}.${p.k || '勾選'}`;
      if (p.type === 'multi') {
        if (p.k) { const l = document.createElement('div'); l.className = 'part-l'; l.textContent = p.k; body.appendChild(l); }
        body.appendChild(optGroup(key, p.opts, true, p.compact ? 'months' : ''));
      } else if (p.type === 'number') {
        const l = document.createElement('label'); l.className = 'fld';
        l.innerHTML = `<span>${esc(p.k)}</span><span class="inline"><input class="field" type="number" min="0" inputmode="numeric" data-k="${esc(key)}"> ${esc(p.unit || '')}</span>`;
        body.appendChild(l);
      } else if (p.type === 'text') body.appendChild(textInput(key, { k: p.k }));
    });
  }
  el.appendChild(body);
  return el;
}

function syncSurvey() {
  if (!CUR) return;
  const S = CUR.S, root = $('main');
  $$('.opts', root).forEach(box => {
    const val = S[box.dataset.key];
    $$('.opt', box).forEach(l => {
      const on = Array.isArray(val) ? val.includes(l.dataset.v) : val === l.dataset.v;
      l.classList.toggle('on', on); l.querySelector('input').checked = on;
    });
    const fills = box.nextElementSibling;
    if (fills) $$('.fill', fills).forEach(f => f.classList.toggle('show', Array.isArray(val) ? val.includes(f.dataset.for) : val === f.dataset.for));
  });
  $$('[data-k]', root).forEach(inp => {
    const v = S[inp.dataset.k] ?? '';
    if (document.activeElement !== inp && inp.value !== String(v)) inp.value = v;
  });
  $$('.seg[data-gk]', root).forEach(b => { const on = S[b.dataset.gk] === b.dataset.gv; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $('#proxyFill')?.classList.toggle('show', S['meta.填寫方式'] === '代填');
  SV.allQs().forEach(q => {
    const el = $('#q-' + q.id); if (!el) return;
    const vis = SV.visible(q, S);
    el.classList.toggle('hidden', !vis);
    el.classList.toggle('done', vis && SV.answered(q, S));
  });
  const { done, total } = SV.progress(S);
  $('#progTxt').textContent = `${done}/${total}`;
  $('#meter').style.width = (total ? done / total * 100 : 0) + '%';
}

function surveyChanged(sync) {
  if (sync) syncSurvey(); else { const { done, total } = SV.progress(CUR.S); $('#progTxt').textContent = `${done}/${total}`; $('#meter').style.width = (total ? done / total * 100 : 0) + '%'; SV.allQs().forEach(q => { const el = $('#q-' + q.id); if (el) el.classList.toggle('done', SV.visible(q, CUR.S) && SV.answered(q, CUR.S)); }); }
  $('#savedTxt').textContent = '儲存中…';
  clearTimeout(CUR.saveT);
  CUR.saveT = setTimeout(() => { saveCur(); $('#savedTxt') && ($('#savedTxt').textContent = '已儲存 ' + fmtTime(Date.now()).split(' ')[1]); }, 500);
}

function saveCur() {
  if (!CUR) return;
  clearTimeout(CUR.saveT); CUR.saveT = null;
  const S = CUR.S, p = BYID.get(CUR.id);
  const { done, total } = SV.progress(S);
  const name = String(S['A1.姓名'] || '').trim() || (p && p.sheet !== 'new' ? personName(p) : '');
  const region = SV.region(S) || p?.f?.['區域'] || '';
  const gender = SV.gender(S) || p?.f?.['乾坤'] || '';
  const isNew = CUR.isNew || (!p || p.sheet === 'new');
  const wasNew = !SURV[CUR.id];
  SURV[CUR.id] = { answers: clone(S), updatedAt: Date.now(), exportedAt: SURV[CUR.id]?.exportedAt || 0, done, total, name, region, gender, isNew };
  if (isNew || wasNew) rebuildPeople();
  persist('surveys', 200);
}
function flushSurvey() { if (CUR?.saveT) saveCur(); }

function dupCheck() {
  const hint = $('#dupHint'); if (!hint) return;
  const name = String(CUR.S['A1.姓名'] || '').trim();
  const hits = name ? PEOPLE.filter(p => p.sheet !== 'new' && String(p.f['姓名'] || '').trim() === name) : [];
  hint.innerHTML = hits.length ? `<div class="notice warn">名冊裡已有「${esc(name)}」：${hits.map(p => `<div><button class="btn" data-act="moveTo" data-id="${esc(p.id)}">改記在 ${esc(name)}（${esc(p.f['區域'] || '')}${p.f['編號'] ? '・' + esc(p.f['編號']) : ''}）名下</button></div>`).join('')}</div>` : '';
}

async function moveSurveyTo(targetId) {
  const t = BYID.get(targetId); if (!t || !CUR) return;
  if (SURV[targetId]) {
    const ok = await dialog({ title: '覆蓋既有問卷？', body: `${personName(t)} 已經有一份問卷（${SURV[targetId].done}/${SURV[targetId].total}），要用目前這份取代嗎？`, ok: '取代', danger: true });
    if (!ok) return;
  }
  const oldId = CUR.id;
  // 名冊有的基本資料（區、乾坤、年齡）補進空白題目
  const pre = prefill(t);
  ['A2', 'A2.其他.fill', 'A3', 'A4'].forEach(k => { if (pre[k] && !SV.has(CUR.S[k])) CUR.S[k] = pre[k]; });
  CUR.id = targetId; CUR.isNew = false;
  delete SURV[oldId];
  saveCur();
  rebuildPeople();
  history.replaceState(history.state, '', '#/s/' + encodeURIComponent(targetId));
  toast(`已改記在 ${personName(t)} 名下`);
  renderSurvey(targetId);
}

// ───────────────────────── Excel ─────────────────────────
function loadExcel() {
  if (window.ExcelJS) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = './vendor/exceljs.min.js';
    s.onload = () => res(); s.onerror = () => rej(new Error('無法載入 Excel 元件（第一次使用需連網開啟一次）'));
    document.head.appendChild(s);
  });
}
function cellVal(c) {
  let v = c.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return isoDate(v);
    if ('formula' in v || 'sharedFormula' in v || 'result' in v) v = (v.result !== undefined && typeof v.result !== 'object') ? v.result : '';
    else if (v.richText) v = v.richText.map(t => t.text).join('');
    else if (v.text !== undefined) v = typeof v.text === 'object' ? (v.text.richText || []).map(t => t.text).join('') : v.text;
    else if (v.error) v = '';
    else v = '';
  }
  if (typeof v === 'string') v = v.trim();
  return v;
}
function headersOf(ws) {
  const out = []; const r = ws.getRow(1);
  for (let c = 1; c <= ws.columnCount; c++) out.push(String(cellVal(r.getCell(c)) || ''));
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

async function parseWorkbook(buf) {
  await loadExcel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const main = wb.getWorksheet('服務人員名冊') || wb.worksheets.find(ws => { const h = headersOf(ws); return h.includes('姓名') && h.includes('區域') && ws.name !== '參考名冊' && ws.name !== '問卷明細'; });
  if (!main) throw new Error('找不到含「姓名」「區域」欄位的名冊工作表');
  const ref = wb.getWorksheet('參考名冊');
  const people = [], seen = new Set();
  const read = (ws, kind) => {
    const hdr = headersOf(ws);
    ws.eachRow((row, rn) => {
      if (rn === 1) return;
      const f = {};
      hdr.forEach((h, i) => { if (!h) return; const v = cellVal(row.getCell(i + 1)); if (v !== '') f[h] = v; });
      if (!f['姓名']) return;
      f['姓名'] = String(f['姓名']);
      let id = f['編號'] ? String(f['編號']) : `${f['區域'] || ''}|${f['姓名']}`;
      if (seen.has(id)) id += `#${kind}${rn}`;
      seen.add(id);
      people.push({ id, sheet: kind, row: rn, f });
    });
    return hdr;
  };
  const headers = read(main, 'main');
  const refHeaders = ref ? read(ref, 'ref') : [];
  const restored = [];
  const det = wb.getWorksheet('問卷明細');
  if (det) {
    const ci = headersOf(det).indexOf('_raw');
    if (ci >= 0) det.eachRow((row, rn) => { if (rn === 1) return; try { const o = JSON.parse(cellVal(row.getCell(ci + 1))); if (o && o.answers) restored.push(o); } catch { /* 略過 */ } });
  }
  return { mainName: main.name, refName: ref?.name || '', headers, refHeaders, people, restored };
}

/** 問卷對應到新名冊：先比 id，其次姓名＋區 */
function rekeySurveys() {
  const ids = new Set(R.people.map(p => p.id));
  let moved = 0, orphan = 0;
  for (const [id, rec] of Object.entries(SURV)) {
    if (ids.has(id)) { rec.isNew = false; continue; }
    const t = findPerson(rec.name, rec.region);
    if (t) {
      if (!SURV[t.id] || SURV[t.id].updatedAt < rec.updatedAt) SURV[t.id] = { ...rec, isNew: false };
      delete SURV[id]; moved++;
    } else { rec.isNew = true; orphan++; }
  }
  return { moved, orphan };
}

function mergeRestored(list) {
  let add = 0;
  for (const o of list) {
    let id = o.id;
    if (!BYID.has(id) || BYID.get(id).sheet === 'new') { const t = findPerson(o.name, o.region); id = t ? t.id : (o.isNew ? o.id : null); }
    if (!id) id = o.id || 'N' + Math.random().toString(36).slice(2, 9);
    const cur = SURV[id];
    if (cur && cur.updatedAt >= (o.updatedAt || 0)) continue;
    const { done, total } = SV.progress(o.answers);
    const ts = o.updatedAt || Date.now();
    SURV[id] = { answers: o.answers, updatedAt: ts, exportedAt: ts, done, total, name: o.name || '', region: o.region || '', gender: o.gender || '', isNew: !BYID.has(id) || BYID.get(id).sheet === 'new' };
    add++;
  }
  return add;
}

async function importRosterFile(file) {
  if (!/\.xlsx$/i.test(file.name)) return toast('請選擇 .xlsx 檔');
  busy('讀取名冊…'); await tick();
  let parsed, buf;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
    parsed = await parseWorkbook(buf);
  } catch (err) { busy(); return dialog({ title: '無法讀取名冊', body: err.message, cancel: '' }); }
  busy();
  if (R) {
    const ok = await dialog({ title: '更新名冊', body: `用「${file.name}」（${parsed.people.length} 人）取代目前的名冊？\n\n已填的問卷會保留，並依編號（其次姓名＋區）自動對應到新名冊。`, ok: '取代' });
    if (!ok) return;
  }
  busy('加密儲存中…'); await tick();
  R = { fileName: file.name, importedAt: Date.now(), mainName: parsed.mainName, refName: parsed.refName, headers: parsed.headers, refHeaders: parsed.refHeaders, people: parsed.people };
  rebuildPeople();
  const rk = rekeySurveys();
  rebuildPeople();
  const add = mergeRestored(parsed.restored);
  rebuildPeople();
  await putJ('roster', R); await putB('xlsx', buf); await putJ('surveys', SURV);
  busy();
  navigator.storage?.persist?.().catch(() => {});
  const nMain = parsed.people.filter(p => p.sheet === 'main').length, nRef = parsed.people.length - nMain;
  await dialog({ title: '名冊已匯入', body: `名冊 ${nMain} 人${nRef ? `、參考名冊 ${nRef} 人` : ''}，已加密存在這支手機。${parsed.restored.length ? `\n檔案內含〈問卷明細〉${parsed.restored.length} 份，合併了 ${add} 份較新的答案。` : ''}${rk.moved ? `\n${rk.moved} 份問卷已依姓名重新對應。` : ''}${rk.orphan ? `\n${rk.orphan} 份問卷在新名冊找不到人，列為「問卷新增」。` : ''}`, cancel: '', ok: '好' });
  UI.region = ''; UI.status = ''; UI.src = '';
  history.replaceState({ d: 0 }, '', '#/'); render();
}

async function importSurveyJson(files) {
  let matched = 0, created = 0, skipped = 0, bad = 0;
  const names = [];
  for (const file of files) {
    try {
      const d = JSON.parse(await file.text());
      if (d.type !== 'tiandatang-survey' || !d.answers) { bad++; continue; }
      const S = d.answers, ts = Date.parse(d.savedAt) || file.lastModified || Date.now();
      const name = String(S['A1.姓名'] || '').trim(), region = SV.region(S);
      const t = findPerson(name, region);
      const id = t ? t.id : 'N' + ts.toString(36) + Math.random().toString(36).slice(2, 5);
      if (SURV[id] && SURV[id].updatedAt >= ts) { skipped++; continue; }
      const { done, total } = SV.progress(S);
      SURV[id] = { answers: S, updatedAt: ts, done, total, name, region, gender: SV.gender(S), isNew: !t };
      t ? matched++ : (created++, names.push(name || file.name));
    } catch { bad++; }
  }
  rebuildPeople(); await putJ('surveys', SURV);
  await dialog({ title: '匯入問卷檔', body: `對應到名冊 ${matched} 份\n名冊外新增 ${created} 份${names.length ? `（${names.join('、')}）` : ''}${skipped ? `\n已有較新答案而略過 ${skipped} 份` : ''}${bad ? `\n不是本問卷格式 ${bad} 個` : ''}`, cancel: '', ok: '好' });
  render();
}

/** ExcelJS 4.4 會把下拉選單範圍寫成重疊的區段（排序用字串比較），這裡改成一欄一段連續範圍，並延伸到新增的列 */
function fixDataValidations(ws, oldLast, newLast) {
  const model = ws.dataValidations?.model; if (!model) return;
  const byCol = {};
  const addCell = (col, row, dv) => { (byCol[col] = byCol[col] || new Map()).set(row, dv); };
  for (const [addr, dv] of Object.entries(model)) {
    const m = addr.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/); if (!m) continue;
    const c1 = l2n(m[1]), r1 = +m[2], c2 = m[3] ? l2n(m[3]) : c1, r2 = m[4] ? +m[4] : r1;
    for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) addCell(c, r, dv);
  }
  const out = {};
  for (const [col, cells] of Object.entries(byCol)) {
    if (newLast > oldLast && cells.has(oldLast)) for (let r = oldLast + 1; r <= newLast; r++) cells.set(r, cells.get(oldLast));
    const rows = [...cells.keys()].sort((a, b) => a - b);
    let start = rows[0], prev = rows[0], cur = JSON.stringify(cells.get(start));
    const emit = () => { const L = n2l(+col); out[start === prev ? `${L}${start}` : `${L}${start}:${L}${prev}`] = cells.get(start); };
    for (const r of rows.slice(1)) {
      const s = JSON.stringify(cells.get(r));
      if (r === prev + 1 && s === cur) { prev = r; continue; }
      emit(); start = prev = r; cur = s;
    }
    emit();
  }
  ws.dataValidations.model = out;
}

function hasAnswers(rec) { return rec && rec.done > 0; }

async function buildExport() {
  await loadExcel();
  const bytes = await getB('xlsx');
  if (!bytes) throw new Error('手機裡沒有名冊 xlsx，請先匯入名冊');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
  const ws = wb.getWorksheet(R.mainName);
  const hdr = headersOf(ws);
  const colOf = h => hdr.indexOf(h) + 1;
  const h1 = ws.getRow(1);
  SUMCOLS.forEach(h => { if (!colOf(h)) { const c = hdr.length + 1; h1.getCell(c).value = h; h1.getCell(c).style = { ...h1.getCell(c - 1).style }; hdr.push(h); } });

  let oldLast = 1, maxSeq = 0;
  ws.eachRow((row, rn) => { if (rn > oldLast) oldLast = rn; if (rn > 1) { const s = Number(cellVal(row.getCell(colOf('序') || 1))); if (s > maxSeq) maxSeq = s; } });
  let next = oldLast + 1;
  const styleRow = ws.getRow(2);
  const stat = { upd: 0, added: 0, age: 0, ref: 0 };
  const entries = Object.entries(SURV).filter(([, r]) => hasAnswers(r));
  const addedNames = [];

  for (const [id, rec] of entries) {
    const p = BYID.get(id);
    const sum = SV.rosterSummary(rec.answers);
    let rn = 0;
    if (p && p.sheet === 'main') rn = p.row;
    else if (p && p.sheet === 'ref') { stat.ref++; continue; }
    else {
      rn = next++;
      const row = ws.getRow(rn);
      for (let c = 1; c <= hdr.length; c++) row.getCell(c).style = { ...styleRow.getCell(c).style };
      const set = (h, v) => { const c = colOf(h); if (c && v !== '' && v !== undefined) row.getCell(c).value = v; };
      set('序', ++maxSeq); set('來源', '問卷新增'); set('區域', rec.region); set('姓名', rec.name); set('乾坤', rec.gender); set('狀態', '在籍');
      set('資料備註', `問卷新增（名冊外人員，${isoDate(new Date(rec.updatedAt))}），編號待補`);
      const ac = colOf('年齡層'); const tmpl = ac && styleRow.getCell(ac).value;
      if (tmpl && typeof tmpl === 'object' && tmpl.formula) row.getCell(ac).value = { formula: tmpl.formula.replace(/\b([A-Z]{1,3})2\b/g, `$1${rn}`) };
      stat.added++; addedNames.push(rec.name);
    }
    const row = ws.getRow(rn);
    let wrote = 0;
    SUMCOLS.forEach(h => { if (sum[h] !== undefined && sum[h] !== '') { row.getCell(colOf(h)).value = sum[h]; wrote++; } });
    const ac = colOf('年齡層'), yc = colOf('116年年紀');
    if (sum['年齡層'] && ac && (!yc || cellVal(row.getCell(yc)) === '')) { row.getCell(ac).value = sum['年齡層']; stat.age++; wrote++; }
    if (wrote) stat.upd++;
  }
  const newLast = next - 1;
  if (ws.autoFilter) ws.autoFilter = `A1:${n2l(hdr.length)}${newLast}`;
  fixDataValidations(ws, oldLast, newLast);

  // 〈問卷明細〉：完整答案＋可還原的原始資料（_raw，隱藏欄）
  const old = wb.getWorksheet('問卷明細'); if (old) wb.removeWorksheet(old.id);
  const ds = wb.addWorksheet('問卷明細', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const cols = SV.columns();
  ds.addRow(['編號', '姓名', '區域', '名冊來源', '問卷進度', '最後更新', ...cols.map(c => c[0]), '_raw']);
  const hs = h1.getCell(1).style;
  ds.getRow(1).eachCell(c => { c.style = { ...hs, alignment: { vertical: 'middle', wrapText: true } }; });
  ds.getRow(1).height = 32;
  const sorted = entries.map(([id, rec]) => [id, rec, BYID.get(id)]).sort((a, b) => String(a[1].region).localeCompare(String(b[1].region)) || String(a[1].name).localeCompare(String(b[1].name)));
  for (const [id, rec, p] of sorted) {
    const srcTxt = !p || p.sheet === 'new' ? '問卷新增' : p.sheet === 'ref' ? '參考名冊' : (p.f['來源'] || '名冊');
    const vals = cols.map(c => { const v = c[1](rec.answers); return v === undefined || v === null ? '' : v; });
    ds.addRow([p?.f?.['編號'] || '', rec.name || personName(p), rec.region || p?.f?.['區域'] || '', srcTxt, `${rec.done}/${rec.total}`, fmtFull(rec.updatedAt), ...vals,
      JSON.stringify({ v: 1, id, name: rec.name, region: rec.region, gender: rec.gender, isNew: !p || p.sheet === 'new', updatedAt: rec.updatedAt, answers: rec.answers })]);
  }
  ds.columns.forEach((c, i) => { c.width = i < 2 ? 12 : i < 6 ? 11 : 14; });
  const rawCol = ds.getColumn(cols.length + 7); rawCol.hidden = true; rawCol.width = 10;
  ds.autoFilter = `A1:${n2l(cols.length + 6)}${sorted.length + 1}`;

  // 〈說明〉加一行回填紀錄
  const note = wb.getWorksheet('說明');
  if (note) {
    const txt = `${fmtFull(Date.now())} 由「服務人員調查」App 匯出：名冊黃底欄回填 ${stat.upd} 人${stat.added ? `（其中名冊外新增 ${stat.added} 人，列在最後，編號待補）` : ''}；完整答案見〈問卷明細〉${stat.ref ? `（含參考名冊 ${stat.ref} 人）` : ''}`;
    let hit = 0; note.eachRow((r, rn) => { if (cellVal(r.getCell(1)) === '問卷回填') hit = rn; });
    if (hit) note.getRow(hit).getCell(2).value = txt;
    else { note.addRow([]); note.addRow(['問卷回填', txt]); }
  }
  // ExcelJS 會省略寬度剛好 9 的欄寬，改成 9.01 保留原本版面
  wb.worksheets.forEach(s => (s.columns || []).forEach(c => { if (c && c.width === 9) c.width = 9.01; }));

  const out = await wb.xlsx.writeBuffer();
  const base = (R.fileName || '服務人員名冊.xlsx').replace(/\.xlsx$/i, '').replace(/_問卷回填_\d{8}$/, '');
  return { blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: `${base}_問卷回填_${ymd()}.xlsx`, stat, addedNames, ids: entries.map(e => e[0]) };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

async function doExport(share) {
  flushSurvey(); await flush();
  const n = Object.values(SURV).filter(hasAnswers).length;
  if (!n) return toast('還沒有任何問卷答案');
  busy('產生名冊 xlsx…'); await tick();
  let res;
  try { res = await buildExport(); } catch (err) { busy(); return dialog({ title: '匯出失敗', body: err.message, cancel: '' }); }
  busy();
  if (share) {
    const file = new File([res.blob], res.name, { type: res.blob.type });
    if (!navigator.canShare?.({ files: [file] })) return toast('這台手機不支援分享檔案，請改用下載');
    keepUnlocked = true;
    try { await navigator.share({ files: [file], title: res.name }); } catch (err) { if (err.name !== 'AbortError') toast('分享失敗：' + err.message); return; }
  } else download(res.blob, res.name);
  const now = Date.now();
  res.ids.forEach(id => { if (SURV[id]) SURV[id].exportedAt = now; });
  SET.lastExportAt = now; await putJ('settings', SET); await putJ('surveys', SURV);
  toast(`已${share ? '分享' : '下載'} ${res.name}`, 4000);
  render();
}

// ───────────────────────── 備份 ─────────────────────────
async function makeBackup() {
  flushSurvey(); await flush();
  busy('產生加密備份…'); await tick();
  const x = await getB('xlsx');
  const payload = { R, SURV, SET, xlsx: x ? b64(x) : null };
  const { iv, ct } = await encBytes(KEY, enc8.encode(JSON.stringify(payload)));
  const file = { type: 'staffSurvey-backup', v: 1, app: APP_VERSION, createdAt: new Date().toISOString(), salt: b64(META.salt), iter: META.iter, iv: b64(iv), data: b64(ct) };
  busy();
  download(new Blob([JSON.stringify(file)], { type: 'application/json' }), `服務人員調查_加密備份_${ymd()}.json`);
  toast('已下載加密備份；還原時要輸入目前這組 PIN', 4000);
}

async function restoreBackup(file) {
  let d;
  try { d = JSON.parse(await file.text()); if (d.type !== 'staffSurvey-backup') throw 0; } catch { return toast('這不是本 App 的加密備份檔'); }
  let payload = null;
  const r = await dialog({
    title: '從備份還原', body: `備份時間：${fmtFull(Date.parse(d.createdAt))}\n請輸入「建立備份時」使用的 PIN。還原會取代這支手機目前的名冊與問卷。`,
    inputs: [{ type: 'password', pin: true, label: '備份的 PIN' }], ok: '還原', danger: !!R,
    validate: async v => {
      try { const k = await deriveKey(v[0].trim(), unb64(d.salt), d.iter); payload = JSON.parse(dec8.decode(await decBytes(k, { iv: unb64(d.iv), ct: unb64(d.data) }))); return ''; }
      catch { return 'PIN 不正確，或備份檔已損壞'; }
    },
  });
  if (!r || !payload) return;
  busy('還原中…'); await tick();
  R = payload.R || null; SURV = payload.SURV || {}; SET = { ...DEFAULT_SET, ...(payload.SET || {}) };
  await putJ('roster', R); await putJ('surveys', SURV); await putJ('settings', SET);
  if (payload.xlsx) await putB('xlsx', unb64(payload.xlsx)); else await DB.del('xlsx');
  rebuildPeople(); busy();
  toast(`已還原：名冊 ${R?.people?.length || 0} 人、問卷 ${Object.keys(SURV).length} 份`, 4000);
  history.replaceState({ d: 0 }, '', '#/'); render();
}

async function changePin() {
  const r = await dialog({
    title: '變更 PIN', inputs: [{ type: 'password', pin: true, label: '目前的 PIN' }, { type: 'password', pin: true, label: '新 PIN（至少 4 碼）' }, { type: 'password', pin: true, label: '再輸入一次新 PIN' }],
    validate: async v => {
      if (v[1].trim().length < 4) return '新 PIN 至少 4 碼';
      if (v[1].trim() !== v[2].trim()) return '兩次新 PIN 不一樣';
      try { await decBytes(await deriveKey(v[0].trim(), META.salt, META.iter), META.check); return ''; } catch { return '目前的 PIN 不正確'; }
    },
  });
  if (!r) return;
  busy('重新加密中…'); await tick();
  flushSurvey(); await flush();
  const x = await getB('xlsx');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await deriveKey(r[1].trim(), salt, PBKDF2_ITER);
  await putJ('roster', R, k); await putJ('surveys', SURV, k); await putJ('settings', SET, k);
  if (x) await putB('xlsx', x, k);
  META = { ...META, salt, iter: PBKDF2_ITER, check: await encBytes(k, enc8.encode('staffSurvey-ok')), fails: 0, until: 0 };
  await DB.set('meta', META);
  KEY = k; busy(); toast('PIN 已變更');
}

// ───────────────────────── 畫面：匯入匯出 ─────────────────────────
async function renderTools() {
  const all = Object.values(SURV).filter(hasAnswers);
  const pending = Object.keys(SURV).filter(id => hasAnswers(SURV[id]) && statusOf(id) === 'pending').length;
  const nMain = R ? R.people.filter(p => p.sheet === 'main').length : 0, nRef = R ? R.people.length - nMain : 0;
  const nNew = PEOPLE.filter(p => p.sheet === 'new').length;
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.xlsx', { type: 'application/octet-stream' })] }));
  let persisted = null; try { persisted = await navigator.storage?.persisted?.(); } catch { /* 無 */ }
  $('#app').innerHTML = shell('匯入匯出', `<div class="tools">
    <div class="card"><h2>名冊</h2>
      ${R ? `<div class="srow"><span class="muted">檔案</span><span>${esc(R.fileName)}</span></div>
      <div class="srow"><span class="muted">匯入時間</span><span>${fmtFull(R.importedAt)}</span></div>
      <div class="srow"><span class="muted">人數</span><span>名冊 ${nMain}${nRef ? `・參考 ${nRef}` : ''}${nNew ? `・問卷新增 ${nNew}` : ''}</span></div>` : '<p class="muted small">還沒匯入名冊。</p>'}
      <div class="btns"><button class="btn ${R ? '' : 'primary'}" data-act="importXlsx">${I.up}${R ? '更新名冊 xlsx' : '匯入名冊 xlsx'}</button></div>
      <p class="tiny muted">更新名冊時，已填的問卷會依編號（其次姓名＋區）自動對應；若匯入的是本 App 匯出的 xlsx，也會把〈問卷明細〉裡的答案合併進來（可用來在兩支手機間交換進度）。</p>
    </div>

    <div class="card"><h2>寫回名冊</h2>
      <p class="small">已填問卷 <b>${all.length}</b> 份，其中 <b>${pending}</b> 份尚未寫回。${SET.lastExportAt ? `上次匯出：${fmtFull(SET.lastExportAt)}` : ''}</p>
      <div class="btns"><button class="btn primary" data-act="export" ${all.length && R ? '' : 'disabled'}>${I.down}下載名冊 xlsx</button>${canShare ? `<button class="btn" data-act="exportShare" ${all.length && R ? '' : 'disabled'}>${I.share}分享…</button>` : ''}</div>
      <p class="tiny muted">以原本的名冊檔為底（格式、公式、下拉選單都保留）：填入黃底欄「工作狀態…116年意願備註」，名冊外的新人加在最後一列，並新增〈問卷明細〉工作表放完整 31 題答案。檔案會存到手機的下載或「檔案」App；「分享」會交給你選的 App（例如 LINE），請只傳給負責的幹部。</p>
    </div>

    <div class="card"><h2>匯入線上問卷檔</h2>
      <p class="small">學長用〈天達堂服務人員問卷〉網頁填好並「儲存」的 .json 檔，可一次選多個匯入，會依姓名＋區自動對應到名冊。</p>
      <div class="btns"><button class="btn" data-act="importJson">${I.up}選擇問卷 .json 檔</button></div>
    </div>

    <div class="card"><h2>調查人</h2>
      <label class="lbl" for="interviewer">你的名字（代填問卷時自動帶入「代填人」）</label>
      <input class="field" id="interviewer" value="${esc(SET.interviewer)}" placeholder="例：簡嘉伸" autocomplete="off">
    </div>

    <div class="card"><h2>備份與還原</h2>
      <p class="small">換手機或怕資料被清掉時使用。備份檔是加密的，還原時要輸入建立備份當下的 PIN。</p>
      <div class="btns"><button class="btn" data-act="backup">${I.down}下載加密備份</button><button class="btn" data-act="restore">${I.up}從備份還原</button></div>
    </div>

    <div class="card"><h2>安全</h2>
      <div class="srow"><label for="lockMin">離開 App 後自動鎖定</label>
        <select class="field" id="lockMin" style="width:auto">${[[0, '立即'], [1, '1 分鐘'], [5, '5 分鐘'], [15, '15 分鐘'], [60, '1 小時']].map(([v, t]) => `<option value="${v}" ${Number(SET.lockMin) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="btns"><button class="btn" data-act="lock">${I.lock}立即鎖定</button><button class="btn" data-act="changePin">變更 PIN</button></div>
      <div class="btns"><button class="btn danger" data-act="wipe">清除這支手機上的所有資料</button></div>
    </div>

    <div class="card"><h2>關於</h2>
      <div class="shield" style="max-width:none;margin-top:0">${I.shield}<div>名冊與問卷只存在這支手機的瀏覽器儲存空間，以 PIN 衍生的 AES-256 金鑰加密；頁面設定為禁止對外連線，不會上傳任何資料。</div></div>
      <p class="tiny muted" style="margin-top:10px">儲存空間${persisted ? '已設為「持久保存」' : '可能在空間不足或長期未使用時被系統清除'}。建議「加入主畫面」安裝成 App，並定期下載加密備份或匯出名冊。<br>版本 ${APP_VERSION}・Excel 處理使用 ExcelJS（MIT）。</p>
    </div></div>`, { nav: 'tools' });
  $('#interviewer').addEventListener('input', e => { SET.interviewer = e.target.value.trim(); persist('settings'); });
  $('#lockMin').addEventListener('change', e => { SET.lockMin = Number(e.target.value); persist('settings', 0); toast('已設定'); });
}

// ───────────────────────── 全域事件 ─────────────────────────
document.addEventListener('click', async e => {
  const g = e.target.closest('[data-go]');
  if (g) {
    if (route().v === 'list') UI.scroll = window.scrollY;
    const h = g.dataset.go;
    if (h === '#/new') { flushSurvey(); history.pushState({ d: (history.state?.d || 0) + 1 }, '', '#/new'); CUR = null; return startNew(); }
    return go(h);
  }
  const r = e.target.closest('[data-region]'); if (r) { UI.region = r.dataset.region; UI.limit = 150; $$('[data-region]').forEach(b => b.classList.toggle('on', b === r)); return renderRows(); }
  const s = e.target.closest('[data-status]'); if (s) { UI.status = s.dataset.status; $$('[data-status]').forEach(b => b.classList.toggle('on', b === s)); return renderRows(); }
  const sc = e.target.closest('[data-src]'); if (sc) { UI.src = sc.dataset.src; $$('[data-src]').forEach(b => b.classList.toggle('on', b === sc)); return renderRows(); }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'back') back('#/');
  else if (act === 'lock') lock();
  else if (act === 'clearQ') { UI.q = ''; $('#q').value = ''; a.hidden = true; renderRows(); $('#q').focus(); }
  else if (act === 'more') { UI.limit += 150; renderRows(); }
  else if (act === 'newWithName') { const nm = UI.q.trim(); history.pushState({ d: (history.state?.d || 0) + 1 }, '', '#/new'); CUR = null; startNew(nm); }
  else if (act === 'importXlsx') { keepUnlocked = true; $('#fileXlsx').click(); }
  else if (act === 'importJson') { keepUnlocked = true; $('#fileJson').click(); }
  else if (act === 'restore') { keepUnlocked = true; $('#fileBackup').click(); }
  else if (act === 'backup') makeBackup();
  else if (act === 'export') doExport(false);
  else if (act === 'exportShare') doExport(true);
  else if (act === 'changePin') changePin();
  else if (act === 'wipe') wipeAll();
  else if (act === 'moveTo') moveSurveyTo(a.dataset.id);
  else if (act === 'doneSurvey') {
    flushSurvey(); await flush();
    const id = CUR?.id;
    if (!SURV[id]) { toast('還沒有填任何答案'); return back('#/'); }
    toast('問卷已儲存');
    const from = CUR?.from;
    if (from === '#/p/' + id) back();
    else if (BYID.has(id)) { history.replaceState(history.state, '', '#/p/' + encodeURIComponent(id)); CUR = null; render(); }
    else back('#/');
  } else if (act === 'delSurvey') {
    const id = a.dataset.id, p = BYID.get(id);
    const isNewP = p?.sheet === 'new';
    const ok = await dialog({ title: isNewP ? '刪除此人與問卷' : '刪除問卷答案', body: `確定刪除 ${personName(p)} 的問卷答案？${isNewP ? '\n此人是名冊外新增，會一併從清單移除。' : ''}\n（已匯出到 xlsx 的不受影響）`, ok: '刪除', danger: true });
    if (!ok) return;
    delete SURV[id]; rebuildPeople(); await persist('surveys', 0); toast('已刪除');
    if (isNewP) back('#/'); else render();
  }
});

$('#fileXlsx').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importRosterFile(f); });
$('#fileJson').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) importSurveyJson(fs); });
$('#fileBackup').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); });
window.addEventListener('pagehide', () => { flushSurvey(); });

// ───────────────────────── 啟動 ─────────────────────────
(async function init() {
  if (!window.crypto?.subtle || !window.indexedDB) {
    $('#app').innerHTML = '<div class="lock"><h1>無法使用</h1><p>這個瀏覽器不支援加密儲存，請用 iPhone Safari、Android Chrome 等較新的瀏覽器，並從 https 網址開啟。</p></div>';
    return;
  }
  try { META = await DB.get('meta'); } catch { META = null; }
  history.replaceState({ d: 0 }, '', '#/');
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const reg = () => navigator.serviceWorker.register('./sw.js').catch(() => {});
    document.readyState === 'complete' ? reg() : window.addEventListener('load', reg);
  }
})();
