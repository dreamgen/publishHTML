import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRequest } from '../worker/src/index.js';

function createMockBucket() {
  const store = new Map();
  return {
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: item.bytes,
        httpMetadata: item.httpMetadata,
        size: item.bytes.byteLength,
        async text() {
          return new TextDecoder().decode(item.bytes);
        },
        async arrayBuffer() {
          return item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength);
        },
      };
    },
    async head(key) {
      const item = store.get(key);
      if (!item) return null;
      return { size: item.bytes.byteLength, httpMetadata: item.httpMetadata };
    },
    async put(key, value, opts = {}) {
      let bytes;
      if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value.slice(0));
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      } else {
        const buf = await new Response(value).arrayBuffer();
        bytes = new Uint8Array(buf);
      }
      store.set(key, { bytes, httpMetadata: opts.httpMetadata || {} });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

async function req(env, path, init = {}) {
  const request = new Request(`https://worker.test${path}`, init);
  return handleRequest(request, env);
}

test('Health check & CORS preflight work cleanly', async () => {
  const env = { READER_BUCKET: createMockBucket() };
  const opt = await req(env, '/api/health', { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), '*');

  const res = await req(env, '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'pocket-reader-sync');
});

test('Vault init, authentication enforcement, books sync, and PDF blob storage', async () => {
  const env = { READER_BUCKET: createMockBucket() };
  const vaultHeaders = {
    'X-Vault-Code': 'MY-VAULT-123',
    'X-Vault-Token': 'a'.repeat(64),
  };

  // Create vault
  const initRes = await req(env, '/api/vault/init', { method: 'POST', headers: vaultHeaders });
  assert.equal(initRes.status, 201);

  // Wrong passphrase returns 401
  const badInit = await req(env, '/api/vault/init', {
    method: 'POST',
    headers: { 'X-Vault-Code': 'MY-VAULT-123', 'X-Vault-Token': 'b'.repeat(64) },
  });
  assert.equal(badInit.status, 401);

  // Path traversal / invalid book ID rejected
  const badBook = await req(env, '/api/vault/books/..%2Fsecret', {
    method: 'PUT',
    headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'x' }),
  });
  assert.equal(badBook.status, 400);

  // Upload book
  const putBook = await req(env, '/api/vault/books/book-1', {
    method: 'PUT',
    headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'book-1', title: '隨身筆記', chapters: [{ id: 'ch-1', title: '一', content: '內容' }] }),
  });
  assert.equal(putBook.status, 200);

  const getBook = await req(env, '/api/vault/books/book-1', { headers: vaultHeaders });
  assert.equal(getBook.status, 200);
  assert.equal((await getBook.json()).title, '隨身筆記');

  // Upload and download PDF blob by SHA-256 hash
  const hash = 'f'.repeat(64);
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const putBlob = await req(env, `/api/vault/blobs/${hash}`, {
    method: 'PUT',
    headers: { ...vaultHeaders, 'Content-Type': 'application/pdf' },
    body: pdfBytes,
  });
  assert.equal(putBlob.status, 200);

  const headBlob = await req(env, `/api/vault/blobs/${hash}`, { method: 'HEAD', headers: vaultHeaders });
  assert.equal(headBlob.status, 200);
  assert.equal(headBlob.headers.get('Content-Length'), String(pdfBytes.byteLength));

  const getBlob = await req(env, `/api/vault/blobs/${hash}`, { headers: vaultHeaders });
  assert.equal(getBlob.status, 200);
  assert.deepEqual(new Uint8Array(await getBlob.arrayBuffer()), pdfBytes);
});

test('Shares creation, editToken protection, version bump update, and public subscription read', async () => {
  const env = { READER_BUCKET: createMockBucket() };

  const createRes = await req(env, '/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '背誦清單',
      kind: 'category',
      books: [{ id: 'b1', title: '大學', chapters: [{ id: 'c1', title: '一', content: '大學之道' }] }],
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.version, 1);
  assert.ok(created.shareId.length === 8);
  assert.ok(created.editToken.length === 32);

  // Public GET must NOT leak editTokenHash
  const readMeta = await req(env, `/api/shares/${created.shareId}/meta`);
  assert.equal(readMeta.status, 200);
  const metaJson = await readMeta.json();
  assert.equal(metaJson.editTokenHash, undefined);
  assert.equal(metaJson.version, 1);

  // Wrong editToken rejected
  const badUpdate = await req(env, `/api/shares/${created.shareId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Edit-Token': 'wrong-token' },
    body: JSON.stringify({ books: [{ id: 'b1', title: '駭入', chapters: [] }] }),
  });
  assert.equal(badUpdate.status, 403);

  // Correct editToken increments version
  const goodUpdate = await req(env, `/api/shares/${created.shareId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Edit-Token': created.editToken },
    body: JSON.stringify({
      title: '背誦清單（修訂版）',
      books: [{ id: 'b1', title: '大學', chapters: [{ id: 'c1', title: '一', content: '大學之道，在明明德。' }] }],
    }),
  });
  assert.equal(goodUpdate.status, 200);
  const updated = await goodUpdate.json();
  assert.equal(updated.version, 2);

  const readBundle = await req(env, `/api/shares/${created.shareId}`);
  const bundle = await readBundle.json();
  assert.equal(bundle.version, 2);
  assert.equal(bundle.books[0].chapters[0].content, '大學之道，在明明德。');
});

test('fetch-url blocks private/loopback SSRF targets', async () => {
  const env = { READER_BUCKET: createMockBucket() };
  for (const blocked of [
    'http://127.0.0.1:8080/secret',
    'http://localhost/admin',
    'http://192.168.1.1/',
    'http://10.0.0.5/internal',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    const res = await req(env, `/api/fetch-url?url=${encodeURIComponent(blocked)}`);
    assert.equal(res.status, 403, `Expected 403 for ${blocked}`);
  }
});
