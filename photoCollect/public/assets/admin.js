// 管理頁主程式：解析網址片段、載入資料、頁首、分頁、確認對話框、自動更新
// 驗證方式：網址有 k 就用管理碼（舊流程）；只有 e 則靠 Google 登入 cookie，依角色（owner／manager／viewer）調整畫面。
import {
  adminApi, ApiError, upsertEvent, loadEvents, stageOf, fmtDateTime, toast,
} from './admin-common.js';
import { renderGphotos } from './admin-gphotos.js';
import { renderSetup } from './admin-setup.js';
import { renderProgress } from './admin-progress.js';
import { renderHandoff } from './admin-handoff.js';
import { renderSecurity } from './admin-security.js';
import { renderMembers } from './admin-members.js';
import { renderAlbum } from './admin-album.js';
import { initAuth, onAuthChange, mountAccount, googleButton, currentMe } from './auth.js';

const $ = (id) => document.getElementById(id);

// ---------- 確認對話框（可要求輸入指定文字） ----------
function ask({ title, body, okLabel = '確定', danger = false, requireText = '' }) {
  const dlg = $('dlg');
  $('dlg-title').textContent = title;
  $('dlg-body').textContent = body;
  const ok = $('dlg-ok');
  ok.textContent = okLabel;
  ok.className = danger ? 'btn btn-danger' : 'btn btn-primary';
  const wrap = $('dlg-req-wrap');
  const inp = $('dlg-req');
  wrap.hidden = !requireText;
  inp.value = '';
  $('dlg-req-label').textContent = requireText ? `請輸入「${requireText}」二字以確認` : '';
  ok.disabled = !!requireText;
  const onInput = () => { ok.disabled = inp.value.trim() !== requireText; };
  inp.addEventListener('input', onInput);
  return new Promise((resolve) => {
    const done = () => {
      inp.removeEventListener('input', onInput);
      $('dlg-cancel').removeEventListener('click', cancel);
      dlg.removeEventListener('close', done);
      resolve(dlg.returnValue === 'ok');
    };
    const cancel = () => dlg.close('cancel');
    $('dlg-cancel').addEventListener('click', cancel);
    dlg.addEventListener('close', done);
    dlg.returnValue = 'cancel';
    dlg.showModal();
    (requireText ? inp : $('dlg-cancel')).focus();
  });
}

// ---------- 錯誤畫面 ----------
function showError(title, body, retry, { login = false } = {}) {
  $('loading').hidden = true;
  $('app').hidden = true;
  $('error-screen').hidden = false;
  // 「請先登入」畫面放 Google 按鈕；登入成功會觸發 onAuthChange 重新載入
  const box = $('err-auth');
  box.hidden = !login;
  box.replaceChildren(...(login ? [googleButton({ size: 'large' })] : []));
  $('err-title').textContent = title;
  $('err-body').textContent = body;
  const btn = $('err-retry');
  btn.hidden = !retry;
  btn.onclick = retry || null;
}

// ---------- 從 Google 相簿授權頁回來（#e=…&gp=ok|denied|err）：還原原本的網址片段（含管理碼） ----------
const gpReturn = (() => {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''));
  const gp = q.get('gp');
  if (!gp) return null;
  let back = '';
  try { back = sessionStorage.getItem('mv.gp.return') || ''; sessionStorage.removeItem('mv.gp.return'); } catch { /* 私密模式 */ }
  const e = q.get('e') || '';
  const bq = new URLSearchParams(back.replace(/^#/, ''));
  let frag;
  if (back && (!e || bq.get('e') === e)) frag = back.replace(/^#/, '');
  else {
    const rec = loadEvents().find((x) => x.event_id === e);
    frag = `e=${encodeURIComponent(e)}${rec ? `&k=${encodeURIComponent(rec.admin_code)}` : ''}`;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}#${frag}`);
  return { gp, why: q.get('why') || '', reused: q.get('reused') === '1' };
})();

// ---------- 啟動 ----------
const params = new URLSearchParams(location.hash.replace(/^#/, ''));
const id = params.get('e') || '';
const k = params.get('k') || '';
let authOn = false;      // 登入功能是否啟用（/api/auth/config）
let bootSub = null;      // 載入當下的登入身分（sub）；之後登入／登出／換帳號就重新載入

const ctx = {
  id, k, gpReturn,
  api: adminApi(id, k),
  data: null,                 // 最近一次 GET/PATCH 回傳
  listeners: new Set(),
  ask, toast,
  get cfg() { return this.data.config; },
  /** 角色：owner／manager／viewer；管理碼（auth=key）或後端沒給時視為 owner */
  get role() { return this.data?.auth === 'key' ? 'owner' : (this.data?.role || 'owner'); },
  get isOwner() { return this.role === 'owner'; },
  get canWrite() { return this.role !== 'viewer'; },
  /** 套用伺服器回傳並通知各分頁 */
  apply(d, src = 'patch') {
    this.data = d;
    renderHeader();
    this.listeners.forEach((fn) => fn(d, src));
  },
  on(fn) { this.listeners.add(fn); },
  async refresh() { this.apply(await this.api(), 'refresh'); },
  /** PATCH 部分設定；成功回傳新資料，失敗 toast 並丟出 */
  async patch(body, { quiet = false } = {}) {
    try {
      const d = await this.api('', { method: 'PATCH', body });
      this.apply(d);
      if (!quiet) toast('已儲存');
      return d;
    } catch (e) {
      toast(`儲存失敗：${e.message}`, 'err');
      throw e;
    }
  },
  switchTab(name) { selectTab(name, true); },
  /** 完整上傳網址（與合約 upload_url 對齊，補上 origin） */
  uploadUrl() {
    const u = this.data.upload_url || `/u/${this.cfg.upload_code}`;
    try { return new URL(u, location.origin).href; } catch { return location.origin + u; }
  },
};

function renderHeader() {
  const d = ctx.data;
  const c = d.config;
  const name = c.basic?.name || '(未命名活動)';
  $('ev-title').textContent = name;
  document.title = `${name}｜管理`;
  const st = stageOf(d.stage);
  const tag = $('stage-tag');
  tag.textContent = st.name;
  tag.className = `tag ${st.tag}`;
  const parts = [];
  if (c.upload?.closes_at) parts.push(`開放至 ${fmtDateTime(c.upload.closes_at)}`);
  if (d.delete_at) parts.push(`照片於 ${fmtDateTime(d.delete_at).slice(0, 10)} 自動刪除`);
  $('head-note').textContent = parts.join(' · ');
  const mode = c.upload?.mode || 'auto';
  const btn = $('open-toggle');
  btn.classList.toggle('on', !!d.is_open);
  btn.setAttribute('aria-pressed', String(!!d.is_open));
  const modeTxt = { auto: '自動', open: '手動開放', closed: '手動關閉' }[mode];
  $('open-label').textContent = `${d.is_open ? '上傳開放中' : '上傳已關閉'} · ${modeTxt}`;
  btn.title = '點擊切換模式：自動 → 手動開放 → 手動關閉';
  if (k) upsertEvent({ event_id: id, admin_code: k, name, date: c.basic?.date || null, end_date: c.basic?.end_date || null });
  renderAuthBars();
}

/** 角色標籤、唯讀提示、「加入我的 Google 帳號」列 */
function renderAuthBars() {
  const d = ctx.data;
  const tag = $('role-tag');
  const viewer = ctx.role === 'viewer';
  const label = d.auth === 'key' ? '' : { owner: '建立者', manager: '管理者', viewer: '檢視者（唯讀）' }[ctx.role] || '';
  tag.textContent = label;
  tag.hidden = !label;
  tag.className = `tag ${viewer ? 'tag-viewer' : 'tag-role'}`;
  const ro = $('ro-bar');
  ro.hidden = !viewer;
  ro.textContent = viewer ? '你是這個活動的「檢視者」：可以查看進度與設定，但不能修改、排除照片或取得金鑰。' : '';
  document.body.classList.toggle('ro-mode', viewer);
  $('open-toggle').disabled = viewer;
  if (viewer) lockReadonly();
  // 用管理碼開啟、已登入、活動還沒有 owner：可以認領
  const claimable = !!k && !!currentMe().user && authOn && !d.config.owner;
  $('claim-bar').hidden = !claimable;
}

// ---------- 檢視者：把所有會寫入的控制項鎖起來（後端本來就會擋，這裡是為了好用） ----------
const SAFE_BTN = /^(複製|已複製|下載|列印|查看全部|收合|載入更多|立即重新整理|前往|之後再補)/;
function lockReadonly() {
  for (const sec of document.querySelectorAll('.panels > section')) {
    if (sec.id === 'panel-members') continue;       // 共同管理自己依角色處理
    for (const e of sec.querySelectorAll('button, input, textarea, select')) {
      if (e.dataset.roLocked) continue;
      if (e.matches('button') && (e.classList.contains('item-btn') || SAFE_BTN.test(e.textContent.trim()))) continue;
      const t = (e.getAttribute('type') || '').toLowerCase();
      if (e.matches('input, textarea') && !['checkbox', 'radio', 'file', 'button', 'submit'].includes(t)) {
        if (e.readOnly) continue;
        e.readOnly = true;                          // 文字欄位保持可選取、可複製
      } else {
        e.disabled = true;
      }
      e.dataset.roLocked = '1';
    }
  }
}
let lockQueued = false;
new MutationObserver(() => {
  if (ctx.data && ctx.role === 'viewer' && !lockQueued) {
    lockQueued = true;
    queueMicrotask(() => { lockQueued = false; lockReadonly(); });
  }
}).observe(document.querySelector('.panels'), { childList: true, subtree: true });

$('claim-btn').addEventListener('click', async () => {
  const msg = $('claim-msg');
  msg.hidden = true;
  $('claim-btn').disabled = true;
  try {
    await ctx.api('/claim', { method: 'POST' });
    toast('已把這個活動加入你的 Google 帳號');
    await ctx.refresh();
  } catch (e) {
    msg.hidden = false;
    msg.textContent = e.status === 409 ? '此活動已由其他帳號管理' : e.status === 401 ? '請先登入 Google 再試一次' : e.message;
    $('claim-btn').disabled = e.status === 409;
  }
});

$('open-toggle').addEventListener('click', async () => {
  const c = ctx.cfg;
  const cur = c.upload?.mode || 'auto';
  const next = { auto: 'open', open: 'closed', closed: 'auto' }[cur];
  const desc = {
    auto: '自動：依「開放時間／截止時間」決定是否開放。',
    open: '手動開放：不看開放時間，立刻開放上傳，直到你再改。',
    closed: '手動關閉：立刻停止上傳，直到你再改。',
  };
  const ok = await ask({
    title: '切換上傳模式',
    body: `目前是「${desc[cur]}」\n要改成「${desc[next]}」？`,
    okLabel: '切換',
  });
  if (!ok) return;
  try { await ctx.patch({ upload: { ...c.upload, mode: next } }); } catch { /* 已 toast */ }
});

// ---------- 分頁（WAI-ARIA tabs，左右鍵／Home／End 切換） ----------
let TABS = ['setup', 'progress', 'album', 'gphotos', 'handoff', 'security'];   // 登入功能啟用時多一個 members
const tabHooks = {};                                            // 切到某分頁時要做的事（共同管理＝重新讀名單）
let curTab = 'setup';
function selectTab(name, focus = false) {
  curTab = name;
  for (const t of TABS) {
    const tab = $(`tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (name === 'progress') ctx.refresh().catch(() => {});
  tabHooks[name]?.();
}
$('tablist').addEventListener('click', (e) => {
  const t = e.target.closest('[role="tab"]');
  if (t) selectTab(t.dataset.tab);
});
$('tablist').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(curTab);
  let n = -1;
  if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
  else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = TABS.length - 1;
  if (n >= 0) { e.preventDefault(); selectTab(TABS[n], true); }
});

// ---------- 載入 ----------
const ID_RE = /^ev_[A-Za-z0-9_-]{12}$/;
async function boot() {
  $('loading').hidden = false;
  $('error-screen').hidden = true;
  authOn = await initAuth();
  bootSub = currentMe().user?.sub || null;
  // 沒有 k：必須靠登入；登入功能沒開就跟過去一樣回報連結不完整
  if (!ID_RE.test(id) || (!k && !authOn)) {
    showError('管理連結不完整', '網址裡找不到活動代碼或管理碼。請從「我的活動」進入，或使用完整的管理連結（…/admin#e=…&k=…）。');
    return;
  }
  let d;
  try {
    d = await ctx.api();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      if (k) showError('管理碼不正確', '這個管理連結的管理碼不對，或已經失效。請改用最新的管理連結。');
      else showError('請先登入', '這個活動需要用 Google 帳號登入才能開啟。登入後會自動進入。', null, { login: true });
    } else if (e instanceof ApiError && e.status === 403) {
      showError('沒有權限', '你沒有這個活動的權限，請向建立者索取。');
    } else if (e instanceof ApiError && e.status === 404) showError('找不到這個活動', '活動不存在或已被刪除。');
    else if (e instanceof ApiError && e.status === 400) showError('管理連結格式不正確', '請確認連結完整複製，沒有少字。');
    else showError('暫時無法連線', e.message || '請稍後再試。', boot);
    return;
  }
  $('loading').hidden = true;
  $('app').hidden = false;

  if (authOn) {
    mountAccount($('acct'));
    $('tab-members').hidden = false;
    TABS = ['setup', 'progress', 'album', 'gphotos', 'handoff', 'security', 'members'];
  }
  const members = authOn ? renderMembers(ctx, $('panel-members')) : null;
  if (members) tabHooks.members = () => members.load();
  const albumPanel = renderAlbum(ctx, $('panel-album'));
  tabHooks.album = () => albumPanel.load();
  const gpPanel = renderGphotos(ctx, $('panel-gphotos'));
  tabHooks.gphotos = () => gpPanel.load();
  const panels = [
    renderSetup(ctx, $('panel-setup')),
    renderProgress(ctx, $('panel-progress')),
    renderHandoff(ctx, $('panel-handoff')),
    renderSecurity(ctx, $('panel-security')),
  ];
  void panels;
  ctx.apply(d, 'init');
  selectTab(gpReturn ? 'gphotos' : 'setup');

  // 每 30 秒自動更新（瀏覽器分頁可見時；輸入中的準備中心不被覆蓋，因為它只更新狀態列）
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    ctx.refresh().catch((e) => {
      // 權限在使用中被收回（例如被移出成員）：改顯示無權限
      if (e instanceof ApiError && e.status === 403) showError('沒有權限', '你沒有這個活動的權限，請向建立者索取。');
    });
  }, 30000);
}
// 手動改網址片段（換活動或管理碼）時重新載入
window.addEventListener('hashchange', () => location.reload());
// 登入身分改變（登入、登出、換帳號）：整頁重新載入，讓各分頁依新的權限重畫
onAuthChange((me) => {
  if ((me.user?.sub || null) !== bootSub) location.reload();
});
boot();
