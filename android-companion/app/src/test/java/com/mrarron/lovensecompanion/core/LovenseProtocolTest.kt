package com.mrarron.lovensecompanion.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class LovenseProtocolTest {
    @Test fun vibrateIsClamped() {
        assertEquals("Vibrate:0;", LovenseProtocol.vibrate(-3))
        assertEquals("Vibrate:12;", LovenseProtocol.vibrate(12))
        assertEquals("Vibrate:20;", LovenseProtocol.vibrate(99))
    }

    @Test fun batteryReplies() {
        assertEquals(85, LovenseProtocol.parseBattery("85;"))
        assertEquals(7, LovenseProtocol.parseBattery("s7;"))
        assertEquals(100, LovenseProtocol.parseBattery("100;"))
        assertNull(LovenseProtocol.parseBattery("OK;"))
        assertNull(LovenseProtocol.parseBattery("ERR;"))
        assertNull(LovenseProtocol.parseBattery("S:11:0082059AD3BD;"))
        assertNull(LovenseProtocol.parseBattery("250;"))
        assertNull(LovenseProtocol.parseBattery(";"))
    }

    @Test fun deviceTypeReplies() {
        assertEquals("S", LovenseProtocol.parseDeviceType("S:11:0082059AD3BD;"))
        assertEquals("OC", LovenseProtocol.parseDeviceType("OC:103:F0A2B3C4D5E6;"))
        assertNull(LovenseProtocol.parseDeviceType("OK;"))
        assertNull(LovenseProtocol.parseDeviceType("85;"))
    }

    @Test fun names() {
        assertEquals("Lush", LovenseProtocol.displayName("S", "LVS-S123"))
        assertEquals("Z36D", LovenseProtocol.displayName(null, "LVS-Z36D"))
        assertEquals("Toy", LovenseProtocol.displayName("??", null))
        assertTrue(LovenseProtocol.isLovenseName("LVS-Lush"))
        assertTrue(LovenseProtocol.isLovenseName("LOVE-1"))
        assertFalse(LovenseProtocol.isLovenseName("Pebble Time 2"))
        assertFalse(LovenseProtocol.isLovenseName(null))
    }

    @Test fun commandServices() {
        assertTrue(LovenseProtocol.isCommandService(UUID.fromString("53300001-0023-4bd4-bbd5-a6920e4c5653")))
        assertTrue(LovenseProtocol.isCommandService(UUID.fromString("5A300001-0024-4BD4-BBD5-A6920E4C5653")))
        assertTrue(LovenseProtocol.isCommandService(UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")))
        assertTrue(LovenseProtocol.isCommandService(UUID.fromString("0000fff0-0000-1000-8000-00805f9b34fb")))
        assertFalse(LovenseProtocol.isCommandService(UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb")))
    }

    @Test fun replyBufferSplitsAndJoins() {
        val b = LovenseProtocol.ReplyBuffer()
        assertEquals(emptyList<String>(), b.feed("8"))
        assertEquals(listOf("85;"), b.feed("5;"))
        assertEquals(listOf("OK;", "S:11:AB;"), b.feed("OK;S:11:AB;"))
    }
}
