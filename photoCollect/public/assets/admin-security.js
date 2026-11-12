// 「安全與保存」分頁：更換上傳碼、立即刪除所有照片、自動刪除日期
import { h, mount, copyText, flashLabel, fmtDateTime, toast } from './admin-common.js';

export function renderSecurity(ctx, panel) {
  async function rotate() {
    const ok = await ctx.ask({
      title: '更換上傳碼', okLabel: '更換上傳碼', danger: true,
      body: '更換後，舊的上傳連結與已印出的 QR Code 會立刻失效，已經在上傳的人也會被擋下。確定要更換嗎？',
    });
    if (!ok) return;
    try {
      await ctx.api('/rotate-upload-code', { method: 'POST' });
      await ctx.refresh();
      toast('已更換上傳碼，請重發公告與 QR Code');
    } catch (e) { toast(`更換失敗：${e.message}`, 'err'); }
  }
  async function purge() {
    const ok = await ctx.ask({
      title: '立即刪除所有照片', okLabel: '永久刪除', danger: true, requireText: '刪除',
      body: '會刪除雲端上這場活動的全部照片與縮圖，無法復原，上傳頁也會變成「已封存」。請先確認製作者已經同步完成。',
    });
    if (!ok) return;
    try {
      const r = await ctx.api('/purge', { method: 'POST', body: { confirm: '刪除' } });
      await ctx.refresh();
      toast(`已刪除 ${r.deleted ?? 0} 張照片`);
    } catch (e) { toast(`刪除失敗：${e.message}`, 'err'); }
  }

  function draw() {
    const d = ctx.data;
    const url = ctx.uploadUrl();
    const purged = d.stage === 'purged' || !!ctx.cfg.deleted_at;
    const copy = h('button', { type: 'button', class: 'btn', text: '複製', onclick: async () => {
      if (await copyText(url)) flashLabel(copy, '已複製'); else toast('無法複製', 'err');
    } });
    const own = ctx.isOwner;   // 只有建立者（或用管理碼開啟）能更換上傳碼、刪除全部照片
    const lock = h('div', { class: 'ac-lock', text: '只有建立者可以操作。' });
    mount(panel,
      h('section', { class: 'card stack', 'aria-labelledby': 'keep-h' },
        h('h2', { id: 'keep-h', class: 'h2', text: '保存與自動刪除' }),
        purged
          ? h('div', { class: 'note', text: `照片已於 ${fmtDateTime(ctx.cfg.deleted_at)} 刪除，這場活動已封存。` })
          : d.delete_at
            ? h('div', { class: 'note' }, '照片會在 ', h('b', { text: fmtDateTime(d.delete_at) }), ' 自動刪除（截止時間加上保存天數）。可在「準備中心 → 上傳設定與告知」調整。')
            : h('div', { class: 'warn', text: '還沒有設定截止時間，照片不會自動刪除。請到「準備中心 → 上傳設定與告知」設定截止時間，或用下方按鈕手動刪除。' })),
      h('section', { class: 'card stack', 'aria-labelledby': 'rot-h' },
        h('h2', { id: 'rot-h', class: 'h2', text: '更換上傳碼' }),
        h('div', { class: 'muted', text: '上傳連結外流或被亂傳時，更換上傳碼後舊連結立即失效，記得重發公告與 QR Code。' }),
        h('div', { class: 'row' }, h('input', { class: 'input link-input', readonly: true, value: url, 'aria-label': '目前的上傳連結' }), copy),
        own ? h('div', {}, h('button', { type: 'button', class: 'btn', text: '更換上傳碼', onclick: rotate })) : lock.cloneNode(true)),
      h('section', { class: 'card stack', 'aria-labelledby': 'del-h' },
        h('h2', { id: 'del-h', class: 'h2', text: '立即刪除所有照片' }),
        h('div', { class: 'muted', text: '活動結束、製作者也同步完成後，可以不等到期日，直接把雲端照片全部刪除。刪除後無法復原。' }),
        own ? h('div', {}, h('button', { type: 'button', class: 'btn btn-danger', text: '立即刪除所有照片', disabled: purged, onclick: purge })) : lock));
  }
  // 自動更新時只在相關資料改變才重繪，避免收合中的預覽與焦點被重設
  let last = '';
  ctx.on((d, src) => {
    const sig = [ctx.data.stage, ctx.data.delete_at, ctx.cfg.deleted_at, ctx.cfg.upload_code, ctx.isOwner].join('|');
    if (src === 'refresh' && sig === last) return;
    last = sig;
    draw();
  });
}
