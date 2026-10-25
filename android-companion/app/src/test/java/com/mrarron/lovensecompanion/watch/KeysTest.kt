package com.mrarron.lovensecompanion.watch

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class KeysTest {
    /** pebble build numbers messageKeys from 10000 in list order; ours must match the watch's. */
    @Test fun keysMatchPackageJson() {
        val pkg = listOf(File("../../package.json"), File("../package.json")).first { it.exists() }.readText()
        val block = Regex("\"messageKeys\"\\s*:\\s*\\[(.*?)]", RegexOption.DOT_MATCHES_ALL).find(pkg)!!.groupValues[1]
        val names = Regex("\"([a-z_]+)\"").findAll(block).map { it.groupValues[1] }.toList()
        assertEquals(names, Keys.NUMBERS.keys.toList())
        names.forEachIndexed { i, n -> assertEquals(10000u + i.toUInt(), Keys.number(n)) }
    }

    @Test fun packageNameIsDeclaredForTheWatchApp() {
        val pkg = listOf(File("../../package.json"), File("../package.json")).first { it.exists() }.readText()
        assert(pkg.contains("\"package\": \"com.mrarron.lovensecompanion\"")) { "package.json companionApp must list com.mrarron.lovensecompanion" }
        assert(pkg.contains("ecd0256e-959e-4f3f-8077-a8ecd37856e0"))
        assertEquals("ecd0256e-959e-4f3f-8077-a8ecd37856e0", Keys.WATCH_UUID.toString())
    }
}
