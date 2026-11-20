# 隨身閱讀 PocketReader (`pocketReader/`)

> 將常用書籍、PDF、EPUB、Word、網頁文章與背誦筆記集中儲存在手機離線使用，主打**純文字重排與雙指縮放文字**、**背誦遮罩／首字提示／自訂挖空／語音朗讀／經典直書**，以及隨時隨地可雙向更新同步的 **Cloudflare Worker + R2** 雲端書庫。

## 核心功能

- **純文字重排與無段縮放**：
  - 閱讀介面支援頂部 `A−` / `A+`、外觀面板滑桿（14–44 px）、鍵盤 `+`/`-`/`0`，以及手機**雙指捏合／張開直接縮放文字字級**（不觸發整頁亂跑，縮放前後自動錨定可視段落）。
  - 支援黑體 / 明體 / 楷體 / 等寬字體、行距、欄寬與 5 種紙感／夜間／OLED／高對比主題。
- **多格式匯入與本機離線 OCR**：
  - **PDF**：自動依座標智慧重組橫排／直排段落（合併軟換行），保留目錄章節；可選擇同時留存原版 PDF，閱讀時一鍵切換 `[純文字 | 原版 PDF]`。若偵測為掃描圖片 PDF，可立即使用本機離線 **Tesseract OCR**（支援繁中橫排與繁中直排）轉成可放大縮小的純文字。
  - **EPUB / Word (.docx) / TXT / Markdown (.md) / 網頁網址**：完整解析章節與表格並存入 IndexedDB 離線保存；另支援 PWA **Share Target** 與作業系統開啟關聯。
- **背誦輔助與語音朗讀**：
  - 三種背誦模式：**逐句遮罩**（可選按句或按短語切分）、**首字提示**（保留每句前 1–2 字）、**自訂挖空**（支援 `{{文字}}` / `==重點==` 標記與全書關鍵詞彙）。
  - 內建 **經典直書（`vertical-rl`）** 與橫書一鍵切換。
  - **語音朗讀 (TTS)**：分段短句朗讀，支援語速調整、單段循環、全章循環與 A-B 區段循環。
- **臨時查閱秒找**：
  - 首頁跨全書庫即時全文檢索，點選結果直接跳轉至該書該章節該段落並高亮關鍵字；支援分類管理與置頂常用資料。
- **跨裝置雲端同步、分享與備份**：
  - 使用自訂「同步碼＋同步密碼」（PBKDF2 衍生金鑰）雙向同步文字書庫、書籤、閱讀進度與原版 PDF，並提供配對 QR Code。
  - 支援將單本書或整個分類產生 **8 碼分享碼／訂閱連結** 與 QR Code；發布者修改更新後可推送新版，訂閱者一鍵拉取更新且保留個人書籤與進度。
  - 隨時可匯出／匯入本機 JSON 備份（可選純文字或含原檔 PDF）。

## 首次部署雲端同步後端（Cloudflare Worker + R2）

若只在本機手機離線使用、貼文字與匯入 PDF，**完全不需要部署後端**即可直接安裝使用。  
如需啟用跨裝置同步與分享訂閱功能：

1. 先於 Cloudflare Dashboard 啟用一次 **R2**（免費額度即足夠個人使用）。
2. 進入 `pocketReader/worker/` 執行部署腳本：
   ```bash
   cd publishHTML/pocketReader/worker
   npm install
   bash scripts/deploy.sh
   ```
3. 部署成功後會取得 `https://pocket-reader-sync.<你的子網域>.workers.dev` 網址：
   - 可直接在 App「設定 → 跨裝置同步」貼上並測試連線，或寫進 `pocketReader/config.js` 的 `workerUrl` 一勞永逸。

## 本機測試

```bash
# 執行純文字引擎與 Worker 單元測試
node --test publishHTML/pocketReader/tests/textEngine.test.mjs publishHTML/pocketReader/tests/worker.test.mjs

# 啟動本機模擬後端（預設 port 8799）
cd publishHTML/pocketReader/worker && npx wrangler dev --local --port 8799
```
