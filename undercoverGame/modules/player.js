// 玩家版（僅線上）：玩家掃自己的信封，在手機上按住查看自己的角色。
// 防偷看：平常遮蔽、按住才顯示、放開／切 App／8 秒自動蓋回；好人與臥底版面一致；一個信封只綁一支手機。
import { h, toast, openScanner, iconEl } from './ui.js';
import { EventSession, deviceId } from './session.js';
import { ROLE, MISSION, ROLE_TEXT, roleTitle, needText, fmtNum, QR } from './rules.js';
import { setUnmount } from './nav.js';
import { noticeBanner } from './notice.js';

const LS_PLAYER = 'ug.player';
const PEEK_MS = 8000;
const jget = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const jset = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } };

export async function mountPlayer(app) {
  document.body.classList.add('player-theme');
  const info = jget(LS_PLAYER);
  if (!info || !info.ev) {
    app.replaceChildren(pshell('查看我的角色', null,
      h('section', { class: 'p-card' }, h('p', {}, '請掃工作人員投影或桌上的「玩家入口」QR 碼進入。')),
      h('a', { class: 'p-btn ghost', href: '#/' }, '回首頁')));
    setUnmount(() => document.body.classList.remove('player-theme'));
    return;
  }
  app.replaceChildren(pshell('查看我的角色', null, h('p', { class: 'p-muted' }, '連線中…')));
  let S;
  try { S = await new EventSession('online', info.ev).start(); } catch (e) {
    app.replaceChildren(pshell('無法連線', null, h('p', { class: 'p-muted' }, e.message), h('button', { class: 'p-btn', onclick: () => mountPlayer(app) }, '重試')));
    return;
  }
  const me = deviceId();
  const ui = { peek: false, timer: 0 };

  // 只切換 class，不重畫 DOM，避免按住中元素被替換而收不到放開事件
  const setPeek = (on) => {
    ui.peek = on;
    const root = app.querySelector('.p-phone');
    if (root) root.classList.toggle('peeking', on);
    const chip = app.querySelector('[data-chip]');
    if (chip) chip.textContent = on ? '按住中' : chip.dataset.chip;
  };
  const hide = () => { clearTimeout(ui.timer); if (ui.peek) setPeek(false); };
  const show = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const pad = app.querySelector('.p-pad');
    if (!pad || pad.disabled || ui.peek) return;
    if (e && e.pointerId != null && pad.setPointerCapture) { try { pad.setPointerCapture(e.pointerId); } catch (err) { /* */ } }
    setPeek(true);
    clearTimeout(ui.timer); ui.timer = setTimeout(hide, PEEK_MS);
    navigator.vibrate && navigator.vibrate(15);
  };
  const onVis = () => { if (document.hidden) hide(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', hide);
  window.addEventListener('pagehide', hide);

  // 目前綁定的信封是否仍有效（梯次可能已更換）
  const current = () => {
    const p = jget(LS_PLAYER);
    if (!p || !p.code || !S.batch) return null;
    const g = S.findEnvelope(p.set, p.code);
    if (!g || g !== p.g || p.batch !== S.batch.no) return null;
    const b = S.playerBinding(g, p.code);
    if (!b || b.device !== me) return null;
    return p;
  };

  const scan = () => openScanner({
    title: '掃我的信封', hint: '用手遮住信封，只掃自己的',
    onResult: (t) => {
      const q = QR.parse(t);
      if (q.type !== 'envelope') return '這不是信封 QR 碼';
      if (!S.qr || q.v !== S.qr.version) return '這是舊版貼紙，請洽工作人員';
      const g = S.findEnvelope(q.set, q.code);
      if (!g) return '這個信封還沒有被綁定到本梯次的座位，請稍候或洽工作人員';
      S.claimEnvelope(g, q.code, me).then(() => {
        jset(LS_PLAYER, { ev: S.ev, batch: S.batch.no, g, set: q.set, code: q.code });
        render();
      }).catch((e) => {
        if (e.message === 'LOCKED') { ui.locked = true; render(); } else toast(e.message, 'bad');
      });
      return true;
    },
  });

  function render() {
    ui.peek = false; clearTimeout(ui.timer);
    if (!S.batch) return app.replaceChildren(pshell('查看我的角色', null, h('section', { class: 'p-card' }, h('p', {}, '工作人員還在準備本梯次，請稍候。'))));
    if (ui.locked) { ui.locked = false; return app.replaceChildren(lockedView()); }
    const p = current();
    if (!p) return app.replaceChildren(entryView());
    if (S.playerCfg.revealed) return app.replaceChildren(endView(p));
    app.replaceChildren(cardView(p));
  }

  function entryView() {
    const step = (n, t) => h('li', {}, h('span', { class: 'p-num' }, n), h('span', {}, t));
    return pshell('查看我的角色', `第 ${S.batch.no} 梯次`,
      h('section', { class: 'p-card' },
        h('h2', {}, '掃描前，先做三件事'),
        h('ol', { class: 'p-steps' },
          step(1, '把手機拿低、貼近胸前，螢幕朝向自己。'),
          step(2, '用另一隻手遮住信封與螢幕。'),
          step(3, '只掃自己的信封。每個信封只能在一支手機上開啟。'))),
      h('p', { class: 'p-note' }, '掃完後畫面會先蓋住。要看角色時，按住畫面中間才會顯示，放開立刻蓋回。'),
      S.playerCfg.open ? null : h('p', { class: 'p-note' }, '玩家查看尚未開放，可以先掃描，開放後即可查看。'),
      h('footer', {}, h('button', { class: 'p-btn', onclick: scan }, iconEl('scan'), '掃我的信封')));
  }

  function lockedView() {
    return pshell('無法開啟這個信封', null,
      h('section', { class: 'p-card center' },
        h('b', { style: { fontSize: '18px' } }, '這個信封已在另一支手機開啟'),
        h('p', { class: 'p-muted' }, '每個信封只能在一支手機上查看，畫面不會顯示任何角色資訊。')),
      h('p', {}, '如果這是你自己的信封（例如換了手機），請舉手請助理主持人協助「重設手機綁定」，再重新掃描。'),
      h('footer', {}, h('button', { class: 'p-btn ghost', onclick: () => render() }, '回上一頁')));
  }

  function cardView(p) {
    const c = S.control, seat = S.seatOf(p.g, p.code);
    const m = c.missionId ? S.mission(c.missionId) : null;
    const open = S.playerCfg.open;
    const role = ROLE[S.mapping(p.g)[p.code]], text = ROLE_TEXT[role.id];
    const eff = S.stats(p.g, p.code);
    const ledger = { money: eff.money, leave: eff.leave };
    const pad = h('button', {
      class: 'p-pad', type: 'button', disabled: !open,
      'aria-label': open ? '按住查看我的角色，放開即隱藏' : '玩家查看尚未開放',
      onpointerdown: show, onpointerup: hide, onpointercancel: hide, onlostpointercapture: hide,
      onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') show(e); }, onkeyup: hide,
      oncontextmenu: (e) => e.preventDefault(),
    },
    h('div', { class: 'p-veil' },
      h('span', { class: 'p-hand', 'aria-hidden': 'true', html: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V6a1.5 1.5 0 0 1 3 0v5M12 10V4.5a1.5 1.5 0 0 1 3 0V11M15 10.5V7a1.5 1.5 0 0 1 3 0v6.5a6.5 6.5 0 0 1-6.5 6.5h-.3a6 6 0 0 1-4.6-2.2L4 14.5a1.5 1.5 0 0 1 2.3-1.9L9 15"/></svg>' }),
      h('b', { style: { fontSize: '20px' } }, open ? '按住查看我的角色' : '玩家查看尚未開放'),
      h('span', { class: 'p-muted small' }, open ? '放開立刻蓋回・先用手遮住螢幕再按' : '請等工作人員宣布開放')),
    open ? h('div', { class: 'p-reveal', 'aria-live': 'polite' },
      h('span', { class: 'p-label' }, '我的身分'),
      h('span', { class: 'p-title' }, roleTitle(role.id)),
      h('span', { class: 'p-muted small' }, text.sub),
      h('hr'),
      h('span', { class: 'p-label' }, '我的目標'), h('ul', {}, text.goals.map((t) => h('li', {}, t))),
      h('span', { class: 'p-label' }, '我要做的事'), h('ul', {}, text.todo.map((t) => h('li', {}, t))),
      h('hr'),
      h('span', { class: 'p-label' }, '我的資源（目前剩餘）'),
      h('div', { class: 'p-res' },
        h('div', {}, h('span', {}, '存款'), h('b', {}, fmtNum(ledger.money))),
        h('div', {}, h('span', {}, '特休'), h('b', {}, ledger.leave)),
        h('div', {}, h('span', {}, '體力'), h('b', {}, eff.power)),
        h('div', {}, h('span', {}, '交通'), h('b', {}, eff.car)))) : null);
    const chipText = c.round ? `第 ${c.round} 回合` : '準備中';
    return h('div', { class: 'p-phone' },
      h('header', {},
        h('div', {}, h('span', { class: 'p-label' }, `第 ${S.batch.no} 梯次・第 ${p.g} 組`), h('h1', {}, `我是 ${seat} 號`)),
        h('span', { class: 'p-chip', 'data-chip': chipText }, chipText)),
      h('main', {},
        noticeBanner(S, 'player', (n) => {
          const out = [];
          if (n.groups && n.groups[p.g] && (n.groups[p.g].codes || []).includes(p.code)) out.push('你的角色資料或資源已修正，請按住確認最新內容');
          if ((n.missions || []).length) out.push('任務條件已修正，請看最新條件');
          return out;
        }, { dark: true, onSeen: () => render() }),
        h('section', { class: 'p-card p-task' },
          h('span', { class: 'p-label' }, '本回合任務・大家都看得到'),
          h('b', { style: { fontSize: '18px' } }, m ? m.name : '等待控場講師發布'),
          m ? h('span', { class: 'p-muted' }, `3 人合計：${needText(m)}`) : null),
        pad),
      h('footer', { class: 'center' },
        h('span', { class: 'p-muted small' }, '切到別的 App、關螢幕或 8 秒後都會自動蓋回'),
        h('span', { class: 'p-muted small' }, '發言時只能說程度，不能說數字')));
  }

  function endView(p) {
    document.body.classList.remove('player-theme');
    const map = S.mapping(p.g), role = ROLE[map[p.code]], hist = S.history(p.g, p.code);
    const seats = S.seats(p.g);
    return h('div', { class: 'phone' },
      h('header', {}, h('div', {}, h('span', { class: 'eyebrow' }, '遊戲結束・已揭牌'), h('h1', {}, `我是 ${hist.seat} 號：${role.name}`),
        h('p', { class: 'muted small' }, roleTitle(role.id).split('・')[0] + '・' + ROLE_TEXT[role.id].sub))),
      h('main', {},
        h('section', { class: 'card' }, h('h2', {}, '我在這場遊戲中'),
          hist.log.length ? h('ol', { class: 'list' }, hist.log.map((y) => h('li', { style: { minHeight: '40px' } },
            h('b', { class: 'tiny', style: { width: '48px' } }, y.adjust ? '修正' : `第 ${y.round} 回`),
            h('span', { class: 'small' }, y.adjust ? '主持人修正資源' : `${MISSION[y.mid].name}・${y.timeout ? '未成行' : y.inTeam ? '出任務・' + (y.ok ? '成功' : '失敗（' + y.reason + '）') : '未出任務'}`))))
            : h('p', { class: 'muted small' }, '沒有回合紀錄。')),
        h('section', { class: 'card' }, h('h2', {}, '本組的身分'),
          h('div', { class: 'grid g2 small' }, Object.keys(seats).map(Number).sort((a, b) => a - b).map((s) => h('span', {}, h('b', {}, s), '　', ROLE[map[seats[s]]].name)))),
        h('div', { class: 'note ok' }, '討論時想一想：你在遊戲裡說的話、舉的牌，和你心裡真正的想法一致嗎？')));
  }

  const off = S.on(() => { if (!document.querySelector('.modal.scan')) render(); });
  setUnmount(() => {
    off(); S.stop(); clearTimeout(ui.timer);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('blur', hide); window.removeEventListener('pagehide', hide);
    document.body.classList.remove('player-theme');
  });
  render();
}

function pshell(title, sub, ...body) {
  const footer = body.length && body[body.length - 1] && body[body.length - 1].tagName === 'FOOTER' ? body.pop() : null;
  return h('div', { class: 'p-phone' },
    h('header', {}, h('div', {}, h('span', { class: 'p-label' }, '勿虛心假意・玩家'), h('h1', {}, title), sub ? h('span', { class: 'p-muted' }, sub) : null)),
    h('main', {}, ...body), footer);
}
