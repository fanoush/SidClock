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
sids/         tune staging area (downloaded locally, never committed)
docs/         hardware, architecture, low power, BLE, OTA, development
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
smpmgr --ble <addr> upgrade app/build/zephyr/zephyr.signed.bin
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
