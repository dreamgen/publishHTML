// 臥底卡抽法選擇（儀表板與離線手機共用）
// 實體抽（預設）：學員實體抽卡，綁定座位時掃到哪張臥底就是哪張。
// 儀表板抽：事先隨機抽定臥底角色，綁定時只接受抽中的臥底卡。不分破壞型／干擾型，不控制比例。
import { h } from './ui.js';
import { ROLE, SPIES, composition, drawSpies } from './rules.js';

/** st: { draw: 'physical'|'dashboard', spies: [] }，會直接修改 st；onChange 用來重畫 */
export function spyPicker(size, st, onChange, drawLabel = '儀表板抽') {
  const c = composition(size);
  if (st.draw === 'dashboard' && (!st.spies || st.spies.length !== c.spies)) st.spies = drawSpies(size);
  const modeBtn = (val, label) => h('button', {
    class: 'btn', 'aria-pressed': String(st.draw === val), type: 'button',
    onclick: () => { st.draw = val; if (val === 'dashboard') st.spies = drawSpies(size); onChange(); },
  }, label);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, `臥底 ${c.spies} 位・抽法`), modeBtn('physical', '實體抽（預設）'), modeBtn('dashboard', drawLabel)),
    st.draw === 'physical'
      ? h('p', { class: 'note' }, `請從 6 張臥底卡中由學員實體抽出 ${c.spies} 張；綁定座位時掃到哪張臥底就是哪張。不分破壞型與干擾型。`)
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { class: 'grid g2' }, st.spies.map((id, k) => h('label', { class: 'field' }, `臥底 ${k + 1}`,
          h('select', { onchange: (e) => { st.spies[k] = e.target.value; } }, SPIES.map((s) => h('option', { value: s, selected: s === id }, ROLE[s].name)))))),
        h('button', { class: 'btn', type: 'button', onclick: () => { st.spies = drawSpies(size); onChange(); } }, '重新抽選臥底'),
        h('p', { class: 'muted tiny' }, '從 6 種臥底隨機抽出，不區分破壞型與干擾型、不控制比例。綁定時只接受抽中的臥底卡。')));
}
