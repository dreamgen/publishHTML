/* 講師愿力表系統 — 實作版講師手機端 PWA (獨立填寫 + 目標頁籤切換) */
(function (global) {
  'use strict';

  const { METRIC_META, computeKrProgress, computeGoalStats, computeLecturerStats } = global.VowEngine;
  const MY_ID_KEY = 'vow_my_lecturer_id_v1';

  const urlTab = new URLSearchParams(global.location.search).get('tab');
  const state = {
    myId: localStorage.getItem(MY_ID_KEY) || '',
    tab: ['overview', 'monthly', 'new', 'print'].includes(urlTab) ? urlTab : 'monthly',
    activeGoalIndex: 0,
    activeMonth: new Date().getMonth() + 1,
    elderMode: false,
    cloudMode: 'local',
    cloudUid: null
  };

  let toastTimer = null;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg) {
    const box = document.getElementById('toastBox');
    const txt = document.getElementById('toastText');
    if (!box || !txt) return;
    txt.textContent = msg;
    box.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add('hidden'), 2600);
  }

  function getMyLecturer() {
    const list = global.VowStore.getLecturers();
    if (state.cloudUid) {
      const byUid = list.find((l) => l.lineUid === state.cloudUid);
      if (byUid) {
        state.myId = byUid.id;
        localStorage.setItem(MY_ID_KEY, byUid.id);
        return byUid;
      }
    }
    if (state.myId) {
      const found = list.find((l) => l.id === state.myId);
      if (found) return found;
    }
    return null;
  }

  function renderOnboarding() {
    const cfg = global.VOW_CONFIG || {};
    const hasLineLogin = Boolean(cfg.lineChannelId && cfg.lineWorkerUrl);
    return `
      <div class="pwa-shell">
        <header class="pwa-topbar">
          <div class="pwa-topbar-inner">
            <div class="row-wrap">
              <div class="brand-logo" style="width:32px;height:32px;font-size:15px;">愿</div>
              <strong style="font-size:16px;">講師愿力表系統｜個人實作版</strong>
            </div>
            <a href="./index.html" class="btn btn-ghost" style="padding:5px 12px;font-size:12px;text-decoration:none;">📊 總覽 / Demo 版</a>
          </div>
        </header>

        <div class="pwa-body">
          <div class="onboarding-layout">
            <!-- 電腦版左側品牌與特色介紹 -->
            <section class="onboarding-hero">
              <div class="stack">
                <span class="badge badge-amber" style="align-self:flex-start;">2026 年度 ‧ 紙電雙軌</span>
                <h1 style="margin:0;font-size:28px;line-height:1.35;">法會誠心立愿<br/>平時自主精進</h1>
                <p style="margin:0;font-size:14px;color:rgba(254,243,199,0.88);line-height:1.7;">
                  免記帳號密碼，綁定 LINE 帳號或認領法會紙本建檔碼即可使用；支援手機單手操作與電腦大螢幕管理。
                </p>
              </div>

              <div class="stack" style="gap:12px;margin-top:24px;">
                <div style="background:rgba(56,28,19,0.72);border:1px solid rgba(200,155,75,0.35);border-radius:12px;padding:14px;">
                  <strong style="color:#fcd34d;">🌟 目標頁籤切換 × 五星評比</strong>
                  <div class="text-xs" style="color:#e6dcd0;margin-top:4px;">依百分比、累積次數、週期期限（3～12 個月）、里程碑與心得自評自動換算星級。</div>
                </div>
                <div style="background:rgba(56,28,19,0.72);border:1px solid rgba(200,155,75,0.35);border-radius:12px;padding:14px;">
                  <strong style="color:#84B39D;">🗓️ 1～12 月自由回報與心得</strong>
                  <div class="text-xs" style="color:#e6dcd0;margin-top:4px;">不強制每週打卡，隨時補填各月進度與修辦心得，並支援母堂呈表 A4 列印。</div>
                </div>
              </div>
            </section>

            <!-- 右側 / 手機版啟用表單 -->
            <div class="onboarding-box stack">
              <div>
                <span class="badge badge-green">個人實作版 PWA</span>
                <h2 style="margin:8px 0 4px;font-size:20px;color:var(--brand);">歡迎啟用講師愿力表 🙏</h2>
                <p class="text-xs" style="color:var(--muted);margin:0;">可透過 LINE 登入、認領法會紙本建檔碼，或直接建立您的個人愿力表。</p>
              </div>

              ${hasLineLogin && !state.cloudUid ? `
                <button type="button" class="btn btn-line" style="justify-content:center;padding:12px;" data-action="line-login">
                  🟢 使用 LINE 帳號登入並自動綁定
                </button>
              ` : ''}

              <form id="claimCodeForm" class="control-box">
                <strong class="text-xs">📝 若您有法會紙本代登「綁定碼」(例如 VOW-L03)：</strong>
                <div style="display:flex;gap:8px;">
                  <input id="claimCodeInput" type="text" placeholder="輸入綁定碼 VOW-XXXX" />
                  <button type="submit" class="btn btn-outline" style="white-space:nowrap;">認領檔案</button>
                </div>
              </form>

              <form id="createSelfForm" class="stack" style="border-top:1px solid var(--border);padding-top:14px;">
                <strong style="font-size:14px;color:var(--brand);">✨ 建立我的個人愿力表</strong>
                <div>
                  <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">講師姓名 *</label>
                  <input id="selfName" type="text" required placeholder="請輸入您的姓名" />
                </div>
                <div>
                  <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">所屬單位 / 佛堂 *</label>
                  <select id="selfUnit">
                    <option value="台北一區">台北一區</option>
                    <option value="台北二區">台北二區</option>
                    <option value="教學組">教學組</option>
                    <option value="成全組">成全組</option>
                  </select>
                </div>
                <div>
                  <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">2026 年度核心精進愿景 *</label>
                  <input id="selfVision" type="text" required placeholder="例如：讓自己的道學更精進" />
                </div>
                <button type="submit" class="btn btn-primary" style="justify-content:center;padding:12px;">建立並進入我的愿力表 ➔</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderGoalTabsBar(lec) {
    const goals = lec.goals || [];
    if (state.activeGoalIndex >= goals.length) state.activeGoalIndex = 0;

    const tabsHtml = goals
      .map((g, idx) => {
        const st = computeGoalStats(g);
        return `
          <button type="button" class="goal-tab ${idx === state.activeGoalIndex ? 'active' : ''}" data-action="select-goal-tab" data-idx="${idx}">
            <span>目標 ${idx + 1}</span>
            <span class="tab-star">★${st.stars.toFixed(1)}</span>
          </button>
        `;
      })
      .join('');

    return `
      <div class="goal-tabs-bar" role="tablist" aria-label="愿力目標頁籤">
        ${tabsHtml}
        <button type="button" class="goal-tab" data-action="go-tab" data-tab="new" style="border-style:dashed;color:var(--line-green);">＋ 新增目標</button>
      </div>
    `;
  }

  function renderKrEditor(goalId, kr) {
    const meta = METRIC_META[kr.type] || METRIC_META.PERCENT;
    const progress = computeKrProgress(kr, 12);
    const mv = kr.monthlyValues || {};
    const monthVal = mv[state.activeMonth] !== undefined ? mv[state.activeMonth] : '';
    const refText = (kr.reflections && kr.reflections[state.activeMonth]) || '';

    let controlHtml = '';
    if (kr.type === 'PERCENT') {
      const val = monthVal !== '' ? Number(monthVal) : progress;
      controlHtml = `
        <div class="row-between text-xs">
          <strong>${state.activeMonth}月進度：</strong>
          <strong style="color:var(--brand);font-size:16px;">${val}%</strong>
        </div>
        <input type="range" min="0" max="100" step="5" value="${val}" data-action="range-kr" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" />
        <div class="row-wrap">
          ${[0, 25, 50, 75, 100].map((p) => `<button type="button" class="btn ${val === p ? 'btn-primary' : 'btn-outline'}" style="padding:6px 10px;" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${p}">${p}%</button>`).join('')}
        </div>
      `;
    } else if (kr.type === 'COUNT') {
      const val = Number(monthVal || 0);
      const totalSum = Object.values(mv).reduce((a, b) => a + Number(b || 0), 0);
      controlHtml = `
        <div class="row-between">
          <div class="text-xs">
            <strong>${state.activeMonth}月新增（目標 ${kr.targetValue} ${esc(kr.unitLabel)}）</strong><br/>
            <span style="color:var(--muted);">累計：${totalSum} ${esc(kr.unitLabel)}（上限 100%）</span>
          </div>
          <div class="row-wrap">
            <button type="button" class="btn btn-outline" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${Math.max(0, val - 1)}">－</button>
            <strong style="min-width:44px;text-align:center;">${val}</strong>
            <button type="button" class="btn btn-primary" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${val + 1}">＋</button>
          </div>
        </div>
      `;
    } else if (kr.type === 'PERIODIC') {
      const val = monthVal !== '' ? Number(monthVal) : -1;
      const dur = Math.min(12, Math.max(3, Number(kr.durationMonths || kr.targetValue || 12)));
      controlHtml = `
        <div class="row-between text-xs">
          <strong>${state.activeMonth}月打卡（期限 ${dur} 個月）：</strong>
          <select data-action="set-periodic-duration" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" style="width:auto;padding:3px 8px;font-size:12px;">
            ${[3, 4, 5, 6, 9, 12].map((d) => `<option value="${d}" ${dur === d ? 'selected' : ''}>${d} 個月</option>`).join('')}
          </select>
        </div>
        <div class="row-wrap">
          <button type="button" class="btn ${val === 100 ? 'btn-line' : 'btn-outline'}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="100">✅ 達成</button>
          <button type="button" class="btn ${val === 50 ? 'btn-amber' : 'btn-outline'}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="50">⏳ 進行中</button>
          <button type="button" class="btn ${val === 0 ? 'btn-primary' : 'btn-outline'}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="0">❌ 未執行</button>
        </div>
      `;
    } else if (kr.type === 'MILESTONE') {
      const steps = kr.milestones || ['階段 1：資料準備', '階段 2：初稿撰寫', '階段 3：演練修正', '階段 4：正式圓滿'];
      const doneCount = monthVal !== '' ? Number(monthVal) : Math.round((progress / 100) * steps.length);
      controlHtml = `
        <div class="text-xs"><strong>截至 ${state.activeMonth}月完成階段：</strong></div>
        <div class="milestone-grid">
          ${steps.map((sName, idx) => {
            const stepNum = idx + 1;
            const checked = stepNum <= doneCount;
            const nextVal = checked && doneCount === stepNum ? stepNum - 1 : stepNum;
            return `<button type="button" class="milestone-btn ${checked ? 'done' : ''}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${nextVal}"><span>${checked ? '☑' : '☐'}</span><span>${esc(sName)}</span></button>`;
          }).join('')}
        </div>
      `;
    } else if (kr.type === 'QUALITATIVE') {
      const score = monthVal !== '' ? Number(monthVal) : Math.round((progress / 100) * 5);
      controlHtml = `
        <div class="text-xs"><strong>${state.activeMonth}月修辦自評（1～5 分）：</strong></div>
        <div class="row-wrap">
          ${[1, 2, 3, 4, 5].map((sc) => `<button type="button" class="btn ${score === sc ? 'btn-primary' : 'btn-outline'}" style="padding:6px 10px;" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${sc}">★${sc}</button>`).join('')}
        </div>
      `;
    }

    return `
      <div class="card stack" style="gap:10px;">
        <div class="row-between">
          <div>
            <span class="badge ${meta.badgeClass}">${meta.icon} ${meta.label}</span>
            <div style="font-weight:700;font-size:15px;margin-top:4px;">${esc(kr.title)}</div>
          </div>
          <strong style="font-size:18px;color:var(--brand);">${progress}%</strong>
        </div>
        <div class="text-xs" style="color:var(--muted);">
          <div><strong>做法：</strong>${esc(kr.action)}</div>
          <div><strong>考量：</strong>${esc(kr.reason)}</div>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
        <div class="control-box">
          ${controlHtml}
          <div style="border-top:1px solid var(--border);padding-top:8px;">
            <label class="text-xs" style="font-weight:600;display:block;margin-bottom:4px;">💬 ${state.activeMonth}月心得回饋：</label>
            <div style="display:flex;gap:6px;">
              <input type="text" value="${esc(refText)}" placeholder="記錄本月心得或成果..." data-action="reflection-input" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" />
              <button type="button" class="btn btn-outline" style="white-space:nowrap;padding:6px 10px;" data-action="voice-reflection" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}">🎙️</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderOverviewTab(lec) {
    const overall = computeLecturerStats(lec);
    const goalsList = (lec.goals || [])
      .map((g, idx) => {
        const st = computeGoalStats(g);
        return `
          <div class="card" style="cursor:pointer;" data-action="open-goal-monthly" data-idx="${idx}">
            <div class="row-between">
              <div>
                <span class="badge badge-sky">目標 ${idx + 1}</span>
                <div style="font-weight:700;font-size:15px;margin-top:4px;">${esc(g.title)}</div>
                <div class="text-xs" style="color:var(--muted);margin-top:2px;">包含 ${(g.krs || []).length} 個關鍵成果 ‧ 點擊切換頁籤填報 ➔</div>
              </div>
              <div style="text-align:right;">
                <div style="color:#d97706;font-weight:800;">${st.starText}</div>
                <div class="text-xs" style="font-weight:700;">${st.stars.toFixed(1)}星 (${st.rate}%)</div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    return `
      <div class="vision-banner">
        <div>
          <div class="row-wrap" style="margin-bottom:6px;">
            <span class="badge badge-sky">${esc(lec.unit)}</span>
            <span class="badge badge-slate">綁定碼：${esc(lec.bindCode || lec.id)}</span>
          </div>
          <h2 style="margin:0;font-size:20px;">${esc(lec.name)} 講師</h2>
          <div style="margin-top:6px;font-size:14px;">
            <span style="color:#fde68a;">核心精進愿景：</span>
            <strong>${esc(lec.coreVision)}</strong>
            <button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:11px;margin-left:4px;" data-action="edit-vision">✎</button>
          </div>
        </div>
        <div class="star-card" style="width:100%;text-align:left;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div class="text-xs" style="color:#fde68a;">年度總五星評比</div>
            <div class="stars-gold" style="font-size:20px;">${overall.starText} ${overall.stars.toFixed(1)}★</div>
          </div>
          <div style="text-align:right;">
            <span class="badge badge-amber">${overall.badge}</span>
            <div style="font-weight:800;margin-top:4px;">${overall.rate}%</div>
          </div>
        </div>
      </div>

      <div class="row-between">
        <strong style="font-size:15px;">我的愿力大目標 (${(lec.goals || []).length})</strong>
        <button type="button" class="btn btn-primary" data-action="go-tab" data-tab="new">＋ 新增目標 / 小目標</button>
      </div>

      ${goalsList ? `<div class="pwa-overview-grid">${goalsList}</div>` : `<div class="card text-xs" style="color:var(--muted);text-align:center;">尚未建立愿力目標，請點選「＋ 新增目標」開始填寫！</div>`}

      <div class="card row-between">
        <span class="text-xs" style="color:var(--muted);">需要切換或重新綁定講師身分？</span>
        <button type="button" class="btn btn-outline" data-action="switch-identity">切換 / 重設身分</button>
      </div>
    `;
  }

  function renderMonthlyTab(lec) {
    const goals = lec.goals || [];
    if (goals.length === 0) {
      return `
        <div class="card stack" style="text-align:center;">
          <p class="text-sm" style="margin:0;">您尚未建立任何愿力目標與關鍵成果。</p>
          <button type="button" class="btn btn-primary" style="justify-content:center;" data-action="go-tab" data-tab="new">＋ 立即新增第一個目標</button>
        </div>
      `;
    }

    const monthPills = Array.from({ length: 12 }, (_, idx) => {
      const m = idx + 1;
      const hasData = goals.some((g) => (g.krs || []).some((kr) => kr.monthlyValues && kr.monthlyValues[m] !== undefined));
      return `
        <button type="button" class="month-pill ${m === state.activeMonth ? 'active' : ''}" data-action="select-month" data-month="${m}">
          <span>${m}月</span>
          <span class="dot ${hasData ? 'filled' : ''}"></span>
        </button>
      `;
    }).join('');

    const curGoal = goals[state.activeGoalIndex] || goals[0];
    const gStat = computeGoalStats(curGoal);

    return `
      <div class="pwa-monthly-layout">
        <aside class="card pwa-month-sidebar" style="padding:14px;">
          <div class="row-between" style="margin-bottom:10px;">
            <strong class="text-xs">🗓️ 選擇填報月份</strong>
            <span class="badge badge-green">目前：${state.activeMonth} 月</span>
          </div>
          <div class="month-grid">${monthPills}</div>
          <div class="text-xs" style="color:var(--muted);margin-top:10px;">綠點表示該月已有填報紀錄；可隨時點選補填或調整。</div>
        </aside>

        <div class="stack">
          <div>
            <div class="text-xs" style="color:var(--muted);font-weight:700;margin-bottom:6px;">📑 切換愿力目標頁籤：</div>
            ${renderGoalTabsBar(lec)}
          </div>

          <div class="goal-header" style="border-radius:14px;">
            <div>
              <div class="text-xs" style="color:#fcd34d;">目標 ${state.activeGoalIndex + 1}</div>
              <div style="font-weight:700;font-size:16px;">${esc(curGoal.title)}</div>
            </div>
            <div style="text-align:right;">
              <div style="color:#fbbf24;font-weight:800;">${gStat.starText} ${gStat.stars.toFixed(1)}★</div>
              <div class="text-xs" style="color:#84B39D;">${gStat.badge} ‧ ${gStat.rate}%</div>
            </div>
          </div>

          <div class="pwa-kr-grid">
            ${(curGoal.krs || []).map((kr) => renderKrEditor(curGoal.id, kr)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function renderNewGoalTab(lec) {
    const goalOptions = (lec.goals || [])
      .map((g, i) => `<option value="${esc(g.id)}">掛載於目標 ${i + 1}：${esc(g.title)}</option>`)
      .join('');
    const hasGoals = (lec.goals || []).length > 0;

    return `
      <div class="card stack">
        <h2 style="margin:0;font-size:18px;color:var(--brand);">＋ 新增愿力目標 / 關鍵成果</h2>
        <form id="mobileAddForm" class="stack">
          <div>
            <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">選擇大目標 *</label>
            <select id="mGoalSelect">
              ${goalOptions}
              <option value="NEW" ${!hasGoals ? 'selected' : ''}>＋ 建立全新的「愿力大目標」</option>
            </select>
            <input id="mNewGoalInput" type="text" class="${hasGoals ? 'hidden' : ''}" ${!hasGoals ? 'required' : ''} style="margin-top:8px;" placeholder="輸入新的愿力大目標（例：對道義問題能夠思考）" />
          </div>

          <div>
            <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">關鍵成果（小目標）*</label>
            <input id="mKrTitle" type="text" required placeholder="例如：讀一貫道疑問解答" />
          </div>

          <div class="form-grid-2">
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">衡量型態 *</label>
              <select id="mKrType">
                <option value="PERCENT">1. 百分比進度型 (0~100%)</option>
                <option value="COUNT">2. 累積次數型 (上限 100%)</option>
                <option value="PERIODIC">3. 週期達成型 (3~12個月期限)</option>
                <option value="MILESTONE">4. 階段里程碑型</option>
                <option value="QUALITATIVE">5. 心得自評型 (1~5分)</option>
              </select>
            </div>
            <div>
              <label id="mTargetLabel" class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">目標數值與單位</label>
              <div style="display:flex;gap:6px;">
                <input id="mKrTarget" type="number" min="1" value="100" />
                <input id="mKrUnit" type="text" value="%" style="width:72px;text-align:center;" />
              </div>
            </div>
          </div>

          <div>
            <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">實際做法 *</label>
            <input id="mKrAction" type="text" required placeholder="例如：每週讀一篇＋寫看法、心得" />
          </div>

          <div>
            <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">原因與考量 *</label>
            <input id="mKrReason" type="text" required placeholder="例如：從已有的文本開始練習" />
          </div>

          <button type="submit" class="btn btn-line" style="justify-content:center;padding:12px;">確認新增並切換至該目標填報</button>
        </form>
      </div>
    `;
  }

  function renderPrintTab(lec) {
    const overall = computeLecturerStats(lec);
    const goalSummaries = (lec.goals || [])
      .map((g, i) => {
        const st = computeGoalStats(g);
        const krs = (g.krs || [])
          .map((kr) => `<li>${esc(kr.title)}（<strong>${computeKrProgress(kr, 12)}%</strong>）— ${esc(kr.action)}</li>`)
          .join('');
        return `
          <div style="border:1px solid var(--border-strong);border-radius:10px;padding:10px;">
            <div class="row-between">
              <strong>目標 ${i + 1}：${esc(g.title)}</strong>
              <span style="color:#d97706;font-weight:700;">${st.starText} ${st.stars.toFixed(1)}星 (${st.rate}%)</span>
            </div>
            <ul style="margin:6px 0 0 18px;padding:0;font-size:12px;color:var(--text-sub);">${krs}</ul>
          </div>
        `;
      })
      .join('');

    return `
      <div class="stack">
        <div class="card row-between no-print">
          <div>
            <strong>🖨️ 我的母堂呈表預覽</strong>
            <div class="text-xs" style="color:var(--muted);">可於法會現場直接列印或存成 PDF。</div>
          </div>
          <button type="button" class="btn btn-line" data-action="do-print">🖨️ 列印 / PDF</button>
        </div>

        <div class="print-sheet stack">
          <div style="text-align:center;border-bottom:2px solid var(--brand);padding-bottom:10px;">
            <h2 style="margin:0;color:var(--brand);font-size:19px;">講 師 精 進 愿 力 表</h2>
            <div class="text-xs" style="color:var(--text-sub);margin-top:4px;">
              單位：${esc(lec.unit)} ｜ 講師：${esc(lec.name)} ｜ 總評：${overall.starText} (${overall.stars.toFixed(1)}星 / ${overall.rate}%)
            </div>
          </div>
          <div style="font-size:13px;"><strong>核心精進愿景：</strong>${esc(lec.coreVision)}</div>
          ${goalSummaries}
          <div class="text-xs" style="border-top:1px solid var(--border);padding-top:10px;color:var(--muted);">
            專屬綁定碼：<strong>${esc(lec.bindCode || lec.id)}</strong> ｜ 親筆簽名：＿＿＿＿＿＿＿＿
          </div>
        </div>
      </div>
    `;
  }

  function render() {
    const root = document.getElementById('pwaApp');
    const lec = getMyLecturer();
    if (!lec) {
      root.innerHTML = renderOnboarding();
      bindEvents();
      return;
    }

    let bodyHtml = '';
    if (state.tab === 'overview') bodyHtml = renderOverviewTab(lec);
    else if (state.tab === 'monthly') bodyHtml = renderMonthlyTab(lec);
    else if (state.tab === 'new') bodyHtml = renderNewGoalTab(lec);
    else if (state.tab === 'print') bodyHtml = renderPrintTab(lec);

    root.innerHTML = `
      <div class="pwa-shell">
        <header class="pwa-topbar no-print">
          <div class="pwa-topbar-inner">
            <div class="row-wrap">
              <div class="brand-logo" style="width:32px;height:32px;font-size:15px;">愿</div>
              <div>
                <div style="font-weight:700;font-size:14px;">${esc(lec.name)} 講師愿力表</div>
                <div style="font-size:11px;color:#fde68a;">${esc(lec.unit)} ‧ ${state.cloudMode === 'firebase' ? '雲端已同步' : '本機儲存'}</div>
              </div>
            </div>

            <nav class="pwa-desktop-nav" aria-label="電腦版功能導覽">
              <button type="button" class="nav-tab ${state.tab === 'overview' ? 'active' : ''}" data-action="go-tab" data-tab="overview">🌟 總覽</button>
              <button type="button" class="nav-tab ${state.tab === 'monthly' ? 'active' : ''}" data-action="go-tab" data-tab="monthly">📅 月度回報</button>
              <button type="button" class="nav-tab ${state.tab === 'new' ? 'active' : ''}" data-action="go-tab" data-tab="new">➕ 新增目標</button>
              <button type="button" class="nav-tab ${state.tab === 'print' ? 'active' : ''}" data-action="go-tab" data-tab="print">🖨️ 呈表列印</button>
            </nav>

            <button type="button" class="btn btn-ghost ${state.elderMode ? 'active-elder' : ''}" style="padding:4px 10px;font-size:11px;" data-action="toggle-elder">🔍 ${state.elderMode ? '標準字' : '大字版'}</button>
          </div>
        </header>

        <main class="pwa-body">${bodyHtml}</main>

        <nav class="bottom-nav no-print" aria-label="手機功能導覽">
          <button type="button" class="bottom-nav-btn ${state.tab === 'overview' ? 'active' : ''}" data-action="go-tab" data-tab="overview">
            <span class="bottom-nav-icon">🌟</span><span>總覽</span>
          </button>
          <button type="button" class="bottom-nav-btn ${state.tab === 'monthly' ? 'active' : ''}" data-action="go-tab" data-tab="monthly">
            <span class="bottom-nav-icon">📅</span><span>回報</span>
          </button>
          <button type="button" class="bottom-nav-btn ${state.tab === 'new' ? 'active' : ''}" data-action="go-tab" data-tab="new">
            <span class="bottom-nav-icon">➕</span><span>新增</span>
          </button>
          <button type="button" class="bottom-nav-btn ${state.tab === 'print' ? 'active' : ''}" data-action="go-tab" data-tab="print">
            <span class="bottom-nav-icon">🖨️</span><span>呈表</span>
          </button>
        </nav>
      </div>
    `;
    bindEvents();
  }

  function mutateKr(goalId, krId, updater, toastMsg) {
    const lec = getMyLecturer();
    if (!lec) return;
    const goal = (lec.goals || []).find((g) => g.id === goalId);
    const kr = goal && (goal.krs || []).find((k) => k.id === krId);
    if (!kr) return;
    updater(kr);
    global.VowStore.saveLecturer(lec);
    render();
    if (toastMsg) showToast(toastMsg);
  }

  function bindEvents() {
    const root = document.getElementById('pwaApp');

    const claimForm = document.getElementById('claimCodeForm');
    if (claimForm) {
      claimForm.onsubmit = (e) => {
        e.preventDefault();
        const code = document.getElementById('claimCodeInput').value.trim().toUpperCase();
        const found = global.VowStore.getLecturers().find((l) => (l.bindCode || '').toUpperCase() === code || l.id.toUpperCase() === code);
        if (!found) {
          showToast('找不到此綁定碼，請確認後再試');
          return;
        }
        if (state.cloudUid) {
          found.lineUid = state.cloudUid;
          found.lineBound = true;
          global.VowStore.saveLecturer(found);
        }
        state.myId = found.id;
        localStorage.setItem(MY_ID_KEY, found.id);
        render();
        showToast(`已成功認領「${found.name}」講師愿力表！`);
      };
    }

    const createForm = document.getElementById('createSelfForm');
    if (createForm) {
      createForm.onsubmit = (e) => {
        e.preventDefault();
        const newId = 'L_' + Date.now();
        const newLec = {
          id: newId,
          name: document.getElementById('selfName').value.trim(),
          unit: document.getElementById('selfUnit').value,
          role: 'lecturer',
          inputMode: 'digital',
          lineBound: Boolean(state.cloudUid),
          lineUid: state.cloudUid || '',
          bindCode: 'VOW-' + String(Date.now()).slice(-4),
          coreVision: document.getElementById('selfVision').value.trim(),
          goals: []
        };
        global.VowStore.saveLecturer(newLec);
        state.myId = newId;
        state.tab = 'new';
        localStorage.setItem(MY_ID_KEY, newId);
        render();
        showToast('個人愿力表建立成功！請新增您的第一個目標');
      };
    }

    const mGoalSel = document.getElementById('mGoalSelect');
    const mNewGoalInp = document.getElementById('mNewGoalInput');
    const mKrType = document.getElementById('mKrType');
    if (mGoalSel && mNewGoalInp) {
      mGoalSel.onchange = (e) => {
        const isNew = e.target.value === 'NEW';
        mNewGoalInp.classList.toggle('hidden', !isNew);
        mNewGoalInp.required = isNew;
      };
    }
    if (mKrType) {
      mKrType.onchange = (e) => {
        const t = e.target.value;
        const targetInp = document.getElementById('mKrTarget');
        const unitInp = document.getElementById('mKrUnit');
        const label = document.getElementById('mTargetLabel');
        if (t === 'PERIODIC') {
          label.textContent = '完成期限 (3~12月) 與單位';
          targetInp.min = 3;
          targetInp.max = 12;
          targetInp.value = 6;
          unitInp.value = '月';
        } else {
          label.textContent = '目標數值與單位';
          targetInp.min = 1;
          targetInp.removeAttribute('max');
          if (t === 'PERCENT') { targetInp.value = 100; unitInp.value = '%'; }
          else if (t === 'COUNT') { targetInp.value = 12; unitInp.value = '次'; }
          else if (t === 'MILESTONE') { targetInp.value = 4; unitInp.value = '階段'; }
          else if (t === 'QUALITATIVE') { targetInp.value = 5; unitInp.value = '分'; }
        }
      };
    }

    const mobileAddForm = document.getElementById('mobileAddForm');
    if (mobileAddForm) {
      mobileAddForm.onsubmit = (e) => {
        e.preventDefault();
        const lec = getMyLecturer();
        if (!lec) return;
        const choice = document.getElementById('mGoalSelect').value;
        const type = document.getElementById('mKrType').value;
        const rawTarget = Number(document.getElementById('mKrTarget').value || 100);
        const newKr = {
          id: 'KR_' + Date.now(),
          title: document.getElementById('mKrTitle').value.trim(),
          action: document.getElementById('mKrAction').value.trim(),
          reason: document.getElementById('mKrReason').value.trim(),
          type,
          durationMonths: type === 'PERIODIC' ? Math.min(12, Math.max(3, rawTarget)) : undefined,
          targetValue: type === 'PERIODIC' ? Math.min(12, Math.max(3, rawTarget)) : rawTarget,
          unitLabel: document.getElementById('mKrUnit').value.trim() || '%',
          monthlyValues: { [state.activeMonth]: type === 'PERCENT' ? 0 : (type === 'PERIODIC' ? 100 : 0) },
          reflections: {}
        };
        if (choice === 'NEW') {
          const gTitle = document.getElementById('mNewGoalInput').value.trim() || '新精進目標';
          lec.goals.push({ id: 'G_' + Date.now(), title: gTitle, krs: [newKr] });
          state.activeGoalIndex = lec.goals.length - 1;
        } else {
          const idx = lec.goals.findIndex((g) => g.id === choice);
          if (idx >= 0) {
            lec.goals[idx].krs.push(newKr);
            state.activeGoalIndex = idx;
          }
        }
        global.VowStore.saveLecturer(lec);
        state.tab = 'monthly';
        render();
        showToast(`已新增「${newKr.title}」`);
      };
    }

    root.querySelectorAll('input[data-action="range-kr"]').forEach((inp) => {
      inp.onchange = (e) => {
        const val = Number(e.target.value);
        mutateKr(inp.dataset.goal, inp.dataset.kr, (kr) => {
          if (!kr.monthlyValues) kr.monthlyValues = {};
          kr.monthlyValues[state.activeMonth] = val;
        }, `已更新 ${state.activeMonth}月進度 ${val}%`);
      };
    });

    root.querySelectorAll('select[data-action="set-periodic-duration"]').forEach((s) => {
      s.onchange = (e) => {
        const dur = Math.min(12, Math.max(3, Number(e.target.value)));
        mutateKr(s.dataset.goal, s.dataset.kr, (kr) => {
          kr.durationMonths = dur;
          kr.targetValue = dur;
        }, `期限已設為 ${dur} 個月`);
      };
    });

    root.querySelectorAll('input[data-action="reflection-input"]').forEach((inp) => {
      inp.onchange = (e) => {
        const txt = e.target.value;
        mutateKr(inp.dataset.goal, inp.dataset.kr, (kr) => {
          if (!kr.reflections) kr.reflections = {};
          kr.reflections[state.activeMonth] = txt;
        }, `已儲存 ${state.activeMonth}月心得`);
      };
    });

    root.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'line-login') {
        if (!global.VowStore.startLineLogin()) showToast('尚未設定 LINE Channel ID');
      } else if (action === 'go-tab') {
        state.tab = btn.dataset.tab;
        render();
      } else if (action === 'select-goal-tab') {
        state.activeGoalIndex = Number(btn.dataset.idx);
        render();
      } else if (action === 'open-goal-monthly') {
        state.activeGoalIndex = Number(btn.dataset.idx);
        state.tab = 'monthly';
        render();
      } else if (action === 'select-month') {
        state.activeMonth = Number(btn.dataset.month);
        render();
      } else if (action === 'set-kr-val') {
        const val = Number(btn.dataset.val);
        mutateKr(btn.dataset.goal, btn.dataset.kr, (kr) => {
          if (!kr.monthlyValues) kr.monthlyValues = {};
          kr.monthlyValues[state.activeMonth] = val;
        }, `已更新 ${state.activeMonth}月進度`);
      } else if (action === 'voice-reflection') {
        const SpeechRec = global.SpeechRecognition || global.webkitSpeechRecognition;
        if (SpeechRec) {
          const rec = new SpeechRec();
          rec.lang = 'zh-TW';
          rec.onresult = (ev) => {
            const spoken = ev.results[0][0].transcript;
            mutateKr(btn.dataset.goal, btn.dataset.kr, (kr) => {
              if (!kr.reflections) kr.reflections = {};
              kr.reflections[state.activeMonth] = spoken;
            }, '語音已轉文字並儲存');
          };
          rec.start();
          showToast('請說話（語音辨識中…）');
        } else {
          showToast('此瀏覽器不支援即時麥克風語音辨識');
        }
      } else if (action === 'edit-vision') {
        const lec = getMyLecturer();
        const next = global.prompt('修改年度核心精進愿景：', lec.coreVision);
        if (next && next.trim()) {
          lec.coreVision = next.trim();
          global.VowStore.saveLecturer(lec);
          render();
          showToast('已更新核心精進愿景');
        }
      } else if (action === 'toggle-elder') {
        state.elderMode = !state.elderMode;
        document.body.classList.toggle('elder-mode', state.elderMode);
        render();
      } else if (action === 'switch-identity') {
        localStorage.removeItem(MY_ID_KEY);
        state.myId = '';
        render();
      } else if (action === 'do-print') {
        global.print();
      }
    };
  }

  async function boot() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    const status = await global.VowStore.initCloudIfConfigured(() => {
      render();
    });
    state.cloudMode = status.mode;
    state.cloudUid = status.uid;
    render();
  }

  global.addEventListener('DOMContentLoaded', boot);
})(window);
