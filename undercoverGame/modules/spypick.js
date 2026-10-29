// 虛偽大人卡抽法選擇（儀表板與離線手機共用）
// 實體抽（預設）：學員實體抽卡，綁定座位時掃到哪張虛偽大人就是哪張。
// 自動抽角色（無實體卡片，儀表板用）：系統抽虛偽大人（可手動改）並隨機排座位，玩家用手機領角色卡。
// 手機抽（離線手機用）：事先抽定虛偽大人角色，綁定時只接受抽中的虛偽大人卡。
// 兩者都不控制破壞型／干擾型比例，但每組至少 1 位破壞型。
import { h } from './ui.js';
import { ROLE, SPIES, composition, drawSpies } from './rules.js';

/**
 * st: { draw: 'physical'|'auto'|'dashboard', spies: [] }，會直接修改 st；onChange 用來重畫
 * alt：第二種抽法的代碼（儀表板 'auto'，離線手機 'dashboard'）
 */
export function spyPicker(size, st, onChange, alt = 'auto') {
  const c = composition(size);
  const label = alt === 'auto' ? '自動抽角色（無實體卡片）' : '手機抽';
  if (st.draw === alt && (!st.spies || st.spies.length !== c.spies)) st.spies = drawSpies(size);
  const modeBtn = (val, text) => h('button', {
    class: 'btn', 'aria-pressed': String(st.draw === val), type: 'button',
    onclick: () => { st.draw = val; if (val === alt) st.spies = drawSpies(size); onChange(); },
  }, text);
  const hint = alt === 'auto'
    ? '不用印信封、不用掃碼綁定。建立後系統把全部角色隨機排到 1～N 號座位；玩家用手機領角色卡，全組領完由控場開放查看。可手動改虛偽大人，不控制比例，但至少 1 位破壞型。'
    : '從 6 種虛偽大人隨機抽出，不控制比例，但至少 1 位破壞型。綁定時只接受抽中的虛偽大人卡。';
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, `虛偽大人 ${c.spies} 位・抽法`), modeBtn('physical', '實體抽（預設）'), modeBtn(alt, label)),
    st.draw === 'physical'
      ? h('p', { class: 'note' }, `請從 6 張虛偽大人卡中由學員實體抽出 ${c.spies} 張；綁定座位時掃到哪張虛偽大人就是哪張。不控制比例，但至少要有 1 張破壞型（綁定時系統會檢查）。`)
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { class: 'grid g2' }, st.spies.map((id, k) => h('label', { class: 'field' }, `虛偽大人 ${k + 1}`,
          h('select', { onchange: (e) => { st.spies[k] = e.target.value; onChange(); } }, SPIES.map((s) => h('option', { value: s, selected: s === id }, ROLE[s].name)))))),
        h('button', { class: 'btn', type: 'button', onclick: () => { st.spies = drawSpies(size); onChange(); } }, '重新抽虛偽大人'),
        h('p', { class: 'muted tiny' }, hint)));
}
