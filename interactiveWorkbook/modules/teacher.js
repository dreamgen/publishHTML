import {
  S, fieldsOf, currentEx, exNumber, firstQid,
} from './state.js';
import {
  E, exLabel, notify, randomId,
} from './util.js';
import {
  shell, tabs, bindTabs, noQuestionsNotice, expandDialog, truncate,
} from './ui.js';
import {
  courseRef, update, remove,
} from './firebase.js';
import {
  deleteExercise, setLock, migrateCourseIfNeeded, answerHasContent,
  createGroups, renameGroup, deleteGroup, mergeGroups, setAllowStudentGroupNames,
  clearLiveCourse, MERGE_KEEP, MERGE_DROP, MERGE_BOTH,
} from './data.js';
import {
  TEMPLATE, validateExercisesPayload, validateAnswer, normalizeGroupName, MAX_GROUPS,
} from './schema.js';
import { forgetCourse } from './storage.js';

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

export function compare() {
  const list = Object.entries(S.course.groups).filter(([k]) => S.groupFilter === 'all' || k === S.groupFilter);
  if (!list.length) return '<div class="notice">目前還沒有組別答案。學員加入並儲存後，答案會即時出現在這裡。</div>';
  const fields = fieldsOf(S.qid);
  const labels = answerRows(fields, {});
  return `<div class="table-scroll"><table class="data-table comparison"><thead><tr><th scope="col">作答欄位</th>${
    list.map(([, g]) => `<th scope="col">${E(g.name)}<div class="muted">${
      g.complete[S.qid] ? '✓ 已完成' : (g.updated[S.qid] ? '草稿' : '尚未作答')
    }</div></th>`).join('')
  }</tr></thead><tbody>${
    labels.map(([label], i) => `<tr><th scope="row">${E(label)}</th>${
      list.map(([, g]) => {
        const v = answerRows(fields, g.answers[S.qid] || {})[i][1];
        return `<td class="answer ${v ? '' : 'empty'}">${v ? E(v) : '— 尚未填寫'}</td>`;
      }).join('')
    }</tr>`).join('')
  }</tbody></table></div>`;
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
  const rows = entries.length
    ? entries.map(([gid, g]) => {
      const archives = Object.keys(g.archives || {}).length;
      return `<div class="group-row"><div class="group-row-main"><b>${E(g.name)}</b><div class="muted">${
        g.author ? `加入者：${E(g.author)}` : '尚未有人加入'
      } · 已作答 ${groupAnsweredCount(g)}／${total} 題${archives ? ` · 封存內容 ${archives} 筆` : ''}</div></div><div class="toolbar"><button type="button" class="small" data-rename-group="${E(gid)}">改名</button><button type="button" class="small danger" data-delete-group="${E(gid)}">刪除</button></div></div>`;
    }).join('')
    : '<div class="notice">目前還沒有任何小組。請在下方先建立組別，學員才能加入；若已允許學員自訂組名，學員也可以自己輸入新的組別。</div>';

  const mergeTools = entries.length >= 2
    ? `<div class="group-merge-tools"><h3>合併小組</h3>
      <p>用在同一組被分成兩筆的時候（例如兩個人各自輸入了不同寫法的組名）。合併會把其中一組的答案併進另一組，再刪除被併入的那一組。這是破壞性動作，無法復原。</p>
      <div class="toolbar">
        <label for="merge-keep">保留這一組</label>
        <select id="merge-keep">${entries.map(([gid, g], i) => `<option value="${E(gid)}" ${i === 0 ? 'selected' : ''}>${E(g.name)}</option>`).join('')}</select>
        <label for="merge-drop">併入並刪除</label>
        <select id="merge-drop">${entries.map(([gid, g], i) => `<option value="${E(gid)}" ${i === 1 ? 'selected' : ''}>${E(g.name)}</option>`).join('')}</select>
        <button type="button" id="merge-start">檢視合併內容</button>
      </div></div>`
    : '';

  return `<section class="manage card group-manage">
      <h2>小組管理</h2>
      <p>小組的身分是系統給的固定編號，名稱只是標籤：改名不會影響任何已經存好的答案。目前共 ${entries.length} 組，一場課程上限 ${MAX_GROUPS} 組。</p>
      <div class="group-rows">${rows}</div>
      <div class="group-add">
        <div class="group-add-item">
          <label for="new-group-name">新增一個小組</label>
          <div class="toolbar"><input id="new-group-name" maxlength="100" placeholder="例如：第 1 組"><button type="button" class="primary" id="add-group">新增</button></div>
        </div>
        <div class="group-add-item">
          <label for="new-group-count">一次產生多組</label>
          <div class="toolbar"><input id="new-group-count" type="number" min="1" max="${MAX_GROUPS}" value="6"><button type="button" id="add-group-batch">產生「第 1 組」～「第 N 組」</button></div>
        </div>
      </div>
      <p class="muted">名稱比對時會忽略空白與全形半形差異，「第 1 組」與「第1組」會被當成同一組，已經存在的不會重複建立。</p>
      <label class="choice group-allow"><input type="checkbox" id="allow-student-names" ${allow ? 'checked' : ''}><span><b>允許學員自行輸入組別名稱</b><br>關閉時，學員只能從你建立的組別中選擇；若還沒有任何組別，學員會看到「講師尚未建立小組，請稍候」的等待畫面，你一建立組別他們的畫面就會自動更新。</span></label>
      ${mergeTools}
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

export function renderTeacher() {
  ensureMigrated(S.session.code);
  const hasEx = S.course.exercises.length > 0;
  const groupCount = Object.keys(S.course.groups).length;
  // S.qid 指不到任何已開放題目時（剛進控制台、或這一題剛被刪掉）自動回到第一題。
  if (exNumber(S.qid) < 0) S.qid = firstQid();
  const current = currentEx();
  const n = exNumber(S.qid);
  shell(`<div class="context"><div class="eyebrow">講師控制台</div><h1>${E(S.course.name)}</h1></div>
    <section class="manage card">
      <h2>課程資訊與題目管理</h2>
      <div class="course-item"><b>學員加入代碼</b><span><code style="font-size:1.4rem">${E(S.session.code)}</code></span></div>
      <p class="muted" style="margin-top:10px">學員在首頁輸入這組代碼即可加入；也可以按「學員加入 QR Code」投影出來讓學員掃描。</p>
      <div class="toolbar">
        <button id="join-qr" class="primary">學員加入 QR Code</button>
        <button id="dl-template">下載題目範本 JSON</button>
        <button id="import-questions">匯入題目 JSON</button>
        <input id="import-questions-file" type="file" accept=".json,application/json" hidden>
        <button class="danger" id="delete-course">刪除整個課程</button>
      </div>
      <p class="muted">匯入題目會取代目前全部練習內容；已存在的組別答案中，欄位不符者將會清空。${
    hasEx ? `目前共 ${S.course.exercises.length} 個練習：${S.course.exercises.map((e2) => E(e2.title)).join('、')}` : ''
  }</p>
    </section>
    ${groupManageSection()}
    ${!hasEx || !current ? noQuestionsNotice() : `
    ${tabs()}
    <div class="toolbar projection-tools">
      <label for="exercise-select">展示題目</label>
      <select id="exercise-select">${S.course.exercises.map((t, i) => `<option value="${E(t.qid)}" ${t.qid === S.qid ? 'selected' : ''}>${exLabel(i)}｜${E(t.title)}</option>`).join('')}</select>
      <label for="group-select">組別</label>
      <select id="group-select"><option value="all">全部組別（${groupCount} 組）</option>${
    Object.entries(S.course.groups).map(([k, g]) => `<option value="${E(k)}" ${S.groupFilter === k ? 'selected' : ''}>${E(g.name)}</option>`).join('')
  }</select>
      <button id="project">${S.projection ? '退出投影' : '簡潔投影'}</button>
    </div>
    <section class="manage card" style="margin-top:24px">
      <h2>課程進度｜練習開關</h2>
      <p>未開放的練習，學員無法進入或查看。可依進度逐題開放，關閉不會刪除答案。「刪除」則會連同各組在該題的答案一起移除。</p>
      <div class="exercise-gates">${S.course.exercises.map((t, i) => `<div class="gate-row"><div><b>${exLabel(i)}｜${E(t.title)}</b><div class="muted">${
    S.course.locks[t.qid] ? '未開放' : '已開放，學員可進入'
  }${answeredCount(t.qid) ? ` · ${answeredCount(t.qid)} 組已作答` : ''}</div></div><div class="toolbar"><button type="button" role="switch" aria-checked="${!S.course.locks[t.qid]}" data-gate="${E(t.qid)}" class="${
    S.course.locks[t.qid] ? '' : 'primary'
  }">${S.course.locks[t.qid] ? '開放' : '關閉'}${exLabel(i)}</button><button type="button" class="danger" data-del-ex="${E(t.qid)}" aria-label="刪除${exLabel(i)}">刪除</button></div></div>`).join('')}</div>
      <div class="toolbar">
        <button id="export-json">匯出全部答案 JSON</button>
        <button id="export-csv">匯出全部答案 CSV</button>
        <button id="import-json">匯入答案 JSON</button>
        <input id="import-file" type="file" accept=".json,application/json" hidden>
      </div>
      <div class="toolbar" style="margin-top:18px">
        <button class="danger" id="clear">清除${S.groupFilter === 'all' ? '所有組別' : '所選組別'}本題答案</button>
        <button class="danger" id="reset">重置本場課程</button>
      </div>
    </section>
    <h1>${exLabel(n)}｜${E(current.title)}</h1>
    <p class="status-line" id="connection">答案即時同步 · 全部組別可左右捲動比較</p>
    <div id="comparison">${compare()}</div>`}`);

  document.querySelector('#dl-template').onclick = downloadTemplate;
  document.querySelector('#import-questions').onclick = () => document.querySelector('#import-questions-file').click();
  document.querySelector('#import-questions-file').onchange = importQuestionsFile;
  document.querySelector('#join-qr').onclick = openJoinQR;
  // 刪除課程放在最上層區塊並在這裡綁定：還沒匯入題目的課程也必須刪得掉。
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
  // 小組管理在「還沒有題目」的課程也要能用：綁定放在提前 return 之前。
  bindGroupManage();
  if (!hasEx || !current) return;

  bindTabs();
  document.querySelectorAll('[data-gate]').forEach((button) => {
    button.onclick = async () => {
      const qid = button.dataset.gate;
      button.disabled = true;
      try { await setLock(S.session.code, qid, !S.course.locks[qid]); } catch (e) { notify(e.message); button.disabled = false; }
    };
  });
  document.querySelectorAll('[data-del-ex]').forEach((button) => {
    button.onclick = async () => {
      const qid = button.dataset.delEx;
      const target = S.course.byQid[qid];
      if (!target) return;
      const answered = answeredCount(qid);
      const warning = answered ? `目前有 ${answered} 組在這一題已經作答，答案會一併永久刪除。\n` : '';
      if (!confirm(`確定刪除「${exLabel(exNumber(qid))}｜${target.title}」？\n\n${warning}後面的練習會自動往前遞補題號，其他練習的答案保留。此操作無法復原。`)) return;
      button.disabled = true;
      try {
        await deleteExercise(S.session.code, S.course, qid);
        if (S.qid === qid) S.qid = firstQid();
        notify(`已刪除「${target.title}」。`);
      } catch (e) {
        notify(e.message);
        button.disabled = false;
      }
    };
  });
  document.querySelector('#exercise-select').onchange = (e) => { S.qid = e.target.value; renderTeacher(); };
  document.querySelector('#group-select').onchange = (e) => { S.groupFilter = e.target.value; renderTeacher(); };
  document.querySelector('#project').onclick = () => { S.projection = !S.projection; renderTeacher(); };
  document.querySelector('#export-json').onclick = () => exportData('json');
  document.querySelector('#export-csv').onclick = () => exportData('csv');
  document.querySelector('#import-json').onclick = () => document.querySelector('#import-file').click();
  document.querySelector('#import-file').onchange = importAnswersFile;

  document.querySelector('#clear').onclick = async () => {
    if (!confirm(`確定清除${S.groupFilter === 'all' ? '所有組別' : '所選組別'}的${exLabel(exNumber(S.qid))}答案？其他練習會保留。`)) return;
    try {
      const qid = S.qid;
      const targets = Object.keys(S.course.groups).filter((k) => S.groupFilter === 'all' || k === S.groupFilter);
      const updates = {};
      targets.forEach((gid) => {
        updates[`groups/${gid}/answers/${qid}`] = '{}';
        updates[`groups/${gid}/complete/${qid}`] = false;
        updates[`groups/${gid}/updated/${qid}`] = 0;
        updates[`groups/${gid}/revision/${qid}`] = (S.course.groups[gid].revision[qid] || 0) + 1;
      });
      await update(courseRef(S.session.code), updates);
      notify('本題答案已清除。');
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
    const preview = prepared.slice(0, 12).map((g) => g.name).join('\n') + (prepared.length > 12 ? `\n…其餘 ${prepared.length - 12} 組` : '');
    const mapping = matchByQid
      ? ''
      : '這份備份沒有可對應的題目 ID（舊版備份或來自其他課程），將依題號順序對應到目前的第一題、第二題……請先確認題目順序相同。\n\n';
    if (!confirm(`匯入摘要：共 ${prepared.length} 組\n新增 ${prepared.length - replaced} 組，同名覆寫 ${replaced} 組。\n\n${preview}\n\n${mapping}同一組別名稱的答案將由備份取代；其他組別與目前題目開關保留。被取代組別需重新加入。確定匯入？`)) return;

    const updates = {};
    Object.entries(S.course.groups).forEach(([gid, g]) => { if (names.has(g.nameKey)) updates[`groups/${gid}`] = null; });
    prepared.forEach((g) => { updates[`groups/${randomId(8)}`] = g; });
    await update(courseRef(S.session.code), updates);
    S.groupFilter = 'all';
    notify(`已匯入 ${prepared.length} 組答案。`);
  } catch (e) {
    notify(e.message);
  } finally {
    event.target.value = '';
  }
}

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
              g.name, g.author, `練習${i + 1} ${exDef.title || ''}`,
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

export function openJoinQR() {
  if (S.joinOpen) return;
  // 尚未建立任何組別、又不允許學員自訂組名時，學員掃碼只會看到等待畫面。
  // 講師常常是「先投影 QR、再想到要開組」，在這裡先問一次比讓全班卡在等待畫面便宜得多。
  if (!S.course.allowStudentGroupNames && !Object.keys(S.course.groups).length) {
    if (!confirm('目前還沒有任何小組，學員掃碼後只會看到等待畫面。要繼續顯示 QR Code 嗎？（取消則回控制台新增組別）')) return;
  }
  S.joinOpen = true;
  const url = joinURL(S.session.code);
  const dialog = document.createElement('dialog');
  dialog.className = 'join-screen';
  dialog.setAttribute('aria-labelledby', 'join-title');
  dialog.innerHTML = `<div class="join-top"><strong>${E(S.course.name)}</strong><button id="close-join">返回講師控制台</button></div>
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
  const close = () => { S.joinOpen = false; dialog.close(); dialog.remove(); };
  dialog.querySelector('#close-join').onclick = close;
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  try {
    // eslint-disable-next-line no-new, no-undef
    new QRious({ element: dialog.querySelector('#qr-canvas'), value: url, size: 900, level: 'M', background: 'white', foreground: 'black' });
  } catch {
    dialog.querySelector('#qr-picture').textContent = 'QR Code 產生失敗，請改用上方代碼或網址。';
  }
}
