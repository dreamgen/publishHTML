/* 講師愿力表系統 — 計算引擎與預設範例資料 */
(function (global) {
  'use strict';

  const METRIC_META = {
    PERCENT: { label: '百分比進度型', badgeClass: 'badge-sky', icon: '📊' },
    COUNT: { label: '累積次數型', badgeClass: 'badge-green', icon: '🔢' },
    PERIODIC: { label: '週期達成型', badgeClass: 'badge-purple', icon: '🗓️' },
    MILESTONE: { label: '階段里程碑型', badgeClass: 'badge-amber', icon: '☑️' },
    QUALITATIVE: { label: '心得自評型', badgeClass: 'badge-rose', icon: '💬' }
  };

  /**
   * 計算單項關鍵成果 (KR) 達成率，嚴格鎖定上限 100%
   */
  function computeKrProgress(kr, upToMonth = 12) {
    const mv = kr.monthlyValues || {};
    if (kr.type === 'PERCENT') {
      let latest = 0;
      for (let m = 1; m <= upToMonth; m++) {
        if (mv[m] !== undefined && mv[m] !== null && mv[m] !== '') {
          latest = Number(mv[m]);
        }
      }
      return Math.min(100, Math.max(0, Math.round(latest)));
    }
    if (kr.type === 'COUNT') {
      let sum = 0;
      for (let m = 1; m <= upToMonth; m++) {
        sum += Number(mv[m] || 0);
      }
      const target = Math.max(1, Number(kr.targetValue || 10));
      return Math.min(100, Math.max(0, Math.round((sum / target) * 100)));
    }
    if (kr.type === 'PERIODIC') {
      // 分母由講師自行設定完成期限（3 個月 ~ 12 個月）
      const durationMonths = Math.min(12, Math.max(3, Number(kr.durationMonths || kr.targetValue || 12)));
      let earned = 0;
      for (let m = 1; m <= upToMonth; m++) {
        if (mv[m] !== undefined && mv[m] !== '') {
          const v = Number(mv[m]);
          if (v >= 100) earned += 1;
          else if (v >= 50) earned += 0.5;
        }
      }
      return Math.min(100, Math.max(0, Math.round((earned / durationMonths) * 100)));
    }
    if (kr.type === 'MILESTONE') {
      let latestStep = 0;
      for (let m = 1; m <= upToMonth; m++) {
        if (mv[m] !== undefined && mv[m] !== '') {
          latestStep = Math.max(latestStep, Number(mv[m]));
        }
      }
      const totalSteps = Math.max(1, Number(kr.targetValue || (kr.milestones ? kr.milestones.length : 4)));
      return Math.min(100, Math.max(0, Math.round((latestStep / totalSteps) * 100)));
    }
    if (kr.type === 'QUALITATIVE') {
      let latestScore = 0;
      for (let m = 1; m <= upToMonth; m++) {
        if (mv[m] !== undefined && Number(mv[m]) > 0) {
          latestScore = Number(mv[m]);
        }
      }
      return Math.min(100, Math.max(0, Math.round((latestScore / 5) * 100)));
    }
    return 0;
  }

  function rateToStars(rate) {
    let stars = 0;
    let badge = '尚未啟動';
    if (rate <= 0) { stars = 0.0; badge = '尚未啟動'; }
    else if (rate < 20) { stars = 1.0; badge = '發心起步'; }
    else if (rate < 40) { stars = 2.0; badge = '持續精進'; }
    else if (rate < 60) { stars = 3.0; badge = '穩步前行'; }
    else if (rate < 75) { stars = 3.5; badge = '漸入佳境'; }
    else if (rate < 85) { stars = 4.0; badge = '精進標竿'; }
    else if (rate < 100) { stars = 4.5; badge = '即將圓滿'; }
    else { stars = 5.0; badge = '功德圓滿'; }

    const full = Math.floor(stars);
    const half = (stars % 1) >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    const starText = '★'.repeat(full) + (half ? '☆' : '') + '☆'.repeat(empty);
    return { stars, starText, badge, hasHalf: half === 1 };
  }

  function computeGoalStats(goal) {
    const krs = goal.krs || [];
    if (krs.length === 0) {
      return { rate: 0, stars: 0, starText: '☆☆☆☆☆', badge: '尚未設定' };
    }
    const sum = krs.reduce((acc, kr) => acc + computeKrProgress(kr, 12), 0);
    const rate = Math.min(100, Math.round(sum / krs.length));
    return { rate, ...rateToStars(rate) };
  }

  function computeLecturerStats(lecturer) {
    const goals = lecturer.goals || [];
    if (goals.length === 0) {
      return { rate: 0, stars: 0, starText: '☆☆☆☆☆', badge: '尚未啟動' };
    }
    const goalStats = goals.map((g) => computeGoalStats(g));
    const avgRate = Math.min(100, Math.round(goalStats.reduce((a, b) => a + b.rate, 0) / goalStats.length));
    return { rate: avgRate, ...rateToStars(avgRate) };
  }

  const DEFAULT_LECTURERS = [
    {
      id: 'L01',
      name: '陳明道',
      unit: '台北一區',
      role: 'lecturer',
      inputMode: 'digital',
      lineBound: true,
      lineUid: '',
      bindCode: 'VOW-L01',
      coreVision: '讓自己的道學更精進',
      goals: [
        {
          id: 'G01',
          title: '對道義問題能夠思考',
          krs: [
            {
              id: 'KR01',
              title: '讀一貫道疑問解答',
              action: '每週讀一篇+寫看法、心得',
              reason: '從已有的文本開始練習，嘗試自己回答同樣的問題',
              type: 'COUNT',
              targetValue: 24,
              unitLabel: '篇',
              monthlyValues: { 1: 2, 2: 1, 3: 3 },
              reflections: {
                1: '一月份讀完前2篇，開始練習用白話向新道親解釋三寶心法。',
                3: '三月份針對疑問解答第4~6篇撰寫個人體悟，收穫良多。'
              }
            },
            {
              id: 'KR02',
              title: '複習初級部的講義和筆記',
              action: '每週複習一個專題，補充心得',
              reason: '溫故知新',
              type: 'PERCENT',
              targetValue: 100,
              unitLabel: '%',
              monthlyValues: { 1: 30, 2: 60, 3: 100 },
              reflections: {
                2: '已完成初級部前半冊講義筆記重整。',
                3: '初級部全冊專題皆已複習完畢，並補充最新班務體悟。'
              }
            }
          ]
        },
        {
          id: 'G02',
          title: '落實講台實務與班務成全',
          krs: [
            {
              id: 'KR03',
              title: '準備一個新講題（道場禮節與修辦精神）',
              action: '依序完成資料蒐集、逐字稿、試講與上台',
              reason: '擴充個人講題庫，隨時補位學習',
              type: 'MILESTONE',
              targetValue: 4,
              unitLabel: '階段',
              milestones: ['1. 經典資料蒐集', '2. 撰寫講綱與逐字稿', '3. 前賢試講指導修正', '4. 正式上台傳題'],
              monthlyValues: { 1: 1, 2: 2, 3: 3 },
              reflections: { 3: '本月已請點傳師與資深講師協助聽試講，完成講稿微調。' }
            },
            {
              id: 'KR04',
              title: '每月參與研究班會後成全討論',
              action: '每月至少出席1次會後檢討並記錄成全心得',
              reason: '培養團隊默契並關心班員學習狀況',
              type: 'PERIODIC',
              durationMonths: 3,
              targetValue: 3,
              unitLabel: '月',
              monthlyValues: { 1: 100, 2: 100, 3: 100 },
              reflections: { 3: '第一季（3個月期限）皆全勤參與研究班會後討論。' }
            }
          ]
        }
      ]
    },
    {
      id: 'L02',
      name: '林淑慧',
      unit: '教學組',
      role: 'unit_leader',
      inputMode: 'digital',
      lineBound: true,
      lineUid: '',
      bindCode: 'VOW-L02',
      coreVision: '深化經典內涵，啟發班員道心',
      goals: [
        {
          id: 'G201',
          title: '精進四書與道學經典研讀',
          krs: [
            {
              id: 'KR201',
              title: '論語與大學章句分段研讀筆記',
              action: '每月完成2篇經典與日常修辦對照心得',
              reason: '充實講道內涵，言之有物',
              type: 'PERCENT',
              targetValue: 100,
              unitLabel: '%',
              monthlyValues: { 1: 25, 2: 55, 3: 85 },
              reflections: { 3: '已完成學而篇至里仁篇之講記整理。' }
            },
            {
              id: 'KR202',
              title: '每月課後道義思辨與體悟自評',
              action: '針對班員提問進行深度反思並記錄回饋',
              reason: '教學相長，提升應機說法能力',
              type: 'QUALITATIVE',
              targetValue: 5,
              unitLabel: '分',
              monthlyValues: { 1: 4, 2: 4, 3: 5 },
              reflections: { 3: '本月班員提問踴躍，整理出3則常見道義問答範例。' }
            }
          ]
        }
      ]
    },
    {
      id: 'L03',
      name: '張文德 (年長紙本組)',
      unit: '台北一區',
      role: 'lecturer',
      inputMode: 'paper',
      lineBound: true,
      lineUid: '',
      bindCode: 'VOW-L03',
      coreVision: '誠心抱守，老實修辦渡化有緣',
      goals: [
        {
          id: 'G301',
          title: '日常誦經迴向與道親家訪成全',
          krs: [
            {
              id: 'KR301',
              title: '全年關懷訪視道親 20 人次',
              action: '每逢初一十五前後偕同同修拜訪久未參班道親',
              reason: '溫暖道親的心，找回佛堂家人',
              type: 'COUNT',
              targetValue: 20,
              unitLabel: '人次',
              monthlyValues: { 1: 3, 2: 4, 3: 5 },
              reflections: { 3: '法會紙本立愿後，由單位負責人協助更新3月份家訪5人次紀錄。' }
            },
            {
              id: 'KR302',
              title: '持誦彌勒救苦真經與感恩反省（半年期）',
              action: '每日早晚獻香後虔誠持誦',
              reason: '定心修持，培養慈悲心念',
              type: 'PERIODIC',
              durationMonths: 6,
              targetValue: 6,
              unitLabel: '月',
              monthlyValues: { 1: 100, 2: 100, 3: 50 },
              reflections: { 3: '持續每日早晚功課不輟。' }
            }
          ]
        }
      ]
    },
    {
      id: 'L04',
      name: '王雅筑 (年長紙本組)',
      unit: '台北二區',
      role: 'lecturer',
      inputMode: 'paper',
      lineBound: false,
      lineUid: '',
      bindCode: 'VOW-L04',
      coreVision: '歡喜了愿，護持佛堂炊事與接待',
      goals: [
        {
          id: 'G401',
          title: '護持法會與研究班十組運作',
          krs: [
            {
              id: 'KR401',
              title: '傳承佛堂素食料理與接待禮節給新進道親',
              action: '每次班期帶領1~2位年輕道親實作學習',
              reason: '經驗傳承，讓佛堂人才源源不絕',
              type: 'PERCENT',
              targetValue: 100,
              unitLabel: '%',
              monthlyValues: { 1: 20, 2: 35, 3: 45 },
              reflections: { 3: '已帶領2位新進講師熟悉法會獻供與炊事流程。' }
            }
          ]
        }
      ]
    }
  ];

  global.VowEngine = {
    METRIC_META,
    computeKrProgress,
    rateToStars,
    computeGoalStats,
    computeLecturerStats,
    DEFAULT_LECTURERS
  };
})(window);
