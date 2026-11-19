# 天達排班協作（tdAssign）

天達堂年度排班的第一階段：**各區排人**與**總召協調**。人由各區排，總召與調度台檢查衝突、預排、指定排班人員。

對應設計稿的 **00（系統總覽與情境對照）**、**A1–A6（年度排班控制台、總表、人員狀態、規則與試算、定版匯出、各區進度與協調）**、**B1–B6（區長首頁、提案與試算、區內排人、依日期、分工送出、組別成員）**、**M8（登入與綁定姓名）**，並支援響應式雙欄工作台、大字無障礙模式與服務手冊印刷排版（`A4`/`A5`）。

目前版本 **v20**（`sw.js` 的 `SW_VERSION`）。v19 起實作全角色分流入口（`R1–R5`＋`#/my`＋`#/lookup`＋`B3` 互動月曆），v20 新增 **R0 系統管理員（`sysadmins`）與帳號與權限管理中心（`#/sys`）**；B3「本區要排的人」支援三個可收合的優先順序區段、組別與日期／互動月曆三段切換；B4／B6 的找人支援一次貼多個姓名與直接新增名冊人員。

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
- 規則檢查沿用 `tdSchedule` 的引擎（`engine.js` 由 `tdSchedule/app.js` 抽出；審查修正後新增換日、個人平日上限、只排假日、不再排班等讀取，其餘邏輯未改）。

### B3／B4／B6 排人功能（v7～v17）

- **找人可一次貼多個姓名**：以空白（含全形）、`,` `，` `、` `;` `；` `/` `|` `・` 等分隔；重複詞自動去重；找不到與已在名單的詞會列出提示。多個詞時可按「一次加入完全相符的 N 人」（總召替各區排則為「一次預排」）：**每個詞必須與名冊姓名完全相符且只有一人**才會加入；部分相符（例如「陳明」符合「陳明德」「陳明華」）、同名多人、找不到的詞一律不加入，會列在提示下方並說明原因，也留在搜尋框方便修正。完全相符但有規則違規的人仍會加入並標違規（按鈕、紀錄與提示都會標示人數）。單次最多 100 人，可用 B5 復原。只輸入一個詞時維持部分比對與候選清單。非本區模式同樣支援。
- **找人排序**：優先去年忠恕搭檔與同日別（平日／假日）的人，其次依既有的合適程度。
- **找人時直接新增名冊人員**：找不到姓名時可「＋ 新增人員」（區域、性別、備註），提供「新增並加入」與「僅新增至名冊」。排班人員新增的人員直接為 `status: ok`，立即進名冊與規則檢查；備註預設「排班人員新增名冊」。使用者已確認：**排班人員新增名冊人員不需確認（不限區）**；但排入時仍依預排規則——總召（或任何依規則應標預排者）替六區排入的紀錄一律標「預排」，只有該區區長能確認。
- **B4 忠恕「帶入去年」**：依去年同日搭檔（`prevJz`）排序；去年同日有多組搭檔時，開「選擇去年合作組合」抽屜，並避開本年已用過的組合；候選人下方會顯示去年搭檔提示。
- **禮節隊「帶入去年」**：以 115 年禮節隊名單（`defaultGroups`）帶入，不再替換已加入的人。
- **B3 本區頁**：優先順序區段可收合；「組別模式」依組別看、「日期模式」依場次看；點狀月曆可點日期跳到該場。

## 檔案

| 檔案 | 內容 |
|---|---|
| `config.js` | 連線設定（Firebase、LINE） |
| `data.js` | 116 年行事曆、377 人名冊、115 年組別名單 `defaultGroups`（含禮節隊 8 隊、基新 2 隊）、115 年忠恕搭檔 `prevJz`（32 筆，`{d, cat, area, pids}`）。由整理名冊的流程產生，與 `tdSchedule/data.js` 已不完全相同；改了名單要重新產生此檔，並遞增版號 |
| `engine.js` | 規則與排班模型 |
| `store.js` | 資料層：本機／Firebase 同一組介面；離線時先存本機，連線後補送 |
| `console.js` | 階段三：00 系統總覽與 A1–A5 年度排班控制台（建置、總表、人員、規則、定版匯出） |
| `app.js`、`styles.css`、`index.html` | 主框架路由、B1–B6／A6／M8 畫面、響應式工作台與大字／印刷樣式 |
| `sw.js` | Service Worker 離線快取管理（目前 `v17`；每次部署要遞增，見「部署清單」） |
| `database.rules.json` | Realtime Database 安全規則（正式版，含 v15 的 `addedPeople` 規則）。請直接修改此檔；開發用的規則產生器已與此檔同步（內容一致），兩者修改時需一起更新 |
| `database.rules.transition.json` | 升級用的**過渡規則**：修正前的舊規則加上 `acl`／`leads`／`config` 三個節點（只有總召可寫），只在升級步驟 3 暫時貼上，見「升級步驟」 |
| `tools/check-version.mjs` | 部署前版本檢查（`node tools/check-version.mjs [--against HEAD]`，無相依），見「部署清單」 |
| `IMPLEMENTATION_LOG.md` | 階段一～三實作成果、調整原因、假設，以及 Code Review 修正與 v7～v17 更新紀錄 |
| `worker/` | LINE 登入用的 Cloudflare Worker |

## 改成多人連線：設定步驟

### 1. 建立 Firebase 專案

1. 到 Firebase 主控台建立新專案（和遊戲用的 `pwa-boardgame` 分開）。
2. 建立 **Realtime Database**（地區建議 asia-southeast1）。
3. **Authentication → Sign-in method** 啟用 **Google**。
4. **Authentication → Settings → Authorized domains** 加入部署網址的網域（例如 `dreamgen.github.io`）。
5. **專案設定 → 您的應用程式** 新增網頁應用程式，把設定物件貼到 `config.js` 的 `firebase`。
6. **Realtime Database → 規則** 貼上 `database.rules.json` 的內容並發布。

### 2. 指定第一位系統管理員與總召

v20 起支援「**系統管理員（`sysadmins`）**」於 App 內的「帳號與權限管理中心（`#/sys`）」線上指派或撤銷總召（`admins`）、各區區長與排班人員。第一位系統管理員必須先從主控台設定：

1. 先用 Google（或 LINE）登入一次 App，可在帳號抽屜或 `#/sys` 複製自己的 User UID。
2. 也可在 Firebase **Authentication → Users** 複製自己的 User UID。
3. 到 **Realtime Database → 資料**，新增 `td116/sysadmins/<UID>`，值填 `true`（若需同時指定總召可再於 App `#/sys` 一鍵設定，或新增 `td116/admins/<UID>: true`）。
4. 重新整理 App，系統管理員即可進入 `#/sys` 集中管理所有總召、各區區長與排班人員（對方需先登入過一次，或透過「以 UID 預先授權」先寫入權限），並點選「總召指揮 → 初始化 116 年資料」。

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
5. `index.html` 的 `Content-Security-Policy` 的 `connect-src` 列了目前的 Worker 網址（`https://tdassign-line-login.ikt-checkin.workers.dev`）；更換 Worker 時要同步修改。
6. v7 起 CSP 另外允許 Firebase 的網域（`*.firebasedatabase.app`、`*.firebaseio.com`，用在 `script-src`、`connect-src`、`frame-src`），讓 Realtime Database 在網路受限時能改用長輪詢連線。目前是萬用網域，之後建議改成專案資料庫的精確主機名稱（見「已知限制」）。

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

## 升級步驟（v7～v17，2026-11-17～18）

已完成階段 1 升級（`acl`／`leads`／`config` 已寫入、正式規則已貼上）的環境，升到 v17 要做：

1. **部署前端**（先跑 `node tools/check-version.mjs --against HEAD`）。CSP 有變更（Firebase 網域），舊版快取會在新版安裝後提示重新整理。
2. **重新貼上 `database.rules.json` 並發布。** v15 起 `addedPeople` 的建立規則允許排班人員（`sched`）直接建立 `status: ok` 的名冊人員；前端 v15 的「新增並加入」在舊規則下會被拒。其餘節點規則沒有變。
3. **v17 沒有改規則。** 規則檔內容與 v16 相同（含 v15 的 `addedPeople` 規則）；開發用的規則產生器已同步，產生結果與 `database.rules.json` 一致，所以修改規則時直接改規則檔即可。
4. **禮節隊名單**：`data.js` 的禮節隊（`lj_*`）已帶入 115 年名單，但**已經初始化的正式資料庫不會自動帶入**（只有「初始化 116 年資料」才會寫入）。正式環境目前禮節隊是空的，要在各禮節隊頁按「帶入去年」才會帶入 115 名單。
5. **禮節 1、2 隊名單有重疊**：松山、三重、瑞芳、內湖的 1、2 隊各有 12～14 人同時在兩隊，這是 115 年實際編制。重疊的人每一場禮節都會出勤（全年 3 場），人數也會略多於每場需求 22 人，系統不會提示。**使用者已確認：重疊者算 2 次；帶入 115 名單可超過需求。** 兩隊各按一次「帶入去年」就會得到同樣的重疊；若不要重疊，請在帶入後自行移出。

## 升級步驟（v20：系統管理員與帳號權限管理，2026-11）

v20 新增 `td116/sysadmins/{uid}` 角色階層及「帳號與權限管理中心（`#/sys`）」，原本唯讀鎖死的 `td116/admins` 改為可由 `sysadmins` 線上新增與撤銷，且 `sysadmins` 擁有全系統讀寫權限及綁定解除權限：

1. **部署前端**（執行 `node tools/check-version.mjs`，確認版號為 `v20`）。
2. **重新貼上 `database.rules.json` 並發布**（Firebase 主控台 → Realtime Database → 規則）。未發布新規則前，總召（`admins`）原有操作完全不受影響，但 `sysadmins` 節點與線上指定總召會被舊規則拒絕。
3. **建立第一位系統管理員**：到 Realtime Database → 資料新增 `td116/sysadmins/<您的UID>: true`（含防呆：系統管理員不可在 App 內刪除自己）。之後即可由該帳號在 `#/sys` 線上管理其他系統管理員、總召、區長與排班人員。

## 部署清單（每次更新前端都要做）

使用者的手機有 Service Worker 快取；**只改 `app.js` 等檔案而沒遞增版號，已安裝的使用者會一直停在舊版**。

1. 改 `sw.js` 的 `SW_VERSION`（遞增版號，例如 `v17` → `v18`）。
2. `sw.js` 的 `ASSETS` 與 `index.html` 所有 `script`／`link` 的 `?v=` 改成同一個數字（兩處網址要完全相同）。
3. 執行檢查（需要 node，不用安裝套件）：

   ```bash
   node tools/check-version.mjs                  # 三處版號一致、ASSETS 的檔案都存在
   node tools/check-version.mjs --against HEAD   # 另外和上一次 commit 比：資產檔有變但版號沒變就失敗
   ```

   `--against` 可換成任何 git ref（例如 `HEAD~1`、上線時的 tag）。失敗時結束碼為 1，可接在部署指令前面。
4. 部署後第一次開啟會顯示舊頁，同時新版在背景安裝；安裝完成時畫面底部出現「有新版，請重新整理」，按下即換新版（沒有按的話，下次開啟也是新版）。
5. 如果有改 `database.rules.json`，要另外到 Firebase 主控台貼上並發布。規則請直接改 `database.rules.json`。

## 雲端資料結構（`td116/`）

| 路徑 | 內容 |
|---|---|
| `meta` | 年度中繼資料：`seeded`（初始化）、`version`（草案版號／`116 定版 v1.0`）、`plan`、`autoAt`、`published`（定版鎖定、異動比對快照 `slotDigest`、未確認預排備案 `preNotes`、`draftVersionAtPublish`）、`publishedHistory/{at}`（解除定版時留下的精簡紀錄） |
| `groups/{組別}/{人員編號}` | 一個人加入一組：`{ by, n, at, pre?, okBy?, okAt?, byAuto? }`（不可有其他欄位） |
| `groupMeta/{組別}` | 組長／主廚指派（`leadPid`）與禮節 6 大崗位配崗（`posts`）；指派對象必須仍是該組組員 |
| `assign/{勤務}/{人員編號}` | 一個人排進一天 |
| `edits/{勤務}` | 決議套用或總召調整之勤務格覆寫（`area`, `d`, `need`, `grp`, `cancel`, `lock`） |
| `extra/{勤務}` | 提案新增之額外勤務格 |
| `areas/{區}` | 區的狀態：`editing`／`submitted`／`confirmed`，`after`＝舊版送出後變更筆數；`changes/{id}`＝`{at, by}`，送出後每一次變更新增一筆（變更總數＝`after`＋`changes` 筆數；送出、確認、退回或「標為已看」時清空） |
| `members/{區}/{uid}` | 排班人員：`role`（`lead` 區長／`sched`）、`status`（`ok`／`pending`）、`scope`（可排項目，沒有＝全部） |
| `sysadmins/{uid}` | v20 新增：系統管理員（值為 `true`；需先於 Firebase 主控台建立第一位，之後可於 `#/sys` 指派其他系統管理員、總召與帳號權限；不可自我撤銷） |
| `admins/{uid}` | 總召、調度台（v20 起可由系統管理員於 `#/sys` 線上指定或撤銷） |
| `sched/{uid}` | 是否為任何一區的排班人員（給安全規則用；只有總召或區長可寫）。v15 起也是「可直接建立 `ok` 名冊人員」的條件 |
| `leads/{uid}` | 是否為任何一區的區長（總召開 App 時自動同步；只有總召可寫） |
| `acl` | 規則用對照表：`g/{組別}`＝`{a, k}`、`s/{勤務}`＝`{a}`、`p/{人員編號}`＝區（總召開 App 時自動同步；只有總召可寫） |
| `config` | 系統設定：`autoApproveBind`（M8 綁定是否立即生效；只有總召可寫） |
| `users/{uid}` | 登入過的人：姓名、登入方式、M8 綁定名冊人員（`pid`, `bindStatus`, `bindArea`）、代管家人（`family`） |
| `addedPeople/{pid}` | 新增名冊人員；`pid` 為 8 位數亂數（10000000–99999999）。欄位：`n` 姓名、`a` 區、`sx` 性別（乾／坤）、`src: 'N'`、`note`、`status`（`pending`／`ok`／`rejected`，只有 `ok` 進名冊；沒有 `status` 的舊資料視為 `ok`）、`by`＝建立者 uid、`at`。來源有二：M8 道親申請（`pending`，測試期可直接 `ok`）；v15 起排班人員在找人時直接新增（`status: ok`，備註預設「排班人員新增名冊」）。名冊沒有刪除功能，新增名冊人員也不在「復原」範圍內（復原只移出排班） |
| `pov/{人員編號}` | 人員狀態：暫停、個人上限、不方便的月份、備註（只有排班人員與總召讀得到） |
| `acks/{issueKey}` | 例外處理紀錄 `{ st, by, at }`；鍵用「~」連接（舊版的「.」讀取時自動換算）；不存訊息內容 |
| `coord/{id}` | 各區請總召協調 |
| `proposals/{id}` | 調整提案：多方案變更（`options`）、討論留言（`talk`）、相關區表態（`votes`，只有該區區長或總召）、決議與還原資訊（`appliedEdits`、`appliedExtra`、`prevEdits`、`prevExtra`、`resolvedVer`） |
| `nominations/{區}` | 區長提名之帶隊小組長與儲備廚師 |
| `rules` | A4 規則嚴重度（`sev`）、參數（`p`）與 8×8 同日兼職矩陣（`mx`） |
| `log/{id}` | 改動紀錄，只能新增、不能改刪（App 只訂閱最近 1000 筆）；`undo`＝`[{ p: 路徑, v: 舊值, a: 寫入後的值 }]`，復原時比對現值，只接受 groups／assign／groupMeta 路徑 |
| `presence/{區}/{uid}` | 誰正在作業 |

## 已知限制

### 上線前要處理

- **正式上線前，總召要把 `autoApproveBind` 關掉。** 目前 `td116/config/autoApproveBind = true` 是測試期設計：任何登入者都能自行把姓名綁定設為生效、也能直接新增 `status: ok` 的名冊人員（立即進入所有人的名冊與引擎）。正式上線時請總召到 A6（或帳號抽屜的綁定區塊）切回「正式審核」。已核准的綁定在正式審核下，本人改 `pid` 必須同時退回 `pending`（規則已限制）。
- **新增名冊人員不需確認（使用者確認）**：關掉 `autoApproveBind` 之後，排班人員仍可直接新增 `ok` 名冊人員（不限區），建立後立即進所有人的名冊與規則檢查，且名冊沒有刪除功能，因此指定排班人員前請確認對象。排入時仍依預排規則由區長確認。
- **CSP 使用萬用網域（待修）**：`script-src` 等放行 `*.firebasedatabase.app`、`*.firebaseio.com`（v7 為了長輪詢）。目前沒有已知可用的注入點，但建議改成專案資料庫的精確主機名稱，並同步更新本檔 LINE 登入第 6 點的說明。

### 待修的小問題（中低嚴重度）

- **禮節隊超過需求沒有提示**（使用者已確認：重疊者算 2 次、帶入 115 名單可超過需求）：1、2 隊重疊（見「升級步驟（v7～v17）」）會讓每場人數略多於需求，也會讓重疊者年度次數較多，系統不會提示「人數過多」。
- **「選擇去年合作組合」抽屜的排版樣式尚未補齊**（v17 起換頁會自動關閉抽屜）。
- **B3 日期模式的組別場次**：同一組別的每一場顯示的是組別全年的撞到／違規數字，不是該場次的數字（待修）。
- **月曆**：圓點小於建議的點選尺寸，日期格沒有鍵盤操作；全月份矩陣以「該週的星期日」歸月，1／1 附近的活動可能出現在前一年 12 月的列。
- **多姓名搜尋**：從訊息貼上多行名單時，瀏覽器可能把換行去掉而黏成一個詞，建議先換成頓號；`・`、`·` 會被當成分隔符，含中點的姓名會被拆開。

### 其他

- **名稱是自己填的**：`talk.who`、`coord.name`、`presence.name`、`users/name` 不與登入帳號綁定，只代表顯示名稱；權限一律看 uid（`admins`、`members`），不看名稱。
- **沒有寫入筆數上限**：任何登入者可以新增 `log`、`users`、`coord`、`talk`；排班人員新增名冊人員也沒有筆數上限。App 只讀 `log` 最近 1000 筆，但仍請在 Firebase／Google Cloud 設預算與用量警示。
- 區長可把任意 uid 加進 `sched`；`sched` 成員可讀 `pov`、建立帶 undo 的 log，v15 起也可新增 `ok` 名冊人員，因此指定排班人員前請確認對象。
- 新增名冊人員不在「復原」範圍內；復原只移出排班，名冊人員會留著。
- 在 console.js 的 A5 封底 QR 碼，網址超過 213 位元組（含中文等非 ASCII 字元時為 212 位元組，因為多一個 UTF-8 的 ECI 標頭）時不產生 QR，並在該位置顯示提示。
- **安全規則**已依區與可排項目（scope）逐筆檢查，預排只有該區區長能確認；但總召「直接排入不標預排」沒有在規則擋（為了相容初始化與 115 年名單帶入），由 App 負責標記。
- **名冊在 `data.js` 裡是公開的**（姓名、區、年齡、角色），和 `tdSchedule` 一樣會隨網站部署出去；資料整理用的內部備註已移除。
- **共用網域**：App 與同帳號的其他 GitHub Pages 專案共用 `dreamgen.github.io` 這個 origin（登入狀態與本機快取互相讀得到），建議日後改用獨立網域。
- **規則驗證**：安全規則只用離線模擬器（targaryen）驗證，未經 Firebase 官方模擬器；部署新規則後請用主控台「規則測試區」抽測。
- 審查期間的自動測試只在本機試用模式進行（沒有連線正式 Firebase）；正式環境的多人連線、Google／LINE 登入以實際使用為準。
- 後續階段待實作（階段四～五）：C1–C3 運行調度台與 M1–M7／M9–M11 手機端個人查詢、回饋與車輛安排。
