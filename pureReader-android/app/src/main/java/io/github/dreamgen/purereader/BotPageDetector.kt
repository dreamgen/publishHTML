package io.github.dreamgen.purereader

/**
 * Mirrors PureExtractor's challenge/error/PTT page detection in pure Kotlin.
 * Intentionally ignores cloudflareinsights beacons and challenge-platform jsd scripts on valid pages.
 */
object BotPageDetector {
    private val SCRIPT_STYLE_REGEX = Regex("<(?:script|style|noscript)\\b[^>]*>[\\s\\S]*?</(?:script|style|noscript)>", RegexOption.IGNORE_CASE)
    private val COMMENT_REGEX = Regex("<!--[\\s\\S]*?-->")
    private val TAG_REGEX = Regex("<[^>]+>")
    private val WHITESPACE_REGEX = Regex("\\s+")
    private val HUMAN_WALL_REGEX = Regex(
        "DDoS-Guard|Access Denied.*Reference #|Please verify you are a human|Verify you are human|Checking your browser before accessing",
        RegexOption.IGNORE_CASE
    )
    private val SOFT_ERROR_REGEX = Regex(
        "^(?:error\\s*)?(?:400|401|403|404|410|429|500|502|503|504)\\b|403 Forbidden|404 Not Found|502 Bad Gateway|503 Service(?: Temporarily)? Unavailable|Access Denied|Page Not Found",
        RegexOption.IGNORE_CASE
    )

    private val CHALLENGE_MARKERS = listOf(
        "cf-browser-verification",
        "Just a moment...",
        "Checking if the site connection is secure",
        "_cf_chl_opt",
        "cf_chl_",
        "id=\"challenge-running\"",
        "id=\"challenge-stage\"",
        "Attention Required! | Cloudflare",
        "_Incapsula_Resource",
        "px-captcha",
        "Enable JavaScript and cookies to continue"
    )

    fun stripTagsQuick(html: String?): String {
        if (html.isNullOrEmpty()) return ""
        return html
            .replace(SCRIPT_STYLE_REGEX, " ")
            .replace(COMMENT_REGEX, " ")
            .replace(TAG_REGEX, " ")
            .replace("&nbsp;", " ", ignoreCase = true)
            .replace("&#160;", " ")
            .replace(WHITESPACE_REGEX, " ")
            .trim()
    }

    fun isChallenge(html: String?): Boolean {
        if (html.isNullOrEmpty()) return false
        for (marker in CHALLENGE_MARKERS) {
            if (html.contains(marker)) return true
        }
        if (html.length < 25_000 && html.contains("Cloudflare") && html.contains("Ray ID")) {
            return true
        }
        if (html.length < 15_000) {
            val visible = stripTagsQuick(html)
            if (visible.length < 300 && HUMAN_WALL_REGEX.containsMatchIn(visible)) {
                return true
            }
        }
        return false
    }

    fun isSoftError(html: String?): Boolean {
        if (html.isNullOrEmpty()) return true
        if (html.length > 18_000) return false
        val visible = stripTagsQuick(html)
        if (visible.length > 260) return false
        return SOFT_ERROR_REGEX.containsMatchIn(visible)
    }

    fun isPttOver18(html: String?, url: String = ""): Boolean {
        if (html.isNullOrEmpty()) return false
        if (url.isNotEmpty() && !url.contains("ptt.cc", ignoreCase = true)) return false
        return html.contains("/ask/over18") && html.contains("年滿十八歲")
    }

    fun isUsableHtml(html: String?, url: String = ""): Boolean {
        if (html.isNullOrEmpty() || html.length < 400) return false
        if (isChallenge(html)) return false
        if (isSoftError(html)) return false
        if (isPttOver18(html, url)) return false
        return true
    }
}
