import { randomId } from './util.js';

// ──────────────────────────────────────────────────────────────────────────────
// 3. 題目 JSON 範本與驗證
// ──────────────────────────────────────────────────────────────────────────────
export const QID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'radio', 'checkbox', 'list', 'table'];
export const COLUMN_TYPES = ['text', 'number', 'date'];
export const MAX_EXERCISES = 30;
export const MAX_FIELDS = 40;
export const MAX_OPTIONS = 40;
export const MAX_ITEMS = 300;
export const MAX_ROWS = 300;
/**
 * 一場課程的小組數量上限。資料層另有「一場課程 500 組」的規模感（匯入答案檔沿用），
 * 但講師手動建立的組別實際上不會那麼多；60 組已足夠涵蓋最大的研習場次，
 * 同時擋下「輸入 500 一次產生」這種誤觸所造成的大量寫入。
 */
export const MAX_GROUPS = 60;

/**
 * 組名正規化：去除所有空白、全形轉半形、小寫轉大寫。
 *
 * **只用於判斷兩個名稱是不是同一組**（nameKey），畫面上顯示一律用原始字串。
 * 例：「第 1 組」「第１組」「第1組」正規化後都是「第1組」，會被視為同一組；
 * 但不處理中文數字，「第一組」與「第1組」仍然是兩組（見功能規劃「尚未決定」一節，這是已知且接受的限制）。
 */
export function normalizeGroupName(s) {
  return String(s ?? '')
    .replace(/\s+/g, '')                       // JS 的 \s 含全形空格 U+3000，一併去掉
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全形 → 半形
    .toUpperCase();
}

export const TEMPLATE = {
  courseTitle: '範例課程（下載後可依需求增刪練習與欄位）',
  exercises: [
    {
      title: '練習一．把名詞講定',
      time: '8 分鐘｜小組 5 分鐘 ＋ 回報 3 分鐘',
      goal: '讓同一單位的人對關鍵名詞有一致的認定。',
      notice: '以自己單位的實際情形填寫；遇到爭議時先取得一致，不必追求最正確的定義。',
      fields: [
        { key: 'definition', label: '我們單位的定義', type: 'textarea', required: true },
        { key: 'decision', label: '誰決定的／何時生效', type: 'text', required: true },
        { key: 'dispute', label: '我們這組最容易吵起來的名詞', type: 'text', required: true },
        { key: 'final', label: '最後我們決定', type: 'textarea', required: true },
      ],
    },
    {
      title: '練習二．六個月的出席，你看到什麼',
      time: '25 分鐘｜小組 15 分鐘 ＋ 發表 10 分鐘',
      goal: '練習不把總數當成唯一答案，學會拆開資料看。',
      reference: {
        caption: '某研究班六個月出席紀錄',
        columns: ['月份', '應到', '實到', '出席率'],
        rows: [['1 月', '50', '43', '86%'], ['2 月', '50', '42', '84%'], ['3 月', '51', '39', '76%']],
      },
      fields: [
        { key: 'see', label: '看到的資料與變化', type: 'textarea', required: true },
        { key: 'questions', label: '想知道的問題（至少四個）', type: 'list', itemType: 'textarea', itemLabel: '問題', minItems: 4, required: true },
        { key: 'action', label: '我們的一個行動', type: 'textarea', required: true },
      ],
    },
    {
      title: '練習三．盤點只有一個人會做的事',
      time: '12 分鐘｜小組 8 分鐘 ＋ 回報 4 分鐘',
      goal: '把「人力不夠」換成看得見的能力分布與單點風險。',
      notice: '至少列出 8 項工作。',
      fields: [
        {
          key: 'rows',
          label: '能力盤點',
          type: 'table',
          itemLabel: '工作',
          minRows: 8,
          required: true,
          columns: [
            { key: 'name', label: '工作項目', type: 'text' },
            { key: 'count', label: '會做的人（人）', type: 'number' },
            { key: 'senior', label: '其中 60 歲以上（人）', type: 'number' },
          ],
        },
        { key: 'trainee', label: '三個月內要培養的人', type: 'text', required: true },
        { key: 'coach', label: '由誰帶、怎麼帶', type: 'textarea', required: true },
      ],
    },
    {
      title: '練習四．下個月只追三個數字',
      time: '12 分鐘｜個人／單位 8 分鐘 ＋ 交表 4 分鐘',
      goal: '把課程變成下個月真的會發生的事。',
      notice: '只挑 3 個你們單位下個月真的會去看的指標。',
      fields: [
        {
          key: 'items',
          label: '選擇的三個指標',
          type: 'checkbox',
          required: true,
          options: ['平均出席', '新參與人數', '新人二次參與', '活躍志工', '高負荷志工', '一個月未參與'],
          minSelect: 3,
          maxSelect: 3,
        },
        { key: 'day', label: '每月檢視日期（1–31）', type: 'number', required: true },
        { key: 'report', label: '一個月後回報日期', type: 'date', required: true },
      ],
    },
  ],
};

export function cleanStr(v, maxlen, what) {
  if (typeof v !== 'string') throw Error(`${what} 必須是文字。`);
  const s = v.trim();
  if (s.length > maxlen) throw Error(`${what} 過長（上限 ${maxlen} 字）。`);
  return s;
}

export function validateField(field, idx) {
  if (!field || typeof field !== 'object') throw Error(`第 ${idx + 1} 個欄位格式不正確。`);
  const key = field.key;
  if (typeof key !== 'string' || !key.trim() || !/^[A-Za-z0-9_]+$/.test(key.trim())) {
    throw Error(`第 ${idx + 1} 個欄位的 key 必須是英數字或底線，且不可空白。`);
  }
  const label = cleanStr(field.label ?? '', 200, `欄位「${key}」的 label`);
  if (!label) throw Error(`欄位「${key}」缺少 label（題目文字）。`);
  if (!FIELD_TYPES.includes(field.type)) throw Error(`欄位「${key}」的 type 不正確，需為：${FIELD_TYPES.join('、')}。`);

  const out = { key: key.trim(), label, type: field.type, required: !!field.required };
  if (field.hint) out.hint = cleanStr(field.hint, 400, `欄位「${key}」的 hint`);

  if (field.type === 'radio' || field.type === 'checkbox') {
    const options = field.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > MAX_OPTIONS
      || options.some((o) => typeof o !== 'string' || !o.trim())) {
      throw Error(`欄位「${key}」需要 1–${MAX_OPTIONS} 個非空白的 options 選項。`);
    }
    out.options = options.map((o) => cleanStr(o, 200, `欄位「${key}」的選項`));
    if (field.type === 'checkbox') {
      ['minSelect', 'maxSelect'].forEach((k) => {
        if (field[k] !== undefined && field[k] !== null) {
          const v = field[k];
          if (!Number.isInteger(v) || v < 0 || v > out.options.length) {
            throw Error(`欄位「${key}」的 ${k} 必須是 0–${out.options.length} 的整數。`);
          }
          out[k] = v;
        }
      });
    }
  }

  if (field.type === 'list') {
    const itemType = field.itemType || 'textarea';
    if (!['text', 'textarea'].includes(itemType)) throw Error(`欄位「${key}」的 itemType 必須是 text 或 textarea。`);
    out.itemType = itemType;
    out.itemLabel = cleanStr(field.itemLabel || '項目', 100, `欄位「${key}」的 itemLabel`) || '項目';
    if (field.minItems !== undefined && field.minItems !== null) {
      if (!Number.isInteger(field.minItems) || field.minItems < 0 || field.minItems > MAX_ITEMS) {
        throw Error(`欄位「${key}」的 minItems 必須是 0–${MAX_ITEMS} 的整數。`);
      }
      out.minItems = field.minItems;
    }
  }

  if (field.type === 'table') {
    const columns = field.columns;
    if (!Array.isArray(columns) || columns.length < 1 || columns.length > 12) throw Error(`欄位「${key}」需要 1–12 個 columns。`);
    const seen = new Set();
    out.columns = columns.map((col, ci) => {
      if (!col || typeof col !== 'object') throw Error(`欄位「${key}」的第 ${ci + 1} 個 column 格式不正確。`);
      const ckey = col.key;
      if (typeof ckey !== 'string' || !/^[A-Za-z0-9_]+$/.test(ckey.trim())) throw Error(`欄位「${key}」的 column key 必須是英數字或底線。`);
      if (seen.has(ckey.trim())) throw Error(`欄位「${key}」的 column key 重複：${ckey}。`);
      seen.add(ckey.trim());
      const clabel = cleanStr(col.label ?? '', 100, `欄位「${key}」的 column label`);
      if (!clabel) throw Error(`欄位「${key}」的 column「${ckey}」缺少 label。`);
      const ctype = col.type || 'text';
      if (!COLUMN_TYPES.includes(ctype)) throw Error(`欄位「${key}」的 column「${ckey}」type 不正確。`);
      return { key: ckey.trim(), label: clabel, type: ctype };
    });
    out.itemLabel = cleanStr(field.itemLabel || '項目', 100, `欄位「${key}」的 itemLabel`) || '項目';
    if (field.minRows !== undefined && field.minRows !== null) {
      if (!Number.isInteger(field.minRows) || field.minRows < 0 || field.minRows > MAX_ROWS) {
        throw Error(`欄位「${key}」的 minRows 必須是 0–${MAX_ROWS} 的整數。`);
      }
      out.minRows = field.minRows;
    }
  }
  return out;
}

export function validateReference(refDef) {
  if (refDef == null) return null;
  if (typeof refDef !== 'object') throw Error('reference 參考資料格式不正確。');
  const out = {};
  if (refDef.caption) out.caption = cleanStr(refDef.caption, 200, 'reference.caption');
  const columns = refDef.columns || [];
  const rows = refDef.rows || [];
  if (!Array.isArray(columns) || columns.some((c) => typeof c !== 'string')) throw Error('reference.columns 必須是字串陣列。');
  if (!Array.isArray(rows) || rows.length > 200) throw Error('reference.rows 必須是陣列，且不超過 200 列。');
  rows.forEach((r) => {
    if (!Array.isArray(r) || r.some((c) => !['string', 'number'].includes(typeof c))) {
      throw Error('reference.rows 每一列必須是文字或數字組成的陣列。');
    }
  });
  out.columns = columns.map((c) => cleanStr(c, 100, 'reference 欄位名稱'));
  out.rows = rows.map((r) => r.map((c) => String(c)));
  return out;
}

export function validateExercise(exDef, idx) {
  if (!exDef || typeof exDef !== 'object') throw Error(`第 ${idx + 1} 個練習格式不正確。`);
  const title = cleanStr(exDef.title ?? '', 200, `第 ${idx + 1} 個練習的 title`);
  if (!title) throw Error(`第 ${idx + 1} 個練習缺少 title。`);
  const fields = exDef.fields;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_FIELDS) {
    throw Error(`練習「${title}」需要 1–${MAX_FIELDS} 個 fields。`);
  }
  const keys = new Set();
  const outFields = fields.map((f, i) => {
    const vf = validateField(f, i);
    if (keys.has(vf.key)) throw Error(`練習「${title}」的欄位 key 重複：${vf.key}。`);
    keys.add(vf.key);
    return vf;
  });
  const out = { title, fields: outFields };
  ['time', 'goal', 'notice'].forEach((k) => { if (exDef[k]) out[k] = cleanStr(exDef[k], 1000, `練習「${title}」的 ${k}`); });
  const reference = validateReference(exDef.reference);
  if (reference) out.reference = reference;
  return out;
}

/**
 * 匯入的題目一律帶上穩定 ID：原 JSON 自帶 qid 就沿用（方便講師手動改題後重新匯入而不弄丟答案），
 * 沒有就現場產生。qid 之後就是答案的 key，重複會讓兩題共用同一份答案，因此必須擋下來。
 */
export function validateExercisesPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.exercises)) {
    throw Error('請上傳正確的題目 JSON（需包含 exercises 陣列，可先下載範本）。');
  }
  const { exercises } = payload;
  if (exercises.length < 1 || exercises.length > MAX_EXERCISES) throw Error(`exercises 需要 1–${MAX_EXERCISES} 個練習。`);
  const seen = new Set();
  return exercises.map((exDef, i) => {
    const out = validateExercise(exDef, i);
    let qid = (exDef && typeof exDef.qid === 'string') ? exDef.qid.trim() : '';
    if (qid) {
      if (!QID_PATTERN.test(qid)) throw Error(`第 ${i + 1} 個練習的 qid 只能是英數字、底線或減號（64 字以內）。`);
      if (seen.has(qid)) throw Error(`第 ${i + 1} 個練習的 qid 與前面的練習重複：${qid}。`);
    } else {
      do { qid = randomId(8); } while (seen.has(qid));
    }
    seen.add(qid);
    return {
      qid, rev: 0, status: 'active', ...out,
    };
  });
}

/**
 * 作答驗證：complete 為 true 時才檢查必填／數量條件。
 * 直接收題目物件（不再用索引），呼叫端用 qid 取題，題目被刪除時就取不到，會在這裡得到明確訊息。
 */
export function validateAnswer(exDef, answer, complete) {
  if (!exDef || typeof exDef !== 'object' || !Array.isArray(exDef.fields)) throw Error('找不到這一題，可能已被講師刪除。');
  if (!answer || typeof answer !== 'object') throw Error('答案格式不正確。');
  const out = {};
  const need = (v, msg) => { if (!String(v ?? '').trim()) throw Error(msg); };

  exDef.fields.forEach((field) => {
    const { key, type, label } = field;
    let v = answer[key];

    if (['text', 'textarea', 'date'].includes(type)) {
      if (v == null) v = '';
      if (typeof v !== 'string' || v.length > 4000) throw Error(`「${label}」格式不正確。`);
      if (complete && field.required) need(v, `請填寫「${label}」。`);
      out[key] = v;
    } else if (type === 'number') {
      if (v == null) v = '';
      if (typeof v !== 'string' || v.length > 40) throw Error(`「${label}」格式不正確。`);
      if (v !== '' && !/^-?\d+$/.test(v)) throw Error(`「${label}」必須是數字。`);
      if (complete && field.required) need(v, `請填寫「${label}」。`);
      out[key] = v;
    } else if (type === 'radio') {
      if (v == null) v = '';
      if (typeof v !== 'string' || (v && !field.options.includes(v))) throw Error(`「${label}」的選項不正確。`);
      if (complete && field.required) need(v, `請選擇「${label}」。`);
      out[key] = v;
    } else if (type === 'checkbox') {
      if (v == null) v = [];
      if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || x < 0 || x >= field.options.length)
        || new Set(v).size !== v.length) throw Error(`「${label}」的選項格式不正確。`);
      if (field.maxSelect != null && v.length > field.maxSelect) throw Error(`「${label}」最多只能選 ${field.maxSelect} 項。`);
      if (complete) {
        if (field.minSelect != null && v.length < field.minSelect) throw Error(`「${label}」至少要選 ${field.minSelect} 項。`);
        else if (field.required && field.minSelect == null && !v.length) throw Error(`請選擇「${label}」。`);
      }
      out[key] = v;
    } else if (type === 'list') {
      if (v == null) v = [];
      if (!Array.isArray(v) || v.length > MAX_ITEMS || v.some((x) => typeof x !== 'string' || x.length > 2000)) {
        throw Error(`「${label}」的內容格式不正確。`);
      }
      if (complete) {
        const filled = v.filter((x) => String(x).trim()).length;
        if (field.minItems != null && filled < field.minItems) throw Error(`「${label}」至少要填 ${field.minItems} 項。`);
        else if (field.required && field.minItems == null && filled === 0) throw Error(`請填寫「${label}」。`);
      }
      out[key] = v;
    } else if (type === 'table') {
      const colKeys = field.columns.map((c) => c.key);
      if (v == null) v = [];
      if (!Array.isArray(v) || v.length > MAX_ROWS) throw Error(`「${label}」的內容格式不正確。`);
      const rows = v.map((row) => {
        if (!row || typeof row !== 'object') throw Error(`「${label}」的內容格式不正確。`);
        const clean = {};
        colKeys.forEach((ck) => {
          const cv = row[ck] ?? '';
          if (typeof cv !== 'string' || cv.length > 500) throw Error(`「${label}」的內容格式不正確。`);
          clean[ck] = cv;
        });
        return clean;
      });
      if (complete) {
        const used = rows.filter((r) => Object.values(r).some((x) => String(x).trim()));
        if (field.minRows != null && used.length < field.minRows) throw Error(`「${label}」至少要填 ${field.minRows} 列。`);
        else if (field.required && field.minRows == null && !used.length) throw Error(`請填寫「${label}」。`);
        used.forEach((r) => {
          colKeys.forEach((ck) => { if (!String(r[ck] ?? '').trim()) throw Error(`「${label}」已填的列請填完整每一欄。`); });
        });
      }
      out[key] = rows;
    }
  });
  return out;
}
