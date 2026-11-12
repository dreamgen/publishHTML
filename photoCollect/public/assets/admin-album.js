// 「相簿與票選」分頁：開放參與者相簿、設定、分享連結、不想入鏡通知、票選結果與 MV 優先
import {
  h, mount, copyText, flashLabel, fmtDateTime, isoToLocalInput, localInputToIso, toast,
} from './admin-common.js';
import { qrSvgNode } from './admin-setup.js';

export function renderAlbum(ctx, panel) {
  let A = null; // GET /album 結果
  let seg = '全部';
  let loading = false;
  let form = null; // 設定表單暫存（未儲存）
  const thumbs = new Map();
  let pickPhotos = null; // source=picked 時的全部照片清單
  let pickCursor = null;

  // ---- 縮圖（帶授權 → blob URL） ----
  function thumb(hash, cls = 'rk-img') {
    const slot = h('div', { class: cls });
    const put = (url) => { slot.replaceChildren(url ? Object.assign(h('img', { alt: '' }), { src: url }) : h('span', { class: 'nopv', text: '無預覽' })); };
    if (thumbs.has(hash)) put(thumbs.get(hash));
    else {
      ctx.api(`/thumb/${hash}`, { raw: true })
        .then(async (r) => { const u = URL.createObjectURL(await r.blob()); thumbs.set(hash, u); put(u); })
        .catch(() => { thumbs.set(hash, null); put(null); });
    }
    return slot;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      A = await ctx.api('/album');
      if (!form) form = fromAlbum(A.album);
      draw();
    } catch (e) {
      mount(panel, h('div', { class: 'card warn', text: `讀取相簿資料失敗：${e.message}` }));
    } finally { loading = false; }
  }
  const fromAlbum = (a) => ({
    source: a.source, access: a.access, limit: a.limit, show_votes: a.show_votes,
    closes_at: isoToLocalInput(a.closes_at), allow_download: a.allow_download, password: '', has_password: a.has_password,
  });

  async function save(extra = {}) {
    const body = {
      source: form.source, access: form.access, limit: Number(form.limit), show_votes: form.show_votes,
      closes_at: localInputToIso(form.closes_at), allow_download: form.allow_download, ...extra,
    };
    if (form.password) body.password = form.password;
    if (body.access === 'password' && !form.password && !form.has_password) { toast('請設定相簿密碼', 'err'); return false; }
    try {
      await ctx.patch({ album: body }, { quiet: true });
      form = null;
      toast('已儲存相簿設定');
      await load();
      return true;
    } catch { return false; }
  }

  async function toggleOpen() {
    const on = !A.album.enabled;
    if (on) {
      const ok = await ctx.ask({
        title: '開放參與者相簿',
        body: '拿到相簿連結的人可以看到相簿裡所有照片（不含已排除的），並選出最佳照片。上傳連結與相簿連結是分開的。確定開放嗎？',
        okLabel: '開放相簿',
      });
      if (!ok) return;
    }
    if (on && form) { await save({ enabled: true }); return; }
    try { await ctx.patch({ album: { enabled: on } }, { quiet: true }); toast(on ? '相簿已開放' : '相簿已關閉，連結暫時失效'); await load(); } catch { /* 已 toast */ }
  }

  function radios(name, opts, cur, onPick) {
    return h('div', { class: 'stack', role: 'radiogroup', style: 'gap:8px' }, ...opts.map(([v, label, hint]) => h('label', { class: 'al-opt' + (cur === v ? ' on' : '') },
      h('input', { type: 'radio', name, value: v, checked: cur === v, onchange: () => onPick(v) }),
      h('span', { class: 'stack', style: 'gap:2px' }, h('b', { text: label }), hint ? h('span', { class: 'muted small', text: hint }) : null))));
  }

  function settingsCard() {
    const a = A.album;
    const f = form;
    const dirty = JSON.stringify(f) !== JSON.stringify(fromAlbum(a));
    const redraw = () => draw();
    const toggle = h('button', { type: 'button', class: 'pill-toggle' + (a.enabled ? ' on' : ''), 'aria-pressed': String(a.enabled), onclick: toggleOpen },
      h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: a.enabled ? '相簿開放中' : '相簿未開放' }));
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: f.has_password ? '已設定（留空＝不變）' : '4–32 字', value: f.password, oninput: (e) => { f.password = e.target.value; } });
    return h('section', { class: 'card stack', 'aria-labelledby': 'al-set-h' },
      h('div', { class: 'sec-head' }, h('h2', { id: 'al-set-h', class: 'h2', text: '相簿設定' }), toggle),
      h('fieldset', { class: 'al-fs' }, h('legend', { text: '相簿放哪些照片' }),
        radios('al-src', [['all', '全部未排除的照片', '主辦者排除的、被回報不想入鏡的不會出現'], ['picked', '只放我挑過的照片', '在下方「挑選放進相簿的照片」逐張勾選']], f.source, (v) => { f.source = v; redraw(); })),
      h('fieldset', { class: 'al-fs' }, h('legend', { text: '誰可以看' }),
        radios('al-acc', [['link', '知道連結的人（預設）', '未登入者以「這支手機＋暱稱」識別；換瀏覽器可能重複投'], ['google', '需用 Google 登入', '可確保一人一份選票'], ['password', '需輸入相簿密碼', '密碼另外在群組公布']], f.access, (v) => { f.access = v; redraw(); }),
        f.access === 'password' ? h('label', { class: 'field', style: 'margin-top:8px' }, '相簿密碼', pw) : null),
      h('label', { class: 'field' }, h('span', {}, '每人可選幾張 ', h('span', { class: 'muted small', text: '預設 10；攝影者選自己的作品不受此限，結果分開標示' })),
        h('input', { class: 'input', type: 'number', min: '1', max: '50', value: String(f.limit), style: 'max-width:120px', oninput: (e) => { f.limit = e.target.value; } })),
      h('fieldset', { class: 'al-fs' }, h('legend', { text: '參與者看得到票數嗎' }),
        h('div', { class: 'chips' }, ...[['live', '隨時顯示'], ['after', '截止後顯示'], ['never', '不顯示']].map(([v, l]) => h('button', {
          type: 'button', class: 'chip', 'aria-pressed': String(f.show_votes === v), onclick: () => { f.show_votes = v; redraw(); },
        }, l))),
        h('div', { class: 'muted small', text: '截止前隱藏票數，比較不會跟風。' })),
      h('label', { class: 'field' }, '票選截止（留空＝不截止）',
        h('input', { class: 'input', type: 'datetime-local', value: f.closes_at, style: 'max-width:260px', oninput: (e) => { f.closes_at = e.target.value; } })),
      h('label', { class: 'al-check' }, h('input', { type: 'checkbox', checked: f.allow_download, onchange: (e) => { f.allow_download = e.target.checked; } }),
        h('span', { class: 'stack', style: 'gap:2px' }, h('b', { text: '允許下載原檔' }), h('span', { class: 'muted small', text: '預設關閉' }))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-primary', text: '儲存相簿設定', onclick: () => save() }),
        dirty ? h('button', { type: 'button', class: 'btn', text: '還原', onclick: () => { form = fromAlbum(a); draw(); } }) : null));
  }

  function shareCard() {
    if (!A.album_url) {
      return h('section', { class: 'card stack' }, h('h2', { class: 'h2', text: '分享相簿' }),
        h('div', { class: 'muted', text: '開放相簿後會產生專屬的相簿連結；只拿到上傳連結的人看不到相簿。' }));
    }
    const url = new URL(A.album_url, location.origin).href;
    const copy = h('button', { type: 'button', class: 'btn btn-primary', text: '複製', onclick: async () => { if (await copyText(url)) flashLabel(copy, '已複製'); else toast('無法複製', 'err'); } });
    const qr = h('div', { class: 'qr-box', style: 'width:120px;height:120px' });
    try { qr.append(qrSvgNode(url, '相簿 QR Code')); } catch { qr.textContent = 'QR Code 產生失敗'; }
    const rotate = async () => {
      const ok = await ctx.ask({ title: '重設相簿連結', body: '舊的相簿連結會立即失效，已分享出去的連結需要重新發送。確定嗎？', okLabel: '重設', danger: true });
      if (!ok) return;
      try { await ctx.api('/album/code', { method: 'POST' }); toast('已重設相簿連結'); await load(); await ctx.refresh(); } catch (e) { toast(`重設失敗：${e.message}`, 'err'); }
    };
    return h('section', { class: 'card stack', 'aria-labelledby': 'al-share-h' },
      h('h2', { id: 'al-share-h', class: 'h2', text: '分享相簿' }),
      h('div', { class: 'muted small', text: '和上傳連結不同；只拿到上傳連結的人看不到相簿。' }),
      h('div', { class: 'row' }, h('input', { class: 'input link-input', readonly: true, value: url, 'aria-label': '相簿連結' }), copy),
      h('div', { class: 'qr-row' }, qr, h('div', { class: 'muted small', style: 'max-width:16em', text: A.album.enabled ? 'LINE 分享時會顯示活動預覽卡與「活動相簿」標題。' : '相簿目前未開放，連結暫時打不開。' })),
      ctx.canWrite ? h('button', { type: 'button', class: 'btn', style: 'color:var(--c-danger)', text: '重設相簿連結（舊連結立即失效）', onclick: rotate }) : null);
  }

  function optoutCard() {
    const list = A.optouts;
    if (!list.length) return null;
    const act = async (hash, action) => {
      try {
        await ctx.api('/album/optout', { method: 'POST', body: { hash, action } });
        toast(action === 'exclude' ? '已排除，同步時會略過' : '已恢復顯示');
        await load();
        await ctx.refresh();
      } catch (e) { toast(`操作失敗：${e.message}`, 'err'); }
    };
    return h('section', { class: 'card stack warn-card', 'aria-labelledby': 'al-opt-h' },
      h('h2', { id: 'al-opt-h', class: 'h2', text: `「我不想入鏡」通知 · ${list.length} 件待處理` }),
      ...list.map((o) => h('div', { class: 'al-optrow' },
        thumb(o.hash, 'al-optimg'),
        h('div', { class: 'grow small', text: `${o.segment || '未分類'} · 攝影 ${o.uploader || '匿名'} · ${fmtDateTime(o.at)} 由「${o.name || '未具名'}」提出 · 目前已從相簿隱藏` }),
        h('button', { type: 'button', class: 'btn btn-danger btn-sm', text: '排除這張', onclick: () => act(o.hash, 'exclude') }),
        h('button', { type: 'button', class: 'btn btn-sm', text: '保留並恢復顯示', onclick: () => act(o.hash, 'keep') }))));
  }

  function rankingCard() {
    const segs = ['全部', ...new Set(A.ranking.map((r) => r.segment || '未分類'))];
    if (!segs.includes(seg)) seg = '全部';
    const rows = A.ranking.filter((r) => seg === '全部' || (r.segment || '未分類') === seg);
    const max = rows.reduce((m, r) => Math.max(m, r.votes), 0) || 1;
    const prio = async (hash, on) => {
      try { await ctx.api('/album/priority', { method: 'POST', body: { hashes: [hash], on } }); await load(); } catch (e) { toast(`操作失敗：${e.message}`, 'err'); }
    };
    const auto = async () => {
      try { const r = await ctx.api('/album/priority', { method: 'POST', body: { top_per_segment: 3 } }); toast(`已標記 ${r.added} 張為 MV 優先`); await load(); } catch (e) { toast(`操作失敗：${e.message}`, 'err'); }
    };
    return h('section', { class: 'card stack', 'aria-labelledby': 'al-rank-h' },
      h('div', { class: 'sec-head' }, h('h2', { id: 'al-rank-h', class: 'h2', text: '票選結果' }),
        h('div', { class: 'chips' }, ...segs.map((s) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(s === seg), onclick: () => { seg = s; draw(); } }, s)))),
      rows.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'al-table' },
        h('thead', {}, h('tr', {}, ...['名次', '照片', '環節 · 攝影', '票數', 'MV 優先'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, ...rows.map((r, i) => h('tr', {},
          h('td', { class: 'rk' + (i < 3 ? ' top' : ''), text: String(i + 1) }),
          h('td', {}, thumb(r.hash)),
          h('td', {}, h('div', { text: r.segment || '未分類', style: 'font-weight:500' }), h('div', { class: 'muted small', text: `${r.uploader || '匿名'}${r.exif_time ? ` · ${r.exif_time.slice(11, 16)}` : ''}` })),
          h('td', {}, h('div', { class: 'al-votes' },
            h('div', { class: 'meter', role: 'img', 'aria-label': `${r.votes} 票` }, h('span', { style: `width:${Math.round((r.votes / max) * 100)}%` })),
            h('b', { text: String(r.votes) }),
            r.self ? h('span', { class: 'al-self', text: `含自選 ${r.self}` }) : null)),
          h('td', {}, h('button', {
            type: 'button', class: 'chip', 'aria-pressed': String(r.priority), onclick: () => prio(r.hash, !r.priority),
          }, r.priority ? '已標 MV 優先' : '標為 MV 優先'))))))) : h('div', { class: 'muted', text: A.album.enabled ? '還沒有人投票。' : '開放相簿後，參與者選的最佳照片會依票數列在這裡。' }),
      h('div', { class: 'al-foot' },
        h('span', { class: 'small', text: `已標 ${A.mv_priority.length} 張為 MV 優先。MV Studio 同步時會收到標記，排程時優先放進對應段落。` }),
        ctx.canWrite && A.ranking.length ? h('button', { type: 'button', class: 'btn btn-primary', text: '每個環節前 3 名一鍵標記', onclick: auto }) : null));
  }

  async function loadPickPhotos(more = false) {
    try {
      const r = await ctx.api(`/photos${more && pickCursor ? `?cursor=${encodeURIComponent(pickCursor)}` : ''}`);
      pickPhotos = (more ? pickPhotos : []).concat((r.photos || []).filter((p) => !p.excluded));
      pickCursor = r.cursor;
      draw();
    } catch (e) { toast(`讀取照片失敗：${e.message}`, 'err'); }
  }

  function pickCard() {
    if (A.album.source !== 'picked') return null;
    if (!pickPhotos) { loadPickPhotos(); return h('section', { class: 'card', text: '讀取照片中…' }); }
    const picked = new Set(A.album_picked);
    const toggle = async (hash, on) => {
      try { await ctx.api('/album/pick', { method: 'POST', body: { hashes: [hash], on } }); await load(); } catch (e) { toast(`操作失敗：${e.message}`, 'err'); }
    };
    return h('section', { class: 'card stack', 'aria-labelledby': 'al-pick-h' },
      h('div', { class: 'sec-head' }, h('h2', { id: 'al-pick-h', class: 'h2', text: `挑選放進相簿的照片 · 已選 ${picked.size} 張` })),
      h('div', { class: 'photo-grid' }, ...pickPhotos.map((p) => h('div', { class: 'pcard' },
        h('div', { class: 'pthumb' }, p.has_thumb ? thumb(p.hash, 'pimg') : h('span', { class: 'nopv', text: '無預覽' })),
        h('div', { class: 'pmeta' }, h('div', { class: 'who', text: `${p.uploader || '匿名'} · ${p.segment || '未分類'}` }),
          h('button', { type: 'button', class: 'chip', 'aria-pressed': String(picked.has(p.hash)), onclick: () => toggle(p.hash, !picked.has(p.hash)) }, picked.has(p.hash) ? '已放進相簿' : '放進相簿'))))),
      pickCursor ? h('button', { type: 'button', class: 'btn', text: '載入更多', onclick: () => loadPickPhotos(true) }) : null);
  }

  function draw() {
    if (!A) return;
    const s = A.stats;
    const left = A.album.closes_at ? Math.ceil((Date.parse(A.album.closes_at) - Date.now()) / 86400000) : null;
    const kpi = (l, v, hint) => h('div', { class: 'card kpi' }, h('div', { class: 'l', text: l }), h('div', { class: 'v', text: v }), h('div', { class: 'hint', text: hint }));
    mount(panel,
      h('section', { class: 'kpis', 'aria-label': '票選總覽' },
        kpi('參與挑選', `${s.voters} 人`, `Google 登入 ${s.google_voters} 人、其餘以裝置＋暱稱識別`),
        kpi('已投出', `${s.total_votes} 票`, `其中攝影者自選 ${s.self_votes} 票（不計上限 ${A.album.limit}）`),
        kpi('相簿照片', `${s.photos_in_album} 張`, `未排除的 ${s.eligible} 張中，${s.hidden} 張被回報隱藏`),
        kpi('距離截止', left == null ? '未設定' : left > 0 ? `${left} 天` : '已截止', A.album.closes_at ? `截止時間 ${fmtDateTime(A.album.closes_at)}` : '可在相簿設定加上截止時間')),
      h('div', { class: 'cols' },
        h('div', { class: 'side' }, settingsCard(), shareCard()),
        h('div', { class: 'main' }, optoutCard(), rankingCard(), pickCard())));
  }

  return { load };
}
