// 修正通知：儀表板儲存修正後，在各畫面顯示「主持人已修正」橫幅，按「知道了」後不再顯示。
import { h } from './ui.js';

const seenKey = (view, ev) => `ug.seen.${view}.${ev}`;
const getSeen = (view, ev) => { try { return +localStorage.getItem(seenKey(view, ev)) || 0; } catch (e) { return 0; } };
const setSeen = (view, ev, at) => { try { localStorage.setItem(seenKey(view, ev), String(at)); } catch (e) { /* */ } };

/**
 * view：'dash' | 'phone' | 'player'
 * pick(notice) 回傳要顯示的文字陣列；空陣列表示這則與本畫面無關。
 */
export function noticeBanner(S, view, pick, { dark = false, onSeen } = {}) {
  const seen = getSeen(view, S.ev);
  const fresh = S.notices.filter((n) => n.at > seen);
  if (!fresh.length) return null;
  const lines = [];
  for (const n of fresh) lines.push(...pick(n));
  const last = fresh[fresh.length - 1].at;
  if (!lines.length) { setSeen(view, S.ev, last); return null; }
  return h('div', { class: 'notice-banner' + (dark ? ' dark' : ''), role: 'alert' },
    h('div', { class: 'flex1' },
      h('b', {}, '主持人已修正資料'),
      h('ul', {}, [...new Set(lines)].map((t) => h('li', {}, t)))),
    h('button', { class: 'btn', onclick: () => { setSeen(view, S.ev, last); onSeen && onSeen(); } }, '知道了'));
}
