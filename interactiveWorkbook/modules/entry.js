import { S } from './state.js';
import { shell } from './ui.js';
import {
  LS, loadJSON, saveJSON, rememberCourse, forgetCourse,
} from './storage.js';
import {
  listGroups, joinGroup, verifyTeacher, createCourse,
} from './data.js';
import { normalizeGroupName } from './schema.js';
import { onValue, courseRef } from './firebase.js';
import { startSession, urlCode } from './session.js';
import { notify, CODE_LENGTH, E } from './util.js';
import { downloadTemplate } from './teacher.js';

// ──────────────────────────────────────────────────────────────────────────────
// 6. 入口畫面（學員 / 講師）
// ──────────────────────────────────────────────────────────────────────────────
export function renderEntry(view = 'student', prefill = {}) {
  S.session = null; S.course = null;
  if (view === 'student') return renderStudentEntry(prefill);
  return renderTeacherEntry(prefill);
}

/**
 * 入口畫面的即時訂閱（等待講師建立小組時用）。
 * 這裡還沒有 session，所以不能借用 S.unwatch；用模組內的變數自己管，
 * 每次重畫入口畫面都先取消，避免留下背景訂閱。
 */
let entryWatch = null;
function stopEntryWatch() {
  if (entryWatch) { entryWatch(); entryWatch = null; }
}

/** 加入前的確認訊息：講清楚「這是加入既有的組」以及後果 */
function joinExistingMessage(group) {
  return `這會加入現有的「${group.name}」${
    group.author ? `（目前填表人：${group.author}）` : '（目前還沒有人加入這一組）'
  }。同一組共用一份答案，你填的內容同組的人都看得到。確定嗎？`;
}

/**
 * 等待畫面：課程不允許學員自訂組名、而講師又還沒建立任何小組。
 * 沿用「尚未匯入題目」的等待畫面樣式，並以 onValue 即時更新——
 * 講師一建立組別，學員的畫面就會自己接上，不必請全班重新整理。
 */
export function renderJoinWaiting(code, courseName) {
  stopEntryWatch();
  shell(`<div class="login"><section class="card waiting">
      <div class="eyebrow">尚未建立小組</div>
      <h1>講師尚未建立小組，請稍候</h1>
      <p>這場課程的組別由講師預先建立。講師一建立組別，這個畫面就會自己更新，你不需要重新整理。</p>
      <p class="muted">課程：${E(courseName || '')}　加入代碼：${E(code)}</p>
      <div class="toolbar"><button id="waiting-back" class="link">← 回上一步，改用其他加入代碼</button></div>
    </section></div>`, { subtitle: courseName || '線上小組練習' });
  document.querySelector('#waiting-back').onclick = () => {
    stopEntryWatch();
    renderStudentEntry({ code, skipLookup: true });
  };
  entryWatch = onValue(courseRef(code), (snap) => {
    const raw = snap.exists() ? snap.val() : null;
    if (!raw) {
      stopEntryWatch();
      notify('這個課程已被刪除，請向講師確認加入代碼。');
      renderStudentEntry({ code, skipLookup: true });
      return;
    }
    const hasGroups = Object.keys(raw.groups || {}).length > 0;
    const allowNames = raw.allowStudentGroupNames !== false;
    if (!hasGroups && !allowNames) return; // 還是沒有組別，繼續等
    stopEntryWatch();
    renderStudentEntry({ code });
  }, (err) => {
    notify('連線中斷：' + err.message);
  });
}

export function renderStudentEntry(prefill = {}) {
  stopEntryWatch();
  const last = loadJSON(LS.LAST, {}) || {};
  const code = prefill.code || urlCode || last.code || '';
  // courseInfo 是最近一次查詢的結果：{ code, courseName, allowStudentGroupNames, groups:[{gid,name,nameKey,author}] }
  let courseInfo = null;

  shell(`<div class="login">
      <div class="eyebrow">互動題本 · 線上小組練習</div>
      <h1>輸入加入代碼，開始作答</h1>
      <p>請輸入講師提供的六碼加入代碼（或直接掃描講師投影的 QR Code）。</p>
      <form id="join-form" class="card">
        <label for="in-code">加入代碼</label>
        <input id="in-code" class="code-input" required maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="ABC123" value="${E(code)}">
        <p id="course-hint" class="muted">輸入代碼後會顯示課程名稱。</p>
        <div id="group-picker"></div>
        <label for="in-name">姓名</label>
        <input id="in-name" required maxlength="100" autocomplete="name" placeholder="填表人姓名" value="${E(last.name || '')}">
        <p class="muted">同一課程的相同組別會共用一份答案，每組請指定一位填表人操作。</p>
        <button class="primary" type="submit">進入小組練習</button>
      </form>
      <button id="switch-login" class="link">我是講師 →</button>
    </div>`, { subtitle: '線上小組練習' });

  const codeInput = document.querySelector('#in-code');
  const hint = document.querySelector('#course-hint');
  const picker = document.querySelector('#group-picker');

  /**
   * 組別欄位有兩種樣子：
   * - 講師預先命名（allowStudentGroupNames === false）→ 下拉選單，只能選現有小組。
   * - 允許學員自訂（true，也是舊課程的預設）→ 沿用原本的自由輸入 + datalist。
   * 還沒查到課程時先給自由輸入，避免代碼還沒打完畫面就空一塊。
   */
  function renderPicker() {
    const groups = courseInfo ? courseInfo.groups : [];
    if (courseInfo && !courseInfo.allowStudentGroupNames) {
      picker.innerHTML = `<label for="in-group-select">組別</label>
        <select id="in-group-select" required>
          <option value="">請選擇你們這一組</option>
          ${groups.map((g) => `<option value="${E(g.gid)}" ${g.nameKey === normalizeGroupName(last.group || '') ? 'selected' : ''}>${E(g.name)}</option>`).join('')}
        </select>
        <p class="muted">這場課程的組別由講師建立，請從清單中選擇。找不到你們這一組時，請告訴講師。</p>`;
      return;
    }
    picker.innerHTML = `<label for="in-group">組別</label>
      <input id="in-group" list="dl-groups" required maxlength="100" placeholder="例如：第 1 組（沒有就直接新增）" value="${E(last.group || '')}">
      <datalist id="dl-groups">${groups.map((g) => `<option value="${E(g.name)}">`).join('')}</datalist>`;
  }
  renderPicker();

  const lookup = async () => {
    const value = codeInput.value.trim().toUpperCase();
    codeInput.value = value;
    if (value.length !== CODE_LENGTH) {
      courseInfo = null;
      hint.textContent = '輸入代碼後會顯示課程名稱。';
      renderPicker();
      return;
    }
    hint.textContent = '查詢中…';
    try {
      const info = await listGroups(value);
      if (!info) {
        courseInfo = null;
        hint.textContent = '找不到這個代碼，請再確認一次。';
        renderPicker();
        return;
      }
      hint.textContent = `課程：${info.courseName}`;
      courseInfo = { code: value, ...info };
      if (!info.allowStudentGroupNames && !info.groups.length) {
        renderJoinWaiting(value, info.courseName);
        return;
      }
      renderPicker();
    } catch (e) { hint.textContent = '查詢失敗：' + e.message; }
  };
  codeInput.addEventListener('change', lookup);
  codeInput.addEventListener('blur', lookup);
  if (code.length === CODE_LENGTH && !prefill.skipLookup) lookup();

  document.querySelector('#switch-login').onclick = () => renderEntry('teacher');
  document.querySelector('#join-form').onsubmit = async (e) => {
    e.preventDefault();
    if (S.busy) return;
    S.busy = true;
    try {
      const code2 = codeInput.value.trim().toUpperCase();
      const author = document.querySelector('#in-name').value.trim();
      if (code2.length !== CODE_LENGTH) throw Error('加入代碼是六個英數字。');
      if (!author) throw Error('請填寫姓名。');
      // 送出當下再查一次：從打開畫面到按下送出之間，講師可能剛建立或刪除了組別。
      const info = await listGroups(code2);
      if (!info) throw Error('找不到這個加入代碼，請確認講師提供的代碼。');
      courseInfo = { code: code2, ...info };
      if (!info.allowStudentGroupNames && !info.groups.length) {
        renderJoinWaiting(code2, info.courseName);
        return;
      }

      // 先問清楚是「加入現有小組」還是「新增小組」，確認之後才寫入。
      // 使用者按取消就直接回到表單，這裡之前沒有做過任何寫入，不會留下半筆資料。
      let target = null;
      let displayName = '';
      const select = document.querySelector('#in-group-select');
      if (select) {
        const hit = info.groups.find((g) => g.gid === select.value);
        if (!hit) throw Error('請先從清單中選擇你們這一組。');
        if (!confirm(joinExistingMessage(hit))) return;
        target = { gid: hit.gid };
        displayName = hit.name;
      } else {
        const typed = document.querySelector('#in-group').value.trim();
        if (!typed) throw Error('請填寫組別。');
        const hit = info.groups.find((g) => g.nameKey === normalizeGroupName(typed));
        if (hit) {
          if (!confirm(joinExistingMessage(hit))) return;
          target = { gid: hit.gid };
          displayName = hit.name;
        } else {
          if (!info.allowStudentGroupNames) {
            throw Error('這場課程的組別由講師預先建立，找不到你輸入的這一組。請重新整理後從清單中選擇，或請講師新增這一組。');
          }
          if (!confirm(`找不到「${typed}」，要新增一個小組嗎？新增之後其他組員也會在清單上看到這一組，並和你共用同一份答案。`)) return;
          target = { name: typed };
          displayName = typed;
        }
      }

      const { gid, name } = await joinGroup(code2, target, author);
      saveJSON(LS.LAST, { code: code2, group: displayName, name: author });
      startSession({
        role: 'student', code: code2, gid, courseName: name, author,
      });
    } catch (err) { notify(err.message); } finally { S.busy = false; }
  };
}

export function renderTeacherEntry(prefill = {}) {
  stopEntryWatch();
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
      if (S.busy) return;
      S.busy = true;
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
      } finally { S.busy = false; }
    };
  }

  const createForm = document.querySelector('#create-form');
  if (createForm) {
    createForm.onsubmit = async (e) => {
      e.preventDefault();
      if (S.busy) return;
      S.busy = true;
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
      } finally { S.busy = false; }
    };
  }
}

export function renderCourseCreated(code, name) {
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
