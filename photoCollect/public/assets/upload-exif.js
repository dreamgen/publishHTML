// 自寫的 JPEG EXIF 時間解析器（處理大小端）。只讀 APP1/TIFF，不解析 HEIC。
// 回傳 "YYYY-MM-DDTHH:MM:SS"（活動當地時間，不帶時區），讀不到回 null。

const TIME_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

function toIso(s) {
  const m = TIME_RE.exec(s || '');
  if (!m || m[1] === '0000' || m[2] === '00' || m[3] === '00') return null;
  const [, y, mo, d, h, mi, se] = m;
  if (+mo > 12 || +d > 31 || +h > 23 || +mi > 59 || +se > 60) return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}

// 讀一個 IFD：回傳 {ascii:{tag:字串}, long:{tag:數值}}
function readIfd(v, base, offset, le, end) {
  const out = { ascii: {}, long: {} };
  if (offset < 8 || base + offset + 2 > end) return out;
  const n = v.getUint16(base + offset, le);
  for (let i = 0; i < n && i < 256; i++) {
    const e = base + offset + 2 + i * 12;
    if (e + 12 > end) break;
    const tag = v.getUint16(e, le);
    const type = v.getUint16(e + 2, le);
    const count = v.getUint32(e + 4, le);
    if (type === 2 && count > 0 && count < 64) {
      // ASCII：長度 > 4 時，值在 TIFF 起點 + 偏移
      const pos = count > 4 ? base + v.getUint32(e + 8, le) : e + 8;
      if (pos + count > end) continue;
      let s = '';
      for (let k = 0; k < count; k++) {
        const c = v.getUint8(pos + k);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      out.ascii[tag] = s;
    } else if (type === 4 && count === 1) {
      out.long[tag] = v.getUint32(e + 8, le);
    }
  }
  return out;
}

function parseTiff(v, base, end) {
  const order = v.getUint16(base);
  let le;
  if (order === 0x4949) le = true; // "II" 小端
  else if (order === 0x4D4D) le = false; // "MM" 大端
  else return null;
  if (v.getUint16(base + 2, le) !== 42) return null;
  const ifd0 = readIfd(v, base, v.getUint32(base + 4, le), le, end);
  let t = null;
  const exifPtr = ifd0.long[0x8769];
  if (exifPtr) {
    const ex = readIfd(v, base, exifPtr, le, end);
    t = toIso(ex.ascii[0x9003]) || toIso(ex.ascii[0x9004]); // DateTimeOriginal → DateTimeDigitized
  }
  return t || toIso(ifd0.ascii[0x0132]); // 最後退到 IFD0 的 DateTime
}

export function readExifTime(buf) {
  try {
    const v = new DataView(buf);
    const len = v.byteLength;
    if (len < 12 || v.getUint16(0) !== 0xFFD8) return null; // 不是 JPEG（例如 HEIC）
    let off = 2;
    while (off + 4 <= len) {
      if (v.getUint8(off) !== 0xFF) return null;
      const marker = v.getUint8(off + 1);
      if (marker === 0xFF) { off += 1; continue; } // 填充位元組
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) return null; // 影像資料開始，不會再有 EXIF
      const segLen = v.getUint16(off + 2);
      if (segLen < 2) return null;
      if (marker === 0xE1 && segLen >= 14 && v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) {
        // "Exif\0\0" 之後是 TIFF
        const end = Math.min(len, off + 2 + segLen);
        const r = parseTiff(v, off + 10, end);
        if (r) return r;
      }
      off += 2 + segLen;
    }
  } catch (_) { /* 資料毀損：視為沒有 EXIF */ }
  return null;
}

// 以 File.lastModified 轉成本地時間字串（EXIF 讀不到時的備援）
export function mtimeToLocalIso(ms) {
  if (!ms || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
