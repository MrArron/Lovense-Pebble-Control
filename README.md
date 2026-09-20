# Lovense Remote for Pebble

Control Lovense toys from your Pebble watch. The watch sends button presses
over Bluetooth to a small companion script running in the Pebble phone app,
which relays them as HTTP commands to the Lovense Remote app's local
"Game Mode" API.

```
Pebble watch  --AppMessage-->  Phone (PebbleKit JS)  --HTTP POST-->  Lovense Remote app (Game Mode)  --BLE-->  Toy
```

## Project status / where this was left off

**Published**, current version **1.2.3**. Confirmed working on real hardware
for both touch-capable platforms: Pebble Time 2 (Emery) and Pebble Round 2
(Gabbro) - boot, Basic mode, both Discrete faces, all three gesture-control
modes (accelerometer double-knock, and the touchscreen's double-tap/
long-press/swipe-to-set-intensity), the safety auto-pause timer, and the
settings page. Chalk (round, non-touch) has only been verified in the
emulator - no non-Gabbro round hardware has been available to test against
yet. The Material 3 settings page and the 1.2.2 performance/bugfix round
(see below) are both confirmed on real Pebble Time 2 (Emery) hardware;
Gabbro and Chalk still need the same re-verification pass the rest of the
app already has.

**This round (touch/gesture round) added**: a swipe-to-set-intensity touch
overlay (a vertical drag anywhere on screen sets vibration level directly
from absolute touch position, live, on Emery/Gabbro in Touchscreen mode) with
a wash-fill + split-color number visual and a brief fade-out on liftoff;
long-press-to-cycle-pattern extended to Basic mode (previously
Discrete-only, for consistent touch behavior across all three faces); a
gesture-control-change hint card that slides in to explain the active
gesture mode's controls whenever it changes, auto-dismissing after a few
seconds or on any button press/swipe; a configurable safety auto-pause
(stops vibration after continuous use - Off/1/3/5/10/15 minutes, default 3,
with a haptic warning in the final 15 seconds, reset by any button press or
touch); and WCAG contrast fixes across 8 of the 15 built-in color presets.

Two real bugs surfaced specifically by hardware testing this round (the
emulator has no touch-simulation path at all, so neither was catchable
before real-device testing), both since fixed: the swipe overlay's intended
translucent wash rendered fully opaque on real hardware (Pebble's solid
fills ignore `GColor8`'s alpha channel entirely - alpha only applies to
bitmap compositing - fixed with a software color blend toward the active
background instead), and the overlay's number briefly rendered pinned to
the fill boundary instead of staying centered (a text-layout bug in how the
split-color effect was drawn, not a hardware quirk - fixed by moving the
white half of the number into its own clipped child layer).

**Local build/test toolchain**: this project builds and runs locally via
`pebble-tool` + the Pebble SDK (WSL/Ubuntu, since the SDK doesn't run on
Windows directly) — `pebble build`, `pebble install --emulator <platform>`,
`pebble screenshot`/`emu-app-config`, and `pebble publish` (release notes +
screenshot/GIF upload) all work against this repo. **This toolchain, the
emulator, and real hardware only exist on the developer's local machine —
see `CLAUDE.md` for what that means for a Claude Code session working here
without local access.** Two build-breaking bugs
this surfaced early on and fixed: the repo was missing the `wscript` build
script pebble-tool requires, and `package.json`'s launcher icon was declared
as two separate `menuIcon: true` resources, which the SDK's appinfo generator
rejects outright (collapsed to one entry using the standard `~bw`/`~color`
filename-tag convention). `enableMultiJS: true` was also added, which is
required for the settings webview to run under `pebble-tool`'s local JS
engine (`pypkjs`) at all. Targets now also include `flint` (Pebble 2 Duo) and
`gabbro` (Pebble Round 2) alongside the original five.

**This round (MD3 settings redesign) added**: a full Material Design 3
rewrite of the phone-side settings page, from a single-scroll page with
Presets/Custom/Toy tabs into a 4-tab bottom-nav app (Connect/Display/
Control/Toys), built from a Claude Design handoff package and seeded from
Lovense Pink (`#B8004F`) — MD3 color tokens (light/dark, following the
phone's own System/Light/Dark setting), filled text fields, choice chips,
ripple state-layer feedback on every interactive surface, a swatch-pop
animation, and a snackbar replacing the old `alert()` calls for validation/
conflict messages. Colors moved into a Display-tab sub-section; the custom
swatch sets expanded from 8/7/10/6 to 18/18/18/12 background/text/accent/
active options, and a 16th built-in preset ("Rose") was added. A security
pass on the new page closed two pre-existing gaps it inherited from the old
page: persisted `customPresets`/`toyGroups` JSON was being spliced into the
generated page as executable JS source (`return <raw>;` inside a try/catch)
rather than actually parsed, and the saved host/port/color values were
spliced into HTML attributes without escaping — both are now safe even if
`localStorage` were ever corrupted or tampered with outside the app. The
save/close message-key contract is unchanged, so no watch-side C or
persisted-storage changes were needed. Confirmed on real Pebble Time 2
(Emery) hardware; see "Project status" above for what's still outstanding on
Gabbro/Chalk.

**This round (1.2.2, redraw/resync performance)** cut redundant work found
during a codebase review, with no intended behavior change except one real
bug fix: `inbox_received_callback` now only persists and applies a setting
when the incoming value actually differs from current state, instead of
redoing the work on every tuple in the phone's full settings resend on
every app launch — previously this meant an unconditional UI teardown/
rebuild, several flash writes, and (the actual user-visible bug) the
gesture-mode hint card popping up on *every* app open rather than only on
an actual gesture-mode change. Also: `draw_rotated_rect` (every tick/hand/
needle draw) no longer allocates/frees a `GPath` per call; UP/DOWN no
longer force a full date/secondary-display recompute (a real Health
Service query on every press when Chrono's secondary display is Steps or
Heart Rate); the per-redraw layout-scale calculation is now computed once
and cached instead of recomputed on every callback; the swipe-intensity
overlay's two draw procs share one text-layout computation instead of each
computing it independently on every drag-move event; and the phone-side
toy-groups JSON is memoized instead of re-parsed on every toy-list refresh.
Confirmed via emulator smoke test across all 7 platforms and real Pebble
Time 2 hardware.

**This round (1.2.3, icon rebrand)** replaced the watch's launcher icon
(`resources/images/icon~color.png` / `icon~bw.png`) with the app's own
brand mark, dropping the prior Lovense-logo-derived design. Drop-in image
swap only, no code changes — not re-verified in the emulator or on real
hardware as part of this round (see `CLAUDE.md`).

**Discrete mode has two selectable faces** — see "Display styles" below:

- **Analog** — an ordinary analog watch face; the second hand encodes
  vibration level (position + color), reverting to true seconds after the
  idle stand-down period. Hour/minute hands have rounded tips, and the
  6 o'clock tick is replaced by a small vector glyph (flat line/square
  wave/sine curve) showing the current pattern.
- **Digital** — digital time with a chronograph-style sub-dial at 6 o'clock
  encoding level, plus a Steady/Pulse/Wave totalizer register drawn as the
  same waveform glyphs (originally Roman numerals I/II/III, replaced in a
  later design pass).

Both faces share the existing bezel/background/text color model plus an
independent **active (vibrating) color**, default Lovense pink (`#FF2D89`,
per Lovense's own site), never reset by presets. Non-Emery rectangular
platforms (aplite/basalt/diorite/flint) get every Emery-derived layout
constant scaled proportionally rather than clipped; Chalk and Gabbro (both
round) keep their own hand-tuned numbers per platform — Gabbro's screen is
260×260 versus Chalk's 180×180, so it needed its own constants rather than a
simple scale-up (see "Round display support" below).

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
"Lovense pink" preset. The watch's launcher icon
(`resources/images/icon~color.png` / `icon~bw.png`) is the app's own brand
mark, not Lovense's logo.

**Deferred, not yet built**: persisting the selected pattern/toy across app
restarts, real-hardware testing/layout tuning for Chalk (the one round
platform not yet confirmed on physical hardware), and real-hardware
verification of the new MD3 settings page on Gabbro and Chalk (Emery only,
so far). See "Extending it" at the bottom.

**To resume this work in a new session** (local or cloud), the most useful
things to have on hand are: this README (all the design decisions and
reasoning) and `CLAUDE.md` (the build/test toolchain and what's local-only
vs. safe for a cloud session to do) — both are tracked in the repo, so a
fresh clone has them automatically. Paste in a description of what's
changed since if you've made manual edits outside of git. The project's
current UUID, message-key list, and persisted-storage key numbering are all
in `package.json`/`main.c` and shouldn't need to change for any of the
deferred features above.

## What's included

- `src/c/main.c` — watchapp UI. UP/DOWN adjust intensity (0–20, steps of 2)
  and, held, cycle patterns. SELECT pauses/resumes at the current level.
  Only the currently-active display style's layers exist in memory at any
  time; Basic mode's button bar is hand-drawn instead of loaded from image
  resources; `heap_bytes_free()`/`heap_bytes_used()` are still logged at
  every major lifecycle point (kept in place through active development).
  Includes Discrete's 10s idle-revert-to-real-seconds (Analog/Digital hand
  position, not Basic — see "Idle behavior"), the round-display (Chalk,
  Gabbro) layout variants, gesture control (accelerometer/touchscreen/off —
  Emery/Gabbro only), and the edge-to-edge bezel fix — see their own
  sections below.
- `src/pkjs/index.js` — companion JS that turns those button presses into
  Lovense Standard API calls (`POST /command`), including native Pulse/Wave
  pattern parameters and toy-connection polling/events, and provides the
  settings page: a Material Design 3, 4-tab app (Connect/Display/Control/
  Toys) with 16 color presets plus an 18/18/18/12-swatch Custom color
  editor under Display, and a disclaimer/GitHub link. Commands target
  every toy currently connected to Lovense Remote, or a saved multi-toy
  group.
- `package.json` — project manifest (UUID, targets, AppMessage keys,
  `resources.media` for the launcher icon). The button bar is still drawn
  in code, not loaded from a PNG - the only bundled image resource is the
  launcher icon itself (see `resources/images/`).
- `resources/images/icon~color.png` / `icon~bw.png` — the watch's launcher
  icon shown in Pebble OS's app list: the app's own brand mark, in color
  (color platforms) and a black/white variant (Aplite/Diorite). Declared as
  a single `MENU_ICON` entry in
  `package.json` (`file: "images/icon.png"`) — the `~bw`/`~color` filename
  tags are Pebble's built-in per-platform resource-variant convention, which
  the SDK resolves automatically per target platform. This is required: the
  SDK's appinfo generator rejects a project with more than one
  `menuIcon: true` resource entry, even when each entry is scoped to
  different platforms via `targetPlatforms` — the only supported way to
  have distinct bw/color icon art is one entry using this tag convention.
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
    it's just a second hand at a plausible position. Hour/minute hands have
    rounded tips; the 6 o'clock quarter-tick is replaced by a small vector
    glyph (`draw_pattern_glyph`) showing the current pattern.
  - **Digital** — digital `HH:MM:SS` time (real, live seconds, ticking
    continuously) with a day-of-week row, plus a chronograph-style sub-dial
    at 6 o'clock whose needle *always* encodes vibration level (angle =
    level⁄20 of a full turn — no idle-based behavior at all) and whose
    ring/needle color follows the same active/muted state rule as the
    Analog hand. Below it, a Steady/Pulse/Wave register drawn as the same
    waveform glyphs (originally Roman numerals I/II/III, replaced in a
    later design pass) with a marker triangle on the selected pattern reads
    as an ordinary chronograph totalizer. Rect platforms only — Chalk and
    Gabbro have no room for it.

  **Analog's** level hand reverts to showing **true elapsed seconds** (an
  ordinary running second hand) after the idle stand-down period with no
  button press, and snaps back to the vibration-level position the instant
  a button is pressed — the same "look ordinary at rest" idea 1a's
  digit-disguise used, just expressed as hand position instead of a digit
  swap. Color (muted/active) always reflects real vibration state
  regardless of idle. **Digital's** sub-dial doesn't need this same trick —
  its main clock already always shows real time continuously, so the
  disguise's "look ordinary at rest" job is already done; the sub-dial
  needle just always shows level, full stop.

  The date row can be switched to show today's step count or current heart
  rate instead (a settings-page radio group, `secondary_display`, default
  "Date") — **Digital** always honors it; **Analog** does too on rectangular
  platforms (there's room in the date aperture), but round Analog (Chalk/
  Gabbro) always shows the date regardless of the setting, since a walking-
  person/heart glyph crowded next to a small round clock face didn't read
  well visually. Steps are read via
  `health_service_sum_today(HealthMetricStepCount)` (accelerometer-derived,
  works on every target platform, no dedicated pedometer needed) — not
  `health_service_peek_current_value()`, which the SDK docs explicitly
  call out as inapplicable to accumulator metrics like step count (always
  returns 0 for them); using the wrong one was a real bug caught via
  real-hardware testing. Heart rate is the opposite case: it's an
  instantaneous metric, so `health_service_peek_current_value
  (HealthMetricHeartRateBPM)` is the *correct* call there. Both show a
  `no-perm`/`n/a` fallback (via `health_service_metric_accessible`) instead
  of silently displaying 0 when the metric can't be read. The walking-person
  (U+1F6B6) and heart (U+2764) glyphs are literal Noto emoji characters
  embedded directly in the string — confirmed rendering correctly on real
  Pebble Time 2 hardware, even though it isn't an officially-documented
  third-party capability (Pebble's public `FONT_KEY_*` system fonts don't
  list emoji, but the text renderer evidently falls back to an emoji-capable
  font for unmapped codepoints, the same way notification text does).

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
(falling back to its model name) is what shows on the watch, truncated to 9
characters (`TOY_NAME_MAX_CHARS` in `index.js`) — empirically the longest
that fits the Basic mode toy/battery row without clipping on Chalk's
narrower screen, the tightest case across all target platforms.

Under the hood, `index.js` keeps an ordered list (`All Toys` always first)
and an index into it; outgoing `Function`/`Pattern` requests include a `toy`
field with the selected ID, or omit it entirely for "All Toys" (per the
Standard API's own behavior — omitting `toy` targets every connected toy).
Switching while active stops whatever was running on the old target and
restarts it on the new one, using the last known intensity and pattern.

Selection isn't persisted on either side — both the watch's index and the
phone's list reset to "All Toys" on relaunch.

**Toy groups**: the settings page's Toys tab lets you check a subset of known
toys, name the group, and save it — groups are appended to the hold-SELECT
cycle after the individual toys (`{name, toyIds:[]}` in `localStorage`,
merged into the toy list fresh on every GetToys/Events refresh via
`appendToyGroups()`, dropping any stale member ids silently). Targeting a
group sends every member's id at once, comma-joined into the `toy` field
(`currentToyId()` joins an array selection into a single string before any
`Function`/`Pattern` request sees it) — the Standard API's documented way to
target multiple specific toys at once (Remote 7.71.0+).

## Basic and Discrete mode colors

Basic and Discrete share **one color scheme** — background, text, and
accent/bezel — not two independently-settable ones. On the wire and on
persisted storage, they're still separate values (`basic_bg_color`/
`discrete_bg_color` etc., six `AppMessage` keys / `PERSIST_KEY_BASIC_*` /
`PERSIST_KEY_DISCRETE_*` on the watch, unchanged since day one), but the
Custom sub-tab's swatch rows write to both sides of each pair at once
(`swatchRow()`'s `data-target` takes a space-separated list of hidden-input
ids now, e.g. `"basicColorBg discreteColorBg"`), so a user only ever sees
and picks three colors, not six, and the two display styles can't drift
apart the way they used to. Discrete's bezel and Basic's accent are the
same underlying role (bezel↔accent), matching how presets already treated
them before this change.

On top of that shared scheme: a persistent toy-name + battery row in Basic
(battery source — watch's own or the selected toy's — is a separate
setting), and an independent **active (vibrating) color** (default Lovense
pink) used only by Discrete's two faces and never touched by presets or the
shared scheme above (nothing in Basic mode needs a vibrating-state color).

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
and **Toy**. Presets is the default — a grid of 16 ready-made looks (the
original 12 — Lovense pink, Classic, Midnight, Forest, Plum, Teal, Rust,
Amber, Slate, Crimson, Violet, Ocean — plus Steel, Ink, Sand, and Rose,
the last added in the MD3 settings redesign), each a small live-rendered
tile showing its actual bezel/background/text colors.
Tapping one sets all six color fields at once (Basic's background/text/
accent and Discrete's bezel/background/text), using the mapping: Discrete's
bezel becomes Basic's accent, and Discrete's background/text become Basic's
background/text — so a preset gives one consistent look across both display
styles rather than needing to set six values by hand. The active/vibrating
color is deliberately not part of any preset (built-in or custom) — it's a
standalone always-pink-by-default setting a preset tap never overwrites.

Custom reveals three swatch rows — Background, Text, Accent/bezel — each
merged from the old separate Basic/Discrete swatch lists (deduping
near-identical colors that had drifted apart, e.g. two slightly different
off-white creams) into one set per role, so the same color sits in the same
position whether you're thinking of it as "Basic's accent" or "Discrete's
bezel." Lovense pink (`#FF2D89`, confirmed against Lovense's own site) is
available both as a one-tap preset and as a standalone swatch, so it can be
mixed with any other color too. It's also this app's **default** color
scheme on a fresh install, before Settings has ever been opened.

Each preset tile's preview now renders a small mockup of whichever Discrete
face is currently selected, using that preset's actual colors — a tiny
CSS clock face (bezel-colored ring, background-colored dial, hour/minute/
level hands in text/muted tone, fixed at a static "10:10"-style angle,
not real time) for Analog, or a small rounded rect with a time readout and
a sub-dial ring stand-in for Digital — instead of the earlier generic
day-row/time/date approximation that didn't resemble either real face.

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

**Discrete mode, Analog face**: after 10 seconds with no button press, the
level (second) hand reverts to showing real, sweeping seconds —
indistinguishable from an ordinary running second hand at rest. Any button
press immediately snaps it back to the vibration-level position and
restarts the 10s timer. Color (muted/active) is unaffected by idle state
either way — only the hand's *position* is disguised.

**Discrete mode, Digital face**: no idle behavior at all — its clock always
shows real, live `HH:MM:SS`, and its chrono sub-dial needle always shows
vibration level, full stop. The main clock already does the "look ordinary
at rest" job continuously, so the sub-dial doesn't need its own idle trick
on top of it (earlier versions gave it one; removed once the clock itself
started showing real seconds, since it became redundant).

The watch switches from `MINUTE_UNIT` to `SECOND_UNIT` tick updates
whenever *either* condition needs live seconds: Analog while idle, or
Digital unconditionally while active (`apply_idle_state()`,
`need_seconds = discrete_active && (s_discrete_face == DISCRETE_FACE_CHRONO || s_idle)`)
— Basic mode and a paused/non-idle Analog face stay on `MINUTE_UNIT` to
avoid the battery cost of ticking every second when nothing needs it.

**Basic mode**: no idle behavior — removed after real-hardware feedback that
it wasn't wanted there. Basic's tip text always shows the button-hint text
(still briefly overridden by the unrelated 5s toy-name-reveal on hold-
SELECT). `reset_idle_timer()` no longer even arms the underlying timer while
Basic is active, since nothing in Basic reacts to `s_idle` anymore - the
whole mechanism is Discrete-only now.

## Round display support (Chalk, Gabbro)

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

All of this is behind `#if defined(PBL_ROUND)` (true for both Chalk and
Gabbro) and was never tested on actual round hardware - the emulator is the
only thing this has run against. Real-hardware layout tuning may be needed.

**Gabbro (Pebble Round 2)** is a second round platform, 260×260 versus
Chalk's 180×180 — 44% larger, not just a scaled-up Chalk. Since a naive
scale-up isn't necessarily the right visual answer, Gabbro gets its own
hand-tuned constants (`#if defined(PBL_PLATFORM_GABBRO) / #elif
defined(PBL_ROUND) [Chalk] / #else [rect]` three-way branches in
`build_analog_face`, `analog_hands_update_proc`, `build_chrono_face`,
`chrono_subdial_update_proc`), sized against Claude Design's own pixel
values for a 260×260 canvas rather than derived from Chalk's numbers. The
bezel inset is also wider on Gabbro (8px vs Chalk's 6px) — 6px read as a
near-invisible hairline at the larger size.

Gabbro is also one of two platforms (with Emery) that has a real capacitive
touchscreen — see "Gesture control" below.

## Gesture control (Emery, Gabbro)

A settings-page radio group (`touchPlayMode` in `index.js` /
`s_touch_mode`/`TOUCH_MODE_*` in `main.c`, persisted as an int) lets you
choose how the watch responds to a knock or touch, for the two platforms
that have either an accelerometer worth using this way or a real
touchscreen:

- **Accelerometer** (default) — `accel_tap_service_subscribe`, the SDK's
  knock/shake detector. Requires **two knocks within 400ms** to toggle play/
  pause, not one — a single knock (including an accidental shake of the
  watch) only arms a window for a matching second knock; it doesn't act by
  itself. An earlier single-knock version turned out to trigger from
  ordinary wrist movement, which is why this needs to be deliberate.
- **Touchscreen** — the real capacitive touch sensor
  (`touch_service_subscribe`), not the accelerometer. There's no long-press
  recognizer in the SDK (only tap/pan/swipe), so both gestures are built
  from the raw `Touchdown`/`PositionUpdate`/`Liftoff` event stream:
  - A quick **double-tap** anywhere on the screen toggles play/pause (same
    400ms-window double-action logic as the accelerometer mode).
  - A **long-press** (600ms) changes pattern. On the Digital face's rect-
    only pattern register, all three glyphs are visible at once, so a
    long-press picks whichever one you pressed directly
    (`pattern_register_col_x` hit-testing, shared with the draw code so the
    two can't drift apart). Everywhere else only one glyph is ever shown at
    a time (Analog's 6 o'clock glyph, or Gabbro's round Digital face, which
    has no register at all), so a long-press there just cycles to the next
    pattern instead.
- **Off** — buttons only, no accelerometer or touch handling at all.

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
- Real hardware testing and layout tuning for the Chalk and Gabbro (round)
  variants.
