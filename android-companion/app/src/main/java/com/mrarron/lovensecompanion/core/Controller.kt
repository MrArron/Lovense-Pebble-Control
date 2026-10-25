package com.mrarron.lovensecompanion.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** A saved toy and its live connection state. */
data class Toy(
    val address: String,
    val name: String,
    val connected: Boolean = false,
    val connecting: Boolean = false,
    val battery: Int? = null,
)

/** The Bluetooth side (ble/ToyManager in the app, a fake in tests). */
interface ToyPort {
    /** Saved toys, in the order they were added. */
    val toys: StateFlow<List<Toy>>
    /** Connect every saved toy that isn't connected yet; keep retrying until [disconnectAll]. */
    fun connectAll()
    fun disconnectAll()
    fun setLevel(addresses: List<String>, level: Int)
}

/** Queues one AppMessage to the watch. Values are Int or String. */
fun interface WatchPort {
    fun send(values: Map<String, Any>)
}

/** Remembers the last link mode the watch reported, so the companion can connect as soon as the app opens. */
interface ModeStore {
    var linkMode: Int
}

/** What the watch sends (src/c/main.c send_command_msg). Every field may be missing. */
data class WatchMessage(
    val command: String?,
    val intensity: Int? = null,
    val pattern: Int? = null,
    val linkMode: Int? = null,
)

/**
 * Plays the part PebbleKit JS plays in Wi-Fi mode, but over Bluetooth: runs the watch's commands on the
 * toys and keeps the watch's toy status rows current. It only acts while the watch says link_mode is
 * Bluetooth; in Wi-Fi mode it lets go of the toys so Lovense Remote can have them.
 *
 * Not thread-safe: call it from one thread (the app uses the main thread).
 */
class Controller(
    private val scope: CoroutineScope,
    private val toys: ToyPort,
    private val watch: WatchPort,
    private val store: ModeStore,
    private val idleDisconnectMs: Long = 60_000,
) {
    companion object {
        const val LINK_WIFI = 0
        const val LINK_BLUETOOTH = 1

        // The watch's BT_STATE_* values (sent on the toy_connected key).
        const val BT_CONNECTING = 0
        const val BT_CONNECTED = 1
        const val BT_DISCONNECTED = 2

        const val ALL_TOYS = "All Toys"
        /** Same cap as TOY_NAME_MAX_CHARS in src/pkjs/index.js. */
        const val NAME_MAX_CHARS = 9

        // Message keys, by name (watch/Keys.kt maps them to numbers).
        const val KEY_TOY_CONNECTED = "toy_connected"
        const val KEY_TOY_NAME = "toy_name"
        const val KEY_TOY_BATTERY = "toy_battery"
    }

    var watchOpen = false
        private set
    val linkMode: Int get() = store.linkMode

    private var active = false
    private var intensity = 0
    private var pattern = Patterns.STEADY
    /** null = all connected toys, else one toy's address. */
    private var selected: String? = null

    private var patternJob: Job? = null
    private var disconnectJob: Job? = null

    private var sentBtState: Int? = null
    private var sentBattery: Int? = null
    private var connectedAddresses: Set<String> = emptySet()

    init {
        scope.launch { toys.toys.collect { onToysChanged(it) } }
    }

    private val bluetooth get() = store.linkMode == LINK_BLUETOOTH

    fun onWatchOpened() {
        watchOpen = true
        sentBtState = null
        sentBattery = null
        disconnectJob?.cancel()
        if (bluetooth) {
            toys.connectAll()
            pushState()
        }
    }

    fun onWatchClosed() {
        watchOpen = false
        active = false
        stopPattern()
        scheduleDisconnect()
    }

    fun onMessage(msg: WatchMessage) {
        msg.linkMode?.let { if (it == LINK_WIFI || it == LINK_BLUETOOTH) store.linkMode = it }
        if (!bluetooth) {
            // Wi-Fi mode: PebbleKit JS is in charge. Stop anything we started and let go of the toys.
            if (active || patternJob != null) {
                active = false
                stopPattern()
            }
            disconnectJob?.cancel()
            toys.disconnectAll()
            return
        }
        watchOpen = true
        disconnectJob?.cancel()
        toys.connectAll()
        msg.intensity?.let { intensity = it }
        msg.pattern?.let { pattern = it }

        when (msg.command) {
            "vibrate" -> {
                active = true
                startPattern()
            }
            "pause", "stop" -> {
                active = false
                stopPattern()
            }
            "next_toy" -> nextToy()
            "hello" -> {
                // Sent on launch and when the mode changes: resend everything.
                sentBtState = null
                sentBattery = null
                if (active) startPattern()
                watch.send(mapOf(KEY_TOY_NAME to currentName()))
            }
            else -> Unit // "ping" and anything unknown: just refresh state below
        }
        pushState()
    }

    private fun nextToy() {
        val options = listOf<String?>(null) + connectedInOrder()
        val i = options.indexOf(selected).coerceAtLeast(0)
        val old = targets()
        selected = options[(i + 1) % options.size]
        if (active) {
            toys.setLevel(old - targets().toSet(), 0)
            startPattern()
        }
        watch.send(mapOf(KEY_TOY_NAME to currentName()))
        sentBattery = null
    }

    private fun connectedInOrder() = toys.toys.value.filter { it.connected }.map { it.address }

    private fun targets(): List<String> {
        val connected = connectedInOrder()
        val sel = selected
        return if (sel == null) connected else connected.filter { it == sel }
    }

    private fun currentName(): String {
        val sel = selected ?: return ALL_TOYS
        val toy = toys.toys.value.firstOrNull { it.address == sel } ?: return ALL_TOYS
        return toy.name.take(NAME_MAX_CHARS)
    }

    private fun startPattern() {
        patternJob?.cancel()
        val steps = Patterns.steps(pattern, intensity)
        patternJob = scope.launch {
            if (steps.size == 1 && steps[0].durationMs == null) {
                toys.setLevel(targets(), steps[0].level)
                return@launch
            }
            while (isActive) {
                for (step in steps) {
                    toys.setLevel(targets(), step.level)
                    delay(step.durationMs ?: Long.MAX_VALUE)
                }
            }
        }
    }

    private fun stopPattern() {
        patternJob?.cancel()
        patternJob = null
        toys.setLevel(connectedInOrder(), 0)
    }

    private fun scheduleDisconnect() {
        disconnectJob?.cancel()
        disconnectJob = scope.launch {
            delay(idleDisconnectMs)
            if (!watchOpen) toys.disconnectAll()
        }
    }

    private fun onToysChanged(list: List<Toy>) {
        val nowConnected = list.filter { it.connected }.map { it.address }.toSet()
        val newlyConnected = nowConnected - connectedAddresses
        connectedAddresses = nowConnected
        if (!bluetooth || !watchOpen) return

        val sel = selected
        if (sel != null && sel !in nowConnected) {
            // The selected toy dropped out: fall back to all toys, like the JS side does.
            selected = null
            watch.send(mapOf(KEY_TOY_NAME to ALL_TOYS))
        }
        // A toy that (re)connects mid-session picks up whatever is playing.
        if (active && newlyConnected.isNotEmpty()) startPattern()
        pushState()
    }

    private fun pushState() {
        if (!watchOpen) return
        val list = toys.toys.value
        val state = when {
            list.any { it.connected } -> BT_CONNECTED
            list.any { it.connecting } -> BT_CONNECTING
            else -> BT_DISCONNECTED
        }
        if (state != sentBtState) {
            sentBtState = state
            watch.send(mapOf(KEY_TOY_CONNECTED to state))
        }
        val battery = currentBattery()
        if (battery != sentBattery) {
            sentBattery = battery
            watch.send(mapOf(KEY_TOY_BATTERY to battery))
        }
    }

    /** The selected toy's battery, or the first connected toy's for "All Toys"; -1 when unknown. */
    private fun currentBattery(): Int {
        val list = toys.toys.value.filter { it.connected }
        val toy = selected?.let { s -> list.firstOrNull { it.address == s } } ?: list.firstOrNull { it.battery != null }
        return toy?.battery ?: -1
    }
}
