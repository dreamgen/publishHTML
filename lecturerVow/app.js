/* 講師愿力表系統 — 主程式與 UI 渲染 */
(function (global) {
  'use strict';

  const { METRIC_META, computeKrProgress, computeGoalStats, computeLecturerStats } = global.VowEngine;

  const state = {
    view: 'pwa',
    activeLecturerId: 'L01',
    activeMonth: new Date().getMonth() + 1 <= 12 ? 3 : 3, // 預設 3 月以利展示第1季歷程
    printBlankMode: false,
    elderMode: false,
    cloudMode: 'local',
    adminRoleFilter: 'ALL',
    adminModeFilter: 'ALL',
    adminStarFilter: 'ALL',
    lineExtraMessages: []
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
    toastTimer = setTimeout(() => box.classList.add('hidden'), 2800);
  }

  function getLecturers() {
    return global.VowStore.getLecturers();
  }

  function getActiveLecturer() {
    const list = getLecturers();
    return list.find((l) => l.id === state.activeLecturerId) || list[0];
  }

  function renderTopbar(lec) {
    const list = getLecturers();
    const options = list
      .map((l) => {
        const st = computeLecturerStats(l);
        const icon = l.inputMode === 'digital' ? '📱電子' : '📝紙本';
        return `<option value="${esc(l.id)}" ${l.id === lec.id ? 'selected' : ''}>${esc(l.name)} (${esc(l.unit)}｜${icon}｜★${st.stars.toFixed(1)})</option>`;
      })
      .join('');

    const cfg = global.VOW_CONFIG || {};
    const hasLineLogin = Boolean(cfg.lineChannelId && cfg.lineWorkerUrl);

    return `
      <header class="topbar no-print">
        <div class="topbar-inner">
          <div class="brand-wrap">
            <div class="brand-logo">愿</div>
            <div>
              <h1 class="brand-title">講師愿力表系統 <span class="badge badge-green" style="font-size:10px;padding:1px 6px;">${state.cloudMode === 'firebase' ? '雲端同步' : '本機試用'}</span></h1>
              <p class="brand-sub">法會紙電雙軌立愿 ‧ 1～12月多元回報 ‧ 五星評比 ‧ 各單位分權總覽</p>
            </div>
          </div>

          <nav class="nav-tabs" aria-label="功能視角切換">
            <button class="nav-tab ${state.view === 'pwa' ? 'active' : ''}" data-action="switch-view" data-view="pwa">📱 講師手機端 (PWA)</button>
            <button class="nav-tab ${state.view === 'paper' ? 'active' : ''}" data-action="switch-view" data-view="paper">📝 法會紙本代登</button>
            <button class="nav-tab ${state.view === 'print' ? 'active' : ''}" data-action="switch-view" data-view="print">🖨️ 母堂呈表列印</button>
            <button class="nav-tab ${state.view === 'admin' ? 'active' : ''}" data-action="switch-view" data-view="admin">📊 管理端與各單位總覽</button>
          </nav>

          <div class="topbar-tools">
            <a href="./pwa.html" class="btn btn-line" style="text-decoration:none;">📲 講師實作版</a>
            <label class="select-pill">
              <span>檢視講師：</span>
              <select id="globalLecturerSelect">${options}</select>
            </label>
            <button class="btn btn-ghost ${state.elderMode ? 'active-elder' : ''}" data-action="toggle-elder">🔍 ${state.elderMode ? '標準字' : '大字版'}</button>
          </div>
        </div>
      </header>
    `;
  }

  function renderClassicTableHTML(lec, isBlankTemplate) {
    const monthsHeader = Array.from({ length: 12 }, (_, i) => `<th>${i + 1}月</th>`).join('');
    let rowsHtml = '';

    if (isBlankTemplate) {
      for (let g = 1; g <= 3; g++) {
        for (let k = 1; k <= 2; k++) {
          rowsHtml += `
            <tr style="height:48px;">
              ${k === 1 ? `<td rowspan="2" style="text-align:center;font-weight:700;background:#F5EFE6;">${g}</td>` : ''}
              ${k === 1 ? `<td rowspan="2"></td>` : ''}
              ${k === 1 ? `<td rowspan="2" style="text-align:center;color:#94a3b8;">☆☆☆☆☆<br/>( % )</td>` : ''}
              <td></td>
              <td style="text-align:center;color:#94a3b8;">%</td>
              <td></td>
              <td></td>
              ${Array.from({ length: 12 }, () => `<td></td>`).join('')}
            </tr>
          `;
        }
      }
    } else {
      (lec.goals || []).forEach((goal, gIdx) => {
        const gStat = computeGoalStats(goal);
        const krs = goal.krs || [];
        krs.forEach((kr, kIdx) => {
          const krProg = computeKrProgress(kr, 12);
          const monthCells = Array.from({ length: 12 }, (_, mIdx) => {
            const m = mIdx + 1;
            const raw = kr.monthlyValues ? kr.monthlyValues[m] : undefined;
            let display = '';
            if (raw !== undefined && raw !== '') {
              if (kr.type === 'PERCENT') display = `${raw}%`;
              else if (kr.type === 'COUNT') display = `${raw}${kr.unitLabel || ''}`;
              else if (kr.type === 'PERIODIC') display = Number(raw) >= 100 ? '✓' : (Number(raw) >= 50 ? '△' : '✗');
              else if (kr.type === 'MILESTONE') display = `S${raw}`;
              else if (kr.type === 'QUALITATIVE') display = `${raw}分`;
            }
            const bg = m === state.activeMonth ? 'background:#fef3c7;font-weight:700;' : '';
            return `<td style="text-align:center;${bg}">${esc(display)}</td>`;
          }).join('');

          const typeLabel = (METRIC_META[kr.type] || METRIC_META.PERCENT).label;
          const periodHint = kr.type === 'PERIODIC' ? `（期限 ${kr.durationMonths || kr.targetValue || 12} 個月）` : '';

          rowsHtml += `
            <tr>
              ${kIdx === 0 ? `<td rowspan="${krs.length}" style="text-align:center;font-weight:700;background:#F2EAE0;">${gIdx + 1}</td>` : ''}
              ${kIdx === 0 ? `<td rowspan="${krs.length}" style="font-weight:700;background:#F5EFE6;min-width:130px;">${esc(goal.title)}</td>` : ''}
              ${kIdx === 0 ? `
                <td rowspan="${krs.length}" style="text-align:center;background:#F5EFE6;min-width:105px;">
                  <div style="color:#d97706;font-weight:700;">${gStat.starText}</div>
                  <div style="font-weight:800;">${gStat.stars.toFixed(1)}星 (${gStat.rate}%)</div>
                  <div style="font-size:11px;color:#66564D;">${gStat.badge}</div>
                </td>
              ` : ''}
              <td style="min-width:140px;">
                <div style="font-weight:700;">${esc(kr.title)}</div>
                <div style="font-size:11px;color:#7D6C62;">[${typeLabel}${periodHint}]</div>
              </td>
              <td style="text-align:center;font-weight:800;">${krProg}%</td>
              <td style="min-width:140px;">${esc(kr.action)}</td>
              <td style="min-width:140px;">${esc(kr.reason)}</td>
              ${monthCells}
            </tr>
          `;
        });
      });
    }

    return `
      <div class="table-wrap">
        <div class="classic-banner">
          <span>核心精進愿景：${isBlankTemplate ? '＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿' : esc(lec.coreVision)}</span>
          <span style="font-size:12px;font-weight:400;color:#fde68a;">
            ${isBlankTemplate ? '單位：＿＿＿＿＿＿　講師姓名：＿＿＿＿＿＿' : `單位：${esc(lec.unit)} ｜ 講師：${esc(lec.name)}`}
          </span>
        </div>
        <table class="classic">
          <thead>
            <tr>
              <th rowspan="2">項</th>
              <th rowspan="2">目　標</th>
              <th rowspan="2">五星評比<br/><span style="font-weight:400;font-size:10px;">(總進度)</span></th>
              <th rowspan="2">關鍵成果 (小目標)</th>
              <th rowspan="2">進度</th>
              <th rowspan="2">實際做法</th>
              <th rowspan="2">原因與考量</th>
              <th colspan="12">每月完成進度與回報紀錄（1月 ～ 12月）</th>
            </tr>
            <tr>${monthsHeader}</tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function renderKrControlHTML(goalId, kr) {
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
          <strong>📅 ${state.activeMonth}月份進度百分比：</strong>
          <strong style="color:var(--brand);font-size:15px;">${val}%</strong>
        </div>
        <input type="range" min="0" max="100" step="5" value="${val}"
          data-action="range-kr" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" />
        <div class="row-wrap">
          ${[0, 25, 50, 75, 100].map((p) => `
            <button type="button" class="btn ${val === p ? 'btn-primary' : 'btn-outline'}"
              data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${p}">${p}%</button>
          `).join('')}
        </div>
      `;
    } else if (kr.type === 'COUNT') {
      const val = Number(monthVal || 0);
      const totalSum = Object.values(mv).reduce((a, b) => a + Number(b || 0), 0);
      controlHtml = `
        <div class="row-between">
          <div class="text-xs">
            <strong>📅 ${state.activeMonth}月份新增數（年度目標：${kr.targetValue} ${esc(kr.unitLabel)}）</strong><br/>
            <span style="color:var(--muted);">全年累計：<strong>${totalSum} / ${kr.targetValue} ${esc(kr.unitLabel)}</strong>（達成率上限鎖定 100%）</span>
          </div>
          <div class="row-wrap">
            <button type="button" class="btn btn-outline" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${Math.max(0, val - 1)}">－</button>
            <span class="badge badge-slate" style="font-size:14px;padding:6px 12px;">${val} ${esc(kr.unitLabel)}</span>
            <button type="button" class="btn btn-primary" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${val + 1}">＋</button>
          </div>
        </div>
      `;
    } else if (kr.type === 'PERIODIC') {
      const val = monthVal !== '' ? Number(monthVal) : -1;
      const dur = Math.min(12, Math.max(3, Number(kr.durationMonths || kr.targetValue || 12)));
      controlHtml = `
        <div class="row-between text-xs">
          <strong>📅 ${state.activeMonth}月份週期打卡（設定完成期限：${dur} 個月）：</strong>
          <select data-action="set-periodic-duration" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" style="width:auto;padding:4px 8px;font-size:12px;">
            ${[3, 4, 5, 6, 9, 12].map((d) => `<option value="${d}" ${dur === d ? 'selected' : ''}>期限：${d} 個月</option>`).join('')}
          </select>
        </div>
        <div class="row-wrap">
          <button type="button" class="btn ${val === 100 ? 'btn-line' : 'btn-outline'}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="100">✅ 本月已達成 (100%)</button>
          <button type="button" class="btn ${val === 50 ? 'btn-amber' : 'btn-outline'}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="50">⏳ 進行中 (50%)</button>
          <button type="button" class="btn ${val === 0 ? 'btn-primary' : 'btn-outline'}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="0">❌ 未執行 (0%)</button>
        </div>
      `;
    } else if (kr.type === 'MILESTONE') {
      const steps = kr.milestones || ['階段 1：資料準備', '階段 2：初稿撰寫', '階段 3：演練修正', '階段 4：正式圓滿'];
      const doneCount = monthVal !== '' ? Number(monthVal) : Math.round((progress / 100) * steps.length);
      controlHtml = `
        <div class="text-xs"><strong>📅 截至 ${state.activeMonth}月份已完成之階段里程碑：</strong></div>
        <div class="milestone-grid">
          ${steps.map((sName, idx) => {
            const stepNum = idx + 1;
            const checked = stepNum <= doneCount;
            const nextVal = checked && doneCount === stepNum ? stepNum - 1 : stepNum;
            return `
              <button type="button" class="milestone-btn ${checked ? 'done' : ''}"
                data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${nextVal}">
                <span>${checked ? '☑' : '☐'}</span>
                <span>${esc(sName)}</span>
              </button>
            `;
          }).join('')}
        </div>
      `;
    } else if (kr.type === 'QUALITATIVE') {
      const score = monthVal !== '' ? Number(monthVal) : Math.round((progress / 100) * 5);
      controlHtml = `
        <div class="text-xs"><strong>📅 ${state.activeMonth}月份修辦自評（1～5 分自動換算）：</strong></div>
        <div class="row-wrap">
          ${[1, 2, 3, 4, 5].map((sc) => `
            <button type="button" class="btn ${score === sc ? 'btn-primary' : 'btn-outline'}"
              data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${sc}">★ ${sc} 分 (${sc * 20}%)</button>
          `).join('')}
        </div>
      `;
    }

    return `
      <div class="kr-item">
        <div class="row-between">
          <div>
            <div class="row-wrap">
              <span class="badge ${meta.badgeClass}">${meta.icon} ${meta.label}</span>
              <strong>${esc(kr.title)}</strong>
            </div>
            <div class="text-xs" style="color:var(--muted);margin-top:4px;">
              <strong>實際做法：</strong>${esc(kr.action)}　｜　<strong>原因與考量：</strong>${esc(kr.reason)}
            </div>
          </div>
          <div style="text-align:right;">
            <span class="text-xs" style="color:var(--muted);display:block;">單項達成率</span>
            <strong style="font-size:18px;color:var(--brand);">${progress}%</strong>
          </div>
        </div>

        <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>

        <div class="control-box">
          ${controlHtml}
          <div style="border-top:1px solid #E6DCD0;padding-top:8px;">
            <label class="text-xs" style="font-weight:600;display:block;margin-bottom:4px;">💬 ${state.activeMonth}月份修辦心得回饋 / 成果紀錄：</label>
            <div style="display:flex;gap:8px;">
              <input type="text" value="${esc(refText)}" placeholder="輸入本月心得或成果說明..."
                data-action="reflection-input" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" />
              <button type="button" class="btn btn-outline" style="white-space:nowrap;"
                data-action="voice-reflection" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}">🎙️ 語音輸入</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderPwaView(lec) {
    const overall = computeLecturerStats(lec);
    const monthPills = Array.from({ length: 12 }, (_, idx) => {
      const m = idx + 1;
      const hasData = (lec.goals || []).some((g) => (g.krs || []).some((kr) => kr.monthlyValues && kr.monthlyValues[m] !== undefined));
      return `
        <button type="button" class="month-pill ${m === state.activeMonth ? 'active' : ''}" data-action="select-month" data-month="${m}">
          <span>${m}月</span>
          <span class="dot ${hasData ? 'filled' : ''}"></span>
        </button>
      `;
    }).join('');

    const goalCards = (lec.goals || [])
      .map((goal, idx) => {
        const gStat = computeGoalStats(goal);
        return `
          <div class="goal-card">
            <div class="goal-header">
              <div class="row-wrap">
                <div class="goal-index">${idx + 1}</div>
                <div>
                  <div class="text-xs" style="color:#fcd34d;">愿力大目標 (Objective ${idx + 1})</div>
                  <div style="font-weight:700;font-size:16px;">${esc(goal.title)}</div>
                </div>
              </div>
              <div class="star-card" style="padding:8px 12px;min-width:170px;">
                <div style="color:#fbbf24;font-weight:800;">${gStat.starText} <span style="color:#fff;">${gStat.stars.toFixed(1)}星</span></div>
                <div class="text-xs" style="color:#84B39D;">${gStat.badge} ‧ ${gStat.rate}%</div>
              </div>
            </div>
            <div class="kr-list">
              ${(goal.krs || []).map((kr) => renderKrControlHTML(goal.id, kr)).join('')}
            </div>
          </div>
        `;
      })
      .join('');

    const extraBubbles = state.lineExtraMessages
      .map(
        (m) => `
        <div class="line-bubble-row">
          <div class="line-avatar">愿</div>
          <div class="line-bubble"><strong>${esc(m.title)}</strong><div style="margin-top:3px;">${esc(m.body)}</div></div>
        </div>
      `
      )
      .join('');

    return `
      <div class="pwa-grid">
        <!-- Left: LINE Official Account Panel + Friend QR Code -->
        <div class="stack">
          <aside class="line-panel">
            <div class="line-header">
              <div class="row-wrap">
                <div class="line-avatar" style="width:32px;height:32px;font-size:13px;">愿</div>
                <div>
                  <div style="font-weight:700;font-size:14px;">講師愿力表官方帳號</div>
                  <div style="font-size:11px;color:#94a3b8;">LINE Login × Messaging API (僅單人 Push)</div>
                </div>
              </div>
              <span class="badge ${lec.lineBound ? 'badge-green' : 'badge-slate'}">${lec.lineBound ? '已綁定' : '紙本待認領'}</span>
            </div>

            <div class="line-chat" id="lineChatArea">
              <div class="line-bubble-row">
                <div class="line-avatar">愿</div>
                <div class="line-bubble">
                  <strong>${esc(lec.name)} 講師吉祥 🙏</strong>
                  <div>核心精進愿景：<span style="color:#3D6352;font-weight:700;">「${esc(lec.coreVision)}」</span></div>
                </div>
              </div>
              <div class="line-bubble-row">
                <div class="line-avatar">愿</div>
                <div class="line-bubble">
                  <div>目前年度總五星評比：<strong>★ ${overall.stars.toFixed(1)} 星 (${overall.rate}%)</strong></div>
                  <div style="color:#7D6C62;margin-top:2px;">點選下方圖文選單可快速跳轉回報；本系統不主動群發推播，僅支援單人 Push 小卡。</div>
                </div>
              </div>
              ${extraBubbles}
            </div>

            <div style="padding:8px 12px;background:#F2EAE0;border-top:1px solid #E6DCD0;" class="row-between">
              <span class="text-xs" style="font-weight:600;">單人 Push 互動：</span>
              <div class="row-wrap">
                <button type="button" class="btn btn-outline" style="padding:4px 8px;font-size:11px;" data-action="push-summary">⭐ Push 我的星級小卡</button>
              </div>
            </div>

            <div class="line-rich-menu">
              <button type="button" class="rich-btn primary" data-action="rich-overview">
                <span>🌟</span><strong>我的愿力表</strong>
              </button>
              <button type="button" class="rich-btn green" data-action="rich-monthly">
                <span>📅</span><strong>本月進度回報</strong>
              </button>
              <button type="button" class="rich-btn" data-action="open-add-modal">
                <span>➕</span><strong>新增目標/小目標</strong>
              </button>
              <button type="button" class="rich-btn" data-action="switch-view" data-view="print">
                <span>🖨️</span><strong>母堂呈表列印</strong>
              </button>
            </div>
          </aside>

          <div class="card" style="text-align:center;">
            <span class="badge badge-green">DEMO 體驗專用</span>
            <h3 style="margin:8px 0 4px;font-size:15px;color:var(--brand);">📱 加入 LINE 官方帳號試用</h3>
            <p class="text-xs" style="color:var(--muted);margin:0 0 10px;">基礎忠恕講師愿力表服務（ID：<code>@533ennet</code>）</p>
            <img src="./assets/line-oa-qr.png" alt="加入基礎忠恕講師愿力表服務 LINE 官方帳號 QR Code" style="width:170px;height:170px;border:1px solid var(--border-strong);border-radius:12px;padding:4px;background:#fff;" />
            <div style="margin-top:10px;">
              <a href="https://line.me/R/ti/p/@533ennet" target="_blank" rel="noopener noreferrer" class="btn btn-line" style="text-decoration:none;justify-content:center;">🟢 直接開啟 LINE 加好友</a>
            </div>
          </div>
        </div>

        <!-- Right: Lecturer PWA Workspace -->
        <div class="stack">
          <div class="vision-banner">
            <div>
              <div class="row-wrap" style="margin-bottom:6px;">
                <span class="badge badge-sky">所屬單位：${esc(lec.unit)}</span>
                <span class="badge ${lec.inputMode === 'digital' ? 'badge-green' : 'badge-amber'}">
                  ${lec.inputMode === 'digital' ? '📱 法會電子版立愿' : '📝 法會紙本版立愿'}
                </span>
                <span class="badge badge-slate">綁定碼：${esc(lec.bindCode || lec.id)}</span>
              </div>
              <h2 style="margin:0;font-size:22px;">${esc(lec.name)} <span style="font-size:14px;font-weight:400;color:#fde68a;">講師</span></h2>
              <div style="margin-top:6px;font-size:15px;">
                <span style="color:#fde68a;">核心精進愿景：</span>
                <strong style="color:#fcd34d;">${esc(lec.coreVision)}</strong>
                <button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:11px;margin-left:6px;" data-action="edit-vision">✎ 修改</button>
              </div>
            </div>
            <div class="star-card">
              <div class="text-xs" style="color:#fde68a;">年度愿力總評比</div>
              <div class="stars-gold">${overall.starText} ${overall.stars.toFixed(1)} 星</div>
              <div class="row-wrap" style="justify-content:flex-end;margin-top:4px;">
                <span class="badge badge-amber">${overall.badge}</span>
                <strong>總達成率 ${overall.rate}%</strong>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="row-between" style="margin-bottom:10px;">
              <div>
                <strong>🗓️ 選擇填報或檢視月份（1～12 月自由更新）</strong>
                <div class="text-xs" style="color:var(--muted);">綠點表示該月已有填報紀錄；可隨時切換月份補填或修改。</div>
              </div>
              <div class="row-wrap">
                <span class="badge badge-green">目前選擇：${state.activeMonth} 月</span>
                <button type="button" class="btn btn-primary" data-action="open-add-modal">＋ 新增目標 / 小目標</button>
              </div>
            </div>
            <div class="month-grid" id="monthGrid">${monthPills}</div>
          </div>

          <div id="goalsWrap" class="stack">${goalCards}</div>

          <div class="card">
            <h3 style="margin:0 0 10px;font-size:15px;">📋 完整橫式愿力表即時預覽（對照原表格＋五星評比＋1～12月）</h3>
            ${renderClassicTableHTML(lec, false)}
          </div>
        </div>
      </div>
    `;
  }

  function renderPaperView() {
    return `
      <div class="card stack">
        <div class="row-between" style="border-bottom:1px solid var(--border);padding-bottom:12px;">
          <div>
            <span class="badge badge-amber">法會 50% 年長紙本組解決方案（總管理員 / 單位負責人皆可代登）</span>
            <h2 style="margin:6px 0 2px;font-size:19px;">📝 法會現場「紙本愿力表」快速代登與綁定工作台</h2>
            <p class="text-xs" style="margin:0;color:var(--muted);">收齊紙本呈表後，在此快速建檔並產生專屬綁定碼（供後續講師本人 LINE 認領或由單位負責人代為更新）。</p>
          </div>
          <button type="button" class="btn btn-amber" data-action="fill-paper-sample">✨ 一鍵帶入手寫紙本範例</button>
        </div>

        <form id="paperEntryForm" class="stack">
          <div class="form-grid-3">
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">講師姓名 *</label>
              <input id="paperName" type="text" required placeholder="例如：林進德 講師" />
            </div>
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">所屬單位 / 佛堂 *</label>
              <select id="paperUnit">
                <option value="台北一區">台北一區</option>
                <option value="台北二區">台北二區</option>
                <option value="教學組">教學組</option>
                <option value="成全組">成全組</option>
              </select>
            </div>
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">核心精進愿景 *</label>
              <input id="paperVision" type="text" required placeholder="例如：深耕經典、廣結善緣渡化有緣" />
            </div>
          </div>

          <div>
            <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">愿力大目標 (Objective) *</label>
            <input id="paperGoalTitle" type="text" required placeholder="例如：熟讀經典並落實日常成全" />
          </div>

          <div class="form-grid-2">
            <div class="control-box">
              <span class="badge badge-sky" style="align-self:flex-start;">關鍵成果 1（必填）</span>
              <input id="paperKr1Title" type="text" required placeholder="小目標名稱" />
              <div class="form-grid-2">
                <select id="paperKr1Type">
                  <option value="PERIODIC">週期達成型 (可設 3~12 月期限)</option>
                  <option value="COUNT">累積次數型 (上限 100%)</option>
                  <option value="PERCENT">百分比進度型 (0~100%)</option>
                  <option value="MILESTONE">階段里程碑型</option>
                  <option value="QUALITATIVE">心得自評型 (1~5分)</option>
                </select>
                <input id="paperKr1Init" type="number" min="0" max="100" value="50" placeholder="初始進度" />
              </div>
              <input id="paperKr1Action" type="text" placeholder="實際做法" />
              <input id="paperKr1Reason" type="text" placeholder="原因與考量" />
            </div>

            <div class="control-box">
              <span class="badge badge-slate" style="align-self:flex-start;">關鍵成果 2（選填）</span>
              <input id="paperKr2Title" type="text" placeholder="小目標名稱（選填）" />
              <div class="form-grid-2">
                <select id="paperKr2Type">
                  <option value="COUNT">累積次數型</option>
                  <option value="PERCENT">百分比進度型</option>
                  <option value="PERIODIC">週期達成型</option>
                </select>
                <input id="paperKr2Init" type="number" min="0" max="100" value="30" placeholder="初始進度" />
              </div>
              <input id="paperKr2Action" type="text" placeholder="實際做法" />
              <input id="paperKr2Reason" type="text" placeholder="原因與考量" />
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;">
            <button type="submit" class="btn btn-line">💾 儲存紙本建檔並切換檢視</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderPrintView(lec) {
    const overall = computeLecturerStats(lec);
    return `
      <div class="stack">
        <div class="card row-between no-print">
          <div>
            <strong>🖨️ 法會母堂呈表專用排版（A4 橫式列印格式）</strong>
            <div class="text-xs" style="color:var(--muted);">可切換為「目前講師資料版」或「空白手寫紙本模板（供法會現場發放）」。</div>
          </div>
          <div class="row-wrap">
            <button type="button" class="btn ${!state.printBlankMode ? 'btn-primary' : 'btn-outline'}" data-action="set-print-mode" data-blank="false">📄 目前講師資料版</button>
            <button type="button" class="btn ${state.printBlankMode ? 'btn-primary' : 'btn-outline'}" data-action="set-print-mode" data-blank="true">📝 空白手寫紙本模板</button>
            <button type="button" class="btn btn-line" data-action="do-print">🖨️ 立即列印 / 存為 PDF</button>
          </div>
        </div>

        <div class="print-sheet">
          <div style="text-align:center;border-bottom:2px solid var(--brand);padding-bottom:12px;margin-bottom:14px;">
            <div style="font-size:12px;color:var(--muted);letter-spacing:2px;">2026 年度法會呈表專用</div>
            <h1 style="margin:4px 0;font-size:22px;color:var(--brand);">講 師 精 進 愿 力 表（紙電雙軌呈表版）</h1>
            <div class="row-wrap" style="justify-content:center;font-size:13px;gap:20px;">
              <span><strong>所屬單位：</strong>${state.printBlankMode ? '＿＿＿＿＿＿＿＿' : esc(lec.unit)}</span>
              <span><strong>立愿講師：</strong>${state.printBlankMode ? '＿＿＿＿＿＿＿＿' : esc(lec.name)}</span>
              <span><strong>填報形式：</strong>${state.printBlankMode ? '□ 電子版列印　□ 現場手寫紙本' : (lec.inputMode === 'digital' ? '☑ 電子版列印呈表' : '☑ 紙本立愿建檔')}</span>
              <span><strong>總評比：</strong>${state.printBlankMode ? '☆☆☆☆☆' : `${overall.starText} (${overall.stars.toFixed(1)}星 / ${overall.rate}%)`}</span>
            </div>
          </div>

          ${renderClassicTableHTML(lec, state.printBlankMode)}

          <div class="print-footer-grid">
            <div style="border:1px solid var(--border);border-radius:10px;padding:10px;">
              <strong>📱 專屬綁定碼：${state.printBlankMode ? 'VOW-______' : esc(lec.bindCode || lec.id)}</strong>
              <div style="color:var(--muted);margin-top:4px;">法會呈表後，平時每月可透過講師愿力表 LINE 官方帳號自由更新進度與心得。</div>
            </div>
            <div style="border:1px solid var(--border);border-radius:10px;padding:10px;">
              <strong>點傳師 / 單位負責人慈悲勉勵：</strong>
            </div>
            <div style="border:1px solid var(--border);border-radius:10px;padding:10px;display:flex;flex-direction:column;justify-content:space-between;">
              <strong>立愿講師親筆簽名（呈上母堂）：</strong>
              <div style="text-align:right;color:var(--muted);">簽名：＿＿＿＿＿＿　2026 年 ＿ 月 ＿ 日</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function getFilteredLecturers() {
    return getLecturers().filter((l) => {
      if (state.adminRoleFilter !== 'ALL' && l.unit !== state.adminRoleFilter) return false;
      if (state.adminModeFilter !== 'ALL' && l.inputMode !== state.adminModeFilter) return false;
      const st = computeLecturerStats(l);
      if (state.adminStarFilter === 'HIGH' && st.stars < 3.5) return false;
      if (state.adminStarFilter === 'MID' && (st.stars < 2.0 || st.stars >= 3.5)) return false;
      if (state.adminStarFilter === 'LOW' && st.stars >= 2.0) return false;
      return true;
    });
  }

  function renderAdminView() {
    const list = getFilteredLecturers();
    const total = list.length;
    const digitalCount = list.filter((l) => l.inputMode === 'digital').length;
    const paperCount = list.filter((l) => l.inputMode === 'paper').length;
    const avgStars = total ? (list.reduce((a, l) => a + computeLecturerStats(l).stars, 0) / total).toFixed(1) : '0.0';
    const avgRate = total ? Math.round(list.reduce((a, l) => a + computeLecturerStats(l).rate, 0) / total) : 0;
    const boundCount = list.filter((l) => l.lineBound).length;

    const itemsHtml = list.length === 0
      ? `<div class="card" style="text-align:center;color:var(--muted);">沒有符合篩選條件的講師資料。</div>`
      : list
          .map((lec) => {
            const st = computeLecturerStats(lec);
            return `
              <div class="card stack" style="padding:0;overflow:hidden;">
                <div style="background:#F2EAE0;padding:12px 16px;border-bottom:1px solid var(--border);" class="row-between">
                  <div class="row-wrap">
                    <span class="badge badge-sky">${esc(lec.unit)}</span>
                    <strong style="font-size:16px;">${esc(lec.name)} 講師</strong>
                    <span class="badge ${lec.inputMode === 'digital' ? 'badge-green' : 'badge-amber'}">${lec.inputMode === 'digital' ? '📱 電子自填' : '📝 紙本代登'}</span>
                    <span style="color:#d97706;font-weight:800;">${st.starText} ${st.stars.toFixed(1)}星 (${st.rate}%｜${st.badge})</span>
                  </div>
                  <div class="row-wrap">
                    <button type="button" class="btn btn-outline" data-action="admin-push-user" data-id="${esc(lec.id)}">💬 單人 Push 提醒</button>
                    <button type="button" class="btn btn-line" data-action="jump-pwa" data-id="${esc(lec.id)}">📱 檢視/代為更新</button>
                  </div>
                </div>
                <div style="padding:12px;">
                  ${renderClassicTableHTML(lec, false)}
                </div>
              </div>
            `;
          })
          .join('');

    return `
      <div class="stack">
        <div class="card row-between">
          <div class="row-wrap" style="gap:14px;">
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:3px;">管理端分權角色 (RBAC)：</label>
              <select id="adminRoleFilter">
                <option value="ALL" ${state.adminRoleFilter === 'ALL' ? 'selected' : ''}>👑 總管理員（全道場單位）</option>
                <option value="台北一區" ${state.adminRoleFilter === '台北一區' ? 'selected' : ''}>📍 單位負責人：台北一區</option>
                <option value="台北二區" ${state.adminRoleFilter === '台北二區' ? 'selected' : ''}>📍 單位負責人：台北二區</option>
                <option value="教學組" ${state.adminRoleFilter === '教學組' ? 'selected' : ''}>📍 單位負責人：教學組</option>
                <option value="成全組" ${state.adminRoleFilter === '成全組' ? 'selected' : ''}>📍 單位負責人：成全組</option>
              </select>
            </div>
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:3px;">立愿方式：</label>
              <select id="adminModeFilter">
                <option value="ALL" ${state.adminModeFilter === 'ALL' ? 'selected' : ''}>全部（電子＋紙本）</option>
                <option value="digital" ${state.adminModeFilter === 'digital' ? 'selected' : ''}>📱 電子版自填</option>
                <option value="paper" ${state.adminModeFilter === 'paper' ? 'selected' : ''}>📝 紙本版代登</option>
              </select>
            </div>
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:3px;">五星評比：</label>
              <select id="adminStarFilter">
                <option value="ALL" ${state.adminStarFilter === 'ALL' ? 'selected' : ''}>全部星級</option>
                <option value="HIGH" ${state.adminStarFilter === 'HIGH' ? 'selected' : ''}>★ 3.5 星以上</option>
                <option value="MID" ${state.adminStarFilter === 'MID' ? 'selected' : ''}>★ 2.0 ～ 3.4 星</option>
                <option value="LOW" ${state.adminStarFilter === 'LOW' ? 'selected' : ''}>★ 2.0 星以下</option>
              </select>
            </div>
          </div>
          <button type="button" class="btn btn-primary" data-action="export-csv">📥 匯出所選單位報表 (CSV/Excel)</button>
        </div>

        <div class="kpi-grid">
          <div class="card">
            <div class="text-xs" style="color:var(--muted);">篩選單位立愿人數</div>
            <div class="kpi-num">${total} <span style="font-size:13px;font-weight:400;">位講師</span></div>
            <div class="text-xs" style="color:#3D6352;">100% 完成母堂呈表建檔</div>
          </div>
          <div class="card">
            <div class="text-xs" style="color:var(--muted);">紙電雙軌比例</div>
            <div class="kpi-num" style="font-size:18px;margin:10px 0;">📱 ${digitalCount} 人 ／ 📝 ${paperCount} 人</div>
            <div class="text-xs" style="color:var(--muted);">電子自填 vs 年長紙本代登</div>
          </div>
          <div class="card">
            <div class="text-xs" style="color:var(--muted);">單位平均五星評比</div>
            <div class="kpi-num" style="color:#d97706;">★ ${avgStars} <span style="font-size:13px;font-weight:400;">/ 5.0</span></div>
            <div class="text-xs" style="color:var(--muted);">平均達成率：${avgRate}%</div>
          </div>
          <div class="card">
            <div class="text-xs" style="color:var(--muted);">LINE 綁定人數</div>
            <div class="kpi-num" style="color:var(--line-green);">${boundCount} / ${total}</div>
            <div class="text-xs" style="color:var(--muted);">支援點對點單人 Push</div>
          </div>
        </div>

        <div class="stack">${itemsHtml}</div>
      </div>
    `;
  }

  function renderAddModal(lec) {
    const goalOptions = (lec.goals || [])
      .map((g, i) => `<option value="${esc(g.id)}">掛載於目標 ${i + 1}：${esc(g.title)}</option>`)
      .join('');

    return `
      <div id="addModal" class="modal-backdrop hidden">
        <div class="modal-panel stack">
          <div class="row-between" style="border-bottom:1px solid var(--border);padding-bottom:10px;">
            <strong style="font-size:16px;">＋ 新增關鍵成果（小目標）與衡量型態</strong>
            <button type="button" class="btn btn-outline" data-action="close-add-modal">✕</button>
          </div>
          <form id="addKrForm" class="stack">
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">選擇掛載的大目標 *</label>
              <select id="modalGoalSelect">
                ${goalOptions}
                <option value="NEW">＋ 新增一項全新的「愿力大目標」</option>
              </select>
              <input id="modalNewGoalInput" type="text" class="hidden" style="margin-top:8px;" placeholder="輸入新的愿力大目標名稱" />
            </div>

            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">關鍵成果（小目標名稱）*</label>
              <input id="modalKrTitle" type="text" required placeholder="例如：每月參與研究班會後討論" />
            </div>

            <div class="form-grid-2">
              <div>
                <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">衡量型態（5 選 1）*</label>
                <select id="modalKrType">
                  <option value="PERCENT">1. 百分比進度型 (0~100%)</option>
                  <option value="COUNT">2. 累積次數型 (上限 100%)</option>
                  <option value="PERIODIC">3. 週期達成型 (可設 3~12 個月)</option>
                  <option value="MILESTONE">4. 階段里程碑型</option>
                  <option value="QUALITATIVE">5. 心得自評型 (1~5分)</option>
                </select>
              </div>
              <div id="modalTargetWrap">
                <label id="modalTargetLabel" class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">年度目標數值與單位</label>
                <div style="display:flex;gap:6px;">
                  <input id="modalKrTarget" type="number" min="1" value="100" />
                  <input id="modalKrUnit" type="text" value="%" style="width:72px;text-align:center;" />
                </div>
              </div>
            </div>

            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">實際做法 *</label>
              <input id="modalKrAction" type="text" required placeholder="例如：每週讀一篇＋寫看法、心得" />
            </div>

            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">原因與考量 *</label>
              <input id="modalKrReason" type="text" required placeholder="例如：溫故知新，充實講道內涵" />
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:8px;border-top:1px solid var(--border);">
              <button type="button" class="btn btn-outline" data-action="close-add-modal">取消</button>
              <button type="submit" class="btn btn-primary">確認新增</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function render() {
    const app = document.getElementById('app');
    const lec = getActiveLecturer();
    let mainHtml = '';
    if (state.view === 'pwa') mainHtml = renderPwaView(lec);
    else if (state.view === 'paper') mainHtml = renderPaperView();
    else if (state.view === 'print') mainHtml = renderPrintView(lec);
    else if (state.view === 'admin') mainHtml = renderAdminView();

    app.innerHTML = `
      ${renderTopbar(lec)}
      <main class="container">${mainHtml}</main>
      ${renderAddModal(lec)}
    `;
    bindEvents();
  }

  function mutateKr(goalId, krId, updater, toastMsg) {
    const lec = getActiveLecturer();
    const goal = (lec.goals || []).find((g) => g.id === goalId);
    const kr = goal && (goal.krs || []).find((k) => k.id === krId);
    if (!kr) return;
    updater(kr);
    global.VowStore.saveLecturer(lec);
    render();
    if (toastMsg) showToast(toastMsg);
  }

  function exportFilteredCSV() {
    const list = getFilteredLecturers();
    let csv = '\uFEFF單位,講師姓名,立愿方式,核心精進愿景,目標名稱,目標五星評比,目標達成率(%),關鍵成果名稱,衡量型態,單項達成率(%),實際做法,原因與考量,最新修辦心得\n';
    list.forEach((lec) => {
      (lec.goals || []).forEach((g) => {
        const gStat = computeGoalStats(g);
        (g.krs || []).forEach((kr) => {
          const prog = computeKrProgress(kr, 12);
          const refs = kr.reflections || {};
          const latestRef = refs[12] || refs[6] || refs[3] || refs[2] || refs[1] || '';
          const row = [
            lec.unit,
            lec.name,
            lec.inputMode === 'digital' ? '電子版' : '紙本版',
            lec.coreVision,
            g.title,
            `${gStat.stars.toFixed(1)}星`,
            `${gStat.rate}%`,
            kr.title,
            (METRIC_META[kr.type] || METRIC_META.PERCENT).label,
            `${prog}%`,
            kr.action,
            kr.reason,
            latestRef
          ].map((c) => `"${String(c || '').replace(/"/g, '""')}"`).join(',');
          csv += row + '\n';
        });
      });
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `講師愿力表_分權匯出_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('已匯出所選單位 CSV 報表');
  }

  function bindEvents() {
    const root = document.getElementById('app');
    const sel = document.getElementById('globalLecturerSelect');
    if (sel) {
      sel.onchange = (e) => {
        state.activeLecturerId = e.target.value;
        state.lineExtraMessages = [];
        render();
        showToast(`已切換檢視：${getActiveLecturer().name} 講師`);
      };
    }

    ['adminRoleFilter', 'adminModeFilter', 'adminStarFilter'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.onchange = (e) => {
          state[id] = e.target.value;
          render();
        };
      }
    });

    // Range sliders & reflection inputs
    root.querySelectorAll('input[data-action="range-kr"]').forEach((inp) => {
      inp.onchange = (e) => {
        const val = Number(e.target.value);
        mutateKr(inp.dataset.goal, inp.dataset.kr, (kr) => {
          if (!kr.monthlyValues) kr.monthlyValues = {};
          kr.monthlyValues[state.activeMonth] = val;
        }, `已更新 ${state.activeMonth}月進度為 ${val}%`);
      };
    });

    root.querySelectorAll('select[data-action="set-periodic-duration"]').forEach((s) => {
      s.onchange = (e) => {
        const dur = Math.min(12, Math.max(3, Number(e.target.value)));
        mutateKr(s.dataset.goal, s.dataset.kr, (kr) => {
          kr.durationMonths = dur;
          kr.targetValue = dur;
        }, `已將週期達成期限調整為 ${dur} 個月`);
      };
    });

    root.querySelectorAll('input[data-action="reflection-input"]').forEach((inp) => {
      inp.onchange = (e) => {
        const txt = e.target.value;
        mutateKr(inp.dataset.goal, inp.dataset.kr, (kr) => {
          if (!kr.reflections) kr.reflections = {};
          kr.reflections[state.activeMonth] = txt;
        }, `已儲存 ${state.activeMonth}月份心得回饋`);
      };
    });

    // Paper entry form
    const paperForm = document.getElementById('paperEntryForm');
    if (paperForm) {
      paperForm.onsubmit = (e) => {
        e.preventDefault();
        const name = document.getElementById('paperName').value.trim();
        const unit = document.getElementById('paperUnit').value;
        const vision = document.getElementById('paperVision').value.trim();
        const goalTitle = document.getElementById('paperGoalTitle').value.trim();
        const kr1Title = document.getElementById('paperKr1Title').value.trim();
        const kr1Type = document.getElementById('paperKr1Type').value;
        const kr1Init = Number(document.getElementById('paperKr1Init').value || 50);

        const krs = [{
          id: 'KR_' + Date.now() + '_1',
          title: kr1Title,
          action: document.getElementById('paperKr1Action').value.trim() || '依計畫每月執行',
          reason: document.getElementById('paperKr1Reason').value.trim() || '自我道學精進',
          type: kr1Type,
          durationMonths: kr1Type === 'PERIODIC' ? 6 : undefined,
          targetValue: kr1Type === 'COUNT' ? 12 : (kr1Type === 'PERIODIC' ? 6 : 100),
          unitLabel: kr1Type === 'COUNT' ? '次' : '%',
          monthlyValues: { [state.activeMonth]: kr1Init },
          reflections: { [state.activeMonth]: '法會紙本立愿已由單位協助數位建檔。' }
        }];

        const kr2Title = document.getElementById('paperKr2Title').value.trim();
        if (kr2Title) {
          const kr2Type = document.getElementById('paperKr2Type').value;
          const kr2Init = Number(document.getElementById('paperKr2Init').value || 30);
          krs.push({
            id: 'KR_' + Date.now() + '_2',
            title: kr2Title,
            action: document.getElementById('paperKr2Action').value.trim() || '每月定期執行',
            reason: document.getElementById('paperKr2Reason').value.trim() || '同修共辦成全',
            type: kr2Type,
            durationMonths: kr2Type === 'PERIODIC' ? 6 : undefined,
            targetValue: kr2Type === 'COUNT' ? 12 : 100,
            unitLabel: kr2Type === 'COUNT' ? '次' : '%',
            monthlyValues: { [state.activeMonth]: kr2Init },
            reflections: {}
          });
        }

        const newId = 'L_' + Date.now();
        const newLec = {
          id: newId,
          name,
          unit,
          role: 'lecturer',
          inputMode: 'paper',
          lineBound: false,
          lineUid: '',
          bindCode: 'VOW-' + String(Date.now()).slice(-4),
          coreVision: vision,
          goals: [{ id: 'G_' + Date.now(), title: goalTitle, krs }]
        };
        global.VowStore.saveLecturer(newLec);
        state.activeLecturerId = newId;
        state.view = 'pwa';
        render();
        showToast(`已成功為「${name}」完成紙本代登！綁定碼：${newLec.bindCode}`);
      };
    }

    // Add KR Modal form
    const modalGoalSel = document.getElementById('modalGoalSelect');
    const modalNewGoalInp = document.getElementById('modalNewGoalInput');
    const modalKrType = document.getElementById('modalKrType');
    if (modalGoalSel && modalNewGoalInp) {
      modalGoalSel.onchange = (e) => {
        const isNew = e.target.value === 'NEW';
        modalNewGoalInp.classList.toggle('hidden', !isNew);
        modalNewGoalInp.required = isNew;
      };
    }
    if (modalKrType) {
      modalKrType.onchange = (e) => {
        const t = e.target.value;
        const targetInp = document.getElementById('modalKrTarget');
        const unitInp = document.getElementById('modalKrUnit');
        const label = document.getElementById('modalTargetLabel');
        if (t === 'PERIODIC') {
          label.textContent = '完成期限（3～12 個月）與單位';
          targetInp.min = 3;
          targetInp.max = 12;
          targetInp.value = 6;
          unitInp.value = '月';
        } else {
          label.textContent = '年度目標數值與單位';
          targetInp.min = 1;
          targetInp.removeAttribute('max');
          if (t === 'PERCENT') { targetInp.value = 100; unitInp.value = '%'; }
          else if (t === 'COUNT') { targetInp.value = 12; unitInp.value = '次'; }
          else if (t === 'MILESTONE') { targetInp.value = 4; unitInp.value = '階段'; }
          else if (t === 'QUALITATIVE') { targetInp.value = 5; unitInp.value = '分'; }
        }
      };
    }

    const addKrForm = document.getElementById('addKrForm');
    if (addKrForm) {
      addKrForm.onsubmit = (e) => {
        e.preventDefault();
        const lec = getActiveLecturer();
        const goalChoice = document.getElementById('modalGoalSelect').value;
        const type = document.getElementById('modalKrType').value;
        const rawTarget = Number(document.getElementById('modalKrTarget').value || 100);
        const newKr = {
          id: 'KR_' + Date.now(),
          title: document.getElementById('modalKrTitle').value.trim(),
          action: document.getElementById('modalKrAction').value.trim(),
          reason: document.getElementById('modalKrReason').value.trim(),
          type,
          durationMonths: type === 'PERIODIC' ? Math.min(12, Math.max(3, rawTarget)) : undefined,
          targetValue: type === 'PERIODIC' ? Math.min(12, Math.max(3, rawTarget)) : rawTarget,
          unitLabel: document.getElementById('modalKrUnit').value.trim() || '%',
          monthlyValues: { [state.activeMonth]: type === 'PERCENT' ? 20 : (type === 'PERIODIC' ? 100 : 1) },
          reflections: {}
        };
        if (goalChoice === 'NEW') {
          const gTitle = document.getElementById('modalNewGoalInput').value.trim() || '新精進目標';
          lec.goals.push({ id: 'G_' + Date.now(), title: gTitle, krs: [newKr] });
        } else {
          const targetGoal = lec.goals.find((g) => g.id === goalChoice);
          if (targetGoal) targetGoal.krs.push(newKr);
        }
        global.VowStore.saveLecturer(lec);
        render();
        showToast(`已新增小目標「${newKr.title}」並自動納入五星評比`);
      };
    }

    // Delegated click handler
    root.onclick = async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'switch-view') {
        state.view = btn.dataset.view;
        render();
      } else if (action === 'toggle-elder') {
        state.elderMode = !state.elderMode;
        document.body.classList.toggle('elder-mode', state.elderMode);
        render();
        showToast(state.elderMode ? '已切換為長輩友善大字體' : '已切換為標準字體');
      } else if (action === 'line-login') {
        if (!global.VowStore.startLineLogin()) showToast('尚未設定 LINE Channel ID');
      } else if (action === 'select-month') {
        state.activeMonth = Number(btn.dataset.month);
        render();
      } else if (action === 'set-kr-val') {
        const val = Number(btn.dataset.val);
        mutateKr(btn.dataset.goal, btn.dataset.kr, (kr) => {
          if (!kr.monthlyValues) kr.monthlyValues = {};
          kr.monthlyValues[state.activeMonth] = val;
        }, `已更新 ${state.activeMonth}月進度！`);
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
            }, '已將語音轉為文字並儲存心得');
          };
          rec.start();
          showToast('請開始說話（繁體中文語音辨識中…）');
        } else {
          const samples = [
            '本月研讀經典後，在講台傳題時更能結合道親生活實例，班員回饋很有共鳴。',
            '透過每週固定複習與筆記整理，對道義脈絡更加清晰，感恩前賢慈悲指導。'
          ];
          const pick = samples[Math.floor(Math.random() * samples.length)];
          mutateKr(btn.dataset.goal, btn.dataset.kr, (kr) => {
            if (!kr.reflections) kr.reflections = {};
            kr.reflections[state.activeMonth] = pick;
          }, '已帶入語音心得範例（此瀏覽器不支援即時麥克風辨識）');
        }
      } else if (action === 'edit-vision') {
        const lec = getActiveLecturer();
        const next = global.prompt('請輸入年度核心精進愿景：', lec.coreVision);
        if (next && next.trim()) {
          lec.coreVision = next.trim();
          global.VowStore.saveLecturer(lec);
          render();
          showToast('已更新核心精進愿景');
        }
      } else if (action === 'push-summary') {
        const lec = getActiveLecturer();
        const st = computeLecturerStats(lec);
        const msg = `🙏 ${lec.name} 講師吉祥！您的年度愿力總評比為 ★ ${st.stars.toFixed(1)} 星（總達成率 ${st.rate}%｜${st.badge}）。`;
        const res = await global.VowStore.sendSinglePush(lec.lineUid, msg);
        state.lineExtraMessages.push({
          title: res.ok ? '✅ 已透過 LINE Messaging API 單人 Push 發送' : '⭐ 單人 Push 小卡預覽（本機模擬）',
          body: msg
        });
        render();
      } else if (action === 'rich-overview') {
        global.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (action === 'rich-monthly') {
        const el = document.getElementById('monthGrid');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (action === 'open-add-modal') {
        document.getElementById('addModal').classList.remove('hidden');
      } else if (action === 'close-add-modal') {
        document.getElementById('addModal').classList.add('hidden');
      } else if (action === 'fill-paper-sample') {
        document.getElementById('paperName').value = '周德福 (年長紙本組)';
        document.getElementById('paperUnit').value = '成全組';
        document.getElementById('paperVision').value = '以身作則，廣結善緣渡化親朋好友';
        document.getElementById('paperGoalTitle').value = '熟悉經典義理並積極參與成全訪視';
        document.getElementById('paperKr1Title').value = '每日早香誦讀經典並記錄體悟';
        document.getElementById('paperKr1Type').value = 'PERIODIC';
        document.getElementById('paperKr1Init').value = 100;
        document.getElementById('paperKr1Action').value = '每日早晚獻香後誦經15分鐘';
        document.getElementById('paperKr1Reason').value = '定心修持，增長智慧';
        document.getElementById('paperKr2Title').value = '全年偕同同修成全訪視 12 次';
        document.getElementById('paperKr2Type').value = 'COUNT';
        document.getElementById('paperKr2Init').value = 4;
        document.getElementById('paperKr2Action').value = '每月安排1次道親家訪關懷';
        document.getElementById('paperKr2Reason').value = '帶動道親回佛堂參班研究';
        showToast('已帶入手寫紙本範例資料');
      } else if (action === 'set-print-mode') {
        state.printBlankMode = btn.dataset.blank === 'true';
        render();
      } else if (action === 'do-print') {
        global.print();
      } else if (action === 'jump-pwa') {
        state.activeLecturerId = btn.dataset.id;
        state.view = 'pwa';
        render();
        showToast(`已切換至 ${getActiveLecturer().name} 講師視角`);
      } else if (action === 'admin-push-user') {
        const lec = getLecturers().find((l) => l.id === btn.dataset.id);
        if (!lec) return;
        const st = computeLecturerStats(lec);
        const msg = `🙏 ${lec.name} 講師吉祥，邀請您於本月底前更新「講師愿力表」${state.activeMonth}月份進度（目前 ★${st.stars.toFixed(1)} 星）。`;
        const res = await global.VowStore.sendSinglePush(lec.lineUid, msg);
        showToast(res.ok ? `已單人 Push 提醒給 ${lec.name}` : `已模擬單人 Push 提醒給 ${lec.name}（尚未設定 Worker URL）`);
      } else if (action === 'export-csv') {
        exportFilteredCSV();
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
    render();
  }

  global.addEventListener('DOMContentLoaded', boot);
})(window);
