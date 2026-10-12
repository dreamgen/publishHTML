import { notebookRef, presenceRef, connectedRef, courseRef, get, set, remove, onValue, onChildAdded, onDisconnect, runTransaction } from './firebase.js';
import { Y, REMOTE, uid, encode, decode, snapshot, fromRoom, plainText } from './notebook-model.js';
import { cachePut, cachePutMany, cacheDelete, cacheGet, pendingFor } from './notebook-cache.js';

const TX = { applyLocally: false };
export function emptyRoom() {
  const doc = new Y.Doc(), base = snapshot(doc); doc.destroy();
  return { meta: { generation: uid(), state: 'ready', schemaVersion: 1 }, base };
}
// Initialization is idempotent. Returning a proposal for null lets RTDB retry with the server value.
export async function ensureNotebook(code, gid) {
  const proposal = emptyRoom();
  const result = await runTransaction(notebookRef(code, gid), (room) => room || proposal, TX);
  return result.snapshot.val();
}

export class Notebook {
  constructor(session, changed) {
    this.session = { ...session }; this.changed = changed;
    this.key = `${session.code}/${session.gid}`; this.client = uid();
    this.doc = new Y.Doc(); this.generation = null; this.ready = false; this.connected = false;
    this.pending = new Map(); this.disposers = []; this.error = ''; this.recovery = '';
    this.closed = false; this.loading = 0; this.saving = false; this.onlineNames = [];
    this.persistChain = Promise.resolve(); this.seen = new Set(); this.storageError = '';
    this.recoveries = new Map();
    this.handleUpdate = (bytes, origin) => {
      if (origin !== REMOTE && this.generation && !this.closed) {
        const id = uid();
        const op = { generation: this.generation, payload: encode(bytes) };
        this.pending.set(id, op);
        // One rescue snapshot per writer/generation, not one full document per keystroke.
        const recoveryId = `rescue:${this.key}:${this.generation}:${this.client}`;
        const record = { id: `${this.key}/${id}`, key: this.key, kind: 'pending', opId: id, recoveryId, ...op };
        const rescue = { id: recoveryId, payload: snapshot(this.doc) };
        this.persistChain = this.persistChain.then(() => cachePutMany([record, rescue])).catch(() => {
          this.storageError = '本機儲存失敗，請立即複製或下載內容。'; this.changed();
        });
        clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 180);
      }
      this.persistSnapshot(); this.changed();
    };
    this.doc.on('update', this.handleUpdate);
  }
  persistSnapshot() {
    if (!this.generation) return;
    const record = { id: `snapshot:${this.key}`, generation: this.generation, payload: snapshot(this.doc) };
    this.persistChain = this.persistChain.then(() => cachePut(record)).catch(() => {
      this.storageError = '本機儲存失敗，請立即複製或下載內容。'; this.changed();
    });
  }
  status() {
    if (this.error) return this.error;
    if (this.storageError) return this.storageError;
    if (!this.ready) return '正在載入記事本…';
    if (this.frozen) return '記事本正在整理，暫停編輯。';
    if (!this.connected) return '連線中斷 · 僅保存在此裝置，尚未同步';
    return this.pending.size ? '同步中…' : '已同步';
  }
  async start() {
    const { code, gid } = this.session;
    try {
      const cached = await cacheGet(`snapshot:${this.key}`);
      this.cached = cached;
      const pending = await pendingFor(this.key);
      const recovered = new Set();
      for (const record of pending) {
        if (record.recoveryId && !recovered.has(record.recoveryId)) {
          record.recovery = (await cacheGet(record.recoveryId))?.payload;
          recovered.add(record.recoveryId);
        }
      }
      this.localRecords = pending;
    } catch { this.storageError = '本機儲存不可用，請定期下載內容。'; }
    if (this.closed) return;
    this.disposers.push(onValue(connectedRef(), (snap) => {
      this.connected = snap.val() === true;
      if (this.connected) { this.flush(); this.writePresence(); }
      this.changed();
    }));
    this.watchMetadata();
    this.disposers.push(onValue(presenceRef(code, gid), (snap) => {
      this.presence = snap.val() || {}; this.refreshNames();
    }, () => {}));
    this.heartbeat = setInterval(() => { this.writePresence(); this.refreshNames(); }, 20000);
    try {
      const exists = (await get(courseRef(code, `groups/${gid}`))).exists();
      if (!exists || this.closed) return this.invalidate();
      const room = await ensureNotebook(code, gid);
      if (room.merge && !(await get(courseRef(code, `groups/${room.merge.dropGid}`))).exists()) {
        await finishNotebookMerge(code, gid, room.merge.dropGid, room.meta.operation);
      }
      if (!this.closed && !this.generation) await this.load(room.meta.generation);
    } catch (e) {
      if (!this.closed && !this.ready && this.cached) {
        this.generation = this.cached.generation;
        Y.applyUpdate(this.doc, decode(this.cached.payload), REMOTE);
        this.restorePending(); this.ready = true;
      }
      this.fail(e);
    }
  }
  watchMetadata() {
    const { code, gid } = this.session;
    this.stopMeta?.();
    this.stopMeta = onValue(notebookRef(code, `${gid}/meta`), (snap) => {
      if (this.closed) return;
      const meta = snap.val();
      if (!meta) { if (this.ready) this.invalidate(); return; }
      this.frozen = meta.state !== 'ready';
      if (meta.generation !== this.generation) this.load(meta.generation);
      else { this.flush(); this.changed(); }
    }, (e) => this.fail(e));
  }
  restorePending() {
    for (const record of this.localRecords || []) {
      if (record.generation !== this.generation) {
        let rescue = this.recoveries.get(record.generation);
        if (!rescue) { rescue = new Y.Doc(); this.recoveries.set(record.generation, rescue); }
        if (record.recovery) Y.applyUpdate(rescue, decode(record.recovery), REMOTE);
        Y.applyUpdate(rescue, decode(record.payload), REMOTE);
        this.recovery = [...this.recoveries.values()].map((doc) => plainText(doc)).filter(Boolean).join('\n\n--- 另一份未同步版本 ---\n\n');
        continue;
      }
      Y.applyUpdate(this.doc, decode(record.payload), REMOTE);
      this.pending.set(record.opId, { generation: record.generation, payload: record.payload });
    }
    this.localRecords = [];
  }
  async load(generation) {
    const ticket = ++this.loading;
    try {
      const room = (await get(notebookRef(this.session.code, this.session.gid))).val();
      if (this.closed || ticket !== this.loading || room?.meta.generation !== generation) return;
      if (this.generation && generation !== this.generation) {
        // Old local changes must never be uploaded to a replacement document.
        if (this.pending.size) {
          const rescue = new Y.Doc(); Y.applyUpdate(rescue, Y.encodeStateAsUpdate(this.doc), REMOTE);
          this.recoveries.set(this.generation, rescue);
          this.recovery = [...this.recoveries.values()].map((doc) => plainText(doc)).join('\n\n--- 另一份未同步版本 ---\n\n');
        }
        this.pending.clear(); this.ready = false;
        const old = this.doc; this.doc = new Y.Doc();
        // Preserve the update handler while letting the view dispose its old bindings first.
        this.doc.on('update', this.handleUpdate);
        this.changed(); old.destroy();
      }
      if (this.cached && this.cached.generation !== generation) {
        const old = new Y.Doc(); Y.applyUpdate(old, decode(this.cached.payload), REMOTE);
        if ((this.localRecords || []).some((r) => r.generation === this.cached.generation)) this.recovery = plainText(old);
        old.destroy();
      }
      this.generation = generation; this.frozen = room.meta.state !== 'ready';
      this.seen.clear();
      Y.applyUpdate(this.doc, decode(room.base), REMOTE);
      for (const [id, op] of Object.entries(room.updates || {})) {
        if (op.generation === generation) { Y.applyUpdate(this.doc, decode(op.payload), REMOTE); this.seen.add(id); }
      }
      this.stopUpdates?.();
      this.stopUpdates = onChildAdded(notebookRef(this.session.code, `${this.session.gid}/updates`), (snap) => {
        const op = snap.val();
        if (this.closed || op.generation !== this.generation || this.seen.has(snap.key)) return;
        try { Y.applyUpdate(this.doc, decode(op.payload), REMOTE); this.seen.add(snap.key); }
        catch { this.fail(Error('記事本資料無法讀取，請下載目前內容並重新開啟。')); }
      }, (e) => this.fail(e));
      this.restorePending(); this.ready = true; this.roomRecovery = room.recovery || null; this.error = '';
      this.changed(); this.flush();
    } catch (e) { this.fail(e); }
  }
  fail(e) { if (!this.closed) { this.error = '同步失敗：' + (e?.message || e); this.changed(); } }
  invalidate() { this.frozen = true; this.error = '此記事本已移除，請下載保留目前內容。'; this.changed(); }
  async flush() {
    if (!this.ready || !this.connected || this.closed || this.frozen || this.saving) return;
    this.saving = true;
    try {
      await this.persistChain;
      for (const [id, op] of this.pending) {
        if (this.closed || this.frozen || op.generation !== this.generation) break;
        await this.persistChain;
        if (this.closed || this.frozen || op.generation !== this.generation) break;
        try { await set(notebookRef(this.session.code, `${this.session.gid}/updates/${id}`), op); }
        catch (e) { if (op.generation !== this.generation || this.closed) continue; throw e; }
        this.pending.delete(id);
        await cacheDelete(`${this.key}/${id}`);
      }
    } catch (e) { this.fail(e); }
    finally {
      this.saving = false; this.changed();
      if (!this.closed && !this.error && this.pending.size && this.connected && !this.frozen) { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 180); }
    }
  }
  async retry() {
    this.error = '';
    try {
      this.watchMetadata();
      const room = await ensureNotebook(this.session.code, this.session.gid);
      await this.load(room.meta.generation);
    } catch (e) { this.fail(e); }
    this.flush(); this.changed();
  }
  refreshNames() {
    this.onlineNames = Object.values(this.presence || {}).filter((p) => Date.now() - p.lastSeen < 65000).map((p) => p.name);
    this.changed();
  }
  async writePresence() {
    if (this.closed || !this.connected || !this.visible) return;
    const r = presenceRef(this.session.code, `${this.session.gid}/${this.client}`);
    try { await onDisconnect(r).remove(); if (!this.closed && this.visible) await set(r, { name: this.session.author || '組員', lastSeen: Date.now() }); } catch { /* Presence is advisory. */ }
  }
  setVisible(value) {
    this.visible = value;
    if (value) this.writePresence();
    else remove(presenceRef(this.session.code, `${this.session.gid}/${this.client}`)).catch(() => {});
  }
  async replace(restore = false) {
    if (!this.connected || this.pending.size || !this.ready) throw Error('請等候內容同步完成後再操作。');
    const generation = this.generation;
    const proposal = emptyRoom();
    const result = await runTransaction(notebookRef(this.session.code, this.session.gid), (room) => {
      if (!room) return null;
      if (room.meta.generation !== generation || room.meta.state !== 'ready') return;
      if (restore && !room.recovery) return;
      const current = fromRoom(room);
      const recovery = { payload: snapshot(current), savedAt: Date.now() }; current.destroy();
      return { ...proposal, base: restore ? room.recovery.payload : proposal.base, recovery };
    }, TX);
    if (!result.committed || !result.snapshot.exists()) throw Error('記事本已變動，請重新確認後再操作。');
  }
  close() {
    this.setVisible(false); this.closed = true; this.loading++;
    clearTimeout(this.timer); clearInterval(this.heartbeat); this.stopUpdates?.(); this.stopMeta?.();
    this.disposers.forEach((fn) => fn()); this.disposers = [];
    this.persistSnapshot(); this.doc.destroy(); this.recoveries.forEach((doc) => doc.destroy());
  }
}

export const deleteNotebook = (code, gid) => remove(notebookRef(code, gid));
export const deleteNotebookPresence = (code, gid = '') => remove(presenceRef(code, gid));

/** Freeze both rooms before the existing answer merge. Retain a restartable journal on the keeper. */
export async function withNotebookMerge(code, keepGid, dropGid, mergeAnswers) {
  const token = `merge_${keepGid}_${dropGid}`;
  const freeze = async (gid) => {
    await ensureNotebook(code, gid);
    const result = await runTransaction(notebookRef(code, gid), (room) => {
      if (!room) return null;
      if (room.meta.state !== 'ready' && room.meta.operation !== token) return;
      return { ...room, meta: { ...room.meta, state: 'frozen', operation: token } };
    }, TX);
    if (!result.committed || !result.snapshot.exists()) throw Error('記事本正在被其他操作整理，請稍後再合併。');
    return result.snapshot.val();
  };
  let keep, drop;
  try {
    drop = await freeze(dropGid); keep = await freeze(keepGid);
    const sourceName = (await get(courseRef(code, `groups/${dropGid}/name`))).val() || '其他小組';
    if (!keep.merge) {
      const original = fromRoom(keep), source = fromRoom(drop);
      const originalPayload = snapshot(original);
      const { paragraphs, addParagraph } = await import('./notebook-model.js');
      for (const { value } of paragraphs(source, true)) {
        const id = addParagraph(original, value.get('scope'), null, value.get('text').toString());
        original.getMap('paragraphs').get(id).set('sourceGroup', value.get('sourceGroup') || sourceName);
        if (value.get('deleted')) original.getMap('paragraphs').get(id).set('deleted', true);
      }
      const proposed = { ...emptyRoom(), base: snapshot(original), meta: { generation: uid(), schemaVersion: 1, state: 'frozen', operation: token },
        merge: { dropGid, original: originalPayload }, ...(keep.recovery ? { recovery: keep.recovery } : {}) };
      original.destroy(); source.destroy();
      const prepared = await runTransaction(notebookRef(code, keepGid), (room) => {
        if (!room) return null;
        return room.meta.operation === token ? proposed : undefined;
      }, TX);
      if (!prepared.committed) throw Error('記事本合併準備失敗，請重試。');
    }
    await mergeAnswers();
    await finishNotebookMerge(code, keepGid, dropGid, token);
  } catch (e) {
    // If answers already committed, preserve the journal and finish on the next open.
    const dropped = !(await get(courseRef(code, `groups/${dropGid}`))).exists();
    if (dropped) { await finishNotebookMerge(code, keepGid, dropGid, token); return; }
    for (const gid of [keepGid, dropGid]) {
      await runTransaction(notebookRef(code, gid), (room) => {
        if (!room) return null;
        if (room.meta.operation !== token) return;
        if (room.merge) return { ...emptyRoom(), base: room.merge.original, ...(room.recovery ? { recovery: room.recovery } : {}) };
        return { ...room, meta: { generation: room.meta.generation, schemaVersion: 1, state: 'ready' } };
      }, TX).catch(() => {});
    }
    throw e;
  }
}
async function finishNotebookMerge(code, keepGid, dropGid, token) {
  await runTransaction(notebookRef(code, keepGid), (room) => {
    if (!room) return null;
    if (room.meta.operation !== token) return;
    const { merge, ...rest } = room;
    return { ...rest, meta: { generation: room.meta.generation, state: 'ready', schemaVersion: 1 } };
  }, TX);
  await deleteNotebook(code, dropGid);
  await deleteNotebookPresence(code, dropGid);
}
