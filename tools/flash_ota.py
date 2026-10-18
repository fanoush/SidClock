#!/usr/bin/env python3
"""Flash a SidClock build over BLE (MCUmgr/SMP) and arm it for the next boot.

The image goes into slot 1 (the OTA slot on the external flash) and is marked
as a *test* swap: MCUboot boots it on the next reset, the app confirms itself
on the way up, and a bad image is reverted instead of sticking.

Arming does not reboot anything - the device keeps running the old image until
the next reset, whenever that happens:

  tools/flash_ota.py           # upload + arm ("applies on the next reset")
  tools/flash_ota.py --now     # upload + arm + reset, wait for the new image

The reset is the only way MCUboot can swap the slots, so `--now` costs one
boot - the one that lands on the new image. Without it a flash costs no boots
at all, but the new image waits for a reset (yours, a watchdog reset, or the
next power cycle).

This is also what `smpmgr --ble <addr> upgrade --slot 1 <bin>` does in one
command. Plain `smpmgr upgrade <bin>` (the default `--slot 0`) uploads *and
reboots without arming* the image - that is why a device updated that way
comes back on the old version; the upload is not lost, it just needs
`image state-write <hash>` before a reset (see docs/ota.md).

Device address (in order): --addr, $SIDCLOCK_ADDR, or a scan for a device
advertising as "SidClock". Needs smpmgr's dependencies - smpclient and bleak
(`tools/smpmgr/install.sh` installs them).

Re-flashing the image that is already running is a no-op: the device refuses
to mark it (its hash resolves to the active slot, and testing the active slot
is not allowed), and there is nothing to apply anyway - the script says so
instead of failing.

Examples:
  tools/flash_ota.py                      # arm app/build/zephyr/zephyr.signed.bin
  tools/flash_ota.py --now                # arm it and boot it
  tools/flash_ota.py -a AA:BB:CC:DD:EE:FF my.signed.bin
"""

import argparse
import asyncio
import logging
import os
import sys
import time
from pathlib import Path

try:
    from smpclient import SMPClient
    from smpclient.generics import error
    from smpclient.mcuboot import IMAGE_TLV, ImageInfo
    from smpclient.requests.image_management import (
        ImageStatesRead,
        ImageStatesWrite,
    )
    from smpclient.requests.os_management import ResetWrite
    from smpclient.transport.ble import SMPBLETransport
except ImportError as exc:  # pragma: no cover - dependency hint
    raise SystemExit(
        f"smpclient is not installed ({exc}) - run tools/smpmgr/install.sh"
    )

REPO = Path(__file__).resolve().parent.parent
DEFAULT_IMAGE = REPO / "app" / "build" / "zephyr" / "zephyr.signed.bin"

# A dropped link is part of the flow (the device reboots, and the reconnect
# loop probes while MCUboot is still swapping), so the transport's "Disconnected
# from ..." warning is noise here. Real failures are reported below.
logging.getLogger("smpclient.transport.ble").setLevel(logging.ERROR)


def log(msg=""):
    print(msg, flush=True)


def short(hashbytes):
    """First 8 bytes of an image hash, for one-line messages."""
    return hashbytes.hex().upper()[:16] + "..." if hashbytes else "?"


async def image_states(client):
    """Read both slots' state; one line of error instead of a traceback."""
    try:
        r = await client.request(ImageStatesRead())
    except asyncio.TimeoutError:
        raise SystemExit("the device did not answer the image state read")
    if error(r):
        raise SystemExit(f"reading the image state failed: {r}")
    return list(r.images)


def pick(states, active=None, slot=None):
    for st in states:
        if active is not None and bool(st.active) != active:
            continue
        if slot is not None and st.slot != slot:
            continue
        return st
    return None


async def wait_for_new_image(addr, want, before, sec_slot, timeout_s):
    """Wait out the reset + swap; returns the new active state or None.

    During the swap the device is in MCUboot and not advertising, so the loop
    simply reconnects until the app answers again. Two findings are handled
    explicitly: the old image answering with the update *still armed* means the
    reset never happened - it is sent again; the old image answering with the
    slot no longer pending means MCUboot booted the test image, it failed, and
    the swap was rolled back - that is reported and given up.
    """
    deadline = time.time() + timeout_s
    reverts = 0
    retries = 0
    while True:
        client = None
        try:
            client = SMPClient(SMPBLETransport(), addr, timeout_s=5.0)
            await client.connect(connect_timeout_s=6.0)
            states = await image_states(client)
            act = pick(states, active=True)
            if act is not None and bytes(act.hash) == want:
                return act
            if act is not None and before is not None and \
                    bytes(act.hash) == before:
                sec = pick(states, slot=sec_slot)
                if sec is not None and sec.pending:
                    if retries < 2:
                        retries += 1
                        log("  still on the old image with the update armed "
                            "- resetting again")
                        try:
                            await client.request(ResetWrite(), timeout_s=3.0)
                        except (asyncio.TimeoutError, OSError):
                            pass
                else:
                    reverts += 1
                    if reverts >= 2:
                        raise SystemExit(
                            "the device came back on the old image and the "
                            "new one is no longer pending: MCUboot reverted "
                            "the test swap - check the boot log (tools/"
                            "sidclock_ble.py log --peek)"
                        )
        except SystemExit:
            raise
        except Exception:
            pass  # device still swapping / not advertising yet
        finally:
            if client is not None:
                try:
                    await client.disconnect()
                except Exception:
                    pass
        if time.time() > deadline:
            return None
        await asyncio.sleep(3.0)


async def upload_and_arm(client, data, want, sec):
    """Upload into the secondary slot and mark it for the next boot.

    Returns the freshly read state of that slot.
    """
    log("uploading ...")
    tty = sys.stdout.isatty()
    last = 0
    try:
        async for off in client.upload(data, slot=0):
            pct = off * 100 // max(len(data), 1)
            if tty:
                if pct != last:
                    print(f"\r  {pct:3d} %", end="", flush=True)
                    last = pct
            elif pct >= last + 10:
                log(f"  {pct:3d} %")
                last = pct
    except asyncio.TimeoutError:
        raise SystemExit("the upload timed out - is the link busy?")
    except OSError as exc:
        raise SystemExit(f"the link dropped during the upload ({exc})")
    if tty:
        print("\r  100 %")
    elif last < 100:
        log("  100 %")

    states = await image_states(client)
    sec = pick(states, slot=sec.slot)
    if sec is None or bytes(sec.hash) != want:
        got = short(sec.hash) if sec is not None else "nothing"
        raise SystemExit(
            f"the upload did not land: slot {sec.slot if sec else '?'} "
            f"holds {got}, expected {short(want)}"
        )
    log(f"slot {sec.slot}: uploaded")

    try:
        r = await client.request(ImageStatesWrite(hash=want, confirm=False))
    except asyncio.TimeoutError:
        raise SystemExit("the device did not answer the arm request")
    if error(r):
        raise SystemExit(f"the device refused to arm the image: {r}")

    states = await image_states(client)
    sec = pick(states, slot=sec.slot)
    if sec is None or not sec.pending:
        raise SystemExit(
            "the image was not marked pending - a reset would boot the old "
            "image again"
        )
    log(f"slot {sec.slot}: armed for a test swap (pending=True)")
    return sec


async def flash(args):
    image = Path(args.image).expanduser()
    if not image.is_file():
        raise SystemExit(f"image not found: {image} - run app/build.sh first")
    try:
        info = ImageInfo.load_file(str(image))
        want = info.get_tlv(IMAGE_TLV.SHA256).value
    except Exception as exc:
        raise SystemExit(f"{image} is not a signed MCUboot image ({exc})")
    data = image.read_bytes()
    log(f"image:   {image} ({len(data)} B, version {info.header.ver}, "
        f"sha256 {short(want)})")

    client = SMPClient(SMPBLETransport(), args.addr, timeout_s=args.timeout)
    try:
        await client.connect(connect_timeout_s=args.connect_timeout)
    except Exception as exc:
        raise SystemExit(
            f"could not reach {args.addr} ({exc.__class__.__name__}) - "
            "device off, BLE access not R/W, or another central connected?"
        )

    try:
        states = await image_states(client)
        act = pick(states, active=True)
        sec = pick(states, active=False)
        if act is None or sec is None:
            raise SystemExit("the device reported no active/secondary slot pair")
        log(f"running: slot {act.slot} {short(act.hash)} "
            f"(confirmed={act.confirmed})")
        log(f"target:  slot {sec.slot} {short(sec.hash)} "
            f"(pending={sec.pending}, confirmed={sec.confirmed})")
        before = bytes(act.hash)

        if before == want:
            # An image that is already the running one cannot be marked for a
            # test swap: the hash resolves to the active slot, and Zephyr
            # refuses "test the active slot" (IMG_MGMT_ERR_IMAGE_SETTING_
            # TEST_TO_ACTIVE_DENIED). There is nothing to apply either way.
            log("the device already runs this image - nothing to upload")
        else:
            sec = await upload_and_arm(client, data, want, sec)

        if not args.now:
            log()
            if before == want:
                log("done - nothing to do (--now would just reboot it).")
            else:
                log("done - the device is still running the old image. The new")
                log("one boots on the next reset; use --now to reset now, or:")
                log(f"  smpmgr --ble {args.addr} os reset")
            return

        log("resetting ...")
        try:
            await client.request(ResetWrite(), timeout_s=3.0)
        except (asyncio.TimeoutError, OSError):
            pass  # expected: the device reboots before it can answer
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass

    log(f"waiting for the device to come back (swap takes a few seconds, "
        f"up to {args.wait:.0f} s) ...")
    act = await wait_for_new_image(args.addr, want, before, sec.slot, args.wait)
    if act is None:
        raise SystemExit(
            f"the device did not answer with the new image within "
            f"{args.wait:.0f} s - check it (tools/sidclock_ble.py status)"
        )
    log(f"booted: slot {act.slot} now runs {short(act.hash)} "
        f"(confirmed={act.confirmed})")
    log()
    log("the wall clock is unset after a reset:  tools/sidclock_ble.py set-time")
    log("boot log (MCUboot's lines first):       tools/sidclock_ble.py log --peek")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "image", nargs="?", default=str(DEFAULT_IMAGE),
        help="MCUboot-signed image (default: app/build/zephyr/zephyr.signed.bin)",
    )
    ap.add_argument(
        "-a", "--addr", default=None,
        help="BLE address or name; default: $SIDCLOCK_ADDR, else a scan for "
             "'SidClock'",
    )
    ap.add_argument(
        "--now", action="store_true",
        help="reset the device after arming, so MCUboot swaps the slots and "
             "boots the new image (one boot)",
    )
    ap.add_argument(
        "--wait", type=float, default=90.0, metavar="SEC",
        help="'--now': how long to wait for the device to come back "
             "(default: 90)",
    )
    ap.add_argument(
        "--timeout", type=float, default=5.0, metavar="SEC",
        help="SMP request timeout (default: 5)",
    )
    ap.add_argument(
        "--connect-timeout", type=float, default=15.0, metavar="SEC",
        help="BLE scan/connect timeout (default: 15)",
    )
    args = ap.parse_args()
    if not args.addr:
        args.addr = os.environ.get("SIDCLOCK_ADDR") or "SidClock"

    try:
        asyncio.run(flash(args))
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
