/**
 * MP3 編碼 Worker（lamejs 1.2.1，LGPL）
 * 輸入：{ left, right: Float32Array, sampleRate, kbps, title }
 * 輸出：{ type: 'progress', pct } / { type: 'done', blob } / { type: 'error', message }
 */
importScripts('./vendor/lame.min.js');

function toInt16(src, dst, offset, len) {
  for (let j = 0; j < len; j++) {
    let s = src[offset + j];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    dst[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
}

// ID3v2.3 標籤（TIT2 標題、TSSE 編碼器），UTF-16 文字
function id3Tag(title) {
  const frames = [];
  const textFrame = (id, text) => {
    if (!text) return;
    const body = new Uint8Array(3 + text.length * 2);
    body[0] = 0x01; body[1] = 0xff; body[2] = 0xfe; // UTF-16 + BOM (LE)
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      body[3 + i * 2] = c & 0xff;
      body[4 + i * 2] = c >> 8;
    }
    const f = new Uint8Array(10 + body.length);
    for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
    const n = body.length;
    f[4] = (n >>> 24) & 0xff; f[5] = (n >>> 16) & 0xff; f[6] = (n >>> 8) & 0xff; f[7] = n & 0xff;
    f.set(body, 10);
    frames.push(f);
  };
  textFrame('TIT2', title);
  textFrame('TSSE', 'sunoRecorder (lamejs)');
  const size = frames.reduce((s, f) => s + f.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0);
  tag[6] = (size >> 21) & 0x7f; tag[7] = (size >> 14) & 0x7f; tag[8] = (size >> 7) & 0x7f; tag[9] = size & 0x7f;
  let o = 10;
  for (const f of frames) { tag.set(f, o); o += f.length; }
  return tag;
}

self.onmessage = (e) => {
  try {
    const { left, right, sampleRate, kbps, title } = e.data;
    const stereo = !!right;
    const enc = new lamejs.Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);
    const BLOCK = 1152 * 32;
    const total = left.length;
    const l16 = new Int16Array(BLOCK);
    const r16 = new Int16Array(BLOCK);
    const out = [id3Tag(title || '')];
    let lastPct = -1;
    for (let i = 0; i < total; i += BLOCK) {
      const len = Math.min(BLOCK, total - i);
      toInt16(left, l16, i, len);
      let buf;
      if (stereo) {
        toInt16(right, r16, i, len);
        buf = enc.encodeBuffer(l16.subarray(0, len), r16.subarray(0, len));
      } else {
        buf = enc.encodeBuffer(l16.subarray(0, len));
      }
      if (buf.length) out.push(new Uint8Array(buf));
      const pct = Math.floor(((i + len) / total) * 100);
      if (pct !== lastPct) { lastPct = pct; self.postMessage({ type: 'progress', pct }); }
    }
    const tail = enc.flush();
    if (tail.length) out.push(new Uint8Array(tail));
    self.postMessage({ type: 'done', blob: new Blob(out, { type: 'audio/mpeg' }) });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
