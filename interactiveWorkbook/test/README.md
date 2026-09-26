# 互動題本｜無頭煙霧測試

不需要真的 Firebase，也不會碰到線上資料：用一個**記憶體版的假 RTDB** 取代
`modules/firebase.js`，再用 Playwright 開兩個瀏覽器分頁（講師、學員）跑完整流程。

## 怎麼跑

需要 node 與 playwright（chromium）。

```bash
# 測這個資料夾的上一層（也就是 interactiveWorkbook 本身）
IW_SRC=.. ./run.sh

# 或指定任何一份程式碼副本
IW_SRC=/path/to/interactiveWorkbook ./run.sh

# 換埠號（預設 8791）
IW_PORT=9000 IW_SRC=.. ./run.sh
```

非零 exit code 代表失敗。**任何一個瀏覽器 console error 或 pageerror 都算失敗**，
這是最有價值的一道防線——多數回歸會先以未攔截的例外現形。

## 13 個情境

| # | 情境 | 守住什麼 |
|---|---|---|
| S1 | 講師建課 | 建課與密碼雜湊流程 |
| S2 | 匯入題目 JSON | 八種欄位型別都能匯入 |
| S3 | 開放題目 | 題目開關 |
| S3b | 講師建立小組 | 講師預先命名（新版預設） |
| S4 | 學員加入 | 下拉／自由輸入兩種組別欄位、加入確認 |
| S5 | 作答與儲存 | 八種欄位型別的輸入與存檔 |
| S6 | 講師即時看到 | onValue 即時同步 |
| S7 | 匯出 JSON | 匯出內容正確 |
| S8 | 存檔衝突保護 | revision 樂觀鎖沒被繞過 |
| S9 | 舊資料自動遷移 | **舊格式課程的答案不會壞，且遷移幂等** |
| S10 | 投影五模式與狀態點 | 四模式可切、綠點正確、字級只改 CSS 變數 |
| S11 | 編輯題目與封存還原 | **取消修改等同沒發生（逐位元組比對）**、封存不進匯出、還原預設關閉且有註記 |
| S12 | 橘點 | 欄位 focus 會寫活動標記、且只亮在該題 |

## 檔案

| 檔案 | 說明 |
|---|---|
| `fake-firebase.js` | 假 RTDB 的瀏覽器端，介面與 `modules/firebase.js` 相同 |
| `serve.mjs` | 靜態伺服器；把 `modules/firebase.js` 的請求換成假的，並代管假資料庫（兩個分頁要共用同一份資料，所以資料存在 node 行程裡，透過 SSE 推播變動） |
| `smoke.mjs` | Playwright 測試腳本 |
| `run.sh` | 一鍵：起伺服器 → 跑測試 → 收伺服器 |

## 已知的刻意簡化

- `window.__fakedb.dump()` / `seed()` 是**非同步**（要 await），因為資料在 node 行程而不在分頁裡。
- `onValue` 只要寫入路徑與監聽路徑有交集就會回呼一次，不像真 RTDB 會在值沒變時省略。
- `runTransaction` 預設直接拿真值呼叫 updater；設 `window.__fakedb.nullFirstTransaction = true` 才模擬 RTDB「第一次給 null」的路徑。
- `serve.mjs` 會替缺少的 `manifest.webmanifest`／`icons/`／`sw.js` 補最小佔位內容，避免 404 被誤判成測試失敗。
