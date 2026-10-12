/** Store pending operations separately: concurrent tabs cannot overwrite one another's outbox. */
let dbPromise;
function database() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('iw-notebooks-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
async function transact(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', mode);
    const request = action(tx.objectStore('records'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || Error('本機儲存失敗'));
  });
}
export const cachePut = (record) => transact('readwrite', (s) => s.put(record));
export const cachePutMany = (records) => transact('readwrite', (s) => { records.forEach((r) => s.put(r)); });
export const cacheDelete = (id) => transact('readwrite', (s) => s.delete(id));
export const cacheGet = (id) => transact('readonly', (s) => s.get(id));
export async function pendingFor(key) {
  return (await transact('readonly', (s) => s.getAll())).filter((r) => r.kind === 'pending' && r.key === key);
}
