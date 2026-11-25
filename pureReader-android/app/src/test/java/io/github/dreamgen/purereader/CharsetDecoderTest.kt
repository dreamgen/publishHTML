package io.github.dreamgen.purereader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.Charset

class CharsetDecoderTest {

    @Test
    fun decodesGbkHtmlUsingMetaCharset() {
        val html = "<html><head><meta charset=\"gbk\"><title>測試標題</title></head><body><p>正文內容繁簡測試</p></body></html>"
        val gbkBytes = html.toByteArray(Charset.forName("GB18030"))
        val decoded = CharsetDecoder.decodeHtmlBytes(gbkBytes, "text/html")
        assertTrue(decoded.contains("正文內容繁簡測試"))
    }

    @Test
    fun trustsValidUtf8EvenWhenMetaSaysGbk() {
        val html = "<html><head><meta charset=\"gbk\"></head><body><p>已由代理轉為UTF-8的繁體中文內容</p></body></html>"
        val utf8Bytes = html.toByteArray(Charsets.UTF_8)
        val decoded = CharsetDecoder.decodeHtmlBytes(utf8Bytes, "text/html")
        assertEquals(html, decoded)
    }

    @Test
    fun decodesBig5Html() {
        val html = "<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=big5\"></head><body><p>繁體中文測試</p></body></html>"
        val big5Bytes = html.toByteArray(Charset.forName("Big5"))
        val decoded = CharsetDecoder.decodeHtmlBytes(big5Bytes, "text/html")
        assertTrue(decoded.contains("繁體中文測試"))
    }
}
