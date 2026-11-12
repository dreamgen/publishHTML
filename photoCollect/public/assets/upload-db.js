// IndexedDB 待傳佇列：存「已壓縮的 Blob＋meta＋縮圖」，斷線或關掉頁面後可續傳。
// 所有函式都吞掉錯誤（無痕模式或空間不足時 IndexedDB 可能不可用），頁面仍可正常上傳，只是沒有續傳。
const DB_NAME = 'mv-upload';
const STORE = 'queue';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const st = req.result.createObjectStore(STORE, { keyPath: 'id' });
        st.createIndex('code', 'code');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return dbp;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(STORE, mode);
      const st = tx.objectStore(STORE);
      const req = fn(st);
      let result = null;
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch (_) { resolve(null); }
  }));
}

export const queueId = (code, hash) => `${code}:${hash}`;

// rec: {code, hash, blob, thumb, meta, name, size, mime}
export function putPending(rec) {
  return run('readwrite', (st) => st.put({ ...rec, id: queueId(rec.code, rec.hash) }));
}
export function delPending(code, hash) {
  return run('readwrite', (st) => st.delete(queueId(code, hash)));
}
export async function listPending(code) {
  return (await run('readonly', (st) => st.index('code').getAll(code))) || [];
}
export async function clearPending(code) {
  const list = await listPending(code);
  for (const r of list) await run('readwrite', (st) => st.delete(r.id));
}
