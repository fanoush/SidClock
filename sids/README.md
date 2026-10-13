# SID library

The watch plays `.sid` files from the `/home` LittleFS partition on the
external flash. This directory is the local staging area for tunes and for
the HVSC databases used by `tools/sid_add.py` (`Songlengths.md5`, the
legacy `Songlengths.txt`, and `STIL.txt`).

No SID files are committed to this repository.

## Getting tunes

Run once (downloads the HVSC databases + eleven well-known sample tunes):

```sh
sids/fetch-samples.sh
```

Or copy your own collection from a local
[High Voltage SID Collection](https://hvsc.c64.org/) checkout.

**Licensing:** every SID file is copyrighted by its composer and/or the
rights holder; HVSC distributes the collection with their permission.
Fetching tunes for private use is fine, but do not redistribute them
(keep them out of git - they are already in `.gitignore`). Credit belongs
to the composers: Commando / IK+ / Knucklebusters © Rob Hubbard, Last
Ninja © Ben Daglish / Anthony Lees, Thing Bounces Back © Ben Daglish,
Last Ninja 2 © Matt Gray, Last Ninja 3 © Reyn Ouwehand, Ocean Loader 2 /
Yie Ar Kung Fu © Martin Galway, Supremacy © Jeroen Tel, Shades © Chris
Hülsbeck.

Some HVSC entries do not play well on the device's cSID-light core:
Arkanoid is now shipped as an RSID (Real C64) image and Parallax's player
fails to emulate correctly, so neither is part of the sample set.

## Preparing and uploading a tune

`tools/sid_add.py` computes the HVSC fingerprint of a tune, looks up its
length(s) and STIL metadata, writes the device sidecars and uploads
everything:

```sh
export SIDCLOCK_ADDR=AA:BB:CC:DD:EE:FF     # or pass --addr
tools/sid_add.py sids/Last_Ninja_2.sid
```

It creates/updates, next to the tune:

| File | Format | Purpose |
|---|---|---|
| `<name>.sid` | PSID/RSID | the tune |
| `<name>.len` | space-separated seconds per subsong | end-of-subtune/tune detection |
| `<name>.stil` | one line per subsong name, last line = comment | info screen + marquee |

All three are uploaded to `/home` on the watch. The player sorts tunes by
file name and reads `<stem>.len` / `<stem>.stil`, so the stems must match.
The SID player's `END` mode decides what happens when a length expires:
`LOOP`, `NEXT TUNE` or `NEXT SUB` (default).

Manual upload without sidecars also works:

```sh
smpmgr --ble <addr> file upload sids/Commando.sid /home/Commando.sid
```
