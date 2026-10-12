#!/usr/bin/env bash
#
# Flash the SidClock bootloader into the internal RRAM at 0x0 with a
# SEGGER J-Link (SWD). The external SPI flash (tunes, settings, OTA slot)
# is not touched.
#
#   ./flash.sh [image.hex]
#
# Default image: build/zephyr/zephyr.hex when present, else the prebuilt
# prebuilt/sidclock-mcuboot-nrf54l15.hex.
#
# On a locked device run tools/flash/erase.sh first - that wipes the whole
# internal RRAM including the stock bootloader and cannot be undone.
# See docs/backup-unlock-flash.md.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
JLINK="${JLINK:-JLinkExe}"
IMG="${1:-}"

if [ -z "$IMG" ]; then
	if [ -f "$HERE/build/zephyr/zephyr.hex" ]; then
		IMG="$HERE/build/zephyr/zephyr.hex"
	else
		IMG="$HERE/prebuilt/sidclock-mcuboot-nrf54l15.hex"
	fi
fi
[ -f "$IMG" ] || { echo "error: image not found: $IMG" >&2; exit 1; }
command -v "$JLINK" >/dev/null 2>&1 || {
	echo "error: $JLINK not found (install SEGGER J-Link, or set JLINK=/path/to/JLinkExe)" >&2
	exit 1
}

CMD="$(mktemp)"
trap 'rm -f "$CMD"' EXIT
cat > "$CMD" <<EOF
connect
r
loadfile $IMG
r
g
qc
EOF

exec "$JLINK" -device nRF54L15_M33 -if SWD -speed 4000 -nogui 1 -ExitOnError 1 -CommanderScript "$CMD"
