#!/usr/bin/env python3
"""Talk to a SidClock device over BLE.

Device address (in order): --addr, $SIDCLOCK_ADDR, or a scan for a device
advertising as "SidClock".

User commands:
  status    read battery level, device time and ambient light level
  set-time  write the host's local date/time to the Current Time Service
            (optional UTC offset in hours, e.g. "set-time +2")
  monitor   poll battery + lux every 2 s until interrupted
  sid N     play /home/N.sid (N = 0..9)
  sidname S play /home/S by file name (e.g. Last_Ninja_2.sid)
  sidstop   stop SID playback
  chip M    SID chip model: auto (follow PSID flags) | 6581 | 8580
  ls        list the files in /home on the device

Developer/debug commands (see docs/ble-services.md; behaviour may change):
  audio     read the audio debug snapshot (I2S state + return codes)
  click     trigger a test click on the device
  beep      trigger a test beep on the device
  tone      play a 1 s test tone on the device
  mute      toggle the device's sound on/off
  rate      get/set the I2S sample rate (Hz)
  tonefreq  step/play a test tone frequency (Hz)
  tonestart/tonestop  steady tone on/off
  fsformat  DESTRUCTIVE: format the /home LittleFS partition

Uploading SID tunes (any name, played in file name order by the device):
  smpmgr --ble <addr> file upload <local.sid> /home/<name>.sid
  tools/sid_add.py <local.sid>     # generates .len from HVSC and uploads

Examples:
  sidclock_ble.py status
  sidclock_ble.py set-time
  sidclock_ble.py sidname Last_Ninja_2.sid
  sidclock_ble.py monitor --addr AA:BB:CC:DD:EE:FF
"""

import argparse
import asyncio
import os
import struct
import sys
import time

from bleak import BleakClient, BleakScanner
TONES = [1000, 2000, 4000, 8000, 10000, 12000, 15000, 18000,
         20000, 22000, 24000, 26000, 28000, 30000]
BATTERY_CHAR = "00002a19-0000-1000-8000-00805f9b34fb"  # BAS Battery Level
CTS_CHAR = "00002a2b-0000-1000-8000-00805f9b34fb"      # CTS Current Time
ILLUMINANCE_CHAR = "00002afb-0000-1000-8000-00805f9b34fb"  # ESS Illuminance
DBG_CHAR = "73696463-6c6f-4b02-9c1d-77ce3f41a5c0"      # SidClock debug


def lux_u24(raw):
    """Illuminance is uint24 little-endian, 0.01 lx per unit."""
    return int.from_bytes(bytes(raw), "little") * 0.01


def time_payload(t):
    """Standard Current Time (0x2A2B) value: 10 bytes, year little-endian."""
    return struct.pack(
        "<HBBBBBBBB",
        t.tm_year,
        t.tm_mon,
        t.tm_mday,
        t.tm_hour,
        t.tm_min,
        t.tm_sec,
        (t.tm_wday % 7) + 1,
        0,
        0,
    )


def time_str(raw):
    year, mon, day, hh, mm, ss, dow, _frac, _reason = struct.unpack(
        "<HBBBBBBBB", bytes(raw)
    )
    return f"{year:04d}-{mon:02d}-{day:02d} {hh:02d}:{mm:02d}:{ss:02d} (dow {dow})"


async def resolve_addr(explicit):
    """--addr / $SIDCLOCK_ADDR / scan for the advertised name."""
    if explicit:
        return explicit
    env = os.environ.get("SIDCLOCK_ADDR")
    if env:
        return env
    print("scanning for a device named 'SidClock' ...", file=sys.stderr)
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: bool(d.name and "SidClock" in d.name), timeout=10.0
    )
    if dev is None:
        raise SystemExit(
            "device not found - pass --addr <addr> or set SIDCLOCK_ADDR"
        )
    print(f"found {dev.name} [{dev.address}]", file=sys.stderr)
    return dev.address


async def cmd_status(addr):
    async with BleakClient(addr) as c:
        batt = await c.read_gatt_char(BATTERY_CHAR)
        ct = await c.read_gatt_char(CTS_CHAR)
        lux = await c.read_gatt_char(ILLUMINANCE_CHAR)
        print(f"battery: {batt[0]} %")
        print(f"time:    {time_str(ct)}")
        print(f"lux:     {lux_u24(lux):.2f} lx")
        print(f"host:    {time.strftime('%Y-%m-%d %H:%M:%S')} (local)")


async def cmd_set_time(addr, tz=None):
    """tz: explicit UTC offset in hours (e.g. "+2"); default: host local."""
    if tz is not None:
        t = time.gmtime(time.time() + float(tz) * 3600)
    else:
        t = time.localtime()
    async with BleakClient(addr) as c:
        payload = time_payload(t)
        await c.write_gatt_char(CTS_CHAR, payload, response=True)
        back = await c.read_gatt_char(CTS_CHAR)
        print(f"wrote:  {time_str(payload)}")
        print(f"device: {time_str(back)}")


async def cmd_monitor(addr):
    async with BleakClient(addr) as c:
        print("polling battery + lux every 2 s - Ctrl-C to stop", flush=True)
        while True:
            batt = await c.read_gatt_char(BATTERY_CHAR)
            lux = await c.read_gatt_char(ILLUMINANCE_CHAR)
            print(
                f"{time.strftime('%H:%M:%S')}  battery {batt[0]:3d} %   "
                f"lux {lux_u24(lux):9.2f}",
                flush=True,
            )
            await asyncio.sleep(2)


def _u32(raw, off):
    return int.from_bytes(bytes(raw[off:off + 4]), "little")


def _rate_of(raw):
    return raw[66] | (raw[67] << 8) | (raw[68] << 16)


async def cmd_audio(addr):
    async with BleakClient(addr) as c:
        raw = await c.read_gatt_char(DBG_CHAR)
        print(f"ready {raw[0]}  init_rc {raw[1]}  enabled {raw[6]}  "
              f"volume {raw[7]}  asleep {raw[5]}")
        print(f"play attempts {raw[9]}  tone buffers left {raw[17]}  "
              f"combo {raw[18]} (flags 0x{raw[19]:02x})")
        print(f"PSEL sck 0x{_u32(raw, 20):08x}  sdout 0x{_u32(raw, 24):08x}  "
              f"mck 0x{_u32(raw, 28):08x}")
        print(f"enable {raw[32]}  txen {raw[33]}")
        if len(raw) > 45:
            peak = raw[36] | (raw[37] << 8)
            print(f"buffers: peak {peak}   w0 0x{_u32(raw, 38):08x}  "
                  f"w1 0x{_u32(raw, 42):08x}")
            print(f"dma events {raw[46]}  mck 0x{_u32(raw, 51):08x}  "
                  f"ratio {raw[47]}  width {raw[48]}  ch {raw[49]}  "
                  f"align {raw[50]}")
            print(f"buserr0 0x{_u32(raw, 55):08x}  "
                  f"buserr1 0x{_u32(raw, 59):08x}")
            if len(raw) > 93:
                title = bytes(raw[75:90]).split(b"\0")[0].decode(
                    errors="replace")
                print(f"sid playing {raw[72]}  songs {raw[73]}  "
                      f"rc {raw[74] - 256 if raw[74] > 127 else raw[74]}  "
                      f"render {raw[13] * 4} us  title {title!r}  "
                      f"calls {raw[90] | (raw[91] << 8)}  "
                      f"frames {raw[92] | (raw[93] << 8)}")
            if len(raw) > 68:
                mode = "direct" if raw[10] == 255 else f"step {raw[10]}"
                print(f"{mode}  rate {_rate_of(raw)} Hz")


async def cmd_tone(addr, code):
    label = {
        1: "click",
        2: "beep",
        3: "sound on/off toggle",
        0x0D: "FORMAT /home storage (DESTRUCTIVE!)",
        0x0E: "play SID",
        0x0F: "stop SID",
        0x50: "1 s steady test tone",
    }.get(code, f"code 0x{code:02x}")
    async with BleakClient(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([code]), response=True)
        print(f"triggered: {label}")




async def cmd_rate(addr, hz=None):
    if hz is not None:
        if not 1000 <= hz <= 96000:
            raise SystemExit("rate must be 1000..96000 Hz")
        async with BleakClient(addr) as c:
            await c.write_gatt_char(DBG_CHAR,
                                    bytes([0x09]) + hz.to_bytes(4, "little"),
                                    response=True)
            raw = await c.read_gatt_char(DBG_CHAR)
            print(f"sample rate set to {_rate_of(raw)} Hz")
        return
    async with BleakClient(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([0x07]), response=True)
        raw = await c.read_gatt_char(DBG_CHAR)
        print(f"sample rate now {_rate_of(raw)} Hz (step {raw[10] + 1})")


async def cmd_tonefreq(addr, hz=None):
    if hz is None:
        async with BleakClient(addr) as c:
            await c.write_gatt_char(DBG_CHAR, bytes([0x08]), response=True)
            raw = await c.read_gatt_char(DBG_CHAR)
            hz = TONES[raw[11]]
        rate = _rate_of(raw)
        warn = ("  (ALIASED - above Nyquist for this rate)"
                if hz * 2 >= rate else "")
        print(f"tone now {hz} Hz at {rate} Hz sample rate{warn} (2 beeps)")
        return

    if not 100 <= hz <= 30000:
        raise SystemExit("tone must be 100..30000 Hz")
    async with BleakClient(addr) as c:
        await c.write_gatt_char(DBG_CHAR,
                                bytes([0x0A]) + hz.to_bytes(4, "little"),
                                response=True)
        raw = await c.read_gatt_char(DBG_CHAR)
    rate = _rate_of(raw)
    warn = ("  (ALIASED - above Nyquist for this rate)" if hz * 2 >= rate
            else "")
    print(f"tone {hz} Hz at {rate} Hz sample rate - 10 s steady{warn}")


async def cmd_tonestart(addr, hz=None):
    hz = 1000 if hz is None else hz
    if not 100 <= hz <= 30000:
        raise SystemExit("tone must be 100..30000 Hz")
    async with BleakClient(addr) as c:
        await c.write_gatt_char(DBG_CHAR,
                                bytes([0x0B]) + hz.to_bytes(4, "little"),
                                response=True)
    print(f"steady {hz} Hz tone started - stop with: tonestop")


async def cmd_tonestop(addr):
    async with BleakClient(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([0x0C]), response=True)
    print("tone stopped")


async def cmd_sid(addr, n=None):
    n = 0 if n is None else n
    if not 0 <= n <= 9:
        raise SystemExit("SID index must be 0..9 (/home/<n>.sid)")
    async with BleakClient(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([0x0E, n]), response=True)
        raw = await c.read_gatt_char(DBG_CHAR)
    title = bytes(raw[75:90]).split(b"\0")[0].decode(errors="replace")
    rc = raw[74] - 256 if raw[74] > 127 else raw[74]
    print(f"SID: playing={raw[72]} songs={raw[73]} rc={rc} title={title!r} "
          f"render_calls={raw[90] | (raw[91] << 8)} "
          f"frame_calls={raw[92] | (raw[93] << 8)}")


async def cmd_sidname(addr, name=None):
    if not name:
        raise SystemExit("usage: sidname <name.sid>  (file in /home)")
    data = name.encode("ascii", "replace")
    if len(data) > 20:
        raise SystemExit("file name too long (max 20 chars)")
    async with BleakClient(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([0x11]) + data, response=True)
        raw = await c.read_gatt_char(DBG_CHAR)
    title = bytes(raw[75:90]).split(b"\0")[0].decode(errors="replace")
    rc = raw[74] - 256 if raw[74] > 127 else raw[74]
    print(f"SID '{name}': playing={raw[72]} songs={raw[73]} rc={rc} "
          f"title={title!r}")


async def cmd_chip(addr, mode=None):
    modes = {"auto": 0, "6581": 1, "8580": 2}
    m = 0 if mode is None else modes.get(str(mode).lower())
    if m is None:
        raise SystemExit("chip mode: auto | 6581 | 8580")
    async with BleakClient(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([0x12, m]), response=True)
    print(f"SID chip mode -> {('auto (PSID flag)', '6581', '8580')[m]}"
          f" (reloads the current tune)")


async def cmd_ls(addr):
    async with BleakClient(addr) as c:
        start = 0
        names = []
        for _ in range(40):
            await c.write_gatt_char(
                DBG_CHAR,
                bytes([0x13, start & 0xFF, (start >> 8) & 0xFF]),
                response=True)
            raw = await c.read_gatt_char(DBG_CHAR)
            chunk = bytes(raw[34:95]).split(b"\0")[0].decode(errors="replace")
            names += [n for n in chunk.split("\n") if n]
            nxt = raw[95]
            if nxt == 0xFF:
                break
            start = nxt
    print("/home:")
    for n in names:
        print(f"  {n}")
    print(f"  ({len(names)} files)")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "command",
        nargs="?",
        default="status",
        choices=[
            "status", "set-time", "monitor", "audio", "click", "beep",
            "tone", "mute", "rate", "tonefreq",
        "tonestart", "tonestop", "fsformat", "sid", "sidname", "chip",
        "sidstop", "ls",
        ],
    )
    ap.add_argument(
        "--addr", default=None,
        help="BLE address; default: $SIDCLOCK_ADDR or a scan by name",
    )
    ap.add_argument(
        "value", nargs="?", type=str, default=None,
        help="rate/tone in Hz, or the file name for 'sidname'",
    )
    args = ap.parse_args()
    args.addr = asyncio.run(resolve_addr(args.addr))

    fn = {
        "status": cmd_status,
        "set-time": cmd_set_time,
        "monitor": cmd_monitor,
        "audio": cmd_audio,
        "click": lambda a: cmd_tone(a, 1),
        "beep": lambda a: cmd_tone(a, 2),
        "tone": lambda a: cmd_tone(a, 0x50),
        "mute": lambda a: cmd_tone(a, 3),
        "rate": cmd_rate,
        "tonefreq": cmd_tonefreq,
        "tonestart": cmd_tonestart,
        "tonestop": cmd_tonestop,
        "fsformat": lambda a: cmd_tone(a, 0x0D),
        "sid": cmd_sid,
        "sidname": cmd_sidname,
        "chip": cmd_chip,
        "ls": cmd_ls,
        "sidstop": lambda a: cmd_tone(a, 0x0F),
    }[args.command]
    if args.command in ("sidname", "chip"):
        asyncio.run(fn(args.addr, args.value))
    elif args.command == "set-time":
        asyncio.run(fn(args.addr, args.value))
    elif args.command in ("rate", "tonefreq", "tonestart", "sid"):
        asyncio.run(fn(args.addr,
                       int(args.value) if args.value is not None else None))
    else:
        asyncio.run(fn(args.addr))


if __name__ == "__main__":
    main()
