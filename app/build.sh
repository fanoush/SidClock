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
# FLPR (VPR RISC-V) bare-metal blob: the blob is built first with the
# riscv64-zephyr-elf toolchain (no Zephyr, no west, no sysbuild), embedded
# in the M33 image as a const array and started on demand (debug command
# 0x30). It is a two-phase build: phase 1 links the blob without the engine
# so the M33 link yields the flpr_blob[] and engine-data addresses, phase 2
# links the full cRSID render engine against that map (zero-copy shared
# state) and relinks. Address drift between the two M33 links fails the
# build. See docs/flpr.md.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/local.conf" ] && . "$ROOT/local.conf"
SDK="${SIDCLOCK_SDK:-$ROOT/.sdk}"

VERSION="1.0.9"

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

# --- FLPR bare-metal blob, two phases (VPR RISC-V) ---
# Built with plain CMake + the riscv64-zephyr-elf toolchain, then embedded
# in the M33 image as a const C array (no pad, no fixed flash partition).
# The blob runs EXACTLY where it is linked (bias 0): phase 1 builds the
# blob without the engine and links the M33 image to learn the flpr_blob[]
# address plus every engine data address; phase 2 links the cRSID render
# engine against that map (engine state stays M33-owned, zero copies) and
# relinks. Any address drift between the two M33 links fails the build.
export PATH="$SDK/tools/zephyr-sdk-0.17.0/riscv64-zephyr-elf/bin:$PATH"
ARMNM="$SDK/tools/zephyr-sdk-0.17.0/arm-zephyr-eabi/bin/arm-zephyr-eabi-nm"
GEN="$HERE/flpr" # generated memmap.ld/datamap.ld (gitignored)

flpr_build() { # $1 = OFF (no engine) | ON (full render engine)
    cmake -GNinja \
        -S "$HERE/flpr" -B "$HERE/build-flpr" \
        -DCMAKE_TOOLCHAIN_FILE="$HERE/flpr/toolchain-rv32emc.cmake" \
        -DFLPR_WITH_ENGINE="$1"
    ninja -C "$HERE/build-flpr"
    riscv64-zephyr-elf-objcopy -O binary "$HERE/build-flpr/flpr.elf" \
        "$HERE/build-flpr/flpr.bin"
}

# Phase 1: blob without the engine at ROM base 0; its bytes only reserve
# the array slot whose address the M33 link assigns.
printf 'MEMORY {\n\tROM (rx)  : ORIGIN = 0x0, LENGTH = 0x28000\n}\n' \
    > "$GEN/memmap.ld"
printf '/* phase 1: no engine map */\n' > "$GEN/datamap.ld"
flpr_build OFF
python3 "$HERE/flpr/blob_to_c.py" --check-relocs \
    "$HERE/build-flpr/flpr.elf" 0x2003E000 0x1C00
python3 "$HERE/flpr/blob_to_c.py" --check-ram \
    "$HERE/flpr/flpr_shared.h" "$HERE/flpr.overlay"
python3 "$HERE/flpr/blob_to_c.py" "$HERE/build-flpr/flpr.bin" \
    "$HERE/src/flpr_blob.c" 0x40000

cmake -GNinja \
    -S "$HERE" -B "$HERE/build" \
    -DBOARD=nrf54l15dk/nrf54l15/cpuapp \
    -DBUILD_VERSION=v4.0.99-sidclock \
    -DZEPHYR_MODULES="$SDK/sdk/mcuboot;$SDK/sdk/modules/hal/nordic;$SDK/sdk/modules/hal/cmsis;$SDK/sdk/modules/crypto/tinycrypt;$SDK/sdk/modules/debug/segger;$SDK/sdk/modules/lib/zcbor;$SDK/sdk/modules/fs/littlefs" \
    -DSIDCLOCK_VERSION="$VERSION" \
    -DSIDCLOCK_SID_ENGINE="${SIDCLOCK_SID_ENGINE:-dual}" \
    "${DEBUG_ARGS[@]}" \
    -DDTC_OVERLAY_FILE="$HERE/app.overlay;$HERE/flpr.overlay" \
    -DPYTHON_EXECUTABLE="$(command -v python3)"

ninja -C "$HERE/build"

# --- Phase 2: full engine blob against the M33 address map ---
# Extract the flpr_blob[] address plus every engine data address from
# the M33 link, pin the blob onto them (zero-copy shared state),
# re-embed, relink, and prove nothing moved.
ARRAY_VMA=$("$ARMNM" --print-size "$HERE/build/zephyr/zephyr.elf" |
    awk '/ R flpr_blob$/ {print "0x" $1}')
[ -n "$ARRAY_VMA" ] || { echo "error: flpr_blob missing in M33 link" >&2; exit 1; }
# Standalone engine object for section names (same flags as the blob build).
riscv64-zephyr-elf-gcc -march=rv32emc_zicsr -mabi=ilp32e -O3 -funroll-loops \
    -std=gnu99 -fno-pie -msmall-data-limit=0 -ffunction-sections \
    -fdata-sections -I"$HERE/src/sid" -I"$HERE/src/sid/crsid" \
    -c "$HERE/src/sid/crsid/libcRSID.c" -o "$HERE/build-flpr/engine.o"
python3 "$HERE/flpr/blob_to_c.py" --gen-map "$ARMNM" \
    "$HERE/build/zephyr/zephyr.elf" "$HERE/build-flpr/engine.o" \
    "$ARRAY_VMA" "$GEN/memmap.ld" "$GEN/datamap.ld"
cp "$GEN/memmap.ld.json" "$GEN/map1.json"
flpr_build ON
python3 "$HERE/flpr/blob_to_c.py" --check-final \
    "$HERE/build-flpr/flpr.elf" "$ARRAY_VMA" 0x2003E000 0x1C00 \
    "$GEN/map1.json"
python3 "$HERE/flpr/blob_to_c.py" "$HERE/build-flpr/flpr.bin" \
    "$HERE/src/flpr_blob.c" 0x40000
ninja -C "$HERE/build"
# Stability: the array and every engine address must be identical.
ARRAY_VMA2=$("$ARMNM" --print-size "$HERE/build/zephyr/zephyr.elf" |
    awk '/ R flpr_blob$/ {print "0x" $1}')
python3 "$HERE/flpr/blob_to_c.py" --gen-map "$ARMNM" \
    "$HERE/build/zephyr/zephyr.elf" "$HERE/build-flpr/engine.o" \
    "$ARRAY_VMA2" "$GEN/memmap.ld" "$GEN/datamap.ld" --expect "$GEN/map1.json"

# Guard: the whole image (app + embedded blob) must fit MCUboot slot0.
python3 - "$HERE" <<'PY'
import sys

img = open(f"{sys.argv[1]}/build/zephyr/zephyr.bin", "rb").read()
assert len(img) <= 0x151000, \
    "image (%d B) overflows MCUboot slot0" % len(img)
print("image: %d B in 0x151000 slot" % len(img))
PY

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
# (CONFIG_ROM_START_OFFSET); the vector table sits at 0xE800. The input
# already contains the embedded FLPR blob, so the whole slot-0 content is
# hash-covered as one image.
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
