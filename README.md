# publishHTML — PWA 工具集

一組可安裝的 Progressive Web App（PWA）小工具，適合在手機或平板上獨立使用。

---

## 工具列表

### 🎲 骰子搖搖 (`playDices.html`)

> 使用物理引擎模擬的 3D 骰子，支援搖動裝置投擲骰子

**功能：**
- 3D 物理骰子模擬（Three.js + Cannon.js）
- 搖動手機自動擲骰（需授權動作感測器）
- 可調整骰子數量（1–20 顆）與大小（1×–4×）
- 自動計算點數總和

**安裝：** 在瀏覽器開啟後，點選「加入主畫面」即可安裝為 App。

---

### 🏆 萬用計分板 (`scoreBoard.html`)

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

**安裝：** 在瀏覽器開啟後，點選「加入主畫面」即可安裝為 App。

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

### 目錄結構

```
publishHTML/
├── playDices.html          # 3D 骰子 PWA
├── playDices.webmanifest   # 骰子 App 設定
├── scoreBoard.html         # 萬用計分板 PWA
├── scoreBoard.webmanifest  # 計分板 App 設定
├── sw.js                   # Service Worker（共用）
├── icons/
│   ├── playDices-192.svg   # 骰子圖示 192×192
│   ├── playDices-512.svg   # 骰子圖示 512×512
│   ├── scoreBoard-192.svg  # 計分板圖示 192×192
│   └── scoreBoard-512.svg  # 計分板圖示 512×512
└── README.md
```

### 新增工具說明

1. 建立 `yourTool.html`（含所有 HTML/CSS/JS）
2. 建立 `yourTool.webmanifest`（參考 `scoreBoard.webmanifest`）
3. 在 `icons/` 新增 SVG 圖示（192 與 512）
4. 在 `sw.js` 的 `APP_CACHE_MAP` 加入一行：
   ```js
   'yourTool': `${CACHE_PREFIX}-yourTool-${SW_VERSION}`,
   ```
