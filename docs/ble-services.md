# BLE services

The device advertises as **`SidClock`** (no pairing; the connection is open).
All interactions use standard services plus one custom debug service.

| Service | Characteristic | Properties | Notes |
|---|---|---|---|
| SMP `8d53dc1d-1db7-4cd3-868b-8a527460aa84` | `da2e7828-fbce-4e01-ae9e-261174997c48` | write-w/o-rsp, notify | MCUmgr/SMP with **img_mgmt**, **os_mgmt**, **fs_mgmt**. Used for OTA and file transfers. |
| Battery `0x180F` | Battery Level `0x2A19` | read, notify | percent |
| Current Time `0x1805` | Current Time `0x2A2B` | read, write | 10-byte little-endian; there is no RTC, the time is kept from uptime |
| Environmental Sensing `0x181A` | Illuminance `0x2AFB` | read | uint24 little-endian, **0.01 lx** units |
| Debug (custom) `73696463-6c6f-4b01-9c1d-77ce3f41a5c0` | `73696463-6c6f-4b02-9c1d-77ce3f41a5c0` | read, write | 128-byte status snapshot; commands below |
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
| `50` | 1 s test tone |

The read snapshot (128 bytes) mixes audio state (sample rate, DMA buffer
health, enable registers), SID state (playing flag, song count, title,
render timing) and UI diagnostics; bytes [96..127] carry timekeeping
telemetry - `k_uptime_get()` ms, the raw GRTC cycle counter, the clock
guard trip count and the current clock base - so a host can spot a broken
uptime source (`tools/sidclock_ble.py status` prints it). Every read is
passive: it must not disturb the running I2S bit clock.

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
