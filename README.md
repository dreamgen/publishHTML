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
- 支援 **2–8 位玩家 / 隊伍**
- 點選名稱可即時重新命名
- 可設定**分數步距**（+1 / +2 / +3 / +5 / +10 / 自訂）
- 可設定**目標分數**（達到後自動顯示勝利畫面）
- 領先者卡片自動金色高亮
- **撤銷**功能（最多 30 步）
- 回合計數器
- 一鍵重置 / 再來一局
- 完整離線支援（Service Worker 快取）

**安裝：** 在瀏覽器開啟後，點選「加入主畫面」即可安裝為 App。

**適用場景範例：**

| 場景 | 建議步距 | 建議目標分 |
|------|---------|-----------|
| 籃球 | +2 / +3 | 21 |
| 桌球 / 羽球 | +1 | 11 或 21 |
| 撲克（鬥地主）| +1 | 自訂 |
| 麻將 | +10 | 自訂 |
| 拔河計分 | +1 | 3（先得 3 分） |
| 大富翁 | +1 | 無限制 |

---

## 技術架構

| 項目 | 說明 |
|------|------|
| 語言 | HTML / CSS / Vanilla JS（無框架） |
| 樣式 | Tailwind CSS（CDN） |
| PWA  | Web App Manifest + Service Worker |
| 快取策略 | Stale-While-Revalidate（支援離線） |
| 語言 | 繁體中文（zh-TW） |

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
