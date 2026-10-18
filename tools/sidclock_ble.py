#!/usr/bin/env python3
"""Talk to a SidClock device over BLE.

Device address (in order): --addr, $SIDCLOCK_ADDR, or a scan for a device
advertising as "SidClock". Discovery/connect gives up after 3 s and reports
one line; a link that drops when a command finishes is not an error.

User commands:
  status    read battery level, device time and ambient light level
  set-time  write the host's local date/time to the Current Time Service
            (optional UTC offset in hours, e.g. "set-time +2")
  monitor   poll battery + lux every 2 s until interrupted
  sid N     play /home/N.sid (N = 0..9)
  sidname S play /home/S by file name (e.g. Last_Ninja_2.sid)
  sidstop   stop SID playback
  filedelete <name>  delete a song file from /home (a .sid also removes
            its .len/.stil sidecars; config files are protected)
  chip M    SID chip model: auto (follow PSID flags) | 6581 | 8580
  engine E  SID engine (dual builds): new (cRSID) | old (cSID-light)
  ls        list the files in /home on the device
  log       print the device's SEGGER RTT log buffer (the LOG_* lines a
            debug probe would show). The lines are consumed by default;
            --peek prints the buffer without consuming it (repeatable) and
            -f/--follow keeps printing new lines until Ctrl-C (the two
            combine: show the window, then only what is new)

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
  glitch    developer: inject a fake timebase glitch (reset | fwd) to
            verify the clock guard absorbs it
  blemode   BLE access mode: rw (default) | ro (no writes / no OTA) |
            off (advertising off) - only accepted while in rw
  stacks    stack high-water marks (name, size, free): the interrupt
            stack first, then the threads in creation order - peak use
            since boot, not the current depth; flags rows with <256 B
            free (alias: threads)
  accel [dump|revive|rail]
            dump the accelerometer: WHO_AM_I at 0x18/0x19, what the
            Zephyr driver and the built-in poller return, then registers
            0x00-0x5F. "revive" reboots the chip and sweeps ODR settings;
            "rail" power-cycles the sensor rail and brings touch/ALS back
            (revive/rail only exist in SIDCLOCK_DEBUG builds)

The bring-up tests (click, beep, tone, rate, tonefreq, tonestart,
tonestop) exist only in debug builds (SIDCLOCK_DEBUG=1 ./build.sh); a
release build rejects them and this tool says so.

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
import contextlib
import os
import signal
import struct
import sys
import time

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakDeviceNotFoundError, BleakError

TONES = [1000, 2000, 4000, 8000, 10000, 12000, 15000, 18000,
         20000, 22000, 24000, 26000, 28000, 30000]
BATTERY_CHAR = "00002a19-0000-1000-8000-00805f9b34fb"  # BAS Battery Level
CTS_CHAR = "00002a2b-0000-1000-8000-00805f9b34fb"      # CTS Current Time
ILLUMINANCE_CHAR = "00002afb-0000-1000-8000-00805f9b34fb"  # ESS Illuminance
DBG_CHAR = "73696463-6c6f-4b02-9c1d-77ce3f41a5c0"      # SidClock debug
CONNECT_TIMEOUT = 3.0  # s; fail fast when the device is not advertising
LOG_CHUNK = 60        # log text bytes the 0x1E command serves per read
LOG_MAX_CHUNKS = 300  # ...so this is one 8 KB window (debug build)


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


@contextlib.contextmanager
def _sigint_graceful():
    """First Ctrl-C: let the poll loop stop; second Ctrl-C: get out by force.

    asyncio's runner cancels the main task on the first Ctrl-C, but that
    cancellation is swallowed somewhere inside bleak's read, so the command
    kept running and the BLE link stayed up (blocking the next run). A flag
    the loop checks leaves through the normal disconnect path instead; a
    second Ctrl-C raises KeyboardInterrupt as usual, for when even that is
    stuck.
    """
    state = {"stop": False}

    def handler(_signum, _frame):
        if state["stop"]:
            raise KeyboardInterrupt
        state["stop"] = True

    prev = signal.signal(signal.SIGINT, handler)
    try:
        yield lambda: state["stop"]
    finally:
        signal.signal(signal.SIGINT, prev)


@contextlib.asynccontextmanager
async def connect(addr):
    """Connect to the device, then leave quietly.

    Discovery + connect give up after CONNECT_TIMEOUT seconds with a
    one-line message instead of a traceback (a device that is off, not
    advertising, or set to BLE R/O / OFF), and the error bleak raises when
    the device has already dropped the link on the way out - a reset, BLE
    OFF, or simply the end of the command - is swallowed.
    """
    c = BleakClient(addr, timeout=CONNECT_TIMEOUT)

    try:
        await c.connect()
    except BleakDeviceNotFoundError:
        raise SystemExit(
            f"device not found: {addr} - powered on and advertising? "
            "(BLE access must be R/W)"
        )
    except (BleakError, OSError, TimeoutError) as e:
        raise SystemExit(f"could not connect to {addr}: {e}")

    try:
        yield c
    finally:
        try:
            await c.disconnect()
        except Exception:
            pass  # link already gone; nothing left to clean up


async def dbg_write(c, payload, what, test_only=False):
    """Write a debug command; report a rejection as one line.

    The bring-up test commands only exist in debug builds
    (SIDCLOCK_DEBUG=1 ./build.sh), so a release device rejects them.
    """
    try:
        await c.write_gatt_char(DBG_CHAR, payload, response=True)
    except BleakError as e:
        hint = (" - the bring-up test commands need a debug build "
                "(SIDCLOCK_DEBUG=1 ./build.sh)") if test_only else ""
        raise SystemExit(f"{what}: rejected by the device ({e}){hint}")


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
    async with connect(addr) as c:
        batt = await c.read_gatt_char(BATTERY_CHAR)
        ct = await c.read_gatt_char(CTS_CHAR)
        lux = await c.read_gatt_char(ILLUMINANCE_CHAR)
        raw = await c.read_gatt_char(DBG_CHAR)
        print(f"battery: {batt[0]} %")
        print(f"time:    {time_str(ct)}")
        print(f"lux:     {lux_u24(lux):.2f} lx")
        print(f"host:    {time.strftime('%Y-%m-%d %H:%M:%S')} (local)")
        guard = _time_guard(raw)
        if guard:
            up, grtc, glitch = guard
            print(f"guard:   {glitch} glitches, uptime {up / 3600:.1f} h, "
                  f"grtc {grtc / 3600:.1f} h")
        mode = _ble_mode(raw)
        if mode:
            print(f"ble:     {mode}")


async def cmd_set_time(addr, tz=None):
    """tz: explicit UTC offset in hours (e.g. "+2"); default: host local."""
    if tz is not None:
        t = time.gmtime(time.time() + float(tz) * 3600)
    else:
        t = time.localtime()
    async with connect(addr) as c:
        payload = time_payload(t)
        await c.write_gatt_char(CTS_CHAR, payload, response=True)
        back = await c.read_gatt_char(CTS_CHAR)
        print(f"wrote:  {time_str(payload)}")
        print(f"device: {time_str(back)}")


async def cmd_monitor(addr):
    async with connect(addr) as c:
        print("polling battery + lux + clock guard every 2 s - Ctrl-C to stop",
              flush=True)
        with _sigint_graceful() as stop:
            while not stop():
                batt = await c.read_gatt_char(BATTERY_CHAR)
                lux = await c.read_gatt_char(ILLUMINANCE_CHAR)
                raw = await c.read_gatt_char(DBG_CHAR)
                guard = _time_guard(raw)
                extra = ""
                if guard:
                    up, grtc, glitch = guard
                    extra = (f"   uptime {up / 3600:6.2f} h  "
                             f"grtc {grtc / 3600:6.2f} h  guard {glitch}")
                print(
                    f"{time.strftime('%H:%M:%S')}  battery {batt[0]:3d} %   "
                    f"lux {lux_u24(lux):9.2f}{extra}",
                    flush=True,
                )
                await asyncio.sleep(2)


async def cmd_blemode(addr, mode=None):
    """Switch BLE access mode (R/W only; R/O and OFF need the device UI or
    a reboot to undo)."""
    code = {"rw": 0, "r/w": 0, "ro": 1, "r/o": 1, "readonly": 1,
            "off": 2}.get((mode or "rw").lower())
    if code is None:
        raise SystemExit("ble mode: rw | ro | off")
    async with connect(addr) as c:
        before = await c.read_gatt_char(DBG_CHAR)
        try:
            await c.write_gatt_char(DBG_CHAR, bytes([0x15, code]),
                                    response=True)
        except Exception:
            if code != 2:
                raise  # only OFF is expected to drop the link
        await asyncio.sleep(1)
        try:
            after = await c.read_gatt_char(DBG_CHAR)
        except Exception:
            after = None  # BLE OFF drops the link immediately

    print(f"ble mode: {_ble_mode(before)} -> {_ble_mode(after)}")
    if code and _ble_mode(after) != ("R/W", "R/O", "OFF")[code]:
        print("note: undo R/O or OFF from the device screen (or reboot)")


async def cmd_glitch(addr, mode=None):
    """Developer test: fake a timebase glitch, verify the clock guard."""
    code = {"reset": 0, "jump": 0, "fwd": 1, "forward": 1}.get(
        (mode or "reset").lower())
    if code is None:
        raise SystemExit("glitch mode: reset | fwd")
    async with connect(addr) as c:
        clock_before = await c.read_gatt_char(CTS_CHAR)
        before = await c.read_gatt_char(DBG_CHAR)
        await c.write_gatt_char(DBG_CHAR, bytes([0x14, code]), response=True)
        await asyncio.sleep(1.5)  # the next clock sample trips the guard
        clock_after = await c.read_gatt_char(CTS_CHAR)
        after = await c.read_gatt_char(DBG_CHAR)
    gb, ga = _u32(before, 112), _u32(after, 112)
    print(f"glitch counter {gb} -> {ga}")
    print(f"clock:  {time_str(clock_before)}")
    print(f"     -> {time_str(clock_after)}")
    if ga <= gb:
        print("WARNING: guard did not trip (old firmware?)")
    else:
        print("guard absorbed the glitch")


def _u32(raw, off):
    return int.from_bytes(bytes(raw[off:off + 4]), "little")


def _u64(raw, off):
    return int.from_bytes(bytes(raw[off:off + 8]), "little")


def _time_guard(raw):
    """(uptime_s, grtc_s, glitches) from the debug snapshot tail."""
    if len(raw) < 128:
        return None
    return (_u64(raw, 96) / 1000.0, _u64(raw, 104) / 1e6, _u32(raw, 112))


def _ble_mode(raw):
    """'R/W' | 'R/O' | 'OFF' from the snapshot, or None (old firmware)."""
    if raw is None or len(raw) < 129 or raw[128] > 2:
        return None
    return ("R/W", "R/O", "OFF")[raw[128]]


def _rate_of(raw):
    return raw[66] | (raw[67] << 8) | (raw[68] << 16)


async def cmd_audio(addr):
    async with connect(addr) as c:
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
                      f"render {raw[13] | (raw[14] << 8)} us  title {title!r}  "
                      f"calls {raw[90] | (raw[91] << 8)}  "
                      f"frames {raw[92] | (raw[93] << 8)}")
            if len(raw) > 139:
                print(f"crash: boots {raw[129]}  cause 0x{raw[131]:02x}{raw[130]:02x}  "
                      f"audio_hb {raw[132] | (raw[133] << 8)}  "
                      f"main_hb {raw[134] | (raw[135] << 8)}  "
                      f"engine {raw[136]}")
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
    async with connect(addr) as c:
        await dbg_write(c, bytes([code]), label, test_only=code in (1, 2, 0x50))
        print(f"triggered: {label}")




async def cmd_rate(addr, hz=None):
    if hz is not None:
        if not 1000 <= hz <= 96000:
            raise SystemExit("rate must be 1000..96000 Hz")
        async with connect(addr) as c:
            await dbg_write(c,
                            bytes([0x09]) + hz.to_bytes(4, "little"),
                            "rate", test_only=True)
            raw = await c.read_gatt_char(DBG_CHAR)
            print(f"sample rate set to {_rate_of(raw)} Hz")
        return
    async with connect(addr) as c:
        await dbg_write(c, bytes([0x07]), "rate", test_only=True)
        raw = await c.read_gatt_char(DBG_CHAR)
        print(f"sample rate now {_rate_of(raw)} Hz (step {raw[10] + 1})")


async def cmd_tonefreq(addr, hz=None):
    if hz is None:
        async with connect(addr) as c:
            await dbg_write(c, bytes([0x08]), "tonefreq", test_only=True)
            raw = await c.read_gatt_char(DBG_CHAR)
            hz = TONES[raw[11]]
        rate = _rate_of(raw)
        warn = ("  (ALIASED - above Nyquist for this rate)"
                if hz * 2 >= rate else "")
        print(f"tone now {hz} Hz at {rate} Hz sample rate{warn} (2 beeps)")
        return

    if not 100 <= hz <= 30000:
        raise SystemExit("tone must be 100..30000 Hz")
    async with connect(addr) as c:
        await dbg_write(c,
                        bytes([0x0A]) + hz.to_bytes(4, "little"),
                        "tonefreq", test_only=True)
        raw = await c.read_gatt_char(DBG_CHAR)
    rate = _rate_of(raw)
    warn = ("  (ALIASED - above Nyquist for this rate)" if hz * 2 >= rate
            else "")
    print(f"tone {hz} Hz at {rate} Hz sample rate - 10 s steady{warn}")


async def cmd_tonestart(addr, hz=None):
    hz = 1000 if hz is None else hz
    if not 100 <= hz <= 30000:
        raise SystemExit("tone must be 100..30000 Hz")
    async with connect(addr) as c:
        await dbg_write(c,
                        bytes([0x0B]) + hz.to_bytes(4, "little"),
                        "tonestart", test_only=True)
    print(f"steady {hz} Hz tone started - stop with: tonestop")


async def cmd_tonestop(addr):
    async with connect(addr) as c:
        await dbg_write(c, bytes([0x0C]), "tonestop", test_only=True)
    print("tone stopped")


async def cmd_sid(addr, n=None):
    n = 0 if n is None else n
    if not 0 <= n <= 9:
        raise SystemExit("SID index must be 0..9 (/home/<n>.sid)")
    async with connect(addr) as c:
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
    async with connect(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([0x11]) + data, response=True)
        raw = await c.read_gatt_char(DBG_CHAR)
    title = bytes(raw[75:90]).split(b"\0")[0].decode(errors="replace")
    rc = raw[74] - 256 if raw[74] > 127 else raw[74]
    print(f"SID '{name}': playing={raw[72]} songs={raw[73]} rc={rc} "
          f"title={title!r}")


async def cmd_engine(addr, value=None):
    """Switch the SID engine (dual-engine builds): new (cRSID) | old (cSID)."""
    if value not in ("new", "old"):
        raise SystemExit("usage: engine new|old  (cRSID / cSID-light)")
    async with connect(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([0x17, 1 if value == "old" else 0]),
                                response=True)
        print(f"SID engine: {value}")


async def cmd_filedelete(addr, name=None):
    """Delete a song file from /home (a .sid also drops its sidecars)."""
    if not name:
        raise SystemExit("usage: filedelete <name>  (e.g. Parallax.sid)")
    names = [name]
    if name.lower().endswith(".sid"):
        names += [name[:-4] + ".len", name[:-4] + ".stil"]
    async with connect(addr) as c:
        for i, n in enumerate(names):
            data = n.encode("ascii", "replace")
            if len(data) > 20:
                raise SystemExit("file name too long (max 20 chars)")
            try:
                await c.write_gatt_char(DBG_CHAR, bytes([0x16]) + data,
                                        response=True)
                print(f"deleted: {n}")
            except Exception:
                if i == 0:
                    raise SystemExit(
                        f"could not delete {n} - missing, or not a "
                        ".sid/.len/.stil file"
                    )
                print(f"not present: {n}")


async def cmd_chip(addr, mode=None):
    modes = {"auto": 0, "6581": 1, "8580": 2}
    m = 0 if mode is None else modes.get(str(mode).lower())
    if m is None:
        raise SystemExit("chip mode: auto | 6581 | 8580")
    async with connect(addr) as c:
        await c.write_gatt_char(DBG_CHAR, bytes([0x12, m]), response=True)
    print(f"SID chip mode -> {('auto (PSID flag)', '6581', '8580')[m]}"
          f" (reloads the current tune)")


def _rtt_chunk(raw):
    """Log text from a snapshot read served by the 0x1E debug command."""
    if len(raw) < 96 or raw[34] != 0x1E:
        return None
    return bytes(raw[36:36 + min(raw[35], LOG_CHUNK)])


async def _log_chunk(c, mode):
    """One log chunk; exit in one line when the device does not serve 0x1E."""
    await dbg_write(c, bytes([0x1E, mode]), "log")
    raw = await c.read_gatt_char(DBG_CHAR)
    text = _rtt_chunk(raw)
    if text is None:
        raise SystemExit("log: unexpected snapshot (old firmware?)")
    return text


def _log_lines(pending, data, last):
    """(text to print, leftover) for `data` appended to a half line.

    Lines end in "\\n" (the RTT backend writes CRLF; the CR is dropped). An
    incomplete last line is kept for the next chunk, unless `last` says to
    print it as it is.
    """
    pending += data
    lines, sep, pending = pending.rpartition(b"\n")
    if not sep and last and pending:
        lines, sep, pending = pending, b"\n", b""
    if not sep:
        return b"", pending
    return lines.replace(b"\r", b"") + b"\n", pending


async def _pull_log(c, emit, first_mode=0, next_mode=0, stop=lambda: False):
    """Feed the device's RTT window to `emit`; True when it was drained."""
    mode = first_mode
    for _ in range(LOG_MAX_CHUNKS):
        if stop():
            return False
        text = await _log_chunk(c, mode)
        if not text:
            return True
        emit(text)
        mode = next_mode
    return False


async def cmd_log(addr, peek=False, follow=False):
    """Print the device's SEGGER RTT log buffer (debug command 0x1E).

    The firmware serves its unread RTT window 60 bytes at a time. Those
    bytes are *consumed* by default: once printed the device forgets them,
    so the next `log` only shows what was logged since. --peek copies the
    window without touching the device's read pointer, so the call can be
    repeated (and a later `log` still sees it); with --peek -f only what is
    new since the last poll is printed, also without consuming.
    -f/--follow keeps polling until interrupted (Ctrl-C).

    The buffer runs in overwrite mode (app/prj.conf), so it always holds
    the newest lines and its first line can be a fragment of one whose
    start was overwritten - that partial line is printed as it is.
    """
    async with connect(addr) as c:
        pending = b""

        def emit(data, last=False):
            nonlocal pending
            text, pending = _log_lines(pending, data, last)
            if text:
                sys.stdout.write(text.decode(errors="replace"))
                sys.stdout.flush()

        async def pull(first_mode, next_mode, stop):
            """Fetch chunks (0 = consume, 1 = restart peek, 2 = continue);
            True when the window was drained."""
            return await _pull_log(c, emit, first_mode, next_mode, stop)

        first = 1 if peek else 0
        cont = 2 if peek else 0
        with _sigint_graceful() as stop:
            if follow:
                if peek:
                    await pull(first, cont, stop)  # window, then follow it
                while not stop():
                    if await pull(cont, cont, stop):
                        await asyncio.sleep(0.2)
            else:
                if not await pull(first, cont, stop) and not stop():
                    print("log: more is buffered (run log again)",
                          file=sys.stderr)
                emit(b"", last=True)


async def cmd_accel(addr, mode=None):
    """Dump the accelerometer's register file (debug command 0x1F).

    The device logs WHO_AM_I at both possible I2C addresses, what the Zephyr
    driver and the built-in poller each return, and registers 0x00-0x5F.
    Modes: none/dump (read only), revive (reboot the chip and sweep ODR
    settings), rail (power-cycle the sensor rail and bring touch/ALS back).
    revive/rail are only compiled into SIDCLOCK_DEBUG builds.
    """
    code = {"revive": 1, "1": 1, "rail": 2, "2": 2}.get(
        (mode or "").lower() or "0", 0)
    async with connect(addr) as c:
        pending = b""

        def emit(data, last=False):
            nonlocal pending
            text, pending = _log_lines(pending, data, last)
            if text:
                sys.stdout.write(text.decode(errors="replace"))
                sys.stdout.flush()

        payload = bytes([0x1F]) if code == 0 else bytes([0x1F, code])
        await dbg_write(c, payload, "accel")
        await _pull_log(c, emit)
        emit(b"", last=True)


async def cmd_ls(addr):
    async with connect(addr) as c:
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


async def _poll_marker(c, marker):
    """Poll the snapshot until the deferred op serves its marker."""
    for _ in range(15):
        await asyncio.sleep(1)
        raw = await c.read_gatt_char(DBG_CHAR)
        if len(raw) < 96:
            raise SystemExit("short snapshot (old firmware?)")
        if raw[34] == marker:
            return raw
    raise SystemExit("op not served (retry)")


async def cmd_stacks(addr, value=None):
    """Stack high-water marks: the interrupt stack first, then the threads."""
    async with connect(addr) as c:
        raws = []
        for page in range(4):  # firmware caps the listing at 3 pages
            payload = bytes([0x1D]) if page == 0 else bytes([0x1D, page])
            await c.write_gatt_char(DBG_CHAR, payload, response=True)
            raw = await _poll_marker(c, 0x1D)
            raws.append(raw)
            if not _stacks_more(raw[35], page):
                break
    rows = _parse_stack_pages(raws)
    print(f"stacks: {len(rows)} rows (interrupt stack, then threads "
          f"in creation order)")
    wid = max((len(name) for name, _, _ in rows), default=4)
    for i, (name, size, free) in enumerate(rows):
        used = size - free
        flag = "  <-- LOW!" if free < 256 else ""
        print(f"  [{i}] {name:<{wid}}  size {size:5d}  free {free:5d}  "
              f"used {used:5d} ({100 * used // size} %){flag}")


def _stacks_more(page_byte, page):
    """Whether another 0x1D page should be requested.

    Bit 6 of the page byte in [35] marks the last page (firmware that has
    the interrupt stack row); older firmware leaves it clear, and then the
    named layout has 3 pages and the pre-name layout 2.
    """
    if page_byte & 0x40:
        return False
    return page + 1 < (3 if page_byte & 0x80 else 2)


def _parse_stack_pages(raws):
    """(name, size, free) rows from the 0x1D snapshot pages.

    Names live in bytes [52..95] as 11-byte fields, aligned with the
    (size, free) pairs at [36..51], 4 rows per page; bit 7 of the page
    byte in [35] marks that layout. Row 0 of the listing is the interrupt
    stack (named "ISR0" by the firmware); the threads follow in creation
    order. A firmware that predates the names keeps the 5-per-page pairs
    at [36..55] and leaves non-text bytes where the names would be, so
    those rows are labelled by position instead.
    """
    rows = []
    for page, raw in enumerate(raws):
        named = bool(raw[35] & 0x80)
        per = 4 if named else 5
        for i in range(per):
            size = raw[36 + 4 * i] | (raw[37 + 4 * i] << 8)
            free = raw[38 + 4 * i] | (raw[39 + 4 * i] << 8)
            if size == 0:
                continue
            name = f"#{per * page + i}"
            if named:
                label = raw[52 + 11 * i:63 + 11 * i].split(b"\0")[0]
                if label:
                    name = label.decode("ascii", "replace").strip()
            rows.append((name, size, free))
    return rows


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
        "sidstop", "ls", "glitch", "blemode", "filedelete",
        "engine", "stacks", "threads", "log", "accel",
        ],
    )
    ap.add_argument(
        "--addr", default=None,
        help="BLE address; default: $SIDCLOCK_ADDR or a scan by name",
    )
    ap.add_argument(
        "--peek", action="store_true",
        help="'log': print the buffer without consuming it (repeatable)",
    )
    ap.add_argument(
        "-f", "--follow", action="store_true",
        help="'log': keep printing new lines until interrupted",
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
        "glitch": cmd_glitch,
        "blemode": cmd_blemode,
        "filedelete": cmd_filedelete,
        "engine": cmd_engine,
        "stacks": cmd_stacks,
        "threads": cmd_stacks,  # alias for the old name
        "log": cmd_log,
        "accel": cmd_accel,
    }[args.command]
    if args.command == "log":
        asyncio.run(fn(args.addr, args.peek, args.follow))
    elif args.command == "accel":
        asyncio.run(fn(args.addr, args.value))
    elif args.command in ("sidname", "chip", "filedelete", "engine",
                          "stacks", "threads"):
        asyncio.run(fn(args.addr, args.value))
    elif args.command == "set-time":
        asyncio.run(fn(args.addr, args.value))
    elif args.command in ("glitch", "blemode"):
        asyncio.run(fn(args.addr, args.value))
    elif args.command in ("rate", "tonefreq", "tonestart", "sid"):
        asyncio.run(fn(args.addr,
                       int(args.value) if args.value is not None else None))
    else:
        asyncio.run(fn(args.addr))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()  # e.g. Ctrl-C in 'monitor': exit without a traceback
        sys.exit(130)
