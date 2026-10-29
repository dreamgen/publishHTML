// 瀏覽器冒煙測試：儀表板＋手機（連線，記憶體版資料庫）與離線單機流程。
// 用法：在 undercoverGame/ 執行 `python3 -m http.server 8765` 後，`node test/smoke.mjs`
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:8765/';
let db = {};
const pages = [];
const getAt = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? null : o[k]), db) ?? null;
const setAt = (p, v) => {
  const ks = p.split('/').filter(Boolean); let o = db;
  for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') { if (v === null) return; o[ks[i]] = {}; } o = o[ks[i]]; }
  if (v === null) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v));
};
const broadcast = async () => { for (const p of pages) await p.evaluate((d) => window.__fbPush && window.__fbPush(d), db).catch(() => {}); };

const FAKE = () => {
  let snap = {}; const ls = [];
  const at = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? null : o[k]), snap) ?? null;
  window.__fbPush = (d) => { snap = d; for (const l of ls) l.cb({ val: () => at(l.p), exists: () => at(l.p) != null }); };
  const R = 'artifacts/undercoverGame/public/data';
  window.__UG_FAKE_FB = {
    evRef: (ev, sub = '') => `${R}/events/${ev}${sub ? '/' + sub : ''}`,
    ref: (p) => p, connectedRef: () => '.info/connected', offsetRef: () => '.info/offset',
    get: async (p) => { snap = await window.__fbGetAll(); return { val: () => at(p), exists: () => at(p) != null }; },
    set: async (p, v) => window.__fbSet(p, v),
    update: async (p, patch) => window.__fbUpdate(p, patch),
    onValue: (p, cb) => {
      if (p === '.info/connected') { cb({ val: () => true }); return () => {}; }
      if (p === '.info/offset') { cb({ val: () => 0 }); return () => {}; }
      const l = { p, cb }; ls.push(l);
      window.__fbGetAll().then((d) => { snap = d; cb({ val: () => at(p), exists: () => at(p) != null }); });
      return () => ls.splice(ls.indexOf(l), 1);
    },
  };
};

const browser = await chromium.launch();
const mkCtx = async (viewport) => {
  const c = await browser.newContext({ viewport });
  await c.exposeFunction('__fbGetAll', () => db);
  await c.exposeFunction('__fbSet', async (p, v) => { setAt(p, v); await broadcast(); });
  await c.exposeFunction('__fbUpdate', async (p, patch) => { for (const [k, v] of Object.entries(patch)) setAt(p + '/' + k, v); await broadcast(); });
  await c.addInitScript(FAKE);
  return c;
};
const ctx = await mkCtx({ width: 1280, height: 900 });
const errors = [];
const open = async (hash, vp, c = ctx) => {
  const p = await c.newPage(); if (vp) await p.setViewportSize(vp);
  p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE + hash); pages.push(p); return p;
};
const step = (s) => console.log('•', s);
const SHOTS = process.env.SHOTS || '/tmp';
const shot = async (p, n, full = true) => { await p.evaluate(() => { const t = document.getElementById('toast'); if (t) t.innerHTML = ''; }); return p.screenshot({ path: `${SHOTS}/ug-${n}.png`, fullPage: full }); };

// 1. 儀表板建立活動
const dash = await open('#/dash');
await dash.getByRole('button', { name: '建立新活動' }).click();
await dash.getByText('活動前準備').first().waitFor();
const ev = await dash.evaluate(() => localStorage.getItem('ug.dash.ev'));
step('活動 ' + ev);
await shot(dash, '1-prep');
// 列印頁
await dash.goto(BASE + '#/print/labels'); await dash.getByText('A 套　13 張').waitFor(); await shot(dash, '2-labels');
await dash.goto(BASE + '#/print/map'); await dash.getByText('13 個角色全對照').first().waitFor(); await shot(dash, '3-map');
await dash.goto(BASE + '#/dash'); await dash.getByRole('button', { name: '梯次與組別' }).waitFor();
// 2. 梯次：12 人 → 6+6
await dash.getByRole('button', { name: '梯次與組別' }).click();
await dash.fill('input[type=number]', '12'); await dash.locator('input[type=number]').dispatchEvent('change');
await dash.getByText('分組：6＋6 人').waitFor();
await shot(dash, '3b-batch');
await dash.getByRole('button', { name: '建立本梯次' }).click();
await dash.getByText('第 1 組・6 人・A 套').waitFor();
await shot(dash, '4-join');
const batch = db.artifacts.undercoverGame.public.data.events[ev].batch;
const sets = db.artifacts.undercoverGame.public.data.events[ev].qr.sets;
const ver = db.artifacts.undercoverGame.public.data.events[ev].qr.version;
const SPY_ORDER = ['sel', 'two', 'yang', 'yes', 'face', 'lie'];
const rolesOf = (cfg) => [...cfg.good, ...(cfg.spies || SPY_ORDER.slice(0, cfg.spyCount))];
step('第 1 組 ' + JSON.stringify(rolesOf(batch.groups[1])) + '・抽法 ' + batch.groups[1].draw);

// 3. 兩支手機加入、綁定（用手動輸入代替相機）
const codeOf = (set, role) => Object.keys(sets[set]).find((c) => sets[set][c] === role);
const phones = [];
for (const g of [1, 2]) {
  const ph = await open(`?join=${ev}.1.${g}`, { width: 390, height: 844 });
  if (g === 1) { await ph.getByRole('button', { name: '確認，開始綁定座位' }).waitFor(); await shot(ph, '4b-confirm', false); }
  await ph.getByRole('button', { name: '確認，開始綁定座位' }).click({ timeout: 8000 }).catch(async (e) => { console.log(await ph.evaluate(() => location.href + ' | ' + document.body.innerText)); throw e; });
  const cfg = batch.groups[g];
  // 座位順序：依角色陣列打散
  const order = rolesOf(cfg);
  await ph.getByRole('button', { name: /號座位的信封/ }).first().click();
  for (const [k, role] of order.entries()) {
    if (g === 1 && k === 3) { await ph.locator('.scan').getByRole('button', { name: '關閉' }).click(); await ph.waitForTimeout(300); await shot(ph, '4c-bind', false); await ph.getByRole('button', { name: /號座位的信封/ }).first().click(); }
    await ph.fill('.scan input', `UG:E:${cfg.set}:${codeOf(cfg.set, role)}:v${ver}`);
    await ph.press('.scan input', 'Enter');
    await ph.waitForTimeout(150);
  }
  await ph.waitForSelector('.scan', { state: 'detached' });
  phones.push({ ph, g, order });
}
await phones[0].ph.waitForTimeout(300);
await shot(phones[0].ph, '5-phone-wait');
step('綁定完成');

// 4. 回合 1：選輪值司機、掃任務、開始、第 1 組成功、第 2 組超時
await dash.getByRole('button', { name: /輪值司機/ }).click();
await dash.getByText('任務 QR 碼・各組手機掃此載入').waitFor();
for (const { ph } of phones) {
  await ph.getByRole('button', { name: '掃不到？直接載入目前任務' }).click();
}
await dash.getByRole('button', { name: '開始回合' }).click();
const p1 = phones[0];
const seatOf = (order, role) => order.indexOf(role) + 1;
await p1.ph.locator('summary').click();
for (const role of ['sen', 'car', 'rich']) await p1.ph.getByRole('button', { name: String(seatOf(p1.order, role)), exact: true }).click();
await shot(p1.ph, '5b-settle', false);
await p1.ph.getByRole('button', { name: '判定結果' }).click();
await p1.ph.getByText('任務成功').first().waitFor();
await shot(p1.ph, '6-success');
const live1 = db.artifacts.undercoverGame.public.data.events[ev].live[1];
const L = (role) => live1.ledger[codeOf('A', role)];
if (L('sen').leave !== 23 || L('car').leave !== 2 || L('rich').leave !== 0) throw new Error('扣除錯誤 ' + JSON.stringify(live1.ledger));
step('第 1 組成功、扣除正確');

// 玩家版：開放 → 玩家 A 掃有錢人信封 → 按住看角色；玩家 B 用另一支手機掃同一信封被擋
await dash.getByRole('button', { name: '開放玩家查看' }).click();
const pctxA = await mkCtx({ width: 390, height: 844 });
const pA = await open(`?player=${ev}`, null, pctxA);
await pA.getByRole('button', { name: '掃我的信封' }).click();
await pA.fill('.scan input', `UG:E:A:${codeOf('A', 'rich')}:v${ver}`); await pA.press('.scan input', 'Enter');
await pA.getByText(`我是 ${seatOf(p1.order, 'rich')} 號`).waitFor();
if (await pA.locator('.p-reveal').isVisible()) throw new Error('未按住就顯示角色');
await shot(pA, '12-player-veil', false);
const box = await pA.locator('.p-pad').boundingBox();
await pA.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await pA.mouse.down();
await pA.waitForTimeout(150); await shot(pA, '13a-player-peek-img', false);
await pA.locator('.p-reveal').getByText('真誠大人・有錢人').waitFor();
await pA.waitForTimeout(900);
const resTxt = await pA.locator('.p-res').innerText();
if (!/特休\s*0/.test(resTxt)) throw new Error('玩家資源未同步 ' + resTxt);
await shot(pA, '13-player-peek', false);
await pA.mouse.up();
await pA.waitForTimeout(150);
if (await pA.locator('.p-reveal').isVisible()) throw new Error('放開後仍顯示角色');
step('玩家：按住顯示、放開蓋回、資源同步');
const pctxB = await mkCtx({ width: 390, height: 844 });
const pB = await open(`?player=${ev}`, null, pctxB);
await pB.getByRole('button', { name: '掃我的信封' }).click();
await pB.fill('.scan input', `UG:E:A:${codeOf('A', 'rich')}:v${ver}`); await pB.press('.scan input', 'Enter');
await pB.getByText('這個信封已在另一支手機開啟').waitFor();
await shot(pB, '14-player-locked', false);
await dash.getByText('已開啟 1 / 6').waitFor();
step('玩家：同一信封第二支手機被擋');
const pctxC = await mkCtx({ width: 390, height: 844 });
const pC = await open(`?player=${ev}`, null, pctxC);
await pC.getByRole('button', { name: '掃我的信封' }).click();
await pC.fill('.scan input', codeOf('A', 'sen').slice(2)); await pC.press('.scan input', 'Enter');
await pC.getByText(`我是 ${seatOf(p1.order, 'sen')} 號`).waitFor();
step('玩家：手動輸入 4 位數字代號可開啟');

// 編輯模式：調整玩家資源、換角色、改任務條件 → 同步並提示
await dash.getByRole('button', { name: '編輯模式' }).click();
const richSeat = seatOf(p1.order, 'rich'), twoSeat = seatOf(p1.order, 'two');
await dash.getByLabel(`${richSeat} 號存款`).first().fill('45000');
await dash.getByLabel(`${twoSeat} 號角色`).first().selectOption('yes');
await dash.getByLabel('大專夏令營power').fill('70');
await shot(dash, '16-edit');
await dash.getByRole('button', { name: '儲存並通知' }).click();
await dash.locator('.modal').getByRole('button', { name: '儲存並通知' }).click();
await dash.getByText('主持人已修正資料').waitFor({ timeout: 8000 }).catch(async (e) => { console.log('TOAST', await dash.locator('#toast').innerText(), errors); throw e; });
const evd = () => db.artifacts.undercoverGame.public.data.events[ev];
if (evd().live[1].ledger[codeOf('A', 'rich')].money !== 45000) throw new Error('資源修正未寫入');
if (evd().live[1].seats[twoSeat] !== codeOf('A', 'yes')) throw new Error('角色修正未寫入');
if (evd().overrides.missions.m2.power !== 70) throw new Error('任務條件未寫入');
await shot(dash, '17-edit-notice');
await pA.getByText('你的角色資料或資源已修正').waitFor();
await pA.getByText('任務條件已修正').waitFor();
await shot(pA, '18-player-notice', false);
await pA.getByRole('button', { name: '知道了' }).click();
const box2 = await pA.locator('.p-pad').boundingBox();
await pA.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2); await pA.mouse.down();
const res2 = await pA.locator('.p-res').innerText(); await pA.mouse.up();
if (!/45,000/.test(res2)) throw new Error('玩家未同步修正後資源 ' + res2);
await p1.ph.getByText('主持人已修正資料').waitFor();
await shot(p1.ph, '19-phone-notice', false);
await p1.ph.getByRole('button', { name: '知道了' }).click();
step('編輯模式：資源、角色、任務條件已同步並提示');
// 超時：把時間撥到 5 分鐘後
await dash.evaluate(() => { const o = Date.now; Date.now = () => o() + 6 * 60 * 1000; });
await dash.getByRole('button', { name: '確認超時' }).waitFor({ timeout: 3000 });
await shot(dash, '7-timeout');
await dash.getByRole('button', { name: '確認超時' }).click();
await phones[1].ph.getByText('任務失敗').first().waitFor();
await shot(phones[1].ph, '8-fail-time');
step('第 2 組超時');
// 角色查詢
await p1.ph.getByRole('button', { name: '掃信封查詢角色' }).click();
await p1.ph.fill('.scan input', codeOf('A', 'sen')); await p1.ph.press('.scan input', 'Enter');
await p1.ph.getByText('角色卡背面應填內容').waitFor();
await shot(p1.ph, '9-lookup');
await p1.ph.getByRole('button', { name: '卡片已校正，返回' }).click();
// 下一回合
await dash.getByRole('button', { name: '下一回合' }).click();
await p1.ph.getByText('第 2 回合').first().waitFor();
await shot(dash, '10-dash-r2');
step('進入第 2 回合');

// O／X 表決：玩家 D 持鄉愿討好（只能投 O）；助理主持人掃滿 3 人自動開始表決
const pctxD = await mkCtx({ width: 390, height: 844 });
const pD = await open(`?player=${ev}`, null, pctxD);
await pD.getByRole('button', { name: '掃我的信封' }).click();
await pD.fill('.scan input', codeOf('A', 'yes').slice(2)); await pD.press('.scan input', 'Enter');
await pD.getByText(`我是 ${twoSeat} 號`).waitFor();
await dash.getByRole('button', { name: /大專夏令營/ }).click();
await p1.ph.getByRole('button', { name: '掃不到？直接載入目前任務' }).click();
await p1.ph.locator('details').evaluate((d) => { d.open = true; });
for (const role of ['pow', 'rich', 'sen']) await p1.ph.getByRole('button', { name: String(seatOf(p1.order, role)), exact: true }).click();
await p1.ph.getByText('表決中').waitFor();
await pD.getByText('請表決').waitFor();
if (!(await pD.getByRole('button', { name: '投 X（反對）' }).isDisabled())) throw new Error('鄉愿討好應該只能投 O');
await shot(pD, '20-player-vote', false);
await pA.getByRole('button', { name: '投 O（同意）' }).click();
await pC.getByRole('button', { name: '投 X（反對）' }).click();
await pA.getByText('你已投 O').waitFor();
await dash.getByText('O 1・X 1・未投 4').waitFor();
await shot(dash, '21-dash-vote');
await pD.getByRole('button', { name: '投 O（同意）' }).click();
await dash.getByText('O 2・X 1・未投 3').waitFor();
// 沒手機的座位：助理主持人把手機輪流交給本人投票（玩家版畫面，不記名）
const longPress = async (pg, name) => { const b = await pg.getByRole('button', { name }).boundingBox(); await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await pg.mouse.down(); await pg.waitForTimeout(1200); await pg.mouse.up(); };
for (let k = 0; k < 3; k++) {
  await p1.ph.getByRole('button', { name: /^交給 \d+ 號投票$/ }).first().click();
  await p1.ph.getByText('請表決（不記名）').waitFor();
  if (k === 0) await shot(p1.ph, '23-proxy-vote', false);
  const oBtn = p1.ph.getByRole('button', { name: '投 O（同意）' });
  if (await oBtn.isDisabled()) await p1.ph.getByRole('button', { name: '投 X（反對）' }).click(); else await oBtn.click();
  await p1.ph.getByText('已投票').waitFor();
  await longPress(p1.ph, '工作人員收回（長按 1 秒）');
  await p1.ph.getByText(/不記名|表決通過/).first().waitFor();
}
await p1.ph.getByText('表決通過：隊伍出發').waitFor();
await dash.getByText('表決通過：隊伍出發').waitFor();
await pA.getByText('通過：隊伍出發').waitFor();
await p1.ph.locator('.cap-row').getByText('2 號').waitFor(); // 表決結束 → 換下一位隊長
if (await dash.locator('.vote-chip.o, .vote-chip.x').count()) throw new Error('不記名表決不應顯示每人投什麼');
await shot(p1.ph, '22-phone-vote', false);
const cls = await pA.evaluate(() => [...document.querySelectorAll('.p-res b')].map((b) => b.className));
if (cls[0] !== 'res-down' || cls[1] !== 'res-zero') throw new Error('資源顏色不對 ' + JSON.stringify(cls));
step('O／X 表決：自動開始、角色限制、統計、全部投完顯示結果；資源扣除綠色、歸零紅色');
await dash.getByRole('button', { name: '揭牌：公開所有身分' }).click();
await dash.locator('.modal').getByRole('button', { name: '揭牌' }).click();
await pA.getByText('遊戲結束・已揭牌').waitFor();
await shot(pA, '15-player-end', false);
step('玩家：揭牌後顯示身分與回顧');

const ROLE_NAME = { sen: '資深老道親', car: '有交通工具', pow: '體力怪', rich: '有錢人', nA: '一般大人 A', nB: '一般大人 B', nC: '一般大人 C', sel: '圖謀私利', yang: '陽奉陰違', face: '表面工夫', lie: '圖方便說謊', two: '口是心非', yes: '鄉愿討好' };
// 6. 自動抽角色（無實體卡片）：7 人 1 組
await dash.getByRole('button', { name: '梯次與組別' }).click();
await dash.fill('input[type=number]', '7'); await dash.locator('input[type=number]').dispatchEvent('change');
await dash.getByRole('button', { name: '自動抽角色（無實體卡片）' }).click();
await dash.getByRole('button', { name: '建立本梯次' }).click();
await dash.locator('.modal').getByRole('button', { name: '建立' }).click();
await dash.getByText('第 1 組・發角色卡').waitFor({ timeout: 5000 }).catch(async (e) => { await shot(dash, 'dbg-hand'); console.log(await dash.evaluate(() => document.body.innerText.slice(0, 1500))); throw e; });
const acfg = evd().batch.groups[1];
if (acfg.draw !== 'auto' || acfg.seatRoles.length !== 7 || !acfg.seatRoles.some((r) => ['sel', 'yang', 'face'].includes(r))) throw new Error('自動抽角色設定不對 ' + JSON.stringify(acfg));
if (Object.keys(evd().live[1].seats).length !== 7) throw new Error('座位沒有自動排好');
await shot(dash, '30-dash-hand');
const pctxH = await mkCtx({ width: 390, height: 844 });
const ph2 = await open(`?join=${ev}.${evd().batch.no}.1`, null, pctxH);
await ph2.getByRole('button', { name: '確認，開始發角色卡' }).click();
await ph2.locator('.hand').getByText('第 1 組・發角色卡').waitFor();
await shot(ph2, '35-phone-hand', false);
const pickSeat = async (pg, n) => { await pg.getByRole('button', { name: `${n} 號`, exact: true }).click(); await pg.getByRole('button', { name: `確認：我是第 1 組 ${n} 號` }).click(); };
await pA.reload(); await pA.getByText('領取我的角色卡').waitFor();
await shot(pA, '31-player-pick', false);
await pickSeat(pA, 1);
await pA.getByText('等全組入座').waitFor();
if (await pA.locator('.p-pad').count()) throw new Error('開放前不應出現角色卡');
await pC.reload(); await pC.getByText('領取我的角色卡').waitFor();
if (!(await pC.getByRole('button', { name: '1 號（已有人領）' }).isDisabled())) throw new Error('已領的座位應不能選');
await pickSeat(pC, 2);
await pC.getByText('等全組入座').waitFor();
// 用相機直接掃座位 QR（網址）開啟
const pctxE = await mkCtx({ width: 390, height: 844 });
const tok3 = evd().live[1].tokens[3];
const pE = await open(`?player=${ev}&seat=${evd().batch.no}.1.3.${tok3}`, null, pctxE);
await pE.getByText('等全組入座').waitFor();
await pE.locator('.p-me').getByText('3', { exact: true }).waitFor();
await shot(pE, '32-player-wait', false);
// 選錯改座位
await pC.getByRole('button', { name: '選錯了，改座位' }).click();
await pickSeat(pC, 4);
await pC.locator('.p-me').getByText('4', { exact: true }).waitFor();
// 舊的座位 QR 被重設後失效
await dash.getByRole('button', { name: '3 號已領取，點一下可重設' }).click();
await dash.locator('.modal').getByRole('button', { name: '重設' }).click();
await pE.getByText('領取我的角色卡').waitFor();
await pE.goto(BASE + `?player=${ev}&seat=${evd().batch.no}.1.3.${tok3}`);
await pE.getByText('已失效').first().waitFor();
await pE.goto(BASE + `?player=${ev}&seat=${evd().batch.no}.1.3.${evd().live[1].tokens[3]}`);
await pE.getByText('等全組入座').waitFor();
// 重排座位：已領的手機留在原號碼
await dash.getByRole('button', { name: '重新隨機排座位' }).click();
await dash.locator('.modal').getByRole('button', { name: '重排' }).click();
await dash.waitForTimeout(300);
await pA.locator('.p-me').getByText('1', { exact: true }).waitFor();
await dash.getByText('已領取 3 / 7').waitFor();
if (!(await dash.getByRole('button', { name: '還差 4 位・無法開放' }).isDisabled())) throw new Error('沒到齊不應能開放');
await shot(dash, '33-dash-hand-progress');
await dash.getByRole('button', { name: '強制開放' }).click();
await dash.locator('.modal').getByRole('button', { name: '強制開放' }).click();
await dash.getByText('第 1 回合：選擇任務').waitFor();
await dash.getByRole('button', { name: /輪值司機/ }).click();
await ph2.getByRole('button', { name: '掃不到？直接載入目前任務' }).click();
await ph2.getByText('本組沒有信封，直接點出任務的座位號').waitFor();
for (const n of [1, 2, 3]) await ph2.locator('.grid.g6').getByRole('button', { name: String(n), exact: true }).click();
await shot(ph2, '36-phone-auto-round', false);
await ph2.getByRole('button', { name: '查詢角色' }).click();
await ph2.getByRole('button', { name: '2', exact: true }).click();
await ph2.getByText('角色已隱藏').waitFor();
// 沒手機的玩家：交給本人看角色卡（玩家版，按住才顯示）
await ph2.getByRole('button', { name: '交給 2 號查看角色卡' }).click();
await ph2.getByText('按住查看我的角色').waitFor();
if (await ph2.locator('.p-reveal').isVisible()) throw new Error('交給玩家：未按住就顯示角色');
const bx = await ph2.locator('.p-pad').boundingBox();
await ph2.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await ph2.mouse.down();
const t2 = await ph2.locator('.p-reveal .p-title').innerText();
await ph2.waitForTimeout(1200); await shot(ph2, '37-handover-card', false);
await ph2.mouse.up();
const role2 = evd().batch.groups[1].seatRoles[1];
if (!t2.endsWith(ROLE_NAME[role2])) throw new Error(`交給玩家：2 號角色不符 ${t2}`);
const lb = await ph2.getByRole('button', { name: '工作人員收回（長按 1 秒）' }).boundingBox();
await ph2.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2); await ph2.mouse.down(); await ph2.waitForTimeout(300); await ph2.mouse.up();
if (!(await ph2.getByText('按住查看我的角色').isVisible())) throw new Error('短按不應收回');
await ph2.mouse.down(); await ph2.waitForTimeout(1200); await ph2.mouse.up();
await ph2.getByText('角色查詢').first().waitFor();
await ph2.getByRole('button', { name: '卡片已校正，返回' }).click();
// 開放後：按住看角色＝系統排在 1 號的角色
const role1 = evd().batch.groups[1].seatRoles[0];
const boxA = await pA.locator('.p-pad').boundingBox();
await pA.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2); await pA.mouse.down();
const t1 = await pA.locator('.p-reveal .p-title').innerText();
await pA.mouse.up();
if (!t1.endsWith(ROLE_NAME[role1])) throw new Error(`1 號角色不符：畫面 ${t1}，應為 ${role1}`);
// 開放後不能自選
const pctxF = await mkCtx({ width: 390, height: 844 });
const pF = await open(`?player=${ev}`, null, pctxF);
await pF.getByText('本組已開放查看，不能再自己選座位').waitFor();
await shot(pF, '34-player-after-open', false);
step('自動抽角色：自選／座位 QR 領取、搶同號被擋、改座位、重設使舊 QR 失效、重排保留座位、強制開放、角色正確、開放後不能自選');

// 5. 離線單機
const off = await open('#/offline', { width: 390, height: 844 });
await off.evaluate((m) => localStorage.setItem('ug.maps', JSON.stringify(m)), { version: ver, sets });
await off.reload();
await shot(off, '11a-offline-setup', false);
await off.getByRole('button', { name: '切換為離線並開始綁定' }).click();
const offData = await off.evaluate(() => JSON.parse(localStorage.getItem('ug.offline.v1')));
const og = offData.myGroup, oc = offData.batch.groups[og];
await off.getByRole('button', { name: /號座位的信封/ }).first().click();
for (const role of rolesOf(oc)) { await off.fill('.scan input', codeOf(oc.set, role)); await off.press('.scan input', 'Enter'); await off.waitForTimeout(80); }
await off.waitForSelector('.scan', { state: 'detached' });
await off.getByRole('button', { name: /大專夏令營/ }).click();
await off.getByRole('button', { name: '開始計時' }).click();
await off.locator('summary').click();
const ocRoles = rolesOf(oc); const spy = 'sel';
for (const role of ['pow', 'rich', spy]) await off.getByRole('button', { name: String(ocRoles.indexOf(role) + 1), exact: true }).click();
await shot(off, '11b-offline-round', false);
await off.getByRole('button', { name: '判定結果' }).click();
await off.getByText('「任務失敗，原因：金額。」').waitFor();
await off.getByText('圖謀私利拿走了隊伍的存款').waitFor();
await shot(off, '11-offline-fail');
const offL = await off.evaluate(() => JSON.parse(localStorage.getItem('ug.offline.v1')));
const lg = offL.live[og].ledger, sc = offL.live[og].seats;
const LM = (role) => lg[sc[ocRoles.indexOf(role) + 1]].money;
if (LM('sel') !== 18000 || LM('pow') !== 0 || LM('rich') !== 39000) throw new Error('圖謀私利扣款不對 ' + JSON.stringify([LM('sel'), LM('pow'), LM('rich')]));
step('離線：圖謀私利被派中 → 存款全歸他（6,000→18,000），原因「金額」');
// 第 2 回合：紙本表決否決 3 次 → 無法派人
await off.getByRole('button', { name: '下一回合：第 2 回合' }).click();
await off.getByRole('button', { name: /輪值司機/ }).click();
await off.getByRole('button', { name: '開始計時' }).click();
for (let i = 0; i < 3; i++) { await off.getByRole('button', { name: 'X 過半或平手・否決' }).click(); await off.waitForTimeout(150); }
await off.getByText('「任務失敗，原因：無法派人。」').waitFor();
await shot(off, '11c-offline-veto');
step('離線：紙本表決否決 3 次 → 原因「無法派人」，隊長每次輪替');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : '沒有頁面錯誤');
await browser.close();
