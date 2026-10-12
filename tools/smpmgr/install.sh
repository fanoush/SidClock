#!/usr/bin/env bash
#
# Install the smpmgr BLE OTA client (with smpclient + bleak) for the
# current user. Uses the pinned versions in requirements.txt; installs
# from the local wheelhouse when present (offline), else from PyPI.
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -d "$HERE/wheels" ]; then
    pip3 install --user --no-index --no-deps --no-build-isolation \
        --find-links "$HERE/wheels" \
        -r "$HERE/requirements.txt"
else
    pip3 install --user -r "$HERE/requirements.txt"
fi

echo
echo "Installed. Run:  $HOME/.local/bin/smpmgr --help"
