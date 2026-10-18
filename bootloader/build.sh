#!/usr/bin/env bash
#
# Build the SidClock bootloader (MCUboot) for the Saphe T device (nRF54L15).
#
#   ./build.sh          # release build (no logging)
#   ./build.sh rtt      # debug build with SEGGER RTT logging
#
# The Zephyr/mcuboot sources and toolchain are shared with the application;
# point SIDCLOCK_SDK at a prepared SDK tree (see fetch-sdk.sh) or put it in
# the repo-root local.conf.
#
# Result:
#   build/zephyr/zephyr.hex   -> flash at 0x0 (see flash.sh)
#   build/zephyr/zephyr.bin   -> same, raw
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/local.conf" ] && . "$ROOT/local.conf"
SDK="${SIDCLOCK_SDK:-$ROOT/.sdk}"

MODE="${1:-release}"
CONF_FILES="$HERE/signature_none.conf;$HERE/sidclock-mcuboot.conf"
if [ "$MODE" = "rtt" ]; then
	CONF_FILES="$CONF_FILES;$HERE/sidclock-rtt.conf"
fi

export ZEPHYR_BASE="$SDK/sdk/zephyr"
export ZEPHYR_TOOLCHAIN_VARIANT=zephyr
export ZEPHYR_SDK_INSTALL_DIR="$SDK/tools/zephyr-sdk-0.17.0"
export PATH="$SDK/tools/bin:$PATH"   # ninja

rm -rf "$HERE/build"

cmake -GNinja \
    -S "$SDK/sdk/mcuboot/boot/zephyr" \
    -B "$HERE/build" \
    -DBOARD=nrf54l15dk/nrf54l15/cpuapp \
    -DBUILD_VERSION=v4.0.99-sidclock \
    -DZEPHYR_MODULES="$SDK/sdk/mcuboot;$SDK/sdk/modules/hal/nordic;$SDK/sdk/modules/hal/cmsis;$SDK/sdk/modules/crypto/tinycrypt;$SDK/sdk/modules/debug/segger" \
    -DEXTRA_CONF_FILE="$CONF_FILES" \
    -DEXTRA_DTC_OVERLAY_FILE="$HERE/sidclock-mcuboot.overlay" \
    -DPYTHON_EXECUTABLE="$(command -v python3)"

ninja -C "$HERE/build"

echo
echo "Bootloader image: $HERE/build/zephyr/zephyr.hex"
echo "Flash with:       $HERE/flash.sh"
