# Architecture

## Overview

SidClock is a single Zephyr application (`app/`) plus an MCUboot bootloader
(`bootloader/`). The application owns everything the user sees and hears:

```
app/src/
  main.c             UI (screens, touch, idle face), alarms, persistence,
                     BLE services, sensors, power logic  (single module, ~4k lines)
  audio.c/.h         I2S output engine (nrfx register level) + SID/tone mixing
  sid_player.cpp/.h  C bridge between the UI/audio and the C++ emulator
  sid/               vendored cSID-light + PSID loader + memory manager
  display_gc9307.c   SPI panel driver (custom framing, power states)
  opt400x.c          OPT3007/OPT4001 ambient light driver
  font1524.h         15x24 bitmap font
app/dts/bindings/    devicetree bindings for the custom drivers
app/app.overlay      pin map, partitions, chosen nodes
```

The bootloader is a stock MCUboot built from pinned sources with a
device-specific overlay (`bootloader/`), configured for the external flash
secondary slot.

## Data flow

```
        touch IRQ ──▶ touch_poll() ──▶ screen handlers ──▶ draw_*()
 littlefs ──▶ sid_player.cpp ──▶ cSID-light render ──┐
                                        audio.c ◀────┘ (512-frame buffers)
  I2S20 ──▶ AW88082 ──▶ speaker
 BLE (SMP/CTS/BAS/Debug) ──▶ main.c services
 MCUboot ◀── slot swap ◀── SMP img_mgmt upload ──▶ external flash slot 1
```

The audio engine is a polled double-buffer feeder (direct nrfx I2S
registers, no interrupts). The main loop runs at ~100 ms cadence plus
event-driven work; rendering the SID happens in the audio path, not in the
UI loop.

## UI

- **Main screen** - header (clock/date, battery, light), four tiles
  (SID player / alarms / sensor / setup), utility buttons (AUTO ROT, sound,
  auto brightness, SLEEP) and volume/brightness sliders.
- **SID player** - tune list with TUNE-/TUNE+, HOME/TUNE/PLAY/SUB transport,
  chip model, end mode, PSID title/author, subsong names and a scrolling
  STIL comment.
- **Alarms** - five slots, mode OFF/ONCE/REPEAT, hour/minute/length sliders
  with -/+ buttons, day checkboxes, ringtone capture from the current tune.
- **Sensor** - live accelerometer readout.
- **Setup** - ambient profiles (night/indoor/outdoor) with per-profile lux
  threshold and brightness levels, idle timeout, SAVE STATE (writes the
  directory index and all settings).
- **Idle face** - single screen clock/date (night profile full-screen),
  re-orients every 15 s and re-checks ambient light; touching returns to
  the UI.
- **Sleep (dark idle)** - panel fully off, no clock or sensor checks, but
  SID playback, SID auto-advance and alarms keep running. An alarm turns
  the panel back on showing the idle clock; a touch wakes the UI.

Software rotation: the panel stays in its native portrait address space;
every window is transposed in the driver so the UI lives in a 448x368
logical landscape frame. The idle face can use portrait rotations.

## Persistence (`/home` on the external flash)

| File | Format | Contents |
|---|---|---|
| `bright.cfg` | 8 numbers | 3 lux thresholds, 3 brightness levels, manual brightness, idle timeout seconds |
| `alarms.cfg` | one line per alarm | `mode hour min len_sec days sub name title` |
| `time.cfg` | 3 numbers | wall clock epoch + GRTC counter + k_uptime at save (no RTC on the board) |
| `sid.cfg` | text | last loaded tune name (restored on boot, no auto-play) |
| `dir.txt` | `name size` lines | directory index for hosts that only have smpmgr |

LittleFS is mounted **without auto-format**: a corrupted or foreign
filesystem is never wiped; the `fsformat` debug command formats explicitly.

## BLE

Standard services (Battery, Current Time, Environmental Sensing) plus
MCUmgr/SMP (image + OS + filesystem groups) and a custom debug
characteristic. See [ble-services.md](ble-services.md).

## Design decisions

- **No dynamic allocation** in hot paths; fixed buffers sized for the
  display band (448x16x2 bytes) and the audio double buffer.
- **Software rotation** instead of panel MADCTL (the panel's MADCTL
  produced mirrored/transposed output on this unit).
- **Visible-time marquee**: the SID comment scrolls only while the SID
  screen is actually visible.
- **Alarms never interrupt actively playing music**; they trigger in idle
  (and in dark sleep) only when nothing is playing or playback is paused.
- **Auto-rotation is opt-in through the AUTO ROT button**; when off, the
  orientation stays put everywhere.
- **Bootloader without signature verification** - hash check only, because
  the stock signing keys do not exist. See [security.md](security.md).
