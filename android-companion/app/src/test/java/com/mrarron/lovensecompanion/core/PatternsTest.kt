package com.mrarron.lovensecompanion.core

import org.junit.Assert.assertEquals
import org.junit.Test

class PatternsTest {
    @Test fun steadyHolds() {
        assertEquals(listOf(Step(8, null)), Patterns.steps(Patterns.STEADY, 8))
    }

    @Test fun zeroIsAlwaysOff() {
        assertEquals(listOf(Step(0, null)), Patterns.steps(Patterns.WAVE, 0))
    }

    @Test fun pulseIsTwoSecondsOnTwoOff() {
        assertEquals(listOf(Step(10, 2000), Step(0, 2000)), Patterns.steps(Patterns.PULSE, 10))
    }

    @Test fun waveMatchesThePkjsShape() {
        // src/pkjs/index.js: Math.round(intensity * f) for f in WAVE_SHAPE, 400ms each
        assertEquals(listOf(2, 4, 7, 10, 7, 4), Patterns.steps(Patterns.WAVE, 10).map { it.level })
        assertEquals(listOf(4, 8, 14, 20, 14, 8), Patterns.steps(Patterns.WAVE, 20).map { it.level })
        assertEquals(setOf(400L), Patterns.steps(Patterns.WAVE, 20).map { it.durationMs }.toSet())
    }

    @Test fun unknownPatternIsSteady() {
        assertEquals(listOf(Step(5, null)), Patterns.steps(9, 5))
    }
}
