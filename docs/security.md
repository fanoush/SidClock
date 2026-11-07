# Security model

SidClock is a development-friendly hobby firmware. This document states the
model plainly so users can make informed decisions.

## What is protected, what is not

| Aspect | State |
|---|---|
| Firmware image integrity | SHA-256 hash validation by MCUboot |
| Firmware authenticity | **none** - no signature check (see below) |
| BLE update access | **open** - SMP works without pairing/bonding |
| BLE file access | open - MCUmgr fs_mgmt can read/write `/home` while connected |
| Debug access (SWD) | unlocked after the first flash (APPROTECT cleared) |
| Secrets in the repository | none |

## Why there is no signature check

The device's stock bootloader was signed with keys that are not available to
this project, and it is replaced during the unlock anyway. The bundled
MCUboot is therefore built with `CONFIG_BOOT_SIGNATURE_TYPE_NONE`: it
validates an image's SHA-256 TLV, which protects against corruption and
truncated uploads, but not against an attacker who can reach the device
over BLE.

Similarly, the BLE service is intentionally unpaired to keep development
and OTA friction low (any BLE central in range can send debug commands or
an update while the device is connected).

## What this means in practice

- Treat the device as one on your personal network: anyone within BLE
  range who can connect to it can update its firmware or modify files.
- The device does not store valuable secrets; the impact is limited to the
  device itself (bricking, altered tunes/settings, altered firmware).
- Do not ship a device configured this way to end users without the
  hardening below.

## Firmware update manifest (web remote)

The web remote's update card trusts `firmware/index.json` and the image next
to the page, so it is only as trustworthy as the site that serves them
(GitHub Pages over HTTPS, from the project's own repository). Before
uploading, the page checks the MCUboot header/TLV structure, the image's
SHA-256 TLV, and the whole-file SHA-256 and size from the manifest. That
catches a corrupted or interrupted download, a stale cache and a mis-named
file - it does **not** prove who built the image, because the device itself
performs no signature check. `Choose file…` deliberately skips the manifest
and flashes any structurally valid signed image (development builds).

## Hardening path (not implemented here)

1. **Own signing key**: build MCUboot with `CONFIG_BOOT_SIGNATURE_TYPE_ECDSA_P256`
   (or RSA/Ed25519), generate a private key outside the repository, and
   sign releases with `imgtool.py -k <key>`. Flash the matching public key
   in the bootloader build.
2. **Pairing/authentication**: enable `CONFIG_BT_SMP` and require
   bonding for the SMP service (`CONFIG_MCUMGR_TRANSPORT_BT_PERM_*` plus
   an IO capability), so only paired centrals can access it.
3. **Disable unused debug commands** in release builds (compile-time
   option) and consider read-protecting the SWD port again after
   development.

## Reporting

If you find a security-relevant issue, open an issue (or contact the
maintainer privately for sensitive reports) rather than publishing an
exploit against devices in the field.
