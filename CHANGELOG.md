# Changelog

## 1.0.7

**Internal**

- `threads` (BLE debug command `1D`) now reports the thread name with each
  stack high-water mark, 4 threads per page, so a tight stack can be
  attributed without recognising its size. Verified on hardware.

## 1.0.6

Weekday fixes in the clock and in REPEAT alarms, a `NEXT SUB` auto-advance
fix, and a leaner release build (~15 KB RAM freed).

**Fixes**

- The clock header and idle screen showed a day of week two days off
  (e.g. "Sun" for a Friday): the weekday index was computed with a
  constant that assumed a different epoch weekday. It now uses
  "1970-01-01 was a Thursday" like the CTS time service already did.
- REPEAT alarms used the same off-by-two index, so they rang two days
  off the selected weekday (a Sunday alarm went off on Friday).
- `NEXT SUB` auto-advance started each newly loaded tune at the PSID
  startSong, which skipped the subtunes before it every time the player
  moved on to the next tune. Automatically loaded tunes now start at
  their first subtune; a manual tune change (and `NEXT TUNE` mode)
  still starts at the header default.

**Host tools**

- `tools/sidclock_ble.py` no longer prints a traceback when the device
  drops the BLE link as a command finishes (it also exits cleanly on
  Ctrl-C during `monitor`), and a device that is not advertising now
  reports one line after a 3 s discovery/connect timeout instead of
  waiting out the 30 s default. `tools/backup_ble.py` ignores the same
  disconnect error.

**Internal**

- `threads` (BLE debug command `1D`) latches the per-thread stack
  high-water marks so a suspected overflow can be sized from the host (a
  thread with less than 256 B free is flagged); it is also how the stacks
  kept in the release build were checked.
- RAM: about 15 KB of the 188 KB is freed. The 8 KB system heap is
  disabled (`CONFIG_HEAP_MEM_POOL_SIZE=0`, verified: nothing in the image
  calls `malloc`/`k_malloc`/`operator new`) and the release RTT log buffer
  drops from 8 KB to 2 KB. Per-block budget: `docs/architecture.md`.
- New debug build: `SIDCLOCK_DEBUG=1 app/build.sh` compiles the bring-up
  test commands back in (test tones, sample-rate/tone ladders, raw MCKFREQ,
  -0.5 KB RAM and their BLE opcodes) and applies `app/prj_debug.conf` for
  the 8 KB log buffer. Release builds reject those opcodes;
  `tools/sidclock_ble.py` reports the rejection in one line instead of a
  traceback. Debug images show `-dbg` in the on-display version string.

## 1.0.5

SID engine: exact ADSR envelope timing restored while keeping the render
speed. Fixes the new engine losing beats and voices in tunes like Last
Ninja 2, second subsong.

**Internal**

- 1.0.4 stepped the envelopes once per sample by replaying every shot
  the sample contained. That rescheduled shots that upstream cRSID
  leaves stalled (its rate counter is only tested against a window of
  the current instruction's cycles), which changed envelope phases and
  dropped envelope steps for seconds at a time in some tunes.
- The envelope pass is event-driven now: the CPU loop folds the cycles
  of consecutive instructions into a per-SID accumulator and runs the
  ADSR emulation only when the earliest shot (or the 0x8000 wrap that
  retries a stalled counter) can be reached within them, or right after
  a SID-register write; provably shotless folded calls collapse into a
  single counter add, and voices holding a level (sustain, released to
  zero) fold through exact modulo math. No sample-boundary rounding
  anywhere, so envelope timing matches upstream again.
- Host verification: bit-identical to upstream cRSID-1.58 on all 20
  sample tunes (single- and multi-SID, including the 2SID/3SID set);
  Last Ninja 2 subsong 2 renders byte-identical WAVs over 60 s. On the
  host worst-window profiler Arkanoid is back within a few percent of
  1.0.4's render time and multi-SID tunes stay well inside the budget.

## 1.0.4

New SID engine with a dual-engine safety net, tuned to fit the real-time
budget on the nRF54L15.

**Features**

- The player now runs cRSID-1.58 (Light profile) instead of the old
  cSID-light core: cycle-exact CPU/ADSR timing, fixed 6581 filter
  low-end (Myth), RTI at $DC0C, more digis and real RSID tunes. The
  default build links both engines: the main-screen button between
  `BLE R/W` and `SLEEP` toggles cRSID/cSID at runtime for tunes that
  play oddly (stops playback, flips the core, restarts the tune), and
  `tools/sidclock_ble.py engine new|old` does the same from the host.
  `SIDCLOCK_SID_ENGINE=crsid` or `=csid` builds single-engine images
  for A/B comparison (their display version gains `-crsid`/`-csid`).
- 2SID/3SID/4SID tune support (PSID v3/v4 and WebSID headers): verified
  on device with Jammer's 2SID/3SID tunes, up to 68% of the audio
  render budget; two multi-SID test tunes were added to
  `sids/fetch-samples.sh`.
- Independent watchdog (30 s, fed from the main loop) reboots the
  device instead of freezing if a thread wedges, and the BLE debug
  snapshot carries crash telemetry: boot count, reset cause, audio/main
  thread heartbeats and the active engine.

**Internal**

- cRSID slimmed for RAM: 4 KB IO banks, no ROM banks (ROM stubs live in
  the RAM copy like the old core), computed memory banking, no
  MD5/SongLengths engine, 320-frame audio buffers; RAM at 99.5%.
- Render-speed work for the M33 (heavy tunes like Arkanoid overran the
  budget in the first port): envelope stepping batched once per sample
  with a multi-shot rate-counter loop, steady voices skipped and their
  rate counters frozen cleanly (woken by SID register writes), memory
  read/write fast paths for non-IO pages, and crash-safety loop bounds
  removed where measurement showed they never fire. Heavy sections are
  ~25% faster than the first port and Arkanoid now fits; normal tunes
  cost ~10% more CPU than the old engine (was 1.7-1.9x at the first
  port). Note attacks may lead by up to one sample (43 us); envelope
  rates are unchanged.

## 1.0.3

Per-subsong STIL comments, plus current-HVSC database support in the
import tool.

**Features**

- The SID screen's scrolling comment line now follows the current
  subsong: when HVSC's STIL database has a note for that subsong (e.g.
  Last Ninja's "EAT YER HEART OUT GALWAY!" on subsong 5) it is shown,
  otherwise the tune-level comment is kept. Notes for tunes without a
  tune-level comment (e.g. Last Ninja 3) show on the annotated subsongs.
- The marquee keeps its scroll position while the displayed text stays
  the same, so the tune-level comment keeps scrolling while stepping
  through subsongs that fall back to it (a subsong's own note starts from
  the beginning). The unchanged comment row is also left untouched on
  such repaints instead of being cleared and redrawn in place.
- Sidecars grew optional `@<subsong> <comment>` lines after the tune
  comment (regenerate them with `tools/sid_add.py`); the firmware sidecar
  buffer went from 1 KB to 3 KB to fit the largest HVSC entries. The tune
  comment no longer carries its trailing newline.
- New `filedelete` command (debug opcode `0x16`): remove tunes from
  `/home`, a `.sid` also drops its `.len`/`.stil` sidecars. Only those
  extensions can be deleted (config files stay protected) and the command
  needs R/W mode.

**Internal**

- `tools/sid_add.py` now looks tunes up in HVSC's current
  `Songlengths.md5` database (whole-file MD5) and falls back to the legacy
  `Songlengths.txt` fingerprint. This fixes recently updated tunes (e.g.
  Arkanoid, Shades) getting no lengths/comments - the legacy database has
  not been regenerated for them. `sids/fetch-samples.sh` downloads both.

## 1.0.2

BLE access modes for when the clock is left unattended, plus main-screen
polish.

**Features**

- Three BLE modes cycled by a new main-screen button: **R/W** (normal),
  **R/O** (read-only: CTS and debug writes are rejected, the
  mcumgr/SMP service - OTA, file upload, os reset - is unregistered) and
  **OFF** (advertising stopped, existing connections dropped). The mode
  is deliberately not persisted: every reboot starts in R/W so OTA and
  development always work. Also settable with the DEV-only `blemode`
  debug/CLI command.
- Main screen: utility buttons rearranged into a 3x2 grid
  (AUTO ROT | AUTO BRI | SND on top, BLE mode | - | SLEEP below); the
  ALARMS tile shows `(ON)`/`(OFF)` instead of highlighting, and the SID
  tile is no longer highlighted (navigation tiles should not look like
  toggles).
- SND OFF now pauses an actively playing tune (silence + idle CPU); SND ON
  resumes it if the mute was what paused it.

**Internal**

- Debug snapshot grew to 132 bytes: byte [128] reports the BLE mode.
  `sidclock_ble.py status` prints it and `sidclock_ble.py blemode`
  switches modes remotely (R/W only).
- `CONFIG_BT_GATT_DYNAMIC_DB=y` for runtime SMP service registration.

## 1.0.1

Timekeeping fix: the wall clock is now driven by the raw GRTC system
counter instead of `k_uptime_get()`.

**Fixes**

- On the nRF54L15 the kernel uptime is seeded through a 32-bit tick count,
  so `k_uptime_get()` steps by a whole 2^32-tick wrap (137,439 s) when the
  GRTC's absolute tick count crosses such a boundary. This jumped the
  clock forward by ~2.3 days overnight (2026-10-13) and ate a morning
  alarm. The wall clock now uses the 64-bit GRTC counter via
  `k_cycle_get_64()`; `time.cfg` gained a GRTC field (old 2-field files
  are migrated on first boot).
- `time.cfg` now stores the actual wall clock at save time (not the stale
  clock base), so a warm reboot no longer drags the clock backwards by the
  time since the last host sync.
- `epoch_now()` keeps the last trusted wall clock when the timebase moves
  backwards or jumps (>2 min between samples) - a GRTC reset can no longer
  corrupt the clock.

**New**

- Timekeeping telemetry in the BLE debug snapshot (bytes [96..127]):
  `k_uptime`, raw GRTC counter, guard trips; `sidclock_ble.py status` and
  `monitor` print it.
- `sidclock_ble.py glitch reset|fwd` injects a fake timebase glitch to
  exercise the clock guard on hardware.

## 1.0.0

First public release.

**Features**

- Landscape touch UI on the 368x448 AMOLED/LCD panel: header (clock, date,
  battery, ambient light), navigation tiles, auto-rotation toggle, sound
  toggle, auto-brightness toggle and a full blank sleep mode.
- SID player with a 6581/8580 cSID-light emulator: tune browser, subtune
  transport, chip-model A/B, song-length-aware END modes (LOOP / NEXT TUNE /
  NEXT SUB), scrolling STIL comment and subsong names.
- Ambient-light profiles (night/indoor/outdoor) with per-profile lux
  thresholds and brightness levels, automatic brightness, burn-in-safe idle
  face with random clock positions.
- Five alarms (OFF / ONCE / REPEAT) with per-day repeat, adjustable length
  and a ringtone captured from a SID.
- Idle face auto-rotation (accelerometer every 15 s), auto-brightness checks
  in idle, configurable idle timeout (15 s .. 5 min) and a dark SLEEP mode
  where SID playback and alarms keep running.
- BLE: Battery Service, Current Time Service, MCUmgr/SMP (OTA +
  filesystem), and a debug/control characteristic. Open connection
  (no pairing) for easy development.
- Over-the-air updates through MCUmgr with MCUboot swap (secondary slot on
  the external 4 MiB SPI flash) and self-confirm.
- LittleFS `/home` partition on the external flash for tunes, sidecars and
  settings.
- Host tools: BLE control CLI, HVSC-fingerprint `sid_add.py` (writes
  `.len`/`.stil` sidecars and uploads), read-only BLE backup tool, bootloader
  and app build scripts with pinned dependencies, prebuilt bootloader.

**Known limitations**

- The bootloader validates images by SHA-256 only (the stock signing keys
  are unavailable) and the SMP service requires no pairing - see
  `docs/security.md`.
- Hardware revision differences (audio amp, panel, ALS) are handled by
  auto-detection/defaults; see `docs/hardware.md`.
