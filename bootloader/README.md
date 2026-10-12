# Bootloader

MCUboot for the Saphe T device (nRF54L15), configured for SidClock's flash
layout: the OTA secondary slot lives on the external MX25R64 SPI flash,
slot 0 in the internal RRAM.

| File | Purpose |
|---|---|
| `fetch-sdk.sh` | downloads the pinned Zephyr/MCUboot sources + toolchain into `$SIDCLOCK_SDK` or `../.sdk` |
| `build.sh` | builds the bootloader (`./build.sh`, or `./build.sh rtt` for the RTT-logging debug build) |
| `flash.sh` | writes the bootloader to 0x0 over SWD (build output or prebuilt) |
| `sidclock-mcuboot.conf` | board-independent config (external NOR, sector budget, no console) |
| `sidclock-rtt.conf` | extra config for the RTT-logging variant |
| `sidclock-mcuboot.overlay` | partitions + SPIM00 wiring |
| `signature_none.conf` | disables signature verification (hash check only) |
| `prebuilt/` | ready-to-flash `sidclock-mcuboot-nrf54l15.hex` / `.bin` |

## Build

```sh
./fetch-sdk.sh        # once; or point SIDCLOCK_SDK at an existing tree
./build.sh            # -> build/zephyr/zephyr.hex
```

## Flash

```sh
./flash.sh            # uses build/zephyr/zephyr.hex if present, else prebuilt/
```

On a locked device, first run `tools/flash/erase.sh` (unlock + mass erase);
see `docs/backup-unlock-flash.md`. The external flash is untouched.

## Why hash-only validation?

The stock bootloader's signing keys are not available, so this build
validates images by SHA-256 only (`signature_none.conf`). See
`docs/security.md` for the implications and the hardening path.

## Layout

```
internal RRAM
  0x000000 - 0x00E000   mcuboot
  0x00E000 - 0x15F000   image-0 (primary, application at 0xE800)
external SPI NOR
  0x000000 - 0x151000   image-1 (secondary / OTA)
  0x151000 - 0x400000   storage (LittleFS /home)
```
