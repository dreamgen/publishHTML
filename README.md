# publishHTML — PWA 工具集

一組可安裝的 Progressive Web App（PWA）小工具，適合在手機或平板上**獨立安裝**使用。

---

## 工具列表

### 🎲 骰子搖搖 (`playDices/`)

> 使用物理引擎模擬的 3D 骰子，支援搖動裝置投擲骰子

**功能：**
- 3D 物理骰子模擬（Three.js + Cannon.js）
- 搖動手機自動擲骰（需授權動作感測器）
- 可調整骰子數量（1–20 顆）與大小（1×–4×）
- 自動計算點數總和

**安裝：** 開啟 `/playDices/` 後，點選「加入主畫面」即可安裝為獨立 App。

---

### 🀄 台灣麻將練習 (`mahjongPractice/`)

> 台灣麻將 16 張單機練習版，含 AI 對手，支援吃、碰、胡

**功能：**
- 台灣麻將 16 張牌制（含一對眼 + 五個面子）
- **3 位 AI 對手**自動摸牌出牌（隨機策略，帶延遲動畫）
- 支援**吃、碰**操作（互動按鈕提示）
- 支援**放槍胡**與**自摸胡**判定
- 牌面依花色分色顯示（萬/筒/索/風/三元牌）
- 剛摸進的牌高亮顯示，方便辨識
- 出牌後自動理牌排序
- 流局偵測（牌庫耗盡）
- 完整離線支援（Service Worker 快取）

**安裝：** 開啟 `/mahjongPractice/` 後，點選「加入主畫面」即可安裝為獨立 App。

---

### 🏆 萬用計分板 (`scoreBoard/`)

> 適用於球類、牌局、比賽的通用即時計分工具

**功能：**
- 支援 **2–8 位玩家 / 隊伍**（名稱可直接在卡片上編輯）
- **6 種內建比賽模板**（羽球 21 分制、桌球 11 分制、籃球、排球 25 分制、麻將、一般模式）
- 可設定**目標分數**與 **Deuce 規則**（需連贏 2 分，超過上限強制獲勝）
- **最多 5 個自訂快捷按鈕**（正數加分 / 負數扣分，例如：-1、+2、+3）
- **局數 / 節次管理**：數字遞增或自訂文字循環（如麻將局名），可設定最高局數
- **正數 / 倒數計時器**（可摺疊顯示，倒數到 0 時自動停止）
- **發球權指示器**（適用羽球、桌球、排球）
- **犯規計數器**（適用籃球）
- **撤銷**（可還原任意操作，包含換局）
- Wake Lock API（防止螢幕休眠）
- 一鍵歸零（含確認對話框）
- 完整離線支援（Service Worker 快取）

**安裝：** 開啟 `/scoreBoard/` 後，點選「加入主畫面」即可安裝為獨立 App。

**適用場景範例：**

| 場景 | 建議模板 | 說明 |
|------|---------|------|
| 羽球 | 羽球 (21分制) | 21 分 Deuce，最多 30 分，共 3 局 |
| 桌球 | 桌球 (11分制) | 11 分 Deuce，共 5 局 |
| 籃球 | 籃球 | 倒數計時 10 分鐘 / 節，犯規計數，共 4 節 |
| 排球 | 排球 (25分制) | 25 分 Deuce，共 5 局 |
| 麻將 | 麻將 | 自訂局名循環（東風局→南風局…），快捷按鈕 ±100/+500/+1000 |
| 其他球類 / 桌遊 | 一般模式 | 自訂所有參數 |

---

### 📖 淨讀器 PureReader (`pureReader/`)

> 過濾廣告，還原乾淨的網頁閱讀體驗

**功能：**
- 貼上任意網址，自動提取乾淨正文與圖片（Mozilla Readability）
- DOMPurify 二次消毒，移除殘餘廣告與惡意指令碼
- 支援 **Web Share Target**：安裝後可從瀏覽器分享選單直接傳送網址閱讀
- 支援 PureReader Userscript 預存目前章節起算的 **10／50／100 章**，可直接送到 PWA 或儲存為本地章節檔案
- PWA 離線書庫可將單本小說目前已預存的全部正文下載為 `.purereader.json` 章節檔案，並可用既有匯入功能重新還原
- Userscript 小說閱讀與預存目前支援 m.biquge.tw、look.thisiscm.com、look.twword.com 與 **czbooks.net**
- 對 czbooks 等有流量防護的站點使用較慢的隨機抓取間隔；遇到 HTTP 403／429 或 Cloudflare 驗證頁時會延遲重試
- 深色 / 淺色模式切換（跟隨系統偏好，可手動覆蓋）
- **字體大小調整**（5 級，閱讀時顯示）
- Userscript 閱讀模式可切換 **全螢幕／適中／書頁** 三種正文寬度，並記住選擇
- 一鍵**複製全文**為純文字（含標題與來源網址）
- 雙代理伺服器備援機制（AllOrigins → CodeTabs）
- 完整離線支援（Service Worker 快取 CDN 函式庫）

**安裝：** 開啟 `/pureReader/` 後，點選「加入主畫面」即可安裝為獨立 App。

**Userscript 預存：** 只需安裝單一檔案 [PureReader 完整 Userscript](./pureReader/pure-reader.user.js)。它同時包含快速小說閱讀模式與預存功能；於工具列點選「預存」，選擇 10、50 或 100 章，再選擇「直接送 PWA」或「本地檔案」。桌面支援時可指定檔名與位置；手機會開啟系統分享面板，可選擇「儲存到檔案」。之後在 PWA 首頁的「資料備份與還原」選擇「匯入備份／章節」，即可將本地章節檔案合併到離線書庫。舊版快速小說腳本及獨立橋接腳本應先停用或移除，避免重複執行。

預存開始後會鎖定儲存方式、章數與 PWA 網址，避免流程中途切換；可使用「取消」中止直接傳送，或在本地檔案等待儲存時選擇「取消預存」。

---

### 🧰 PDF 工坊 (`pdfEditor/`)

> 完全在裝置本機處理的 PDF 頁面整理與文字標註工具，文件不會上傳伺服器

**功能：**
- 開啟或拖放一份／多份 PDF，直接合併成同一份文件
- PDF 頁面預覽、縮圖導覽、縮放與頁碼顯示
- 拖曳排序，並提供手機可用的逐頁上移／下移按鈕
- 單頁或多頁選取、順時針旋轉與刪除
- 將選取頁面擷取成獨立 PDF
- 加入多行文字標註，支援繁體中文、字級與顏色設定
- 文字標註可直接拖曳位置或使用 Delete 鍵刪除
- 開啟需要使用者密碼的 PDF；密碼僅保留於當次記憶體
- 自由畫筆、半透明螢光筆、矩形框與箭頭標註
- 加入圖片、透明印章與手寫簽名
- 插入 A4 直向／橫向空白頁，或將多張圖片轉成 PDF
- 依 `1-3, 6, 9-12` 格式批次選取頁面
- 填寫文字、勾選框、下拉選單與單選 PDF 表單，套用後扁平化
- IndexedDB 自動儲存目前草稿；加密文件還原時會重新詢問密碼
- 最近使用文件清單、深色模式與更多鍵盤快捷鍵
- 支援 Web Share Target，可從系統分享選單將 PDF 傳入已安裝的 PWA
- 最多 40 步復原／重做
- 匯出下載、File System Access 另存新檔及系統分享
- 支援 PWA File Handling API，可從作業系統以 PDF 工坊開啟 `.pdf`
- OCR 支援橫書與直書（繁體中文直排）兩種辨識方向，全部在本機完成
- PDF.js 與 pdf-lib 固定版本隨 App 快取，安裝後可完整離線使用

**隱私：** 所有 PDF 解析、編輯和輸出都在瀏覽器內完成，不會將文件傳送到後端。

**加密文件：** 密碼不會寫入自動草稿。由於瀏覽器端寫入元件無法直接重組加密 PDF 物件，受密碼保護的頁面會在匯出時以高解析方式重建成新的無密碼 PDF。

**安裝：** 開啟 `/pdfEditor/` 後，點選「加入主畫面」即可安裝為獨立 App。

---

### ☁️ htmlShare — 單頁 HTML 分享工具 (`htmlShare/`)

> 上傳一份 HTML 檔案（例如 AI 產生的網頁），取得一個網址即可分享給其他人瀏覽

**功能：**
- 拖放或選擇 `.html` 檔案上傳，也可直接貼上 HTML 原始碼
- 上傳後立即取得一個短網址（`.../s/xxxxxxxx`）與對應 QR Code，方便手機掃描分享
- 一鍵複製連結、開啟新分頁預覽
- 本機瀏覽器保留上傳紀錄（僅存在自己裝置上，不會上傳到任何地方）
- 在上傳紀錄裡可以把某筆分享**更新成新版本**（換掉內容，網址不變），只有原本上傳的那個裝置能更新，別人拿到連結沒辦法竄改
- 單檔上限 5MB，任何人只要有連結就能上傳與瀏覽

**安裝：** 開啟 `/htmlShare/` 後，點選「加入主畫面」即可安裝為獨立 App。

**後端：** 沿用 `pureReader` 既有的 `purereader-proxy-cf` Worker（同一個 Cloudflare Worker 身兼 CORS 代理與 htmlShare 上傳／分享，不用另外部署）。首次啟用 htmlShare 功能，只需在 `purereader-proxy-cf/` 建立一次 R2 bucket 並重新部署（見 `purereader-proxy-cf/README.md`），htmlShare 前端已預設指向這個 Worker 的網址。

---

### 📱 QRCode 產生器 (`qrCodeGenerator/`)

> 輸入或貼上任意網址／文字，產生可美化、下載與分享的 QR Code（從 QRPWA 內建同名小工具抽取而來，獨立成一個可安裝的 App）

**功能：**
- 輸入或貼上任意網址／文字，即時產生 QR Code 圖片（QRious 引擎，純前端本機產生，內容不會上傳到任何伺服器）
- 美化選項（選填）：標題（頁首色塊／QR 下方純文字兩種樣式）、副標題、QR 本身顏色與頁首色塊／中央 LOGO 顏色（各 4 組精選深色組合，避免掃描失敗）
- 中央內容：可放最多 4 個字的文字徽章、6 種常用服務圖示（LINE／FB／IG／YouTube／TikTok／URL），或上傳自訂圖片（自動置中裁切並壓縮）
- 依內容長度與是否有中央美化自動選擇容錯等級；內容過長時會優雅降級（自動拿掉中央美化改產生一般 QR）或提示改用短網址，絕不靜默產生無法掃描的 QR
- 下載 PNG 圖片、複製原始網址／文字、透過 Web Share API 一鍵分享（可連同圖片檔一起分享，LINE 等 App 皆可在系統分享清單選擇）
- 支援作為系統「分享目標」：從瀏覽器或其他 App 的分享選單選擇本工具，會自動帶入分享內容並產生 QR Code
- 完整離線支援（Service Worker 快取）

**安裝：** 開啟 `/qrCodeGenerator/` 後，點選「加入主畫面」即可安裝為獨立 App。

### 📝 互動題本 (`interactiveWorkbook/`)

> 講師開課程、匯入題目（JSON），學員以六碼代碼加入分組作答，講師端即時比較與投影各組答案

**功能：**
- 講師自訂課程名稱與密碼建立課程，系統產生**六碼加入代碼**（密碼以 PBKDF2-SHA256 加鹽雜湊儲存，不存明文）
- 題目完全由 **JSON 匯入**，可先下載範本；支援單行／多行文字、數字、日期、單選、多選（可限定恰好選 N 項）、可增減的清單、可增減列數的表格
- 學員輸入代碼 → 選（或新增）組別 → 填姓名即可作答；同課程相同組別共用一份答案（已取消原本的「單位」欄位）
- 依課程進度**逐題開放／關閉**練習，未開放的題目學員無法進入或查看；也可**單獨刪除某一題**（連同各組該題答案），題號自動遞補
- 學員作答畫面固定顯示**自己的組別與姓名**，可當場確認並「更正」
- 講師端**即時**看到各組答案（Firebase onValue，不需重新整理），可依欄位對齊比較、切換單組、簡潔投影模式
- 儲存採 revision 交易比對，多台裝置同時作答不會互相覆寫
- 學員加入 QR Code 全螢幕投影；匯出全部答案 JSON／CSV，JSON 可再匯入還原
- 清除單題答案、刪除小組、重置課程、刪除整個課程

**安裝：** 開啟 `/interactiveWorkbook/` 後，點選「加入主畫面」即可安裝為獨立 App。

**後端：** Firebase Realtime Database（與 `liveInteraction` 共用 `pwa-boardgame` 專案），匿名登入，資料路徑 `artifacts/interactiveWorkbook/public/data/courses/<六碼代碼>`。**首次使用前必須在 Firebase 主控台設定資料庫規則**，內容見 `interactiveWorkbook/database.rules.json`，詳細說明見該資料夾的 `README.md`。

---

### 🗓️ 工作行程記錄 (`workLog/`)

> 往返各客戶時記錄抵達／離開時間、地點、工作內容與成果，每日覆盤後匯出日報寄給主管，月底匯出工時統計表

**功能：**
- **抵達打卡**：一鍵選取常用地點（依使用次數排序）或輸入新地點，抵達時間預設為現在、可修改
- **GPS 定位（可關閉）**：打卡時記錄座標；常用地點第一次打卡會自動記住座標，之後到 300 公尺內自動選取該地點
- **離開計算時長**：進行中卡片即時顯示停留時間，離開時自動計算時長（支援跨午夜）；行程之間自動標示「移動／空檔」時間
- **本日待辦**：可一次貼上多行；抵達客戶時從待辦、常用工作內容快速點選本次工作內容，也可自行輸入
- **帶入前一工作日**：一鍵帶入前一工作日未完成待辦＋「明日計畫」
- **每日覆盤**：逐項填寫工作成果、勾選待辦完成、撰寫今日總結與明日計畫
- **單日報告**：產生純文字日報，可一鍵「寄信給主管」（mailto，自動帶入收件人／副本／主旨）、複製全文或透過系統分享（LINE／Teams…）
- **每月統計**：出勤天數、駐點總時數、依地點時數與占比、每日明細；匯出「統計表 CSV」與「行程明細 CSV」（UTF-8 含 BOM，Excel 開啟不亂碼）
- 可補登／編輯／刪除任一天的行程，常用地點與常用工作內容可自訂與排序
- **資料只存在本機**（localStorage），可匯出 JSON 備份、匯入合併或取代（換手機用）
- 完整離線支援（Service Worker 快取）

**安裝：** 開啟 `/workLog/` 後，點選「加入主畫面」即可安裝為獨立 App。

---

### 🧭 PWA 總覽 App Hub (`appHub/`)

> 快速搜尋並開啟本專案所有已安裝／可安裝的 PWA 工具，新增工具時清單會自動更新

**功能：**
- 列出目前所有 PWA 工具，附圖示與簡短說明
- 即時搜尋（工具名稱、說明、分類皆可比對）
- 點選卡片直接開啟該工具
- 清單資料來自 `apps.json`，由 `scripts/generate-apps-index.mjs` 掃描 `publishHTML/` 下每個子目錄的 `manifest.webmanifest`（或退回解析 `index.html` 的 `<title>`／`<meta name="description">`）自動產生，**不需要手動維護**
- GitHub Actions 部署流程（`.github/workflows/deploy.yml`）會在每次推送到 `main` 時自動重新產生 `apps.json`，因此正式站台上的總覽一律反映當下 repo 的最新工具清單
- 完整離線支援（Service Worker 快取；`apps.json` 採 Network First，連線時優先取得最新清單）

**安裝：** 開啟 `/appHub/` 後，點選「加入主畫面」即可安裝為獨立 App。

**本機重新產生清單：** `node scripts/generate-apps-index.mjs`

---

## 技術架構

| 項目 | 說明 |
|------|------|
| 語言 | HTML / CSS / JavaScript |
| UI 框架 | 多數工具使用 React 18 UMD；PDF 工坊使用原生 ES Modules |
| JSX 編譯 | React 工具使用 Babel Standalone；PDF 工坊不需要編譯 |
| 圖示 | 內嵌 SVG 元件（仿 lucide-react 風格） |
| 樣式 | 多數工具使用 Tailwind CSS Play CDN；PDF 工坊使用獨立響應式 CSS |
| PWA  | Web App Manifest + Service Worker |
| 快取策略 | Stale-While-Revalidate（支援離線） |
| 介面語言 | 繁體中文（zh-TW） |

---

## 目錄結構與 PWA Scope 設計

**每個工具都放在獨立子目錄**，擁有專屬的 PWA Scope，讓手機可以將每個工具分別安裝為獨立的 App，互不干擾。

```
publishHTML/
├── playDices/                   # 骰子搖搖 PWA（scope: ./，解析為 …/playDices/）
│   ├── index.html               # 主頁面（含所有 HTML/CSS/JS）
│   ├── manifest.webmanifest     # PWA 設定（scope、icon、name…）
│   ├── sw.js                    # Service Worker（僅管理此工具的快取）
│   └── icons/
│       ├── playDices-192.svg    # App 圖示 192×192
│       └── playDices-512.svg    # App 圖示 512×512
├── scoreBoard/                  # 萬用計分板 PWA（scope: ./，解析為 …/scoreBoard/）
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js
│   └── icons/
│       ├── scoreBoard-192.svg
│       └── scoreBoard-512.svg
├── mahjongPractice/             # 台灣麻將練習 PWA（scope: ./，解析為 …/mahjongPractice/）
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js
│   └── icons/
│       ├── mahjongPractice-192.svg
│       └── mahjongPractice-512.svg
├── pureReader/                  # 淨讀器 PureReader PWA（scope: ./，解析為 …/pureReader/）
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js
│   └── icons/
│       ├── pureReader-192.svg
│       └── pureReader-512.svg
├── pdfEditor/                   # PDF 工坊 PWA（scope: ./，解析為 …/pdfEditor/）
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── vendor/                  # 固定版本 PDF.js 與 pdf-lib
│   └── icons/
│       ├── pdfEditor-192.svg
│       └── pdfEditor-512.svg
└── README.md
```

---

## 新增工具說明

每個新工具必須放在**獨立子目錄**，並擁有自己的 `manifest.webmanifest` 與 `sw.js`，這樣手機才能將它安裝為獨立的 App。

### 步驟

1. **建立子目錄** `yourTool/`，並在其中建立以下檔案：

   ```
   yourTool/
   ├── index.html               # 工具主頁面（含所有 HTML/CSS/JS）
   ├── manifest.webmanifest     # PWA 設定
   ├── sw.js                    # Service Worker
   └── icons/
       ├── yourTool-192.svg     # 圖示 192×192
       └── yourTool-512.svg     # 圖示 512×512
   ```

2. **設定 `manifest.webmanifest`**，關鍵欄位如下（複製 `scoreBoard/manifest.webmanifest` 再修改）：

   ```json
   {
     "id": "yourTool",
     "name": "工具全名",
     "short_name": "短名稱",
     "start_url": "./",
     "scope": "./",
     "icons": [
       { "src": "./icons/yourTool-192.svg", "sizes": "192x192", "type": "image/svg+xml", "purpose": "any" },
       { "src": "./icons/yourTool-512.svg", "sizes": "512x512", "type": "image/svg+xml", "purpose": "any" },
       { "src": "./icons/yourTool-512.svg", "sizes": "512x512", "type": "image/svg+xml", "purpose": "maskable" }
     ]
   }
   ```

   > **重要：**
   > - `id` 必須是**每個工具唯一的字串**（如工具名稱），**不可**所有工具都用 `"./"`。
   >   macOS Chrome 比對 `id` 時不展開相對路徑，若多個工具都寫 `"./"` 會被識別為同一個 App，導致後安裝的工具顯示先前工具的圖示。
   > - `scope` 與 `start_url` 使用 `"./"` 即可（從 manifest 所在目錄解析，自動指向該工具的子目錄）。
   > - 不可寫成絕對路徑（如 `"/yourTool/"`），在 GitHub Pages 等子目錄部署環境會從網域根解析，造成安裝後 404。

3. **設定 `sw.js`**（複製 `scoreBoard/sw.js`，將所有 `scoreBoard` 改為 `yourTool`）：

   ```js
   const CACHE_NAME = `yourTool-v1`;
   const SHARED_CACHE = `yourTool-shared-v1`;
   const ALL_CACHES = [CACHE_NAME, SHARED_CACHE];
   // …其餘邏輯不變
   ```

4. **在 `index.html` 的 `<head>` 加入 PWA meta**：

   ```html
   <link rel="manifest" href="./manifest.webmanifest">
   <link rel="icon" type="image/svg+xml" href="./icons/yourTool-192.svg">
   <link rel="apple-touch-icon" href="./icons/yourTool-192.svg">
   <meta name="mobile-web-app-capable" content="yes">
   <meta name="apple-mobile-web-app-capable" content="yes">
   ```

   > **注意：** `<link rel="icon" type="image/svg+xml">` 必須加入，macOS Chrome 依賴此標籤顯示 PWA 圖示；遺漏時會退回顯示 App 名稱的第一個字。

5. **SVG 圖示的 `id` 屬性須以工具名稱為前綴**，避免多個圖示在相同渲染環境中產生衝突：

   ```xml
   <!-- 錯誤：通用 id 可能跨檔衝突 -->
   <linearGradient id="bg" ...>
   <!-- 正確：加工具名稱前綴 -->
   <linearGradient id="yourToolBg" ...>
   ```

6. **在 `index.html` 底部加入 Service Worker 註冊**：

   ```html
   <script>
     if ('serviceWorker' in navigator) {
       window.addEventListener('load', () =>
         navigator.serviceWorker.register('./sw.js')
           .catch(err => console.warn('[SW] Registration failed:', err))
       );
     }
   </script>
   ```

### 新工具會自動出現在「PWA 總覽」嗎？

會。只要新目錄有 `manifest.webmanifest`（建議）或至少 `index.html` 有 `<title>`／`<meta name="description">`，
`appHub/` 的清單就會在下次部署時自動包含它，不需要另外手動編輯任何清單檔案。想在本機先看到效果，
執行一次 `node scripts/generate-apps-index.mjs` 重新產生 `appHub/apps.json` 即可。

---

### 為何每個工具需要獨立 Scope？

PWA 的「可安裝性」取決於 `manifest.webmanifest` 中的 `scope` 欄位。若多個工具共用相同的 scope（例如根目錄 `"/"`），行動瀏覽器會認為它們是**同一個 App**，導致後安裝的工具覆蓋前一個，無法同時在主畫面保留兩個獨立圖示。

將每個工具放在獨立子目錄並設定對應的 `scope`，瀏覽器即可識別為不同的 App，使用者便能分別安裝、各自出現在主畫面。
