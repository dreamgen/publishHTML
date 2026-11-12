// 「Google 相簿」分頁：
//   方案 A：連結主辦者的 Google 帳號 → 系統建立相簿 → 主辦者在 Google 相簿 App 開共用 → 照片分批同步
//   方案 B（備援）：把照片下載到資料夾或 ZIP，手動拖進任何 Google 相簿
import { h, mount, copyText, flashLabel, fmtDateTime, fmtBytes, toast } from './admin-common.js';

const RETURN_KEY = 'mv.gp.return';
const WHY = {
  state: '授權連結已逾時或無效，請重新按「連結 Google 相簿」。',
  nonce: '請在同一個瀏覽器完成 Google 授權（不要複製授權網址到別的瀏覽器）。',
  scope: '授權時沒有勾選「將相片和影片新增至 Google 相簿」，請重新連結並勾選全部權限。',
  refresh: 'Google 沒有發出長期授權。請到 Google 帳號「第三方應用程式與服務」移除本應用程式後再連結一次。',
  token: 'Google 授權回應錯誤，請稍後再試。',
  album: '建立 Google 相簿失敗，請稍後再試。',
  event: '活動不存在或已封存。',
  code: 'Google 沒有回傳授權碼，請再試一次。',
  disabled: '伺服器尚未設定 Google 相簿匯出。',
};

export function renderGphotos(ctx, panel) {
  let st = null;         // GET /gphotos 回傳
  let loadErr = '';
  let running = false;   // 立即同步進行中
  let stopReq = false;
  let runMsg = '';
  let dl = null;         // 下載進度 { done, total, bytes, label }
  let dlStop = false;
  let includeExcluded = false;

  async function load() {
    try { st = await ctx.api('/gphotos'); loadErr = ''; } catch (e) { loadErr = e.message; }
    draw();
  }

  async function connect() {
    try {
      const r = await ctx.api('/gphotos/connect', { method: 'POST' });
      try { sessionStorage.setItem(RETURN_KEY, location.hash); } catch { /* 私密模式：回來時改用本機記住的管理碼 */ }
      location.href = r.auth_url;
    } catch (e) { toast(`無法開始連結：${e.message}`, 'err'); }
  }

  async function disconnect() {
    const ok = await ctx.ask({
      title: '中斷 Google 相簿連結', okLabel: '中斷連結', danger: true,
      body: '會撤銷本系統對你 Google 相簿的授權，之後不會再同步。相簿與已上傳的照片都會留在 Google 相簿。之後用同一個 Google 帳號重新連結，可以接續同一本相簿。',
    });
    if (!ok) return;
    try { st = await ctx.api('/gphotos/disconnect', { method: 'POST' }); toast('已中斷連結'); } catch (e) { toast(`失敗：${e.message}`, 'err'); }
    draw();
  }

  async function savePatch(body, okMsg) {
    try { st = await ctx.api('/gphotos', { method: 'PATCH', body }); toast(okMsg); } catch (e) { toast(`儲存失敗：${e.message}`, 'err'); }
    draw();
  }

  async function syncNow(retryFailed = false) {
    if (running) return;
    running = true; stopReq = false; runMsg = '同步中…';
    draw();
    let total = 0;
    let first = true;
    try {
      for (;;) {
        const r = await ctx.api('/gphotos/sync', { method: 'POST', body: { limit: 8, retry_failed: retryFailed && first } });
        first = false;
        st = r;
        total += r.added;
        runMsg = `本次已同步 ${total} 張，剩 ${r.remaining} 張`;
        draw();
        if (!r.remaining || stopReq) break;
        if (!r.added && !r.failed_now) break; // 沒有進展（避免無窮迴圈）
      }
      toast(stopReq ? `已暫停，本次同步 ${total} 張` : `同步完成，本次 ${total} 張`);
    } catch (e) {
      runMsg = '';
      if (e.code === 'gphotos_busy') toast('另一個同步正在進行（可能是自動同步），請稍候再試', 'err');
      else toast(`同步中斷：${e.message}`, 'err');
      await load();
    } finally {
      running = false;
      draw();
    }
  }

  // ---------- 方案 B：下載 ----------
  async function listPhotos() {
    const out = [];
    let cursor = '';
    do {
      const r = await ctx.api(`/photos${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      out.push(...r.photos);
      cursor = r.cursor || '';
    } while (cursor);
    return out.filter((p) => includeExcluded || !p.excluded);
  }
  const fileName = (p) => `${(p.exif_time || p.uploaded_at || '').replace(/[-:]/g, '').replace('T', '_').slice(0, 15) || 'photo'}_${p.hash.slice(0, 10)}.${p.ext || 'jpg'}`;
  async function fetchOriginal(p) {
    const res = await ctx.api(`/original/${p.hash}`, { raw: true });
    return new Uint8Array(await res.arrayBuffer());
  }

  async function downloadToFolder() {
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
    await runDownload(async (list) => {
      for (const p of list) {
        if (dlStop) break;
        const name = fileName(p);
        let exists = false;
        try { await dir.getFileHandle(name); exists = true; } catch { /* 不存在 */ }
        if (!exists) {
          const bytes = await fetchOriginal(p);
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await w.write(bytes);
          await w.close();
          dl.bytes += bytes.length;
        }
        dl.done++;
        draw();
      }
    });
  }

  async function downloadZip() {
    const PART = 400 * 1024 * 1024; // 每個 ZIP 約 400MB，避免瀏覽器記憶體不足
    const base = (ctx.cfg.basic?.name || 'photos').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    await runDownload(async (list) => {
      let zip = new ZipWriter();
      let part = 1;
      const flush = () => {
        if (!zip.count) return;
        saveBlob(zip.finish(), `${base}_照片_${String(part).padStart(2, '0')}.zip`);
        part++;
        zip = new ZipWriter();
      };
      for (const p of list) {
        if (dlStop) break;
        const bytes = await fetchOriginal(p);
        if (zip.size + bytes.length > PART) flush();
        zip.add(fileName(p), bytes);
        dl.done++; dl.bytes += bytes.length;
        draw();
      }
      flush();
    });
  }

  async function runDownload(fn) {
    if (dl) return;
    dlStop = false;
    dl = { done: 0, total: 0, bytes: 0 };
    draw();
    try {
      const list = await listPhotos();
      dl.total = list.length;
      draw();
      if (!list.length) { toast('沒有可下載的照片'); return; }
      await fn(list);
      toast(dlStop ? `已停止，完成 ${dl.done} 張` : `下載完成，共 ${dl.done} 張`);
    } catch (e) {
      toast(`下載中斷：${e.message}`, 'err');
    } finally {
      dl = null;
      draw();
    }
  }

  // ---------- 畫面 ----------
  function statusCard() {
    if (!st) return h('section', { class: 'card' }, h('div', { class: 'muted', text: loadErr ? `讀取失敗：${loadErr}` : '讀取中…' }));
    if (!st.enabled && !st.album_title) {
      return h('section', { class: 'card stack', 'aria-labelledby': 'gp-h' },
        h('h2', { id: 'gp-h', class: 'h2', text: '同步到 Google 相簿' }),
        h('div', { class: 'warn', text: '這個網站還沒有啟用 Google 相簿同步（管理員需要在 Google Cloud 開啟 Photos Library API，並設定 GOOGLE_CLIENT_SECRET）。目前可以先用下方「下載全部照片」手動放進 Google 相簿。' }));
    }
    const canWrite = ctx.canWrite;
    const kids = [h('h2', { id: 'gp-h', class: 'h2', text: '同步到 Google 相簿' })];
    if (!st.album_title) {
      kids.push(
        h('div', { class: 'muted' }, '用你的 Google 帳號授權後，系統會在你的 Google 相簿建立一本「', h('b', { text: ctx.cfg.basic?.name || '活動' }), '」相簿，把收到的照片自動放進去。你再到 Google 相簿 App 把相簿設成共用，就能分享給大家。'),
        h('ol', { class: 'note gp-steps' },
          h('li', { text: '按「連結 Google 相簿」，用要存放照片的 Google 帳號登入並勾選全部權限。' }),
          h('li', { text: '回到這裡後按「立即同步」（或開啟每小時自動同步）。' }),
          h('li', { text: '在 Google 相簿 App 打開這本相簿 → 分享 → 建立連結，把連結貼回這裡方便複製。' })),
        h('div', { class: 'muted small', text: '注意：照片會佔用該 Google 帳號的儲存空間；Google 不允許程式寫入你自己建立的相簿，所以一定要用系統建立的這本相簿。' }),
        canWrite ? h('div', {}, h('button', { type: 'button', class: 'btn btn-primary', text: '連結 Google 相簿', onclick: connect })) : h('div', { class: 'ac-lock', text: '需要管理者權限。' }),
      );
      return h('section', { class: 'card stack', 'aria-labelledby': 'gp-h' }, ...kids);
    }

    // 已連結過
    if (st.need_reconnect) {
      kids.push(h('div', { class: 'warn' }, st.last_error || '目前沒有有效的 Google 授權，無法同步。', ' ',
        canWrite ? h('button', { type: 'button', class: 'btn btn-sm', text: '重新連結', onclick: connect }) : null));
    }
    kids.push(h('dl', { class: 'gp-info' },
      h('dt', { text: 'Google 帳號' }), h('dd', { text: st.account_email || '（未知）' }),
      h('dt', { text: '相簿' }), h('dd', {},
        st.album_url ? h('a', { href: st.album_url, target: '_blank', rel: 'noopener', text: st.album_title }) : st.album_title),
      h('dt', { text: '連結時間' }), h('dd', { text: st.connected_at ? `${fmtDateTime(st.connected_at)}${st.connected_by ? `（${st.connected_by}）` : ''}` : '—' })));

    // 共用連結
    const shareInp = h('input', { class: 'input', type: 'url', value: st.share_url || '', placeholder: 'https://photos.app.goo.gl/…', 'aria-label': 'Google 相簿共用連結' });
    const copyShare = h('button', { type: 'button', class: 'btn', text: '複製', disabled: !st.share_url, onclick: async () => {
      if (await copyText(st.share_url)) flashLabel(copyShare, '已複製'); else toast('無法複製', 'err');
    } });
    kids.push(
      h('h3', { class: 'h3', text: '共用連結' }),
      st.share_url ? null : h('div', { class: 'note', text: '相簿目前只有你看得到。請在 Google 相簿 App 打開上面的相簿 → 右上角「分享」→「建立連結」（可開啟「協作」讓大家也能加照片），把連結貼在下面。' }),
      h('div', { class: 'row' }, shareInp,
        canWrite ? h('button', { type: 'button', class: 'btn', text: '儲存', onclick: () => savePatch({ share_url: shareInp.value.trim() }, '已儲存共用連結') }) : null,
        copyShare));
    return h('section', { class: 'card stack', 'aria-labelledby': 'gp-h' }, ...kids);
  }

  function syncCard() {
    if (!st || !st.album_title) return null;
    const pct = st.eligible ? Math.round((st.synced / st.eligible) * 100) : 0;
    const canSync = ctx.canWrite && st.connected && !running;
    const auto = h('input', { type: 'checkbox', id: 'gp-auto', checked: !!st.auto, disabled: !ctx.canWrite || !st.connected });
    auto.addEventListener('change', () => savePatch({ auto: auto.checked }, auto.checked ? '已開啟自動同步' : '已關閉自動同步'));
    return h('section', { class: 'card stack', 'aria-labelledby': 'gps-h' },
      h('h2', { id: 'gps-h', class: 'h2', text: '同步進度' }),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(st.eligible), 'aria-valuenow': String(st.synced) },
        h('span', { style: `width:${pct}%` })),
      h('div', { class: 'row gp-nums' },
        h('span', {}, '已同步 ', h('b', { text: String(st.synced) }), ` / ${st.eligible} 張`),
        h('span', { class: 'muted', text: `剩 ${st.remaining} 張` }),
        st.failed ? h('span', { class: 'gp-fail', text: `失敗 ${st.failed} 張` }) : null,
        h('span', { class: 'muted small', text: st.last_sync_at ? `上次同步 ${fmtDateTime(st.last_sync_at)}` : '尚未同步' })),
      runMsg ? h('div', { class: 'note', role: 'status', text: runMsg }) : null,
      st.last_error && !st.need_reconnect ? h('div', { class: 'warn', text: `上次錯誤：${st.last_error}` }) : null,
      h('div', { class: 'row' },
        running
          ? h('button', { type: 'button', class: 'btn', text: stopReq ? '暫停中…' : '暫停', onclick: () => { stopReq = true; draw(); } })
          : h('button', { type: 'button', class: 'btn btn-primary', text: '立即同步', disabled: !canSync || !st.remaining, onclick: () => syncNow(false) }),
        st.failed && !running ? h('button', { type: 'button', class: 'btn', text: '重試失敗的照片', disabled: !canSync, onclick: () => syncNow(true) }) : null),
      st.failed_list && st.failed_list.length ? h('details', { class: 'pv' }, h('summary', { text: '失敗原因' }),
        h('ul', { class: 'gp-faillist' }, st.failed_list.map((f) => h('li', {}, h('code', { text: f.hash.slice(0, 10) }), ` ${f.msg}`)))) : null,
      h('label', { class: 'check', for: 'gp-auto' }, auto, ' 每小時自動同步新照片（每次最多約 10 張；照片多時請按「立即同步」）'),
      h('div', { class: 'muted small', text: '已排除、上傳者刪除的照片不會同步；已同步到 Google 相簿的照片，之後在這裡排除或刪除，不會從 Google 相簿移除（請到 Google 相簿手動刪）。活動照片到期自動刪除時，Google 相簿裡的照片也會保留。' }),
      ctx.canWrite && st.connected ? h('div', {}, h('button', { type: 'button', class: 'btn btn-sm', text: '中斷連結', onclick: disconnect })) : null,
      ctx.canWrite && !st.connected && !st.need_reconnect ? h('div', {}, h('button', { type: 'button', class: 'btn btn-primary', text: '重新連結', onclick: connect })) : null);
  }

  function downloadCard() {
    if (!ctx.canWrite) return null;
    const hasFs = typeof window.showDirectoryPicker === 'function';
    const ex = h('input', { type: 'checkbox', id: 'gp-ex', checked: includeExcluded, disabled: !!dl });
    ex.addEventListener('change', () => { includeExcluded = ex.checked; });
    const pct = dl && dl.total ? Math.round((dl.done / dl.total) * 100) : 0;
    return h('section', { class: 'card stack', 'aria-labelledby': 'gpd-h' },
      h('h2', { id: 'gpd-h', class: 'h2', text: '備援：下載全部照片' }),
      h('div', { class: 'muted', text: '不想授權、或要放進「你自己既有的」共用相簿時：先把原圖下載下來，再打開 photos.google.com 的相簿，把檔案拖進去上傳。' }),
      h('label', { class: 'check', for: 'gp-ex' }, ex, ' 包含已排除的照片'),
      dl ? h('div', { class: 'stack' },
        h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` })),
        h('div', { class: 'row' },
          h('span', { text: dl.total ? `${dl.done} / ${dl.total} 張・${fmtBytes(dl.bytes)}` : '整理清單中…' }),
          h('button', { type: 'button', class: 'btn btn-sm', text: '停止', onclick: () => { dlStop = true; } })))
        : h('div', { class: 'row' },
          hasFs ? h('button', { type: 'button', class: 'btn btn-primary', text: '下載到資料夾', onclick: downloadToFolder }) : null,
          h('button', { type: 'button', class: hasFs ? 'btn' : 'btn btn-primary', text: '下載 ZIP', onclick: downloadZip })),
      h('div', { class: 'muted small', text: hasFs
        ? '「下載到資料夾」會直接寫進你選的資料夾，中斷後再按一次會跳過已下載的檔案（建議電腦版 Chrome／Edge）。ZIP 每包約 400MB。'
        : 'ZIP 每包約 400MB；照片很多時會分成多個檔案下載。' }));
  }

  function draw() {
    mount(panel, statusCard(), syncCard(), downloadCard());
  }

  // 從 Google 授權頁回來
  if (ctx.gpReturn) {
    const r = ctx.gpReturn;
    if (r.gp === 'ok') toast(r.reused ? '已重新連結，沿用原本的 Google 相簿' : '已連結 Google 相簿，並建立了新相簿');
    else if (r.gp === 'denied') toast('你取消了 Google 授權', 'err');
    else toast(WHY[r.why] || 'Google 相簿連結失敗，請再試一次', 'err');
  }
  draw();
  return { load };
}

// ---------- 下載工具 ----------
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// 最小 ZIP 產生器（只用「儲存」不壓縮；照片本來就壓縮過）。檔名用 UTF-8（旗標 bit 11）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.size = 0; this.count = 0; }
  add(name, data) {
    const nb = new TextEncoder().encode(name);
    const crc = crc32(data);
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true);
    ch.setUint32(42, this.size, true);
    this.parts.push(lh, nb, data);
    this.central.push(ch, nb);
    this.size += 30 + nb.length + data.length;
    this.count++;
  }
  finish() {
    const cdSize = this.central.reduce((s, x) => s + x.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, this.count, true); end.setUint16(10, this.count, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, this.size, true);
    return new Blob([...this.parts, ...this.central, end], { type: 'application/zip' });
  }
}
