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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.exposeFunction('__fbGetAll', () => db);
await ctx.exposeFunction('__fbSet', async (p, v) => { setAt(p, v); await broadcast(); });
await ctx.exposeFunction('__fbUpdate', async (p, patch) => { for (const [k, v] of Object.entries(patch)) setAt(p + '/' + k, v); await broadcast(); });
await ctx.addInitScript(FAKE);
const errors = [];
const open = async (hash, vp) => {
  const p = await ctx.newPage(); if (vp) await p.setViewportSize(vp);
  p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE + hash); pages.push(p); return p;
};
const step = (s) => console.log('•', s);
const shot = (p, n) => p.screenshot({ path: `/tmp/ug-${n}.png`, fullPage: true });

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
await dash.getByRole('button', { name: '建立本梯次' }).click();
await dash.getByText('第 1 組・6 人・A 套').waitFor();
await shot(dash, '4-join');
const batch = db.artifacts.undercoverGame.public.data.events[ev].batch;
const sets = db.artifacts.undercoverGame.public.data.events[ev].qr.sets;
const ver = db.artifacts.undercoverGame.public.data.events[ev].qr.version;
step('組別角色 ' + JSON.stringify(batch.groups[1].roles));

// 3. 兩支手機加入、綁定（用手動輸入代替相機）
const codeOf = (set, role) => Object.keys(sets[set]).find((c) => sets[set][c] === role);
const phones = [];
for (const g of [1, 2]) {
  const ph = await open(`?join=${ev}.1.${g}`, { width: 390, height: 844 });
  await ph.getByRole('button', { name: '確認，開始綁定座位' }).click({ timeout: 8000 }).catch(async (e) => { console.log(await ph.evaluate(() => location.href + ' | ' + document.body.innerText)); throw e; });
  const cfg = batch.groups[g];
  // 座位順序：依角色陣列打散
  const order = [...cfg.roles];
  await ph.getByRole('button', { name: /號座位的信封/ }).first().click();
  for (const role of order) {
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
await p1.ph.getByRole('button', { name: '判定結果' }).click();
await p1.ph.getByText('任務成功').first().waitFor();
await shot(p1.ph, '6-success');
const live1 = db.artifacts.undercoverGame.public.data.events[ev].live[1];
const L = (role) => live1.ledger[codeOf('A', role)];
if (L('sen').leave !== 23 || L('car').leave !== 2 || L('rich').leave !== 0) throw new Error('扣除錯誤 ' + JSON.stringify(live1.ledger));
step('第 1 組成功、扣除正確');
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

// 5. 離線單機
const off = await open('#/offline', { width: 390, height: 844 });
await off.evaluate((m) => localStorage.setItem('ug.maps', JSON.stringify(m)), { version: ver, sets });
await off.reload();
await off.getByRole('button', { name: '切換為離線並開始綁定' }).click();
const offData = await off.evaluate(() => JSON.parse(localStorage.getItem('ug.offline.v1')));
const og = offData.myGroup, oc = offData.batch.groups[og];
await off.getByRole('button', { name: /號座位的信封/ }).first().click();
for (const role of oc.roles) { await off.fill('.scan input', codeOf(oc.set, role)); await off.press('.scan input', 'Enter'); await off.waitForTimeout(80); }
await off.waitForSelector('.scan', { state: 'detached' });
await off.getByRole('button', { name: /大專夏令營/ }).click();
await off.getByRole('button', { name: '開始計時' }).click();
await off.locator('summary').click();
const spy = oc.roles.find((r) => ['sel', 'yang', 'face'].includes(r));
for (const role of ['pow', 'rich', spy]) await off.getByRole('button', { name: String(oc.roles.indexOf(role) + 1), exact: true }).click();
await off.getByRole('button', { name: '判定結果' }).click();
await off.getByText('「任務失敗，原因：人。」').waitFor();
await shot(off, '11-offline-fail');
step('離線：破壞型被派中 → 原因「人」');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : '沒有頁面錯誤');
await browser.close();
