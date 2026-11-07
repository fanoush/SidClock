#!/usr/bin/env python3
"""Write the firmware update manifest the web remote reads.

The web remote checks for updates by fetching `firmware/index.json` next to
the page and comparing the connected firmware's version with the release
published there. GitHub release assets cannot be fetched by a browser (the
redirect to release-assets.githubusercontent.com sends no CORS headers),
while GitHub Pages does, so the release workflow copies the signed image
into the Pages artifact and this tool writes the manifest beside it:

    tools/fw_manifest.py web/firmware/sidclock-v1.0.10.signed.bin \\
        --page https://github.com/fanoush/SidClock/releases/tag/v1.0.10 \\
        --out web/firmware/index.json

The version, size and hashes all come from the image itself - the MCUboot
header and TLV area are parsed here, so a mis-named file cannot advertise a
version it does not contain. The file name is only used to build the URL.

Without `--out` the manifest is printed, which is handy for checking a build:

    tools/fw_manifest.py app/build/zephyr/zephyr.signed.bin
"""

import argparse
import datetime
import hashlib
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SCHEMA = 1

IMAGE_MAGIC = 0x96F3B83D
IMAGE_HEADER_SIZE = 32
TLV_INFO_MAGIC = 0x6907
TLV_SHA256 = 0x10


def die(msg):
    print(f"fw_manifest: {msg}", file=sys.stderr)
    raise SystemExit(1)


def parse_image(data, name="<image>"):
    """Validate a signed MCUboot image and return its identity."""

    def bad(why):
        raise ValueError(f"{name}: {why}")

    if len(data) < IMAGE_HEADER_SIZE:
        bad("too short to hold an MCUboot header")
    magic, _load, hdr_size, _pad, img_size = struct.unpack_from("<IIHHI", data, 0)
    if magic != IMAGE_MAGIC:
        bad(f"not a signed MCUboot image (magic 0x{magic:08x})")
    if hdr_size < IMAGE_HEADER_SIZE or img_size == 0:
        bad(f"invalid MCUboot header (hdr {hdr_size}, image {img_size})")

    major, minor, revision = struct.unpack_from("<BBH", data, 20)
    build = struct.unpack_from("<I", data, 24)[0]
    version = f"{major}.{minor}.{revision}"

    body_end = hdr_size + img_size
    if body_end + 4 > len(data):
        bad(f"truncated: {len(data)} bytes, the header needs {body_end + 4}")
    if struct.unpack_from("<H", data, body_end)[0] != TLV_INFO_MAGIC:
        bad("missing the MCUboot TLV area")
    # it_tlv_tot counts the whole area, including this 4-byte info header
    tlv_len = struct.unpack_from("<H", data, body_end + 2)[0]
    total = body_end + tlv_len
    if tlv_len < 4 or total != len(data):
        bad(f"unexpected length {len(data)}: the TLV area ends at {total}")

    image_hash = hashlib.sha256(data[:body_end]).hexdigest()
    p = body_end + 4
    tlv_hash = None
    while p + 4 <= total:
        tlv_type = data[p]  # one byte type, one pad byte, two byte length
        length = struct.unpack_from("<H", data, p + 2)[0]
        if p + 4 + length > total:
            bad("truncated TLV entry")
        if tlv_type == TLV_SHA256:
            tlv_hash = data[p + 4:p + 4 + length]
        p += 4 + length
    if p != total:
        bad("the TLV area does not end at the end of the file")
    if tlv_hash is None:
        bad("no SHA-256 TLV (MCUboot could not validate this image)")
    if tlv_hash.hex() != image_hash:
        bad("the SHA-256 TLV does not match the image body")

    return {
        "version": version,
        "build": build,
        "hdr_size": hdr_size,
        "img_size": img_size,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "image_hash": image_hash,
    }


def build_manifest(info, file_name, page=None, now=None):
    latest = {
        "version": info["version"],
        "file": file_name,
        "size": info["size"],
        "sha256": info["sha256"],
        "image_hash": info["image_hash"],
    }
    if info.get("build"):
        latest["build"] = info["build"]
    if page:
        latest["page"] = page
    stamp = now or datetime.datetime.now(datetime.timezone.utc)
    return {
        "schema": SCHEMA,
        "generated": stamp.replace(microsecond=0).isoformat(),
        "latest": latest,
    }


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("image", help="signed MCUboot image (*.signed.bin)")
    ap.add_argument("-o", "--out", default=None,
                    help="write the manifest here (default: print it)")
    ap.add_argument("--file", default=None,
                    help="name the page should fetch (default: the image's "
                         "own file name)")
    ap.add_argument("--page", default=None,
                    help="release page URL, shown as 'release notes'")
    args = ap.parse_args()

    path = os.path.abspath(os.path.expanduser(args.image))
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as e:
        die(f"cannot read {args.image}: {e.strerror}")
    try:
        info = parse_image(data, os.path.basename(path))
    except ValueError as e:
        die(str(e))

    manifest = build_manifest(
        info,
        args.file or os.path.basename(path),
        page=args.page,
    )
    text = json.dumps(manifest, indent=2) + "\n"
    if args.out:
        out = os.path.abspath(os.path.expanduser(args.out))
        parent = os.path.dirname(out)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(out, "w") as fh:
            fh.write(text)
        shown = os.path.relpath(out, ROOT)
        if shown.startswith(os.pardir):
            shown = out
        print(f"{shown}: {info['version']} "
              f"({info['size']} B, sha256 {info['sha256'][:16]}...)",
              flush=True)
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
