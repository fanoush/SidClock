# BLE services

The device advertises as **`SidClock`** (no pairing; the connection is open).
All interactions use standard services plus one custom debug service.

| Service | Characteristic | Properties | Notes |
|---|---|---|---|
| SMP `8d53dc1d-1db7-4cd3-868b-8a527460aa84` | `da2e7828-fbce-4e01-ae9e-261174997c48` | write-w/o-rsp, notify | MCUmgr/SMP with **img_mgmt**, **os_mgmt**, **fs_mgmt**. Used for OTA and file transfers. |
| Battery `0x180F` | Battery Level `0x2A19` | read, notify | percent |
| Current Time `0x1805` | Current Time `0x2A2B` | read, write | 10-byte little-endian; there is no RTC, the time is kept from uptime |
| Environmental Sensing `0x181A` | Illuminance `0x2AFB` | read | uint24 little-endian, **0.01 lx** units |
| SidClock (custom) `73696463-6c6f-4b01-9c1d-77ce3f41a5c0` | `73696463-6c6f-4b02-9c1d-77ce3f41a5c0` | read, write | 132-byte debug snapshot; commands below. Writes are rejected in the R/O and OFF access modes (see below). |
| " | `73696463-6c6f-4b03-9c1d-77ce3f41a5c0` | read, notify | **player state**, 16 bytes - notifies on change and 1 Hz while playing |
| " | `73696463-6c6f-4b04-9c1d-77ce3f41a5c0` | read | **player strings**, 96 bytes (title/name/author/`id`) |
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
| `18` | toggle play/pause - the SID screen's transport button (a paused tune resumes where it stopped; with nothing loaded it starts the first tune) |
| `19` / `1A` | play the next / previous tune in file name order |
| `1B` / `1C` | step to the next / previous subtune |
| `20` + u8 `sub` + name | play `/home/<name>` at subtune `sub` - `11` plus a subtune (`sub` is 1-based, like the UI counts, and `255` selects the PSID startSong) |
| `21` + u8 `sub` | play subtune `sub` (1-based) of the loaded tune; `255` = the PSID startSong. Rejected when no tune is loaded. |
| `1D` [+ u8 `page`] | stack telemetry for the overflow hunt, 4 rows per page: the **interrupt stack** first, then the threads in creation order. `(size, free)` u16 pairs at `[36..51]`, the matching 11-byte names at `[52..95]`; `[34]` marker, `[35]` page with bit 7 set to say the names follow and bit 6 set on the last page (bit 7 clear = the older 5-per-page layout without names; bit 6 clear everywhere = firmware from before the interrupt row). Only the requested page is latched, so one page costs 4 stack scans. Under 256 B free anywhere is the smoking gun. |
| `1E` [+ u8 `mode`] | drain the SEGGER RTT log buffer - the `LOG_*` lines a debug probe would show; the next read returns up to 60 bytes of text at `[36..95]`, the byte count in `[35]`, `[34]` = marker. The bare opcode (or `mode` 0) **consumes** the chunk, so the device forgets it and a second call only shows newer lines. `mode` 1 restarts a *peek* at the oldest unread byte and 2 continues it; a peek never moves the read pointer, so it is repeatable and a later consume still sees the window. |
| `1F` [+ u8 `mode`] | accelerometer diagnosis into the log (**read-only** in a release image): I2C scan 0x08-0x77, `WHO_AM_I` at both possible addresses (0x19/0x18), what the Zephyr driver and the built-in poller each return, registers 0x00-0x5F as eight-byte rows, single-register reads of the control block and of the six output bytes, and a `CTRL_REG1`/`CTRL_REG4` write/read-back. This is what showed that a unit serving all zeros only needed the missing initialization: `ctrl2=30 ctrl4=88` and a moving `reg 28` row mean the chip is configured and converting, `ctrl2=00` with frozen output bytes means it is not. `SIDCLOCK_DEBUG` builds also take `mode` 1 (reboot the register file from OTP via the `CTRL_REG5` BOOT bit, then walk the ODR settings logging the output registers after each) and `mode` 2 (drop the sensor rail P1.11 for 150 ms, then bring touch, ambient light and the accelerometer back up and watch the data registers). |
| `50` | 1 s test tone |

Name-taking commands (`11`, `16`, `20`) accept up to 23 characters - the
full 24-byte buffer - so a `.sid` and all of its sidecars stay addressable
(a `.stil` is one character longer than its `.sid`; uploaded `.sid` names
stay at 20, keeping the sidecars inside the limit with room to spare).

Player commands (`0E`, `11`, `12`, `17` and `18`..`21`) are executed by
the **main loop** a moment after the write - the same path as a button
press. They must not run on the Bluetooth receive workqueue, whose small
stack cannot hold the tune loader plus a directory scan, so the write
handler only parks the request; a second command that arrives while one
is still queued is rejected with `INSUFFICIENT_RESOURCES`. Reading the
player state (or the snapshot) right after a write can still show the
previous tune for that moment.

The read snapshot (140 bytes) mixes audio state (sample rate, DMA buffer
health, enable registers), SID state (playing flag, song count, title,
render timing) and UI diagnostics; bytes [96..127] carry timekeeping
telemetry - `k_uptime_get()` ms, the raw GRTC cycle counter, the clock
guard trip count and the current clock base - so a host can spot a broken
uptime source, and byte [128] reports the BLE access mode. Bytes [129..138]
carry crash telemetry: boot counter, hwinfo reset-cause flags (LE), audio
and main thread heartbeats (u16 LE each, a stalled one names the hung
thread) and the active SID engine (0 = new, 1 = legacy, 0xFF = none).
Byte [137] is the filesystem state (0 = `/home` mounted, 1 = not mounted)
with the mount error code in [138]: an unmounted or corrupt LittleFS used to
report nothing anywhere, so `status` and `ls` can now say it instead of
showing an empty directory. Byte [139] is the worst audio-loop gap in ms
(low byte) since the previous snapshot read: it shows a stall that starts
after boot, when the all-time maximum in [16] is already saturated.

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
the buffer intact for a later plain `log`. The buffer lives at the start of
RAM and MCUboot writes its boot decision into the same region before it
starts the app (the app finds the control block valid and keeps it), so
after a reset the first lines are the bootloader's - a swap that did or did
not happen is diagnosed without a probe. The buffer runs in **overwrite**
mode (`CONFIG_LOG_BACKEND_RTT_MODE_OVERWRITE`): nothing on the device reads
it back, so a full buffer discards its oldest unread bytes instead of every
new line, and it always holds the newest window - its first line can be the
tail of a line whose start is gone, and that partial line is printed as it
is. The log core's small ring does the same one stage earlier.

The window (8 KB, debug builds a little more) holds only what has not been
read yet, and it lives in RAM across a warm reset, so a boot is visible
only while it still fits in the window. To capture a whole boot: drain it
once (`log`), reset the device, then `log --peek` - the window then starts
with MCUboot's banner. Draining is a real read: a debug probe running an
RTT session advances the same read pointer, so a probe viewer left open
leaves the BLE drain only the lines it has not seen (and vice versa).

A 30 s independent watchdog (fed from the main loop) reboots instead of
freezing: any wedged thread stops the loop directly or via a stuck lock.
After an unexpected reboot, `tools/sidclock_ble.py audio` shows the boot
count, the reset cause and which heartbeat stalled.

The accelerometer gets the full initialization sequence at boot (see
`accel_config()` in `main.c`): the Zephyr driver's init clears
`CTRL1`..`CTRL6` but never primes the high-pass filter or resets the FIFO,
and a part whose filter was never initialized answers every read with its
power-on zeros instead of live samples. It is then read through the Zephyr
LIS2DH driver, with a small built-in I2C poller as a fallback: when the
driver returns a sample with no gravity (|x|+|y|+|z| < 500 mg - what an
unconfigured or absent chip looks like) the app latches onto the poller,
logs the raw bytes once and the sensor screen prints `ACCEL: no sample`
instead of a plausible-looking `0.000`. Both paths report `g` with three
decimals, so the tilt bars and the rotation thresholds see the same units.
The register dump above is the field test for such a unit:
`tools/sidclock_ble.py accel` shows the output bytes and the filter
registers without needing a probe. A healthy unit shows a live sample there
(`Z = +/-9.8 m/s2`).

## Player status (web UI)

The custom service carries two more read characteristics so a host does not
have to parse the developer snapshot and does not have to poll:

- **state** `73696463-6c6f-4b03-9c1d-77ce3f41a5c0`, 16 bytes:
  `[0]` flags - bit 0 playing, bit 1 paused, bit 2 sound on, bit 3 legacy
  engine; `[1]` subtune (0-based), `[2]` song count, `[3]` end mode,
  `[4]` chip model mode (0 = auto, 1 = 6581, 2 = 8580), `[5]` chip in use
  (1 = 6581, 2 = 8580), `[6]` **info generation**, `[7]` reserved;
  `[8..11]` elapsed seconds (u32 LE), `[12..15]` the current subsong
  length from the `.len` sidecar (u32 LE, 0 = unknown).
- **info** `73696463-6c6f-4b04-9c1d-77ce3f41a5c0`, 96 bytes: title (32),
  file name (24), author (32), each NUL-padded, then `id` (8): the first
  4 bytes of the **whole-file MD5** of the tune the device actually
  loaded, as 8 lowercase hex characters. All zeros means unknown (no
  tune loaded, or the hash failed) and no HVSC file has that prefix.
  The id is what makes HVSC metadata exact: `Songlengths.md5` is keyed on
  this digest, while file names are not unique (HVSC has 3,700+ shared
  basenames, and uploads rename files). It only changes when a tune
  loads, like the strings.

The state value **notifies** on any change and once per second while a
tune plays (the elapsed field, so a client can tick between them); it
stays in sync with on-device button presses too. Nothing is sent while
nobody subscribes. A host subscribes to the state, reads the info once,
and re-reads the info whenever the generation byte moves. Both reads work
in every BLE access mode; the command writes need R/W as usual.

`tools/sidclock_ble.py state` prints one snapshot and `watch` follows the
notifications - the shell counterpart of the [web
remote](https://fanoush.github.io/SidClock/) (`web/`), which uses exactly
these two characteristics plus the command writes above.

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
tools/sidclock_ble.py sidname Parallax.sid --sub 2   # start at subtune 2
tools/sidclock_ble.py sidstop
tools/sidclock_ble.py state          # tune, subtune, position, modes
tools/sidclock_ble.py watch          # follow the state notifications
tools/sidclock_ble.py playpause      # also: next, prev, subnext, subprev
tools/sidclock_ble.py subplay 3      # subtune 3 of the loaded tune
tools/sidclock_ble.py ls             # list /home (paged listing command)
```

Developer commands (`audio`, `click`, `beep`, `tone`, `mute`, `rate`,
`tonefreq`, `tonestart`, `tonestop`, `chip`, `fsformat`) are documented in
the CLI's `--help`. The test-signal ones need a debug build
(`SIDCLOCK_DEBUG=1 ./build.sh`); against a release device the CLI reports
the rejection in one line instead of a traceback. `fsformat` erases `/home`
and asks for an explicit `yes` first (`-y` answers it, required when stdin
is not a terminal), then prints whether the fresh filesystem mounted.

## Files and OTA

- Tunes and sidecars live in LittleFS at `/home` and are uploaded with
  MCUmgr `fs_mgmt` (`smpmgr file upload ...`). There is no directory
  listing in `fs_mgmt`; use the `13` command (`tools/sidclock_ble.py ls`),
  which pages through a RAM index built at boot and kept current from
  uploads, so listing while a tune plays no longer touches the flash.
- Firmware images are uploaded with `tools/flash_ota.py` (or `smpmgr
  upgrade --slot 1`; a plain `upgrade` uploads without arming the image) -
  see [ota.md](ota.md).
