// 起點頁：建立活動、我的活動清單（localStorage＋Google 帳號三分區）、用管理連結開啟
import {
  h, mount, apiFetch, adminApi, ApiError, loadEvents, upsertEvent, removeEvent,
  getCreateSecret, setCreateSecret, adminHref, adminFullUrl, parseAdminLink,
  stageOf, daysFromNow, fmtDate, fmtDateTime, copyText, toast, flashLabel,
} from './admin-common.js';
import { initAuth, onAuthChange, refreshMe, mountAccount, currentMe } from './auth.js';

const $ = (id) => document.getElementById(id);

function showErr(box, msg) { box.textContent = msg || ''; box.hidden = !msg; }

// ---------- 登入狀態 ----------
let authOn = false;                       // 登入功能是否啟用（/api/auth/config）
const meNow = () => (authOn ? currentMe() : { user: null });
const loggedIn = () => !!meNow().user;
/** 已登入且有免密碼建立資格 */
let forceSecret = false;                  // 免密碼被伺服器拒絕後，改要求輸入密碼
const canFree = () => loggedIn() && !!meNow().user.can_create && !forceSecret;

// ---------- 建立活動 ----------
const form = $('create-form');
$('ev-secret').value = getCreateSecret();

/** 依登入狀態調整建立密碼欄位 */
function applyCreateMode() {
  const free = canFree();
  $('secret-field').hidden = free;
  $('create-free').hidden = !free;
  // 已登入但還沒有資格：說明輸入一次就好；未登入維持原本說明
  const needSecretLogin = loggedIn() && !free;
  $('secret-note').hidden = !needSecretLogin;
  $('secret-hint').textContent = needSecretLogin ? '' : '（只存在這個瀏覽器，之後可修改）';
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('ev-name').value.trim();
  const date = $('ev-date').value || null;
  const endDate = $('ev-end').value || null;
  const secret = $('ev-secret').value.trim();
  const err = $('create-err');
  showErr(err, '');
  const free = canFree();
  if (!name) { showErr(err, '請先輸入活動名稱'); $('ev-name').focus(); return; }
  if (!free && !secret) { showErr(err, '請輸入建立密碼'); $('ev-secret').focus(); return; }
  if (endDate && !date) { showErr(err, '多日活動請先填開始日期'); $('ev-date').focus(); return; }
  if (endDate && endDate < date) { showErr(err, '結束日期不能早於開始日期'); $('ev-end').focus(); return; }
  const btn = $('create-btn');
  btn.disabled = true;
  try {
    const r = await apiFetch('/api/create', { method: 'POST', headers: free ? {} : { 'X-Create-Secret': secret }, body: { name, date, end_date: endDate && endDate !== date ? endDate : null } });
    if (loggedIn()) {
      // 已登入：活動直接歸在這個帳號名下，用 cookie 進管理頁，不帶管理碼
      if (!free) setCreateSecret(secret);
      location.href = adminHref(r.event_id, '');
      return;
    }
    setCreateSecret(secret);
    upsertEvent({ event_id: r.event_id, admin_code: r.admin_code, name, date, end_date: endDate && endDate !== date ? endDate : null, created_at: new Date().toISOString() });
    location.href = adminHref(r.event_id, r.admin_code);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      if (free) {
        // 免密碼資格失效（例如從名單移除）：改顯示密碼欄位
        forceSecret = true;
        applyCreateMode();
        showErr(err, '這個帳號目前沒有免密碼建立的資格，請輸入建立密碼');
      } else showErr(err, '建立密碼不正確');
    } else showErr(err, e.message || '建立失敗，請稍後再試');
    btn.disabled = false;
  }
});

// ---------- 我的活動 ----------
/** 依 API 資料產生「下一步」提示 */
function nextHint(d) {
  const c = d.config;
  const missing = d.must_missing || [];
  switch (d.stage) {
    case 'planning':
      if (!c.segments?.length) return '貼上活動流程表';
      if (missing.includes('upload')) return '設定開放上傳時間與告知文字';
      return '等待開放時間，可先分享上傳連結';
    case 'open': return `看即時進度（已收到 ${d.stats?.total ?? 0} 張）`;
    case 'grace': return '補傳期：看進度，提醒大家補傳';
    case 'closed': return c.sync?.key ? '照片可同步，交給 MV 製作者' : '交給 MV 製作者，產生同步金鑰';
    case 'purged': return `照片已於 ${fmtDate(c.deleted_at) || '到期'} 刪除`;
    default: return '';
  }
}

function renderRow(rec) {
  const badge = h('span', { class: 'tag', text: '讀取中…' });
  const next = h('div', { class: 'ev-next muted', text: '正在讀取進度…' });
  const date = h('div', { class: 'muted small', text: daysFromNow(rec.date, rec.end_date) });
  const title = h('a', { class: 'ev-title', href: adminHref(rec.event_id, rec.admin_code), text: rec.name || '(未命名活動)' });
  const copyBtn = h('button', { type: 'button', class: 'btn btn-sm', text: '複製管理連結' });
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(adminFullUrl(rec.event_id, rec.admin_code));
    if (ok) flashLabel(copyBtn, '已複製'); else toast('無法複製，請手動複製網址列', 'err');
  });
  const rmBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `從清單移除 ${rec.name || ''}`, text: '移除' });
  rmBtn.addEventListener('click', () => {
    if (!confirm(`從這個瀏覽器的清單移除「${rec.name}」？\n（只移除清單，不會刪除活動。若沒有另外保存管理連結，之後就無法再管理它。）`)) return;
    removeEvent(rec.event_id);
    row.remove();
    if (!$('ev-list').children.length) renderList();
  });
  // 已登入：舊流程的活動（有管理碼）可以認領到自己的 Google 帳號
  const msg = h('div', { class: 'ac-row-msg', role: 'alert', hidden: true });
  let claimBtn = null;
  if (loggedIn()) {
    claimBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: '加入我的帳號' });
    claimBtn.addEventListener('click', async () => {
      claimBtn.disabled = true;
      msg.hidden = true;
      try {
        await apiFetch(`/api/admin/${encodeURIComponent(rec.event_id)}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${rec.admin_code}` } });
        removeEvent(rec.event_id);
        toast('已加入你的帳號');
        await refreshMe();   // 重新整理後會從「這台瀏覽器」移到「我建立的活動」
        renderAll();
      } catch (e) {
        msg.hidden = false;
        if (e.status === 409) {
          msg.textContent = '此活動已由其他帳號管理';
          return;                           // 無法認領，不再重試
        }
        msg.textContent = e.status === 401 ? '管理碼不正確，或登入已過期，請重新登入後再試' : (e.message || '加入失敗，請稍後再試');
        claimBtn.disabled = false;
      }
    });
  }
  const row = h('div', { class: 'ev-row' },
    h('div', { class: 'ev-main' }, title, date),
    badge, next,
    h('div', { class: 'ev-actions' }, claimBtn, copyBtn, rmBtn),
    msg);

  adminApi(rec.event_id, rec.admin_code)().then((d) => {
    const st = stageOf(d.stage);
    badge.className = `tag ${st.tag}`;
    badge.textContent = st.name;
    next.textContent = `下一步：${nextHint(d)}`;
    // 名稱／日期以伺服器為準並回寫清單
    const nm = d.config.basic?.name || rec.name;
    if (nm !== rec.name || d.config.basic?.date !== rec.date || (d.config.basic?.end_date || null) !== (rec.end_date || null)) {
      upsertEvent({ event_id: rec.event_id, name: nm, date: d.config.basic?.date || null, end_date: d.config.basic?.end_date || null });
      title.textContent = nm;
      date.textContent = daysFromNow(d.config.basic?.date, d.config.basic?.end_date);
    }
  }).catch((e) => {
    badge.className = 'tag tag-warn';
    badge.textContent = '無法讀取';
    next.textContent = e.status === 401 ? '管理碼不正確或已更換，請改用最新的管理連結'
      : e.status === 404 ? '找不到這個活動（可能已被刪除）' : '暫時無法讀取，稍後再試';
  });
  return row;
}

/** 這台瀏覽器記住的活動（舊流程）。已登入時，已在帳號名下的不重複列出 */
function renderList() {
  const owned = new Set((meNow().events || []).map((x) => x.event_id));
  const list = loadEvents().filter((x) => !(loggedIn() && owned.has(x.event_id)));
  const box = $('ev-list');
  if (!list.length) {
    mount(box, h('div', { class: 'card muted', text: loggedIn() ? '這台瀏覽器沒有另外記住的活動。' : '還沒有活動。從左邊建立一個，或貼上管理連結加入。' }));
    return;
  }
  mount(box, list.map(renderRow));
}

// ---------- 帳號三分區（登入後） ----------
function rmFromAccount(kind, rec) {
  const what = kind === 'events' ? '你的活動清單' : '你上傳過的活動清單';
  return async (btn) => {
    if (!confirm(`從${what}移除「${rec.name || ''}」？\n（只移除清單，不會刪除活動或照片。）`)) return;
    btn.disabled = true;
    try {
      await apiFetch(`/api/me/${kind}/${encodeURIComponent(rec.event_id)}`, { method: 'DELETE' });
      await refreshMe();
      renderAll();
    } catch (e) {
      btn.disabled = false;
      toast(`移除失敗：${e.message}`, 'err');
    }
  };
}
function removeBtn(kind, rec) {
  const b = h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `從清單移除 ${rec.name || ''}`, text: '從清單移除' });
  const run = rmFromAccount(kind, rec);
  b.addEventListener('click', () => run(b));
  return b;
}
const ROLE_TAG = { manager: ['管理者', 'tag tag-role'], viewer: ['檢視者', 'tag tag-viewer'] };

function eventRow(ev, { shared }) {
  const st = stageOf(ev.stage);
  const tags = [h('span', { class: `tag ${st.tag}`, text: st.name })];
  if (shared) {
    const [label, cls] = ROLE_TAG[ev.role] || ['檢視者', 'tag tag-viewer'];
    tags.push(h('span', { class: cls, text: label }));
  }
  return h('div', { class: 'ev-row' },
    h('div', { class: 'ev-main' },
      h('a', { class: 'ev-title', href: adminHref(ev.event_id, ''), text: ev.name || '(未命名活動)' }),
      h('div', { class: 'muted small', text: daysFromNow(ev.date, ev.end_date) })),
    h('div', { class: 'row' }, tags),
    h('div', { class: 'ev-actions' }, shared ? null : removeBtn('events', ev)));
}

function uploadRow(u) {
  const when = u.last_at ? `最後上傳 ${fmtDateTime(u.last_at)}` : '';
  const sub = [`已上傳 ${u.count ?? 0} 張`, when].filter(Boolean).join(' · ');
  return h('div', { class: 'ev-row' },
    h('div', { class: 'ev-main' },
      u.valid && u.upload_url
        ? h('a', { class: 'ev-title', href: u.upload_url, text: u.name || '(未命名活動)' })
        : h('span', { class: 'ev-title-off', text: u.name || '(未命名活動)' }),
      h('div', { class: 'muted small', text: sub })),
    u.valid ? null : h('span', { class: 'tag tag-off', text: '連結已失效' }),
    h('div', { class: 'ev-actions' }, removeBtn('uploads', u)));
}

function section(title, items, emptyText, build) {
  return h('section', { class: 'ac-sec', 'aria-label': title },
    h('h2', { class: 'h2 ac-sec-h' }, title, h('span', { class: 'count', text: items.length ? `${items.length}` : '' })),
    items.length ? h('div', { class: 'stack' }, items.map(build)) : h('div', { class: 'ac-empty', text: emptyText }));
}

function renderAcct() {
  const box = $('acct-sections');
  if (!loggedIn()) { box.hidden = true; box.replaceChildren(); return; }
  const m = meNow();
  box.hidden = false;
  mount(box,
    section('我建立的活動', m.events || [], '還沒有活動。從左邊建立一個。', (e) => eventRow(e, { shared: false })),
    section('別人分享給我的', m.shared || [], '還沒有人分享活動給你。請對方在「共同管理」加入你的 Google Email。', (e) => eventRow(e, { shared: true })),
    section('我上傳過的活動', m.uploads || [], '登入後在活動的上傳頁上傳照片，就會記在這裡。', uploadRow));
}

/** 依登入狀態切換整頁：提示、分區、本機清單標題 */
function renderAll() {
  const li = loggedIn();
  $('auth-hint').hidden = !(authOn && !li);
  $('list-h').textContent = li ? '這台瀏覽器記住的活動' : '我的活動';
  $('local-note').textContent = li
    ? '這些活動只記在這台瀏覽器（用管理連結開啟的舊流程）。按「加入我的帳號」後，換電腦登入 Google 也能找到。'
    : '管理連結只存在這個瀏覽器裡，換電腦或清除瀏覽資料就找不回來。請按每筆活動的「複製管理連結」，另外保存到筆記或雲端硬碟。';
  renderAcct();
  renderList();
}
renderAll();

// 登入功能：啟用時才顯示帳號區與相關 UI；未啟用就維持原本行為
initAuth().then((on) => {
  authOn = on;
  if (!on) return;
  mountAccount($('acct'));
  applyCreateMode();
  renderAll();
  onAuthChange(() => { forceSecret = false; applyCreateMode(); renderAll(); });
});

// ---------- 用管理連結開啟 ----------
$('open-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('open-err');
  showErr(err, '');
  const p = parseAdminLink($('open-link').value);
  if (!p) { showErr(err, '看不出這是管理連結，請貼上完整的「…/admin#e=…&k=…」'); return; }
  try {
    const d = await adminApi(p.e, p.k)();
    upsertEvent({ event_id: p.e, admin_code: p.k, name: d.config.basic?.name || '', date: d.config.basic?.date || null, end_date: d.config.basic?.end_date || null });
    $('open-link').value = '';
    renderList();
    toast('已加入我的活動');
  } catch (e) {
    showErr(err, e.status === 401 ? '管理碼不正確' : e.status === 404 ? '找不到這個活動' : e.message);
  }
});
