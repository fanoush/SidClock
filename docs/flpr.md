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
fails. The blob's `.flprhot` section (engine code executed from the FLPR
SRAM - see "Where the time goes") is copied by `startup.S` before
`main`; it currently carries ~28 KB against the 52 KB window. `blob_audit.py` also audits the blob link: zero dynamic
relocations, no `gp`-relative code, no small-data sections, stack top
where the header says.

## On-device test

```sh
app/build.sh                    # FLPR works in both; debug adds the tone tests
tools/flash_ota.py --now                    # arm + reboot + verify
tools/sidclock_ble.py set-time
tools/sidclock_ble.py sidname Last_Ninja_2.sid
tools/sidclock_ble.py engine split          # or the main-screen engine button
tools/sidclock_ble.py audio                 # split health line, see below
tools/sidclock_ble.py engine new            # back to the M33 renderer
```

The blob never runs before the first command that needs it. A stalled or
absent blob shows as a frozen heartbeat in snapshot `[140..141]` with
`alive` clear in `[142]`.

`engine split` prints one extra line while the split runs:

```
split: flpr cpu 41.3%  lead 320 (min 144)  starved 0
```

- **`flpr cpu`** is the fraction of wall time the blob spends inside the
  CPU pump (permille in `[144..145]`), measured with `mcycle` over a
  ~0.25 s window. It is the FLPR half's utilisation: ~49% on Game Over,
  ~63% on Arkanoid, ~10% on a light tune. At 100% the blob is saturated
  and the M33 starts to starve.
- **`lead`** is `prod - cons`, the samples the blob is ahead of the M33
  (snapshot `[148..149]`). The blob pumps to 320, so it hovers there
  while there is headroom and falls when there is not. **`min`** is the
  lowest since playback started (`[146..147]`, `n/a` before the first
  buffer): a minimum that keeps collapsing towards 0 - in particular
  below one audio buffer (176 samples) - means the FLPR side is at or
  past 100% even if `starved` is still 0.
- **`starved`** counts fill buffers that found no samples ready at all
  (`[150..151]`); the same counter is the `underruns` field of the
  `flpr:` line in `audio`. A non-zero value is an audible gap.

So: `flpr cpu` is the mean load, `lead min` is the worst-case margin
between the two cores. Both are in the debug snapshot, so they can be
recorded with `audio` while the tune plays.

## Engine selection

The main-screen engine button cycles three choices (BLE command `0x17`):

| Choice | Rendering |
|---|---|
| `cRSID` | cRSID on the M33 (default) |
| `cSID` | legacy cSID-light on the M33 (dual builds) |
| `SPLIT` | FLPR runs the C64/CPU, the M33 the SID stage + I2S |

A fourth mode existed during bring-up (the whole cRSID engine on the
blob). It is gone: at 44.5 us/frame it sat at ~98% of realtime with
~1.7 underruns/s on the heaviest tune, while split B runs the same tune
with the M33 at ~19% and the FLPR at ~50%.

Switching stops playback, changes the core and reloads/restarts the tune.
With `SPLIT` selected, `audio_sid_start()` boots the blob (and powers the
VPR block back up if an M33 engine had powered it down) and the M33
renders the SID stage from the blob's cycle counts and register-write
events in the audio fill path. `audio_sid_stop()` halts and powers the
block down (see Power). If the blob cannot start, the audio path falls
back to the M33 renderer instead of going silent.

Pause/resume drives the blob too: paused sets `run = 0` (no CPU
emulation, no tune-clock advance), resume drops whatever queued up and
restarts it.

The tune clock (UI time line, player-state characteristic, auto-advance)
is driven by the samples the M33 renders, so it advances exactly with
what is played, in every mode.

## Where the time goes (measured, 22050 Hz frames, budget 45.3 us/frame)

The VPR has **no instruction cache**: code fetched from RRAM costs ~3
cycles per instruction, code fetched from SRAM ~1 (measured with the same
4-instruction loop: 15.3 vs 5.1 cycles/iteration). That makes *code
placement* the dominant tuning knob on this core - far more than the
optimisation level - and it is easy to get wrong:

| Blob layout | what runs from where | split CPU half |
|---|---|---|
| early bring-up | only `cRSID_emulateC64` in SRAM, the 26 KB 6510 interpreter and `cRSID_generateSample` XIP from RRAM | 37 us/frame (82%), Arkanoid 98% |
| **current** | `cRSID_emulateCPU` + `cRSID_emulateC64` + `cRSID_generateSample` + the pump in `.flprhot` (28.4 KB of the 52 KB window) | **22 us/frame (49%)**, Arkanoid 63% |

The interpreter was the one that mattered: it is ~70% of the frame's work
and was being fetched at ~3 cycles/instruction. Moving it into SRAM cut
its own cost by ~2.8x and the whole blob half by ~40% (Arkanoid 98% ->
63%, Game Over 83% -> 49%, ACE II 17% -> 11%, Last Ninja 2 ~10%).

Rule: **anything executed per audio frame belongs in `.flprhot`** - and so
does the idle loop. Between buffers `main()` spins on the shared control
word; from RRAM that spin fetched ~8 instructions every ~24 cycles (a few
hundred MB/s of reads) from the same memory the M33 fetches its code
from, the reverse of the contention above. It lives in SRAM too now, so
after `_start` (612 B, runs once) the blob generates no code fetches from
RRAM at all; only its data accesses to the shared structs remain.
 The
section is copied to FLPR SRAM by `startup.S` before `main`, the build
audit caps it to the window, and `nm` should show every engine function
at 0x2002F000+:

```sh
riscv64-zephyr-elf-nm -S --size-sort app/build-flpr/flpr.elf | tail
```

Optimisation level, measured again once the code was in SRAM: `-O2` beats
`-O3` slightly (68.8% vs 71.4% on Arkanoid); `CRSID_HOT_CODE` uses
`-O2` too (it used to force `-Os` to fit the window, but 24 KB of the
52 KB are still free and `-O2` measured a little better).

Per-section cycles on Arkanoid (profiling build, see below), cycles per
audio frame at 128 MHz:

| Section | cycles/frame | share |
|---|---|---|
| 6510 interpreter (`cRSID_emulateCPU`) | 1600-2200 | ~50% |
| both CIAs (`cRSID_emulateCIA` x2) | 1050-1550 | ~40% |
| VIC raster/IRQ (`cRSID_emulateVIC`) | 220-350 | ~10% |

Both heavy tunes here are RSID, so the VIC and both CIAs run once per
instruction (PSID calls neither). A fast path for "timer stopped, no
strobe" was tried and measured flat: these tunes keep their timers
running, so it never triggered - reverted rather than kept as dead
weight. The remaining cost is the emulation itself, now running from
SRAM.

Historical whole-engine numbers (the removed mode, measured when only
`cRSID_emulateC64` was in SRAM): 44.5 us/frame, ~98% of realtime. With
today's placement that engine would be far cheaper, but split B is still
the better use of the second core:

| Split | M33 (measured) | FLPR (measured) |
|---|---|---|
| A: SID on the FLPR, C64/CPU on the M33 (superseded) | 25.5 us (56%) | ~26 us (58%) |
| B: C64/CPU on the FLPR, SID + I2S on the M33 (current) | 8.8 us (19%) | 22 us (49%) |
| whole engine on the FLPR (removed) | ~0 (drains only) | 44.5 us (98%), ~1.7 underruns/s |

What the split buys is the *screen*: the M33 spends ~9 us/frame on audio
instead of ~30 us, so UI redraws no longer starve the emulation.

### Profiling the split CPU half

`FLPR_PROF=1 app/build.sh` builds the blob with `mcycle` counters around
the interpreter, both CIAs and the VIC. They are exponential averages
(alpha 1/16) published in `FLPR_SHARED->prof[]` once per frame, so the
overhead is well under 1%; the M33 logs them whenever the debug snapshot
is read:

```sh
FLPR_PROF=1 app/build.sh && tools/flash_ota.py --now
tools/sidclock_ble.py engine split
tools/sidclock_ble.py sidname Arkanoid.sid
tools/sidclock_ble.py audio                 # any snapshot read triggers it
tools/sidclock_ble.py log | grep 'split prof'
# split prof: cpu 1659 cia 1042 vic 248 total 2943 cyc/frame
```

`total` is the sum of the three sections (the rest of the frame is the
waveform publish, event handling and the pump loop). Release builds do
not write `prof[]`, so the log line never appears there.

### Fidelity: what the split has to get exactly right

The split runs the same core in two images, so differences come only from
*splitting* the per-sample work. Three rules came out of tuning it, each
found by a tune that broke:

- **Same output stage as the unsplit engine.** cRSID has two SID
  renderers and the choice is a *global setting*, not a tune flag:
  `cRSID_init()` defaults to HighQualitySID (oversampled waveforms +
  filter, `cRSID_emulateOversampledSIDwaves`/`SIDoutputs`, phase step
  `freq * CRSID_OVERSAMPLING_CYCLES`), while the device's
  `libcsid_init()` sets Light (`cRSID_emulateLightSIDs`, phase step
  `freq * SampleClockRatio` - a 16x different scale). The split used to
  force the light renderer for everything, so selecting HQ at runtime
  would have played at the wrong pitch scale through the wrong filter
  chain. The selection is now mirrored, which also makes the host
  harness test the same path as the device (it used to call
  `cRSID_setQuality` *before* `cRSID_init`, which forces HQ - so it was
  silently testing HQ for every tune; it now applies the quality after
  init and defaults to Light, `SID_HQ=1` for the oversampled path).
- **Per-write cycle offsets.** The blob tags each SID write with the
  cycle it happened at inside the sample (`FLPR_EVENTS[].cyc`, from
  `FLPR_SHARED->cur_cyc`), and the M33 replays the sample's ADSR cycles
  up to that point before applying it. Without it, all of a sample's
  writes were applied first and one envelope pass ran afterwards: a
  gate-off/gate-on pair (the hard restart almost every SID player uses
  for note-on) collapsed, the rising edge was never seen, and notes
  played without their attack - Leviathan again, on every note.
- **Per-chip register files.** Each SID instance gets its own 32-byte
  block (`FLPR_SID_REGCOPY + (chip-1)*32`) and writes are tagged with the
  chip (`FLPR_EVENTS[].chip`). Before that, only writes inside SID 1's
  range became events, so 2SID/3SID tunes played without their extra
  chips. Probe: Odyssey 2SID went from max |diff| 16806 to 3,
  Light Years 3SID from 5933 to 21.

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

- **never starts the FLPR unless the split engine is selected**
  (`NORDIC_VPR_LAUNCHER=n`), so the default cRSID/cSID builds pay nothing;
- **powers the block down** (`flpr_halt()`: CPURUN off, NDMRESET, then
  clear `MEMCONF.POWER[1].RET` bit 0 - the same bit Zephyr's
  `z_sys_poweroff()` clears for the VPR) whenever playback stops or an
  M33 engine is selected. `flpr_start()` re-enables retention first and
  re-boots the blob, so switching back to split/FLPR is a few ms;
- while playing, the blob is busy ~80% of the time on the heaviest
  tunes and spins otherwise;
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
and the per-second energy ratio of the two files. After the fixes in
"Fidelity" above, the tunes tested here are identical or within a few
LSBs in both quality modes: Leviathan 0 samples differing, Game Over
max |diff| 2, Arkanoid 5, Odyssey 2SID 3, Light Years 3SID 21 - all
inaudible, and a far cry from the hundreds-to-thousands RMS differences
before.

### SID quality (Light vs HQ)

`quality light|hq` (BLE `0x35`, not persisted) switches the SID renderer
at runtime. HQ is cRSID's own default, but it costs ~4.6x the SID stage
on this hardware, measured on the device for Leviathan:

| mode | split SID stage | share of the 45.3 us frame |
|---|---|---|
| light (default) | 2.5 ms / 320 frames = 7.7 us | 17% |
| HQ | 13.7 ms / 320 frames = 43 us | 95% |

and the M33 cRSID engine goes from ~35 us to ~62 us/frame, i.e. past
realtime. So HQ is an A/B listening tool, not a default: it lowers
aliasing and models the filter/output stage more closely, but it leaves
no headroom for the UI or for a 2SID/3SID tune (which multiply the SID
work). `-DHOST_DIRECT_REGS`
bypasses the event ring (writes the SID copy directly) to separate event
timing from the ADSR replay. `CRSID_HOST_TEST` maps the shared regions to
plain arrays and enables both split roles in one binary (the device build
has them in separate images).

## What to watch

- **FLPR load**: `audio`'s `split: flpr cpu N%` line (snapshot
  `[144..145]`, permille). ~49% on Game Over, ~63% on Arkanoid, ~10% on
  a light tune; it is measured inside the pump with `mcycle` (only the
  calls that actually produce samples are charged), so it is the real
  duty cycle rather than an estimate. Multiply by 45.35 us for the
  us/frame.
- **Lead**: `lead N (min M)` (snapshot `[146..149]`). The blob pumps to
  320 samples ahead, so `lead` sits there with headroom. A `min` that
  keeps dropping towards 0 - especially below one fill buffer (176
  samples) - is the FLPR side at or over 100%, even before an audible
  gap.
- **Starved buffers**: `starved N` (snapshot `[150..151]`) and the
  `underruns` field of the `flpr:` line. Non-zero means the M33 found no
  samples at a buffer boundary: an audible gap.
- **M33 share**: `render N us` is the M33's SID-stage time per 320
  frames (was ~5-7 us, against a 14.5 ms period).
- **RRAM contention**: the blob XIPs from the same RRAM bank the M33
  fetches from, so heavy M33 flash traffic (UI draws) can stall it. The
  320-sample lead rides through bursts; a persistent shortfall is either
  the FLPR at its limit (`flpr cpu` near 100%) or growing M33 stalls.
