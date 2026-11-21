import {
  createSession, joinSession, subscribeSession, ensureGroupInSession,
  saveItem, deleteItem, setDecision, setProjectorCursor, loadItemImage,
  getRecentSessions, removeRecentSession, importSessionFromBackup,
} from './modules/store.js';
import { compressImageFile, getCachedImage } from './modules/images.js';
import {
  DECISION_META, SUGGESTION_LABELS, OTHER_QUICK_TAGS,
  exportCsv, exportJsonBackup,
} from './modules/export.js';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  mode: 'firebase', // 'firebase' | 'local'
  code: '',
  session: null,
  unsub: null,
  activeTab: 'collect',
  selectedGroup: localStorage.getItem('itemInventory:lastGroup') || '',
  editingItemId: '',
  editingImgId: '',
  pendingImageDataUrl: '',
  suggestion: 'none',
  projectorOpen: false,
  projectorItemId: '',
  wakeLock: null,
};

const $ = (id) => document.getElementById(id);

// ── Utilities ────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function showAlert(msg, actionLabel = '', onAction = null) {
  $('alertBannerText').textContent = msg;
  const btn = $('btnAlertAction');
  if (actionLabel && onAction) {
    btn.textContent = actionLabel;
    btn.classList.remove('hidden');
    btn.onclick = onAction;
  } else {
    btn.classList.add('hidden');
  }
  $('alertBanner').classList.remove('hidden');
}

function hideAlert() {
  $('alertBanner').classList.add('hidden');
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getItemsArray() {
  if (!state.session?.items) return [];
  return Object.values(state.session.items).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function getGroupsArray() {
  const preset = Array.isArray(state.session?.meta?.groups) ? state.session.meta.groups : [];
  const fromItems = getItemsArray().map((i) => i.group).filter(Boolean);
  return [...new Set([...preset, ...fromItems])];
}

// ── Lazy Image Hydration ─────────────────────────────────────────────────────
function hydrateImageElement(imgEl, imgId) {
  if (!imgEl || !imgId) return;
  const cached = getCachedImage(`${state.mode}:${state.code}:${imgId}`);
  if (cached) {
    imgEl.src = cached;
    return;
  }
  loadItemImage(state.code, state.mode, imgId)
    .then((dataUrl) => {
      if (dataUrl && imgEl.isConnected) imgEl.src = dataUrl;
    })
    .catch(() => {});
}

// ── Mode & Home ──────────────────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  $('btnModeFirebase').classList.toggle('active', mode === 'firebase');
  $('btnModeLocal').classList.toggle('active', mode === 'local');
}

function renderRecentSessions() {
  const list = getRecentSessions();
  const card = $('recentCard');
  const container = $('recentList');
  if (!list.length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  container.innerHTML = '';
  list.forEach((entry) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-flex; align-items:center; gap:4px;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.innerHTML = `${entry.mode === 'local' ? '💻' : '☁️'} ${esc(entry.title || entry.code)} <small style="opacity:0.7;">(${esc(entry.code)})</small>`;
    btn.onclick = () => enterSession(entry.code, entry.mode);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chip chip-soft';
    del.style.padding = '5px 8px';
    del.title = '從最近紀錄移除';
    del.textContent = '✕';
    del.onclick = () => {
      removeRecentSession(entry.code, entry.mode);
      renderRecentSessions();
    };
    wrap.append(btn, del);
    container.appendChild(wrap);
  });
}

// ── Session Lifecycle ────────────────────────────────────────────────────────
async function enterSession(code, mode) {
  hideAlert();
  try {
    const res = await joinSession(code, mode);
    openSessionView(res.code, res.mode, res.session);
  } catch (err) {
    handleStoreError(err);
  }
}

function openSessionView(code, mode, initialSession) {
  if (state.unsub) state.unsub();
  state.code = code;
  state.mode = mode;
  state.session = initialSession;

  const url = new URL(location.href);
  url.searchParams.set('code', code);
  if (mode === 'local') url.searchParams.set('mode', 'local');
  else url.searchParams.delete('mode');
  history.replaceState(null, '', url.toString());

  $('homeView').classList.add('hidden');
  $('sessionView').classList.remove('hidden');
  $('btnShowQr').classList.toggle('hidden', mode === 'local');
  $('headerModePill').classList.remove('hidden');
  $('headerModePill').textContent = mode === 'local' ? '💻 本機模式' : '☁️ 雲端同步';
  $('btnLeaveSession').classList.remove('hidden');
  $('headerCode').textContent = code;

  // Restore saved user preferences
  $('inputItemLocation').value = localStorage.getItem('itemInventory:lastLocation') || '';
  $('inputCreatedBy').value = localStorage.getItem('itemInventory:lastUser') || '';

  const groups = getGroupsArray();
  if (!state.selectedGroup || !groups.includes(state.selectedGroup)) {
    state.selectedGroup = groups[0] || '第一組';
  }

  state.unsub = subscribeSession(
    code,
    mode,
    (data) => {
      state.session = data;
      renderSession();
    },
    (err) => handleStoreError(err)
  );
  renderSession();
}

function leaveSession() {
  if (state.unsub) state.unsub();
  state.unsub = null;
  state.code = '';
  state.session = null;
  closeProjector();
  hideAlert();

  const url = new URL(location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('mode');
  history.replaceState(null, '', url.toString());

  $('homeView').classList.remove('hidden');
  $('sessionView').classList.add('hidden');
  $('btnShowQr').classList.add('hidden');
  $('headerModePill').classList.add('hidden');
  $('btnLeaveSession').classList.add('hidden');
  $('headerTitle').textContent = '物品盤點站';
  $('headerSub').textContent = '分組拍照盤點 ・ 投影共同決議';
  renderRecentSessions();
}

function handleStoreError(err) {
  const msg = err?.message || String(err);
  if (/PERMISSION_DENIED|permission/i.test(msg)) {
    showAlert(
      '雲端資料庫尚未設定 itemInventory 讀寫規則，請先將 database.rules.json 合併至 Firebase，或改用「本機單機／雙視窗模式」。',
      '切換至本機模式',
      () => {
        setMode('local');
        hideAlert();
        showToast('已切換至本機模式');
      }
    );
  } else {
    showToast(msg);
  }
}

// ── Render Session ───────────────────────────────────────────────────────────
function renderSession() {
  if (!state.session) return;
  const title = state.session.meta?.title || '物品盤點';
  $('headerTitle').textContent = title;
  $('headerSub').textContent = `場次 ${state.code} ・ 共 ${getItemsArray().length} 項物品`;

  const items = getItemsArray();
  $('tabTotalCount').textContent = String(items.length);

  renderGroupChips();
  renderCollectList();
  renderOverview();
  if (state.projectorOpen) renderProjector();
}

function renderGroupChips() {
  const groups = getGroupsArray();
  if (state.selectedGroup && !groups.includes(state.selectedGroup)) {
    groups.push(state.selectedGroup);
  }
  const container = $('groupChips');
  container.innerHTML = '';
  groups.forEach((g) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip ${state.selectedGroup === g ? 'active' : ''}`;
    btn.textContent = g;
    btn.onclick = () => {
      state.selectedGroup = g;
      localStorage.setItem('itemInventory:lastGroup', g);
      renderGroupChips();
      renderCollectList();
    };
    container.appendChild(btn);
  });
}

function renderCollectList() {
  const allItems = getItemsArray();
  const onlyMine = $('chkOnlyMyGroup').checked;
  const list = onlyMine ? allItems.filter((i) => i.group === state.selectedGroup) : allItems;
  $('collectListCount').textContent = String(list.length);

  const container = $('collectItemsList');
  container.innerHTML = '';
  if (!list.length) {
    container.innerHTML = `<div style="text-align:center; padding:32px 12px; color:var(--text-muted);">目前尚無盤點項目，請從左側拍照登錄第一件物品！</div>`;
    return;
  }

  list.forEach((it) => {
    const dec = DECISION_META[it.decision] || DECISION_META.pending;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:10px; padding:10px; border:1px solid var(--border); border-radius:12px; align-items:center; background:#fff;';

    const thumbWrap = document.createElement('div');
    thumbWrap.style.cssText = 'width:68px; height:68px; border-radius:10px; background:#f1f5f9; overflow:hidden; flex-shrink:0; display:flex; align-items:center; justify-content:center; cursor:pointer;';
    if (it.imgId) {
      const img = document.createElement('img');
      img.alt = it.name;
      img.style.cssText = 'width:100%; height:100%; object-fit:cover;';
      thumbWrap.appendChild(img);
      hydrateImageElement(img, it.imgId);
      thumbWrap.onclick = () => { if (img.src) openLightbox(img.src); };
    } else {
      thumbWrap.innerHTML = '<span style="font-size:1.4rem; opacity:0.4;">📦</span>';
    }

    const info = document.createElement('div');
    info.style.cssText = 'flex:1; min-width:0;';
    info.innerHTML = `
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <strong style="font-size:0.96rem;">${esc(it.name)}</strong>
        <span class="badge badge-group">${esc(it.group)}</span>
        <span class="badge ${dec.cls}">${dec.icon} ${dec.label}</span>
      </div>
      <div class="item-meta" style="margin-top:2px;">
        數量：${it.qty} ${esc(it.unit || '件')}
        ${it.location ? ` ・ 📍 ${esc(it.location)}` : ''}
      </div>
      ${it.note ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(it.note)}</div>` : ''}
    `;

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = '編輯';
    editBtn.onclick = () => startEditItem(it);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = '刪除';
    delBtn.onclick = async () => {
      if (!confirm(`確定要刪除「${it.name}」嗎？`)) return;
      await deleteItem(state.code, state.mode, it.id, it.imgId);
      showToast('已刪除項目');
    };
    btns.append(editBtn, delBtn);

    row.append(thumbWrap, info, btns);
    container.appendChild(row);
  });
}

// ── Overview & Filters ───────────────────────────────────────────────────────
function renderOverview() {
  const items = getItemsArray();
  const counts = { total: items.length, pending: 0, keep: 0, discard: 0, other: 0 };
  items.forEach((it) => {
    const k = counts[it.decision] !== undefined ? it.decision : 'pending';
    counts[k]++;
  });

  $('statTotal').textContent = String(counts.total);
  $('statPending').textContent = String(counts.pending);
  $('statKeep').textContent = String(counts.keep);
  $('statDiscard').textContent = String(counts.discard);
  $('statOther').textContent = String(counts.other);

  $('printTitle').textContent = `${state.session?.meta?.title || '物品盤點'} — 決議清冊`;
  $('printSummaryLine').textContent = `場次代碼：${state.code} ｜ 總計 ${counts.total} 項（續留 ${counts.keep}、丟棄 ${counts.discard}、其它處理 ${counts.other}、待議 ${counts.pending}）`;

  // Group filter options
  const selGroup = $('selectFilterGroup');
  const prevGroup = selGroup.value;
  const groups = getGroupsArray();
  selGroup.innerHTML = '<option value="all">全部組別</option>' +
    groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  if ([...selGroup.options].some((o) => o.value === prevGroup)) selGroup.value = prevGroup;

  const q = $('inputSearch').value.trim().toLowerCase();
  const fg = selGroup.value;
  const fd = $('selectFilterDecision').value;

  const filtered = items.filter((it) => {
    if (fg !== 'all' && it.group !== fg) return false;
    if (fd !== 'all' && (it.decision || 'pending') !== fd) return false;
    if (q) {
      const hay = `${it.name} ${it.location} ${it.note} ${it.group} ${it.decisionNote}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const grid = $('overviewGrid');
  grid.innerHTML = '';
  if (!filtered.length) {
    grid.innerHTML = '<div class="card" style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:36px;">沒有符合條件的物品項目</div>';
    return;
  }

  filtered.forEach((it) => {
    const dec = DECISION_META[it.decision] || DECISION_META.pending;
    const card = document.createElement('article');
    card.className = 'item-card';

    const thumb = document.createElement('div');
    thumb.className = 'item-thumb';
    if (it.imgId) {
      const img = document.createElement('img');
      img.alt = it.name;
      thumb.appendChild(img);
      hydrateImageElement(img, it.imgId);
    } else {
      thumb.innerHTML = '<span class="item-thumb-placeholder">📦 無照片</span>';
    }
    thumb.onclick = () => openProjector(it.id);

    const body = document.createElement('div');
    body.className = 'item-body';
    body.innerHTML = `
      <div class="item-head">
        <h3 class="item-name">${esc(it.name)}</h3>
        <span class="badge ${dec.cls}">${dec.icon} ${dec.label}</span>
      </div>
      <div class="item-meta">
        <span class="badge badge-group">${esc(it.group)}</span>
        ・ 數量 <strong>${it.qty}</strong> ${esc(it.unit || '件')}
        ${it.location ? ` ・ 📍 ${esc(it.location)}` : ''}
      </div>
      ${it.note ? `<div class="item-note">${esc(it.note)}</div>` : ''}
      ${it.decisionNote ? `<div style="font-size:0.82rem; color:var(--primary); font-weight:600;">➜ ${esc(it.decisionNote)}${it.decisionBy ? `（${esc(it.decisionBy)}）` : ''}</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const quickDecisions = [
      { k: 'keep', lbl: '✅ 續留' },
      { k: 'discard', lbl: '🗑️ 丟棄' },
      { k: 'other', lbl: '🔄 其它' },
    ];
    quickDecisions.forEach((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-sm ${it.decision === d.k ? 'btn-primary' : ''}`;
      b.textContent = d.lbl;
      b.onclick = () => setDecision(state.code, state.mode, it.id, {
        decision: d.k,
        decisionNote: it.decisionNote || '',
        decisionBy: it.decisionBy || '',
      });
      actions.appendChild(b);
    });

    const projBtn = document.createElement('button');
    projBtn.type = 'button';
    projBtn.className = 'btn btn-sm btn-soft';
    projBtn.style.marginLeft = 'auto';
    projBtn.textContent = '📺 投影';
    projBtn.onclick = () => openProjector(it.id);
    actions.appendChild(projBtn);

    card.append(thumb, body, actions);
    grid.appendChild(card);
  });
}

// ── Item Form (Photo + Create/Edit) ──────────────────────────────────────────
async function handlePhotoFile(file) {
  if (!file) return;
  try {
    $('photoMetaText').textContent = '正在壓縮照片…';
    $('photoEmptyState').classList.add('hidden');
    $('photoPreviewState').classList.remove('hidden');

    const { dataUrl, w, h, bytes } = await compressImageFile(file);
    state.pendingImageDataUrl = dataUrl;
    $('imgFormPreview').src = dataUrl;
    $('photoMetaText').textContent = `已最佳化：${w}×${h} px（約 ${Math.round(bytes / 1024)} KB）`;
  } catch (err) {
    clearFormPhoto();
    showToast(err?.message || '照片處理失敗');
  }
}

function clearFormPhoto() {
  state.pendingImageDataUrl = '';
  state.editingImgId = '';
  $('imgFormPreview').src = '';
  $('photoMetaText').textContent = '';
  $('photoPreviewState').classList.add('hidden');
  $('photoEmptyState').classList.remove('hidden');
  $('inputCamera').value = '';
  $('inputGallery').value = '';
  $('inputReplacePhoto').value = '';
}

function setSuggestion(sug) {
  state.suggestion = sug;
  $('suggestionChips').querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.sug === sug);
  });
}

function startEditItem(it) {
  state.editingItemId = it.id;
  state.editingImgId = it.imgId || '';
  state.pendingImageDataUrl = '';
  state.selectedGroup = it.group || state.selectedGroup;
  renderGroupChips();

  $('itemFormTitle').textContent = '✏️ 編輯盤點物品';
  $('btnSubmitItem').textContent = '💾 儲存修改';
  $('btnCancelEdit').classList.remove('hidden');

  $('inputItemName').value = it.name || '';
  $('inputItemQty').value = it.qty || 1;
  $('inputItemUnit').value = it.unit || '件';
  $('inputItemLocation').value = it.location || '';
  $('inputCreatedBy').value = it.createdBy || '';
  $('inputItemNote').value = it.note || '';
  setSuggestion(it.suggestion || 'none');

  if (it.imgId) {
    $('photoEmptyState').classList.add('hidden');
    $('photoPreviewState').classList.remove('hidden');
    $('photoMetaText').textContent = '目前照片（若不更換將保留原圖）';
    hydrateImageElement($('imgFormPreview'), it.imgId);
  } else {
    clearFormPhoto();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetItemForm() {
  state.editingItemId = '';
  state.editingImgId = '';
  $('itemFormTitle').textContent = '📸 拍照登錄物品';
  $('btnSubmitItem').textContent = '✅ 登錄物品';
  $('btnCancelEdit').classList.add('hidden');
  $('inputItemName').value = '';
  $('inputItemQty').value = 1;
  $('inputItemNote').value = '';
  setSuggestion('none');
  clearFormPhoto();
}

// ── Projector Spotlight Mode ─────────────────────────────────────────────────
function getProjectorList() {
  const items = getItemsArray();
  if ($('chkProjOnlyPending').checked) {
    const pending = items.filter((i) => !i.decision || i.decision === 'pending');
    return pending.length ? pending : items;
  }
  return items;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch {
    // ignore unsupported environments
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

function openProjector(targetItemId = '') {
  const list = getProjectorList();
  if (!list.length) {
    showToast('目前尚無任何物品可投影');
    return;
  }
  state.projectorOpen = true;
  state.projectorItemId = targetItemId || list[0].id;
  $('projectorOverlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  requestWakeLock();
  renderProjector();
}

function closeProjector() {
  state.projectorOpen = false;
  $('projectorOverlay').classList.add('hidden');
  document.body.style.overflow = '';
  releaseWakeLock();
}

function renderProjector() {
  const all = getItemsArray();
  const list = getProjectorList();
  if (!list.length) {
    closeProjector();
    return;
  }
  let idx = list.findIndex((i) => i.id === state.projectorItemId);
  if (idx === -1) {
    idx = 0;
    state.projectorItemId = list[0].id;
  }
  const it = list[idx];
  const decidedCount = all.filter((i) => i.decision && i.decision !== 'pending').length;
  $('projProgressText').textContent = `第 ${idx + 1} / ${list.length} 項 ・ 已決議 ${decidedCount}/${all.length}`;

  const stage = $('projPhotoStage');
  stage.innerHTML = '';
  if (it.imgId) {
    const img = document.createElement('img');
    img.alt = it.name;
    stage.appendChild(img);
    hydrateImageElement(img, it.imgId);
    img.onclick = () => { if (img.src) openLightbox(img.src); };
  } else {
    stage.innerHTML = '<span style="color:#64748b; font-size:1.1rem;">📦 此物品未附照片</span>';
  }

  const dec = DECISION_META[it.decision] || DECISION_META.pending;
  $('projGroupBadge').textContent = it.group || '未分組';
  const curBadge = $('projCurrentBadge');
  curBadge.className = `badge ${dec.cls}`;
  curBadge.textContent = `${dec.icon} ${dec.label}`;

  $('projItemName').textContent = it.name;
  $('projItemQty').textContent = `${it.qty} ${it.unit || '件'}`;
  $('projItemLocation').textContent = it.location || '未填寫';
  $('projItemCreatedBy').textContent = it.createdBy || '未填寫';
  $('projItemSuggestion').textContent = SUGGESTION_LABELS[it.suggestion] || '無初步建議';
  $('projItemNote').textContent = it.note || '（無現場備註）';

  $('inputProjDecNote').value = it.decisionNote || '';
  $('inputProjDecBy').value = it.decisionBy || '';

  document.querySelectorAll('.dec-btn').forEach((btn) => {
    const d = btn.dataset.dec;
    btn.className = `dec-btn ${it.decision === d ? `active-${d}` : ''}`;
  });
}

async function applyProjectorDecision(decision) {
  const list = getProjectorList();
  const idx = list.findIndex((i) => i.id === state.projectorItemId);
  if (idx === -1) return;
  const it = list[idx];

  const decisionNote = $('inputProjDecNote').value;
  const decisionBy = $('inputProjDecBy').value;

  await setDecision(state.code, state.mode, it.id, {
    decision,
    decisionNote,
    decisionBy,
  });

  if ($('chkProjAutoNext').checked && decision !== 'pending') {
    const nextList = getProjectorList();
    if (nextList.length) {
      const nextIdx = Math.min(idx + ($('chkProjOnlyPending').checked ? 0 : 1), nextList.length - 1);
      state.projectorItemId = nextList[nextIdx]?.id || nextList[0].id;
      setProjectorCursor(state.code, state.mode, state.projectorItemId).catch(() => {});
      renderProjector();
    }
  }
}

function stepProjector(delta) {
  const list = getProjectorList();
  if (!list.length) return;
  const idx = Math.max(0, list.findIndex((i) => i.id === state.projectorItemId));
  const nextIdx = (idx + delta + list.length) % list.length;
  state.projectorItemId = list[nextIdx].id;
  setProjectorCursor(state.code, state.mode, state.projectorItemId).catch(() => {});
  renderProjector();
}

// ── Modals (QR & Lightbox) ───────────────────────────────────────────────────
function openQrModal() {
  const joinUrl = `${location.origin}${location.pathname}?code=${state.code}`;
  $('modalCodeText').textContent = state.code;
  if (window.QRious) {
    new window.QRious({
      element: $('qrCanvas'),
      value: joinUrl,
      size: 210,
      level: 'M',
    });
  }
  $('qrModal').classList.remove('hidden');
}

function openLightbox(src) {
  $('lightboxImg').src = src;
  $('lightboxModal').classList.remove('hidden');
}

// ── Event Wiring ─────────────────────────────────────────────────────────────
function bindEvents() {
  // Mode switch
  $('btnModeFirebase').onclick = () => setMode('firebase');
  $('btnModeLocal').onclick = () => setMode('local');

  // Create session
  $('formCreateSession').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('inputSessionTitle').value;
    const groups = $('inputPresetGroups').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    try {
      const res = await createSession({ title, groups, mode: state.mode });
      openSessionView(res.code, res.mode, res.session);
      showToast(`場次建立成功！代碼：${res.code}`);
    } catch (err) {
      handleStoreError(err);
    }
  };

  // Join session
  $('formJoinSession').onsubmit = async (e) => {
    e.preventDefault();
    await enterSession($('inputJoinCode').value, state.mode);
  };

  // Import JSON backup
  $('inputImportJson').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      showToast('正在匯入備份與照片…');
      const res = await importSessionFromBackup(data, state.mode);
      await enterSession(res.code, res.mode);
      showToast('備份匯入完成！');
    } catch (err) {
      handleStoreError(err);
    }
  };

  // Leave session
  $('btnLeaveSession').onclick = leaveSession;

  // Tabs
  document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      const tab = btn.dataset.tab;
      state.activeTab = tab;
      document.querySelectorAll('.tab-btn[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      $('tabCollect').classList.toggle('hidden', tab !== 'collect');
      $('tabOverview').classList.toggle('hidden', tab !== 'overview');
    };
  });
  $('btnOpenProjector').onclick = () => openProjector();

  // Add new group
  $('btnAddGroup').onclick = async () => {
    const g = $('inputNewGroup').value.trim();
    if (!g) return;
    state.selectedGroup = g;
    localStorage.setItem('itemInventory:lastGroup', g);
    $('inputNewGroup').value = '';
    await ensureGroupInSession(state.code, state.mode, g, getGroupsArray());
    renderGroupChips();
    renderCollectList();
    showToast(`已切換至組別「${g}」`);
  };

  // Photo inputs
  ['inputCamera', 'inputGallery', 'inputReplacePhoto'].forEach((id) => {
    $(id).onchange = (e) => handlePhotoFile(e.target.files?.[0]);
  });
  $('btnClearPhoto').onclick = clearFormPhoto;

  // Qty stepper
  $('btnQtyMinus').onclick = () => {
    const v = Math.max(1, (Number($('inputItemQty').value) || 1) - 1);
    $('inputItemQty').value = v;
  };
  $('btnQtyPlus').onclick = () => {
    const v = (Number($('inputItemQty').value) || 1) + 1;
    $('inputItemQty').value = v;
  };

  // Suggestion chips
  $('suggestionChips').querySelectorAll('.chip').forEach((btn) => {
    btn.onclick = () => setSuggestion(btn.dataset.sug);
  });

  // Submit item
  $('formItem').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('inputItemName').value.trim();
    if (!name) return;

    const loc = $('inputItemLocation').value.trim();
    const user = $('inputCreatedBy').value.trim();
    localStorage.setItem('itemInventory:lastLocation', loc);
    localStorage.setItem('itemInventory:lastUser', user);

    const existing = state.editingItemId ? state.session?.items?.[state.editingItemId] : null;
    const payload = {
      ...(existing || {}),
      id: state.editingItemId || '',
      imgId: state.editingImgId || '',
      name,
      qty: Number($('inputItemQty').value) || 1,
      unit: $('inputItemUnit').value.trim() || '件',
      group: state.selectedGroup || '第一組',
      location: loc,
      createdBy: user,
      note: $('inputItemNote').value.trim(),
      suggestion: state.suggestion,
    };

    const btn = $('btnSubmitItem');
    btn.disabled = true;
    try {
      await ensureGroupInSession(state.code, state.mode, payload.group, getGroupsArray());
      await saveItem(state.code, state.mode, payload, state.pendingImageDataUrl);
      showToast(state.editingItemId ? '已更新物品資料' : `已登錄「${name}」`);
      resetItemForm();
    } catch (err) {
      handleStoreError(err);
    } finally {
      btn.disabled = false;
    }
  };
  $('btnCancelEdit').onclick = resetItemForm;
  $('chkOnlyMyGroup').onchange = renderCollectList;

  // Overview filters & exports
  $('inputSearch').oninput = renderOverview;
  $('selectFilterGroup').onchange = renderOverview;
  $('selectFilterDecision').onchange = renderOverview;
  $('btnExportCsv').onclick = () => exportCsv(state.session, getItemsArray());
  $('btnExportJson').onclick = async () => {
    showToast('正在打包照片與資料…');
    await exportJsonBackup(state.code, state.mode, state.session, getItemsArray());
    showToast('備份下載完成');
  };
  $('btnPrint').onclick = () => window.print();

  // Projector controls
  $('btnCloseProjector').onclick = closeProjector;
  $('btnProjPrev').onclick = () => stepProjector(-1);
  $('btnProjNext').onclick = () => stepProjector(1);
  $('chkProjOnlyPending').onchange = renderProjector;

  // Quick-pick tags for "other" handling
  const tagsWrap = $('projOtherTags');
  OTHER_QUICK_TAGS.forEach((tag) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.style.cssText = 'background:#1e293b; border-color:#475569; color:#e2e8f0; padding:4px 10px; font-size:0.78rem;';
    b.textContent = tag;
    b.onclick = () => {
      $('inputProjDecNote').value = tag;
      applyProjectorDecision('other');
    };
    tagsWrap.appendChild(b);
  });

  document.querySelectorAll('.dec-btn').forEach((btn) => {
    btn.onclick = () => applyProjectorDecision(btn.dataset.dec);
  });

  const saveProjNote = () => {
    const it = state.session?.items?.[state.projectorItemId];
    if (!it) return;
    setDecision(state.code, state.mode, it.id, {
      decision: it.decision || 'pending',
      decisionNote: $('inputProjDecNote').value,
      decisionBy: $('inputProjDecBy').value,
    });
  };
  $('inputProjDecNote').onchange = saveProjNote;
  $('inputProjDecBy').onchange = saveProjNote;

  // Keyboard shortcuts in Projector mode
  window.addEventListener('keydown', (e) => {
    if (!state.projectorOpen) return;
    if (e.key === 'Escape') {
      if (!$('lightboxModal').classList.contains('hidden')) {
        $('lightboxModal').classList.add('hidden');
      } else {
        closeProjector();
      }
      return;
    }
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft') { e.preventDefault(); stepProjector(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepProjector(1); }
    else if (e.key === '1') applyProjectorDecision('keep');
    else if (e.key === '2') applyProjectorDecision('discard');
    else if (e.key === '3') applyProjectorDecision('other');
    else if (e.key === '0') applyProjectorDecision('pending');
  });

  // Modals
  $('btnShowQr').onclick = openQrModal;
  $('btnCloseQrModal').onclick = () => $('qrModal').classList.add('hidden');
  $('qrModal').onclick = (e) => { if (e.target === $('qrModal')) $('qrModal').classList.add('hidden'); };
  $('btnCopyLink').onclick = async () => {
    const link = `${location.origin}${location.pathname}?code=${state.code}`;
    await navigator.clipboard.writeText(link);
    showToast('已複製加入連結！');
  };
  $('lightboxModal').onclick = () => $('lightboxModal').classList.add('hidden');
}

// ── Init ─────────────────────────────────────────────────────────────────────
function init() {
  bindEvents();
  renderRecentSessions();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const mode = params.get('mode') === 'local' ? 'local' : 'firebase';
  if (code) {
    setMode(mode);
    enterSession(code, mode);
  }
}

init();
