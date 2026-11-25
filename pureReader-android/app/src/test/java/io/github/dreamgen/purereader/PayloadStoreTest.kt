package io.github.dreamgen.purereader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class PayloadStoreTest {

    @Test
    fun putAndConsumeReturnsPayloadOnce() {
        val store = PayloadStore()
        val sample = """{"html":"<html><body>測試'\"特殊字元\\n</body></html>"}"""
        val token = store.put(sample)
        assertNotEquals("", token)
        assertEquals(1, store.size())

        assertEquals(sample, store.consume(token))
        assertEquals(0, store.size())
        assertEquals("", store.consume(token))
    }
}
