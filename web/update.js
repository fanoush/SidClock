/*
 * Firmware update support for the web remote - no DOM, no Bluetooth.
 *
 * The page compares the connected firmware with the release published next
 * to it (`firmware/index.json`, written by tools/fw_manifest.py in the Pages
 * workflow) and offers the update when the device is older. Everything that
 * decides *whether* to offer an update and *whether a downloaded file is a
 * valid image* lives here so it can be tested without a device.
 *
 * Why the manifest is hosted on GitHub Pages instead of the release assets:
 * a browser cannot read `github.com/.../releases/download/...` cross-origin
 * (the redirect to release-assets.githubusercontent.com carries no CORS
 * headers), while Pages serves `access-control-allow-origin: *`. The binary
 * is copied into the Pages artifact by the release workflow, so the page
 * fetches it same-origin.
 *
 * The MCUboot image is verified here end to end: the header/TLV structure,
 * the SHA-256 TLV against the image body, the whole-file SHA-256 from the
 * manifest, and (when present) the image hash the device itself reports in
 * `image state-read`. That hash is exactly what `image state-write` needs to
 * arm the update, so no imgtool on the device or the page is involved.
 */

const IMAGE_MAGIC = 0x96f3b83d;
const TLV_INFO_MAGIC = 0x6907;
const TLV_SHA256 = 0x10;
const IMAGE_HEADER_SIZE = 32;

export const MANIFEST_SCHEMA = 1;
export const MANIFEST_PATH = 'firmware/index.json';
/** Where `python3 tools/serve_web.py` and local `http.server` runs look for
 *  the published manifest (Pages allows cross-origin reads). */
export const MANIFEST_FALLBACK =
  'https://fanoush.github.io/SidClock/firmware/index.json';

const MANIFEST_KEY = 'sidclock-firmware-manifest';
const MANIFEST_TTL = 60 * 60 * 1000; // one hour: releases do not move

/* ---------- small helpers ---------- */

export function hexOf(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function bytesOfHex(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const concat = (parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/** Compare dotted version strings (`1.0.7`, `v1.0.10`, `1.0.11-dbg`).
 *  Returns <0, 0 or >0; missing trailing fields count as zero. */
export function cmpVersion(a, b) {
  const parse = (v) => String(v == null ? '' : v)
    .replace(/^v/i, '')
    .split(/[^0-9]+/)
    .filter((s) => s.length)
    .map((s) => Number(s));
  const pa = parse(a);
  const pb = parse(b);
  if (!pa.length || !pb.length) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export async function sha256Hex(bytes) {
  const subtle = typeof crypto !== 'undefined' && crypto.subtle;
  if (!subtle) {
    throw new Error('checksum verification needs a secure context ' +
                    '(https or localhost)');
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return hexOf(digest);
}

/* ---------- MCUboot image ---------- */

/** Structure of a signed MCUboot image, without hashing it. */
export function parseImageHeader(bytes) {
  if (!bytes || bytes.length < IMAGE_HEADER_SIZE) {
    return { ok: false, reason: 'not a firmware image (file is too short)' };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== IMAGE_MAGIC) {
    return { ok: false, reason: 'not a signed MCUboot image (bad magic)' };
  }
  const hdrSize = dv.getUint16(8, true);
  const imgSize = dv.getUint32(12, true);
  const version = `${bytes[20]}.${bytes[21]}.${dv.getUint16(22, true)}`;
  const build = dv.getUint32(24, true);
  if (hdrSize < IMAGE_HEADER_SIZE || imgSize === 0) {
    return { ok: false, reason: 'invalid MCUboot header (no image body)' };
  }
  const end = hdrSize + imgSize;
  if (end + 4 > bytes.length) {
    return {
      ok: false,
      reason: `truncated image: ${bytes.length} bytes, the header needs ` +
              `at least ${end + 4}`,
    };
  }
  if (dv.getUint16(end, true) !== TLV_INFO_MAGIC) {
    return { ok: false, reason: 'missing the MCUboot TLV area' };
  }
  const tlvLen = dv.getUint16(end + 2, true);
  /* it_tlv_tot covers the whole area, including this 4-byte info header */
  const total = end + tlvLen;
  if (tlvLen < 4 || total !== bytes.length) {
    return {
      ok: false,
      reason: `unexpected image length: ${bytes.length} bytes, the TLV area ` +
              `ends at ${total} (cut or padded download?)`,
    };
  }
  let p = end + 4;
  let tlvHash = null;
  while (p + 4 <= total) {
    const type = bytes[p];
    const len = dv.getUint16(p + 2, true);
    if (p + 4 + len > total) {
      return { ok: false, reason: 'truncated MCUboot TLV entry' };
    }
    if (type === TLV_SHA256) tlvHash = bytes.subarray(p + 4, p + 4 + len);
    p += 4 + len;
  }
  if (p !== total) return { ok: false, reason: 'invalid MCUboot TLV area' };
  if (!tlvHash || tlvHash.length !== 32) {
    return { ok: false, reason: 'the image has no SHA-256 TLV' };
  }
  return {
    ok: true,
    hdrSize,
    imgSize,
    version,
    build,
    end,
    tlvHash: hexOf(tlvHash),
  };
}

/** Parse + hash an image: the SHA-256 TLV must match the body. */
export async function verifyImage(bytes) {
  const head = parseImageHeader(bytes);
  if (!head.ok) return head;
  const imageHash = await sha256Hex(bytes.subarray(0, head.end));
  if (imageHash !== head.tlvHash) {
    return {
      ok: false,
      reason: 'the image does not match its own hash TLV (corrupt or ' +
              'truncated download)',
    };
  }
  return {
    ok: true,
    info: {
      ...head,
      imageHash,
      fileHash: await sha256Hex(bytes),
    },
  };
}

/** Verify a downloaded release against its manifest entry. `release` may be
 *  a plain `{ version, size, sha256, image_hash }` object (the local-file
 *  path passes nulls to skip the checks it cannot make). */
export async function verifyRelease(bytes, release = {}) {
  const v = await verifyImage(bytes);
  if (!v.ok) return v;
  const info = v.info;
  const want = (s) => String(s || '').toLowerCase();
  if (release.size && bytes.length !== release.size) {
    return {
      ok: false,
      reason: `size mismatch: ${bytes.length} bytes downloaded, the manifest ` +
              `says ${release.size}`,
    };
  }
  if (release.sha256 && info.fileHash !== want(release.sha256)) {
    return {
      ok: false,
      reason: 'checksum mismatch: the downloaded file is not the published ' +
              'one (interrupted download or a stale cache - try again)',
    };
  }
  if (release.version && info.version !== release.version) {
    return {
      ok: false,
      reason: `the image is version ${info.version}, the manifest says ` +
              `${release.version}`,
    };
  }
  if (release.image_hash && info.imageHash !== want(release.image_hash)) {
    return { ok: false, reason: 'the image hash does not match the manifest' };
  }
  return { ok: true, info };
}

/* ---------- manifest ---------- */

/** Normalise a manifest document and resolve each release's URL against the
 *  URL it was loaded from. Throws when the document is not usable. */
export function normalizeManifest(raw, baseUrl) {
  if (!raw || raw.schema !== MANIFEST_SCHEMA) {
    throw new Error(`unsupported firmware manifest (schema ${raw && raw.schema})`);
  }
  const latest = raw.latest;
  if (!latest || !latest.version || !latest.file) {
    throw new Error('the firmware manifest has no latest release');
  }
  const base = baseUrl || (typeof location !== 'undefined' ? location.href : '');
  /* the release-notes link ends up in an <a href>: keep it http(s) even if
   * a manifest somewhere says otherwise */
  let page = '';
  if (latest.page) {
    try {
      const u = new URL(latest.page, base);
      if (u.protocol === 'http:' || u.protocol === 'https:') page = u.href;
    } catch (e) { /* not a URL: no link */ }
  }
  return {
    schema: raw.schema,
    generated: raw.generated || '',
    latest: {
      ...latest,
      page,
      url: new URL(latest.file, base).href,
    },
  };
}

function defaultCache() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch (e) {
    return null; // private mode / storage disabled
  }
}

function readCache(cache, now, ttl) {
  if (!cache) return null;
  try {
    const raw = cache.getItem(MANIFEST_KEY);
    if (!raw) return null;
    const hit = JSON.parse(raw);
    if (!hit || !hit.manifest || typeof hit.at !== 'number') return null;
    if (now - hit.at > ttl || now < hit.at) return null;
    return hit.manifest;
  } catch (e) {
    return null;
  }
}

function writeCache(cache, manifest, now) {
  if (!cache) return;
  try {
    cache.setItem(MANIFEST_KEY, JSON.stringify({ at: now, manifest }));
  } catch (e) { /* full or disabled: no cache, still fine */ }
}

export function clearManifestCache() {
  const cache = defaultCache();
  try {
    if (cache) cache.removeItem(MANIFEST_KEY);
  } catch (e) { /* ignore */ }
}

/** Manifest URLs to try, in order. Tests and local builds can point the
 *  page at a fixture with `window.__sidclockFirmwareUrl`. */
export function manifestUrls() {
  const override = (typeof window !== 'undefined' &&
                    window.__sidclockFirmwareUrl) || '';
  if (override) return [String(override)];
  const here = typeof location !== 'undefined' ? location.href : '';
  return [new URL(MANIFEST_PATH, here).href, MANIFEST_FALLBACK];
}

async function fetchJson(url, fetchImpl) {
  const r = await fetchImpl(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const raw = await r.json();
  return normalizeManifest(raw, url);
}

/** Load (and cache) the release manifest. Returns null when no manifest is
 *  reachable - callers just hide the update card then. */
export async function loadManifest({
  urls = manifestUrls(),
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  cache = defaultCache(),
  now = Date.now(),
  ttl = MANIFEST_TTL,
  fresh = false,
} = {}) {
  if (!fresh) {
    const hit = readCache(cache, now, ttl);
    if (hit) return hit;
  }
  if (!fetchImpl) return null;
  for (const url of urls) {
    try {
      const manifest = await fetchJson(url, fetchImpl);
      writeCache(cache, manifest, now);
      return manifest;
    } catch (e) {
      // try the next location; a missing manifest is not an error the page
      // should show (a locally served page has no published firmware)
      console.info(`firmware manifest: ${e.message}`);
    }
  }
  return null;
}

/** Download a release binary, reporting bytes as they arrive. */
export async function fetchRelease(release, onProgress, fetchImpl = fetch) {
  const r = await fetchImpl(release.url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`firmware download failed: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || release.size || 0;
  if (!r.body || typeof r.body.getReader !== 'function') {
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (onProgress) onProgress(bytes.length, total || bytes.length);
    return bytes;
  }
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (onProgress) onProgress(got, total || got);
  }
  return concat(parts);
}

/* ---------- what the page should offer ---------- */

/**
 * Decide what the update card shows for the connected firmware.
 *
 * `running` is `SidClock.firmware` (the hello/legacy descriptor version),
 * `smp` says whether the update service is reachable (R/W mode).
 */
export function planUpdate({ manifest, running, connected = true, smp = false }) {
  const latest = manifest && manifest.latest;
  if (!latest || !latest.version || !latest.url) return { state: 'no-manifest' };
  if (!running) return { state: 'unknown', release: latest };
  const cmp = cmpVersion(running, latest.version);
  if (cmp === 0) return { state: 'up-to-date', running, release: latest };
  if (cmp > 0) return { state: 'ahead', running, release: latest };
  const canInstall = !!(connected && smp);
  return {
    state: 'available',
    running,
    release: latest,
    canInstall,
    why: canInstall ? ''
      : !connected ? 'connect to the device first'
        : 'the device must be in BLE R/W mode (its main screen says so)',
  };
}
