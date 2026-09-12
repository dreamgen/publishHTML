# 互動題本 — 線上小組練習（interactiveWorkbook）

通用的線上互動題本 PWA。講師自行開課程、匯入題目（JSON），學員以**六碼加入代碼**進入，選（或新增）組別、填姓名即可分組作答；講師端即時看到各組答案，可逐題開放、投影比較、匯出。

- 前端：純靜態頁面，部署在 GitHub Pages（`publishHTML` repo，push 到 `main` 自動部署）
- 後端：Firebase Realtime Database（與 `liveInteraction` 共用 `pwa-boardgame` 專案），匿名登入
- 資料路徑：`artifacts/interactiveWorkbook/public/data/courses/<六碼代碼>`

---

## 首次部署：兩個步驟

### 1. 設定 Firebase 資料庫規則（**必做，否則一定會出現「Permission denied」**）

目前 `pwa-boardgame` 資料庫的規則會拒絕所有讀寫（連 `liveInteraction` 自己的路徑也被拒），需要補上規則。

到 [Firebase 主控台](https://console.firebase.google.com/) → 選擇 `pwa-boardgame` 專案 → Realtime Database → 規則，貼上本資料夾的 `database.rules.json` 內容後發布：

```json
{
  "rules": {
    "artifacts": {
      "interactiveWorkbook": {
        "public": { "data": { "courses": { "$code": {
          ".read": "auth != null",
          ".write": "auth != null"
        } } } }
      },
      "liveInteraction": {
        "public": { "data": { ".read": "auth != null", ".write": "auth != null" } }
      }
    }
  }
}
```

規則說明：

- 只有登入（匿名登入也算）的使用者可以讀寫，且**必須指定完整的六碼代碼路徑**；沒有人能列出全部課程，等於代碼本身就是進入課程的鑰匙。
- `liveInteraction` 區塊是順便把既有連線桌遊的權限一起補回來；若不需要可以整段刪除。
- 若日後還有其他 PWA 要共用這個資料庫，在 `artifacts` 底下再加一段同樣格式的規則即可，不要直接覆蓋整份規則。

也可以用 Firebase CLI 部署（需切換到擁有 `pwa-boardgame` 的帳號）：

```bash
firebase login:use dreamgen@gmail.com
firebase deploy --only database --project pwa-boardgame
```

（CLI 會讀取 `firebase.json` 裡指定的規則檔；若沒有 `firebase.json`，用主控台貼上比較快。）

### 2. 部署前端

跟其他 PWA 一樣，把 `publishHTML` 推上 `main` 即可自動部署：

```
https://dreamgen.github.io/publishHTML/interactiveWorkbook/
```

在手機或電腦瀏覽器開啟後，選「加入主畫面」／安裝圖示即可當成 App 使用。

---

## 講師：建立課程與匯入題目

1. 首頁按「我是講師 →」，切到「建立新課程」。
2. 輸入課程名稱與講師密碼（至少 6 個字元，需輸入兩次），按「建立課程」。
3. 系統會產生一組**六碼加入代碼**（例如 `K7M2QP`）。**請抄下代碼**；密碼以 PBKDF2-SHA256 雜湊後才儲存，遺失無法還原，只能重新建立課程。
   - 這台裝置的瀏覽器會記住您開過的課程代碼，下次登入可直接點「填入」。
4. 進入控制台後，按「下載題目範本 JSON」，依格式編輯後按「匯入題目 JSON」上傳。
5. 匯入題目會**完全取代**目前課程的練習內容；已有的組別答案中，欄位不符者會被清空，其餘保留。可隨時重新匯入修改題目。

### 題目 JSON 格式

最外層需要 `exercises` 陣列，每個元素是一個「練習」：

```json
{
  "exercises": [
    {
      "title": "練習標題（必填）",
      "time": "時間分配說明（選填）",
      "goal": "這一題的目的（選填）",
      "notice": "作答前的提醒（選填）",
      "reference": {
        "caption": "參考表格標題（選填）",
        "columns": ["欄位1", "欄位2"],
        "rows": [["值1", "值2"]]
      },
      "fields": [ /* 見下方欄位類型 */ ]
    }
  ]
}
```

`fields` 中每個欄位的 `key` 由英數字或底線組成、同一練習內不可重複；`label` 是顯示的題目文字；`required` 決定「標記完成」時是否必填。支援的 `type`：

| type | 說明 | 可用的額外設定 |
|------|------|----------------|
| `text` / `textarea` | 單行／多行文字 | `hint` |
| `number` | 整數 | `hint` |
| `date` | 日期 | `hint` |
| `radio` | 單選 | `options`（必填） |
| `checkbox` | 多選 | `options`（必填）、`minSelect`、`maxSelect` |
| `list` | 可增減的文字清單 | `itemType`（`text`／`textarea`）、`minItems`、`itemLabel` |
| `table` | 可增減列數的表格 | `columns`（每欄 `key`／`label`／`type`）、`minRows`、`itemLabel` |

例如「恰好選三個指標」寫成 `"minSelect": 3, "maxSelect": 3`；「至少填 8 列」寫成 `"minRows": 8`。範本 `題目範本.json`（控制台可直接下載）示範了以上每一種類型。

上限：30 個練習、每個練習 40 個欄位、每個選項清單 40 項。

## 講師：上課時的控制台

- **學員加入 QR Code**：全螢幕顯示 QR Code 與六碼代碼，適合投影。學員掃碼後代碼會自動帶入。
- **練習開關**：未開放的練習，學員無法進入或查看。依進度逐題開放，關閉不會刪除答案；講師本身隨時看得到所有答案。
- **展示題目／組別**：切換要比較的題目與組別，答案依欄位對齊，**即時更新**（不需重新整理）。
- **簡潔投影**：隱藏管理區，只留題目與答案，適合投影比較；再按一次退出。
- **匯出**：JSON（可再匯入還原）或 CSV（Excel 閱讀分析用）。
- **清除本題答案／刪除所選小組／重置本場課程／刪除整個課程**：都會先跳出確認；重置與刪除課程需輸入指定文字。

## 學員操作

1. 開啟網址（或掃 QR Code），輸入六碼加入代碼，畫面會顯示課程名稱確認。
2. 選擇現有組別或直接輸入新組別名稱，填姓名，即可進入。
3. 同一課程的**相同組別名稱**共用一份答案，建議每組一人操作、其他人共同討論。
4. 「儲存草稿」可以尚未填完；「標記完成並儲存」會依欄位設定檢查必填與數量條件。**答案不會自動儲存，離開前請按儲存。**
5. 同題同時在多台裝置修改時，系統會擋下較舊的覆寫，並提示先複製保留畫面文字再重新載入。

## 安全性與限制

這是給教室／研習場合用的輕量工具，安全模型如下，請衡量後使用：

- **代碼即鑰匙**：知道六碼代碼的人就能加入該課程、看到同課程各組的作答。代碼不會公開列出，但也不要貼到公開網頁。
- **講師密碼**以 PBKDF2-SHA256（150,000 次迭代）加鹽雜湊後儲存，不存明文；但因為驗證在瀏覽器端進行，雜湊值本身是可讀的，請使用有強度的密碼、不要重複使用其他系統的密碼。
- 前端直接連資料庫（沒有自己的伺服器），因此熟悉開發者工具的人技術上可以繞過畫面限制改寫該課程資料。與同 repo 的 `liveInteraction` 相同，屬於「信任參與者」的設計。若需要真正的權限控管，要改成經由 Cloudflare Worker 或 Cloud Functions 驗證。
- 資料存在 Firebase，沒有自動過期機制。課程結束後建議匯出答案，再用「刪除整個課程」清掉。

## 離線行為

Service Worker 只快取介面本身（HTML／JS／圖示／CDN 函式庫），**作答資料一律即時連線**。沒有網路時可以開啟 App 外觀，但無法加入課程或儲存答案。

## 檔案

| 檔案 | 說明 |
|------|------|
| `index.html` | 頁面骨架與樣式 |
| `app.js` | 全部邏輯（Firebase 連線、題目渲染、講師控制台） |
| `sw.js` | Service Worker（stale-while-revalidate） |
| `manifest.webmanifest` | PWA 安裝設定 |
| `icons/` | 192／512 SVG 圖示 |
| `題目範本.json` | 範例題目，可直接匯入 |
| `database.rules.json` | Firebase Realtime Database 規則（部署用） |

外部相依：Firebase JS SDK 11.6.1（gstatic CDN）、QRious 4.0.2（cdnjs），皆由 Service Worker 快取。
