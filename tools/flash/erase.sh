#!/usr/bin/env bash
#
# UNLOCK + FULL ERASE of a locked device over SWD (SEGGER J-Link).
#
#   ./erase.sh
#
# This performs an ERASEALL: it removes APPROTECT and wipes the whole
# internal RRAM, including the stock bootloader and application. The
# external SPI flash (tunes, /home data, OTA slot) is not touched.
#
# AFTER THIS THE STOCK FIRMWARE AND BOOTLOADER ARE GONE FOREVER - back up
# what you need over BLE first (tools/backup_ble.py) and read
# docs/backup-unlock-flash.md.
#
set -euo pipefail

JLINK="${JLINK:-JLinkExe}"
command -v "$JLINK" >/dev/null 2>&1 || {
	echo "error: $JLINK not found (install SEGGER J-Link, or set JLINK=/path/to/JLinkExe)" >&2
	exit 1
}

CMD="$(mktemp)"
trap 'rm -f "$CMD"' EXIT
cat > "$CMD" <<EOF
connect
unlock
erase
qc
EOF

exec "$JLINK" -device nRF54L15_M33 -if SWD -speed 4000 -nogui 1 -ExitOnError 1 -CommanderScript "$CMD"
