/* 講師愿力表系統 — DEMO 與管理端主程式（禪意留白追蹤風） */
(function (global) {
  'use strict';

  const { METRIC_META, computeKrProgress, computeGoalStats, computeLecturerStats } = global.VowEngine;

  const state = {
    view: 'pwa',
    activeLecturerId: 'L01',
    activeMonth: 3,
    activeGoalIndex: 0,
    openReflectionIds: {},
    adminExpandedMap: { L01: true },
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

    return `
      <header class="topbar no-print">
        <div class="topbar-inner">
          <div class="brand-wrap">
            <div class="brand-logo">愿</div>
            <div>
              <h1 class="brand-title">講師愿力表 <span class="badge badge-green" style="font-size:10px;padding:1px 7px;">${state.cloudMode === 'firebase' ? '雲端同步' : '禪意留白版'}</span></h1>
              <p class="brand-sub">紙電雙軌立愿 ‧ 月度自由回報 ‧ 五星評比</p>
            </div>
          </div>

          <nav class="nav-tabs desktop-only" aria-label="功能視角切換">
            <button class="nav-tab ${state.view === 'pwa' ? 'active' : ''}" data-action="switch-view" data-view="pwa">📱 講師手機端 (PWA)</button>
            <button class="nav-tab ${state.view === 'paper' ? 'active' : ''}" data-action="switch-view" data-view="paper">📝 法會紙本代登</button>
            <button class="nav-tab ${state.view === 'print' ? 'active' : ''}" data-action="switch-view" data-view="print">🖨️ 母堂呈表列印</button>
            <button class="nav-tab ${state.view === 'admin' ? 'active' : ''}" data-action="switch-view" data-view="admin">📊 管理端與各單位總覽</button>
          </nav>

          <div class="topbar-tools">
            <a href="./pwa.html" class="btn btn-primary" style="text-decoration:none;padding:6px 12px;font-size:12px;">📲 講師實作版</a>
            <label class="select-pill">
              <span>講師：</span>
              <select id="globalLecturerSelect">${options}</select>
            </label>
            <button class="btn btn-ghost ${state.elderMode ? 'active-elder' : ''}" style="padding:6px 11px;font-size:12px;" data-action="toggle-elder">🔍 ${state.elderMode ? '標準字' : '大字版'}</button>
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
              ${k === 1 ? `<td rowspan="2" style="text-align:center;font-weight:700;background:#FAF9F6;">${g}</td>` : ''}
              ${k === 1 ? `<td rowspan="2"></td>` : ''}
              ${k === 1 ? `<td rowspan="2" style="text-align:center;color:#8A867E;">☆☆☆☆☆<br/>( % )</td>` : ''}
              <td></td>
              <td style="text-align:center;color:#8A867E;">%</td>
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
            const bg = m === state.activeMonth ? 'background:#FBF5E6;font-weight:700;color:#5F6F58;' : 'background:#FAF9F6;';
            return `<td style="text-align:center;${bg}">${esc(display)}</td>`;
          }).join('');

          const typeLabel = (METRIC_META[kr.type] || METRIC_META.PERCENT).label;
          const periodHint = kr.type === 'PERIODIC' ? `（期限 ${kr.durationMonths || kr.targetValue || 12} 個月）` : '';

          rowsHtml += `
            <tr>
              ${kIdx === 0 ? `<td rowspan="${krs.length}" style="text-align:center;font-weight:700;background:#F0EDE6;">${gIdx + 1}</td>` : ''}
              ${kIdx === 0 ? `<td rowspan="${krs.length}" style="font-weight:700;background:#FAF9F6;min-width:130px;">${esc(goal.title)}</td>` : ''}
              ${kIdx === 0 ? `
                <td rowspan="${krs.length}" style="text-align:center;background:#FAF9F6;min-width:105px;">
                  <div style="color:#C9A24D;font-weight:700;">${gStat.starText}</div>
                  <div style="font-weight:800;">${gStat.stars.toFixed(1)}星 (${gStat.rate}%)</div>
                  <div style="font-size:11px;color:#7A7770;">${gStat.badge}</div>
                </td>
              ` : ''}
              <td style="min-width:140px;">
                <div style="font-weight:600;">${esc(kr.title)}</div>
                <div style="font-size:11px;color:#7A7770;">[${typeLabel}${periodHint}]</div>
              </td>
              <td style="text-align:center;font-weight:800;color:#5F6F58;">${krProg}%</td>
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
          <span style="font-size:12px;font-weight:400;color:#EAE6DD;">
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
    const progress = computeKrProgress(kr, 12);
    const mv = kr.monthlyValues || {};
    const monthVal = mv[state.activeMonth] !== undefined ? mv[state.activeMonth] : '';
    const refText = (kr.reflections && kr.reflections[state.activeMonth]) || '';
    const isRefOpen = Boolean(state.openReflectionIds[kr.id]);

    let controlHtml = '';
    if (kr.type === 'PERCENT') {
      const val = monthVal !== '' ? Number(monthVal) : progress;
      controlHtml = `
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div class="row-between text-xs" style="color:var(--muted);">
            <span>${state.activeMonth}月進度調整</span>
            <strong style="color:var(--text);">${val}%</strong>
          </div>
          <input type="range" min="0" max="100" step="5" value="${val}"
            data-action="range-kr" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" />
        </div>
      `;
    } else if (kr.type === 'COUNT') {
      const val = Number(monthVal || 0);
      const totalSum = Object.values(mv).reduce((a, b) => a + Number(b || 0), 0);
      controlHtml = `
        <div class="row-between">
          <span class="text-xs" style="color:var(--muted);">${state.activeMonth}月新增 <span style="color:var(--moss-dark);">(累計 ${totalSum}/${kr.targetValue} ${esc(kr.unitLabel)})</span></span>
          <div class="row-wrap" style="gap:6px;">
            <button type="button" class="btn btn-outline" style="width:30px;height:30px;padding:0;justify-content:center;" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${Math.max(0, val - 1)}">－</button>
            <strong style="min-width:44px;text-align:center;font-size:13px;">${val} ${esc(kr.unitLabel)}</strong>
            <button type="button" class="btn btn-primary" style="width:30px;height:30px;padding:0;justify-content:center;" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${val + 1}">＋</button>
          </div>
        </div>
      `;
    } else if (kr.type === 'PERIODIC') {
      const val = monthVal !== '' ? Number(monthVal) : -1;
      controlHtml = `
        <div class="periodic-pill-group">
          <button type="button" class="periodic-pill-btn ${val === 100 ? 'active-done' : ''}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="100">✓ 已達成</button>
          <button type="button" class="periodic-pill-btn ${val === 50 ? 'active-prog' : ''}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="50">⋯ 進行中</button>
          <button type="button" class="periodic-pill-btn ${val === 0 ? 'active-miss' : ''}" data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="0">✕ 未執行</button>
        </div>
      `;
    } else if (kr.type === 'MILESTONE') {
      const steps = kr.milestones || ['階段 1：資料準備', '階段 2：初稿撰寫', '階段 3：演練修正', '階段 4：正式圓滿'];
      const doneCount = monthVal !== '' ? Number(monthVal) : Math.round((progress / 100) * steps.length);
      controlHtml = `
        <div class="milestone-grid">
          ${steps.map((sName, idx) => {
            const stepNum = idx + 1;
            const checked = stepNum <= doneCount;
            const nextVal = checked && doneCount === stepNum ? stepNum - 1 : stepNum;
            return `
              <button type="button" class="milestone-btn ${checked ? 'done' : ''}"
                data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${nextVal}">
                <span>${checked ? '✓' : '○'}</span>
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(sName)}</span>
              </button>
            `;
          }).join('')}
        </div>
      `;
    } else if (kr.type === 'QUALITATIVE') {
      const score = monthVal !== '' ? Number(monthVal) : Math.round((progress / 100) * 5);
      controlHtml = `
        <div class="row-between">
          <span class="text-xs" style="color:var(--muted);">${state.activeMonth}月自評</span>
          <div class="row-wrap" style="gap:4px;">
            ${[1, 2, 3, 4, 5].map((sc) => `
              <button type="button" class="btn ${score === sc ? 'btn-dark' : 'btn-outline'}" style="width:30px;height:30px;padding:0;justify-content:center;font-size:12px;"
                data-action="set-kr-val" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" data-val="${sc}">${sc}</button>
            `).join('')}
          </div>
        </div>
      `;
    }

    return `
      <div class="kr-zen-row">
        <div class="row-between" style="gap:8px;">
          <span style="font-weight:600;font-size:14px;color:var(--text);">${esc(kr.title)}</span>
          <strong style="font-size:15px;color:var(--moss);flex-shrink:0;">${progress}%</strong>
        </div>

        ${controlHtml}

        <div class="kr-footer-links">
          <details>
            <summary>做法與考量</summary>
            <div class="kr-note-drawer">
              <div><strong>做法：</strong>${esc(kr.action)}</div>
              <div><strong>考量：</strong>${esc(kr.reason)}</div>
            </div>
          </details>
          <div class="row-wrap" style="gap:10px;">
            <button type="button" class="kr-footer-link-btn" style="${refText ? 'color:#5F6F58;font-weight:600;' : ''}" data-action="toggle-reflection" data-kr="${esc(kr.id)}">
              💬 ${refText ? '已寫心得' : '寫心得'}
            </button>
            <button type="button" class="kr-footer-link-btn" style="color:#b91c1c;" data-action="delete-kr" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}">刪除</button>
          </div>
        </div>

        ${isRefOpen ? `
          <div style="display:flex;gap:6px;padding-top:2px;">
            <input type="text" value="${esc(refText)}" placeholder="輸入 ${state.activeMonth}月份修辦心得..."
              data-action="reflection-input" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}" />
            <button type="button" class="btn btn-outline" style="padding:6px 10px;flex-shrink:0;" data-action="voice-reflection" data-goal="${esc(goalId)}" data-kr="${esc(kr.id)}">🎙️</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  function renderPwaView(lec) {
    const overall = computeLecturerStats(lec);
    const goals = lec.goals || [];
    if (state.activeGoalIndex >= goals.length) state.activeGoalIndex = 0;

    const circumference = 263.89;
    const dashOffset = circumference - (overall.rate / 100) * circumference;

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

    let goalFocusHtml = '';
    let goalTabsHtml = '';
    if (goals.length === 0) {
      goalFocusHtml = `<div class="zen-card" style="text-align:center;color:var(--muted);">尚未設定愿力目標，請點選「＋ 新增目標」。</div>`;
    } else {
      goalTabsHtml = goals
        .map((g, idx) => {
          const numLabel = String(idx + 1).padStart(2, '0');
          return `
            <button type="button" class="goal-seg-btn ${idx === state.activeGoalIndex ? 'active' : ''}" data-action="select-goal-tab" data-idx="${idx}">
              <span>${numLabel}</span>
              <span style="font-weight:400;max-width:115px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(g.title)}</span>
            </button>
          `;
        })
        .join('');

      const focusedGoal = goals[state.activeGoalIndex];
      const gStat = computeGoalStats(focusedGoal);
      goalFocusHtml = `
        <div class="goal-focus-card">
          <div class="goal-focus-header">
            <div>
              <div style="font-size:11px;color:var(--muted);">目標 ${state.activeGoalIndex + 1} / ${goals.length}</div>
              <div style="font-weight:700;font-size:16px;color:var(--text);">${esc(focusedGoal.title)}</div>
            </div>
            <div class="row-wrap" style="gap:8px;">
              <div style="background:var(--bg);padding:5px 12px;border-radius:999px;font-size:12px;">
                <span style="color:var(--gold);font-weight:700;">${gStat.starText} ${gStat.stars.toFixed(1)}</span>
                <span style="color:var(--muted);margin:0 4px;">·</span>
                <strong style="color:var(--moss-dark);">${gStat.rate}%</strong>
              </div>
              <button type="button" class="kr-footer-link-btn" style="color:#b91c1c;" data-action="delete-goal" data-id="${esc(focusedGoal.id)}">刪除目標</button>
            </div>
          </div>
          <div class="kr-zen-list">
            ${(focusedGoal.krs || []).map((kr) => renderKrControlHTML(focusedGoal.id, kr)).join('')}
          </div>
        </div>
      `;
    }

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
                  <div style="font-size:11px;color:#A8A29E;">LINE Login × Messaging API (僅單人 Push)</div>
                </div>
              </div>
              <span class="badge ${lec.lineBound ? 'badge-green' : 'badge-slate'}">${lec.lineBound ? '已綁定' : '紙本待認領'}</span>
            </div>

            <div class="line-chat" id="lineChatArea">
              <div class="line-bubble-row">
                <div class="line-avatar">愿</div>
                <div class="line-bubble">
                  <strong>${esc(lec.name)} 講師吉祥 🙏</strong>
                  <div>核心精進愿景：<span style="color:var(--moss-dark);font-weight:700;">「${esc(lec.coreVision)}」</span></div>
                </div>
              </div>
              <div class="line-bubble-row">
                <div class="line-avatar">愿</div>
                <div class="line-bubble">
                  <div>目前年度總五星評比：<strong style="color:var(--gold);">★ ${overall.stars.toFixed(1)} 星 (${overall.rate}%)</strong></div>
                  <div style="color:var(--muted);margin-top:2px;">點選下方圖文選單可快速跳轉回報；本系統不主動群發推播，僅支援單人 Push 小卡。</div>
                </div>
              </div>
              ${extraBubbles}
            </div>

            <div style="padding:8px 12px;background:var(--surface-soft);border-top:1px solid var(--border);" class="row-between">
              <span class="text-xs" style="font-weight:600;color:var(--muted);">單人 Push 互動：</span>
              <button type="button" class="btn btn-outline" style="padding:4px 10px;font-size:11px;" data-action="push-summary">⭐ Push 星級小卡</button>
            </div>

            <div class="line-rich-menu">
              <button type="button" class="rich-btn primary" data-action="rich-overview"><span>🌟</span><strong>我的愿力表</strong></button>
              <button type="button" class="rich-btn green" data-action="rich-monthly"><span>📅</span><strong>本月進度回報</strong></button>
              <button type="button" class="rich-btn" data-action="open-add-modal"><span>➕</span><strong>新增目標</strong></button>
              <button type="button" class="rich-btn" data-action="switch-view" data-view="print"><span>🖨️</span><strong>母堂呈表</strong></button>
            </div>
          </aside>

          <div class="zen-card" style="text-align:center;">
            <span class="badge badge-green">DEMO 體驗專用</span>
            <h3 style="margin:8px 0 4px;font-size:15px;color:var(--text);">📱 加入 LINE 官方帳號試用</h3>
            <p class="text-xs" style="color:var(--muted);margin:0 0 10px;">基礎忠恕講師愿力表服務（ID：<code>@533ennet</code>）</p>
            <img src="./assets/line-oa-qr.png" alt="加入基礎忠恕講師愿力表服務 LINE 官方帳號 QR Code" style="width:160px;height:160px;border:1px solid var(--border-strong);border-radius:14px;padding:4px;background:#fff;" />
            <div style="margin-top:10px;">
              <a href="https://line.me/R/ti/p/@533ennet" target="_blank" rel="noopener noreferrer" class="btn btn-line" style="text-decoration:none;justify-content:center;">🟢 直接開啟 LINE 加好友</a>
            </div>
          </div>
        </div>

        <!-- Right: Lecturer PWA Mobile Simulator Frame (Frameless Zen Layout) -->
        <div class="demo-phone-frame">
          <div class="demo-phone-notch">
            <span>📱 講師手機端 PWA</span>
            <span>禪意留白版</span>
          </div>
          <div class="demo-phone-screen">
            <!-- Vision Card with SVG Progress Ring -->
            <div class="zen-vision-card" style="padding:16px;">
              <div style="flex:1;min-width:0;">
                <div class="row-wrap" style="gap:5px;margin-bottom:6px;">
                  <span class="badge badge-sky">${esc(lec.unit)}</span>
                  <span class="badge ${lec.inputMode === 'digital' ? 'badge-green' : 'badge-amber'}">${lec.inputMode === 'digital' ? '電子立愿' : '紙本建檔'}</span>
                </div>
                <h2 style="margin:0;font-size:19px;">${esc(lec.name)} <span style="font-size:12px;font-weight:400;color:var(--muted);">講師</span></h2>
                <div style="margin-top:4px;font-size:12px;">
                  <span style="color:var(--muted);">2026 核心愿景：</span>
                  <div style="font-weight:600;color:var(--text);display:flex;align-items:center;gap:4px;margin-top:2px;">
                    <span>${esc(lec.coreVision)}</span>
                    <button type="button" class="kr-footer-link-btn" style="background:var(--surface-warm);padding:2px 7px;border-radius:999px;" data-action="edit-vision">✎</button>
                  </div>
                </div>
                <div style="margin-top:8px;display:flex;align-items:center;gap:6px;">
                  <span style="color:var(--gold);font-weight:700;font-size:12px;">${overall.starText} ${overall.stars.toFixed(1)}</span>
                  <span class="badge badge-green">${overall.badge}</span>
                </div>
              </div>

              <div class="zen-ring-wrap" style="width:78px;height:78px;">
                <svg style="width:100%;height:100%;transform:rotate(-90deg);" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#EFECE6" stroke-width="8" />
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#7C8B74" stroke-width="8" stroke-linecap="round"
                    stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset.toFixed(2)}" />
                </svg>
                <div class="zen-ring-text">
                  <strong style="font-size:16px;color:var(--text);">${overall.rate}%</strong>
                  <span style="font-size:9px;color:var(--muted);">總達成率</span>
                </div>
              </div>
            </div>

            <!-- Frameless Month Pills directly on #FAF9F6 -->
            <div>
              <div class="row-between" style="padding:0 4px;margin-bottom:6px;">
                <span class="text-xs" style="color:var(--muted);font-weight:600;">月份進度</span>
                <div class="row-wrap" style="gap:8px;">
                  <span class="text-xs" style="color:var(--moss-dark);font-weight:700;">${state.activeMonth} 月</span>
                  <button type="button" class="btn btn-outline" style="padding:3px 10px;font-size:11px;" data-action="open-add-modal">＋ 新增</button>
                </div>
              </div>
              <div class="month-strip no-scrollbar" id="monthGrid">${monthPills}</div>
            </div>

            <!-- Frameless Segmented Goal Switcher directly on #FAF9F6 -->
            ${goals.length ? `
              <div>
                <div class="text-xs" style="color:var(--muted);font-weight:600;padding:0 4px;margin-bottom:6px;">聚焦目標</div>
                <div class="goal-seg-bar no-scrollbar">${goalTabsHtml}</div>
              </div>
            ` : ''}

            <!-- Single Focused Goal -->
            ${goalFocusHtml}
          </div>
        </div>
      </div>

      <!-- Collapsible Classic Table -->
      <details class="zen-card" style="margin-top:20px;">
        <summary style="cursor:pointer;list-style:none;" class="row-between">
          <div>
            <strong style="font-size:15px;">📋 展開完整橫式愿力表即時預覽（1～12 月總覽）</strong>
            <div class="text-xs" style="color:var(--muted);">上方卡片調整任何月份進度，表格與五星評比會即時同步。</div>
          </div>
          <span class="badge badge-green" style="padding:5px 12px;">點擊展開 ▾</span>
        </summary>
        <div style="margin-top:14px;">
          ${renderClassicTableHTML(lec, false)}
        </div>
      </details>
    `;
  }

  function renderPaperView() {
    return `
      <div class="zen-card stack">
        <div class="row-between" style="border-bottom:1px solid var(--border);padding-bottom:12px;">
          <div>
            <span class="badge badge-amber">法會 50% 年長紙本組解決方案（總管理員 / 單位負責人皆可代登）</span>
            <h2 style="margin:6px 0 2px;font-size:19px;">📝 法會現場「紙本愿力表」快速代登與綁定工作台</h2>
            <p class="text-xs" style="margin:0;color:var(--muted);">收齊紙本呈表後，在此快速建檔並產生專屬綁定碼。</p>
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
              <span class="badge badge-green" style="align-self:flex-start;">關鍵成果 1（必填）</span>
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
            <button type="submit" class="btn btn-primary">💾 儲存建檔</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderPrintView(lec) {
    const overall = computeLecturerStats(lec);
    return `
      <div class="stack">
        <div class="zen-card row-between no-print">
          <div>
            <strong>🖨️ 法會母堂呈表專用排版（A4 橫式列印格式）</strong>
            <div class="text-xs" style="color:var(--muted);">可切換為「目前講師資料版」或「空白手寫紙本模板（供法會現場發放）」。</div>
          </div>
          <div class="row-wrap">
            <button type="button" class="btn ${!state.printBlankMode ? 'btn-primary' : 'btn-outline'}" data-action="set-print-mode" data-blank="false">📄 目前講師資料版</button>
            <button type="button" class="btn ${state.printBlankMode ? 'btn-primary' : 'btn-outline'}" data-action="set-print-mode" data-blank="true">📝 空白手寫紙本模板</button>
            <button type="button" class="btn btn-dark" data-action="do-print">🖨️ 列印 / PDF</button>
          </div>
        </div>

        <div class="print-sheet">
          <div style="text-align:center;border-bottom:2px solid var(--moss);padding-bottom:12px;margin-bottom:14px;">
            <div style="font-size:12px;color:var(--muted);letter-spacing:2px;">2026 年度法會呈表專用</div>
            <h1 style="margin:4px 0;font-size:22px;color:var(--text);">講 師 精 進 愿 力 表（紙電雙軌呈表版）</h1>
            <div class="row-wrap" style="justify-content:center;font-size:13px;gap:20px;">
              <span><strong>所屬單位：</strong>${state.printBlankMode ? '＿＿＿＿＿＿＿＿' : esc(lec.unit)}</span>
              <span><strong>立愿講師：</strong>${state.printBlankMode ? '＿＿＿＿＿＿＿＿' : esc(lec.name)}</span>
              <span><strong>填報形式：</strong>${state.printBlankMode ? '□ 電子版列印　□ 現場手寫紙本' : (lec.inputMode === 'digital' ? '☑ 電子版列印呈表' : '☑ 紙本立愿建檔')}</span>
              <span><strong>總評比：</strong>${state.printBlankMode ? '☆☆☆☆☆' : `${overall.starText} (${overall.stars.toFixed(1)}星 / ${overall.rate}%)`}</span>
            </div>
          </div>

          ${renderClassicTableHTML(lec, state.printBlankMode)}

          <div class="print-footer-grid">
            <div style="border:1px solid var(--border-strong);border-radius:10px;padding:10px;">
              <strong>📱 專屬綁定碼：${state.printBlankMode ? 'VOW-______' : esc(lec.bindCode || lec.id)}</strong>
              <div style="color:var(--muted);margin-top:4px;">法會呈表後，平時每月可透過講師愿力表 LINE 官方帳號自由更新進度與心得。</div>
            </div>
            <div style="border:1px solid var(--border-strong);border-radius:10px;padding:10px;">
              <strong>點傳師 / 單位負責人慈悲勉勵：</strong>
            </div>
            <div style="border:1px solid var(--border-strong);border-radius:10px;padding:10px;display:flex;flex-direction:column;justify-content:space-between;">
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
      ? `<div class="zen-card" style="text-align:center;color:var(--muted);">沒有符合篩選條件的講師資料。</div>`
      : list
          .map((lec) => {
            const st = computeLecturerStats(lec);
            const isOpen = Boolean(state.adminExpandedMap[lec.id]);
            return `
              <div style="border:1px solid var(--border);border-radius:18px;overflow:hidden;background:#fff;">
                <div class="admin-lec-header" style="${isOpen ? 'border-bottom:1px solid var(--border);' : ''}" data-action="toggle-admin-row" data-id="${esc(lec.id)}">
                  <div class="admin-lec-meta">
                    <span class="badge badge-green" style="background:var(--moss);color:#fff;flex-shrink:0;">${esc(lec.unit)}</span>
                    <strong style="font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(lec.name)} 講師</strong>
                    <span class="badge ${lec.inputMode === 'digital' ? 'badge-green' : 'badge-amber'}" style="flex-shrink:0;">${lec.inputMode === 'digital' ? '電子自填' : '紙本代登'}</span>
                    <span style="color:var(--gold);font-weight:700;font-size:13px;flex-shrink:0;">${st.starText} ${st.stars.toFixed(1)}</span>
                    <span class="text-xs" style="color:var(--muted);flex-shrink:0;">(${st.rate}%｜${st.badge})</span>
                  </div>
                  <div class="admin-lec-actions">
                    <button type="button" class="btn btn-primary" style="padding:5px 11px;font-size:12px;" data-action="jump-pwa" data-id="${esc(lec.id)}">
                      <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"/></svg>
                      <span>檢視</span>
                    </button>
                    <span class="chevron-btn" title="${isOpen ? '收合' : '展開'}">
                      <svg class="chevron-icon ${isOpen ? 'open' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg>
                    </span>
                  </div>
                </div>
                ${isOpen ? `<div style="padding:12px;">${renderClassicTableHTML(lec, false)}</div>` : ''}
              </div>
            `;
          })
          .join('');

    return `
      <div class="stack">
        <div class="zen-card row-between">
          <div class="row-wrap" style="gap:14px;">
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:3px;color:var(--muted);">管理端分權角色 (RBAC)：</label>
              <select id="adminRoleFilter">
                <option value="ALL" ${state.adminRoleFilter === 'ALL' ? 'selected' : ''}>👑 總管理員（全道場單位）</option>
                <option value="台北一區" ${state.adminRoleFilter === '台北一區' ? 'selected' : ''}>📍 單位負責人：台北一區</option>
                <option value="台北二區" ${state.adminRoleFilter === '台北二區' ? 'selected' : ''}>📍 單位負責人：台北二區</option>
                <option value="教學組" ${state.adminRoleFilter === '教學組' ? 'selected' : ''}>📍 單位負責人：教學組</option>
                <option value="成全組" ${state.adminRoleFilter === '成全組' ? 'selected' : ''}>📍 單位負責人：成全組</option>
              </select>
            </div>
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:3px;color:var(--muted);">立愿方式：</label>
              <select id="adminModeFilter">
                <option value="ALL" ${state.adminModeFilter === 'ALL' ? 'selected' : ''}>全部（電子＋紙本）</option>
                <option value="digital" ${state.adminModeFilter === 'digital' ? 'selected' : ''}>📱 電子版自填</option>
                <option value="paper" ${state.adminModeFilter === 'paper' ? 'selected' : ''}>📝 紙本版代登</option>
              </select>
            </div>
            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:3px;color:var(--muted);">五星評比：</label>
              <select id="adminStarFilter">
                <option value="ALL" ${state.adminStarFilter === 'ALL' ? 'selected' : ''}>全部星級</option>
                <option value="HIGH" ${state.adminStarFilter === 'HIGH' ? 'selected' : ''}>★ 3.5 星以上</option>
                <option value="MID" ${state.adminStarFilter === 'MID' ? 'selected' : ''}>★ 2.0 ～ 3.4 星</option>
                <option value="LOW" ${state.adminStarFilter === 'LOW' ? 'selected' : ''}>★ 2.0 星以下</option>
              </select>
            </div>
          </div>
          <button type="button" class="btn btn-primary" data-action="export-csv">📥 匯出報表</button>
        </div>

        <div class="kpi-grid">
          <div class="zen-card">
            <div class="text-xs" style="color:var(--muted);">篩選單位立愿人數</div>
            <div class="kpi-num">${total} <span style="font-size:13px;font-weight:400;">位講師</span></div>
            <div class="text-xs" style="color:var(--moss-dark);">100% 完成母堂呈表建檔</div>
          </div>
          <div class="zen-card">
            <div class="text-xs" style="color:var(--muted);">紙電雙軌比例</div>
            <div class="kpi-num" style="font-size:18px;margin:10px 0;">📱 ${digitalCount} 人 ／ 📝 ${paperCount} 人</div>
            <div class="text-xs" style="color:var(--muted);">電子自填 vs 年長紙本代登</div>
          </div>
          <div class="zen-card">
            <div class="text-xs" style="color:var(--muted);">單位平均五星評比</div>
            <div class="kpi-num" style="color:var(--gold);">★ ${avgStars} <span style="font-size:13px;font-weight:400;color:var(--muted);">/ 5.0</span></div>
            <div class="text-xs" style="color:var(--muted);">平均達成率：${avgRate}%</div>
          </div>
          <div class="zen-card">
            <div class="text-xs" style="color:var(--muted);">LINE 綁定人數</div>
            <div class="kpi-num" style="color:var(--moss);">${boundCount} / ${total}</div>
            <div class="text-xs" style="color:var(--muted);">支援點對點單人 Push</div>
          </div>
        </div>

        <div class="zen-card stack">
          <div class="row-between">
            <div>
              <h3 style="margin:0;font-size:16px;">📋 各單位講師愿力目標、五星評比與 1~12 月進度總覽</h3>
              <p class="text-xs" style="margin:3px 0 0;color:var(--muted);">點擊任一講師列即可收合或展開完整 1~12 月進度明細表。</p>
            </div>
            <div class="row-wrap">
              <button type="button" class="btn btn-outline" style="padding:5px 12px;font-size:12px;" data-action="expand-all-admin">▾ 全部展開</button>
              <button type="button" class="btn btn-outline" style="padding:5px 12px;font-size:12px;" data-action="collapse-all-admin">▴ 全部收合</button>
            </div>
          </div>
          <div class="stack" style="gap:10px;">${itemsHtml}</div>
        </div>
      </div>
    `;
  }

  function renderMobileBottomNav() {
    return `
      <nav class="bottom-nav no-print" aria-label="手機功能導覽">
        <button type="button" class="bottom-nav-btn ${state.view === 'pwa' ? 'active' : ''}" data-action="switch-view" data-view="pwa">
          <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9.5z"/></svg>
          <span>愿力表</span>
        </button>
        <button type="button" class="bottom-nav-btn ${state.view === 'paper' ? 'active' : ''}" data-action="switch-view" data-view="paper">
          <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"/></svg>
          <span>紙本代登</span>
        </button>
        <button type="button" class="bottom-nav-btn ${state.view === 'print' ? 'active' : ''}" data-action="switch-view" data-view="print">
          <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659"/></svg>
          <span>呈表列印</span>
        </button>
        <button type="button" class="bottom-nav-btn ${state.view === 'admin' ? 'active' : ''}" data-action="switch-view" data-view="admin">
          <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg>
          <span>管理總覽</span>
        </button>
      </nav>
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
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">實際做法（選填）</label>
              <input id="modalKrAction" type="text" placeholder="例如：每週讀一篇＋寫看法、心得" />
            </div>

            <div>
              <label class="text-xs" style="font-weight:700;display:block;margin-bottom:4px;">原因與考量（選填）</label>
              <input id="modalKrReason" type="text" placeholder="例如：溫故知新，充實講道內涵" />
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
      ${renderMobileBottomNav()}
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
        state.activeGoalIndex = 0;
        state.openReflectionIds = {};
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

    root.querySelectorAll('input[data-action="range-kr"]').forEach((inp) => {
      inp.onchange = (e) => {
        const val = Number(e.target.value);
        mutateKr(inp.dataset.goal, inp.dataset.kr, (kr) => {
          if (!kr.monthlyValues) kr.monthlyValues = {};
          kr.monthlyValues[state.activeMonth] = val;
        }, `已更新 ${state.activeMonth}月進度為 ${val}%`);
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
          targetValue: kr1Type === 'COUNT' ? 12 : (kr1Type === 'PERIODIC' ? 6 : 100),
          unitLabel: kr1Type === 'COUNT' ? '次' : '%',
          monthlyValues: { [state.activeMonth]: kr1Init },
          reflections: { [state.activeMonth]: '法會紙本立愿已由單位協助數位建檔。' }
        }];
        if (kr1Type === 'PERIODIC') krs[0].durationMonths = 6;

        const kr2Title = document.getElementById('paperKr2Title').value.trim();
        if (kr2Title) {
          const kr2Type = document.getElementById('paperKr2Type').value;
          const kr2Init = Number(document.getElementById('paperKr2Init').value || 30);
          const kr2 = {
            id: 'KR_' + Date.now() + '_2',
            title: kr2Title,
            action: document.getElementById('paperKr2Action').value.trim() || '每月定期執行',
            reason: document.getElementById('paperKr2Reason').value.trim() || '同修共辦成全',
            type: kr2Type,
            targetValue: kr2Type === 'COUNT' ? 12 : 100,
            unitLabel: kr2Type === 'COUNT' ? '次' : '%',
            monthlyValues: { [state.activeMonth]: kr2Init },
            reflections: {}
          };
          if (kr2Type === 'PERIODIC') kr2.durationMonths = 6;
          krs.push(kr2);
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
        state.activeGoalIndex = 0;
        state.view = 'pwa';
        render();
        showToast(`已成功為「${name}」完成紙本代登！綁定碼：${newLec.bindCode}`);
      };
    }

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
        if (!Array.isArray(lec.goals)) lec.goals = [];
        const goalChoice = document.getElementById('modalGoalSelect').value;
        const type = document.getElementById('modalKrType').value;
        const rawTarget = Number(document.getElementById('modalKrTarget').value || 100);
        const newKr = {
          id: 'KR_' + Date.now(),
          title: document.getElementById('modalKrTitle').value.trim(),
          action: document.getElementById('modalKrAction').value.trim() || '依計畫持續精進',
          reason: document.getElementById('modalKrReason').value.trim() || '自我道學成長',
          type,
          targetValue: type === 'PERIODIC' ? Math.min(12, Math.max(3, rawTarget)) : rawTarget,
          unitLabel: document.getElementById('modalKrUnit').value.trim() || '%',
          monthlyValues: { [state.activeMonth]: type === 'PERCENT' ? 20 : (type === 'PERIODIC' ? 100 : 1) },
          reflections: {}
        };
        if (type === 'PERIODIC') newKr.durationMonths = newKr.targetValue;

        if (goalChoice === 'NEW') {
          const gTitle = document.getElementById('modalNewGoalInput').value.trim() || '新精進目標';
          lec.goals.push({ id: 'G_' + Date.now(), title: gTitle, krs: [newKr] });
          state.activeGoalIndex = lec.goals.length - 1;
        } else {
          const idx = lec.goals.findIndex((item) => item.id === goalChoice);
          if (idx >= 0) {
            if (!Array.isArray(lec.goals[idx].krs)) lec.goals[idx].krs = [];
            lec.goals[idx].krs.push(newKr);
            state.activeGoalIndex = idx;
          }
        }
        document.getElementById('addModal').classList.add('hidden');
        render();
        showToast(`已新增小目標「${newKr.title}」並自動納入五星評比`);
        global.VowStore.saveLecturer(lec);
      };
    }

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
      } else if (action === 'select-month') {
        state.activeMonth = Number(btn.dataset.month);
        render();
      } else if (action === 'select-goal-tab') {
        state.activeGoalIndex = Number(btn.dataset.idx);
        render();
      } else if (action === 'delete-goal') {
        e.stopPropagation();
        const lec = getActiveLecturer();
        if (!lec || !Array.isArray(lec.goals)) return;
        const gId = btn.dataset.id;
        const target = lec.goals.find((g) => g.id === gId);
        if (!target) return;
        if (!global.confirm(`確定要刪除目標「${target.title}」嗎？`)) return;
        lec.goals = lec.goals.filter((g) => g.id !== gId);
        if (state.activeGoalIndex >= lec.goals.length) {
          state.activeGoalIndex = Math.max(0, lec.goals.length - 1);
        }
        render();
        showToast('已刪除目標');
        global.VowStore.saveLecturer(lec);
      } else if (action === 'delete-kr') {
        const lec = getActiveLecturer();
        if (!lec || !Array.isArray(lec.goals)) return;
        const goal = lec.goals.find((g) => g.id === btn.dataset.goal);
        if (!goal || !Array.isArray(goal.krs)) return;
        const kr = goal.krs.find((k) => k.id === btn.dataset.kr);
        if (!kr) return;
        if (!global.confirm(`確定要刪除小目標「${kr.title}」嗎？`)) return;
        goal.krs = goal.krs.filter((k) => k.id !== btn.dataset.kr);
        if (goal.krs.length === 0) {
          lec.goals = lec.goals.filter((g) => g.id !== goal.id);
          if (state.activeGoalIndex >= lec.goals.length) {
            state.activeGoalIndex = Math.max(0, lec.goals.length - 1);
          }
        }
        render();
        showToast('已刪除小目標');
        global.VowStore.saveLecturer(lec);
      } else if (action === 'toggle-reflection') {
        const krId = btn.dataset.kr;
        state.openReflectionIds[krId] = !state.openReflectionIds[krId];
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
          }, '已帶入語音心得範例');
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
      } else if (action === 'toggle-admin-row') {
        const id = btn.dataset.id;
        state.adminExpandedMap[id] = !state.adminExpandedMap[id];
        render();
      } else if (action === 'expand-all-admin') {
        getFilteredLecturers().forEach((l) => { state.adminExpandedMap[l.id] = true; });
        render();
        showToast('已展開全部講師進度明細');
      } else if (action === 'collapse-all-admin') {
        getFilteredLecturers().forEach((l) => { state.adminExpandedMap[l.id] = false; });
        render();
        showToast('已收合全部講師列表');
      } else if (action === 'jump-pwa') {
        e.stopPropagation();
        state.activeLecturerId = btn.dataset.id;
        state.activeGoalIndex = 0;
        state.view = 'pwa';
        render();
        showToast(`已切換至 ${getActiveLecturer().name} 講師視角`);
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
