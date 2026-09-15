/* Versioned presentation data. QR payloads are never derived from display fields. */
(function (root) {
  'use strict';
  const presets = [
    ['靛藍商務', '#172554', '#4338ca'], ['翡翠典雅', '#064e3b', '#0d9488'],
    ['暖金禮賓', '#78350f', '#b45309'], ['莓紫雅緻', '#581c87', '#be185d']
  ];
  const defaultFields = () => ['姓名', '班級名稱', '學號'].map((label, i) => ({key: ['name','class','number'][i], label, mode: 'default', value: '', sourceId: '', sourceKey: ['name','class','number'][i]}));
  const design = () => ({layout: 'classic', theme: '0', background: 'gradient', color1: presets[0][1], color2: presets[0][2], rotate: false});
  const color = (v, fallback) => /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  function normalize(rows) {
    if (!Array.isArray(rows)) return [];
    const ids = new Set();
    return rows.filter(b => b && typeof b.id === 'string' && /^[\w-]{1,100}$/.test(b.id) && !ids.has(b.id) && ids.add(b.id) && typeof b.name === 'string' && typeof b.content === 'string' && b.content).map(b => {
      const d = {...design(), ...b.design};
      d.layout = ['classic','split','minimal'].includes(d.layout) ? d.layout : 'classic';
      d.theme = ['0','1','2','3','custom'].includes(d.theme) ? d.theme : '0';
      d.background = d.background === 'solid' ? 'solid' : 'gradient';
      d.color1 = color(d.color1, presets[0][1]); d.color2 = color(d.color2, presets[0][2]);
      d.rotate = d.rotate === true;
      const seen = new Set();
      const fields = Array.isArray(b.fields) ? b.fields.slice(0,20).filter(f => f && typeof f.key === 'string' && !seen.has(f.key) && seen.add(f.key)).map(f => ({key:f.key, label:String(f.label || '').slice(0,40), value:String(f.value || '').slice(0,200), mode:['own','default','reference'].includes(f.mode)?f.mode:'own',sourceId:String(f.sourceId || ''),sourceKey:String(f.sourceKey || f.key)})) : defaultFields();
      return {id:b.id,name:b.name.slice(0,100),content:b.content,color:color(b.color,'#4338ca'),createdAt:b.createdAt || Date.now(),isDefault:!!b.isDefault,fields,design:d};
    });
  }
  function resolve(badges, badge, key, visited = new Set()) {
    const token = JSON.stringify([badge.id,key]);
    if (visited.has(token)) return {value:'',error:'循環引用，請改為自行輸入'};
    const f = badge.fields.find(f => f.key === key);
    if (!f) return {value:'',error:'來源欄位已移除'};
    if (f.mode === 'own') return {value:f.value};
    const source = f.mode === 'default' ? badges.find(b => b.isDefault) || badges[0] : badges.find(b => b.id === f.sourceId);
    if (f.mode === 'default' && source?.id === badge.id) return {value:f.value};
    if (!source) return {value:f.value,error:'來源名牌不存在'};
    visited.add(token);
    return resolve(badges,source,f.sourceKey || key,visited);
  }
  function detachReferences(badges,id) {
    const source = badges.find(b => b.isDefault) || badges[0];
    for (const b of badges) for (const f of b.fields) {
      if (b.id !== id && ((f.mode === 'reference' && f.sourceId === id) || (f.mode === 'default' && source?.id === id))) {
        const result = resolve(badges,b,f.key); f.value = result.value; f.mode = 'own';
      }
    }
  }
  root.BadgeDesign = {presets,defaultFields,design,normalize,resolve,detachReferences};
})(typeof window === 'undefined' ? globalThis : window);
