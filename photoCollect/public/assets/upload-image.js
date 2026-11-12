// 圖片處理：SHA-256、壓縮、縮圖
export const MAX_EDGE = 2560; // 壓縮後長邊
export const THUMB_EDGE = 320;

export async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (let i = 0; i < d.length; i++) s += d[i].toString(16).padStart(2, '0');
  return s;
}

const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', gif: 'image/gif' };
const ALLOWED = new Set(Object.values(EXT_MIME));

// 部分瀏覽器對 HEIC 給空的 type，依副檔名補上；回傳 '' 表示不是支援的格式
export function guessMime(file) {
  const t = (file.type || '').toLowerCase();
  if (ALLOWED.has(t)) return t;
  if (t && t !== 'application/octet-stream') return '';
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return EXT_MIME[ext] || '';
}

function canvasToJpeg(bmp, w, h, quality) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // 透明 PNG 轉 JPEG 時墊白底
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob((b) => { c.width = c.height = 0; resolve(b); }, 'image/jpeg', quality));
}

async function resizeJpeg(bmp, edge, quality) {
  const long = Math.max(bmp.width, bmp.height);
  const k = long > edge ? edge / long : 1; // 小於就不放大
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const blob = await canvasToJpeg(bmp, w, h, quality);
  return blob ? { blob, w, h } : null;
}

// 回傳 {blob, thumb, w, h, mime}
//  - 未勾原圖：長邊縮到 2560、JPEG 0.85；壓縮後反而更大且原檔是 JPEG 就傳原檔
//  - 勾原圖：傳原檔，仍嘗試縮圖
//  - 解碼失敗（多半是非 Safari 的 HEIC）：傳原檔、無縮圖
export async function processImage(file, mime, original) {
  const orig = file.type === mime ? file : new Blob([file], { type: mime });
  let bmp = null;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) { bmp = null; }
  if (!bmp) return { blob: orig, thumb: null, w: 0, h: 0, mime };
  try {
    let thumb = null;
    try { thumb = (await resizeJpeg(bmp, THUMB_EDGE, 0.8))?.blob || null; } catch (_) { thumb = null; }
    if (original) return { blob: orig, thumb, w: bmp.width, h: bmp.height, mime };
    let r = null;
    try { r = await resizeJpeg(bmp, MAX_EDGE, 0.85); } catch (_) { r = null; }
    if (!r || (mime === 'image/jpeg' && r.blob.size >= file.size)) {
      return { blob: orig, thumb, w: bmp.width, h: bmp.height, mime };
    }
    return { blob: r.blob, thumb, w: r.w, h: r.h, mime: 'image/jpeg' };
  } finally {
    if (bmp.close) bmp.close();
  }
}
