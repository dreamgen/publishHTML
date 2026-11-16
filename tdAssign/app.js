/* 天達排班協作 — 各區排人、總召協調（第一階段）
 * 畫面對應設計稿：B3 本區要排的人、B6 組別成員、B4 依日期勤務、B5 分工與送出、A6 各區進度與協調
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
  const UI = { filter: '全部', q: '', out: false, outArea: '', outQ: '', showAll: false, person: null, apptQ: '', toast: '' };

  /* ---------------- 由雲端資料算出排班模型 ---------------- */
  let M = null, ISS = [], bySlot = {}, byPid = {};
  const D = () => store.data || {};
  const rec = (kind, key, pid) => ((D()[kind] || {})[key] || {})[pid];
  function recompute() {
    const st = E.freshState();
    const d = D();
    st.groups = {};
    for (const gm of BASE.groupsMeta) st.groups[gm.id] = Object.keys((d.groups || {})[gm.id] || {}).map(Number);
    st.assign = {};
    for (const sid in d.assign || {}) st.assign[sid] = { p: Object.keys(d.assign[sid]).map(Number), lk: [] };
    st.pov = {};
    for (const pid in d.pov || {}) st.pov[pid] = d.pov[pid];
    E.setState(st);
    M = E.buildModel();
    ISS = E.allIssues(M);
    bySlot = {}; byPid = {};
    for (const c of ISS) {
      for (const sid of c.slots) (bySlot[sid] = bySlot[sid] || []).push(c);
      if (c.pid != null) (byPid[c.pid] = byPid[c.pid] || []).push(c);
    }
  }

  /* ---------------- 身分與權限 ---------------- */
  const me = () => store.user;
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
  function cnt(list) { let v = 0, n = 0; for (const c of list) { if (c.lvl === '違規') v++; else n++; } return { v, n }; }
  const uniq = (a) => [...new Set(a)];
  const isClash = (c) => c.lvl === '違規' && (c.rule === 'P1' || c.rule === 'P2'); // 同一天撞到別的排班

  /* 一個組或一格目前的問題（只算和這裡有關的） */
  function groupIssues(gk) {
    const ids = new Set(groupSlots(gk).map((s) => s.id));
    const mem = new Set(M ? (E.getState().groups[gk] || []) : []);
    return uniq(ISS.filter((c) => c.slots.some((id) => ids.has(id)) && (c.pid == null || mem.has(c.pid))));
  }
  const slotIssuesOf = (sid) => bySlot[sid] || [];
  function personIssuesIn(pid, slotIds) { const S = new Set(slotIds); return (byPid[pid] || []).filter((c) => c.slots.some((id) => S.has(id)) || ['P5', 'P5b', 'P6'].includes(c.rule)); }

  /* 把一個人放進一個組（全年每一場）或一格去試算 */
  function evalInGroup(p, gk) {
    const G = groupSlots(gk), ids = new Set(G.map((s) => s.id));
    const list = (M.personSlots[p.id] || []).filter((x) => !ids.has(x.id)).concat(G).sort((a, b) => a.ds - b.ds);
    const iss = E.personIssues(M, p, list).filter((c) => c.slots.some((id) => ids.has(id)) || ['P5', 'P5b', 'P6'].includes(c.rule));
    const hard = iss.filter((c) => c.lvl === '違規'), soft = iss.filter((c) => c.lvl === '注意');
    const occN = E.occasions(list).length;
    return { p, hard, soft, occN, score: -hard.length * 1000 - soft.length * 10 - occN };
  }
  function evalInSlot(p, s) { const ev = E.evalCandidate(M, p, s); ev.occN = ev.occN + 1; return ev; }

  /* ---------------- 寫入 ---------------- */
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
    // 總召或調度台替別的區排人＝預排，要由區長確認
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
    const up = { 'meta/seeded': { at: Date.now(), by: me() ? me().name : '本機試用', from: BASE.version } };
    for (const gm of BASE.groupsMeta) for (const pid of BASE.defaultGroups[gm.id] || []) up[`groups/${gm.id}/${pid}`] = { by: 'seed', n: '115 年名單', at: Date.now() };
    return store.update(up);
  }

  /* 在線名單：每個人在哪一區、哪一頁（用時間戳判斷，2 分鐘內算在線） */
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
      return { gm, n, iss, pre, clash, done: n >= (gm.need || 1) && !clash && !pre };
    });
    const dated = areaDated(area).map((s) => {
      const si = slotIssuesOf(s.id).filter((c) => c.rule !== 'P11'), n = M.asg[s.id].p.length, need = E.slotNeed(M, s), iss = cnt(si), clash = si.filter(isClash).length;
      const pre = Object.values((D().assign || {})[s.id] || {}).filter((r) => r.pre).length;
      return { s, n, need, iss, pre, clash, done: n >= need && !clash && !pre };
    });
    const all = groups.concat(dated);
    return {
      groups, dated,
      gDone: groups.filter((x) => x.done).length, dDone: dated.filter((x) => x.done).length,
      short: dated.filter((x) => x.n < x.need).length + groups.filter((x) => x.n < (x.gm.need || 1)).length,
      v: all.reduce((a, x) => a + x.iss.v, 0), n: all.reduce((a, x) => a + x.iss.n, 0), pre: all.reduce((a, x) => a + x.pre, 0), clash: all.reduce((a, x) => a + x.clash, 0),
      status: ((D().areas || {})[area] || {}).status || 'editing', after: ((D().areas || {})[area] || {}).after || 0
    };
  }
  const ST_LABEL = { editing: ['wn', '區內排人中'], submitted: ['pl', '已送出'], confirmed: ['ok', '已確認'] };

  /* ---------------- 畫面：共用 ---------------- */
  function topbar(title, sub, back) {
    const u = me();
    const sync = store.mode === 'local' ? '本機試用' : !store.online ? `離線${store.pending ? ' · ' + store.pending + ' 筆待同步' : ''}` : store.pending ? `同步中 ${store.pending}` : '已同步';
    return `<header class="top">
      ${back ? `<a class="back" href="${back}">← 返回</a>` : `<a class="back" href="#/">天達排班協作</a>`}
      <div class="top-r"><span class="sync ${store.online ? '' : 'off'}">${esc(sync)}</span>
      ${u ? `<button class="btn sm" data-act="menu">${esc(u.name || '我')}</button>` : `<a class="btn sm pri" href="#/login">登入</a>`}</div>
      <div class="ttl"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    </header>`;
  }
  function areaNav(area, cur) {
    const it = (href, key, t) => `<a href="${href}" class="${cur === key ? 'on' : ''}">${t}</a>`;
    return `<nav class="bnav">${it('#/a/' + area, 'a', '排人')}${it('#/t/' + area, 't', '分工與送出')}${it('#/review', 'r', '各區進度')}</nav>`;
  }
  function issueLines(list, max) {
    const L = list.slice(0, max || 3);
    return L.map((c) => `<div class="iss ${c.lvl === '違規' ? 'bad' : 'warn'}">${esc(c.msg)}</div>`).join('') + (list.length > L.length ? `<div class="muted small">還有 ${list.length - L.length} 則</div>` : '');
  }

  /* ---------------- 畫面：首頁、登入 ---------------- */
  function vHome() {
    const mine = myAreas();
    const seeded = !!(D().meta || {}).seeded;
    let body = '';
    if (!seeded) {
      body += `<section class="card warnbox"><b>這個年度還沒有初始資料。</b><div class="muted">初始化會把 115 年的組別名單帶進來當起點，各區再調整。</div>
        ${store.mode === 'local' || isAdmin() ? `<button class="btn pri" data-act="seed">初始化 116 年資料</button>` : `<div class="muted">請總召或調度台登入後初始化。</div>`}</section>`;
    }
    if (me() && !mine.length && !isAdmin()) {
      body += `<section class="card"><b>您還不是任何一區的排班人員。</b><div class="muted">可以先瀏覽；要排班請到自己的區按「申請成為排班人員」，由區長或調度台同意。</div></section>`;
    }
    body += `<section class="list">` + WORK_AREAS.map((a) => {
      const s = seeded ? areaStats(a) : null, m = mine.includes(a);
      const tot = s ? s.groups.length + s.dated.length : 0;
      if (s && !tot) return '';
      const [cls, lab] = ST_LABEL[s ? s.status : 'editing'];
      return `<a class="row" href="#/a/${a}"><div class="row-h"><b class="c-${a}">${a}</b>${m ? tag('ok', '我負責') : ''}${s ? tag(cls, lab) : ''}</div>
        ${s ? `<div class="muted small">組別 ${s.gDone}／${s.groups.length} · 依日期 ${s.dDone}／${s.dated.length}${s.clash ? ` · <span class="t-bad">撞到 ${s.clash}</span>` : ''}${s.pre ? ` · 預排待確認 ${s.pre}` : ''}</div>` : ''}</a>`;
    }).join('') + `</section>`;
    body += `<a class="btn wide" href="#/review">各區進度與跨區協調</a>`;
    return topbar('116 年各區排人', store.mode === 'local' ? '本機試用模式：資料只存在這台裝置' : '人由各區排；總召檢查衝突與協調') + `<main>${body}</main>`;
  }
  function vLogin() {
    let body;
    if (store.mode === 'local') {
      const opt = (who, t, d) => `<button class="row" data-act="local-in" data-who='${esc(JSON.stringify(who))}'><b>${esc(t)}</b><div class="muted small">${esc(d)}</div></button>`;
      body = `<section class="card"><b>本機試用模式</b><div class="muted">還沒有連上 Firebase。選一個身分試用，資料只存在這台裝置；開兩個分頁選不同身分，可以模擬多人同時排。</div></section>
        <section class="list">${opt({ uid: 'local-admin', name: '總召（試用）', admin: true }, '總召、調度台', '看各區進度、協調、預排、指定排班人員')}
        ${AREAS.map((a) => opt({ uid: 'local-lead-' + a, name: a + '區長（試用）', leadOf: a }, a + ' 區長', '排本區的人、指定排班人員、確認預排、送出')).join('')}
        ${opt({ uid: 'local-u1', name: '道親甲（試用）' }, '一般道親', '還不是排班人員：可瀏覽、可申請加入')}</section>`;
    } else {
      body = `<section class="card"><b>查班表不用登入。</b><div class="muted">登入是為了知道是誰排的；要排班還需要區長或調度台把您指定為排班人員。</div></section>
        <button class="btn pri big" data-act="in" data-kind="google">使用 Google 帳號登入</button>
        ${CFG.lineChannelId && CFG.lineWorkerUrl ? `<button class="btn big" data-act="in" data-kind="line">使用 LINE 登入</button>` : `<div class="muted small">LINE 登入尚未設定（需要 Channel ID 與後端網址，見 README）。</div>`}`;
    }
    return topbar('登入', '', '#/') + `<main>${body}${store.error ? `<div class="iss bad">${esc(store.error)}</div>` : ''}</main>`;
  }

  /* ---------------- 畫面：B3 本區要排的人 ---------------- */
  function reminders(area, S) {
    const out = [];
    const preRows = [];
    for (const g of S.groups) for (const pid in (D().groups || {})[g.gm.id] || {}) if (D().groups[g.gm.id][pid].pre) preRows.push({ href: '#/g/' + g.gm.id, t: `${g.gm.name}：${(M.pById[pid] || {}).n || pid}`, r: D().groups[g.gm.id][pid] });
    for (const x of S.dated) for (const pid in (D().assign || {})[x.s.id] || {}) if (D().assign[x.s.id][pid].pre) preRows.push({ href: '#/s/' + x.s.id, t: `${slotName(x.s)}：${(M.pById[pid] || {}).n || pid}`, r: D().assign[x.s.id][pid] });
    if (preRows.length) out.push(`<div class="rem"><b>預排待區長確認 ${preRows.length} 筆</b>${preRows.slice(0, 4).map((r) => `<a href="${r.href}">${esc(r.t)}<span class="muted small">（${esc(r.r.n || '')} 預排）</span></a>`).join('')}</div>`);
    const pend = Object.entries((D().members || {})[area] || {}).filter(([, m]) => m.status === 'pending');
    if (pend.length && (isLead(area) || isAdmin())) out.push(`<div class="rem"><b>申請成為排班人員 ${pend.length} 人</b><a href="#/t/${area}">${pend.map(([, m]) => esc(m.name)).join('、')} → 去處理</a></div>`);
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
    const keep = (x) => UI.filter === '全部' || (UI.filter === '還沒排好' && !x.done) || (UI.filter === '有問題' && (x.iss.v || x.pre));
    const chips = ['全部', '還沒排好', '有問題'].map((t) => `<button class="chip ${UI.filter === t ? 'on' : ''}" data-act="filter" data-v="${t}">${t}</button>`).join('');
    const st = (x, short) => (x.pre ? tag('pre', `預排 ${x.pre}`) : '') + (x.clash ? tag('bad', `撞到 ${x.clash}`) : '') + (short ? tag('bad', short) : '') + (x.done ? tag('ok', '排好') : '') + (x.iss.v - x.clash > 0 ? tag('wn', `違規 ${x.iss.v - x.clash}`) : '') + (x.iss.n ? tag('no', `注意 ${x.iss.n}`) : '');
    const gRows = S.groups.filter(keep).map((g) => {
      const slots = groupSlots(g.gm.id), ed = present(area, 'g/' + g.gm.id).filter((u) => !me() || u.uid !== me().uid);
      return `<a class="row" href="#/g/${g.gm.id}"><div class="row-h"><b>${esc(g.gm.name)}</b><span class="num">${g.n} 人</span></div>
        <div class="muted small">全年 ${slots.length} 場${g.gm.need ? ` · 每場需要 ${g.gm.need} 人` : ''}</div>
        <div class="row-t">${st(g, g.n < (g.gm.need || 1) ? '人數不足' : '')}${ed.length ? `<span class="muted small">${esc(ed.map((u) => u.name).join('、'))} 正在編輯</span>` : ''}</div></a>`;
    }).join('');
    const dRows = S.dated.filter(keep).map((x) => {
      const ed = present(area, 's/' + x.s.id).filter((u) => !me() || u.uid !== me().uid);
      return `<a class="row" href="#/s/${x.s.id}"><div class="row-h"><b>${esc(slotName(x.s))}</b><span class="num ${x.n < x.need ? 't-bad' : ''}">${x.n}／${x.need}</span></div>
        <div class="row-t">${st(x, x.n < x.need ? (x.n ? `缺 ${x.need - x.n}` : '還沒排') : '')}${ed.length ? `<span class="muted small">${esc(ed.map((u) => u.name).join('、'))} 正在編輯</span>` : ''}</div></a>`;
    }).join('');
    const m = memberOf(area);
    const join = me() && !isAdmin() && AREAS.includes(area) && !m ? `<button class="btn wide" data-act="join" data-area="${area}">申請成為 ${area} 的排班人員</button>` : m && m.status === 'pending' ? `<div class="card muted">已申請成為排班人員，等區長或調度台同意。</div>` : '';
    return topbar(`${area}　本區要排的人`, `${tag(cls, lab)}${S.after ? tag('pl', `送出後變更 ${S.after}`) : ''}`, '#/') + `<main>
      ${here.length ? `<div class="pres">${avatars(here)}<span class="muted small">${here.length} 人正在作業 · 改動即時同步</span></div>` : ''}
      ${join}${reminders(area, S)}
      <div class="chips">${chips}</div>
      <div class="sec-h"><h2>組別</h2><span class="num muted">排好 ${S.gDone}／${S.groups.length} 組</span></div>
      <div class="muted small">改組員，全年每一場自動帶入。不能只改某一天。</div>
      <section class="list">${gRows || '<div class="empty">沒有符合的組別</div>'}</section>
      <div class="sec-h"><h2>依日期排（沒有組別）</h2><span class="num muted">排滿 ${S.dDone}／${S.dated.length} 格</span></div>
      <section class="list">${dRows || '<div class="empty">沒有符合的勤務</div>'}</section>
      <div class="muted small">哪一區、哪一天、哪一組由總召排定。標「預排」的人是總召或調度台先排的，必須由區長確認或重排。</div>
    </main>${areaNav(area, 'a')}`;
  }

  /* ---------------- 畫面：B6 組別成員、B4 依日期勤務（共用） ---------------- */
  function otherWork(pid, exceptIds, focusIds) {
    // 直接顯示這個人其他的排班內容（協調優先於隱私）
    const ex = new Set(exceptIds), L = (M.personSlots[pid] || []).filter((s) => !ex.has(s.id) && (!focusIds || focusIds.includes(s.id)));
    return L.map((s) => {
      const r = s.groupKey ? rec('groups', s.groupKey, pid) : rec('assign', s.id, pid);
      const gm = s.groupKey ? gmOf(s.groupKey) : null;
      return `<div class="other"><b>${esc(dLabel(s))}${esc(s.label || s.cat)}</b><div class="muted small">${esc(s.cat)} · ${esc(gm ? gm.name + '（組員，全年）' : s.area)} · ${esc(s.loc || '')}${r && r.n ? ` · ${esc(r.n)} 排入` : ''}</div></div>`;
    }).join('');
  }
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
      ${otherIds.length ? `<div class="clash"><div class="small"><b>同時也排在：</b></div>${otherWork(p.id, ctxIds, otherIds)}
        <div class="acts">${canEdit ? `<button class="btn sm" data-act="rm" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">從這裡移出</button>` : ''}
        ${me() ? `<button class="btn sm" data-act="coord" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}" data-msg="${esc(clash[0].msg)}">請總召協調</button>` : ''}</div></div>` : ''}
      ${r && r.pre ? `<div class="prebox"><span class="small">必須由區長確認或重排</span>${lead ? `<div class="acts"><button class="btn sm pri" data-act="pre-ok" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">確認</button><button class="btn sm" data-act="rm" data-kind="${kind}" data-key="${key}" data-pid="${p.id}" data-area="${area}" data-label="${esc(label)}">重排（移出）</button></div>` : ''}</div>` : ''}
    </div>`;
  }
  function roleOf(p) { return [p.cr, p.lead].filter(Boolean).join('、'); }
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
    const rows = mem.map((p) => ({ p, r: rec('groups', gk, p.id), iss: personIssuesIn(p.id, ids) }))
      .sort((a, b) => (b.r && b.r.pre ? 1 : 0) - (a.r && a.r.pre ? 1 : 0) || cnt(b.iss).v - cnt(a.iss).v || cnt(b.iss).n - cnt(a.iss).n);
    const quiet = rows.filter((x) => !x.iss.length && !(x.r && x.r.pre)), loud = rows.filter((x) => !quiet.includes(x));
    const showQuiet = UI.showAll || quiet.length <= 6;
    const ed = present(area, 'g/' + gk).filter((u) => !me() || u.uid !== me().uid);
    const local = AREAS.includes(area) ? M.people.filter((p) => p.a === area && !p.off) : M.people.filter((p) => AREAS.includes(p.a) && !p.off);
    const need = gm.need || 0;
    return topbar(gm.name, `${esc(gm.cat)} · ${mem.length} 人${need ? ` · 每場需要 ${need} 人` : ''}`, '#/a/' + area) + `<main>
      <section class="card"><div class="small muted"><b>這一組今年負責 ${slots.length} 場</b>（總召排定）</div>
        <div class="dates">${slots.map((s) => `<span>${esc(dLabel(s))}${esc(s.label || s.cat)}</span>`).join('') || '<span>尚未排定場次</span>'}</div>
        <div class="muted small">改組員會套用到這 ${slots.length} 場。某一天有人不能來，是定版後在調度台找代班，不在這裡改。</div></section>
      ${ed.length ? `<div class="edbox">${avatars(ed)}<span>${esc(ed.map((u) => u.name).join('、'))} 也在改這一組，改動會立刻出現。</span></div>` : ''}
      ${!canEdit ? `<div class="card muted">${me() ? '您不是這一區的排班人員，只能瀏覽。' : '登入並成為排班人員後才能調整。'}</div>` : ''}
      <section class="card members"><h2>組員</h2>
        ${loud.map((x) => memberRow(x.p, x.r, x.iss, 'groups', gk, area, gm.name, canEdit, ids)).join('')}
        ${showQuiet ? quiet.map((x) => memberRow(x.p, x.r, x.iss, 'groups', gk, area, gm.name, canEdit, ids)).join('') : `<button class="btn wide" data-act="more">其餘 ${quiet.length} 人沒有問題，點開看全部</button>`}
        ${!mem.length ? '<div class="empty">還沒有組員</div>' : ''}</section>
      ${canEdit ? finder(area, inIds, 'groups', gk, gm.name, (p) => evalInGroup(p, gk), canEdit, local) : ''}
      ${canEdit && (BASE.defaultGroups[gk] || []).length ? `<button class="btn wide" data-act="last-year" data-gk="${gk}">帶入 115 年名單（補上不在組裡的人）</button>` : ''}
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
    const quiet = rows.filter((x) => !x.iss.length && !(x.r && x.r.pre)), loud = rows.filter((x) => !quiet.includes(x));
    const showQuiet = UI.showAll || quiet.length <= 6;
    const ed = present(area, 's/' + sid).filter((u) => !me() || u.uid !== me().uid);
    const slotOnly = slotIssuesOf(sid).filter((c) => c.pid == null);
    const local = E.poolFor(M, s, false);
    return topbar(label, `${esc(s.loc || '')} · 需要 ${need} 人 · <b class="${A.length < need ? 't-bad' : 't-ok'}">已排 ${A.length}</b>`, '#/a/' + area) + `<main>
      ${ed.length ? `<div class="edbox">${avatars(ed)}<span>${esc(ed.map((u) => u.name).join('、'))} 也在排這一格。加的人會立刻出現，不會互相蓋掉。</span></div>` : ''}
      ${!canEdit ? `<div class="card muted">${me() ? '您不是這一區的排班人員，只能瀏覽。' : '登入並成為排班人員後才能調整。'}</div>` : ''}
      ${slotOnly.length ? `<div class="card">${issueLines(slotOnly, 4)}</div>` : ''}
      <section class="card members"><h2>已排人員</h2>
        ${loud.map((x) => memberRow(x.p, x.r, x.iss, 'assign', sid, area, label, canEdit, [sid])).join('')}
        ${showQuiet ? quiet.map((x) => memberRow(x.p, x.r, x.iss, 'assign', sid, area, label, canEdit, [sid])).join('') : `<button class="btn wide" data-act="more">其餘 ${quiet.length} 人沒有問題，點開看全部</button>`}
        ${!A.length ? '<div class="empty">還沒有排人</div>' : ''}</section>
      ${canEdit ? finder(area, inIds, 'assign', sid, label, (p) => evalInSlot(p, s), canEdit, local) : ''}
    </main>${areaNav(area, 'a')}`;
  }

  /* ---------------- 畫面：B5 分工與送出 ---------------- */
  function vTeam(area) {
    const S = areaStats(area), mems = Object.entries((D().members || {})[area] || {});
    const boss = isLead(area) || isAdmin();
    const [cls, lab] = ST_LABEL[S.status];
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
      ? S.status === 'editing' ? `<button class="btn pri big" data-act="submit" data-area="${area}">送出給總召確認</button>` : `<button class="btn" data-act="unsubmit" data-area="${area}">收回，繼續排</button>`
      : `<div class="muted small">只有區長能送出。</div>`;
    return topbar(`${area}　分工與送出`, tag(cls, lab), '#/a/' + area) + `<main>
      <div class="muted">一開始只有區長是排班人員。其他人要由區長或調度台指定後才能排。</div>
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

  /* ---------------- 畫面：A6 各區進度與協調 ---------------- */
  function vReview() {
    if (!(D().meta || {}).seeded) return vHome();
    const rows = WORK_AREAS.map((a) => ({ a, S: areaStats(a) })).filter((x) => x.S.groups.length + x.S.dated.length);
    const tbl = rows.map(({ a, S }) => {
      const [cls, lab] = ST_LABEL[S.status], tot = S.groups.length + S.dated.length, done = S.gDone + S.dDone;
      const mem = Object.values((D().members || {})[a] || {}).filter((m) => m.status === 'ok');
      const on = present(a).length;
      const act = isAdmin() && S.status === 'submitted' ? `<button class="btn sm pri" data-act="confirm-area" data-area="${a}">確認</button><button class="btn sm" data-act="return-area" data-area="${a}">退回</button>` : '';
      return `<div class="arow"><a href="#/a/${a}" class="c-${a}"><b>${a}</b></a>${tag(cls, lab)}${S.after ? tag('pl', `送出後變更 ${S.after}`) : ''}
        <div class="bar"><div style="width:${tot ? Math.round(done / tot * 100) : 0}%"></div></div><span class="num small">${done}／${tot}</span>
        <div class="muted small">缺人 ${S.short} · <span class="${S.clash ? 't-bad' : ''}">撞到 ${S.clash}</span> · 其他違規 ${S.v - S.clash} · 注意 ${S.n}${S.pre ? ` · 預排待確認 ${S.pre}` : ''} · 排班人員 ${mem.length ? mem.length + ' 人' : '尚未指定'}${on ? ` · ${on} 人作業中` : ''}</div>
        <div class="acts">${act}<a class="btn sm" href="#/t/${a}">排班人員</a></div></div>`;
    }).join('');
    const coord = Object.entries(D().coord || {}).sort((a, b) => b[1].at - a[1].at);
    const openC = coord.filter(([, c]) => c.st !== 'done');
    const crossAll = ISS.filter(isClash).length, cross = ISS.filter(isClash).slice(0, UI.showAll ? 300 : 12);
    return topbar('各區進度與跨區協調', '人由各區排；這裡看進度、處理衝突', '#/') + `<main>
      <section class="card">${tbl}</section>
      <section class="card"><h2>各區請總召協調（${openC.length}）</h2>
        ${openC.map(([id, c]) => `<div class="mem"><div class="mem-h"><b class="c-${esc(c.area)}">${esc(c.area)}</b><span class="muted small">${esc(c.name)} · ${ago(c.at)}</span>${isAdmin() ? `<button class="btn sm" data-act="coord-done" data-id="${id}">已處理</button>` : ''}</div>
          <div>${esc(c.label)}：${esc(c.msg)}</div>${c.pid ? `<button class="link" data-act="person" data-pid="${c.pid}">看 ${esc((M.pById[c.pid] || {}).n || '')} 的全年排班</button>` : ''}</div>`).join('') || '<div class="empty">目前沒有</div>'}</section>
      <section class="card"><h2>同一人撞到的排班（${crossAll}）</h2><div class="muted small">兩邊排的當下都看得到對方的內容；這裡列出還沒有人換的。</div>
        ${cross.map((c) => `<div class="mem"><div class="iss bad">${esc(c.msg)}</div><button class="link" data-act="person" data-pid="${c.pid}">看全年排班</button>
          ${c.slots.map((id) => { const s = M.byId[id]; return s ? ` <a class="small" href="${s.groupKey ? '#/g/' + s.groupKey : '#/s/' + id}">${esc(s.area)} ${esc(s.groupKey ? gmOf(s.groupKey).name : s.cat)}</a>` : ''; }).join('')}</div>`).join('') || '<div class="empty">沒有</div>'}
        ${crossAll > cross.length ? `<button class="btn wide" data-act="more">顯示全部</button>` : ''}</section>
      <div class="muted small">總召或調度台替各區排人時會標成「預排」，必須由該區區長確認或重排。指定各區排班人員：按各區右側的「排班人員」。</div>
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
  function route() { const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')); const [v, ...rest] = h.split('/'); return { v: v || '', arg: rest.join('/') }; }
  function render() {
    if (!store.ready) { $('#app').innerHTML = '<div class="empty">載入中…</div>'; return; }
    recompute();
    const r = route(), key = r.v + '/' + r.arg;
    if (key !== lastRoute) { UI.q = ''; UI.out = false; UI.outQ = ''; UI.showAll = false; UI.filter = '全部'; UI.apptQ = ''; lastRoute = key; window.scrollTo(0, 0); onEnter(r); }
    const ae = document.activeElement, keepId = ae && ae.id, pos = ae && ae.selectionStart;
    const sc = window.scrollY;
    let html;
    if (r.v === 'login') html = me() ? (location.replace('#/'), '') : vLogin();
    else if (r.v === 'a' && WORK_AREAS.includes(r.arg)) html = vArea(r.arg);
    else if (r.v === 'g') html = vGroup(r.arg);
    else if (r.v === 's') html = vSlot(r.arg);
    else if (r.v === 't' && WORK_AREAS.includes(r.arg)) html = vTeam(r.arg);
    else if (r.v === 'review') html = vReview();
    else html = vHome();
    $('#app').innerHTML = html + (UI.person ? personSheet(UI.person) : '') + `<div id="toast" role="status" hidden></div>` + (store.error ? `<div class="errbar">${esc(store.error)}</div>` : '');
    if (keepId) { const el = document.getElementById(keepId); if (el) { el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch (e) { } } }
    window.scrollTo(0, sc);
  }
  function onEnter(r) {
    let area = '', where = '';
    if (r.v === 'a' || r.v === 't') area = r.arg;
    else if (r.v === 'g' && gmOf(r.arg)) { area = gmOf(r.arg).area; where = 'g/' + r.arg; }
    else if (r.v === 's' && M && M.byId[r.arg]) { area = M.byId[r.arg].area; where = 's/' + r.arg; }
    beat(memberOf(area) || isAdmin() ? area : '', where);
  }

  /* ---------------- 事件 ---------------- */
  const need = (ok, msg) => { if (!ok) toast(msg || '沒有權限'); return ok; };
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act]'); if (!t) return;
    const a = t.dataset.act, d = t.dataset;
    if (a === 'seed') seedDefaults().then(() => toast('已帶入 115 年組別名單'));
    else if (a === 'local-in') store.signIn(JSON.parse(d.who)).then(() => { location.hash = '#/'; });
    else if (a === 'in') store.signIn(d.kind).catch((e) => toast('登入沒有完成：' + (e.code || e.message)));
    else if (a === 'menu') { if (confirm(`目前登入：${me().name}\n要登出嗎？`)) { beat('', ''); store.signOut(); } }
    else if (a === 'filter') { UI.filter = d.v; render(); }
    else if (a === 'more') { UI.showAll = true; render(); }
    else if (a === 'out') { UI.out = d.v === '1'; UI.showAll = false; render(); const el = document.getElementById(UI.out ? 'outQ' : 'q'); if (el) el.focus(); }
    else if (a === 'person') { UI.person = +d.pid; render(); }
    else if (a === 'close-person') { UI.person = null; render(); }
    else if (a === 'add') { if (need(can(d.area, d.kind === 'groups' ? kindOfGroup(d.key) : 'jz'))) addPerson(d.kind, d.key, +d.pid, d.area, d.label); }
    else if (a === 'rm') { if (need(can(d.area, d.kind === 'groups' ? kindOfGroup(d.key) : 'jz'))) removePerson(d.kind, d.key, +d.pid, d.area, d.label); }
    else if (a === 'pre-ok') { if (need(isLead(d.area) || (isAdmin() && !AREAS.includes(d.area)), '預排必須由區長確認')) confirmPre(d.kind, d.key, +d.pid, d.area, d.label); }
    else if (a === 'last-year') {
      const gk = d.gk, gm = gmOf(gk); if (!need(can(gm.area, kindOfGroup(gk)))) return;
      const cur = new Set(E.getState().groups[gk] || []), add = (BASE.defaultGroups[gk] || []).filter((id) => !cur.has(id) && M.pById[id]);
      if (!add.length) return toast('115 年名單的人都已經在組裡');
      const up = {}; for (const id of add) up[`groups/${gk}/${id}`] = stamp();
      store.update(Object.assign(up, logOp(gm.area, `${gm.name} 帶入 115 年名單 ${add.length} 人`), touchArea(gm.area))); toast(`已補上 ${add.length} 人`);
    }
    else if (a === 'coord') {
      const id = store.pushId();
      store.update(Object.assign({ ['coord/' + id]: { area: d.area, pid: +d.pid, label: d.label, msg: d.msg, uid: me().uid, name: me().name, at: Date.now(), st: 'open' } }, logOp(d.area, `${d.label} 請總召協調：${d.msg}`)));
      toast('已送給總召');
    }
    else if (a === 'coord-done') { if (need(isAdmin())) store.update({ [`coord/${d.id}/st`]: 'done', [`coord/${d.id}/doneBy`]: me().name }); }
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && UI.person) { UI.person = null; render(); } });

  store.onChange(render);
  store.init().then(() => {
    if (store.mode === 'local' && !(store.data.meta || {}).seeded) seedDefaults();
    render();
  }).catch((e) => { $('#app').innerHTML = `<div class="iss bad">無法啟動：${esc(e.message)}</div>`; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => { });
  window.__td = { store, E, get M() { return M; }, get ISS() { return ISS; } };
})();
