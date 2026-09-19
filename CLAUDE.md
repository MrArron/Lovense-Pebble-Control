# CLAUDE.md

Guidance for any Claude Code session (local or cloud) working in this repo.

## What this is
"Lovense Remote for Pebble" — a Pebble smartwatch app (C, `src/c/`) plus a
PebbleKit JS phone companion (`src/pkjs/`) that controls Lovense toys over
the local Wi-Fi LAN API exposed by the Lovense Remote app's Game Mode. Ships
to all 7 Pebble platforms (aplite, basalt, chalk, diorite, emery, flint,
gabbro) via the Rebble Appstore.

## Build & test toolchain — local-machine only
Building and testing use `pebble-tool` (v5.0.40, SDK 4.33.1) inside a WSL
Ubuntu sandbox on the developer's Windows machine, invoked against the repo
mounted at `/mnt/c/Users/User/OneDrive/Documents/GitHub/Lovense-Pebble-Control`.
**This toolchain, the QEMU emulator, and the developer's real Pebble Time 2 /
Pebble Round 2 hardware only exist on that local machine.** A cloud Claude
Code session has none of it: no WSL, no emulator, no Bluetooth/USB path to
real hardware, and no logged-in CloudPebble/Rebble developer session.

**Practical effect for a cloud session:** implement changes, commit them to
a feature branch, push, and explicitly tell the developer what needs to be
verified locally before the change can be called tested/working — never
claim something was tested/verified/working unless it actually was, by
whichever side (local session or developer) is capable of doing so.

**What can only be verified locally, and how** (for the developer, or a
local Claude Code session with WSL access):
- **Emulator smoke test** — `pebble build` → `pebble install --emulator
  <platform>` → `pebble screenshot --no-open --emulator <platform> <path>` /
  `pebble logs --emulator <platform>` / `pebble emu-button click
  <select|back|up|down> --emulator <platform>`. Run after every dev round:
  the new/changed feature plus a spot-check of core features on emery
  (Pebble Time 2, flagship) and gabbro (Pebble Round 2) for touch features,
  and a boot/UI pass on the rest for regressions.
- **Real hardware** — CloudPebble needs a manual *pull, then a manual
  Build* (pull alone produces nothing installable) before installing to the
  paired phone/watch. Only the developer can confirm real-device behavior.
- **Store-listing GIFs/screenshots and `pebble publish`** — also require
  the local WSL pebble-tool plus `ffmpeg` and an authenticated Rebble login;
  regenerate all 7 platforms' assets every release (see prior session
  history / project memory for the exact capture recipe).

## Git workflow
- Feature branch until the developer has personally confirmed the change on
  real hardware; `main` only on their explicit go-ahead.
- If a bug affects what's already shipped on `main`, flag it and get
  explicit confirmation before patching `main` directly.
- Every publish (CloudPebble or `pebble publish`) needs real release notes/
  changelog, not just a version bump.

## `.claude/`
Tracked in this repo (skills, project tooling) so any session — local or
cloud — starts with the same capabilities. Session-local runtime files
(lock files, caches) are gitignored, not committed.
