package com.mrarron.lovensecompanion.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import com.mrarron.lovensecompanion.core.LovenseProtocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class FoundToy(val address: String, val name: String)

/**
 * Looks for advertising Lovense toys for a short while, for the "Add a toy" list. A toy only
 * advertises while nothing is connected to it, so Lovense Remote must have let go of it.
 *
 * Callers must hold BLUETOOTH_SCAN (Android 12+) or location (Android 10-11).
 */
@SuppressLint("MissingPermission")
class ToyScanner(private val context: Context, private val scope: CoroutineScope) {
    companion object {
        const val SCAN_MS = 15_000L
    }

    private val _found = MutableStateFlow<List<FoundToy>>(emptyList())
    val found: StateFlow<List<FoundToy>> = _found
    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning
    private var stopJob: Job? = null

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val name = result.scanRecord?.deviceName ?: return
            if (!LovenseProtocol.isLovenseName(name)) return
            val address = result.device.address
            scope.launch {
                if (_found.value.none { it.address == address }) _found.value = _found.value + FoundToy(address, name)
            }
        }
    }

    /** Returns false when Bluetooth is off or unavailable. */
    fun start(): Boolean {
        val scanner = context.getSystemService(BluetoothManager::class.java)?.adapter
            ?.takeIf { it.isEnabled }?.bluetoothLeScanner ?: return false
        stop()
        _found.value = emptyList()
        scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
        _scanning.value = true
        stopJob = scope.launch {
            delay(SCAN_MS)
            stop()
        }
        return true
    }

    fun stop() {
        stopJob?.cancel()
        stopJob = null
        if (!_scanning.value) return
        _scanning.value = false
        context.getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeScanner?.stopScan(callback)
    }
}
