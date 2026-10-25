package com.mrarron.lovensecompanion

import android.app.Application
import com.mrarron.lovensecompanion.ble.ToyManager
import com.mrarron.lovensecompanion.core.Controller
import com.mrarron.lovensecompanion.data.Prefs
import com.mrarron.lovensecompanion.watch.WatchLink
import io.rebble.pebblekit2.client.DefaultPebbleAndroidAppPicker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class App : Application() {
    companion object {
        private lateinit var instance: App
        fun get() = instance
    }

    /** App-wide scope on the main thread: the controller and the PebbleKit callbacks share it. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    lateinit var prefs: Prefs
        private set
    lateinit var toys: ToyManager
        private set
    lateinit var controller: Controller
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        // Only talk to the Pebble app the user explicitly granted on the main screen.
        DefaultPebbleAndroidAppPicker.getInstance(this).enableAutoSelect = false
        prefs = Prefs(this)
        toys = ToyManager(this, prefs, scope)
        controller = Controller(scope, toys, WatchLink(this, scope), prefs)
    }
}
