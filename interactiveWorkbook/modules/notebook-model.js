/** Paragraph identity, text and scope are independent CRDT values. No UI or database imports. */
import { Y } from '../vendor/notebook-editor.js';
export { Y };
export const LOCAL = 'notebook-local';
export const REMOTE = 'notebook-remote';
export const uid = () => crypto.randomUUID().replaceAll('-', '');
export function encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 16384) s += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(s);
}
export const decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const snapshot = (doc) => encode(Y.encodeStateAsUpdate(doc));
export function fromRoom(room) {
  const doc = new Y.Doc();
  if (room?.base) Y.applyUpdate(doc, decode(room.base), REMOTE);
  for (const op of Object.values(room?.updates || {})) {
    if (op.generation === room.meta.generation) Y.applyUpdate(doc, decode(op.payload), REMOTE);
  }
  return doc;
}
export function paragraphs(doc, includeDeleted = false) {
  const map = doc.getMap('paragraphs');
  return doc.getArray('order').toArray().map((id) => ({ id, value: map.get(id) }))
    .filter(({ value }) => value && (includeDeleted || !value.get('deleted')));
}
export function addParagraph(doc, scope, afterId, text = '') {
  const id = uid();
  doc.transact(() => {
    const p = new Y.Map();
    p.set('scope', scope); p.set('text', new Y.Text(text)); p.set('deleted', false);
    doc.getMap('paragraphs').set(id, p);
    const order = doc.getArray('order');
    const index = afterId ? order.toArray().indexOf(afterId) : -1;
    order.insert(index < 0 ? order.length : index + 1, [id]);
  }, LOCAL);
  return id;
}
export function setScope(doc, id, scope) {
  const p = doc.getMap('paragraphs').get(id);
  if (p && !p.get('deleted')) doc.transact(() => p.set('scope', scope), LOCAL);
}
export function deleteParagraph(doc, id) {
  const p = doc.getMap('paragraphs').get(id);
  if (p) doc.transact(() => p.set('deleted', true), LOCAL);
}
export function splitParagraph(doc, id, start, end, scope) {
  const p = doc.getMap('paragraphs').get(id);
  if (!p || p.get('deleted')) return null;
  const text = p.get('text');
  let next;
  doc.transact(() => {
    const tail = text.toString().slice(end);
    text.delete(start, text.length - start);
    next = addParagraph(doc, scope, id, tail);
  }, LOCAL);
  return next;
}
export function plainText(doc, filter = '*', label = (s) => s?.label || '全局') {
  return paragraphs(doc).filter(({ value }) => filter === '*' || (value.get('scope')?.qid || '') === filter)
    .map(({ value }) => `【${label(value.get('scope'))}】${value.get('sourceGroup') ? '（合併自「' + value.get('sourceGroup') + '」）' : ''}\n${value.get('text').toString()}`).join('\n\n');
}
