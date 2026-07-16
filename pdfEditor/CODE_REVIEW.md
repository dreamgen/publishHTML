# PdfEditor PWA Code Review（2026-07-17）

> **2026-07-17 更新**：項目 1（response.ok）、2（count clamp）、3（縮圖快取＋增量更新）、4（Autosave 拆 store，DB v2）、5（undo 圖片引用化）、6（source GC）、7（OCR idle terminate）、8（SW lazy cache OCR 模型，SW v15）、9（dialog 擋快捷鍵）均已實作。未實作：CSP（項目 10）、模組拆分與測試（低優先）。

範圍：`app.js`（4,340 行）、`sw.js`、`index.html`、`manifest.webmanifest`、`styles.css`。整體品質良好：render token 取消機制、密碼流程、OCR 座標旋轉轉換、Android dialog fallback、a11y（aria-live、aria-label）與 localStorage try/catch 都處理得很細緻。以下依優先級列出問題與建議。

---

## 🔴 高優先（建議儘快修）

### 1. SW navigate 快取未檢查 `response.ok`
`sw.js` L144-154：導覽請求成功就把回應覆寫進 `./index.html` 快取，**404/500 錯誤頁也會被寫入**，之後離線 fallback 會拿到壞掉的 index.html，PWA 離線直接開不起來。

```js
// 修正：只快取正常回應
fetch(request).then((response) => {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
  }
  return response;
})
```

### 2. `consumeSharedFile` 的 `count` 參數無上限
`app.js` L3948：`?shared=1&count=99999999` 會造成上億次 `cache.match` 迴圈，惡意連結可讓頁面卡死（DoS）。

```js
const requestedCount = Math.min(20, Math.max(1, Number(...) || 1));
```

### 3. 側欄縮圖全量重繪（大文件效能瓶頸）
`renderSidebar()` 在每次 `selectPage`、`mutate`、搜尋跳頁時 `replaceChildren()` 重建所有卡片並重新 render 全部縮圖 canvas。100+ 頁文件每點一頁就重跑一次全部 PDF render。建議：

- 縮圖快取：以 `pageId + rotation` 為 key 快取 ImageBitmap/dataURL，rotation 不變就直接貼回。
- `selectPage` 只切換 active class 與 checkbox 狀態（增量更新），不重建 DOM。

### 4. 自動儲存每次重寫全部來源 bytes
`saveAutosave()` 每次（debounce 900ms）都把**所有** `source.bytes.slice()` 整包寫入 IndexedDB。開 50MB PDF 後每拖一個標註就重寫 50MB+，影響效能與 flash 壽命，也是「裝置空間不足」toast 的主因。建議拆兩個 object store：

- `sources`：bytes 只在來源新增/被表單替換時寫一次。
- `state`：pages/annotations/textIndex/activePageId，輕量、可高頻寫。

---

## 🟡 中優先

### 5. Undo 堆疊記憶體膨脹
`pushHistory()` 保留 40 份 `clonePages()`，annotations 內含簽名/圖片的 base64 `dataUrl`。幾張圖片標註後，undo 堆疊可能複製數十 MB。建議 dataUrl 改存引用（`imageId` → 獨立 Map/Blob store），pages 快照只存 id。

### 6. 孤兒 source 不會回收
合併檔案後 undo，或刪除某來源的全部頁面後，`this.sources` 仍保留該來源的 bytes + pdfjsDoc + pdfLibDoc（三份記憶體）。建議在 `normalizeState()` 加 source GC：無任何 page 引用時 `loadingTask.destroy()` 並自 Map 移除（需注意 undo/redo 堆疊仍可能引用，可改為 redo/undo 清空時回收）。

### 7. OCR worker 常駐
辨識完成後 worker 不終止，Tesseract WASM + 雙語模型常駐約百 MB 記憶體。建議 idle（如 3 分鐘）後自動 `terminate()`，下次使用再重建。

### 8. SW install 一次性快取 39MB，脆弱且慢
`vendor/` 共約 39MB（tesseract 15M、pdf-lib 17M、pdfjs 7M），`cache.addAll` 是原子操作，任一檔失敗整個 install 失敗、重來。建議：

- OCR 模型與 core（~15MB）改 lazy：首次執行 OCR 時才 `cache.put`，SW install 只快取 app shell + pdfjs + pdf-lib。
- `AUXILIARY_MANIFESTS` 被 fetch 兩次（`addAll` 已抓過一次），可先 `cache.match` 再 parse。

### 9. Dialog 開啟時單鍵快捷仍生效
`handleKeyboard` 只擋 input/textarea。confirm dialog 開啟時按 `r`/`Delete` 仍會旋轉/觸發刪除流程。建議開頭加：

```js
if (document.querySelector("dialog[open]")) return;
```

### 10. 缺少 CSP
純本機處理的工具值得加一層防護，尤其有 share-target 與外部檔案輸入：

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; object-src 'none'">
```
（需驗證 pdf.js/tesseract worker 與 data: 圖片標註相容性。）

---

## 🟢 低優先／程式風格

- **`document` 遮蔽**：`insertBlankPage`、`convertImagesToPdf`、`applyFormValues`、`exportPages` 內 `const document = await PDFDocument.create()` 遮蔽全域 `document`，日後在該 scope 誤用 DOM API 會炸。建議改名 `pdfDoc`。
- **SW 版本錯配風險**：`app.js` 走 network-first、`pdf.mjs` 走 cache-first，vendor 升級若忘了 bump `SW_VERSION` 會 HTML/vendor 版本不一致。建議在 sw.js 頂部註解強調，或改用 asset revision hash。
- **SW 更新 reload**：`skipWaiting + clients.claim + controllerchange → location.reload()`，使用者編輯到一半會被 reload（dirty 時有 beforeunload 確認，可接受）。更平滑的做法：dirty 時延後 reload，改顯示「有新版本」toast。
- **`saveSignature`** 逐像素掃描 O(w×h)：可接受，但可只掃 alpha channel（步進 4）已是現狀，無需改；若簽名板放大再考慮。
- **單檔 4,340 行**：`PdfWorkshop` 一個 class 包辦全部。建議按職責拆 ES modules：`viewer.js`、`annotations.js`、`ocr.js`、`search.js`、`persistence.js`、`install.js`，並考慮 JSDoc + `tsc --checkJs` 補型別檢查。
- **無自動化測試**：`parsePageRange`、`normalizeSearchText`、`transformOcrBox`、`hexToRgb` 等純函式很適合先補單元測試。

---

## ✅ 值得保留的優點

- render token / RenderingCancelledException 處理避免競態，thumbnail 用 generation + `requestIdleCallback` 排程。
- 使用者輸入一律 `textContent`，`innerHTML` 僅用於靜態 SVG，無 XSS 面。
- 密碼 PDF 流程（onPassword + pdf-lib fallback 判斷 encrypted）完整。
- OCR bbox 正規化 + 旋轉轉換（`transformOcrBox`）設計乾淨。
- a11y：toast/busy/OCR 進度皆有 `aria-live`，按鈕都有 aria-label。
- localStorage/clipboard 皆有 fallback 與 try/catch。

## 建議修復順序

1. sw.js `response.ok` 檢查（一行，風險最高）
2. `count` clamp（一行）
3. Dialog open 時擋快捷鍵（一行）
4. 縮圖快取 + selectPage 增量更新
5. Autosave 拆 store
6. Source GC / OCR worker idle terminate / undo dataUrl 引用化
7. SW lazy cache OCR 模型、CSP、模組拆分
