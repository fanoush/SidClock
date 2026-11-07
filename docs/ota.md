# Over-the-air updates

The bootloader never speaks BLE. Updates are handled by the running
application, which contains Zephyr's MCUmgr over the standard Bluetooth
SMP service:

```
 app receives the image over BLE
   -> writes it to slot 1 on the external flash
     -> the client marks it for the next boot
       -> reset
         -> MCUboot swaps slot 1 -> slot 0 and boots it
           -> the app confirms the image (or MCUboot reverts a test swap)
```

The upload and the marking are **two separate requests**, and MCUboot can
only swap slots on a reset - so a flash can always be split into "arm now,
apply at the next reset" and never needs a dedicated reboot.

This is **not** the Nordic legacy DFU protocol: `nrfutil dfu ble` and
`.zip` packages do not apply here.

## Client

```sh
tools/smpmgr/install.sh        # installs smpmgr + smpclient + bleak
```

or use any recent `smpmgr` from PyPI.

## Quick flash

`tools/flash_ota.py` wraps the whole sequence (upload, mark, optional
reset, verification) and resolves the device like the other tools:
`--addr`, `$SIDCLOCK_ADDR`, or a scan for a device advertising as
`SidClock`.

```sh
tools/flash_ota.py               # upload + arm; no reboot
tools/flash_ota.py --now         # upload + arm + reset, then wait for the
                                 # new image and verify that it booted
tools/flash_ota.py -a AA:BB:CC:DD:EE:FF other.signed.bin
```

Without `--now` nothing resets the device: the image sits in slot 1,
marked, and it comes up on the *next* reset - yours, a watchdog reset, or
the next power cycle. That is the zero-extra-boot update path: the update
costs no boot at all, it just applies later. `--now` costs exactly one
boot, the one that lands on the new image.

The script prints the running and target hashes, and with `--now` the slot
and hash the device booted. It exits non-zero with a one-line message when
the upload did not land, the device refused the mark, or the new image did
not come back (MCUboot reverted the test swap).

## Procedure (smpmgr)

1. Build the image:

   ```sh
   app/build.sh                 # -> app/build/zephyr/zephyr.signed.bin
   ```

2. Find the device's Bluetooth address (it advertises as `SidClock`):

   ```sh
   bluetoothctl
   scan on
   # note the address of "SidClock", then: scan off / exit
   ```

   or just let the CLI scan for you:

   ```sh
   tools/sidclock_ble.py status --addr AA:BB:CC:DD:EE:FF
   ```

3. Make sure the device is not connected to another central (a second BLE
   connection also blocks the update) and keep it on the charger. The
   screen must show `BLE R/W` (the default after a reboot); in `BLE R/O`
   or `BLE OFF` the update service is not available.

4. Upload and arm in one command:

   ```sh
   smpmgr --ble <addr> upgrade --slot 1 app/build/zephyr/zephyr.signed.bin
   ```

   `--slot 1` makes smpmgr mark the uploaded image for the next boot
   before it resets the device (a *test* swap: MCUboot reverts an image
   that fails to boot, and a good image confirms itself on the way up, so
   the swap sticks). The transfer runs at a boosted link rate (2M PHY,
   15 ms interval, 251-byte data length) and takes a few seconds for a
   ~1 MB image.

   The default `smpmgr --ble <addr> upgrade <bin>` (`--slot 0`) uploads
   and *resets without marking*: MCUboot finds nothing pending and boots
   the old image again, which looks exactly like a failed update. The
   upload is not lost - the bytes are in slot 1 - it just needs the
   marking request before a reset:

   ```sh
   smpmgr --ble <addr> image state-read              # note the slot-1 hash
   smpmgr --ble <addr> image state-write <hash>      # arm it (test swap)
   smpmgr --ble <addr> os reset                      # apply it
   ```

   Marking is persistent: it applies on the next reset, whenever that
   happens (a power cycle counts). `smpmgr --ble <addr> image erase 1`
   drops a staged image without touching slot 0.

5. Check what is running:

   ```sh
   smpmgr --ble <addr> image state-read
   ```

   Slot 0 shows the running image with `confirmed=True` once the app has
   come up; slot 1 holds the image it replaced. The `version` field only
   changes when `VERSION` in `app/build.sh` is bumped, so within a release
   the image hash is the reliable tell (the script prints the same hashes
   in short form).

   `smpmgr --ble <addr> upgrade --confirm <bin>` is the one-command
   variant without `--slot 1`: it marks the image **permanently** instead
   of for a test swap, so MCUboot never reverts a bad image. Use it only
   when the SWD pads (or the serial recovery path) are reachable.

## Web remote

The web remote (`web/`) does the same upload-arm-reboot sequence in the
browser, on top of the same SMP link it already uses for HVSC file
transfers. After every connect it fetches `firmware/index.json` next to the
page, compares the connected firmware with the release it describes, and
offers the update when the device is older:

```
fetch manifest  ->  download the image  ->  verify it in the browser
  -> upload slot 1  ->  check the slot hash  ->  arm a test swap
    -> "firmware X is staged" card with Reboot now / Discard
      -> os reset  ->  poll reconnect  ->  report the new version or a revert
```

- The **manifest and the image live on GitHub Pages**, not on the release
  page. A browser cannot read a GitHub release asset cross-origin (the
  redirect to `release-assets.githubusercontent.com` sends no CORS
  headers), while Pages sends `access-control-allow-origin: *`. The Pages
  workflow copies the latest release's `*.signed.bin` into `web/firmware/`
  and runs `tools/fw_manifest.py` to write the manifest beside it; the
  deploy happens again whenever a release is published.
- `tools/fw_manifest.py` takes the version, size and both hashes **from
  the image itself** (MCUboot header + TLV area), so a mis-named file
  cannot advertise a version it does not contain. `build.yml` runs the
  same parser on every built image.
- The page verifies the header and TLV structure, the SHA-256 TLV against
  the image body, the whole-file SHA-256 and size against the manifest,
  and the version. The image hash it computes (`sha256(header + body)`)
  is exactly the value `image state-write` needs.
- Nothing is applied until the user presses **Reboot now**; the device
  keeps running the old image until then (a power cycle also applies it).
  The update is armed as a **test swap**, so MCUboot reverts an image that
  fails to boot. The reconnect loop then reports either the new version or
  that the device came back on the old one.
- **Choose file…** flashes a local `.signed.bin` through the same
  verification/upload/arming path (development builds, pre-releases, a
  fully offline recovery). It skips the manifest comparison but still
  checks the image's own structure and hash.
- `os reset` reboots without a clean BLE disconnect, and the browser can
  keep the dead link "connected" for a few seconds; every operation on
  it then fails with `GATT Server is disconnected`. The page therefore
  drops the link itself before reconnecting, retries the reconnect until
  a *fresh* link has read the device's identity, and only then decides
  whether the new firmware came up or MCUboot reverted the swap.
- The card never offers a downgrade: a development build newer than the
  latest release shows "dev build" and no update button. `BLE R/O` hides
  the SMP service, so the card explains that the device must be in R/W
  mode instead of failing the upload.

To publish a build by hand (for example a pre-release or a local server):

```sh
python3 tools/fw_manifest.py app/build/zephyr/zephyr.signed.bin \
    --page https://github.com/fanoush/SidClock/releases \
    --out web/firmware/index.json
cp app/build/zephyr/zephyr.signed.bin web/firmware/
```

Both generated files are gitignored; a plain `python3 -m http.server
--directory web` has no manifest and simply hides the update section.

## Troubleshooting

- `--ble <addr> not found`: BlueZ sometimes drops the device from cache
  after a reconnect. Retry, or `remove <addr>` in `bluetoothctl` first.
- SMP service not found / `upgrade` fails immediately: the device is in
  `BLE R/O` or `BLE OFF` (main-screen button). Set it back to `BLE R/W`;
  a reboot also restores R/W.
- Every SMP request times out (`no answer to SMP request`) while the
  debug characteristic still answers (status, tune listing): the link is
  up, the transport is not. The page probes SMP right after connecting
  and, when the probe stays silent, keeps the remote usable but disables
  tune uploads and firmware updates with that reason in the device card's
  update section -
  reconnect, and if `smpmgr --ble <addr> image state-read` also hangs it
  is device-side: capture `tools/sidclock_ble.py log --peek`.
- Transfer stalls: check the battery/charger and that no central is
  connected. Retrying is safe - a partial image in slot 1 is simply
  overwritten.
- Firmware unchanged after `upgrade`: the image was never marked (see
  step 4). `image state-read` shows it in slot 1 with `pending=False`;
  `image state-write <hash>` + `os reset` applies it.
- `image state-write` fails with
  `IMG_MGMT_ERR_IMAGE_SETTING_TEST_TO_ACTIVE_DENIED`: the hash named the
  *active* slot, because the image being flashed is the one already
  running (both slots hold the same hash after such an upload). Nothing to
  apply - build a different image, or reset if a reboot is all you wanted.
  `tools/flash_ota.py` reports this instead of failing.
- The device came back on the old image after a reset that should have
  applied the update: `image state-read` again. Slot 1 still `pending`
  means MCUboot never got to swap (the reset did not happen, or it
  rebooted before the mark was written); slot 1 no longer `pending` and
  slot 0 old means MCUboot booted the test image, it failed, and the swap
  was rolled back - check the boot log
  (`tools/sidclock_ble.py log --peek`).
- Device does not boot after a failed update: MCUboot reverts an
  unconfirmed image on the next reset. If the app no longer boots at all,
  reflash slot 0 over SWD (`app/flash.sh`).

## Validation model

Images are validated by **SHA-256 hash only** - there is no signature
check, and the BLE service requires no pairing. Treat OTA as a development
interface; see [security.md](security.md).
