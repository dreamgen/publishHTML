/**
 * 隨身閱讀 PocketReader — 雲端雙向同步、分享訂閱與本機備份引擎
 */

import {
  getAllBooks,
  getBook,
  putBook,
  getBlob,
  putBlob,
  getAllShares,
  putShare,
  getAllSubscriptions,
  putSubscription,
  getSetting,
  setSetting,
} from './db.js';
import { mergeBooks, normalizeBookForSync } from './textEngine.js';

export function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export function generateVaultCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const pick = (i) => chars[bytes[i] % chars.length];
  return `PR-${pick(0)}${pick(1)}${pick(2)}-${pick(3)}${pick(4)}${pick(5)}`;
}

export function generatePassphrase() {
  const chars = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export async function deriveVaultToken(vaultCode, passphrase) {
  const cleanCode = String(vaultCode || '').trim();
  const cleanPass = String(passphrase || '');
  if (cleanCode.length < 3) throw new Error('同步碼至少需要 3 個字元');
  if (cleanPass.length < 4) throw new Error('同步密碼至少需要 4 個字元');

  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(cleanPass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(`pocket-reader-vault:${cleanCode}`),
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(25000),
  });
  let body = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    body = await res.json().catch(() => null);
  }
  if (!res.ok) {
    throw new Error(body?.error || `伺服器回應錯誤 (${res.status})`);
  }
  return body;
}

export async function testWorkerConnection(workerUrl) {
  const base = cleanBaseUrl(workerUrl);
  if (!base) throw new Error('請先輸入 Worker 網址');
  const data = await apiJson(`${base}/api/health`);
  if (!data?.ok) throw new Error('Worker 健康檢查未通過');
  return data;
}

export async function syncVault({ workerUrl, vaultCode, passphrase, syncPdfBlobs = true, onProgress } = {}) {
  const base = cleanBaseUrl(workerUrl);
  if (!base) throw new Error('請先設定 Cloudflare Worker 網址');
  const code = String(vaultCode || '').trim();
  const token = await deriveVaultToken(code, passphrase);
  const authHeaders = {
    'X-Vault-Code': code,
    'X-Vault-Token': token,
  };

  onProgress?.('驗證雲端同步空間…');
  await apiJson(`${base}/api/vault/init`, {
    method: 'POST',
    headers: authHeaders,
  });

  onProgress?.('讀取雲端書庫索引…');
  const remoteManifest = (await apiJson(`${base}/api/vault/manifest`, { headers: authHeaders })) || {
    version: 1,
    updatedAt: 0,
    books: {},
    categories: [],
  };
  const remoteEntries = remoteManifest.books || {};

  const localBooks = await getAllBooks({ includeDeleted: true });
  const localMap = new Map(localBooks.map((b) => [b.id, normalizeBookForSync(b)]));
  const allIds = new Set([...localMap.keys(), ...Object.keys(remoteEntries)]);

  let pulled = 0;
  let pushed = 0;
  let blobsUploaded = 0;
  let blobsDownloaded = 0;
  const finalBooks = new Map();

  for (const id of allIds) {
    const local = localMap.get(id) || null;
    const remoteMeta = remoteEntries[id] || null;

    let merged = local;
    const needPull =
      remoteMeta &&
      (!local ||
        Number(remoteMeta.updatedAt || 0) > Number(local.updatedAt || 0) ||
        Number(remoteMeta.contentUpdatedAt || 0) > Number(local.contentUpdatedAt || 0) ||
        (remoteMeta.deletedAt || 0) > (local.deletedAt || 0));

    if (needPull) {
      onProgress?.(`下載更新：${remoteMeta.title || local?.title || id}`);
      try {
        const remoteBook = await apiJson(`${base}/api/vault/books/${encodeURIComponent(id)}`, {
          headers: authHeaders,
        });
        merged = mergeBooks(local, remoteBook);
        await putBook(merged);
        pulled++;
      } catch (err) {
        if (!local) throw err;
      }
    }

    if (!merged) continue;
    finalBooks.set(id, merged);

    const needPush =
      !remoteMeta ||
      Number(merged.updatedAt || 0) > Number(remoteMeta.updatedAt || 0) ||
      Number(merged.contentUpdatedAt || 0) > Number(remoteMeta.contentUpdatedAt || 0) ||
      Number(merged.deletedAt || 0) !== Number(remoteMeta.deletedAt || 0);

    if (needPush) {
      onProgress?.(`上傳變更：${merged.title}`);
      await apiJson(`${base}/api/vault/books/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });
      pushed++;
    }

    // Sync PDF original blobs if enabled
    if (syncPdfBlobs && merged.pdfBlobHash && !merged.deletedAt) {
      const hash = merged.pdfBlobHash;
      const localBlob = await getBlob(hash);
      if (localBlob?.data) {
        const headRes = await fetch(`${base}/api/vault/blobs/${hash}`, {
          method: 'HEAD',
          headers: authHeaders,
          signal: AbortSignal.timeout(12000),
        });
        if (headRes.status === 404) {
          onProgress?.(`上傳原版 PDF：${merged.title}`);
          const putRes = await fetch(`${base}/api/vault/blobs/${hash}`, {
            method: 'PUT',
            headers: { ...authHeaders, 'Content-Type': localBlob.mimeType || 'application/pdf' },
            body: localBlob.data,
            signal: AbortSignal.timeout(60000),
          });
          if (putRes.ok) blobsUploaded++;
        }
      } else {
        onProgress?.(`下載原版 PDF：${merged.title}`);
        const getRes = await fetch(`${base}/api/vault/blobs/${hash}`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(60000),
        });
        if (getRes.ok) {
          const buf = await getRes.arrayBuffer();
          await putBlob({ hash, data: buf, mimeType: 'application/pdf', name: `${merged.title}.pdf` });
          blobsDownloaded++;
        }
      }
    }
  }

  // Merge custom categories
  const localCats = (await getSetting('customCategories', [])) || [];
  const mergedCats = [...new Set([...(remoteManifest.categories || []), ...localCats])];
  await setSetting('customCategories', mergedCats);

  const nextManifestBooks = {};
  for (const [id, b] of finalBooks.entries()) {
    nextManifestBooks[id] = {
      id: b.id,
      title: b.title,
      updatedAt: b.updatedAt,
      contentUpdatedAt: b.contentUpdatedAt,
      deletedAt: b.deletedAt || null,
      pdfBlobHash: b.pdfBlobHash || null,
    };
  }

  const nextManifest = {
    version: Number(remoteManifest.version || 1) + (pushed > 0 || pulled > 0 ? 1 : 0),
    updatedAt: Date.now(),
    categories: mergedCats,
    books: nextManifestBooks,
  };

  if (pushed > 0 || !remoteManifest.updatedAt || mergedCats.length !== (remoteManifest.categories || []).length) {
    onProgress?.('更新雲端書庫索引…');
    await apiJson(`${base}/api/vault/manifest`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(nextManifest),
    });
  }

  return {
    pulled,
    pushed,
    blobsUploaded,
    blobsDownloaded,
    totalBooks: [...finalBooks.values()].filter((b) => !b.deletedAt).length,
    syncedAt: Date.now(),
  };
}

export async function downloadVaultPdfBlob({ workerUrl, vaultCode, passphrase, hash, title = 'document' }) {
  const base = cleanBaseUrl(workerUrl);
  if (!base || !vaultCode || !passphrase) {
    throw new Error('請先設定雲端同步碼與密碼，才能下載原版 PDF');
  }
  const token = await deriveVaultToken(vaultCode, passphrase);
  const res = await fetch(`${base}/api/vault/blobs/${hash}`, {
    headers: { 'X-Vault-Code': vaultCode.trim(), 'X-Vault-Token': token },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('雲端找不到此原版 PDF');
  const data = await res.arrayBuffer();
  await putBlob({ hash, data, mimeType: 'application/pdf', name: `${title}.pdf` });
  return data;
}

function sanitizeSharedBook(book) {
  const norm = normalizeBookForSync(book);
  return {
    id: norm.id,
    title: norm.title,
    author: norm.author,
    category: norm.category,
    tags: norm.tags,
    sourceType: norm.sourceType,
    sourceUrl: norm.sourceUrl,
    chapters: norm.chapters,
    pdfBlobHash: norm.pdfBlobHash,
    pdfPageCount: norm.pdfPageCount,
    isVerticalDefault: norm.isVerticalDefault,
    clozeTerms: norm.clozeTerms,
    contentUpdatedAt: norm.contentUpdatedAt,
    updatedAt: norm.updatedAt,
  };
}

export async function publishShare({
  workerUrl,
  title,
  description = '',
  kind = 'book',
  targetKey = '',
  books,
  includePdfBlobs = false,
}) {
  const base = cleanBaseUrl(workerUrl);
  if (!base) throw new Error('請先設定 Cloudflare Worker 網址');
  const sanitized = books.map((b) => {
    const s = sanitizeSharedBook(b);
    if (!includePdfBlobs) s.pdfBlobHash = null;
    return s;
  });

  const created = await apiJson(`${base}/api/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description, kind, books: sanitized }),
  });

  if (includePdfBlobs) {
    await uploadShareBlobs({ base, shareId: created.shareId, editToken: created.editToken, books: sanitized });
  }

  const record = {
    shareId: created.shareId,
    editToken: created.editToken,
    workerUrl: base,
    title: created.title,
    description,
    kind,
    targetKey,
    bookIds: books.map((b) => b.id),
    includePdfBlobs,
    version: created.version,
    updatedAt: created.updatedAt,
  };
  await putShare(record);
  return record;
}

export async function updateShare({ shareRecord, books, title, description }) {
  const base = cleanBaseUrl(shareRecord.workerUrl);
  if (!base) throw new Error('缺少 Worker 網址');
  const sanitized = books.map((b) => {
    const s = sanitizeSharedBook(b);
    if (!shareRecord.includePdfBlobs) s.pdfBlobHash = null;
    return s;
  });

  const updated = await apiJson(`${base}/api/shares/${encodeURIComponent(shareRecord.shareId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Edit-Token': shareRecord.editToken,
    },
    body: JSON.stringify({
      title: title || shareRecord.title,
      description: description ?? shareRecord.description ?? '',
      kind: shareRecord.kind,
      books: sanitized,
    }),
  });

  if (shareRecord.includePdfBlobs) {
    await uploadShareBlobs({
      base,
      shareId: shareRecord.shareId,
      editToken: shareRecord.editToken,
      books: sanitized,
    });
  }

  const nextRecord = {
    ...shareRecord,
    title: updated.title,
    version: updated.version,
    bookIds: books.map((b) => b.id),
    updatedAt: updated.updatedAt,
  };
  await putShare(nextRecord);
  return nextRecord;
}

async function uploadShareBlobs({ base, shareId, editToken, books }) {
  const uploaded = new Set();
  for (const b of books) {
    if (!b.pdfBlobHash || uploaded.has(b.pdfBlobHash)) continue;
    const blob = await getBlob(b.pdfBlobHash);
    if (!blob?.data) continue;
    await fetch(`${base}/api/shares/${encodeURIComponent(shareId)}/blobs/${b.pdfBlobHash}`, {
      method: 'PUT',
      headers: {
        'X-Edit-Token': editToken,
        'Content-Type': blob.mimeType || 'application/pdf',
      },
      body: blob.data,
      signal: AbortSignal.timeout(60000),
    });
    uploaded.add(b.pdfBlobHash);
  }
}

export async function fetchShareBundle(workerUrl, shareId) {
  const base = cleanBaseUrl(workerUrl);
  if (!base) throw new Error('請先設定 Cloudflare Worker 網址（才能讀取分享碼）');
  const cleanId = extractShareId(shareId);
  if (!cleanId) throw new Error('分享碼格式不正確');
  return apiJson(`${base}/api/shares/${encodeURIComponent(cleanId)}`);
}

export function extractShareId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const hashMatch = raw.match(/#(?:sub|share)=([a-zA-Z0-9]{6,16})/);
  if (hashMatch) return hashMatch[1];
  const idMatch = raw.match(/^([a-zA-Z0-9]{6,16})$/);
  return idMatch ? idMatch[1] : '';
}

export async function subscribeToShare({ workerUrl, shareId, downloadPdfs = true }) {
  const base = cleanBaseUrl(workerUrl);
  const bundle = await fetchShareBundle(base, shareId);
  const imported = [];

  for (const remoteBook of bundle.books || []) {
    const localId = `sub_${bundle.shareId}_${remoteBook.id}`;
    const existing = await getBook(localId);
    const mergedCloze = [
      ...new Set([...(existing?.clozeTerms || []), ...(remoteBook.clozeTerms || [])]),
    ];
    const nextBook = normalizeBookForSync({
      ...remoteBook,
      id: localId,
      pinned: existing ? existing.pinned : false,
      bookmarks: existing?.bookmarks || [],
      readingState: existing?.readingState || { chapterIndex: 0, paraIndex: 0, updatedAt: 0 },
      clozeTerms: mergedCloze,
      deletedAt: null,
      subscription: {
        shareId: bundle.shareId,
        sourceBookId: remoteBook.id,
        version: bundle.version,
        title: bundle.title,
        workerUrl: base,
      },
    });
    await putBook(nextBook);
    imported.push(nextBook);

    if (downloadPdfs && remoteBook.pdfBlobHash) {
      const existingBlob = await getBlob(remoteBook.pdfBlobHash);
      if (!existingBlob) {
        try {
          const res = await fetch(
            `${base}/api/shares/${encodeURIComponent(bundle.shareId)}/blobs/${remoteBook.pdfBlobHash}`,
            { signal: AbortSignal.timeout(45000) }
          );
          if (res.ok) {
            const buf = await res.arrayBuffer();
            await putBlob({
              hash: remoteBook.pdfBlobHash,
              data: buf,
              mimeType: 'application/pdf',
              name: `${nextBook.title}.pdf`,
            });
          }
        } catch {
          // Non-fatal: text is still usable offline
        }
      }
    }
  }

  const subRecord = {
    shareId: bundle.shareId,
    title: bundle.title,
    description: bundle.description || '',
    kind: bundle.kind || 'book',
    version: bundle.version,
    bookCount: (bundle.books || []).length,
    workerUrl: base,
    updatedAt: bundle.updatedAt || Date.now(),
    checkedAt: Date.now(),
  };
  await putSubscription(subRecord);
  return { subscription: subRecord, books: imported };
}

export async function refreshAllSubscriptions(defaultWorkerUrl = '') {
  const subs = await getAllSubscriptions();
  const updates = [];
  for (const sub of subs) {
    const base = cleanBaseUrl(sub.workerUrl || defaultWorkerUrl);
    if (!base) continue;
    try {
      const meta = await apiJson(`${base}/api/shares/${encodeURIComponent(sub.shareId)}/meta`);
      if (Number(meta.version || 1) > Number(sub.version || 0)) {
        const res = await subscribeToShare({ workerUrl: base, shareId: sub.shareId });
        updates.push({ shareId: sub.shareId, title: res.subscription.title, version: res.subscription.version });
      } else {
        await putSubscription({ ...sub, checkedAt: Date.now() });
      }
    } catch {
      // Keep going for other subscriptions
    }
  }
  return updates;
}

export async function downloadSharePdfBlob({ workerUrl, shareId, hash, title = 'document' }) {
  const base = cleanBaseUrl(workerUrl);
  if (!base) throw new Error('缺少訂閱來源伺服器網址');
  const res = await fetch(`${base}/api/shares/${encodeURIComponent(shareId)}/blobs/${hash}`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('分享來源找不到此原版 PDF');
  const data = await res.arrayBuffer();
  await putBlob({ hash, data, mimeType: 'application/pdf', name: `${title}.pdf` });
  return data;
}

// ── Local JSON Backup / Restore ───────────────────────────────────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function exportBackupJson({ includeBlobs = false } = {}) {
  const [books, shares, subscriptions, customCategories] = await Promise.all([
    getAllBooks({ includeDeleted: false }),
    getAllShares(),
    getAllSubscriptions(),
    getSetting('customCategories', []),
  ]);

  const blobs = [];
  if (includeBlobs) {
    const seen = new Set();
    for (const b of books) {
      if (!b.pdfBlobHash || seen.has(b.pdfBlobHash)) continue;
      seen.add(b.pdfBlobHash);
      const rec = await getBlob(b.pdfBlobHash);
      if (rec?.data) {
        blobs.push({
          hash: rec.hash,
          mimeType: rec.mimeType || 'application/pdf',
          name: rec.name || '',
          base64: arrayBufferToBase64(rec.data),
        });
      }
    }
  }

  return JSON.stringify(
    {
      format: 'pocketReader-backup-v1',
      exportedAt: new Date().toISOString(),
      customCategories: customCategories || [],
      books,
      shares,
      subscriptions,
      blobs,
    },
    null,
    2
  );
}

export async function importBackupJson(jsonText) {
  const data = JSON.parse(jsonText);
  if (!data || data.format !== 'pocketReader-backup-v1' || !Array.isArray(data.books)) {
    throw new Error('備份檔案格式不正確');
  }

  let importedBooks = 0;
  for (const raw of data.books) {
    const existing = await getBook(raw.id);
    const merged = mergeBooks(existing, raw);
    if (merged) {
      await putBook(merged);
      importedBooks++;
    }
  }

  for (const b of data.blobs || []) {
    if (!b?.hash || !b?.base64) continue;
    const existing = await getBlob(b.hash);
    if (!existing) {
      await putBlob({
        hash: b.hash,
        data: base64ToArrayBuffer(b.base64),
        mimeType: b.mimeType || 'application/pdf',
        name: b.name || '',
      });
    }
  }

  for (const s of data.shares || []) {
    if (s?.shareId && s?.editToken) await putShare(s);
  }
  for (const sub of data.subscriptions || []) {
    if (sub?.shareId) await putSubscription(sub);
  }
  if (Array.isArray(data.customCategories) && data.customCategories.length) {
    const prev = (await getSetting('customCategories', [])) || [];
    await setSetting('customCategories', [...new Set([...prev, ...data.customCategories])]);
  }

  return { importedBooks, importedBlobs: (data.blobs || []).length };
}

export { getAllShares, getAllSubscriptions };
