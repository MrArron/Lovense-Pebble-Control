package com.mrarron.lovensecompanion.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ControllerTest {
    private class FakeToys : ToyPort {
        override val toys = MutableStateFlow(listOf(Toy("A", "Lush"), Toy("B", "Hush")))
        val levels = mutableListOf<Pair<List<String>, Int>>()
        var connectCalls = 0
        var disconnectCalls = 0

        override fun connectAll() {
            connectCalls++
        }

        override fun disconnectAll() {
            disconnectCalls++
            toys.value = toys.value.map { it.copy(connected = false, connecting = false) }
        }

        override fun setLevel(addresses: List<String>, level: Int) {
            levels += addresses to level
        }

        fun connect(vararg addresses: String, battery: Int? = null) {
            toys.value = toys.value.map { if (it.address in addresses) it.copy(connected = true, battery = battery) else it }
        }
    }

    private class FakeStore(override var linkMode: Int) : ModeStore

    private class Setup(scope: TestScope, mode: Int = Controller.LINK_BLUETOOTH) {
        val toys = FakeToys()
        val sent = mutableListOf<Map<String, Any>>()
        val store = FakeStore(mode)
        val controller = Controller(scope.backgroundScope, toys, { sent += it }, store, idleDisconnectMs = 60_000)
        fun lastLevel() = toys.levels.last()
        fun sentValues(key: String) = sent.mapNotNull { it[key] }
    }

    private fun msg(command: String, intensity: Int = 0, pattern: Int = Patterns.STEADY, link: Int? = Controller.LINK_BLUETOOTH) =
        WatchMessage(command, intensity, pattern, link)

    @Test fun steadyVibrateGoesToAllConnectedToys() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        s.toys.connect("A", "B")
        runCurrent()
        s.controller.onMessage(msg("vibrate", 12))
        runCurrent()
        assertEquals(listOf("A", "B") to 12, s.lastLevel())
        s.controller.onMessage(msg("pause", 12))
        runCurrent()
        assertEquals(listOf("A", "B") to 0, s.lastLevel())
    }

    @Test fun pulseAlternatesEveryTwoSeconds() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        s.toys.connect("A")
        runCurrent()
        s.controller.onMessage(msg("vibrate", 10, Patterns.PULSE))
        runCurrent()
        assertEquals(listOf("A") to 10, s.lastLevel())
        advanceTimeBy(2001)
        assertEquals(listOf("A") to 0, s.lastLevel())
        advanceTimeBy(2000)
        assertEquals(listOf("A") to 10, s.lastLevel())
        s.controller.onMessage(msg("stop"))
        runCurrent()
        val count = s.toys.levels.size
        advanceTimeBy(10_000)
        assertEquals("pattern stopped", count, s.toys.levels.size)
        assertEquals(listOf("A") to 0, s.lastLevel())
    }

    @Test fun wifiModeLetsGoOfTheToys() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        s.toys.connect("A")
        runCurrent()
        s.controller.onMessage(msg("vibrate", 8))
        runCurrent()
        s.controller.onMessage(msg("ping", 8, link = Controller.LINK_WIFI))
        runCurrent()
        assertEquals(Controller.LINK_WIFI, s.store.linkMode)
        assertEquals(1, s.toys.disconnectCalls)
        assertEquals(listOf("A") to 0, s.lastLevel())
        // Nothing more happens on further Wi-Fi commands
        val before = s.toys.levels.size
        s.controller.onMessage(msg("vibrate", 8, link = Controller.LINK_WIFI))
        runCurrent()
        assertEquals(before, s.toys.levels.size)
    }

    @Test fun watchOpenInWifiModeDoesNotConnect() = runTest {
        val s = Setup(this, mode = Controller.LINK_WIFI)
        s.controller.onWatchOpened()
        runCurrent()
        assertEquals(0, s.toys.connectCalls)
        assertTrue(s.sent.isEmpty())
    }

    @Test fun bluetoothModeConnectsOnOpenAndReportsState() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        runCurrent()
        assertEquals(1, s.toys.connectCalls)
        assertEquals(listOf<Any>(Controller.BT_DISCONNECTED), s.sentValues(Controller.KEY_TOY_CONNECTED))
        s.toys.connect("A", battery = 77)
        runCurrent()
        assertEquals(listOf<Any>(Controller.BT_DISCONNECTED, Controller.BT_CONNECTED), s.sentValues(Controller.KEY_TOY_CONNECTED))
        assertEquals(77, s.sentValues(Controller.KEY_TOY_BATTERY).last())
    }

    @Test fun nextToyCyclesAndMovesThePattern() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        s.toys.connect("A", "B")
        runCurrent()
        s.controller.onMessage(msg("vibrate", 6))
        runCurrent()
        s.controller.onMessage(msg("next_toy", 6))
        runCurrent()
        assertEquals("Lush", s.sentValues(Controller.KEY_TOY_NAME).last())
        assertTrue(s.toys.levels.contains(listOf("B") to 0))
        assertEquals(listOf("A") to 6, s.lastLevel())
        s.controller.onMessage(msg("next_toy", 6))
        s.controller.onMessage(msg("next_toy", 6))
        runCurrent()
        assertEquals(listOf("Lush", "Hush", Controller.ALL_TOYS), s.sentValues(Controller.KEY_TOY_NAME))
        assertEquals(listOf("A", "B") to 6, s.lastLevel())
    }

    @Test fun reconnectingToyPicksUpThePattern() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        runCurrent()
        s.controller.onMessage(msg("vibrate", 9))
        runCurrent()
        s.toys.connect("A")
        runCurrent()
        assertEquals(listOf("A") to 9, s.lastLevel())
    }

    @Test fun selectedToyDroppingFallsBackToAll() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        s.toys.connect("A", "B")
        runCurrent()
        s.controller.onMessage(msg("next_toy"))
        runCurrent()
        s.toys.toys.value = s.toys.toys.value.map { if (it.address == "A") it.copy(connected = false) else it }
        runCurrent()
        assertEquals(Controller.ALL_TOYS, s.sentValues(Controller.KEY_TOY_NAME).last())
    }

    @Test fun closingTheWatchAppStopsAndLaterDisconnects() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        s.toys.connect("A")
        runCurrent()
        s.controller.onMessage(msg("vibrate", 15))
        runCurrent()
        s.controller.onWatchClosed()
        runCurrent()
        assertEquals(listOf("A") to 0, s.lastLevel())
        assertFalse(s.controller.watchOpen)
        advanceTimeBy(59_000)
        assertEquals(0, s.toys.disconnectCalls)
        advanceTimeBy(2_000)
        assertEquals(1, s.toys.disconnectCalls)
    }

    @Test fun reopeningCancelsTheDelayedDisconnect() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        runCurrent()
        s.controller.onWatchClosed()
        advanceTimeBy(30_000)
        s.controller.onWatchOpened()
        advanceTimeBy(60_000)
        assertEquals(0, s.toys.disconnectCalls)
    }

    @Test fun helloResendsName() = runTest {
        val s = Setup(this)
        s.controller.onWatchOpened()
        runCurrent()
        s.controller.onMessage(msg("hello"))
        runCurrent()
        assertEquals(Controller.ALL_TOYS, s.sentValues(Controller.KEY_TOY_NAME).last())
    }

    @Test fun longNamesAreCappedForTheWatch() = runTest {
        val s = Setup(this)
        s.toys.toys.value = listOf(Toy("A", "Solace Pro Max"))
        s.controller.onWatchOpened()
        s.toys.connect("A")
        runCurrent()
        s.controller.onMessage(msg("next_toy"))
        runCurrent()
        assertEquals("Solace Pr", s.sentValues(Controller.KEY_TOY_NAME).last())
    }
}
