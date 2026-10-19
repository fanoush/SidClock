# SidClock

SID music player firmware for the **Saphe T** device (Nordic nRF54L15):
a low-power hobby firmware with a touch UI, Bluetooth LE over-the-air
updates and a full **6581/8580 SID emulator** that plays PSID/RSID tunes
from the device's external flash.

*This is an independent project - not affiliated with or endorsed by Saphe.
"Saphe T" is referenced only to describe the hardware it runs on.*

## Features

- **SID player** - cSID-light emulator with A/B chip models (6581/8580),
  tune browser, subtune transport, PSID metadata, scrolling STIL comment
  and song-length-aware end modes (LOOP / NEXT TUNE / NEXT SUB).
- **Device UX** - big burn-in-safe idle clock (with accelerometer-based
  orientation and automatic brightness), configurable idle timeout
  (15 s .. 5 min), full blank sleep that keeps music and alarms alive.
- **Alarms** - five OFF/ONCE/REPEAT alarms, per-day repeat, adjustable
  ring length, ringtone captured from a SID.
- **Adjustable everywhere** - volume/brightness sliders, three ambient
  light profiles (night/indoor/outdoor) with per-profile lux thresholds and
  brightness levels.
- **BLE** - Battery Service, Current Time Service, MCUmgr/SMP for
  **over-the-air updates** and filesystem transfers (upload tunes without
  unplugging anything), plus a debug/control characteristic.
- **Web remote** - a [phone-friendly page](https://fanoush.github.io/SidClock/)
  over Web Bluetooth (Chrome/Edge on a computer or Android): battery,
  device clock, current tune/subtune with progress, transport controls and
  one-press clock sync. Static files in `web/`, deployed by the `pages`
  workflow - nothing to install.
- **Low power** - tickless kernel, duty-cycled sensors, stream suspend,
  dark sleep mode; the design keeps the SID emulator and alarm service
  running while the panel is off.
- **Tooling** - BLE control CLI, HVSC-fingerprint tune importer, read-only
  BLE backup tool, reproducible pinned-SDK builds, prebuilt bootloader.

## Hardware

Saphe T device: nRF54L15 (Cortex-M33), 368x448 AMOLED/LCD, FT3168 touch,
LIS2DH accelerometer, OPT3007/OPT4001 ambient light sensor, AW88082 class-D
amplifier (I2S), 4 MiB MX25R64 external SPI flash (LittleFS + OTA slot).
See [docs/hardware.md](docs/hardware.md).

## Repository layout

```
app/          Zephyr application (UI, SID player, audio, drivers)
bootloader/   MCUboot config + build scripts + prebuilt bootloader
tools/        host tools: BLE CLI, tune importer, backup, flashing, smpmgr
              (tools/web-tests/ holds the browser test page for web/)
sids/         tune staging area (downloaded locally, never committed)
docs/         hardware, architecture, low power, BLE, OTA, development
web/          web remote (Web Bluetooth), served by GitHub Pages
```

## Quick start

```sh
# 1. Fetch the pinned Zephyr/MCUboot sources + toolchain (~600 MB download):
bootloader/fetch-sdk.sh
pip3 install --user -r tools/requirements-build.txt

# 2. Build:
bootloader/build.sh          # -> bootloader/build/zephyr/zephyr.hex
app/build.sh                 # -> app/build/zephyr/zephyr.signed.bin

# 3. First flash on a device (destroys the stock firmware - read the docs):
tools/flash/erase.sh         # unlock + erase internal flash
bootloader/flash.sh          # write bootloader
app/flash.sh                 # write application

# 4. Talk to the device (scans for the "SidClock" BLE name):
tools/sidclock_ble.py status
tools/sidclock_ble.py set-time

# 5. Get some music on it:
sids/fetch-samples.sh                       # tunes + HVSC databases
tools/sid_add.py sids/Commando.sid          # sidecars + upload

# 6. Updates over the air:
tools/flash_ota.py --now                    # upload + arm + reboot (one boot)
```

Detailed steps: [docs/getting-started.md](docs/getting-started.md),
unlocking and backups: [docs/backup-unlock-flash.md](docs/backup-unlock-flash.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | toolchain, build, flash, first run |
| [docs/hardware.md](docs/hardware.md) | parts, revisions, pinout, flash layout |
| [docs/architecture.md](docs/architecture.md) | firmware structure, modules, design decisions |
| [docs/low-power.md](docs/low-power.md) | power states and what runs in each |
| [docs/ble-services.md](docs/ble-services.md) | GATT services + debug commands |
| [docs/ota.md](docs/ota.md) | over-the-air update procedure |
| [docs/backup-unlock-flash.md](docs/backup-unlock-flash.md) | backup, SWD unlock, first flash |
| [docs/sid-library.md](docs/sid-library.md) | tune player behavior, sidecars, HVSC pipeline |
| [docs/development.md](docs/development.md) | conventions, debugging, release process |
| [docs/security.md](docs/security.md) | update authentication model and hardening |
| [AGENTS.md](AGENTS.md) | orientation for AI coding agents |

## Web remote

[**fanoush.github.io/SidClock**](https://fanoush.github.io/SidClock/) is a
single static page that talks to the device over Web Bluetooth: battery,
the device and browser clocks side by side (the device one turns amber
while they disagree - it has no RTC and forgets the time on every reset),
the current tune and subtune with a progress bar, play/pause/stop, tune
and subtune transport, one-press clock sync and a light/dark switch.
It runs in Chrome or Edge (desktop) and Chrome on Android; the device
accepts one host at a time and only accepts commands in R/W mode, and it
pushes every status value (no polling). The page source is `web/`,
deployed by the `pages` workflow (`web/` holds only the site); the
protocol behind it is in [docs/ble-services.md](docs/ble-services.md).

The page also does what `tools/sid_add.py` does on a PC, without
installing anything:

- **Search and upload**: search hvsc.c64.org and write a tune straight to
  the device's `/home` over mcumgr SMP - that needs R/W mode (the device
  unregisters the SMP service otherwise) and the browser's Web Bluetooth
  SMP characteristic. The boxes beside the search box pick which fields
  count (name, author, released - the API searches all three, series
  names included) and long result lists page in behind a *show more*
  button.
- **Sidecars**: the first upload (or the *load databases* button) caches
  HVSC's `Songlengths.md5` and `STIL.txt` in IndexedDB - about 9 MB
  together, they only change with HVSC releases - and the page builds the
  device's `.len` and `.stil` files with the same rules, caps and
  truncation as `tools/sid_add.py`.
- **Device library**: list `/home`, mark tunes that have sidecars, play or
  delete them (a `.sid` drops its `.len`/`.stil` too). The card sits above
  the search and starts collapsed - tap its header to open it - so a long
  result list cannot bury it.
- **Tune info**: while a tune plays, the page shows its HVSC song lengths,
  the subtune names (tap one to jump to that subtune), the STIL note for
  the current subtune and the tune comment. Tunes uploaded from the page
  are matched by their remembered HVSC path, others by file name (several
  HVSC files can share a name, so the upload path wins).

For local testing on a phone, Web Bluetooth needs `https` - plain http
counts as a secure context only on `localhost` itself:

```sh
# a quick tunnel gives a real certificate (no browser warning):
python3 -m http.server 8000                     # from the repo root
cloudflared tunnel --url http://localhost:8000  # open <url>/web/ on the phone

# or self-signed TLS, no third party involved:
python3 tools/serve_web.py                      # open https://<this-computer>:8443/
python3 tools/serve_web.py -v                   # log requests with their User-Agent
```

## Status and limitations

- The bootloader validates images by **SHA-256 only** (the stock signing
  keys are unavailable) and the BLE service requires **no pairing** - this
  is a development-friendly trade-off, see [docs/security.md](docs/security.md).
- Unlocking a device erases its internal flash. The stock firmware cannot be
  restored afterwards; the external flash (`/home` data) survives.
- Hardware revisions differ (amplifier, panel, light sensor); defaults and
  auto-detection cover the common revision, see [docs/hardware.md](docs/hardware.md).

## License

MIT - see [LICENSE](LICENSE). Third-party components and their licenses are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). SID tunes are
copyrighted by their composers and are **not** part of this repository.
