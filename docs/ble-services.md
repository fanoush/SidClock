# BLE services

The device advertises as **`SidClock`** (no pairing; the connection is open).
All interactions use standard services plus one custom debug service.

| Service | Characteristic | Properties | Notes |
|---|---|---|---|
| SMP `8d53dc1d-1db7-4cd3-868b-8a527460aa84` | `da2e7828-fbce-4e01-ae9e-261174997c48` | write-w/o-rsp, notify | MCUmgr/SMP with **img_mgmt**, **os_mgmt**, **fs_mgmt**. Used for OTA and file transfers. |
| Battery `0x180F` | Battery Level `0x2A19` | read, notify | percent |
| Current Time `0x1805` | Current Time `0x2A2B` | read, write | 10-byte little-endian; there is no RTC, the time is kept from uptime |
| Environmental Sensing `0x181A` | Illuminance `0x2AFB` | read | uint24 little-endian, **0.01 lx** units |
| Debug (custom) `73696463-6c6f-4b01-9c1d-77ce3f41a5c0` | `73696463-6c6f-4b02-9c1d-77ce3f41a5c0` | read, write | 132-byte status snapshot; commands below. Writes are rejected in the R/O and OFF access modes (see below). |
| GATT `0x1801` | Service Changed `0x2A05` | indicate | standard |

The debug characteristic is a **developer interface**: its snapshot layout
and command set are documented here but may change between releases.

## Debug commands

Writes are a single opcode byte, optionally followed by little-endian
arguments:

| Bytes | Effect |
|---|---|
| `01` | play click |
| `02` | play beep |
| `03` | toggle mute (SND) |
| `07` / `08` | step the sample-rate ladder / tone ladder |
| `09` + u32 LE | set sample rate (1000-96000 Hz, silent) |
| `0A` + u32 LE | steady tone for 10 s (100-30000 Hz) |
| `0B` + u32 LE | steady tone until `0C` |
| `0C` | stop steady tone |
| `0D` | **format + remount `/home` (destructive)** - for reviving a corrupted filesystem only |
| `0E` + u8 `idx` | play `/home/<idx>.sid` starting at the default subtune |
| `0F` | stop SID playback |
| `10` + u32 LE | calibration: raw I2S MCKFREQ value |
| `11` + name | play `/home/<name>` (any file name) |
| `12` + u8 `mode` | chip model: 0 = auto (PSID flag), 1 = 6581, 2 = 8580 (reloads the tune) |
| `13` + u16 LE | request a `/home` listing page from that entry index; the next read returns `name\n` rows in bytes [34..94], byte [95] = next index or 0xFF |
| `14` + u8 `mode` | developer test: inject a fake uptime glitch (`0` = counter reset, `1` = forward jump) to verify the clock guard |
| `15` + u8 `mode` | set the BLE access mode (`0` = R/W, `1` = R/O, `2` = OFF); only accepted in R/W |
| `16` + name | delete `/home/<name>` - only `.sid`, `.len` and `.stil` files (config files are protected); rejected in R/O and OFF |
| `17` + u8 engine | global SID engine, dual-engine builds only: `0` = new cRSID, `1` = legacy cSID-light (same as the main-screen button: stops, flips, restarts the current tune) |
| `50` | 1 s test tone |

The read snapshot (132 bytes) mixes audio state (sample rate, DMA buffer
health, enable registers), SID state (playing flag, song count, title,
render timing) and UI diagnostics; bytes [96..127] carry timekeeping
telemetry - `k_uptime_get()` ms, the raw GRTC cycle counter, the clock
guard trip count and the current clock base - so a host can spot a broken
uptime source, and byte [128] reports the BLE access mode. Bytes [129..139]
carry crash telemetry: boot counter, hwinfo reset-cause flags (LE), audio
and main thread heartbeats (u16 LE each, a stalled one names the hung
thread) and the active SID engine (0 = new, 1 = legacy, 0xFF = none).
Every read is passive: it must not disturb the running I2S bit clock.

A 30 s independent watchdog (fed from the main loop) reboots instead of
freezing: any wedged thread stops the loop directly or via a stuck lock.
After an unexpected reboot, `tools/sidclock_ble.py audio` shows the boot
count, the reset cause and which heartbeat stalled.

## BLE access modes

The main screen has a `BLE R/W` / `BLE R/O` / `BLE OFF` button that
cycles a convenience lock for when the clock is left unattended:

| Mode | Time set | Debug writes | SMP (OTA, file upload, os reset) | Advertising |
|---|---|---|---|---|
| **R/W** (default) | yes | yes | registered | on |
| **R/O** | rejected | rejected | unregistered | on |
| **OFF** | - | - | unregistered | stopped + connections dropped |

Reads (battery, time, lux, snapshot) keep working in R/O - note the
developer `ls` command needs a debug write, so it is unavailable there.
The SID player, alarms and the UI are unaffected by all modes. The mode
is **not persisted**: every reboot starts in R/W so OTA and development
always work. Leaving R/O or OFF requires the device screen (or a reset).
`tools/sidclock_ble.py blemode rw|ro|off` switches it remotely while in
R/W, and `status` prints the current mode.

This is not a security boundary (the BLE link is open and images are
SHA-256-checked only) - it prevents accidental or casual changes while
the device is unattended; see [ota.md](ota.md) and [security.md](security.md).

## Removing tunes

`tools/sidclock_ble.py filedelete <name>` deletes `/home/<name>`; for a
`.sid` it also removes the matching `.len` and `.stil` sidecars. Only
those three extensions can be deleted (the config files are protected)
and the command requires R/W mode.

## Host CLI

`tools/sidclock_ble.py` wraps the common operations. It resolves the device
address from `--addr`, `$SIDCLOCK_ADDR`, or a scan for the advertised name:

```sh
tools/sidclock_ble.py status         # battery, device time, lux
tools/sidclock_ble.py set-time       # write the host clock
tools/sidclock_ble.py sidname Last_Ninja_2.sid
tools/sidclock_ble.py sidstop
tools/sidclock_ble.py ls             # list /home (paged listing command)
```

Developer commands (`audio`, `click`, `beep`, `tone`, `mute`, `rate`,
`tonefreq`, `tonestart`, `tonestop`, `chip`, `fsformat`) are documented in
the CLI's `--help`.

## Files and OTA

- Tunes and sidecars live in LittleFS at `/home` and are uploaded with
  MCUmgr `fs_mgmt` (`smpmgr file upload ...`). There is no directory
  listing in `fs_mgmt`; use the `13` command (`tools/sidclock_ble.py ls`)
  or download `/home/dir.txt`.
- Firmware images are uploaded with `smpmgr upgrade` - see [ota.md](ota.md).
