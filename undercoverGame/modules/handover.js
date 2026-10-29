// 交給玩家：沒有手機的玩家，借助理主持人的手機查看角色卡或投票。
// 畫面與玩家版相同（深色、按住才顯示、放開立刻蓋回），不顯示任何工作人員資訊；
// 要長按「交回工作人員」才能回到助理主持人畫面，避免玩家順手翻到別人的資料。
import { h, toast } from './ui.js';
import { ROLE, ROLE_TEXT, VOTE_LOCK, roleTitle, needText, fmtNum } from './rules.js';

const PEEK_MS = 8000;
const HOLD_MS = 1000;

/** 長按才觸發的按鈕（工作人員收回手機用） */
function holdBtn(label, fn) {
  let t = 0;
  const cancel = (e) => { clearTimeout(t); e.currentTarget.classList.remove('holding'); };
  return h('button', {
    class: 'p-btn ghost p-hold', type: 'button', 'aria-label': `${label}（長按 1 秒）`,
    onpointerdown: (e) => { const el = e.currentTarget; el.classList.add('holding'); t = setTimeout(() => { el.classList.remove('holding'); fn(); }, HOLD_MS); },
    onpointerup: cancel, onpointerleave: cancel, onpointercancel: cancel,
    oncontextmenu: (e) => e.preventDefault(),
  }, h('span', { class: 'p-hold-bar', 'aria-hidden': 'true' }), h('span', {}, label));
}

function frame(S, g, seat, chip, ...body) {
  const footer = body.pop();
  return h('div', { class: 'p-phone handover' },
    h('header', {},
      h('div', {}, h('span', { class: 'p-label' }, `第 ${S.batch.no} 梯次・第 ${g} 組`), h('h1', {}, `我是 ${seat} 號`)),
      h('span', { class: 'p-chip', 'data-chip': chip }, chip)),
    h('main', {}, ...body), footer);
}

/** 角色卡（按住查看） */
export function handoverCard(S, g, code, onExit) {
  const seat = S.seatOf(g, code);
  const role = ROLE[S.mapping(g)[code]], text = ROLE_TEXT[role.id];
  const eff = S.stats(g, code), base = S.roleBase(role.id);
  const resCls = (v, b) => (v === 0 ? 'res-zero' : v < b ? 'res-down' : '');
  const c = S.control, m = c.missionId ? S.mission(c.missionId) : null;
  let timer = 0, root = null;
  const setPeek = (on) => { if (root) root.classList.toggle('peeking', on); };
  const hide = () => { clearTimeout(timer); setPeek(false); };
  const show = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const pad = e && e.currentTarget;
    if (pad && e.pointerId != null && pad.setPointerCapture) { try { pad.setPointerCapture(e.pointerId); } catch (err) { /* */ } }
    setPeek(true);
    clearTimeout(timer); timer = setTimeout(hide, PEEK_MS);
    navigator.vibrate && navigator.vibrate(15);
  };
  const pad = h('button', {
    class: 'p-pad', type: 'button', 'aria-label': '按住查看我的角色，放開即隱藏',
    onpointerdown: show, onpointerup: hide, onpointercancel: hide, onlostpointercapture: hide,
    onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') show(e); }, onkeyup: hide,
    oncontextmenu: (e) => e.preventDefault(),
  },
  h('div', { class: 'p-veil' },
    h('b', { style: { fontSize: '20px' } }, '按住查看我的角色'),
    h('span', { class: 'p-muted small' }, '放開立刻蓋回・先用手遮住螢幕再按')),
  h('div', { class: 'p-reveal', 'aria-live': 'polite' },
    h('img', { class: 'p-img', src: `./roles/role-${role.id}.jpg`, alt: '', 'aria-hidden': 'true', draggable: 'false' }),
    h('div', { class: 'p-shade', 'aria-hidden': 'true' }),
    h('div', { class: 'p-info' },
      h('span', { class: 'p-label' }, '我的身分'),
      h('span', { class: 'p-title' }, roleTitle(role.id)),
      h('span', { class: 'p-muted small' }, text.sub),
      h('hr'),
      h('span', { class: 'p-label' }, '我的目標'), h('ul', {}, text.goals.map((t) => h('li', {}, t))),
      h('span', { class: 'p-label' }, '我要做的事'), h('ul', {}, text.todo.map((t) => h('li', {}, t))),
      h('div', { class: 'p-res' },
        h('div', {}, h('span', {}, '存款'), h('b', { class: resCls(eff.money, base.money) }, fmtNum(eff.money))),
        h('div', {}, h('span', {}, '特休'), h('b', { class: resCls(eff.leave, base.leave) }, eff.leave)),
        h('div', {}, h('span', {}, '體力'), h('b', {}, eff.power)),
        h('div', {}, h('span', {}, '交通'), h('b', {}, eff.car))))));
  root = frame(S, g, seat, '借用手機',
    h('section', { class: 'p-card p-task' },
      h('span', { class: 'p-label' }, '本回合任務・大家都看得到'),
      h('b', { style: { fontSize: '18px' } }, m ? m.name : '等待控場講師發布'),
      m ? h('span', { class: 'p-muted' }, `3 人合計：${needText(m)}`) : null),
    pad,
    h('footer', { class: 'center' },
      h('span', { class: 'p-muted small' }, '看完請把手機交回工作人員；8 秒後也會自動蓋回'),
      holdBtn('工作人員收回', () => { hide(); onExit(); })));
  return root;
}

/** O／X 表決（不記名：投完只顯示「已投票」，不顯示投了什麼） */
export function handoverVote(S, g, code, onExit) {
  const seat = +S.seatOf(g, code);
  const role = ROLE[S.mapping(g)[code]];
  const t = S.tally(g);
  const lock = VOTE_LOCK[role.id];
  const team = t && t.team && t.team.length ? `出任務名單：${t.team.join('・')} 號` : '對隊長提出的名單表決';
  const voted = !!(t && (t.votes || {})[seat]);
  const done = voted || !t || t.status !== 'open';
  const cast = (v) => S.castVote(g, t.id, seat, v).catch((e) => toast(e.message, 'bad'));
  const body = done
    ? h('section', { class: 'p-card center' },
      h('b', { style: { fontSize: '22px' } }, voted ? '已投票' : '這次表決已結束'),
      h('span', { class: 'p-muted' }, '請把手機交回工作人員。'))
    : h('section', { class: 'p-card p-task p-vote' },
      h('span', { class: 'p-label' }, '請表決（不記名）'),
      h('span', {}, team),
      h('div', { class: 'p-vote-btns' },
        h('button', { class: 'p-vbtn o', type: 'button', disabled: lock === 'X', onclick: () => cast('O'), 'aria-label': '投 O（同意）' }, 'O'),
        h('button', { class: 'p-vbtn x', type: 'button', disabled: lock === 'O', onclick: () => cast('X'), 'aria-label': '投 X（反對）' }, 'X')),
      lock ? h('span', { class: 'p-muted small' }, '有一個選項目前不能選') : null,
      h('span', { class: 'p-muted small' }, '用手遮住螢幕再按；按下後就不能改。'));
  return frame(S, g, seat, '借用手機', body,
    h('footer', { class: 'center' }, holdBtn('工作人員收回', onExit)));
}
