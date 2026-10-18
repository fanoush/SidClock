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
arguments. Opcodes `01`, `02`, `07`-`0C`, `10` and `50` are bring-up test
signals: they are only compiled into **debug builds**
(`SIDCLOCK_DEBUG=1 ./build.sh`), and a release build answers them with
`VALUE_NOT_ALLOWED`.

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
| `1D` [+ u8 `page`] | stack telemetry for the overflow hunt, 4 rows per page: the **interrupt stack** first, then the threads in creation order. `(size, free)` u16 pairs at `[36..51]`, the matching 11-byte names at `[52..95]`; `[34]` marker, `[35]` page with bit 7 set to say the names follow and bit 6 set on the last page (bit 7 clear = the older 5-per-page layout without names; bit 6 clear everywhere = firmware from before the interrupt row). Only the requested page is latched, so one page costs 4 stack scans. Under 256 B free anywhere is the smoking gun. |
| `1E` [+ u8 `mode`] | drain the SEGGER RTT log buffer - the `LOG_*` lines a debug probe would show; the next read returns up to 60 bytes of text at `[36..95]`, the byte count in `[35]`, `[34]` = marker. The bare opcode (or `mode` 0) **consumes** the chunk, so the device forgets it and a second call only shows newer lines. `mode` 1 restarts a *peek* at the oldest unread byte and 2 continues it; a peek never moves the read pointer, so it is repeatable and a later consume still sees the window. |
| `1F` [+ u8 `mode`] | accelerometer diagnosis into the log (**read-only** in a release image): I2C scan 0x08-0x77, `WHO_AM_I` at both possible addresses (0x19/0x18), what the Zephyr driver and the built-in poller each return, registers 0x00-0x5F as eight-byte rows, single-register reads of the control block and of the six output bytes, and a `CTRL_REG1`/`CTRL_REG4` write/read-back. This is what identifies a chip that answers on I2C but never converts. `SIDCLOCK_DEBUG` builds also take `mode` 1 (reboot the register file from OTP via the `CTRL_REG5` BOOT bit, then walk the ODR settings logging the output registers after each) and `mode` 2 (drop the sensor rail P1.11 for 150 ms, then bring touch, ambient light and the accelerometer back up and watch the data registers). |
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

The stack telemetry (`1D`) reports **peaks, not current depth**: stacks are
filled with 0xAA when a thread starts (`CONFIG_INIT_STACKS`), and the
listing counts the bytes that are still untouched, so `used` is the deepest
the stack has been since boot and never decreases. The first row is the
interrupt stack (`ISR0`), which is where BLE controller and I2S service
routines live; the rest are threads, named from the kernel's own copy
(`CONFIG_THREAD_NAME`) when the snapshot is built. A real overflow trips
the hardware stack guard (a reset, recorded in the crash telemetry) before
it could show up here as 0 free.
Every read is passive: it must not disturb the running I2S bit clock.

`tools/sidclock_ble.py log` drains the RTT buffer over BLE: the same
`LOG_*` lines a debug probe would show, without needing SWD access (the
pads are under the back cover). `--peek` prints the window without
consuming it and `-f` follows; both together watch new lines while leaving
the buffer intact for a later plain `log`. The buffer runs in **overwrite**
mode (`CONFIG_LOG_BACKEND_RTT_MODE_OVERWRITE`): nothing on the device reads
it back, so a full buffer discards its oldest unread bytes instead of every
new line, and it always holds the newest window - its first line can be the
tail of a line whose start is gone, and that partial line is printed as it
is. The log core's small ring does the same one stage earlier.

A 30 s independent watchdog (fed from the main loop) reboots instead of
freezing: any wedged thread stops the loop directly or via a stuck lock.
After an unexpected reboot, `tools/sidclock_ble.py audio` shows the boot
count, the reset cause and which heartbeat stalled.

The accelerometer is read through the Zephyr LIS2DH driver, with a small
built-in I2C poller as a fallback: when the driver returns a sample with no
gravity (|x|+|y|+|z| < 500 mg - what a chip that acknowledges on I2C but
never actually converts looks like) the app latches onto the poller, logs
the raw bytes once and the sensor screen prints `ACCEL: no sample` instead
of a plausible-looking `0.000`. Both paths report `g` with three decimals,
so the tilt bars and the rotation thresholds see the same units. The
register dump above is the field test for such a unit: `tools/sidclock_ble.py
accel` shows the frozen output bytes and the chip's `WHO_AM_I` without
needing a probe. A healthy unit shows a live sample there
(`Z = +/-9.8 m/s2`).

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
the CLI's `--help`. The test-signal ones need a debug build
(`SIDCLOCK_DEBUG=1 ./build.sh`); against a release device the CLI reports
the rejection in one line instead of a traceback.

## Files and OTA

- Tunes and sidecars live in LittleFS at `/home` and are uploaded with
  MCUmgr `fs_mgmt` (`smpmgr file upload ...`). There is no directory
  listing in `fs_mgmt`; use the `13` command (`tools/sidclock_ble.py ls`)
  or download `/home/dir.txt`.
- Firmware images are uploaded with `smpmgr upgrade` - see [ota.md](ota.md).
