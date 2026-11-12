# 規劃：照片同步到 Google 相簿（方案 A）＋下載備援（方案 B）（2026-11-12）

## 1. 限制（為什麼不能用「既有的共用相簿」）
- 2025/3/31 起 Photos Library API 只剩 `photoslibrary.appendonly`、`readonly.appcreateddata`、`edit.appcreateddata`：
  程式只能把照片加入「同一個 Google Cloud 專案建立的相簿」，不能寫入使用者自己建立的相簿。
- `sharedAlbums.share / join` 與 `photoslibrary.sharing` 範圍已移除：無法用 API 共用相簿，上傳者也無法加入相簿後用自己的帳號上傳。
- 所以流程是：系統建立相簿 → 主辦者在 Google 相簿 App 手動共用。要放進既有相簿只能走方案 B（下載後手動上傳）。

## 2. 方案 A 流程
1. 管理頁「Google 相簿」分頁 → `POST gphotos/connect` 取得授權網址（state = HMAC 簽章的 `{e, n, x, by}`，nonce 另放 HttpOnly cookie，防止把別人的授權結果塞給你）。
2. Google 授權（`access_type=offline`、`prompt=consent`）→ `/oauth/gphotos/callback`：換 token、檢查範圍、建立相簿（標題「活動名稱 日期（活動照片）」）。
   同一帳號重新連結時，`albums.get` 讀得到舊相簿就沿用，同步紀錄保留。
3. refresh token 以 AES-GCM（金鑰＝HKDF(SESSION_SECRET)）加密，存在 `events/{id}/gphotos.json`，不放活動設定、不回傳前端。
4. 同步：`POST gphotos/sync` 一次最多 15 張（預設 8）：R2 讀原圖 → `POST /v1/uploads`（raw）→ `mediaItems:batchCreate` 加入相簿 → 記錄 `items[hash]=mediaItemId`。
   前端一直呼叫到做完，可暫停；排除／刪除的照片不同步；失敗 3 次列為失敗，可「重試失敗的照片」。
   以 `lock_until`（90 秒）避免手動與排程同時同步。
5. 自動同步：勾選後寫入 `gphotos/auto/{id}` 索引，每小時 :47 排程合計最多 30 張。
6. 主辦者把 Google 相簿的共用連結貼回管理頁（只做保存與複製）。
7. 中斷連結：撤銷 token；相簿留在 Google。排程刪除活動時同樣撤銷並刪狀態檔。

## 3. 方案 B（備援）
- `GET /api/admin/{id}/original/{hash}`（manager）。
- 管理頁「下載全部照片」：Chrome／Edge 用 File System Access「下載到資料夾」（可中斷續傳，已存在的檔案跳過）；其他瀏覽器產生不壓縮 ZIP，每包約 400MB。
- 檔名：`拍攝時間_雜湊前10碼.副檔名`（Google 相簿依 EXIF 排序，檔名只是方便辨識）。

## 4. 已知限制與風險
| 項目 | 說明 |
|---|---|
| OAuth 驗證 | appendonly 是敏感範圍；正式版未送審會顯示「未驗證」警告、上限 100 位使用者。測試狀態的 refresh token 7 天失效 |
| 空間 | 佔用主辦者 Google 帳號空間 |
| 刪除 | API 無法刪除／移出照片：已同步的照片排除或刪除不會反映到 Google 相簿 |
| 配額 | 每專案每日約 10,000 次請求；超過回 429，隔天再試 |
| Worker 限制 | 每次請求子請求數有限 → 分批；原圖整張讀進記憶體（單張上限遠低於 128MB） |
| 金鑰 | 更換 SESSION_SECRET ＝ 所有活動需重新連結（狀態顯示「需要重新連結」） |

## 5. 未做（之後可加）
- 上傳頁／相簿頁顯示「到 Google 相簿看照片」按鈕（目前共用連結只在管理頁複製）。
- 相簿改名（需 `edit.appcreateddata`）。
- 用 Cloudflare Queues 取代前端迴圈，讓大量同步可在背景完成。
