package com.mrarron.lovensecompanion.core

import kotlin.math.roundToInt

/** One level held for [durationMs], or forever when it is null. */
data class Step(val level: Int, val durationMs: Long?)

/**
 * The watch's three patterns, matching what the PebbleKit JS side asks Game Mode for
 * (src/pkjs/index.js: startPatternTo / WAVE_SHAPE). Game Mode loops them inside Lovense Remote;
 * over Bluetooth the companion has to step through them itself.
 */
object Patterns {
    const val STEADY = 0
    const val PULSE = 1
    const val WAVE = 2

    const val PULSE_ON_MS = 2000L
    const val PULSE_OFF_MS = 2000L
    const val WAVE_STEP_MS = 400L
    val WAVE_SHAPE = listOf(0.2, 0.4, 0.7, 1.0, 0.7, 0.4)

    /** The steps to loop through. A single step with a null duration is just held. */
    fun steps(pattern: Int, intensity: Int): List<Step> {
        val level = intensity.coerceIn(0, LovenseProtocol.MAX_LEVEL)
        if (level == 0) return listOf(Step(0, null))
        return when (pattern) {
            PULSE -> listOf(Step(level, PULSE_ON_MS), Step(0, PULSE_OFF_MS))
            WAVE -> WAVE_SHAPE.map { f -> Step((level * f).roundToInt().coerceIn(0, LovenseProtocol.MAX_LEVEL), WAVE_STEP_MS) }
            else -> listOf(Step(level, null))
        }
    }
}
