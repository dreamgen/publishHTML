// 控場講師儀表板：建立活動、信封 QR 版本與列印、梯次與組別設定、回合控制
import { h, toast, confirmBox, qrImg, iconEl, fmtClock, wakeLock } from './ui.js';
import { EventSession } from './session.js';
import { connect } from './fb.js';
import {
  ROLE, MISSIONS, MISSION, SABOTAGE, DISRUPT, ROUND_LIMIT_MS, KIND_LABEL,
  splitGroups, composition, buildGroupRoles, shuffle, generateMapping, needText, fmtNum, QR,
} from './rules.js';
import { setUnmount } from './nav.js';

const LS_EV = 'ug.dash.ev';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* */ } };

function randomEv() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
}

export async function mountDashboard(app) {
  const ev = lsGet(LS_EV);
  if (!ev) return entry(app);
  app.replaceChildren(h('main', { class: 'wrap' }, h('p', { class: 'muted' }, `連線到活動 ${ev}…`)));
  const S = await new EventSession('online', ev).start();
  if (!S.data) {
    lsSet(LS_EV, null);
    toast(`找不到活動 ${ev}`, 'bad');
    return entry(app);
  }
  return dashboard(app, S);
}

function entry(app) {
  const code = h('input', { type: 'text', placeholder: '例如 K7QM', 'aria-label': '活動代碼', maxlength: 4, style: { textTransform: 'uppercase' } });
  const create = async () => {
    try {
      const fb = await connect();
      let ev, tries = 0;
      do { ev = randomEv(); tries++; } while ((await fb.get(fb.evRef(ev))).exists() && tries < 5);
      await fb.set(fb.evRef(ev), {
        createdAt: Date.now(),
        qr: { version: 1, updatedAt: Date.now(), sets: generateMapping() },
        control: { round: 0, missionId: null, status: 'idle', accum: 0 },
      });
      lsSet(LS_EV, ev);
      mountDashboard(app);
    } catch (e) { toast(e.message, 'bad'); }
  };
  const open = () => {
    const v = code.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(v)) return toast('請輸入 4 碼活動代碼', 'bad');
    lsSet(LS_EV, v); mountDashboard(app);
  };
  app.replaceChildren(h('main', { class: 'wrap', style: { maxWidth: '720px' } },
    h('header', {}, h('div', {}, h('span', { class: 'eyebrow' }, '勿虛心假意・控場講師'), h('h1', {}, '儀表板')), h('a', { class: 'btn', href: '#/' }, iconEl('back'), '首頁')),
    h('section', { class: 'card' },
      h('h2', {}, '建立新活動'),
      h('p', { class: 'muted small' }, '整場活動（所有梯次）用同一個活動。建立時會產生 A、B 兩套各 13 個信封 QR 碼。'),
      h('button', { class: 'btn primary big', onclick: create }, '建立新活動')),
    h('section', { class: 'card' },
      h('h2', {}, '開啟既有活動'),
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); open(); } }, h('div', { class: 'flex1' }, code), h('button', { class: 'btn', type: 'submit' }, '開啟')))));
}

function dashboard(app, S) {
  let tab = S.batch ? 'control' : 'prep';
  let reveal = false;
  let form = null; // 梯次設定表單暫存
  let lastTimeUp = false;
  let lock = null;
  wakeLock().then((l) => { lock = l; });

  const ev = S.ev;
  const groupsOf = () => (S.batch ? Object.keys(S.batch.groups).map(Number).sort() : []);

  const initForm = () => {
    const b = S.batch;
    const total = b ? b.total : 12;
    form = { no: b ? b.no + 1 : 1, total, spies: {} };
    rollSpies();
  };
  const rollSpies = () => {
    let sizes;
    try { sizes = splitGroups(form.total); } catch (e) { form.error = e.message; form.sizes = []; return; }
    form.error = null; form.sizes = sizes; form.spies = {};
    sizes.forEach((size, i) => {
      const c = composition(size);
      form.spies[i + 1] = [...shuffle(SABOTAGE).slice(0, c.sab), ...shuffle(DISRUPT).slice(0, c.dis)];
    });
  };

  const render = () => {
    const c = S.control;
    const root = h('main', { class: 'wrap' },
      h('header', {},
        h('div', {}, h('span', { class: 'eyebrow' }, `勿虛心假意・控場講師・活動 ${ev}`),
          h('h1', {}, S.batch ? `第 ${S.batch.no} 梯次　${S.batch.total} 人・${groupsOf().length} 組` : '尚未建立梯次')),
        h('div', { class: 'row' },
          h('span', { class: 'chip ' + (S.online ? 'ok' : 'bad') }, S.online ? '已連線' : '連線中斷'),
          h('span', { class: 'chip bad' }, '請勿投影此畫面'),
          h('button', { class: 'btn', onclick: async () => { if (await confirmBox('切換活動', '回到活動選擇畫面（資料仍保留在雲端）。')) { lsSet(LS_EV, null); location.hash = '#/'; } } }, '切換活動'))),
      h('nav', { class: 'row', 'aria-label': '儀表板分頁' },
        ...[['prep', '活動前準備'], ['batch', '梯次與組別'], ['control', '回合控制']].map(([k, label]) =>
          h('button', { class: 'btn', 'aria-pressed': String(tab === k), onclick: () => { tab = k; if (k === 'batch') initForm(); render(); } }, label))),
      tab === 'prep' ? prepTab() : tab === 'batch' ? batchTab() : controlTab(c));
    app.replaceChildren(root);
  };

  // ── 活動前準備：QR 版本、列印 ─────────────────────────────
  function prepTab() {
    const q = S.qr;
    return h('div', { class: 'cols' },
      h('section', { class: 'card' },
        h('h2', {}, '信封 QR 碼（全場固定）'),
        h('p', { class: 'muted small' }, 'A、B 兩套各 13 個 QR 碼，固定對應 6 種臥底與 7 位好人（特殊大人 4、一般大人 A、B、C），所有梯次共用。每梯次依人數從套內取出要用的信封。'),
        h('div', { class: 'row' }, h('span', { class: 'chip' }, `目前版本 v${q.version}`), h('span', { class: 'muted tiny' }, '建立於 ' + new Date(q.updatedAt).toLocaleString('zh-TW'))),
        h('div', { class: 'row' },
          h('a', { class: 'btn dark', href: '#/print/labels' }, iconEl('print'), '列印貼紙（A、B 套）'),
          h('a', { class: 'btn', href: '#/print/map' }, iconEl('print'), '列印對照表（A、B 套）')),
        h('div', { class: 'note bad' }, '更新 QR 碼會重新配對所有代號，已印的貼紙與對照表全部作廢。只在活動前使用。'),
        h('button', {
          class: 'btn soft-bad', onclick: async () => {
            if (S.batch && !(await confirmBox('目前已有梯次', '更新後本梯次已綁定的座位也會失效，仍要更新？', '仍要更新', true))) return;
            if (!(await confirmBox('更新 QR 碼？', `將建立 v${q.version + 1}，舊版貼紙與對照表全部作廢，需要重新列印與裝填。`, '更新', true))) return;
            await S.patch({ qr: { version: q.version + 1, updatedAt: Date.now(), sets: generateMapping() }, live: null });
            toast(`已更新為 v${q.version + 1}`);
          },
        }, '更新 QR 碼（重新配對）')),
      h('section', { class: 'card' },
        h('h2', {}, '離線備援'),
        h('p', { class: 'muted small' }, '現場沒網路時，助理主持人在手機的離線模式掃這裡（或對照表上）的「離線載入 QR 碼」，就能取得該套信封的對照。'),
        h('div', { class: 'row', style: { justifyContent: 'space-around' } },
          ...['A', 'B'].map((set) => h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' } },
            qrImg(QR.map(q.version, set, q.sets[set]), 180, `${set} 套離線載入 QR 碼`), h('b', {}, `${set} 套 v${q.version}`))))));
  }

  // ── 梯次與組別 ───────────────────────────────────────────
  function batchTab() {
    if (!form) initForm();
    const b = S.batch;
    const groupCards = form.sizes.map((size, i) => {
      const g = i + 1, c = composition(size), set = g === 1 ? 'A' : 'B';
      const picks = form.spies[g];
      const sel = (idx, pool) => h('select', {
        'aria-label': pool === SABOTAGE ? '破壞型' : '干擾型',
        onchange: (e) => { picks[idx] = e.target.value; },
      }, pool.map((id) => h('option', { value: id, selected: picks[idx] === id }, ROLE[id].name)));
      return h('section', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', {}, `第 ${g} 組・${size} 人`), h('span', { class: 'muted small' }, `好人 ${c.good.length}・臥底 ${c.sab + c.dis}・信封 ${set} 套`)),
        h('p', { class: 'small' }, h('b', { style: { color: 'var(--ok)' } }, '好人　'), c.good.map((id) => ROLE[id].name).join('、')),
        h('div', { class: 'grid g2' },
          ...picks.slice(0, c.sab).map((_, k) => h('label', { class: 'field' }, `破壞型 ${k + 1}`, sel(k, SABOTAGE))),
          ...picks.slice(c.sab).map((_, k) => h('label', { class: 'field' }, `干擾型 ${k + 1}`, sel(c.sab + k, DISRUPT)))));
    });
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', alignItems: 'end' } },
          h('label', { class: 'field' }, '梯次',
            h('select', { onchange: (e) => { form.no = +e.target.value; } }, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { value: n, selected: form.no === n }, `第 ${n} 梯次`)))),
          h('label', { class: 'field' }, '本梯次總人數',
            h('input', { type: 'number', min: 6, max: 22, value: form.total, onchange: (e) => { form.total = +e.target.value; rollSpies(); render(); } })),
          h('button', { class: 'btn', onclick: () => { rollSpies(); render(); } }, '重新抽選臥底')),
        form.error ? h('p', { class: 'note bad' }, form.error)
          : h('p', { class: 'muted small' }, `分組：${form.sizes.join('＋')} 人。規則：11 人以下 1 組；12 人分 6＋6；13 人分 6＋7。每組依人數自動帶入好壞比例。`)),
      ...groupCards,
      h('div', { class: 'row end' },
        b ? h('span', { class: 'muted small' }, `目前是第 ${b.no} 梯次；建立新梯次會清除目前各組的綁定與結算記錄。`) : null,
        h('button', {
          class: 'btn primary', disabled: !!form.error, onclick: async () => {
            try {
              const groups = {};
              form.sizes.forEach((size, i) => {
                const g = i + 1;
                const spies = form.spies[g];
                if (new Set(spies).size !== spies.length) throw new Error(`第 ${g} 組臥底重複，請重新選擇`);
                groups[g] = { size, set: g === 1 ? 'A' : 'B', roles: buildGroupRoles(size, spies) };
              });
              if (b && !(await confirmBox(`建立第 ${form.no} 梯次？`, '目前各組的綁定與結算記錄會清除。', '建立', true))) return;
              await S.patch({
                batch: { no: form.no, total: form.total, createdAt: Date.now(), groups },
                live: null,
                control: { round: 1, missionId: null, status: 'idle', accum: 0, startAt: null },
              });
              tab = 'control'; render();
              toast(`已建立第 ${form.no} 梯次，請助理主持人掃組別 QR 碼`);
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, '建立本梯次')));
  }

  // ── 回合控制 ─────────────────────────────────────────────
  function controlTab(c) {
    if (!S.batch) return h('section', { class: 'card' }, h('p', {}, '還沒有梯次。'), h('button', { class: 'btn primary', onclick: () => { tab = 'batch'; initForm(); render(); } }, '前往梯次與組別'));
    const gs = groupsOf();
    const allReady = gs.every((g) => S.allBound(g));
    if (!allReady || c.round === 0) return joinPanel(gs);

    const r = c.round;
    const used = {};
    for (const g of gs) for (const [mid, rr] of Object.entries(S.usedMissions(g))) used[mid] = rr;
    const allSettled = gs.every((g) => S.rounds(g)[r]);
    const missionGrid = h('div', { class: 'grid g3' }, MISSIONS.map((m) => h('button', {
      class: 'mission' + (used[m.id] ? ' used' : ''), 'aria-pressed': String(c.missionId === m.id),
      onclick: async () => {
        if (c.status !== 'idle') return toast('回合進行中不能換任務；請先撤銷或進入下一回合', 'bad');
        if (gs.some((g) => S.rounds(g)[r])) return toast('已有組別結算這回合，不能換任務', 'bad');
        await S.setMission(r, m.id);
      },
    }, h('span', { class: 't' }, h('span', {}, m.tag), h('span', {}, used[m.id] ? `第 ${used[m.id]} 回合` : '')), h('span', { class: 'n' }, m.name), h('span', { class: 'c' }, needText(m)))));

    const loadedChips = gs.map((g) => {
      const l = S.live(g).loaded;
      const ok = l && l.round === r && l.mid === c.missionId;
      return h('span', { class: 'chip ' + (ok ? 'ok' : '') }, `第 ${g} 組 ${ok ? '已載入' : '未載入'}`);
    });
    const remaining = ROUND_LIMIT_MS - S.elapsed();
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'cols' },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('div', { class: 'row between' }, h('h2', {}, `第 ${r} 回合：選擇任務`), h('span', { class: 'muted tiny' }, '灰底＝已用過，仍可重選')),
            missionGrid),
          c.missionId ? h('div', { style: { flex: '0 1 260px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '14px', borderRadius: '14px', background: 'var(--bg)' } },
            h('span', { class: 'eyebrow' }, '任務 QR 碼・各組手機掃此載入'),
            qrImg(QR.mission(ev, r, c.missionId), 190, '本回合任務 QR 碼'),
            h('b', {}, MISSION[c.missionId].name),
            h('div', { class: 'row', style: { justifyContent: 'center' } }, loadedChips))
            : h('div', { class: 'note', style: { flex: '0 1 260px' } }, '選好任務後，這裡會出現任務 QR 碼。'))),
      h('section', { class: 'dark', style: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '16px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { class: 'tiny', style: { color: '#BDB6A8' } }, '本回合剩餘・各組同步'),
          h('div', { class: 'row' },
            h('span', { class: 'timer' + (remaining <= 0 ? ' late' : ''), 'data-timer': '1', style: { fontSize: '44px', color: remaining <= 0 ? '#F2B597' : '' } }, fmtClock(Math.max(0, remaining))),
            h('b', { 'data-status': '1', style: { color: c.status === 'paused' ? '#F4F1EA' : '#F2B597' } }, statusText(c, remaining)))),
        h('div', { class: 'row' },
          h('button', { class: 'btn', disabled: c.status !== 'idle' || !c.missionId, onclick: () => S.startRound().catch((e) => toast(e.message, 'bad')) }, iconEl('play'), '開始回合'),
          c.status === 'paused'
            ? h('button', { class: 'btn', onclick: () => S.resume() }, iconEl('play'), '繼續')
            : h('button', { class: 'btn', disabled: c.status !== 'running', onclick: () => S.pause() }, iconEl('pause'), '暫停'),
          h('button', {
            class: 'btn', disabled: !c.missionId, onclick: async () => {
              if (!allSettled && !(await confirmBox('還有組別沒結算', '未結算的組別這回合會沒有結果。仍要進入下一回合？', '下一回合', true))) return;
              await S.patch({ control: { round: r + 1, missionId: null, status: 'idle', accum: 0, startAt: null } });
            },
          }, '下一回合'))),
      h('div', { class: 'row end' }, h('button', { class: 'btn', 'aria-pressed': String(reveal), onclick: () => { reveal = !reveal; render(); } }, reveal ? '隱藏角色' : '顯示角色（揭牌後）')),
      h('div', { class: 'cols' }, gs.map((g) => groupCard(g, c))));
  }

  function statusText(c, remaining) {
    if (c.status === 'idle') return c.missionId ? '尚未開始' : '請先選任務';
    if (c.status === 'paused') return '已暫停・各組手機同步暫停';
    return remaining <= 0 ? '已到 5 分鐘' : '進行中';
  }

  function joinPanel(gs) {
    return h('div', { class: 'cols' }, gs.map((g) => {
      const cfg = S.groupCfg(g), live = S.live(g);
      const bound = Object.keys(live.seats || {}).length;
      const url = `${location.origin}${location.pathname}?join=${ev}.${S.batch.no}.${g}`;
      return h('section', { class: 'card', style: { alignItems: 'center', textAlign: 'center' } },
        h('h2', {}, `第 ${g} 組・${cfg.size} 人・${cfg.set} 套`),
        qrImg(url, 200, `第 ${g} 組加入用 QR 碼`),
        h('span', { class: 'chip ' + (live.phone ? 'ok' : '') }, live.phone ? `手機已加入・綁定 ${bound}/${cfg.size}` : '等待手機掃描'),
        h('p', { class: 'muted tiny' }, '助理主持人用手機相機或本程式掃描加入。QR 碼不含角色資訊。'),
        h('details', {}, h('summary', { class: 'small' }, '本組角色（請勿外流）'), h('p', { class: 'small' }, cfg.roles.map((id) => ROLE[id].name).join('、'))));
    }).concat([h('section', { class: 'card' },
      h('h2', {}, '等待全部組別綁定完成'),
      h('p', { class: 'muted small' }, '每組手機加入後，依座位編號逐一掃信封。全部組別都綁定完成，才會出現回合控制。'))]));
  }

  function groupCard(g, c) {
    const cfg = S.groupCfg(g), rounds = S.rounds(g), r = c.round, x = rounds[r];
    const ledger = S.live(g).ledger || {}, seats = S.seats(g), map = S.mapping(g);
    const ok = Object.values(rounds).filter((y) => y.ok).length, bad = Object.values(rounds).filter((y) => !y.ok).length;
    const maxR = Math.max(4, r);
    const strip = h('ol', { class: 'res-strip', 'aria-label': '各回合結果', style: { gridTemplateColumns: `repeat(${Math.min(maxR, 6)},minmax(0,1fr))` } },
      Array.from({ length: maxR }, (_, i) => {
        const rr = i + 1, y = rounds[rr];
        const name = y ? MISSION[y.mid].name : rr === r && c.missionId ? MISSION[c.missionId].name : '待選';
        const cls = y ? (y.ok ? 'ok' : 'bad') : rr === r ? 'cur' : '';
        return h('li', { class: cls }, h('span', {}, `${rr} ${name}`), h('b', {}, y ? (y.ok ? '成功' : `失敗・${y.reason}`) : rr === r ? (c.status === 'idle' ? '—' : '協調中') : '—'));
      }));
    let status = null;
    if (x) {
      status = x.timeout
        ? h('div', { class: 'alert', style: { background: 'var(--bad)', color: '#fff', borderColor: 'var(--bad)' } }, h('b', {}, '已超時：「任務失敗，原因：時間。」不扣除資源'),
          h('button', { class: 'btn', onclick: () => S.undo(g, r) }, '撤銷'))
        : h('div', { class: 'note ' + (x.ok ? 'ok' : 'bad') }, `已結算：${x.ok ? '任務成功' : '任務失敗，原因：' + x.reason}（出任務 ${x.seats.join('・')} 號）`);
    } else if (S.timeUp()) {
      status = h('div', { class: 'alert', role: 'alert' },
        h('div', {}, h('b', {}, '5 分鐘到，尚未成行'), h('p', { class: 'small' }, '按下確認才算超時；可先觀察是否正在表決')),
        h('button', { class: 'btn danger', onclick: () => S.confirmTimeout(g).catch((e) => toast(e.message, 'bad')) }, '確認超時'));
    }
    const seatNos = Object.keys(seats).map(Number).sort((a, b) => a - b);
    return h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, `第 ${g} 組・${cfg.size} 人`), h('span', { class: 'muted small' }, `成功 ${ok}・失敗 ${bad}`)),
      status, strip,
      h('div', { class: 'scroll-x' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '座位'), reveal ? h('th', {}, '角色') : null, h('th', { class: 'num' }, '存款'), h('th', { class: 'num' }, '特休'), h('th', { class: 'num' }, '體力'), h('th', {}, '交通'))),
        h('tbody', {}, seatNos.map((s) => {
          const code = seats[s], role = ROLE[map[code]], l = ledger[code] || { money: role.money, leave: role.leave };
          return h('tr', {},
            h('th', { scope: 'row', style: { fontSize: '18px', fontWeight: 900 } }, s),
            reveal ? h('td', {}, role.name, h('span', { class: 'muted tiny' }, '　' + KIND_LABEL[role.kind])) : null,
            h('td', { class: 'num' + (l.money === 0 ? ' zero' : '') }, fmtNum(l.money)),
            h('td', { class: 'num' + (l.leave === 0 ? ' zero' : '') }, l.leave),
            h('td', { class: 'num' }, role.power),
            h('td', {}, role.car));
        })))));
  }

  // 每秒更新計時；跨過 5 分鐘時重畫一次（出現確認超時）
  const timer = setInterval(() => {
    if (tab !== 'control') return;
    const c = S.control, rem = ROUND_LIMIT_MS - S.elapsed();
    const t = app.querySelector('[data-timer]');
    if (t) { t.textContent = fmtClock(Math.max(0, rem)); t.style.color = rem <= 0 ? '#F2B597' : ''; }
    const st = app.querySelector('[data-status]');
    if (st) st.textContent = statusText(c, rem);
    const up = S.timeUp();
    if (up !== lastTimeUp) { lastTimeUp = up; render(); }
  }, 500);

  const off = S.on(() => {
    // 表單編輯中不打斷
    if (tab === 'batch' && document.activeElement && app.contains(document.activeElement) && /SELECT|INPUT/.test(document.activeElement.tagName)) return;
    render();
  });
  setUnmount(() => { clearInterval(timer); off(); S.stop(); lock && lock.release && lock.release(); });
  render();
}
