package com.mrarron.lovensecompanion.core

import java.util.UUID

/**
 * Lovense's Bluetooth LE protocol: plain ASCII commands ending in ';', written to a TX characteristic,
 * replies arrive as notifications on an RX characteristic. Documented by the Buttplug project:
 * https://buttplug.io/stpihkal/protocols/lovense/ (and its device config, protocols/lovense.yml).
 */
object LovenseProtocol {
    const val MAX_LEVEL = 20

    const val DEVICE_TYPE = "DeviceType;"
    const val BATTERY = "Battery;"

    fun vibrate(level: Int) = "Vibrate:${level.coerceIn(0, MAX_LEVEL)};"

    /** Every Lovense toy advertises a name starting with one of these. */
    fun isLovenseName(name: String?) = name != null && (name.startsWith("LVS-") || name.startsWith("LOVE-"))

    private const val GEN3_SUFFIX = "-4bd4-bbd5-a6920e4c5653"
    private val GEN2_SERVICE: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
    private val GEN1_SERVICE: UUID = UUID.fromString("0000fff0-0000-1000-8000-00805f9b34fb")

    /**
     * Whether a GATT service is the Lovense command service. Newer toys use a family of UUIDs
     * (XY300001-002Z-4bd4-bbd5-a6920e4c5653) that differ per model, so match on the shared suffix.
     */
    fun isCommandService(uuid: UUID): Boolean =
        uuid == GEN2_SERVICE || uuid == GEN1_SERVICE || uuid.toString().lowercase().endsWith(GEN3_SUFFIX)

    /** "85;" or "s85;" -> 85. Anything else (OK;, ERR;, DeviceType replies) -> null. */
    fun parseBattery(reply: String): Int? {
        val body = reply.trim().removeSuffix(";").removePrefix("s")
        if (body.isEmpty() || body.length > 3 || !body.all { it.isDigit() }) return null
        return body.toInt().takeIf { it in 0..100 }
    }

    /** "S:11:0082059AD3BD;" -> "S". The first field is the model letter code. */
    fun parseDeviceType(reply: String): String? {
        val parts = reply.trim().removeSuffix(";").split(':')
        if (parts.size < 2) return null
        val type = parts[0]
        return type.takeIf { it.isNotEmpty() && it.length <= 6 && it.all { c -> c.isLetter() || c == '-' } }
    }

    // Model codes from the Buttplug device config. Lush reports "S" (assumed the same for Lush 4).
    private val MODELS = mapOf(
        "S" to "Lush", "AN" to "Lush Anal", "Z" to "Hush", "W" to "Domi", "O" to "Osci",
        "OC" to "Osci 3", "V" to "Mission", "CA" to "Mission 2", "X" to "Ferri", "R" to "Diamo",
        "L" to "Ambi", "Q" to "Tenera", "T" to "Calor", "J" to "Dolce", "P" to "Edge",
        "A" to "Nora", "C" to "Nora", "B" to "Max", "ED" to "Gush", "EZ" to "Gush 2",
        "EB" to "Hyphy", "EA" to "Gravity", "EL" to "Ridge", "U" to "Lapis", "SD" to "Vulse",
        "H" to "Solace", "BA" to "Solace Pro", "WD" to "Spinel", "CB" to "Velvo", "EI" to "Flexer",
    )

    /** A short display name: the model if the toy told us, else the advertised name without "LVS-". */
    fun displayName(deviceType: String?, advertisedName: String?): String {
        deviceType?.let { MODELS[it] }?.let { return it }
        val bare = advertisedName?.removePrefix("LVS-")?.removePrefix("LOVE-")?.trim()
        return if (bare.isNullOrEmpty()) "Toy" else bare
    }

    /**
     * Splits a notification stream into complete replies. Toys normally send one reply per
     * notification, but this also copes with replies split across or joined within notifications.
     */
    class ReplyBuffer {
        private val sb = StringBuilder()

        fun feed(chunk: String): List<String> {
            sb.append(chunk)
            val out = mutableListOf<String>()
            while (true) {
                val i = sb.indexOf(";")
                if (i < 0) break
                out += sb.substring(0, i + 1)
                sb.delete(0, i + 1)
            }
            if (sb.length > 64) sb.setLength(0) // garbage without a terminator
            return out
        }
    }
}
