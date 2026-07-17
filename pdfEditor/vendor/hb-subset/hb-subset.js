/*!
 * hb-subset.js — HarfBuzz WASM 字型子集化的極簡包裝器。
 * 使用 harfbuzzjs 1.4.0 的 harfbuzz-subset.wasm（MIT，見 HARFBUZZJS-LICENSE.txt）。
 * 於主執行緒（window）與 Web Worker（importScripts）皆可載入，掛在 HBSubset 全域。
 */
(function (root) {
  "use strict";

  const HB_MEMORY_MODE_WRITABLE = 2;
  let exportsPromise = null;

  async function loadWasmExports(options) {
    if (!exportsPromise) {
      exportsPromise = (async () => {
        let binary = options?.wasmBinary || null;
        if (!binary) {
          if (!options?.wasmUrl) throw new Error("缺少 hb-subset.wasm 位置。");
          const response = await fetch(options.wasmUrl);
          if (!response.ok) throw new Error("hb-subset.wasm 載入失敗。");
          binary = await response.arrayBuffer();
        }
        const result = await WebAssembly.instantiate(binary, {});
        return result.instance ? result.instance.exports : result.exports;
      })().catch((error) => {
        // 載入失敗不要快取 rejected promise，讓下一次呼叫可以重試。
        exportsPromise = null;
        throw error;
      });
    }
    return exportsPromise;
  }

  function subsetWithExports(hb, fontBytes, codePoints) {
    const heap = () => new Uint8Array(hb.memory.buffer);
    const fontPtr = hb.malloc(fontBytes.length);
    heap().set(fontBytes, fontPtr);
    const blob = hb.hb_blob_create(
      fontPtr,
      fontBytes.length,
      HB_MEMORY_MODE_WRITABLE,
      0,
      0
    );
    const face = hb.hb_face_create(blob, 0);
    hb.hb_blob_destroy(blob);
    let input = 0;
    let subsetFace = 0;
    let resultBlob = 0;
    try {
      input = hb.hb_subset_input_create_or_fail();
      if (!input) throw new Error("hb_subset_input 建立失敗。");
      const unicodeSet = hb.hb_subset_input_unicode_set(input);
      for (const codePoint of codePoints) hb.hb_set_add(unicodeSet, codePoint);
      subsetFace = hb.hb_subset_or_fail(face, input);
      if (!subsetFace) throw new Error("字型子集化失敗。");
      resultBlob = hb.hb_face_reference_blob(subsetFace);
      const length = hb.hb_blob_get_length(resultBlob);
      if (!length) throw new Error("字型子集化結果為空。");
      const dataPtr = hb.hb_blob_get_data(resultBlob, 0);
      // heap() 需重新取得：wasm 記憶體可能已成長並汰換原本的 ArrayBuffer。
      return heap().slice(dataPtr, dataPtr + length);
    } finally {
      if (resultBlob) hb.hb_blob_destroy(resultBlob);
      if (subsetFace) hb.hb_face_destroy(subsetFace);
      if (input) hb.hb_subset_input_destroy(input);
      hb.hb_face_destroy(face);
      hb.free(fontPtr);
    }
  }

  /**
   * 依 text 中實際出現的字元裁切字型子集。
   * @param {ArrayBuffer|Uint8Array} fontBytes 原始字型（TTF/OTF）
   * @param {string|Iterable<number>} text 要保留的文字（或 code point 陣列）
   * @param {{ wasmUrl?: string, wasmBinary?: ArrayBuffer }} options
   * @returns {Promise<Uint8Array>} 子集化後的字型位元組
   */
  async function subsetFont(fontBytes, text, options) {
    const hb = await loadWasmExports(options || {});
    const codePoints = new Set();
    if (typeof text === "string") {
      for (const character of text) codePoints.add(character.codePointAt(0));
    } else {
      for (const codePoint of text || []) codePoints.add(Number(codePoint));
    }
    codePoints.add(0x20); // 空白必留
    const bytes =
      fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes);
    return subsetWithExports(hb, bytes, codePoints);
  }

  root.HBSubset = { subsetFont };
})(typeof self !== "undefined" ? self : globalThis);
