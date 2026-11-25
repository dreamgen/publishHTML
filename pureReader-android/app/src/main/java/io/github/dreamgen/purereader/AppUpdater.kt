package io.github.dreamgen.purereader

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Self-hosted GitHub Releases auto-updater for personal PureReader Android installs.
 * Checks version.json -> downloads signed APK -> verifies SHA-256 -> launches Android installer.
 */
class AppUpdater(
    private val context: Context,
    private val onStateChanged: (String) -> Unit,
) {
    data class ManifestInfo(
        val versionCode: Long,
        val versionName: String,
        val apkUrl: String,
        val sha256: String,
        val notes: String,
        val updatedAt: String,
    )

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var checking = false

    @Volatile
    private var downloading = false

    @Volatile
    private var downloadProgress = 0

    @Volatile
    private var updateAvailable = false

    @Volatile
    private var latestManifest: ManifestInfo? = null

    @Volatile
    private var lastStatus = ""

    @Volatile
    private var lastError = ""

    @Volatile
    private var pendingInstallFile: File? = null

    fun isAutoCheckEnabled(): Boolean = prefs.getBoolean(KEY_AUTO_CHECK, true)

    fun isWifiOnlyEnabled(): Boolean = prefs.getBoolean(KEY_WIFI_ONLY, false)

    fun isAutoDownloadEnabled(): Boolean = prefs.getBoolean(KEY_AUTO_DOWNLOAD, false)

    fun getManifestUrl(): String {
        val saved = prefs.getString(KEY_MANIFEST_URL, null)?.trim().orEmpty()
        return if (isValidHttpsUrl(saved)) saved else BuildConfig.UPDATE_MANIFEST_URL
    }

    fun saveSettingsJson(rawJson: String): String {
        try {
            val obj = JSONObject(rawJson)
            val editor = prefs.edit()
            if (obj.has("autoCheckEnabled")) {
                editor.putBoolean(KEY_AUTO_CHECK, obj.optBoolean("autoCheckEnabled", true))
            }
            if (obj.has("wifiOnly")) {
                editor.putBoolean(KEY_WIFI_ONLY, obj.optBoolean("wifiOnly", false))
            }
            if (obj.has("autoDownload")) {
                editor.putBoolean(KEY_AUTO_DOWNLOAD, obj.optBoolean("autoDownload", false))
            }
            if (obj.has("manifestUrl")) {
                val candidate = obj.optString("manifestUrl", "").trim()
                if (candidate.isEmpty()) {
                    editor.remove(KEY_MANIFEST_URL)
                } else if (isValidHttpsUrl(candidate)) {
                    editor.putString(KEY_MANIFEST_URL, candidate)
                } else {
                    lastError = "更新來源網址必須為 https://"
                    emitState()
                    return getStateJson()
                }
            }
            editor.apply()
            lastError = ""
            if (lastStatus.isBlank()) {
                lastStatus = "已儲存更新設定"
            }
        } catch (_: Exception) {
            lastError = "無法解析更新設定"
        }
        emitState()
        return getStateJson()
    }

    fun getStateJson(): String {
        val m = latestManifest
        return JSONObject().apply {
            put("versionCode", BuildConfig.VERSION_CODE)
            put("versionName", BuildConfig.VERSION_NAME)
            put("autoCheckEnabled", isAutoCheckEnabled())
            put("wifiOnly", isWifiOnlyEnabled())
            put("autoDownload", isAutoDownloadEnabled())
            put("manifestUrl", getManifestUrl())
            put("defaultManifestUrl", BuildConfig.UPDATE_MANIFEST_URL)
            put("lastCheckedAt", prefs.getLong(KEY_LAST_CHECKED_AT, 0L))
            put("checking", checking)
            put("downloading", downloading)
            put("downloadProgress", downloadProgress)
            put("updateAvailable", updateAvailable)
            put("latestVersionCode", m?.versionCode ?: BuildConfig.VERSION_CODE.toLong())
            put("latestVersionName", m?.versionName ?: "")
            put("releaseNotes", m?.notes ?: "")
            put("updatedAt", m?.updatedAt ?: "")
            put("statusMessage", lastStatus)
            put("error", lastError)
            put("readyToInstall", hasVerifiedDownloadedApk(m))
        }.toString()
    }

    fun maybeAutoCheckOnStartup() {
        if (!isAutoCheckEnabled()) return
        val lastAt = prefs.getLong(KEY_LAST_CHECKED_AT, 0L)
        if (System.currentTimeMillis() - lastAt < AUTO_CHECK_INTERVAL_MS) return
        if (isWifiOnlyEnabled() && !isOnUnmeteredOrWifi()) return
        checkForUpdate(manual = false)
    }

    fun checkForUpdate(manual: Boolean) {
        if (checking || downloading) {
            emitState()
            return
        }
        if (isWifiOnlyEnabled() && !manual && !isOnUnmeteredOrWifi()) {
            return
        }
        checking = true
        lastError = ""
        lastStatus = if (manual) "正在檢查最新版本…" else ""
        emitState()

        val manifestUrl = getManifestUrl()
        executor.execute {
            try {
                val sep = if (manifestUrl.contains("?")) "&" else "?"
                val jsonText = httpGetText("$manifestUrl${sep}t=${System.currentTimeMillis()}")
                val parsed = parseManifest(jsonText, BuildConfig.VERSION_CODE.toLong())
                prefs.edit().putLong(KEY_LAST_CHECKED_AT, System.currentTimeMillis()).apply()

                if (parsed == null) {
                    checking = false
                    lastError = if (manual) "更新資訊格式無效或尚未發布版本" else ""
                    lastStatus = ""
                    emitState()
                    return@execute
                }

                latestManifest = parsed
                val hasNew = parsed.versionCode > BuildConfig.VERSION_CODE.toLong()
                updateAvailable = hasNew
                checking = false
                lastError = ""
                lastStatus = if (hasNew) {
                    "發現新版本 v${parsed.versionName} (Build ${parsed.versionCode})"
                } else {
                    "目前已是最新版本 v${BuildConfig.VERSION_NAME}"
                }
                emitState()

                if (hasNew && isAutoDownloadEnabled() && (!isWifiOnlyEnabled() || isOnUnmeteredOrWifi())) {
                    startDownloadAndInstall(launchInstallerAfter = manual)
                }
            } catch (e: Exception) {
                checking = false
                lastStatus = ""
                lastError = if (manual) "檢查更新失敗：${e.message ?: "連線失敗"}" else ""
                emitState()
            }
        }
    }

    fun installOrDownloadUpdate() {
        if (downloading) return
        val m = latestManifest
        if (m == null || !updateAvailable) {
            checkForUpdate(manual = true)
            return
        }
        if (isWifiOnlyEnabled() && !isOnUnmeteredOrWifi()) {
            lastError = "已啟用僅在 Wi-Fi 下載，請連接 Wi-Fi 或調整設定"
            emitState()
            return
        }
        val cachedApk = getUpdateApkFile(m.versionCode)
        if (hasVerifiedDownloadedApk(m)) {
            triggerInstallerWithPermissionCheck(cachedApk)
            return
        }
        startDownloadAndInstall(launchInstallerAfter = true)
    }

    fun onHostResume() {
        val pending = pendingInstallFile ?: return
        if (!pending.isFile) {
            pendingInstallFile = null
            return
        }
        if (canInstallPackages()) {
            pendingInstallFile = null
            launchApkInstaller(pending)
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    private fun startDownloadAndInstall(launchInstallerAfter: Boolean) {
        val m = latestManifest ?: return
        if (downloading) return
        downloading = true
        downloadProgress = 0
        lastError = ""
        lastStatus = "正在下載 v${m.versionName}…"
        emitState()

        executor.execute {
            val targetFile = getUpdateApkFile(m.versionCode)
            val tempFile = File(targetFile.parentFile, "${targetFile.name}.part")
            try {
                targetFile.parentFile?.mkdirs()
                cleanStaleUpdateApks(excludeVersionCode = m.versionCode)

                downloadFileWithRedirects(m.apkUrl, tempFile) { pct ->
                    downloadProgress = pct
                    lastStatus = if (pct > 0) "正在下載更新 ($pct%)…" else "正在下載更新…"
                    emitState()
                }

                if (m.sha256.isNotBlank()) {
                    val actualHash = sha256Hex(tempFile)
                    if (!actualHash.equals(m.sha256, ignoreCase = true)) {
                        tempFile.delete()
                        downloading = false
                        downloadProgress = 0
                        lastStatus = ""
                        lastError = "APK 校驗失敗（SHA-256 不符）"
                        emitState()
                        return@execute
                    }
                }

                if (targetFile.exists()) targetFile.delete()
                if (!tempFile.renameTo(targetFile)) {
                    tempFile.copyTo(targetFile, overwrite = true)
                    tempFile.delete()
                }

                downloading = false
                downloadProgress = 100
                lastStatus = if (launchInstallerAfter) "下載完成，正在開啟系統安裝器…" else "已預先下載 v${m.versionName}，可隨時安裝"
                emitState()

                if (launchInstallerAfter) {
                    mainHandler.post { triggerInstallerWithPermissionCheck(targetFile) }
                }
            } catch (e: Exception) {
                tempFile.delete()
                downloading = false
                downloadProgress = 0
                lastStatus = ""
                lastError = "下載更新失敗：${e.message ?: "網路錯誤"}"
                emitState()
            }
        }
    }

    private fun canInstallPackages(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || appContext.packageManager.canRequestPackageInstalls()
    }

    private fun triggerInstallerWithPermissionCheck(apkFile: File) {
        if (!apkFile.isFile) {
            lastError = "找不到下載的安裝檔，請重新下載"
            emitState()
            return
        }
        if (!canInstallPackages()) {
            pendingInstallFile = apkFile
            lastStatus = "請允許「安裝未知應用程式」後返回，將自動繼續安裝"
            emitState()
            Toast.makeText(context, "請開啟「允許來自此來源的應用程式」權限，返回後將自動安裝", Toast.LENGTH_LONG).show()
            try {
                val permIntent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${appContext.packageName}")
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(permIntent)
            } catch (_: Exception) {
                lastError = "無法開啟安裝權限設定頁"
                emitState()
            }
            return
        }
        launchApkInstaller(apkFile)
    }

    private fun launchApkInstaller(apkFile: File) {
        try {
            val contentUri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.fileprovider", apkFile)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(contentUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            lastError = "無法啟動系統安裝器：${e.message}"
            emitState()
        }
    }

    private fun getUpdateApkFile(versionCode: Long): File {
        return File(File(appContext.cacheDir, "updates"), "PureReader-v$versionCode.apk")
    }

    private fun hasVerifiedDownloadedApk(m: ManifestInfo?): Boolean {
        if (m == null) return false
        val file = getUpdateApkFile(m.versionCode)
        if (!file.isFile || file.length() < 100_000L) return false
        if (m.sha256.isBlank()) return true
        return sha256Hex(file).equals(m.sha256, ignoreCase = true)
    }

    private fun cleanStaleUpdateApks(excludeVersionCode: Long) {
        val dir = File(appContext.cacheDir, "updates")
        val keepName = "PureReader-v$excludeVersionCode.apk"
        dir.listFiles()?.forEach { f ->
            if (f.name != keepName) f.delete()
        }
    }

    private fun isOnUnmeteredOrWifi(): Boolean {
        val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    private fun emitState() {
        val payload = getStateJson()
        mainHandler.post { onStateChanged(payload) }
    }

    companion object {
        private const val PREFS_NAME = "purereader_updater"
        private const val KEY_AUTO_CHECK = "auto_check_enabled"
        private const val KEY_WIFI_ONLY = "wifi_only_download"
        private const val KEY_AUTO_DOWNLOAD = "auto_download_enabled"
        private const val KEY_MANIFEST_URL = "manifest_url"
        private const val KEY_LAST_CHECKED_AT = "last_checked_at"
        private const val AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L

        fun isValidHttpsUrl(rawUrl: String?): Boolean {
            if (rawUrl.isNullOrBlank()) return false
            return try {
                val u = URL(rawUrl.trim())
                u.protocol.equals("https", ignoreCase = true) && !u.host.isNullOrBlank()
            } catch (_: Exception) {
                false
            }
        }

        fun parseManifest(rawJson: String?, currentVersionCode: Long): ManifestInfo? {
            if (rawJson.isNullOrBlank()) return null
            return try {
                val obj = JSONObject(rawJson)
                val vc = obj.optLong("versionCode", 0L)
                val vn = obj.optString("versionName", "").trim()
                val apkUrl = obj.optString("apkUrl", "").trim()
                val sha256 = obj.optString("sha256", "").trim().lowercase()
                val notes = obj.optString("notes", "").trim()
                val updatedAt = obj.optString("updatedAt", "").trim()
                if (vc <= 0L || vn.isBlank() || !isValidHttpsUrl(apkUrl)) return null
                if (sha256.isNotEmpty() && !Regex("^[a-f0-9]{64}$").matches(sha256)) return null
                ManifestInfo(
                    versionCode = vc,
                    versionName = vn.ifBlank { currentVersionCode.toString() },
                    apkUrl = apkUrl,
                    sha256 = sha256,
                    notes = notes,
                    updatedAt = updatedAt,
                )
            } catch (_: Exception) {
                null
            }
        }

        private fun openHttpsFollowingRedirects(rawUrl: String, maxHops: Int = 5): HttpURLConnection {
            var current = rawUrl
            repeat(maxHops) {
                require(isValidHttpsUrl(current)) { "僅支援 HTTPS 更新來源" }
                val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    connectTimeout = 10_000
                    readTimeout = 20_000
                    setRequestProperty("User-Agent", "PureReaderAndroid/${BuildConfig.VERSION_NAME}")
                    setRequestProperty("Cache-Control", "no-cache")
                }
                val code = conn.responseCode
                if (code in setOf(301, 302, 303, 307, 308)) {
                    val loc = conn.getHeaderField("Location").orEmpty()
                    conn.disconnect()
                    require(loc.isNotBlank()) { "重導向網址為空" }
                    current = URL(URL(current), loc).toString()
                } else {
                    return conn
                }
            }
            throw IllegalStateException("重導向次數過多")
        }

        private fun httpGetText(url: String): String {
            val conn = openHttpsFollowingRedirects(url)
            try {
                val code = conn.responseCode
                if (code !in 200..299) throw IllegalStateException("HTTP $code")
                return conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            } finally {
                conn.disconnect()
            }
        }

        private fun downloadFileWithRedirects(
            url: String,
            destFile: File,
            onProgress: (Int) -> Unit,
        ) {
            val conn = openHttpsFollowingRedirects(url)
            try {
                val code = conn.responseCode
                if (code !in 200..299) throw IllegalStateException("HTTP $code")
                val total = conn.contentLengthLong
                var downloaded = 0L
                var lastPct = -1
                conn.inputStream.use { input ->
                    FileOutputStream(destFile).use { out ->
                        val buf = ByteArray(16 * 1024)
                        while (true) {
                            val read = input.read(buf)
                            if (read <= 0) break
                            out.write(buf, 0, read)
                            downloaded += read
                            if (total > 0) {
                                val pct = ((downloaded * 100) / total).toInt().coerceIn(0, 100)
                                if (pct != lastPct && (pct % 5 == 0 || pct == 100)) {
                                    lastPct = pct
                                    onProgress(pct)
                                }
                            }
                        }
                    }
                }
            } finally {
                conn.disconnect()
            }
        }

        private fun sha256Hex(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(16 * 1024)
                while (true) {
                    val read = input.read(buf)
                    if (read <= 0) break
                    md.update(buf, 0, read)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
