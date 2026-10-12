# Third-party notices

SidClock itself is MIT-licensed (see `LICENSE`). It uses the following
third-party components:

## Build dependencies (fetched by `bootloader/fetch-sdk.sh`, not vendored)

| Component | License | Notes |
|---|---|---|
| [Zephyr RTOS](https://github.com/zephyrproject-rtos/zephyr) (NCS tree) | Apache-2.0 | RTOS, drivers, Bluetooth host/controller, MCUmgr |
| [MCUboot](https://github.com/mcu-boot/mcuboot) | Apache-2.0 | bootloader (`bootloader/`) |
| [hal_nordic](https://github.com/zephyrproject-rtos/hal_nordic), [cmsis](https://github.com/zephyrproject-rtos/cmsis), [tinycrypt](https://github.com/zephyrproject-rtos/tinycrypt), [littlefs](https://github.com/zephyrproject-rtos/littlefs), [zcbor](https://github.com/zephyrproject-rtos/zcbor), [segger](https://github.com/zephyrproject-rtos/segger) | Apache-2.0 / BSD-style (per component) | Zephyr modules |
| [Zephyr SDK](https://github.com/zephyrproject-rtos/sdk-ng) | Apache-2.0 | toolchain |

## Source components

| Component | License | Notes |
|---|---|---|
| [cSID-light](http://hermit.sidrip.com/) by Mihaly Horvath (Hermit) | "WTFPL" style: *"Do what the fuck you want with this code, but please mention me as its original author."* | `app/src/sid/libcsidlight.cpp`, `libcsid.h`, `precalc.h`; the SID emulator core. Adapted for this application. |
| SIDPlayer wrapper pieces by Phil Schatzmann | MIT | `app/src/sid/SIDConfig.h`, `sidmemory.h` (memory manager design) from [SIDPlayer](https://github.com/pschatzmann/SIDPlayer). |
| DroidSansMono bitmap glyphs | Apache-2.0 | `app/src/font1524.h`, extracted from Zephyr's `subsys/fb/cfb_fonts.c` (`cfb_font_1524`); font © The Android Open Source Project. |

## Host tools (installed separately)

| Component | License |
|---|---|
| [smpmgr](https://github.com/intercreate/smpmgr-tool), [smpclient](https://github.com/intercreate/smpclient), [bleak](https://github.com/hbldh/bleak) | MIT / Apache-2.0 (see their packages) |

## SID music

No SID files are distributed with this repository. `sids/fetch-samples.sh`
downloads tunes from the official HVSC server. Every SID file is
copyrighted by its composer and/or rights holder; the
[High Voltage SID Collection](https://hvsc.c64.org/) distributes the
collection with their permission. Credit for the sample tunes belongs to
their composers - see `sids/README.md`.
