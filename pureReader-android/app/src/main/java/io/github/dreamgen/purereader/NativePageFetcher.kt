package io.github.dreamgen.purereader

import android.webkit.CookieManager
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * 3-Tier native page fetcher:
 *   Tier 1: Same-origin fetch inside the live verified inAppWebView (reuses Chromium TLS + cf_clearance).
 *   Tier 2: Native HttpURLConnection synced with CookieManager + WebView User-Agent.
 *   Tier 3: Visible In-App Browser BottomSheet auto-rescue for Cloudflare/WAF human verification.
 */
class NativePageFetcher(private val host: FetchHost) {

    interface FetchHost {
        fun getWebViewUserAgent(): String
        fun trySameOriginWebViewFetch(url: String, fresh: Boolean, callback: (WebViewFetchResult?) -> Unit)
        fun startInAppBrowserRescue(requestId: String, url: String, autoCapture: Boolean, callback: (RescueResult) -> Unit)
        fun cancelInAppBrowserRescue(requestId: String)
        fun deliverFetchResult(requestId: String, payloadJson: String)
    }

    data class WebViewFetchResult(
        val ok: Boolean,
        val status: Int,
        val finalUrl: String,
        val html: String,
    )

    data class RescueResult(
        val ok: Boolean,
        val cancelled: Boolean,
        val finalUrl: String,
        val title: String,
        val html: String,
        val error: String = "",
    )

    private val executor = Executors.newCachedThreadPool()
    private val activeRequests = ConcurrentHashMap<String, RequestState>()

    private class RequestState {
        @Volatile
        var cancelled = false

        @Volatile
        var connection: HttpURLConnection? = null
    }

    fun fetch(requestId: String, rawUrl: String, allowInteractive: Boolean, fresh: Boolean) {
        val state = RequestState()
        activeRequests[requestId] = state
        val startedAt = System.currentTimeMillis()
        val targetUrl = normalizeTargetUrl(rawUrl)

        if (!isAllowedHttpUrl(targetUrl)) {
            deliverResult(
                requestId = requestId,
                ok = false,
                finalUrl = targetUrl,
                html = "",
                winnerLabel = "",
                hadChallenge = false,
                cancelled = false,
                error = "不支援或封鎖的網址",
                startedAt = startedAt,
            )
            return
        }

        // Tier 1: Same-origin verified WebView fetch (fast path for novel chapters after verification)
        host.trySameOriginWebViewFetch(targetUrl, fresh) { wvRes ->
            if (state.cancelled) {
                activeRequests.remove(requestId)
                return@trySameOriginWebViewFetch
            }
            if (wvRes != null && wvRes.ok && BotPageDetector.isUsableHtml(wvRes.html, wvRes.finalUrl)) {
                deliverResult(
                    requestId = requestId,
                    ok = true,
                    finalUrl = wvRes.finalUrl.ifBlank { targetUrl },
                    html = wvRes.html,
                    winnerLabel = "Android 同源瀏覽器",
                    hadChallenge = false,
                    cancelled = false,
                    error = "",
                    startedAt = startedAt,
                )
                return@trySameOriginWebViewFetch
            }

            // Tier 2: Native HttpURLConnection with CookieManager sync
            executor.execute {
                runTier2Http(requestId, state, targetUrl, allowInteractive, fresh, startedAt)
            }
        }
    }

    fun cancel(requestId: String) {
        val state = activeRequests.remove(requestId) ?: return
        state.cancelled = true
        try {
            state.connection?.disconnect()
        } catch (_: Exception) {
        }
        host.cancelInAppBrowserRescue(requestId)
    }

    fun shutdown() {
        activeRequests.keys.toList().forEach { cancel(it) }
        executor.shutdownNow()
    }

    private fun runTier2Http(
        requestId: String,
        state: RequestState,
        targetUrl: String,
        allowInteractive: Boolean,
        fresh: Boolean,
        startedAt: Long,
    ) {
        if (state.cancelled) {
            activeRequests.remove(requestId)
            return
        }

        val httpAttempt = performHttpGet(state, targetUrl, fresh)
        if (state.cancelled) {
            activeRequests.remove(requestId)
            return
        }

        val html = httpAttempt.html
        val finalUrl = httpAttempt.finalUrl.ifBlank { targetUrl }
        val status = httpAttempt.status

        if (status in 200..299 && BotPageDetector.isUsableHtml(html, finalUrl)) {
            deliverResult(
                requestId = requestId,
                ok = true,
                finalUrl = finalUrl,
                html = html,
                winnerLabel = "Android 原生直連",
                hadChallenge = false,
                cancelled = false,
                error = "",
                startedAt = startedAt,
            )
            return
        }

        val isChallengeOrWall =
            BotPageDetector.isChallenge(html) ||
                BotPageDetector.isPttOver18(html, finalUrl) ||
                status in setOf(403, 406, 429, 503)

        if (isChallengeOrWall && allowInteractive) {
            // Tier 3: Visible In-App Browser BottomSheet rescue
            host.startInAppBrowserRescue(requestId, finalUrl, autoCapture = true) { rescue ->
                if (state.cancelled) {
                    activeRequests.remove(requestId)
                    return@startInAppBrowserRescue
                }
                if (rescue.ok && rescue.html.isNotBlank()) {
                    deliverResult(
                        requestId = requestId,
                        ok = true,
                        finalUrl = rescue.finalUrl.ifBlank { finalUrl },
                        html = rescue.html,
                        winnerLabel = "Android 內建瀏覽器",
                        hadChallenge = true,
                        cancelled = false,
                        error = "",
                        startedAt = startedAt,
                    )
                } else {
                    deliverResult(
                        requestId = requestId,
                        ok = false,
                        finalUrl = rescue.finalUrl.ifBlank { finalUrl },
                        html = "",
                        winnerLabel = "",
                        hadChallenge = true,
                        cancelled = rescue.cancelled,
                        error = rescue.error.ifBlank { if (rescue.cancelled) "已取消內建瀏覽器驗證" else "內建瀏覽器未取得可用內容" },
                        startedAt = startedAt,
                    )
                }
            }
            return
        }

        deliverResult(
            requestId = requestId,
            ok = false,
            finalUrl = finalUrl,
            html = "",
            winnerLabel = "",
            hadChallenge = isChallengeOrWall,
            cancelled = false,
            error = httpAttempt.error.ifBlank { if (isChallengeOrWall) "網站防火牆／真人驗證" else "HTTP $status" },
            startedAt = startedAt,
        )
    }

    private data class HttpAttempt(
        val status: Int,
        val finalUrl: String,
        val html: String,
        val error: String = "",
    )

    private fun performHttpGet(state: RequestState, startUrl: String, fresh: Boolean): HttpAttempt {
        var currentUrl = startUrl
        val cookieManager = runCatching { CookieManager.getInstance() }.getOrNull()
        val ua = host.getWebViewUserAgent()

        for (hop in 0 until 6) {
            if (state.cancelled) return HttpAttempt(0, currentUrl, "", "已取消")
            if (!isAllowedHttpUrl(currentUrl)) return HttpAttempt(403, currentUrl, "", "目標網址不允許連線")

            var conn: HttpURLConnection? = null
            try {
                val urlObj = URL(currentUrl)
                conn = (urlObj.openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    requestMethod = "GET"
                    connectTimeout = 10_000
                    readTimeout = 12_000
                    useCaches = !fresh
                    setRequestProperty("User-Agent", ua)
                    setRequestProperty(
                        "Accept",
                        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
                    )
                    setRequestProperty("Accept-Language", "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7")
                    setRequestProperty("Upgrade-Insecure-Requests", "1")
                    if (fresh) {
                        setRequestProperty("Cache-Control", "no-cache")
                    }

                    val existingCookie = cookieManager?.getCookie(currentUrl)
                    val hostLower = urlObj.host.lowercase()
                    val cookieHeader = buildString {
                        if (!existingCookie.isNullOrBlank()) append(existingCookie)
                        if ((hostLower == "www.ptt.cc" || hostLower == "ptt.cc") &&
                            (existingCookie == null || !existingCookie.contains("over18=1"))
                        ) {
                            if (isNotEmpty()) append("; ")
                            append("over18=1")
                        }
                    }
                    if (cookieHeader.isNotEmpty()) {
                        setRequestProperty("Cookie", cookieHeader)
                    }
                }
                state.connection = conn

                val code = conn.responseCode
                // Sync Set-Cookie back to CookieManager
                val setCookies = conn.headerFields["Set-Cookie"] ?: conn.headerFields["set-cookie"]
                if (cookieManager != null && setCookies != null) {
                    for (cookie in setCookies) {
                        cookieManager.setCookie(currentUrl, cookie)
                    }
                }

                if (code in 300..399) {
                    val location = conn.getHeaderField("Location")
                    if (!location.isNullOrBlank()) {
                        currentUrl = URL(urlObj, location).toString()
                        continue
                    }
                }

                val stream = if (code >= 400) conn.errorStream ?: conn.inputStream else conn.inputStream
                val bytes = if (stream != null) readUpToBytes(stream, MAX_HTML_BYTES) else ByteArray(0)
                val contentType = conn.contentType ?: ""
                val decoded = CharsetDecoder.decodeHtmlBytes(bytes, contentType)
                return HttpAttempt(code, currentUrl, decoded)
            } catch (e: Exception) {
                return HttpAttempt(0, currentUrl, "", e.message ?: "連線失敗")
            } finally {
                state.connection = null
                try {
                    conn?.disconnect()
                } catch (_: Exception) {
                }
            }
        }
        return HttpAttempt(0, currentUrl, "", "重新導向次數過多")
    }

    private fun readUpToBytes(input: java.io.InputStream, maxBytes: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var total = 0
        while (total < maxBytes) {
            val read = input.read(buf, 0, minOf(buf.size, maxBytes - total))
            if (read <= 0) break
            out.write(buf, 0, read)
            total += read
        }
        return out.toByteArray()
    }

    private fun deliverResult(
        requestId: String,
        ok: Boolean,
        finalUrl: String,
        html: String,
        winnerLabel: String,
        hadChallenge: Boolean,
        cancelled: Boolean,
        error: String,
        startedAt: Long,
    ) {
        activeRequests.remove(requestId)
        val json = JSONObject().apply {
            put("ok", ok)
            put("finalUrl", finalUrl)
            put("html", html)
            put("winnerLabel", winnerLabel)
            put("hadChallenge", hadChallenge)
            put("cancelled", cancelled)
            put("error", error)
            put("elapsedMs", (System.currentTimeMillis() - startedAt).coerceAtLeast(1L))
        }
        host.deliverFetchResult(requestId, json.toString())
    }

    companion object {
        private const val MAX_HTML_BYTES = 6 * 1024 * 1024

        private val DOMAIN_MAP = mapOf(
            "look.twword.com" to "www.novel543.com",
            "look.thisiscm.com" to "www.novel543.com",
        )

        fun normalizeTargetUrl(raw: String): String {
            return try {
                val u = URL(raw.trim())
                val mappedHost = DOMAIN_MAP[u.host.lowercase()]
                if (mappedHost != null) {
                    URL(u.protocol, mappedHost, u.port, u.file).toString()
                } else {
                    u.toString()
                }
            } catch (_: Exception) {
                raw.trim()
            }
        }

        fun isAllowedHttpUrl(rawUrl: String): Boolean {
            return try {
                val u = URL(rawUrl)
                val proto = u.protocol.lowercase()
                if (proto != "http" && proto != "https") return false
                val host = u.host.lowercase().trim('[', ']')
                if (host.isBlank() || host == "localhost" || host == "::1" || host == "0.0.0.0" ||
                    host.endsWith(".local") || host.endsWith(".internal")
                ) {
                    return false
                }
                val addr = InetAddress.getByName(host)
                !(addr.isAnyLocalAddress || addr.isLoopbackAddress || addr.isLinkLocalAddress || addr.isSiteLocalAddress)
            } catch (_: Exception) {
                false
            }
        }
    }
}
