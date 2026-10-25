package com.mrarron.lovensecompanion.watch

import com.mrarron.lovensecompanion.core.WatchMessage
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import java.util.UUID

/**
 * AppMessage keys. pebble build numbers the package.json "messageKeys" list from 10000 in order, so
 * these must follow that list exactly (KeysTest checks it against ../package.json).
 */
object Keys {
    val WATCH_UUID: UUID = UUID.fromString("ecd0256e-959e-4f3f-8077-a8ecd37856e0")

    val NUMBERS: Map<String, UInt> = listOf(
        "command", "intensity", "ui_style", "pattern", "toy_connected", "toy_name",
        "basic_bg_color", "basic_text_color", "basic_accent_color", "discrete_bezel_color",
        "discrete_bg_color", "discrete_text_color", "discrete_active_color", "discrete_face",
        "battery_source", "toy_battery", "secondary_display", "touch_play_mode",
        "auto_timeout_minutes", "link_mode",
    ).mapIndexed { i, name -> name to (10000u + i.toUInt()) }.toMap()

    fun number(name: String): UInt = NUMBERS[name] ?: error("Unknown message key $name")
}

/** Builds a dictionary: ints become signed Int32 (the watch reads ->value->int32), strings become Text. */
fun toDictionary(values: Map<String, Any>): PebbleDictionary = values.entries.associate { (name, v) ->
    Keys.number(name) to when (v) {
        is Int -> PebbleDictionaryItem.Int32(v)
        is String -> PebbleDictionaryItem.Text(v)
        else -> throw IllegalArgumentException("Unsupported value type")
    }
}

/** Reads an integer item of any width/signedness. */
fun PebbleDictionary.int(name: String): Int? = when (val v = this[Keys.number(name)]) {
    is PebbleDictionaryItem.Int32 -> v.value
    is PebbleDictionaryItem.UInt32 -> v.value.toInt()
    is PebbleDictionaryItem.Int16 -> v.value.toInt()
    is PebbleDictionaryItem.UInt16 -> v.value.toInt()
    is PebbleDictionaryItem.Int8 -> v.value.toInt()
    is PebbleDictionaryItem.UInt8 -> v.value.toInt()
    else -> null
}

fun PebbleDictionary.text(name: String): String? = when (val v = this[Keys.number(name)]) {
    is PebbleDictionaryItem.Text -> v.value
    is PebbleDictionaryItem.Bytes -> v.value.toString(Charsets.UTF_8).trimEnd('\u0000')
    else -> null
}

fun PebbleDictionary.toWatchMessage() = WatchMessage(
    command = text("command"),
    intensity = int("intensity"),
    pattern = int("pattern"),
    linkMode = int("link_mode"),
)
