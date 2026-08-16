# purereader-proxy-cf — 共用 Cloudflare Worker

> 目前部署網址：`https://purereader-proxy-cf.dreamgen-dev.workers.dev`

這個 Worker 現在身兼兩個用途，共用同一次部署：

1. **PureReader CORS Proxy**（原本的功能）— `pureReader/` 用它繞過小說網站的 CORS／Cloudflare 真人驗證限制。路徑：`GET /?url=...`
2. **htmlShare 上傳／分享後端**（新增）— `htmlShare/` 用它把上傳的單一 HTML 存進 R2，並用短網址提供瀏覽。路徑：`POST /api/upload`、`GET /s/:id`

兩者互不影響：htmlShare 走專屬路徑，沒有動到既有 `/?url=...` 代理邏輯（已用測試腳本驗證過）。

---

## 新增 htmlShare 功能後，要做的事

因為 htmlShare 需要一個 R2 儲存空間，而這是**既有 Worker 第一次用到 R2**，所以重新部署前要先建立 bucket：

```bash
cd purereader-proxy-cf
npx wrangler r2 bucket create htmlshare-uploads
```

> 如果帳號還沒啟用過 R2，第一次使用時 Cloudflare 可能會要求你到 dashboard 的 R2 頁面按一次「Enable R2」。若指令失敗，先到 https://dash.cloudflare.com → R2 手動啟用一次，再重跑上面的指令。

建立好之後部署（沿用你原本登入過的 wrangler 帳號，不需要重新 `wrangler login`）：

```bash
npx wrangler deploy
```

部署完成後，htmlShare 前端要打的網址不變，還是：

```
https://purereader-proxy-cf.dreamgen-dev.workers.dev
```

htmlShare PWA（`htmlShare/index.html`）已經把這個網址設成預設值，理論上不用手動貼；如果你的 workers.dev 子網域不是 `dreamgen-dev`，或想改用自訂網域，再到 htmlShare 頁面右上角齒輪圖示調整。

---

## htmlShare API

### `POST /api/upload`

```json
{ "html": "<!DOCTYPE html>...", "title": "選填標題" }
```

回傳：

```json
{ "id": "74LTTtFw", "url": "https://.../s/74LTTtFw", "title": "...", "size": 1234, "uploadedAt": "2026-08-16T12:00:00.000Z" }
```

- 單檔上限 5MB（`src/index.js` 的 `HTML_SHARE_MAX_BYTES`）
- 內容需通過「看起來像 HTML」的粗略檢查
- 目前**任何人只要知道這個 Worker 網址就能上傳**（沿用你先前的選擇），分享 ID 是 8 碼隨機亂數，不容易被猜到或列舉

### `GET /s/:id`

直接回傳先前上傳的 HTML 內容（`Content-Type: text/html`），也就是分享出去的網址本身。

---

## 濫用防護

因為上傳是完全公開的，如果之後發現被濫用（大量垃圾上傳），可以考慮：

1. Cloudflare Dashboard → Security → WAF → Rate limiting rules，針對 `/api/upload` 設定速率限制（例如每個 IP 每分鐘最多 5 次），不用改程式碼。
2. 在 `src/index.js` 的 `handleHtmlShareUpload` 加一個簡單密碼欄位，前端對應加輸入框。
3. 加上 Cloudflare Turnstile（免費隱形驗證碼）擋機器人上傳。

---

## 本地開發

```bash
npm install
npx wrangler dev
```

## 檔案結構

```
purereader-proxy-cf/
├── src/index.js       # 路由：/api/upload、/s/:id、其餘走 PureReader 代理
├── wrangler.toml      # R2 binding（HTML_BUCKET）
├── package.json
└── README.md
```
