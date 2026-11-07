// 核對信封（控場講師）：任何時候都能掃信封 QR，確認信封裡放的角色卡沒有放錯。
// 掃描 → 顯示這個代號應該裝的角色（含角色卡圖）→ 打開信封比對 → 按「正確」或「放錯了」。
// 核對紀錄存在資料庫（qrcheck/v<版本>/<套>/<代號>），多位工作人員可分頭核對；更新 QR 碼後自動作廢。
import { h, toast, confirmBox, openScanner } from './ui.js';
import { ROLE, KIND_LABEL, QR, roleTitle } from './rules.js';

const sortedCodes = (map) => Object.keys(map).sort();

/** 依掃描內容找出信封：{ set, code, role, stale, v } 或 { error } */
export function lookupEnvelope(q, text) {
  const p = QR.parse(text);
  if (p.type !== 'envelope' && p.type !== 'code') return { error: '這不是信封上的 QR 碼或代號（手動輸入請填 4 位數字）' };
  const set = p.set || ['A', 'B'].find((s) => q.sets[s] && q.sets[s][p.code]);
  const role = set && q.sets[set] && q.sets[set][p.code];
  if (!role) return { error: `目前 v${q.version} 的 A、B 套都沒有代號 ${p.code}，可能是舊版貼紙或別的活動` };
  return { set, code: p.code, role, v: p.v || null, stale: p.type === 'envelope' && p.v !== q.version };
}

/**
 * st：畫面狀態（呼叫端保存）{ cur: {set, code, ...} | null, set: 'A' }
 */
export function checkTab(S, st, rerender) {
  const q = S.qr;
  const marks = ((S.data && S.data.qrcheck && S.data.qrcheck[`v${q.version}`]) || {});
  const markOf = (set, code) => (marks[set] || {})[code] || null;
  const mark = (set, code, ok) => S.patch({ [`qrcheck/v${q.version}/${set}/${code}`]: { ok, at: Date.now() } });
  const err = (e) => toast(e.message, 'bad');

  // 本梯次哪一組、哪個座位用了這個信封
  const usage = (set, code) => {
    const groups = (S.batch && S.batch.groups) || {};
    for (const g of Object.keys(groups)) {
      if (groups[g].set !== set) continue;
      const seat = S.seatOf(g, code);
      if (seat) return groups[g].draw === 'auto' ? `第 ${g} 組 ${seat} 號（自動抽角色，不用信封）` : `第 ${g} 組 ${seat} 號`;
    }
    return null;
  };

  const scan = () => openScanner({
    title: '掃信封核對', hint: '掃信封上的 QR 碼，或輸入 4 位數字代號',
    onResult: (t) => {
      const r = lookupEnvelope(q, t);
      if (r.error) return r.error;
      st.cur = r; st.set = r.set;
      setTimeout(rerender);
      return true;
    },
  });

  // ── 掃描結果 ──
  let result;
  if (!st.cur) {
    result = h('section', { class: 'card check-hero' },
      h('h2', {}, '核對信封內容'),
      h('ol', { class: 'steps small' },
        h('li', {}, '按「掃信封」掃信封上的 QR 碼（相機不能用時可輸入 4 位數字）。'),
        h('li', {}, '畫面會顯示這個信封「應該裝」的角色卡。'),
        h('li', {}, '打開信封比對，按「正確」或「放錯了」。')),
      h('button', { class: 'btn primary big', onclick: scan }, '掃信封'),
      h('p', { class: 'muted tiny' }, '任何時候都能用：裝填信封後、每梯次開始前、收回信封時都可以抽查。'));
  } else {
    const { set, code, role, stale, v } = st.cur;
    const r = ROLE[role], m = markOf(set, code), used = usage(set, code);
    const next = (ok) => mark(set, code, ok).then(() => { if (ok) { st.cur = null; rerender(); scan(); } else rerender(); }).catch(err);
    if (stale) {
      result = h('section', { class: 'card check-hero stale' },
        h('div', { class: 'note bad' }, h('b', {}, `這是 v${v} 的舊版貼紙，已作廢。`), `目前是 v${q.version}。舊版的代號對應已失效，無法判斷信封該裝什麼，請撕掉換貼 v${q.version} 的貼紙並重新裝填。`),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: scan }, '掃另一個'),
          h('button', { class: 'btn', onclick: () => { st.cur = null; rerender(); } }, '關閉結果')));
      return wrapPage(result);
    }
    result = h('section', { class: 'card check-hero' },
      h('div', { class: 'check-main' },
        h('img', { class: 'check-img', src: `./roles/role-${role}.jpg`, alt: `${r.name} 角色卡圖` }),
        h('div', { class: 'check-info' },
          h('span', { class: 'eyebrow' }, `${set} 套・${code}・v${q.version}`),
          h('span', { class: 'muted small' }, '這個信封應該裝'),
          h('b', { class: 'check-role', style: { color: r.camp === 'spy' ? 'var(--bad)' : 'var(--ok)' } }, roleTitle(role)),
          h('span', { class: 'small' }, KIND_LABEL[r.kind]),
          h('span', { class: 'chip ' + (used ? 'dark' : '') }, used ? `本梯次：${used}` : '本梯次未使用'),
          m ? h('span', { class: 'chip ' + (m.ok ? 'ok' : 'bad') }, m.ok ? `已核對正確（${new Date(m.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}）` : '上次核對：放錯了') : null)),
      m && !m.ok ? h('div', { class: 'note bad' }, `請把「${r.name}」的角色卡放進 ${set} 套 ${code} 的信封，抽出來的卡放回它自己的信封，修正後再掃一次確認。`) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary big flex1', onclick: () => next(true) }, '正確，掃下一個'),
        h('button', { class: 'btn soft-bad big flex1', onclick: () => next(false) }, '放錯了')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: scan }, '掃另一個'),
        h('button', { class: 'btn', onclick: () => { st.cur = null; rerender(); } }, '關閉結果')));
  }

  return wrapPage(result);

  function wrapPage(resultNode) {
  // ── 核對清單 ──
  const setNow = st.set || 'A';
  const map = q.sets[setNow];
  const codes = sortedCodes(map);
  const count = (s) => { const ms = marks[s] || {}; const all = sortedCodes(q.sets[s]); return { ok: all.filter((c) => ms[c] && ms[c].ok).length, bad: all.filter((c) => ms[c] && !ms[c].ok).length, n: all.length }; };
  const list = h('section', { class: 'card' },
    h('div', { class: 'row between' },
      h('h2', {}, '核對清單'),
      h('div', { class: 'row' }, ['A', 'B'].map((s) => { const c = count(s); return h('button', { class: 'btn', 'aria-pressed': String(setNow === s), onclick: () => { st.set = s; rerender(); } }, `${s} 套 ${c.ok}/${c.n}${c.bad ? `・放錯 ${c.bad}` : ''}`); }))),
    h('div', { class: 'check-grid' }, codes.map((code) => {
      const m = markOf(setNow, code), r = ROLE[map[code]];
      return h('button', {
        class: 'check-item ' + (m ? (m.ok ? 'ok' : 'bad') : 'todo'), type: 'button',
        'aria-label': `${code} ${r.name}：${m ? (m.ok ? '正確' : '放錯') : '未核對'}`,
        onclick: () => { st.cur = { set: setNow, code, role: map[code], stale: false }; rerender(); },
      }, h('b', { class: 'mono' }, code), h('span', {}, r.name), h('span', { class: 'tiny' }, m ? (m.ok ? '✓ 正確' : '✗ 放錯') : '未核對'));
    })),
    h('div', { class: 'row between' },
      h('span', { class: 'muted tiny' }, '紀錄存在雲端，多位工作人員可以分頭核對；更新 QR 碼後清單會重新開始。點代號可看應裝的角色。'),
      h('button', {
        class: 'btn', onclick: async () => {
          if (await confirmBox(`清除 ${setNow} 套的核對紀錄？`, '下次裝填或收回信封後，可以清除重新核對。', '清除', true)) S.patch({ [`qrcheck/v${q.version}/${setNow}`]: null }).catch(err);
        },
      }, `清除 ${setNow} 套紀錄`)));

  return h('div', { class: 'stack' },
    h('div', { class: 'note bad' }, '此頁會顯示信封對應的角色，請勿投影或讓學員看到。'),
    resultNode, list);
  }
}
