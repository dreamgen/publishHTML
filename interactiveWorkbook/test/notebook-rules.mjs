import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFile } from 'node:fs/promises';
import { ref, set, get, update } from 'firebase/database';
const rules=await readFile(new URL('../database.rules.json', import.meta.url),'utf8');
const env=await initializeTestEnvironment({projectId:'demo-iw-notebook',database:{host:'127.0.0.1',port:9007,rules}});
const db=env.authenticatedContext('member').database();
const root='artifacts/interactiveWorkbook/public/data';
const base=`${root}/notebooks/RULE01/g1`;
const gen='a'.repeat(32), newer='b'.repeat(32);
try{
 await env.withSecurityRulesDisabled(async c=>{await set(ref(c.database(),`${root}/courses/RULE01`),{name:'rules',groups:{g1:{name:'G'}}});});
 await assertSucceeds(set(ref(db,base),{meta:{generation:gen,state:'ready',schemaVersion:1},base:'AAA='}));
 await assertSucceeds(set(ref(db,`${base}/updates/op1`),{generation:gen,payload:'AA=='}));
 await assertFails(set(ref(env.unauthenticatedContext().database(),`${base}/updates/noauth`),{generation:gen,payload:'AA=='}));
 await assertFails(set(ref(db,`${base}/updates/stale`),{generation:newer,payload:'AA=='}));
 await assertFails(set(ref(db,`${base}/updates/large`),{generation:gen,payload:'x'.repeat(700001)}));
 await assertFails(set(ref(db,`${base}/updates/bad`),{generation:gen,payload:'AA==',extra:'bad'}));
 await assertSucceeds(update(ref(db,`${base}/meta`),{state:'frozen'}));
 await assertFails(set(ref(db,`${base}/updates/frozen`),{generation:gen,payload:'AA=='}));
 await assertSucceeds(set(ref(db,base),{meta:{generation:newer,state:'ready',schemaVersion:1},base:'AAA=',recovery:{payload:'AAA=',savedAt:1}}));
 await assertFails(set(ref(db,`${base}/updates/old`),{generation:gen,payload:'AA=='}));
 await assertSucceeds(set(ref(db,`${base}/updates/current`),{generation:newer,payload:'AA=='}));
 await set(ref(db,`${root}/courses/RULE01/groups/g1`),null);
 await assertFails(set(ref(db,`${base}/updates/deleted`),{generation:newer,payload:'AA=='}));
 await assertSucceeds(set(ref(db,base),null));
 console.log('PASS rules: authorized writes; anonymous denial; malformed/oversized denial; freeze; generation fence; deletion fence; cleanup');
}finally{await env.cleanup();}
