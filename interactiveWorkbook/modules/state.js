// ──────────────────────────────────────────────────────────────────────────────
// 5. 畫面狀態
// ──────────────────────────────────────────────────────────────────────────────
/**
 * 共用可變狀態集中在單一物件 S。ES modules 的 import 是唯讀繫結，
 * 其他模組一律讀寫 S.xxx，不可以 import { xxx } 再賦值。
 *
 * 目前題目以穩定 ID（S.qid）表示，不再用數字索引：題號會因刪除與封存而位移，標題也可能重複，
 * 只有 qid 能在題目清單變動後仍指向同一題。「練習一／二／三」的題號由 exNumber(qid) 現算。
 */
export const S = {
  session: null,      // {role:'teacher'|'student', code, gid, courseName}
  course: null,        // normalizeCourse() 的結果
  unwatch: null,        // onValue 取消訂閱
  unwatchLive: null,
  qid: null,            // 目前題目的穩定 ID
  draft: {},
  dirty: false,
  revision: 0,
  groupFilter: 'all',
  projection: false,
  busy: false,
  joinOpen: false,
  projMode: 'dots',
  projScale: 1.2,   // 投影字級倍率；1.2 讓簡潔投影的 24px 基準達到 28px 門檻（見 projection.js）
  projField: null,
  projGroups: [],
  live: { activity: {}, editLocks: {} },
  lastStudentSignature: '',
};

export const myGroup = () => (S.course && S.session && S.session.gid ? S.course.groups[S.session.gid] : null);

/** 目前題目物件；qid 為 null 或指到已不存在的題目時回傳 null */
export const currentEx = () => ((S.course && S.qid && S.course.byQid[S.qid]) || null);

/** 題目在 active 陣列中的位置（給「練習一／二／三」用）；找不到回傳 -1 */
export const exNumber = (qid) => (S.course ? S.course.exercises.findIndex((exDef) => exDef.qid === qid) : -1);

export const fieldsOf = (qid) => (((S.course && S.course.byQid[qid]) || {}).fields || []);

/** 第一個已開放（active）題目的 qid，沒有題目時為 null */
export const firstQid = () => ((S.course && S.course.exercises.length) ? S.course.exercises[0].qid : null);
