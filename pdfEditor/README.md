# PDF 工坊

一個完全在瀏覽器本機執行的 PWA PDF 編輯器。文件、密碼、OCR 影像與搜尋索引都不會上傳。

## 已實作功能

- 開啟一般與密碼保護 PDF
- 多檔合併、頁面排序、旋轉、刪除、範圍選取與擷取
- 插入空白頁、圖片轉 PDF
- Excel `.xlsx` 轉 PDF，可選擇要轉換的 Sheet，並開啟為新文件或插入目前頁面後
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

## Android 接收 PDF 分享

PDF 工坊必須由 Android Chrome 完整安裝成 PWA，作業系統才會將它註冊到 PDF 分享清單。一般的瀏覽器書籤或舊版「加入主畫面」捷徑不具備這項能力。

未安裝的 Android 裝置第一次開啟時，會自動顯示一次安裝說明。頁面最上方工具列也會保留「安裝 APP」按鈕，直到安裝完成；點選後可重新查看安裝方式。

如果分享清單沒有顯示 PDF 工坊：

1. 從 Android 主畫面或「設定 → 應用程式」移除舊的 PDF 工坊。
2. 使用 Chrome 開啟 PDF 工坊網址。
3. 點選頁首的「安裝 APP」，或 Chrome 選單中的「安裝應用程式」。
4. 等待安裝完成後重新開啟 PDF 工坊。
5. 從檔案管理器或其他 APP 分享 PDF，即可選擇 PDF 工坊。

Manifest 同時接受標準 PDF MIME、常見舊式 PDF MIME、`.pdf` 副檔名與 Android 有時使用的 `application/octet-stream`，並可接收一次分享的多個 PDF。

## 本機啟動

請透過 HTTP 伺服器開啟，Service Worker 與 Web Worker 不支援直接使用 `file://`：

```bash
python3 -m http.server 8765
```

接著開啟 `http://localhost:8765/publishHTML/pdfEditor/`，或直接在本目錄啟動伺服器後開啟 `http://localhost:8765/`。

首次安裝離線版本時會快取 PDF.js、字型與 PDF 編輯核心；OCR 核心與繁中／英文模型（約 15MB）改為背景與首次使用時快取，讓安裝更快、更不易失敗。

## Excel 轉 PDF

可從首頁的「開啟」、拖放區或「插入 → Excel 轉 PDF」選擇 `.xlsx`。活頁簿只在本機 Worker 中解析，使用者可勾選要轉換的 Sheet，並指定紙張、方向、縮放、列印範圍及插入位置。

目前會轉換儲存格內容、已儲存的公式結果、合併儲存格、欄寬列高、基本字型樣式、填色、框線與對齊。圖表、SmartArt、巨集、密碼保護 Excel 與部分條件格式不在支援範圍；原始 Excel 不會保存到草稿，只有產生的 PDF 會進入既有草稿與匯出流程。
