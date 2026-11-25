package io.github.dreamgen.purereader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdaterTest {

    @Test
    fun parsesValidManifestWithSha256AndNotes() {
        val validSha = "a".repeat(64)
        val json = """
            {
              "versionCode": 105,
              "versionName": "1.1.5",
              "apkUrl": "https://github.com/dreamgen/publishHTML/releases/download/purereader-latest/PureReader-latest.apk",
              "sha256": "$validSha",
              "notes": "加入分頁偵測與自動更新",
              "updatedAt": "2026-11-25T09:00:00Z"
            }
        """.trimIndent()

        val parsed = AppUpdater.parseManifest(json, currentVersionCode = 1L)
        assertNotNull(parsed)
        assertEquals(105L, parsed!!.versionCode)
        assertEquals("1.1.5", parsed.versionName)
        assertEquals(validSha, parsed.sha256)
        assertEquals("加入分頁偵測與自動更新", parsed.notes)
    }

    @Test
    fun rejectsInsecureHttpOrMalformedSha256() {
        val httpJson = """
            {
              "versionCode": 2,
              "versionName": "1.0.1",
              "apkUrl": "http://example.com/PureReader.apk"
            }
        """.trimIndent()
        assertNull(AppUpdater.parseManifest(httpJson, currentVersionCode = 1L))

        val badHashJson = """
            {
              "versionCode": 2,
              "versionName": "1.0.1",
              "apkUrl": "https://github.com/dreamgen/publishHTML/releases/download/purereader-latest/PureReader-latest.apk",
              "sha256": "not-a-valid-sha"
            }
        """.trimIndent()
        assertNull(AppUpdater.parseManifest(badHashJson, currentVersionCode = 1L))
    }

    @Test
    fun validatesHttpsUrlsOnly() {
        assertTrue(AppUpdater.isValidHttpsUrl("https://github.com/dreamgen/publishHTML/releases/download/purereader-latest/version.json"))
        assertFalse(AppUpdater.isValidHttpsUrl("http://github.com/test"))
        assertFalse(AppUpdater.isValidHttpsUrl("javascript:alert(1)"))
        assertFalse(AppUpdater.isValidHttpsUrl(""))
    }
}
