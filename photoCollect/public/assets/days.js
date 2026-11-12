// 多日活動的顯示工具（上傳頁、我上傳的照片、相簿共用；與 admin-common.js 的同名函式一致）
const WD = '日一二三四五六';

/** 單日「2026/11/20」；多日「2026/11/20–11/22」 */
export function dateRangeText(b) {
  const s = b && b.date;
  if (!s) return '';
  const e = b.end_date && b.end_date > s ? b.end_date : null;
  const f = (d) => d.replace(/-/g, '/');
  if (!e) return f(s);
  return e.slice(0, 4) === s.slice(0, 4) ? `${f(s)}–${Number(e.slice(5, 7))}/${Number(e.slice(8, 10))}` : `${f(s)}–${f(e)}`;
}

/** 「第2天 11/21（六）」；沒有日期只回「第2天」 */
export function dayLabel(day, date) {
  const d = date ? new Date(date + 'T00:00:00Z') : null;
  return [`第${day}天`, d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）` : ''].filter(Boolean).join(' ');
}

/** 今天（使用者本地日期）YYYY-MM-DD */
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 依天分組：[{ day, date, label, today, items }]；單日活動回一組（day 0、label 空字串） */
export function groupByDay(segments) {
  const out = [];
  const today = todayStr();
  for (const s of segments || []) {
    const key = s.day || 0;
    let g = out.find((x) => x.day === key);
    if (!g) {
      g = { day: key, date: s.date || null, label: key ? dayLabel(key, s.date) : '', today: !!s.date && s.date === today, items: [] };
      out.push(g);
    }
    g.items.push(s);
  }
  return out;
}
