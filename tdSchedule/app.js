/* 天達堂 116 年排班台 PWA - 主控與排班引擎 */
(() => {
  'use strict';

  const BASE = window.BASE_DATA;
  const AREAS = ['瑞芳', '內湖', '松山', '三重', '基隆', '新莊'];
  const ALL_WORK_AREAS = ['瑞芳', '內湖', '松山', '三重', '基隆', '新莊', '青年班', '新民班', '機動', '交通隊'];
  const PERSON_AREAS = ['瑞芳', '內湖', '松山', '三重', '基隆', '新莊', '青年班', '新民班', '天達', '金門'];
  const SPECIAL_AREAS = ['機動', '交通隊', '青年班', '新民班'];
  const CATS = ['廚務', '會館輪廚', '環境整理', '服務', '禮節', '洗碗', '忠恕平日', '忠恕週六', '忠恕週日', '大典前晚', '協辦', '交通'];
  const JOB_CLASSES = ['主廚', '大廚', '二廚', '服務', '禮節', '忠恕', '交通', '其他'];
  const SEVS = ['違規', '注意', '關閉'];
  const ACK_ST = ['未處理', '協調中', '已協調', '接受例外'];
  const VIEWS = ['area', 'ungrouped', 'schedule', 'overview', 'issues', 'settings'];
  const STORAGE_KEY = 'tdt-pwa-v1';
  const FILTER_KEY = 'tdt-pwa-filters-v1';

  const WD = '日一二三四五六';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 日期工具 ---------- */
  function dn(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; }
  function ds(n) { return new Date(n * 864e5).toISOString().slice(0, 10); }
  function wdOf(s) { return new Date(dn(s) * 864e5).getUTCDay(); }
  function fmtD(s) { const [y, m, d] = s.split('-').map(Number); return (y >= 2028 ? (y - 1911) + '/' : '') + m + '/' + d; }
  function splitList(t) { return String(t || '').split(/[\s,，、;；\n\r]+/).map(x => x.trim()).filter(Boolean); }

  /* ---------- 預設規則 ---------- */
  function defaultRules() {
    const m = {};
    const set = (a, b, v) => { m[a + '|' + b] = v; m[b + '|' + a] = v; };
    for (const a of JOB_CLASSES) for (const b of JOB_CLASSES) m[a + '|' + b] = '違規';
    set('服務', '禮節', '允許'); set('服務', '二廚', '允許'); set('禮節', '二廚', '允許');
    set('交通', '服務', '注意'); set('交通', '禮節', '注意'); set('忠恕', '二廚', '注意');
    return {
      v: 1,
      sev: {
        A1: '違規', A2: '違規', A3: '違規', A4: '違規', A5: '違規', A5b: '注意', A6: '違規', A7: '注意', A8: '注意', A9: '注意', A10: '違規', A11: '注意',
        P2: '違規', P3: '違規', P3b: '注意', P4: '違規', P4b: '關閉', P5: '違規', P5b: '注意', P6: '注意', P7: '違規', P8: '注意', P9: '注意', P10: '注意', P11: '注意', P12: '注意'
      },
      p: {
        mdDates: (BASE.mingde || []).join(' '),
        xzDates: (BASE.xzmd || []).join(' '),
        holidays: Object.keys(BASE.hol || {}).join(' '),
        weekdayOnlyAreas: '基隆', noCookAreas: '松山 新莊',
        jzMax: 2, cookGap: 7, densDays: 7, densMax: 3, jzDiff: 1,
        hard: 7, soft: 30, satSunExempt: true,
        cookIdeal: 6, cookMax: 10, otherIdeal: 4, otherMax: 6,
        wdMax: 3, wdScope: '上班或未填', hotelDays: 3,
        oldAge: 80, minorAge: 18,
        shortRatio: 1, skipEmpty: true,
        wLoad: 6, wSoft: 12, wAff: 25, wCross: 40, wNew: 3, wMismatch: 15, allowCross: false, wholeGroup: true
      },
      mx: m
    };
  }

  const RULE_META = [
    { id: 'A1', lv: '區', name: '同一區同一天只負責一項', desc: '同區同日不能同時有兩種任務（廚務、服務、禮節、洗碗、忠恕、前晚、協辦）。同區多組廚務支援同一場活動不算。' },
    { id: 'A2', lv: '區', name: '明德班日不排該區', desc: '明德班日（第 2 週六，7 月不上課）只排新莊；新莊明德班日（第 4 週日）不排新莊。' },
    { id: 'A3', lv: '區', name: '週六環境整理與週日服務不同區', desc: '同一個週末的環境整理（六）與服務（日）由不同區負責。' },
    { id: 'A4', lv: '區', name: '指定區只排忠恕平日', desc: '例如基隆只排週三到週五的忠恕平日小隊。', params: [['weekdayOnlyAreas', '區（空白分隔）', 'text']] },
    { id: 'A5', lv: '區', name: '忠恕同一梯同區天數上限', desc: '同一梯（週三到週日）同一區最多出幾天。', params: [['jzMax', '最多天數', 'num']] },
    { id: 'A5b', lv: '區', name: '忠恕同一梯同區連兩天', desc: '同一梯中同一區排在相鄰兩天。' },
    { id: 'A6', lv: '區', name: '忠恕週六、週日不同區', desc: '同一梯的週六大區與週日區不能是同一區。' },
    { id: 'A7', lv: '區', name: '同一廚務組出勤間隔', desc: '同一廚務組（機動組除外）在幾天內出勤兩次。同組同日兩處一律列為違規。', params: [['cookGap', '天數內', 'num']] },
    { id: 'A8', lv: '區', name: '各區出勤密度', desc: '同一區在連續幾天內出勤超過幾次（多日活動算 1 次）。', params: [['densDays', '連續天數', 'num'], ['densMax', '最多次數', 'num']] },
    { id: 'A9', lv: '區', name: '禮節、洗碗連兩場同區', desc: '依日期排序，相鄰兩場禮節（或洗碗）是同一區。' },
    { id: 'A10', lv: '區', name: '沒有廚務組的區不排廚務', desc: '', params: [['noCookAreas', '區（空白分隔）', 'text']] },
    { id: 'A11', lv: '區', name: '假日忠恕各區次數平均', desc: '五個大區的忠恕週六＋週日次數，最多與最少相差超過幾次就提醒。', params: [['jzDiff', '容許差距', 'num']] },
    { id: 'P1', lv: '人', name: '同日兼職（C8）', desc: '同一人同一天有兩項工作時，依下方對照表判斷允許、注意或違規。', matrix: true },
    { id: 'P2', lv: '人', name: '同日跨地點', desc: '同一人同一天被排在兩個不同地點（天達堂、道院、會館、德光）。' },
    { id: 'P3', lv: '人', name: '兩次服務間隔（C10）嚴重', desc: '兩次服務相隔天數在此以內。多日活動算一次；同日兼職算一次。', params: [['hard', '天數以內', 'num'], ['satSunExempt', '週六環境整理接週日不計', 'bool']] },
    { id: 'P3b', lv: '人', name: '兩次服務間隔（C10）提醒', desc: '超過嚴重天數、但在此天數以內。', params: [['soft', '天數以內', 'num']] },
    { id: 'P4', lv: '人', name: '主廚、大廚只做廚務（C12）', desc: '主廚、大廚被排到廚務以外的工作。' },
    { id: 'P4b', lv: '人', name: '所有廚務人員只做廚務（C12 理想）', desc: '二廚也只做廚務。預設關閉。' },
    { id: 'P5', lv: '人', name: '年度次數上限（C13）', desc: '超過最小情境上限。同日兼職、多日活動都算 1 次。', params: [['cookMax', '廚務人員上限', 'num'], ['otherMax', '其他人員上限', 'num']] },
    { id: 'P5b', lv: '人', name: '年度次數理想值（C13）', desc: '超過理想次數。', params: [['cookIdeal', '廚務人員理想', 'num'], ['otherIdeal', '其他人員理想', 'num']] },
    { id: 'P6', lv: '人', name: '平日天數上限（C14）', desc: '還在上班的人平日服務要請假。會館輪廚依天數計。', params: [['wdMax', '每年最多平日天數', 'num'], ['wdScope', '適用對象', 'sel', ['只限上班中', '上班或未填', '全部']]] },
    { id: 'P7', lv: '人', name: '本人不可排的日期或月份', desc: '在人員設定的不可排日期、不方便月份、暫停排班。' },
    { id: 'P8', lv: '人', name: '高齡、未成年提醒（C2）', desc: '', params: [['oldAge', '幾歲以上提醒', 'num'], ['minorAge', '未滿幾歲提醒', 'num']] },
    { id: 'P9', lv: '人', name: '跨區支援', desc: '人員所屬區與該格負責區不同（機動組、交通隊、廚務跨區支援除外）。' },
    { id: 'P10', lv: '人', name: '專長不符', desc: '禮節無經驗且未編入禮節隊、非本組人員支援廚務、無交通經驗排交通。' },
    { id: 'P11', lv: '格', name: '人數不足', desc: '已排人數低於需求人數 × 比例。', params: [['shortRatio', '比例（1＝滿額）', 'num'], ['skipEmpty', '尚未排人的格不列入', 'bool']] },
    { id: 'P12', lv: '格', name: '缺帶隊', desc: '廚務缺主廚、其他隊伍缺對應的小組長或組長。' }
  ];

  const AUTO_PARAMS = [
    ['wholeGroup', '廚務依組別整組帶入', 'bool'],
    ['allowCross', '本區人數不足時找其他區', 'bool'],
    ['wLoad', '平均分配（次數越多越不優先）', 'num'],
    ['wSoft', '每一項「注意」扣分', 'num'],
    ['wAff', '固定搭檔加分（親和分數 × 權重）', 'num'],
    ['wCross', '跨區扣分', 'num'],
    ['wMismatch', '專長不符扣分', 'num'],
    ['wNew', '新人扣分（負數＝優先新人）', 'num']
  ];

  /* ---------- 狀態與儲存 ---------- */
  function cloneDefaultGroups() {
    const g = {};
    for (const gm of BASE.groupsMeta) {
      g[gm.id] = (BASE.defaultGroups[gm.id] || []).slice();
    }
    return g;
  }

  function freshState() {
    return {
      rules: defaultRules(),
      edits: {},
      extra: {},
      groups: cloneDefaultGroups(),
      slotMod: {},
      assign: {},
      addedPeople: [],
      peopleEdits: {},
      pov: {},
      acks: {},
      decisions: {},
      log: [],
      theme: 'auto',
      largeMode: false
    };
  }

  function mergeRules(r) {
    const d = defaultRules();
    if (!r) return d;
    return {
      v: 1,
      sev: Object.assign(d.sev, r.sev || {}),
      p: Object.assign(d.p, r.p || {}),
      mx: Object.assign(d.mx, r.mx || {})
    };
  }

  let st = freshState();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) {
      st = Object.assign(freshState(), saved);
      st.rules = mergeRules(saved.rules);
      const defG = cloneDefaultGroups();
      st.groups = Object.assign(defG, saved.groups || {});
    }
  } catch (e) { }

  const F = {
    area: '瑞芳',
    areaTab: 'groups', // 'groups' | 'ungrouped' | 'people'
    ugCat: '忠恕',
    ugWave: '',
    ugArea: '',
    ugSt: '',
    schedMode: 'list', // 'list' | 'matrix'
    month: '',
    areaF: '',
    cat: '',
    only: '',
    q: '',
    issTab: 'rules', // 'rules' | 'disc'
    ilvl: '',
    iscope: '',
    irule: '',
    iarea: '',
    ist: '未結',
    prole: '',
    psort: 'occ',
    pq: '',
    cq: '',
    call: false
  };
  try { Object.assign(F, JSON.parse(localStorage.getItem(FILTER_KEY) || '{}')); } catch (e) { }

  function saveF() { try { localStorage.setItem(FILTER_KEY, JSON.stringify(F)); } catch (e) { } }
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      const sy = $('#sync');
      if (sy) sy.innerHTML = `<span class="dot on"></span>已儲存於本機`;
    } catch (e) {
      toast('本機儲存空間不足，請匯出 JSON 備份');
    }
  }

  function applyTheme() {
    if (st.theme === 'dark' || st.theme === 'light') {
      document.documentElement.setAttribute('data-theme', st.theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
  function applyLargeMode() {
    const on = !!st.largeMode;
    if (on) document.documentElement.setAttribute('data-large', '1');
    else document.documentElement.removeAttribute('data-large');
    const b = $('#btnLarge');
    if (b) {
      b.textContent = on ? '標準版' : '大字版';
      b.classList.toggle('pri', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  applyTheme();
  applyLargeMode();

  /* ---------- 組別對應 ---------- */
  const GROUP_META_BY_ID = {};
  BASE.groupsMeta.forEach(g => { GROUP_META_BY_ID[g.id] = g; });

  function resolveSlotGroupKey(s) {
    if (!s) return '';
    if (s.cat === '廚務' || s.cat === '會館輪廚') {
      if (s.area === '機動' || s.grp === '機動') return 'k_機動';
      if (['1', '2', '3', '4', '5', '6', '7'].includes(String(s.grp))) return 'k_' + s.grp;
      return '';
    }
    if (s.cat === '環境整理' || s.cat === '服務') {
      if (['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].includes(String(s.grp))) return 'srv_' + s.grp;
      return '';
    }
    if (s.cat === '禮節') {
      if (s.grp === '基新' || s.grp === '基新隊') {
        if (s.area === '基隆') return 'lj_基新_基隆';
        if (s.area === '新莊') return 'lj_基新_新莊';
        return '';
      }
      if (/^(松山|三重|瑞芳|內湖)[12]$/.test(String(s.grp))) return 'lj_' + s.grp;
      return '';
    }
    if (s.cat === '交通') {
      if (s.grp === '天達交通隊') return 'tr_天達交通隊';
      if (s.grp === '道院交通') return 'tr_道院交通';
      return '';
    }
    return '';
  }

  function defaultGroupForAreaCat(area, cat) {
    if (cat === '環境整理' || cat === '服務') {
      return { 松山: 'A', 三重: 'C', 瑞芳: 'E', 內湖: 'G', 新莊: 'I', 基隆: 'J' }[area] || '';
    }
    if (cat === '禮節') {
      return { 松山: '松山1', 三重: '三重1', 瑞芳: '瑞芳1', 內湖: '內湖1', 基隆: '基新', 新莊: '基新' }[area] || '';
    }
    if (cat === '廚務' || cat === '會館輪廚') {
      return { 內湖: '1', 瑞芳: '3', 三重: '4', 基隆: '6', 機動: '機動' }[area] || '';
    }
    return '';
  }

  function groupOptionsForSlot(s) {
    if (s.cat === '廚務' || s.cat === '會館輪廚') {
      const m = { 內湖: ['1', '2'], 瑞芳: ['3', '7'], 三重: ['4', '5'], 基隆: ['6'], 機動: ['機動'] };
      return m[s.area] || [];
    }
    if (s.cat === '環境整理' || s.cat === '服務') {
      const m = { 松山: ['A', 'B'], 三重: ['C', 'D'], 瑞芳: ['E', 'F'], 內湖: ['G', 'H'], 新莊: ['I'], 基隆: ['J'] };
      return m[s.area] || [];
    }
    if (s.cat === '禮節') {
      if (s.area === '基隆' || s.area === '新莊') return ['基新'];
      if (['松山', '三重', '瑞芳', '內湖'].includes(s.area)) return [s.area + '1', s.area + '2'];
      return [];
    }
    if (s.cat === '交通') return ['天達交通隊', '道院交通'];
    return [];
  }

  /* ---------- 建立工作模型 ---------- */
  function buildModel() {
    const R = st.rules;
    const holidays = new Set(splitList(R.p.holidays));
    const peopleRaw = BASE.people.concat(st.addedPeople || []);
    const people = peopleRaw.map(p => {
      const pe = (st.peopleEdits || {})[p.id] || {};
      const o = (st.pov || {})[p.id] || {};
      return Object.assign({}, p, pe, {
        work: o.work || '',
        unav: splitList(o.unav),
        months: (o.months || []).map(Number),
        cap: o.cap ? +o.cap : null,
        off: !!o.off,
        pnote: o.note || ''
      });
    });
    const pById = {};
    people.forEach(p => { pById[p.id] = p; });

    // 反向索引：每人目前在哪些組別
    const personGroups = {};
    for (const gk in st.groups) {
      for (const pid of (st.groups[gk] || [])) {
        if (!pById[pid]) continue;
        (personGroups[pid] = personGroups[pid] || []).push(gk);
      }
    }

    const slots = [];
    const all = BASE.slots.concat(Object.values(st.extra || {}));
    for (const b of all) {
      const ed = (st.edits || {})[b.id] || {};
      const s = Object.assign(
        {},
        b,
        ed.area !== undefined ? { area: ed.area } : {},
        ed.grp !== undefined ? { grp: ed.grp } : {},
        ed.need !== undefined && ed.need !== '' ? { need: +ed.need } : {},
        ed.loc ? { loc: ed.loc } : {}
      );
      s.note = ed.note || '';
      s.cancel = !!ed.cancel;
      s.edited = ed.area !== undefined && ed.area !== b.area;
      s.ds = dn(s.d);
      s.de = dn(s.e || s.d);
      s.wd = wdOf(s.d);
      s.wdays = 0;
      for (let x = s.ds; x <= s.de; x++) {
        const k = ds(x), w = wdOf(k);
        if (w >= 1 && w <= 5 && !holidays.has(k)) s.wdays++;
      }
      s.weekday = s.wdays > 0;
      s.groupKey = resolveSlotGroupKey(s);
      slots.push(s);
    }
    slots.sort((a, b) => a.ds - b.ds || CATS.indexOf(a.cat) - CATS.indexOf(b.cat) || a.id.localeCompare(b.id));
    const byId = {};
    slots.forEach(s => { byId[s.id] = s; });

    const aff = {};
    for (const [a, b, v] of BASE.aff) {
      (aff[a] = aff[a] || {})[b] = v;
      (aff[b] = aff[b] || {})[a] = v;
    }

    const asg = {};
    for (const s of slots) {
      if (s.groupKey) {
        const gList = (st.groups[s.groupKey] || []).filter(id => pById[id]);
        const mod = st.slotMod[s.id] || {};
        const ex = mod.exclude || [];
        const inc = (mod.include || []).filter(id => pById[id] && !gList.includes(id));
        const p = gList.filter(id => !ex.includes(id)).concat(inc);
        const lk = (mod.lk || []).filter(id => p.includes(id));
        asg[s.id] = { p, lk, fromGroup: gList, exclude: ex, include: inc };
      } else {
        const a = st.assign[s.id];
        asg[s.id] = a
          ? { p: (a.p || []).filter(id => pById[id]), lk: (a.lk || []).filter(id => pById[id]) }
          : { p: [], lk: [] };
      }
    }

    const M = { R, slots, byId, people, pById, aff, asg, holidays, personGroups };
    M.personSlots = {};
    for (const s of slots) {
      if (s.cancel) continue;
      for (const id of asg[s.id].p) {
        (M.personSlots[id] = M.personSlots[id] || []).push(s);
      }
    }
    for (const k in M.personSlots) M.personSlots[k].sort((a, b) => a.ds - b.ds);
    return M;
  }

  /* ---------- 人員屬性與規則判斷 ---------- */
  function isCookSlot(s) { return s.cat === '廚務' || s.cat === '會館輪廚'; }
  function isCookPerson(M, p) {
    if (p.cr) return true;
    const gs = M.personGroups[p.id] || [];
    return gs.some(gk => gk.startsWith('k_'));
  }
  function isHeadCook(p) { return /主廚|大廚/.test(p.cr || ''); }
  function jobClass(p, s) {
    if (isCookSlot(s)) return /主廚/.test(p.cr || '') ? '主廚' : /大廚/.test(p.cr || '') ? '大廚' : '二廚';
    if (s.cat === '環境整理' || s.cat === '服務' || s.cat === '洗碗') return '服務';
    if (s.cat === '禮節') return '禮節';
    if (s.cat.startsWith('忠恕')) return '忠恕';
    if (s.cat === '交通') return '交通';
    return '其他';
  }
  function canLead(p, s) {
    if (!p) return false;
    if (isCookSlot(s)) return /主廚/.test(p.cr || '');
    if (s.cat === '禮節') return /禮節小組長/.test(p.lead || '');
    if (s.cat.startsWith('忠恕')) return /忠恕小組長/.test(p.lead || '') || /小組長/.test(p.zr || '');
    if (s.cat === '環境整理' || s.cat === '服務') return /服務組長/.test(p.lead || '');
    return false;
  }
  function needsLead(s) {
    return ['廚務', '會館輪廚', '禮節', '忠恕平日', '忠恕週六', '忠恕週日', '環境整理', '服務'].includes(s.cat);
  }
  function slotNeed(M, s) {
    if (isCookSlot(s) && M.R.p.wholeGroup && s.groupKey) {
      const g = (st.groups[s.groupKey] || []).length;
      if (g) return g;
    }
    return +s.need || 0;
  }
  function capOf(M, p) {
    const P = M.R.p;
    if (p.cap) return { ideal: p.cap, max: p.cap };
    return isCookPerson(M, p) ? { ideal: +P.cookIdeal, max: +P.cookMax } : { ideal: +P.otherIdeal, max: +P.otherMax };
  }
  function wdScopeHit(M, p) {
    const sc = M.R.p.wdScope;
    if (sc === '全部') return true;
    if (sc === '只限上班中') return p.work === '上班中';
    return p.work === '上班中' || !p.work;
  }
  function occasions(list) {
    const occ = [];
    for (const s of list) {
      const last = occ[occ.length - 1];
      if (last && s.ds <= last.de) { last.slots.push(s); last.de = Math.max(last.de, s.de); }
      else occ.push({ ds: s.ds, de: s.de, slots: [s] });
    }
    return occ;
  }

  function personIssues(M, p, list) {
    const R = M.R, S = R.sev, P = R.p, out = [];
    const add = (rule, lvl, slots, msg) => {
      if (lvl && lvl !== '關閉' && lvl !== '允許') {
        out.push({ rule, lvl, pid: p.id, slots: slots.map(s => s.id), date: slots[0] ? slots[0].d : '', area: p.a, msg });
      }
    };
    list = list.slice().sort((a, b) => a.ds - b.ds);

    // P7 不可排
    for (const s of list) {
      let why = '';
      if (p.off) why = '暫停排班';
      else {
        for (let x = s.ds; x <= s.de; x++) {
          const k = ds(x);
          if (p.unav.includes(k)) why = fmtD(k) + ' 不可排';
          if (p.months.includes(+k.slice(5, 7))) why = (+k.slice(5, 7)) + ' 月不方便';
        }
      }
      if (why) add('P7', S.P7, [s], `${p.n}：${why}（${s.cat}）`);
    }

    // P1 / P2 同日
    const byDay = {};
    for (const s of list) for (let x = s.ds; x <= s.de; x++) (byDay[x] = byDay[x] || []).push(s);
    const seenPair = new Set();
    for (const x in byDay) {
      const L = byDay[x];
      if (L.length < 2) continue;
      for (let i = 0; i < L.length; i++) {
        for (let j = i + 1; j < L.length; j++) {
          const a = L[i], b = L[j], key = a.id + '|' + b.id;
          if (seenPair.has(key)) continue;
          seenPair.add(key);
          if (a.loc !== b.loc) {
            add('P2', S.P2, [a, b], `${p.n}：同一天在${a.loc}（${a.cat}）與${b.loc}（${b.cat}）`);
            continue;
          }
          const ca = jobClass(p, a), cb = jobClass(p, b);
          const v = R.mx[ca + '|' + cb] || '違規';
          add('P1', v, [a, b], `${p.n}：同日兼 ${a.cat}（${ca}）＋${b.cat}（${cb}）`);
        }
      }
    }

    // P3 間隔
    const occ = occasions(list);
    for (let i = 1; i < occ.length; i++) {
      const a = occ[i - 1], b = occ[i], gap = b.ds - a.de;
      if (P.satSunExempt && gap === 1 && a.slots.some(s => s.cat === '環境整理') && new Date(b.ds * 864e5).getUTCDay() === 0) continue;
      if (gap <= +P.hard) add('P3', S.P3, [a.slots[0], b.slots[0]], `${p.n}：${fmtD(ds(a.de))} → ${fmtD(ds(b.ds))} 只隔 ${gap} 天`);
      else if (gap <= +P.soft) add('P3b', S.P3b, [a.slots[0], b.slots[0]], `${p.n}：${fmtD(ds(a.de))} → ${fmtD(ds(b.ds))} 隔 ${gap} 天`);
    }

    // P4 廚務專職
    for (const s of list) {
      if (isCookSlot(s)) continue;
      if (isHeadCook(p)) add('P4', S.P4, [s], `${p.n}（${p.cr}）被排到${s.cat}`);
      else if (isCookPerson(M, p)) add('P4b', S.P4b, [s], `${p.n}（${p.cr || '廚務組'}）被排到${s.cat}`);
    }

    // P5 年度上限
    const cap = capOf(M, p);
    if (occ.length > cap.max) add('P5', S.P5, [occ[cap.max].slots[0]], `${p.n}：全年 ${occ.length} 次，超過上限 ${cap.max}`);
    else if (occ.length > cap.ideal) add('P5b', S.P5b, [occ[cap.ideal].slots[0]], `${p.n}：全年 ${occ.length} 次，超過理想 ${cap.ideal}`);

    // P6 平日天數
    if (wdScopeHit(M, p)) {
      let w = 0, first = null;
      const seen = new Set();
      for (const s of list) {
        for (let x = s.ds; x <= s.de; x++) {
          const k = ds(x), wd = wdOf(k);
          if (wd >= 1 && wd <= 5 && !M.holidays.has(k) && !seen.has(x)) {
            seen.add(x); w++;
            if (w > +P.wdMax && !first) first = s;
          }
        }
      }
      if (first) add('P6', S.P6, [first], `${p.n}：平日 ${w} 天，超過 ${P.wdMax} 天${p.work ? '' : '（工作狀態未填）'}`);
    }

    // P8 年齡
    if (list.length && p.age) {
      if (p.age >= +P.oldAge) add('P8', S.P8, [list[0]], `${p.n}：${p.age} 歲，排了 ${occ.length} 次`);
      else if (p.age < +P.minorAge) add('P8', S.P8, [list[0]], `${p.n}：${p.age} 歲（未成年）`);
    }

    // P9 跨區 / P10 專長
    const pGroups = M.personGroups[p.id] || [];
    for (const s of list) {
      if (!SPECIAL_AREAS.includes(s.area) && !isCookSlot(s) && p.a !== s.area) {
        add('P9', S.P9, [s], `${p.n}（${p.a}）支援 ${s.area} ${s.cat}`);
      }
      let mm = '';
      if (s.cat === '禮節' && !p.li && !(s.groupKey && pGroups.includes(s.groupKey))) mm = '沒有禮節經驗';
      if (isCookSlot(s) && s.area !== '青年班') {
        const inGroup = (s.groupKey && pGroups.includes(s.groupKey)) || (p.cg || []).includes(String(s.grp)) || (p.cg || []).includes('機動');
        if (!inGroup) mm = `不是${s.grp || ''}組廚務成員`;
      }
      if (s.cat === '交通' && !p.tr && !(s.groupKey && pGroups.includes(s.groupKey))) mm = '沒有交通經驗';
      if (mm) add('P10', S.P10, [s], `${p.n}：${mm}（${s.cat}）`);
    }
    return out;
  }

  function areaIssues(M) {
    const R = M.R, S = R.sev, P = R.p, out = [];
    const add = (rule, lvl, slots, area, msg) => {
      if (lvl && lvl !== '關閉') out.push({ rule, lvl, slots: slots.map(s => s.id), date: slots[0] ? slots[0].d : '', area, msg });
    };
    const L = M.slots.filter(s => !s.cancel && s.area);
    const dist = L.filter(s => AREAS.includes(s.area));

    // A1 同區同日多項
    const byAD = {};
    for (const s of dist) for (let x = s.ds; x <= s.de; x++) {
      const k = s.area + '|' + x;
      (byAD[k] = byAD[k] || []).push(s);
    }
    const a1seen = new Set();
    for (const k in byAD) {
      const G = byAD[k];
      const tasks = {};
      for (const s of G) {
        const t = (isCookSlot(s) ? '廚務' : s.cat) + '@' + s.loc;
        (tasks[t] = tasks[t] || []).push(s);
      }
      if (Object.keys(tasks).length > 1) {
        const sig = G.map(s => s.id).sort().join();
        if (a1seen.has(sig)) continue;
        a1seen.add(sig);
        const [area] = k.split('|');
        add('A1', S.A1, G, area, `${area} 同一天 ${Object.keys(tasks).length} 項：${G.map(s => s.cat + (s.grp && isCookSlot(s) ? ' ' + s.grp + '組' : '') + '（' + s.loc + '）').join('、')}`);
      }
    }

    // A2 明德班日
    const md = new Set(splitList(P.mdDates)), xz = new Set(splitList(P.xzDates));
    for (const s of dist) {
      for (let x = s.ds; x <= s.de; x++) {
        const k = ds(x);
        if (md.has(k) && s.area !== '新莊') { add('A2', S.A2, [s], s.area, `${fmtD(k)} 是${s.area}明德班日，排了${s.cat}`); break; }
        if (xz.has(k) && s.area === '新莊') { add('A2', S.A2, [s], s.area, `${fmtD(k)} 是新莊明德班日，排了${s.cat}`); break; }
      }
    }

    // A3 環境整理與服務同週末
    const env = dist.filter(s => s.cat === '環境整理');
    for (const e of env) {
      for (const s of dist) {
        if (s.cat === '服務' && s.ds === e.ds + 1 && s.area === e.area) {
          add('A3', S.A3, [e, s], e.area, `${e.area} 同週末負責環境整理與服務`);
        }
      }
    }

    // A4 只排平日
    const wOnly = splitList(P.weekdayOnlyAreas);
    for (const s of dist) {
      if ((s.cat === '忠恕週六' || s.cat === '忠恕週日') && wOnly.includes(s.area)) {
        add('A4', S.A4, [s], s.area, `${s.area} 只排忠恕平日，卻排了${s.cat}`);
      }
    }

    // A5 / A5b / A6 忠恕梯次
    const jz = dist.filter(s => s.cat.startsWith('忠恕')).sort((a, b) => a.ds - b.ds);
    const waves = [];
    for (const s of jz) {
      const w = waves[waves.length - 1];
      if (w && s.ds - w[w.length - 1].ds <= 3) w.push(s);
      else waves.push([s]);
    }
    for (const w of waves) {
      const byA = {};
      for (const s of w) (byA[s.area] = byA[s.area] || []).push(s);
      for (const a in byA) {
        const G = byA[a];
        if (G.length > +P.jzMax) add('A5', S.A5, G, a, `${a} 在 ${fmtD(w[0].d)} 這一梯忠恕排了 ${G.length} 天`);
        for (let i = 1; i < G.length; i++) {
          if (G[i].ds - G[i - 1].ds === 1) add('A5b', S.A5b, [G[i - 1], G[i]], a, `${a} 忠恕連兩天（${fmtD(G[i - 1].d)}、${fmtD(G[i].d)}）`);
        }
      }
      const sat = w.find(s => s.cat === '忠恕週六'), sun = w.find(s => s.cat === '忠恕週日');
      if (sat && sun && sat.area === sun.area) add('A6', S.A6, [sat, sun], sat.area, `${sat.area} 同一梯週六、週日都排忠恕`);
    }

    // A7 廚務組間隔
    const cooks = L.filter(s => isCookSlot(s) && s.grp && s.grp !== '機動' && s.area !== '青年班');
    const byG = {};
    for (const s of cooks) (byG[s.grp] = byG[s.grp] || []).push(s);
    for (const g in byG) {
      const G = byG[g].sort((a, b) => a.ds - b.ds);
      for (let i = 1; i < G.length; i++) {
        const gap = G[i].ds - G[i - 1].de;
        if (gap <= 0) add('A7', '違規', [G[i - 1], G[i]], G[i].area, `${g} 組同一天兩處（${G[i - 1].loc}、${G[i].loc}）`);
        else if (gap <= +P.cookGap) add('A7', S.A7, [G[i - 1], G[i]], G[i].area, `${g} 組 ${fmtD(G[i - 1].d)} → ${fmtD(G[i].d)} 隔 ${gap} 天`);
      }
    }

    // A8 出勤密度
    for (const a of AREAS) {
      const occ = occasions(dist.filter(s => s.area === a).sort((x, y) => x.ds - y.ds));
      let lastFlag = -1;
      for (let i = 0; i < occ.length; i++) {
        let j = i;
        while (j + 1 < occ.length && occ[j + 1].ds - occ[i].ds < +P.densDays) j++;
        const n = j - i + 1;
        if (n > +P.densMax && j > lastFlag) {
          add('A8', S.A8, occ.slice(i, j + 1).map(o => o.slots[0]), a, `${a} 在 ${fmtD(ds(occ[i].ds))} 起 ${P.densDays} 天內出勤 ${n} 次`);
          lastFlag = j;
        }
      }
    }

    // A9 禮節、洗碗連兩場同區
    for (const cat of ['禮節', '洗碗']) {
      const G = L.filter(s => s.cat === cat).sort((a, b) => a.ds - b.ds);
      const dates = [...new Set(G.map(s => s.ds))];
      for (let i = 1; i < dates.length; i++) {
        const A = G.filter(s => s.ds === dates[i - 1]), B = G.filter(s => s.ds === dates[i]);
        for (const b of B) {
          if (A.some(a => a.area === b.area)) {
            add('A9', S.A9, [A.find(a => a.area === b.area), b], b.area, `${cat}連兩場都是${b.area}（${fmtD(ds(dates[i - 1]))}、${fmtD(b.d)}）`);
          }
        }
      }
    }

    // A10 無廚務組不排廚務
    const noCook = splitList(P.noCookAreas);
    for (const s of dist) if (isCookSlot(s) && noCook.includes(s.area)) add('A10', S.A10, [s], s.area, `${s.area} 沒有廚務組，卻排了廚務`);

    // A11 假日忠恕次數平均
    const big = AREAS.filter(a => !wOnly.includes(a));
    const cnt = {};
    big.forEach(a => { cnt[a] = 0; });
    for (const s of dist) if ((s.cat === '忠恕週六' || s.cat === '忠恕週日') && cnt[s.area] !== undefined) cnt[s.area] += (+s.share || 1);
    const vals = Object.values(cnt), mx = Math.max(...vals), mn = Math.min(...vals);
    if (mx - mn > +P.jzDiff) {
      const hi = big.filter(a => cnt[a] === mx), lo = big.filter(a => cnt[a] === mn);
      add('A11', S.A11, [], hi.join('、'), `假日忠恕次數不平均：${big.map(a => a + ' ' + cnt[a]).join('、')}（${hi.join('、')} 最多，${lo.join('、')} 最少）`);
    }
    return out;
  }

  function slotIssues(M, s) {
    const R = M.R, out = [];
    if (s.cancel || !s.area) return out;
    const A = M.asg[s.id].p, need = slotNeed(M, s);
    if (!(R.p.skipEmpty && A.length === 0) && A.length < need * (+R.p.shortRatio) && R.sev.P11 !== '關閉') {
      out.push({ rule: 'P11', lvl: R.sev.P11, slots: [s.id], date: s.d, area: s.area, msg: `${s.area} ${s.cat}：已排 ${A.length} / 需要 ${need} 人` });
    }
    if (needsLead(s) && A.length && !A.some(id => canLead(M.pById[id], s)) && R.sev.P12 !== '關閉') {
      out.push({ rule: 'P12', lvl: R.sev.P12, slots: [s.id], date: s.d, area: s.area, msg: `${s.area} ${s.cat}${s.grp ? ' ' + s.grp : ''}：沒有可帶隊的人` });
    }
    return out;
  }

  function issueKey(c) { return [c.rule, c.pid || '', ...c.slots].join('.').replace(/[^A-Za-z0-9_.\-]/g, '_') || c.rule; }

  function allIssues(M) {
    const out = areaIssues(M).map(c => Object.assign(c, { scope: '區' }));
    for (const id in M.personSlots) {
      for (const c of personIssues(M, M.pById[id], M.personSlots[id])) out.push(Object.assign(c, { scope: '人' }));
    }
    for (const s of M.slots) {
      for (const c of slotIssues(M, s)) out.push(Object.assign(c, { scope: '格' }));
    }
    for (const c of out) c.key = issueKey(c);
    out.sort((a, b) => (a.lvl === b.lvl ? 0 : a.lvl === '違規' ? -1 : 1) || a.date.localeCompare(b.date));
    return out;
  }

  /* ---------- 候選評分與自動排人 ---------- */
  function evalCandidate(M, p, s) {
    const list = (M.personSlots[p.id] || []).filter(x => x.id !== s.id).concat([s]);
    const issues = personIssues(M, p, list).filter(c => c.slots.includes(s.id) || c.rule === 'P5' || c.rule === 'P5b' || c.rule === 'P6');
    const hard = issues.filter(c => c.lvl === '違規');
    const soft = issues.filter(c => c.lvl === '注意');
    const P = M.R.p;
    const occN = occasions((M.personSlots[p.id] || []).filter(x => x.id !== s.id)).length;
    const cap = capOf(M, p);
    let score = 100;
    score -= occN / Math.max(1, cap.ideal) * (+P.wLoad) * 3;
    score -= soft.length * (+P.wSoft);
    if (!SPECIAL_AREAS.includes(s.area) && !isCookSlot(s) && p.a !== s.area) score -= +P.wCross;
    if (soft.some(c => c.rule === 'P10')) score -= +P.wMismatch;
    if (p.src === 'N') score -= +P.wNew;
    let affSum = 0; const mates = [];
    for (const id of M.asg[s.id].p) {
      const v = (M.aff[p.id] || {})[id];
      if (v) { affSum += v; mates.push(M.pById[id].n); }
    }
    score += affSum * (+P.wAff);
    if (needsLead(s) && canLead(p, s)) score += 2;
    return { p, score, hard, soft, affSum, mates, occN };
  }

  function poolFor(M, s, cross) {
    return M.people.filter(p => {
      if (p.off) return false;
      if (M.asg[s.id].p.includes(p.id)) return false;
      if (s.area === '青年班') return p.a === '青年班' || cross;
      if (s.area === '新民班') return p.a === '新民班' || cross;
      if (!AREAS.includes(p.a) && !['天達'].includes(p.a)) return false;
      if (s.cat === '交通') return cross ? AREAS.includes(p.a) : !!p.tr;
      if (s.area === '機動') return (M.personGroups[p.id] || []).includes('k_機動') || (p.cg || []).includes('機動');
      if (isCookSlot(s)) return (s.groupKey && (M.personGroups[p.id] || []).includes(s.groupKey)) || (p.cg || []).includes(String(s.grp)) || cross;
      return cross ? p.a !== s.area : p.a === s.area;
    });
  }

  function rankCandidates(M, s, opts) {
    opts = opts || {};
    const pool = opts.all
      ? M.people.filter(p => !p.off && !M.asg[s.id].p.includes(p.id) && p.a !== '金門')
      : poolFor(M, s, false);
    return pool.map(p => evalCandidate(M, p, s)).sort((a, b) => (a.hard.length - b.hard.length) || b.score - a.score);
  }

  function assignToModel(M, s, pid) {
    const A = M.asg[s.id];
    if (A.p.includes(pid)) return;
    A.p.push(pid);
    const L = (M.personSlots[pid] = M.personSlots[pid] || []);
    L.push(s);
    L.sort((a, b) => a.ds - b.ds);
  }

  function autoSchedule(M, filter, mode) {
    const P = M.R.p;
    // 自動排人處理未組別勤務或尚未設定組別的勤務
    const targets = M.slots.filter(s => !s.cancel && s.area && (!filter || filter(s)));
    if (mode === 'redo') {
      for (const s of targets) {
        if (s.groupKey) continue; // 組別名單保持由組別設定控制
        const lk = M.asg[s.id].lk.slice();
        M.asg[s.id] = { p: lk.slice(), lk };
        for (const pid in M.personSlots) {
          M.personSlots[pid] = M.personSlots[pid].filter(x => x.id !== s.id || lk.includes(pid));
        }
      }
    }
    const order = targets.filter(isCookSlot).concat(targets.filter(s => !isCookSlot(s) && s.cat !== '交通'), targets.filter(s => s.cat === '交通'));
    let added = 0;
    for (const s of order) {
      if (s.groupKey && (st.groups[s.groupKey] || []).length > 0 && mode !== 'fill_one') continue;
      const need = slotNeed(M, s);
      const pick = (cross) => {
        let pool = poolFor(M, s, cross);
        while (M.asg[s.id].p.length < need && pool.length) {
          let best = null;
          const wantLead = needsLead(s) && !M.asg[s.id].p.some(id => canLead(M.pById[id], s));
          for (const p of pool) {
            const ev = evalCandidate(M, p, s);
            if (ev.hard.length) continue;
            if (wantLead && canLead(p, s)) ev.score += 1000;
            if (!best || ev.score > best.score) best = ev;
          }
          if (!best) break;
          assignToModel(M, s, best.p.id);
          added++;
          pool = pool.filter(p => p !== best.p);
        }
      };
      pick(false);
      if (P.allowCross && M.asg[s.id].p.length < need && !SPECIAL_AREAS.includes(s.area)) pick(true);
    }
    return added;
  }

  function areaDelta(slotId) {
    const b0 = areaIssues(M);
    const cnt0 = { v: b0.filter(c => c.lvl === '違規').length, n: b0.filter(c => c.lvl === '注意').length };
    const s = M.byId[slotId];
    const opts = isCookSlot(s) ? AREAS.concat(['機動', '青年班']) : s.cat === '交通' ? ['交通隊'] : AREAS.concat(s.cat === '洗碗' ? ['新民班'] : []);
    const res = {};
    const origEd = st.edits[slotId];
    for (const a of opts) {
      const grp = defaultGroupForAreaCat(a, s.cat) || (origEd && origEd.grp) || s.grp;
      st.edits[slotId] = Object.assign({}, origEd || {}, { area: a, grp });
      const m2 = buildModel();
      const c2 = areaIssues(m2);
      res[a] = {
        dv: c2.filter(c => c.lvl === '違規').length - cnt0.v,
        dn: c2.filter(c => c.lvl === '注意').length - cnt0.n
      };
    }
    if (origEd) st.edits[slotId] = origEd; else delete st.edits[slotId];
    return res;
  }

  /* ---------- 姓名解析與依區建立人員 ---------- */
  function nextPersonId() {
    const maxBase = BASE.people.reduce((mx, p) => Math.max(mx, p.id), 0);
    const maxAdd = (st.addedPeople || []).reduce((mx, p) => Math.max(mx, p.id), maxBase);
    return maxAdd + 1;
  }

  function findOrCreatePersonByName(rawToken, targetArea, defaultProps) {
    // 支援格式：王小明 或 王小明(瑞芳) 或 王小明（乾）
    let nm = rawToken.trim();
    let explicitArea = null;
    let explicitSx = null;
    const mArea = nm.match(/^(.+?)[(（]([^)）]+)[)）]$/);
    if (mArea) {
      nm = mArea[1].trim();
      const tag = mArea[2].trim();
      if (PERSON_AREAS.includes(tag)) explicitArea = tag;
      else if (['乾', '坤', '童'].includes(tag)) explicitSx = tag;
    }
    const homeArea = explicitArea || (PERSON_AREAS.includes(targetArea) ? targetArea : '天達');
    // 1. 先比對同區
    let found = M.people.find(p => p.n === nm && p.a === homeArea);
    // 2. 若未指定區或是在全區性單位(機動/交通隊)，若全域唯一則採用
    if (!found && !explicitArea) {
      const matches = M.people.filter(p => p.n === nm);
      if (matches.length === 1) found = matches[0];
    }
    if (found) return { person: found, created: false };

    const newP = Object.assign({
      id: nextPersonId(),
      n: nm,
      a: homeArea,
      sx: explicitSx,
      age: null,
      src: 'M',
      lead: '',
      cg: [],
      cr: '',
      sg: '',
      li: '',
      zr: '',
      tr: '',
      n115: 0,
      wd115: 0,
      cls: '',
      note: '手動依區新增'
    }, defaultProps || {});
    st.addedPeople.push(newP);
    return { person: newP, created: true };
  }

  /* ---------- 全域衍生狀態與重新計算 ---------- */
  let M, ISS = [], bySlot = {}, byPerson = {}, openIss = [];
  let view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'area';
  let drawer = null; // { type: 'slot'|'person'|'addPerson', id }
  let modal = null;
  let openPickerGroupId = null;
  let openCandidateSlotId = null;
  let undoStack = null;

  function recompute() {
    M = buildModel();
    ISS = allIssues(M);
    bySlot = {};
    byPerson = {};
    for (const c of ISS) {
      c.ack = st.acks[c.key] || null;
      c.open = !c.ack || c.ack.st === '未處理' || c.ack.st === '協調中';
      for (const id of c.slots) (bySlot[id] = bySlot[id] || []).push(c);
      if (c.pid) (byPerson[c.pid] = byPerson[c.pid] || []).push(c);
    }
    openIss = ISS.filter(c => c.open);
  }

  let rq = 0;
  function schedule(skipPersist) {
    if (!skipPersist) persist();
    if (rq) return;
    rq = requestAnimationFrame(() => {
      rq = 0;
      recompute();
      render();
    });
  }

  function addLog(msg) {
    st.log.unshift({ t: Date.now(), msg });
    if (st.log.length > 200) st.log.length = 200;
  }

  function snapshotUndo(label) {
    undoStack = {
      label,
      groups: JSON.parse(JSON.stringify(st.groups)),
      slotMod: JSON.parse(JSON.stringify(st.slotMod)),
      assign: JSON.parse(JSON.stringify(st.assign)),
      addedPeople: JSON.parse(JSON.stringify(st.addedPeople))
    };
  }

  /* ---------- 共用 UI 小元件 ---------- */
  const areaTag = a => `<span class="area-tag" style="--ac:var(--c-${esc(a)})">${esc(a || '未定')}</span>`;
  const lvlPill = l => `<span class="pill ${l === '違規' ? 'bad' : 'warn'}">${l}</span>`;
  const wdName = s => '週' + WD[wdOf(s)];
  function cnt(L) { let v = 0, n = 0; for (const c of L || []) if (c.open) { if (c.lvl === '違規') v++; else n++; } return { v, n }; }
  function badges(L) { const c = cnt(L); return (c.v ? `<span class="badge bad" title="違規">${c.v}</span>` : '') + (c.n ? `<span class="badge warn" title="注意">${c.n}</span>` : ''); }
  function ruleName(id) { const r = RULE_META.find(x => x.id === id); return r ? r.name : id; }
  function slotTitle(s) { return `${fmtD(s.d)}${s.e && s.e !== s.d ? '–' + fmtD(s.e) : ''}（${WD[s.wd]}）${s.cat}`; }
  function grpLabel(s) {
    if (!s.grp) return '';
    if (isCookSlot(s)) return s.grp === '機動' ? '機動組' : s.grp + '組';
    if (s.cat === '禮節') return s.grp === '基新' ? '基新隊' : s.grp.replace(/(\d)$/, '$1隊');
    if (s.cat === '環境整理' || s.cat === '服務') return s.grp + '組';
    return s.grp;
  }
  function roleTags(p) {
    const t = [];
    if (p.cr) t.push(p.cr.replace('、', '/') + (p.cg && p.cg.length ? '・' + p.cg.join('/') + '組' : ''));
    if (p.sg) t.push('服務' + p.sg);
    if (p.lead) t.push(p.lead.replace(/、/g, '/'));
    if (p.li) t.push('禮節');
    if (p.tr) t.push('交通' + p.tr.replace('、', '/'));
    if (p.src === 'N') t.push('新人');
    if (p.src === 'M') t.push('新增');
    return t.map(x => `<span class="pill mute">${esc(x)}</span>`).join(' ');
  }
  function personLabel(p) {
    return `${esc(p.n)}<span class="muted small">・${esc(p.a)}${p.age ? '・' + p.age + '歲' : ''}</span>`;
  }
  function toast(msg) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }
  function monthsList() { return [...new Set(M.slots.map(s => s.d.slice(0, 7)))]; }
  function monthLabel(m) { const [y, mm] = m.split('-').map(Number); return (y - 1911) + ' 年 ' + mm + ' 月'; }

  /* ---------- 頂部 Header ---------- */
  function renderHeader() {
    const c = cnt(ISS);
    $('#hdrCounts').innerHTML = `<button class="pill bad" data-act="goIssues" title="查看未處理違規">違規 <b class="num">${c.v}</b></button><button class="pill warn" data-act="goIssuesAll" title="查看未處理注意">注意 <b class="num">${c.n}</b></button>`;
    $('#tabIss').innerHTML = c.v ? ` <span class="badge bad">${c.v}</span>` : '';
    document.querySelectorAll('#tabs a, #bottomNav a').forEach(a => a.classList.toggle('on', a.dataset.v === view));
    $('#btnUndo').hidden = !undoStack;
  }

  /* ---------- 分頁 1：依區排人 (#area) ---------- */
  function areaUngroupedSlots(area) {
    return M.slots.filter(s => !s.cancel && !s.groupKey && s.area === area);
  }

  function areaGroupsList(area) {
    return BASE.groupsMeta.filter(g => g.area === area);
  }

  function renderAreaWork() {
    let h = `<div class="area-switcher">`;
    for (const a of ALL_WORK_AREAS) {
      const pCount = M.people.filter(p => p.a === a && !p.off).length;
      const gCount = areaGroupsList(a).length;
      const ugSlots = areaUngroupedSlots(a);
      const ugUnfilled = ugSlots.filter(s => M.asg[s.id].p.length < slotNeed(M, s)).length;
      const meta = [];
      if (st.largeMode) {
        if (pCount) meta.push(`${pCount}人`);
        if (gCount) meta.push(`${gCount}組`);
        else if (ugSlots.length) meta.push(`${ugSlots.length}場`);
      } else {
        if (pCount) meta.push(`${pCount}人`);
        if (gCount) meta.push(`${gCount}組`);
        if (ugSlots.length) meta.push(`無組${ugSlots.length}場${ugUnfilled ? `(缺${ugUnfilled})` : '(齊)'}`);
      }
      h += `<button class="area-btn ${F.area === a ? 'on' : ''}" style="--ac:var(--c-${esc(a)})" data-act="selWorkArea" data-a="${esc(a)}">
        <span class="nm">${esc(a)}</span>
        <span class="meta">${meta.join(' · ') || '專案'}</span>
      </button>`;
    }
    h += `</div>`;

    const a = F.area;
    const areaGroups = areaGroupsList(a);
    const ugSlots = areaUngroupedSlots(a);
    const areaPeople = M.people.filter(p => p.a === a);

    h += `<div class="subtabs">
      <button class="subtab ${F.areaTab === 'groups' ? 'on' : ''}" data-act="selAreaTab" data-t="groups">${st.largeMode ? `有組別 (${areaGroups.length})` : `有組別設定（${areaGroups.length} 組）`}</button>
      <button class="subtab ${F.areaTab === 'ungrouped' ? 'on' : ''}" data-act="selAreaTab" data-t="ungrouped">${st.largeMode ? `無組別 (${ugSlots.length})` : `無組別排人・依日期（${ugSlots.length} 場）`}</button>
      <button class="subtab ${F.areaTab === 'people' ? 'on' : ''}" data-act="selAreaTab" data-t="people">${st.largeMode ? `名冊 (${areaPeople.length})` : `本區人員名冊（${areaPeople.length} 人）`}</button>
    </div>`;

    if (F.areaTab === 'groups') h += renderAreaGroups(a, areaGroups, areaPeople);
    else if (F.areaTab === 'ungrouped') h += renderAreaUngrouped(a, ugSlots);
    else h += renderAreaPeople(a, areaPeople);
    return h;
  }

  function renderGroupCard(gm, areaPeople) {
    const memberIds = (st.groups[gm.id] || []).filter(id => M.pById[id]);
    const linkedSlots = M.slots.filter(s => !s.cancel && s.groupKey === gm.id);
    const isPickerOpen = openPickerGroupId === gm.id;

    let h = `<div class="group-card" style="--ac:var(--c-${esc(gm.area)})">
      <div class="group-head">
        <div>
          <div class="group-title">
            ${areaTag(gm.area)}
            <span>${esc(gm.name)}</span>
            <span class="pill mute">${esc(gm.cat)}</span>
            <span class="pill ${memberIds.length >= gm.need ? 'ok' : memberIds.length ? 'warn' : 'mute'}">${st.largeMode ? `${memberIds.length}/${gm.need}人` : `已設 ${memberIds.length} / 建議 ${gm.need} 人`}</span>
          </div>
          ${st.largeMode ? '' : `<div class="small muted" style="margin-top:3px">設定本組固定成員後，下方 ${linkedSlots.length} 場勤務將自動帶入本組名單（各場可再個別設定請假／代班）。</div>`}
        </div>
        <div class="row">
          ${gm.cat === '禮節' ? `<button class="btn xs" data-act="suggestRitual" data-g="${gm.id}" title="依 115 年禮節經驗自動帶入／補齊">帶入 115 名單</button>` : ''}
          ${BASE.defaultGroups[gm.id] && BASE.defaultGroups[gm.id].length ? `<button class="btn xs" data-act="resetGroup" data-g="${gm.id}">還原 115 名單</button>` : ''}
          <button class="btn xs" data-act="togglePicker" data-g="${gm.id}">${isPickerOpen ? '收合名單' : (st.largeMode ? '點選名冊名單' : '從名冊勾選')}</button>
          <button class="btn xs ghost" data-act="clearGroup" data-g="${gm.id}">清空</button>
        </div>
      </div>

      <div class="quick-add">
        <input type="text" id="ga_${gm.id}" data-group-input="${gm.id}" placeholder="${st.largeMode ? `輸入姓名加入（例：王小明、陳美華）` : `直接輸入姓名加入本組（可空格、逗號或頓號一次貼多位，新姓名自動建檔至${esc(gm.area)}）`}">
        <button class="btn sm pri" data-act="groupAddNames" data-g="${gm.id}" data-a="${esc(gm.area)}">加入名單</button>
      </div>

      <div class="member-chips">`;
    if (!memberIds.length) {
      h += `<span class="small muted">尚未設定組員。請在上方輸入姓名或點「從名冊勾選」。</span>`;
    } else {
      for (const pid of memberIds) {
        const p = M.pById[pid];
        const isLead = /主廚|大廚|組長/.test((p.cr || '') + (p.lead || ''));
        const pIss = cnt(byPerson[pid]);
        const cls = pIss.v ? 'bad' : pIss.n ? 'warn' : isLead ? 'lead' : '';
        const roleNote = [p.cr, p.lead ? p.lead.replace(/、/g, '/') : '', p.a !== gm.area ? p.a : ''].filter(Boolean).join('・');
        h += `<span class="mchip ${cls}">
          <button class="name-btn" data-act="openPerson" data-id="${pid}" title="檢視人員與排班">${esc(p.n)}</button>
          ${roleNote ? `<span class="role-sm">${esc(roleNote)}</span>` : ''}
          <button class="x-btn" data-act="groupRm" data-g="${gm.id}" data-p="${pid}" aria-label="移出本組" title="移出本組">✕</button>
        </span>`;
      }
    }
    h += `</div>`;

    if (isPickerOpen) {
      const candidates = gm.area === '機動' || gm.area === '交通隊'
        ? M.people.filter(p => p.a !== '金門')
        : areaPeople;
      const sorted = candidates.slice().sort((a, b) => {
        const aHit = memberIds.includes(a.id) ? 1 : 0;
        const bHit = memberIds.includes(b.id) ? 1 : 0;
        if (aHit !== bHit) return bHit - aHit;
        if (gm.cat === '禮節') return (b.li ? 1 : 0) - (a.li ? 1 : 0) || b.n115 - a.n115;
        if (gm.cat === '廚務') return (b.cr ? 1 : 0) - (a.cr ? 1 : 0) || b.n115 - a.n115;
        return (b.sg ? 1 : 0) - (a.sg ? 1 : 0) || b.n115 - a.n115;
      });
      h += `<div class="picker-box">
        <div class="row" style="justify-content:space-between">
          <span class="small muted">勾選加入 <b>${esc(gm.name)}</b>（顯示${gm.area === '機動' || gm.area === '交通隊' ? '全體' : esc(gm.area)}名冊共 ${sorted.length} 人）</span>
        </div>
        <div class="picker-grid">`;
      for (const p of sorted) {
        const chk = memberIds.includes(p.id);
        const tag = p.cr || (p.li ? '禮節經驗' : '') || (p.sg ? '服務' + p.sg : '') || (p.tr ? '交通' : '');
        h += `<label class="pick-item ${chk ? 'checked' : ''}">
          <input type="checkbox" data-act="groupToggle" data-g="${gm.id}" data-p="${p.id}" ${chk ? 'checked' : ''}>
          <span><b>${esc(p.n)}</b>${p.a !== gm.area ? ` <span class="muted">(${esc(p.a)})</span>` : ''}${tag ? ` <span class="muted small">${esc(tag)}</span>` : ''}</span>
        </label>`;
      }
      h += `</div></div>`;
    }

    h += `<div>
      <div class="small muted" style="margin-bottom:4px">116 年套用本組的勤務場次（點擊可單場請假排除／臨時支援）：</div>
      <div class="date-badges">`;
    if (!linkedSlots.length) {
      h += `<span class="small muted">目前排班表尚未指定到此組別</span>`;
    } else {
      for (const s of linkedSlots) {
        const A = M.asg[s.id];
        const c = cnt(bySlot[s.id]);
        const modNote = ((A.exclude && A.exclude.length) || (A.include && A.include.length))
          ? ` (調${A.include.length ? '+' + A.include.length : ''}${A.exclude.length ? '-' + A.exclude.length : ''})` : '';
        h += `<button class="date-pill ${c.v ? 'bad' : c.n ? 'warn' : ''}" data-act="openSlot" data-id="${s.id}">
          <span class="num">${fmtD(s.d)}</span><span>${esc(s.cat)}</span><span class="muted">${A.p.length}人${modNote}</span>
        </button>`;
      }
    }
    h += `</div></div></div>`;
    return h;
  }

  function renderAreaGroups(area, areaGroups, areaPeople) {
    let h = '';
    if (!areaGroups.length) {
      h += `<div class="panel"><p class="empty">${esc(area)} 目前沒有固定常設組別，請切換到「無組別排人・依日期」進行排班。</p></div>`;
      return h;
    }
    // 額外提供：若為四大區(松山/三重/瑞芳/內湖)，顯示「115 禮節經驗自動均分 1/2 隊」快捷按鈕
    if (['松山', '三重', '瑞芳', '內湖'].includes(area)) {
      h += `<div class="row" style="margin-bottom:10px;justify-content:space-between">
        <span class="small muted">「廚務組」與「服務組」已預設帶入 115 年編組名單；「禮節隊」可直接輸入或一鍵依 115 禮節經驗均分。</span>
        <button class="btn sm" data-act="autoSplitRitualArea" data-a="${esc(area)}">一鍵均分 ${esc(area)} 禮節 1／2 隊</button>
      </div>`;
    }
    h += `<div class="grid">`;
    for (const gm of areaGroups) {
      h += renderGroupCard(gm, areaPeople);
    }
    h += `</div>`;
    return h;
  }

  function renderSlotQuickCard(s) {
    const A = M.asg[s.id];
    const need = slotNeed(M, s);
    const info = BASE.days[s.d] || {};
    const c = cnt(bySlot[s.id]);
    const isCandOpen = openCandidateSlotId === s.id;
    const isFull = A.p.length >= need;

    let h = `<div class="ug-card ${c.v ? 'v' : ''}" style="--ac:var(--c-${esc(s.area)})">
      <div class="ug-head">
        <div>
          <div class="row">
            <span class="ug-date">${fmtD(s.d)}${s.e && s.e !== s.d ? '–' + fmtD(s.e) : ''}（${WD[s.wd]}）</span>
            ${areaTag(s.area)}
            <span class="pill info">${esc(s.cat)}</span>
            ${s.weekday ? '<span class="pill warn">平日需請假</span>' : (info.hol ? `<span class="pill mute">${esc(info.hol)}</span>` : '')}
            <span class="pill ${isFull ? 'ok' : A.p.length ? 'warn' : 'mute'} num">${A.p.length} / ${need} 人</span>
            ${badges(bySlot[s.id])}
          </div>
          <div class="small muted" style="margin-top:3px">${esc(s.label || info.act || '')} · 地點：${esc(s.loc)}${st.largeMode ? '' : ` · 來源：${esc(s.src)}`}</div>
        </div>
        <div class="row">
          <button class="btn xs" data-act="autoOne" data-id="${s.id}">自動補滿</button>
          <button class="btn xs" data-act="toggleCand" data-id="${s.id}">${isCandOpen ? '收合名單' : (st.largeMode ? '點選本區名單' : '點選本區人選')}</button>
          <button class="btn xs ghost" data-act="openSlot" data-id="${s.id}">${st.largeMode ? '詳細編輯' : '詳細抽屜'}</button>
        </div>
      </div>

      <div class="quick-add">
        <input type="text" id="sa_${s.id}" data-slot-input="${s.id}" placeholder="${st.largeMode ? `輸入姓名排入這一天` : `依日期輸入姓名（可空格、逗號或頓號一次貼多位，新姓名自動建檔至${esc(s.area)}）`}">
        <button class="btn sm pri" data-act="slotAddNames" data-id="${s.id}">加入排班</button>
      </div>

      <div class="member-chips">`;
    if (!A.p.length) {
      h += `<span class="small muted">尚未排人</span>`;
    } else {
      for (const pid of A.p) {
        const p = M.pById[pid];
        const lk = A.lk.includes(pid);
        const lead = canLead(p, s);
        const pIss = cnt((byPerson[pid] || []).filter(x => x.slots.includes(s.id) || x.rule.startsWith('P5') || x.rule === 'P6'));
        const cls = pIss.v ? 'bad' : pIss.n ? 'warn' : lead ? 'lead' : '';
        h += `<span class="mchip ${cls}">
          <button class="name-btn" data-act="openPerson" data-id="${pid}">${esc(p.n)}</button>
          ${lead ? '<span class="role-sm">帶隊</span>' : ''}
          ${lk ? '<span class="role-sm">鎖</span>' : ''}
          <button class="x-btn" data-act="rm" data-id="${s.id}" data-p="${pid}" title="移除">✕</button>
        </span>`;
      }
    }
    h += `</div>`;

    if (isCandOpen) {
      const C = rankCandidates(M, s, { all: false }).slice(0, 24);
      h += `<div class="picker-box">
        <div class="small muted">依規則與搭檔親和度排序的推薦人選（點擊立即加入）：</div>
        <div class="picker-grid">`;
      if (!C.length) h += `<span class="small muted">本區無其他未排候選人，可直接上方輸入姓名或開「詳細抽屜」跨區支援。</span>`;
      for (const e of C) {
        const p = e.p;
        const warnTxt = e.hard.length ? `違規(${e.hard.length})` : e.soft.length ? `注意(${e.soft.length})` : e.mates.length ? `搭檔:${e.mates[0]}` : `已${e.occN}次`;
        h += `<button class="pick-item" data-act="add" data-id="${s.id}" data-p="${p.id}">
          <span><b>${esc(p.n)}</b>${canLead(p, s) ? ' ★' : ''} <span class="muted small">${esc(warnTxt)}</span></span>
        </button>`;
      }
      h += `</div></div>`;
    }
    h += `</div>`;
    return h;
  }

  function renderAreaUngrouped(area, ugSlots) {
    let h = `<div class="row" style="margin-bottom:10px;justify-content:space-between">
      <span class="small muted">無組別勤務（忠恕輪值、洗碗、大典前晚、道院協辦等）可直接依「日期 × 區域」輸入姓名排人。</span>
      ${ugSlots.length ? `<button class="btn sm pri" data-act="autoAreaUngrouped" data-a="${esc(area)}">全部無組別自動補滿</button>` : ''}
    </div>`;
    if (!ugSlots.length) {
      return h + `<div class="panel"><p class="empty">${esc(area)} 沒有無組別的待排勤務。</p></div>`;
    }
    h += `<div class="grid">`;
    for (const s of ugSlots) h += renderSlotQuickCard(s);
    h += `</div>`;
    return h;
  }

  function renderAreaPeople(area, areaPeople) {
    let list = areaPeople.map(p => {
      const sl = M.personSlots[p.id] || [];
      const occ = occasions(sl).length;
      const c = cnt(byPerson[p.id]);
      return { p, occ, c, cap: capOf(M, p) };
    });
    if (F.pq) list = list.filter(o => o.p.n.includes(F.pq.trim()));
    const sorts = {
      occ: (a, b) => b.occ - a.occ || a.p.id - b.p.id,
      iss: (a, b) => (b.c.v - a.c.v) || (b.c.n - a.c.n),
      age: (a, b) => (b.p.age || 0) - (a.p.age || 0),
      id: (a, b) => a.p.id - b.p.id
    };
    list.sort(sorts[F.psort] || sorts.id);

    let h = `<div class="panel" style="margin-bottom:14px">
      <h3 style="margin-bottom:8px">依區輸入人員（${esc(area)}）</h3>
      <div class="quick-add" style="margin-bottom:8px">
        <textarea id="batchPeopleInput" rows="2" placeholder="輸入單人或批次貼上多位姓名（以空格、逗號、頓號或換行分隔），例如：王大明、陳小芳、林志明"></textarea>
        <button class="btn pri" data-act="batchAddAreaPeople" data-a="${esc(area)}">新增至 ${esc(area)} 名冊</button>
      </div>
      <div class="row">
        <button class="btn sm" data-act="openAddPersonModal" data-a="${esc(area)}">＋ 詳細資料新增單筆人員</button>
        <span class="small muted">可加註性別例如 <code>王大明(乾)</code>；點擊下方任一人員可編輯其屬性、組別與不可排日期。</span>
      </div>
    </div>`;

    h += `<div class="filters">
      <input type="search" id="pQ" placeholder="搜尋${esc(area)}姓名" value="${esc(F.pq)}">
      <select id="pSort">
        <option value="id" ${F.psort === 'id' ? 'selected' : ''}>依名冊序</option>
        <option value="occ" ${F.psort === 'occ' ? 'selected' : ''}>依 116 次數</option>
        <option value="iss" ${F.psort === 'iss' ? 'selected' : ''}>依問題數</option>
        <option value="age" ${F.psort === 'age' ? 'selected' : ''}>依年紀</option>
      </select>
      <span class="small muted">共 ${list.length} 人</span>
    </div>`;

    if (st.largeMode) {
      h += `<div class="elder-plist">`;
      if (!list.length) {
        h += `<div class="panel"><p class="empty">目前沒有人員資料，請在上方輸入新增。</p></div>`;
      } else {
        for (const o of list) {
          const p = o.p;
          const gNames = (M.personGroups[p.id] || []).map(gk => GROUP_META_BY_ID[gk]?.short || gk).join('、');
          h += `<button class="elder-pcard" data-act="openPerson" data-id="${p.id}">
            <div class="ep-top">
              <span class="ep-name">${esc(p.n)}${p.off ? '（暫停）' : ''}</span>
              <span class="pill acc num">116年 ${o.occ} 次</span>
            </div>
            <div class="ep-sub">${esc(p.sx || '未填')}${p.age ? ' · ' + p.age + '歲' : ''}${gNames ? ' · ' + esc(gNames) : ''}${p.cr ? ' · ' + esc(p.cr) : ''}${p.li ? ' · 禮節' : ''}${p.tr ? ' · 交通' : ''}</div>
          </button>`;
        }
      }
      h += `</div>`;
      return h;
    }

    h += `<div class="panel tbl-wrap"><table><thead><tr><th>姓名</th><th>性別/年紀</th><th>組別與專長</th><th class="r">116 次數</th><th class="r">問題</th><th class="r">115 次</th></tr></thead><tbody>`;
    if (!list.length) {
      h += `<tr><td colspan="6" class="empty">目前沒有人員資料，請在上方輸入新增。</td></tr>`;
    } else {
      for (const o of list) {
        const p = o.p;
        const gNames = (M.personGroups[p.id] || []).map(gk => GROUP_META_BY_ID[gk]?.short || gk).join('、');
        h += `<tr class="click" data-act="openPerson" data-id="${p.id}">
          <td><b>${esc(p.n)}</b>${p.off ? ' <span class="pill mute">暫停</span>' : ''}${p.work ? ` <span class="pill mute">${esc(p.work)}</span>` : ''}</td>
          <td class="small">${esc(p.sx || '—')}${p.age ? ' · ' + p.age + '歲' : ''}</td>
          <td>${gNames ? `<span class="pill acc">${esc(gNames)}</span> ` : ''}${roleTags(p)}</td>
          <td class="r num">${o.occ}</td>
          <td class="r">${badges(byPerson[p.id])}</td>
          <td class="r num muted">${p.n115 || '—'}</td>
        </tr>`;
      }
    }
    h += `</tbody></table></div>`;
    return h;
  }

  /* ---------- 分頁 2：忠恕＆無組別專頁 (#ungrouped) ---------- */
  function waveOfSlot(s) {
    if (!s.cat.startsWith('忠恕')) return '';
    if (s.d <= '2027-03-10') return 'W1';
    if (s.d <= '2027-06-10') return 'W2';
    if (s.d <= '2027-09-01') return 'W3';
    if (s.d <= '2027-12-01') return 'W4';
    return 'W5';
  }

  function renderUngroupedPage() {
    let L = M.slots.filter(s => !s.cancel && !s.groupKey);
    if (F.ugCat === '忠恕') L = L.filter(s => s.cat.startsWith('忠恕'));
    else if (F.ugCat) L = L.filter(s => s.cat === F.ugCat);
    if (F.ugWave) L = L.filter(s => waveOfSlot(s) === F.ugWave);
    if (F.ugArea) L = L.filter(s => s.area === F.ugArea);
    if (F.ugSt === 'short') L = L.filter(s => M.asg[s.id].p.length < slotNeed(M, s));
    else if (F.ugSt === 'full') L = L.filter(s => M.asg[s.id].p.length >= slotNeed(M, s));

    const totalNeed = L.reduce((a, s) => a + slotNeed(M, s), 0);
    const totalGot = L.reduce((a, s) => a + M.asg[s.id].p.length, 0);

    let h = `<div class="panel" style="margin-bottom:14px">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2 style="margin:0">無組別輪值：依日期與區域輸入人員</h2>
          <div class="small muted">忠恕道院輪值（平日 5人／週六大區 28人／週日 13人）、洗碗、大典前晚、道院協辦與青年班場次皆無固定組別，可依日期與區域直接輸入或指派人員。</div>
        </div>
        <div class="row">
          <span class="pill acc num">目前篩選：${L.length} 場 · 已排 ${totalGot} / ${totalNeed} 人</span>
          <button class="btn sm pri" data-act="autoUngroupedFiltered">依篩選條件自動補滿</button>
        </div>
      </div>
    </div>`;

    h += `<div class="filters">
      <select id="ugCat" aria-label="類別">
        <option value="" ${F.ugCat === '' ? 'selected' : ''}>全部無組別勤務</option>
        <option value="忠恕" ${F.ugCat === '忠恕' ? 'selected' : ''}>忠恕輪值（全部）</option>
        <option value="忠恕平日" ${F.ugCat === '忠恕平日' ? 'selected' : ''}>忠恕平日（5人）</option>
        <option value="忠恕週六" ${F.ugCat === '忠恕週六' ? 'selected' : ''}>忠恕週六（28人）</option>
        <option value="忠恕週日" ${F.ugCat === '忠恕週日' ? 'selected' : ''}>忠恕週日（13人）</option>
        <option value="洗碗" ${F.ugCat === '洗碗' ? 'selected' : ''}>洗碗</option>
        <option value="大典前晚" ${F.ugCat === '大典前晚' ? 'selected' : ''}>大典前晚</option>
        <option value="協辦" ${F.ugCat === '協辦' ? 'selected' : ''}>道院協辦</option>
        <option value="廚務" ${F.ugCat === '廚務' ? 'selected' : ''}>青年班廚務</option>
      </select>
      <select id="ugWave" aria-label="忠恕梯次">
        <option value="" ${F.ugWave === '' ? 'selected' : ''}>全部梯次／日期</option>
        <option value="W1" ${F.ugWave === 'W1' ? 'selected' : ''}>第 1 梯（2/27–3/5）</option>
        <option value="W2" ${F.ugWave === 'W2' ? 'selected' : ''}>第 2 梯（5/26–5/30）</option>
        <option value="W3" ${F.ugWave === 'W3' ? 'selected' : ''}>第 3 梯（8/18–8/22）</option>
        <option value="W4" ${F.ugWave === 'W4' ? 'selected' : ''}>第 4 梯（11/10–11/14）</option>
        <option value="W5" ${F.ugWave === 'W5' ? 'selected' : ''}>第 5 梯（117/2/2–2/6）</option>
      </select>
      <select id="ugArea" aria-label="區">
        <option value="">全部區域</option>
        ${AREAS.concat(['青年班', '新民班']).map(a => `<option ${F.ugArea === a ? 'selected' : ''}>${a}</option>`).join('')}
      </select>
      <select id="ugSt" aria-label="狀態">
        <option value="">全部狀態</option>
        <option value="short" ${F.ugSt === 'short' ? 'selected' : ''}>只看尚未額滿</option>
        <option value="full" ${F.ugSt === 'full' ? 'selected' : ''}>只看已額滿</option>
      </select>
    </div>`;

    if (!L.length) return h + `<p class="empty">沒有符合條件的無組別勤務。</p>`;
    h += `<div class="grid">`;
    for (const s of L) h += renderSlotQuickCard(s);
    h += `</div>`;
    return h;
  }

  /* ---------- 分頁 3：全年排班表 (#schedule) ---------- */
  function renderSchedule() {
    let L = M.slots;
    if (F.month) L = L.filter(s => s.d.slice(0, 7) === F.month);
    if (F.areaF) L = L.filter(s => s.area === F.areaF);
    if (F.cat) L = L.filter(s => (F.cat === '忠恕' ? s.cat.startsWith('忠恕') : s.cat === F.cat));
    if (F.only === 'v') L = L.filter(s => cnt(bySlot[s.id]).v);
    if (F.only === 'any') L = L.filter(s => { const c = cnt(bySlot[s.id]); return c.v || c.n; });
    if (F.only === 'short') L = L.filter(s => !s.cancel && M.asg[s.id].p.length < slotNeed(M, s));
    if (F.q) {
      const q = F.q.trim();
      L = L.filter(s => ((BASE.days[s.d] || {}).act || '').includes(q) || (s.label || '').includes(q) || M.asg[s.id].p.some(id => M.pById[id].n.includes(q)));
    }

    let h = `<div class="filters">
      ${st.largeMode ? '' : `<div class="seg" role="group" aria-label="檢視模式">
        <button class="${F.schedMode === 'list' ? 'on s3' : ''}" data-act="setSchedMode" data-m="list">排人清單</button>
        <button class="${F.schedMode === 'matrix' ? 'on s3' : ''}" data-act="setSchedMode" data-m="matrix">總表矩陣 (v9.2)</button>
      </div>`}
      <select id="fMonth" aria-label="月份"><option value="">全部月份</option>${monthsList().map(m => `<option value="${m}" ${F.month === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select>
      <select id="fArea" aria-label="區"><option value="">全部區</option>${ALL_WORK_AREAS.map(a => `<option ${F.areaF === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
      <select id="fCat" aria-label="類別"><option value="">全部類別</option>${['廚務', '會館輪廚', '環境整理', '服務', '禮節', '洗碗', '忠恕', '大典前晚', '協辦', '交通'].map(c => `<option ${F.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      ${st.largeMode ? '' : `<select id="fOnly" aria-label="篩選"><option value="">全部格</option><option value="v" ${F.only === 'v' ? 'selected' : ''}>只看有違規</option><option value="any" ${F.only === 'any' ? 'selected' : ''}>只看有問題</option><option value="short" ${F.only === 'short' ? 'selected' : ''}>只看人數不足</option></select>`}
      <input type="search" id="fQ" placeholder="搜尋活動或姓名" value="${esc(F.q)}">
      ${st.largeMode ? '' : `<button class="btn sm" data-act="addSlot">＋ 新增勤務</button>`}
    </div>`;

    if (F.schedMode === 'matrix' && !st.largeMode) return h + renderMatrix(L);
    if (!L.length) return h + `<p class="empty">沒有符合條件的勤務。</p>`;

    const byDay = {};
    for (const s of L) (byDay[s.d] = byDay[s.d] || []).push(s);
    let lastM = '';
    for (const d of Object.keys(byDay).sort()) {
      const m = d.slice(0, 7);
      if (m !== lastM) { h += `<h2 style="margin-top:${lastM ? 18 : 0}px">${monthLabel(m)}</h2>`; lastM = m; }
      const info = BASE.days[d] || {};
      const S0 = byDay[d][0];
      h += `<div class="day"><div class="day-h"><span class="dd">${fmtD(d)}</span><span class="muted">${wdName(d)}</span>${S0.weekday ? '<span class="pill warn">平日</span>' : (info.hol ? `<span class="pill mute">${esc(info.hol)}</span>` : '')}<span class="act">${esc(info.act || '')}</span>${info.note ? `<span class="dn">${esc(info.note)}</span>` : ''}</div>`;
      for (const s of byDay[d]) {
        const A = M.asg[s.id], need = slotNeed(M, s), c = cnt(bySlot[s.id]);
        const names = A.p.map(id => M.pById[id].n);
        h += `<div class="slot ${c.v ? 'v' : c.n ? 'w' : ''} ${s.cancel ? 'cx' : ''}" data-act="openSlot" data-id="${s.id}" tabindex="0" role="button">
          <span class="cat">${esc(s.cat)}${s.e && s.e !== s.d ? `<span class="muted small">・${s.de - s.ds + 1}天</span>` : ''}</span>
          <span>${areaTag(s.area)} <span class="muted small">${esc(grpLabel(s))}</span>${s.groupKey ? ' <span class="pill mute" style="font-size:10.5px">組</span>' : ''}${s.edited ? ' <span class="pill acc">改派</span>' : ''}</span>
          <span class="loc">${esc(s.loc)}</span>
          <span class="names">${s.cancel ? '此日不需要' : names.length ? esc(names.join('、')) : '<span class="muted">尚未排人</span>'}</span>
          <span class="iss"><span class="fill ${A.p.length < need ? 'short' : ''}"><span class="num">${A.p.length}/${need}</span><span class="meter"><i style="width:${need ? Math.min(100, A.p.length / need * 100) : 0}%"></i></span></span>${badges(bySlot[s.id])}</span>
        </div>`;
      }
      h += `</div>`;
    }
    return h;
  }

  function renderMatrix(filteredSlots) {
    const slotDates = new Set(filteredSlots.map(s => s.d));
    const allDates = Object.keys(BASE.days).sort().filter(d => {
      if (F.month && d.slice(0, 7) !== F.month) return false;
      if (F.areaF || F.cat || F.only || F.q) return slotDates.has(d);
      return true;
    });
    const slotsByDay = {};
    for (const s of M.slots) (slotsByDay[s.d] = slotsByDay[s.d] || []).push(s);

    const cols = [
      ['廚務', s => isCookSlot(s)],
      ['環境整理', s => s.cat === '環境整理'],
      ['服務', s => s.cat === '服務'],
      ['禮節', s => s.cat === '禮節'],
      ['洗碗', s => s.cat === '洗碗'],
      ['忠恕輪值', s => s.cat.startsWith('忠恕')],
      ['前晚／協辦', s => s.cat === '大典前晚' || s.cat === '協辦']
    ];

    let h = `<div class="matrix-wrap"><table class="matrix"><thead><tr><th>日期</th><th>活動</th>${cols.map(([n]) => `<th>${n}</th>`).join('')}<th>交通</th></tr></thead><tbody>`;
    let lastM = '';
    for (const d of allDates) {
      const m = d.slice(0, 7);
      if (m !== lastM) {
        h += `<tr class="month"><td colspan="10">${monthLabel(m)}</td></tr>`;
        lastM = m;
      }
      const info = BASE.days[d] || {};
      const ss = (slotsByDay[d] || []).filter(s => !s.cancel);
      const dayBad = ss.some(s => cnt(bySlot[s.id]).v > 0);
      const dayWarn = !dayBad && ss.some(s => cnt(bySlot[s.id]).n > 0);
      const w = wdOf(d);
      const isWk = w > 0 && w < 6 && !M.holidays.has(d);
      h += `<tr class="${dayBad ? 'lv-bad' : dayWarn ? 'lv-warn' : ''}">
        <td class="date">${fmtD(d)} <span style="${isWk && ss.length ? 'color:var(--bad);font-weight:700' : 'color:var(--muted)'}">${WD[w]}</span></td>
        <td><div style="font-weight:500">${esc(info.act || '')}</div>${info.loc ? `<div class="small muted">${esc(info.loc)}</div>` : ''}</td>`;
      for (const [, pred] of cols) {
        const list = ss.filter(pred);
        h += `<td>`;
        for (const s of list) {
          const c = cnt(bySlot[s.id]);
          const A = M.asg[s.id];
          const need = slotNeed(M, s);
          const cls = c.v ? 'bad' : c.n ? 'warn' : '';
          h += `<button class="chip-slot ${cls}" style="--ac:var(--c-${esc(s.area)})" data-act="openSlot" data-id="${s.id}" title="點擊改派或設定人員">
            <span class="cdot"></span>
            <span class="rn">${esc(s.area)}</span>
            ${s.grp ? `<span class="muted small">${esc(grpLabel(s))}</span>` : ''}
            <span class="num small muted">${A.p.length}/${need}</span>
          </button><br>`;
        }
        h += `</td>`;
      }
      const trs = ss.filter(s => s.cat === '交通');
      h += `<td>${trs.map(s => `<button class="chip-slot" style="--ac:var(--c-交通隊)" data-act="openSlot" data-id="${s.id}"><span class="cdot"></span><span class="rn">${esc(s.grp)}</span> <span class="num small muted">${M.asg[s.id].p.length}/${slotNeed(M, s)}</span></button>`).join(' ')}</td>`;
      h += `</tr>`;
    }
    h += `</tbody></table></div>`;
    return h;
  }

  /* ---------- 分頁 4：總覽與負擔 (#overview) ---------- */
  function areaStats() {
    const rows = {};
    for (const a of AREAS.concat(['青年班', '新民班', '機動', '交通隊'])) {
      rows[a] = { a, k: 0, sv: 0, lj: 0, wash: 0, zzW: 0, zzS: 0, zzU: 0, ex: 0, hol: 0, wd: 0, wdays: 0, need: 0, got: 0, v: 0, n: 0, ppl: 0, occ: 0 };
    }
    for (const s of M.slots) {
      if (s.cancel || !rows[s.area]) continue;
      const r = rows[s.area], sh = +s.share || 1;
      if (s.weekday) { r.wd += sh; r.wdays += s.wdays * sh; } else r.hol += sh;
      if (isCookSlot(s)) r.k += sh;
      else if (s.cat === '環境整理' || s.cat === '服務') r.sv += sh;
      else if (s.cat === '禮節') r.lj += sh;
      else if (s.cat === '洗碗') r.wash += sh;
      else if (s.cat === '忠恕平日') r.zzW += sh;
      else if (s.cat === '忠恕週六') r.zzS += sh;
      else if (s.cat === '忠恕週日') r.zzU += sh;
      else if (s.cat === '大典前晚' || s.cat === '協辦') r.ex += sh;
      r.need += slotNeed(M, s);
      r.got += M.asg[s.id].p.length;
    }
    for (const c of openIss) if (c.scope === '區' && rows[c.area]) { if (c.lvl === '違規') rows[c.area].v++; else rows[c.area].n++; }
    for (const p of M.people) if (rows[p.a] && !p.off) { rows[p.a].ppl++; rows[p.a].occ += occasions(M.personSlots[p.id] || []).length; }
    return Object.values(rows);
  }

  function renderOverview() {
    const live = M.slots.filter(s => !s.cancel);
    const need = live.reduce((a, s) => a + slotNeed(M, s), 0);
    const got = live.reduce((a, s) => a + M.asg[s.id].p.length, 0);
    const c = cnt(ISS);
    const used = M.people.filter(p => (M.personSlots[p.id] || []).length).length;
    const occs = M.people.map(p => ({ p, n: occasions(M.personSlots[p.id] || []).length }));
    const act = occs.filter(o => AREAS.includes(o.p.a) && !o.p.off);
    const buckets = [['0 次', x => x === 0], ['1–2', x => x >= 1 && x <= 2], ['3–4', x => x >= 3 && x <= 4], ['5–6', x => x >= 5 && x <= 6], ['7–10', x => x >= 7 && x <= 10], ['11 次以上', x => x > 10]];
    const bmax = Math.max(1, ...buckets.map(([, f]) => act.filter(o => f(o.n)).length));
    const rows = areaStats();
    const f1 = x => Number.isInteger(x) ? x : x.toFixed(1);

    let h = `<div class="kpis">
      <div class="kpi"><div class="l">全年勤務格</div><div class="v">${live.length}</div><div class="s">v9.2 行事曆（含忠恕、交通）</div></div>
      <div class="kpi"><div class="l">已排人次／需要</div><div class="v">${got}<span class="small muted"> / ${need}</span></div><div class="meter"><i style="width:${need ? Math.min(100, got / need * 100) : 0}%"></i></div></div>
      <div class="kpi bad"><div class="l">未處理違規</div><div class="v">${c.v}</div><div class="s">區層級 ${openIss.filter(x => x.lvl === '違規' && x.scope === '區').length} · 個人 ${openIss.filter(x => x.lvl === '違規' && x.scope !== '區').length}</div></div>
      <div class="kpi warn"><div class="l">未處理注意</div><div class="v">${c.n}</div><div class="s">已協調或接受 ${ISS.filter(x => !x.open).length}</div></div>
      <div class="kpi"><div class="l">有排到的人</div><div class="v">${used}</div><div class="s">名冊共 ${M.people.length} 人</div></div>
    </div>`;

    h += `<section class="panel" style="margin-bottom:14px">
      <h2>各區負擔統計（含忠恕平日／週六／週日與人員達成率）</h2>
      <div class="tbl-wrap"><table><thead>
        <tr><th>區</th><th class="r">廚務</th><th class="r">服/整</th><th class="r">禮節</th><th class="r">洗碗</th><th class="r">忠恕平</th><th class="r">忠恕六</th><th class="r">忠恕日</th><th class="r">前晚協辦</th><th class="r">假日次</th><th class="r">平日次</th><th class="r">請假天</th><th class="r">已排／需要</th><th class="r">問題</th></tr>
      </thead><tbody>`;
    for (const r of rows) {
      h += `<tr class="click" data-act="goWorkArea" data-a="${esc(r.a)}">
        <td>${areaTag(r.a)}</td>
        <td class="r num">${f1(r.k)}</td><td class="r num">${f1(r.sv)}</td><td class="r num">${f1(r.lj)}</td><td class="r num">${f1(r.wash)}</td>
        <td class="r num">${f1(r.zzW)}</td><td class="r num">${f1(r.zzS)}</td><td class="r num">${f1(r.zzU)}</td><td class="r num">${f1(r.ex)}</td>
        <td class="r num"><b>${f1(r.hol)}</b></td><td class="r num" style="color:var(--warn)"><b>${f1(r.wd)}</b></td><td class="r num">${f1(r.wdays)}</td>
        <td class="r num">${r.got} / ${r.need}</td>
        <td class="r">${r.v ? `<span class="badge bad">${r.v}</span>` : ''}${r.n ? ` <span class="badge warn">${r.n}</span>` : ''}</td>
      </tr>`;
    }
    h += `</tbody></table></div>
      <p class="small muted">點擊任一列可直接跳轉至該區的「依區排人」工作台。聯合勤務（如基新隊、新莊+基隆洗碗）各算 0.5 次。</p>
    </section>`;

    h += `<div class="grid g2">
      <section class="panel"><h2>人員年度次數分佈（六大區 ${act.length} 人）</h2><div class="bars">`;
    for (const [l, fn] of buckets) {
      const n = act.filter(o => fn(o.n)).length;
      const cls = l.startsWith('11') ? 'v' : l === '7–10' ? 'w' : '';
      h += `<div class="b"><span>${l}</span><span class="t"><i class="${cls}" style="width:${n / bmax * 100}%"></i></span><span class="num r">${n}</span></div>`;
    }
    h += `</div></section>`;

    const top = openIss.filter(x => x.lvl === '違規').slice(0, 8);
    h += `<section class="panel"><h2>需優先處理的違規</h2>`;
    if (!top.length) h += `<p class="empty">目前沒有未處理的違規。</p>`;
    for (const x of top) h += issueRow(x, true);
    if (openIss.filter(x => x.lvl === '違規').length > top.length) h += `<p><button class="linkish" data-act="goIssues">查看全部違規 →</button></p>`;
    h += `</section></div>`;
    return h;
  }

  /* ---------- 分頁 5：衝突與議題 (#issues) ---------- */
  function issueRow(c, compact) {
    const p = c.pid ? M.pById[c.pid] : null;
    const sl = c.slots.map(id => M.byId[id]).filter(Boolean);
    const links = sl.map(s => `<button class="linkish" data-act="openSlot" data-id="${s.id}">${fmtD(s.d)} ${esc(s.cat)}</button>`).join('、');
    const st0 = c.ack ? c.ack.st : '未處理';
    return `<div class="issue ${c.open ? '' : 'done'}">
      <div>${lvlPill(c.lvl)}</div>
      <div>
        <div>${p ? `<button class="linkish" data-act="openPerson" data-id="${p.id}">${esc(c.msg)}</button>` : esc(c.msg)}</div>
        <div class="meta">${esc(c.rule)}・${esc(ruleName(c.rule))}${links ? '・' + links : ''}${c.ack && c.ack.note ? `<br>處理：${esc(c.ack.note)}` : ''}</div>
      </div>
      ${compact ? '' : `<div class="ctl">
        <select data-ack="${esc(c.key)}" aria-label="處理狀態">${ACK_ST.map(x => `<option ${x === st0 ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input type="text" data-acknote="${esc(c.key)}" placeholder="協調結果／備案" value="${esc(c.ack ? c.ack.note : '')}">
      </div>`}
    </div>`;
  }

  function renderIssues() {
    let h = `<div class="subtabs">
      <button class="subtab ${F.issTab === 'rules' ? 'on' : ''}" data-act="selIssTab" data-t="rules">規則檢查清單（${openIss.length} 待處理）</button>
      <button class="subtab ${F.issTab === 'disc' ? 'on' : ''}" data-act="selIssTab" data-t="disc">籌備會議議題 D1–D16（${BASE.disc.length} 項）</button>
    </div>`;

    if (F.issTab === 'disc') {
      const col = { 紅: 'var(--bad)', 橙: 'var(--warn)', 黃: 'var(--info)' };
      h += `<div class="grid g2">`;
      for (const x of BASE.disc) {
        const dc = st.decisions[x.id] || {};
        h += `<div class="disc-card" style="--dc:${col[x.lvl] || 'var(--line)'}">
          <div class="row" style="justify-content:space-between">
            <div class="row"><b>${esc(x.id)}</b><span class="pill ${x.lvl === '紅' ? 'bad' : x.lvl === '橙' ? 'warn' : 'info'}">${esc(x.span)}</span></div>
            <select data-disc-st="${x.id}" style="border:1px solid var(--line);border-radius:6px;padding:2px 6px;background:var(--surface)">
              ${['未討論', '討論中', '已決定'].map(o => `<option ${(dc.status || '未討論') === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select>
          </div>
          <div>${esc(x.what)}</div>
          <div class="small muted">問題：${esc(x.issue)}</div>
          <div class="small muted">選項：${esc(x.opts)}</div>
          <textarea data-disc-tx="${x.id}" rows="2" placeholder="輸入會議結論與負責人…" style="border:1px solid var(--line);border-radius:6px;padding:5px 8px;background:var(--sunk)">${esc(dc.text || '')}</textarea>
        </div>`;
      }
      h += `</div>`;
      return h;
    }

    let L = ISS;
    if (F.ilvl) L = L.filter(c => c.lvl === F.ilvl);
    if (F.iscope) L = L.filter(c => c.scope === F.iscope);
    if (F.irule) L = L.filter(c => c.rule === F.irule);
    if (F.iarea) L = L.filter(c => c.area && c.area.includes(F.iarea));
    if (F.ist === '未結') L = L.filter(c => c.open);
    else if (F.ist) L = L.filter(c => (c.ack ? c.ack.st : '未處理') === F.ist);
    const rules = [...new Set(ISS.map(c => c.rule))].sort();

    h += `<div class="filters">
      <select id="iLvl"><option value="">違規＋注意</option><option ${F.ilvl === '違規' ? 'selected' : ''}>違規</option><option ${F.ilvl === '注意' ? 'selected' : ''}>注意</option></select>
      <select id="iScope"><option value="">全部層級</option>${['區', '人', '格'].map(x => `<option value="${x}" ${F.iscope === x ? 'selected' : ''}>${x === '區' ? '區層級' : x === '人' ? '個人' : '勤務格'}</option>`).join('')}</select>
      <select id="iRule"><option value="">全部規則</option>${rules.map(r => `<option value="${r}" ${F.irule === r ? 'selected' : ''}>${r} ${esc(ruleName(r))}（${ISS.filter(c => c.rule === r).length}）</option>`).join('')}</select>
      <select id="iArea"><option value="">全部區</option>${AREAS.map(a => `<option ${F.iarea === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
      <select id="iSt"><option value="未結" ${F.ist === '未結' ? 'selected' : ''}>未處理＋協調中</option><option value="" ${F.ist === '' ? 'selected' : ''}>全部狀態</option>${ACK_ST.map(x => `<option ${F.ist === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <span class="small muted">${L.length} 筆</span>
    </div>`;
    if (!L.length) return h + `<p class="empty">沒有符合條件的問題。</p>`;
    h += `<section class="panel">${L.slice(0, 300).map(c => issueRow(c)).join('')}${L.length > 300 ? `<p class="small muted">只顯示前 300 筆，請用篩選縮小範圍。</p>` : ''}</section>`;
    return h;
  }

  /* ---------- 分頁 6：規則與匯出 (#settings) ---------- */
  function sevSeg(id, cur, withAllow) {
    const opts = withAllow ? ['違規', '注意', '關閉', '允許'] : SEVS;
    return `<span class="seg" role="group">${opts.map((s, i) => `<button class="${s === cur ? 'on' : ''} s${i}" data-act="sev" data-rule="${id}" data-v="${s}">${s}</button>`).join('')}</span>`;
  }
  function paramInput(key, label, type, opts) {
    const v = M.R.p[key];
    if (type === 'bool') return `<label class="field" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" data-param="${key}" ${v ? 'checked' : ''}>${esc(label)}</label>`;
    if (type === 'sel') return `<label class="field">${esc(label)}<select data-param="${key}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    if (type === 'text') return `<label class="field wide">${esc(label)}<input type="text" data-param="${key}" value="${esc(v)}"></label>`;
    return `<label class="field">${esc(label)}<input type="number" data-param="${key}" value="${esc(v)}"></label>`;
  }

  function renderSettings() {
    if (st.largeMode) {
      return `<div class="grid" style="gap:14px">
        <section class="panel">
          <h2>顯示與操作模式</h2>
          <p class="small muted">目前為「大字簡化版」，字體放大、排版簡化為單欄，適合手機閱讀與操作。</p>
          <div class="elder-actions">
            <button class="btn pri" data-act="toggleLarge">切換回標準版（完整總表與規則參數）</button>
            <button class="btn" data-act="toggleTheme">切換深色／淺色外觀（目前：${st.theme === 'dark' ? '深色' : st.theme === 'light' ? '淺色' : '跟隨系統'}）</button>
          </div>
        </section>
        <section class="panel">
          <h2>匯出報表與備份還原</h2>
          <div class="elder-actions">
            <button class="btn pri" data-act="export" data-k="sched">匯出排班明細（CSV 表格）</button>
            <button class="btn" data-act="export" data-k="groups">匯出各區組別名單（CSV）</button>
            <button class="btn" data-act="export" data-k="people">匯出人員統計（CSV）</button>
            <button class="btn" data-act="export" data-k="json">下載完整備份檔（JSON）</button>
            <label class="btn" style="text-align:center">匯入 JSON 備份還原<input type="file" id="importJson" accept="application/json,.json" hidden></label>
            <button class="btn danger" data-act="resetAll">重設所有本機資料</button>
          </div>
        </section>
      </div>`;
    }

    const counts = {};
    for (const c of ISS) counts[c.rule] = (counts[c.rule] || 0) + 1;

    let h = `<div class="grid g2" style="margin-bottom:16px">
      <section class="panel">
        <h2>匯出報表與備份</h2>
        <div class="row" style="margin-bottom:10px">
          <button class="btn pri sm" data-act="export" data-k="sched">匯出排班明細 CSV</button>
          <button class="btn sm" data-act="export" data-k="groups">匯出各區組別名單 CSV</button>
          <button class="btn sm" data-act="export" data-k="people">匯出人員統計 CSV</button>
          <button class="btn sm" data-act="export" data-k="issues">匯出衝突清單 CSV</button>
          <button class="btn sm" data-act="export" data-k="json">下載完整備份 JSON</button>
        </div>
        <div class="row">
          <label class="btn sm">匯入 JSON 備份還原<input type="file" id="importJson" accept="application/json,.json" hidden></label>
          <button class="btn sm danger" data-act="resetAll">重設所有本機資料</button>
        </div>
        <p class="small muted" style="margin-bottom:0">所有資料皆即時儲存於此瀏覽器本機（離線亦可使用）。建議定期下載 JSON 備份或傳給各區幹部共用。</p>
      </section>

      <section class="panel">
        <h2>最近操作紀錄（${st.log.length} 筆）</h2>
        <div style="max-height:175px;overflow-y:auto">`;
    if (!st.log.length) h += `<p class="small muted">尚無操作紀錄。</p>`;
    else {
      h += `<table class="small"><tbody>` + st.log.slice(0, 40).map(l => `<tr><td class="num muted" style="white-space:nowrap">${new Date(l.t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(l.msg)}</td></tr>`).join('') + `</tbody></table>`;
    }
    h += `</div></section></div>`;

    h += `<div class="row" style="margin-bottom:12px;justify-content:space-between">
      <h2 style="margin:0">排班規則與檢查參數</h2>
      <button class="btn sm" data-act="resetRules">還原預設規則</button>
    </div>`;

    for (const [lv, title] of [['區', '區層級規則'], ['人', '個人層級規則'], ['格', '勤務格規則']]) {
      h += `<h3>${title}</h3><div class="rules" style="margin-bottom:16px">`;
      for (const r of RULE_META.filter(x => x.lv === lv)) {
        h += `<div class="rule">
          <div class="rh"><span class="rid">${r.id}</span><div><div class="rn">${esc(r.name)}</div>${r.desc ? `<div class="rd">${esc(r.desc)}</div>` : ''}</div><span class="cnt">${counts[r.id] ? `<span class="pill mute">${counts[r.id]}</span>` : ''}</span></div>
          ${!r.matrix ? `<div>${sevSeg(r.id, M.R.sev[r.id])}</div>` : ''}
          ${r.params ? `<div class="params">${r.params.map(p => paramInput(p[0], p[1], p[2], p[3])).join('')}</div>` : ''}
          ${r.matrix ? renderMatrixRule() : ''}
        </div>`;
      }
      h += `</div>`;
    }

    h += `<h3>日期設定</h3><div class="rules" style="margin-bottom:16px"><div class="rule">
      ${paramInput('mdDates', '明德班日（各區，新莊除外）', 'text')}
      ${paramInput('xzDates', '新莊明德班日（第 4 週日）', 'text')}
      ${paramInput('holidays', '國定假日（平日中算假日）', 'text')}
    </div></div>`;

    h += `<h3>自動排人權重</h3><div class="rules"><div class="rule"><div class="params">${AUTO_PARAMS.map(p => paramInput(p[0], p[1], p[2])).join('')}</div></div></div>`;
    return h;
  }

  function renderMatrixRule() {
    let h = `<div class="tbl-wrap"><table class="mx"><thead><tr><th></th>${JOB_CLASSES.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
    JOB_CLASSES.forEach((a, i) => {
      h += `<tr><th>${a}</th>`;
      JOB_CLASSES.forEach((b, j) => {
        if (j < i) { h += `<td class="muted">·</td>`; return; }
        const v = M.R.mx[a + '|' + b] || '違規';
        const vi = ['違規', '注意', '關閉', '允許'].indexOf(v);
        h += `<td><select class="v${vi}" data-mx="${a}|${b}">${['違規', '注意', '允許'].map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></td>`;
      });
      h += `</tr>`;
    });
    h += `</tbody></table></div>`;
    return h;
  }

  /* ---------- 抽屜：勤務格 ---------- */
  function slotDrawer(id) {
    const s = M.byId[id];
    if (!s) return '';
    const A = M.asg[s.id], need = slotNeed(M, s), info = BASE.days[s.d] || {};
    const iss = bySlot[s.id] || [];
    const gm = s.groupKey ? GROUP_META_BY_ID[s.groupKey] : null;
    const grpOpts = groupOptionsForSlot(s);
    const areaOpts = isCookSlot(s) ? AREAS.concat(['機動', '青年班']) : s.cat === '交通' ? ['交通隊'] : AREAS.concat(s.cat === '洗碗' ? ['新民班'] : []);
    const dc = areaDelta(s.id);

    let h = `<div class="dh">
      <div style="min-width:0">
        <div class="small muted">${esc(s.label || info.act || '')}</div>
        <h2>${esc(slotTitle(s))}</h2>
        <div class="row" style="margin-top:4px">${areaTag(s.area)}<span class="muted">${esc(grpLabel(s))} · ${esc(s.loc)} · ${s.weekday ? '平日' : '假日'}</span></div>
      </div>
      <button class="btn ghost x" data-act="close" aria-label="關閉">${st.largeMode ? '✕ 關閉' : '✕'}</button>
    </div><div class="db">`;

    if (info.note) h += `<div class="small muted">總表備註：${esc(info.note)}</div>`;

    // 負責區與組別
    h += `<div class="sec"><h3>負責區與組別<span class="sp small muted">括號為改派後區層級增減</span></h3><div class="opts">`;
    for (const a of areaOpts) {
      const d = dc[a] || { dv: 0, dn: 0 };
      const fmt = (n, l) => n ? `<b class="${n > 0 ? 'up' : 'dn'}">${l}${n > 0 ? '+' : ''}${n}</b>` : '';
      h += `<button class="opt ${a === s.area ? 'cur' : ''}" data-act="setArea" data-id="${s.id}" data-a="${esc(a)}">${areaTag(a)}<span class="d">${a === s.area ? '目前' : (fmt(d.dv, '違規') + ' ' + fmt(d.dn, '注意')).trim() || '無變化'}</span></button>`;
    }
    h += `</div><div class="row" style="margin-top:8px">`;
    if (grpOpts.length) {
      h += `<label class="field">組別／隊別<select id="edGrp">${grpOpts.map(g => `<option value="${esc(g)}" ${g === s.grp ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>`;
    } else {
      h += `<label class="field">組別／隊別<input type="text" id="edGrp" value="${esc(s.grp)}" style="width:110px"></label>`;
    }
    h += `<label class="field">需要人數<input type="number" id="edNeed" value="${esc(+s.need || '')}" style="width:80px"></label>
      <label class="field">地點<select id="edLoc">${['天達堂', '道院', '會館', '德光', '各區'].map(x => `<option ${x === s.loc ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="field" style="flex:1;min-width:150px">備註<input type="text" id="edNote" value="${esc(s.note)}"></label>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn sm pri" data-act="saveSlot" data-id="${s.id}">儲存設定</button>
      <label class="small muted" style="display:flex;gap:5px;align-items:center"><input type="checkbox" id="edCancel" ${s.cancel ? 'checked' : ''}>此日不需要</label>
      ${s.extra ? `<button class="btn sm danger" data-act="delSlot" data-id="${s.id}">刪除新增勤務</button>` : ''}
    </div></div>`;

    if (gm) {
      h += `<div class="panel" style="background:var(--accent-soft);border-color:var(--accent)">
        <div class="small">本場次連動組別：<b>${esc(gm.name)}</b>（目前固定成員 ${A.fromGroup.length} 人）。下方新增會列為「本場臨時支援」，移除會列為「本場請假排除」。若要調整整個組別固定成員，請前往「依區排人 → 有組別設定」。</div>
      </div>`;
    }

    h += `<div class="sec"><h3>這一格的問題 ${badges(iss)}</h3>${iss.length ? iss.map(c => issueRow(c, true)).join('') : '<p class="small muted">沒有問題。</p>'}</div>`;

    // 直接輸入姓名加入
    h += `<div class="sec">
      <h3>已排人員 <span class="num">${A.p.length}/${need}</span><span class="sp row"><button class="btn sm" data-act="autoOne" data-id="${s.id}">自動補滿</button><button class="btn sm ghost" data-act="clearOne" data-id="${s.id}">清除</button></span></h3>
      <div class="quick-add" style="margin-bottom:8px">
        <input type="text" id="sd_add_${s.id}" data-slot-input="${s.id}" placeholder="直接輸入姓名加入本場（可空白/逗號分隔多位）">
        <button class="btn sm pri" data-act="slotDrawerAddNames" data-id="${s.id}">加入</button>
      </div>
      <div class="plist">`;
    if (!A.p.length) h += `<p class="small muted">尚未排人。</p>`;
    const sorted = A.p.slice().sort((a, b) => canLead(M.pById[b], s) - canLead(M.pById[a], s));
    for (const pid of sorted) {
      const p = M.pById[pid];
      const my = (byPerson[pid] || []).filter(c => c.slots.includes(s.id) || c.rule.startsWith('P5') || c.rule === 'P6');
      const lk = A.lk.includes(pid);
      const isInc = gm && A.include.includes(pid);
      const occN = occasions(M.personSlots[pid] || []).length;
      h += `<div class="prow">
        <div style="min-width:0">
          <span class="nm"><button class="linkish" data-act="openPerson" data-id="${pid}" style="color:inherit;text-decoration:none">${personLabel(p)}</button></span>
          ${canLead(p, s) ? ' <span class="pill acc">可帶隊</span>' : ''}
          ${isInc ? ' <span class="pill info">臨時支援</span>' : ''}
          <div class="info">全年 ${occN} 次 · ${roleTags(p)}</div>
          ${my.length ? `<div class="chips">${my.map(c => `<span class="pill ${c.lvl === '違規' ? 'bad' : 'warn'}" title="${esc(c.msg)}">${esc(ruleName(c.rule))}</span>`).join('')}</div>` : ''}
        </div>
        <div class="acts">
          ${!gm ? `<button class="icon-btn ${lk ? 'on' : ''}" data-act="lock" data-id="${s.id}" data-p="${pid}" title="${lk ? '已鎖定' : '鎖定'}">${lk ? '鎖' : '○'}</button>` : ''}
          <button class="icon-btn" data-act="rm" data-id="${s.id}" data-p="${pid}" title="${gm ? '此日請假排除' : '移除'}">✕</button>
        </div>
      </div>`;
    }
    h += `</div></div>`;

    if (!s.cancel) {
      let C = rankCandidates(M, s, { all: F.call });
      if (F.cq) C = C.filter(e => e.p.n.includes(F.cq.trim()));
      h += `<div class="sec">
        <h3>候選人<span class="sp row"><label class="small muted" style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="cAll" ${F.call ? 'checked' : ''}>含其他區、非本組</label></span></h3>
        <input type="search" id="cQ" placeholder="搜尋姓名" value="${esc(F.cq)}" style="border:1px solid var(--line);border-radius:6px;padding:6px 9px;background:var(--surface);width:100%;margin-bottom:6px">
        <div class="plist">`;
      for (const e of C.slice(0, 40)) {
        const p = e.p;
        const chips = e.hard.map(c => `<span class="pill bad" title="${esc(c.msg)}">${esc(ruleName(c.rule))}</span>`)
          .concat(e.soft.map(c => `<span class="pill warn" title="${esc(c.msg)}">${esc(ruleName(c.rule))}</span>`));
        if (e.mates.length) chips.push(`<span class="pill ok">搭檔 ${esc(e.mates.join('、'))}</span>`);
        h += `<div class="prow">
          <div style="min-width:0"><span class="nm">${personLabel(p)}</span>${canLead(p, s) ? ' <span class="pill acc">可帶隊</span>' : ''}<div class="info">全年 ${e.occN} 次 · 分數 ${Math.round(e.score)} · ${roleTags(p)}</div>${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}</div>
          <div class="acts"><button class="btn sm ${e.hard.length ? '' : 'pri'}" data-act="add" data-id="${s.id}" data-p="${p.id}">加入</button></div>
        </div>`;
      }
      if (!C.length) h += `<p class="small muted">沒有候選人。可勾選「含其他區」或上方直接輸入姓名加入。</p>`;
      h += `</div></div>`;
    }
    return h + `</div>`;
  }

  /* ---------- 抽屜：人員編輯與時間軸 ---------- */
  function personDrawer(id) {
    const p = M.pById[id];
    if (!p) return '';
    const list = M.personSlots[id] || [], occ = occasions(list), cap = capOf(M, p), iss = byPerson[id] || [];
    const o = st.pov[id] || {};
    const gNames = (M.personGroups[id] || []).map(gk => GROUP_META_BY_ID[gk]?.name || gk);

    let h = `<div class="dh">
      <div>
        <h2>${esc(p.n)}</h2>
        <div class="row" style="margin-top:4px">${areaTag(p.a)}<span class="muted">${esc(p.sx || '')}${p.age ? '・' + p.age + ' 歲' : ''} · ${p.src === 'N' ? '高出席未服務' : p.src === 'M' ? '手動新增' : '115 服務 ' + p.n115 + ' 場'}</span></div>
        <div class="row" style="margin-top:4px">${gNames.map(n => `<span class="pill acc">${esc(n)}</span>`).join(' ')} ${roleTags(p)}</div>
      </div>
      <button class="btn ghost x" data-act="close" aria-label="關閉">${st.largeMode ? '✕ 關閉' : '✕'}</button>
    </div><div class="db">`;

    h += `<div class="kpis" style="margin:0">
      <div class="kpi ${occ.length > cap.max ? 'bad' : occ.length > cap.ideal ? 'warn' : ''}"><div class="l">116 年次數</div><div class="v">${occ.length}</div><div class="s">理想 ${cap.ideal}／上限 ${cap.max}</div></div>
      <div class="kpi"><div class="l">問題</div><div class="v" style="font-size:18px">${badges(iss) || '<span class="muted small">無</span>'}</div></div>
    </div>`;

    h += `<div class="sec"><h3>排班時間軸</h3><div class="tl">`;
    if (!list.length) h += `<p class="small muted">尚未排到任何勤務。</p>`;
    occ.forEach((oc, i) => {
      if (i) {
        const gap = oc.ds - occ[i - 1].de;
        const cls = gap <= +M.R.p.hard ? 'bad' : gap <= +M.R.p.soft ? 'warn' : '';
        h += `<div class="gap ${cls}">↓ 隔 ${gap} 天</div>`;
      }
      for (const s of oc.slots) {
        h += `<div class="it"><span class="num">${fmtD(s.d)}（${WD[s.wd]}）</span><span><button class="linkish" data-act="openSlot" data-id="${s.id}">${esc(s.cat)}</button> ${areaTag(s.area)} <span class="muted small">${esc(grpLabel(s))} · ${esc(s.loc)}</span></span><span>${s.weekday ? '<span class="pill warn">平日</span>' : ''}</span></div>`;
      }
    });
    h += `</div></div>`;

    h += `<div class="sec"><h3>問題</h3>${iss.length ? iss.map(c => issueRow(c, true)).join('') : '<p class="small muted">沒有問題。</p>'}</div>`;

    const mates = Object.entries(M.aff[id] || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (mates.length) {
      h += `<div class="sec"><h3>忠恕固定搭檔（親和分數）</h3><div class="row">${mates.map(([q, v]) => `<button class="pill ${v >= 0.7 ? 'ok' : 'mute'}" data-act="openPerson" data-id="${q}">${esc(M.pById[q].n)} ${v.toFixed(2)}</button>`).join('')}</div></div>`;
    }

    h += `<div class="sec"><h3>基本資料與專長設定</h3>
      <div class="row">
        <label class="field">姓名<input type="text" id="peName" value="${esc(p.n)}" style="width:100px"></label>
        <label class="field">所屬區<select id="peArea">${PERSON_AREAS.map(a => `<option ${a === p.a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
        <label class="field">性別<select id="peSx">${['', '乾', '坤', '童'].map(x => `<option value="${x}" ${x === (p.sx || '') ? 'selected' : ''}>${x || '未填'}</option>`).join('')}</select></label>
        <label class="field">年齡<input type="number" id="peAge" value="${esc(p.age || '')}" style="width:72px"></label>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="field">廚務角色<select id="peCr">${['', '主廚', '大廚', '二廚'].map(x => `<option value="${x}" ${x === (p.cr || '') ? 'selected' : ''}>${x || '無'}</option>`).join('')}</select></label>
        <label class="field">帶隊身分<input type="text" id="peLead" value="${esc(p.lead || '')}" placeholder="如 服務組長、禮節小組長" style="width:180px"></label>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="field" style="flex:1">禮節經驗<input type="text" id="peLi" value="${esc(p.li || '')}" placeholder="有填即具禮節經驗"></label>
        <label class="field" style="width:120px">交通角色<input type="text" id="peTr" value="${esc(p.tr || '')}" placeholder="司機／指揮"></label>
      </div>
    </div>`;

    h += `<div class="sec"><h3>排班條件（不可排／工作狀態）</h3>
      <div class="row">
        <label class="field">工作狀態<select id="pvWork">${['', '上班中', '退休／自由', '學生'].map(x => `<option value="${x}" ${x === (o.work || '') ? 'selected' : ''}>${x || '未填'}</option>`).join('')}</select></label>
        <label class="field">年度上限<input type="number" id="pvCap" value="${esc(o.cap || '')}" placeholder="依規則" style="width:88px"></label>
        <label class="small muted" style="display:flex;gap:5px;align-items:center;margin-top:16px"><input type="checkbox" id="pvOff" ${o.off ? 'checked' : ''}>暫停排班</label>
      </div>
      <div class="field" style="margin-top:8px">不方便月份<div class="row">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => `<label class="small" style="display:flex;gap:2px;align-items:center"><input type="checkbox" data-month="${m}" ${(o.months || []).map(Number).includes(m) ? 'checked' : ''}>${m}</label>`).join('')}</div></div>
      <label class="field" style="margin-top:8px">不可排日期（2027-05-29，空白分隔）<input type="text" id="pvUnav" value="${esc(o.unav || '')}"></label>
      <label class="field" style="margin-top:8px">備註<input type="text" id="pvNote" value="${esc(o.note || '')}"></label>
      <div class="row" style="margin-top:10px"><button class="btn sm pri" data-act="savePerson" data-id="${id}">儲存人員資料與條件</button></div>
    </div>`;

    return h + `</div>`;
  }

  /* ---------- 對話框 ---------- */
  function autoModal() {
    return `<div class="modal-scrim" data-act="closeModal"></div><div class="modal" role="dialog" aria-label="自動排人">
      <h2 style="margin:0">自動排人（無組別／未滿額勤務）</h2>
      <label class="field">範圍<select id="auScope"><option value="all">全年</option>${monthsList().map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('')}</select></label>
      <label class="field">區<select id="auArea"><option value="">全部區</option>${ALL_WORK_AREAS.map(a => `<option>${a}</option>`).join('')}</select></label>
      <label class="field">方式<select id="auMode"><option value="fill">只補空位（保留已排與固定組別）</option><option value="redo">重排無組別（保留鎖定與固定組別）</option></select></label>
      <p class="small muted" style="margin:0">不會選取會造成違規的人；優先帶入固定搭檔與帶隊人員。執行後可按「復原上一步」。</p>
      <div class="row"><button class="btn pri" data-act="runAuto">執行自動排人</button><button class="btn" data-act="closeModal">取消</button></div>
    </div>`;
  }

  function addSlotModal() {
    return `<div class="modal-scrim" data-act="closeModal"></div><div class="modal" role="dialog" aria-label="新增勤務">
      <h2 style="margin:0">新增勤務</h2>
      <div class="row"><label class="field">開始日期<input type="date" id="nsD" value="2027-07-18" min="2027-01-01" max="2028-02-29"></label><label class="field">結束日期<input type="date" id="nsE"></label></div>
      <div class="row"><label class="field">類別<select id="nsCat">${CATS.map(c => `<option>${c}</option>`).join('')}</select></label><label class="field">區<select id="nsArea">${ALL_WORK_AREAS.map(a => `<option>${a}</option>`).join('')}</select></label></div>
      <div class="row"><label class="field">組別（無組別留空）<input type="text" id="nsGrp" style="width:110px"></label><label class="field">需要人數<input type="number" id="nsNeed" value="10" style="width:80px"></label><label class="field">地點<select id="nsLoc">${['天達堂', '道院', '會館', '德光', '各區'].map(x => `<option>${x}</option>`).join('')}</select></label></div>
      <div class="row"><button class="btn pri" data-act="createSlot">新增</button><button class="btn" data-act="closeModal">取消</button></div>
    </div>`;
  }

  function addPersonModal() {
    return `<div class="modal-scrim" data-act="closeModal"></div><div class="modal" role="dialog" aria-label="新增人員">
      <h2 style="margin:0">新增人員至 ${esc(F.area)} 名冊</h2>
      <div class="row">
        <label class="field" style="flex:1">姓名<input type="text" id="npName" placeholder="請輸入姓名"></label>
        <label class="field">所屬區<select id="npArea">${PERSON_AREAS.map(a => `<option ${a === F.area ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      </div>
      <div class="row">
        <label class="field">性別<select id="npSx"><option value="">未填</option><option>乾</option><option>坤</option><option>童</option></select></label>
        <label class="field">年齡<input type="number" id="npAge" style="width:80px"></label>
        <label class="field">廚務角色<select id="npCr"><option value="">無</option><option>主廚</option><option>大廚</option><option>二廚</option></select></label>
      </div>
      <div class="row">
        <label class="field" style="flex:1">帶隊／專長（選填）<input type="text" id="npLead" placeholder="如 忠恕小組長、服務組長"></label>
      </div>
      <div class="row">
        <label class="small"><input type="checkbox" id="npLi"> 具禮節經驗</label>
        <label class="small"><input type="checkbox" id="npTr"> 具交通經驗</label>
      </div>
      <div class="row"><button class="btn pri" data-act="createPerson">建立人員</button><button class="btn" data-act="closeModal">取消</button></div>
    </div>`;
  }

  /* ---------- 主繪製 ---------- */
  function render() {
    renderHeader();
    const sy = window.scrollY;
    const fn = {
      area: renderAreaWork,
      ungrouped: renderUngroupedPage,
      schedule: renderSchedule,
      overview: renderOverview,
      issues: renderIssues,
      settings: renderSettings
    }[view] || renderAreaWork;

    $('#main').innerHTML = fn();

    const layer = $('#layer');
    let lh = '';
    if (drawer) {
      lh += `<div class="scrim" data-act="close"></div><aside class="drawer" aria-label="詳細資料">${drawer.type === 'slot' ? slotDrawer(drawer.id) : personDrawer(drawer.id)}</aside>`;
    }
    if (modal === 'auto') lh += autoModal();
    else if (modal === 'addSlot') lh += addSlotModal();
    else if (modal === 'addPerson') lh += addPersonModal();

    const prevScroll = layer.querySelector('.db') ? layer.querySelector('.db').scrollTop : 0;
    const keep = layer.dataset.k === (drawer ? drawer.type + drawer.id : '');
    layer.innerHTML = lh;
    layer.dataset.k = drawer ? drawer.type + drawer.id : '';
    if (keep && layer.querySelector('.db')) layer.querySelector('.db').scrollTop = prevScroll;
    window.scrollTo(0, sy);
  }

  /* ---------- 業務操作函式 ---------- */
  function addNamesToGroup(gk, area, text) {
    const tokens = splitList(text);
    if (!tokens.length) { toast('請先輸入姓名'); return; }
    snapshotUndo('設定組別名單');
    const list = (st.groups[gk] = st.groups[gk] || []);
    let added = 0, created = 0, dup = 0;
    for (const tk of tokens) {
      const { person, created: isNew } = findOrCreatePersonByName(tk, area);
      if (isNew) {
        created++;
        recompute(); // 讓後續查詢可立即看到
      }
      if (!list.includes(person.id)) {
        list.push(person.id);
        added++;
      } else {
        dup++;
      }
    }
    const gname = GROUP_META_BY_ID[gk]?.name || gk;
    addLog(`組別 ${gname} 加入 ${added} 人${created ? `（新建立 ${created} 人）` : ''}`);
    schedule();
    toast(`${gname} 已加入 ${added} 人${created ? `（新建立 ${created} 位至${area}）` : ''}${dup ? `，${dup} 位已在組內` : ''}`);
  }

  function addNamesToSlot(slotId, text) {
    const s = M.byId[slotId];
    if (!s) return;
    const tokens = splitList(text);
    if (!tokens.length) { toast('請先輸入姓名'); return; }
    snapshotUndo('依日期輸入人員');
    let added = 0, created = 0, dup = 0;
    for (const tk of tokens) {
      const { person, created: isNew } = findOrCreatePersonByName(tk, s.area);
      if (isNew) {
        created++;
        recompute();
      }
      if (s.groupKey) {
        const mod = (st.slotMod[slotId] = st.slotMod[slotId] || { include: [], exclude: [], lk: [] });
        mod.exclude = (mod.exclude || []).filter(x => x !== person.id);
        if (!M.asg[slotId].p.includes(person.id) && !(mod.include || []).includes(person.id)) {
          (mod.include = mod.include || []).push(person.id);
          added++;
        } else dup++;
      } else {
        const a = (st.assign[slotId] = st.assign[slotId] || { p: [], lk: [] });
        if (!a.p.includes(person.id)) {
          a.p.push(person.id);
          added++;
        } else dup++;
      }
    }
    addLog(`${fmtD(s.d)} ${s.cat}（${s.area}）輸入 ${added} 人`);
    schedule();
    toast(`${fmtD(s.d)} ${s.area} 已加入 ${added} 人${created ? `（新建立 ${created} 位）` : ''}${dup ? `，${dup} 位重複略過` : ''}`);
  }

  function suggestRitualForGroup(gk) {
    const gm = GROUP_META_BY_ID[gk];
    if (!gm) return;
    snapshotUndo('帶入 115 禮節經驗名單');
    const cands = M.people.filter(p => p.a === gm.area && !p.off && p.li && !isHeadCook(p));
    // 若同一區分 1 隊、2 隊，依 index 交錯均分確保兩隊都有禮節小組長與經驗者
    const isOne = gk.endsWith('1');
    const isTwo = gk.endsWith('2');
    cands.sort((a, b) => (/禮節小組長/.test(b.lead || '') - /禮節小組長/.test(a.lead || '')) || b.n115 - a.n115);
    const chosen = (isOne || isTwo)
      ? cands.filter((_, idx) => (isOne ? idx % 2 === 0 : idx % 2 === 1))
      : cands;
    st.groups[gk] = chosen.slice(0, gm.need).map(p => p.id);
    addLog(`依 115 禮節經驗帶入 ${gm.name}（${st.groups[gk].length} 人）`);
    schedule();
    toast(`${gm.name} 已帶入 ${st.groups[gk].length} 位具禮節經驗人員`);
  }

  /* ---------- 匯出功能 ---------- */
  function csv(rows) {
    return '\ufeff' + rows.map(r => r.map(v => {
      v = String(v == null ? '' : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')).join('\r\n');
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function doExport(k) {
    const stamp = new Date().toISOString().slice(0, 10);
    if (k === 'sched') {
      const rows = [['日期', '結束日', '星期', '平日', '活動', '類別', '區', '組別', '地點', '需要人數', '已排人數', '人員', '違規', '注意', '備註']];
      for (const s of M.slots) {
        const A = M.asg[s.id], c = cnt(bySlot[s.id]);
        rows.push([
          fmtD(s.d), s.e !== s.d ? fmtD(s.e) : '', WD[s.wd], s.weekday ? '平日' : '',
          (BASE.days[s.d] || {}).act || '', s.cat, s.area, grpLabel(s), s.loc,
          s.cancel ? 0 : slotNeed(M, s), A.p.length,
          A.p.map(id => M.pById[id].n).join('、'), c.v, c.n, (s.cancel ? '此日不需要；' : '') + s.note
        ]);
      }
      downloadFile(`116排班明細_${stamp}.csv`, csv(rows), 'text/csv;charset=utf-8');
    } else if (k === 'groups') {
      const rows = [['組別代號', '類別', '區', '組別名稱', '建議人數', '目前人數', '成員姓名（含原屬區）']];
      for (const gm of BASE.groupsMeta) {
        const pids = (st.groups[gm.id] || []).filter(id => M.pById[id]);
        const names = pids.map(id => {
          const p = M.pById[id];
          return p.a === gm.area ? p.n : `${p.n}(${p.a})`;
        });
        rows.push([gm.id, gm.cat, gm.area, gm.name, gm.need, pids.length, names.join('、')]);
      }
      downloadFile(`116各區組別名單_${stamp}.csv`, csv(rows), 'text/csv;charset=utf-8');
    } else if (k === 'people') {
      const rows = [['名冊序', '區', '姓名', '性別', '年紀', '組別', '廚務角色', '帶隊角色', '116次數', '平日天數', '違規', '注意', '工作狀態', '暫停', '115次數', '排班日期']];
      for (const p of M.people) {
        const L = M.personSlots[p.id] || [];
        let wd = 0; const seen = new Set();
        for (const s of L) for (let x = s.ds; x <= s.de; x++) { const kk = ds(x), w = wdOf(kk); if (w >= 1 && w <= 5 && !M.holidays.has(kk) && !seen.has(x)) { seen.add(x); wd++; } }
        const c = cnt(byPerson[p.id]);
        const gNames = (M.personGroups[p.id] || []).map(gk => GROUP_META_BY_ID[gk]?.name || gk).join('、');
        rows.push([p.id, p.a, p.n, p.sx || '', p.age || '', gNames, p.cr, p.lead, occasions(L).length, wd, c.v, c.n, p.work, p.off ? '是' : '', p.n115, L.map(s => fmtD(s.d) + s.cat).join('、')]);
      }
      downloadFile(`116人員統計_${stamp}.csv`, csv(rows), 'text/csv;charset=utf-8');
    } else if (k === 'issues') {
      const rows = [['等級', '規則', '規則名稱', '層級', '日期', '區', '人員', '說明', '處理狀態', '處理說明']];
      for (const c of ISS) rows.push([c.lvl, c.rule, ruleName(c.rule), c.scope, c.date ? fmtD(c.date) : '', c.area || '', c.pid ? M.pById[c.pid].n : '', c.msg, c.ack ? c.ack.st : '未處理', c.ack ? c.ack.note : '']);
      downloadFile(`116衝突清單_${stamp}.csv`, csv(rows), 'text/csv;charset=utf-8');
    } else if (k === 'json') {
      downloadFile(`116排班台備份_${stamp}.json`, JSON.stringify(st, null, 2), 'application/json');
    }
    toast('已開始下載檔案');
  }

  /* ---------- 事件監聽 ---------- */
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const a = t.dataset.act, id = t.dataset.id;

    if (a === 'toggleTheme') {
      st.theme = st.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      persist();
      render();
      toast(st.theme === 'dark' ? '已切換為深色模式' : '已切換為淺色模式');
      return;
    }
    if (a === 'toggleLarge') {
      st.largeMode = !st.largeMode;
      if (st.largeMode && F.schedMode === 'matrix') {
        F.schedMode = 'list';
        saveF();
      }
      applyLargeMode();
      persist();
      render();
      toast(st.largeMode ? '已切換為「大字簡化版」' : '已切換回「標準版」');
      return;
    }
    if (a === 'close') { drawer = null; render(); return; }
    if (a === 'closeModal') { modal = null; render(); return; }
    if (a === 'openSlot') { e.preventDefault(); drawer = { type: 'slot', id }; F.cq = ''; render(); return; }
    if (a === 'openPerson') { e.preventDefault(); drawer = { type: 'person', id: +id }; render(); return; }
    if (a === 'openAuto') { modal = 'auto'; render(); return; }
    if (a === 'addSlot') { modal = 'addSlot'; render(); return; }
    if (a === 'openAddPersonModal') { modal = 'addPerson'; render(); return; }
    if (a === 'goIssues') { F.ilvl = '違規'; F.issTab = 'rules'; saveF(); location.hash = 'issues'; return; }
    if (a === 'goIssuesAll') { F.ilvl = ''; F.issTab = 'rules'; saveF(); location.hash = 'issues'; return; }
    if (a === 'goWorkArea') { F.area = t.dataset.a; saveF(); location.hash = 'area'; return; }

    if (a === 'selWorkArea') { F.area = t.dataset.a; openPickerGroupId = null; openCandidateSlotId = null; saveF(); render(); return; }
    if (a === 'selAreaTab') { F.areaTab = t.dataset.t; saveF(); render(); return; }
    if (a === 'selIssTab') { F.issTab = t.dataset.t; saveF(); render(); return; }
    if (a === 'setSchedMode') { F.schedMode = t.dataset.m; saveF(); render(); return; }
    if (a === 'togglePicker') { openPickerGroupId = openPickerGroupId === t.dataset.g ? null : t.dataset.g; render(); return; }
    if (a === 'toggleCand') { openCandidateSlotId = openCandidateSlotId === id ? null : id; render(); return; }

    if (a === 'groupAddNames') {
      const gk = t.dataset.g, area = t.dataset.a;
      const inp = document.getElementById('ga_' + gk);
      if (inp) { addNamesToGroup(gk, area, inp.value); }
      return;
    }
    if (a === 'groupRm') {
      const gk = t.dataset.g, pid = +t.dataset.p;
      snapshotUndo('移出組員');
      st.groups[gk] = (st.groups[gk] || []).filter(x => x !== pid);
      addLog(`${GROUP_META_BY_ID[gk]?.name || gk} 移出 ${M.pById[pid]?.n}`);
      schedule();
      return;
    }
    if (a === 'clearGroup') {
      const gk = t.dataset.g;
      snapshotUndo('清空組別');
      st.groups[gk] = [];
      addLog(`清空 ${GROUP_META_BY_ID[gk]?.name || gk}`);
      schedule();
      return;
    }
    if (a === 'resetGroup') {
      const gk = t.dataset.g;
      snapshotUndo('還原 115 組別');
      st.groups[gk] = (BASE.defaultGroups[gk] || []).slice();
      addLog(`還原 ${GROUP_META_BY_ID[gk]?.name || gk} 為 115 名單`);
      schedule();
      toast('已還原 115 名單');
      return;
    }
    if (a === 'suggestRitual') {
      suggestRitualForGroup(t.dataset.g);
      return;
    }
    if (a === 'autoSplitRitualArea') {
      const area = t.dataset.a;
      suggestRitualForGroup('lj_' + area + '1');
      suggestRitualForGroup('lj_' + area + '2');
      return;
    }

    if (a === 'slotAddNames') {
      const inp = document.getElementById('sa_' + id);
      if (inp) addNamesToSlot(id, inp.value);
      return;
    }
    if (a === 'slotDrawerAddNames') {
      const inp = document.getElementById('sd_add_' + id);
      if (inp) addNamesToSlot(id, inp.value);
      return;
    }

    if (a === 'batchAddAreaPeople') {
      const area = t.dataset.a;
      const inp = $('#batchPeopleInput');
      if (!inp) return;
      const tokens = splitList(inp.value);
      if (!tokens.length) { toast('請輸入至少一位姓名'); return; }
      snapshotUndo('依區批次新增人員');
      let created = 0, existed = 0;
      for (const tk of tokens) {
        const res = findOrCreatePersonByName(tk, area);
        if (res.created) { created++; recompute(); }
        else existed++;
      }
      inp.value = '';
      addLog(`${area} 批次新增 ${created} 人`);
      schedule();
      toast(`已新增 ${created} 位至 ${area} 名冊${existed ? `（${existed} 位已存在）` : ''}`);
      return;
    }

    if (a === 'createPerson') {
      const nm = ($('#npName')?.value || '').trim();
      if (!nm) { toast('請輸入姓名'); return; }
      const area = $('#npArea').value;
      const newP = {
        id: nextPersonId(),
        n: nm,
        a: area,
        sx: $('#npSx').value || null,
        age: $('#npAge').value ? +$('#npAge').value : null,
        src: 'M',
        lead: $('#npLead').value.trim(),
        cg: [],
        cr: $('#npCr').value,
        sg: '',
        li: $('#npLi').checked ? '手動標記' : '',
        zr: '',
        tr: $('#npTr').checked ? '支援' : '',
        n115: 0, wd115: 0, cls: '', note: '手動依區新增'
      };
      st.addedPeople.push(newP);
      modal = null;
      addLog(`新增人員：${nm}（${area}）`);
      schedule();
      toast(`已建立 ${nm}（${area}）`);
      return;
    }

    if (a === 'add' || a === 'rm' || a === 'lock') {
      const s = M.byId[id], pid = +t.dataset.p;
      if (!s) return;
      if (s.groupKey) {
        const mod = (st.slotMod[id] = st.slotMod[id] || { include: [], exclude: [], lk: [] });
        const inBase = (st.groups[s.groupKey] || []).includes(pid);
        if (a === 'add') {
          mod.exclude = (mod.exclude || []).filter(x => x !== pid);
          if (!inBase && !(mod.include || []).includes(pid)) (mod.include = mod.include || []).push(pid);
        } else if (a === 'rm') {
          if (inBase) { if (!(mod.exclude || []).includes(pid)) (mod.exclude = mod.exclude || []).push(pid); }
          else mod.include = (mod.include || []).filter(x => x !== pid);
        }
      } else {
        const curA = st.assign[id] || { p: [], lk: [] };
        let p = curA.p.slice(), lk = curA.lk.slice();
        if (a === 'add' && !p.includes(pid)) p.push(pid);
        if (a === 'rm') { p = p.filter(x => x !== pid); lk = lk.filter(x => x !== pid); }
        if (a === 'lock') lk = lk.includes(pid) ? lk.filter(x => x !== pid) : lk.concat([pid]);
        st.assign[id] = { p, lk };
      }
      if (a !== 'lock') addLog(`${fmtD(s.d)} ${s.cat}（${s.area}）${a === 'add' ? '加入' : '移除'} ${M.pById[pid]?.n}`);
      schedule();
      return;
    }

    if (a === 'autoOne' || a === 'clearOne') {
      const s = M.byId[id];
      if (!s) return;
      snapshotUndo(a === 'autoOne' ? '單場自動補滿' : '清除本場人員');
      if (a === 'clearOne') {
        if (s.groupKey) {
          st.slotMod[id] = { include: [], exclude: (st.groups[s.groupKey] || []).slice(), lk: [] };
        } else {
          const lk = (st.assign[id]?.lk || []).slice();
          st.assign[id] = { p: lk.slice(), lk };
        }
      } else {
        const M2 = buildModel();
        const s2 = M2.byId[id];
        const added = autoSchedule(M2, x => x.id === id, 'fill_one');
        if (s.groupKey) {
          const base = st.groups[s.groupKey] || [];
          const mod = (st.slotMod[id] = st.slotMod[id] || { include: [], exclude: [], lk: [] });
          for (const pid of M2.asg[id].p) {
            if (!base.includes(pid) && !mod.include.includes(pid)) mod.include.push(pid);
          }
        } else {
          st.assign[id] = { p: M2.asg[id].p.slice(), lk: M2.asg[id].lk.slice() };
        }
        toast(`已補滿 ${added} 人`);
      }
      schedule();
      return;
    }

    if (a === 'autoAreaUngrouped') {
      const area = t.dataset.a;
      snapshotUndo(`${area} 無組別自動補滿`);
      const M2 = buildModel();
      const added = autoSchedule(M2, s => !s.groupKey && s.area === area, 'fill');
      for (const s of M2.slots) {
        if (!s.groupKey && s.area === area) {
          st.assign[s.id] = { p: M2.asg[s.id].p.slice(), lk: M2.asg[s.id].lk.slice() };
        }
      }
      addLog(`${area} 無組別勤務自動補滿 ${added} 人次`);
      schedule();
      toast(`${area} 無組別勤務已補入 ${added} 人次`);
      return;
    }

    if (a === 'autoUngroupedFiltered') {
      snapshotUndo('無組別依篩選自動補滿');
      const M2 = buildModel();
      const flt = s => {
        if (s.groupKey) return false;
        if (F.ugCat === '忠恕' && !s.cat.startsWith('忠恕')) return false;
        else if (F.ugCat && F.ugCat !== '忠恕' && s.cat !== F.ugCat) return false;
        if (F.ugWave && waveOfSlot(s) !== F.ugWave) return false;
        if (F.ugArea && s.area !== F.ugArea) return false;
        return true;
      };
      const added = autoSchedule(M2, flt, 'fill');
      for (const s of M2.slots) if (flt(s)) st.assign[s.id] = { p: M2.asg[s.id].p.slice(), lk: M2.asg[s.id].lk.slice() };
      addLog(`無組別篩選自動補滿 ${added} 人次`);
      schedule();
      toast(`已自動補入 ${added} 人次`);
      return;
    }

    if (a === 'runAuto') {
      const scope = $('#auScope').value, area = $('#auArea').value, mode = $('#auMode').value;
      snapshotUndo('自動排人');
      const M2 = buildModel();
      const flt = s => (scope === 'all' || s.d.slice(0, 7) === scope) && (!area || s.area === area);
      const n = autoSchedule(M2, flt, mode);
      for (const s of M2.slots) {
        if (flt(s) && !s.groupKey) st.assign[s.id] = { p: M2.asg[s.id].p.slice(), lk: M2.asg[s.id].lk.slice() };
      }
      modal = null;
      addLog(`自動排人（${scope === 'all' ? '全年' : scope}${area ? '·' + area : ''}）補入 ${n} 人次`);
      schedule();
      toast(`已排入 ${n} 人次`);
      return;
    }

    if (a === 'undo' && undoStack) {
      st.groups = undoStack.groups;
      st.slotMod = undoStack.slotMod;
      st.assign = undoStack.assign;
      st.addedPeople = undoStack.addedPeople;
      const lbl = undoStack.label;
      undoStack = null;
      addLog('復原：' + lbl);
      schedule();
      toast('已復原：' + lbl);
      return;
    }

    if (a === 'setArea') {
      const s = M.byId[id], newArea = t.dataset.a;
      const newGrp = defaultGroupForAreaCat(newArea, s.cat);
      st.edits[id] = Object.assign({}, st.edits[id] || {}, { area: newArea, grp: newGrp || '' });
      addLog(`${fmtD(s.d)} ${s.cat} 改派：${s.area} → ${newArea}`);
      schedule();
      toast(`已改派為 ${newArea}`);
      return;
    }

    if (a === 'saveSlot') {
      const s = M.byId[id];
      const ed = Object.assign({}, st.edits[id] || {}, {
        grp: $('#edGrp').value.trim(),
        need: $('#edNeed').value,
        loc: $('#edLoc').value,
        note: $('#edNote').value.trim(),
        cancel: $('#edCancel').checked
      });
      if (s.extra) st.extra[id] = Object.assign({}, st.extra[id], { grp: ed.grp, need: +ed.need, loc: ed.loc });
      st.edits[id] = ed;
      addLog(`${fmtD(s.d)} ${s.cat} 更新設定`);
      schedule();
      toast('已儲存勤務格設定');
      return;
    }

    if (a === 'delSlot') {
      delete st.extra[id]; delete st.edits[id]; delete st.assign[id]; delete st.slotMod[id];
      drawer = null;
      addLog('刪除新增勤務 ' + id);
      schedule();
      return;
    }

    if (a === 'createSlot') {
      const d = $('#nsD').value, e2 = $('#nsE').value || d;
      if (!d) { toast('請選擇日期'); return; }
      const nid = 'X' + Date.now().toString(36);
      const s = {
        id: nid, d, e: e2 < d ? d : e2,
        cat: $('#nsCat').value, area: $('#nsArea').value,
        share: 1, need: +$('#nsNeed').value || 0, src: '新增',
        grp: $('#nsGrp').value.trim(), loc: $('#nsLoc').value, extra: true, label: '手動新增勤務'
      };
      st.extra[nid] = s;
      modal = null;
      drawer = { type: 'slot', id: nid };
      addLog(`新增勤務：${fmtD(d)} ${s.cat} ${s.area}`);
      schedule();
      return;
    }

    if (a === 'savePerson') {
      const pid = +id;
      const baseP = BASE.people.find(x => x.id === pid);
      const pe = {
        n: $('#peName').value.trim() || M.pById[pid].n,
        a: $('#peArea').value,
        sx: $('#peSx').value || null,
        age: $('#peAge').value ? +$('#peAge').value : null,
        cr: $('#peCr').value,
        lead: $('#peLead').value.trim(),
        li: $('#peLi').value.trim(),
        tr: $('#peTr').value.trim()
      };
      if (baseP) st.peopleEdits[pid] = Object.assign({}, st.peopleEdits[pid] || {}, pe);
      else {
        const ap = st.addedPeople.find(x => x.id === pid);
        if (ap) Object.assign(ap, pe);
      }
      const months = [...document.querySelectorAll('[data-month]')].filter(x => x.checked).map(x => +x.dataset.month);
      st.pov[pid] = {
        work: $('#pvWork').value,
        cap: $('#pvCap').value,
        off: $('#pvOff').checked,
        months,
        unav: $('#pvUnav').value.trim(),
        note: $('#pvNote').value.trim()
      };
      addLog(`更新 ${pe.n} 的資料與排班條件`);
      schedule();
      toast('已儲存人員資料');
      return;
    }

    if (a === 'sev') { st.rules.sev[t.dataset.rule] = t.dataset.v; schedule(); return; }
    if (a === 'resetRules') { st.rules = defaultRules(); schedule(); toast('已還原預設規則'); return; }
    if (a === 'export') { doExport(t.dataset.k); return; }
    if (a === 'resetAll') {
      if (!confirm('確定要清除所有本機編輯與排班並還原為初始狀態嗎？')) return;
      st = freshState();
      applyTheme();
      applyLargeMode();
      schedule();
      toast('已重設為初始資料');
      return;
    }
  });

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.act === 'groupToggle') {
      const gk = t.dataset.g, pid = +t.dataset.p;
      const list = (st.groups[gk] = st.groups[gk] || []);
      if (t.checked && !list.includes(pid)) list.push(pid);
      else if (!t.checked) st.groups[gk] = list.filter(x => x !== pid);
      schedule();
      return;
    }
    const map = {
      fMonth: 'month', fArea: 'areaF', fCat: 'cat', fOnly: 'only',
      ugCat: 'ugCat', ugWave: 'ugWave', ugArea: 'ugArea', ugSt: 'ugSt',
      iLvl: 'ilvl', iScope: 'iscope', iRule: 'irule', iArea: 'iarea', iSt: 'ist',
      pSort: 'psort'
    };
    if (map[t.id]) { F[map[t.id]] = t.value; saveF(); render(); return; }
    if (t.id === 'cAll') { F.call = t.checked; render(); return; }
    if (t.dataset.param) {
      const k = t.dataset.param;
      st.rules.p[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? 0 : +t.value) : t.value;
      schedule();
      return;
    }
    if (t.dataset.mx) {
      const [a, b] = t.dataset.mx.split('|');
      st.rules.mx[a + '|' + b] = t.value;
      st.rules.mx[b + '|' + a] = t.value;
      schedule();
      return;
    }
    if (t.dataset.ack !== undefined || t.dataset.acknote !== undefined) {
      const key = t.dataset.ack || t.dataset.acknote;
      const cur = Object.assign({ st: '未處理', note: '' }, st.acks[key] || {});
      if (t.dataset.ack) cur.st = t.value; else cur.note = t.value.trim();
      cur.t = Date.now();
      const c = ISS.find(x => x.key === key);
      if (c) { cur.msg = c.msg; cur.rule = c.rule; }
      if (cur.st === '未處理' && !cur.note) delete st.acks[key]; else st.acks[key] = cur;
      schedule();
      return;
    }
    if (t.dataset.discSt || t.dataset.discTx) {
      const did = t.dataset.discSt || t.dataset.discTx;
      const cur = Object.assign({ status: '未討論', text: '' }, st.decisions[did] || {});
      if (t.dataset.discSt) cur.status = t.value; else cur.text = t.value;
      cur.at = Date.now();
      st.decisions[did] = cur;
      persist();
      toast(`已儲存 ${did} 討論紀錄`);
      return;
    }
    if (t.id === 'importJson' && t.files && t.files[0]) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          st = Object.assign(freshState(), parsed);
          st.rules = mergeRules(parsed.rules);
          st.groups = Object.assign(cloneDefaultGroups(), parsed.groups || {});
          applyTheme();
          applyLargeMode();
          schedule();
          toast('已成功匯入備份檔');
        } catch (err) {
          toast('JSON 備份格式無效');
        }
      };
      reader.readAsText(t.files[0], 'utf-8');
      return;
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (modal) modal = null;
      else drawer = null;
      render();
      return;
    }
    if (e.key === 'Enter' && e.target.dataset.groupInput) {
      e.preventDefault();
      const gk = e.target.dataset.groupInput;
      const gm = GROUP_META_BY_ID[gk];
      if (gm) addNamesToGroup(gk, gm.area, e.target.value);
      return;
    }
    if (e.key === 'Enter' && e.target.dataset.slotInput) {
      e.preventDefault();
      addNamesToSlot(e.target.dataset.slotInput, e.target.value);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.slot[data-act]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  let qT = 0;
  document.addEventListener('input', e => {
    const t = e.target;
    const map = { fQ: 'q', pQ: 'pq', cQ: 'cq' };
    if (!map[t.id]) return;
    F[map[t.id]] = t.value;
    clearTimeout(qT);
    qT = setTimeout(() => {
      const pos = t.selectionStart, idd = t.id;
      render();
      const n = document.getElementById(idd);
      if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) { } }
    }, 220);
  });

  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (VIEWS.includes(v)) { view = v; drawer = null; render(); window.scrollTo(0, 0); }
  });

  /* ---------- PWA 註冊與安裝 ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { });
    });
  }
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = $('#btnInstall');
    if (btn) {
      btn.hidden = false;
      btn.onclick = async () => {
        btn.hidden = true;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
      };
    }
  });

  recompute();
  render();
})();
