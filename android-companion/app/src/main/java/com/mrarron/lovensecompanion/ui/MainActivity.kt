package com.mrarron.lovensecompanion.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.mrarron.lovensecompanion.App
import com.mrarron.lovensecompanion.ble.ToyScanner
import com.mrarron.lovensecompanion.core.Controller
import com.mrarron.lovensecompanion.core.Toy
import io.rebble.pebblekit2.client.DefaultPebbleAndroidAppPicker
import io.rebble.pebblekit2.client.ui.PebbleAppPermissionDialog
import java.text.DateFormat
import java.util.Date

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { CompanionTheme { MainScreen() } }
    }
}

@Composable
fun CompanionTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val ctx = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        dark -> darkColorScheme(primary = Color(0xFFFFB0C8))
        else -> lightColorScheme(primary = Color(0xFFB8004F))
    }
    MaterialTheme(colorScheme = scheme) { Surface(Modifier.fillMaxSize(), content = content) }
}

private fun bluetoothPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

private fun hasBluetoothPermissions(ctx: Context) = bluetoothPermissions().all {
    ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
}

@Composable
fun MainScreen() {
    val ctx = LocalContext.current
    val app = App.get()
    val scope = rememberCoroutineScope()
    val scanner = remember { ToyScanner(ctx, scope) }
    DisposableEffect(Unit) { onDispose { scanner.stop() } }

    var refresh by remember { mutableIntStateOf(0) }
    var showPebbleDialog by remember { mutableStateOf(false) }
    val picker = remember { DefaultPebbleAndroidAppPicker.getInstance(ctx) }
    val selectedApp by produceState<String?>(null, refresh, showPebbleDialog) { value = picker.getCurrentlySelectedApp() }
    val eligible = remember(refresh) { picker.getAllEligibleApps() }

    var btGranted by remember { mutableStateOf(hasBluetoothPermissions(ctx)) }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        btGranted = hasBluetoothPermissions(ctx)
    }

    val toys by app.toys.toys.collectAsState()
    val activity by app.watchActivity.collectAsState()
    val found by scanner.found.collectAsState()
    val scanning by scanner.scanning.collectAsState()
    var scanError by remember { mutableStateOf<String?>(null) }

    if (showPebbleDialog) {
        PebbleAppPermissionDialog(picker, onDismiss = {
            showPebbleDialog = false
            refresh++
        })
    }

    Column(
        Modifier
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Lovense Remote", style = MaterialTheme.typography.headlineSmall)
        Text(
            "The companion to the Lovense Remote Pebble watch app. Controls your toy over Bluetooth, with no Wi-Fi needed.",
            style = MaterialTheme.typography.bodyMedium,
        )

        Step("1. Allow the Pebble app") {
            when {
                selectedApp != null -> Text("Connected to the Pebble app.")
                eligible.isEmpty() -> Text("Install the Pebble app (Core Devices) first.")
                else -> {
                    Text("Let the Pebble app pass watch button presses to this app.")
                    Button(onClick = { showPebbleDialog = true }) { Text("Allow") }
                }
            }
        }

        Step("2. Bluetooth permission") {
            if (btGranted) {
                Text("Granted.")
            } else {
                Text("Needed to find your toy and connect to it.")
                Button(onClick = { permLauncher.launch(bluetoothPermissions()) }) { Text("Grant") }
            }
        }

        Step("3. Your toys") {
            if (toys.isEmpty()) Text("No toys yet. Close the official Lovense Remote app (or turn off its Bluetooth link), switch the toy on, then tap Find toys.")
            toys.forEach { ToyRow(it) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                FilledTonalButton(
                    enabled = btGranted && !scanning,
                    onClick = { scanError = if (scanner.start()) null else "Turn on Bluetooth first." },
                ) { Text(if (scanning) "Searching…" else "Find toys") }
                scanError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            found.filter { f -> toys.none { it.address == f.address } }.forEach { f ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(f.name, Modifier.weight(1f))
                    TextButton(onClick = { app.toys.add(f.address, f.name) }) { Text("Add") }
                }
            }
        }

        Step("4. On the watch") {
            Text("In the Pebble app, open the Lovense Remote watch app's settings, go to Connect, choose Bluetooth and save. Then open the watch app.")
            Text(
                when {
                    activity.messages == 0 && activity.lastEvent == null ->
                        "Nothing from the watch app yet. Open it on the watch (version 1.3.0 or newer)."
                    activity.messages == 0 ->
                        "The Pebble app told us the watch app opened, but no button presses have arrived yet. Press a button on the watch."
                    app.controller.linkMode == Controller.LINK_BLUETOOTH -> "The watch is set to Bluetooth."
                    else -> "The watch is set to Wi-Fi. Change it on the Connect tab of the watch app's settings."
                },
                style = MaterialTheme.typography.bodySmall,
            )
            activity.lastEvent?.let { event ->
                Text(
                    "Last from the watch: $event at ${DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(activity.lastEventAt))}" +
                        " · ${activity.messages} message(s)",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun Step(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun ToyRow(toy: Toy) {
    val toys = App.get().toys
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(toy.name)
            val status = when {
                toy.connected -> "Connected" + (toy.battery?.let { " · $it%" } ?: "")
                toy.connecting -> "Connecting…"
                else -> "Not connected"
            }
            Text(status, style = MaterialTheme.typography.bodySmall)
        }
        if (toy.connected) {
            TextButton(onClick = { toys.test(toy.address) }) { Text("Test") }
            TextButton(onClick = { toys.disconnect(toy.address) }) { Text("Disconnect") }
        } else if (toy.connecting) {
            TextButton(onClick = { toys.disconnect(toy.address) }) { Text("Stop") }
        } else {
            TextButton(onClick = { toys.connect(toy.address) }) { Text("Connect") }
        }
        TextButton(onClick = { toys.remove(toy.address) }) { Text("Remove") }
    }
}
