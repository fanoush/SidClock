#!/usr/bin/env python3
"""Talk to a SidClock device over BLE.

Device address (in order): --addr, $SIDCLOCK_ADDR, or a scan for a device
advertising as "SidClock". Discovery/connect gives up after 3 s and reports
one line; a link that drops when a command finishes is not an error.

User commands:
  status    read battery level, device time and ambient light level
  protocol  show which wire protocol the device speaks: firmware, protocol
            and layout ids, capability bits and which commands this tool
            has to disable for it
  set-time  write the host's local date/time to the Current Time Service
            (optional UTC offset in hours, e.g. "set-time +2")
  monitor   poll battery + lux every 2 s until interrupted
  sid N     play /home/N.sid (N = 0..9), optionally at subtune --sub M
  sidname S play /home/S by file name (e.g. Last_Ninja_2.sid), same
  sidstop   stop SID playback
  playpause toggle play/pause (a paused tune resumes where it stopped)
  next/prev play the next/previous tune in file name order
  subnext / subprev  step to the next/previous subtune
  subplay N start subtune N (1-based) of the loaded tune; 255 = the
            PSID startSong
  state     read the player status: tune, subtune, position, modes
  watch     follow the player state notifications until Ctrl-C (tune
            changes, transport, position once per second)
  filedelete <name>  delete a song file from /home (a .sid also removes
            its .len/.stil sidecars; config files are protected)
  chip M    SID chip model: auto (follow PSID flags) | 6581 | 8580
  endmode M end-of-tune mode: nextsub | nexttune | loop (the SID screen
            END button; takes effect at the next song end)
  engine E  SID engine (dual builds): new (cRSID) | old (cSID-light)
  volume [N] software volume 0-255 (the VOL slider; no value = read it)
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
  fsformat  DESTRUCTIVE: format the /home LittleFS partition (asks for an
            explicit "yes"; -y skips the question and is required when stdin
            is not a terminal)
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

Uploading SID tunes (names up to 23 characters, played in file name order by
the device):
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

import protocol

TONES = [1000, 2000, 4000, 8000, 10000, 12000, 15000, 18000,
         20000, 22000, 24000, 26000, 28000, 30000]
BATTERY_CHAR = "00002a19-0000-1000-8000-00805f9b34fb"  # BAS Battery Level
CTS_CHAR = "00002a2b-0000-1000-8000-00805f9b34fb"      # CTS Current Time
ILLUMINANCE_CHAR = "00002afb-0000-1000-8000-00805f9b34fb"  # ESS Illuminance
CONNECT_TIMEOUT = 3.0  # s; fail fast when the device is not advertising
LOG_MAX_CHUNKS = 300  # 300 x 60 bytes = one 8 KB RTT window

# Selected when a connection is made (see _detect_protocol). Every command
# reads UUIDs, offsets, opcodes and limits from it, so the tool follows the
# connected firmware instead of assuming the newest release.
DEV = None


def lux_u24(raw):
    """Illuminance is uint24 little-endian, 0.01 lx per unit."""
    return int.from_bytes(bytes(raw), "little") * 0.01


def time_payload(t, ms=0):
    """Standard Current Time (0x2A2B) value: 10 bytes, year little-endian.
    The fraction byte (1/256 s) carries the milliseconds so the device does
    not snap its clock to the whole second."""
    return struct.pack(
        "<HBBBBBBBB",
        t.tm_year,
        t.tm_mon,
        t.tm_mday,
        t.tm_hour,
        t.tm_min,
        t.tm_sec,
        (t.tm_wday % 7) + 1,
        min(255, round(ms * 256 / 1000)),
        0,
    )


def time_str(raw):
    year, mon, day, hh, mm, ss, dow, frac, _reason = struct.unpack(
        "<HBBBBBBBB", bytes(raw)
    )
    return (f"{year:04d}-{mon:02d}-{day:02d} {hh:02d}:{mm:02d}:{ss:02d}"
            f".{(frac * 1000 + 128) // 256:03d} (dow {dow})")


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


async def _device_chars(c):
    """Map lower-case characteristic UUID -> bleak characteristic object."""
    services = getattr(c, "services", None)
    if services is None:
        getter = getattr(c, "get_services", None)
        if getter is not None:
            services = await getter()
    chars = {}
    for svc in services or []:
        for ch in getattr(svc, "characteristics", []) or []:
            chars[ch.uuid.lower()] = ch
    return chars


async def _detect_protocol(c):
    """Select the descriptor that matches the connected firmware.

    A 1.0.11+ device answers the hello read exactly; older firmware is
    identified by which characteristics exist plus the size of the debug
    value (see the legacy block in protocol/*.json).
    """
    chars = await _device_chars(c)
    present = {name for name, uuid in (
        ("debug", protocol.DEBUG_UUID),
        ("state", protocol.STATE_UUID),
        ("info", protocol.INFO_UUID),
        ("hello", protocol.HELLO_UUID)) if uuid in chars}
    if "debug" not in present:
        raise SystemExit(
            "protocol: the device exposes no SidClock debug characteristic - "
            "is this a SidClock, and is BLE access R/W?")
    hello = None
    if "hello" in present:
        try:
            hello = await c.read_gatt_char(protocol.HELLO_UUID)
        except (BleakError, AttributeError) as e:
            # A characteristic whose value cannot be read says nothing about
            # the layout: fall through to the legacy probe without it.
            print(f"protocol: hello read failed ({e}); falling back to the "
                  "legacy probe", file=sys.stderr)
    if hello is not None:
        try:
            desc, notes = protocol.select_for_hello(hello)
        except protocol.ProtocolError as e:
            raise SystemExit(f"protocol: {e}")
    else:
        probe = present - {"hello"}
        size = None
        try:
            size = len(await c.read_gatt_char(protocol.DEBUG_UUID))
        except (BleakError, AttributeError):
            pass
        desc, notes = protocol.select_legacy(probe, size)
        if desc is None:
            raise SystemExit(
                "protocol: unrecognised legacy device layout "
                f"(characteristics: {', '.join(sorted(probe))}, "
                f"debug {size or '?'} bytes)")
    desc.notes = notes
    return desc


@contextlib.asynccontextmanager
async def connect(addr):
    """Connect to the device, select its protocol, then leave quietly.

    Discovery + connect give up after CONNECT_TIMEOUT seconds with a
    one-line message instead of a traceback (a device that is off, not
    advertising, or set to BLE R/O / OFF), and the error bleak raises when
    the device has already dropped the link on the way out - a reset, BLE
    OFF, or simply the end of the command - is swallowed.
    """
    global DEV
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
        DEV = await _detect_protocol(c)
        for note in DEV.notes:
            print(f"protocol: {note}", file=sys.stderr)
        yield c
    finally:
        DEV = None
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
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
    except BleakError as e:
        hint = (" - the bring-up test commands need a debug build "
                "(SIDCLOCK_DEBUG=1 ./build.sh)") if test_only else ""
        raise SystemExit(f"{what}: rejected by the device ({e}){hint}")


def snap(raw, area, name, default=None):
    """Read a descriptor field from a device value, or `default` when the
    connected firmware predates that field."""
    if not DEV.has_field(area, name):
        return default
    return DEV.int(raw, area, name)


def snap_text(raw, area, name, default=""):
    if not DEV.has_field(area, name):
        return default
    return DEV.text(raw, area, name)


def has(area, name):
    return DEV.has_field(area, name)


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


async def cmd_protocol(addr):
    """Describe the wire protocol the connected device speaks.

    Every tool command is driven by the descriptor picked here, so this is
    the one place that answers "why is feature X missing?": a hello device
    selects by protocol+layout, an older one by the legacy probe.
    """
    async with connect(addr) as c:
        hello = None
        if DEV.has_char("hello"):
            raw = await c.read_gatt_char(DEV.char("hello"))
            try:
                hello = protocol.parse_hello(raw)
            except protocol.ProtocolError:
                hello = None

        # Everything below reads DEV (and reloads the index); print while
        # the link is still up, like status does.
        print(f"firmware: {DEV.firmware}  (protocol {DEV.protocol}, "
              f"{'hello' if DEV.source == 'hello' else 'legacy probe'})")
        if hello:
            print(f"hello:    protocol {hello['protocol']}  layout "
                  f"0x{hello['layout']:04x}  caps 0x{hello['caps']:08x}")
            build = [n for n, on in (("debug", hello["debug"]),
                                     ("legacy engine", hello["legacy_engine"]),
                                     ("split engine", hello["split_engine"]))
                     if on]
            print(f"build:    {', '.join(build) if build else 'release'}")
        for note in DEV.notes:
            print(f"note:     {note}")
        index = protocol.load_index()
        newest = protocol.load_descriptor(index["latest"])
        missing = sorted(newest.features - DEV.features)
        print(f"features: {len(DEV.features)} of {len(newest.features)} "
              f"({newest.firmware} has the rest)")
        if missing:
            print(f"disabled: {', '.join(missing)}")


async def cmd_status(addr):
    async with connect(addr) as c:
        batt = await c.read_gatt_char(BATTERY_CHAR)
        ct = await c.read_gatt_char(CTS_CHAR)
        lux = await c.read_gatt_char(ILLUMINANCE_CHAR)
        raw = await c.read_gatt_char(DEV.char("debug"))
        print(f"firmware: {DEV.firmware}  (protocol {DEV.protocol}, "
              f"{'hello' if DEV.source == 'hello' else 'legacy probe'})")
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
        fs = _fs_state(raw)
        if fs is not None:
            mounted, err = fs
            if mounted:
                print("fs:      /home mounted")
            else:
                print(f"fs:      /home NOT mounted (mount error -{err}) - "
                      "corrupt or not formatted; 'fsformat' recreates it")


async def cmd_set_time(addr, tz=None):
    """tz: explicit UTC offset in hours (e.g. "+2"); default: host local."""
    async with connect(addr) as c:
        # One quick round trip to estimate the link delay: the payload has
        # to carry the time at which the write *arrives*, not the time it
        # was built, or the device ends up one link delay behind.
        t0 = time.monotonic()
        await c.read_gatt_char(CTS_CHAR)
        rtt = time.monotonic() - t0
        now = time.time() + rtt / 2
        if tz is not None:
            t = time.gmtime(now + float(tz) * 3600)
        else:
            t = time.localtime(now)
        payload = time_payload(t, int((now % 1) * 1000))
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
                raw = await c.read_gatt_char(DEV.char("debug"))
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
    async with connect(addr) as c:
        try:
            code = DEV.value("ble_mode", mode or "rw")
        except protocol.ProtocolError:
            raise SystemExit("ble mode: rw | ro | off")
        before = await c.read_gatt_char(DEV.char("debug"))
        try:
            await c.write_gatt_char(DEV.char("debug"),
                                    DEV.build("set_ble_mode", code),
                                    response=True)
        except Exception:
            if code != 2:
                raise  # only OFF is expected to drop the link
        await asyncio.sleep(1)
        try:
            after = await c.read_gatt_char(DEV.char("debug"))
        except Exception:
            after = None  # BLE OFF drops the link immediately

    print(f"ble mode: {_ble_mode(before)} -> {_ble_mode(after)}")
    if code and _ble_mode(after) != ("R/W", "R/O", "OFF")[code]:
        print("note: undo R/O or OFF from the device screen (or reboot)")


def _flpr(raw):
    """(heartbeat, alive, rendering) from the snapshot, or None (old fw)."""
    if not has("snapshot", "flpr_heartbeat"):
        return None
    hb = snap(raw, "snapshot", "flpr_heartbeat")
    flags = snap(raw, "snapshot", "flpr_flags")
    alive = DEV.snapshot_flags().get("flpr_alive", 0x01)
    rendering = DEV.snapshot_flags().get("flpr_rendering", 0x02)
    return (hb, bool(flags & alive), bool(flags & rendering))


async def cmd_flpr(addr, mode=None):
    """Start/stop the FLPR bare-metal blob (R/W only)."""
    code = {"start": 1, "stop": 0}.get((mode or "start").lower())
    if code is None:
        raise SystemExit("flpr mode: start | stop")
    async with connect(addr) as c:
        try:
            payload = DEV.build("flpr", code)
        except protocol.Unsupported as e:
            raise SystemExit(f"flpr: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
        await asyncio.sleep(1.5)
        after = await c.read_gatt_char(DEV.char("debug"))
    hb = _flpr(after)
    if hb is None:
        print("no FLPR telemetry (old firmware?)")
    else:
        print(f"flpr: {'start' if code else 'stop'} -> "
              f"heartbeat {hb[0]}, alive {hb[1]}, rendering {hb[2]}")


async def cmd_flpralu(addr, value=None):
    """Core-speed probe on the blob: N register-only loop iterations."""
    try:
        n = int(value or 100000)
    except ValueError:
        raise SystemExit("flpralu [ITERATIONS]")
    if not 1 <= n <= 65000:
        raise SystemExit("flpralu [ITERATIONS]")
    async with connect(addr) as c:
        try:
            payload = DEV.build("flpralu", n)
        except protocol.Unsupported as e:
            raise SystemExit(f"flpralu: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
        await asyncio.sleep(0.5)
        after = await c.read_gatt_char(DEV.char("debug"))
    cyc = snap(after, "snapshot", "flpr_bench_cycles", 0)
    if not cyc:
        print("no probe telemetry (old firmware?)")
        return
    ins = snap(after, "snapshot", "flpr_bench_instr", 0)
    us = snap(after, "snapshot", "flpr_bench_us", 0)
    print(f"flpralu {n} iter: {cyc} cycles, {ins} instr, "
          f"IPC {ins / cyc:.2f}, clock ~{cyc / us:.0f} MHz")


async def cmd_glitch(addr, mode=None):
    """Developer test: fake a timebase glitch, verify the clock guard."""
    code = {"reset": 0, "jump": 0, "fwd": 1, "forward": 1}.get(
        (mode or "reset").lower())
    if code is None:
        raise SystemExit("glitch mode: reset | fwd")
    async with connect(addr) as c:
        clock_before = await c.read_gatt_char(CTS_CHAR)
        before = await c.read_gatt_char(DEV.char("debug"))
        await c.write_gatt_char(DEV.char("debug"),
                                DEV.build("glitch", code), response=True)
        await asyncio.sleep(1.5)  # the next clock sample trips the guard
        clock_after = await c.read_gatt_char(CTS_CHAR)
        after = await c.read_gatt_char(DEV.char("debug"))
    gb = snap(before, "snapshot", "time_glitches", 0)
    ga = snap(after, "snapshot", "time_glitches", 0)
    print(f"glitch counter {gb} -> {ga}")
    print(f"clock:  {time_str(clock_before)}")
    print(f"     -> {time_str(clock_after)}")
    if ga <= gb:
        print("WARNING: guard did not trip (old firmware?)")
    else:
        print("guard absorbed the glitch")


def _time_guard(raw):
    """(uptime_s, grtc_s, glitches) from the debug snapshot tail."""
    if not has("snapshot", "uptime_ms"):
        return None
    return (snap(raw, "snapshot", "uptime_ms") / 1000.0,
            snap(raw, "snapshot", "grtc_cycles") / 1e6,
            snap(raw, "snapshot", "time_glitches"))


def _value_label(set_name, value, default=None):
    for item in DEV.value_items(set_name):
        if item["value"] == value:
            return item.get("label", item["name"])
    return str(value) if default is None else default


def _ble_mode(raw):
    """'R/W' | 'R/O' | 'OFF' from the snapshot, or None (old firmware)."""
    if raw is None or not has("snapshot", "ble_mode"):
        return None
    value = snap(raw, "snapshot", "ble_mode")
    if value > 2:
        return None
    return _value_label("ble_mode", value)


def _fs_state(raw):
    """(mounted, err) from the snapshot, or None (old firmware)."""
    if raw is None or not has("snapshot", "fs_state"):
        return None
    return snap(raw, "snapshot", "fs_state") == 0, snap(raw, "snapshot",
                                                        "fs_err")


def _player_state(raw):
    """Decode the state value, or None if the read looks wrong."""
    if raw is None or not has("state", "flags"):
        return None
    if len(raw) < DEV.char_size("state"):
        return None
    flags = snap(raw, "state", "flags")
    f = DEV.state_flags()
    return {
        "playing": bool(flags & f.get("playing", 0x01)),
        "paused": bool(flags & f.get("paused", 0x02)),
        "sound": bool(flags & f.get("sound", 0x04)),
        "legacy": bool(flags & f.get("legacy_engine", 0x08)),
        "split": bool(flags & f.get("split_engine", 0x00)),
        # 0-based on the wire, 1-based in every print
        "subtune": snap(raw, "state", "subtune"),
        "songs": snap(raw, "state", "songs"),
        "end": snap(raw, "state", "end_mode"),
        "model": snap(raw, "state", "model_mode"),
        "chip": snap(raw, "state", "chip"),
        "gen": snap(raw, "state", "generation"),
        "volume": snap(raw, "state", "volume", 0),
        "elapsed": snap(raw, "state", "elapsed"),
        "length": snap(raw, "state", "length"),
    }


def _player_info(raw):
    info = {
        "title": snap_text(raw, "info", "title") if raw is not None else "",
        "name": snap_text(raw, "info", "name") if raw is not None else "",
        "author": snap_text(raw, "info", "author") if raw is not None else "",
        "id": None,
    }
    if raw is not None and has("info", "md5_id"):
        text = snap_text(raw, "info", "md5_id").lower()
        if len(text) == 8 and all(ch in "0123456789abcdef" for ch in text) \
                and text != "00000000":
            info["id"] = text
    return info


def _state_words(st):
    if st["playing"]:
        return "paused" if st["paused"] else "playing"
    return "loaded (stopped)" if st["songs"] else "idle (no tune)"


def _state_pos(st):
    return f"{st['elapsed']} s" + (f"/{st['length']} s" if st["length"] else "")


def _end_label(st):
    return _value_label("end_mode", st["end"])


def _model_label(st):
    return _value_label("model_mode", st["model"])


async def _read_char(c, uuid, what):
    """Read a player-status characteristic; a clear line on old firmware."""
    try:
        return bytes(await c.read_gatt_char(uuid))
    except (BleakError, AttributeError) as e:
        raise SystemExit(
            f"{what}: characteristic not found ({e}) - firmware "
            f"{DEV.firmware} does not provide it"
        )


async def _maybe_state(c):
    """Player state value, or None when the firmware predates the char."""
    if not DEV.has_char("state"):
        return None
    try:
        return _player_state(bytes(await c.read_gatt_char(DEV.char("state"))))
    except (BleakError, AttributeError):
        return None


async def _settle_player(c, before, timeout=2.0):
    """Wait for a parked player command to land.

    The device runs player commands in its main loop (the GATT callback's
    stack cannot hold the tune loader), so a snapshot read right after the
    write can still show the old tune. Wait for the generation byte to
    move or the elapsed time to restart.
    """
    if before is None:
        return
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        st = await _maybe_state(c)
        if st is None:
            return
        if st["gen"] != before["gen"] or st["elapsed"] < before["elapsed"]:
            return
        await asyncio.sleep(0.1)


def _rate_of(raw):
    return snap(raw, "snapshot", "cfg_rate", 0)


async def cmd_audio(addr):
    async with connect(addr) as c:
        raw = await c.read_gatt_char(DEV.char("debug"))
        print(f"ready {snap(raw, 'snapshot', 'audio_ready')}  "
              f"init_rc {snap(raw, 'snapshot', 'audio_init_rc')}  "
              f"enabled {snap(raw, 'snapshot', 'audio_enabled')}  "
              f"volume {snap(raw, 'snapshot', 'audio_volume')}  "
              f"asleep {snap(raw, 'snapshot', 'audio_spare5')}")
        under = snap(raw, "snapshot", "pipe_underruns", 0)
        active = snap(raw, "snapshot", "pipe_active", 0)
        if under or active:
            print(f"flpr: rendering {active}  underruns {under}")
        print(f"play attempts {snap(raw, 'snapshot', 'play_attempts')}  "
              f"tone buffers left {snap(raw, 'snapshot', 'tone_buffers')}  "
              f"combo {snap(raw, 'snapshot', 'amp_combo')} "
              f"(flags 0x{snap(raw, 'snapshot', 'combo_flags'):02x})")
        print(f"PSEL sck 0x{snap(raw, 'snapshot', 'i2s_psel_sck'):08x}  "
              f"sdout 0x{snap(raw, 'snapshot', 'i2s_psel_sdout'):08x}  "
              f"mck 0x{snap(raw, 'snapshot', 'i2s_psel_mck'):08x}")
        print(f"enable {snap(raw, 'snapshot', 'i2s_enable')}  "
              f"txen {snap(raw, 'snapshot', 'i2s_txen')}")
        if has("snapshot", "diag_peak"):
            print(f"buffers: peak {snap(raw, 'snapshot', 'diag_peak')}   "
                  f"w0 0x{snap(raw, 'snapshot', 'diag_dma0_word0'):08x}  "
                  f"w1 0x{snap(raw, 'snapshot', 'diag_dma1_word0'):08x}")
            print(f"dma events {snap(raw, 'snapshot', 'diag_dma_consumed')}  "
                  f"mck 0x{snap(raw, 'snapshot', 'i2s_mckfreq'):08x}  "
                  f"ratio {snap(raw, 'snapshot', 'i2s_ratio')}  "
                  f"width {snap(raw, 'snapshot', 'i2s_swidth')}  "
                  f"ch {snap(raw, 'snapshot', 'i2s_channels')}  "
                  f"align {snap(raw, 'snapshot', 'i2s_align')}")
            print(f"buserr0 0x{snap(raw, 'snapshot', 'i2s_buserr0'):08x}  "
                  f"buserr1 0x{snap(raw, 'snapshot', 'i2s_buserr1'):08x}")
        if has("snapshot", "sid_playing"):
            print(f"sid playing {snap(raw, 'snapshot', 'sid_playing')}  "
                  f"songs {snap(raw, 'snapshot', 'sid_songs')}  "
                  f"rc {snap(raw, 'snapshot', 'sid_last_rc')}  "
                  f"render {snap(raw, 'snapshot', 'render_us')} us  "
                  f"title {snap_text(raw, 'snapshot', 'sid_title')!r}  "
                  f"calls {snap(raw, 'snapshot', 'sid_render_calls')}  "
                  f"frames {snap(raw, 'snapshot', 'sid_frame_calls')}")
            if has("snapshot", "flpr_split") and \
                    snap(raw, "snapshot", "flpr_split") == 1:
                load = snap(raw, "snapshot", "flpr_health_cpu_load")
                lmin = snap(raw, "snapshot", "flpr_health_lead_min")
                lcur = snap(raw, "snapshot", "flpr_health_lead")
                starved = snap(raw, "snapshot", "flpr_health_starved")
                lms = "n/a" if lmin == 0xFFFF else str(lmin)
                print(f"split: flpr cpu {load / 10:.1f}%  "
                      f"lead {lcur} (min {lms})  starved {starved}")
        if has("snapshot", "boots"):
            print(f"crash: boots {snap(raw, 'snapshot', 'boots')}  "
                  f"cause 0x{snap(raw, 'snapshot', 'reset_cause_hi'):02x}"
                  f"{snap(raw, 'snapshot', 'reset_cause_lo'):02x}  "
                  f"audio_hb {snap(raw, 'snapshot', 'audio_hb')}  "
                  f"main_hb {snap(raw, 'snapshot', 'main_hb')}  "
                  f"engine {snap(raw, 'snapshot', 'engine')}")
        if has("snapshot", "flpr_bench_cycles") and \
                snap(raw, "snapshot", "flpr_bench_cycles"):
            cyc = snap(raw, "snapshot", "flpr_bench_cycles")
            ins = snap(raw, "snapshot", "flpr_bench_instr")
            us = snap(raw, "snapshot", "flpr_bench_us")
            ipc = ins / cyc if cyc else 0
            mhz = cyc / us if us else 0
            print(f"flpr bench: {us} us  {cyc} cycles  {ins} instr  "
                  f"IPC {ipc:.2f}  clock ~{mhz:.0f} MHz")
        if has("snapshot", "cfg_rate"):
            step = snap(raw, "snapshot", "rate_index")
            mode = "direct" if step == 0xFF else f"step {step}"
            print(f"{mode}  rate {_rate_of(raw)} Hz")


async def cmd_tone(addr, name):
    """Bare-opcode developer sounds: click, beep, long_tone."""
    label = {
        "click": "click",
        "beep": "beep",
        "long_tone": "1 s steady test tone",
    }.get(name, name)
    async with connect(addr) as c:
        try:
            payload = DEV.build(name)
        except protocol.Unsupported as e:
            raise SystemExit(f"{name}: {e}")
        await dbg_write(c, payload, name, test_only=True)
        print(f"triggered: {label}")


async def cmd_fsformat(addr, yes=False):
    """DESTRUCTIVE: erase /home and recreate a fresh LittleFS partition."""
    if not _confirm(
            "fsformat erases /home: every tune, the settings, the alarms and "
            "the saved clock are gone and cannot be recovered.", yes):
        raise SystemExit("aborted - nothing was formatted")
    async with connect(addr) as c:
        await dbg_write(c, DEV.build("fsformat"), "format /home")
        raw = await c.read_gatt_char(DEV.char("debug"))
    state = _fs_state(raw)
    if state is None:
        print("formatted (this firmware does not report the filesystem state)")
    elif state[0]:
        print("formatted: /home mounted")
    else:
        print(f"formatted, but /home is still not mounted "
              f"(mount error -{state[1]})")


def _confirm(question, assume_yes):
    """Guard for destructive commands.

    A stdin that is not a terminal is refused unless --yes was given, so a
    script cannot wipe the device by accident.
    """
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        raise SystemExit(f"{question}\nrefusing without a terminal to confirm "
                         "on - pass -y to say yes non-interactively")
    print(question)
    try:
        ans = input("Type 'yes' to continue, anything else aborts: ")
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return ans.strip().lower() in ("yes", "y")


async def cmd_rate(addr, hz=None):
    if hz is not None:
        if not 1000 <= hz <= 96000:
            raise SystemExit("rate must be 1000..96000 Hz")
        async with connect(addr) as c:
            try:
                payload = DEV.build("set_rate", hz)
            except protocol.Unsupported as e:
                raise SystemExit(f"rate: {e}")
            await dbg_write(c, payload, "rate", test_only=True)
            raw = await c.read_gatt_char(DEV.char("debug"))
            print(f"sample rate set to {_rate_of(raw)} Hz")
        return
    async with connect(addr) as c:
        try:
            payload = DEV.build("rate_next")
        except protocol.Unsupported as e:
            raise SystemExit(f"rate: {e}")
        await dbg_write(c, payload, "rate", test_only=True)
        raw = await c.read_gatt_char(DEV.char("debug"))
        print(f"sample rate now {_rate_of(raw)} Hz "
              f"(step {snap(raw, 'snapshot', 'rate_index') + 1})")


async def cmd_tonefreq(addr, hz=None):
    if hz is None:
        async with connect(addr) as c:
            try:
                payload = DEV.build("tone_next")
            except protocol.Unsupported as e:
                raise SystemExit(f"tonefreq: {e}")
            await dbg_write(c, payload, "tonefreq", test_only=True)
            raw = await c.read_gatt_char(DEV.char("debug"))
            hz = TONES[snap(raw, "snapshot", "tone_index") % len(TONES)]
        rate = _rate_of(raw)
        warn = ("  (ALIASED - above Nyquist for this rate)"
                if hz * 2 >= rate else "")
        print(f"tone now {hz} Hz at {rate} Hz sample rate{warn} (2 beeps)")
        return

    if not 100 <= hz <= 30000:
        raise SystemExit("tone must be 100..30000 Hz")
    async with connect(addr) as c:
        try:
            payload = DEV.build("tone_10s", hz)
        except protocol.Unsupported as e:
            raise SystemExit(f"tonefreq: {e}")
        await dbg_write(c, payload, "tonefreq", test_only=True)
        raw = await c.read_gatt_char(DEV.char("debug"))
    rate = _rate_of(raw)
    warn = ("  (ALIASED - above Nyquist for this rate)" if hz * 2 >= rate
            else "")
    print(f"tone {hz} Hz at {rate} Hz sample rate - 10 s steady{warn}")


async def cmd_tonestart(addr, hz=None):
    hz = 1000 if hz is None else hz
    if not 100 <= hz <= 30000:
        raise SystemExit("tone must be 100..30000 Hz")
    async with connect(addr) as c:
        try:
            payload = DEV.build("tone_hold", hz)
        except protocol.Unsupported as e:
            raise SystemExit(f"tonestart: {e}")
        await dbg_write(c, payload, "tonestart", test_only=True)
    print(f"steady {hz} Hz tone started - stop with: tonestop")


async def cmd_tonestop(addr):
    async with connect(addr) as c:
        try:
            payload = DEV.build("tone_release")
        except protocol.Unsupported as e:
            raise SystemExit(f"tonestop: {e}")
        await dbg_write(c, payload, "tonestop", test_only=True)
    print("tone stopped")


def _snap_sid_summary(raw):
    """(playing, songs, rc, title, render_calls, frame_calls) from the
    debug snapshot, or None when the firmware has no SID block there."""
    if not has("snapshot", "sid_playing"):
        return None
    return (snap(raw, "snapshot", "sid_playing"),
            snap(raw, "snapshot", "sid_songs"),
            snap(raw, "snapshot", "sid_last_rc"),
            snap_text(raw, "snapshot", "sid_title"),
            snap(raw, "snapshot", "sid_render_calls", 0),
            snap(raw, "snapshot", "sid_frame_calls", 0))


async def cmd_sid(addr, n=None, sub=None):
    n = 0 if n is None else n
    if not 0 <= n <= 9:
        raise SystemExit("SID index must be 0..9 (/home/<n>.sid)")
    if sub is not None and not 1 <= sub <= 255:
        raise SystemExit("subtune must be 1..255 (255 = the PSID default)")
    async with connect(addr) as c:
        try:
            payload = (DEV.build("play_file", sub, f"{n}.sid")
                       if sub is not None else
                       DEV.build("play_index", n))
        except protocol.Unsupported as e:
            raise SystemExit(f"sid: {e}")
        before = await _maybe_state(c)
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
        await _settle_player(c, before)
        raw = await c.read_gatt_char(DEV.char("debug"))
        # _snap_sid_summary() reads field offsets from DEV, which goes away
        # with the link: decode while it is still up.
        summary = _snap_sid_summary(raw)
        if summary is None:
            print(f"played {n}.sid (this firmware does not report SID "
                  "status)")
            return
        playing, songs, rc, title, calls, frames = summary
        print(f"SID: playing={playing} songs={songs} rc={rc} "
              f"title={title!r} render_calls={calls} frame_calls={frames}")


async def cmd_sidname(addr, name=None, sub=None):
    if not name:
        raise SystemExit("usage: sidname <name.sid>  (file in /home)")
    data = name.encode("ascii", "replace")
    if sub is not None and not 1 <= sub <= 255:
        raise SystemExit("subtune must be 1..255 (255 = the PSID default)")
    async with connect(addr) as c:
        nmax = DEV.name_max("play_file" if sub is not None else
                            "play_file_default")
        if len(data) > nmax:
            raise SystemExit(f"file name too long (max {nmax} chars)")
        try:
            payload = (DEV.build("play_file", sub, data)
                       if sub is not None else
                       DEV.build("play_file_default", data))
        except protocol.Unsupported as e:
            raise SystemExit(f"sidname: {e}")
        before = await _maybe_state(c)
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
        await _settle_player(c, before)
        raw = await c.read_gatt_char(DEV.char("debug"))
        summary = _snap_sid_summary(raw)
        if summary is None:
            print(f"SID '{name}': played (this firmware does not report SID "
                  "status)")
            return
        playing, songs, rc, title, _calls, _frames = summary
        print(f"SID '{name}': playing={playing} songs={songs} rc={rc} "
              f"title={title!r}")


async def cmd_transport(addr, name, what):
    """The play/pause and tune/subtune step commands: bare opcode, no reply."""
    async with connect(addr) as c:
        try:
            payload = DEV.build(name)
        except protocol.Unsupported as e:
            raise SystemExit(f"{name}: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
    print(what)


async def cmd_subplay(addr, n=None):
    """Start subtune N (1-based) of the loaded tune; 255 = PSID default."""
    if n is None:
        raise SystemExit("usage: subplay <n>  (1-based subtune, 255 = default)")
    if not 1 <= n <= 255:
        raise SystemExit("subtune must be 1..255 (255 = the PSID default)")
    async with connect(addr) as c:
        try:
            payload = DEV.build("subplay", n)
        except protocol.Unsupported as e:
            raise SystemExit(f"subplay: {e}")
        try:
            await c.write_gatt_char(DEV.char("debug"), payload,
                                    response=True)
        except BleakError as e:
            raise SystemExit(
                f"subplay: rejected by the device ({e}) - is a tune loaded?"
            )
    print(f"subtune {n}" + (" (PSID default)" if n == 255 else ""))


def _state_line(st):
    return (f"{_state_words(st):16s} sub {st['subtune'] + 1}/{st['songs']}  "
            f"pos {_state_pos(st):12s} chip {st['chip']} ({_model_label(st)})  "
            f"end {_end_label(st)}  snd {'on' if st['sound'] else 'off'}  "
            f"vol {st.get('volume', 0)}")


async def cmd_state(addr):
    """One-shot read of the player state + info characteristics."""
    async with connect(addr) as c:
        if not DEV.has_char("state"):
            raise SystemExit(
                f"state: firmware {DEV.firmware} has no player state "
                "characteristic (added in 1.0.9)")
        state = _player_state(await _read_char(c, DEV.char("state"), "state"))
        info = (_player_info(await _read_char(c, DEV.char("info"), "state"))
                if DEV.has_char("info") else
                {"title": "", "name": "", "author": "", "id": None})
        # The labels in _state_line() come from DEV, which the protocol
        # object clears when the link goes away: print while it is alive.
        if state is None:
            raise SystemExit("state: unexpected value from the device")
        engine = ("legacy" if state["legacy"] else
                  "split (FLPR CPU + M33 SID)" if state.get("split")
                  else "cRSID")
        print(f"player:  {_state_line(state)}")
        print(f"engine:  {engine}")
        if info["title"] or info["name"]:
            print(f"tune:    {info['title'] or '-'}  [{info['name'] or '-'}]")
            print(f"author:  {info['author'] or '-'}")
            if info["id"]:
                print(f"id:      {info['id']} (whole-file MD5 prefix, "
                      "HVSC match)")


async def cmd_watch(addr):
    """Follow the player state notifications until Ctrl-C."""
    async with connect(addr) as c:
        if not DEV.has_char("state"):
            raise SystemExit(
                f"watch: firmware {DEV.firmware} has no player state "
                "characteristic (added in 1.0.9)")
        last_gen = {"value": -1}
        want_info = {"flag": False}

        def on_state(_sender, data):
            st = _player_state(bytes(data))
            if st is None:
                return
            if st["gen"] != last_gen["value"]:
                last_gen["value"] = st["gen"]
                want_info["flag"] = True
            print(f"{time.strftime('%H:%M:%S')}  {_state_line(st)}",
                  flush=True)

        try:
            await c.start_notify(DEV.char("state"), on_state)
        except (BleakError, AttributeError) as e:
            raise SystemExit(
                f"watch: cannot subscribe ({e}) - firmware too old?"
            )
        print("watching player state - Ctrl-C to stop", flush=True)
        with _sigint_graceful() as stop:
            while not stop():
                if want_info["flag"]:
                    want_info["flag"] = False
                    if DEV.has_char("info"):
                        raw = await _read_char(c, DEV.char("info"), "watch")
                        info = _player_info(raw)
                    else:
                        info = {"title": "", "name": "", "author": "",
                                "id": None}
                    print(f"          tune: {info['title']} "
                          f"[{info['name']}] by {info['author']}"
                          + (f"  id {info['id']}" if info["id"] else ""),
                          flush=True)
                await asyncio.sleep(0.1)
        with contextlib.suppress(Exception):
            await c.stop_notify(DEV.char("state"))


async def cmd_quality(addr, value=None):
    """SID waveform quality: light (default) | hq (oversampled, costly)."""
    if value not in ("light", "hq"):
        raise SystemExit("usage: quality light|hq  (HQ oversampled waveforms; "
                         "~4.6x the SID cost, not persisted)")
    code = {"light": 0, "hq": 1}[value]
    async with connect(addr) as c:
        try:
            payload = DEV.build("set_quality", code)
        except protocol.Unsupported as e:
            raise SystemExit(f"quality: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
    print(f"SID quality: {value}")


async def cmd_volume(addr, value=None):
    """Software volume 0-255 (the VOL slider); no value reads the snapshot."""
    usage = "volume [0-255]  (no value = read)"
    async with connect(addr) as c:
        if value is None:
            raw = await c.read_gatt_char(DEV.char("debug"))
            v = snap(raw, "snapshot", "audio_volume")
            print(f"volume: {v} ({round(v * 100 / 255)}%)")
            return
        try:
            v = int(value)
        except ValueError:
            raise SystemExit(usage)
        if not 0 <= v <= 255:
            raise SystemExit(usage)
        try:
            payload = DEV.build("set_volume", v)
        except protocol.Unsupported as e:
            raise SystemExit(f"volume: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
        print(f"volume: {v} ({round(v * 100 / 255)}%) (saved)")


async def cmd_splitrate(addr, value=None):
    """Split SID nominal rate: default | HZ (0 = the SID-count default)."""
    usage = "splitrate [HZ]  (0 = default by SID count: 34000; persisted)"
    try:
        hz = int(value or 0)
    except ValueError:
        raise SystemExit(usage)
    if not 0 <= hz <= 96000:
        raise SystemExit(usage)
    async with connect(addr) as c:
        try:
            payload = DEV.build("splitrate", hz)
        except protocol.Unsupported as e:
            raise SystemExit(f"splitrate: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
    print(f"split SID rate: {hz if hz else 'default by SID count'} (saved)")


async def cmd_engine(addr, value=None):
    """Switch the SID engine: new | old | split."""
    if value not in ("new", "old", "split"):
        raise SystemExit("usage: engine new|old|split  (cRSID / "
                         "cSID-light / split: FLPR runs the C64/CPU)")
    code = {"new": 0, "old": 1, "split": 2}[value]
    async with connect(addr) as c:
        try:
            payload = DEV.build("set_engine", code)
        except protocol.Unsupported as e:
            raise SystemExit(f"engine: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
        print(f"SID engine: {value}")


async def cmd_filedelete(addr, name=None):
    """Delete a song file from /home (a .sid also drops its sidecars)."""
    if not name:
        raise SystemExit("usage: filedelete <name>  (e.g. Parallax.sid)")
    names = [name]
    if name.lower().endswith(".sid"):
        names += [name[:-4] + ".len", name[:-4] + ".stil"]
    async with connect(addr) as c:
        nmax = DEV.name_max("delete")
        for i, n in enumerate(names):
            data = n.encode("ascii", "replace")
            if len(data) > nmax:
                if i == 0:
                    raise SystemExit(f"file name too long (max {nmax} chars)")
                print(f"cannot delete (name too long): {n}")
                continue
            try:
                payload = DEV.build("delete", data)
            except protocol.Unsupported as e:
                raise SystemExit(f"filedelete: {e}")
            try:
                await c.write_gatt_char(DEV.char("debug"), payload,
                                        response=True)
                print(f"deleted: {n}")
            except Exception as e:
                if i == 0:
                    raise SystemExit(
                        f"could not delete {n} - missing, or not a "
                        ".sid/.len/.stil file"
                    )
                print(f"could not delete {n}: {e}")


async def cmd_chip(addr, mode=None):
    modes = {"auto": 0, "6581": 1, "8580": 2}
    m = 0 if mode is None else modes.get(str(mode).lower())
    if m is None:
        raise SystemExit("chip mode: auto | 6581 | 8580")
    async with connect(addr) as c:
        try:
            payload = DEV.build("set_chip", m)
        except protocol.Unsupported as e:
            raise SystemExit(f"chip: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
    print(f"SID chip mode -> {('auto (PSID flag)', '6581', '8580')[m]}"
          f" (reloads the current tune)")


async def cmd_endmode(addr, value=None):
    """End-of-tune mode: what the SID screen's END button cycles."""
    modes = {"nextsub": 0, "nexttune": 1, "loop": 2}
    m = modes.get(str(value).lower()) if value is not None else None
    if m is None:
        raise SystemExit("end mode: nextsub | nexttune | loop")
    async with connect(addr) as c:
        try:
            payload = DEV.build("set_end_mode", m)
        except protocol.Unsupported as e:
            raise SystemExit(f"end mode: {e}")
        await c.write_gatt_char(DEV.char("debug"), payload, response=True)
    print(f"end mode -> {_value_label('end_mode', m)}")


def _rtt_chunk(raw):
    """Log text from a snapshot read served by the log debug command."""
    if raw is None or not has("log", "marker") or \
            snap(raw, "log", "marker") != DEV.opcode("log"):
        return None
    n = min(snap(raw, "log", "count"), int(DEV.limits["log_chunk"]))
    return bytes(raw[DEV.offset("log", "text"):][:n])


async def _log_chunk(c, mode):
    """One log chunk; exit in one line when the device does not serve it."""
    try:
        await dbg_write(c, DEV.build("log", mode), "log")
    except protocol.Unsupported as e:
        raise SystemExit(f"log: {e}")
    raw = await c.read_gatt_char(DEV.char("debug"))
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

        try:
            payload = (DEV.build("accel", code) if code else
                       DEV.build("accel"))
        except protocol.Unsupported as e:
            raise SystemExit(f"accel: {e}")
        await dbg_write(c, payload, "accel")
        await _pull_log(c, emit)
        emit(b"", last=True)


async def cmd_ls(addr):
    async with connect(addr) as c:
        start = 0
        names = []
        raw = b""
        for _ in range(400):  # ~4 files/page; 40 pages truncated big libraries
            try:
                payload = DEV.build("list_page", start)
            except protocol.Unsupported as e:
                raise SystemExit(f"ls: {e}")
            await c.write_gatt_char(DEV.char("debug"), payload,
                                    response=True)
            raw = await c.read_gatt_char(DEV.char("debug"))
            chunk = DEV.text(raw, "listing", "text")
            names += [n for n in chunk.split("\n") if n]
            nxt = snap(raw, "listing", "next", 0xFF)
            if nxt == 0xFF:
                break
            start = nxt
        # The protocol object is cleared when the link goes away, so read
        # the filesystem state while the connection (and DEV) still exists.
        state = _fs_state(raw)
    print("/home:")
    for n in names:
        print(f"  {n}")
    print(f"  ({len(names)} files)")
    if state is not None and not state[0]:
        print(f"  filesystem corrupt or not formatted (mount error "
              f"-{state[1]}) - nothing is stored, so the listing is empty; "
              "'fsformat' recreates it")
    elif state is not None and not names:
        print("  /home is mounted but the directory could not be read - "
              "the firmware's directory-handle pool may be exhausted; "
              "a reboot clears it (do not 'fsformat')")


async def _poll_marker(c, marker):
    """Poll the snapshot until the deferred op serves its marker."""
    for _ in range(15):
        await asyncio.sleep(1)
        raw = await c.read_gatt_char(DEV.char("debug"))
        if snap(raw, "stacks", "marker", None) == marker:
            return raw
    raise SystemExit("op not served (retry)")


async def cmd_stacks(addr, value=None):
    """Stack high-water marks: the interrupt stack first, then the threads."""
    async with connect(addr) as c:
        try:
            marker = DEV.opcode("stacks")
        except protocol.Unsupported as e:
            raise SystemExit(f"stacks: {e}")
        raws = []
        for page in range(4):  # firmware caps the listing at 3 pages
            payload = (DEV.build("stacks", page) if page else
                       DEV.build("stacks"))
            await c.write_gatt_char(DEV.char("debug"), payload,
                                    response=True)
            raw = await _poll_marker(c, marker)
            raws.append(raw)
            if not _stacks_more(snap(raw, "stacks", "page"), page):
                break
        # _parse_stack_pages() reads the row names through DEV, which goes
        # away with the link: decode while it is still up.
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
    """Whether another stacks page should be requested.

    Bit 6 of the page byte marks the last page (firmware that has the
    interrupt stack row); older firmware leaves it clear, and then the
    named layout has 3 pages and the pre-name layout 2.
    """
    if page_byte & 0x40:
        return False
    return page + 1 < (3 if page_byte & 0x80 else 2)


def _parse_stack_pages(raws):
    """(name, size, free) rows from the stack telemetry snapshot pages.

    Names live in a per-row text field aligned with the (size, free) pairs,
    4 rows per page; bit 7 of the page byte marks that layout. Row 0 of the
    listing is the interrupt stack (named "ISR0" by the firmware); the
    threads follow in creation order. A firmware that predates the names
    keeps the 5-per-page pairs and leaves non-text bytes where the names
    would be, so those rows are labelled by position instead.
    """
    rows_off = DEV.offset("stacks", "rows")
    names_off = DEV.offset("stacks", "names")
    name_max = int(DEV.limits["stack_name_max"])
    per_page = int(DEV.limits["stack_rows_per_page"])
    rows = []
    for page, raw in enumerate(raws):
        named = bool(snap(raw, "stacks", "page") & 0x80)
        per = per_page if named else 5
        for i in range(per):
            size = int.from_bytes(raw[rows_off + 4 * i:
                                     rows_off + 2 + 4 * i], "little")
            free = int.from_bytes(raw[rows_off + 2 + 4 * i:
                                     rows_off + 4 + 4 * i], "little")
            if size == 0:
                continue
            name = f"#{per * page + i}"
            if named:
                label = raw[names_off + name_max * i:
                            names_off + name_max * (i + 1)].split(b"\0")[0]
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
            "status", "protocol", "set-time", "monitor", "audio",
            "click", "beep",
            "tone", "mute", "rate", "tonefreq",
        "tonestart", "tonestop", "fsformat", "sid", "sidname", "chip",
        "sidstop", "ls", "glitch", "blemode", "filedelete", "endmode",
        "engine", "quality", "volume", "splitrate", "stacks", "threads",
        "log", "accel",
        "playpause", "next", "prev", "subnext", "subprev", "subplay",
        "state", "watch", "flpr", "flpralu",
        ],
    )
    ap.add_argument(
        "--addr", default=None,
        help="BLE address; default: $SIDCLOCK_ADDR or a scan by name",
    )
    ap.add_argument(
        "--sub", type=int, default=None,
        help="'sid'/'sidname': start at subtune N (1-based; 255 = PSID default)",
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
        "-y", "--yes", action="store_true",
        help="answer destructive-command confirmations with yes (fsformat)",
    )
    ap.add_argument(
        "value", nargs="?", type=str, default=None,
        help="rate/tone in Hz, or the file name for 'sidname'",
    )
    args = ap.parse_args()
    args.addr = asyncio.run(resolve_addr(args.addr))

    fn = {
        "status": cmd_status,
        "protocol": cmd_protocol,
        "set-time": cmd_set_time,
        "monitor": cmd_monitor,
        "audio": cmd_audio,
        "click": lambda a: cmd_tone(a, "click"),
        "beep": lambda a: cmd_tone(a, "beep"),
        "tone": lambda a: cmd_tone(a, "long_tone"),
        "mute": lambda a: cmd_tone(a, "mute"),
        "rate": cmd_rate,
        "tonefreq": cmd_tonefreq,
        "tonestart": cmd_tonestart,
        "tonestop": cmd_tonestop,
        "fsformat": cmd_fsformat,
        "sid": cmd_sid,
        "sidname": cmd_sidname,
        "chip": cmd_chip,
        "endmode": cmd_endmode,
        "ls": cmd_ls,
        "sidstop": lambda a: cmd_tone(a, "stop"),
        "glitch": cmd_glitch,
        "blemode": cmd_blemode,
        "filedelete": cmd_filedelete,
        "engine": cmd_engine,
        "quality": cmd_quality,
        "volume": cmd_volume,
        "splitrate": cmd_splitrate,
        "stacks": cmd_stacks,
        "threads": cmd_stacks,  # alias for the old name
        "log": cmd_log,
        "accel": cmd_accel,
        "playpause": lambda a: cmd_transport(a, "play_pause",
                                             "play/pause toggled"),
        "next": lambda a: cmd_transport(a, "next_tune", "next tune"),
        "prev": lambda a: cmd_transport(a, "prev_tune", "previous tune"),
        "subnext": lambda a: cmd_transport(a, "next_subtune",
                                           "next subtune"),
        "subprev": lambda a: cmd_transport(a, "prev_subtune",
                                           "previous subtune"),
        "subplay": cmd_subplay,
        "state": cmd_state,
        "watch": cmd_watch,
        "flpr": cmd_flpr,
        "flpralu": cmd_flpralu,
    }[args.command]
    if args.command == "log":
        asyncio.run(fn(args.addr, args.peek, args.follow))
    elif args.command == "accel":
        asyncio.run(fn(args.addr, args.value))
    elif args.command == "sidname":
        asyncio.run(fn(args.addr, args.value, args.sub))
    elif args.command in ("chip", "filedelete", "engine", "quality", "volume",
                          "splitrate", "stacks", "threads", "endmode"):
        asyncio.run(fn(args.addr, args.value))
    elif args.command == "set-time":
        asyncio.run(fn(args.addr, args.value))
    elif args.command == "fsformat":
        asyncio.run(fn(args.addr, args.yes))
    elif args.command in ("glitch", "blemode", "flpr", "flpralu"):
        asyncio.run(fn(args.addr, args.value))
    elif args.command == "sid":
        asyncio.run(fn(args.addr,
                       int(args.value) if args.value is not None else None,
                       args.sub))
    elif args.command in ("rate", "tonefreq", "tonestart", "subplay"):
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
