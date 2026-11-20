/**
 * 隨身閱讀 PocketReader — 純邏輯文字核心（零瀏覽器 DOM 依賴，支援 Node 單元測試）
 */

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeSearchText(str) {
  return String(str ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase();
}

export function decodeHtmlEntities(str) {
  if (!str) return '';
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ensp: ' ',
    emsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    middot: '·',
  };
  return String(str).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, ent) => {
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const code = Number.parseInt(ent.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    if (ent.startsWith('#')) {
      const code = Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    return Object.prototype.hasOwnProperty.call(named, ent) ? named[ent] : full;
  });
}

const CHAPTER_CN_RE =
  /^第[零〇一二三四五六七八九十百千萬兩0-9]{1,8}[章節回卷篇部課講品折幕](?:[\s：:.\-—]|$)/;
const CHAPTER_EN_RE = /^(?:chapter|part|section|book|lesson)\s+[0-9ivxlcdm]+(?:\b|[:.\-\s])/i;

export function splitIntoChapters(rawText, options = {}) {
  const {
    defaultTitle = '全文',
    minChapterGapLines = 0,
    splitOnH2 = false,
  } = options;

  const text = String(rawText ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) {
    return [{ id: 'ch-1', title: defaultTitle, content: '' }];
  }

  const lines = text.split('\n');
  const hasH1 = lines.some((l) => /^#\s+\S/.test(l.trim()));
  const markers = [];

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    let heading = null;
    if (/^#\s+\S/.test(trimmed)) {
      heading = trimmed.replace(/^#\s+/, '').trim();
    } else if ((!hasH1 || splitOnH2) && /^##\s+\S/.test(trimmed)) {
      heading = trimmed.replace(/^##\s+/, '').trim();
    } else if (trimmed.length <= 42 && (CHAPTER_CN_RE.test(trimmed) || CHAPTER_EN_RE.test(trimmed))) {
      heading = trimmed;
    }

    if (heading) {
      if (!markers.length || i - markers[markers.length - 1].lineIndex > minChapterGapLines) {
        markers.push({ lineIndex: i, title: heading });
      }
    }
  }

  if (markers.length === 0) {
    return [{ id: 'ch-1', title: defaultTitle, content: text }];
  }

  const chapters = [];
  if (markers[0].lineIndex > 0) {
    const preface = lines.slice(0, markers[0].lineIndex).join('\n').trim();
    if (preface) {
      chapters.push({ id: `ch-${chapters.length + 1}`, title: '前言', content: preface });
    }
  }

  for (let m = 0; m < markers.length; m++) {
    const start = markers[m].lineIndex + 1;
    const end = m + 1 < markers.length ? markers[m + 1].lineIndex : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    const title = markers[m].title || `第 ${chapters.length + 1} 章`;
    // Keep chapter heading at top if body is empty so chapter isn't blank
    chapters.push({
      id: `ch-${chapters.length + 1}`,
      title,
      content: body || title,
    });
  }

  return chapters.length ? chapters : [{ id: 'ch-1', title: defaultTitle, content: text }];
}

/**
 * 將單章 Markdown / 純文字拆成可定址段落塊（與 paraIndex 一一對應）
 */
export function parseChapterBlocks(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) i++;
      blocks.push({
        type: 'code',
        lang,
        text: codeLines.join('\n'),
        rawText: codeLines.join('\n'),
      });
      continue;
    }

    // Markdown table (header row + separator row)
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim())
    ) {
      const tableLines = [trimmed];
      i++;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      blocks.push({
        type: 'table',
        lines: tableLines,
        rawText: tableLines.join('\n'),
      });
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr', text: '', rawText: trimmed });
      i++;
      continue;
    }

    // Headings
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      blocks.push({
        type: 'heading',
        level: hMatch[1].length,
        text: hMatch[2].trim(),
        rawText: trimmed,
      });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const body = trimmed.replace(/^>\s?/, '');
      blocks.push({
        type: 'quote',
        text: body,
        rawText: trimmed,
      });
      i++;
      continue;
    }

    // Unordered list item
    const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      blocks.push({
        type: 'list-item',
        ordered: false,
        text: ulMatch[1],
        rawText: trimmed,
      });
      i++;
      continue;
    }

    // Ordered list item
    const olMatch = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (olMatch) {
      blocks.push({
        type: 'list-item',
        ordered: true,
        marker: olMatch[1],
        text: olMatch[2],
        rawText: trimmed,
      });
      i++;
      continue;
    }

    // Normal paragraph line
    blocks.push({
      type: 'para',
      text: trimmed,
      rawText: trimmed,
    });
    i++;
  }

  return blocks;
}

export function isCjkChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function joinSmartText(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.endsWith('-') && /^[a-z]/i.test(right) && left.length >= 2 && /[a-z]/i.test(left[left.length - 2])) {
    return left.slice(0, -1) + right;
  }
  const last = left[left.length - 1];
  const first = right[0];
  if (isCjkChar(last) || isCjkChar(first)) {
    return left + right;
  }
  if (/[\s([{「『（【《“‘]$/.test(left) || /^[\s.,;:!?)\]｝」』）】》”’]/.test(right)) {
    return left + right;
  }
  return `${left} ${right}`;
}

/**
 * 智慧重組 PDF 單頁文字項（支援橫排、直排、軟換行合併與段落偵測）
 */
export function reconstructPdfPageText(rawItems, viewport = {}) {
  const items = (rawItems || [])
    .filter((it) => it && typeof it.str === 'string' && it.str.replace(/\s+/g, '') !== '')
    .map((it) => {
      const tr = Array.isArray(it.transform) ? it.transform : [12, 0, 0, 12, 0, 0];
      const a = tr[0] || 0;
      const b = tr[1] || 0;
      const c = tr[2] || 0;
      const d = tr[3] || 0;
      const x = Number.isFinite(tr[4]) ? tr[4] : 0;
      const y = Number.isFinite(tr[5]) ? tr[5] : 0;
      const fontSize = Math.max(6, Math.hypot(a, b) || Math.hypot(c, d) || it.height || 12);
      const width = Number.isFinite(it.width) && it.width > 0 ? it.width : fontSize * it.str.length * 0.6;
      const rotatedVertical = Math.abs(b) > Math.abs(a) * 1.4;
      return { str: it.str, x, y, width, fontSize, rotatedVertical };
    });

  if (items.length === 0) {
    return { text: '', isVertical: false };
  }

  // Heuristic: detect vertical-rl layout
  let verticalTransitions = 0;
  let horizontalTransitions = 0;
  let rotatedCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].rotatedVertical) rotatedCount++;
    if (i > 0) {
      const prev = items[i - 1];
      const curr = items[i];
      const fs = Math.max(prev.fontSize, curr.fontSize);
      const dx = Math.abs(curr.x - prev.x);
      const dy = prev.y - curr.y; // positive if moving downwards in PDF coords
      if (dx < fs * 0.6 && dy > fs * 0.45 && dy < fs * 3.5) {
        verticalTransitions++;
      } else if (Math.abs(dy) < fs * 0.45 && curr.x > prev.x) {
        horizontalTransitions++;
      }
    }
  }

  const hasLongHorizontalRuns = items.some((it) => !it.rotatedVertical && it.str.trim().length >= 6);
  const isVertical =
    rotatedCount > items.length * 0.6 ||
    (!hasLongHorizontalRuns && verticalTransitions > horizontalTransitions * 1.25 && verticalTransitions >= 4);

  if (isVertical) {
    return {
      text: reconstructVerticalColumns(items, viewport),
      isVertical: true,
    };
  }

  return {
    text: reconstructHorizontalLines(items),
    isVertical: false,
  };
}

function reconstructVerticalColumns(items) {
  // Cluster by X descending (right-to-left columns)
  const sorted = [...items].sort((a, b) => b.x - a.x || b.y - a.y);
  const columns = [];

  for (const item of sorted) {
    let targetCol = null;
    for (const col of columns) {
      const tol = Math.max(col.avgFs, item.fontSize) * 0.65;
      if (Math.abs(item.x - col.x) <= tol) {
        targetCol = col;
        break;
      }
    }
    if (!targetCol) {
      targetCol = { x: item.x, avgFs: item.fontSize, items: [] };
      columns.push(targetCol);
    }
    targetCol.items.push(item);
    targetCol.x =
      targetCol.items.reduce((sum, it) => sum + it.x, 0) / targetCol.items.length;
  }

  columns.sort((a, b) => b.x - a.x);
  for (const col of columns) {
    col.items.sort((a, b) => b.y - a.y);
    col.text = col.items.map((it) => it.str.trim()).join('');
    col.topY = col.items[0].y;
    col.bottomY = col.items[col.items.length - 1].y;
  }

  const maxTopY = Math.max(...columns.map((c) => c.topY));
  const minBottomY = Math.min(...columns.map((c) => c.bottomY));
  const colSpan = Math.max(1, maxTopY - minBottomY);

  const pitches = [];
  for (let i = 1; i < columns.length; i++) {
    const p = columns[i - 1].x - columns[i].x;
    if (p > 0) pitches.push(p);
  }
  pitches.sort((a, b) => a - b);
  const medianPitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0;

  const paragraphs = [];
  let buf = '';
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (!col.text) continue;
    if (!buf) {
      buf = col.text;
    } else {
      const prev = columns[i - 1];
      const fs = Math.max(prev.avgFs, col.avgFs);
      const indentedStart = maxTopY - col.topY > fs * 1.4;
      const prevEndedEarly = prev.bottomY - minBottomY > Math.max(fs * 2.2, colSpan * 0.25);
      const colGap = prev.x - col.x;
      const wideColGap = medianPitch > 0 && colGap > Math.max(fs * 3.8, medianPitch * 1.65);
      if (indentedStart || prevEndedEarly || wideColGap) {
        paragraphs.push(buf);
        buf = col.text;
      } else {
        buf = joinSmartText(buf, col.text);
      }
    }
  }
  if (buf) paragraphs.push(buf);
  return paragraphs.join('\n\n');
}

function reconstructHorizontalLines(items) {
  // Cluster by Y descending (top-to-bottom)
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];

  for (const item of sorted) {
    let targetLine = null;
    for (const line of lines) {
      const tol = Math.max(line.avgFs, item.fontSize) * 0.45;
      if (Math.abs(item.y - line.y) <= tol) {
        targetLine = line;
        break;
      }
    }
    if (!targetLine) {
      targetLine = { y: item.y, avgFs: item.fontSize, items: [] };
      lines.push(targetLine);
    }
    targetLine.items.push(item);
  }

  lines.sort((a, b) => b.y - a.y);

  const builtLines = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const item of line.items) {
      const chunk = item.str;
      if (!chunk) continue;
      if (!text) {
        text = chunk.trimStart();
      } else {
        const gap = item.x - prevEnd;
        const last = text[text.length - 1];
        const first = chunk.trimStart()[0];
        const bothCjk = isCjkChar(last) && isCjkChar(first);
        const spaceNeeded = bothCjk ? gap > item.fontSize * 0.55 : gap > item.fontSize * 0.22;
        if (spaceNeeded && !/\s$/.test(text) && !/^\s/.test(chunk)) {
          text += ' ' + chunk.trimStart();
        } else {
          text += chunk;
        }
      }
      prevEnd = item.x + item.width;
    }
    text = text.trim();
    if (!text) continue;

    const minX = line.items[0].x;
    const maxEnd = Math.max(...line.items.map((it) => it.x + it.width));
    builtLines.push({
      y: line.y,
      minX,
      maxEnd,
      width: maxEnd - minX,
      avgFs: line.avgFs,
      text,
    });
  }

  if (builtLines.length === 0) return '';

  // Estimate body left margin and normal line width
  const sortedX = [...builtLines].map((l) => l.minX).sort((a, b) => a - b);
  const leftMargin = sortedX[Math.floor(sortedX.length * 0.15)] ?? sortedX[0];
  const maxWidth = Math.max(...builtLines.map((l) => l.width), 1);

  const paragraphs = [];
  let buf = '';

  for (let i = 0; i < builtLines.length; i++) {
    const curr = builtLines[i];
    if (!buf) {
      buf = curr.text;
      continue;
    }
    const prev = builtLines[i - 1];
    const fs = Math.max(prev.avgFs, curr.avgFs);
    const dy = prev.y - curr.y;

    const isBigGap = dy > fs * 1.95;
    const isIndented = curr.minX - leftMargin > fs * 1.35;
    const prevLooksShortAndEnded =
      prev.width < maxWidth * 0.78 && /[。！？；.!?:」』”’）)]$/.test(prev.text);
    const currIsHeadingOrList =
      CHAPTER_CN_RE.test(curr.text) ||
      CHAPTER_EN_RE.test(curr.text) ||
      /^(?:[-*•·]|\d+[.)、]|[（(]?[一二三四五六七八九十\d]+[）)、.])\s*/.test(curr.text) ||
      /^#{1,4}\s+/.test(curr.text);
    const prevWasHeading =
      CHAPTER_CN_RE.test(prev.text) ||
      CHAPTER_EN_RE.test(prev.text) ||
      /^#{1,4}\s+/.test(prev.text);

    if (isBigGap || isIndented || prevLooksShortAndEnded || currIsHeadingOrList || prevWasHeading) {
      paragraphs.push(buf);
      buf = curr.text;
    } else {
      buf = joinSmartText(buf, curr.text);
    }
  }
  if (buf) paragraphs.push(buf);

  return paragraphs.join('\n\n');
}

/**
 * 解析 Word (.docx) 的 word/document.xml 為乾淨 Markdown / 純文字（支援 Node 與瀏覽器）
 */
export function parseDocxXml(documentXmlString) {
  const xml = String(documentXmlString ?? '');
  if (!xml.trim()) return '';

  const extractParagraph = (pInner) => {
    const styleMatch = pInner.match(/<w:pStyle\b[^>]*\bw:val=["']([^"']+)["']/i);
    const styleVal = styleMatch ? styleMatch[1] : '';
    const hasNumPr = /<w:numPr\b/i.test(pInner);

    // Tokenize text runs, line breaks, and tabs in order
    let out = '';
    const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(?:br|cr)\b[^>]*\/>|<w:tab\b[^>]*\/>/gi;
    let m;
    while ((m = tokenRe.exec(pInner)) !== null) {
      if (m[1] !== undefined) {
        out += decodeHtmlEntities(m[1]);
      } else if (/^<w:tab\b/i.test(m[0])) {
        out += '  ';
      } else {
        out += '\n';
      }
    }

    const cleaned = out.replace(/\n{3,}/g, '\n\n').trim();
    if (!cleaned) return '';

    if (/^(?:Heading1|Title|1)$/i.test(styleVal)) return `# ${cleaned}`;
    if (/^(?:Heading2|Subtitle|2)$/i.test(styleVal)) return `## ${cleaned}`;
    if (/^(?:Heading3|Heading4|3|4)$/i.test(styleVal)) return `### ${cleaned}`;
    if (hasNumPr && !/^[-*•]\s/.test(cleaned)) return `- ${cleaned}`;
    return cleaned;
  };

  const extractTable = (tblInner) => {
    const rows = [];
    const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi;
    let trM;
    while ((trM = trRe.exec(tblInner)) !== null) {
      const cells = [];
      const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi;
      let tcM;
      while ((tcM = tcRe.exec(trM[1])) !== null) {
        const cellParts = [];
        const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
        let pM;
        while ((pM = pRe.exec(tcM[1])) !== null) {
          const txt = extractParagraph(pM[1]).replace(/^#{1,3}\s+/, '').replace(/\n+/g, ' ');
          if (txt) cellParts.push(txt);
        }
        cells.push(cellParts.join(' ').replace(/\|/g, '\\|').trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const colCount = Math.max(...rows.map((r) => r.length));
    const padRow = (r) => {
      const copy = [...r];
      while (copy.length < colCount) copy.push('');
      return `| ${copy.join(' | ')} |`;
    };
    const md = [padRow(rows[0]), `| ${Array(colCount).fill('---').join(' | ')} |`];
    for (let r = 1; r < rows.length; r++) {
      md.push(padRow(rows[r]));
    }
    return md.join('\n');
  };

  // Walk body top-level elements (tables vs standalone paragraphs) so table paragraphs aren't duplicated
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i);
  const body = bodyMatch ? bodyMatch[1] : xml;

  const blocks = [];
  const blockRe = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
  let bm;
  while ((bm = blockRe.exec(body)) !== null) {
    if (bm[1] !== undefined) {
      const tbl = extractTable(bm[1]);
      if (tbl) blocks.push(tbl);
    } else if (bm[2] !== undefined) {
      const p = extractParagraph(bm[2]);
      if (p) blocks.push(p);
    }
  }

  return blocks.join('\n\n');
}

/**
 * 解析 EPUB XHTML 或網頁 HTML 片段為標題與乾淨 Markdown/純文字
 */
export function parseEpubXhtml(xhtmlString) {
  let html = String(xhtmlString ?? '');
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    : '';

  // Remove non-content blocks
  html = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|nav|aside|footer|header|form|button)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : html;

  // Convert structural tags to Markdown markers before stripping tags
  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n# ${t}\n\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n## ${t}\n\n`)
    .replace(/<h[3-6]\b[^>]*>([\s\S]*?)<\/h[3-6]>/gi, (_, t) => `\n\n### ${t}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => {
      const clean = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return clean ? `\n\n> ${clean}\n\n` : '\n\n';
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${t}`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<\/(p|div|section|article|tr|ul|ol|dt|dd|figcaption)>/gi, '\n\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ');

  const stripped = decodeHtmlEntities(body.replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: stripped };
}

/**
 * 將文字切分為背誦單元（按句 / 按短語）
 */
export function segmentSentences(text, granularity = 'sentence') {
  const input = String(text ?? '');
  if (!input) return [];

  const punct = granularity === 'clause' ? '。！？；，、：!?;,:' : '。！？；!?;';
  const closers = '」』”’）》】)\\]';
  const re = new RegExp(`([^\\n${punct}]+(?:[${punct}\\n]+[${closers}]*)?|[${punct}\\n]+[${closers}]*)`, 'g');
  const raw = input.match(re);
  if (!raw || raw.length === 0) return [input];

  // Merge punctuation-only / closing-quote-only trailing fragments into previous segment
  const onlyPunctRe = new RegExp(`^[\\s${punct}\\n${closers}.]+$`);
  const segments = [];
  for (const part of raw) {
    if (!part) continue;
    if (segments.length > 0 && onlyPunctRe.test(part)) {
      segments[segments.length - 1] += part;
    } else {
      segments.push(part);
    }
  }
  return segments;
}

function sanitizeHref(url) {
  const raw = String(url ?? '').trim();
  return /^https?:\/\//i.test(raw) ? raw : null;
}

function applySearchHighlightToText(plainText, searchQuery) {
  const rawQuery = String(searchQuery ?? '').trim();
  if (!rawQuery) return escapeHtml(plainText);

  const terms = rawQuery
    .normalize('NFKC')
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return escapeHtml(plainText);

  const escapedPattern = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(${escapedPattern})`, 'gi');

  let out = '';
  let lastIndex = 0;
  let m;
  while ((m = re.exec(plainText)) !== null) {
    if (m.index > lastIndex) {
      out += escapeHtml(plainText.slice(lastIndex, m.index));
    }
    out += `<mark class="search-hit">${escapeHtml(m[0])}</mark>`;
    lastIndex = re.lastIndex;
  }
  if (lastIndex < plainText.length) {
    out += escapeHtml(plainText.slice(lastIndex));
  }
  return out;
}

/**
 * 渲染一般行內 Markdown（先安全跳脫再套用樣式）
 */
export function renderInlineHtml(text, searchQuery = '') {
  const src = String(text ?? '');
  // Parse inline tokens safely: `code`, **bold**, *italic*, {{cloze}}, ==mark==, [label](url)
  const tokenRe =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\{\{[^}]+\}\}|==[^=]+==|\[[^\]]+\]\([^)]+\))/g;

  let out = '';
  let last = 0;
  let m;
  while ((m = tokenRe.exec(src)) !== null) {
    if (m.index > last) {
      out += applySearchHighlightToText(src.slice(last, m.index), searchQuery);
    }
    const tok = m[0];
    if (tok.startsWith('`') && tok.endsWith('`')) {
      out += `<code class="inline-code">${applySearchHighlightToText(tok.slice(1, -1), searchQuery)}</code>`;
    } else if (tok.startsWith('**') && tok.endsWith('**')) {
      out += `<strong>${applySearchHighlightToText(tok.slice(2, -2), searchQuery)}</strong>`;
    } else if (tok.startsWith('*') && tok.endsWith('*')) {
      out += `<em>${applySearchHighlightToText(tok.slice(1, -1), searchQuery)}</em>`;
    } else if (tok.startsWith('{{') && tok.endsWith('}}')) {
      out += `<span class="cloze-tag">${applySearchHighlightToText(tok.slice(2, -2), searchQuery)}</span>`;
    } else if (tok.startsWith('==') && tok.endsWith('==')) {
      out += `<mark class="text-highlight">${applySearchHighlightToText(tok.slice(2, -2), searchQuery)}</mark>`;
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const safeUrl = lm ? sanitizeHref(lm[2]) : null;
      if (lm && safeUrl) {
        out += `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${applySearchHighlightToText(lm[1], searchQuery)}</a>`;
      } else {
        out += applySearchHighlightToText(tok, searchQuery);
      }
    }
    last = tokenRe.lastIndex;
  }
  if (last < src.length) {
    out += applySearchHighlightToText(src.slice(last), searchQuery);
  }
  return out;
}

function stripInlineSyntax(text) {
  return String(text ?? '')
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function splitFirstHintChars(sentence, hintChars = 1) {
  const chars = Array.from(sentence);
  let visibleSeen = 0;
  let splitIdx = 0;
  for (let i = 0; i < chars.length; i++) {
    splitIdx = i + 1;
    if (!/[\s「『“‘（(【《—\-]/.test(chars[i])) {
      visibleSeen++;
      if (visibleSeen >= hintChars) break;
    }
  }
  return {
    hint: chars.slice(0, splitIdx).join(''),
    rest: chars.slice(splitIdx).join(''),
  };
}

function renderClozeMode(text, { paraIdx = 0, revealedUnits = new Set(), clozeTerms = [], searchQuery = '' }) {
  const escapedTerms = (clozeTerms || [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const parts = ['(\\{\\{[^}]+\\}\\}|==[^=]+==)'];
  if (escapedTerms.length) {
    parts.push(`(${escapedTerms.join('|')})`);
  }
  const re = new RegExp(parts.join('|'), 'g');

  let out = '';
  let last = 0;
  let cIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out += renderInlineHtml(text.slice(last, m.index), searchQuery);
    }
    const raw = m[0];
    const inner =
      (raw.startsWith('{{') && raw.endsWith('}}')) || (raw.startsWith('==') && raw.endsWith('=='))
        ? raw.slice(2, -2)
        : raw;
    const clozeKey = `cloze:${paraIdx}:${cIdx}`;
    const revealed = revealedUnits.has(clozeKey);
    out += `<span class="cloze-blank ${revealed ? 'is-revealed' : 'is-masked'}" data-unit-key="${escapeHtml(clozeKey)}" tabindex="0" role="button" aria-pressed="${revealed ? 'true' : 'false'}">${applySearchHighlightToText(inner, searchQuery)}</span>`;
    cIdx++;
    last = re.lastIndex;
  }
  if (last < text.length) {
    out += renderInlineHtml(text.slice(last), searchQuery);
  }
  return out;
}

function renderReciteContent(text, options) {
  const {
    reciteMode = 'off',
    granularity = 'sentence',
    hintChars = 1,
    revealedUnits = new Set(),
    clozeTerms = [],
    searchQuery = '',
    paraIdx = 0,
  } = options;

  if (reciteMode === 'cloze') {
    return renderClozeMode(text, { paraIdx, revealedUnits, clozeTerms, searchQuery });
  }

  if (reciteMode !== 'mask' && reciteMode !== 'first-char') {
    return renderInlineHtml(text, searchQuery);
  }

  const clean = stripInlineSyntax(text);
  const units = segmentSentences(clean, granularity);
  return units
    .map((unit, uIdx) => {
      if (!unit.trim()) return escapeHtml(unit);
      const unitKey = `${paraIdx}:${uIdx}`;
      const revealed = revealedUnits.has(unitKey);

      if (reciteMode === 'first-char') {
        const { hint, rest } = splitFirstHintChars(unit, hintChars);
        return `<span class="recite-unit is-first-char ${revealed ? 'is-revealed' : 'is-masked'}" data-unit-key="${escapeHtml(unitKey)}" tabindex="0" role="button" aria-pressed="${revealed ? 'true' : 'false'}"><span class="recite-hint">${applySearchHighlightToText(hint, searchQuery)}</span><span class="recite-rest">${applySearchHighlightToText(rest, searchQuery)}</span></span>`;
      }

      return `<span class="recite-unit ${revealed ? 'is-revealed' : 'is-masked'}" data-unit-key="${escapeHtml(unitKey)}" tabindex="0" role="button" aria-pressed="${revealed ? 'true' : 'false'}">${applySearchHighlightToText(unit, searchQuery)}</span>`;
    })
    .join('');
}

/**
 * 將單一段落或區塊渲染為安全的閱讀 HTML
 */
export function renderParagraphHtml(blockOrText, options = {}) {
  const { paraIdx = 0, searchQuery = '', activeTts = false, bookmarked = false } = options;
  const block =
    typeof blockOrText === 'string'
      ? parseChapterBlocks(blockOrText)[0] || { type: 'para', text: blockOrText }
      : blockOrText;

  const extraCls = `${activeTts ? ' is-tts-active' : ''}${bookmarked ? ' is-bookmarked' : ''}`;

  if (block.type === 'hr') {
    return `<hr class="reader-hr" data-para-idx="${paraIdx}">`;
  }

  if (block.type === 'code') {
    return `<pre class="reader-code${extraCls}" data-para-idx="${paraIdx}"><code>${applySearchHighlightToText(block.text, searchQuery)}</code></pre>`;
  }

  if (block.type === 'table') {
    const rows = block.lines
      .filter((_, idx) => idx !== 1)
      .map((line, rIdx) => {
        const cells = line
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
        const tag = rIdx === 0 ? 'th' : 'td';
        return `<tr>${cells.map((c) => `<${tag}>${renderInlineHtml(c, searchQuery)}</${tag}>`).join('')}</tr>`;
      })
      .join('');
    return `<div class="reader-table-wrap${extraCls}" data-para-idx="${paraIdx}"><table class="reader-table">${rows}</table></div>`;
  }

  const inner = renderReciteContent(block.text || '', options);

  if (block.type === 'heading') {
    const lvl = Math.min(4, Math.max(2, (block.level || 1) + 1));
    return `<h${lvl} class="reader-heading reader-h${block.level || 1}${extraCls}" data-para-idx="${paraIdx}">${inner}</h${lvl}>`;
  }

  if (block.type === 'quote') {
    return `<blockquote class="reader-quote${extraCls}" data-para-idx="${paraIdx}">${inner}</blockquote>`;
  }

  if (block.type === 'list-item') {
    const bullet = block.ordered ? `${escapeHtml(block.marker)}.` : '•';
    return `<div class="reader-list-item${extraCls}" data-para-idx="${paraIdx}"><span class="reader-list-bullet">${bullet}</span><span class="reader-list-body">${inner}</span></div>`;
  }

  return `<p class="reader-para${extraCls}" data-para-idx="${paraIdx}">${inner}</p>`;
}

/**
 * 跨全書庫即時全文檢索
 */
export function searchLibrary(books, query, options = {}) {
  const { limit = 60, category = 'all' } = options;
  const rawQuery = String(query ?? '').trim();
  if (!rawQuery) return [];

  const normQuery = normalizeSearchText(rawQuery);
  const terms = normQuery.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results = [];

  for (const book of books || []) {
    if (!book || book.deletedAt) continue;
    if (category === 'pinned' && !book.pinned) continue;
    if (category !== 'all' && category !== 'pinned' && book.category !== category) continue;

    const titleNorm = normalizeSearchText(book.title);
    const metaNorm = normalizeSearchText(
      [book.author, book.category, ...(book.tags || [])].filter(Boolean).join(' ')
    );

    let metaScore = 0;
    if (terms.every((t) => titleNorm.includes(t))) metaScore += 100;
    if (terms.every((t) => metaNorm.includes(t))) metaScore += 40;
    if (titleNorm.includes(normQuery)) metaScore += 40;

    let bookBestHit = null;
    let totalHits = 0;

    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    for (let cIdx = 0; cIdx < chapters.length; cIdx++) {
      const ch = chapters[cIdx];
      const chTitleNorm = normalizeSearchText(ch.title);
      const chTitleMatched = terms.every((t) => chTitleNorm.includes(t));

      const blocks = parseChapterBlocks(ch.content);
      for (let pIdx = 0; pIdx < blocks.length; pIdx++) {
        const plain = stripInlineSyntax(blocks[pIdx].rawText || blocks[pIdx].text || '');
        const norm = normalizeSearchText(plain);
        if (!norm) continue;
        if (!terms.every((t) => norm.includes(t))) continue;

        totalHits++;
        let score = metaScore + (chTitleMatched ? 25 : 0) + 12;
        if (norm.includes(normQuery)) score += 20;

        if (!bookBestHit || score > bookBestHit.score) {
          const firstIdx = norm.indexOf(terms[0]);
          const start = Math.max(0, firstIdx - 28);
          const end = Math.min(plain.length, firstIdx + 68);
          const snippet =
            (start > 0 ? '…' : '') + plain.slice(start, end).trim() + (end < plain.length ? '…' : '');
          bookBestHit = {
            bookId: book.id,
            title: book.title,
            category: book.category || '未分類',
            sourceType: book.sourceType || 'text',
            chapterIndex: cIdx,
            chapterTitle: ch.title || `第 ${cIdx + 1} 章`,
            paraIndex: pIdx,
            snippet,
            score,
          };
        }
      }

      if (!bookBestHit && chTitleMatched) {
        totalHits++;
        bookBestHit = {
          bookId: book.id,
          title: book.title,
          category: book.category || '未分類',
          sourceType: book.sourceType || 'text',
          chapterIndex: cIdx,
          chapterTitle: ch.title,
          paraIndex: 0,
          snippet: `章節：${ch.title}`,
          score: metaScore + 25,
        };
      }
    }

    if (!bookBestHit && metaScore > 0) {
      const firstCh = chapters[0];
      const firstBlock = firstCh ? parseChapterBlocks(firstCh.content)[0] : null;
      bookBestHit = {
        bookId: book.id,
        title: book.title,
        category: book.category || '未分類',
        sourceType: book.sourceType || 'text',
        chapterIndex: 0,
        chapterTitle: firstCh?.title || '全文',
        paraIndex: 0,
        snippet: stripInlineSyntax(firstBlock?.text || book.author || book.category || '').slice(0, 80),
        score: metaScore,
      };
    }

    if (bookBestHit) {
      results.push({ ...bookBestHit, matchCount: totalHits });
    }
  }

  results.sort((a, b) => b.score - a.score || b.matchCount - a.matchCount);
  return results.slice(0, limit);
}

export function countBookChars(book) {
  if (!book || !Array.isArray(book.chapters)) return 0;
  return book.chapters.reduce((sum, ch) => sum + String(ch?.content || '').replace(/\s+/g, '').length, 0);
}

export function normalizeBookForSync(book) {
  const now = Date.now();
  const chapters = Array.isArray(book?.chapters) && book.chapters.length
    ? book.chapters.map((ch, idx) => ({
        id: String(ch?.id || `ch-${idx + 1}`),
        title: String(ch?.title || `第 ${idx + 1} 章`),
        content: String(ch?.content ?? ''),
      }))
    : [{ id: 'ch-1', title: '全文', content: '' }];

  return {
    id: String(book?.id || `bk-${now}`),
    title: String(book?.title || '未命名文件').trim() || '未命名文件',
    author: String(book?.author || '').trim(),
    category: String(book?.category || '隨手筆記').trim() || '隨手筆記',
    tags: Array.isArray(book?.tags) ? [...new Set(book.tags.map((t) => String(t).trim()).filter(Boolean))] : [],
    pinned: Boolean(book?.pinned),
    sourceType: String(book?.sourceType || 'text'),
    sourceUrl: String(book?.sourceUrl || ''),
    chapters,
    pdfBlobHash: book?.pdfBlobHash || null,
    pdfPageCount: Number.isFinite(book?.pdfPageCount) ? book.pdfPageCount : 0,
    isVerticalDefault: Boolean(book?.isVerticalDefault),
    clozeTerms: Array.isArray(book?.clozeTerms)
      ? [...new Set(book.clozeTerms.map((t) => String(t).trim()).filter(Boolean))]
      : [],
    clozeUpdatedAt: Number(book?.clozeUpdatedAt || book?.updatedAt || now),
    bookmarks: Array.isArray(book?.bookmarks) ? book.bookmarks.map((bm) => ({ ...bm })) : [],
    readingState: {
      chapterIndex: Number(book?.readingState?.chapterIndex || 0),
      paraIndex: Number(book?.readingState?.paraIndex || 0),
      scrollRatio: Number(book?.readingState?.scrollRatio || 0),
      pdfPage: Number(book?.readingState?.pdfPage || 1),
      viewMode: book?.readingState?.viewMode === 'pdf' ? 'pdf' : 'text',
      updatedAt: Number(book?.readingState?.updatedAt || 0),
    },
    subscription: book?.subscription ? { ...book.subscription } : null,
    createdAt: Number(book?.createdAt || now),
    updatedAt: Number(book?.updatedAt || now),
    contentUpdatedAt: Number(book?.contentUpdatedAt || book?.updatedAt || now),
    deletedAt: book?.deletedAt ? Number(book.deletedAt) : null,
  };
}

function mergeBookmarks(localList = [], remoteList = []) {
  const byId = new Map();
  for (const item of [...localList, ...remoteList]) {
    if (!item || !item.id) continue;
    const prev = byId.get(item.id);
    if (!prev || Number(item.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
      byId.set(item.id, { ...item });
    }
  }
  return [...byId.values()].filter((bm) => !bm.deletedAt || bm.deletedAt < Number(bm.updatedAt || 0));
}

/**
 * 雙向同步無損合併：內容採 contentUpdatedAt LWW，閱讀位置與書籤取最新或聯集
 */
export function mergeBooks(localRaw, remoteRaw) {
  if (!localRaw && !remoteRaw) return null;
  if (!localRaw) return normalizeBookForSync(remoteRaw);
  if (!remoteRaw) return normalizeBookForSync(localRaw);

  const local = normalizeBookForSync(localRaw);
  const remote = normalizeBookForSync(remoteRaw);

  const localDel = local.deletedAt || 0;
  const remoteDel = remote.deletedAt || 0;
  const maxContent = Math.max(local.contentUpdatedAt, remote.contentUpdatedAt);
  const maxDel = Math.max(localDel, remoteDel);

  const contentOwner = local.contentUpdatedAt >= remote.contentUpdatedAt ? local : remote;
  const metaOwner = local.updatedAt >= remote.updatedAt ? local : remote;
  const readingOwner =
    (local.readingState?.updatedAt || 0) >= (remote.readingState?.updatedAt || 0) ? local : remote;
  const clozeOwner = (local.clozeUpdatedAt || 0) >= (remote.clozeUpdatedAt || 0) ? local : remote;

  return {
    ...metaOwner,
    title: contentOwner.title,
    author: contentOwner.author,
    category: metaOwner.category,
    tags: metaOwner.tags,
    pinned: metaOwner.pinned,
    sourceType: contentOwner.sourceType,
    sourceUrl: contentOwner.sourceUrl,
    chapters: contentOwner.chapters,
    pdfBlobHash: contentOwner.pdfBlobHash || local.pdfBlobHash || remote.pdfBlobHash || null,
    pdfPageCount: contentOwner.pdfPageCount || local.pdfPageCount || remote.pdfPageCount || 0,
    isVerticalDefault: metaOwner.isVerticalDefault,
    clozeTerms: clozeOwner.clozeTerms,
    clozeUpdatedAt: clozeOwner.clozeUpdatedAt,
    bookmarks: mergeBookmarks(local.bookmarks, remote.bookmarks),
    readingState: { ...readingOwner.readingState },
    subscription: metaOwner.subscription || local.subscription || remote.subscription || null,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    contentUpdatedAt: maxContent,
    deletedAt: maxDel > maxContent ? maxDel : null,
  };
}

export function getStarterBooks(now = Date.now()) {
  return [
    normalizeBookForSync({
      id: 'starter-guide',
      title: '隨身閱讀使用指南（操作與背誦示範）',
      author: '隨身閱讀 PocketReader',
      category: '常用置頂',
      tags: ['指南', '快速上手'],
      pinned: true,
      sourceType: 'text',
      createdAt: now,
      updatedAt: now,
      contentUpdatedAt: now,
      clozeTerms: ['雙指縮放', '純文字重排', '背誦模式'],
      chapters: [
        {
          id: 'ch-1',
          title: '一、把重要資料收進手機離線隨身帶',
          content: [
            '出門在外要背講稿、查手冊或翻經典，最怕臨時在雲端資料夾找不到，或是手機開原版 PDF 字小到必須一直左右拖曳。',
            '透過「隨身閱讀 PocketReader」，你可以把 **PDF、EPUB 電子書、Word (.docx)、純文字 / Markdown** 或 **網頁文章** 全部變成 {{純文字重排}} 格式儲存在手機本機，沒有網路也能秒開。',
            '> 小提示：在閱讀畫面中直接用 **兩隻手指捏合或張開**（{{雙指縮放}}），就能即時無段放大縮小文字，文章會自動重新斷行，完全不會切到字！',
          ].join('\n\n'),
        },
        {
          id: 'ch-2',
          title: '二、背誦與語音複習技巧',
          content: [
            '點選閱讀器上方的「{{背誦模式}}」按鈕，可切換三種自我測驗方式：',
            '- **逐句遮罩**：把每一句或每一個短語蓋起來，點一下逐句揭露，或按底部「顯示下一句」一步步驗收。',
            '- **首字提示**：只顯示每句前 1～2 個字作為提示，最常用於經典、詩詞或簡報口條記憶。',
            '- **自訂挖空**：文字中用 `{{雙大括號}}` 或 `==雙等號==` 標記重點，或在閱讀頁加入關鍵詞，就會自動變成可點開的填空卡片。',
            '- **語音朗讀 (TTS)**：戴上耳機就能邊走邊聽，支援單段循環、全章循環與 A-B 重複聽背。',
          ].join('\n\n'),
        },
        {
          id: 'ch-3',
          title: '三、隨時隨地更新與分享同步',
          content: [
            '在電腦端整理好講義或更新手冊內容後，打開右上角「同步」設定同一組 **同步碼＋密碼**，手機一按「立即同步」就能把最新版本與原版 PDF 拉回離線書庫。',
            '也可以把單本書或整個分類產生 **8 碼分享碼／訂閱連結** 傳給同儕或夥伴；你後續修正錯字或補充章節後按「更新分享」，對方一按更新就能同步最新版本，且會完整保留他們自己的書籤與閱讀位置。',
          ].join('\n\n'),
        },
      ],
    }),
    normalizeBookForSync({
      id: 'starter-classics',
      title: '大學首章・心經（直書與背誦範本）',
      author: '經典選讀',
      category: '背誦經典',
      tags: ['經典', '背誦', '直書示範'],
      pinned: false,
      isVerticalDefault: true,
      sourceType: 'text',
      createdAt: now - 1000,
      updatedAt: now - 1000,
      contentUpdatedAt: now - 1000,
      clozeTerms: ['明明德', '親民', '止於至善', '色即是空'],
      chapters: [
        {
          id: 'ch-1',
          title: '大學・經一章',
          content: [
            '大學之道，在{{明明德}}，在{{親民}}，在{{止於至善}}。',
            '知止而後有定，定而後能靜，靜而後能安，安而後能慮，慮而後能得。',
            '物有本末，事有終始，知所先後，則近道矣。',
            '古之欲明明德於天下者，先治其國；欲治其國者，先齊其家；欲齊其家者，先修其身；欲修其身者，先正其心；欲正其心者，先誠其意；欲誠其意者，先致其知；致知在格物。',
            '物格而後知至，知至而後意誠，意誠而後心正，心正而後身修，身修而後家齊，家齊而後國治，國治而後天下平。',
            '自天子以至於庶人，壹是皆以修身為本。其本亂而末治者否矣；其所厚者薄，而其所薄者厚，未之有也。',
          ].join('\n\n'),
        },
        {
          id: 'ch-2',
          title: '般若波羅蜜多心經',
          content: [
            '觀自在菩薩，行深般若波羅蜜多時，照見五蘊皆空，度一切苦厄。',
            '舍利子，色不異空，空不異色，{{色即是空}}，空即是色，受想行識，亦復如是。',
            '舍利子，是諸法空相，不生不滅，不垢不淨，不增不減。',
            '是故空中無色，無受想行識，無眼耳鼻舌身意，無色聲香味觸法，無眼界，乃至無意識界。',
            '無無明，亦無無明盡，乃至無老死，亦無老死盡。無苦集滅道，無智亦無得，以無所得故。',
            '菩提薩埵，依般若波羅蜜多故，心無罣礙，無罣礙故，無有恐怖，遠離顛倒夢想，究竟涅槃。',
            '三世諸佛，依般若波羅蜜多故，得阿耨多羅三藐三菩提。',
            '故知般若波羅蜜多，是大神咒，是大明咒，是無上咒，是無等等咒，能除一切苦，真實不虛。',
            '故說般若波羅蜜多咒，即說咒曰：揭諦揭諦，波羅揭諦，波羅僧揭諦，菩提薩婆訶。',
          ].join('\n\n'),
        },
      ],
    }),
  ];
}
