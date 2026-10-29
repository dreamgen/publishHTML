// 儀表板「編輯模式」：調整玩家資源、修改座位綁定的角色、角色初始值、任務條件。
// 所有修改先放在草稿，按「儲存並通知」才一次寫入，並留下修正通知同步給助理主持人與玩家。
import { h, toast, confirmBox } from './ui.js';
import { ROLES, ROLE, MISSIONS, CAR_OPTIONS, needText, fmtNum } from './rules.js';

const num = (v) => { const n = Number(String(v).replace(/[,\s]/g, '')); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };

function needToForm(need) {
  const f = { money: need.money || '', leave: need.leave || '', power: need.power || '', cars: need.cars || '', bus: '' };
  if (need.transport) for (const t of need.transport) { if (t.bus) f.bus = t.bus; if (t.cars) f.cars = t.cars; }
  return f;
}
function formToNeed(f) {
  const n = {};
  for (const k of ['money', 'leave', 'power']) { const v = num(f[k]); if (v) n[k] = v; }
  const cars = num(f.cars), bus = num(f.bus);
  if (bus) n.transport = cars ? [{ bus }, { cars }] : [{ bus }];
  else if (cars) n.cars = cars;
  return n;
}

/** 建立（或沿用）草稿 */
export function makeDraft(S) {
  const d = { players: {}, roles: {}, missions: {}, note: '' };
  for (const g of Object.keys((S.batch && S.batch.groups) || {})) {
    d.players[g] = {};
    const seats = S.seats(g);
    for (const s of Object.keys(seats)) {
      const st = S.stats(g, seats[s]);
      d.players[g][s] = { code: seats[s], money: st.money, leave: st.leave, power: st.power, car: st.car };
    }
  }
  for (const r of ROLES) { const b = S.roleBase(r.id); d.roles[r.id] = { money: b.money, leave: b.leave, power: b.power, car: b.car }; }
  for (const m of MISSIONS) d.missions[m.id] = needToForm(S.mission(m.id).need);
  return d;
}

export function editTab(S, st, rerender) {
  if (!st.draft) st.draft = makeDraft(S);
  const d = st.draft;
  const input = (obj, key, opts = {}) => h('input', {
    type: 'text', inputmode: 'numeric', value: obj[key] === '' ? '' : fmtNum(obj[key]), 'aria-label': opts.label || key,
    style: { minHeight: '40px', fontSize: '15px', padding: '0 8px', textAlign: 'right', fontFamily: 'var(--mono)', width: opts.w || '96px' },
    oninput: (e) => { obj[key] = e.target.value.trim() === '' ? '' : (num(e.target.value) ?? obj[key]); },
  });
  const carSel = (obj, label) => h('select', { 'aria-label': label, style: { minHeight: '40px', fontSize: '15px', width: '96px' }, onchange: (e) => { obj.car = e.target.value; } },
    CAR_OPTIONS.map((c) => h('option', { value: c, selected: obj.car === c }, c)));

  // 1. 玩家資源與角色
  const groups = Object.keys(d.players).map((g) => {
    const cfg = S.groupCfg(g), map = S.mapping(g);
    const codeByRole = Object.fromEntries(Object.entries(map).map(([c, r]) => [r, c]));
    const rows = Object.keys(d.players[g]).map(Number).sort((a, b) => a - b).map((s) => {
      const p = d.players[g][s];
      const roleSel = h('select', {
        'aria-label': `${s} 號角色`, style: { minHeight: '40px', fontSize: '15px' },
        onchange: (e) => {
          const code = codeByRole[e.target.value];
          const other = Object.keys(d.players[g]).find((x) => +x !== s && d.players[g][x].code === code);
          if (other) { // 交換兩個座位的角色（資源跟著信封走）
            const tmp = { ...d.players[g][other] };
            d.players[g][other] = { ...p };
            d.players[g][s] = tmp;
          } else { // 換成未綁定的信封：資源改用該角色初始值
            const b = d.roles[e.target.value];
            d.players[g][s] = { code, money: b.money, leave: b.leave, power: b.power, car: b.car };
          }
          rerender();
        },
      }, ROLES.map((r) => {
        const seatedAt = Object.keys(d.players[g]).find((x) => d.players[g][x].code === codeByRole[r.id]);
        return h('option', { value: r.id, selected: map[p.code] === r.id }, r.name + (seatedAt && +seatedAt !== s ? `（${seatedAt} 號，會交換）` : ''));
      }));
      const changed = p.code !== S.seats(g)[s];
      return h('tr', {},
        h('th', { scope: 'row', style: { fontSize: '17px', fontWeight: 900 } }, s),
        h('td', {}, roleSel, changed ? h('div', { class: 'tiny', style: { color: 'var(--bad-d)' } }, '角色將變更') : null),
        h('td', {}, input(p, 'money', { label: `${s} 號存款` })), h('td', {}, input(p, 'leave', { label: `${s} 號特休`, w: '64px' })),
        h('td', {}, input(p, 'power', { label: `${s} 號體力`, w: '64px' })), h('td', {}, carSel(p, `${s} 號交通`)));
    });
    return h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, `第 ${g} 組・${cfg.set} 套`), h('span', { class: 'muted tiny' }, '存款、特休為目前剩餘量；選到已在別的座位的角色會兩邊交換')),
      h('div', { class: 'scroll-x' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['座位', '角色', '存款', '特休', '體力', '交通'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows))));
  });

  // 2. 角色初始值
  const roleRows = ROLES.map((r) => {
    const o = d.roles[r.id];
    return h('tr', {}, h('th', { scope: 'row' }, r.name, h('div', { class: 'tiny muted' }, r.camp === 'spy' ? '虛偽大人' : '真誠大人')),
      h('td', {}, input(o, 'money', { label: `${r.name}存款` })), h('td', {}, input(o, 'leave', { label: `${r.name}特休`, w: '64px' })),
      h('td', {}, input(o, 'power', { label: `${r.name}體力`, w: '64px' })), h('td', {}, carSel(o, `${r.name}交通`)));
  });

  // 3. 任務條件
  const missionRows = MISSIONS.map((m) => {
    const f = d.missions[m.id];
    return h('tr', {}, h('th', { scope: 'row' }, m.name, h('div', { class: 'tiny muted' }, m.tag)),
      ...['money', 'leave', 'power', 'cars', 'bus'].map((k) => h('td', {}, input(f, k, { label: `${m.name}${k}`, w: k === 'money' ? '96px' : '56px' }))));
  });

  return h('div', { class: 'stack' },
    h('div', { class: 'note bad' }, h('b', {}, '編輯模式　'), '修改只在按「儲存並通知」後才生效，並會同步到助理主持人與玩家手機，顯示「主持人已修正」提示。已結算的回合紀錄不會被改寫。'),
    S.batch ? groups : h('p', { class: 'muted' }, '尚未建立梯次，沒有玩家資料可調整。'),
    h('div', { class: 'cols' },
      h('section', { class: 'card' },
        h('h2', {}, '角色初始值'),
        h('p', { class: 'muted tiny' }, '影響之後新綁定的座位、角色查詢的初始值與列印的對照表；目前已在遊戲中的剩餘量請在上方個別調整。'),
        h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ...['角色', '存款', '特休', '體力', '交通'].map((t) => h('th', {}, t)))), h('tbody', {}, roleRows)))),
      h('section', { class: 'card' },
        h('h2', {}, '任務條件（3 人合計）'),
        h('p', { class: 'muted tiny' }, '空白＝不需要。「遊覽車」與「汽車」都填時，表示遊覽車或汽車任一達到即可。'),
        h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ...['任務', '存款', '特休', '體力', '汽車', '遊覽車'].map((t) => h('th', {}, t)))), h('tbody', {}, missionRows))))),
    h('section', { class: 'card' },
      h('label', { class: 'field' }, '修正說明（可不填，只給工作人員看）',
        h('input', { type: 'text', value: d.note, oninput: (e) => { d.note = e.target.value; }, placeholder: '例如：3 號角色卡裝錯，改為陽奉陰違' })),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => { st.draft = null; st.on = false; rerender(); } }, '取消編輯'),
        h('button', { class: 'btn', onclick: () => { st.draft = makeDraft(S); rerender(); } }, '重新載入目前資料'),
        h('button', { class: 'btn primary', onclick: () => save(S, st, rerender) }, '儲存並通知'))));
}

async function save(S, st, rerender) {
  const d = st.draft;
  const patch = {}, staff = [], groupsN = {}, missionsN = [], roleInitN = [];
  const now = S.now();
  // 角色初始值
  const roleOver = { ...S.overrides.roles };
  for (const r of ROLES) {
    const o = d.roles[r.id], base = S.roleBase(r.id);
    const diff = ['money', 'leave', 'power', 'car'].filter((k) => o[k] !== '' && o[k] !== base[k]);
    if (diff.length) {
      roleOver[r.id] = { money: num(o.money) ?? base.money, leave: num(o.leave) ?? base.leave, power: num(o.power) ?? base.power, car: o.car };
      roleInitN.push(r.id);
      staff.push(`角色初始值「${r.name}」：` + diff.map((k) => `${label(k)} ${fmtVal(k, base[k])}→${fmtVal(k, roleOver[r.id][k])}`).join('、'));
    }
  }
  if (roleInitN.length) patch['overrides/roles'] = roleOver;
  // 任務條件
  const missionOver = { ...S.overrides.missions };
  for (const m of MISSIONS) {
    const before = S.mission(m.id).need, after = formToNeed(d.missions[m.id]);
    if (canon(before) !== canon(after)) {
      if (!Object.keys(after).length) { toast(`「${m.name}」至少要有一項條件`, 'bad'); return; }
      missionOver[m.id] = after; missionsN.push(m.id);
      staff.push(`任務「${m.name}」條件：${needText({ need: before })} → ${needText({ need: after })}`);
    }
  }
  if (missionsN.length) patch['overrides/missions'] = missionOver;
  // 玩家
  for (const g of Object.keys(d.players)) {
    const seatsNow = S.seats(g), map = S.mapping(g), ledger = S.live(g).ledger || {};
    const adjCodes = {}, seatsN = [], codesN = [];
    for (const s of Object.keys(d.players[g])) {
      const p = d.players[g][s], oldCode = seatsNow[s];
      const money = num(p.money), leave = num(p.leave), power = num(p.power);
      if (money == null || leave == null || power == null) { toast(`第 ${g} 組 ${s} 號的數值不正確`, 'bad'); return; }
      const lines = [];
      if (p.code !== oldCode) {
        patch[`live/${g}/seats/${s}`] = p.code;
        lines.push(`角色 ${ROLE[map[oldCode]].name}→${ROLE[map[p.code]].name}`);
        // 舊信封若已不在任何座位，清掉它的玩家綁定與帳本
        if (!Object.values(d.players[g]).some((x) => x.code === oldCode)) {
          patch[`live/${g}/players/${oldCode}`] = null;
          patch[`live/${g}/ledger/${oldCode}`] = null;
          patch[`live/${g}/adjust/${oldCode}`] = null;
        }
        codesN.push(oldCode);
      }
      const cur = S.stats(g, p.code);
      const curLedger = ledger[p.code];
      if (!curLedger || curLedger.money !== money || curLedger.leave !== leave || p.code !== oldCode) {
        patch[`live/${g}/ledger/${p.code}`] = { money, leave };
        adjCodes[p.code] = { money, leave, reset: true };
        if (curLedger && (curLedger.money !== money)) lines.push(`存款 ${fmtNum(curLedger.money)}→${fmtNum(money)}`);
        if (curLedger && (curLedger.leave !== leave)) lines.push(`特休 ${curLedger.leave}→${leave}`);
      }
      const base = S.roleBase(map[p.code]);
      if (power !== cur.power || p.car !== cur.car || p.code !== oldCode) {
        patch[`live/${g}/adjust/${p.code}`] = (power === base.power && p.car === base.car) ? null : { power, car: p.car };
        if (power !== cur.power) lines.push(`體力 ${cur.power}→${power}`);
        if (p.car !== cur.car) lines.push(`交通 ${cur.car}→${p.car}`);
      }
      if (lines.length || adjCodes[p.code]) {
        seatsN.push(+s); codesN.push(p.code);
        if (lines.length) staff.push(`第 ${g} 組 ${s} 號：${lines.join('、')}`);
      }
    }
    if (Object.keys(adjCodes).length) patch[`live/${g}/adjlog/a${now}`] = { at: now, codes: adjCodes };
    if (seatsN.length) groupsN[g] = { seats: seatsN, codes: [...new Set(codesN)] };
  }
  if (!staff.length && !Object.keys(groupsN).length) { toast('沒有任何修改'); return; }
  if (!(await confirmBox('儲存並通知？', staff.slice(0, 8).join('\n') + (staff.length > 8 ? `\n…共 ${staff.length} 項` : ''), '儲存並通知'))) return;
  if (d.note.trim()) staff.push('說明：' + d.note.trim());
  await S.saveEdits(patch, { staff, missions: missionsN, roleInit: roleInitN, groups: groupsN });
  st.draft = null; st.on = false;
  toast('已儲存，並通知助理主持人與玩家');
  rerender();
}

const canon = (n) => JSON.stringify(formToNeed(needToForm(n)));
const label = (k) => ({ money: '存款', leave: '特休', power: '體力', car: '交通' }[k]);
const fmtVal = (k, v) => (k === 'money' ? fmtNum(v) : v);
