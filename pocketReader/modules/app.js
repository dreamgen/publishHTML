/**
 * 隨身閱讀 PocketReader — 主應用控制器
 */

import { DEFAULT_CONFIG } from '../config.js';
import {
  escapeHtml,
  splitIntoChapters,
  searchLibrary,
  countBookChars,
  normalizeBookForSync,
  getStarterBooks,
  parseChapterBlocks,
} from './textEngine.js';
import {
  openDb,
  sha256Hex,
  getAllBooks,
  getBook,
  putBook,
  softDeleteBook,
  putBlob,
  getBlob,
  cleanupUnusedBlobs,
  getStorageStats,
  getSetting,
  setSetting,
  deleteSubscription,
} from './db.js';
import {
  parseTextFile,
  extractPdfBook,
  runPdfOcr,
  parseDocxFile,
  parseEpubFile,
  fetchWebArticle,
} from './parsers.js';
import { TtsController } from './tts.js';
import { ReaderController, DEFAULT_READER_PREFS } from './reader.js';
import {
  cleanBaseUrl,
  generateVaultCode,
  testWorkerConnection,
  syncVault,
  downloadVaultPdfBlob,
  downloadSharePdfBlob,
  publishShare,
  updateShare,
  fetchShareBundle,
  extractShareId,
  subscribeToShare,
  refreshAllSubscriptions,
  exportBackupJson,
  importBackupJson,
  getAllShares,
  getAllSubscriptions,
} from './sync.js';

const $ = (id) => document.getElementById(id);

const SOURCE_LABELS = {
  text: '文字',
  md: 'Markdown',
  txt: 'TXT',
  pdf: 'PDF',
  'pdf-ocr': 'PDF+OCR',
  epub: 'EPUB',
  docx: 'Word',
  web: '網頁',
};

const state = {
  books: [],
  activeCategory: 'all',
  sortMode: 'recent',
  searchQuery: '',
  customCategories: [...DEFAULT_CONFIG.defaultCategories],
  syncCfg: {
    workerUrl: DEFAULT_CONFIG.workerUrl || '',
    vaultCode: '',
    passphrase: '',
    syncPdfBlobs: true,
    lastSyncedAt: 0,
  },
  readerPrefs: { ...DEFAULT_READER_PREFS },
  editingBook: null,
  editingChapterIdx: 0,
  ocrTargetBookId: null,
  ocrTargetBuffer: null,
  ocrAbortCtrl: null,
  shareContext: null,
  paraActionTarget: null,
};

let readerCtrl = null;
let ttsCtrl = null;
let qriousLoaded = false;

// ── Utilities ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3200) {
  const stack = $('toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'is-error' : type === 'ok' ? 'is-ok' : ''}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, duration);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTimeShort(ts) {
  if (!ts) return '尚未';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function highlightQuerySafe(text, query) {
  const clean = String(text || '');
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return escapeHtml(clean);
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (m.index > last) out += escapeHtml(clean.slice(last, m.index));
    out += `<mark class="search-hit">${escapeHtml(m[0])}</mark>`;
    last = re.lastIndex;
  }
  if (last < clean.length) out += escapeHtml(clean.slice(last));
  return out;
}

async function ensureQRious() {
  if (qriousLoaded || window.QRious) {
    qriousLoaded = true;
    return window.QRious;
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../../eventControl/vendor/qrious.min.js', import.meta.url).href;
    s.onload = () => {
      qriousLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error('QR Code 元件載入失敗'));
    document.head.appendChild(s);
  });
  return window.QRious;
}

function openModal(id) {
  const el = $(id);
  if (el) el.hidden = false;
}

function closeModal(id) {
  const el = $(id);
  if (el) el.hidden = true;
}

function insertClozeAtSelection(textarea) {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const val = textarea.value;
  const selected = val.slice(start, end) || '重點詞彙';
  const wrapped = `{{${selected}}}`;
  textarea.value = val.slice(0, start) + wrapped + val.slice(end);
  textarea.focus();
  textarea.setSelectionRange(start + 2, start + 2 + selected.length);
}

// ── Data Loading & Saving ─────────────────────────────────────────────────────
async function reloadLibrary() {
  state.books = await getAllBooks({ includeDeleted: false });
  renderCategoryChips();
  renderContinueCard();
  renderBookList();
  updateCategoryDatalist();
  if (state.searchQuery) renderSearchResults();
}

function getAllKnownCategories() {
  const set = new Set(state.customCategories || []);
  for (const b of state.books) {
    if (b.category) set.add(b.category);
  }
  return [...set];
}

function updateCategoryDatalist() {
  const dl = $('categoryDatalist');
  if (!dl) return;
  dl.innerHTML = getAllKnownCategories()
    .map((c) => `<option value="${escapeHtml(c)}"></option>`)
    .join('');
}

async function saveCategoryIfNew(cat) {
  const clean = String(cat || '').trim();
  if (!clean) return;
  if (!state.customCategories.includes(clean)) {
    state.customCategories.push(clean);
    await setSetting('customCategories', state.customCategories);
  }
}

function updateSyncStatusLine() {
  const el = $('syncStatusLine');
  if (!el) return;
  if (!state.syncCfg.workerUrl || !state.syncCfg.vaultCode) {
    el.textContent = '本機離線就緒（尚未設定雲端同步）';
  } else if (state.syncCfg.lastSyncedAt) {
    el.textContent = `已連線 ${state.syncCfg.vaultCode} · 上次同步 ${formatTimeShort(state.syncCfg.lastSyncedAt)}`;
  } else {
    el.textContent = `已設定同步碼 ${state.syncCfg.vaultCode}`;
  }
}

// ── Library Rendering ─────────────────────────────────────────────────────────
function renderCategoryChips() {
  const wrap = $('categoryChips');
  const cats = getAllKnownCategories();
  const hasSubs = state.books.some((b) => b.subscription);
  const pills = [
    { key: 'all', label: `全部 (${state.books.length})` },
    { key: 'pinned', label: '📌 置頂' },
  ];
  if (hasSubs) pills.push({ key: 'subscriptions', label: '📡 訂閱' });
  for (const c of cats) {
    const cnt = state.books.filter((b) => b.category === c).length;
    if (cnt > 0 || DEFAULT_CONFIG.defaultCategories.includes(c)) {
      pills.push({ key: c, label: cnt > 0 ? `${c} (${cnt})` : c });
    }
  }

  wrap.innerHTML = pills
    .map(
      (p) =>
        `<button type="button" class="chip-btn ${state.activeCategory === p.key ? 'is-active' : ''}" data-cat="${escapeHtml(p.key)}">${escapeHtml(p.label)}</button>`
    )
    .join('');

  const shareCatBtn = $('btnShareCategory');
  const isCustomCat =
    state.activeCategory !== 'all' &&
    state.activeCategory !== 'pinned' &&
    state.activeCategory !== 'subscriptions';
  shareCatBtn.hidden = !isCustomCat;
}

function renderContinueCard() {
  const sec = $('continueSection');
  const sorted = [...state.books]
    .filter((b) => (b.readingState?.updatedAt || 0) > 0)
    .sort((a, b) => (b.readingState?.updatedAt || 0) - (a.readingState?.updatedAt || 0));

  if (!sorted.length) {
    sec.hidden = true;
    sec.innerHTML = '';
    return;
  }

  const book = sorted[0];
  const chIdx = Math.min(book.readingState?.chapterIndex || 0, Math.max(0, (book.chapters?.length || 1) - 1));
  const chTitle = book.chapters?.[chIdx]?.title || '全文';
  const pct = Math.min(
    100,
    Math.round((((chIdx + 0.5) / Math.max(1, book.chapters?.length || 1)) * 100))
  );

  sec.hidden = false;
  sec.innerHTML = `
    <div class="continue-card" data-open-book="${escapeHtml(book.id)}">
      <div>
        <div class="continue-kicker">繼續閱讀 · ${escapeHtml(book.category || '隨身書庫')}</div>
        <div class="continue-title">${escapeHtml(book.title)}</div>
        <div class="continue-meta">${escapeHtml(chTitle)} · 約 ${pct}%</div>
      </div>
      <button type="button" class="continue-cta">打開閱讀</button>
    </div>
  `;
}

function getFilteredBooks() {
  let list = [...state.books];
  if (state.activeCategory === 'pinned') {
    list = list.filter((b) => b.pinned);
  } else if (state.activeCategory === 'subscriptions') {
    list = list.filter((b) => b.subscription);
  } else if (state.activeCategory !== 'all') {
    list = list.filter((b) => b.category === state.activeCategory);
  }

  list.sort((a, b) => {
    if (a.pinned !== b.pinned && state.activeCategory === 'all') {
      return a.pinned ? -1 : 1;
    }
    if (state.sortMode === 'title') {
      return (a.title || '').localeCompare(b.title || '', 'zh-Hant');
    }
    if (state.sortMode === 'updated') {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    }
    const ra = a.readingState?.updatedAt || a.updatedAt || 0;
    const rb = b.readingState?.updatedAt || b.updatedAt || 0;
    return rb - ra;
  });

  return list;
}

function renderBookList() {
  const listEl = $('bookList');
  const books = getFilteredBooks();
  if (!books.length) {
    listEl.innerHTML = `
      <div class="empty-library">
        <p>此分類目前沒有書籍或筆記。</p>
        <p>點右上角「＋ 新增內容」貼上文字、匯入 PDF / EPUB / Word 或輸入分享碼加入！</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = books
    .map((b) => {
      const firstBlock = b.chapters?.[0] ? parseChapterBlocks(b.chapters[0].content)[0] : null;
      const excerpt = (firstBlock?.text || b.author || '').replace(/\{\{|\}\}|==/g, '').slice(0, 75);
      const chars = countBookChars(b);
      const chCount = (b.chapters || []).length;
      const srcLabel = SOURCE_LABELS[b.sourceType] || '文字';

      return `
        <article class="book-card" data-book-id="${escapeHtml(b.id)}">
          <div>
            <div class="book-card-top">
              <div class="book-badges">
                <span class="badge badge-accent">${escapeHtml(b.category || '未分類')}</span>
                <span class="badge">${escapeHtml(srcLabel)}</span>
                ${b.pdfBlobHash ? '<span class="badge badge-gold">含原版 PDF</span>' : ''}
                ${b.subscription ? `<span class="badge">訂閱 v${b.subscription.version || 1}</span>` : ''}
              </div>
              <button type="button" class="pin-btn ${b.pinned ? 'is-pinned' : ''}" data-book-action="pin" title="置頂">${b.pinned ? '📌' : '📍'}</button>
            </div>
            <div class="book-main-click" data-book-action="open">
              <h3 class="book-title">${escapeHtml(b.title)}</h3>
              <p class="book-excerpt">${escapeHtml(excerpt || '（空白內容）')}</p>
            </div>
          </div>
          <div>
            <div class="book-meta">
              <span>${chCount} 章</span>
              <span>約 ${chars.toLocaleString()} 字</span>
              ${b.isVerticalDefault ? '<span>直書</span>' : ''}
              <span>更新 ${formatTimeShort(b.contentUpdatedAt || b.updatedAt)}</span>
            </div>
            <div class="book-actions">
              <button type="button" class="btn btn-xs btn-primary" data-book-action="open">閱讀</button>
              <div class="book-actions-right">
                <button type="button" class="btn btn-xs btn-soft" data-book-action="edit">編輯</button>
                <button type="button" class="btn btn-xs btn-soft" data-book-action="share">分享</button>
                <button type="button" class="btn btn-xs btn-danger-soft" data-book-action="delete">刪除</button>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderSearchResults() {
  const panel = $('searchResultsPanel');
  const q = state.searchQuery.trim();
  if (!q) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  const hits = searchLibrary(state.books, q, { limit: 40 });
  panel.hidden = false;
  if (!hits.length) {
    panel.innerHTML = `<div class="search-hit-item"><div class="search-hit-snippet">在全書庫中找不到「${escapeHtml(q)}」相關內容。</div></div>`;
    return;
  }

  panel.innerHTML = hits
    .map(
      (h) => `
      <button type="button" class="search-hit-item" data-jump-book="${escapeHtml(h.bookId)}" data-jump-ch="${h.chapterIndex}" data-jump-para="${h.paraIndex}">
        <div class="search-hit-head">
          <span class="search-hit-title">${escapeHtml(h.title)}</span>
          <span class="search-hit-meta">${escapeHtml(h.chapterTitle)} · ${h.matchCount} 處相符</span>
        </div>
        <div class="search-hit-snippet">${highlightQuerySafe(h.snippet, q)}</div>
      </button>
    `
    )
    .join('');
}

// ── Reader Actions ────────────────────────────────────────────────────────────
async function openBookInReader(bookId, { chapterIndex = null, paraIndex = null, searchQuery = '' } = {}) {
  const book = await getBook(bookId);
  if (!book) {
    toast('找不到此書籍', 'error');
    return;
  }

  $('libraryView').hidden = true;
  $('readerView').hidden = false;
  $('readerView').classList.remove('is-immersive');
  $('readerDocTitle').textContent = book.title;
  $('viewModeSwitch').hidden = !book.pdfBlobHash;
  $('btnMoreOcr').hidden = !book.pdfBlobHash;
  $('btnModeText').classList.add('is-active');
  $('btnModePdf').classList.remove('is-active');

  syncAppearanceControlsToPrefs();
  syncReciteUiToPrefs();

  await readerCtrl.openBook(book, { chapterIndex, paraIndex, searchQuery });
  $('btnToggleVertical').classList.toggle('is-active', readerCtrl.isVertical);
  if (book.readingState?.viewMode === 'pdf' && book.pdfBlobHash && chapterIndex === null) {
    $('btnModePdf').classList.add('is-active');
    $('btnModeText').classList.remove('is-active');
  }
  renderClozeTermsChips();
}

function exitReader() {
  ttsCtrl?.stop();
  readerCtrl?.persistReadingPosition();
  readerCtrl?.closePdfDocument();
  $('readerView').hidden = true;
  $('libraryView').hidden = false;
  $('appearancePanel').hidden = true;
  $('readerMoreMenu').hidden = true;
  $('tocDrawer').hidden = true;
  reloadLibrary();
}

function syncAppearanceControlsToPrefs() {
  const p = readerCtrl.prefs;
  $('rangeFontSize').value = p.fontSize;
  $('lblFontSize').textContent = `${p.fontSize} px`;
  $('rangeLineHeight').value = p.lineHeight;
  $('lblLineHeight').textContent = Number(p.lineHeight).toFixed(2);

  document.querySelectorAll('#appearancePanel [data-width]').forEach((b) => {
    b.classList.toggle('is-active', Number(b.dataset.width) === Number(p.maxWidth));
  });
  document.querySelectorAll('#appearancePanel [data-font]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.font === p.fontFamily);
  });
  document.querySelectorAll('#appearancePanel [data-theme]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.theme === p.theme);
  });
}

function syncReciteUiToPrefs() {
  const mode = readerCtrl.prefs.reciteMode || 'off';
  document.querySelectorAll('#reciteModeSwitch [data-recite]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.recite === mode);
  });
  $('reciteGranularity').value = readerCtrl.prefs.granularity || 'sentence';
  $('reciteHintChars').value = String(readerCtrl.prefs.hintChars || 1);
  $('reciteGranularity').hidden = mode === 'off' || mode === 'cloze';
  $('reciteHintChars').hidden = mode !== 'first-char';
  $('btnAddClozeTerm').hidden = mode !== 'cloze';
  $('clozeTermsChips').hidden = mode !== 'cloze';
  $('btnToggleRecite').classList.toggle('is-active', mode !== 'off');
}

function renderClozeTermsChips() {
  const wrap = $('clozeTermsChips');
  const terms = readerCtrl?.book?.clozeTerms || [];
  if (!terms.length) {
    wrap.innerHTML = `<span class="hint-text">提示：文章內有 {{文字}} / ==文字== 會自動挖空，或點「＋ 新增挖空詞」加入詞彙。</span>`;
    return;
  }
  wrap.innerHTML = terms
    .map(
      (t) =>
        `<span class="cloze-chip">${escapeHtml(t)} <button type="button" data-remove-cloze="${escapeHtml(t)}" aria-label="移除">×</button></span>`
    )
    .join('');
}

function renderTocDrawer(tab = 'chapters') {
  const book = readerCtrl?.book;
  if (!book) return;
  const list = $('tocList');
  $('tabTocChapters').classList.toggle('is-active', tab === 'chapters');
  $('tabTocBookmarks').classList.toggle('is-active', tab === 'bookmarks');

  if (tab === 'chapters') {
    list.innerHTML = (book.chapters || [])
      .map(
        (ch, idx) => `
        <button type="button" class="drawer-item ${idx === readerCtrl.chapterIndex ? 'is-current' : ''}" data-toc-ch="${idx}">
          <span>${escapeHtml(ch.title || `第 ${idx + 1} 章`)}</span>
          <span class="hint-text">${idx + 1}</span>
        </button>
      `
      )
      .join('');
    return;
  }

  const bms = book.bookmarks || [];
  if (!bms.length) {
    list.innerHTML = `<div class="status-box">尚未建立書籤。閱讀時點右下角「🔖 書籤」或長按任一段落即可加入。</div>`;
    return;
  }
  list.innerHTML = bms
    .map(
      (bm) => `
      <div class="bookmark-row">
        <button type="button" class="bookmark-jump" data-bm-ch="${bm.chapterIndex}" data-bm-para="${bm.paraIndex}">
          <div><strong>${escapeHtml(book.chapters?.[bm.chapterIndex]?.title || `第 ${bm.chapterIndex + 1} 章`)}</strong></div>
          <div class="hint-text">${escapeHtml(bm.excerpt || '')}</div>
          ${bm.note ? `<div class="bookmark-note">筆記：${escapeHtml(bm.note)}</div>` : ''}
        </button>
        <button type="button" class="btn btn-xs btn-danger-soft" data-del-bm="${escapeHtml(bm.id)}">刪</button>
      </div>
    `
    )
    .join('');
}

async function addBookmarkAt(chapterIndex, paraIndex, note = '') {
  const book = readerCtrl?.book;
  if (!book) return;
  const blocks = parseChapterBlocks(book.chapters?.[chapterIndex]?.content || '');
  const excerpt = (blocks[paraIndex]?.text || '').replace(/\{\{|\}\}|==/g, '').slice(0, 60);
  const bm = {
    id: `bm-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    chapterIndex,
    paraIndex,
    excerpt,
    note: String(note || '').trim(),
    updatedAt: Date.now(),
  };
  book.bookmarks = [...(book.bookmarks || []), bm];
  book.updatedAt = Date.now();
  await putBook(book);
  readerCtrl.renderCurrentView({ preserveScroll: true });
  toast('已加入書籤', 'ok');
}

// ── File Import & OCR Pipeline ────────────────────────────────────────────────
async function handleFileImportList(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;

  const statusBox = $('fileImportStatus');
  statusBox.hidden = false;
  const category = $('fileCategory').value.trim() || '長篇書籍';
  await saveCategoryIfNew(category);
  const keepPdf = $('fileKeepPdf').checked;

  let imported = 0;
  let lastBook = null;
  let scannedCandidate = null;

  for (const file of files) {
    const name = file.name || '未命名檔案';
    const lower = name.toLowerCase();
    statusBox.innerHTML = `正在解析：<strong>${escapeHtml(name)}</strong>…`;

    try {
      if (lower.endsWith('.pdf')) {
        const buf = await file.arrayBuffer();
        let password = '';
        let extracted = null;
        while (true) {
          try {
            extracted = await extractPdfBook(buf, {
              title: name,
              password,
              onProgress: ({ page, total }) => {
                statusBox.innerHTML = `正在抽取 PDF 文字：<strong>${escapeHtml(name)}</strong>（第 ${page} / ${total} 頁）`;
              },
            });
            break;
          } catch (err) {
            if (err?.name === 'PasswordException') {
              const pwd = window.prompt(`「${name}」受密碼保護，請輸入開啟密碼：`, '');
              if (pwd === null) throw new Error('已取消匯入加密 PDF');
              password = pwd;
            } else {
              throw err;
            }
          }
        }

        let pdfBlobHash = null;
        if (keepPdf) {
          if (buf.byteLength > DEFAULT_CONFIG.maxPdfBlobBytes) {
            toast(`${name} 超過 25MB 雲端原檔上限，僅儲存純文字內容`, 'info', 4500);
          } else {
            pdfBlobHash = await sha256Hex(buf);
            await putBlob({ hash: pdfBlobHash, data: buf, mimeType: 'application/pdf', name });
          }
        }

        const now = Date.now();
        const book = normalizeBookForSync({
          id: `bk-${now}-${Math.random().toString(16).slice(2, 6)}`,
          title: extracted.title,
          author: extracted.author,
          category,
          sourceType: 'pdf',
          chapters: extracted.chapters,
          pdfBlobHash,
          pdfPageCount: extracted.pageCount,
          isVerticalDefault: extracted.isVerticalDefault,
          createdAt: now,
          updatedAt: now,
          contentUpdatedAt: now,
        });
        await putBook(book);
        imported++;
        lastBook = book;
        if (extracted.likelyScanned) {
          scannedCandidate = { book, buffer: buf };
        }
      } else if (lower.endsWith('.epub')) {
        const res = await parseEpubFile(file);
        const now = Date.now();
        const book = normalizeBookForSync({
          id: `bk-${now}-${Math.random().toString(16).slice(2, 6)}`,
          ...res,
          category,
          createdAt: now,
          updatedAt: now,
          contentUpdatedAt: now,
        });
        await putBook(book);
        imported++;
        lastBook = book;
      } else if (lower.endsWith('.docx')) {
        const res = await parseDocxFile(file);
        const now = Date.now();
        const book = normalizeBookForSync({
          id: `bk-${now}-${Math.random().toString(16).slice(2, 6)}`,
          ...res,
          category,
          createdAt: now,
          updatedAt: now,
          contentUpdatedAt: now,
        });
        await putBook(book);
        imported++;
        lastBook = book;
      } else if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.markdown') || file.type.startsWith('text/')) {
        const res = await parseTextFile(file);
        const now = Date.now();
        const book = normalizeBookForSync({
          id: `bk-${now}-${Math.random().toString(16).slice(2, 6)}`,
          ...res,
          category,
          createdAt: now,
          updatedAt: now,
          contentUpdatedAt: now,
        });
        await putBook(book);
        imported++;
        lastBook = book;
      } else {
        throw new Error(`不支援的檔案格式：${name}`);
      }
    } catch (err) {
      statusBox.innerHTML = `<span style="color:var(--danger)">匯入 ${escapeHtml(name)} 失敗：${escapeHtml(err.message)}</span>`;
      toast(`匯入 ${name} 失敗：${err.message}`, 'error', 4500);
    }
  }

  await reloadLibrary();

  if (scannedCandidate) {
    statusBox.innerHTML = `
      <div><strong>${escapeHtml(scannedCandidate.book.title)}</strong> 平均每頁字數極少，應為<strong>掃描版圖片 PDF</strong>。</div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" id="btnPromptOcrNow" class="btn btn-xs btn-primary">立即執行本機離線 OCR 轉文字</button>
        <button type="button" id="btnPromptOpenPdfNow" class="btn btn-xs btn-soft">先看原版 PDF</button>
      </div>
    `;
    $('btnPromptOcrNow')?.addEventListener('click', () => {
      closeModal('addModal');
      openOcrModalForBook(scannedCandidate.book.id, scannedCandidate.buffer);
    });
    $('btnPromptOpenPdfNow')?.addEventListener('click', () => {
      closeModal('addModal');
      openBookInReader(scannedCandidate.book.id);
    });
    return;
  }

  if (imported > 0) {
    statusBox.innerHTML = `已成功匯入 ${imported} 份文件到「${escapeHtml(category)}」。`;
    toast(`已匯入 ${imported} 份文件`, 'ok');
    if (files.length === 1 && lastBook) {
      closeModal('addModal');
      openBookInReader(lastBook.id);
    }
  }
}

async function openOcrModalForBook(bookId, buffer = null) {
  const book = await getBook(bookId);
  if (!book) return;
  let pdfBuf = buffer;
  if (!pdfBuf && book.pdfBlobHash) {
    const blob = await getBlob(book.pdfBlobHash);
    pdfBuf = blob?.data || null;
  }
  if (!pdfBuf) {
    toast('找不到原版 PDF 資料，無法進行 OCR', 'error');
    return;
  }

  state.ocrTargetBookId = bookId;
  state.ocrTargetBuffer = pdfBuf;
  $('ocrLangSelect').value = book.isVerticalDefault ? 'chi_tra_vert+chi_tra' : 'chi_tra+eng';
  $('ocrProgressBox').hidden = true;
  $('btnStartOcr').disabled = false;
  openModal('ocrModal');
  navigator.serviceWorker?.controller?.postMessage({ type: 'warm-ocr-cache' });
}

async function startOcrProcess() {
  if (!state.ocrTargetBookId || !state.ocrTargetBuffer) return;
  const langMode = $('ocrLangSelect').value;
  $('ocrProgressBox').hidden = false;
  $('btnStartOcr').disabled = true;
  state.ocrAbortCtrl = new AbortController();

  try {
    const res = await runPdfOcr(state.ocrTargetBuffer, {
      langMode,
      signal: state.ocrAbortCtrl.signal,
      onProgress: ({ progress, status }) => {
        $('ocrProgressText').textContent = status || '辨識中…';
        $('ocrProgressFill').style.width = `${Math.round((progress || 0) * 100)}%`;
      },
    });

    const book = await getBook(state.ocrTargetBookId);
    if (book && res.recognizedPages > 0) {
      const now = Date.now();
      book.chapters = res.chapters;
      book.sourceType = 'pdf-ocr';
      book.isVerticalDefault = res.isVerticalDefault;
      book.updatedAt = now;
      book.contentUpdatedAt = now;
      book.readingState = { ...(book.readingState || {}), viewMode: 'text', chapterIndex: 0, paraIndex: 0, updatedAt: now };
      await putBook(book);
      await reloadLibrary();
      closeModal('ocrModal');
      toast(
        res.cancelled
          ? `已取消，保留前 ${res.recognizedPages} 頁 OCR 文字`
          : `離線 OCR 完成（共 ${res.recognizedPages} 頁）`,
        'ok'
      );
      openBookInReader(book.id);
    }
  } catch (err) {
    toast(`OCR 失敗：${err.message}`, 'error', 4500);
  } finally {
    $('btnStartOcr').disabled = false;
    state.ocrAbortCtrl = null;
  }
}

// ── Edit Book Modal ───────────────────────────────────────────────────────────
async function openEditBookModal(bookId) {
  const book = await getBook(bookId);
  if (!book) return;
  state.editingBook = JSON.parse(JSON.stringify(book));
  state.editingChapterIdx = 0;

  $('editTitle').value = state.editingBook.title || '';
  $('editCategory').value = state.editingBook.category || '';
  $('editTags').value = (state.editingBook.tags || []).join(', ');
  $('editPinned').checked = Boolean(state.editingBook.pinned);
  $('editVertical').checked = Boolean(state.editingBook.isVerticalDefault);

  renderEditChapterSelect();
  openModal('editModal');
}

function renderEditChapterSelect() {
  const chs = state.editingBook?.chapters || [];
  const sel = $('editChapterSelect');
  sel.innerHTML = chs
    .map((c, i) => `<option value="${i}">${i + 1}. ${escapeHtml(c.title || `第 ${i + 1} 章`)}</option>`)
    .join('');
  state.editingChapterIdx = Math.min(state.editingChapterIdx, Math.max(0, chs.length - 1));
  sel.value = String(state.editingChapterIdx);
  const curr = chs[state.editingChapterIdx] || { title: '', content: '' };
  $('editChapterTitle').value = curr.title || '';
  $('editChapterContent').value = curr.content || '';
}

function commitCurrentEditChapterFields() {
  const chs = state.editingBook?.chapters;
  if (!chs || !chs[state.editingChapterIdx]) return;
  chs[state.editingChapterIdx].title = $('editChapterTitle').value.trim() || `第 ${state.editingChapterIdx + 1} 章`;
  chs[state.editingChapterIdx].content = $('editChapterContent').value;
}

// ── Share & Sync Modals ───────────────────────────────────────────────────────
async function openShareModal({ kind = 'book', bookId = null, category = null }) {
  if (!state.syncCfg.workerUrl) {
    toast('請先在「設定」填入 Cloudflare Worker 網址，才能產生雲端分享碼', 'error', 4500);
    openSyncModal('cloud');
    return;
  }

  let books = [];
  let defaultTitle = '';
  let targetKey = '';
  if (kind === 'category') {
    books = state.books.filter((b) => b.category === category);
    defaultTitle = `${category}（書單合輯）`;
    targetKey = `cat:${category}`;
  } else {
    const b = await getBook(bookId);
    if (!b) return;
    books = [b];
    defaultTitle = b.title;
    targetKey = `book:${b.id}`;
  }

  if (!books.length) {
    toast('沒有可分享的書籍', 'error');
    return;
  }

  const shares = await getAllShares();
  const existingShare = shares.find((s) => s.targetKey === targetKey);

  state.shareContext = { kind, books, targetKey, existingShare };
  $('shareTitleInput').value = existingShare?.title || defaultTitle;
  $('shareDescInput').value = existingShare?.description || '';
  $('shareIncludePdf').checked = Boolean(existingShare?.includePdfBlobs);
  $('shareFormArea').hidden = false;
  $('shareResultArea').hidden = true;

  if (existingShare) {
    $('shareExistingNotice').hidden = false;
    $('shareExistingNotice').textContent = `先前曾分享為代碼 ${existingShare.shareId}（v${existingShare.version}），您可以直接推送新版內容，連結與 QR Code 保持不變！`;
    $('btnUpdateExistingShare').hidden = false;
  } else {
    $('shareExistingNotice').hidden = true;
    $('btnUpdateExistingShare').hidden = true;
  }

  openModal('shareModal');
}

async function showShareResult(record) {
  $('shareFormArea').hidden = true;
  $('shareResultArea').hidden = false;
  $('shareResultCode').textContent = record.shareId;
  const shareUrl = `${location.origin}${location.pathname}#sub=${record.shareId}`;
  $('shareResultUrl').value = shareUrl;

  try {
    const QRious = await ensureQRious();
    new QRious({
      element: $('shareQrCanvas'),
      value: shareUrl,
      size: 200,
      backgroundAlpha: 1,
      foreground: '#272522',
    });
  } catch {
    // ignore QR error
  }
}

async function openSyncModal(initialTab = 'cloud') {
  $('syncWorkerUrl').value = state.syncCfg.workerUrl || '';
  $('syncVaultCode').value = state.syncCfg.vaultCode || '';
  $('syncPassphrase').value = state.syncCfg.passphrase || '';
  $('syncIncludePdfBlobs').checked = state.syncCfg.syncPdfBlobs !== false;
  $('syncProgressBox').hidden = true;
  $('pairQrBox').hidden = true;

  switchSyncTab(initialTab);
  openModal('syncModal');

  if (initialTab === 'subs') await renderManageLists();
  if (initialTab === 'backup') await renderStorageStats();
}

function switchSyncTab(tabName) {
  document.querySelectorAll('#syncTabs .tab-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === tabName);
  });
  $('paneSyncCloud').hidden = tabName !== 'cloud';
  $('paneSyncSubs').hidden = tabName !== 'subs';
  $('paneSyncBackup').hidden = tabName !== 'backup';
}

async function renderManageLists() {
  const [subs, shares] = await Promise.all([getAllSubscriptions(), getAllShares()]);
  const subsEl = $('subscriptionsList');
  if (!subs.length) {
    subsEl.innerHTML = `<div class="hint-text">尚未訂閱任何外部書庫。可從「＋ 新增內容 → 訂閱分享碼」加入。</div>`;
  } else {
    subsEl.innerHTML = subs
      .map(
        (s) => `
        <div class="manage-item">
          <div>
            <strong>${escapeHtml(s.title)}</strong>
            <div class="hint-text">代碼 ${escapeHtml(s.shareId)} · v${s.version} · ${s.bookCount} 本</div>
          </div>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn btn-xs btn-soft" data-sub-update="${escapeHtml(s.shareId)}">更新</button>
            <button type="button" class="btn btn-xs btn-danger-soft" data-sub-remove="${escapeHtml(s.shareId)}">退訂</button>
          </div>
        </div>
      `
      )
      .join('');
  }

  const sharesEl = $('mySharesList');
  if (!shares.length) {
    sharesEl.innerHTML = `<div class="hint-text">尚未發布過分享書單。</div>`;
  } else {
    sharesEl.innerHTML = shares
      .map(
        (sh) => `
        <div class="manage-item">
          <div>
            <strong>${escapeHtml(sh.title)}</strong>
            <div class="hint-text">分享碼 ${escapeHtml(sh.shareId)} · v${sh.version} · 更新 ${formatTimeShort(sh.updatedAt)}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button type="button" class="btn btn-xs btn-soft" data-copy-share="${escapeHtml(sh.shareId)}">複製連結</button>
            <button type="button" class="btn btn-xs btn-primary" data-push-share="${escapeHtml(sh.shareId)}">推送更新</button>
          </div>
        </div>
      `
      )
      .join('');
  }
}

async function renderStorageStats() {
  const stats = await getStorageStats();
  $('storageStatsBox').innerHTML = `
    <div><strong>本機離線書籍：</strong>${stats.bookCount} 本（文字約 ${formatBytes(stats.textBytes)}）</div>
    <div><strong>本機原版 PDF：</strong>${stats.blobCount} 份（佔用 ${formatBytes(stats.blobBytes)}）</div>
    <div><strong>合計離線儲存：</strong>${formatBytes(stats.totalBytes)}</div>
  `;
}

async function saveSyncConfigFromInputs() {
  state.syncCfg = {
    ...state.syncCfg,
    workerUrl: cleanBaseUrl($('syncWorkerUrl').value),
    vaultCode: $('syncVaultCode').value.trim(),
    passphrase: $('syncPassphrase').value,
    syncPdfBlobs: $('syncIncludePdfBlobs').checked,
  };
  await setSetting('syncCfg', state.syncCfg);
  updateSyncStatusLine();
}

async function executeCloudSync() {
  if (!state.syncCfg.workerUrl || !state.syncCfg.vaultCode || !state.syncCfg.passphrase) {
    openSyncModal('cloud');
    toast('請先填寫 Worker 網址、同步碼與同步密碼', 'info');
    return;
  }

  const box = $('syncProgressBox');
  box.hidden = false;
  box.textContent = '準備連線同步…';
  $('btnQuickSync').disabled = true;

  try {
    const res = await syncVault({
      ...state.syncCfg,
      onProgress: (msg) => {
        box.textContent = msg;
      },
    });
    const subUpdates = await refreshAllSubscriptions(state.syncCfg.workerUrl);

    state.syncCfg.lastSyncedAt = res.syncedAt;
    await setSetting('syncCfg', state.syncCfg);
    updateSyncStatusLine();
    await reloadLibrary();

    const subText = subUpdates.length ? `，訂閱更新 ${subUpdates.length} 筆` : '';
    const summary = `同步完成！下載 ${res.pulled} 本、上傳 ${res.pushed} 本${subText}`;
    box.textContent = summary;
    toast(summary, 'ok', 4000);
  } catch (err) {
    box.textContent = `同步失敗：${err.message}`;
    toast(`同步失敗：${err.message}`, 'error', 4500);
  } finally {
    $('btnQuickSync').disabled = false;
  }
}

async function renderPairQr() {
  await saveSyncConfigFromInputs();
  const { workerUrl, vaultCode, passphrase } = state.syncCfg;
  if (!workerUrl || !vaultCode) {
    toast('請先填入 Worker 網址與同步碼', 'error');
    return;
  }
  const includePass = $('pairQrIncludePass').checked;
  const params = new URLSearchParams({ worker: workerUrl, code: vaultCode });
  if (includePass && passphrase) params.set('pass', passphrase);
  const url = `${location.origin}${location.pathname}#sync=${encodeURIComponent(params.toString())}`;

  $('pairQrBox').hidden = false;
  $('pairUrlInput').value = url;

  try {
    const QRious = await ensureQRious();
    new QRious({
      element: $('pairQrCanvas'),
      value: url,
      size: 190,
      backgroundAlpha: 1,
      foreground: '#272522',
    });
  } catch {
    // ignore
  }
}

// ── Incoming URL Hash / PWA Share Inbox / File Handlers ───────────────────────
async function handleIncomingHash() {
  const hash = location.hash || '';
  if (!hash) return;

  if (hash.startsWith('#sub=')) {
    const shareId = extractShareId(hash);
    history.replaceState(null, '', location.pathname + location.search);
    if (shareId) {
      openModal('addModal');
      document.querySelector('#addTabs [data-tab="subscribe"]')?.click();
      $('subCodeInput').value = shareId;
      $('btnPreviewSub')?.click();
    }
  } else if (hash.startsWith('#sync=')) {
    const raw = decodeURIComponent(hash.slice(6));
    const params = new URLSearchParams(raw);
    history.replaceState(null, '', location.pathname + location.search);
    const worker = params.get('worker') || '';
    const code = params.get('code') || '';
    const pass = params.get('pass') || '';
    if (worker || code) {
      state.syncCfg = {
        ...state.syncCfg,
        workerUrl: cleanBaseUrl(worker) || state.syncCfg.workerUrl,
        vaultCode: code || state.syncCfg.vaultCode,
        passphrase: pass || state.syncCfg.passphrase,
      };
      await setSetting('syncCfg', state.syncCfg);
      updateSyncStatusLine();
      openSyncModal('cloud');
      toast('已帶入跨裝置配對設定！請確認密碼後按「立即雙向同步」', 'ok', 4500);
    }
  }
}

async function checkShareInbox() {
  const params = new URLSearchParams(location.search);
  if (!params.has('share-inbox')) return;
  history.replaceState(null, '', location.pathname + location.hash);

  try {
    const cache = await caches.open('pocketReader-share-inbox');
    const metaRes = await cache.match(new URL('./__share-meta__.json', location.href).href);
    if (!metaRes) return;
    const meta = await metaRes.json();

    if (meta.fileCount > 0) {
      const files = [];
      for (let i = 0; i < meta.fileCount; i++) {
        const fileRes = await cache.match(new URL(`./__share-file__-${i}`, location.href).href);
        if (!fileRes) continue;
        const blob = await fileRes.blob();
        const rawName = fileRes.headers.get('X-Share-File-Name') || `分享檔案-${i + 1}`;
        const name = decodeURIComponent(rawName);
        files.push(new File([blob], name, { type: blob.type }));
      }
      await caches.delete('pocketReader-share-inbox');
      if (files.length) {
        openModal('addModal');
        document.querySelector('#addTabs [data-tab="file"]')?.click();
        await handleFileImportList(files);
        return;
      }
    }

    await caches.delete('pocketReader-share-inbox');
    const sharedUrl = meta.url || (meta.text && /^https?:\/\/\S+$/i.test(meta.text) ? meta.text : '');
    if (sharedUrl) {
      openModal('addModal');
      document.querySelector('#addTabs [data-tab="web"]')?.click();
      $('webUrlInput').value = sharedUrl;
      $('btnFetchWeb')?.click();
    } else if (meta.text || meta.title) {
      openModal('addModal');
      document.querySelector('#addTabs [data-tab="paste"]')?.click();
      $('pasteTitle').value = meta.title || '系統分享文字';
      $('pasteContent').value = meta.text || '';
    }
  } catch (err) {
    console.warn('[ShareInbox]', err);
  }
}

function setupLaunchQueue() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams?.files?.length) return;
    const files = [];
    for (const handle of launchParams.files) {
      try {
        files.push(await handle.getFile());
      } catch {
        // ignore
      }
    }
    if (files.length) {
      openModal('addModal');
      document.querySelector('#addTabs [data-tab="file"]')?.click();
      await handleFileImportList(files);
    }
  });
}

// ── Event Wiring ──────────────────────────────────────────────────────────────
function bindAllEvents() {
  // Library search
  $('librarySearchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    $('btnClearSearch').hidden = !state.searchQuery;
    renderSearchResults();
  });
  $('btnClearSearch').addEventListener('click', () => {
    state.searchQuery = '';
    $('librarySearchInput').value = '';
    $('btnClearSearch').hidden = true;
    renderSearchResults();
  });
  $('searchResultsPanel').addEventListener('click', (e) => {
    const item = e.target.closest('[data-jump-book]');
    if (!item) return;
    openBookInReader(item.dataset.jumpBook, {
      chapterIndex: Number(item.dataset.jumpCh),
      paraIndex: Number(item.dataset.jumpPara),
      searchQuery: state.searchQuery,
    });
  });

  // Continue card
  $('continueSection').addEventListener('click', (e) => {
    const card = e.target.closest('[data-open-book]');
    if (card) openBookInReader(card.dataset.openBook);
  });

  // Category & Sort
  $('categoryChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    state.activeCategory = btn.dataset.cat;
    renderCategoryChips();
    renderBookList();
  });
  $('sortSelect').addEventListener('change', (e) => {
    state.sortMode = e.target.value;
    renderBookList();
  });
  $('btnShareCategory').addEventListener('click', () => {
    openShareModal({ kind: 'category', category: state.activeCategory });
  });

  // Book cards
  $('bookList').addEventListener('click', async (e) => {
    const actEl = e.target.closest('[data-book-action]');
    const card = e.target.closest('[data-book-id]');
    if (!actEl || !card) return;
    const bookId = card.dataset.bookId;
    const action = actEl.dataset.bookAction;

    if (action === 'open') {
      openBookInReader(bookId);
    } else if (action === 'pin') {
      const b = await getBook(bookId);
      if (!b) return;
      b.pinned = !b.pinned;
      b.updatedAt = Date.now();
      await putBook(b);
      await reloadLibrary();
    } else if (action === 'edit') {
      openEditBookModal(bookId);
    } else if (action === 'share') {
      openShareModal({ kind: 'book', bookId });
    } else if (action === 'delete') {
      const b = await getBook(bookId);
      if (!b) return;
      if (!window.confirm(`確定要刪除「${b.title}」嗎？`)) return;
      await softDeleteBook(bookId);
      await reloadLibrary();
      toast('已刪除書籍', 'info');
    }
  });

  // Topbar Buttons
  $('btnOpenAdd').addEventListener('click', () => openModal('addModal'));
  $('btnOpenSync').addEventListener('click', () => openSyncModal('cloud'));
  $('btnQuickSync').addEventListener('click', () => executeCloudSync());

  // Close modal buttons & backdrop
  document.addEventListener('click', (e) => {
    const closeTarget = e.target.closest('[data-close-modal]');
    if (closeTarget) {
      closeModal(closeTarget.dataset.closeModal);
      return;
    }
    if (e.target.classList.contains('modal-backdrop') && e.target.id !== 'ocrModal') {
      e.target.hidden = true;
    }
  });

  // Add Modal Tabs
  $('addTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('#addTabs .tab-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    $('formAddPaste').hidden = tab !== 'paste';
    $('paneAddFile').hidden = tab !== 'file';
    $('paneAddWeb').hidden = tab !== 'web';
    $('paneAddSubscribe').hidden = tab !== 'subscribe';
  });

  // Add Paste
  $('btnInsertClozePaste').addEventListener('click', () => insertClozeAtSelection($('pasteContent')));
  $('formAddPaste').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('pasteTitle').value.trim();
    const content = $('pasteContent').value.trim();
    if (!title || !content) return;
    const category = $('pasteCategory').value.trim() || '隨手筆記';
    await saveCategoryIfNew(category);
    const now = Date.now();
    const chapters = splitIntoChapters(content, { defaultTitle: title });
    const book = normalizeBookForSync({
      id: `bk-${now}-${Math.random().toString(16).slice(2, 6)}`,
      title,
      author: $('pasteAuthor').value.trim(),
      category,
      isVerticalDefault: $('pasteVertical').checked,
      sourceType: 'text',
      chapters,
      createdAt: now,
      updatedAt: now,
      contentUpdatedAt: now,
    });
    await putBook(book);
    e.target.reset();
    closeModal('addModal');
    await reloadLibrary();
    toast('已存入隨身書庫', 'ok');
    openBookInReader(book.id);
  });

  // Add File
  $('fileInput').addEventListener('change', (e) => {
    handleFileImportList(e.target.files);
    e.target.value = '';
  });
  const dropZone = $('fileDropZone');
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('is-dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
    handleFileImportList(e.dataTransfer?.files);
  });

  // Add Web
  $('btnFetchWeb').addEventListener('click', async () => {
    const url = $('webUrlInput').value.trim();
    if (!url) return;
    $('btnFetchWeb').disabled = true;
    $('btnFetchWeb').textContent = '擷取中…';
    try {
      const res = await fetchWebArticle(url, {
        workerUrl: state.syncCfg.workerUrl,
        fallbackCorsProxyUrl: DEFAULT_CONFIG.fallbackCorsProxyUrl,
      });
      $('webPreviewBox').hidden = false;
      $('webPreviewTitle').value = res.title;
      $('webPreviewContent').value = res.chapters.map((c) => `# ${c.title}\n\n${c.content}`).join('\n\n');
      $('webPreviewBox').dataset.sourceUrl = res.sourceUrl;
    } catch (err) {
      toast(err.message, 'error', 4000);
    } finally {
      $('btnFetchWeb').disabled = false;
      $('btnFetchWeb').textContent = '擷取內文';
    }
  });
  $('btnSaveWebArticle').addEventListener('click', async () => {
    const title = $('webPreviewTitle').value.trim() || '網頁文章';
    const text = $('webPreviewContent').value.trim();
    if (!text) return;
    const category = $('webCategory').value.trim() || '工作查閱';
    await saveCategoryIfNew(category);
    const now = Date.now();
    const book = normalizeBookForSync({
      id: `bk-${now}-${Math.random().toString(16).slice(2, 6)}`,
      title,
      category,
      sourceType: 'web',
      sourceUrl: $('webPreviewBox').dataset.sourceUrl || '',
      chapters: splitIntoChapters(text, { defaultTitle: title }),
      createdAt: now,
      updatedAt: now,
      contentUpdatedAt: now,
    });
    await putBook(book);
    closeModal('addModal');
    $('webPreviewBox').hidden = true;
    $('webUrlInput').value = '';
    await reloadLibrary();
    toast('已將網頁文章存入離線書庫', 'ok');
    openBookInReader(book.id);
  });

  // Add Subscribe
  $('btnPreviewSub').addEventListener('click', async () => {
    const box = $('subPreviewBox');
    const code = extractShareId($('subCodeInput').value);
    if (!code) {
      toast('請輸入有效的 8 碼分享碼或訂閱連結', 'error');
      return;
    }
    if (!state.syncCfg.workerUrl) {
      box.hidden = false;
      box.innerHTML = '請先至「設定 → 跨裝置同步」填入 Cloudflare Worker 網址，才能讀取雲端分享書單。';
      return;
    }
    box.hidden = false;
    box.textContent = '查詢雲端書單中…';
    try {
      const bundle = await fetchShareBundle(state.syncCfg.workerUrl, code);
      box.innerHTML = `
        <div><strong>${escapeHtml(bundle.title)}</strong>（v${bundle.version} · ${(bundle.books || []).length} 本）</div>
        ${bundle.description ? `<div class="hint-text">${escapeHtml(bundle.description)}</div>` : ''}
        <div style="margin-top:10px">
          <button type="button" id="btnConfirmSubscribe" class="btn btn-xs btn-primary">加入離線書庫並訂閱更新</button>
        </div>
      `;
      $('btnConfirmSubscribe')?.addEventListener('click', async () => {
        try {
          const res = await subscribeToShare({
            workerUrl: state.syncCfg.workerUrl,
            shareId: code,
          });
          await reloadLibrary();
          closeModal('addModal');
          toast(`已訂閱「${res.subscription.title}」（${res.books.length} 本）`, 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    } catch (err) {
      box.textContent = `查詢失敗：${err.message}`;
    }
  });

  // Edit Book Modal
  $('editChapterSelect').addEventListener('change', (e) => {
    commitCurrentEditChapterFields();
    state.editingChapterIdx = Number(e.target.value);
    renderEditChapterSelect();
  });
  $('btnEditAddChapter').addEventListener('click', () => {
    commitCurrentEditChapterFields();
    const chs = state.editingBook.chapters;
    chs.push({
      id: `ch-${Date.now()}`,
      title: `第 ${chs.length + 1} 章`,
      content: '',
    });
    state.editingChapterIdx = chs.length - 1;
    renderEditChapterSelect();
  });
  $('btnEditDelChapter').addEventListener('click', () => {
    const chs = state.editingBook.chapters;
    if (chs.length <= 1) {
      toast('至少需保留一個章節', 'error');
      return;
    }
    if (!window.confirm('確定要刪除目前這個章節嗎？')) return;
    chs.splice(state.editingChapterIdx, 1);
    state.editingChapterIdx = Math.max(0, state.editingChapterIdx - 1);
    renderEditChapterSelect();
  });
  $('btnInsertClozeEdit').addEventListener('click', () => insertClozeAtSelection($('editChapterContent')));
  $('formEditBook').addEventListener('submit', async (e) => {
    e.preventDefault();
    commitCurrentEditChapterFields();
    const b = state.editingBook;
    if (!b) return;
    const now = Date.now();
    b.title = $('editTitle').value.trim() || b.title;
    b.category = $('editCategory').value.trim() || '隨手筆記';
    await saveCategoryIfNew(b.category);
    b.tags = $('editTags')
      .value.split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    b.pinned = $('editPinned').checked;
    b.isVerticalDefault = $('editVertical').checked;
    b.updatedAt = now;
    b.contentUpdatedAt = now;
    await putBook(b);
    closeModal('editModal');
    await reloadLibrary();
    if (!$('readerView').hidden && readerCtrl.book?.id === b.id) {
      readerCtrl.book = b;
      readerCtrl.isVertical = Boolean(b.isVerticalDefault);
      $('readerDocTitle').textContent = b.title;
      readerCtrl.applyAppearance();
      readerCtrl.renderCurrentView({ preserveScroll: true });
    }
    toast('已儲存書籍內容', 'ok');
  });

  // OCR Modal
  $('btnStartOcr').addEventListener('click', () => startOcrProcess());
  $('btnCancelOcr').addEventListener('click', () => {
    if (state.ocrAbortCtrl) {
      state.ocrAbortCtrl.abort();
    } else {
      closeModal('ocrModal');
    }
  });

  // Share Modal
  $('btnCreateNewShare').addEventListener('click', async () => {
    if (!state.shareContext) return;
    try {
      const rec = await publishShare({
        workerUrl: state.syncCfg.workerUrl,
        title: $('shareTitleInput').value.trim() || '分享書單',
        description: $('shareDescInput').value.trim(),
        kind: state.shareContext.kind,
        targetKey: state.shareContext.targetKey,
        books: state.shareContext.books,
        includePdfBlobs: $('shareIncludePdf').checked,
      });
      await showShareResult(rec);
      toast('已產生分享碼', 'ok');
    } catch (err) {
      toast(`發布分享失敗：${err.message}`, 'error');
    }
  });
  $('btnUpdateExistingShare').addEventListener('click', async () => {
    const ctx = state.shareContext;
    if (!ctx?.existingShare) return;
    try {
      ctx.existingShare.includePdfBlobs = $('shareIncludePdf').checked;
      const rec = await updateShare({
        shareRecord: ctx.existingShare,
        books: ctx.books,
        title: $('shareTitleInput').value.trim() || ctx.existingShare.title,
        description: $('shareDescInput').value.trim(),
      });
      await showShareResult(rec);
      toast(`已推送更新至分享碼 ${rec.shareId} (v${rec.version})`, 'ok');
    } catch (err) {
      toast(`更新失敗：${err.message}`, 'error');
    }
  });
  $('btnCopyShareUrl').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('shareResultUrl').value);
    toast('已複製訂閱連結', 'ok');
  });
  $('btnSystemShareLink').addEventListener('click', async () => {
    const url = $('shareResultUrl').value;
    const title = $('shareTitleInput').value.trim() || '隨身閱讀分享';
    if (navigator.share) {
      try {
        await navigator.share({ title, text: `加入我的隨身閱讀書單「${title}」`, url });
        return;
      } catch {
        // fallback to clipboard
      }
    }
    await navigator.clipboard.writeText(url);
    toast('已複製訂閱連結', 'ok');
  });

  // Sync Modal Tabs & Actions
  $('syncTabs').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    switchSyncTab(tab);
    if (tab === 'subs') await renderManageLists();
    if (tab === 'backup') await renderStorageStats();
  });
  $('btnGenVaultCode').addEventListener('click', () => {
    $('syncVaultCode').value = generateVaultCode();
  });
  $('btnTogglePassVis').addEventListener('click', () => {
    const inp = $('syncPassphrase');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('btnTestWorker').addEventListener('click', async () => {
    try {
      await testWorkerConnection($('syncWorkerUrl').value);
      toast('Cloudflare Worker 連線正常！', 'ok');
    } catch (err) {
      toast(`連線失敗：${err.message}`, 'error');
    }
  });
  $('btnSaveSyncCfg').addEventListener('click', async () => {
    await saveSyncConfigFromInputs();
    toast('已儲存雲端同步設定', 'ok');
  });
  $('btnRunSyncNow').addEventListener('click', async () => {
    await saveSyncConfigFromInputs();
    await executeCloudSync();
  });
  $('btnShowPairQr').addEventListener('click', () => renderPairQr());
  $('pairQrIncludePass').addEventListener('change', () => renderPairQr());

  // Manage Subscriptions & My Shares
  $('btnRefreshAllSubs').addEventListener('click', async () => {
    const updates = await refreshAllSubscriptions(state.syncCfg.workerUrl);
    await reloadLibrary();
    await renderManageLists();
    toast(updates.length ? `已更新 ${updates.length} 筆訂閱` : '所有訂閱皆為最新版本', 'ok');
  });
  $('subscriptionsList').addEventListener('click', async (e) => {
    const updBtn = e.target.closest('[data-sub-update]');
    const remBtn = e.target.closest('[data-sub-remove]');
    if (updBtn) {
      const shareId = updBtn.dataset.subUpdate;
      const subs = await getAllSubscriptions();
      const sub = subs.find((s) => s.shareId === shareId);
      try {
        const res = await subscribeToShare({
          workerUrl: sub?.workerUrl || state.syncCfg.workerUrl,
          shareId,
        });
        await reloadLibrary();
        await renderManageLists();
        toast(`已更新至 v${res.subscription.version}`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (remBtn) {
      await deleteSubscription(remBtn.dataset.subRemove);
      await renderManageLists();
      toast('已移除訂閱追蹤（書庫內既有離線內容保留）', 'info');
    }
  });
  $('mySharesList').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy-share]');
    const pushBtn = e.target.closest('[data-push-share]');
    if (copyBtn) {
      const url = `${location.origin}${location.pathname}#sub=${copyBtn.dataset.copyShare}`;
      await navigator.clipboard.writeText(url);
      toast('已複製訂閱連結', 'ok');
    } else if (pushBtn) {
      const shares = await getAllShares();
      const sh = shares.find((s) => s.shareId === pushBtn.dataset.pushShare);
      if (!sh) return;
      let books = [];
      if (sh.kind === 'category' && sh.targetKey?.startsWith('cat:')) {
        const cat = sh.targetKey.slice(4);
        books = state.books.filter((b) => b.category === cat);
      } else {
        books = state.books.filter((b) => (sh.bookIds || []).includes(b.id));
      }
      if (!books.length) {
        toast('書庫中找不到對應書籍可更新', 'error');
        return;
      }
      try {
        const updated = await updateShare({ shareRecord: sh, books });
        await renderManageLists();
        toast(`已更新 ${updated.shareId} 至 v${updated.version}`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  // Backups
  const downloadTextFile = (filename, content) => {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };
  $('btnExportTextBackup').addEventListener('click', async () => {
    const json = await exportBackupJson({ includeBlobs: false });
    downloadTextFile(`pocketReader-text-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
    toast('已匯出純文字 JSON 備份', 'ok');
  });
  $('btnExportFullBackup').addEventListener('click', async () => {
    const json = await exportBackupJson({ includeBlobs: true });
    downloadTextFile(`pocketReader-full-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
    toast('已匯出完整 JSON 備份', 'ok');
  });
  $('importBackupInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const res = await importBackupJson(await file.text());
      await reloadLibrary();
      await renderStorageStats();
      toast(`已還原 ${res.importedBooks} 本書（含 ${res.importedBlobs} 份 PDF）`, 'ok');
    } catch (err) {
      toast(`還原失敗：${err.message}`, 'error');
    }
  });
  $('btnCleanupBlobs').addEventListener('click', async () => {
    const removed = await cleanupUnusedBlobs();
    await renderStorageStats();
    toast(removed ? `已清理 ${removed} 份未使用的暫存原檔` : '沒有多餘的暫存原檔', 'ok');
  });

  // ── Reader Controls ─────────────────────────────────────────────────────────
  $('btnBackLibrary').addEventListener('click', () => exitReader());

  $('btnFontMinus').addEventListener('click', () => {
    readerCtrl.setFontSize(readerCtrl.prefs.fontSize - 2);
    syncAppearanceControlsToPrefs();
  });
  $('btnFontPlus').addEventListener('click', () => {
    readerCtrl.setFontSize(readerCtrl.prefs.fontSize + 2);
    syncAppearanceControlsToPrefs();
  });
  $('btnPanelFontMinus').addEventListener('click', () => {
    readerCtrl.setFontSize(readerCtrl.prefs.fontSize - 1);
    syncAppearanceControlsToPrefs();
  });
  $('btnPanelFontPlus').addEventListener('click', () => {
    readerCtrl.setFontSize(readerCtrl.prefs.fontSize + 1);
    syncAppearanceControlsToPrefs();
  });
  $('rangeFontSize').addEventListener('input', (e) => {
    readerCtrl.setFontSize(Number(e.target.value));
    $('lblFontSize').textContent = `${e.target.value} px`;
  });
  $('rangeLineHeight').addEventListener('input', (e) => {
    readerCtrl.prefs.lineHeight = Number(e.target.value);
    $('lblLineHeight').textContent = Number(e.target.value).toFixed(2);
    readerCtrl.applyAppearance();
    setSetting('readerPrefs', readerCtrl.prefs);
  });

  $('appearancePanel').addEventListener('click', (e) => {
    const widthBtn = e.target.closest('[data-width]');
    const fontBtn = e.target.closest('[data-font]');
    const themeBtn = e.target.closest('[data-theme]');
    if (widthBtn) {
      readerCtrl.prefs.maxWidth = Number(widthBtn.dataset.width);
    } else if (fontBtn) {
      readerCtrl.prefs.fontFamily = fontBtn.dataset.font;
    } else if (themeBtn) {
      readerCtrl.prefs.theme = themeBtn.dataset.theme;
    } else {
      return;
    }
    readerCtrl.applyAppearance();
    syncAppearanceControlsToPrefs();
    setSetting('readerPrefs', readerCtrl.prefs);
  });

  $('btnToggleAppearance').addEventListener('click', () => {
    $('readerMoreMenu').hidden = true;
    $('appearancePanel').hidden = !$('appearancePanel').hidden;
  });
  $('btnCloseAppearance').addEventListener('click', () => {
    $('appearancePanel').hidden = true;
  });

  $('btnToggleVertical').addEventListener('click', () => {
    const isVert = readerCtrl.toggleVertical();
    $('btnToggleVertical').classList.toggle('is-active', isVert);
  });

  $('btnModeText').addEventListener('click', () => {
    $('btnModeText').classList.add('is-active');
    $('btnModePdf').classList.remove('is-active');
    readerCtrl.setViewMode('text');
  });
  $('btnModePdf').addEventListener('click', () => {
    $('btnModePdf').classList.add('is-active');
    $('btnModeText').classList.remove('is-active');
    readerCtrl.setViewMode('pdf');
  });

  // PDF Toolbar
  $('btnPdfPrev').addEventListener('click', () => readerCtrl.stepPdfPage(-1));
  $('btnPdfNext').addEventListener('click', () => readerCtrl.stepPdfPage(1));
  $('btnPdfZoomOut').addEventListener('click', () => readerCtrl.setPdfScale(-0.2));
  $('btnPdfZoomIn').addEventListener('click', () => readerCtrl.setPdfScale(0.2));
  $('btnPdfRunOcr').addEventListener('click', () => {
    if (readerCtrl.book) openOcrModalForBook(readerCtrl.book.id);
  });
  $('pdfStatus').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-action="download-remote-pdf"]')) return;
    const b = readerCtrl.book;
    if (!b?.pdfBlobHash) return;
    try {
      toast('正在下載原版 PDF…', 'info');
      if (b.subscription) {
        await downloadSharePdfBlob({
          workerUrl: b.subscription.workerUrl || state.syncCfg.workerUrl,
          shareId: b.subscription.shareId,
          hash: b.pdfBlobHash,
          title: b.title,
        });
      } else {
        await downloadVaultPdfBlob({
          ...state.syncCfg,
          hash: b.pdfBlobHash,
          title: b.title,
        });
      }
      toast('原版 PDF 下載完成', 'ok');
      readerCtrl.renderPdfView();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Recite Controls
  $('btnToggleRecite').addEventListener('click', () => {
    $('reciteControlBar').hidden = !$('reciteControlBar').hidden;
  });
  $('reciteModeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-recite]');
    if (!btn) return;
    readerCtrl.prefs.reciteMode = btn.dataset.recite;
    readerCtrl.revealedUnits.clear();
    syncReciteUiToPrefs();
    readerCtrl.renderCurrentView({ preserveScroll: true });
    setSetting('readerPrefs', readerCtrl.prefs);
  });
  $('reciteGranularity').addEventListener('change', (e) => {
    readerCtrl.prefs.granularity = e.target.value;
    readerCtrl.revealedUnits.clear();
    readerCtrl.renderCurrentView({ preserveScroll: true });
    setSetting('readerPrefs', readerCtrl.prefs);
  });
  $('reciteHintChars').addEventListener('change', (e) => {
    readerCtrl.prefs.hintChars = Number(e.target.value);
    readerCtrl.renderCurrentView({ preserveScroll: true });
    setSetting('readerPrefs', readerCtrl.prefs);
  });
  $('btnRevealNext').addEventListener('click', () => {
    if (!readerCtrl.revealNextUnit()) toast('本章已全部顯示', 'info');
  });
  $('btnHideAll').addEventListener('click', () => readerCtrl.hideAllUnits());
  $('btnRevealAll').addEventListener('click', () => readerCtrl.revealAllUnits());
  $('btnAddClozeTerm').addEventListener('click', async () => {
    const selText = window.getSelection?.()?.toString?.().trim() || '';
    const term = window.prompt('輸入要在此書挖空的關鍵詞（支援多重詞組）：', selText);
    if (!term || !term.trim() || !readerCtrl.book) return;
    const clean = term.trim();
    const book = readerCtrl.book;
    book.clozeTerms = [...new Set([...(book.clozeTerms || []), clean])];
    book.clozeUpdatedAt = Date.now();
    book.updatedAt = Date.now();
    await putBook(book);
    renderClozeTermsChips();
    readerCtrl.renderCurrentView({ preserveScroll: true });
  });
  $('clozeTermsChips').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove-cloze]');
    if (!btn || !readerCtrl.book) return;
    const term = btn.dataset.removeCloze;
    const book = readerCtrl.book;
    book.clozeTerms = (book.clozeTerms || []).filter((t) => t !== term);
    book.clozeUpdatedAt = Date.now();
    book.updatedAt = Date.now();
    await putBook(book);
    renderClozeTermsChips();
    readerCtrl.renderCurrentView({ preserveScroll: true });
  });

  // TTS Controls
  $('btnToggleTts').addEventListener('click', () => {
    $('ttsControlBar').hidden = !$('ttsControlBar').hidden;
    $('btnToggleTts').classList.toggle('is-active', !$('ttsControlBar').hidden || ttsCtrl.playing);
  });
  $('btnTtsPlayPause').addEventListener('click', () => {
    const ch = readerCtrl.book?.chapters?.[readerCtrl.chapterIndex];
    if (!ch) return;
    const startPara = readerCtrl.getTopVisibleParagraphIndex();
    ttsCtrl.togglePlayPause(ch.content || '', startPara);
  });
  $('btnTtsStop').addEventListener('click', () => ttsCtrl.stop());
  $('btnTtsPrev').addEventListener('click', () => ttsCtrl.prev());
  $('btnTtsNext').addEventListener('click', () => ttsCtrl.next());
  $('ttsRateSelect').addEventListener('change', (e) => ttsCtrl.setRate(Number(e.target.value)));
  $('ttsLoopSelect').addEventListener('change', (e) => ttsCtrl.setLoopMode(e.target.value));
  $('ttsVoiceSelect').addEventListener('change', (e) => ttsCtrl.setVoice(e.target.value));

  // In-book search
  $('btnToggleSearch').addEventListener('click', () => {
    $('inBookSearchBar').hidden = !$('inBookSearchBar').hidden;
    if (!$('inBookSearchBar').hidden) $('inBookSearchInput').focus();
  });
  $('btnCloseInBookSearch').addEventListener('click', () => {
    $('inBookSearchBar').hidden = true;
    $('inBookSearchInput').value = '';
    readerCtrl.searchInBook('');
  });
  $('inBookSearchInput').addEventListener('input', (e) => {
    const res = readerCtrl.searchInBook(e.target.value);
    $('inBookSearchCount').textContent = `${res.current}/${res.total}`;
  });
  $('btnSearchPrev').addEventListener('click', () => {
    const res = readerCtrl.stepSearchHit(-1);
    $('inBookSearchCount').textContent = `${res.current}/${res.total}`;
  });
  $('btnSearchNext').addEventListener('click', () => {
    const res = readerCtrl.stepSearchHit(1);
    $('inBookSearchCount').textContent = `${res.current}/${res.total}`;
  });

  // Chapter nav & Bookmark
  $('btnPrevChapter').addEventListener('click', () => readerCtrl.goChapter(readerCtrl.chapterIndex - 1));
  $('btnNextChapter').addEventListener('click', () => readerCtrl.goChapter(readerCtrl.chapterIndex + 1));
  $('readerArticle').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="prev-chapter"]')) {
      readerCtrl.goChapter(readerCtrl.chapterIndex - 1);
    } else if (e.target.closest('[data-action="next-chapter"]')) {
      readerCtrl.goChapter(readerCtrl.chapterIndex + 1);
    }
  });
  $('btnAddBookmarkNow').addEventListener('click', async () => {
    const paraIdx = readerCtrl.getTopVisibleParagraphIndex();
    const note = window.prompt('加入書籤（可輸入簡短筆記，或留空直接確定）：', '');
    if (note === null) return;
    await addBookmarkAt(readerCtrl.chapterIndex, paraIdx, note);
  });

  // TOC Drawer
  $('btnToggleToc').addEventListener('click', () => {
    renderTocDrawer('chapters');
    $('tocDrawer').hidden = false;
  });
  $('btnCloseToc').addEventListener('click', () => ($('tocDrawer').hidden = true));
  $('tocDrawer').addEventListener('click', async (e) => {
    if (e.target.closest('[data-close-drawer]')) {
      $('tocDrawer').hidden = true;
      return;
    }
    const chBtn = e.target.closest('[data-toc-ch]');
    if (chBtn) {
      readerCtrl.goChapter(Number(chBtn.dataset.tocCh));
      $('tocDrawer').hidden = true;
      return;
    }
    const bmBtn = e.target.closest('[data-bm-ch]');
    if (bmBtn) {
      readerCtrl.goChapter(Number(bmBtn.dataset.bmCh), { paraIndex: Number(bmBtn.dataset.bmPara) });
      $('tocDrawer').hidden = true;
      return;
    }
    const delBm = e.target.closest('[data-del-bm]');
    if (delBm && readerCtrl.book) {
      readerCtrl.book.bookmarks = (readerCtrl.book.bookmarks || []).filter((x) => x.id !== delBm.dataset.delBm);
      readerCtrl.book.updatedAt = Date.now();
      await putBook(readerCtrl.book);
      renderTocDrawer('bookmarks');
      readerCtrl.renderCurrentView({ preserveScroll: true });
    }
  });
  $('tabTocChapters').addEventListener('click', () => renderTocDrawer('chapters'));
  $('tabTocBookmarks').addEventListener('click', () => renderTocDrawer('bookmarks'));

  // Reader More Menu
  $('btnReaderMore').addEventListener('click', () => {
    $('appearancePanel').hidden = true;
    $('readerMoreMenu').hidden = !$('readerMoreMenu').hidden;
  });
  $('readerMoreMenu').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-more]');
    if (!btn || !readerCtrl.book) return;
    $('readerMoreMenu').hidden = true;
    const act = btn.dataset.more;
    if (act === 'edit') {
      openEditBookModal(readerCtrl.book.id);
    } else if (act === 'share') {
      openShareModal({ kind: 'book', bookId: readerCtrl.book.id });
    } else if (act === 'wakeLock') {
      const on = await readerCtrl.toggleWakeLock();
      $('lblWakeLock').textContent = `螢幕保持恆亮：${on ? '開啟' : '關閉'}`;
      toast(on ? '螢幕將保持恆亮' : '已關閉螢幕恆亮', 'info');
    } else if (act === 'ocr') {
      openOcrModalForBook(readerCtrl.book.id);
    } else if (act === 'copyChapter') {
      const ch = readerCtrl.book.chapters?.[readerCtrl.chapterIndex];
      await navigator.clipboard.writeText(`${ch?.title || ''}\n\n${ch?.content || ''}`.trim());
      toast('已複製本章純文字', 'ok');
    }
  });

  // Paragraph Action Sheet
  $('btnParaBookmark').addEventListener('click', async () => {
    const target = state.paraActionTarget;
    closeModal('paraActionModal');
    if (!target) return;
    const note = window.prompt('輸入書籤筆記（選填）：', '');
    if (note === null) return;
    await addBookmarkAt(readerCtrl.chapterIndex, target.paraIdx, note);
  });
  $('btnParaTts').addEventListener('click', () => {
    const target = state.paraActionTarget;
    closeModal('paraActionModal');
    if (!target) return;
    $('ttsControlBar').hidden = false;
    const ch = readerCtrl.book?.chapters?.[readerCtrl.chapterIndex];
    if (ch) ttsCtrl.startChapter(ch.content || '', target.paraIdx);
  });
  $('btnParaCloze').addEventListener('click', async () => {
    const target = state.paraActionTarget;
    closeModal('paraActionModal');
    const selText = window.getSelection?.()?.toString?.().trim() || target?.text?.slice(0, 12) || '';
    const term = window.prompt('輸入要設為挖空的詞組：', selText);
    if (!term || !term.trim() || !readerCtrl.book) return;
    const book = readerCtrl.book;
    book.clozeTerms = [...new Set([...(book.clozeTerms || []), term.trim()])];
    book.clozeUpdatedAt = Date.now();
    book.updatedAt = Date.now();
    await putBook(book);
    readerCtrl.prefs.reciteMode = 'cloze';
    $('reciteControlBar').hidden = false;
    syncReciteUiToPrefs();
    renderClozeTermsChips();
    readerCtrl.renderCurrentView({ preserveScroll: true });
  });
  $('btnParaSetA').addEventListener('click', () => {
    const target = state.paraActionTarget;
    closeModal('paraActionModal');
    if (!target) return;
    ttsCtrl.setLoopMode('ab');
    $('ttsLoopSelect').value = 'ab';
    ttsCtrl.setAbPoint('A', target.paraIdx);
    $('ttsControlBar').hidden = false;
    toast(`已設為朗讀起點 A（第 ${target.paraIdx + 1} 段）`, 'ok');
  });
  $('btnParaSetB').addEventListener('click', () => {
    const target = state.paraActionTarget;
    closeModal('paraActionModal');
    if (!target) return;
    ttsCtrl.setLoopMode('ab');
    $('ttsLoopSelect').value = 'ab';
    ttsCtrl.setAbPoint('B', target.paraIdx);
    $('ttsControlBar').hidden = false;
    toast(`已設為朗讀終點 B（第 ${target.paraIdx + 1} 段）`, 'ok');
  });

  // Keyboard shortcuts inside Reader
  document.addEventListener('keydown', (e) => {
    if ($('readerView').hidden) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName)) return;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      readerCtrl.setFontSize(readerCtrl.prefs.fontSize + 2);
      syncAppearanceControlsToPrefs();
    } else if (e.key === '-') {
      e.preventDefault();
      readerCtrl.setFontSize(readerCtrl.prefs.fontSize - 2);
      syncAppearanceControlsToPrefs();
    } else if (e.key === '0') {
      e.preventDefault();
      readerCtrl.setFontSize(20);
      syncAppearanceControlsToPrefs();
    } else if (e.key === 'Escape') {
      $('appearancePanel').hidden = true;
      $('readerMoreMenu').hidden = true;
      $('tocDrawer').hidden = true;
    }
  });
}

// ── Bootstrapping ─────────────────────────────────────────────────────────────
async function bootstrap() {
  await openDb();

  const savedSync = await getSetting('syncCfg', null);
  if (savedSync) {
    state.syncCfg = {
      ...state.syncCfg,
      ...savedSync,
      workerUrl: savedSync.workerUrl || DEFAULT_CONFIG.workerUrl || '',
    };
  }
  const savedCats = await getSetting('customCategories', null);
  if (Array.isArray(savedCats) && savedCats.length) {
    state.customCategories = savedCats;
  }
  const savedPrefs = await getSetting('readerPrefs', null);
  if (savedPrefs) {
    state.readerPrefs = { ...DEFAULT_READER_PREFS, ...savedPrefs };
  }

  // Initialize starter books on very first launch (even including soft-deleted check so deleted starters don't respawn)
  const allIncludingDeleted = await getAllBooks({ includeDeleted: true });
  const initialized = await getSetting('starterSeeded', false);
  if (!initialized && allIncludingDeleted.length === 0) {
    for (const b of getStarterBooks()) {
      await putBook(b);
    }
    await setSetting('starterSeeded', true);
  }

  ttsCtrl = new TtsController({
    onStateChange: (st) => {
      const voiceSel = $('ttsVoiceSelect');
      const voices = st.voices || ttsCtrl?.getVoices() || [];
      if (voiceSel && voiceSel.options.length !== voices.length) {
        voiceSel.innerHTML = voices
          .map((v) => `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`)
          .join('');
        if (st.voiceURI) voiceSel.value = st.voiceURI;
      }
      $('btnTtsPlayPause').textContent = st.playing && !st.paused ? '⏸ 暫停' : '▶ 朗讀';
      if (st.loopMode === 'ab') {
        $('ttsAbInfo').hidden = false;
        $('ttsAbInfo').textContent = `A-B 區段：第 ${(st.abRange.startPara ?? 0) + 1} 段 ～ 第 ${(st.abRange.endPara ?? 0) + 1} 段（長按段落可設 A/B 點）`;
      } else {
        $('ttsAbInfo').hidden = true;
      }
    },
    onQueueItemStart: (item) => {
      readerCtrl?.setActiveTtsPara(item ? item.paraIdx : null);
    },
    onError: (msg) => toast(msg, 'error'),
  });
  ttsCtrl._emitState();

  readerCtrl = new ReaderController(
    {
      readerView: $('readerView'),
      stage: $('readerStage'),
      scrollArea: $('readerScrollArea'),
      article: $('readerArticle'),
      pdfArea: $('readerPdfArea'),
      pdfStatus: $('pdfStatus'),
      pdfCanvasWrap: $('pdfCanvasWrap'),
      pdfCanvas: $('pdfCanvas'),
      pdfPageLabel: $('pdfPageLabel'),
      zoomHud: $('zoomHud'),
    },
    {
      onPrefsChange: (prefs) => {
        state.readerPrefs = prefs;
        syncAppearanceControlsToPrefs();
        setSetting('readerPrefs', prefs);
      },
      onProgressUpdate: ({ percent, label }) => {
        $('readerProgressLabel').textContent = label;
        $('readerProgressFill').style.width = `${percent}%`;
      },
      onBookMutated: (book) => putBook(book),
      onChapterChange: () => ttsCtrl?.stop(),
      onCanvasTap: () => {
        $('appearancePanel').hidden = true;
        $('readerMoreMenu').hidden = true;
        $('readerView').classList.toggle('is-immersive');
      },
      onParagraphAction: (paraIdx, text) => {
        state.paraActionTarget = { paraIdx, text };
        $('paraActionPreview').textContent = text.slice(0, 140) || `第 ${paraIdx + 1} 段`;
        openModal('paraActionModal');
      },
      getPdfBlob: (hash) => getBlob(hash),
    }
  );
  readerCtrl.setPrefs(state.readerPrefs);

  bindAllEvents();
  updateSyncStatusLine();
  await reloadLibrary();
  setupLaunchQueue();
  await checkShareInbox();
  await handleIncomingHash();
  window.addEventListener('hashchange', () => handleIncomingHash());
}

bootstrap().catch((err) => {
  console.error('[PocketReader] Boot error:', err);
  toast(`啟動異常：${err.message}`, 'error', 5000);
});
