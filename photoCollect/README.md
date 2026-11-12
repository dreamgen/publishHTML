# 雲端收照片（mv-photo-collect）

活動照片從手機上傳到 Cloudflare R2，MV Studio 再用 `mvctl sync` 下載製作。一個 Worker 同時提供 API、手機上傳頁（PWA）、主辦者管理頁與安裝包下載頁。

| 網址 | 給誰 | 內容 |
|---|---|---|
| `/` | 主辦者 | 我的活動、建立新活動（需要建立密碼） |
| `/admin#e=…&k=…` | 主辦者 | 準備中心、即時進度、交給 MV 製作者、安全與保存 |
| `/u/<上傳碼>` | 攝影師、家長 | 上傳照片（可加到手機主畫面） |
| `/download/` | MV 製作者 | 安裝包、SHA-256、安裝提示詞 |

API 規格見 `docs/API.md`；設計上的假設見 `docs/ASSUMPTIONS.md`。

## 第一次部署

需要 Node.js 18 以上與一個 Cloudflare 帳號（免費方案即可，啟用 R2 時 Cloudflare 可能要求登記付款方式）。

```bash
cd cloud
npm install
npx wrangler login          # 會開瀏覽器登入 Cloudflare
bash scripts/deploy.sh      # 建立 R2 bucket、設定建立密碼、部署
```

`deploy.sh` 會詢問「建立密碼」（`CREATE_SECRET`）：建議用 20 字以上的隨機字串，只告訴要辦活動的主辦者。部署完成後終端機會顯示網址（`https://mv-photo-collect.<你的帳號>.workers.dev`）。要用自己的網域，在 Cloudflare 後台的 Worker → Settings → Domains 加上。

建議另外在 Cloudflare 後台為 `/api/*` 設一條 Rate Limiting 規則（例如每 IP 每分鐘 300 次）。

## 啟用 Google 帳號登入（選用）

登入後可以：在任何電腦看到自己建立的活動、記錄上傳過的活動，以及把活動分享給別人共同管理（管理者／檢視者）。不設定的話一切照舊，用管理連結管理。

1. 到 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → 建立專案（任意名稱）→「OAuth 同意畫面」選「外部」，填應用程式名稱與你的 Email，發布狀態設為「正式版」（只用基本登入範圍，不需要 Google 審查）。
2. 「憑證」→「建立憑證」→「OAuth 用戶端 ID」→ 類型「網頁應用程式」。
   - 已授權的 JavaScript 來源：填你的 Worker 網址，例如 `https://mv-photo-collect.<帳號>.workers.dev`（自訂網域也要加）。
   - 不需要填重新導向 URI。
3. 把產生的「用戶端 ID」填進 `wrangler.toml` 的 `GOOGLE_CLIENT_ID`。
4. 選填：`CREATOR_EMAILS` 填可免密碼建立活動的 Email（逗號分隔，或 `@你的網域`）。其他人第一次建立活動時輸入一次建立密碼，之後同一個 Google 帳號就不用再輸入。
5. 執行 `bash scripts/deploy.sh`，第一次會要你設定 `SESSION_SECRET`（輸入 32 字以上的隨機字串，例如 `openssl rand -base64 48` 的結果）。

舊活動要加入帳號：登入後在起點頁「這台瀏覽器記住的活動」按「加入我的帳號」，或用管理連結開啟後按頁首的「把這個活動加入我的 Google 帳號」。

## 更新安裝包

本地 MV Studio 可攜版更新後：

```bash
bash scripts/build-download.sh ../dist/memory-mv-studio.zip 1.0.1
bash scripts/deploy.sh
```

## 本機測試

```bash
cp .dev.vars.example .dev.vars           # 本機用的建立密碼 local-dev-secret
npx wrangler dev --local --port 8787 --test-scheduled
# 另一個終端機
node test/e2e.mjs                        # 435 項端到端測試
```

本機資料存在 `.wrangler/state/`，刪掉即可重置。

## 免費額度估算

一場 1,000 張的活動（手機端壓縮後）約 0.5–1 GB；R2 免費額度每月 10 GB 儲存、下載流量免費。照片會在「截止時間＋保存天數」後由每日排程自動刪除。

## 檔案結構

```
src/            Worker 程式（router、auth、config、stats、upload、admin、sync、schedule）
public/         靜態頁：index（起點）、admin（管理）、upload（上傳 PWA）、download（下載頁）
public/vendor/  qrcode-generator（MIT）
test/e2e.mjs    端到端測試
scripts/        deploy.sh、build-download.sh
```
