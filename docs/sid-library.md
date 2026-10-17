# SID library and player

## What the player does

- Reads **PSID/RSID** tunes from `/home` on the external flash, in file
  name order. Files up to ~200 kB are streamed from flash into the
  emulator's 64 kB C64 map.
- A tune loaded by hand (tune change, SUB+/-, PLAY, BLE `sid`/`sidname`)
  starts at the **default subtune** from the PSID header; the SID screen
  has SUB-/SUB+ transport plus play/pause/stop.
- **Chip model**: `auto` follows the PSID flags; 6581/8580 can be forced
  for A/B comparison. Switching reloads the tune.
- **Song length sidecars**: `<stem>.len` contains seconds per subsong
  (space/comma/newline separated; a single value applies to all). Without
  a sidecar the tune simply loops.
- **End modes** (`END:` button): `LOOP`, `NEXT TUNE` or `NEXT SUB`
  (default) - what happens when the current length expires. In `NEXT SUB`
  mode an automatically loaded tune starts at its **first** subtune, so
  the subtunes before the header default are not skipped on the way
  through; `NEXT TUNE` starts each tune at the header default (the
  author's pick).
- **STIL sidecar**: `<stem>.stil` holds one line per subsong name (may be
  empty), the tune-level comment line, then optional `@<subsong> <text>`
  lines with per-subsong notes (HVSC's `(#N)` comments). The player shows
  the names in the subtitle and scrolls the comment for the current
  subsong, falling back to the tune comment when the subsong has none.
  Each marquee keeps its scroll position while its text stays the same
  (so a shared tune comment keeps scrolling across subsongs and is not
  redrawn while unchanged). All parts are optional.

The marquee only advances while the SID screen is visible; playback and
auto-advance continue while the device is idle or asleep.

## Getting tunes onto the device

No SID files are committed to the repository. Fetch the sample set plus the
HVSC databases:

```sh
sids/fetch-samples.sh            # 8 tunes + Songlengths.txt + STIL.txt into sids/
```

Import a tune (fingerprints it against the HVSC Songlengths database,
writes `.len` + `.stil`, uploads all three files to `/home`):

```sh
export SIDCLOCK_ADDR=AA:BB:CC:DD:EE:FF
tools/sid_add.py sids/Last_Ninja_2.sid
tools/sid_add.py --no-upload sids/*.sid       # sidecars only, no BLE
```

Manual upload also works (sidecars are optional):

```sh
smpmgr --ble <addr> file upload sids/Commando.sid /home/Commando.sid
```

Remove a tune (a `.sid` also removes its `.len`/`.stil` sidecars):

```sh
tools/sidclock_ble.py filedelete Parallax.sid
```

**Licensing**: SID files are copyrighted by their composers; HVSC
distributes them with permission. Keep them out of git - they are ignored
by `.gitignore` - and credit the composers. See `sids/README.md` for
details.
