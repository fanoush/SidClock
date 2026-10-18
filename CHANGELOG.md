# Changelog

## 1.0.7

**Fixes**

- The accelerometer now gets the missing initialization before the first
  sample: `CTRL_REG3`/`CTRL_REG2` (high-pass filter), `FIFO_CTRL` bypass, a
  `REFERENCE` read to reset the filter, `CTRL_REG6`, then `CTRL_REG1 = 0x57`
  with `CTRL_REG4 = 0x88` (BDU, +-2g, high resolution). The Zephyr driver's
  init clears `CTRL1`..`CTRL6` but never primes the filter, and a part whose
  filter was never initialized answers every read with its power-on zeros -
  which used to look exactly like a dead chip. The sequence runs once per
  boot; the register file survives power-down, so resumes stay a single
  `CTRL1` write. Verified on hardware: a unit that had been reading `0/0/0`
  through a chip reboot, an ODR sweep and a sensor-rail drop now reports
  `Z = -9.98 m/s2` through the normal driver path.
- The accelerometer is no longer taken at face value. When the Zephyr LIS2DH
  driver returns a sample with no gravity at all (|x|+|y|+|z| < 500 mg), the
  app falls back to its own I2C poller, keeps the driver's values only once a
  real sample arrives, logs the raw bytes, and the sensor screen prints
  `ACCEL: no sample` instead of three plausible-looking zeros - an
  unconfigured or absent chip used to look exactly like a device lying flat.
  Both read paths now report `g` with three decimals and the
  orientation/tilt thresholds are compared in that same unit, so a device
  lying flat keeps its current idle face instead of picking one from the
  residual tilt. Verified on hardware.
- `SAVE STATE` no longer claims success on an unmounted `/home`: every
  writer no-ops without a filesystem, so the log said "state saved" while
  nothing was written. The save is now refused with a warning that names
  the mount error, and the read snapshot carries the filesystem state so
  hosts can see it too.

**Host tools**

- `tools/sidclock_ble.py log` prints the device's SEGGER RTT log buffer:
  the `LOG_*` lines that until now needed a debug probe (the SWD pads are
  under the back-cover foil, so in practice they were invisible). The lines
  are consumed by default, `--peek` prints the buffer without consuming it
  (so it can be repeated, and a later `log` still sees it) and `-f` follows;
  `--peek -f` watches new lines without ever consuming them. Verified on
  hardware.
- `threads` is now `stacks` (the interrupt stack comes first, then the
  threads); `threads` keeps working as an alias.
- `status` and `ls` report the filesystem state: an unmounted (corrupt or
  not formatted) LittleFS used to look like a device with no tunes, with
  the only hint buried in the boot log. `status` now prints `fs:` with the
  mount error and `ls` says the listing is empty because nothing is
  stored; `fsformat` recreates it.
- `fsformat` states what it erases and asks for an explicit `yes` before
  sending the format command; without a terminal it refuses unless `-y` is
  passed, so a script cannot wipe `/home` by accident. It then reports
  whether the fresh filesystem mounted.
- Ctrl-C now stops `log -f` and `monitor`: the first SIGINT was swallowed
  (asyncio cancels the main task and bleak's D-Bus read absorbs it), which
  left the tool running *and* the BLE link up, so the device stopped
  advertising and the next run reported "device not found" until the link
  was dropped by hand. The poll loops now leave through the normal
  disconnect path; a second Ctrl-C still forces the way out.

**Internal**

- `stacks` (BLE debug command `1D`, was `threads`; the old name still
  works) now reports the **interrupt stack** as its first row, then the
  threads, so the stack shared by the BLE controller and the I2S service
  routines is visible too - the `ISR0` line the thread analyzer used to
  print only into the log is now a row with size/free/used. The latch
  holds just the requested page (4 rows) and a thread handle per row
  instead of a copy of its name (the kernel owns it, `CONFIG_THREAD_NAME`,
  so it is read when the snapshot is built): 148 B of RAM back, and one
  page costs 4 stack scans instead of 12. The page byte's bit 6 marks the
  last page, so the host follows the listing instead of assuming 3 pages.
  Verified on hardware (same numbers as the previous firmware).
- The thread analyzer subsys is gone (`CONFIG_THREAD_ANALYZER`): the walk
  is 20 lines in `main.c`, which also drops `CONFIG_THREAD_RUNTIME_STATS`
  from the context-switch path; `CONFIG_INIT_STACKS`, `THREAD_MONITOR` and
  `THREAD_STACK_INFO` are now set explicitly.
- The log buffer runs in overwrite mode
  (`CONFIG_LOG_BACKEND_RTT_MODE_OVERWRITE`): with nothing reading RTT back,
  DROP kept only the oldest lines and threw every new one away; overwrite
  keeps the newest window (its first line can be the tail of a line whose
  start is gone - printed as it is). Debug command `1E` serves it to the
  BLE snapshot read, 60 bytes at a time.
- The RTT buffer is 8 KB in the release build too (was 2 KB) and both
  images use the *same* region at the start of RAM (`.rtt_buff_data`):
  MCUboot writes its boot decision there and the app keeps the initialised
  control block instead of starting its own
  (`CONFIG_SEGGER_RTT_INIT_MODE_STRONG_CHECK`), so a reset's log begins
  with the bootloader's lines - previously invisible, because two build
  bugs kept the bootloader's RTT path dead: `bootloader/build.sh` did not
  pass the segger module (`CONFIG_USE_SEGGER_RTT` was silently demoted to
  `n`) and `./build.sh rtt` *replaced* the base config instead of
  extending it. The up-buffer size decides where the control block sits,
  so it must stay identical in `app/prj.conf` and
  `bootloader/sidclock-mcuboot.conf`; the prebuilt bootloader is rebuilt.
- New read-only BLE debug command `1F` (`accel`) dumps the accelerometer:
  I2C scan 0x08-0x77, `WHO_AM_I` at 0x19/0x18, what the driver and the
  built-in poller each return, register rows 0x00-0x5F, single-register reads
  of the control block and of the six output bytes, and a
  `CTRL_REG1`/`CTRL_REG4` write/read-back. `SIDCLOCK_DEBUG` builds also take
  mode 1 (reboot the register file from OTP via the `CTRL_REG5` BOOT bit,
  then sweep the ODR settings) and mode 2 (power-cycle the sensor rail and
  bring touch/ALS back up). It is what led to the all-zero unit's root cause:
  same part as a working one (same `WHO_AM_I`, same trim/lot fingerprint),
  config writes sticking, data-ready tracking the ODR - only the six output
  bytes never left their power-up value, through a chip reboot, an ODR sweep
  and a rail drop. Applying the full initialization sequence above brought it
  live, so the zeros were the missing filter configuration, not a dead part.
- The periodic slot/trailer dump every 5 s is `SIDCLOCK_DEBUG`-only now: in
  a release image two lines every five seconds filled the ~2 KB log buffer
  and hid everything else. The boot-time dump stays.

## 1.0.6

Weekday fixes in the clock and in REPEAT alarms, a `NEXT SUB` auto-advance
fix, and a leaner release build (~15 KB RAM freed).

**Fixes**

- The clock header and idle screen showed a day of week two days off
  (e.g. "Sun" for a Friday): the weekday index was computed with a
  constant that assumed a different epoch weekday. It now uses
  "1970-01-01 was a Thursday" like the CTS time service already did.
- REPEAT alarms used the same off-by-two index, so they rang two days
  off the selected weekday (a Sunday alarm went off on Friday).
- `NEXT SUB` auto-advance started each newly loaded tune at the PSID
  startSong, which skipped the subtunes before it every time the player
  moved on to the next tune. Automatically loaded tunes now start at
  their first subtune; a manual tune change (and `NEXT TUNE` mode)
  still starts at the header default.

**Host tools**

- `tools/sidclock_ble.py` no longer prints a traceback when the device
  drops the BLE link as a command finishes (it also exits cleanly on
  Ctrl-C during `monitor`), and a device that is not advertising now
  reports one line after a 3 s discovery/connect timeout instead of
  waiting out the 30 s default. `tools/backup_ble.py` ignores the same
  disconnect error.

**Internal**

- `threads` (BLE debug command `1D`) latches the per-thread stack
  high-water marks so a suspected overflow can be sized from the host (a
  thread with less than 256 B free is flagged); it is also how the stacks
  kept in the release build were checked.
- RAM: about 15 KB of the 188 KB is freed. The 8 KB system heap is
  disabled (`CONFIG_HEAP_MEM_POOL_SIZE=0`, verified: nothing in the image
  calls `malloc`/`k_malloc`/`operator new`) and the release RTT log buffer
  drops from 8 KB to 2 KB. Per-block budget: `docs/architecture.md`.
- New debug build: `SIDCLOCK_DEBUG=1 app/build.sh` compiles the bring-up
  test commands back in (test tones, sample-rate/tone ladders, raw MCKFREQ,
  -0.5 KB RAM and their BLE opcodes) and applies `app/prj_debug.conf` for
  the 8 KB log buffer. Release builds reject those opcodes;
  `tools/sidclock_ble.py` reports the rejection in one line instead of a
  traceback. Debug images show `-dbg` in the on-display version string.

## 1.0.5

SID engine: exact ADSR envelope timing restored while keeping the render
speed. Fixes the new engine losing beats and voices in tunes like Last
Ninja 2, second subsong.

**Internal**

- 1.0.4 stepped the envelopes once per sample by replaying every shot
  the sample contained. That rescheduled shots that upstream cRSID
  leaves stalled (its rate counter is only tested against a window of
  the current instruction's cycles), which changed envelope phases and
  dropped envelope steps for seconds at a time in some tunes.
- The envelope pass is event-driven now: the CPU loop folds the cycles
  of consecutive instructions into a per-SID accumulator and runs the
  ADSR emulation only when the earliest shot (or the 0x8000 wrap that
  retries a stalled counter) can be reached within them, or right after
  a SID-register write; provably shotless folded calls collapse into a
  single counter add, and voices holding a level (sustain, released to
  zero) fold through exact modulo math. No sample-boundary rounding
  anywhere, so envelope timing matches upstream again.
- Host verification: bit-identical to upstream cRSID-1.58 on all 20
  sample tunes (single- and multi-SID, including the 2SID/3SID set);
  Last Ninja 2 subsong 2 renders byte-identical WAVs over 60 s. On the
  host worst-window profiler Arkanoid is back within a few percent of
  1.0.4's render time and multi-SID tunes stay well inside the budget.

## 1.0.4

New SID engine with a dual-engine safety net, tuned to fit the real-time
budget on the nRF54L15.

**Features**

- The player now runs cRSID-1.58 (Light profile) instead of the old
  cSID-light core: cycle-exact CPU/ADSR timing, fixed 6581 filter
  low-end (Myth), RTI at $DC0C, more digis and real RSID tunes. The
  default build links both engines: the main-screen button between
  `BLE R/W` and `SLEEP` toggles cRSID/cSID at runtime for tunes that
  play oddly (stops playback, flips the core, restarts the tune), and
  `tools/sidclock_ble.py engine new|old` does the same from the host.
  `SIDCLOCK_SID_ENGINE=crsid` or `=csid` builds single-engine images
  for A/B comparison (their display version gains `-crsid`/`-csid`).
- 2SID/3SID/4SID tune support (PSID v3/v4 and WebSID headers): verified
  on device with Jammer's 2SID/3SID tunes, up to 68% of the audio
  render budget; two multi-SID test tunes were added to
  `sids/fetch-samples.sh`.
- Independent watchdog (30 s, fed from the main loop) reboots the
  device instead of freezing if a thread wedges, and the BLE debug
  snapshot carries crash telemetry: boot count, reset cause, audio/main
  thread heartbeats and the active engine.

**Internal**

- cRSID slimmed for RAM: 4 KB IO banks, no ROM banks (ROM stubs live in
  the RAM copy like the old core), computed memory banking, no
  MD5/SongLengths engine, 320-frame audio buffers; RAM at 99.5%.
- Render-speed work for the M33 (heavy tunes like Arkanoid overran the
  budget in the first port): envelope stepping batched once per sample
  with a multi-shot rate-counter loop, steady voices skipped and their
  rate counters frozen cleanly (woken by SID register writes), memory
  read/write fast paths for non-IO pages, and crash-safety loop bounds
  removed where measurement showed they never fire. Heavy sections are
  ~25% faster than the first port and Arkanoid now fits; normal tunes
  cost ~10% more CPU than the old engine (was 1.7-1.9x at the first
  port). Note attacks may lead by up to one sample (43 us); envelope
  rates are unchanged.

## 1.0.3

Per-subsong STIL comments, plus current-HVSC database support in the
import tool.

**Features**

- The SID screen's scrolling comment line now follows the current
  subsong: when HVSC's STIL database has a note for that subsong (e.g.
  Last Ninja's "EAT YER HEART OUT GALWAY!" on subsong 5) it is shown,
  otherwise the tune-level comment is kept. Notes for tunes without a
  tune-level comment (e.g. Last Ninja 3) show on the annotated subsongs.
- The marquee keeps its scroll position while the displayed text stays
  the same, so the tune-level comment keeps scrolling while stepping
  through subsongs that fall back to it (a subsong's own note starts from
  the beginning). The unchanged comment row is also left untouched on
  such repaints instead of being cleared and redrawn in place.
- Sidecars grew optional `@<subsong> <comment>` lines after the tune
  comment (regenerate them with `tools/sid_add.py`); the firmware sidecar
  buffer went from 1 KB to 3 KB to fit the largest HVSC entries. The tune
  comment no longer carries its trailing newline.
- New `filedelete` command (debug opcode `0x16`): remove tunes from
  `/home`, a `.sid` also drops its `.len`/`.stil` sidecars. Only those
  extensions can be deleted (config files stay protected) and the command
  needs R/W mode.

**Internal**

- `tools/sid_add.py` now looks tunes up in HVSC's current
  `Songlengths.md5` database (whole-file MD5) and falls back to the legacy
  `Songlengths.txt` fingerprint. This fixes recently updated tunes (e.g.
  Arkanoid, Shades) getting no lengths/comments - the legacy database has
  not been regenerated for them. `sids/fetch-samples.sh` downloads both.

## 1.0.2

BLE access modes for when the clock is left unattended, plus main-screen
polish.

**Features**

- Three BLE modes cycled by a new main-screen button: **R/W** (normal),
  **R/O** (read-only: CTS and debug writes are rejected, the
  mcumgr/SMP service - OTA, file upload, os reset - is unregistered) and
  **OFF** (advertising stopped, existing connections dropped). The mode
  is deliberately not persisted: every reboot starts in R/W so OTA and
  development always work. Also settable with the DEV-only `blemode`
  debug/CLI command.
- Main screen: utility buttons rearranged into a 3x2 grid
  (AUTO ROT | AUTO BRI | SND on top, BLE mode | - | SLEEP below); the
  ALARMS tile shows `(ON)`/`(OFF)` instead of highlighting, and the SID
  tile is no longer highlighted (navigation tiles should not look like
  toggles).
- SND OFF now pauses an actively playing tune (silence + idle CPU); SND ON
  resumes it if the mute was what paused it.

**Internal**

- Debug snapshot grew to 132 bytes: byte [128] reports the BLE mode.
  `sidclock_ble.py status` prints it and `sidclock_ble.py blemode`
  switches modes remotely (R/W only).
- `CONFIG_BT_GATT_DYNAMIC_DB=y` for runtime SMP service registration.

## 1.0.1

Timekeeping fix: the wall clock is now driven by the raw GRTC system
counter instead of `k_uptime_get()`.

**Fixes**

- On the nRF54L15 the kernel uptime is seeded through a 32-bit tick count,
  so `k_uptime_get()` steps by a whole 2^32-tick wrap (137,439 s) when the
  GRTC's absolute tick count crosses such a boundary. This jumped the
  clock forward by ~2.3 days overnight (2026-10-13) and ate a morning
  alarm. The wall clock now uses the 64-bit GRTC counter via
  `k_cycle_get_64()`; `time.cfg` gained a GRTC field (old 2-field files
  are migrated on first boot).
- `time.cfg` now stores the actual wall clock at save time (not the stale
  clock base), so a warm reboot no longer drags the clock backwards by the
  time since the last host sync.
- `epoch_now()` keeps the last trusted wall clock when the timebase moves
  backwards or jumps (>2 min between samples) - a GRTC reset can no longer
  corrupt the clock.

**New**

- Timekeeping telemetry in the BLE debug snapshot (bytes [96..127]):
  `k_uptime`, raw GRTC counter, guard trips; `sidclock_ble.py status` and
  `monitor` print it.
- `sidclock_ble.py glitch reset|fwd` injects a fake timebase glitch to
  exercise the clock guard on hardware.

## 1.0.0

First public release.

**Features**

- Landscape touch UI on the 368x448 AMOLED/LCD panel: header (clock, date,
  battery, ambient light), navigation tiles, auto-rotation toggle, sound
  toggle, auto-brightness toggle and a full blank sleep mode.
- SID player with a 6581/8580 cSID-light emulator: tune browser, subtune
  transport, chip-model A/B, song-length-aware END modes (LOOP / NEXT TUNE /
  NEXT SUB), scrolling STIL comment and subsong names.
- Ambient-light profiles (night/indoor/outdoor) with per-profile lux
  thresholds and brightness levels, automatic brightness, burn-in-safe idle
  face with random clock positions.
- Five alarms (OFF / ONCE / REPEAT) with per-day repeat, adjustable length
  and a ringtone captured from a SID.
- Idle face auto-rotation (accelerometer every 15 s), auto-brightness checks
  in idle, configurable idle timeout (15 s .. 5 min) and a dark SLEEP mode
  where SID playback and alarms keep running.
- BLE: Battery Service, Current Time Service, MCUmgr/SMP (OTA +
  filesystem), and a debug/control characteristic. Open connection
  (no pairing) for easy development.
- Over-the-air updates through MCUmgr with MCUboot swap (secondary slot on
  the external 4 MiB SPI flash) and self-confirm.
- LittleFS `/home` partition on the external flash for tunes, sidecars and
  settings.
- Host tools: BLE control CLI, HVSC-fingerprint `sid_add.py` (writes
  `.len`/`.stil` sidecars and uploads), read-only BLE backup tool, bootloader
  and app build scripts with pinned dependencies, prebuilt bootloader.

**Known limitations**

- The bootloader validates images by SHA-256 only (the stock signing keys
  are unavailable) and the SMP service requires no pairing - see
  `docs/security.md`.
- Hardware revision differences (audio amp, panel, ALS) are handled by
  auto-detection/defaults; see `docs/hardware.md`.
