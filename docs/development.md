# Development

## Build workflow

```sh
bootloader/fetch-sdk.sh          # once (or after changing the pinned revs)
bootloader/build.sh              # bootloader (rtt: ./build.sh rtt)
app/build.sh                     # application + MCUboot signature
SIDCLOCK_DEBUG=1 app/build.sh    # + bring-up test commands
```

The SDK location comes from `$SIDCLOCK_SDK` or a repo-root `local.conf`
(gitignored). Both scripts are safe to rerun; the app build is incremental
(ninja), the bootloader build cleans its build directory for reproducible
output.

`app/build.sh` builds the **release** configuration by default: the bring-up
test commands (test tones, sample-rate/tone ladders, raw MCKFREQ) are
compiled out and the debug BLE opcodes behind them are rejected.
`SIDCLOCK_DEBUG=1` builds the **debug** configuration instead: those
commands exist again, and the on-display version shows `-dbg`. The flag is
passed on every build, so a debug build never leaks into the next release
build. The RTT log buffer size is not a build knob: it is the same in release
and debug, because it has to stay in step with the bootloader's (see *RTT
bootloader* below).

`app/build.sh` reuses/generates `app/sidclock.pem` for the MCUboot header if
it is missing. The bootloader checks hashes only, so the key content does
not matter - but never commit it (it is gitignored).

## Flashing

| Path | Command |
|---|---|
| Bootloader (SWD) | `bootloader/flash.sh [image.hex]` |
| Application (SWD) | `app/flash.sh [image.signed.bin]` |
| Application (BLE) | `tools/flash_ota.py --now [image.signed.bin]` |
| Unlock + erase | `tools/flash/erase.sh` (destructive) |

For day-to-day development, OTA (`tools/flash_ota.py`, or `smpmgr` by
hand) is fastest; SWD is the recovery path. After any reset the wall clock
is unset - run `tools/sidclock_ble.py set-time`.

## Debugging

- **RTT bootloader**: the bootloader logs its validation/swap decisions
  over SEGGER RTT into the same RAM region the application uses
  (`.rtt_buff_data`, the first bytes of RAM): MCUboot initialises the
  control block, the app finds it already valid and keeps it
  (`CONFIG_SEGGER_RTT_INIT_MODE_STRONG_CHECK`), so after a reset the log
  drain starts with the bootloader's lines. The up-buffer size decides
  where the control block sits inside that region, so
  `CONFIG_SEGGER_RTT_BUFFER_SIZE_UP` must be identical in `app/prj.conf`
  and `bootloader/sidclock-mcuboot.conf`. `bootloader/build.sh rtt` only
  raises MCUboot's log level to DBG. The app always logs over RTT
  (`CONFIG_LOG_BACKEND_RTT`), no UART is wired.
- **BLE status**: `tools/sidclock_ble.py audio` prints the audio/SID debug
  snapshot; `status`, `monitor` and `ls` cover the rest. The debug
  characteristic layout and commands are in
  [ble-services.md](ble-services.md).
- **Firmware log**: `tools/sidclock_ble.py log` drains the SEGGER RTT
  buffer over BLE (the same `LOG_*` lines a probe would show, and no probe
  is attached during normal development). `log --peek` reads the buffer
  without consuming it, `log -f` follows; the 8 KB buffer keeps its newest
  window by overwriting the oldest unread bytes, and after a reset it still
  holds the lines written before the bootloader's.
- **UI problems**: the display driver has power-state control; a fully
  blank panel with a running app usually means a missing panel re-init
  after sleep, not a dead driver.

## Conventions

- Zephyr coding style, 4-space tabs, 80-column comments. `main.c` is
  intentionally a single module for the UI today; if you split it, keep
  the screen functions independent of static state where practical.
- No dynamic allocation in the application path; `CONFIG_HEAP_MEM_POOL_SIZE=0`
  and the linked image contains no `malloc`/`k_malloc` caller, so nothing
  reserves the system heap. Static buffers are sized for the display band
  (448x16x2 bytes) and the audio double buffer.
- Store config changes by setting the `*_dirty` flags; the main loop
  throttles the flash writes.
- Time comparisons must use **unsigned modular deltas**
  (`k_uptime_get_32() - t0 >= N`): the uptime base is large and persists
  across warm resets on this SoC.
- Keep the panel/NOR bus traffic out of the debug log (`CONFIG_LOG_MAX_LEVEL`
  is 3) - the RTT buffer must not stall the display path.

## Web remote deployment

`web/` is published to GitHub Pages by `.github/workflows/pages.yml` on
every push that touches `web/**` (or by hand: Actions -> *pages* -> *Run
workflow*). The artifact is `web/` itself, so the page is served at the
site root - <https://fanoush.github.io/SidClock/> - and a change is only
live once the `pages` workflow has succeeded.

One-time setup per repository (a fork or a fresh clone needs it too):
Pages has to exist before `actions/configure-pages` can use it, and the
Actions token cannot create it - that is the one `pages` failure that is
not a code problem (`configure-pages` fails, upload/deploy are skipped):

1. **Settings -> Pages -> Build and deployment -> Source: GitHub
   Actions** (not "Deploy from a branch"). GitHub then creates the
   `github-pages` environment the workflow deploys into.
2. Re-run the workflow: Actions -> *pages* -> *Re-run all jobs*, or push
   another change under `web/`.

Check it without the UI (404 = not enabled yet):

```sh
curl -s https://api.github.com/repos/fanoush/SidClock/pages
```

The README links the remote with a QR code (`docs/qr-web-remote.png`) so
a phone can scan it off the screen. It is a committed image (no
third-party badge service in the page), and it is regenerated with:

```sh
python3 -m venv /tmp/qr && /tmp/qr/bin/pip install 'qrcode[pil]'
/tmp/qr/bin/python - <<'PY'
import qrcode
qr = qrcode.QRCode(box_size=6, border=4)   # 222x222 for this URL
qr.add_data('https://fanoush.github.io/SidClock/')
qr.make()
qr.make_image().save('docs/qr-web-remote.png')
PY
```

Keep the quiet zone (the `border=4`) and the dark-on-light colours: an
inverted or cropped QR is what makes a scanner give up.

### Serving the page locally

On a desktop, `localhost` is a secure context over plain http, so the
page runs straight from a checkout - `--directory web` makes `web/` the
site root, so the URL needs no `/web/`:

```sh
python3 -m http.server 8000 --directory web     # http://localhost:8000/
```

The browser test pages import from `web/` and other repository paths, so
those want the repository root as the server root instead:

```sh
python3 -m http.server 8899                     # repository root
# http://localhost:8899/tools/web-tests/index.html  (+ ?live for network checks)
# .../page.html drives the real page against the live API (network)
# .../connect.html drives it against a fake Bluetooth device (offline)
python3 tools/web-tests/record.py --out /tmp/wt.txt   # headless runner
```

A phone on the Wi-Fi is neither `localhost` nor `https`, and Web
Bluetooth is only exposed in a secure context, so it needs one of:

```sh
# a quick tunnel in front of the local server - real certificate, no warning:
python3 -m http.server 8000 --directory web
cloudflared tunnel --url http://localhost:8000  # open the tunnel URL on the phone

# or self-signed TLS, no third party involved (accept the warning once):
python3 tools/serve_web.py                      # https://<this-computer>:8443/
python3 tools/serve_web.py -v                   # log requests with their User-Agent
```

Both serve `web/` as the site root, so the remote is at `/`. The phone
must be Chrome or Edge on Android - iOS Safari has no Web Bluetooth.

## Testing checklist

Before calling a change done, verify on hardware:

1. Boot + UI: all screens draw, touch targets work, sliders respond.
2. SID: load a tune, play/pause/subtune, chip switch, end mode, marquee.
3. Alarms: create an ONCE alarm a minute out in idle, check ring/wake/touch.
4. Idle: wait for the timeout, confirm auto-brightness and orientation.
   If the idle face stops rotating or the sensor screen shows
   `ACCEL: no sample`, `tools/sidclock_ble.py accel` (read-only) prints the
   chip's `WHO_AM_I`, both read paths and the register file: a good unit
   shows a live `Z = +/-9.8 m/s2` with `ctrl2=30 ctrl4=88`, frozen output
   bytes with `ctrl2=00` mean the boot configuration did not stick.
5. Sleep: SLEEP button - panel dark, music continues, touch wakes, alarm
   wakes into the idle clock.
6. BLE: `status`, `set-time`, `ls`; OTA with `tools/flash_ota.py --now`,
   then `image state-read` (slot 0 = the new hash, `confirmed=True`).
   Without `--now` the device must keep running (slot 0 unchanged).
7. Persistence: change settings, power-cycle (reset), verify they survive.
8. Web remote (`web/`): `tools/web-tests/` in a browser - all pass, `?live`
   too (network; downloads the HVSC databases) - then the page itself in
   Chrome: connect, play/pause, search + upload a tune (R/W mode), the
   HVSC info card, and play/delete from the device library. A merged
   `web/**` change reaches the published page only through the `pages`
   workflow (see [Web remote deployment](#web-remote-deployment)).

## Releases

1. Bump `VERSION` in `app/build.sh` and update `CHANGELOG.md`.
2. Build + test the checklist above.
3. Commit, push, then tag and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "SidClock X.Y.Z"
   git push origin vX.Y.Z
   ```

   CI builds the firmware and **creates the GitHub release automatically**
   (tag pushes only) with the signed application, the bootloader images and
   a `SHA256SUMS` file attached.
