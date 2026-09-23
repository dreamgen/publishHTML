import {
  authReady, courseRef, liveRef, get, set, update, remove, runTransaction,
} from './firebase.js';
import {
  randomCode, randomId, derivePassword, PBKDF2_ITERATIONS,
} from './util.js';
import { normalizeGroupName, MAX_GROUPS } from './schema.js';
import { rememberCourse } from './storage.js';

// ──────────────────────────────────────────────────────────────────────────────
// 4. 資料層
// ──────────────────────────────────────────────────────────────────────────────
export const SCHEMA_VERSION = 2;

/**
 * 題目正規化：缺什麼補什麼，而且是**決定性**的。
 * 沒有 qid 的舊題目一律依索引補成 `L<i>`，所有裝置（講師與學員）在遷移前都會算出同一組 qid，
 * 不會因為誰先開啟畫面就產生不同的 ID；同時記下 legacyIndex，讓讀取端知道還有一個舊的數字 key 可退回。
 */
export function normalizeExercise(exDef, i) {
  const out = (exDef && typeof exDef === 'object') ? { ...exDef } : {};
  delete out.legacyIndex;
  if (typeof out.qid !== 'string' || !out.qid) {
    out.qid = 'L' + i;
    out.legacyIndex = i;
  }
  out.rev = Number(out.rev) || 0;
  out.status = out.status === 'archived' ? 'archived' : 'active';
  return out;
}

/** 寫回資料庫前去掉只存在於記憶體的欄位（legacyIndex 是讀取端算出來的，不入庫） */
export function stripRuntimeFields(exDef) {
  const out = { ...exDef };
  delete out.legacyIndex;
  return out;
}

let exercisesCache = { json: null, parsed: [] };
export function parseExercises(json) {
  if (!json) return [];
  if (exercisesCache.json === json) return exercisesCache.parsed;
  let parsed = [];
  try { parsed = JSON.parse(json); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [];
  parsed = parsed.map(normalizeExercise);
  exercisesCache = { json, parsed };
  return parsed;
}

/**
 * 讀取端的雙軌 fallback：先找 qid，再退回舊的數字 key。
 * 只有從舊資料補號出來的題目（有 legacyIndex）才有退回來源；新題目沒有，也不該有。
 */
export function pickByQid(source, exDef) {
  if (!source || typeof source !== 'object') return undefined;
  const direct = source[exDef.qid];
  if (direct !== undefined && direct !== null) return direct;
  if (exDef.legacyIndex == null) return undefined;
  const legacy = source[String(exDef.legacyIndex)];
  return legacy === undefined || legacy === null ? undefined : legacy;
}

function parseAnswer(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/**
 * 一份答案（JSON 字串或物件）裡有沒有真的填過東西。空字串、空清單、整列空白的表格都不算。
 * 合併小組要靠它判斷「兩組是不是都在同一題有內容」，所以放在資料層，畫面模組共用同一套判準。
 */
export function answerHasContent(value) {
  const parsed = typeof value === 'string' ? parseAnswer(value) : (value || {});
  return Object.values(parsed).some((v) => {
    if (v == null) return false;
    if (Array.isArray(v)) {
      return v.some((item) => (item && typeof item === 'object'
        ? Object.values(item).some((cell) => String(cell ?? '').trim())
        : String(item ?? '').trim()));
    }
    return !!String(v).trim();
  });
}

/**
 * 封存答案：合併小組時「兩者皆保留」的落選答案（功能二的封存題答案之後也用同一個節點）。
 * 每筆記錄自己帶 qid，不像 answers 以 qid 當 key——同一題可以有很多筆封存。
 */
function normalizeArchives(raw) {
  const out = {};
  Object.entries((raw && typeof raw === 'object') ? raw : {}).forEach(([id, rec]) => {
    if (!rec || typeof rec !== 'object') return;
    out[id] = {
      id,
      label: String(rec.label || ''),
      savedAt: Number(rec.savedAt) || 0,
      qid: String(rec.qid || ''),
      json: typeof rec.json === 'string' ? rec.json : JSON.stringify(rec.json ?? {}),
    };
  });
  return out;
}

/** 某一組在某一題的封存紀錄，依存入時間由舊到新 */
export function archivesFor(group, qid) {
  return Object.values((group && group.archives) || {})
    .filter((rec) => rec.qid === qid)
    .sort((a, b) => a.savedAt - b.savedAt);
}

/**
 * 把 RTDB 原始資料轉成畫面用的結構。
 * 所有以題目為單位的資料（locks / answers / complete / updated / revision）一律改用 qid 當 key，
 * 讀取時 byQid 優先、legacyIndex 退回，因此尚未遷移的舊課程也能正確讀出答案。
 */
export function normalizeCourse(raw) {
  if (!raw) return null;
  const all = parseExercises(raw.exercisesJson);
  const byQid = {};
  all.forEach((exDef) => { byQid[exDef.qid] = exDef; });

  const locks = {};
  all.forEach((exDef) => {
    const value = pickByQid(raw.locks, exDef);
    locks[exDef.qid] = value === undefined ? true : !!value; // 預設未開放
  });

  const groups = {};
  Object.entries(raw.groups || {}).forEach(([gid, g]) => {
    const src = g || {};
    const answers = {};
    const complete = {};
    const updated = {};
    const revision = {};
    all.forEach((exDef) => {
      answers[exDef.qid] = parseAnswer(pickByQid(src.answers, exDef));
      complete[exDef.qid] = !!pickByQid(src.complete, exDef);
      updated[exDef.qid] = Number(pickByQid(src.updated, exDef)) || 0;
      revision[exDef.qid] = Number(pickByQid(src.revision, exDef)) || 0;
    });
    const name = src.name || '';
    groups[gid] = {
      name,
      // 舊小組沒有 nameKey：讀取時即時算出來就好，不必為了補欄位而多一次寫入。
      // 名稱只是標籤，答案掛在 gid 底下，因此 nameKey 只用來判斷「是不是同一組」，不影響任何答案。
      nameKey: src.nameKey || normalizeGroupName(name),
      author: src.author || '',
      createdAt: src.createdAt || 0,
      answers,
      complete,
      updated,
      revision,
      archives: normalizeArchives(src.archives),
    };
  });

  return {
    name: raw.name || '',
    createdAt: raw.createdAt || 0,
    schemaVersion: Number(raw.schemaVersion) || 0,
    // 刻意的不對稱：**新建課程**寫入 false（新的預設是講師預先命名小組，見 createCourse），
    // 但**讀取**舊課程時，沒有這個欄位一律視為 true。
    // 理由：已經開在線上的課程，學員本來就靠「自己輸入組別」加入；若讀取端也預設 false，
    // 這些課程會在改版當下突然變成「講師尚未建立小組，請稍候」而卡住全班。
    // 只有講師在控制台按下開關、或之後新建的課程，才會真的是 false。
    allowStudentGroupNames: raw.allowStudentGroupNames !== false,
    all,                                                // 含封存題，保持原陣列順序（寫回時用）
    exercises: all.filter((exDef) => exDef.status === 'active'),
    archived: all.filter((exDef) => exDef.status === 'archived'),
    byQid,
    locks,
    groups,
  };
}

export const activeExercises = (course) => ((course && course.exercises) || []);
export const exerciseIndex = (course, qid) => activeExercises(course).findIndex((exDef) => exDef.qid === qid);

export async function fetchCourse(code) {
  await authReady;
  const snap = await get(courseRef(code));
  return snap.exists() ? snap.val() : null;
}

// ──────────────────────────────────────────────────────────────────────────────
// 4.1 舊資料遷移（規約 3.3）
// ──────────────────────────────────────────────────────────────────────────────
/**
 * 把一個以數字索引為 key 的物件改寫成以 qid 為 key。
 * 對不上任何題目的舊 key 會**原樣保留**，不在遷移時默默刪掉——遷移不該是第二條讓答案消失的路徑。
 */
function remapByQid(source, all, coerce) {
  const src = (source && typeof source === 'object') ? source : {};
  const out = {};
  const consumed = new Set();
  all.forEach((exDef) => {
    let value = src[exDef.qid];
    let usedKey = exDef.qid;
    if (value === undefined || value === null) {
      if (exDef.legacyIndex == null) return;
      usedKey = String(exDef.legacyIndex);
      value = src[usedKey];
    }
    if (value === undefined || value === null) return;
    consumed.add(usedKey);
    out[exDef.qid] = coerce(value);
  });
  Object.keys(src).forEach((key) => {
    if (consumed.has(key) || out[key] !== undefined) return;
    const value = src[key];
    if (value === undefined || value === null) return;
    out[key] = value;
  });
  return out;
}

/** 由 current（整個課程節點）算出遷移後的樣子；純函式，方便重跑與測試 */
export function migratedCourseNode(current) {
  const all = parseExercises(current.exercisesJson);
  const next = { ...current };
  next.exercisesJson = JSON.stringify(all.map(stripRuntimeFields));
  next.locks = remapByQid(current.locks, all, (v) => !!v);
  const groups = {};
  Object.entries(current.groups || {}).forEach(([gid, g]) => {
    const src = g || {};
    groups[gid] = {
      ...src,
      answers: remapByQid(src.answers, all, (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? {}))),
      complete: remapByQid(src.complete, all, (v) => !!v),
      updated: remapByQid(src.updated, all, (v) => Number(v) || 0),
      revision: remapByQid(src.revision, all, (v) => Number(v) || 0),
    };
  });
  if (Object.keys(groups).length) next.groups = groups;
  next.schemaVersion = SCHEMA_VERSION;
  return next;
}

/**
 * 一次性遷移，由講師端觸發（學員端靠讀取時的 fallback 就能正常作答）。
 * 用 runTransaction 在整個課程節點上一次改寫，兩台講師裝置同時開啟也只會有一份結果。
 * 幂等：已經是 v2 就什麼都不做；因為補號是決定性的（L<i>），重跑也只會算出同一組 qid。
 * 注意 RTDB 第一次呼叫回呼可能給 null（本機尚無快取），這時中止並向伺服器再確認一次。
 */
export async function migrateCourseIfNeeded(code) {
  await authReady;
  const snap = await get(courseRef(code));
  if (!snap.exists()) return false;
  if (Number((snap.val() || {}).schemaVersion) === SCHEMA_VERSION) return false;

  const runOnce = async () => {
    let already = false;
    let missing = false;
    const result = await runTransaction(courseRef(code), (current) => {
      if (current === null) { missing = true; return undefined; } // 中止，稍後再確認
      if (Number(current.schemaVersion) === SCHEMA_VERSION) { already = true; return undefined; }
      return migratedCourseNode(current);
    });
    return { committed: !!(result && result.committed), already, missing };
  };

  let outcome = await runOnce();
  if (outcome.missing) {
    const again = await get(courseRef(code));
    if (!again.exists()) return false;
    if (Number((again.val() || {}).schemaVersion) === SCHEMA_VERSION) return false;
    outcome = await runOnce();
  }
  return outcome.committed && !outcome.already;
}

// ──────────────────────────────────────────────────────────────────────────────
// 4.2 課程與組別
// ──────────────────────────────────────────────────────────────────────────────
export async function createCourse(name, password) {
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
    schemaVersion: SCHEMA_VERSION,
    exercisesJson: '[]',
    // 新課程的預設是「講師預先命名小組」。舊課程沒有這個欄位時讀取端會當成 true，
    // 兩邊刻意不一致的理由寫在 normalizeCourse。
    allowStudentGroupNames: false,
  });
  rememberCourse(code, name);
  return code;
}

export async function verifyTeacher(code, password) {
  const raw = await fetchCourse(code);
  if (!raw) throw Error('找不到這個加入代碼，請確認是否輸入正確。');
  const hash = await derivePassword(password, raw.pwSalt, raw.pwIter || PBKDF2_ITERATIONS);
  if (hash !== raw.pwHash) throw Error('講師密碼不正確。');
  return raw;
}

/**
 * 規約 3.2：live/<CODE> 底下是易變資料（活動標記、編輯鎖），刪除小組時要一併清掉，不能留孤兒。
 * 目前還沒有任何模組寫入 live（那是組內編輯鎖與投影功能的事），但清理邏輯先寫好，
 * 之後那些功能上線時就不必回頭補——漏掉的清理不會報錯，只會安靜地留下垃圾。
 */
export async function clearLiveGroup(code, gid) {
  await authReady;
  await update(liveRef(code), { [`activity/${gid}`]: null, [`editLocks/${gid}`]: null });
}

/** 整個課程的 live 資料（刪除課程、重置課程時用） */
export async function clearLiveCourse(code) {
  await authReady;
  await remove(liveRef(code));
}

/**
 * groups 節點的 transaction 包裝。
 * RTDB 第一次呼叫回呼時可能給 null（本機尚無快取），若直接依這個 null 判斷「小組不存在」就會誤判，
 * 因此中止後再向伺服器確認一次，真的沒有 groups 節點才回報 missing。
 * apply(groups) 回傳 { value } 表示要寫入，回傳 { missing: true } 或其他不含 value 的物件表示中止。
 */
async function groupsTransaction(code, apply) {
  const once = async () => {
    let outcome = { missing: true };
    const result = await runTransaction(courseRef(code, 'groups'), (groups) => {
      if (groups === null) { outcome = { missing: true, fromNull: true }; return undefined; }
      outcome = apply(groups) || {};
      return Object.prototype.hasOwnProperty.call(outcome, 'value') ? outcome.value : undefined;
    });
    return { ...outcome, committed: !!(result && result.committed) };
  };
  let outcome = await once();
  if (outcome.fromNull) {
    const snap = await get(courseRef(code, 'groups'));
    if (snap.exists()) outcome = await once();
  }
  return outcome;
}

/** 入口畫面用：只取組別清單與「是否允許學員自訂組名」，不需要整份題目 */
export async function listGroups(code) {
  const raw = await fetchCourse(code);
  if (!raw) return null;
  const groups = Object.entries(raw.groups || {}).map(([gid, g]) => {
    const src = g || {};
    const name = src.name || '';
    return {
      gid,
      name,
      nameKey: src.nameKey || normalizeGroupName(name),
      author: src.author || '',
      createdAt: Number(src.createdAt) || 0,
    };
  }).sort((a, b) => (a.createdAt - b.createdAt) || a.name.localeCompare(b.name, 'zh-Hant'));
  return {
    courseName: raw.name || '',
    allowStudentGroupNames: raw.allowStudentGroupNames !== false,
    groups,
  };
}

/** 講師開關「允許學員自訂組名」 */
export async function setAllowStudentGroupNames(code, allow) {
  await authReady;
  await set(courseRef(code, 'allowStudentGroupNames'), !!allow);
}

/**
 * 講師預先建立小組。names 可以是一個名稱，也可以是「第 1 組」～「第 N 組」一整批。
 * 正規化後已存在的名稱一律跳過（不重複建立），回傳 { created, skipped, overflow } 讓呼叫端說明結果。
 */
export async function createGroups(code, names) {
  await authReady;
  const wanted = [];
  const seen = new Set();
  (names || []).forEach((n) => {
    const name = String(n ?? '').trim();
    if (!name) return;
    if (name.length > 100) throw Error('組別名稱請控制在 100 字以內。');
    const nameKey = normalizeGroupName(name);
    if (!nameKey || seen.has(nameKey)) return; // 同一批裡自己撞號的，只留第一個
    seen.add(nameKey);
    wanted.push({ name, nameKey });
  });
  if (!wanted.length) throw Error('請先輸入要建立的組別名稱。');

  let created = [];
  let skipped = [];
  let overflow = false;
  await runTransaction(courseRef(code, 'groups'), (groups) => {
    const current = groups || {};
    // transaction 可能因為資料過期而重跑，每次都要從當下的 groups 重新計算，不能沿用上一輪的結果。
    created = []; skipped = []; overflow = false;
    const existing = new Set(Object.values(current).map((g) => ((g && g.nameKey) || normalizeGroupName((g && g.name) || ''))));
    const next = { ...current };
    let count = Object.keys(current).length;
    wanted.forEach((w) => {
      if (existing.has(w.nameKey)) { skipped.push(w.name); return; }
      if (count >= MAX_GROUPS) { overflow = true; return; }
      existing.add(w.nameKey);
      next[randomId(8)] = {
        name: w.name, nameKey: w.nameKey, author: '', createdAt: Date.now(),
      };
      created.push(w.name);
      count += 1;
    });
    if (!created.length) return undefined; // 全部都已存在或已達上限：不必寫入
    return next;
  });
  return { created, skipped, overflow };
}

/**
 * 改名。名稱只是標籤：答案、完成狀態、revision 全部掛在 gid 底下，改名不會動到任何一筆答案。
 * 正規化後與其他組撞號時擋下來——那代表講師想要的其實是「合併小組」。
 */
export async function renameGroup(code, gid, name) {
  await authReady;
  const clean = String(name ?? '').trim();
  if (!clean) throw Error('組別名稱不可以是空白。');
  if (clean.length > 100) throw Error('組別名稱請控制在 100 字以內。');
  const nameKey = normalizeGroupName(clean);
  if (!nameKey) throw Error('組別名稱不可以只有空白或標點。');
  let clash = '';
  const outcome = await groupsTransaction(code, (groups) => {
    clash = '';
    const current = groups[gid];
    if (!current) return { missing: true };
    const hit = Object.entries(groups).find(([k, g]) => k !== gid
      && ((g && g.nameKey) || normalizeGroupName((g && g.name) || '')) === nameKey);
    if (hit) { clash = (hit[1] && hit[1].name) || ''; return { clash: true }; }
    return { value: { ...groups, [gid]: { ...current, name: clean, nameKey } } };
  });
  if (clash) {
    throw Error(`「${clean}」與現有的「${clash}」會被當成同一組（比對時會忽略空白與全形半形差異），因此不能改成這個名稱。請換一個名稱；若本來就想把兩組併在一起，請改用「合併小組」。`);
  }
  if (outcome.missing) throw Error('這一組已經不存在，可能已被其他裝置刪除。');
}

/** 刪除小組：連同該組所有答案與封存紀錄，並清掉 live/<CODE> 底下屬於這一組的資料 */
export async function deleteGroup(code, gid) {
  await authReady;
  const outcome = await groupsTransaction(code, (groups) => {
    if (!groups[gid]) return { missing: true };
    const next = { ...groups };
    delete next[gid];
    return { value: next }; // 刪到一組不剩時 next 是空物件，RTDB 會把整個 groups 節點移除，正是我們要的
  });
  if (outcome.missing) throw Error('這一組已經不存在，可能已被其他裝置刪除。');
  // 小組本身已經刪掉了，live 清不掉只是留下不會被讀到的垃圾。
  // 這裡不往外丟錯，否則畫面會顯示「刪除失敗」，與實際結果不符。
  await clearLiveGroup(code, gid).catch(() => {});
}

export const MERGE_KEEP = 'keep';
export const MERGE_DROP = 'drop';
export const MERGE_BOTH = 'both';

/**
 * 合併小組（破壞性動作，講師專用，作為異常狀況的還原手段）。
 *
 * - 只有一邊有內容的題目：自動採用有內容的那一份，不必問講師。
 * - 兩邊都有內容的題目：依 perQuestionChoice[qid] 決定
 *   'keep'（保留組原本那份）／'drop'（改用被併入組那份）／'both'（兩者皆保留）。
 * - 'both' 的落選那一份寫進保留組的封存紀錄 archives，學員端看得到、可以複製，但不進匯出檔。
 * - 動到答案的題目一律把 revision 進位，讓還停在舊畫面的學員裝置在儲存時撞到樂觀鎖而不是默默覆蓋。
 * - 完成後刪除被併入的那一組（含它的 live 資料）。
 *
 * finalName 是講師確認後要保留的組名（原始字串）；省略時沿用保留組現有的名稱。
 */
export async function mergeGroups(code, keepGid, dropGid, perQuestionChoice, finalName) {
  await authReady;
  if (!keepGid || !dropGid || keepGid === dropGid) throw Error('請選擇兩個不同的小組再合併。');
  const choices = perQuestionChoice || {};
  const outcome = await groupsTransaction(code, (groups) => {
    const keep = groups[keepGid];
    const drop = groups[dropGid];
    if (!keep || !drop) return { missing: true };
    const answers = { ...(keep.answers || {}) };
    const complete = { ...(keep.complete || {}) };
    const updated = { ...(keep.updated || {}) };
    const revision = { ...(keep.revision || {}) };
    const archives = { ...(keep.archives || {}) };
    const dropAnswers = drop.answers || {};
    const now = Date.now();
    const label = `合併自「${drop.name || '未命名小組'}」`;

    Object.keys(dropAnswers).forEach((qid) => {
      const theirs = dropAnswers[qid];
      if (!answerHasContent(theirs)) return; // 對方這一題沒填內容，什麼都不用做
      const mineHas = answerHasContent(answers[qid]);
      // 只有一邊有內容時忽略講師的選擇，直接採用有內容的那一份（畫面上也已經這樣告知）。
      const choice = mineHas ? (choices[qid] || MERGE_KEEP) : MERGE_DROP;
      if (choice === MERGE_KEEP) return;
      if (choice === MERGE_BOTH) {
        archives[randomId(8)] = {
          label, savedAt: now, qid, json: String(theirs),
        };
        return;
      }
      answers[qid] = String(theirs);
      complete[qid] = !!(drop.complete || {})[qid];
      updated[qid] = Number((drop.updated || {})[qid]) || now;
      revision[qid] = (Number(revision[qid]) || 0) + 1;
    });

    const next = { ...groups };
    next[keepGid] = {
      ...keep,
      ...(finalName ? { name: String(finalName), nameKey: normalizeGroupName(finalName) } : {}),
      answers,
      complete,
      updated,
      revision,
      ...(Object.keys(archives).length ? { archives } : {}),
    };
    delete next[dropGid];
    return { value: next };
  });
  if (outcome.missing) throw Error('要合併的兩組之中有一組已經不存在，可能已被其他裝置刪除。請重新整理後再確認一次。');
  await clearLiveGroup(code, dropGid).catch(() => {}); // 同 deleteGroup：合併已經完成，清不掉 live 不算失敗
}

/**
 * 學員加入小組。
 * - `{ gid }`：直接加入指定的小組（講師預先命名、學員從清單選的情況）。
 * - `{ name }`：在 transaction 內**再正規化比對一次**，比對到就沿用那一組、沒有才新建。
 *   兩位學員同時輸入同一組名時，後跑的那一次會拿到伺服器最新資料而沿用先建立的那一組，
 *   不會產生兩個同名小組。顯示名稱一律採用**最先建立**那一組的原始字串，後來加入者不改寫它。
 */
export async function joinGroup(code, target, author) {
  await authReady;
  const raw = await fetchCourse(code);
  if (!raw) throw Error('找不到這個加入代碼，請確認講師提供的代碼。');
  const courseName = raw.name || '';
  const allowNames = raw.allowStudentGroupNames !== false;
  const who = String(author ?? '').trim();
  const pick = (target && typeof target === 'object') ? target : { name: target };
  const wantGid = pick.gid ? String(pick.gid) : '';
  const wantName = String(pick.name ?? '').trim();

  if (wantGid) {
    const outcome = await groupsTransaction(code, (groups) => {
      const current = groups[wantGid];
      if (!current) return { missing: true };
      return { value: { ...groups, [wantGid]: { ...current, author: who } } };
    });
    if (outcome.missing) throw Error('這一組已經不存在，可能剛被講師刪除。請回上一步重新選擇組別。');
    return { gid: wantGid, name: courseName, created: false };
  }

  if (!wantName) throw Error('請填寫組別名稱。');
  if (wantName.length > 100) throw Error('組別名稱請控制在 100 字以內。');
  const nameKey = normalizeGroupName(wantName);
  if (!nameKey) throw Error('組別名稱不可以只有空白或標點。');

  let gid = null;
  let created = false;
  let full = false;
  let blocked = false;
  await runTransaction(courseRef(code, 'groups'), (groups) => {
    const current = groups || {};
    gid = null; created = false; full = false; blocked = false;
    const found = Object.keys(current).find((k) => {
      const g = current[k] || {};
      return ((g.nameKey || normalizeGroupName(g.name || '')) === nameKey);
    });
    if (found) {
      gid = found;
      return { ...current, [found]: { ...current[found], author: who } };
    }
    if (!allowNames) { blocked = true; return undefined; }
    if (Object.keys(current).length >= MAX_GROUPS) { full = true; return undefined; }
    gid = randomId(8);
    created = true;
    return {
      ...current,
      [gid]: {
        name: wantName, nameKey, author: who, createdAt: Date.now(),
      },
    };
  });
  if (blocked) throw Error('這場課程的組別由講師預先建立，找不到你輸入的這一組。請回上一步從清單中選擇，或請講師新增這一組。');
  if (full) throw Error(`這場課程的組別數已達上限 ${MAX_GROUPS} 組，無法再新增。請從現有的組別中選擇，或請講師先整理組別。`);
  if (!gid) throw Error('加入組別失敗，請再試一次。');
  return { gid, name: courseName, created };
}

// ──────────────────────────────────────────────────────────────────────────────
// 4.3 題目與答案
// ──────────────────────────────────────────────────────────────────────────────
export const revisionOf = (groupRaw, qid) => Number(((groupRaw || {}).revision || {})[qid] || 0);

export async function setLock(code, qid, locked) {
  await authReady;
  await set(courseRef(code, `locks/${qid}`), !!locked);
}

/**
 * 刪除單一練習：題目本身、題目開關，以及所有組別在這一題的答案都要一起移除。
 * 改用 qid 之後不再需要搬動索引——其餘題目的 key 不變，所以也不必為了防止「寫到別題」而把 revision 加一：
 * 這一題的 key 直接消失，還停在舊畫面的裝置儲存時會走 saveAnswer 的「題目已不存在」路徑並得到明確訊息。
 * 先確保課程已遷移，否則舊的數字 key 會在改寫 exercisesJson（題目從此帶 qid）之後失去退回來源。
 */
export async function deleteExercise(code, courseData, qid) {
  const target = courseData.byQid[qid];
  if (!target) throw Error('找不到這個練習，可能已被其他裝置刪除。');
  await migrateCourseIfNeeded(code);
  const remaining = courseData.all.filter((exDef) => exDef.qid !== qid);
  const updates = { exercisesJson: JSON.stringify(remaining.map(stripRuntimeFields)) };
  updates[`locks/${qid}`] = null;
  Object.keys(courseData.groups).forEach((gid) => {
    updates[`groups/${gid}/answers/${qid}`] = null;
    updates[`groups/${gid}/complete/${qid}`] = null;
    updates[`groups/${gid}/updated/${qid}`] = null;
    updates[`groups/${gid}/revision/${qid}`] = null;
  });
  await update(courseRef(code), updates);
}

/**
 * 以 transaction 比對 revision 後寫入，避免覆蓋其他裝置較新的答案。
 * 注意：RTDB 第一次呼叫回呼時可能給 null（本機尚無快取），若直接中止會誤判成「組別已刪除」，
 * 因此中止後會再向伺服器確認一次，真的不存在才回報錯誤。
 */
export async function saveAnswerOnce(code, gid, qid, json, expectedRevision, complete, author) {
  let conflict = false;
  let missing = false;
  const result = await runTransaction(courseRef(code, `groups/${gid}`), (current) => {
    if (current === null) { missing = true; return undefined; } // 中止，稍後再確認
    const rev = revisionOf(current, qid);
    if (rev !== expectedRevision) { conflict = true; return undefined; } // 中止：有較新的答案
    return {
      ...current,
      answers: { ...(current.answers || {}), [qid]: json },
      complete: { ...(current.complete || {}), [qid]: !!complete },
      revision: { ...(current.revision || {}), [qid]: rev + 1 },
      updated: { ...(current.updated || {}), [qid]: Date.now() },
      ...(author ? { author } : {}),
    };
  });
  return { result, conflict, missing };
}

export async function saveAnswer(code, gid, qid, answerObject, expectedRevision, complete, author) {
  await authReady;
  // 題目可能在作答期間被講師刪除。先確認這個 qid 還在題目清單裡，避免寫出一筆沒有題目的孤兒答案；
  // 也順便保證不會因為題號位移而把答案存到別題（qid 化之後本來就不會，但錯誤訊息要講得清楚）。
  const exSnap = await get(courseRef(code, 'exercisesJson'));
  const list = parseExercises(exSnap.exists() ? exSnap.val() : '');
  if (!list.some((exDef) => exDef.qid === qid)) {
    throw Error('這一題已被講師刪除，無法儲存。請先複製保留畫面上的文字，再重新載入頁面。');
  }
  const json = JSON.stringify(answerObject);
  let { result, conflict, missing } = await saveAnswerOnce(code, gid, qid, json, expectedRevision, complete, author);
  if (missing) {
    const snap = await get(courseRef(code, `groups/${gid}`));
    if (!snap.exists()) throw Error('此組已被講師刪除或課程已重置，請重新加入。');
    ({ result, conflict, missing } = await saveAnswerOnce(code, gid, qid, json, expectedRevision, complete, author));
    if (missing) throw Error('此組已被講師刪除或課程已重置，請重新加入。');
  }
  if (conflict) throw Error('本題已在其他裝置更新或由講師清除。請先複製保留畫面上的文字，再按「重新載入本題」。');
  if (!result.committed) throw Error('儲存未完成，請再試一次。');
  return revisionOf(result.snapshot.val(), qid);
}
