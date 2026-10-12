#!/usr/bin/env bash
#
# Build + sign the SidClock application.
#
#   ./build.sh
#
# The Zephyr/mcuboot sources and toolchain are shared with the bootloader.
# Point SIDCLOCK_SDK at a prepared SDK tree (see bootloader/fetch-sdk.sh),
# either via the environment or a local.conf file in the repo root:
#
#   SIDCLOCK_SDK=/path/to/sdk ./build.sh
#
# Result:
#   build/zephyr/zephyr.signed.bin   <- upload over BLE with smpmgr
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/local.conf" ] && . "$ROOT/local.conf"
SDK="${SIDCLOCK_SDK:-$ROOT/.sdk}"

VERSION="1.0.0"

export ZEPHYR_BASE="$SDK/sdk/zephyr"
export ZEPHYR_TOOLCHAIN_VARIANT=zephyr
export ZEPHYR_SDK_INSTALL_DIR="$SDK/tools/zephyr-sdk-0.17.0"
export PATH="$SDK/tools/bin:$PATH"   # ninja

cmake -GNinja \
    -S "$HERE" -B "$HERE/build" \
    -DBOARD=nrf54l15dk/nrf54l15/cpuapp \
    -DBUILD_VERSION=v4.0.99-sidclock \
    -DZEPHYR_MODULES="$SDK/sdk/mcuboot;$SDK/sdk/modules/hal/nordic;$SDK/sdk/modules/hal/cmsis;$SDK/sdk/modules/crypto/tinycrypt;$SDK/sdk/modules/debug/segger;$SDK/sdk/modules/lib/zcbor;$SDK/sdk/modules/fs/littlefs" \
    -DSIDCLOCK_VERSION="$VERSION" \
    -DDTC_OVERLAY_FILE="$HERE/app.overlay" \
    -DPYTHON_EXECUTABLE="$(command -v python3)"

ninja -C "$HERE/build"

# Dev signing key (generated on first use, never commit it). The bootloader
# validates images by SHA-256 only, so any key works.
if [ ! -f "$HERE/sidclock.pem" ]; then
    python3 "$SDK/sdk/mcuboot/scripts/imgtool.py" keygen -t ecdsa-p256 -k "$HERE/sidclock.pem"
fi

# NB: no --pad-header - the build already contains the 0x800 header space
# (CONFIG_ROM_START_OFFSET); the vector table sits at 0xE800.
python3 "$SDK/sdk/mcuboot/scripts/imgtool.py" sign \
    --key "$HERE/sidclock.pem" \
    --header-size 0x800 \
    --slot-size 0x151000 \
    --align 8 \
    --version "$VERSION" \
    "$HERE/build/zephyr/zephyr.bin" \
    "$HERE/build/zephyr/zephyr.signed.bin"

echo
echo "Signed image: $HERE/build/zephyr/zephyr.signed.bin"
echo "Upload with:  smpmgr --ble <addr> upgrade $HERE/build/zephyr/zephyr.signed.bin"
