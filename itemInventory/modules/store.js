/**
 * 資料同步層：支援「Firebase 雲端多人即時同步」與「本機單機／雙視窗同步」
 *
 * - Firebase 模式：使用 artifacts/itemInventory/public/data/{sessions,images}/<CODE>
 *   圖片獨立存放於 images/<CODE>/<imgId>，避免主監聽器重複下載大圖。
 * - 本機模式：使用 localStorage + IndexedDB + BroadcastChannel，無需網路或 Firebase 規則即可使用，
 *   且同一瀏覽器開兩個分頁（例如一頁拍照、一頁投影）仍可即時同步。
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getDatabase, ref, get, set, update, remove, onValue,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  idbPutImage, idbGetImage, idbDeleteImage,
  loadImageWithCache, setCachedImage, deleteCachedImage,
} from './images.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAi2QYt_Cnl7X9wC3h-IUfOkUli7qMLrIM',
  authDomain: 'pwa-boardgame.firebaseapp.com',
  databaseURL: 'https://pwa-boardgame-default-rtdb.asia-southeast1.firebasedatabase.app/',
  projectId: 'pwa-boardgame',
  storageBucket: 'pwa-boardgame.firebasestorage.app',
  messagingSenderId: '1079279430768',
  appId: '1:1079279430768:web:644823331e777e10b018b5',
};

const DB_ROOT = 'artifacts/itemInventory/public/data';
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOCAL_PREFIX = 'itemInventory:session:';
const RECENT_KEY = 'itemInventory:recentSessions';

let fbApp = null;
let fbDb = null;
let fbAuth = null;
let authPromise = null;

function ensureFirebase() {
  if (!fbApp) {
    fbApp = initializeApp(firebaseConfig);
    fbDb = getDatabase(fbApp);
    fbAuth = getAuth(fbApp);
  }
  if (!authPromise) {
    authPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('連線資料庫逾時，請檢查網路或改用本機模式')), 10000);
      const unsub = onAuthStateChanged(fbAuth, (user) => {
        if (user) {
          clearTimeout(timer);
          unsub();
          resolve(user);
        }
      });
      signInAnonymously(fbAuth).catch((err) => {
        clearTimeout(timer);
        authPromise = null;
        reject(new Error('匿名登入失敗：' + (err?.message || err)));
      });
    });
  }
  return authPromise;
}

const sessionRef = (code, sub = '') => ref(fbDb, `${DB_ROOT}/sessions/${code}${sub ? '/' + sub : ''}`);
const imageRef = (code, imgId = '') => ref(fbDb, `${DB_ROOT}/images/${code}${imgId ? '/' + imgId : ''}`);

export function generateCode(len = 6) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export function generateId(prefix = 'id') {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return `${prefix}_${Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ── 本機 BroadcastChannel ──────────────────────────────────────────────────────
const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('itemInventory-local') : null;

function readLocalSession(code) {
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + code);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalSession(code, data) {
  localStorage.setItem(LOCAL_PREFIX + code, JSON.stringify(data));
  if (bc) bc.postMessage({ code, updatedAt: Date.now() });
}

export function saveRecentSession(entry) {
  try {
    const list = getRecentSessions().filter((x) => !(x.code === entry.code && x.mode === entry.mode));
    list.unshift({ ...entry, lastOpenedAt: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    // ignore quota errors
  }
}

export function getRecentSessions() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function removeRecentSession(code, mode) {
  try {
    const list = getRecentSessions().filter((x) => !(x.code === code && x.mode === mode));
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    if (mode === 'local') {
      localStorage.removeItem(LOCAL_PREFIX + code);
    }
  } catch {
    // ignore
  }
}

// ── 公開 API ──────────────────────────────────────────────────────────────────

/**
 * 建立盤點場次
 * @param {{ title: string, groups: string[], mode: 'firebase' | 'local', customCode?: string }} opts
 */
export async function createSession({ title, groups = [], mode = 'firebase', customCode = '' }) {
  const cleanGroups = [...new Set(groups.map((g) => g.trim()).filter(Boolean))];
  const baseSession = {
    meta: {
      title: (title || '物品盤點場次').trim(),
      createdAt: Date.now(),
      groups: cleanGroups.length ? cleanGroups : ['第一組', '第二組', '第三組'],
    },
    items: {},
    projector: {
      activeItemId: '',
      updatedAt: Date.now(),
    },
  };

  if (mode === 'local') {
    const code = normalizeCode(customCode) || generateCode(6);
    writeLocalSession(code, baseSession);
    saveRecentSession({ code, title: baseSession.meta.title, mode: 'local' });
    return { code, mode: 'local', session: baseSession };
  }

  await ensureFirebase();
  let code = normalizeCode(customCode) || generateCode(6);
  for (let i = 0; i < 4; i++) {
    const snap = await get(sessionRef(code, 'meta'));
    if (!snap.exists()) break;
    if (customCode) throw new Error(`場次代碼 ${code} 已存在`);
    code = generateCode(6);
  }
  await set(sessionRef(code), baseSession);
  saveRecentSession({ code, title: baseSession.meta.title, mode: 'firebase' });
  return { code, mode: 'firebase', session: baseSession };
}

/**
 * 檢查並加入現有場次
 */
export async function joinSession(rawCode, mode = 'firebase') {
  const code = normalizeCode(rawCode);
  if (!/^[A-Z0-9]{4,6}$/.test(code)) {
    throw new Error('請輸入 4～6 碼英數字場次代碼');
  }

  if (mode === 'local') {
    const session = readLocalSession(code);
    if (!session) throw new Error(`找不到本機盤點場次「${code}」`);
    saveRecentSession({ code, title: session.meta?.title || code, mode: 'local' });
    return { code, mode: 'local', session };
  }

  await ensureFirebase();
  const snap = await get(sessionRef(code));
  if (!snap.exists()) {
    throw new Error(`找不到場次「${code}」，請確認代碼是否正確`);
  }
  const session = snap.val();
  saveRecentSession({ code, title: session.meta?.title || code, mode: 'firebase' });
  return { code, mode: 'firebase', session };
}

/**
 * 訂閱場次即時更新
 */
export function subscribeSession(code, mode, onData, onError) {
  if (mode === 'local') {
    const emit = () => {
      const data = readLocalSession(code);
      if (data) onData(data);
    };
    emit();
    const onBc = (e) => { if (e.data?.code === code) emit(); };
    const onStorage = (e) => { if (e.key === LOCAL_PREFIX + code) emit(); };
    if (bc) bc.addEventListener('message', onBc);
    window.addEventListener('storage', onStorage);
    return () => {
      if (bc) bc.removeEventListener('message', onBc);
      window.removeEventListener('storage', onStorage);
    };
  }

  let unsub = () => {};
  let cancelled = false;
  ensureFirebase()
    .then(() => {
      if (cancelled) return;
      unsub = onValue(
        sessionRef(code),
        (snap) => {
          if (snap.exists()) onData(snap.val());
        },
        (err) => {
          if (onError) onError(err);
        }
      );
    })
    .catch((err) => {
      if (onError) onError(err);
    });

  return () => {
    cancelled = true;
    unsub();
  };
}

/**
 * 新增組別到場次的預設組別清單
 */
export async function ensureGroupInSession(code, mode, groupName, currentGroups = []) {
  const clean = String(groupName || '').trim();
  if (!clean || currentGroups.includes(clean)) return;
  const next = [...currentGroups, clean];
  if (mode === 'local') {
    const s = readLocalSession(code);
    if (!s) return;
    s.meta = s.meta || {};
    s.meta.groups = next;
    writeLocalSession(code, s);
    return;
  }
  await ensureFirebase();
  await set(sessionRef(code, 'meta/groups'), next);
}

/**
 * 新增或更新物品（含圖片儲存）
 */
export async function saveItem(code, mode, itemData, newImageDataUrl = '') {
  const now = Date.now();
  const isEdit = Boolean(itemData.id);
  const id = itemData.id || generateId('it');
  let imgId = itemData.imgId || '';

  if (newImageDataUrl) {
    const oldImgId = imgId;
    imgId = generateId('img');
    const cacheKey = `${mode}:${code}:${imgId}`;
    setCachedImage(cacheKey, newImageDataUrl);

    if (mode === 'local') {
      await idbPutImage(`${code}:${imgId}`, newImageDataUrl);
      if (oldImgId) await idbDeleteImage(`${code}:${oldImgId}`).catch(() => {});
    } else {
      await ensureFirebase();
      await set(imageRef(code, imgId), { data: newImageDataUrl, createdAt: now });
      if (oldImgId) await remove(imageRef(code, oldImgId)).catch(() => {});
    }
    if (oldImgId) deleteCachedImage(`${mode}:${code}:${oldImgId}`);
  }

  const record = {
    id,
    name: String(itemData.name || '').trim(),
    qty: Math.max(1, Number(itemData.qty) || 1),
    unit: String(itemData.unit || '件').trim() || '件',
    group: String(itemData.group || '未分組').trim() || '未分組',
    location: String(itemData.location || '').trim(),
    note: String(itemData.note || '').trim(),
    suggestion: itemData.suggestion || 'none',
    imgId,
    createdBy: String(itemData.createdBy || '').trim(),
    createdAt: isEdit && itemData.createdAt ? itemData.createdAt : now,
    updatedAt: now,
    decision: itemData.decision || 'pending',
    decisionNote: itemData.decisionNote || '',
    decisionBy: itemData.decisionBy || '',
    decidedAt: itemData.decidedAt || 0,
  };

  if (mode === 'local') {
    const s = readLocalSession(code);
    if (!s) throw new Error('找不到場次資料');
    s.items = s.items || {};
    s.items[id] = record;
    writeLocalSession(code, s);
    return record;
  }

  await ensureFirebase();
  await set(sessionRef(code, `items/${id}`), record);
  return record;
}

/**
 * 刪除物品（連同圖片）
 */
export async function deleteItem(code, mode, itemId, imgId = '') {
  if (mode === 'local') {
    const s = readLocalSession(code);
    if (s && s.items) {
      delete s.items[itemId];
      writeLocalSession(code, s);
    }
    if (imgId) {
      deleteCachedImage(`local:${code}:${imgId}`);
      await idbDeleteImage(`${code}:${imgId}`).catch(() => {});
    }
    return;
  }

  await ensureFirebase();
  await remove(sessionRef(code, `items/${itemId}`));
  if (imgId) {
    deleteCachedImage(`firebase:${code}:${imgId}`);
    await remove(imageRef(code, imgId)).catch(() => {});
  }
}

/**
 * 更新投影討論決議
 */
export async function setDecision(code, mode, itemId, { decision, decisionNote = '', decisionBy = '' }) {
  const now = Date.now();
  const patch = {
    decision,
    decisionNote: String(decisionNote || '').trim(),
    decisionBy: String(decisionBy || '').trim(),
    decidedAt: decision === 'pending' ? 0 : now,
    updatedAt: now,
  };

  if (mode === 'local') {
    const s = readLocalSession(code);
    if (!s || !s.items?.[itemId]) return;
    Object.assign(s.items[itemId], patch);
    writeLocalSession(code, s);
    return;
  }

  await ensureFirebase();
  await update(sessionRef(code, `items/${itemId}`), patch);
}

/**
 * 同步投影目前聚焦的物品 ID
 */
export async function setProjectorCursor(code, mode, activeItemId) {
  const payload = { activeItemId: activeItemId || '', updatedAt: Date.now() };
  if (mode === 'local') {
    const s = readLocalSession(code);
    if (!s) return;
    s.projector = payload;
    writeLocalSession(code, s);
    return;
  }
  await ensureFirebase();
  await set(sessionRef(code, 'projector'), payload);
}

/**
 * 讀取單張物品照片（含記憶體快取）
 */
export async function loadItemImage(code, mode, imgId) {
  if (!imgId) return '';
  const cacheKey = `${mode}:${code}:${imgId}`;
  return loadImageWithCache(cacheKey, async () => {
    if (mode === 'local') {
      return await idbGetImage(`${code}:${imgId}`);
    }
    await ensureFirebase();
    const snap = await get(imageRef(code, imgId));
    return snap.exists() ? (snap.val()?.data || '') : '';
  });
}

/**
 * 將現有資料匯入為新場次（含圖片）
 */
export async function importSessionFromBackup(backupData, mode = 'local') {
  const title = backupData?.meta?.title ? `${backupData.meta.title} (匯入)` : '匯入的盤點場次';
  const groups = Array.isArray(backupData?.meta?.groups) ? backupData.meta.groups : ['第一組'];
  const { code } = await createSession({ title, groups, mode });
  const rawItems = backupData?.items ? Object.values(backupData.items) : [];

  for (const it of rawItems) {
    const imgDataUrl = it._imageDataUrl || '';
    const cleanItem = { ...it };
    delete cleanItem._imageDataUrl;
    delete cleanItem.id;
    delete cleanItem.imgId;
    await saveItem(code, mode, cleanItem, imgDataUrl);
  }
  return { code, mode };
}
