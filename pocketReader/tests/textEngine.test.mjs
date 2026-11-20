import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  splitIntoChapters,
  reconstructPdfPageText,
  parseDocxXml,
  parseEpubXhtml,
  segmentSentences,
  renderParagraphHtml,
  searchLibrary,
  mergeBooks,
  normalizeBookForSync,
  getStarterBooks,
} from '../modules/textEngine.js';

test('escapeHtml safely escapes HTML special characters', () => {
  assert.equal(escapeHtml('<script>alert("x\'&")</script>'), '&lt;script&gt;alert(&quot;x&#39;&amp;&quot;)&lt;/script&gt;');
});

test('splitIntoChapters splits Markdown headings and Chinese chapter headers', () => {
  const md = [
    '# 第一章 初見',
    '第一段內容。',
    '',
    '# 第二章 進階',
    '第二段內容。',
  ].join('\n');
  const ch1 = splitIntoChapters(md);
  assert.equal(ch1.length, 2);
  assert.equal(ch1[0].title, '第一章 初見');
  assert.equal(ch1[1].title, '第二章 進階');

  const cn = [
    '前言說明文字',
    '',
    '第一回 緣起',
    '話說天下大勢。',
    '',
    '第二回 發展',
    '且看下文分解。',
  ].join('\n');
  const ch2 = splitIntoChapters(cn);
  assert.equal(ch2.length, 3);
  assert.equal(ch2[0].title, '前言');
  assert.equal(ch2[1].title, '第一回 緣起');
  assert.equal(ch2[2].title, '第二回 發展');
});

test('reconstructPdfPageText merges CJK soft-wraps and detects paragraph breaks (horizontal)', () => {
  const items = [
    // Line 1 (full width, no terminal punctuation -> wraps to line 2)
    { str: '這是一段很長的中文測試文字用來檢查軟換', transform: [12, 0, 0, 12, 50, 700], width: 320, height: 12 },
    // Line 2 (ends with period and shorter)
    { str: '行會自動接在一起。', transform: [12, 0, 0, 12, 50, 684], width: 120, height: 12 },
    // Line 3 (big vertical gap / new paragraph)
    { str: '這是第二段開頭。', transform: [12, 0, 0, 12, 50, 650], width: 110, height: 12 },
  ];
  const res = reconstructPdfPageText(items);
  assert.equal(res.isVertical, false);
  assert.equal(res.text, '這是一段很長的中文測試文字用來檢查軟換行會自動接在一起。\n\n這是第二段開頭。');
});

test('reconstructPdfPageText detects vertical-rl columns and reads right-to-left top-to-bottom', () => {
  // Right column x=300, Left column x=260; characters stacked downwards
  const items = [
    { str: '大', transform: [14, 0, 0, 14, 300, 700], width: 14, height: 14 },
    { str: '學', transform: [14, 0, 0, 14, 300, 682], width: 14, height: 14 },
    { str: '之', transform: [14, 0, 0, 14, 300, 664], width: 14, height: 14 },
    { str: '道', transform: [14, 0, 0, 14, 300, 646], width: 14, height: 14 },
    { str: '，', transform: [14, 0, 0, 14, 300, 628], width: 14, height: 14 },
    { str: '在', transform: [14, 0, 0, 14, 260, 700], width: 14, height: 14 },
    { str: '明', transform: [14, 0, 0, 14, 260, 682], width: 14, height: 14 },
    { str: '明', transform: [14, 0, 0, 14, 260, 664], width: 14, height: 14 },
    { str: '德', transform: [14, 0, 0, 14, 260, 646], width: 14, height: 14 },
    { str: '。', transform: [14, 0, 0, 14, 260, 628], width: 14, height: 14 },
  ];
  const res = reconstructPdfPageText(items);
  assert.equal(res.isVertical, true);
  assert.equal(res.text, '大學之道，在明明德。');
});

test('parseDocxXml extracts headings, paragraphs, and Markdown tables cleanly', () => {
  const xml = `
    <w:document><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>工作手冊</w:t></w:r></w:p>
      <w:p><w:r><w:t>第一條注意事項 &amp; 說明</w:t></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>項目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>負責人</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>報到</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>小明</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    </w:body></w:document>
  `;
  const md = parseDocxXml(xml);
  assert.match(md, /^# 工作手冊/m);
  assert.match(md, /第一條注意事項 & 說明/);
  assert.match(md, /\| 項目 \| 負責人 \|/);
  assert.match(md, /\| 報到 \| 小明 \|/);
});

test('parseEpubXhtml strips scripts/nav and preserves structured text', () => {
  const xhtml = `
    <html><head><title>章節一</title></head>
    <body>
      <nav>目錄導覽</nav>
      <script>alert(1)</script>
      <h1>序言</h1>
      <p>這是<strong>重要</strong>段落。</p>
      <ul><li>第一點</li><li>第二點</li></ul>
    </body></html>
  `;
  const res = parseEpubXhtml(xhtml);
  assert.equal(res.title, '章節一');
  assert.doesNotMatch(res.text, /alert/);
  assert.doesNotMatch(res.text, /目錄導覽/);
  assert.match(res.text, /# 序言/);
  assert.match(res.text, /\*\*重要\*\*/);
  assert.match(res.text, /- 第一點/);
});

test('segmentSentences respects sentence vs clause granularity and keeps closing quotes', () => {
  const s = '孔子曰：「學而時習之，不亦說乎？」有朋自遠方來。';
  const bySentence = segmentSentences(s, 'sentence');
  assert.equal(bySentence.length, 2);
  assert.equal(bySentence[0], '孔子曰：「學而時習之，不亦說乎？」');

  const byClause = segmentSentences(s, 'clause');
  assert.equal(byClause.length, 4);
});

test('renderParagraphHtml handles mask, first-char, cloze modes and XSS safety', () => {
  const xss = renderParagraphHtml('<img src=x onerror=alert(1)>測試', { paraIdx: 0 });
  assert.doesNotMatch(xss, /<img/);
  assert.match(xss, /&lt;img/);

  const maskHtml = renderParagraphHtml('第一句。第二句。', {
    paraIdx: 0,
    reciteMode: 'mask',
    revealedUnits: new Set(['0:0']),
  });
  assert.match(maskHtml, /data-unit-key="0:0"/);
  assert.match(maskHtml, /class="recite-unit is-revealed"/);
  assert.match(maskHtml, /class="recite-unit is-masked" data-unit-key="0:1"/);

  const firstCharHtml = renderParagraphHtml('觀自在菩薩，行深般若波羅蜜多時。', {
    paraIdx: 1,
    reciteMode: 'first-char',
    hintChars: 2,
  });
  assert.match(firstCharHtml, /<span class="recite-hint">觀自<\/span>/);
  assert.match(firstCharHtml, /<span class="recite-rest">在菩薩，行深般若波羅蜜多時。<\/span>/);

  const clozeHtml = renderParagraphHtml('大學之道，在{{明明德}}，在親民。', {
    paraIdx: 2,
    reciteMode: 'cloze',
    clozeTerms: ['親民'],
  });
  assert.match(clozeHtml, /data-unit-key="cloze:2:0"[^>]*>明明德<\/span>/);
  assert.match(clozeHtml, /data-unit-key="cloze:2:1"[^>]*>親民<\/span>/);
});

test('searchLibrary performs multi-keyword full-text search with exact jump coordinates', () => {
  const books = getStarterBooks(1000);
  const hits = searchLibrary(books, '大學 明明德');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bookId, 'starter-classics');
  assert.equal(hits[0].chapterIndex, 0);
  assert.equal(hits[0].paraIndex, 0);
  assert.match(hits[0].snippet, /大學之道/);
});

test('mergeBooks preserves newer content, newest reading position, and union of bookmarks', () => {
  const local = normalizeBookForSync({
    id: 'bk-1',
    title: '舊標題',
    chapters: [{ id: 'ch-1', title: '一', content: '舊文字' }],
    bookmarks: [{ id: 'bm-a', chapterIndex: 0, paraIndex: 1, updatedAt: 100 }],
    readingState: { chapterIndex: 0, paraIndex: 4, updatedAt: 300 },
    contentUpdatedAt: 100,
    updatedAt: 300,
  });

  const remote = normalizeBookForSync({
    id: 'bk-1',
    title: '新標題',
    chapters: [{ id: 'ch-1', title: '一', content: '電腦更新後的最新文字' }],
    bookmarks: [{ id: 'bm-b', chapterIndex: 0, paraIndex: 2, updatedAt: 250 }],
    readingState: { chapterIndex: 0, paraIndex: 1, updatedAt: 150 },
    contentUpdatedAt: 250,
    updatedAt: 250,
  });

  const merged = mergeBooks(local, remote);
  assert.equal(merged.title, '新標題');
  assert.equal(merged.chapters[0].content, '電腦更新後的最新文字');
  assert.equal(merged.readingState.paraIndex, 4);
  assert.equal(merged.bookmarks.length, 2);
});
