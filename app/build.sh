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
# SID engine selection (default: dual): the default build links both
# engines and switches them at runtime (main-screen button or
# tools/sidclock_ble.py engine). SIDCLOCK_SID_ENGINE=crsid or =csid build
# single-engine images for A/B comparison; those show -crsid/-csid in the
# on-display version string, the signed image version is the same.
#
# Debug build:
#
#   SIDCLOCK_DEBUG=1 ./build.sh
#
# compiles the bring-up test commands back in (test tones, rate/tone
# ladders, raw MCKFREQ) and applies app/prj_debug.conf. The SEGGER RTT log
# buffer is *not* a build knob: it is shared with the bootloader and its
# size decides where the RTT control block lands in RAM (see prj.conf).
# Debug images show -dbg in the on-display version string; the signed image
# version stays the same. The flag is passed to CMake on every build, so a
# debug build does not leak into the next release build.
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

VERSION="1.0.8"

# Always passed explicitly: the CMake cache would otherwise keep an earlier
# build's value (same caveat as SIDCLOCK_SID_ENGINE below).
if [ "${SIDCLOCK_DEBUG:-0}" = "1" ]; then
    DEBUG_ARGS=(-DSIDCLOCK_DEBUG=1 -DEXTRA_CONF_FILE="$HERE/prj_debug.conf")
else
    DEBUG_ARGS=(-DSIDCLOCK_DEBUG=0 -DEXTRA_CONF_FILE=)
fi

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
    -DSIDCLOCK_SID_ENGINE="${SIDCLOCK_SID_ENGINE:-dual}" \
    "${DEBUG_ARGS[@]}" \
    -DDTC_OVERLAY_FILE="$HERE/app.overlay" \
    -DPYTHON_EXECUTABLE="$(command -v python3)"

ninja -C "$HERE/build"

# Dev signing key (generated on first use, never commit it). The bootloader
# validates images by SHA-256 only, so any key works.
if ! python3 -c "import click, cryptography, cbor2" 2>/dev/null; then
    echo "error: missing Python packages for image signing (click, cryptography, cbor2)." >&2
    echo "       Install the build requirements:  pip3 install --user -r \"$ROOT/tools/requirements-build.txt\"" >&2
    exit 1
fi
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
