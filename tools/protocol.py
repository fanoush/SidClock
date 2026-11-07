#!/usr/bin/env python3
"""Load SidClock BLE protocol descriptors and decode device values.

`protocol/current.json` is the single source of truth for the wire format;
`protocol/index.json` lists one frozen descriptor for every released
firmware.  A tool selects the descriptor that matches the connected device:

  * the hello characteristic (protocol + layout + caps) when the firmware
    has one, which is exact even across patch releases;
  * otherwise the legacy probe: which characteristics exist plus the debug
    characteristic size (see the `legacy` block in each descriptor).

Nothing in here talks to Bluetooth; `sidclock_ble.py` does the discovery and
then calls `select_for_hello()` / `select_legacy()`.
"""

import json
import os
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROTO_DIR = os.path.join(ROOT, "protocol")

# Permanent UUIDs. The hello characteristic was added with protocol 5 and is
# never allowed to move again; the older three are the original debug service
# layout. All three are repeated in every descriptor - these constants only
# let a client look for them before it knows which descriptor applies.
HELLO_UUID = "73696463-6c6f-4b05-9c1d-77ce3f41a5c0"
DEBUG_UUID = "73696463-6c6f-4b02-9c1d-77ce3f41a5c0"
STATE_UUID = "73696463-6c6f-4b03-9c1d-77ce3f41a5c0"
INFO_UUID = "73696463-6c6f-4b04-9c1d-77ce3f41a5c0"

TYPE_SIZE = {
    "u8": 1, "i8": 1,
    "u16": 2, "i16": 2,
    "u24": 3,
    "u32": 4, "i32": 4,
    "u64": 8,
}
VARIABLE_TYPES = ("string", "bytes", "hex")


class Unsupported(Exception):
    """The connected firmware's descriptor does not offer this feature."""


class ProtocolError(Exception):
    """The descriptor or the device's hello value is unusable."""


def _read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_index():
    return _read_json(os.path.join(PROTO_DIR, "index.json"))


def load_descriptor(entry_or_fw):
    """Load a descriptor from an index entry, a firmware string or a path."""
    if isinstance(entry_or_fw, dict):
        fw = entry_or_fw["firmware"]
        path = os.path.join(PROTO_DIR, entry_or_fw["file"])
    elif os.path.sep in str(entry_or_fw):
        fw = None
        path = entry_or_fw
    else:
        fw = str(entry_or_fw)
        path = os.path.join(PROTO_DIR, "versions", fw + ".json")

    if not os.path.exists(path):
        # The current development descriptor is not frozen yet; its index
        # entry points at versions/<fw>.json, which only exists after
        # `proto_gen.py freeze`. Fall back to current.json.
        current = os.path.join(PROTO_DIR, "current.json")
        if os.path.exists(current):
            data = _read_json(current)
            if fw is None or data["firmware"] == fw:
                return Descriptor(data)
    try:
        return Descriptor(_read_json(path))
    except FileNotFoundError:
        raise ProtocolError(f"no protocol descriptor for {entry_or_fw!r}")


def semver(text):
    try:
        return tuple(int(x) for x in str(text).split("."))
    except ValueError:
        return (0,)


def parse_hello(raw):
    """Decode the 12-byte hello value (see docs/ble-services.md)."""
    raw = bytes(raw)
    if len(raw) < 12:
        raise ProtocolError(f"hello is {len(raw)} bytes, expected 12")
    protocol, layout, caps = struct.unpack_from("<HHI", raw, 0)
    return {
        "protocol": protocol,
        "layout": layout,
        "caps": caps,
        "firmware": f"{raw[8]}.{raw[9]}.{raw[10]}",
        "flags": raw[11],
        "debug": bool(raw[11] & 0x01),
        "legacy_engine": bool(raw[11] & 0x02),
        "split_engine": bool(raw[11] & 0x04),
    }


class Descriptor:
    """One firmware's wire protocol with typed accessors."""

    def __init__(self, data, source="hello"):
        self.data = data
        self.source = source
        self.firmware = data["firmware"]
        self.protocol = data["protocol"]
        self.notes = []
        self.features = set(data.get("features", []))
        self.characteristics = data.get("characteristics", {})
        self.limits = data.get("limits", {})
        self._snapshot = data.get("snapshot", {"size": 0, "fields": []})
        self._snap_fields = self._field_map(self._snapshot.get("fields", []))
        self._overlays = {
            name: self._field_map(ov.get("fields", []))
            for name, ov in self._snapshot.get("overlays", {}).items()
        }
        self._state_fields = self._field_map(
            data.get("state", {}).get("fields", []))
        self._info_fields = self._field_map(
            (data.get("info", {}).get("strings", []) +
             data.get("info", {}).get("hex", [])))
        self._hello_fields = self._field_map(
            data.get("hello", {}).get("fields", []))
        self._commands = {c["name"]: c for c in data.get("commands", [])}

    @staticmethod
    def _field_map(fields):
        return {f["name"]: f for f in fields}

    # --- capabilities -------------------------------------------------
    def has(self, feature):
        return feature in self.features

    def has_char(self, name):
        return name in self.characteristics

    def char(self, name):
        ch = self.characteristics.get(name)
        if ch is None:
            raise Unsupported(
                f"{name} characteristic requires a newer firmware "
                f"(connected: {self.firmware})")
        return ch["uuid"]

    def char_size(self, name):
        return self.characteristics.get(name, {}).get("size")

    def require(self, feature, what=None):
        if not self.has(feature):
            raise Unsupported(
                f"{what or feature}: not supported by firmware {self.firmware}")

    # --- field access ------------------------------------------------
    def _fields(self, area):
        if area == "snapshot":
            return self._snap_fields
        if area == "state":
            return self._state_fields
        if area == "info":
            return self._info_fields
        if area == "hello":
            return self._hello_fields
        if area in self._overlays:
            return self._overlays[area]
        raise KeyError(area)

    def field(self, area, name):
        fields = self._fields(area)
        if name not in fields:
            raise Unsupported(
                f"{area}.{name}: not described by firmware {self.firmware}")
        return fields[name]

    def has_field(self, area, name):
        return name in self._fields(area)

    def offset(self, area, name):
        return int(self.field(area, name)["offset"])

    def length(self, area, name):
        f = self.field(area, name)
        if f["type"] in VARIABLE_TYPES:
            return int(f["size"])
        return TYPE_SIZE[f["type"]]

    def int(self, raw, area, name):
        f = self.field(area, name)
        off = int(f["offset"])
        size = self.length(area, name)
        if off + size > len(raw):
            raise Unsupported(
                f"{area}.{name}: device value is {len(raw)} bytes, need "
                f"{off + size} (firmware {self.firmware})")
        signed = f["type"].startswith("i")
        return int.from_bytes(bytes(raw[off:off + size]), "little",
                              signed=signed)

    def text(self, raw, area, name, encoding="utf-8"):
        off = self.offset(area, name)
        size = self.length(area, name)
        chunk = bytes(raw[off:off + size]).split(b"\0")[0]
        return chunk.decode(encoding, "replace")

    def snapshot_size(self):
        return int(self._snapshot.get("size", 0))

    def snapshot_flags(self):
        return {f["name"]: f["mask"]
                for f in self._snapshot.get("flags", [])}

    def state_flags(self):
        return {f["name"]: f["mask"]
                for f in self.data.get("state", {}).get("flags", [])}

    def hello_flags(self):
        return {f["name"]: f["mask"]
                for f in self.data.get("hello", {}).get("flags", [])}

    def value_label(self, set_name, value):
        for item in self.data.get("values", {}).get(set_name, []):
            if item["value"] == value:
                return item.get("label", item["name"])
        return str(value)

    def decode_snapshot(self, raw):
        out = {}
        for name, f in self._snap_fields.items():
            try:
                if f["type"] in VARIABLE_TYPES:
                    out[name] = bytes(raw[int(f["offset"]):
                                         int(f["offset"]) + int(f["size"])])
                else:
                    out[name] = self.int(raw, "snapshot", name)
            except Unsupported:
                pass  # newer descriptor than the device actually is
        return out

    # --- commands ----------------------------------------------------
    def command(self, name, build="release"):
        c = self._commands.get(name)
        if c is None:
            raise Unsupported(
                f"command {name!r}: not supported by firmware {self.firmware}")
        return c

    def has_command(self, name):
        return name in self._commands

    def opcode(self, name):
        return int(self.command(name)["opcode"])

    def command_limits(self, name):
        """(min_len, max_len) of a command payload, from the descriptor."""
        c = self.command(name)
        total = 1
        minimum = 1
        for arg in c.get("args", []):
            if arg["type"] == "name":
                n = self.limits["name_max"]
                nmin = 1
            else:
                n = {"u8": 1, "u16": 2, "u32": 4}[arg["type"]]
                nmin = n
            total += n
            if not arg.get("optional"):
                minimum += nmin
        return minimum, total

    def value(self, set_name, mode):
        """Protocol value for a named value set (e.g. "end_mode")."""
        for item in self.data.get("values", {}).get(set_name, []):
            if str(mode).lower() in (item["name"].lower(),
                                     str(item.get("label", "")).lower()):
                return item["value"]
        raise ProtocolError(f"{set_name}: unknown mode {mode!r}")

    def value_items(self, set_name):
        return self.data.get("values", {}).get(set_name, [])

    def name_max(self, command):
        """Longest name `command` accepts (its name arg's max, else name_max).

        Only `delete` takes longer names than the loader can play: it must
        be able to remove whatever the listing shows.
        """
        for arg in self.command(command).get("args", []):
            if arg["type"] == "name":
                return arg.get("max") or self.limits["name_max"]
        return self.limits["name_max"]

    def build(self, name, *args, build="release"):
        """Encode a command write: opcode followed by its args."""
        c = self.command(name, build=build)
        out = bytearray([int(c["opcode"])])
        declared = c.get("args", [])
        if len(args) > len(declared):
            raise ProtocolError(f"{name}: too many arguments")
        for i, arg in enumerate(declared):
            typ = arg["type"]
            value = args[i] if i < len(args) else None
            if typ == "name":
                if value is None:
                    value = ""
                data = value.encode("ascii", "replace") if isinstance(
                    value, str) else bytes(value)
                nmax = arg.get("max") or self.limits["name_max"]
                if len(data) > nmax:
                    raise ProtocolError(
                        f"{name}: name too long (max {nmax})")
                out += data
                continue
            if value is None:
                if arg.get("optional"):
                    continue  # the bare opcode is a legal request
                raise ProtocolError(f"{name}: missing argument {arg['name']}")
            size = {"u8": 1, "u16": 2, "u32": 4}[typ]
            out += int(value).to_bytes(size, "little")
        return bytes(out)


def select_for_hello(hello, index=None):
    """Pick the descriptor for a hello value. Returns (Descriptor, notes)."""
    index = index or load_index()
    info = parse_hello(hello)
    notes = []
    for entry in index["versions"]:
        if (entry["protocol"] == info["protocol"] and
                int(entry["layout"], 16) == info["layout"]):
            desc = load_descriptor(entry)
            desc.source = "hello"
            return desc, notes

    # Same protocol but a different layout means the descriptor was edited
    # without a protocol bump; use the newest descriptor for that protocol.
    same = [e for e in index["versions"]
            if e["protocol"] == info["protocol"]]
    if same:
        entry = max(same, key=lambda e: semver(e["firmware"]))
        desc = load_descriptor(entry)
        desc.source = "hello"
        notes.append(
            f"hello layout 0x{info['layout']:04x} has no descriptor; using "
            f"{desc.firmware} (layout 0x{int(entry['layout'], 16):04x})")
        return desc, notes

    older = [e for e in index["versions"] if e["protocol"] < info["protocol"]]
    if older:
        entry = max(older, key=lambda e: e["protocol"])
        desc = load_descriptor(entry)
        desc.source = "hello"
        notes.append(
            f"device speaks protocol {info['protocol']}, newest descriptor "
            f"is {desc.protocol} ({desc.firmware}); commands added later are "
            "disabled")
        return desc, notes

    raise ProtocolError(
        f"device speaks protocol {info['protocol']} (fw {info['firmware']}), "
        "older than every descriptor this tool ships")


def select_legacy(present, debug_size=None, index=None):
    """Pick a descriptor for a device without hello.

    `present` is the set of characteristic names found on the device
    ("debug", "state", "info"); `debug_size` is the length of the value the
    debug characteristic returns (None when it could not be read).
    """
    index = index or load_index()
    notes = [
        "device has no hello characteristic; using the legacy probe "
        "(firmware version is approximate)"
    ]
    for entry in sorted(index["versions"],
                        key=lambda e: (e["protocol"], semver(e["firmware"])),
                        reverse=True):
        legacy = entry.get("legacy")
        if not legacy:
            continue
        has = legacy.get("has", [])
        missing = legacy.get("missing", [])
        if not all(name in present for name in has):
            continue
        if not all(name not in present for name in missing):
            continue
        bounds = legacy.get("debug_size")
        if bounds and debug_size is not None and not (
                bounds[0] <= debug_size <= bounds[1]):
            continue
        desc = load_descriptor(entry)
        desc.source = "legacy"
        notes.append(
            f"matched {desc.firmware} (protocol {desc.protocol}): "
            f"debug {debug_size or '?'} bytes, "
            f"state {'yes' if 'state' in present else 'no'}, "
            f"info {'yes' if 'info' in present else 'no'}")
        return desc, notes
    return None, notes
