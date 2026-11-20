/**
 * 隨身閱讀 PocketReader — 語音朗讀引擎 (Web Speech API)
 * 採短句切分 + runId 防競態設計，支援語速調整、單段/全章/A-B 循環
 */

import { parseChapterBlocks, segmentSentences } from './textEngine.js';

function stripMarkdownForSpeech(text) {
  return String(text || '')
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

export class TtsController {
  constructor({ onStateChange, onQueueItemStart, onError } = {}) {
    this.onStateChange = onStateChange;
    this.onQueueItemStart = onQueueItemStart;
    this.onError = onError;

    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.synth = this.supported ? window.speechSynthesis : null;

    this.queue = [];
    this.cursor = 0;
    this.playing = false;
    this.paused = false;
    this.rate = 1.0;
    this.voiceURI = '';
    this.loopMode = 'off'; // 'off' | 'para' | 'chapter' | 'ab'
    this.abRange = { startPara: null, endPara: null };
    this.runId = 0;
    this.voices = [];

    if (this.supported) {
      this._refreshVoices({ emit: false });
      this.synth.addEventListener?.('voiceschanged', () => this._refreshVoices({ emit: true }));
    }
  }

  _refreshVoices({ emit = true } = {}) {
    if (!this.synth) return [];
    const raw = this.synth.getVoices() || [];
    this.voices = raw.sort((a, b) => {
      const aZh = /^zh[-_]TW/i.test(a.lang) ? 0 : /^zh/i.test(a.lang) ? 1 : 2;
      const bZh = /^zh[-_]TW/i.test(b.lang) ? 0 : /^zh/i.test(b.lang) ? 1 : 2;
      if (aZh !== bZh) return aZh - bZh;
      return a.name.localeCompare(b.name);
    });
    if (!this.voiceURI && this.voices.length) {
      const tw = this.voices.find((v) => /^zh[-_]TW/i.test(v.lang)) || this.voices.find((v) => /^zh/i.test(v.lang));
      if (tw) this.voiceURI = tw.voiceURI;
    }
    if (emit) this._emitState();
    return this.voices;
  }

  getVoices() {
    if (!this.voices.length && this.supported) this._refreshVoices({ emit: false });
    return this.voices;
  }

  buildQueueFromChapter(chapterContent) {
    const blocks = parseChapterBlocks(chapterContent || '');
    const items = [];
    for (let pIdx = 0; pIdx < blocks.length; pIdx++) {
      const blk = blocks[pIdx];
      if (blk.type === 'hr' || blk.type === 'code') continue;
      const clean = stripMarkdownForSpeech(blk.text || '');
      if (!clean) continue;

      const sentences = segmentSentences(clean, 'sentence');
      for (const s of sentences) {
        const trimmed = s.trim();
        if (!trimmed) continue;
        // Split very long sentences into <= 110 char chunks for Chrome SpeechSynthesis stability
        if (trimmed.length <= 110) {
          items.push({ paraIdx: pIdx, text: trimmed });
        } else {
          const clauses = segmentSentences(trimmed, 'clause');
          let buf = '';
          for (const c of clauses) {
            if ((buf + c).length > 110 && buf) {
              items.push({ paraIdx: pIdx, text: buf.trim() });
              buf = c;
            } else {
              buf += c;
            }
          }
          if (buf.trim()) items.push({ paraIdx: pIdx, text: buf.trim() });
        }
      }
    }
    this.queue = items;
    return items;
  }

  startChapter(chapterContent, startParaIdx = 0) {
    if (!this.supported) {
      this.onError?.('此裝置瀏覽器不支援語音朗讀功能');
      return;
    }
    this.buildQueueFromChapter(chapterContent);
    if (!this.queue.length) {
      this.onError?.('本章節沒有可朗讀的文字');
      return;
    }
    const idx = Math.max(
      0,
      this.queue.findIndex((it) => it.paraIdx >= startParaIdx)
    );
    this.cursor = idx === -1 ? 0 : idx;
    this.playing = true;
    this.paused = false;
    this._speakCurrent();
  }

  togglePlayPause(chapterContent, fallbackPara = 0) {
    if (!this.supported) {
      this.onError?.('此裝置瀏覽器不支援語音朗讀功能');
      return;
    }
    if (!this.playing) {
      this.startChapter(chapterContent, fallbackPara);
      return;
    }
    if (this.paused) {
      this.paused = false;
      this.synth.resume();
      this._emitState();
    } else {
      this.paused = true;
      this.synth.pause();
      this._emitState();
    }
  }

  stop() {
    this.runId++;
    this.playing = false;
    this.paused = false;
    if (this.synth) {
      try {
        this.synth.cancel();
      } catch {
        // ignore
      }
    }
    this.onQueueItemStart?.(null);
    this._emitState();
  }

  prev() {
    if (!this.queue.length) return;
    this.cursor = Math.max(0, this.cursor - 1);
    if (this.playing) {
      this.paused = false;
      this._speakCurrent();
    } else {
      this._emitState();
    }
  }

  next() {
    if (!this.queue.length) return;
    this.cursor = Math.min(this.queue.length - 1, this.cursor + 1);
    if (this.playing) {
      this.paused = false;
      this._speakCurrent();
    } else {
      this._emitState();
    }
  }

  setRate(rate) {
    this.rate = Math.min(2.0, Math.max(0.5, Number(rate) || 1.0));
    if (this.playing && !this.paused) {
      this._speakCurrent();
    } else {
      this._emitState();
    }
  }

  setVoice(voiceURI) {
    this.voiceURI = voiceURI || '';
    if (this.playing && !this.paused) {
      this._speakCurrent();
    } else {
      this._emitState();
    }
  }

  setLoopMode(mode) {
    this.loopMode = mode;
    this._emitState();
  }

  setAbPoint(pointType, paraIdx) {
    if (pointType === 'A') {
      this.abRange.startPara = paraIdx;
      if (this.abRange.endPara !== null && this.abRange.endPara < paraIdx) {
        this.abRange.endPara = paraIdx;
      }
    } else {
      this.abRange.endPara = paraIdx;
      if (this.abRange.startPara !== null && this.abRange.startPara > paraIdx) {
        this.abRange.startPara = paraIdx;
      }
    }
    this._emitState();
  }

  _findNextCursor(currIdx) {
    const curr = this.queue[currIdx];
    if (!curr) return -1;

    if (this.loopMode === 'para') {
      const nextSamePara = currIdx + 1 < this.queue.length && this.queue[currIdx + 1].paraIdx === curr.paraIdx;
      if (nextSamePara) return currIdx + 1;
      const firstOfPara = this.queue.findIndex((it) => it.paraIdx === curr.paraIdx);
      return firstOfPara >= 0 ? firstOfPara : 0;
    }

    if (this.loopMode === 'ab' && this.abRange.startPara !== null && this.abRange.endPara !== null) {
      const next = currIdx + 1;
      if (next < this.queue.length && this.queue[next].paraIdx <= this.abRange.endPara) {
        return next;
      }
      const startIdx = this.queue.findIndex((it) => it.paraIdx >= this.abRange.startPara);
      return startIdx >= 0 ? startIdx : 0;
    }

    if (currIdx + 1 < this.queue.length) {
      return currIdx + 1;
    }

    if (this.loopMode === 'chapter') {
      return 0;
    }

    return -1;
  }

  _speakCurrent() {
    if (!this.synth || !this.queue.length) return;
    const myRunId = ++this.runId;
    try {
      this.synth.cancel();
    } catch {
      // ignore
    }

    const item = this.queue[this.cursor];
    if (!item) {
      this.stop();
      return;
    }

    const utter = new SpeechSynthesisUtterance(item.text);
    utter.rate = this.rate;
    const voice = this.voices.find((v) => v.voiceURI === this.voiceURI);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    } else {
      utter.lang = 'zh-TW';
    }

    this.onQueueItemStart?.(item);
    this._emitState();

    utter.onend = () => {
      if (this.runId !== myRunId || !this.playing) return;
      const nextIdx = this._findNextCursor(this.cursor);
      if (nextIdx === -1) {
        this.stop();
      } else {
        this.cursor = nextIdx;
        this._speakCurrent();
      }
    };

    utter.onerror = (evt) => {
      if (this.runId !== myRunId) return;
      if (evt?.error === 'interrupted' || evt?.error === 'canceled') return;
      this.stop();
      this.onError?.(`語音朗讀失敗：${evt?.error || '未知錯誤'}`);
    };

    this.synth.speak(utter);
  }

  _emitState() {
    this.onStateChange?.({
      supported: this.supported,
      playing: this.playing,
      paused: this.paused,
      rate: this.rate,
      voiceURI: this.voiceURI,
      voices: this.voices,
      loopMode: this.loopMode,
      abRange: { ...this.abRange },
      cursor: this.cursor,
      total: this.queue.length,
      currentParaIdx: this.queue[this.cursor]?.paraIdx ?? null,
    });
  }
}
