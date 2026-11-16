/* 天達堂排班引擎：由 tdSchedule/app.js 第 5–795 行抽出（規則、模型、候選評分），邏輯未改。
 * 用法：const E = TDEngine(BASE_DATA); E.setState(st); const M = E.buildModel(); E.allIssues(M);
 */
window.TDEngine = function (BASE) {
  'use strict';
  let st = null;
  const AREAS = ['瑞芳', '內湖', '松山', '三重', '基隆', '新莊'];
  const ALL_WORK_AREAS = ['瑞芳', '內湖', '松山', '三重', '基隆', '新莊', '青年班', '新民班', '機動', '交通隊'];
  const PERSON_AREAS = ['瑞芳', '內湖', '松山', '三重', '基隆', '新莊', '青年班', '新民班', '天達', '金門'];
  const SPECIAL_AREAS = ['機動', '交通隊', '青年班', '新民班'];
  const CATS = ['廚務', '會館輪廚', '環境整理', '服務', '禮節', '洗碗', '忠恕平日', '忠恕週六', '忠恕週日', '大典前晚', '協辦', '交通'];
  const JOB_CLASSES = ['主廚', '大廚', '二廚', '服務', '禮節', '忠恕', '交通', '其他'];
  const SEVS = ['違規', '注意', '關閉'];
  const ACK_ST = ['未處理', '協調中', '已協調', '接受例外'];
  const WD = '日一二三四五六';
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
        ed.loc ? { loc: ed.loc } : {},
        ed.d ? { d: ed.d } : {},
        ed.e ? { e: ed.e } : (ed.d && !b.e ? { e: ed.d } : {}),
        ed.lock !== undefined ? { lock: !!ed.lock } : {}
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

  st = freshState();
  return {
    setState(s) { st = s; }, getState() { return st; },
    AREAS, ALL_WORK_AREAS, PERSON_AREAS, SPECIAL_AREAS, CATS, JOB_CLASSES, WD, RULE_META, GROUP_META_BY_ID,
    dn, ds, wdOf, fmtD, splitList, defaultRules, cloneDefaultGroups, freshState, mergeRules,
    resolveSlotGroupKey, defaultGroupForAreaCat, groupOptionsForSlot, buildModel,
    isCookSlot, isCookPerson, isHeadCook, jobClass, canLead, needsLead, slotNeed, capOf, occasions,
    personIssues, areaIssues, slotIssues, issueKey, allIssues,
    evalCandidate, poolFor, rankCandidates, assignToModel, autoSchedule
  };
};
if (typeof module !== 'undefined') module.exports = window.TDEngine;
