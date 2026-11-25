package io.github.dreamgen.purereader

import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * Decodes HTML response bytes with BOM -> declared header/meta charset -> strict UTF-8 -> CJK heuristic.
 */
object CharsetDecoder {
    private val HEADER_CHARSET_REGEX = Regex("charset\\s*=\\s*([^\\s;]+)", RegexOption.IGNORE_CASE)
    private val META_CHARSET_1 = Regex("<meta[^>]+charset\\s*=\\s*[\"']?\\s*([a-zA-Z0-9._-]+)", RegexOption.IGNORE_CASE)
    private val META_CHARSET_2 = Regex("<meta[^>]+content\\s*=\\s*[\"'][^\"']*charset\\s*=\\s*([a-zA-Z0-9._-]+)", RegexOption.IGNORE_CASE)
    private val META_XML_ENC = Regex("<\\?xml[^>]+encoding\\s*=\\s*[\"']([a-zA-Z0-9._-]+)", RegexOption.IGNORE_CASE)
    private val CJK_REGEX = Regex("[\\u4e00-\\u9fff]")

    fun normalizeCharsetName(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val c = raw.trim().lowercase().trim('"', '\'')
        return when (c) {
            "utf8", "utf-8" -> "utf-8"
            "gb2312", "gbk", "gb_2312", "gb_2312-80", "x-gbk", "csgb2312", "gb18030" -> "GB18030"
            "big5", "big5-hkscs", "cp950", "csbig5", "x-x-big5" -> "Big5"
            "shift_jis", "shift-jis", "sjis", "x-sjis", "ms932", "windows-31j" -> "Shift_JIS"
            "euc-jp", "eucjp" -> "EUC-JP"
            "euc-kr", "euckr", "ks_c_5601-1987", "cp949" -> "EUC-KR"
            "iso-8859-1", "latin1", "windows-1252" -> "windows-1252"
            else -> c
        }
    }

    fun decodeHtmlBytes(bytes: ByteArray, contentTypeHeader: String? = null): String {
        if (bytes.isEmpty()) return ""

        // 1. BOM
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
            return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
            return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
            return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
        }

        // 2. Inspect header & <meta charset>
        val headerCharset = normalizeCharsetName(
            HEADER_CHARSET_REGEX.find(contentTypeHeader ?: "")?.groupValues?.getOrNull(1)
        )
        val headLen = minOf(bytes.size, 4096)
        val asciiHead = String(bytes, 0, headLen, Charsets.ISO_8859_1)
        val metaRaw = (
            META_CHARSET_1.find(asciiHead)
                ?: META_CHARSET_2.find(asciiHead)
                ?: META_XML_ENC.find(asciiHead)
            )?.groupValues?.getOrNull(1)
        val metaCharset = normalizeCharsetName(metaRaw)

        // 3. Strict UTF-8 validity check
        val strictUtf8 = decodeStrictUtf8(bytes)
        if (strictUtf8 != null) {
            val declaredNonUtf8 =
                (headerCharset.isNotEmpty() && headerCharset != "utf-8") ||
                    (metaCharset.isNotEmpty() && metaCharset != "utf-8")
            if (!declaredNonUtf8 || strictUtf8.any { it.code >= 0x80 }) {
                return strictUtf8
            }
        }

        // 4. Declared non-UTF-8 charset
        val declared = when {
            headerCharset.isNotEmpty() && headerCharset != "utf-8" -> headerCharset
            metaCharset.isNotEmpty() && metaCharset != "utf-8" -> metaCharset
            else -> ""
        }
        if (declared.isNotEmpty()) {
            decodeCharsetOrNull(bytes, declared)?.let { return it }
        }

        // 5. Fallback heuristic
        val utf8Loose = String(bytes, Charsets.UTF_8)
        val utf8Bad = utf8Loose.count { it == '\uFFFD' }
        if (utf8Bad == 0) return utf8Loose

        var bestText = utf8Loose
        var bestScore = CJK_REGEX.findAll(utf8Loose).count() - utf8Bad * 10
        for (candidate in listOf("GB18030", "Big5", "Shift_JIS")) {
            val decoded = decodeCharsetOrNull(bytes, candidate) ?: continue
            val bad = decoded.count { it == '\uFFFD' }
            val score = CJK_REGEX.findAll(decoded).count() - bad * 10
            if (score > bestScore) {
                bestScore = score
                bestText = decoded
            }
        }
        return bestText
    }

    private fun decodeStrictUtf8(bytes: ByteArray): String? {
        return try {
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: Exception) {
            null
        }
    }

    private fun decodeCharsetOrNull(bytes: ByteArray, charsetName: String): String? {
        return try {
            val cs = Charset.forName(charsetName)
            String(bytes, cs)
        } catch (_: Exception) {
            null
        }
    }
}
