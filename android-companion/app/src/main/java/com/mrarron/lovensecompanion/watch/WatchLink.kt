package com.mrarron.lovensecompanion.watch

import android.content.Context
import com.mrarron.lovensecompanion.core.WatchPort
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.TransmissionResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Outbox to the watch: one AppMessage at a time, each retried up to 3 times, then dropped
 * (same as the PebbleKit JS queue in src/pkjs/index.js).
 */
class WatchLink(context: Context, scope: CoroutineScope) : WatchPort {
    companion object {
        const val MAX_RETRIES = 3
        const val RETRY_DELAY_MS = 300L
        const val SEND_TIMEOUT_MS = 10_000L
    }

    private val sender by lazy { DefaultPebbleSender(context.applicationContext) }
    private val queue = Channel<Map<String, Any>>(Channel.UNLIMITED)

    init {
        scope.launch {
            for (values in queue) {
                val data = toDictionary(values)
                for (attempt in 0..MAX_RETRIES) {
                    val ok = try {
                        withTimeoutOrNull(SEND_TIMEOUT_MS) {
                            val results = sender.sendDataToPebble(Keys.WATCH_UUID, data)
                            !results.isNullOrEmpty() && results.values.any { it == TransmissionResult.Success }
                        } ?: false
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        false
                    }
                    if (ok) break
                    if (attempt < MAX_RETRIES) delay(RETRY_DELAY_MS)
                }
            }
        }
    }

    override fun send(values: Map<String, Any>) {
        queue.trySend(values)
    }
}
