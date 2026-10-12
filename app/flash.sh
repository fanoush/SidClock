#!/usr/bin/env bash
#
# Flash the signed SidClock application into slot 0 (internal RRAM at
# 0xE000) with a SEGGER J-Link (SWD). The bootloader must already be
# flashed at 0x0 (bootloader/flash.sh).
#
#   ./flash.sh [image.bin]
#
# Default image: build/zephyr/zephyr.signed.bin.
#
# For normal use prefer BLE OTA (smpmgr); SWD is the recovery path when
# the app on the device no longer boots.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
JLINK="${JLINK:-JLinkExe}"
IMG="${1:-$HERE/build/zephyr/zephyr.signed.bin}"

[ -f "$IMG" ] || { echo "error: image not found: $IMG (run ./build.sh first)" >&2; exit 1; }
command -v "$JLINK" >/dev/null 2>&1 || {
	echo "error: $JLINK not found (install SEGGER J-Link, or set JLINK=/path/to/JLinkExe)" >&2
	exit 1
}

CMD="$(mktemp)"
trap 'rm -f "$CMD"' EXIT
cat > "$CMD" <<EOF
connect
r
loadbin $IMG 0xE000
verifybin $IMG 0xE000
r
g
qc
EOF

exec "$JLINK" -device nRF54L15_M33 -if SWD -speed 4000 -nogui 1 -ExitOnError 1 -CommanderScript "$CMD"
