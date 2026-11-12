// 分享預覽圖：在瀏覽器用 canvas 合成 1200×630 的卡片（LINE、FB 貼連結時顯示的那張圖）
// LINE 常把預覽圖從中央裁成正方形小縮圖，所以所有關鍵內容都放在「中央安全區」630×630（x=285–915）並置中：
// 沒有照片：全版深青綠，相機線條圖示（約 72px 高）在文字上方中央
// 有照片：照片 cover 填滿全版＋黑色 45% 遮罩，中央放圓角深青綠半透明面板（600×500）裝文字

export const CARD_W = 1200;
export const CARD_H = 630;
const TEAL = '#0E6F6A';
const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei","Noto Sans CJK TC","Noto Sans CJK JP",sans-serif';
const MAX_PNG = 1000 * 1024; // PNG 超過這個大小就改存 JPEG（照片背景的 PNG 可能很大；伺服器上限 1.5MB）

const font = (w, px) => `${w} ${px}px ${FONT}`;

// 圓角矩形路徑（不用 ctx.roundRect，舊版瀏覽器也能跑）
function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** 把文字切成斷行單位：英數字詞保持完整，中文逐字、空白獨立 */
function tokens(text) {
  return text.match(/[A-Za-z0-9'’._\-]+|\s+|[\s\S]/gu) || [];
}

/** 依寬度自動換行；單一字詞超過寬度時逐字拆開 */
function wrap(g, text, maxW) {
  const lines = [];
  let cur = '';
  for (const t of tokens(text)) {
    if (/^\s+$/.test(t)) { if (cur) cur += ' '; continue; }
    if (g.measureText(cur + t).width <= maxW) { cur += t; continue; }
    if (cur) { lines.push(cur.trimEnd()); cur = ''; }
    if (g.measureText(t).width <= maxW) { cur = t; continue; }
    for (const ch of t) { // 超長英數字詞
      if (g.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ''; }
      cur += ch;
    }
  }
  if (cur) lines.push(cur.trimEnd());
  return lines;
}

/** 太寬就截斷並加「…」 */
function ellipsize(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && g.measureText(chars.join('') + '…').width > maxW) chars.pop();
  return chars.join('') + '…';
}

/** 兩行時把斷行位置調均衡（避免第二行只剩一個字）：找出仍是兩行的最小寬度 */
function balance(g, name, maxW, lines) {
  let best = lines;
  for (let w = maxW - 20; w >= maxW * 0.5; w -= 20) {
    const t = wrap(g, name, w);
    if (t.length !== 2) break;
    best = t;
  }
  return best;
}

/** 活動名稱：字級 72→40px。優先單行（字級 ≥ 56），否則兩行並均衡斷行；兩行仍放不下最小字級才截斷加「…」 */
function fitName(g, name, maxW) {
  let twoLine = null;
  for (let px = 72; px >= 40; px -= 4) {
    g.font = font(700, px);
    const lines = wrap(g, name, maxW);
    if (lines.length === 1 && px >= 56) return { px, lines };
    if (lines.length <= 2 && !twoLine) twoLine = { px, lines };
  }
  if (twoLine) {
    g.font = font(700, twoLine.px);
    if (twoLine.lines.length === 2) twoLine.lines = balance(g, name, maxW, twoLine.lines);
    return twoLine;
  }
  g.font = font(700, 40);
  const lines = wrap(g, name, maxW).slice(0, 2);
  lines[1] = ellipsize(g, lines[1] + '…', maxW);
  return { px: 40, lines };
}

function drawCamera(g, cx, cy, s) {
  g.save();
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.lineWidth = Math.max(4, 12 * s);
  const bw = 330 * s, bh = 236 * s;
  const x0 = cx - bw / 2, y0 = cy - bh / 2 + 14 * s;
  rr(g, x0, y0, bw, bh, 36 * s); g.stroke();
  g.beginPath();
  g.moveTo(cx - 76 * s, y0); g.lineTo(cx - 52 * s, y0 - 40 * s);
  g.lineTo(cx + 52 * s, y0 - 40 * s); g.lineTo(cx + 76 * s, y0);
  g.stroke();
  g.beginPath(); g.arc(cx, cy + 14 * s, 70 * s, 0, Math.PI * 2); g.stroke();
  g.lineWidth = Math.max(3, 7 * s);
  g.beginPath(); g.arc(cx, cy + 14 * s, 26 * s, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(x0 + bw - 60 * s, y0 + 40 * s, 10 * s, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** 讀取照片（依 EXIF 方向轉正）；無法解碼（例如 HEIC）時丟出友善訊息 */
async function loadPhoto(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try { return await createImageBitmap(file); } catch {
      throw new Error('這張照片無法讀取，請改用 JPG 或 PNG。');
    }
  }
}

function canvasBlob(cv, type, q) {
  return new Promise((res) => cv.toBlob(res, type, q));
}

/**
 * 產生預覽圖
 * @param {{name:string, date?:string|null, location?:string, photo?:File|null}} o
 * @returns {Promise<{blob:Blob, type:string}>} 預設 PNG；太大時改 JPEG
 */
export async function generateCard({ name, date, location, photo }) {
  // 字型：先等 Noto Sans TC 載入；失敗（離線、被擋）就用系統字型
  try {
    await document.fonts.load('700 64px "Noto Sans TC"');
    await document.fonts.load('500 30px "Noto Sans TC"');
  } catch { /* 用備援字型 */ }

  const img = photo ? await loadPhoto(photo) : null;
  const cv = document.createElement('canvas');
  cv.width = CARD_W; cv.height = CARD_H;
  const g = cv.getContext('2d');
  const CX = CARD_W / 2;
  const textW = 560; // 文字最大寬度，置中後落在 x=320–880，在安全區內
  g.fillStyle = TEAL;
  g.fillRect(0, 0, CARD_W, CARD_H);

  let yLabel, yName, yPill;
  if (img) {
    // 照片 cover 填滿全版，蓋 45% 黑色遮罩，中央放半透明深青綠面板
    const sc = Math.max(CARD_W / img.width, CARD_H / img.height);
    const sw = CARD_W / sc, sh = CARD_H / sc;
    g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, CARD_W, CARD_H);
    if (img.close) img.close();
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, 0, CARD_W, CARD_H);
    rr(g, CX - 300, 65, 600, 500, 36);
    g.fillStyle = 'rgba(14,111,106,0.88)';
    g.fill();
    yLabel = 104; yName = 150; yPill = 469;
  } else {
    drawCamera(g, CX, 88, 0.26); // 約 72px 高
    yLabel = 150; yName = 192; yPill = 522;
  }

  g.textBaseline = 'top';
  g.textAlign = 'center';

  // 小字：活動照片募集
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.font = font(500, 26);
  g.fillText('活動照片募集', CX, yLabel);

  // 大字：活動名稱（最多 2 行）
  const { px, lines } = fitName(g, String(name || '').trim() || '活動照片', textW);
  g.fillStyle = '#fff';
  g.font = font(700, px);
  const lh = Math.round(px * 1.25);
  let y = yName;
  for (const ln of lines) { g.fillText(ln, CX, y); y += lh; }

  // 日期・地點
  const sub = [date ? String(date).replace(/-/g, '/') : '', location ? String(location).trim() : ''].filter(Boolean).join('・');
  if (sub) {
    g.fillStyle = 'rgba(255,255,255,0.94)';
    g.font = font(400, 28);
    g.fillText(ellipsize(g, sub, textW), CX, y + 14);
  }

  // 邀請短句（白底圓角標籤）
  g.font = font(700, 30);
  const label = '請上傳你拍到的照片';
  const lw = Math.min(textW, Math.ceil(g.measureText(label).width) + 56);
  rr(g, CX - lw / 2, yPill, lw, 60, 30);
  g.fillStyle = '#fff';
  g.fill();
  g.fillStyle = TEAL;
  g.fillText(ellipsize(g, label, lw - 56), CX, yPill + 14);

  let blob = await canvasBlob(cv, 'image/png');
  if (!blob) throw new Error('瀏覽器無法產生圖片。');
  if (blob.size > MAX_PNG) {
    for (const q of [0.9, 0.8, 0.7]) {
      const j = await canvasBlob(cv, 'image/jpeg', q);
      if (j) { blob = j; if (j.size <= MAX_PNG) break; }
    }
  }
  return { blob, type: blob.type };
}
