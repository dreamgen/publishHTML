import assert from 'node:assert/strict';
const { chromium } = await import(process.env.IW_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.IW_CHROMIUM });
const base = process.env.IW_BASE_URL || 'http://127.0.0.1:8793';
const errors = [], pages = [];
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, message) {
  for (let i = 0; i < 80; i++) { if (await fn()) return; await pause(100); }
  throw Error(message);
}
const rows = (p) => p.locator('.nb-paragraph');
async function contents(p) {
  return p.evaluate(async () => {
    const { S } = await import('/modules/state.js');
    const { paragraphs } = await import('/modules/notebook-model.js');
    return paragraphs(S.notebook.controller.doc).map(({ id, value }) => ({ id, text: value.get('text').toString(), scope: value.get('scope') }));
  });
}
async function synced(p) { await wait(async () => (await p.locator('#nb-status').innerText()) === '已同步', 'not synced: ' + await p.locator('#nb-status').innerText()); }
async function add(p, filter, text) {
  await p.selectOption('#nb-filter', filter); await p.click('#nb-add');
  await rows(p).last().locator('.cm-content').fill(text); await synced(p);
}
async function act(p, method, ...args) {
  return p.evaluate(async ({ method, args }) => {
    const { S } = await import('/modules/state.js');
    const model = await import('/modules/notebook-model.js');
    return model[method](S.notebook.controller.doc, ...args);
  }, { method, args });
}
try {
  for (const name of ['小明', '小華', '小美', '別組']) {
    const context = await browser.newContext();
    await context.route(/qrious/i, (r) => r.fulfill({ body: 'window.QRious=function(){}', contentType: 'text/javascript' }));
    const p = await context.newPage(); pages.push(p);
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(base); await p.waitForFunction(() => window.__iwBooted);
  }
  const [a,b,c,d] = pages;
  const course = { name: '記事本測試', schemaVersion: 2, createdAt: Date.now(),
    exercisesJson: JSON.stringify([{ qid:'q1', title:'第一個主題', fields:[{key:'answer',type:'textarea',label:'正式答案'}],status:'active'}, {qid:'q2',title:'第二個主題',fields:[],status:'active'}]),
    locks: {q1:false,q2:false}, groups: {g1:{name:'第一組',nameKey:'第一組'},g2:{name:'第二組',nameKey:'第二組'}} };
  await a.evaluate((course) => window.__fakedb.seed({artifacts:{interactiveWorkbook:{public:{data:{courses:{NOTE01:course}}}}}}), course);
  for (let i=0;i<pages.length;i++) {
    await pages[i].evaluate(async ({gid,name}) => {
      const {startSession}=await import('/modules/session.js'); startSession({role:'student',code:'NOTE01',gid,author:name,courseName:'記事本測試'});
    }, {gid:i===3?'g2':'g1',name:['小明','小華','小美','別組'][i]});
    await pages[i].click('#open-notebook'); await synced(pages[i]);
  }
  await add(a,'q2','第二題討論');
  await wait(async()=> (await contents(b)).length===1,'paragraph not synchronized');
  assert.equal((await contents(b))[0].scope.qid,'q2');
  await b.selectOption('#nb-filter','q1'); await pause(); assert.equal(await rows(b).count(),0);
  await c.selectOption('#nb-filter','q2'); await wait(async()=>await rows(c).count()===1,'filter missing');
  assert.equal(await rows(d).count(),0);
  console.log('PASS N1 paragraph scope, independent filters and groups');

  await b.selectOption('#nb-filter','q2');
  await Promise.all([a,b,c].map((p)=>p.evaluate(()=>window.__fakedb.setConnected(false))));
  await Promise.all([a,b,c].map((p,i)=>p.evaluate(async (letter)=>{
    const {S}=await import('/modules/state.js'); const {paragraphs,LOCAL}=await import('/modules/notebook-model.js');
    const text=paragraphs(S.notebook.controller.doc)[0].value.get('text');
    S.notebook.controller.doc.transact(()=>text.insert(0,letter),LOCAL);
  },['甲','乙','丙'][i])));
  await Promise.all([a,b,c].map((p)=>p.evaluate(()=>window.__fakedb.setConnected(true))));
  await Promise.all([a,b,c].map(synced));
  await wait(async()=>JSON.stringify(await contents(a))===JSON.stringify(await contents(b))&&JSON.stringify(await contents(a))===JSON.stringify(await contents(c)),'concurrent documents diverged');
  const combined=(await contents(a))[0].text; for(const letter of ['甲','乙','丙']) assert.ok(combined.includes(letter));
  console.log('PASS N2 three simultaneous same-position edits converge');

  const id=(await contents(a))[0].id;
  await a.locator('.nb-more-btn').first().click();
  await a.locator('.nb-paragraph select').selectOption(''); await synced(a);
  await a.click('#nb-filter'); await wait(async()=>await rows(a).count()===0,'moved paragraph remained');
  await b.selectOption('#nb-filter',''); await wait(async()=>await rows(b).count()===1,'global paragraph missing');
  assert.equal((await contents(b))[0].text,combined);
  await add(a,'*','全局內容');
  assert.equal((await contents(a)).at(-1).scope.qid,null);
  console.log('PASS N3 moving to global preserves text; all-view defaults global');

  await a.selectOption('#nb-filter','q1'); await a.click('#nb-add');
  await rows(a).last().locator('.cm-content').fill('甲乙');
  await a.keyboard.press('End'); await a.keyboard.press('Enter');
  await wait(async()=>await rows(a).count()===2,'Enter did not create paragraph');
  await a.keyboard.insertText('新段'); await a.keyboard.press('Shift+Enter'); await a.keyboard.insertText('同段');
  await synced(a); assert.equal((await contents(a)).at(-1).text,'新段\n同段'); assert.equal((await contents(a)).at(-1).scope.qid,'q1');
  console.log('PASS N4 paragraph split and within-paragraph newline');

  await b.selectOption('#nb-filter','q1'); await wait(async()=>await rows(b).count()===2,'paragraph not replicated');
  await rows(b).last().locator('.cm-content').click();
  const last=(await contents(a)).at(-1).id;
  await act(a,'setScope',last,{qid:'q2',label:'第二個主題'}); await synced(a);
  await wait(async()=>await b.locator('.nb-moved').last().innerText().then(t=>t.includes('結束編輯')),'active paragraph vanished');
  await b.keyboard.insertText('繼續'); await synced(b);
  await b.click('#nb-filter'); await wait(async()=>await rows(b).count()===1,'blur did not apply filter');
  assert.ok((await contents(a)).at(-1).text.includes('繼續'));
  console.log('PASS N5 remote reassignment does not destroy active editor');

  const before=JSON.stringify(await contents(a));
  await a.evaluate(()=>window.__fakedb.setConnected(false));
  await act(a,'addParagraph',{qid:null,label:'全局'},null,'離線保留');
  await pause(300); await a.reload(); await a.click('#open-notebook'); await synced(a);
  assert.ok((await contents(a)).some(p=>p.text==='離線保留'));
  console.log('PASS N6 durable outbox survives reload');

  await a.evaluate(async()=>{const {S}=await import('/modules/state.js');await S.notebook.controller.retry();await S.notebook.controller.replace();});
  await wait(async()=> (await contents(a)).length===0 && (await contents(b)).length===0,'clear did not replace generation');
  await a.evaluate(async()=>{const {S}=await import('/modules/state.js');await S.notebook.controller.replace(true);});
  await wait(async()=> (await contents(a)).some(p=>p.text==='離線保留'),'restore missing');
  assert.ok((await contents(a)).some(p=>p.scope.qid==='q2'));
  console.log('PASS N7 atomic clear/restore retains paragraph scopes');

  await a.selectOption('#nb-filter','*');
  await a.setViewportSize({width:390,height:844});
  assert.ok((await a.locator('#notebook-panel').boundingBox()).width<=390);
  assert.equal(await a.locator('#app').evaluate(el=>el.inert),true);
  await a.screenshot({path:'/tmp/iw-notebook-mobile.png'});
  await a.setViewportSize({width:1440,height:900});
  await wait(async()=>!(await a.locator('#app').evaluate(el=>el.inert)),'desktop background remained inert');
  assert.ok((await a.locator('#save').boundingBox()).x + (await a.locator('#save').boundingBox()).width <= (await a.locator('#notebook-panel').boundingBox()).x);
  await a.screenshot({path:'/tmp/iw-notebook-desktop.png'});
  console.log('PASS N8 responsive mobile and desktop panel');

  // Group merge includes notebooks even though formal answers are still single-editor.
  await add(d,'q1','第二組獨有內容');
  await synced(d);
  await a.evaluate(async()=>{const {mergeGroups}=await import('/modules/data.js');await mergeGroups('NOTE01','g1','g2',{},'合併組');});
  await wait(async()=> (await contents(a)).some(p=>p.text==='第二組獨有內容'),'merge lost source notes');
  assert.ok((await contents(a)).find(p=>p.text==='第二組獨有內容').scope.qid==='q1');
  console.log('PASS N9 merging groups preserves both notebooks and scopes');

  // A disconnected editor must never replay old operations into a cleared generation.
  await Promise.all([a,b,c].map(synced));
  await c.evaluate(()=>window.__fakedb.setConnected(false));
  await act(c,'addParagraph',{qid:'q1',label:'第一題'},null,'清空時離線的重要文字');
  await pause(300);
  await a.evaluate(async()=>{const {S}=await import('/modules/state.js');await S.notebook.controller.replace();});
  await wait(async()=> (await contents(a)).length===0,'second clear failed');
  await c.evaluate(()=>window.__fakedb.setConnected(true));
  await wait(async()=>await c.evaluate(async()=>{const {S}=await import('/modules/state.js');return S.notebook.controller.recovery.includes('清空時離線的重要文字');}),'old generation recovery missing');
  await pause(500); assert.equal((await contents(a)).length,0);
  await c.reload(); await c.click('#open-notebook'); await synced(c);
  await wait(async()=>await c.evaluate(async()=>{const {S}=await import('/modules/state.js');return S.notebook.controller.recovery.includes('清空時離線的重要文字');}),'recovery did not survive second reload');
  console.log('PASS N10 stale offline changes fenced and recoverable across reload');

  await add(a,'q1','中文輸入測試');
  await b.selectOption('#nb-filter','q1'); await wait(async()=>await rows(b).count()===1,'IME paragraph missing');
  const editor=rows(b).first().locator('.cm-content'); await editor.click();
  await editor.dispatchEvent('compositionstart',{data:''});
  const para=(await contents(a))[0].id;
  await act(a,'setScope',para,{qid:'q2',label:'第二題'}); await synced(a);
  await editor.dispatchEvent('compositionend',{data:'組字'});
  await b.keyboard.insertText('組字'); await synced(b);
  await wait(async()=> (await contents(a))[0].text.includes('組字'),'composition input lost');
  console.log('PASS N11 composition events survive remote scope change');

  await a.selectOption('#nb-filter','q2');
  await a.evaluate(async()=>{const {courseRef,update}=await import('/modules/firebase.js');await update(courseRef('NOTE01'),{exercisesJson:JSON.stringify([{qid:'q1',title:'更名後題目',fields:[],status:'active'}])});});
  await wait(async()=> (await a.locator('#nb-filter').innerText()).includes('已移除'),'removed question label missing');
  assert.equal((await contents(a))[0].scope.qid,'q2');
  assert.equal(await a.locator('#nb-add').isDisabled(),true);
  console.log('PASS N12 deleted question keeps its notes without reassigning to another question');

  await a.evaluate(async()=>{const {deleteGroup}=await import('/modules/data.js');await deleteGroup('NOTE01','g1');});
  await wait(async()=>await a.locator('#notebook-panel').count()===0,'notebook survives deleted group');
  const data=await a.evaluate(()=>window.__fakedb.dump());
  assert.equal(data.artifacts.interactiveWorkbook.public.data.notebooks?.NOTE01?.g1,undefined);
  console.log('PASS N13 deleting group removes notebook and panel');

  await d.evaluate(async()=>{
    const {set,courseRef}=await import('/modules/firebase.js');
    await set(courseRef('EMPTY1'),{name:'無題目課程',schemaVersion:2,exercisesJson:'[]',groups:{g3:{name:'第三組'}}});
    const {startSession}=await import('/modules/session.js');
    startSession({role:'student',code:'EMPTY1',gid:'g3',author:'測試',courseName:'無題目課程'});
  });
  await d.click('#open-notebook'); await synced(d);
  await add(d,'','沒有題目也可記錄');
  assert.equal((await contents(d))[0].scope.qid,null);
  assert.equal(await d.locator('#nb-filter option').count(),2);
  console.log('PASS N14 notebook available before questions exist');

  assert.deepEqual(errors,[]);
  console.log('PASS no browser errors');
} finally { await browser.close(); }
