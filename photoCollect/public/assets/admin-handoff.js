// 「交給 MV 製作者」分頁：同步金鑰、三份提示詞（A 安裝／B 製作／C 接續）
import { h, mount, copyText, flashLabel, toast } from './admin-common.js';
import { installPrompt, makePrompt, resumePrompt } from './prompts.js';

export function renderHandoff(ctx, panel) {
  let showKey = false;
  let syncUrl = '';          // 後端回傳的 sync_url（若有）

  const downloadUrl = () => `${location.origin}/download/`;
  const getSyncUrl = () => {
    if (syncUrl) { try { return new URL(syncUrl, location.origin).href; } catch { /* 用預設 */ } }
    return `${location.origin}/api/sync/${ctx.id}`;
  };
  const maskKey = (k) => '•'.repeat(Math.min(k.length, 24));

  async function makeKey(reissue) {
    if (reissue) {
      const ok = await ctx.ask({
        title: '撤銷並重發同步金鑰', danger: true, okLabel: '撤銷並重發',
        body: '舊的金鑰會立刻失效。已經把舊提示詞交給製作者的話，需要重新複製「製作提示詞」再給他。確定要重發嗎？',
      });
      if (!ok) return;
    }
    try {
      const r = await ctx.api('/sync-key', { method: 'POST' });
      syncUrl = r.sync_url || '';
      showKey = true;
      await ctx.refresh();
      toast(reissue ? '已重發同步金鑰' : '已產生同步金鑰');
    } catch (e) { toast(`失敗：${e.message}`, 'err'); }
  }

  function copyBtn(label, doneLabel, getText, cls = 'btn btn-big') {
    const b = h('button', { type: 'button', class: cls, text: label });
    b.addEventListener('click', async () => {
      const ok = await copyText(getText());
      if (ok) { flashLabel(b, doneLabel); toast('已複製，請貼給 AI'); } else toast('無法複製，請展開預覽手動選取', 'err');
    });
    return b;
  }

  function preview(title, text) {
    return h('details', { class: 'pv' }, h('summary', { text: title }), h('pre', { text }));
  }

  function draw() {
    // 檢視者看不到同步金鑰與提示詞（後端也不會回金鑰）
    if (!ctx.canWrite) {
      mount(panel, h('section', { class: 'card stack' },
        h('h2', { class: 'h2', text: '交給 MV 製作者' }),
        h('div', { class: 'ac-lock', text: '需要管理者權限。你目前是「檢視者」，請向建立者索取管理者權限，或請他把提示詞交給製作者。' })));
      return;
    }
    const c = ctx.cfg;
    const name = c.basic?.name || '';
    const key = c.sync?.key || '';

    const keySec = key
      ? [
        h('label', { class: 'field muted small', for: 'sync-key' }, '同步金鑰（只能下載，不能修改或刪除）'),
        h('div', { class: 'key-row' },
          h('input', { id: 'sync-key', class: 'input', readonly: true, value: showKey ? key : maskKey(key), 'aria-label': '同步金鑰' }),
          h('button', { type: 'button', class: 'btn', text: showKey ? '隱藏' : '顯示', 'aria-pressed': String(showKey), onclick: () => { showKey = !showKey; draw(); } })),
      ]
      : [
        h('div', { class: 'note', text: '還沒有同步金鑰。產生後，製作者的 AI 才能下載這場活動的照片。' }),
        h('div', {}, h('button', { type: 'button', class: 'btn btn-primary', text: '產生同步金鑰', onclick: () => makeKey(false) })),
      ];

    const pa = installPrompt({ downloadUrl: downloadUrl() });
    const pb = key ? makePrompt({ name, syncUrl: getSyncUrl(), key }) : '';
    const pbShown = key ? makePrompt({ name, syncUrl: getSyncUrl(), key: showKey ? key : maskKey(key) }) : '';
    const pc = resumePrompt({ name });

    const bBtn = copyBtn('複製製作提示詞（B）', '已複製，請貼給 AI', () => pb);
    bBtn.className = 'btn btn-primary btn-big';
    if (!key) { bBtn.disabled = true; bBtn.title = '請先產生同步金鑰'; }

    mount(panel,
      h('section', { class: 'card card-accent stack', 'aria-labelledby': 'mv-h' },
        h('h2', { id: 'mv-h', class: 'h2', text: '交給 MV 製作者' }),
        h('div', { class: 'lead', style: 'margin:0', text: '複製下面的提示詞，貼給製作者電腦上的 AI（Claude、Gemini 等）。AI 會用同步金鑰下載照片，並一步步帶著完成 MV。' }),
        keySec,
        h('div', { class: 'prompt-btns' },
          copyBtn('複製安裝提示詞（A）', '已複製，請貼給 AI', () => pa),
          bBtn),
        key ? null : h('div', { class: 'small muted', text: '製作提示詞包含同步金鑰，所以要先產生金鑰才能複製。' }),
        h('div', { class: 'row' },
          copyBtn('複製接續提示詞（C）', '已複製，請貼給 AI', () => pc, 'btn'),
          h('span', { class: 'small muted', text: '之前做到一半，要請 AI 接續時使用' }),
          key ? h('button', { type: 'button', class: 'btn-link-danger', text: '撤銷並重發金鑰', onclick: () => makeKey(true) }) : null),
        h('div', { class: 'warn', text: '製作提示詞內含同步金鑰，只能下載照片、不能修改或刪除，但請只傳給製作者本人，不要貼到公開的群組。' })),
      h('section', { class: 'stack', 'aria-label': '提示詞預覽' },
        h('h2', { class: 'h3', text: '提示詞預覽' }),
        preview('A　安裝提示詞（第一次使用，製作者電腦還沒裝 MV Studio）', pa),
        preview(`B　製作提示詞${key ? '' : '（需先產生同步金鑰）'}`, key ? pbShown : makePrompt({ name, syncUrl: getSyncUrl(), key: '（尚未產生）' })),
        preview('C　接續提示詞（做到一半，繼續下一步）', pc)));
  }

  // 自動更新時只在相關資料改變才重繪，避免收合中的預覽與焦點被重設
  let last = '';
  ctx.on((d, src) => {
    const sig = [ctx.cfg.sync?.key, ctx.cfg.basic?.name, ctx.id, ctx.canWrite].join('|');
    if (src === 'refresh' && sig === last) return;
    last = sig;
    draw();
  });
}
