/**
 * PureReader Core Extraction & Fetching Engine (extractor.js)
 *
 * 統一負責：
 * 1. 網址正規化與直連快取通道（Wikipedia REST API、GitHub Raw Markdown）
 * 2. 智慧字元編碼偵測（UTF-8 / GB18030 / GBK / Big5 / Shift_JIS，避免亂碼）
 * 3. 分層對沖競速代理（Hedged Staggered Race + 熔斷器 + Bot 驗證／SPA 空殼偵測）
 * 4. 完整 Markdown 轉乾淨語意 HTML（供 Jina Reader 與 GitHub 文件使用）
 * 5. 四層正文萃取管線（站點特化規則 → Mozilla Readability → 內容密度啟發式 → JSON-LD 備援）
 * 6. 正文淨化後處理（還原懶加載／noscript 圖片、清除隱藏浮水印與雜訊、移除零寬字元、估算閱讀時間）
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.PureExtractor = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (globalScope) {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────
  const CF_PROXY_BASE = 'https://purereader-proxy-cf.dreamgen-dev.workers.dev/';
  const PROXY_TIMEOUT_FAST_MS = 10000;
  const PROXY_TIMEOUT_JINA_MS = 25000;
  const HEDGE_STAGGER_FG_MS = 2200; // 前景閱讀：超過 2.2 秒未回傳即啟動下一個備援代理競速
  const HEDGE_STAGGER_BG_MS = 4500; // 小說預載：保守對沖，降低免費代理消耗
  const STRATEGY_PREF_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天後重新評估網域最佳策略
  const CIRCUIT_BREAKER_FAILS = 2;
  const CIRCUIT_BREAKER_COOLDOWN_MS = 90 * 1000;
  const JINA_MIN_INTERVAL_MS = 3000;

  const DOMAIN_MAP = {
    'look.twword.com': 'www.novel543.com',
    'look.thisiscm.com': 'www.novel543.com',
  };

  const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
    'fbclid', 'gclid', 'yclid', 'mc_cid', 'mc_eid', 'igshid', 'igsh',
  ]);

  const STRATEGY_LABELS = {
    '-2': '直連快取通道',
    0: '自有代理 (CF)',
    1: 'CodeTabs',
    2: 'AllOrigins JSON',
    3: 'AllOrigins Raw',
    4: 'Jina 渲染引擎',
  };

  // In-memory proxy circuit breaker & Jina rate-limit state
  const _proxyHealth = new Map(); // idx -> { fails, cooldownUntil, lastMs }
  let _lastJinaRequestAt = 0;

  // ─── URL Helpers ───────────────────────────────────────────────────────────
  function normalizeUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return urlStr;
    let trimmed = urlStr.trim();
    if (!trimmed) return trimmed;
    if (!/^https?:\/\//i.test(trimmed) && /^[a-z0-9.-]+\.[a-z]{2,}(\/|\?|#|$)/i.test(trimmed)) {
      trimmed = 'https://' + trimmed;
    }
    if (!/^https?:\/\//i.test(trimmed)) return trimmed;
    try {
      const u = new URL(trimmed);
      if (DOMAIN_MAP[u.hostname]) {
        u.hostname = DOMAIN_MAP[u.hostname];
      }
      for (const key of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.has(key.toLowerCase())) {
          u.searchParams.delete(key);
        }
      }
      return u.href;
    } catch {
      return trimmed;
    }
  }

  function safeResolveUrl(href, baseUrl) {
    if (!href) return '';
    const trimmed = String(href).trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed;
    if (/^(?:javascript|vbscript|mailto|tel):/i.test(trimmed)) return '';
    try {
      if (baseUrl) {
        return new URL(trimmed, baseUrl).href;
      }
      if (/^https?:\/\//i.test(trimmed)) {
        return new URL(trimmed).href;
      }
      if (trimmed.startsWith('//')) {
        return new URL('https:' + trimmed).href;
      }
      return '';
    } catch {
      return '';
    }
  }

  // ─── Charset Detection & HTML Decoding ─────────────────────────────────────
  function normalizeCharsetName(raw) {
    if (!raw) return '';
    const c = String(raw).trim().toLowerCase().replace(/^["']|["']$/g, '');
    if (!c) return '';
    if (c === 'utf8' || c === 'utf-8') return 'utf-8';
    if (['gb2312', 'gbk', 'gb_2312', 'gb_2312-80', 'x-gbk', 'csgb2312', 'gb18030'].includes(c)) return 'gb18030';
    if (['big5', 'big5-hkscs', 'cp950', 'csbig5', 'x-x-big5'].includes(c)) return 'big5';
    if (['shift_jis', 'shift-jis', 'sjis', 'x-sjis', 'ms932', 'windows-31j'].includes(c)) return 'shift-jis';
    if (['euc-jp', 'eucjp'].includes(c)) return 'euc-jp';
    if (['euc-kr', 'euckr', 'ks_c_5601-1987', 'cp949'].includes(c)) return 'euc-kr';
    if (['iso-8859-1', 'latin1', 'windows-1252'].includes(c)) return 'windows-1252';
    return c;
  }

  function _countReplacementChars(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0xfffd) n++;
    }
    return n;
  }

  function _countCommonCjk(text) {
    const m = text.match(/[\u4e00-\u9fff]/g);
    return m ? m.length : 0;
  }

  /**
   * 智慧解碼 HTML 位元組（自動處理 GBK / GB18030 / Big5 / Shift_JIS 與代理強制標示 utf-8 的情況）
   */
  function decodeHtmlBytes(input, contentTypeHeader = '') {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    if (bytes.length === 0) return '';

    // 1. Check BOM
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: false }).decode(bytes);
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be', { fatal: false }).decode(bytes);
    }

    // 2. Inspect HTTP header charset & HTML <meta charset>
    const headerMatch = (contentTypeHeader || '').match(/charset\s*=\s*([^\s;]+)/i);
    const headerCharset = normalizeCharsetName(headerMatch?.[1]);

    const headLen = Math.min(bytes.length, 4096);
    let asciiHead = '';
    for (let i = 0; i < headLen; i++) asciiHead += String.fromCharCode(bytes[i]);

    const metaMatch =
      asciiHead.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i) ||
      asciiHead.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i) ||
      asciiHead.match(/<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9._-]+)/i);
    const metaCharset = normalizeCharsetName(metaMatch?.[1]);

    // 3. Test strict UTF-8 validity first (handles proxies that already transcoded to UTF-8 while keeping <meta charset="gbk">)
    let strictUtf8 = null;
    try {
      strictUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      strictUtf8 = null;
    }

    if (strictUtf8 !== null) {
      // If bytes are 100% valid UTF-8 and either have non-ASCII or declared UTF-8, trust UTF-8!
      const declaredNonUtf8 = (metaCharset && metaCharset !== 'utf-8') || (headerCharset && headerCharset !== 'utf-8');
      if (!declaredNonUtf8 || /[\u0080-\uffff]/.test(strictUtf8)) {
        return strictUtf8;
      }
    }

    // 4. Not valid UTF-8 — decode using declared charset (prefer non-UTF-8 meta/header)
    const declared =
      (headerCharset && headerCharset !== 'utf-8' ? headerCharset : '') ||
      (metaCharset && metaCharset !== 'utf-8' ? metaCharset : '');

    if (declared) {
      try {
        return new TextDecoder(declared, { fatal: false }).decode(bytes);
      } catch {
        // fall through to heuristic
      }
    }

    // 5. Fallback heuristic for undeclared non-UTF-8 CJK pages (GB18030 vs Big5)
    const utf8Loose = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const utf8Bad = _countReplacementChars(utf8Loose);
    if (utf8Bad === 0) return utf8Loose;

    let bestText = utf8Loose;
    let bestScore = _countCommonCjk(utf8Loose) - utf8Bad * 10;
    for (const candidate of ['gb18030', 'big5', 'shift-jis']) {
      try {
        const decoded = new TextDecoder(candidate, { fatal: false }).decode(bytes);
        const bad = _countReplacementChars(decoded);
        const score = _countCommonCjk(decoded) - bad * 10;
        if (score > bestScore) {
          bestScore = score;
          bestText = decoded;
        }
      } catch {
        // encoding unsupported in runtime
      }
    }
    return bestText;
  }

  /**
   * 解碼 AllOrigins JSON 偶爾回傳的 data:text/html;...;base64,... 內容
   */
  function decodeDataUrlIfNeeded(contents) {
    if (typeof contents !== 'string') return '';
    const m = contents.match(/^data:([^;,]*(?:;[^;,]*)*);base64,([\s\S]+)$/i);
    if (!m) return contents;
    try {
      const mime = m[1] || 'text/html';
      const b64 = m[2].replace(/\s+/g, '');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return decodeHtmlBytes(bytes, mime);
    } catch {
      return contents;
    }
  }

  // ─── Page Diagnostics (Bot Challenge / Soft Error / Redirect / SPA) ─────────
  function _stripTagsQuick(html) {
    return String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isBotChallengePage(html) {
    if (!html || typeof html !== 'string') return false;
    // 注意：正常頁面可能載入 cloudflareinsights beacon 或 challenge-platform/.../jsd/main.js，
    // 不可當作 challenge 判定依據。
    if (
      html.includes('cf-browser-verification') ||
      html.includes('Just a moment...') ||
      html.includes('Checking if the site connection is secure') ||
      html.includes('_cf_chl_opt') ||
      html.includes('cf_chl_') ||
      html.includes('id="challenge-running"') ||
      html.includes('id="challenge-stage"') ||
      html.includes('Attention Required! | Cloudflare') ||
      html.includes('_Incapsula_Resource') ||
      html.includes('px-captcha') ||
      html.includes('Enable JavaScript and cookies to continue')
    ) {
      return true;
    }
    if (html.length < 25000 && html.includes('Cloudflare') && html.includes('Ray ID')) {
      return true;
    }
    // Short Akamai / DDoS-Guard / generic human verification walls
    if (html.length < 15000) {
      const visible = _stripTagsQuick(html);
      if (visible.length < 300) {
        if (
          /DDoS-Guard|Access Denied.*Reference #|Please verify you are a human|Verify you are human|Checking your browser before accessing/i.test(visible)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function isSoftErrorPage(html) {
    if (!html || typeof html !== 'string') return true;
    if (html.length > 18000) return false;
    const visible = _stripTagsQuick(html);
    if (visible.length > 260) return false;
    return /^(?:error\s*)?(?:400|401|403|404|410|429|500|502|503|504)\b|403 Forbidden|404 Not Found|502 Bad Gateway|503 Service(?: Temporarily)? Unavailable|Access Denied|Page Not Found/i.test(
      visible
    );
  }

  function isPttOver18Page(html, url = '') {
    if (!html) return false;
    if (url && !/ptt\.cc/i.test(url)) return false;
    return html.includes('/ask/over18') && html.includes('年滿十八歲');
  }

  function isUsableHtml(html, url = '') {
    if (!html || typeof html !== 'string' || html.length < 400) return false;
    if (isBotChallengePage(html)) return false;
    if (isSoftErrorPage(html)) return false;
    if (isPttOver18Page(html, url)) return false;
    return true;
  }

  /**
   * 偵測 HTML Meta Refresh 或 JS 重導向（僅在頁面簡短或幾乎無可見內文時觸發）
   */
  function detectClientRedirect(html, baseUrl) {
    if (!html || typeof html !== 'string') return null;
    if (html.length > 10000 && _stripTagsQuick(html).length > 220) return null;

    // 1. <meta http-equiv="refresh" content="0;url=...">
    const metaRefresh = html.match(
      /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"';\s>]+)/i
    );
    if (metaRefresh?.[1]) {
      const resolved = safeResolveUrl(metaRefresh[1].replace(/^['"]|['"]$/g, ''), baseUrl);
      if (resolved && resolved !== baseUrl) return resolved;
    }

    // 2. window.location / location.href / location.replace / location.assign
    const jsMatch = html.match(
      /(?:window\.|top\.|self\.)?location(?:\.(?:href|replace|assign))?\s*(?:=|\()\s*['"]([^'"]+)['"]/i
    );
    if (jsMatch?.[1]) {
      const candidate = jsMatch[1].trim();
      if (candidate && !candidate.startsWith('#') && !/^javascript:/i.test(candidate)) {
        const resolved = safeResolveUrl(candidate, baseUrl);
        if (resolved && resolved !== baseUrl) return resolved;
      }
    }
    return null;
  }

  /**
   * 偵測無內容的 SPA 空殼頁面（大量 JS 但靜態 HTML 幾乎沒有正文，應自動升級至無頭瀏覽器渲染）
   */
  function looksLikeEmptySpaShell(html) {
    if (!html || typeof html !== 'string') return false;
    // 若是簡短轉址頁，應走重導向追蹤而非當作 SPA 空殼
    if (detectClientRedirect(html, 'https://example.com/')) return false;
    // 若頁面內嵌 JSON-LD articleBody，靜態解析即可提取正文，不視為空殼
    if (/"articleBody"\s*:\s*"[^"]{160,}/i.test(html)) return false;
    // 來自 Jina Markdown 的 HTML 不視為空殼
    if (html.includes('name="pr-source" content="jina-markdown"')) return false;

    const visible = _stripTagsQuick(html);
    if (visible.length >= 220) return false;

    // 極少可見文字 + 常見 SPA 掛載點或啟用 JS 提示
    if (
      /<div[^>]+id=["'](?:root|app|__next|__nuxt|svelte|gatsby-focus-wrapper)["']/i.test(html) ||
      /enable javascript|javascript is required|please turn on javascript|noscript/i.test(html) ||
      (html.length > 2500 && visible.length < 140)
    ) {
      return true;
    }
    return false;
  }

  // ─── Rich Markdown-to-HTML Converter (Jina Reader & GitHub .md) ────────────
  function _escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _isJunkImageUrl(url) {
    if (!url) return true;
    return /(?:doubleclick|google-analytics|googletagmanager|facebook\.com\/tr|pixel\.wp\.com|hm\.baidu\.com|scorecardresearch|gravatar\.com\/avatar\/[^?]*s=(?:16|24|32)|1x1|blank\.gif|spacer\.gif|loading\.gif)/i.test(
      url
    );
  }

  function _renderInlineMarkdown(text, baseUrl) {
    let s = _escapeHtml(text);

    // Inline code (`code`) — protect content from further inline replacements
    const codeSlots = [];
    s = s.replace(/`([^`]+)`/g, (_, code) => {
      const idx = codeSlots.length;
      codeSlots.push(`<code>${code}</code>`);
      return `\u0000CODE${idx}\u0000`;
    });

    // Linked image: [![alt](imgUrl)](linkUrl)
    s = s.replace(/\[!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)\]\(([^)\s]+)\)/g, (_, alt, imgUrl) => {
      const resolved = safeResolveUrl(imgUrl.replace(/&amp;/g, '&'), baseUrl);
      if (!resolved || _isJunkImageUrl(resolved)) return '';
      return `<img src="${_escapeHtml(resolved)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
    });

    // Standalone image: ![alt](imgUrl)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, imgUrl) => {
      const resolved = safeResolveUrl(imgUrl.replace(/&amp;/g, '&'), baseUrl);
      if (!resolved || _isJunkImageUrl(resolved)) return '';
      return `<img src="${_escapeHtml(resolved)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
    });

    // Links: [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, href) => {
      const resolved = safeResolveUrl(href.replace(/&amp;/g, '&'), baseUrl);
      if (!resolved) return label;
      return `<a href="${_escapeHtml(resolved)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    // Bold, italic, strikethrough
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // Restore inline code
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeSlots[Number(idx)] || '');
    return s;
  }

  function _isNavClutterLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // Lines composed almost entirely of markdown links separated by | / · / spaces (typical header/footer nav dump)
    const withoutLinks = trimmed
      .replace(/!?\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/[\s|*•·/\\›»—–\-·•[\]()]+/g, '');
    const linkCount = (trimmed.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
    if (linkCount >= 3 && withoutLinks.length < 8) return true;
    return false;
  }

  function _isTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  function _splitTableCells(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  }

  /**
   * 將 Jina Reader 或 GitHub 的 Markdown 轉成結構完整、乾淨的語意 HTML
   */
  function markdownToHtml(markdown, fallbackUrl = '', { isJina = true } = {}) {
    if (!markdown || typeof markdown !== 'string') return '';

    let title = '';
    let publishedTime = '';
    let sourceUrl = fallbackUrl;
    let body = markdown.replace(/\r\n?/g, '\n');

    if (isJina) {
      const titleMatch = body.match(/^Title:\s*(.+)$/m);
      if (titleMatch) title = titleMatch[1].trim();
      const urlMatch = body.match(/^URL Source:\s*(.+)$/m);
      if (urlMatch) sourceUrl = urlMatch[1].trim() || fallbackUrl;
      const pubMatch = body.match(/^Published Time:\s*(.+)$/m);
      if (pubMatch) publishedTime = pubMatch[1].trim();

      const contentIdx = body.indexOf('Markdown Content:');
      if (contentIdx >= 0) {
        body = body.slice(contentIdx + 'Markdown Content:'.length);
      } else {
        // Strip leading metadata header lines if "Markdown Content:" marker absent
        body = body.replace(/^(?:Title|URL Source|Published Time|Warning):.*\n/gm, '');
      }
    }

    // Separate Jina Links/Buttons summary into footer (useful for NovelMode _findNextUrl)
    let linksText = '';
    const linksMatch = body.match(/(?:^|\n)Links\/Buttons:/i);
    if (linksMatch && typeof linksMatch.index === 'number') {
      linksText = body.slice(linksMatch.index + linksMatch[0].length);
      body = body.slice(0, linksMatch.index);
    }

    const lines = body.split('\n');
    // Trim leading nav-bar link dumps (only before substantive content begins)
    let startIdx = 0;
    while (startIdx < lines.length && (!lines[startIdx].trim() || _isNavClutterLine(lines[startIdx]))) {
      startIdx++;
    }
    const cleanLines = lines.slice(startIdx);

    const htmlParts = [];
    let i = 0;
    let firstHeadingUsedAsTitle = false;

    while (i < cleanLines.length) {
      const line = cleanLines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // Skip isolated Jina warning banners or nav bars
      if (/^Warning:\s+/i.test(trimmed) || _isNavClutterLine(trimmed)) {
        i++;
        continue;
      }

      // 1. Fenced code block (``` ... ```)
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)/);
      if (fenceMatch) {
        const fence = fenceMatch[1][0].repeat(fenceMatch[1].length);
        const lang = fenceMatch[2] || '';
        const codeLines = [];
        i++;
        while (i < cleanLines.length && !cleanLines[i].trim().startsWith(fence)) {
          codeLines.push(cleanLines[i]);
          i++;
        }
        i++; // consume closing fence
        const langAttr = lang ? ` class="language-${_escapeHtml(lang)}"` : '';
        htmlParts.push(`<pre><code${langAttr}>${_escapeHtml(codeLines.join('\n'))}</code></pre>`);
        continue;
      }

      // 2. ATX Heading (# ... ######)
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2].trim();
        if (!title && level === 1 && !firstHeadingUsedAsTitle) {
          title = headingText.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
          firstHeadingUsedAsTitle = true;
        } else {
          htmlParts.push(`<h${level}>${_renderInlineMarkdown(headingText, sourceUrl)}</h${level}>`);
        }
        i++;
        continue;
      }

      // 3. Setext Heading (Title\n===== or -----)
      if (i + 1 < cleanLines.length && /^(?:={3,}|-{3,})\s*$/.test(cleanLines[i + 1].trim()) && trimmed.length < 160) {
        const level = cleanLines[i + 1].trim().startsWith('=') ? 1 : 2;
        if (!title && level === 1 && !firstHeadingUsedAsTitle) {
          title = trimmed.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
          firstHeadingUsedAsTitle = true;
        } else {
          htmlParts.push(`<h${level}>${_renderInlineMarkdown(trimmed, sourceUrl)}</h${level}>`);
        }
        i += 2;
        continue;
      }

      // 4. Horizontal rule
      if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
        htmlParts.push('<hr>');
        i++;
        continue;
      }

      // 5. Table
      if (trimmed.includes('|') && i + 1 < cleanLines.length && _isTableSeparator(cleanLines[i + 1])) {
        const headers = _splitTableCells(trimmed);
        i += 2;
        const rows = [];
        while (i < cleanLines.length && cleanLines[i].trim() && cleanLines[i].includes('|')) {
          rows.push(_splitTableCells(cleanLines[i]));
          i++;
        }
        const thead = `<thead><tr>${headers.map((h) => `<th>${_renderInlineMarkdown(h, sourceUrl)}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${_renderInlineMarkdown(c, sourceUrl)}</td>`).join('')}</tr>`)
          .join('')}</tbody>`;
        htmlParts.push(`<table>${thead}${tbody}</table>`);
        continue;
      }

      // 6. Blockquote
      if (trimmed.startsWith('>')) {
        const quoteLines = [];
        while (i < cleanLines.length && cleanLines[i].trim().startsWith('>')) {
          quoteLines.push(cleanLines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        htmlParts.push(
          `<blockquote><p>${quoteLines.map((q) => _renderInlineMarkdown(q, sourceUrl)).join('<br>')}</p></blockquote>`
        );
        continue;
      }

      // 7. Unordered list
      if (/^[-*+]\s+/.test(trimmed)) {
        const items = [];
        while (i < cleanLines.length && /^\s*[-*+]\s+/.test(cleanLines[i])) {
          items.push(cleanLines[i].trim().replace(/^[-*+]\s+/, ''));
          i++;
        }
        htmlParts.push(`<ul>${items.map((it) => `<li>${_renderInlineMarkdown(it, sourceUrl)}</li>`).join('')}</ul>`);
        continue;
      }

      // 8. Ordered list
      if (/^\d+[.)]\s+/.test(trimmed)) {
        const items = [];
        while (i < cleanLines.length && /^\s*\d+[.)]\s+/.test(cleanLines[i])) {
          items.push(cleanLines[i].trim().replace(/^\d+[.)]\s+/, ''));
          i++;
        }
        htmlParts.push(`<ol>${items.map((it) => `<li>${_renderInlineMarkdown(it, sourceUrl)}</li>`).join('')}</ol>`);
        continue;
      }

      // 9. Standalone Image line -> <figure>
      const standaloneImg = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
      if (standaloneImg) {
        const resolved = safeResolveUrl(standaloneImg[2], sourceUrl);
        if (resolved && !_isJunkImageUrl(resolved)) {
          const alt = standaloneImg[1].trim();
          const cap = alt && !/^Image\s*\d*$/i.test(alt) ? `<figcaption>${_escapeHtml(alt)}</figcaption>` : '';
          htmlParts.push(
            `<figure><img src="${_escapeHtml(resolved)}" alt="${_escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">${cap}</figure>`
          );
        }
        i++;
        continue;
      }

      // 10. Regular paragraph (merge consecutive plain lines until blank line or block starter)
      const paraLines = [];
      while (i < cleanLines.length) {
        const cur = cleanLines[i].trim();
        if (
          !cur ||
          /^#{1,6}\s+/.test(cur) ||
          /^(`{3,}|~{3,})/.test(cur) ||
          cur.startsWith('>') ||
          /^[-*+]\s+/.test(cur) ||
          /^\d+[.)]\s+/.test(cur) ||
          /^(?:[-*_]\s*){3,}$/.test(cur) ||
          _isNavClutterLine(cur)
        ) {
          break;
        }
        paraLines.push(cur);
        i++;
      }
      if (paraLines.length > 0) {
        const rendered = paraLines.map((p) => _renderInlineMarkdown(p, sourceUrl)).join('<br>');
        if (rendered.trim()) {
          htmlParts.push(`<p>${rendered}</p>`);
        }
      }
    }

    // Footer links block for NovelMode next-chapter discovery
    let footerHtml = '';
    if (linksText.trim()) {
      const linkAnchors = [];
      const linkRegex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
      let m;
      while ((m = linkRegex.exec(linksText)) !== null) {
        const href = safeResolveUrl(m[2], sourceUrl);
        if (href) {
          linkAnchors.push(`<a href="${_escapeHtml(href)}">${_escapeHtml(m[1])}</a>`);
        }
      }
      if (linkAnchors.length > 0) {
        footerHtml = `<footer data-pr-links="1">${linkAnchors.join(' ')}</footer>`;
      }
    }

    const metaTags = [
      `<meta name="pr-source" content="${isJina ? 'jina-markdown' : 'raw-markdown'}">`,
      publishedTime ? `<meta property="article:published_time" content="${_escapeHtml(publishedTime)}">` : '',
      sourceUrl ? `<base href="${_escapeHtml(sourceUrl)}">` : '',
    ]
      .filter(Boolean)
      .join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${_escapeHtml(title)}</title>${metaTags}</head><body><article>${htmlParts.join('\n')}</article>${footerHtml}</body></html>`;
  }

  // ─── Direct Fast-Path Resolvers (Zero-Proxy CORS Platforms) ────────────────
  async function tryDirectFastFetch(url, signal, { setStatus, fetchImpl = globalScope.fetch } = {}) {
    if (!fetchImpl) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    const startedAt = Date.now();

    // 1. Wikipedia REST API (supports CORS *, returns clean semantic HTML)
    const wikiMatch = parsed.hostname.match(/^([a-z-]+)\.(?:m\.)?wikipedia\.org$/i);
    if (wikiMatch && parsed.pathname.startsWith('/wiki/')) {
      const lang = wikiMatch[1].toLowerCase();
      const slug = parsed.pathname.slice('/wiki/'.length);
      if (slug && !slug.includes(':')) {
        try {
          if (setStatus) setStatus('透過 Wikipedia 直連通道高速讀取…');
          const apiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${slug}`;
          const ctrl = new AbortController();
          const onAbort = () => ctrl.abort();
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => ctrl.abort(), 7000);
          try {
            const res = await fetchImpl(apiUrl, { signal: ctrl.signal });
            if (res.ok) {
              const html = await res.text();
              if (html && html.length >= 400) {
                return {
                  html,
                  finalUrl: url,
                  winnerIdx: -2,
                  winnerLabel: 'Wikipedia 直連',
                  elapsedMs: Date.now() - startedAt,
                  isMarkdown: false,
                  hadChallengePage: false,
                };
              }
            }
          } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
          }
        } catch (e) {
          if (e.name === 'AbortError' && signal?.aborted) throw e;
        }
      }
    }

    // 2. GitHub / Raw GitHub Markdown files (supports CORS *)
    let rawMdUrl = null;
    if (parsed.hostname === 'raw.githubusercontent.com' && /\.(?:md|markdown|txt)$/i.test(parsed.pathname)) {
      rawMdUrl = parsed.href;
    } else if (parsed.hostname === 'github.com') {
      const ghBlob = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+\.(?:md|markdown))$/i);
      if (ghBlob) {
        rawMdUrl = `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}`;
      }
    }

    if (rawMdUrl) {
      try {
        if (setStatus) setStatus('透過 GitHub 直連通道讀取文件…');
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ctrl.abort(), 7000);
        try {
          const res = await fetchImpl(rawMdUrl, { signal: ctrl.signal });
          if (res.ok) {
            const md = await res.text();
            if (md && md.length >= 40) {
              return {
                html: markdownToHtml(md, url, { isJina: false }),
                finalUrl: url,
                winnerIdx: -2,
                winnerLabel: 'GitHub 直連',
                elapsedMs: Date.now() - startedAt,
                isMarkdown: true,
                hadChallengePage: false,
              };
            }
          }
        } finally {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      } catch (e) {
        if (e.name === 'AbortError' && signal?.aborted) throw e;
      }
    }

    return null;
  }

  // ─── Proxy Circuit Breaker & Strategy Builders ─────────────────────────────
  function _isProxyCoolingDown(idx) {
    const h = _proxyHealth.get(idx);
    return Boolean(h && h.cooldownUntil && Date.now() < h.cooldownUntil);
  }

  function _recordProxySuccess(idx, elapsedMs) {
    _proxyHealth.set(idx, { fails: 0, cooldownUntil: 0, lastMs: elapsedMs });
  }

  function _recordProxyFailure(idx, isNetworkOrServerError) {
    if (!isNetworkOrServerError) return;
    const prev = _proxyHealth.get(idx) || { fails: 0, cooldownUntil: 0, lastMs: 0 };
    const fails = prev.fails + 1;
    const cooldownUntil = fails >= CIRCUIT_BREAKER_FAILS ? Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS : 0;
    _proxyHealth.set(idx, { fails, cooldownUntil, lastMs: prev.lastMs });
  }

  function resetProxyHealth() {
    _proxyHealth.clear();
  }

  function _sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function _waitJinaRateLimit(signal) {
    const now = Date.now();
    const diff = now - _lastJinaRequestAt;
    if (diff < JINA_MIN_INTERVAL_MS) {
      await _sleepWithSignal(JINA_MIN_INTERVAL_MS - diff, signal);
    }
    _lastJinaRequestAt = Date.now();
  }

  async function fetchJinaReader(url, { signal, mode = 'article', fetchImpl = globalScope.fetch } = {}) {
    await _waitJinaRateLimit(signal);

    // 小說模式優先嘗試 HTML 以保留完整章節導覽列；一般文章優先走免 Preflight 的 Markdown（更快更乾淨）
    if (mode === 'novel') {
      try {
        const res = await fetchImpl(`https://r.jina.ai/${url}`, {
          headers: { 'X-Return-Format': 'html' },
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        return { html, finalUrl: url, isMarkdown: false };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // CORS preflight 失敗時改用無自訂 header 的簡單 GET（不觸發 preflight）
        const res2 = await fetchImpl(`https://r.jina.ai/${url}`, { signal });
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
        const md = await res2.text();
        return { html: markdownToHtml(md, url, { isJina: true }), finalUrl: url, isMarkdown: true };
      }
    }

    // 一般文章模式：無自訂 header 簡單請求（零 CORS Preflight 延遲，直接取得無頭瀏覽器萃取結果）
    const res = await fetchImpl(`https://r.jina.ai/${url}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();
    return { html: markdownToHtml(md, url, { isJina: true }), finalUrl: url, isMarkdown: true };
  }

  function _buildFastStrategies(url, { fresh = false, fetchImpl = globalScope.fetch } = {}) {
    const cfQuery = `${CF_PROXY_BASE}?url=${encodeURIComponent(url)}${fresh ? '&fresh=1' : ''}`;
    return [
      {
        idx: 0,
        label: STRATEGY_LABELS[0],
        fn: async (sig) => {
          const res = await fetchImpl(cfQuery, { signal: sig });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const html = decodeHtmlBytes(buf, res.headers.get('content-type') || '');
          const finalUrl = res.headers.get('x-final-url') || url;
          return { html, finalUrl, isMarkdown: false };
        },
      },
      {
        idx: 2,
        label: STRATEGY_LABELS[2],
        fn: async (sig) => {
          const res = await fetchImpl(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { signal: sig });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data?.status?.http_code >= 400) throw new Error(`HTTP ${data.status.http_code}`);
          const html = decodeDataUrlIfNeeded(data?.contents || '');
          const finalUrl = data?.status?.url || url;
          return { html, finalUrl, isMarkdown: false };
        },
      },
      {
        idx: 1,
        label: STRATEGY_LABELS[1],
        fn: async (sig) => {
          const res = await fetchImpl(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, { signal: sig });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const html = decodeHtmlBytes(buf, res.headers.get('content-type') || '');
          return { html, finalUrl: url, isMarkdown: false };
        },
      },
      {
        idx: 3,
        label: STRATEGY_LABELS[3],
        fn: async (sig) => {
          const res = await fetchImpl(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { signal: sig });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const html = decodeHtmlBytes(buf, res.headers.get('content-type') || '');
          return { html, finalUrl: url, isMarkdown: false };
        },
      },
    ];
  }

  function _orderFastStrategies(strategies, preferredIdx) {
    const healthy = [];
    const cooling = [];
    for (const s of strategies) {
      if (_isProxyCoolingDown(s.idx)) cooling.push(s);
      else healthy.push(s);
    }
    const ordered = [...healthy, ...cooling];
    if (preferredIdx >= 0 && preferredIdx !== 4) {
      const prefPos = ordered.findIndex((s) => s.idx === preferredIdx);
      if (prefPos > 0 && !_isProxyCoolingDown(preferredIdx)) {
        const [pref] = ordered.splice(prefPos, 1);
        ordered.unshift(pref);
      }
    }
    return ordered;
  }

  /**
   * 執行單一策略並加上獨立逾時與外部 Abort 連動
   */
  async function _runStrategyWithTimeout(strategy, outerSignal, timeoutMs) {
    const stratCtrl = new AbortController();
    const onOuterAbort = () => stratCtrl.abort();
    if (outerSignal) {
      if (outerSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stratCtrl.abort();
    }, timeoutMs);

    const startedAt = Date.now();
    try {
      const result = await strategy.fn(stratCtrl.signal);
      return { ...result, elapsedMs: Date.now() - startedAt };
    } catch (e) {
      if (e.name === 'AbortError' && !timedOut && outerSignal?.aborted) {
        throw e;
      }
      const err = new Error(timedOut ? `逾時 (${Math.round(timeoutMs / 1000)}s)` : e.message || '請求失敗');
      err.isNetworkOrServer = true;
      err.timedOut = timedOut;
      throw err;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * 對沖競速抓取引擎（Hedged Staggered Race）
   * - 優先直連快取通道（Wikipedia / GitHub .md）
   * - 首選策略超時前若超過 staggerMs 未回應，自動並行啟動下一個代理，第一個回傳可用 HTML 者勝出並立即中止其餘請求
   * - 偵測到 Bot Challenge / SPA 空殼時自動升級至 Jina Reader 無頭瀏覽器渲染
   */
  async function fetchViaProxies(
    url,
    {
      signal,
      preferredIdx = -1,
      setStatus,
      mode = 'article',
      fresh = false,
      forceJina = false,
      hedged = true,
      fetchImpl = globalScope.fetch,
    } = {}
  ) {
    const overallStart = Date.now();

    // 0. 強制使用 Jina 無頭瀏覽器渲染（例如使用者點擊「深度渲染重抓」）
    if (forceJina) {
      if (setStatus) setStatus('正在透過無頭瀏覽器 (Jina Reader) 深度渲染網頁…');
      try {
        const res = await _runStrategyWithTimeout(
          {
            idx: 4,
            label: STRATEGY_LABELS[4],
            fn: (sig) => fetchJinaReader(url, { signal: sig, mode, fetchImpl }),
          },
          signal,
          PROXY_TIMEOUT_JINA_MS
        );
        if (isUsableHtml(res.html, url)) {
          return {
            html: res.html,
            finalUrl: res.finalUrl || url,
            winnerIdx: 4,
            winnerLabel: STRATEGY_LABELS[4],
            elapsedMs: Date.now() - overallStart,
            isMarkdown: Boolean(res.isMarkdown),
            hadChallengePage: false,
            lastError: '',
          };
        }
        return {
          html: null,
          finalUrl: url,
          winnerIdx: -1,
          winnerLabel: '',
          elapsedMs: Date.now() - overallStart,
          isMarkdown: false,
          hadChallengePage: isBotChallengePage(res.html),
          lastError: '深度渲染未取得有效內容',
        };
      } catch (e) {
        if (e.name === 'AbortError' && signal?.aborted) throw e;
        return {
          html: null,
          finalUrl: url,
          winnerIdx: -1,
          winnerLabel: '',
          elapsedMs: Date.now() - overallStart,
          isMarkdown: false,
          hadChallengePage: false,
          lastError: e.message || '深度渲染失敗',
        };
      }
    }

    // 1. 直連快取通道（免代理、最低延遲）
    if (!fresh) {
      const direct = await tryDirectFastFetch(url, signal, { setStatus, fetchImpl });
      if (direct) return { ...direct, lastError: '' };
    }

    // 2. 若此網域慣用策略已是 Jina（曾確認需無頭瀏覽器渲染或擋所有 HTTP 代理），直接先跑 Jina 省去等待時間
    if (preferredIdx === 4) {
      if (setStatus) setStatus('嘗試慣用通道 (Jina 渲染引擎)…');
      try {
        const res = await _runStrategyWithTimeout(
          {
            idx: 4,
            label: STRATEGY_LABELS[4],
            fn: (sig) => fetchJinaReader(url, { signal: sig, mode, fetchImpl }),
          },
          signal,
          PROXY_TIMEOUT_JINA_MS
        );
        if (isUsableHtml(res.html, url)) {
          return {
            html: res.html,
            finalUrl: res.finalUrl || url,
            winnerIdx: 4,
            winnerLabel: STRATEGY_LABELS[4],
            elapsedMs: Date.now() - overallStart,
            isMarkdown: Boolean(res.isMarkdown),
            hadChallengePage: false,
            lastError: '',
          };
        }
      } catch (e) {
        if (e.name === 'AbortError' && signal?.aborted) throw e;
      }
    }

    // 3. 快速 HTTP 代理層（對沖競速）
    const fastStrategies = _orderFastStrategies(_buildFastStrategies(url, { fresh, fetchImpl }), preferredIdx);
    const staggerMs = hedged ? HEDGE_STAGGER_FG_MS : HEDGE_STAGGER_BG_MS;

    const raceResult = await _runHedgedRace(fastStrategies, url, {
      outerSignal: signal,
      staggerMs,
      mode,
      preferredIdx,
      setStatus,
    });

    if (raceResult.winner) {
      return {
        html: raceResult.winner.html,
        finalUrl: raceResult.winner.finalUrl || url,
        winnerIdx: raceResult.winner.idx,
        winnerLabel: raceResult.winner.label,
        elapsedMs: Date.now() - overallStart,
        isMarkdown: Boolean(raceResult.winner.isMarkdown),
        hadChallengePage: raceResult.hadChallengePage,
        lastError: '',
      };
    }

    // 4. 最終防線：自動升級至 Jina Reader（所有快速代理失敗、遇防火牆或僅取得 SPA 空殼）
    if (preferredIdx !== 4) {
      if (setStatus) {
        setStatus(
          raceResult.spaFallback
            ? '偵測到動態網頁，自動切換無頭瀏覽器渲染 (Jina)…'
            : raceResult.hadChallengePage
              ? '一般代理遭防火牆阻擋，改用無頭瀏覽器穿透 (Jina)…'
              : '一般代理回應異常，啟用最終備援 (Jina 渲染引擎)…'
        );
      }
      try {
        const res = await _runStrategyWithTimeout(
          {
            idx: 4,
            label: STRATEGY_LABELS[4],
            fn: (sig) => fetchJinaReader(url, { signal: sig, mode, fetchImpl }),
          },
          signal,
          PROXY_TIMEOUT_JINA_MS
        );
        if (isUsableHtml(res.html, url)) {
          return {
            html: res.html,
            finalUrl: res.finalUrl || url,
            winnerIdx: 4,
            winnerLabel: STRATEGY_LABELS[4],
            elapsedMs: Date.now() - overallStart,
            isMarkdown: Boolean(res.isMarkdown),
            hadChallengePage: raceResult.hadChallengePage,
            lastError: '',
          };
        }
        if (res.html && isBotChallengePage(res.html)) {
          raceResult.hadChallengePage = true;
        }
      } catch (e) {
        if (e.name === 'AbortError' && signal?.aborted) throw e;
        raceResult.lastError = e.message || raceResult.lastError;
      }
    }

    // 若 Jina 也失敗但有 SPA fallback HTML，仍回傳給萃取層嘗試 JSON-LD / meta 提取
    if (raceResult.spaFallback) {
      return {
        html: raceResult.spaFallback.html,
        finalUrl: raceResult.spaFallback.finalUrl || url,
        winnerIdx: raceResult.spaFallback.idx,
        winnerLabel: raceResult.spaFallback.label,
        elapsedMs: Date.now() - overallStart,
        isMarkdown: false,
        hadChallengePage: raceResult.hadChallengePage,
        lastError: '',
      };
    }

    return {
      html: null,
      finalUrl: url,
      winnerIdx: -1,
      winnerLabel: '',
      elapsedMs: Date.now() - overallStart,
      isMarkdown: false,
      hadChallengePage: raceResult.hadChallengePage,
      lastError: raceResult.lastError || '所有代理均失敗',
    };
  }

  function _runHedgedRace(strategies, url, { outerSignal, staggerMs, mode, preferredIdx, setStatus }) {
    return new Promise((resolve, reject) => {
      if (outerSignal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const raceCtrl = new AbortController();
      let settled = false;
      let nextIdx = 0;
      let activeCount = 0;
      let staggerTimer = null;
      let lastError = '';
      let hadChallengePage = false;
      let spaFallback = null;
      const activeLabels = new Set();

      const onOuterAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(staggerTimer);
        raceCtrl.abort();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (outerSignal) outerSignal.addEventListener('abort', onOuterAbort, { once: true });

      function updateStatus() {
        if (!setStatus || settled) return;
        const names = [...activeLabels];
        if (names.length === 1) {
          const isPref = strategies.find((s) => s.label === names[0])?.idx === preferredIdx;
          setStatus(`正在透過 ${names[0]}${isPref ? ' ★慣用' : ''} 擷取…`);
        } else if (names.length > 1) {
          setStatus(`多路競速擷取中 (${names.join(' + ')})…`);
        }
      }

      function finish(winner) {
        if (settled) return;
        settled = true;
        clearTimeout(staggerTimer);
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
        raceCtrl.abort(); // 立即取消其餘未完成的備援請求
        resolve({ winner, lastError, hadChallengePage, spaFallback });
      }

      function scheduleNext() {
        clearTimeout(staggerTimer);
        if (settled || nextIdx >= strategies.length) return;
        staggerTimer = setTimeout(() => {
          launchNext();
        }, staggerMs);
      }

      function launchNext() {
        if (settled || nextIdx >= strategies.length) return;
        const strategy = strategies[nextIdx++];
        activeCount++;
        activeLabels.add(strategy.label);
        updateStatus();

        // 若還有下一個策略，排程對沖啟動（避免單一代理卡死）
        if (nextIdx < strategies.length) {
          scheduleNext();
        }

        _runStrategyWithTimeout(strategy, raceCtrl.signal, PROXY_TIMEOUT_FAST_MS)
          .then((res) => {
            activeLabels.delete(strategy.label);
            if (settled) return;

            if (isUsableHtml(res.html, url)) {
              // 偵測 SPA 空殼（文章模式下不直接當作最終勝出，繼續找其他代理或交給 Jina 渲染）
              if (mode !== 'novel' && looksLikeEmptySpaShell(res.html)) {
                if (!spaFallback) {
                  spaFallback = { ...res, idx: strategy.idx, label: strategy.label };
                }
                lastError = '偵測到動態網頁 (SPA)';
                // 若還沒把後續策略啟動完，先不浪費時間在同樣是靜態 HTTP 的代理上，直接結束快速層交給 Jina！
                finish(null);
                return;
              }
              _recordProxySuccess(strategy.idx, res.elapsedMs);
              finish({ ...res, idx: strategy.idx, label: strategy.label });
              return;
            }

            if (res.html && isBotChallengePage(res.html)) {
              hadChallengePage = true;
              lastError = '網站防火牆／真人驗證';
            } else if (res.html && isPttOver18Page(res.html, url)) {
              lastError = '需通過滿 18 歲確認頁';
            } else if (res.html && isSoftErrorPage(res.html)) {
              lastError = '目標網頁回傳錯誤頁';
            } else {
              lastError = '回應內容過短';
            }
          })
          .catch((e) => {
            activeLabels.delete(strategy.label);
            if (settled) return;
            if (e.name === 'AbortError' && raceCtrl.signal.aborted) return;
            _recordProxyFailure(strategy.idx, Boolean(e.isNetworkOrServer));
            lastError = e.message || '代理請求失敗';
          })
          .finally(() => {
            activeCount--;
            if (settled) return;
            if (nextIdx < strategies.length) {
              // 目前失敗／遭阻擋 → 立刻補位下一個策略，不必等對沖計時器！
              if (activeCount === 0) {
                clearTimeout(staggerTimer);
                launchNext();
              } else {
                updateStatus();
              }
            } else if (activeCount === 0) {
              finish(null);
            }
          });
      }

      if (strategies.length === 0) {
        finish(null);
        return;
      }
      launchNext();
    });
  }

  // ─── Site-Specific High-Precision Content Profiles ─────────────────────────
  const SITE_RULES = [
    // 常見繁中／簡中小說站
    {
      match: /(?:^|\.)(?:novel543\.com|twword\.com|thisiscm\.com)$/i,
      content: ['.chapter-content .content', '.chapter-content', '#chaptercontent'],
      heading: ['.chapter-content > h1', 'h1'],
      remove: ['.foot-nav', '.gadBlock', '.ad', 'script', 'ins'],
    },
    {
      match: /(?:biquge|bqg|xbiquge)/i,
      content: ['#chaptercontent', '#content', '.content'],
      heading: ['.book.read > h1', '.bookname h1', 'h1'],
      remove: ['.read-page', '.bottem1', '.bottem2', '.con_top', 'p.readinline'],
    },
    {
      match: /(?:^|\.)czbooks\.net$/i,
      content: ['.chapter-detail > .content', '.chapter-detail .content'],
      heading: ['.chapter-detail > .name', '.name', 'h1'],
      remove: ['.chapter-nav', '.notice'],
    },
    {
      match: /(?:69shuba|69xinshu|69shu|twkan\.com)/i,
      content: ['#txtcontent0', '.txtnav', '#txtnav'],
      heading: ['h1.hide720', '.txtnav h1', 'h1'],
      remove: ['.txtinfo', '.page1', '.bottom-ad', '.contentadv', '.hide720'],
    },
    {
      match: /(?:piaotia|uukanshu|xbanxia|banxia|sto\.cx|hetushu|ixdzs|wfxs|uuread|ttkan|wa01|shukuge|quanben)/i,
      content: ['#nr1', '#BookText', '#chaptercontent', '#content', '.read-content', '#article', '.content'],
      heading: ['h1', '.title', '#nr_title'],
      remove: ['.page_chapter', '.bottem', '.ad', '.chapter-nav'],
    },
    // 微信公眾號
    {
      match: /(?:^|\.)mp\.weixin\.qq\.com$/i,
      content: ['#js_content'],
      heading: ['#activity-name', 'h1'],
      byline: ['#js_name', '.rich_media_meta_nickname'],
      remove: ['#js_toobar3', '.qr_code_pc', '.reward_area'],
    },
    // PTT 網頁版（特殊處理：整理表頭並將推文收進可展開區塊）
    {
      match: /(?:^|\.)ptt\.cc$/i,
      custom: 'ptt',
    },
    // Wikipedia
    {
      match: /(?:^|\.)wikipedia\.org$/i,
      content: ['#mw-content-text .mw-parser-output', 'body'],
      heading: ['#firstHeading', 'h1'],
      remove: [
        '.mw-editsection', '.navbox', '.vertical-navbox', '.sistersitebox',
        '.noprint', '.mw-jump-link', '.toc', '#toc', '.catlinks', '.printfooter',
        'style', 'link', '.reference', '.mw-ref', 'sup.mw-ref', '.mw-empty-elt',
        '.shortdescription', 'table.ambox', 'table.mbox-small', '.metadata',
      ],
    },
    // 知乎專欄
    {
      match: /(?:^|\.)zhuanlan\.zhihu\.com$/i,
      content: ['.Post-RichTextContainer', '.RichText'],
      heading: ['.Post-Title', 'h1'],
      byline: ['.AuthorInfo-name'],
      remove: ['.ContentItem-actions', '.Post-topicsAndReviewer', '.Recommendations-Main'],
    },
    // 方格子 Vocus
    {
      match: /(?:^|\.)vocus\.cc$/i,
      content: ['article .draft-content', 'article'],
      heading: ['h1'],
      remove: ['[class*="paywall"]', '[class*="related"]', '[class*="recommend"]'],
    },
    // Substack
    {
      match: /(?:^|\.)substack\.com$/i,
      content: ['.body.markup', '.available-content'],
      heading: ['h1.post-title', 'h1'],
      remove: ['.subscription-widget-wrap', '.subscribe-widget', '.captioned-button-wrap'],
    },
    // 痞客邦 Pixnet
    {
      match: /(?:^|\.)pixnet\.net$/i,
      content: ['#article-content-inner', '.article-content-inner'],
      heading: ['.title h2', 'h1'],
      remove: ['.article-footer', '.author-profile', '.pixnet-ad'],
    },
    // 台灣主流新聞與科技媒體
    {
      match: /(?:^|\.)udn\.com$/i,
      content: ['.article-content__editor', 'section.article-content__editor', '#story_body_content'],
      heading: ['h1.article-content__title', 'h1'],
      remove: ['.article-content__ad', '.related-news', '.inline-ad', '.context-box__content'],
    },
    {
      match: /(?:^|\.)ltn\.com\.tw$/i,
      content: ['.text[itemprop="articleBody"]', '.whitecon .text', '.content .text'],
      heading: ['h1'],
      remove: ['.appE1121', '.before_ir', '.after_ir', '.related', '.suggest', '.ph_b', '.author'],
    },
    {
      match: /(?:^|\.)cna\.com\.tw$/i,
      content: ['.paragraph', 'article .paragraph'],
      heading: ['h1'],
      remove: ['.moreArticle', '.Subscription', '.ad'],
    },
    {
      match: /(?:^|\.)ettoday\.net$/i,
      content: ['.story[itemprop="articleBody"]', '.story'],
      heading: ['h1.title', 'h1'],
      remove: ['.ad_in_news', '.part_pictxt_3', '.related-news', '.fb-like'],
    },
    {
      match: /(?:^|\.)sportsv\.net$/i,
      content: ['.article_content', '.article-content', 'article .content', 'article', '.post-content'],
      heading: ['h1.article_title', 'h1.title', 'article h1', 'h1'],
      byline: ['.author_name', '.article_author', '.author'],
      remove: ['.related_articles', '.related-articles', '.share_box', '.social', '.ad', '.ads', '.author_box', '.tag_list', '.comment'],
    },
    {
      match: /(?:^|\.)(?:technews\.tw|ithome\.com\.tw|inside\.com\.tw|bnext\.com\.tw|storm\.mg|twreporter\.org|pansci\.asia)$/i,
      content: [
        '.indent',
        '.field-name-body .field-item',
        '.article_content',
        '.article-body',
        '#CMS_wrapper',
        'article .content',
        'article',
      ],
      heading: ['h1.entry-title', 'h1.page-header', 'h1.post_title', 'h1'],
      remove: ['.related-posts', '.share', '.social', '.ad', '.newsletter', '.author-box'],
    },
  ];

  // ─── Metadata & JSON-LD Harvester ──────────────────────────────────────────
  function _extractJsonLdArticle(doc) {
    const result = { title: '', byline: '', publishedTime: '', body: '', image: '', siteName: '' };
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    const articleTypes = new Set([
      'Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report', 'ScholarlyArticle', 'WebPage', 'Story',
    ]);

    function inspect(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(inspect);
        return;
      }
      if (obj['@graph']) inspect(obj['@graph']);

      const rawType = obj['@type'];
      const types = Array.isArray(rawType) ? rawType : [rawType];
      const isArticle = types.some((t) => articleTypes.has(t));

      if (isArticle || obj.articleBody) {
        if (!result.title && typeof obj.headline === 'string') result.title = obj.headline.trim();
        if (!result.title && typeof obj.name === 'string') result.title = obj.name.trim();
        if (!result.publishedTime && typeof obj.datePublished === 'string') result.publishedTime = obj.datePublished.trim();
        if (!result.byline && obj.author) {
          const authors = Array.isArray(obj.author) ? obj.author : [obj.author];
          const names = authors
            .map((a) => (typeof a === 'string' ? a : a?.name))
            .filter(Boolean);
          if (names.length) result.byline = names.join('、');
        }
        if (!result.siteName && obj.publisher?.name) {
          result.siteName = String(obj.publisher.name).trim();
        }
        if (!result.body && typeof obj.articleBody === 'string' && obj.articleBody.trim().length >= 80) {
          result.body = obj.articleBody.trim();
        }
        if (!result.image && obj.image) {
          const img = Array.isArray(obj.image) ? obj.image[0] : obj.image;
          result.image = typeof img === 'string' ? img : img?.url || '';
        }
      }
    }

    scripts.forEach((s) => {
      try {
        const parsed = JSON.parse(s.textContent || '');
        inspect(parsed);
      } catch {
        // ignore invalid JSON-LD
      }
    });
    return result;
  }

  function _harvestMetadata(doc, url) {
    const getMeta = (sel) => doc.querySelector(sel)?.getAttribute('content')?.trim() || '';
    const jsonLd = _extractJsonLdArticle(doc);

    const siteName =
      jsonLd.siteName ||
      getMeta('meta[property="og:site_name"]') ||
      getMeta('meta[name="application-name"]') ||
      '';

    const title =
      jsonLd.title ||
      getMeta('meta[property="og:title"]') ||
      getMeta('meta[name="twitter:title"]') ||
      doc.querySelector('h1')?.textContent?.trim() ||
      doc.title?.trim() ||
      '';

    const byline =
      jsonLd.byline ||
      getMeta('meta[name="author"]') ||
      getMeta('meta[property="article:author"]') ||
      '';

    const publishedTime =
      jsonLd.publishedTime ||
      getMeta('meta[property="article:published_time"]') ||
      getMeta('meta[name="pubdate"]') ||
      getMeta('meta[name="publishdate"]') ||
      doc.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ||
      '';

    const leadImage = safeResolveUrl(
      jsonLd.image || getMeta('meta[property="og:image"]') || getMeta('meta[name="twitter:image"]'),
      url
    );

    const sourceTag = getMeta('meta[name="pr-source"]');
    const canonical = safeResolveUrl(
      doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || getMeta('meta[property="og:url"]'),
      url
    );

    return {
      title,
      docTitle: doc.title?.trim() || '',
      siteName,
      byline,
      publishedTime,
      leadImage,
      jsonLdBody: jsonLd.body,
      sourceTag,
      canonical,
    };
  }

  function _cleanTitle(rawTitle, siteName) {
    let t = String(rawTitle || '').replace(/\s+/g, ' ').trim();
    if (!t) return '無標題';

    // Remove trailing " - SiteName" / " | SiteName" / " _ SiteName"
    if (siteName && siteName.length >= 2) {
      const escapedSite = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = t.replace(new RegExp(`\\s*[-_|｜—–·•]\\s*${escapedSite}\\s*$`, 'i'), '').trim();
      if (stripped.length >= 4) t = stripped;
    }

    // Also trim generic trailing website suffix if title has "標題 - 網站名"
    const sepMatch = t.match(/^(.{8,}?)\s+(?:\||｜|-|—|–)\s+([^|｜\-—–]{2,24})$/);
    if (sepMatch && !/第\s*[0-9一二三四五六七八九十百千]+\s*[章節回]/.test(sepMatch[2])) {
      t = sepMatch[1].trim();
    }
    return t;
  }

  // ─── DOM Pre-Cleaning & Normalization Helpers ──────────────────────────────
  function _pickBestSrcsetUrl(srcset, baseUrl) {
    if (!srcset) return '';
    const candidates = String(srcset)
      .split(',')
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const u = parts[0];
        const desc = parts[1] || '1x';
        let weight = 1;
        if (desc.endsWith('w')) weight = parseInt(desc, 10) || 1;
        else if (desc.endsWith('x')) weight = (parseFloat(desc) || 1) * 600;
        return { url: u, weight };
      })
      .filter((c) => c.url && !c.url.startsWith('data:'));

    if (candidates.length === 0) return '';
    // Prefer high-res around 800-1600w without pulling huge 4000w originals unnecessarily
    candidates.sort((a, b) => b.weight - a.weight);
    const ideal = candidates.find((c) => c.weight <= 1600 && c.weight >= 600) || candidates[0];
    return safeResolveUrl(ideal.url, baseUrl);
  }

  function _isPlaceholderSrc(src) {
    if (!src) return true;
    const s = src.trim().toLowerCase();
    return (
      (s.startsWith('data:image/svg+xml') && s.length < 400) ||
      (s.startsWith('data:image/gif') && s.length < 250) ||
      /(?:blank|spacer|placeholder|loading|lazy|transparent|grey|gray|pixel|1x1)\.(?:gif|png|jpg|svg|webp)(?:\?|$)/i.test(s)
    );
  }

  function _unwrapNoscriptImages(doc, DOMParserImpl) {
    const noscripts = Array.from(doc.querySelectorAll('noscript'));
    for (const ns of noscripts) {
      const raw = ns.textContent || ns.innerHTML || '';
      if (!/<img\b/i.test(raw)) continue;
      try {
        const frag = new DOMParserImpl().parseFromString(raw, 'text/html');
        const imgs = Array.from(frag.querySelectorAll('img'));
        if (imgs.length === 0) continue;
        // If previous sibling is a placeholder <img>, replace it; otherwise insert before <noscript>
        const prev = ns.previousElementSibling;
        if (prev && prev.tagName === 'IMG' && _isPlaceholderSrc(prev.getAttribute('src'))) {
          const realSrc = imgs[0].getAttribute('src');
          if (realSrc && !_isPlaceholderSrc(realSrc)) {
            prev.setAttribute('src', realSrc);
            continue;
          }
        }
        for (const img of imgs) {
          const imported = doc.importNode(img, true);
          ns.parentNode?.insertBefore(imported, ns);
        }
      } catch {
        // ignore malformed noscript
      }
    }
  }

  function _restoreLazyImages(rootEl, baseUrl) {
    // 1. Handle <picture><source srcset>
    rootEl.querySelectorAll('picture').forEach((pic) => {
      const img = pic.querySelector('img');
      if (!img) return;
      if (!_isPlaceholderSrc(img.getAttribute('src'))) return;
      const source = pic.querySelector('source[srcset], source[data-srcset]');
      if (source) {
        const best = _pickBestSrcsetUrl(source.getAttribute('data-srcset') || source.getAttribute('srcset'), baseUrl);
        if (best) img.setAttribute('src', best);
      }
    });

    // 2. Restore lazy attributes on all <img>
    const LAZY_ATTRS = [
      'data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'data-lazy',
      'data-url', 'data-echo', 'data-hi-res-src', 'data-src-retina', 'original-src',
      'file', 'zoomfile', 'data-ks-lazyload', 'data-img', 'data-image',
    ];
    rootEl.querySelectorAll('img').forEach((img) => {
      const curSrc = img.getAttribute('src') || '';
      let chosen = '';
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v && !_isPlaceholderSrc(v)) {
          chosen = safeResolveUrl(v, baseUrl);
          if (chosen) break;
        }
      }
      if (!chosen) {
        const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
        if (srcset && _isPlaceholderSrc(curSrc)) {
          chosen = _pickBestSrcsetUrl(srcset, baseUrl);
        }
      }
      if (!chosen && curSrc && !_isPlaceholderSrc(curSrc)) {
        chosen = safeResolveUrl(curSrc, baseUrl);
      }

      if (chosen && !_isJunkImageUrl(chosen)) {
        img.setAttribute('src', chosen);
      } else if (_isPlaceholderSrc(curSrc) || _isJunkImageUrl(curSrc)) {
        img.remove();
        return;
      }

      // Remove 1x1 tracking pixels
      const w = parseInt(img.getAttribute('width') || '', 10);
      const h = parseInt(img.getAttribute('height') || '', 10);
      if ((w > 0 && w <= 2) || (h > 0 && h <= 2)) {
        img.remove();
      }
    });
  }

  /**
   * 解除被網站用 visibility:hidden / opacity:0 暫時隱藏的正文容器（如微信 #js_content），
   * 同時刪除短小的隱藏防爬蟲／浮水印蜜罐節點。
   */
  function _cleanHiddenNodes(doc) {
    const styled = Array.from(doc.querySelectorAll('[style], [hidden]'));
    for (const el of styled) {
      if (!el.parentNode) continue;
      const tag = el.tagName;
      if (tag === 'HTML' || tag === 'BODY' || tag === 'HEAD') continue;

      const style = (el.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
      const hasHiddenAttr = el.hasAttribute('hidden');
      const isDisplayNone = style.includes('display:none');
      const isVisHidden = style.includes('visibility:hidden');
      const isOpacityZero = /(?:^|;)opacity:0(?:;|$)/.test(style);
      const isFontZero = /font-size:0(?:px|em|rem|%)?(?:;|$)/.test(style);
      const isOffscreen = /(?:left|text-indent):-\d{4,}px/.test(style);

      if (!hasHiddenAttr && !isDisplayNone && !isVisHidden && !isOpacityZero && !isFontZero && !isOffscreen) {
        continue;
      }

      const idClass = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
      const isKnownContent =
        el.id === 'js_content' ||
        tag === 'ARTICLE' ||
        tag === 'MAIN' ||
        /\b(?:rich_media_content|article-content|post-content|entry-content)\b/i.test(idClass);
      const textLen = (el.textContent || '').trim().length;
      const hasRichChildren = Boolean(el.querySelector('img, p, figure, table, pre'));

      // 微信公眾號 #js_content 或捲動淡入（visibility:hidden / opacity:0）正文容器 → 解除隱藏而非刪除
      if (
        (isVisHidden || isOpacityZero) &&
        !isDisplayNone &&
        !isFontZero &&
        !isOffscreen &&
        !hasHiddenAttr &&
        (isKnownContent || hasRichChildren || textLen >= 60)
      ) {
        if (el.style) {
          el.style.visibility = 'visible';
          el.style.opacity = '1';
        }
        continue;
      }

      // 隱藏浮水印、反爬蟲蜜罐（font-size:0 / display:none / offscreen / 短小隱藏節點）→ 移除
      if (isDisplayNone || isFontZero || isOffscreen || hasHiddenAttr || textLen < 60) {
        el.remove();
      }
    }
  }

  /**
   * 將以 <br> 分段的正文容器轉換為標準 <p> 段落（大幅提升小說站／論壇排版、Readability 與 TTS 效果）
   */
  function _normalizeBrToParagraphs(container, doc) {
    if (!container) return;
    const brs = container.querySelectorAll('br');
    if (brs.length < 2) return;

    // 針對直接包含多個 <br> 且幾乎無 <p> 子元素的容器轉換為 <p>
    const targets = [container, ...Array.from(container.querySelectorAll('div, section'))];
    for (const el of targets) {
      if (!el.isConnected) continue;
      if (el.closest('pre, code, table')) continue;
      const directBrs = Array.from(el.children).filter((c) => c.tagName === 'BR').length;
      const directPs = Array.from(el.children).filter((c) => c.tagName === 'P').length;
      if (directBrs < 2 || directPs >= directBrs) continue;

      // Split childNodes into paragraph groups on <br>
      const groups = [[]];
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 1 && node.tagName === 'BR') {
          if (groups[groups.length - 1].length > 0) {
            groups.push([]);
          }
        } else if (
          node.nodeType === 1 &&
          /^(?:DIV|P|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|FIGURE|HR|DETAILS)$/.test(node.tagName)
        ) {
          if (groups[groups.length - 1].length > 0) groups.push([]);
          groups.push([node]);
          groups.push([]);
        } else {
          groups[groups.length - 1].push(node);
        }
      }

      const frag = doc.createDocumentFragment();
      for (const group of groups) {
        if (group.length === 0) continue;
        if (
          group.length === 1 &&
          group[0].nodeType === 1 &&
          /^(?:DIV|P|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|FIGURE|HR|DETAILS)$/.test(group[0].tagName)
        ) {
          frag.appendChild(group[0]);
          continue;
        }
        const p = doc.createElement('p');
        for (const n of group) p.appendChild(n);
        if (p.textContent.trim() || p.querySelector('img')) {
          frag.appendChild(p);
        }
      }
      el.innerHTML = '';
      el.appendChild(frag);
    }
  }

  function _linkDensity(el) {
    const total = (el.textContent || '').trim().length;
    if (total === 0) return 0;
    let linkLen = 0;
    el.querySelectorAll('a').forEach((a) => {
      linkLen += (a.textContent || '').trim().length;
    });
    return linkLen / total;
  }

  function _preCleanDocument(doc, url, DOMParserImpl) {
    // 0. Inject <base> so Readability resolves relative URLs against the actual article URL
    if (doc.head && url) {
      let base = doc.head.querySelector('base');
      if (!base) {
        base = doc.createElement('base');
        doc.head.insertBefore(base, doc.head.firstChild);
      }
      base.setAttribute('href', url);
    }

    // 1. Unwrap <noscript> images before removing <noscript>
    _unwrapNoscriptImages(doc, DOMParserImpl);

    // 2. Restore lazy-loaded images
    _restoreLazyImages(doc, url);

    // 3. Unhide main content traps & strip hidden honeypot nodes
    _cleanHiddenNodes(doc);

    // 4. Unconditionally remove scripts/styles/embeds
    doc.querySelectorAll('script, noscript, style, template, iframe, object, embed, link[rel="stylesheet"]').forEach((el) =>
      el.remove()
    );

    // 5. Guarded chrome / ad removal (never remove an element containing > 55% of total body text!)
    const totalBodyLen = (doc.body?.textContent || '').trim().length;
    const chromeSelectors = [
      'nav', 'footer', 'aside', '[role="navigation"]', '[role="banner"]', '[role="complementary"]', '[role="contentinfo"]',
      '.ad', '.ads', '.advert', '.advertisement', '.adsbygoogle', '.adBlock', '.clickforceads',
      '.ad-container', '.ad-wrapper', '.ad-banner', '.ad-slot', '[data-ad-zone]', '[data-ad-slot]',
      '[data-google-query-id]', 'ins.adsbygoogle', '[id^="ad-"]', '[class^="ad-"]', '[class*="-ad-"]',
      '.dable-widget', '#dablewidget', '.popin', '.outbrain', '.teads', '.taboola', '.mgid',
      '.share-buttons', '.social-share', '.post-share', '.article-share', '.breadcrumb', '.breadcrumbs',
      '.cookie-banner', '.cookie-notice', '#comments', '.comments', '.comment-list', '#disqus_thread',
      '.newsletter', '.subscribe-box', '.related-posts', '.related-articles', '.recommendations',
      '.ext-reading', '.extend-reading', '[class*="related-article"]', '[class*="related-post"]',
      '[class*="recommend"]', '[class*="bottom-article"]', '.next-article', '.post-navigation',
      '.nav-links', '.pagination', '.author-bio', '[class*="popup"]', '[class*="modal"]',
    ];

    try {
      doc.querySelectorAll(chromeSelectors.join(',')).forEach((el) => {
        if (!el.isConnected || el === doc.body || el === doc.documentElement) return;
        const len = (el.textContent || '').trim().length;
        if (totalBodyLen > 400 && len > totalBodyLen * 0.55) return; // 安全閥：避免誤殺正文容器
        el.remove();
      });
    } catch {
      // ignore selector error
    }

    // 6. Smart multi-<article> pruning (keep highest-scoring top-level <article>, don't blindly keep index 0!)
    const allArticles = Array.from(doc.querySelectorAll('article'));
    const topArticles = allArticles.filter((a) => !a.parentElement?.closest('article'));
    if (topArticles.length > 1) {
      const scored = topArticles
        .map((el) => {
          const textLen = (el.textContent || '').trim().length;
          const ld = _linkDensity(el);
          return { el, textLen, score: textLen * Math.max(0.1, 1 - ld) };
        })
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      const second = scored[1];
      if (best && best.textLen >= 400 && best.score >= (second?.score || 0) * 1.4) {
        for (const item of scored.slice(1)) {
          item.el.remove();
        }
      }
    }
  }

  // ─── Tier 1: Special PTT & Site-Rule Extractor ─────────────────────────────
  function _extractPtt(doc) {
    const main = doc.querySelector('#main-content');
    if (!main) return null;

    const clone = main.cloneNode(true);
    let author = '';
    let title = '';
    let publishedTime = '';

    clone.querySelectorAll('.article-metaline, .article-metaline-right').forEach((line) => {
      const tag = line.querySelector('.article-meta-tag')?.textContent?.trim() || '';
      const val = line.querySelector('.article-meta-value')?.textContent?.trim() || '';
      if (tag === '作者') author = val;
      else if (tag === '標題') title = val;
      else if (tag === '時間') publishedTime = val;
      line.remove();
    });

    // Separate push comments into a neat collapsible section
    const pushes = Array.from(clone.querySelectorAll('.push'));
    const pushHtml = pushes
      .map((p) => {
        const tag = _escapeHtml(p.querySelector('.push-tag')?.textContent?.trim() || '');
        const uid = _escapeHtml(p.querySelector('.push-userid')?.textContent?.trim() || '');
        const content = _escapeHtml((p.querySelector('.push-content')?.textContent || '').replace(/^:\s*/, '').trim());
        const time = _escapeHtml(p.querySelector('.push-ipdatetime')?.textContent?.trim() || '');
        p.remove();
        return `<p><strong>${tag} ${uid}</strong>：${content} <small>${time}</small></p>`;
      })
      .join('');

    // Strip standard PTT signature / origin footer lines
    clone.querySelectorAll('.f2').forEach((el) => {
      if (/※ 發信站|※ 文章網址|※ 編輯/.test(el.textContent || '')) el.remove();
    });

    // Convert plain text line breaks into clean paragraphs
    const rawBodyText = (clone.textContent || '').replace(/\r\n?/g, '\n').trim();
    const paragraphs = rawBodyText
      .split(/\n{2,}/)
      .map((block) =>
        block
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            // Linkify URLs inside PTT plain text
            return _escapeHtml(l).replace(
              /(https?:\/\/[^\s<]+)/g,
              '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
            );
          })
          .join('<br>')
      )
      .filter(Boolean)
      .map((p) => `<p>${p}</p>`)
      .join('\n');

    const detailsBlock =
      pushes.length > 0
        ? `<details><summary>💬 推文留言（共 ${pushes.length} 則）</summary>${pushHtml}</details>`
        : '';

    return {
      title,
      byline: author,
      publishedTime,
      content: `${paragraphs}\n${detailsBlock}`.trim(),
      extractorTier: 'site-rule',
    };
  }

  function _extractBySiteRule(doc, url, mode) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      return null;
    }

    const rule = SITE_RULES.find((r) => r.match.test(hostname));
    if (!rule) return null;

    if (rule.custom === 'ptt') {
      return _extractPtt(doc);
    }

    let contentEl = null;
    for (const sel of rule.content || []) {
      const candidate = doc.querySelector(sel);
      if (!candidate) continue;
      const candLen = (candidate.textContent || '').trim().length;
      const hasImg = Boolean(candidate.querySelector('img'));
      const minRequired = hasImg ? 20 : mode === 'novel' ? 40 : 60;
      if (candLen >= minRequired) {
        contentEl = candidate.cloneNode(true);
        break;
      }
    }
    if (!contentEl) return null;

    if (rule.remove?.length) {
      try {
        contentEl.querySelectorAll(rule.remove.join(',')).forEach((el) => el.remove());
      } catch {
        // ignore
      }
    }

    _normalizeBrToParagraphs(contentEl, doc);

    let title = '';
    for (const sel of rule.heading || []) {
      const h = doc.querySelector(sel);
      if (h?.textContent?.trim()) {
        title = h.textContent.trim();
        break;
      }
    }

    let byline = '';
    for (const sel of rule.byline || []) {
      const b = doc.querySelector(sel);
      if (b?.textContent?.trim()) {
        byline = b.textContent.trim();
        break;
      }
    }

    const textLen = (contentEl.textContent || '').trim().length;
    const hasImgAfter = Boolean(contentEl.querySelector('img'));
    const minFinal = hasImgAfter ? 20 : mode === 'novel' ? 40 : 60;
    if (textLen < minFinal) return null;

    return {
      title,
      byline,
      content: contentEl.innerHTML,
      textLength: textLen,
      extractorTier: 'site-rule',
    };
  }

  // ─── Tier 3: Custom Content-Density Fallback Extractor ─────────────────────
  const POSITIVE_CLASS_RE = /article|content|entry|post|story|chapter|txt|body|main|detail|read|prose|markdown|text/i;
  const NEGATIVE_CLASS_RE = /comment|sidebar|nav|menu|footer|header|related|recommend|widget|ad|promo|share|login|modal|popup|banner|meta|tag/i;

  function _extractByDensity(doc, minChars = 100) {
    if (!doc.body) return null;

    const candidates = Array.from(doc.body.querySelectorAll('article, main, section, div'));
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      const len = text.length;
      if (len < minChars) continue;

      const ld = _linkDensity(el);
      if (ld > 0.55) continue;

      const pCount = el.querySelectorAll('p').length;
      const brCount = el.querySelectorAll('br').length;
      const punctCount = (text.match(/[。，！？；：,.;!?]/g) || []).length;

      let score = len * (1 - ld * 1.1) + pCount * 28 + Math.min(brCount, 80) * 12 + punctCount * 10;

      const hint = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
      if (POSITIVE_CLASS_RE.test(hint)) score *= 1.35;
      if (NEGATIVE_CLASS_RE.test(hint)) score *= 0.45;
      if (el.tagName === 'ARTICLE' || el.tagName === 'MAIN') score *= 1.2;

      // Prefer tighter inner container over giant outer wrappers containing the exact same text
      const childBlocks = Array.from(el.children).filter((c) => /^(?:DIV|SECTION|ARTICLE|MAIN)$/.test(c.tagName));
      const hasTighterChild = childBlocks.some((c) => (c.textContent || '').trim().length >= len * 0.88);
      if (hasTighterChild) score *= 0.72;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (!best) return null;
    const clone = best.cloneNode(true);
    _normalizeBrToParagraphs(clone, doc);
    const cleanLen = (clone.textContent || '').trim().length;
    if (cleanLen < minChars) return null;

    return {
      title: doc.querySelector('h1')?.textContent?.trim() || '',
      byline: '',
      content: clone.innerHTML,
      textLength: cleanLen,
      extractorTier: 'density',
    };
  }

  // ─── Stage 4: Post-Extraction Polishing ────────────────────────────────────
  const BOILERPLATE_LINE_PATTERNS = [
    /^溫馨提示[:：]/,
    /請記住本站域名|一秒記住.*網|天才一秒記住/,
    /手機用戶請瀏覽.*閱讀|更優質的閱讀體驗/,
    /本章未完[，,]?請點擊下一頁|點擊下一頁繼續閱讀/,
    /請收藏本站|加入書籤|投推薦票|章節報錯|點此舉報/,
    /^喜歡《?.*》?請大家收藏/,
    /^(?:上一章|上一頁)\s*(?:[|｜/\s]*目錄[|｜/\s]*)?(?:下一章|下一頁)$/,
    /^(?:延伸閱讀|相關閱讀|相關文章|推薦閱讀|猜你喜歡|更多新聞|分享到|複製連結|立即訂閱|加入會員)[:：]?$/,
    /無彈窗免費閱讀|最新章節全文閱讀|筆趣閣.*最快更新/,
  ];

  function _normalizeCompareText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s\-_|｜—–·•《》「」『』【】()（）:：,，.。!！?？]/g, '');
  }

  function _computeReadingStats(plainText) {
    const clean = String(plainText || '').replace(/\s+/g, ' ').trim();
    const cjkChars = (clean.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const latinWords = (clean.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[a-zA-Z0-9]+/g) || []).length;
    const charCount = cjkChars + latinWords;
    const readingMinutes = Math.max(1, Math.round(cjkChars / 450 + latinWords / 220));
    return { charCount, readingMinutes, textLength: clean.length };
  }

  function _polishContentHtml(rawHtml, { title, baseUrl, DOMParserImpl }) {
    const doc = new DOMParserImpl().parseFromString(`<!DOCTYPE html><body><div id="pr-root">${rawHtml}</div></body>`, 'text/html');
    const rootEl = doc.getElementById('pr-root');
    if (!rootEl) return { html: rawHtml, plainText: '' };

    // 1. Strip zero-width invisible anti-copy characters from text nodes
    const walker = doc.createTreeWalker(rootEl, 4 /* NodeFilter.SHOW_TEXT */);
    let node;
    while ((node = walker.nextNode())) {
      if (/[\u200B-\u200D\uFEFF\u00AD]/.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
      }
    }

    // 2. Convert residual <br> blocks inside content into <p>
    _normalizeBrToParagraphs(rootEl, doc);

    // 3. Remove leading duplicate heading that matches article title
    const normTitle = _normalizeCompareText(title);
    const firstEl = rootEl.firstElementChild;
    if (firstEl && /^H[1-3]$/.test(firstEl.tagName) && normTitle.length >= 4) {
      const normHead = _normalizeCompareText(firstEl.textContent);
      if (normHead && (normHead === normTitle || normTitle.includes(normHead) || normHead.includes(normTitle))) {
        firstEl.remove();
      }
    }

    // 4. Remove residual short boilerplate / watermark / navigation noise paragraphs
    rootEl.querySelectorAll('p, div, span, li').forEach((el) => {
      if (!el.isConnected || el.children.length > 2 || el.querySelector('img, table, pre, code')) return;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 120) return;
      if (BOILERPLATE_LINE_PATTERNS.some((re) => re.test(text))) {
        el.remove();
      }
    });

    // 5. Clean images: absolute URLs, dedupe consecutive identical images, strip trackers/placeholders
    let prevImgSrc = '';
    rootEl.querySelectorAll('img').forEach((img) => {
      const src = safeResolveUrl(img.getAttribute('src'), baseUrl);
      if (!src || _isPlaceholderSrc(src) || _isJunkImageUrl(src)) {
        img.remove();
        return;
      }
      if (src === prevImgSrc) {
        img.remove();
        return;
      }
      prevImgSrc = src;
      img.setAttribute('src', src);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.removeAttribute('srcset');
    });

    // 6. Clean links: resolve relative URLs, strip javascript:, open safely in new tab
    rootEl.querySelectorAll('a').forEach((a) => {
      const rawHref = a.getAttribute('href');
      if (!rawHref) return;
      const resolved = safeResolveUrl(rawHref, baseUrl);
      if (!resolved) {
        a.removeAttribute('href');
      } else {
        a.setAttribute('href', resolved);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });

    // 7. Remove empty wrapper elements (bottom-up)
    Array.from(rootEl.querySelectorAll('p, div, span, section, figure, blockquote'))
      .reverse()
      .forEach((el) => {
        if (!el.isConnected) return;
        if (!el.textContent.trim() && !el.querySelector('img, video, audio, table, pre, hr, iframe')) {
          el.remove();
        }
      });

    const plainText = (rootEl.textContent || '').replace(/\s+/g, ' ').trim();
    return { html: rootEl.innerHTML.trim(), plainText };
  }

  /**
   * 統一四層正文萃取入口（取代 index.html 中多處重複的 Readability 解析程式碼）
   */
  function extractFromHtml(
    html,
    url,
    {
      mode = 'article',
      DOMParserImpl = globalScope.DOMParser,
      ReadabilityImpl = globalScope.Readability,
    } = {}
  ) {
    if (!html || typeof html !== 'string') return null;

    const parser = new DOMParserImpl();
    const doc = parser.parseFromString(html, 'text/html');
    const meta = _harvestMetadata(doc, url);
    const effectiveUrl = url || meta.canonical || '';

    let domain = '';
    try {
      domain = new URL(effectiveUrl).hostname;
    } catch {
      domain = '';
    }

    // Tier 0: Already-extracted clean Markdown HTML (from Jina Reader or GitHub Raw)
    if (meta.sourceTag === 'jina-markdown' || meta.sourceTag === 'raw-markdown') {
      const articleEl = doc.querySelector('article');
      if (articleEl && articleEl.innerHTML.trim()) {
        const title = _cleanTitle(meta.title || meta.docTitle, meta.siteName);
        const polished = _polishContentHtml(articleEl.innerHTML, { title, baseUrl: effectiveUrl, DOMParserImpl });
        if (polished.plainText.length >= 20) {
          const stats = _computeReadingStats(polished.plainText);
          return {
            title,
            byline: meta.byline,
            publishedTime: meta.publishedTime,
            siteName: meta.siteName,
            domain,
            leadImage: meta.leadImage,
            content: polished.html,
            textContent: polished.plainText,
            extractorTier: 'markdown',
            finalUrl: effectiveUrl,
            ...stats,
          };
        }
      }
    }

    // Stage 2: Pre-clean DOM
    _preCleanDocument(doc, effectiveUrl, DOMParserImpl);

    let bestResult = null;

    // Tier 1: High-precision site-specific profile
    const siteResult = _extractBySiteRule(doc, effectiveUrl, mode);
    if (siteResult && siteResult.content) {
      bestResult = siteResult;
    }

    // Tier 2: Mozilla Readability (run on cloned document so Tier 3 still has intact DOM if needed)
    let readabilityResult = null;
    if (!bestResult && ReadabilityImpl) {
      try {
        const docClone = doc.cloneNode(true);
        const parsed = new ReadabilityImpl(docClone, {
          charThreshold: mode === 'novel' ? 80 : 120,
          nbTopCandidates: 5,
        }).parse();
        if (parsed?.content) {
          const cleanLen = (parsed.textContent || '').replace(/\s+/g, ' ').trim().length;
          readabilityResult = {
            title: parsed.title || '',
            byline: parsed.byline || '',
            content: parsed.content,
            textLength: cleanLen,
            extractorTier: 'readability',
          };
        }
      } catch {
        readabilityResult = null;
      }
    }

    // Tier 3: Custom content-density extractor (fallback when Readability fails or truncates badly)
    if (!bestResult) {
      const bodyLen = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim().length;
      const readabilityLooksThin = !readabilityResult || (readabilityResult.textLength < 220 && bodyLen >= 450);

      if (readabilityLooksThin) {
        const densityResult = _extractByDensity(doc, mode === 'novel' ? 40 : 100);
        if (
          densityResult &&
          (!readabilityResult || densityResult.textLength > readabilityResult.textLength * 1.6)
        ) {
          bestResult = densityResult;
        }
      }
      if (!bestResult && readabilityResult) {
        bestResult = readabilityResult;
      }
    }

    // Tier 4: JSON-LD articleBody backup
    if ((!bestResult || (bestResult.textLength || 0) < 120) && meta.jsonLdBody && meta.jsonLdBody.length >= 80) {
      const jsonHtml = meta.jsonLdBody
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${_escapeHtml(p)}</p>`)
        .join('\n');
      bestResult = {
        title: meta.title,
        byline: meta.byline,
        content: jsonHtml,
        textLength: meta.jsonLdBody.length,
        extractorTier: 'json-ld',
      };
    }

    if (!bestResult || !bestResult.content) return null;

    const finalTitle = _cleanTitle(bestResult.title || meta.title || meta.docTitle, meta.siteName);
    const polished = _polishContentHtml(bestResult.content, {
      title: finalTitle,
      baseUrl: effectiveUrl,
      DOMParserImpl,
    });

    const hasPolishedImg = /<img\b/i.test(polished.html);
    const minPolishedLen = hasPolishedImg ? 15 : mode === 'novel' ? 20 : 40;
    if (!polished.html || polished.plainText.length < minPolishedLen) {
      return null;
    }

    const stats = _computeReadingStats(polished.plainText);
    return {
      title: finalTitle,
      byline: bestResult.byline || meta.byline || '',
      publishedTime: bestResult.publishedTime || meta.publishedTime || '',
      siteName: meta.siteName || '',
      domain,
      leadImage: meta.leadImage || '',
      content: polished.html,
      textContent: polished.plainText,
      extractorTier: bestResult.extractorTier,
      finalUrl: effectiveUrl,
      ...stats,
    };
  }

  // ─── MHTML (.mhtml / .mht) Parser (Chrome 離線網頁封存檔) ─────────────────
  function _decodeQuotedPrintableToBytes(str) {
    // 移除軟換行 (=\r\n 或 =\n)
    const unfolded = String(str || '').replace(/=\r?\n/g, '');
    const out = [];
    for (let i = 0; i < unfolded.length; i++) {
      const ch = unfolded[i];
      if (ch === '=' && i + 2 < unfolded.length && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
        out.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        out.push(unfolded.charCodeAt(i) & 0xff);
      }
    }
    return new Uint8Array(out);
  }

  function _decodeRfc2047Word(headerVal) {
    if (!headerVal) return '';
    return String(headerVal).replace(/=\?([^?]+)\?([QBqb])\?([^?]+)\?=/g, (_, charset, enc, payload) => {
      try {
        const cs = normalizeCharsetName(charset) || 'utf-8';
        let bytes;
        if (enc.toUpperCase() === 'B') {
          const bin = atob(payload.replace(/\s+/g, ''));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          bytes = _decodeQuotedPrintableToBytes(payload.replace(/_/g, ' '));
        }
        return new TextDecoder(cs, { fatal: false }).decode(bytes);
      } catch {
        return payload;
      }
    });
  }

  function _parseMimeHeaders(rawBlock) {
    const unfolded = String(rawBlock || '').replace(/\r?\n[ \t]+/g, ' ');
    const headers = {};
    for (const line of unfolded.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (!headers[key]) headers[key] = val;
    }
    return headers;
  }

  function isMhtmlContent(rawText) {
    if (!rawText || typeof rawText !== 'string') return false;
    const head = rawText.slice(0, 2000);
    return /Content-Type:\s*multipart\/related/i.test(head) && /boundary=/i.test(head);
  }

  /**
   * 解析 Chrome / Edge 另存的 .mhtml / .mht 離線網頁，還原 HTML 與內嵌圖片
   */
  function parseMhtml(rawInput) {
    let rawText = '';
    if (typeof rawInput === 'string') {
      rawText = rawInput;
    } else {
      const bytes = rawInput instanceof Uint8Array ? rawInput : new Uint8Array(rawInput || 0);
      // 以 Latin-1 讀出 MIME 結構，避免破壞各區段的原始編碼位元組
      let s = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      rawText = s;
    }

    const headerEndMatch = rawText.match(/\r?\n\r?\n/);
    if (!headerEndMatch || typeof headerEndMatch.index !== 'number') return null;

    const topHeaders = _parseMimeHeaders(rawText.slice(0, headerEndMatch.index));
    const ct = topHeaders['content-type'] || '';
    const boundaryMatch = ct.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
    if (!boundaryMatch?.[1]) return null;

    const boundary = boundaryMatch[1].trim();
    const sourceUrl = topHeaders['snapshot-content-location'] || topHeaders['content-location'] || '';
    const subject = _decodeRfc2047Word(topHeaders['subject'] || '');

    const rawBody = rawText.slice(headerEndMatch.index + headerEndMatch[0].length);
    const parts = rawBody.split(`--${boundary}`);

    let html = '';
    let htmlLocation = sourceUrl;
    const imageMap = new Map(); // location / cid -> data URI

    for (const part of parts) {
      const cleanedPart = part.replace(/^(?:\r?\n)+/, '');
      const trimmed = cleanedPart.trim();
      if (!trimmed || trimmed === '--') continue;
      const sepMatch = cleanedPart.match(/\r?\n\r?\n/);
      if (!sepMatch || typeof sepMatch.index !== 'number') continue;

      const partHeaders = _parseMimeHeaders(cleanedPart.slice(0, sepMatch.index).trim());
      const partBody = cleanedPart.slice(sepMatch.index + sepMatch[0].length);
      const partCt = partHeaders['content-type'] || '';
      const partEnc = (partHeaders['content-transfer-encoding'] || '').toLowerCase();
      const partLoc = (partHeaders['content-location'] || '').trim();
      const partCid = (partHeaders['content-id'] || '').replace(/^<|>$/g, '').trim();

      if (!html && /text\/html/i.test(partCt)) {
        let bytes;
        if (partEnc === 'quoted-printable') {
          bytes = _decodeQuotedPrintableToBytes(partBody);
        } else if (partEnc === 'base64') {
          try {
            const bin = atob(partBody.replace(/\s+/g, ''));
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } catch {
            bytes = new TextEncoder().encode(partBody);
          }
        } else {
          bytes = new Uint8Array(partBody.length);
          for (let i = 0; i < partBody.length; i++) bytes[i] = partBody.charCodeAt(i) & 0xff;
        }
        html = decodeHtmlBytes(bytes, partCt);
        if (partLoc && !htmlLocation) htmlLocation = partLoc;
      } else if (/^image\/(?:jpeg|jpg|png|webp|gif|avif)/i.test(partCt) && partEnc === 'base64' && imageMap.size < 60) {
        const cleanB64 = partBody.replace(/\s+/g, '');
        if (cleanB64.length > 0 && cleanB64.length < 3_000_000) {
          const mime = partCt.split(';')[0].trim().toLowerCase();
          const dataUri = `data:${mime};base64,${cleanB64}`;
          if (partLoc) imageMap.set(partLoc, dataUri);
          if (partCid) imageMap.set(`cid:${partCid}`, dataUri);
        }
      }
    }

    if (!html) return null;

    // 將 HTML 內的 cid: 與離線圖片網址還原為內嵌 data URI（離線也能顯示配圖）
    if (imageMap.size > 0) {
      html = html.replace(/(src|data-src|data-original)\s*=\s*(["'])([^"']+)\2/gi, (full, attr, quote, val) => {
        const decodedVal = val.replace(/&amp;/g, '&');
        let hit = imageMap.get(decodedVal) || imageMap.get(val);
        if (!hit && htmlLocation) {
          const resolved = safeResolveUrl(decodedVal, htmlLocation);
          if (resolved) hit = imageMap.get(resolved);
        }
        return hit ? `${attr}=${quote}${hit}${quote}` : full;
      });
    }

    return {
      html,
      sourceUrl: htmlLocation || sourceUrl,
      title: subject,
    };
  }

  // ─── Pasted / Imported Content Extractor (方案三：剪貼簿富文本／HTML／MHTML／純文字) ─
  function _looksLikeHtmlMarkup(str) {
    if (!str || typeof str !== 'string') return false;
    return /<(?:!doctype\s+html|html|head|body|article|section|main|div|p|h[1-6]|img|figure|blockquote|ul|ol|table)\b[^>]*>/i.test(
      str
    );
  }

  function _looksLikeMarkdown(str) {
    if (!str || typeof str !== 'string') return false;
    let signals = 0;
    if (/^#{1,6}\s+\S/m.test(str)) signals++;
    if (/^```/m.test(str)) signals++;
    if (/!\[[^\]]*\]\(https?:\/\/[^)]+\)/.test(str)) signals++;
    if (/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(str)) signals++;
    if (/^\s*[-*+]\s+\S/m.test(str) && /\n\s*[-*+]\s+\S/m.test(str)) signals++;
    return signals >= 2;
  }

  function _extractFromHtmlFragment(fragmentHtml, baseUrl, customTitle, DOMParserImpl) {
    const wrapped = `<!DOCTYPE html><html><head><meta charset="utf-8"><base href="${_escapeHtml(baseUrl || 'https://local.invalid/')}"></head><body><div id="pr-frag">${fragmentHtml}</div></body></html>`;
    const doc = new DOMParserImpl().parseFromString(wrapped, 'text/html');
    const frag = doc.getElementById('pr-frag');
    if (!frag) return null;

    _unwrapNoscriptImages(doc, DOMParserImpl);
    _restoreLazyImages(frag, baseUrl);
    _cleanHiddenNodes(doc);
    frag.querySelectorAll('script, noscript, style, template, iframe, object, embed, form, button, nav, footer, aside').forEach((el) =>
      el.remove()
    );
    _normalizeBrToParagraphs(frag, doc);

    const inferredHeading = frag.querySelector('h1, h2')?.textContent?.trim() || '';
    const title = (customTitle || '').trim() || _cleanTitle(inferredHeading, '') || '貼上的文章';

    const polished = _polishContentHtml(frag.innerHTML, {
      title,
      baseUrl: baseUrl || '',
      DOMParserImpl,
    });
    if (!polished.html || (polished.plainText.length < 10 && !/<img\b/i.test(polished.html))) return null;

    const stats = _computeReadingStats(polished.plainText);
    let domain = '';
    try {
      domain = baseUrl ? new URL(baseUrl).hostname : '手動匯入';
    } catch {
      domain = '手動匯入';
    }

    return {
      title,
      byline: '',
      publishedTime: '',
      siteName: '',
      domain,
      leadImage: '',
      content: polished.html,
      textContent: polished.plainText,
      extractorTier: 'paste-html',
      finalUrl: baseUrl || '',
      ...stats,
    };
  }

  function _extractFromPlainText(rawText, baseUrl, customTitle) {
    const cleaned = String(rawText || '')
      .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!cleaned) return null;

    const rawBlocks = cleaned
      .split(/\n{2,}/)
      .map((b) =>
        b
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !BOILERPLATE_LINE_PATTERNS.some((re) => re.test(l)))
      )
      .filter((lines) => lines.length > 0);

    // 若整段文字都只用單一換行分隔（常見手機複製結果），改以單行拆段
    const blocks =
      rawBlocks.length === 1 && rawBlocks[0].length >= 3
        ? rawBlocks[0].map((line) => [line])
        : rawBlocks;

    if (blocks.length === 0) return null;

    let title = (customTitle || '').trim();
    if (!title) {
      const firstLine = blocks[0][0] || '';
      const looksLikeHeading =
        blocks.length > 1 &&
        firstLine.length >= 2 &&
        firstLine.length <= 80 &&
        !/^https?:\/\//i.test(firstLine) &&
        !/[。！？.!?]$/.test(firstLine);
      if (looksLikeHeading) {
        title = firstLine;
        if (blocks[0].length === 1) blocks.shift();
        else blocks[0].shift();
      } else {
        title = firstLine.slice(0, 40) + (firstLine.length > 40 ? '…' : '');
      }
    }

    const linkify = (line) =>
      _escapeHtml(line).replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
      );

    const contentHtml = blocks
      .map((lines) => `<p>${lines.map(linkify).join('<br>')}</p>`)
      .join('\n');

    const plainText = blocks.map((lines) => lines.join(' ')).join('\n');
    const stats = _computeReadingStats(plainText);

    let domain = '';
    try {
      domain = baseUrl ? new URL(baseUrl).hostname : '手動貼上';
    } catch {
      domain = '手動貼上';
    }

    return {
      title: title || '貼上的文章',
      byline: '',
      publishedTime: '',
      siteName: '',
      domain,
      leadImage: '',
      content: contentHtml,
      textContent: plainText,
      extractorTier: 'paste-text',
      finalUrl: baseUrl || '',
      ...stats,
    };
  }

  /**
   * 統一處理使用者手動貼上或匯入的內容（支援富文本 HTML 剪貼簿、原始 HTML、Chrome .mhtml、Markdown 與純文字）
   */
  function extractFromPastedContent({
    html = '',
    text = '',
    sourceUrl = '',
    customTitle = '',
    DOMParserImpl = globalScope.DOMParser,
    ReadabilityImpl = globalScope.Readability,
  } = {}) {
    let effectiveUrl = sourceUrl ? normalizeUrl(sourceUrl) : '';
    let effectiveTitle = (customTitle || '').trim();
    let candidateHtml = typeof html === 'string' ? html.trim() : '';
    const candidateText = typeof text === 'string' ? text.trim() : '';

    // 1. MHTML (.mhtml / .mht) 自動拆封
    if (isMhtmlContent(candidateText) || isMhtmlContent(candidateHtml)) {
      const parsedMhtml = parseMhtml(isMhtmlContent(candidateText) ? candidateText : candidateHtml);
      if (parsedMhtml?.html) {
        candidateHtml = parsedMhtml.html;
        if (!effectiveUrl && parsedMhtml.sourceUrl) effectiveUrl = normalizeUrl(parsedMhtml.sourceUrl);
        if (!effectiveTitle && parsedMhtml.title) effectiveTitle = parsedMhtml.title;
      }
    }

    // 若使用者把原始 HTML 貼在文字框內，自動視為 HTML
    if (!candidateHtml && _looksLikeHtmlMarkup(candidateText)) {
      candidateHtml = candidateText;
    }

    // 2. HTML 處理：區分「完整網頁（含側欄／導覽）」與「手動框選的局部富文本片段」
    if (candidateHtml) {
      const isFullPage =
        /<(?:!doctype\s+html|html|head|body)\b/i.test(candidateHtml) ||
        /<(?:nav|header|footer|aside)\b/i.test(candidateHtml) ||
        candidateHtml.length > 20000;

      if (isFullPage) {
        const extracted = extractFromHtml(candidateHtml, effectiveUrl, {
          mode: 'article',
          DOMParserImpl,
          ReadabilityImpl,
        });
        if (extracted?.content) {
          if (effectiveTitle) extracted.title = effectiveTitle;
          if (!extracted.domain) extracted.domain = '匯入網頁';
          return extracted;
        }
      }

      // 局部選取片段或完整頁退回方案：保留使用者選取內容並做乾淨化後處理
      const fragResult = _extractFromHtmlFragment(candidateHtml, effectiveUrl, effectiveTitle, DOMParserImpl);
      if (fragResult) return fragResult;
    }

    // 3. Markdown 內容
    if (candidateText && _looksLikeMarkdown(candidateText)) {
      const mdHtml = markdownToHtml(candidateText, effectiveUrl, { isJina: false });
      const extracted = extractFromHtml(mdHtml, effectiveUrl, {
        mode: 'article',
        DOMParserImpl,
        ReadabilityImpl,
      });
      if (extracted?.content) {
        if (effectiveTitle) extracted.title = effectiveTitle;
        if (!extracted.domain) extracted.domain = '匯入文件';
        return extracted;
      }
    }

    // 4. 純文字
    if (candidateText) {
      return _extractFromPlainText(candidateText, effectiveUrl, effectiveTitle);
    }

    return null;
  }

  // ─── Formatting Helpers ────────────────────────────────────────────────────
  function formatPublishedDate(rawDate) {
    if (!rawDate) return '';
    const d = new Date(rawDate);
    if (Number.isNaN(d.getTime())) return String(rawDate).slice(0, 16);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }

  return {
    CF_PROXY_BASE,
    STRATEGY_LABELS,
    STRATEGY_PREF_TTL_MS,
    normalizeUrl,
    safeResolveUrl,
    normalizeCharsetName,
    decodeHtmlBytes,
    decodeDataUrlIfNeeded,
    isBotChallengePage,
    isSoftErrorPage,
    isPttOver18Page,
    isUsableHtml,
    detectClientRedirect,
    looksLikeEmptySpaShell,
    markdownToHtml,
    tryDirectFastFetch,
    fetchJinaReader,
    fetchViaProxies,
    resetProxyHealth,
    extractFromHtml,
    isMhtmlContent,
    parseMhtml,
    extractFromPastedContent,
    formatPublishedDate,
  };
});
