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

const VIDEO_EXT_MIME = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', '3gp': 'video/3gpp' };
const VIDEO_ALLOWED = new Set(Object.values(VIDEO_EXT_MIME));

export const isVideoMime = (mime) => VIDEO_ALLOWED.has(String(mime || '').toLowerCase());

// 部分瀏覽器對 HEIC 給空的 type，依副檔名補上；回傳 '' 表示不是支援的格式
export function guessMime(file) {
  const t = (file.type || '').toLowerCase();
  if (ALLOWED.has(t)) return t;
  if (t && t !== 'application/octet-stream') return '';
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return EXT_MIME[ext] || '';
}

export function guessVideoMime(file) {
  const t = String(file?.type || '').split(';')[0].trim().toLowerCase();
  if (t === 'video/x-m4v') return 'video/mp4';
  if (VIDEO_ALLOWED.has(t)) return t;
  const ext = (file?.name || '').split('.').pop().toLowerCase();
  return VIDEO_EXT_MIME[ext] || '';
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

// 擷取影片封面縮圖、寬高與秒數（解碼失敗或逾時 8 秒則降級回傳無縮圖，不影響上傳）
export function processVideo(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      try { v.load(); } catch (_) { /* 忽略 */ }
      URL.revokeObjectURL(url);
      resolve(res);
    };
    const timer = setTimeout(() => {
      finish({ thumb: null, w: v.videoWidth || 0, h: v.videoHeight || 0, duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0 });
    }, 8000);
    const snap = () => {
      const w = v.videoWidth || 0;
      const h = v.videoHeight || 0;
      const duration = Number.isFinite(v.duration) ? Math.round(v.duration) : 0;
      if (!w || !h) { finish({ thumb: null, w: 0, h: 0, duration }); return; }
      try {
        const long = Math.max(w, h);
        const k = long > THUMB_EDGE ? THUMB_EDGE / long : 1;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((blob) => {
          c.width = c.height = 0;
          finish({ thumb: blob || null, w, h, duration });
        }, 'image/jpeg', 0.8);
      } catch (_) {
        finish({ thumb: null, w, h, duration });
      }
    };
    v.addEventListener('error', () => finish({ thumb: null, w: 0, h: 0, duration: 0 }), { once: true });
    v.addEventListener('loadedmetadata', () => {
      const target = Number.isFinite(v.duration) && v.duration > 0.2 ? Math.min(1, v.duration * 0.1) : 0;
      if (target > 0) {
        v.addEventListener('seeked', snap, { once: true });
        try { v.currentTime = target; } catch (_) { v.addEventListener('loadeddata', snap, { once: true }); }
      } else {
        v.addEventListener('loadeddata', snap, { once: true });
      }
    }, { once: true });
    v.src = url;
  });
}
