// ==UserScript==
// @name         PureReader - 直接預存到 PWA
// @namespace    https://github.com/dreamgen/publishHTML
// @version      0.5.0
// @description  將目前章節起算的 10、50 或 100 章直接傳送到 PureReader PWA，供離線閱讀。
// @match        https://m.biquge.tw/book/*/*.html
// @match        https://look.thisiscm.com/*
// @match        https://look.twword.com/*
// @match        https://czbooks.net/n/*/*
// @run-at       document-end
// @inject-into  content
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (document.documentElement) document.documentElement.dataset.pureReaderBridgeVersion = '0.5.0';

  const DEFAULT_PWA_URL = 'https://dreamgen.github.io/publishHTML/pureReader/';
  const PWA_URL_STORAGE_KEY = 'pureReader.bridgePwaUrl';
  const ALLOWED_COUNTS = new Set([10, 50, 100]);
  const DEFAULT_FETCH_POLICY = Object.freeze({
    minDelayMs: 120,
    maxDelayMs: 120,
    maxRetries: 0,
    retryBaseMs: 3000,
    retryMaxMs: 30000,
    retryJitterMs: 1000,
  });
  const BRIDGE = Object.freeze({
    schema: 'purereader.chapter-bundle',
    version: 1,
    hello: 'PURE_READER_BRIDGE_HELLO',
    ready: 'PURE_READER_BRIDGE_READY',
    import: 'PURE_READER_BRIDGE_IMPORT',
    result: 'PURE_READER_BRIDGE_RESULT',
  });
  const SITE_PROFILES = [
    {
      hosts: ['m.biquge.tw'],
      selectors: {
        content: '#chaptercontent',
        heading: '.book.read > h1',
        next: 'a[rel="next"], #next_url',
        previous: 'a[rel="prev"], #prev_url, .read-page > a:first-child',
        index: 'a[rel="index"], #info_url',
      },
      noisePatterns: [],
    },
    {
      hosts: ['look.thisiscm.com', 'look.twword.com'],
      selectors: {
        content: '.chapter-content .content',
        heading: '.chapter-content > h1',
        next: '.foot-nav a[rel="next"]',
        previous: '.foot-nav a[rel="prev"]',
        index: '.foot-nav a[rel="index"]',
      },
      noisePatterns: [/^溫馨提示[:：].*(?:廣告|掃碼|簡訊)/],
    },
    {
      hosts: ['czbooks.net'],
      selectors: {
        content: '.chapter-detail > .content',
        heading: '.chapter-detail > .name',
        next: '.chapter-nav .next-chapter',
        previous: '.chapter-nav .prev-chapter',
        index: '.chapter-detail .position a[href*="/n/"]',
        bookTitle: '.chapter-detail .position a[href*="/n/"]',
      },
      fetchPolicy: {
        minDelayMs: 1200,
        maxDelayMs: 2600,
        maxRetries: 4,
        retryBaseMs: 5000,
        retryMaxMs: 60000,
        retryJitterMs: 2500,
      },
      noisePatterns: [],
    },
  ];
  const profile = SITE_PROFILES.find((item) => item.hosts.includes(location.hostname))
    || SITE_PROFILES.find((item) => document.querySelector(item.selectors.content));
  if (!profile) return;
  const fetchPolicy = Object.freeze({ ...DEFAULT_FETCH_POLICY, ...profile.fetchPolicy });

  let dialog = null;
  let abortController = null;
  let transferWindow = null;
  let transferNonce = '';
  let transferOrigin = '';
  let readyResolver = null;
  let readyRejecter = null;
  let resultResolver = null;
  let resultRejecter = null;
  let helloTimer = 0;
  let timeoutTimer = 0;
  let deliveryMode = 'pwa';
  let pendingLocalFile = null;
  let operationState = 'idle';

  function canonicalURL(value, base = location.href) {
    const url = new URL(value, base);
    url.hash = '';
    return url.href;
  }

  function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function randomNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  function matchingLinks(root, selector, fallbackText) {
    const links = [...root.querySelectorAll(selector)];
    if (fallbackText) {
      links.push(...[...root.querySelectorAll('a[href]')]
        .filter((element) => element.textContent.trim() === fallbackText));
    }
    return [...new Set(links)];
  }

  function chapterLink(root, selector, baseURL, fallbackText) {
    const link = matchingLinks(root, selector, fallbackText)
      .find((element) => element.getAttribute('href'));
    return link ? canonicalURL(link.getAttribute('href'), baseURL) : null;
  }

  function sanitizeContent(source, baseURL) {
    const content = source.cloneNode(true);
    content.querySelectorAll([
      'script', 'style', 'iframe', 'ins', 'form', 'object', 'embed',
      '[data-ad-zone]', '[data-ad]', '.adBlock', '.adsbygoogle', '.clickforceads',
      '[class*="advert"]', '[id*="advert"]',
    ].join(',')).forEach((element) => element.remove());

    content.querySelectorAll('p, div').forEach((element) => {
      const text = element.textContent.trim();
      if (profile.noisePatterns.some((pattern) => pattern.test(text))) element.remove();
    });

    content.querySelectorAll('*').forEach((element) => {
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
    });

    content.querySelectorAll('img').forEach((image) => {
      const sourceURL = image.getAttribute('data-src')
        || image.getAttribute('data-original')
        || image.getAttribute('data-lazy-src')
        || image.getAttribute('src');
      if (sourceURL && !sourceURL.startsWith('data:')) {
        try { image.src = canonicalURL(sourceURL, baseURL); } catch (error) {}
      }
      image.removeAttribute('srcset');
      image.removeAttribute('data-srcset');
      image.loading = 'lazy';
    });

    [...content.querySelectorAll('div')]
      .reverse()
      .filter((element) => !element.textContent.trim() && !element.querySelector('img'))
      .forEach((element) => element.remove());
    content.querySelectorAll('p').forEach((element) => {
      if (!element.textContent.trim() && !element.querySelector('img')) element.remove();
    });
    return content.innerHTML.trim();
  }

  function parseChapter(root, url) {
    const selectors = profile.selectors;
    const content = root.querySelector(selectors.content);
    const heading = root.querySelector(selectors.heading) || root.querySelector('h1');
    if (!content || !heading) throw new Error('無法辨識正文或章節標題');

    const contentHtml = sanitizeContent(content, url);
    const title = heading.textContent.trim();
    return {
      url: canonicalURL(url),
      title,
      documentTitle: root.title || title,
      contentHtml,
      previousUrl: chapterLink(root, selectors.previous, url, '上一章'),
      nextUrl: chapterLink(root, selectors.next, url, '下一章'),
      indexUrl: chapterLink(root, selectors.index, url, '目錄'),
      savedAt: Date.now(),
      checksum: fnv1a(`${title}\n${contentHtml}`),
    };
  }

  function inferBookTitle(chapter) {
    const candidates = [
      profile.selectors.bookTitle
        ? document.querySelector(profile.selectors.bookTitle)?.textContent
        : '',
      document.querySelector('meta[property="og:novel:book_name"]')?.content,
      document.querySelector('meta[property="og:title"]')?.content,
      chapter.documentTitle,
    ].filter(Boolean);
    for (const candidate of candidates) {
      const cleaned = candidate
        .replace(chapter.title, '')
        .replace(/[《〈]目錄[》〉]/g, '')
        .replace(/^[\s|｜_—–\-:：]+|[\s|｜_—–\-:：]+$/g, '')
        .trim();
      if (cleaned && cleaned !== chapter.title) return cleaned.slice(0, 200);
    }
    return `小說（${location.hostname}）`;
  }

  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('已取消', 'AbortError'));
      }, { once: true });
    });
  }

  function randomMilliseconds(minimum, maximum) {
    const lower = Math.max(0, Math.floor(minimum));
    const upper = Math.max(lower, Math.floor(maximum));
    return lower + Math.floor(Math.random() * (upper - lower + 1));
  }

  function retryAfterMilliseconds(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
  }

  function isCloudflareChallenge(parsed, html) {
    if (parsed.querySelector(profile.selectors.content)) return false;
    const title = parsed.title.trim().toLowerCase();
    return title === 'just a moment...'
      || title.includes('attention required')
      || parsed.querySelector('#challenge-error-text, script[src*="/cdn-cgi/challenge-platform/"]')
      || /(?:_cf_chl_opt|cf-chl-|challenges\.cloudflare\.com)/i.test(html);
  }

  class RetryableChapterError extends Error {
    constructor(message, retryAfterMs = 0) {
      super(message);
      this.name = 'RetryableChapterError';
      this.retryAfterMs = retryAfterMs;
      this.retryable = true;
    }
  }

  async function fetchChapterOnce(url, signal, bypassCache) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: bypassCache ? 'reload' : 'force-cache',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal,
    });
    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    if (isCloudflareChallenge(parsed, html)) {
      throw new RetryableChapterError(
        'Cloudflare 驗證頁',
        retryAfterMilliseconds(response.headers.get('Retry-After')),
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw new RetryableChapterError(
        `網站流量防護（HTTP ${response.status}）`,
        retryAfterMilliseconds(response.headers.get('Retry-After')),
      );
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseChapter(parsed, url);
  }

  async function fetchChapter(url, signal, completed, total) {
    let retryCount = 0;
    while (true) {
      try {
        return await fetchChapterOnce(url, signal, retryCount > 0);
      } catch (error) {
        if (!error.retryable || retryCount >= fetchPolicy.maxRetries) throw error;
        retryCount += 1;
        const exponentialDelay = Math.min(
          fetchPolicy.retryMaxMs,
          fetchPolicy.retryBaseMs * (2 ** (retryCount - 1)),
        );
        const waitMs = Math.max(
          error.retryAfterMs || 0,
          exponentialDelay + randomMilliseconds(0, fetchPolicy.retryJitterMs),
        );
        setStatus(
          `${error.message}，${Math.ceil(waitMs / 1000)} 秒後重試（${retryCount}／${fetchPolicy.maxRetries}）`,
          completed,
          total,
        );
        await delay(waitMs, signal);
      }
    }
  }

  function setStatus(message, completed = 0, total = 0) {
    ensureDialog();
    const status = dialog.querySelector('#pure-reader-bridge-status');
    const progress = dialog.querySelector('#pure-reader-bridge-progress');
    status.textContent = message;
    progress.style.width = total ? `${Math.min(100, completed / total * 100)}%` : '0%';
  }

  function applyOperationState() {
    ensureDialog();
    const locked = operationState !== 'idle';
    dialog.setAttribute('aria-busy', String(operationState === 'running'));
    dialog.querySelectorAll('[data-count]').forEach((button) => { button.disabled = locked; });
    dialog.querySelectorAll('[data-delivery]').forEach((button) => { button.disabled = locked; });
    dialog.querySelector('#pure-reader-bridge-close').disabled = locked;
    dialog.querySelector('#pure-reader-pwa-url').disabled = locked;
    dialog.querySelector('#pure-reader-local-save').disabled = operationState !== 'ready_to_save';
    const cancelButton = dialog.querySelector('#pure-reader-bridge-cancel');
    cancelButton.hidden = !locked;
    cancelButton.textContent = operationState === 'ready_to_save' ? '取消預存' : '取消';
  }

  function beginOperation() {
    if (operationState !== 'idle') return null;
    operationState = 'running';
    abortController = new AbortController();
    applyOperationState();
    return abortController;
  }

  function finishOperation() {
    abortController = null;
    operationState = 'idle';
    applyOperationState();
  }

  function cancelCurrentOperation() {
    if (operationState === 'running' && abortController && !abortController.signal.aborted) {
      setStatus('正在取消預存…');
      abortController.abort();
      return;
    }
    if (operationState === 'ready_to_save') {
      pendingLocalFile = null;
      dialog.querySelector('#pure-reader-local-save').hidden = true;
      finishOperation();
      setStatus('已取消；未儲存本地章節檔案');
    }
  }

  function selectDeliveryMode(mode) {
    if (operationState !== 'idle' || !['pwa', 'file'].includes(mode)) return;
    deliveryMode = mode;
    pendingLocalFile = null;
    dialog.querySelectorAll('[data-delivery]').forEach((button) => {
      const selected = button.dataset.delivery === mode;
      button.dataset.active = selected ? 'true' : 'false';
      button.setAttribute('aria-pressed', String(selected));
    });
    dialog.querySelector('#pure-reader-pwa-url-group').hidden = mode !== 'pwa';
    dialog.querySelector('#pure-reader-local-save').hidden = true;
    setStatus(mode === 'pwa'
      ? '請選擇章節數，完成後會直接開啟 PWA。'
      : '請選擇章節數；整理完成後再指定檔案位置或使用手機分享儲存。');
  }

  function getPwaURL() {
    const value = dialog?.querySelector('#pure-reader-pwa-url')?.value.trim()
      || localStorage.getItem(PWA_URL_STORAGE_KEY)
      || DEFAULT_PWA_URL;
    const url = new URL(value);
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLocal) throw new Error('PWA 網址必須使用 HTTPS');
    localStorage.setItem(PWA_URL_STORAGE_KEY, url.href);
    return url;
  }

  async function collectChapters(count, signal) {
    const chapters = [];
    const seen = new Set();
    let chapter = parseChapter(document, canonicalURL(location.href));
    let stopReason = '';

    while (chapters.length < count) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (seen.has(chapter.url)) {
        stopReason = 'duplicate_url';
        break;
      }
      seen.add(chapter.url);
      chapters.push(chapter);
      setStatus(`正在整理第 ${chapters.length}／${count} 章：${chapter.title}`, chapters.length, count);
      if (chapters.length >= count) break;
      if (!chapter.nextUrl) {
        stopReason = 'last_chapter';
        break;
      }
      try {
        await delay(randomMilliseconds(fetchPolicy.minDelayMs, fetchPolicy.maxDelayMs), signal);
        chapter = await fetchChapter(chapter.nextUrl, signal, chapters.length, count);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        stopReason = 'fetch_error';
        setStatus(`第 ${chapters.length + 1} 章讀取失敗，將使用已完成的 ${chapters.length} 章`, chapters.length, count);
        break;
      }
    }
    return { chapters, stopReason };
  }

  function cleanupTransferTimers() {
    clearInterval(helloTimer);
    clearTimeout(timeoutTimer);
    helloTimer = 0;
    timeoutTimer = 0;
  }

  function resetTransfer() {
    cleanupTransferTimers();
    transferWindow = null;
    transferNonce = '';
    transferOrigin = '';
    readyResolver = null;
    readyRejecter = null;
    resultResolver = null;
    resultRejecter = null;
  }

  function openPwaReceiver(signal) {
    const pwaURL = getPwaURL();
    transferNonce = randomNonce();
    pwaURL.searchParams.set('prReceive', '1');
    pwaURL.searchParams.set('prNonce', transferNonce);
    transferOrigin = pwaURL.origin;
    transferWindow = window.open(pwaURL.href, 'pureReaderPwaReceiver');
    if (!transferWindow) throw new Error('瀏覽器阻擋了 PWA 視窗，請允許此網站開啟彈出式視窗');

    const ready = new Promise((resolve, reject) => {
      const handleAbort = () => {
        cleanupTransferTimers();
        reject(new DOMException('已取消', 'AbortError'));
      };
      readyResolver = (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      };
      readyRejecter = (error) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      };
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener('abort', handleAbort, { once: true });
      const sendHello = () => {
        if (transferWindow?.closed) {
          cleanupTransferTimers();
          readyRejecter(new Error('PWA 視窗已關閉'));
          return;
        }
        transferWindow.postMessage({ type: BRIDGE.hello, nonce: transferNonce }, transferOrigin);
      };
      helloTimer = window.setInterval(sendHello, 400);
      timeoutTimer = window.setTimeout(() => {
        cleanupTransferTimers();
        readyRejecter(new Error('PWA 連線逾時，請確認網址與版本是否正確'));
      }, 30000);
      sendHello();
    });
    return ready;
  }

  function waitForImportResult(signal) {
    return new Promise((resolve, reject) => {
      const handleAbort = () => {
        cleanupTransferTimers();
        reject(new DOMException('已取消', 'AbortError'));
      };
      resultResolver = (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      };
      resultRejecter = (error) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      };
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener('abort', handleAbort, { once: true });
      timeoutTimer = window.setTimeout(() => resultRejecter(new Error('PWA 匯入逾時')), 120000);
    });
  }

  async function createChapterBundle(count, signal) {
    const { chapters, stopReason } = await collectChapters(count, signal);
    const current = chapters[0];
    const indexUrl = current.indexUrl || new URL('.', current.url).href;
    return {
      schema: BRIDGE.schema,
      version: BRIDGE.version,
      bundleId: `${Date.now()}-${fnv1a(current.url)}`,
      createdAt: new Date().toISOString(),
      requestedChapterCount: count,
      completedChapterCount: chapters.length,
      stopReason,
      currentUrl: current.url,
      book: {
        id: `userscript-${fnv1a(indexUrl)}`,
        title: inferBookTitle(current),
        indexUrl,
      },
      chapters,
    };
  }

  async function startTransfer(count) {
    if (!ALLOWED_COUNTS.has(count)) return;
    const operation = beginOperation();
    if (!operation) return;
    try {
      setStatus('正在開啟 PureReader PWA…');
      const ready = openPwaReceiver(operation.signal);
      const [, bundle] = await Promise.all([
        ready,
        createChapterBundle(count, operation.signal),
      ]);
      const resultPromise = waitForImportResult(operation.signal);
      setStatus(`正在傳送 ${bundle.chapters.length} 章到 PWA…`, bundle.chapters.length, bundle.chapters.length);
      transferWindow.postMessage({ type: BRIDGE.import, nonce: transferNonce, bundle }, transferOrigin);
      const result = await resultPromise;
      setStatus(`完成：新增 ${result.inserted}、更新 ${result.updated}、略過 ${result.unchanged}，共 ${result.total} 章`, result.total, result.total);
    } catch (error) {
      if (!operation.signal.aborted) operation.abort();
      if (error.name === 'AbortError') setStatus('已取消；尚未傳送章節');
      else setStatus(`失敗：${error.message || '未知錯誤'}`);
    } finally {
      resetTransfer();
      finishOperation();
    }
  }

  function safeFilenamePart(value, fallback) {
    const cleaned = String(value || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return (cleaned || fallback).slice(0, 80);
  }

  async function prepareLocalFile(count) {
    if (!ALLOWED_COUNTS.has(count)) return;
    const operation = beginOperation();
    if (!operation) return;
    pendingLocalFile = null;
    dialog.querySelector('#pure-reader-local-save').hidden = true;
    let readyToSave = false;
    try {
      const bundle = await createChapterBundle(count, operation.signal);
      const bookName = safeFilenamePart(bundle.book.title, 'PureReader小說');
      const chapterName = safeFilenamePart(bundle.chapters[0].title, '目前章節');
      const filename = `${bookName}_${chapterName}_${bundle.chapters.length}章.purereader.json`;
      pendingLocalFile = new File(
        [JSON.stringify(bundle, null, 2)],
        filename,
        { type: 'application/json;charset=utf-8', lastModified: Date.now() },
      );
      dialog.querySelector('#pure-reader-local-save').hidden = false;
      abortController = null;
      operationState = 'ready_to_save';
      applyOperationState();
      readyToSave = true;
      setStatus(`已整理 ${bundle.chapters.length} 章（${Math.max(1, Math.round(pendingLocalFile.size / 1024))} KB），請按「儲存本地檔案」。`, bundle.chapters.length, bundle.chapters.length);
    } catch (error) {
      if (error.name === 'AbortError') setStatus('已取消；尚未建立本地檔案');
      else setStatus(`建立檔案失敗：${error.message || '未知錯誤'}`);
    } finally {
      if (!readyToSave) finishOperation();
    }
  }

  function downloadLocalFile(file) {
    const objectURL = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = objectURL;
    link.download = file.name;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  }

  async function saveLocalFile() {
    const file = pendingLocalFile;
    if (!file) return;
    const button = dialog.querySelector('#pure-reader-local-save');
    button.disabled = true;
    let saved = false;
    try {
      if (typeof window.showSaveFilePicker === 'function' && window.isSecureContext) {
        const handle = await window.showSaveFilePicker({
          suggestedName: file.name,
          types: [{ description: 'PureReader 章節檔案', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(file);
        await writable.close();
        setStatus(`已儲存：${file.name}`);
        saved = true;
        return;
      }

      const shareData = { title: 'PureReader 預存章節', files: [file] };
      if (typeof navigator.share === 'function'
          && typeof navigator.canShare === 'function'
          && navigator.canShare(shareData)) {
        await navigator.share(shareData);
        setStatus('已交給系統分享面板；請選擇「儲存到檔案」或您慣用的檔案 App。');
        saved = true;
        return;
      }

      downloadLocalFile(file);
      setStatus(`已下載：${file.name}`);
      saved = true;
    } catch (error) {
      if (error.name === 'AbortError') setStatus('已取消選擇儲存位置，檔案仍可再次儲存。');
      else setStatus(`儲存失敗：${error.message || '未知錯誤'}`);
    } finally {
      if (saved) {
        pendingLocalFile = null;
        button.hidden = true;
        finishOperation();
      } else {
        applyOperationState();
      }
    }
  }

  function handleBridgeMessage(event) {
    if (!transferWindow || event.source !== transferWindow || event.origin !== transferOrigin) return;
    const data = event.data || {};
    if (data.nonce !== transferNonce) return;
    if (data.type === BRIDGE.ready && readyResolver) {
      cleanupTransferTimers();
      const resolve = readyResolver;
      readyResolver = null;
      readyRejecter = null;
      resolve(data);
      return;
    }
    if (data.type === BRIDGE.result && resultResolver) {
      cleanupTransferTimers();
      const resolve = resultResolver;
      const reject = resultRejecter;
      resultResolver = null;
      resultRejecter = null;
      data.ok ? resolve(data.result) : reject(new Error(data.error || 'PWA 匯入失敗'));
    }
  }

  function ensureDialog() {
    const readerShell = document.querySelector('#pure-reader-shell');
    if (dialog?.isConnected) {
      // PureReader hides every direct <body> child except its own shell.
      // Keep the modal inside the shell so it remains visible and interactive.
      if (readerShell && dialog.parentElement !== readerShell) readerShell.append(dialog);
      return dialog;
    }
    dialog = document.createElement('dialog');
    dialog.id = 'pure-reader-bridge-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="pure-reader-bridge-card">
        <div class="pure-reader-bridge-head">
          <strong>預存 PureReader 章節</strong>
          <button type="submit" id="pure-reader-bridge-close" aria-label="關閉">✕</button>
        </div>
        <p>從目前章節開始，包含目前章節。</p>
        <div class="pure-reader-bridge-delivery" aria-label="儲存方式">
          <button type="button" data-delivery="pwa" data-active="true" aria-pressed="true">直接送 PWA</button>
          <button type="button" data-delivery="file" data-active="false" aria-pressed="false">本地檔案</button>
        </div>
        <div class="pure-reader-bridge-counts" aria-label="預存章節數">
          <button type="button" data-count="10">10 章</button>
          <button type="button" data-count="50">50 章</button>
          <button type="button" data-count="100">100 章</button>
        </div>
        <div id="pure-reader-pwa-url-group">
          <label class="pure-reader-bridge-url-label" for="pure-reader-pwa-url">PWA 網址</label>
          <input id="pure-reader-pwa-url" type="url" spellcheck="false">
        </div>
        <div class="pure-reader-bridge-track"><span id="pure-reader-bridge-progress"></span></div>
        <div id="pure-reader-bridge-status" role="status">請選擇章節數，完成後會直接開啟 PWA。</div>
        <button type="button" id="pure-reader-local-save" hidden>儲存本地檔案</button>
        <button type="button" id="pure-reader-bridge-cancel" hidden>取消</button>
      </form>`;
    (readerShell || document.body).append(dialog);
    dialog.querySelector('#pure-reader-pwa-url').value = localStorage.getItem(PWA_URL_STORAGE_KEY) || DEFAULT_PWA_URL;
    dialog.querySelectorAll('[data-delivery]').forEach((button) => {
      button.addEventListener('click', () => selectDeliveryMode(button.dataset.delivery));
    });
    dialog.querySelectorAll('[data-count]').forEach((button) => {
      button.addEventListener('click', () => {
        const count = Number(button.dataset.count);
        if (deliveryMode === 'file') prepareLocalFile(count);
        else startTransfer(count);
      });
    });
    dialog.querySelector('#pure-reader-local-save').addEventListener('click', saveLocalFile);
    dialog.querySelector('#pure-reader-bridge-cancel').addEventListener('click', cancelCurrentOperation);
    dialog.addEventListener('cancel', (event) => {
      if (operationState === 'idle') return;
      event.preventDefault();
      cancelCurrentOperation();
    });
    dialog.addEventListener('close', () => {
      if (!abortController) {
        resetTransfer();
        pendingLocalFile = null;
      }
    });
    return dialog;
  }

  function installStyle() {
    const style = document.createElement('style');
    style.textContent = `
      #pure-reader-save-pwa { white-space: nowrap; }
      #pure-reader-bridge-dialog { width:min(92vw,460px); padding:0; border:0; border-radius:18px; background:transparent; color:#1f2937; font-family:ui-sans-serif,system-ui,sans-serif; }
      #pure-reader-bridge-dialog::backdrop { background:rgba(0,0,0,.48); backdrop-filter:blur(3px); }
      .pure-reader-bridge-card { display:flex; flex-direction:column; gap:14px; padding:20px; border-radius:18px; background:#fff; box-shadow:0 24px 80px rgba(0,0,0,.3); }
      .pure-reader-bridge-head { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:18px; }
      .pure-reader-bridge-head button { border:0; background:transparent; color:#6b7280; font-size:18px; cursor:pointer; }
      .pure-reader-bridge-card p { margin:0; color:#6b7280; font-size:14px; }
      .pure-reader-bridge-delivery { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; padding:4px; border-radius:13px; background:#f3f4f6; }
      .pure-reader-bridge-delivery button { min-height:40px; border:0; border-radius:10px; background:transparent; color:#6b7280; font-weight:800; cursor:pointer; }
      .pure-reader-bridge-delivery button[data-active="true"] { background:#fff; color:#4338ca; box-shadow:0 2px 8px rgba(0,0,0,.1); }
      .pure-reader-bridge-delivery button:disabled, .pure-reader-bridge-head button:disabled, #pure-reader-pwa-url:disabled { opacity:.45; cursor:not-allowed; }
      .pure-reader-bridge-counts { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
      .pure-reader-bridge-counts button, #pure-reader-local-save, #pure-reader-bridge-cancel { min-height:44px; border:1px solid #c7d2fe; border-radius:12px; background:#eef2ff; color:#4338ca; font-weight:800; cursor:pointer; }
      .pure-reader-bridge-counts button:disabled { opacity:.45; cursor:not-allowed; }
      .pure-reader-bridge-url-label { color:#4b5563; font-size:12px; font-weight:700; }
      #pure-reader-pwa-url-group { display:flex; flex-direction:column; gap:6px; }
      #pure-reader-pwa-url-group[hidden] { display:none; }
      #pure-reader-pwa-url { box-sizing:border-box; width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:10px; font-size:13px; }
      .pure-reader-bridge-track { height:7px; overflow:hidden; border-radius:999px; background:#e5e7eb; }
      #pure-reader-bridge-progress { display:block; width:0; height:100%; border-radius:inherit; background:linear-gradient(90deg,#4f46e5,#8b5cf6); transition:width .2s ease; }
      #pure-reader-bridge-status { min-height:42px; color:#374151; font-size:13px; line-height:1.55; overflow-wrap:anywhere; }
      #pure-reader-bridge-cancel { border-color:#fecaca; background:#fef2f2; color:#dc2626; }
      #pure-reader-local-save { border-color:#a7f3d0; background:#ecfdf5; color:#047857; }
      #pure-reader-save-pwa.pure-reader-bridge-floating { position:fixed; z-index:2147483646; right:12px; bottom:78px; min-height:42px; padding:9px 13px; border:0; border-radius:12px; background:#4f46e5; color:#fff; font:700 14px/1 ui-sans-serif,system-ui,sans-serif; box-shadow:0 8px 28px rgba(0,0,0,.25); }
      @media (prefers-color-scheme:dark) {
        #pure-reader-bridge-dialog { color:#f3f4f6; }
        .pure-reader-bridge-card { background:#1f2937; }
        .pure-reader-bridge-delivery { background:#111827; }
        .pure-reader-bridge-delivery button[data-active="true"] { background:#374151; color:#c7d2fe; }
        .pure-reader-bridge-card p, .pure-reader-bridge-url-label { color:#9ca3af; }
        #pure-reader-pwa-url { border-color:#4b5563; background:#111827; color:#f3f4f6; }
        .pure-reader-bridge-track { background:#374151; }
        #pure-reader-bridge-status { color:#e5e7eb; }
      }`;
    (document.head || document.documentElement).append(style);
  }

  function installSaveButton() {
    if (document.querySelector('#pure-reader-save-pwa')) return true;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'pure-reader-save-pwa';
    button.textContent = '預存';
    button.title = '預存 10、50 或 100 章到 PWA 或本地檔案';
    button.addEventListener('click', () => {
      const modal = ensureDialog();
      if (!modal.open) modal.showModal();
    });
    const toolbar = document.querySelector('#pure-reader-toolbar');
    if (toolbar) toolbar.prepend(button);
    else {
      button.classList.add('pure-reader-bridge-floating');
      document.body.append(button);
    }
    return Boolean(toolbar);
  }

  function startBridge() {
    document.documentElement.dataset.pureReaderBridgeVersion = '0.5.0';
    window.addEventListener('message', handleBridgeMessage);
    installStyle();
    if (!installSaveButton()) {
      const observer = new MutationObserver(() => {
        const floating = document.querySelector('#pure-reader-save-pwa.pure-reader-bridge-floating');
        const toolbar = document.querySelector('#pure-reader-toolbar');
        if (!floating || !toolbar) return;
        floating.classList.remove('pure-reader-bridge-floating');
        toolbar.prepend(floating);
        observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.body) startBridge();
  else document.addEventListener('DOMContentLoaded', startBridge, { once: true });
})();
