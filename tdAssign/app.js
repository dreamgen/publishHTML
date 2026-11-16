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
    person: null, acctOpen: false, apptQ: '', bindQ: '', famQ: '', toast: '',
    b6Mode: '', b1NomOpen: false, b1ShowCook: false,
    pAddOptOpen: false, a6RemindOpen: false, a6PickAreaOpen: false
  };

  /* ---------------- 設定與狀態工具 ---------------- */
  function autoApproveBind() {
    try {
      const ov = localStorage.getItem('tdAssign-test-autoBind');
      if (ov === '1') return true;
      if (ov === '0') return false;
    } catch (e) { }
    return CFG.autoApproveBind !== false;
  }
  function setAutoApproveBind(val) {
    try { localStorage.setItem('tdAssign-test-autoBind', val ? '1' : '0'); } catch (e) { }
    toast(val ? '已切為測試模式：姓名綁定立即生效' : '已切為正式審核：綁定需區長或小組長確認');
    render();
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
  function recompute() {
    const st = E.freshState();
    const d = D();
    st.groups = {};
    for (const gm of BASE.groupsMeta) st.groups[gm.id] = Object.keys((d.groups || {})[gm.id] || {}).map(Number);
    st.assign = {};
    for (const sid in d.assign || {}) st.assign[sid] = { p: Object.keys(d.assign[sid]).map(Number), lk: [] };
    st.edits = d.edits || {};
    st.extra = d.extra || {};
    st.addedPeople = Object.values(d.addedPeople || {}).map((p) => Object.assign({}, p, { id: +p.id }));
    st.pov = d.pov || {};
    st.acks = d.acks || {};
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
    for (const pid in d.proposals || {}) {
      const pr = d.proposals[pid];
      if (!pr || pr.status === 'resolved') continue;
      for (const sid of pr.slotIds || []) (slotProps[sid] = slotProps[sid] || []).push(pr);
    }
  }

  /* ---------------- 身分、綁定與權限 ---------------- */
  const me = () => store.user;
  const myUserRec = () => (me() && (D().users || {})[me().uid]) || null;
  function myBoundPerson() {
    const u = myUserRec();
    if (!u || !u.pid || !M) return null;
    return { p: M.pById[+u.pid] || null, status: u.bindStatus || 'ok', rec: u };
  }
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
  const kindOfGroup = (gk) => gk.split('_')[0];
  const gmOf = (gk) => E.GROUP_META_BY_ID[gk];
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
    if (meta.leadPid && M.pById[+meta.leadPid]) return M.pById[+meta.leadPid];
    const mem = (E.getState().groups[gk] || []).map((id) => M.pById[id]).filter(Boolean);
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

  /* ---------------- 各區指標計算（供 B1 使用） ---------------- */
  function areaMetrics(area) {
    const activePeople = M.people.filter((p) => p.a === area && !p.off);
    const aSlots = M.slots.filter((s) => !s.cancel && s.area === area);
    let totalDemand = 0;
    for (const s of aSlots) totalDemand += E.slotNeed(M, s) * (s.share || 1);
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
    E.setState(simSt);
    const m2 = E.buildModel();
    const iss2 = E.allIssues(m2).filter((c) => !((d.acks || {})[c.key] && d.acks[c.key].st === '接受例外'));
    E.setState(baseSt); // 立刻還原基準狀態

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
      areaDiffs,
      assignedHit,
      lockedText: opt.lockNote || (lockedSrcs.length ? `原為「${lockedSrcs[0]}」，採用時將解除鎖定` : '不需更動已鎖定行事曆'),
      peopleText: opt.affectedPeopleNote || (assignedHit ? `影響已排 ${assignedHit} 人次，需確認或通知` : '尚未排到個人'),
      needReplyText: (opt.needReply && opt.needReply.length) ? opt.needReply.join('、') : (areaDiffs.map((x) => x.area).join('、') || prop.area)
    };
  }

  /* ---------------- 寫入操作 ---------------- */
  const stamp = (extra) => Object.assign({ by: me().uid, n: me().name, at: Date.now() }, extra || {});
  function logOp(area, msg, undo) {
    const id = store.pushId();
    return { ['log/' + id]: { uid: me().uid, name: me().name, at: Date.now(), area, msg, undo: undo || null } };
  }
  function touchArea(area) {
    const a = (D().areas || {})[area];
    return a && (a.status === 'submitted' || a.status === 'confirmed') ? { ['areas/' + area + '/after']: (a.after || 0) + 1 } : {};
  }
  function addPerson(kind, key, pid, area, label) {
    const p = M.pById[pid];
    const pre = isAdmin() && !(memberOf(area) && memberOf(area).status === 'ok') && AREAS.includes(area);
    const path = `${kind}/${key}/${pid}`;
    store.update(Object.assign({ [path]: stamp(pre ? { pre: true } : null) }, logOp(area, `${label} ${pre ? '預排' : '加入'} ${p.n}`, { [path]: null }), touchArea(area)));
    toast(pre ? `已預排 ${p.n}，等 ${area} 區長確認` : `已加入 ${p.n}`);
  }
  function removePerson(kind, key, pid, area, label) {
    const p = M.pById[pid], path = `${kind}/${key}/${pid}`, prev = rec(kind, key, pid) || null;
    store.update(Object.assign({ [path]: null }, logOp(area, `${label} 移出 ${p ? p.n : pid}`, { [path]: prev }), touchArea(area)));
    toast(`已移出 ${p ? p.n : ''}`);
  }
  function confirmPre(kind, key, pid, area, label) {
    const r = rec(kind, key, pid); if (!r) return;
    const next = Object.assign({}, r); delete next.pre; next.okBy = me().name; next.okAt = Date.now();
    store.update(Object.assign({ [`${kind}/${key}/${pid}`]: next }, logOp(area, `${label} 確認預排 ${M.pById[pid].n}`)));
    toast('已確認');
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

  /* M8 姓名綁定、加入名冊、代管家人 */
  function bindPersonToMe(pid) {
    if (!me()) return toast('請先登入');
    const p = M.pById[+pid]; if (!p) return;
    const okNow = autoApproveBind() || isAdmin() || isLead(p.a);
    const uid = me().uid;
    store.update({
      [`users/${uid}/pid`]: +pid,
      [`users/${uid}/bindStatus`]: okNow ? 'ok' : 'pending',
      [`users/${uid}/bindArea`]: p.a,
      [`users/${uid}/bindAt`]: Date.now(),
      [`users/${uid}/bindOkBy`]: okNow ? (autoApproveBind() ? '測試期自動生效' : me().name) : null
    });
    toast(okNow ? `已綁定為 ${p.n}（${p.a}）` : `已送出「${p.n}」綁定申請，待 ${p.a} 區長確認`);
  }
  function applyNewPerson(name, area, sx, note) {
    if (!me()) return toast('請先登入');
    name = String(name || '').trim();
    if (!name) return toast('請輸入姓名');
    const maxId = M.people.reduce((mx, p) => Math.max(mx, +p.id || 0), 0);
    const newId = maxId + 1;
    const okNow = autoApproveBind() || isAdmin() || isLead(area);
    const uid = me().uid;
    const person = {
      id: newId, n: name, a: area || '瑞芳', sx: sx || '', age: null,
      src: 'N', lead: '', cg: [], cr: '', sg: '', li: '', zr: '', tr: '',
      n115: 0, wd115: 0, cls: '', note: note || 'M8 申請加入名冊'
    };
    store.update(Object.assign({
      [`addedPeople/${newId}`]: person,
      [`users/${uid}/pid`]: newId,
      [`users/${uid}/bindStatus`]: okNow ? 'ok' : 'pending',
      [`users/${uid}/bindArea`]: person.a,
      [`users/${uid}/bindAt`]: Date.now(),
      [`users/${uid}/bindOkBy`]: okNow ? '測試期自動生效' : null
    }, logOp(person.a, `申請新增名冊與綁定：${name}`)));
    toast(okNow ? `已將 ${name} 加入名冊並綁定` : `已送出「${name}」加入名冊申請`);
  }
  function toggleFamily(pid, add) {
    if (!me()) return;
    const uid = me().uid, p = M.pById[+pid];
    if (!p) return;
    store.set(`users/${uid}/family/${pid}`, add ? { pid: +pid, n: p.n, a: p.a, at: Date.now() } : null);
    toast(add ? `已加入代管家人：${p.n}` : `已移除代管：${p.n}`);
  }
  function approveBind(uid, allow) {
    const u = (D().users || {})[uid]; if (!u) return;
    const area = u.bindArea || '瑞芳';
    if (!need(isLead(area) || isAdmin())) return;
    if (allow) {
      store.update(Object.assign({
        [`users/${uid}/bindStatus`]: 'ok',
        [`users/${uid}/bindOkBy`]: me().name,
        [`users/${uid}/bindOkAt`]: Date.now()
      }, logOp(area, `確認 ${u.name} 綁定名冊姓名`)));
      toast('已確認姓名綁定');
    } else {
      store.update(Object.assign({
        [`users/${uid}/bindStatus`]: 'rejected',
        [`users/${uid}/bindOkBy`]: me().name
      }, logOp(area, `退回 ${u.name} 姓名綁定申請`)));
      toast('已退回綁定申請');
    }
  }

  /* B6 禮節崗位、組長、移組、帶入去年 */
  function bringLastYearGroup(gk) {
    const gm = gmOf(gk); if (!gm || !need(can(gm.area, kindOfGroup(gk)))) return;
    const cur = new Set(E.getState().groups[gk] || []);
    let ids = (BASE.defaultGroups[gk] || []).filter((id) => !cur.has(id) && M.pById[id]);
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
    const up = {}; for (const id of ids) up[`groups/${gk}/${id}`] = stamp();
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
    const fromPath = `groups/${fromGk}/${pid}`, toPath = `groups/${toGk}/${pid}`;
    store.update(Object.assign(
      { [fromPath]: null, [toPath]: stamp() },
      logOp(gmFrom.area, `${p.n} 從 ${gmFrom.name} 移到 ${gmTo.name}`, { [fromPath]: prev, [toPath]: null }),
      touchArea(gmFrom.area), touchArea(gmTo.area)
    ));
    UI.b6Mode = '';
    toast(`已將 ${p.n} 移到 ${gmTo.name}`);
  }

  /* B4 帶入去年 & 系統建議補滿 */
  function bringLastYearSlot(sid) {
    const s = M.byId[sid]; if (!s || !need(can(s.area, 'jz'))) return;
    const cur = new Set(M.asg[sid].p), needN = E.slotNeed(M, s), left = Math.max(0, needN - cur.size);
    if (!left) return toast('這一格人數已達需求');
    const local = E.poolFor(M, s, false).filter((p) => !cur.has(p.id) && (s.cat.startsWith('忠恕') ? (p.zr || p.n115 > 0) : p.n115 > 0));
    const ranked = local.map((p) => evalInSlot(p, s)).filter((ev) => !ev.hard.length)
      .sort((a, b) => ((b.p.zr ? 1 : 0) - (a.p.zr ? 1 : 0)) || (b.p.n115 || 0) - (a.p.n115 || 0) || b.score - a.score);
    const pick = ranked.slice(0, left);
    if (!pick.length) return toast('去年有經驗且無衝突的人都在裡面了，請改用「系統建議補滿」');
    const up = {}, undo = {}, label = slotName(s);
    for (const ev of pick) { const path = `assign/${sid}/${ev.p.id}`; up[path] = stamp(); undo[path] = null; }
    store.update(Object.assign(up, logOp(s.area, `${label} 帶入去年名單 ${pick.length} 人`, undo), touchArea(s.area)));
    toast(`已帶入 ${pick.length} 人`);
  }
  function autoFillSlot(sid) {
    const s = M.byId[sid]; if (!s || !need(can(s.area, 'jz'))) return;
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
    const up = {}, undo = {}, label = slotName(s);
    for (const p of chosen) { const path = `assign/${sid}/${p.id}`; up[path] = stamp(); undo[path] = null; }
    store.update(Object.assign(up, logOp(s.area, `${label} 系統建議補滿 ${chosen.length} 人`, undo), touchArea(s.area)));
    toast(`已依合適程度補入 ${chosen.length} 人`);
  }

  /* B2 提案寫入與決議套用 */
  function createProposalFromForm(areaDefault) {
    if (!me()) return toast('請先登入');
    const type = $('#npType').value;
    const sid = $('#npSlot').value;
    const title = ($('#npTitle').value || '').trim();
    const reason = ($('#npReason').value || '').trim();
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
      byName: me().name, byUid: me().uid, at: Date.now(),
      status: 'waiting', step: 3,
      options: [
        { id: 'A', label: labelA, changes: chA, needReply: targetArea ? [targetArea] : [area] },
        { id: 'B', label: '乙 維持原案，區內協調例外', changes: {}, needReply: [area] }
      ],
      votes: { [area]: { st: '同意甲', by: me().name, at: Date.now() } },
      talk: {}
    };
    store.update(Object.assign({ ['proposals/' + id]: prop }, logOp(area, `提出調整提案 ${id}：${title}`)))
      .then(() => { location.hash = '#/p/' + id; });
    toast('已送出提案並完成影響試算');
  }
  function addOptionToProposal(propId) {
    if (!me()) return toast('請先登入');
    const pr = (D().proposals || {})[propId]; if (!pr) return;
    const label = ($('#optLabel').value || '').trim();
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
    const nextOpts = (pr.options || []).concat([{
      id: letter, label: `${prefix} ${label}`, changes,
      needReply: uniq([area || pr.area].filter(Boolean))
    }]);
    UI.pAddOptOpen = false;
    store.update({ [`proposals/${propId}/options`]: nextOpts });
    toast(`已新增做法「${prefix}」並納入試算`);
  }
  function adoptProposalOption(propId, optId) {
    if (!need(isAdmin(), '決議套用到總表需由總召或調度台執行（區長請先在右側表態）')) return;
    const pr = (D().proposals || {})[propId]; if (!pr) return;
    const opt = (pr.options || []).find((o) => o.id === optId); if (!opt) return;
    const up = {}, prevEdits = {}, prevExtra = {};
    for (const sid in opt.changes || {}) {
      prevEdits[sid] = (D().edits || {})[sid] || null;
      up['edits/' + sid] = Object.assign({}, prevEdits[sid] || {}, opt.changes[sid]);
    }
    for (const eid in opt.extraSlots || {}) {
      prevExtra[eid] = (D().extra || {})[eid] || null;
      up['extra/' + eid] = opt.extraSlots[eid];
    }
    const oldVer = draftVer(), newVer = nextDraftVer(oldVer);
    up['meta/version'] = newVer;
    up[`proposals/${propId}/status`] = 'resolved';
    up[`proposals/${propId}/step`] = 6;
    up[`proposals/${propId}/chosen`] = optId;
    up[`proposals/${propId}/resolvedBy`] = me().name;
    up[`proposals/${propId}/resolvedAt`] = Date.now();
    up[`proposals/${propId}/prevVer`] = oldVer;
    up[`proposals/${propId}/prevEdits`] = prevEdits;
    up[`proposals/${propId}/prevExtra`] = prevExtra;
    const tid = store.pushId();
    up[`proposals/${propId}/talk/${tid}`] = {
      who: '系統', area: '系統', at: Date.now(),
      text: `${me().name} 決議採用「${opt.label}」，已套用至總表並將草案升版為 ${newVer}。`
    };
    store.update(Object.assign(up, logOp(pr.area || '總召', `決議套用提案 ${propId}（${opt.label}），升版為 ${newVer}`)));
    toast(`已套用到總表（${newVer}）`);
  }
  function revertProposal(propId) {
    if (!need(isAdmin(), '只有總召可還原決議')) return;
    const pr = (D().proposals || {})[propId]; if (!pr || pr.status !== 'resolved') return;
    const up = {};
    for (const sid in pr.prevEdits || {}) up['edits/' + sid] = pr.prevEdits[sid];
    for (const eid in pr.prevExtra || {}) up['extra/' + eid] = pr.prevExtra[eid];
    if (pr.prevVer) up['meta/version'] = pr.prevVer;
    up[`proposals/${propId}/status`] = 'waiting';
    up[`proposals/${propId}/step`] = 3;
    up[`proposals/${propId}/chosen`] = null;
    store.update(Object.assign(up, logOp(pr.area || '總召', `還原提案 ${propId} 決議前狀態`)));
    toast('已還原決議前版本');
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
    const groups = areaGroups(area).map((gm) => {
      const n = (E.getState().groups[gm.id] || []).length, gi = groupIssues(gm.id), iss = cnt(gi), clash = gi.filter(isClash).length;
      const pre = Object.values((D().groups || {})[gm.id] || {}).filter((r) => r.pre).length;
      const lead = groupLead(gm.id);
      const posts = ((D().groupMeta || {})[gm.id] || {}).posts || {};
      const postCnt = RITUAL_POSTS.filter((k) => posts[k]).length;
      return { gm, n, iss, pre, clash, lead, postCnt, done: n >= (gm.need || 1) && !clash && !pre };
    });
    const dated = areaDated(area).map((s) => {
      const si = slotIssuesOf(s.id).filter((c) => c.rule !== 'P11'), n = M.asg[s.id].p.length, need = E.slotNeed(M, s), iss = cnt(si), clash = si.filter(isClash).length;
      const pre = Object.values((D().assign || {})[s.id] || {}).filter((r) => r.pre).length;
      const props = slotProps[s.id] || [];
      return { s, n, need, iss, pre, clash, props, done: n >= need && !clash && !pre };
    });
    const all = groups.concat(dated);
    const hasEdited = all.some((x) => x.n > 0) || Object.keys((D().members || {})[area] || {}).length > 0;
    const rawStatus = ((D().areas || {})[area] || {}).status;
    return {
      groups, dated,
      gDone: groups.filter((x) => x.done).length, dDone: dated.filter((x) => x.done).length,
      short: dated.filter((x) => x.n < x.need).length + groups.filter((x) => x.n < (x.gm.need || 1)).length,
      v: all.reduce((a, x) => a + x.iss.v, 0), n: all.reduce((a, x) => a + x.iss.n, 0),
      pre: all.reduce((a, x) => a + x.pre, 0), clash: all.reduce((a, x) => a + x.clash, 0),
      status: rawStatus || (hasEdited ? 'editing' : 'not_started'),
      after: ((D().areas || {})[area] || {}).after || 0
    };
  }
  const ST_LABEL = { not_started: ['no', '還沒開始'], editing: ['wn', '區內排人中'], submitted: ['pl', '已送出'], confirmed: ['ok', '已確認'] };

  /* ---------------- 畫面：共用頂部與導覽 ---------------- */
  function accountBtn() {
    const u = me(), bp = myBoundPerson();
    const label = u ? (bp && bp.p ? `${u.name}（${bp.p.n}）` : u.name || '我') : '';
    const sync = store.mode === 'local' ? '本機試用' : !store.online ? `離線${store.pending ? ' · ' + store.pending + ' 筆待同步' : ''}` : store.pending ? `同步中 ${store.pending}` : '已同步';
    return `<div class="top-r"><span class="sync ${store.online ? '' : 'off'}">${esc(sync)}</span>
      ${u ? `<button class="btn sm" data-act="open-acct">${esc(label)}</button>` : `<a class="btn sm pri" href="#/login">登入 / 綁定</a>`}</div>`;
  }
  function topbar(title, sub, back) {
    return `<header class="top">
      ${back ? `<a class="back" href="${back}">← 返回</a>` : `<a class="back" href="#/">天達排班協作</a>`}
      ${accountBtn()}
      <div class="ttl"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    </header>`;
  }
  function wsHeader(wsKey, subKey, area) {
    const a = area || defaultArea();
    const wsLink = (k, href, txt) => `<a href="${href}" class="${wsKey === k ? 'on' : ''}">${txt}</a>`;
    let subs = '';
    if (wsKey === 'A') {
      subs = `<a href="#/review" class="${subKey === 'review' ? 'on' : ''}">各區進度與協調</a>
        <a href="#/" class="${subKey === 'home' ? 'on' : ''}">工作區總覽</a>`;
    } else if (wsKey === 'B') {
      subs = `<a href="#/b1/${a}" class="${subKey === 'b1' ? 'on' : ''}">本區首頁</a>
        <a href="#/a/${a}" class="${subKey === 'b3' ? 'on' : ''}">排人（手機）</a>
        <a href="#/p" class="${subKey === 'b2' ? 'on' : ''}">提案與試算</a>`;
    }
    return `<header class="ws-header">
      <div class="ws-top">
        <a class="ws-brand" href="#/">
          <div class="ws-logo" aria-hidden="true">達</div>
          <div><div class="ws-title">天達堂排班系統</div><div class="ws-sub">116 年度 · 草案 ${esc(draftVer())}</div></div>
        </a>
        <nav class="ws-nav" aria-label="工作台">
          ${wsLink('home', '#/', '總覽')}
          ${wsLink('A', '#/review', '各區進度(A6)')}
          ${wsLink('B', `#/b1/${a}`, '各區討論(B1–B5)')}
          ${wsLink('P', '#/p', '提案試算(B2)')}
        </nav>
        ${accountBtn()}
      </div>
      ${subs ? `<div class="sub-nav">${subs}</div>` : ''}
    </header>`;
  }
  function areaNav(area, cur) {
    const it = (href, key, t) => `<a href="${href}" class="${cur === key ? 'on' : ''}">${t}</a>`;
    return `<nav class="bnav" aria-label="區排人選單">${it('#/a/' + area, 'a', '排人')}${it('#/t/' + area, 't', '分工與送出')}${it('#/b1/' + area, 'p', '提案')}</nav>`;
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
    let body = '';
    if (!seeded) {
      body += `<section class="card warnbox"><b>這個年度還沒有初始資料。</b><div class="muted">初始化會把 115 年的組別名單與初始調整提案帶進來當起點，各區再調整。</div>
        ${store.mode === 'local' || isAdmin() ? `<button class="btn pri" data-act="seed">初始化 116 年資料</button>` : `<div class="muted">請總召或調度台登入後初始化。</div>`}</section>`;
    }
    if (me()) {
      const bindLine = bp && bp.p
        ? `已綁定：<b>${esc(bp.p.n)}</b>（${esc(bp.p.a)}）${bp.status === 'pending' ? tag('wn', '待區長確認') : tag('ok', '已生效')}`
        : `尚未綁定名冊姓名 ${tag('wn', '點此綁定')}`;
      body += `<section class="card"><div class="row-h"><span>${bindLine}</span><button class="btn sm" data-act="open-acct">帳號與綁定 (M8)</button></div>
        ${!mine.length && !isAdmin() ? `<div class="muted small">您還不是任何一區的排班人員：可先瀏覽，或到自己的區按「申請成為排班人員」。</div>` : ''}</section>`;
    }
    body += `<div class="act-bar2">
      <a class="btn blue-out" href="#/b1/${curArea}">區長首頁 (B1)</a>
      <a class="btn blue" href="#/p">提案與影響試算 (B2)</a>
    </div>`;
    body += `<section class="list">` + WORK_AREAS.map((a) => {
      const s = seeded ? areaStats(a) : null, m = mine.includes(a);
      const tot = s ? s.groups.length + s.dated.length : 0;
      if (s && !tot) return '';
      const [cls, lab] = ST_LABEL[s ? s.status : 'editing'];
      return `<div class="row"><div class="row-h"><a href="#/a/${a}" style="text-decoration:none"><b class="c-${a}">${a}</b></a>${m ? tag('ok', '我負責') : ''}${s ? tag(cls, lab) : ''}
        <span style="margin-left:auto;display:flex;gap:6px"><a class="btn sm" href="#/b1/${a}">首頁</a><a class="btn sm pri" href="#/a/${a}">排人</a></span></div>
        ${s ? `<div class="muted small">組別 ${s.gDone}／${s.groups.length} · 依日期 ${s.dDone}／${s.dated.length}${s.clash ? ` · <span class="t-bad">撞到 ${s.clash}</span>` : ''}${s.pre ? ` · 預排待確認 ${s.pre}` : ''}</div>` : ''}</div>`;
    }).join('') + `</section>`;
    body += `<a class="btn wide" href="#/review">各區進度與跨區協調 (A6)</a>`;
    return topbar(`116 年各區排人（${draftVer()}）`, store.mode === 'local' ? '本機試用模式 · 測試期間姓名綁定立即生效' : '人由各區排；總召檢查衝突與協調') + `<main>${body}</main>`;
  }

  function bindSectionHtml() {
    const bp = myBoundPerson();
    const u = myUserRec() || {};
    const q = UI.bindQ;
    const hits = q.length >= 1 ? M.people.filter((p) => p.n.includes(q)).slice(0, 8) : [];
    const fam = Object.values(u.family || {});
    const famHits = UI.famQ.length >= 1 ? M.people.filter((p) => p.n.includes(UI.famQ) && (!bp || !bp.p || p.id !== bp.p.id) && !(u.family || {})[p.id]).slice(0, 5) : [];
    const isAuto = autoApproveBind();
    return `<section class="card">
      <div class="row-h"><h2>第一次登入：找到自己的名字 (M8)</h2>${tag(isAuto ? 'ok' : 'wn', isAuto ? '測試期：立即生效' : '正式期：需區長確認')}</div>
      ${bp && bp.p ? `<div class="bind-hit on"><div><b>${esc(bp.p.n)}　${esc(bp.p.a)}</b><div class="muted small">${esc(roleOf(bp.p) || '道親')} · ${esc((M.personGroups[bp.p.id] || []).map((g) => gmOf(g).name).join('、') || '尚未入組')}</div></div>
        ${tag(bp.status === 'ok' ? 'ok' : 'wn', bp.status === 'ok' ? '已綁定' : '待區長確認')}</div>` : ''}
      <label>搜尋姓名<input id="bindQ" type="search" value="${esc(UI.bindQ)}" data-input="bindQ" placeholder="輸入名字（例如：許明德）"></label>
      <div class="list">${hits.map((p) => {
        const gs = (M.personGroups[p.id] || []).map((g) => gmOf(g).name).join('、');
        return `<div class="bind-hit"><div><b>${esc(p.n)}　${esc(p.a)}</b><div class="muted small">${esc(roleOf(p) || '道親')}${gs ? ' · ' + esc(gs) : ''}</div></div>
          <button class="btn sm pri" data-act="bind-me" data-pid="${p.id}">這是我</button></div>`;
      }).join('') || (q ? '<div class="muted small">名冊找不到這個名字？可於下方申請加入名冊。</div>' : '')}</div>
      <div class="muted small">送出後${isAuto ? '（測試期間立即生效，完工後恢復由小組長或區長確認）' : '由您的小組長或區長確認，確認前可先瀏覽班表'}。
        <button class="link" data-act="toggle-auto-bind">${isAuto ? '切換為正式審核測試' : '切換為測試立即生效'}</button></div>
      <details><summary>名冊上找不到名字？申請加入名冊</summary>
        <div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
          <div class="grid2">
            <label>姓名<input id="newPerName" type="text" placeholder="請輸入姓名"></label>
            <label>所屬區<select id="newPerArea">${E.PERSON_AREAS.map((a) => `<option>${a}</option>`).join('')}</select></label>
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
        <div class="acts"><button class="btn sm" data-act="person" data-pid="${f.pid}">看班表</button><button class="btn sm" data-act="rm-fam" data-pid="${f.pid}">移除</button></div></div>`).join('') || '<div class="muted small">尚未加入代管家人</div>'}
      <label>搜尋家人姓名<input id="famQ" type="search" value="${esc(UI.famQ)}" data-input="famQ" placeholder="輸入家人名字"></label>
      ${famHits.map((p) => `<div class="bind-hit"><div><b>${esc(p.n)}</b> <span class="muted small">${esc(p.a)}</span></div><button class="btn sm" data-act="add-fam" data-pid="${p.id}">代管</button></div>`).join('')}
    </section>`;
  }

  function vLogin() {
    let body = `<section class="card login-cmp">
      <div><div class="small muted"><b>不用登入</b></div><ul><li>本週與全年場次</li><li>各場名單、車次</li><li>組別、依姓名查詢</li><li>公告、服務指南</li></ul></div>
      <div><div class="small t-ok"><b>登入之後</b></div><ul><li>排本區名單、提案</li><li>回覆會到、請假</li><li>代管家人</li><li>帶隊點名與回饋</li></ul></div>
    </section>`;
    if (me()) {
      body += bindSectionHtml();
      body += `<button class="btn wide" data-act="signout">登出目前帳號（${esc(me().name)}）</button>`;
    } else if (store.mode === 'local') {
      const sampleP = M.people.find((p) => p.a === '瑞芳' && p.n) || M.people[0];
      const opt = (who, t, d) => `<button class="row" data-act="local-in" data-who='${esc(JSON.stringify(who))}'><b>${esc(t)}</b><div class="muted small">${esc(d)}</div></button>`;
      body += `<section class="card"><b>本機試用模式</b><div class="muted">選一個身分試用，資料只存在這台裝置；開兩個分頁選不同身分，可模擬多人同時排。</div></section>
        <section class="list">${opt({ uid: 'local-admin', name: '總召（試用）', admin: true }, '總召、調度台', '看各區進度、協調、預排、決議套用提案、指定排班人員')}
        ${AREAS.map((a) => opt({ uid: 'local-lead-' + a, name: a + '區長（試用）', leadOf: a }, a + ' 區長', '區長首頁、排本區的人、提案表態、指定排班人員、確認預排、送出')).join('')}
        ${sampleP ? opt({ uid: 'local-bound-' + sampleP.id, name: sampleP.n, pid: sampleP.id, area: sampleP.a }, `已綁定道親：${sampleP.n}（${sampleP.a}）`, '直接體驗 M8 已綁定名冊姓名狀態') : ''}
        ${opt({ uid: 'local-u1', name: '道親甲（試用）' }, '一般道親（未綁定）', '登入後搜尋名冊姓名綁定「這是我」或申請成為排班人員')}</section>`;
    } else {
      body += `<button class="btn pri big" data-act="in" data-kind="google">使用 Google 帳號登入</button>
        ${CFG.lineChannelId && CFG.lineWorkerUrl ? `<button class="btn big" data-act="in" data-kind="line">使用 LINE 登入</button>` : `<div class="muted small">LINE 登入尚未設定。</div>`}`;
    }
    return topbar(me() ? '帳號與姓名綁定' : '登入', '', '#/') + `<main>${body}${store.error ? `<div class="iss bad">${esc(store.error)}</div>` : ''}</main>`;
  }

  function accountSheet() {
    if (!me()) return '';
    return `<div class="sheet-bg" data-act="close-acct"></div><aside class="sheet" role="dialog" aria-label="帳號與姓名綁定">
      <div class="mem-h"><h2>${esc(me().name || '我')}</h2><span class="muted small">${esc(me().provider || '')}${isAdmin() ? ' · 總召/調度台' : ''}</span>
        <button class="btn sm" data-act="close-acct">關閉</button></div>
      ${bindSectionHtml()}
      <button class="btn wide bad-out" data-act="signout">登出</button>
    </aside>`;
  }

  /* ---------------- 畫面：B3 本區要排的人 ---------------- */
  function reminders(area, S) {
    const out = [];
    const preRows = [];
    for (const g of S.groups) for (const pid in (D().groups || {})[g.gm.id] || {}) if (D().groups[g.gm.id][pid].pre) preRows.push({ href: '#/g/' + g.gm.id, t: `${g.gm.name}：${(M.pById[pid] || {}).n || pid}`, r: D().groups[g.gm.id][pid] });
    for (const x of S.dated) for (const pid in (D().assign || {})[x.s.id] || {}) if (D().assign[x.s.id][pid].pre) preRows.push({ href: '#/s/' + x.s.id, t: `${slotName(x.s)}：${(M.pById[pid] || {}).n || pid}`, r: D().assign[x.s.id][pid] });
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
      return `<a class="row" href="#/g/${g.gm.id}"><div class="row-h"><b>${esc(g.gm.name)}</b><span class="num">${g.gm.cat === '禮節' ? `${g.postCnt}／6 崗位 · ` : ''}${g.n} 人</span></div>
        <div class="muted small">${esc(subDesc)}</div>
        <div class="row-t">${st(g, g.n < (g.gm.need || 1) ? '人數不足' : '')}${tag('no', own)}${ed.length ? `<span class="muted small">${esc(ed.map((u) => u.name).join('、'))} 正在編輯</span>` : ''}</div></a>`;
    }).join('');

    const dRows = S.dated.filter((x) => keep(x, 'jz')).map((x) => {
      const ed = present(area, 's/' + x.s.id).filter((u) => !me() || u.uid !== me().uid);
      const own = ownerOfSlot(x.s), hasProp = x.props && x.props.length;
      const pTag = hasProp ? tag('bad', '提案中') : '';
      const pNote = hasProp ? `<span class="muted small">${esc(x.props[0].id)} ${esc(x.props[0].title)}</span>` : '';
      return `<a class="row" href="#/s/${x.s.id}"><div class="row-h"><b>${esc(slotName(x.s))}</b><span class="num ${x.n < x.need ? 't-bad' : ''}">${x.n}／${x.need}</span></div>
        <div class="row-t">${st(x, x.n < x.need ? (x.n ? `缺 ${x.need - x.n}` : '還沒排') : '')}${pTag}${tag('no', own)}${pNote}${ed.length ? `<span class="muted small">${esc(ed.map((u) => u.name).join('、'))} 正在編輯</span>` : ''}</div></a>`;
    }).join('');

    const m = memberOf(area);
    const join = me() && !isAdmin() && AREAS.includes(area) && !m ? `<button class="btn wide" data-act="join" data-area="${area}">申請成為 ${area} 的排班人員</button>` : m && m.status === 'pending' ? `<div class="card muted">已申請成為排班人員，等區長或調度台同意。</div>` : '';
    return topbar(`${area}　本區要排的人`, `${tag(cls, lab)}${S.after ? tag('pl', `送出後變更 ${S.after}`) : ''}<a class="link" style="margin-left:auto" href="#/b1/${area}">區長首頁 →</a>`, '#/') + `<main>
      ${here.length ? `<div class="pres">${avatars(here)}<span class="muted small">${here.length} 人正在作業 · 改動即時同步</span></div>` : ''}
      ${join}${reminders(area, S)}
      <div class="chips">${chips}</div>
      <div class="sec-h"><h2>組別</h2><span class="num muted">排好 ${S.gDone}／${S.groups.length} 組</span></div>
      <div class="muted small">改組員，全年每一場自動帶入。不能只改某一天。</div>
      <section class="list">${gRows || '<div class="empty">沒有符合的組別</div>'}</section>
      <div class="sec-h"><h2>依日期排（沒有組別）</h2><span class="num muted">排滿 ${S.dDone}／${S.dated.length} 格</span></div>
      <section class="list">${dRows || '<div class="empty">沒有符合的勤務</div>'}</section>
      <div class="muted small">哪一區、哪一天、哪一組由總召排定並鎖住，要換日或換區請用提案。標「預排」的人是總召或調度台先排的，必須由區長確認或重排。</div>
    </main>${areaNav(area, 'a')}`;
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
  function candList(kind, key, area, label, pool, evalFn, canEdit) {
    const evs = pool.map(evalFn).sort((a, b) => (a.hard.length - b.hard.length) || b.score - a.score);
    const L = UI.showAll ? evs : evs.slice(0, 12);
    return L.map((ev) => {
      const p = ev.p, why = ev.hard[0] || ev.soft[0];
      return `<div class="cand"><div><button class="link" data-act="person" data-pid="${p.id}">${esc(p.n)}</button> <span class="muted small">${esc(p.a)}${roleOf(p) ? ' · ' + esc(roleOf(p)) : ''}${p.src === 'N' ? ' · 還沒服務過' : ''}</span>
        <div class="small ${ev.hard.length ? 't-bad' : ev.soft.length ? 't-warn' : 'muted'}">${why ? esc(why.msg) + (ev.hard.length ? '（排入會標成違規）' : '') : `加入後全年 ${ev.occN} 次`}${ev.mates && ev.mates.length ? ` · 常和 ${esc(ev.mates.slice(0, 2).join('、'))} 同組` : ''}</div></div>
        ${canEdit ? `<button class="btn sm ${ev.hard.length ? '' : 'pri'}" data-act="add" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">${isAdmin() && !(memberOf(area) && memberOf(area).status === 'ok') && AREAS.includes(area) ? '預排' : '加入'}</button>` : ''}</div>`;
    }).join('') + (evs.length > L.length ? `<button class="btn wide" data-act="more">顯示全部 ${evs.length} 人</button>` : '') || '<div class="empty">沒有符合的人</div>';
  }
  function finder(area, inIds, kind, key, label, evalFn, canEdit, localPool) {
    const others = AREAS.filter((a) => a !== area);
    if (UI.out && !UI.outArea) UI.outArea = others[0];
    const q = UI.out ? UI.outQ : UI.q;
    let pool, hint = '';
    if (UI.out) {
      pool = q.length >= 1 ? M.people.filter((p) => p.a === UI.outArea && !p.off && !inIds.has(p.id) && p.n.includes(q)) : [];
      hint = q.length < 1 ? '請選區域並輸入至少一個字。' : pool.length ? `找到 ${pool.length} 位。排入後對方的區也會看到這一筆。` : '這一區找不到符合的人。';
    } else {
      pool = localPool.filter((p) => !inIds.has(p.id) && (!q || p.n.includes(q)));
    }
    const ctl = UI.out
      ? `<div class="outbox"><div class="grid2"><label>區域<select id="outArea" data-act-change="outArea">${others.map((a) => `<option ${a === UI.outArea ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
          <label>姓名（至少一個字）<input id="outQ" type="search" value="${esc(UI.outQ)}" data-input="outQ" placeholder="例如：李"></label></div>
          <button class="btn wide" data-act="out" data-v="0">回本區人員</button></div>`
      : `<label>找人（${AREAS.includes(area) ? '本區' : '全部'}）<input id="q" type="search" value="${esc(UI.q)}" data-input="q" placeholder="輸入姓名"></label>
         ${AREAS.includes(area) ? `<button class="btn wide" data-act="out" data-v="1">找非本區人員</button>` : ''}`;
    return `<section class="finder"><div class="sec-h"><h2>${UI.out ? '非本區人員 · ' + esc(UI.outArea) : '可以加入的人'}</h2><span class="muted small">${UI.out ? '輸入後才列出' : '依合適程度'}</span></div>
      ${ctl}<div class="muted small">${hint}</div><div id="cands">${candList(kind, key, area, label, pool, evalFn, canEdit)}</div>
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
          <select ${canEdit ? '' : 'disabled'} data-act-change="set-post" data-gk="${gk}" data-post="${esc(post)}">${opts(posts[post])}</select></div>`).join('')}</div></section>`;
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
      const targets = BASE.groupsMeta.filter((g) => g.id !== gk && (g.area === area || g.cat === gm.cat));
      subPanel = `<section class="card warnbox"><div class="row-h"><h2>將組員移到別組</h2><button class="btn sm" data-act="b6-mode" data-v="">取消</button></div>
        ${mem.length && targets.length ? `<div class="grid2">
          <label>選擇組員<select id="mvPid">${mem.map((p) => `<option value="${p.id}">${esc(p.n)}</option>`).join('')}</select></label>
          <label>目標組別<select id="mvToGk">${targets.map((g) => `<option value="${g.id}">${esc(g.name)}（${esc(g.cat)}）</option>`).join('')}</select></label>
        </div><button class="btn pri" data-act="move-mem" data-gk="${gk}">確認移轉</button>` : '<div class="muted small">沒有可移轉的組員或目標組別</div>'}</section>`;
    }

    return topbar(gm.name, `${lead ? `${leadLabel} ${esc(lead.n)} · ` : ''}${need ? `每場需要 ${need} 人 · ` : ''}目前 ${mem.length} 人`, '#/a/' + area) + `<main>
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
      ${canEdit ? finder(area, inIds, 'groups', gk, gm.name, (p) => evalInGroup(p, gk), canEdit, local) : ''}
      ${subPanel}
      ${canEdit ? `<div class="act-bar3">
        <button class="btn" data-act="last-year" data-gk="${gk}">帶入去年</button>
        <button class="btn" data-act="b6-mode" data-v="lead">換${leadLabel}</button>
        <button class="btn" data-act="b6-mode" data-v="move">移到別組</button>
      </div>` : ''}
      <div class="muted small">檢查是把組員放進這一組全年每一場去算：全年次數、七天內重複、不方便的月份、和其他組或忠恕輪值有沒有同一天。</div>
    </main>${areaNav(area, 'a')}`;
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

    return topbar(label, `${esc(s.loc || '')} · 需要 ${need} 人 · <b class="${A.length < need ? 't-bad' : 't-ok'}">已排 ${A.length}</b>`, '#/a/' + area) + `<main>
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
      ${canEdit ? finder(area, inIds, 'assign', sid, label, (p) => evalInSlot(p, s), canEdit, local) : ''}
      ${canEdit ? `<div class="act-bar2">
        <button class="btn" data-act="slot-last-year" data-sid="${sid}">帶入去年名單</button>
        <button class="btn pri" data-act="slot-autofill" data-sid="${sid}">系統建議補滿</button>
      </div>
      <div class="muted small">沒有網路時照常可以排，連上後自動同步；同一個人被兩邊同時改到時，兩邊都看得到提示。</div>` : ''}
    </main>${areaNav(area, 'a')}`;
  }

  /* ---------------- 畫面：B5 分工與送出 ---------------- */
  function vTeam(area) {
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
        return `<div class="mem"><div class="mem-h"><b>${esc(u.name)}</b> <span class="muted small">申請綁定為「${esc(p ? p.n : u.pid)}」</span>
          <div class="acts" style="margin-left:auto"><button class="btn sm pri" data-act="approve-bind" data-uid="${uid}" data-ok="1">同意</button><button class="btn sm" data-act="approve-bind" data-uid="${uid}" data-ok="0">不同意</button></div></div></div>`;
      }).join('')}</section>` : '';

    const row = ([uid, m]) => {
      const sc = m.scope ? KINDS.filter(([k]) => m.scope[k]).map(([, t]) => t).join('、') || '尚未勾選' : '全部可排';
      const on = present(area).some((u) => u.uid === uid);
      const scopeBox = boss && m.role !== 'lead' && m.status === 'ok' ? `<details><summary>指定只排哪些</summary><div class="grid2">${KINDS.map(([k, t]) => `<label class="ck"><input type="checkbox" data-act-change="scope" data-area="${area}" data-uid="${uid}" data-k="${k}" ${!m.scope || m.scope[k] ? 'checked' : ''}> ${t}</label>`).join('')}</div><div class="muted small">全部勾選＝全部可排。</div></details>` : '';
      return `<div class="mem"><div class="mem-h"><b>${esc(m.name)}</b>${tag('no', m.role === 'lead' ? '區長' : '排班人員')}${m.status === 'pending' ? tag('wn', '申請中') : ''}${on ? tag('ok', '作業中') : ''}
        ${boss && m.status === 'pending' ? `<button class="btn sm pri" data-act="approve" data-area="${area}" data-uid="${uid}">同意</button>` : ''}
        ${boss && m.role !== 'lead' ? `<button class="btn sm" data-act="unmember" data-area="${area}" data-uid="${uid}">${m.status === 'pending' ? '不同意' : '取消'}</button>` : ''}
        ${isAdmin() && m.role === 'lead' ? `<button class="btn sm" data-act="unmember" data-area="${area}" data-uid="${uid}">取消區長</button>` : ''}</div>
        <div class="muted small">${m.role === 'lead' ? '排班人員（預設）· 全部可排；可送出' : esc(sc)}${m.by ? ` · ${esc(m.by)} 指定` : ''}</div>${scopeBox}</div>`;
    };
    const users = Object.entries(D().users || {}).filter(([uid, u]) => !((D().members || {})[area] || {})[uid] && UI.apptQ && (u.name || '').includes(UI.apptQ)).slice(0, 8);
    const appoint = boss ? `<section class="card"><h2>指定排班人員</h2><div class="muted small">對方要先登入過一次，才找得到。也可以請他在本區頁面按「申請成為排班人員」。</div>
      <label>找已登入的人<input id="apptQ" type="search" value="${esc(UI.apptQ)}" data-input="apptQ" placeholder="輸入姓名（至少一個字）"></label>
      <div id="appt">${users.map(([uid, u]) => `<div class="cand"><div><b>${esc(u.name)}</b> <span class="muted small">${esc(u.provider || '')}</span></div><div class="acts"><button class="btn sm pri" data-act="appoint" data-area="${area}" data-uid="${uid}" data-role="sched">指定</button>${isAdmin() ? `<button class="btn sm" data-act="appoint" data-area="${area}" data-uid="${uid}" data-role="lead">設為區長</button>` : ''}</div></div>`).join('') || (UI.apptQ ? '<div class="empty">找不到，請對方先登入一次</div>' : '')}</div></section>` : '';
    const logs = Object.entries(D().log || {}).filter(([, l]) => l.area === area).sort((a, b) => b[1].at - a[1].at).slice(0, UI.showAll ? 60 : 8);
    const submit = isLead(area)
      ? S.status === 'editing' || S.status === 'not_started' ? `<button class="btn pri big" data-act="submit" data-area="${area}">送出給總召確認</button>` : `<button class="btn" data-act="unsubmit" data-area="${area}">收回，繼續排</button>`
      : `<div class="muted small">只有區長能送出。</div>`;
    return topbar(`${area}　分工與送出`, tag(cls, lab), '#/a/' + area) + `<main>
      ${flowHtml}
      <div class="muted">一開始只有區長是排班人員。其他人要由區長或調度台指定後才能排。</div>
      ${bindPendHtml}
      <section class="card members"><h2>本區排班人員</h2>${mems.map(row).join('') || '<div class="empty">還沒有排班人員。請調度台指定區長。</div>'}</section>
      ${appoint}
      <section class="card sendbox"><h2>送出給總召前</h2>
        <div class="kv"><span>組別排好</span><b>${S.gDone}／${S.groups.length} 組</b></div>
        <div class="kv"><span>依日期排滿</span><b>${S.dDone}／${S.dated.length} 格</b></div>
        <div class="kv"><span>人數不足</span><b class="${S.short ? 't-bad' : ''}">${S.short}</b></div>
        <div class="kv"><span>同一天撞到別的排班</span><b class="${S.clash ? 't-bad' : ''}">${S.clash}</b></div>
        <div class="kv"><span>其他違規（間隔、次數上限等）</span><b class="${S.v - S.clash ? 't-warn' : ''}">${S.v - S.clash}</b></div>
        <div class="kv"><span>注意</span><b class="${S.n ? 't-warn' : ''}">${S.n}</b></div>
        <div class="kv"><span>預排待確認</span><b>${S.pre}</b></div>
        ${submit}<div class="muted small">沒排好也可以送，缺的人會列給總召協調。送出後還能改，改動會標記給總召看。</div></section>
      <section class="card"><h2>最近的改動</h2>${logs.map(([id, l]) => `<div class="logrow"><span class="num small">${ago(l.at)}</span> <b>${esc(l.name)}</b> ${esc(l.msg)}${l.undo && can(area, 'jz') && !l.undone ? ` <button class="link" data-act="undo" data-id="${id}">復原</button>` : l.undone ? ' <span class="muted small">已復原</span>' : ''}</div>`).join('') || '<div class="empty">還沒有改動</div>'}
        ${logs.length >= 8 && !UI.showAll ? `<button class="btn wide" data-act="more">看更多</button>` : ''}</section>
    </main>${areaNav(area, 't')}`;
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

    const coord = Object.entries(D().coord || {}).sort((a, b) => b[1].at - a[1].at).filter(([, c]) => c.st !== 'done');
    const crossList = ISS.filter(isClash);
    const shortSubmitted = rows.filter((x) => x.S.status === 'submitted' && x.S.short > 0);
    const afterChanges = rows.filter((x) => x.S.after > 0);
    const crossP3 = ISS.filter((c) => !c.accepted && c.rule === 'P3' && c.lvl === '違規' && c.slots.length >= 2 && (M.byId[c.slots[0]] && M.byId[c.slots[1]] && M.byId[c.slots[0]].area !== M.byId[c.slots[1]].area));
    const acceptedAcks = Object.entries(D().acks || {}).filter(([, a]) => a.st === '接受例外');

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
      ${pickAreaBox}${remindBox}${flowHtml}${tbl}
      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <div class="row-h"><h2>需要總召協調</h2><span class="muted small">各區排的當下就看得到對方排的內容；這裡列的是還沒談定的</span></div>
            ${coord.map(([id, c]) => `<div class="coord-item">
              <div>${tag('bad', '區請協調')} <b class="c-${esc(c.area)}">${esc(c.area)}</b> <span class="muted small">${esc(c.name)} · ${ago(c.at)}</span>
                <div><b>${esc(c.label)}</b>：${esc(c.msg)}</div></div>
              <div class="muted small">${c.pid ? `<button class="link" data-act="person" data-pid="${c.pid}">看 ${(M.pById[c.pid] || {}).n || ''} 全年排班</button>` : ''}</div>
              <div class="acts">${isAdmin() ? `<button class="btn sm pri" data-act="coord-done" data-id="${id}">標為已處理</button>` : ''}</div>
            </div>`).join('')}
            ${crossList.slice(0, UI.showAll ? 200 : 8).map((c) => `<div class="coord-item">
              <div>${tag('bad', '同一人在兩份名單')}<div style="font-weight:700;margin-top:4px">${esc(c.msg)}</div>
                <div>${c.slots.map((sid) => { const s = M.byId[sid]; return s ? `<a class="small" href="${s.groupKey ? '#/g/' + s.groupKey : '#/s/' + sid}">${esc(s.area)} ${esc(s.groupKey ? gmOf(s.groupKey).name : s.cat)}</a>` : ''; }).join(' · ')}</div></div>
              <div class="muted small">${c.pid ? `<button class="link" data-act="person" data-pid="${c.pid}">看全年排班</button>` : ''}</div>
              <div class="acts">${isAdmin() ? `<button class="btn sm" data-act="ack-issue" data-key="${esc(c.key)}" data-msg="${esc(c.msg)}">接受為例外</button>` : ''}</div>
            </div>`).join('')}
            ${shortSubmitted.map(({ a, S }) => `<div class="coord-item">
              <div>${tag('bad', '人數不足')}<div style="font-weight:700;margin-top:4px">${a} 送出時尚有 ${S.short} 格缺人</div><div class="muted small">已送出但缺額，建議向人均較低區域發支援請求</div></div>
              <div class="muted small">相關：${a}</div>
              <div class="acts">${isAdmin() ? `<a class="btn sm pri" href="#/p/new?area=${a}&type=合併支援">發支援請求</a>` : ''}</div>
            </div>`).join('')}
            ${crossP3.slice(0, 6).map((c) => `<div class="coord-item">
              <div>${tag('wn', '跨名單七天內重複')}<div style="font-weight:700;margin-top:4px">${esc(c.msg)}</div></div>
              <div class="muted small">${c.slots.map((sid) => M.byId[sid] ? M.byId[sid].area : '').join('、')}</div>
              <div class="acts">${c.pid ? `<button class="btn sm" data-act="person" data-pid="${c.pid}">逐筆檢視</button>` : ''}${isAdmin() ? `<button class="btn sm" data-act="ack-issue" data-key="${esc(c.key)}" data-msg="${esc(c.msg)}">接受為例外</button>` : ''}</div>
            </div>`).join('')}
            ${afterChanges.map(({ a, S }) => `<div class="coord-item">
              <div>${tag('pl', '送出後變更')}<div style="font-weight:700;margin-top:4px">${a} 送出後又更動 ${S.after} 筆</div><div class="muted small">違規 ${S.v} · 注意 ${S.n}</div></div>
              <div class="muted small">相關：${a}</div>
              <div class="acts">${isAdmin() ? `<button class="btn sm pri" data-act="clear-after" data-area="${a}">標為已看</button>` : ''}</div>
            </div>`).join('')}
            ${!coord.length && !crossList.length && !shortSubmitted.length && !afterChanges.length && !crossP3.length ? '<div class="empty">目前沒有需要協調的事項</div>' : ''}
            ${crossList.length > 8 && !UI.showAll ? `<button class="btn wide" data-act="more">顯示全部碰撞（${crossList.length}）</button>` : ''}
            ${acceptedAcks.length ? `<details><summary>已接受為例外（${acceptedAcks.length}）</summary>
              ${acceptedAcks.map(([k, v]) => `<div class="logrow">${esc(v.msg || k)} · ${esc(v.by || '')} ${isAdmin() ? `<button class="link" data-act="unack-issue" data-key="${esc(k)}">撤銷例外</button>` : ''}</div>`).join('')}</details>` : ''}
          </section>
        </div>
        <aside class="split-side">
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
      const relProp = Object.values(D().proposals || {}).find((p) => p.status !== 'resolved' && p.slotIds && c.slots.some((sid) => p.slotIds.includes(sid)));
      asks.push({
        cls: 'bad', tag: '同日衝突', t: c.msg, d: relProp ? `已有提案 ${relProp.id}：${relProp.title}` : '建議透過「提出調整」試算換區或換日方案。',
        acts: relProp ? `<a class="btn sm blue-out" href="#/p/${relProp.id}">處理提案 ${relProp.id}</a>` : `<a class="btn sm blue-out" href="#/p/new?area=${area}&slot=${c.slots[0] || ''}&type=換區">提出調整</a>`
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
    // 3) 預排待確認
    for (const x of S.dated) for (const pid in (D().assign || {})[x.s.id] || {}) {
      if (D().assign[x.s.id][pid].pre) {
        const p = M.pById[pid];
        asks.push({
          cls: 'pre', tag: '預排', t: `調度台預排 ${p ? p.n : pid}，等區長確認`, d: `${slotName(x.s)}。只有區長能確認或重排。`,
          acts: isLead(area) ? `<button class="btn sm pri" data-act="pre-ok" data-kind="assign" data-key="${x.s.id}" data-pid="${pid}" data-area="${area}" data-label="${esc(slotName(x.s))}">確認</button>
            <button class="btn sm" data-act="rm" data-kind="assign" data-key="${x.s.id}" data-pid="${pid}" data-area="${area}" data-label="${esc(slotName(x.s))}">重排</button>` : `<a class="btn sm" href="#/s/${x.s.id}">查看</a>`
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
    const relProps = Object.values(D().proposals || {}).filter((p) => p.area === area || (p.targetAreas || []).includes(area) || p.area === '總召')
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
              return `<a class="mem" style="text-decoration:none;color:inherit" href="#/p/${p.id}">
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
    const allProps = Object.values(D().proposals || {}).sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || b.at - a.at);
    const [rawId, qs] = (arg || '').split('?');
    const qParams = new URLSearchParams(qs || '');

    // 新增提案表單
    if (rawId === 'new') {
      const defArea = qParams.get('area') || defaultArea();
      const defSlot = qParams.get('slot') || '';
      const defType = qParams.get('type') || '換區';
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

    const pr = (rawId && (D().proposals || {})[rawId]) || (D().proposals || {}).D10 || allProps[0];
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
      <button class="btn blue" data-act="add-prop-opt" data-pid="${pr.id}">加入並重新試算</button>
    </section>` : '';

    // 相關區表態
    const replyAreas = uniq([pr.area].concat(pr.targetAreas || [], ['排班總召']).filter((a) => AREAS.includes(a) || a === '排班總召'));
    const votes = pr.votes || {};
    const myVoteArea = isAdmin() ? '排班總召' : myAreas().find((a) => replyAreas.includes(a));
    const talks = Object.entries(pr.talk || {}).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));

    return `${wsHeader('P', 'b2', AREAS.includes(pr.area) ? pr.area : defaultArea())}<main class="wide-main">
      <div class="tabs-pill">
        ${allProps.map((p) => `<a href="#/p/${p.id}" class="${p.id === pr.id ? 'on' : ''}">${esc(p.id)} ${esc(p.title.slice(0, 14))}${p.title.length > 14 ? '…' : ''}</a>`).join('')}
        <a href="#/p/new" style="border-color:var(--info);color:var(--info)">＋ 提出新調整</a>
      </div>

      <div class="page-head">
        <div>
          <div class="muted small">${AREAS.includes(pr.area) ? `<a href="#/b1/${pr.area}">本區首頁</a>` : `<a href="#/">總覽</a>`} ／ 提案 ${esc(pr.id)}</div>
          <h1>${esc(pr.title)}</h1>
          <p class="muted" style="margin:4px 0 0">${esc(pr.byName)}提出 · 類型「${esc(pr.type)}」· 原因：${esc(pr.reason)}</p>
        </div>
        <div class="acts">${stBadge}${pr.status === 'resolved' && isAdmin() ? `<button class="btn sm" data-act="revert-prop" data-pid="${pr.id}">還原決議前版本</button>` : ''}</div>
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
                : `<button class="btn sm ${idx === bestIdx ? 'blue' : ''}" data-act="adopt-prop" data-pid="${pr.id}" data-oid="${o.id}">採用${esc(o.label.slice(0, 1))}</button>`}</div>`).join('')}
            </div>
          </div></div>
          ${addOptForm}

          <section class="card"><h2>討論</h2>
            ${talks.map(([, m]) => `<div class="talk-row"><div><b class="c-${esc(m.area)}">${esc(m.who)}</b><div class="muted small">${ago(m.at)}</div></div><div>${esc(m.text)}</div></div>`).join('') || '<div class="muted small">尚無留言</div>'}
            ${me() ? `<label>留言<textarea id="propTalkTxt" rows="2" placeholder="寫下本區的情況或條件"></textarea></label>
              <button class="btn blue-out" style="align-self:flex-start" data-act="send-talk" data-pid="${pr.id}">送出留言</button>` : '<div class="muted small">登入後可留言</div>'}
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
              <div class="acts">${opts.map((o) => `<button class="btn sm" data-act="vote-prop" data-pid="${pr.id}" data-area="${esc(myVoteArea)}" data-st="同意${esc(o.label.slice(0, 1))}">同意${esc(o.label.slice(0, 1))}</button>`).join('')}
                <button class="btn sm" data-act="vote-prop" data-pid="${pr.id}" data-area="${esc(myVoteArea)}" data-st="待討論">待討論</button></div>
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
    return `<div class="sheet-bg" data-act="close-person"></div><aside class="sheet" role="dialog" aria-label="${esc(p.n)} 的全年排班">
      <div class="mem-h"><h2>${esc(p.n)}</h2><span class="muted">${esc(p.a)}${roleOf(p) ? ' · ' + esc(roleOf(p)) : ''}</span><button class="btn sm" data-act="close-person">關閉</button></div>
      <div class="muted small">全年 ${occ} 次（上限 ${cap.max}）· 已排 ${L.length} 筆${p.off ? ' · 暫停排班' : ''}</div>
      ${issueLines(iss, 6)}
      <h3>全年排班</h3>${otherWork(pid, [], null) || '<div class="empty">還沒有排班</div>'}
      ${editable ? `<h3>人員狀態（只有排班人員看得到）</h3>
        <label class="ck"><input type="checkbox" data-act-change="pov-off" data-pid="${pid}" ${o.off ? 'checked' : ''}> 暫停排班</label>
        <label>個人全年上限（次）<input type="number" min="0" max="30" value="${esc(o.cap || '')}" data-act-change="pov" data-pid="${pid}" data-k="cap"></label>
        <label>不方便的月份（用空白分開，例：6 7 8）<input type="text" value="${esc((o.months || []).join(' '))}" data-act-change="pov-months" data-pid="${pid}"></label>
        <label>備註<input type="text" value="${esc(o.note || '')}" data-act-change="pov" data-pid="${pid}" data-k="note"></label>` : ''}
    </aside>`;
  }

  /* ---------------- 路由與繪製 ---------------- */
  let lastRoute = '';
  function route() {
    const raw = location.hash.replace(/^#\/?/, '');
    const qIdx = raw.indexOf('?');
    const pathPart = decodeURIComponent(qIdx >= 0 ? raw.slice(0, qIdx) : raw);
    const qs = qIdx >= 0 ? raw.slice(qIdx + 1) : '';
    const [v, ...rest] = (pathPart || '').split('/');
    return { v: v || '', arg: rest.join('/') + (qs ? '?' + qs : ''), pathArg: rest.join('/') };
  }
  function render() {
    const appEl = $('#app');
    if (!store.ready) { appEl.innerHTML = '<div class="empty">載入中…</div>'; return; }
    recompute();
    const r = route(), key = r.v + '/' + r.pathArg;
    if (key !== lastRoute) {
      UI.q = ''; UI.out = false; UI.outQ = ''; UI.showAll = false; UI.filter = '全部';
      UI.apptQ = ''; UI.b6Mode = ''; UI.b1NomOpen = false; UI.pAddOptOpen = false;
      lastRoute = key; window.scrollTo(0, 0); onEnter(r);
    }
    const wide = ['review', 'b1', 'p'].includes(r.v);
    appEl.className = wide ? 'wide-app' : '';
    const ae = document.activeElement, keepId = ae && ae.id, pos = ae && ae.selectionStart;
    const sc = window.scrollY;
    let html;
    if (r.v === 'login' || r.v === 'bind') html = vLogin();
    else if (r.v === 'a' && WORK_AREAS.includes(r.pathArg)) html = vArea(r.pathArg);
    else if (r.v === 'b1') html = vAreaLead(r.pathArg);
    else if (r.v === 'p') html = vProposal(r.arg);
    else if (r.v === 'g') html = vGroup(r.pathArg);
    else if (r.v === 's') html = vSlot(r.pathArg);
    else if (r.v === 't' && WORK_AREAS.includes(r.pathArg)) html = vTeam(r.pathArg);
    else if (r.v === 'review') html = vReview();
    else html = vHome();
    appEl.innerHTML = html + (UI.person ? personSheet(UI.person) : '') + (UI.acctOpen && !['login', 'bind'].includes(r.v) ? accountSheet() : '') + `<div id="toast" role="status" hidden></div>` + (store.error ? `<div class="errbar">${esc(store.error)}</div>` : '');
    if (keepId) { const el = document.getElementById(keepId); if (el) { el.focus(); try { if (pos != null && el.setSelectionRange) el.setSelectionRange(pos, pos); } catch (e) { } } }
    window.scrollTo(0, sc);
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
    if (a === 'seed') seedDefaults().then(() => toast('已帶入 115 年組別名單與初始提案'));
    else if (a === 'local-in') store.signIn(JSON.parse(d.who)).then(() => { location.hash = '#/'; });
    else if (a === 'in') store.signIn(d.kind).catch((e) => toast('登入沒有完成：' + (e.code || e.message)));
    else if (a === 'signout') { UI.acctOpen = false; beat('', ''); store.signOut(); }
    else if (a === 'open-acct') { UI.acctOpen = true; render(); }
    else if (a === 'close-acct') { UI.acctOpen = false; render(); }
    else if (a === 'toggle-auto-bind') setAutoApproveBind(!autoApproveBind());
    else if (a === 'bind-me') bindPersonToMe(+d.pid);
    else if (a === 'apply-new-person') applyNewPerson($('#newPerName').value, $('#newPerArea').value, $('#newPerSx').value, $('#newPerNote').value);
    else if (a === 'add-fam') toggleFamily(+d.pid, true);
    else if (a === 'rm-fam') toggleFamily(+d.pid, false);
    else if (a === 'approve-bind') approveBind(d.uid, d.ok === '1');
    else if (a === 'filter') { UI.filter = d.v; render(); }
    else if (a === 'more') { UI.showAll = true; render(); }
    else if (a === 'out') { UI.out = d.v === '1'; UI.showAll = false; render(); const el = document.getElementById(UI.out ? 'outQ' : 'q'); if (el) el.focus(); }
    else if (a === 'person') { UI.person = +d.pid; render(); }
    else if (a === 'close-person') { UI.person = null; render(); }
    else if (a === 'add') { if (need(can(d.area, d.kind === 'groups' ? kindOfGroup(d.key) : 'jz'))) addPerson(d.kind, d.key, +d.pid, d.area, d.label); }
    else if (a === 'rm') { if (need(can(d.area, d.kind === 'groups' ? kindOfGroup(d.key) : 'jz'))) removePerson(d.kind, d.key, +d.pid, d.area, d.label); }
    else if (a === 'pre-ok') { if (need(isLead(d.area) || (isAdmin() && !AREAS.includes(d.area)), '預排必須由區長確認')) confirmPre(d.kind, d.key, +d.pid, d.area, d.label); }
    else if (a === 'pre-all-ok') {
      if (!need(isLead(d.area) || isAdmin(), '預排必須由區長確認')) return;
      const up = {};
      for (const pid in (D().assign || {})[d.sid] || {}) {
        const r = D().assign[d.sid][pid];
        if (r && r.pre) { const nx = Object.assign({}, r); delete nx.pre; nx.okBy = me().name; nx.okAt = Date.now(); up[`assign/${d.sid}/${pid}`] = nx; }
      }
      store.update(Object.assign(up, logOp(d.area, `${d.label} 確認全部預排`))); toast('已確認全部預排');
    }
    else if (a === 'pre-all-rm') {
      if (!need(isLead(d.area) || isAdmin())) return;
      const up = {}, undo = {};
      for (const pid in (D().assign || {})[d.sid] || {}) {
        const r = D().assign[d.sid][pid];
        if (r && r.pre) { const path = `assign/${d.sid}/${pid}`; up[path] = null; undo[path] = r; }
      }
      store.update(Object.assign(up, logOp(d.area, `${d.label} 移出全部預排`, undo), touchArea(d.area))); toast('已移出預排人員');
    }
    else if (a === 'last-year') bringLastYearGroup(d.gk);
    else if (a === 'auto-posts') autoAssignRitualPosts(d.gk);
    else if (a === 'b6-mode') { UI.b6Mode = UI.b6Mode === d.v ? '' : d.v; render(); }
    else if (a === 'set-lead') {
      const gm = gmOf(d.gk), p = M.pById[+d.pid];
      if (!gm || !p || !need(can(gm.area, kindOfGroup(d.gk)))) return;
      store.update(Object.assign({ [`groupMeta/${d.gk}/leadPid`]: +d.pid }, logOp(gm.area, `${gm.name} 改由 ${p.n} 帶隊`)));
      UI.b6Mode = ''; toast(`已設定 ${p.n} 帶隊`);
    }
    else if (a === 'move-mem') moveGroupMember(d.gk, $('#mvToGk').value, $('#mvPid').value);
    else if (a === 'slot-last-year') bringLastYearSlot(d.sid);
    else if (a === 'slot-autofill') autoFillSlot(d.sid);
    else if (a === 'coord') {
      const id = store.pushId();
      store.update(Object.assign({ ['coord/' + id]: { area: d.area, pid: +d.pid, label: d.label, msg: d.msg, uid: me().uid, name: me().name, at: Date.now(), st: 'open' } }, logOp(d.area, `${d.label} 請總召協調：${d.msg}`)));
      toast('已送給總召');
    }
    else if (a === 'coord-done') { if (need(isAdmin())) store.update({ [`coord/${d.id}/st`]: 'done', [`coord/${d.id}/doneBy`]: me().name }); }
    else if (a === 'ack-issue') { if (need(isAdmin())) { store.set(`acks/${d.key}`, { st: '接受例外', by: me().name, at: Date.now(), msg: d.msg }); toast('已標記為接受例外'); } }
    else if (a === 'unack-issue') { if (need(isAdmin())) { store.set(`acks/${d.key}`, null); toast('已撤銷例外'); } }
    else if (a === 'clear-after') { if (need(isAdmin())) { store.set(`areas/${d.area}/after`, 0); toast(`已標記 ${d.area} 送出後變更為已看`); } }
    else if (a === 'toggle-a6-remind') { UI.a6RemindOpen = !UI.a6RemindOpen; render(); }
    else if (a === 'toggle-a6-pick') { UI.a6PickAreaOpen = !UI.a6PickAreaOpen; render(); }
    else if (a === 'copy-remind') { if (navigator.clipboard) navigator.clipboard.writeText(d.text).catch(() => {}); toast('已複製提醒訊息'); }
    else if (a === 'open-nom') { UI.b1NomOpen = true; render(); }
    else if (a === 'close-nom') { UI.b1NomOpen = false; render(); }
    else if (a === 'save-nom') {
      if (!need(isLead(d.area) || isAdmin())) return;
      store.update(Object.assign({ [`nominations/${d.area}`]: { leads: $('#nomLeads').value.trim(), cooks: $('#nomCooks').value.trim(), updatedBy: me().name, updatedAt: Date.now() } },
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
      const txt = ($('#propTalkTxt').value || '').trim(); if (!txt) return toast('請輸入留言內容');
      const tid = store.pushId(), area = isAdmin() ? '總召' : (myAreas()[0] || (myBoundPerson() && myBoundPerson().p ? myBoundPerson().p.a : ''));
      store.set(`proposals/${d.pid}/talk/${tid}`, { who: me().name, area, at: Date.now(), text: txt });
      toast('已送出留言');
    }
    else if (a === 'vote-prop') {
      if (!me()) return toast('請先登入');
      store.set(`proposals/${d.pid}/votes/${d.area}`, { st: d.st, by: me().name, at: Date.now() });
      toast(`已表態：${d.st}`);
    }
    else if (a === 'join') { store.set(`members/${d.area}/${me().uid}`, { name: me().name, role: 'sched', status: 'pending', at: Date.now() }); toast('已送出申請'); }
    else if (a === 'approve') { if (need(isLead(d.area) || isAdmin())) { const m = memberOf(d.area, d.uid); store.update({ [`members/${d.area}/${d.uid}`]: Object.assign({}, m, { status: 'ok', by: me().name }), ['sched/' + d.uid]: true }); } }
    else if (a === 'appoint') {
      if (!need(d.role === 'lead' ? isAdmin() : isLead(d.area) || isAdmin())) return;
      const u = (D().users || {})[d.uid];
      store.update(Object.assign({ [`members/${d.area}/${d.uid}`]: { name: u.name, role: d.role, status: 'ok', by: me().name, at: Date.now() }, ['sched/' + d.uid]: true }, logOp(d.area, `指定 ${u.name} 為${d.role === 'lead' ? '區長' : '排班人員'}`)));
      UI.apptQ = ''; toast('已指定');
    }
    else if (a === 'unmember') {
      const m = memberOf(d.area, d.uid); if (!m || !need(m.role === 'lead' ? isAdmin() : isLead(d.area) || isAdmin())) return;
      if (!confirm(`取消 ${m.name} 在 ${d.area} 的排班權限？`)) return;
      const still = WORK_AREAS.some((x) => x !== d.area && memberOf(x, d.uid) && memberOf(x, d.uid).status === 'ok');
      store.update(Object.assign({ [`members/${d.area}/${d.uid}`]: null }, still ? {} : { ['sched/' + d.uid]: null }, logOp(d.area, `取消 ${m.name} 的排班權限`)));
    }
    else if (a === 'submit') { if (need(isLead(d.area), '只有區長能送出')) { store.update(Object.assign({ ['areas/' + d.area]: { status: 'submitted', by: me().name, at: Date.now(), after: 0 } }, logOp(d.area, '送出給總召確認'))); toast('已送出'); } }
    else if (a === 'unsubmit') { if (need(isLead(d.area))) store.update(Object.assign({ ['areas/' + d.area]: { status: 'editing', by: me().name, at: Date.now() } }, logOp(d.area, '收回，繼續排'))); }
    else if (a === 'confirm-area') { if (need(isAdmin())) store.update(Object.assign({ ['areas/' + d.area]: { status: 'confirmed', by: me().name, at: Date.now(), after: 0 } }, logOp(d.area, '總召確認'))); }
    else if (a === 'return-area') { if (need(isAdmin())) { const why = prompt('退回的原因（會記在改動紀錄）') || ''; store.update(Object.assign({ ['areas/' + d.area]: { status: 'editing', by: me().name, at: Date.now() } }, logOp(d.area, '總召退回' + (why ? '：' + why : '')))); } }
    else if (a === 'undo') {
      const l = (D().log || {})[d.id]; if (!l || !l.undo || !need(can(l.area, 'jz'))) return;
      store.update(Object.assign({}, l.undo, { [`log/${d.id}/undone`]: me().name }, logOp(l.area, `復原「${l.msg}」`))); toast('已復原');
    }
  });

  document.addEventListener('input', (ev) => {
    const k = ev.target.dataset && ev.target.dataset.input; if (!k) return;
    UI[k] = ev.target.value.trim(); UI.showAll = false; render();
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target, a = t.dataset && t.dataset.actChange; if (!a) return;
    const d = t.dataset;
    if (a === 'outArea') { UI.outArea = t.value; render(); }
    else if (a === 'b1-area') { location.hash = '#/b1/' + t.value; }
    else if (a === 'b1-cook') { UI.b1ShowCook = t.checked; render(); }
    else if (a === 'set-post') {
      const gm = gmOf(d.gk); if (!gm || !need(can(gm.area, 'lj'))) return render();
      store.set(`groupMeta/${d.gk}/posts/${d.post}`, t.value ? +t.value : null);
      toast(`已設定「${d.post}」`);
    }
    else if (a === 'scope') {
      if (!need(isLead(d.area) || isAdmin())) return render();
      const m = memberOf(d.area, d.uid), sc = m.scope ? Object.assign({}, m.scope) : Object.fromEntries(KINDS.map(([k]) => [k, true]));
      sc[d.k] = t.checked;
      const all = KINDS.every(([k]) => sc[k]);
      store.set(`members/${d.area}/${d.uid}/scope`, all ? null : sc);
    }
    else if (a === 'pov-off' || a === 'pov' || a === 'pov-months') {
      const p = M.pById[+d.pid]; if (!need(can(p.a, 'pov'))) return render();
      const o = Object.assign({}, (D().pov || {})[d.pid] || {});
      if (a === 'pov-off') o.off = t.checked; else if (a === 'pov-months') o.months = t.value.split(/[\s,，、]+/).map(Number).filter((n) => n >= 1 && n <= 12); else o[d.k] = t.value;
      for (const k of Object.keys(o)) if (o[k] === '' || o[k] === false || (Array.isArray(o[k]) && !o[k].length)) delete o[k];
      store.update(Object.assign({ ['pov/' + d.pid]: Object.keys(o).length ? o : null }, logOp(p.a, `更新 ${p.n} 的人員狀態`)));
    }
  });

  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (UI.person) { UI.person = null; render(); }
      else if (UI.acctOpen) { UI.acctOpen = false; render(); }
    }
  });

  store.onChange(render);
  store.init().then(() => {
    if (store.mode === 'local' && !(store.data.meta || {}).seeded) seedDefaults();
    else if (store.mode === 'local' && !Object.keys(store.data.proposals || {}).length) {
      const initP = buildInitialProposals(), up = {};
      for (const id in initP) up['proposals/' + id] = initP[id];
      store.update(up);
    }
    render();
  }).catch((e) => { $('#app').innerHTML = `<div class="iss bad">無法啟動：${esc(e.message)}</div>`; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => { });
  window.__td = {
    store, E,
    get M() { return M; }, get ISS() { return ISS; },
    recompute, seedDefaults, areaStats, areaMetrics,
    simulateProposalOption, buildInitialProposals,
    autoApproveBind, setAutoApproveBind,
    bindPersonToMe, applyNewPerson, toggleFamily, approveBind,
    bringLastYearGroup, autoAssignRitualPosts, moveGroupMember,
    bringLastYearSlot, autoFillSlot, adoptProposalOption, revertProposal
  };
})();
