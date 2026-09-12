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
  SELECT stops immediately, holding SELECT jumps to max intensity.
- `src/pkjs/index.js` — companion JS that turns those button presses into
  Lovense Standard API calls (`POST /command`), and provides a small settings
  page for entering the Lovense app's IP/port.
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
3. Save.

## 5. Use it

Open the app on your watch:

- **UP** — increase vibration intensity
- **DOWN** — decrease vibration intensity (down to 0 stops it)
- **SELECT** — stop immediately
- **Hold SELECT** — jump to max intensity

## Notes and troubleshooting

- Both the phone running Lovense Remote and the phone paired to your Pebble
  must be on the same local network (they can be the same phone).
- If nothing happens, check the PebbleKit JS logs (`pebble logs` while the
  phone is connected) — the companion script logs whether requests reach the
  Lovense API and what status code comes back.
- Game Mode's IP can change if the phone reconnects to Wi-Fi — re-check it in
  the Lovense app if control suddenly stops working.
- The watchapp sends a "stop" command when it's closed, so leaving the app
  shouldn't leave a toy running.
- This only talks to the Lovense app over your local network — it doesn't go
  through Lovense's cloud, so it won't work over cellular data or across
  separate networks.

## Extending it

Ideas if you want to build on this:
- Add more patterns (pulse, wave) by sending Lovense's `Preset:` actions
  instead of raw `Vibrate:`.
- Support multiple toys by adding a `toy` field to the AppMessage payload and
  the Lovense command body.
- Add a vibration-strength bar using Pebble's `ActionBarLayer` instead of
  plain button clicks, for finer control.
