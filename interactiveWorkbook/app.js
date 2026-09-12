/**
 * 互動題本 — 線上小組練習 PWA
 *
 * 後端：Firebase Realtime Database（與 liveInteraction 共用 pwa-boardgame 專案）
 * 資料路徑：artifacts/interactiveWorkbook/public/data/courses/<六碼加入代碼>
 *
 * 設計重點
 * - 講師建立課程時自訂名稱與密碼，系統產生六碼加入代碼；密碼以 PBKDF2-SHA256 雜湊後才寫入資料庫。
 * - 題目由講師以 JSON 匯入（可先下載範本），存成單一 JSON 字串，避免 RTDB 對巢狀陣列／空物件的處理差異。
 * - 學員以加入代碼進入，選（或新增）組別、填姓名即可作答；同組共用一份答案。
 * - 以 onValue 即時同步，講師端答案、題目開關變動都會立即反映，不需輪詢。
 * - 存檔採 runTransaction 比對 revision，避免兩台裝置互相覆蓋。
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getDatabase, ref, get, set, update, remove, onValue, runTransaction,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';

// ──────────────────────────────────────────────────────────────────────────────
// 1. Firebase 初始化（沿用 liveInteraction 的 pwa-boardgame 專案設定）
// ──────────────────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: 'AIzaSyAi2QYt_Cnl7X9wC3h-IUfOkUli7qMLrIM',
  authDomain: 'pwa-boardgame.firebaseapp.com',
  databaseURL: 'https://pwa-boardgame-default-rtdb.asia-southeast1.firebasedatabase.app/',
  projectId: 'pwa-boardgame',
  storageBucket: 'pwa-boardgame.firebasestorage.app',
  messagingSenderId: '1079279430768',
  appId: '1:1079279430768:web:644823331e777e10b018b5',
};

const DB_ROOT = 'artifacts/interactiveWorkbook/public/data';
const COURSES = `${DB_ROOT}/courses`;

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => { if (user) resolve(user); });
  signInAnonymously(auth).catch((e) => notify('無法連線到資料庫：' + e.message));
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. 基本工具
// ──────────────────────────────────────────────────────────────────────────────
const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CH = '一二三四五六七八九十'.split('');
const exLabel = (i) => `練習${CH[i] || (i + 1)}`;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉容易看錯的 0O1I
const CODE_LENGTH = 6;
const PBKDF2_ITERATIONS = 150000;

let messageTimer;
function notify(text) {
  const el = document.querySelector('#message');
  if (!el) return;
  el.textContent = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { el.textContent = ''; }, 8000);
}

/** RTDB 可能把索引物件或陣列混用；一律轉回保留索引位置的陣列 */
function toArr(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'object') {
    const keys = Object.keys(value).map(Number).filter((k) => !Number.isNaN(k));
    const len = keys.length ? Math.max(...keys) + 1 : 0;
    const out = new Array(len);
    keys.forEach((k) => { out[k] = value[k]; });
    return out;
  }
  return [];
}

function pad(arr, n, fill) {
  const out = toArr(arr).slice(0, n);
  for (let i = 0; i < n; i += 1) if (out[i] === undefined || out[i] === null) out[i] = fill();
  return out;
}

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function randomId(bytes = 8) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const toHex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

/** PBKDF2-SHA256；需要安全連線（https 或 localhost）才有 crypto.subtle */
async function derivePassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  if (!crypto.subtle) throw Error('這個瀏覽器環境不支援密碼加密，請改用 https 網址開啟。');
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}

// 本機記錄：講師自己開過的課程、學員上次加入的身分
const LS = { COURSES: 'iw_myCourses', LAST: 'iw_lastJoin' };
const loadJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 無痕模式忽略 */ } };

function rememberCourse(code, name) {
  const list = loadJSON(LS.COURSES, []).filter((c) => c.code !== code);
  list.unshift({ code, name, savedAt: Date.now() });
  saveJSON(LS.COURSES, list.slice(0, 20));
}
function forgetCourse(code) {
  saveJSON(LS.COURSES, loadJSON(LS.COURSES, []).filter((c) => c.code !== code));
}

// 目前工作階段
const SESSION_KEY = 'iw_session';
const loadSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } };
const saveSession = (s) => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ } };
const clearSession = () => { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } };

// ──────────────────────────────────────────────────────────────────────────────
// 3. 題目 JSON 範本與驗證
// ──────────────────────────────────────────────────────────────────────────────
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'radio', 'checkbox', 'list', 'table'];
const COLUMN_TYPES = ['text', 'number', 'date'];
const MAX_EXERCISES = 30;
const MAX_FIELDS = 40;
const MAX_OPTIONS = 40;
const MAX_ITEMS = 300;
const MAX_ROWS = 300;

const TEMPLATE = {
  courseTitle: '範例課程（下載後可依需求增刪練習與欄位）',
  exercises: [
    {
      title: '練習一．把名詞講定',
      time: '8 分鐘｜小組 5 分鐘 ＋ 回報 3 分鐘',
      goal: '讓同一單位的人對關鍵名詞有一致的認定。',
      notice: '以自己單位的實際情形填寫；遇到爭議時先取得一致，不必追求最正確的定義。',
      fields: [
        { key: 'definition', label: '我們單位的定義', type: 'textarea', required: true },
        { key: 'decision', label: '誰決定的／何時生效', type: 'text', required: true },
        { key: 'dispute', label: '我們這組最容易吵起來的名詞', type: 'text', required: true },
        { key: 'final', label: '最後我們決定', type: 'textarea', required: true },
      ],
    },
    {
      title: '練習二．六個月的出席，你看到什麼',
      time: '25 分鐘｜小組 15 分鐘 ＋ 發表 10 分鐘',
      goal: '練習不把總數當成唯一答案，學會拆開資料看。',
      reference: {
        caption: '某研究班六個月出席紀錄',
        columns: ['月份', '應到', '實到', '出席率'],
        rows: [['1 月', '50', '43', '86%'], ['2 月', '50', '42', '84%'], ['3 月', '51', '39', '76%']],
      },
      fields: [
        { key: 'see', label: '看到的資料與變化', type: 'textarea', required: true },
        { key: 'questions', label: '想知道的問題（至少四個）', type: 'list', itemType: 'textarea', itemLabel: '問題', minItems: 4, required: true },
        { key: 'action', label: '我們的一個行動', type: 'textarea', required: true },
      ],
    },
    {
      title: '練習三．盤點只有一個人會做的事',
      time: '12 分鐘｜小組 8 分鐘 ＋ 回報 4 分鐘',
      goal: '把「人力不夠」換成看得見的能力分布與單點風險。',
      notice: '至少列出 8 項工作。',
      fields: [
        {
          key: 'rows',
          label: '能力盤點',
          type: 'table',
          itemLabel: '工作',
          minRows: 8,
          required: true,
          columns: [
            { key: 'name', label: '工作項目', type: 'text' },
            { key: 'count', label: '會做的人（人）', type: 'number' },
            { key: 'senior', label: '其中 60 歲以上（人）', type: 'number' },
          ],
        },
        { key: 'trainee', label: '三個月內要培養的人', type: 'text', required: true },
        { key: 'coach', label: '由誰帶、怎麼帶', type: 'textarea', required: true },
      ],
    },
    {
      title: '練習四．下個月只追三個數字',
      time: '12 分鐘｜個人／單位 8 分鐘 ＋ 交表 4 分鐘',
      goal: '把課程變成下個月真的會發生的事。',
      notice: '只挑 3 個你們單位下個月真的會去看的指標。',
      fields: [
        {
          key: 'items',
          label: '選擇的三個指標',
          type: 'checkbox',
          required: true,
          options: ['平均出席', '新參與人數', '新人二次參與', '活躍志工', '高負荷志工', '一個月未參與'],
          minSelect: 3,
          maxSelect: 3,
        },
        { key: 'day', label: '每月檢視日期（1–31）', type: 'number', required: true },
        { key: 'report', label: '一個月後回報日期', type: 'date', required: true },
      ],
    },
  ],
};

function cleanStr(v, maxlen, what) {
  if (typeof v !== 'string') throw Error(`${what} 必須是文字。`);
  const s = v.trim();
  if (s.length > maxlen) throw Error(`${what} 過長（上限 ${maxlen} 字）。`);
  return s;
}

function validateField(field, idx) {
  if (!field || typeof field !== 'object') throw Error(`第 ${idx + 1} 個欄位格式不正確。`);
  const key = field.key;
  if (typeof key !== 'string' || !key.trim() || !/^[A-Za-z0-9_]+$/.test(key.trim())) {
    throw Error(`第 ${idx + 1} 個欄位的 key 必須是英數字或底線，且不可空白。`);
  }
  const label = cleanStr(field.label ?? '', 200, `欄位「${key}」的 label`);
  if (!label) throw Error(`欄位「${key}」缺少 label（題目文字）。`);
  if (!FIELD_TYPES.includes(field.type)) throw Error(`欄位「${key}」的 type 不正確，需為：${FIELD_TYPES.join('、')}。`);

  const out = { key: key.trim(), label, type: field.type, required: !!field.required };
  if (field.hint) out.hint = cleanStr(field.hint, 400, `欄位「${key}」的 hint`);

  if (field.type === 'radio' || field.type === 'checkbox') {
    const options = field.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > MAX_OPTIONS
      || options.some((o) => typeof o !== 'string' || !o.trim())) {
      throw Error(`欄位「${key}」需要 1–${MAX_OPTIONS} 個非空白的 options 選項。`);
    }
    out.options = options.map((o) => cleanStr(o, 200, `欄位「${key}」的選項`));
    if (field.type === 'checkbox') {
      ['minSelect', 'maxSelect'].forEach((k) => {
        if (field[k] !== undefined && field[k] !== null) {
          const v = field[k];
          if (!Number.isInteger(v) || v < 0 || v > out.options.length) {
            throw Error(`欄位「${key}」的 ${k} 必須是 0–${out.options.length} 的整數。`);
          }
          out[k] = v;
        }
      });
    }
  }

  if (field.type === 'list') {
    const itemType = field.itemType || 'textarea';
    if (!['text', 'textarea'].includes(itemType)) throw Error(`欄位「${key}」的 itemType 必須是 text 或 textarea。`);
    out.itemType = itemType;
    out.itemLabel = cleanStr(field.itemLabel || '項目', 100, `欄位「${key}」的 itemLabel`) || '項目';
    if (field.minItems !== undefined && field.minItems !== null) {
      if (!Number.isInteger(field.minItems) || field.minItems < 0 || field.minItems > MAX_ITEMS) {
        throw Error(`欄位「${key}」的 minItems 必須是 0–${MAX_ITEMS} 的整數。`);
      }
      out.minItems = field.minItems;
    }
  }

  if (field.type === 'table') {
    const columns = field.columns;
    if (!Array.isArray(columns) || columns.length < 1 || columns.length > 12) throw Error(`欄位「${key}」需要 1–12 個 columns。`);
    const seen = new Set();
    out.columns = columns.map((col, ci) => {
      if (!col || typeof col !== 'object') throw Error(`欄位「${key}」的第 ${ci + 1} 個 column 格式不正確。`);
      const ckey = col.key;
      if (typeof ckey !== 'string' || !/^[A-Za-z0-9_]+$/.test(ckey.trim())) throw Error(`欄位「${key}」的 column key 必須是英數字或底線。`);
      if (seen.has(ckey.trim())) throw Error(`欄位「${key}」的 column key 重複：${ckey}。`);
      seen.add(ckey.trim());
      const clabel = cleanStr(col.label ?? '', 100, `欄位「${key}」的 column label`);
      if (!clabel) throw Error(`欄位「${key}」的 column「${ckey}」缺少 label。`);
      const ctype = col.type || 'text';
      if (!COLUMN_TYPES.includes(ctype)) throw Error(`欄位「${key}」的 column「${ckey}」type 不正確。`);
      return { key: ckey.trim(), label: clabel, type: ctype };
    });
    out.itemLabel = cleanStr(field.itemLabel || '項目', 100, `欄位「${key}」的 itemLabel`) || '項目';
    if (field.minRows !== undefined && field.minRows !== null) {
      if (!Number.isInteger(field.minRows) || field.minRows < 0 || field.minRows > MAX_ROWS) {
        throw Error(`欄位「${key}」的 minRows 必須是 0–${MAX_ROWS} 的整數。`);
      }
      out.minRows = field.minRows;
    }
  }
  return out;
}

function validateReference(refDef) {
  if (refDef == null) return null;
  if (typeof refDef !== 'object') throw Error('reference 參考資料格式不正確。');
  const out = {};
  if (refDef.caption) out.caption = cleanStr(refDef.caption, 200, 'reference.caption');
  const columns = refDef.columns || [];
  const rows = refDef.rows || [];
  if (!Array.isArray(columns) || columns.some((c) => typeof c !== 'string')) throw Error('reference.columns 必須是字串陣列。');
  if (!Array.isArray(rows) || rows.length > 200) throw Error('reference.rows 必須是陣列，且不超過 200 列。');
  rows.forEach((r) => {
    if (!Array.isArray(r) || r.some((c) => !['string', 'number'].includes(typeof c))) {
      throw Error('reference.rows 每一列必須是文字或數字組成的陣列。');
    }
  });
  out.columns = columns.map((c) => cleanStr(c, 100, 'reference 欄位名稱'));
  out.rows = rows.map((r) => r.map((c) => String(c)));
  return out;
}

function validateExercise(exDef, idx) {
  if (!exDef || typeof exDef !== 'object') throw Error(`第 ${idx + 1} 個練習格式不正確。`);
  const title = cleanStr(exDef.title ?? '', 200, `第 ${idx + 1} 個練習的 title`);
  if (!title) throw Error(`第 ${idx + 1} 個練習缺少 title。`);
  const fields = exDef.fields;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_FIELDS) {
    throw Error(`練習「${title}」需要 1–${MAX_FIELDS} 個 fields。`);
  }
  const keys = new Set();
  const outFields = fields.map((f, i) => {
    const vf = validateField(f, i);
    if (keys.has(vf.key)) throw Error(`練習「${title}」的欄位 key 重複：${vf.key}。`);
    keys.add(vf.key);
    return vf;
  });
  const out = { title, fields: outFields };
  ['time', 'goal', 'notice'].forEach((k) => { if (exDef[k]) out[k] = cleanStr(exDef[k], 1000, `練習「${title}」的 ${k}`); });
  const reference = validateReference(exDef.reference);
  if (reference) out.reference = reference;
  return out;
}

function validateExercisesPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.exercises)) {
    throw Error('請上傳正確的題目 JSON（需包含 exercises 陣列，可先下載範本）。');
  }
  const { exercises } = payload;
  if (exercises.length < 1 || exercises.length > MAX_EXERCISES) throw Error(`exercises 需要 1–${MAX_EXERCISES} 個練習。`);
  return exercises.map((exDef, i) => validateExercise(exDef, i));
}

/** 作答驗證：complete 為 true 時才檢查必填／數量條件 */
function validateAnswer(exercises, n, answer, complete) {
  if (!(n >= 0 && n < exercises.length)) throw Error('題號不正確。');
  if (!answer || typeof answer !== 'object') throw Error('答案格式不正確。');
  const exDef = exercises[n];
  const out = {};
  const need = (v, msg) => { if (!String(v ?? '').trim()) throw Error(msg); };

  exDef.fields.forEach((field) => {
    const { key, type, label } = field;
    let v = answer[key];

    if (['text', 'textarea', 'date'].includes(type)) {
      if (v == null) v = '';
      if (typeof v !== 'string' || v.length > 4000) throw Error(`「${label}」格式不正確。`);
      if (complete && field.required) need(v, `請填寫「${label}」。`);
      out[key] = v;
    } else if (type === 'number') {
      if (v == null) v = '';
      if (typeof v !== 'string' || v.length > 40) throw Error(`「${label}」格式不正確。`);
      if (v !== '' && !/^-?\d+$/.test(v)) throw Error(`「${label}」必須是數字。`);
      if (complete && field.required) need(v, `請填寫「${label}」。`);
      out[key] = v;
    } else if (type === 'radio') {
      if (v == null) v = '';
      if (typeof v !== 'string' || (v && !field.options.includes(v))) throw Error(`「${label}」的選項不正確。`);
      if (complete && field.required) need(v, `請選擇「${label}」。`);
      out[key] = v;
    } else if (type === 'checkbox') {
      if (v == null) v = [];
      if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || x < 0 || x >= field.options.length)
        || new Set(v).size !== v.length) throw Error(`「${label}」的選項格式不正確。`);
      if (field.maxSelect != null && v.length > field.maxSelect) throw Error(`「${label}」最多只能選 ${field.maxSelect} 項。`);
      if (complete) {
        if (field.minSelect != null && v.length < field.minSelect) throw Error(`「${label}」至少要選 ${field.minSelect} 項。`);
        else if (field.required && field.minSelect == null && !v.length) throw Error(`請選擇「${label}」。`);
      }
      out[key] = v;
    } else if (type === 'list') {
      if (v == null) v = [];
      if (!Array.isArray(v) || v.length > MAX_ITEMS || v.some((x) => typeof x !== 'string' || x.length > 2000)) {
        throw Error(`「${label}」的內容格式不正確。`);
      }
      if (complete) {
        const filled = v.filter((x) => String(x).trim()).length;
        if (field.minItems != null && filled < field.minItems) throw Error(`「${label}」至少要填 ${field.minItems} 項。`);
        else if (field.required && field.minItems == null && filled === 0) throw Error(`請填寫「${label}」。`);
      }
      out[key] = v;
    } else if (type === 'table') {
      const colKeys = field.columns.map((c) => c.key);
      if (v == null) v = [];
      if (!Array.isArray(v) || v.length > MAX_ROWS) throw Error(`「${label}」的內容格式不正確。`);
      const rows = v.map((row) => {
        if (!row || typeof row !== 'object') throw Error(`「${label}」的內容格式不正確。`);
        const clean = {};
        colKeys.forEach((ck) => {
          const cv = row[ck] ?? '';
          if (typeof cv !== 'string' || cv.length > 500) throw Error(`「${label}」的內容格式不正確。`);
          clean[ck] = cv;
        });
        return clean;
      });
      if (complete) {
        const used = rows.filter((r) => Object.values(r).some((x) => String(x).trim()));
        if (field.minRows != null && used.length < field.minRows) throw Error(`「${label}」至少要填 ${field.minRows} 列。`);
        else if (field.required && field.minRows == null && !used.length) throw Error(`請填寫「${label}」。`);
        used.forEach((r) => {
          colKeys.forEach((ck) => { if (!String(r[ck] ?? '').trim()) throw Error(`「${label}」已填的列請填完整每一欄。`); });
        });
      }
      out[key] = rows;
    }
  });
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. 資料層
// ──────────────────────────────────────────────────────────────────────────────
const courseRef = (code, sub = '') => ref(db, `${COURSES}/${code}${sub ? '/' + sub : ''}`);

let exercisesCache = { json: null, parsed: [] };
function parseExercises(json) {
  if (!json) return [];
  if (exercisesCache.json === json) return exercisesCache.parsed;
  let parsed = [];
  try { parsed = JSON.parse(json); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [];
  exercisesCache = { json, parsed };
  return parsed;
}

/** 把 RTDB 原始資料轉成畫面用的結構 */
function normalizeCourse(raw) {
  if (!raw) return null;
  const exercises = parseExercises(raw.exercisesJson);
  const n = exercises.length;
  const groups = {};
  Object.entries(raw.groups || {}).forEach(([gid, g]) => {
    groups[gid] = {
      name: g.name || '',
      author: g.author || '',
      createdAt: g.createdAt || 0,
      answers: pad(g.answers, n, () => '{}').map((s) => {
        try { return JSON.parse(s); } catch { return {}; }
      }),
      complete: pad(g.complete, n, () => false).map(Boolean),
      updated: pad(g.updated, n, () => 0),
      revision: pad(g.revision, n, () => 0).map((x) => Number(x) || 0),
    };
  });
  return {
    name: raw.name || '',
    createdAt: raw.createdAt || 0,
    exercises,
    locks: pad(raw.locks, n, () => true).map(Boolean),
    groups,
  };
}

async function fetchCourse(code) {
  await authReady;
  const snap = await get(courseRef(code));
  return snap.exists() ? snap.val() : null;
}

async function createCourse(name, password) {
  await authReady;
  let code = randomCode();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await get(courseRef(code));
    if (!snap.exists()) break;
    code = randomCode();
    if (attempt === 5) throw Error('加入代碼產生失敗，請再試一次。');
  }
  const pwSalt = randomId(16);
  const pwHash = await derivePassword(password, pwSalt);
  await set(courseRef(code), {
    name,
    pwSalt,
    pwHash,
    pwIter: PBKDF2_ITERATIONS,
    createdAt: Date.now(),
    exercisesJson: '[]',
  });
  rememberCourse(code, name);
  return code;
}

async function verifyTeacher(code, password) {
  const raw = await fetchCourse(code);
  if (!raw) throw Error('找不到這個加入代碼，請確認是否輸入正確。');
  const hash = await derivePassword(password, raw.pwSalt, raw.pwIter || PBKDF2_ITERATIONS);
  if (hash !== raw.pwHash) throw Error('講師密碼不正確。');
  return raw;
}

/**
 * 找到同名組別就沿用，否則新建。
 * 用 transaction 處理「兩位學員同時新增同一組」的競態；RTDB 在資料過期時會自動以伺服器資料重跑
 * 回呼，因此最後一次執行所決定的 gid 才是真正寫入的那一個。
 */
async function joinGroup(code, groupName, author) {
  const raw = await fetchCourse(code);
  if (!raw) throw Error('找不到這個加入代碼，請確認講師提供的代碼。');
  let gid = null;
  await runTransaction(courseRef(code, 'groups'), (groups) => {
    const current = groups || {};
    const found = Object.keys(current).find((k) => String((current[k] || {}).name || '').trim() === groupName);
    if (found) {
      gid = found;
      return { ...current, [found]: { ...current[found], author } };
    }
    gid = randomId(8);
    return { ...current, [gid]: { name: groupName, author, createdAt: Date.now() } };
  });
  if (!gid) throw Error('加入組別失敗，請再試一次。');
  return { gid, name: raw.name || '' };
}

const revisionOf = (groupRaw, index) => Number(((groupRaw || {}).revision || {})[index] || 0);

/**
 * 以 transaction 比對 revision 後寫入，避免覆蓋其他裝置較新的答案。
 * 注意：RTDB 第一次呼叫回呼時可能給 null（本機尚無快取），若直接中止會誤判成「組別已刪除」，
 * 因此中止後會再向伺服器確認一次，真的不存在才回報錯誤。
 */
async function saveAnswerOnce(code, gid, index, json, expectedRevision, complete, author) {
  let conflict = false;
  let missing = false;
  const result = await runTransaction(courseRef(code, `groups/${gid}`), (current) => {
    if (current === null) { missing = true; return undefined; } // 中止，稍後再確認
    const rev = revisionOf(current, index);
    if (rev !== expectedRevision) { conflict = true; return undefined; } // 中止：有較新的答案
    return {
      ...current,
      answers: { ...(current.answers || {}), [index]: json },
      complete: { ...(current.complete || {}), [index]: !!complete },
      revision: { ...(current.revision || {}), [index]: rev + 1 },
      updated: { ...(current.updated || {}), [index]: Date.now() },
      ...(author ? { author } : {}),
    };
  });
  return { result, conflict, missing };
}

async function saveAnswer(code, gid, index, answerObject, expectedRevision, complete, author) {
  const json = JSON.stringify(answerObject);
  let { result, conflict, missing } = await saveAnswerOnce(code, gid, index, json, expectedRevision, complete, author);
  if (missing) {
    const snap = await get(courseRef(code, `groups/${gid}`));
    if (!snap.exists()) throw Error('此組已被講師刪除或課程已重置，請重新加入。');
    ({ result, conflict, missing } = await saveAnswerOnce(code, gid, index, json, expectedRevision, complete, author));
    if (missing) throw Error('此組已被講師刪除或課程已重置，請重新加入。');
  }
  if (conflict) throw Error('本題已在其他裝置更新或由講師清除。請先複製保留畫面上的文字，再按「重新載入本題」。');
  if (!result.committed) throw Error('儲存未完成，請再試一次。');
  return revisionOf(result.snapshot.val(), index);
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. 畫面狀態
// ──────────────────────────────────────────────────────────────────────────────
let session = null;      // {role:'teacher'|'student', code, gid, courseName}
let course = null;       // normalizeCourse() 的結果
let unwatch = null;      // onValue 取消訂閱
let ex = 0;
let draft = {};
let dirty = false;
let revision = 0;
let groupFilter = 'all';
let projection = false;
let busy = false;
let joinOpen = false;
let lastStudentSignature = '';

const myGroup = () => (course && session && session.gid ? course.groups[session.gid] : null);
const fieldsOf = (i) => ((course && course.exercises[i] && course.exercises[i].fields) || []);

function shell(body, options = {}) {
  document.body.classList.toggle('projection', projection);
  const subtitle = options.subtitle ?? (course ? course.name : '線上小組練習');
  document.querySelector('#app').innerHTML = `<header><div><b>互動題本</b><small>${E(subtitle)}</small></div>${
    session ? `<button id="logout">離開${session.role === 'teacher' ? '講師模式' : '本組'}</button>` : ''
  }</header><main class="wrap">${body}</main>`;
  const logout = document.querySelector('#logout');
  if (logout) {
    logout.onclick = () => {
      if (busy) return;
      if (dirty && !confirm('尚有未儲存的答案，確定離開？')) return;
      leaveSession();
    };
  }
}

function leaveSession() {
  if (unwatch) { unwatch(); unwatch = null; }
  session = null; course = null; draft = {}; dirty = false; projection = false;
  ex = 0; groupFilter = 'all'; lastStudentSignature = '';
  clearSession();
  renderEntry('student');
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. 入口畫面（學員 / 講師）
// ──────────────────────────────────────────────────────────────────────────────
const urlCode = (new URLSearchParams(location.search).get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function renderEntry(view = 'student', prefill = {}) {
  session = null; course = null;
  if (view === 'student') return renderStudentEntry(prefill);
  return renderTeacherEntry(prefill);
}

function renderStudentEntry(prefill = {}) {
  const last = loadJSON(LS.LAST, {}) || {};
  const code = prefill.code || urlCode || last.code || '';
  shell(`<div class="login">
      <div class="eyebrow">互動題本 · 線上小組練習</div>
      <h1>輸入加入代碼，開始作答</h1>
      <p>請輸入講師提供的六碼加入代碼（或直接掃描講師投影的 QR Code）。</p>
      <form id="join-form" class="card">
        <label for="in-code">加入代碼</label>
        <input id="in-code" class="code-input" required maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="ABC123" value="${E(code)}">
        <p id="course-hint" class="muted">輸入代碼後會顯示課程名稱。</p>
        <label for="in-group">組別</label>
        <input id="in-group" list="dl-groups" required maxlength="100" placeholder="例如：第 1 組（沒有就直接新增）" value="${E(last.group || '')}">
        <datalist id="dl-groups"></datalist>
        <label for="in-name">姓名</label>
        <input id="in-name" required maxlength="100" autocomplete="name" placeholder="填表人姓名" value="${E(last.name || '')}">
        <p class="muted">同一課程的相同組別會共用一份答案，每組請指定一位填表人操作。</p>
        <button class="primary" type="submit">進入小組練習</button>
      </form>
      <button id="switch-login" class="link">我是講師 →</button>
    </div>`, { subtitle: '線上小組練習' });

  const codeInput = document.querySelector('#in-code');
  const hint = document.querySelector('#course-hint');
  const lookup = async () => {
    const value = codeInput.value.trim().toUpperCase();
    codeInput.value = value;
    if (value.length !== CODE_LENGTH) { hint.textContent = '輸入代碼後會顯示課程名稱。'; return; }
    hint.textContent = '查詢中…';
    try {
      const raw = await fetchCourse(value);
      if (!raw) { hint.textContent = '找不到這個代碼，請再確認一次。'; return; }
      hint.textContent = `課程：${raw.name}`;
      const groups = Object.values(raw.groups || {}).map((g) => g.name).filter(Boolean);
      document.querySelector('#dl-groups').innerHTML = groups.map((n) => `<option value="${E(n)}">`).join('');
    } catch (e) { hint.textContent = '查詢失敗：' + e.message; }
  };
  codeInput.addEventListener('change', lookup);
  codeInput.addEventListener('blur', lookup);
  if (code.length === CODE_LENGTH) lookup();

  document.querySelector('#switch-login').onclick = () => renderEntry('teacher');
  document.querySelector('#join-form').onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    try {
      const code2 = codeInput.value.trim().toUpperCase();
      const groupName = document.querySelector('#in-group').value.trim();
      const author = document.querySelector('#in-name').value.trim();
      if (code2.length !== CODE_LENGTH) throw Error('加入代碼是六個英數字。');
      if (!groupName || !author) throw Error('請填寫組別與姓名。');
      const { gid, name } = await joinGroup(code2, groupName, author);
      saveJSON(LS.LAST, { code: code2, group: groupName, name: author });
      startSession({ role: 'student', code: code2, gid, courseName: name });
    } catch (err) { notify(err.message); } finally { busy = false; }
  };
}

function renderTeacherEntry(prefill = {}) {
  const mine = loadJSON(LS.COURSES, []);
  const tab = prefill.tab || 'login';
  shell(`<div class="login">
      <div class="eyebrow">互動題本 · 講師控制台</div>
      <h1>開課與管理</h1>
      <div class="seg">
        <button id="tab-login" class="${tab === 'login' ? 'active' : ''}">登入既有課程</button>
        <button id="tab-create" class="${tab === 'create' ? 'active' : ''}">建立新課程</button>
      </div>
      ${tab === 'login' ? `
      <form id="teacher-form" class="card">
        <label for="in-code">加入代碼</label>
        <input id="in-code" class="code-input" required maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="ABC123" value="${E(prefill.code || '')}">
        <label for="in-password">講師密碼</label>
        <input id="in-password" type="password" autocomplete="current-password" required>
        <button class="primary" type="submit">進入講師控制台</button>
      </form>
      ${mine.length ? `<div class="card"><h2>這台裝置開過的課程</h2><div class="course-list">${
        mine.map((c) => `<div class="course-item"><b>${E(c.name)}</b><span><code>${E(c.code)}</code> <button class="small" data-pick="${E(c.code)}">填入</button> <button class="small danger" data-forget="${E(c.code)}">移除紀錄</button></span></div>`).join('')
      }</div><p class="muted">此清單只存在這台裝置的瀏覽器，移除紀錄不會刪除課程。</p></div>` : ''}
      ` : `
      <form id="create-form" class="card">
        <label for="new-name">課程名稱</label>
        <input id="new-name" required maxlength="100" placeholder="例如：114 年幹部研習">
        <label for="new-password">講師密碼（至少 6 個字元）</label>
        <input id="new-password" type="password" required minlength="6" autocomplete="new-password">
        <label for="new-password2">再輸入一次密碼</label>
        <input id="new-password2" type="password" required minlength="6" autocomplete="new-password">
        <p class="muted">建立後會取得一組六碼加入代碼，學員以這組代碼進入。請抄下代碼並妥善保管密碼；密碼不會以明文儲存，遺失無法還原。</p>
        <button class="primary" type="submit">建立課程</button>
      </form>`}
      <div class="toolbar">
        <button id="switch-login" class="link">← 返回學員入口</button>
        <button id="dl-template" class="link">下載題目範本 JSON</button>
      </div>
    </div>`, { subtitle: '講師控制台' });

  document.querySelector('#tab-login').onclick = () => renderEntry('teacher', { tab: 'login' });
  document.querySelector('#tab-create').onclick = () => renderEntry('teacher', { tab: 'create' });
  document.querySelector('#switch-login').onclick = () => renderEntry('student');
  document.querySelector('#dl-template').onclick = downloadTemplate;

  document.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => { document.querySelector('#in-code').value = b.dataset.pick; document.querySelector('#in-password').focus(); };
  });
  document.querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = () => { forgetCourse(b.dataset.forget); renderEntry('teacher', { tab: 'login' }); };
  });

  const loginForm = document.querySelector('#teacher-form');
  if (loginForm) {
    loginForm.onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      const button = loginForm.querySelector('button[type=submit]');
      button.disabled = true; button.textContent = '驗證中…';
      try {
        const code = document.querySelector('#in-code').value.trim().toUpperCase();
        const password = document.querySelector('#in-password').value;
        if (code.length !== CODE_LENGTH) throw Error('加入代碼是六個英數字。');
        const raw = await verifyTeacher(code, password);
        rememberCourse(code, raw.name || '');
        startSession({ role: 'teacher', code, gid: null, courseName: raw.name || '' });
      } catch (err) {
        notify(err.message);
        button.disabled = false; button.textContent = '進入講師控制台';
      } finally { busy = false; }
    };
  }

  const createForm = document.querySelector('#create-form');
  if (createForm) {
    createForm.onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      const button = createForm.querySelector('button[type=submit]');
      button.disabled = true; button.textContent = '建立中…';
      try {
        const name = document.querySelector('#new-name').value.trim();
        const password = document.querySelector('#new-password').value;
        const password2 = document.querySelector('#new-password2').value;
        if (!name) throw Error('請輸入課程名稱。');
        if (password.length < 6) throw Error('講師密碼至少需要 6 個字元。');
        if (password !== password2) throw Error('兩次輸入的密碼不一致。');
        const code = await createCourse(name, password);
        renderCourseCreated(code, name);
      } catch (err) {
        notify(err.message);
        button.disabled = false; button.textContent = '建立課程';
      } finally { busy = false; }
    };
  }
}

function renderCourseCreated(code, name) {
  shell(`<div class="login">
      <div class="eyebrow">課程已建立</div>
      <h1>${E(name)}</h1>
      <div class="card">
        <p>學員加入代碼（請抄下，或稍後在控制台隨時查看）：</p>
        <div class="code-display">${E(code)}</div>
        <div class="notice warn">密碼以不可還原的方式儲存，若遺失只能重新建立課程。建議把代碼與密碼記在您的備忘錄。</div>
        <button class="primary" id="go-console">進入講師控制台，開始匯入題目</button>
      </div>
    </div>`, { subtitle: name });
  document.querySelector('#go-console').onclick = () => startSession({ role: 'teacher', code, gid: null, courseName: name });
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. 即時訂閱
// ──────────────────────────────────────────────────────────────────────────────
function startSession(next) {
  session = next;
  saveSession(next);
  ex = 0; draft = {}; dirty = false; revision = 0; groupFilter = 'all'; lastStudentSignature = '';
  if (unwatch) { unwatch(); unwatch = null; }
  shell('<div class="card"><p>載入課程中…</p></div>', { subtitle: next.courseName });
  unwatch = onValue(courseRef(next.code), (snap) => {
    applySnapshot(snap.exists() ? snap.val() : null);
  }, (err) => {
    notify('連線中斷：' + err.message);
  });
}

function applySnapshot(raw) {
  if (!raw) {
    notify('這個課程已被刪除。');
    leaveSession();
    return;
  }
  const previousExercises = course ? course.exercises.length : -1;
  course = normalizeCourse(raw);
  if (session.courseName !== course.name) {
    session = { ...session, courseName: course.name };
    saveSession(session);
  }
  if (ex >= course.exercises.length) ex = 0;

  if (session.role === 'teacher') {
    if (groupFilter !== 'all' && !course.groups[groupFilter]) groupFilter = 'all';
    const active = document.activeElement;
    const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
    if (!typing || previousExercises !== course.exercises.length) {
      const box = document.querySelector('#comparison .table-scroll');
      const scrollLeft = box ? box.scrollLeft : 0;
      renderTeacher();
      const nextBox = document.querySelector('#comparison .table-scroll');
      if (nextBox) nextBox.scrollLeft = scrollLeft;
    }
    const conn = document.querySelector('#connection');
    if (conn) conn.textContent = '答案即時同步 · 最後更新 ' + new Date().toLocaleTimeString('zh-TW') + ' · 全部組別可左右捲動比較';
    return;
  }

  // 學員：組別若被刪除就退出
  const group = myGroup();
  if (!group) {
    notify('此組已被講師刪除或課程已重置，請重新加入。');
    leaveSession();
    return;
  }
  const signature = JSON.stringify({
    locks: course.locks,
    exCount: course.exercises.length,
    exTitles: course.exercises.map((e2) => e2.title),
    rev: group.revision,
    complete: group.complete,
  });
  const structural = previousExercises !== course.exercises.length;
  if (signature === lastStudentSignature && !structural) return;
  lastStudentSignature = signature;

  const remoteRevision = group.revision[ex] || 0;
  if (!dirty && (remoteRevision !== revision || structural)) {
    draft = structuredClone(group.answers[ex] || {});
    revision = remoteRevision;
    applyDefaults();
  }
  if (!dirty || structural || course.locks[ex]) renderStudent();
}

// ──────────────────────────────────────────────────────────────────────────────
// 8. 學員作答畫面
// ──────────────────────────────────────────────────────────────────────────────
function applyDefaults() {
  fieldsOf(ex).forEach((f) => {
    if (f.type === 'checkbox' && !Array.isArray(draft[f.key])) draft[f.key] = [];
    if (f.type === 'radio' && draft[f.key] == null) draft[f.key] = '';
    if (f.type === 'list' && !Array.isArray(draft[f.key])) {
      draft[f.key] = Array.from({ length: Math.max(1, f.minItems || 0) }, () => '');
    }
    if (f.type === 'table' && !Array.isArray(draft[f.key])) {
      const n = Math.max(1, Math.min(f.minRows || 1, 12));
      draft[f.key] = Array.from({ length: n }, () => Object.fromEntries(f.columns.map((c) => [c.key, ''])));
    }
    if (['text', 'textarea', 'number', 'date'].includes(f.type) && draft[f.key] == null) draft[f.key] = '';
  });
}

function fieldBox(key, label, type, value, opts = {}) {
  const id = 'f-' + key.replace(/[^\w-]/g, '_');
  const star = opts.required ? ' <span aria-hidden="true">＊</span>' : '';
  const control = type === 'textarea'
    ? `<textarea id="${id}" data-field="${E(key)}">${E(value ?? '')}</textarea>`
    : `<input id="${id}" data-field="${E(key)}" type="${type}" ${type === 'number' ? 'min="0" step="1"' : ''} value="${E(value ?? '')}">`;
  return `<div class="form-field"><label for="${id}">${E(label)}${star}</label>${
    opts.hint ? `<p class="muted">${E(opts.hint)}</p>` : ''}${control}</div>`;
}

function renderReference(refDef) {
  if (!refDef) return '';
  return `<div class="table-scroll"><table class="data-table">${
    refDef.caption ? `<caption>${E(refDef.caption)}</caption>` : ''
  }<thead><tr>${(refDef.columns || []).map((c) => `<th>${E(c)}</th>`).join('')}</tr></thead><tbody>${
    (refDef.rows || []).map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th>${E(c)}</th>` : `<td>${E(c)}</td>`)).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

function renderListField(f) {
  const items = draft[f.key] || [];
  return `<div class="form-field"><label>${E(f.label)}${f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
    f.minItems ? `<p class="muted">至少填 ${f.minItems} 項。</p>` : ''
  }${items.map((v, i) => `<div class="row-card list-item"><div class="toolbar"><h3>${E(f.itemLabel || '項目')} ${i + 1}</h3>${
    items.length > 1 ? `<button type="button" class="danger small" data-list-remove="${E(f.key)}" data-idx="${i}">移除</button>` : ''
  }</div>${
    f.itemType === 'text'
      ? `<input data-list="${E(f.key)}" data-idx="${i}" type="text" value="${E(v)}">`
      : `<textarea data-list="${E(f.key)}" data-idx="${i}">${E(v)}</textarea>`
  }</div>`).join('')}<button type="button" data-list-add="${E(f.key)}">＋ 新增${E(f.itemLabel || '項目')}</button></div>`;
}

function renderTableField(f) {
  const rows = draft[f.key] || [];
  return `<div class="form-field"><label>${E(f.label)}${f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
    f.minRows ? `<p class="muted">至少填 ${f.minRows} 列。</p>` : ''
  }${rows.map((row, i) => `<section class="row-card"><div class="toolbar"><h3>${E(f.itemLabel || '項目')} ${i + 1}</h3>${
    rows.length > 1 ? `<button type="button" class="danger small" data-table-remove="${E(f.key)}" data-idx="${i}">移除</button>` : ''
  }</div><div class="row-grid" style="grid-template-columns:repeat(${f.columns.length},minmax(0,1fr))">${
    f.columns.map((c) => `<div class="form-field"><label>${E(c.label)}</label><input data-table="${E(f.key)}" data-col="${E(c.key)}" data-idx="${i}" type="${
      c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text'
    }" ${c.type === 'number' ? 'min="0" step="1"' : ''} value="${E(row[c.key] || '')}"></div>`).join('')
  }</div></section>`).join('')}<button type="button" data-table-add="${E(f.key)}">＋ 新增${E(f.itemLabel || '項目')}</button></div>`;
}

function renderChoiceField(f) {
  if (f.type === 'radio') {
    return `<div class="form-field"><label>${E(f.label)}${f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
      f.options.map((o, i) => `<label class="choice"><input type="radio" name="radio-${E(f.key)}" data-radio="${E(f.key)}" value="${E(o)}" ${
        draft[f.key] === o ? 'checked' : ''
      }><span>${i + 1}．${E(o)}</span></label>`).join('')
    }</div>`;
  }
  const selected = draft[f.key] || [];
  const limitHit = f.maxSelect != null && selected.length >= f.maxSelect;
  return `<div class="form-field"><label>${E(f.label)}${f.required ? ' <span aria-hidden="true">＊</span>' : ''}</label>${
    f.maxSelect != null ? `<p class="muted">已選 ${selected.length}／${f.maxSelect} 項${
      f.minSelect != null && f.minSelect !== f.maxSelect ? `（至少 ${f.minSelect} 項）` : ''
    }</p>` : ''
  }${f.options.map((o, i) => `<label class="choice"><input type="checkbox" data-checkbox="${E(f.key)}" data-idx="${i}" ${
    selected.includes(i) ? 'checked' : ''
  } ${limitHit && !selected.includes(i) ? 'disabled' : ''}><span>${E(o)}</span></label>`).join('')}</div>`;
}

function renderField(f) {
  if (f.type === 'radio' || f.type === 'checkbox') return renderChoiceField(f);
  if (f.type === 'list') return renderListField(f);
  if (f.type === 'table') return renderTableField(f);
  const inputType = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'text' ? 'text' : 'textarea';
  return fieldBox(f.key, f.label, inputType, draft[f.key], { required: f.required, hint: f.hint });
}

function tabs() {
  if (!course.exercises.length) return '';
  const group = myGroup();
  return `<nav class="tabs" aria-label="切換練習">${course.exercises.map((t, i) => `<button data-ex="${i}" class="${
    ex === i ? 'active' : ''
  }" ${ex === i ? 'aria-current="step"' : ''} ${session.role === 'student' && course.locks[i] ? 'disabled' : ''}>${exLabel(i)}<span>${E(t.title)}</span>${
    course.locks[i] ? ' · 未開放' : ' · 已開放'
  }${session.role === 'student' && group && group.complete[i] ? ' ✓' : ''}</button>`).join('')}</nav>`;
}

function noQuestionsNotice() {
  return `<section class="card waiting"><div class="eyebrow">尚未匯入題目</div><h1>這個課程還沒有題目</h1><p>${
    session.role === 'teacher' ? '請使用上方的「匯入題目 JSON」新增練習內容，或先下載範本編輯。' : '請等候講師匯入題目後再進入。'
  }</p></section>`;
}

function renderStudent() {
  const group = myGroup();
  if (!group) return;
  if (!course.exercises.length) {
    shell(`<div class="eyebrow">${E(group.name)} · 填表人 ${E(group.author)}</div>${noQuestionsNotice()}`);
    return;
  }
  const exDef = course.exercises[ex];
  if (course.locks[ex]) {
    shell(`<div class="eyebrow">${E(group.name)}</div>${tabs()}<section class="card waiting">
      <div class="eyebrow">依課程進度開放</div><h1>${exLabel(ex)}尚未開放</h1>
      <p>請等候講師開放，再進入本題作答。</p><p>其他已開放的練習，可從上方按鈕進入。</p>
      ${dirty ? '<div class="notice warn">本題未儲存的修改暫留在此頁；請勿重新整理或離開，待講師重新開放後儲存。</div>' : ''}
      <p id="save-state" role="status" class="muted">開放狀態會即時更新，不需重新整理。</p></section>`);
    bindTabs();
    return;
  }
  shell(`<div class="eyebrow">${E(group.name)} · 填表人 ${E(group.author)}</div>${tabs()}
    <div class="card">
      <span class="badge">${exLabel(ex)}${exDef.time ? ' · ' + E(exDef.time) : ''}</span>
      <h1>${E(exDef.title)}</h1>
      ${exDef.goal ? `<p>${E(exDef.goal)}</p>` : ''}
      <fieldset id="fields" style="border:0;padding:0;margin:0;min-width:0">
        ${exDef.notice ? `<div class="notice">${E(exDef.notice)}</div>` : ''}
        ${renderReference(exDef.reference)}
        ${exDef.fields.map(renderField).join('')}
      </fieldset>
    </div>
    <div class="savebar">
      <span id="save-state">${dirty ? '尚未儲存' : (group.updated[ex] ? '已儲存 ' + new Date(group.updated[ex]).toLocaleString('zh-TW') : '尚未作答')}${
    group.complete[ex] ? ' · 已完成' : ''
  }</span>
      <button id="reload">重新載入本題</button>
      <button id="save">儲存草稿</button>
      <button class="primary" id="complete">標記完成並儲存</button>
    </div>`);
  bindTabs();
  bindFieldEvents();
  document.querySelector('#save').onclick = () => saveDraft(false);
  document.querySelector('#complete').onclick = () => saveDraft(true);
  document.querySelector('#reload').onclick = () => {
    if (busy) return;
    if (dirty && !confirm('重新載入會捨棄畫面上未儲存的修改，確定繼續？')) return;
    const g = myGroup();
    draft = structuredClone(g.answers[ex] || {});
    revision = g.revision[ex] || 0;
    dirty = false;
    applyDefaults();
    renderStudent();
  };
}

function bindFieldEvents() {
  document.querySelectorAll('[data-field]').forEach((el) => el.addEventListener('input', () => {
    draft[el.dataset.field] = el.value; markDirty();
  }));
  document.querySelectorAll('[data-radio]').forEach((el) => el.addEventListener('change', () => {
    draft[el.dataset.radio] = el.value; markDirty();
  }));
  document.querySelectorAll('[data-checkbox]').forEach((el) => el.addEventListener('change', () => {
    const key = el.dataset.checkbox;
    const i = Number(el.dataset.idx);
    const current = draft[key] || [];
    draft[key] = el.checked ? [...current, i] : current.filter((x) => x !== i);
    markDirty(); renderStudent();
  }));
  document.querySelectorAll('[data-list]').forEach((el) => el.addEventListener('input', () => {
    draft[el.dataset.list][Number(el.dataset.idx)] = el.value; markDirty();
  }));
  document.querySelectorAll('[data-list-add]').forEach((el) => el.addEventListener('click', () => {
    draft[el.dataset.listAdd].push(''); markDirty(); renderStudent();
  }));
  document.querySelectorAll('[data-list-remove]').forEach((el) => el.addEventListener('click', () => {
    draft[el.dataset.listRemove].splice(Number(el.dataset.idx), 1); markDirty(); renderStudent();
  }));
  document.querySelectorAll('[data-table]').forEach((el) => el.addEventListener('input', () => {
    draft[el.dataset.table][Number(el.dataset.idx)][el.dataset.col] = el.value; markDirty();
  }));
  document.querySelectorAll('[data-table-add]').forEach((el) => el.addEventListener('click', () => {
    const key = el.dataset.tableAdd;
    const f = fieldsOf(ex).find((x) => x.key === key);
    draft[key].push(Object.fromEntries(f.columns.map((c) => [c.key, ''])));
    markDirty(); renderStudent();
  }));
  document.querySelectorAll('[data-table-remove]').forEach((el) => el.addEventListener('click', () => {
    draft[el.dataset.tableRemove].splice(Number(el.dataset.idx), 1); markDirty(); renderStudent();
  }));
}

function markDirty() {
  dirty = true;
  const el = document.querySelector('#save-state');
  if (el) el.textContent = '尚未儲存，請按儲存草稿';
}

function bindTabs() {
  document.querySelectorAll('[data-ex]').forEach((b) => {
    b.onclick = () => {
      if (busy) return;
      const target = Number(b.dataset.ex);
      if (session.role === 'student' && course.locks[target]) { notify('本題尚未開放。'); return; }
      if (dirty && !confirm('本題還沒儲存。確定捨棄修改並切換題目？')) return;
      ex = target;
      dirty = false;
      if (session.role === 'teacher') { renderTeacher(); return; }
      const g = myGroup();
      draft = structuredClone(g.answers[ex] || {});
      revision = g.revision[ex] || 0;
      applyDefaults();
      renderStudent();
    };
  });
}

async function saveDraft(complete) {
  if (busy || course.locks[ex]) return;
  busy = true;
  const fields = document.querySelector('#fields');
  const saveBtn = document.querySelector('#save');
  const completeBtn = document.querySelector('#complete');
  if (fields) fields.disabled = true;
  if (saveBtn) saveBtn.disabled = true;
  if (completeBtn) completeBtn.disabled = true;
  try {
    const cleaned = validateAnswer(course.exercises, ex, draft, complete);
    const group = myGroup();
    const newRevision = await saveAnswer(session.code, session.gid, ex, cleaned, revision, complete, group.author);
    revision = newRevision;
    draft = structuredClone(cleaned);
    applyDefaults();
    dirty = false;
    lastStudentSignature = '';
    notify(complete ? '已完成並交給講師。' : '草稿已儲存。');
    renderStudent();
  } catch (e) {
    notify(e.message);
  } finally {
    busy = false;
    if (fields) fields.disabled = false;
    if (saveBtn) saveBtn.disabled = false;
    if (completeBtn) completeBtn.disabled = false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 9. 講師控制台
// ──────────────────────────────────────────────────────────────────────────────
function answerRows(fields, a) {
  return fields.map((f) => {
    let v;
    if (f.type === 'checkbox') v = (a[f.key] || []).map((i) => f.options[i]).filter(Boolean).join('、');
    else if (f.type === 'list') v = (a[f.key] || []).map((x, i) => `${i + 1}．${x || '未填'}`).join('\n');
    else if (f.type === 'table') {
      const used = (a[f.key] || []).filter((r) => Object.values(r).some((x) => String(x || '').trim()));
      v = used.map((r, i) => `${i + 1}．` + f.columns.map((c) => `${c.label}：${r[c.key] || '未填'}`).join('｜')).join('\n');
    } else v = a[f.key] || '';
    return [f.label, v];
  });
}

function compare() {
  const list = Object.entries(course.groups).filter(([k]) => groupFilter === 'all' || k === groupFilter);
  if (!list.length) return '<div class="notice">目前還沒有組別答案。學員加入並儲存後，答案會即時出現在這裡。</div>';
  const fields = fieldsOf(ex);
  const labels = answerRows(fields, {});
  return `<div class="table-scroll"><table class="data-table comparison"><thead><tr><th scope="col">作答欄位</th>${
    list.map(([, g]) => `<th scope="col">${E(g.name)}<div class="muted">${
      g.complete[ex] ? '✓ 已完成' : (g.updated[ex] ? '草稿' : '尚未作答')
    }</div></th>`).join('')
  }</tr></thead><tbody>${
    labels.map(([label], i) => `<tr><th scope="row">${E(label)}</th>${
      list.map(([, g]) => {
        const v = answerRows(fields, g.answers[ex] || {})[i][1];
        return `<td class="answer ${v ? '' : 'empty'}">${v ? E(v) : '— 尚未填寫'}</td>`;
      }).join('')
    }</tr>`).join('')
  }</tbody></table></div>`;
}

function renderTeacher() {
  const hasEx = course.exercises.length > 0;
  const groupCount = Object.keys(course.groups).length;
  shell(`<div class="context"><div class="eyebrow">講師控制台</div><h1>${E(course.name)}</h1></div>
    <section class="manage card">
      <h2>課程資訊與題目管理</h2>
      <div class="course-item"><b>學員加入代碼</b><span><code style="font-size:1.4rem">${E(session.code)}</code></span></div>
      <p class="muted" style="margin-top:10px">學員在首頁輸入這組代碼即可加入；也可以按「學員加入 QR Code」投影出來讓學員掃描。</p>
      <div class="toolbar">
        <button id="join-qr" class="primary">學員加入 QR Code</button>
        <button id="dl-template">下載題目範本 JSON</button>
        <button id="import-questions">匯入題目 JSON</button>
        <input id="import-questions-file" type="file" accept=".json,application/json" hidden>
      </div>
      <p class="muted">匯入題目會取代目前全部練習內容；已存在的組別答案中，欄位不符者將會清空。${
    hasEx ? `目前共 ${course.exercises.length} 個練習：${course.exercises.map((e2) => E(e2.title)).join('、')}` : ''
  }</p>
    </section>
    ${!hasEx ? noQuestionsNotice() : `
    ${tabs()}
    <div class="toolbar projection-tools">
      <label for="exercise-select">展示題目</label>
      <select id="exercise-select">${course.exercises.map((t, i) => `<option value="${i}" ${i === ex ? 'selected' : ''}>${exLabel(i)}｜${E(t.title)}</option>`).join('')}</select>
      <label for="group-select">組別</label>
      <select id="group-select"><option value="all">全部組別（${groupCount} 組）</option>${
    Object.entries(course.groups).map(([k, g]) => `<option value="${E(k)}" ${groupFilter === k ? 'selected' : ''}>${E(g.name)}</option>`).join('')
  }</select>
      <button id="project">${projection ? '退出投影' : '簡潔投影'}</button>
    </div>
    <section class="manage card" style="margin-top:24px">
      <h2>課程進度｜練習開關</h2>
      <p>未開放的練習，學員無法進入或查看。可依進度逐題開放，關閉不會刪除答案。</p>
      <div class="exercise-gates">${course.exercises.map((t, i) => `<div class="gate-row"><div><b>${exLabel(i)}｜${E(t.title)}</b><div class="muted">${
    course.locks[i] ? '未開放' : '已開放，學員可進入'
  }</div></div><button type="button" role="switch" aria-checked="${!course.locks[i]}" data-gate="${i}" class="${
    course.locks[i] ? '' : 'primary'
  }">${course.locks[i] ? '開放' : '關閉'}${exLabel(i)}</button></div>`).join('')}</div>
      <div class="toolbar">
        <button id="export-json">匯出全部答案 JSON</button>
        <button id="export-csv">匯出全部答案 CSV</button>
        <button id="import-json">匯入答案 JSON</button>
        <input id="import-file" type="file" accept=".json,application/json" hidden>
      </div>
      <div class="toolbar" style="margin-top:18px">
        <button class="danger" id="clear">清除${groupFilter === 'all' ? '所有組別' : '所選組別'}本題答案</button>
        <button class="danger" id="delete-group" ${groupFilter === 'all' ? 'disabled' : ''}>刪除所選小組</button>
        <button class="danger" id="reset">重置本場課程</button>
        <button class="danger" id="delete-course">刪除整個課程</button>
      </div>
    </section>
    <h1>${exLabel(ex)}｜${E(course.exercises[ex].title)}</h1>
    <p class="status-line" id="connection">答案即時同步 · 全部組別可左右捲動比較</p>
    <div id="comparison">${compare()}</div>`}`);

  document.querySelector('#dl-template').onclick = downloadTemplate;
  document.querySelector('#import-questions').onclick = () => document.querySelector('#import-questions-file').click();
  document.querySelector('#import-questions-file').onchange = importQuestionsFile;
  document.querySelector('#join-qr').onclick = openJoinQR;
  if (!hasEx) return;

  bindTabs();
  document.querySelectorAll('[data-gate]').forEach((button) => {
    button.onclick = async () => {
      const i = Number(button.dataset.gate);
      button.disabled = true;
      try { await set(courseRef(session.code, `locks/${i}`), !course.locks[i]); } catch (e) { notify(e.message); button.disabled = false; }
    };
  });
  document.querySelector('#exercise-select').onchange = (e) => { ex = Number(e.target.value); renderTeacher(); };
  document.querySelector('#group-select').onchange = (e) => { groupFilter = e.target.value; renderTeacher(); };
  document.querySelector('#project').onclick = () => { projection = !projection; renderTeacher(); };
  document.querySelector('#export-json').onclick = () => exportData('json');
  document.querySelector('#export-csv').onclick = () => exportData('csv');
  document.querySelector('#import-json').onclick = () => document.querySelector('#import-file').click();
  document.querySelector('#import-file').onchange = importAnswersFile;

  document.querySelector('#clear').onclick = async () => {
    if (!confirm(`確定清除${groupFilter === 'all' ? '所有組別' : '所選組別'}的${exLabel(ex)}答案？其他練習會保留。`)) return;
    try {
      const targets = Object.keys(course.groups).filter((k) => groupFilter === 'all' || k === groupFilter);
      const updates = {};
      targets.forEach((gid) => {
        updates[`groups/${gid}/answers/${ex}`] = '{}';
        updates[`groups/${gid}/complete/${ex}`] = false;
        updates[`groups/${gid}/updated/${ex}`] = 0;
        updates[`groups/${gid}/revision/${ex}`] = (course.groups[gid].revision[ex] || 0) + 1;
      });
      await update(courseRef(session.code), updates);
      notify('本題答案已清除。');
    } catch (e) { notify(e.message); }
  };

  document.querySelector('#delete-group').onclick = async () => {
    const g = course.groups[groupFilter];
    if (!g) return;
    if (!confirm(`確定刪除「${g.name}」及該組所有答案？其他小組保留。`)) return;
    try {
      await remove(courseRef(session.code, `groups/${groupFilter}`));
      groupFilter = 'all';
      notify('小組與該組答案已刪除。');
    } catch (e) { notify(e.message); }
  };

  document.querySelector('#reset').onclick = async () => {
    if (prompt('這會移除全部組別及全部練習答案，並關閉所有練習（題目保留）。請輸入「重置課程」確認。') !== '重置課程') return;
    try {
      const updates = { groups: null };
      course.exercises.forEach((_, i) => { updates[`locks/${i}`] = true; });
      await update(courseRef(session.code), updates);
      groupFilter = 'all';
      notify('課程已重置，全部組別與答案已清空。');
    } catch (e) { notify(e.message); }
  };

  document.querySelector('#delete-course').onclick = async () => {
    if (prompt(`這會永久刪除整個課程「${course.name}」，包含題目與所有組別答案，無法復原。請輸入課程名稱確認。`) !== course.name) return;
    try {
      await remove(courseRef(session.code));
      forgetCourse(session.code);
      notify('課程已刪除。');
    } catch (e) { notify(e.message); }
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 10. 匯入 / 匯出
// ──────────────────────────────────────────────────────────────────────────────
function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadTemplate() {
  downloadBlob(JSON.stringify(TEMPLATE, null, 2), '題目範本.json', 'application/json');
  notify('已下載題目範本，可用文字編輯器修改後再匯入。');
}

async function readJSONFile(file, limitBytes, hint) {
  if (file.size > limitBytes) throw Error(`檔案過大，請選擇 ${Math.round(limitBytes / 1000000)} MB 以下的 JSON。`);
  const text = (await file.text()).replace(/^﻿/, '');
  try { return JSON.parse(text); } catch { throw Error(hint); }
}

async function importQuestionsFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const payload = await readJSONFile(file, 2000000, '無法讀取 JSON，請使用範本格式編輯。');
    const exercises = validateExercisesPayload(payload);
    const groupCount = Object.keys(course.groups).length;
    const message = `匯入摘要：共 ${exercises.length} 個練習\n${
      exercises.map((t, i) => `${i + 1}．${t.title}`).join('\n')
    }\n\n目前課程有 ${course.exercises.length} 個練習、${groupCount} 個組別。匯入後將完全取代目前的練習內容；已存在的組別答案中，欄位不符的部分將會清空。確定匯入？`;
    if (!confirm(message)) return;
    const updates = { exercisesJson: JSON.stringify(exercises) };
    for (let i = 0; i < exercises.length; i += 1) {
      updates[`locks/${i}`] = course.locks[i] === undefined ? true : course.locks[i];
    }
    if (course.exercises.length > exercises.length) {
      for (let i = exercises.length; i < course.exercises.length; i += 1) updates[`locks/${i}`] = null;
    }
    await update(courseRef(session.code), updates);
    ex = 0;
    notify(`已匯入 ${exercises.length} 個練習。`);
  } catch (e) {
    notify(e.message);
  } finally {
    event.target.value = '';
  }
}

async function importAnswersFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const payload = await readJSONFile(file, 9500000, '無法讀取 JSON，請使用「匯出全部答案 JSON」產生的備份檔。');
    if (!payload || typeof payload !== 'object' || !payload.groups || typeof payload.groups !== 'object') {
      throw Error('請選擇本題本匯出的 JSON 答案檔。CSV 僅供閱讀，不能還原。');
    }
    const incoming = Object.values(payload.groups);
    if (!incoming.length || incoming.length > 500) throw Error('匯入檔需包含 1–500 個小組。');
    const n = course.exercises.length;
    const prepared = incoming.map((g) => {
      const name = String(g.name || '').trim();
      const author = String(g.author || '').trim();
      if (!name || !author || name.length > 100 || author.length > 100) throw Error('小組的組別與填表人須完整填寫（100 字以內）。');
      const answers = {};
      const complete = {};
      const updated = {};
      const revision = {};
      for (let i = 0; i < n; i += 1) {
        const raw = Array.isArray(g.answers) ? g.answers[i] : (g.answers || {})[i];
        const wantComplete = Array.isArray(g.complete) ? !!g.complete[i] : !!(g.complete || {})[i];
        let clean = {};
        let ok = wantComplete;
        try {
          clean = validateAnswer(course.exercises, i, raw && typeof raw === 'object' ? raw : {}, wantComplete);
        } catch {
          try { clean = validateAnswer(course.exercises, i, raw && typeof raw === 'object' ? raw : {}, false); ok = false; } catch { clean = {}; ok = false; }
        }
        answers[i] = JSON.stringify(clean);
        complete[i] = ok;
        const u = Array.isArray(g.updated) ? g.updated[i] : (g.updated || {})[i];
        updated[i] = typeof u === 'number' ? u : (u ? Date.parse(u) || 0 : 0);
        revision[i] = 0;
      }
      return { name, author, answers, complete, updated, revision, createdAt: Date.now() };
    });
    const names = new Set(prepared.map((g) => g.name));
    if (names.size !== prepared.length) throw Error('匯入檔有重複的組別名稱，請先確認備份。');
    const existingNames = new Set(Object.values(course.groups).map((g) => g.name));
    const replaced = prepared.filter((g) => existingNames.has(g.name)).length;
    const preview = prepared.slice(0, 12).map((g) => g.name).join('\n') + (prepared.length > 12 ? `\n…其餘 ${prepared.length - 12} 組` : '');
    if (!confirm(`匯入摘要：共 ${prepared.length} 組\n新增 ${prepared.length - replaced} 組，同名覆寫 ${replaced} 組。\n\n${preview}\n\n同一組別名稱的答案將由備份取代；其他組別與目前題目開關保留。被取代組別需重新加入。確定匯入？`)) return;

    const updates = {};
    Object.entries(course.groups).forEach(([gid, g]) => { if (names.has(g.name)) updates[`groups/${gid}`] = null; });
    prepared.forEach((g) => { updates[`groups/${randomId(8)}`] = g; });
    await update(courseRef(session.code), updates);
    groupFilter = 'all';
    notify(`已匯入 ${prepared.length} 組答案。`);
  } catch (e) {
    notify(e.message);
  } finally {
    event.target.value = '';
  }
}

function exportData(format) {
  try {
    const titles = course.exercises.map((e2) => e2.title);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      const groups = {};
      Object.entries(course.groups).forEach(([gid, g]) => {
        groups[gid] = {
          name: g.name,
          author: g.author,
          answers: g.answers,
          complete: g.complete,
          updated: g.updated.map((t) => (t ? new Date(t).toISOString() : '')),
        };
      });
      downloadBlob(
        JSON.stringify({ exportedAt: new Date().toISOString(), course: course.name, code: session.code, titles, groups }, null, 2),
        `${course.name || '互動題本'}_各組答案_${stamp}.json`,
        'application/json',
      );
    } else {
      const rows = [['組別', '填表人', '練習', '狀態', '更新時間', '欄位', '答案']];
      Object.values(course.groups).forEach((g) => {
        g.answers.forEach((a, i) => {
          answerRows(fieldsOf(i), a).forEach(([k, v]) => {
            rows.push([
              g.name, g.author, `練習${i + 1} ${titles[i] || ''}`,
              g.complete[i] ? '已完成' : '草稿',
              g.updated[i] ? new Date(g.updated[i]).toLocaleString('zh-TW') : '',
              k, v || '',
            ]);
          });
        });
      });
      const cell = (v) => '"' + String(v).replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
      downloadBlob('﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'), `${course.name || '互動題本'}_各組答案_${stamp}.csv`, 'text/csv');
    }
    notify('已匯出檔案。');
  } catch (e) { notify(e.message); }
}

// ──────────────────────────────────────────────────────────────────────────────
// 11. 學員加入 QR Code
// ──────────────────────────────────────────────────────────────────────────────
function joinURL(code) {
  return location.origin + location.pathname.replace(/index\.html$/, '') + '?c=' + encodeURIComponent(code);
}

function openJoinQR() {
  if (joinOpen) return;
  joinOpen = true;
  const url = joinURL(session.code);
  const dialog = document.createElement('dialog');
  dialog.className = 'join-screen';
  dialog.setAttribute('aria-labelledby', 'join-title');
  dialog.innerHTML = `<div class="join-top"><strong>${E(course.name)}</strong><button id="close-join">返回講師控制台</button></div>
    <div class="join-body">
      <h1 id="join-title">請掃碼，進入小組練習</h1>
      <p>① 用手機相機掃碼，或到下方網址輸入代碼</p>
      <div id="qr-picture"><canvas id="qr-canvas"></canvas></div>
      <div class="code-display">${E(session.code)}</div>
      <p class="join-address">${E(url)}</p>
      <p>② 選擇（或新增）組別、填寫姓名即可開始</p>
    </div>`;
  document.body.appendChild(dialog);
  dialog.showModal();
  const close = () => { joinOpen = false; dialog.close(); dialog.remove(); };
  dialog.querySelector('#close-join').onclick = close;
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  try {
    // eslint-disable-next-line no-new, no-undef
    new QRious({ element: dialog.querySelector('#qr-canvas'), value: url, size: 900, level: 'M', background: 'white', foreground: 'black' });
  } catch {
    dialog.querySelector('#qr-picture').textContent = 'QR Code 產生失敗，請改用上方代碼或網址。';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 12. 啟動
// ──────────────────────────────────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

(async function boot() {
  try {
    await authReady;
  } catch (e) {
    notify('無法連線到資料庫，請檢查網路後重新整理。');
  }
  const saved = loadSession();
  if (saved && saved.code && saved.role) {
    startSession(saved);
    return;
  }
  renderEntry('student');
}());
