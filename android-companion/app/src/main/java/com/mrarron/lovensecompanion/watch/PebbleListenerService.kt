package com.mrarron.lovensecompanion.watch

import com.mrarron.lovensecompanion.App
import io.rebble.pebblekit2.client.BasePebbleListenerService
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import java.util.UUID

/**
 * Bound by the Pebble app while the watch app runs, which also keeps this process awake for the
 * Bluetooth connection to the toy. Only our watch app's UUID is handled. Callbacks arrive on the
 * main thread, which is where the controller lives.
 */
class PebbleListenerService : BasePebbleListenerService() {
    override suspend fun onMessageReceived(watchappUUID: UUID, data: PebbleDictionary, watch: WatchIdentifier): ReceiveResult {
        if (watchappUUID != Keys.WATCH_UUID) return ReceiveResult.Nack
        App.get().controller.onMessage(data.toWatchMessage())
        return ReceiveResult.Ack
    }

    override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID == Keys.WATCH_UUID) App.get().controller.onWatchOpened()
    }

    override fun onAppClosed(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID == Keys.WATCH_UUID) App.get().controller.onWatchClosed()
    }
}
