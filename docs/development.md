# Development

## Build workflow

```sh
bootloader/fetch-sdk.sh          # once (or after changing the pinned revs)
bootloader/build.sh              # bootloader (rtt: ./build.sh rtt)
app/build.sh                     # application + MCUboot signature
SIDCLOCK_DEBUG=1 app/build.sh    # + bring-up test commands, 8 KB RTT log buffer
```

The SDK location comes from `$SIDCLOCK_SDK` or a repo-root `local.conf`
(gitignored). Both scripts are safe to rerun; the app build is incremental
(ninja), the bootloader build cleans its build directory for reproducible
output.

`app/build.sh` builds the **release** configuration by default: the bring-up
test commands (test tones, sample-rate/tone ladders, raw MCKFREQ) are
compiled out - the debug BLE opcodes behind them are rejected - and the RTT
log buffer is 2 KB. `SIDCLOCK_DEBUG=1` builds the **debug** configuration
instead: those commands exist again and `app/prj_debug.conf` raises the RTT
buffer to 8 KB; the on-display version shows `-dbg`. The flag is passed on
every build, so a debug build never leaks into the next release build.

`app/build.sh` reuses/generates `app/sidclock.pem` for the MCUboot header if
it is missing. The bootloader checks hashes only, so the key content does
not matter - but never commit it (it is gitignored).

## Flashing

| Path | Command |
|---|---|
| Bootloader (SWD) | `bootloader/flash.sh [image.hex]` |
| Application (SWD) | `app/flash.sh [image.signed.bin]` |
| Application (BLE) | `smpmgr --ble <addr> upgrade app/build/zephyr/zephyr.signed.bin` |
| Unlock + erase | `tools/flash/erase.sh` (destructive) |

For day-to-day development, OTA (`smpmgr`) is fastest; SWD is the recovery
path. After any reset the wall clock is unset - run
`tools/sidclock_ble.py set-time`.

## Debugging

- **RTT bootloader**: build `bootloader/build.sh rtt` and flash it; MCUboot
  logs its validation/swap decisions over SEGGER RTT. The app always logs
  over RTT (`CONFIG_LOG_BACKEND_RTT`), no UART is wired.
- **BLE status**: `tools/sidclock_ble.py audio` prints the audio/SID debug
  snapshot; `status`, `monitor` and `ls` cover the rest. The debug
  characteristic layout and commands are in
  [ble-services.md](ble-services.md).
- **Firmware log**: `tools/sidclock_ble.py log` drains the SEGGER RTT
  buffer over BLE (the same `LOG_*` lines a probe would show, and no probe
  is attached during normal development). `log --peek` reads the buffer
  without consuming it, `log -f` follows; the buffer keeps its newest 2 KB
  (8 KB in debug builds) by overwriting the oldest unread bytes.
- **UI problems**: the display driver has power-state control; a fully
  blank panel with a running app usually means a missing panel re-init
  after sleep, not a dead driver.

## Conventions

- Zephyr coding style, 4-space tabs, 80-column comments. `main.c` is
  intentionally a single module for the UI today; if you split it, keep
  the screen functions independent of static state where practical.
- No dynamic allocation in the application path; `CONFIG_HEAP_MEM_POOL_SIZE=0`
  and the linked image contains no `malloc`/`k_malloc` caller, so nothing
  reserves the system heap. Static buffers are sized for the display band
  (448x16x2 bytes) and the audio double buffer.
- Store config changes by setting the `*_dirty` flags; the main loop
  throttles the flash writes.
- Time comparisons must use **unsigned modular deltas**
  (`k_uptime_get_32() - t0 >= N`): the uptime base is large and persists
  across warm resets on this SoC.
- Keep the panel/NOR bus traffic out of the debug log (`CONFIG_LOG_MAX_LEVEL`
  is 3) - the RTT buffer must not stall the display path.

## Testing checklist

Before calling a change done, verify on hardware:

1. Boot + UI: all screens draw, touch targets work, sliders respond.
2. SID: load a tune, play/pause/subtune, chip switch, end mode, marquee.
3. Alarms: create an ONCE alarm a minute out in idle, check ring/wake/touch.
4. Idle: wait for the timeout, confirm auto-brightness and orientation.
   If the idle face stops rotating or the sensor screen shows
   `ACCEL: no sample`, `tools/sidclock_ble.py accel` (read-only) prints the
   chip's `WHO_AM_I`, both read paths and the register file: a good unit
   shows a live `Z = +/-9.8 m/s2`, a silent one frozen output bytes.
5. Sleep: SLEEP button - panel dark, music continues, touch wakes, alarm
   wakes into the idle clock.
6. BLE: `status`, `set-time`, `ls`, OTA upload and version check.
7. Persistence: change settings, power-cycle (reset), verify they survive.

## Releases

1. Bump `VERSION` in `app/build.sh` and update `CHANGELOG.md`.
2. Build + test the checklist above.
3. Commit, push, then tag and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "SidClock X.Y.Z"
   git push origin vX.Y.Z
   ```

   CI builds the firmware and **creates the GitHub release automatically**
   (tag pushes only) with the signed application, the bootloader images and
   a `SHA256SUMS` file attached.
