// ==UserScript==
// @name         PureReader - 快速小說模式
// @namespace    https://github.com/pure-reader
// @version      1.10.0
// @description  多站全螢幕閱讀、背景預抓，並可將 10、50 或 100 章預存到 PWA 或本地檔案。
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

  document.documentElement.dataset.pureReaderVersion = '1.10.0';

  const SITE_PROFILES = [
    {
      hosts: ['m.biquge.tw'],
      selectors: {
        content: '#chaptercontent',
        heading: '.book.read > h1',
        next: 'a[rel="next"], #next_url',
        previous: 'a[rel="prev"], #prev_url, .read-page > a:first-child',
        index: 'a[rel="index"], #info_url',
        navigation: '.read-page',
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
        navigation: '.foot-nav',
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
        navigation: '.chapter-nav',
      },
      noisePatterns: [],
    },
  ];
  const SITE_PROFILE = SITE_PROFILES.find((profile) => profile.hosts.includes(location.hostname))
    || SITE_PROFILES.find((profile) => document.querySelector(profile.selectors.content))
    || SITE_PROFILES[0];
  const SELECTORS = SITE_PROFILE.selectors;

  const CACHE_LIMIT = 4;
  const FONT_MIN = 16;
  const FONT_MAX = 34;
  const FONT_STEP = 2;
  const LAYOUTS = [
    { id: 'full', name: '全螢幕', maxWidth: 'none' },
    { id: 'medium', name: '適中', maxWidth: '1080px' },
    { id: 'book', name: '書頁', maxWidth: '720px' },
  ];
  const THEMES = [
    { id: 'paper', name: '紙張米', background: '#f7f3e8', text: '#27231d', panel: 'rgba(247, 243, 232, .94)', surface: '#e8e0d1', accent: '#343027', accentText: '#ffffff', border: 'rgba(70, 58, 40, .16)', scheme: 'light' },
    { id: 'snow', name: '柔和白', background: '#ffffff', text: '#202124', panel: 'rgba(255, 255, 255, .94)', surface: '#eceff1', accent: '#30343b', accentText: '#ffffff', border: 'rgba(32, 33, 36, .14)', scheme: 'light' },
    { id: 'sage', name: '護眼綠', background: '#e8f1e5', text: '#203126', panel: 'rgba(232, 241, 229, .94)', surface: '#d2e2ce', accent: '#315c40', accentText: '#ffffff', border: 'rgba(32, 49, 38, .16)', scheme: 'light' },
    { id: 'ocean', name: '海水藍', background: '#e7f0f5', text: '#1c3442', panel: 'rgba(231, 240, 245, .94)', surface: '#cedfe8', accent: '#2d5368', accentText: '#ffffff', border: 'rgba(28, 52, 66, .16)', scheme: 'light' },
    { id: 'rose', name: '胭脂粉', background: '#f6e8ec', text: '#422a30', panel: 'rgba(246, 232, 236, .94)', surface: '#ead1d8', accent: '#704854', accentText: '#ffffff', border: 'rgba(66, 42, 48, .16)', scheme: 'light' },
    { id: 'amber', name: '暖黃紙', background: '#f5e7c8', text: '#3b2b14', panel: 'rgba(245, 231, 200, .94)', surface: '#e9d5aa', accent: '#6b4d20', accentText: '#ffffff', border: 'rgba(59, 43, 20, .17)', scheme: 'light' },
    { id: 'night', name: '夜間黑', background: '#171613', text: '#e9e2d6', panel: 'rgba(23, 22, 19, .94)', surface: '#2b2924', accent: '#e5dccd', accentText: '#211f1b', border: 'rgba(255, 255, 255, .14)', scheme: 'dark' },
  ];
  const chapterCache = new Map();
  const inFlight = new Map();
  const originalPageState = new Map();
  let currentURL = canonicalURL(location.href);
  let navigationToken = 0;
  let bootstrapped = false;
  let readerShell = null;
  let readerFontSize = readNumberPreference('fontSize', 20);
  let themeIndex = readNumberPreference('themeIndex', preferredThemeIndex());
  let layoutIndex = readNumberPreference('layoutIndex', 0);
  let readerOpen = readNumberPreference('readerOpen', 1) !== 0;

  function preferredThemeIndex() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
      ? THEMES.findIndex((theme) => theme.id === 'night')
      : 0;
  }

  function readNumberPreference(key, fallback) {
    try {
      const value = Number(localStorage.getItem(`pureReader.${key}`));
      return Number.isFinite(value) && localStorage.getItem(`pureReader.${key}`) !== null ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function savePreference(key, value) {
    try {
      localStorage.setItem(`pureReader.${key}`, String(value));
    } catch {}
  }

  function canonicalURL(value, base = location.href) {
    const url = new URL(value, base);
    url.hash = '';
    return url.href;
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

  function sanitizeContent(source) {
    const content = source.cloneNode(true);

    content.querySelectorAll([
      'script',
      'style',
      'iframe',
      'ins',
      'form',
      'object',
      'embed',
      '[data-ad-zone]',
      '[data-ad]',
      '.adBlock',
      '.adsbygoogle',
      '.clickforceads',
      '[class*="advert"]',
      '[id*="advert"]',
    ].join(',')).forEach((element) => element.remove());

    content.querySelectorAll('p, div').forEach((element) => {
      const text = element.textContent.trim();
      if (SITE_PROFILE.noisePatterns.some((pattern) => pattern.test(text))) element.remove();
    });

    content.querySelectorAll('*').forEach((element) => {
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
    });

    // 廣告外框常在 iframe/ins 移除後留下空白，避免閱讀區出現大洞。
    [...content.querySelectorAll('div')]
      .reverse()
      .filter((element) => !element.textContent.trim() && !element.querySelector('img'))
      .forEach((element) => element.remove());

    content.querySelectorAll('p').forEach((element) => {
      if (!element.textContent.trim() && !element.querySelector('img')) element.remove();
    });

    return content.innerHTML.trim();
  }

  function parseChapter(html, url) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const content = parsed.querySelector(SELECTORS.content);
    const heading = parsed.querySelector(SELECTORS.heading) || parsed.querySelector('h1');

    if (!content || !heading) {
      throw new Error('PureReader 無法辨識此頁的正文或章節標題');
    }

    return {
      url,
      documentTitle: parsed.title,
      heading: heading.textContent.trim(),
      contentHTML: sanitizeContent(content),
      nextURL: chapterLink(parsed, SELECTORS.next, url, '下一章'),
      previousURL: chapterLink(parsed, SELECTORS.previous, url, '上一章'),
      indexURL: chapterLink(parsed, SELECTORS.index, url, '目錄'),
    };
  }

  function readCurrentChapter() {
    const content = document.querySelector(SELECTORS.content);
    const heading = document.querySelector(SELECTORS.heading) || document.querySelector('h1');
    if (!content || !heading) return null;

    return {
      url: currentURL,
      documentTitle: document.title,
      heading: heading.textContent.trim(),
      contentHTML: sanitizeContent(content),
      nextURL: chapterLink(document, SELECTORS.next, currentURL, '下一章'),
      previousURL: chapterLink(document, SELECTORS.previous, currentURL, '上一章'),
      indexURL: chapterLink(document, SELECTORS.index, currentURL, '目錄'),
    };
  }

  function cacheChapter(chapter) {
    chapterCache.delete(chapter.url);
    chapterCache.set(chapter.url, chapter);
    while (chapterCache.size > CACHE_LIMIT) {
      chapterCache.delete(chapterCache.keys().next().value);
    }
    return chapter;
  }

  function cachedChapter(url) {
    const chapter = chapterCache.get(url);
    if (!chapter) return null;
    chapterCache.delete(url);
    chapterCache.set(url, chapter);
    return chapter;
  }

  async function loadChapter(url) {
    const normalized = canonicalURL(url);
    const cached = cachedChapter(normalized);
    if (cached) return cached;
    if (inFlight.has(normalized)) return inFlight.get(normalized);

    const request = fetch(normalized, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'force-cache',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`章節載入失敗（HTTP ${response.status}）`);
        return response.text();
      })
      .then((html) => cacheChapter(parseChapter(html, normalized)))
      .finally(() => inFlight.delete(normalized));

    inFlight.set(normalized, request);
    return request;
  }

  function preload(url) {
    if (!url || chapterCache.has(url) || inFlight.has(url)) return;
    loadChapter(url).catch(() => {});
  }

  function updateNavigationLinks(chapter) {
    const mappings = [
      [SELECTORS.next, chapter.nextURL, '下一章'],
      [SELECTORS.previous, chapter.previousURL, '上一章'],
      [SELECTORS.index, chapter.indexURL, '目錄'],
    ];

    for (const [selector, url, fallbackText] of mappings) {
      matchingLinks(document, selector, fallbackText).forEach((link) => {
        if (url) {
          link.href = url;
          link.removeAttribute('aria-disabled');
          link.classList.remove('pure-reader-disabled');
        } else {
          link.removeAttribute('href');
          link.setAttribute('aria-disabled', 'true');
          link.classList.add('pure-reader-disabled');
        }
      });
    }
  }

  function ensureReaderShell() {
    if (readerShell?.isConnected) return readerShell;

    readerShell = document.createElement('main');
    readerShell.id = 'pure-reader-shell';
    readerShell.setAttribute('aria-label', 'PureReader 小說閱讀模式');
    readerShell.setAttribute('aria-keyshortcuts', 'Space');
    readerShell.tabIndex = -1;
    readerShell.innerHTML = `
      <button type="button" id="pure-reader-show" aria-label="顯示 PureReader 閱讀模式" title="顯示閱讀模式">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 2.75h8.4l3.6 3.6v14.9h-12zM14.5 3v4h3.75M9 11h7M9 14h7M9 17h5"/></svg>
        <span>顯示</span>
      </button>
      <article id="pure-reader-article">
        <div id="pure-reader-toolbar" role="toolbar" aria-label="閱讀設定">
          <button type="button" data-reader-action="decrease" aria-label="縮小字體" title="縮小字體">A−</button>
          <button type="button" data-reader-action="increase" aria-label="放大字體" title="放大字體">A＋</button>
          <button type="button" id="pure-reader-theme" data-reader-action="theme" aria-label="切換閱讀配色" title="切換閱讀配色">
            <span class="pure-reader-swatch" aria-hidden="true"></span>
            <span id="pure-reader-theme-name"></span>
          </button>
          <button type="button" id="pure-reader-layout" data-reader-action="layout" aria-label="切換版面寬度" title="切換版面寬度">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 18h16M8 10h8M8 14h8"/></svg>
            <span id="pure-reader-layout-name"></span>
          </button>
          <button type="button" data-reader-action="close" aria-label="關閉閱讀模式" title="恢復原始頁面">關閉</button>
        </div>
        <h1 id="pure-reader-title"></h1>
        <div id="pure-reader-content"></div>
      </article>
      <nav id="pure-reader-actions" aria-label="章節導覽">
        <a id="pure-reader-index" rel="index" aria-label="目錄" title="目錄">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14v17H5zM8 8h8M8 12h8M8 16h6"/></svg>
        </a>
        <a id="pure-reader-next" rel="next">下一章</a>
      </nav>
    `;

    document.body.append(readerShell);
    readerShell.querySelector('#pure-reader-toolbar').addEventListener('click', handleToolbarClick);
    readerShell.querySelector('#pure-reader-show').addEventListener('click', () => setReaderOpen(true));
    applyReaderPreferences();
    setReaderOpen(readerOpen, { persist: false });
    return readerShell;
  }

  function hideOriginalPage() {
    [...document.body.children].forEach((element) => {
      if (element === readerShell) return;
      if (!originalPageState.has(element)) {
        originalPageState.set(element, {
          inert: Boolean(element.inert),
          hadInert: element.hasAttribute('inert'),
          ariaHidden: element.getAttribute('aria-hidden'),
        });
      }
      element.inert = true;
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    });
    document.documentElement.classList.add('pure-reader-mode');
  }

  function restoreOriginalPage() {
    document.documentElement.classList.remove('pure-reader-mode', 'pure-reader-loading');
    originalPageState.forEach((state, element) => {
      if (!element.isConnected) return;
      element.inert = state.inert;
      if (state.hadInert) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
      if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', state.ariaHidden);
    });
  }

  function setReaderOpen(open, { persist = true } = {}) {
    readerOpen = Boolean(open);
    if (!readerShell) return;
    readerShell.classList.toggle('pure-reader-closed', !readerOpen);
    if (readerOpen) hideOriginalPage();
    else restoreOriginalPage();
    if (persist) savePreference('readerOpen', readerOpen ? 1 : 0);
  }

  function clampFontSize(value) {
    return Math.min(FONT_MAX, Math.max(FONT_MIN, value));
  }

  function applyReaderPreferences() {
    if (!readerShell) return;
    readerFontSize = clampFontSize(readerFontSize);
    themeIndex = ((Math.trunc(themeIndex) % THEMES.length) + THEMES.length) % THEMES.length;
    layoutIndex = ((Math.trunc(layoutIndex) % LAYOUTS.length) + LAYOUTS.length) % LAYOUTS.length;
    const theme = THEMES[themeIndex];
    const layout = LAYOUTS[layoutIndex];

    readerShell.style.setProperty('--reader-font-size', `${readerFontSize}px`);
    readerShell.style.setProperty('--reader-page-max-width', layout.maxWidth);
    readerShell.style.setProperty('--reader-background', theme.background);
    readerShell.style.setProperty('--reader-text', theme.text);
    readerShell.style.setProperty('--reader-panel', theme.panel);
    readerShell.style.setProperty('--reader-surface', theme.surface);
    readerShell.style.setProperty('--reader-accent', theme.accent);
    readerShell.style.setProperty('--reader-accent-text', theme.accentText);
    readerShell.style.setProperty('--reader-border', theme.border);
    readerShell.style.setProperty('--reader-color-scheme', theme.scheme);
    readerShell.dataset.theme = theme.id;
    readerShell.dataset.layout = layout.id;

    const themeButton = readerShell.querySelector('#pure-reader-theme');
    readerShell.querySelector('#pure-reader-theme-name').textContent = theme.name;
    themeButton.setAttribute('aria-label', `切換閱讀配色，目前為${theme.name}`);
    themeButton.title = `目前：${theme.name}；點擊切換配色`;
    const layoutButton = readerShell.querySelector('#pure-reader-layout');
    readerShell.querySelector('#pure-reader-layout-name').textContent = layout.name;
    layoutButton.setAttribute('aria-label', `切換版面寬度，目前為${layout.name}`);
    layoutButton.title = `目前：${layout.name}；點擊切換全螢幕、適中與書頁版面`;
    readerShell.querySelector('[data-reader-action="decrease"]').disabled = readerFontSize <= FONT_MIN;
    readerShell.querySelector('[data-reader-action="increase"]').disabled = readerFontSize >= FONT_MAX;
  }

  function handleToolbarClick(event) {
    const button = event.target.closest('button[data-reader-action]');
    if (!button) return;

    const action = button.dataset.readerAction;
    if (action === 'decrease') {
      readerFontSize = clampFontSize(readerFontSize - FONT_STEP);
      savePreference('fontSize', readerFontSize);
    } else if (action === 'increase') {
      readerFontSize = clampFontSize(readerFontSize + FONT_STEP);
      savePreference('fontSize', readerFontSize);
    } else if (action === 'theme') {
      themeIndex = (themeIndex + 1) % THEMES.length;
      savePreference('themeIndex', themeIndex);
    } else if (action === 'layout') {
      layoutIndex = (layoutIndex + 1) % LAYOUTS.length;
      savePreference('layoutIndex', layoutIndex);
    } else if (action === 'close') {
      setReaderOpen(false);
      return;
    }

    applyReaderPreferences();
  }

  function renderReaderShell(chapter) {
    const shell = ensureReaderShell();
    shell.querySelector('#pure-reader-title').textContent = chapter.heading;
    shell.querySelector('#pure-reader-content').innerHTML = chapter.contentHTML;

    const index = shell.querySelector('#pure-reader-index');
    if (chapter.indexURL) {
      index.href = chapter.indexURL;
      index.removeAttribute('aria-disabled');
      index.classList.remove('pure-reader-disabled');
    } else {
      index.removeAttribute('href');
      index.setAttribute('aria-disabled', 'true');
      index.classList.add('pure-reader-disabled');
    }

    const next = shell.querySelector('#pure-reader-next');
    if (chapter.nextURL) {
      next.href = chapter.nextURL;
      next.textContent = '下一章';
      next.removeAttribute('aria-disabled');
      next.classList.remove('pure-reader-disabled');
    } else {
      next.removeAttribute('href');
      next.textContent = '已是最後一章';
      next.setAttribute('aria-disabled', 'true');
      next.classList.add('pure-reader-disabled');
    }
  }

  function renderChapter(chapter, { push = true } = {}) {
    const content = document.querySelector(SELECTORS.content);
    const heading = document.querySelector(SELECTORS.heading) || document.querySelector('h1');
    if (!content || !heading) throw new Error('目前頁面缺少閱讀區');

    heading.textContent = chapter.heading;
    content.innerHTML = chapter.contentHTML;
    document.title = chapter.documentTitle || chapter.heading;
    updateNavigationLinks(chapter);
    renderReaderShell(chapter);

    currentURL = chapter.url;
    if (push) history.pushState({ pureReader: true, url: chapter.url }, '', chapter.url);
    document.documentElement.classList.remove('pure-reader-loading');
    readerShell?.scrollTo({ top: 0, behavior: 'auto' });

    preload(chapter.nextURL);
    dispatchEvent(new CustomEvent('purereader:chapter', { detail: { ...chapter, contentHTML: undefined } }));
  }

  async function navigate(url, options) {
    if (!url) return;
    const token = ++navigationToken;
    document.documentElement.classList.add('pure-reader-loading');

    try {
      const chapter = await loadChapter(url);
      if (token !== navigationToken) return;
      renderChapter(chapter, options);
    } catch (error) {
      document.documentElement.classList.remove('pure-reader-loading');
      // 解析或網路異常時退回原生換頁，閱讀流程不會被鎖死。
      location.assign(url);
    }
  }

  function interceptNavigation(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest(`#pure-reader-next, ${SELECTORS.next}, ${SELECTORS.previous}, ${SELECTORS.navigation} a[rel="next"], ${SELECTORS.navigation} #next_url, ${SELECTORS.navigation} #prev_url, ${SELECTORS.navigation} > a:first-child`);
    if (!link?.href || link.getAttribute('aria-disabled') === 'true') return;

    const destination = canonicalURL(link.href);
    if (new URL(destination).origin !== location.origin) return;
    event.preventDefault();
    navigate(destination);
  }

  function handleReaderKeydown(event) {
    if (!readerOpen) return;
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;

    event.preventDefault();
    if (event.repeat || !readerShell || document.documentElement.classList.contains('pure-reader-loading')) return;

    const remaining = readerShell.scrollHeight - readerShell.scrollTop - readerShell.clientHeight;
    if (remaining > 4) {
      readerShell.scrollBy({
        top: Math.max(160, readerShell.clientHeight - 96),
        behavior: 'smooth',
      });
      return;
    }

    const next = readerShell.querySelector('#pure-reader-next');
    if (next?.href && next.getAttribute('aria-disabled') !== 'true') {
      navigate(next.href);
    }
  }

  function cleanLiveContent(content) {
    const observer = new MutationObserver(() => {
      content.querySelectorAll('iframe, ins, script, .clickforceads, .adsbygoogle, [data-ad-zone]')
        .forEach((element) => element.remove());
    });
    observer.observe(content, { childList: true, subtree: true });
  }

  function installStyle() {
    const style = document.createElement('style');
    style.textContent = `
      html.pure-reader-mode,
      html.pure-reader-mode body {
        overflow: hidden !important;
      }

      html.pure-reader-mode body > :not(#pure-reader-shell) {
        visibility: hidden !important;
        pointer-events: none !important;
      }

      #pure-reader-shell {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        box-sizing: border-box;
        width: 100vw;
        height: 100dvh;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        background: var(--reader-background, #f7f3e8);
        color: var(--reader-text, #27231d);
        color-scheme: var(--reader-color-scheme, light);
        font-family: ui-serif, "Noto Serif TC", "PingFang TC", "Microsoft JhengHei", serif;
        text-align: left;
      }

      #pure-reader-shell.pure-reader-closed {
        overflow: hidden;
        background: transparent;
        pointer-events: none;
      }

      #pure-reader-shell.pure-reader-closed #pure-reader-article,
      #pure-reader-shell.pure-reader-closed #pure-reader-actions {
        display: none;
      }

      #pure-reader-show {
        display: none;
      }

      #pure-reader-shell.pure-reader-closed #pure-reader-show {
        position: fixed;
        top: max(12px, env(safe-area-inset-top));
        right: max(12px, env(safe-area-inset-right));
        display: inline-flex;
        min-height: 40px;
        align-items: center;
        justify-content: center;
        gap: 7px;
        padding: 8px 12px;
        border: 1px solid var(--reader-border, rgba(70, 58, 40, .16));
        border-radius: 12px;
        background: var(--reader-surface, #e8e0d1);
        color: var(--reader-text, #27231d);
        box-shadow: 0 4px 18px rgba(0, 0, 0, .16);
        font: 700 15px/1 ui-sans-serif, system-ui, sans-serif;
        pointer-events: auto;
        cursor: pointer;
      }

      #pure-reader-show svg {
        width: 20px;
        height: 20px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }

      #pure-reader-article {
        box-sizing: border-box;
        width: 100%;
        max-width: var(--reader-page-max-width, none);
        min-height: 100%;
        margin: 0 auto;
        padding: max(22px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) clamp(88px, 9vw, 112px) max(18px, env(safe-area-inset-left));
      }

      #pure-reader-toolbar {
        display: flex;
        width: 100%;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0 0 18px;
        font-family: ui-sans-serif, system-ui, sans-serif;
      }

      #pure-reader-toolbar button {
        display: inline-flex;
        min-width: 44px;
        min-height: 42px;
        align-items: center;
        justify-content: center;
        gap: 7px;
        padding: 8px 12px;
        border: 1px solid var(--reader-border, rgba(70, 58, 40, .16));
        border-radius: 12px;
        background: var(--reader-surface, #e8e0d1);
        color: var(--reader-text, #27231d);
        font: 700 16px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
      }

      #pure-reader-toolbar button:hover {
        filter: brightness(.96);
      }

      #pure-reader-toolbar button:focus-visible {
        outline: 3px solid var(--reader-accent, #343027);
        outline-offset: 2px;
      }

      #pure-reader-toolbar button:disabled {
        cursor: not-allowed;
        opacity: .4;
      }

      #pure-reader-theme {
        min-width: 116px;
      }

      #pure-reader-layout {
        min-width: 112px;
      }

      #pure-reader-layout svg {
        width: 18px;
        height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }

      .pure-reader-swatch {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        border: 2px solid var(--reader-text, #27231d);
        border-radius: 50%;
        background: linear-gradient(135deg, var(--reader-background, #f7f3e8) 0 50%, var(--reader-text, #27231d) 50% 100%);
      }

      #pure-reader-title {
        margin: 0 0 1.4em;
        color: inherit;
        font-size: clamp(1.35rem, 5.6vw, 1.9rem);
        font-weight: 700;
        line-height: 1.45;
        text-wrap: balance;
      }

      #pure-reader-content {
        width: 100%;
        max-width: none;
        font-size: var(--reader-font-size, 20px);
        line-height: 1.9;
        letter-spacing: .045em;
        overflow-wrap: anywhere;
      }

      #pure-reader-content p {
        margin: 0 0 1em;
        padding: 0;
        text-indent: 0;
      }

      #pure-reader-content img {
        display: block;
        width: auto;
        max-width: 100%;
        height: auto;
        margin: 1.2em auto;
      }

      #pure-reader-actions {
        position: sticky;
        bottom: 0;
        display: flex;
        box-sizing: border-box;
        width: 100%;
        align-items: center;
        gap: clamp(6px, 1vw, 10px);
        padding: clamp(6px, 1vw, 10px) max(10px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
        border-top: 1px solid var(--reader-border, rgba(70, 58, 40, .14));
        background: var(--reader-panel, rgba(247, 243, 232, .94));
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }

      #pure-reader-index,
      #pure-reader-next {
        display: flex;
        box-sizing: border-box;
        min-height: clamp(40px, 4.2vw, 52px);
        align-items: center;
        justify-content: center;
        border-radius: clamp(10px, 1.1vw, 14px);
        background: var(--reader-accent, #343027);
        color: var(--reader-accent-text, #fff);
        font: 700 clamp(15px, 1.35vw, 18px)/1 ui-sans-serif, system-ui, sans-serif;
        text-decoration: none;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
      }

      #pure-reader-index {
        width: clamp(40px, 4.2vw, 52px);
        flex: 0 0 clamp(40px, 4.2vw, 52px);
      }

      #pure-reader-index svg {
        width: 21px;
        height: 21px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }

      #pure-reader-next {
        width: auto;
        flex: 1 1 auto;
      }

      html.pure-reader-loading #pure-reader-shell {
        cursor: progress;
      }

      html.pure-reader-loading #pure-reader-content {
        opacity: .42;
      }

      #pure-reader-content { transition: opacity 120ms ease; }
      .pure-reader-disabled { opacity: .38; pointer-events: none; }
      #chaptercontent iframe,
      #chaptercontent ins,
      #chaptercontent .clickforceads,
      #chaptercontent .adsbygoogle,
      #chaptercontent [data-ad-zone] { display: none !important; }

      @media (max-width: 480px) {
        #pure-reader-toolbar {
          gap: 6px;
        }

        #pure-reader-toolbar button {
          padding-inline: 10px;
        }

        #pure-reader-theme {
          min-width: 108px;
        }

        #pure-reader-layout {
          min-width: 100px;
        }
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function bootstrap() {
    if (bootstrapped) return true;
    const chapter = readCurrentChapter();
    const content = document.querySelector(SELECTORS.content);
    if (!chapter || !content) return false;

    bootstrapped = true;
    cacheChapter(chapter);
    content.innerHTML = chapter.contentHTML;
    updateNavigationLinks(chapter);
    installStyle();
    renderReaderShell(chapter);
    cleanLiveContent(content);
    document.addEventListener('click', interceptNavigation, true);
    document.addEventListener('keydown', handleReaderKeydown, true);
    addEventListener('popstate', () => navigate(location.href, { push: false }));
    preload(chapter.nextURL);
    return true;
  }

  function watchForChapter() {
    if (!document.documentElement) {
      setTimeout(watchForChapter, 0);
      return;
    }

    const observer = new MutationObserver(() => {
      if (bootstrap()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (!bootstrap()) watchForChapter();
})();
