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

## Where the time goes (measured, Game Over - the heaviest tune here)

VPR cycle counter, blob bench, 22050 Hz frames (budget 45.3 us/frame):

| Configuration | cycles/frame | us/frame |
|---|---|---|
| all engine code XIP from RRAM, -O3 -funroll-loops | 8,735 | 69.2 |
| CPU interpreter in SRAM | 6,889 | 54.4 |
| cRSID_emulateC64 in SRAM, -O3 | 5,901 | 49.4 |
| **cRSID_emulateC64 in SRAM, -O2** | **5,668** | **44.5** |
| ...with the CPU interpreter stubbed out | 3,367 | 26.3 |

M33 for the same tune: 30.6 us/frame (69% of realtime).

So the engine splits roughly **59% SID + 41% 6510 interpreter**. The
current design runs all of it on the FLPR: it fits, but with ~2% margin,
which shows up as ~1.7 underruns/second on this tune. Splitting the work
across both cores is the way to get real headroom:

| Split | M33 (measured) | FLPR (measured) |
|---|---|---|
| A: SID on the FLPR, C64/CPU on the M33 (implemented, `engine split`) | 25.5 us (56%) | ~26 us (58%) |
| B: C64/CPU on the FLPR, SID + I2S on the M33 | ~5 us would stay (11%) | ~18 us (40%) |
| whole engine on the FLPR (`engine flpr`) | ~0 (drains only) | 44.5 us (98%), ~1.7 underruns/s |

The measured split is lopsided: the SID stage costs ~5 us/frame on the
M33 but ~26 us on the FLPR (it is table/branch heavy, and the VPR has no
instruction cache), while the 6510 interpreter is *cheaper* on the FLPR
(18 us) than on the M33 (25.5 us). So the SID stage is the wrong half to
offload: the better split is B - the M33 keeps only the SID stage and
I2S (~11%) and the FLPR runs the C64/CPU (~40%).

**ADSR windows must stay <= 7 cycles.** cRSID's envelope pass detects at
most one shot per call and its quiet-voice folding assumes
`cycles/call <= 7` (below any prescale period). Batching a whole sample
(~45 cycles) into one call therefore advances slow envelopes once
instead of several times - heard as a bass line fading out. The M33
replays each sample's cycles in 7-cycle chunks, which matches the
per-instruction fold closely (events can land up to 7 *cycles* off).

A is the better split for UI responsiveness and the natural boundary:
the per-sample SID stage (`cRSID_emulateLightSIDs`) is already separate
from the per-instruction cycle loop. It needs the SID instance (voices,
ADSR, filter - about 1 KB, fits in the FLPR's SRAM) to move to the blob,
and the M33 to send per-sample cycle counts plus the SID register writes
($D400-$D41C) with their cycle offsets, so the ADSR gating and the
waveform generation stay cycle-exact. OSC3 reads would need the blob to
publish the oscillator value each sample (cRSID tolerates ~22 cycles of
delay there).

## Power

A started VPR costs about **0.5 mA**, and that cost does not go away by
stopping it: `CPURUN=0` plus a `NDMRESET` pulse leaves the block drawing
the same current (Nordic's answer in DevZone 127621: the default sleep
state is WAIT; DEEPSLEEP/HIBERNATE only shave part of it, and the way to
remove it is to power the block down while keeping state in RAM).

SidClock therefore:

- **never starts the FLPR unless an FLPR engine is selected**
  (`NORDIC_VPR_LAUNCHER=n`), so the default cRSID/cSID builds pay nothing;
- **powers the block down** (`flpr_halt()`: CPURUN off, NDMRESET, then
  clear `MEMCONF.POWER[1].RET` bit 0 - the same bit Zephyr's
  `z_sys_poweroff()` clears for the VPR) whenever playback stops or an
  M33 engine is selected. `flpr_start()` re-enables retention first and
  re-boots the blob, so switching back to split/FLPR is a few ms;
- while playing, the blob is busy ~40% of the time and spins otherwise;
  it does not `WFI` because a bare-metal blob has no interrupt to wake it
  (adding the VEVIF wake is possible, but the core is powered anyway while
  playing).

Do not enable VPR hibernate without moving the mailbox: the hardware
context-save address (`VPR00_VPRSAVEADDR`, 0x2003FE00) sits inside it.

## Host harness (tools/crsid_split_wav.c)

The split is deterministic, so both paths can be rendered on the host from
an identical state and compared sample by sample - no device needed:

```sh
gcc -O2 -std=gnu99 -o /tmp/split_wav tools/crsid_split_wav.c \
    app/src/sid/crsid/libcRSID.c -I app/src/sid -I app/src/sid/crsid \
    -I app/flpr -DCRSID_SPLIT -DCRSID_HOST_TEST -lm
/tmp/split_wav sids/Game_Over.sid 60 1 out   # -> out_ref.wav / out_split.wav
```

It reports the first differing sample with context, per-second RMS of the
difference (spots where a part goes missing rather than a constant offset)
and the per-second energy ratio of the two files. `-DHOST_DIRECT_REGS`
bypasses the event ring (writes the SID copy directly) to separate event
timing from the ADSR replay. `CRSID_HOST_TEST` maps the shared regions to
plain arrays and enables both split roles in one binary (the device build
has them in separate images).

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
