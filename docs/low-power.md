# Low power

SidClock keeps the SID player and the alarm service alive while using as
little energy as possible. This document describes the states and the
mechanisms; the "what runs" table is the summary to check a design change
against.

## Power states

| State | Panel | CPU / tick | Accelerometer | Light sensor | Audio | Alarms |
|---|---|---|---|---|---|---|
| **Active UI** | on, auto brightness | running, 100 ms loop | sampled every 2 s (auto-rotate) | profile updates on change | playing/paused as user set | armed, checked every second |
| **Idle face** | on, auto brightness | running, 1 s loop | sampled every 15 s, suspended in between | checked every 15 s | unchanged (keeps playing) | armed, checked every 15 s |
| **Sleep (dark idle)** | off (panel sleep-in) | running, 1 s loop | suspended (not sampled) | not sampled | unchanged (keeps playing, auto-advance continues) | armed, checked every second |

Entering sleep blanks the panel, stops all drawing (no clock, no battery
draw), skips the lux/orientation checks, and parks the accelerometer. It is
not a deep-sleep mode: the CPU keeps running the kernel, the audio thread
and the BLE stack.

## Mechanisms

- **Tickless kernel** (`CONFIG_TICKLESS_KERNEL=y`) - the kernel only wakes
  on scheduled work, not on every tick. This Zephyr port has no system PM
  subsystem, so there are no `CONSTLAT` states to enter; the idle thread
  executes `WFI`.
- **Sensor duty cycling** - the accelerometer is powered down (`CTRL_REG1 =
  0`) outside its sampling instants; the ambient light sensor is polled at
  low frequency and only when the display is on.
- **Audio stream suspend** - a class-D amplifier fed a continuous bit clock
  never enters its auto-shutdown, so after ~30 s without sound the I2S
  stream is stopped entirely (`TASKS_STOP`, `ENABLE=0`). Click/beep/alarm
  restarts it in a few milliseconds.
- **Panel power states** - `0` = display off/sleep-in (sleep mode), `1` =
  full re-init, `2` = deep standby. The app uses `0` for sleep to avoid
  re-init cost on wake.
- **BLE connection parameters** - when a central connects, the link is
  boosted (2M PHY, small connection interval) only for OTA throughput;
  advertising stops while connected.
- **Marquee pause** - the SID comment scroll accumulates only the time the
  SID screen is actually visible, so no timer work happens for invisible
  text.

## Measuring

There is no on-board current sense; measure with a USB power meter or a
Nordic Power Profiler Kit on the battery rail and compare states:

1. Active UI, panel at a fixed brightness.
2. Idle face (clock drawn once a minute, 15 s sensor checks).
3. Sleep (dark idle) with playback stopped.
4. Sleep with a SID playing.

Record numbers in this document when you have them - the state table above
tells you exactly which subsystems should be quiescent in each case.
