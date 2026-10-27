// 助理主持人手機：連線模式（掃組別 → 綁定座位 → 掃任務 → 結算）與離線單機模式
import { h, toast, confirmBox, openScanner, iconEl, fmtClock } from './ui.js';
import { EventSession, deviceId, loadOffline, saveOffline, clearOffline } from './session.js';
import {
  ROLE, MISSIONS, MISSION, SABOTAGE, DISRUPT, ROUND_LIMIT_MS, KIND_LABEL, REASON_ORDER,
  composition, buildGroupRoles, shuffle, needText, fmtNum, announce, QR,
} from './rules.js';
import { setUnmount } from './nav.js';

const LS_PHONE = 'ug.phone';
const LS_MAPS = 'ug.maps';
const jget = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const jset = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } };

export async function mountPhone(app, mode) {
  if (mode === 'offline') return offlineEntry(app);
  const info = jget(LS_PHONE);
  if (!info) return scanJoin(app);
  app.replaceChildren(shell('連線中…', null, h('p', { class: 'muted' }, `連線到活動 ${info.ev}…`)));
  let S;
  try { S = await new EventSession('online', info.ev).start(); } catch (e) {
    app.replaceChildren(shell('無法連線', null,
      h('div', { class: 'note bad' }, e.message),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => mountPhone(app, 'online') }, '重試'), h('a', { class: 'btn', href: '#/offline' }, '改用離線單機操作'))));
    return;
  }
  if (S.qr) jset(LS_MAPS, S.qr);
  if (!S.data || !S.batch || S.batch.no !== info.batch || !S.groupCfg(info.g)) {
    S.stop();
    jset(LS_PHONE, null);
    toast('這張組別 QR 碼已失效（梯次已更換），請重新掃描', 'bad');
    return scanJoin(app);
  }
  return groupApp(app, S, info.g, info);
}

// ── 共用外框 ──────────────────────────────────────────────
function shell(title, sub, ...body) {
  const footer = body.length && body[body.length - 1] && body[body.length - 1].tagName === 'FOOTER' ? body.pop() : null;
  return h('div', { class: 'phone' },
    h('header', {}, h('div', {}, sub ? h('span', { class: 'eyebrow' }, sub) : h('span', { class: 'eyebrow' }, '勿虛心假意・助理主持人'), h('h1', {}, title))),
    h('main', {}, ...body), footer);
}

function scanJoin(app) {
  const doScan = () => openScanner({
    title: '掃組別 QR 碼', hint: '掃描控場講師儀表板上的組別 QR 碼',
    onResult: (t) => {
      const p = QR.parse(t);
      if (p.type !== 'join') return '這不是組別 QR 碼';
      jset(LS_PHONE, { ev: p.ev, batch: p.batch, g: p.g });
      setTimeout(() => mountPhone(app, 'online'));
      return true;
    },
  });
  app.replaceChildren(shell('加入組別', null,
    h('section', { class: 'card' },
      h('p', {}, '請掃描儀表板「回合控制」頁上的組別 QR 碼。也可以直接用手機相機掃，會自動開啟本程式。'),
      h('button', { class: 'btn primary big', onclick: doScan }, iconEl('scan'), '掃組別 QR 碼')),
    h('a', { class: 'btn', href: '#/offline' }, '現場沒網路？改用離線單機操作'),
    h('a', { class: 'btn', href: '#/' }, iconEl('back'), '回首頁')));
}

// ── 離線入口：建立組別 ─────────────────────────────────────
function offlineEntry(app) {
  const data = loadOffline();
  if (data && data.batch) {
    const S = new EventSession('offline', 'LOCAL');
    S.start();
    return groupApp(app, S, data.myGroup || 1, null);
  }
  const maps = jget(LS_MAPS);
  const st = { no: 1, g: 1, size: 6, set: 'A', spies: null };
  const roll = () => { const c = composition(st.size); st.spies = [...shuffle(SABOTAGE).slice(0, c.sab), ...shuffle(DISRUPT).slice(0, c.dis)]; };
  roll();
  let mapsNow = maps;
  const render = () => {
    const c = composition(st.size);
    const have = mapsNow && mapsNow.sets && mapsNow.sets[st.set];
    const sel = (idx, pool) => h('select', { 'aria-label': pool === SABOTAGE ? '破壞型' : '干擾型', onchange: (e) => { st.spies[idx] = e.target.value; } },
      pool.map((id) => h('option', { value: id, selected: st.spies[idx] === id }, ROLE[id].name)));
    app.replaceChildren(shell('單機建立組別', null,
      h('div', { class: 'note bad' }, '離線後本組只在這支手機運作，不再同步，也沒有儀表板。任務、計時與超時都由你在手機上決定。'),
      h('div', { class: 'grid g2' },
        h('label', { class: 'field' }, '梯次', h('select', { onchange: (e) => { st.no = +e.target.value; } }, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { value: n, selected: st.no === n }, `第 ${n} 梯次`)))),
        h('label', { class: 'field' }, '組別', h('select', { onchange: (e) => { st.g = +e.target.value; st.set = st.g === 1 ? 'A' : 'B'; render(); } }, [1, 2].map((n) => h('option', { value: n, selected: st.g === n }, `第 ${n} 組`))))),
      h('div', { class: 'field' }, h('span', {}, '本組人數'),
        h('div', { class: 'grid g6' }, [6, 7, 8, 9, 10, 11].map((n) => h('button', { class: 'btn', 'aria-pressed': String(st.size === n), onclick: () => { st.size = n; roll(); render(); } }, n)))),
      h('section', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', {}, `${st.size} 人組角色組成`), h('span', { class: 'muted small' }, `好人 ${c.good.length}・臥底 ${c.sab + c.dis}`)),
        h('p', { class: 'small' }, h('b', { style: { color: 'var(--ok)' } }, '好人　'), c.good.map((id) => ROLE[id].name).join('、')),
        h('div', { class: 'grid g2' },
          ...Array.from({ length: c.sab }, (_, k) => h('label', { class: 'field' }, `破壞型 ${k + 1}`, sel(k, SABOTAGE))),
          ...Array.from({ length: c.dis }, (_, k) => h('label', { class: 'field' }, `干擾型 ${k + 1}`, sel(c.sab + k, DISRUPT)))),
        h('label', { class: 'field' }, '信封套別', h('select', { onchange: (e) => { st.set = e.target.value; render(); } }, ['A', 'B'].map((s) => h('option', { value: s, selected: st.set === s }, `${s} 套`)))),
        have ? h('div', { class: 'note ok' }, `${st.set} 套 v${mapsNow.version} 對照已在手機上`)
          : h('div', { class: 'note bad' }, `手機上沒有 ${st.set} 套的對照。請掃對照表或儀表板上的「離線載入 QR 碼」。`),
        h('button', {
          class: 'btn', onclick: () => openScanner({
            title: '掃離線載入 QR 碼', hint: `掃 ${st.set} 套對照表右下角的 QR 碼`,
            onResult: (t) => {
              const p = QR.parse(t);
              if (p.type !== 'map') return '這不是離線載入 QR 碼';
              if (Object.keys(p.map).length !== 13) return 'QR 碼內容不完整';
              const cur = jget(LS_MAPS) || { version: p.v, sets: {} };
              if (cur.version !== p.v) { cur.version = p.v; cur.sets = {}; }
              cur.sets[p.set] = p.map; jset(LS_MAPS, cur); mapsNow = cur; st.set = p.set;
              setTimeout(render); toast(`已載入 ${p.set} 套 v${p.v}`); return true;
            },
          }),
        }, iconEl('scan'), '掃離線載入 QR 碼')),
      h('footer', {},
        h('button', {
          class: 'btn dark big', disabled: !have, onclick: () => {
            try {
              if (new Set(st.spies).size !== st.spies.length) throw new Error('臥底重複，請重新選擇');
              const roles = buildGroupRoles(st.size, st.spies);
              const data = {
                myGroup: st.g, createdAt: Date.now(),
                qr: { version: mapsNow.version, sets: { [st.set]: mapsNow.sets[st.set] } },
                batch: { no: st.no, total: st.size, groups: { [st.g]: { size: st.size, set: st.set, roles } } },
                control: { round: 1, missionId: null, status: 'idle', accum: 0, startAt: null },
                live: { [st.g]: { phone: { id: deviceId(), at: Date.now() } } },
              };
              saveOffline(data);
              offlineEntry(app);
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, '切換為離線並開始綁定'),
        h('a', { class: 'btn', href: '#/' }, iconEl('back'), '回首頁'))));
  };
  render();
}

// ── 組別主程式（連線／離線共用）────────────────────────────
function groupApp(app, S, g, info) {
  const offline = S.mode === 'offline';
  const ui = { picks: [], lookup: null, confirmed: offline || !!(info && info.confirmed), checked: false };
  let lastUp = false;

  const sub = () => `第 ${S.batch.no} 梯次・第 ${g} 組${offline ? '・離線' : ''}`;
  const remaining = () => ROUND_LIMIT_MS - S.elapsed();

  const render = () => {
    if (!S.batch || !S.groupCfg(g)) {
      app.replaceChildren(shell('梯次已更換', null, h('p', {}, '控場講師已建立新梯次，請重新掃組別 QR 碼。'),
        h('button', { class: 'btn primary big', onclick: () => { jset(LS_PHONE, null); location.hash = '#/phone'; location.reload(); } }, '重新加入')));
      return;
    }
    if (ui.lookup) return app.replaceChildren(lookupScreen());
    if (!ui.confirmed) return app.replaceChildren(confirmScreen());
    if (!S.allBound(g)) return app.replaceChildren(bindScreen());
    app.replaceChildren(roundScreen());
  };

  // 確認組別（連線）
  function confirmScreen() {
    const cfg = S.groupCfg(g);
    return shell('加入組別', null,
      h('section', { class: 'card', style: { border: '2px solid var(--ok)' } },
        h('span', { class: 'eyebrow', style: { color: 'var(--ok)' } }, '已辨識組別'),
        h('h2', { style: { fontSize: '24px', fontWeight: 900 } }, `第 ${S.batch.no} 梯次・第 ${g} 組`),
        h('p', { class: 'muted' }, `${cfg.size} 人・本梯次共 ${Object.keys(S.batch.groups).length} 組`),
        h('p', { class: 'small' }, `座位 1～${cfg.size} 號（順時針）・信封 ${cfg.set} 套（v${S.qr.version}）・回合由控場講師儀表板同步`),
        h('div', { class: 'note' }, '角色組成只在儀表板設定，手機不顯示誰是臥底。')),
      h('footer', {},
        h('button', {
          class: 'btn primary big', onclick: async () => {
            await S.patch({ [`live/${g}/phone`]: { id: deviceId(), at: Date.now() } });
            ui.confirmed = true; jset(LS_PHONE, { ...info, confirmed: true }); render();
          },
        }, '確認，開始綁定座位'),
        h('button', { class: 'btn', onclick: () => { jset(LS_PHONE, null); S.stop(); scanJoin(app); } }, '不是這組，重新掃描')));
  }

  // 座位綁定
  function bindScreen() {
    const cfg = S.groupCfg(g), seats = S.seats(g);
    const next = Array.from({ length: cfg.size }, (_, i) => i + 1).find((s) => !seats[s]);
    const bound = Object.keys(seats).map(Number).sort((a, b) => a - b);
    const scan = () => openScanner({
      title: `掃 ${next} 號座位的信封`, hint: '依座位順時針逐一掃描',
      onResult: (t) => {
        const p = QR.parse(t);
        let code = p.code;
        if (p.type === 'envelope') { if (p.v !== S.qr.version) return `這是 v${p.v} 的舊貼紙，目前是 v${S.qr.version}`; }
        else if (p.type !== 'code') return '這不是信封 QR 碼';
        const err = S.checkEnvelope(g, code).error;
        if (err) return err;
        if (S.seatOf(g, code)) return `這個信封已綁定在 ${S.seatOf(g, code)} 號`;
        const seatNow = Array.from({ length: cfg.size }, (_, i) => i + 1).find((s) => !S.seats(g)[s]);
        S.bindSeat(g, seatNow, code).then(() => {
          if (S.allBound(g)) { toast('全員綁定完成'); closer(); } else toast(`${seatNow} 號綁定完成`);
        }).catch((e) => toast(e.message, 'bad'));
        return 'keep';
      },
      onClose: () => render(),
    });
    let closer = () => {};
    return shell('掃碼綁定座位', sub(),
      h('div', { class: 'row between' }, h('span', { class: 'muted small' }, '座位順序（順時針）・角色不顯示'), h('b', { class: 'mono' }, `${bound.length} / ${cfg.size}`)),
      h('ol', { class: 'list' }, Array.from({ length: cfg.size }, (_, i) => {
        const s = i + 1, code = seats[s];
        return h('li', { class: code ? '' : s === next ? 'cur' : 'todo' },
          h('b', { style: { width: '30px', fontSize: '20px' } }, s),
          h('span', { class: 'flex1 mono' }, code || (s === next ? '下一位' : '待掃')),
          code ? h('span', { style: { color: 'var(--ok)' } }, '✓') : null);
      })),
      h('footer', {},
        h('button', { class: 'btn primary big', onclick: () => { closer = scan(); } }, iconEl('scan'), `掃 ${next} 號座位的信封`),
        h('button', { class: 'btn', disabled: !bound.length, onclick: () => S.unbindSeat(g, bound[bound.length - 1]).catch((e) => toast(e.message, 'bad')) }, `重掃上一位（${bound[bound.length - 1] || '-'} 號）`)));
  }

  // 回合畫面
  function roundScreen() {
    const c = S.control, r = c.round, x = S.rounds(g)[r];
    const loaded = S.live(g).loaded;
    const ready = offline ? !!c.missionId : !!(loaded && loaded.round === r && loaded.mid === c.missionId && c.missionId);
    const head = h('div', { class: 'row between' },
      h('div', {}, h('span', { class: 'eyebrow' }, sub()), h('h1', {}, `第 ${r} 回合`)),
      h('div', { class: 'row', style: { gap: '6px' } },
        h('span', { class: 'timer' + (remaining() <= 0 && c.status !== 'idle' ? ' late' : ''), 'data-timer': '1' }, c.status === 'idle' ? '05:00' : fmtClock(Math.max(0, remaining()))),
        h('button', { class: 'btn icon', 'aria-label': '掃信封查詢角色', onclick: () => scanLookup() }, iconEl('search')),
        offline && c.status !== 'idle' ? h('button', { class: 'btn icon', 'aria-label': c.status === 'paused' ? '繼續計時' : '暫停計時', onclick: () => (c.status === 'paused' ? S.resume() : S.pause()) }, iconEl(c.status === 'paused' ? 'play' : 'pause')) : null));
    const wrapper = (...body) => h('div', { class: 'phone' }, h('header', {}, head), ...body);

    if (x) return wrapper(...resultView(r, x));

    const timeAlert = offline && S.timeUp() ? h('div', { class: 'alert', role: 'alert' },
      h('div', {}, h('b', {}, '5 分鐘到，尚未成行'), h('p', { class: 'tiny' }, '按下才算超時失敗')),
      h('button', { class: 'btn danger', onclick: () => S.confirmTimeout(g) }, '確認超時')) : null;
    const pausedNote = c.status === 'paused' ? h('div', { class: 'note' }, '控場已暫停計時') : null;

    // 任務選擇／載入
    let missionBlock;
    if (offline) {
      const used = S.usedMissions(g);
      missionBlock = h('section', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { class: 'row between' }, h('h2', {}, '本回合任務（自行選擇）'), h('span', { class: 'muted tiny' }, '灰底＝已用過')),
        h('div', { class: 'grid g3' }, MISSIONS.map((m) => h('button', {
          class: 'mission' + (used[m.id] ? ' used' : ''), 'aria-pressed': String(c.missionId === m.id), style: { minHeight: '60px' },
          onclick: () => { if (c.status !== 'idle') return toast('計時中不能換任務', 'bad'); S.setMission(r, m.id); },
        }, h('span', { class: 'n', style: { fontSize: '14px' } }, m.name), h('span', { class: 'c' }, used[m.id] ? `第 ${used[m.id]} 回合` : m.tag)))),
        c.missionId ? h('p', { class: 'small' }, '條件：', h('b', {}, needText(MISSION[c.missionId]))) : null,
        c.status === 'idle' && c.missionId ? h('button', { class: 'btn dark', onclick: () => S.startRound() }, iconEl('play'), '開始計時') : null);
    } else if (!c.missionId) {
      missionBlock = h('div', { class: 'note' }, '等待控場講師選擇本回合任務…');
    } else if (!ready) {
      missionBlock = h('section', { class: 'card' },
        h('p', {}, '請掃儀表板上的任務 QR 碼載入本回合任務。'),
        h('button', {
          class: 'btn primary big', onclick: () => openScanner({
            title: '掃任務 QR 碼', hint: '儀表板「回合控制」右側的 QR 碼',
            onResult: (t) => {
              const p = QR.parse(t);
              if (p.type !== 'mission') return '這不是任務 QR 碼';
              if (p.ev !== S.ev) return '這是別的活動的任務 QR 碼';
              if (p.round !== S.control.round || p.mid !== S.control.missionId) return '任務 QR 碼已過期，請掃儀表板目前顯示的';
              S.loadMission(g, p.round, p.mid); return true;
            },
            onClose: () => render(),
          }),
        }, iconEl('scan'), '掃任務 QR 碼'),
        h('button', { class: 'btn', onclick: () => S.loadMission(g, r, c.missionId) }, '掃不到？直接載入目前任務'));
    } else {
      missionBlock = h('div', { class: 'note ok row between' },
        h('span', {}, `已載入：`, h('b', {}, MISSION[c.missionId].name), `（${needText(MISSION[c.missionId])}）`));
    }

    // 掃隊員
    const cfg = S.groupCfg(g);
    const teamBlock = ready ? h('section', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('div', { class: 'row between' }, h('h2', {}, '出任務的 3 人'), h('span', { class: 'muted tiny' }, '限本組・不可重複')),
      h('div', { class: 'grid g3' }, [0, 1, 2].map((i) => {
        const s = ui.picks[i];
        return s ? h('button', { class: 'seat', 'aria-label': `移除 ${s} 號`, onclick: () => { ui.picks.splice(i, 1); render(); } }, h('span', { class: 'tiny muted' }, '座位'), h('span', { class: 'big-num' }, s), h('span', { class: 'tiny muted' }, '點一下移除'))
          : h('button', { class: 'seat empty', onclick: () => scanTeam() }, iconEl('scan'), `掃第 ${i + 1} 位`);
      })),
      h('details', { open: ui.manual, ontoggle: (e) => { ui.manual = e.target.open; } }, h('summary', { class: 'small muted' }, '掃不到？改點座位編號'),
        h('div', { class: 'grid g6', style: { marginTop: '8px' } }, Array.from({ length: cfg.size }, (_, i) => i + 1).map((s) => h('button', {
          class: 'btn', 'aria-pressed': String(ui.picks.includes(s)),
          onclick: () => { if (ui.picks.includes(s)) ui.picks = ui.picks.filter((y) => y !== s); else if (ui.picks.length < 3) ui.picks.push(s); render(); },
        }, s)))),
      h('p', { class: 'muted tiny' }, '宣告前請確認這 3 個號碼正確。結算時全場禁言，只宣告成敗與原因類別，不說是誰。')) : null;

    return wrapper(h('main', {}, timeAlert, pausedNote, missionBlock, teamBlock),
      h('footer', {},
        ready ? h('button', {
          class: 'btn primary big', disabled: ui.picks.length !== 3, onclick: async () => {
            if (c.status === 'idle' && !(await confirmBox('回合尚未開始計時', '仍要直接結算嗎？'))) return;
            try { await S.settle(g, r, c.missionId, ui.picks); ui.picks = []; ui.checked = false; } catch (e) { toast(e.message, 'bad'); }
          },
        }, '判定結果') : null,
        h('span', { class: 'muted tiny', style: { textAlign: 'center' } }, offline ? '選任務 → 開始計時 → 掃 3 人 → 判定' : '開始、暫停與超時由控場講師在儀表板操作'),
        offline ? h('button', { class: 'btn', onclick: endOffline }, '結束並清除離線資料') : null));
  }

  function resultView(r, x) {
    const m = MISSION[x.mid];
    const seats = S.seats(g), ledger = S.live(g).ledger || {};
    const hero = h('section', { class: 'hero ' + (x.ok ? 'ok' : 'bad') },
      h('span', { class: 'tiny' }, `第 ${r} 回合・${m.name}`),
      h('h1', { style: { fontSize: '32px' } }, x.ok ? '任務成功' : '任務失敗'),
      h('div', { class: 'say' }, h('div', { class: 'tiny', style: { opacity: .85 } }, x.ok ? '控場講師宣告' : '控場講師宣告（只說類別，不說是誰）'), announce(x)));
    const body = [];
    if (x.ok) {
      const rows = (x.seats || []).map((s) => {
        const code = seats[s], d = x.deltas[code] || { money: 0, leave: 0 }, l = ledger[code];
        const cell = (key, unit) => (m.need[key] ? h('td', {}, h('b', { class: 'mono' + (l[key] === 0 ? ' zero' : ''), style: { fontSize: '20px' } }, key === 'money' ? fmtNum(l[key]) : l[key]), h('div', { class: 'tiny muted' }, `扣 ${fmtNum(-d[key])}${unit}`)) : h('td', { class: 'muted' }, '不變'));
        return h('tr', {}, h('th', { scope: 'row', style: { fontSize: '22px', fontWeight: 900 } }, s), cell('money', ''), cell('leave', ' 天'));
      });
      body.push(h('section', { class: 'card', style: { padding: 0, gap: 0 } },
        h('div', { class: 'row between', style: { padding: '12px 16px' } }, h('h2', {}, '請抄到角色卡背面'), h('span', { class: 'muted tiny' }, '剩餘量')),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '座位'), h('th', {}, '存款'), h('th', {}, '特休'))), h('tbody', {}, rows))),
      h('label', { class: 'card', style: { flexDirection: 'row', alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: ui.checked, onchange: (e) => { ui.checked = e.target.checked; }, style: { width: '22px', height: '22px', accentColor: 'var(--ok)' } }),
        '已幫 3 位學員在角色卡填好剩餘量'));
    } else {
      body.push(h('section', { class: 'card' },
        h('h2', {}, '判定順序'),
        h('ol', { class: 'list' }, REASON_ORDER.map(([k, t]) => h('li', { class: k === x.reason ? 'cur' : '', style: k === x.reason ? { borderColor: 'var(--bad)', background: 'var(--bad-bg)' } : {} },
          h('b', { style: { width: '44px' } }, k), h('span', { class: 'small' }, t), k === x.reason ? h('span', { class: 'chip bad' }, '命中') : null))),
        h('p', { class: 'small' }, x.timeout ? '未成行，不扣除資源。' : `出任務 ${x.seats.join('・')} 號・失敗不扣除資源`)));
    }
    const c = S.control;
    return [h('main', {}, hero, ...body),
      h('footer', {},
        h('button', {
          class: 'btn', onclick: async () => { if (await confirmBox('撤銷這次結算？', '資源會還原，可重新掃描出任務的 3 人。', '撤銷', true)) S.undo(g, r); },
        }, '撤銷重掃'),
        offline ? h('button', { class: 'btn dark big', onclick: () => S.patch({ control: { round: r + 1, missionId: null, status: 'idle', accum: 0, startAt: null } }) }, `下一回合：第 ${r + 1} 回合`)
          : h('div', { class: 'note', style: { textAlign: 'center' } }, c.round === r ? '等待控場講師進入下一回合…' : ''))];
  }

  // 掃隊員
  function scanTeam() {
    openScanner({
      title: `掃第 ${ui.picks.length + 1} 位隊員的信封`, hint: '掃出任務隊員的信封 QR 碼',
      onResult: (t) => {
        const p = QR.parse(t);
        if (p.type !== 'envelope' && p.type !== 'code') return '這不是信封 QR 碼';
        const seat = S.seatOf(g, p.code);
        if (!seat) return '這個信封不在本組';
        if (ui.picks.includes(+seat)) return `${seat} 號已經掃過了`;
        ui.picks.push(+seat);
        setTimeout(render);
        if (ui.picks.length >= 3) return true;
        return 'keep';
      },
      onClose: () => render(),
    });
  }

  // 角色查詢
  function scanLookup() {
    openScanner({
      title: '掃信封查詢角色', hint: '掃任一位學員的信封',
      onResult: (t) => {
        const p = QR.parse(t);
        if (p.type !== 'envelope' && p.type !== 'code') return '這不是信封 QR 碼';
        if (!S.mapping(g)[p.code]) return '這個信封不在本組的套別';
        ui.lookup = { code: p.code, hide: false }; setTimeout(render); return true;
      },
    });
  }
  function lookupScreen() {
    const { code, hide } = ui.lookup;
    const hist = S.history(g, code), role = hist.role;
    const boxRow = (label, key, init) => {
      const vals = hist.boxes[key];
      return [h('b', {}, label), h('span', { class: 'mono tiny', style: { textAlign: 'center' } }, key === 'money' ? fmtNum(init) : init),
        ...[0, 1, 2, 3].map((i) => h('span', { class: 'b' + (vals[i] != null ? ' f' : '') + (i === vals.length - 1 ? ' last' : '') }, vals[i] != null ? (key === 'money' ? fmtNum(vals[i]) : vals[i]) : ''))];
    };
    const over = hist.boxes.money.length > 4 || hist.boxes.leave.length > 4;
    return shell('角色查詢', sub(),
      h('section', { class: 'dark', style: { flexDirection: 'row', alignItems: 'center', gap: '14px' } },
        h('div', { style: { width: '60px', height: '60px', borderRadius: '14px', background: 'var(--bg)', color: 'var(--ink)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' } },
          h('span', { class: 'tiny muted' }, '座位'), h('b', { style: { fontSize: '26px' } }, hist.seat || '-')),
        h('div', { class: 'flex1' },
          h('div', { class: 'mono tiny', style: { color: '#BDB6A8' } }, `${code}・${S.groupCfg(g).set} 套 v${S.qr.version}`),
          h('div', { style: { fontSize: '22px', fontWeight: 900 } }, hide ? '••••••' : role.name),
          h('div', { class: 'small', style: { color: '#D8D2C5' } }, hide ? '角色已隱藏' : KIND_LABEL[role.kind])),
        h('button', { class: 'btn icon', style: { background: 'transparent', color: 'var(--bg)', borderColor: '#4A4740' }, 'aria-label': hide ? '顯示角色' : '隱藏角色', onclick: () => { ui.lookup.hide = !hide; render(); } }, hide ? '顯' : '隱')),
      h('section', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', {}, '角色卡背面應填內容'), h('span', { class: 'muted tiny' }, '用來校正實體卡')),
        h('div', { class: 'boxes' },
          h('span', { class: 'muted' }, '項目'), h('span', { class: 'muted tiny', style: { textAlign: 'center' } }, '初始'),
          ...[1, 2, 3, 4].map((i) => h('span', { class: 'muted tiny', style: { textAlign: 'center' } }, `剩餘 ${i}`)),
          ...boxRow('存款', 'money', role.money), ...boxRow('特休', 'leave', role.leave)),
        over ? h('p', { class: 'note bad' }, '變動超過 4 次，卡上格子不夠，請寫在旁邊。') : null,
        h('p', { class: 'small' }, `目前：存款 ${fmtNum(hist.money)}・特休 ${hist.leave} 天・體力 ${role.power}（不扣）・交通 ${role.car}（不扣）`)),
      h('section', { class: 'card' },
        h('h2', {}, '資源使用記錄'),
        hist.log.length ? h('ol', { class: 'list' }, hist.log.map((y) => {
          const m = MISSION[y.mid];
          const what = y.timeout ? '未成行（時間失敗）' : y.inTeam ? `出任務・${y.ok ? '成功' : '失敗（' + y.reason + '）'}` : '未出任務';
          const ch = [];
          if (y.d.money) ch.push(`存款 ${fmtNum(y.d.money)}`);
          if (y.d.leave) ch.push(`特休 ${y.d.leave}`);
          return h('li', { style: { minHeight: '52px', padding: '6px 12px' } }, h('b', { class: 'tiny', style: { width: '44px' } }, `第 ${y.round} 回`),
            h('div', { class: 'flex1' }, h('div', { class: 'small', style: { fontWeight: 700 } }, `${m.name}・${what}`), h('div', { class: 'tiny muted' }, ch.length ? ch.join('、') : '無變動')));
        })) : h('p', { class: 'muted small' }, '還沒有結算記錄。')),
      h('footer', {},
        h('span', { class: 'tiny', style: { textAlign: 'center', color: 'var(--bad-d)' } }, '此畫面含角色身分，請勿讓學員看到'),
        h('div', { class: 'row' },
          h('button', { class: 'btn flex1', onclick: () => { ui.lookup = null; scanLookup(); } }, iconEl('scan'), '再掃一個'),
          h('button', { class: 'btn dark flex1', style: { minHeight: '48px' }, onclick: () => { ui.lookup = null; render(); } }, '卡片已校正，返回'))));
  }

  async function endOffline() {
    if (!(await confirmBox('結束離線操作？', '這支手機上的本組資料會全部清除，無法復原。', '清除', true))) return;
    clearOffline(); location.hash = '#/';
  }

  const tick = setInterval(() => {
    const c = S.control;
    const t = app.querySelector('[data-timer]');
    if (t && c.status !== 'idle') { const rem = remaining(); t.textContent = fmtClock(Math.max(0, rem)); t.classList.toggle('late', rem <= 0); }
    const up = S.timeUp();
    if (up !== lastUp) { lastUp = up; if (!document.querySelector('.modal')) render(); }
  }, 500);
  let lastRound = S.control.round;
  const off = S.on(() => {
    if (S.control.round !== lastRound) { lastRound = S.control.round; ui.picks = []; ui.checked = false; }
    if (document.querySelector('.modal.scan')) return; // 掃描中不重畫，避免關掉相機
    render();
  });
  setUnmount(() => { clearInterval(tick); off(); S.stop(); });
  render();
}
