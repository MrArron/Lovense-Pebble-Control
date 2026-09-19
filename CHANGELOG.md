# Changelog

Release notes for Lovense Remote for Pebble. This file starts at 1.2.1 —
history before that lives in `README.md`'s "Project status / where this was
left off" section, which stays the fuller narrative record of design
decisions and reasoning; this file is the short version meant for pasting
straight into a `pebble publish` release-notes field or a store listing
update.

## [1.2.1] - 2026-09-19

### Added

- Full Material Design 3 redesign of the phone-side settings page, from a
  single-scroll page (Presets/Custom/Toy tabs) into a 4-tab bottom-nav app
  (Connect / Display / Control / Toys), built from a Claude Design handoff
  package and seeded from Lovense Pink (`#B8004F`): MD3 color tokens
  (light/dark, following the phone's System/Light/Dark setting), filled
  text fields, choice chips, ripple state-layer feedback on every
  interactive surface, a swatch-pop animation, and a snackbar that replaces
  the old `alert()` calls for validation/conflict messages.
- A 16th built-in color preset, "Rose" (`#7a1f5e` bezel / `#fce8f3` bg /
  `#2d0a2e` text), matching the design handoff's preset table.
- Expanded the Custom-tab swatch sets from 8/7/10/6 to 18/18/18/12
  background/text/accent/active options, per the design handoff's tokens.

### Changed

- Colors moved from a top-level Presets/Custom tab pair into a sub-section
  of the new Display tab.
- The digital (chrono) preset-tile preview, custom-preset delete, toy-group
  management, and the live Custom-tab color preview all carried over from
  the previous settings page with the same behavior, restyled to MD3.

### Security

Two gaps in the settings-page generator were found and closed. Both existed
in the pre-redesign page too — carried forward unintentionally while
rebuilding the page, not introduced by the MD3 rewrite itself — and neither
is exploitable through the app's own normal UI, since the data they touch
can currently only ever be written by the settings page's own save flow.
Fixed now as defense-in-depth, in case that data is ever read from or
written to outside the app's control (a compromised phone, a bug in a
future change, etc.):

- **Persisted `customPresets`/`toyGroups` were evaluated as JavaScript, not
  parsed as JSON.** The generator spliced the raw stored string directly
  into the settings page as executable source (`return <raw string>;`
  inside a try/catch), rather than treating it as data. If that stored
  value were ever anything other than well-formed JSON, it would have run
  as code in the settings WebView the next time Settings was opened. Fixed
  by `JSON.stringify()`-encoding the raw string into a proper JS string
  literal and having the page call `JSON.parse()` on it at runtime instead.
- **Saved host, port, and color values were spliced into HTML attributes
  unescaped.** `lovenseHost`, `lovensePort`, and the four persisted color
  values (`basicColorBg/Text/Accent`, `discreteColorActive`) were written
  into `value="..."`/`style="background:...""` attributes without escaping
  quotes or angle brackets. A stored value containing `">` could have broken
  out of the attribute and injected markup/script into the settings page.
  Fixed by running these through the existing `escapeHtml()` helper (already
  used elsewhere in this file for toy id/name from the unauthenticated
  Lovense LAN API) before interpolation.

No fix here changes the save/close message-key contract (`webviewclosed`
still reads the same keys) or touches watch-side C, so no persisted-storage
or `AppMessage` key changes are needed.

### Verified (local build + emulator, this session)

- `pebble build` succeeds clean on all 7 target platforms.
- `pebble install --emulator emery` + `pebble emu-app-config`: full
  interactive pass over all 4 tabs (Connect / Display / Control / Toys) —
  all 16 color presets render (including the new "Rose"), Custom-tab
  swatch selection updates the live preview instantly, tab navigation and
  the Presets/Custom sub-tabs work, Save triggers the MD3 snackbar
  ("Settings saved — sending to watch…") with zero JS console errors —
  including with an attribute-breaking (`"`, `=`) string typed into the
  host field, confirming the `escapeHtml()` fix doesn't break normal input
  handling.
- `pebble install --emulator gabbro` + boot screenshot: Basic-style watch
  face renders correctly on the round display, no regression.
- Note: the settings page's Save button closes via
  `document.location="pebblejs://close#..."`, the real-phone convention —
  no desktop browser has that protocol registered, so the actual
  save-to-watch-storage round trip can only be confirmed on a real phone,
  not via the emulator/browser flow. That leg is covered by the real
  hardware verification below.

### Verified (developer, real hardware)

- **Pebble Time 2 (Emery)**: confirmed working, including the security-fix
  commit specifically (the escaping + `JSON.parse` fixes), via the phone
  companion app's settings flow.

### Not yet verified

- The MD3 settings page on Gabbro or Chalk with a real device (emulator
  install/boot confirmed above for Gabbro; the settings webview itself
  still only has emulator-side visual/functional coverage there, per the
  `pebblejs://close` limitation above).
