// 遊戲規則：角色、任務、分組、判定與扣除。純函式，不碰畫面與資料庫，可在 Node 直接測試。
// 依據：《勿虛心假意｜體驗遊戲修正方案（Dry Run 回饋後）》

export const ROLES = [
  { id: 'sen', name: '資深老道親', camp: 'good', kind: 'special', car: '轎車', money: 20000, leave: 30, power: 10 },
  { id: 'car', name: '有交通工具', camp: 'good', kind: 'special', car: '遊覽車', money: 10000, leave: 7, power: 20 },
  { id: 'pow', name: '體力怪', camp: 'good', kind: 'special', car: '機車', money: 1000, leave: 1, power: 50 },
  { id: 'rich', name: '有錢人', camp: 'good', kind: 'special', car: '轎車', money: 50000, leave: 3, power: 10 },
  { id: 'nA', name: '一般大人 A', camp: 'good', kind: 'normal', car: '轎車', money: 3000, leave: 7, power: 5 },
  { id: 'nB', name: '一般大人 B', camp: 'good', kind: 'normal', car: '腳踏車', money: 2000, leave: 7, power: 5 },
  { id: 'nC', name: '一般大人 C', camp: 'good', kind: 'normal', car: '機車', money: 3000, leave: 7, power: 5 },
  { id: 'sel', name: '圖謀私利', camp: 'spy', kind: 'sabotage', car: '徒步', money: 6000, leave: 7, power: 15 },
  { id: 'yang', name: '陽奉陰違', camp: 'spy', kind: 'sabotage', car: '徒步', money: 6000, leave: 7, power: 15 },
  { id: 'face', name: '表面工夫', camp: 'spy', kind: 'sabotage', car: '腳踏車', money: 5000, leave: 7, power: 15 },
  { id: 'lie', name: '圖方便說謊', camp: 'spy', kind: 'disrupt', car: '轎車', money: 30000, leave: 20, power: 40 },
  { id: 'two', name: '口是心非', camp: 'spy', kind: 'disrupt', car: '腳踏車', money: 8000, leave: 7, power: 15 },
  { id: 'yes', name: '鄉愿討好', camp: 'spy', kind: 'disrupt', car: '徒步', money: 6000, leave: 7, power: 15 },
];
export const ROLE = Object.fromEntries(ROLES.map((r) => [r.id, r]));
export const SABOTAGE = ROLES.filter((r) => r.kind === 'sabotage').map((r) => r.id);
export const DISRUPT = ROLES.filter((r) => r.kind === 'disrupt').map((r) => r.id);
export const SPECIALS = ['sen', 'car', 'pow', 'rich'];
export const SPIES = ROLES.filter((r) => r.camp === 'spy').map((r) => r.id);

/** 統稱（2026-10-28 會議）：好人＝真誠大人、臥底＝虛偽大人 */
export const CAMP_NAME = { good: '真誠大人', spy: '虛偽大人' };
export const KIND_LABEL = { special: '真誠大人・特殊', normal: '真誠大人・一般', sabotage: '虛偽大人・破壞型', disrupt: '虛偽大人・干擾型' };
export const WHEN_LABEL = { sen: '每組必用', car: '每組必用', pow: '每組必用', rich: '每組必用', nA: '7 人以上', nB: '9 人以上', nC: '11 人' };

// 任務條件：money 元、leave 天、power 點、cars 汽車台數（轎車＋遊覽車）、bus 遊覽車台數。
// alt：替代交通條件（任一成立即可）。
export const MISSIONS = [
  { id: 'm0', name: '出國開荒', tag: '開場必答', need: { money: 51000, leave: 39 } },
  { id: 'm1', name: '輪值司機', tag: '任務', need: { leave: 15, cars: 2 } },
  { id: 'm2', name: '大專夏令營', tag: '任務', need: { power: 60, money: 18000 } },
  { id: 'm3', name: '旅遊辦道', tag: '任務', need: { money: 36000, transport: [{ bus: 1 }, { cars: 3 }] } },
  { id: 'm4', name: '秋季祭典幫廚', tag: '任務', need: { power: 80, cars: 2 } },
  { id: 'm5', name: '災後復原', tag: '備用', need: { power: 100, leave: 12 } },
];
export const MISSION = Object.fromEntries(MISSIONS.map((m) => [m.id, m]));
export const ROUND_LIMIT_MS = 5 * 60 * 1000;
/** 同一回合表決否決幾次就「無法派人」而失敗 */
export const VETO_LIMIT = 3;

export function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }

export function needText(m) {
  const n = m.need, out = [];
  if (n.money) out.push(`存款 ${fmtNum(n.money)}`);
  if (n.leave) out.push(`特休 ${n.leave} 天`);
  if (n.power) out.push(`體力 ${n.power}`);
  if (n.cars) out.push(`汽車 ${n.cars} 台`);
  if (n.transport) out.push(n.transport.map((t) => (t.bus ? `遊覽車 ${t.bus} 台` : `汽車 ${t.cars} 台`)).join('（或') + (n.transport.length > 1 ? '）' : ''));
  return out.join('、');
}

// ── 分組與角色組成 ─────────────────────────────────────────────────────────────
export function splitGroups(total) {
  if (total < 6) throw new Error('總人數至少 6 人');
  if (total <= 11) return [total];
  const g = Math.ceil(total / 11);
  if (g > 2) throw new Error('信封只有 A、B 兩套，最多分 2 組（22 人）');
  const base = Math.floor(total / g), extra = total % g;
  return Array.from({ length: g }, (_, i) => base + (i >= g - extra ? 1 : 0));
}

// 每組人數 → 好人角色與臥底人數。臥底不分破壞型／干擾型，從 6 種臥底中隨機抽，不控制比例。
const COMPOSE = {
  6: { normals: [], spies: 2 },
  7: { normals: ['nA'], spies: 2 },
  8: { normals: ['nA'], spies: 3 },
  9: { normals: ['nA', 'nB'], spies: 3 },
  10: { normals: ['nA', 'nB'], spies: 4 },
  11: { normals: ['nA', 'nB', 'nC'], spies: 4 },
};
export function composition(size) {
  const c = COMPOSE[size];
  if (!c) throw new Error('每組人數須為 6～11 人');
  return { good: [...SPECIALS, ...c.normals], spies: c.spies };
}

export function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** 抽虛偽大人：不控制破壞型／干擾型比例，但每組至少要有 1 位破壞型 */
export function drawSpies(size, rnd = Math.random) {
  const n = composition(size).spies;
  const first = shuffle(SABOTAGE, rnd)[0];
  return shuffle([first, ...shuffle(SPIES.filter((id) => id !== first), rnd).slice(0, n - 1)], rnd);
}

/**
 * 建立一組的設定。
 * draw = 'physical'（預設，實體抽臥底卡：綁定座位時掃到哪張臥底就是哪張）
 *      | 'dashboard'（離線手機抽：事先抽定，spies 為虛偽大人角色陣列）
 */
export function makeGroupCfg(size, set, draw = 'physical', spies = null, rnd = Math.random) {
  const c = composition(size);
  const cfg = { size, set, draw, good: c.good, spyCount: c.spies };
  if (draw === 'dashboard' || draw === 'auto') {
    const list = spies || drawSpies(size);
    if (list.length !== c.spies) throw new Error(`${size} 人組需要 ${c.spies} 位虛偽大人`);
    if (new Set(list).size !== list.length || list.some((id) => !SPIES.includes(id))) throw new Error('虛偽大人不可重複');
    if (!list.some((id) => SABOTAGE.includes(id))) throw new Error('每組至少要有 1 位破壞型虛偽大人');
    cfg.spies = list;
    // 自動抽角色（無實體卡片）：全部角色隨機排到 1～N 號座位，seatRoles[i] 為 i+1 號的角色
    if (draw === 'auto') cfg.seatRoles = shuffle([...c.good, ...list], rnd);
  }
  return cfg;
}

/** 自動抽角色：依 seatRoles 與 QR 對照表算出座位 → 代號（同一套對照表，代號只在系統內部使用） */
export function autoSeats(cfg, mapping) {
  const codeOf = Object.fromEntries(Object.entries(mapping).map(([code, role]) => [role, code]));
  const seats = {};
  cfg.seatRoles.forEach((role, i) => { seats[i + 1] = codeOf[role]; });
  return seats;
}
export function makeNonce(rnd = Math.random) { return Math.floor(rnd() * 36 ** 6).toString(36).padStart(6, '0'); }

/** 這個角色能不能綁進本組。boundRoles：已綁定座位的角色。回傳錯誤訊息或 null。 */
export function roleAllowed(cfg, role, boundRoles) {
  if (!ROLE[role]) return '不明的角色';
  if (boundRoles.includes(role)) return '這個角色已經綁定過了';
  if (ROLE[role].camp === 'good') return cfg.good.includes(role) ? null : `這個真誠大人角色 ${cfg.size} 人組不使用，請換一個信封`;
  if (cfg.draw === 'dashboard') return cfg.spies.includes(role) ? null : '這張虛偽大人卡不是儀表板抽中的，請換一個信封';
  const spiesBound = boundRoles.filter((r) => ROLE[r].camp === 'spy');
  if (spiesBound.length >= cfg.spyCount) return `本組虛偽大人已滿 ${cfg.spyCount} 位，請換真誠大人的信封`;
  // 每組至少 1 位破壞型：最後一個虛偽大人名額若還沒有破壞型，只能放破壞型
  if (ROLE[role].kind === 'disrupt' && spiesBound.length === cfg.spyCount - 1 && !spiesBound.some((r) => ROLE[r].kind === 'sabotage'))
    return '每組至少要有 1 位破壞型虛偽大人（圖謀私利／陽奉陰違／表面工夫），請換一個信封';
  return null;
}

/** 綁定完成前，好人與臥底各還差幾位 */
export function remainingSlots(cfg, boundRoles) {
  const goodLeft = cfg.good.filter((r) => !boundRoles.includes(r)).length;
  const spyLeft = cfg.spyCount - boundRoles.filter((r) => ROLE[r].camp === 'spy').length;
  return { goodLeft, spyLeft };
}

// ── 玩家版角色說明（每個角色固定 2 點目標＋3 點要做的事，畫面長度一致，避免從版面看出陣營）──
const GOOD_GOALS = ['派出對的人，完成 4 個任務中的至少 3 個', '最後指認出虛偽大人'];
const GOOD_COMMON = ['仔細聽每個人怎麼說', '留意每次表決有幾票 O、幾票 X'];
export const ROLE_TEXT = {
  sen: { sub: '特殊大人', goals: GOOD_GOALS, todo: [...GOOD_COMMON, '你的特休最多，需要特休的任務常是關鍵人選'] },
  car: { sub: '特殊大人', goals: GOOD_GOALS, todo: [...GOOD_COMMON, '你有遊覽車，需要汽車的任務常是關鍵人選'] },
  pow: { sub: '特殊大人', goals: GOOD_GOALS, todo: [...GOOD_COMMON, '你的體力最高，需要體力的任務常是關鍵人選'] },
  rich: { sub: '特殊大人', goals: GOOD_GOALS, todo: [...GOOD_COMMON, '你的存款充足，需要存款的任務常是關鍵人選'] },
  nA: { sub: '一般大人', goals: GOOD_GOALS, todo: [...GOOD_COMMON, '你的資源不多，多觀察、幫大家找出虛偽大人'] },
  nB: { sub: '一般大人', goals: GOOD_GOALS, todo: [...GOOD_COMMON, '你的資源不多，多觀察、幫大家找出虛偽大人'] },
  nC: { sub: '一般大人', goals: GOOD_GOALS, todo: [...GOOD_COMMON, '你的資源不多，多觀察、幫大家找出虛偽大人'] },
  sel: { sub: '借道場的人情和資源，謀自己的名利', goals: ['想辦法被派出去，讓任務失敗', '最後不被指認出來'],
    todo: ['只爭取需要存款的任務', '參考台詞：「我存款很夠，這次派我最保險。」', '被派中：任務失敗，隊伍提出的存款全歸你'] },
  yang: { sub: '嘴上答應，事後沒做，或隨便丟給別人做', goals: ['想辦法被派出去，讓任務失敗', '最後不被指認出來'],
    todo: ['對任何任務都答應會去', '參考台詞：「交給我，沒問題！」', '被派中出任務時，該任務一定失敗，你的資源不納入計算'] },
  face: { sub: '只做給別人看，挑輕避重，只求掛名好看', goals: ['想辦法被派出去，讓任務失敗', '最後不被指認出來'],
    todo: ['只爭取需要特休或體力的任務', '參考台詞：「這種體力活我最常做，一定要派我。」', '被派中出任務時，該任務一定失敗'] },
  lie: { sub: '為了方便或小利說謊，事雖小卻違背本心', goals: ['照指定行為干擾團隊', '最後不被指認出來'],
    todo: ['資源很好，卻怕麻煩，極力反對自己出任務', '參考台詞：「我真的不行，這次千萬不要派我。」', '若仍被派出，資源照常計算，任務不會因你失敗'] },
  two: { sub: '嘴上請人指正，被勸時心裡卻不服', goals: ['照指定行為干擾團隊', '最後不被指認出來'],
    todo: ['每次投票都投 X（反對）', '參考台詞：「你說得對，我沒意見。」（但投 X）', '被派出時資源照常計算，任務不會因你失敗'] },
  yes: { sub: '不問對錯，一味附和、吹捧別人', goals: ['照指定行為干擾團隊', '最後不被指認出來'],
    todo: ['每次投票都投 O（同意）；有人不想去時，跟著幫腔', '參考台詞：「大家說得都有道理，我都可以。」', '被派出時資源照常計算，任務不會因你失敗'] },
};
/** 角色的表決限制：口是心非只能投 X、鄉愿討好只能投 O */
export const VOTE_LOCK = { two: 'X', yes: 'O' };
export function roleTitle(id) { const r = ROLE[id]; return `${CAMP_NAME[r.camp]}・${r.name}`; }

// ── QR 碼對照 ─────────────────────────────────────────────────────────────────
/** 產生 A、B 兩套各 13 個代號，兩套代號互不重複。 */
export function generateMapping(rnd = Math.random) {
  const used = new Set();
  const code = () => { let c; do { c = 'Q-' + String(1000 + Math.floor(rnd() * 9000)); } while (used.has(c)); used.add(c); return c; };
  const sets = {};
  for (const s of ['A', 'B']) {
    sets[s] = {};
    for (const r of ROLES) sets[s][code()] = r.id;
  }
  return sets;
}

export const QR = {
  player: (base, ev) => `${base}?player=${ev}`,
  seat: (base, ev, batch, g, seat, nonce) => `${base}?player=${ev}&seat=${batch}.${g}.${seat}.${nonce}`,
  envelope: (set, code, v) => `UG:E:${set}:${code}:v${v}`,
  mission: (ev, round, mid) => `UG:M:${ev}:${round}:${mid}`,
  map: (v, set, map) => `UG:MAP:v${v}:${set}:` + Object.entries(map).map(([c, r]) => `${c.slice(2)}=${r}`).join(','),
  parse(text) {
    const t = String(text || '').trim();
    let m;
    if ((m = t.match(/[?#&]player=([A-Z0-9]{4})&seat=(\d+)\.(\d+)\.(\d+)\.([a-z0-9]+)/i))) return { type: 'seat', ev: m[1].toUpperCase(), batch: +m[2], g: +m[3], seat: +m[4], nonce: m[5].toLowerCase() };
    if ((m = t.match(/[?#&]player=([A-Z0-9]{4})/i))) return { type: 'player', ev: m[1].toUpperCase() };
    if ((m = t.match(/[?#&]join=([A-Z0-9]+)\.(\d+)\.(\d+)/i))) return { type: 'join', ev: m[1].toUpperCase(), batch: +m[2], g: +m[3] };
    if ((m = t.match(/^UG:E:([AB]):(Q-\d{4}):v(\d+)$/))) return { type: 'envelope', set: m[1], code: m[2], v: +m[3] };
    if ((m = t.match(/^UG:M:([A-Z0-9]+):(\d+):(m\d)$/))) return { type: 'mission', ev: m[1], round: +m[2], mid: m[3] };
    if ((m = t.match(/^UG:MAP:v(\d+):([AB]):(.+)$/))) {
      const map = {};
      for (const kv of m[3].split(',')) { const [c, r] = kv.split('='); if (ROLE[r]) map['Q-' + c] = r; }
      return { type: 'map', v: +m[1], set: m[2], map };
    }
    // 手動輸入容錯：全形數字、空白、大小寫、有無「Q-」都可以（例如 4827、q4827、Q 4827、Ｑ－４８２７）
    const plain = t.replace(/[０-９Ｑｑ－]/g, (c) => ({ 'Ｑ': 'Q', 'ｑ': 'Q', '－': '-' }[c] || String.fromCharCode(c.charCodeAt(0) - 0xFEE0))).replace(/\s+/g, '');
    if ((m = plain.match(/^Q?-?(\d{4})$/i))) return { type: 'code', code: 'Q-' + m[1] };
    return { type: 'unknown', text: t };
  },
};

// ── 判定與扣除 ────────────────────────────────────────────────────────────────
const CAR_TYPES = ['轎車', '遊覽車'];

/** 依需求量分攤：3 人平均，不足平均額者扣到 0，差額由剩最多的人補，再由次多的人補。回傳 { code: 付出量 } */
function splitPay(members, key, need) {
  const share = need / members.length;
  const pay = {}, left = {};
  let short = 0;
  for (const m of members) {
    pay[m.code] = Math.min(share, m[key]);
    left[m.code] = m[key] - pay[m.code];
    short += share - pay[m.code];
  }
  const order = [...members].sort((x, y) => left[y.code] - left[x.code]);
  for (const m of order) {
    if (short <= 0) break;
    const more = Math.min(short, left[m.code]);
    pay[m.code] += more; left[m.code] -= more; short -= more;
  }
  return pay;
}

/**
 * members: [{ code, role, money, leave }]（money/leave 為目前剩餘量）
 * 回傳 { ok, reason, totals, deltas: { code: { money, leave } }, stolen? }
 * 圖謀私利（sel）在隊伍中且任務需要存款：照常分攤收錢，但收到的存款全歸圖謀私利（stolen 為他淨拿走的金額），
 *   任務因錢不足而失敗（原因「金額」）。特休不扣。
 * 隊伍若另有陽奉陰違或表面工夫：「人」優先，任務失敗、不扣除，圖謀私利拿不到錢。
 * 任務不需要存款時，圖謀私利和其他破壞型一樣，任務失敗、原因「人」、不扣除。
 */
export function judge(mission, members) {
  const n = mission.need;
  // power／car 可由成員帶入（儀表板修正後的值），沒有就用角色預設
  const roles = members.map((m) => ({ ...ROLE[m.role], ...(m.power != null ? { power: m.power } : {}), ...(m.car ? { car: m.car } : {}) }));
  const totals = {
    money: members.reduce((s, m) => s + m.money, 0),
    leave: members.reduce((s, m) => s + m.leave, 0),
    power: roles.reduce((s, r) => s + r.power, 0),
    cars: roles.filter((r) => CAR_TYPES.includes(r.car)).length,
    bus: roles.filter((r) => r.car === '遊覽車').length,
  };
  const transportOk = () => {
    if (n.transport) return n.transport.some((t) => (!t.bus || totals.bus >= t.bus) && (!t.cars || totals.cars >= t.cars));
    return !n.cars || totals.cars >= n.cars;
  };
  const zero = () => Object.fromEntries(members.map((m) => [m.code, { money: 0, leave: 0 }]));
  const thief = members.find((m) => m.role === 'sel');
  // 隊上另有陽奉陰違／表面工夫 → 「人」優先：任務失敗、不扣除，圖謀私利也拿不到錢
  const otherSabotage = members.some((m) => m.role !== 'sel' && ROLE[m.role].kind === 'sabotage');
  if (thief && n.money && !otherSabotage) {
    const pay = splitPay(members, 'money', n.money);
    const deltas = zero();
    let total = 0;
    for (const m of members) { deltas[m.code].money -= pay[m.code]; total += pay[m.code]; }
    deltas[thief.code].money += total;
    return { ok: false, reason: '金額', totals, deltas, stolen: deltas[thief.code].money, thief: thief.code };
  }
  let reason = null;
  if (roles.some((r) => r.kind === 'sabotage')) reason = '人';
  else if (n.money && totals.money < n.money) reason = '金額';
  else if (n.power && totals.power < n.power) reason = '體力';
  else if (n.leave && totals.leave < n.leave) reason = '特休';
  else if (!transportOk()) reason = '交通';
  if (reason) return { ok: false, reason, totals, deltas: {} };

  const deltas = zero();
  for (const key of ['money', 'leave']) {
    if (!n[key]) continue;
    const pay = splitPay(members, key, n[key]);
    for (const m of members) deltas[m.code][key] -= pay[m.code];
  }
  return { ok: true, reason: null, totals, deltas };
}

export const REASON_ORDER = [
  ['人', '隊伍中有破壞型虛偽大人'],
  ['金額', '存款不足；或圖謀私利拿走存款'],
  ['體力', '體力合計不足'],
  ['特休', '特休合計不足'],
  ['交通', '交通工具不足'],
  ['時間', '5 分鐘內未成行'],
  ['無法派人', `同一回合表決否決 ${VETO_LIMIT} 次`],
];

export function announce(result) {
  return result.ok ? '「任務成功。」' : `「任務失敗，原因：${result.reason}。」`;
}

/** 初始資源帳本 */
export const CAR_OPTIONS = ['徒步', '腳踏車', '機車', '轎車', '遊覽車'];

/** 套用儀表板修正後的角色初始值 */
export function roleWith(id, overrides) { return { ...ROLE[id], ...((overrides && overrides[id]) || {}) }; }
/** 套用儀表板修正後的任務條件（整個 need 物件取代） */
export function missionWith(mid, overrides) {
  const m = MISSION[mid];
  const o = overrides && overrides[mid];
  return o ? { ...m, need: o } : m;
}

export function initialLedger(seatCodes, mapping, roleOverrides) {
  const ledger = {};
  for (const code of Object.values(seatCodes)) {
    const r = roleWith(mapping[code], roleOverrides);
    ledger[code] = { money: r.money, leave: r.leave };
  }
  return ledger;
}
