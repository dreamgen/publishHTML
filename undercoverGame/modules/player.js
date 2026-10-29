// 玩家版（僅線上）：玩家掃自己的信封，在手機上按住查看自己的角色。
// 防偷看：平常遮蔽、按住才顯示、放開／切 App／8 秒自動蓋回；真誠大人與虛偽大人版面一致；一個信封只綁一支手機。
import { h, toast, openScanner, iconEl } from './ui.js';
import { EventSession, deviceId } from './session.js';
import { ROLE, MISSION, ROLE_TEXT, VOTE_LOCK, VETO_LIMIT, roleTitle, needText, fmtNum, QR } from './rules.js';
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
  // 用手機相機直接掃座位 QR 開啟時，app.js 會把座位資訊暫存在 seatTok
  const pendingSeat = info.seatTok || null;
  if (pendingSeat) jset(LS_PLAYER, { ...info, seatTok: undefined });
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
    if (!S.batch) return null;
    const p = jget(LS_PLAYER);
    if (p && p.code) {
      const g = S.findEnvelope(p.set, p.code);
      const b = g && S.playerBinding(g, p.code);
      if (g && g === p.g && p.batch === S.batch.no && b && b.device === me) return p;
    }
    // 自動抽角色被重排座位、或本機紀錄遺失時，依資料庫裡這支手機的綁定找回
    const c = S.myClaim(me);
    if (!c) return null;
    const q = { ev: S.ev, batch: S.batch.no, g: c.g, set: S.groupCfg(c.g).set, code: c.code };
    jset(LS_PLAYER, q);
    return q;
  };
  const save = (r) => jset(LS_PLAYER, { ev: S.ev, batch: S.batch.no, g: r.g, set: S.groupCfg(r.g).set, code: r.code });
  // 自動抽角色：領座位（掃座位 QR 帶 nonce；自選不帶）
  const takeSeat = (g, seat, nonce = null) => S.claimSeat(g, seat, me, nonce).then((r) => { save(r); ui.pick = null; render(); }).catch((e) => {
    if (e.message === 'TAKEN') { ui.taken = { g, seat }; render(); } else toast(e.message, 'bad');
  });
  const useSeatQr = (q) => {
    if (q.ev !== S.ev) return '這是別的活動的座位 QR 碼';
    if (!S.batch || q.batch !== S.batch.no) return '這個座位 QR 碼已過期（梯次已更換）';
    takeSeat(q.g, q.seat, q.nonce);
    return true;
  };

  const scan = (title = '掃我的信封', hint = '用手遮住信封，只掃自己的') => openScanner({
    title, hint,
    onResult: (t) => {
      const q = QR.parse(t);
      if (q.type === 'seat') return useSeatQr(q);
      // 相機掃到：UG:E:A:Q-1234:v3；手動輸入：Q-1234 或 1234
      if (q.type !== 'envelope' && q.type !== 'code') return '這不是信封上的 QR 碼或代號，手動輸入請填 4 位數字（例如 4827）';
      if (q.type === 'envelope' && (!S.qr || q.v !== S.qr.version)) return '這是舊版貼紙，請洽工作人員';
      let set = q.set;
      if (!set) set = ['A', 'B'].find((s) => S.qr && S.qr.sets && S.qr.sets[s] && S.qr.sets[s][q.code]);
      if (!set) return `找不到代號 ${q.code}，請確認信封上的號碼`;
      const g = S.findEnvelope(set, q.code);
      if (!g) return '這個信封還沒有被綁定到本梯次的座位，請稍候或洽工作人員';
      if (S.isAuto(g)) return '本組沒有信封，請掃工作人員給你的座位 QR 碼，或在畫面上選座位號';
      S.claimEnvelope(g, q.code, me).then(() => {
        jset(LS_PLAYER, { ev: S.ev, batch: S.batch.no, g, set, code: q.code });
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
    if (ui.taken) { const t = ui.taken; ui.taken = null; return app.replaceChildren(takenView(t)); }
    const p = current();
    if (!p) return app.replaceChildren(autoGroups().length ? autoEntryView() : entryView());
    if (S.playerCfg.revealed) return app.replaceChildren(endView(p));
    if (S.isAuto(p.g) && !S.handOpen(p.g)) return app.replaceChildren(waitView(p));
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
      h('footer', {}, h('button', { class: 'p-btn', onclick: () => scan() }, iconEl('scan'), '掃我的信封'),
        h('span', { class: 'p-muted small', style: { textAlign: 'center' } }, '相機掃不到時，可在掃描視窗下方輸入信封上的 4 位數字'),
        h('span', { class: 'p-muted', style: { textAlign: 'center', fontSize: '11px' } }, `程式版本 ${window.__UG_VERSION || ''}`)));
  }

  // ── 自動抽角色（無實體卡片）──────────────────────────────
  const autoGroups = () => Object.keys((S.batch && S.batch.groups) || {}).map(Number).filter((g) => S.isAuto(g)).sort();
  function autoEntryView() {
    const gs = autoGroups(), hasPhysical = Object.keys(S.batch.groups).length > gs.length;
    const pickable = gs.filter((g) => !S.handLocked(g));
    if (!ui.pick || !pickable.includes(ui.pick.g)) ui.pick = { g: pickable[0] || gs[0], seat: null };
    const g = ui.pick.g, cfg = S.groupCfg(g), claimed = S.claimedSeats(g);
    const selfOk = pickable.includes(g);
    return pshell('領取我的角色卡', `第 ${S.batch.no} 梯次`,
      h('button', { class: 'p-btn', onclick: () => scan('掃座位 QR 碼', '掃工作人員手機或螢幕上顯示的、你的座位 QR 碼') }, iconEl('scan'), '掃工作人員給我的座位 QR'),
      selfOk ? h('div', { class: 'p-or' }, h('span', {}), '或自己選', h('span', {})) : null,
      selfOk ? h('section', { class: 'p-card' },
        gs.length > 1 ? h('fieldset', { class: 'p-field' }, h('legend', {}, '我在第幾組'),
          h('div', { class: 'p-grid2' }, gs.map((n) => h('button', {
            class: 'p-opt', type: 'button', 'aria-pressed': String(n === g), disabled: !pickable.includes(n),
            onclick: () => { ui.pick = { g: n, seat: null }; render(); },
          }, `第 ${n} 組`)))) : null,
        h('fieldset', { class: 'p-field' }, h('legend', {}, '我的座位號碼（看桌上的號碼牌）'),
          h('div', { class: 'p-grid4' }, Array.from({ length: cfg.size }, (_, i) => i + 1).map((s) => h('button', {
            class: 'p-opt mono' + (claimed.includes(s) ? ' taken' : ''), type: 'button', 'aria-pressed': String(ui.pick.seat === s),
            disabled: claimed.includes(s), 'aria-label': `${s} 號${claimed.includes(s) ? '（已有人領）' : ''}`,
            onclick: () => { ui.pick.seat = s; render(); },
          }, s))),
          h('span', { class: 'p-muted small' }, '劃線的號碼已經有人領了。'))) 
        : h('p', { class: 'p-note' }, '本組已開放查看，不能再自己選座位。請舉手請工作人員顯示你的座位 QR 碼。'),
      hasPhysical ? h('button', { class: 'p-btn ghost', onclick: () => scan() }, '我有信封：掃我的信封') : null,
      h('footer', {},
        selfOk ? h('button', { class: 'p-btn', disabled: !ui.pick.seat, onclick: () => takeSeat(g, ui.pick.seat) }, ui.pick.seat ? `確認：我是第 ${g} 組 ${ui.pick.seat} 號` : '請先選座位號碼') : null,
        h('span', { class: 'p-muted small', style: { textAlign: 'center' } }, '全組都領取、主持人開放後才會看到角色；選錯可以再改')));
  }
  function waitView(p) {
    const cfg = S.groupCfg(p.g), seat = S.seatOf(p.g, p.code), n = S.claimedSeats(p.g).length;
    return pshell('已領取座位', `第 ${S.batch.no} 梯次・第 ${p.g} 組`,
      h('section', { class: 'p-card center p-me' },
        h('span', { class: 'p-muted' }, '我是'), h('b', { class: 'mono' }, seat), h('span', { style: { fontWeight: 700 } }, '號'),
        h('span', { class: 'p-muted small' }, '主持人請大家舉起手機核對時，確認這個號碼和你的座位牌一樣。')),
      h('section', { class: 'p-card', 'aria-live': 'polite' },
        h('div', { class: 'row between' }, h('b', {}, '等全組入座'), h('span', { class: 'p-muted' }, `${n} / ${cfg.size} 已領取`)),
        h('div', { class: 'p-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(cfg.size), 'aria-valuenow': String(n), 'aria-label': '入座進度' },
          h('span', { style: { width: `${Math.round((n / cfg.size) * 100)}%` } })),
        h('span', { class: 'p-muted small' }, '角色還沒有顯示。全組都領取、主持人按「開放查看」後，這裡會換成按住查看的角色卡。')),
      S.handLocked(p.g) ? h('p', { class: 'p-note' }, '主持人暫時蓋住了畫面，請稍候。') : null,
      h('footer', {},
        S.handLocked(p.g) ? null : h('button', { class: 'p-btn ghost', onclick: () => S.releaseSeat(p.g, p.code, me).then(() => { jset(LS_PLAYER, { ev: S.ev }); render(); }).catch((e) => toast(e.message, 'bad')) }, '選錯了，改座位'),
        h('span', { class: 'p-muted small', style: { textAlign: 'center' } }, '開放查看後就不能自己改，請找工作人員')));
  }
  function takenView(t) {
    return pshell('這個座位已經有人領了', `第 ${S.batch.no} 梯次・第 ${t.g} 組・${t.seat} 號`,
      h('section', { class: 'p-card', role: 'alert' },
        h('h2', {}, '先確認你坐的號碼'),
        h('ul', {}, h('li', {}, '看桌上的座位牌，再選一次。'), h('li', {}, `確定是 ${t.seat} 號：可能有人選錯，請舉手找工作人員重設。`))),
      h('p', { class: 'p-note' }, '開放查看前，誰都看不到角色，所以選錯不會洩漏身分。'),
      h('footer', {}, h('button', { class: 'p-btn', onclick: () => render() }, '重新選座位')));
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
    const open = S.viewOpen(p.g);
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
      // 先出現角色圖，下方文字區塊再淡入（見 styles.css 的 p-img／p-info 動畫）
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
          h('div', {}, h('span', {}, '存款'), h('b', { class: resCls(ledger.money, S.roleBase(role.id).money) }, fmtNum(ledger.money))),
          h('div', {}, h('span', {}, '特休'), h('b', { class: resCls(ledger.leave, S.roleBase(role.id).leave) }, ledger.leave)),
          h('div', {}, h('span', {}, '體力'), h('b', {}, eff.power)),
          h('div', {}, h('span', {}, '交通'), h('b', {}, eff.car))))) : null);
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
        votePanel(p, role, seat),
        h('section', { class: 'p-card p-task' },
          h('span', { class: 'p-label' }, '本回合任務・大家都看得到'),
          h('b', { style: { fontSize: '18px' } }, m ? m.name : '等待控場講師發布'),
          m ? h('span', { class: 'p-muted' }, `3 人合計：${needText(m)}`) : null),
        pad),
      h('footer', { class: 'center' },
        h('span', { class: 'p-muted small' }, '切到別的 App、關螢幕或 8 秒後都會自動蓋回'),
        h('span', { class: 'p-muted small' }, '發言時只能說程度，不能說數字')));
  }

  // 資源顏色：因任務成功扣除過＝綠色，歸零＝紅色
  function resCls(v, base) { return v === 0 ? 'res-zero' : v < base ? 'res-down' : ''; }

  // O／X 表決面板（平常畫面顯示，按住查看角色時隱藏）
  function votePanel(p, role, seat) {
    const t = S.tally(p.g);
    const cap = S.captain(p.g);
    if (!t || t.round !== S.control.round) {
      return S.control.missionId ? h('section', { class: 'p-card p-task p-vote' },
        h('span', { class: 'p-label' }, '輪值隊長'), h('b', { style: { fontSize: '20px' } }, `${cap} 號`),
        h('span', { class: 'p-muted small' }, `由隊長提出 3 人名單；本回合已否決 ${S.voteFails(p.g)} 次（${VETO_LIMIT} 次就無法派人）`)) : null;
    }
    if (t.paper) {
      return h('section', { class: 'p-card p-task p-vote ' + (t.passed ? 'pass' : 'fail') },
        h('span', { class: 'p-label' }, '表決結果'),
        h('b', { style: { fontSize: '20px' } }, t.passed ? '通過：隊伍出發' : `否決：換 ${cap} 號當隊長`));
    }
    const mine = (t.votes || {})[seat];
    const team = (t.team && t.team.length ? `出任務名單：${t.team.join('・')} 號` : '對隊長提出的名單表決') + '（不記名）';
    if (t.status === 'closed') {
      return h('section', { class: 'p-card p-task p-vote ' + (t.passed ? 'pass' : 'fail') },
        h('span', { class: 'p-label' }, '表決結果'),
        h('b', { style: { fontSize: '20px' } }, t.passed ? '通過：隊伍出發' : `否決：換 ${cap} 號當隊長`),
        h('span', { class: 'p-muted' }, `O ${t.o}・X ${t.x}`));
    }
    if (mine) {
      return h('section', { class: 'p-card p-task p-vote' },
        h('span', { class: 'p-label' }, '表決中'),
        h('b', {}, `你已投 ${mine}`),
        h('span', { class: 'p-muted small' }, `${team}・已投 ${t.o + t.x} 人，等待 ${t.pending.length} 人`));
    }
    const lock = VOTE_LOCK[role.id];
    const cast = (v) => S.castVote(p.g, t.id, seat, v).catch((e) => toast(e.message, 'bad'));
    return h('section', { class: 'p-card p-task p-vote' },
      h('span', { class: 'p-label' }, '請表決'),
      h('span', {}, team),
      h('div', { class: 'p-vote-btns' },
        h('button', { class: 'p-vbtn o', type: 'button', disabled: lock === 'X', onclick: () => cast('O'), 'aria-label': '投 O（同意）' }, 'O'),
        h('button', { class: 'p-vbtn x', type: 'button', disabled: lock === 'O', onclick: () => cast('X'), 'aria-label': '投 X（反對）' }, 'X')),
      lock ? h('span', { class: 'p-muted small' }, '有一個選項目前不能選') : null);
  }

  function endView(p) {
    document.body.classList.remove('player-theme');
    const map = S.mapping(p.g), role = ROLE[map[p.code]], hist = S.history(p.g, p.code);
    const seats = S.seats(p.g);
    return h('div', { class: 'phone' },
      h('header', {}, h('div', {}, h('span', { class: 'eyebrow' }, '遊戲結束・已揭牌'), h('h1', {}, `我是 ${hist.seat} 號：`, h('span', { class: role.camp === 'spy' ? 'spy-red' : '' }, role.name)),
        h('p', { class: 'muted small' }, h('span', { class: role.camp === 'spy' ? 'spy-red' : '' }, roleTitle(role.id).split('・')[0]), '・' + ROLE_TEXT[role.id].sub))),
      h('main', {},
        h('section', { class: 'card' }, h('h2', {}, '我在這場遊戲中'),
          hist.log.length ? h('ol', { class: 'list' }, hist.log.map((y) => h('li', { style: { minHeight: '40px' } },
            h('b', { class: 'tiny', style: { width: '48px' } }, y.adjust ? '修正' : `第 ${y.round} 回`),
            h('span', { class: 'small' }, y.adjust ? '主持人修正資源' : `${MISSION[y.mid].name}・${y.timeout ? `未成行（${y.reason}）` : y.inTeam ? '出任務・' + (y.ok ? '成功' : '失敗（' + y.reason + '）') : '未出任務'}`))))
            : h('p', { class: 'muted small' }, '沒有回合紀錄。')),
        h('section', { class: 'card' }, h('h2', {}, '本組的身分'),
          h('div', { class: 'grid g2 small' }, Object.keys(seats).map(Number).sort((a, b) => a - b).map((s) => {
            const r = ROLE[map[seats[s]]];
            return h('span', { class: r.camp === 'spy' ? 'spy-red' : '' }, h('b', {}, s), '　', r.name, r.camp === 'spy' ? '（虛偽大人）' : '');
          }))),
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
  if (pendingSeat) { const r = useSeatQr(pendingSeat); if (r !== true) toast(r, 'bad'); }
}

function pshell(title, sub, ...body) {
  const footer = body.length && body[body.length - 1] && body[body.length - 1].tagName === 'FOOTER' ? body.pop() : null;
  return h('div', { class: 'p-phone' },
    h('header', {}, h('div', {}, h('span', { class: 'p-label' }, '勿虛心假意・玩家'), h('h1', {}, title), sub ? h('span', { class: 'p-muted' }, sub) : null)),
    h('main', {}, ...body), footer);
}
