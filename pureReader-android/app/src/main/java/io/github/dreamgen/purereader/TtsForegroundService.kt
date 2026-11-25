package io.github.dreamgen.purereader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Foreground Service driving native Android TextToSpeech with PARTIAL_WAKE_LOCK
 * so novel listening continues smoothly when the screen turns off.
 */
class TtsForegroundService : Service(), TextToSpeech.OnInitListener {

    interface TtsEventListener {
        fun onTtsEvent(eventJson: String)
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pendingStart = false
    private var wakeLock: PowerManager.WakeLock? = null

    private var chapterTitle: String = "淨讀器朗讀"
    private var paragraphs: List<String> = emptyList()
    private var currentIndex: Int = 0
    private var speechRate: Float = 1.0f
    private var preferredVoiceName: String = ""
    private var isPlaying: Boolean = false
    private var activeUtteranceSeq: Long = 0L

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        tts = TextToSpeech(applicationContext, this)
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            ttsReady = true
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    // Handled before speak()
                }

                override fun onDone(utteranceId: String?) {
                    val expected = "pr_utt_${activeUtteranceSeq}_$currentIndex"
                    if (utteranceId != expected || !isPlaying) return
                    val nextIdx = currentIndex + 1
                    if (nextIdx < paragraphs.size) {
                        currentIndex = nextIdx
                        emitProgress()
                        updateNotification()
                        speakCurrentInternal()
                    } else {
                        emitEvent(JSONObject().apply {
                            put("type", "chapterEnd")
                            put("index", currentIndex)
                        })
                    }
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    // Ignore interrupted utterances during skip/pause
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    val expected = "pr_utt_${activeUtteranceSeq}_$currentIndex"
                    if (utteranceId == expected && isPlaying) {
                        val nextIdx = currentIndex + 1
                        if (nextIdx < paragraphs.size) {
                            currentIndex = nextIdx
                            emitProgress()
                            speakCurrentInternal()
                        }
                    }
                }
            })
            if (pendingStart && isPlaying) {
                pendingStart = false
                speakCurrentInternal()
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                chapterTitle = intent.getStringExtra(EXTRA_TITLE)?.ifBlank { "淨讀器朗讀" } ?: "淨讀器朗讀"
                val paraJson = intent.getStringExtra(EXTRA_PARAGRAPHS_JSON) ?: "[]"
                paragraphs = parseParagraphs(paraJson)
                currentIndex = intent.getIntExtra(EXTRA_START_INDEX, 0).coerceIn(0, (paragraphs.size - 1).coerceAtLeast(0))
                speechRate = intent.getFloatExtra(EXTRA_RATE, 1.0f).coerceIn(0.5f, 2.5f)
                preferredVoiceName = intent.getStringExtra(EXTRA_VOICE_NAME) ?: ""

                if (paragraphs.isEmpty()) {
                    stopPlaybackAndSelf()
                    return START_NOT_STICKY
                }

                isPlaying = true
                isRunning = true
                acquireWakeLock()
                startForegroundCompat()
                emitState()
                emitProgress()

                if (ttsReady) {
                    speakCurrentInternal()
                } else {
                    pendingStart = true
                }
            }

            ACTION_PAUSE -> {
                if (isPlaying) {
                    isPlaying = false
                    activeUtteranceSeq++
                    tts?.stop()
                    releaseWakeLock()
                    emitState()
                    updateNotification()
                }
            }

            ACTION_RESUME -> {
                if (!isPlaying && paragraphs.isNotEmpty()) {
                    isPlaying = true
                    isRunning = true
                    acquireWakeLock()
                    emitState()
                    updateNotification()
                    if (ttsReady) {
                        speakCurrentInternal()
                    } else {
                        pendingStart = true
                    }
                }
            }

            ACTION_TOGGLE -> {
                if (isPlaying) {
                    onStartCommand(Intent(ACTION_PAUSE), 0, startId)
                } else {
                    onStartCommand(Intent(ACTION_RESUME), 0, startId)
                }
            }

            ACTION_PREV -> {
                if (paragraphs.isNotEmpty() && currentIndex > 0) {
                    currentIndex--
                    isPlaying = true
                    acquireWakeLock()
                    emitState()
                    emitProgress()
                    updateNotification()
                    if (ttsReady) speakCurrentInternal()
                }
            }

            ACTION_NEXT -> {
                if (paragraphs.isNotEmpty()) {
                    if (currentIndex < paragraphs.size - 1) {
                        currentIndex++
                        isPlaying = true
                        acquireWakeLock()
                        emitState()
                        emitProgress()
                        updateNotification()
                        if (ttsReady) speakCurrentInternal()
                    } else {
                        emitEvent(JSONObject().apply {
                            put("type", "chapterEnd")
                            put("index", currentIndex)
                        })
                    }
                }
            }

            ACTION_STOP -> {
                stopPlaybackAndSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun speakCurrentInternal() {
        val engine = tts ?: return
        if (!isPlaying || currentIndex !in paragraphs.indices) return

        applyVoiceAndRate(engine)
        val seq = ++activeUtteranceSeq
        val utteranceId = "pr_utt_${seq}_$currentIndex"
        val text = paragraphs[currentIndex]
        val params = Bundle()
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
    }

    private fun applyVoiceAndRate(engine: TextToSpeech) {
        engine.setSpeechRate(speechRate)
        if (preferredVoiceName.isNotBlank()) {
            val matched = engine.voices?.firstOrNull { it.name == preferredVoiceName }
            if (matched != null) {
                engine.voice = matched
                return
            }
        }
        val tw = Locale.TAIWAN
        if (engine.isLanguageAvailable(tw) >= TextToSpeech.LANG_AVAILABLE) {
            engine.language = tw
        } else {
            engine.language = Locale.CHINESE
        }
    }

    private fun stopPlaybackAndSelf() {
        isPlaying = false
        isRunning = false
        pendingStart = false
        activeUtteranceSeq++
        try {
            tts?.stop()
        } catch (_: Exception) {
        }
        releaseWakeLock()
        emitEvent(JSONObject().apply { put("type", "stopped") })
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val openAppIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val prevIntent = serviceActionPendingIntent(1, ACTION_PREV)
        val toggleIntent = serviceActionPendingIntent(2, ACTION_TOGGLE)
        val nextIntent = serviceActionPendingIntent(3, ACTION_NEXT)
        val stopIntent = serviceActionPendingIntent(4, ACTION_STOP)

        val previewText = paragraphs.getOrNull(currentIndex)?.take(60) ?: ""
        val statusLabel = if (isPlaying) "朗讀中 (${currentIndex + 1}/${paragraphs.size})" else "已暫停 (${currentIndex + 1}/${paragraphs.size})"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(chapterTitle)
            .setContentText("$statusLabel · $previewText")
            .setContentIntent(openAppIntent)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "上一段", prevIntent)
            .addAction(
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (isPlaying) "暫停" else "播放",
                toggleIntent
            )
            .addAction(android.R.drawable.ic_media_next, "下一段", nextIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "結束", stopIntent)
            .build()
    }

    private fun serviceActionPendingIntent(reqCode: Int, action: String): PendingIntent {
        val intent = Intent(this, TtsForegroundService::class.java).apply { this.action = action }
        return PendingIntent.getService(
            this,
            reqCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "淨讀器聽書背景朗讀",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "於背景及關閉螢幕時持續朗讀小說章節"
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PureReader::TtsWakeLock").apply {
                setReferenceCounted(false)
            }
        }
        if (wakeLock?.isHeld != true) {
            wakeLock?.acquire(4 * 60 * 60 * 1000L) // 4h safety cap, refreshed per chapter
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {
        }
    }

    private fun emitProgress() {
        emitEvent(JSONObject().apply {
            put("type", "progress")
            put("index", currentIndex)
        })
    }

    private fun emitState() {
        emitEvent(JSONObject().apply {
            put("type", "state")
            put("playing", isPlaying)
        })
    }

    private fun emitEvent(obj: JSONObject) {
        eventListener?.onTtsEvent(obj.toString())
    }

    private fun parseParagraphs(jsonStr: String): List<String> {
        return try {
            val arr = JSONArray(jsonStr)
            buildList(arr.length()) {
                for (i in 0 until arr.length()) {
                    val t = arr.optString(i, "").trim()
                    if (t.isNotEmpty()) add(t)
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    override fun onDestroy() {
        isRunning = false
        releaseWakeLock()
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (_: Exception) {
        }
        tts = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "purereader_tts_channel"
        private const val NOTIFICATION_ID = 4101

        const val ACTION_START = "io.github.dreamgen.purereader.tts.START"
        const val ACTION_PAUSE = "io.github.dreamgen.purereader.tts.PAUSE"
        const val ACTION_RESUME = "io.github.dreamgen.purereader.tts.RESUME"
        const val ACTION_TOGGLE = "io.github.dreamgen.purereader.tts.TOGGLE"
        const val ACTION_PREV = "io.github.dreamgen.purereader.tts.PREV"
        const val ACTION_NEXT = "io.github.dreamgen.purereader.tts.NEXT"
        const val ACTION_STOP = "io.github.dreamgen.purereader.tts.STOP"

        const val EXTRA_TITLE = "title"
        const val EXTRA_PARAGRAPHS_JSON = "paragraphs_json"
        const val EXTRA_START_INDEX = "start_index"
        const val EXTRA_RATE = "rate"
        const val EXTRA_VOICE_NAME = "voice_name"

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var eventListener: TtsEventListener? = null
    }
}
