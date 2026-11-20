/**
 * 隨身閱讀 PocketReader — IndexedDB 本機離線儲存層
 */

const DB_NAME = 'pocketReader-db';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        const books = db.createObjectStore('books', { keyPath: 'id' });
        books.createIndex('updatedAt', 'updatedAt', { unique: false });
        books.createIndex('category', 'category', { unique: false });
        books.createIndex('subscriptionId', 'subscriptionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains('shares')) {
        db.createObjectStore('shares', { keyPath: 'shareId' });
      }
      if (!db.objectStoreNames.contains('subscriptions')) {
        db.createObjectStore('subscriptions', { keyPath: 'shareId' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('無法開啟 IndexedDB'));
    };
  });
  return dbPromise;
}

function txRun(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let resultValue;
        try {
          const req = fn(store);
          if (req && typeof req === 'object' && 'onsuccess' in req) {
            req.onsuccess = () => {
              resultValue = req.result;
            };
          } else {
            resultValue = req;
          }
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(resultValue);
        tx.onerror = () => reject(tx.error || new Error(`IndexedDB 交易失敗 (${storeName})`));
        tx.onabort = () => reject(tx.error || new Error(`IndexedDB 交易中止 (${storeName})`));
      })
  );
}

export async function sha256Hex(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getAllBooks({ includeDeleted = false } = {}) {
  const list = await txRun('books', 'readonly', (store) => store.getAll());
  const books = Array.isArray(list) ? list : [];
  return includeDeleted ? books : books.filter((b) => !b.deletedAt);
}

export function getBook(id) {
  return txRun('books', 'readonly', (store) => store.get(id));
}

export function putBook(book) {
  const record = {
    ...book,
    subscriptionId: book?.subscription?.shareId || '',
  };
  return txRun('books', 'readwrite', (store) => store.put(record)).then(() => record);
}

export async function softDeleteBook(id) {
  const existing = await getBook(id);
  if (!existing) return null;
  const now = Date.now();
  const updated = {
    ...existing,
    deletedAt: now,
    updatedAt: now,
  };
  return putBook(updated);
}

export function hardDeleteBook(id) {
  return txRun('books', 'readwrite', (store) => store.delete(id));
}

export function putBlob({ hash, data, mimeType = 'application/pdf', name = '' }) {
  const size = data instanceof ArrayBuffer ? data.byteLength : data?.byteLength || 0;
  return txRun('blobs', 'readwrite', (store) =>
    store.put({
      hash,
      data,
      size,
      mimeType,
      name,
      updatedAt: Date.now(),
    })
  );
}

export function getBlob(hash) {
  if (!hash) return Promise.resolve(null);
  return txRun('blobs', 'readonly', (store) => store.get(hash));
}

export function deleteBlob(hash) {
  if (!hash) return Promise.resolve();
  return txRun('blobs', 'readwrite', (store) => store.delete(hash));
}

export async function listBlobHashes() {
  const rows = await txRun('blobs', 'readonly', (store) => store.getAllKeys());
  return Array.isArray(rows) ? rows : [];
}

export async function cleanupUnusedBlobs() {
  const books = await getAllBooks({ includeDeleted: false });
  const used = new Set(books.map((b) => b.pdfBlobHash).filter(Boolean));
  const keys = await listBlobHashes();
  let removed = 0;
  for (const hash of keys) {
    if (!used.has(hash)) {
      await deleteBlob(hash);
      removed++;
    }
  }
  return removed;
}

export async function getStorageStats() {
  const [books, blobs] = await Promise.all([
    getAllBooks({ includeDeleted: false }),
    txRun('blobs', 'readonly', (store) => store.getAll()),
  ]);
  const textBytes = new Blob([JSON.stringify(books)]).size;
  const blobBytes = (blobs || []).reduce((sum, b) => sum + (b.size || 0), 0);
  return {
    bookCount: books.length,
    blobCount: (blobs || []).length,
    textBytes,
    blobBytes,
    totalBytes: textBytes + blobBytes,
  };
}

export async function getSetting(key, fallback = null) {
  const row = await txRun('settings', 'readonly', (store) => store.get(key));
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  return txRun('settings', 'readwrite', (store) => store.put({ key, value, updatedAt: Date.now() }));
}

export async function getAllShares() {
  const list = await txRun('shares', 'readonly', (store) => store.getAll());
  return Array.isArray(list) ? list : [];
}

export function putShare(record) {
  return txRun('shares', 'readwrite', (store) => store.put(record));
}

export function deleteShare(shareId) {
  return txRun('shares', 'readwrite', (store) => store.delete(shareId));
}

export async function getAllSubscriptions() {
  const list = await txRun('subscriptions', 'readonly', (store) => store.getAll());
  return Array.isArray(list) ? list : [];
}

export function putSubscription(record) {
  return txRun('subscriptions', 'readwrite', (store) => store.put(record));
}

export function deleteSubscription(shareId) {
  return txRun('subscriptions', 'readwrite', (store) => store.delete(shareId));
}
