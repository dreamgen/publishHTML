package io.github.dreamgen.purereader

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BotPageDetectorTest {

    @Test
    fun detectsCloudflareChallengeMarkers() {
        val challengeHtml = """
            <!DOCTYPE html>
            <html><head><title>Just a moment...</title></head>
            <body>
              <div id="challenge-running">Checking if the site connection is secure</div>
              <script>window._cf_chl_opt = { cvId: '3' };</script>
            </body></html>
        """.trimIndent()

        assertTrue(BotPageDetector.isChallenge(challengeHtml))
        assertFalse(BotPageDetector.isUsableHtml(challengeHtml, "https://www.novel543.com/123.html"))
    }

    @Test
    fun ignoresCloudflareInsightsBeaconOnValidPage() {
        val validArticle = buildString {
            append("<!DOCTYPE html><html><head><title>第一章 初入江湖</title></head><body>")
            append("<article><p>")
            repeat(30) { append("這是一段正常的繁體中文小說正文內容，用來測試不會被誤判為 Cloudflare 驗證頁。") }
            append("</p></article>")
            append("<script defer src=\"https://static.cloudflareinsights.com/beacon.min.js\"></script>")
            append("<script src=\"/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js\"></script>")
            append("</body></html>")
        }

        assertFalse(BotPageDetector.isChallenge(validArticle))
        assertTrue(BotPageDetector.isUsableHtml(validArticle, "https://www.novel543.com/0303/1.html"))
    }

    @Test
    fun detectsPttOver18GateOnlyForPtt() {
        val pttGate = """
            <html><body><form action="/ask/over18" method="post">
            我同意，我已年滿十八歲。
            </form></body></html>
        """.trimIndent().padEnd(600, ' ')

        assertTrue(BotPageDetector.isPttOver18(pttGate, "https://www.ptt.cc/bbs/Gossiping/index.html"))
        assertFalse(BotPageDetector.isUsableHtml(pttGate, "https://www.ptt.cc/bbs/Gossiping/index.html"))
        assertFalse(BotPageDetector.isPttOver18(pttGate, "https://example.com/article"))
    }

    @Test
    fun detectsShortSoftErrorPage() {
        val errHtml = "<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>".padEnd(500, ' ')
        assertTrue(BotPageDetector.isSoftError(errHtml))
        assertFalse(BotPageDetector.isUsableHtml(errHtml, "https://example.com/1"))
    }
}
