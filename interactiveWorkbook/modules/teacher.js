import {
  S, currentEx, exNumber, firstQid,
} from './state.js';
import {
  E, exLabel, notify, randomId,
} from './util.js';
import {
  shell, noQuestionsNotice, expandDialog, truncate,
} from './ui.js';
import {
  courseRef, update, remove,
} from './firebase.js';
import {
  deleteExercise, setLock, migrateCourseIfNeeded, answerHasContent, courseHasAnswers,
  createGroups, renameGroup, deleteGroup, mergeGroups, setAllowStudentGroupNames, changeTeacherPassword,
  clearLiveCourse, clearLiveGroup, orphanAnswerUpdates, MERGE_KEEP, MERGE_DROP, MERGE_BOTH,
} from './data.js';
import {
  TEMPLATE, validateExercisesPayload, validateAnswer, normalizeGroupName, MAX_GROUPS,
} from './schema.js';
import { forgetCourse } from './storage.js';
import { clearActivityForQuestion, clearEnteredForQuestion } from './live.js';
import {
  projectionArea, projectionControls, projectionStage, projectionCounts, projectionLegend, projModeLabel, showQuestionFirst,
  bindProjection, disposeProjection, syncProjection,
} from './projection.js';
import {
  isProjectorWindow, onJoinQR, openProjectorWindow, projectorConnected, publishJoinQR, startProjectorBeacon,
} from './projwin.js';
import {
  beginEditQuestion, beginNewQuestion, confirmLockQuestion, archivedSection, bindArchivedSection,
} from './editor.js';

// ──────────────────────────────────────────────────────────────────────────────
// 9. 講師控制台
// ──────────────────────────────────────────────────────────────────────────────
/**
 * 舊資料遷移只由講師端做，而且每個代碼只做一次：控制台每次重畫都會走到這裡，
 * 沒有這個旗標就會在每次 snapshot 都送一次 transaction。學員端不遷移，靠讀取時的 fallback。
 */
const migrationStarted = new Set();
function ensureMigrated(code) {
  if (!code || migrationStarted.has(code)) return;
  migrationStarted.add(code);
  migrateCourseIfNeeded(code).catch((e) => {
    migrationStarted.delete(code);
    notify('舊課程資料升級未完成：' + e.message + ' 題目與答案都還在，請重新整理後再進入一次。');
  });
}

export function answerRows(fields, a) {
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

/** 判斷一個答案值是否真的有填（空字串、空清單、整列空白的表格都不算） */
export function hasContent(value) {
  if (value == null) return false;
  if (Array.isArray(value)) {
    return value.some((item) => (item && typeof item === 'object'
      ? Object.values(item).some((cell) => String(cell ?? '').trim())
      : String(item ?? '').trim()));
  }
  return !!String(value).trim();
}

/** 某一題目前有幾組填過（用來在刪除前提醒講師） */
export function answeredCount(qid) {
  return Object.values(S.course.groups)
    .filter((g) => Object.values(g.answers[qid] || {}).some(hasContent)).length;
}

// ──────────────────────────────────────────────────────────────────────────────
// 9.1 小組管理
//
// 小組的身分是 gid（穩定 ID），名稱只是標籤：改名、合併都不會動到答案的存放位置。
// 這一區塊在「還沒有題目」的課程也要能用——講師通常在上課前就先把組別開好。
// ──────────────────────────────────────────────────────────────────────────────

/** 依建立時間排序的小組清單（同時間則依名稱），讓講師每次看到的順序一致 */
export function sortedGroups() {
  return Object.entries(S.course.groups)
    .sort((a, b) => (a[1].createdAt - b[1].createdAt) || String(a[1].name).localeCompare(String(b[1].name), 'zh-Hant'));
}

/** 某一組在幾個（未封存的）練習有答案 */
export function groupAnsweredCount(g) {
  return S.course.exercises.filter((exDef) => answerHasContent(g.answers[exDef.qid])).length;
}

/** 一份答案的純文字摘要，給合併確認畫面與封存視窗用 */
export function answerText(exDef, answer) {
  return answerRows(exDef.fields || [], answer || {})
    .filter(([, v]) => String(v || '').trim())
    .map(([k, v]) => `${k}：${v}`)
    .join('\n');
}

/** 題目在畫面上的名稱；封存題不在 active 陣列裡，沒有題號可用 */
export function exDisplayLabel(exDef) {
  const i = exNumber(exDef.qid);
  return i >= 0 ? `${exLabel(i)}｜${exDef.title || ''}` : `（已封存的題目）${exDef.title || ''}`;
}

export function groupManageSection() {
  const entries = sortedGroups();
  const total = S.course.exercises.length;
  const allow = S.course.allowStudentGroupNames;
  const cards = entries.length
    ? `<div class="group-cards">${entries.map(([gid, g]) => {
      const archives = Object.keys(g.archives || {}).length;
      return `<div class="group-row group-card">
          <div class="group-card-head"><b>${E(g.name)}</b><span>已作答 ${groupAnsweredCount(g)}／${total}</span></div>
          <span class="group-card-meta">${g.author ? `加入者：${E(g.author)}` : '尚未有人加入'}${archives ? ` · 封存內容 ${archives} 筆` : ''}</span>
          <div class="group-card-actions">
            <button type="button" class="ghost-btn" data-rename-group="${E(gid)}">改名</button>
            ${entries.length >= 2 ? `<button type="button" class="ghost-btn" data-merge-from="${E(gid)}">合併到…</button>` : ''}
            <span class="flex-spacer"></span>
            <button type="button" class="text-danger-btn" data-delete-group="${E(gid)}">刪除</button>
          </div>
        </div>`;
    }).join('')}</div>`
    : '<div class="notice">目前還沒有任何小組。請在下方先建立組別，學員才能加入；若已允許學員自訂組名，學員也可以自己輸入新的組別。</div>';

  const mergeTools = entries.length >= 2
    ? `<div class="group-merge-tools prep-card" id="merge-tools"><b>合併小組</b>
      <span class="prep-card-note">用在同一組被分成兩筆的時候（例如兩個人各自輸入了不同寫法的組名）。合併會把其中一組的答案併進另一組，再刪除被併入的那一組。這是破壞性動作，無法復原。</span>
      <div class="merge-row">
        <label for="merge-drop">把這一組</label>
        <select id="merge-drop">${entries.map(([gid, g], i) => `<option value="${E(gid)}" ${i === 1 ? 'selected' : ''}>${E(g.name)}</option>`).join('')}</select>
        <label for="merge-keep">併入</label>
        <select id="merge-keep">${entries.map(([gid, g], i) => `<option value="${E(gid)}" ${i === 0 ? 'selected' : ''}>${E(g.name)}</option>`).join('')}</select>
        <button type="button" class="ghost-btn" id="merge-start">檢視合併內容</button>
      </div></div>`
    : '';

  return `<section class="prep-pane group-manage">
      <div class="prep-head"><h2>小組</h2><span class="prep-head-note">${entries.length} 組 · 上限 ${MAX_GROUPS} 組 · 改名不影響答案</span></div>
      <div class="group-rows">${cards}</div>
      <div class="group-add">
        <div class="prep-card group-add-item">
          <label for="new-group-name">新增一個小組</label>
          <div class="inline-row"><input id="new-group-name" maxlength="100" placeholder="例如：第 ${entries.length + 1} 組"><button type="button" class="navy-btn" id="add-group">新增</button></div>
        </div>
        <div class="prep-card group-add-item">
          <label for="new-group-count">一次產生多組</label>
          <div class="inline-row"><span>第 1 組 ～ 第</span><input id="new-group-count" class="count-input" type="number" min="1" max="${MAX_GROUPS}" value="6"><span>組</span><span class="flex-spacer"></span><button type="button" class="ghost-btn" id="add-group-batch">產生</button></div>
        </div>
      </div>
      <label class="prep-card switch-card group-allow"><span class="switch-card-text"><b>允許學員自行輸入組別名稱</b><span>關閉時，學員只能從上面的組別中選擇；還沒有任何組別時，學員會停在等待畫面，你一建立組別就會自動更新。</span></span><input type="checkbox" role="switch" class="switch-input" id="allow-student-names" ${allow ? 'checked' : ''}></label>
      ${mergeTools}
      <p class="prep-foot-note">名稱比對時會忽略空白與全形半形差異，「第 1 組」與「第1組」會被當成同一組，已經存在的不會重複建立。</p>
    </section>`;
}

export function bindGroupManage() {
  document.querySelectorAll('[data-rename-group]').forEach((button) => {
    button.onclick = async () => {
      const gid = button.dataset.renameGroup;
      const g = S.course.groups[gid];
      if (!g) return;
      const next = prompt(`要把「${g.name}」改成什麼名稱？名稱只是標籤，這一組已經存好的答案不會受到影響。`, g.name);
      if (next === null) return;
      if (next.trim() === g.name) return;
      button.disabled = true;
      try {
        await renameGroup(S.session.code, gid, next);
        notify(`已改名為「${next.trim()}」。`);
      } catch (e) { notify(e.message); button.disabled = false; }
    };
  });

  document.querySelectorAll('[data-delete-group]').forEach((button) => {
    button.onclick = async () => {
      const gid = button.dataset.deleteGroup;
      const g = S.course.groups[gid];
      if (!g) return;
      const answered = groupAnsweredCount(g);
      const detail = answered
        ? `這一組在 ${answered} 個練習已經有答案，會連同小組一起永久刪除。`
        : '這一組目前還沒有任何答案。';
      if (!confirm(`確定刪除「${g.name}」？\n\n${detail}\n該組的加入紀錄與封存內容也會一併移除，其他小組不受影響。此操作無法復原。`)) return;
      button.disabled = true;
      try {
        await deleteGroup(S.session.code, gid);
        if (S.groupFilter === gid) S.groupFilter = 'all';
        notify(`已刪除「${g.name}」及該組所有答案。`);
      } catch (e) { notify(e.message); button.disabled = false; }
    };
  });

  const addButton = document.querySelector('#add-group');
  if (addButton) {
    addButton.onclick = async () => {
      const input = document.querySelector('#new-group-name');
      const name = input.value.trim();
      if (!name) { notify('請先輸入要新增的組別名稱。'); input.focus(); return; }
      addButton.disabled = true;
      try {
        const result = await createGroups(S.session.code, [name]);
        if (result.created.length) { notify(`已新增「${result.created[0]}」。`); input.value = ''; } else if (result.overflow) {
          notify(`組別數已達上限 ${MAX_GROUPS} 組，這一組沒有建立。請先刪除或合併用不到的組別。`);
        } else {
          notify(`「${name}」與現有的組別會被當成同一組（比對時忽略空白與全形半形差異），因此沒有重複建立。`);
        }
      } catch (e) { notify(e.message); } finally { addButton.disabled = false; }
    };
  }

  const batchButton = document.querySelector('#add-group-batch');
  if (batchButton) {
    batchButton.onclick = async () => {
      const input = document.querySelector('#new-group-count');
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < 1) { notify('請輸入 1 以上的整數，代表要產生幾組。'); input.focus(); return; }
      if (n > MAX_GROUPS) { notify(`一次最多只能產生 ${MAX_GROUPS} 組，請輸入 ${MAX_GROUPS} 以下的數字。`); input.focus(); return; }
      if (!confirm(`要建立「第 1 組」到「第 ${n} 組」嗎？已經存在的同名組別會自動跳過，不會重複建立，也不會影響任何已存的答案。`)) return;
      batchButton.disabled = true;
      try {
        const names = Array.from({ length: n }, (_, i) => `第 ${i + 1} 組`);
        const result = await createGroups(S.session.code, names);
        const parts = [`已建立 ${result.created.length} 組`];
        if (result.skipped.length) parts.push(`跳過 ${result.skipped.length} 組（同名的組別已經存在）`);
        if (result.overflow) parts.push(`其餘沒有建立，因為組別數已達上限 ${MAX_GROUPS} 組`);
        notify(`${parts.join('，')}。`);
      } catch (e) { notify(e.message); } finally { batchButton.disabled = false; }
    };
  }

  const allowBox = document.querySelector('#allow-student-names');
  if (allowBox) {
    allowBox.onchange = async () => {
      const next = allowBox.checked;
      allowBox.disabled = true;
      try {
        await setAllowStudentGroupNames(S.session.code, next);
        notify(next
          ? '已允許學員自行輸入組別名稱。學員輸入的名稱若與現有組別相同（忽略空白與全形半形差異），會自動併入那一組，不會產生重複的組。'
          : '已改為學員只能從你建立的組別中選擇。若目前還沒有任何組別，學員會停在等待畫面，直到你建立組別為止。');
      } catch (e) {
        notify(e.message);
        allowBox.checked = !next;
      } finally { allowBox.disabled = false; }
    };
  }

  // 卡片上的「合併到…」只是幫忙預選下方合併工具的「把這一組」，真正的確認仍走 openMergeDialog。
  document.querySelectorAll('[data-merge-from]').forEach((button) => {
    button.onclick = () => {
      const drop = document.querySelector('#merge-drop');
      const keep = document.querySelector('#merge-keep');
      if (!drop || !keep) return;
      drop.value = button.dataset.mergeFrom;
      if (keep.value === drop.value) {
        const other = [...keep.options].find((o) => o.value !== drop.value);
        if (other) keep.value = other.value;
      }
      const tools = document.querySelector('#merge-tools');
      if (tools) tools.scrollIntoView({ behavior: 'smooth', block: 'center' });
      keep.focus();
    };
  });

  const mergeStart = document.querySelector('#merge-start');
  if (mergeStart) {
    mergeStart.onclick = () => {
      const keepGid = document.querySelector('#merge-keep').value;
      const dropGid = document.querySelector('#merge-drop').value;
      if (keepGid === dropGid) { notify('「保留」與「併入並刪除」不能選同一組，請重新選擇。'); return; }
      openMergeDialog(keepGid, dropGid);
    };
  }
}

/**
 * 合併前的逐題盤點。
 * 走 S.course.all（含封存題）而不是只走 active：答案還在的題目都要算進來，
 * 否則被併入的組一旦刪除，那些答案就會安靜地消失——這正是規約不變條件 1 要擋的事。
 */
export function mergePlan(keepGid, dropGid) {
  const keep = S.course.groups[keepGid];
  const drop = S.course.groups[dropGid];
  const conflicts = [];
  const autos = [];
  S.course.all.forEach((exDef) => {
    const mine = keep.answers[exDef.qid];
    const theirs = drop.answers[exDef.qid];
    const mineHas = answerHasContent(mine);
    const theirsHas = answerHasContent(theirs);
    if (!mineHas && !theirsHas) return;
    if (mineHas && theirsHas) {
      conflicts.push({
        qid: exDef.qid,
        label: exDisplayLabel(exDef),
        keepText: answerText(exDef, mine),
        dropText: answerText(exDef, theirs),
      });
    } else {
      autos.push({ label: exDisplayLabel(exDef), from: mineHas ? 'keep' : 'drop' });
    }
  });
  return { conflicts, autos };
}

let mergeOpen = false;
export function openMergeDialog(keepGid, dropGid) {
  if (mergeOpen) return;
  const keep = S.course.groups[keepGid];
  const drop = S.course.groups[dropGid];
  if (!keep || !drop) { notify('選到的小組已經不存在，請重新整理後再試一次。'); return; }
  const { conflicts, autos } = mergePlan(keepGid, dropGid);
  const preview = (text) => E(truncate(text, 160).shown || '（空白）');

  mergeOpen = true;
  const dialog = document.createElement('dialog');
  dialog.className = 'float-window merge-window';
  dialog.innerHTML = `<div class="float-top"><strong>合併小組</strong><button type="button" data-close>取消</button></div>
    <div class="float-body">
      <div class="notice warn">合併完成後，「${E(drop.name)}」會被刪除，包含它的加入紀錄與所有沒有被採用的答案。此操作無法復原。</div>
      <fieldset class="merge-name"><legend>合併後要用哪一個組名？</legend>
        <label class="choice"><input type="radio" name="merge-name" value="keep" checked><span>${E(keep.name)}（保留組目前的名稱）</span></label>
        <label class="choice"><input type="radio" name="merge-name" value="drop"><span>${E(drop.name)}（改用被併入那一組的名稱）</span></label>
      </fieldset>
      ${conflicts.length ? `<h3>兩組都有答案的練習（${conflicts.length} 題，請逐題選擇）</h3>${conflicts.map((c) => `<fieldset class="merge-conflict"><legend>${E(c.label)}</legend>
        <label class="choice"><input type="radio" name="mc-${E(c.qid)}" value="${MERGE_KEEP}" checked><span><b>保留「${E(keep.name)}」的答案</b><br><small class="muted">${preview(c.keepText)}</small></span></label>
        <label class="choice"><input type="radio" name="mc-${E(c.qid)}" value="${MERGE_DROP}"><span><b>改用「${E(drop.name)}」的答案</b><br><small class="muted">${preview(c.dropText)}</small></span></label>
        <label class="choice"><input type="radio" name="mc-${E(c.qid)}" value="${MERGE_BOTH}"><span><b>兩者皆保留</b><br><small class="muted">以「${E(keep.name)}」的答案繼續作答，「${E(drop.name)}」的那一份存成封存紀錄：該組學員在這一題看得到、可以複製，但不會出現在匯出檔裡。</small></span></label>
        <div class="toolbar"><button type="button" class="small" data-full="keep" data-qid="${E(c.qid)}">看「${E(keep.name)}」完整內容</button><button type="button" class="small" data-full="drop" data-qid="${E(c.qid)}">看「${E(drop.name)}」完整內容</button></div>
      </fieldset>`).join('')}` : '<div class="notice">沒有兩組都填過的練習，不需要逐題選擇。</div>'}
      ${autos.length ? `<div class="merge-auto"><h3>自動處理的練習（只有一邊有答案，不需要選）</h3><ul>${autos.map((a) => `<li>${E(a.label)}：採用「${E(a.from === 'keep' ? keep.name : drop.name)}」的答案</li>`).join('')}</ul></div>` : ''}
      ${!conflicts.length && !autos.length ? '<div class="notice">這兩組目前都還沒有任何答案，合併後只會留下一組。</div>' : ''}
    </div>
    <div class="float-actions"><button type="button" data-close>取消</button><button type="button" class="primary" id="merge-confirm">確認合併</button></div>`;
  document.body.appendChild(dialog);
  dialog.showModal();
  const close = () => { mergeOpen = false; dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.querySelectorAll('[data-full]').forEach((b) => {
    b.onclick = () => {
      const c = conflicts.find((x) => x.qid === b.dataset.qid);
      if (!c) return;
      const isKeep = b.dataset.full === 'keep';
      expandDialog(`${isKeep ? keep.name : drop.name}｜${c.label}`, (isKeep ? c.keepText : c.dropText) || '（空白）');
    };
  });

  dialog.querySelector('#merge-confirm').onclick = async () => {
    const choices = {};
    conflicts.forEach((c) => {
      const picked = dialog.querySelector(`input[name="mc-${c.qid}"]:checked`);
      choices[c.qid] = picked ? picked.value : MERGE_KEEP;
    });
    const namePick = dialog.querySelector('input[name="merge-name"]:checked');
    const finalName = (namePick && namePick.value === 'drop') ? drop.name : keep.name;
    const archived = Object.values(choices).filter((v) => v === MERGE_BOTH).length;
    const takenOver = Object.values(choices).filter((v) => v === MERGE_DROP).length;
    const discarded = conflicts.length - archived - takenOver;
    const summary = [
      `合併後的組名：「${finalName}」。`,
      `「${drop.name}」會被永久刪除。`,
      autos.filter((a) => a.from === 'drop').length ? `${autos.filter((a) => a.from === 'drop').length} 題自動採用「${drop.name}」的答案。` : '',
      takenOver ? `${takenOver} 題改用「${drop.name}」的答案，「${keep.name}」原本那一份會被覆蓋掉。` : '',
      archived ? `${archived} 題兩者皆保留，落選那一份存成封存紀錄。` : '',
      discarded ? `${discarded} 題保留「${keep.name}」的答案，「${drop.name}」那一份會隨著小組一起刪除。` : '',
    ].filter(Boolean).join('\n');
    if (!confirm(`確定要合併嗎？\n\n${summary}\n\n此操作無法復原。`)) return;
    const button = dialog.querySelector('#merge-confirm');
    button.disabled = true;
    try {
      await mergeGroups(S.session.code, keepGid, dropGid, choices, finalName);
      if (S.groupFilter === dropGid) S.groupFilter = 'all';
      notify(`已合併小組，保留「${finalName}」，並刪除「${drop.name}」。`);
      close();
    } catch (e) { notify(e.message); button.disabled = false; }
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 9.2 控制台版面
//
// 講師控制台分成兩個模式，用頁首的切換鈕切換：
//   課前準備：題目、小組、匯入／匯出、課程設定（左側分頁）。所有「會改結構」的操作都在這裡。
//   上課中：  左欄逐題開關、中欄進度摘要＋作答監看、右欄投影控制。上課時只需要看這一頁。
// 投影（S.projection）時整個控制台換成投影舞台，只剩投影內容。
// ──────────────────────────────────────────────────────────────────────────────
const PREP_TABS = [['q', '題目'], ['g', '小組'], ['d', '匯入／匯出'], ['s', '課程設定']];

/** 題目的建議時間只取第一段（「8 分鐘｜小組 5 分鐘…」→「8 分鐘」），控制台空間有限 */
function shortTime(exDef) {
  return String((exDef && exDef.time) || '').split('｜')[0].trim();
}

function exHeadLabel(i, exDef) {
  const t = shortTime(exDef);
  return `${exLabel(i)}${t ? ` · ${E(t)}` : ''}`;
}

function completedCount(qid) {
  return Object.values(S.course.groups).filter((g) => g.complete && g.complete[qid]).length;
}

function teacherHeaderExtra() {
  const mode = S.teacherMode;
  return `<div class="mode-switch" role="group" aria-label="控制台模式">${
    [['prep', '課前準備'], ['live', '上課中']].map(([k, label]) => `<button type="button" data-teacher-mode="${k}" class="${mode === k ? 'is-on' : ''}" aria-pressed="${mode === k}">${label}</button>`).join('')
  }</div><div class="header-spacer"></div>
    <div class="code-box"><span>加入代碼</span><b>${E(S.session.code)}</b><button type="button" id="join-qr">顯示 QR</button></div>`;
}

function switchTrack(on) {
  return `<span class="sw-track${on ? ' is-on' : ''}" aria-hidden="true"><span class="sw-knob"></span></span>`;
}

/** 題目開放／關閉的開關；上課中的左欄與課前準備的題目列表共用，綁定見 bindGates()。 */
function gateButton(qid, i, open) {
  return `<button type="button" class="ex-gate" role="switch" aria-checked="${open}" data-gate="${E(qid)}" aria-label="${open ? '關閉' : '開放'}${exLabel(i)}">
          ${switchTrack(open)}<span class="ex-gate-state">${open ? '開放中' : '關閉'}</span>
        </button>`;
}

function bindGates() {
  document.querySelectorAll('[data-gate]').forEach((button) => {
    button.onclick = async () => {
      const qid = button.dataset.gate;
      const locking = !S.course.locks[qid];
      // 關閉（不是開放）而且已經有小組進入這一題時先問一次，並一併說明「接下來要修改」的後續影響。
      if (locking && !confirmLockQuestion(qid)) return;
      button.disabled = true;
      try { await setLock(S.session.code, qid, locking); } catch (e) { notify(e.message); button.disabled = false; }
    };
  });
}

// ── 上課中 ──────────────────────────────────────────────────────────────────
function liveLayout() {
  const total = Object.keys(S.course.groups).length;
  const gates = S.course.exercises.map((t, i) => {
    const open = !S.course.locks[t.qid];
    const sel = t.qid === S.qid;
    return `<div class="ex-row${sel ? ' is-selected' : ''}">
        <button type="button" class="ex-row-main" data-select-ex="${E(t.qid)}" aria-current="${sel ? 'true' : 'false'}">
          <span class="ex-row-label">${exHeadLabel(i, t)}</span>
          <b class="ex-row-title">${E(t.title)}</b>
          <span class="ex-row-meta${open ? ' is-open' : ''}">${open ? `${completedCount(t.qid)}／${total} 組完成` : '學員看不到'}</span>
        </button>
        ${gateButton(t.qid, i, open)}
      </div>`;
  }).join('');
  const aside = `<aside class="console-left">
      <div class="console-left-head"><b>練習</b><span>開關即時生效</span></div>
      <div class="exercise-gates">${gates}</div>
      <div class="console-left-foot">要編輯、刪除題目，請到「課前準備」。</div>
    </aside>`;
  const current = currentEx();
  if (!current) {
    return `${aside}<section class="console-center">${noQuestionsNotice()}<p class="muted">到「課前準備」新增或匯入題目。</p></section><aside class="console-right"></aside>`;
  }
  const n = exNumber(S.qid);
  const open = !S.course.locks[S.qid];
  const c = projectionCounts();
  const dots = S.projMode === 'dots';
  return `${aside}
    <section class="console-center">
      <div class="center-head">
        <div class="center-title"><div class="center-eyebrow">${exHeadLabel(n, current)}</div><h2>${E(current.title)}</h2></div>
        <span class="state-pill${open ? ' is-open' : ''}">${open ? '開放中 · 學員可作答' : '關閉中'}</span>
      </div>
      <div class="summary-cards">
        <div class="summary-card"><span>已完成</span><b>${c.done}<small> ／ ${c.total} 組</small></b></div>
        <div class="summary-card"><span>草稿中</span><b>${c.draft}<small> 組</small></b></div>
        <div class="summary-card"><span>尚未作答</span><b>${c.none}<small> 組</small></b></div>
      </div>
      <div class="monitor-card">
        <div class="monitor-head"><b>${dots ? '作答監看' : `投影預覽 · ${E(projModeLabel())}`}</b>${dots ? projectionLegend() : ''}</div>
        <div class="monitor-body">${projectionArea()}</div>
      </div>
      <p class="console-note" id="connection">${dots ? '點任一格看該組內容。橘點不會自動熄滅，儲存後轉為綠點。' : '答案即時同步 · 投影畫面與這裡的預覽內容相同。'}</p>
    </section>
    <aside class="console-right">${projectionControls()}</aside>`;
}

// ── 課前準備 ────────────────────────────────────────────────────────────────
function prepQuestions(importLocked) {
  const list = S.course.exercises.map((t, i) => {
    const open = !S.course.locks[t.qid];
    const answered = answeredCount(t.qid);
    const t2 = shortTime(t);
    const meta = `${(t.fields || []).length} 個欄位${t2 ? ` · ${E(t2)}` : ''}${answered ? ` · ${answered} 組已作答` : ' · 尚無作答'}`;
    const note = open ? '先把開關關掉才能編輯' : (answered ? '編輯時會先封存原題' : '');
    const menuOpen = S.prepMenu === t.qid;
    return `<div class="prep-q">
        <div class="prep-q-num">${i + 1}</div>
        <div class="prep-q-body"><b>${E(t.title)}</b><span>${meta}</span></div>
        ${gateButton(t.qid, i, open)}
        <div class="prep-q-actions">
          <div class="prep-q-buttons">
            <button type="button" class="outline-btn${open ? ' is-blocked' : ''}" data-edit-ex="${E(t.qid)}" aria-disabled="${open}" aria-label="編輯${exLabel(i)}">編輯</button>
            <button type="button" class="outline-btn more-btn" data-prep-menu="${E(t.qid)}" aria-expanded="${menuOpen}" aria-label="${exLabel(i)}的更多操作">···</button>
          </div>
          ${menuOpen ? `<div class="prep-q-menu">
            ${answered ? `<button type="button" class="danger-soft-btn" data-clear-ex="${E(t.qid)}">清除此題各組答案…</button>` : ''}
            <button type="button" class="danger-soft-btn" data-del-ex="${E(t.qid)}" aria-label="刪除${exLabel(i)}">刪除此題（含各組答案）</button>
          </div>` : ''}
          ${note ? `<span class="prep-q-note">${note}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  return `<section class="prep-pane prep-questions">
      <div class="prep-head">
        <h2>題目</h2>
        <div class="prep-head-actions">
          <button type="button" class="outline-btn" id="dl-template">下載範本 JSON</button>
          <button type="button" class="outline-btn" id="import-questions" ${importLocked ? 'disabled' : ''}>匯入題目 JSON</button>
          <input id="import-questions-file" type="file" accept=".json,application/json" hidden>
          <button type="button" class="navy-btn" id="new-exercise">＋ 新增一題</button>
        </div>
      </div>
      ${importLocked
    ? '<div class="prep-warn">已有組別存過答案，「匯入題目 JSON」已停用。要整份重新匯入，請先在「課程設定」重置本場課程；或改用「新增一題」與各題的「編輯」。</div>'
    : '<p class="prep-sub">匯入題目會取代目前全部練習內容；課程開始有答案之後匯入就會停用，屆時請改用「新增一題」與各題的「編輯」。</p>'}
      ${S.course.exercises.length ? `<p class="prep-sub">目前共 ${S.course.exercises.length} 個練習</p><div class="prep-q-list">${list}</div>` : noQuestionsNotice()}
      ${archivedSection()}
    </section>`;
}

function prepData() {
  return `<section class="prep-pane prep-data">
      <h2>匯入／匯出答案</h2>
      <div class="prep-card">
        <b>匯出全部答案</b>
        <div class="prep-row"><button type="button" class="navy-btn" id="export-json">JSON（可再匯入還原）</button><button type="button" class="outline-btn" id="export-csv">CSV（Excel 閱讀）</button></div>
      </div>
      <div class="prep-card">
        <b>從備份還原答案</b>
        <span class="prep-card-note">同名組別的答案會由備份取代，其他組別不受影響。</span>
        <div><button type="button" class="outline-btn" id="import-json">選擇 JSON 備份檔</button><input id="import-file" type="file" accept=".json,application/json" hidden></div>
      </div>
    </section>`;
}

function prepSettings() {
  return `<section class="prep-pane prep-settings">
      <h2>課程設定</h2>
      <div class="prep-card">
        <span class="prep-card-note">課程名稱</span>
        <b class="course-name-text">${E(S.course.name)}</b>
      </div>
      <div class="prep-card password-card">
        <div><b>講師密碼</b><span class="prep-card-note">所有講師共用這組密碼。重設後，已登入的控制台不受影響，下次登入改用新密碼。</span></div>
        <button type="button" class="outline-btn" id="reset-password">重設密碼…</button>
      </div>
      <div class="danger-zone">
        <div class="danger-zone-head">無法復原的操作</div>
        <div class="danger-zone-row"><div><b>重置本場課程</b><span>清空全部組別與答案、關閉所有練習，題目保留。</span></div><button type="button" class="danger-outline-btn" id="reset">重置…</button></div>
        <div class="danger-zone-row"><div><b>刪除整個課程</b><span>題目、組別、答案全部刪除，需輸入課程名稱確認。</span></div><button type="button" class="danger-fill-btn" id="delete-course">刪除課程…</button></div>
      </div>
    </section>`;
}

let passwordOpen = false;
function openPasswordDialog() {
  if (passwordOpen) return;
  passwordOpen = true;
  const dialog = document.createElement('dialog');
  dialog.className = 'float-window password-window';
  dialog.setAttribute('aria-labelledby', 'pw-title');
  // 用 form 包起來：按 Enter 就送出，瀏覽器的密碼管理員也認得這是「改密碼」
  dialog.innerHTML = `<form method="dialog" id="pw-form">
      <div class="float-top"><strong id="pw-title">重設講師密碼</strong><button type="button" data-close>取消</button></div>
      <div class="float-body">
        <input type="text" name="username" autocomplete="username" value="${E(S.session.code)}" hidden>
        <label for="pw-current">目前的密碼</label>
        <input id="pw-current" type="password" autocomplete="current-password" required>
        <label for="pw-next">新密碼（至少 6 個字元）</label>
        <input id="pw-next" type="password" autocomplete="new-password" minlength="6" required>
        <label for="pw-next2">再輸入一次新密碼</label>
        <input id="pw-next2" type="password" autocomplete="new-password" minlength="6" required>
        <p class="muted">密碼以不可還原的方式儲存。重設後請通知其他共用這門課的講師。</p>
        <p class="pw-error" id="pw-error" role="alert"></p>
      </div>
      <div class="float-actions"><button type="button" data-close>取消</button><button type="submit" class="primary" id="pw-save">更新密碼</button></div>
    </form>`;
  document.body.appendChild(dialog);
  dialog.showModal();
  const close = () => { passwordOpen = false; dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  const field = (id) => dialog.querySelector(id);
  const showError = (msg, focus) => { field('#pw-error').textContent = msg; if (focus) focus.focus(); };
  field('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const current = field('#pw-current').value;
    const next = field('#pw-next').value;
    if (next.length < 6) { showError('新密碼至少需要 6 個字元。', field('#pw-next')); return; }
    if (next !== field('#pw-next2').value) { showError('兩次輸入的新密碼不一致。', field('#pw-next2')); return; }
    if (next === current) { showError('新密碼與目前的密碼相同。', field('#pw-next')); return; }
    const save = field('#pw-save');
    save.disabled = true;
    save.textContent = '更新中…';
    try {
      await changeTeacherPassword(S.session.code, current, next);
      close();
      notify('講師密碼已更新，下次登入請使用新密碼。');
    } catch (err) {
      save.disabled = false;
      save.textContent = '更新密碼';
      showError(err.message, err.message.startsWith('目前的密碼') ? field('#pw-current') : null);
    }
  };
  field('#pw-current').focus();
}

function prepLayout(importLocked) {
  const counts = { q: S.course.exercises.length, g: Object.keys(S.course.groups).length };
  const nav = `<nav class="prep-nav" aria-label="課前準備">${
    PREP_TABS.map(([k, label]) => `<button type="button" data-prep-tab="${k}" class="${S.prepTab === k ? 'is-on' : ''}" aria-current="${S.prepTab === k ? 'page' : 'false'}"><span>${label}</span><span class="prep-nav-count">${counts[k] ?? ''}</span></button>`).join('')
  }<div class="prep-nav-fill"></div><div class="prep-nav-foot">準備好之後切到「上課中」，再逐題開放。</div></nav>`;
  let pane = '';
  if (S.prepTab === 'g') pane = groupManageSection();
  else if (S.prepTab === 'd') pane = prepData();
  else if (S.prepTab === 's') pane = prepSettings();
  else pane = prepQuestions(importLocked);
  return `${nav}<div class="prep-main">${pane}</div>`;
}

// ── 刪除／清除單題（課前準備的「···」選單） ─────────────────────────────────
async function deleteQuestion(button, qid) {
  const target = S.course.byQid[qid];
  if (!target) return;
  const answered = answeredCount(qid);
  const warning = answered ? `目前有 ${answered} 組在這一題已經作答，答案會一併永久刪除。\n` : '';
  if (!confirm(`確定刪除「${exLabel(exNumber(qid))}｜${target.title}」？\n\n${warning}後面的練習會自動往前遞補題號，其他練習的答案保留。此操作無法復原。`)) return;
  button.disabled = true;
  try {
    await deleteExercise(S.session.code, S.course, qid);
    // 題目沒了，掛在它身上的 live 輔助標記（橘點、已進入）留著只會是永遠不會被讀到的垃圾。
    await clearActivityForQuestion(S.session.code, qid);
    await clearEnteredForQuestion(S.session.code, qid);
    if (S.qid === qid) S.qid = firstQid();
    S.prepMenu = null;
    notify(`已刪除「${target.title}」。`);
  } catch (e) {
    notify(e.message);
    button.disabled = false;
  }
}

async function clearQuestionAnswers(qid) {
  const target = S.course.byQid[qid];
  if (!target) return;
  if (!confirm(`確定清除所有組別的「${exLabel(exNumber(qid))}｜${target.title}」答案？其他練習會保留。此操作無法復原。`)) return;
  try {
    const updates = {};
    Object.keys(S.course.groups).forEach((gid) => {
      updates[`groups/${gid}/answers/${qid}`] = '{}';
      updates[`groups/${gid}/complete/${qid}`] = false;
      updates[`groups/${gid}/updated/${qid}`] = 0;
      updates[`groups/${gid}/revision/${qid}`] = (S.course.groups[gid].revision[qid] || 0) + 1;
    });
    await update(courseRef(S.session.code), updates);
    // 答案清掉了，活動標記也要跟著清：否則橘點會留在一個已經沒有答案的欄位上，變成假訊號。
    await clearActivityForQuestion(S.session.code, qid);
    // 「已進入」標記同理：不清的話，接下來關閉這一題時還會彈出「已經有 N 組進入這一題」的假警訊。
    await clearEnteredForQuestion(S.session.code, qid);
    S.prepMenu = null;
    notify('本題答案已清除。');
  } catch (e) { notify(e.message); }
}

// ── 投影：本機全螢幕 ───────────────────────────────────────────────────────
function leaveLocalProjection() {
  if (!S.projection || isProjectorWindow) return;
  S.projection = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  renderTeacher();
}

function enterLocalProjection() {
  S.projection = true;
  // 投影的第一頁一律是題目，講師再用 → 翻到答案
  showQuestionFirst();
  syncProjection();
  renderTeacher();
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => { /* 瀏覽器不允許時就停在視窗內的投影畫面，Esc 一樣能回去 */ });
}

let fullscreenBound = false;
function bindFullscreenExit() {
  if (fullscreenBound) return;
  fullscreenBound = true;
  // 使用者按 Esc 退出全螢幕時，瀏覽器只會發 fullscreenchange，不會把 Esc 交給頁面。
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && S.projection && !isProjectorWindow && S.session && S.session.role === 'teacher') leaveLocalProjection();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.projection && !isProjectorWindow && S.session && S.session.role === 'teacher' && !document.querySelector('dialog[open]')) leaveLocalProjection();
  });
}

export function renderTeacher() {
  // 重畫會換掉整棵 DOM：先解除上一輪投影區的 live 訂閱與鍵盤監聽，否則殭屍訂閱會對已移除的節點動手。
  disposeProjection();
  ensureMigrated(S.session.code);
  const hasEx = S.course.exercises.length > 0;
  // 匯入降級為開課前的準備動作：一旦有任何答案就停用（理由寫在題目分頁的警示裡）。
  const importLocked = courseHasAnswers(S.course);
  // S.qid 指不到任何已開放題目時（剛進控制台、或這一題剛被刪掉）自動回到第一題。
  if (exNumber(S.qid) < 0) S.qid = firstQid();
  // 群組篩選下拉已移除：控制台一律看全部組別。
  S.groupFilter = 'all';
  if (isProjectorWindow) S.projection = true;
  if (S.teacherMode !== 'prep' && S.teacherMode !== 'live') S.teacherMode = hasEx ? 'live' : 'prep';
  bindFullscreenExit();
  bindJoinQRChannel();

  // ── 投影舞台 ──
  if (S.projection) {
    shell(projectionStage(), { layout: 'stage' });
    const back = document.querySelector('.proj-stage #project');
    if (back) back.onclick = leaveLocalProjection;
    // 舞台上的加入代碼本身就是按鈕：按了直接顯示 QR，不必先回控制台
    document.querySelector('#stage-join-qr').onclick = () => openJoinQR({ backLabel: '返回投影畫面' });
    const full = document.querySelector('#stage-fullscreen');
    if (full) {
      full.onclick = () => {
        const el = document.documentElement;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      };
    }
    if (hasEx && currentEx()) bindProjection();
    else if (isProjectorWindow) startProjectorBeacon();
    return;
  }

  const live = S.teacherMode === 'live';
  shell(`<h1 class="sr-only">講師控制台｜${E(S.course.name)}</h1>
    <div class="console-grid ${live ? 'is-live' : 'is-prep'}">${live ? liveLayout() : prepLayout(importLocked)}</div>`, {
    layout: 'console',
    headerExtra: teacherHeaderExtra(),
  });

  document.querySelectorAll('[data-teacher-mode]').forEach((b) => {
    b.onclick = () => { S.teacherMode = b.dataset.teacherMode; renderTeacher(); };
  });
  document.querySelector('#join-qr').onclick = onJoinQRButton;
  paintJoinButton();

  if (!live) {
    document.querySelectorAll('[data-prep-tab]').forEach((b) => {
      b.onclick = () => { S.prepTab = b.dataset.prepTab; S.prepMenu = null; renderTeacher(); };
    });
    bindPrepPane();
    return;
  }

  document.querySelectorAll('[data-select-ex]').forEach((b) => {
    b.onclick = () => {
      if (S.qid === b.dataset.selectEx) return;
      S.qid = b.dataset.selectEx;
      showQuestionFirst(); // 換題時投影先回到題目頁
      renderTeacher();
      syncProjection();
    };
  });
  bindGates();
  if (!hasEx || !currentEx()) return;
  document.querySelector('#open-projector').onclick = () => {
    // 新開的投影視窗從題目頁開始：控制台先切到題目，投影視窗連上時拿到的就是這份狀態
    if (!projectorConnected() && S.projMode !== 'question') { showQuestionFirst(); renderTeacher(); }
    if (openProjectorWindow() === false) notify('瀏覽器擋下了新視窗。請允許這個網站開啟彈出式視窗，或改用「本機全螢幕」。');
  };
  document.querySelector('#project').onclick = enterLocalProjection;

  // 投影區的綁定放在最後：它會重新登記 live 訂閱，必須在這一輪 DOM 都建好之後。
  bindProjection();
}

function bindPrepPane() {
  const tab = S.prepTab;
  if (tab === 'g') { bindGroupManage(); return; }
  if (tab === 'd') {
    document.querySelector('#export-json').onclick = () => exportData('json');
    document.querySelector('#export-csv').onclick = () => exportData('csv');
    document.querySelector('#import-json').onclick = () => document.querySelector('#import-file').click();
    document.querySelector('#import-file').onchange = importAnswersFile;
    return;
  }
  if (tab === 's') {
    // 刪除課程放在課程設定並在這裡綁定：還沒匯入題目的課程也必須刪得掉。
    document.querySelector('#reset-password').onclick = openPasswordDialog;
    document.querySelector('#delete-course').onclick = async () => {
      if (prompt(`這會永久刪除整個課程「${S.course.name}」，包含題目與所有組別答案，無法復原。請輸入課程名稱確認。`) !== S.course.name) return;
      // 先留存代碼：課程一被刪除，onValue 會立刻收到 null 並把 session 清空。
      const code = S.session.code;
      try {
        await remove(courseRef(code));
        await clearLiveCourse(code).catch(() => { /* live 是易變資料，清不掉不影響課程已被刪除的事實 */ });
        forgetCourse(code);
        notify('課程已刪除。');
      } catch (e) { notify(e.message); }
    };
    document.querySelector('#reset').onclick = async () => {
      if (prompt('這會移除全部組別及全部練習答案，並關閉所有練習（題目保留）。請輸入「重置課程」確認。') !== '重置課程') return;
      try {
        const updates = { groups: null };
        S.course.all.forEach((exDef) => { updates[`locks/${exDef.qid}`] = true; });
        await update(courseRef(S.session.code), updates);
        await clearLiveCourse(S.session.code).catch(() => { /* 同上：清不掉只是留下垃圾，不影響重置結果 */ });
        S.groupFilter = 'all';
        notify('課程已重置，全部組別與答案已清空。');
      } catch (e) { notify(e.message); }
    };
    return;
  }
  // 題目分頁
  bindGates();
  document.querySelector('#dl-template').onclick = downloadTemplate;
  document.querySelector('#import-questions').onclick = () => document.querySelector('#import-questions-file').click();
  document.querySelector('#import-questions-file').onchange = importQuestionsFile;
  document.querySelector('#new-exercise').onclick = () => beginNewQuestion(S.session.code);
  bindArchivedSection(S.session.code);
  document.querySelectorAll('[data-edit-ex]').forEach((button) => {
    // 開放中的題目，編輯器自己會擋下並說明要先關閉（按鈕只是看起來停用，點了才會看到理由）。
    button.onclick = () => beginEditQuestion(S.session.code, button.dataset.editEx);
  });
  document.querySelectorAll('[data-prep-menu]').forEach((b) => {
    b.onclick = () => { S.prepMenu = S.prepMenu === b.dataset.prepMenu ? null : b.dataset.prepMenu; renderTeacher(); };
  });
  document.querySelectorAll('[data-del-ex]').forEach((button) => {
    button.onclick = () => deleteQuestion(button, button.dataset.delEx);
  });
  document.querySelectorAll('[data-clear-ex]').forEach((button) => {
    button.onclick = () => clearQuestionAnswers(button.dataset.clearEx);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 10. 匯入 / 匯出
// ──────────────────────────────────────────────────────────────────────────────
export function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadTemplate() {
  downloadBlob(JSON.stringify(TEMPLATE, null, 2), '題目範本.json', 'application/json');
  notify('已下載題目範本，可用文字編輯器修改後再匯入。');
}

export async function readJSONFile(file, limitBytes, hint) {
  if (file.size > limitBytes) throw Error(`檔案過大，請選擇 ${Math.round(limitBytes / 1000000)} MB 以下的 JSON。`);
  const text = (await file.text()).replace(/^﻿/, '');
  try { return JSON.parse(text); } catch { throw Error(hint); }
}

/**
 * 匯入題目。題目的 qid 就是答案的 key，因此：
 * - 原 JSON 自帶 qid 的，照它的 qid（講師改完題目重新匯入時，答案會留在原來的題目上）。
 * - 沒帶 qid 的，沿用目前同一個位置那一題的 qid，維持「重新匯入不會讓已作答的答案整批失聯」的既有行為。
 * - 其餘才用新產生的 qid。
 */
export async function importQuestionsFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    // 畫面上按鈕已經停用，這裡再擋一次：檔案選擇窗開著的時候，別的裝置可能剛好存進第一筆答案。
    if (courseHasAnswers(S.course)) {
      throw Error('這場課程已經有組別存過答案，匯入題目已停用（匯入是整份取代，無法分辨修改版與全新題目）。要重新匯入請先執行「重置本場課程」，或改用「新增一題」與各題的「編輯」。');
    }
    const payload = await readJSONFile(file, 2000000, '無法讀取 JSON，請使用範本格式編輯。');
    const validated = validateExercisesPayload(payload);
    const carried = validated.map((_, i) => {
      const q = payload.exercises[i] && payload.exercises[i].qid;
      return typeof q === 'string' && !!q.trim();
    });
    const used = new Set(validated.filter((_, i) => carried[i]).map((ex) => ex.qid));
    const existing = S.course.exercises;
    const exercises = validated.map((ex, i) => {
      if (carried[i]) return ex;
      const inherited = existing[i] ? existing[i].qid : null;
      if (inherited && !used.has(inherited)) { used.add(inherited); return { ...ex, qid: inherited }; }
      used.add(ex.qid);
      return ex;
    });

    const groupCount = Object.keys(S.course.groups).length;
    const message = `匯入摘要：共 ${exercises.length} 個練習\n${
      exercises.map((t, i) => `${i + 1}．${t.title}`).join('\n')
    }\n\n目前課程有 ${S.course.exercises.length} 個練習、${groupCount} 個組別。匯入後將完全取代目前的練習內容；已存在的組別答案中，欄位不符的部分將會清空。確定匯入？`;
    if (!confirm(message)) return;
    // 先把舊課程升級到 v2：改寫 exercisesJson 之後，題目就都帶著 qid，舊的數字 key 會失去退回來源。
    await migrateCourseIfNeeded(S.session.code);
    const updates = { exercisesJson: JSON.stringify(exercises) };
    const keep = new Set(exercises.map((ex) => ex.qid));
    exercises.forEach((ex) => {
      updates[`locks/${ex.qid}`] = S.course.locks[ex.qid] === undefined ? true : !!S.course.locks[ex.qid];
    });
    Object.keys(S.course.locks).forEach((qid) => { if (!keep.has(qid)) updates[`locks/${qid}`] = null; });
    // 匯入是整份取代，消失的 qid 底下各組的 answers/complete/updated/revision 也要清掉。
    // 「有答案就停用匯入」只擋得住有內容的答案，一批全空白的答案節點照樣放行，不清就成孤兒。
    // 遷移完成後才讀：此時伺服器上的 key 都已經是 qid，舊的數字 key 不會被誤判成孤兒。
    Object.assign(updates, await orphanAnswerUpdates(S.session.code, keep));
    await update(courseRef(S.session.code), updates);
    S.qid = exercises[0].qid;
    notify(`已匯入 ${exercises.length} 個練習。`);
  } catch (e) {
    notify(e.message);
  } finally {
    event.target.value = '';
  }
}

export async function importAnswersFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const payload = await readJSONFile(file, 9500000, '無法讀取 JSON，請使用「匯出全部答案 JSON」產生的備份檔。');
    if (!payload || typeof payload !== 'object' || !payload.groups || typeof payload.groups !== 'object') {
      throw Error('請選擇本題本匯出的 JSON 答案檔。CSV 僅供閱讀，不能還原。');
    }
    const incoming = Object.values(payload.groups);
    if (!incoming.length || incoming.length > 500) throw Error('匯入檔需包含 1–500 個小組。');
    const list = S.course.exercises;
    // 新版備份有 questions:[{qid,title}]，答案以 qid 對應。
    // 舊備份沒有這一段（或備份來自另一個課程、qid 完全對不上）時，退回用題號位置對應到目前第 i 題。
    const backupQids = Array.isArray(payload.questions)
      ? payload.questions.map((q) => (q && typeof q.qid === 'string' ? q.qid : '')).filter(Boolean)
      : [];
    const matchByQid = backupQids.some((qid) => !!S.course.byQid[qid]);
    const prepared = incoming.map((g) => {
      const name = String(g.name || '').trim();
      const author = String(g.author || '').trim();
      if (!name || !author || name.length > 100 || author.length > 100) throw Error('小組的組別與填表人須完整填寫（100 字以內）。');
      const answers = {};
      const complete = {};
      const updated = {};
      const revision = {};
      const pick = (source, exDef, i) => {
        const src = source || {};
        return matchByQid ? src[exDef.qid] : src[i]; // 舊備份的 answers 可能是陣列或以題號為 key 的物件，兩者取法相同
      };
      list.forEach((exDef, i) => {
        const raw = pick(g.answers, exDef, i);
        const wantComplete = !!pick(g.complete, exDef, i);
        let clean = {};
        let ok = wantComplete;
        try {
          clean = validateAnswer(exDef, raw && typeof raw === 'object' ? raw : {}, wantComplete);
        } catch {
          try { clean = validateAnswer(exDef, raw && typeof raw === 'object' ? raw : {}, false); ok = false; } catch { clean = {}; ok = false; }
        }
        answers[exDef.qid] = JSON.stringify(clean);
        complete[exDef.qid] = ok;
        const u = pick(g.updated, exDef, i);
        updated[exDef.qid] = typeof u === 'number' ? u : (u ? Date.parse(u) || 0 : 0);
        revision[exDef.qid] = 0;
      });
      return {
        name,
        // 備份檔沒有 nameKey（或來自舊版），一律重算：小組的名稱比對一律走正規化後的 nameKey。
        nameKey: normalizeGroupName(name),
        author,
        answers,
        complete,
        updated,
        revision,
        createdAt: Date.now(),
      };
    });
    const names = new Set(prepared.map((g) => g.nameKey));
    if (names.size !== prepared.length) throw Error('匯入檔有重複的組別名稱（比對時會忽略空白與全形半形差異），請先確認備份。');
    const existingNames = new Set(Object.values(S.course.groups).map((g) => g.nameKey));
    const replaced = prepared.filter((g) => existingNames.has(g.nameKey)).length;
    // 被取代的組別是整組刪掉再重建，而備份檔本來就不含 archives，
    // 所以那些封存內容一定會消失。硬留只會產生對不上題目的孤兒，因此改成在確認訊息裡講清楚。
    const losingArchives = Object.values(S.course.groups)
      .filter((g) => names.has(g.nameKey) && Object.keys(g.archives || {}).length).length;
    const archiveWarning = losingArchives
      ? `\n注意：被取代的組別中有 ${losingArchives} 組帶有封存內容（來自合併小組或講師修改題目），這些封存內容會一併永久消失；備份檔裡沒有它們，匯入後無法復原。\n`
      : '';
    const preview = prepared.slice(0, 12).map((g) => g.name).join('\n') + (prepared.length > 12 ? `\n…其餘 ${prepared.length - 12} 組` : '');
    const mapping = matchByQid
      ? ''
      : '這份備份沒有可對應的題目 ID（舊版備份或來自其他課程），將依題號順序對應到目前的第一題、第二題……請先確認題目順序相同。\n\n';
    if (!confirm(`匯入摘要：共 ${prepared.length} 組\n新增 ${prepared.length - replaced} 組，同名覆寫 ${replaced} 組。\n\n${preview}\n\n${mapping}同一組別名稱的答案將由備份取代；其他組別與目前題目開關保留。被取代組別需重新加入。\n${archiveWarning}確定匯入？`)) return;

    const updates = {};
    const removedGids = [];
    Object.entries(S.course.groups).forEach(([gid, g]) => {
      if (!names.has(g.nameKey)) return;
      updates[`groups/${gid}`] = null;
      removedGids.push(gid);
    });
    prepared.forEach((g) => { updates[`groups/${randomId(8)}`] = g; });
    await update(courseRef(S.session.code), updates);
    // 被取代的組別已經不存在了，它們在 live/<CODE> 的活動標記、已進入與編輯鎖要一併清掉（同 deleteGroup）。
    // 清不掉只是留下不會被讀到的垃圾，不該因此把已經完成的匯入報成失敗。
    await Promise.all(removedGids.map((gid) => clearLiveGroup(S.session.code, gid).catch(() => {})));
    S.groupFilter = 'all';
    notify(`已匯入 ${prepared.length} 組答案。`);
  } catch (e) {
    notify(e.message);
  } finally {
    event.target.value = '';
  }
}

/**
 * 匯出。list 只取 S.course.exercises（status === 'active'），因此**封存題的答案不會出現在匯出檔**，
 * 各組的 archives（封存紀錄）也完全沒被讀到。這是講師的課堂管理責任，不是權限管制——
 * 把封存題還原之後，它就是一般題目，答案自然會回到匯出檔裡。
 */
export function exportData(format) {
  try {
    const list = S.course.exercises;
    const titles = list.map((e2) => e2.title);
    // titles 是給人看的；questions 才是還原時用來對應答案的依據（標題會重複，qid 不會）。
    const questions = list.map((e2) => ({ qid: e2.qid, title: e2.title }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      const groups = {};
      Object.entries(S.course.groups).forEach(([gid, g]) => {
        const answers = {};
        const complete = {};
        const updated = {};
        list.forEach((exDef) => {
          answers[exDef.qid] = g.answers[exDef.qid] || {};
          complete[exDef.qid] = !!g.complete[exDef.qid];
          updated[exDef.qid] = g.updated[exDef.qid] ? new Date(g.updated[exDef.qid]).toISOString() : '';
        });
        groups[gid] = {
          name: g.name, author: g.author, answers, complete, updated,
        };
      });
      downloadBlob(
        JSON.stringify({
          exportedAt: new Date().toISOString(), course: S.course.name, code: S.session.code, titles, questions, groups,
        }, null, 2),
        `${S.course.name || '互動題本'}_各組答案_${stamp}.json`,
        'application/json',
      );
    } else {
      const rows = [['組別', '最後儲存者', '練習', '狀態', '更新時間', '欄位', '答案']];
      Object.values(S.course.groups).forEach((g) => {
        list.forEach((exDef, i) => {
          answerRows(exDef.fields || [], g.answers[exDef.qid] || {}).forEach(([k, v]) => {
            rows.push([
              g.name, g.author, `${exLabel(i)} ${exDef.title || ''}`,
              g.complete[exDef.qid] ? '已完成' : '草稿',
              g.updated[exDef.qid] ? new Date(g.updated[exDef.qid]).toLocaleString('zh-TW') : '',
              k, v || '',
            ]);
          });
        });
      });
      const cell = (v) => '"' + String(v).replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
      downloadBlob('﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n'), `${S.course.name || '互動題本'}_各組答案_${stamp}.csv`, 'text/csv');
    }
    notify('已匯出檔案。');
  } catch (e) { notify(e.message); }
}

// ──────────────────────────────────────────────────────────────────────────────
// 11. 學員加入 QR Code
// ──────────────────────────────────────────────────────────────────────────────
export function joinURL(code) {
  return location.origin + location.pathname.replace(/index\.html$/, '') + '?c=' + encodeURIComponent(code);
}

/** 沒有組別又不允許學員自訂組名時先問一次；回傳 false 表示講師選擇先回去開組 */
function confirmJoinWithoutGroups() {
  // 學員掃碼只會看到等待畫面。講師常常是「先投影 QR、再想到要開組」，在這裡先問一次比讓全班卡在等待畫面便宜得多。
  if (S.course.allowStudentGroupNames || Object.keys(S.course.groups).length) return true;
  return confirm('目前還沒有任何小組，學員掃碼後只會看到等待畫面。要繼續顯示 QR Code 嗎？（取消則回控制台新增組別）');
}

let closeJoinDialog = null;

/**
 * 全螢幕的學員加入頁。options：
 *   skipConfirm  已在控制台確認過（投影視窗收到指令時用）
 *   backLabel    關閉鈕的字（投影舞台上要寫「返回投影畫面」）
 *   onClose      關閉後要做什麼（投影視窗用來通知控制台）
 */
export function openJoinQR(options = {}) {
  if (S.joinOpen) return;
  if (!options.skipConfirm && !confirmJoinWithoutGroups()) return;
  S.joinOpen = true;
  const url = joinURL(S.session.code);
  const dialog = document.createElement('dialog');
  dialog.className = 'join-screen';
  dialog.setAttribute('aria-labelledby', 'join-title');
  dialog.innerHTML = `<div class="join-top"><strong>${E(S.course.name)}</strong><button id="close-join">${E(options.backLabel || '返回講師控制台')}</button></div>
    <div class="join-body">
      <h1 id="join-title">請掃碼，進入小組練習</h1>
      <p>① 用手機相機掃碼，或到下方網址輸入代碼</p>
      <div id="qr-picture"><canvas id="qr-canvas"></canvas></div>
      <div class="code-display">${E(S.session.code)}</div>
      <p class="join-address">${E(url)}</p>
      <p>② 選擇（或新增）組別、填寫姓名即可開始</p>
    </div>`;
  document.body.appendChild(dialog);
  dialog.showModal();
  const close = () => {
    if (!S.joinOpen) return;
    S.joinOpen = false;
    closeJoinDialog = null;
    dialog.close();
    dialog.remove();
    if (options.onClose) options.onClose();
  };
  closeJoinDialog = close;
  dialog.querySelector('#close-join').onclick = close;
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  try {
    // eslint-disable-next-line no-new, no-undef
    new QRious({ element: dialog.querySelector('#qr-canvas'), value: url, size: 900, level: 'M', background: 'white', foreground: 'black' });
  } catch {
    dialog.querySelector('#qr-picture').textContent = 'QR Code 產生失敗，請改用上方代碼或網址。';
  }
}

export function closeJoinQR() { if (closeJoinDialog) closeJoinDialog(); }

// ── 控制台的「顯示 QR」：有投影視窗就顯示在投影視窗，否則在本機開 ─────────────
let projQrOpen = false;

function paintJoinButton() {
  const b = document.querySelector('#join-qr');
  if (!b) return;
  const remote = projectorConnected();
  b.textContent = remote && projQrOpen ? '收起投影 QR' : '顯示 QR';
  b.title = remote ? '在投影視窗顯示學員加入的 QR Code' : '在這台電腦全螢幕顯示學員加入的 QR Code';
}

function onJoinQRButton() {
  if (!projectorConnected()) { openJoinQR(); return; }
  if (projQrOpen) { publishJoinQR(false); projQrOpen = false; paintJoinButton(); return; }
  if (!confirmJoinWithoutGroups()) return;
  publishJoinQR(true);
  projQrOpen = true;
  paintJoinButton();
  notify('已在投影視窗顯示 QR Code。');
}

let joinQRBound = false;
function bindJoinQRChannel() {
  if (joinQRBound) return;
  joinQRBound = true;
  onJoinQR((open) => {
    if (isProjectorWindow) {
      if (open) openJoinQR({ skipConfirm: true, backLabel: '返回投影畫面', onClose: () => publishJoinQR(false) });
      else closeJoinQR();
      return;
    }
    // 控制台端：投影視窗那邊被關掉（或重新開啟）時，更新按鈕的字
    projQrOpen = open;
    paintJoinButton();
  });
}
