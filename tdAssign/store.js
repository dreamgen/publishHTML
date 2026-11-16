/* 天達排班協作 — 資料層
 *
 * 兩種實作、同一組介面：
 *   LocalStore    本機試用：localStorage，分頁之間用 storage 事件同步（可開兩個分頁模擬多人）
 *   FirebaseStore 多人連線：Firebase Realtime Database + Auth（Google、LINE）
 *
 * 寫入一律以「一個人加入一組／排進一天」這種最小路徑為單位（set(path, value)），
 * 所以兩個人同時改同一處不會互相蓋掉。
 *
 * 介面：
 *   store.mode            'local' | 'firebase'
 *   store.data            目前整份資料（唯讀快取）
 *   store.user            { uid, name, provider } 或 null
 *   store.online          是否連線中
 *   store.pending         尚未送出的寫入筆數（離線時累積）
 *   store.init()          Promise
 *   store.onChange(fn)    資料、身分、連線狀態有變時呼叫
 *   store.update(map)     { 'groups/k_1/12': {...}, 'assign/S001/3': null }，null 代表刪除
 *   store.set(path, v)    單一路徑
 *   store.pushId()        產生可排序的唯一 id
 *   store.signIn(kind)    'google' | 'line'；本機模式傳入身分物件
 *   store.signOut()
 */
(function () {
  'use strict';
  const CFG = window.TD_CONFIG || {};
  const TOP = ['meta', 'groups', 'groupMeta', 'assign', 'edits', 'extra', 'areas', 'members', 'admins', 'sched', 'users', 'addedPeople', 'pov', 'acks', 'coord', 'proposals', 'nominations', 'supportReq', 'rules', 'log', 'presence'];

  function setPath(obj, path, value) {
    const ks = path.split('/');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) {
      if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') {
        if (value === null) return;
        o[ks[i]] = {};
      }
      o = o[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (value === null || value === undefined) delete o[last]; else o[last] = value;
    // 清掉空的上層節點（和 Realtime Database 的行為一致）
    if (value === null) {
      for (let depth = ks.length - 1; depth > 0; depth--) {
        let p = obj;
        for (let i = 0; i < depth - 1; i++) p = p[ks[i]];
        const k = ks[depth - 1];
        if (p[k] && typeof p[k] === 'object' && !Object.keys(p[k]).length) delete p[k]; else break;
      }
    }
  }
  let idSeq = 0;
  function pushId() { return Date.now().toString(36) + (idSeq++).toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6); }

  function base() {
    const subs = [];
    return {
      data: {}, user: null, online: true, pending: 0, ready: false, error: '',
      onChange(fn) { subs.push(fn); },
      emit() { for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } } },
      set(path, v) { return this.update({ [path]: v }); },
      pushId
    };
  }

  /* ---------------- 本機試用 ---------------- */
  function LocalStore() {
    const KEY = 'tdAssign-local-v1', WHO = 'tdAssign-local-who';
    const s = base();
    s.mode = 'local';
    const load = () => { try { s.data = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { s.data = {}; } };
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s.data)); } catch (e) { s.error = '本機儲存空間不足'; } };
    s.init = async () => {
      load();
      try { s.user = JSON.parse(sessionStorage.getItem(WHO) || 'null'); } catch (e) { s.user = null; }
      window.addEventListener('storage', (e) => { if (e.key === KEY) { load(); s.emit(); } });
      s.ready = true; s.emit();
    };
    s.update = async (map) => {
      load(); // 先讀最新的，再套用自己的最小改動，避免蓋掉另一個分頁剛寫的
      for (const p in map) setPath(s.data, p, map[p]);
      save(); s.emit();
    };
    s.signIn = async (who) => {
      s.user = who; sessionStorage.setItem(WHO, JSON.stringify(who));
      load();
      const prev = (s.data.users || {})[who.uid] || {};
      const uObj = Object.assign({}, prev, { name: who.name, provider: 'local' });
      if (who.pid && !uObj.pid) {
        uObj.pid = who.pid;
        uObj.bindStatus = 'ok';
        uObj.bindArea = who.area || who.leadOf || '';
        uObj.bindAt = Date.now();
      }
      const up = { ['users/' + who.uid]: uObj };
      if (who.admin) up['admins/' + who.uid] = true;
      if (who.leadOf) { up['members/' + who.leadOf + '/' + who.uid] = { name: who.name, role: 'lead', status: 'ok', by: '本機試用' }; up['sched/' + who.uid] = true; }
      await s.update(up);
    };
    s.signOut = async () => { s.user = null; sessionStorage.removeItem(WHO); s.emit(); };
    s.reset = () => { localStorage.removeItem(KEY); load(); s.emit(); };
    return s;
  }

  /* ---------------- Firebase ---------------- */
  function FirebaseStore() {
    const FB = 'https://www.gstatic.com/firebasejs/11.6.1/';
    const OUT = 'tdAssign-outbox-v1', CACHE = 'tdAssign-cache-v1';
    const s = base();
    s.mode = 'firebase';
    s.online = false;
    let dbm, authm, db, auth, outbox = [], flushing = false, listening = {};
    const root = (CFG.root || 'td116') + '/';
    const saveOut = () => { try { localStorage.setItem(OUT, JSON.stringify(outbox)); } catch (e) { } s.pending = outbox.length; };
    const saveCache = () => { try { localStorage.setItem(CACHE, JSON.stringify(s.data)); } catch (e) { } };

    async function flush() {
      if (flushing || !s.online || !outbox.length) return;
      flushing = true;
      while (outbox.length && s.online) {
        const map = outbox[0], fb = {};
        for (const p in map) fb[root + p] = map[p];
        try { await dbm.update(dbm.ref(db), fb); outbox.shift(); saveOut(); s.error = ''; }
        catch (e) {
          // 權限不足等錯誤：丟掉這一筆並提示，免得卡住後面的寫入
          if (/permission/i.test(String(e && e.message))) { outbox.shift(); saveOut(); s.error = '沒有權限寫入，這一筆沒有存到雲端'; resub(); }
          else { s.error = '暫時無法寫入，稍後會再試'; break; }
        }
      }
      flushing = false; s.emit();
    }
    function sub(key) {
      if (listening[key]) return;
      listening[key] = dbm.onValue(dbm.ref(db, root + key), (snap) => {
        const v = snap.val();
        if (v == null) delete s.data[key]; else s.data[key] = v;
        // 尚未送出的本機改動要疊回去，畫面才不會跳回舊值
        for (const map of outbox) for (const p in map) if (p.split('/')[0] === key) setPath(s.data, p, map[p]);
        saveCache(); s.ready = true; s.emit();
      }, () => { listening[key] = null; });
    }
    function resub() { for (const k of TOP) { if (typeof listening[k] === 'function') { listening[k](); } listening[k] = null; sub(k); } }

    s.init = async () => {
      try { s.data = JSON.parse(localStorage.getItem(CACHE) || '{}') || {}; outbox = JSON.parse(localStorage.getItem(OUT) || '[]') || []; } catch (e) { }
      s.pending = outbox.length;
      if (Object.keys(s.data).length) { s.ready = true; s.emit(); }
      const [{ initializeApp }, d, a] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-database.js'), import(FB + 'firebase-auth.js')]);
      dbm = d; authm = a;
      const app = initializeApp(CFG.firebase, 'tdAssign');
      db = d.getDatabase(app); auth = a.getAuth(app);
      d.onValue(d.ref(db, '.info/connected'), (snap) => { s.online = !!snap.val(); s.emit(); flush(); });
      await lineCallback();
      try { await a.getRedirectResult(auth); } catch (e) { s.error = '登入沒有完成：' + (e.code || e.message); }
      a.onAuthStateChanged(auth, async (u) => {
        if (u) {
          const prov = u.uid.startsWith('line:') ? 'line' : 'google';
          const known = (s.data.users || {})[u.uid];
          s.user = { uid: u.uid, name: (known && known.name) || u.displayName || '', provider: prov };
          if (!known || !known.name) {
            s.update({
              ['users/' + u.uid + '/name']: s.user.name || '未命名',
              ['users/' + u.uid + '/provider']: prov
            });
          }
        } else s.user = null;
        resub(); // 登入前後能讀的範圍不同，重新訂閱
        s.emit();
      });
      for (const k of TOP) sub(k);
    };
    s.update = async (map) => {
      for (const p in map) setPath(s.data, p, map[p]);
      outbox.push(map); saveOut(); saveCache(); s.emit();
      flush();
    };
    s.signIn = async (kind) => {
      if (kind === 'google') {
        const prov = new authm.GoogleAuthProvider();
        try { await authm.signInWithPopup(auth, prov); }
        catch (e) {
          if (/popup|operation-not-supported/i.test(e.code || '')) await authm.signInWithRedirect(auth, prov);
          else throw e;
        }
      } else if (kind === 'line') {
        const state = pushId();
        sessionStorage.setItem('tdAssign-line-state', state);
        const redirect = location.origin + location.pathname;
        location.href = 'https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=' + encodeURIComponent(CFG.lineChannelId) +
          '&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + state + '&scope=profile%20openid';
      }
    };
    async function lineCallback() {
      const q = new URLSearchParams(location.search);
      const code = q.get('code'), state = q.get('state');
      if (!code || !state) return;
      const want = sessionStorage.getItem('tdAssign-line-state');
      const redirect = location.origin + location.pathname;
      history.replaceState(null, '', redirect + location.hash);
      if (state !== want) { s.error = 'LINE 登入沒有完成，請再試一次'; return; }
      sessionStorage.removeItem('tdAssign-line-state');
      try {
        const r = await fetch(CFG.lineWorkerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, redirectUri: redirect }) });
        const j = await r.json();
        if (!r.ok || !j.token) throw new Error(j.error || 'LINE 登入失敗');
        const cred = await authm.signInWithCustomToken(auth, j.token);
        if (j.name) {
          await s.update({
            ['users/' + cred.user.uid + '/name']: j.name,
            ['users/' + cred.user.uid + '/provider']: 'line'
          });
        }
      } catch (e) { s.error = 'LINE 登入沒有完成：' + e.message; }
    }
    s.signOut = async () => { await authm.signOut(auth); };
    return s;
  }

  window.TDStore = { create() { return CFG.firebase ? FirebaseStore() : LocalStore(); }, setPath, TOP };
  if (typeof module !== 'undefined') module.exports = window.TDStore;
})();
