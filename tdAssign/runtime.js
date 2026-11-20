/* 天達排班協作 — 階段四、五（C1–C3 運行調度台、M1–M7／M9–M11 志工與幹部手機端）
 * 透過 window.TDRuntime 與 app.js 對接，共用 BASE_DATA、TDEngine 與 TDStore 最小路徑寫入。
 */
(function () {
  'use strict';

  const ROUTES = ['c1', 'c2', 'c3', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm9', 'm10', 'm11'];
  const h = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const RUI = {
    c1Date: '',
    c1LeaveOpen: false,
    c2Sel: '',
    c2AddOpen: false,
    c2ImportOpen: false,
    c2ImportDiff: null,
    m2Reason: '身體不適',
    m3Slot: '',
    m3Ans: { 0: '剛好', 1: '順利', 2: '剛好' },
    m4WeekStart: '',
    m5Tab: '依工作',
    m6Tab: '服務工作',
    m6Area: '全部',
    m6Q: '',
    m7Tab: '服務指南',
    m7Cat: '全部',
    m7Q: '',
    m7AddOpen: false,
    m9Mode: '',
    m9Seats: 2,
    m10Slot: '',
    m10TempOpen: false,
    m11Slot: '',
    m11Car: ''
  };

  /* ---------------- 預設種子（指南、檢討基準與 C2 典型變更） ---------------- */
  const DEFAULT_GUIDES = [
    { id: 'dg1', tab: '指南', cat: '忠恕輪值', meta: '輪值組 · 3 分鐘', title: '輪值當天要做什麼', body: '服務時間 08:30–13:30（提早 10 分鐘集合）。\n崗位分配：服務台、導覽（需著制服）、佛堂、寶塔、廁所、外圍環境、接駁與廚房支援。\n建議人數下限：平日 8 人、週六大區 25 人、週日 12–16 人；請小組長前一天清點到齊。', at: 1 },
    { id: 'dg2', tab: '指南', cat: '忠恕輪值', meta: '輪值組 · 2 分鐘', title: '小組長：7 天前要確認的事', body: '1. 於「我的服務」確認組員出席回覆（會到／無法出席）。\n2. 協調輪值與當日廚務人數，若低於下限提早向區長或調度台求援。\n3. 進入「車輛安排 (M10)」確認共乘與需要接送之長輩。', at: 2 },
    { id: 'dg3', tab: '指南', cat: '第一次服務', meta: '人力資源處 · 2 分鐘', title: '新人須知：怎麼看班表與請假', body: '打開頁面即可在「全堂查詢」輸入姓名查班；使用 LINE／Google 登入並綁定姓名後，可於首頁看到下一場服務倒數、一鍵回覆「我會到」或送出「無法出席」尋找同班底代班，還能在「這一場我怎麼去」登記共乘。', at: 3 },
    { id: 'dg4', tab: '指南', cat: '廚務', meta: '廚務組 · 2 分鐘', title: '分菜制與儲備廚師分工說明', body: '針對中小型週六班次，採用「分菜制」時由各班組每 2–3 人認領一道菜自理，廚務組僅派 1 位儲備廚師現場指導與協調設備，可大幅減輕固定廚務組假日連班負擔。', at: 4 },
    { id: 'dg5', tab: '指南', cat: '禮節', meta: '壇務處 · 3 分鐘', title: '辦道 6 大崗位工作檢核', body: '操持、燒香禮、請壇禮、辦道禮、獻供人員、填表／掛號須於典禮開始前 30 分鐘著裝到位並對表流程；小組長可在 B6 組別頁直接設定各崗位人選。', at: 5 },
    { id: 'dg6', tab: '指南', cat: '交通', meta: '交通處 · 2 分鐘', title: '交通指揮與接駁安全事項', body: '清晨班或無大眾運輸時段，請優先透過 M9 共乘媒合順路車或於 M10 指派臨時接駁司機；司機出發、晚到或變更上車點可由 M11「通知同車的人」一鍵更新。', at: 6 }
  ];

  const DEFAULT_CHANGES = [
    {
      id: 'CHG_D16',
      kind: '新增活動',
      src: '行事曆 11/10 版',
      status: '處理中',
      title: '心靈成長班 2.0（玉和）四個週六',
      detail: '行事曆新增 8/14、9/18、10/16、11/20 四個週六班務，需廚務人力；請確認是否採分菜制或機動支援。',
      needKind: '廚務',
      dates: ['2027-08-14', '2027-09-18', '2027-10-16', '2027-11-20'],
      area: '機動',
      propId: 'D16',
      chosen: '丙'
    },
    {
      id: 'CHG_02',
      kind: '新增活動',
      src: '行事曆 11/10 版',
      status: '待處理',
      title: '4/25 讀經大會師廚務支援',
      detail: '年度讀經大會師活動，請試算當日與前後七天可用廚務組別並指派單位承接。',
      needKind: '廚務、服務',
      dates: ['2027-04-25'],
      area: '內湖',
      chosen: ''
    },
    {
      id: 'CHG_03',
      kind: '改期',
      src: '行事曆 11/10 版',
      status: '待確認',
      title: '讀經會考 11/21 → 11/28',
      detail: '行事曆預排曾寫 11/21，改為 11/28 後需避開同日明理班重疊並向班務窗口確認。',
      needKind: '廚務、服務',
      dates: ['2027-11-21', '2027-11-28'],
      area: '瑞芳',
      chosen: ''
    },
    {
      id: 'CHG_04',
      kind: '臨時協辦',
      src: '道院公關處',
      status: '討論中',
      title: '參訪服務機動排班',
      detail: '天達第 3 順位協辦單位，每次 10 人以內、單一單位承接即可。',
      needKind: '服務',
      dates: ['2027-06-19'],
      area: '機動',
      chosen: ''
    },
    {
      id: 'CHG_05',
      kind: '取消合併',
      src: '行事曆 11/10 版',
      status: '已套用',
      title: '2/21 清口壇辦法會併入 3/7',
      detail: '移除原 2/21 勤務並併入春季班次，已通知相關單位。',
      needKind: '廚務、禮節',
      dates: ['2027-02-21', '2027-03-07'],
      area: '三重',
      chosen: '甲'
    }
  ];

  const REVIEW_115_METRICS = [
    { key: 'w7', k: '七天內重複服務', v115: '268 次 · 100 人', hint: '同一人兩次服務間隔 7 天內；多日活動算一次' },
    { key: 'avg', k: '平均每人服務次數', v115: '8.6 次', hint: '有實際出勤者之平均；廚務與其他分開看' },
    { key: 'top20', k: '前 20% 的人承擔的人次', v115: '41%', hint: '依實際排定／出勤人次排序' },
    { key: 'wd4', k: '平日請假 4 天以上', v115: '44 人', hint: '平日出勤天數；國定假日不計' },
    { key: 'newbie', k: '第一次服務的新人', v115: '—', hint: '名冊「高出席未服務」新人中實際排入或出勤者' },
    { key: 'minok', k: '實到達需求下限的場次', v115: '無紀錄', hint: '116 年起由小組長 M3 點名與回饋取得' }
  ];

  /* ---------------- 日期與資料工具 ---------------- */
  function fmtYmdLocal(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  function parseYmd(str) {
    const [y, m, d] = String(str || '2027-01-01').split('-').map(Number);
    return new Date(Date.UTC(y || 2027, (m || 1) - 1, d || 1));
  }
  function addDays(str, delta) {
    const dt = parseYmd(str);
    dt.setUTCDate(dt.getUTCDate() + delta);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  function mondayOf(str) {
    const dt = parseYmd(str);
    const wd = dt.getUTCDay();
    const diff = wd === 0 ? -6 : (1 - wd);
    return addDays(str, diff);
  }
  function liveSlotsSorted(ctx) {
    if (!ctx.M) return [];
    return ctx.M.slots.filter((s) => !s.cancel && s.d).slice().sort((a, b) => a.d.localeCompare(b.d) || a.id.localeCompare(b.id));
  }
  function defaultBaseDate(ctx) {
    const today = fmtYmdLocal(new Date());
    const live = liveSlotsSorted(ctx);
    if (!live.length) return today;
    const end14 = addDays(today, 13);
    if (live.some((s) => s.d >= today && s.d <= end14)) return today;
    const future = live.find((s) => s.d >= today);
    return future ? future.d : live[0].d;
  }
  function defaultWeekStart(ctx) {
    const today = fmtYmdLocal(new Date());
    const w0 = mondayOf(today);
    const wEnd = addDays(w0, 6);
    const live = liveSlotsSorted(ctx);
    if (!live.length) return w0;
    if (live.some((s) => s.d >= w0 && s.d <= wEnd)) return w0;
    const future = live.find((s) => s.d >= w0);
    return mondayOf(future ? future.d : live[0].d);
  }
  function rocRange(d1, d2) {
    const f = (s) => `${+s.slice(0, 4) - 1911}/${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
    return `${f(d1)} – ${f(d2)}`;
  }

  function effectiveSlotCrew(sid, ctx) {
    const M = ctx.M;
    const s = M && M.byId[sid];
    if (!s) return [];
    const rsvpMap = (ctx.D().rsvp || {})[sid] || {};
    const baseIds = (M.asg[sid] && M.asg[sid].p) || [];
    const seen = new Set();
    const crew = [];
    for (const pid of baseIds) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = M.pById[pid];
      if (!p) continue;
      const rv = rsvpMap[pid] || null;
      crew.push({ pid, p, rsvp: rv, isSub: false, origName: '' });
    }
    for (const k of Object.keys(rsvpMap)) {
      if (!ctx.RE_PID.test(k)) continue;
      const pid = +k;
      const rv = rsvpMap[k];
      if (!rv || rv.st !== 'sub' || seen.has(pid)) continue;
      seen.add(pid);
      const p = M.pById[pid];
      if (!p) continue;
      crew.push({ pid, p, rsvp: rv, isSub: true, origName: rv.origName || '' });
    }
    return crew;
  }

  function slotRsvpStats(sid, ctx) {
    const s = ctx.M && ctx.M.byId[sid];
    if (!s) return { crew: [], need: 0, ok: 0, wait: 0, no: 0, carMiss: 0, hasHeadNo: false, leadConfirmed: true };
    const crew = effectiveSlotCrew(sid, ctx);
    const need = ctx.E.slotNeed(ctx.M, s);
    const rsvpMap = (ctx.D().rsvp || {})[sid] || {};
    const carData = (ctx.D().carpool || {})[sid] || {};
    const offline = carData.mode === 'offline';
    const riders = carData.riders || {};
    const cars = carData.cars || {};
    let ok = 0, wait = 0, no = 0, carMiss = 0, hasHeadNo = false;
    const leadP = s.groupKey ? ctx.groupLead(s.groupKey) : null;
    let leadConfirmed = !leadP;
    for (const it of crew) {
      const rv = it.rsvp;
      const st = rv ? rv.st : '';
      if (st === 'ok' || st === 'sub') {
        ok++;
        if (leadP && it.pid === leadP.id) leadConfirmed = true;
      } else if (st === 'no') {
        // 若已被人以 st:'sub' 補上，原作者不算在待補缺額內（已交接）
        const hasAcceptedSub = rv.subPid && rsvpMap[rv.subPid] && rsvpMap[rv.subPid].st === 'sub';
        if (!hasAcceptedSub) no++;
        if (ctx.E.isHeadCook(it.p) && !hasAcceptedSub) hasHeadNo = true;
      } else {
        wait++;
      }
      if (!offline && st !== 'no') {
        const rd = riders[it.pid];
        const cancelledCar = rd && rd.carId && cars[rd.carId] && cars[rd.carId].cancelled;
        if (rd && (rd.mode === 'need_help' || cancelledCar)) carMiss++;
      }
    }
    if (s.cat === '忠恕週日' || s.cat === '忠恕週六' || s.cat === '忠恕平日') {
      const hasLeadIn = crew.some((it) => !it.rsvp || it.rsvp.st !== 'no' ? /組長/.test(it.p.lead || '') || (it.rsvp && it.rsvp.st === 'ok') : false);
      if (!crew.length) leadConfirmed = false;
      else if (!leadP) leadConfirmed = crew.some((it) => it.rsvp && (it.rsvp.st === 'ok' || it.rsvp.st === 'sub'));
      else if (hasLeadIn && leadP) {
        const lrv = rsvpMap[leadP.id];
        leadConfirmed = !!(lrv && lrv.st === 'ok');
      }
    }
    return { crew, need, ok, wait, no, carMiss, hasHeadNo, leadConfirmed, offline };
  }

  function isSlotDriver(sid, p, meUid, ctx) {
    const cp = (ctx.D().carpool || {})[sid] || {};
    const cars = cp.cars || {};
    return Object.entries(cars).filter(([, c]) => c && !c.cancelled && ((p && c.driverPid === p.id) || (meUid && c.driverUid === meUid) || (p && cp.riders && cp.riders[p.id] && cp.riders[p.id].carId)));
  }

  function personDrivingCars(ctx) {
    const bp = ctx.myBoundPerson();
    const p = bp && ctx.boundOk(bp) ? bp.p : null;
    const u = ctx.me();
    const out = [];
    const cpAll = ctx.D().carpool || {};
    for (const sid of Object.keys(cpAll)) {
      const s = ctx.M && ctx.M.byId[sid];
      if (!s || s.cancel) continue;
      const cars = (cpAll[sid] && cpAll[sid].cars) || {};
      for (const cid of Object.keys(cars)) {
        const c = cars[cid];
        if (!c || c.cancelled) continue;
        if ((p && +c.driverPid === p.id) || (u && c.driverUid === u.uid)) {
          out.push({ sid, s, cid, car: c });
        }
      }
    }
    out.sort((a, b) => a.s.d.localeCompare(b.s.d));
    return out;
  }

  function findSlotForPerson(p, ctx) {
    if (!p || !ctx.M) return [];
    const base = (ctx.M.personSlots[p.id] || []).slice();
    const seen = new Set(base.map((s) => s.id));
    const rsvpAll = ctx.D().rsvp || {};
    for (const sid of Object.keys(rsvpAll)) {
      if (seen.has(sid)) continue;
      const rv = (rsvpAll[sid] || {})[p.id];
      if (rv && rv.st === 'sub' && ctx.M.byId[sid] && !ctx.M.byId[sid].cancel) {
        base.push(ctx.M.byId[sid]);
        seen.add(sid);
      }
    }
    base.sort((a, b) => a.ds - b.ds);
    return base;
  }

  function computePendingSubInvites(p, ctx) {
    if (!p || !ctx.M) return [];
    const rsvpAll = ctx.D().rsvp || {};
    const out = [];
    for (const sid of Object.keys(rsvpAll)) {
      const s = ctx.M.byId[sid];
      if (!s || s.cancel) continue;
      const m = rsvpAll[sid] || {};
      for (const origPid of Object.keys(m)) {
        const r = m[origPid];
        if (r && r.st === 'no' && +r.subPid === p.id && !(m[p.id] && m[p.id].st === 'sub')) {
          const origP = ctx.M.pById[+origPid];
          out.push({ sid, s, origPid: +origPid, origName: (origP && origP.n) || r.origName || '同區夥伴' });
        }
      }
    }
    return out;
  }

  /* ---------------- 本機試用運行期示範資料 ---------------- */
  function seedDemoRuntime(ctx) {
    if (ctx.store.mode !== 'local') { ctx.toast('僅本機試用模式支援載入運行期模擬資料'); return; }
    if (!ctx.M || !(ctx.D().meta || {}).seeded) { ctx.toast('請先完成年度初始資料建置'); return; }
    const slots = liveSlotsSorted(ctx);
    if (!slots.length) return;
    const baseD = defaultBaseDate(ctx);
    const endD = addDays(baseD, 13);
    const winSlots = slots.filter((s) => s.d >= baseD && s.d <= endD);
    const targetSlots = winSlots.length ? winSlots : slots.slice(0, 6);
    const now = Date.now();
    const u = ctx.me() || { uid: 'local-sysadmin', name: '系統' };
    const up = {};

    const firstSlot = targetSlots[0];
    const secondSlot = targetSlots[1] || targetSlots[0];
    const thirdSlot = targetSlots[2] || targetSlots[0];

    // 確保三個代表格內至少有預設或示範人員以便點名與共乘展示
    for (const s of [firstSlot, secondSlot, thirdSlot]) {
      let crew = (ctx.M.asg[s.id] && ctx.M.asg[s.id].p) || [];
      if (!crew.length) {
        const candPool = ctx.M.people.filter((x) => !x.off && x.a === s.area).slice(0, 5);
        if (s.groupKey) {
          for (const p of candPool) up[`groups/${s.groupKey}/${p.id}`] = { by: u.uid, n: u.name, at: now };
        } else {
          for (const p of candPool) up[`assign/${s.id}/${p.id}`] = { by: u.uid, n: u.name, at: now };
        }
        crew = candPool.map((p) => p.id);
      }
      if (crew.length >= 2) {
        const p0 = ctx.M.pById[crew[0]], p1 = ctx.M.pById[crew[1]];
        if (p0 && p1) {
          up[`rsvp/${s.id}/${p0.id}`] = { st: 'ok', by: p0.n, uid: 'demo-' + p0.id, at: now - 3600000 };
          up[`rsvp/${s.id}/${p1.id}`] = { st: 'no', subPid: crew[2] || null, by: p1.n, uid: 'demo-' + p1.id, at: now - 1800000 };
          up[`rsvpNote/${s.id}/${p1.id}`] = { reason: '沒有交通', note: '示例：待小組長協助共乘', uid: 'demo-' + p1.id, at: now - 1800000 };
          const cid = 'c_demo_' + s.id;
          up[`carpool/${s.id}/mode`] = 'app';
          up[`carpool/${s.id}/cars/${cid}`] = { driverName: p0.n, driverPid: p0.id, driverUid: u.uid, kind: '自己開車', seats: 3, pickup: `${s.area}集合點 07:40`, at: now };
          if (crew[2]) up[`carpool/${s.id}/riders/${crew[2]}`] = { mode: 'carpool', carId: cid, status: 'pending', by: '示例', uid: 'demo', at: now };
          if (crew[3]) up[`carpool/${s.id}/riders/${crew[3]}`] = { mode: 'need_help', from: `${s.area}市區`, by: '示例', uid: 'demo', at: now };
        }
      }
    }

    // 點名與回饋樣本（供 M3 & C3 使用）
    const fbCrew = ((ctx.M.asg[firstSlot.id] && ctx.M.asg[firstSlot.id].p) || []).slice(0, 4);
    for (const pid of fbCrew) {
      up[`checkin/${firstSlot.id}/${pid}`] = { here: true, by: '示例點名', uid: u.uid, at: now - 7200000 };
    }
    up[`feedback/${firstSlot.id}`] = {
      headcount: '剛好', transport: '順利', workload: '剛好',
      note: '新人 1 位見習穩定，已納入服務紀錄。',
      hereCnt: fbCrew.length, totalCnt: Math.max(fbCrew.length, 4),
      area: firstSlot.area, cat: firstSlot.cat, d: firstSlot.d,
      by: u.name, uid: u.uid, at: now - 5400000
    };
    up[`feedback/${secondSlot.id}`] = {
      headcount: '不足', transport: '臨時安排', workload: '偏重',
      note: '少 1 位收尾較忙；接送臨時找車。',
      hereCnt: 3, totalCnt: 5,
      area: secondSlot.area, cat: secondSlot.cat, d: secondSlot.d,
      by: u.name, uid: u.uid, at: now - 3600000
    };
    const bId = 'b_demo1';
    up[`bulletins/${bId}`] = { tab: '公告', cat: '全部', title: `${ctx.E.fmtD(firstSlot.d)} ${firstSlot.label || firstSlot.cat} 集合提醒`, body: '請當場服務道親提早 10 分鐘集合，並透過 M9 登記交通方式。', pin: true, by: u.name, at: now };
    const nId = 'n_demo1';
    up[`slotNotes/${firstSlot.id}/${nId}`] = { who: u.name, uid: u.uid, text: '週六梯次請提早 10 分鐘到集合點，車輛資訊已於依車次更新。', at: now };
    ctx.store.update(up);
    ctx.toast('已載入本機運行期模擬資料（出席、請假、共乘、點名、回饋與公告）');
  }

  /* ---------------- C1 調度台計算與畫面 ---------------- */
  function computeC1Alerts(winSlots, ctx) {
    const D = ctx.D();
    const dispatches = D.dispatch || {};
    const doneKeys = new Set(Object.values(dispatches).filter((x) => x && x.st === 'done' && x.alertKey).map((x) => x.alertKey));
    const ranks = ctx.allAreaLoadRank();
    const alerts = [];

    for (const s of winSlots) {
      const st = slotRsvpStats(s.id, ctx);
      const cp = (D.carpool || {})[s.id] || {};
      const cars = Object.values(cp.cars || {}).filter((c) => c && !c.cancelled);
      const freeCars = cars.filter((c) => {
        const taken = Object.values(cp.riders || {}).filter((r) => r && r.carId).length;
        return (c.seats || 0) > taken;
      });
      // 1. 交通未定
      if (st.carMiss > 0 && !doneKeys.has(`car_${s.id}`)) {
        alerts.push({
          key: `car_${s.id}`,
          kind: 'bad',
          tag: '交通未定',
          sid: s.id,
          area: s.area,
          d: s.d,
          title: `${ctx.E.fmtD(s.d)}（${ctx.WD[s.wd]}）${s.label || s.cat}：${st.carMiss} 人需要交通接送`,
          why: cars.length ? '目前車輛安排仍有未上車或原司機取消，請媒合空位或聯絡車隊。' : '本場尚無登入可用共乘車次，請小組長改用「線下安排」或徵求司機。',
          s1: { t: '同區道親車隊徵求', d: `複製上車地點與需求發至 ${s.area} 群組徵求順路司機`, b: '複製徵求並標記', mode: 'copy-car', extra: freeCars.length ? `現場還有 ${freeCars.length} 車可檢視 M10` : '' },
          s2: { t: '前往小組長車輛安排 (M10)', d: '手動指派車輛，或切換為「線下安排」避免重複提醒', href: `#/m10/${s.id}`, b: '前往 M10' },
          s3: { t: '大眾運輸加共乘說明', d: '產生集合時間與路線筆記貼到 M5 場次筆記', b: '寫入場次筆記', mode: 'note-transit' }
        });
      }
      // 2. 缺人或請假未補
      const availOk = st.crew.length - st.no;
      if ((availOk < st.need || st.no > 0) && !doneKeys.has(`short_${s.id}`)) {
        const deficit = Math.max(st.no, st.need - availOk);
        const curIds = new Set(st.crew.map((x) => x.pid));
        const sameAreaCands = ctx.M.people.filter((p) => p.a === s.area && !p.off && !curIds.has(p.id) && !ctx.evalSlotCand(p, s, curIds).hard.length).slice(0, 4);
        const lowArea = ranks.slice().sort((a, b) => a.avg - b.avg).find((r) => r.area !== s.area);
        const cpD = (D.carpool || {})[s.id] || {};
        const carsCount = Object.values(cpD.cars || {}).filter((c) => c && !c.cancelled).length;
        // 若無人開任何車次、且本區未設線下模式，僅於有 need_help 時才算急迫；若 someone leaves with '沒有交通', show reason to admins
        const leaveReasons = st.crew
          .filter((it) => it.rsvp && it.rsvp.st === 'no')
          .map((it) => {
            const rn = (((D.rsvpNote || {})[s.id] || {})[it.pid] || {});
            return rn.reason ? `${it.p.n}（${rn.reason}）` : it.p.n;
          });
        alerts.push({
          key: `short_${s.id}`,
          kind: availOk < st.need ? 'bad' : 'wn',
          tag: `缺 ${deficit} 人`,
          sid: s.id,
          area: s.area,
          d: s.d,
          title: `${ctx.E.fmtD(s.d)}（${ctx.WD[s.wd]}）${s.label || s.cat}：需 ${st.need} 人，可用 ${availOk}（已覆 ${st.ok}・請假 ${st.no}）`,
          why: (leaveReasons.length ? `請假人員：${leaveReasons.join('、')}。` : '') + (sameAreaCands.length ? `本區仍有 ${sameAreaCands.map((x) => x.n).join('、')} 等無衝突人員可聯絡替補。` : '本區當週可用人員較緊，可考慮跨區借調或確認最低人力。'),
          _carsCount: carsCount,
          s1: { t: '從本區推薦替補名單挑人', d: sameAreaCands.length ? `優先推薦：${sameAreaCands.map((x) => x.n).join('、')}` : '開啟 B4/B6 找人面板補齊', b: sameAreaCands.length ? `請 ${sameAreaCands[0].n} 替補` : '開啟排人', pid: sameAreaCands[0] ? sameAreaCands[0].id : 0, href: s.groupKey ? `#/g/${s.groupKey}` : `#/s/${s.id}`, mode: sameAreaCands.length ? 'assign-first' : '' },
          s2: { t: lowArea ? `向人均較低區借調（建議 ${lowArea.area}）` : '跨區調度借調', d: lowArea ? `${lowArea.area}區目前人均 ${lowArea.avg.toFixed(1)} 次，可發出借調通知` : '透過提案發起支援請求', b: '送出借調紀錄', href: `#/p/new?area=${encodeURIComponent(s.area)}&slot=${encodeURIComponent(s.id)}&type=${encodeURIComponent('合併支援')}` },
          s3: { t: '回報窗口降限或標為已協調', d: '經堂務處或區長確認後，留存調度處理紀錄', b: '標為已協調', mode: 'mark-done' }
        });
      }
      // 3. 主廚請假警示
      if (st.hasHeadNo && !doneKeys.has(`cook_${s.id}`)) {
        const subCook = ctx.M.people.find((p) => !p.off && ctx.E.isCookPerson(ctx.M, p) && !st.crew.some((x) => x.pid === p.id) && !ctx.evalSlotCand(p, s, new Set()).hard.length);
        alerts.push({
          key: `cook_${s.id}`,
          kind: 'wn',
          tag: '主廚請假',
          sid: s.id,
          area: s.area,
          d: s.d,
          title: `${ctx.E.fmtD(s.d)}（${ctx.WD[s.wd]}）${s.label || s.cat}：主廚／帶隊廚師請假`,
          why: '主廚不可由一般二廚未授權頂替，建議找同區大廚代理或改分菜制。',
          s1: { t: '請儲備主廚／大廚代理', d: subCook ? `建議詢問 ${subCook.n}（${subCook.a}）代理本場` : '到 B6/B4 找廚務大廚代理', b: subCook ? `通知 ${subCook.n}` : '前往組別', href: s.groupKey ? `#/g/${s.groupKey}` : `#/s/${s.id}`, mode: 'copy-cook', pid: subCook ? subCook.id : 0 },
          s2: { t: '改走分菜制（C2）', d: '每 2–3 人負責一道菜並通知班務組', href: '#/c2', b: '前往 C2 試算' },
          s3: { t: '標為已處理', d: '完成口頭聯繫後歸檔提醒', b: '標為已處理', mode: 'mark-done' }
        });
      }
    }
    alerts.sort((a, b) => (a.kind === 'bad' ? 0 : 1) - (b.kind === 'bad' ? 0 : 1) || a.d.localeCompare(b.d));
    return alerts;
  }

  function renderC1(ctx) {
    const a = ctx.defaultArea();
    if (!ctx.isAdmin()) {
      return `${ctx.wsHeader('R', 'c1', a)}<main class="wide-main"><section class="card warnbox"><h2>運行調度台限「排班總召／系統管理員」使用</h2><div class="acts"><a class="btn pri" href="#/m4">看本週服務 (M4)</a><a class="btn" href="#/">回我的首頁</a></div></section></main>`;
    }
    const baseD = RUI.c1Date || defaultBaseDate(ctx);
    const endD = addDays(baseD, 13);
    const live = liveSlotsSorted(ctx);
    const winSlots = live.filter((s) => s.d >= baseD && s.d <= endD);
    const alerts = computeC1Alerts(winSlots, ctx);

    let totalCrew = 0, totalOk = 0, totalWait = 0, totalNo = 0, totalCarMiss = 0, missSlotCnt = 0, carSlotCnt = 0;
    const dayRows = winSlots.map((s) => {
      const st = slotRsvpStats(s.id, ctx);
      totalCrew += Math.max(st.need, st.crew.length);
      totalOk += st.ok;
      totalWait += st.wait;
      totalNo += st.no;
      if (st.crew.length - st.no < st.need) { missSlotCnt++; totalCarMiss += 0; }
      if (st.carMiss > 0) { carSlotCnt++; totalCarMiss += st.carMiss; }
      const tot = Math.max(1, st.need, st.ok + st.wait + st.no);
      const w1 = Math.round((st.ok / tot) * 100);
      const w2 = Math.round((st.wait / tot) * 100);
      const w3 = Math.max(0, 100 - w1 - w2);
      return `<a class="row" href="#/m5/${h(s.id)}">
        <div class="row-h">
          <div><span class="num small">${h(ctx.E.fmtD(s.d))} ${h(ctx.WD[s.wd])}</span> <b>${h(s.label || s.cat)}</b> ${ctx.tag('no', s.area)}</div>
          <span class="num small ${st.ok < st.need ? 't-warn' : 't-ok'}">${st.ok}／${st.need}</span>
        </div>
        <div class="rt-bar" aria-label="已確認 ${st.ok}、未回覆 ${st.wait}、請假 ${st.no}">
          <span class="rt-b-ok" style="width:${w1}%"></span>
          <span class="rt-b-wn" style="width:${w2}%"></span>
          <span class="rt-b-bd" style="width:${w3}%"></span>
        </div>
      </a>`;
    }).join('');

    const okPct = totalCrew ? Math.round((totalOk / totalCrew) * 100) : 0;
    const shortPersons = winSlots.reduce((sum, s) => {
      const st = slotRsvpStats(s.id, ctx);
      return sum + Math.max(0, st.need - (st.crew.length - st.no));
    }, 0);

    const leaveForm = RUI.c1LeaveOpen ? `<section class="card warnbox">
      <div class="row-h"><h2>代填登記無法出席／請假</h2><button type="button" class="btn sm" data-act="rt-c1-leave-toggle">關閉</button></div>
      <div class="grid2">
        <label>選擇未來 14 天場次<select id="rtC1LeaveSid">${(winSlots.length ? winSlots : live.slice(0, 20)).map((s) => `<option value="${h(s.id)}">${h(ctx.dLabel(s))} ${h(s.label || s.cat)}（${h(s.area)}）</option>`).join('')}</select></label>
        <label>服務人員<select id="rtC1LeavePid">${ctx.M.people.filter((p) => !p.off).slice(0, 120).map((p) => `<option value="${p.id}">${h(p.n)}（${h(p.a)}）</option>`).join('')}</select></label>
      </div>
      <div class="grid2">
        <label>請假原因（寫入私密 rsvpNote）<select id="rtC1LeaveReason"><option>身體不適</option><option>家裡有事</option><option>工作請不了假</option><option>沒有交通</option></select></label>
        <label>補充備註<input id="rtC1LeaveNote" type="text" placeholder="例：已電話通知"></label>
      </div>
      <div class="acts"><button type="button" class="btn pri" data-act="rt-c1-leave-submit">寫入請假紀錄</button></div>
    </section>` : '';

    const dispatches = Object.entries(ctx.D().dispatch || {}).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 8);
    const reminds = [
      ['14 天前', '通知日期、地點、同組名單；請按「我會到」或「無法出席」', '【天達堂 116 服務 14 天前通知】本次名單與車次已更新，請至系統「我的服務」點選我會到或及早申請代班。'],
      ['3–5 天前', '確認共乘誰開車與上車點；未回覆者再發一次提醒', '【行前 3–5 天確認】請協助回覆是否需要交通接送，同車上車點請見服務詳情 (M5)。'],
      ['前 1 天', '重申集合時間與聯絡人；長輩或需要接送者多一通電話關懷', '【明日服務行前提醒】請準時於集合點會合，有變動請立即通知帶隊小組長。'],
      ['服務後', '請小組長進入 M3 填寫一分鐘點名與回饋', '【服務圓滿回饋】感恩各位付出！請帶隊小組長至「運行帶隊 → 點名回饋 (M3)」完成 1 分鐘點名與回饋。']
    ];

    return `${ctx.wsHeader('R', 'c1', a)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">C1 運行調度台 · 區間 ${h(rocRange(baseD, endD))}</div>
          <h1>未來 14 天有 ${alerts.length} 件事需要調度處理</h1>
          <p class="muted" style="margin:4px 0 0">依急迫程度排列；每件附上建議／其次／最後手段，點擊會同步記錄並複製聯絡文案。</p>
        </div>
        <div class="acts">
          ${ctx.store.mode === 'local' ? `<button type="button" class="btn sm pre-out" data-act="rt-seed-demo">載入運行模擬資料</button>` : ''}
          <button type="button" class="btn" data-act="rt-c1-leave-toggle">登記請假</button>
          <a class="btn pri" href="#/c2">登記需求變更 (C2)</a>
        </div>
      </div>

      <section class="card" style="padding:10px 14px">
        <div class="row-h">
          <div class="acts">
            <button type="button" class="btn sm" data-act="rt-c1-shift" data-delta="-14">← 上 14 天</button>
            <label style="flex-direction:row;align-items:center;gap:6px"><span class="small muted">起始日</span><input id="rtC1Date" type="date" value="${h(baseD)}" data-act-change="rt-c1-date"></label>
            <button type="button" class="btn sm" data-act="rt-c1-shift" data-delta="14">下 14 天 →</button>
          </div>
          <button type="button" class="btn sm pri-out" data-act="rt-c1-shift" data-delta="reset">回到最近有效場次</button>
        </div>
      </section>

      ${leaveForm}

      <section class="cmd-grid" aria-label="14天調度摘要">
        <div class="cmd-card"><div class="cmd-k">未來 14 天勤務</div><div class="cmd-v">${winSlots.length} <span class="small muted">場</span></div><div class="cmd-s">${h(rocRange(baseD, endD))}</div></div>
        <div class="cmd-card cmd-ok"><div class="cmd-k">已確認比例</div><div class="cmd-v">${okPct}%</div><div class="cmd-s">已覆會到 ${totalOk} 人次</div></div>
        <div class="cmd-card cmd-warn"><div class="cmd-k">尚未回覆</div><div class="cmd-v">${totalWait} <span class="small muted">人次</span></div><div class="cmd-s">前 3 天未覆建議電話提醒</div></div>
        <div class="cmd-card ${shortPersons ? 'cmd-bad' : ''}"><div class="cmd-k">缺人／待補</div><div class="cmd-v">${shortPersons} <span class="small muted">人</span></div><div class="cmd-s">影響 ${missSlotCnt} 格（含請假 ${totalNo}）</div></div>
        <div class="cmd-card ${totalCarMiss ? 'cmd-bad' : ''}"><div class="cmd-k">交通未定</div><div class="cmd-v">${totalCarMiss} <span class="small muted">人</span></div><div class="cmd-s">${carSlotCnt} 場需要協助接送</div></div>
      </section>

      <div class="split-grid">
        <div class="split-main">
          <div class="sec-h"><h2>急迫調度清單（${alerts.length}）</h2><a class="small" href="#/m4">對照本週公開視角 (M4) →</a></div>
          ${alerts.map((al) => `<article class="card rt-alert row-st-${al.kind === 'bad' ? 'bad' : 'wn'}">
            <div class="row-h">
              <div class="row-t">${ctx.tag(al.kind, al.tag)} <b class="c-${h(al.area)}">${h(al.area)}</b> <a href="#/m5/${h(al.sid)}" style="font-weight:700">${h(al.title)}</a></div>
              <button type="button" class="btn sm" data-act="rt-c1-done" data-key="${h(al.key)}" data-sid="${h(al.sid)}" data-title="${h(al.title)}">標為已處理</button>
            </div>
            <div class="muted small">${h(al.why)}</div>
            <div class="rt-step-grid">
              <div class="rt-plan">
                <div class="small"><b>建議做法：</b>${h(al.s1.t)}</div>
                <div class="muted small">${h(al.s1.d)}</div>
                ${al.s1.mode === 'assign-first' && al.s1.pid ? `<button type="button" class="btn sm pri" data-act="rt-c1-sub-first" data-key="${h(al.key)}" data-sid="${h(al.sid)}" data-pid="${al.s1.pid}">${h(al.s1.b)}</button>`
                  : al.s1.mode ? `<button type="button" class="btn sm pri" data-act="rt-c1-action" data-key="${h(al.key)}" data-sid="${h(al.sid)}" data-mode="${h(al.s1.mode)}" data-title="${h(al.s1.t)}">${h(al.s1.b)}</button>`
                  : `<a class="btn sm pri" href="${h(al.s1.href || '#/m5/' + al.sid)}">${h(al.s1.b)}</a>`}
              </div>
              <div class="rt-plan">
                <div class="small"><b>其次：</b>${h(al.s2.t)}</div>
                <div class="muted small">${h(al.s2.d)}</div>
                <a class="btn sm" href="${h(al.s2.href || '#/')}">${h(al.s2.b)}</a>
              </div>
              <div class="rt-plan">
                <div class="small"><b>最後手段：</b>${h(al.s3.t)}</div>
                <div class="muted small">${h(al.s3.d)}</div>
                <button type="button" class="btn sm" data-act="rt-c1-done" data-key="${h(al.key)}" data-sid="${h(al.sid)}" data-title="${h(al.s3.t)}">${h(al.s3.b)}</button>
              </div>
            </div>
          </article>`).join('') || '<section class="card"><div class="empty">這 14 天內沒有急迫待處理的調度異常！</div></section>'}
        </div>

        <aside class="split-side">
          <section class="card">
            <div class="row-h"><h2>未來 14 天一覽</h2><span class="muted small">綠已覆 · 橘待覆 · 紅請假</span></div>
            <div class="list">${dayRows || '<div class="empty">此 14 天區間沒有安排勤務格</div>'}</div>
          </section>
          <section class="card">
            <h2>自動提醒節點（點擊複製文案）</h2>
            ${reminds.map(([w, desc, msg]) => `<div class="bind-hit">
              <div><b>${h(w)}</b><div class="muted small">${h(desc)}</div></div>
              <button type="button" class="btn sm" data-act="rt-copy" data-text="${h(msg)}">複製</button>
            </div>`).join('')}
          </section>
          <section class="card">
            <h2>近期調度異動</h2>
            ${dispatches.map(([, dp]) => `<div class="logrow"><span class="num small">${h(ctx.ago(dp.at))}</span> <b>${h(dp.by || '')}</b> ${h(dp.title)} · ${h(dp.action)}</div>`).join('') || '<div class="empty">尚無運行調度紀錄</div>'}
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- C2 需求變更處理 ---------------- */
  function allChangesList(ctx) {
    const map = new Map();
    for (const c of DEFAULT_CHANGES) map.set(c.id, Object.assign({}, c));
    for (const [id, c] of Object.entries(ctx.D().changes || {})) {
      if (c && typeof c === 'object') map.set(id, Object.assign({}, map.get(id) || {}, c, { id }));
    }
    return [...map.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  function renderC2(ctx) {
    const area = ctx.defaultArea();
    if (!ctx.isAdmin()) {
      return `${ctx.wsHeader('R', 'c2', area)}<main class="wide-main"><section class="card warnbox"><h2>需求變更處理限總召或系統管理員</h2><a class="btn pri" href="#/">回首頁</a></section></main>`;
    }
    const list = allChangesList(ctx);
    const cur = list.find((c) => c.id === RUI.c2Sel) || list[0];
    if (cur) RUI.c2Sel = cur.id;

    const addForm = RUI.c2AddOpen ? `<section class="card warnbox">
      <div class="row-h"><h2>新增需求變更</h2><button type="button" class="btn sm" data-act="rt-c2-add-toggle">關閉</button></div>
      <div class="grid2">
        <label>變更類型<select id="rtC2Kind"><option>新增活動</option><option>取消或合併</option><option>改期</option><option>與其他單位互換</option><option>調整人數或角色</option><option>改地點</option><option>臨時協辦</option></select></label>
        <label>承辦單位<select id="rtC2Area">${ctx.WORK_AREAS.map((a) => `<option>${h(a)}</option>`).join('')}</select></label>
      </div>
      <label>變更說明標題<input id="rtC2Title" type="text" placeholder="例：5/15 青年志工培訓廚務"></label>
      <div class="grid2">
        <label>來源窗口<input id="rtC2Src" type="text" placeholder="例：行事曆修訂版"></label>
        <label>影響日期（逗號或空白隔開 YYYY-MM-DD）<input id="rtC2Dates" type="text" placeholder="2027-05-15"></label>
      </div>
      <label>詳細需求說明<textarea id="rtC2Detail" rows="2" placeholder="需廚務／服務幾人、有無衝突等"></textarea></label>
      <button type="button" class="btn pri" data-act="rt-c2-add">建立變更項目</button>
    </section>` : '';

    const importBox = RUI.c2ImportOpen ? `<section class="card">
      <div class="row-h"><h2>匯入新版行事曆差異比對</h2><button type="button" class="btn sm" data-act="rt-c2-import-toggle">關閉</button></div>
      <div class="muted small">貼上新版行事曆日期與活動（每行格式：<code>YYYY-MM-DD 活動名稱</code>），系統只列出差異不覆蓋已排定人員。</div>
      <textarea id="rtC2ImportTxt" rows="4" placeholder="2027-08-14 心靈成長班 2.0&#10;2027-09-25 秋季讀經觀摩"></textarea>
      <div class="acts"><button type="button" class="btn pri" data-act="rt-c2-import-run">比對現有 221 格差異</button></div>
      ${RUI.c2ImportDiff ? `<div class="list" style="margin-top:6px">${RUI.c2ImportDiff.map((it) => `<div class="bind-hit"><div><b class="num">${h(it.d)}</b> ${h(it.name)}<div class="muted small">${it.sameCount ? `當日已有 ${it.sameCount} 格勤務` : '現有行事曆當日為空（全新新增）'}</div></div>
        <button type="button" class="btn sm pri-out" data-act="rt-c2-import-create" data-d="${h(it.d)}" data-name="${h(it.name)}">轉入變更清單</button></div>`).join('')}</div>` : ''}
    </section>` : '';

    const curDates = cur && Array.isArray(cur.dates) ? cur.dates : [];
    const dateAnalysis = curDates.map((dStr) => {
      const same = ctx.M ? ctx.M.slots.filter((s) => !s.cancel && s.d === dStr) : [];
      const wStart = addDays(dStr, -7), wEnd = addDays(dStr, 7);
      const near = ctx.M ? ctx.M.slots.filter((s) => !s.cancel && s.d !== dStr && s.d >= wStart && s.d <= wEnd && /廚|服務|忠恕/.test(s.cat)) : [];
      const busyGroups = new Set(near.map((s) => s.groupKey).filter(Boolean));
      const freeGroups = ctx.BASE.groupsMeta.filter((g) => !busyGroups.has(g.id)).slice(0, 3).map((g) => g.name);
      return {
        dStr,
        sameTxt: same.map((s) => `${s.area} ${s.label || s.cat}`).join('；') || '無同日衝突勤務',
        nearTxt: near.slice(0, 3).map((s) => `${ctx.E.fmtD(s.d)} ${s.area}${s.cat}`).join('；') || '前後 7 天無密集班次',
        canTxt: freeGroups.join('、') || '機動組或分菜制'
      };
    });

    const plans = cur ? [
      { id: '甲', tag: '集中支援', cls: 'wn', t: `甲、由機動組／${cur.area || '本區'}直接承接`, d: `直接建立勤務格交由固定組承接。`, v: 0, w: curDates.length || 1, note: '優點：統一指揮；留意該單位全年上限次數。' },
      { id: '乙', tag: '相鄰調度', cls: 'bd', t: '乙、由鄰近日別已出勤之組別兼任', d: '由該週六日已在場班底提前一天或順延服務。', v: 0, w: (curDates.length || 1) + 1, note: '連兩天出勤疲勞度較高，建議僅作為備案。' },
      { id: '丙', tag: '建議', cls: 'ok', t: '丙、分菜制或單場認領（儲備幹部 1 位指導）', d: '不佔用固定廚務組全年配額，降低連日疲勞與跨區衝突。', v: 0, w: 0, note: '不增加既有固定組違規；需班務／主辦單位配合提供人力。' }
    ] : [];

    return `${ctx.wsHeader('R', 'c2', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">C2 需求變更處理 · 行事曆異動與承接試算</div>
          <h1>年度途中需求變更管理</h1>
          <p class="muted" style="margin:4px 0 0">逐筆比對同日／前後七天勤務，先比較甲乙丙承接方案，選定後再建立勤務格或轉為正式提案。</p>
        </div>
        <div class="acts">
          <button type="button" class="btn" data-act="rt-c2-import-toggle">匯入新版行事曆比對</button>
          <button type="button" class="btn pri" data-act="rt-c2-add-toggle">＋ 新增變更</button>
          <a class="btn" href="#/c1">← 回調度台 (C1)</a>
        </div>
      </div>

      ${addForm}${importBox}

      <div class="split-grid">
        <aside class="split-side">
          <section class="card">
            <h2>變更清單（${list.length}）</h2>
            <div class="list">
              ${list.map((c) => {
                const stCls = c.status === '已套用' ? 'ok' : c.status === '討論中' ? 'pl' : 'wn';
                const on = cur && c.id === cur.id;
                return `<button type="button" class="row ${on ? 'row-sel' : ''}" data-act="rt-c2-pick" data-id="${h(c.id)}">
                  <div class="row-h"><span class="small muted">${h(c.kind)} · ${h(c.src || '')}</span>${ctx.tag(stCls, c.status)}</div>
                  <b>${h(c.title)}</b>
                  <div class="muted small">${h(c.area || '')}${c.chosen ? ` · 已選方案 ${h(c.chosen)}` : ''}</div>
                </button>`;
              }).join('')}
            </div>
          </section>
        </aside>

        <div class="split-main">
          ${cur ? `<section class="card">
            <div class="row-h">
              <div><div class="muted small">${h(cur.kind)} · ${h(cur.src || '')}</div><h2 style="font-size:20px">${h(cur.title)}</h2></div>
              ${ctx.tag(cur.status === '已套用' ? 'ok' : 'wn', cur.status)}
            </div>
            <p class="muted" style="margin:0">${h(cur.detail || '')}</p>
            <div class="kv-row"><b>需要勤務</b><span>${h(cur.needKind || '廚務')} · 預定承辦：${h(cur.area || '機動')}</span></div>
            <div class="kv-row"><b>影響日期</b><span>${curDates.map((d) => ctx.E.fmtD(d)).join('、') || '尚未指定具體日期'}</span></div>
          </section>

          <section class="card">
            <h2>2. 影響日期現況檢查（真實讀取總表）</h2>
            <div class="table-wrap"><table class="tbl"><thead><tr><th>日期</th><th>同日已有勤務</th><th>前後七天相關班次</th><th>可承接組別參考</th></tr></thead>
              <tbody>${dateAnalysis.map((x) => `<tr><td class="num">${h(ctx.E.fmtD(x.dStr))}</td><td>${h(x.sameTxt)}</td><td>${h(x.nearTxt)}</td><td>${h(x.canTxt)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">尚無指定日期</td></tr>'}</tbody></table></div>
          </section>

          <section class="card">
            <h2>3. 承接方案比較與決定</h2>
            <div class="cmd-grid">
              ${plans.map((p) => {
                const picked = cur.chosen === p.id;
                return `<div class="card" style="${picked ? 'border:2px solid var(--accent);background:var(--accent-soft)' : ''}">
                  <div class="row-h"><b>${h(p.t)}</b>${ctx.tag(p.cls, p.tag)}</div>
                  <div class="muted small">${h(p.d)}</div>
                  <div class="small">新增違規 <b>${p.v}</b> · 新增注意 <b>${p.w}</b></div>
                  <div class="muted small">${h(p.note)}</div>
                  <button type="button" class="btn sm ${picked ? 'pri' : 'pri-out'}" data-act="rt-c2-choose" data-id="${h(cur.id)}" data-opt="${p.id}">${picked ? '✓ 已選此方案' : '選這個方案'}</button>
                </div>`;
              }).join('')}
            </div>
            <div class="acts" style="margin-top:6px">
              ${curDates[0] ? `<button type="button" class="btn pri" data-act="rt-c2-apply-extra" data-id="${h(cur.id)}">為第一個影響日 (${h(ctx.E.fmtD(curDates[0]))}) 新增勤務格 (extra)</button>` : ''}
              <a class="btn blue-out" href="#/p/new?area=${encodeURIComponent(cur.area || area)}&type=${encodeURIComponent('新單位認領')}">轉為正式 B2 多方案提案 →</a>
            </div>
          </section>

          <section class="card">
            <h2>4. 選定後標準流程</h2>
            <ol style="margin:0;padding-left:20px;font-size:14px;display:flex;flex-direction:column;gap:4px">
              <li><b>建立勤務格</b>：由系統寫入 <code>extra</code> 並標來源窗口。</li>
              <li><b>相關單位回覆</b>：距離超過 14 天通知區長，不到 14 天直入 C1 調度台待辦。</li>
              <li><b>排入人員</b>：於 B4/B6 依規則檢查排入人員。</li>
              <li><b>三階段通知與紀錄</b>：透過 M4/M7/M9 完成行前與接送安排。</li>
            </ol>
          </section>` : '<section class="card"><div class="empty">請從左側選擇一筆變更項目</div></section>'}
        </div>
      </div>
    </main>`;
  }

  /* ---------------- C3 回饋與年度檢討 ---------------- */
  function computeC3Data(ctx) {
    const M = ctx.M;
    const D = ctx.D();
    const ISS = ctx.ISS || [];
    let w7Cnt = 0, activePeople = 0, totalAss = 0, top20Pct = 0, wd4Cnt = 0, newbieCnt = 0;
    const w7Pids = new Set();
    for (const c of ISS) if (c.rule === 'P3' && c.pid != null) { w7Cnt++; w7Pids.add(c.pid); }
    const occCounts = [];
    if (M) {
      for (const p of M.people) {
        const slots = M.personSlots[p.id] || [];
        const occ = ctx.E.occasions(slots).length;
        if (occ > 0) {
          activePeople++;
          totalAss += occ;
          occCounts.push(occ);
          if (!p.n115) newbieCnt++;
          const wdDays = new Set(slots.filter((s) => s.wd >= 1 && s.wd <= 5 && !s.hol).map((s) => s.d)).size;
          if (wdDays >= 4) wd4Cnt++;
        }
      }
      occCounts.sort((a, b) => b - a);
      const k20 = Math.max(1, Math.ceil(occCounts.length * 0.2));
      const sumTop = occCounts.slice(0, k20).reduce((a, b) => a + b, 0);
      top20Pct = totalAss ? Math.round((sumTop / totalAss) * 100) : 0;
    }
    const fbs = Object.entries(D.feedback || {}).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const okMin = fbs.filter(([, f]) => f && f.headcount !== '不足').length;
    const nowVals = {
      w7: activePeople ? `${w7Cnt} 次 · ${w7Pids.size} 人` : '—',
      avg: activePeople ? `${(totalAss / activePeople).toFixed(1)} 次` : '—',
      top20: activePeople ? `${top20Pct}%` : '—',
      wd4: `${wd4Cnt} 人`,
      newbie: `${newbieCnt} 人`,
      minok: fbs.length ? `${okMin}／${fbs.length} 場達標` : '累計中（待 M3 回饋）'
    };

    // 根據真實 feedback 與 checkin 自動產生系統檢討建議，並合併代表性規則建議
    const sugs = [];
    const lackFbs = fbs.filter(([, f]) => f && f.headcount === '不足');
    const carFbs = fbs.filter(([, f]) => f && f.transport && f.transport !== '順利');
    const heavyFbs = fbs.filter(([, f]) => f && f.workload === '偏重');
    if (lackFbs.length) sugs.push({ id: 'SUG_FB_LACK', cls: 'wn', kind: '實到不足', t: `已有 ${lackFbs.length} 場回饋人數不足`, ev: lackFbs.map(([, f]) => `${f.d} ${f.cat}(${f.area})`).slice(0, 3).join('、'), act: '檢視相關勤務需求下限，或設定事前支援梯次' });
    if (carFbs.length) sugs.push({ id: 'SUG_FB_CAR', cls: 'bd', kind: '交通', t: `${carFbs.length} 場回饋交通為臨時安排或有人沒車`, ev: carFbs.map(([, f]) => `${f.d} ${f.cat}(${f.area})`).slice(0, 3).join('、'), act: '平日或偏遠班次優先於 M10 指派固定接駁司機或包車' });
    if (heavyFbs.length) sugs.push({ id: 'SUG_FB_HEAVY', cls: 'pl', kind: '工作量', t: `${heavyFbs.length} 場回饋工作量偏重`, ev: heavyFbs.map(([, f]) => `${f.d} ${f.cat}`).slice(0, 3).join('、'), act: '明年度考量拆組、增加新人見習或調整分菜制' });

    const ckAll = D.checkin || {};
    const missByPid = {};
    for (const sid of Object.keys(ckAll)) {
      for (const pid of Object.keys(ckAll[sid] || {})) {
        if (ckAll[sid][pid] && ckAll[sid][pid].here === false) missByPid[pid] = (missByPid[pid] || 0) + 1;
      }
    }
    const repeatMiss = Object.entries(missByPid).filter(([, n]) => n >= 2);
    if (repeatMiss.length) {
      sugs.push({ id: 'SUG_CK_MISS', cls: 'pl', kind: '人員', t: `${repeatMiss.length} 位道親點名未到達 2 次以上`, ev: '依據 M3 點名紀錄彙整', act: '請區長於 A3 關懷確認體力或改為少量排班' });
    }

    sugs.push(
      { id: 'SUG_A5_W7', cls: 'wn', kind: '規則', t: '第 3、4 週日與連續出勤疲勞提醒', ev: `目前總表 7 天內重複共 ${w7Cnt} 次`, act: '於 A4 將間隔注意門檻由 8 天提高至 14 天' },
      { id: 'SUG_DIV', cls: 'ok', kind: '做法', t: '中小型班次明理班廚務採分菜制', ev: '減輕固定廚務組連班壓力、主廚不需全程在場', act: '117 年明理班中小型梯次預設採分菜制' }
    );
    return { nowVals, fbs, sugs };
  }

  function renderC3(ctx) {
    const area = ctx.defaultArea();
    if (!ctx.isAdmin()) {
      return `${ctx.wsHeader('R', 'c3', area)}<main class="wide-main"><section class="card warnbox"><h2>回饋與年度檢討限總召或系統管理員</h2><a class="btn pri" href="#/">回首頁</a></section></main>`;
    }
    const { nowVals, fbs, sugs } = computeC3Data(ctx);
    const rev = ctx.D().review || {};
    const targets = rev.targets || {};
    const decisions = rev.decisions || {};

    return `${ctx.wsHeader('R', 'c3', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">C3 回饋與年度檢討 · 從 116 實際出勤回饋至 117 草案</div>
          <h1>每次服務的回饋，累積成明年的規則</h1>
          <p class="muted" style="margin:4px 0 0">小組長於 M3 填寫的一分鐘點名與回饋會自動彙整至此；總召可直接決定哪些納入 117 年規則草案。</p>
        </div>
        <div class="acts">
          <button type="button" class="btn" data-act="rt-c3-export-csv">匯出年度回饋 (CSV)</button>
          <button type="button" class="btn pri-out" data-act="rt-c3-export-json">匯出 117 規則檢討 (JSON)</button>
          <a class="btn pri" href="#/a4">前往 A4 規則設定</a>
        </div>
      </div>

      <section class="card">
        <div class="row-h"><h2>年度指標：和 115 年比</h2><button type="button" class="btn sm pri" data-act="rt-c3-save-targets">儲存 116 目標</button></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>指標</th><th>115 年實際</th><th>116 年目標（可自訂）</th><th>116 年至今</th><th>怎麼算</th></tr></thead>
          <tbody>${REVIEW_115_METRICS.map((m) => `<tr>
            <td><b>${h(m.k)}</b></td>
            <td class="num">${h(m.v115)}</td>
            <td><input id="rtC3Tgt-${h(m.key)}" type="text" value="${h(targets[m.key] || '')}" placeholder="輸入目標例：↓30%"></td>
            <td class="num"><b>${h(nowVals[m.key])}</b></td>
            <td class="muted small">${h(m.hint)}</td>
          </tr>`).join('')}</tbody></table></div>
      </section>

      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <div class="row-h"><h2>系統整理的調整建議（${sugs.length}）</h2><span class="muted small">標為「放進 117 草案」將同步納入匯出 JSON</span></div>
            <div class="list">
              ${sugs.map((s) => {
                const dec = decisions[s.id] || '';
                const dCls = dec === '放進 117 草案' ? 'ok' : dec === '再觀察' ? 'wn' : dec === '不採用' ? 'no' : '';
                return `<div class="mem">
                  <div class="row-h"><div>${ctx.tag(s.cls, s.kind)} <b>${h(s.t)}</b></div>${dec ? ctx.tag(dCls, dec) : ''}</div>
                  <div class="muted small">依據：${h(s.ev)}</div>
                  <div class="small"><b>建議做法：</b>${h(s.act)}</div>
                  <div class="acts" style="margin-top:4px">
                    ${['放進 117 草案', '再觀察', '不採用'].map((opt) => `<button type="button" class="btn sm ${dec === opt ? 'pri' : ''}" data-act="rt-c3-decide" data-id="${h(s.id)}" data-v="${h(opt)}">${h(opt)}</button>`).join('')}
                  </div>
                </div>`;
              }).join('')}
            </div>
          </section>

          <section class="card">
            <div class="row-h"><h2>最近的服務後回饋（${fbs.length} 筆）</h2><a class="small" href="#/m3">前往 M3 填寫示範 →</a></div>
            ${fbs.map(([sid, f]) => {
              const s = ctx.M && ctx.M.byId[sid];
              const pCls = f.headcount === '剛好' ? 'ok' : f.headcount === '不足' ? 'bad' : 'wn';
              const tCls = f.transport === '順利' ? 'ok' : 'wn';
              const wCls = f.workload === '剛好' ? 'ok' : f.workload === '偏重' ? 'wn' : 'no';
              return `<div class="mem">
                <div class="row-h"><div><span class="num small">${h(f.d || (s && s.d) || '')}</span> <b>${h(s ? (s.label || s.cat) : sid)}</b> <b class="c-${h(f.area || '')}">${h(f.area || '')}</b></div>
                  <span class="num small">${f.hereCnt || 0}／${f.totalCnt || 0} 人</span></div>
                <div class="row-t">${ctx.tag(pCls, '人數 ' + (f.headcount || '—'))}${ctx.tag(tCls, '交通 ' + (f.transport || '—'))}${ctx.tag(wCls, '工作量 ' + (f.workload || '—'))}</div>
                ${f.note ? `<div class="small muted">${h(f.note)}</div>` : ''}
              </div>`;
            }).join('') || '<div class="empty">尚未收到 M3 服務後回饋。小組長點名完提交一分鐘回饋後會即時顯示於此。</div>'}
          </section>
        </div>

        <aside class="split-side">
          <section class="card">
            <h2>回饋會自動更新什麼</h2>
            <div class="kv-row"><b>個人狀態</b><span class="muted">連 3 次未到或體力負荷，提醒區長於 A3 調整限量或照護設定。</span></div>
            <div class="kv-row"><b>需求模板</b><span class="muted">比較每類勤務實到人數與「人數夠嗎」回饋，修正下年度需求下限。</span></div>
            <div class="kv-row"><b>搭檔合作分數</b><span class="muted">依實際同場點名紀錄每年重算。</span></div>
            <div class="kv-row"><b>常用司機與接送</b><span class="muted">累積 M9/M10 車次記錄，明年自動優先配車。</span></div>
            <div class="kv-row"><b>117 規則草案</b><span class="muted">左側勾選「放進 117 草案」的建議可直接匯出供籌備會拍板。</span></div>
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- M1 嵌入式元件（配合 app.js vMyService） ---------------- */
  function renderM1Hero(p, nextSlot, ctx) {
    if (!p || !nextSlot) return '';
    const rsvpMap = (ctx.D().rsvp || {})[nextSlot.id] || {};
    const myRv = rsvpMap[p.id] || null;
    const isSub = myRv && myRv.st === 'sub';
    const stTag = myRv
      ? (myRv.st === 'ok' ? ctx.tag('ok', '✓ 已回覆會到') : myRv.st === 'sub' ? ctx.tag('ok', `代班中（原 ${myRv.origName || '夥伴'}）`) : ctx.tag('bad', '已報無法出席'))
      : ctx.tag('wn', '尚未回覆出席');
    const cp = (ctx.D().carpool || {})[nextSlot.id] || {};
    const rd = (cp.riders || {})[p.id];
    const car = rd && rd.carId && (cp.cars || {})[rd.carId];
    let transTxt = cp.mode === 'offline' ? '小組線下安排' : '尚未填寫交通';
    if (rd) {
      if (rd.mode === 'bus') transTxt = '交通車或公車';
      else if (rd.mode === 'ride_self') transTxt = '已有人載';
      else if (rd.mode === 'drive') transTxt = '自己開車';
      else if (rd.mode === 'need_help') transTxt = '已通知需要交通協助';
      else if (rd.mode === 'carpool') transTxt = car ? `搭 ${car.driverName} 的車（${rd.status === 'ok' ? '已確認' : '待確認'}）` : '已申請共乘';
    }
    const leadP = nextSlot.groupKey ? ctx.groupLead(nextSlot.groupKey) : null;
    const drvCars = personDrivingCars(ctx).filter((x) => x.sid === nextSlot.id);
    return `<div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
      <div class="kv-row"><b>出席狀態</b><span>${stTag} ${isSub ? `<span class="small t-ok">感謝您協助代班！</span>` : ''}</span></div>
      <div class="kv-row"><b>交通安排</b><span>${h(transTxt)} <a class="small" href="#/m9/${h(nextSlot.id)}">填寫／更改 (M9)</a></span></div>
      ${leadP ? `<div class="kv-row"><b>帶隊幹部</b><span>${h(leadP.n)}（${h(nextSlot.area)}）</span></div>` : ''}
      <div class="acts" style="margin-top:4px">
        <button type="button" class="btn sm ${myRv && myRv.st === 'ok' ? 'pri' : 'pri-out'}" data-act="rt-rsvp" data-sid="${h(nextSlot.id)}" data-pid="${p.id}" data-st="ok">${myRv && myRv.st === 'ok' ? '✓ 我會到' : '我會到'}</button>
        <a class="btn sm ${myRv && myRv.st === 'no' ? 'warn' : ''}" href="#/m2/${h(nextSlot.id)}?pid=${p.id}">無法出席 (M2)</a>
        <a class="btn sm" href="#/m9/${h(nextSlot.id)}?pid=${p.id}">這一場怎麼去 (M9)</a>
        <a class="btn sm" href="#/m5/${h(nextSlot.id)}">看同組名單與車次 (M5)</a>
        ${drvCars.length ? `<a class="btn sm blue-out" href="#/m11/${h(nextSlot.id)}/${h(drvCars[0].cid)}">我開的車 (M11)</a>` : ''}
      </div>
    </div>`;
  }

  function renderM1SlotBadge(p, s, ctx) {
    if (!p || !s) return '';
    const rv = ((ctx.D().rsvp || {})[s.id] || {})[p.id];
    const rvTag = rv
      ? (rv.st === 'ok' ? ctx.tag('ok', '會到') : rv.st === 'sub' ? ctx.tag('ok', '代班') : ctx.tag('bad', '無法出席'))
      : '';
    return rvTag;
  }

  function renderM1Footer(p, ctx) {
    if (!p) return '';
    const invites = computePendingSubInvites(p, ctx);
    const drv = personDrivingCars(ctx);
    const invHtml = invites.length ? `<section class="card warnbox" style="margin-top:8px">
      <h2>有同組夥伴請您代班（${invites.length}）</h2>
      ${invites.map((it) => `<div class="bind-hit">
        <div><b>${h(ctx.dLabel(it.s))}${h(it.s.label || it.s.cat)}</b><div class="muted small">${h(it.origName)} 無法出席，邀請您支援這場</div></div>
        <button type="button" class="btn sm pri" data-act="rt-sub-accept" data-sid="${h(it.sid)}" data-pid="${p.id}" data-orig="${it.origPid}">我願意代班</button>
      </div>`).join('')}
    </section>` : '';

    const drvHtml = drv.length ? `<section class="card" style="margin-top:8px">
      <div class="row-h"><h2>我開的車（司機專區 M11）</h2><a class="small" href="#/m11">全部駕駛場次 →</a></div>
      ${drv.map((x) => `<div class="bind-hit"><div><b>${h(ctx.dLabel(x.s))}${h(x.s.label || x.s.cat)}</b><div class="muted small">${h(x.car.pickup || '待填上車地點')} · 可載 ${x.car.seats} 位</div></div>
        <a class="btn sm pri-out" href="#/m11/${h(x.sid)}/${h(x.cid)}">管理乘客 →</a></div>`).join('')}
    </section>` : '';

    const leadQuick = ctx.isAdmin() || ctx.myAreas().length
      ? `<section class="card" style="margin-top:8px">
          <div class="row-h"><h2>小組長／幹部現場工具</h2><span class="muted small">點名與車次協調</span></div>
          <div class="acts"><a class="btn sm pri-out" href="#/m3">當日點名與回饋 (M3)</a><a class="btn sm blue-out" href="#/m10">車輛安排 (M10)</a></div>
        </section>` : '';

    return invHtml + drvHtml + leadQuick;
  }

  /* ---------------- M2 志工：無法出席 ---------------- */
  function renderM2(arg, ctx) {
    const [sidRaw, qs] = String(arg || '').split('?');
    const sid = ctx.RE_SID.test(sidRaw) ? sidRaw : '';
    const q = new URLSearchParams(qs || '');
    const bp = ctx.myBoundPerson();
    const pidParam = +q.get('pid') || 0;
    const p = (pidParam && ctx.M && ctx.M.pById[pidParam]) || (bp && ctx.boundOk(bp) ? bp.p : null);
    const s = sid && ctx.M ? ctx.M.byId[sid] : null;
    const area = (s && s.area) || (p && p.a) || ctx.defaultArea();

    if (!ctx.me() || !p || !s) {
      return `${ctx.wsHeader('R', 'm2', area)}<main class="wide-main"><section class="card warnbox">
        <h2>無法出席請假申請 (M2)</h2>
        <div class="muted small">${!ctx.me() ? '請先登入並綁定姓名後再填寫。' : '請從「我的服務」挑選要異動的場次。'}</div>
        <div class="acts"><a class="btn pri" href="#/my">回我的服務</a><a class="btn" href="#/m4">看本週服務</a></div>
      </section></main>`;
    }

    const curIds = new Set(effectiveSlotCrew(sid, ctx).map((x) => x.pid));
    const subCands = ctx.M.people
      .filter((x) => x.id !== p.id && !x.off && !curIds.has(x.id) && x.a === s.area && !ctx.evalSlotCand(x, s, curIds).hard.length)
      .slice(0, 5);
    const reasons = ['身體不適', '家裡有事', '工作請不了假', '沒有交通'];
    const leadP = s.groupKey ? ctx.groupLead(s.groupKey) : null;

    return `${ctx.wsHeader('R', 'm2', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">M2 無法出席回報 · <b>${h(p.n)}</b></div>
          <h1>${h(ctx.dLabel(s))} ${h(s.label || s.cat)}</h1>
        </div>
        <a class="btn" href="#/my">← 回我的服務</a>
      </div>

      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <h2>1. 原因（只有小組長／調度台看得到，不會公開）</h2>
            <div class="rt-pill-group">
              ${reasons.map((r) => `<button type="button" class="chip ${RUI.m2Reason === r ? 'on' : ''}" data-act="rt-m2-reason" data-v="${h(r)}">${h(r)}</button>`).join('')}
            </div>
            <label>補充說明（選填）<input id="rtM2Note" type="text" placeholder="例：臨時出差、家中有長輩需照顧"></label>
          </section>

          <section class="card">
            <h2>2. 誰可以代班（同區且當天無衝突候選）</h2>
            <div class="muted small">按「請他代班」系統會登記代班人並複製邀請訊息給您轉傳 LINE。</div>
            <div class="list">
              ${subCands.map((c) => {
                const occ = ctx.E.occasions(ctx.M.personSlots[c.id] || []).length;
                return `<div class="bind-hit">
                  <div><b>${h(c.n)}</b> <span class="muted small">${h(c.a)}${c.zr ? ' · 曾任忠恕輪值' : ''} · 今年已排 ${occ} 次</span></div>
                  <button type="button" class="btn sm pri" data-act="rt-m2-sub" data-sid="${h(sid)}" data-pid="${p.id}" data-sub="${c.id}">請他代班</button>
                </div>`;
              }).join('') || '<div class="muted small">暫無推薦替補人選，請直接交給小組長或調度台協調。</div>'}
            </div>
          </section>
        </div>

        <aside class="split-side">
          <section class="card">
            <h2>不知道找誰？</h2>
            <div class="muted small">交給${leadP ? `小組長 <b>${h(leadP.n)}</b>` : `${h(s.area)} 區長／調度台`}統籌安排；越早送出越好找人。</div>
            <button type="button" class="btn pri big" data-act="rt-m2-submit" data-sid="${h(sid)}" data-pid="${p.id}">送出無法出席通知</button>
            <div class="muted small" style="margin-top:6px">若未來整段期間都不方便，請於 <a href="#/my">我的服務</a> 點選告知不方便的月份。</div>
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- M3 小組長：當日點名與回饋 ---------------- */
  function renderM3(arg, ctx) {
    const sidArg = String(arg || '').split('?')[0];
    const live = liveSlotsSorted(ctx);
    const myAs = ctx.myAreas();
    const candSlots = (myAs.length && !ctx.isAdmin())
      ? live.filter((s) => myAs.includes(s.area))
      : live;
    const slots = candSlots.length ? candSlots : live;
    const baseD = defaultBaseDate(ctx);
    const nearDefault = slots.find((s) => s.d >= baseD) || slots[0];
    const sid = (ctx.RE_SID.test(sidArg) && ctx.M && ctx.M.byId[sidArg]) ? sidArg : (RUI.m3Slot && ctx.M && ctx.M.byId[RUI.m3Slot] ? RUI.m3Slot : (nearDefault ? nearDefault.id : ''));
    RUI.m3Slot = sid;
    const s = sid && ctx.M ? ctx.M.byId[sid] : null;
    const area = (s && s.area) || ctx.defaultArea();

    const canDo = ctx.me() && (ctx.isAdmin() || ctx.myAreas().length > 0);
    if (!canDo) {
      return `${ctx.wsHeader('R', 'm3', area)}<main class="wide-main"><section class="card warnbox">
        <h2>小組長當日點名與回饋 (M3)</h2>
        <div class="muted small">請登入且由區長／總召指派為排班幹部後即可為場次進行現場點名與回饋。</div>
        <div class="acts"><a class="btn pri" href="#/m5/${h(sid || '')}">查看服務詳情 (M5)</a><a class="btn" href="#/">回首頁</a></div>
      </section></main>`;
    }
    if (!s) return `${ctx.wsHeader('R', 'm3', area)}<main class="wide-main"><section class="card"><div class="empty">目前尚無場次資料。</div></section></main>`;

    const crew = effectiveSlotCrew(s.id, ctx);
    const ck = (ctx.D().checkin || {})[s.id] || {};
    const cp = (ctx.D().carpool || {})[s.id] || {};
    const cars = cp.cars || {};
    const riders = cp.riders || {};
    const fbPrev = (ctx.D().feedback || {})[s.id] || null;
    const ans = fbPrev ? { 0: fbPrev.headcount || '剛好', 1: fbPrev.transport || '順利', 2: fbPrev.workload || '剛好' } : RUI.m3Ans;
    if (fbPrev) Object.assign(RUI.m3Ans, ans);

    let hereCnt = 0;
    const crewRows = crew.map((it) => {
      const c = ck[it.pid];
      const on = !!(c && c.here);
      if (on) hereCnt++;
      const rd = riders[it.pid];
      const car = rd && rd.carId && cars[rd.carId];
      const carStatus = car && car.status ? ` · 司機：${car.status}` : '';
      return `<button type="button" class="rt-checkin-row ${on ? 'here' : ''}" data-act="rt-m3-checkin" data-sid="${h(s.id)}" data-pid="${it.pid}">
        <div><b>${h(it.p.n)}</b> <span class="muted small">${it.isSub ? `代班（原 ${h(it.origName)}）` : h(ctx.roleOf(it.p) || it.p.a)}${h(carStatus)}</span></div>
        <span class="tag ${on ? 'ok' : 'wn'}">${on ? '✓ 已到' : '未到'}</span>
      </button>`;
    }).join('');

    const qd = [['人數夠嗎', ['不足', '剛好', '太多']], ['交通順利嗎', ['順利', '臨時安排', '有人沒車']], ['工作量', ['偏輕', '剛好', '偏重']]];

    return `${ctx.wsHeader('R', 'm3', area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">M3 小組長現場作業 · <span class="c-${h(s.area)}">${h(s.area)}</span></div>
          <h1>當日點名與服務後回饋</h1>
        </div>
        <div class="acts">
          <a class="btn blue-out" href="#/m10/${h(s.id)}">車輛安排 (M10)</a>
          <a class="btn" href="#/m5/${h(s.id)}">服務詳情 (M5)</a>
        </div>
      </div>

      <section class="card" style="padding:10px 14px">
        <label>切換點名場次<select id="rtM3SlotSel" data-act-change="rt-m3-slot-sel">${slots.slice(0, 80).map((x) => `<option value="${h(x.id)}" ${x.id === s.id ? 'selected' : ''}>${h(ctx.dLabel(x))} ${h(x.label || x.cat)}（${h(x.area)}）</option>`).join('')}</select></label>
      </section>

      <div class="cmd-grid">
        <div class="cmd-card cmd-ok"><div class="cmd-k">已到</div><div class="cmd-v">${hereCnt}</div></div>
        <div class="cmd-card cmd-warn"><div class="cmd-k">未到</div><div class="cmd-v">${Math.max(0, crew.length - hereCnt)}</div></div>
        <div class="cmd-card"><div class="cmd-k">名單共計</div><div class="cmd-v">${crew.length}</div></div>
      </div>

      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <div class="row-h"><h2>點擊人員切換「已到／未到」</h2><span class="muted small">即時存檔</span></div>
            <div class="list">${crewRows || '<div class="empty">這一場尚未排入名單，請先至 B4/B6 加入或載入模擬資料。</div>'}</div>
          </section>
        </div>

        <aside class="split-side">
          <section class="card">
            <div class="row-h"><h2>服務後回饋（一分鐘）</h2>${fbPrev ? ctx.tag('ok', '已提交') : ''}</div>
            <div class="muted small">提交後會即時累積到總召「回饋與年度檢討 (C3)」。</div>
            ${qd.map(([qt, opts], qi) => `<div><div class="small" style="font-weight:700;margin-bottom:4px">${h(qt)}</div>
              <div class="rt-pill-group">${opts.map((opt) => `<button type="button" class="chip sm ${ans[qi] === opt ? 'on' : ''}" data-act="rt-m3-ans" data-qi="${qi}" data-v="${h(opt)}">${h(opt)}</button>`).join('')}</div>
            </div>`).join('')}
            <label>想補充的事（例：新人表現、交通接送建議）<textarea id="rtM3FbNote" rows="3">${h((fbPrev && fbPrev.note) || '')}</textarea></label>
            <button type="button" class="btn pri big" data-act="rt-m3-submit" data-sid="${h(s.id)}">送出服務回饋</button>
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- M4 本週服務（免登入） ---------------- */
  function renderM4(ctx) {
    const w0 = RUI.m4WeekStart || defaultWeekStart(ctx);
    RUI.m4WeekStart = w0;
    const wEnd = addDays(w0, 6);
    const live = liveSlotsSorted(ctx);
    const evs = live.filter((s) => s.d >= w0 && s.d <= wEnd);
    const pinned = Object.values(ctx.D().bulletins || {}).find((b) => b && b.tab === '公告' && b.pin)
      || DEFAULT_GUIDES[0];

    const notes = [];
    for (const s of evs) {
      const m = (ctx.D().slotNotes || {})[s.id] || {};
      for (const [nid, n] of Object.entries(m)) {
        if (n && n.text) notes.push({ sid: s.id, slot: s, nid, ...n });
      }
    }
    notes.sort((a, b) => (b.at || 0) - (a.at || 0));

    return `${ctx.wsHeader('R', 'm4', ctx.defaultArea())}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">M4 本週服務（免登入可看） · ${h(rocRange(w0, wEnd))}</div>
          <h1>本週天達堂服務一覽</h1>
        </div>
        <div class="acts">
          <button type="button" class="btn sm" data-act="rt-m4-week" data-w="${h(addDays(w0, -7))}">← 上一週</button>
          <button type="button" class="btn sm pri-out" data-act="rt-m4-week" data-w="${h(defaultWeekStart(ctx))}">最近有班週</button>
          <button type="button" class="btn sm" data-act="rt-m4-week" data-w="${h(addDays(w0, 7))}">下一週 →</button>
        </div>
      </div>

      ${pinned ? `<section class="rt-bulletin-pin">
        <div>${ctx.tag('ok', '置頂公告')} <b>${h(pinned.title)}</b> <span class="small muted">${h(String(pinned.body || '').slice(0, 60))}</span></div>
        <a class="btn sm" href="#/m7">看公告與指南 →</a>
      </section>` : ''}

      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <div class="row-h"><h2>本週場次（${evs.length} 場）</h2><span class="muted small">點任一場次查看名單、車次與筆記</span></div>
            <div class="list">
              ${evs.map((s) => {
                const st = slotRsvpStats(s.id, ctx);
                const leadP = s.groupKey ? ctx.groupLead(s.groupKey) : null;
                const avail = st.crew.length - st.no;
                let badge = ctx.tag('ok', '人齊');
                if (st.carMiss > 0) badge = ctx.tag('bad', '交通未定');
                else if (avail < st.need) badge = ctx.tag('wn', `缺 ${st.need - avail}`);
                else if (!st.leadConfirmed) badge = ctx.tag('wn', '帶隊待覆');
                return `<a class="row" href="#/m5/${h(s.id)}">
                  <div class="row-h"><div><span class="num small">${h(ctx.E.fmtD(s.d))}（${h(ctx.WD[s.wd])}）</span> <b>${h(s.label || s.cat)}</b></div>${badge}</div>
                  <div class="muted small">${leadP ? `帶隊 ${h(leadP.n)} · ` : ''}應排 ${st.need} 人 · 已排 ${st.crew.length} 人（已覆 ${st.ok}） · <b class="c-${h(s.area)}">${h(s.area)}</b></div>
                </a>`;
              }).join('') || '<div class="empty">這一週沒有排定勤務，請點右上方「← 上一週／下一週 →」。</div>'}
            </div>
          </section>
        </div>

        <aside class="split-side">
          <section class="card">
            <h2>本週意見交流</h2>
            <div class="list">
              ${notes.slice(0, 8).map((n) => `<div class="bind-hit"><div><b>${h(n.who)}</b> <span class="muted small">${h(ctx.E.fmtD(n.slot.d))} ${h(n.slot.cat)}</span>
                <div class="small">${h(n.text)}</div></div><a class="small" href="#/m5/${h(n.sid)}">查看</a></div>`).join('') || '<div class="empty">本週尚無現場留言或共乘提醒</div>'}
            </div>
            ${ctx.me() && evs.length ? `<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
              <label>給本週場次留言<select id="rtM4NoteSid">${evs.map((s) => `<option value="${h(s.id)}">${h(ctx.E.fmtD(s.d))} ${h(s.label || s.cat)}</option>`).join('')}</select></label>
              <input id="rtM4NoteTxt" type="text" placeholder="分享集合、共乘空位或注意事項">
              <button type="button" class="btn sm pri" data-act="rt-m4-note">送出留言</button>
            </div>` : (!ctx.me() ? '<div class="muted small">登入後可於此留訊息給同場夥伴與小組長。</div>' : '')}
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- M5 服務詳情：名單、車次、複製資訊 ---------------- */
  function buildM5Text(s, crew, ctx) {
    const leadP = s.groupKey ? ctx.groupLead(s.groupKey) : null;
    const cp = (ctx.D().carpool || {})[s.id] || {};
    const cars = Object.entries(cp.cars || {}).filter(([, c]) => c && !c.cancelled);
    const carLines = cp.mode === 'offline' ? '【交通】小組長線下安排'
      : cars.length ? '【車次】\n' + cars.map(([cid, c], i) => {
        const ps = Object.entries(cp.riders || {}).filter(([, r]) => r && r.carId === cid).map(([pid]) => (ctx.M.pById[+pid] || {}).n || pid);
        return `第 ${i + 1} 車 ${c.driverName}（${c.pickup || '集合點待定'}）：${ps.join('、') || '尚無人預排'}`;
      }).join('\n') : '【交通】各自前往或待登記';
    return `【天達堂服務通知】${ctx.dLabel(s)} ${s.label || s.cat}${s.loc ? ' · ' + s.loc : ''}\n`
      + `負責單位：${s.area}${leadP ? ' · 帶隊：' + leadP.n : ''}\n`
      + `名單（${crew.length} 人）：${crew.map((x) => x.p.n + (x.isSub ? `(代${x.origName})` : '')).join('、') || '待排'}\n`
      + carLines;
  }

  function renderM5(arg, ctx) {
    const sid = String(arg || '').split('?')[0];
    const s = (ctx.RE_SID.test(sid) && ctx.M && ctx.M.byId[sid]) || liveSlotsSorted(ctx)[0];
    if (!s) return `${ctx.wsHeader('R', 'm5', ctx.defaultArea())}<main class="wide-main"><div class="empty">找不到場次</div></main>`;

    const crew = effectiveSlotCrew(s.id, ctx);
    const rsvpMap = (ctx.D().rsvp || {})[s.id] || {};
    const cp = (ctx.D().carpool || {})[s.id] || {};
    const cars = Object.entries(cp.cars || {}).filter(([, c]) => c && !c.cancelled);
    const riders = cp.riders || {};
    const leadP = s.groupKey ? ctx.groupLead(s.groupKey) : null;
    const sameDay = ctx.M.slots.filter((x) => !x.cancel && x.d === s.d && x.cat === s.cat);

    let tabBody = '';
    if (RUI.m5Tab === '依工作') {
      const meta = s.groupKey ? ((ctx.D().groupMeta || {})[s.groupKey] || {}) : {};
      const posts = meta.posts || {};
      const lines = [];
      if (leadP) lines.push(['帶隊組長／主廚', leadP.n]);
      if (Object.keys(posts).length) {
        lines.push(['崗位配崗', Object.entries(posts).map(([k, pid]) => `${k}：${(ctx.M.pById[+pid] || {}).n || pid}`).join('；')]);
      }
      const names = crew.map((x) => {
        const rv = rsvpMap[x.pid];
        if (rv && rv.st === 'no') return `${x.p.n}(請假)`;
        if (x.isSub) return `${x.p.n}(代${x.origName})`;
        return x.p.n;
      });
      lines.push([`${s.cat} 名單（${crew.length} 人）`, names.join('、') || '尚未排入人員']);
      tabBody = lines.map(([k, v]) => `<div class="kv-row"><b>${h(k)}</b><span>${h(v)}</span></div>`).join('');
    } else if (RUI.m5Tab === '依區域') {
      const byArea = new Map();
      for (const x of crew) {
        const a = x.p.a || s.area;
        if (!byArea.has(a)) byArea.set(a, []);
        byArea.get(a).push(x.p.n + (x.isSub ? '(代班)' : ''));
      }
      tabBody = [...byArea.entries()].map(([a, ns]) => `<div class="kv-row"><b class="c-${h(a)}">${h(a)}（${ns.length}）</b><span>${h(ns.join('、'))}</span></div>`).join('') || '<div class="empty">尚無名單</div>';
    } else {
      if (cp.mode === 'offline') {
        tabBody = '<div class="empty">這一場的交通由小組長線下安排聯絡。</div>';
      } else {
        const rows = cars.map(([cid, c], idx) => {
          const ps = Object.entries(riders).filter(([, r]) => r && r.carId === cid);
          const pTxt = ps.map(([pid, r]) => `${(ctx.M.pById[+pid] || {}).n || pid}${r.status === 'pending' ? '(待確認)' : ''}`).join('、') || '尚無乘客';
          return `<div class="kv-row"><b>第 ${idx + 1} 車 ${h(c.driverName)}（${h(c.pickup || '地點待填')}）</b><span>${h(pTxt)} · 剩 ${Math.max(0, (c.seats || 0) - ps.length)} 位</span></div>`;
        });
        const selfGo = Object.entries(riders).filter(([, r]) => r && (r.mode === 'bus' || r.mode === 'ride_self')).map(([pid]) => (ctx.M.pById[+pid] || {}).n || pid);
        const needHelp = Object.entries(riders).filter(([, r]) => r && r.mode === 'need_help').map(([pid]) => (ctx.M.pById[+pid] || {}).n || pid);
        if (selfGo.length) rows.push(`<div class="kv-row"><b>自行前往</b><span>${h(selfGo.join('、'))}</span></div>`);
        if (needHelp.length) rows.push(`<div class="kv-row"><b class="t-bad">還沒有車 (${needHelp.length})</b><span>${h(needHelp.join('、'))}</span></div>`);
        tabBody = rows.join('') || '<div class="empty">尚未有人登記車次，登入者可於「這一場我怎麼去 (M9)」登記或徵車。</div>';
      }
    }

    const guide = DEFAULT_GUIDES.find((g) => s.cat.includes(g.cat) || (g.cat === '忠恕輪值' && s.cat.startsWith('忠恕'))) || DEFAULT_GUIDES[0];
    const notes = Object.entries((ctx.D().slotNotes || {})[s.id] || {}).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const shareTxt = buildM5Text(s, crew, ctx);

    return `${ctx.wsHeader('R', 'm5', s.area)}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">M5 服務詳情 · <b class="c-${h(s.area)}">${h(s.area)}</b></div>
          <h1>${h(ctx.dLabel(s))} ${h(s.label || s.cat)}</h1>
          <div class="muted small">${s.loc ? h(s.loc) + ' · ' : ''}需求 ${ctx.E.slotNeed(ctx.M, s)} 人 · 已排 ${crew.length} 人 · 車次 ${cars.length} 台${sameDay.length > 1 ? ` · 同日尚有 ${sameDay.length - 1} 格相關梯次` : ''}</div>
        </div>
        <div class="acts">
          <button type="button" class="btn pri" data-act="rt-copy" data-text="${h(shareTxt)}">複製服務資訊</button>
          <a class="btn" href="#/m4">← 回本週服務</a>
        </div>
      </div>

      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <div class="chips">${['依工作', '依區域', '依車次'].map((t) => `<button type="button" class="chip sm ${RUI.m5Tab === t ? 'on' : ''}" data-act="rt-m5-tab" data-v="${h(t)}">${h(t)}</button>`).join('')}</div>
            ${tabBody}
          </section>

          <section class="card">
            <div class="row-h"><h2>這一場的筆記（${notes.length}）</h2><a class="small" href="#/m7">服務指南總覽 →</a></div>
            ${notes.map(([, n]) => `<div class="logrow"><span class="num small">${h(ctx.ago(n.at))}</span> <b>${h(n.who)}</b> ${h(n.text)}</div>`).join('') || '<div class="empty">尚無場次筆記</div>'}
            ${ctx.me() ? `<div class="sys-add-row" style="grid-template-columns:1fr auto">
              <input id="rtM5NoteTxt" type="text" placeholder="新增給同場夥伴的筆記（集合地點／臨時提醒）">
              <button type="button" class="btn sm pri" data-act="rt-m5-note" data-sid="${h(s.id)}">新增筆記</button>
            </div>` : ''}
          </section>
        </div>

        <aside class="split-side">
          <section class="card">
            <h2>快速操作與服務說明</h2>
            <div class="kv-row"><b>${h(guide.title)}</b><span class="muted">${h(guide.body)}</span></div>
            <div class="acts" style="margin-top:6px">
              <a class="btn sm pri-out" href="#/m9/${h(s.id)}">這一場我怎麼去 (M9)</a>
              ${ctx.isAdmin() || ctx.myAreas().length ? `<a class="btn sm" href="#/m3/${h(s.id)}">小組長點名 (M3)</a><a class="btn sm" href="#/m10/${h(s.id)}">車輛安排 (M10)</a>` : ''}
              <a class="btn sm" href="${s.groupKey ? '#/g/' + h(s.groupKey) : '#/s/' + h(s.id)}">看排人明細</a>
            </div>
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- M6 四合一查詢（免登入，取代／擴充原 lookup） ---------------- */
  function renderM6List(ctx) {
    if (!ctx.M) return '';
    const q = String(RUI.m6Q || '').trim().toLowerCase();
    const area = RUI.m6Area || '全部';
    const tab = RUI.m6Tab || '服務工作';

    if (tab === '服務工作') {
      const rows = liveSlotsSorted(ctx).filter((s) => (area === '全部' || s.area === area) && (!q || `${s.label || ''} ${s.cat} ${s.area} ${s.d}`.toLowerCase().includes(q))).slice(0, 60);
      return rows.map((s) => {
        const leadP = s.groupKey ? ctx.groupLead(s.groupKey) : null;
        return `<a class="row" href="#/m5/${h(s.id)}">
          <div class="row-h"><b>${h(ctx.dLabel(s))} ${h(s.label || s.cat)}</b><b class="c-${h(s.area)}">${h(s.area)}</b></div>
          <div class="muted small">${h(s.cat)} · 已排 ${ctx.M.asg[s.id].p.length}／${ctx.E.slotNeed(ctx.M, s)}${leadP ? ' · 帶隊 ' + h(leadP.n) : ''}</div>
        </a>`;
      }).join('') || '<div class="empty">找不到符合的服務工作。</div>';
    }

    if (tab === '組別') {
      const gms = ctx.BASE.groupsMeta.filter((g) => (area === '全部' || g.area === area) && (!q || `${g.name} ${g.area} ${g.cat}`.toLowerCase().includes(q)));
      return gms.map((g) => {
        const mems = (ctx.E.getState().groups[g.id] || []).map((id) => ctx.M.pById[id]).filter(Boolean);
        const leadP = ctx.groupLead(g.id);
        return `<a class="row" href="#/g/${h(g.id)}">
          <div class="row-h"><b>${h(g.name)}</b><span class="num small">${mems.length} 人</span></div>
          <div class="muted small">${leadP ? '帶隊 ' + h(leadP.n) + ' · ' : ''}${mems.slice(0, 12).map((p) => p.off ? `<span class="muted">${h(p.n)}</span>` : h(p.n)).join('、')}${mems.length > 12 ? ` 等 ${mems.length} 人` : ''}</div>
        </a>`;
      }).join('') || '<div class="empty">找不到符合的組別。</div>';
    }

    if (tab === '人員') {
      if (!q) return '<div class="muted small">請輸入道親姓名（例：許明德），免登入即可查詢全年場次與崗位（不公開個人電話與狀態）。</div>';
      const hits = ctx.M.people.filter((p) => (p.n || '').toLowerCase().includes(q)).slice(0, 10);
      if (!hits.length) return `<div class="muted small">找不到符合「${h(RUI.m6Q)}」的人員。</div>`;
      const today = fmtYmdLocal(new Date());
      return hits.map((p) => {
        const slots = findSlotForPerson(p, ctx);
        const past = slots.filter((s) => s.d < today);
        const next = slots.filter((s) => s.d >= today);
        const gs = (ctx.M.personGroups[p.id] || []).map((g) => ctx.gmOf(g).name).join('、');
        return `<div class="card">
          <div class="row-h"><div><b>${h(p.n)}</b> <b class="c-${h(p.a)}">${h(p.a)}</b>${ctx.roleOf(p) ? ` · <span class="muted small">${h(ctx.roleOf(p))}</span>` : ''}</div>
            <button type="button" class="btn sm pri" data-act="person" data-pid="${p.id}">完整時間軸 →</button></div>
          <div class="muted small">116 年共 ${ctx.E.occasions(slots).length} 次（${slots.length} 場）${gs ? ' · ' + h(gs) : ''}</div>
          ${past.length ? `<div class="small"><b>已服務 ${past.length} 次：</b>${past.slice(0, 4).map((s) => `${ctx.E.fmtD(s.d)} ${s.cat}`).join('、')}</div>` : ''}
          ${next.length ? `<div class="small"><b>接下來 ${next.length} 場：</b>${next.slice(0, 6).map((s) => `<a href="#/m5/${h(s.id)}">${h(ctx.E.fmtD(s.d))} ${h(s.label || s.cat)}</a>`).join('、')}</div>` : ''}
        </div>`;
      }).join('');
    }

    // 更新
    const items = [];
    for (const [, dp] of Object.entries(ctx.D().dispatch || {})) if (dp) items.push({ at: dp.at || 0, who: dp.by || '調度台', title: dp.title, note: dp.action, sid: dp.sid });
    for (const [, l] of Object.entries(ctx.D().log || {})) if (l) items.push({ at: l.at || 0, who: l.name || '系統', title: `[${l.area || ''}] ${l.msg}`, note: '' });
    items.sort((a, b) => b.at - a.at);
    const filtered = items.filter((x) => !q || `${x.title} ${x.who} ${x.note}`.toLowerCase().includes(q)).slice(0, 30);
    return filtered.map((x) => `<div class="bind-hit"><div><span class="num small muted">${h(ctx.ago(x.at))} · ${h(x.who)}</span><div><b>${h(x.title)}</b></div>${x.note ? `<div class="muted small">${h(x.note)}</div>` : ''}</div>
      ${x.sid ? `<a class="btn sm" href="#/m5/${h(x.sid)}">看場次</a>` : ''}</div>`).join('') || '<div class="empty">尚無近期更新紀錄</div>';
  }

  function renderM6(ctx) {
    const showArea = RUI.m6Tab === '服務工作' || RUI.m6Tab === '組別';
    const placeholder = RUI.m6Tab === '人員' ? '輸入姓名（例如：許明德）' : RUI.m6Tab === '組別' ? '搜尋組別或地區' : RUI.m6Tab === '更新' ? '搜尋日期或異動內容' : '搜尋活動或日期（例如：明理班）';
    return `${ctx.wsHeader('lookup', 'm6', ctx.defaultArea())}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">M6 全堂公開查詢（免登入）</div>
          <h1>查詢：服務工作、組別、人員與更新</h1>
        </div>
        <div class="acts"><a class="btn" href="#/m4">本週服務 (M4)</a><a class="btn" href="#/m7">公告與指南 (M7)</a></div>
      </div>

      <section class="card">
        <div class="chips" role="tablist">${['服務工作', '組別', '人員', '更新'].map((t) => `<button type="button" class="chip ${RUI.m6Tab === t ? 'on' : ''}" data-act="rt-m6-tab" data-v="${h(t)}">${h(t)}</button>`).join('')}</div>
        <label>搜尋<input id="m6Q" type="search" value="${h(RUI.m6Q)}" data-input="m6Q" placeholder="${h(placeholder)}"></label>
        ${showArea ? `<div class="chips">${['全部', ...ctx.AREAS, '青年班', '機動', '交通隊'].map((a) => `<button type="button" class="chip sm ${RUI.m6Area === a ? 'on' : ''}" data-act="rt-m6-area" data-v="${h(a)}">${h(a)}</button>`).join('')}</div>` : ''}
        <div id="m6List" class="list">${renderM6List(ctx)}</div>
      </section>
    </main>`;
  }

  /* ---------------- M7 公告與服務指南 ---------------- */
  function allBulletins(ctx) {
    const map = new Map();
    for (const g of DEFAULT_GUIDES) map.set(g.id, Object.assign({}, g));
    for (const [id, b] of Object.entries(ctx.D().bulletins || {})) {
      if (b && typeof b === 'object') map.set(id, Object.assign({}, b, { id }));
    }
    return [...map.values()].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || (b.at || 0) - (a.at || 0));
  }

  function renderM7List(ctx) {
    const list = allBulletins(ctx);
    const q = String(RUI.m7Q || '').trim().toLowerCase();
    const isGuide = RUI.m7Tab === '服務指南';
    const wantTab = isGuide ? '指南' : '公告';
    const filtered = list.filter((b) => {
      if ((b.tab || '公告') !== wantTab) return false;
      if (isGuide && RUI.m7Cat !== '全部' && b.cat !== RUI.m7Cat) return false;
      if (!q) return true;
      return `${b.title} ${b.body || ''} ${b.cat || ''}`.toLowerCase().includes(q);
    });
    const canEdit = ctx.me() && (ctx.isAdmin() || ctx.myAreas().length > 0);
    return filtered.map((b) => `<article class="card" style="${b.pin ? 'border-left:4px solid var(--accent)' : ''}">
      <div class="row-h">
        <div class="row-t">${b.pin ? ctx.tag('ok', '置頂') : ''}${ctx.tag('no', b.cat || '全部')} <span class="muted small">${h(b.meta || ctx.ago(b.at) || '')}</span></div>
        ${canEdit && !String(b.id).startsWith('dg') ? `<div class="acts"><button type="button" class="btn sm" data-act="rt-m7-pin" data-id="${h(b.id)}">${b.pin ? '取消置頂' : '置頂'}</button><button type="button" class="btn sm" data-act="rt-m7-del" data-id="${h(b.id)}">移除</button></div>` : ''}
      </div>
      <h2>${h(b.title)}</h2>
      <div class="small" style="white-space:pre-line">${h(b.body || '')}</div>
    </article>`).join('') || `<div class="empty">${isGuide ? '目前尚無此類別的服務指南' : '目前尚無新公告'}</div>`;
  }

  function renderM7(ctx) {
    const canEdit = ctx.me() && (ctx.isAdmin() || ctx.myAreas().length > 0);
    const cats = ['全部', '忠恕輪值', '第一次服務', '廚務', '服務', '禮節', '交通'];
    const addBox = canEdit && RUI.m7AddOpen ? `<section class="card warnbox">
      <div class="row-h"><h2>發布新公告或服務指南</h2><button type="button" class="btn sm" data-act="rt-m7-add-toggle">關閉</button></div>
      <div class="grid2">
        <label>類型<select id="rtM7Tab"><option value="公告">公告</option><option value="指南">服務指南</option></select></label>
        <label>對象／分類<select id="rtM7Cat">${['全部', ...ctx.AREAS, '忠恕輪值', '廚務', '服務', '禮節', '交通', '第一次服務'].map((c) => `<option>${h(c)}</option>`).join('')}</select></label>
      </div>
      <label>標題<input id="rtM7Title" type="text" placeholder="例：5/29 忠恕輪值集合時間更新"></label>
      <label>內容<textarea id="rtM7Body" rows="3" placeholder="集合時間、服裝與注意事項"></textarea></label>
      <button type="button" class="btn pri" data-act="rt-m7-add">立即發布</button>
    </section>` : '';

    return `${ctx.wsHeader('R', 'm7', ctx.defaultArea())}<main class="wide-main">
      <div class="page-head">
        <div>
          <div class="muted small">M7 全堂公告與服務教學（免登入可看）</div>
          <h1>公告與服務指南</h1>
        </div>
        <div class="acts">
          ${canEdit ? `<button type="button" class="btn pri" data-act="rt-m7-add-toggle">＋ 發布公告／指南</button>` : ''}
          <a class="btn" href="#/m4">回本週服務</a>
        </div>
      </div>

      ${addBox}

      <section class="card">
        <div class="chips">${['公告', '服務指南'].map((t) => `<button type="button" class="chip ${RUI.m7Tab === t ? 'on' : ''}" data-act="rt-m7-tab" data-v="${h(t)}">${h(t)}</button>`).join('')}</div>
        <label>搜尋公告與指南<input id="m7Q" type="search" value="${h(RUI.m7Q)}" data-input="m7Q" placeholder="關鍵字搜尋：分菜制、崗位、交通…"></label>
        ${RUI.m7Tab === '服務指南' ? `<div class="chips">${cats.map((c) => `<button type="button" class="chip sm ${RUI.m7Cat === c ? 'on' : ''}" data-act="rt-m7-cat" data-v="${h(c)}">${h(c)}</button>`).join('')}</div>` : ''}
      </section>
      <div id="m7List" class="list">${renderM7List(ctx)}</div>
    </main>`;
  }

  /* ---------------- M9 志工：這一場我怎麼去 ---------------- */
  function renderM9(arg, ctx) {
    const [sidRaw, qs] = String(arg || '').split('?');
    const q = new URLSearchParams(qs || '');
    const sid = (ctx.RE_SID.test(sidRaw) && ctx.M && ctx.M.byId[sidRaw]) ? sidRaw : '';
    const bp = ctx.myBoundPerson();
    const pidParam = +q.get('pid') || 0;
    const p = (pidParam && ctx.M && ctx.M.pById[pidParam]) || (bp && ctx.boundOk(bp) ? bp.p : null);
    const s = sid ? ctx.M.byId[sid] : null;
    const area = (s && s.area) || (p && p.a) || ctx.defaultArea();

    if (!ctx.me() || !p || !s) {
      return `${ctx.wsHeader('R', 'm9', area)}<main class="wide-main"><section class="card warnbox"><h2>這一場我怎麼去 (M9)</h2><div class="muted small">請先登入並綁定姓名後從「我的服務」進入填寫。</div><a class="btn pri" href="#/my">回我的服務</a></section></main>`;
    }

    const cp = (ctx.D().carpool || {})[s.id] || {};
    const riders = cp.riders || {};
    const cars = cp.cars || {};
    const myR = riders[p.id] || null;
    const modeLabelMap = { bus: '交通車或公車', ride_self: '已有人載', drive: '自己開車', carpool: '坐別人的車', need_help: '需要協助' };
    const mode = RUI.m9Mode || (myR && modeLabelMap[myR.mode]) || '坐別人的車';
    const myCarEntry = Object.entries(cars).find(([, c]) => c && !c.cancelled && ((+c.driverPid === p.id) || (ctx.me() && c.driverUid === ctx.me().uid)));
    const seats = RUI.m9Seats;

    const modeBtn = (t) => `<button type="button" class="chip ${mode === t ? 'on' : ''}" data-act="rt-m9-mode" data-v="${h(t)}">${h(t)}</button>`;
    let body = '';
    if (mode === '交通車或公車') {
      body = `<div class="muted small">已選擇自行搭乘交通車或公車，不佔共乘空位；集合時間請查看服務詳情 (M5)。</div>
        <button type="button" class="btn pri" data-act="rt-m9-save" data-sid="${h(s.id)}" data-pid="${p.id}" data-mode="bus">確認儲存「自行前往」</button>`;
    } else if (mode === '已有人載' || mode === '自己開車') {
      body = `<div class="small" style="font-weight:700">${mode === '自己開車' ? '我開車，可以順路載人' : '家人／朋友載我，車上還有空位'}</div>
        <div class="rt-step"><span>還能再載幾位？</span>
          <button type="button" class="btn sm" data-act="rt-m9-seats" data-delta="-1">−</button>
          <b class="num" style="min-width:24px;text-align:center">${seats}</b>
          <button type="button" class="btn sm" data-act="rt-m9-seats" data-delta="1">＋</button></div>
        <label>上車地點與時間<input id="rtM9Pickup" type="text" value="${h((myCarEntry && myCarEntry[1].pickup) || '')}" placeholder="例：瑞芳火車站 07:40"></label>
        <div class="muted small">${seats > 0 ? '同場夥伴可在下面看到這台車並預排上車，由您確認。' : '空位為 0 時僅記錄自行前往，不會開放共乘。'}</div>
        <div class="acts">
          <button type="button" class="btn pri" data-act="rt-m9-save" data-sid="${h(s.id)}" data-pid="${p.id}" data-mode="${mode === '自己開車' ? 'drive' : 'ride_self'}">儲存我的車輛與座位</button>
          ${myCarEntry ? `<a class="btn blue-out" href="#/m11/${h(s.id)}/${h(myCarEntry[0])}">管理我開的車 (M11) →</a>` : ''}
        </div>`;
    } else if (mode === '坐別人的車') {
      const carCards = Object.entries(cars).filter(([, c]) => c && !c.cancelled && ((+c.seats || 0) > 0 || (myR && myR.carId))).map(([cid, c]) => {
        const ps = Object.entries(riders).filter(([, r]) => r && r.carId === cid);
        const left = Math.max(0, (c.seats || 0) - ps.length);
        const mine = myR && myR.carId === cid;
        if ((+c.seats || 0) === 0 && !mine) return '';
        return `<div class="rt-car-card" style="${mine ? 'border:2px solid var(--accent);background:var(--accent-soft)' : ''}">
          <div class="row-h"><div><b>${h(c.driverName)}</b> <span class="muted small">${h(c.kind)}</span></div>
            ${ctx.tag(mine ? 'ok' : left ? 'wn' : 'no', mine ? (myR.status === 'ok' ? '已確認' : '已預排待確認') : (left ? `剩 ${left} 位` : '已滿'))}</div>
          <div class="muted small">${h(c.pickup || '集合點洽司機')} · 同車 ${ps.map(([id]) => (ctx.M.pById[+id] || {}).n || id).join('、') || '尚無人'}</div>
          <div class="acts">
            ${mine ? `<button type="button" class="btn sm warn-out" data-act="rt-m9-cancel-car" data-sid="${h(s.id)}" data-pid="${p.id}">取消預排</button>`
              : `<button type="button" class="btn sm ${left ? 'pri' : ''}" ${left ? '' : 'disabled'} data-act="rt-m9-pick-car" data-sid="${h(s.id)}" data-pid="${p.id}" data-cid="${h(cid)}">${left ? '預排搭這台車' : '已滿'}</button>`}
          </div>
        </div>`;
      }).join('');
      body = `<div class="list">${carCards || '<div class="empty">這場目前還沒有同場車次，若需要交通請點上方「需要協助」。</div>'}</div>`;
    } else {
      body = `<label>從哪裡出發？<input id="rtM9From" type="text" value="${h((myR && myR.from) || '')}" placeholder="例：基隆廟口／瑞芳市區"></label>
        <div class="muted small">送出後小組長 (M10) 與調度台會立即看到並為您安排順路接送。</div>
        <button type="button" class="btn pri" data-act="rt-m9-save" data-sid="${h(s.id)}" data-pid="${p.id}" data-mode="need_help">送出交通協助需求</button>`;
    }

    return `${ctx.wsHeader('R', 'm9', area)}<main class="wide-main">
      <div class="page-head">
        <div><div class="muted small">M9 共乘與交通登記 · ${h(p.n)}</div><h1>${h(ctx.dLabel(s))} ${h(s.label || s.cat)}</h1></div>
        <a class="btn" href="#/my">← 回我的服務</a>
      </div>
      ${cp.mode === 'offline' ? '<section class="card warnbox"><b>本場目前設定為「小組線下安排交通」</b><div class="muted small">若小組長已電話或群組統一通知上車點，可不必在此填寫。</div></section>' : ''}
      <section class="card">
        <h2>自行前往或搭便車？</h2>
        <div class="rt-pill-group">${['交通車或公車', '已有人載', '自己開車', '坐別人的車', '需要協助'].map(modeBtn).join('')}</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">${body}</div>
      </section>
    </main>`;
  }

  /* ---------------- M10 小組長：車輛安排 ---------------- */
  function renderM10(arg, ctx) {
    const sidArg = String(arg || '').split('?')[0];
    const live = liveSlotsSorted(ctx);
    const sid = (ctx.RE_SID.test(sidArg) && ctx.M && ctx.M.byId[sidArg]) ? sidArg : (RUI.m10Slot && ctx.M && ctx.M.byId[RUI.m10Slot] ? RUI.m10Slot : ((live.find((x) => x.d >= defaultBaseDate(ctx)) || live[0] || {}).id || ''));
    RUI.m10Slot = sid;
    const s = sid && ctx.M ? ctx.M.byId[sid] : null;
    const area = (s && s.area) || ctx.defaultArea();
    if (!ctx.me() || !(ctx.isAdmin() || ctx.myAreas().length)) {
      return `${ctx.wsHeader('R', 'm10', area)}<main class="wide-main"><section class="card warnbox"><h2>小組長車輛安排 (M10) 限幹部操作</h2><a class="btn pri" href="#/m5/${h(sid || '')}">查看服務車次 (M5)</a></section></main>`;
    }
    if (!s) return `${ctx.wsHeader('R', 'm10', area)}<main class="wide-main"><div class="empty">無場次資料</div></main>`;

    const cp = (ctx.D().carpool || {})[s.id] || {};
    const mode = cp.mode === 'offline' ? 'offline' : 'app';
    const cars = Object.entries(cp.cars || {}).filter(([, c]) => c && !c.cancelled);
    const riders = cp.riders || {};
    const crew = effectiveSlotCrew(s.id, ctx);

    let doneCnt = 0, pendCnt = 0, helpCnt = 0, unfilledCnt = 0;
    const pendList = [], helpList = [], unfilledList = [], selfList = [];
    for (const it of crew) {
      const rd = riders[it.pid];
      if (!rd) { unfilledCnt++; unfilledList.push(it); continue; }
      if (rd.mode === 'need_help' || (rd.carId && cp.cars && cp.cars[rd.carId] && cp.cars[rd.carId].cancelled)) { helpCnt++; helpList.push({ it, rd }); continue; }
      if (rd.mode === 'carpool' && rd.status === 'pending') { pendCnt++; pendList.push({ it, rd }); continue; }
      doneCnt++;
      if (rd.mode === 'bus' || rd.mode === 'ride_self' || rd.mode === 'drive') selfList.push({ it, rd });
    }

    const tempBox = RUI.m10TempOpen ? `<section class="card warnbox">
      <div class="row-h"><h2>新增臨時司機（免入組名單即可開啟 M11）</h2><button type="button" class="btn sm" data-act="rt-m10-temp-toggle">關閉</button></div>
      <div class="grid2">
        <label>司機姓名<input id="rtM10TmpName" type="text" placeholder="例：陳臨時司機"></label>
        <label>可載座位<input id="rtM10TmpSeats" type="number" min="1" max="12" value="4"></label>
      </div>
      <label>上車地點與時間<input id="rtM10TmpPickup" type="text" placeholder="例：基隆火車站南站 07:30"></label>
      <button type="button" class="btn pri" data-act="rt-m10-temp-add" data-sid="${h(s.id)}">建立並複製專屬司機連結</button>
    </section>` : '';

    return `${ctx.wsHeader('R', 'm10', area)}<main class="wide-main">
      <div class="page-head">
        <div><div class="muted small">M10 小組長車輛安排 · <span class="c-${h(s.area)}">${h(s.area)}</span></div><h1>${h(ctx.dLabel(s))} ${h(s.label || s.cat)}</h1></div>
        <div class="acts">
          <button type="button" class="btn pri-out" data-act="rt-m10-temp-toggle">＋ 加臨時司機</button>
          <button type="button" class="btn pri" data-act="rt-m10-copy" data-sid="${h(s.id)}">複製車次表</button>
          <a class="btn" href="#/m3/${h(s.id)}">← 回當日點名</a>
        </div>
      </div>

      <section class="card" style="padding:10px 14px">
        <div class="row-h">
          <label style="flex:1;min-width:220px">切換場次<select id="rtM10SlotSel" data-act-change="rt-m10-slot-sel">${live.slice(0, 80).map((x) => `<option value="${h(x.id)}" ${x.id === s.id ? 'selected' : ''}>${h(ctx.dLabel(x))} ${h(x.label || x.cat)}（${h(x.area)}）</option>`).join('')}</select></label>
          <div class="rt-pill-group">
            <button type="button" class="chip sm ${mode === 'app' ? 'on' : ''}" data-act="rt-m10-mode" data-sid="${h(s.id)}" data-v="app">用 App 記錄</button>
            <button type="button" class="chip sm ${mode === 'offline' ? 'on' : ''}" data-act="rt-m10-mode" data-sid="${h(s.id)}" data-v="offline">線下安排</button>
          </div>
        </div>
      </section>

      ${tempBox}

      ${mode === 'offline' ? `<section class="card warnbox"><b>目前採「小組線下安排」模式</b><div class="muted small">組員免填 App 交通，公開詳情顯示為「小組長安排」，且不觸發 C1 交通未定警報；原已填車次資料仍完整保留。</div></section>` : ''}

      <section class="cmd-grid">
        <div class="cmd-card cmd-ok"><div class="cmd-k">已排好</div><div class="cmd-v">${doneCnt}</div></div>
        <div class="cmd-card cmd-warn"><div class="cmd-k">共乘待確認</div><div class="cmd-v">${pendCnt}</div></div>
        <div class="cmd-card cmd-bad"><div class="cmd-k">需要協助</div><div class="cmd-v">${helpCnt}</div></div>
        <div class="cmd-card"><div class="cmd-k">還沒填</div><div class="cmd-v">${unfilledCnt}</div></div>
      </section>

      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <h2>待處理乘客</h2>
            ${pendList.map(({ it, rd }) => {
              const car = rd.carId && cp.cars && cp.cars[rd.carId];
              return `<div class="bind-hit"><div><b>${h(it.p.n)}</b> 想搭 ${h((car && car.driverName) || '某司機')} 的車 ${ctx.tag('wn', '待確認')}</div>
                <button type="button" class="btn sm pri" data-act="rt-m10-confirm" data-sid="${h(s.id)}" data-pid="${it.pid}" data-ok="1">確認搭車</button></div>`;
            }).join('')}
            ${helpList.map(({ it, rd }) => `<div class="bind-hit"><div><b class="t-bad">${h(it.p.n)} 需要協助</b> <span class="muted small">${h(rd.from ? '從 ' + rd.from : '')}</span></div>
              <div class="acts"><select id="rtM10Assign-${it.pid}">${cars.map(([cid, c]) => `<option value="${h(cid)}">${h(c.driverName)} 的車</option>`).join('')}<option value="__bus__">改搭交通車</option></select>
              <button type="button" class="btn sm pri" data-act="rt-m10-assign" data-sid="${h(s.id)}" data-pid="${it.pid}">指派</button></div></div>`).join('')}
            ${unfilledList.map((it) => `<div class="bind-hit"><div><b>${h(it.p.n)}</b> <span class="muted small">尚未填寫交通</span></div>
              <div class="acts">${cars.length ? `<select id="rtM10Assign-${it.pid}">${cars.map(([cid, c]) => `<option value="${h(cid)}">${h(c.driverName)} 的車</option>`).join('')}<option value="__bus__">代填：交通車</option></select><button type="button" class="btn sm" data-act="rt-m10-assign" data-sid="${h(s.id)}" data-pid="${it.pid}">代填</button>` : `<button type="button" class="btn sm" data-act="rt-copy" data-text="${h(`請 ${it.p.n} 協助至天達排班 App 回覆 ${ctx.dLabel(s)} 交通方式`)}">複製提醒</button>`}</div></div>`).join('')}
            ${!pendList.length && !helpList.length && !unfilledList.length ? '<div class="empty">全員交通皆已確定！</div>' : ''}
          </section>

          <section class="card">
            <h2>所有車次（${cars.length}）</h2>
            <div class="list">
              ${cars.map(([cid, c]) => {
                const ps = Object.entries(riders).filter(([, r]) => r && r.carId === cid);
                return `<div class="rt-car-card">
                  <div class="row-h"><div><b>${h(c.driverName)}</b> ${ctx.tag('no', c.kind)}</div><span class="num small">${ps.length}／${c.seats}</span></div>
                  <div class="muted small">${h(c.pickup || '集合點待填')}${c.status ? ' · ' + h(c.status) : ''}</div>
                  <div class="list">${ps.map(([pid, r]) => `<div class="bind-hit"><span>${h((ctx.M.pById[+pid] || {}).n || pid)}${r.status === 'pending' ? '（待確認）' : ''}</span>
                    <button type="button" class="link" data-act="rt-m10-rm-rider" data-sid="${h(s.id)}" data-pid="${pid}">移出</button></div>`).join('') || '<div class="muted small">還沒有乘客</div>'}</div>
                  <div class="acts"><a class="btn sm" href="#/m11/${h(s.id)}/${h(cid)}">司機頁面 (M11)</a></div>
                </div>`;
              }).join('') || '<div class="empty">尚無車輛登記</div>'}
            </div>
          </section>
        </div>

        <aside class="split-side">
          <section class="card">
            <h2>自行前往（${selfList.length} 人）</h2>
            ${selfList.map(({ it, rd }) => `<div class="bind-hit"><span>${h(it.p.n)}</span><span class="muted small">${rd.mode === 'bus' ? '交通車／公車' : rd.mode === 'drive' ? '自己開車' : '家人載'}</span></div>`).join('') || '<div class="empty">尚無</div>'}
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- M11 司機：我開的車 ---------------- */
  function renderM11(arg, ctx) {
    const [sidRaw, cidRaw] = String(arg || '').split('?')[0].split('/');
    const drvList = personDrivingCars(ctx);
    const sid = (ctx.RE_SID.test(sidRaw || '') && ctx.M && ctx.M.byId[sidRaw]) ? sidRaw : (RUI.m11Slot || (drvList[0] && drvList[0].sid) || '');
    const cp = sid ? ((ctx.D().carpool || {})[sid] || {}) : {};
    const cars = cp.cars || {};
    const cid = (cidRaw && cars[cidRaw]) ? cidRaw : (RUI.m11Car && cars[RUI.m11Car] ? RUI.m11Car : ((drvList.find((x) => x.sid === sid) || {}).cid || Object.keys(cars)[0] || ''));
    RUI.m11Slot = sid; RUI.m11Car = cid;
    const s = sid && ctx.M ? ctx.M.byId[sid] : null;
    const car = cid ? cars[cid] : null;

    if (!s || !car) {
      return `${ctx.wsHeader('R', 'm11', ctx.defaultArea())}<main class="wide-main"><section class="card warnbox">
        <h2>我開的車 (M11)</h2>
        <div class="muted small">目前沒有您擔任司機的場次。您可以先於「這一場我怎麼去 (M9)」選擇「自己開車」，或請小組長建立臨時司機連結。</div>
        <div class="acts"><a class="btn pri" href="#/my">回我的服務</a><a class="btn" href="#/m10">查看車輛安排 (M10)</a></div>
      </section></main>`;
    }

    const riders = cp.riders || {};
    const myPs = Object.entries(riders).filter(([, r]) => r && r.carId === cid);
    const left = (car.seats || 0) - myPs.length;
    const crew = effectiveSlotCrew(s.id, ctx).filter((x) => !riders[x.pid] || riders[x.pid].carId !== cid);

    return `${ctx.wsHeader('R', 'm11', s.area)}<main class="wide-main">
      ${!ctx.me() ? '<section class="card warnbox"><b>您目前尚未登入</b><div class="muted small">臨時司機請先使用 LINE 或 Google 登入後，即可確認或管理車上乘客。</div><a class="btn sm pri" href="#/login">前往登入 →</a></section>' : ''}
      <div class="page-head">
        <div><div class="muted small">M11 司機專區 · ${h(car.driverName)}</div><h1>${h(ctx.dLabel(s))} ${h(s.label || s.cat)}</h1></div>
        <div class="acts"><a class="btn" href="#/m10/${h(s.id)}">車輛總覽 (M10)</a><a class="btn" href="#/my">回我的服務</a></div>
      </div>

      ${drvList.length > 1 ? `<section class="card" style="padding:10px 14px"><label>切換我開的場次<select id="rtM11Sel" data-act-change="rt-m11-slot-sel">${drvList.map((x) => `<option value="${h(x.sid)}/${h(x.cid)}" ${x.cid === cid ? 'selected' : ''}>${h(ctx.dLabel(x.s))} ${h(x.s.label || x.s.cat)}</option>`).join('')}</select></label></section>` : ''}

      <div class="split-grid">
        <div class="split-main">
          <section class="card">
            <div class="row-h"><h2>車輛與空位</h2>${car.cancelled ? ctx.tag('bad', '已取消發車') : ctx.tag(left > 0 ? 'ok' : left === 0 ? 'wn' : 'bad', left > 0 ? `還有 ${left} 位` : left === 0 ? '已滿' : '超載')}</div>
            <label>上車地點與時間<input id="rtM11Pickup" type="text" value="${h(car.pickup || '')}" placeholder="例：瑞芳車站 07:40"></label>
            <div class="rt-step"><span>可以載幾位（不含司機）</span>
              <button type="button" class="btn sm" data-act="rt-m11-seats" data-sid="${h(s.id)}" data-cid="${h(cid)}" data-delta="-1">−</button>
              <b class="num">${car.seats || 0}</b>
              <button type="button" class="btn sm" data-act="rt-m11-seats" data-sid="${h(s.id)}" data-cid="${h(cid)}" data-delta="1">＋</button>
              <button type="button" class="btn sm pri" style="margin-left:auto" data-act="rt-m11-save" data-sid="${h(s.id)}" data-cid="${h(cid)}">儲存地點</button>
            </div>
            ${car.status ? `<div class="muted small">最新司機狀態：<b>${h(car.status)}</b></div>` : ''}
          </section>

          <section class="card">
            <h2>車上乘客（${myPs.length} 位）</h2>
            <div class="list">
              ${myPs.map(([pid, r]) => {
                const pn = (ctx.M.pById[+pid] || {}).n || pid;
                const pend = r.status === 'pending';
                return `<div class="bind-hit"><div><b>${h(pn)}</b> ${ctx.tag(pend ? 'wn' : 'ok', pend ? '想搭車，等您確認' : '已確認')}</div>
                  <div class="acts">${pend ? `<button type="button" class="btn sm pri" data-act="rt-m11-rider" data-sid="${h(s.id)}" data-cid="${h(cid)}" data-pid="${pid}" data-op="ok">確認</button>` : ''}
                    <button type="button" class="btn sm" data-act="rt-m11-rider" data-sid="${h(s.id)}" data-cid="${h(cid)}" data-pid="${pid}" data-op="rm">${pend ? '婉拒' : '移出'}</button></div></div>`;
              }).join('') || '<div class="empty">尚無乘客</div>'}
            </div>
            ${crew.length && !car.cancelled ? `<div class="sys-add-row" style="grid-template-columns:1fr auto">
              <select id="rtM11AddPid">${crew.map((x) => `<option value="${x.pid}">${h(x.p.n)}（${h(x.p.a)}）</option>`).join('')}</select>
              <button type="button" class="btn sm pri-out" data-act="rt-m11-add-rider" data-sid="${h(s.id)}" data-cid="${h(cid)}">＋ 加一位乘客</button>
            </div>` : ''}
          </section>
        </div>

        <aside class="split-side">
          <section class="card">
            <h2>通知同車的人（更新狀態＋複製 LINE 訊息）</h2>
            <div class="acts">
              <button type="button" class="btn sm pri-out" data-act="rt-m11-notify" data-sid="${h(s.id)}" data-cid="${h(cid)}" data-msg="我出發了">我出發了</button>
              <button type="button" class="btn sm warn-out" data-act="rt-m11-notify" data-sid="${h(s.id)}" data-cid="${h(cid)}" data-msg="會晚到約10分鐘">會晚到</button>
              <button type="button" class="btn sm" data-act="rt-m11-notify" data-sid="${h(s.id)}" data-cid="${h(cid)}" data-msg="已更新上車地點">改地點</button>
            </div>
            ${!car.cancelled ? `<button type="button" class="btn wide bad-out" style="margin-top:8px" data-act="rt-m11-cancel" data-sid="${h(s.id)}" data-cid="${h(cid)}">這一場不能開了</button>` : '<div class="muted small">已取消此車次。</div>'}
          </section>
        </aside>
      </div>
    </main>`;
  }

  /* ---------------- 整合摘要與路由分派 ---------------- */
  function getRuntimeSummary(ctx) {
    const baseD = defaultBaseDate(ctx);
    const endD = addDays(baseD, 13);
    const live = liveSlotsSorted(ctx);
    const winSlots = live.filter((s) => s.d >= baseD && s.d <= endD);
    const alerts = computeC1Alerts(winSlots, ctx);
    return {
      baseD,
      endD,
      winCount: winSlots.length,
      alertCount: alerts.length,
      fbCount: Object.keys(ctx.D().feedback || {}).length,
      changeCount: allChangesList(ctx).filter((c) => c.status !== '已套用').length
    };
  }

  function renderRoute(name, arg, ctx) {
    if (name === 'c1') return renderC1(ctx);
    if (name === 'c2') return renderC2(ctx);
    if (name === 'c3') return renderC3(ctx);
    if (name === 'm2') return renderM2(arg, ctx);
    if (name === 'm3') return renderM3(arg, ctx);
    if (name === 'm4') return renderM4(ctx);
    if (name === 'm5') return renderM5(arg, ctx);
    if (name === 'm6' || name === 'lookup') return renderM6(ctx);
    if (name === 'm7') return renderM7(ctx);
    if (name === 'm9') return renderM9(arg, ctx);
    if (name === 'm10') return renderM10(arg, ctx);
    if (name === 'm11') return renderM11(arg, ctx);
    return '';
  }

  /* ---------------- 事件處理 ---------------- */
  function handleClick(a, d, ev, ctx) {
    if (!a || !a.startsWith('rt-')) return false;
    const u = ctx.me();
    const D = ctx.D();
    const RE_PID = ctx.RE_PID, RE_SID = ctx.RE_SID;

    if (a === 'rt-seed-demo') { seedDemoRuntime(ctx); return true; }
    if (a === 'rt-copy') {
      if (d.text && navigator.clipboard) navigator.clipboard.writeText(d.text).catch(() => {});
      ctx.toast('已複製訊息文字');
      return true;
    }

    // M1 & M2
    if (a === 'rt-rsvp') {
      if (!u) { ctx.toast('請先登入'); return true; }
      if (!RE_SID.test(d.sid || '') || !RE_PID.test(d.pid || '')) return true;
      ctx.store.set(`rsvp/${d.sid}/${d.pid}`, { st: 'ok', by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() });
      ctx.toast('已回覆「我會到」');
      return true;
    }
    if (a === 'rt-sub-accept') {
      if (!u || !RE_SID.test(d.sid || '') || !RE_PID.test(d.pid || '')) return true;
      const p = ctx.M.pById[+d.pid];
      const origP = ctx.M.pById[+d.orig];
      ctx.store.set(`rsvp/${d.sid}/${d.pid}`, {
        st: 'sub', origPid: +d.orig || 0, origName: String((origP && origP.n) || '').slice(0, 40),
        by: String((p && p.n) || u.name || '').slice(0, 40), uid: u.uid, at: Date.now()
      });
      ctx.toast('已確認代班，感謝您的承擔！');
      return true;
    }
    if (a === 'rt-m2-reason') { RUI.m2Reason = d.v || '身體不適'; ctx.render(); return true; }
    if (a === 'rt-m2-sub' || a === 'rt-m2-submit') {
      if (!u) { ctx.toast('請先登入'); return true; }
      if (!RE_SID.test(d.sid || '') || !RE_PID.test(d.pid || '')) return true;
      const p = ctx.M.pById[+d.pid];
      const s = ctx.M.byId[d.sid];
      if (!p || !s) return true;
      const noteEl = document.getElementById('rtM2Note');
      const note = String((noteEl && noteEl.value) || '').trim().slice(0, 200);
      const subId = d.sub && RE_PID.test(d.sub) ? +d.sub : 0;
      const subP = subId ? ctx.M.pById[subId] : null;
      const rsvpObj = { st: 'no', by: String(p.n || u.name || '').slice(0, 40), uid: u.uid, at: Date.now() };
      if (subP) { rsvpObj.subPid = subP.id; rsvpObj.subName = subP.n; }
      const up = {
        [`rsvp/${s.id}/${p.id}`]: rsvpObj,
        [`rsvpNote/${s.id}/${p.id}`]: { reason: String(RUI.m2Reason || '身體不適').slice(0, 40), note, uid: u.uid, at: Date.now() }
      };
      if (ctx.isAdmin() || ctx.myAreas().length) {
        up['dispatch/' + 'dp_' + ctx.store.pushId()] = {
          sid: s.id, title: `${ctx.E.fmtD(s.d)} ${s.label || s.cat}`,
          action: subP ? `${p.n} 回報無法出席並邀請 ${subP.n} 代班` : `${p.n} 回報無法出席，交由小組長協調`,
          st: 'open', by: p.n, uid: u.uid, at: Date.now()
        };
      }
      ctx.store.update(up);
      if (subP && navigator.clipboard) {
        navigator.clipboard.writeText(`平安，我 ${ctx.dLabel(s)} 臨時有事無法出席「${s.label || s.cat}」，請問您方便代班嗎？`).catch(() => {});
      }
      ctx.toast(subP ? `已登記並複製給 ${subP.n} 的代班邀請訊息` : '已送出無法出席通知給小組長');
      location.hash = '#/my';
      return true;
    }

    // M3 點名與回饋
    if (a === 'rt-m3-checkin') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      if (!RE_SID.test(d.sid || '') || !RE_PID.test(d.pid || '')) return true;
      const cur = ((((D.checkin || {})[d.sid] || {})[d.pid] || {}).here) === true;
      ctx.store.set(`checkin/${d.sid}/${d.pid}`, { here: !cur, by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() });
      return true;
    }
    if (a === 'rt-m3-ans') { RUI.m3Ans[+d.qi] = d.v; ctx.render(); return true; }
    if (a === 'rt-m3-submit') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      const s = RE_SID.test(d.sid || '') && ctx.M.byId[d.sid];
      if (!s) return true;
      const crew = effectiveSlotCrew(s.id, ctx);
      const ck = (D.checkin || {})[s.id] || {};
      const hereCnt = crew.filter((x) => ck[x.pid] && ck[x.pid].here).length;
      const noteEl = document.getElementById('rtM3FbNote');
      ctx.store.set(`feedback/${s.id}`, {
        headcount: RUI.m3Ans[0] || '剛好',
        transport: RUI.m3Ans[1] || '順利',
        workload: RUI.m3Ans[2] || '剛好',
        note: String((noteEl && noteEl.value) || '').trim().slice(0, 500),
        hereCnt, totalCnt: crew.length,
        area: s.area, cat: s.cat, d: s.d,
        by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now()
      });
      ctx.toast('已提交服務回饋並同步至檢討台 (C3)');
      return true;
    }

    // M4 / M5
    if (a === 'rt-m4-week') { RUI.m4WeekStart = d.w || ''; ctx.render(); return true; }
    if (a === 'rt-m4-note') {
      if (!u) { ctx.toast('請先登入'); return true; }
      const sid = (document.getElementById('rtM4NoteSid') || {}).value;
      const txtEl = document.getElementById('rtM4NoteTxt');
      const txt = String((txtEl && txtEl.value) || '').trim().slice(0, 500);
      if (!RE_SID.test(sid || '') || !txt) { ctx.toast('請選擇場次並輸入留言'); return true; }
      if (txtEl) txtEl.value = '';
      ctx.store.set(`slotNotes/${sid}/n_${ctx.store.pushId()}`, { who: String(u.name || '').slice(0, 40), uid: u.uid, text: txt, at: Date.now() });
      ctx.toast('已送出本週留言');
      return true;
    }
    if (a === 'rt-m5-tab') { RUI.m5Tab = d.v || '依工作'; ctx.render(); return true; }
    if (a === 'rt-m5-note') {
      if (!u) { ctx.toast('請先登入'); return true; }
      const txtEl = document.getElementById('rtM5NoteTxt');
      const txt = String((txtEl && txtEl.value) || '').trim().slice(0, 500);
      if (!RE_SID.test(d.sid || '') || !txt) { ctx.toast('請輸入筆記內容'); return true; }
      if (txtEl) txtEl.value = '';
      ctx.store.set(`slotNotes/${d.sid}/n_${ctx.store.pushId()}`, { who: String(u.name || '').slice(0, 40), uid: u.uid, text: txt, at: Date.now() });
      ctx.toast('已新增場次筆記');
      return true;
    }

    // M6 & M7
    if (a === 'rt-m6-tab') { RUI.m6Tab = d.v || '服務工作'; ctx.render(); return true; }
    if (a === 'rt-m6-area') { RUI.m6Area = d.v || '全部'; ctx.render(); return true; }
    if (a === 'rt-m7-tab') { RUI.m7Tab = d.v || '服務指南'; ctx.render(); return true; }
    if (a === 'rt-m7-cat') { RUI.m7Cat = d.v || '全部'; ctx.render(); return true; }
    if (a === 'rt-m7-add-toggle') { RUI.m7AddOpen = !RUI.m7AddOpen; ctx.render(); return true; }
    if (a === 'rt-m7-add') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      const tab = (document.getElementById('rtM7Tab') || {}).value === '指南' ? '指南' : '公告';
      const cat = String((document.getElementById('rtM7Cat') || {}).value || '全部').slice(0, 20);
      const title = String((document.getElementById('rtM7Title') || {}).value || '').trim().slice(0, 120);
      const body = String((document.getElementById('rtM7Body') || {}).value || '').trim().slice(0, 2000);
      if (!title) { ctx.toast('請輸入標題'); return true; }
      ctx.store.set(`bulletins/b_${ctx.store.pushId()}`, { tab, cat, title, body, pin: false, by: String(u.name || '').slice(0, 40), at: Date.now() });
      RUI.m7Tab = tab === '指南' ? '服務指南' : '公告';
      RUI.m7AddOpen = false;
      ctx.toast('已發布' + tab);
      return true;
    }
    if (a === 'rt-m7-pin') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      const cur = (D.bulletins || {})[d.id];
      if (cur) ctx.store.set(`bulletins/${d.id}/pin`, !cur.pin);
      return true;
    }
    if (a === 'rt-m7-del') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      ctx.store.set(`bulletins/${d.id}`, null);
      ctx.toast('已移除');
      return true;
    }

    // M9 共乘
    if (a === 'rt-m9-mode') { RUI.m9Mode = d.v || '坐別人的車'; ctx.render(); return true; }
    if (a === 'rt-m9-seats') { RUI.m9Seats = Math.max(0, Math.min(8, RUI.m9Seats + (+d.delta || 0))); ctx.render(); return true; }
    if (a === 'rt-m9-save') {
      if (!u || !RE_SID.test(d.sid || '') || !RE_PID.test(d.pid || '')) return true;
      const p = ctx.M.pById[+d.pid];
      const m = d.mode;
      const up = {};
      if (m === 'bus' || m === 'need_help') {
        const from = String((document.getElementById('rtM9From') || {}).value || '').trim().slice(0, 60);
        up[`carpool/${d.sid}/riders/${p.id}`] = { mode: m, from, by: String(p.n).slice(0, 40), uid: u.uid, at: Date.now() };
      } else if (m === 'drive' || m === 'ride_self') {
        const pickup = String((document.getElementById('rtM9Pickup') || {}).value || '').trim().slice(0, 80);
        const cid = 'c_' + p.id;
        up[`carpool/${d.sid}/riders/${p.id}`] = { mode: m, carId: cid, status: 'ok', by: String(p.n).slice(0, 40), uid: u.uid, at: Date.now() };
        up[`carpool/${d.sid}/cars/${cid}`] = {
          driverName: String(p.n).slice(0, 40), driverPid: +p.id, driverUid: u.uid,
          kind: m === 'drive' ? '自己開車' : '已有人載', seats: RUI.m9Seats, pickup, at: Date.now()
        };
      }
      ctx.store.update(up);
      RUI.m9Mode = '';
      ctx.toast('已儲存交通資訊');
      return true;
    }
    if (a === 'rt-m9-pick-car') {
      if (!u || !RE_SID.test(d.sid || '') || !RE_PID.test(d.pid || '') || !d.cid) return true;
      const p = ctx.M.pById[+d.pid];
      ctx.store.set(`carpool/${d.sid}/riders/${p.id}`, { mode: 'carpool', carId: d.cid, status: 'pending', by: String(p.n).slice(0, 40), uid: u.uid, at: Date.now() });
      ctx.toast('已送出預排搭車，等司機或小組長確認');
      return true;
    }
    if (a === 'rt-m9-cancel-car') {
      if (!u || !RE_SID.test(d.sid || '') || !RE_PID.test(d.pid || '')) return true;
      ctx.store.set(`carpool/${d.sid}/riders/${d.pid}`, null);
      RUI.m9Mode = '';
      ctx.toast('已取消預排車次');
      return true;
    }

    // M10 小組長車輛安排
    if (a === 'rt-m10-mode') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      ctx.store.set(`carpool/${d.sid}/mode`, d.v === 'offline' ? 'offline' : 'app');
      ctx.toast(d.v === 'offline' ? '已切為小組線下安排交通' : '已恢復使用 App 共乘記錄');
      return true;
    }
    if (a === 'rt-m10-confirm') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      ctx.store.set(`carpool/${d.sid}/riders/${d.pid}/status`, d.ok === '1' ? 'ok' : 'pending');
      ctx.toast('已確認乘客上車');
      return true;
    }
    if (a === 'rt-m10-assign') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      const sel = document.getElementById('rtM10Assign-' + d.pid);
      const val = sel && sel.value;
      const p = ctx.M.pById[+d.pid];
      if (!val || !p) return true;
      if (val === '__bus__') {
        ctx.store.set(`carpool/${d.sid}/riders/${p.id}`, { mode: 'bus', by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() });
      } else {
        ctx.store.set(`carpool/${d.sid}/riders/${p.id}`, { mode: 'carpool', carId: val, status: 'ok', by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() });
      }
      ctx.toast(`已為 ${p.n} 安排交通`);
      return true;
    }
    if (a === 'rt-m10-rm-rider') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      ctx.store.set(`carpool/${d.sid}/riders/${d.pid}`, { mode: 'need_help', by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() });
      ctx.toast('已移出車次，標為需要協助');
      return true;
    }
    if (a === 'rt-m10-temp-toggle') { RUI.m10TempOpen = !RUI.m10TempOpen; ctx.render(); return true; }
    if (a === 'rt-m10-temp-add') {
      if (!ctx.need(ctx.isAdmin() || ctx.myAreas().length > 0)) return true;
      const nm = String((document.getElementById('rtM10TmpName') || {}).value || '').trim().slice(0, 40);
      const seats = Math.max(1, Math.min(12, +(document.getElementById('rtM10TmpSeats') || {}).value || 4));
      const pickup = String((document.getElementById('rtM10TmpPickup') || {}).value || '').trim().slice(0, 80);
      if (!nm) { ctx.toast('請輸入臨時司機姓名'); return true; }
      const cid = 'c_tmp_' + ctx.store.pushId();
      ctx.store.set(`carpool/${d.sid}/cars/${cid}`, { driverName: nm, kind: '臨時司機', seats, pickup, temp: true, driverUid: u.uid, at: Date.now() });
      RUI.m10TempOpen = false;
      if (navigator.clipboard) navigator.clipboard.writeText(`${location.origin || ''}${location.pathname || ''}#/m11/${d.sid}/${cid}`).catch(() => {});
      ctx.toast(`已新增臨時司機「${nm}」並複製司機頁面連結`);
      return true;
    }
    if (a === 'rt-m10-copy') {
      const s = ctx.M.byId[d.sid];
      const txt = s ? buildM5Text(s, effectiveSlotCrew(s.id, ctx), ctx) : '';
      if (txt && navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
      ctx.toast('已複製車次與名單總表');
      return true;
    }

    // M11 司機頁面
    if (a === 'rt-m11-seats') {
      if (!u) { ctx.toast('請先登入'); return true; }
      const c = (((D.carpool || {})[d.sid] || {}).cars || {})[d.cid];
      if (!c) return true;
      const next = Math.max(0, Math.min(12, (+c.seats || 0) + (+d.delta || 0)));
      ctx.store.set(`carpool/${d.sid}/cars/${d.cid}/seats`, next);
      return true;
    }
    if (a === 'rt-m11-save') {
      if (!u) { ctx.toast('請先登入'); return true; }
      const pickup = String((document.getElementById('rtM11Pickup') || {}).value || '').trim().slice(0, 80);
      ctx.store.set(`carpool/${d.sid}/cars/${d.cid}/pickup`, pickup);
      ctx.toast('已更新上車地點');
      return true;
    }
    if (a === 'rt-m11-rider') {
      if (!u) { ctx.toast('請先登入'); return true; }
      if (d.op === 'ok') ctx.store.set(`carpool/${d.sid}/riders/${d.pid}/status`, 'ok');
      else ctx.store.set(`carpool/${d.sid}/riders/${d.pid}`, { mode: 'need_help', by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() });
      ctx.toast(d.op === 'ok' ? '已確認乘客上車' : '已移出該位乘客');
      return true;
    }
    if (a === 'rt-m11-add-rider') {
      if (!u) { ctx.toast('請先登入'); return true; }
      const pid = (document.getElementById('rtM11AddPid') || {}).value;
      if (!RE_PID.test(pid || '')) return true;
      ctx.store.set(`carpool/${d.sid}/riders/${pid}`, { mode: 'carpool', carId: d.cid, status: 'ok', by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() });
      ctx.toast('已加入乘客');
      return true;
    }
    if (a === 'rt-m11-notify') {
      if (!u) { ctx.toast('請先登入'); return true; }
      const c = (((D.carpool || {})[d.sid] || {}).cars || {})[d.cid];
      const msg = String(d.msg || '').slice(0, 60);
      const up = {
        [`carpool/${d.sid}/cars/${d.cid}/status`]: msg,
        [`slotNotes/${d.sid}/n_${ctx.store.pushId()}`]: { who: String((c && c.driverName) || u.name || '司機').slice(0, 40), uid: u.uid, text: `【司機回報】${msg}（${(c && c.pickup) || '原集合點'}）`, at: Date.now() }
      };
      ctx.store.update(up);
      if (navigator.clipboard) navigator.clipboard.writeText(`【天達服務車次通知】${(c && c.driverName) || ''}：${msg}（上車點：${(c && c.pickup) || ''}）`).catch(() => {});
      ctx.toast(`已更新狀態「${msg}」並複製 LINE 訊息`);
      return true;
    }
    if (a === 'rt-m11-cancel') {
      if (!u) { ctx.toast('請先登入'); return true; }
      const cp = (D.carpool || {})[d.sid] || {};
      const c = (cp.cars || {})[d.cid];
      if (!c) return true;
      if (!confirm('確定這一場不能開車了？同車乘客將自動改成「需要協助」並通知小組長與調度台。')) return true;
      const up = { [`carpool/${d.sid}/cars/${d.cid}/cancelled`]: true, [`carpool/${d.sid}/cars/${d.cid}/status`]: '司機取消發車' };
      for (const [pid, r] of Object.entries(cp.riders || {})) {
        if (r && r.carId === d.cid) up[`carpool/${d.sid}/riders/${pid}`] = { mode: 'need_help', from: String(c.pickup || '').slice(0, 60), by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() };
      }
      const s = ctx.M.byId[d.sid];
      if (ctx.isAdmin() || ctx.myAreas().length > 0) {
        up[`dispatch/dp_${ctx.store.pushId()}`] = { sid: d.sid, title: s ? `${ctx.E.fmtD(s.d)} ${s.label || s.cat}` : d.sid, action: `司機 ${c.driverName} 取消發車，原乘客已轉為需要交通協助`, st: 'open', by: c.driverName, uid: u.uid, at: Date.now() };
      }
      ctx.store.update(up);
      ctx.toast('已標記不能開車並通知小組長與調度台');
      return true;
    }

    // C1 調度台
    if (a === 'rt-c1-shift') { RUI.c1Date = d.delta === 'reset' ? '' : addDays(RUI.c1Date || defaultBaseDate(ctx), +d.delta || 0); ctx.render(); return true; }
    if (a === 'rt-c1-leave-toggle') { RUI.c1LeaveOpen = !RUI.c1LeaveOpen; ctx.render(); return true; }
    if (a === 'rt-c1-leave-submit') {
      if (!ctx.need(ctx.isAdmin())) return true;
      const sid = (document.getElementById('rtC1LeaveSid') || {}).value;
      const pid = +(document.getElementById('rtC1LeavePid') || {}).value;
      const reason = String((document.getElementById('rtC1LeaveReason') || {}).value || '家裡有事').slice(0, 40);
      const note = String((document.getElementById('rtC1LeaveNote') || {}).value || '').slice(0, 200);
      const p = ctx.M.pById[pid];
      if (!RE_SID.test(sid || '') || !p) return true;
      ctx.store.update({
        [`rsvp/${sid}/${pid}`]: { st: 'no', by: p.n, uid: u.uid, at: Date.now() },
        [`rsvpNote/${sid}/${pid}`]: { reason, note, uid: u.uid, at: Date.now() },
        [`dispatch/dp_${ctx.store.pushId()}`]: { sid, title: `${p.n} 請假登記`, action: '總召代為登記無法出席', st: 'open', by: u.name, uid: u.uid, at: Date.now() }
      });
      RUI.c1LeaveOpen = false;
      ctx.toast(`已為 ${p.n} 登記無法出席`);
      return true;
    }
    if (a === 'rt-c1-sub-first') {
      if (!ctx.need(ctx.isAdmin())) return true;
      const s = ctx.M.byId[d.sid], p = ctx.M.pById[+d.pid];
      if (!s || !p) return true;
      const up = {
        [`dispatch/dp_${ctx.store.pushId()}`]: { sid: s.id, alertKey: d.key, title: `${ctx.E.fmtD(s.d)} ${s.label || s.cat}`, action: `排入／預排替補 ${p.n}`, st: 'done', by: u.name, uid: u.uid, at: Date.now() }
      };
      if (s.groupKey) up[`rsvp/${s.id}/${p.id}`] = { st: 'sub', origName: '同區補位', by: p.n, uid: u.uid, at: Date.now() };
      else up[`assign/${s.id}/${p.id}`] = ctx.stamp(ctx.isPreFor(s.area) ? { pre: true } : null);
      ctx.store.update(up);
      ctx.toast(`已安排 ${p.n} 替補該場`);
      return true;
    }
    if (a === 'rt-c1-action') {
      if (!ctx.need(ctx.isAdmin())) return true;
      const s = ctx.M.byId[d.sid];
      if (!s) return true;
      if (d.mode === 'note-transit') {
        ctx.store.update({
          [`slotNotes/${s.id}/n_${ctx.store.pushId()}`]: { who: String(u.name || '調度台').slice(0, 40), uid: u.uid, text: '【調度公告】請優先搭乘大眾運輸至集合點，車資可依規定登記補助。', at: Date.now() },
          [`dispatch/dp_${ctx.store.pushId()}`]: { sid: s.id, alertKey: d.key, title: `${ctx.E.fmtD(s.d)} ${s.label || s.cat}`, action: '已產生大眾運輸備案筆記', st: 'done', by: u.name, uid: u.uid, at: Date.now() }
        });
        ctx.toast('已寫入交通備案筆記並結案');
      } else {
        ctx.store.set(`dispatch/dp_${ctx.store.pushId()}`, { sid: s.id, alertKey: d.key, title: `${ctx.E.fmtD(s.d)} ${s.label || s.cat}`, action: String(d.title || '已協調通知').slice(0, 200), st: 'done', by: u.name, uid: u.uid, at: Date.now() });
        if (navigator.clipboard) navigator.clipboard.writeText(`【天達堂車隊支援徵求】${ctx.dLabel(s)} ${s.label || s.cat}（${s.area}）尚需順路車輛接送，方便支援的司機請至 M9/M10 登記！`).catch(() => {});
        ctx.toast('已記錄處理並複製徵求文案');
      }
      return true;
    }
    if (a === 'rt-c1-done') {
      if (!ctx.need(ctx.isAdmin())) return true;
      ctx.store.set(`dispatch/dp_${ctx.store.pushId()}`, { sid: d.sid || '', alertKey: d.key || '', title: String(d.title || '調度處理').slice(0, 120), action: '調度台標為已處理', st: 'done', by: String(u.name || '').slice(0, 40), uid: u.uid, at: Date.now() });
      ctx.toast('已標記為處理完成');
      return true;
    }

    // C2 需求變更
    if (a === 'rt-c2-pick') { RUI.c2Sel = d.id || ''; ctx.render(); return true; }
    if (a === 'rt-c2-add-toggle') { RUI.c2AddOpen = !RUI.c2AddOpen; ctx.render(); return true; }
    if (a === 'rt-c2-import-toggle') { RUI.c2ImportOpen = !RUI.c2ImportOpen; ctx.render(); return true; }
    if (a === 'rt-c2-add') {
      if (!ctx.need(ctx.isAdmin())) return true;
      const title = String((document.getElementById('rtC2Title') || {}).value || '').trim().slice(0, 120);
      if (!title) { ctx.toast('請輸入變更標題'); return true; }
      const id = 'CHG_' + ctx.store.pushId();
      const dates = String((document.getElementById('rtC2Dates') || {}).value || '').split(/[\s,，、]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
      ctx.store.set(`changes/${id}`, {
        id,
        kind: String((document.getElementById('rtC2Kind') || {}).value || '新增活動').slice(0, 20),
        src: String((document.getElementById('rtC2Src') || {}).value || '人工登記').slice(0, 40),
        area: String((document.getElementById('rtC2Area') || {}).value || ctx.defaultArea()).slice(0, 10),
        status: '待處理',
        title,
        detail: String((document.getElementById('rtC2Detail') || {}).value || '').slice(0, 300),
        dates,
        at: Date.now()
      });
      RUI.c2Sel = id;
      RUI.c2AddOpen = false;
      ctx.toast('已新增需求變更項目');
      return true;
    }
    if (a === 'rt-c2-import-run') {
      const raw = String((document.getElementById('rtC2ImportTxt') || {}).value || '');
      const diff = raw.split(/\r?\n/).map((line) => {
        const m = line.trim().match(/^(\d{4}-\d{2}-\d{2})[\s｜|、,，]+(.+)$/);
        if (!m) return null;
        const sameCount = ctx.M ? ctx.M.slots.filter((s) => !s.cancel && s.d === m[1]).length : 0;
        return { d: m[1], name: m[2].slice(0, 80), sameCount };
      }).filter(Boolean);
      RUI.c2ImportDiff = diff;
      ctx.render();
      ctx.toast(diff.length ? `已比對 ${diff.length} 筆行事曆差異` : '請依 YYYY-MM-DD 活動名稱 格式輸入');
      return true;
    }
    if (a === 'rt-c2-import-create') {
      if (!ctx.need(ctx.isAdmin())) return true;
      const id = 'CHG_' + ctx.store.pushId();
      ctx.store.set(`changes/${id}`, { id, kind: '新增活動', src: '行事曆匯入比對', area: '機動', status: '待處理', title: `${ctx.E.fmtD(d.d)} ${d.name}`.slice(0, 120), detail: '由新版行事曆比對轉入', dates: [d.d], at: Date.now() });
      RUI.c2Sel = id;
      RUI.c2ImportOpen = false;
      ctx.toast('已轉入變更清單');
      return true;
    }
    if (a === 'rt-c2-choose') {
      if (!ctx.need(ctx.isAdmin())) return true;
      const base = allChangesList(ctx).find((x) => x.id === d.id);
      if (!base) return true;
      ctx.store.set(`changes/${d.id}`, Object.assign({}, base, { id: d.id, chosen: d.opt, status: '已選定', at: Date.now() }));
      ctx.toast(`已選定承接方案 ${d.opt}`);
      return true;
    }
    if (a === 'rt-c2-apply-extra') {
      if (!ctx.need(ctx.isAdmin())) return true;
      const base = allChangesList(ctx).find((x) => x.id === d.id);
      if (!base || !base.dates || !base.dates[0]) return true;
      const dStr = base.dates[0];
      const exId = 'EX_C2_' + ctx.store.pushId().slice(0, 10);
      const area = ctx.WORK_AREAS.includes(base.area) ? base.area : '機動';
      ctx.store.update({
        [`extra/${exId}`]: { id: exId, d: dStr, e: dStr, area, cat: '廚務', label: String(base.title || '新增勤務').slice(0, 60), need: 6, src: 'C2需求變更' },
        [`changes/${base.id}`]: Object.assign({}, base, { id: base.id, status: '已套用', at: Date.now() })
      });
      ctx.toast(`已於 ${ctx.E.fmtD(dStr)} 建立勤務格 ${exId}`);
      return true;
    }

    // C3 回饋與檢討
    if (a === 'rt-c3-decide') {
      if (!ctx.need(ctx.isAdmin())) return true;
      ctx.store.set(`review/decisions/${d.id}`, d.v);
      ctx.toast(`已標為「${d.v}」`);
      return true;
    }
    if (a === 'rt-c3-save-targets') {
      if (!ctx.need(ctx.isAdmin())) return true;
      const up = {};
      for (const m of REVIEW_115_METRICS) {
        const el = document.getElementById('rtC3Tgt-' + m.key);
        if (el) up[`review/targets/${m.key}`] = String(el.value || '').trim().slice(0, 40) || null;
      }
      ctx.store.update(up);
      ctx.toast('已儲存 116 年目標');
      return true;
    }
    if (a === 'rt-c3-export-csv' || a === 'rt-c3-export-json') {
      const data = computeC3Data(ctx);
      if (a === 'rt-c3-export-csv') {
        const lines = ['\uFEFF日期,活動,區別,實到,應排,人數夠嗎,交通順利嗎,工作量,備註',
          ...data.fbs.map(([sid, f]) => `${f.d || ''},${sid},${f.area || ''},${f.hereCnt || 0},${f.totalCnt || 0},${f.headcount || ''},${f.transport || ''},${f.workload || ''},"${String(f.note || '').replace(/"/g, '""')}"`)];
        if (navigator.clipboard) navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
        ctx.toast('已產生並複製回饋 CSV（含 UTF-8 BOM 格式）');
      } else {
        const out = { year: 117, metricsNow: data.nowVals, decisions: (D.review || {}).decisions || {}, suggestions: data.sugs };
        if (navigator.clipboard) navigator.clipboard.writeText(JSON.stringify(out, null, 2)).catch(() => {});
        ctx.toast('已匯出並複製 117 規則與檢討 JSON');
      }
      return true;
    }

    return false;
  }

  function handleChange(a, t, d, ev, ctx) {
    if (!a || !a.startsWith('rt-')) return false;
    if (a === 'rt-c1-date') { RUI.c1Date = t.value || ''; ctx.render(); return true; }
    if (a === 'rt-m3-slot-sel') { location.hash = '#/m3/' + t.value; return true; }
    if (a === 'rt-m10-slot-sel') { location.hash = '#/m10/' + t.value; return true; }
    if (a === 'rt-m11-slot-sel') { location.hash = '#/m11/' + t.value; return true; }
    return false;
  }

  function handleSearchInput(k, val, ctx) {
    if (k === 'm6Q') {
      RUI.m6Q = String(val || '');
      const el = document.getElementById('m6List');
      if (el) el.innerHTML = renderM6List(ctx);
      return true;
    }
    if (k === 'm7Q') {
      RUI.m7Q = String(val || '');
      const el = document.getElementById('m7List');
      if (el) el.innerHTML = renderM7List(ctx);
      return true;
    }
    return false;
  }

  window.TDRuntime = {
    ROUTES,
    RUI,
    renderRoute,
    handleClick,
    handleChange,
    handleSearchInput,
    renderM1Hero,
    renderM1SlotBadge,
    renderM1Footer,
    getRuntimeSummary,
    seedDemoRuntime,
    effectiveSlotCrew,
    slotRsvpStats,
    computeC3Data
  };
})();
