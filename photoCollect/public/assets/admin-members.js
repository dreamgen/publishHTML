// 「共同管理」分頁：列出擁有者與成員、新增／改角色／移除（只有擁有者或用管理碼開啟時可編輯）
// 所有伺服器資料一律以 textContent 寫入。
import { h, mount, copyText, flashLabel, fmtDateTime, toast } from './admin-common.js';

const ROLE_LABEL = { manager: '管理者', viewer: '檢視者' };

/** §8.6 權限表：[動作, 擁有者, 管理者, 檢視者] */
const PERMS = [
  ['讀取活動、進度、縮圖、照片清單', true, true, true],
  ['修改設定、排除照片、上傳預覽卡、產生／重發同步金鑰', true, true, false],
  ['看到同步金鑰明碼', true, true, false],
  ['更換上傳碼、刪除所有照片', true, false, false],
  ['管理成員（新增、改角色、移除）', true, false, false],
];

function yesNo(ok) {
  return h('td', { class: 'c' },
    h('span', { class: ok ? 'ac-yes' : 'ac-no', 'aria-hidden': 'true', text: ok ? '✓' : '—' }),
    h('span', { class: 'visually-hidden', text: ok ? '可以' : '不行' }));
}

export function renderMembers(ctx, panel) {
  let data = null;        // { owner:{email}|null, members:[...] }
  let loadErr = '';
  let loaded = false;
  const editable = () => ctx.isOwner;

  async function load() {
    try {
      data = await ctx.api('/members');
      loadErr = '';
    } catch (e) {
      loadErr = e.status === 403 ? '你沒有權限查看成員名單' : (e.message || '讀取失敗');
    }
    loaded = true;
    draw();
  }

  async function setRole(email, role, sel, prev) {
    sel.disabled = true;
    try {
      data = await ctx.api('/members', { method: 'POST', body: { email, role } });
      toast(`已改為${ROLE_LABEL[role]}`);
    } catch (e) {
      sel.value = prev;
      toast(`變更失敗：${e.message}`, 'err');
    }
    draw();
  }

  async function remove(email) {
    const ok = await ctx.ask({
      title: '移除成員', okLabel: '移除', danger: true,
      body: `要移除「${email}」嗎？對方會立刻失去這個活動的權限，「別人分享給我的」也不會再出現。`,
    });
    if (!ok) return;
    try {
      await ctx.api(`/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
      toast('已移除');
      await load();
    } catch (e) {
      toast(`移除失敗：${e.message}`, 'err');
    }
  }

  function memberRow(m) {
    const cells = [h('td', { class: 'em', text: m.email })];
    if (editable()) {
      const sel = h('select', { class: 'select', 'aria-label': `${m.email} 的角色` },
        h('option', { value: 'manager', text: ROLE_LABEL.manager }),
        h('option', { value: 'viewer', text: ROLE_LABEL.viewer }));
      sel.value = m.role;
      sel.addEventListener('change', () => setRole(m.email, sel.value, sel, m.role));
      cells.push(h('td', {}, sel));
    } else {
      cells.push(h('td', {}, h('span', { class: m.role === 'manager' ? 'tag tag-role' : 'tag tag-viewer', text: ROLE_LABEL[m.role] || m.role })));
    }
    cells.push(h('td', { class: 'em', text: m.added_by || '' }), h('td', { text: fmtDateTime(m.added_at) }));
    cells.push(h('td', {}, editable()
      ? h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `移除 ${m.email}`, text: '移除', onclick: () => remove(m.email) })
      : null));
    return h('tr', {}, cells);
  }

  function addForm() {
    const email = h('input', { class: 'input', type: 'email', id: 'mem-email', placeholder: 'name@gmail.com', autocomplete: 'off', maxlength: '254' });
    const role = h('select', { class: 'select', id: 'mem-role', 'aria-label': '角色' },
      h('option', { value: 'manager', text: '管理者' }),
      h('option', { value: 'viewer', text: '檢視者' }));
    const err = h('div', { class: 'form-err', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary', text: '新增成員' });
    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'ac-add' },
        h('label', { class: 'field', for: 'mem-email' }, 'Google Email', email),
        h('label', { class: 'field', for: 'mem-role' }, '角色', role),
        btn),
      err);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      const v = email.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { err.textContent = '請輸入正確的 Email'; err.hidden = false; email.focus(); return; }
      btn.disabled = true;
      try {
        data = await ctx.api('/members', { method: 'POST', body: { email: v, role: role.value } });
        toast(`已新增 ${v}（${ROLE_LABEL[role.value]}）`);
        draw();
      } catch (e) {
        err.textContent = e.status === 400 ? '無法新增：Email 格式不正確、是建立者本人，或成員已達 20 位上限' : e.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
    return form;
  }

  function draw() {
    if (!loaded) { mount(panel, h('div', { class: 'muted', text: '讀取成員名單中…' })); return; }
    const adminUrl = `${location.origin}/admin#e=${ctx.id}`;
    const copy = h('button', { type: 'button', class: 'btn', text: '複製管理頁連結' });
    copy.addEventListener('click', async () => {
      if (await copyText(adminUrl)) flashLabel(copy, '已複製'); else toast('無法複製，請手動選取', 'err');
    });
    const members = data?.members || [];
    const owner = data?.owner;

    const ownerRow = h('tr', {},
      h('td', { class: 'em', text: owner?.email || '（尚未綁定 Google 帳號）' }),
      h('td', {}, h('span', { class: 'tag tag-ok', text: '建立者' })),
      h('td', { text: '—' }), h('td', { text: '—' }), h('td'));

    mount(panel,
      h('section', { class: 'card stack', 'aria-labelledby': 'mem-h' },
        h('h2', { id: 'mem-h', class: 'h2', text: '共同管理' }),
        h('div', { class: 'lead', style: 'margin:0', text: '對方用這個 Email 登入 Google 後，會在『別人分享給我的』看到這個活動。' }),
        editable() ? null : h('div', { class: 'ac-lock', text: '只有建立者可以新增、修改或移除成員，你目前只能查看名單。' }),
        loadErr ? h('div', { class: 'form-err', role: 'alert', text: loadErr }) : null,
        owner ? null : h('div', { class: 'note', text: '這個活動還沒有綁定 Google 帳號（用管理連結開啟的舊活動）。可以先加入成員；也建議用頁面上方的按鈕，把活動加入你自己的 Google 帳號。' }),
        h('div', { class: 'ac-table-wrap' },
          h('table', { class: 'ac-table' },
            h('thead', {}, h('tr', {}, ['Email', '角色', '加入者', '加入時間', ''].map((t) => h('th', { scope: 'col', text: t })))),
            h('tbody', {}, ownerRow, members.map(memberRow)))),
        members.length ? null : h('div', { class: 'muted small', text: '還沒有共同管理的成員。' }),
        editable() ? addForm() : null),
      h('section', { class: 'card stack', 'aria-labelledby': 'perm-h' },
        h('h2', { id: 'perm-h', class: 'h2', text: '各角色可以做什麼' }),
        h('div', { class: 'ac-table-wrap' },
          h('table', { class: 'ac-table ac-perm' },
            h('thead', {}, h('tr', {},
              h('th', { scope: 'col', text: '動作' }),
              ['建立者', '管理者', '檢視者'].map((t) => h('th', { scope: 'col', class: 'c', text: t })))),
            h('tbody', {}, PERMS.map(([act, o, m, v]) => h('tr', {}, h('td', { text: act }), yesNo(o), yesNo(m), yesNo(v)))))),
        h('div', { class: 'muted small', text: '建立者是建立活動（或把活動加入自己帳號）的人。用管理連結開啟的人，權限等同建立者。' })),
      h('section', { class: 'card stack', 'aria-labelledby': 'lnk-h' },
        h('h2', { id: 'lnk-h', class: 'h2', text: '管理頁連結' }),
        h('div', { class: 'muted', text: '這個連結不含管理碼，只有已登入且在名單內的人打得開，可以放心傳給共同管理的人。' }),
        h('div', { class: 'ac-copy-row' },
          h('input', { class: 'input link-input', readonly: true, value: adminUrl, 'aria-label': '管理頁連結' }), copy)));
  }

  // 角色改變（例如被改成檢視者）時重畫；名單本身在切到此分頁時重新讀取
  let lastEd = null;
  ctx.on(() => {
    const ed = editable();
    if (loaded && lastEd !== null && ed !== lastEd) draw();   // 只在可編輯與否改變時重畫，避免蓋掉輸入中的 Email
    lastEd = ed;
  });
  draw();
  return { load };
}
