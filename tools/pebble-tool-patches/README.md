# pebble-tool local patches — moved

The `pebble-tool` toolchain (`~/.local/share/uv/tools/pebble-tool/...` in
WSL) is a single install shared by every Pebble project on this machine —
not something specific to this repo. Tracking the local customizations
made to it (extra `pebble emu-*` commands, GIF/screenshot capture logic)
lives project-agnostically at:

```
~/pebble-tool-patches/    (WSL home directory)
```

See that directory's `README.md` for the full list of what's been added,
`snapshot/` for known-good copies of the patched files, and `apply.sh` to
reapply them after a `uv tool upgrade`/reinstall wipes the live install
(which happens silently — `uv` has no idea these edits exist).

## Why this note is here instead of the content itself

This doc used to hold full copies of the patched files, added while
building the `emu-touch`/`emu-swipe` touchscreen-emulation commands
(2026-09-19). Since `pebble-tool` isn't part of any one project, keeping
that tracking here would mean a future Pebble project — and any Claude Code
session working on one — would have no reason to know this repo, or this
doc, exists. Moving it to the WSL home directory makes it discoverable
regardless of which project's session goes looking for it.

If `~/pebble-tool-patches/` is ever missing (new machine, fresh WSL distro,
etc.), the touch/swipe feature's rationale and implementation are also
described in this repo's git history around 2026-09-19, and in the
[coredevices/PebbleOS](https://github.com/coredevices/PebbleOS) project's
own `pbl touch`/`pbl swipe` dev commands
(`tools/libs/pbl-cli/pbl/emulator.py`), which use the same QMP mechanism.
