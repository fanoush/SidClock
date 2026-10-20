# FLPR (VPR RISC-V) cRSID render engine

The nRF54L15 has a second core next to the Cortex-M33: the **FLPR**
(fast light-weight peripheral processor), an RV32EMC RISC-V VPR. This
branch runs the cRSID render engine on it as a bare-metal blob, fed and
drained by the M33, so the SID emulation cost leaves the application
core.

Status: experimental. The engine renders correctly and audibly from the
blob; the M33 keeps loading/initialising tunes and owns all engine
state, and feeds I2S exactly as before.

## Why bare metal, and why XIP

- **Bare metal**: the blob is a `while (1)` render pump. No Zephyr, no
  west, no sysbuild, no interrupts, no libc - just the engine and the
  ring. Zephyr on the FLPR would cost RAM and add nothing for a
  number-crunching loop.
- **XIP**: the cRSID engine is ~150 KB of RV32EMC `.text` (measured with
  the `riscv64-zephyr-elf` toolchain, `-O3 -funroll-loops`), so the
  Nordic 96 KB SRAM-execution window cannot hold it. The blob executes
  in place from the M33 image at `flpr_blob[]` instead.
- **Zero copies**: the blob links the same `libcRSID.c` translation unit
  with every engine data symbol pinned onto the M33 instance address
  (`build.sh` two-phase link). Tune loading, `init` and `play` stay on
  the M33, operating on the state the blob renders from.

## Layout

Code: linked into the M33 image with `.incbin` in a small assembly unit
(`app/flpr/flpr_blob.S`, the elm-chan "binclude" trick) as `flpr_blob[]`,
aligned 128 bytes. No generated C array and no fixed flash partition:
the signed image grows by exactly the blob size. `build.sh` passes the
built binary's path and CMake makes the object depend on it, so a
rebuilt blob relinks.

RAM (all in the FLPR-side 68 KB SRAM window, outside the M33's 188 KB
link region, so the app keeps all of its RAM):

| Region | Address | Size | Use |
|---|---|---|---|
| SRAM | `0x20034000-0x2003BFFF` | 32 KB | PCM ring: blob renders, M33 drains (16384 int16 frames, ~0.74 s, absorbs fetch-contention bursts) |
| SRAM | `0x2003E000-0x2003FBFF` | 7 KB | blob-private RAM (`.got`/`.data`/`.bss`), 1 KB stack on top |
| SRAM | `0x2003FC00-0x2003FFFF` | 1 KB | shared control struct (`flpr/flpr_shared.h`) |

`app/flpr/flpr_shared.h` and `app/flpr.overlay` must agree on the RAM
map; `build.sh` checks it.

## Start / stop

`NORDIC_VPR_LAUNCHER=n`: **nothing runs on the FLPR at boot**. Debug
command `0x30` starts it; `0x30` with 0 halts it.

Start copies the embedded blob to FLPR private RAM when it fits (small
test builds) and otherwise XIPs it from `flpr_blob[]`, then sets
`INITPC` and runs the core. Stopping holds the core in reset via
`NDMRESET`: plain `CPURUN=0` only selects the state entered after a core
reset, so a CPURUN-only stop would never halt a running blob.

## Build

`app/build.sh` builds the blob first (plain CMake +
`flpr/toolchain-rv32emc.cmake`, `riscv64-zephyr-elf` from the SDK),
embeds it, then links the M33 image twice:

1. blob without the engine -> M33 link -> read `flpr_blob[]` and every
   engine data address;
2. blob with the engine linked against that map -> re-embed -> relink.

The second M33 link must produce the identical map, otherwise the build
fails. `blob_audit.py` also audits the blob link: zero dynamic
relocations, no `gp`-relative code, no small-data sections, stack top
where the header says.

## On-device test

```sh
app/build.sh                    # FLPR works in both; debug adds the tone tests
tools/flash_ota.py --now                    # arm + reboot + verify
tools/sidclock_ble.py set-time
tools/sidclock_ble.py sidname Last_Ninja_2.sid
tools/sidclock_ble.py engine flpr           # or the main-screen engine button
tools/sidclock_ble.py audio                 # "flpr pipe" line: underruns/peak
tools/sidclock_ble.py flprbench 4096        # engine render time, snapshot [144..151]
tools/sidclock_ble.py engine new            # back to the M33 renderer
```

`flprsid 0` forces the pipe directly without changing the engine choice
(handy when the tune is already playing); `flprsid stop` (or `0F`) stops
it. The blob never runs before the first command that needs it. A stalled
or absent blob shows as a frozen heartbeat in snapshot `[140..141]` with
`alive` clear in `[142]`.

## Engine selection

The main-screen engine button cycles three choices (BLE command `0x17`):

| Choice | Rendering |
|---|---|
| `cRSID` | cRSID on the M33 (default) |
| `cSID` | legacy cSID-light on the M33 (dual builds) |
| `FLPR` | cRSID on the FLPR blob |

Switching stops playback, changes the core and reloads/restarts the tune.
With `FLPR` selected, `audio_sid_start()` boots the blob (first use only)
and the audio fill drains the ring instead of calling the M33 renderer;
`audio_sid_stop()` idles the blob (`run = 0`) but leaves the core up, so
switching tunes does not pay a boot each time. If the blob cannot start,
the audio path falls back to the M33 renderer instead of going silent.

Pause/resume drives the blob too: paused sets `run = 0` (no rendering, no
tune-clock advance), resume drops whatever queued up and restarts it.

The tune clock (UI time line, player-state characteristic, auto-advance)
is driven by the frames the M33 actually drains from the ring, so it
advances exactly with what is played, in all three modes.

## What to watch

- **Underruns**: `audio` reports the pipe shortfall counter. Zero over a
  long run means the blob keeps ahead of the 320-frame DMA buffers.
- **Render time**: `flprbench` renders N frames on the blob, timed by
  the M33 (includes the cross-core round trip, so it is an upper bound
  per batch). Compare with the M33 render time in `audio`'s
  `render ... us` field.
- **RRAM contention**: the blob XIPs from the same RRAM bank the M33
  fetches from, so heavy M33 flash traffic (UI draws) can stall it. The
  32 KB ring rides through bursts; a persistent shortfall means growing
  it or the M33 traffic was underestimated.
