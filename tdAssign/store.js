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
 *
 * 寫入格式（階段 1 起）：
 *   - 每一筆寫入的路徑、值都先檢查（不得含 . # $ [ ] 、undefined、NaN、__proto__），不合法直接拒收，不進 outbox。
 *   - outbox 每筆為 { uid, map }：只用寫入當下的帳號送出；別的帳號留下的筆數另計 store.foreignPending。
 *   - 舊版 outbox（純 map、undo 為物件、acks 鍵含「.」）在 init 時由 migrateOutbox() 轉換後再送。
 */
(function () {
  'use strict';
  const CFG = window.TD_CONFIG || {};
  const TOP = ['meta', 'groups', 'groupMeta', 'assign', 'edits', 'extra', 'areas', 'members', 'admins', 'sched', 'leads', 'users', 'addedPeople', 'pov', 'acks', 'coord', 'proposals', 'nominations', 'supportReq', 'rules', 'log', 'presence', 'acl', 'config'];
  // 只有登入且有權限才讀得到的節點：讀取被拒或登出時要清掉，也不寫進本機快取（P-01）
  const PRIVATE = new Set(['pov', 'users', 'admins', 'sched', 'leads']);
  const NO_CACHE = ['pov', 'users'];
  const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const ILLEGAL = /[.#$\[\]\/]/; // RTDB 鍵不允許的字元（路徑分段後的單一鍵）

  function setPath(obj, path, value) {
    const ks = String(path).split('/');
    if (ks.some((k) => !k || BAD_KEYS.has(k))) throw new Error('bad path ' + path);
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
  function getPath(obj, path) {
    let o = obj;
    for (const k of String(path).split('/')) { if (o == null || typeof o !== 'object' || BAD_KEYS.has(k)) return undefined; o = o[k]; }
    return o;
  }
  /* 寫入前檢查：回傳錯誤訊息字串，合法則回傳 '' */
  function checkKey(k) { return !k || ILLEGAL.test(k) || BAD_KEYS.has(k) || k.length > 700 ? '鍵不合法：' + k : ''; }
  function checkValue(v, where, depth) {
    if (v === null) return '';
    if (v === undefined) return '值為 undefined：' + where;
    if (typeof v === 'number') return Number.isFinite(v) ? '' : '數值不合法：' + where;
    if (typeof v === 'string' || typeof v === 'boolean') return '';
    if (typeof v !== 'object' || (depth || 0) > 30) return '值的型別不合法：' + where;
    for (const k of Object.keys(v)) {
      const e = checkKey(k) || checkValue(v[k], where + '/' + k, (depth || 0) + 1);
      if (e) return e;
    }
    return '';
  }
  function checkMap(map) {
    if (!map || typeof map !== 'object') return '寫入內容不合法';
    for (const p in map) {
      const segs = String(p).split('/');
      for (const k of segs) { const e = checkKey(k); if (e) return e + '（' + p + '）'; }
      const e = checkValue(map[p], p, 0);
      if (e) return e;
    }
    return '';
  }

  /* ---------- 舊版 outbox 轉換（S-01 救回卡住的寫入） ----------
   * 舊格式：outbox = [ map, map, ... ]
   *   - log/{id}.undo 為物件，鍵是含「/」的路徑 → 轉成陣列 [{p, v, a}]（a = 同一筆 map 裡該路徑寫入的值）
   *   - acks/{issueKey} 的鍵含「.」→ 換成「~」，並拿掉 msg（P-02 不再把訊息寫進公開節點）
   *   - pov 相關 log 訊息（某月暫停）→ 改成中性文字
   *   - 其他無法修正的路徑才丟棄，回傳 dropped 筆數
   * 新格式：outbox = [ { uid, map }, ... ]
   */
  const ackKey = (k) => String(k).replace(/\./g, '~').replace(/[^A-Za-z0-9_~\-]/g, '_');
  function stripNulls(o) { const r = {}; for (const k in o) if (o[k] !== null && o[k] !== undefined) r[k] = o[k]; return r; }
  function neutralMsg(msg) {
    let m = String(msg == null ? '' : msg);
    m = m.replace(/ (設為|取消)\d{1,2}月暫停$/, ' 的人員狀態已更新');
    m = m.replace(/^替暫停人員 (.+?) 預排 (\d+) 位替補$/, '為 $1 的勤務預排 $2 位替補');
    return m;
  }
  function convertUndo(undo, map) {
    if (Array.isArray(undo)) return undo.filter((u) => u && typeof u.p === 'string' && !checkMap({ [u.p]: null }));
    if (!undo || typeof undo !== 'object') return null;
    const out = [];
    for (const p of Object.keys(undo)) {
      if (checkMap({ [p]: null })) continue; // 路徑本身不合法：丟掉這一項
      out.push(stripNulls({ p, v: undo[p] == null ? null : undo[p], a: map && map[p] != null ? map[p] : null }));
    }
    return out.length ? out : null;
  }
  function migrateEntry(entry) {
    const isNew = entry && typeof entry === 'object' && entry.map && typeof entry.map === 'object' && !Array.isArray(entry.map) && Object.keys(entry).every((k) => k === 'uid' || k === 'map');
    const uid = isNew ? (entry.uid || null) : null;
    const src = isNew ? entry.map : entry;
    const out = {};
    let dropped = 0, converted = 0;
    if (!src || typeof src !== 'object') return { entry: null, dropped: 1, converted: 0 };
    for (const p0 of Object.keys(src)) {
      let p = p0, v = src[p0];
      const segs = p.split('/');
      if (segs[0] === 'acks' && segs.length === 2) {
        const nk = ackKey(segs[1]);
        if (nk !== segs[1]) { p = 'acks/' + nk; converted++; }
        if (v && typeof v === 'object' && 'msg' in v) { v = Object.assign({}, v); delete v.msg; converted++; }
      } else if (segs[0] === 'log' && segs.length === 2 && v && typeof v === 'object') {
        v = Object.assign({}, v);
        if (v.undo != null && !Array.isArray(v.undo)) { v.undo = convertUndo(v.undo, src); converted++; }
        else if (Array.isArray(v.undo)) v.undo = convertUndo(v.undo, src);
        if (v.undo == null) delete v.undo;
        const nm = neutralMsg(v.msg); if (nm !== v.msg) { v.msg = nm; converted++; }
        if (typeof v.msg === 'string' && v.msg.length > 300) v.msg = v.msg.slice(0, 300);
        if (typeof v.name === 'string' && v.name.length > 40) v.name = v.name.slice(0, 40);
      }
      if (checkMap({ [p]: v })) { dropped++; continue; }
      out[p] = v;
    }
    return { entry: Object.keys(out).length ? { uid, map: out } : null, dropped, converted };
  }
  function migrateOutbox(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const outbox = []; let dropped = 0, converted = 0;
    for (const e of list) {
      const r = migrateEntry(e);
      dropped += r.dropped; converted += r.converted;
      if (r.entry) outbox.push(r.entry);
    }
    return { outbox, dropped, converted };
  }

  let idSeq = 0;
  function pushId() { return Date.now().toString(36) + (idSeq++).toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6); }
  function randHex(n) {
    const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (!c) throw new Error('瀏覽器不支援安全亂數');
    return Array.from(c.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function base() {
    const subs = [];
    return {
      data: {}, user: null, online: true, pending: 0, foreignPending: 0, ready: false, authReady: false, error: '', notice: '',
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
      s.ready = true; s.authReady = true; s.emit();
    };
    s.update = async (map) => {
      const err = checkMap(map);
      if (err) { s.error = '這一筆資料格式不正確，沒有存檔：' + err; console.error(err, map); s.emit(); return false; }
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
    const OUT = 'tdAssign-outbox-v1', CACHE = 'tdAssign-cache-v1', LOG_LIMIT = 1000;
    const s = base();
    s.mode = 'firebase';
    s.online = false;
    let dbm, authm, db, auth, outbox = [], flushing = false, listening = {};
    const root = (CFG.root || 'td116') + '/';
    const curUid = () => (auth && auth.currentUser && auth.currentUser.uid) || null;
    const mine = (e) => !e.uid || e.uid === curUid();
    function count() {
      s.pending = outbox.filter(mine).length;
      s.foreignPending = outbox.length - s.pending;
    }
    const saveOut = () => { try { localStorage.setItem(OUT, JSON.stringify(outbox)); } catch (e) { } count(); };
    const saveCache = () => {
      try {
        const c = Object.assign({}, s.data);
        for (const k of NO_CACHE) delete c[k];
        localStorage.setItem(CACHE, JSON.stringify(c));
      } catch (e) { }
    };
    function dropPrivate(keys) {
      let changed = false;
      for (const k of keys) if (k in s.data) { delete s.data[k]; changed = true; }
      if (changed) saveCache();
      return changed;
    }

    async function flush() {
      // N-4：沒有登入時一律不送、也不丟棄；等有人登入再送（沒有 uid 的舊筆數由第一個登入者送出）
      if (flushing || !s.online || !s.authReady || !curUid() || !outbox.length) return;
      flushing = true;
      let i = 0;
      while (i < outbox.length && s.online) {
        const ent = outbox[i];
        if (!mine(ent)) { i++; continue; } // 別的帳號留下的：保留，不用目前身分送出
        const fb = {};
        for (const p in ent.map) fb[root + p] = ent.map[p];
        try { await dbm.update(dbm.ref(db), fb); outbox.splice(i, 1); saveOut(); s.error = ''; }
        catch (e) {
          const msg = String(e && (e.code || e.message));
          const retryable = /network|disconnect|unavailable|timeout|offline/i.test(msg);
          if (!retryable) {
            outbox.splice(i, 1); saveOut();
            const what = Object.keys(ent.map).slice(0, 2).join('、');
            s.error = (/permission/i.test(msg) ? '沒有權限寫入，這一筆沒有存到雲端' : '資料格式錯誤，這一筆沒有存到雲端') + (what ? '（' + what + '）' : '');
            console.error(e, ent.map); resub();
          } else { s.error = '暫時無法寫入，稍後會再試'; break; }
        }
      }
      flushing = false; s.emit();
    }
    function sub(key) {
      if (listening[key]) return;
      // N-7：log 只訂閱最近 LOG_LIMIT 筆（push id 依時間排序），避免被灌爆後每個人啟動都下載整個節點
      const r0 = dbm.ref(db, root + key);
      const rq = key === 'log' && dbm.query && dbm.limitToLast ? dbm.query(r0, dbm.limitToLast(LOG_LIMIT)) : r0;
      listening[key] = dbm.onValue(rq, (snap) => {
        const v = snap.val();
        if (v == null) delete s.data[key]; else s.data[key] = v;
        // 尚未送出的本機改動要疊回去，畫面才不會跳回舊值
        for (const ent of outbox) if (mine(ent)) for (const p in ent.map) if (p.split('/')[0] === key) setPath(s.data, p, ent.map[p]);
        saveCache(); s.ready = true; s.emit();
      }, () => {
        listening[key] = null;
        if (PRIVATE.has(key) && dropPrivate([key])) s.emit();
      });
    }
    function resub() { for (const k of TOP) { if (typeof listening[k] === 'function') { listening[k](); } listening[k] = null; sub(k); } }

    s.init = async () => {
      let rawOut = [];
      try { s.data = JSON.parse(localStorage.getItem(CACHE) || '{}') || {}; rawOut = JSON.parse(localStorage.getItem(OUT) || '[]') || []; } catch (e) { }
      // 舊版快取可能存有 pov、users（P-01），一律清掉
      for (const k of NO_CACHE) delete s.data[k];
      const mig = migrateOutbox(rawOut);
      outbox = mig.outbox;
      if (mig.dropped) s.notice = `有 ${mig.dropped} 筆舊版本留下的待送資料格式無法轉換，已捨棄，請檢查最近的排班是否需要重做。`;
      saveOut(); saveCache();
      if (Object.keys(s.data).length) { s.ready = true; s.emit(); }
      // 測試用接縫：window.__TD_SDK 有提供對應模組時不連線載入（正式環境沒有這個物件）
      const sdk = (f) => Promise.resolve((window.__TD_SDK && window.__TD_SDK[f]) || import(FB + f));
      const [{ initializeApp }, d, a] = await Promise.all([sdk('firebase-app.js'), sdk('firebase-database.js'), sdk('firebase-auth.js')]);
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
          s.user = { uid: u.uid, name: String((known && known.name) || u.displayName || '').slice(0, 40), provider: prov };
          if (!known || !known.name) {
            s.update({
              ['users/' + u.uid + '/name']: s.user.name || '未命名',
              ['users/' + u.uid + '/provider']: prov
            });
          }
        } else {
          s.user = null;
          dropPrivate(['pov', 'users', 'admins', 'sched', 'leads']);
        }
        s.authReady = true;
        count();
        resub(); // 登入前後能讀的範圍不同，重新訂閱
        s.emit();
        flush();
      });
      for (const k of TOP) sub(k);
    };
    s.update = async (map) => {
      const err = checkMap(map);
      if (err) { s.error = '這一筆資料格式不正確，沒有存檔：' + err; console.error(err, map); s.emit(); return false; }
      for (const p in map) setPath(s.data, p, map[p]);
      outbox.push({ uid: curUid(), map }); saveOut(); saveCache(); s.emit();
      flush();
    };
    s.discardForeign = () => { outbox = outbox.filter(mine); saveOut(); s.emit(); };
    s.signIn = async (kind) => {
      if (kind === 'google') {
        const prov = new authm.GoogleAuthProvider();
        try { await authm.signInWithPopup(auth, prov); }
        catch (e) {
          if (/popup|operation-not-supported/i.test(e.code || '')) await authm.signInWithRedirect(auth, prov);
          else throw e;
        }
      } else if (kind === 'line') {
        const state = randHex(16), nonce = randHex(16);
        sessionStorage.setItem('tdAssign-line-state', state);
        sessionStorage.setItem('tdAssign-line-nonce', nonce);
        const redirect = location.origin + location.pathname;
        location.href = 'https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=' + encodeURIComponent(CFG.lineChannelId) +
          '&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + state + '&nonce=' + nonce + '&scope=profile%20openid';
      }
    };
    async function lineCallback() {
      const q = new URLSearchParams(location.search);
      const code = q.get('code'), state = q.get('state');
      if (!code || !state) return;
      const want = sessionStorage.getItem('tdAssign-line-state');
      const nonce = sessionStorage.getItem('tdAssign-line-nonce') || '';
      const redirect = location.origin + location.pathname;
      history.replaceState(null, '', redirect + location.hash);
      if (!want || state !== want) { s.error = 'LINE 登入沒有完成，請再試一次'; return; }
      sessionStorage.removeItem('tdAssign-line-state');
      sessionStorage.removeItem('tdAssign-line-nonce');
      try {
        const r = await fetch(CFG.lineWorkerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, redirectUri: redirect, nonce }) });
        const j = await r.json();
        if (!r.ok || !j.token) throw new Error(j.error || 'LINE 登入失敗');
        const cred = await authm.signInWithCustomToken(auth, j.token);
        if (j.name) {
          await s.update({
            ['users/' + cred.user.uid + '/name']: String(j.name).slice(0, 40),
            ['users/' + cred.user.uid + '/provider']: 'line'
          });
        }
      } catch (e) { s.error = 'LINE 登入沒有完成：' + e.message; }
    }
    s.signOut = async () => { await authm.signOut(auth); };
    return s;
  }

  window.TDStore = { create() { return CFG.firebase ? FirebaseStore() : LocalStore(); }, setPath, getPath, checkMap, migrateOutbox, TOP };
  if (typeof module !== 'undefined') module.exports = window.TDStore;
})();
