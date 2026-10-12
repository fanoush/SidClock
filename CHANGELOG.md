# Changelog

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
