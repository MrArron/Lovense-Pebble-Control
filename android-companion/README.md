# Pebble Toy Companion (Android)

Optional Android app that lets the Lovense Remote watch app work with **no
Wi-Fi**. Instead of going through Lovense Remote's Game Mode, the Pebble app
hands the watch's button presses to this app (PebbleKit Android 2), and this
app drives the toy over Bluetooth LE using Lovense's own command protocol
(`Vibrate:N;`, `Battery;`, `DeviceType;`, documented by the
[Buttplug project](https://buttplug.io/stpihkal/protocols/lovense/)).

Needs the Core Devices Pebble app 1.0.7.7 or newer, Android 10+.

## Setup

1. Install the APK from this repo's GitHub Releases.
2. Open it and follow the four steps on screen: allow the Pebble app, grant
   Bluetooth, add your toy, then switch the watch app to Bluetooth.
3. To add the toy, close Lovense Remote first (a toy accepts one connection
   at a time and only shows up in a scan when nothing is connected to it),
   switch the toy on, and tap **Find toys**.
4. In the Pebble app, open the watch app's settings, **Connect** tab, choose
   **Bluetooth**, and save.

From then on, opening the watch app connects to the toy; closing it stops
the toy and disconnects a minute later. Switching the watch back to Wi-Fi
makes the companion let go of the toy so Lovense Remote can use it.

## What works over Bluetooth

Steady, Pulse and Wave, intensity, pause/resume, safety auto-pause (that one
lives on the watch), toy switching with Hold SELECT (All Toys, then each
connected toy), the toy connection glyph and the toy battery row. Toy groups
from the settings page are Wi-Fi only for now.

## Code

- `core/`: plain Kotlin, unit tested. `LovenseProtocol` (commands, reply
  parsing), `Patterns` (Pulse/Wave timing, matching `src/pkjs/index.js`),
  `Controller` (what PebbleKit JS does in Wi-Fi mode, done over Bluetooth).
- `ble/`: Android Bluetooth: `ToyConnection` (one GATT link, write queue,
  keepalive, reconnect), `ToyManager` (saved toys), `ToyScanner` (pairing).
- `watch/`: PebbleKit 2 glue. `Keys` must list `package.json`'s
  `messageKeys` in order (the watch numbers them from 10000).
- `ui/MainActivity.kt`: the setup screen.

Build: `./gradlew testDebugUnitTest lintDebug assembleDebug` (Android SDK
platform android-37.2, build-tools 37.0.0). Releases: see
[`../docs/RELEASING.md`](../docs/RELEASING.md).
