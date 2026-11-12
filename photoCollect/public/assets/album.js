// 參與者相簿：瀏覽、選最佳照片（每人上限；自己拍的不佔名額）、回報不想入鏡
// 所有伺服器／使用者字串一律用 textContent 插入，不使用 innerHTML。
import { googleButton, onAuthChange, initAuth } from './auth.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 忽略 */ } },
};
const sstore = {
  get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* 忽略 */ } },
};
function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
let deviceId = store.get('mv.device');
if (!deviceId) { deviceId = randomId(); store.set('mv.device', deviceId); }

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
function heartSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z');
  s.append(p);
  return s;
}
function say(t) { const l = $('live'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 50); }
function toast(t) {
  const d = el('div', { class: 'toast', role: 'status' }, t);
  document.body.append(d);
  setTimeout(() => d.remove(), 2600);
}
const pad = (n) => String(n).padStart(2, '0');
const hm = (s) => (s && s.length >= 16 ? s.slice(11, 16) : '');
function fmtWhen(iso) { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// ---------- 網址與 API ----------
const code = decodeURIComponent(location.pathname.split('/')[2] || '');
const API = `/api/a/${encodeURIComponent(code)}`;
const KEY_NAME = `mv.albumKey.${code}`;
let albumKey = sstore.get(KEY_NAME) || '';

function headers(extra = {}) {
  const h = { 'x-device': deviceId, ...extra };
  if (albumKey) h['x-album-key'] = albumKey;
  return h;
}
const imgUrl = (kind, h, dl) => `${API}/${kind}/${h}?d=${encodeURIComponent(deviceId)}${albumKey ? `&k=${albumKey}` : ''}${dl ? '&download=1' : ''}`;

async function call(method, path, body, extra) {
  const h = headers(extra);
  if (body) h['content-type'] = 'application/json';
  let r;
  try { r = await fetch(API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
  catch (_) { throw Object.assign(new Error('無法連線，請檢查網路後再試。'), { status: 0 }); }
  let j = null;
  try { j = await r.json(); } catch (_) { /* 非 JSON */ }
  if (!r.ok) throw Object.assign(new Error((j && j.message) || `發生錯誤（${r.status}）`), { status: r.status, code: j && j.error });
  return j;
}

// ---------- 狀態 ----------
let info = null;
let tab = '全部';
let sort = 'time';
let shown = []; // 目前格子裡的照片（順序同畫面）
let vIdx = -1; // 大圖目前索引
let pendingVote = null; // 等暱稱填好後要補送的選擇

function gate(title, text, { pw = false, login = false } = {}) {
  for (const id of ['picks', 'tabs', 'main', 'nick']) $(id).hidden = true;
  $('who-btn').hidden = true;
  $('gate').hidden = false;
  $('gate-h').textContent = title;
  $('gate-text').textContent = text;
  $('pw-form').hidden = !pw;
  const gl = $('gate-login');
  gl.hidden = !login;
  if (login && !gl.firstChild) gl.append(googleButton());
  $('gate-h').focus({ preventScroll: true });
}

async function load(pass) {
  try {
    info = await call('GET', '/info', null, pass ? { 'x-album-pass': pass } : undefined);
  } catch (e) {
    if (e.code === 'album_password') {
      albumKey = '';
      gate('這個相簿需要密碼', pass ? '密碼不正確，請再試一次。' : '請輸入主辦者在群組公布的相簿密碼。', { pw: true });
      if (pass) $('pw').select();
    } else if (e.code === 'login_required') {
      gate('請先用 Google 登入', '主辦者設定這個相簿要登入才能看，這樣才能確保一人一份選票。', { login: true });
    } else if (e.status === 404) {
      gate('相簿未開放', '主辦者還沒開放相簿，或連結已經失效。');
    } else {
      gate('載入失敗', e.message);
    }
    return;
  }
  if (info.key) { albumKey = info.key; sstore.set(KEY_NAME, albumKey); }
  paint();
}

$('pw-form').addEventListener('submit', (e) => { e.preventDefault(); load($('pw').value); });

function paint() {
  $('gate').hidden = true;
  const ev = info.event;
  $('ev-name').textContent = ev.name || '活動相簿';
  document.title = `${ev.name}｜活動相簿`;
  const sub = [`${info.photos.length} 張`];
  if (info.album.closes_at) sub.push(`${info.album.voting_open ? '票選至' : '票選已於'} ${fmtWhen(info.album.closes_at)}${info.album.voting_open ? '' : ' 截止'}`);
  else if (!info.album.voting_open) sub.push('票選已截止');
  $('ev-sub').textContent = sub.join(' · ');
  paintWho();
  paintPicks();
  const closed = $('closed-note');
  closed.hidden = info.album.voting_open;
  closed.textContent = '票選已截止，相簿目前只能瀏覽。';

  const counts = {};
  for (const p of info.photos) counts[p.segment || '未分類'] = (counts[p.segment || '未分類'] || 0) + 1;
  const names = ['全部', ...info.segments.filter((s) => counts[s]), ...(counts['未分類'] ? ['未分類'] : [])];
  if (!names.includes(tab)) tab = '全部';
  $('tabs').replaceChildren(...names.map((n) => el('button', {
    type: 'button', class: 'filter', 'aria-pressed': String(n === tab), onclick: () => { tab = n; paint(); },
  }, n)));
  $('tabs').hidden = names.length <= 2 && !info.photos.length;
  $('sort-btn').hidden = !info.album.votes_visible;
  if (!info.album.votes_visible) sort = 'time';
  $('sort-label').textContent = sort === 'time' ? '依拍攝時間' : '依票數';

  shown = info.photos.filter((p) => tab === '全部' || (p.segment || '未分類') === tab);
  if (sort === 'hot') shown = shown.slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));
  $('count-line').textContent = `${tab === '全部' ? '全部環節' : tab} · ${shown.length} 張`;
  $('grid').replaceChildren(...shown.map(tile));
  $('empty').hidden = info.photos.length > 0;
  $('main').hidden = false;
  if (vIdx >= 0) paintViewer();
}

function paintWho() {
  const me = info.me;
  const btn = $('who-btn');
  btn.hidden = !me.kind;
  if (me.kind === 'google') btn.textContent = `${me.name || '已登入'}（Google）`;
  else btn.textContent = me.name ? `${me.name}（這支手機）· 更改` : '輸入暱稱';
  const showNick = me.needs_name && info.album.voting_open;
  if (showNick) openNick(false);
}
function openNick(focus = true) {
  const n = $('nick');
  n.hidden = false;
  $('nick-in').value = info.me.name || '';
  const nl = $('nick-login');
  if (!nl.firstChild) {
    initAuth().then((on) => {
      if (!on || nl.firstChild) return;
      nl.append(el('div', { class: 'sec-hint', style: 'margin:4px 0 6px' }, '或改用 Google 登入（換手機也保留選擇）'), googleButton({ size: 'medium' }));
    });
  }
  if (focus) $('nick-in').focus();
}
$('who-btn').addEventListener('click', () => { if (info.me.kind === 'device') { if ($('nick').hidden) openNick(); else $('nick').hidden = true; } });
$('nick-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('nick-in').value.trim();
  if (!name) return;
  try {
    const r = await call('POST', '/me', { name });
    info.me = r.me;
    $('nick').hidden = true;
    paintWho();
    say(`已設定暱稱 ${name}`);
    if (pendingVote) { const pv = pendingVote; pendingVote = null; await toggleVote(pv); }
  } catch (err) { toast(err.message); }
});

function countedPicks() { return info.me.picks.length; }

function paintPicks() {
  const me = info.me;
  const limit = info.album.limit;
  $('picks').hidden = !me.kind;
  const n = countedPicks();
  $('pk-n').textContent = `${n} / ${limit}`;
  $('pk-fill').style.width = `${Math.min(100, Math.round((n / limit) * 100))}%`;
  $('pk-bar').setAttribute('aria-valuemax', String(limit));
  $('pk-bar').setAttribute('aria-valuenow', String(n));
  const full = n >= limit;
  const note = $('pk-note');
  note.textContent = !info.album.voting_open ? '票選已截止' : full ? '已選滿，取消一張才能再選' : `還可以選 ${limit - n} 張`;
  note.style.color = full && info.album.voting_open ? 'var(--c-warn-ink)' : '';
  note.style.fontWeight = full && info.album.voting_open ? '700' : '';
  const own = $('pk-own');
  own.hidden = !me.self.length;
  own.textContent = `另選了自己拍的 ${me.self.length} 張（攝影者選自己的作品不限張數，結果會分開標示）`;
}

const isPicked = (p) => info.me.picks.includes(p.hash) || info.me.self.includes(p.hash);

function tile(p, i) {
  const on = isPicked(p);
  const wrap = el('div', { class: 'tile', style: 'cursor:default' });
  const open = el('button', { type: 'button', class: 'tile', style: 'position:absolute;inset:0;border-radius:0;background:transparent', 'aria-label': `開啟大圖：${p.segment || '未分類'}${p.uploader ? `，攝影 ${p.uploader}` : ''}`, onclick: () => openViewer(i) });
  if (p.has_thumb || p.viewable) {
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => { img.remove(); open.append(el('span', { class: 'noimg' }, '無預覽')); });
    img.src = imgUrl('thumb', p.hash);
    open.append(img);
  } else open.append(el('span', { class: 'noimg' }, '無預覽'));
  wrap.append(open);
  if (p.segment) wrap.append(el('span', { class: 'badge b-seg' }, p.segment));
  if (p.mine) wrap.append(el('span', { class: 'badge b-mine' }, '我拍的 · 不佔名額'));
  const full = !p.mine && countedPicks() >= info.album.limit && !on;
  const heart = el('button', {
    type: 'button', class: 'heart', 'aria-pressed': String(on),
    'aria-label': `${on ? '取消選擇' : '選為最佳照片'}${info.album.votes_visible ? `（目前 ${p.votes || 0} 票）` : ''}`,
    disabled: !info.album.voting_open || !info.me.kind,
    onclick: () => (full ? toast(`每人最多選 ${info.album.limit} 張，請先取消一張`) : toggleVote(p.hash)),
  }, heartSvg());
  if (info.album.votes_visible) heart.append(el('span', { style: 'font-variant-numeric:tabular-nums' }, String(p.votes || 0)));
  wrap.append(heart);
  return wrap;
}

async function toggleVote(hash) {
  const p = info.photos.find((x) => x.hash === hash);
  if (!p) return;
  if (info.me.kind === 'device' && !info.me.name) {
    pendingVote = hash;
    openNick();
    toast('請先輸入暱稱');
    return;
  }
  const on = !isPicked(p);
  try {
    const r = await call('POST', '/vote', { hash, on });
    info.me = r.me;
    if (info.album.votes_visible) p.votes = Math.max(0, (p.votes || 0) + (on ? 1 : -1));
    say(on ? '已選為最佳照片' : '已取消選擇');
    paint();
  } catch (e) {
    if (e.code === 'name_required') { pendingVote = hash; openNick(); }
    toast(e.message);
  }
}
$('sort-btn').addEventListener('click', () => { sort = sort === 'time' ? 'hot' : 'time'; paint(); });

// ---------- 大圖 ----------
function openViewer(i) {
  vIdx = i;
  $('viewer').hidden = false;
  $('opt-box').hidden = true;
  paintViewer();
  $('v-close').focus();
}
function closeViewer() {
  const i = vIdx;
  vIdx = -1;
  $('viewer').hidden = true;
  const tiles = $('grid').querySelectorAll('.tile > .tile');
  if (tiles[i]) tiles[i].focus();
}
function paintViewer() {
  if (vIdx < 0) return;
  if (!shown.length) { closeViewer(); return; }
  if (vIdx >= shown.length) vIdx = shown.length - 1;
  const p = shown[vIdx];
  const on = isPicked(p);
  $('v-pos').textContent = `${vIdx + 1} / ${shown.length}`;
  $('v-picks').textContent = info.me.kind ? `我的選擇 ${countedPicks()} / ${info.album.limit}` : '';
  $('v-img').src = p.viewable ? imgUrl('photo', p.hash) : imgUrl('thumb', p.hash);
  $('v-img').alt = `${p.segment || '未分類'}${p.uploader ? `，攝影 ${p.uploader}` : ''}`;
  $('v-seg').textContent = p.segment || '未分類';
  $('v-by').textContent = [p.uploader ? `攝影：${p.uploader}${p.mine ? '（你）' : ''}` : (p.mine ? '你拍的' : ''), hm(p.exif_time)].filter(Boolean).join(' · ');
  $('v-votes').textContent = info.album.votes_visible ? `${p.votes || 0} 人選它` : '';
  const btn = $('v-pick');
  btn.setAttribute('aria-pressed', String(on));
  btn.disabled = !info.album.voting_open || !info.me.kind;
  $('v-pick-label').textContent = on ? '已選為最佳（再按取消）' : (p.mine ? '選為最佳（自己的作品，不佔名額）' : '選為最佳照片');
  const dl = $('v-dl');
  dl.hidden = !info.album.allow_download;
  dl.href = imgUrl('photo', p.hash, true);
  $('opt-link').hidden = !info.me.kind || p.mine || !$('opt-box').hidden; // 自己拍的照片到「我上傳的照片」刪除即可
  $('opt-link').textContent = info.me.optouts.includes(p.hash) ? '已通知主辦者' : '照片裡有我，我不想入鏡';
  $('v-prev').hidden = $('v-next').hidden = shown.length < 2;
}
const step = (d) => { if (!shown.length) return; vIdx = (vIdx + d + shown.length) % shown.length; $('opt-box').hidden = true; paintViewer(); };
$('v-prev').addEventListener('click', () => step(-1));
$('v-next').addEventListener('click', () => step(1));
$('v-close').addEventListener('click', closeViewer);
$('v-pick').addEventListener('click', () => {
  const p = shown[vIdx];
  if (!p) return;
  if (!p.mine && !isPicked(p) && countedPicks() >= info.album.limit) { toast(`每人最多選 ${info.album.limit} 張，請先取消一張`); return; }
  toggleVote(p.hash);
});
$('opt-link').addEventListener('click', () => { $('opt-box').hidden = false; $('opt-link').hidden = true; $('opt-yes').focus(); });
$('opt-no').addEventListener('click', () => { $('opt-box').hidden = true; paintViewer(); });
$('opt-yes').addEventListener('click', async () => {
  const p = shown[vIdx];
  if (!p) return;
  try {
    await call('POST', '/optout', { hash: p.hash });
    info.photos = info.photos.filter((x) => x.hash !== p.hash);
    $('opt-box').hidden = true;
    toast('已通知主辦者，這張已先隱藏');
    say('已通知主辦者，這張照片已先從相簿隱藏');
    paint();
  } catch (e) { toast(e.message); }
});
// 鍵盤：Esc 關閉、左右鍵切換
document.addEventListener('keydown', (e) => {
  if ($('viewer').hidden) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});
// 左右滑動切換
let touchX = null;
$('viewer').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$('viewer').addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
});

onAuthChange(() => load());

if (!code) gate('找不到相簿', '請從主辦者提供的連結開啟。');
else load();
