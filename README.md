# Lovense Remote for Pebble

Control Lovense toys from your Pebble watch. The watch sends button presses
over Bluetooth to a small companion script running in the Pebble phone app,
which relays them as HTTP commands to the Lovense Remote app's local
"Game Mode" API.

```
Pebble watch  --AppMessage-->  Phone (PebbleKit JS)  --HTTP POST-->  Lovense Remote app (Game Mode)  --BLE-->  Toy
```

## What's included

- `src/c/main.c` — watchapp UI. UP/DOWN adjust intensity (0–20, steps of 2),
  SELECT pauses/resumes at the current level.
- `src/pkjs/index.js` — companion JS that turns those button presses into
  Lovense Standard API calls (`POST /command`), and provides a small settings
  page for entering the Lovense app's IP/port. Commands target every toy
  currently connected to Lovense Remote.
- `package.json` — project manifest (UUID, targets, AppMessage keys).

## 1. Set up the build toolchain

Pebble's own SDK is defunct, but the community keeps a compatible toolchain
alive. The straightforward path today:

- Install `pebble-tool` per the current Rebble/Core Devices instructions
  (search "rebble pebble-tool install" for the up-to-date steps for your OS —
  this changes often enough that it's worth checking fresh).
- Confirm it works: `pebble --version`.

## 2. Build and install

From this project's root folder:

```bash
pebble build
pebble install --phone <YOUR_PHONE_IP>   # or --emulator basalt to test in an emulator first
```

`pebble install --phone` requires the Pebble phone app's developer mode to be
turned on (Settings > About > tap version a few times, similar to Android's
pattern) so it can accept installs over Wi-Fi.

## 3. Enable Lovense Game Mode

1. Open the **Lovense Remote** app (on the same phone as your Pebble app, or
   another device on the same Wi-Fi network).
2. Connect your toy to the app as usual.
3. Go to **Discover > Game Mode** and enable it. Note the IP address and port
   it displays (default port is `20010`).

## 4. Configure the watchapp

1. In the Pebble phone app, open this app's settings page.
2. Enter the IP address and port from Game Mode.
3. Pick a display style — **Basic** or **Discrete** (see below).
4. Save. The watch updates its look immediately; the choice is also saved on
   the watch itself, so it's remembered even if it's later reinstalled or the
   phone app restarts.

## 5. Use it

Same three buttons regardless of display style:

- **UP / DOWN** — adjust intensity (0–20, steps of 2). You can do this while
  paused too — it just sets the level that the next resume will use, without
  making anything buzz.
- **SELECT** — pause/resume. Pausing stops vibration but remembers the
  intensity; resuming sends that same level again.

All commands target every toy currently connected to Lovense Remote — there's
no per-toy selection.

### Display styles

- **Basic** — the straightforward layout: a big number for the current
  intensity, a "VIBRATING"/"PAUSED" label, and on-screen button hints.
- **Discrete** — disguised as an ordinary minimalist watchface. It shows the
  real time large and centered (with today's day/date beneath), and tucks the
  intensity into a small ":NN" readout where seconds would normally sit — it
  doesn't tick like real seconds, but at a glance it reads as a watchface. The
  only sign of active/paused state is that readout's color (a muted gray when
  paused, red when vibrating) — no text anywhere says what it's controlling.

## Notes and troubleshooting

- Both the phone running Lovense Remote and the phone paired to your Pebble
  must be on the same local network (they can be the same phone).
- If nothing happens, check the PebbleKit JS logs (`pebble logs` while the
  phone is connected) — the companion script logs whether requests reach the
  Lovense API and what status code comes back.
- Pausing sends a `Vibrate:0` command rather than a separate stop command —
  the same mechanism used to start vibration, just at zero — so stopping is
  exactly as reliable as starting, regardless of toy or firmware quirks.
- Game Mode's IP can change if the phone reconnects to Wi-Fi — re-check it in
  the Lovense app if control suddenly stops working.
- The watchapp sends a full "stop" command when it's closed, so leaving the
  app shouldn't leave anything running.
- This only talks to the Lovense app over your local network — it doesn't go
  through Lovense's cloud, so it won't work over cellular data or across
  separate networks.

## Extending it

Ideas if you want to build on this:
- Add more patterns (pulse, wave) by sending Lovense's `Preset:` actions
  instead of raw `Vibrate:`.
- Add a vibration-strength bar using Pebble's `ActionBarLayer` instead of
  plain button clicks, for finer control in Basic mode.
- Target a specific toy instead of all connected toys by adding a `toy` field
  (a toy ID from Lovense's `GetToys` command) to the outgoing command body.
- Make Discrete mode's "seconds" tick with real seconds when paused (so it's
  indistinguishable from a real watchface at rest), only switching to the
  intensity readout while actively vibrating.
