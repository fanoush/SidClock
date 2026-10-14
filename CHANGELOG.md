# Changelog

## Unreleased

- cRSID micro-optimizations for the M33 (targeted at heavy tunes like
  Arkanoid that overrun the render budget): ADSR stepping skips voices
  proven steady (woken by SID-register writes), the instruction loop
  skips the ADSR step entirely while all voices are steady, and the
  memory read/write fast paths bypass the bank-pointer logic for
  non-IO pages. Crash-safety loop bounds were relocated/removed where
  measurement showed they never fired.
- SID engine swap (not yet validated on hardware): the default build now
  plays through cRSID-1.58 in Light profile (integer-only, more accurate:
  cycle-exact CPU/ADSR, fixed 6581 filter bottom, RTI at $DC0C, more digis
  and real RSID support), slimmed for RAM (4 KB IO banks, no ROM banks,
  computed banking) behind the unchanged `libcsid_*` API. The original
  cSID-light core stays available with `SIDCLOCK_SID_ENGINE=csid` for A/B
  comparison; the on-display version grows a `-crsid`/`-csid` suffix while
  the signed image version is identical for both. Audio buffers shrank
  512 to 384 frames to fit the bigger engine state (RAM at 99.6%).
- Optional dual-engine build (`SIDCLOCK_SID_ENGINE=dual`, display
  suffix `-dual`): legacy cSID-light linked alongside cRSID, sharing
  one 64 KB C64 RAM with a main-screen toggle button (second row middle,
  dual builds only) that stops playback, flips the core and restarts the
  tune. For heavy tunes (e.g. Arkanoid) that overrun the render budget;
  defaults to the new core.

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
