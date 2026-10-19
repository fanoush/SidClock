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

The [web remote](../README.md#web-remote) does the same from a browser:
search hvsc.c64.org, upload (with `.len`/`.stil` built in the page),
list, play and delete. The search follows the API's own rule - every
query word against the title, the author **and** the released line - so
the `name`/`author`/`released` boxes decide what counts: name and author
are on by default, which keeps HVSC series names ("1987 Commando
Frontier") out of a title search. The API returns every match and takes
no paging parameters, so the page draws 100 rows and a "show more"
button continues the list. `web/hvsc.js` has to keep matching
`tools/sid_add.py` - same caps, same truncation - and both are checked
against the same fixtures in `tools/web-tests/`.

The page labels the tune it is showing by the **whole-file MD5** the
device reports for the file it actually loaded (`info` characteristic
bytes [88..95], the first 4 bytes of the digest as 8 hex characters):
`Songlengths.md5` is keyed on exactly this digest, so the lookup is
exact even for renamed uploads and for the ~3,700 basenames HVSC reuses
across directories. Without an id (no tune, or a hash that failed) the
page falls back to the upload record, then to the case-sensitive file
name - and marks a name match that several HVSC files share, because
then the metadata may describe a different tune.

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
