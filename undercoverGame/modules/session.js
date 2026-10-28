// 資料層：連線模式寫 Firebase，離線模式寫 localStorage。兩者共用同一份資料形狀與「多路徑更新」寫法。
//
// events/<EV>
//   createdAt
//   qr:      { version, updatedAt, sets: { A: { 'Q-4827': 'sen', ... }, B: {...} } }
//   batch:   { no, total, createdAt, groups: { 1: { size, set, roles: [...] }, 2: {...} } }
//   control: { round, missionId, status: idle|running|paused, startAt, accum, updatedAt }
//   live/<g>: { phone, seats: { 1: code }, ledger: { code: {money, leave} },
//               rounds: { <r>: { mid, seats, ok, reason, deltas, timeout, at } }, loaded: { round, mid } }
import { connect } from './fb.js';
import { ROLE, MISSION, ROUND_LIMIT_MS, judge, initialLedger, roleAllowed, roleWith, missionWith } from './rules.js';

const LS_OFFLINE = 'ug.offline.v1';

export function applyPatch(obj, patch) {
  for (const [path, val] of Object.entries(patch)) {
    const keys = path.split('/').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') { if (val === null) { cur = null; break; } cur[keys[i]] = {}; }
      cur = cur[keys[i]];
    }
    if (!cur) continue;
    const last = keys[keys.length - 1];
    if (val === null) delete cur[last]; else cur[last] = JSON.parse(JSON.stringify(val));
  }
  return obj;
}

export function deviceId() {
  try {
    let id = localStorage.getItem('ug.device');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('ug.device', id); }
    return id;
  } catch (e) { return 'nostore'; }
}

export function loadOffline() { try { return JSON.parse(localStorage.getItem(LS_OFFLINE) || 'null'); } catch (e) { return null; } }
export function saveOffline(data) { try { localStorage.setItem(LS_OFFLINE, JSON.stringify(data)); } catch (e) { /* 存不了就只留在記憶體 */ } }
export function clearOffline() { try { localStorage.removeItem(LS_OFFLINE); } catch (e) { /* */ } }

export class EventSession {
  /** mode: 'online' | 'offline' */
  constructor(mode, ev) {
    this.mode = mode; this.ev = ev; this.data = null; this.offset = 0; this.listeners = new Set(); this.online = mode === 'offline';
  }
  async start() {
    if (this.mode === 'offline') {
      this.data = loadOffline() || {};
      this.emit();
      return this;
    }
    this.fb = await connect();
    this.fb.onValue(this.fb.offsetRef(), (s) => { this.offset = s.val() || 0; });
    this.fb.onValue(this.fb.connectedRef(), (s) => { this.online = !!s.val(); this.emit(); });
    await new Promise((resolve) => {
      this.unsub = this.fb.onValue(this.fb.evRef(this.ev), (snap) => { this.data = snap.val(); this.emit(); resolve(); },
        (err) => { this.error = err; this.emit(); resolve(); });
    });
    return this;
  }
  stop() { this.unsub && this.unsub(); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  now() { return Date.now() + this.offset; }

  async patch(p) {
    if (this.mode === 'offline') { this.data = applyPatch(this.data || {}, p); saveOffline(this.data); this.emit(); return; }
    await this.fb.update(this.fb.evRef(this.ev), p);
  }

  // ── 讀取 ─────────────────────────────────────────────
  get qr() { return (this.data && this.data.qr) || null; }
  get batch() { return (this.data && this.data.batch) || null; }
  get control() { return (this.data && this.data.control) || { round: 0, missionId: null, status: 'idle', accum: 0 }; }
  groupCfg(g) { return this.batch && this.batch.groups && this.batch.groups[g]; }
  live(g) { return (this.data && this.data.live && this.data.live[g]) || {}; }
  mapping(g) { const c = this.groupCfg(g); return (c && this.qr && this.qr.sets && this.qr.sets[c.set]) || {}; }
  elapsed() {
    const c = this.control;
    if (c.status === 'running') return (c.accum || 0) + Math.max(0, this.now() - (c.startAt || this.now()));
    return c.accum || 0;
  }
  timeUp() { return this.control.status !== 'idle' && this.elapsed() >= ROUND_LIMIT_MS; }
  seats(g) { return this.live(g).seats || {}; }
  seatOf(g, code) { const s = this.seats(g); return Object.keys(s).find((k) => s[k] === code); }
  allBound(g) { const c = this.groupCfg(g); return !!c && Object.keys(this.seats(g)).length >= c.size; }
  rounds(g) { return this.live(g).rounds || {}; }
  usedMissions(g) {
    const out = {};
    for (const [r, x] of Object.entries(this.rounds(g))) out[x.mid] = +r;
    return out;
  }

  // ── 回合控制（儀表板；離線時由手機自己操作）─────────────────
  async setMission(round, missionId) {
    await this.patch({ control: { round, missionId, status: 'idle', startAt: null, accum: 0, updatedAt: this.now() } });
  }
  async startRound() {
    const c = this.control;
    if (!c.missionId) throw new Error('請先選擇本回合任務');
    await this.patch({ 'control/status': 'running', 'control/startAt': this.now(), 'control/updatedAt': this.now() });
  }
  async pause() {
    const c = this.control;
    if (c.status !== 'running') return;
    await this.patch({ 'control/status': 'paused', 'control/accum': this.elapsed(), 'control/startAt': null });
  }
  async resume() {
    if (this.control.status !== 'paused') return;
    await this.patch({ 'control/status': 'running', 'control/startAt': this.now() });
  }
  async confirmTimeout(g) {
    const c = this.control;
    if (this.rounds(g)[c.round]) throw new Error('本組這回合已經結算');
    await this.patch({ [`live/${g}/rounds/${c.round}`]: { mid: c.missionId, ok: false, reason: '時間', timeout: true, deltas: {}, seats: [], at: this.now() } });
  }

  // ── 手機：綁定、結算、撤銷 ─────────────────────────────
  /** 已綁定座位的角色（實體抽時，臥底以掃到的為準） */
  boundRoles(g) { const map = this.mapping(g); return Object.values(this.seats(g)).map((c) => map[c]); }
  checkEnvelope(g, code) {
    const map = this.mapping(g), cfg = this.groupCfg(g);
    const role = map[code];
    if (!role) return { error: '這個 QR 碼不在本組的信封套別裡（可能是另一套或舊版本）' };
    const exist = this.seatOf(g, code);
    if (exist) return { error: `這個信封已綁定在 ${exist} 號`, role };
    const err = roleAllowed(cfg, role, this.boundRoles(g));
    return err ? { error: err, role } : { role };
  }
  async bindSeat(g, seat, code) {
    const chk = this.checkEnvelope(g, code);
    if (chk.error) throw new Error(chk.error);
    const p = { [`live/${g}/seats/${seat}`]: code };
    const cfg = this.groupCfg(g);
    const seats = { ...this.seats(g), [seat]: code };
    if (Object.keys(seats).length >= cfg.size) p[`live/${g}/ledger`] = initialLedger(seats, this.mapping(g), this.overrides.roles);
    await this.patch(p);
  }
  async unbindSeat(g, seat) {
    if (Object.keys(this.rounds(g)).length) throw new Error('已經開始結算，不能再改座位');
    await this.patch({ [`live/${g}/seats/${seat}`]: null, [`live/${g}/ledger`]: null });
  }
  async loadMission(g, round, mid) { await this.patch({ [`live/${g}/loaded`]: { round, mid } }); }

  members(g, seatList) {
    const seats = this.seats(g), map = this.mapping(g), ledger = this.live(g).ledger || {};
    return seatList.map((s) => {
      const code = seats[s], st = this.stats(g, code);
      return { seat: +s, code, role: map[code], money: ledger[code].money, leave: ledger[code].leave, power: st.power, car: st.car };
    });
  }
  preview(g, mid, seatList) { return judge(this.mission(mid), this.members(g, seatList)); }

  // ── 儀表板修正（角色初始值、任務條件、個別玩家的體力／交通）────────────
  get overrides() { const o = (this.data && this.data.overrides) || {}; return { roles: o.roles || {}, missions: o.missions || {} }; }
  roleBase(id) { return roleWith(id, this.overrides.roles); }
  mission(mid) { return missionWith(mid, this.overrides.missions); }
  /** 某位玩家目前的有效數值：角色初始值（含修正）＋個別修正（體力、交通）＋帳本（存款、特休） */
  stats(g, code) {
    const base = this.roleBase(this.mapping(g)[code]);
    const adj = ((this.live(g).adjust || {})[code]) || {};
    const l = ((this.live(g).ledger || {})[code]) || { money: base.money, leave: base.leave };
    return { ...base, power: adj.power != null ? adj.power : base.power, car: adj.car || base.car, money: l.money, leave: l.leave };
  }
  get notices() {
    const n = (this.data && this.data.notices) || {};
    return Object.entries(n).map(([id, v]) => ({ id, ...v })).sort((a, b) => a.at - b.at);
  }
  /** 寫入修正並留下通知（給儀表板、助理主持人與受影響的玩家） */
  async saveEdits(patch, notice) {
    const at = this.now();
    await this.patch({ ...patch, [`notices/n${at}`]: { ...notice, at } });
  }

  async settle(g, round, mid, seatList) {
    if (this.rounds(g)[round]) throw new Error('這回合已經結算過；要重來請先撤銷');
    const res = this.preview(g, mid, seatList);
    const ledger = this.live(g).ledger;
    const p = { [`live/${g}/rounds/${round}`]: { mid, seats: seatList.map(Number), ok: res.ok, reason: res.reason, deltas: res.deltas, at: this.now() } };
    for (const [code, d] of Object.entries(res.deltas)) {
      p[`live/${g}/ledger/${code}/money`] = ledger[code].money + d.money;
      p[`live/${g}/ledger/${code}/leave`] = ledger[code].leave + d.leave;
    }
    await this.patch(p);
    return res;
  }
  async undo(g, round) {
    const r = this.rounds(g)[round];
    if (!r) return;
    const ledger = this.live(g).ledger;
    const p = { [`live/${g}/rounds/${round}`]: null };
    for (const [code, d] of Object.entries(r.deltas || {})) {
      p[`live/${g}/ledger/${code}/money`] = ledger[code].money - d.money;
      p[`live/${g}/ledger/${code}/leave`] = ledger[code].leave - d.leave;
    }
    await this.patch(p);
  }

  // ── 玩家版 ──────────────────────────────────────────
  get playerCfg() { return (this.data && this.data.player) || { open: false, revealed: false }; }
  /** 依信封找出所在組別（必須已被助理主持人綁定座位） */
  findEnvelope(set, code) {
    for (const g of Object.keys((this.batch && this.batch.groups) || {})) {
      if (this.groupCfg(g).set === set && this.seatOf(g, code)) return +g;
    }
    return null;
  }
  playerBinding(g, code) { return ((this.live(g).players || {})[code]) || null; }
  async claimEnvelope(g, code, device) {
    const b = this.playerBinding(g, code);
    if (b && b.device !== device) throw new Error('LOCKED');
    if (!b) await this.patch({ [`live/${g}/players/${code}`]: { device, at: this.now() } });
  }
  async resetPlayer(g, code) { await this.patch({ [`live/${g}/players/${code}`]: null }); }

  /** 角色查詢：初始值、每回合紀錄、角色卡剩餘欄應填內容 */
  history(g, code) {
    const role = this.roleBase(this.mapping(g)[code]);
    const seat = this.seatOf(g, code);
    let money = role.money, leave = role.leave;
    const boxes = { money: [], leave: [] }, log = [];
    const rounds = this.rounds(g);
    const items = Object.keys(rounds).map((r) => ({ kind: 'round', r: +r, at: rounds[r].at || 0, x: rounds[r] }));
    const adj = this.live(g).adjlog || {};
    for (const [id, a] of Object.entries(adj)) if (a.codes && a.codes[code]) items.push({ kind: 'adj', at: a.at || 0, d: a.codes[code], id });
    items.sort((a, b) => a.at - b.at || (a.r || 0) - (b.r || 0));
    for (const it of items) {
      if (it.kind === 'adj') {
        const d = { money: it.d.money || 0, leave: it.d.leave || 0 };
        if (it.d.reset) { money = it.d.money; leave = it.d.leave; boxes.money.push(money); boxes.leave.push(leave); }
        else {
          if (d.money) { money += d.money; boxes.money.push(money); }
          if (d.leave) { leave += d.leave; boxes.leave.push(leave); }
        }
        log.push({ adjust: true, d: it.d, at: it.at });
        continue;
      }
      const x = it.x;
      const inTeam = seat && (x.seats || []).includes(+seat);
      const d = (x.deltas || {})[code] || { money: 0, leave: 0 };
      if (d.money) { money += d.money; boxes.money.push(money); }
      if (d.leave) { leave += d.leave; boxes.leave.push(leave); }
      log.push({ round: it.r, mid: x.mid, inTeam, ok: x.ok, reason: x.reason, timeout: x.timeout, d });
    }
    return { role, seat, money, leave, boxes, log };
  }
}
