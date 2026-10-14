#!/usr/bin/env bash
#
# Download a few sample SID tunes plus the HVSC song-length and STIL
# databases into this directory (sids/).
#
# Nothing in this directory is committed to the repository: the files come
# straight from the official HVSC download server and their copyright
# remains with the composers. See sids/README.md.
#
#   ./fetch-samples.sh
#
# After fetching:
#   tools/sid_add.py sids/Commando.sid              # sidecars + upload
#   tools/sid_add.py --no-upload sids/*.sid         # local sidecars only
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="https://hvsc.c64.org/download/C64Music"

dl() { # hvsc-path [local-name]
	local remote="$1" name="${2:-$(basename "$1")}"
	if [ -s "$HERE/$name" ]; then
		echo "have $name"
		return
	fi
	echo "fetching $name"
	curl -fL --retry 3 -o "$HERE/$name.part" "$BASE/$remote"
	mv "$HERE/$name.part" "$HERE/$name"
}

# Databases used by tools/sid_add.py
dl DOCUMENTS/Songlengths.md5
dl DOCUMENTS/Songlengths.txt
dl DOCUMENTS/STIL.txt

# A few well-known tunes to get started (edit/extend freely).
# Arkanoid and Parallax are deliberately not here: current HVSC ships
# Arkanoid as an RSID (Real C64) image and Parallax's player does not
# emulate well in the cSID-light core - both sound wrong on the device.
dl MUSICIANS/H/Hubbard_Rob/Commando.sid
dl MUSICIANS/H/Hubbard_Rob/IK_plus.sid
dl MUSICIANS/H/Hubbard_Rob/Knucklebusters.sid
dl MUSICIANS/T/Tel_Jeroen/Supremacy.sid
dl MUSICIANS/H/Huelsbeck_Chris/Shades.sid
dl MUSICIANS/D/Daglish_Ben/Last_Ninja.sid
dl MUSICIANS/D/Daglish_Ben/Thing_Bounces_Back.sid
dl MUSICIANS/G/Gray_Matt/Last_Ninja_2.sid
dl MUSICIANS/O/Ouwehand_Reyn/Last_Ninja_3.sid
dl MUSICIANS/G/Galway_Martin/Ocean_Loader_2.sid
dl MUSICIANS/G/Galway_Martin/Yie_Ar_Kung_Fu.sid
# Multi-SID test tunes (PSID v3/v4: second/third SID at $D420/$D440).
# Short local names: the BLE play command accepts at most 20 characters.
dl MUSICIANS/J/Jammer/Yet_Bigger_Beat_2SID.sid YBB_2SID.sid
dl MUSICIANS/J/Jammer/Melbourne_Shuffle_3SID.sid Melbourne_3SID.sid

echo
echo "done - next:  tools/sid_add.py sids/Commando.sid"
