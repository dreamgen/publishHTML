/* 天達排班協作 — 階段一、二完整版（B1–B6、A6、M8）
 * 僅使用 tdAssign 雲端資料結構（td116/*），支援本機試用與 Firebase 即時協作。
 */
(() => {
  'use strict';
  const BASE = window.BASE_DATA;
  const E = window.TDEngine(BASE);
  const store = window.TDStore.create();
  const CFG = window.TD_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getPath = window.TDStore.getPath;
  // 資料庫鍵的白名單格式（讀進來的鍵一律過濾，避免被拿來做屬性注入）
  const RE_PID = /^[0-9]{1,9}$/, RE_SID = /^[A-Za-z0-9_]{1,24}$/, RE_EXID = /^EX_[A-Za-z0-9_]{1,20}$/, RE_PROPID = /^[A-Za-z0-9_]{1,24}$/, RE_ACK = /^[A-Za-z0-9_~\-]{1,200}$/, RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
  // 取出某節點底下「鍵為純數字人員編號、值為物件」的紀錄（髒資料的鍵或值一律略過）
  const pidRecs = (node) => Object.keys(node && typeof node === 'object' ? node : {}).filter((k) => /^\d+$/.test(k) && RE_PID.test(k) && node[k] && typeof node[k] === 'object').map((k) => [k, node[k]]);
  const BASE_MAX_ID = BASE.people.reduce((mx, p) => Math.max(mx, +p.id || 0), 0);
  const AREAS = E.AREAS;
  const WORK_AREAS = E.ALL_WORK_AREAS; // 六區＋青年班、新民班、機動、交通隊
  const KINDS = [['jz', '忠恕輪值與依日期勤務'], ['k', '廚務組'], ['srv', '服務組'], ['lj', '禮節隊'], ['tr', '交通隊'], ['pov', '人員狀態']];
  const RITUAL_POSTS = ['操持', '燒香禮', '請壇禮', '辦道禮', '獻供人員', '填表／掛號'];
  const PROPOSAL_TYPES = [
    ['換區', '由另一區承接，或兩區對調'],
    ['換日', '同一項任務移到另一天'],
    ['調整人數', '降到需求下限，或請求支援人數'],
    ['合併支援', '兩區合併出勤，名額依人數比例'],
    ['不便時段', '整區在某段期間不排，系統找可對調的日期'],
    ['新單位認領', '班級或青年班認領某一場']
  ];

  const UI = {
    filter: '全部', q: '', out: false, outArea: '', outQ: '', showAll: false,
    person: null, acctOpen: false, lyPick: null, newPerOpen: false, apptQ: '', bindQ: '', famQ: '', toast: '',
    b6Mode: '', b1NomOpen: false, b1ShowCook: false,
    b3Mode: 'group', b3CalYm: '', b3FocusId: '',
    pAddOptOpen: false, a6RemindOpen: false, a6PickAreaOpen: false
  };

  /* ---------------- 設定與狀態工具 ---------------- */
  function isLargeMode() {
    try { return localStorage.getItem('tdAssign-large') === '1'; } catch (e) { return false; }
  }
  function applyLargeMode(on) {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.classList.toggle('large-mode', !!on);
    }
  }
  function toggleLargeMode() {
    const on = !(typeof document !== 'undefined' && document.documentElement && document.documentElement.classList.contains('large-mode'));
    applyLargeMode(on);
    try { localStorage.setItem('tdAssign-large', on ? '1' : '0'); } catch (e) { }
    toast(on ? '已切換為大字版' : '已切換為標準字級');
    render();
  }
  applyLargeMode(isLargeMode());

  // M8 測試開關：以資料庫 td116/config/autoApproveBind（只有總召可寫）為準；
  // 資料庫沒有設定時才用 config.js 的值（本機試用模式的預設）。不再接受 localStorage 覆寫。
  try { localStorage.removeItem('tdAssign-test-autoBind'); } catch (e) { }
  function autoApproveBind() {
    const c = (D().config || {}).autoApproveBind;
    if (typeof c === 'boolean') return c;
    return CFG.autoApproveBind !== false;
  }
  function setAutoApproveBind(val) {
    if (!need(isAdmin(), '只有總召可切換綁定審核方式')) return;
    if (!confirm(val ? '改為「測試期：姓名綁定立即生效」？所有人的綁定將不需區長確認。' : '改為「正式審核：綁定需區長或小組長確認」？')) return;
    store.update(Object.assign({ 'config/autoApproveBind': !!val }, logOp('總召', val ? '綁定審核切為測試期立即生效' : '綁定審核切為正式審核')));
    toast(val ? '已切為測試模式：姓名綁定立即生效' : '已切為正式審核：綁定需區長或小組長確認');
  }
  const D = () => store.data || {};
  const draftVer = () => (D().meta && D().meta.version) || CFG.draftVersion || 'v9.3';
  function nextDraftVer(cur) {
    const m = String(cur || 'v9.3').match(/^v?(\d+)\.(\d+)$/);
    return m ? `v${m[1]}.${+m[2] + 1}` : 'v9.4';
  }
  const rec = (kind, key, pid) => ((D()[kind] || {})[key] || {})[pid];

  /* ---------------- 由雲端資料算出排班模型 ---------------- */
  let M = null, ISS = [], bySlot = {}, byPid = {}, slotProps = {};
  // #20：模型只在「會影響排班模型的資料」變動時重算（presence、log 等變動不重算）
  const MODEL_KEYS = ['rules', 'groups', 'assign', 'edits', 'extra', 'addedPeople', 'pov', 'acks', 'proposals', 'admins', 'sched'];
  let lastModelSig = null;
  function dataSigs() {
    const d = D(), parts = {};
    for (const k in d) if (k !== 'presence') parts[k] = JSON.stringify(d[k]);
    const uid = me() ? me().uid : '';
    const model = uid + '|' + MODEL_KEYS.map((k) => k + ':' + (parts[k] || '')).join('|');
    const view = model + '|' + Object.keys(parts).filter((k) => !MODEL_KEYS.includes(k)).sort().map((k) => k + ':' + parts[k]).join('|')
      + '|' + [me() ? me().name : '', store.mode, store.online, store.pending, store.foreignPending, store.error, store.notice, store.ready, store.authReady].join('/');
    return { model, view };
  }
  function recompute(force, sg) {
    const msig = (sg || dataSigs()).model;
    if (!force && M && msig === lastModelSig) return false;
    lastModelSig = msig;
    const st = E.freshState();
    const d = D();
    st.rules = E.mergeRules(d.rules);
    st.groups = {};
    for (const gm of BASE.groupsMeta) st.groups[gm.id] = Object.keys((d.groups || {})[gm.id] || {}).filter((k) => RE_PID.test(k)).map(Number);
    st.assign = {};
    for (const sid in d.assign || {}) if (RE_SID.test(sid) && d.assign[sid] && typeof d.assign[sid] === 'object') st.assign[sid] = { p: Object.keys(d.assign[sid]).filter((k) => RE_PID.test(k)).map(Number), lk: [] };
    st.edits = cleanEdits(d.edits);
    st.extra = cleanExtra(d.extra);
    st.addedPeople = addedPeopleList(d.addedPeople);
    // P-01：與資料庫讀取規則一致，只有總召或排班人員（sched）才把 pov 放進模型；否則公開畫面不會出現暫停／不方便的訊息
    st.pov = me() && (isAdmin() || (d.sched || {})[me().uid]) ? (d.pov || {}) : {};
    st.acks = normAcks();
    E.setState(st);
    M = E.buildModel();
    ISS = E.allIssues(M);
    bySlot = {}; byPid = {};
    for (const c of ISS) {
      c.ack = st.acks[c.key] || null;
      c.accepted = !!(c.ack && c.ack.st === '接受例外');
      for (const sid of c.slots) (bySlot[sid] = bySlot[sid] || []).push(c);
      if (c.pid != null) (byPid[c.pid] = byPid[c.pid] || []).push(c);
    }
    slotProps = {};
    for (const pr of propList()) {
      if (pr.status === 'resolved') continue;
      for (const sid of Array.isArray(pr.slotIds) ? pr.slotIds : []) (slotProps[sid] = slotProps[sid] || []).push(pr);
    }
    return true;
  }

  /* ---------------- 讀入資料的清理（X-03、R-04、#14） ---------------- */
  const str = (v, n) => (v == null ? '' : String(v)).slice(0, n || 60);
  function cleanEdits(src) {
    const out = {};
    for (const sid in src || {}) {
      const e = src[sid];
      if (!RE_SID.test(sid) || !e || typeof e !== 'object') continue;
      const o = {};
      if (e.area !== undefined && WORK_AREAS.includes(e.area)) o.area = e.area;
      if (e.grp !== undefined) o.grp = str(e.grp, 20);
      if (e.need !== undefined && e.need !== '' && Number.isFinite(+e.need)) o.need = +e.need;
      if (e.loc) o.loc = str(e.loc, 40);
      if (e.d && RE_DATE.test(e.d)) o.d = e.d;
      if (e.e && RE_DATE.test(e.e)) o.e = e.e;
      if (e.lock !== undefined) o.lock = !!e.lock;
      if (e.cancel) o.cancel = true;
      if (e.note) o.note = str(e.note, 300);
      out[sid] = o;
    }
    return out;
  }
  function cleanExtra(src) {
    const out = {};
    for (const k in src || {}) {
      const x = src[k];
      if (!RE_EXID.test(k) || !x || typeof x !== 'object' || !RE_DATE.test(x.d || '') || !WORK_AREAS.includes(x.area)) continue;
      out[k] = Object.assign({}, x, {
        id: k, d: x.d, e: RE_DATE.test(x.e || '') ? x.e : x.d, area: x.area,
        cat: str(x.cat, 20) || '服務', grp: str(x.grp, 20), loc: str(x.loc, 40), label: str(x.label, 60), src: str(x.src, 40),
        need: Number.isFinite(+x.need) && +x.need > 0 ? +x.need : 1, share: Number.isFinite(+x.share) && +x.share > 0 ? +x.share : 1
      });
    }
    return out;
  }
  // addedPeople：以鍵為準、不得蓋掉 data.js 的編號；只有 status 為 ok（或舊資料沒有 status）的人才進名冊
  function addedPeopleList(src, all) {
    const out = [];
    for (const k in src || {}) {
      const p = src[k];
      if (!RE_PID.test(k) || +k <= BASE_MAX_ID || !p || typeof p !== 'object') continue;
      const status = p.status || 'ok';
      if (!all && status !== 'ok') continue;
      out.push({
        id: +k, n: str(p.n, 20) || '（未命名）', a: E.PERSON_AREAS.includes(p.a) ? p.a : '瑞芳', sx: p.sx === '乾' || p.sx === '坤' ? p.sx : '',
        age: Number.isFinite(+p.age) && p.age !== null && p.age !== '' ? +p.age : null, src: 'N',
        lead: str(p.lead, 40), cg: [], cr: str(p.cr, 40), sg: str(p.sg, 40), li: str(p.li, 60), zr: str(p.zr, 40), tr: str(p.tr, 40),
        n115: 0, wd115: 0, cls: '', note: str(p.note, 60), status, by: str(p.by, 128)
      });
    }
    return out;
  }
  // acks：舊鍵含「.」，一律換成新格式的鍵讀取（S-01）
  function normAcks() {
    const out = {};
    for (const k in D().acks || {}) { const v = D().acks[k]; if (v && typeof v === 'object') out[E.normAckKey(k)] = v; }
    return out;
  }
  // 提案：鍵需符合格式，id 以鍵為準（X-02）
  function propList() {
    const out = [];
    for (const k in D().proposals || {}) {
      const p = D().proposals[k];
      if (!RE_PROPID.test(k) || !p || typeof p !== 'object') continue;
      out.push(Object.assign({}, p, { id: k, title: String(p.title || k) }));
    }
    return out;
  }
  const propById = (id) => (RE_PROPID.test(String(id || '')) && D().proposals && D().proposals[id] && typeof D().proposals[id] === 'object') ? Object.assign({}, D().proposals[id], { id, title: String(D().proposals[id].title || id) }) : null;

  /* ---------------- 身分、綁定與權限 ---------------- */
  const me = () => store.user;
  const myUserRec = () => (me() && (D().users || {})[me().uid]) || null;
  function myBoundPerson() {
    const u = myUserRec();
    if (!u || !u.pid || !M) return null;
    // status：ok｜pending｜rejected（#13：被退回的不算已綁定）
    return { p: M.pById[+u.pid] || null, status: u.bindStatus || 'ok', rec: u };
  }
  const boundOk = (bp) => !!(bp && bp.p && bp.status === 'ok');
  const isAdmin = () => !!(me() && (D().admins || {})[me().uid]);
  const memberOf = (area, uid) => ((D().members || {})[area] || {})[uid || (me() && me().uid)];
  const isLead = (area) => { const m = memberOf(area); return !!(m && m.status === 'ok' && m.role === 'lead'); };
  function can(area, kind) {
    if (!me()) return false;
    if (isAdmin()) return true;
    const m = memberOf(area);
    if (!m || m.status !== 'ok') return false;
    return !m.scope || !!m.scope[kind];
  }
  const kindOfGroup = (gk) => String(gk).split('_')[0];
  const gmOf = (gk) => E.GROUP_META_BY_ID[gk];

  /* ---------------- 共用權限工具（階段 1；掛在 window.TDApp 給 console.js 與後續階段用） ---------------- */
  // 總召替「六區」排人＝預排；總召若本身是該區排班人員則直接排入
  const isPreFor = (area) => isAdmin() && !(memberOf(area) && memberOf(area).status === 'ok') && AREAS.includes(area);
  // 預排只有該區區長能確認；六區以外的單位（青年班、新民班、機動、交通隊）總召可確認
  const canConfirmPre = (area) => isLead(area) || (isAdmin() && !AREAS.includes(area));
  const isPublished = () => !!(D().meta && D().meta.published);
  // 一個寫入路徑需要的權限（undo 與前端判斷共用，與 database.rules.json 一致）
  const EDIT_FIELDS = ['area', 'grp', 'need', 'loc', 'd', 'e', 'lock', 'cancel', 'note'];
  const RITUAL_POST_SET = new Set(['操持', '燒香禮', '請壇禮', '辦道禮', '獻供人員', '填表／掛號']);
  function pathInfo(p) {
    const k = String(p).split('/');
    if (k[0] === 'groups' && k.length === 3 && gmOf(k[1]) && RE_PID.test(k[2])) return { type: 'rec', area: gmOf(k[1]).area, kind: kindOfGroup(k[1]) };
    if (k[0] === 'assign' && k.length === 3 && RE_SID.test(k[1]) && RE_PID.test(k[2]) && M && M.byId[k[1]]) return { type: 'rec', area: M.byId[k[1]].area, kind: 'jz' };
    if (k[0] === 'groupMeta' && gmOf(k[1]) && ((k.length === 3 && k[2] === 'leadPid') || (k.length === 4 && k[2] === 'posts' && RITUAL_POST_SET.has(k[3])))) return { type: 'meta', area: gmOf(k[1]).area, kind: kindOfGroup(k[1]) };
    return null;
  }
  const canPath = (p) => { const i = pathInfo(p); return !!(i && can(i.area, i.kind)); };
  // undo 的舊值只接受排班紀錄的形狀（避免被塞入任意資料）
  const REC_KEYS = { by: 'string', n: 'string', at: 'number', pre: 'boolean', okBy: 'string', okAt: 'number', byAuto: 'string' };
  function undoValueOk(info, v) {
    if (v == null) return true;
    if (info.type === 'meta') return typeof v === 'number' && Number.isFinite(v);
    if (typeof v !== 'object' || Array.isArray(v)) return false;
    return Object.keys(v).every((k) => REC_KEYS[k] && typeof v[k] === REC_KEYS[k]) && (v.pre === undefined || v.pre === true);
  }
  // 新 undo 格式：[{ p: 'groups/k_1/12', v: 舊值, a: 寫入後的值 }]（null 會被 RTDB 省略，讀取時視為 null）
  function mkUndo(up, paths) {
    const list = [];
    for (const p of paths || Object.keys(up)) {
      const it = { p };
      const v = getPath(D(), p); if (v != null) it.v = JSON.parse(JSON.stringify(v));
      if (up[p] != null) it.a = JSON.parse(JSON.stringify(up[p]));
      list.push(it);
    }
    return list;
  }
  function normUndo(undo) {
    if (!Array.isArray(undo)) {
      // RTDB 會把陣列存成 {0:…,1:…}；舊版物件格式（路徑為鍵）無法比對現值，不提供復原
      if (undo && typeof undo === 'object' && Object.keys(undo).every((k) => /^\d+$/.test(k))) undo = Object.keys(undo).sort((a, b) => a - b).map((k) => undo[k]);
      else return null;
    }
    const out = [];
    for (const u of undo) {
      if (!u || typeof u.p !== 'string') return null;
      const info = pathInfo(u.p);
      if (!info) return null;
      const v = u.v == null ? null : u.v, a = u.a == null ? null : u.a;
      if (!undoValueOk(info, v) || !undoValueOk(info, a)) return null;
      out.push({ p: u.p, v, a, info });
    }
    return out.length ? out : null;
  }
  function sameVal(x, y) {
    if (x == null && y == null) return true;
    if (x == null || y == null || typeof x !== typeof y) return false;
    if (typeof x !== 'object') return x === y;
    const kx = Object.keys(x).filter((k) => x[k] != null), ky = Object.keys(y).filter((k) => y[k] != null);
    return kx.length === ky.length && kx.every((k) => sameVal(x[k], y[k]));
  }
  // 誰看得到「復原」：本人或本區區長、總召，且每一個路徑都有權限
  function canUndo(l) {
    if (!me() || !l || l.undone) return false;
    const list = normUndo(l.undo);
    if (!list) return false;
    if (!(l.uid === me().uid || isLead(l.area) || isAdmin())) return false;
    return list.every((u) => canPath(u.p));
  }
  const groupSlots = (gk) => M.slots.filter((s) => s.groupKey === gk && !s.cancel);
  const areaGroups = (area) => BASE.groupsMeta.filter((g) => g.area === area);
  const areaDated = (area) => M.slots.filter((s) => !s.groupKey && s.area === area && !s.cancel);
  const myAreas = () => WORK_AREAS.filter((a) => { const m = memberOf(a); return m && m.status === 'ok'; });
  function defaultArea() {
    const mine = myAreas().filter((a) => AREAS.includes(a));
    if (mine.length) return mine[0];
    const bp = myBoundPerson();
    if (bp && bp.p && AREAS.includes(bp.p.a)) return bp.p.a;
    return '瑞芳';
  }

  /* ---------------- 小工具 ---------------- */
  const WD = E.WD;
  const dLabel = (s) => `${E.fmtD(s.d)}${s.e && s.e !== s.d ? '–' + E.fmtD(s.e) : ''}（${WD[s.wd]}）`;
  const slotName = (s) => `${dLabel(s)}${s.label || s.cat}${s.label && !s.label.includes(s.cat) ? ' ' + s.cat : ''}`;
  function ago(t) {
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return '剛剛'; if (m < 60) return m + ' 分鐘前';
    const h = Math.round(m / 60); if (h < 24) return h + ' 小時前';
    const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate();
  }
  const tag = (cls, t) => `<span class="tag ${cls}">${esc(t)}</span>`;
  function toast(t) { UI.toast = t; const el = $('#toast'); if (el) { el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3200); } }
  const need = (ok, msg) => { if (!ok) toast(msg || '沒有權限'); return ok; };
  function cnt(list) { let v = 0, n = 0; for (const c of list || []) { if (c.accepted) continue; if (c.lvl === '違規') v++; else n++; } return { v, n }; }
  const uniq = (a) => [...new Set(a)];
  const isClash = (c) => !c.accepted && c.lvl === '違規' && (c.rule === 'P1' || c.rule === 'P2');
  const isAreaClash = (c) => !c.accepted && c.lvl === '違規' && (c.rule === 'A1' || c.rule === 'A2');

  function groupIssues(gk) {
    const ids = new Set(groupSlots(gk).map((s) => s.id));
    const mem = new Set(M ? (E.getState().groups[gk] || []) : []);
    return uniq(ISS.filter((c) => c.slots.some((id) => ids.has(id)) && (c.pid == null || mem.has(c.pid))));
  }
  const slotIssuesOf = (sid) => bySlot[sid] || [];
  function personIssuesIn(pid, slotIds) {
    const S = new Set(slotIds);
    return (byPid[pid] || []).filter((c) => c.slots.some((id) => S.has(id)) || ['P5', 'P5b', 'P6'].includes(c.rule));
  }

  function groupLead(gk) {
    const meta = (D().groupMeta || {})[gk] || {};
    const memIds = E.getState().groups[gk] || [];
    // #16：組長必須仍是本組組員
    if (meta.leadPid && M.pById[+meta.leadPid] && memIds.includes(+meta.leadPid)) return M.pById[+meta.leadPid];
    const mem = memIds.map((id) => M.pById[id]).filter(Boolean);
    const gm = gmOf(gk);
    if (!gm || !mem.length) return null;
    if (gm.cat === '廚務') return mem.find((p) => /主廚/.test(p.cr || '')) || mem.find((p) => /大廚/.test(p.cr || '')) || null;
    if (gm.cat === '服務') return mem.find((p) => /服務組長/.test(p.lead || '')) || null;
    if (gm.cat === '禮節') return mem.find((p) => /禮節小組長/.test(p.lead || '')) || null;
    return mem.find((p) => /小組長|組長/.test((p.lead || '') + (p.zr || ''))) || null;
  }
  function ownerOfGroup(gm) {
    const k = kindOfGroup(gm.id);
    if (k === 'k') return '主廚';
    if (k === 'srv') return '人事組';
    if (k === 'lj') return '禮節小組長';
    return '區長';
  }
  function ownerOfSlot(s) { return s.cat === '大典前晚' ? '區長' : '輪值組'; }
  function isMineItem(area, kind) {
    if (isAdmin() || isLead(area)) return true;
    const m = memberOf(area);
    if (m && m.status === 'ok') return !m.scope || !!m.scope[kind];
    const bp = myBoundPerson();
    if (bp && bp.p && bp.status === 'ok') return bp.p.a === area;
    return false;
  }

  function evalInGroup(p, gk) {
    const G = groupSlots(gk), ids = new Set(G.map((s) => s.id));
    const list = (M.personSlots[p.id] || []).filter((x) => !ids.has(x.id)).concat(G).sort((a, b) => a.ds - b.ds);
    const iss = E.personIssues(M, p, list).filter((c) => c.slots.some((id) => ids.has(id)) || ['P5', 'P5b', 'P6'].includes(c.rule));
    const hard = iss.filter((c) => c.lvl === '違規'), soft = iss.filter((c) => c.lvl === '注意');
    const occN = E.occasions(list).length;
    return { p, hard, soft, occN, score: -hard.length * 1000 - soft.length * 10 - occN };
  }
  function evalInSlot(p, s) { const ev = E.evalCandidate(M, p, s); ev.occN = ev.occN + 1; return ev; }
  function evalSlotCand(p, s, curSet) {
    const ev = evalInSlot(p, s);
    if (!s.cat.startsWith('忠恕')) return ev;
    const isWd = s.cat === '忠恕平日';
    const prevJz = BASE.prevJz || [];
    const sameType = (j) => j.cat === s.cat;
    const sameBucket = (j) => (isWd ? j.cat === '忠恕平日' : j.cat !== '忠恕平日');
    let coopExact = 0, coopBucket = 0;
    if (curSet && curSet.size) {
      for (const j of prevJz) {
        if (!j.pids.includes(p.id)) continue;
        const shared = j.pids.filter((id) => curSet.has(id)).length;
        if (!shared) continue;
        if (sameType(j)) coopExact += shared;
        else if (sameBucket(j)) coopBucket += shared;
      }
    }
    const exactCnt = prevJz.filter((j) => sameType(j) && j.pids.includes(p.id)).length;
    const holCnt = !isWd ? prevJz.filter((j) => j.cat !== '忠恕平日' && j.pids.includes(p.id)).length : 0;
    const wd115 = p.wd115 || 0, hol115 = Math.max(0, (p.n115 || 0) - wd115);
    const hasRightExp = isWd ? (exactCnt > 0 || wd115 > 0) : (holCnt > 0 || hol115 > 0 || !!p.zr);
    const hasWrongOnly = isWd ? (!hasRightExp && hol115 > 0) : (!hasRightExp && wd115 > 0);
    let boost = coopExact * 80 + coopBucket * 40;
    if (exactCnt > 0) boost += 30 + Math.min(exactCnt, 5) * 3;
    else if (!isWd && holCnt > 0) boost += 15;
    else if (hasRightExp) boost += 12;
    else if (hasWrongOnly) boost -= 20;
    ev.score += boost;
    if (coopExact > 0) ev.lyNote = `去年${s.cat}同日搭檔`;
    else if (coopBucket > 0) ev.lyNote = '去年忠恕同日搭檔';
    else if (exactCnt > 0) ev.lyNote = `去年${s.cat} ${exactCnt} 次`;
    else if (isWd && wd115 > 0) ev.lyNote = `去年平日 ${wd115} 次`;
    else if (!isWd && hol115 > 0) ev.lyNote = `去年假日 ${hol115} 次`;
    return ev;
  }

  /* ---------------- 各區指標計算（供 B1 使用） ---------------- */
  function areaMetrics(area) {
    const activePeople = M.people.filter((p) => p.a === area && !p.off);
    const aSlots = M.slots.filter((s) => !s.cancel && s.area === area);
    let totalDemand = 0;
    // 聯合勤務（基新隊等）每一格的 need 已是本區分到的人數，不再乘 share（與 E.areaLoad 一致）
    for (const s of aSlots) totalDemand += E.slotNeed(M, s);
    const avgLoad = activePeople.length ? totalDemand / activePeople.length : 0;

    const envSrvSlots = aSlots.filter((s) => s.cat === '環境整理' || s.cat === '服務');
    const ljSlots = aSlots.filter((s) => s.cat === '禮節');
    const washSlots = aSlots.filter((s) => s.cat === '洗碗');
    const jzHol = aSlots.filter((s) => s.cat === '忠恕週六' || s.cat === '忠恕週日');
    const jzWd = aSlots.filter((s) => s.cat === '忠恕平日');
    const srvGrps = areaGroups(area).filter((g) => g.cat === '服務').map((g) => g.short);
    const ljGrps = areaGroups(area).filter((g) => g.cat === '禮節').map((g) => g.short);
    const heads = activePeople.filter((p) => /主廚/.test(p.cr || '')).length;
    const leaders = activePeople.filter((p) => /小組長|組長/.test((p.lead || '') + (p.zr || ''))).length;
    const avg115 = activePeople.length ? activePeople.reduce((a, p) => a + (p.n115 || 0), 0) / activePeople.length : 0;
    return {
      peopleCnt: activePeople.length, totalDemand, avgLoad,
      envSrvCnt: envSrvSlots.length, srvGrps,
      ljCnt: ljSlots.length, ljGrps,
      washCnt: washSlots.length,
      jzHol, jzWd, heads, leaders, avg115, aSlots
    };
  }
  function allAreaLoadRank() {
    return AREAS.map((a) => ({ area: a, avg: areaMetrics(a).avgLoad }))
      .sort((x, y) => y.avg - x.avg);
  }

  /* ---------------- 初始提案種子（B2 對應 data.js disc） ---------------- */
  function buildInitialProposals() {
    const now = Date.now();
    return {
      D10: {
        id: 'D10',
        type: '換區',
        area: '瑞芳',
        targetAreas: ['瑞芳', '新莊'],
        slotIds: ['S187'],
        title: '12/11 冬季大典前晚：瑞芳改由新莊負責',
        reason: '當天是明德班結班，明德班日只排新莊。結班當天本區有學員與輔導幹部要到，前晚再排人手會不夠。',
        byName: '瑞芳區長',
        byUid: 'seed',
        at: now - 86400000 * 3,
        status: 'waiting',
        step: 3,
        options: [
          {
            id: 'A', label: '甲 改由新莊',
            changes: { S187: { area: '新莊', lock: false } },
            affectedPeopleNote: '尚未排到個人',
            lockNote: '行事曆寫冬季瑞芳，需回報更正',
            needReply: ['新莊']
          },
          {
            id: 'B', label: '乙 瑞芳照排，避開明德班的人',
            changes: {},
            affectedPeopleNote: '瑞芳需避開明德班學員',
            lockNote: '不需更動行事曆',
            needReply: ['明德班班務']
          },
          {
            id: 'C', label: '丙 瑞芳與基隆＋新莊互換秋冬',
            changes: { S187: { area: '新莊', lock: false }, S185: { area: '瑞芳', lock: false, need: 12 }, S186: { cancel: true } },
            affectedPeopleNote: '兩場都要避開或重排',
            lockNote: '行事曆兩處需回報更正',
            needReply: ['基隆', '新莊']
          }
        ],
        votes: {
          瑞芳: { st: '同意甲', by: '瑞芳區長', at: now - 86400000 * 2 },
          新莊: { st: '待回覆', at: now - 86400000 * 2 }
        },
        talk: {
          t1: { who: '瑞芳區長', area: '瑞芳', at: now - 86400000 * 3, text: '結班當天本區有學員與輔導幹部要到，前晚再排人手會不夠。' },
          t2: { who: '排班總召', area: '總召', at: now - 86400000 * 2, text: '新莊全年人均次數較低，多一場仍低於各區平均。已請新莊確認當晚能出的人數。' },
          t3: { who: '系統', area: '系統', at: now - 86400000, text: '行事曆 11/10 版把冬季大典前晚列為瑞芳並已鎖定。採用甲或丙時會解除鎖定，並提醒回報行事曆更正。' }
        }
      },
      D16: {
        id: 'D16',
        type: '調整人數',
        area: '總召',
        targetAreas: ['內湖', '瑞芳', '三重', '機動'],
        slotIds: ['S036', 'S097', 'S101', 'S105', 'S109'],
        title: '心靈成長班 2.0（玉和）四個週六，廚務怎麼排',
        reason: '行事曆 11/10 版新增 8/14、9/18、10/16、11/20，廚務尚未安排，四天都和環境整理同日。',
        byName: '排班總召',
        byUid: 'seed',
        at: now - 86400000 * 4,
        status: 'discussing',
        step: 2,
        options: [
          {
            id: 'A', label: '甲 機動組承接四場',
            changes: {},
            extraSlots: {
              EX_D16_1: { id: 'EX_D16_1', d: '2027-08-14', e: '2027-08-14', cat: '廚務', area: '機動', grp: '機動', need: 8, share: 1, loc: '天達堂', label: '心靈成長班 2.0', src: '提案D16' },
              EX_D16_2: { id: 'EX_D16_2', d: '2027-09-18', e: '2027-09-18', cat: '廚務', area: '機動', grp: '機動', need: 8, share: 1, loc: '天達堂', label: '心靈成長班 2.0', src: '提案D16' },
              EX_D16_3: { id: 'EX_D16_3', d: '2027-10-16', e: '2027-10-16', cat: '廚務', area: '機動', grp: '機動', need: 8, share: 1, loc: '天達堂', label: '心靈成長班 2.0', src: '提案D16' },
              EX_D16_4: { id: 'EX_D16_4', d: '2027-11-20', e: '2027-11-20', cat: '廚務', area: '機動', grp: '機動', need: 8, share: 1, loc: '天達堂', label: '心靈成長班 2.0', src: '提案D16' }
            },
            affectedPeopleNote: '機動組全年多 4 場',
            lockNote: '新增 4 格機動組廚務',
            needReply: ['機動']
          },
          {
            id: 'B', label: '乙 採分菜制（每場 1 位指導）',
            changes: {},
            extraSlots: {
              EX_D16_1: { id: 'EX_D16_1', d: '2027-08-14', e: '2027-08-14', cat: '協辦', area: '機動', grp: '', need: 1, share: 1, loc: '天達堂', label: '心靈成長班 2.0 分菜指導', src: '提案D16' },
              EX_D16_2: { id: 'EX_D16_2', d: '2027-09-18', e: '2027-09-18', cat: '協辦', area: '機動', grp: '', need: 1, share: 1, loc: '天達堂', label: '心靈成長班 2.0 分菜指導', src: '提案D16' },
              EX_D16_3: { id: 'EX_D16_3', d: '2027-10-16', e: '2027-10-16', cat: '協辦', area: '機動', grp: '', need: 1, share: 1, loc: '天達堂', label: '心靈成長班 2.0 分菜指導', src: '提案D16' },
              EX_D16_4: { id: 'EX_D16_4', d: '2027-11-20', e: '2027-11-20', cat: '協辦', area: '機動', grp: '', need: 1, share: 1, loc: '天達堂', label: '心靈成長班 2.0 分菜指導', src: '提案D16' }
            },
            affectedPeopleNote: '不占廚務組場次，每場僅 1 位儲備廚師',
            lockNote: '需班務提供自理名單',
            needReply: ['機動', '班務']
          }
        ],
        votes: { 總召: { st: '同意乙', by: '排班總召', at: now - 86400000 * 3 } },
        talk: {
          t1: { who: '排班總召', area: '總召', at: now - 86400000 * 3, text: '先以分菜制 vs 機動組整組支援進行試算，請各區評估儲備廚師人選。' }
        }
      },
      D1: {
        id: 'D1',
        type: '換區',
        area: '內湖',
        targetAreas: ['內湖', '機動'],
        slotIds: ['S007', 'S180'],
        title: '2/27 內湖廚務 1 組與忠恕週六大區同一天',
        reason: '115 手冊已排 2/27 內湖廚務 1 組於道院，與改期後的 2/27 忠恕週六大區（內湖）同一天，觸發同區同日兩項違規。',
        byName: '內湖區長',
        byUid: 'seed',
        at: now - 86400000 * 2,
        status: 'discussing',
        step: 3,
        options: [
          {
            id: 'A', label: '甲 廚務 1 組改由機動組支援',
            changes: { S007: { area: '機動', grp: '機動', lock: false } },
            affectedPeopleNote: '內湖 1 組釋出 8 人次回到週六大區',
            lockNote: '解除 115 手冊鎖定',
            needReply: ['內湖', '機動']
          },
          {
            id: 'B', label: '乙 維持現狀（內湖兼顧兩項，標為例外）',
            changes: {},
            affectedPeopleNote: '內湖當天需同時出廚務 1 組與週六大區',
            lockNote: '維持 115 手冊原案',
            needReply: ['內湖']
          }
        ],
        votes: { 內湖: { st: '待回覆', at: now - 86400000 } },
        talk: {
          t1: { who: '系統', area: '系統', at: now - 86400000, text: '依規則 A1，同區同日同時有廚務 1 組與忠恕週六大區會列為違規。' }
        }
      },
      D2: {
        id: 'D2',
        type: '合併支援',
        area: '交通隊',
        targetAreas: ['瑞芳', '內湖', '三重'],
        slotIds: ['S200', 'S201'],
        title: '3/21 天達交通隊與道院交通（聯合二中隊）名單重疊',
        reason: '名冊僅 10 位具交通角色，3/21 同日兩處皆需交通人力，無法由同一批人兼兩地。',
        byName: '排班總召',
        byUid: 'seed',
        at: now - 86400000 * 2,
        status: 'discussing',
        step: 2,
        options: [
          {
            id: 'A', label: '甲 道院交通由各區支援另補 8 人',
            changes: { S201: { need: 8 } },
            affectedPeopleNote: '不拆天達交通隊，道院交通由問卷「可指揮/接駁」者補齊',
            lockNote: '不影響行事曆日期',
            needReply: ['瑞芳', '內湖']
          },
          {
            id: 'B', label: '乙 降為基本需求 6 人',
            changes: { S201: { need: 6 } },
            affectedPeopleNote: '減少 2 位支援需求',
            lockNote: '需與道院交通組確認',
            needReply: ['道院交通組']
          }
        ],
        votes: {},
        talk: {}
      },
      P_1170204: {
        id: 'P_1170204',
        type: '換區',
        area: '內湖',
        targetAreas: ['內湖', '基隆'],
        slotIds: ['S076'],
        title: '117/2/4 忠恕廚務：內湖 1 組改基隆 6 組',
        reason: '11/3 籌備會決議調整，避免內湖連日出勤。',
        byName: '排班總召',
        byUid: 'seed',
        at: now - 86400000 * 10,
        status: 'resolved',
        step: 6,
        chosen: 'A',
        resolvedBy: '籌備會決議',
        resolvedAt: now - 86400000 * 9,
        options: [
          { id: 'A', label: '甲 改由基隆 6 組承接', changes: {}, affectedPeopleNote: '已由基隆 6 組接手', lockNote: '已更新總表', needReply: ['基隆'] }
        ],
        votes: { 內湖: { st: '同意甲', by: '內湖區長' }, 基隆: { st: '同意甲', by: '基隆區長' } },
        talk: { t1: { who: '排班總召', area: '總召', at: now - 86400000 * 9, text: '已依決議套用至 116 草案總表。' } }
      }
    };
  }

  /* ---------------- B2 多方案影響試算引擎 ---------------- */
  function simulateProposalOption(prop, opt) {
    const d = D();
    const baseSt = E.getState();
    const baseConflicts = ISS.filter((c) => !c.accepted && c.lvl === '違規' && ['A1', 'A2', 'P1', 'P2'].includes(c.rule)).length;
    const baseViols = new Set(ISS.filter((c) => !c.accepted && c.lvl === '違規').map((c) => c.key));
    const baseNotices = new Set(ISS.filter((c) => !c.accepted && c.lvl === '注意').map((c) => c.key));

    const nextEdits = Object.assign({}, d.edits || {});
    for (const sid in opt.changes || {}) {
      nextEdits[sid] = Object.assign({}, nextEdits[sid] || {}, opt.changes[sid]);
    }
    const nextExtra = Object.assign({}, d.extra || {}, opt.extraSlots || {});

    const simSt = Object.assign({}, baseSt, { edits: nextEdits, extra: nextExtra });
    let m2, iss2;
    try {
      E.setState(simSt);
      m2 = E.buildModel();
      iss2 = E.allIssues(m2).filter((c) => !((d.acks || {})[c.key] && d.acks[c.key].st === '接受例外'));
    } finally { E.setState(baseSt); } // #17：不論成敗都還原基準狀態

    const nextConflicts = iss2.filter((c) => c.lvl === '違規' && ['A1', 'A2', 'P1', 'P2'].includes(c.rule)).length;
    const addedViols = iss2.filter((c) => c.lvl === '違規' && !baseViols.has(c.key));
    const addedNotices = iss2.filter((c) => c.lvl === '注意' && !baseNotices.has(c.key));

    // 各區場次增減
    const cnt0 = {}, cnt2 = {};
    for (const a of WORK_AREAS) { cnt0[a] = 0; cnt2[a] = 0; }
    for (const s of M.slots) if (!s.cancel && cnt0[s.area] !== undefined) cnt0[s.area]++;
    for (const s of m2.slots) if (!s.cancel && cnt2[s.area] !== undefined) cnt2[s.area]++;
    const areaDiffs = [];
    for (const a of WORK_AREAS) {
      const df = cnt2[a] - cnt0[a];
      if (df !== 0) areaDiffs.push({ area: a, diff: df });
    }

    // 各區負擔變化（人均需求、假日／平日次），協調時說明負擔怎麼移動
    const loadDiffs = [];
    try {
      const L0 = E.areaLoad(M), L2 = E.areaLoad(m2);
      for (const a of WORK_AREAS) {
        const o0 = L0.rows[a], o2 = L2.rows[a];
        if (!o0 || !o2 || (o0.need === o2.need && o0.hol === o2.hol && o0.wk === o2.wk)) continue;
        loadDiffs.push({ area: a, perCap0: o0.perCap, perCap2: o2.perCap, ratio0: o0.ratio, ratio2: o2.ratio, hol0: o0.hol, hol2: o2.hol, wk0: o0.wk, wk2: o2.wk });
      }
    } catch (e) { /* 只影響說明列 */ }

    // 受影響的已排人數與鎖定狀況
    let assignedHit = 0, lockedSrcs = [];
    const checkIds = uniq((prop.slotIds || []).concat(Object.keys(opt.changes || {})));
    for (const sid of checkIds) {
      const s = M.byId[sid];
      if (!s) continue;
      assignedHit += (M.asg[sid] ? M.asg[sid].p.length : 0);
      if (s.lock && opt.changes && opt.changes[sid]) lockedSrcs.push(`${s.src || '已鎖定'}（${slotName(s)}）`);
    }

    return {
      baseConflicts, nextConflicts,
      addedViols, addedNotices,
      areaDiffs, loadDiffs,
      lockedText: opt.lockNote || (lockedSrcs.length ? `原為「${lockedSrcs[0]}」，採用時將解除鎖定` : '不需更動已鎖定行事曆'),
      assignedHit,
      peopleText: (assignedHit ? `影響已排 ${assignedHit} 人次，需確認或通知` : '尚未排到個人') + (opt.affectedPeopleNote && !(assignedHit && /尚未排到個人/.test(opt.affectedPeopleNote)) ? `（${opt.affectedPeopleNote}）` : ''),
      needReplyText: (opt.needReply && opt.needReply.length) ? opt.needReply.join('、') : (areaDiffs.map((x) => x.area).join('、') || prop.area)
    };
  }

  /* ---------------- 寫入操作 ---------------- */
  const stamp = (extra) => Object.assign({ by: me().uid, n: String(me().name || '').slice(0, 40), at: Date.now() }, extra || {});
  // logOp(area, msg, undoList)：undoList 為 mkUndo() 產生的陣列 [{p, v, a}]；舊版「路徑為鍵」的物件不再接受
  function logOp(area, msg, undo) {
    const id = store.pushId();
    const rec = { uid: me().uid, name: String(me().name || '').slice(0, 40), at: Date.now(), area: String(area || '').slice(0, 12), msg: String(msg || '').slice(0, 300) };
    if (Array.isArray(undo) && undo.length) rec.undo = undo;
    else if (undo && !Array.isArray(undo)) console.error('logOp：undo 必須是 mkUndo() 產生的陣列', undo);
    return { ['log/' + id]: rec };
  }
  // #11：送出後的每一筆變更各寫一個鍵 areas/{area}/changes/{id}（一人一筆，不再 read-modify-write）；
  // 舊資料的數字 after 仍會計入。送出／確認／退回會整個覆寫 areas/{area}，changes 一併清空。
  function touchArea(area) {
    const a = (D().areas || {})[area];
    return a && (a.status === 'submitted' || a.status === 'confirmed') && me()
      ? { ['areas/' + area + '/changes/' + store.pushId()]: { at: Date.now(), by: String(me().name || '').slice(0, 40) } } : {};
  }
  function afterCount(area) {
    const a = (D().areas || {})[area] || {};
    return (+a.after || 0) + Object.keys(a.changes && typeof a.changes === 'object' ? a.changes : {}).length;
  }
  function addPerson(kind, key, pid, area, label) {
    const p = M.pById[pid];
    if (!p) return;
    if (kind === 'assign' && M.byId[key] && M.byId[key].cancel) return toast('這一格已取消，不能再排人');
    const pre = isPreFor(area);
    const path = `${kind}/${key}/${pid}`;
    const up = { [path]: stamp(pre ? { pre: true } : null) };
    store.update(Object.assign(up, logOp(area, `${label} ${pre ? '預排' : '加入'} ${p.n}`, mkUndo(up)), touchArea(area)));
    toast(pre ? `已預排 ${p.n}，等 ${area} 區長確認` : `已加入 ${p.n}`);
  }
  // 組員離開某組時，同時清掉指向他的組長／禮節崗位（同一次原子寫入，#16）
  function metaCleanup(gk, pid) {
    const up = {}, meta = (D().groupMeta || {})[gk] || {};
    if (meta.leadPid != null && +meta.leadPid === +pid) up[`groupMeta/${gk}/leadPid`] = null;
    for (const post of RITUAL_POSTS) if (meta.posts && meta.posts[post] != null && +meta.posts[post] === +pid) up[`groupMeta/${gk}/posts/${post}`] = null;
    return up;
  }
  function removePerson(kind, key, pid, area, label) {
    const p = M.pById[pid], path = `${kind}/${key}/${pid}`;
    const up = Object.assign({ [path]: null }, kind === 'groups' ? metaCleanup(key, pid) : {});
    store.update(Object.assign(up, logOp(area, `${label} 移出 ${p ? p.n : pid}`, mkUndo(up)), touchArea(area)));
    toast(`已移出 ${p ? p.n : ''}`);
  }
  // confirmPre 內含權限檢查（#6、C-05）：只有該區區長；六區以外單位總召可確認
  function confirmPre(kind, key, pid, area, label) {
    if (!need(canConfirmPre(area), '預排必須由該區區長確認')) return false;
    const r = rec(kind, key, pid); if (!r) return false;
    const next = Object.assign({}, r); delete next.pre; next.okBy = String(me().name || '').slice(0, 40); next.okAt = Date.now();
    const p = M.pById[pid];
    store.update(Object.assign({ [`${kind}/${key}/${pid}`]: next }, logOp(area, `${label} 確認預排 ${p ? p.n : pid}`)));
    toast('已確認');
    return true;
  }
  function seedDefaults() {
    const up = {
      'meta/seeded': { at: Date.now(), by: me() ? me().name : '本機試用', from: BASE.version },
      'meta/version': draftVer()
    };
    for (const gm of BASE.groupsMeta) for (const pid of BASE.defaultGroups[gm.id] || []) up[`groups/${gm.id}/${pid}`] = { by: 'seed', n: '115 年名單', at: Date.now() };
    if (!Object.keys(D().proposals || {}).length) {
      const initP = buildInitialProposals();
      for (const id in initP) up['proposals/' + id] = initP[id];
    }
    return store.update(up);
  }
  /* 總召開 App 時自動檢查並補寫新規則依賴的節點（acl、leads、config）。
   * acl/g/{gk}={a,k}、acl/s/{sid}={a}、acl/p/{pid}=區、leads/{uid}=true（目前任一區的區長）、config/autoApproveBind */
  const adminSyncTried = new Set();
  function expectedAdminNodes() {
    const want = {};
    for (const gm of BASE.groupsMeta) want['acl/g/' + gm.id] = { a: gm.area, k: kindOfGroup(gm.id) };
    for (const s of M.slots) if (RE_SID.test(s.id)) want['acl/s/' + s.id] = { a: s.area };
    for (const p of M.people) if (E.PERSON_AREAS.includes(p.a)) want['acl/p/' + p.id] = p.a;
    const leads = {};
    for (const a in D().members || {}) for (const uid in D().members[a] || {}) { const m = D().members[a][uid]; if (m && m.role === 'lead' && m.status === 'ok') leads[uid] = true; }
    return { want, leads };
  }
  function adminSyncMap() {
    if (!isAdmin() || !M || !(D().meta || {}).seeded) return null;
    const up = {};
    const { want, leads } = expectedAdminNodes();
    const have = D().acl || {};
    for (const p in want) if (!sameVal(getPath({ acl: have }, p), want[p])) up[p] = want[p];
    for (const sec of ['g', 's', 'p']) for (const k in have[sec] || {}) if (!(('acl/' + sec + '/' + k) in want)) up['acl/' + sec + '/' + k] = null;
    for (const uid in leads) if ((D().leads || {})[uid] !== true) up['leads/' + uid] = true;
    for (const uid in D().leads || {}) if (!leads[uid]) up['leads/' + uid] = null;
    if (typeof (D().config || {}).autoApproveBind !== 'boolean') up['config/autoApproveBind'] = CFG.autoApproveBind !== false;
    return Object.keys(up).length ? up : null;
  }
  function ensureAdminNodes() {
    if (store.mode === 'firebase' && (!store.authReady || !store.online)) return;
    const up = adminSyncMap(); if (!up) return;
    const sig = JSON.stringify(up);
    if (adminSyncTried.has(sig)) return; // 同一份差異只送一次，避免權限錯誤時無限重送
    adminSyncTried.add(sig);
    setTimeout(() => store.update(up), 0);
  }

  /* M8 姓名綁定、加入名冊、代管家人 */
  // 同一名冊人員已被其他帳號綁定生效（#13）
  const boundByOther = (pid) => Object.entries(D().users || {}).some(([uid, u]) => u && +u.pid === +pid && u.bindStatus === 'ok' && (!me() || uid !== me().uid));
  function bindPersonToMe(pid) {
    if (!me()) return toast('請先登入');
    const p = M.pById[+pid]; if (!p) return;
    const dup = boundByOther(p.id);
    const auto = autoApproveBind(), boss = isAdmin() || isLead(p.a);
    const okNow = !dup && (auto || boss);
    const uid = me().uid;
    store.update({
      [`users/${uid}/pid`]: +pid,
      [`users/${uid}/bindStatus`]: okNow ? 'ok' : 'pending',
      [`users/${uid}/bindArea`]: p.a,
      [`users/${uid}/bindAt`]: Date.now(),
      [`users/${uid}/bindOkBy`]: okNow ? (boss ? String(me().name || '').slice(0, 40) : '測試期自動生效') : null
    });
    toast(dup ? `「${p.n}」已被其他帳號綁定，已送出申請，待 ${p.a} 區長確認` : okNow ? `已綁定為 ${p.n}（${p.a}）` : `已送出「${p.n}」綁定申請，待 ${p.a} 區長確認`);
  }
  // 新名冊編號：8 位數亂數（不與 data.js 1–377 衝突，兩人同時申請也不會撞號；寫入前再檢查一次）
  function newPersonId(extraUsed) {
    const used = (id) => !!(M.pById[id] || (D().addedPeople || {})[id] || (extraUsed && extraUsed.has(id)));
    for (let i = 0; i < 40; i++) {
      const r = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 4294967296);
      const id = 10000000 + (r % 89999999);
      if (!used(id)) { if (extraUsed) extraUsed.add(id); return id; }
    }
    return 0;
  }
  function createRosterPersonFromFinder(d) {
    const owner = d.kind === 'groups' ? gmOf(d.key) : d.kind === 'assign' ? M.byId[d.key] : null;
    if (!owner) return;
    const permKind = d.kind === 'groups' ? kindOfGroup(d.key) : 'jz';
    if (!need(can(owner.area, permKind))) return;
    if (d.join === '1' && d.kind === 'assign' && owner.cancel) return toast('這一格已取消，不能再排人');
    const rawNames = ($('#fNewPerName') && $('#fNewPerName').value) || '';
    const names = splitQueryTerms(rawNames).map((s) => s.slice(0, 20)).filter(Boolean);
    if (!names.length) return toast('請輸入姓名');
    const targetAreaRaw = ($('#fNewPerArea') && $('#fNewPerArea').value) || owner.area;
    const targetArea = E.PERSON_AREAS.includes(targetAreaRaw) ? targetAreaRaw : '瑞芳';
    const sxRaw = ($('#fNewPerSx') && $('#fNewPerSx').value) || '';
    const sx = sxRaw === '乾' || sxRaw === '坤' ? sxRaw : '';
    const note = String((($('#fNewPerNote') && $('#fNewPerNote').value) || '排班人員新增名冊')).trim().slice(0, 60) || '排班人員新增名冊';
    const uid = me().uid, pre = isPreFor(owner.area), join = d.join === '1';
    const up = {}, joinPaths = [], usedIds = new Set();
    let created = 0, joined = 0, skipped = 0;
    const curIds = finderCtx ? finderCtx.inIds : new Set();
    for (const nm of names) {
      const existing = M.people.find((p) => p.n === nm && p.a === targetArea && !p.off);
      if (existing) {
        if (join && !curIds.has(existing.id)) {
          const pth = `${d.kind}/${d.key}/${existing.id}`;
          up[pth] = stamp(pre ? { pre: true } : null);
          joinPaths.push(pth);
          joined++;
        } else {
          skipped++;
        }
        continue;
      }
      const newId = newPersonId(usedIds);
      if (!newId) return toast('無法產生名冊編號，請稍後再試');
      up[`addedPeople/${newId}`] = {
        id: newId, n: nm, a: targetArea, sx,
        src: 'N', note, status: 'ok', by: uid, at: Date.now()
      };
      created++;
      if (join) {
        const pth = `${d.kind}/${d.key}/${newId}`;
        up[pth] = stamp(pre ? { pre: true } : null);
        joinPaths.push(pth);
        joined++;
      }
    }
    if (!created && !joined) return toast(skipped ? '名冊已有同名人員且已在此名單內' : '沒有可新增的人員');
    const lbl = d.label || (d.kind === 'groups' ? owner.name : slotName(owner));
    const logMsg = created
      ? `${lbl} 新增名冊 ${created} 人${joined ? `並${pre ? '預排' : '加入'} ${joined} 人` : ''}`
      : `${lbl} ${pre ? '預排' : '加入'} ${joined} 人`;
    const undo = joinPaths.length ? mkUndo(up, joinPaths) : undefined;
    if ($('#fNewPerName')) $('#fNewPerName').value = '';
    if ($('#fNewPerNote')) $('#fNewPerNote').value = '';
    if (join) { if (UI.out) UI.outQ = ''; else UI.q = ''; }
    UI.newPerOpen = false;
    store.update(Object.assign(up, logOp(owner.area, logMsg, undo), join ? touchArea(owner.area) : null));
    const parts = [];
    if (created) parts.push(`已新增名冊 ${created} 人`);
    if (joined) parts.push(`${pre ? '預排' : '加入'} ${joined} 人`);
    if (skipped) parts.push(`${skipped} 人已在名單`);
    toast(parts.join('，'));
  }
  function applyNewPerson(name, area, sx, note) {
    if (!me()) return toast('請先登入');
    name = String(name || '').trim().slice(0, 20);
    if (!name) return toast('請輸入姓名');
    if (!E.PERSON_AREAS.includes(area)) area = '瑞芳';
    const newId = newPersonId();
    if (!newId) return toast('無法產生名冊編號，請稍後再試');
    const okNow = autoApproveBind() || isAdmin() || isLead(area);
    const uid = me().uid;
    const person = {
      id: newId, n: name, a: area, sx: sx === '乾' || sx === '坤' ? sx : '',
      src: 'N', note: String(note || 'M8 申請加入名冊').slice(0, 60),
      status: okNow ? 'ok' : 'pending', by: uid, at: Date.now()
    };
    store.update(Object.assign({
      [`addedPeople/${newId}`]: person,
      [`users/${uid}/pid`]: newId,
      [`users/${uid}/bindStatus`]: okNow ? 'ok' : 'pending',
      [`users/${uid}/bindArea`]: person.a,
      [`users/${uid}/bindAt`]: Date.now(),
      [`users/${uid}/bindOkBy`]: okNow ? (isAdmin() || isLead(area) ? String(me().name || '').slice(0, 40) : '測試期自動生效') : null
    }, logOp(person.a, `申請新增名冊與綁定：${name}`)));
    toast(okNow ? `已將 ${name} 加入名冊並綁定` : `已送出「${name}」加入名冊申請`);
  }
  function toggleFamily(pid, add) {
    if (!me()) return;
    const uid = me().uid, p = M.pById[+pid];
    if (!p) return;
    // #26：代管家人只是自己的快捷清單（班表本來就公開、不含任何權限）；仍限制對象：不能是自己、不重複、最多 10 位
    const bp = myBoundPerson(), fam = (myUserRec() || {}).family || {};
    if (add) {
      if (bp && bp.p && bp.p.id === p.id) return toast('這是您自己的姓名，不用加入代管');
      if (fam[p.id]) return toast(`${p.n} 已經在代管清單`);
      if (Object.keys(fam).length >= 10) return toast('代管家人最多 10 位');
    }
    store.set(`users/${uid}/family/${pid}`, add ? { pid: +pid, n: p.n, a: p.a, at: Date.now() } : null);
    toast(add ? `已加入代管家人：${p.n}` : `已移除代管：${p.n}`);
  }
  function approveBind(uid, allow) {
    const u = (D().users || {})[uid]; if (!u) return;
    const area = u.bindArea || '瑞芳';
    if (!need(isLead(area) || isAdmin())) return;
    // 新名冊申請（addedPeople）一併核准或退回（#14）
    const ap = u.pid && (D().addedPeople || {})[u.pid];
    const apUp = ap && ap.status && ap.status !== (allow ? 'ok' : 'rejected') ? { [`addedPeople/${u.pid}/status`]: allow ? 'ok' : 'rejected' } : {};
    const nm = String(me().name || '').slice(0, 40);
    if (allow) {
      store.update(Object.assign({
        [`users/${uid}/bindStatus`]: 'ok',
        [`users/${uid}/bindOkBy`]: nm,
        [`users/${uid}/bindOkAt`]: Date.now()
      }, apUp, logOp(area, `確認 ${u.name} 綁定名冊姓名`)));
      toast('已確認姓名綁定');
    } else {
      store.update(Object.assign({
        [`users/${uid}/bindStatus`]: 'rejected',
        [`users/${uid}/bindOkBy`]: nm
      }, apUp, logOp(area, `退回 ${u.name} 姓名綁定申請`)));
      toast('已退回綁定申請');
    }
  }

  /* B6 禮節崗位、組長、移組、帶入去年 */
  function bringLastYearGroup(gk) {
    const gm = gmOf(gk); if (!gm || !need(can(gm.area, kindOfGroup(gk)))) return;
    const cur = new Set(E.getState().groups[gk] || []);
    let ids = (BASE.defaultGroups[gk] || []).filter((id) => !cur.has(id) && M.pById[id] && !M.pById[id].off);
    let fromNote = '115 年名單';
    if (!ids.length && gm.cat === '禮節') {
      // 禮節隊在 BASE.defaultGroups 為空時，依 115 年禮節經驗與交錯均分規則建議帶入
      const cands = M.people.filter((p) => p.a === gm.area && !p.off && p.li && !E.isHeadCook(p));
      cands.sort((a, b) => (/禮節小組長/.test(b.lead || '') - /禮節小組長/.test(a.lead || '')) || (b.n115 || 0) - (a.n115 || 0));
      const is1 = gk.endsWith('1'), is2 = gk.endsWith('2');
      const picked = (is1 || is2) ? cands.filter((_, i) => (is1 ? i % 2 === 0 : i % 2 === 1)) : cands;
      ids = picked.slice(0, gm.need || 12).map((p) => p.id).filter((id) => !cur.has(id));
      fromNote = '115 年禮節經驗名單';
    }
    if (!ids.length) return toast('沒有可再帶入的人員');
    const up = {}, pre = isPreFor(gm.area); for (const id of ids) up[`groups/${gk}/${id}`] = stamp(pre ? { pre: true } : null);
    store.update(Object.assign(up, logOp(gm.area, `${gm.name} 帶入${fromNote} ${ids.length} 人`), touchArea(gm.area)));
    toast(`已補上 ${ids.length} 人（${fromNote}）`);
  }
  function autoAssignRitualPosts(gk) {
    const gm = gmOf(gk); if (!gm || gm.cat !== '禮節' || !need(can(gm.area, 'lj'))) return;
    const mem = (E.getState().groups[gk] || []).map((id) => M.pById[id]).filter(Boolean);
    if (!mem.length) return toast('請先加入組員（或按「帶入去年」）');
    const used = new Set(), up = {};
    for (const post of RITUAL_POSTS) {
      const kw = post.replace('人員', '').replace('／掛號', '');
      const hit = mem.find((p) => !used.has(p.id) && (p.li || '').includes(kw))
        || (post === '操持' ? mem.find((p) => !used.has(p.id) && /禮節小組長/.test(p.lead || '')) : null)
        || mem.find((p) => !used.has(p.id));
      if (hit) { used.add(hit.id); up[`groupMeta/${gk}/posts/${post}`] = hit.id; }
    }
    store.update(Object.assign(up, logOp(gm.area, `${gm.name} 依 115 年經驗自動配崗`), touchArea(gm.area)));
    toast('已完成禮節 6 大崗位配崗');
  }
  function moveGroupMember(fromGk, toGk, pid) {
    const gmFrom = gmOf(fromGk), gmTo = gmOf(toGk), p = M.pById[+pid];
    if (!gmFrom || !gmTo || !p) return;
    if (!need(can(gmFrom.area, kindOfGroup(fromGk)) && can(gmTo.area, kindOfGroup(toGk)), '您沒有同時異動兩組的權限')) return;
    const prev = rec('groups', fromGk, pid) || null;
    if (!prev) return toast(`${p.n} 不在 ${gmFrom.name}`);
    if (rec('groups', toGk, pid)) return toast(`${p.n} 已經在 ${gmTo.name}，沒有移動`);
    const fromPath = `groups/${fromGk}/${pid}`, toPath = `groups/${toGk}/${pid}`;
    // #5：保留原紀錄；原本是預排、或總召移入六區的組，都維持預排（不可繞過區長確認）
    const keepPre = (prev && prev.pre) || isPreFor(gmTo.area);
    const moved = Object.assign({}, prev, stamp());
    if (keepPre) { moved.pre = true; delete moved.okBy; delete moved.okAt; } else delete moved.pre;
    const up = Object.assign({ [fromPath]: null, [toPath]: moved }, metaCleanup(fromGk, pid));
    store.update(Object.assign(
      up,
      logOp(gmFrom.area, `${p.n} 從 ${gmFrom.name} 移到 ${gmTo.name}`, mkUndo(up)),
      touchArea(gmFrom.area), touchArea(gmTo.area)
    ));
    UI.b6Mode = '';
    toast(`已將 ${p.n} 移到 ${gmTo.name}`);
  }

  /* B4 帶入去年 & 系統建議補滿 */
  function jzOtherUsedMap(s) {
    const used = {};
    for (const o of M.slots) {
      if (o.cancel || o.id === s.id || o.area !== s.area || o.cat !== s.cat) continue;
      for (const id of M.asg[o.id].p) {
        if (!used[id]) used[id] = [];
        used[id].push(E.fmtD(o.d));
      }
    }
    return used;
  }
  function jzPrevGroups(s) {
    const isWd = s.cat === '忠恕平日';
    const prevJz = BASE.prevJz || [];
    const exact = prevJz.filter((j) => j.area === s.area && j.cat === s.cat);
    const bucket = prevJz.filter((j) => j.area === s.area && (isWd ? j.cat === '忠恕平日' : j.cat !== '忠恕平日'));
    const raw = exact.length ? exact : bucket;
    const seen = new Map();
    for (let i = raw.length - 1; i >= 0; i--) {
      const j = raw[i];
      const key = [...j.pids].sort((a, b) => a - b).join(',');
      if (!seen.has(key)) seen.set(key, j);
    }
    const used = jzOtherUsedMap(s);
    const groups = [...seen.values()].map((j) => {
      let overlap = 0;
      const dates = new Set();
      for (const id of j.pids) {
        if (used[id]) { overlap++; used[id].forEach((d) => dates.add(d)); }
      }
      return Object.assign({}, j, { overlap, usedDates: [...dates] });
    });
    groups.sort((a, b) => (a.overlap - b.overlap) || (a.d < b.d ? 1 : -1));
    return groups;
  }
  function jzLastYearRank(pool, s, cur, preferredGroup) {
    const isWd = s.cat === '忠恕平日';
    const prevJz = BASE.prevJz || [];
    const sameType = (j) => j.cat === s.cat;
    const sameBucket = (j) => (isWd ? j.cat === '忠恕平日' : j.cat !== '忠恕平日');
    const used = jzOtherUsedMap(s);
    let anchor = preferredGroup || null;
    if (!anchor && !cur.size) {
      const groups = jzPrevGroups(s);
      if (groups.length) anchor = groups[0];
    }
    const anchorSet = new Set(anchor ? anchor.pids : []);
    return pool.filter((p) => {
      if (anchorSet.has(p.id)) return true;
      const exactCnt = prevJz.filter((j) => sameType(j) && j.pids.includes(p.id)).length;
      const holCnt = !isWd ? prevJz.filter((j) => j.cat !== '忠恕平日' && j.pids.includes(p.id)).length : 0;
      const wd115 = p.wd115 || 0;
      const hol115 = Math.max(0, (p.n115 || 0) - wd115);
      return isWd ? (exactCnt > 0 || wd115 > 0) : (holCnt > 0 || hol115 > 0 || !!p.zr);
    }).map((p) => {
      const ev = evalInSlot(p, s);
      if (ev.hard.length) return null;
      const exactCnt = prevJz.filter((j) => sameType(j) && j.pids.includes(p.id)).length;
      const holCnt = !isWd ? prevJz.filter((j) => j.cat !== '忠恕平日' && j.pids.includes(p.id)).length : 0;
      let coop = 0;
      if (preferredGroup) {
        coop = anchorSet.has(p.id) ? 20000 : 0;
      } else if (cur.size) {
        for (const j of prevJz) {
          if (!j.pids.includes(p.id)) continue;
          const shared = j.pids.filter((id) => cur.has(id)).length;
          if (shared) coop += shared * (sameType(j) ? 10000 : sameBucket(j) ? 4000 : 1000);
        }
      } else if (anchorSet.has(p.id)) {
        coop = 10000;
      }
      const dupPenalty = !preferredGroup && used[p.id] ? used[p.id].length * 5000 : 0;
      const typeScore = (exactCnt ? 2000 + exactCnt * 100 : (!isWd && holCnt ? 500 + holCnt * 50 : 0))
        + (isWd ? (p.wd115 || 0) * 20 : Math.max(0, (p.n115 || 0) - (p.wd115 || 0)) * 20)
        + (p.zr ? 300 : 0);
      ev.lyScore = coop - dupPenalty + typeScore + ev.score;
      return ev;
    }).filter(Boolean).sort((a, b) => b.lyScore - a.lyScore);
  }
  function applyLastYearSlot(sid, groupIdx) {
    const s = M.byId[sid]; if (!s || !need(can(s.area, 'jz'))) return;
    if (s.cancel) return toast('這一格已取消，不能再排人');
    const cur = new Set(M.asg[sid].p), needN = E.slotNeed(M, s), left = Math.max(0, needN - cur.size);
    if (!left) return toast('這一格人數已達需求');
    let pick = [];
    if (s.cat.startsWith('忠恕') && groupIdx >= 0) {
      const g = jzPrevGroups(s)[groupIdx];
      if (!g) return toast('找不到該去年組合');
      pick = g.pids.map((id) => M.pById[id]).filter((p) => p && !p.off && !cur.has(p.id)).slice(0, left).map((p) => ({ p }));
    } else {
      const pool = E.poolFor(M, s, false).filter((p) => !cur.has(p.id));
      const ranked = s.cat.startsWith('忠恕')
        ? jzLastYearRank(pool, s, cur, null)
        : pool.filter((p) => p.n115 > 0).map((p) => evalInSlot(p, s)).filter((ev) => !ev.hard.length)
            .sort((a, b) => (b.p.n115 || 0) - (a.p.n115 || 0) || b.score - a.score);
      pick = ranked.slice(0, left);
    }
    if (!pick.length) return toast(groupIdx >= 0 ? '這一組沒有可帶入的人員' : '去年有經驗且無衝突的人都在裡面了，請改用「系統建議補滿」');
    const up = {}, label = slotName(s), pre = isPreFor(s.area);
    for (const ev of pick) up[`assign/${sid}/${ev.p.id}`] = stamp(pre ? { pre: true } : null);
    UI.lyPick = null;
    store.update(Object.assign(up, logOp(s.area, `${label} 帶入去年名單 ${pick.length} 人`, mkUndo(up)), touchArea(s.area)));
    toast(`已帶入 ${pick.length} 人`);
  }
  function bringLastYearSlot(sid) {
    const s = M.byId[sid]; if (!s || !need(can(s.area, 'jz'))) return;
    if (s.cancel) return toast('這一格已取消，不能再排人');
    const cur = new Set(M.asg[sid].p);
    if (!cur.size && s.cat.startsWith('忠恕')) {
      const groups = jzPrevGroups(s);
      if (groups.length > 1) { UI.lyPick = sid; render(); return; }
    }
    applyLastYearSlot(sid, -1);
  }
  function autoFillSlot(sid) {
    const s = M.byId[sid]; if (!s || !need(can(s.area, 'jz'))) return;
    if (s.cancel) return toast('這一格已取消，不能再排人');
    const cur = new Set(M.asg[sid].p), needN = E.slotNeed(M, s);
    let left = Math.max(0, needN - cur.size);
    if (!left) return toast('這一格人數已滿');
    let pool = E.poolFor(M, s, false).filter((p) => !cur.has(p.id));
    let hasLead = M.asg[sid].p.some((id) => E.canLead(M.pById[id], s));
    const chosen = [];
    while (left > 0 && pool.length) {
      let best = null;
      for (const p of pool) {
        const ev = evalInSlot(p, s);
        if (ev.hard.length) continue;
        let sc = ev.score;
        if (E.needsLead(s) && !hasLead && E.canLead(p, s)) sc += 1000;
        if (!best || sc > best.sc) best = { p, sc };
      }
      if (!best) break;
      chosen.push(best.p);
      if (E.canLead(best.p, s)) hasLead = true;
      pool = pool.filter((p) => p !== best.p);
      left--;
    }
    if (!chosen.length) return toast('目前本區沒有可無違規補入的候選人，請改用「找非本區人員」或手動排入');
    const up = {}, label = slotName(s), pre = isPreFor(s.area);
    for (const p of chosen) up[`assign/${sid}/${p.id}`] = stamp(pre ? { pre: true } : null);
    store.update(Object.assign(up, logOp(s.area, `${label} 系統建議補滿 ${chosen.length} 人`, mkUndo(up)), touchArea(s.area)));
    toast(`已依合適程度補入 ${chosen.length} 人`);
  }

  /* B2 提案寫入與決議套用 */
  function createProposalFromForm(areaDefault) {
    if (!me()) return toast('請先登入');
    const type = $('#npType').value;
    const sid = $('#npSlot').value;
    const title = ($('#npTitle').value || '').trim().slice(0, 120);
    const reason = ($('#npReason').value || '').trim().slice(0, 1000);
    const targetArea = $('#npTargetArea') ? $('#npTargetArea').value : '';
    const newDate = $('#npNewDate') ? $('#npNewDate').value : '';
    const newNeed = $('#npNewNeed') ? $('#npNewNeed').value : '';
    if (!title) return toast('請輸入提案標題');
    const s = sid ? M.byId[sid] : null;
    const area = s ? s.area : (areaDefault || defaultArea());
    const id = 'P_' + store.pushId().slice(-6).toUpperCase();
    const chA = {};
    if (s) {
      if (type === '換區' && targetArea) chA[s.id] = { area: targetArea, lock: false };
      else if (type === '換日' && newDate) chA[s.id] = { d: newDate, lock: false };
      else if (type === '調整人數' && newNeed) chA[s.id] = { need: +newNeed };
      else if (type === '新單位認領' && targetArea) chA[s.id] = { area: targetArea, lock: false };
    }
    const labelA = type === '換區' && targetArea ? `甲 改由${targetArea}負責`
      : type === '換日' && newDate ? `甲 改期至 ${E.fmtD(newDate)}`
      : type === '調整人數' && newNeed ? `甲 需求人數調整為 ${newNeed} 人`
      : '甲 依提案調整';
    const prop = {
      id, type, area,
      targetAreas: uniq([area, targetArea].filter(Boolean)),
      slotIds: s ? [s.id] : [],
      title, reason: reason || '區內討論提出調整',
      byName: String(me().name || '').slice(0, 40), byUid: me().uid, at: Date.now(),
      status: 'waiting', step: 3,
      options: [
        { id: 'A', label: labelA, changes: chA, needReply: targetArea ? [targetArea] : [area] },
        { id: 'B', label: '乙 維持原案，區內協調例外', changes: {}, needReply: [area] }
      ],
      votes: isLead(area) ? { [area]: { st: '同意甲', by: String(me().name || '').slice(0, 40), at: Date.now() } } : {},
      talk: {}
    };
    store.update(Object.assign({ ['proposals/' + id]: prop }, logOp(area, `提出調整提案 ${id}：${title}`)))
      .then(() => { location.hash = '#/p/' + id; });
    toast('已送出提案並完成影響試算');
  }
  function addOptionToProposal(propId) {
    if (!me()) return toast('請先登入');
    const pr = propById(propId); if (!pr) return;
    // 與規則一致：總召、提案人或排班人員可新增做法
    if (!need(isAdmin() || pr.byUid === me().uid || isLead(pr.area), '只有提案人、提案所屬區的區長或總召可新增做法')) return;
    const label = ($('#optLabel').value || '').trim().slice(0, 60);
    const sid = $('#optSlot') ? $('#optSlot').value : (pr.slotIds && pr.slotIds[0]) || '';
    const area = $('#optArea') ? $('#optArea').value : '';
    const date = $('#optDate') ? $('#optDate').value : '';
    const needVal = $('#optNeed') ? $('#optNeed').value : '';
    if (!label) return toast('請輸入做法名稱');
    const idx = (pr.options || []).length;
    const letter = String.fromCharCode(65 + idx);
    const prefix = ['甲', '乙', '丙', '丁', '戊'][idx] || letter;
    const changes = {};
    if (sid) {
      const ch = {};
      if (area) { ch.area = area; ch.lock = false; }
      if (date) { ch.d = date; ch.lock = false; }
      if (needVal) ch.need = +needVal;
      if (Object.keys(ch).length) changes[sid] = ch;
    }
    const nextOpts = (Array.isArray(pr.options) ? pr.options : Object.values(pr.options || {})).concat([{
      id: letter, label: `${prefix} ${label}`, changes,
      needReply: uniq([area || pr.area].filter(Boolean))
    }]);
    UI.pAddOptOpen = false;
    store.update({ [`proposals/${propId}/options`]: nextOpts });
    toast(`已新增做法「${prefix}」並納入試算`);
  }
  function adoptProposalOption(propId, optId) {
    if (!need(isAdmin(), '決議套用到總表需由總召或調度台執行（區長請先在右側表態）')) return;
    if (isPublished()) return toast('總表已定版，不能再採用提案；請先由總召取消定版');
    const pr = propById(propId); if (!pr) return;
    if (pr.status === 'resolved') return toast('這個提案已經決議過了');
    const opt = (Array.isArray(pr.options) ? pr.options : Object.values(pr.options || {})).find((o) => o && o.id === optId); if (!opt) return;
    // 高風險動作：先列出實際會改的內容（R-04、X-01）
    const chLines = Object.keys(opt.changes || {}).map((sid) => { const s0 = M.byId[sid]; return `・${s0 ? slotName(s0) : sid}：${Object.entries(opt.changes[sid] || {}).map(([k, v]) => k + '=' + JSON.stringify(v)).join('、')}`; });
    const exLines = Object.keys(opt.extraSlots || {}).map((eid) => { const x = opt.extraSlots[eid] || {}; return `・新增勤務 ${eid}：${x.d || ''} ${x.area || ''} ${x.cat || ''}`; });
    const okVal = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    const badKey = Object.keys(opt.changes || {}).some((sid) => !RE_SID.test(sid) || !opt.changes[sid] || typeof opt.changes[sid] !== 'object' || Object.keys(opt.changes[sid]).some((f) => !EDIT_FIELDS.includes(f) || !okVal(opt.changes[sid][f])))
      || Object.keys(opt.extraSlots || {}).some((eid) => !RE_EXID.test(eid));
    if (badKey) return toast('這個做法含有格式不正確的勤務格，無法套用');
    if (!confirm(`採用「${opt.label}」並套用到總表？\n${chLines.concat(exLines).slice(0, 30).join('\n') || '（不改動任何勤務格）'}${chLines.length + exLines.length > 30 ? '\n…共 ' + (chLines.length + exLines.length) + ' 項' : ''}`)) return;
    // #1／#9：逐欄寫入，並記下「動了哪些欄位（appliedEdits）」與「這些欄位原本的值（prevEdits，原本沒有的就不存）」；
    // 還原時只處理 appliedEdits 內的欄位，且現值仍等於決議值才還原。RTDB 不存 null，所以不用 null 當記號。
    const up = {}, prevEdits = {}, prevExtra = {}, appliedEdits = {}, appliedExtra = {};
    for (const sid in opt.changes || {}) {
      const cur = (D().edits || {})[sid] || {};
      for (const f in opt.changes[sid]) {
        up[`edits/${sid}/${f}`] = opt.changes[sid][f];
        if (cur[f] !== undefined && cur[f] !== null) (prevEdits[sid] = prevEdits[sid] || {})[f] = cur[f];
      }
      appliedEdits[sid] = Object.assign({}, opt.changes[sid]);
    }
    for (const eid in opt.extraSlots || {}) {
      const cur = (D().extra || {})[eid];
      if (cur) prevExtra[eid] = cur;
      appliedExtra[eid] = Object.assign({}, opt.extraSlots[eid], { id: eid });
      up['extra/' + eid] = appliedExtra[eid];
    }
    const oldVer = draftVer(), newVer = nextDraftVer(oldVer);
    up['meta/version'] = newVer;
    up[`proposals/${propId}/status`] = 'resolved';
    up[`proposals/${propId}/step`] = 6;
    up[`proposals/${propId}/chosen`] = optId;
    up[`proposals/${propId}/resolvedBy`] = me().name;
    up[`proposals/${propId}/resolvedAt`] = Date.now();
    up[`proposals/${propId}/prevVer`] = oldVer;
    up[`proposals/${propId}/resolvedVer`] = newVer;
    up[`proposals/${propId}/prevEdits`] = Object.keys(prevEdits).length ? prevEdits : null;
    up[`proposals/${propId}/prevExtra`] = Object.keys(prevExtra).length ? prevExtra : null;
    up[`proposals/${propId}/appliedEdits`] = Object.keys(appliedEdits).length ? appliedEdits : null;
    up[`proposals/${propId}/appliedExtra`] = Object.keys(appliedExtra).length ? appliedExtra : null;
    const tid = store.pushId();
    up[`proposals/${propId}/talk/${tid}`] = {
      who: '系統', area: '系統', at: Date.now(),
      text: `${me().name} 決議採用「${opt.label}」，已套用至總表並將草案升版為 ${newVer}。`
    };
    store.update(Object.assign(up, logOp(pr.area || '總召', `決議套用提案 ${propId}（${opt.label}），升版為 ${newVer}`)));
    toast(`已套用到總表（${newVer}）`);
  }
  // 還原計畫：只回復該提案動過的欄位；現值仍等於決議值才還原，否則列為衝突（#9）
  function revertPlan(pr) {
    const opts = Array.isArray(pr.options) ? pr.options : Object.values(pr.options || {});
    const opt = opts.find((o) => o && o.id === pr.chosen) || {};
    const appE = pr.appliedEdits || opt.changes || {};   // 舊資料沒有 appliedEdits：由採用的做法推得
    const appX = pr.appliedExtra || Object.fromEntries(Object.entries(opt.extraSlots || {}).map(([k, v]) => [k, Object.assign({}, v, { id: k })]));
    const up = {}, lines = [], conflicts = [];
    for (const sid in appE) {
      if (!RE_SID.test(sid) || !appE[sid] || typeof appE[sid] !== 'object') continue;
      const cur = (D().edits || {})[sid] || {}, prevCell = (pr.prevEdits || {})[sid] || {};
      for (const f in appE[sid]) {
        if (!EDIT_FIELDS.includes(f)) continue;
        if (sameVal(cur[f], appE[sid][f])) { const pv = prevCell[f]; up[`edits/${sid}/${f}`] = pv === undefined ? null : pv; lines.push(`・${sid}.${f}：${pv === undefined ? '移除' : '恢復為 ' + JSON.stringify(pv)}`); }
        else conflicts.push(`${sid}.${f}（現為 ${JSON.stringify(cur[f] === undefined ? null : cur[f])}）`);
      }
    }
    for (const eid in appX) {
      if (!RE_EXID.test(eid)) continue;
      const cur = (D().extra || {})[eid];
      if (sameVal(cur, appX[eid])) { const pv = (pr.prevExtra || {})[eid]; up['extra/' + eid] = pv || null; lines.push(`・新增勤務 ${eid}：${pv ? '恢復' : '移除'}`); }
      else conflicts.push(`新增勤務 ${eid}（已被改過）`);
    }
    return { up, lines, conflicts };
  }
  function revertProposal(propId) {
    if (!need(isAdmin(), '只有總召可還原決議')) return;
    if (isPublished()) return toast('總表已定版，不能還原決議；請先由總召取消定版');
    const pr = propById(propId); if (!pr || pr.status !== 'resolved') return;
    const plan = revertPlan(pr), up = plan.up;
    if (!confirm(`還原提案 ${pr.id} 的決議？\n${plan.lines.slice(0, 20).join('\n') || '（沒有可還原的欄位）'}${plan.conflicts.length ? '\n\n以下欄位在決議後已被改過，會保留不動：\n' + plan.conflicts.slice(0, 10).join('\n') : ''}`)) return;
    // 版號只往前走：若決議之後沒有別的升版，才回到決議前的版號；否則再升一版
    const curVer = draftVer();
    up['meta/version'] = (pr.resolvedVer && pr.prevVer && curVer === pr.resolvedVer) ? pr.prevVer : nextDraftVer(curVer);
    up[`proposals/${propId}/status`] = 'waiting';
    up[`proposals/${propId}/step`] = 3;
    up[`proposals/${propId}/chosen`] = null;
    const tid = store.pushId();
    up[`proposals/${propId}/talk/${tid}`] = { who: '系統', area: '系統', at: Date.now(), text: `${me().name} 還原了決議${plan.conflicts.length ? `（${plan.conflicts.length} 個欄位決議後已被改過，保留不動）` : ''}，版號 ${up['meta/version']}。` };
    store.update(Object.assign(up, logOp(pr.area || '總召', `還原提案 ${propId} 決議前狀態`)));
    toast(plan.conflicts.length ? `已還原，但有 ${plan.conflicts.length} 個欄位已被改過而保留` : '已還原決議前版本');
  }

  /* 在線名單 */
  let presTimer = null, presArea = '';
  function beat(area, where) {
    if (!me()) return;
    if (presArea && presArea !== area) store.set(`presence/${presArea}/${me().uid}`, null);
    presArea = area;
    if (area) store.set(`presence/${area}/${me().uid}`, { name: me().name, at: Date.now(), where: where || '' });
    clearInterval(presTimer);
    if (area) presTimer = setInterval(() => { if (me() && document.visibilityState === 'visible') store.set(`presence/${area}/${me().uid}`, { name: me().name, at: Date.now(), where: where || '' }); }, 45000);
  }
  function present(area, where) {
    const now = Date.now(), P = (D().presence || {})[area] || {};
    return Object.keys(P).filter((u) => now - P[u].at < 120000 && (!where || P[u].where === where)).map((u) => Object.assign({ uid: u }, P[u]));
  }
  const avatars = (list) => list.map((u) => `<span class="av" title="${esc(u.name)}">${esc((u.name || '?').slice(0, 1))}</span>`).join('');

  /* ---------------- 各區統計 ---------------- */
  function areaStats(area) {
    const allIss = [];
    const groups = areaGroups(area).map((gm) => {
      // #12：組別不計每場的 P11（人數不足已有標籤），與依日期列口徑一致
      const n = (E.getState().groups[gm.id] || []).length, gi = groupIssues(gm.id).filter((c) => c.rule !== 'P11'), iss = cnt(gi), clash = gi.filter(isClash).length;
      allIss.push(...gi);
      const pre = pidRecs((D().groups || {})[gm.id]).filter(([, r]) => r.pre).length;
      const lead = groupLead(gm.id);
      const posts = ((D().groupMeta || {})[gm.id] || {}).posts || {};
      const memIds = E.getState().groups[gm.id] || [];
      const postCnt = RITUAL_POSTS.filter((k) => posts[k] && memIds.includes(+posts[k])).length;
      return { gm, n, iss, pre, clash, lead, postCnt, done: n >= (gm.need || 1) && !clash && !pre };
    });
    const dated = areaDated(area).map((s) => {
      const si = slotIssuesOf(s.id).filter((c) => c.rule !== 'P11'), n = M.asg[s.id].p.length, need = E.slotNeed(M, s), iss = cnt(si), clash = si.filter(isClash).length;
      allIss.push(...si);
      const pre = pidRecs((D().assign || {})[s.id]).filter(([, r]) => r.pre).length;
      const props = slotProps[s.id] || [];
      return { s, n, need, iss, pre, clash, props, done: n >= need && !clash && !pre };
    });
    const all = groups.concat(dated);
    const hasEdited = all.some((x) => x.n > 0) || Object.keys((D().members || {})[area] || {}).length > 0;
    const rawStatus = ((D().areas || {})[area] || {}).status;
    // #8：區層級的違規／撞到以 issue key 去重（同一筆碰撞在組別與依日期各出現一次，只算一筆）
    const uk = new Map(); for (const c of allIss) if (!uk.has(c.key)) uk.set(c.key, c);
    const ul = [...uk.values()], uc = cnt(ul);
    return {
      groups, dated,
      gDone: groups.filter((x) => x.done).length, dDone: dated.filter((x) => x.done).length,
      short: dated.filter((x) => x.n < x.need).length + groups.filter((x) => x.n < (x.gm.need || 1)).length,
      v: uc.v, n: uc.n,
      pre: all.reduce((a, x) => a + x.pre, 0), clash: ul.filter(isClash).length,
      status: rawStatus || (hasEdited ? 'editing' : 'not_started'),
      after: afterCount(area)
    };
  }
  const ST_LABEL = { not_started: ['no', '還沒開始'], editing: ['wn', '區內排人中'], submitted: ['pl', '已送出'], confirmed: ['ok', '已確認'] };

  /* ---------------- 畫面：共用頂部與導覽 ---------------- */
  function largeModeBtn() {
    const on = typeof document !== 'undefined' && document.documentElement && document.documentElement.classList.contains('large-mode');
    return `<button type="button" class="btn sm large-btn${on ? ' on' : ''}" data-act="toggle-large" aria-pressed="${on ? 'true' : 'false'}" title="切換大字版">${on ? '大字版 ✓' : '大字版'}</button>`;
  }
  function accountBtn() {
    const u = me(), bp = myBoundPerson();
    const label = u ? (boundOk(bp) ? `${u.name}（${bp.p.n}）` : u.name || '我') : '';
    const sync = (store.mode === 'local' ? '本機試用' : !store.online ? `離線${store.pending ? ' · ' + store.pending + ' 筆待同步' : ''}` : store.pending ? `同步中 ${store.pending}` : '已同步')
      + (store.foreignPending ? ` · 另有 ${store.foreignPending} 筆其他帳號未送出` : '');
    return `<div class="top-r"><span class="sync ${store.online ? '' : 'off'}">${esc(sync)}</span>
      ${largeModeBtn()}
      ${u ? `<button class="btn sm" data-act="open-acct">${esc(label)}</button>` : `<a class="btn sm pri" href="#/login">登入 / 綁定</a>`}</div>`;
  }
  function topbar(title, sub, back, backLabel) {
    return `<header class="top">
      ${back ? `<a class="back" href="${esc(back)}">${esc(backLabel || '← 返回')}</a>` : `<a class="back" href="#/">天達排班協作</a>`}
      ${accountBtn()}
      <div class="ttl"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    </header>`;
  }
  function wsHeader(wsKey, subKey, area) {
    const a = area || defaultArea();
    const isA = wsKey === 'A' || wsKey === 'home';
    const isBP = wsKey === 'B' || wsKey === 'P';
    const isAreaGroup = isBP || wsKey === 'area';
    const isOv = wsKey === 'overview' || wsKey === '00';
    const navItem = (active, href, txt) => `<a href="${href}" class="${active ? 'on' : ''}">${txt}</a>`;
    let subs = '';
    if (isA) {
      subs = [
        navItem(subKey === 'a1', '#/a1', '建置與初版'),
        navItem(subKey === 'a2', '#/a2', '年度總表'),
        navItem(subKey === 'a3', '#/a3', '人員狀態'),
        navItem(subKey === 'a4', '#/a4', '規則與試算'),
        navItem(subKey === 'review', '#/review', '各區進度與協調'),
        navItem(subKey === 'a5', '#/a5', '定版與匯出')
      ].join('');
    } else if (isAreaGroup) {
      subs = [
        navItem(subKey === 'b1', `#/b1/${a}`, '本區首頁'),
        navItem(subKey === 'b3' || subKey === 'a', `#/a/${a}`, '本區排人'),
        navItem(subKey === 't' || subKey === 'b5', `#/t/${a}`, '分工與送出'),
        navItem(subKey === 'b2' || subKey === 'p', '#/p', '提案與試算')
      ].join('');
    } else {
      subs = [
        navItem(isOv || subKey === 'overview', '#/overview', '系統總覽'),
        navItem(false, '#/a1', '建置與初版'),
        navItem(false, '#/a2', '年度總表'),
        navItem(false, `#/b1/${a}`, '本區首頁'),
        navItem(false, `#/a/${a}`, '各區排人'),
        navItem(wsKey === 'login' || subKey === 'login', '#/login', '帳號與綁定')
      ].join('');
    }
    const pub = !!(D().meta && D().meta.published);
    const verTxt = pub || String(draftVer()).includes('定版') ? esc(draftVer()) : `草案 ${esc(draftVer())}`;
    return `<header class="ws-header no-print">
      <div class="ws-top">
        <a class="ws-brand" href="#/">
          <div class="ws-logo" aria-hidden="true">達</div>
          <div><div class="ws-title">天達堂排班系統</div><div class="ws-sub">116 年度 · ${verTxt}</div></div>
        </a>
        <nav class="ws-nav" aria-label="工作台">
          ${navItem(isOv, '#/overview', '總覽')}
          ${navItem(wsKey === 'A', '#/a1', '年度控制台')}
          ${navItem(isBP, `#/b1/${a}`, '各區討論')}
          ${navItem(wsKey === 'area', `#/a/${a}`, '各區排人')}
          ${navItem(wsKey === 'home', '#/', '工作區首頁')}
        </nav>
        ${accountBtn()}
      </div>
      <div class="sub-nav">${subs}</div>
    </header>`;
  }
  function currentAreaForNav(r) {
    if (r && (r.v === 'a' || r.v === 't' || r.v === 'b1') && WORK_AREAS.includes(r.pathArg)) return r.pathArg;
    if (r && r.v === 'g' && gmOf(r.pathArg)) return gmOf(r.pathArg).area;
    if (r && r.v === 's' && M && M.byId[r.pathArg]) return M.byId[r.pathArg].area;
    return defaultArea();
  }
  function globalBottomNav(r) {
    const a = currentAreaForNav(r);
    const it = (href, active, t) => `<a href="${href}" class="${active ? 'on' : ''}">${t}</a>`;
    const isHome = !r || !r.v || r.v === 'login' || r.v === 'bind';
    const isArea = r && (r.v === 'a' || r.v === 'g' || r.v === 's');
    const isTeam = r && r.v === 't';
    const isProp = r && (r.v === 'b1' || r.v === 'p');
    const isCtrl = r && ['overview', 'a1', 'a2', 'a3', 'a4', 'a5', 'review'].includes(r.v);
    return `<nav class="bnav no-print" aria-label="行動版快捷導覽">
      ${it('#/', isHome, '首頁')}
      ${it('#/a/' + a, isArea, '排人')}
      ${it('#/t/' + a, isTeam, '分工')}
      ${it('#/b1/' + a, isProp, '提案')}
      ${it('#/a1', isCtrl, '控制台')}
    </nav>`;
  }
  function issueLines(list, max) {
    const active = list.filter((c) => !c.accepted), acc = list.filter((c) => c.accepted);
    const L = active.slice(0, max || 3);
    let h = L.map((c) => `<div class="iss ${c.lvl === '違規' ? 'bad' : 'warn'}">${esc(c.msg)}</div>`).join('');
    if (active.length > L.length) h += `<div class="muted small">還有 ${active.length - L.length} 則</div>`;
    if (acc.length) h += `<div class="muted small">另有 ${acc.length} 則已標為「接受例外」</div>`;
    return h;
  }

  /* ---------------- 畫面：首頁、M8 登入與姓名綁定 ---------------- */
  function vHome() {
    const mine = myAreas(), seeded = !!(D().meta || {}).seeded, bp = myBoundPerson();
    const curArea = defaultArea();
    let notices = '';
    if (!seeded) {
      notices += `<section class="card warnbox"><b>這個年度還沒有初始資料。</b><div class="muted">初始化會把 115 年的組別名單與初始調整提案帶進來當起點，各區再調整。</div>
        ${store.mode === 'local' || isAdmin() ? `<button class="btn pri" data-act="seed">初始化 116 年資料</button>` : `<div class="muted">請總召或調度台登入後初始化。</div>`}</section>`;
    }
    if (me()) {
      const bindLine = bp && bp.p && bp.status === 'rejected'
        ? `綁定「${esc(bp.p.n)}」的申請${tag('bad', '已被退回')}<span class="muted small">請重新綁定或洽區長</span>`
        : bp && bp.p
        ? `已綁定：<b>${esc(bp.p.n)}</b>（${esc(bp.p.a)}）${bp.status === 'pending' ? tag('wn', '待區長確認') : tag('ok', '已生效')}`
        : `尚未綁定名冊姓名 ${tag('wn', '點此綁定')}`;
      notices += `<section class="card"><div class="row-h"><span>${bindLine}</span>
        <div class="acts">${boundOk(bp) || (bp && bp.p && bp.status === 'pending') ? `<button class="btn sm pri-out" data-act="person" data-pid="${+bp.p.id}">看我的班表</button>` : ''}<button class="btn sm" data-act="open-acct">帳號與綁定 (M8)</button></div></div>
        ${!mine.length && !isAdmin() ? `<div class="muted small">您還不是任何一區的排班人員：可先瀏覽，或到自己的區按「申請成為排班人員」。</div>` : ''}</section>`;
    } else {
      notices += `<section class="card"><div class="row-h"><div><b>尚未登入</b><div class="muted small">登入並綁定姓名後可排本區名單、提案表態、代管家人。</div></div>
        <a class="btn sm pri" href="#/login">登入 / 綁定 (M8)</a></div></section>`;
    }

    const areaCards = WORK_AREAS.map((a) => {
      const s = seeded ? areaStats(a) : null, m = mine.includes(a);
      const tot = s ? s.groups.length + s.dated.length : 0;
      if (s && !tot) return '';
      const [cls, lab] = ST_LABEL[s ? s.status : 'editing'];
      return `<div class="row"><div class="row-h"><div class="row-t"><a href="#/a/${a}" style="text-decoration:none"><b class="c-${a}">${a}</b></a>${m ? tag('ok', '我負責') : ''}${s ? tag(cls, lab) : ''}</div>
        <div class="acts"><a class="btn sm" href="#/b1/${a}">首頁</a><a class="btn sm pri" href="#/a/${a}">排人</a></div></div>
        ${s ? `<div class="muted small">組別 ${s.gDone}／${s.groups.length} · 依日期 ${s.dDone}／${s.dated.length}${s.clash ? ` · <span class="t-bad">撞到 ${s.clash}</span>` : ''}${s.pre ? ` · 預排待確認 ${s.pre}` : ''}</div>` : ''}</div>`;
    }).join('');

    const sideHub = `<aside class="split-side">
      <section class="home-hub">
        <div class="sec-h"><h2>三個工作台與階段入口</h2><a class="link small" href="#/overview">系統總覽 (00) →</a></div>
        <div class="hub-card hub-a">
          <div class="hub-k">工作台 A · 總召、人資處</div>
          <div class="hub-t">年度排班控制台</div>
          <div class="muted small">產生初版、年度總表、人員狀態、規則試算、跨區協調與印刷定版。</div>
          <div class="acts">
            <a class="btn sm pri" href="#/a1">建置初版 A1</a>
            <a class="btn sm" href="#/a2">年度總表 A2</a>
            <a class="btn sm" href="#/a3">人員狀態 A3</a>
            <a class="btn sm" href="#/a4">規則試算 A4</a>
            <a class="btn sm" href="#/review">進度協調 A6</a>
            <a class="btn sm" href="#/a5">定版匯出 A5</a>
          </div>
        </div>
        <div class="hub-card hub-b">
          <div class="hub-k">工作台 B · 區長、主廚、小組長</div>
          <div class="hub-t">各區討論與區內排人</div>
          <div class="muted small">查看本區任務與負擔比較、提出換日／換區／支援提案並即時試算影響。</div>
          <div class="acts">
            <a class="btn sm blue" href="#/b1/${curArea}">${esc(curArea)} 區長首頁 (B1)</a>
            <a class="btn sm blue-out" href="#/p">提案與影響試算 (B2)</a>
            <a class="btn sm" href="#/a/${curArea}">區內排人 (B3)</a>
          </div>
        </div>
        <a class="btn wide" href="#/overview">查看 00 系統總覽、年度 7 階段流程與 18 情境對照</a>
      </section>
    </aside>`;

    return `${wsHeader('home', '', curArea)}<main class="wide-main">
      <div class="page-head">
        <div>
          <h1>116 年排班工作區（${esc(draftVer())}）</h1>
          <p class="muted" style="margin:4px 0 0">${store.mode === 'local' ? '本機試用模式 · 測試期間姓名綁定立即生效' : '一份資料，三個工作台；人由各區排，總召檢查衝突與定版'}</p>
        </div>
        <div class="acts">
          <a class="btn pri" href="#/overview">系統總覽 (00)</a>
          <a class="btn blue-out" href="#/b1/${curArea}">${esc(curArea)} 區長首頁</a>
        </div>
      </div>
      <div class="split-grid">
        <div class="split-main">
          ${notices}
          <div class="sec-h"><h2>各區排人進度（B3／B1）</h2><span class="muted small">${seeded ? '點區域進入排人，或開區長首頁' : '尚未初始化'}</span></div>
          <section class="area-cards-grid">${areaCards}</section>
        </div>
        ${sideHub}
      </div>
    </main>`;
  }

  let isComposing = false, pendingRender = false, finderCtx = null, apptArea = '';

  function renderBindHits() {
    const q = UI.bindQ;
    const hits = q.length >= 1 ? M.people.filter((p) => p.n.includes(q)).slice(0, 8) : [];
    return hits.map((p) => {
      const gs = (M.personGroups[p.id] || []).map((g) => gmOf(g).name).join('、');
      return `<div class="bind-hit"><div><b>${esc(p.n)}　${esc(p.a)}</b><div class="muted small">${esc(roleOf(p) || '道親')}${gs ? ' · ' + esc(gs) : ''}</div></div>
        <button class="btn sm pri" data-act="bind-me" data-pid="${+p.id}">這是我</button></div>`;
    }).join('') || (q ? '<div class="muted small">名冊找不到這個名字？可於下方申請加入名冊。</div>' : '');
  }
  function renderFamHits() {
    const bp = myBoundPerson(), u = myUserRec() || {};
    const famHits = UI.famQ.length >= 1 ? M.people.filter((p) => p.n.includes(UI.famQ) && (!bp || !bp.p || p.id !== bp.p.id) && !(u.family || {})[p.id]).slice(0, 5) : [];
    return famHits.map((p) => `<div class="bind-hit"><div><b>${esc(p.n)}</b> <span class="muted small">${esc(p.a)}</span></div><button class="btn sm" data-act="add-fam" data-pid="${p.id}">代管</button></div>`).join('');
  }

  function bindSectionHtml() {
    const bp = myBoundPerson();
    const u = myUserRec() || {};
    const fam = Object.values(u.family || {});
    const isAuto = autoApproveBind();
    return `<section class="card">
      <div class="row-h"><h2>第一次登入：找到自己的名字 (M8)</h2>${tag(isAuto ? 'ok' : 'wn', isAuto ? '測試期：立即生效' : '正式期：需區長確認')}</div>
      ${bp && bp.p ? `<div class="bind-hit on"><div><b>${esc(bp.p.n)}　${esc(bp.p.a)}</b><div class="muted small">${esc(roleOf(bp.p) || '道親')} · ${esc((M.personGroups[bp.p.id] || []).map((g) => gmOf(g).name).join('、') || '尚未入組')}</div></div>
        ${bp.status === 'ok' ? tag('ok', '已綁定') : bp.status === 'rejected' ? tag('bad', '已被退回，請重新綁定') : tag('wn', '待區長確認')}</div>` : ''}
      <label>搜尋姓名<input id="bindQ" type="search" value="${esc(UI.bindQ)}" data-input="bindQ" placeholder="輸入名字（例如：許明德）"></label>
      <div id="bindHits" class="list">${renderBindHits()}</div>
      <div class="muted small">送出後${isAuto ? '（測試期間立即生效，完工後恢復由小組長或區長確認）' : '由您的小組長或區長確認，確認前可先瀏覽班表'}。
        ${isAdmin() ? `<button class="link" data-act="toggle-auto-bind">${isAuto ? '總召：改為正式審核' : '總召：改為測試期立即生效'}</button>` : ''}</div>
      <details><summary>名冊上找不到名字？申請加入名冊</summary>
        <div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
          <div class="grid2">
            <label>姓名<input id="newPerName" type="text" placeholder="請輸入姓名"></label>
            <label>所屬區<select id="newPerArea">${E.PERSON_AREAS.map((a) => `<option>${esc(a)}</option>`).join('')}</select></label>
          </div>
          <div class="grid2">
            <label>乾／坤<select id="newPerSx"><option value="">未指定</option><option>乾</option><option>坤</option></select></label>
            <label>備註<input id="newPerNote" type="text" placeholder="例：新加入服務"></label>
          </div>
          <button class="btn pri" data-act="apply-new-person">送出加入名冊並綁定</button>
        </div>
      </details>
    </section>
    <section class="card">
      <h2>代管家人（沒有手機的家人）</h2>
      <div class="muted small">加入後可替家人看全年班表、回覆出席或請假。</div>
      ${fam.map((f) => `<div class="bind-hit"><div><b>${esc(f.n)}</b> <span class="muted small">${esc(f.a)}</span></div>
        <div class="acts"><button class="btn sm" data-act="person" data-pid="${+f.pid || ''}">看班表</button><button class="btn sm" data-act="rm-fam" data-pid="${+f.pid || ''}">移除</button></div></div>`).join('') || '<div class="muted small">尚未加入代管家人</div>'}
      <label>搜尋家人姓名<input id="famQ" type="search" value="${esc(UI.famQ)}" data-input="famQ" placeholder="輸入家人名字"></label>
      <div id="famHits">${renderFamHits()}</div>
    </section>`;
  }

  function vLogin() {
    let mainHtml = '';
    if (me()) {
      mainHtml += bindSectionHtml();
      mainHtml += `<button class="btn wide" data-act="signout">登出目前帳號（${esc(me().name)}）</button>`;
    } else if (store.mode === 'local') {
      const sampleP = M.people.find((p) => p.a === '瑞芳' && p.n) || M.people[0];
      const opt = (who, t, d) => `<button class="row" data-act="local-in" data-who='${esc(JSON.stringify(who))}'><b>${esc(t)}</b><div class="muted small">${esc(d)}</div></button>`;
      mainHtml += `<section class="card"><b>本機試用模式</b><div class="muted">選一個身分試用，資料只存在這台裝置；開兩個分頁選不同身分，可模擬多人同時排。</div></section>
        <section class="list">${opt({ uid: 'local-admin', name: '總召（試用）', admin: true }, '總召、調度台', '看各區進度、協調、預排、決議套用提案、指定排班人員')}
        ${AREAS.map((a) => opt({ uid: 'local-lead-' + a, name: a + '區長（試用）', leadOf: a }, a + ' 區長', '區長首頁、排本區的人、提案表態、指定排班人員、確認預排、送出')).join('')}
        ${sampleP ? opt({ uid: 'local-bound-' + sampleP.id, name: sampleP.n, pid: sampleP.id, area: sampleP.a }, `已綁定道親：${sampleP.n}（${sampleP.a}）`, '直接體驗 M8 已綁定名冊姓名狀態') : ''}
        ${opt({ uid: 'local-u1', name: '道親甲（試用）' }, '一般道親（未綁定）', '登入後搜尋名冊姓名綁定「這是我」或申請成為排班人員')}</section>`;
    } else {
      mainHtml += `<section class="card"><button class="btn pri big" data-act="in" data-kind="google">使用 Google 帳號登入</button>
        ${CFG.lineChannelId && CFG.lineWorkerUrl ? `<button class="btn big" data-act="in" data-kind="line">使用 LINE 登入</button>` : `<div class="muted small">LINE 登入尚未設定。</div>`}</section>`;
    }
    const sideHtml = `<aside class="split-side">
      <section class="card login-cmp">
        <div><div class="small muted"><b>不用登入</b></div><ul><li>本週與全年場次</li><li>各場名單、車次</li><li>組別、依姓名查詢</li><li>公告、服務指南</li></ul></div>
        <div><div class="small t-ok"><b>登入之後</b></div><ul><li>排本區名單、提案</li><li>回覆會到、請假</li><li>代管家人</li><li>帶隊點名與回饋</li></ul></div>
      </section>
      <section class="card"><h2>姓名綁定與代管說明</h2>
        <div class="kv-row"><b>找自己</b><span class="muted">搜尋名冊姓名點「這是我」，確認身分後即可檢視全年班表。</span></div>
        <div class="kv-row"><b>申請入冊</b><span class="muted">名冊尚未建立者可填寫姓名與所屬區申請加入。</span></div>
        <div class="kv-row"><b>代管家人</b><span class="muted">替沒有智慧型手機的長輩或家人加入代管，一同查詢與代回。</span></div>
      </section>
    </aside>`;
    return `${wsHeader('login', 'login', defaultArea())}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small"><a href="#/">工作區首頁</a> ／ 帳號與姓名綁定 (M8)</div>
          <h1>${me() ? '帳號與姓名綁定' : '登入系統'}</h1>
        </div>
        <div class="acts"><a class="btn" href="#/">← 回工作區首頁</a></div>
      </div>
      <div class="split-grid">
        <div class="split-main">${mainHtml}${store.error ? `<div class="iss bad">${esc(store.error)}</div>` : ''}</div>
        ${sideHtml}
      </div>
    </main>`;
  }

  function accountSheet() {
    if (!me()) return '';
    const isLg = typeof document !== 'undefined' && document.documentElement && document.documentElement.classList.contains('large-mode');
    return `<div class="sheet-bg" data-act="close-acct"></div><aside class="sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label="帳號與姓名綁定">
      <div class="mem-h"><h2>${esc(me().name || '我')}</h2><span class="muted small">${esc(me().provider || '')}${isAdmin() ? ' · 總召/調度台' : ''}</span>
        <button class="btn sm" data-act="close-acct">關閉</button></div>
      <div class="bind-hit">
        <div><b>字級與閱讀模式</b><div class="muted small">${isLg ? '目前已開啟大字版，介面文字與按鈕已放大' : '目前為標準字級，可切換大字版方便閱讀'}</div></div>
        <button type="button" class="btn sm ${isLg ? 'pri' : 'pri-out'}" data-act="toggle-large">${isLg ? '切回標準字' : '開啟大字版'}</button>
      </div>
      ${bindSectionHtml()}
      <button class="btn wide bad-out" data-act="signout">登出</button>
    </aside>`;
  }

  /* ---------------- 畫面：B3 本區要排的人 ---------------- */
  function reminders(area, S) {
    const out = [];
    const preRows = [];
    for (const g of S.groups) for (const [pid, rec] of pidRecs((D().groups || {})[g.gm.id])) if (rec.pre) preRows.push({ href: '#/g/' + g.gm.id, t: `${g.gm.name}：${(M.pById[+pid] || {}).n || pid}`, r: rec });
    for (const x of S.dated) for (const [pid, rec] of pidRecs((D().assign || {})[x.s.id])) if (rec.pre) preRows.push({ href: '#/s/' + x.s.id, t: `${slotName(x.s)}：${(M.pById[+pid] || {}).n || pid}`, r: rec });
    if (preRows.length) out.push(`<div class="rem"><b>預排待區長確認 ${preRows.length} 筆</b>${preRows.slice(0, 4).map((r) => `<a href="${r.href}">${esc(r.t)}<span class="muted small">（${esc(r.r.n || '')} 預排）</span></a>`).join('')}</div>`);
    const pend = Object.entries((D().members || {})[area] || {}).filter(([, m]) => m.status === 'pending');
    const bindPend = Object.entries(D().users || {}).filter(([, u]) => u.bindStatus === 'pending' && u.bindArea === area);
    if ((pend.length || bindPend.length) && (isLead(area) || isAdmin())) {
      out.push(`<div class="rem"><b>待同意申請（排班 ${pend.length}、綁定 ${bindPend.length}）</b><a href="#/t/${area}">前往分工與送出處理 →</a></div>`);
    }
    const bad = [];
    for (const g of S.groups) for (const c of groupIssues(g.gm.id)) if (isClash(c)) bad.push({ href: '#/g/' + g.gm.id, c });
    for (const x of S.dated) for (const c of slotIssuesOf(x.s.id)) if (isClash(c)) bad.push({ href: '#/s/' + x.s.id, c });
    const seen = new Set(), ub = bad.filter((b) => !seen.has(b.c.key) && seen.add(b.c.key));
    if (ub.length) out.push(`<div class="rem"><b>和別的排班撞到 ${ub.length} 筆</b>${ub.slice(0, 4).map((b) => `<a href="${b.href}">${esc(b.c.msg)}</a>`).join('')}${ub.length > 4 ? `<span class="muted small">還有 ${ub.length - 4} 筆，請看各組</span>` : ''}</div>`);
    return out.length ? `<section class="card rembox"><h2>提醒事項</h2>${out.join('')}</section>` : '';
  }

  const B3_DOT_LEGEND = [
    ['b3-dot-k', '廚務'],
    ['b3-dot-srv', '服務／環境'],
    ['b3-dot-lj', '禮節'],
    ['b3-dot-jzwd', '忠恕平日'],
    ['b3-dot-jzhol', '忠恕假日'],
    ['b3-dot-wash', '洗碗'],
    ['b3-dot-other', '其它勤務']
  ];
  const B3_JZ_ORDER = { '忠恕平日': 1, '忠恕週六': 2, '忠恕週日': 3 };

  function b3DotCls(s) {
    if (s.cat === '廚務' || s.cat === '會館輪廚') return 'b3-dot-k';
    if (s.cat === '環境整理' || s.cat === '服務') return 'b3-dot-srv';
    if (s.cat === '禮節') return 'b3-dot-lj';
    if (s.cat === '忠恕平日') return 'b3-dot-jzwd';
    if (s.cat === '忠恕週六' || s.cat === '忠恕週日') return 'b3-dot-jzhol';
    if (s.cat === '洗碗') return 'b3-dot-wash';
    return 'b3-dot-other';
  }
  function rocYmLabel(ym) {
    return (+ym.slice(0, 4) - 1911) + ' 年 ' + (+ym.slice(5, 7)) + ' 月';
  }
  function sundayOfDateStr(dStr) {
    const y = +dStr.slice(0, 4), m = +dStr.slice(5, 7), d = +dStr.slice(8, 10);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const sun = new Date(dt.getTime() - dt.getUTCDay() * 86400000);
    return `${sun.getUTCFullYear()}-${String(sun.getUTCMonth() + 1).padStart(2, '0')}-${String(sun.getUTCDate()).padStart(2, '0')}`;
  }

  function b3Calendar(area, S, keep) {
    const calSlots = [];
    for (const g of S.groups) if (keep(g, kindOfGroup(g.gm.id))) calSlots.push(...groupSlots(g.gm.id));
    for (const x of S.dated) if (keep(x, 'jz')) calSlots.push(x.s);

    const presentCls = new Set(calSlots.map(b3DotCls));
    const legendHtml = B3_DOT_LEGEND.filter(([cls]) => presentCls.has(cls))
      .map(([cls, lab]) => `<span class="b3-legend-item"><span class="b3-dot ${cls}"></span>${esc(lab)}</span>`).join('');

    const yms = [...new Set(calSlots.map((s) => s.d.slice(0, 7)))].sort();
    const curYm = (UI.b3CalYm === 'all' || yms.includes(UI.b3CalYm)) ? UI.b3CalYm : (yms[0] || '');
    const monthBtns = yms.map((ym) => `<button type="button" class="chip sm ${curYm === ym ? 'on' : ''}" data-act="b3-cal-ym" data-v="${ym}">${(+ym.slice(0, 4) - 1911)}/${+ym.slice(5, 7)}</button>`).join('')
      + (yms.length ? `<button type="button" class="chip sm ${curYm === 'all' ? 'on' : ''}" data-act="b3-cal-ym" data-v="all">全部月份</button>` : '');

    const prioSlot = (s) => s.groupKey ? 0 : (s.cat.startsWith('忠恕') ? 1 : 2);
    const calCellHtml = (num, slots, withWd) => {
      const dots = slots.map((s) => {
        const dtLab = `${E.fmtD(s.d)}${withWd ? `（${E.WD[s.wd]}）` : ''}`;
        const tip = `${dtLab} ${s.cat}${s.groupKey && gmOf(s.groupKey) ? ' · ' + gmOf(s.groupKey).name : ''}`;
        return `<button type="button" class="b3-dot ${b3DotCls(s)}" data-act="b3-cal-dot" data-sid="${esc(s.id)}" data-gk="${esc(s.groupKey || '')}" title="${esc(tip)}" aria-label="${esc(dtLab + ' ' + s.cat)}"></button>`;
      }).join('');
      const dayAttr = slots.length ? ` data-act="b3-cal-dot" data-sid="${esc(slots[0].id)}" data-gk="${esc(slots[0].groupKey || '')}"` : '';
      return `<div class="b3-cal-day${slots.length ? ' has-work' : ''}"${dayAttr}><span class="b3-day-num">${num}</span><div class="b3-dots">${dots}</div></div>`;
    };

    let gridsHtml = '';
    if (curYm === 'all') {
      const bySun = {};
      for (const s of calSlots) {
        const sunStr = sundayOfDateStr(s.d);
        (bySun[sunStr] = bySun[sunStr] || []).push(s);
      }
      for (const d in bySun) bySun[d].sort((a, b) => prioSlot(a) - prioSlot(b) || a.d.localeCompare(b.d) || a.id.localeCompare(b.id));
      const allYms = [...new Set([...yms, ...Object.keys(bySun).map((d) => d.slice(0, 7))])].sort();
      if (allYms.length) {
        const hdAll = ['月份', '1', '2', '3', '4', '5'].map((w) => `<div class="b3-cal-hd">${w}</div>`).join('');
        const rows = allYms.map((ym) => {
          const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
          const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
          const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
          const firstSun = 1 + ((7 - firstWd) % 7);
          const cells = [`<div class="b3-cal-mcell">${y - 1911}/${m}</div>`];
          for (let w = 0; w < 5; w++) {
            const sunDay = firstSun + w * 7;
            if (sunDay > daysInMonth) cells.push('<div class="b3-cal-day empty"></div>');
            else {
              const sunStr = `${ym}-${String(sunDay).padStart(2, '0')}`;
              cells.push(calCellHtml(sunDay, bySun[sunStr] || [], true));
            }
          }
          return cells.join('');
        }).join('');
        gridsHtml = `<div class="b3-cal-all-grid">${hdAll}${rows}</div>`;
      }
    } else if (curYm) {
      const byDate = {};
      for (const s of calSlots) (byDate[s.d] = byDate[s.d] || []).push(s);
      for (const d in byDate) byDate[d].sort((a, b) => prioSlot(a) - prioSlot(b) || a.id.localeCompare(b.id));
      const hdHtml = ['日', '一', '二', '三', '四', '五', '六'].map((w) => `<div class="b3-cal-hd">${w}</div>`).join('');
      const y = +curYm.slice(0, 4), m = +curYm.slice(5, 7);
      const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const cells = [];
      for (let i = 0; i < firstWd; i++) cells.push('<div class="b3-cal-day empty"></div>');
      for (let day = 1; day <= daysInMonth; day++) {
        const dStr = `${curYm}-${String(day).padStart(2, '0')}`;
        cells.push(calCellHtml(day, byDate[dStr] || [], false));
      }
      gridsHtml = `<div class="b3-cal-month-title">${esc(rocYmLabel(curYm))}</div><div class="b3-cal-grid">${hdHtml}${cells.join('')}</div>`;
    }

    return `<section class="card b3-cal-card">
      <div class="sec-h"><h2>排班月曆</h2><span class="muted small">共 ${calSlots.length} 場 · 點圓點定位</span></div>
      ${legendHtml ? `<div class="b3-legend">${legendHtml}</div>` : ''}
      ${monthBtns ? `<div class="b3-cal-months">${monthBtns}</div>` : ''}
      ${gridsHtml || '<div class="empty">沒有符合的排班場次</div>'}
    </section>`;
  }

  function vArea(area) {
    if (!(D().meta || {}).seeded) return vHome();
    const S = areaStats(area), [cls, lab] = ST_LABEL[S.status];
    const here = present(area);
    const keep = (x, kind) => UI.filter === '全部'
      || (UI.filter === '還沒排好' && !x.done)
      || (UI.filter === '我負責的' && isMineItem(area, kind))
      || (UI.filter === '有問題' && (x.iss.v || x.pre || (x.props && x.props.length)));
    const chips = ['全部', '還沒排好', '我負責的', '有問題'].map((t) => `<button class="chip ${UI.filter === t ? 'on' : ''}" data-act="filter" data-v="${t}">${t}</button>`).join('');
    const st = (x, short) => (x.pre ? tag('pre', `預排 ${x.pre}`) : '') + (x.clash ? tag('bad', `撞到 ${x.clash}`) : '') + (short ? tag('bad', short) : '') + (x.done ? tag('ok', '排好') : '') + (x.iss.v - x.clash > 0 ? tag('wn', `違規 ${x.iss.v - x.clash}`) : '') + (x.iss.n ? tag('no', `注意 ${x.iss.n}`) : '');

    const datedRowHtml = (x) => {
      const ed = present(area, 's/' + x.s.id).filter((u) => !me() || u.uid !== me().uid);
      const own = ownerOfSlot(x.s), hasProp = x.props && x.props.length;
      const pTag = hasProp ? tag('bad', '提案中') : '';
      const pNote = hasProp ? `<span class="muted small">${esc(x.props[0].id)} ${esc(x.props[0].title)}</span>` : '';
      const id = 'b3-slot-' + x.s.id;
      return `<a id="${esc(id)}" class="row ${UI.b3FocusId === id ? 'b3-focus-pulse' : ''}" href="#/s/${esc(x.s.id)}"><div class="row-h"><b>${esc(slotName(x.s))}</b><span class="num ${x.n < x.need ? 't-bad' : ''}">${x.n}／${x.need}</span></div>
        <div class="row-t">${tag('no', x.s.cat)}${st(x, x.n < x.need ? (x.n ? `缺 ${x.need - x.n}` : '還沒排') : '')}${pTag}${tag('no', own)}${pNote}${ed.length ? `<span class="muted small">${esc(ed.map((u) => u.name).join('、'))} 正在編輯</span>` : ''}</div></a>`;
    };

    let mainHtml = '';
    if (UI.b3Mode === 'date') {
      const entries = [];
      for (const g of S.groups) {
        if (!keep(g, kindOfGroup(g.gm.id))) continue;
        for (const s of groupSlots(g.gm.id)) entries.push({ d: s.d, s, g, isGroup: true, href: '#/g/' + g.gm.id });
      }
      for (const x of S.dated) {
        if (!keep(x, 'jz')) continue;
        entries.push({ d: x.s.d, s: x.s, x, isGroup: false, href: '#/s/' + x.s.id });
      }
      const prio = (it) => it.isGroup ? 0 : (it.s.cat.startsWith('忠恕') ? 1 : 2);
      entries.sort((a, b) => a.d.localeCompare(b.d) || prio(a) - prio(b) || a.s.id.localeCompare(b.s.id));

      const byYm = new Map();
      for (const it of entries) {
        const ym = it.d.slice(0, 7);
        if (!byYm.has(ym)) byYm.set(ym, []);
        byYm.get(ym).push(it);
      }
      mainHtml = [...byYm.entries()].map(([ym, list]) => {
        const rows = list.map((it) => {
          const s = it.s, id = 'b3-date-' + s.id;
          const got = (M.asg[s.id] && M.asg[s.id].p ? M.asg[s.id].p.length : 0);
          const need = E.slotNeed(M, s);
          const ed = present(area, it.isGroup ? ('g/' + it.g.gm.id) : ('s/' + s.id)).filter((u) => !me() || u.uid !== me().uid);
          const own = it.isGroup ? ownerOfGroup(it.g.gm) : ownerOfSlot(s);
          const props = it.isGroup ? (slotProps[s.id] || []) : (it.x.props || []);
          const hasProp = props.length > 0;
          const pTag = hasProp ? tag('bad', '提案中') : '';
          const pNote = hasProp ? `<span class="muted small">${esc(props[0].id)} ${esc(props[0].title)}</span>` : '';
          const statusTags = st(it.isGroup ? it.g : it.x, got < need ? (got ? `缺 ${need - got}` : '還沒排') : '');
          const dateStr = `${E.fmtD(s.d)}（${E.WD[s.wd]}）${s.e && s.e !== s.d ? '–' + E.fmtD(s.e) : ''}`;
          const actLabel = s.label && s.label !== s.cat ? s.label : s.cat;
          const sub = it.isGroup ? `組別：${it.g.gm.name}` : `依日期排 · ${s.cat}`;
          return `<a id="${esc(id)}" class="row ${UI.b3FocusId === id ? 'b3-focus-pulse' : ''}" href="${esc(it.href)}"><div class="row-h"><b>${esc(dateStr)} · ${esc(actLabel)}</b><span class="num ${got < need ? 't-bad' : ''}">${got}／${need}</span></div>
            <div class="muted small">${esc(sub)}${s.loc ? ` · ${esc(s.loc)}` : ''}</div>
            <div class="row-t">${tag('no', s.cat)}${statusTags}${pTag}${tag('no', own)}${pNote}${ed.length ? `<span class="muted small">${esc(ed.map((u) => u.name).join('、'))} 正在編輯</span>` : ''}</div></a>`;
        }).join('');
        return `<details class="b3-sec" data-sec="${esc('ym-' + ym)}" open><summary class="b3-sec-sum"><span class="b3-sec-title">${esc(rocYmLabel(ym))}</span><span class="num muted">${list.length} 場</span></summary><div class="b3-sec-body"><section class="list">${rows}</section></div></details>`;
      }).join('') || '<div class="empty">沒有符合的勤務</div>';
    } else {
      const gRows = S.groups.filter((g) => keep(g, kindOfGroup(g.gm.id))).map((g) => {
        const slots = groupSlots(g.gm.id), ed = present(area, 'g/' + g.gm.id).filter((u) => !me() || u.uid !== me().uid);
        const own = ownerOfGroup(g.gm);
        const mem = (E.getState().groups[g.gm.id] || []).map((id) => M.pById[id]).filter(Boolean);
        let subDesc = `全年 ${slots.length} 場`;
        if (g.gm.cat === '廚務') {
          const mc = mem.filter((p) => /主廚/.test(p.cr || '')).length, dc = mem.filter((p) => !/主廚/.test(p.cr || '') && /大廚/.test(p.cr || '')).length;
          subDesc = `主廚 ${mc}、大廚 ${dc}、二廚 ${Math.max(0, mem.length - mc - dc)} · 全年 ${slots.length} 場`;
        } else if (g.gm.cat === '禮節') {
          subDesc = `${g.lead ? '組長 ' + g.lead.n + ' · ' : ''}6 崗位已排 ${g.postCnt}／6 · 全年 ${slots.length} 場`;
        } else {
          subDesc = `${g.lead ? '小組長 ' + g.lead.n + ' · ' : ''}全年 ${slots.length} 場${g.gm.need ? ` · 每場需要 ${g.gm.need} 人` : ''}`;
        }
        const id = 'b3-grp-' + g.gm.id;
        return `<a id="${esc(id)}" class="row ${UI.b3FocusId === id ? 'b3-focus-pulse' : ''}" href="#/g/${esc(g.gm.id)}"><div class="row-h"><b>${esc(g.gm.name)}</b><span class="num">${g.gm.cat === '禮節' ? `${g.postCnt}／6 崗位 · ` : ''}${g.n} 人</span></div>
          <div class="muted small">${esc(subDesc)}</div>
          <div class="row-t">${st(g, g.n < (g.gm.need || 1) ? '人數不足' : '')}${tag('no', own)}${ed.length ? `<span class="muted small">${esc(ed.map((u) => u.name).join('、'))} 正在編輯</span>` : ''}</div></a>`;
      }).join('');

      const jzAll = S.dated.filter((x) => x.s.cat.startsWith('忠恕'));
      const jzDone = jzAll.filter((x) => x.done).length;
      const jzRows = jzAll.filter((x) => keep(x, 'jz'))
        .sort((a, b) => (B3_JZ_ORDER[a.s.cat] || 9) - (B3_JZ_ORDER[b.s.cat] || 9) || a.s.d.localeCompare(b.s.d) || a.s.id.localeCompare(b.s.id))
        .map(datedRowHtml).join('');

      const othAll = S.dated.filter((x) => !x.s.cat.startsWith('忠恕'));
      const othDone = othAll.filter((x) => x.done).length;
      const othRows = othAll.filter((x) => keep(x, 'jz'))
        .sort((a, b) => a.s.d.localeCompare(b.s.d) || a.s.id.localeCompare(b.s.id))
        .map(datedRowHtml).join('');

      mainHtml = `<details class="b3-sec" data-sec="groups" open><summary class="b3-sec-sum"><span class="b3-sec-title">1. 有組別（固定組員）</span><span class="num muted">排好 ${S.gDone}／${S.groups.length} 組</span></summary><div class="b3-sec-body"><div class="muted small">改組員，全年每一場自動帶入。不能只改某一天。</div><section class="list">${gRows || '<div class="empty">沒有符合的組別</div>'}</section><div class="muted small">哪一區、哪一天、哪一組由總召排定並鎖住，要換日或換區請用提案。標「預排」的人是總召或調度台先排的，必須由區長確認或重排。</div></div></details>`
        + `<details class="b3-sec" data-sec="jz" open><summary class="b3-sec-sum"><span class="b3-sec-title">2. 忠恕輪值（平日／週六／週日）</span><span class="num muted">排滿 ${jzDone}／${jzAll.length} 格</span></summary><div class="b3-sec-body"><section class="list">${jzRows || '<div class="empty">沒有符合的忠恕輪值</div>'}</section></div></details>`
        + `<details class="b3-sec" data-sec="oth" open><summary class="b3-sec-sum"><span class="b3-sec-title">3. 其它無組別（依日期排）</span><span class="num muted">排滿 ${othDone}／${othAll.length} 格</span></summary><div class="b3-sec-body"><section class="list">${othRows || '<div class="empty">沒有符合的其它勤務</div>'}</section></div></details>`;
    }

    const m = memberOf(area);
    const join = me() && !isAdmin() && AREAS.includes(area) && !m ? `<button class="btn wide" data-act="join" data-area="${area}">申請成為 ${area} 的排班人員</button>` : m && m.status === 'pending' ? `<div class="card muted">已申請成為排班人員，等區長或調度台同意。</div>` : '';
    return `${wsHeader('area', 'b3', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small"><a href="#/">工作區首頁</a> ／ <span class="c-${area}">${esc(area)}</span> · 區內排人 (B3)</div>
          <div class="row-t"><h1>${esc(area)}　本區要排的人</h1>${tag(cls, lab)}${S.after ? tag('pl', `送出後變更 ${S.after}`) : ''}</div>
        </div>
        <div class="acts" style="align-items:flex-end">
          <label style="font-size:12px">切換區<select data-act-change="a-area">${WORK_AREAS.map((a) => `<option ${a === area ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
          <a class="btn blue-out" href="#/b1/${area}">區長首頁 (B1)</a>
          <a class="btn" href="#/t/${area}">分工與送出 (B5)</a>
        </div>
      </div>
      ${here.length ? `<div class="pres">${avatars(here)}<span class="muted small">${here.length} 人正在作業 · 改動即時同步</span></div>` : ''}
      ${join}
      <div class="b3-toolbar"><div class="chips">${chips}</div><div class="seg" role="group" aria-label="檢視模式"><button type="button" class="${UI.b3Mode !== 'date' ? 'on' : ''}" data-act="b3-mode" data-v="group">組別模式</button><button type="button" class="${UI.b3Mode === 'date' ? 'on' : ''}" data-act="b3-mode" data-v="date">日期模式</button></div></div>
      <div class="split-grid">
        <div class="split-main">
          ${mainHtml}
        </div>
        <aside class="split-side b3-side">
          ${reminders(area, S)}
          ${b3Calendar(area, S, keep)}
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- 畫面：B6 組別成員、B4 依日期勤務 ---------------- */
  function otherWork(pid, exceptIds, focusIds) {
    const ex = new Set(exceptIds), L = (M.personSlots[pid] || []).filter((s) => !ex.has(s.id) && (!focusIds || focusIds.includes(s.id)));
    return L.map((s) => {
      const r = s.groupKey ? rec('groups', s.groupKey, pid) : rec('assign', s.id, pid);
      const gm = s.groupKey ? gmOf(s.groupKey) : null;
      return `<div class="other"><b>${esc(dLabel(s))}${esc(s.label || s.cat)}</b><div class="muted small">${esc(s.cat)} · ${esc(gm ? gm.name + '（組員，全年）' : s.area)} · ${esc(s.loc || '')}${r && r.n ? ` · ${esc(r.n)} 排入` : ''}</div></div>`;
    }).join('');
  }
  function roleOf(p) { return [p.cr, p.lead].filter(Boolean).join('、'); }
  function memberRow(p, r, iss, kind, key, area, label, canEdit, ctxIds) {
    const c = cnt(iss);
    const t = r && r.pre ? tag('pre', '預排') : c.v ? tag('bad', '違規') : c.n ? tag('wn', '注意') : '';
    const lead = isLead(area) || (isAdmin() && !AREAS.includes(area));
    const clash = iss.filter(isClash);
    const otherIds = uniq(clash.flatMap((x) => x.slots)).filter((id) => !ctxIds.includes(id));
    return `<div class="mem">
      <div class="mem-h"><button class="link" data-act="person" data-pid="${p.id}">${esc(p.n)}</button><span class="muted small">${esc(p.a)}${p.a !== area && AREAS.includes(area) ? '（非本區）' : ''}${roleOf(p) ? ' · ' + esc(roleOf(p)) : ''}</span>${t}
        ${canEdit ? `<button class="btn sm" data-act="rm" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">移出</button>` : ''}</div>
      ${r && r.n ? `<div class="muted small">${esc(r.n)} ${r.pre ? '預排' : '排入'} · ${ago(r.at)}${r.okBy ? ` · ${esc(r.okBy)} 確認` : ''}</div>` : ''}
      ${issueLines(iss, 2)}
      ${otherIds.length ? `<div class="clash-box"><div><b>和別的名單撞到：</b>${esc(p.n)} 同一天也排在</div>
        ${otherIds.map((oid) => {
          const os = M.byId[oid]; if (!os) return '';
          const ogm = os.groupKey ? gmOf(os.groupKey) : null;
          const or = os.groupKey ? rec('groups', os.groupKey, p.id) : rec('assign', os.id, p.id);
          return `<div class="clash-card"><b>${esc(ogm ? ogm.name : os.area + ' ' + os.cat)}</b><div class="muted small">${esc(dLabel(os))}${esc(os.loc || '')} · ${esc(os.label || os.cat)}${or && or.n ? ` · ${esc(or.n)} 排入` : ''}</div></div>`;
        }).join('')}
        <div class="acts">${canEdit ? `<button class="btn sm bad" data-act="rm" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">從這裡移出</button>` : ''}
        ${me() ? `<button class="btn sm bad-out" data-act="coord" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}" data-msg="${esc(clash[0].msg)}">和幹部商量／請總召協調</button>` : ''}</div></div>` : ''}
      ${r && r.pre ? `<div class="prebox"><span class="small">必須由區長確認或重排</span>${lead ? `<div class="acts"><button class="btn sm pri" data-act="pre-ok" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">確認</button><button class="btn sm" data-act="rm" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">重排（移出）</button></div>` : ''}</div>` : ''}
    </div>`;
  }
  function splitQueryTerms(raw) {
    const seen = new Set(), out = [];
    for (const s of String(raw || '').split(/[\s,，、;；/／|｜・·\n\r\t]+/)) {
      const t = s.trim();
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  }
  const matchNameTerms = (name, terms) => !terms.length || terms.some((t) => String(name || '').includes(t));
  function candList(kind, key, area, label, pool, evalFn, canEdit, plan) {
    const terms = splitQueryTerms(UI.out ? UI.outQ : UI.q);
    const evs = pool.map(evalFn).sort((a, b) => (a.hard.length - b.hard.length) || b.score - a.score);
    const L = (UI.showAll || terms.length > 1) ? evs : evs.slice(0, 12);
    // 多人批次：只加入「與名冊姓名完全相符」的人（部分相符、同名多人、找不到者不加入，列在提示下方）
    const activePlan = (terms.length > 1 && canEdit) ? (plan || (finderCtx ? batchPlan(finderCtx) : null)) : null;
    const evById = activePlan ? new Map(evs.map((ev) => [ev.p.id, ev])) : null;
    const planHard = activePlan ? activePlan.add.filter((p) => { const ev = evById.get(p.id); return ev ? ev.hard.length > 0 : false; }).length : 0;
    const batchBtn = (activePlan && activePlan.add.length)
      ? `<button type="button" class="btn wide pri" style="margin-bottom:8px" data-act="add-batch" data-kind="${kind}" data-key="${key}" data-area="${area}" data-label="${esc(label)}">一次${isPreFor(area) ? '預排' : '加入'}完全相符的 ${activePlan.add.length} 人${planHard ? `（其中 ${planHard} 人有違規）` : ''}</button>`
      : '';
    return batchBtn + (L.map((ev) => {
      const p = ev.p, why = ev.hard[0] || ev.soft[0];
      return `<div class="cand"><div><button class="link" data-act="person" data-pid="${p.id}">${esc(p.n)}</button> <span class="muted small">${esc(p.a)}${roleOf(p) ? ' · ' + esc(roleOf(p)) : ''}${p.src === 'N' ? ' · 還沒服務過' : ''}</span>
        <div class="small ${ev.hard.length ? 't-bad' : ev.soft.length ? 't-warn' : 'muted'}">${why ? esc(why.msg) + (ev.hard.length ? '（排入會標成違規）' : '') : `加入後全年 ${ev.occN} 次`}${ev.lyNote ? ` · <span class="t-ok">${esc(ev.lyNote)}</span>` : ''}${ev.mates && ev.mates.length ? ` · 常和 ${esc(ev.mates.slice(0, 2).join('、'))} 同組` : ''}</div></div>
        ${canEdit ? `<button class="btn sm ${ev.hard.length ? '' : 'pri'}" data-act="add" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">${isAdmin() && !(memberOf(area) && memberOf(area).status === 'ok') && AREAS.includes(area) ? '預排' : '加入'}</button>` : ''}</div>`;
    }).join('') + (evs.length > L.length ? `<button class="btn wide" data-act="more">顯示全部 ${evs.length} 人</button>` : '') || '<div class="empty">沒有符合的人</div>');
  }
  // 批次計畫：每個輸入詞必須與名冊姓名完全相符且唯一才加入
  function batchPlan(ctx) {
    const terms = splitQueryTerms(UI.out ? UI.outQ : UI.q);
    const uni = UI.out ? M.people.filter((p) => p.a === UI.outArea && !p.off) : ctx.localPool;
    const add = [], already = [], rejects = [], seen = new Set();
    const nameList = (L) => L.slice(0, 6).map((p) => p.n).join('、') + (L.length > 6 ? `…等 ${L.length} 人` : '');
    for (const t of terms) {
      const inUni = uni.filter((p) => !p.off && p.n === t);
      if (inUni.length > 1) {
        rejects.push({ term: t, reason: `同名 ${inUni.length} 人（${inUni.map((p) => p.a).join('、')}），無法確定` });
        continue;
      }
      if (inUni.length === 1) {
        const p = inUni[0];
        if (ctx.inIds.has(p.id)) { already.push(t); continue; }
        if (!seen.has(p.id)) { seen.add(p.id); add.push(p); }
        continue;
      }
      const all = M.people.filter((p) => !p.off && p.n === t);
      if (all.length >= 1) {
        if (all.some((p) => ctx.inIds.has(p.id))) { already.push(t); continue; }
        rejects.push({ term: t, reason: `不在${UI.out ? UI.outArea : '本區'}（名冊上是 ${all.map((p) => p.a).join('、')}）` });
        continue;
      }
      const part = uni.filter((p) => p.n.includes(t));
      rejects.push({ term: t, reason: part.length ? `部分相符：${nameList(part)}` : '找不到' });
    }
    return { terms, add, already, rejects };
  }
  function rejectsHtml(plan) {
    if (!plan || !plan.rejects.length) return '';
    return `<div class="muted small"><strong>未加入（需與名冊姓名完全相符）：</strong></div>` + plan.rejects.map((r) => `<div class="small t-warn">「${esc(r.term)}」${esc(r.reason)}</div>`).join('');
  }
  function computeFinderState(ctx) {
    const q = UI.out ? UI.outQ : UI.q;
    const terms = splitQueryTerms(q);
    let pool, hint = '';
    if (UI.out) {
      pool = terms.length >= 1 ? M.people.filter((p) => p.a === UI.outArea && !p.off && !ctx.inIds.has(p.id) && matchNameTerms(p.n, terms)) : [];
      hint = terms.length < 1 ? '請選區域並輸入至少一個字。' : pool.length ? `找到 ${pool.length} 位。排入後對方的區也會看到這一筆。` : '這一區找不到符合的人。';
    } else {
      pool = ctx.localPool.filter((p) => !ctx.inIds.has(p.id) && matchNameTerms(p.n, terms));
    }
    let plan = null;
    if (terms.length > 1) {
      plan = batchPlan(ctx);
      hint = `輸入 ${terms.length} 筆，完全相符可批次加入 ${plan.add.length} 位`
        + (plan.already.length ? `；已在名單：${plan.already.join('、')}` : '')
        + (plan.rejects.length ? `；${plan.rejects.length} 筆未加入（需與名冊姓名完全相符，見下）` : '')
        + (UI.out && plan.add.length ? '。排入後對方的區也會看到這一筆。' : '。');
    }
    return { pool, hint, plan };
  }
  function updateFinderDom() {
    if (!finderCtx) return;
    const candsEl = document.getElementById('cands'), hintEl = document.getElementById('finderHint');
    if (!candsEl) return;
    const { pool, hint, plan } = computeFinderState(finderCtx);
    if (hintEl) hintEl.textContent = hint;
    const rjEl = document.getElementById('finderRejects');
    if (rjEl) rjEl.innerHTML = rejectsHtml(plan);
    candsEl.innerHTML = candList(finderCtx.kind, finderCtx.key, finderCtx.area, finderCtx.label, pool, finderCtx.evalFn, finderCtx.canEdit, plan);
  }
  function finder(area, inIds, kind, key, label, evalFn, canEdit, localPool) {
    const others = AREAS.filter((a) => a !== area);
    if (UI.out && !UI.outArea) UI.outArea = others[0];
    finderCtx = { area, inIds, kind, key, label, evalFn, canEdit, localPool };
    const { pool, hint, plan } = computeFinderState(finderCtx);
    const defArea = UI.out ? UI.outArea : (E.PERSON_AREAS.includes(area) ? area : '瑞芳');
    const qTerms = splitQueryTerms(UI.out ? UI.outQ : UI.q);
    const poolNames = pool.map((p) => p.n);
    const inNames = [...inIds].map((id) => (M.pById[id] || {}).n || '').filter(Boolean);
    const missTerms = qTerms.filter((t) => !poolNames.some((n) => n.includes(t)) && !inNames.some((n) => n.includes(t)));
    const prefillNames = missTerms.join('、');
    const newPerForm = canEdit && UI.newPerOpen ? `<div class="outbox" style="margin-top:8px">
      <div class="row-h"><b>新增名冊人員</b><button type="button" class="btn sm" data-act="toggle-new-per">取消</button></div>
      <label>姓名（可分隔貼上多人）<input id="fNewPerName" type="text" value="${esc(prefillNames)}" placeholder="例如：王小明、李小華"></label>
      <div class="grid2">
        <label>區域<select id="fNewPerArea">${E.PERSON_AREAS.map((a) => `<option value="${esc(a)}" ${a === defArea ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
        <label>性別<select id="fNewPerSx"><option value="">未填</option><option value="乾">乾</option><option value="坤">坤</option></select></label>
      </div>
      <label>備註（選填）<input id="fNewPerNote" type="text" maxlength="60" placeholder="例如：新進志工"></label>
      <div class="act-bar2">
        <button type="button" class="btn pri sm" data-act="create-roster-person" data-join="1" data-kind="${kind}" data-key="${key}" data-area="${area}" data-label="${esc(label)}">新增並${isPreFor(area) ? '預排' : '加入'}</button>
        <button type="button" class="btn sm" data-act="create-roster-person" data-join="0" data-kind="${kind}" data-key="${key}" data-area="${area}" data-label="${esc(label)}">僅新增至名冊</button>
      </div>
    </div>` : '';
    const actBtns = canEdit
      ? `<div class="act-bar2" style="margin-top:6px">
          ${AREAS.includes(area) ? `<button type="button" class="btn" data-act="out" data-v="${UI.out ? '0' : '1'}">${UI.out ? '回本區人員' : '找非本區人員'}</button>` : ''}
          <button type="button" class="btn ${UI.newPerOpen ? 'pri-out' : ''}" data-act="toggle-new-per">${UI.newPerOpen ? '收合新增人員' : '＋ 新增人員'}</button>
        </div>`
      : (AREAS.includes(area) ? `<button class="btn wide" data-act="out" data-v="${UI.out ? '0' : '1'}">${UI.out ? '回本區人員' : '找非本區人員'}</button>` : '');
    const ctl = UI.out
      ? `<div class="outbox"><div class="grid2"><label>區域<select id="outArea" data-act-change="outArea">${others.map((a) => `<option ${a === UI.outArea ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
          <label>姓名（至少一個字）<input id="outQ" type="search" value="${esc(UI.outQ)}" data-input="outQ" placeholder="可用頓號、逗號或空白分隔多人"></label></div>
          ${actBtns}</div>`
      : `<label>找人（${AREAS.includes(area) ? '本區' : '全部'}）<input id="q" type="search" value="${esc(UI.q)}" data-input="q" placeholder="輸入姓名（可用頓號、逗號或空白分隔多人）"></label>
         ${actBtns}`;
    return `<section class="finder"><div class="sec-h"><h2>${UI.out ? '非本區人員 · ' + esc(UI.outArea) : '可以加入的人'}</h2><span class="muted small">${UI.out ? '輸入後才列出' : '依合適程度'}</span></div>
      ${ctl}${newPerForm}<div id="finderHint" class="muted small">${esc(hint)}</div><div id="finderRejects" aria-live="polite">${rejectsHtml(plan)}</div><div id="cands">${candList(kind, key, area, label, pool, evalFn, canEdit, plan)}</div>
      <div class="muted small">規則不允許的人仍可排入，但會標成違規，交給總召確認。</div></section>`;
  }

  function vGroup(gk) {
    const gm = gmOf(gk); if (!gm) return vHome();
    const area = gm.area, kind = kindOfGroup(gk), canEdit = can(area, kind);
    const slots = groupSlots(gk), ids = slots.map((s) => s.id);
    const mem = (E.getState().groups[gk] || []).map((id) => M.pById[id]).filter(Boolean);
    const inIds = new Set(mem.map((p) => p.id));
    const lead = groupLead(gk), leadLabel = gm.cat === '廚務' ? '主廚' : '小組長';
    const rows = mem.map((p) => ({ p, r: rec('groups', gk, p.id), iss: personIssuesIn(p.id, ids) }))
      .sort((a, b) => (b.r && b.r.pre ? 1 : 0) - (a.r && a.r.pre ? 1 : 0) || cnt(b.iss).v - cnt(a.iss).v || cnt(b.iss).n - cnt(a.iss).n);
    const quiet = rows.filter((x) => !cnt(x.iss).v && !cnt(x.iss).n && !(x.r && x.r.pre)), loud = rows.filter((x) => !quiet.includes(x));
    const showQuiet = UI.showAll || quiet.length <= 6;
    const ed = present(area, 'g/' + gk).filter((u) => !me() || u.uid !== me().uid);
    const local = AREAS.includes(area) ? M.people.filter((p) => p.a === area && !p.off) : M.people.filter((p) => AREAS.includes(p.a) && !p.off);
    const need = gm.need || 0;

    // 禮節隊 6 大崗位指派
    let postsHtml = '';
    if (gm.cat === '禮節') {
      const posts = ((D().groupMeta || {})[gk] || {}).posts || {};
      const opts = (sel) => `<option value="">未指派</option>` + mem.map((p) => `<option value="${p.id}" ${+sel === p.id ? 'selected' : ''}>${esc(p.n)}${p.li ? '（' + esc(p.li.slice(0, 12)) + '）' : ''}</option>`).join('');
      postsHtml = `<section class="card"><div class="row-h"><h2>辦道 6 大崗位指派</h2>
        ${canEdit ? `<button class="btn sm" data-act="auto-posts" data-gk="${gk}">依 115 經驗自動配崗</button>` : ''}</div>
        <div class="post-grid">${RITUAL_POSTS.map((post) => `<div class="post-item"><label>${esc(post)}</label>
          <select aria-label="${esc(post)}（${esc(gm.name)}）" ${canEdit ? '' : 'disabled'} data-act-change="set-post" data-gk="${gk}" data-post="${esc(post)}">${opts(posts[post])}</select></div>`).join('')}</div></section>`;
    }

    // 換小組長／移到別組子面板
    let subPanel = '';
    if (canEdit && UI.b6Mode === 'lead') {
      const cands = mem.slice().sort((a, b) => (/組長|主廚/.test((b.lead || '') + (b.cr || '')) - /組長|主廚/.test((a.lead || '') + (a.cr || ''))));
      subPanel = `<section class="card warnbox"><div class="row-h"><h2>選擇${leadLabel}</h2><button class="btn sm" data-act="b6-mode" data-v="">取消</button></div>
        ${cands.length ? `<div class="list">${cands.map((p) => `<button class="row" data-act="set-lead" data-gk="${gk}" data-pid="${p.id}">
          <div class="row-h"><b>${esc(p.n)}</b>${lead && lead.id === p.id ? tag('ok', '目前' + leadLabel) : ''}</div>
          <div class="muted small">${esc(roleOf(p) || '組員')}</div></button>`).join('')}</div>` : '<div class="muted small">請先加入組員</div>'}</section>`;
    } else if (canEdit && UI.b6Mode === 'move') {
      // #25(c)：只列同類別（廚務／服務／禮節）且自己有權限的組
      const targets = BASE.groupsMeta.filter((g) => g.id !== gk && (g.area === area || g.cat === gm.cat) && kindOfGroup(g.id) === kind && can(g.area, kindOfGroup(g.id)));
      subPanel = `<section class="card warnbox"><div class="row-h"><h2>將組員移到別組</h2><button class="btn sm" data-act="b6-mode" data-v="">取消</button></div>
        ${mem.length && targets.length ? `<div class="grid2">
          <label>選擇組員<select id="mvPid">${mem.map((p) => `<option value="${p.id}">${esc(p.n)}</option>`).join('')}</select></label>
          <label>目標組別<select id="mvToGk">${targets.map((g) => `<option value="${g.id}">${esc(g.name)}（${esc(g.cat)}）</option>`).join('')}</select></label>
        </div><button class="btn pri" data-act="move-mem" data-gk="${gk}">確認移轉</button>` : '<div class="muted small">沒有可移轉的組員或目標組別</div>'}</section>`;
    }

    return `${wsHeader('area', 'b3', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small"><a href="#/">工作區首頁</a> ／ <a href="#/a/${area}">${esc(area)} 排人</a> ／ 組別成員 (B6)</div>
          <h1>${esc(gm.name)}</h1>
          <div class="muted small" style="margin-top:4px">${lead ? `${leadLabel} ${esc(lead.n)} · ` : ''}${need ? `每場需要 ${need} 人 · ` : ''}目前 ${mem.length} 人</div>
        </div>
        <div class="acts">
          <a class="btn" href="#/a/${area}">← 回 ${esc(area)} 排人</a>
          <a class="btn blue-out" href="#/b1/${area}">本區首頁 (B1)</a>
        </div>
      </div>
      <div class="split-grid">
        <div class="split-main">
          <section class="card"><div class="small muted"><b>這一組今年負責 ${slots.length} 場</b>（總召排定）</div>
            <div class="dates">${slots.map((s) => `<span>${esc(dLabel(s))}${esc(s.label || s.cat)}</span>`).join('') || '<span>尚未排定場次</span>'}</div>
            <div class="muted small">改組員會套用到這 ${slots.length} 場。某一天有人不能來，是定版後在調度台找代班，不在這裡改。</div></section>
          ${ed.length ? `<div class="edbox">${avatars(ed)}<span>${esc(ed.map((u) => u.name).join('、'))} 也在改這一組，改動會立刻出現。</span></div>` : ''}
          ${!canEdit ? `<div class="card muted">${me() ? '您不是這一區的排班人員，只能瀏覽。' : '登入並成為排班人員後才能調整。'}</div>` : ''}
          ${postsHtml}
          <section class="card members"><h2>組員</h2>
            ${loud.map((x) => memberRow(x.p, x.r, x.iss, 'groups', gk, area, gm.name, canEdit, ids)).join('')}
            ${showQuiet ? quiet.map((x) => memberRow(x.p, x.r, x.iss, 'groups', gk, area, gm.name, canEdit, ids)).join('') : `<button class="btn wide" data-act="more">其餘 ${quiet.length} 人沒有問題，點開看全部</button>`}
            ${!mem.length ? '<div class="empty">還沒有組員</div>' : ''}</section>
          ${subPanel}
          ${canEdit ? `<div class="act-bar3">
            <button class="btn" data-act="last-year" data-gk="${gk}">帶入去年</button>
            <button class="btn" data-act="b6-mode" data-v="lead">換${leadLabel}</button>
            <button class="btn" data-act="b6-mode" data-v="move">移到別組</button>
          </div>` : ''}
          <div class="muted small">檢查是把組員放進這一組全年每一場去算：全年次數、七天內重複、不方便的月份、和其他組或忠恕輪值有沒有同一天。</div>
        </div>
        <aside class="split-side inspector" aria-label="候選人搜尋">
          ${canEdit ? finder(area, inIds, 'groups', gk, gm.name, (p) => evalInGroup(p, gk), canEdit, local) : '<div class="empty">登入並取得本區排班權限後可從此處搜尋加入組員。</div>'}
        </aside>
      </div>
    </main>`;
  }

  function vSlot(sid) {
    const s = M.byId[sid]; if (!s) return vHome();
    if (s.groupKey) { location.replace('#/g/' + s.groupKey); return ''; }
    const area = s.area, canEdit = can(area, 'jz'), label = slotName(s);
    const A = M.asg[sid].p.map((id) => M.pById[id]).filter(Boolean), inIds = new Set(A.map((p) => p.id));
    const need = E.slotNeed(M, s);
    const rows = A.map((p) => ({ p, r: rec('assign', sid, p.id), iss: personIssuesIn(p.id, [sid]) }))
      .sort((a, b) => (b.r && b.r.pre ? 1 : 0) - (a.r && a.r.pre ? 1 : 0) || cnt(b.iss).v - cnt(a.iss).v || cnt(b.iss).n - cnt(a.iss).n);
    const quiet = rows.filter((x) => !cnt(x.iss).v && !cnt(x.iss).n && !(x.r && x.r.pre)), loud = rows.filter((x) => !quiet.includes(x));
    const showQuiet = UI.showAll || quiet.length <= 6;
    const ed = present(area, 's/' + sid).filter((u) => !me() || u.uid !== me().uid);
    const slotOnly = slotIssuesOf(sid).filter((c) => c.pid == null && !c.accepted);
    const local = E.poolFor(M, s, false);
    const preList = rows.filter((x) => x.r && x.r.pre);
    const leadEdit = isLead(area) || (isAdmin() && !AREAS.includes(area));
    const cancelBox = s.cancel ? `<div class="card warnbox"><b>此日不需要（已取消）</b><div class="muted small">這一格已被取消，不列入任何檢查，也不能再排人。${A.length ? `目前還有 ${A.length} 位殘留人員，請移出。` : ''}</div>
      ${A.length && canEdit ? `<button class="btn sm bad-out" data-act="slot-clear-all" data-sid="${esc(sid)}">全部移出</button>` : ''}</div>` : '';

    return `${wsHeader('area', 'b3', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small"><a href="#/">工作區首頁</a> ／ <a href="#/a/${area}">${esc(area)} 排人</a> ／ 依日期勤務 (B4)</div>
          <h1>${esc(label)}</h1>
          <div class="muted small" style="margin-top:4px">${esc(s.loc || '')} · 需要 ${need} 人 · <b class="${A.length < need ? 't-bad' : 't-ok'}">已排 ${A.length}</b></div>
        </div>
        <div class="acts">
          <a class="btn" href="#/a/${area}">← 回 ${esc(area)} 排人</a>
          <a class="btn blue-out" href="#/p/new?area=${area}&slot=${sid}">提出調整</a>
        </div>
      </div>
      <div class="split-grid">
        <div class="split-main">
          ${cancelBox}
          ${ed.length ? `<div class="edbox">${avatars(ed)}<span>${esc(ed.map((u) => u.name).join('、'))} 也在排這一格。加的人會立刻出現，不會互相蓋掉。</span></div>` : ''}
          ${preList.length ? `<div class="pre-banner"><div><b>預排 ${preList.length} 人：</b>${esc(preList.map((x) => x.p.n).join('、'))}（總召或調度台先排的）。必須由區長確認或重排。</div>
            ${leadEdit ? `<div class="act-bar2"><button class="btn pri" data-act="pre-all-ok" data-sid="${sid}" data-area="${area}" data-label="${esc(label)}">全部確認</button>
              <button class="btn pre-out" data-act="pre-all-rm" data-sid="${sid}" data-area="${area}" data-label="${esc(label)}">全部重排（移出）</button></div>` : ''}</div>` : ''}
          ${!canEdit ? `<div class="card muted">${me() ? '您不是這一區的排班人員，只能瀏覽。' : '登入並成為排班人員後才能調整。'}</div>` : ''}
          ${slotOnly.length ? `<div class="card">${issueLines(slotOnly, 4)}</div>` : ''}
          <section class="card members"><h2>已排人員</h2>
            ${loud.map((x) => memberRow(x.p, x.r, x.iss, 'assign', sid, area, label, canEdit, [sid])).join('')}
            ${showQuiet ? quiet.map((x) => memberRow(x.p, x.r, x.iss, 'assign', sid, area, label, canEdit, [sid])).join('') : `<button class="btn wide" data-act="more">其餘 ${quiet.length} 人沒有問題，點開看全部</button>`}
            ${!A.length ? '<div class="empty">還沒有排人</div>' : ''}</section>
          ${canEdit && !s.cancel ? `<div class="act-bar2">
            <button class="btn" data-act="slot-last-year" data-sid="${sid}">帶入去年名單</button>
            <button class="btn pri" data-act="slot-autofill" data-sid="${sid}">系統建議補滿</button>
          </div>
          <div class="muted small">沒有網路時照常可以排，連上後自動同步；同一個人被兩邊同時改到時，兩邊都看得到提示。</div>` : ''}
        </div>
        <aside class="split-side inspector" aria-label="候選人搜尋">
          ${s.cancel ? '<div class="empty">這一格已取消，不能再排入人員。</div>' : canEdit ? finder(area, inIds, 'assign', sid, label, (p) => evalSlotCand(p, s, inIds), canEdit, local) : '<div class="empty">登入並取得本區排班權限後可從此處搜尋排入人員。</div>'}
        </aside>
      </div>
    </main>`;
  }

  function renderApptHits(area) {
    const users = Object.entries(D().users || {}).filter(([uid, u]) => !((D().members || {})[area] || {})[uid] && UI.apptQ && (u.name || '').includes(UI.apptQ)).slice(0, 8);
    return users.map(([uid, u]) => `<div class="cand"><div><b>${esc(u.name)}</b> <span class="muted small">${esc(u.provider || '')}</span></div><div class="acts"><button class="btn sm pri" data-act="appoint" data-area="${area}" data-uid="${esc(uid)}" data-role="sched">指定</button>${isAdmin() ? `<button class="btn sm" data-act="appoint" data-area="${area}" data-uid="${esc(uid)}" data-role="lead">設為區長</button>` : ''}</div></div>`).join('') || (UI.apptQ ? '<div class="empty">找不到，請對方先登入一次</div>' : '');
  }

  /* ---------------- 畫面：B5 分工與送出 ---------------- */
  function vTeam(area) {
    apptArea = area;
    const S = areaStats(area), mems = Object.entries((D().members || {})[area] || {});
    const boss = isLead(area) || isAdmin();
    const [cls, lab] = ST_LABEL[S.status];
    const stepIdx = S.status === 'confirmed' ? 3 : S.status === 'submitted' ? 2 : 1;
    const flowHtml = `<ol class="flow-steps cols4" aria-label="本區進度">${['總召排區', '區內排人', '總召確認', '定版'].map((t, i) =>
      `<li class="flow-step ${i < stepIdx ? 'done' : i === stepIdx ? 'cur' : ''}"><div class="fs-t">${t}</div></li>`).join('')}</ol>`;

    const bindPends = Object.entries(D().users || {}).filter(([, u]) => u.bindStatus === 'pending' && u.bindArea === area);
    const bindPendHtml = boss && bindPends.length ? `<section class="card warnbox"><h2>待確認的姓名綁定（${bindPends.length}）</h2>
      ${bindPends.map(([uid, u]) => {
        const p = M.pById[+u.pid];
        const ap = (D().addedPeople || {})[u.pid];
        const note = (ap && ap.status === 'pending' ? '（新名冊申請）' : '') + (Object.entries(D().users || {}).some(([x, v]) => x !== uid && v && +v.pid === +u.pid && v.bindStatus === 'ok') ? '（此姓名已被其他帳號綁定）' : '');
        return `<div class="mem"><div class="mem-h"><b>${esc(u.name)}</b> <span class="muted small">申請綁定為「${esc(p ? p.n : (ap ? ap.n : u.pid))}」${esc(note)}</span>
          <div class="acts" style="margin-left:auto"><button class="btn sm pri" data-act="approve-bind" data-uid="${esc(uid)}" data-ok="1">同意</button><button class="btn sm" data-act="approve-bind" data-uid="${esc(uid)}" data-ok="0">不同意</button></div></div></div>`;
      }).join('')}</section>` : '';

    const row = ([uid, m]) => {
      const sc = m.scope ? KINDS.filter(([k]) => m.scope[k]).map(([, t]) => t).join('、') || '尚未勾選' : '全部可排';
      const on = present(area).some((u) => u.uid === uid);
      const scopeBox = boss && m.role !== 'lead' && m.status === 'ok' ? `<details><summary>指定只排哪些</summary><div class="grid2">${KINDS.map(([k, t]) => `<label class="ck"><input type="checkbox" data-act-change="scope" data-area="${area}" data-uid="${esc(uid)}" data-k="${k}" ${!m.scope || m.scope[k] ? 'checked' : ''}> ${t}</label>`).join('')}</div><div class="muted small">全部勾選＝全部可排。</div></details>` : '';
      return `<div class="mem"><div class="mem-h"><b>${esc(m.name)}</b>${tag('no', m.role === 'lead' ? '區長' : '排班人員')}${m.status === 'pending' ? tag('wn', '申請中') : ''}${on ? tag('ok', '作業中') : ''}
        ${boss && m.status === 'pending' ? `<button class="btn sm pri" data-act="approve" data-area="${area}" data-uid="${esc(uid)}">同意</button>` : ''}
        ${boss && m.role !== 'lead' ? `<button class="btn sm" data-act="unmember" data-area="${area}" data-uid="${esc(uid)}">${m.status === 'pending' ? '不同意' : '取消'}</button>` : ''}
        ${isAdmin() && m.role === 'lead' ? `<button class="btn sm" data-act="unmember" data-area="${area}" data-uid="${esc(uid)}">取消區長</button>` : ''}</div>
        <div class="muted small">${m.role === 'lead' ? '排班人員（預設）· 全部可排；可送出' : esc(sc)}${m.by ? ` · ${esc(m.by)} 指定` : ''}</div>${scopeBox}</div>`;
    };
    const appoint = boss ? `<section class="card"><h2>指定排班人員</h2><div class="muted small">對方要先登入過一次，才找得到。也可以請他在本區頁面按「申請成為排班人員」。</div>
      <label>找已登入的人<input id="apptQ" type="search" value="${esc(UI.apptQ)}" data-input="apptQ" placeholder="輸入姓名（至少一個字）"></label>
      <div id="appt">${renderApptHits(area)}</div></section>` : '';
    const logs = Object.entries(D().log || {}).filter(([, l]) => l.area === area).sort((a, b) => b[1].at - a[1].at).slice(0, UI.showAll ? 60 : 8);
    const submit = isLead(area)
      ? S.status === 'editing' || S.status === 'not_started' ? `<button class="btn pri big" data-act="submit" data-area="${area}">送出給總召確認</button>` : (S.status === 'confirmed' ? `<div class="muted small">總召已確認。要修改請聯絡總召退回。</div>` : `<button class="btn" data-act="unsubmit" data-area="${area}">收回，繼續排</button>`)
      : `<div class="muted small">只有區長能送出。</div>`;
    return `${wsHeader('area', 't', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small"><a href="#/">工作區首頁</a> ／ <a href="#/a/${area}">${esc(area)} 排人</a> ／ 分工與送出 (B5)</div>
          <div class="row-t"><h1>${esc(area)}　分工與送出</h1>${tag(cls, lab)}</div>
        </div>
        <div class="acts">
          <a class="btn" href="#/a/${area}">← 回 ${esc(area)} 排人</a>
          <a class="btn blue-out" href="#/b1/${area}">區長首頁 (B1)</a>
        </div>
      </div>
      ${flowHtml}
      <div class="split-grid">
        <div class="split-main">
          <div class="muted">一開始只有區長是排班人員。其他人要由區長或調度台指定後才能排。</div>
          ${bindPendHtml}
          <section class="card members"><h2>本區排班人員</h2>${mems.map(row).join('') || '<div class="empty">還沒有排班人員。請調度台指定區長。</div>'}</section>
          ${appoint}
          <section class="card"><h2>最近的改動</h2>${logs.map(([id, l]) => `<div class="logrow"><span class="num small">${ago(l.at)}</span> <b>${esc(l.name)}</b> ${esc(l.msg)}${canUndo(l) ? ` <button class="link" data-act="undo" data-id="${esc(id)}">復原</button>` : l.undone ? ' <span class="muted small">已復原</span>' : ''}</div>`).join('') || '<div class="empty">還沒有改動</div>'}
            ${logs.length >= 8 && !UI.showAll ? `<button class="btn wide" data-act="more">看更多</button>` : ''}</section>
        </div>
        <aside class="split-side inspector" aria-label="送出確認">
          <section class="card sendbox"><h2>送出給總召前</h2>
            <div class="kv"><span>組別排好</span><b>${S.gDone}／${S.groups.length} 組</b></div>
            <div class="kv"><span>依日期排滿</span><b>${S.dDone}／${S.dated.length} 格</b></div>
            <div class="kv"><span>人數不足</span><b class="${S.short ? 't-bad' : ''}">${S.short}</b></div>
            <div class="kv"><span>同一天撞到別的排班</span><b class="${S.clash ? 't-bad' : ''}">${S.clash}</b></div>
            <div class="kv"><span>其他違規（間隔、次數上限等）</span><b class="${S.v - S.clash ? 't-warn' : ''}">${S.v - S.clash}</b></div>
            <div class="kv"><span>注意</span><b class="${S.n ? 't-warn' : ''}">${S.n}</b></div>
            <div class="kv"><span>預排待確認</span><b>${S.pre}</b></div>
            ${submit}<div class="muted small">沒排好也可以送，缺的人會列給總召協調。送出後還能改，改動會標記給總召看。</div></section>
          <section class="card"><h2>分工權限說明</h2>
            <div class="kv-row"><b>區長</b><span class="muted">可排全區全部項目、指定／撤銷排班人員、確認預排及送出給總召。</span></div>
            <div class="kv-row"><b>排班人員</b><span class="muted">依區長勾選範圍（廚務、服務、禮節、交通、輪值或人員狀態）協助排人。</span></div>
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- 畫面：A6 各區進度與跨區協調 ---------------- */
  function vReview() {
    if (!(D().meta || {}).seeded) return vHome();
    const rows = WORK_AREAS.map((a) => ({ a, S: areaStats(a) })).filter((x) => x.S.groups.length + x.S.dated.length);
    const unsubmitted = rows.filter((x) => x.S.status === 'editing' || x.S.status === 'not_started').map((x) => x.a);

    const tbl = `<div class="table-wrap"><div class="arow-table">
      <div class="arow-grid hd"><div>區</div><div>狀態</div><div>排好（組別＋依日期）</div><div>缺人</div><div>違規</div><div>注意</div><div>排班人員</div><div></div></div>
      ${rows.map(({ a, S }) => {
        const [cls, lab] = ST_LABEL[S.status], tot = S.groups.length + S.dated.length, done = S.gDone + S.dDone;
        const mem = Object.values((D().members || {})[a] || {}).filter((m) => m.status === 'ok');
        const on = present(a).length;
        const pct = tot ? Math.round(done / tot * 100) : 0;
        const actBtn = isAdmin() && S.status === 'submitted'
          ? `<button class="btn sm pri" data-act="confirm-area" data-area="${a}">確認</button><button class="btn sm" data-act="return-area" data-area="${a}">退回</button>`
          : (S.status === 'not_started' ? `<a class="btn sm" href="#/t/${a}">指定排班人員</a>` : `<a class="btn sm" href="#/a/${a}">查看</a>`);
        return `<div class="arow-grid">
          <div><a href="#/a/${a}" class="c-${a}" style="text-decoration:none"><b>${a}</b></a></div>
          <div>${tag(cls, lab)}${S.after ? `<div>${tag('pl', `送出後變更 ${S.after}`)}</div>` : ''}</div>
          <div style="display:grid;grid-template-columns:1fr 56px;gap:8px;align-items:center"><div class="bar"><div style="width:${pct}%"></div></div><span class="num small">${done}／${tot}</span></div>
          <div class="num ${S.short ? 't-bad' : ''}">${S.short}</div>
          <div class="num ${S.v ? 't-bad' : ''}">${S.v}</div>
          <div class="num ${S.n ? 't-warn' : ''}">${S.n}</div>
          <div class="muted small">${mem.length ? mem.length + ' 人' : '尚未指定'}${on ? ` · ${on} 人作業中` : ''}${S.pre ? ` · 預排 ${S.pre}` : ''}</div>
          <div class="acts">${actBtn}<a class="btn sm" href="#/b1/${a}">首頁</a></div>
        </div>`;
      }).join('')}
    </div></div>`;

    // 各區負擔：協調換區、支援請求時的說明依據（與 A2 年度總表同一套算法）
    const TC = window.TDConsole;
    let loadHtml = '';
    if (TC && TC.renderAreaLoad) {
      const cctx = consoleCtx();
      const L = E.areaLoad(M);
      loadHtml = `<section class="card load-card">
        <div class="row-h"><h2 style="margin:0">各區負擔（協調參考）</h2><a class="btn sm" href="#/a2">到年度總表看分類次數</a></div>
        ${TC.renderAreaLoad(cctx, { L, compact: true })}
        <div class="small muted">${TC.loadNoteHtml(L)}</div>
      </section>`;
    }
    const coord = Object.entries(D().coord || {}).sort((a, b) => b[1].at - a[1].at).filter(([, c]) => c.st !== 'done');
    const crossList = ISS.filter(isClash);
    const shortSubmitted = rows.filter((x) => x.S.status === 'submitted' && x.S.short > 0);
    const afterChanges = rows.filter((x) => x.S.after > 0);
    const crossP3 = ISS.filter((c) => !c.accepted && c.rule === 'P3' && c.lvl === '違規' && c.slots.length >= 2 && (M.byId[c.slots[0]] && M.byId[c.slots[1]] && M.byId[c.slots[0]].area !== M.byId[c.slots[1]].area));
    const acceptedAcks = Object.entries(normAcks()).filter(([, a]) => a.st === '接受例外');
    const issByKey = new Map(ISS.map((c) => [c.key, c]));

    // #15：所屬區不在六區的綁定申請（天達、金門、青年班…）沒有區長，由總召在這裡確認
    const orphanBinds = isAdmin() ? Object.entries(D().users || {}).filter(([, u]) => u && u.bindStatus === 'pending' && !AREAS.includes(u.bindArea)) : [];
    const orphanHtml = orphanBinds.length ? `<section class="card warnbox"><h2>待確認的姓名綁定（無區長的單位，${orphanBinds.length}）</h2>
      ${orphanBinds.map(([uid, u]) => { const p0 = M.pById[+u.pid], ap = (D().addedPeople || {})[u.pid];
        return `<div class="mem"><div class="mem-h"><b>${esc(u.name)}</b> <span class="muted small">申請綁定為「${esc(p0 ? p0.n : (ap ? ap.n : u.pid))}」· ${esc(u.bindArea || '')}</span>
        <div class="acts" style="margin-left:auto"><button class="btn sm pri" data-act="approve-bind" data-uid="${esc(uid)}" data-ok="1">同意</button><button class="btn sm" data-act="approve-bind" data-uid="${esc(uid)}" data-ok="0">不同意</button></div></div></div>`; }).join('')}</section>` : '';
    const flowHtml = `<ol class="flow-steps" aria-label="年度排班分工">
      <li class="flow-step"><div class="fs-d">總召、人資</div><div class="fs-t">1. 排到區並鎖定</div><div class="fs-d">哪一區、哪一天、哪一組</div></li>
      <li class="flow-step done"><div class="fs-d">各區</div><div class="fs-t">2. 區內排人</div><div class="fs-d">一開始只有區長能排；區長或調度台可再指定</div></li>
      <li class="flow-step done"><div class="fs-d">總召、人資</div><div class="fs-t">3. 檢查衝突與協調</div><div class="fs-d">跨區衝突、人數不足、需要借調</div></li>
      <li class="flow-step"><div class="fs-d">總召</div><div class="fs-t">4. 定版</div><div class="fs-d">全部的區確認後鎖版、匯出手冊</div></li>
    </ol>`;

    const remindBox = UI.a6RemindOpen ? `<section class="card warnbox">
      <div class="row-h"><h2>提醒還沒送出的區</h2><button class="btn sm" data-act="toggle-a6-remind">關閉</button></div>
      <div class="muted small">目前尚未送出：<b>${unsubmitted.length ? unsubmitted.join('、') : '全部皆已送出'}</b></div>
      ${unsubmitted.length ? `<button class="btn sm pri" data-act="copy-remind" data-text="${esc(`【天達堂 116 排班提醒】請 ${unsubmitted.join('、')} 區長完成本區排人後，於「分工與送出」點擊送出給總召確認。`)}">複製提醒訊息（可貼 LINE 群組）</button>` : ''}
    </section>` : '';

    const pickAreaBox = UI.a6PickAreaOpen ? `<section class="card">
      <div class="row-h"><h2>前往指定各區排班人員</h2><button class="btn sm" data-act="toggle-a6-pick">關閉</button></div>
      <div class="chips">${WORK_AREAS.map((a) => `<a class="btn sm" href="#/t/${a}">${a}</a>`).join('')}</div>
    </section>` : '';

    return `${wsHeader('A', 'review')}<main class="wide-main">
      <div class="page-head">
        <div><h1>各區排人進度，以及需要協調的事</h1><p class="muted" style="margin:4px 0 0">人由各區自己排。這裡看各區排到哪裡，並處理只有跨區才看得出來的衝突。</p></div>
        <div class="acts">
          <button class="btn" data-act="toggle-a6-pick">指定各區排班人員</button>
          <button class="btn" data-act="toggle-a6-remind">提醒還沒送出的區</button>
          <a class="btn pri" href="#/p">前往提案試算</a>
        </div>
      </div>
      ${pickAreaBox}${remindBox}${orphanHtml}${flowHtml}${tbl}
      ${loadHtml}
      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <div class="row-h"><h2>需要總召協調</h2><span class="muted small">各區排的當下就看得到對方排的內容；這裡列的是還沒談定的</span></div>
            ${coord.map(([id, c]) => `<div class="coord-item">
              <div>${tag('bad', '區請協調')} <b class="c-${esc(c.area)}">${esc(c.area)}</b> <span class="muted small">${esc(c.name)} · ${ago(c.at)}</span>
                <div><b>${esc(c.label)}</b>：${esc(c.msg)}</div></div>
              <div class="muted small">${+c.pid ? `<button class="link" data-act="person" data-pid="${+c.pid}">看 ${esc((M.pById[+c.pid] || {}).n || '')} 全年排班</button>` : ''}</div>
              <div class="acts">${isAdmin() ? `<button class="btn sm pri" data-act="coord-done" data-id="${esc(id)}">標為已處理</button>` : ''}</div>
            </div>`).join('')}
            ${crossList.slice(0, UI.showAll ? 200 : 8).map((c) => `<div class="coord-item">
              <div>${tag('bad', '同一人在兩份名單')}<div style="font-weight:700;margin-top:4px">${esc(c.msg)}</div>
                <div>${c.slots.map((sid) => { const s = M.byId[sid]; return s ? `<a class="small" href="${s.groupKey ? '#/g/' + s.groupKey : '#/s/' + sid}">${esc(s.area)} ${esc(s.groupKey ? gmOf(s.groupKey).name : s.cat)}</a>` : ''; }).join(' · ')}</div></div>
              <div class="muted small">${c.pid ? `<button class="link" data-act="person" data-pid="${+c.pid}">看全年排班</button>` : ''}</div>
              <div class="acts">${isAdmin() ? `<button class="btn sm" data-act="ack-issue" data-key="${esc(c.key)}">接受為例外</button>` : ''}</div>
            </div>`).join('')}
            ${shortSubmitted.map(({ a, S }) => `<div class="coord-item">
              <div>${tag('bad', '人數不足')}<div style="font-weight:700;margin-top:4px">${a} 送出時尚有 ${S.short} 格缺人</div><div class="muted small">已送出但缺額，建議向人均較低區域發支援請求</div></div>
              <div class="muted small">相關：${a}</div>
              <div class="acts">${isAdmin() ? `<a class="btn sm pri" href="#/p/new?area=${a}&type=合併支援">發支援請求</a>` : ''}</div>
            </div>`).join('')}
            ${crossP3.slice(0, 6).map((c) => `<div class="coord-item">
              <div>${tag('wn', '跨名單七天內重複')}<div style="font-weight:700;margin-top:4px">${esc(c.msg)}</div></div>
              <div class="muted small">${esc(c.slots.map((sid) => M.byId[sid] ? M.byId[sid].area : '').join('、'))}</div>
              <div class="acts">${c.pid ? `<button class="btn sm" data-act="person" data-pid="${+c.pid}">逐筆檢視</button>` : ''}${isAdmin() ? `<button class="btn sm" data-act="ack-issue" data-key="${esc(c.key)}">接受為例外</button>` : ''}</div>
            </div>`).join('')}
            ${afterChanges.map(({ a, S }) => `<div class="coord-item">
              <div>${tag('pl', '送出後變更')}<div style="font-weight:700;margin-top:4px">${a} 送出後又更動 ${S.after} 筆</div><div class="muted small">違規 ${S.v} · 注意 ${S.n}</div></div>
              <div class="muted small">相關：${a}</div>
              <div class="acts">${isAdmin() ? `<button class="btn sm pri" data-act="clear-after" data-area="${a}">標為已看</button>` : ''}</div>
            </div>`).join('')}
            ${!coord.length && !crossList.length && !shortSubmitted.length && !afterChanges.length && !crossP3.length ? '<div class="empty">目前沒有需要協調的事項</div>' : ''}
            ${crossList.length > 8 && !UI.showAll ? `<button class="btn wide" data-act="more">顯示全部碰撞（${crossList.length}）</button>` : ''}
            ${acceptedAcks.length ? `<details><summary>已接受為例外（${acceptedAcks.length}）</summary>
              ${acceptedAcks.map(([k, v]) => `<div class="logrow">${esc(issByKey.has(k) ? issByKey.get(k).msg : '（此問題目前已不存在）')} · ${esc(v.by || '')} ${isAdmin() ? `<button class="link" data-act="unack-issue" data-key="${esc(k)}">撤銷例外</button>` : ''}</div>`).join('')}</details>` : ''}
          </section>
        </div>
        <aside class="split-side">
          ${isAdmin() ? `<section class="card"><h2>姓名綁定審核方式 (M8)</h2>
            <div class="muted small">目前：<b>${autoApproveBind() ? '測試期，綁定立即生效' : '正式審核，需區長或小組長確認'}</b>${typeof (D().config || {}).autoApproveBind === 'boolean' ? '' : '（資料庫尚未設定，暫用 config.js 預設）'}</div>
            <button class="btn sm" data-act="toggle-auto-bind">${autoApproveBind() ? '改為正式審核' : '改為測試期立即生效'}</button></section>` : ''}
          <section class="card"><h2>檢查在哪裡出現</h2>
            <div class="kv-row"><b>區內規則</b><span class="muted">人數、個人上限、平日天數、暫停與不方便的月份：各區排的當下就看得到</span></div>
            <div class="kv-row"><b>跨區、跨名單</b><span class="muted">同一人在兩份名單、不同地點兼職、跨名單間隔：兩邊直接看得到對方內容，談不攏再請總召協調</span></div>
            <div class="kv-row"><b>預排</b><span class="muted">總召或調度台可以先預排人；必須由區長確認或重排</span></div>
            <div class="kv-row"><b>區層級</b><span class="muted">同日同區多項、相鄰場次同區、各區次數：由總召以提案處理</span></div>
            <div class="kv-row"><b>搭檔加分</b><span class="muted">只影響候選人排序，不顯示分數</span></div>
          </section>
          <section class="card"><h2>多人同時作業的規則</h2>
            <ul style="margin:0;padding-left:18px;font-size:14px;display:flex;flex-direction:column;gap:6px">
              <li>以「一個人加入一組」或「一個人排進一天」為單位存檔，不會互相蓋掉</li>
              <li>有組別的勤務只能改組員，全年每一場一起變</li>
              <li>同一個人被兩邊同時排到衝突的格，會立即顯示對方內容並可請總召協調</li>
              <li>每筆改動記下誰、何時，可以單筆復原</li>
              <li>離線先存本機，連線後自動補送；送出後仍可改並標記給總召</li>
            </ul>
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- 畫面：B1 區長首頁 ---------------- */
  function vAreaLead(area) {
    if (!AREAS.includes(area)) area = defaultArea();
    if (!(D().meta || {}).seeded) return vHome();
    const am = areaMetrics(area);
    const ranks = allAreaLoadRank();
    const myRank = ranks.findIndex((x) => x.area === area) + 1;
    const maxAvg = Math.max(1, ...ranks.map((x) => x.avg));

    // KPI 6 張
    const kpis = [
      { l: '人均次數', v: am.avgLoad.toFixed(1), s: `六區第 ${myRank} 高（共 ${am.peopleCnt} 人）` },
      { l: '環境＋服務', v: am.envSrvCnt, s: am.srvGrps.length ? am.srvGrps.join('、') + ' 輪替' : '—' },
      { l: '禮節', v: am.ljCnt, s: am.ljGrps.length ? am.ljGrps.join('、') : '—' },
      { l: '洗碗', v: am.washCnt, s: '依日期排人' },
      { l: '忠恕假日', v: am.jzHol.length, s: am.jzHol.slice(0, 3).map((s) => E.fmtD(s.d)).join('、') || '無' },
      { l: '忠恕平日', v: am.jzWd.length, s: am.jzWd.length ? '需要請假' : '無' }
    ];

    // 提醒事項（需要區長處理）
    const asks = [];
    // 1) 本區區級違規（如 12/11 明德班、2/27 內湖）
    const areaViols = ISS.filter((c) => !c.accepted && c.scope === '區' && c.lvl === '違規' && c.area === area);
    for (const c of areaViols) {
      const relProp = propList().find((p) => p.status !== 'resolved' && Array.isArray(p.slotIds) && c.slots.some((sid) => p.slotIds.includes(sid)));
      asks.push({
        cls: 'bad', tag: '同日衝突', t: c.msg, d: relProp ? `已有提案 ${relProp.id}：${relProp.title}` : '建議透過「提出調整」試算換區或換日方案。',
        acts: relProp ? `<a class="btn sm blue-out" href="#/p/${encodeURIComponent(relProp.id)}">處理提案 ${esc(relProp.id)}</a>` : `<a class="btn sm blue-out" href="#/p/new?area=${area}&slot=${c.slots[0] || ''}&type=換區">提出調整</a>`
      });
    }
    // 2) 本區依日期勤務缺額且人力緊繃
    const S = areaStats(area);
    for (const x of S.dated.filter((d) => d.n < d.need)) {
      const freeCnt = E.poolFor(M, x.s, false).filter((p) => !M.asg[x.s.id].p.includes(p.id) && !evalInSlot(p, x.s).hard.length).length;
      if (freeCnt < x.need - x.n || x.need >= 15) {
        asks.push({
          cls: 'wn', tag: '人數', t: `${slotName(x.s)} 需 ${x.need} 人，目前 ${x.n} 人`,
          d: `本區無違規可補約 ${freeCnt} 人。`,
          acts: `<a class="btn sm blue-out" href="#/p/new?area=${area}&slot=${x.s.id}&type=合併支援">請求支援</a><a class="btn sm" href="#/s/${x.s.id}">我來補名單</a>`
        });
      }
    }
    // 3) 預排待確認（組別與依日期都要列，#10）
    for (const g of S.groups) for (const [pid, rec] of pidRecs((D().groups || {})[g.gm.id])) {
      if (rec.pre) {
        const p = M.pById[+pid];
        asks.push({
          cls: 'pre', tag: '預排', t: `調度台預排 ${p ? p.n : +pid}，等區長確認`, d: `${g.gm.name}。只有區長能確認或重排。`,
          acts: isLead(area) ? `<button class="btn sm pri" data-act="pre-ok" data-kind="groups" data-key="${esc(g.gm.id)}" data-pid="${+pid}" data-area="${area}" data-label="${esc(g.gm.name)}">確認</button>
            <button class="btn sm" data-act="rm" data-kind="groups" data-key="${esc(g.gm.id)}" data-pid="${+pid}" data-area="${area}" data-label="${esc(g.gm.name)}">重排</button>` : `<a class="btn sm" href="#/g/${esc(g.gm.id)}">查看</a>`
        });
      }
    }
    for (const x of S.dated) for (const [pid, rec] of pidRecs((D().assign || {})[x.s.id])) {
      if (rec.pre) {
        const p = M.pById[+pid];
        asks.push({
          cls: 'pre', tag: '預排', t: `調度台預排 ${p ? p.n : +pid}，等區長確認`, d: `${slotName(x.s)}。只有區長能確認或重排。`,
          acts: isLead(area) ? `<button class="btn sm pri" data-act="pre-ok" data-kind="assign" data-key="${esc(x.s.id)}" data-pid="${+pid}" data-area="${esc(area)}" data-label="${esc(slotName(x.s))}">確認</button>
            <button class="btn sm" data-act="rm" data-kind="assign" data-key="${esc(x.s.id)}" data-pid="${+pid}" data-area="${esc(area)}" data-label="${esc(slotName(x.s))}">重排</button>` : `<a class="btn sm" href="#/s/${x.s.id}">查看</a>`
        });
      }
    }
    // 4) 帶隊與儲備廚師提名提醒
    const nom = (D().nominations || {})[area] || {};
    if (!nom.updatedAt) {
      asks.push({
        cls: 'pl', tag: '提名', t: '小組長與儲備廚師提名', d: '每區儲備廚師建議 4 位；帶隊小組長請填一年可帶場次。',
        acts: `<button class="btn sm blue-out" data-act="open-nom">開始填寫</button>`
      });
    }

    // 本區全年任務表
    const taskSlots = am.aSlots.filter((s) => UI.b1ShowCook || !E.isCookSlot(s));
    const taskRows = taskSlots.map((s) => {
      const a = M.asg[s.id].p.length, need = E.slotNeed(M, s);
      const si = slotIssuesOf(s.id).filter((c) => !c.accepted && c.rule !== 'P11');
      const hasViol = si.some((c) => c.lvl === '違規') || areaViols.some((c) => c.slots.includes(s.id));
      const hasWarn = si.some((c) => c.lvl === '注意');
      const props = slotProps[s.id] || [];
      let tCls = 'no', tLab = '待排', tNote = s.src || '';
      if (props.length) { tCls = 'bad'; tLab = '提案中'; tNote = props[0].id; }
      else if (hasViol) { tCls = 'bad'; tLab = '同日衝突'; tNote = (si[0] || areaViols[0]).msg; }
      else if (s.lock && a >= need) { tCls = 'pre'; tLab = '已鎖定'; }
      else if (a >= need && !hasWarn) { tCls = 'ok'; tLab = '通過'; }
      else if (a < need && a > 0) { tCls = 'wn'; tLab = `缺 ${need - a}`; }
      else if (hasWarn) { tCls = 'wn'; tLab = '注意'; tNote = si[0].msg; }
      else if (s.lock) { tCls = 'pre'; tLab = '已鎖定'; }
      return `<div class="task-grid">
        <div class="num small">${esc(dLabel(s))}</div>
        <div><a href="${s.groupKey ? '#/g/' + s.groupKey : '#/s/' + s.id}" style="text-decoration:none;font-weight:700">${esc(s.label || s.cat)}</a> <span class="muted small">${esc(s.cat)}</span></div>
        <div class="num small ${a < need ? 't-bad' : ''}">${a}／${need}</div>
        <div>${tag(tCls, tLab)} <span class="muted small">${esc(tNote)}</span></div>
        <div><a class="link" href="#/p/new?area=${area}&slot=${s.id}">調整</a></div>
      </div>`;
    }).join('');

    // 相關提案
    const relProps = propList().filter((p) => p.area === area || (p.targetAreas || []).includes(area) || p.area === '總召')
      .sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || b.at - a.at);

    // 提名互動面板
    const areaCands = M.people.filter((p) => p.a === area && !p.off);
    const leadCands = areaCands.filter((p) => /小組長|組長/.test((p.lead || '') + (p.zr || '')) || p.n115 >= 5);
    const nomBox = UI.b1NomOpen ? `<section class="card warnbox" style="margin-top:8px">
      <div class="row-h"><h3>提名帶隊人與儲備廚師（${area}）</h3><button class="btn sm" data-act="close-nom">收合</button></div>
      <label>推薦小組長／帶隊人（可用逗號分隔姓名及可帶場次）<textarea id="nomLeads" rows="2" placeholder="例：王特蓮(6次)、林萬鶴(4次)">${esc(nom.leads || '')}</textarea></label>
      <div class="muted small">本區資深可帶隊參考：${esc(leadCands.slice(0, 6).map((p) => p.n).join('、'))}</div>
      <label>推薦儲備廚師（建議 4 位）<input id="nomCooks" type="text" value="${esc(nom.cooks || '')}" placeholder="輸入姓名，以頓號或空白分隔"></label>
      <button class="btn pri" data-act="save-nom" data-area="${area}">儲存提名</button>
    </section>` : '';

    return `${wsHeader('B', 'b1', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="c-${area}" style="font-size:13px;font-weight:700">${area}區 · 區長首頁</div>
          <h1>本區 116 年的任務與待回覆事項</h1>
          <p class="muted" style="margin:4px 0 0">這裡只列 ${area} 的資料。要調整請用「提出調整」，系統會先算出對其他區的影響。</p>
        </div>
        <div class="acts" style="align-items:flex-end">
          <label style="font-size:12px">切換區<select data-act-change="b1-area">${AREAS.map((a) => `<option ${a === area ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
          <a class="btn blue-out" href="#/a/${area}">排本區的人</a>
          <a class="btn blue" href="#/p/new?area=${area}">提出調整</a>
        </div>
      </div>

      <div class="kpi-grid">${kpis.map((k) => `<div class="kpi-card"><div class="kpi-l">${k.l}</div><div class="kpi-v">${k.v}</div><div class="kpi-s">${esc(k.s)}</div></div>`).join('')}</div>

      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <div class="row-h"><h2>提醒事項：需要區長處理</h2><span class="muted small">共 ${asks.length} 項</span></div>
            ${asks.map((a) => `<div class="coord-item"><div>${tag(a.cls, a.tag)}<div style="font-weight:700;margin-top:4px">${esc(a.t)}</div><div class="muted small">${esc(a.d)}</div></div>
              <div class="acts">${a.acts}</div></div>`).join('') || '<div class="empty">目前沒有待處理提醒</div>'}
          </section>

          <div class="table-wrap"><div class="task-table">
            <div class="table-head-pad"><h2>本區全年任務（${taskSlots.length} 場）</h2>
              <label class="ck"><input type="checkbox" data-act-change="b1-cook" ${UI.b1ShowCook ? 'checked' : ''}> 含廚務組場次</label></div>
            <div class="task-grid hd"><div>日期</div><div>任務</div><div>人數</div><div>狀況</div><div></div></div>
            ${taskRows || '<div class="empty">本區沒有任務</div>'}
          </div></div>
        </div>

        <aside class="split-side">
          <section class="card"><h2>各區人均次數（估計）</h2>
            ${ranks.map((r) => `<div class="load-row"><b class="c-${r.area}">${r.area}</b>
              <div class="load-bar"><div style="width:${Math.round(r.avg / maxAvg * 100)}%;background:currentColor" class="c-${r.area}"></div></div>
              <span class="num small" style="text-align:right">${r.avg.toFixed(1)}</span></div>`).join('')}
            <div class="muted small">基隆人數少、只排平日，人均最高。松山沒有廚務組，多分擔非廚務項目。</div>
          </section>

          <section class="card"><h2>和本區有關的提案</h2>
            ${relProps.map((p) => {
              const stTag = p.status === 'resolved' ? tag('ok', '已決議') : p.status === 'waiting' ? tag('wn', '等待回覆') : tag('pl', '討論中');
              return `<a class="mem" style="text-decoration:none;color:inherit" href="#/p/${encodeURIComponent(p.id)}">
                <div class="row-h"><b>${esc(p.id)} ${esc(p.title)}</b>${stTag}</div>
                <div class="muted small">${esc(p.byName)}提出 · ${esc(p.type)}</div></a>`;
            }).join('') || '<div class="empty">目前沒有相關提案</div>'}
          </section>

          <section class="card"><h2>帶隊人力</h2>
            <div class="muted small">115 年 ${area} 平均每人服務 ${am.avg115.toFixed(1)} 次 · 目前可帶隊共 ${am.leaders} 位。</div>
            <div class="kv"><span>主廚／大廚</span><b class="num">${am.heads} 位主廚</b></div>
            <div class="kv"><span>小組長提名</span><b class="${nom.leads ? 't-ok' : 't-warn'}">${nom.leads ? esc(nom.leads) : '尚未填寫'}</b></div>
            <div class="kv"><span>儲備廚師提名</span><b class="${nom.cooks ? 't-ok' : 't-warn'}">${nom.cooks ? esc(nom.cooks) : '尚未填寫'}</b></div>
            <button class="btn blue-out" data-act="open-nom">提名帶隊人與儲備廚師</button>
            ${nomBox}
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- 畫面：B2 調整提案與影響試算 ---------------- */
  function vProposal(arg) {
    if (!(D().meta || {}).seeded) return vHome();
    const allProps = propList().sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || b.at - a.at);
    const [rawId, qs] = (arg || '').split('?');
    const qParams = new URLSearchParams(qs || '');

    // 新增提案表單
    if (rawId === 'new') {
      // 網址參數不可信：只接受已知的區、格、類型（X-02 反射式注入）
      const defArea = WORK_AREAS.includes(qParams.get('area')) ? qParams.get('area') : defaultArea();
      const defSlot = RE_SID.test(qParams.get('slot') || '') ? qParams.get('slot') : '';
      const defType = PROPOSAL_TYPES.some(([t]) => t === qParams.get('type')) ? qParams.get('type') : '換區';
      const sObj = defSlot ? M.byId[defSlot] : null;
      const slotOpts = defArea
        ? M.slots.filter((s) => !s.cancel && s.area === defArea).concat(M.slots.filter((s) => !s.cancel && s.area !== defArea))
        : M.slots.filter((s) => !s.cancel);
      const defTitle = sObj ? `${slotName(sObj)}：${defArea} 調整` : '';
      return `${wsHeader('P', 'b2', defArea)}<main class="wide-main">
        <div class="page-head"><div><div class="muted small"><a href="#/b1/${defArea}">本區首頁</a> ／ 新增提案</div><h1>提出調整提案</h1></div>
          <a class="btn" href="#/p">← 回提案列表</a></div>
        <section class="card" style="max-width:720px">
          <div class="grid2">
            <label>提案類型<select id="npType">${PROPOSAL_TYPES.map(([t]) => `<option ${t === defType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            <label>目標勤務格<select id="npSlot"><option value="">（不指定單一格／通案）</option>${slotOpts.map((s) => `<option value="${s.id}" ${s.id === defSlot ? 'selected' : ''}>${esc(dLabel(s))}${esc(s.area)} · ${esc(s.cat)}</option>`).join('')}</select></label>
          </div>
          <label>提案標題<input id="npTitle" type="text" value="${esc(defTitle)}" placeholder="例：12/11 冬季大典前晚改由新莊負責"></label>
          <label>原因說明<textarea id="npReason" placeholder="說明為何需要調整，系統會自動產生甲乙方案並試算影響"></textarea></label>
          <div class="grid2">
            <label>方案甲承接區（換區／認領用）<select id="npTargetArea"><option value="">未指定</option>${WORK_AREAS.map((a) => `<option>${a}</option>`).join('')}</select></label>
            <label>方案甲新日期（換日用）<input id="npNewDate" type="date"></label>
          </div>
          <label>方案甲新需求人數（調整人數用）<input id="npNewNeed" type="number" min="1" max="50" placeholder="例：22"></label>
          <button class="btn blue big" data-act="create-prop" data-area="${defArea}">建立提案並執行影響試算</button>
        </section>
      </main>`;
    }

    if (rawId && !propById(rawId)) {
      return `${wsHeader('P', 'b2', defaultArea())}<main class="wide-main"><div class="page-head"><div><h1>找不到提案</h1><p class="muted">沒有編號為「${esc(rawId)}」的提案，可能已被刪除或網址有誤。</p></div></div>
        <div class="acts"><a class="btn pri" href="#/p">回提案列表</a><a class="btn" href="#/p/new">＋ 提出新調整</a></div></main>`;
    }
    const pr = propById(rawId) || propById('D10') || allProps[0];
    if (!pr) return `${wsHeader('P', 'b2')}<main class="wide-main"><div class="empty">目前沒有提案，請按「提出新調整」。</div><a class="btn pri" href="#/p/new">＋ 提出新調整</a></main>`;

    const curStep = pr.step || (pr.status === 'resolved' ? 6 : 3);
    const steps = ['提出', '影響試算', '相關區回覆', '籌備會決議', '套用到總表', '通知與紀錄'];
    const flowHtml = `<ol class="flow-steps" aria-label="提案進度">${steps.map((t, i) => {
      const idx = i + 1;
      const cls = idx < curStep ? 'blue-done' : idx === curStep ? 'blue-cur' : '';
      return `<li class="flow-step ${cls}"><div class="fs-d">${idx}</div><div class="fs-t">${t}</div></li>`;
    }).join('')}</ol>`;

    const opts = pr.options || [];
    const sims = opts.map((o) => ({ o, sim: simulateProposalOption(pr, o) }));
    const colStyle = `grid-template-columns: 1.1fr ${opts.map(() => '1fr').join(' ')}`;

    const cmpRows = [
      { k: '同日衝突', vals: sims.map((x) => ({ t: `${x.sim.baseConflicts} 處 → ${x.sim.nextConflicts} 處`, c: x.sim.nextConflicts < x.sim.baseConflicts ? 't-ok' : 't-bad' })) },
      { k: '新增違規', vals: sims.map((x) => ({ t: x.sim.addedViols.length ? x.sim.addedViols.map((v) => v.msg).slice(0, 2).join('；') : '無', c: x.sim.addedViols.length ? 't-bad' : '' })) },
      { k: '新增注意', vals: sims.map((x) => ({ t: x.sim.addedNotices.length ? `＋${x.sim.addedNotices.length} 則` : '無', c: x.sim.addedNotices.length ? 't-warn' : '' })) },
      { k: '各區場次變化', vals: sims.map((x) => ({ t: x.sim.areaDiffs.length ? x.sim.areaDiffs.map((d) => `${d.area} ${d.diff > 0 ? '＋' + d.diff : d.diff}`).join('、') : '不變', c: '' })) },
      { k: '各區負擔（人均需求）', vals: sims.map((x) => {
        const L = x.sim.loadDiffs || [];
        const f = (n) => (n == null ? '—' : n.toFixed(2));
        const n1 = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
        const hw = (d) => [d.hol0 !== d.hol2 ? `假日 ${n1(d.hol0)}→${n1(d.hol2)}` : '', d.wk0 !== d.wk2 ? `平日 ${n1(d.wk0)}→${n1(d.wk2)}` : ''].filter(Boolean).join('、');
        const t = L.length ? L.map((d) => (d.perCap0 != null && d.perCap0 !== d.perCap2
          ? `${d.area} ${f(d.perCap0)}→${f(d.perCap2)}（比 ${f(d.ratio0)}→${f(d.ratio2)}）`
          : `${d.area} ${hw(d) || '不變'}`)).join('；') : '不變';
        return { t, c: L.some((d) => d.ratio2 != null && d.ratio2 >= 1.25 && d.ratio2 > d.ratio0) ? 't-warn' : '' };
      }) },
      { k: '受影響的人', vals: sims.map((x) => ({ t: x.sim.peopleText, c: '' })) },
      { k: '外部已定案', vals: sims.map((x) => ({ t: x.sim.lockedText, c: x.sim.lockedText.includes('解除') ? 't-warn' : '' })) },
      { k: '需要誰同意', vals: sims.map((x) => ({ t: x.sim.needReplyText, c: '' })) }
    ];

    const bestIdx = sims.reduce((best, cur, idx) => (cur.sim.nextConflicts - cur.sim.baseConflicts + cur.sim.addedViols.length < sims[best].sim.nextConflicts - sims[best].sim.baseConflicts + sims[best].sim.addedViols.length ? idx : best), 0);
    const stBadge = pr.status === 'resolved' ? tag('ok', `已決議（${pr.chosen || ''}）`) : tag('wn', pr.status === 'waiting' ? '等待回覆' : '討論中');

    // 新增做法表單
    const addOptForm = UI.pAddOptOpen ? `<section class="card warnbox" style="margin-top:10px">
      <div class="row-h"><h3>新增比較做法</h3><button class="btn sm" data-act="toggle-add-opt">收合</button></div>
      <label>做法名稱<input id="optLabel" type="text" placeholder="例：改由三重承接"></label>
      <div class="grid2">
        <label>目標勤務格<select id="optSlot">${(pr.slotIds || []).map((id) => M.byId[id]).filter(Boolean).concat(M.slots.filter((s) => !s.cancel).slice(0, 40)).map((s) => `<option value="${s.id}">${esc(dLabel(s))}${esc(s.area)} ${esc(s.cat)}</option>`).join('')}</select></label>
        <label>改派負責區<select id="optArea"><option value="">不改區</option>${WORK_AREAS.map((a) => `<option>${a}</option>`).join('')}</select></label>
      </div>
      <div class="grid2">
        <label>改日期<input id="optDate" type="date"></label>
        <label>改需求人數<input id="optNeed" type="number" min="1" max="50"></label>
      </div>
      <button class="btn blue" data-act="add-prop-opt" data-pid="${esc(pr.id)}">加入並重新試算</button>
    </section>` : '';

    // 相關區表態
    const replyAreas = uniq([pr.area].concat(pr.targetAreas || [], ['排班總召']).filter((a) => AREAS.includes(a) || a === '排班總召'));
    const votes = pr.votes || {};
    // #25(b)：表態代表全區，只有該區區長（總召代表「排班總召」）
    const myVoteArea = isAdmin() ? '排班總召' : replyAreas.find((a) => AREAS.includes(a) && isLead(a));
    const talks = Object.entries(pr.talk || {}).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));

    return `${wsHeader('P', 'b2', AREAS.includes(pr.area) ? pr.area : defaultArea())}<main class="wide-main">
      <div class="tabs-pill">
        ${allProps.map((p) => `<a href="#/p/${encodeURIComponent(p.id)}" class="${p.id === pr.id ? 'on' : ''}">${esc(p.id)} ${esc(p.title.slice(0, 14))}${p.title.length > 14 ? '…' : ''}</a>`).join('')}
        <a href="#/p/new" style="border-color:var(--info);color:var(--info)">＋ 提出新調整</a>
      </div>

      <div class="page-head">
        <div>
          <div class="muted small">${AREAS.includes(pr.area) ? `<a href="#/b1/${pr.area}">本區首頁</a>` : `<a href="#/">總覽</a>`} ／ 提案 ${esc(pr.id)}</div>
          <h1>${esc(pr.title)}</h1>
          <p class="muted" style="margin:4px 0 0">${esc(pr.byName)}提出 · 類型「${esc(pr.type)}」· 原因：${esc(pr.reason)}</p>
        </div>
        <div class="acts">${stBadge}${pr.status === 'resolved' && isAdmin() && !isPublished() ? `<button class="btn sm" data-act="revert-prop" data-pid="${esc(pr.id)}">還原決議前版本</button>` : ''}</div>
      </div>

      ${flowHtml}

      <div class="split-grid">
        <div class="split-main">
          <div class="table-wrap"><div class="cmp-table">
            <div class="table-head-pad">
              <div><h2>影響試算：${opts.length} 個做法並排</h2><div class="muted small">數字是套用後和目前草案的即時試算差異。</div></div>
              <button class="btn sm" data-act="toggle-add-opt">＋ 新增做法進來比較</button>
            </div>
            <div class="cmp-grid hd" style="${colStyle}"><div>指標</div>${opts.map((o) => `<div>${esc(o.label)}</div>`).join('')}</div>
            ${cmpRows.map((r) => `<div class="cmp-grid" style="${colStyle}"><b>${esc(r.k)}</b>${r.vals.map((v) => `<div class="${v.c}">${esc(v.t)}</div>`).join('')}</div>`).join('')}
            <div class="cmp-grid" style="${colStyle}">
              <div class="muted small">系統建議：${opts[bestIdx] ? esc(opts[bestIdx].label) : '—'}（衝突最少／無新增違規）</div>
              ${opts.map((o, idx) => `<div>${pr.status === 'resolved'
                ? (pr.chosen === o.id ? tag('ok', '已採用') : tag('no', '未採用'))
                : isAdmin() ? (isPublished() ? '<span class="muted small">已定版</span>' : `<button class="btn sm ${idx === bestIdx ? 'blue' : ''}" data-act="adopt-prop" data-pid="${esc(pr.id)}" data-oid="${esc(o.id)}">採用${esc(o.label.slice(0, 1))}</button>`) : ''}</div>`).join('')}
            </div>
          </div></div>
          ${addOptForm}

          <section class="card"><h2>討論</h2>
            ${talks.map(([, m]) => `<div class="talk-row"><div><b class="c-${esc(m.area)}">${esc(m.who)}</b><div class="muted small">${ago(m.at)}</div></div><div>${esc(m.text)}</div></div>`).join('') || '<div class="muted small">尚無留言</div>'}
            ${me() ? `<label>留言<textarea id="propTalkTxt" rows="2" placeholder="寫下本區的情況或條件"></textarea></label>
              <button class="btn blue-out" style="align-self:flex-start" data-act="send-talk" data-pid="${esc(pr.id)}">送出留言</button>` : '<div class="muted small">登入後可留言</div>'}
          </section>
        </div>

        <aside class="split-side">
          <section class="card"><h2>相關區的回覆</h2>
            ${replyAreas.map((a) => {
              const v = votes[a];
              const cls = !v || v.st.includes('待') ? 'wn' : 'ok';
              return `<div class="row-h" style="padding-top:8px;border-top:1px solid var(--sunk)">
                <div><b class="c-${a}">${esc(a)}</b> <span class="muted small">${a === pr.area ? '提案區' : ''}</span></div>
                ${tag(cls, v ? v.st : '待回覆')}</div>`;
            }).join('')}
            ${myVoteArea ? `<div style="padding-top:10px;border-top:1px solid var(--sunk);display:flex;flex-direction:column;gap:6px">
              <div class="small muted">代表「<b>${esc(myVoteArea)}</b>」表態：</div>
              <div class="acts">${opts.map((o) => {
                const stTxt = `同意${o.label.slice(0, 1)}`;
                const on = votes[myVoteArea] && votes[myVoteArea].st === stTxt;
                return `<button class="btn sm ${on ? 'blue' : ''}" data-act="vote-prop" data-pid="${esc(pr.id)}" data-area="${esc(myVoteArea)}" data-st="${esc(stTxt)}">${esc(stTxt)}</button>`;
              }).join('')}
                <button class="btn sm ${votes[myVoteArea] && votes[myVoteArea].st === '待討論' ? 'warn' : ''}" data-act="vote-prop" data-pid="${esc(pr.id)}" data-area="${esc(myVoteArea)}" data-st="待討論">待討論</button></div>
            </div>` : ''}
            <div class="muted small">只有受影響的區需要回覆。</div>
          </section>

          <section class="card"><h2>決議後系統會做的事</h2>
            <ol style="margin:0;padding-left:20px;font-size:14px;display:flex;flex-direction:column;gap:6px">
              <li>更新總表與組別輪替，重新檢查全部規則</li>
              <li>草案版號加一，保留決議前的版本可比較、可還原</li>
              <li>通知相關區區長；定版後才通知到個人</li>
              <li>在議題清單與改動紀錄記下結論與日期</li>
            </ol>
          </section>

          <section class="card"><h2>可以提出的調整</h2>
            ${PROPOSAL_TYPES.map(([t, d]) => `<div class="kv-row"><b>${t}</b><span class="muted">${d}</span></div>`).join('')}
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- 人員抽屜：全年排班與狀態 ---------------- */
  function personSheet(pid) {
    const p = M.pById[pid]; if (!p) return '';
    const L = M.personSlots[pid] || [], iss = byPid[pid] || [], occ = E.occasions(L).length, cap = E.capOf(M, p);
    const o = (D().pov || {})[pid] || {};
    const editable = can(p.a, 'pov');
    return `<div class="sheet-bg" data-act="close-person"></div><aside class="sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label="${esc(p.n)} 的全年排班">
      <div class="mem-h"><h2>${esc(p.n)}</h2><span class="muted">${esc(p.a)}${roleOf(p) ? ' · ' + esc(roleOf(p)) : ''}</span><button class="btn sm" data-act="close-person">關閉</button></div>
      <div class="muted small">全年 ${occ} 次（上限 ${cap.max}）· 已排 ${L.length} 筆${p.off && (can(p.a, 'pov') || isAdmin()) ? ' · 暫停排班' : ''}</div>
      ${issueLines(iss, 6)}
      <h3>全年排班</h3>${otherWork(pid, [], null) || '<div class="empty">還沒有排班</div>'}
      ${editable ? `<h3>人員狀態（只有排班人員看得到）</h3>
        <label class="ck"><input id="povOff" type="checkbox" data-act-change="pov-off" data-pid="${+pid}" ${o.off ? 'checked' : ''}> 暫停排班</label>
        <label>個人全年上限（次）<input id="povCap" type="number" min="0" max="30" value="${esc(o.cap || '')}" data-act-change="pov" data-pid="${+pid}" data-k="cap"></label>
        <label>不方便的月份（用空白分開，例：6 7 8）<input id="povMonths" type="text" value="${esc((o.months || []).join(' '))}" data-act-change="pov-months" data-pid="${+pid}"></label>
        <label>備註<input id="povNote" type="text" value="${esc(o.note || '')}" data-act-change="pov" data-pid="${+pid}" data-k="note"></label>` : ''}
    </aside>`;
  }

  function lastYearPickSheet(sid) {
    const s = M && M.byId[sid]; if (!s) return '';
    const groups = jzPrevGroups(s);
    const items = groups.map((g, i) => {
      let hardCnt = 0;
      const names = g.pids.map((id) => {
        const p = M.pById[id]; if (!p) return '';
        const ev = evalInSlot(p, s);
        if (ev.hard.length) hardCnt++;
        return esc(p.n) + (p.zr ? `（${esc(p.zr)}）` : '') + (ev.hard.length ? '⚠' : '');
      }).filter(Boolean).join('、');
      const statusTag = g.overlap === 0
        ? tag('ok', '推薦・本年未排')
        : tag('warn', `與 ${g.usedDates.join('、')} 重疊 ${g.overlap} 人`);
      const hardTag = hardCnt ? ' ' + tag('bad', `${hardCnt} 人有規則衝突`) : '';
      return `<div class="cand-row">
        <div>
          <div class="cand-name">${esc(g.d)}（${esc(g.cat)}） ${statusTag}${hardTag}</div>
          <div class="muted small">${names}</div>
        </div>
        <button class="btn pri sm" data-act="pick-ly-group" data-sid="${sid}" data-idx="${i}">帶入這組</button>
      </div>`;
    }).join('');
    return `<div class="sheet-bg" data-act="close-ly"></div><aside class="sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label="選擇去年合作組合">
      <div class="mem-h"><h2>選擇去年合作組合</h2><span class="muted">${esc(s.area)} · ${esc(s.cat)}（${E.fmtD(s.d)}）</span><button class="btn sm" data-act="close-ly">關閉</button></div>
      <div class="muted small">共找到 ${groups.length} 組去年組合；已優先將本年度尚未排過的組合排在前面。</div>
      <div class="cand-list" style="margin-top:10px">${items}</div>
      <div class="row" style="margin-top:12px"><button class="btn" data-act="pick-ly-group" data-sid="${sid}" data-idx="-1">自動挑選（避開本年已排）</button></div>
    </aside>`;
  }

  /* ---------------- 控制台整合上下文 & 路由與繪製 ---------------- */
  function consoleCtx() {
    return {
      store, E, BASE,
      get M() { return M; },
      get ISS() { return ISS; },
      D, me, isAdmin, isLead, can, memberOf, myAreas, defaultArea,
      draftVer, nextDraftVer,
      wsHeader, topbar, accountBtn, tag, esc, ago, dLabel, slotName, roleOf, cnt, isClash,
      toast, need, logOp, touchArea, stamp, addPerson, removePerson, confirmPre,
      evalInSlot, evalInGroup, areaStats, areaMetrics, allAreaLoadRank, render,
      // 階段 1 共用工具
      isPreFor, canConfirmPre, isPublished, mkUndo, canPath, kindOfGroup, normAcks, autoApproveBind, afterCount
    };
  }
  // 給 console.js 與後續階段使用的共用介面（同一組函式，與 consoleCtx() 相同來源）
  window.TDApp = {
    esc, isPreFor, canConfirmPre, confirmPre, logOp, mkUndo, isPublished, canPath, canUndo, normUndo, normAcks,
    kindOfGroup, isAdmin, isLead, can, memberOf, autoApproveBind, adminSyncMap, sameVal, afterCount,
    ctx: () => consoleCtx()
  };

  let lastRoute = '';
  function route() {
    const raw = location.hash.replace(/^#\/?/, '');
    const qIdx = raw.indexOf('?');
    let pathPart = '';
    try { pathPart = decodeURIComponent(qIdx >= 0 ? raw.slice(0, qIdx) : raw); } catch (e) { pathPart = ''; } // #23：錯誤的編碼退回首頁
    const qs = qIdx >= 0 ? raw.slice(qIdx + 1) : '';
    const [v, ...rest] = (pathPart || '').split('/');
    return { v: v || '', arg: rest.join('/') + (qs ? '?' + qs : ''), pathArg: rest.join('/') };
  }
  /* UI-01：重繪時保留焦點、select／輸入框的值、details 開合；他人 presence 心跳不重繪也不重算 */
  function ctlKey(el) {
    if (!el || !el.tagName) return '';
    if (el.id) return '#' + el.id;
    if (el.tagName === 'SUMMARY') {
      const pd = el.parentElement, sec = pd && pd.dataset && pd.dataset.sec;
      return sec ? 'sec:' + sec : 'sum:' + (el.textContent || '').trim().slice(0, 40);
    }
    const ds = el.dataset || {}, ks = Object.keys(ds).sort();
    if (!ks.length) return el.tagName === 'A' && el.getAttribute('href') ? 'a:' + el.getAttribute('href') : '';
    return el.tagName + ':' + ks.map((k) => k + '=' + ds[k]).join('&');
  }
  function findByKey(root, key) {
    if (!key) return null;
    if (key[0] === '#') return document.getElementById(key.slice(1));
    for (const el of root.querySelectorAll('button,select,input,textarea,a,summary,[role="button"][tabindex]')) if (ctlKey(el) === key) return el;
    return null;
  }
  function presSig(r) {
    let areas;
    if (['a', 't', 'b1'].includes(r.v)) areas = [r.pathArg];
    else if (r.v === 'g' && gmOf(r.pathArg)) areas = [gmOf(r.pathArg).area];
    else if (r.v === 's' && M && M.byId[r.pathArg]) areas = [M.byId[r.pathArg].area];
    else if (r.v === 'review') areas = WORK_AREAS;
    else return '';
    const now = Date.now(), out = [];
    for (const a of areas) { const P = (D().presence || {})[a] || {}; for (const u in P) if (P[u] && now - P[u].at < 120000) out.push([a, u, P[u].where || '', P[u].name || ''].join('/')); }
    return out.sort().join(',');
  }
  let lastViewSig = '', lastSheet = '', sheetTrigger = '';
  const selectFocused = () => { const a = document.activeElement; return !!(a && a.tagName === 'SELECT' && a.closest && a.closest('#app')); };
  // 資料庫／連線狀態有變時才重繪；只有 presence 心跳（在線名單沒變）就什麼都不做
  function onStoreChange() {
    if (!store.ready || !lastViewSig) return render();
    if (dataSigs().view + '|' + presSig(route()) === lastViewSig) return;
    if (isComposing || selectFocused()) { pendingRender = true; return; } // 正在輸入或操作下拉選單：等操作完再補繪
    render();
  }
  function flushDeferred() { if (pendingRender && !isComposing) render(); }
  function render() {
    if (isComposing) { pendingRender = true; return; }
    pendingRender = false;
    const appEl = $('#app');
    if (!store.ready) { appEl.innerHTML = '<div class="empty">載入中…</div>'; return; }
    const sg = dataSigs();
    recompute(false, sg);
    ensureAdminNodes();
    const r = route(), key = r.v + '/' + r.pathArg;
    const routeChanged = key !== lastRoute;
    if (routeChanged) {
      UI.q = ''; UI.out = false; UI.outQ = ''; UI.showAll = false; UI.filter = '全部';
      UI.apptQ = ''; UI.b6Mode = ''; UI.b1NomOpen = false; UI.pAddOptOpen = false; UI.newPerOpen = false;
      UI.b3CalYm = ''; UI.b3FocusId = ''; UI.lyPick = null;
      finderCtx = null; apptArea = '';
      lastRoute = key; window.scrollTo(0, 0); onEnter(r);
    }
    const C = window.TDConsole;
    appEl.className = '';
    const ae = document.activeElement, focusKey = ae && appEl.contains(ae) ? ctlKey(ae) : '';
    const draftVals = {}, detailsState = [], scrollState = [];
    const SCROLL_SEL = '.table-scroll-y, .table-wrap, .inspector, .sheet, .ws-nav, .sub-nav';
    if (!routeChanged && appEl.querySelectorAll) {
      for (const el of appEl.querySelectorAll('input[id], textarea[id], select[id]')) {
        if (el.type === 'checkbox' || el.type === 'radio' || (el.dataset && el.dataset.input)) continue;
        if (el.dataset && el.dataset.actChange && el !== ae) continue;
        draftVals[el.id] = el.value;
      }
      for (const dt of appEl.querySelectorAll('details')) { const sm = dt.querySelector('summary'); detailsState.push([sm ? (sm.textContent || '').trim().slice(0, 40) : '', dt.open, (dt.dataset && dt.dataset.sec) || '']); }
      const seenScroll = {};
      for (const el of appEl.querySelectorAll(SCROLL_SEL)) {
        const k = (el.getAttribute('aria-label') || '') + '|' + el.className;
        const idx = seenScroll[k] || 0;
        seenScroll[k] = idx + 1;
        if (el.scrollTop || el.scrollLeft) scrollState.push([k, idx, el.scrollTop, el.scrollLeft]);
      }
    }
    let pos = null, posEnd = null;
    try { if (ae && typeof ae.selectionStart === 'number') { pos = ae.selectionStart; posEnd = ae.selectionEnd; } } catch (e) { }
    const sc = window.scrollY;
    let html;
    if (C && Array.isArray(C.ROUTES) && C.ROUTES.includes(r.v)) html = C.renderRoute(r.v, r.arg, consoleCtx());
    else if (r.v === 'login' || r.v === 'bind') html = vLogin();
    else if (r.v === 'a' && WORK_AREAS.includes(r.pathArg)) html = vArea(r.pathArg);
    else if (r.v === 'b1') html = vAreaLead(r.pathArg);
    else if (r.v === 'p') html = vProposal(r.arg);
    else if (r.v === 'g') html = vGroup(r.pathArg);
    else if (r.v === 's') html = vSlot(r.pathArg);
    else if (r.v === 't' && WORK_AREAS.includes(r.pathArg)) html = vTeam(r.pathArg);
    else if (r.v === 'review') html = vReview();
    else html = vHome();
    const sheetNow = UI.person ? 'p' + UI.person : (UI.lyPick ? 'ly' + UI.lyPick : (UI.acctOpen && !['login', 'bind'].includes(r.v) && me() ? 'acct' : ''));
    appEl.innerHTML = html + globalBottomNav(r) + (UI.person ? personSheet(UI.person) : '') + (UI.lyPick ? lastYearPickSheet(UI.lyPick) : '') + (UI.acctOpen && !['login', 'bind'].includes(r.v) ? accountSheet() : '') + `<div id="toast" role="status" hidden></div>` + (store.error || store.notice ? `<div class="errbar">${esc([store.error, store.notice].filter(Boolean).join('　'))}</div>` : '');
    for (const id in draftVals) {
      const el = document.getElementById(id);
      if (!el || el.value === draftVals[id]) continue;
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === draftVals[id])) continue; // 選項已不存在就不硬套
      el.value = draftVals[id];
    }
    if (detailsState.length) {
      const dts = appEl.querySelectorAll('details');
      // 有 data-sec 的區段（B3）以穩定的區段代號還原；其餘仍以順序＋摘要文字比對
      const bySec = {};
      for (const dt of dts) if (dt.dataset && dt.dataset.sec) bySec[dt.dataset.sec] = dt;
      detailsState.forEach(([t, open, sec], i) => {
        if (sec) { if (bySec[sec]) bySec[sec].open = open; return; }
        const dt = dts[i]; const sm = dt && dt.querySelector('summary');
        if (dt && !(dt.dataset && dt.dataset.sec) && sm && (sm.textContent || '').trim().slice(0, 40) === t) dt.open = open;
      });
    }
    if (scrollState.length && appEl.querySelectorAll) {
      const buckets = {};
      for (const el of appEl.querySelectorAll(SCROLL_SEL)) {
        const k = (el.getAttribute('aria-label') || '') + '|' + el.className;
        (buckets[k] = buckets[k] || []).push(el);
      }
      for (const [k, idx, st, sl] of scrollState) {
        const el = buckets[k] && buckets[k][idx];
        if (el) { el.scrollTop = st; el.scrollLeft = sl; }
      }
    }
    // UI-03：抽屜是模態對話框 — 背景 inert、開啟時焦點進抽屜、關閉後焦點回到觸發鈕
    const sheetEl = appEl.querySelector('.sheet');
    for (const ch of appEl.children) {
      if (sheetEl && ch !== sheetEl && !ch.classList.contains('sheet-bg') && ch.id !== 'toast' && !ch.classList.contains('errbar')) ch.setAttribute('inert', '');
    }
    document.body.classList.toggle('sheet-open', !!sheetEl);
    const sheetOpened = !!sheetEl && sheetNow !== lastSheet, sheetClosed = !sheetEl && !!lastSheet;
    lastSheet = sheetEl ? sheetNow : '';
    if (sheetOpened) { try { sheetEl.focus({ preventScroll: true }); } catch (e) { } }
    else if (sheetClosed) { const tr = findByKey(appEl, sheetTrigger); if (tr) { try { tr.focus({ preventScroll: true }); } catch (e) { } } sheetTrigger = ''; }
    else if (focusKey) {
      const el = findByKey(appEl, focusKey);
      if (el && !el.disabled) {
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
        try { if (pos != null && el.setSelectionRange) el.setSelectionRange(pos, posEnd != null ? posEnd : pos); } catch (e) { }
      }
    }
    window.scrollTo(0, sc);
    lastViewSig = sg.view + '|' + presSig(r);
  }
  function onEnter(r) {
    let area = '', where = '';
    if (r.v === 'a' || r.v === 't' || r.v === 'b1') area = r.pathArg;
    else if (r.v === 'g' && gmOf(r.pathArg)) { area = gmOf(r.pathArg).area; where = 'g/' + r.pathArg; }
    else if (r.v === 's' && M && M.byId[r.pathArg]) { area = M.byId[r.pathArg].area; where = 's/' + r.pathArg; }
    beat(memberOf(area) || isAdmin() ? area : '', where);
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act]'); if (!t) return;
    const a = t.dataset.act, d = t.dataset;
    if (window.TDConsole && typeof window.TDConsole.handleClick === 'function' && window.TDConsole.handleClick(a, d, ev, consoleCtx())) return;
    if (a === 'toggle-large') { toggleLargeMode(); return; }
    if (a === 'seed') seedDefaults().then(() => toast('已帶入 115 年組別名單與初始提案'));
    else if (a === 'local-in') store.signIn(JSON.parse(d.who)).then(() => { location.hash = '#/'; });
    else if (a === 'in') store.signIn(d.kind).catch((e) => toast('登入沒有完成：' + (e.code || e.message)));
    else if (a === 'signout') {
      if (store.pending && !confirm(`還有 ${store.pending} 筆改動尚未送到雲端，登出後要等這個帳號再登入才會送出。確定登出？`)) return;
      UI.acctOpen = false; beat('', ''); store.signOut();
    }
    else if (a === 'open-acct') { if (!lastSheet) sheetTrigger = ctlKey(t); UI.acctOpen = true; render(); }
    else if (a === 'close-acct') { UI.acctOpen = false; render(); }
    else if (a === 'toggle-auto-bind') setAutoApproveBind(!autoApproveBind());
    else if (a === 'bind-me') bindPersonToMe(+d.pid);
    else if (a === 'apply-new-person') {
      const nm = $('#newPerName').value, ar = $('#newPerArea').value, sx = $('#newPerSx').value, nt = $('#newPerNote').value;
      if (String(nm || '').trim()) { $('#newPerName').value = ''; $('#newPerNote').value = ''; }
      applyNewPerson(nm, ar, sx, nt);
    }
    else if (a === 'add-fam') toggleFamily(+d.pid, true);
    else if (a === 'rm-fam') toggleFamily(+d.pid, false);
    else if (a === 'approve-bind') approveBind(d.uid, d.ok === '1');
    else if (a === 'filter') { UI.filter = d.v; UI.b3FocusId = ''; render(); }
    else if (a === 'b3-mode') { UI.b3Mode = d.v === 'date' ? 'date' : 'group'; UI.b3FocusId = ''; render(); }
    else if (a === 'b3-cal-ym') { UI.b3CalYm = d.v || ''; UI.b3FocusId = ''; render(); }
    else if (a === 'b3-cal-dot') {
      const targetId = UI.b3Mode === 'date' ? ('b3-date-' + d.sid) : (d.gk ? ('b3-grp-' + d.gk) : ('b3-slot-' + d.sid));
      UI.b3FocusId = targetId;
      for (const prev of document.querySelectorAll('.b3-focus-pulse')) if (prev.id !== targetId) prev.classList.remove('b3-focus-pulse');
      const el = document.getElementById(targetId);
      if (el) {
        const dt = el.closest('details');
        if (dt && !dt.open) dt.open = true;
        el.classList.remove('b3-focus-pulse');
        void el.offsetWidth;
        el.classList.add('b3-focus-pulse');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        try { el.focus({ preventScroll: true }); } catch (e) { }
      }
    }
    else if (a === 'more') { UI.showAll = true; render(); }
    else if (a === 'out') { UI.out = d.v === '1'; UI.showAll = false; render(); const el = document.getElementById(UI.out ? 'outQ' : 'q'); if (el) el.focus(); }
    else if (a === 'toggle-new-per') { UI.newPerOpen = !UI.newPerOpen; render(); if (UI.newPerOpen) { const el = $('#fNewPerName'); if (el) el.focus(); } }
    else if (a === 'create-roster-person') createRosterPersonFromFinder(d);
    else if (a === 'person') { if (!lastSheet) sheetTrigger = ctlKey(t); UI.person = +d.pid; render(); }
    else if (a === 'close-person') { UI.person = null; render(); }
    else if (a === 'add' || a === 'rm') {
      // 區以資料為準（不信任按鈕上的 data-area）
      const owner = d.kind === 'groups' ? gmOf(d.key) : d.kind === 'assign' ? M.byId[d.key] : null;
      if (!owner || !(+d.pid > 0) || !M.pById[+d.pid] && a === 'add') return;
      if (!need(can(owner.area, d.kind === 'groups' ? kindOfGroup(d.key) : 'jz'))) return;
      if (a === 'add') addPerson(d.kind, d.key, +d.pid, owner.area, d.label); else removePerson(d.kind, d.key, +d.pid, owner.area, d.label);
    }
    else if (a === 'add-batch') {
      const owner = d.kind === 'groups' ? gmOf(d.key) : d.kind === 'assign' ? M.byId[d.key] : null;
      if (!owner || !finderCtx) return;
      if (d.kind === 'assign' && owner.cancel) return toast('這一格已取消，不能再排人');
      if (!need(can(owner.area, d.kind === 'groups' ? kindOfGroup(d.key) : 'jz'))) return;
      const plan = batchPlan(finderCtx);
      const list = plan.add.filter((p) => p && M.pById[p.id] && !finderCtx.inIds.has(p.id));
      if (!list.length) return toast(plan.rejects.length ? '沒有完全相符的人可加入（請看下方說明）' : '沒有可加入的人員');
      if (list.length > 100) return toast('一次最多批次加入 100 人，請分批');
      const pre = isPreFor(owner.area);
      const hardN = list.filter((p) => { try { return finderCtx.evalFn(p).hard.length > 0; } catch (e) { return false; } }).length;
      const up = {};
      for (const p of list) up[`${d.kind}/${d.key}/${p.id}`] = stamp(pre ? { pre: true } : null);
      const lbl = d.label || (d.kind === 'groups' ? owner.name : slotName(owner));
      const rejN = plan.rejects.length;
      if (UI.out) UI.outQ = plan.rejects.map((r) => r.term).join('、'); else UI.q = plan.rejects.map((r) => r.term).join('、'); // 沒加入的詞留在搜尋框
      store.update(Object.assign(up, logOp(owner.area, `${lbl} 批次${pre ? '預排' : '加入'} ${list.length} 人（完全相符${hardN ? `，含違規 ${hardN} 人` : ''}${rejN ? `；未加入 ${rejN} 筆` : ''}）`, mkUndo(up)), touchArea(owner.area)));
      toast((pre ? `已批次預排 ${list.length} 人，等 ${owner.area} 區長確認` : `已批次加入 ${list.length} 人`) + (hardN ? `（${hardN} 人有違規，已標示）` : '') + (rejN ? `；${rejN} 筆未加入，留在搜尋框` : ''));
    }
    else if (a === 'pre-ok') { const s0 = d.kind === 'groups' ? gmOf(d.key) : M.byId[d.key]; if (s0 && (d.kind === 'groups' || d.kind === 'assign')) confirmPre(d.kind, d.key, +d.pid, s0.area, d.label); }
    else if (a === 'pre-all-ok') {
      const s0 = M.byId[d.sid]; if (!s0) return;
      if (!need(canConfirmPre(s0.area), '預排必須由該區區長確認')) return;
      const up = {};
      for (const pid in (D().assign || {})[d.sid] || {}) {
        const r = D().assign[d.sid][pid];
        if (RE_PID.test(pid) && r && r.pre) { const nx = Object.assign({}, r); delete nx.pre; nx.okBy = String(me().name || '').slice(0, 40); nx.okAt = Date.now(); up[`assign/${d.sid}/${pid}`] = nx; }
      }
      if (!Object.keys(up).length) return;
      store.update(Object.assign(up, logOp(s0.area, `${slotName(s0)} 確認全部預排`))); toast('已確認全部預排');
    }
    else if (a === 'pre-all-rm') {
      const s0 = M.byId[d.sid]; if (!s0) return;
      if (!need(isLead(s0.area) || isAdmin())) return;
      const up = {};
      for (const pid in (D().assign || {})[d.sid] || {}) {
        const r = D().assign[d.sid][pid];
        if (RE_PID.test(pid) && r && r.pre) up[`assign/${d.sid}/${pid}`] = null;
      }
      if (!Object.keys(up).length) return;
      store.update(Object.assign(up, logOp(s0.area, `${slotName(s0)} 移出全部預排`, mkUndo(up)), touchArea(s0.area))); toast('已移出預排人員');
    }
    else if (a === 'last-year') bringLastYearGroup(d.gk);
    else if (a === 'auto-posts') autoAssignRitualPosts(d.gk);
    else if (a === 'b6-mode') { UI.b6Mode = UI.b6Mode === d.v ? '' : d.v; render(); }
    else if (a === 'set-lead') {
      const gm = gmOf(d.gk), p = M.pById[+d.pid];
      if (!gm || !p || !need(can(gm.area, kindOfGroup(d.gk)))) return;
      const up = { [`groupMeta/${d.gk}/leadPid`]: +d.pid };
      store.update(Object.assign(up, logOp(gm.area, `${gm.name} 改由 ${p.n} 帶隊`, mkUndo(up)), touchArea(gm.area)));
      UI.b6Mode = ''; toast(`已設定 ${p.n} 帶隊`);
    }
    else if (a === 'move-mem') moveGroupMember(d.gk, $('#mvToGk').value, $('#mvPid').value);
    else if (a === 'slot-clear-all') {
      const s0 = M.byId[d.sid]; if (!s0 || !need(can(s0.area, 'jz'))) return;
      const up = {}; for (const pid in (D().assign || {})[d.sid] || {}) if (RE_PID.test(pid)) up[`assign/${d.sid}/${pid}`] = null;
      if (!Object.keys(up).length) return;
      store.update(Object.assign(up, logOp(s0.area, `${slotName(s0)}（已取消）移出全部殘留人員`, mkUndo(up)), touchArea(s0.area))); toast('已移出殘留人員');
    }
    else if (a === 'slot-last-year') { if (!lastSheet) sheetTrigger = ctlKey(t); bringLastYearSlot(d.sid); }
    else if (a === 'pick-ly-group') applyLastYearSlot(d.sid, +d.idx);
    else if (a === 'close-ly') { UI.lyPick = null; render(); }
    else if (a === 'slot-autofill') autoFillSlot(d.sid);
    else if (a === 'coord') {
      if (!me()) return toast('請先登入');
      if (!WORK_AREAS.includes(d.area) || !(+d.pid > 0)) return;
      const id = store.pushId();
      const label = String(d.label || '').slice(0, 120), msg = String(d.msg || '').slice(0, 300);
      store.update(Object.assign({ ['coord/' + id]: { area: d.area, pid: +d.pid, label, msg, uid: me().uid, name: String(me().name || '').slice(0, 40), at: Date.now(), st: 'open' } }, logOp(d.area, `${label} 請總召協調：${msg}`)));
      toast('已送給總召');
    }
    else if (a === 'coord-done') { if (need(isAdmin()) && RE_SID.test(d.id || '')) store.update({ [`coord/${d.id}/st`]: 'done', [`coord/${d.id}/doneBy`]: String(me().name || '').slice(0, 40) }); }
    // acks 只存 {st, by, at}，訊息由 engine 即時產生（P-02）
    else if (a === 'ack-issue') { if (need(isAdmin()) && RE_ACK.test(d.key || '')) { store.set(`acks/${d.key}`, { st: '接受例外', by: String(me().name || '').slice(0, 40), at: Date.now() }); toast('已標記為接受例外'); } }
    else if (a === 'unack-issue') {
      if (!need(isAdmin()) || !RE_ACK.test(d.key || '')) return;
      // 舊資料的鍵含「.」：一併刪除
      const up = { [`acks/${d.key}`]: null };
      for (const k in D().acks || {}) if (k !== d.key && E.normAckKey(k) === d.key && !/[.#$\[\]\/]/.test(k)) up['acks/' + k] = null;
      store.update(up); toast('已撤銷例外');
    }
    else if (a === 'clear-after') { if (need(isAdmin())) { store.update({ [`areas/${d.area}/after`]: 0, [`areas/${d.area}/changes`]: null }); toast(`已標記 ${d.area} 送出後變更為已看`); } }
    else if (a === 'toggle-a6-remind') { UI.a6RemindOpen = !UI.a6RemindOpen; render(); }
    else if (a === 'toggle-a6-pick') { UI.a6PickAreaOpen = !UI.a6PickAreaOpen; render(); }
    else if (a === 'copy-remind') { if (navigator.clipboard) navigator.clipboard.writeText(d.text).catch(() => {}); toast('已複製提醒訊息'); }
    else if (a === 'open-nom') { UI.b1NomOpen = true; render(); }
    else if (a === 'close-nom') { UI.b1NomOpen = false; render(); }
    else if (a === 'save-nom') {
      if (!need(isLead(d.area) || isAdmin())) return;
      if (!AREAS.includes(d.area)) return;
      store.update(Object.assign({ [`nominations/${d.area}`]: { leads: $('#nomLeads').value.trim().slice(0, 500), cooks: $('#nomCooks').value.trim().slice(0, 500), updatedBy: String(me().name || '').slice(0, 40), updatedAt: Date.now() } },
        logOp(d.area, `更新帶隊人與儲備廚師提名`)));
      UI.b1NomOpen = false; toast('已儲存提名');
    }
    else if (a === 'create-prop') createProposalFromForm(d.area);
    else if (a === 'toggle-add-opt') { UI.pAddOptOpen = !UI.pAddOptOpen; render(); }
    else if (a === 'add-prop-opt') addOptionToProposal(d.pid);
    else if (a === 'adopt-prop') adoptProposalOption(d.pid, d.oid);
    else if (a === 'revert-prop') revertProposal(d.pid);
    else if (a === 'send-talk') {
      if (!me()) return toast('請先登入');
      if (!propById(d.pid)) return;
      const el = $('#propTalkTxt');
      const txt = (el && el.value || '').trim().slice(0, 1000); if (!txt) return toast('請輸入留言內容');
      if (el) el.value = '';
      const tid = store.pushId(), area = isAdmin() ? '總召' : (myAreas()[0] || (myBoundPerson() && myBoundPerson().p ? myBoundPerson().p.a : ''));
      store.set(`proposals/${d.pid}/talk/${tid}`, { who: String(me().name || '').slice(0, 40), area: String(area || '').slice(0, 12), at: Date.now(), text: txt });
      toast('已送出留言');
    }
    else if (a === 'vote-prop') {
      if (!me()) return toast('請先登入');
      // #25(b)：只能由該區區長代表全區表態（總召代表「排班總召」）
      const okArea = d.area === '排班總召' ? isAdmin() : (AREAS.includes(d.area) && isLead(d.area));
      if (!need(okArea && propById(d.pid), '您不能代表這一區表態')) return;
      store.set(`proposals/${d.pid}/votes/${d.area}`, { st: String(d.st || '').slice(0, 20), by: String(me().name || '').slice(0, 40), at: Date.now() });
      toast(`已表態：${d.st}`);
    }
    else if (a === 'join') {
      if (!me() || !AREAS.includes(d.area) || memberOf(d.area)) return;
      store.set(`members/${d.area}/${me().uid}`, { name: String(me().name || '').slice(0, 40), role: 'sched', status: 'pending', at: Date.now() }); toast('已送出申請');
    }
    else if (a === 'approve') {
      if (!WORK_AREAS.includes(d.area) || !need(isLead(d.area) || isAdmin())) return;
      const m = memberOf(d.area, d.uid);
      if (!m || m.status !== 'pending') return toast('這筆申請已不存在或已處理');
      if (!confirm(`同意 ${m.name} 成為 ${d.area} 的排班人員？`)) return;
      // 只帶入允許的欄位（R-06：自行申請時塞入的其他欄位不會被帶進正式紀錄）
      const nm = { name: String(m.name || '').slice(0, 40), role: 'sched', status: 'ok', by: String(me().name || '').slice(0, 40), at: Date.now() };
      if (m.scope && typeof m.scope === 'object') nm.scope = Object.fromEntries(KINDS.filter(([k]) => m.scope[k] === true).map(([k]) => [k, true]));
      store.update(Object.assign({ [`members/${d.area}/${d.uid}`]: nm, ['sched/' + d.uid]: true }, logOp(d.area, `同意 ${nm.name} 成為排班人員`)));
    }
    else if (a === 'appoint') {
      if (!WORK_AREAS.includes(d.area) || (d.role !== 'lead' && d.role !== 'sched')) return;
      if (!need(d.role === 'lead' ? isAdmin() : isLead(d.area) || isAdmin())) return;
      const u = (D().users || {})[d.uid];
      if (!u) return toast('找不到這個帳號，請對方先登入一次');
      const nm = String(u.name || '未命名').slice(0, 40);
      if (!confirm(`指定 ${nm} 為 ${d.area} 的${d.role === 'lead' ? '區長' : '排班人員'}？`)) return;
      const up = { [`members/${d.area}/${d.uid}`]: { name: nm, role: d.role, status: 'ok', by: String(me().name || '').slice(0, 40), at: Date.now() }, ['sched/' + d.uid]: true };
      if (d.role === 'lead') up['leads/' + d.uid] = true;
      store.update(Object.assign(up, logOp(d.area, `指定 ${nm} 為${d.role === 'lead' ? '區長' : '排班人員'}`)));
      UI.apptQ = ''; toast('已指定');
    }
    else if (a === 'unmember') {
      const m = memberOf(d.area, d.uid); if (!m || !need(m.role === 'lead' ? isAdmin() : isLead(d.area) || isAdmin())) return;
      if (!confirm(`取消 ${m.name} 在 ${d.area} 的排班權限？`)) return;
      const still = WORK_AREAS.some((x) => x !== d.area && memberOf(x, d.uid) && memberOf(x, d.uid).status === 'ok');
      const stillLead = WORK_AREAS.some((x) => x !== d.area && memberOf(x, d.uid) && memberOf(x, d.uid).status === 'ok' && memberOf(x, d.uid).role === 'lead');
      const up = { [`members/${d.area}/${d.uid}`]: null };
      if (!still) up['sched/' + d.uid] = null;
      if (m.role === 'lead' && !stillLead) up['leads/' + d.uid] = null;
      store.update(Object.assign(up, logOp(d.area, `取消 ${m.name} 的排班權限`)));
    }
    else if (a === 'submit') { if (WORK_AREAS.includes(d.area) && need(isLead(d.area), '只有區長能送出')) { store.update(Object.assign({ ['areas/' + d.area]: { status: 'submitted', by: String(me().name || '').slice(0, 40), at: Date.now(), after: 0 } }, logOp(d.area, '送出給總召確認'))); toast('已送出'); } }
    else if (a === 'unsubmit') { if (WORK_AREAS.includes(d.area) && need(isLead(d.area)) && need(((D().areas || {})[d.area] || {}).status !== 'confirmed', '總召已確認，要修改請聯絡總召退回')) store.update(Object.assign({ ['areas/' + d.area]: { status: 'editing', by: String(me().name || '').slice(0, 40), at: Date.now() } }, logOp(d.area, '收回，繼續排'))); }
    else if (a === 'confirm-area') {
      if (!WORK_AREAS.includes(d.area) || !need(isAdmin())) return;
      if (!confirm(`確認 ${d.area} 的排班？`)) return;
      store.update(Object.assign({ ['areas/' + d.area]: { status: 'confirmed', by: String(me().name || '').slice(0, 40), at: Date.now(), after: 0 } }, logOp(d.area, '總召確認')));
    }
    else if (a === 'return-area') { if (WORK_AREAS.includes(d.area) && need(isAdmin())) { const why = String(prompt('退回的原因（會記在改動紀錄）') || '').slice(0, 200); store.update(Object.assign({ ['areas/' + d.area]: { status: 'editing', by: String(me().name || '').slice(0, 40), at: Date.now() } }, logOp(d.area, '總召退回' + (why ? '：' + why : '')))); } }
    else if (a === 'undo') {
      // #7、#22、R-01：白名單路徑、比對現值、不可重複、依每個路徑檢查權限、先確認
      const l = (D().log || {})[d.id]; if (!l) return;
      if (l.undone) return toast('這一筆已經復原過了');
      if (!need(canUndo(l), '您不能復原這一筆')) return;
      const list = normUndo(l.undo);
      const conflict = list.filter((u) => !sameVal(getPath(D(), u.p), u.a));
      if (conflict.length) return toast(`有 ${conflict.length} 處在這之後已被改過，無法自動復原，請手動調整`);
      const desc = list.map((u) => { const k = u.p.split('/'); const who = RE_PID.test(k[2] || '') && M.pById[+k[2]] ? M.pById[+k[2]].n : ''; const where = k[0] === 'assign' && M.byId[k[1]] ? slotName(M.byId[k[1]]) : gmOf(k[1]) ? gmOf(k[1]).name : k[1]; return `・${where} ${who}：${u.v == null ? '移除' : '恢復'}`; });
      if (!confirm(`復原「${l.msg}」？會改動：\n${desc.slice(0, 20).join('\n')}${desc.length > 20 ? '\n…共 ' + desc.length + ' 處' : ''}`)) return;
      const up = {};
      for (const u of list) up[u.p] = u.v;
      const areas = uniq(list.map((u) => u.info.area));
      store.update(Object.assign(up, { [`log/${d.id}/undone`]: String(me().name || '').slice(0, 40) }, logOp(l.area, `復原「${l.msg}」`), ...areas.map((x) => touchArea(x)))); toast('已復原');
    }
  });

  function updateSearchDom(k, val) {
    if (window.TDConsole && typeof window.TDConsole.handleSearchInput === 'function' && window.TDConsole.handleSearchInput(k, val, consoleCtx())) return;
    if (k === 'q' || k === 'outQ') updateFinderDom();
    else if (k === 'apptQ') { const el = document.getElementById('appt'); if (el && apptArea) el.innerHTML = renderApptHits(apptArea); }
    else if (k === 'bindQ') { const el = document.getElementById('bindHits'); if (el) el.innerHTML = renderBindHits(); }
    else if (k === 'famQ') { const el = document.getElementById('famHits'); if (el) el.innerHTML = renderFamHits(); }
  }

  document.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  document.addEventListener('compositionend', (ev) => {
    isComposing = false;
    const k = ev.target && ev.target.dataset && ev.target.dataset.input;
    if (k) {
      const val = ev.target.value.trim();
      if (k in UI) UI[k] = val;
      UI.showAll = false;
      updateSearchDom(k, val);
    }
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  });
  document.addEventListener('input', (ev) => {
    if (ev.isComposing || isComposing) return;
    const k = ev.target && ev.target.dataset && ev.target.dataset.input;
    if (!k) return;
    const val = ev.target.value.trim();
    if (k in UI) UI[k] = val;
    UI.showAll = false;
    updateSearchDom(k, val);
  });

  document.addEventListener('change', (ev) => { try { onChange(ev); } finally { flushDeferred(); } });
  // 下拉選單失去焦點後，補做操作期間延後的重繪
  document.addEventListener('focusout', (ev) => {
    if (pendingRender && ev.target && ev.target.tagName === 'SELECT') setTimeout(() => { if (pendingRender && !selectFocused()) flushDeferred(); }, 0);
  });
  function onChange(ev) {
    const t = ev.target, a = t.dataset && t.dataset.actChange; if (!a) return;
    const d = t.dataset;
    if (window.TDConsole && typeof window.TDConsole.handleChange === 'function' && window.TDConsole.handleChange(a, t, d, ev, consoleCtx())) return;
    if (a === 'outArea') { UI.outArea = t.value; render(); }
    else if (a === 'a-area') { location.hash = '#/a/' + t.value; }
    else if (a === 'b1-area') { location.hash = '#/b1/' + t.value; }
    else if (a === 'b1-cook') { UI.b1ShowCook = t.checked; render(); }
    else if (a === 'set-post') {
      const gm = gmOf(d.gk); if (!gm || !RITUAL_POST_SET.has(d.post) || !need(can(gm.area, 'lj'))) return render();
      const up = { [`groupMeta/${d.gk}/posts/${d.post}`]: t.value && RE_PID.test(t.value) ? +t.value : null };
      store.update(Object.assign(up, logOp(gm.area, `${gm.name} 設定崗位「${d.post}」`, mkUndo(up)), touchArea(gm.area)));
      toast(`已設定「${d.post}」`);
    }
    else if (a === 'scope') {
      if (!need(isLead(d.area) || isAdmin())) return render();
      const m = memberOf(d.area, d.uid); if (!m || !KINDS.some(([k]) => k === d.k)) return render();
      const sc = Object.fromEntries(KINDS.map(([k]) => [k, m.scope ? m.scope[k] === true : true]));
      sc[d.k] = t.checked;
      const all = KINDS.every(([k]) => sc[k]);
      store.set(`members/${d.area}/${d.uid}/scope`, all ? null : sc);
    }
    else if (a === 'pov-off' || a === 'pov' || a === 'pov-months') {
      const p = M.pById[+d.pid]; if (!p || !need(can(p.a, 'pov'))) return render();
      const o = Object.assign({}, (D().pov || {})[p.id] || {});
      if (a === 'pov-off') o.off = t.checked; else if (a === 'pov-months') o.months = t.value.split(/[\s,，、]+/).map(Number).filter((n) => n >= 1 && n <= 12);
      else if (d.k === 'cap') o.cap = t.value === '' ? '' : Math.max(0, Math.min(99, Math.round(+t.value) || 0));
      else if (d.k === 'note') o.note = String(t.value || '').slice(0, 200);
      else return render();
      for (const k of Object.keys(o)) if (o[k] === '' || o[k] === false || (Array.isArray(o[k]) && !o[k].length)) delete o[k];
      store.update(Object.assign({ ['pov/' + p.id]: Object.keys(o).length ? o : null }, logOp(p.a, `更新 ${p.n} 的人員狀態`)));
    }
  }

  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const sh = document.querySelector('#app .sheet'); if (!sh) return;
      const f = [...sh.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
      const list = f.length ? f : [sh];
      const first = list[0], last = list[list.length - 1], act = document.activeElement;
      if (!sh.contains(act)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (act === first || act === sh)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key === 'Escape') {
      if (UI.person) { UI.person = null; render(); }
      else if (UI.lyPick) { UI.lyPick = null; render(); }
      else if (UI.acctOpen) { UI.acctOpen = false; render(); }
    }
  });

  store.onChange(onStoreChange);
  store.init().then(() => {
    if (store.mode === 'local' && !(store.data.meta || {}).seeded) seedDefaults();
    else if (store.mode === 'local' && !Object.keys(store.data.proposals || {}).length) {
      const initP = buildInitialProposals(), up = {};
      for (const id in initP) up['proposals/' + id] = initP[id];
      store.update(up);
    }
    render();
  }).catch((e) => { $('#app').innerHTML = `<div class="iss bad">無法啟動：${esc(e.message)}</div>`; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // N-2：有新版 Service Worker 接手時提示重新整理（第一次安裝沒有舊 controller，不提示）
    const hadController = !!navigator.serviceWorker.controller;
    let updShown = false;
    const showUpdateBar = () => {
      if (updShown || !hadController || document.getElementById('upd-bar')) return;
      updShown = true;
      const bar = document.createElement('div');
      bar.id = 'upd-bar'; bar.className = 'updbar'; bar.setAttribute('role', 'alert');
      bar.innerHTML = '<span>有新版，請重新整理</span><button type="button" class="btn sm" id="upd-reload">重新整理</button>';
      document.body.appendChild(bar);
      document.getElementById('upd-reload').addEventListener('click', () => location.reload());
    };
    navigator.serviceWorker.addEventListener('controllerchange', showUpdateBar);
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(); });
      });
    }).catch(() => { });
  }
  window.__td = {
    store, E,
    get M() { return M; }, get ISS() { return ISS; },
    recompute: () => recompute(true), seedDefaults, areaStats, areaMetrics,
    simulateProposalOption, buildInitialProposals,
    autoApproveBind, setAutoApproveBind, adminSyncMap, ensureAdminNodes, canUndo, normUndo, mkUndo, isPreFor, canConfirmPre, confirmPre,
    bindPersonToMe, applyNewPerson, toggleFamily, approveBind,
    bringLastYearGroup, autoAssignRitualPosts, moveGroupMember,
    bringLastYearSlot, autoFillSlot, adoptProposalOption, revertProposal,
    consoleCtx, isLargeMode, toggleLargeMode
  };
})();
