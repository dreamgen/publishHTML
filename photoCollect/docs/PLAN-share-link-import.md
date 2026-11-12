# 規劃：上傳頁「貼共用連結匯入」Google 相簿／Google 雲端硬碟（2026-11-12）

參考：PPTPlayer-V2 `backend/src/services/googlePhotosAlbum.js`、`routes/googlePhotos.js`、`frontend/src/services/googlePhotosMulti.js`。

## 1. 參考專案的做法（Google 相簿）
- 解析公開分享頁（非官方）：`photos.app.goo.gl/…` → `photos.google.com/share/…?key=…`；短網址要加 `?_imcp=1` 才會 302（2026-10-21 實測）。
- 分享頁 HTML 的 `AF_initDataCallback({key:'ds:1', data})`：`data[1]` 照片（uid、baseUrl、寬、高、拍攝時間 ms、加入時間）、`data[2]` 下一頁 token、`data[3]` 相簿 id／標題；下一頁用 batchexecute RPC `snAcKc`。
- baseUrl（`lh3.googleusercontent.com/pw/…`）不會過期，只要相簿維持公開；`=w{W}-h{H}` 縮放、`=d` 原圖。
- 防護：只接受 Google 相簿網域並逐跳檢查轉址（防 SSRF）、逾時 20 秒、最多 10 頁／1000 張、清單快取 10 分鐘、uid 去重、略過影片、錯誤一律帶代碼（不是公開、找不到、格式變更…）、縮圖代理與每日用量上限。
- 參考專案沒有雲端硬碟資料夾匯入。

## 2. MV 雲端的做法（Cloudflare Worker）
### Google 相簿連結
- `POST /api/u/{code}/import/list {url}`：Worker 依上面方式解析，回傳相簿標題與照片清單 `{uid, w, h, taken_at}`；baseUrl 不給前端，以清單快取（isolate 10 分鐘＋R2 `events/{id}/imports/{hash}.json` 1 天）對應。
- `GET /api/u/{code}/import/thumb?a=&uid=`：代理 `=w320-h320` 縮圖（只限清單內的照片）。
- `POST /api/u/{code}/import/photo {a, uid, groups?, segment?, uploader?, device}`：每次一張；Worker 取 `=w2560-h2560`（勾「原圖」改 `=d`）寫入 R2，縮圖再取 `=w320-h320`；拍攝時間用清單的 taken_at（換成活動當地時間，預設 UTC+8）；以 `gp:{uid}` 與內容雜湊雙重去重。前端並行 3 張、顯示進度、佇列存 IndexedDB 可續傳。
### Google 雲端硬碟資料夾連結（新增，需 API 金鑰）
- 只接受「知道連結的任何人都能檢視」的資料夾或檔案連結（`drive.google.com/drive/folders/{id}`、`/file/d/{id}`，含 `resourcekey`）。
- Worker 用 Drive API v3＋伺服器端 API 金鑰：`files.list q="'{id}' in parents and mimeType contains 'image/'"`（含子資料夾一層）、欄位 `id,name,mimeType,size,imageMediaMetadata(time,width,height),thumbnailLink`；下載 `files.get?alt=media`；拍攝時間用 EXIF `imageMediaMetadata.time`。
- 不需要使用者登入 Google、不需要 OAuth 審查；需要在 Google Cloud 專案建立只限 Drive API 的金鑰（Worker secret `GOOGLE_API_KEY`）。

## 3. 上傳頁 UX
- 快速上傳大按鈕下方：「貼 Google 相簿／雲端硬碟連結匯入」。分批分類上傳也有。
- 貼上連結（可多個，一行一個）→ 顯示相簿／資料夾、張數、拍攝期間 → 縮圖格（預設全選，可取消；已上傳過的標「已有」）→「匯入 N 張」→ 沿用上傳畫面（進度、依拍攝時間分組補小隊）。
- 教學小卡：Google 相簿「分享 → 建立連結」；雲端硬碟「共用 → 一般存取權：知道連結的任何人」。
- 管理頁可關閉匯入、設定每活動每日匯入上限（預設 1,500 張）。

## 4. 風險
- Google 相簿分享頁是非官方格式，Google 改版就會失效 → 錯誤代碼＋提示改用手機直接上傳；解析器獨立模組、加回歸測試（保存一份樣本 HTML）。
- 雲端硬碟大量下載可能遇到配額或 403（每日用量）→ 失敗可重試、顯示原因。
- Worker 每次請求的子請求數與時間有限 → 一張一個請求、清單分頁。
- 被拿來當代理抓任意網址 → 網域白名單、只抓清單內項目、上傳碼驗證、速率限制。

## 5. 分段
1. 相簿解析器移植（Worker 版，原生 fetch／無 Buffer）＋樣本 HTML 測試。
2. 匯入 API（清單、縮圖、單張匯入、去重、上限）＋e2e 測試。
3. 上傳頁匯入流程（貼連結、挑選、進度、續傳、補小隊）。
4. 雲端硬碟資料夾（API 金鑰）。
5. 管理頁開關與用量。
