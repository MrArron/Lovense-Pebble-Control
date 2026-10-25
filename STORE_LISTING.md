# Pebble/Rebble App Store listing

Pebble/Rebble app store listings are submitted through the dev-portal web
form, not through `package.json` — this file just holds the copy to paste
in there.

## Short description

Control your Lovense toy discreetly from your wrist.

## Full description

Control your Lovense toy discreetly from your wrist. Change intensity,
switch patterns and pause without ever taking out your phone.

Two ways to look:
- Basic: a clear remote with a big intensity number, the current pattern
  and on-screen button hints.
- Discrete: looks like an ordinary watch to everyone but you. Pick an
  Analog face, where the second hand quietly shows the vibration level, or
  a Digital face with a chronograph-style sub-dial. No numbers on screen,
  and the Analog face goes back to normal seconds when you stop pressing
  buttons.

Controls:
- UP / DOWN: intensity, 0 to 20.
- SELECT: pause and resume.
- Hold UP / DOWN: Steady, Pulse and Wave patterns.
- Hold SELECT: switch between All Toys and each connected toy.
- Pebble Time 2 and Pebble Round 2: double-knock to pause, or use the
  touchscreen to tap, long-press, and swipe to set intensity.
- Safety auto-pause stops the toy after 1 to 15 minutes without a press,
  with a buzz warning first.

Two ways to connect, chosen on the settings page:
- Wi-Fi: works with the official Lovense Remote app's Game Mode on any
  phone on the same Wi-Fi network. No internet needed. Supports multi-toy
  groups.
- Bluetooth (new in 1.3.0, Android only): works anywhere, with no Wi-Fi
  at all. Install the free Lovense Remote companion app for Android (from
  the GitHub releases page linked below) and it connects to the toy
  directly through the Pebble app. Steady, Pulse, Wave, intensity, pause,
  toy switching and the toy's battery level all work.

Also included: 16 color presets plus fully custom colors, your own saved
presets, toy connection and battery status on the watch, and support for
every Pebble, from the original Pebble to Pebble Time 2 and the round
Pebble Round 2.

Setup guide and companion download:
https://github.com/MrArron/Lovense-Pebble-Control

This app is created independently by its developer and is not affiliated
with, endorsed by, or sponsored by Lovense or Pebble/Core Devices/Rebble.

Built with the assistance of Claude (Claude Sonnet 5, Anthropic).

## Icon

`resources/images/icon~color.png` (color platforms) /
`resources/images/icon~bw.png` (Aplite/Diorite) — the app's own brand mark,
used as the in-app menu icon (`MENU_ICON` in `package.json`).

The Android companion (`android-companion/`) uses the same mark as its
launcher icon (`res/drawable/ic_launcher_foreground.xml`, drawn from the
store icon's design: Lovense-blue `#0B90E0`, coral `#F2604D` "p", white
lens) and the same name, "Lovense Remote".
