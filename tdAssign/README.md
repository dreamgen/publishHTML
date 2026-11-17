# 天達排班協作（tdAssign）

天達堂年度排班的第一階段：**各區排人**與**總召協調**。人由各區排，總召與調度台檢查衝突、預排、指定排班人員。

對應設計稿的 **00（系統總覽與情境對照）**、**A1–A6（年度排班控制台、總表、人員狀態、規則與試算、定版匯出、各區進度與協調）**、**B1–B6（區長首頁、提案與試算、區內排人、依日期、分工送出、組別成員）**、**M8（登入與綁定姓名）**，並支援響應式雙欄工作台、大字無障礙模式與服務手冊印刷排版（`A4`/`A5`）。

> 實作成果、額外調整原因、自行補充假設與驗證結果詳見 [IMPLEMENTATION_LOG.md](./IMPLEMENTATION_LOG.md)。

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
| `console.js` | 階段三：00 系統總覽與 A1–A5 年度排班控制台（建置、總表、人員、規則、定版匯出） |
| `app.js`、`styles.css`、`index.html` | 主框架路由、B1–B6／A6／M8 畫面、響應式工作台與大字／印刷樣式 |
| `sw.js` | Service Worker 離線快取管理（目前 `v6`；每次部署要遞增，見「部署清單」） |
| `database.rules.json` | Realtime Database 安全規則（正式版） |
| `database.rules.transition.json` | 升級用的**過渡規則**：修正前的舊規則加上 `acl`／`leads`／`config` 三個節點（只有總召可寫），只在升級步驟 3 暫時貼上，見「升級步驟」 |
| `tools/check-version.mjs` | 部署前版本檢查（`node tools/check-version.mjs [--against HEAD]`，無相依），見「部署清單」 |
| `IMPLEMENTATION_LOG.md` | 階段一～三實作成果、調整原因、假設與驗證紀錄 |
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
   npx wrangler secret put ALLOWED_REDIRECTS       # 建議：App 完整網址，例如 https://dreamgen.github.io/publishHTML/tdAssign/（多個用逗號分隔）
   ```

4. 把 Channel ID 與 Worker 網址填進 `config.js` 的 `lineChannelId`、`lineWorkerUrl`。兩個都填了才會出現 LINE 登入按鈕。
5. `index.html` 的 `Content-Security-Policy` 的 `connect-src` 只列了目前的 Worker 網址（`https://tdassign-line-login.ikt-checkin.workers.dev`）；更換 Worker 時要同步修改。

服務帳戶金鑰只放在 Worker 的 secret，不要放進這個資料夾或 git。

## 升級步驟（階段 1：資料格式與安全，2026-11）

正式環境已經有人在用。新版規則依賴新節點（`acl`、`leads`、`config`），而**修正前的舊規則沒有這三個節點，預設拒絕寫入**，所以總召開 App 時「自動補寫」在舊規則下會失敗。請用**兩段規則**升級（`database.rules.transition.json` 是舊規則加上這三個節點，只有總召可寫；其他行為與舊規則完全相同）：

1. **部署前端**（這個資料夾的全部檔案；部署前先跑 `node tools/check-version.mjs --against HEAD`，見「部署清單」）。舊版手機裡卡在 `localStorage` 的待送資料（`tdAssign-outbox-v1`），新版開啟時會自動轉換成新格式，並在**登入後**才送出（未登入時不送、也不丟棄）；真的無法轉換的筆數會在畫面下方提示。
2. **Realtime Database → 規則，貼上 `database.rules.transition.json` 並發布**（過渡規則）。此時舊行為不變，只多了總召可寫 `acl`／`leads`／`config`。
3. **總召用新版開一次 App**（登入後停在任何頁面幾秒即可）。App 會自動補寫：
   - `acl/g/{組別}`＝`{a: 區, k: 類別}`、`acl/s/{勤務}`＝`{a: 區}`、`acl/p/{人員編號}`＝所屬區（規則用來判斷「這一格屬於哪一區」）
   - `leads/{uid}`＝目前所有區長（規則用來判斷誰可以指定排班人員）
   - `config/autoApproveBind`：資料庫還沒有這個設定時，以 `config.js` 的 `autoApproveBind`（目前 `true`，測試期立即生效）補寫一次，行為不變
   之後總召每次開 App、改派負責區、新增勤務格、指定或取消區長時，App 都會自動同步這些節點。
4. **確認已寫入**：Realtime Database → 資料，看得到 `td116/acl`（含 `g`／`s`／`p` 三個子節點）、`td116/leads`、`td116/config`。沒有就不要進下一步，先看總召的畫面有沒有「沒有權限寫入」的提示。
5. **再貼正式的 `database.rules.json` 並發布。** 貼完後在 Firebase「規則測試區」至少抽測：一般帳號寫 `members/瑞芳/{自己}` 且 role=lead（應拒）、區長寫 `groups/srv_E/{pid}`（應過）、區長寫別區的組（應拒）、一般帳號寫 `log/{id}` 且帶 `undo`（應拒）、總召寫 `acl/s/S171/a`（應過）。
6. （LINE 登入有用時）重新部署 `worker/`，並設定 `ALLOWED_REDIRECTS`（見上方第 3 節）。舊版 Worker 仍相容新前端，只是沒有完全比對 redirect_uri；Worker 的 nonce 檢查目前只在前端有送 nonce 時才比對，舊前端都淘汰後建議改成必填。
7. 建議同時在 Firebase 主控台確認：Authentication 只啟用 Google 與自訂 token（沒有匿名、電子郵件）；Google Cloud 設定預算與用量警示。

**沒有做過渡規則、直接貼新規則時（備案）**：貼完後**立刻**讓總召開 App，新規則允許總召寫這三個節點。在這幾分鐘內，區長與排班人員的排班寫入、一般道親的姓名綁定（含新增名冊 `ok`）、排班人員改人員狀態都會被拒；被拒的筆數會被丟棄並顯示「沒有權限寫入，這一筆沒有存到雲端」。**請先通知各區暫停操作**，總召確認 `acl`／`leads`／`config` 出現後再通知恢復，並請各區檢查剛才排的內容有沒有存到。

**只部署前端、規則還沒動時**：正常操作不受影響，只有總召每次開 App 會看到一次「沒有權限寫入」的錯誤條（`acl` 同步被拒）。

**M8 測試開關**改由資料庫 `td116/config/autoApproveBind` 決定（只有總召可改）。總召在「各區進度與協調（A6）」右側或帳號抽屜的綁定區塊切換；`config.js` 的值只在資料庫沒有設定時（以及本機試用模式）使用。一般使用者不再能用 localStorage 切換。

## 部署清單（每次更新前端都要做）

使用者的手機有 Service Worker 快取；**只改 `app.js` 等檔案而沒遞增版號，已安裝的使用者會一直停在舊版**。

1. 改 `sw.js` 的 `SW_VERSION`（例 `v6` → `v7`）。
2. `sw.js` 的 `ASSETS` 與 `index.html` 所有 `script`／`link` 的 `?v=` 改成同一個數字（兩處網址要完全相同）。
3. 執行檢查（需要 node，不用安裝套件）：

   ```bash
   node tools/check-version.mjs                  # 三處版號一致、ASSETS 的檔案都存在
   node tools/check-version.mjs --against HEAD   # 另外和上一次 commit 比：資產檔有變但版號沒變就失敗
   ```

   `--against` 可換成任何 git ref（例如 `HEAD~1`、上線時的 tag）。失敗時結束碼為 1，可接在部署指令前面。
4. 部署後第一次開啟會顯示舊頁，同時新版在背景安裝；安裝完成時畫面底部出現「有新版，請重新整理」，按下即換新版（沒有按的話，下次開啟也是新版）。
5. 如果有改 `database.rules.json`（先改 `findings/genrules.py`，再 `python3 findings/genrules.py > tdAssign/database.rules.json`），要另外到主控台貼上。

## 雲端資料結構（`td116/`）

| 路徑 | 內容 |
|---|---|
| `meta` | 年度中繼資料：`seeded`（初始化）、`version`（草案版號／`116 定版 v1.0`）、`plan`、`published`（定版鎖定與異動比對快照 `slotDigest`） |
| `groups/{組別}/{人員編號}` | 一個人加入一組：`{ by, n, at, pre?, okBy?, okAt?, byAuto? }`（不可有其他欄位） |
| `groupMeta/{組別}` | 組長／主廚指派（`leadPid`）與禮節 6 大崗位配崗（`posts`） |
| `assign/{勤務}/{人員編號}` | 一個人排進一天 |
| `edits/{勤務}` | 決議套用或總召調整之勤務格覆寫（`area`, `d`, `need`, `grp`, `cancel`, `lock`） |
| `extra/{勤務}` | 提案新增之額外勤務格 |
| `areas/{區}` | 區的狀態：`editing`／`submitted`／`confirmed`，`after`＝送出後變更筆數 |
| `members/{區}/{uid}` | 排班人員：`role`（`lead` 區長／`sched`）、`status`（`ok`／`pending`）、`scope`（可排項目，沒有＝全部） |
| `admins/{uid}` | 總召、調度台 |
| `sched/{uid}` | 是否為任何一區的排班人員（給安全規則用；只有總召或區長可寫） |
| `leads/{uid}` | 是否為任何一區的區長（總召開 App 時自動同步；只有總召可寫） |
| `acl` | 規則用對照表：`g/{組別}`＝`{a, k}`、`s/{勤務}`＝`{a}`、`p/{人員編號}`＝區（總召開 App 時自動同步；只有總召可寫） |
| `config` | 系統設定：`autoApproveBind`（M8 綁定是否立即生效；只有總召可寫） |
| `users/{uid}` | 登入過的人：姓名、登入方式、M8 綁定名冊人員（`pid`, `bindStatus`, `bindArea`）、代管家人（`family`） |
| `addedPeople/{pid}` | M8 申請加入的新增名冊人員；`pid` 為 8 位數亂數，`status`：`pending`／`ok`／`rejected`（只有 `ok` 進名冊），`by`＝申請人 uid |
| `pov/{人員編號}` | 人員狀態：暫停、個人上限、不方便的月份、備註（只有排班人員與總召讀得到） |
| `acks/{issueKey}` | 例外處理紀錄 `{ st, by, at }`；鍵用「~」連接（舊版的「.」讀取時自動換算）；不存訊息內容 |
| `coord/{id}` | 各區請總召協調 |
| `proposals/{id}` | 調整提案：多方案變更（`options`）、討論留言（`talk`）、相關區表態（`votes`）、決議與還原資訊 |
| `nominations/{區}` | 區長提名之帶隊小組長與儲備廚師 |
| `rules` | A4 規則嚴重度（`sev`）、參數（`p`）與 8×8 同日兼職矩陣（`mx`） |
| `log/{id}` | 改動紀錄，只能新增、不能改刪（App 只訂閱最近 1000 筆）；`undo`＝`[{ p: 路徑, v: 舊值, a: 寫入後的值 }]`，復原時比對現值，只接受 groups／assign／groupMeta 路徑 |
| `presence/{區}/{uid}` | 誰正在作業 |

## 已知限制

- **正式上線前，總召要把 `autoApproveBind` 關掉。** 目前 `td116/config/autoApproveBind = true` 是測試期設計：任何登入者都能自行把姓名綁定設為生效、也能直接新增 `status: ok` 的名冊人員（立即進入所有人的名冊與引擎）。正式上線時請總召到 A6（或帳號抽屜的綁定區塊）切回「正式審核」。已核准的綁定在正式審核下，本人改 `pid` 必須同時退回 `pending`（規則已限制）。
- **名稱是自己填的**：`talk.who`、`coord.name`、`presence.name`、`users/name` 不與登入帳號綁定，只代表顯示名稱；權限一律看 uid（`admins`、`members`），不看名稱。
- **沒有寫入筆數上限**：任何登入者可以新增 `log`、`users`、`coord`、`talk`。App 只讀 `log` 最近 1000 筆，但仍請在 Firebase／Google Cloud 設預算與用量警示。
- 區長可把任意 uid 加進 `sched`（只多了讀 `pov` 與建立帶 undo 的 log 的權限）。
- 在 console.js 的 A5 封底 QR 碼，網址超過 213 位元組（含中文等非 ASCII 字元時為 212 位元組，因為多一個 UTF-8 的 ECI 標頭）時不產生 QR，並在該位置顯示提示。
- **安全規則**已依區與可排項目（scope）逐筆檢查，預排只有該區區長能確認；但總召「直接排入不標預排」沒有在規則擋（為了相容初始化與 115 年名單帶入），由 App 負責標記。
- **名冊在 `data.js` 裡是公開的**（姓名、區、年齡、角色），和 `tdSchedule` 一樣會隨網站部署出去；資料整理用的內部備註已移除。
- **共用網域**：App 與同帳號的其他 GitHub Pages 專案共用 `dreamgen.github.io` 這個 origin（登入狀態與本機快取互相讀得到），建議日後改用獨立網域。
- **測試期設定**：目前 `td116/config/autoApproveBind` 為 `true`（姓名綁定立即生效），系統正式上線前由總召在 A6 切換為正式審核。
- 多人連線模式還沒有用真正的 Firebase 專案測過；本機試用模式與 LINE 後端的憑證簽發有測。
- 後續階段待實作（階段四～五）：C1–C3 運行調度台與 M1–M7／M9–M11 手機端個人查詢、回饋與車輛安排。
