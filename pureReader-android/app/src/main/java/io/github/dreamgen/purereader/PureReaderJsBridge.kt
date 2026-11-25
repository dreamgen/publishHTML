package io.github.dreamgen.purereader

import android.webkit.JavascriptInterface

/**
 * JavaScript bridge exposed ONLY to the trusted readerWebView (https://appassets.purereader.local/).
 * Never attach this bridge to the untrusted inAppWebView!
 */
class PureReaderJsBridge(
    private val host: BridgeHost,
    private val payloadStore: PayloadStore,
) {
    interface BridgeHost {
        fun onWebReady()
        fun onRequestFetch(requestId: String, url: String, allowInteractive: Boolean, fresh: Boolean)
        fun onCancelFetch(requestId: String)
        fun onOpenInAppBrowser(url: String, autoCapture: Boolean)
        fun onSetKeepScreenOn(keepOn: Boolean)
        fun onSetThemeDark(isDark: Boolean)
        fun onSaveBase64File(filename: String, mimeType: String, base64Data: String)
        fun getUpdateSettingsJson(): String
        fun saveUpdateSettingsJson(settingsJson: String): String
        fun onCheckAppUpdate(manual: Boolean)
        fun onInstallAppUpdate()
        fun isNativeTtsAvailable(): Boolean
        fun getNativeTtsVoicesJson(): String
        fun onStartNativeTts(chapterTitle: String, paragraphsJson: String, startIndex: Int, rate: Float, voiceName: String)
        fun onPauseNativeTts()
        fun onResumeNativeTts()
        fun onStopNativeTts()
    }

    @JavascriptInterface
    fun isAndroidApp(): Boolean = true

    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getAppVersionCode(): Int = BuildConfig.VERSION_CODE

    @JavascriptInterface
    fun notifyWebReady() {
        host.onWebReady()
    }

    @JavascriptInterface
    fun requestFetch(requestId: String, url: String, allowInteractive: Boolean, fresh: Boolean) {
        host.onRequestFetch(requestId, url, allowInteractive, fresh)
    }

    @JavascriptInterface
    fun cancelFetch(requestId: String) {
        host.onCancelFetch(requestId)
    }

    @JavascriptInterface
    fun openInAppBrowser(url: String, autoCapture: Boolean) {
        host.onOpenInAppBrowser(url, autoCapture)
    }

    @JavascriptInterface
    fun consumePayload(token: String?): String = payloadStore.consume(token)

    @JavascriptInterface
    fun setKeepScreenOn(keepOn: Boolean) {
        host.onSetKeepScreenOn(keepOn)
    }

    @JavascriptInterface
    fun setThemeDark(isDark: Boolean) {
        host.onSetThemeDark(isDark)
    }

    @JavascriptInterface
    fun saveBase64File(filename: String, mimeType: String, base64Data: String) {
        host.onSaveBase64File(filename, mimeType, base64Data)
    }

    @JavascriptInterface
    fun getUpdateSettingsJson(): String = host.getUpdateSettingsJson()

    @JavascriptInterface
    fun saveUpdateSettingsJson(settingsJson: String?): String =
        host.saveUpdateSettingsJson(settingsJson ?: "{}")

    @JavascriptInterface
    fun checkAppUpdate(manual: Boolean) {
        host.onCheckAppUpdate(manual)
    }

    @JavascriptInterface
    fun installAppUpdate() {
        host.onInstallAppUpdate()
    }

    @JavascriptInterface
    fun isNativeTtsAvailable(): Boolean = host.isNativeTtsAvailable()

    @JavascriptInterface
    fun getNativeTtsVoicesJson(): String = host.getNativeTtsVoicesJson()

    @JavascriptInterface
    fun startNativeTts(chapterTitle: String, paragraphsJson: String, startIndex: Int, rate: Float, voiceName: String) {
        host.onStartNativeTts(chapterTitle, paragraphsJson, startIndex, rate, voiceName)
    }

    @JavascriptInterface
    fun pauseNativeTts() {
        host.onPauseNativeTts()
    }

    @JavascriptInterface
    fun resumeNativeTts() {
        host.onResumeNativeTts()
    }

    @JavascriptInterface
    fun stopNativeTts() {
        host.onStopNativeTts()
    }
}
