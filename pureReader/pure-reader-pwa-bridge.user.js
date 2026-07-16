// ==UserScript==
// @name         PureReader - 直接預存到 PWA
// @namespace    https://github.com/dreamgen/publishHTML
// @version      0.1.1
// @description  將目前章節起算的 10、50 或 100 章直接傳送到 PureReader PWA，供離線閱讀。
// @match        https://m.biquge.tw/book/*/*.html
// @match        https://look.thisiscm.com/*
// @match        https://look.twword.com/*
// @run-at       document-end
// @inject-into  content
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const DEFAULT_PWA_URL = 'https://dreamgen.github.io/publishHTML/pureReader/';
  const PWA_URL_STORAGE_KEY = 'pureReader.bridgePwaUrl';
  const ALLOWED_COUNTS = new Set([10, 50, 100]);
  const FETCH_DELAY_MS = 120;
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
  ];
  const profile = SITE_PROFILES.find((item) => item.hosts.includes(location.hostname));
  if (!profile) return;

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
      document.querySelector('meta[property="og:novel:book_name"]')?.content,
      document.querySelector('meta[property="og:title"]')?.content,
      chapter.documentTitle,
    ].filter(Boolean);
    for (const candidate of candidates) {
      const cleaned = candidate
        .replace(chapter.title, '')
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

  async function fetchChapter(url, signal) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'force-cache',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return parseChapter(parsed, url);
  }

  function setStatus(message, completed = 0, total = 0) {
    ensureDialog();
    const status = dialog.querySelector('#pure-reader-bridge-status');
    const progress = dialog.querySelector('#pure-reader-bridge-progress');
    status.textContent = message;
    progress.style.width = total ? `${Math.min(100, completed / total * 100)}%` : '0%';
  }

  function setBusy(busy) {
    ensureDialog();
    dialog.querySelectorAll('[data-count]').forEach((button) => { button.disabled = busy; });
    dialog.querySelector('#pure-reader-bridge-close').disabled = busy;
    dialog.querySelector('#pure-reader-bridge-cancel').hidden = !busy;
    dialog.querySelector('#pure-reader-pwa-url').disabled = busy;
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
        await delay(FETCH_DELAY_MS, signal);
        chapter = await fetchChapter(chapter.nextUrl, signal);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        stopReason = 'fetch_error';
        setStatus(`第 ${chapters.length + 1} 章讀取失敗，將傳送已完成的 ${chapters.length} 章`, chapters.length, count);
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

  function openPwaReceiver() {
    const pwaURL = getPwaURL();
    transferNonce = randomNonce();
    pwaURL.searchParams.set('prReceive', '1');
    pwaURL.searchParams.set('prNonce', transferNonce);
    transferOrigin = pwaURL.origin;
    transferWindow = window.open(pwaURL.href, 'pureReaderPwaReceiver');
    if (!transferWindow) throw new Error('瀏覽器阻擋了 PWA 視窗，請允許此網站開啟彈出式視窗');

    const ready = new Promise((resolve, reject) => {
      readyResolver = resolve;
      readyRejecter = reject;
      const sendHello = () => {
        if (transferWindow?.closed) {
          cleanupTransferTimers();
          reject(new Error('PWA 視窗已關閉'));
          return;
        }
        transferWindow.postMessage({ type: BRIDGE.hello, nonce: transferNonce }, transferOrigin);
      };
      helloTimer = window.setInterval(sendHello, 400);
      timeoutTimer = window.setTimeout(() => {
        cleanupTransferTimers();
        reject(new Error('PWA 連線逾時，請確認網址與版本是否正確'));
      }, 30000);
      sendHello();
    });
    return ready;
  }

  function waitForImportResult() {
    return new Promise((resolve, reject) => {
      resultResolver = resolve;
      resultRejecter = reject;
      timeoutTimer = window.setTimeout(() => reject(new Error('PWA 匯入逾時')), 120000);
    });
  }

  async function startTransfer(count) {
    if (!ALLOWED_COUNTS.has(count) || abortController) return;
    setBusy(true);
    abortController = new AbortController();
    try {
      setStatus('正在開啟 PureReader PWA…');
      const ready = openPwaReceiver();
      const collected = collectChapters(count, abortController.signal);
      const [, { chapters, stopReason }] = await Promise.all([ready, collected]);
      const current = chapters[0];
      const indexUrl = current.indexUrl || new URL('.', current.url).href;
      const resultPromise = waitForImportResult();
      const bundle = {
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
      setStatus(`正在傳送 ${chapters.length} 章到 PWA…`, chapters.length, chapters.length);
      transferWindow.postMessage({ type: BRIDGE.import, nonce: transferNonce, bundle }, transferOrigin);
      const result = await resultPromise;
      setStatus(`完成：新增 ${result.inserted}、更新 ${result.updated}、略過 ${result.unchanged}，共 ${result.total} 章`, result.total, result.total);
    } catch (error) {
      if (error.name === 'AbortError') setStatus('已取消；尚未傳送章節');
      else setStatus(`失敗：${error.message || '未知錯誤'}`);
    } finally {
      abortController = null;
      cleanupTransferTimers();
      setBusy(false);
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
          <strong>預存到 PureReader PWA</strong>
          <button type="submit" id="pure-reader-bridge-close" aria-label="關閉">✕</button>
        </div>
        <p>從目前章節開始，包含目前章節。</p>
        <div class="pure-reader-bridge-counts" aria-label="預存章節數">
          <button type="button" data-count="10">10 章</button>
          <button type="button" data-count="50">50 章</button>
          <button type="button" data-count="100">100 章</button>
        </div>
        <label class="pure-reader-bridge-url-label" for="pure-reader-pwa-url">PWA 網址</label>
        <input id="pure-reader-pwa-url" type="url" spellcheck="false">
        <div class="pure-reader-bridge-track"><span id="pure-reader-bridge-progress"></span></div>
        <div id="pure-reader-bridge-status" role="status">請選擇預存章節數。</div>
        <button type="button" id="pure-reader-bridge-cancel" hidden>取消</button>
      </form>`;
    (readerShell || document.body).append(dialog);
    dialog.querySelector('#pure-reader-pwa-url').value = localStorage.getItem(PWA_URL_STORAGE_KEY) || DEFAULT_PWA_URL;
    dialog.querySelectorAll('[data-count]').forEach((button) => {
      button.addEventListener('click', () => startTransfer(Number(button.dataset.count)));
    });
    dialog.querySelector('#pure-reader-bridge-cancel').addEventListener('click', () => abortController?.abort());
    dialog.addEventListener('cancel', (event) => {
      if (!abortController) return;
      event.preventDefault();
      abortController.abort();
    });
    dialog.addEventListener('close', () => {
      if (!abortController) resetTransfer();
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
      .pure-reader-bridge-counts { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
      .pure-reader-bridge-counts button, #pure-reader-bridge-cancel { min-height:44px; border:1px solid #c7d2fe; border-radius:12px; background:#eef2ff; color:#4338ca; font-weight:800; cursor:pointer; }
      .pure-reader-bridge-counts button:disabled { opacity:.45; cursor:not-allowed; }
      .pure-reader-bridge-url-label { color:#4b5563; font-size:12px; font-weight:700; }
      #pure-reader-pwa-url { box-sizing:border-box; width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:10px; font-size:13px; }
      .pure-reader-bridge-track { height:7px; overflow:hidden; border-radius:999px; background:#e5e7eb; }
      #pure-reader-bridge-progress { display:block; width:0; height:100%; border-radius:inherit; background:linear-gradient(90deg,#4f46e5,#8b5cf6); transition:width .2s ease; }
      #pure-reader-bridge-status { min-height:42px; color:#374151; font-size:13px; line-height:1.55; overflow-wrap:anywhere; }
      #pure-reader-bridge-cancel { border-color:#fecaca; background:#fef2f2; color:#dc2626; }
      #pure-reader-save-pwa.pure-reader-bridge-floating { position:fixed; z-index:2147483646; right:12px; bottom:78px; min-height:42px; padding:9px 13px; border:0; border-radius:12px; background:#4f46e5; color:#fff; font:700 14px/1 ui-sans-serif,system-ui,sans-serif; box-shadow:0 8px 28px rgba(0,0,0,.25); }
      @media (prefers-color-scheme:dark) {
        #pure-reader-bridge-dialog { color:#f3f4f6; }
        .pure-reader-bridge-card { background:#1f2937; }
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
    button.textContent = '存到 PWA';
    button.title = '預存 10、50 或 100 章到 PureReader PWA';
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
})();
