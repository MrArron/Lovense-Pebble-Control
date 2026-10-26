package com.mrarron.lovensecompanion.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import android.util.Log
import com.mrarron.lovensecompanion.core.LovenseProtocol
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID

/**
 * One Bluetooth LE link to one Lovense toy. Connects, finds the command service, turns on reply
 * notifications, then writes commands one at a time. While [connect] is wanted it reconnects on its
 * own after a drop. Everything except the GATT callbacks runs on [scope]'s (main) thread; the
 * callbacks hop onto it before touching state.
 *
 * Callers must hold BLUETOOTH_CONNECT (checked by [ToyManager] before calling [connect]).
 */
@SuppressLint("MissingPermission")
class ToyConnection(
    private val context: Context,
    val address: String,
    private val scope: CoroutineScope,
    private val onState: (connected: Boolean, connecting: Boolean) -> Unit,
    private val onReply: (String) -> Unit,
) {
    companion object {
        private const val TAG = "ToyConnection"
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val WRITE_TIMEOUT_MS = 1_000L
        private const val KEEPALIVE_MS = 10_000L
        private const val BATTERY_EVERY = 6 // keepalives, so once a minute
        private const val RETRY_MIN_MS = 2_000L
        private const val RETRY_MAX_MS = 30_000L
    }

    private var wanted = false
    private var gatt: BluetoothGatt? = null
    private var tx: BluetoothGattCharacteristic? = null
    private var ready = false
    private var retryMs = RETRY_MIN_MS
    private var retryJob: Job? = null
    private var keepaliveJob: Job? = null
    private var writeDone: CompletableDeferred<Boolean>? = null
    private val replies = LovenseProtocol.ReplyBuffer()
    private val outbox = Channel<String>(Channel.UNLIMITED)

    init {
        scope.launch {
            for (cmd in outbox) {
                val g = gatt
                val ch = tx
                if (!ready || g == null || ch == null) continue
                val done = CompletableDeferred<Boolean>()
                writeDone = done
                if (write(g, ch, cmd.toByteArray(Charsets.US_ASCII))) {
                    withTimeoutOrNull(WRITE_TIMEOUT_MS) { done.await() }
                }
                writeDone = null
            }
        }
    }

    val isReady get() = ready

    fun connect() {
        wanted = true
        if (gatt != null || retryJob?.isActive == true) return
        open()
    }

    fun disconnect() {
        wanted = false
        retryJob?.cancel()
        val g = gatt ?: run { onState(false, false); return }
        if (ready) {
            // Best effort: make sure it stops before we let go.
            write(g, tx ?: return close(), LovenseProtocol.vibrate(0).toByteArray(Charsets.US_ASCII))
        }
        g.disconnect()
        // Some stacks never report the disconnect for a link that wasn't up yet.
        scope.launch {
            delay(1_500)
            if (!wanted && gatt === g) close()
        }
    }

    fun send(command: String) {
        if (ready) outbox.trySend(command)
    }

    private fun open() {
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
        if (adapter == null || !adapter.isEnabled) {
            onState(false, false)
            scheduleRetry()
            return
        }
        val device = try {
            adapter.getRemoteDevice(address)
        } catch (_: IllegalArgumentException) {
            onState(false, false)
            return
        }
        onState(false, true)
        gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        if (gatt == null) scheduleRetry()
    }

    private fun close() {
        keepaliveJob?.cancel()
        ready = false
        tx = null
        gatt?.close()
        gatt = null
        writeDone?.complete(false)
        onState(false, false)
    }

    private fun scheduleRetry() {
        if (!wanted) return
        retryJob?.cancel()
        val wait = retryMs
        retryMs = (retryMs * 2).coerceAtMost(RETRY_MAX_MS)
        onState(false, true)
        retryJob = scope.launch {
            delay(wait)
            if (wanted && gatt == null) open()
        }
    }

    private fun onReady() {
        ready = true
        retryMs = RETRY_MIN_MS
        onState(true, false)
        send(LovenseProtocol.DEVICE_TYPE)
        send(LovenseProtocol.BATTERY)
        keepaliveJob?.cancel()
        keepaliveJob = scope.launch {
            var n = 0
            while (isActive) {
                delay(KEEPALIVE_MS)
                n++
                send(if (n % BATTERY_EVERY == 0) LovenseProtocol.BATTERY else LovenseProtocol.DEVICE_TYPE)
            }
        }
    }

    private fun setUp(g: BluetoothGatt) {
        val service = g.services.firstOrNull { LovenseProtocol.isCommandService(it.uuid) }
        val chars = service?.characteristics.orEmpty()
        val writable = chars.firstOrNull {
            it.properties and (BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
        }
        val notify = chars.firstOrNull { it.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0 }
        if (writable == null || notify == null) {
            Log.w(TAG, "No Lovense command service on $address")
            g.disconnect()
            return
        }
        tx = writable
        g.setCharacteristicNotification(notify, true)
        val cccd = notify.getDescriptor(CCCD)
        if (cccd == null || !writeDescriptor(g, cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
            // Commands still work without replies; we just won't see battery levels.
            onReady()
        }
    }

    private fun write(g: BluetoothGatt, ch: BluetoothGattCharacteristic, bytes: ByteArray): Boolean {
        val type = if (ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeCharacteristic(ch, bytes, type) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            ch.writeType = type
            @Suppress("DEPRECATION")
            ch.value = bytes
            @Suppress("DEPRECATION")
            g.writeCharacteristic(ch)
        }
    }

    private fun writeDescriptor(g: BluetoothGatt, d: BluetoothGattDescriptor, value: ByteArray): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeDescriptor(d, value) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            d.value = value
            @Suppress("DEPRECATION")
            g.writeDescriptor(d)
        }

    private fun handleNotification(value: ByteArray) {
        for (reply in replies.feed(value.toString(Charsets.US_ASCII))) onReply(reply)
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            scope.launch {
                if (g !== gatt) {
                    g.close()
                    return@launch
                }
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (!wanted) {
                        g.disconnect()
                    } else if (!g.discoverServices()) {
                        g.disconnect()
                    }
                } else {
                    close()
                    scheduleRetry()
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            scope.launch {
                if (g !== gatt) return@launch
                if (status == BluetoothGatt.GATT_SUCCESS) setUp(g) else g.disconnect()
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            scope.launch {
                if (g === gatt && descriptor.uuid == CCCD && !ready) onReady()
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            scope.launch { writeDone?.complete(status == BluetoothGatt.GATT_SUCCESS) }
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            val copy = value.copyOf()
            scope.launch { if (g === gatt) handleNotification(copy) }
        }

        @Deprecated("Used before Android 13")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            @Suppress("DEPRECATION")
            val copy = characteristic.value?.copyOf() ?: return
            scope.launch { if (g === gatt) handleNotification(copy) }
        }
    }
}
