// O／X 表決的工作人員面板（助理主持人手機、儀表板共用）
import { h, toast } from './ui.js';

/**
 * opts.team：目前選定的出任務座位（助理主持人手機才有）
 * opts.compact：儀表板用較精簡的樣式
 */
export function voteBox(S, g, opts = {}) {
  const t = S.tally(g);
  const r = S.control.round;
  const team = opts.team || [];
  const phoneSeats = S.phoneSeats(g);
  const start = () => S.openVote(g, team).catch((e) => toast(e.message, 'bad'));
  if (!t || t.round !== r) {
    return h('section', { class: 'vote-box' },
      h('div', { class: 'row between' }, h('b', {}, 'O／X 表決'), h('span', { class: 'muted tiny' }, `已開手機 ${phoneSeats.length} 人`)),
      h('p', { class: 'muted small' }, opts.team ? '掃滿 3 位出任務的人會自動開始表決，也可以直接按「開始表決」。' : '名單提出後可開始表決，玩家在自己的手機上投 O 或 X。'),
      h('button', { class: 'btn', onclick: start, disabled: !phoneSeats.length }, '開始表決'));
  }
  const votes = t.votes || {};
  const chips = t.required.map((s) => h('span', { class: 'vote-chip ' + (votes[s] === 'O' ? 'o' : votes[s] === 'X' ? 'x' : 'wait') }, `${s}`, h('b', {}, votes[s] || '…')));
  const closed = t.status === 'closed';
  return h('section', { class: 'vote-box' + (closed ? (t.passed ? ' pass' : ' fail') : '') },
    h('div', { class: 'row between' },
      h('b', {}, closed ? (t.passed ? '表決通過：隊伍出發' : '表決否決：請重新協調名單') : '表決中'),
      h('span', { class: 'mono' }, `O ${t.o}・X ${t.x}${closed ? '' : `・未投 ${t.pending.length}`}`)),
    t.team && t.team.length ? h('p', { class: 'small' }, `出任務名單：${t.team.join('・')} 號`) : null,
    h('div', { class: 'row', style: { gap: '6px' } }, chips),
    closed ? null : h('p', { class: 'muted tiny' }, t.pending.length ? `等待 ${t.pending.join('、')} 號投票；全部投完會自動顯示結果。` : ''),
    h('div', { class: 'row' },
      closed ? h('button', { class: 'btn', onclick: start }, '重新表決')
        : h('button', { class: 'btn', onclick: () => S.closeVote(g) }, '結束表決並計票'),
      h('button', { class: 'btn', onclick: () => S.clearVote(g) }, '清除')));
}
