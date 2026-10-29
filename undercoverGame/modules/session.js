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
import { ROLE, MISSION, ROUND_LIMIT_MS, judge, initialLedger, roleAllowed, roleWith, missionWith, VETO_LIMIT, autoSeats, makeNonce, shuffle } from './rules.js';

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
  /** 已綁定座位的角色（實體抽時，虛偽大人以掃到的為準） */
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
    const p = { [`live/${g}/rounds/${round}`]: { mid, seats: seatList.map(Number), ok: res.ok, reason: res.reason, deltas: res.deltas, at: this.now(), ...(res.thief ? { stolen: res.stolen, thief: res.thief } : {}) } };
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
    const p = { [`live/${g}/rounds/${round}`]: null, ...(r.vetoed ? { [`live/${g}/vfails/${round}`]: null } : {}) };
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
    if (this.isAuto(g)) throw new Error('本組沒有信封，請掃座位 QR 碼或選座位號');
    await this.claimSlot(g, code, { device, at: this.now() });
  }
  /** 玩家能不能看角色：實體抽看全場「開放玩家查看」；自動抽角色看本組「開放查看」 */
  viewOpen(g) { return this.isAuto(g) ? this.handOpen(g) : !!this.playerCfg.open; }
  async resetPlayer(g, code) {
    const p = { [`live/${g}/players/${code}`]: null };
    // 自動抽角色：重設時換一組隨機碼，舊的座位 QR（含截圖）就失效
    const seat = this.isAuto(g) && this.seatOf(g, code);
    if (seat) p[`live/${g}/tokens/${seat}`] = makeNonce();
    await this.patch(p);
  }
  /** 寫入手機綁定，避免兩支手機同時搶同一個座位：有交易功能就用交易，否則寫入後再讀回確認 */
  async claimSlot(g, code, rec) {
    const path = `live/${g}/players/${code}`;
    if (this.fb && this.fb.runTransaction) {
      const res = await this.fb.runTransaction(this.fb.evRef(this.ev, path), (cur) => (cur && cur.device !== rec.device ? undefined : (cur || rec)));
      const v = res.snapshot.val();
      if (!res.committed || !v || v.device !== rec.device) throw new Error('LOCKED');
      return;
    }
    const b = this.playerBinding(g, code);
    if (b && b.device !== rec.device) throw new Error('LOCKED');
    if (!b) await this.patch({ [path]: rec });
    const after = this.playerBinding(g, code);
    if (after && after.device !== rec.device) throw new Error('LOCKED');
  }

  // ── 自動抽角色（無實體卡片）：玩家用手機領座位，全組領完後控場開放查看 ──────
  isAuto(g) { const c = this.groupCfg(g); return !!c && c.draw === 'auto'; }
  handOpen(g) { return !!this.live(g).handOpen; }
  /** 曾經開放過：之後就算暫時蓋住，也不能再自選或改座位 */
  handLocked(g) { return !!this.live(g).handOpened; }
  tokens(g) { return this.live(g).tokens || {}; }
  /** 已領取的座位號 */
  claimedSeats(g) {
    const seats = this.seats(g), players = this.live(g).players || {};
    return Object.keys(seats).filter((s) => players[seats[s]]).map(Number).sort((a, b) => a - b);
  }
  /** 建立梯次時，自動抽角色組別的初始資料（座位、帳本、座位 QR 隨機碼） */
  autoLive(cfg) {
    const mapping = this.qr.sets[cfg.set];
    const seats = autoSeats(cfg, mapping);
    const tokens = {};
    for (const s of Object.keys(seats)) tokens[s] = makeNonce();
    return { seats, ledger: initialLedger(seats, mapping, this.overrides.roles), tokens, handOpen: false };
  }
  /** 這支手機目前在本梯次領了哪個座位 */
  myClaim(device) {
    for (const g of Object.keys((this.batch && this.batch.groups) || {})) {
      const players = this.live(g).players || {};
      for (const [code, b] of Object.entries(players)) if (b && b.device === device) return { g: +g, code, seat: +this.seatOf(g, code) };
    }
    return null;
  }
  /**
   * 玩家領座位。nonce：掃工作人員顯示的座位 QR 才有；自選座位不帶。
   * 開放查看後只能用座位 QR 領（避免開放後亂選偷看別人的角色）。
   */
  async claimSeat(g, seat, device, nonce = null) {
    const cfg = this.groupCfg(g);
    if (!cfg || cfg.draw !== 'auto') throw new Error('這一組不是自動抽角色，請掃自己的信封');
    seat = Number(seat);
    if (!(seat >= 1 && seat <= cfg.size)) throw new Error(`座位號碼是 1～${cfg.size}`);
    if (nonce) { if (this.tokens(g)[seat] !== nonce) throw new Error('這個座位 QR 碼已失效，請工作人員重新顯示'); }
    else if (this.handLocked(g)) throw new Error('已開放查看，不能再自己選座位；請找工作人員顯示你的座位 QR 碼');
    const code = this.seats(g)[seat];
    const cur = this.playerBinding(g, code);
    if (cur && cur.device !== device) throw new Error('TAKEN');
    const old = this.myClaim(device);
    if (old && !(old.g === +g && old.code === code)) {
      if (this.handLocked(old.g)) throw new Error(`這支手機已經領了第 ${old.g} 組 ${old.seat} 號，要換座位請找工作人員重設`);
      await this.patch({ [`live/${old.g}/players/${old.code}`]: null });
    }
    try { await this.claimSlot(g, code, { device, at: this.now(), seat }); } catch (e) { throw new Error(e.message === 'LOCKED' ? 'TAKEN' : e.message); }
    return { g: +g, code, seat };
  }
  /** 玩家自己放掉座位（開放查看前，選錯時改座位） */
  async releaseSeat(g, code, device) {
    if (this.handLocked(g)) throw new Error('已開放查看，請找工作人員重設');
    const b = this.playerBinding(g, code);
    if (b && b.device === device) await this.patch({ [`live/${g}/players/${code}`]: null });
  }
  /** 開放前重新隨機排座位：已領座位的手機留在原座位號，只換角色 */
  async reshuffleSeats(g) {
    if (this.handLocked(g)) throw new Error('已開放查看過，不能重排座位');
    if (Object.keys(this.rounds(g)).length) throw new Error('已經開始結算，不能重排座位');
    const cfg = this.groupCfg(g), oldSeats = this.seats(g), players = this.live(g).players || {};
    const seatRoles = shuffle(cfg.seatRoles);
    const next = this.autoLive({ ...cfg, seatRoles });
    const moved = {};
    for (const [s, code] of Object.entries(oldSeats)) if (players[code]) moved[next.seats[s]] = players[code];
    await this.patch({
      [`batch/groups/${g}/seatRoles`]: seatRoles,
      [`live/${g}/seats`]: next.seats, [`live/${g}/ledger`]: next.ledger, [`live/${g}/players`]: moved,
    });
  }
  async openHand(g, force = false) {
    const cfg = this.groupCfg(g);
    if (!force && this.claimedSeats(g).length < cfg.size) throw new Error('還有座位沒領取');
    await this.patch({ [`live/${g}/handOpen`]: true, [`live/${g}/handOpened`]: true });
  }
  async closeHand(g) { await this.patch({ [`live/${g}/handOpen`]: false }); }

  // ── O／X 表決（玩家手機投票，助理主持人與儀表板看統計）──────────────
  vote(g) { return this.live(g).vote || null; }
  /** 有開啟玩家手機的座位（應投票的人） */
  phoneSeats(g) {
    const seats = this.seats(g), players = this.live(g).players || {};
    return Object.keys(seats).filter((s) => players[seats[s]]).map(Number).sort((a, b) => a - b);
  }
  async openVote(g, team = []) {
    const at = this.now();
    await this.patch({ [`live/${g}/vote`]: { id: `v${at}`, round: this.control.round, team: team.map(Number), voters: Object.keys(this.seats(g)).map(Number).sort((a, b) => a - b), status: 'open', votes: {}, at } });
  }
  /** 統計：required 為全組座位（沒手機的人由助理主持人手機輪流交給本人投票） */
  tally(g) {
    const v = this.vote(g);
    if (!v) return null;
    const votes = v.votes || {};
    const voted = Object.keys(votes).map(Number);
    const required = [...new Set([...(v.voters || []), ...voted])].sort((a, b) => a - b);
    const o = voted.filter((s) => votes[s] === 'O').length, x = voted.filter((s) => votes[s] === 'X').length;
    const pending = required.filter((s) => !votes[s]);
    if (v.paper) return { ...v, o: v.po != null ? v.po : null, x: v.px != null ? v.px : null, pending: [], required: [], passed: v.result === 'pass' };
    return { ...v, o, x, pending, required, passed: o > x };
  }
  async castVote(g, voteId, seat, choice) {
    const v = this.vote(g);
    if (!v || v.id !== voteId || v.status !== 'open') throw new Error('這次表決已經結束');
    if (!['O', 'X'].includes(choice)) throw new Error('只能投 O 或 X');
    await this.patch({ [`live/${g}/vote/votes/${seat}`]: choice });
    const t = this.tally(g);
    if (t && t.status === 'open' && !t.pending.length) await this.closeVote(g);
  }
  async closeVote(g) {
    const t = this.tally(g);
    if (!t || t.status !== 'open') return;
    await this.afterVote(g, t.passed, { [`live/${g}/vote/status`]: 'closed', [`live/${g}/vote/result`]: t.passed ? 'pass' : 'fail', [`live/${g}/vote/closedAt`]: this.now() });
  }
  /** 紙本不記名表決：控場主持人收完 O／X 小紙片後，直接登記通過或否決（o、x 票數可省略） */
  async recordVote(g, passed, o = null, x = null) {
    const at = this.now();
    const v = { id: `v${at}`, round: this.control.round, team: [], voters: [], status: 'closed', votes: {}, paper: true, result: passed ? 'pass' : 'fail', at, closedAt: at };
    if (o != null) v.po = o;
    if (x != null) v.px = x;
    await this.afterVote(g, passed, { [`live/${g}/vote`]: v });
  }

  // ── 輪值隊長：每次表決結束（通過或否決）都換下一位；同一回合否決 3 次 → 無法派人，任務失敗 ──
  captain(g) { return this.live(g).captain || 1; }
  voteFails(g, round = this.control.round) { return ((this.live(g).vfails || {})[round]) || 0; }
  async setCaptain(g, seat) { await this.patch({ [`live/${g}/captain`]: Number(seat) }); }
  async afterVote(g, passed, extra = {}) {
    const c = this.control, cfg = this.groupCfg(g);
    const size = (cfg && cfg.size) || 1;
    const p = { ...extra, [`live/${g}/captain`]: (this.captain(g) % size) + 1 };
    if (!passed) {
      const n = this.voteFails(g, c.round) + 1;
      p[`live/${g}/vfails/${c.round}`] = n;
      if (n >= VETO_LIMIT && !this.rounds(g)[c.round] && c.missionId) {
        p[`live/${g}/rounds/${c.round}`] = { mid: c.missionId, ok: false, reason: '無法派人', timeout: true, vetoed: true, deltas: {}, seats: [], at: this.now() };
      }
    }
    await this.patch(p);
  }
  async clearVote(g) { await this.patch({ [`live/${g}/vote`]: null }); }

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
