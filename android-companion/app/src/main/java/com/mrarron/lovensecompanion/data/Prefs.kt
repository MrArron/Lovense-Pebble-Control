package com.mrarron.lovensecompanion.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.mrarron.lovensecompanion.core.Controller
import com.mrarron.lovensecompanion.core.ModeStore

/** A toy the user added on the main screen: its Bluetooth address and a display name. */
data class SavedToy(val address: String, val name: String)

/** Small on-device settings. Nothing here leaves the phone. */
class Prefs(context: Context) : ModeStore {
    private val sp: SharedPreferences = context.getSharedPreferences("companion", Context.MODE_PRIVATE)

    override var linkMode: Int
        get() = sp.getInt("linkMode", Controller.LINK_WIFI)
        set(value) = sp.edit { putInt("linkMode", value) }

    fun savedToys(): List<SavedToy> =
        sp.getString("toys", "").orEmpty().lines().mapNotNull { line ->
            val i = line.indexOf('|')
            if (i <= 0) null else SavedToy(line.substring(0, i), line.substring(i + 1))
        }

    fun setSavedToys(toys: List<SavedToy>) = sp.edit {
        putString("toys", toys.joinToString("\n") { "${it.address}|${it.name.replace("\n", " ")}" })
    }
}
