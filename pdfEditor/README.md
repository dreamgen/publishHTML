# PDF 工坊

一個完全在瀏覽器本機執行的 PWA PDF 編輯器。文件、密碼、OCR 影像與搜尋索引都不會上傳。

## 已實作功能

- 開啟一般與密碼保護 PDF
- 多檔合併、頁面排序、旋轉、刪除、範圍選取與擷取
- 插入空白頁、圖片轉 PDF
- 文字、畫筆、螢光筆、矩形、箭頭、圖片與手寫簽名標註
- PDF 表單填寫與扁平化
- 繁體中文＋英文 OCR，可辨識目前頁、所選頁或全部頁面
- PDF 原生文字與 OCR 結果的統一搜尋、上一筆／下一筆與頁面高亮
- PDF 原生文字與 OCR 文字皆可拖曳或長按選取，並使用頁面上的「複製選取文字」
- IndexedDB 本機草稿、自動還原、Web Share Target 與離線安裝

## OCR 與搜尋

OCR 使用本機封裝的 Tesseract.js、`chi_tra` 與 `eng` 模型。預設會跳過已含可搜尋文字的頁面，以降低處理時間與記憶體使用量。

OCR 結果會保存到本機草稿並加入編輯器搜尋索引，也可以在 OCR 視窗中複製。目前匯出 PDF 不會額外寫入隱藏 OCR 文字層；匯出內容仍以原 PDF 與視覺標註為主。

搜尋快捷鍵為 `Ctrl/⌘ + F`。搜尋會忽略大小寫與空白差異，適合跨 PDF 文字片段或逐字 OCR 結果查找中文詞句。

在 Android 上會使用相容性對話框開啟插入頁面、簽名、表單與 OCR 功能，並以 Pointer Events 處理畫筆、螢光筆、矩形與箭頭。PWA 核心檔案採網路優先更新，版本更新完成後會自動重新載入，避免 HTML 與 JavaScript 快取版本不一致。

## 本機啟動

請透過 HTTP 伺服器開啟，Service Worker 與 Web Worker 不支援直接使用 `file://`：

```bash
python3 -m http.server 8765
```

接著開啟 `http://localhost:8765/publishHTML/pdfEditor/`，或直接在本目錄啟動伺服器後開啟 `http://localhost:8765/`。

首次安裝離線版本時會快取 PDF.js、字型、OCR 核心與繁中／英文模型。
