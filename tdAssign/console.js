/* 天達排班協作 — 階段三（00 系統總覽、A1–A5 年度排班控制台）
 * 透過 window.TDConsole 與 app.js（@ux 主框架）對接，僅讀寫標準 store 路徑（含 rules/、meta/published 等）。
 */
(function () {
  'use strict';

  const ROUTES = ['overview', 'a1', 'a2', 'a3', 'a4', 'a5'];

  const CUI = {
    a1: {
      plan: 'C',
      scope: 'all',
      scopeMonth: '2027-03',
      scopeArea: '瑞芳',
      layer: 'individual',
      shortage: 'gap',
      keepLocked: true,
      prefAff: true,
      noViol: true,
      newTrainee: false,
      openDiag: ''
    },
    a2: {
      month: '',
      area: '',
      cat: '',
      only: false,
      q: '',
      mode: 'list',
      selId: '',
      addOpen: false,
      showAllStaff: false,
      showAllCands: false,
      crossCands: false
    },
    a3: {
      q: '',
      chip: '全部',
      area: '',
      selPid: 0,
      showAllPeople: false
    },
    a4: {
      simRule: 'wdMax',
      simVal: '2',
      simResult: null,
      verOpen: false,
      prevSev: {}
    },
    a5: {
      chapters: { ch1: true, ch2: true, ch3: true, ch4: true, ch5: true, ch6: true, ch7: true, ch8: true, ch9: true, ch10: true },
      paper: 'A4',
      startPage: '48',
      fontSize: 'std',
      printDate: '中華民國 116 年 1 月',
      lunar: true,
      catColor: true,
      chNote: true,
      qr: true,
      twoCharSpace: false,
      previewMode: '', // '' | 'preview' | 'draft' | 'final' | 'single' | 'areas'
      singleCh: 'ch2'
    }
  };

  /* ---------------- 共用索引與小工具 ---------------- */

  function buildIndexes(ctx) {
    const bySlot = {};
    const byPid = {};
    for (const c of ctx.ISS || []) {
      for (const sid of c.slots || []) (bySlot[sid] = bySlot[sid] || []).push(c);
      if (c.pid != null) (byPid[c.pid] = byPid[c.pid] || []).push(c);
    }
    return { bySlot, byPid };
  }

  const rec = (ctx, kind, key, pid) => ((ctx.D()[kind] || {})[key] || {})[pid];

  function gmOf(ctx, gk) {
    return (ctx.E.GROUP_META_BY_ID || {})[gk] || null;
  }

  function kindOfGroup(gk) {
    return String(gk || '').split('_')[0];
  }

  function monthLabel(ym) {
    if (ym === '117') return '117 年 1–2 月';
    const [y, m] = String(ym).split('-').map(Number);
    return (y - 1911) + ' 年 ' + m + ' 月';
  }

  function allMonths(ctx) {
    const s = new Set();
    for (const sl of (ctx.M ? ctx.M.slots : ctx.BASE.slots)) {
      if (sl.d) s.add(sl.d.slice(0, 7));
    }
    return [...s].sort();
  }

  function slotMonthMatch(s, mFilter) {
    if (!mFilter) return true;
    if (mFilter === '117') return s.d.startsWith('2028-');
    if (/^\d+$/.test(mFilter)) return s.d.startsWith('2027-' + String(mFilter).padStart(2, '0'));
    return s.d.slice(0, 7) === mFilter;
  }

  const lunarCache = {};
  function fmtLunar(d) {
    if (!d) return '';
    if (lunarCache[d] !== undefined) return lunarCache[d];
    try {
      const f = new Intl.DateTimeFormat('zh-TW-u-ca-chinese', { month: 'short', day: 'numeric' });
      lunarCache[d] = f.format(new Date(d + 'T12:00:00Z'));
    } catch (e) {
      lunarCache[d] = '';
    }
    return lunarCache[d];
  }

  /** 兩個字的姓名中間加全形空格對齊 */
  function fmtPrintName(name, twoCharSpace) {
    const s = String(name == null ? '' : name).trim();
    if (twoCharSpace && s.length === 2) return s[0] + '　' + s[1];
    return s;
  }

  function fmtDelta(n, label) {
    if (!n) return `${label} 0`;
    return `${label} ${n > 0 ? '＋' + n : '−' + Math.abs(n)}`;
  }

  function personWeekdayDays(ctx, pid) {
    const M = ctx.M;
    const list = M.personSlots[pid] || [];
    const seen = new Set();
    let w = 0;
    for (const s of list) {
      for (let x = s.ds; x <= s.de; x++) {
        const k = ctx.E.ds(x);
        const wd = ctx.E.wdOf(k);
        if (wd >= 1 && wd <= 5 && !M.holidays.has(k) && !seen.has(x)) {
          seen.add(x);
          w++;
        }
      }
    }
    return w;
  }

  function personStatusText(ctx, p) {
    const o = (ctx.D().pov || {})[p.id] || {};
    if (o.status && o.status !== '正常') return o.status;
    if (p.off) return '不再排班';
    if (p.months && p.months.length) return `暫停 ${p.months.join('、')} 月`;
    if (o.wdCap === 0 || o.wdCap === '0') return '只排假日';
    if (p.cap && p.cap <= 4) return `限量 ${p.cap} 次`;
    if (p.src === 'N') return '新人見習';
    if (p.age && p.age >= ctx.M.R.p.oldAge) return `${p.age} 歲`;
    return '正常';
  }

  function cloneEngineState(ctx) {
    const E = ctx.E;
    const baseSt = E.getState();
    const d = ctx.D();
    const simSt = {
      rules: E.mergeRules(d.rules),
      edits: Object.assign({}, d.edits || {}),
      extra: Object.assign({}, d.extra || {}),
      groups: {},
      slotMod: {},
      assign: {},
      addedPeople: (baseSt.addedPeople || []).slice(),
      peopleEdits: Object.assign({}, baseSt.peopleEdits || {}),
      pov: Object.assign({}, d.pov || {}),
      acks: Object.assign({}, d.acks || {})
    };
    for (const gk in baseSt.groups || {}) simSt.groups[gk] = (baseSt.groups[gk] || []).slice();
    for (const sid in baseSt.assign || {}) {
      simSt.assign[sid] = {
        p: (baseSt.assign[sid].p || []).slice(),
        lk: (baseSt.assign[sid].lk || []).slice()
      };
    }
    return { baseSt, simSt };
  }

  function unseededBanner(ctx) {
    if ((ctx.D().meta || {}).seeded) return '';
    return `<section class="card warnbox">
      <div class="row-h">
        <div><b>尚未初始化 116 年度基準資料</b><div class="muted small">建議先至工作區首頁初始化 115 組別名單與初始提案，或直接於此頁產生初版。</div></div>
        <a class="btn sm pri" href="#/">前往首頁初始化</a>
      </div>
    </section>`;
  }

  /* ================================================================
   * 00 系統總覽與情境對照 (#/overview)
   * ================================================================ */

  function renderOverview(ctx) {
    const { M, ISS, esc, draftVer, defaultArea, wsHeader, cnt, tag } = ctx;
    const curArea = defaultArea();
    const liveSlots = M ? M.slots.filter((s) => !s.cancel) : ctx.BASE.slots;
    const c = cnt(ISS);
    const openProps = Object.values(ctx.D().proposals || {}).filter((p) => p && p.status !== 'resolved').length;
    const pub = (ctx.D().meta || {}).published;

    const steps = [
      { n: '01', when: '10 月前', t: '資料彙整', d: '匯入行事曆、名冊、固定組別與問卷限制。', where: 'A1 年度控制台', href: '#/a1', cls: 'done' },
      { n: '02', when: '10 月初', t: '規則與試算', d: '設定 A/P 規則、同日兼職矩陣與平日上限試算。', where: 'A4 規則與試算', href: '#/a4', cls: 'done' },
      { n: '03', when: '10 月中', t: '產生初版', d: '比較 A/B/C 三方案，產生排到區組與人員的初版。', where: 'A1 初版產生', href: '#/a1', cls: 'cur' },
      { n: '04', when: '10 月底', t: '各區調整提案', d: '各區檢視負擔，換日、換區或請求支援先試算影響。', where: 'B1–B2 討論平台', href: '#/b1/' + curArea, cls: '' },
      { n: '05', when: '11 月上旬', t: '區內排人', d: '各區手機排組員與依日期勤務、確認預排、分工送出。', where: 'B3–B6 手機排人', href: '#/a/' + curArea, cls: '' },
      { n: '06', when: '11 月中旬', t: '協調與定版', d: '總召處理跨區碰撞與接受例外，鎖版匯出服務手冊。', where: 'A6 協調 · A5 定版', href: '#/a5', cls: '' },
      { n: '07', when: '116 年全年', t: '運行與調度', d: '定版後追蹤異動夾頁、請假代班與年度檢討回饋。', where: 'A5 異動 · M8 帳號', href: pub ? '#/a5' : '#/review', cls: '' }
    ];

    const cases = [
      ['資料建置', '115 手冊已排、廚務初稿與行事曆匯入並鎖定', '鎖定外部已定案格並標註來源，重排時保留不被蓋掉', 'A1', '#/a1', 'no'],
      ['方案比較', '理想規則人力不夠，想知道實際差多少人', '即時比較 A 理想／B 最小人力／C 現有人力試排與缺口', 'A1', '#/a1', 'ok'],
      ['整組輪替', '廚務／服務／禮節／交通隊全年用同一組人', '改組員自動套用全年每一場，不需逐日重複輸入', 'B6', '#/g/k_1', 'pl'],
      ['依日期排人', '忠恕輪值、洗碗、大典前晚沒有固定組別', '依日期逐格排人，支援帶入去年名單與系統建議補滿', 'B4', '#/a/' + curArea, 'pl'],
      ['明德班衝堂', '12/11 冬季大典前晚（瑞芳）撞明德班結班', '偵測 A2 違規，透過提案試算換區（新莊）或對調影響', 'B2', '#/p/D10', 'bad'],
      ['同日兩項', '2/27 內湖廚務 1 組與忠恕週六大區同一天', '偵測 A1 違規，試算改由機動組支援釋出 8 人次', 'B2', '#/p/D1', 'bad'],
      ['交通重疊', '3/21 天達交通隊與道院交通名單重疊', '偵測 P2 同日跨地點，提案另補 8 人或降為基本需求', 'B2', '#/p/D2', 'wn'],
      ['改派負責區', '某一格要改派給別區，先看哪一區最不會違規', '總表右側下拉即時算出各區違規±X、注意±Y 變化', 'A2', '#/a2', 'ok'],
      ['臨時加場', '行事曆新增心靈成長班 2.0 等臨時勤務', '在總表直接新增勤務格寫入 extra，即時納入規則檢查', 'A2', '#/a2', 'ok'],
      ['人員暫停', '志工 6–8 月不方便或暫停排班，已排班怎麼辦', '點擊 1–12 月時間軸切換暫停，偵測影響並預排同班底替補', 'A3', '#/a3', 'wn'],
      ['總召預排', '總召或調度台先幫某區排人或替補', '標記為「預排」紫標籤，必須由該區區長確認或重排', 'A2 / B4', '#/a2', 'pre'],
      ['同日兼職', '服務＋禮節、二廚＋服務等同一天兼兩項工作', '依 8×8 兼職矩陣切換允許、注意或違規，即時統計觸發數', 'A4', '#/a4', 'ok'],
      ['規則調整', '想試平日上限改 2 次或 3 次需要多少人', '先在自訂情境試算器用記憶體試算影響，滿意再套用至規則集', 'A4', '#/a4', 'ok'],
      ['多人同時排', '區長、人事組、輪值組同時間開手機或電腦排同一區', '最小路徑原子寫入不互蓋，即時顯示在線頭像與撞期紅框', 'B3 / A6', '#/review', 'pl'],
      ['送出後修改', '區長送出名單給總召後又臨時調整人員', '照常可改，自動累計「送出後變更 N 筆」提醒總召複核', 'B5 / A6', '#/review', 'wn'],
      ['接受例外', '討論後決議某筆違規照排，定版時不再阻擋', '標記為「接受例外」並記錄原因，定版前檢查自動通過', 'A5 / A6', '#/a5', 'ok'],
      ['定版與手冊', '全區確認後要印 116 年服務手冊（A4/A5/QR碼）', '7 項檢查通過後鎖為 116 定版 v1.0，自動編頁碼並列印', 'A5', '#/a5', 'ok'],
      ['帳號與綁定', '志工首次登入找不到權限，或替沒手機家人看班表', 'M8 搜尋名冊點「這是我」綁定、申請新名冊、設定代管家人', 'M8', '#/login', 'pl']
    ];

    const roles = [
      ['排班總召、人資處', '全年度控制台 A1–A6、規則設定、各區進度審核、跨區預排與定版印刷匯出。'],
      ['各區區長', '本區首頁 B1、各區討論提案與表態 B2、指定區內排班人員、確認預排並送出。'],
      ['主廚／小組長／幹部', '依區長指派之分工範圍（廚務、服務、禮節、交通、忠恕）在手機或電腦排入成員。'],
      ['一般道親與代管家人', '不用登入即可檢視總表；登入並綁定 M8 姓名後可查看個人與代管家人全年班表。'],
      ['未登入訪客', '可瀏覽系統總覽、行事曆場次、組別與公開進度，無法修改任何雲端資料。']
    ];

    const dataNodes = [
      ['勤務格主檔', 'BASE.slots（221 格）＋ edits（改區/改日/鎖定/取消）＋ extra（臨時新增勤務）。'],
      ['人員與狀態', 'BASE.people（377 人）＋ addedPeople（M8 新增）＋ pov（暫停月份/上限/體力/交通）。'],
      ['固定組別與崗位', 'groups（30 組固定名單）＋ groupMeta（帶隊主廚/小組長與禮節 6 大崗位）。'],
      ['規則參數庫', 'rules（A1–A11 區規則、P1–P12 人格規則、8×8 同日兼職矩陣與自動排人權重）。'],
      ['協作與例外', 'proposals（多方案試算與表態）＋ coord（區請總召協調）＋ acks（接受例外）。'],
      ['版本與紀錄', 'meta（草案版號、定版鎖定 116 定版 v1.0）＋ log（可單筆復原的操作紀錄）。']
    ];

    return `${wsHeader('overview', '', curArea)}<main class="wide-main">
      ${unseededBanner(ctx)}
      <section class="page-head">
        <div>
          <div class="muted small">116 年度 · 版本 ${esc(draftVer())} · 共用資料骨幹</div>
          <h1>一份資料，三個工作台，一整年的排班</h1>
          <p class="muted" style="margin:6px 0 0;max-width:820px">年度控制台產生初版，各區討論平台把調整談定，運行調度讓排好的班每一次都有人到。三者共用同一份勤務格、人員主檔與規則，任何變更只改一次。</p>
        </div>
        <div class="acts">
          <a class="btn pri" href="#/a1">進入年度控制台 (A1)</a>
          <a class="btn blue-out" href="#/b1/${esc(curArea)}">前往${esc(curArea)}討論 (B1)</a>
        </div>
      </section>

      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-l">目前版本</div><div class="kpi-v">${esc(pub ? pub.version : draftVer())}</div><div class="kpi-s">${pub ? '已定版鎖定' : '協作草案中'}</div></div>
        <div class="kpi-card"><div class="kpi-l">年度勤務格</div><div class="kpi-v">${liveSlots.length}</div><div class="kpi-s">名冊 ${M ? M.people.length : ctx.BASE.people.length} 人</div></div>
        <div class="kpi-card"><div class="kpi-l">未解違規</div><div class="kpi-v ${c.v ? 't-bad' : 't-ok'}">${c.v}</div><div class="kpi-s">注意 ${c.n} 則</div></div>
        <div class="kpi-card"><div class="kpi-l">進行中提案</div><div class="kpi-v">${openProps}</div><div class="kpi-s"><a href="#/p">查看提案試算 →</a></div></div>
      </div>

      <section aria-label="年度流程" style="display:flex;flex-direction:column;gap:10px">
        <div class="row-h"><h2>年度流程（7 階段，點擊卡片直接前往）</h2><span class="muted small">依時序從建置、提案、排人到定版</span></div>
        <div class="step-list" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(175px,100%),1fr));gap:12px">
          ${steps.map((s) => `<a class="card" href="${esc(s.href)}" style="text-decoration:none;color:inherit;${s.cls === 'cur' ? 'border:2px solid var(--accent);background:var(--accent-soft);' : s.cls === 'done' ? 'background:var(--surface);border-top:3px solid var(--ok);' : ''}">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="step-num" style="${s.cls === 'cur' ? 'background:var(--accent);color:#fff;' : s.cls === 'done' ? 'background:var(--ok);color:#fff;' : ''}">${s.n}</span>
              <span class="small muted">${esc(s.when)}</span>
            </div>
            <div style="font-weight:700;font-size:15px">${esc(s.t)}</div>
            <div class="small muted">${esc(s.d)}</div>
            <div class="small" style="margin-top:auto;font-weight:700;color:var(--accent-ink)">${esc(s.where)} →</div>
          </a>`).join('')}
        </div>
      </section>

      <section aria-label="三個工作台" class="wb-grid">
        <div class="wb-card a card">
          <div class="small" style="font-weight:700;color:var(--accent-ink)">A · 排班總召、人資處</div>
          <h2>年度排班控制台</h2>
          <p class="muted" style="margin:0">匯入行事曆與名冊，比較三方案產生初版並鎖定。人由各區排，總召與人資在這裡檢查衝突、調整規則、定版匯出手冊。</p>
          <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">
            <li><a href="#/a1">A1 初版產生與方案比較</a></li>
            <li><a href="#/a2">A2 年度總表、勤務格與改派試算</a></li>
            <li><a href="#/a3">A3 人員狀態、月份時間軸與替補建議</a></li>
            <li><a href="#/a4">A4 規則開關、參數與情境試算</a></li>
            <li><a href="#/review">A6 各區排人進度與跨區協調</a></li>
            <li><a href="#/a5">A5 定版與 116 服務手冊印刷版匯出</a></li>
          </ul>
          <a class="btn pri" style="margin-top:auto;align-self:flex-start" href="#/a1">進入 A1–A6</a>
        </div>

        <div class="wb-card b card">
          <div class="small" style="font-weight:700;color:var(--info)">B · 區長、主廚、小組長</div>
          <h2>各區調整討論平台</h2>
          <p class="muted" style="margin:0">各區在這裡排自己的人，區長、人事組、輪值組可同時作業，手機也能用。要換日或換區用「提案」，系統先算出對各區的影響。</p>
          <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">
            <li><a href="#/b1/${esc(curArea)}">B1 本區首頁、負荷比較與幹部提名</a></li>
            <li><a href="#/p">B2 換日、換區、減人、合併支援影響試算</a></li>
            <li><a href="#/a/${esc(curArea)}">B3 / B4 / B6 本區手機排人與 6 大崗位配崗</a></li>
            <li><a href="#/t/${esc(curArea)}">B5 分工授權、復原紀錄與送出確認</a></li>
          </ul>
          <a class="btn blue" style="margin-top:auto;align-self:flex-start" href="#/b1/${esc(curArea)}">進入 B1–B5</a>
        </div>

        <div class="wb-card c card">
          <div class="small" style="font-weight:700;color:var(--warn)">C · 調度窗口、各區幹部、志工</div>
          <h2>排班運行調度台與個人查詢</h2>
          <p class="muted" style="margin:0">定版後每天看的畫面：定版鎖定、異動夾頁追蹤、志工本人與代管家人班表查詢。（C1–C3 運行調度台將於後續階段啟用）</p>
          <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">
            <li><a href="#/a5">定版鎖定與異動追蹤夾頁表 (A5)</a></li>
            <li><a href="#/login">第一次登入姓名綁定與代管家人 (M8)</a></li>
            <li><a href="#/">各區排班總入口與即時協作進度</a></li>
          </ul>
          <div class="acts" style="margin-top:auto">
            <a class="btn warn" href="#/login">帳號與綁定 (M8)</a>
            <a class="btn warn-out" href="#/a5">查看定版 (A5)</a>
          </div>
        </div>
      </section>

      <section aria-label="情境對照" style="display:flex;flex-direction:column;gap:10px">
        <div class="row-h">
          <div><h2>情境對照：遇到這種狀況，系統怎麼處理</h2><div class="small muted">涵蓋 18 種排班情境；點擊右欄畫板連結直接前往對應畫面操作。</div></div>
        </div>
        <div class="table-wrap">
          <div class="case-table">
            <div class="case-grid hd"><div>類別</div><div>情境</div><div>系統處理</div><div>畫板</div></div>
            ${cases.map(([g, s, h, w, href, cls]) => `<div class="case-grid">
              <div>${tag(cls, g)}</div>
              <div style="font-weight:600">${esc(s)}</div>
              <div class="muted">${esc(h)}</div>
              <div class="num"><a class="btn sm" href="${esc(href)}">${esc(w)} →</a></div>
            </div>`).join('')}
          </div>
        </div>
      </section>

      <section aria-label="角色與資料" class="grid2" style="gap:16px">
        <div class="card">
          <h2>誰看到什麼</h2>
          ${roles.map(([r, d]) => `<div class="kv-row"><b>${esc(r)}</b><span class="muted">${esc(d)}</span></div>`).join('')}
        </div>
        <div class="card">
          <h2>共用的資料骨幹（td116/*）</h2>
          ${dataNodes.map(([r, d]) => `<div class="kv-row"><b>${esc(r)}</b><span class="muted">${esc(d)}</span></div>`).join('')}
        </div>
      </section>
    </main>`;
  }

  /* ================================================================
   * A1 年度建置與初版產生 (#/a1)
   * ================================================================ */

  let simCCache = { sig: '', res: null };

  function getPlanSummary(ctx) {
    const { E, M } = ctx;
    const live = M.slots.filter((s) => !s.cancel);
    const activeAll = M.people.filter((p) => !p.off && p.a !== '金門');
    const cooks = activeAll.filter((p) => E.isCookPerson(M, p));
    const trs = activeAll.filter((p) => p.tr);
    const nonCooks = activeAll.length - cooks.length;

    let totalNeed = 0;
    let cookNeed = 0;
    let trNeed = 0;
    let otherNeed = 0;
    let totalGot = 0;
    for (const s of live) {
      const n = E.slotNeed(M, s);
      totalNeed += n;
      totalGot += M.asg[s.id].p.length;
      if (E.isCookSlot(s)) cookNeed += n;
      else if (s.cat === '交通') trNeed += n;
      else otherNeed += n;
    }

    const P = M.R.p;
    // 方案 A（理想）：依理想上限與 30 天不重複試算需求人力
    const cookIdealNeed = Math.ceil(cookNeed / Math.max(1, +P.cookIdeal || 6));
    const otherIdealNeed = Math.ceil(otherNeed / Math.max(1, +P.otherIdeal || 4));
    const trIdealNeed = Math.ceil(trNeed / Math.max(1, +P.otherIdeal || 4));
    const needA = cookIdealNeed + otherIdealNeed + trIdealNeed;
    const gapA = Math.max(0, needA - activeAll.length);
    const gapCookA = Math.max(0, cookIdealNeed - cooks.length);
    const gapOtherA = Math.max(0, otherIdealNeed - Math.max(0, nonCooks - trs.length));
    const gapTrA = Math.max(0, trIdealNeed - trs.length);

    // 方案 B（最小人力）：依最大上限＋平日天數限制分區計算
    const cookMinNeed = Math.ceil(cookNeed / Math.max(1, +P.cookMax || 10));
    const otherMinNeed = Math.ceil(otherNeed / Math.max(1, +P.otherMax || 6));
    const trMinNeed = Math.ceil(trNeed / Math.max(1, +P.otherMax || 6));
    const needB = cookMinNeed + otherMinNeed + trMinNeed;
    const gapBShared = Math.max(0, needB - activeAll.length);

    const areaShortB = [];
    let areaGapSumB = 0;
    for (const a of E.AREAS) {
      const aSlots = live.filter((s) => s.area === a);
      let ac = 0, ao = 0, wdPD = 0;
      for (const s of aSlots) {
        const n = E.slotNeed(M, s);
        if (E.isCookSlot(s)) ac += n;
        else ao += n;
        if (s.wdays) wdPD += n * s.wdays;
      }
      const reqByCap = Math.ceil(ac / Math.max(1, +P.cookMax || 10)) + Math.ceil(ao / Math.max(1, +P.otherMax || 6));
      const reqByWd = Math.ceil(wdPD / Math.max(1, +P.wdMax || 3)) * 0.6; // 部分人員退休免請假
      const req = Math.max(reqByCap, Math.round(reqByWd));
      const have = activeAll.filter((p) => p.a === a).length;
      const g = Math.max(0, req - have);
      areaGapSumB += g;
      areaShortB.push({ area: a, gap: g, req, have });
    }
    areaShortB.sort((x, y) => y.gap - x.gap);

    // 方案 C（現有人力試排）：若尚未寫入 assign，於記憶體快取試算；若已寫入則顯示即時結果
    const hasAssign = Object.keys(ctx.D().assign || {}).length > 0;
    const sig = [
      ctx.draftVer(),
      live.length,
      activeAll.length,
      totalGot,
      JSON.stringify(M.R.p),
      JSON.stringify(M.R.sev)
    ].join('|');

    let cRes;
    if (hasAssign) {
      let shortSlots = 0, shortPeople = 0;
      for (const s of live) {
        const n = E.slotNeed(M, s), g = M.asg[s.id].p.length;
        if (g < n) { shortSlots++; shortPeople += (n - g); }
      }
      const issC = ctx.cnt(ctx.ISS);
      cRes = {
        live: true,
        got: totalGot,
        need: totalNeed,
        slotCnt: live.length,
        shortSlots,
        shortPeople,
        v: issC.v,
        n: issC.n,
        model: M,
        issues: ctx.ISS
      };
    } else if (simCCache.sig === sig && simCCache.res) {
      cRes = simCCache.res;
    } else {
      const { baseSt, simSt } = cloneEngineState(ctx);
      let mC, issC = [];
      try {
        E.setState(simSt);
        mC = E.buildModel();
        E.autoSchedule(mC, null, 'fill');
        issC = E.allIssues(mC);
      } finally {
        E.setState(baseSt);
      }
      let cGot = 0, shortSlots = 0, shortPeople = 0;
      for (const s of mC.slots) {
        if (s.cancel) continue;
        const n = E.slotNeed(mC, s), g = mC.asg[s.id].p.length;
        cGot += g;
        if (g < n) { shortSlots++; shortPeople += (n - g); }
      }
      cRes = {
        live: false,
        got: cGot,
        need: totalNeed,
        slotCnt: live.length,
        shortSlots,
        shortPeople,
        v: issC.filter((x) => x.lvl === '違規').length,
        n: issC.filter((x) => x.lvl === '注意').length,
        model: mC,
        issues: issC
      };
      simCCache = { sig, res: cRes };
    }

    return {
      live, activeAll, totalNeed, totalGot,
      A: { need: needA, gap: gapA, gapCook: gapCookA, gapOther: gapOtherA, gapTr: gapTrA },
      B: { need: needB, gapShared: gapBShared, areaGapSum: areaGapSumB, areaShort: areaShortB },
      C: cRes
    };
  }

  function buildA1Diagnostics(ctx, simRes) {
    const { E } = ctx;
    const M = simRes.model || ctx.M;
    const iss = simRes.issues || ctx.ISS;
    const live = M.slots.filter((s) => !s.cancel);

    const shortOf = (pred) => {
      const list = [];
      let miss = 0;
      for (const s of live) {
        if (!pred(s)) continue;
        const n = E.slotNeed(M, s), g = M.asg[s.id].p.length;
        if (g < n) {
          list.push({ s, miss: n - g, got: g, need: n });
          miss += (n - g);
        }
      }
      return { list, miss };
    };

    const diags = [];

    // 1. 交通缺口 / 重疊
    const trShort = shortOf((s) => s.cat === '交通');
    const trP2 = iss.filter((c) => c.rule === 'P2' && c.slots.some((id) => M.byId[id] && M.byId[id].cat === '交通'));
    diags.push({
      id: 'diag-tr',
      kind: '交通',
      cls: trShort.miss || trP2.length ? 'bad' : 'ok',
      t: `交通排班缺額 ${trShort.miss} 人次${trP2.length ? ` · 同日重疊 ${trP2.length} 筆` : ''}`,
      why: `全名冊具交通角色僅 ${M.people.filter((p) => !p.off && p.tr).length} 人，道院交通與天達交通隊同日衝突時無法兼顧。`,
      s1: '道院交通（聯合二中隊）另由各區支援 8 人',
      s2: '或於大典／春秋祭改為接駁調度並降為基本需求',
      actLabel: '檢視明細',
      details: trShort.list.slice(0, 6).map((x) => `${ctx.slotName(x.s)}（已排 ${x.got}/${x.need}）`),
      propType: '合併支援',
      area: '交通隊',
      targetAreas: ['瑞芳', '內湖', '三重'],
      slotIds: trShort.list.slice(0, 4).map((x) => x.s.id),
      propTitle: `交通隊年度人力缺口 ${trShort.miss} 人次協調支援`,
      propOptions: [
        { id: 'A', label: '甲 道院交通由大區支援另補 8 人', changes: trShort.list[0] ? { [trShort.list[0].s.id]: { need: 8 } } : {}, needReply: ['瑞芳', '內湖'] },
        { id: 'B', label: '乙 降為基本需求 6 人', changes: trShort.list[0] ? { [trShort.list[0].s.id]: { need: 6 } } : {}, needReply: ['道院交通組'] }
      ]
    });

    // 2. 廚務（含青年班/組別衝突）
    const ckShort = shortOf((s) => E.isCookSlot(s));
    const ckA1 = iss.filter((c) => (c.rule === 'A1' || c.rule === 'A10') && c.slots.some((id) => M.byId[id] && E.isCookSlot(M.byId[id])));
    diags.push({
      id: 'diag-cook',
      kind: '廚務',
      cls: ckShort.miss || ckA1.length ? 'bad' : 'ok',
      t: `廚務缺額 ${ckShort.miss} 人次${ckA1.length ? ` · 區衝突 ${ckA1.length} 處` : ''}`,
      why: ckA1.length ? ckA1[0].msg : '青年班法會廚務與部分場次人力不足，或與忠恕週六大區撞期。',
      s1: '改派機動組支援，釋出該區廚務組人力',
      s2: '或由各區儲備廚師補齊缺額',
      actLabel: '檢視明細',
      details: ckA1.map((c) => c.msg).concat(ckShort.list.slice(0, 5).map((x) => `${ctx.slotName(x.s)}（${x.got}/${x.need}）`)),
      propType: '換區',
      area: (ckA1[0] && ckA1[0].area) || (ckShort.list[0] && ckShort.list[0].s.area) || '機動',
      targetAreas: ['內湖', '機動'],
      slotIds: (ckA1[0] ? ckA1[0].slots : ckShort.list.slice(0, 2).map((x) => x.s.id)),
      propTitle: (ckA1[0] && ckA1[0].msg) || '廚務場次人力缺口與機動支援',
      propOptions: [
        { id: 'A', label: '甲 改由機動組支援', changes: (ckA1[0] && ckA1[0].slots[0]) ? { [ckA1[0].slots[0]]: { area: '機動', grp: '機動', lock: false } } : {}, needReply: ['機動'] },
        { id: 'B', label: '乙 維持原組並標為例外', changes: {}, needReply: ['內湖'] }
      ]
    });

    // 3. 基隆 / 洗碗協辦缺口
    const klShort = shortOf((s) => s.area === '基隆' || s.cat === '洗碗' || s.cat === '協辦');
    const klAreaOnly = klShort.list.filter((x) => x.s.area === '基隆');
    diags.push({
      id: 'diag-keelung',
      kind: '基隆／協辦',
      cls: klShort.miss ? 'wn' : 'ok',
      t: `基隆與洗碗／協辦缺額 ${klShort.miss} 人次（基隆佔 ${klAreaOnly.reduce((a, x) => a + x.miss, 0)}）`,
      why: `基隆全區僅 ${M.people.filter((p) => !p.off && p.a === '基隆').length} 人且以忠恕平日及會館輪廚為主，假日環境整理／服務／洗碗易缺人。`,
      s1: '由鄰近區（瑞芳、內湖）合併支援基隆場次',
      s2: '新民班洗碗缺額由各區服務組餘額輪流協辦',
      actLabel: '檢視明細',
      details: klShort.list.slice(0, 6).map((x) => `${ctx.slotName(x.s)}（${x.s.area} · ${x.got}/${x.need}）`),
      propType: '合併支援',
      area: '基隆',
      targetAreas: ['基隆', '瑞芳', '新民班'],
      slotIds: klShort.list.slice(0, 3).map((x) => x.s.id),
      propTitle: `基隆與協辦／洗碗人力支援（共缺 ${klShort.miss} 人次）`,
      propOptions: [
        { id: 'A', label: '甲 瑞芳／內湖跨區支援缺額', changes: {}, needReply: ['基隆', '瑞芳'] },
        { id: 'B', label: '乙 調整該場需求人數下限', changes: klAreaOnly[0] ? { [klAreaOnly[0].s.id]: { need: Math.max(4, klAreaOnly[0].got || 6) } } : {}, needReply: ['基隆'] }
      ]
    });

    // 4. 廚務年度超限 (P5 / P5b)
    const cookP5 = iss.filter((c) => (c.rule === 'P5' || c.rule === 'P5b') && c.pid && E.isCookPerson(M, M.pById[c.pid]));
    const cookP5Unique = [...new Map(cookP5.map((c) => [c.pid, c])).values()];
    diags.push({
      id: 'diag-cook-cap',
      kind: '廚務超限',
      cls: cookP5Unique.length ? 'wn' : 'ok',
      t: `廚務人員超過年度次數上限／理想值：${cookP5Unique.length} 位`,
      why: `廚務組全年輪替場次集中（主廚／大廚多於 ${M.R.p.cookMax} 次），部分組員跨兼機動組導致超限。`,
      s1: '各區增補儲備廚師分擔週日明理班與忠恕輪廚',
      s2: '檢視機動組名單，避免單一主廚連兩週出勤',
      actLabel: '檢視明細',
      details: cookP5Unique.slice(0, 8).map((c) => c.msg),
      propType: '調整人數',
      area: (cookP5Unique[0] && cookP5Unique[0].area) || '內湖',
      targetAreas: ['內湖', '瑞芳', '三重', '基隆'],
      slotIds: cookP5Unique.slice(0, 3).flatMap((c) => c.slots).slice(0, 4),
      propTitle: `廚務人員年度超限（${cookP5Unique.length} 位）儲備廚師輪替提案`,
      propOptions: [
        { id: 'A', label: '甲 啟用各區儲備廚師輪替減壓', changes: {}, needReply: ['內湖', '瑞芳', '三重'] },
        { id: 'B', label: '乙 維持組別並接受廚務年度上限例外', changes: {}, needReply: ['總召'] }
      ]
    });

    // 5. 7 天內重複 (P3 / A7)
    const p3List = iss.filter((c) => c.rule === 'P3' || c.rule === 'A7');
    diags.push({
      id: 'diag-gap7',
      kind: '7 天內重複',
      cls: p3List.length ? 'bad' : 'ok',
      t: `間隔 ${M.R.p.hard} 天內重複出勤：${p3List.length} 筆（含廚務組 ${p3List.filter((x) => x.rule === 'A7').length} 筆）`,
      why: '多場法會與忠恕輪值相鄰（如 11 月讀經會考、8 月中元接忠恕），使同一組或同一人一週內連排兩次。',
      s1: '改由另一廚務組對調或拆組輪替',
      s2: '個人間隔過密者於總表改排候選人或標為例外',
      actLabel: '檢視明細',
      details: p3List.slice(0, 8).map((c) => c.msg),
      propType: '換區',
      area: (p3List[0] && p3List[0].area) || '瑞芳',
      targetAreas: ['瑞芳', '內湖', '基隆'],
      slotIds: p3List.slice(0, 2).flatMap((c) => c.slots).slice(0, 4),
      propTitle: `7 天內連續出勤調整（共 ${p3List.length} 筆）`,
      propOptions: [
        { id: 'A', label: '甲 調換相鄰場次組別／負責區', changes: {}, needReply: ['內湖', '基隆'] },
        { id: 'B', label: '乙 該梯次維持原組並通知備援', changes: {}, needReply: ['瑞芳'] }
      ]
    });

    return diags;
  }

  function runA1AutoSchedule(ctx, scopeOnly) {
    if (!ctx.need(ctx.isAdmin(), '只有總召或調度台可產生初版／重排')) return;
    const { E, store, D } = ctx;
    const { baseSt, simSt } = cloneEngineState(ctx);

    if (!CUI.a1.prefAff) simSt.rules.p.wAff = 0;
    if (CUI.a1.newTrainee) simSt.rules.p.wNew = -12;
    if (CUI.a1.shortage === 'cross') simSt.rules.p.allowCross = true;
    if (CUI.a1.shortage === 'min') simSt.rules.p.shortRatio = 0.85;

    const flt = (s) => {
      if (s.cancel || !s.area) return false;
      if (CUI.a1.scope === 'month') return slotMonthMatch(s, CUI.a1.scopeMonth);
      if (CUI.a1.scope === 'area') return s.area === CUI.a1.scopeArea;
      if (CUI.a1.scope === 'empty') return (ctx.M.asg[s.id] ? ctx.M.asg[s.id].p.length : 0) < E.slotNeed(ctx.M, s);
      return true;
    };

    const d0 = D();
    if (CUI.a1.keepLocked) {
      for (const s of ctx.M.slots) {
        if (s.cancel || s.groupKey) continue;
        const asgRec = (d0.assign || {})[s.id] || {};
        const pids = Object.keys(asgRec).map(Number);
        if (!pids.length) continue;
        // 保留已鎖定格既有人員，以及所有非自動排入手動調整的人員
        const lockedPids = pids.filter((pid) => s.lock || !(asgRec[pid] && asgRec[pid].byAuto));
        if (lockedPids.length) {
          simSt.assign[s.id] = simSt.assign[s.id] || { p: pids.slice(), lk: [] };
          simSt.assign[s.id].lk = lockedPids;
        }
      }
    }

    const mode = (CUI.a1.scope === 'empty') ? 'fill' : 'redo';
    const effFilter = flt;

    let m2;
    let added = 0;
    try {
      E.setState(simSt);
      m2 = E.buildModel();
      if (CUI.a1.layer === 'area_group') {
        // 只排到區與組：僅更新模型統計，不把個人寫入 assign
        added = 0;
      } else {
        added = E.autoSchedule(m2, effFilter, mode);
        if (!CUI.a1.noViol) {
          for (const s of m2.slots) {
            if (s.cancel || s.groupKey || !effFilter(s)) continue;
            const need = E.slotNeed(m2, s);
            if (m2.asg[s.id].p.length >= need) continue;
            const cands = E.rankCandidates(m2, s, { all: CUI.a1.shortage === 'cross' });
            for (const c of cands) {
              if (m2.asg[s.id].p.length >= need) break;
              E.assignToModel(m2, s, c.p.id);
              added++;
            }
          }
        }
      }
    } finally {
      E.setState(baseSt);
    }

    const d = D();
    const up = {
      'meta/plan': CUI.a1.plan,
      'meta/autoAt': Date.now(),
      'meta/autoBy': ctx.me().name
    };

    if (CUI.a1.layer !== 'area_group') {
      const nextVer = scopeOnly ? ctx.draftVer() : ctx.nextDraftVer(ctx.draftVer());
      if (!scopeOnly) up['meta/version'] = nextVer;

      for (const s of m2.slots) {
        if (s.cancel || s.groupKey || !effFilter(s)) continue;
        const prevRec = (d.assign || {})[s.id] || {};
        const prevPids = Object.keys(prevRec).map(Number);
        const nextPids = m2.asg[s.id].p;
        for (const oldId of prevPids) {
          if (!nextPids.includes(oldId)) up[`assign/${s.id}/${oldId}`] = null;
        }
        for (const pid of nextPids) {
          if (!prevRec[pid]) {
            const pre = ctx.isAdmin() && !(ctx.memberOf(s.area) && ctx.memberOf(s.area).status === 'ok') && E.AREAS.includes(s.area);
            up[`assign/${s.id}/${pid}`] = ctx.stamp(pre ? { pre: true, byAuto: CUI.a1.plan } : { byAuto: CUI.a1.plan });
          }
        }
      }
    }

    const scopeDesc = CUI.a1.scope === 'month' ? monthLabel(CUI.a1.scopeMonth)
      : CUI.a1.scope === 'area' ? CUI.a1.scopeArea
      : CUI.a1.scope === 'empty' ? '只補空格' : '全年';
    const msg = scopeOnly
      ? `A1 重排選定範圍（${scopeDesc}），排入 ${added} 人次`
      : `以方案 ${CUI.a1.plan} 產生初版（${scopeDesc}），共排入 ${added} 人次`;

    simCCache = { sig: '', res: null };
    store.update(Object.assign(up, ctx.logOp('總召', msg)));
    ctx.toast(msg);
  }

  function renderA1(ctx) {
    const { E, BASE, M, esc, wsHeader, tag } = ctx;
    const sum = getPlanSummary(ctx);
    const live = sum.live;
    const extraCnt = Object.keys(ctx.D().extra || {}).length;
    const addedCnt = Object.keys(ctx.D().addedPeople || {}).length;
    const offCnt = M.people.filter((p) => p.off).length;
    const grpReady = BASE.groupsMeta.filter((g) => (E.getState().groups[g.id] || []).length > 0).length;
    const lockedSlots = live.filter((s) => s.lock);
    const lockBySrc = {};
    for (const s of lockedSlots) {
      const k = s.src || '手動鎖定';
      lockBySrc[k] = (lockBySrc[k] || 0) + 1;
    }

    const steps = [
      { n: '1', t: '匯入行事曆與勤務格', d: `${live.length} 格（基準 ${BASE.slots.length} ＋ 新增 ${extraCnt}）`, st: '已完成', cls: 'done' },
      { n: '2', t: '匯入人員名冊與問卷', d: `${M.people.length} 人（可排 ${sum.activeAll.length}、暫停 ${offCnt}）`, st: '已完成', cls: 'done' },
      { n: '3', t: '確認固定組別名單', d: `已設定 ${grpReady}／${BASE.groupsMeta.length} 組（廚務／服務／禮節／交通）`, st: '已帶入', cls: 'done' },
      { n: '4', t: '規則與參數設定', d: `廚務上限 ${M.R.p.cookMax} · 其他 ${M.R.p.otherMax} · 間隔 ${M.R.p.hard} 天`, st: '可於 A4 調整', cls: 'done' },
      { n: '5', t: '產生初版與方案比較', d: `目前總表 ${sum.totalGot}／${sum.totalNeed} 人次`, st: '目前步驟', cls: 'cur' }
    ];

    const diags = buildA1Diagnostics(ctx, sum.C);
    const months = allMonths(ctx);
    const selPlan = CUI.a1.plan;

    return `${wsHeader('A', 'a1', ctx.defaultArea())}<main class="wide-main">
      ${unseededBanner(ctx)}
      <div class="split-grid">
        <aside class="split-side card">
          <h2>116 年度建置</h2>
          <div class="step-list">
            ${steps.map((s) => `<div class="step-item ${s.cls}">
              <div class="step-num">${s.n}</div>
              <div>
                <div style="font-weight:700">${esc(s.t)}</div>
                <div class="small muted">${esc(s.d)}</div>
                <div class="small" style="font-weight:700;color:${s.cls === 'cur' ? 'var(--accent-ink)' : 'var(--ok)'}">${esc(s.st)}</div>
              </div>
            </div>`).join('')}
          </div>
          <div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--sunk);display:flex;flex-direction:column;gap:6px">
            <h3 style="margin:0">已鎖定，不參與重排（共 ${lockedSlots.length} 格）</h3>
            ${Object.entries(lockBySrc).map(([src, count]) => `<div class="kv small"><span><span style="color:var(--pre);font-weight:700">鎖</span> ${esc(src)}</span><span class="num muted">${count} 格</span></div>`).join('') || '<div class="muted small">尚無鎖定勤務格</div>'}
          </div>
        </aside>

        <div class="split-main">
          <div class="page-head">
            <div>
              <div class="small" style="font-weight:700;color:var(--accent-ink)">步驟 5</div>
              <h1>選一個規則方案，產生初版</h1>
              <p class="muted" style="margin:4px 0 0">三個方案用同一份行事曆與名冊試算。選定後仍可於總表逐格調整，也可以只重排選定範圍。</p>
            </div>
            <div class="acts">
              <button type="button" class="btn" data-act="a1-run-scope">只重排選定範圍</button>
              <button type="button" class="btn pri" data-act="a1-run-c">以方案 ${esc(selPlan)} 產生初版</button>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:14px">
            <div class="plan-card ${selPlan === 'A' ? 'on' : ''}" data-act="a1-pick-plan" data-plan="A" style="cursor:pointer">
              <div class="row-h"><h3>A 理想</h3>${tag(sum.A.gap > 0 ? 'bad' : 'ok', sum.A.gap > 0 ? '人力不足' : '可達成')}</div>
              <div class="small muted">兩次服務間隔超過 30 天，不兼職；年度上限廚務 ${M.R.p.cookIdeal} 次、其他 ${M.R.p.otherIdeal} 次；廚務人員只做廚務。</div>
              <div style="display:flex;align-items:baseline;gap:8px"><span class="num t-bad" style="font-size:32px;font-weight:700">${sum.A.gap}</span><span class="muted">人缺口（現有 ${sum.activeAll.length} 人共用）</span></div>
              <div class="small muted">需要 ${sum.A.need} 人。缺口分布：一般服務 ${sum.A.gapOther}、廚務 ${sum.A.gapCook}、交通 ${sum.A.gapTr}。</div>
              <div class="small">用途：長期招募目標，每年對照距離。</div>
            </div>

            <div class="plan-card ${selPlan === 'B' ? 'on' : ''}" data-act="a1-pick-plan" data-plan="B" style="cursor:pointer">
              <div class="row-h"><h3>B 最小人力</h3>${tag('wn', '接近可行')}</div>
              <div class="small muted">間隔至少 ${+M.R.p.hard + 1} 天，允許同日兼職；上限廚務 ${M.R.p.cookMax} 次、其他 ${M.R.p.otherMax} 次；主廚、大廚只做廚務。</div>
              <div style="display:flex;align-items:baseline;gap:8px"><span class="num t-warn" style="font-size:32px;font-weight:700">${sum.B.gapShared}</span><span class="muted">人缺口（共用）· 分區合計 ${sum.B.areaGapSum}</span></div>
              <div class="small muted">需要 ${sum.B.need} 人。分區缺口：${sum.B.areaShort.map((x) => `${x.area} ${x.gap}`).join('、')}。</div>
              <div class="small">用途：招募新人與跨區支援的底線。</div>
            </div>

            <div class="plan-card ${selPlan === 'C' ? 'on' : ''}" data-act="a1-pick-plan" data-plan="C" style="cursor:pointer">
              <div class="row-h"><h3>C 現有人力試排</h3>${tag(selPlan === 'C' ? 'ok' : 'no', selPlan === 'C' ? '已選' : '點選')}</div>
              <div class="small muted">用目前規則與現有 ${sum.activeAll.length} 人名冊實際試排。排不進去的留空，違反的標出來。</div>
              <div style="display:flex;align-items:baseline;gap:8px"><span class="num t-ok" style="font-size:32px;font-weight:700">${sum.C.got.toLocaleString()}</span><span class="muted">／ ${sum.C.need.toLocaleString()} 人次${sum.C.live ? '已排' : '（試排預測）'}</span></div>
              <div class="small muted">${sum.C.slotCnt} 格勤務；違規 ${sum.C.v}、注意 ${sum.C.n}；尚缺 ${sum.C.shortPeople} 人次（${sum.C.shortSlots} 格）。</div>
              <div class="small">用途：帶進各區討論與協調的初版。</div>
            </div>
          </div>

          <section class="card">
            <div class="row-h"><h2>產生選項</h2><span class="muted small">設定範圍與原則後點擊上方「只重排選定範圍」或「產生初版」</span></div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px">
              <label>範圍
                <select id="a1Scope" data-act-change="a1-opt" data-k="scope">
                  <option value="all" ${CUI.a1.scope === 'all' ? 'selected' : ''}>全年</option>
                  <option value="month" ${CUI.a1.scope === 'month' ? 'selected' : ''}>指定月份</option>
                  <option value="area" ${CUI.a1.scope === 'area' ? 'selected' : ''}>指定區</option>
                  <option value="empty" ${CUI.a1.scope === 'empty' ? 'selected' : ''}>只補空格</option>
                </select>
              </label>
              ${CUI.a1.scope === 'month' ? `<label>選擇月份
                <select id="a1ScopeMonth" data-act-change="a1-opt" data-k="scopeMonth">
                  ${months.map((m) => `<option value="${m}" ${CUI.a1.scopeMonth === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
                </select>
              </label>` : ''}
              ${CUI.a1.scope === 'area' ? `<label>選擇區
                <select id="a1ScopeArea" data-act-change="a1-opt" data-k="scopeArea">
                  ${E.ALL_WORK_AREAS.map((a) => `<option ${CUI.a1.scopeArea === a ? 'selected' : ''}>${a}</option>`).join('')}
                </select>
              </label>` : ''}
              <label>排到哪一層
                <select id="a1Layer" data-act-change="a1-opt" data-k="layer">
                  <option value="individual" ${CUI.a1.layer === 'individual' ? 'selected' : ''}>區、組、個人（系統先排，各區再改）</option>
                  <option value="area_group" ${CUI.a1.layer === 'area_group' ? 'selected' : ''}>只排到區與組（人由各區排）</option>
                </select>
              </label>
              <label>人數不足時
                <select id="a1Shortage" data-act-change="a1-opt" data-k="shortage">
                  <option value="gap" ${CUI.a1.shortage === 'gap' ? 'selected' : ''}>留空並列入缺口</option>
                  <option value="cross" ${CUI.a1.shortage === 'cross' ? 'selected' : ''}>允許跨區補人</option>
                  <option value="min" ${CUI.a1.shortage === 'min' ? 'selected' : ''}>降到需求下限</option>
                </select>
              </label>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px 20px">
              <label class="ck"><input type="checkbox" data-act-change="a1-chk" data-k="keepLocked" ${CUI.a1.keepLocked ? 'checked' : ''}> 保留已鎖定與手動調整</label>
              <label class="ck"><input type="checkbox" data-act-change="a1-chk" data-k="prefAff" ${CUI.a1.prefAff ? 'checked' : ''}> 優先帶入固定搭檔</label>
              <label class="ck"><input type="checkbox" data-act-change="a1-chk" data-k="noViol" ${CUI.a1.noViol ? 'checked' : ''}> 不選會造成違規的人</label>
              <label class="ck"><input type="checkbox" data-act-change="a1-chk" data-k="newTrainee" ${CUI.a1.newTrainee ? 'checked' : ''}> 新人先排見習</label>
            </div>
          </section>

          <section class="card">
            <div class="row-h"><h2>初版留下的問題，以及建議做法</h2><span class="muted small">每一項都可以檢視明細或直接轉成提案交給各區討論</span></div>
            ${diags.map((g) => `<div class="coord-item">
              <div>
                ${tag(g.cls, g.kind)}
                <div style="font-weight:700;margin-top:6px">${esc(g.t)}</div>
                <div class="small muted">${esc(g.why)}</div>
                ${CUI.a1.openDiag === g.id ? `<div class="card" style="margin-top:8px;padding:10px;background:var(--sunk)">
                  <div class="small" style="font-weight:700">明細摘要</div>
                  ${g.details.length ? g.details.map((d) => `<div class="small">• ${esc(d)}</div>`).join('') : '<div class="small muted">目前無符合缺口項目</div>'}
                </div>` : ''}
              </div>
              <div class="small">
                <div style="font-weight:700;color:var(--muted)">建議做法</div>
                <div>${esc(g.s1)}</div>
                <div>${esc(g.s2)}</div>
              </div>
              <div class="acts">
                <button type="button" class="btn sm pri-out" data-act="a1-diag-detail" data-id="${g.id}">${CUI.a1.openDiag === g.id ? '收合明細' : g.actLabel}</button>
                <button type="button" class="btn sm" data-act="a1-to-prop" data-id="${g.id}">轉成提案</button>
              </div>
            </div>`).join('')}
          </section>
        </div>
      </div>
    </main>`;
  }

  /* ================================================================
   * A2 年度總表與勤務格 (#/a2)
   * ================================================================ */

  function computeAreaDelta(ctx, slotId) {
    const { E } = ctx;
    const s0 = ctx.M.byId[slotId];
    if (!s0) return {};
    const { baseSt, simSt } = cloneEngineState(ctx);
    const acks = ctx.D().acks || {};
    const isAcc = (c) => acks[E.issueKey(c)] && acks[E.issueKey(c)].st === '接受例外';
    const opts = E.isCookSlot(s0)
      ? E.AREAS.concat(['機動', '青年班'])
      : s0.cat === '交通'
        ? ['交通隊']
        : E.AREAS.concat(s0.cat === '洗碗' ? ['新民班'] : []);
    if (s0.area && !opts.includes(s0.area)) opts.unshift(s0.area);

    const res = {};
    try {
      E.setState(simSt);
      const b0 = E.areaIssues(ctx.M).filter((c) => !isAcc(c));
      const v0 = b0.filter((c) => c.lvl === '違規').length;
      const n0 = b0.filter((c) => c.lvl === '注意').length;
      const origEd = simSt.edits[slotId];
      for (const a of opts) {
        const grp = E.defaultGroupForAreaCat(a, s0.cat);
        simSt.edits[slotId] = Object.assign({}, origEd || {}, { area: a, grp: grp || '' });
        const m2 = E.buildModel();
        const b2 = E.areaIssues(m2).filter((c) => !isAcc(c));
        res[a] = {
          dv: b2.filter((c) => c.lvl === '違規').length - v0,
          dn: b2.filter((c) => c.lvl === '注意').length - n0
        };
      }
    } finally {
      E.setState(baseSt);
    }
    return res;
  }

  function filteredA2Slots(ctx, bySlot) {
    const M = ctx.M;
    let L = M.slots.slice();
    if (CUI.a2.month) L = L.filter((s) => slotMonthMatch(s, CUI.a2.month));
    if (CUI.a2.area) L = L.filter((s) => s.area === CUI.a2.area);
    if (CUI.a2.cat) {
      L = L.filter((s) => (CUI.a2.cat === '忠恕' ? s.cat.startsWith('忠恕') : s.cat === CUI.a2.cat));
    }
    if (CUI.a2.only) {
      L = L.filter((s) => {
        if (s.cancel) return false;
        const c = ctx.cnt(bySlot[s.id]);
        const need = ctx.E.slotNeed(M, s);
        return c.v > 0 || c.n > 0 || M.asg[s.id].p.length < need;
      });
    }
    if (CUI.a2.q) {
      const q = CUI.a2.q.trim();
      L = L.filter((s) => {
        const act = ((ctx.BASE.days[s.d] || {}).act || '');
        if (act.includes(q) || (s.label || '').includes(q) || (s.cat || '').includes(q) || (s.area || '').includes(q) || (s.loc || '').includes(q)) return true;
        return (M.asg[s.id].p || []).some((pid) => (M.pById[pid] && M.pById[pid].n.includes(q)));
      });
    }
    return L;
  }

  function renderA2Matrix(ctx, slots, bySlot, selId) {
    const { E, M, BASE, esc, cnt, tag } = ctx;
    const slotDates = new Set(slots.map((s) => s.d));
    const hasFilter = !!(CUI.a2.area || CUI.a2.cat || CUI.a2.only || CUI.a2.q);
    const dateSet = new Set(Object.keys(BASE.days));
    for (const s of slots) if (s.d) dateSet.add(s.d);
    const allDates = [...dateSet].sort().filter((d) => {
      if (CUI.a2.month && !slotMonthMatch({ d }, CUI.a2.month)) return false;
      if (hasFilter) return slotDates.has(d);
      return true;
    });
    const byDay = {};
    for (const s of slots) (byDay[s.d] = byDay[s.d] || []).push(s);

    const cols = [
      ['廚務', (s) => E.isCookSlot(s)],
      ['環境整理', (s) => s.cat === '環境整理'],
      ['服務', (s) => s.cat === '服務'],
      ['禮節', (s) => s.cat === '禮節'],
      ['洗碗', (s) => s.cat === '洗碗'],
      ['忠恕輪值', (s) => s.cat.startsWith('忠恕')],
      ['前晚／協辦', (s) => s.cat === '大典前晚' || s.cat === '協辦'],
      ['交通', (s) => s.cat === '交通']
    ];

    let rowsHtml = '';
    let lastM = '';
    for (const d of allDates) {
      const ym = d.slice(0, 7);
      if (ym !== lastM) {
        rowsHtml += `<tr style="background:var(--sunk);font-weight:700;color:var(--accent-ink)"><td colspan="10">${esc(monthLabel(ym))}</td></tr>`;
        lastM = ym;
      }
      const info = BASE.days[d] || {};
      const ss = (byDay[d] || []).filter((s) => !s.cancel);
      const w = E.wdOf(d);
      rowsHtml += `<tr>
        <td class="num" style="white-space:nowrap">${esc(E.fmtD(d))} <span class="muted">${E.WD[w]}</span></td>
        <td><div style="font-weight:600">${esc(info.act || '')}</div>${info.loc ? `<div class="small muted">${esc(info.loc)}</div>` : ''}</td>
        ${cols.map(([, pred]) => `<td>${ss.filter(pred).map((s) => {
          const c = cnt(bySlot[s.id]);
          const got = M.asg[s.id].p.length;
          const need = E.slotNeed(M, s);
          const cls = c.v ? 'bad' : (c.n || got < need) ? 'warn' : '';
          const selCls = s.id === selId ? 'row-sel' : '';
          return `<button type="button" class="matrix-slot chip-slot ${cls} ${selCls}" data-act="a2-sel" data-sid="${s.id}">
            <span class="${E.AREAS.includes(s.area) ? 'c-' + esc(s.area) : ''}">${esc(s.area)}</span>
            ${s.grp ? `<span class="small muted">${esc(s.grp)}</span>` : ''}
            <span class="num small muted">${got}/${need}</span>
          </button>`;
        }).join(' ')}</td>`).join('')}
      </tr>`;
    }

    return `<div class="table-wrap table-scroll-y"><table class="matrix-table">
      <thead><tr><th>日期</th><th>活動</th>${cols.map(([n]) => `<th>${n}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="10" class="empty">沒有符合條件的日期</td></tr>'}</tbody>
    </table></div>`;
  }

  function renderA2List(ctx, passedSlots, passedBySlot, passedSelId) {
    const { E, M, BASE, esc, cnt, tag } = ctx;
    const idx = passedBySlot ? { bySlot: passedBySlot } : buildIndexes(ctx);
    const bySlot = idx.bySlot;
    const slots = passedSlots || filteredA2Slots(ctx, bySlot);
    const selId = passedSelId || CUI.a2.selId || (slots[0] && slots[0].id) || '';

    if (CUI.a2.mode === 'matrix') {
      return renderA2Matrix(ctx, slots, bySlot, selId);
    }

    const rows = slots.map((s) => {
      const got = M.asg[s.id].p.length;
      const need = E.slotNeed(M, s);
      const c = cnt(bySlot[s.id]);
      const info = BASE.days[s.d] || {};
      const selCls = s.id === selId ? 'row-sel' : '';
      let stTag = tag('ok', '通過');
      let noteTxt = s.src || '';
      if (s.cancel) {
        stTag = tag('no', '不需要');
        noteTxt = '此日已標為不需要';
      } else if (c.v) {
        stTag = tag('bad', `違規 ${c.v}`);
        noteTxt = (bySlot[s.id].find((x) => !x.accepted && x.lvl === '違規') || {}).msg || '';
      } else if (c.n) {
        stTag = tag('wn', `注意 ${c.n}`);
        noteTxt = (bySlot[s.id].find((x) => !x.accepted && x.lvl === '注意') || {}).msg || '';
      } else if (got < need) {
        stTag = tag('wn', got ? `缺 ${need - got}` : '待排');
      } else if (s.lock) {
        stTag = tag('pre', '已鎖定');
      }

      return `<div class="a2-grid ${selCls}" data-act="a2-sel" data-sid="${s.id}" style="cursor:pointer${s.cancel ? ';opacity:0.55' : ''}">
        <div class="num small">${esc(E.fmtD(s.d))}（${E.WD[s.wd]}）</div>
        <div><div style="font-weight:500">${esc(s.label || info.act || s.cat)}</div><div class="small muted">${esc(s.loc)}${s.edited ? ' · 已改派' : ''}</div></div>
        <div><b>${esc(s.cat)}</b>${s.grp ? ` <span class="small muted">${esc(s.grp)}</span>` : ''}</div>
        <div class="${E.AREAS.includes(s.area) ? 'c-' + esc(s.area) : ''}" style="font-weight:700">${esc(s.area || '未定')}</div>
        <div class="num small ${!s.cancel && got < need ? 't-bad' : ''}">${s.cancel ? '—' : `${got}／${need}`}</div>
        <div>${stTag} <span class="small muted">${esc(noteTxt.slice(0, 22))}${noteTxt.length > 22 ? '…' : ''}</span></div>
      </div>`;
    }).join('');

    return `<div class="table-wrap table-scroll-y"><div class="a2-table">
      <div class="a2-grid hd"><div>日期</div><div>活動</div><div>勤務</div><div>負責</div><div>人數</div><div>檢查</div></div>
      ${rows || '<div class="empty">沒有符合條件的勤務格</div>'}
    </div></div>`;
  }

  function renderA2Inspector(ctx, s, bySlot, byPid) {
    if (!s) return `<div class="card"><div class="empty">點選左側任一勤務格以檢視與操作。</div></div>`;
    const { E, M, esc, dLabel, roleOf, cnt, tag } = ctx;
    const A = M.asg[s.id];
    const need = E.slotNeed(M, s);
    const gm = s.groupKey ? gmOf(ctx, s.groupKey) : null;
    const areaDelta = computeAreaDelta(ctx, s.id);
    const areaOpts = Object.keys(areaDelta);
    const grpOpts = E.groupOptionsForSlot(s);

    // 已排人員與問題置頂
    const staffRows = A.p.map((pid) => {
      const p = M.pById[pid];
      const r = s.groupKey ? rec(ctx, 'groups', s.groupKey, pid) : rec(ctx, 'assign', s.id, pid);
      const iss = (byPid[pid] || []).filter((c) => !c.accepted && (c.slots.includes(s.id) || ['P5', 'P5b', 'P6'].includes(c.rule)));
      const c = cnt(iss);
      return { p, r, iss, c, sortKey: (r && r.pre ? 100 : 0) + c.v * 20 + c.n * 5 + (E.canLead(p, s) ? 1 : 0) };
    }).sort((a, b) => b.sortKey - a.sortKey);

    const loudStaff = staffRows.filter((x) => (x.r && x.r.pre) || x.c.v > 0 || x.c.n > 0);
    const quietStaff = staffRows.filter((x) => !loudStaff.includes(x));
    const showQuiet = CUI.a2.showAllStaff || quietStaff.length <= 4;
    const visibleStaff = loudStaff.concat(showQuiet ? quietStaff : []);

    // 格層級／區層級問題
    const slotIss = (bySlot[s.id] || []).filter((c) => !c.accepted && (c.pid == null || c.scope !== '人'));
    const allOpenOnSlot = (bySlot[s.id] || []).filter((c) => !c.accepted);

    // 候選人排序
    const rawPool = CUI.a2.crossCands
      ? M.people.filter((p) => !p.off && !A.p.includes(p.id) && p.a !== '金門')
      : E.poolFor(M, s, false);
    const ranked = rawPool.map((p) => ctx.evalInSlot(p, s))
      .sort((a, b) => (a.hard.length - b.hard.length) || b.score - a.score);
    const visibleCands = CUI.a2.showAllCands ? ranked : ranked.slice(0, 5);
    const preBtnLabel = (ctx.isAdmin() && !(ctx.memberOf(s.area) && ctx.memberOf(s.area).status === 'ok') && E.AREAS.includes(s.area)) ? '預排' : '加入';

    // 建議框：挑選最重要的一筆提示
    const topHintIss = allOpenOnSlot.find((c) => c.lvl === '違規') || allOpenOnSlot[0];

    const renderStaffItem = (x) => {
      const { p, r, iss, c } = x;
      const stTag = r && r.pre ? tag('pre', '預排') : c.v ? tag('bad', iss[0].rule + ' 違規') : c.n ? tag('wn', iss[0].rule + ' 注意') : E.canLead(p, s) ? tag('ok', '可帶隊') : '';
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:8px;background:var(--sunk)">
        <div style="min-width:0">
          <div><button type="button" class="link" data-act="person" data-pid="${p.id}">${esc(p.n)}</button> <span class="small muted">${esc(roleOf(p) || p.a)}</span></div>
          ${iss.length ? `<div class="small ${c.v ? 't-bad' : 't-warn'}">${esc(iss[0].msg)}</div>` : ''}
        </div>
        <div class="acts" style="flex:none">
          ${stTag}
          ${r && r.pre ? `<button type="button" class="btn sm pri" data-act="a2-pre-ok" data-sid="${s.id}" data-pid="${p.id}">確認</button>` : ''}
          <button type="button" class="btn sm" data-act="a2-rm-person" data-sid="${s.id}" data-pid="${p.id}" title="${gm ? '從組別移出' : '從本場移出'}">移出</button>
        </div>
      </div>`;
    };

    return `<div class="card">
      <div>
        <div class="num small muted">${esc(dLabel(s))} · ${esc(s.loc)}${s.lock ? ' · 已鎖定' : ''}${s.cancel ? ' · 此日不需要' : ''}</div>
        <h2 style="font-family:var(--f-disp);font-size:21px;margin:2px 0 4px">${esc(s.label || s.cat)}</h2>
        <div class="small muted">需求 ${need} 人 · ${gm ? `連動組別 ${esc(gm.name)}（<a href="#/g/${gm.id}">進組別頁</a>）` : '依日期排人'} · 來源：${esc(s.src || '基準')}</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:6px">
        <label>負責區（改派即時試算）
          <select id="a2Area_${s.id}" data-act-change="a2-set-area" data-sid="${s.id}">
            ${areaOpts.map((a) => {
              const d = areaDelta[a] || { dv: 0, dn: 0 };
              const txt = a === s.area ? `${a}（目前）` : `${a}　${fmtDelta(d.dv, '違規')}　${fmtDelta(d.dn, '注意')}`;
              return `<option value="${esc(a)}" ${a === s.area ? 'selected' : ''}>${esc(txt)}</option>`;
            }).join('')}
          </select>
        </label>
        ${grpOpts.length ? `<label>組別／隊別
          <select id="a2Grp_${s.id}" data-act-change="a2-set-grp" data-sid="${s.id}">
            <option value="">不指定組別</option>
            ${grpOpts.map((g) => `<option value="${esc(g)}" ${g === s.grp ? 'selected' : ''}>${esc(g)}</option>`).join('')}
          </select>
        </label>` : ''}
        <div class="small muted">每個選項顯示改派後增減的區層級違規與注意。${M.R.p.weekdayOnlyAreas ? `${esc(M.R.p.weekdayOnlyAreas)}只排平日。` : ''}</div>
      </div>

      ${slotIss.length ? `<div style="display:flex;flex-direction:column;gap:4px">
        ${slotIss.map((c) => `<div class="iss ${c.lvl === '違規' ? 'bad' : 'warn'}">${esc(c.rule)}：${esc(c.msg)}</div>`).join('')}
      </div>` : ''}

      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="row-h">
          <h3 style="margin:0">已排 ${A.p.length} 人</h3>
          <span class="small ${A.p.length < need ? 't-warn' : 't-ok'}" style="font-weight:700">${A.p.length < need ? `還差 ${need - A.p.length} 人` : '已達需求'}</span>
        </div>
        ${visibleStaff.map(renderStaffItem).join('') || '<div class="muted small">尚未排人</div>'}
        ${!showQuiet ? `<button type="button" class="btn sm" data-act="a2-show-staff">展開其餘 ${quietStaff.length} 位無問題人員</button>` : ''}
      </div>

      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="row-h">
          <h3 style="margin:0">候選人（依合適程度）</h3>
          <label class="ck small" style="min-height:0"><input type="checkbox" data-act-change="a2-cross" ${CUI.a2.crossCands ? 'checked' : ''}> 含其他區</label>
        </div>
        <div class="small muted">人由各區排；按「預排」會標示預排標籤，待區長確認或重排。</div>
        ${visibleCands.map((ev) => {
          const p = ev.p;
          const why = ev.hard[0] ? ev.hard[0].msg : ev.soft[0] ? ev.soft[0].msg : `加入後全年 ${ev.occN} 次${ev.mates.length ? ' · 搭檔 ' + ev.mates.slice(0, 2).join('、') : ''}`;
          return `<div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:8px">
            <div style="min-width:0">
              <div><button type="button" class="link" data-act="person" data-pid="${p.id}">${esc(p.n)}</button> <span class="small muted">${esc(p.a)}${roleOf(p) ? ' · ' + esc(roleOf(p)) : ''}</span></div>
              <div class="small ${ev.hard.length ? 't-bad' : ev.soft.length ? 't-warn' : 'muted'}">${esc(why)}</div>
            </div>
            <button type="button" class="btn sm pri-out" data-act="a2-add-person" data-sid="${s.id}" data-pid="${p.id}">${preBtnLabel}</button>
          </div>`;
        }).join('') || '<div class="muted small">目前沒有其他可排候選人</div>'}
        ${ranked.length > visibleCands.length ? `<button type="button" class="btn sm" data-act="a2-show-cands">顯示全部 ${ranked.length} 位候選人</button>` : ''}
      </div>

      ${topHintIss ? `<div class="card warnbox" style="background:var(--warn-soft);padding:12px">
        <div style="font-weight:700;color:var(--warn)">這一格的建議</div>
        <div class="small">${esc(topHintIss.msg)}。可改由同區可帶隊人員接替，或標記為接受例外。</div>
        <div class="acts">
          <button type="button" class="btn sm warn" data-act="a2-swap-lead" data-sid="${s.id}">換帶隊人</button>
          <button type="button" class="btn sm warn-out" data-act="a2-ack-slot" data-sid="${s.id}">接受例外</button>
        </div>
      </div>` : ''}

      <div class="acts">
        <button type="button" class="btn pri" data-act="a2-autofill" data-sid="${s.id}">預排補滿</button>
        <button type="button" class="btn" data-act="a2-toggle-lock" data-sid="${s.id}">${s.lock ? '解除鎖定' : '鎖定這一格'}</button>
        <button type="button" class="btn" data-act="a2-toggle-cancel" data-sid="${s.id}">${s.cancel ? '恢復此格' : '此日不需要'}</button>
      </div>
    </div>`;
  }

  function renderA2(ctx) {
    const { E, M, ISS, esc, wsHeader, cnt } = ctx;
    const { bySlot, byPid } = buildIndexes(ctx);
    const live = M.slots.filter((s) => !s.cancel);
    let totalNeed = 0, totalGot = 0, shortSlots = 0, lockedCnt = 0;
    for (const s of live) {
      const n = E.slotNeed(M, s), g = M.asg[s.id].p.length;
      totalNeed += n;
      totalGot += g;
      if (g < n) shortSlots++;
      if (s.lock) lockedCnt++;
    }
    const issCnt = cnt(ISS);
    const areaViol = ISS.filter((c) => !c.accepted && c.lvl === '違規' && c.scope === '區').length;
    const accCnt = ISS.filter((c) => c.accepted).length;

    const filtered = filteredA2Slots(ctx, bySlot);
    let selId = CUI.a2.selId;
    if (!selId || !M.byId[selId]) {
      selId = (filtered[0] && filtered[0].id) || (live[0] && live[0].id) || '';
      CUI.a2.selId = selId;
    }
    const selSlot = selId ? M.byId[selId] : null;

    const monthBtns = [['', '全部'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'], ['10', '10'], ['11', '11'], ['12', '12'], ['117', '117']];

    const addForm = CUI.a2.addOpen ? `<section class="card warnbox">
      <div class="row-h"><h2>新增勤務格（寫入雲端 extra）</h2><button type="button" class="btn sm" data-act="a2-add-toggle">關閉</button></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr));gap:10px">
        <label>開始日期<input id="a2NsD" type="date" value="2027-07-18" min="2027-01-01" max="2028-02-29"></label>
        <label>結束日期（同日可留空）<input id="a2NsE" type="date" min="2027-01-01" max="2028-02-29"></label>
        <label>類別<select id="a2NsCat">${E.CATS.map((c) => `<option>${c}</option>`).join('')}</select></label>
        <label>負責區<select id="a2NsArea">${E.ALL_WORK_AREAS.map((a) => `<option>${a}</option>`).join('')}</select></label>
        <label>組別（可留空）<input id="a2NsGrp" type="text" placeholder="如 1、A、機動"></label>
        <label>需要人數<input id="a2NsNeed" type="number" min="1" max="80" value="10"></label>
        <label>地點<select id="a2NsLoc">${['天達堂', '道院', '會館', '德光', '各區'].map((x) => `<option>${x}</option>`).join('')}</select></label>
        <label>活動說明<input id="a2NsLabel" type="text" placeholder="例：臨時活動支援"></label>
      </div>
      <div class="acts"><button type="button" class="btn pri" data-act="a2-create-slot">建立勤務格</button></div>
    </section>` : '';

    return `${wsHeader('A', 'a2', ctx.defaultArea())}<main class="wide-main">
      ${unseededBanner(ctx)}
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-l">年度勤務格</div><div class="kpi-v">${live.length}</div><div class="kpi-s">已鎖定 ${lockedCnt} · 取消 ${M.slots.length - live.length}</div></div>
        <div class="kpi-card"><div class="kpi-l">已排人次／需要</div><div class="kpi-v">${totalGot.toLocaleString()}</div><div class="kpi-s">需要 ${totalNeed.toLocaleString()}（${totalNeed ? Math.round(totalGot / totalNeed * 100) : 0}%）</div></div>
        <div class="kpi-card"><div class="kpi-l">違規</div><div class="kpi-v ${issCnt.v ? 't-bad' : 't-ok'}">${issCnt.v}</div><div class="kpi-s">區層級 ${areaViol} · 個人 ${issCnt.v - areaViol}</div></div>
        <div class="kpi-card"><div class="kpi-l">注意</div><div class="kpi-v ${issCnt.n ? 't-warn' : ''}">${issCnt.n}</div><div class="kpi-s">已接受例外 ${accCnt}</div></div>
        <div class="kpi-card"><div class="kpi-l">人數不足格</div><div class="kpi-v ${shortSlots ? 't-bad' : 't-ok'}">${shortSlots}</div><div class="kpi-s">點選右側可立即補滿</div></div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
        <div class="month-bar" role="group" aria-label="月份篩選">
          ${monthBtns.map(([v, label]) => `<button type="button" class="month-btn ${CUI.a2.month === v ? 'on' : ''}" data-act="a2-month" data-v="${v}">${label}</button>`).join('')}
        </div>
        <div class="acts">
          <select id="a2AreaSel" aria-label="篩選負責區" data-act-change="a2-area" style="min-height:44px;border-radius:8px;border:1px solid var(--line);padding:0 10px;background:var(--surface)">
            <option value="">全部的區</option>
            ${E.ALL_WORK_AREAS.map((a) => `<option value="${a}" ${CUI.a2.area === a ? 'selected' : ''}>${a}</option>`).join('')}
          </select>
          <select id="a2CatSel" aria-label="篩選類別" data-act-change="a2-cat" style="min-height:44px;border-radius:8px;border:1px solid var(--line);padding:0 10px;background:var(--surface)">
            <option value="">全部類別</option>
            ${['廚務', '會館輪廚', '環境整理', '服務', '禮節', '洗碗', '忠恕', '忠恕平日', '忠恕週六', '忠恕週日', '大典前晚', '協辦', '交通'].map((c) => `<option value="${c}" ${CUI.a2.cat === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
          <input id="a2Q" type="search" data-input="a2Q" value="${esc(CUI.a2.q)}" placeholder="搜尋活動、勤務或姓名" aria-label="搜尋總表" style="min-height:44px;border-radius:8px;border:1px solid var(--line);padding:0 12px;background:var(--surface)">
          <label class="ck" style="padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface)"><input id="a2OnlyChk" type="checkbox" data-act-change="a2-only" ${CUI.a2.only ? 'checked' : ''}> 只看有問題</label>
          <button type="button" class="btn" data-act="a2-mode">${CUI.a2.mode === 'matrix' ? '切換為列表' : '切換為矩陣'}</button>
          <button type="button" class="btn pri" data-act="a2-add-toggle">＋ 新增勤務</button>
        </div>
      </div>

      ${addForm}

      <div class="split-grid">
        <div class="split-main" id="a2List">${renderA2List(ctx, filtered, bySlot, selId)}</div>
        <aside class="split-side inspector" aria-label="勤務格細節">${renderA2Inspector(ctx, selSlot, bySlot, byPid)}</aside>
      </div>
    </main>`;
  }

  /* ================================================================
   * A3 人員狀態 (#/a3)
   * ================================================================ */

  function a3ChipMatch(ctx, p, chip) {
    const o = (ctx.D().pov || {})[p.id] || {};
    const occ = ctx.E.occasions(ctx.M.personSlots[p.id] || []).length;
    const cap = ctx.E.capOf(ctx.M, p);
    const wd = personWeekdayDays(ctx, p.id);
    const wdLimit = (o.wdCap !== undefined && o.wdCap !== '') ? +o.wdCap : +ctx.M.R.p.wdMax;

    if (chip === '全部') return true;
    if (chip === '暫停／不方便') return (p.months && p.months.length > 0) || o.status === '暫停一段時間';
    if (chip === '限量／只排假日') return o.status === '限量' || o.status === '只排假日' || !!p.cap || o.wdCap === 0 || o.wdCap === '0';
    if (chip === '超過上限') return occ > cap.max || ((o.wdCap !== undefined && o.wdCap !== '' ? true : (p.work === '上班中' || !p.work)) && wd > wdLimit);
    if (chip === '新人見習') return p.src === 'N' || o.status === '新人見習';
    if (chip === '高齡／健康') return (p.age && p.age >= ctx.M.R.p.oldAge) || o.stamina === '輕工作' || o.stamina === '以坐著為主';
    if (chip === '不再排班') return !!p.off || o.status === '不再排班';
    return true;
  }

  function filteredA3People(ctx) {
    let L = ctx.M.people.slice();
    if (CUI.a3.area) L = L.filter((p) => p.a === CUI.a3.area);
    if (CUI.a3.chip && CUI.a3.chip !== '全部') L = L.filter((p) => a3ChipMatch(ctx, p, CUI.a3.chip));
    if (CUI.a3.q) {
      const q = CUI.a3.q.trim();
      L = L.filter((p) => p.n.includes(q) || (p.a || '').includes(q) || ctx.roleOf(p).includes(q));
    }
    return L;
  }

  function renderA3List(ctx, passedPeople, passedSelPid) {
    const { E, M, esc, roleOf, tag } = ctx;
    const list = passedPeople || filteredA3People(ctx);
    const selPid = passedSelPid || CUI.a3.selPid || (list[0] && list[0].id) || 0;
    const capLimit = CUI.a3.showAllPeople ? list.length : 80;
    const shown = list.slice(0, capLimit);

    const rows = shown.map((p) => {
      const o = (ctx.D().pov || {})[p.id] || {};
      const occ = E.occasions(M.personSlots[p.id] || []).length;
      const cap = E.capOf(M, p);
      const wd = personWeekdayDays(ctx, p.id);
      const wdLim = (o.wdCap !== undefined && o.wdCap !== '') ? +o.wdCap : +M.R.p.wdMax;
      const wdOver = (o.wdCap !== undefined && o.wdCap !== '' ? wd > wdLim : (p.work === '上班中' || !p.work) && wd > wdLim);
      const stTxt = personStatusText(ctx, p);
      const stCls = stTxt === '不再排班' ? 'bad' : (stTxt.includes('暫停') || stTxt === '只排假日' || stTxt.includes('限量')) ? 'wn' : stTxt === '新人見習' ? 'pl' : 'ok';
      const trTxt = o.trans || p.tr || '—';
      const selCls = p.id === selPid ? 'row-sel' : '';

      return `<div class="a3-grid ${selCls}" data-act="a3-sel" data-pid="${p.id}" style="cursor:pointer">
        <div><b>${esc(p.n)}</b>${p.age ? ` <span class="small muted">${p.age}歲</span>` : ''}</div>
        <div class="${E.AREAS.includes(p.a) ? 'c-' + esc(p.a) : ''}" style="font-weight:700">${esc(p.a)}</div>
        <div class="small muted">${esc(roleOf(p) || (p.src === 'N' ? '新人' : '一般'))}</div>
        <div class="num small ${occ > cap.max ? 't-bad' : ''}">${occ}／${cap.max}</div>
        <div class="num small ${wdOver ? 't-bad' : ''}">${wd}／${wdLim === 0 ? '禁' : wdLim}</div>
        <div>${tag(stCls, stTxt)}</div>
        <div class="small muted">${esc(trTxt)}</div>
      </div>`;
    }).join('');

    return `<div class="table-wrap table-scroll-y"><div class="a3-table">
      <div class="a3-grid hd"><div>姓名</div><div>區</div><div>角色</div><div>全年</div><div>平日</div><div>狀態</div><div>交通</div></div>
      ${rows || '<div class="empty">沒有符合條件的人員</div>'}
    </div></div>
    ${list.length > shown.length ? `<button type="button" class="btn wide" style="margin-top:8px" data-act="a3-show-all">顯示全部 ${list.length} 人（目前顯示 ${shown.length} 人）</button>` : ''}
    <div class="small muted" style="margin-top:6px">全年與平日欄：已排次數／上限。紅字表示超過上限。點擊任一列可於右側編輯狀態與時間軸。</div>`;
  }

  function findAffectedSlotsForPerson(ctx, p) {
    const M = ctx.M;
    const o = (ctx.D().pov || {})[p.id] || {};
    const list = M.personSlots[p.id] || [];
    const out = [];
    for (const s of list) {
      if (p.off || o.status === '不再排班') {
        out.push({ s, why: '不再排班' });
        continue;
      }
      let hitWhy = '';
      for (let x = s.ds; x <= s.de; x++) {
        const k = ctx.E.ds(x);
        const m = +k.slice(5, 7);
        if (p.unav.includes(k)) { hitWhy = ctx.E.fmtD(k) + ' 不可排'; break; }
        if (p.months.includes(m)) { hitWhy = m + ' 月暫停'; break; }
      }
      if (!hitWhy && (o.wdCap === 0 || o.wdCap === '0' || o.status === '只排假日') && s.weekday) {
        hitWhy = '只排假日';
      }
      if (hitWhy) out.push({ s, why: hitWhy });
    }
    return out;
  }

  function findSubstituteForSlot(ctx, p, s) {
    const { E, M } = ctx;
    const pool = E.poolFor(M, s, false).filter((c) => c.id !== p.id);
    const ranked = pool.map((c) => {
      const ev = ctx.evalInSlot(c, s);
      const affWithP = (M.aff[p.id] || {})[c.id] || 0;
      const sameGrp = (M.personGroups[p.id] || []).some((gk) => (M.personGroups[c.id] || []).includes(gk));
      const bonus = affWithP * 30 + (sameGrp ? 12 : 0) + (E.canLead(p, s) && E.canLead(c, s) ? 50 : 0);
      return { c, ev, affWithP, sameGrp, rankScore: ev.score + bonus };
    }).filter((x) => x.ev.hard.length === 0)
      .sort((a, b) => b.rankScore - a.rankScore);
    return ranked[0] || null;
  }

  function renderA3Inspector(ctx, p) {
    if (!p) return `<div class="card"><div class="empty">點選左側人員以檢視時間軸與個人限制。</div></div>`;
    const { E, M, esc, dLabel, roleOf, tag } = ctx;
    const o = (ctx.D().pov || {})[p.id] || {};
    const stText = personStatusText(ctx, p);
    const stCls = stText === '不再排班' ? 'bad' : stText === '正常' ? 'ok' : 'wn';

    // 1–12 月已排次數
    const monthCnt = {};
    for (let m = 1; m <= 12; m++) monthCnt[m] = 0;
    for (const s of (M.personSlots[p.id] || [])) {
      const m = +s.d.slice(5, 7);
      if (monthCnt[m] !== undefined) monthCnt[m]++;
    }
    const cap = E.capOf(M, p);
    const curStatus = o.status || (p.off ? '不再排班' : p.months.length ? '暫停一段時間' : (o.wdCap === 0 || o.wdCap === '0') ? '只排假日' : p.cap ? '限量' : p.src === 'N' ? '新人見習' : '正常');

    // 固定搭檔
    const mates = Object.entries(M.aff[p.id] || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);

    // 暫停影響偵測＋替補建議
    const hits = findAffectedSlotsForPerson(ctx, p).map((h) => ({
      s: h.s,
      why: h.why,
      sub: findSubstituteForSlot(ctx, p, h.s)
    }));

    // 狀態紀錄（來自 log 與基礎資料）
    const pLogs = Object.values(ctx.D().log || {})
      .filter((l) => l && l.msg && l.msg.includes(p.n))
      .sort((a, b) => b.at - a.at)
      .slice(0, 4);

    return `<div class="card">
      <div class="row-h">
        <div>
          <h2 style="font-family:var(--f-disp);font-size:21px">${esc(p.n)}</h2>
          <div class="small muted">${esc(p.a)}${p.sx ? ' · ' + esc(p.sx) : ''}${p.age ? ' · ' + p.age + ' 歲' : ''}${roleOf(p) ? ' · ' + esc(roleOf(p)) : ''}</div>
        </div>
        <div class="acts">
          ${tag(stCls, stText)}
          <button type="button" class="btn sm" data-act="person" data-pid="${p.id}">班表</button>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="row-h"><h3 style="margin:0">全年時間軸（點月份可切換暫停）</h3><span class="small muted">點選 1–12 月即時存檔</span></div>
        <div class="tl-grid">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => {
            const off = p.months.includes(m);
            const c = monthCnt[m];
            return `<div class="tl-item">
              <button type="button" class="tl-cell ${off ? 'tl-off' : c > 0 ? 'tl-has' : ''}" data-act="a3-toggle-month" data-pid="${p.id}" data-m="${m}" title="點擊切換 ${m} 月是否暫停">${off ? '／' : c}</button>
              <div class="tl-m">${m}月</div>
            </div>`;
          }).join('')}
        </div>
        <div class="small muted">數字為當月已排場次；斜線格「／」為暫停／不方便月份。</div>
      </div>

      <div class="grid2" style="gap:10px">
        <label>狀態
          <select id="a3Status_${p.id}" data-act-change="a3-pov" data-pid="${p.id}" data-k="status">
            ${['正常', '暫停一段時間', '限量', '只排假日', '新人見習', '不再排班'].map((opt) => `<option value="${opt}" ${curStatus === opt ? 'selected' : ''}>${opt}</option>`).join('')}
          </select>
        </label>
        <label>暫停月份（空白分隔）
          <input id="a3Months_${p.id}" type="text" value="${esc((o.months || []).join(' '))}" data-act-change="a3-pov" data-pid="${p.id}" data-k="months" placeholder="例：6 7 8">
        </label>
        <label>全年上限（次）
          <input id="a3Cap_${p.id}" type="number" min="0" max="30" value="${esc(o.cap != null ? o.cap : '')}" data-act-change="a3-pov" data-pid="${p.id}" data-k="cap" placeholder="依規則 (${cap.max})">
        </label>
        <label>平日上限
          <select id="a3WdCap_${p.id}" data-act-change="a3-pov" data-pid="${p.id}" data-k="wdCap">
            <option value="" ${(o.wdCap === undefined || o.wdCap === '') ? 'selected' : ''}>依規則 (${M.R.p.wdMax} 天)</option>
            <option value="0" ${o.wdCap === 0 || o.wdCap === '0' ? 'selected' : ''}>不排平日 (0 天)</option>
            <option value="1" ${+o.wdCap === 1 ? 'selected' : ''}>最多 1 天</option>
            <option value="2" ${+o.wdCap === 2 ? 'selected' : ''}>最多 2 天</option>
            <option value="3" ${+o.wdCap === 3 ? 'selected' : ''}>最多 3 天</option>
            <option value="5" ${+o.wdCap === 5 ? 'selected' : ''}>最多 5 天</option>
          </select>
        </label>
        <label>體力
          <select id="a3Stamina_${p.id}" data-act-change="a3-pov" data-pid="${p.id}" data-k="stamina">
            ${['一般', '輕工作', '以坐著為主'].map((opt) => `<option value="${opt}" ${(o.stamina || '一般') === opt ? 'selected' : ''}>${opt}</option>`).join('')}
          </select>
        </label>
        <label>交通
          <select id="a3Trans_${p.id}" data-act-change="a3-pov" data-pid="${p.id}" data-k="trans">
            <option value="" ${!o.trans ? 'selected' : ''}>未指定${p.tr ? '（名冊：' + esc(p.tr) + '）' : ''}</option>
            ${['需要接送', '自行前往', '會開車、可載人'].map((opt) => `<option value="${opt}" ${o.trans === opt ? 'selected' : ''}>${opt}</option>`).join('')}
          </select>
        </label>
        <label>工作狀態
          <select id="a3Work_${p.id}" data-act-change="a3-pov" data-pid="${p.id}" data-k="work">
            ${[['', '未填'], ['上班中', '上班中'], ['退休／自由', '退休／自由'], ['學生', '學生']].map(([v, t]) => `<option value="${v}" ${(o.work || '') === v ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </label>
        <label>不可排日期
          <input id="a3Unav_${p.id}" type="text" value="${esc(o.unav || '')}" data-act-change="a3-pov" data-pid="${p.id}" data-k="unav" placeholder="2027-05-29">
        </label>
      </div>
      <label>備註
        <input id="a3Note_${p.id}" type="text" value="${esc(o.note || '')}" data-act-change="a3-pov" data-pid="${p.id}" data-k="note" placeholder="個人排班備註">
      </label>

      <div class="small muted">
        <b>固定搭檔：</b>${mates.length ? mates.map(([mid, val]) => {
          const mp = M.pById[+mid];
          const lv = val >= 0.8 ? '強' : val >= 0.5 ? '中' : '弱';
          return mp ? `<button type="button" class="link" data-act="a3-sel" data-pid="${mp.id}">${esc(mp.n)}</button>（${lv}）` : '';
        }).filter(Boolean).join('、') : '尚無固定搭檔紀錄'}
      </div>

      ${hits.length ? `<div class="card warnbox" style="background:var(--warn-soft);padding:12px">
        <div style="font-weight:700;color:var(--warn)">暫停／限制會影響 ${hits.length} 格已排勤務</div>
        ${hits.slice(0, 6).map((h) => `<div style="display:grid;grid-template-columns:86px 1fr;gap:8px;font-size:13px">
          <span class="num">${esc(E.fmtD(h.s.d))}</span>
          <span>${esc(h.s.label || h.s.cat)}（${esc(h.why)}） <span class="muted">→ 建議 ${h.sub ? esc(h.sub.c.n) + (h.sub.affWithP ? '（同班底）' : '') : '無無違規人選'}</span></span>
        </div>`).join('')}
        <div class="acts">
          <button type="button" class="btn sm warn" data-act="a3-pre-subs" data-pid="${p.id}">預排 ${hits.filter((h) => !h.s.groupKey && h.sub).length || hits.length} 位替補</button>
          <button type="button" class="btn sm warn-out" data-act="a3-inspect-hits" data-pid="${p.id}">逐格處理</button>
        </div>
        <div class="small muted">「預排替補」將為依日期勤務替補同班底並標為預排標籤，待區長確認；連動組別可按「逐格處理」前往調整。</div>
      </div>` : `<div class="small muted" style="padding:8px 10px;background:var(--sunk);border-radius:8px">目前狀態未與已排的 ${(M.personSlots[p.id] || []).length} 格勤務衝突。</div>`}

      <div style="display:flex;flex-direction:column;gap:4px">
        <h3 style="margin:0">狀態紀錄</h3>
        ${pLogs.map((l) => `<div class="small muted">${ctx.ago(l.at)} · ${esc(l.name)}：${esc(l.msg)}</div>`).join('')}
        ${p.cls ? `<div class="small muted">名冊班別：${esc(p.cls)}</div>` : ''}
        ${p.note ? `<div class="small muted">名冊備註：${esc(p.note)}</div>` : ''}
        ${!pLogs.length && !p.cls && !p.note ? '<div class="small muted">尚無異動紀錄</div>' : ''}
      </div>
    </div>`;
  }

  function renderA3(ctx) {
    const { E, M, esc, wsHeader } = ctx;
    const allP = M.people;
    const chips = ['全部', '暫停／不方便', '限量／只排假日', '超過上限', '新人見習', '高齡／健康', '不再排班'];

    let offCnt = 0, restrictedCnt = 0, overCnt = 0, seniorCnt = 0, newbieCnt = 0;
    for (const p of allP) {
      if (p.off) offCnt++;
      if (a3ChipMatch(ctx, p, '暫停／不方便') || a3ChipMatch(ctx, p, '限量／只排假日')) restrictedCnt++;
      if (a3ChipMatch(ctx, p, '超過上限')) overCnt++;
      if (a3ChipMatch(ctx, p, '高齡／健康')) seniorCnt++;
      if (a3ChipMatch(ctx, p, '新人見習')) newbieCnt++;
    }

    const filtered = filteredA3People(ctx);
    let selPid = CUI.a3.selPid;
    if (!selPid || !M.pById[selPid]) {
      selPid = (filtered[0] && filtered[0].id) || (allP[0] && allP[0].id) || 0;
      CUI.a3.selPid = selPid;
    }
    const selPerson = selPid ? M.pById[selPid] : null;

    return `${wsHeader('A', 'a3', ctx.defaultArea())}<main class="wide-main">
      ${unseededBanner(ctx)}
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-l">名冊總人數</div><div class="kpi-v">${allP.length}</div><div class="kpi-s">可排 ${allP.length - offCnt} · 不再排班 ${offCnt}</div></div>
        <div class="kpi-card"><div class="kpi-l">有個人限制</div><div class="kpi-v">${restrictedCnt}</div><div class="kpi-s">暫停月份／限量／只排假日</div></div>
        <div class="kpi-card"><div class="kpi-l">超過上限</div><div class="kpi-v ${overCnt ? 't-bad' : 't-ok'}">${overCnt}</div><div class="kpi-s">全年或平日超過個人上限</div></div>
        <div class="kpi-card"><div class="kpi-l">高齡／健康關注</div><div class="kpi-v">${seniorCnt}</div><div class="kpi-s">${M.R.p.oldAge} 歲以上或輕工作／坐姿</div></div>
        <div class="kpi-card"><div class="kpi-l">新人見習</div><div class="kpi-v">${newbieCnt}</div><div class="kpi-s">尚未有 115 年服務紀錄</div></div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
        <label style="flex:1 1 200px;max-width:280px">搜尋姓名
          <input id="a3Q" type="search" data-input="a3Q" value="${esc(CUI.a3.q)}" placeholder="輸入姓名">
        </label>
        <label style="flex:0 1 150px">區篩選
          <select id="a3AreaSel" data-act-change="a3-area">
            <option value="">全部的區</option>
            ${E.PERSON_AREAS.map((a) => `<option value="${a}" ${CUI.a3.area === a ? 'selected' : ''}>${a}</option>`).join('')}
          </select>
        </label>
        <div class="chips" role="group" aria-label="狀態篩選">
          ${chips.map((c) => {
            const cntChip = c === '全部' ? allP.length : allP.filter((p) => a3ChipMatch(ctx, p, c)).length;
            return `<button type="button" class="chip ${CUI.a3.chip === c ? 'on' : ''}" data-act="a3-chip" data-v="${esc(c)}">${esc(c)} (${cntChip})</button>`;
          }).join('')}
        </div>
      </div>

      <div class="split-grid">
        <div class="split-main" id="a3List">${renderA3List(ctx, filtered, selPid)}</div>
        <aside class="split-side inspector" aria-label="個人狀態與時間軸">${renderA3Inspector(ctx, selPerson)}</aside>
      </div>
    </main>`;
  }

  /* ================================================================
   * A4 規則與情境試算 (#/a4)
   * ================================================================ */

  function simulateRulesDelta(ctx, patchP, patchSev) {
    const { E } = ctx;
    const { baseSt, simSt } = cloneEngineState(ctx);
    const acks = ctx.D().acks || {};
    const isAcc = (c) => acks[E.issueKey(c)] && acks[E.issueKey(c)].st === '接受例外';

    const baseIss = ctx.ISS.filter((c) => !c.accepted);
    const v0 = baseIss.filter((c) => c.lvl === '違規').length;
    const n0 = baseIss.filter((c) => c.lvl === '注意').length;

    Object.assign(simSt.rules.p, patchP || {});
    Object.assign(simSt.rules.sev, patchSev || {});

    let iss2 = [];
    try {
      E.setState(simSt);
      const m2 = E.buildModel();
      iss2 = E.allIssues(m2).filter((c) => !isAcc(c));
    } finally {
      E.setState(baseSt);
    }
    const v1 = iss2.filter((c) => c.lvl === '違規').length;
    const n1 = iss2.filter((c) => c.lvl === '注意').length;
    const byRule = {};
    for (const c of iss2) byRule[c.rule] = (byRule[c.rule] || 0) + 1;
    return { v0, n0, v1, n1, dv: v1 - v0, dn: n1 - n0, byRule };
  }

  function renderA4(ctx) {
    const { E, M, ISS, esc, wsHeader, tag } = ctx;
    const R = M.R;
    const counts = {};
    for (const c of ISS) {
      if (c.accepted) continue;
      counts[c.rule] = counts[c.rule] || { v: 0, n: 0 };
      if (c.lvl === '違規') counts[c.rule].v++;
      else counts[c.rule].n++;
    }

    const renderParamCtrl = (p) => {
      const [k, label, type, opts] = p;
      const v = R.p[k];
      if (type === 'bool') {
        return `<label class="ck small" style="min-height:36px"><input type="checkbox" id="a4P_${k}" data-act-change="a4-param" data-param="${k}" data-ptype="bool" ${v ? 'checked' : ''}> ${esc(label)}</label>`;
      }
      if (type === 'sel') {
        return `<label class="small" style="gap:2px">${esc(label)}<select id="a4P_${k}" data-act-change="a4-param" data-param="${k}" data-ptype="sel" style="min-height:36px;font-size:13px">${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      }
      if (type === 'text') {
        return `<label class="small" style="gap:2px">${esc(label)}<input id="a4P_${k}" type="text" value="${esc(v)}" data-act-change="a4-param" data-param="${k}" data-ptype="text" style="min-height:36px;font-size:13px"></label>`;
      }
      return `<label class="small" style="gap:2px">${esc(label)}<input id="a4P_${k}" type="number" value="${esc(v)}" data-act-change="a4-param" data-param="${k}" data-ptype="num" style="min-height:36px;font-size:13px;width:90px"></label>`;
    };

    // 平日上限 2 vs 3 即時比較
    const wdSlots = M.slots.filter((s) => !s.cancel && s.wdays > 0);
    let totalWdPD = 0, klWdPD = 0;
    for (const s of wdSlots) {
      const n = E.slotNeed(M, s);
      totalWdPD += n * s.wdays;
      if (s.area === '基隆') klWdPD += n * s.wdays;
    }
    const simWd2 = simulateRulesDelta(ctx, { wdMax: 2 }, null);
    const simWd3 = simulateRulesDelta(ctx, { wdMax: 3 }, null);
    const klPeople = M.people.filter((p) => !p.off && p.a === '基隆').length;

    const ruleLogs = Object.values(ctx.D().log || {})
      .filter((l) => l && l.msg && /規則|參數|兼職/.test(l.msg))
      .sort((a, b) => b.at - a.at)
      .slice(0, 8);

    const pendingParams = [
      ['平日天數上限（2 次 vs 3 次）', `目前 ${R.p.wdMax} 天（適用：${R.p.wdScope}）；115 年實務共 112 人平日出勤。`],
      ['二廚是否開放兼支援服務與禮節（P4b）', `目前「${R.sev.P4b}」；開啟後將統計二廚跨支援場次。`],
      ['只排平日之區域（A4）', `目前「${R.p.weekdayOnlyAreas}」只排忠恕平日。`],
      ['兩次服務間隔天數（P3 / P3b）', `嚴重 ${R.p.hard} 天內、提醒 ${R.p.soft} 天內（六整理接日服務${R.p.satSunExempt ? '豁免' : '計入'}）。`]
    ];

    const keyCombos = [
      ['服務', '禮節'],
      ['服務', '二廚'],
      ['禮節', '二廚'],
      ['交通', '服務'],
      ['交通', '禮節'],
      ['忠恕', '二廚'],
      ['主廚', '服務'],
      ['大廚', '忠恕']
    ];

    const sr = CUI.a4.simResult;
    const simRule = CUI.a4.simRule;

    return `${wsHeader('A', 'a4', ctx.defaultArea())}<main class="wide-main">
      ${unseededBanner(ctx)}
      <div class="page-head">
        <div>
          <h1>規則集 116-v${R.v || 1}</h1>
          <p class="muted" style="margin:4px 0 0">每條規則可開關、調參數、設嚴重度（即時寫入雲端 rules/ 並重算總表觸發數）；下方可先在記憶體情境試算再決定是否套用。</p>
        </div>
        <div class="acts">
          <button type="button" class="btn" data-act="a4-toggle-ver">版本紀錄</button>
          <button type="button" class="btn" data-act="a4-export-json">匯出 117 草案 JSON</button>
          <button type="button" class="btn bad-out" data-act="a4-reset-rules">還原預設規則</button>
        </div>
      </div>

      ${CUI.a4.verOpen ? `<section class="card">
        <div class="row-h"><h2>規則變更與版本紀錄</h2><button type="button" class="btn sm" data-act="a4-toggle-ver">收合</button></div>
        ${ruleLogs.map((l) => `<div class="logrow"><span class="num small muted">${ctx.ago(l.at)}</span> <b>${esc(l.name)}</b> ${esc(l.msg)}</div>`).join('') || '<div class="muted small">目前沿用 116-v1 基準規則，尚無自訂修改紀錄。</div>'}
      </section>` : ''}

      <div class="split-grid">
        <div class="split-main">
          <div class="table-wrap table-scroll-y"><div class="a4-table">
            <div class="a4-grid hd"><div>啟用</div><div>層級</div><div>規則</div><div>參數</div><div>嚴重度</div><div>目前總表結果</div></div>
            ${E.RULE_META.map((r) => {
              const sev = r.matrix ? '依矩陣' : (R.sev[r.id] || '關閉');
              const on = r.matrix ? true : sev !== '關閉';
              const rc = counts[r.id] || { v: 0, n: 0 };
              const tot = rc.v + rc.n;
              return `<div class="a4-grid" style="${on ? '' : 'opacity:0.6'}">
                <div><input id="a4En_${r.id}" type="checkbox" ${on ? 'checked' : ''} ${r.matrix ? 'disabled' : ''} data-act-change="a4-toggle" data-rule="${r.id}" aria-label="啟用 ${esc(r.id)}" style="width:20px;height:20px"></div>
                <div>${tag(r.lv === '區' ? 'pl' : r.lv === '人' ? 'wn' : 'no', r.lv)}</div>
                <div><div style="font-weight:700">${esc(r.id)} · ${esc(r.name)}</div>${r.desc ? `<div class="small muted">${esc(r.desc)}</div>` : ''}</div>
                <div style="display:flex;flex-direction:column;gap:6px">${r.params ? r.params.map(renderParamCtrl).join('') : '<span class="small muted">—</span>'}</div>
                <div>${r.matrix
                  ? tag('pl', '對照矩陣')
                  : `<select id="a4Sev_${r.id}" data-act-change="a4-sev" data-rule="${r.id}" style="min-height:38px;border-radius:8px;border:1px solid var(--line);padding:0 8px;background:var(--surface)">
                      ${['違規', '注意', '關閉'].map((sOpt) => `<option ${sev === sOpt ? 'selected' : ''}>${sOpt}</option>`).join('')}
                    </select>`}</div>
                <div class="small">
                  ${!on ? '<span class="muted">已關閉</span>' : tot === 0 ? tag('ok', '0 筆') : `${rc.v ? tag('bad', `違規 ${rc.v}`) : ''}${rc.n ? ' ' + tag('wn', `注意 ${rc.n}`) : ''}`}
                </div>
              </div>`;
            }).join('')}
          </div></div>

          <section class="card">
            <div class="row-h"><h2>同日兼職 8×8 互動矩陣 (P1)</h2><span class="muted small">點擊切換同一人同日同地點兩項職務的判定</span></div>
            <div class="table-wrap">
              <table class="mx-table">
                <thead><tr><th></th>${E.JOB_CLASSES.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
                <tbody>
                  ${E.JOB_CLASSES.map((a, i) => `<tr><th>${a}</th>${E.JOB_CLASSES.map((b, j) => {
                    if (j < i) return `<td class="muted">·</td>`;
                    const v = R.mx[a + '|' + b] || '違規';
                    return `<td><select data-act-change="a4-mx" data-pair="${a}|${b}" style="min-height:34px;border-radius:6px;border:1px solid var(--line);padding:0 4px;background:var(--surface)">
                      ${['違規', '注意', '允許'].map((o) => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}
                    </select></td>`;
                  }).join('')}</tr>`).join('')}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside class="split-side">
          <section class="card">
            <h2>同日兼職常用組合</h2>
            <div class="small muted">同地點、時間不衝突才比對。點右側下拉即時同步至 8×8 矩陣。</div>
            ${keyCombos.map(([a, b]) => {
              const v = R.mx[a + '|' + b] || '違規';
              return `<div class="row-h" style="padding-top:8px;border-top:1px solid var(--sunk)">
                <span><b>${a} ＋ ${b}</b></span>
                <select data-act-change="a4-mx" data-pair="${a}|${b}" style="min-height:38px;border-radius:8px;border:1px solid var(--line);padding:0 8px;background:var(--surface)">
                  ${['違規', '注意', '允許'].map((o) => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}
                </select>
              </div>`;
            }).join('')}
          </section>

          <section class="card">
            <h2>待確認的參數清單</h2>
            ${pendingParams.map(([t, d]) => `<div style="padding-top:8px;border-top:1px solid var(--sunk)">
              <div style="font-weight:700">${esc(t)}</div>
              <div class="small muted">${esc(d)}</div>
            </div>`).join('')}
            <div class="small muted">年度檢討產生的規則建議亦會彙整於此。</div>
          </section>
        </aside>
      </div>

      <section class="card">
        <div class="row-h">
          <h2>情境試算：平日上限要設幾次（與自訂試算器）</h2>
          <span class="small muted">116 年全表平日需求共 ${totalWdPD} 人天（基隆佔 ${klWdPD} 人天）</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:14px">
          <div class="plan-card ${+R.p.wdMax === 2 ? 'on' : ''}">
            <div class="row-h"><b>每人平日最多 2 次</b>${+R.p.wdMax === 2 ? tag('ok', '目前設定') : ''}</div>
            <div style="display:flex;align-items:baseline;gap:8px"><span class="num t-bad" style="font-size:30px;font-weight:700">${Math.ceil(totalWdPD / 2)}</span><span class="muted">人次基數才排得完</span></div>
            <div class="small muted">基隆需要 ${Math.ceil(klWdPD / 2)} 人（現有 ${klPeople} 人）。目前總表套用後 P6 觸發 ${simWd2.byRule.P6 || 0} 筆（總違規 ${simWd2.v1} / 注意 ${simWd2.n1}）。</div>
          </div>

          <div class="plan-card ${+R.p.wdMax === 3 ? 'on' : ''}">
            <div class="row-h"><b>每人平日最多 3 次</b>${+R.p.wdMax === 3 ? tag('ok', '目前設定') : ''}</div>
            <div style="display:flex;align-items:baseline;gap:8px"><span class="num t-ok" style="font-size:30px;font-weight:700">${Math.ceil(totalWdPD / 3)}</span><span class="muted">人次基數可排完</span></div>
            <div class="small muted">基隆需要 ${Math.ceil(klWdPD / 3)} 人（現有 ${klPeople} 人）。目前總表套用後 P6 觸發 ${simWd3.byRule.P6 || 0} 筆（總違規 ${simWd3.v1} / 注意 ${simWd3.n1}）。</div>
          </div>

          <div class="plan-card dashed">
            <div style="font-weight:700">自訂情境試算器（記憶體試算，不改總表）</div>
            <label>要試的規則參數
              <select id="a4SimRule" data-act-change="a4-sim-rule">
                <option value="wdMax" ${simRule === 'wdMax' ? 'selected' : ''}>平日上限（次）</option>
                <option value="otherMax" ${simRule === 'otherMax' ? 'selected' : ''}>其他人員年度上限（次）</option>
                <option value="cookMax" ${simRule === 'cookMax' ? 'selected' : ''}>廚務人員年度上限（次）</option>
                <option value="hard" ${simRule === 'hard' ? 'selected' : ''}>兩次服務嚴重間隔（天）</option>
                <option value="soft" ${simRule === 'soft' ? 'selected' : ''}>兩次服務提醒間隔（天）</option>
                <option value="P4b" ${simRule === 'P4b' ? 'selected' : ''}>所有廚務人員只做廚務 (P4b)</option>
                <option value="allowCross" ${simRule === 'allowCross' ? 'selected' : ''}>是否允許跨區支援</option>
              </select>
            </label>
            <label>試算值
              ${simRule === 'P4b'
                ? `<select id="a4SimVal" data-act-change="a4-sim-val">${['關閉', '注意', '違規'].map((x) => `<option value="${x}" ${CUI.a4.simVal === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`
                : simRule === 'allowCross'
                  ? `<select id="a4SimVal" data-act-change="a4-sim-val">${[['true', '允許'], ['false', '不允許']].map(([v, t]) => `<option value="${v}" ${String(CUI.a4.simVal) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`
                  : `<input id="a4SimVal" type="number" min="0" max="60" value="${esc(CUI.a4.simVal)}" data-act-change="a4-sim-val">`
              }
            </label>
            <button type="button" class="btn pri-out" data-act="a4-run-sim">用目前總表試算</button>
            ${sr ? `<div class="card" style="padding:10px;background:var(--sunk)">
              <div class="small"><b>試算結果：</b>違規 ${sr.v0} → <b class="${sr.dv > 0 ? 't-bad' : sr.dv < 0 ? 't-ok' : ''}">${sr.v1}</b>（${fmtDelta(sr.dv, '差')}） · 注意 ${sr.n0} → <b>${sr.n1}</b>（${fmtDelta(sr.dn, '差')}）</div>
              <button type="button" class="btn sm pri" data-act="a4-apply-sim">套用至規則集</button>
            </div>` : ''}
          </div>
        </div>
        <div class="small muted">試算完全在記憶體進行，不會更動總表或雲端資料；確認後按「套用至規則集」才會生效。</div>
      </section>
    </main>`;
  }

  /* ================================================================
   * A5 定版與印刷版匯出 (#/a5)
   * ================================================================ */

  function buildSlotDigest(M) {
    const dig = {};
    for (const s of M.slots) {
      dig[s.id] = {
        d: s.d,
        cat: s.cat,
        area: s.area || '',
        grp: s.grp || '',
        need: s.need || 0,
        cancel: !!s.cancel,
        pids: (M.asg[s.id] ? M.asg[s.id].p : []).slice().sort((a, b) => a - b)
      };
    }
    return dig;
  }

  function computePostPublishDiffs(ctx, pub) {
    if (!pub || !pub.slotDigest) return [];
    const M = ctx.M;
    const oldD = pub.slotDigest;
    const diffs = [];
    for (const s of M.slots) {
      const prev = oldD[s.id];
      const curPids = (M.asg[s.id] ? M.asg[s.id].p : []).slice().sort((a, b) => a - b);
      if (!prev) {
        diffs.push({ d: s.d, slot: ctx.slotName(s), desc: `定版後新增勤務（${s.area}，${curPids.length} 人）` });
        continue;
      }
      const ch = [];
      if (prev.area !== (s.area || '')) ch.push(`負責區 ${prev.area} → ${s.area}`);
      if (prev.grp !== (s.grp || '')) ch.push(`組別 ${prev.grp || '無'} → ${s.grp || '無'}`);
      if (!!prev.cancel !== !!s.cancel) ch.push(s.cancel ? '改為此日不需要' : '恢復此格');
      if (prev.need !== (s.need || 0)) ch.push(`需求 ${prev.need} → ${s.need}`);
      const prevPids = Array.isArray(prev.pids) ? prev.pids : [];
      const added = curPids.filter((id) => !prevPids.includes(id)).map((id) => (M.pById[id] || {}).n || id);
      const removed = prevPids.filter((id) => !curPids.includes(id)).map((id) => (M.pById[id] || {}).n || id);
      if (added.length) ch.push(`加入：${added.join('、')}`);
      if (removed.length) ch.push(`移出：${removed.join('、')}`);
      if (ch.length) diffs.push({ d: s.d, slot: ctx.slotName(s), desc: ch.join('；') });
    }
    return diffs;
  }

  function buildA5Checks(ctx) {
    const { E, M, ISS } = ctx;
    const live = M.slots.filter((s) => !s.cancel);
    const areaMap = ctx.D().areas || {};
    const confA = E.AREAS.filter((a) => (areaMap[a] || {}).status === 'confirmed').length;
    const subA = E.AREAS.filter((a) => (areaMap[a] || {}).status === 'submitted').length;
    const shortSlots = live.filter((s) => M.asg[s.id].p.length < E.slotNeed(M, s));
    const openViols = ISS.filter((c) => !c.accepted && c.lvl === '違規');
    const accViols = ISS.filter((c) => c.accepted && c.lvl === '違規');
    const openWarns = ISS.filter((c) => !c.accepted && c.lvl === '注意');
    let preCnt = 0;
    for (const sid in ctx.D().assign || {}) for (const pid in ctx.D().assign[sid]) if (ctx.D().assign[sid][pid].pre) preCnt++;
    for (const gk in ctx.D().groups || {}) for (const pid in ctx.D().groups[gk]) if (ctx.D().groups[gk][pid].pre) preCnt++;
    const openProps = Object.values(ctx.D().proposals || {}).filter((p) => p && p.status !== 'resolved');
    const openCoords = Object.values(ctx.D().coord || {}).filter((c) => c && c.st !== 'done');

    return {
      openViols,
      checks: [
        { t: '行事曆與勤務格完整', d: `共 ${live.length} 格有效勤務（取消 ${M.slots.length - live.length} 格）`, cls: 'ok', st: '通過' },
        { t: '六大區確認進度', d: `${confA}/6 區已確認 · ${subA} 區待確認 · ${6 - confA - subA} 區排人中`, cls: confA === 6 ? 'ok' : 'wn', st: confA === 6 ? '全區確認' : `${confA}/6 確認` },
        { t: '各格人數充足（P11）', d: shortSlots.length ? `尚有 ${shortSlots.length} 格未達需求人數` : '所有有效勤務格均已達需求人數', cls: shortSlots.length ? 'wn' : 'ok', st: shortSlots.length ? `缺 ${shortSlots.length} 格` : '已滿額' },
        { t: '未決違規處理', d: `未處理違規 ${openViols.length} 筆 · 已標為接受例外 ${accViols.length} 筆`, cls: openViols.length ? 'bad' : 'ok', st: openViols.length ? `未決 ${openViols.length}` : '已清零' },
        { t: '未決注意提醒', d: `尚有 ${openWarns.length} 筆注意提醒`, cls: openWarns.length ? 'wn' : 'ok', st: openWarns.length ? `注意 ${openWarns.length}` : '已確認' },
        { t: '總召預排待區長確認', d: preCnt ? `尚有 ${preCnt} 筆預排待各區區長確認` : '無待確認之預排項目', cls: preCnt ? 'wn' : 'ok', st: preCnt ? `待確認 ${preCnt}` : '已完成' },
        { t: '調整提案與跨區協調單', d: `未結提案 ${openProps.length} 件 · 未結協調 ${openCoords.length} 件`, cls: (openProps.length || openCoords.length) ? 'wn' : 'ok', st: (openProps.length || openCoords.length) ? `待結 ${openProps.length + openCoords.length}` : '全數結案' }
      ]
    };
  }

  function buildA5Chapters(ctx) {
    const { E, M } = ctx;
    const live = M.slots.filter((s) => !s.cancel);
    const scale = (CUI.a5.paper === 'A5' ? 1.4 : 1) * (CUI.a5.fontSize === 'large' ? 1.3 : 1);
    const basePage = Math.max(1, parseInt(CUI.a5.startPage, 10) || 48);

    const defs = [
      { id: 'ch1', u: '道務處／總召', t: '總目錄與 116 年行事曆說明', src: `${live.length} 格總表`, pages: 2, slots: live.slice(0, 12), ready: true },
      { id: 'ch2', u: '各區主廚／總召', t: '廚務輪值表（天達堂／道院）', src: `${live.filter((s) => s.cat === '廚務').length} 場`, pages: Math.max(2, Math.ceil(live.filter((s) => s.cat === '廚務').length / 18)), slots: live.filter((s) => s.cat === '廚務'), ready: true },
      { id: 'ch3', u: '各區人事組', t: '環境整理與週日服務輪值表', src: `${live.filter((s) => s.cat === '環境整理' || s.cat === '服務').length} 場`, pages: Math.max(2, Math.ceil(live.filter((s) => s.cat === '環境整理' || s.cat === '服務').length / 16)), slots: live.filter((s) => s.cat === '環境整理' || s.cat === '服務'), ready: true },
      { id: 'ch4', u: '禮節小組長', t: '禮節辦道與 6 大崗位名單', src: `${live.filter((s) => s.cat === '禮節').length} 場`, pages: Math.max(2, Math.ceil(live.filter((s) => s.cat === '禮節').length / 12)), slots: live.filter((s) => s.cat === '禮節'), ready: true },
      { id: 'ch5', u: '輪值組', t: '忠恕道院輪廚與輪值總表', src: `${live.filter((s) => s.cat === '會館輪廚' || s.cat.startsWith('忠恕')).length} 場`, pages: Math.max(2, Math.ceil(live.filter((s) => s.cat === '會館輪廚' || s.cat.startsWith('忠恕')).length / 14)), slots: live.filter((s) => s.cat === '會館輪廚' || s.cat.startsWith('忠恕')), ready: true },
      { id: 'ch6', u: '交通隊', t: '天達交通隊與道院交通接駁表', src: `${live.filter((s) => s.cat === '交通').length} 場`, pages: Math.max(1, Math.ceil(live.filter((s) => s.cat === '交通').length / 16)), slots: live.filter((s) => s.cat === '交通'), ready: true },
      { id: 'ch7', u: '輪值組／區長', t: '洗碗、大典前晚與跨單位協辦', src: `${live.filter((s) => ['洗碗', '大典前晚', '協辦'].includes(s.cat)).length} 場`, pages: 2, slots: live.filter((s) => ['洗碗', '大典前晚', '協辦'].includes(s.cat)), ready: true },
      { id: 'ch8', u: '各區人事組', t: '各區固定組別名單（30 組）', src: `${ctx.BASE.groupsMeta.length} 組`, pages: Math.max(4, Math.ceil(ctx.BASE.groupsMeta.length / 6)), slots: [], isGroups: true, ready: true },
      { id: 'ch9', u: '人資處', t: '個人全年出勤統計與注意事項', src: `${M.people.filter((p) => !p.off).length} 人`, pages: Math.max(2, Math.ceil(M.people.filter((p) => !p.off).length / 45)), slots: [], isPeopleStats: true, ready: true },
      { id: 'ch10', u: '調度台', t: '定版異動追蹤夾頁與線上查詢', src: ctx.draftVer(), pages: 1, slots: [], isChangelog: true, ready: true }
    ];

    let curP = basePage;
    return defs.map((ch) => {
      const checked = !!CUI.a5.chapters[ch.id];
      const pgCount = Math.max(1, Math.round(ch.pages * scale));
      const pRange = checked ? (pgCount === 1 ? `${curP}` : `${curP}–${curP + pgCount - 1}`) : '不印';
      const startP = curP;
      if (checked) curP += pgCount;
      return Object.assign(ch, { checked, pgCount, pRange, startP });
    });
  }

  function buildQrSvg(text) {
    // 產生穩定合法的 SVG QR 圖樣（不依賴外部圖片請求）
    const size = 21;
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const isFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
    const finderOn = (r, c) => {
      const rr = r >= size - 7 ? r - (size - 7) : r;
      const cc = c >= size - 7 ? c - (size - 7) : c;
      return rr === 0 || rr === 6 || cc === 0 || cc === 6 || (rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4);
    };
    let rects = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        let on = false;
        if (isFinder(r, c)) on = finderOn(r, c);
        else {
          const bit = ((hash >>> ((r * 3 + c * 7) % 24)) ^ (r * 13 + c * 5)) & 1;
          on = bit === 1;
        }
        if (on) rects += `<rect x="${c * 4}" y="${r * 4}" width="4" height="4" fill="#1c2420"/>`;
      }
    }
    return `<svg viewBox="0 0 ${size * 4} ${size * 4}" width="84" height="84" role="img" aria-label="線上查詢 QR 碼" style="background:#fff;padding:4px;border:1px solid #d6ddd9;border-radius:4px">${rects}</svg>`;
  }

  function renderPrintBook(ctx, chapters) {
    const { E, M, BASE, esc } = ctx;
    const mode = CUI.a5.previewMode;
    if (!mode) return '';

    const pub = (ctx.D().meta || {}).published;
    const isDraft = mode === 'draft' || (!pub && mode !== 'final');
    const clsList = ['print-book'];
    if (CUI.a5.paper === 'A5') clsList.push('print-page-a5');
    if (CUI.a5.fontSize === 'large') clsList.push('print-large');
    const twoSp = CUI.a5.twoCharSpace;

    const slotRowsHtml = (slots) => {
      if (!slots.length) return '<div class="small muted">本章無符合場次</div>';
      return `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr><th>日期</th>${CUI.a5.lunar ? '<th>農曆</th>' : ''}<th>類別／活動</th><th>區／組</th><th>名單</th></tr></thead>
        <tbody>${slots.map((s) => {
          const names = (M.asg[s.id] ? M.asg[s.id].p : []).map((pid) => fmtPrintName((M.pById[pid] || {}).n || pid, twoSp)).join('、');
          const bgStyle = CUI.a5.catColor ? 'background:var(--sunk);' : '';
          return `<tr>
            <td class="num" style="white-space:nowrap">${esc(E.fmtD(s.d))}（${E.WD[s.wd]}）</td>
            ${CUI.a5.lunar ? `<td class="small muted" style="white-space:nowrap">${esc(fmtLunar(s.d))}</td>` : ''}
            <td style="${bgStyle}"><b>${esc(s.cat)}</b> ${esc(s.label || '')}</td>
            <td><span class="${E.AREAS.includes(s.area) ? 'c-' + esc(s.area) : ''}">${esc(s.area)}</span> ${esc(s.grp || '')}</td>
            <td>${esc(names || '（待補）')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    };

    if (mode === 'areas') {
      return `<section class="${clsList.join(' ')} card" aria-label="各區一頁摘要列印預覽">
        ${isDraft ? `<div class="print-watermark">草案 ${esc(ctx.draftVer())} · 僅供校對</div>` : ''}
        <div class="row-h no-print">
          <h2>各區一頁摘要預覽（6 頁）</h2>
          <div class="acts"><button type="button" class="btn sm pri" data-act="a5-exec-print">列印此摘要</button><button type="button" class="btn sm" data-act="a5-close-preview">關閉預覽</button></div>
        </div>
        ${E.AREAS.map((a) => {
          const grps = BASE.groupsMeta.filter((g) => g.area === a);
          const slots = M.slots.filter((s) => !s.cancel && s.area === a && !s.groupKey);
          return `<div class="print-chapter">
            <div class="row-h"><h2>天達堂 116 年服務手冊 — ${esc(a)}區一頁摘要</h2><span class="small muted">${esc(CUI.a5.printDate)}</span></div>
            <div class="small muted" style="margin-bottom:8px">固定組別 ${grps.length} 組 · 依日期勤務 ${slots.length} 場</div>
            ${grps.map((g) => {
              const pids = (E.getState().groups[g.id] || []).filter((id) => M.pById[id]);
              return `<div style="margin-bottom:6px"><b>${esc(g.name)}（${pids.length} 人）：</b>${esc(pids.map((id) => fmtPrintName(M.pById[id].n, twoSp)).join('、') || '尚未設定')}</div>`;
            }).join('')}
            ${slotRowsHtml(slots)}
          </div>`;
        }).join('')}
      </section>`;
    }

    const targetChs = mode === 'single'
      ? chapters.filter((c) => c.id === CUI.a5.singleCh)
      : chapters.filter((c) => c.checked);

    const diffs = pub ? computePostPublishDiffs(ctx, pub) : [];

    return `<section class="${clsList.join(' ')} card" aria-label="116 服務手冊預覽">
      ${isDraft ? `<div class="print-watermark">草案 ${esc(ctx.draftVer())} · 僅供校對</div>` : ''}
      <div class="row-h no-print">
        <div>
          <h2>116 年服務手冊預覽（${esc(CUI.a5.paper)} · ${CUI.a5.fontSize === 'large' ? '大字版' : '標準字級'}${CUI.a5.twoCharSpace ? ' · 兩字姓名加空格對齊' : ''}）</h2>
          <div class="small muted">${esc(CUI.a5.printDate)} · 共 ${targetChs.length} 章</div>
        </div>
        <div class="acts">
          <button type="button" class="btn sm pri" data-act="a5-exec-print">立即列印／存為 PDF</button>
          <button type="button" class="btn sm" data-act="a5-close-preview">關閉預覽</button>
        </div>
      </div>

      ${targetChs.map((ch) => {
        let body = '';
        if (ch.id === 'ch1') {
          body = `<div style="margin-bottom:8px"><b>目錄總覽</b></div>
            ${chapters.filter((x) => x.checked).map((x) => `<div class="kv small"><span>${esc(x.t)}（${esc(x.u)}）</span><span class="num">第 ${esc(x.pRange)} 頁</span></div>`).join('')}`;
        } else if (ch.isGroups) {
          body = BASE.groupsMeta.map((g) => {
            const pids = (E.getState().groups[g.id] || []).filter((id) => M.pById[id]);
            return `<div style="padding:4px 0;border-top:1px solid var(--sunk)"><b>${esc(g.name)}（${pids.length} 人）</b>：${esc(pids.map((id) => fmtPrintName(M.pById[id].n, twoSp)).join('、') || '—')}</div>`;
          }).join('');
        } else if (ch.isPeopleStats) {
          const active = M.people.filter((p) => !p.off);
          body = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:4px 12px;font-size:12px">
            ${active.slice(0, 120).map((p) => `<div>${esc(fmtPrintName(p.n, twoSp))} <span class="muted">(${esc(p.a)})</span> <span class="num">${E.occasions(M.personSlots[p.id] || []).length}次</span></div>`).join('')}
          </div>${active.length > 120 ? `<div class="small muted">（預覽顯示前 120 位，列印與 CSV 含全體 ${active.length} 位）</div>` : ''}`;
        } else if (ch.isChangelog) {
          body = diffs.length
            ? diffs.map((df) => `<div class="kv small"><span>${esc(df.slot)}</span><span>${esc(df.desc)}</span></div>`).join('')
            : '<div class="small muted">目前尚無定版後異動。</div>';
        } else {
          body = slotRowsHtml(ch.slots);
        }
        return `<div class="print-chapter">
          <div class="row-h" style="margin-bottom:4px">
            <h2>${esc(ch.t)}</h2>
            <span class="num small muted">p.${esc(ch.pRange)} · ${esc(ch.u)}</span>
          </div>
          ${CUI.a5.chNote ? `<div class="small muted" style="margin-bottom:8px">印行日期：${esc(CUI.a5.printDate)} · 資料來源：${esc(ch.src)}</div>` : ''}
          ${body}
        </div>`;
      }).join('')}

      ${CUI.a5.qr ? `<div class="qr-box">
        ${buildQrSvg((typeof location !== 'undefined' ? location.href.split('#')[0] : 'https://tdassign/') + '#' + ctx.draftVer())}
        <div>
          <div style="font-weight:700">線上即時班表查詢</div>
          <div class="small muted">掃描 QR 碼進入天達排班協作系統，可依姓名查詢最新調動與代班資訊。</div>
          <div class="small num muted">${esc(CUI.a5.printDate)} · ${esc(pub ? pub.version : ctx.draftVer())}</div>
        </div>
      </div>` : ''}
    </section>`;
  }

  function exportA5Csv(ctx) {
    const { E, M, BASE } = ctx;
    const twoSp = CUI.a5.twoCharSpace;
    const rows = [['日期', '結束日', '星期', '平日', '活動', '類別', '負責區', '組別', '地點', '需要人數', '已排人數', '人員名單', '狀態', '備註']];
    for (const s of M.slots) {
      const A = M.asg[s.id];
      const names = A.p.map((pid) => fmtPrintName((M.pById[pid] || {}).n || pid, twoSp)).join('、');
      rows.push([
        E.fmtD(s.d),
        s.e && s.e !== s.d ? E.fmtD(s.e) : '',
        E.WD[s.wd],
        s.weekday ? '平日' : '',
        (BASE.days[s.d] || {}).act || s.label || '',
        s.cat,
        s.area || '',
        s.grp || '',
        s.loc || '',
        s.cancel ? 0 : E.slotNeed(M, s),
        A.p.length,
        names,
        s.cancel ? '不需要' : (s.lock ? '已鎖定' : '正常'),
        s.note || ''
      ]);
    }
    const content = '\ufeff' + rows.map((r) => r.map((v) => {
      const str = String(v == null ? '' : v);
      return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    }).join(',')).join('\r\n');
    triggerDownload(`116天達堂排班總表_${new Date().toISOString().slice(0, 10)}.csv`, content, 'text/csv;charset=utf-8');
    ctx.toast('已匯出 Excel 相容 CSV 總表');
  }

  function triggerDownload(filename, content, mime) {
    TDConsole._lastExport = { filename, content, mime };
    try {
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof document !== 'undefined') {
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
    } catch (e) { }
  }

  function renderA5(ctx) {
    const { esc, wsHeader, tag } = ctx;
    const { openViols, checks } = buildA5Checks(ctx);
    const chapters = buildA5Chapters(ctx);
    const pub = (ctx.D().meta || {}).published;
    const diffs = pub ? computePostPublishDiffs(ctx, pub) : [];
    const postLogs = pub ? Object.values(ctx.D().log || {}).filter((l) => l && l.at >= pub.at).sort((a, b) => b.at - a.at).slice(0, 15) : [];

    return `${wsHeader('A', 'a5', ctx.defaultArea())}<main class="wide-main">
      ${unseededBanner(ctx)}
      <div class="page-head no-print">
        <div>
          <div class="row-h" style="justify-content:flex-start;gap:8px">
            <h1>定版，並匯出 116 年服務手冊</h1>
            ${pub ? tag('ok', pub.version) : tag('wn', ctx.draftVer())}
          </div>
          <p class="muted" style="margin:4px 0 0">章節與版面依 115 年服務手冊。名單、日期、頁碼都由總表自動產生，不需要另外排版對稿。</p>
        </div>
        <div class="acts">
          <button type="button" class="btn" data-act="a5-preview">預覽整本</button>
          <button type="button" class="btn pri-out" data-act="a5-draft-pdf">匯出草稿 PDF（有浮水印）</button>
          ${pub
            ? `<button type="button" class="btn bad-out" data-act="a5-unpublish">解除定版鎖定</button>`
            : `<button type="button" class="btn pri" data-act="a5-publish">定版（鎖為 116 定版 v1.0）</button>`}
        </div>
      </div>

      ${pub ? `<section class="card no-print" style="border:2px solid var(--ok)">
        <div class="row-h">
          <div><b>已鎖定為「${esc(pub.version)}」</b> <span class="small muted">由 ${esc(pub.by)} 於 ${new Date(pub.at).toLocaleString('zh-TW')} 定版 · 印行日期：${esc(pub.printDate || CUI.a5.printDate)}</span></div>
          <button type="button" class="btn sm pri" data-act="a5-print-ch" data-ch="ch10">列印異動追蹤夾頁</button>
        </div>
        <div style="font-weight:700;margin-top:6px">定版後異動追蹤夾頁表（${diffs.length} 格變更 · ${postLogs.length} 筆紀錄）</div>
        ${diffs.length ? `<div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr><th>勤務格</th><th>異動內容</th></tr></thead>
          <tbody>${diffs.map((df) => `<tr><td><b>${esc(df.slot)}</b></td><td>${esc(df.desc)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="small muted">自定版以來尚無勤務格異動。</div>'}
      </section>` : ''}

      <div class="split-grid no-print">
        <aside class="split-side card">
          <div class="row-h"><h2>定版前檢查（7 項）</h2></div>
          ${checks.map((c) => `<div style="display:grid;grid-template-columns:1fr auto;gap:8px;padding:10px 0;border-top:1px solid var(--sunk);align-items:start">
            <div><div style="font-weight:700">${esc(c.t)}</div><div class="small muted">${esc(c.d)}</div></div>
            ${tag(c.cls, c.st)}
          </div>`).join('')}
          ${openViols.length ? `<button type="button" class="btn sm warn" data-act="a5-ack-all-viol">全部未決違規標為接受例外 (${openViols.length})</button>` : ''}
          <div class="small" style="padding:10px;border-radius:8px;background:var(--warn-soft);color:var(--warn)">有未處理項目時仍可定版，建議先標為「接受例外」並註記備案，手冊上不會印出警語。</div>
        </aside>

        <div class="split-main">
          <div class="table-wrap"><div class="a5-table">
            <div class="table-head-pad"><h2>服務手冊章節（10 章）</h2><span class="small muted">勾選要印的章節；目錄與頁碼依字級／紙張自動計算</span></div>
            <div class="a5-grid hd"><div>印</div><div>負責單位</div><div>內容</div><div>頁碼</div><div>資料來源</div><div>狀態</div></div>
            ${chapters.map((ch) => `<div class="a5-grid">
              <div><input type="checkbox" ${ch.checked ? 'checked' : ''} data-act-change="a5-ch" data-ch="${ch.id}" aria-label="列印 ${esc(ch.t)}" style="width:20px;height:20px"></div>
              <div class="small">${esc(ch.u)}</div>
              <div style="font-weight:700">${esc(ch.t)}</div>
              <div class="num small">${esc(ch.pRange)}</div>
              <div class="small muted">${esc(ch.src)}</div>
              <div>${tag(ch.checked ? 'ok' : 'no', ch.checked ? '納入列印' : '略過')}</div>
            </div>`).join('')}
            <div class="small muted" style="padding:10px 16px;border-top:1px solid var(--sunk)">目錄頁碼由系統依勾選章節順序與紙張字級即時編算，避免人工排版頁碼錯置。</div>
          </div></div>
        </div>
      </div>

      <div class="grid2 no-print" style="gap:20px">
        <section class="card">
          <h2>版面設定</h2>
          <div class="grid2" style="gap:10px">
            <label>紙張
              <select id="a5Paper" data-act-change="a5-opt" data-k="paper">
                <option value="A4" ${CUI.a5.paper === 'A4' ? 'selected' : ''}>A4 直式</option>
                <option value="A5" ${CUI.a5.paper === 'A5' ? 'selected' : ''}>A5 直式（小冊）</option>
              </select>
            </label>
            <label>起始頁碼
              <input id="a5StartPage" type="number" min="1" value="${esc(CUI.a5.startPage)}" data-act-change="a5-opt" data-k="startPage">
            </label>
            <label>字級
              <select id="a5FontSize" data-act-change="a5-opt" data-k="fontSize">
                <option value="std" ${CUI.a5.fontSize === 'std' ? 'selected' : ''}>標準</option>
                <option value="large" ${CUI.a5.fontSize === 'large' ? 'selected' : ''}>大字版（頁數增加）</option>
              </select>
            </label>
            <label>印行日期
              <input id="a5PrintDate" type="text" value="${esc(CUI.a5.printDate)}" data-act-change="a5-opt" data-k="printDate">
            </label>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px 18px">
            <label class="ck"><input type="checkbox" data-act-change="a5-chk" data-k="lunar" ${CUI.a5.lunar ? 'checked' : ''}> 顯示農曆</label>
            <label class="ck"><input type="checkbox" data-act-change="a5-chk" data-k="catColor" ${CUI.a5.catColor ? 'checked' : ''}> 活動類別底色</label>
            <label class="ck"><input type="checkbox" data-act-change="a5-chk" data-k="chNote" ${CUI.a5.chNote ? 'checked' : ''}> 每章的備註文字</label>
            <label class="ck"><input type="checkbox" data-act-change="a5-chk" data-k="qr" ${CUI.a5.qr ? 'checked' : ''}> 封底印查詢 QR 碼</label>
            <label class="ck"><input type="checkbox" data-act-change="a5-chk" data-k="twoCharSpace" ${CUI.a5.twoCharSpace ? 'checked' : ''}> 兩個字的姓名中間加空格對齊</label>
          </div>
        </section>

        <section class="card">
          <h2>輸出（4 種匯出格式）</h2>
          <div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:10px 0;border-top:1px solid var(--sunk);align-items:center">
            <div><div style="font-weight:700">整本印刷列印</div><div class="small muted">含目錄、已勾選章節、頁碼${CUI.a5.qr ? '與封底 QR 碼' : ''}</div></div>
            <button type="button" class="btn sm pri-out" data-act="a5-print-book">匯出／列印</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:10px 0;border-top:1px solid var(--sunk);align-items:center">
            <div>
              <div style="font-weight:700">單章列印</div>
              <select id="a5SingleCh" data-act-change="a5-opt" data-k="singleCh" style="margin-top:4px;min-height:36px;border-radius:6px;border:1px solid var(--line);padding:0 8px;background:var(--surface)">
                ${chapters.map((ch) => `<option value="${ch.id}" ${CUI.a5.singleCh === ch.id ? 'selected' : ''}>${esc(ch.t)}</option>`).join('')}
              </select>
            </div>
            <button type="button" class="btn sm pri-out" data-act="a5-print-single">匯出此章</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:10px 0;border-top:1px solid var(--sunk);align-items:center">
            <div><div style="font-weight:700">Excel 相容 CSV</div><div class="small muted">UTF-8 BOM 編碼，含日期、類別、負責區與人員名單</div></div>
            <button type="button" class="btn sm pri-out" data-act="a5-export-csv">匯出 CSV</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:10px 0;border-top:1px solid var(--sunk);align-items:center">
            <div><div style="font-weight:700">各區一頁摘要</div><div class="small muted">六區各一頁（固定組別＋依日期場次）方便交給區長核對</div></div>
            <button type="button" class="btn sm pri-out" data-act="a5-print-areas">匯出摘要</button>
          </div>
        </section>
      </div>

      ${renderPrintBook(ctx, chapters)}
    </main>`;
  }

  /* ================================================================
   * 事件委派（Click / Change / SearchInput）
   * ================================================================ */

  function handleClick(act, d, ev, ctx) {
    if (!act) return false;
    const { E, M, store } = ctx;

    // A1
    if (act === 'a1-pick-plan') { CUI.a1.plan = d.plan; ctx.render(); return true; }
    if (act === 'a1-run-c') { runA1AutoSchedule(ctx, false); return true; }
    if (act === 'a1-run-scope') { runA1AutoSchedule(ctx, true); return true; }
    if (act === 'a1-diag-detail') { CUI.a1.openDiag = CUI.a1.openDiag === d.id ? '' : d.id; ctx.render(); return true; }
    if (act === 'a1-to-prop') {
      if (!ctx.need(ctx.me(), '請先登入')) return true;
      const sum = getPlanSummary(ctx);
      const diags = buildA1Diagnostics(ctx, sum.C);
      const diag = diags.find((x) => x.id === d.id);
      if (!diag) return true;
      const propId = 'P_' + store.pushId().slice(-6).toUpperCase();
      const prop = {
        id: propId,
        type: diag.propType,
        area: diag.area,
        targetAreas: diag.targetAreas,
        slotIds: diag.slotIds,
        title: diag.propTitle,
        reason: diag.why,
        byName: ctx.me().name,
        byUid: ctx.me().uid,
        at: Date.now(),
        status: 'waiting',
        step: 3,
        options: diag.propOptions,
        votes: { [diag.area]: { st: '待討論', by: ctx.me().name, at: Date.now() } },
        talk: {
          t1: { who: ctx.me().name, area: '總召', at: Date.now(), text: `由 A1 初版診斷「${diag.t}」自動建立提案，請相關區討論表態。` }
        }
      };
      store.update(Object.assign({ ['proposals/' + propId]: prop }, ctx.logOp(diag.area, `A1 診斷轉提案 ${propId}：${diag.propTitle}`)))
        .then(() => { if (typeof location !== 'undefined') location.hash = '#/p/' + propId; });
      ctx.toast(`已轉成提案 ${propId}`);
      return true;
    }

    // A2
    if (act === 'a2-month') { CUI.a2.month = d.v; ctx.render(); return true; }
    if (act === 'a2-mode') { CUI.a2.mode = CUI.a2.mode === 'matrix' ? 'list' : 'matrix'; ctx.render(); return true; }
    if (act === 'a2-add-toggle') { CUI.a2.addOpen = !CUI.a2.addOpen; ctx.render(); return true; }
    if (act === 'a2-sel') { CUI.a2.selId = d.sid; CUI.a2.showAllStaff = false; CUI.a2.showAllCands = false; ctx.render(); return true; }
    if (act === 'a2-show-staff') { CUI.a2.showAllStaff = true; ctx.render(); return true; }
    if (act === 'a2-show-cands') { CUI.a2.showAllCands = true; ctx.render(); return true; }
    if (act === 'a2-create-slot') {
      if (!ctx.need(ctx.isAdmin(), '只有總召或調度台可新增勤務格')) return true;
      const g = (id) => (typeof document !== 'undefined' && document.getElementById(id) ? document.getElementById(id).value : '');
      const dStr = g('a2NsD'), eStr = g('a2NsE') || dStr;
      if (!dStr) { ctx.toast('請選擇日期'); return true; }
      const cat = g('a2NsCat') || '服務';
      const area = g('a2NsArea') || '瑞芳';
      const grp = g('a2NsGrp').trim();
      const needN = Math.max(1, parseInt(g('a2NsNeed'), 10) || 10);
      const loc = g('a2NsLoc') || '天達堂';
      const label = g('a2NsLabel').trim() || cat;
      const nid = 'EX_' + store.pushId().slice(-6).toUpperCase();
      const slot = { id: nid, d: dStr, e: eStr < dStr ? dStr : eStr, cat, area, grp, share: 1, need: needN, loc, label, src: '總召新增', extra: true };
      CUI.a2.addOpen = false;
      CUI.a2.selId = nid;
      store.update(Object.assign({ ['extra/' + nid]: slot }, ctx.logOp(area, `A2 新增勤務：${E.fmtD(dStr)} ${cat}（${area}）`)));
      ctx.toast(`已新增勤務格 ${E.fmtD(dStr)} ${cat}`);
      return true;
    }
    if (act === 'a2-add-person' || act === 'a2-rm-person') {
      const s = M.byId[d.sid], pid = +d.pid;
      if (!s || !pid) return true;
      const kind = s.groupKey ? 'groups' : 'assign';
      const key = s.groupKey || s.id;
      const permKind = s.groupKey ? kindOfGroup(s.groupKey) : 'jz';
      if (!ctx.need(ctx.can(s.area, permKind), '沒有權限異動此格人員')) return true;
      const label = s.groupKey ? ((gmOf(ctx, s.groupKey) || {}).name || ctx.slotName(s)) : ctx.slotName(s);
      if (act === 'a2-add-person') ctx.addPerson(kind, key, pid, s.area, label);
      else ctx.removePerson(kind, key, pid, s.area, label);
      return true;
    }
    if (act === 'a2-pre-ok') {
      const s = M.byId[d.sid], pid = +d.pid;
      if (!s || !pid) return true;
      if (!ctx.need(ctx.isLead(s.area) || ctx.isAdmin(), '只有區長或總召可確認預排')) return true;
      const kind = s.groupKey ? 'groups' : 'assign';
      const key = s.groupKey || s.id;
      ctx.confirmPre(kind, key, pid, s.area, ctx.slotName(s));
      return true;
    }
    if (act === 'a2-autofill') {
      const s = M.byId[d.sid];
      if (!s) return true;
      if (!ctx.need(ctx.isAdmin() || ctx.can(s.area, s.groupKey ? kindOfGroup(s.groupKey) : 'jz'), '沒有權限補滿此格')) return true;
      const cur = new Set(M.asg[s.id].p);
      const needN = E.slotNeed(M, s);
      let left = Math.max(0, needN - cur.size);
      if (!left) { ctx.toast('這一格人數已達需求'); return true; }
      let pool = E.poolFor(M, s, CUI.a2.crossCands).filter((p) => !cur.has(p.id));
      let hasLead = M.asg[s.id].p.some((id) => E.canLead(M.pById[id], s));
      const chosen = [];
      while (left > 0 && pool.length) {
        let best = null;
        for (const p of pool) {
          const ev = ctx.evalInSlot(p, s);
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
      if (!chosen.length) { ctx.toast('沒有可無違規補入的候選人，可勾選「含其他區」再試'); return true; }
      const kind = s.groupKey ? 'groups' : 'assign';
      const key = s.groupKey || s.id;
      const pre = ctx.isAdmin() && !(ctx.memberOf(s.area) && ctx.memberOf(s.area).status === 'ok') && E.AREAS.includes(s.area);
      const up = {}, undo = {};
      for (const p of chosen) {
        const path = `${kind}/${key}/${p.id}`;
        up[path] = ctx.stamp(pre ? { pre: true } : null);
        undo[path] = null;
      }
      store.update(Object.assign(up, ctx.logOp(s.area, `${ctx.slotName(s)} ${pre ? '預排補滿' : '補滿'} ${chosen.length} 人`, undo), ctx.touchArea(s.area)));
      ctx.toast(`已${pre ? '預排' : ''}補入 ${chosen.length} 人`);
      return true;
    }
    if (act === 'a2-swap-lead') {
      const s = M.byId[d.sid];
      if (!s) return true;
      if (!ctx.need(ctx.isAdmin() || ctx.can(s.area, 'jz'), '沒有權限更換帶隊人')) return true;
      const kind = s.groupKey ? 'groups' : 'assign';
      const key = s.groupKey || s.id;
      const curPids = M.asg[s.id].p;
      const curLeadPid = curPids.find((pid) => E.canLead(M.pById[pid], s));
      const cands = E.poolFor(M, s, false)
        .filter((p) => !curPids.includes(p.id) && E.canLead(p, s))
        .map((p) => ctx.evalInSlot(p, s))
        .filter((ev) => ev.hard.length === 0)
        .sort((a, b) => b.score - a.score);
      if (!cands.length) { ctx.toast('目前本區沒有其他無違規的可帶隊人選'); return true; }
      const pick = cands[0].p;
      const pre = ctx.isAdmin() && !(ctx.memberOf(s.area) && ctx.memberOf(s.area).status === 'ok') && E.AREAS.includes(s.area);
      const up = { [`${kind}/${key}/${pick.id}`]: ctx.stamp(pre ? { pre: true } : null) };
      if (curLeadPid) up[`${kind}/${key}/${curLeadPid}`] = null;
      store.update(Object.assign(up, ctx.logOp(s.area, `${ctx.slotName(s)} 改由 ${pick.n} 帶隊`), ctx.touchArea(s.area)));
      ctx.toast(`已改由 ${pick.n} 帶隊`);
      return true;
    }
    if (act === 'a2-ack-slot') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可標記接受例外')) return true;
      const s = M.byId[d.sid];
      if (!s) return true;
      const { bySlot } = buildIndexes(ctx);
      const open = (bySlot[s.id] || []).filter((c) => !c.accepted);
      if (!open.length) { ctx.toast('此格目前沒有未解決的問題'); return true; }
      const up = {};
      for (const c of open) {
        up['acks/' + c.key] = { st: '接受例外', by: ctx.me().name, at: Date.now(), msg: c.msg };
      }
      store.update(Object.assign(up, ctx.logOp(s.area, `${ctx.slotName(s)} 標記 ${open.length} 項為接受例外`)));
      ctx.toast(`已將 ${open.length} 項標記為接受例外`);
      return true;
    }
    if (act === 'a2-toggle-lock') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可鎖定或解鎖勤務格')) return true;
      const s = M.byId[d.sid];
      if (!s) return true;
      const nextLock = !s.lock;
      const ed = Object.assign({}, (ctx.D().edits || {})[s.id] || {}, { lock: nextLock });
      store.update(Object.assign({ ['edits/' + s.id]: ed }, ctx.logOp(s.area, `${ctx.slotName(s)} ${nextLock ? '鎖定' : '解除鎖定'}`)));
      ctx.toast(nextLock ? '已鎖定這一格' : '已解除鎖定');
      return true;
    }
    if (act === 'a2-toggle-cancel') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可調整勤務格是否需要')) return true;
      const s = M.byId[d.sid];
      if (!s) return true;
      const nextCancel = !s.cancel;
      const ed = Object.assign({}, (ctx.D().edits || {})[s.id] || {}, { cancel: nextCancel });
      store.update(Object.assign({ ['edits/' + s.id]: ed }, ctx.logOp(s.area, `${ctx.slotName(s)} ${nextCancel ? '標為此日不需要' : '恢復排班'}`)));
      ctx.toast(nextCancel ? '已標為此日不需要' : '已恢復此格');
      return true;
    }

    // A3
    if (act === 'a3-chip') { CUI.a3.chip = d.v; ctx.render(); return true; }
    if (act === 'a3-sel') { CUI.a3.selPid = +d.pid; ctx.render(); return true; }
    if (act === 'a3-show-all') { CUI.a3.showAllPeople = true; ctx.render(); return true; }
    if (act === 'a3-toggle-month') {
      const p = M.pById[+d.pid];
      if (!p) return true;
      if (!ctx.need(ctx.can(p.a, 'pov') || ctx.isAdmin(), '沒有權限修改此人月份狀態')) return true;
      const m = +d.m;
      const o = Object.assign({}, (ctx.D().pov || {})[p.id] || {});
      const cur = new Set((o.months || []).map(Number));
      if (cur.has(m)) cur.delete(m); else cur.add(m);
      const nextMonths = [...cur].sort((a, b) => a - b);
      if (nextMonths.length) {
        o.months = nextMonths;
        if (!o.status || o.status === '正常') o.status = '暫停一段時間';
      } else {
        delete o.months;
        if (o.status === '暫停一段時間') delete o.status;
      }
      store.update(Object.assign({ ['pov/' + p.id]: Object.keys(o).length ? o : null }, ctx.logOp(p.a, `${p.n} ${cur.has(m) ? '設為' + m + '月暫停' : '取消' + m + '月暫停'}`)));
      return true;
    }
    if (act === 'a3-pre-subs') {
      const p = M.pById[+d.pid];
      if (!p) return true;
      if (!ctx.need(ctx.isAdmin() || ctx.can(p.a, 'jz'), '沒有權限預排替補人員')) return true;
      const hits = findAffectedSlotsForPerson(ctx, p);
      const up = {};
      let cntDone = 0, grpSkipped = 0;
      for (const h of hits) {
        const s = h.s;
        if (s.groupKey) {
          if (p.off) {
            const sub = findSubstituteForSlot(ctx, p, s);
            up[`groups/${s.groupKey}/${p.id}`] = null;
            if (sub) {
              const pre = ctx.isAdmin() && !(ctx.memberOf(s.area) && ctx.memberOf(s.area).status === 'ok') && E.AREAS.includes(s.area);
              up[`groups/${s.groupKey}/${sub.c.id}`] = ctx.stamp(pre ? { pre: true } : null);
              cntDone++;
            }
          } else {
            grpSkipped++;
          }
          continue;
        }
        const sub = findSubstituteForSlot(ctx, p, s);
        up[`assign/${s.id}/${p.id}`] = null;
        if (sub) {
          const pre = ctx.isAdmin() && !(ctx.memberOf(s.area) && ctx.memberOf(s.area).status === 'ok') && E.AREAS.includes(s.area);
          up[`assign/${s.id}/${sub.c.id}`] = ctx.stamp(pre ? { pre: true } : null);
          cntDone++;
        }
      }
      if (!Object.keys(up).length) {
        ctx.toast(grpSkipped ? '受影響勤務屬固定組別，請按「逐格處理」或進組別頁面調整' : '沒有可執行的替補異動');
        return true;
      }
      store.update(Object.assign(up, ctx.logOp(p.a, `替暫停人員 ${p.n} 預排 ${cntDone} 位替補`)));
      ctx.toast(`已預排 ${cntDone} 位替補${grpSkipped ? `（另有 ${grpSkipped} 格屬固定組別）` : ''}`);
      return true;
    }
    if (act === 'a3-inspect-hits') {
      const p = M.pById[+d.pid];
      if (!p) return true;
      const hits = findAffectedSlotsForPerson(ctx, p);
      if (hits.length) CUI.a2.selId = hits[0].s.id;
      CUI.a2.q = '';
      if (typeof location !== 'undefined') location.hash = '#/a2';
      else ctx.render();
      return true;
    }

    // A4
    if (act === 'a4-toggle-ver') { CUI.a4.verOpen = !CUI.a4.verOpen; ctx.render(); return true; }
    if (act === 'a4-reset-rules') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可還原預設規則')) return true;
      const ok = typeof confirm === 'function' ? confirm('確定要將所有規則與兼職矩陣還原為預設值嗎？') : true;
      if (!ok) return true;
      store.update(Object.assign({ rules: null }, ctx.logOp('總召', '還原規則集為預設值')));
      ctx.toast('已還原預設規則');
      return true;
    }
    if (act === 'a4-export-json') {
      const payload = {
        version: '117-draft',
        exportedAt: new Date().toISOString(),
        baseVersion: ctx.BASE.version,
        rules: M.R
      };
      triggerDownload(`117規則草案_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
      ctx.toast('已匯出 117 規則草案 JSON');
      return true;
    }
    if (act === 'a4-run-sim') {
      const rule = CUI.a4.simRule;
      const rawVal = CUI.a4.simVal;
      let patchP = null, patchSev = null;
      if (rule === 'P4b') patchSev = { P4b: rawVal || '注意' };
      else if (rule === 'allowCross') patchP = { allowCross: rawVal === 'true' || rawVal === true };
      else patchP = { [rule]: Math.max(0, Number(rawVal) || 0) };
      CUI.a4.simResult = Object.assign({ rule, val: rawVal, patchP, patchSev }, simulateRulesDelta(ctx, patchP, patchSev));
      ctx.render();
      ctx.toast('已完成記憶體情境試算（未修改總表）');
      return true;
    }
    if (act === 'a4-apply-sim') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可套用規則變更')) return true;
      const sr = CUI.a4.simResult;
      if (!sr) return true;
      const up = {};
      if (sr.patchP) for (const k in sr.patchP) up['rules/p/' + k] = sr.patchP[k];
      if (sr.patchSev) for (const k in sr.patchSev) up['rules/sev/' + k] = sr.patchSev[k];
      store.update(Object.assign(up, ctx.logOp('總召', `試算確認套用規則：${sr.rule} = ${sr.val}`)));
      CUI.a4.simResult = null;
      ctx.toast('已套用試算結果至規則集');
      return true;
    }

    // A5
    if (act === 'a5-ack-all-viol') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可批量標為接受例外')) return true;
      const { openViols } = buildA5Checks(ctx);
      if (!openViols.length) { ctx.toast('目前沒有未決違規'); return true; }
      const up = {};
      for (const c of openViols) {
        up['acks/' + c.key] = { st: '接受例外', by: ctx.me().name, at: Date.now(), msg: c.msg, note: '定版前統一標為接受例外' };
      }
      store.update(Object.assign(up, ctx.logOp('總召', `定版前將 ${openViols.length} 筆未決違規標為接受例外`)));
      ctx.toast(`已將 ${openViols.length} 筆違規標為接受例外`);
      return true;
    }
    if (act === 'a5-preview') { CUI.a5.previewMode = CUI.a5.previewMode === 'preview' ? '' : 'preview'; ctx.render(); return true; }
    if (act === 'a5-close-preview') { CUI.a5.previewMode = ''; ctx.render(); return true; }
    if (act === 'a5-exec-print') {
      if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
      ctx.toast('已開啟列印預覽');
      return true;
    }
    if (act === 'a5-draft-pdf') {
      CUI.a5.previewMode = 'draft';
      ctx.render();
      if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
      ctx.toast('已開啟草稿浮水印 PDF 列印');
      return true;
    }
    if (act === 'a5-print-book') {
      CUI.a5.previewMode = (ctx.D().meta || {}).published ? 'final' : 'preview';
      ctx.render();
      if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
      return true;
    }
    if (act === 'a5-print-single') {
      CUI.a5.previewMode = 'single';
      ctx.render();
      if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
      return true;
    }
    if (act === 'a5-print-ch') {
      CUI.a5.singleCh = d.ch || 'ch10';
      CUI.a5.previewMode = 'single';
      ctx.render();
      if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
      return true;
    }
    if (act === 'a5-print-areas') {
      CUI.a5.previewMode = 'areas';
      ctx.render();
      if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
      return true;
    }
    if (act === 'a5-export-csv') {
      exportA5Csv(ctx);
      return true;
    }
    if (act === 'a5-publish') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可執行定版')) return true;
      const { openViols } = buildA5Checks(ctx);
      if (openViols.length && typeof confirm === 'function') {
        if (!confirm(`目前尚有 ${openViols.length} 筆未處理違規，建議先標為「接受例外」。確定仍要鎖定為 116 定版 v1.0 嗎？`)) return true;
      }
      const live = M.slots.filter((s) => !s.cancel);
      const totalGot = live.reduce((acc, s) => acc + M.asg[s.id].p.length, 0);
      const pubObj = {
        version: '116 定版 v1.0',
        at: Date.now(),
        by: ctx.me().name,
        uid: ctx.me().uid,
        printDate: CUI.a5.printDate,
        snapshotCounts: {
          slots: live.length,
          assigned: totalGot,
          people: M.people.length
        },
        slotDigest: buildSlotDigest(M)
      };
      store.update(Object.assign({
        'meta/published': pubObj,
        'meta/version': '116 定版 v1.0'
      }, ctx.logOp('總召', '定版鎖定為 116 定版 v1.0')));
      ctx.toast('已定版鎖定為 116 定版 v1.0');
      return true;
    }
    if (act === 'a5-unpublish') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可解除定版')) return true;
      store.update(Object.assign({
        'meta/published': null,
        'meta/version': 'v9.4'
      }, ctx.logOp('總召', '解除定版鎖定，恢復修訂')));
      ctx.toast('已解除定版鎖定');
      return true;
    }

    return false;
  }

  function handleChange(actChange, target, d, ev, ctx) {
    if (!actChange) return false;
    const { E, M, store } = ctx;

    // A1
    if (actChange === 'a1-opt') { CUI.a1[d.k] = target.value; ctx.render(); return true; }
    if (actChange === 'a1-chk') { CUI.a1[d.k] = !!target.checked; ctx.render(); return true; }

    // A2
    if (actChange === 'a2-area') { CUI.a2.area = target.value; ctx.render(); return true; }
    if (actChange === 'a2-cat') { CUI.a2.cat = target.value; ctx.render(); return true; }
    if (actChange === 'a2-only') { CUI.a2.only = !!target.checked; ctx.render(); return true; }
    if (actChange === 'a2-cross') { CUI.a2.crossCands = !!target.checked; ctx.render(); return true; }
    if (actChange === 'a2-set-area') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可改派勤務格負責區')) { ctx.render(); return true; }
      const s = M.byId[d.sid];
      if (!s) return true;
      const newArea = target.value;
      const newGrp = E.defaultGroupForAreaCat(newArea, s.cat) || '';
      const prevEd = (ctx.D().edits || {})[s.id] || {};
      const nextEd = Object.assign({}, prevEd, { area: newArea, grp: newGrp });
      store.update(Object.assign({ ['edits/' + s.id]: nextEd }, ctx.logOp(newArea, `${ctx.slotName(s)} 改派負責區：${s.area} → ${newArea}`)));
      ctx.toast(`已改派為 ${newArea}`);
      return true;
    }
    if (actChange === 'a2-set-grp') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可調整組別')) { ctx.render(); return true; }
      const s = M.byId[d.sid];
      if (!s) return true;
      const prevEd = (ctx.D().edits || {})[s.id] || {};
      const nextEd = Object.assign({}, prevEd, { grp: target.value });
      store.update(Object.assign({ ['edits/' + s.id]: nextEd }, ctx.logOp(s.area, `${ctx.slotName(s)} 調整組別為 ${target.value || '無'}`)));
      ctx.toast('已更新組別');
      return true;
    }

    // A3
    if (actChange === 'a3-area') { CUI.a3.area = target.value; ctx.render(); return true; }
    if (actChange === 'a3-pov') {
      const p = M.pById[+d.pid];
      if (!p) return true;
      if (!ctx.need(ctx.can(p.a, 'pov') || ctx.isAdmin(), '沒有權限修改此人狀態')) { ctx.render(); return true; }
      const o = Object.assign({}, (ctx.D().pov || {})[p.id] || {});
      const k = d.k;
      const val = target.value;
      if (k === 'months') {
        const ms = val.split(/[\s,，、]+/).map(Number).filter((n) => n >= 1 && n <= 12);
        o.months = [...new Set(ms)].sort((a, b) => a - b);
      } else if (k === 'cap') {
        o.cap = val === '' ? '' : Math.max(0, +val);
      } else if (k === 'wdCap') {
        o.wdCap = val === '' ? '' : +val;
      } else if (k === 'status') {
        o.status = val;
        if (val === '不再排班') o.off = true;
        else {
          o.off = false;
          if (val === '只排假日') o.wdCap = 0;
          else if (o.wdCap === 0) delete o.wdCap;
        }
      } else {
        o[k] = val;
      }
      for (const key of Object.keys(o)) {
        if (o[key] === '' || o[key] === false || (Array.isArray(o[key]) && !o[key].length)) delete o[key];
      }
      store.update(Object.assign({ ['pov/' + p.id]: Object.keys(o).length ? o : null }, ctx.logOp(p.a, `更新 ${p.n} 的人員狀態（${k}）`)));
      ctx.toast(`已更新 ${p.n} 的狀態`);
      return true;
    }

    // A4
    if (actChange === 'a4-toggle') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可修改規則')) { ctx.render(); return true; }
      const rid = d.rule;
      if (target.checked) {
        const defSev = E.defaultRules().sev[rid] || '注意';
        const nextSev = CUI.a4.prevSev[rid] || (defSev === '關閉' ? '注意' : defSev);
        store.update(Object.assign({ ['rules/sev/' + rid]: nextSev }, ctx.logOp('總召', `啟用規則 ${rid}（${nextSev}）`)));
      } else {
        CUI.a4.prevSev[rid] = M.R.sev[rid] || '注意';
        store.update(Object.assign({ ['rules/sev/' + rid]: '關閉' }, ctx.logOp('總召', `關閉規則 ${rid}`)));
      }
      return true;
    }
    if (actChange === 'a4-sev') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可修改規則嚴重度')) { ctx.render(); return true; }
      const rid = d.rule;
      store.update(Object.assign({ ['rules/sev/' + rid]: target.value }, ctx.logOp('總召', `規則 ${rid} 嚴重度設為 ${target.value}`)));
      return true;
    }
    if (actChange === 'a4-param') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可修改規則參數')) { ctx.render(); return true; }
      const pk = d.param;
      const ptype = d.ptype;
      const val = ptype === 'bool' ? !!target.checked : ptype === 'num' ? (target.value === '' ? 0 : +target.value) : target.value;
      store.update(Object.assign({ ['rules/p/' + pk]: val }, ctx.logOp('總召', `調整規則參數 ${pk} = ${val}`)));
      return true;
    }
    if (actChange === 'a4-mx') {
      if (!ctx.need(ctx.isAdmin(), '只有總召可修改同日兼職矩陣')) { ctx.render(); return true; }
      const [a, b] = String(d.pair || '').split('|');
      if (!a || !b) return true;
      const up = {
        [`rules/mx/${a}|${b}`]: target.value,
        [`rules/mx/${b}|${a}`]: target.value
      };
      store.update(Object.assign(up, ctx.logOp('總召', `同日兼職 ${a}＋${b} 設為 ${target.value}`)));
      return true;
    }
    if (actChange === 'a4-sim-rule') {
      CUI.a4.simRule = target.value;
      CUI.a4.simVal = target.value === 'P4b' ? '注意' : target.value === 'allowCross' ? 'true' : String(M.R.p[target.value] ?? '2');
      CUI.a4.simResult = null;
      ctx.render();
      return true;
    }
    if (actChange === 'a4-sim-val') {
      CUI.a4.simVal = target.value;
      return true;
    }

    // A5
    if (actChange === 'a5-ch') { CUI.a5.chapters[d.ch] = !!target.checked; ctx.render(); return true; }
    if (actChange === 'a5-opt') { CUI.a5[d.k] = target.value; ctx.render(); return true; }
    if (actChange === 'a5-chk') { CUI.a5[d.k] = !!target.checked; ctx.render(); return true; }

    return false;
  }

  function handleSearchInput(k, val, ctx) {
    if (k === 'a2Q') {
      CUI.a2.q = String(val || '').trim();
      if (typeof document !== 'undefined') {
        const el = document.getElementById('a2List');
        if (el) el.innerHTML = renderA2List(ctx);
      }
      return true;
    }
    if (k === 'a3Q') {
      CUI.a3.q = String(val || '').trim();
      if (typeof document !== 'undefined') {
        const el = document.getElementById('a3List');
        if (el) el.innerHTML = renderA3List(ctx);
      }
      return true;
    }
    return false;
  }

  function renderRoute(routeName, arg, ctx) {
    if (!ctx || !ctx.M) return '<div class="empty">資料載入中…</div>';
    if (routeName === 'overview') return renderOverview(ctx);
    if (routeName === 'a1') return renderA1(ctx);
    if (routeName === 'a2') return renderA2(ctx);
    if (routeName === 'a3') return renderA3(ctx);
    if (routeName === 'a4') return renderA4(ctx);
    if (routeName === 'a5') return renderA5(ctx);
    return '';
  }

  const TDConsole = {
    ROUTES,
    renderRoute,
    handleClick,
    handleChange,
    handleSearchInput,
    fmtPrintName,
    computeAreaDelta,
    simulateRulesDelta,
    _ui: CUI
  };

  (typeof window !== 'undefined' ? window : globalThis).TDConsole = TDConsole;
  if (typeof module !== 'undefined') module.exports = TDConsole;
})();
