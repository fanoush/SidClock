#!/usr/bin/env python3
"""Generate SidClock's BLE protocol artefacts from protocol/current.json.

The JSON descriptor is the single source of truth for the wire format.  This
tool validates it and emits:

  app/src/proto_gen.h              C constants used by the firmware
  protocol/index.json              descriptor index for host tools
  protocol/versions/*.json         frozen descriptors (one per release)

`tools/proto_gen.py check` fails when any of those is out of date; the build
and CI run it.  A release freezes the current descriptor with
`tools/proto_gen.py freeze --version X`.

The web remote is served from web/ alone (GitHub Pages artifact,
tools/serve_web.py), so it needs its own copies below that root;
`tools/proto_gen.py stage` writes web/protocol/ at deploy and serve time and
the directory is gitignored - the repository keeps one copy of each
descriptor.
"""

import argparse
import json
import os
import re
import shutil
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROTO = os.path.join(ROOT, "protocol")
VERSIONS = os.path.join(PROTO, "versions")
HEADER = os.path.join(ROOT, "app", "src", "proto_gen.h")
WEB_PROTO = os.path.join(ROOT, "web", "protocol")
BUILD_SH = os.path.join(ROOT, "app", "build.sh")

TYPES = {
    "u8": 1, "i8": 1,
    "u16": 2, "i16": 2,
    "u24": 3,
    "u32": 4, "i32": 4,
    "u64": 8,
}
VARIABLE_TYPES = {"string", "bytes", "hex"}
ACCESS = {"read", "read-write", "read-notify", "write"}
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
FINAL_FIELDS = ("name", "offset", "type", "size")


def die(msg):
    print(f"proto_gen: {msg}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        die(f"missing {os.path.relpath(path, ROOT)}")
    except json.JSONDecodeError as e:
        die(f"{os.path.relpath(path, ROOT)}: {e}")


def dump_json(obj):
    return json.dumps(obj, indent=2, ensure_ascii=True) + "\n"


def macro(s):
    s = re.sub(r"[^A-Za-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_").upper()
    if not s:
        die(f"bad macro name from {s!r}")
    return s


def field_size(f):
    if f["type"] in VARIABLE_TYPES:
        return int(f["size"])
    return TYPES[f["type"]]


def semver(v):
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)$", v)
    if not m:
        die(f"bad firmware version {v!r} (want X.Y.Z)")
    return tuple(int(x) for x in m.groups())


def load_caps():
    caps = load_json(os.path.join(PROTO, "caps.json"))
    if set(caps.values()) != set(range(len(caps))):
        die("protocol/caps.json must assign every capability a unique bit")
    return caps


def check_fields(desc, area, fields, size, allow_alt=False):
    seen = set()
    used = []
    for f in fields:
        for key in ("name", "offset", "type"):
            if key not in f:
                die(f"{desc['firmware']} {area}: field missing {key}: {f}")
        name = f["name"]
        if name in seen:
            die(f"{desc['firmware']} {area}: duplicate field {name}")
        seen.add(name)
        if f["type"] not in TYPES and f["type"] not in VARIABLE_TYPES:
            die(f"{desc['firmware']} {area}.{name}: bad type {f['type']}")
        if f["type"] in VARIABLE_TYPES and "size" not in f:
            die(f"{desc['firmware']} {area}.{name}: {f['type']} needs size")
        start = int(f["offset"])
        end = start + field_size(f)
        if start < 0 or end > size:
            die(f"{desc['firmware']} {area}.{name}: {start}..{end - 1} "
                f"outside 0..{size - 1}")
        if not f.get("alt"):
            for s, e, other in used:
                if start < e and s < end:
                    die(f"{desc['firmware']} {area}: {name} overlaps {other}")
            used.append((start, end, name))
        elif not allow_alt:
            die(f"{desc['firmware']} {area}.{name}: alt only allowed in "
                "the snapshot")


def validate(desc):
    if not isinstance(desc, dict):
        die("descriptor is not an object")
    for key in ("schema", "firmware", "protocol", "service",
                "characteristics", "features", "limits", "values",
                "commands", "snapshot"):
        if key not in desc:
            die(f"{desc.get('firmware', '?')}: missing {key}")
    semver(desc["firmware"])
    if not isinstance(desc["protocol"], int) or desc["protocol"] <= 0:
        die(f"{desc['firmware']}: protocol must be a positive integer")
    if not UUID_RE.match(desc["service"]):
        die(f"{desc['firmware']}: bad service UUID")

    chars = desc["characteristics"]
    if "debug" not in chars:
        die(f"{desc['firmware']}: debug characteristic is mandatory")
    for name, ch in chars.items():
        if not UUID_RE.match(ch.get("uuid", "")):
            die(f"{desc['firmware']}: bad UUID for {name}")
        if not isinstance(ch.get("size"), int) or ch["size"] <= 0:
            die(f"{desc['firmware']}: bad size for {name}")
        if ch.get("access") not in ACCESS:
            die(f"{desc['firmware']}: bad access for {name}")

    caps = load_caps()
    for feat in desc["features"]:
        if feat not in caps:
            die(f"{desc['firmware']}: unknown feature {feat}")
    if len(set(desc["features"])) != len(desc["features"]):
        die(f"{desc['firmware']}: duplicate feature")

    for name, ch in chars.items():
        feat = ch.get("feature")
        if feat is not None and feat not in desc["features"]:
            die(f"{desc['firmware']}: {name} feature {feat} not listed")

    for key in ("name_max", "log_chunk", "listing_text_max",
                "stack_rows_per_page", "stack_name_max"):
        if not isinstance(desc["limits"].get(key), int):
            die(f"{desc['firmware']}: limits.{key} must be an int")

    for set_name, vals in desc["values"].items():
        if not isinstance(vals, list) or not vals:
            die(f"{desc['firmware']}: values.{set_name} must be a list")
        used = set()
        names = set()
        for v in vals:
            if v.get("value") in used:
                die(f"{desc['firmware']}: duplicate {set_name} value")
            if v.get("name") in names:
                die(f"{desc['firmware']}: duplicate {set_name} name")
            used.add(v.get("value"))
            names.add(v.get("name"))

    cmds = desc["commands"]
    opcodes = set()
    names = set()
    for c in cmds:
        for key in ("name", "opcode"):
            if key not in c:
                die(f"{desc['firmware']}: command missing {key}: {c}")
        if c["opcode"] in opcodes:
            die(f"{desc['firmware']}: duplicate opcode {c['opcode']:#x}")
        if c["name"] in names:
            die(f"{desc['firmware']}: duplicate command {c['name']}")
        opcodes.add(c["opcode"])
        names.add(c["name"])
        if c.get("build", "release") not in ("release", "debug"):
            die(f"{desc['firmware']}: {c['name']}: bad build")
        feat = c.get("feature")
        if feat is not None and feat not in desc["features"]:
            die(f"{desc['firmware']}: {c['name']} feature {feat} not listed")
        for a in c.get("args", []):
            if a.get("type") not in ("u8", "u16", "u32", "name"):
                die(f"{desc['firmware']}: {c['name']}: bad arg type")
            if a["type"] == "name":
                maxn = a.get("max")
                # A name a listing page cannot carry (name + newline + NUL
                # fits the page text) can never be addressed either.
                if maxn is not None and not (
                        desc["limits"]["name_max"] <= maxn <=
                        desc["limits"]["listing_text_max"] - 2):
                    die(f"{desc['firmware']}: {c['name']}: name max must "
                        "be between limits.name_max and "
                        "limits.listing_text_max - 2")

    if "state" in desc:
        st = desc["state"]
        if st.get("size") != 16:
            die(f"{desc['firmware']}: state must be 16 bytes")
        check_fields(desc, "state", st["fields"], st["size"])
        for fl in st.get("flags", []):
            if not isinstance(fl.get("mask"), int):
                die(f"{desc['firmware']}: state flag mask must be int")
    if "info" in desc:
        info = desc["info"]
        if info.get("size") != 96:
            die(f"{desc['firmware']}: info must be 96 bytes")
        fields = list(info.get("strings", [])) + list(info.get("hex", []))
        check_fields(desc, "info", fields, info["size"])
    if "hello" in desc:
        hello = desc["hello"]
        if hello.get("size") != 12:
            die(f"{desc['firmware']}: hello must be 12 bytes")
        check_fields(desc, "hello", hello["fields"], hello["size"])
        for fl in hello.get("flags", []):
            if not isinstance(fl.get("mask"), int):
                die(f"{desc['firmware']}: hello flag mask must be int")

    snap = desc["snapshot"]
    if not isinstance(snap.get("size"), int) or snap["size"] <= 0:
        die(f"{desc['firmware']}: bad snapshot size")
    check_fields(desc, "snapshot", snap["fields"], snap["size"],
                 allow_alt=True)
    for fl in snap.get("flags", []):
        if not isinstance(fl.get("mask"), int):
            die(f"{desc['firmware']}: snapshot flag mask must be int")
    for oname, ov in snap.get("overlays", {}).items():
        check_fields(desc, f"overlay {oname}", ov["fields"], snap["size"])

    legacy = desc.get("legacy")
    if legacy is not None:
        for key in legacy:
            if key not in ("has", "missing", "debug_size"):
                die(f"{desc['firmware']}: legacy: unknown key {key}")
        for key in ("has", "missing"):
            for name in legacy.get(key, []):
                if name not in ("debug", "state", "info", "hello"):
                    die(f"{desc['firmware']}: legacy: unknown char {name}")
        ds = legacy.get("debug_size")
        if ds is not None and (not isinstance(ds, list) or len(ds) != 2):
            die(f"{desc['firmware']}: legacy.debug_size must be [min, max]")


def layout(desc):
    """CRC16 of the wire-relevant schema (no firmware/protocol/docs)."""
    wire = {
        "characteristics": desc["characteristics"],
        "features": desc["features"],
        "limits": desc["limits"],
        "values": desc["values"],
        "commands": [
            {k: c[k] for k in ("name", "opcode", "args", "build", "feature")
             if k in c}
            for c in desc["commands"]
        ],
        "snapshot": desc["snapshot"],
        "state": desc.get("state"),
        "info": desc.get("info"),
        "hello": desc.get("hello"),
    }
    blob = json.dumps(wire, sort_keys=True, separators=(",", ":")).encode()
    return zlib.crc32(blob) & 0xFFFF


def caps_value(desc, caps):
    value = 0
    for feat in desc["features"]:
        value |= 1 << caps[feat]
    return value


def cmd_lengths(desc, c):
    total = 1
    minimum = 1
    for a in c.get("args", []):
        if a["type"] == "name":
            n = a.get("max") or desc["limits"]["name_max"]
            nmin = 1
        else:
            n = {"u8": 1, "u16": 2, "u32": 4}[a["type"]]
            nmin = n
        total += n
        if not a.get("optional"):
            minimum += nmin
    return minimum, total


def uuid_macro(u):
    parts = u.split("-")
    return ("BT_UUID_128_ENCODE(0x%s, 0x%s, 0x%s, 0x%s, 0x%s)" %
            (parts[0], parts[1], parts[2], parts[3], parts[4]))


def field_macros(prefix, fields, lines):
    for f in fields:
        name = macro(f["name"])
        lines.append(f"#define {prefix}_OFF_{name} {f['offset']}")
        if f["type"] in VARIABLE_TYPES:
            lines.append(f"#define {prefix}_LEN_{name} {f['size']}")


def emit_header(desc, caps):
    fw = semver(desc["firmware"])
    lay = layout(desc)
    lines = [
        "/* Auto-generated by tools/proto_gen.py from protocol/current.json.",
        " * Do not edit; run `tools/proto_gen.py emit` instead.",
        " */",
        "#ifndef SIDCLOCK_PROTO_GEN_H_",
        "#define SIDCLOCK_PROTO_GEN_H_",
        "",
        "#include <stdint.h>",
        "",
        f"#define SC_FW_STRING \"{desc['firmware']}\"",
        f"#define SC_FW_MAJOR {fw[0]}",
        f"#define SC_FW_MINOR {fw[1]}",
        f"#define SC_FW_PATCH {fw[2]}",
        f"#define SC_PROTO_VERSION {desc['protocol']}",
        f"#define SC_PROTO_LAYOUT 0x{lay:04x}",
        f"#define SC_CAPS 0x{caps_value(desc, caps):08x}u",
        "",
    ]
    for feat, bit in sorted(caps.items(), key=lambda kv: kv[1]):
        lines.append(f"#define SC_CAP_{macro(feat)} {bit}")
    lines.append("")
    feats = set(desc["features"])
    for feat in caps:
        lines.append(f"#define SC_FEATURE_{macro(feat)} "
                     f"{1 if feat in feats else 0}")
    lines.append("")

    for key in ("name_max", "log_chunk", "listing_text_max",
                "stack_rows_per_page", "stack_name_max"):
        lines.append(f"#define SC_{macro(key)} {desc['limits'][key]}")
    lines.append("")

    for name, ch in desc["characteristics"].items():
        lines.append(f"#define SC_CHR_{macro(name)}_SIZE {ch['size']}")
    lines.append("")

    if "hello" in desc:
        lines.append(f"#define SC_HELLO_SIZE {desc['hello']['size']}")
        field_macros("SC_HELLO", desc["hello"]["fields"], lines)
        for fl in desc["hello"].get("flags", []):
            lines.append(f"#define SC_HELLO_FLAG_{macro(fl['name'])} "
                         f"0x{fl['mask']:02x}u")
        lines.append("")

    if "state" in desc:
        lines.append(f"#define SC_STATE_SIZE {desc['state']['size']}")
        field_macros("SC_STATE", desc["state"]["fields"], lines)
        for fl in desc["state"].get("flags", []):
            lines.append(f"#define SC_STATE_FLAG_{macro(fl['name'])} "
                         f"0x{fl['mask']:02x}u")
        lines.append("")

    if "info" in desc:
        info = desc["info"]
        lines.append(f"#define SC_INFO_SIZE {info['size']}")
        field_macros("SC_INFO", info.get("strings", []) +
                     info.get("hex", []), lines)
        lines.append("")

    snap = desc["snapshot"]
    lines.append(f"#define SC_SNAPSHOT_SIZE {snap['size']}")
    field_macros("SC_SNAP", snap["fields"], lines)
    for fl in snap.get("flags", []):
        lines.append(f"#define SC_SNAP_FLAG_{macro(fl['name'])} "
                     f"0x{fl['mask']:02x}u")
    lines.append("")
    for oname, ov in snap.get("overlays", {}).items():
        field_macros(f"SC_{macro(oname)}", ov["fields"], lines)
    lines.append("")

    for set_name, vals in desc["values"].items():
        for v in vals:
            lines.append(f"#define SC_{macro(set_name)}_{macro(v['name'])} "
                         f"{v['value']}")
    lines.append("")

    for c in desc["commands"]:
        cname = macro(c["name"])
        lines.append(f"#define SC_CMD_{cname} 0x{c['opcode']:02x}")
        lo, hi = cmd_lengths(desc, c)
        lines.append(f"#define SC_CMD_{cname}_MINLEN {lo}")
        lines.append(f"#define SC_CMD_{cname}_MAXLEN {hi}")
    lines.append("")

    lines += [
        "#ifdef SC_WANT_UUIDS",
        "#include <zephyr/bluetooth/uuid.h>",
        f"#define SC_SERVICE_UUID BT_UUID_DECLARE_128({uuid_macro(desc['service'])})",
    ]
    for name, ch in desc["characteristics"].items():
        lines.append(f"#define SC_CHR_{macro(name)}_UUID "
                     f"BT_UUID_DECLARE_128({uuid_macro(ch['uuid'])})")
    lines += [
        "#endif /* SC_WANT_UUIDS */",
        "",
        "#endif /* SIDCLOCK_PROTO_GEN_H_ */",
        "",
    ]
    return "\n".join(lines)


def descriptor_entry(desc, caps, file_name, dev=False):
    return {
        "firmware": desc["firmware"],
        "protocol": desc["protocol"],
        "layout": f"{layout(desc):04x}",
        "file": f"versions/{file_name}",
        "legacy": desc.get("legacy"),
        "features": desc["features"],
        "dev": bool(dev),
    }


def collect():
    """Return (current, frozen dict, index descriptors)."""
    current = load_json(os.path.join(PROTO, "current.json"))
    validate(current)
    frozen = {}
    if os.path.isdir(VERSIONS):
        for name in sorted(os.listdir(VERSIONS)):
            if not name.endswith(".json"):
                continue
            desc = load_json(os.path.join(VERSIONS, name))
            validate(desc)
            frozen[desc["firmware"]] = desc
            if name != desc["firmware"] + ".json":
                die(f"protocol/versions/{name}: firmware is "
                    f"{desc['firmware']}")
    return current, frozen


def build_index(current, frozen, caps):
    entries = []
    for fw in sorted(frozen, key=lambda v: semver(v)):
        entries.append(descriptor_entry(frozen[fw], caps, f"{fw}.json"))
    fw = current["firmware"]
    if fw in frozen:
        # The current descriptor must match what was frozen for this
        # version; otherwise the release was edited after freezing.
        if json.dumps(current, sort_keys=True) != json.dumps(
                frozen[fw], sort_keys=True):
            die(f"protocol/current.json differs from frozen "
                f"protocol/versions/{fw}.json; bump the firmware version "
                "and freeze it")
    else:
        entries.append(descriptor_entry(current, caps, f"{fw}.json",
                                        dev=True))
    entries.sort(key=lambda e: (e["protocol"], semver(e["firmware"])))
    latest = max(entries, key=lambda e: (e["protocol"],
                                         semver(e["firmware"])))
    return {
        "schema": 1,
        "latest": latest["firmware"],
        "capability_bits": caps,
        "versions": entries,
    }, entries


def expected_files(current, frozen, caps):
    """Return {relative path: contents} for everything --emit writes."""
    index, entries = build_index(current, frozen, caps)
    files = {
        os.path.relpath(HEADER, ROOT): emit_header(current, caps),
        os.path.relpath(os.path.join(PROTO, "index.json"), ROOT):
            dump_json(index),
    }
    for e in entries:
        fw = e["firmware"]
        src = frozen.get(fw, current if fw == current["firmware"] else None)
        if src is None:
            die(f"no descriptor for {fw}")
        files[os.path.relpath(
            os.path.join(VERSIONS, f"{fw}.json"), ROOT)] = dump_json(src)
    return files, index


def write_files(files):
    for rel, text in files.items():
        path = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(text)


def read_version():
    with open(BUILD_SH) as fh:
        for line in fh:
            m = re.match(r'^VERSION="([^"]+)"\s*$', line)
            if m:
                return m.group(1)
    die("VERSION not found in app/build.sh")


def cmd_check(require_version=None):
    current, frozen = collect()
    caps = load_caps()
    if require_version is None:
        require_version = read_version()
    if current["firmware"] != require_version:
        die(f"protocol/current.json is {current['firmware']}, but "
            f"app/build.sh VERSION is {require_version}")
    files, _ = expected_files(current, frozen, caps)
    bad = []
    for rel, text in files.items():
        path = os.path.join(ROOT, rel)
        try:
            with open(path) as fh:
                have = fh.read()
        except FileNotFoundError:
            bad.append(f"{rel}: missing")
            continue
        if have != text:
            bad.append(f"{rel}: differs")
    if bad:
        die("generated protocol files are out of date:\n  " +
            "\n  ".join(bad) + "\nrun tools/proto_gen.py emit")
    print("protocol: ok")


def stage_web(quiet=False):
    """Copy the descriptors the static page serves into web/protocol/.

    The page is deployed as the web/ directory alone, so it can only fetch
    files below it.  The copies are generated, never edited: this runs at
    deploy and serve time, and web/protocol/ is gitignored.
    """
    dst_versions = os.path.join(WEB_PROTO, "versions")
    os.makedirs(dst_versions, exist_ok=True)
    for name in os.listdir(dst_versions):
        if name.endswith(".json") and not os.path.exists(
                os.path.join(VERSIONS, name)):
            os.unlink(os.path.join(dst_versions, name))
    shutil.copyfile(os.path.join(PROTO, "index.json"),
                    os.path.join(WEB_PROTO, "index.json"))
    n = 1
    for name in sorted(os.listdir(VERSIONS)):
        if name.endswith(".json"):
            shutil.copyfile(os.path.join(VERSIONS, name),
                            os.path.join(dst_versions, name))
            n += 1
    if not quiet:
        print(f"protocol: staged {n} files for the web remote")
    return n


def cmd_stage():
    stage_web()


def cmd_emit(require_version=None):
    current, frozen = collect()
    caps = load_caps()
    if require_version is not None and current["firmware"] != require_version:
        die(f"protocol/current.json is {current['firmware']}, but "
            f"VERSION is {require_version}")
    files, _ = expected_files(current, frozen, caps)
    write_files(files)
    print(f"protocol: wrote {len(files)} files for "
          f"{current['firmware']} (protocol {current['protocol']})")


def cmd_freeze(version):
    current, _ = collect()
    if current["firmware"] != version:
        die(f"current.json is {current['firmware']}, not {version}; "
            "bump it first")
    # The frozen copy must be byte-identical to current.json (build_index
    # refuses a release whose descriptor was edited after freezing). The
    # layout id lives in index.json, computed from the descriptor, not in
    # the descriptor itself.
    path = os.path.join(VERSIONS, f"{version}.json")
    os.makedirs(VERSIONS, exist_ok=True)
    with open(path, "w") as fh:
        fh.write(dump_json(current))
    # Re-read through the normal path so the emitted files use it too.
    cmd_emit(require_version=version)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_check = sub.add_parser("check")
    p_check.add_argument("--require-version", default=None)
    p_emit = sub.add_parser("emit")
    p_emit.add_argument("--require-version", default=None)
    p_freeze = sub.add_parser("freeze")
    p_freeze.add_argument("--version", required=True)
    sub.add_parser("stage", help="copy the descriptors into web/protocol/ "
                                 "(deploy/serve time; gitignored)")
    args = ap.parse_args()
    if args.cmd == "check":
        cmd_check(args.require_version)
    elif args.cmd == "emit":
        cmd_emit(args.require_version)
    elif args.cmd == "stage":
        cmd_stage()
    else:
        cmd_freeze(args.version)


if __name__ == "__main__":
    main()
