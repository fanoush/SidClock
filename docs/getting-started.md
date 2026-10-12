# Getting started

This walks through building SidClock from a clean checkout and getting it
onto a device.

## 0. Prerequisites

- Linux host (x86_64), ~3 GB disk for the pinned SDK.
- `python3`, `pip`, `curl`, `tar`, `git`, `cmake` (>= 3.20) and a C++ host
  toolchain for the SDK helper scripts.
- [SEGGER J-Link](https://www.segger.com/downloads/jlink/) software if you
  will flash over SWD (`JLinkExe` on `PATH`, or set `JLINK=/path/to/JLinkExe`).
  The SWD port is **1.8 V logic** - use a probe with level shifters and a
  VTref connection; 3.3 V logic can damage it.
- A Bluetooth LE adapter with BlueZ for the host tools.

## 1. Fetch the pinned SDK

The bootloader and the application share one SDK tree (Zephyr at the exact
revision the hardware was brought up with, MCUboot, the required Zephyr
modules, and Zephyr SDK 0.17.0 with the ARM toolchain):

```sh
bootloader/fetch-sdk.sh          # -> ./.sdk (gitignored)
```

To keep the SDK elsewhere, run with a target directory
(`bootloader/fetch-sdk.sh ~/sidclock-sdk`) and put the path in the
repo-root `local.conf`:

```sh
SIDCLOCK_SDK=/home/me/sidclock-sdk
```

Then install the Python build requirements once:

```sh
pip3 install --user -r tools/requirements-build.txt
```

## 2. Build

```sh
bootloader/build.sh              # release bootloader -> bootloader/build/zephyr/zephyr.hex
app/build.sh                     # application + MCUboot signature -> app/build/zephyr/zephyr.signed.bin
```

Both scripts are idempotent; rerun after changes. `bootloader/build.sh rtt`
builds a debug bootloader with SEGGER RTT logging instead.

## 3. First flash (SWD)

A locked device must be unlocked first - this **erases the internal flash**
(stock bootloader + application) and cannot be undone. Back up anything
precious over BLE first; in particular the Device Information strings
(model/serial) mirror identity values in the chip's one-time area that the
unlock destroys. Details and warnings:
[backup-unlock-flash.md](backup-unlock-flash.md).

The SWD port runs at **1.8 V logic** - use a level-shifting probe; 3.3 V
logic can damage it. The pads hide under the back-cover foil next to the
charging contacts (see [hardware.md](hardware.md)).

```sh
tools/flash/erase.sh             # unlock + mass erase (RRAM only)
bootloader/flash.sh              # bootloader at 0x0 (prebuilt used unless built)
app/flash.sh                     # signed app into slot 0 (0xE000)
```

After the reset the device boots SidClock and advertises as `SidClock`.

## 4. Talk to the device

The host CLI finds the device by its advertised name (or takes `--addr` /
`$SIDCLOCK_ADDR`):

```sh
tools/sidclock_ble.py status     # battery, device time, ambient light
tools/sidclock_ble.py set-time   # write the host clock (no RTC on the board)
```

If BLE tooling is missing, install it once:

```sh
tools/smpmgr/install.sh          # smpmgr + smpclient + bleak
```

## 5. Put music on it

Fetch a few sample tunes plus the HVSC song-length/STIL databases, then
import them (generates `.len`/`.stil` sidecars and uploads everything):

```sh
sids/fetch-samples.sh
tools/sid_add.py sids/Commando.sid
```

No tunes are committed to the repository; see
[sid-library.md](sid-library.md) and `sids/README.md` for the pipeline and
licensing notes.

## 6. Updates over the air

```sh
app/build.sh
smpmgr --ble <addr> upgrade app/build/zephyr/zephyr.signed.bin
```

The device downloads into the secondary slot on the external flash and
MCUboot swaps it on the next reset. More details: [ota.md](ota.md).

## Troubleshooting

- **No `SidClock` in a BLE scan** - make sure the app is running (not the
  blank sleep mode) and no other central is connected.
- **Flash verify errors with J-Link** - check the SWD wiring and that the
  J-Link is not powering the board down; `JLinkExe -device nRF54L15_M33`.
- **Audio silent** - the amplifier is enabled only while sound plays; if
  needed, trigger a test tone: `tools/sidclock_ble.py beep`.
- **`/home` looks empty after flashing** - the external flash is untouched
  by SWD; if it was never populated, use `sids/fetch-samples.sh` +
  `tools/sid_add.py`, or the `fsformat` debug command to recreate a fresh
  filesystem (destructive).
