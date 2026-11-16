# 天達排班協作（tdAssign）

天達堂年度排班的第一階段：**各區排人**與**總召協調**。人由各區排，總召與調度台檢查衝突、預排、指定排班人員。

對應設計稿的 B1（區長首頁）、B2（調整提案與影響試算）、B3（本區要排的人）、B6（組別成員）、B4（依日期勤務）、B5（分工與送出）、A6（各區進度與協調）、M8（登入與綁定姓名）。

> 實作成果、額外調整原因與自行補充假設詳見 [IMPLEMENTATION_LOG.md](./IMPLEMENTATION_LOG.md)（供後續審查檢核）。

## 兩種模式

| 模式 | 什麼時候 | 資料在哪 |
|---|---|---|
| 本機試用 | `config.js` 的 `firebase` 是 `null`（預設） | 只在這台裝置的瀏覽器。可切換身分；開兩個分頁選不同身分可模擬多人 |
| 多人連線 | 填好 Firebase 設定後 | Firebase Realtime Database，需要登入才能排 |

查看不用登入；排班要登入，而且要被指定為排班人員。

## 規則

- 有組別的勤務（廚務組、服務組、禮節隊、交通隊）只改**組員**，全年每一場一起變。
- 沒有組別的勤務（忠恕輪值、洗碗、協辦、大典前晚）**依日期**排人。
- 每一區一開始只有**區長**能排；區長或調度台可以再指定排班人員，並可勾選只排哪些項目。
- 總召或調度台替各區排的人是**預排**，必須由該區區長確認或重排。
- 可以排非本區的人：「找非本區人員」→ 選區域 → 輸入至少一個字。
- 同一天撞到別的排班時，直接顯示對方那一筆的內容。
- 規則不允許的人仍可排入，但會標成違規。
- 只有區長能送出；送出後仍可改，改動會標記給總召。
- 規則檢查沿用 `tdSchedule` 的引擎（`engine.js` 由 `tdSchedule/app.js` 抽出，邏輯未改）。

## 檔案

| 檔案 | 內容 |
|---|---|
| `config.js` | 連線設定（Firebase、LINE） |
| `data.js` | 116 年行事曆、377 人名冊、115 年組別名單（和 `tdSchedule/data.js` 相同） |
| `engine.js` | 規則與排班模型 |
| `store.js` | 資料層：本機／Firebase 同一組介面；離線時先存本機，連線後補送 |
| `app.js`、`styles.css`、`index.html` | 畫面 |
| `database.rules.json` | Realtime Database 安全規則 |
| `worker/` | LINE 登入用的 Cloudflare Worker |

## 改成多人連線：設定步驟

### 1. 建立 Firebase 專案

1. 到 Firebase 主控台建立新專案（和遊戲用的 `pwa-boardgame` 分開）。
2. 建立 **Realtime Database**（地區建議 asia-southeast1）。
3. **Authentication → Sign-in method** 啟用 **Google**。
4. **Authentication → Settings → Authorized domains** 加入部署網址的網域（例如 `dreamgen.github.io`）。
5. **專案設定 → 您的應用程式** 新增網頁應用程式，把設定物件貼到 `config.js` 的 `firebase`。
6. **Realtime Database → 規則** 貼上 `database.rules.json` 的內容並發布。

### 2. 指定第一位總召

總召／調度台名單（`admins`）只能從主控台設定：

1. 先用 Google 登入一次 App。
2. 到 **Authentication → Users** 複製自己的 User UID。
3. 到 **Realtime Database → 資料**，新增 `td116/admins/<UID>`，值填 `true`。
4. 重新整理 App，首頁按「初始化 116 年資料」。

之後各區區長由總召在「各區進度 → 排班人員」指定（對方要先登入過一次）。

### 3. LINE 登入（選用）

1. 到 LINE Developers 建立 **LINE Login** channel，Callback URL 填 App 的網址（例如 `https://dreamgen.github.io/publishHTML/tdAssign/`）。
2. Firebase **專案設定 → 服務帳戶 → 產生新的私密金鑰**，下載 JSON。
3. 部署 `worker/`：

   ```bash
   cd worker
   npx wrangler deploy
   npx wrangler secret put LINE_CHANNEL_ID
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler secret put FIREBASE_CLIENT_EMAIL   # JSON 裡的 client_email
   npx wrangler secret put FIREBASE_PRIVATE_KEY    # JSON 裡的 private_key 整段
   npx wrangler secret put ALLOWED_ORIGIN          # 例如 https://dreamgen.github.io
   ```

4. 把 Channel ID 與 Worker 網址填進 `config.js` 的 `lineChannelId`、`lineWorkerUrl`。兩個都填了才會出現 LINE 登入按鈕。
5. Worker 網址如果不是 `*.workers.dev`，要把它加進 `index.html` 的 `Content-Security-Policy` 的 `connect-src`。

服務帳戶金鑰只放在 Worker 的 secret，不要放進這個資料夾或 git。

## 雲端資料結構（`td116/`）

| 路徑 | 內容 |
|---|---|
| `groups/{組別}/{人員編號}` | 一個人加入一組：`{ by, n, at, pre? }` |
| `groupMeta/{組別}` | 組長／主廚指派（`leadPid`）與禮節 6 大崗位配崗（`posts`） |
| `assign/{勤務}/{人員編號}` | 一個人排進一天 |
| `edits/{勤務}` | 決議套用或總召調整之勤務格覆寫（`area`, `d`, `need`, `grp`, `cancel`, `lock`） |
| `extra/{勤務}` | 提案新增之額外勤務格 |
| `areas/{區}` | 區的狀態：`editing`／`submitted`／`confirmed`，`after`＝送出後變更筆數 |
| `members/{區}/{uid}` | 排班人員：`role`（`lead` 區長／`sched`）、`status`（`ok`／`pending`）、`scope`（可排項目，沒有＝全部） |
| `admins/{uid}` | 總召、調度台 |
| `sched/{uid}` | 是否為任何一區的排班人員（給安全規則用） |
| `users/{uid}` | 登入過的人：姓名、登入方式、M8 綁定名冊人員（`pid`, `bindStatus`, `bindArea`）、代管家人（`family`） |
| `addedPeople/{pid}` | M8 找不到姓名時申請加入的新增名冊人員 |
| `pov/{人員編號}` | 人員狀態：暫停、個人上限、不方便的月份、備註（只有排班人員與總召讀得到） |
| `acks/{issueKey}` | 例外處理紀錄（如 `接受例外`） |
| `coord/{id}` | 各區請總召協調 |
| `proposals/{id}` | 調整提案：多方案變更（`options`）、討論留言（`talk`）、相關區表態（`votes`）、決議與還原資訊 |
| `nominations/{區}` | 區長提名之帶隊小組長與儲備廚師 |
| `log/{id}` | 改動紀錄（可單筆復原） |
| `presence/{區}/{uid}` | 誰正在作業 |

## 已知限制

- **安全規則只管到「是不是排班人員」**：哪一區、哪些項目可排是由 App 判斷，規則沒有逐區擋。有心人用排班人員的帳號直接呼叫資料庫可以改到別區；每筆都有紀錄可追。
- **名冊在 `data.js` 裡是公開的**（姓名、區、年齡、角色），和 `tdSchedule` 一樣會隨網站部署出去。
- **測試期設定**：`config.js` 的 `autoApproveBind` 目前預設為 `true`（姓名綁定立即生效），系統正式上線前應改回 `false`，恢復由區長或小組長確認。
- 多人連線模式還沒有用真正的 Firebase 專案測過；本機試用模式與 LINE 後端的憑證簽發有測。
- 後續階段待實作（階段三～五）：A1–A5 年度控制台與印刷版定版匯出、M1–M7／M9–M11 手機端查詢與車輛安排、C1–C3 運行調度台。
