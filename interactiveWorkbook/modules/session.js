import {
  S, myGroup, exNumber, firstQid,
} from './state.js';
import { saveSession, clearSession } from './storage.js';
import { shell } from './ui.js';
import { onValue, courseRef } from './firebase.js';
import { normalizeCourse } from './data.js';
import { notify } from './util.js';
import { renderEntry } from './entry.js';
import { renderTeacher } from './teacher.js';
import { renderStudent, applyDefaults } from './student.js';
import { watchLive, stopWatchLive } from './live.js';

// urlCode 原屬「6. 入口畫面」一節，因為只被 startSession 之外的入口畫面使用、且與 session 生命週期相關，
// 一併留在這裡由 entry.js 匯入。
export const urlCode = (new URLSearchParams(location.search).get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function leaveSession() {
  if (S.unwatch) { S.unwatch(); S.unwatch = null; }
  stopWatchLive();
  S.session = null; S.course = null; S.draft = {}; S.dirty = false; S.projection = false;
  S.qid = null; S.groupFilter = 'all'; S.lastStudentSignature = '';
  clearSession();
  renderEntry('student');
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. 即時訂閱
// ──────────────────────────────────────────────────────────────────────────────
export function startSession(next) {
  S.session = next;
  saveSession(next);
  S.qid = null; S.draft = {}; S.dirty = false; S.revision = 0; S.groupFilter = 'all'; S.lastStudentSignature = '';
  if (S.unwatch) { S.unwatch(); S.unwatch = null; }
  shell('<div class="card"><p>載入課程中…</p></div>', { subtitle: next.courseName });
  // 活動標記與編輯鎖走另一條訂閱（見 live.js），刻意不讓它們觸發這裡的主監聽。
  watchLive(next.code);
  S.unwatch = onValue(courseRef(next.code), (snap) => {
    applySnapshot(snap.exists() ? snap.val() : null);
  }, (err) => {
    notify('連線中斷：' + err.message);
  });
}

export function applySnapshot(raw) {
  if (!raw) {
    notify('這個課程已被刪除。');
    leaveSession();
    return;
  }
  const previousQids = S.course ? S.course.exercises.map((e2) => e2.qid).join(',') : null;
  S.course = normalizeCourse(raw);
  if (S.session.courseName !== S.course.name) {
    S.session = { ...S.session, courseName: S.course.name };
    saveSession(S.session);
  }
  // 題目清單有變動時（例如講師刪了某一題），以 qid 把畫面留在原本那一題：
  // 標題會重複、題號會位移，只有 qid 靠得住。原本那一題真的不在了才回到第一題。
  if (exNumber(S.qid) < 0) S.qid = firstQid();
  // 第一次收到 snapshot 也算「結構有變」：草稿要從遠端答案帶進來，畫面要畫出來。
  const isFirst = previousQids === null;
  const structural = isFirst || previousQids !== S.course.exercises.map((e2) => e2.qid).join(',');

  if (S.session.role === 'teacher') {
    if (S.groupFilter !== 'all' && !S.course.groups[S.groupFilter]) S.groupFilter = 'all';
    const active = document.activeElement;
    const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
    if (!typing || structural) {
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
  // 以 qid 集合與各題 revision 當簽章：只要這些沒變，畫面就沒有重畫的必要。
  // 組名與封存筆數也放進來：講師改名或合併小組（兩者皆保留）時不會動到 revision，
  // 但身分列與封存提示都要跟著更新，否則學員要切換題目才看得到。
  const signature = JSON.stringify([
    group.name,
    Object.keys(group.archives || {}).length,
    S.course.exercises.map((e2) => [
      e2.qid, e2.title, !!S.course.locks[e2.qid], group.revision[e2.qid] || 0, !!group.complete[e2.qid],
    ]),
  ]);
  if (signature === S.lastStudentSignature && !structural) return;
  S.lastStudentSignature = signature;
  if (structural && !isFirst) {
    notify(S.dirty
      ? '講師調整了題目，題號可能已變動；請確認畫面內容仍屬於這一題，再按儲存。'
      : '講師調整了題目。');
  }

  const remoteRevision = group.revision[S.qid] || 0;
  if (!S.dirty && (remoteRevision !== S.revision || structural)) {
    S.draft = structuredClone(group.answers[S.qid] || {});
    S.revision = remoteRevision;
    applyDefaults();
  }
  if (!S.dirty || structural || S.course.locks[S.qid]) renderStudent();
}
