package com.mrarron.lovensecompanion.ble

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.mrarron.lovensecompanion.core.LovenseProtocol
import com.mrarron.lovensecompanion.core.Toy
import com.mrarron.lovensecompanion.core.ToyPort
import com.mrarron.lovensecompanion.data.Prefs
import com.mrarron.lovensecompanion.data.SavedToy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** The saved toys and their Bluetooth links. Call from the main thread. */
class ToyManager(
    private val context: Context,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
) : ToyPort {
    private val connections = mutableMapOf<String, ToyConnection>()
    private val _toys = MutableStateFlow(prefs.savedToys().map { Toy(it.address, it.name) })
    override val toys: StateFlow<List<Toy>> = _toys

    fun hasConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    override fun connectAll() {
        _toys.value.forEach { connect(it.address) }
    }

    override fun disconnectAll() {
        connections.values.forEach { it.disconnect() }
    }

    override fun setLevel(addresses: List<String>, level: Int) {
        val cmd = LovenseProtocol.vibrate(level)
        addresses.forEach { connections[it]?.send(cmd) }
    }

    fun connect(address: String) {
        if (!hasConnectPermission()) return
        connectionFor(address).connect()
    }

    fun disconnect(address: String) {
        connections[address]?.disconnect()
    }

    /** A short buzz, so the user can tell which toy is which. */
    fun test(address: String) {
        val c = connections[address]?.takeIf { it.isReady } ?: return
        c.send(LovenseProtocol.vibrate(6))
        scope.launch {
            delay(700)
            c.send(LovenseProtocol.vibrate(0))
        }
    }

    fun add(address: String, advertisedName: String?) {
        if (_toys.value.any { it.address == address }) return
        val name = LovenseProtocol.displayName(null, advertisedName)
        _toys.value = _toys.value + Toy(address, name)
        save()
    }

    fun remove(address: String) {
        connections.remove(address)?.disconnect()
        _toys.value = _toys.value.filterNot { it.address == address }
        save()
    }

    private fun save() = prefs.setSavedToys(_toys.value.map { SavedToy(it.address, it.name) })

    private fun connectionFor(address: String) = connections.getOrPut(address) {
        ToyConnection(
            context, address, scope,
            onState = { connected, connecting ->
                update(address) { it.copy(connected = connected, connecting = connecting, battery = if (connected) it.battery else null) }
            },
            onReply = { reply -> onReply(address, reply) },
        )
    }

    private fun onReply(address: String, reply: String) {
        LovenseProtocol.parseBattery(reply)?.let { pct ->
            update(address) { it.copy(battery = pct) }
            return
        }
        LovenseProtocol.parseDeviceType(reply)?.let { type ->
            val model = LovenseProtocol.displayName(type, null)
            if (model != "Toy" && _toys.value.firstOrNull { it.address == address }?.name != model) {
                update(address) { it.copy(name = model) }
                save()
            }
        }
    }

    private fun update(address: String, change: (Toy) -> Toy) {
        _toys.value = _toys.value.map { if (it.address == address) change(it) else it }
    }
}
