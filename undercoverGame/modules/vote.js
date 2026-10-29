// O／X 表決的工作人員面板（助理主持人手機、儀表板共用）
// 2026-10-28 會議：隊長輪流指派、不記名表決（紙本小紙片交控場主持人，或玩家手機投票）、
// 同一回合否決 3 次就無法派人而失敗。不記名：這裡只顯示票數與還沒投的座位，不顯示誰投了什麼。
import { h, toast } from './ui.js';
import { VETO_LIMIT } from './rules.js';

/**
 * opts.team：目前選定的出任務座位（助理主持人手機才有）
 * opts.offline：離線單機（沒有玩家手機，只能紙本登記）
 */
export function voteBox(S, g, opts = {}) {
  const t = S.tally(g);
  const r = S.control.round;
  const team = opts.team || [];
  const phoneSeats = opts.offline ? [] : S.phoneSeats(g);
  const cap = S.captain(g), fails = S.voteFails(g, r);
  const err = (e) => toast(e.message, 'bad');
  const start = () => S.openVote(g, team).catch(err);
  const paper = (ok) => S.recordVote(g, ok).catch(err);
  const passedNow = t && t.round === r && t.status === 'closed' && t.passed;
  const capRow = h('div', { class: 'row between cap-row' },
    h('span', {}, passedNow ? '下回合隊長　' : '輪值隊長　', h('b', { class: 'mono', style: { fontSize: '20px' } }, `${cap} 號`)),
    h('span', { class: 'small ' + (fails ? 'bad-t' : 'muted') }, `本回合已否決 ${fails}／${VETO_LIMIT} 次`));
  const paperRow = h('div', { class: 'row' },
    h('span', { class: 'small muted' }, '紙本計票：'),
    h('button', { class: 'btn', onclick: () => paper(true) }, 'O 過半・通過'),
    h('button', { class: 'btn', onclick: () => paper(false) }, 'X 過半或平手・否決'));
  if (!t || t.round !== r) {
    return h('section', { class: 'vote-box' },
      h('div', { class: 'row between' }, h('b', {}, '不記名表決'), opts.offline ? null : h('span', { class: 'muted tiny' }, `已開手機 ${phoneSeats.length} 人`)),
      capRow,
      h('p', { class: 'muted small' }, opts.offline ? '由隊長提出 3 人名單，收完 O／X 小紙片後登記結果。'
        : opts.team ? '掃滿 3 位出任務的人會自動開始手機表決；用紙本時，收完小紙片直接登記結果。' : '名單提出後可開始手機表決，或收完 O／X 小紙片直接登記結果。'),
      opts.offline ? null : h('button', { class: 'btn', onclick: start, disabled: !phoneSeats.length }, '開始手機表決'),
      paperRow);
  }
  const closed = t.status === 'closed';
  const count = t.paper ? (t.o != null ? `O ${t.o}・X ${t.x}` : '紙本') : `O ${t.o}・X ${t.x}${closed ? '' : `・未投 ${t.pending.length}`}`;
  const vetoed = closed && !t.passed && fails >= VETO_LIMIT;
  const head = closed ? (t.passed ? '表決通過：隊伍出發' : vetoed ? `否決 ${VETO_LIMIT} 次：無法派人，任務失敗` : `表決否決：換 ${cap} 號當隊長，重新提出名單`) : '表決中（不記名）';
  return h('section', { class: 'vote-box' + (closed ? (t.passed ? ' pass' : ' fail') : '') },
    h('div', { class: 'row between' }, h('b', {}, head), h('span', { class: 'mono' }, count)),
    capRow,
    t.team && t.team.length ? h('p', { class: 'small' }, `出任務名單：${t.team.join('・')} 號`) : null,
    closed || t.paper ? null : h('div', { class: 'row', style: { gap: '6px' } },
      t.required.map((s) => h('span', { class: 'vote-chip ' + ((t.votes || {})[s] ? 'done' : 'wait') }, `${s}`, h('b', {}, (t.votes || {})[s] ? '已投' : '…')))),
    closed ? null : h('p', { class: 'muted tiny' }, t.pending.length ? `等待 ${t.pending.join('、')} 號投票；全部投完會自動計票。只顯示票數，不顯示誰投什麼。` : ''),
    h('div', { class: 'row' },
      closed ? (vetoed || t.passed ? null : (opts.offline ? null : h('button', { class: 'btn', onclick: start, disabled: !phoneSeats.length }, '重新手機表決')))
        : h('button', { class: 'btn', onclick: () => S.closeVote(g) }, '結束表決並計票'),
      closed ? null : h('button', { class: 'btn', onclick: () => S.clearVote(g) }, '取消這次表決')),
    closed && !vetoed && !t.passed ? paperRow : null);
}
