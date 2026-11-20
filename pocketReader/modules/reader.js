/**
 * 隨身閱讀 PocketReader — 閱讀器互動控制器
 * 支援：純文字重排、雙指縮放文字、經典直書/橫書、背誦遮罩/首字/挖空、原版 PDF 切換、文內搜尋與 Wake Lock
 */

import {
  escapeHtml,
  parseChapterBlocks,
  renderParagraphHtml,
  normalizeSearchText,
} from './textEngine.js';
import { getPdfJs, getPdfJsDocParams } from './parsers.js';

export const DEFAULT_READER_PREFS = {
  fontSize: 20,
  lineHeight: 1.85,
  letterSpacing: 0.02,
  fontFamily: 'sans', // sans | serif | kai | mono
  theme: 'paper', // paper | sepia | slate | oled | contrast
  maxWidth: 740,
  reciteMode: 'off', // off | mask | first-char | cloze
  granularity: 'sentence', // sentence | clause
  hintChars: 1,
};

const FONT_STACKS = {
  sans: "system-ui, -apple-system, 'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei', sans-serif",
  serif: "'Songti TC', 'Noto Serif TC', 'PMingLiU', 'Times New Roman', serif",
  kai: "'BiauKai', 'DFKai-SB', 'Kaiti TC', 'TW-Kai', 'Noto Serif TC', serif",
  mono: "'SFMono-Regular', Menlo, Consolas, 'Noto Sans Mono CJK TC', monospace",
};

export class ReaderController {
  constructor(els, callbacks = {}) {
    this.els = els;
    this.cb = callbacks;

    this.book = null;
    this.chapterIndex = 0;
    this.prefs = { ...DEFAULT_READER_PREFS };
    this.isVertical = false;
    this.viewMode = 'text'; // 'text' | 'pdf'
    this.revealedUnits = new Set();
    this.activeTtsPara = null;

    this.searchQuery = '';
    this.searchHits = [];
    this.searchCursor = -1;

    this.wakeLockEnabled = false;
    this.wakeLockSentinel = null;

    // Pinch state
    this._pinchActive = false;
    this._pinchStartDist = 0;
    this._pinchStartSize = 20;
    this._pinchAnchor = null;
    this._zoomHudTimer = null;
    this._saveProgressTimer = null;

    // PDF original view state
    this.pdfLoadingTask = null;
    this.pdfDoc = null;
    this.pdfPage = 1;
    this.pdfScale = 1.25;
    this.pdfRenderToken = 0;
    this.pdfHashLoaded = null;

    this._bindEvents();
  }

  _bindEvents() {
    const area = this.els.scrollArea;

    // Pinch-to-zoom ONLY for 2 touches; single finger scroll stays 100% native
    area.addEventListener(
      'touchstart',
      (e) => {
        if (this.viewMode !== 'text') return;
        if (e.touches.length === 2) {
          this._pinchActive = true;
          this._pinchStartDist = this._touchDist(e.touches[0], e.touches[1]);
          this._pinchStartSize = this.prefs.fontSize;
          this._pinchAnchor = this._captureTopAnchor();
        }
      },
      { passive: true }
    );

    area.addEventListener(
      'touchmove',
      (e) => {
        if (!this._pinchActive || this.viewMode !== 'text') return;
        if (e.touches.length !== 2) return;
        e.preventDefault();
        const dist = this._touchDist(e.touches[0], e.touches[1]);
        if (this._pinchStartDist < 10) return;
        const ratio = dist / this._pinchStartDist;
        const nextSize = Math.min(44, Math.max(14, Math.round(this._pinchStartSize * ratio)));
        if (nextSize !== this.prefs.fontSize) {
          this.setFontSize(nextSize, { preserveAnchor: this._pinchAnchor, silentSave: true, showHud: true });
        } else {
          this._showZoomHud(nextSize);
        }
      },
      { passive: false }
    );

    const endPinch = () => {
      if (!this._pinchActive) return;
      this._pinchActive = false;
      this._pinchAnchor = null;
      this.cb.onPrefsChange?.({ ...this.prefs });
    };
    area.addEventListener('touchend', endPinch, { passive: true });
    area.addEventListener('touchcancel', endPinch, { passive: true });

    // Desktop Ctrl+Wheel / Trackpad pinch zoom + Vertical-RL wheel conversion
    area.addEventListener(
      'wheel',
      (e) => {
        if (this.viewMode !== 'text') return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 1 : -1;
          this.setFontSize(this.prefs.fontSize + delta, { showHud: true });
          return;
        }
        if (this.isVertical && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          area.scrollLeft -= e.deltaY;
        }
      },
      { passive: false }
    );

    // Track scroll progress debounced
    area.addEventListener(
      'scroll',
      () => {
        if (!this.book || this.viewMode !== 'text') return;
        this.cb.onProgressUpdate?.(this.computeProgress());
        clearTimeout(this._saveProgressTimer);
        this._saveProgressTimer = setTimeout(() => {
          this.persistReadingPosition();
        }, 350);
      },
      { passive: true }
    );

    // Article delegation: tap recite/cloze units OR tap center to toggle bars
    this.els.article.addEventListener('click', (e) => {
      const unit = e.target.closest('.recite-unit, .cloze-blank');
      if (unit) {
        e.stopPropagation();
        const key = unit.dataset.unitKey;
        if (key) {
          if (this.revealedUnits.has(key)) {
            this.revealedUnits.delete(key);
            unit.classList.remove('is-revealed');
            unit.classList.add('is-masked');
            unit.setAttribute('aria-pressed', 'false');
          } else {
            this.revealedUnits.add(key);
            unit.classList.add('is-revealed');
            unit.classList.remove('is-masked');
            unit.setAttribute('aria-pressed', 'true');
          }
        }
        return;
      }

      if (e.target.closest('a, button')) return;
      const sel = window.getSelection?.();
      if (sel && sel.toString().trim().length > 0) return;

      this.cb.onCanvasTap?.();
    });

    // Paragraph context menu / long-press action menu
    let pressTimer = null;
    this.els.article.addEventListener('contextmenu', (e) => {
      const para = e.target.closest('[data-para-idx]');
      if (!para) return;
      e.preventDefault();
      this.cb.onParagraphAction?.(Number(para.dataset.paraIdx), para.textContent || '');
    });

    this.els.article.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) {
          clearTimeout(pressTimer);
          return;
        }
        const para = e.target.closest('[data-para-idx]');
        if (!para) return;
        const startX = e.touches[0].clientX;
        const startY = e.touches[0].clientY;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          this.cb.onParagraphAction?.(Number(para.dataset.paraIdx), para.textContent || '');
        }, 520);

        const cancelMove = (mv) => {
          if (!mv.touches[0]) return;
          if (Math.hypot(mv.touches[0].clientX - startX, mv.touches[0].clientY - startY) > 12) {
            clearTimeout(pressTimer);
            this.els.article.removeEventListener('touchmove', cancelMove);
          }
        };
        const cancelEnd = () => {
          clearTimeout(pressTimer);
          this.els.article.removeEventListener('touchmove', cancelMove);
          this.els.article.removeEventListener('touchend', cancelEnd);
        };
        this.els.article.addEventListener('touchmove', cancelMove, { passive: true });
        this.els.article.addEventListener('touchend', cancelEnd, { passive: true });
      },
      { passive: true }
    );

    // Re-acquire wake lock when returning to foreground
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wakeLockEnabled) {
        this._requestWakeLock();
      }
    });
  }

  _touchDist(t1, t2) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  }

  setPrefs(prefs) {
    this.prefs = { ...DEFAULT_READER_PREFS, ...prefs };
    this.applyAppearance();
  }

  applyAppearance() {
    const stage = this.els.stage;
    const root = this.els.readerView;
    root.dataset.readerTheme = this.prefs.theme || 'paper';

    stage.style.setProperty('--reader-font-size', `${this.prefs.fontSize}px`);
    stage.style.setProperty('--reader-line-height', String(this.prefs.lineHeight));
    stage.style.setProperty('--reader-letter-spacing', `${this.prefs.letterSpacing}em`);
    stage.style.setProperty('--reader-max-width', `${this.prefs.maxWidth || 740}px`);
    stage.style.setProperty('--reader-font-family', FONT_STACKS[this.prefs.fontFamily] || FONT_STACKS.sans);

    this.els.scrollArea.classList.toggle('is-vertical', this.isVertical);
    this.els.article.classList.toggle('is-vertical', this.isVertical);
  }

  setFontSize(size, { preserveAnchor = null, silentSave = false, showHud = true } = {}) {
    const anchor = preserveAnchor || (this.viewMode === 'text' ? this._captureTopAnchor() : null);
    const clamped = Math.min(44, Math.max(14, Math.round(Number(size) || 20)));
    this.prefs.fontSize = clamped;
    this.els.stage.style.setProperty('--reader-font-size', `${clamped}px`);
    if (anchor) this._restoreTopAnchor(anchor);
    if (showHud) this._showZoomHud(clamped);
    if (!silentSave) {
      this.cb.onPrefsChange?.({ ...this.prefs });
    }
  }

  _showZoomHud(size) {
    const hud = this.els.zoomHud;
    if (!hud) return;
    hud.textContent = `${size} px`;
    hud.classList.add('is-visible');
    clearTimeout(this._zoomHudTimer);
    this._zoomHudTimer = setTimeout(() => hud.classList.remove('is-visible'), 750);
  }

  _captureTopAnchor() {
    const area = this.els.scrollArea;
    const rect = area.getBoundingClientRect();
    const nodes = this.els.article.querySelectorAll('[data-para-idx]');
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (this.isVertical) {
        if (r.left <= rect.right && r.right >= rect.left) {
          return { paraIdx: Number(el.dataset.paraIdx), offset: rect.right - r.right };
        }
      } else if (r.bottom >= rect.top + 8) {
        return { paraIdx: Number(el.dataset.paraIdx), offset: r.top - rect.top };
      }
    }
    return null;
  }

  _restoreTopAnchor(anchor) {
    if (!anchor) return;
    const el = this.els.article.querySelector(`[data-para-idx="${anchor.paraIdx}"]`);
    if (!el) return;
    const area = this.els.scrollArea;
    const rect = area.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (this.isVertical) {
      const diff = (rect.right - r.right) - anchor.offset;
      area.scrollLeft += diff;
    } else {
      const diff = (r.top - rect.top) - anchor.offset;
      area.scrollTop += diff;
    }
  }

  async openBook(book, { chapterIndex = null, paraIndex = null, searchQuery = '' } = {}) {
    this.closePdfDocument();
    this.book = book;
    this.revealedUnits.clear();
    this.activeTtsPara = null;
    this.searchQuery = searchQuery || '';

    const chapters = book.chapters || [];
    const savedCh = Math.min(Math.max(0, book.readingState?.chapterIndex || 0), Math.max(0, chapters.length - 1));
    this.chapterIndex = chapterIndex !== null ? Math.min(Math.max(0, chapterIndex), Math.max(0, chapters.length - 1)) : savedCh;
    this.isVertical = Boolean(book.isVerticalDefault);
    this.viewMode =
      book.readingState?.viewMode === 'pdf' && book.pdfBlobHash && chapterIndex === null ? 'pdf' : 'text';
    this.pdfPage = Math.max(1, book.readingState?.pdfPage || 1);

    this.applyAppearance();
    this.renderCurrentView({ targetPara: paraIndex });
  }

  renderCurrentView({ targetPara = null, preserveScroll = false } = {}) {
    if (!this.book) return;
    const showPdf = this.viewMode === 'pdf';
    this.els.scrollArea.hidden = showPdf;
    this.els.pdfArea.hidden = !showPdf;

    if (showPdf) {
      this.renderPdfView();
      return;
    }

    const chapters = this.book.chapters || [];
    const ch = chapters[this.chapterIndex] || { title: '全文', content: '' };
    const blocks = parseChapterBlocks(ch.content || '');
    const bookmarkSet = new Set(
      (this.book.bookmarks || [])
        .filter((bm) => bm.chapterIndex === this.chapterIndex)
        .map((bm) => bm.paraIndex)
    );

    const anchor = preserveScroll ? this._captureTopAnchor() : null;

    const headerHtml = `
      <header class="reader-chapter-header">
        <div class="reader-book-kicker">${escapeHtml(this.book.title)}</div>
        <h1 class="reader-chapter-title">${escapeHtml(ch.title || `第 ${this.chapterIndex + 1} 章`)}</h1>
      </header>
    `;

    const bodyHtml = blocks.length
      ? blocks
          .map((blk, idx) =>
            renderParagraphHtml(blk, {
              paraIdx: idx,
              reciteMode: this.prefs.reciteMode,
              granularity: this.prefs.granularity,
              hintChars: this.prefs.hintChars,
              revealedUnits: this.revealedUnits,
              clozeTerms: this.book.clozeTerms || [],
              searchQuery: this.searchQuery,
              activeTts: this.activeTtsPara === idx,
              bookmarked: bookmarkSet.has(idx),
            })
          )
          .join('\n')
      : `<p class="reader-empty-chapter">本章目前沒有文字內容，可點右上角「編輯」新增或修改文字。</p>`;

    const footerHtml = `
      <footer class="reader-chapter-footer">
        <button type="button" class="btn btn-soft" data-action="prev-chapter" ${this.chapterIndex <= 0 ? 'disabled' : ''}>← 上一章</button>
        <span class="chapter-indicator">${this.chapterIndex + 1} / ${Math.max(1, chapters.length)}</span>
        <button type="button" class="btn btn-soft" data-action="next-chapter" ${this.chapterIndex >= chapters.length - 1 ? 'disabled' : ''}>下一章 →</button>
      </footer>
    `;

    this.els.article.innerHTML = headerHtml + bodyHtml + footerHtml;

    requestAnimationFrame(() => {
      if (targetPara !== null && targetPara !== undefined) {
        this.scrollToParagraph(targetPara);
      } else if (preserveScroll && anchor) {
        this._restoreTopAnchor(anchor);
      } else if (
        this.book.readingState &&
        this.book.readingState.chapterIndex === this.chapterIndex &&
        this.book.readingState.paraIndex > 0
      ) {
        this.scrollToParagraph(this.book.readingState.paraIndex);
      } else {
        this.els.scrollArea.scrollTop = 0;
        this.els.scrollArea.scrollLeft = 0;
      }
      this.cb.onProgressUpdate?.(this.computeProgress());
    });
  }

  scrollToParagraph(paraIdx, { smooth = false } = {}) {
    const el = this.els.article.querySelector(`[data-para-idx="${paraIdx}"]`);
    if (!el) return;
    el.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      block: this.isVertical ? 'nearest' : 'start',
      inline: this.isVertical ? 'start' : 'nearest',
    });
  }

  setActiveTtsPara(paraIdx) {
    const prev = this.els.article.querySelectorAll('.is-tts-active');
    prev.forEach((n) => n.classList.remove('is-tts-active'));
    this.activeTtsPara = paraIdx;
    if (paraIdx === null || paraIdx === undefined) return;
    const el = this.els.article.querySelector(`[data-para-idx="${paraIdx}"]`);
    if (el) {
      el.classList.add('is-tts-active');
      const areaRect = this.els.scrollArea.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const outOfView = this.isVertical
        ? elRect.left < areaRect.left || elRect.right > areaRect.right
        : elRect.top < areaRect.top + 40 || elRect.bottom > areaRect.bottom - 40;
      if (outOfView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    }
  }

  goChapter(idx, { paraIndex = 0 } = {}) {
    if (!this.book) return;
    const chapters = this.book.chapters || [];
    if (idx < 0 || idx >= chapters.length) return;
    this.chapterIndex = idx;
    this.revealedUnits.clear();
    this.renderCurrentView({ targetPara: paraIndex });
    this.persistReadingPosition();
    this.cb.onChapterChange?.(idx);
  }

  toggleVertical() {
    this.isVertical = !this.isVertical;
    if (this.book) {
      this.book.isVerticalDefault = this.isVertical;
      this.book.updatedAt = Date.now();
      this.cb.onBookMutated?.(this.book);
    }
    this.applyAppearance();
    requestAnimationFrame(() => {
      this.els.scrollArea.scrollTop = 0;
      this.els.scrollArea.scrollLeft = 0;
    });
    return this.isVertical;
  }

  setViewMode(mode) {
    this.viewMode = mode === 'pdf' ? 'pdf' : 'text';
    if (this.book) {
      this.book.readingState = {
        ...(this.book.readingState || {}),
        viewMode: this.viewMode,
        updatedAt: Date.now(),
      };
      this.cb.onBookMutated?.(this.book, { silent: true });
    }
    this.renderCurrentView();
  }

  revealNextUnit() {
    const next = this.els.article.querySelector('.recite-unit.is-masked, .cloze-blank.is-masked');
    if (!next) return false;
    const key = next.dataset.unitKey;
    if (key) this.revealedUnits.add(key);
    next.classList.add('is-revealed');
    next.classList.remove('is-masked');
    next.setAttribute('aria-pressed', 'true');
    next.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    return true;
  }

  hideAllUnits() {
    this.revealedUnits.clear();
    this.els.article.querySelectorAll('.recite-unit, .cloze-blank').forEach((el) => {
      el.classList.remove('is-revealed');
      el.classList.add('is-masked');
      el.setAttribute('aria-pressed', 'false');
    });
  }

  revealAllUnits() {
    this.els.article.querySelectorAll('.recite-unit, .cloze-blank').forEach((el) => {
      const key = el.dataset.unitKey;
      if (key) this.revealedUnits.add(key);
      el.classList.add('is-revealed');
      el.classList.remove('is-masked');
      el.setAttribute('aria-pressed', 'true');
    });
  }

  getTopVisibleParagraphIndex() {
    const area = this.els.scrollArea;
    const rect = area.getBoundingClientRect();
    const nodes = this.els.article.querySelectorAll('[data-para-idx]');
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (this.isVertical) {
        if (r.left <= rect.right && r.right >= rect.left) {
          return Number(el.dataset.paraIdx);
        }
      } else if (r.bottom >= rect.top + 12) {
        return Number(el.dataset.paraIdx);
      }
    }
    return 0;
  }

  computeProgress() {
    if (!this.book) return { percent: 0, label: '0%' };
    if (this.viewMode === 'pdf' && this.pdfDoc) {
      const total = this.pdfDoc.numPages || 1;
      const pct = Math.round((this.pdfPage / total) * 100);
      return { percent: pct, label: `PDF 第 ${this.pdfPage} / ${total} 頁` };
    }
    const chapters = this.book.chapters || [];
    const totalCh = Math.max(1, chapters.length);
    const area = this.els.scrollArea;
    let inChapterRatio = 0;
    if (this.isVertical) {
      const maxScroll = Math.max(1, area.scrollWidth - area.clientWidth);
      inChapterRatio = Math.min(1, Math.max(0, Math.abs(area.scrollLeft) / maxScroll));
    } else {
      const maxScroll = Math.max(1, area.scrollHeight - area.clientHeight);
      inChapterRatio = Math.min(1, Math.max(0, area.scrollTop / maxScroll));
    }
    const overall = Math.min(100, Math.round(((this.chapterIndex + inChapterRatio) / totalCh) * 100));
    return {
      percent: overall,
      label: `第 ${this.chapterIndex + 1}/${totalCh} 章 · ${overall}%`,
    };
  }

  persistReadingPosition() {
    if (!this.book) return;
    const paraIdx = this.viewMode === 'text' ? this.getTopVisibleParagraphIndex() : this.book.readingState?.paraIndex || 0;
    this.book.readingState = {
      chapterIndex: this.chapterIndex,
      paraIndex: paraIdx,
      scrollRatio: 0,
      pdfPage: this.pdfPage,
      viewMode: this.viewMode,
      updatedAt: Date.now(),
    };
    this.cb.onBookMutated?.(this.book, { silent: true });
  }

  // ── In-book search ──────────────────────────────────────────────────────────
  searchInBook(query) {
    this.searchQuery = String(query || '').trim();
    this.searchHits = [];
    this.searchCursor = -1;

    if (!this.book || !this.searchQuery) {
      this.renderCurrentView({ preserveScroll: true });
      return { total: 0, current: 0 };
    }

    const normQ = normalizeSearchText(this.searchQuery);
    const chapters = this.book.chapters || [];
    for (let cIdx = 0; cIdx < chapters.length; cIdx++) {
      const blocks = parseChapterBlocks(chapters[cIdx].content || '');
      for (let pIdx = 0; pIdx < blocks.length; pIdx++) {
        const plain = normalizeSearchText(blocks[pIdx].rawText || blocks[pIdx].text || '');
        if (plain.includes(normQ)) {
          this.searchHits.push({ chapterIndex: cIdx, paraIndex: pIdx });
        }
      }
    }

    if (this.searchHits.length > 0) {
      const sameChIdx = this.searchHits.findIndex((h) => h.chapterIndex >= this.chapterIndex);
      this.searchCursor = sameChIdx >= 0 ? sameChIdx : 0;
      const hit = this.searchHits[this.searchCursor];
      this.chapterIndex = hit.chapterIndex;
      this.renderCurrentView({ targetPara: hit.paraIndex });
      return { total: this.searchHits.length, current: this.searchCursor + 1 };
    }

    this.renderCurrentView({ preserveScroll: true });
    return { total: 0, current: 0 };
  }

  stepSearchHit(delta) {
    if (!this.searchHits.length) return { total: 0, current: 0 };
    this.searchCursor = (this.searchCursor + delta + this.searchHits.length) % this.searchHits.length;
    const hit = this.searchHits[this.searchCursor];
    if (hit.chapterIndex !== this.chapterIndex) {
      this.chapterIndex = hit.chapterIndex;
      this.renderCurrentView({ targetPara: hit.paraIndex });
    } else {
      this.scrollToParagraph(hit.paraIndex, { smooth: true });
    }
    return { total: this.searchHits.length, current: this.searchCursor + 1 };
  }

  // ── Original PDF Viewer ─────────────────────────────────────────────────────
  async renderPdfView() {
    const hash = this.book?.pdfBlobHash;
    if (!hash) {
      this.els.pdfStatus.hidden = false;
      this.els.pdfStatus.innerHTML = `<p>此文件沒有附加原版 PDF。</p>`;
      this.els.pdfCanvasWrap.hidden = true;
      return;
    }

    const blob = await this.cb.getPdfBlob?.(hash);
    if (!blob || !blob.data) {
      this.els.pdfStatus.hidden = false;
      this.els.pdfCanvasWrap.hidden = true;
      this.els.pdfStatus.innerHTML = `
        <div class="pdf-missing-card">
          <p>這本書的原版 PDF 尚未下載到這台手機。</p>
          <button type="button" class="btn btn-primary" data-action="download-remote-pdf">從雲端下載原版 PDF</button>
        </div>
      `;
      return;
    }

    this.els.pdfStatus.hidden = true;
    this.els.pdfCanvasWrap.hidden = false;

    if (!this.pdfDoc || this.pdfHashLoaded !== hash) {
      this.closePdfDocument();
      const pdfjsLib = await getPdfJs();
      this.pdfLoadingTask = pdfjsLib.getDocument(getPdfJsDocParams(blob.data));
      this.pdfDoc = await this.pdfLoadingTask.promise;
      this.pdfHashLoaded = hash;
      this.pdfPage = Math.min(Math.max(1, this.pdfPage), this.pdfDoc.numPages);
    }

    await this._drawPdfPage();
  }

  async _drawPdfPage() {
    if (!this.pdfDoc) return;
    const token = ++this.pdfRenderToken;
    const page = await this.pdfDoc.getPage(this.pdfPage);
    if (token !== this.pdfRenderToken) return;

    const stageW = Math.max(280, this.els.pdfArea.clientWidth - 28);
    const baseVp = page.getViewport({ scale: 1 });
    const fitScale = stageW / baseVp.width;
    const scale = Math.max(0.4, Math.min(3.0, fitScale * this.pdfScale));
    const vp = page.getViewport({ scale });
    const dpr = Math.min(2.2, window.devicePixelRatio || 1);

    const canvas = this.els.pdfCanvas;
    canvas.width = Math.ceil(vp.width * dpr);
    canvas.height = Math.ceil(vp.height * dpr);
    canvas.style.width = `${Math.ceil(vp.width)}px`;
    canvas.style.height = `${Math.ceil(vp.height)}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (token !== this.pdfRenderToken) return;

    this.els.pdfPageLabel.textContent = `第 ${this.pdfPage} / ${this.pdfDoc.numPages} 頁`;
    this.cb.onProgressUpdate?.(this.computeProgress());
    this.persistReadingPosition();
  }

  stepPdfPage(delta) {
    if (!this.pdfDoc) return;
    const next = Math.min(this.pdfDoc.numPages, Math.max(1, this.pdfPage + delta));
    if (next === this.pdfPage) return;
    this.pdfPage = next;
    this._drawPdfPage();
  }

  setPdfScale(delta) {
    this.pdfScale = Math.min(2.4, Math.max(0.6, Number((this.pdfScale + delta).toFixed(2))));
    this._drawPdfPage();
  }

  closePdfDocument() {
    this.pdfRenderToken++;
    const task = this.pdfLoadingTask;
    const doc = this.pdfDoc;
    this.pdfLoadingTask = null;
    this.pdfDoc = null;
    this.pdfHashLoaded = null;
    try {
      const p = task?.destroy?.() ?? doc?.destroy?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // ignore
    }
  }

  // ── Wake Lock ───────────────────────────────────────────────────────────────
  async toggleWakeLock() {
    this.wakeLockEnabled = !this.wakeLockEnabled;
    if (this.wakeLockEnabled) {
      const ok = await this._requestWakeLock();
      if (!ok) this.wakeLockEnabled = false;
    } else {
      await this._releaseWakeLock();
    }
    return this.wakeLockEnabled;
  }

  async _requestWakeLock() {
    if (!('wakeLock' in navigator)) return false;
    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');
      return true;
    } catch {
      return false;
    }
  }

  async _releaseWakeLock() {
    try {
      await this.wakeLockSentinel?.release?.();
    } catch {
      // ignore
    }
    this.wakeLockSentinel = null;
  }
}
