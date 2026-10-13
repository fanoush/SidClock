# Changelog

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
