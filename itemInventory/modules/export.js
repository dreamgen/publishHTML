/**
 * 匯出與標籤工具：CSV 報表、JSON 完整備份（含照片）、狀態中文對照
 */
import { loadItemImage } from './store.js';

export const DECISION_META = {
  pending: { label: '待議', short: '待議', cls: 'badge-pending', icon: '⏳' },
  keep: { label: '續留', short: '續留', cls: 'badge-keep', icon: '✅' },
  discard: { label: '丟棄', short: '丟棄', cls: 'badge-discard', icon: '🗑️' },
  other: { label: '其它處理', short: '其它', cls: 'badge-other', icon: '🔄' },
};

export const SUGGESTION_LABELS = {
  none: '無初步建議',
  keep: '建議續留',
  discard: '建議丟棄',
  other: '建議其它處理',
};

export const OTHER_QUICK_TAGS = [
  '轉贈他人／社福',
  '二手拍賣',
  '維修後再議',
  '移交其他單位',
  '資源回收變賣',
];

function csvCell(val) {
  const s = String(val ?? '').replace(/\r?\n/g, ' ');
  if (/[",]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 匯出 CSV（Excel 可直接開啟不亂碼）
 */
export function exportCsv(session, items) {
  const headers = [
    '序號', '組別', '物品名稱', '數量', '單位', '存放位置',
    '現場備註', '盤點建議', '最終決議', '處理方式／去向說明',
    '負責人', '盤點人', '盤點時間', '決議時間',
  ];
  const rows = [headers.map(csvCell).join(',')];

  items.forEach((it, idx) => {
    const dec = DECISION_META[it.decision] || DECISION_META.pending;
    const sug = SUGGESTION_LABELS[it.suggestion] || SUGGESTION_LABELS.none;
    rows.push([
      idx + 1,
      it.group,
      it.name,
      it.qty,
      it.unit || '件',
      it.location || '',
      it.note || '',
      sug,
      dec.label,
      it.decisionNote || '',
      it.decisionBy || '',
      it.createdBy || '',
      fmtDate(it.createdAt),
      fmtDate(it.decidedAt),
    ].map(csvCell).join(','));
  });

  const bom = '\uFEFF';
  const blob = new Blob([bom + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const title = (session?.meta?.title || '物品盤點').replace(/[\\/:*?"<>|]/g, '_');
  downloadBlob(blob, `${title}_盤點決議表.csv`);
}

/**
 * 匯出含照片的完整 JSON 備份
 */
export async function exportJsonBackup(code, mode, session, items) {
  const enrichedItems = {};
  for (const it of items) {
    let imgData = '';
    if (it.imgId) {
      try {
        imgData = await loadItemImage(code, mode, it.imgId);
      } catch {
        imgData = '';
      }
    }
    enrichedItems[it.id] = {
      ...it,
      _imageDataUrl: imgData,
    };
  }

  const payload = {
    version: 1,
    exportedAt: Date.now(),
    meta: session?.meta || {},
    items: enrichedItems,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const title = (session?.meta?.title || '物品盤點').replace(/[\\/:*?"<>|]/g, '_');
  downloadBlob(blob, `${title}_完整備份.json`);
}
