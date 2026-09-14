# Lovense Remote for Pebble

Control Lovense toys from your Pebble watch. The watch sends button presses
over Bluetooth to a small companion script running in the Pebble phone app,
which relays them as HTTP commands to the Lovense Remote app's local
"Game Mode" API.

```
Pebble watch  --AppMessage-->  Phone (PebbleKit JS)  --HTTP POST-->  Lovense Remote app (Game Mode)  --BLE-->  Toy
```

## Project status / where this was left off

**Confirmed working on real Pebble Time 2 hardware**: boot, Basic mode, both
Discrete faces (Analog/Digital) render and the idle-revert behavior works as
designed. Real-device testing also surfaced three bugs, now fixed - see
"Fixed this pass" below.

**Discrete mode has two selectable faces** — see "Display styles" below:

- **Analog** — an ordinary analog watch face; the second hand encodes
  vibration level (position + color), reverting to true seconds after the
  idle stand-down period.
- **Digital** — digital time with a chronograph-style sub-dial at 6 o'clock
  encoding level, plus a Steady/Pulse/Wave totalizer register.

Both faces share the existing bezel/background/text color model plus an
independent **active (vibrating) color**, default Lovense pink (`#FF2D89`,
per Lovense's own site), never reset by presets. Non-Emery rectangular
platforms (aplite/basalt/diorite) get every Emery-derived layout constant
scaled proportionally rather than clipped; Chalk keeps its own hand-tuned
numbers.

Also built: a **Toy Settings** tab (status, Test connection/Test vibration
buttons that talk to the Lovense API directly from the settings page, custom
toy groups targeting multiple toys at once via a comma-joined `toy` field),
a light/dark toggle for the settings page's own chrome, a persistent
toy-name + battery row in Basic mode with a watch-vs-toy battery-source
setting, "save custom colors as a new named preset" (with delete),
preventing the same color being picked for text and background, and a
three-state (connecting/connected/disconnected) BT status glyph that blinks
while connecting and updates immediately if the toy-events socket drops
mid-session. The default color scheme (both display styles) is now the
"Lovense pink" preset, and the watch has a launcher icon based on Lovense's
logo (`resources/images/icon~color.png` / `icon~bw.png`).

**Fixed this pass** (found via real-hardware testing): `GetToys`'s `toys`
field is a JSON-**encoded string**, not a plain object — `Object.keys()` on
it was iterating characters, not toy entries, which broke toy-name display,
the BT status, and the settings page's "Test connection" toy count (it was
reporting the JSON blob's character count). Also: the analog/chrono hands'
thinnest widths degenerated to a hairline at most rotation angles due to
Pebble's fixed-point trig truncating at `half_width=1`; and Basic mode's
idle timer (now removed) and tip text (now shifted up) were clipped by the
watch's physical bezel.

**Untested**: this pass's changes haven't run on real hardware yet - needs
a `pebble build`/`pebble install` round. Chalk (round display) remains
untested on physical hardware.

**Deferred, not yet built**: persisting the selected pattern/toy across app
restarts, and real-hardware testing/layout tuning for Chalk. See "Extending
it" at the bottom.

**To resume this work in a new session**, the most useful things to paste
back in are: this README (has all the design decisions and reasoning), and
either this zip or a description of what's changed since if you've made
manual edits. The project's current UUID, message-key list, and persisted-
storage key numbering are all in `package.json`/`main.c` and shouldn't need
to change for any of the deferred features above.

## What's included

- `src/c/main.c` — watchapp UI. UP/DOWN adjust intensity (0–20, steps of 2)
  and, held, cycle patterns. SELECT pauses/resumes at the current level.
  Only the currently-active display style's layers exist in memory at any
  time; Basic mode's button bar is hand-drawn instead of loaded from image
  resources; `heap_bytes_free()`/`heap_bytes_used()` are still logged at
  every major lifecycle point (kept in place through active development).
  Includes Discrete's 10s idle-revert-to-real-seconds (Analog/Digital hand
  position, not Basic — see "Idle behavior"), the round-display (Chalk)
  layout variant, and the edge-to-edge bezel fix — see their own sections
  below.
- `src/pkjs/index.js` — companion JS that turns those button presses into
  Lovense Standard API calls (`POST /command`), including native Pulse/Wave
  pattern parameters and toy-connection polling/events, and provides the
  settings page (connection info, display style, 15 color presets plus a
  Custom tab and a Toy tab, and a disclaimer/GitHub link). Commands target
  every toy currently connected to Lovense Remote, or a saved multi-toy
  group.
- `package.json` — project manifest (UUID, targets, AppMessage keys,
  `resources.media` for the launcher icon). The button bar is still drawn
  in code, not loaded from a PNG - the only bundled image resource is the
  launcher icon itself (see `resources/images/`).
- `resources/images/icon~color.png` / `icon~bw.png` — the watch's launcher
  icon shown in Pebble OS's app list, based on Lovense's logo in the app's
  Lovense-pink brand color (color platforms) and a black/white variant
  (Aplite/Diorite). Declared as `MENU_ICON` in `package.json`.
- `STORE_LISTING.md` — copy for the Pebble/Rebble app store listing (not a
  build input - that store's submission happens through a separate web
  form, this is just where the text lives).

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

Same buttons regardless of display style:

- **UP / DOWN** — adjust intensity (0–20, steps of 2). You can do this while
  paused too — it just sets the level that the next resume will use, without
  making anything buzz.
- **Hold UP / hold DOWN** — cycle patterns forward/backward: Steady → Pulse →
  Wave → back to Steady. If you're actively vibrating, the toy switches to
  the new pattern immediately; if paused, it just changes what resume will
  use.
- **SELECT** — pause/resume. Pausing stops vibration but remembers the
  intensity; resuming sends that same level again.
- **Hold SELECT** — cycle the target toy: All Toys → toy 1 → toy 2 → … →
  back to All Toys. If you're actively vibrating, the running pattern moves
  from the old target to the new one (old target stops, new one starts at
  the same intensity/pattern); if paused, it just changes what the next
  resume will target. The selection isn't persisted — it resets to All Toys
  each time the watchapp is launched.

All commands target whichever toy (or "All Toys") is currently selected.

### Display styles

- **Basic** — a big number for the current intensity, a "VIBRATING"/"PAUSED"
  label, the current pattern name, and a button bar down the right edge
  (chevrons for UP/DOWN, a pause/play glyph for SELECT that swaps depending
  on state) with a tooltip beneath explaining the hold gestures. The bar is
  drawn with vector shapes (`GPath`/rect fills) in a plain `Layer`'s draw
  callback, not an `ActionBarLayer` with loaded icon bitmaps — see "Memory
  optimizations" below for why. Background, text, and accent (pattern label
  + bar background) colors are all customizable from the phone's settings
  page.
- **Discrete** — disguised as an ordinary watchface. There are two selectable
  Discrete face styles (a settings-page toggle, `discrete_face`, shared
  presets/colors between them so switching styles keeps the same look):
  - **Analog** — a plain analog watch: hour and minute hands show real time,
    and a second hand encodes vibration level (angle = level × 18°). The
    hand is muted whenever not vibrating (any level, including 0) and turns
    the active/pink color only while actively vibrating — to an observer
    it's just a second hand at a plausible position.
  - **Digital** — digital `HH:MM` time with a day-of-week row, plus a
    chronograph-style sub-dial at 6 o'clock whose needle encodes level
    (angle = level⁄20 of a full turn) and whose ring/needle color follows the
    same active/muted state rule as the Analog hand. Below it, a Steady/
    Pulse/Wave register drawn as Roman numerals (I/II/III) with a marker
    triangle on the selected pattern reads as an ordinary chronograph
    totalizer.

  On both faces, the level indicator reverts to showing **true elapsed
  seconds** (an ordinary running second hand / sweeping chrono sub-dial)
  after the idle stand-down period with no button press, and snaps back to
  the vibration-level position the instant a button is pressed — the same
  "look ordinary at rest" idea 1a's digit-disguise used, just expressed as
  hand position instead of a digit swap. Color (muted/active) always
  reflects real vibration state regardless of idle, so the disguise never
  hides *that* something is running, only *what number* it's at.

  A "BT" label + a small status dot (muted when connected, red when lost)
  plus a battery percentage sit in a status row on both faces; the label
  itself no longer recolors on connection loss — only the dot does. The
  current pattern isn't otherwise shown in Analog; instead, cycling patterns
  gives a distinct number of short wrist buzzes (1/2/3 for Steady/Pulse/
  Wave) — a haptic tap looks like completely ordinary watch feedback and
  doesn't compromise the disguise. Holding SELECT to change toy still
  reveals the selected toy's name briefly (reusing the date row) before
  reverting. Bezel/background/text are customizable from the phone's
  settings page along with a new independent **active (vibrating) color**
  (default Lovense pink, not reset by presets); the muted secondary tone and
  BT-lost red are fixed, since they're part of how the disguise communicates
  state.

## Patterns

Steady sends a plain `Function`/`Vibrate:N`. Pulse and Wave now use Lovense's
actual documented parameters rather than a client-side workaround:

- **Pulse** sends one `Function` request with `loopRunningSec`/`loopPauseSec`
  set (2 seconds on, 2 off), so the toy itself handles the on/off timing —
  no repeated requests from the phone, and it still respects whatever
  intensity you've set.
- **Wave** sends a `Pattern` request — a short intensity sequence
  (`rule`/`strength`) scaled to your chosen intensity, stepping every 400ms,
  looped indefinitely (`timeSec: 0`). Again, one request, no phone-side timer.

Both replace the original setInterval-based workaround, since Lovense's
public developer docs (turned out to be readable without a login) confirm
these parameters. Their named `Preset` command (`pulse`/`wave`/`fireworks`/
`earthquake`) also works and is simpler, but doesn't accept an intensity
parameter — using `loopRunningSec`/`Pattern` instead keeps your chosen
intensity meaningful for Pulse and Wave, not just Steady.

Pattern selection isn't persisted — it resets to Steady each time the
watchapp is launched.

## Toy connection detection

The Discrete face's status row (labeled "BT") shows whether the Lovense toy
itself is still connected to the phone — not the watch's own Bluetooth link
to the phone, which is a separate, less useful signal. The "BT" label itself
stays muted in every state; a small dot next to it carries the state
instead, in three states (`BT_STATE_CONNECTING`/`CONNECTED`/`DISCONNECTED`
in `main.c`, sent as the same 0/1/2 values over the existing `toy_connected`
key from `index.js`):

- **Connecting** — an unfilled ring, blinking on/off every 650ms
  (`s_bt_blink_timer`), muted color. Shown before the first real answer
  arrives (optimistic-unknown default on launch), and again if the toy-
  events socket drops mid-session while a reconnect is pending.
- **Connected** — a filled disc, muted color.
- **Disconnected** — a filled disc, fixed red — the ring/fill distinction
  plus color is what tells the three states apart at a glance.

The primary source is the **Toy Events API** — a WebSocket connection
(`ws://{ip}:{port}/v1`) that pushes `toy-list` and `toy-status` events the
instant a toy connects, disconnects, or is added/removed, rather than
waiting on a poll. `index.js` connects to it on launch, sends the required
`access` handshake and a `ping` every 5 seconds to keep it alive, and tracks
each toy's connected state as events arrive. If Game Mode is turned off, an
`event-closed` event fires and the socket closes; if it drops for any other
reason (Wi-Fi hiccup, app restart), it retries every 10 seconds — and the
watch shows "connecting" again the moment the socket closes, resolving back
to connected/disconnected via whichever check completes next (the socket's
own reconnect, or the `GetToys` fallback below, which re-enables itself the
instant the socket drops).

**`GetToys`'s response has a quirk worth knowing if you touch this code**:
`data.toys` in the JSON response is itself a JSON-encoded *string*, not a
nested object — `JSON.parse()` it again before treating it as
`{toyId: toyObject}`. Getting this wrong (as the original polling code did)
doesn't throw - `Object.keys()` on a raw string just silently iterates its
*characters* instead of toy entries, which is a very confusing bug to chase
since everything still "runs."

The original `GetToys`-polling approach is kept as a fallback for whenever
the socket isn't confirmed connected yet (right after launch, or while a
reconnect is pending):

- **While actively vibrating**: a `GetToys` check runs every 60 seconds,
  plus on every button press (UP/DOWN, SELECT, pattern changes).
- **While paused**: no periodic check — UP/DOWN don't send anything to the
  toy while paused, so they send a lightweight `ping` command instead, just
  to trigger a check without affecting the toy.

Once the socket confirms access, both of these fall silent automatically
(no wasted requests) and only resume if the socket disconnects.

## Toy selection

Hold SELECT cycles through All Toys plus every toy the phone currently knows
about, sourced from the same data as the connection glyph (the Events API's
`toy-list` when connected, `GetToys` as a fallback). Each toy's nickname
(falling back to its model name) is what shows on the watch, truncated to 20
characters.

Under the hood, `index.js` keeps an ordered list (`All Toys` always first)
and an index into it; outgoing `Function`/`Pattern` requests include a `toy`
field with the selected ID, or omit it entirely for "All Toys" (per the
Standard API's own behavior — omitting `toy` targets every connected toy).
Switching while active stops whatever was running on the old target and
restarts it on the new one, using the last known intensity and pattern.

Selection isn't persisted on either side — both the watch's index and the
phone's list reset to "All Toys" on relaunch.

**Toy groups**: the settings page's Toy tab lets you check a subset of known
toys, name the group, and save it — groups are appended to the hold-SELECT
cycle after the individual toys (`{name, toyIds:[]}` in `localStorage`,
merged into the toy list fresh on every GetToys/Events refresh via
`appendToyGroups()`, dropping any stale member ids silently). Targeting a
group sends every member's id at once, comma-joined into the `toy` field
(`currentToyId()` joins an array selection into a single string before any
`Function`/`Pattern` request sees it) — the Standard API's documented way to
target multiple specific toys at once (Remote 7.71.0+).

## Basic and Discrete mode colors

The settings page has color pickers (a handful of preset swatches each, not
a full picker) for:

- **Basic mode**: background, text, and accent (pattern label + button bar
  background), plus a persistent toy-name + battery row (battery source —
  the watch's own or the currently selected toy's — is a separate setting).
- **Discrete mode**: bezel, background, and text (used by both the Analog
  and Digital faces — see "Display styles"), plus an independent **active
  (vibrating) color** (default Lovense pink) shared by both faces and never
  touched by presets.

All of these are sent to the watch as hex strings (or ints for the discrete
face / battery source choices), parsed into `GColor`s, and persisted
on-watch with `persist_write_int` the same way `ui_style` is — so they
survive app restarts and don't need the phone to resend them (though it does
anyway on `ready`, in case they were never received the first time).

Discrete mode's muted secondary tone and the fixed BT-lost red are
intentionally not customizable — changing those would blur the one visual
cue the disguise actually relies on to communicate state. The Custom tab
also refuses to let text and background land on the same color (would make
text invisible) — picking a swatch that would collide with the paired field
is rejected with an alert instead of applied.

## Presets

The settings page's Colors section has three tabs: **Presets**, **Custom**,
and **Toy**. Presets is the default — a grid of 15 ready-made looks (the
original 12 — Lovense pink, Classic, Midnight, Forest, Plum, Teal, Rust,
Amber, Slate, Crimson, Violet, Ocean — plus Steel, Ink, and Sand), each a
small live-rendered tile showing its actual bezel/background/text colors.
Tapping one sets all six color fields at once (Basic's background/text/
accent and Discrete's bezel/background/text), using the mapping: Discrete's
bezel becomes Basic's accent, and Discrete's background/text become Basic's
background/text — so a preset gives one consistent look across both display
styles rather than needing to set six values by hand. The active/vibrating
color is deliberately not part of any preset (built-in or custom) — it's a
standalone always-pink-by-default setting a preset tap never overwrites.

Custom reveals the same swatch pickers as before, now with more options per
row (7-8 instead of 4-6) after the "give more freedom, keep white/black/an
off-white as anchors" request. Lovense pink (`#FF2D89`, confirmed against
Lovense's own site — both the built-in preset's bezel and the active-color
swatch row now use this same value, replacing two earlier different guesses)
is available both as a one-tap preset and as a standalone swatch in the
bezel/background/text rows, so it can be mixed with any other color too.
It's also this app's **default** color scheme on a fresh install, on both
display styles, before Settings has ever been opened.

Custom also has a **"Save as preset"** flow: name the current bezel/
background/text combo and it's appended to the Presets grid with a delete
("×") button that only appears on custom tiles. Everything stays in the
config page's own in-memory state (Pebble config pages have no live
round-trip back into `index.js` while open) until the main **Save** button,
which bundles the custom-preset list into the same close payload as every
other setting; `webviewclosed` persists it to `localStorage` from there —
the same pattern every other field on this page already uses.

Each preset tile is a live mini-preview of the discrete colors, not just a
flat swatch: a day-of-week row (with a highlighted day), a time row, and a
date row, using the same colors as the real Discrete layout (it no longer
tries to mimic either face's exact geometry — just the palette). The
"muted" secondary tones in the preview (day letters, date) are computed the
same way the watch computes them (see "Secondary color contrast" below) via
a JS `blendHex()` that mirrors the watch's `blend_colors()`, so what you see
in Settings should closely match what actually renders — though the watch's
`GColor8` only has 4 levels per channel, so its exact shade may be a touch
different from the phone preview's full 8-bit precision.

## Secondary color contrast

A few presets (Plum, Forest) pair a dark accent/bezel with a dark
background, which made secondary text nearly unreadable — Discrete's
day-row/date used a fixed muted color (`GColorArmyGreen`) that only looked
right against a pale background, and Basic's pattern label used the raw
accent color even when that accent had poor contrast against a dark
background.

Both are now computed dynamically instead of using a fixed constant:
`blend_colors()` takes the 2-bit-per-channel RGB values from two `GColor8`s
and averages them. Discrete's muted tone is `blend(background, text)`;
Basic's pattern-label color is `blend(accent, text)`. Since blending toward
`text` (which is chosen for contrast against the background already) pulls
the result toward the readable end regardless of how dark the accent or
background are, this needed no separate "is this too dark" check — it just
works out.  Recomputed whenever colors change (`apply_basic_colors`/
`apply_discrete_colors`) and once at boot after loading persisted colors.

## Idle behavior

**Discrete mode**: after 10 seconds with no button press, the level
indicator (Analog's second hand / Digital's chrono needle) reverts to
showing real, sweeping seconds — indistinguishable from an ordinary running
second hand / chronograph sub-dial at rest. The watch switches from
`MINUTE_UNIT` to `SECOND_UNIT` tick updates only while idle in Discrete
mode, to avoid the battery cost of ticking every second all the time. Any
button press immediately snaps the indicator back to the vibration-level
position and restarts the 10s timer. Color (muted/active) is unaffected by
idle state either way — only the hand's *position* is disguised, the same
principle 1a's digit-swap used, just expressed as hand angle now that
there's no "seconds" digit to swap.

**Basic mode**: no idle behavior — removed after real-hardware feedback that
it wasn't wanted there. Basic's tip text always shows the button-hint text
(still briefly overridden by the unrelated 5s toy-name-reveal on hold-
SELECT). `reset_idle_timer()` no longer even arms the underlying timer while
Basic is active, since nothing in Basic reacts to `s_idle` anymore - the
whole mechanism is Discrete-only now.

## Round display support (Chalk)

Chalk's round screen automatically clips anything drawn outside its
physical circle, which changes how a couple of things need to be drawn:

- **Discrete's bezel** (`frame_update_proc`): on rectangular platforms, a
  small-radius full-bleed rectangle plus an inset rounded rectangle (see
  "edge-to-edge bezel" below). On Chalk, a plain full-bleed square already
  reads as a solid bezel disc thanks to the hardware clip - but the inner
  face needs an explicit `graphics_fill_circle`, since an inset rectangle
  would just show sharp corners sitting inside that clip, not a smaller
  circle.
- **Basic mode's button bar**: a vertical strip on the right edge (the
  rectangular-platform layout) would get clipped near the top and bottom on
  a circle. On Chalk it becomes a horizontal row along the bottom instead -
  same three icons, left to right.
- **Layout insets**: the day-of-week row, corner glyphs, and vertical
  spacing in Discrete mode all use larger margins on Chalk, since a circle
  has much less usable width away from its vertical center than a rectangle
  does.

All of this is behind `#if defined(PBL_ROUND)` and was never tested on
actual round hardware (Rebble's current SDK doesn't include a Chalk unit
this project has access to) - the emulator is the only thing this has run
against. Real-hardware layout tuning may be needed.

## Edge-to-edge bezel and layout corrections (rectangular platforms)

The original bezel used a large outer corner radius (16px) that didn't
reach the screen's true physical corners, leaving the window's background
color visible in a small gap at each corner on real Emery hardware - a bug
reported on a physical Pebble Time 2. Fixed by shrinking the outer radius to
4px (flush to the edge) while leaving the inner radius at 13px unchanged,
per feedback that the larger inner curve looked better than a matching flush
inner edge. The bezel's ring thickness was separately widened from 4px to
8px after real-hardware testing showed 4px reading as a thin outline rather
than a visible bezel.

Discrete mode's vertical layout was also corrected to match the original
mockup after real-hardware testing showed BT/battery had drifted to the
bottom corners (their position before this project's very first Discrete
implementation, never actually updated to match later mockup iterations)
instead of the top corners, which also left time/date sitting off-center
rather than around the screen's true vertical middle. Current layout, top to
bottom: BT/battery in the top corners (`status_row_y`), the day-of-week row
just below them (`day_row_y`), then time/date/toy positioned relative to
`center_y` now that the bottom of the screen isn't reserved for status
glyphs.

## Memory optimizations and debug logging

After the Emery crash (`App fault!` with `LR` pointing into RAM — a pattern
usually caused by a stack overflow or a call through a bad pointer, and
consistent with running low on heap), four changes went in:

1. **Right-sized AppMessage buffers.** `app_message_open()` previously used
   `app_message_inbox_size_maximum()`/`..._outbox_size_maximum()`, which
   requests the largest buffer the platform allows. Everything this app
   actually sends is a handful of short strings and ints — the buffers are
   now fixed at 128 bytes each (`APP_MESSAGE_INBOX_SIZE`/`_OUTBOX_SIZE`),
   comfortably more than needed without reserving platform-maximum space.
2. **Only the active display style exists in memory.** Previously both
   Basic's and Discrete's layers were created up front and the inactive one
   was just hidden (`layer_set_hidden`), meaning both were permanently
   resident. `build_basic_ui`/`teardown_basic_ui` and
   `build_discrete_ui`/`teardown_discrete_ui` now construct and destroy each
   style's layers on demand; `switch_ui_style()` tears down whichever one
   isn't needed and builds the other, both on first launch and whenever the
   phone sends a new `ui_style`.
3. **The day-of-week row is one `Layer`, not seven `TextLayer`s.** A single
   custom draw callback (`day_row_update_proc`) now renders all 7 letters,
   coloring today's differently from `s_current_wday` — same visual result,
   one allocated object instead of seven.
4. **Basic mode's button bar is hand-drawn, not loaded from bitmaps.** The
   previous `ActionBarLayer` + four PNG icon resources are gone entirely,
   replaced by a plain `Layer` (`button_bar_update_proc`) that draws the
   chevrons with `GPath`/`gpath_draw_filled` and the pause/play glyph with
   rect fills and a `GPath` triangle. This removes `gbitmap_create_with_resource`
   from the app entirely (a suspect for the crash, not just a memory cost)
   along with the image files and their `package.json` resource entries.

**Debug logging**: `heap_bytes_free()`/`heap_bytes_used()` are logged (via a
small `log_heap()` helper) at `init` start/end, `window_load` start/end,
before/after each UI style's build and teardown, and after every processed
AppMessage. This was left in place until the crash below was fully resolved,
and can now be trimmed down or removed if you'd rather have quieter logs.

## Root cause of the Emery boot crash: a broken `strtol()`

The app faulted immediately on every launch on a physical Pebble Time 2,
consistently, no matter what UI/AppMessage/toy-tracking code was present or
absent — while an identical binary ran perfectly in the emulator every time.
After isolating essentially every other API call in the app one at a time
(persist reads, `app_message_open`, `tick_timer_service_subscribe`, click
registration, `GPath` drawing, container `Layer` nesting, launch path, call
ordering, UUID/persisted-storage state) without reproducing it, the actual
cause turned out to be much narrower: **`strtol()` itself faults on this
Pebble Time 2 / current Rebble Emery toolchain combination.** Confirmed by
isolating a single bare `strtol()` call with nothing else in the app running
at all — no AppMessage, no UI, no persisted storage.

`strtol()` was only ever used in `parse_hex_color()`, to turn the hex color
strings from the settings page (`"#rrggbb"`) into `GColor`s. Every crash in
this project's history happened at or immediately after the first real call
to that function — which is why so many individually-tested pieces came back
clean: none of them ever actually invoked it with a real argument. The fix
was to stop using the C library for this entirely: `hex_nibble()` converts
each hex character to a 0–15 value with plain character comparisons, and
`parse_hex_color()` builds the color from that instead of calling `strtol()`.
`strlen()` (the only other libc string function in that path) was removed
too, replaced with direct null-character checks, since at that point it
seemed safer not to trust any more of this platform's C library than
strictly necessary.

If you hit a similarly inexplicable, code-independent crash on this
toolchain again, a libc function you're relying on is a very reasonable
first suspect - worth testing in isolation the same way, with nothing else
running, before spending time on application-level logic.

## Outgoing AppMessage queue

`Pebble.sendAppMessage()` doesn't queue multiple in-flight sends for you —
calling it again before the watch has acked or nacked the previous message
causes the new one to be dropped with `APP_MSG_BUSY` (error code 64) on the
watch side. This surfaced for real: the `ready` handler fires off the UI
style, then Basic's three colors, then Discrete's three colors, and once all
three sends went out, the third one started losing that race.

Every place `index.js` used to call `Pebble.sendAppMessage()` directly now
goes through `queueAppMessage()` instead, which pushes onto `s_outgoingQueue`
and only calls `Pebble.sendAppMessage()` for the next queued message once the
current one's success or error callback has fired. Messages are now always
delivered one at a time, in the order they were queued, regardless of how
many get triggered in a burst (like on `ready`, or when several color
settings are saved from the config page at once).

## Other Lovense API features worth considering

While confirming the Preset/Pattern schemas and building the Events API
above, a couple of other things in Lovense's public docs stood out:

- **Toy battery level** — already sitting unused in every `GetToys`
  response and every Events API `battery-changed` event (0–100). Since
  we're already connected either way, showing the toy's own battery
  percentage somewhere (as a fourth option alongside steps/heart rate, from
  our earlier mockups) would cost essentially nothing extra.
- **`stopPrevious`** — a `Function` request parameter that controls whether
  a new command stops whatever was previously running. We don't need it now
  since we only ever send one function at a time, but it'd matter if a toy
  ever needed multiple simultaneous functions (e.g. vibrate + rotate).
- **`button-down`/`button-up`/`button-pressed`** — Events API messages for
  toys that have their own physical buttons (Nora, Max 2, Solace, Mission2).
  Not useful for controlling vibration, but could be a fun secondary input
  if a toy's own button should do something in the app.

## Notes and troubleshooting

- Both the phone running Lovense Remote and the phone paired to your Pebble
  must be on the same local network (they can be the same phone).
- If nothing happens, check the PebbleKit JS logs (`pebble logs` while the
  phone is connected) — the companion script logs whether requests reach the
  Lovense API and what status code comes back.
- Pausing sends a `Vibrate:0` command rather than a separate stop command —
  the same mechanism used to start vibration, just at zero — so stopping is
  exactly as reliable as starting, and it overrides a running Pulse loop or
  Wave pattern the same way it overrides Steady.
- Game Mode's IP can change if the phone reconnects to Wi-Fi — re-check it in
  the Lovense app if control suddenly stops working.
- The watchapp sends a full "stop" command when it's closed, so leaving the
  app shouldn't leave anything running.
- This only talks to the Lovense app over your local network — it doesn't go
  through Lovense's cloud, so it won't work over cellular data or across
  separate networks.

## Extending it

Built in the Discrete-redesign pass (see "Project status" at the top for
what's still untested on real hardware):

- **Toy Settings tab** — connection/socket status, per-toy battery, a "Test
  connection" button (`GetToys` sent directly from the config page's own
  webview, no pkjs round-trip), a "Test vibration" button (brief low-
  intensity pulse, same direct-from-webview approach), and custom toy groups
  (named subsets of known toys, targeted via a comma-joined `toy` field).
- Light/dark toggle for the settings page's own chrome, via CSS custom
  properties on `<body data-theme>` — accent stays the same pink in both
  modes, only backgrounds/text/dividers flip.
- A persistent toy name + battery row in Basic mode (previously Discrete-
  only), plus a `battery_source` setting for whether that reading is the
  watch's own or the selected toy's.
- "Save custom colors as a new named preset," with delete — the Presets tab
  is now the 15 built-ins plus any custom ones, added/removed entirely
  client-side in the config page and persisted through the same Save flow
  as everything else.
- Preventing the same color being selected for text and background in
  Custom mode — a swatch pick that would collide with its paired field is
  rejected with an alert instead of applied.
- A three-state toy-connection glyph (connecting/connected/disconnected)
  instead of the original two-state one, to avoid the brief window right
  after launch where "connected" is shown optimistically before the first
  real check completes — also re-shown if the toy-events socket drops
  mid-session and a reconnect is pending, not just at first launch.

Other ideas:
- Persist the selected pattern and toy with `persist_write_int`/a small
  on-watch string buffer, the same way `ui_style` and the colors are, if you
  want them to survive app restarts.
- Real hardware testing and layout tuning for the Chalk (round) variant.
