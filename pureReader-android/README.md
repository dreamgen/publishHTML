# PureReader Android 原生混合 App（方案三）

將 [pureReader/](../pureReader/) 封裝為 Android 原生混合式 App，解決手機端 PWA 的三大痛點：

1. **三層原生抓取 + 內建瀏覽器自動過 Cloudflare 驗證**
   - **Tier 1（同源已驗證 WebView Fetch）**：內建瀏覽器通過驗證並停留於目標站同源網域後，後續小說章節直接復用該 WebView 執行同源 `fetch()`，共享 Chromium TLS 指紋與 `cf_clearance` Cookie。
   - **Tier 2（原生 HTTP + CookieManager 同步）**：一般網站由原生 `HttpURLConnection` 直接連線（無 CORS 限制），自動攜帶 WebView `CookieManager`、偵測 `UTF-8` / `GB18030` / `Big5` / `Shift_JIS` 編碼，並對 `ptt.cc` 自動帶入 `over18=1`。
   - **Tier 3（內建瀏覽器 BottomSheet 自動救援）**：當前景讀取遭遇 Cloudflare / WAF 真人驗證時，自動滑出內建瀏覽器；使用者通過驗證後由唯讀輪詢偵測正文就緒，**自動擷取完整渲染後 HTML 並關閉內建瀏覽器**，立即於淨讀器排版閱讀（亦可手動點擊標題列「📥 立即擷取」）。
2. **鎖屏不斷線原生背景聽書（`TtsForegroundService`）**
   - 透過 Android `ForegroundService`（`mediaPlayback`）+ `PARTIAL_WAKE_LOCK` 驅動原生 `TextToSpeech` 與通知欄控制列（上一段／暫停播放／下一段／結束）。
3. **螢幕常亮、系統分享接收、檔案匯入匯出**
   - 閱讀畫面自動啟用 `FLAG_KEEP_SCREEN_ON`。
   - 支援從 Chrome / LINE / PTT 使用系統「分享」直接傳送網址或網頁到「淨讀器」。
   - 透過 `syncPureReaderWebAssets` Gradle Task 於每次建置自動從 `../pureReader/` 同步最新前端檔案，不重複維護兩份 UI。

## 建置與輸出 APK

```bash
cd pureReader-android
./gradlew testDebugUnitTest assembleDebug
```

編譯完成後的 Debug APK 位於：
`pureReader-android/app/build/outputs/apk/debug/app-debug.apk`
