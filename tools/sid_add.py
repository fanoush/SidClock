#!/usr/bin/env python3
"""Add SID tunes to a SidClock device with correct song lengths.

For every FILE.sid given:
  - computes the HVSC fingerprint (libsidplayfp PSID::createMD5: the C64
    data without the embedded load address, plus init/play/songs, the
    per-song speed bytes and the NTSC flag),
  - looks it up in the HVSC Songlengths database,
  - writes a .len sidecar (seconds per subsong, what the firmware reads),
  - writes a .stil sidecar (subsong names, per-subsong and tune comments),
  - keeps a copy of the tune + sidecars in the archive directory,
  - uploads them to /home on the device over BLE (MCUmgr fs_mgmt).

The device plays /home in file name order and uses <name>.len to know when a
subsong has ended (END mode: LOOP / NEXT TUNE / NEXT SUB), so all files must
share the stem: Commando.sid -> Commando.len.

Usage:
  tools/sid_add.py MyTune.sid                 # upload + archive
  tools/sid_add.py --no-upload *.sid          # only generate .len files
  tools/sid_add.py --name 4.sid MyTune.sid    # override the device name

The databases (Songlengths.txt and STIL.txt, from hvsc.c64.org) are expected
in the archive directory (default: <repo>/sids/).
"""

import argparse
import hashlib
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / "sids"
DB_DEFAULT = ARCHIVE / "Songlengths.txt"
STIL_DEFAULT = ARCHIVE / "STIL.txt"

# Device .stil limits: keep in sync with the firmware sidecar buffer
# (SID_STIL_MAX = 3072 in app/src/main.c).
SID_STIL_NAME_CHARS = 24
SID_STIL_TUNE_CHARS = 200
SID_STIL_NOTE_CHARS = 160
SID_STIL_MAX_BYTES = 3000


def sid_md5(d: bytes) -> str:
    """HVSC song-lengths fingerprint (libsidplayfp PSID::createMD5)."""
    offs = (d[6] << 8) | d[7]
    load = (d[8] << 8) | d[9]
    init = (d[0xA] << 8) | d[0xB]
    play = (d[0xC] << 8) | d[0xD]
    songs = (d[0xE] << 8) | d[0xF]
    speed = struct.unpack(">I", d[0x12:0x16])[0]
    flags = (d[0x76] << 8) | d[0x77]
    clock = (flags >> 2) & 3

    data = d[offs + 2:] if load == 0 else d[offs:]
    blob = data + struct.pack("<HHH", init, play, songs)
    blob += bytes((speed >> s) & 1 for s in range(songs))
    if clock == 2:  # NTSC changes the fingerprint
        blob += b"\x02"
    return hashlib.md5(blob).hexdigest()


def load_db(path: Path) -> dict:
    db = {}
    last_path = "?"
    for line in open(path, encoding="latin-1"):
        line = line.strip()
        if not line:
            continue
        if line.startswith(";"):
            last_path = line[1:].strip()
        elif "=" in line:
            h, v = line.split("=", 1)
            db[h.lower()] = (last_path, v)
    return db


def load_stil(path: Path) -> dict:
    """HVSC STIL.txt -> {path: {"names": {1-based subsong: name},
    "comment": tune comment, "subs": {1-based subsong: comment}}}
    (fields may wrap across lines)."""
    keys = ("TITLE", "NAME", "AUTHOR", "ARTIST", "PUBLISHER", "COMMENT",
            "RELEASED", "MUSIC", "INFO", "COVER")
    entries = {}
    cur = None
    sub = 0
    field = None
    text = []

    def flush_field():
        nonlocal field, text
        if cur is None or field is None:
            field, text = None, []
            return
        joined = " ".join(t.strip() for t in text).strip()
        joined = joined.strip('"').strip()
        if field == "COMMENT":
            if sub == 0:
                if not entries[cur]["comment"]:
                    entries[cur]["comment"] = joined
                else:
                    entries[cur]["comment"] += " " + joined
            elif joined:
                subs = entries[cur]["subs"]
                if sub in subs:
                    subs[sub] += " " + joined
                else:
                    subs[sub] = joined
        else:  # NAME / TITLE
            if sub > 0 and sub not in entries[cur]["names"] and joined:
                entries[cur]["names"][sub] = joined
        field, text = None, []

    for line in open(path, encoding="latin-1"):
        raw = line.rstrip("\n")
        stripped = raw.strip()
        if not stripped:
            flush_field()
            continue
        if raw.startswith("/") or raw.startswith("\\"):
            flush_field()
            cur = stripped
            entries[cur] = {"names": {}, "comment": "", "subs": {}}
            sub = 0
            continue
        if stripped.startswith("(#") and stripped.endswith(")"):
            flush_field()
            try:
                sub = int(stripped[2:-1])
            except ValueError:
                sub = 0
            continue
        matched = False
        for key in keys:
            if stripped.startswith(key + ":"):
                flush_field()
                field = key
                text = [stripped[len(key) + 1:]]
                matched = True
                break
        if not matched and field is not None:
            text.append(stripped)
        elif not matched:
            flush_field()
    flush_field()
    return entries


def strip_time_range(s: str) -> str:
    import re

    return re.sub(r"\s*\(\d+:\d+[-–]?\d*:?\d*\)\s*$", "", s).strip()


def build_stil(entry: dict, songs: int) -> str:
    """Device .stil: `songs` name lines, the tune comment, then optional
    `@<subsong> <comment>` lines carrying HVSC's per-subsong notes."""
    lines = []
    for i in range(1, songs + 1):
        name = entry["names"].get(i, "")
        lines.append(strip_time_range(name)[:SID_STIL_NAME_CHARS])
    comment = " ".join(entry["comment"].split())
    lines.append(comment[:SID_STIL_TUNE_CHARS])
    used = sum(len(line) + 1 for line in lines)
    for sub in sorted(entry.get("subs", {})):
        text = " ".join(entry["subs"][sub].split())
        if not text:
            continue
        line = f"@{sub} {text[:SID_STIL_NOTE_CHARS]}"
        if used + len(line) + 1 > SID_STIL_MAX_BYTES:
            break  # rare: too many/long notes for the device buffer
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines) + "\n"


def parse_lengths(v: str):
    out = []
    for tok in v.split():
        if ":" in tok:
            m, s = tok.split(":")
            out.append(int(float(m) * 60 + float(s) + 0.5))
        else:
            out.append(0)
    return out


def smpmgr_bin() -> str:
    return (os.environ.get("SMPMGR")
            or shutil.which("smpmgr")
            or os.path.expanduser("~/.local/bin/smpmgr"))


def upload(addr: str, local: Path, remote: str, quiet=True) -> bool:
    for _ in range(3):
        try:
            r = subprocess.run(
                [smpmgr_bin(), "--ble", addr, "file", "upload",
                 str(local), remote],
                capture_output=True, text=True, timeout=300)
            if r.returncode == 0:
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", help="local .sid file(s)")
    ap.add_argument("--addr", default=None,
                    help="device BLE address (default: $SIDCLOCK_ADDR)")
    ap.add_argument("--db", default=str(DB_DEFAULT), help="Songlengths.txt path")
    ap.add_argument("--stil", default=str(STIL_DEFAULT), help="STIL.txt path")
    ap.add_argument("--dir", default=str(ARCHIVE), help="archive directory")
    ap.add_argument("--name", help="override the device file name (single input)")
    ap.add_argument("--meta-only", action="store_true",
                    help="only write/upload the .len/.stil sidecars")
    ap.add_argument("--no-upload", action="store_true",
                    help="only create .len/.stil files, do not use BLE")
    args = ap.parse_args()

    if args.name and len(args.files) != 1:
        ap.error("--name needs exactly one input file")
    if not args.no_upload:
        args.addr = args.addr or os.environ.get("SIDCLOCK_ADDR")
        if not args.addr:
            ap.error("pass --addr, set $SIDCLOCK_ADDR, or use --no-upload")

    archive = Path(args.dir)
    archive.mkdir(parents=True, exist_ok=True)
    db = load_db(Path(args.db))
    stil = load_stil(Path(args.stil)) if Path(args.stil).exists() else {}
    rc = 0

    for src in args.files:
        src = Path(src)
        data = src.read_bytes()
        if data[:4] not in (b"PSID", b"RSID"):
            print(f"{src.name}: not a PSID/RSID file - skipped")
            rc = 1
            continue

        name = args.name or src.name
        if not name.endswith(".sid"):
            print(f"{src.name}: name must end in .sid (use --name)")
            rc = 1
            continue

        songs = (data[0xE] << 8) | data[0xF]
        fp = sid_md5(data)
        entry = db.get(fp)

        # archive copy
        dst_sid = archive / name
        if src.resolve() != dst_sid.resolve():
            shutil.copyfile(src, dst_sid)

        dst_len = archive / (name[:-4] + ".len")
        dst_stil = archive / (name[:-4] + ".stil")
        path = None
        if entry:
            path, v = entry
            lens = parse_lengths(v)
            if len(lens) > 32:
                print(f"  note: {len(lens)} lengths, firmware keeps 32")
                lens = lens[:32]
            dst_len.write_text(" ".join(str(x) for x in lens) + "\n")
            print(f"{name}: {path}")
            print(f"  lengths: {v}")
        else:
            print(f"{name}: not in the Songlengths database "
                  f"(fingerprint {fp}) - no .len created")
            if dst_len.exists():
                dst_len.unlink()

        # STIL metadata (subsong names + tune comment), matched by the
        # same path the Songlengths entry points at
        if path and path in stil:
            se = stil[path]
            txt = build_stil(se, songs)
            dst_stil.write_text(txt)
            names = sum(1 for i in range(1, songs + 1) if se["names"].get(i))
            notes = len(se.get("subs", {}))
            extra = ", comment" if se["comment"] else ""
            if notes:
                extra += f", {notes} sub note{'s' if notes != 1 else ''}"
            print(f"  stil: {names}/{songs} subsong names{extra}"
                  f" -> {dst_stil.name}")
        else:
            print(f"  stil: no STIL entry for this tune")
            if dst_stil.exists():
                dst_stil.unlink()

        if args.no_upload:
            continue

        ok1 = True if args.meta_only else upload(args.addr, dst_sid, f"/home/{name}")
        ok2 = True
        if dst_len.exists():
            ok2 = upload(args.addr, dst_len, f"/home/{dst_len.name}")
        ok3 = True
        if dst_stil.exists():
            ok3 = upload(args.addr, dst_stil, f"/home/{dst_stil.name}")
        print(f"  upload: {'' if args.meta_only else name + ' '}"
              f"{'' if args.meta_only else ('OK' if ok1 else 'FAILED')}, "
              f"len {'-' if not dst_len.exists() else ('OK' if ok2 else 'FAILED')}, "
              f"stil {'-' if not dst_stil.exists() else ('OK' if ok3 else 'FAILED')}")
        if not (ok1 and ok2 and ok3):
            rc = 1

    return rc


if __name__ == "__main__":
    sys.exit(main())
