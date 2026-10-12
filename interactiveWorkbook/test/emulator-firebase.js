/** Test-only entry. Bundle with esbuild; never loaded by the production app. */
import { initializeApp } from 'firebase/app';
import { getDatabase, connectDatabaseEmulator, ref, get, set, update, remove, onValue, onChildAdded, onDisconnect, runTransaction, goOffline, goOnline } from 'firebase/database';
export { ref, get, set, update, remove, onValue, onChildAdded, onDisconnect, runTransaction };
const uid = crypto.randomUUID();
const app = initializeApp({ projectId:'demo-iw-notebook', databaseURL:'https://demo-iw-notebook-default-rtdb.firebaseio.com' });
const db = getDatabase(app);
connectDatabaseEmulator(db,'127.0.0.1',9007,{mockUserToken:{sub:uid,user_id:uid}});
export const AUTH_SLOW_MS=12000;
export const authReady=Promise.resolve({uid});
export const DB_ROOT='artifacts/interactiveWorkbook/public/data';
export const COURSES=`${DB_ROOT}/courses`;
export const courseRef=(code,sub='')=>ref(db,`${COURSES}/${code}${sub?'/'+sub:''}`);
export const liveRef=(code,sub='')=>ref(db,`${DB_ROOT}/live/${code}${sub?'/'+sub:''}`);
export const imageRef=(code,sub='')=>ref(db,`${DB_ROOT}/images/${code}${sub?'/'+sub:''}`);
export const notebookRef=(code,sub='')=>ref(db,`${DB_ROOT}/notebooks/${code}${sub?'/'+sub:''}`);
export const presenceRef=(code,sub='')=>ref(db,`${DB_ROOT}/notebookPresence/${code}${sub?'/'+sub:''}`);
export const connectedRef=()=>ref(db,'.info/connected');
const endpoint='http://127.0.0.1:9007/.json?ns=demo-iw-notebook-default-rtdb';
window.__fakedb={
  setConnected(value){if(value)goOnline(db);else goOffline(db);},
  async seed(tree){const r=await fetch(endpoint,{method:'PUT',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:JSON.stringify(tree)});if(!r.ok)throw Error(await r.text());},
  async dump(){const r=await fetch(endpoint,{headers:{Authorization:'Bearer owner'}});return r.json();},
};
