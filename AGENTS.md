# AGENTS.md - guide for AI coding agents

Orientation for a new agent session working on this repository. Read this
first, then the linked document for the area you are touching.

## Objective

SidClock is a SID music player firmware for the Saphe T device (Nordic
nRF54L15). Goals, in order:

1. **Low power** - the device should run as long as possible on battery.
   Every feature must justify its idle cost; see `docs/low-power.md` for
   the state table that changes must respect.
2. **Good UX** - readable idle clock, responsive touch UI, alarms
   that work reliably, no stuck/blank states.
3. **Accurate music** - the cSID-light emulation at the correct pitch and
   rate, with tune metadata and end modes.
4. **Maintainable** - simple static design, no dynamic allocation, clear
   modules, reproducible pinned builds.

## Read these first

| Area | Document |
|---|---|
| Hardware, pins, variants | `docs/hardware.md` |
| Firmware structure, persistence formats | `docs/architecture.md` |
| Power states (what may run when) | `docs/low-power.md` |
| BLE services + debug commands | `docs/ble-services.md` |
| Build/flash/OTA commands | `docs/getting-started.md`, `docs/ota.md` |
| Coding conventions, release process | `docs/development.md` |
| Security model | `docs/security.md` |

## Hardware in one paragraph

nRF54L15 (Cortex-M33, 1.5 MB RRAM, 256 KB RAM). 368x448 AMOLED/LCD over
SPIM00 (CS1) with a custom QSPI-style framing; FT3168 touch and LIS2DH
accelerometer and OPT3007/OPT4001 ambient light on TWIM30; AW88082 I2S
class-D amplifier (early boards: MAX98357A); MX25R64 4 MiB SPI flash (CS0)
holding the OTA secondary slot and the LittleFS `/home`. Sensor rail enable
P1.11 must be high. The DK console UART shares pins with the I2S amplifier
and must stay disabled or the amp is silent. One side button (flush with
the case) drives the reset pin - reboot only, not a software input. SWD
pads are **1.8 V logic**, hidden under the back-cover foil next to the
charging contacts (probe with level shifters/VTref).

## Repository layout

```
app/         Zephyr application (the main body of work)
bootloader/  MCUboot config + scripts + prebuilt image
tools/       host-side Python tools (BLE CLI, HVSC importer, backup, web server,
             plus tools/web-tests/ - browser tests for web/)
sids/        local tune staging (gitignored contents)
docs/        the documents above
web/         web remote (Web Bluetooth status/control + HVSC search/upload)
```

## Build / flash / test

```sh
bootloader/fetch-sdk.sh                 # one-time pinned dependency fetch
app/build.sh                            # -> app/build/zephyr/zephyr.signed.bin
SIDCLOCK_DEBUG=1 app/build.sh           # bench build: bring-up test commands
tools/flash_ota.py                      # arm the OTA image (next reset applies it)
tools/flash_ota.py --now                # arm + reset + verify (one boot)
tools/sidclock_ble.py set-time          # after every reset (no RTC)
tools/sidclock_ble.py status            # quick health check
```

The device resolves by advertised name `SidClock` (or `--addr`/`$SIDCLOCK_ADDR`).
If `smpmgr` is missing: `tools/smpmgr/install.sh`.

## Libraries

- **Zephyr** (pinned revision in `bootloader/fetch-sdk.sh`): kernel,
  Bluetooth host + split controller, MCUmgr, LittleFS, drivers.
- **MCUboot**: bootloader; hash-only image validation.
- **cSID-light** (vendored in `app/src/sid/`): SID emulator core (WTFPL
  attribution in the file header).
- **Zephyr SDK 0.17.0** toolchain.
- Host tools: `smpmgr`/`smpclient`/`bleak` (see `tools/smpmgr/`).

## Design decisions and invariants

Do not break these without discussing it in the PR/commit:

- **No dynamic allocation** in app paths; static buffers only. The system
  heap is off (`CONFIG_HEAP_MEM_POOL_SIZE=0`) because nothing in the linked
  image calls `malloc`/`k_malloc`; RAM sits at ~95 % with ~9 KB free. Per
  block breakdown: `docs/architecture.md` ("RAM budget").
- **Software rotation**: the panel stays in native portrait; windows are
  transposed in the display driver. The logical UI is 448x368 landscape;
  the idle face can be portrait.
- **Marquee** advances only while the SID screen is visible (visible-time
  accounting).
- **Alarms** trigger only in idle/sleep and never interrupt actively
  playing music; ringtone length from `len_sec`; touch stops them.
- **SLEEP** is "dark idle": no drawing, no lux/rotation checks, but SID
  playback + auto-advance and alarms keep running.
- **BLE access modes** (R/W / R/O / OFF) cycled by the main-screen button:
  R/O rejects CTS + debug writes and unregisters the mcumgr SMP service
  (OTA/fs/os), OFF also stops advertising and drops connections. Not
  persisted - every boot is R/W. Remote switching is the DEV-only debug
  command `0x15`/`blemode`; SMP (un)registration rides on
  `CONFIG_BT_GATT_DYNAMIC_DB`.
- **SND OFF** pauses an actively playing tune and SND ON resumes it (only
  when the mute is what paused it).
- **AUTO ROT** toggle controls all automatic orientation changes.
- **Persistence** formats are documented in `docs/architecture.md`; keep
  them backwards compatible (they live in LittleFS across updates).
- **Uptime deltas** must be unsigned modular (`k_uptime_get_32() - t0`) -
  the base is large and persists across warm resets. The wall clock does
  **not** use `k_uptime` at all: `epoch_now()` runs on the raw GRTC counter
  (`k_cycle_get_64()`, see `grtc_ms()`) with a guard that re-anchors on a
  timebase reset/jump (`time_glitches`).
- **LittleFS never auto-formats**; `fsformat` is the explicit destructive
  path.

## Known pitfalls

- The uptime base is ~4e9 ms on current units; signed 32-bit comparisons
  against zero-initialized timestamps are wrong.
- On this port `k_uptime_get()` is seeded through a 32-bit tick count, so
  it steps by a whole 2^32-tick wrap (137,439 s) when the GRTC's absolute
  tick count crosses a boundary - that threw the wall clock +2.3 days
  overnight on 2026-10-13 and ate an alarm. The wall clock therefore uses
  the raw GRTC counter (`grtc_ms()`), and `epoch_now()` keeps the last
  trusted value when the counter moves backwards or jumps >2 min. Never
  put `k_uptime_get()` back into wall-clock math.
- Debug snapshot bytes [96..127] carry timekeeping telemetry (k_uptime,
  raw GRTC counter, guard trips); byte [128] is the BLE access mode.
  `sidclock_ble.py status/monitor` print it, `glitch reset|fwd` injects a
  fake glitch, `blemode rw|ro|off` switches the BLE mode (R/W only) and
  `filedelete <name>` removes tunes (`.sid`/`.len`/`.stil` only).
  `log [--peek] [-f]` drains the RTT log buffer over BLE (debug command
  `0x1E`, 60 bytes per snapshot read); the buffer is in overwrite mode so
  it always holds the newest lines.
- The bring-up test commands (`click`, `beep`, `tone`, `rate`, `tonefreq`,
  `tonestart`, `tonestop`) exist only in `SIDCLOCK_DEBUG=1` builds; release
  images reject the opcodes and the BLE tool reports that in one line.
- Every BLE write handler must check `ble_mode == BLE_MODE_RW` - the CTS
  and debug handlers gate at the top; new write paths that forget it
  silently bypass R/O.
- The console UART shares the amplifier pins: keep `CONFIG_SERIAL=n` and
  `&uart20 { status = "disabled"; }`.
- The panel needs a full re-init (`gc9307_panel_state(dev, 1)`) after
  sleep-in, including re-applying brightness.
- `image state-read` version only changes when `VERSION` in `app/build.sh`
  is bumped.
- OTA uploads never arm anything: Zephyr's `image upload` writes slot 1
  and stops, and only `image state-write` (a *client* request) makes
  MCUboot boot it. Plain `smpmgr upgrade` resets without that request, so
  the device comes back on the old image looking like a failed update; use
  `tools/flash_ota.py` (arm-only, or `--now`) or `smpmgr upgrade --slot 1`.
  A staged image is persistent and drops with `smpmgr image erase 1`.
- BLE tooling can be flaky right after a reset; retry once.
- The web remote's `web/hvsc.js` is the browser twin of `tools/sid_add.py`:
  same `.len`/`.stil` rules (name/tune/note caps 24/200/160 chars, 3000
  bytes), same truncation, keyed the same way. HVSC's `Songlengths.md5`
  is keyed on the **whole-file** MD5 - the HVSC API's `md5` field is the
  libsidplayfp PSID fingerprint and does *not* match it (that one is only
  for the legacy `Songlengths.txt`). Change both implementations together.
- The page shortens uploaded names to 20 characters (`sid_find_next` skips
  names over 23, but play-by-name `0x20` and `filedelete` `0x16` take at
  most 20) and remembers the original HVSC path per device name, because
  several HVSC files can share one file name.
- Tune identity is exact now: the info characteristic is 96 bytes and its
  last 8 are the loaded file's whole-file MD5 prefix (`sid_player_md5_prefix`,
  `app/src/md5.c`; `00000000` = unknown - no HVSC file has that prefix).
  The page keys `Songlengths.md5` on it (`byPrefix`), so rename/case/dupe
  games cannot confuse the metadata; the upload record and then the file
  name are only fallbacks, and `tuneLookup()` is the place to change that
  order. Anything that grows `player_info` again must stay inside the
  `sizeof` comparisons in `player_info_check` (it bumps the generation
  byte) and needs no GATT table change.
- Web remote tests: `python3 tools/web-tests/record.py --out /tmp/wt.txt &`
  then a headless Chrome on
  `http://127.0.0.1:8901/tools/web-tests/index.html?record&live` - the
  `?live` half needs the network and downloads the HVSC databases.
  `tools/web-tests/page.html?record` drives the real page (search boxes,
  paging, status line) in an iframe against the live API; wrap the headless
  Chrome in `timeout` - the report arrives before Chrome exits.
  `tools/web-tests/connect.html?record` drives the real page against a
  fake Web Bluetooth device (offline, no hardware): it fails the CCC write
  and info read the way a fresh Chrome/Android link does, checks that a
  rejected CCC write heals with one silent reconnect, and that the page
  stays connected and usable throughout.

## Testing checklist (run on hardware)

`docs/development.md` has the full checklist: UI screens, SID playback and
end modes, alarm ring/wake, idle checks, sleep behaviour, BLE status/time/
OTA, persistence across reset.

## Roadmap / known improvement areas

- Split `main.c` into modules (ui, alarms, persistence, ble, sensors).
- Power measurements per state (fill in `docs/low-power.md`).
- Optional hardening build: MCUboot with own signing key + SMP pairing.
- UI polish: animations, more idle-face clock styles, screenshots.
- Web-serial/Web-BLE flasher for easier installation.

## Session workflow

1. Read this file + the doc for your area.
2. Build (`app/build.sh`), flash over OTA, `set-time`, run the relevant
   part of the test checklist.
3. Keep commits small and explain hardware-side verification in the
   message.
4. Before publishing: update `CHANGELOG.md` and bump `VERSION` for
   releases.
