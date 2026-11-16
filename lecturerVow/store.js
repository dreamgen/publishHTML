/* 講師愿力表系統 — 資料持久層 (localStorage + 全新 Firebase RTDB + LINE Login / Push API) */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'lecturer_vow_pwa_v1';
  const cfg = global.VOW_CONFIG || {};
  const rootPath = cfg.root || 'vow2026';

  let lecturers = [];
  let fbApp = null;
  let fbDb = null;
  let fbAuth = null;
  let currentUid = null;
  let onDataChangeCb = null;

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(global.VowEngine.DEFAULT_LECTURERS));
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      lecturers = raw ? JSON.parse(raw) : cloneDefaults();
    } catch {
      lecturers = cloneDefaults();
    }
    return lecturers;
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lecturers));
    } catch {
      // Ignore quota errors
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function initCloudIfConfigured(onChange) {
    onDataChangeCb = onChange;
    loadLocal();
    if (!cfg.firebase || !cfg.firebase.apiKey) {
      return { mode: 'local', uid: null };
    }

    try {
      if (!global.firebase) {
        await loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
        await loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js');
        await loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-database-compat.js');
      }
      fbApp = global.firebase.apps.length ? global.firebase.app() : global.firebase.initializeApp(cfg.firebase);
      fbAuth = global.firebase.auth();
      fbDb = global.firebase.database();

      // 若網址帶有 LINE Login OAuth 回傳的 code，向 Worker 交換 Firebase Custom Token
      const params = new URLSearchParams(global.location.search);
      const code = params.get('code');
      if (code && cfg.lineWorkerUrl) {
        const cleanRedirect = global.location.origin + global.location.pathname;
        global.history.replaceState({}, '', cleanRedirect);
        const res = await fetch(`${cfg.lineWorkerUrl.replace(/\/$/, '')}/auth/line`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirectUri: cleanRedirect })
        });
        const data = await res.json();
        if (data.token) {
          await fbAuth.signInWithCustomToken(data.token);
        }
      }

      // 若有 LIFF ID，嘗試無縫登入
      if (cfg.liffId && cfg.lineWorkerUrl && !fbAuth.currentUser) {
        try {
          await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
          await global.liff.init({ liffId: cfg.liffId });
          if (global.liff.isLoggedIn()) {
            const idToken = global.liff.getIDToken();
            if (idToken) {
              const res = await fetch(`${cfg.lineWorkerUrl.replace(/\/$/, '')}/auth/line`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken })
              });
              const data = await res.json();
              if (data.token) await fbAuth.signInWithCustomToken(data.token);
            }
          }
        } catch {
          // Non-LIFF browser fallback
        }
      }

      if (fbAuth.currentUser) {
        currentUid = fbAuth.currentUser.uid;
        subscribeCloudLecturers();
      }
      return { mode: 'firebase', uid: currentUid };
    } catch {
      return { mode: 'local-fallback', uid: null };
    }
  }

  function normalizeLecturer(lec) {
    if (!lec || typeof lec !== 'object') return lec;
    if (!Array.isArray(lec.goals)) lec.goals = [];
    lec.goals.forEach((g) => {
      if (!Array.isArray(g.krs)) g.krs = [];
    });
    return lec;
  }

  function subscribeCloudLecturers() {
    if (!fbDb) return;
    fbDb.ref(`${rootPath}/lecturers`).on('value', (snap) => {
      const val = snap.val();
      if (val && typeof val === 'object') {
        lecturers = Object.values(val).map(normalizeLecturer);
        saveLocal();
        if (typeof onDataChangeCb === 'function') onDataChangeCb(lecturers);
      }
    });
  }

  function getLecturers() {
    return lecturers;
  }

  function setLecturers(next) {
    lecturers = next;
    saveLocal();
  }

  async function saveLecturer(lec) {
    const clean = normalizeLecturer(JSON.parse(JSON.stringify(lec)));
    const idx = lecturers.findIndex((item) => item.id === clean.id);
    if (idx >= 0) lecturers[idx] = clean;
    else lecturers.push(clean);
    saveLocal();

    if (fbDb && fbAuth && fbAuth.currentUser) {
      try {
        await fbDb.ref(`${rootPath}/lecturers/${clean.id}`).set(clean);
      } catch (err) {
        console.error('Firebase save error:', err);
      }
    }
  }

  function startLineLogin() {
    if (!cfg.lineChannelId) return false;
    const redirectUri = encodeURIComponent(global.location.origin + global.location.pathname);
    const state = Math.random().toString(36).slice(2);
    global.location.href = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${encodeURIComponent(cfg.lineChannelId)}&redirect_uri=${redirectUri}&state=${state}&scope=profile%20openid`;
    return true;
  }

  /**
   * 單人 Push API（僅針對單一講師發送星級小卡或提醒，不做群發推播）
   */
  async function sendSinglePush(toLineUserId, messageText) {
    if (!cfg.lineWorkerUrl) {
      return { ok: false, simulated: true };
    }
    const res = await fetch(`${cfg.lineWorkerUrl.replace(/\/$/, '')}/line/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toLineUserId, messageText })
    });
    return { ok: res.ok, simulated: false };
  }

  global.VowStore = {
    initCloudIfConfigured,
    getLecturers,
    setLecturers,
    saveLecturer,
    startLineLogin,
    sendSinglePush
  };
})(window);
