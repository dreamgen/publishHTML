// 共用畫面工具：元素建立、提示、對話框、QR 產生與掃描
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function toast(msg, kind = '') {
  const box = document.getElementById('toast');
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), 3200);
}

/** 自製確認框，回傳 Promise<boolean> */
export function confirmBox(title, body, okText = '確定', danger = false) {
  return new Promise((resolve) => {
    const close = (v) => { wrap.remove(); resolve(v); };
    const wrap = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-card' },
        h('h2', {}, title),
        body ? h('p', { class: 'muted', style: { whiteSpace: 'pre-line' } }, body) : null,
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => close(false) }, '取消'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => close(true) }, okText))));
    document.body.append(wrap);
    wrap.querySelector('.btn.' + (danger ? 'danger' : 'primary')).focus();
  });
}

/** 產生 QR 圖（img 元素）。依賴 vendor/qrious.min.js */
export function qrImg(text, size = 220, label = 'QR 碼') {
  const q = new window.QRious({ value: text, size: size * 2, level: 'M', padding: 0 });
  return h('img', { src: q.toDataURL(), width: size, height: size, alt: label, class: 'qr' });
}

export const icon = {
  scan: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
  print: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9V3h10v6M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z"/></svg>',
};
export function iconEl(name) { const s = h('span', { class: 'ico', 'aria-hidden': 'true' }); s.innerHTML = icon[name]; return s; }

// ── 掃描器 ───────────────────────────────────────────────────────────────────
/**
 * 開啟相機掃描。onResult(text) 回傳：
 *   true      → 成功並關閉
 *   'keep'    → 成功、繼續掃下一個（連續掃描）
 *   字串      → 顯示錯誤訊息，繼續掃
 * 也可以手動輸入代碼（相機不可用時）。回傳 close 函式。
 */
export function openScanner({ title, hint = '', onResult, onClose }) {
  let stream = null, raf = 0, closed = false, lastText = '', lastAt = 0, detector = null;
  const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'scan-video' });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const msg = h('p', { class: 'scan-msg', 'aria-live': 'polite' }, hint);
  const input = h('input', { type: 'text', inputmode: 'text', placeholder: '手動輸入，例如 Q-4827 或 4827', 'aria-label': '手動輸入代碼', autocomplete: 'off' });
  const close = () => {
    if (closed) return; closed = true;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    wrap.remove();
    onClose && onClose();
  };
  const handle = (text) => {
    const now = Date.now();
    if (text === lastText && now - lastAt < 2500) return;
    lastText = text; lastAt = now;
    let r;
    try { r = onResult(text); } catch (e) { r = e.message; }
    if (r === true) { navigator.vibrate && navigator.vibrate(60); close(); }
    else if (r === 'keep') { navigator.vibrate && navigator.vibrate(60); msg.textContent = hint; msg.className = 'scan-msg ok'; }
    else if (typeof r === 'string') { navigator.vibrate && navigator.vibrate([40, 60, 40]); msg.textContent = r; msg.className = 'scan-msg err'; }
  };
  const wrap = h('div', { class: 'modal scan', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-card scan-card' },
      h('div', { class: 'row between' }, h('h2', {}, title), h('button', { class: 'btn', onclick: close }, '關閉')),
      h('div', { class: 'scan-box' }, video, h('div', { class: 'scan-frame', 'aria-hidden': 'true' })),
      msg,
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) { handle(input.value.trim()); input.value = ''; lastText = ''; } } },
        input, h('button', { class: 'btn', type: 'submit' }, '送出'))));
  document.body.append(wrap);

  const tick = async () => {
    if (closed) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes[0]) handle(codes[0].rawValue);
        } else if (window.jsQR) {
          const w = 480, hgt = Math.round(video.videoHeight * (480 / video.videoWidth));
          canvas.width = w; canvas.height = hgt;
          ctx.drawImage(video, 0, 0, w, hgt);
          const img = ctx.getImageData(0, 0, w, hgt);
          const code = window.jsQR(img.data, w, hgt, { inversionAttempts: 'dontInvert' });
          if (code && code.data) handle(code.data);
        }
      } catch (e) { /* 單張失敗忽略 */ }
    }
    raf = requestAnimationFrame(() => setTimeout(tick, 120));
  };
  (async () => {
    try {
      if ('BarcodeDetector' in window) {
        const fmts = await window.BarcodeDetector.getSupportedFormats();
        if (fmts.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
    } catch (e) { detector = null; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      tick();
    } catch (e) {
      msg.textContent = '無法開啟相機（' + (e.name || e.message) + '），請改用下方手動輸入。';
      msg.className = 'scan-msg err';
    }
  })();
  return close;
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

export async function wakeLock() {
  try { if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen'); } catch (e) { /* 不支援就算了 */ }
  return null;
}
