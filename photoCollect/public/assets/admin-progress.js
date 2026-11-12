// 「即時進度」分頁：KPI、各環節 vs 需求、各小隊、最新上傳縮圖與排除
import { h, mount, fmtBytes, relTime, fmtDateTime, toast } from './admin-common.js';

const FREE_BYTES = 10 * 1024 ** 3; // 免費額度 10 GB

export function renderProgress(ctx, panel) {
  const thumbs = new Map();   // hash -> blob URL（null 代表載入失敗）
  const queue = [];
  let active = 0;
  let allMode = false;        // 是否在「查看全部」
  let allPhotos = [];
  let allCursor = null;
  let pending = false;        // 焦點在面板內時暫緩重繪
  let refocus = null;         // 操作後重繪，要把焦點還給哪張照片的按鈕
  let rotView = 'station';    // 輪站熱度表：依關卡／依時段

  // ---- 縮圖載入（帶 Bearer → blob URL；限制同時 6 個） ----
  function pump() {
    while (active < 6 && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => { active--; pump(); });
    }
  }
  function loadThumb(hash, slot) {
    if (thumbs.has(hash)) { show(slot, thumbs.get(hash)); return; }
    queue.push(async () => {
      try {
        const res = await ctx.api(`/thumb/${hash}`, { raw: true });
        const url = URL.createObjectURL(await res.blob());
        thumbs.set(hash, url);
        show(slot, url);
      } catch {
        thumbs.set(hash, null);
        show(slot, null);
      }
    });
    pump();
  }
  function show(slot, url) {
    if (!slot.isConnected) return;
    if (url) {
      const img = h('img', { alt: '照片縮圖', width: '320', height: '240' });
      img.src = url;
      slot.replaceChildren(img);
    } else {
      slot.replaceChildren(h('span', { class: 'nopv', text: '無預覽' }));
    }
  }
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => {
    for (const e of es) {
      if (e.isIntersecting) { io.unobserve(e.target); loadThumb(e.target.dataset.hash, e.target); }
    }
  }, { rootMargin: '200px' }) : null;

  // ---- 元件 ----
  function bar(label, pct, cls, note, noteCls, tickPct) {
    return h('div', { class: 'brow' },
      h('span', { class: 'lab', text: label }),
      h('div', { class: `meter ${cls}`, role: 'img', 'aria-label': `${label}：${note}` },
        h('span', { style: `width:${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%` }),
        tickPct != null ? h('i', { class: 'tick', style: `left:calc(${Math.min(100, tickPct)}% - 1px)` }) : null),
      h('span', { class: `note-r ${noteCls}`, text: note }));
  }

  function photoCard(p) {
    const wrap = h('div', { class: 'pthumb' });
    const slot = h('div', { class: 'pimg' }); // 縮圖或「無預覽」放這裡；排除標籤放外層，不被縮圖載入覆蓋
    wrap.append(slot);
    if (p.has_thumb) {
      slot.append(h('span', { class: 'nopv', text: '載入中…' }));
      slot.dataset.hash = p.hash;
      if (io) io.observe(slot); else loadThumb(p.hash, slot);
    } else {
      slot.append(h('span', { class: 'nopv', text: '無預覽' }));
    }
    if (p.excluded) wrap.append(h('span', { class: 'ex-badge', text: '已排除' }));
    const t = p.exif_time ? p.exif_time.slice(11, 16) : fmtDateTime(p.uploaded_at).slice(11);
    const who = [p.uploader || '匿名', (p.groups || []).join('、') || null, p.segment || '未分類', t].filter(Boolean).join(' · ');
    const btn = h('button', { type: 'button', 'data-hash': p.hash, class: `btn${p.excluded ? '' : ' dng'}`, text: p.excluded ? '取消排除' : '排除' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await ctx.api('/exclude', { method: 'POST', body: { hash: p.hash, excluded: !p.excluded } });
        p.excluded = !p.excluded;
        // 兩份清單（最新 24 張與全部）都同步
        for (const q of [...(ctx.data.stats.recent || []), ...allPhotos]) if (q.hash === p.hash) q.excluded = p.excluded;
        toast(p.excluded ? '已排除，同步時會略過' : '已取消排除');
        refocus = p.hash;
        btn.blur();
        await ctx.refresh();
      } catch (e) { toast(`操作失敗：${e.message}`, 'err'); btn.disabled = false; }
    });
    return h('div', { class: `pcard${p.excluded ? ' ex' : ''}` }, wrap, h('div', { class: 'pmeta' }, h('div', { class: 'who', text: who }), btn));
  }

  async function loadAll(more = false) {
    try {
      const r = await ctx.api(`/photos${more && allCursor ? `?cursor=${encodeURIComponent(allCursor)}` : ''}`);
      allPhotos = (more ? allPhotos : []).concat(r.photos || []);
      allPhotos.sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
      allCursor = r.cursor || null;
      allMode = true;
      draw();
    } catch (e) { toast(`載入失敗：${e.message}`, 'err'); }
  }

  // ---- 繪製 ----
  // ---- 輪站課程：每隊在每一關的照片（熱度表） ----
  function rotationSections(rots) {
    return rots.filter((r) => r.groups.length).map((r) => {
      const max = Math.max(1, ...r.counts.flat(), ...r.free);
      const hasBye = r.rows.some((row) => row.includes(-1));
      const showFree = hasBye && r.bye_mode === 'free';
      const low = [];
      const cell = (n, label, idx) => {
        const td = h('td', { text: label });
        if (n <= 1) { td.className = 'low'; return td; }
        const a = n / max;
        td.style.background = `rgba(14,111,106,${(0.08 + a * 0.62).toFixed(2)})`;
        td.style.color = a > 0.55 ? '#fff' : '#0A5551';
        void idx;
        return td;
      };
      const byStation = rotView === 'station';
      const heads = byStation
        ? [...r.stations.map((s) => h('th', { scope: 'col' }, h('b', { text: s.name }), s.place ? [h('br'), s.place] : null)), showFree ? h('th', { scope: 'col' }, h('b', { text: '自由活動' }), h('br'), '輪空時段') : null]
        : r.slots.map((s, i) => h('th', { scope: 'col' }, h('b', { text: `${r.days && r.days.length > 1 && s.day ? `第${s.day}天 ` : ''}第 ${i + 1} 段` }), h('br'), `${s.start}–${s.end}`));
      const body = r.groups.map((g, gi) => {
        let sum = 0;
        const tds = [];
        if (byStation) {
          r.stations.forEach((s, si) => {
            const n = r.counts[gi][si];
            sum += n;
            if (n <= 1) {
              const t = r.rows[gi].indexOf(si);
              low.push(`${g}在「${s.name}」${n} 張${t >= 0 ? `（第 ${t + 1} 段 ${r.slots[t].start}–${r.slots[t].end}）` : ''}`);
            }
            tds.push(cell(n, String(n)));
          });
          if (showFree) { sum += r.free[gi]; tds.push(h('td', { class: 'bye', text: String(r.free[gi]) })); }
        } else {
          r.rows[gi].forEach((si) => {
            if (si < 0) { tds.push(h('td', { class: 'bye', text: showFree ? `輪空 · ${r.free[gi]}` : '輪空' })); return; }
            const n = r.counts[gi][si];
            tds.push(cell(n, `${r.stations[si].name} · ${n}`));
          });
          sum = r.counts[gi].reduce((a, b) => a + b, 0) + (showFree ? r.free[gi] : 0);
        }
        return h('tr', {}, h('th', { scope: 'row', text: g }), tds, h('td', { class: 'sum', text: String(sum) }));
      });
      const views = h('div', { class: 'chips', role: 'group', 'aria-label': '切換檢視' }, [['station', '依關卡'], ['slot', '依時段']].map(([v, l]) => h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(rotView === v), onclick: () => { rotView = v; draw(); },
      }, l)));
      return h('section', { class: 'card stack', 'aria-labelledby': `rot-${r.id}-h` },
        h('div', { class: 'sec-head' },
          h('div', { class: 'stack', style: 'gap:2px' },
            h('h2', { id: `rot-${r.id}-h`, class: 'h2', text: `${r.title}：每隊在每一關的照片${r.day ? `（第${r.day}天）` : r.days && r.days.length > 1 ? `（第${r.days[0]}–${r.days[r.days.length - 1]}天）` : ''}` }),
            h('span', { class: 'small muted', text: '依「小隊＋時段」或攝影師選的關卡歸類；格子越深代表照片越多' })),
          views),
        h('div', { class: 'scroll-x' }, h('table', { class: 'rot-heat' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: byStation ? '小隊 ＼ 關卡' : '小隊 ＼ 時段' }), heads, h('th', { scope: 'col', text: '合計' }))),
          h('tbody', {}, body))),
        byStation && low.length ? h('div', { class: 'warn', role: 'status' }, h('b', { text: '補拍提醒：' }), low.slice(0, 6).join('；') + (low.length > 6 ? `；另有 ${low.length - 6} 格` : '') + '。可以請那個時段的帶隊老師補傳。') : null,
        r.pending || r.unknown_group ? h('div', { class: 'note' },
          r.pending ? [`另有 `, h('b', { text: `${r.pending} 張` }), '拍在輪站時段，但沒勾小隊也沒選關卡（或勾了多隊），暫時無法分到課程，MV Studio 同步後由 AI 看照片內容判斷。'] : null,
          r.unknown_group ? ` ${r.unknown_group} 張已選關卡但時間不在輪站時段，無法算出小隊。` : null) : null);
    });
  }

  function draw() {
    pending = false;
    const d = ctx.data, s = d.stats || {};
    const kpi = (l, v, hint) => h('div', { class: 'card kpi' }, h('div', { class: 'l', text: l }), h('div', { class: 'v', text: v }), h('div', { class: 'hint', text: hint }));
    const kpis = h('section', { class: 'kpis', 'aria-label': '總覽' },
      kpi('已收到照片', String(s.total ?? 0), '不含已排除的照片'),
      kpi('上傳人數', String(s.uploaders ?? 0), s.last_upload_at ? `最近一筆 ${relTime(s.last_upload_at)}` : '還沒有人上傳'),
      kpi('雲端用量', fmtBytes(s.bytes), `免費額度 10 GB（已用 ${(((s.bytes || 0) / FREE_BYTES) * 100).toFixed(1)}%）`),
      kpi('已排除', String(s.excluded_count ?? 0), '同步時略過'));

    // 各環節
    const segs = s.by_segment || [];
    const scale = Math.max(1, ...segs.map((x) => Math.max(x.have, x.target || 0)), s.unclassified || 0) * 1.15; // 留白讓需求黑線不貼在最右邊
    const segRows = segs.map((x) => {
      const t = x.target || 0;
      const ok = t === 0 || x.have >= t;
      const note = t === 0 ? `${x.have} 張` : ok ? `${x.have} 張 · 足夠` : `${x.have} / ${t} · 缺`;
      return bar(x.name, (x.have / scale) * 100, ok ? '' : 'low', note, ok ? 'ok' : 'low', t > 0 ? (t / scale) * 100 : null);
    });
    segRows.push(bar('未分類', ((s.unclassified || 0) / scale) * 100, '', `${s.unclassified || 0} 張`, '', null));
    const segSec = h('section', { class: 'card stack', 'aria-labelledby': 'seg-h' },
      h('div', { class: 'sec-head' }, h('h2', { id: 'seg-h', class: 'h2', text: '各環節照片 vs. MV 需求' }),
        h('span', { class: 'small muted', text: '黑線為需求張數；需求來自 MV Studio 的內容規劃，未同步前顯示拍攝清單目標' })),
      segs.length ? segRows : [h('div', { class: 'muted', text: '還沒有環節。到「準備中心」貼上活動流程表後，這裡會顯示各環節的照片數。' }), segRows.at(-1)]);

    // 各小隊
    const grps = s.by_group || [];
    const top = Math.max(0, ...grps.map((g) => g.have));
    const grpSec = h('section', { class: 'card stack', 'aria-labelledby': 'grp-h' },
      h('div', { class: 'sec-head' }, h('h2', { id: 'grp-h', class: 'h2', text: '各小隊入鏡張數' }),
        h('span', { class: 'small muted', text: '依上傳者勾選的小隊統計，差距大時請相關攝影師補拍' })),
      grps.length ? grps.map((g) => {
        const low = top > 0 && g.have < top * 0.4;
        return bar(g.name, top ? (g.have / top) * 100 : 0, `grp${low ? ' low' : ''}`, low ? `${g.have} 張 · 偏少` : `${g.have} 張`, low ? 'low' : '', null);
      }) : h('div', { class: 'muted', text: '還沒有設定小隊。' }));

    // 最新上傳
    const list = allMode ? allPhotos : (s.recent || []);
    const recSec = h('section', { class: 'card stack', 'aria-labelledby': 'recent-h' },
      h('div', { class: 'sec-head' },
        h('h2', { id: 'recent-h', class: 'h2', text: allMode ? `全部照片（已載入 ${allPhotos.length} 張）` : '最新上傳' }),
        h('span', { class: 'small muted', text: '有人不想入鏡時按「排除」，MV Studio 同步時會略過' })),
      list.length ? h('div', { class: 'photo-grid' }, list.map(photoCard)) : h('div', { class: 'muted', text: '還沒有照片。' }),
      h('div', { class: 'row' },
        allMode ? h('button', { type: 'button', class: 'btn', text: '收合，只看最新 24 張', onclick: () => { allMode = false; draw(); } })
          : h('button', { type: 'button', class: 'btn', text: `查看全部（${s.total ?? 0}${s.excluded_count ? ` + 已排除 ${s.excluded_count}` : ''} 張）`, onclick: () => loadAll(false) }),
        allMode && allCursor ? h('button', { type: 'button', class: 'btn', text: '載入更多', onclick: () => loadAll(true) }) : null,
        h('button', { type: 'button', class: 'btn', text: '立即重新整理', onclick: () => ctx.refresh().then(() => toast('已更新')).catch((e) => toast(e.message, 'err')) }),
        h('span', { class: 'small muted', text: '每 30 秒自動更新' })));

    mount(panel, kpis, segSec, ...rotationSections(s.rotations || []), grpSec, recSec);
    if (refocus) {
      const b = panel.querySelector(`button[data-hash="${refocus}"]`);
      refocus = null;
      if (b) b.focus();
    }
  }

  panel.addEventListener('focusout', () => {
    // 焦點離開後補上暫緩的重繪
    setTimeout(() => { if (pending && !panel.contains(document.activeElement)) draw(); }, 0);
  });
  ctx.on((d, src) => {
    if (src === 'refresh' && panel.contains(document.activeElement) && panel.hasChildNodes()) { pending = true; return; }
    draw();
  });
  void thumbs;
}
