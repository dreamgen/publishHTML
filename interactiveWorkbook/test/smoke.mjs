#!/usr/bin/env node
/**
 * smoke.mjs — 「互動題本」PWA 的無頭煙霧測試（S1–S8）。
 *
 * 用法：
 *   IW_SRC=/tmp/iw IW_BASE_URL=http://127.0.0.1:8791 node smoke.mjs
 * 一般透過 run.sh 執行（它會先啟動 serve.mjs 再跑這個檔案）。
 *
 * 任何一筆瀏覽器 console error 或 pageerror 都視為測試失敗（見 collectErrors）。
 */

import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE_URL = process.env.IW_BASE_URL || 'http://127.0.0.1:8791';
const COURSES_PATH = 'artifacts/interactiveWorkbook/public/data/courses';

// ──────────────────────────────────────────────────────────────────────────────
// 小工具
// ──────────────────────────────────────────────────────────────────────────────
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

let aborted = false;
async function step(name, fn) {
  if (aborted) { record(name, false, '因前一情境失敗而跳過'); return; }
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (e) {
    record(name, false, e && e.message ? e.message : String(e));
    aborted = true;
  }
}

function getAtPath(tree, p) {
  return p.split('/').filter(Boolean).reduce(
    (node, key) => (node && typeof node === 'object' ? node[key] : undefined),
    tree,
  );
}

/** 輪詢直到 selector（.first()）的 innerText 包含 text，或逾時丟錯。 */
async function waitForText(page, selector, text, timeout = 8000) {
  const loc = page.locator(selector).first();
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    try {
      last = await loc.innerText();
      if (last.includes(text)) return true;
    } catch { /* 元素可能還沒出現，或畫面正在整頁重繪 */ }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error(`逾時：選擇器「${selector}」未出現文字「${text}」（目前內容片段：${JSON.stringify(last.slice(0, 200))}）`);
}

/** 攔掉 QRious CDN：這是完整外部網域的請求，serve.mjs 那台伺服器看不到、也攔不到，
 *  只能在 Playwright 這一層攔——避免測試被外部網路可用性拖慢或搞不確定。 */
async function stubExternal(context) {
  await context.route(/qrious/i, (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `window.QRious = function (opts) {
      try {
        var c = opts && opts.element;
        if (c && c.getContext) {
          var ctx = c.getContext('2d');
          if (ctx) { ctx.fillStyle = opts.background || '#fff'; ctx.fillRect(0, 0, opts.size || 100, opts.size || 100); }
        }
      } catch (e) { /* 測試用 stub，失敗就算了 */ }
    };`,
  }));
}

function attachErrorCollectors(page, bucket, label) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.push(`[${label}] console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    bucket.push(`[${label}] pageerror: ${err && err.message ? err.message : String(err)}`);
  });
}

// 涵蓋 text/textarea/number/date/radio/checkbox/list/table 八種欄位型別的最小題本
const QUESTIONS = {
  exercises: [
    {
      title: '全欄位型別測試',
      goal: '涵蓋八種欄位型別的最小題本，供自動化測試使用。',
      fields: [
        { key: 't1', label: '文字題', type: 'text', required: true },
        { key: 'ta1', label: '多行文字題', type: 'textarea', required: true },
        { key: 'n1', label: '數字題', type: 'number', required: true },
        { key: 'd1', label: '日期題', type: 'date', required: true },
        {
          key: 'r1', label: '單選題', type: 'radio', required: true, options: ['A選項', 'B選項', 'C選項'],
        },
        {
          key: 'c1', label: '複選題', type: 'checkbox', required: true, options: ['甲', '乙', '丙'], minSelect: 1,
        },
        {
          key: 'l1', label: '清單題', type: 'list', itemType: 'text', itemLabel: '項目', minItems: 1, required: true,
        },
        {
          key: 'tb1',
          label: '表格題',
          type: 'table',
          itemLabel: '列',
          minRows: 1,
          required: true,
          columns: [
            { key: 'c1', label: '欄一', type: 'text' },
            { key: 'c2', label: '欄二', type: 'number' },
          ],
        },
      ],
    },
  ],
};

// ──────────────────────────────────────────────────────────────────────────────
// 主流程
// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch();
  const errors = [];
  const courseName = 'Playwright 測試課程';
  let courseCode = null;
  let teacherCtx;
  let studentCtx;
  let teacherPage;
  let studentPage;

  try {
    teacherCtx = await browser.newContext({ acceptDownloads: true });
    await stubExternal(teacherCtx);
    teacherPage = await teacherCtx.newPage();
    attachErrorCollectors(teacherPage, errors, 'teacher');
    teacherPage.on('dialog', (d) => d.accept());

    // ── S1 講師建課 ──────────────────────────────────────────────────────────
    await step('S1 講師建課', async () => {
      await teacherPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await teacherPage.locator('#switch-login').waitFor({ timeout: 15000 });
      await teacherPage.locator('#switch-login').click();
      await teacherPage.locator('#tab-create').click();
      await teacherPage.locator('#new-name').fill(courseName);
      await teacherPage.locator('#new-password').fill('test1234');
      await teacherPage.locator('#new-password2').fill('test1234');
      await teacherPage.locator('#create-form button[type=submit]').click();
      await teacherPage.locator('.code-display').waitFor({ timeout: 15000 });
      courseCode = (await teacherPage.locator('.code-display').innerText()).trim();
      if (!/^[A-Z0-9]{6}$/.test(courseCode)) throw Error(`加入代碼格式不正確：「${courseCode}」`);
      await teacherPage.locator('#go-console').click();
      await waitForText(teacherPage, 'main', '講師控制台');
      await waitForText(teacherPage, 'main', courseName);
      await waitForText(teacherPage, 'main', '這個課程還沒有題目');
      return `代碼=${courseCode}`;
    });

    // ── S2 匯入題目 ──────────────────────────────────────────────────────────
    await step('S2 匯入題目', async () => {
      const payload = Buffer.from(JSON.stringify(QUESTIONS), 'utf8');
      await teacherPage.locator('#import-questions-file').setInputFiles({
        name: 'questions.json', mimeType: 'application/json', buffer: payload,
      });
      await waitForText(teacherPage, '#message', '已匯入 1 個練習');
      await waitForText(teacherPage, '.manage', '目前共 1 個練習');
      await waitForText(teacherPage, 'nav.tabs', '練習一');
    });

    // ── S3 開放題目 ──────────────────────────────────────────────────────────
    await step('S3 開放題目', async () => {
      await teacherPage.locator('[data-gate]').first().click();
      await waitForText(teacherPage, '.exercise-gates', '已開放，學員可進入');
    });

    // ── S3b 講師建立小組 ────────────────────────────────────────────────────
    // 新版預設由講師預先命名小組（allowStudentGroupNames=false），
    // 學員只能從清單選；所以要先在控制台建立組別，學員才進得來。
    await step('S3b 講師建立小組', async () => {
      await teacherPage.locator('#new-group-name').fill('測試組');
      await teacherPage.locator('#add-group').click();
      await waitForText(teacherPage, '#app', '測試組');
      return '已建立「測試組」';
    });

    // ── S4 學員加入 ──────────────────────────────────────────────────────────
    await step('S4 學員加入', async () => {
      studentCtx = await browser.newContext();
      await stubExternal(studentCtx);
      studentPage = await studentCtx.newPage();
      attachErrorCollectors(studentPage, errors, 'student');
      studentPage.on('dialog', (d) => d.accept());

      await studentPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await studentPage.locator('#in-code').waitFor({ timeout: 15000 });
      await studentPage.locator('#in-code').fill(courseCode);
      await studentPage.locator('#in-code').press('Tab'); // 觸發 change/blur 查詢課程名稱
      await waitForText(studentPage, '#course-hint', courseName);
      // 組別欄位有兩種樣子：講師預先命名時是下拉選單，允許學員自訂時是自由輸入。
      const sel = studentPage.locator('#in-group-select');
      if (await sel.count()) await sel.selectOption({ label: '測試組' });
      else await studentPage.locator('#in-group').fill('測試組');
      await studentPage.locator('#in-name').fill('小美');
      await studentPage.locator('#join-form button.primary').click();
      await waitForText(studentPage, 'main', '全欄位型別測試');
      await waitForText(studentPage, '.identity', '測試組');
      await waitForText(studentPage, '.identity', '小美');
    });

    // ── S5 作答與儲存 ────────────────────────────────────────────────────────
    await step('S5 作答與儲存', async () => {
      await studentPage.locator('[data-field="t1"]').fill('同學回答文字');
      await studentPage.locator('[data-field="ta1"]').fill('多行\n測試內容');
      await studentPage.locator('[data-field="n1"]').fill('42');
      await studentPage.locator('[data-field="d1"]').fill('2026-09-14');
      await studentPage.locator('input[data-radio="r1"][value="B選項"]').check();

      await studentPage.locator('[data-list-add="l1"]').click();
      await studentPage.locator('[data-list="l1"][data-idx="0"]').fill('第一項');
      await studentPage.locator('[data-list="l1"][data-idx="1"]').fill('第二項');

      await studentPage.locator('[data-table-add="tb1"]').click();
      await studentPage.locator('[data-table="tb1"][data-col="c1"][data-idx="0"]').fill('列一欄一');
      await studentPage.locator('[data-table="tb1"][data-col="c2"][data-idx="0"]').fill('1');
      await studentPage.locator('[data-table="tb1"][data-col="c1"][data-idx="1"]').fill('列二欄一');
      await studentPage.locator('[data-table="tb1"][data-col="c2"][data-idx="1"]').fill('2');

      await studentPage.locator('[data-checkbox="c1"][data-idx="0"]').check();
      await studentPage.locator('[data-checkbox="c1"][data-idx="2"]').check();

      await studentPage.locator('#save').click();
      await waitForText(studentPage, '#save-state', '已儲存');

      await studentPage.locator('#complete').click();
      await waitForText(studentPage, '#message', '已完成並交給講師');
    });

    // ── S6 講師即時看到 ──────────────────────────────────────────────────────
    await step('S6 講師即時看到', async () => {
      // 監看階段預設是「狀態點」模式，刻意不顯示文字；要看內容得切到分享模式。
      await teacherPage.locator('[data-proj-mode="all"]').click();
      await waitForText(teacherPage, '#proj-area', '同學回答文字', 8000);
      await waitForText(teacherPage, '#proj-area', '第一項', 8000);
    });

    // ── S7 匯出 ─────────────────────────────────────────────────────────────
    await step('S7 匯出', async () => {
      const [download] = await Promise.all([
        teacherPage.waitForEvent('download'),
        teacherPage.locator('#export-json').click(),
      ]);
      const dpath = await download.path();
      const content = fs.readFileSync(dpath, 'utf8');
      const parsed = JSON.parse(content);
      const group = Object.values(parsed.groups || {}).find((g) => g.name === '測試組');
      if (!group) throw Error('匯出的 JSON 找不到「測試組」。');
      // 答案以題目穩定 ID（qid）為 key；舊備份是題號索引，兩種都接受。
      const firstKey = (parsed.questions && parsed.questions[0] && parsed.questions[0].qid) || '0';
      const first = (group.answers || {})[firstKey] || (group.answers || {})[0];
      if (!first || first.t1 !== '同學回答文字') {
        throw Error('匯出的 JSON 內容不含學員填寫的文字。找到的 key：' + Object.keys(group.answers || {}).join(','));
      }
      return `檔案=${download.suggestedFilename()}`;
    });

    // ── S8 衝突保護 ─────────────────────────────────────────────────────────
    await step('S8 衝突保護', async () => {
      // 先讓學員端進入「未儲存」狀態（S.dirty = true），
      // 這樣等一下模擬的伺服器端 revision 變動才不會被 onValue 悄悄同步蓋掉。
      await studentPage.locator('[data-field="t1"]').fill('同學回答文字 衝突測試');
      await waitForText(studentPage, '#save-state', '尚未儲存');

      const tree = await teacherPage.evaluate(() => window.__fakedb.dump());
      const courseNode = getAtPath(tree, `${COURSES_PATH}/${courseCode}`);
      if (!courseNode || !courseNode.groups) throw Error('假資料庫內找不到課程或組別資料。');
      const gid = Object.keys(courseNode.groups)[0];
      if (!gid) throw Error('假資料庫找不到任何組別，無法模擬另一台裝置的寫入。');
      // revision 以 qid 為 key（舊格式是題號索引），從 exercisesJson 取第一題的 qid。
      let firstQid = '0';
      try {
        const list = JSON.parse(courseNode.exercisesJson || '[]');
        if (list[0] && list[0].qid) firstQid = list[0].qid;
      } catch { /* 舊格式，沿用索引 */ }
      courseNode.groups[gid].revision = courseNode.groups[gid].revision || {};
      courseNode.groups[gid].revision[firstQid] = (Number(courseNode.groups[gid].revision[firstQid]) || 0) + 1;
      await teacherPage.evaluate((t) => window.__fakedb.seed(t), tree);

      await studentPage.locator('#save').click();
      await waitForText(studentPage, '#message', '其他裝置');
    });

    // ── S9 舊資料自動遷移 ────────────────────────────────────────────────────
    // 把資料庫裡的課程「降級」回舊格式（無 schemaVersion、無 qid、答案與開關用題號索引），
    // 模擬既有線上課程；重新載入講師端，答案必須完好，且應被自動遷移成 v2。
    await step('S9 舊資料自動遷移', async () => {
      const tree = await teacherPage.evaluate(() => window.__fakedb.dump());
      const node = getAtPath(tree, `${COURSES_PATH}/${courseCode}`);
      if (!node) throw Error('假資料庫找不到課程。');

      const list = JSON.parse(node.exercisesJson || '[]');
      const qids = list.map((q) => q.qid);
      if (!qids[0]) throw Error('降級前的題目沒有 qid，前面的情境可能沒跑到。');

      // 1. 題目拿掉 qid / rev / status
      node.exercisesJson = JSON.stringify(list.map(({ qid, rev, status, ...rest }) => rest));
      // 2. locks 改回題號索引
      const oldLocks = node.locks || {};
      node.locks = {};
      qids.forEach((q, i) => { node.locks[i] = oldLocks[q] !== undefined ? oldLocks[q] : true; });
      // 3. 每組的 answers/complete/updated/revision 改回題號索引
      Object.values(node.groups || {}).forEach((g) => {
        ['answers', 'complete', 'updated', 'revision'].forEach((field) => {
          const src = g[field] || {};
          const out = {};
          qids.forEach((q, i) => { if (src[q] !== undefined) out[i] = src[q]; });
          g[field] = out;
        });
      });
      // 4. 拿掉 schemaVersion
      delete node.schemaVersion;
      await teacherPage.evaluate((t) => window.__fakedb.seed(t), tree);

      // 重新載入講師端：舊格式必須讀得出答案（讀取端決定性補號 + 雙軌 fallback）
      await teacherPage.reload({ waitUntil: 'domcontentloaded' });
      await teacherPage.locator('[data-proj-mode="all"]').click();
      await waitForText(teacherPage, '#proj-area', '同學回答文字');

      // 遷移應已完成：schemaVersion 變 2、答案 key 變回 qid
      const after = await (async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const t2 = await teacherPage.evaluate(() => window.__fakedb.dump());
          const n2 = getAtPath(t2, `${COURSES_PATH}/${courseCode}`);
          if (n2 && n2.schemaVersion === 2) return n2;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 200));
        }
        throw Error('逾時：講師端載入後 schemaVersion 仍未變成 2，自動遷移沒有發生。');
      })();

      const migrated = JSON.parse(after.exercisesJson || '[]');
      if (!migrated.every((q) => q.qid)) throw Error('遷移後仍有題目沒有 qid。');
      const firstQid = migrated[0].qid;
      const g = Object.values(after.groups || {})[0];
      if (!g || !g.answers || g.answers[firstQid] === undefined) {
        throw Error('遷移後答案沒有改用 qid 當 key，找到的 key：' + Object.keys((g || {}).answers || {}).join(','));
      }
      const parsedAnswer = JSON.parse(g.answers[firstQid]);
      if (parsedAnswer.t1 !== '同學回答文字') throw Error('遷移後第一題的答案內容不對：' + JSON.stringify(parsedAnswer).slice(0, 120));

      // 幂等：再重新載入一次，資料不應再變動
      const before = JSON.stringify(after);
      await teacherPage.reload({ waitUntil: 'domcontentloaded' });
      await teacherPage.locator('[data-proj-mode="all"]').click();
      await waitForText(teacherPage, '#proj-area', '同學回答文字');
      await new Promise((r) => setTimeout(r, 800));
      const t3 = await teacherPage.evaluate(() => window.__fakedb.dump());
      const n3 = getAtPath(t3, `${COURSES_PATH}/${courseCode}`);
      if (JSON.stringify(n3) !== before) throw Error('遷移不幂等：第二次載入又改動了資料。');

      return `qid=${firstQid}，答案完好且幂等`;
    });

    // ── S10 投影五模式與狀態點 ──────────────────────────────────────────────
    await step('S10 投影五模式與狀態點', async () => {
      const seen = {};
      for (const mode of ['dots', 'single', 'group', 'compare', 'all']) {
        // eslint-disable-next-line no-await-in-loop
        await teacherPage.locator(`[data-proj-mode="${mode}"]`).click();
        // eslint-disable-next-line no-await-in-loop
        await teacherPage.locator('#proj-area').waitFor({ timeout: 5000 });
        // eslint-disable-next-line no-await-in-loop
        seen[mode] = (await teacherPage.locator('#proj-area').innerText()).replace(/\s+/g, '').length;
      }
      // 狀態點模式不應該顯示答案文字，分享模式才顯示。
      await teacherPage.locator('[data-proj-mode="dots"]').click();
      const dotsText = await teacherPage.locator('#proj-area').innerText();
      if (dotsText.includes('同學回答文字')) throw Error('狀態點模式不該顯示答案文字。');
      const dots = await teacherPage.locator('.proj-dot').count();
      if (!dots) throw Error('狀態點模式找不到任何狀態點。');
      // 綠點：學員已儲存的欄位
      const filled = await teacherPage.locator('.proj-dot.is-filled').count();
      if (!filled) throw Error('學員已作答，卻沒有任何綠點。');

      // 字級加減只改 CSS 變數，不重畫（捲動位置與 DOM 都不該被換掉）
      const before = await teacherPage.locator('#proj-area').getAttribute('style');
      await teacherPage.locator('[data-proj-scale="1"]').click();
      const after = await teacherPage.locator('#proj-area').getAttribute('style');
      if (before === after) throw Error('按字級＋之後 --proj-scale 沒有變。');

      return `各模式字數 ${JSON.stringify(seen)}，狀態點 ${dots} 顆（綠 ${filled}）`;
    });

    // ── S11 講師在頁面上編輯題目（封存／還原） ─────────────────────────────
    await step('S11 編輯題目與封存還原', async () => {
      const dbPath = `${COURSES_PATH}/${courseCode}`;
      const snapshot = async () => {
        const t = await teacherPage.evaluate(() => window.__fakedb.dump());
        return getAtPath(t, dbPath);
      };
      const activeTitles = (node) => JSON.parse(node.exercisesJson || '[]')
        .filter((q) => (q.status || 'active') === 'active').map((q) => q.title);

      // 第一題已經有學員答案（S5 存過），所以編輯必須走封存路徑。
      // 前置條件：題目還開放時不能編輯 —— 先關閉它。
      await teacherPage.locator('[data-gate]').first().click();
      await waitForText(teacherPage, '.exercise-gates', '未開放');

      const before = await snapshot();
      const firstQid = JSON.parse(before.exercisesJson)[0].qid;

      // ① 修改 → 取消，必須等同沒發生
      await teacherPage.locator(`[data-edit-ex="${firstQid}"]`).click();
      await teacherPage.locator('#ed-title').waitFor({ timeout: 8000 });
      await teacherPage.locator('#ed-title').fill('這個標題不該被存下來');
      await teacherPage.locator('[data-cancel]').click();
      await teacherPage.locator('#ed-title').waitFor({ state: 'detached', timeout: 8000 });
      await new Promise((r) => setTimeout(r, 600));
      const afterCancel = await snapshot();
      if (JSON.stringify(afterCancel) !== JSON.stringify(before)) {
        throw Error('取消修改之後課程狀態與修改前不同，「等同沒發生」沒有成立。');
      }

      // ② 修改 → 存檔：原題封存、新題接手題號、答案還在
      await teacherPage.locator(`[data-edit-ex="${firstQid}"]`).click();
      await teacherPage.locator('#ed-title').waitFor({ timeout: 8000 });
      await teacherPage.locator('#ed-title').fill('改過的第一題');
      await teacherPage.locator('[data-save]').click();
      await teacherPage.locator('#ed-title').waitFor({ state: 'detached', timeout: 8000 });
      await waitForText(teacherPage, '.exercise-gates', '改過的第一題');

      const afterEdit = await snapshot();
      const list = JSON.parse(afterEdit.exercisesJson);
      const orig = list.find((q) => q.qid === firstQid);
      if (!orig || orig.status !== 'archived') throw Error('原題沒有被封存。');
      if (orig.archiveReason !== 'edit') throw Error('封存原因不是 edit。');
      const fresh = list.find((q) => q.archivedFrom === firstQid);
      if (!fresh) throw Error('找不到從原題複製出來的新題。');
      const titles = activeTitles(afterEdit);
      if (titles[0] !== '改過的第一題') throw Error('新題沒有接下原題的題號位置：' + titles.join('／'));
      if (titles.length !== activeTitles(before).length) throw Error('封存題佔了題號，active 題數不對。');

      // 原題的答案必須原封不動還在
      const g = Object.values(afterEdit.groups || {})[0];
      if (!g.answers[firstQid]) throw Error('封存後原題的答案不見了。');
      const keptBefore = Object.values(before.groups || {})[0].answers[firstQid];
      if (g.answers[firstQid] !== keptBefore) throw Error('封存後原題的答案內容被改動了。');

      // ③ 匯出不可以含封存題的答案
      const [dl] = await Promise.all([
        teacherPage.waitForEvent('download'),
        teacherPage.locator('#export-json').click(),
      ]);
      const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
      const exportedQids = (exported.questions || []).map((q) => q.qid);
      if (exportedQids.includes(firstQid)) throw Error('匯出檔含有已封存題目。');
      const anyGroup = Object.values(exported.groups || {})[0] || {};
      if ((anyGroup.answers || {})[firstQid]) throw Error('匯出檔含有封存題的答案。');
      if (anyGroup.archives) throw Error('匯出檔含有 archives。');

      // ④ 還原：原題回來、預設關閉、標題有註記
      await teacherPage.locator(`[data-restore-ex="${firstQid}"]`).click();
      await waitForText(teacherPage, '.exercise-gates', '（修改前版本）');
      const afterRestore = await snapshot();
      const restored = JSON.parse(afterRestore.exercisesJson).find((q) => q.qid === firstQid);
      if (restored.status !== 'active') throw Error('還原後題目仍是封存狀態。');
      if (afterRestore.locks[firstQid] !== true) throw Error('還原後的題目不是關閉狀態。');
      if (!restored.title.includes('（修改前版本）')) throw Error('還原後標題沒有註記：' + restored.title);
      const g2 = Object.values(afterRestore.groups || {})[0];
      if (g2.answers[firstQid] !== keptBefore) throw Error('還原後答案對不上。');

      return `封存→還原完整，題號不受影響（active ${activeTitles(afterRestore).length} 題）`;
    });

    // ── S12 橘點：欄位被點過、但還沒儲存 ────────────────────────────────────
    // 稽核發現橘點的寫入端一度完全缺失（狀態點只剩綠與灰），所以這一項專測它。
    await step('S12 橘點（已點過未儲存）', async () => {
      // S11 之後「改過的第一題」是一份還沒有任何答案的新題，正好用來測空欄位的橘點。
      const tree0 = await teacherPage.evaluate(() => window.__fakedb.dump());
      const node0 = getAtPath(tree0, `${COURSES_PATH}/${courseCode}`);
      const fresh = JSON.parse(node0.exercisesJson)
        .find((q) => (q.status || 'active') === 'active' && q.title === '改過的第一題');
      if (!fresh) throw Error('找不到 S11 產生的「改過的第一題」。');

      // 講師開放這一題
      await teacherPage.locator(`[data-gate="${fresh.qid}"]`).click();
      await waitForText(teacherPage, '.exercise-gates', '已開放，學員可進入');

      // 學員重新載入後進入這一題（sessionStorage 記著身分）
      await studentPage.reload({ waitUntil: 'domcontentloaded' });
      await studentPage.locator(`[data-qid="${fresh.qid}"]`).waitFor({ timeout: 10000 });
      await studentPage.locator(`[data-qid="${fresh.qid}"]`).click();
      await studentPage.locator('[data-field="t1"]').waitFor({ timeout: 10000 });

      // 只 focus，不輸入、不儲存
      await studentPage.locator('[data-field="t1"]').focus();
      await new Promise((r) => setTimeout(r, 1200));

      // 遠端應該出現這個欄位的活動標記
      const tree1 = await teacherPage.evaluate(() => window.__fakedb.dump());
      const live = getAtPath(tree1, `artifacts/interactiveWorkbook/public/data/live/${courseCode}`);
      const act = ((live || {}).activity) || {};
      const gid = Object.keys(act)[0];
      if (!gid || !act[gid][fresh.qid] || !act[gid][fresh.qid].t1) {
        throw Error('focus 欄位後資料庫沒有出現活動標記，橘點的寫入端沒有生效。實際 activity：' + JSON.stringify(act));
      }

      // 講師端切到這一題的狀態點模式，應該看得到橘點、且沒有綠點（這一題還沒存過）
      await teacherPage.locator('#exercise-select').selectOption(fresh.qid);
      await teacherPage.locator('[data-proj-mode="dots"]').click();
      await teacherPage.locator('.proj-dot').first().waitFor({ timeout: 5000 });
      const deadline = Date.now() + 6000;
      let touched = 0;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        touched = await teacherPage.locator('.proj-dot.is-touched').count();
        if (touched) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!touched) throw Error('資料庫有活動標記，但講師端沒有渲染出橘點。');
      // 點的 id 是 dot-<gid>-<qid>-<欄位>，用它確認畫面真的切到了這一題
      const ids = await teacherPage.locator('.proj-dot').evaluateAll(
        (els) => els.map((el) => `${el.id}|${el.className}`),
      );
      const mine = ids.filter((x) => x.includes(`-${fresh.qid}-`));
      if (!mine.length) throw Error('狀態點不屬於這一題，畫面沒有切過去。實際：' + ids.join(' , '));
      const filled = mine.filter((x) => x.includes('is-filled'));
      if (filled.length) throw Error('這一題還沒有人儲存過，卻出現了綠點：' + filled.join(' , '));

      return `橘點 ${touched} 顆，綠點 0 顆`;
    });
  } finally {
    if (studentCtx) await studentCtx.close().catch(() => {});
    if (teacherCtx) await teacherCtx.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log('\n===== 測試總結 =====');
  results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`));
  const failedSteps = results.filter((r) => !r.ok).length;
  console.log(`共 ${results.length} 項情境，通過 ${results.length - failedSteps} 項，失敗 ${failedSteps} 項。`);

  if (errors.length) {
    console.log(`\n偵測到 ${errors.length} 筆瀏覽器 console error / pageerror（任何一筆都視為測試失敗）：`);
    errors.forEach((m) => console.log(' - ' + m));
  } else {
    console.log('未偵測到任何 console error / pageerror。');
  }

  const failed = failedSteps > 0 || errors.length > 0;
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke.mjs 執行時發生未預期的例外：', e);
  process.exit(1);
});
