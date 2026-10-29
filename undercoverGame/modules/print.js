// 列印頁：信封 QR 貼紙（每套 13 張）與工作人員對照表（每套 13 列）。A、B 兩套各一頁。
import { h, qrImg, iconEl } from './ui.js';
import { connect } from './fb.js';
import { ROLE, KIND_LABEL, WHEN_LABEL, fmtNum, QR, roleWith } from './rules.js';

export async function mountPrint(app, parts) {
  const kind = parts[0] === 'map' ? 'map' : 'labels';
  let ev = null;
  try { ev = localStorage.getItem('ug.dash.ev'); } catch (e) { /* */ }
  if (!ev) throw new Error('請先在儀表板開啟活動');
  app.replaceChildren(h('p', { class: 'wrap muted' }, '讀取中…'));
  const fb = await connect();
  const snap = await fb.get(fb.evRef(ev, 'qr'));
  const q = snap.val();
  const ov = (await fb.get(fb.evRef(ev, 'overrides/roles'))).val() || {};
  if (!q) throw new Error('這個活動還沒有 QR 碼');
  const today = new Date().toLocaleDateString('zh-TW');
  const pages = ['A', 'B'].map((set) => (kind === 'labels' ? labelsPage(set, q, today) : mapPage(set, q, today, ov)));
  app.replaceChildren(
    h('div', { class: 'print-bar' },
      h('a', { class: 'btn', href: '#/dash' }, iconEl('back'), '回儀表板'),
      h('a', { class: 'btn', href: kind === 'labels' ? '#/print/map' : '#/print/labels' }, kind === 'labels' ? '改看對照表' : '改看貼紙'),
      h('button', { class: 'btn dark', onclick: () => window.print() }, iconEl('print'), '列印（A4）')),
    ...pages);
}

const sortedCodes = (map) => Object.keys(map).sort();

function labelsPage(set, q, today) {
  const map = q.sets[set];
  const cells = sortedCodes(map).map((code) => h('div', {},
    qrImg(QR.envelope(set, code, q.version), 104, `信封 QR 碼 ${code}`),
    h('span', { class: 'code' }, code),
    h('span', { class: 'tiny muted' }, `${set} 套・v${q.version}`)));
  cells.push(h('div', {}), h('div', {}));
  return h('section', { class: 'print-page' },
    h('div', { class: 'print-head' },
      h('div', {}, h('div', { class: 'eyebrow' }, '勿虛心假意・信封 QR 貼紙・全場固定'), h('h1', {}, `${set} 套　13 張`)),
      h('p', { class: 'tiny muted', style: { textAlign: 'right' } }, `QR 碼版本 v${q.version}・沿虛線剪下貼在信封正面`, h('br'), '貼紙不含任何角色資訊')),
    h('div', { class: 'labels' }, cells),
    h('div', { class: 'row between tiny muted', style: { marginTop: 'auto' } },
      h('span', {}, `依代號排序，與角色無關。裝填請對照同版本的「${set} 套對照表」。`), h('span', {}, `列印日期 ${today}`)));
}

function mapPage(set, q, today, ov) {
  const map = q.sets[set];
  const rows = sortedCodes(map).map((code) => {
    const r = roleWith(map[code], ov);
    return h('tr', {},
      h('td', { class: 'mono', style: { fontWeight: 700 } }, code), h('td', { style: { fontWeight: 700 } }, r.name), h('td', {}, KIND_LABEL[r.kind]),
      h('td', {}, WHEN_LABEL[r.id] || '依抽選'), h('td', {}, r.car),
      h('td', { class: 'num' }, fmtNum(r.money)), h('td', { class: 'num' }, r.leave), h('td', { class: 'num' }, r.power),
      h('td', {}), h('td', {}));
  });
  return h('section', { class: 'print-page' },
    h('div', { class: 'print-head' },
      h('div', {}, h('div', { class: 'eyebrow' }, `勿虛心假意・QR 碼與角色對照表・版本 v${q.version}`), h('h1', {}, `${set} 套　13 個角色全對照`)),
      h('span', { class: 'chip dark', style: { borderRadius: '6px' } }, '工作人員專用・勿讓學員看到')),
    h('p', { class: 'small' }, '整場活動固定使用這份對照；只有控場講師在活動前按「更新 QR 碼」才會重組，重組後本表與貼紙一律作廢。用途：① 裝填信封後由第二人核對打勾；② 每梯次依人數取出要用的信封；③ PWA 故障時人工判定。'),
    h('table', { class: 'map-table' },
      h('thead', {}, h('tr', {}, ...['代號', '角色', '陣營', '使用時機', '交通'].map((t) => h('th', {}, t)),
        ...['存款', '特休', '體力'].map((t) => h('th', { class: 'num' }, t)), h('th', { style: { width: '40px' } }, '裝填'), h('th', { style: { width: '40px' } }, '核對'))),
      h('tbody', {}, rows)),
    h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '16px', flexWrap: 'nowrap' } },
      h('div', { class: 'flex1 small', style: { lineHeight: 1.6 } },
        h('b', {}, '人工判定提醒　'),
        '隊上有陽奉陰違或表面工夫 → 失敗，原因「人」，不扣除（優先）；圖謀私利在隊上且任務要存款 → 存款照常分攤但全歸他，失敗原因「金額」；圖謀私利出不要存款的任務 → 原因「人」；否則依序比對存款、體力、特休、交通。成功時只扣存款與特休，3 人平均分攤，不足由持有最多者補。未用到的信封每梯次結束後放回本套。'),
      h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' } },
        qrImg(QR.map(q.version, set, map), 110, `${set} 套離線載入 QR 碼`), h('span', { class: 'tiny' }, '離線載入 QR 碼'))),
    h('div', { class: 'grid g2 small', style: { marginTop: 'auto' } },
      h('span', { style: { borderBottom: '1px solid var(--ink)', paddingBottom: '6px' } }, '裝填人：'),
      h('span', { style: { borderBottom: '1px solid var(--ink)', paddingBottom: '6px' } }, `核對人：　　　　　　　　列印 ${today}`)));
}
