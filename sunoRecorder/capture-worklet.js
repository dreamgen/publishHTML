/**
 * AudioWorklet：擷取分頁音訊的原始 PCM（Float32，雙聲道）
 * - 每累積 8192 frames 傳一包 PCM 給主執行緒（transfer，不複製）
 * - 每 2048 frames 回報一次峰值，用於音量表與「播完自動停止」
 * 直接擷取 PCM 而不是用 MediaRecorder（Opus），可避免「Opus → MP3」兩次有損壓縮。
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 8192;
    this._alloc();
    this.levelFrames = 0;
    this.levelPeak = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this._post();
        this.running = false;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  _alloc() {
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.n = 0;
  }

  _post() {
    if (!this.n) return;
    const l = this.n === this.size ? this.l : this.l.slice(0, this.n);
    const r = this.n === this.size ? this.r : this.r.slice(0, this.n);
    this.port.postMessage({ type: 'pcm', l, r }, [l.buffer, r.buffer]);
    this._alloc();
  }

  process(inputs) {
    if (!this.running) return false;
    const inp = inputs[0];
    if (inp && inp.length) {
      const a = inp[0];
      const b = inp[1] || inp[0];
      for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        this.l[this.n] = x;
        this.r[this.n] = y;
        const p = Math.max(x < 0 ? -x : x, y < 0 ? -y : y);
        if (p > this.levelPeak) this.levelPeak = p;
        if (++this.n === this.size) this._post();
      }
      this.levelFrames += a.length;
      if (this.levelFrames >= 2048) {
        this.port.postMessage({ type: 'level', peak: this.levelPeak, frames: this.levelFrames });
        this.levelFrames = 0;
        this.levelPeak = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
