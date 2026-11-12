// 「我上傳的照片」：檢視、修改小隊／環節／備註、更換、刪除（只看得到這支手機或登入帳號上傳的照片）
// 所有伺服器／使用者字串一律用 textContent 插入，不使用 innerHTML。
import { readExifTime, mtimeToLocalIso } from './upload-exif.js';
import { sha256Hex, guessMime, processImage } from './upload-image.js';
import { mountAccount, onAuthChange } from './auth.js';
import { groupByDay } from './days.js';

const $ = (id) => document.getElementById(id);
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
const svg = (d, size = 14, sw = 3) => {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
};
function say(t) { const l = $('live'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 50); }
function toast(t) {
  const d = el('div', { class: 'toast', role: 'status' }, t);
  document.body.append(d);
  setTimeout(() => d.remove(), 2600);
}
const VIEWS = ['msg', 'list', 'edit'];
function show(v) {
  for (const n of VIEWS) $('view-' + n).hidden = n !== v;
  const f = { msg: 'msg-title', list: 'list-h', edit: 'edit-h' }[v];
  $(f).focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
const pad = (n) => String(n).padStart(2, '0');
const hm = (s) => (s && s.length >= 16 ? s.slice(11, 16) : '');
function fmtWhen(iso) { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// ---------- 網址與 API ----------
const code = decodeURIComponent(location.pathname.split('/')[2] || '');
const API = `/api/u/${encodeURIComponent(code)}/mine`;
const uploadUrl = `/u/${encodeURIComponent(code)}`;
$('back-upload').href = uploadUrl;
$('more-link').href = uploadUrl;
$('msg-back').href = uploadUrl;
const thumbUrl = (h, v = '') => `${API}/${h}/thumb?d=${encodeURIComponent(deviceId)}${v ? `&v=${v}` : ''}`;

async function call(method, path, body, isForm) {
  const headers = { 'x-device': deviceId };
  if (body && !isForm) headers['content-type'] = 'application/json';
  let r;
  try {
    r = await fetch(API + path, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined, cache: 'no-store' });
  } catch (_) {
    throw new Error('無法連線，請檢查網路後再試。');
  }
  let j = null;
  try { j = await r.json(); } catch (_) { /* 非 JSON */ }
  if (!r.ok) {
    const e = new Error((j && j.message) || `發生錯誤（${r.status}），請稍後再試。`);
    e.code = j && j.error;
    e.status = r.status;
    throw e;
  }
  return j;
}

// ---------- 狀態 ----------
let data = null; // GET /mine 結果
let filter = '全部';
let selecting = false;
const sel = new Set();

function msg(title, text, back = true) {
  $('msg-title').textContent = title;
  $('msg-text').textContent = text;
  $('msg-back').hidden = !back;
  show('msg');
}

async function load(keepView = false) {
  try {
    data = await call('GET', '');
  } catch (e) {
    msg(e.status === 404 ? '找不到這個上傳連結' : '載入失敗', e.message);
    return;
  }
  document.title = `我上傳的照片｜${data.event.name}`;
  for (const h of [...sel]) if (!data.photos.some((p) => p.hash === h && !p.excluded)) sel.delete(h);
  paintList();
  if (!keepView) show('list');
}

const segLabel = (p) => p.segment_effective || '待標環節';

function paintList() {
  const ps = data.photos;
  const who = data.login ? `${data.login.name || data.login.email}（這支手機＋帳號）` : '這支手機';
  $('list-sub').replaceChildren(
    `${data.event.name} · ${who}上傳 ${ps.length} 張`, el('br'),
    data.editable ? `只有你看得到這一頁${data.closes_at ? `，開放修改至 ${fmtWhen(data.closes_at)}` : ''}` : '只有你看得到這一頁',
  );
  const closed = $('closed-note');
  closed.hidden = data.editable;
  closed.textContent = '已過開放修改時間，只能檢視或刪除照片。需要修改請聯絡主辦者。';
  $('sel-toggle').hidden = !ps.length;
  if (data.album_url) { $('album-link').hidden = false; $('album-link').href = data.album_url; } else $('album-link').hidden = true;

  // 篩選
  const counts = {};
  for (const p of ps) counts[segLabel(p)] = (counts[segLabel(p)] || 0) + 1;
  const names = ['全部', '待標環節', ...data.segments.map((s) => s.name)].filter((n) => n === '全部' || counts[n]);
  if (!names.includes(filter)) filter = '全部';
  $('filters').replaceChildren(...names.map((n) => el('button', {
    type: 'button', class: 'filter', 'aria-pressed': String(n === filter),
    onclick: () => { filter = n; paintList(); },
  }, n, el('span', { class: 'n' }, String(n === '全部' ? ps.length : counts[n])))));
  $('filters').hidden = ps.length === 0;

  const untagged = counts['待標環節'] || 0;
  const flag = $('flag');
  flag.hidden = !(untagged && data.editable);
  flag.textContent = `${untagged} 張還沒標環節，補上後 MV 才能排進對的段落。`;

  const shown = ps.filter((p) => filter === '全部' || segLabel(p) === filter);
  $('grid').replaceChildren(...shown.map(tile));
  const empty = $('empty');
  empty.hidden = ps.length > 0;
  empty.textContent = '這支手機還沒有上傳照片。若你是在其他手機上傳，請用同一個 Google 帳號登入後再看。';
  paintSel();
}

function tile(p) {
  const isSel = sel.has(p.hash);
  const b = el('button', {
    type: 'button',
    class: 'tile' + (p.excluded ? ' is-dim' : '') + (selecting && isSel ? ' is-sel' : ''),
    'aria-label': `${segLabel(p)}，${p.exif_time ? hm(p.exif_time) + ' 拍攝' : ''}${p.excluded ? '，主辦者已排除' : ''}`,
    'aria-pressed': selecting && !p.excluded ? String(isSel) : null,
    onclick: () => {
      if (selecting) {
        if (p.excluded) { toast('主辦者已排除的照片不能批次修改'); return; }
        if (sel.has(p.hash)) sel.delete(p.hash); else sel.add(p.hash);
        paintList();
      } else openEdit([p.hash]);
    },
  });
  {
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => { img.remove(); b.prepend(el('span', { class: 'noimg' }, '無預覽')); });
    img.src = thumbUrl(p.hash, p.edited_at ? Date.parse(p.edited_at) : '');
    b.append(img);
  }
  if (selecting && !p.excluded) b.append(el('span', { class: 'check-dot' }, svg('M5 12l5 5 9-10')));
  let badge = null;
  if (p.excluded) badge = el('span', { class: 'badge b-ex' }, '主辦者已排除');
  else if (!p.segment_effective) badge = el('span', { class: 'badge b-warn' }, '待標環節');
  else if (p.votes) badge = el('span', { class: 'badge' }, `相簿 ${p.votes} 票`);
  if (badge) b.append(badge);
  return b;
}

function paintSel() {
  $('sel-toggle').setAttribute('aria-pressed', String(selecting));
  $('sel-toggle').textContent = selecting ? '完成' : '選取多張';
  $('foot-sel').hidden = !selecting;
  $('foot-main').hidden = selecting;
  $('sel-count').textContent = `已選 ${sel.size} 張`;
  for (const id of ['batch-groups', 'batch-seg', 'batch-del']) $(id).disabled = !sel.size;
  $('batch-groups').disabled = $('batch-seg').disabled = !sel.size || !data.editable;
}
$('sel-toggle').addEventListener('click', () => { selecting = !selecting; if (!selecting) sel.clear(); $('batch-confirm').hidden = true; paintList(); });
$('batch-groups').addEventListener('click', () => openEdit([...sel], 'groups'));
$('batch-seg').addEventListener('click', () => openEdit([...sel], 'segment'));
$('batch-del').addEventListener('click', () => {
  $('batch-confirm-h').textContent = `確定刪除這 ${sel.size} 張照片？`;
  $('batch-confirm').hidden = false;
  $('batch-del-yes').focus();
});
$('batch-del-no').addEventListener('click', () => { $('batch-confirm').hidden = true; });
$('batch-del-yes').addEventListener('click', async () => {
  const btn = $('batch-del-yes');
  btn.disabled = true;
  let ok = 0;
  let err = '';
  for (const h of [...sel]) {
    try { await call('DELETE', `/${h}`); ok++; sel.delete(h); } catch (e) { err = e.message; }
  }
  btn.disabled = false;
  $('batch-confirm').hidden = true;
  toast(err ? `已刪除 ${ok} 張；${err}` : `已刪除 ${ok} 張`);
  say(`已刪除 ${ok} 張`);
  if (!sel.size) selecting = false;
  await load();
});

// ---------- 修改 ----------
let E = null; // { hashes, mode: 'single'|'groups'|'segment', groups:Set, segment, note, replace:{...}|null, dirty, confirmDel }

function openEdit(hashes, mode = 'single') {
  const first = data.photos.find((p) => p.hash === hashes[0]);
  if (!first) return;
  const single = mode === 'single';
  E = {
    hashes, mode,
    groups: new Set(single ? first.groups : []),
    segment: single ? first.segment : null,
    note: single ? first.note || '' : '',
    replace: null,
    dirty: false,
  };
  const canEdit = data.editable && !(single && first.excluded);
  $('edit-h').textContent = single ? '修改照片' : (mode === 'groups' ? `改 ${hashes.length} 張的小隊` : `改 ${hashes.length} 張的環節`);
  const idx = data.photos.findIndex((p) => p.hash === first.hash);
  $('edit-pos').textContent = single ? `第 ${idx + 1} / ${data.photos.length} 張` : '';
  $('photo-sec').hidden = !single;
  $('note-sec').hidden = !single;
  $('grp-sec').hidden = mode === 'segment';
  $('seg-sec').hidden = mode === 'groups';
  if (single) {
    $('pv-img').src = thumbUrl(first.hash, first.edited_at ? Date.parse(first.edited_at) : '');
    $('pv-img').alt = `${segLabel(first)} 的照片`;
    $('pv-votes').hidden = !first.votes;
    $('pv-votes').textContent = `相簿 ${first.votes} 票`;
    $('replace-btn').disabled = !canEdit;
    $('e-note').value = E.note;
    $('e-note').disabled = !canEdit;
  }
  $('del-confirm').hidden = true;
  E.canEdit = canEdit;
  paintEdit(first);
  show('edit');
}

function paintEdit(first) {
  const canEdit = E.canEdit;
  const single = E.mode === 'single';
  if (single) {
    const p = first || data.photos.find((x) => x.hash === E.hashes[0]);
    const lines = [];
    if (E.replace) lines.push(`${E.replace.name}${E.replace.w ? ` · ${E.replace.w}×${E.replace.h}` : ''}`);
    const meta = [];
    if (p.exif_time) meta.push(`拍攝 ${hm(p.exif_time)}`);
    if (p.uploaded_at) meta.push(`上傳 ${fmtWhen(p.uploaded_at)}`);
    if (p.edited_at) meta.push(`修改 ${fmtWhen(p.edited_at)}`);
    if (p.excluded) meta.push('主辦者已排除');
    lines.push(meta.join(' · '));
    $('pv-line').replaceChildren(...lines.flatMap((t, i) => (i ? [el('br'), t] : [t])));
    $('pv-new').hidden = !E.replace;
    $('replace-label').textContent = E.replace ? '復原原照片' : '更換照片';
    const rn = $('replace-note');
    rn.hidden = !E.replace;
    rn.textContent = `換成 ${E.replace ? E.replace.name : ''}。小隊、環節、備註會保留${p.votes ? `；相簿已有的 ${p.votes} 票會歸零，因為參與者選的是舊照片` : ''}。`;
  }
  $('e-groups').replaceChildren(...data.groups.map((g) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(E.groups.has(g)), disabled: !canEdit,
    onclick: () => { if (E.groups.has(g)) E.groups.delete(g); else E.groups.add(g); E.dirty = true; paintEdit(null); },
  }, g)));
  if (!data.groups.length) $('e-groups').replaceChildren(el('span', { class: 'sec-hint' }, '主辦者沒有設定小隊。'));
  const opts = [{ name: 'auto', label: '依拍攝時間自動判斷', time: '' }];
  for (const g of groupByDay(data.segments.filter((s) => !s.kind && !s.rotation_slot))) {
    if (g.label) opts.push({ head: g.label + (g.today ? ' · 今天' : '') });
    opts.push(...g.items.map((s) => ({ name: s.name, label: g.label ? s.title || s.name : s.name, time: `${s.start}–${s.end}` })));
  }
  // 輪站課程：每個區塊列出關卡（選了關卡、沒勾小隊時，伺服器會依時段反推小隊）
  for (const r of data.rotations || []) {
    opts.push({ head: `${r.title}${r.day ? `（第${r.day}天）` : ''} · 選關卡` });
    opts.push(...r.stations.map((st) => ({ name: st.segment, label: st.name, time: st.place || '' })));
    if (r.free_segment) opts.push({ name: r.free_segment, label: '自由活動（輪空時段）', time: '' });
  }
  $('e-segs').replaceChildren(...opts.map((o) => (o.head ? el('div', { class: 'seg-day' }, o.head) : el('button', {
    type: 'button', role: 'radio', class: 'seg', 'aria-checked': String(E.segment === o.name), disabled: !canEdit,
    onclick: () => { E.segment = o.name; E.dirty = true; paintEdit(null); },
    'aria-label': o.name === 'auto' ? null : `${o.name} ${o.time}`,
  }, el('span', { class: 'seg-dot' }), el('span', { class: 'seg-name' }, o.label), el('span', { class: 'seg-time' }, o.time)))));
  const ready = E.dirty && (E.mode !== 'segment' || E.segment);
  $('save-btn').disabled = !ready || !canEdit;
  $('dirty-note').textContent = !canEdit ? (data.editable ? '主辦者已排除，無法修改' : '已過開放修改時間') : E.dirty ? '尚未儲存；MV Studio 下次同步時會更新這張的資料' : '沒有變更';
}

$('edit-back').addEventListener('click', () => {
  if (E && E.dirty && !confirm('有尚未儲存的修改，確定離開？')) return;
  E = null;
  show('list');
});
$('e-note').addEventListener('input', () => { E.note = $('e-note').value; E.dirty = true; paintEdit(null); });
$('del-btn').addEventListener('click', () => { $('del-confirm').hidden = false; $('del-yes').focus(); });
$('del-no').addEventListener('click', () => { $('del-confirm').hidden = true; });
$('del-yes').addEventListener('click', async () => {
  $('del-yes').disabled = true;
  try {
    await call('DELETE', `/${E.hashes[0]}`);
    toast('已刪除');
    say('已刪除這張照片');
    E = null;
    await load();
  } catch (e) { toast(e.message); }
  $('del-yes').disabled = false;
});

$('replace-btn').addEventListener('click', () => {
  if (E.replace) { // 復原
    URL.revokeObjectURL(E.replace.preview);
    E.replace = null;
    const p = data.photos.find((x) => x.hash === E.hashes[0]);
    $('pv-img').src = thumbUrl(p.hash);
    E.dirty = E.note !== (p.note || '') || E.segment !== p.segment || [...E.groups].sort().join() !== [...p.groups].sort().join();
    paintEdit(null);
    return;
  }
  $('replace-input').value = '';
  $('replace-input').click();
});
$('replace-input').addEventListener('change', async () => {
  const f = $('replace-input').files && $('replace-input').files[0];
  if (!f) return;
  const mime = guessMime(f);
  if (!mime) { toast('只接受 JPEG、PNG、WebP、HEIC、GIF 圖片'); return; }
  $('replace-btn').disabled = true;
  $('replace-label').textContent = '處理中…';
  try {
    const buf = await f.arrayBuffer();
    const hash = await sha256Hex(buf);
    if (hash === E.hashes[0]) { toast('選到的是同一張照片'); return; }
    let exif = readExifTime(buf);
    const timeSrc = exif ? 'exif' : 'mtime';
    if (!exif) exif = mtimeToLocalIso(f.lastModified);
    const r = await processImage(f, mime, false);
    const preview = URL.createObjectURL(r.thumb || r.blob);
    E.replace = { file: f, name: f.name || '新照片', hash, exif, timeSrc, blob: r.blob, thumb: r.thumb, w: r.w, h: r.h, preview };
    $('pv-img').src = preview;
    E.dirty = true;
  } catch (_) {
    toast('這張照片無法讀取，請換一張');
  } finally {
    $('replace-btn').disabled = false;
    paintEdit(null);
  }
});

$('save-btn').addEventListener('click', async () => {
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = '儲存中…';
  try {
    if (E.mode === 'single') {
      let h = E.hashes[0];
      const p = data.photos.find((x) => x.hash === h);
      if (E.replace) {
        const R = E.replace;
        const fd = new FormData();
        fd.append('photo', R.blob, R.name);
        if (R.thumb) fd.append('thumb', R.thumb, 'thumb.jpg');
        fd.append('meta', JSON.stringify({ hash: R.hash, orig_name: R.name, exif_time: R.exif || '', time_src: R.timeSrc, w: R.w || '', h: R.h || '' }));
        const res = await call('POST', `/${h}/replace`, fd, true);
        h = res.hash;
        URL.revokeObjectURL(R.preview);
      }
      const body = {};
      if ([...E.groups].sort().join() !== [...p.groups].sort().join()) body.groups = [...E.groups];
      if (E.segment !== p.segment) body.segment = E.segment;
      if (E.note !== (p.note || '')) body.note = E.note;
      if (Object.keys(body).length) await call('PATCH', `/${h}`, body);
      toast(E.replace ? '已更換照片' : '已儲存');
    } else {
      let ok = 0;
      let err = '';
      for (const h of E.hashes) {
        const body = E.mode === 'groups' ? { groups: [...E.groups] } : { segment: E.segment };
        try { await call('PATCH', `/${h}`, body); ok++; } catch (e) { err = e.message; }
      }
      toast(err ? `已更新 ${ok} 張；${err}` : `已更新 ${ok} 張`);
      sel.clear();
      selecting = false;
    }
    say('已儲存');
    E = null;
    await load();
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  } finally {
    btn.textContent = '儲存修改';
  }
});

// ---------- 帳號（選用）：登入後也看得到其他手機上傳的照片 ----------
const acct = $('acct-sec');
mountAccount(acct);
onAuthChange(() => { if (data) load(!$('view-edit').hidden); });

if (!code || code === '_app') msg('找不到上傳連結', '請從主辦者提供的連結開啟。', false);
else load();
