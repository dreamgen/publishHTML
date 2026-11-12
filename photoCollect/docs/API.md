# 雲端收照片 API 合約（v1）

所有子系統（Worker 後端、上傳頁 PWA、管理頁、本地 `mvctl sync`）都以本文件為準。修改合約前先改本文件。

- Runtime：Cloudflare Workers（ES modules）＋ Workers Static Assets（`public/`）＋ R2（binding `PHOTOS`）。
- 只有一個 Worker：`/api/*` 由程式處理，其餘路徑交給靜態資源；`/u/*` 一律回 `public/upload.html`（並依活動設定改寫分享預覽 meta，見 §5.6），`/og/{code}` 回分享預覽圖，`/admin` 回 `public/admin.html`，`/download` 回 `public/download/index.html`。
- 所有回應 JSON，UTF-8。錯誤格式：`{"error":"<code>","message":"<給人看的繁中訊息>"}`，HTTP 狀態碼對應。
- 所有回應加 `X-Robots-Tag: noindex`；HTML 也有 `<meta name="robots" content="noindex">`。
- 時間：ISO 8601 字串。活動「本地時間」（流程表、EXIF）一律是**不帶時區的** `HH:MM` / `YYYY-MM-DDTHH:MM:SS`，代表活動當地時間。`opens_at`/`closes_at` 由前端以使用者瀏覽器時區轉成帶時區 ISO 字串送出。

## 1. 三把鑰匙

| 鑰匙 | 格式 | 傳遞方式 | 權限 |
|---|---|---|---|
| 建立密碼 `CREATE_SECRET` | Worker secret（部署時設定） | 建立活動時 header `X-Create-Secret` | 只能建立新活動 |
| 上傳碼 `upload_code` | 22 字元 base64url 隨機 | 網址 `/u/{upload_code}` | 讀活動公開資訊與統計數字、上傳照片 |
| 管理碼 `admin_code` | 32 字元 base64url 隨機 | 網址片段 `/admin#e={event_id}&k={admin_code}`；API 用 `Authorization: Bearer {admin_code}` | 該活動全部管理 |
| 同步金鑰 `sync_key` | 32 字元 base64url 隨機 | `Authorization: Bearer {sync_key}` | 下載該活動照片與設定；回寫需求張數 |

- `event_id`：`ev_` + 12 字元 base64url。
- 管理碼與同步金鑰在 R2 只存 SHA-256（hex）；同步金鑰另存一份明碼於 config 的 `sync.key`（僅管理 API 回傳，讓管理頁能重新複製提示詞）。比對一律用常數時間比較。
- 上傳碼存明碼（它本來就在公開連結裡），並建立索引物件 `codes/u/{upload_code}` → 內容為 event_id。

## 2. R2 物件配置

```
events/{event_id}/config.json        活動設定（見 §3）
events/{event_id}/p/{hash}.{ext}     照片（壓縮後 jpg，或無法壓縮時的原檔 heic/png/…）
events/{event_id}/t/{hash}.jpg       縮圖（長邊 320px）
codes/u/{upload_code}                內容 = event_id
events/{event_id}/og.png | og.jpg    分享預覽圖（1200×630 建議；依上傳的 MIME 擇一，換格式時舊檔刪除）
```

照片物件的 `customMetadata`（全部是字串，總長 < 2KB，超過就截斷 note/uploader）：

| key | 內容 |
|---|---|
| `hash` | 原始檔案 SHA-256 hex（去重鍵；由手機端計算） |
| `orig_name` | 原始檔名（截 80 字） |
| `uploader` | 稱呼（截 24 字） |
| `device` | 裝置隨機 ID（localStorage 產生，用來算「這支手機累計」） |
| `groups` | JSON 陣列字串，例如 `["第一小隊"]` |
| `segment` | 使用者手動選的環節名稱；`auto` 表示依時間判斷 |
| `exif_time` | `YYYY-MM-DDTHH:MM:SS`（手機端從原檔 EXIF 讀出；讀不到則用 `File.lastModified` 轉本地時間，並 `time_src=mtime`） |
| `time_src` | `exif` 或 `mtime` |
| `w` `h` | 壓縮後尺寸 |
| `original` | `1` 表示使用者勾了「傳原圖」 |
| `uploaded_at` | 伺服器時間 ISO |

## 3. config.json

```json
{
  "id": "ev_xxxxxxxxxxxx",
  "version": 1,
  "created_at": "...", "updated_at": "...",
  "basic": {"name": "活動名稱", "date": "2026-11-08", "location": "", "organizer": ""},
  "schedule_text": "09:00-09:30 報到相見歡\n10:30-12:00 闖關遊戲",
  "segments": [{"start": "09:00", "end": "09:30", "name": "報到相見歡"}],
  "groups": ["第一小隊", "第二小隊"],
  "shots": [{"segment": "報到相見歡", "target": 10, "tip": "入場笑臉", "source": "auto|manual|mv"}],
  "upload": {
    "mode": "auto",                       // auto | open | closed（手動覆寫）
    "opens_at": null, "closes_at": null,  // ISO 帶時區；null = 未設定
    "retention_days": 30,
    "max_mb": 30,
    "notice": "照片只用於製作本活動回顧 MV，將於 {delete_date} 自動刪除。上傳的照片只有主辦者看得到。",
    "max_photos": 5000
  },
  "mv": {"maker": "", "song": ""},
  "invite": {"title": "", "message": "", "card_updated_at": null, "card_ext": null, "card_auto": false},
  "checklist_done": {"basic": true, "schedule": false, "groups": false, "shots": false, "upload": false, "invite": false, "mv": false},
  "excluded": ["<hash>", "..."],
  "upload_code": "....",
  "admin_hash": "<sha256 hex>",
  "sync": {"key": "....", "hash": "<sha256 hex>", "created_at": "..."},
  "deleted_at": null
}
```

`invite`（分享預覽，缺少時讀取會補預設值）：
- `title`：預覽標題，≤40 字；空字串 = 自動（`basic.name`）。
- `message`：邀請文字，≤120 字；空字串 = 自動。兩者寫入前會把控制字元（含換行）換成空白並修剪。
- `card_updated_at`：預覽圖最後更新時間（ISO）；`null` = 尚無自訂卡片（使用預設圖）。
- `card_ext`：`png` | `jpg` | `null`，對應 R2 的 `og.{ext}`（伺服器維護，PATCH 不可改）。
- `card_auto`：`true` = 卡片是管理頁用「無照片」樣式自動產生的（基本資料改變時管理頁會自動重產）；`false` = 使用者自選封面照片。可由 PATCH 或 `PUT og-card?auto=` 設定。

自動邀請文字：`邀請你上傳【{活動名稱}】拍到的照片，我們會一起做成回顧 MV。` ＋ `{YYYY/MM/DD} {地點}`（空欄位省略）＋ `開放至 {M/D}`（有 `closes_at` 才有，以台灣時間 UTC+8 換算日期），日期地點與開放日之間以「・」相連；沒有任何附加資訊時就只有第一句。

### 衍生值（後端計算，回傳時附上，不存）
- `stage`：`planning`（尚未開放過且未到 opens_at）／`open`（目前可上傳）／`grace`（活動日之後、仍可上傳）／`closed`（已過 closes_at 或手動關閉）／`purged`（照片已刪除）。
  - 可上傳 `is_open` = `mode=="open"` 或（`mode=="auto"` 且 `opens_at` 有值且 `opens_at <= now < (closes_at ?? +∞)`）。`mode=="closed"` 永遠不可上傳。
  - `open` 與 `grace` 的差別：`now` 的日期 > `basic.date` 即 `grace`。
- `delete_at` = `closes_at + retention_days`；`closes_at` 為 null 時為 null（不自動刪）。
- `must_missing`：開放上傳前必填但未完成的項目 key 陣列。必填 = `upload`（`opens_at` 與 `notice` 皆有值才算完成）。
- 環節判斷 `segment_of(photo)`：`segment != "auto"` 且仍存在於 `segments` → 用它；否則取 `exif_time` 的 `HH:MM`，落在 `[start, end)` 的第一個環節；都沒有 → `null`（顯示為「未分類」）。

## 4. 共用：流程表解析（前後端與 Python 三處一致）

每行去頭尾空白後比對 `^(\d{1,2}):(\d{2})\s*[-–~～至到]\s*(\d{1,2}):(\d{2})\s+(.+)$`，時間補成兩位數 `HH:MM`。不符合的行忽略。名稱去除首尾標點與空白，截 20 字，重複名稱只保留第一個。
**多日活動（v4）**：不符合時段格式的行若是日期標題，就開始新的一天。標題寫法：有年份 `2026/11/20`、`2026-11-20`、`2026年11月20日`；沒年份只認 `11/20`、`11月20日`（年份取開始日期，早於開始日期 180 天以上時算下一年）；或 `Day 2`、`D2`、`第二天`（日期＝開始日期＋N−1，沒有開始日期時為 null）。可帶後綴（例如 `（六）`、`戶外日`，30 字內）。連續標題或標題前沒有環節時沿用同一天；第一個標題前的環節算第 1 天。
有環節的天數 ≥ 2 時，`name` 改為 `第N天・名稱`（去重以 `name` 計，同名環節各天分開），並多帶 `day`、`date`；只有一天時維持單日格式（`day`、`date` 為 null）。每個環節另帶 `title`（原名稱）。
環節判斷（`segmentOf`）：手動選的環節優先；否則找時段涵蓋拍攝時間的環節，若這些環節有 `date`，拍攝日期必須相同（不在任何活動日 → 未分類）；沒有日期而多天同時段 → 未分類。
`basic.end_date`：多日活動的最後一天（YYYY-MM-DD，需晚於 `date`、最長 60 天；等於 `date` 時存成 null）。改 `date` 時重新解析流程表。補傳期（grace）以「結束日期、開始日期、流程表各天日期」的最晚者判斷。`POST /api/create` 可帶 `end_date`。

拍攝清單自動產生：對每個環節若 `shots` 裡沒有同名項目就新增 `{segment, target: 8, tip: "", source: "auto"}`；環節被刪除時，`source=="auto"` 的對應項目一併刪除，`manual`/`mv` 保留。

## 5. API

### 5.1 公開
- `GET /api/health` → `{"ok":true,"version":"1"}`

### 5.2 建立活動
- `POST /api/create`（舊路徑 `/api/events` 仍可用；新路徑避開廣告阻擋清單），header `X-Create-Secret`，body `{"name": "...", "date": "YYYY-MM-DD" | null}`
  - name 必填，1–60 字。
  - 回 `201 {"event_id","admin_code","upload_code","admin_url":"/admin#e=..&k=..","upload_url":"/u/.."}`
  - 錯誤：`401 bad_create_secret`、`400 invalid`。

### 5.3 上傳頁（路徑中的 `{code}` = upload_code）
- `GET /api/u/{code}/info` → 
  ```json
  {"event":{"name","date","location","organizer"},
   "stage":"planning|open|grace|closed|purged","is_open":true,
   "opens_at","closes_at","delete_at","notice":"(已代入 {delete_date})","max_mb":30,
   "groups":[...], "segments":[{"start","end","name"}],
   "progress":{"total":812,"by_segment":[{"name","have","target"}],"unclassified":12},
   "device_count": 46}
  ```
  - `device_count` 只有帶 query `?device=<id>` 才計算。
  - 統計可快取 30 秒（Cache API 或 isolate 記憶體），上傳後不需即時。
  - 404 `not_found`（上傳碼不存在或活動已刪除）。
- `POST /api/u/{code}/check`，body `{"hashes":["..."]}`（≤200 個）→ `{"existing":["..."]}`
- `POST /api/u/{code}/photo`，`multipart/form-data`：
  - `photo`：檔案（必填；`image/jpeg|png|webp|heic|heif|gif`；大小 ≤ `max_mb`）
  - `thumb`：320px JPEG（選填；HEIC 無法在手機端解碼時可缺）
  - `meta`：JSON 字串，欄位同 §2 customMetadata（`hash` 必填、64 位 hex）
  - 回 `201 {"ok":true,"hash","duplicate":false}`；已存在回 `200 {"ok":true,"hash","duplicate":true}`（不覆寫）
  - 錯誤：`403 upload_closed`、`413 too_large`、`415 bad_type`、`400 invalid`、`409 event_full`（超過 max_photos）、`429 rate_limited`（同一 IP 每分鐘 > 120 次）

### 5.4 管理（`Authorization: Bearer {admin_code}`；路徑 `{id}` = event_id）
- `GET /api/admin/{id}` → `{"config": <config 去掉 admin_hash 與 sync.hash>, "stage","is_open","delete_at","must_missing","upload_url","invite_effective": {"title","message","image_url"},"stats": <見下>}`
  - `invite_effective`：實際生效的分享預覽內容（自訂值，留空則為自動值）；`image_url` 為絕對網址 `{origin}/og/{upload_code}?v={card_updated_at 或 config.updated_at 的毫秒時間戳}`。
  - `stats` = `{"total","bytes","uploaders": <不同 device 數>,"last_upload_at","excluded_count","by_segment":[{"name","have","target"}],"unclassified","by_group":[{"name","have"}],"recent":[{"hash","uploader","groups":[],"segment","exif_time","uploaded_at","excluded":bool,"has_thumb":bool}] /* 最新 24 張 */}`
- `PATCH /api/admin/{id}`，body 為部分 config：可改 `basic`、`schedule_text`、`groups`、`shots`、`upload`（不可改 `upload_code`）、`mv`、`invite`（只能改 `title`、`message`、`card_auto`）、`checklist_done`。後端：
  - 改 `schedule_text` 時重新解析 `segments` 並同步 auto 拍攝清單（§4）。
  - `groups` 去空白、去重、每個 ≤ 20 字、最多 30 個。
  - `upload.retention_days` 限 7–180；`max_mb` 限 5–50；`notice` ≤ 300 字。
  - `invite.title` ≤ 40 字、`invite.message` ≤ 120 字（超過 400）；去控制字元後修剪，留空 = 回到自動產生；`invite.card_auto` 為布林。
  - 回同 GET 的結構。
- `POST /api/admin/{id}/exclude`，body `{"hash","excluded":true|false}` → `{"ok":true,"excluded_count"}`
- `GET /api/admin/{id}/thumb/{hash}` → 縮圖 JPEG（無縮圖時回原圖）
- `GET /api/admin/{id}/photos?cursor=` → `{"photos":[同 recent 項目], "cursor": null|"..."}`（每頁 200，新到舊不保證，前端自行排序）
- `POST /api/admin/{id}/rotate-upload-code` → `{"upload_code","upload_url"}`（舊碼立即失效）
- `POST /api/admin/{id}/sync-key` → `{"sync_key","sync_url"}`（產生或重發；舊金鑰立即失效）。`sync_url` = `{origin}/api/sync/{id}`
- `PUT /api/admin/{id}/og-card[?auto=1|0]`：body 為原始位元組，`Content-Type` 必須是 `image/png` 或 `image/jpeg`（可帶參數），最大 1.5MB（串流計數，不信任 Content-Length），並檢查檔頭魔術字串。寫入 `events/{id}/og.png`（或 `og.jpg`，換格式時刪除另一個），更新 `invite.card_updated_at` 與 `invite.card_ext`；有帶 `auto` 時同時設定 `invite.card_auto`。回應同 `GET /api/admin/{id}`。錯誤：`415 bad_type`（MIME 或內容不符）、`413 too_large`、`400 invalid`、`409 purged`（活動照片已刪除）、`409 conflict`。
- `POST /api/admin/{id}/purge` body `{"confirm":"刪除"}` → 刪除所有 `p/`、`t/` 與預覽圖 `og.*` 物件，`deleted_at` 設為現在 → `{"ok":true,"deleted": n}`
- 錯誤：`401 unauthorized`、`404 not_found`

### 5.5 同步（`Authorization: Bearer {sync_key}`）
- `GET /api/sync/{id}/manifest?cursor=` → 
  ```json
  {"event":{"id","name","date","location","organizer"},
   "segments":[...],"groups":[...],"shots":[...],"excluded":[...],
   "photos":[{"hash","ext","size","uploader","device","groups":[],"segment":"<manual 名稱或 auto>","exif_time","time_src","w","h","uploaded_at","original":bool}],
   "cursor": null|"..."}
  ```
  （每頁 ≤ 1000；不含已排除照片）
- `GET /api/sync/{id}/photo/{hash}` → 照片原始位元組，`Content-Type` 依副檔名，`ETag` = hash
- `POST /api/sync/{id}/requirements`，body `{"requirements":{"<主題名>":{"photos_needed":n}}}` → 對名稱與環節相同者，把 `shots[].target` 改成 `photos_needed` 並設 `source:"mv"`；回 `{"ok":true,"updated":n}`

### 5.6 分享預覽（公開，無需金鑰）
- `GET /og/{upload_code}`：有自訂卡片回卡片（`image/png` 或 `image/jpeg`）；沒有卡片、上傳碼格式錯誤／不存在／已更換、活動已刪除，一律回預設圖 `public/assets/og-default.png`（1200×630）。`Cache-Control: public, max-age=300`；`?v=` 只用來讓 LINE 等快取失效，伺服器忽略。
- `GET /u/{upload_code}`：回 `upload.html`，並用 HTMLRewriter 只改 `<head>` 內既有 meta 的 content：`<title>` = `{title}｜照片募集`；`description`；`og:type`=`website`、`og:site_name`=`活動照片募集`、`og:title`=`{title}`、`og:description`=`{message}`、`og:url`=`{origin}/u/{code}`；`og:image`=`invite_effective.image_url`、`og:image:width`=1200、`og:image:height`=630、`og:image:alt`；`twitter:card`=`summary_large_image`。
  - 活動不存在、已換碼、已刪除（`deleted_at` 有值）時一律用通用文字（標題「活動照片募集」、說明「請使用主辦者提供的連結，上傳你在活動中拍到的照片。」、預設圖），不洩露任何活動資訊。
  - 頁面初始 body 只有簡短說明；訊息、選擇、上傳中、完成等畫面放在 `<template id="tpl-views">`，由 `upload.js` 啟動時載入。

### 5.7 排程（Cron，每天 03:17 UTC）
- 掃描 `events/*/config.json`：`delete_at` 已過且 `deleted_at` 為 null 者，刪除 `p/`、`t/`，設定 `deleted_at`，並刪除 `codes/u/{upload_code}`（上傳連結失效）。config 保留（顯示「已封存」）。

## 6. 安全規則（實作必須遵守）
- 所有 key 比對用常數時間；任何 `{hash}` 參數必須符合 `^[0-9a-f]{64}$`，`{id}` 必須符合 `^ev_[A-Za-z0-9_-]{12}$`，否則 400。
- 上傳只信任白名單 MIME，副檔名由 MIME 決定（不採用使用者檔名）。
- 管理 API 與同步 API 不設 CORS（同源使用）；上傳 API 同源。`OPTIONS` 一律 204 無 CORS 標頭。
- 回應加 `Cache-Control: no-store`（縮圖與照片除外：`private, max-age=3600`）。
- 靜態頁加 CSP：`default-src 'self'; img-src 'self' blob: data:; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`。

## 7. 實作備註（Worker 後端已落實的解讀，非合約變更）
- 照片物件 customMetadata 額外有伺服器寫入的 `thumb`（`1` 表示有縮圖），供 `has_thumb` 使用，不必逐張 head `t/`。
- 統計的 `total`、`bytes`、`uploaders`、`by_segment`、`by_group`、`unclassified`（含上傳頁 `progress`）**不含已排除照片**；`excluded_count` 為「實際存在且被排除」的張數；`recent` 與 `photos` 仍包含已排除項目並以 `excluded` 標示。`device_count` 含已排除照片。
- `recent[].segment`、`photos[].segment` 為依 `segment_of` 算出的生效環節名稱（`null`＝未分類），manifest 的 `segment` 則維持原始值（手動名稱或 `auto`）。
- `by_segment[].target` = 同名環節所有 `shots[].target` 加總。
- `purge` 回傳的 `deleted` 為刪除的照片張數（`p/`），不含縮圖。手動 purge 不刪 `codes/u/`（上傳頁顯示 `purged`）；排程清除才刪上傳碼索引。
- `mode=="open"` 依 §3 公式不受 `closes_at` 限制；`grace` 以 UTC 日期與 `basic.date` 比較。`{delete_date}` 以 `closes_at` 自身的時區計算本地日期。
- `opens_at` / `closes_at` 必須是帶時區的 ISO 字串（否則 400）。
- 管理 API 檢查順序：`id` 格式（400）→ 缺 Bearer（401）→ 活動不存在（404）→ 金鑰錯誤（401）。同步被排除的照片（`/sync/{id}/photo/{hash}`）回 404。
- 管理與同步 API 的 `Cache-Control: no-store`；照片 `private, max-age=3600` 並加 `Content-Security-Policy: default-src 'none'; sandbox`。
- 設定檔寫入使用 R2 etag 條件寫入（樂觀鎖）：衝突時重新讀取、重新驗證金鑰後重試，最多 4 次；仍衝突則管理與同步 API 回 `409 conflict`（前端顯示「其他人同時在修改，請重新整理」）。
- purge 先設定 `deleted_at` 再刪檔；上傳寫入後若發現活動已刪除，會收回剛寫入的照片並回 `403`；排程也會補掃已刪除活動殘留的 `p/`、`t/`。
- 上傳 body 以串流計數：超過 `max_mb + 2MB`（照片）或 1MB（JSON）即中斷回 `413`，不依賴 `Content-Length`。
- 上傳 meta 會淨化：`groups` 只保留活動設定中存在的小隊、`segment` 只接受 `auto` 或既有環節名稱、文字欄位移除換行與控制字元（這些字串最後會交給使用者的 AI 讀取，避免夾帶指令）。
- 分享預覽：`og.*` 與 config 分開寫入（先寫圖、再用樂觀鎖更新 `invite`）；`purgePhotos` 一併刪除 `og.png`／`og.jpg`（手動 purge、排程清除、已刪除活動的補刪都會走到）。
- CSP 另含 `form-action 'self'`。`/u/`（無上傳碼）也回上傳頁外殼，由前端導向最後一次使用的上傳碼。

### Google 登入（§8）的實作備註
- **檔案**：`src/session.js`（cookie 簽發／驗證、CSRF）、`src/auth-google.js`（ID token 與 JWKS）、`src/account.js`（users／shares、/api/me、成員、認領、上傳記錄、`CREATOR_EMAILS`）、`src/store.js`（`updateJson`：etag 樂觀鎖的 JSON 讀改寫）、`src/auth.js` 的 `requireRole(env, req, id, minRole)`（所有管理 API 的唯一授權入口）。
- **啟用條件**：`GOOGLE_CLIENT_ID` 去除空白後非空，**且** `SESSION_SECRET` ≥ 32 字元；否則 `/api/auth/config` 回 `{"google_client_id":null}`、`POST /api/auth/google` 回 `404 not_found`、cookie 一律視為無效、CSP 維持 §6 原樣。空字串＝未設定。
- **Cookie**：名稱 `mvs`，值 `base64url(JSON{sub,email,name,picture,exp}).base64url(HMAC-SHA256)`；`exp` 為 Unix **秒**（簽發後 30 天）；簽章用常數時間比較；無狀態，登出只清 cookie（無法使已發出的 cookie 提前失效，要全部失效請更換 `SESSION_SECRET`）。屬性 `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`，https 才加 `Secure`。
- **ID token 錯誤碼**：`401 invalid_token`（格式、alg 非 RS256、kid 不明、簽章、aud、iss、過期、缺 sub／email）、`401 email_unverified`（`email_verified` 不是 `true`）、`503 auth_unavailable`（連不到 Google 且沒有任何快取金鑰）。`exp` 容許 60 秒時差；`email_verified` 接受布林 `true` 或字串 `"true"`。
- **JWKS**：isolate 記憶體快取，依 `Cache-Control: max-age`（夾在 60 秒～24 小時；沒有就 1 小時）；遇到不認得的 `kid` 且距上次抓取超過 60 秒才會重抓一次；重抓失敗沿用舊快取。`DEV_TEST_JWKS` 只在請求 hostname 為 `localhost`／`127.0.0.1` 時採用，且只用來找 `kid` 相符的金鑰（找不到仍照常向 Google 取）。
- **CSRF**：使用 cookie 身分的非 GET／HEAD／OPTIONS 請求要求 `Origin` 與請求網址同源，否則 `403 bad_origin`（管理 API、`/api/create`、`claim`、`/api/me/*` 的 DELETE、已登入的 `logout`）。`POST /api/auth/google` 沒有 cookie 身分，只在「有帶 Origin 且不同源」時回 403。**上傳 API 例外**：`/api/u/{code}/photo` 只在 Origin 同源時才採用 cookie 做上傳記錄，否則當匿名處理（上傳本身照常，不回 403），避免影響既有上傳流程。
- **角色判斷**：有 `Authorization: Bearer` 就只看管理碼（錯誤即 `401`，不退回 cookie）。cookie 路徑順序：無有效登入 `401` → Origin 不符 `403 bad_origin` → 活動不存在 `404` → 非 owner／成員 `403 forbidden` → 角色不足 `403 forbidden`。`owner` 以 `sub` 比對，成員以小寫 Email 比對。最低角色：讀取（`GET` 管理／縮圖／photos／members）viewer；`PATCH`、`exclude`、`og-card`、`sync-key` manager；`rotate-upload-code`、`purge`、成員新增／移除 owner。
- **viewer**：回應 `config.sync` 仍在，但沒有 `key`（也沒有 `hash`）。`config.owner` 含 `sub`（Google 的穩定識別碼，不是機密）。舊活動讀取時補 `owner:null`、`members:[]`。
- **成員**：Email 轉小寫儲存；`POST members` 成功回 `200 {"owner":{"email"}|null,"members":[{email,role,added_by,added_at}]}`（新增與改角色同一回應格式）；擁有者自己／格式錯誤／role 不是 manager|viewer／第 21 位 → `400 invalid`；`DELETE` 不存在的成員 `404 not_found`。管理碼（無登入）也能管理成員，此時 `added_by` 為擁有者 Email（無擁有者則為 `(管理碼)`）。
- **索引寫入順序**：新增成員先寫 `shares/{hash}` 再寫 config（config 才是權威）；移除成員先改 config（權限立即撤銷）再清 `shares`。`/api/me` 以 config 的 `owner`／`members` 為準，索引殘留或活動不存在時略過並順手清掉；暫時讀不到的活動（R2 錯誤）不顯示也不清。
- **`/api/me`**：`user.can_create` 是有效值＝`users/{sub}.json` 的旗標 **或** Email 符合 `CREATOR_EMAILS`。`events`／`shared` 的 `stage` 為 §3 衍生值。`uploads[].valid` ＝ 活動存在、未被刪除（`deleted_at`）且 config 的 `upload_code` 等於記錄的碼（手動 purge 後也是 `false`）。`uploads[].name` 優先用活動目前名稱。一個活動若同時是自己的與分享的，只列在 `events`。
- **`POST /api/create`**：已登入時一律檢查 Origin；無論用密碼或名單建立，`owner` 都是目前使用者；加入 `users/{sub}.events` 若失敗只記 log（活動仍建立成功、回應仍有 `admin_code`，可事後 `claim` 補上）。帶了正確密碼才會永久寫入 `can_create:true`（名單資格不寫入）。資格不足一律 `401 bad_create_secret`。`CREATOR_EMAILS` 以逗號、分號或空白分隔，不分大小寫；`@網域` 只比對該網域本身，不含子網域。
- **`claim`**：回 `200 {"ok":true,"event_id","owner":{"email"}}`；已是自己的活動重複認領為 `200`（並補上索引）；認領者原本若是該活動成員，會同時移出 `members` 與 `shares`。`401` 於缺 Bearer、缺登入或管理碼錯誤；順序為 id 格式 → 缺憑證 401 → Origin 403 → 活動不存在 404 → 管理碼 401 → `409 has_owner`。
- **上傳記錄**：重複上傳（`duplicate:true`）也算一次 `count`；`/api/me` 的 `uploads` 最多 100 筆、新到舊；以 `updateJson` 重試（最多 8 次）處理同一人並行上傳。寫入任何一步失敗只記 log，不影響上傳回應。`info.me` 的 `count` 來自 `users.uploads`，使用者移除記錄後歸零。
- **`DELETE /api/me/events/{id}`、`/api/me/uploads/{id}`**：需登入＋同源 Origin；活動編號格式不符 `400`；不存在的項目也回 `200 {"ok":true}`（冪等）。移除 `events` 只是從自己的清單拿掉，config 的 `owner` 不變，仍可用 cookie 管理，也能再次 `claim`／建立時重新加入。分享給你的活動（`shared`）由擁有者管理，不能自行移除。
- **CSP（§8.8）**：只在啟用登入時，`/`、`/admin`、`/u/*` 使用含 Google 網域的 CSP；`/download` 與其他頁維持 §6。`img-src` 另開放 `https://lh3.googleusercontent.com` 以顯示 Google 大頭貼。`DEV_TEST_JWKS` 需同時 `DEV_MODE=1` 才生效。

## 8. Google 帳號登入（v2，選用功能）

未設定 `GOOGLE_CLIENT_ID` 時整個功能隱藏，所有既有行為不變（管理碼、上傳碼、同步金鑰照常可用）。

### 8.1 部署設定
| 名稱 | 種類 | 說明 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | `[vars]` | Google Cloud Console 建立的 OAuth 用戶端 ID（網頁應用程式），「已授權的 JavaScript 來源」填 Worker 網址 |
| `SESSION_SECRET` | secret | 簽發登入 cookie 用，≥32 字元隨機字串 |
| `CREATOR_EMAILS` | `[vars]`，選填 | 逗號分隔 Email 或 `@網域`，名單內的人免建立密碼即可建立活動 |
| `DEV_TEST_JWKS` | 只放 `.dev.vars` | 本機測試用的 JWK Set（JSON 字串）。**只有請求 host 為 localhost/127.0.0.1 時才採用**，否則忽略 |

### 8.2 登入流程
1. 前端 `GET /api/auth/config` → `{"google_client_id": "..."|null}`；有值才載入 `https://accounts.google.com/gsi/client` 並顯示「使用 Google 登入」按鈕。
2. 使用者登入後前端拿到 ID token（JWT），`POST /api/auth/google` body `{"credential": "<jwt>"}`。
3. 後端驗證：RS256 簽章（金鑰取自 `https://www.googleapis.com/oauth2/v3/certs`，依 `Cache-Control` 快取；本機可用 `DEV_TEST_JWKS`）、`aud == GOOGLE_CLIENT_ID`、`iss ∈ {accounts.google.com, https://accounts.google.com}`、`exp > now`（容許 60 秒時差）、`email_verified == true`。
4. 通過後建立或更新 `users/{sub}.json`，回 `Set-Cookie: mvs=<payload>.<hmac>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`（本機 http 時不加 Secure）。payload = base64url(JSON `{sub,email,name,picture,exp}`)，HMAC-SHA256 用 `SESSION_SECRET`。回 `{"user": {...}}`。
5. `GET /api/me` → 未登入 `{"user": null}`；已登入 `{"user":{sub,email,name,picture,can_create}, "events":[...], "shared":[...], "uploads":[...]}`（見 8.4）。
6. `POST /api/auth/logout` → 清除 cookie。

### 8.3 CSRF 防護
cookie 驗證的請求（非 GET）必須帶 `Origin` 且與請求網址同源，否則 `403 bad_origin`。Bearer 金鑰的請求不受影響。

### 8.4 R2 物件
```
users/{sub}.json            {"sub","email","name","picture","created_at","last_login_at","can_create":bool,
                             "events":[{"event_id","added_at"}],             // 自己建立或認領的活動（owner）
                             "uploads":[{"event_id","upload_code","name","count","last_at"}]}  // 曾上傳的活動，最多 100 筆，新到舊
shares/{sha256(lower(email))}.json   {"events":[{"event_id","role","added_at","added_by"}]}   // 別人分享給這個 Email 的活動
```
`GET /api/me` 回傳時把 `events` 與 `shared` 展開成 `{event_id, name, date, stage, role}`（讀各活動 config；活動已不存在就略過並順手清掉索引）。`uploads` 回傳 `{event_id, name, upload_url, count, last_at, valid}`（`valid` = 上傳碼仍有效）。

### 8.5 config 新增欄位
```json
"owner": {"sub": "...", "email": "..."} | null,
"members": [{"email": "a@b.com", "role": "manager|viewer", "added_by": "owner@x.com", "added_at": "..."}]
```

### 8.6 角色與權限
| 動作 | owner | manager | viewer | 管理碼（舊） |
|---|---|---|---|---|
| 讀取活動、進度、縮圖、照片清單 | ✓ | ✓ | ✓ | ✓ |
| PATCH 設定、排除照片、上傳預覽卡、產生/重發同步金鑰 | ✓ | ✓ | — | ✓ |
| 更換上傳碼、刪除所有照片 | ✓ | — | — | ✓ |
| 管理成員（新增、改角色、移除） | ✓ | — | — | ✓ |
| 看到同步金鑰明碼 | ✓ | ✓ | — | ✓ |

管理 API 驗證順序：有 `Authorization: Bearer` → 依管理碼（舊行為，視為 owner 權限）；否則用 cookie 的使用者：`sub == owner.sub` → owner；`email` 在 `members` → 該角色；都不是 → `403 forbidden`（未登入 `401 unauthorized`）。權限不足 → `403 forbidden`。
`GET /api/admin/{id}` 回應多 `"role": "owner|manager|viewer"`、`"auth": "key|account"`；viewer 時回應中的 `config.sync.key` 必須移除。

### 8.7 新增 API
- `POST /api/create`：已登入時，若 `can_create`、或 Email 符合 `CREATOR_EMAILS`，可不帶 `X-Create-Secret`；帶了正確密碼則把 `can_create` 設為 true。已登入建立的活動 `owner` = 該使用者，並加入 `users/{sub}.events`。未登入行為不變。回應仍含 `admin_code`（給沒登入的備援與舊流程）。
- `POST /api/admin/{id}/claim`（需 Bearer 管理碼＋登入 cookie）：活動 `owner` 為 null 時設為目前使用者並加入其 `events`；已有 owner 且不是自己 → `409 has_owner`。
- `GET /api/admin/{id}/members`（owner/manager/viewer 皆可讀）→ `{"owner": {email}, "members": [...]}`
- `POST /api/admin/{id}/members` body `{"email","role"}`（owner）→ 新增或改角色，並寫入 `shares/{hash}`；Email 格式驗證，最多 20 位；不可加 owner 自己。
- `DELETE /api/admin/{id}/members/{email-urlencoded}`（owner）→ 移除並更新 `shares/{hash}`。
- `DELETE /api/me/events/{id}`、`DELETE /api/me/uploads/{id}`：從自己的清單移除（不影響活動本身）。
- 上傳記錄：`POST /api/u/{code}/photo` 若帶有效 cookie，成功（含 duplicate）後更新該使用者 `uploads`（同活動合併，`count` 加 1、`last_at` 更新、`upload_code` 更新為目前碼）。寫入失敗不影響上傳結果。上傳照片的 customMetadata 記錄 `sub`（v3 起，只用於「我上傳的照片」權限判斷，任何 API 都不回傳）。
- `GET /api/u/{code}/info` 若已登入，多回 `"me": {"name","email","count": 此帳號在本活動累計}`。

### 8.8 CSP 調整
有登入功能的頁面（`/`、`/admin`、`/u/*`）CSP 增加：`script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; style-src` 再加 `https://accounts.google.com/gsi/style`。


## 9. 我上傳的照片與參與者相簿（v3）

### 9.1 身分
- 上傳者：`x-device` 標頭（上傳頁 localStorage `mv.device`，16–64 字 `[A-Za-z0-9_-]`；圖片網址用 `?d=`），或上傳時登入的 Google 帳號（照片 metadata `sub`）。任一符合即為該照片的上傳者。只靠 cookie 的修改請求須同源。
- 相簿參與者：登入者 `g_{sub}`；未登入者 `d_{sha256(裝置碼)[0:32]}`，投票前須設定暱稱（1–24 字）。

### 9.2 我上傳的照片 `/api/u/{code}/mine`
| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/mine` | `{event, editable, closes_at, groups, segments, album_url, login, photos:[{hash, groups, segment, segment_effective, note, exif_time, uploaded_at, edited_at, replaced, excluded, has_thumb, votes, priority}]}` |
| GET | `/mine/{hash}/thumb?d=` | 自己的縮圖（無縮圖時回原檔） |
| PATCH | `/mine/{hash}` | `{groups?, segment?, note?}`；需開放上傳中、未被排除 → 403 `upload_closed`／`excluded` |
| DELETE | `/mine/{hash}` | 隨時可刪（含已排除）；hash 進 `removed` |
| POST | `/mine/{hash}/replace` | multipart 同上傳；沿用小隊、環節、備註、上傳者；新 hash 已存在 → 409 `duplicate`；舊 hash 進 `removed`，相簿票數歸零、MV 優先取消、相簿精選改指新照片 |

### 9.3 參與者相簿 `/api/a/{code}`（相簿碼與上傳碼分開；相簿關閉或活動刪除 → 404）
| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/info` | `{event, album:{limit, show_votes, votes_visible, closes_at, voting_open, allow_download, access}, segments, me:{kind, name, needs_name, picks, self, optouts}, login, photos:[{hash, segment, uploader, exif_time, mine, has_thumb, viewable, votes?}], key?}` |
| POST | `/me` | `{name}` 設定暱稱 |
| POST | `/vote` | `{hash, on, name?}`；自己拍的進 `self`、不佔名額；超過上限 409 `limit_reached`；截止 403 `voting_closed`；沒暱稱 400 `name_required` |
| POST | `/optout` | `{hash}` 回報不想入鏡（每人最多 10 件），照片先隱藏 |
| GET | `/thumb/{hash}`、`/photo/{hash}[?download=1]` | 圖片；下載需 `allow_download` |

存取：`access=google` 未登入 → 401 `login_required`；`access=password` 以 `x-album-pass`（明碼）換得 `key`，之後用 `x-album-key` 標頭或 `?k=`；錯誤 → 401 `album_password`。

### 9.4 主辦者
- `PATCH /api/admin/{id}` 新增 `album: {enabled, source:'all'|'picked', access:'link'|'google'|'password', password, limit 1–50, show_votes:'live'|'after'|'never', closes_at, allow_download}`；第一次 `enabled:true` 時產生相簿碼；回應多 `album_url`，`config.album` 以 `has_password` 取代密碼雜湊。
- `GET /api/admin/{id}/album`（viewer）：設定、`stats{voters, google_voters, total_votes, self_votes, photos_in_album, hidden, eligible}`、`ranking[{hash, segment, uploader, exif_time, votes, self, priority, picked}]`、`optouts`、`mv_priority`、`album_picked`。
- `POST /api/admin/{id}/album/code`（重設相簿連結）、`/album/optout {hash, action:'exclude'|'keep'}`、`/album/priority {hashes, on}` 或 `{top_per_segment:N}`、`/album/pick {hashes, on}`（manager）。

### 9.5 同步
- `manifest.photos[]` 多 `note`、`edited_at`、`priority`、`votes`（不含攝影者自選）；`excluded` 合併 `removed`（舊版 mvctl 也會把刪除／更換掉的照片移到 `_excluded/`），另回 `removed`。
- 頁面：`/u/{code}/mine`（我上傳的照片）、`/a/{code}`（相簿，分享預覽改寫 meta）、`/og/a/{code}`（相簿預覽圖，沿用活動卡片；非「知道連結」的相簿一律回預設圖與通用文字）。


## 10. 輪站課程（v5）
- `PATCH /api/admin/{id}` 新增 `rotations: [{ id?, title, day: 第N天|null, slots: [{start,end}], stations: [{name, place}], rows: [{ group, cells: [關卡索引 | -1 輪空] }], bye_mode: 'free'|'skip' }]`（最多 6 區塊；時段 1–12 依序不重疊；關卡 1–12、名稱不重複且不可叫「自由活動」；小隊需存在於 `groups`，不存在的列略過；每列格數＝時段數）。
- 每個關卡展開成 `segments` 裡的環節：`{name, title, start, end, day, date, kind: 'station', rotation, place}`；有輪空且 `bye_mode='free'` 時多一個 `kind: 'free'` 的「自由活動」。多日活動（`day` 有值）名稱加「第N天・」。拍攝清單自動各一項（自由活動目標 3 張）。
- 環節判斷：手動選的環節優先；拍攝時間在輪站時段內時，依照片的小隊查輪站表（每段涵蓋「本段開始～下一段開始」，換站時間算前一段）。只勾一隊或多隊同一關 → 該關卡；輪空 → 自由活動（skip 模式為未分類）；沒勾小隊或多隊不同關 → 退回一般時段環節（例如流程表的「輪站時間」整段），沒有則未分類。
- 守在某一關的攝影師：上傳（或在「我上傳的照片」改環節）時選了關卡、沒勾小隊 → 伺服器依時段反推小隊並寫入 `groups`。
- `GET /api/u/{code}/info`、`/mine`、同步 `manifest` 多 `rotations`（`stations[].segment`、`rows`、`date`、`free_segment`）。
- 管理統計 `stats.rotations[]`：`{groups, stations, slots, rows, counts[g][s], free[g], pending, unknown_group, bye_mode}`。
- **時段取自流程表（v5.1）**：`slots[].seg` 可填流程表環節名稱。儲存與每次流程表變動時，該段時間依流程表更新（流程表刪掉該環節則沿用上次時間）；被選用的流程環節標記 `rotation_slot: 輪站 id`，保留為「判斷不了是哪一關」的收容環節，但不產生自動拍攝清單，上傳頁與「我上傳的照片」不單獨列出，本地 MV Studio 不建立成主題。
- **跨日輪站（v5.2）**：`slots[].day` 可讓每一段在不同天（例如第 1 天下午兩段、第 2 天上午一段），需依「天、開始時間」排列。全部時段同一天時區塊 `day` 為那天、關卡名稱加「第N天・」；跨日時區塊 `day` 為 null、關卡名稱不加前綴（跨天共用同一個課程主題），環節多帶 `days`。照片依拍攝日期找到那一天的時段；換站時間只在同一天內延續。`rotations` 的 `slots[]` 回傳時帶 `day`、`date`，另有 `days`。


## 11. 貼共用連結匯入（v6）

上傳碼驗證、需 `is_open` 且 `upload.import_enabled !== false`；速率限制與上傳共用。`info` 多回 `import`（是否開放）、`import_drive`（伺服器有 `GOOGLE_API_KEY`）。

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/u/{code}/import/list` | `{url}` → `{aid, source:'gphotos'|'gdrive', title, count, truncated, daily_limit, daily_left, items:[{uid, w, h, taken, name, have}]}` |
| GET | `/api/u/{code}/import/thumb/{aid}/{uid}` | 代理 320px 預覽（只限清單內項目） |
| POST | `/api/u/{code}/import/photo` | `{aid, uid, original?, uploader?, device?, groups?, segment?}` → `201 {ok, hash, duplicate:false, segment, taken}`；已有 → `200 {duplicate:true, hash}` |

- 支援連結：`photos.app.goo.gl/…`、`goo.gl/photos/…`、`photos.google.com/share/…`；`drive.google.com/drive/folders/{id}`（可含 `resourcekey`）、`/file/d/{id}`、`/open?id=`。
- `uid`：`gp:{相簿項目 id}`／`gd:{雲端硬碟檔案 id}`，寫進照片 metadata `src`（`parsePhoto().src`）。
- 錯誤碼：`bad_source` 400、`album_not_public`／`drive_not_public`／`album_empty`／`short_link_unresolved` 422、`album_not_found` 404、`album_parse_failed`／`source_fetch_failed` 502、`source_timeout` 504、`drive_disabled` 503、`import_disabled` 403、`import_daily_limit` 429、`list_expired` 410、`source_gone` 410。
- 設定：`upload.import_enabled`（預設 true）、`upload.import_daily`（預設 1500，0–5000）。
- 環境：secret `GOOGLE_API_KEY`（雲端硬碟用，建議在 Google Cloud 限制只能呼叫 Drive API）；`IMPORT_TZ_OFFSET_MIN`（預設 480）；本機測試 `DEV_MODE=1`＋`IMPORT_TEST_ORIGIN` 把 Google 網域導向假伺服器。

## 12. 匯出到 Google 相簿（v7）

需要 `GOOGLE_CLIENT_ID`、`SESSION_SECRET`（≥32）與 `GOOGLE_CLIENT_SECRET`；缺任何一個時 `enabled=false`，connect／sync 回 404 `gphotos_disabled`。

| 方法與路徑 | 權限 | 說明 |
|---|---|---|
| `GET /api/admin/{id}/gphotos` | viewer | 狀態：`enabled, connected, need_reconnect, account_email, album_title, album_url, share_url, auto, connected_at, connected_by, last_sync_at, last_error, syncing, eligible, synced, remaining, failed, failed_list[{hash,msg}]` |
| `POST /api/admin/{id}/gphotos/connect` | manager | 回 `{auth_url, redirect_uri}`，並設 `gpn` nonce cookie（HttpOnly、Path=/oauth/gphotos/callback、10 分鐘） |
| `GET /oauth/gphotos/callback?code&state` | — | 驗 state（HMAC、10 分鐘）＋ nonce cookie → 換 token → 檢查 appendonly 範圍與 refresh token → 沿用（albums.get 可讀）或建立相簿 → 302 `/admin#e={id}&gp=ok[&reused=1]`；失敗 `gp=denied` 或 `gp=err&why=state|nonce|code|event|token|scope|refresh|album|disabled` |
| `PATCH /api/admin/{id}/gphotos` | manager | `{share_url?, auto?}`；share_url 限 `https://photos.app.goo.gl/…`、`https://photos.google.com/share/…` 或空字串 |
| `POST /api/admin/{id}/gphotos/sync` | manager | `{limit?=8 (1–15), retry_failed?}` 同步一批，回 `{added, failed_now, ...狀態}`；前端重複呼叫直到 `remaining=0` |
| `POST /api/admin/{id}/gphotos/disconnect` | manager | 撤銷 refresh token；相簿與同步紀錄保留 |
| `GET /api/admin/{id}/original/{hash}` | manager | 原圖（attachment），給「下載全部照片」備援 |

錯誤碼：`gphotos_not_connected`(409)、`gphotos_reconnect`(409，refresh token 失效)、`gphotos_busy`(409，另一個同步進行中；鎖 90 秒)、`gphotos_album_unavailable`(409，相簿被刪)、`gphotos_rate_limited`(429)、`gphotos_token_failed`/`gphotos_batch_failed`/`gphotos_fetch_failed`(502)、`gphotos_timeout`(504)。

同步規則：排除（excluded）與上傳者刪除（removed）的照片不同步；依上傳時間由舊到新；同一張失敗 3 次後不再自動重試（`retry_failed` 清除）。
排程：`47 * * * *` 對 `gphotos/auto/{id}` 列出的活動同步，每次合計最多 30 張、每活動 10 張。排程刪除活動時撤銷授權並刪除 `events/{id}/gphotos.json`。
`GET /api/admin/{id}/photos` 的每張照片多了 `ext`、`size`。
