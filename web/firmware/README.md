# firmware/

Published firmware for the web remote's update card. **Generated at deploy
time - nothing here is committed except this file.**

`pages.yml` downloads the signed image of the latest GitHub release into
this directory and runs `tools/fw_manifest.py` to write `index.json`:

```
firmware/index.json                     version, size, sha256, image hash
firmware/sidclock-v1.0.10.signed.bin    the image itself
```

The page fetches `firmware/index.json` next to itself after every connect
and offers the update when the connected device is older. The binary lives
here rather than on the release page because a browser cannot read GitHub
release assets cross-origin (the redirect sends no CORS headers), while
GitHub Pages does.

A local `python3 -m http.server --directory web` has no `index.json`, so the
update card simply stays hidden; `python3 tools/serve_web.py` does the same
(`web/update.js` falls back to the published Pages manifest, which Pages
serves with `Access-Control-Allow-Origin: *`).

To publish locally, for a release or a test build:

```sh
python3 tools/fw_manifest.py app/build/zephyr/zephyr.signed.bin \
    --page https://github.com/fanoush/SidClock/releases \
    --out web/firmware/index.json
cp app/build/zephyr/zephyr.signed.bin web/firmware/
```

Both generated files are gitignored.
