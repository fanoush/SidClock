#!/usr/bin/env bash
#
# Download + unpack the pinned build dependencies for SidClock:
#
#   - Zephyr (NCS 3.0.x tree) and MCUboot at fixed revisions
#   - the Zephyr modules used by the app and the bootloader
#   - Zephyr SDK 0.17.0 (minimal + host tools + arm-zephyr-eabi toolchain)
#   - ninja
#
# Usage:
#
#   ./fetch-sdk.sh [target-dir]
#
# Default target: $SIDCLOCK_SDK, else <repo>/.sdk (gitignored).
#
# Works on Linux x86_64 and aarch64 (SDK URLs follow the host arch).
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/local.conf" ] && . "$ROOT/local.conf"
TARGET="${1:-${SIDCLOCK_SDK:-$ROOT/.sdk}}"

case "$(uname -m)" in
	x86_64|amd64) SDK_ARCH=x86_64 ;;
	aarch64|arm64) SDK_ARCH=aarch64 ;;
	*) echo "error: unsupported host architecture '$(uname -m)' (need x86_64 or aarch64)" >&2; exit 1 ;;
esac

SRC="$TARGET/src"
TOOLS="$TARGET/tools"
mkdir -p "$SRC" "$TOOLS" \
	"$TARGET/sdk/modules/hal" "$TARGET/sdk/modules/crypto" \
	"$TARGET/sdk/modules/debug" "$TARGET/sdk/modules/lib" "$TARGET/sdk/modules/fs"

dl() { # url file
	if [ -s "$2" ]; then
		echo "have $(basename "$2")"
		return
	fi
	echo "downloading $1"
	curl -fL --retry 3 -o "$2.part" "$1"
	mv "$2.part" "$2"
}

# --- Zephyr SDK 0.17.0 (minimal + host tools + arm toolchain) ---
dl https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.0/zephyr-sdk-0.17.0_linux-${SDK_ARCH}_minimal.tar.xz "$TOOLS/sdk-minimal.tar.xz"
dl https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.0/hosttools_linux-${SDK_ARCH}.tar.xz "$TOOLS/hosttools.tar.xz"
dl https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.0/toolchain_linux-${SDK_ARCH}_arm-zephyr-eabi.tar.xz "$TOOLS/arm-zephyr-eabi.tar.xz"

# --- sources (pinned revisions) ---
dl https://codeload.github.com/nrfconnect/sdk-zephyr/tar.gz/f791c49f492c "$SRC/zephyr.tar.gz"
dl https://codeload.github.com/zephyrproject-rtos/mcuboot/tar.gz/a2bc982b3379d51fefda3e17a6a067342dce1a8b "$SRC/mcuboot.tar.gz"
dl https://codeload.github.com/zephyrproject-rtos/hal_nordic/tar.gz/8cdcc33c6e5c7618ca4e77ff19a0eab557cc4bd5 "$SRC/hal_nordic.tar.gz"
dl https://codeload.github.com/zephyrproject-rtos/cmsis/tar.gz/4b96cbb174678dcd3ca86e11e1f24bc5f8726da0 "$SRC/cmsis.tar.gz"
dl https://codeload.github.com/zephyrproject-rtos/tinycrypt/tar.gz/1012a3ebee18c15ede5efc8332ee2fc37817670f "$SRC/tinycrypt.tar.gz"
dl https://codeload.github.com/zephyrproject-rtos/littlefs/tar.gz/009bcff0ed4853a53df8256039fa815bda6854dd "$SRC/littlefs.tar.gz"
dl https://codeload.github.com/zephyrproject-rtos/zcbor/tar.gz/9b07780aca6fb21f82a241ba386ad9b379809337 "$SRC/zcbor.tar.gz"
dl https://codeload.github.com/zephyrproject-rtos/segger/tar.gz/cf56b1d9c80f81a26e2ac5727c9cf177116a4692 "$SRC/segger.tar.gz"

# --- ninja (hosttools does not ship it on all platforms) ---
# Prefer a ninja already on PATH (this is required on aarch64, where the
# ninja project ships no linux binary zip); otherwise fetch the x86_64 build.
if ! command -v ninja >/dev/null 2>&1; then
	if [ "$SDK_ARCH" = "x86_64" ]; then
		dl https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-linux.zip "$SRC/ninja-linux.zip"
	else
		echo "error: ninja not found - install it first (pip install ninja, or apt install ninja-build)." >&2
		exit 1
	fi
fi

# --- unpack sources ---
untar() { # archive dest (strip the single top-level dir)
	if [ -d "$2" ]; then
		return
	fi
	mkdir -p "$2"
	tar -xf "$1" --strip-components=1 -C "$2"
}

untar "$SRC/zephyr.tar.gz" "$TARGET/sdk/zephyr"
untar "$SRC/mcuboot.tar.gz" "$TARGET/sdk/mcuboot"
untar "$SRC/hal_nordic.tar.gz" "$TARGET/sdk/modules/hal/nordic"
untar "$SRC/cmsis.tar.gz" "$TARGET/sdk/modules/hal/cmsis"
untar "$SRC/tinycrypt.tar.gz" "$TARGET/sdk/modules/crypto/tinycrypt"
untar "$SRC/littlefs.tar.gz" "$TARGET/sdk/modules/fs/littlefs"
untar "$SRC/zcbor.tar.gz" "$TARGET/sdk/modules/lib/zcbor"
untar "$SRC/segger.tar.gz" "$TARGET/sdk/modules/debug/segger"

# --- unpack the SDK ---
SDKDIR="$TOOLS/zephyr-sdk-0.17.0"
if [ ! -d "$SDKDIR" ]; then
	tar -xf "$TOOLS/sdk-minimal.tar.xz" -C "$TOOLS"
fi
[ -d "$SDKDIR/hosttools" ] || tar -xf "$TOOLS/hosttools.tar.xz" -C "$SDKDIR"
[ -d "$SDKDIR/arm-zephyr-eabi" ] || tar -xf "$TOOLS/arm-zephyr-eabi.tar.xz" -C "$SDKDIR"

if [ ! -x "$TOOLS/bin/ninja" ] && [ -s "$SRC/ninja-linux.zip" ]; then
	mkdir -p "$TOOLS/bin"
	python3 - "$SRC/ninja-linux.zip" "$TOOLS/bin" <<'PY'
import sys
import zipfile

zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
	chmod +x "$TOOLS/bin/ninja"
fi

echo
echo "SDK ready: $TARGET"
echo "One-time Python build requirements:  pip3 install --user -r \"$ROOT/tools/requirements-build.txt\""
