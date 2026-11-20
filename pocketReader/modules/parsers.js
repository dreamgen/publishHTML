/**
 * 隨身閱讀 PocketReader — 多格式檔案解析與離線 OCR 引擎
 * 重用同網域 ../pdfEditor/vendor/ 下的 PDF.js、Tesseract.js 與 fflate
 */

import {
  splitIntoChapters,
  reconstructPdfPageText,
  parseDocxXml,
  parseEpubXhtml,
  decodeHtmlEntities,
} from './textEngine.js';

let pdfjsPromise = null;
let fflatePromise = null;
let tesseractPromise = null;
let ocrWorker = null;
let ocrWorkerLangKey = null;
let ocrIdleTimer = null;

const OCR_LANGUAGE_MODES = {
  'chi_tra+eng': {
    langs: ['chi_tra', 'eng'],
    label: '繁體中文＋英文（橫排）',
    vertical: false,
  },
  'chi_tra_vert+chi_tra': {
    langs: ['chi_tra_vert', 'chi_tra'],
    label: '繁體中文直排',
    vertical: true,
    psm: '3',
  },
};

function stripFileExt(filename) {
  return String(filename || '未命名文件').replace(/\.[^.]+$/, '').trim() || '未命名文件';
}

function loadScriptOnce(src, globalCheck) {
  if (globalCheck()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-pr-src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`無法載入元件：${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.dataset.prSrc = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`無法載入元件：${src}`));
    document.head.appendChild(script);
  });
}

export async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../../pdfEditor/vendor/pdfjs/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs-worker-bridge.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

export function getPdfJsDocParams(data, password) {
  // Always copy bytes so PDF.js worker transfer never detaches the caller's ArrayBuffer
  const copy = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
  return {
    data: copy,
    password: password || undefined,
    isEvalSupported: false,
    useWorkerFetch: false,
    standardFontDataUrl: new URL('../../pdfEditor/vendor/pdfjs/standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('../../pdfEditor/vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    wasmUrl: new URL('../../pdfEditor/vendor/pdfjs/wasm/', import.meta.url).href,
    useSystemFonts: true,
  };
}

async function ensureFflate() {
  if (!fflatePromise) {
    const src = new URL('../../pdfEditor/vendor/fflate/fflate.min.js', import.meta.url).href;
    fflatePromise = loadScriptOnce(src, () => Boolean(window.fflate));
  }
  await fflatePromise;
  if (!window.fflate?.unzipSync) {
    throw new Error('ZIP 解壓元件載入失敗');
  }
  return window.fflate;
}

async function ensureTesseract() {
  if (!tesseractPromise) {
    const src = new URL('../../pdfEditor/vendor/tesseract/tesseract.min.js', import.meta.url).href;
    tesseractPromise = loadScriptOnce(src, () => Boolean(window.Tesseract?.createWorker));
  }
  await tesseractPromise;
  if (!window.Tesseract?.createWorker) {
    throw new Error('離線 OCR 元件載入失敗');
  }
  return window.Tesseract;
}

export async function parseTextFile(file) {
  const buffer = await file.arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      text = new TextDecoder('big5').decode(buffer);
    } catch {
      text = new TextDecoder('utf-8').decode(buffer);
    }
  }
  text = text.replace(/^\uFEFF/, '');
  const title = stripFileExt(file.name);
  const isMd = /\.(md|markdown)$/i.test(file.name || '');
  const chapters = splitIntoChapters(text, { defaultTitle: title, splitOnH2: isMd });
  return {
    title,
    sourceType: isMd ? 'md' : 'txt',
    chapters,
  };
}

async function resolveOutlineChapters(pdfDoc, pageTexts) {
  try {
    const outline = await pdfDoc.getOutline();
    if (!Array.isArray(outline) || outline.length < 2) return null;

    const entries = [];
    const walk = async (nodes, depth = 0) => {
      for (const node of nodes) {
        if (!node?.title) continue;
        let pageIndex = null;
        try {
          let dest = node.dest;
          if (typeof dest === 'string') {
            dest = await pdfDoc.getDestination(dest);
          }
          if (Array.isArray(dest) && dest[0]) {
            pageIndex = await pdfDoc.getPageIndex(dest[0]);
          }
        } catch {
          pageIndex = null;
        }
        if (Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageTexts.length) {
          entries.push({ title: node.title.trim(), pageIndex, depth });
        }
        if (depth < 1 && Array.isArray(node.items) && node.items.length) {
          await walk(node.items, depth + 1);
        }
      }
    };
    await walk(outline, 0);
    if (entries.length < 2) return null;

    entries.sort((a, b) => a.pageIndex - b.pageIndex);
    // Deduplicate same start page keeping first
    const deduped = [];
    for (const e of entries) {
      if (!deduped.length || e.pageIndex > deduped[deduped.length - 1].pageIndex) {
        deduped.push(e);
      }
    }
    if (deduped.length < 2) return null;

    const chapters = [];
    if (deduped[0].pageIndex > 0) {
      const pre = pageTexts.slice(0, deduped[0].pageIndex).filter(Boolean).join('\n\n');
      if (pre) chapters.push({ id: `ch-${chapters.length + 1}`, title: '封面與前言', content: pre });
    }
    for (let i = 0; i < deduped.length; i++) {
      const start = deduped[i].pageIndex;
      const end = i + 1 < deduped.length ? deduped[i + 1].pageIndex : pageTexts.length;
      const body = pageTexts
        .slice(start, end)
        .map((t, idx) => (t ? `### 第 ${start + idx + 1} 頁\n\n${t}` : ''))
        .filter(Boolean)
        .join('\n\n');
      chapters.push({
        id: `ch-${chapters.length + 1}`,
        title: deduped[i].title,
        content: body || `（第 ${start + 1} 頁無文字）`,
      });
    }
    return chapters;
  } catch {
    return null;
  }
}

export function buildChaptersFromPages(pageTexts, { defaultTitle = '全文', pagesPerChapter = 10 } = {}) {
  const total = pageTexts.length;
  if (total === 0) return [{ id: 'ch-1', title: defaultTitle, content: '' }];

  // Try natural chapter heading splitting first if merged text has clear chapters
  const joinedAll = pageTexts.filter(Boolean).join('\n\n');
  if (total <= 60 && joinedAll) {
    const byHeadings = splitIntoChapters(joinedAll, { defaultTitle });
    if (byHeadings.length >= 2 && byHeadings.length <= 80) {
      return byHeadings;
    }
  }

  if (total <= 12) {
    const content = pageTexts
      .map((t, idx) => (total === 1 ? t : t ? `### 第 ${idx + 1} 頁\n\n${t}` : ''))
      .filter(Boolean)
      .join('\n\n');
    return [{ id: 'ch-1', title: defaultTitle, content: content || '（未偵測到內嵌文字）' }];
  }

  const chapters = [];
  for (let start = 0; start < total; start += pagesPerChapter) {
    const end = Math.min(total, start + pagesPerChapter);
    const body = pageTexts
      .slice(start, end)
      .map((t, offset) => (t ? `### 第 ${start + offset + 1} 頁\n\n${t}` : ''))
      .filter(Boolean)
      .join('\n\n');
    chapters.push({
      id: `ch-${chapters.length + 1}`,
      title: `第 ${start + 1}–${end} 頁`,
      content: body || `（第 ${start + 1}–${end} 頁無內嵌文字）`,
    });
  }
  return chapters;
}

export async function extractPdfBook(arrayBuffer, { title = 'PDF 文件', password = '', onProgress } = {}) {
  const pdfjsLib = await getPdfJs();
  const loadingTask = pdfjsLib.getDocument(getPdfJsDocParams(arrayBuffer, password));
  let pdfDoc = null;

  try {
    pdfDoc = await loadingTask.promise;
    const total = pdfDoc.numPages;
    const pageTexts = [];
    let verticalCount = 0;
    let totalChars = 0;

    for (let pageNum = 1; pageNum <= total; pageNum++) {
      onProgress?.({ page: pageNum, total, phase: 'extract' });
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const { text, isVertical } = reconstructPdfPageText(textContent.items, viewport);
      if (isVertical) verticalCount++;
      totalChars += text.replace(/\s+/g, '').length;
      pageTexts.push(text);
    }

    let docTitle = stripFileExt(title);
    let author = '';
    try {
      const meta = await pdfDoc.getMetadata();
      const metaTitle = String(meta?.info?.Title || '').trim();
      const metaAuthor = String(meta?.info?.Author || '').trim();
      if (metaTitle && !/^untitled$/i.test(metaTitle) && docTitle === 'PDF 文件') {
        docTitle = metaTitle;
      }
      if (metaAuthor) author = metaAuthor;
    } catch {
      // ignore metadata error
    }

    const outlineChapters = await resolveOutlineChapters(pdfDoc, pageTexts);
    const chapters = outlineChapters || buildChaptersFromPages(pageTexts, { defaultTitle: docTitle });
    const avgCharsPerPage = total > 0 ? totalChars / total : 0;

    return {
      title: docTitle,
      author,
      sourceType: 'pdf',
      chapters,
      pageCount: total,
      totalChars,
      avgCharsPerPage,
      likelyScanned: total > 0 && avgCharsPerPage < 18,
      isVerticalDefault: verticalCount > total * 0.5,
    };
  } finally {
    try {
      await (loadingTask?.destroy?.() ?? pdfDoc?.destroy?.());
    } catch {
      // ignore
    }
  }
}

function scheduleOcrCleanup() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(async () => {
    if (ocrWorker) {
      const w = ocrWorker;
      ocrWorker = null;
      ocrWorkerLangKey = null;
      await w.terminate().catch(() => {});
    }
  }, 3 * 60 * 1000);
}

async function getOcrWorker(langKey, onLogger) {
  const mode = OCR_LANGUAGE_MODES[langKey] || OCR_LANGUAGE_MODES['chi_tra+eng'];
  clearTimeout(ocrIdleTimer);

  if (ocrWorker && ocrWorkerLangKey === langKey) {
    return ocrWorker;
  }
  if (ocrWorker) {
    const stale = ocrWorker;
    ocrWorker = null;
    ocrWorkerLangKey = null;
    await stale.terminate().catch(() => {});
  }

  const Tesseract = await ensureTesseract();
  const worker = await Tesseract.createWorker(mode.langs, Tesseract.OEM?.LSTM_ONLY ?? 1, {
    workerPath: new URL('../vendor/tesseract-worker-bridge.js', import.meta.url).href,
    corePath: new URL('../../pdfEditor/vendor/tesseract/core/', import.meta.url).href,
    langPath: new URL('../../pdfEditor/vendor/tesseract/lang-data/', import.meta.url).href,
    workerBlobURL: false,
    gzip: true,
    logger: (msg) => onLogger?.(msg),
    errorHandler: (err) => console.error('[PocketReader OCR]', err),
  });

  if (mode.psm) {
    await worker.setParameters({ tessedit_pageseg_mode: String(mode.psm) });
  }
  ocrWorker = worker;
  ocrWorkerLangKey = langKey;
  return ocrWorker;
}

export async function runPdfOcr(
  arrayBuffer,
  { langMode = 'chi_tra+eng', password = '', onProgress, signal } = {}
) {
  const pdfjsLib = await getPdfJs();
  const loadingTask = pdfjsLib.getDocument(getPdfJsDocParams(arrayBuffer, password));
  let pdfDoc = null;
  let currentPage = 0;
  let totalPages = 0;

  try {
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages;
    onProgress?.({ page: 0, total: totalPages, progress: 0.02, status: '準備離線 OCR 引擎…' });

    const worker = await getOcrWorker(langMode, (msg) => {
      const p = Number.isFinite(msg?.progress) ? msg.progress : 0;
      const base = totalPages && currentPage ? (currentPage - 1) / totalPages : 0;
      const pct = totalPages ? Math.min(0.99, base + p / totalPages) : p * 0.1;
      const labels = {
        'loading tesseract core': '載入 OCR 核心',
        'initializing tesseract': '初始化 OCR',
        'loading language traineddata': '載入繁中／英文語言模型',
        'initializing api': '初始化辨識引擎',
        'recognizing text': `辨識第 ${currentPage || 1} / ${totalPages} 頁`,
      };
      onProgress?.({
        page: currentPage,
        total: totalPages,
        progress: pct,
        status: labels[msg?.status] || '處理 OCR…',
      });
    });

    const pageTexts = [];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (signal?.aborted) break;
      currentPage = pageNum;
      onProgress?.({
        page: pageNum,
        total: totalPages,
        progress: (pageNum - 1) / totalPages,
        status: `渲染並辨識第 ${pageNum} / ${totalPages} 頁`,
      });

      const page = await pdfDoc.getPage(pageNum);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = Math.min(2.0, 2200 / Math.max(baseVp.width, baseVp.height, 1));
      const vp = page.getViewport({ scale: Math.max(1.2, scale) });
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (signal?.aborted) break;

      const { data } = await worker.recognize(canvas);
      const raw = String(data?.text || '')
        .replace(/\r\n?/g, '\n')
        // Clean stray spaces between CJK chars produced by OCR
        .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      pageTexts.push(raw);
    }

    const chapters = buildChaptersFromPages(pageTexts, { defaultTitle: 'OCR 辨識文字' });
    return {
      chapters,
      recognizedPages: pageTexts.length,
      totalPages,
      cancelled: Boolean(signal?.aborted),
      isVerticalDefault: langMode === 'chi_tra_vert+chi_tra',
    };
  } finally {
    scheduleOcrCleanup();
    try {
      await (loadingTask?.destroy?.() ?? pdfDoc?.destroy?.());
    } catch {
      // ignore
    }
  }
}

export async function parseDocxFile(file) {
  const fflate = await ensureFflate();
  const buf = new Uint8Array(await file.arrayBuffer());
  const files = fflate.unzipSync(buf);

  const docBytes = files['word/document.xml'];
  if (!docBytes) {
    throw new Error('此檔案不是有效的 .docx 文件（缺少 word/document.xml）');
  }
  const xml = new TextDecoder('utf-8').decode(docBytes);
  const text = parseDocxXml(xml);

  let title = stripFileExt(file.name);
  let author = '';
  if (files['docProps/core.xml']) {
    const coreXml = new TextDecoder('utf-8').decode(files['docProps/core.xml']);
    const tm = coreXml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
    const cm = coreXml.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i);
    if (tm && tm[1].trim() && title === '未命名文件') title = decodeHtmlEntities(tm[1].trim());
    if (cm && cm[1].trim()) author = decodeHtmlEntities(cm[1].trim());
  }

  const chapters = splitIntoChapters(text, { defaultTitle: title });
  return {
    title,
    author,
    sourceType: 'docx',
    chapters,
  };
}

function resolveZipPath(baseFile, relPath) {
  const cleanRel = relPath.split('#')[0];
  if (!baseFile || !baseFile.includes('/')) return cleanRel.replace(/^\.\//, '');
  const dir = baseFile.slice(0, baseFile.lastIndexOf('/'));
  const parts = `${dir}/${cleanRel}`.split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function findZipEntry(files, path) {
  if (files[path]) return files[path];
  const decoded = decodeURIComponent(path);
  if (files[decoded]) return files[decoded];
  const lower = decoded.toLowerCase();
  const hit = Object.keys(files).find((k) => k.toLowerCase() === lower);
  return hit ? files[hit] : null;
}

export async function parseEpubFile(file) {
  const fflate = await ensureFflate();
  const buf = new Uint8Array(await file.arrayBuffer());
  const files = fflate.unzipSync(buf);
  const decoder = new TextDecoder('utf-8');

  const containerBytes = findZipEntry(files, 'META-INF/container.xml');
  if (!containerBytes) {
    throw new Error('無效的 EPUB 檔案（缺少 container.xml）');
  }
  const containerXml = decoder.decode(containerBytes);
  const rootMatch = containerXml.match(/full-path=["']([^"']+)["']/i);
  if (!rootMatch) throw new Error('無法定位 EPUB 目錄檔 (.opf)');

  const opfPath = rootMatch[1];
  const opfBytes = findZipEntry(files, opfPath);
  if (!opfBytes) throw new Error('找不到 EPUB 內容描述檔 (.opf)');
  const opfXml = decoder.decode(opfBytes);

  const metaTitle = opfXml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
  const metaCreator = opfXml.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i);
  const title = metaTitle?.[1]?.trim()
    ? decodeHtmlEntities(metaTitle[1].replace(/<[^>]+>/g, '').trim())
    : stripFileExt(file.name);
  const author = metaCreator?.[1]?.trim()
    ? decodeHtmlEntities(metaCreator[1].replace(/<[^>]+>/g, '').trim())
    : '';

  // Map manifest id -> href
  const manifest = new Map();
  const itemRe = /<item\b([^>]+)\/?>/gi;
  let im;
  while ((im = itemRe.exec(opfXml)) !== null) {
    const attrs = im[1];
    const idM = attrs.match(/\bid=["']([^"']+)["']/i);
    const hrefM = attrs.match(/\bhref=["']([^"']+)["']/i);
    const typeM = attrs.match(/\bmedia-type=["']([^"']+)["']/i);
    if (idM && hrefM) {
      manifest.set(idM[1], {
        href: hrefM[1],
        mediaType: typeM ? typeM[1] : '',
        fullPath: resolveZipPath(opfPath, hrefM[1]),
      });
    }
  }

  // Optional TOC title lookup from toc.ncx
  const tocTitles = new Map();
  for (const item of manifest.values()) {
    if (item.mediaType.includes('ncx') || item.href.endsWith('.ncx')) {
      const ncxBytes = findZipEntry(files, item.fullPath);
      if (ncxBytes) {
        const ncx = decoder.decode(ncxBytes);
        const navRe = /<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*src=["']([^"']+)["']/gi;
        let nm;
        while ((nm = navRe.exec(ncx)) !== null) {
          const full = resolveZipPath(item.fullPath, nm[2]);
          if (!tocTitles.has(full)) {
            tocTitles.set(full, decodeHtmlEntities(nm[1].replace(/<[^>]+>/g, '').trim()));
          }
        }
      }
    }
  }

  // Walk spine itemrefs
  const spineHrefs = [];
  const spineRe = /<itemref\b[^>]*\bidref=["']([^"']+)["'][^>]*\/?>/gi;
  let sm;
  while ((sm = spineRe.exec(opfXml)) !== null) {
    const entry = manifest.get(sm[1]);
    if (entry) spineHrefs.push(entry);
  }

  const chapters = [];
  for (const entry of spineHrefs) {
    const bytes = findZipEntry(files, entry.fullPath);
    if (!bytes) continue;
    const xhtml = decoder.decode(bytes);
    const { title: pageTitle, text } = parseEpubXhtml(xhtml);
    if (!text || text.length < 2) continue;

    const firstHeading = text.match(/^#{1,3}\s+(.+)$/m)?.[1];
    const chTitle =
      tocTitles.get(entry.fullPath) ||
      firstHeading ||
      (pageTitle && pageTitle !== title ? pageTitle : `第 ${chapters.length + 1} 節`);

    chapters.push({
      id: `ch-${chapters.length + 1}`,
      title: chTitle,
      content: text,
    });
  }

  if (!chapters.length) {
    throw new Error('EPUB 檔案中沒有可讀取的文字章節');
  }

  return {
    title,
    author,
    sourceType: 'epub',
    chapters,
  };
}

export async function fetchWebArticle(targetUrl, { workerUrl = '', fallbackCorsProxyUrl = '' } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl.trim());
    if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error('僅支援 http / https 網址');
  } catch {
    throw new Error('請輸入有效的網頁網址（須包含 https:// 或 http://）');
  }

  const endpoints = [];
  if (workerUrl) {
    endpoints.push(`${workerUrl.replace(/\/$/, '')}/api/fetch-url?url=${encodeURIComponent(parsedUrl.href)}`);
  }
  if (fallbackCorsProxyUrl) {
    endpoints.push(`${fallbackCorsProxyUrl}${encodeURIComponent(parsedUrl.href)}`);
  }

  let html = '';
  let lastErr = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, { signal: AbortSignal.timeout(18000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text && text.length > 80) {
        html = text;
        break;
      }
    } catch (err) {
      lastErr = err;
    }
  }

  if (!html) {
    throw new Error(`無法擷取該網頁（${lastErr?.message || '請確認連線或同步 Worker 設定'}）`);
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    doc.querySelector('h1')?.textContent?.trim() ||
    doc.title?.trim() ||
    parsedUrl.hostname;

  doc
    .querySelectorAll('script, style, noscript, nav, footer, aside, header, form, iframe, svg, .ad, .ads, .advertisement')
    .forEach((el) => el.remove());

  const candidates = [
    doc.querySelector('article'),
    doc.querySelector('main'),
    doc.querySelector('[role="main"]'),
    doc.querySelector('.post-content, .article-content, .entry-content, #content, #article'),
    doc.body,
  ].filter(Boolean);

  let bestNode = doc.body;
  let bestScore = -1;
  for (const cand of candidates) {
    const pLen = [...cand.querySelectorAll('p, h1, h2, h3, li, blockquote')]
      .map((n) => n.textContent.trim().length)
      .reduce((a, b) => a + b, 0);
    if (pLen > bestScore) {
      bestScore = pLen;
      bestNode = cand;
    }
  }

  if (!bestNode) throw new Error('此網頁沒有可擷取的正文內容');
  const { text } = parseEpubXhtml(bestNode.innerHTML || '');
  if (!text) throw new Error('此網頁正文為空（可能是純動態載入頁面）');

  const chapters = splitIntoChapters(text, { defaultTitle: title });
  return {
    title,
    sourceType: 'web',
    sourceUrl: parsedUrl.href,
    chapters,
  };
}
