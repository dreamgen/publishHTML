package io.github.dreamgen.purereader

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Thread-safe token store for passing large HTML/JSON payloads from Kotlin to WebView
 * without escaping strings into evaluateJavascript().
 */
class PayloadStore {
    private val store = ConcurrentHashMap<String, String>()

    fun put(payloadJson: String): String {
        val token = UUID.randomUUID().toString()
        store[token] = payloadJson
        return token
    }

    fun consume(token: String?): String {
        if (token.isNullOrBlank()) return ""
        return store.remove(token) ?: ""
    }

    fun size(): Int = store.size
}
