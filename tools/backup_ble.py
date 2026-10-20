#!/usr/bin/env python3
"""Read-only BLE backup of a Saphe T device (stock firmware).

Collects everything obtainable without writing to the device:

  * advertising data (name, service UUIDs, manufacturer data)
  * full GATT tree: services, characteristics, properties, and the value of
    every readable characteristic (DIS strings are decoded)
  * MCUmgr image state (read)
  * the /home LittleFS files via MCUmgr fs_mgmt (read-size + download)

Keep the result: the Device Information strings (Model Number, Serial
Number, revisions) mirror identity values stored in the chip's one-time
(UICR) area, which the SWD unlock erase destroys - they are needed if the
original application is ever flashed back. Nothing is ever
written/uploaded/deleted on the device.

Usage:

  tools/backup_ble.py --addr AA:BB:CC:DD:EE:FF
  tools/backup_ble.py --name "Saphe T"       # scan by advertised name
  tools/backup_ble.py --addr ... --outdir backups/unit2

The stock device advertises as "Saphe T". --name is a case-insensitive
substring match (so --name Saphe also matches); quote it on the shell when
it contains a space.
"""

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime

from bleak import BleakClient, BleakScanner


class _QuietClient(BleakClient):
    """BleakClient that ignores the error BlueZ can raise on disconnect.

    When the walk ends (or the device resets) the link often drops before
    bleak disconnects it; that exception would only add a traceback after
    all the work is already done and saved.
    """

    async def __aexit__(self, *exc):
        try:
            await super().__aexit__(*exc)
        except Exception:
            pass

SMPMGR = (os.environ.get("SMPMGR")
          or shutil.which("smpmgr")
          or os.path.expanduser("~/.local/bin/smpmgr"))

DIS_NAMES = {
    "00002a29": "Manufacturer Name",
    "00002a24": "Model Number",
    "00002a25": "Serial Number",
    "00002a26": "Firmware Revision",
    "00002a27": "Hardware Revision",
    "00002a28": "Software Revision",
    "00002a23": "System ID",
    "00002a2a": "IEEE Regulatory Cert",
    "00002a50": "PnP ID",
}

KNOWN_FILES = [
    "/home/db/lifetime.bin",
    "/home/db/stat_log.bin",
    "/home/db/acc_info.bin",
    "/home/flags/flags.bin",
    "/home/prod/selftest.bin",
    "/home/LOGO.BIN",
]
KNOWN_FILES += [f"/home/db/speed_log{i:02d}.bin" for i in range(16)]
KNOWN_FILES += [f"/home/db/acc_log{i:02d}.bin" for i in range(16)]
KNOWN_FILES += [f"/home/db/acc_log{i}.bin" for i in range(1, 10)]


def log(msg):
    print(msg, flush=True)


async def find_device(addr, name):
    log("scanning ...")
    found = {}
    for d, adv in (await BleakScanner.discover(timeout=15,
                                               return_adv=True)).values():
        found[d.address.upper()] = (d, adv)
    if addr:
        hit = found.get(addr.upper())
        if hit:
            return hit
        log(f"address {addr} not seen, retrying with longer scan ...")
        for d, adv in (await BleakScanner.discover(timeout=20,
                                                   return_adv=True)).values():
            if d.address.upper() == addr.upper():
                return d, adv
        return None
    for d, adv in found.values():
        if d.name and name.lower() in d.name.lower():
            return d, adv
    return None


def smpmgr(args, timeout=120):
    try:
        r = subprocess.run([SMPMGR, "--ble", ADDR, *args], timeout=timeout,
                           capture_output=True, text=True)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return -1, "TIMEOUT"


async def gatt_backup(d, adv, outdir):
    os.makedirs(outdir, exist_ok=True)

    adv_info = {
        "local_name": adv.local_name,
        "service_uuids": list(adv.service_uuids),
        "manufacturer_data": {hex(k): v.hex()
                              for k, v in adv.manufacturer_data.items()},
        "service_data": {k: v.hex() for k, v in adv.service_data.items()},
        "rssi": adv.rssi,
    }
    log(f"advertising: {json.dumps(adv_info)}")
    with open(os.path.join(outdir, "advertising.json"), "w") as f:
        json.dump(adv_info, f, indent=2)

    gatt = []
    lines = [f"GATT tree of {d.address} {d.name!r}",
             f"backed up {datetime.now().isoformat()}", ""]
    async with _QuietClient(d, timeout=30) as c:
        for s in c.services:
            svc = {"uuid": s.uuid, "description": s.description, "chars": []}
            lines.append(f"service {s.uuid}  {s.description}")
            for ch in s.characteristics:
                entry = {"uuid": ch.uuid, "properties": list(ch.properties)}
                value = None
                if "read" in ch.properties:
                    try:
                        raw = await c.read_gatt_char(ch)
                        value = raw.hex()
                        entry["value_hex"] = value
                        key = ch.uuid[:8]
                        if key in DIS_NAMES:
                            txt = raw.decode("utf-8", "replace").strip("\x00")
                            entry["text"] = txt
                            lines.append(f"  char {ch.uuid}  [{','.join(ch.properties)}]"
                                         f"  {DIS_NAMES[key]} = {txt!r}")
                        else:
                            lines.append(f"  char {ch.uuid}  [{','.join(ch.properties)}]"
                                         f"  = {value}")
                    except Exception as e:
                        entry["read_error"] = str(e)
                        lines.append(f"  char {ch.uuid}  [{','.join(ch.properties)}]"
                                     f"  READ FAILED: {e}")
                else:
                    lines.append(f"  char {ch.uuid}  [{','.join(ch.properties)}]")
                svc["chars"].append(entry)
            gatt.append(svc)

    with open(os.path.join(outdir, "gatt.json"), "w") as f:
        json.dump(gatt, f, indent=2)
    with open(os.path.join(outdir, "gatt.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
    log(f"GATT: {len(gatt)} services saved to {outdir}/gatt.txt")


def fs_backup(outdir):
    fsdir = os.path.join(outdir, "files")
    os.makedirs(fsdir, exist_ok=True)
    manifest = []
    for path in KNOWN_FILES:
        rc, out = smpmgr(["file", "read-size", path], timeout=40)
        m = re.findall(r"(\d[\d]*)", out.strip().splitlines()[-1]
                       if out.strip() else "")
        if rc != 0 or not m:
            manifest.append({"path": path, "exists": False})
            continue
        size = int(m[-1])
        dest = os.path.join(fsdir, path.strip("/").replace("/", "_"))
        rc2, out2 = smpmgr(["file", "download", path, dest], timeout=600)
        ok = rc2 == 0 and os.path.exists(dest)
        md5 = None
        if ok:
            with open(dest, "rb") as f:
                md5 = hashlib.md5(f.read()).hexdigest()
        manifest.append({"path": path, "exists": True, "size": size,
                         "downloaded": ok, "md5": md5})
        log(f"  {path}: {size} B -> {'ok' if ok else 'DOWNLOAD FAILED'}")
    with open(os.path.join(outdir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    got = sum(1 for e in manifest if e.get("downloaded"))
    log(f"files: {got}/{len(KNOWN_FILES)} downloaded")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--addr", default=None)
    ap.add_argument(
        "--name", default="Saphe",
        help="advertised name, case-insensitive substring "
             "(the stock device advertises as 'Saphe T')",
    )
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()

    d, adv = asyncio.run(find_device(args.addr, args.name))
    if not d:
        log("device not found")
        return 1
    log(f"target: {d.address} {d.name!r}")

    global ADDR
    ADDR = d.address
    outdir = args.outdir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "backups",
        f"{d.name.replace(' ', '_')}_{d.address.replace(':', '')}")
    log(f"output: {outdir}")

    asyncio.run(gatt_backup(d, adv, outdir))

    rc, out = smpmgr(["image", "state-read"], timeout=40)
    with open(os.path.join(outdir, "image-state.txt"), "w") as f:
        f.write(out)
    log("image state:\n" + out.strip())

    log("\nfilesystem (read-only):")
    fs_backup(outdir)
    log("\nbackup complete (nothing was written to the device)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
