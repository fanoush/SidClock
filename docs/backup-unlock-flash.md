# Backup, unlock and first flash

> **Warning** - unlocking your device erases its internal flash and with it
> the stock bootloader and application. It cannot be undone, and the stock
> firmware is not distributed with this project. Everything below is a
> one-way door.

## What survives the unlock

| Area | Erased by `erase`? | Notes |
|---|---|---|
| Internal RRAM (bootloader + app) | **yes** | replaced by SidClock |
| UICR (model/serial/hardware revision identity) | **yes** | capture the BLE Device Information strings first (see below) |
| External SPI flash: `/home` filesystem | no | tunes, settings and logs survive |
| External SPI flash: OTA slot | no | overwritten on the first update |

## 1. Back up the stock firmware state (optional but recommended)

While the stock application is still running, the read-only BLE backup tool
collects everything reachable without writing: advertising data, the full
GATT tree, MCUmgr image state and the `/home` filesystem over MCUmgr:

```sh
tools/backup_ble.py --name "Saphe T"         # or --addr AA:BB:...
# -> backups/<name>_<address>/{advertising.json,gatt.json,gatt.txt,manifest.json,files/}
```

**Keep the Device Information strings** (Model Number, Serial Number,
firmware/software revision - all stored automatically in `gatt.json` /
`gatt.txt`): they mirror identity values that are programmed into the
chip's one-time (UICR) area, which the unlock erase destroys. If you ever
want to flash the original application back, you will need those values to
restore the device identity (the hardware revision lives in the same area).

The stock device advertises as `Saphe T`; `--name` is a case-insensitive
substring match, so `--name Saphe` works as well (quote the value on the
shell when it contains a space). Nothing is written to the device. Note
that this backup cannot restore the stock firmware itself (its bootloader
signing keys do not exist), only the user data.

## 2. Access the SWD pads and connect

No disassembly is needed. On the back of the device, next to the two
visible charging contacts, the PCB has **four contact pads at the same
pitch: SWDIO, 5V, GND, SWDCLK**. The two charging contacts (5V, GND) are
exposed; the SWDIO/SWDCLK pads are hidden under the black back-cover
sticker/foil, which is glued directly onto the PCB. Scratch the foil away
carefully with a fine tool to reach them.

> **The SWD port is 1.8 V logic.** Use a J-Link/probe with level shifters
> and a VTref (voltage reference) connection to the board's 1.8 V rail;
> driving 3.3 V logic into the port can damage it.

The stock firmware may have APPROTECT enabled. While it is, debug access is
blocked; the J-Link `unlock` command clears it by performing an ERASEALL
(this is the step that wipes the internal flash).

## 3. Unlock + erase

```sh
tools/flash/erase.sh
```

Requires `JLinkExe` on `PATH` (or `JLINK=/path/to/JLinkExe`). It runs the
J-Link `unlock` + `erase` commands against `nRF54L15_M33` over SWD. After
this the internal flash is blank and APPROTECT is off.

## 4. Flash the bootloader

```sh
bootloader/build.sh      # optional: build from source
bootloader/flash.sh      # writes build/zephyr/zephyr.hex or the prebuilt image at 0x0
```

## 5. Flash the application

```sh
app/build.sh
app/flash.sh             # writes the signed image into slot 0 at 0xE000
```

The device resets and boots SidClock; it advertises as `SidClock`. Continue
with [getting-started.md](getting-started.md) (time, tunes, OTA).

## Recovery

- **App does not boot** - reflash slot 0 over SWD (`app/flash.sh`); the
  external flash and settings are untouched.
- **Bootloader does not boot** - reflash the bootloader over SWD
  (`bootloader/flash.sh`). If that fails, repeat the unlock/erase step.
- **Corrupted `/home` filesystem** - the app never auto-formats; use the
  `fsformat` debug command (destructive) to recreate it. It asks for an
  explicit `yes` first (`-y` answers it, and is required when stdin is not
  a terminal; `status`/`ls` say when the filesystem is not mounted):

  ```sh
  tools/sidclock_ble.py fsformat
  ```
