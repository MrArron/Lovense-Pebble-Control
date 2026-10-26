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
        val msg = data.toWatchMessage()
        note(true, "\"${msg.command}\" (link_mode ${msg.linkMode ?: "missing"})", countMessage = true)
        App.get().controller.onMessage(msg)
        return ReceiveResult.Ack
    }

    override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != Keys.WATCH_UUID) return
        note(true, "watch app opened")
        App.get().controller.onWatchOpened()
    }

    override fun onAppClosed(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != Keys.WATCH_UUID) return
        note(false, "watch app closed")
        App.get().controller.onWatchClosed()
    }

    private fun note(open: Boolean, event: String, countMessage: Boolean = false) {
        val flow = App.get().watchActivity
        val old = flow.value
        flow.value = old.copy(
            appOpen = open,
            lastEvent = event,
            lastEventAt = System.currentTimeMillis(),
            messages = old.messages + if (countMessage) 1 else 0,
        )
    }
}
