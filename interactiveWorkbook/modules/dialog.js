// ──────────────────────────────────────────────────────────────────────────────
// 自製提示窗：取代瀏覽器原生的 confirm() / prompt() / alert()
// ──────────────────────────────────────────────────────────────────────────────
/**
 * 為什麼不用原生 confirm/prompt/alert：
 * - 它們是同步阻塞的。部分瀏覽器（LINE、FB 等 App 內建瀏覽器、某些行動版 Safari／Chrome 情境）
 *   會直接吞掉、或讓頁面卡在一個看不到的對話框上，學員與講師只會覺得「按了沒反應」。
 * - 文字無法排版：一長串說明擠成一團，連 **粗體** 都會原樣顯示成星號。
 *
 * 這裡的每個函式都回傳 Promise，呼叫端一律 `await`：
 *   if (!(await askConfirm('確定刪除？', { danger: true }))) return;
 *
 * 實作採用 <dialog>.showModal()，與 ui.js 的浮動視窗同一套：top layer 依開啟順序疊放，
 * 所以在題目編輯器、合併視窗這類已經是 modal 的視窗上再開提示，也會正確蓋在最上面。
 * 極舊的 App 內建瀏覽器若不支援 showModal()，退回用一層固定定位的遮罩自己畫。
 *
 * 訊息格式：純文字，換行照原樣顯示；`**文字**` 會變成粗體（先跳脫 HTML，再轉粗體，不會有注入問題）。
 */
import { E } from './util.js';

const supportsModal = typeof HTMLDialogElement === 'function'
  && typeof HTMLDialogElement.prototype.showModal === 'function';

let seq = 0;

function richText(message) {
  return E(message).replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * 共用核心。回傳 Promise<{ ok: boolean, value: string }>。
 * options:
 *   title, message, okLabel, cancelLabel, danger,
 *   input: false | { value, placeholder, maxLength, label },
 *   expect: 需要逐字輸入才能按確定的文字（例如課程名稱）,
 *   hideCancel: 只有一顆「知道了」按鈕的告知視窗
 */
function openAsk(options) {
  const {
    title = '請確認',
    message = '',
    okLabel = '確定',
    cancelLabel = '取消',
    danger = false,
    input = false,
    expect = null,
    hideCancel = false,
  } = options;

  seq += 1;
  const id = `ask-${seq}`;
  const wantsInput = !!input || expect != null;
  const inputCfg = input || {};
  const returnFocus = document.activeElement;

  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'float-window ask-window';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-msg`);
    dialog.innerHTML = `
      <div class="float-top"><strong id="${id}-title">${E(title)}</strong></div>
      <div class="float-body ask-body">
        <div class="ask-message" id="${id}-msg">${richText(message)}</div>
        ${wantsInput ? `<label class="ask-label" for="${id}-input">${E(
    expect != null ? `請輸入「${expect}」以確認` : (inputCfg.label || '請輸入'),
  )}</label>
        <input id="${id}-input" class="ask-input" data-ask-input type="text" autocomplete="off"
          ${expect != null ? `data-expect="${E(expect)}"` : ''}
          ${inputCfg.maxLength ? `maxlength="${Number(inputCfg.maxLength)}"` : ''}
          placeholder="${E(inputCfg.placeholder || '')}" value="${E(inputCfg.value ?? '')}">` : ''}
      </div>
      <div class="float-actions ask-actions">
        ${hideCancel ? '' : `<button type="button" data-ask-cancel>${E(cancelLabel)}</button>`}
        <button type="button" data-ask-ok class="${danger ? 'danger-solid' : 'primary'}">${E(okLabel)}</button>
      </div>`;

    let overlay = null;
    if (supportsModal) {
      document.body.appendChild(dialog);
      dialog.showModal();
    } else {
      overlay = document.createElement('div');
      overlay.className = 'ask-overlay';
      dialog.setAttribute('open', '');
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
    }

    const okBtn = dialog.querySelector('[data-ask-ok]');
    const cancelBtn = dialog.querySelector('[data-ask-cancel]');
    const field = dialog.querySelector('[data-ask-input]');

    const valid = () => (expect == null ? true : (field ? field.value.trim() === String(expect).trim() : false));
    const sync = () => { okBtn.disabled = !valid(); };

    let done = false;
    const finish = (ok) => {
      if (done) return;
      if (ok && !valid()) return;
      done = true;
      const value = field ? field.value : '';
      try { if (supportsModal && dialog.open) dialog.close(); } catch { /* 已關閉 */ }
      (overlay || dialog).remove();
      if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
        try { returnFocus.focus({ preventScroll: true }); } catch { /* 忽略 */ }
      }
      resolve({ ok: !!ok, value });
    };

    okBtn.onclick = () => finish(true);
    if (cancelBtn) cancelBtn.onclick = () => finish(false);
    // Esc：等同取消（只有「知道了」一顆按鈕時等同確定）。不點遮罩關閉——太容易誤觸。
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(hideCancel); });
    dialog.addEventListener('keydown', (e) => {
      if (!supportsModal && e.key === 'Escape') { e.preventDefault(); finish(hideCancel); }
      if (e.key === 'Enter' && field && e.target === field && !e.isComposing) {
        e.preventDefault(); // 中文輸入法選字時的 Enter 不算送出
        finish(true);
      }
    });

    if (field) {
      field.addEventListener('input', sync);
      sync();
      setTimeout(() => { field.focus(); field.select(); }, 0);
    } else {
      // 破壞性動作預設停在「取消」，避免手滑一按 Enter 就刪掉；一般確認停在「確定」，與原生 confirm 一致。
      setTimeout(() => { ((danger && cancelBtn) ? cancelBtn : okBtn).focus(); }, 0);
    }
  });
}

/** 取代 confirm()。回傳 Promise<boolean>。 */
export async function askConfirm(message, options = {}) {
  const r = await openAsk({ ...options, message });
  return r.ok;
}

/** 取代 prompt()。按取消回傳 null，否則回傳輸入的文字（未 trim，交給呼叫端決定）。 */
export async function askText(message, options = {}) {
  const r = await openAsk({
    title: '請輸入',
    ...options,
    message,
    input: {
      value: options.defaultValue ?? '',
      placeholder: options.placeholder,
      maxLength: options.maxLength,
      label: options.label,
    },
  });
  return r.ok ? r.value : null;
}

/** 需要逐字輸入指定文字才能執行的破壞性動作（刪除課程、重置課程）。回傳 Promise<boolean>。 */
export async function askTyped(message, expect, options = {}) {
  const r = await openAsk({ danger: true, ...options, message, expect: String(expect) });
  return r.ok;
}

/** 取代 alert()：只有一顆「知道了」。 */
export async function showNotice(message, options = {}) {
  await openAsk({ title: '提示', okLabel: '知道了', ...options, message, hideCancel: true });
}
