# 講師愿力表系統 (`lecturerVow/`)

> 兼顧法會紙電雙軌立愿、1～12 月多元進度回報、五星評比激勵與各單位分權總覽的 Zero-build PWA。

## 核心功能
- **📱 講師手機端 (PWA)**：支援「標準字體 / 長輩大字版」、1～12 月膠囊切換、5 種關鍵成果衡量型態（百分比進度、累積次數、週期達成、階段里程碑、心得自評）、修辦心得（支援瀏覽器語音輸入）與離線快取。
- **📝 法會紙本代登**：總管理員與單位負責人可協助 50% 年長紙本組快速建檔，並產生專屬認領綁定碼（`VOW-XXXX`）。
- **🖨️ 母堂呈表 A4 列印**：一鍵切換「目前講師資料版」與「空白手寫紙本模板」，透過 `@media print` 輸出 A4 橫式呈表。
- **📊 管理端與各單位分權總覽**：依單位、立愿方式（電子 / 紙本）、星級區間篩選，支援單人 Push 提醒與一鍵匯出 CSV（Excel 相容）。

## 計算規則
- **單項達成率上限**：所有關鍵成果單項達成率最高鎖定為 `100%`。
- **週期達成型 (`PERIODIC`)**：分母由講師自行設定完成期限（`3 ～ 12` 個月）。
- **五星評比**：依目標旗下所有關鍵成果平均達成率自動換算 `0.0 ～ 5.0` 顆星（支援半星）。

## 環境設定（啟用全新 Firebase 專案與 LINE 整合）

1. **建立全新 Firebase 專案**：
   - 於 Firebase Console 建立新專案並啟用 **Realtime Database** 與 **Authentication**。
   - 將 `database.rules.json` 部署至 Realtime Database 規則。
   - 複製 Web SDK 設定物件填入 `config.js` 的 `VOW_CONFIG.firebase`（未填時預設為本機 `localStorage` 試用模式）。
2. **部署 Cloudflare Worker（LINE Login + Messaging API 單人 Push）**：
   - 進入 `worker/` 目錄，設定 secrets：
     - `LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`（LINE Login）
     - `LINE_MESSAGING_TOKEN`（LINE Official Account Messaging API，用於單人 Push 與 Webhook 回覆，不做群發推播）
     - `FIREBASE_CLIENT_EMAIL`、`FIREBASE_PRIVATE_KEY`（新 Firebase 專案服務帳戶）
     - `ALLOWED_ORIGIN`（例如 `https://<username>.github.io`）
   - 部署後將 Worker URL 與 Channel ID（及選填 `liffId`）填入 `config.js`。
