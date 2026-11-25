package io.github.dreamgen.purereader

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.text.TextUtils
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.net.URL
import java.util.Locale

class MainActivity : AppCompatActivity(), PureReaderJsBridge.BridgeHost, NativePageFetcher.FetchHost, TtsForegroundService.TtsEventListener {

    private lateinit var rootContainer: FrameLayout
    private lateinit var readerWebView: WebView
    private lateinit var sheetScrim: View
    private lateinit var sheetContainer: LinearLayout
    private lateinit var sheetTitleView: TextView
    private lateinit var sheetSubtitleView: TextView
    private lateinit var sheetProgressBar: ProgressBar
    private lateinit var sheetCaptureBtn: Button
    private lateinit var inAppWebView: WebView

    private val mainHandler = Handler(Looper.getMainLooper())
    private val payloadStore = PayloadStore()
    private lateinit var pageFetcher: NativePageFetcher
    private lateinit var appUpdater: AppUpdater

    private var webReady = false
    private var pendingSharedPayloadJson: String? = null
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingExportBytes: ByteArray? = null

    // In-App Browser rescue state
    private var sheetVisible = false
    private var activeRescueRequestId: String? = null
    private var activeRescueCallback: ((NativePageFetcher.RescueResult) -> Unit)? = null
    private var sheetAutoCapture = false
    private var stableReadableHits = 0
    private var lastInAppOrigin: String = ""
    private var captureInProgress = false

    // Cached TTS engine purely for enumerating available Chinese voices
    private var voiceQueryTts: TextToSpeech? = null
    private var cachedVoicesJson: String = "[]"

    private val openFileLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val cb = fileUploadCallback
        fileUploadCallback = null
        cb?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
    }

    private val saveFileLauncher = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val bytes = pendingExportBytes
        pendingExportBytes = null
        if (uri != null && bytes != null) {
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                Toast.makeText(this, "已儲存檔案", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "儲存失敗：${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private val requestNotifPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        // Non-blocking: foreground TTS still runs even if notification permission is declined
    }

    private val rescuePollRunnable = object : Runnable {
        override fun run() {
            if (!sheetVisible || !sheetAutoCapture || captureInProgress) return
            evaluateInAppReadiness()
            if (sheetVisible && sheetAutoCapture) {
                mainHandler.postDelayed(this, POLL_INTERVAL_MS)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        pageFetcher = NativePageFetcher(this)
        appUpdater = AppUpdater(this) { stateJson ->
            if (webReady) {
                deliverToWeb("appUpdate", "", stateJson)
            }
        }
        TtsForegroundService.eventListener = this
        initVoiceQueryTts()

        buildViews()
        setContentView(rootContainer)
        setupInsets()
        setupWebViews()
        setupBackNavigation()

        parseShareIntent(intent)?.let { pendingSharedPayloadJson = it }

        readerWebView.loadUrl("$APP_ORIGIN/assets/www/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val sharedJson = parseShareIntent(intent) ?: return
        if (webReady) {
            deliverToWeb("sharedInput", "", sharedJson)
        } else {
            pendingSharedPayloadJson = sharedJson
        }
    }

    override fun onResume() {
        super.onResume()
        readerWebView.onResume()
        readerWebView.resumeTimers()
        inAppWebView.onResume()
        readerWebView.settings.cacheMode =
            if (isNetworkAvailable()) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
        appUpdater.onHostResume()
    }

    override fun onPause() {
        inAppWebView.onPause()
        CookieManager.getInstance().flush()
        // Keep readerWebView timers alive when background TTS is running so lock-screen chapter transitions work
        if (!TtsForegroundService.isRunning) {
            readerWebView.onPause()
            readerWebView.pauseTimers()
        }
        super.onPause()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        TtsForegroundService.eventListener = null
        pageFetcher.shutdown()
        appUpdater.shutdown()
        try {
            voiceQueryTts?.shutdown()
        } catch (_: Exception) {
        }
        readerWebView.destroy()
        inAppWebView.destroy()
        super.onDestroy()
    }

    // ─── UI Construction ───────────────────────────────────────────────────────
    private fun buildViews() {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()

        rootContainer = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(Color.parseColor("#F9FAFB"))
        }

        readerWebView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        }
        rootContainer.addView(readerWebView)

        // Dim scrim behind In-App Browser BottomSheet
        sheetScrim = View(this).apply {
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
            setBackgroundColor(Color.parseColor("#99000000"))
            visibility = View.GONE
            alpha = 0f
            setOnClickListener { cancelAndCloseSheet() }
        }
        rootContainer.addView(sheetScrim)

        // BottomSheet container (88% height)
        val sheetHeight = (resources.displayMetrics.heightPixels * 0.88f).toInt().coerceAtLeast(dp(420))
        sheetContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, sheetHeight, Gravity.BOTTOM)
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadii = floatArrayOf(dp(20).toFloat(), dp(20).toFloat(), dp(20).toFloat(), dp(20).toFloat(), 0f, 0f, 0f, 0f)
            }
            elevation = dp(16).toFloat()
            visibility = View.GONE
            translationY = sheetHeight.toFloat()
        }

        // Sheet header bar
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(10), dp(14), dp(8))
            setBackgroundColor(Color.parseColor("#F8FAFC"))
        }

        val topRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val titleCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        sheetTitleView = TextView(this).apply {
            text = "內建瀏覽器驗證"
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.parseColor("#0F172A"))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        sheetSubtitleView = TextView(this).apply {
            text = "載入網頁中…"
            textSize = 12f
            setTextColor(Color.parseColor("#64748B"))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        titleCol.addView(sheetTitleView)
        titleCol.addView(sheetSubtitleView)

        val backBtn = makeHeaderIconButton("←") {
            if (inAppWebView.canGoBack()) inAppWebView.goBack()
        }
        val reloadBtn = makeHeaderIconButton("↻") {
            inAppWebView.reload()
        }
        val closeBtn = makeHeaderIconButton("✕") {
            cancelAndCloseSheet()
        }

        sheetCaptureBtn = Button(this).apply {
            text = "📥 立即擷取"
            textSize = 12f
            isAllCaps = false
            setTextColor(Color.WHITE)
            setPadding(dp(10), dp(4), dp(10), dp(4))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#2563EB"))
                cornerRadius = dp(8).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(34)).apply {
                marginStart = dp(6)
                marginEnd = dp(4)
            }
            setOnClickListener { captureCurrentInAppPage(isAuto = false) }
        }

        topRow.addView(titleCol)
        topRow.addView(backBtn)
        topRow.addView(reloadBtn)
        topRow.addView(sheetCaptureBtn)
        topRow.addView(closeBtn)

        sheetProgressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3)).apply {
                topMargin = dp(6)
            }
            max = 100
            visibility = View.GONE
        }

        header.addView(topRow)
        header.addView(sheetProgressBar)
        sheetContainer.addView(header)

        inAppWebView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        sheetContainer.addView(inAppWebView)
        rootContainer.addView(sheetContainer)
    }

    private fun makeHeaderIconButton(label: String, onClick: () -> Unit): Button {
        val density = resources.displayMetrics.density
        val size = (34 * density).toInt()
        return Button(this).apply {
            text = label
            textSize = 15f
            setTextColor(Color.parseColor("#334155"))
            setBackgroundColor(Color.TRANSPARENT)
            setPadding(0, 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(size, size).apply {
                marginStart = (2 * density).toInt()
            }
            setOnClickListener { onClick() }
        }
    }

    private fun setupInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    // ─── WebView Setup ─────────────────────────────────────────────────────────
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebViews() {
        if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(readerWebView, true)
        cookieManager.setAcceptThirdPartyCookies(inAppWebView, true)

        readerWebView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = if (isNetworkAvailable()) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
        }
        installWebGpuGuardIfNeeded(readerWebView)
        readerWebView.addJavascriptInterface(PureReaderJsBridge(this, payloadStore), "PureReaderAndroid")
        readerWebView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == APP_HOST) {
                    return serveLocalAsset(uri.path ?: "")
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val urlStr = request.url.toString()
                if (urlStr.startsWith(APP_ORIGIN)) return false
                // External links clicked inside reader (e.g. "開啟原頁") open inside In-App Browser!
                if (urlStr.startsWith("http://") || urlStr.startsWith("https://")) {
                    showInAppBrowser(urlStr, requestId = null, autoCapture = false, callback = null)
                    return true
                }
                return false
            }
        }
        readerWebView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback
                openFileLauncher.launch(arrayOf("text/html", "application/json", "text/plain", "multipart/related", "*/*"))
                return true
            }
        }

        // Security: NO @JavascriptInterface on inAppWebView because it loads untrusted third-party sites!
        inAppWebView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // Strip "; wv" marker if present so picky WAFs treat this as standard Chrome Mobile
            userAgentString = userAgentString.replace("; wv)", ")")
        }
        installWebGpuGuardIfNeeded(inAppWebView)
        inAppWebView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                stableReadableHits = 0
                if (url != null && url.startsWith("http")) {
                    lastInAppOrigin = extractOrigin(url)
                    sheetSubtitleView.text = try { URL(url).host } catch (_: Exception) { url }
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                CookieManager.getInstance().flush()
                if (url != null && url.startsWith("http")) {
                    lastInAppOrigin = extractOrigin(url)
                }
                if (sheetVisible && sheetAutoCapture && !captureInProgress) {
                    mainHandler.removeCallbacks(rescuePollRunnable)
                    mainHandler.postDelayed(rescuePollRunnable, 500L)
                }
            }
        }
        inAppWebView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                sheetProgressBar.progress = newProgress
                sheetProgressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            override fun onReceivedTitle(view: WebView?, title: String?) {
                if (!title.isNullOrBlank()) {
                    sheetTitleView.text = title
                }
            }
        }
    }

    private fun serveLocalAsset(rawPath: String): WebResourceResponse {
        val normalized = rawPath.trimStart('/')
        val safePath = when {
            normalized.isEmpty() || normalized == "assets/www" || normalized == "assets/www/" -> "www/index.html"
            normalized.startsWith("assets/www/") -> normalized.removePrefix("assets/")
            else -> "www/$normalized"
        }
        if (safePath.contains("..") || !safePath.startsWith("www/")) {
            return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        return try {
            val stream = assets.open(safePath)
            val mime = when {
                safePath.endsWith(".html") -> "text/html"
                safePath.endsWith(".js") -> "application/javascript"
                safePath.endsWith(".webmanifest") -> "application/manifest+json"
                safePath.endsWith(".svg") -> "image/svg+xml"
                safePath.endsWith(".png") -> "image/png"
                safePath.endsWith(".css") -> "text/css"
                else -> "application/octet-stream"
            }
            WebResourceResponse(mime, "utf-8", stream)
        } catch (_: Exception) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (sheetVisible) {
                    if (inAppWebView.canGoBack()) {
                        inAppWebView.goBack()
                    } else {
                        cancelAndCloseSheet()
                    }
                    return
                }
                if (readerWebView.canGoBack()) {
                    readerWebView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    // ─── In-App Browser BottomSheet & Auto-Rescue Poller ───────────────────────
    private fun showInAppBrowser(
        url: String,
        requestId: String?,
        autoCapture: Boolean,
        callback: ((NativePageFetcher.RescueResult) -> Unit)?,
    ) {
        mainHandler.post {
            activeRescueRequestId = requestId
            activeRescueCallback = callback
            sheetAutoCapture = autoCapture
            stableReadableHits = 0
            captureInProgress = false

            sheetTitleView.text = if (autoCapture) "正在通過網站驗證…" else "內建瀏覽器"
            sheetSubtitleView.text = try { URL(url).host } catch (_: Exception) { url }

            sheetScrim.visibility = View.VISIBLE
            sheetContainer.visibility = View.VISIBLE
            sheetScrim.animate().alpha(1f).setDuration(200).start()
            sheetContainer.animate().translationY(0f).setDuration(240).start()
            sheetVisible = true

            // Auto-pass PTT over18 cookie before loading
            try {
                val u = URL(url)
                if (u.host.equals("www.ptt.cc", true) || u.host.equals("ptt.cc", true)) {
                    CookieManager.getInstance().setCookie(url, "over18=1; Path=/")
                }
            } catch (_: Exception) {
            }

            inAppWebView.loadUrl(url)
            if (autoCapture) {
                mainHandler.removeCallbacks(rescuePollRunnable)
                mainHandler.postDelayed(rescuePollRunnable, POLL_INTERVAL_MS)
            }
        }
    }

    private fun hideSheet() {
        mainHandler.removeCallbacks(rescuePollRunnable)
        sheetVisible = false
        sheetAutoCapture = false
        val targetY = sheetContainer.height.takeIf { it > 0 }?.toFloat() ?: 2200f
        sheetScrim.animate().alpha(0f).setDuration(180).withEndAction {
            sheetScrim.visibility = View.GONE
        }.start()
        sheetContainer.animate().translationY(targetY).setDuration(200).withEndAction {
            sheetContainer.visibility = View.GONE
        }.start()
    }

    private fun cancelAndCloseSheet() {
        mainHandler.post {
            val cb = activeRescueCallback
            val finalUrl = inAppWebView.url ?: ""
            activeRescueRequestId = null
            activeRescueCallback = null
            hideSheet()
            cb?.invoke(
                NativePageFetcher.RescueResult(
                    ok = false,
                    cancelled = true,
                    finalUrl = finalUrl,
                    title = "",
                    html = "",
                    error = "已取消內建瀏覽器驗證"
                )
            )
        }
    }

    private fun evaluateInAppReadiness() {
        val probeJs = """
            (() => {
              try {
                const href = location.href || '';
                if (!/^https?:\/\//i.test(href)) return { ready: false };
                const rs = document.readyState || 'loading';
                if (rs === 'loading') return { ready: false };
                const title = (document.title || '').trim();
                const html = document.documentElement ? document.documentElement.outerHTML : '';
                const bodyText = document.body ? (document.body.innerText || '').replace(/\s+/g, ' ').trim() : '';
                const isChl =
                  title.toLowerCase() === 'just a moment...' ||
                  title.toLowerCase().includes('attention required') ||
                  Boolean(document.querySelector('#challenge-running, #challenge-stage, #cf-challenge-running, .cf-browser-verification, #challenge-error-text')) ||
                  html.includes('_cf_chl_opt') ||
                  html.includes('cf_chl_') ||
                  html.includes('Checking if the site connection is secure') ||
                  (html.includes('/ask/over18') && html.includes('年滿十八歲'));
                const pCount = document.querySelectorAll('p, article').length;
                const looksRendered = rs === 'complete'
                  ? bodyText.length >= 80
                  : (bodyText.length >= 280 && pCount >= 2);
                return { ready: !isChl && html.length >= 500 && looksRendered, title };
              } catch (e) {
                return { ready: false };
              }
            })();
        """.trimIndent()

        inAppWebView.evaluateJavascript(probeJs) { rawResult ->
            if (!sheetVisible || !sheetAutoCapture || captureInProgress) return@evaluateJavascript
            val obj = parseEvalJsonObject(rawResult) ?: return@evaluateJavascript
            if (obj.optBoolean("ready", false)) {
                stableReadableHits++
                sheetSubtitleView.text = "驗證通過，正在擷取內容…"
                if (stableReadableHits >= 2) {
                    captureCurrentInAppPage(isAuto = true)
                }
            } else {
                stableReadableHits = 0
            }
        }
    }

    private fun captureCurrentInAppPage(isAuto: Boolean) {
        if (captureInProgress) return
        captureInProgress = true
        mainHandler.removeCallbacks(rescuePollRunnable)

        val captureJs = """
            (() => ({
              url: location.href || '',
              title: document.title || '',
              html: document.documentElement ? document.documentElement.outerHTML : ''
            }))();
        """.trimIndent()

        inAppWebView.evaluateJavascript(captureJs) { rawResult ->
            captureInProgress = false
            val obj = parseEvalJsonObject(rawResult)
            val capturedUrl = obj?.optString("url", "") ?: (inAppWebView.url ?: "")
            val capturedTitle = obj?.optString("title", "") ?: ""
            val capturedHtml = obj?.optString("html", "") ?: ""

            CookieManager.getInstance().flush()
            if (capturedUrl.startsWith("http")) {
                lastInAppOrigin = extractOrigin(capturedUrl)
            }

            if (capturedHtml.isBlank() || (isAuto && BotPageDetector.isChallenge(capturedHtml))) {
                if (!isAuto) {
                    Toast.makeText(this, "目前頁面尚無法擷取內容", Toast.LENGTH_SHORT).show()
                }
                return@evaluateJavascript
            }

            val cb = activeRescueCallback
            activeRescueRequestId = null
            activeRescueCallback = null
            hideSheet()

            if (cb != null) {
                cb.invoke(
                    NativePageFetcher.RescueResult(
                        ok = true,
                        cancelled = false,
                        finalUrl = capturedUrl,
                        title = capturedTitle,
                        html = capturedHtml,
                    )
                )
            } else {
                val manualPayload = JSONObject().apply {
                    put("url", capturedUrl)
                    put("title", capturedTitle)
                    put("html", capturedHtml)
                }
                deliverToWeb("manualCapture", "", manualPayload.toString())
            }
        }
    }

    // ─── FetchHost Implementation ──────────────────────────────────────────────
    override fun getWebViewUserAgent(): String {
        return WebSettings.getDefaultUserAgent(this).replace("; wv)", ")")
    }

    override fun trySameOriginWebViewFetch(url: String, fresh: Boolean, callback: (NativePageFetcher.WebViewFetchResult?) -> Unit) {
        mainHandler.post {
            val targetOrigin = extractOrigin(url)
            val currentWvOrigin = inAppWebView.url?.let { extractOrigin(it) } ?: lastInAppOrigin
            if (targetOrigin.isBlank() || targetOrigin != currentWvOrigin) {
                callback(null)
                return@post
            }

            val urlJson = JSONObject.quote(url)
            val cacheMode = if (fresh) "reload" else "default"
            val script = """
                (() => {
                  const slot = '__prwv_' + Math.random().toString(36).slice(2);
                  window[slot] = { done: false };
                  fetch($urlJson, { credentials: 'include', cache: '$cacheMode' })
                    .then(async (res) => {
                      const buf = await res.arrayBuffer();
                      let html = '';
                      try {
                        const ct = res.headers.get('content-type') || '';
                        const m = ct.match(/charset=([^\s;]+)/i);
                        const enc = (m && m[1]) ? m[1] : 'utf-8';
                        html = new TextDecoder(enc, { fatal: false }).decode(buf);
                      } catch (e) {
                        html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
                      }
                      window[slot] = { done: true, ok: res.ok, status: res.status, finalUrl: res.url || $urlJson, html };
                    })
                    .catch(() => {
                      window[slot] = { done: true, ok: false, status: 0, finalUrl: $urlJson, html: '' };
                    });
                  return slot;
                })();
            """.trimIndent()

            inAppWebView.evaluateJavascript(script) { rawSlot ->
                val slot = parseEvalJsonString(rawSlot)
                if (slot.isNullOrBlank()) {
                    callback(null)
                    return@evaluateJavascript
                }
                pollWebViewFetchSlot(slot, attempts = 0, callback = callback)
            }
        }
    }

    private fun pollWebViewFetchSlot(
        slot: String,
        attempts: Int,
        callback: (NativePageFetcher.WebViewFetchResult?) -> Unit,
    ) {
        if (attempts > 40) {
            callback(null)
            return
        }
        val readScript = """
            (() => {
              const v = window['$slot'];
              if (!v || !v.done) return null;
              delete window['$slot'];
              return v;
            })();
        """.trimIndent()

        inAppWebView.evaluateJavascript(readScript) { raw ->
            val obj = parseEvalJsonObject(raw)
            if (obj == null) {
                mainHandler.postDelayed({ pollWebViewFetchSlot(slot, attempts + 1, callback) }, 150L)
            } else {
                callback(
                    NativePageFetcher.WebViewFetchResult(
                        ok = obj.optBoolean("ok", false),
                        status = obj.optInt("status", 0),
                        finalUrl = obj.optString("finalUrl", ""),
                        html = obj.optString("html", ""),
                    )
                )
            }
        }
    }

    override fun startInAppBrowserRescue(
        requestId: String,
        url: String,
        autoCapture: Boolean,
        callback: (NativePageFetcher.RescueResult) -> Unit,
    ) {
        showInAppBrowser(url, requestId, autoCapture, callback)
    }

    override fun cancelInAppBrowserRescue(requestId: String) {
        mainHandler.post {
            if (activeRescueRequestId == requestId) {
                activeRescueRequestId = null
                activeRescueCallback = null
                hideSheet()
            }
        }
    }

    override fun deliverFetchResult(requestId: String, payloadJson: String) {
        deliverToWeb("fetch", requestId, payloadJson)
    }

    // ─── PureReaderJsBridge.BridgeHost Implementation ──────────────────────────
    override fun onWebReady() {
        mainHandler.post {
            webReady = true
            val pending = pendingSharedPayloadJson
            if (pending != null) {
                pendingSharedPayloadJson = null
                deliverToWeb("sharedInput", "", pending)
            }
            if (isNetworkAvailable()) {
                mainHandler.postDelayed({ appUpdater.maybeAutoCheckOnStartup() }, 1500L)
            }
        }
    }

    override fun onRequestFetch(requestId: String, url: String, allowInteractive: Boolean, fresh: Boolean) {
        pageFetcher.fetch(requestId, url, allowInteractive, fresh)
    }

    override fun onCancelFetch(requestId: String) {
        pageFetcher.cancel(requestId)
    }

    override fun onOpenInAppBrowser(url: String, autoCapture: Boolean) {
        if (url.isBlank()) return
        showInAppBrowser(url, requestId = null, autoCapture = autoCapture, callback = null)
    }

    override fun onSetKeepScreenOn(keepOn: Boolean) {
        mainHandler.post {
            if (keepOn) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    override fun onSetThemeDark(isDark: Boolean) {
        mainHandler.post {
            rootContainer.setBackgroundColor(Color.parseColor(if (isDark) "#111827" else "#F9FAFB"))
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            controller.isAppearanceLightStatusBars = !isDark
            controller.isAppearanceLightNavigationBars = !isDark
        }
    }

    override fun onSaveBase64File(filename: String, mimeType: String, base64Data: String) {
        mainHandler.post {
            pendingExportBytes = try {
                Base64.decode(base64Data, Base64.DEFAULT)
            } catch (_: Exception) {
                null
            }
            if (pendingExportBytes == null) {
                Toast.makeText(this, "匯出資料編碼失敗", Toast.LENGTH_SHORT).show()
                return@post
            }
            saveFileLauncher.launch(filename.ifBlank { "purereader_export.json" })
        }
    }

    override fun getUpdateSettingsJson(): String = appUpdater.getStateJson()

    override fun saveUpdateSettingsJson(settingsJson: String): String =
        appUpdater.saveSettingsJson(settingsJson)

    override fun onCheckAppUpdate(manual: Boolean) {
        appUpdater.checkForUpdate(manual)
    }

    override fun onInstallAppUpdate() {
        appUpdater.installOrDownloadUpdate()
    }

    override fun isNativeTtsAvailable(): Boolean = true

    override fun getNativeTtsVoicesJson(): String = cachedVoicesJson

    override fun onStartNativeTts(
        chapterTitle: String,
        paragraphsJson: String,
        startIndex: Int,
        rate: Float,
        voiceName: String,
    ) {
        ensureNotificationPermissionIfNeeded()
        val intent = Intent(this, TtsForegroundService::class.java).apply {
            action = TtsForegroundService.ACTION_START
            putExtra(TtsForegroundService.EXTRA_TITLE, chapterTitle)
            putExtra(TtsForegroundService.EXTRA_PARAGRAPHS_JSON, paragraphsJson)
            putExtra(TtsForegroundService.EXTRA_START_INDEX, startIndex)
            putExtra(TtsForegroundService.EXTRA_RATE, rate)
            putExtra(TtsForegroundService.EXTRA_VOICE_NAME, voiceName)
        }
        ContextCompat.startForegroundService(this, intent)
    }

    override fun onPauseNativeTts() {
        startService(Intent(this, TtsForegroundService::class.java).apply { action = TtsForegroundService.ACTION_PAUSE })
    }

    override fun onResumeNativeTts() {
        val intent = Intent(this, TtsForegroundService::class.java).apply { action = TtsForegroundService.ACTION_RESUME }
        ContextCompat.startForegroundService(this, intent)
    }

    override fun onStopNativeTts() {
        startService(Intent(this, TtsForegroundService::class.java).apply { action = TtsForegroundService.ACTION_STOP })
    }

    override fun onTtsEvent(eventJson: String) {
        deliverToWeb("tts", "", eventJson)
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────
    private fun deliverToWeb(kind: String, requestId: String, payloadJson: String) {
        val token = payloadStore.put(payloadJson)
        val js = "window.__prNativeDeliver && window.__prNativeDeliver(${JSONObject.quote(kind)}, ${JSONObject.quote(requestId)}, ${JSONObject.quote(token)});"
        mainHandler.post {
            readerWebView.evaluateJavascript(js, null)
        }
    }

    private fun initVoiceQueryTts() {
        voiceQueryTts = TextToSpeech(applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val arr = JSONArray()
                val voices = voiceQueryTts?.voices.orEmpty()
                    .filter {
                        val lang = it.locale.language.lowercase(Locale.ROOT)
                        lang == "zh" || it.locale.toString().lowercase(Locale.ROOT).contains("zh")
                    }
                    .sortedWith(compareBy({ it.locale.toString() }, { it.name }))
                for (v in voices) {
                    arr.put(JSONObject().apply {
                        put("name", v.name)
                        put("label", "${v.locale.displayName} · ${v.name}")
                        put("locale", v.locale.toLanguageTag())
                    })
                }
                cachedVoicesJson = arr.toString()
            }
        }
    }

    private fun ensureNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestNotifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun parseShareIntent(intent: Intent?): String? {
        if (intent == null || intent.action != Intent.ACTION_SEND) return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: ""
        val html = intent.getStringExtra(Intent.EXTRA_HTML_TEXT)?.trim() ?: ""
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim() ?: ""

        val urlMatch = Regex("https?://\\S+", RegexOption.IGNORE_CASE).find(text)?.value ?: ""
        if (urlMatch.isBlank() && html.isBlank() && text.isBlank()) return null

        return JSONObject().apply {
            put("url", urlMatch)
            put("html", html)
            put("text", if (urlMatch.isNotBlank() && text == urlMatch) "" else text)
            put("title", subject)
        }.toString()
    }

    private fun extractOrigin(rawUrl: String): String {
        return try {
            val u = URL(rawUrl)
            val portPart = if (u.port > 0 && u.port != u.defaultPort) ":${u.port}" else ""
            "${u.protocol.lowercase()}://${u.host.lowercase()}$portPart"
        } catch (_: Exception) {
            ""
        }
    }

    private fun parseEvalJsonObject(raw: String?): JSONObject? {
        if (raw.isNullOrBlank() || raw == "null") return null
        return try {
            val parsed = JSONTokener(raw).nextValue()
            when (parsed) {
                is JSONObject -> parsed
                is String -> JSONTokener(parsed).nextValue() as? JSONObject
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun parseEvalJsonString(raw: String?): String? {
        if (raw.isNullOrBlank() || raw == "null") return null
        return try {
            val parsed = JSONTokener(raw).nextValue()
            parsed as? String
        } catch (_: Exception) {
            null
        }
    }

    /**
     * On devices/emulators whose OpenGL ES driver lacks ES 3.1 (reqGlEsVersion < 0x30001),
     * Chromium WebView's Dawn WebGPU probe triggers EGL_BAD_CONFIG -> SIGTRAP in Chrome_InProcGp.
     * Guard navigator.gpu at document-start so Cloudflare challenges fall back cleanly to WebGL/Canvas.
     */
    private fun installWebGpuGuardIfNeeded(webView: WebView) {
        if (!needsWebGpuGuard()) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val guardScript = """
            (() => {
              try {
                if (typeof GPU !== 'undefined' && GPU.prototype && typeof GPU.prototype.requestAdapter === 'function') {
                  GPU.prototype.requestAdapter = function() { return Promise.resolve(null); };
                }
                if (typeof Navigator !== 'undefined' && Navigator.prototype && 'gpu' in Navigator.prototype) {
                  Object.defineProperty(Navigator.prototype, 'gpu', {
                    configurable: true,
                    enumerable: true,
                    get: function() { return undefined; }
                  });
                }
              } catch (e) {}
            })();
        """.trimIndent()
        WebViewCompat.addDocumentStartJavaScript(webView, guardScript, setOf("*"))
    }

    private fun needsWebGpuGuard(): Boolean {
        if (isEmulator()) return true
        return try {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager ?: return false
            am.deviceConfigurationInfo.reqGlEsVersion < 0x30001
        } catch (_: Exception) {
            false
        }
    }

    private fun isEmulator(): Boolean {
        return Build.FINGERPRINT.contains("generic", ignoreCase = true) ||
            Build.FINGERPRINT.contains("emulator", ignoreCase = true) ||
            Build.MODEL.contains("sdk_gphone", ignoreCase = true) ||
            Build.MODEL.contains("Emulator", ignoreCase = true) ||
            Build.HARDWARE.contains("ranchu", ignoreCase = true) ||
            Build.HARDWARE.contains("goldfish", ignoreCase = true) ||
            Build.PRODUCT.contains("sdk_gphone", ignoreCase = true) ||
            Build.PRODUCT.contains("emulator", ignoreCase = true)
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    companion object {
        private const val APP_HOST = "appassets.purereader.local"
        private const val APP_ORIGIN = "https://$APP_HOST"
        private const val POLL_INTERVAL_MS = 750L
    }
}
