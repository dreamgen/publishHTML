// 自動抽角色（無實體卡片）：發角色卡面板（儀表板與助理主持人手機共用）
// 逐一顯示座位 QR（含隨機碼、不含角色）→ 玩家用手機掃描領取；玩家也可自己選座位號。
// 全組都領取後，控場按「開放查看角色」，玩家才看得到角色。
import { h, toast, confirmBox, qrImg } from './ui.js';
import { ROLE, QR } from './rules.js';

/**
 * st：此面板的畫面狀態（呼叫端保存，會直接修改）{ cur, full, showRoles }
 * opts.staffRoles：是否提供「顯示座位角色」與「重新排座位」（儀表板才有）
 */
export function handPanel(S, g, st, rerender, opts = {}) {
  const cfg = S.groupCfg(g), seats = S.seats(g), tokens = S.tokens(g);
  const nos = Array.from({ length: cfg.size }, (_, i) => i + 1);
  const claimed = S.claimedSeats(g);
  const left = nos.filter((s) => !claimed.includes(s));
  // 目前顯示的座位被領走了 → 自動跳到下一個還沒領的號碼
  if (!st.cur || claimed.includes(st.cur)) st.cur = left.find((s) => s > (st.cur || 0)) || left[0] || null;
  const cur = st.cur;
  const base = `${location.origin}${location.pathname}`;
  const url = cur ? QR.seat(base, S.ev, S.batch.no, g, cur, tokens[cur]) : null;
  const step = (d) => { if (!left.length) return; const i = left.indexOf(cur); st.cur = left[(i + d + left.length) % left.length]; rerender(); };
  const err = (e) => toast(e.message, 'bad');
  const open = S.handOpen(g);

  const seatBtn = (s) => {
    const done = claimed.includes(s), on = s === cur;
    return h('button', {
      class: 'btn hand-seat' + (done ? ' done' : on ? ' on' : ''), type: 'button',
      'aria-label': `${s} 號${done ? '已領取，點一下可重設' : on ? '正在顯示' : '未領取'}`,
      onclick: async () => {
        if (!done) { st.cur = s; rerender(); return; }
        if (await confirmBox(`重設 ${s} 號？`, '玩家選錯號或換手機時使用。重設後舊的座位 QR 失效，請重新顯示讓玩家掃描（開放前玩家也可以自己重選）。', '重設', true)) {
          S.resetPlayer(g, seats[s]).then(() => { st.cur = s; rerender(); }).catch(err);
        }
      },
    }, h('b', { class: 'mono' }, s), h('span', { class: 'tiny' }, done ? '已領取' : on ? '顯示中' : '未領取'));
  };

  const qrBlock = cur ? h('div', { class: 'hand-qr' },
    h('span', { class: 'small' }, `請 ${cur} 號用自己的手機掃描`),
    h('b', { class: 'mono hand-no' }, `${cur} 號`),
    qrImg(url, opts.qrSize || 220, `${cur} 號座位 QR 碼`),
    h('span', { class: 'muted tiny' }, 'QR 只含座位與隨機碼，不含角色；領走後立即失效。請勿投影這一區。'),
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', type: 'button', onclick: () => step(-1), 'aria-label': '上一個未領取的座位' }, '上一號'),
      h('button', { class: 'btn', type: 'button', onclick: () => { st.full = true; rerender(); } }, '全螢幕顯示'),
      h('button', { class: 'btn dark', type: 'button', onclick: () => step(1), 'aria-label': '下一個未領取的座位' }, '下一號')))
    : h('div', { class: 'note ok' }, open ? '已開放查看。' : '全組都已領取。請大家舉起手機核對畫面上的號碼和座位牌一致，再按「開放查看角色」。');

  const full = st.full && cur ? h('div', { class: 'qr-full', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${cur} 號座位 QR 碼` },
    h('b', { class: 'mono', style: { fontSize: '44px' } }, `第 ${g} 組・${cur} 號`),
    qrImg(url, Math.min(520, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.62)), `${cur} 號座位 QR 碼`),
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', type: 'button', onclick: () => step(-1) }, '上一號'),
      h('button', { class: 'btn dark', type: 'button', onclick: () => step(1) }, '下一號'),
      h('button', { class: 'btn', type: 'button', onclick: () => { st.full = false; rerender(); } }, '關閉'))) : null;

  const rolesBox = opts.staffRoles ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('div', { class: 'row between' },
      h('b', { class: 'small' }, '座位安排（系統隨機）'),
      h('div', { class: 'row' },
        h('button', { class: 'btn soft-bad', type: 'button', 'aria-pressed': String(!!st.showRoles), onclick: () => { st.showRoles = !st.showRoles; rerender(); } }, st.showRoles ? '遮蔽座位角色' : '顯示座位角色（勿投影）'),
        S.handLocked(g) ? null : h('button', {
          class: 'btn', type: 'button', onclick: async () => {
            if (await confirmBox('重新隨機排座位？', '已領取的手機會留在原本的座位號，只換角色。開放查看前沒有人看過角色，所以可以重排。', '重排')) S.reshuffleSeats(g).catch(err);
          },
        }, '重新隨機排座位'))),
    h('div', { class: 'grid g3' }, nos.map((s) => {
      const role = ROLE[S.mapping(g)[seats[s]]];
      return h('div', { class: 'hand-role' }, h('b', { class: 'mono' }, s),
        h('span', { style: { color: st.showRoles ? (role.camp === 'spy' ? 'var(--bad)' : 'var(--ok)') : 'var(--muted)', fontWeight: 700 } }, st.showRoles ? role.name : '••••••'));
    }))) : null;

  return h('section', { class: 'card hand' },
    h('div', { class: 'row between' }, h('h2', {}, `第 ${g} 組・發角色卡`), h('span', { class: 'muted small' }, `已領取 ${claimed.length} / ${cfg.size}`)),
    h('div', { class: 'cols' },
      h('div', { style: { flex: '0 1 300px', display: 'flex', flexDirection: 'column', gap: '8px' } }, qrBlock),
      h('div', { style: { flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { class: 'grid g6' }, nos.map(seatBtn)),
        h('span', { class: 'muted tiny' }, '點未領取的座位顯示它的 QR；點已領取的座位可重設。玩家也可以在玩家頁自己選組別與座位號。'),
        rolesBox)),
    open ? h('div', { class: 'row between' }, h('span', { class: 'chip ok' }, '已開放查看'), h('button', { class: 'btn', type: 'button', onclick: () => S.closeHand(g).catch(err) }, '暫時蓋住玩家畫面'))
      : h('div', { class: 'row end' },
        left.length ? h('button', {
          class: 'btn soft-bad', type: 'button', onclick: async () => {
            if (await confirmBox(`還有 ${left.length} 位沒領取，仍要開放？`, `未領取：${left.join('、')} 號。開放後這些座位只能由工作人員顯示座位 QR 領取（不能自選），沒手機的人可用工作人員手機查看。`, '強制開放', true)) S.openHand(g, true).catch(err);
          },
        }, '強制開放') : null,
        h('button', { class: 'btn primary', type: 'button', disabled: !!left.length, onclick: () => S.openHand(g).catch(err) }, left.length ? `還差 ${left.length} 位・無法開放` : '開放查看角色')),
    full);
}
