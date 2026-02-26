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

## 技術架構

| 項目 | 說明 |
|------|------|
| 語言 | HTML / CSS / JavaScript |
| UI 框架 | React 18（UMD CDN，無需建置步驟） |
| JSX 編譯 | Babel Standalone（瀏覽器端即時編譯） |
| 圖示 | 內嵌 SVG 元件（仿 lucide-react 風格） |
| 樣式 | Tailwind CSS Play CDN（支援任意值語法） |
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

### 為何每個工具需要獨立 Scope？

PWA 的「可安裝性」取決於 `manifest.webmanifest` 中的 `scope` 欄位。若多個工具共用相同的 scope（例如根目錄 `"/"`），行動瀏覽器會認為它們是**同一個 App**，導致後安裝的工具覆蓋前一個，無法同時在主畫面保留兩個獨立圖示。

將每個工具放在獨立子目錄並設定對應的 `scope`，瀏覽器即可識別為不同的 App，使用者便能分別安裝、各自出現在主畫面。
