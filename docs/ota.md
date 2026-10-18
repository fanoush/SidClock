# Over-the-air updates

The bootloader never speaks BLE. Updates are handled by the running
application, which contains Zephyr's MCUmgr over the standard Bluetooth
SMP service:

```
 app receives the image over BLE
   -> writes it to slot 1 on the external flash
     -> marks it for the next boot
       -> reset
         -> MCUboot swaps slot 1 -> slot 0 and boots it
           -> the app confirms the image (or MCUboot reverts a test swap)
```

This is **not** the Nordic legacy DFU protocol: `nrfutil dfu ble` and
`.zip` packages do not apply here.

## Client

```sh
tools/smpmgr/install.sh        # installs smpmgr + smpclient + bleak
```

or use any recent `smpmgr` from PyPI.

## Procedure

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

4. Upload:

   ```sh
   smpmgr --ble <addr> upgrade app/build/zephyr/zephyr.signed.bin
   ```

   The transfer runs at a boosted link rate (2M PHY, 15 ms interval,
   251-byte data length) and takes a few seconds for a ~1 MB image.

5. The device resets, MCUboot swaps the slots and the new firmware boots
   and confirms itself. Check the running version:

   ```sh
   smpmgr --ble <addr> image state-read | grep version
   ```

   (The image version comes from `app/build.sh`; bump `VERSION` there when
   releasing.)

   **The reset after `upgrade` boots the *old* image.** The upload only
   writes the bytes into slot 1; asking MCUboot to boot them is a separate
   request (`image state write`) that the *client* has to send. Zephyr's
   `image upload` handler never marks anything by itself, and smpmgr 0.17.0
   only sends that request when `--slot` is not 0 or `--confirm` is given -
   with the default invocation MCUboot finds nothing pending and boots
   slot 0 again. This is not a bootloader misconfiguration: `image
   state-read` shows the new image sitting in slot 1, bootable, simply not
   marked (`pending=False`). Mark it for a *test* swap (MCUboot still
   reverts if it fails to boot; the app confirms itself on the way up, so
   the swap sticks) and reset:

   ```sh
   smpmgr --ble <addr> image state-read     # note the slot-1 image hash
   smpmgr --ble <addr> image state-write <hash>
   smpmgr --ble <addr> os reset
   ```

   `smpmgr --ble <addr> upgrade --confirm <bin>` is the one-command
   variant: it marks the image permanently instead of for a test swap, so
   MCUboot never reverts a bad image. Use it only when the SWD pads (or
   the serial recovery path) are reachable.

## Troubleshooting

- `--ble <addr> not found`: BlueZ sometimes drops the device from cache
  after a reconnect. Retry, or `remove <addr>` in `bluetoothctl` first.
- SMP service not found / `upgrade` fails immediately: the device is in
  `BLE R/O` or `BLE OFF` (main-screen button). Set it back to `BLE R/W`;
  a reboot also restores R/W.
- Transfer stalls: check the battery/charger and that no central is
  connected. Retrying is safe - a partial image in slot 1 is simply
  overwritten.
- Device does not boot after a failed update: MCUboot reverts an
  unconfirmed image on the next reset. If the app no longer boots at all,
  reflash slot 0 over SWD (`app/flash.sh`).

## Validation model

Images are validated by **SHA-256 hash only** - there is no signature
check, and the BLE service requires no pairing. Treat OTA as a development
interface; see [security.md](security.md).
