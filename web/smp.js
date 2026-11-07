/*
 * Minimal SMP (mcumgr Simple Management Protocol) client over the
 * Bluetooth SMP characteristic: file uploads to /home (fs_mgmt) and
 * firmware updates (img_mgmt + os reset).
 *
 * The wire format mirrors smpmgr/smpclient: an 8-byte big-endian header
 * (op | version << 3, flags, length, group id, sequence, command id)
 * followed by a CBOR payload. One request is one frame and one round
 * trip; a frame that does not fit in one ATT write is split into
 * MTU-sized writes - the device reassembles it (Zephyr's BT SMP
 * transport runs with CONFIG_MCUMGR_TRANSPORT_BT_REASSEMBLY).
 *
 * The largest frame the device accepts is its mcumgr buffer size
 * (CONFIG_MCUMGR_TRANSPORT_NETBUF_SIZE, 2048 here), reported by the
 * OS/parameters command; frames are packed to that size so each round
 * trip carries as much file data as possible.
 *
 * Firmware upload and arming are two separate requests, exactly like
 * `tools/flash_ota.py`: `uploadImage()` writes slot 1, `armImage()` marks
 * it for a test swap, and the device applies it on the next reset. The
 * image hash to arm is the MCUboot SHA-256 TLV value (the hash of the
 * header and body), which the page computes itself - see update.js.
 */

export const SMP_SERVICE = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHARACTERISTIC = 'da2e7828-fbce-4e01-ae9e-261174997c48';

const GROUP_OS = 0;
const GROUP_IMG = 1;
const GROUP_FS = 8;

const OP_READ = 0;
const OP_WRITE = 2;

const VERSION = 1; // SMPv2, what smpclient sends

const CMD_OS_MCUMGR_PARAMS = 6;
const CMD_OS_RESET = 5;
const CMD_FS_DOWNLOAD_UPLOAD = 0;
const CMD_FS_STATUS = 1;
const CMD_FS_CLOSE = 4;
const CMD_IMG_STATE = 0;   // read lists the slots, write arms one
const CMD_IMG_UPLOAD = 1;
const CMD_IMG_ERASE = 5;

/* the largest ATT write to the device: its 247-byte ATT MTU minus the
 * 3-byte ATT header. Only a starting guess - if a write fails the client
 * halves it and retries the frame from the start (nothing was sent). */
const ATT_CHUNK_MAX = 244;

/* the transport probe in start(): short, because a silent link is a
 * state the page reports instead of waiting it out */
const PROBE_TIMEOUT_MS = 1500;

/* sizeof(struct image_header): Zephyr's img_mgmt rejects an upload that
 * starts at offset 0 unless the request carries this much image data
 * (the header check needs the MCUboot magic and the version). */
const IMAGE_HEADER_SIZE = 32;

const GENERIC_RC = [
  'ok', 'unknown error', 'out of memory', 'bad value', 'timed out',
  'not found', 'bad state', 'response too large', 'not supported',
  'corrupt', 'busy', 'access denied', 'protocol too old',
  'protocol too new',
];

const FS_RC = [
  'ok', 'unknown error', 'invalid file name', 'file not found',
  'is a directory', 'open failed', 'seek failed', 'read failed',
  'truncate failed', 'delete failed', 'write failed', 'bad offset',
  'offset beyond file', 'hash type not found', 'mount not found',
  'read-only filesystem', 'file is empty',
];

/* IMG_MGMT_ERR from Zephyr's mcumgr image group (subsys/mgmt/mcumgr/grp/
 * img_mgmt/include/mgmt/img_mgmt.h). Kept complete so an unexpected code
 * still has a name. */
const IMG_RC = [
  'ok', 'unknown error', 'cannot query the flash layout', 'no image in the slot',
  'the image has no TLVs', 'invalid TLV', 'multiple hash TLVs',
  'invalid TLV size', 'no hash TLV', 'no free slot', 'flash open failed',
  'flash read failed', 'flash write failed', 'flash erase failed',
  'invalid slot', 'out of memory', 'flash context already set',
  'flash context not set', 'no flash device', 'invalid page offset',
  'missing offset', 'missing length', 'image too short for its header',
  'bad image magic', 'invalid hash', 'load address does not match the slot',
  'cannot read the running version', 'the running image is newer',
  'an image is already pending', 'invalid vector table', 'image too large',
  'more data than the image length', 'image confirmation denied',
  'cannot set the active slot to test',
  'the active slot cannot be determined',
];

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const hexOf = (bytes) => {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
};

const bytesOfHex = (hex) => {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/* ---------- CBOR (just what SMP uses: uint, bytes, text, map) ---------- */

function head(major, n) {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 0x10000) {
    return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  }
  if (n < 0x100000000) {
    return new Uint8Array([
      (major << 5) | 26,
      (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff,
    ]);
  }
  const b = new Uint8Array(9);
  b[0] = (major << 5) | 27;
  new DataView(b.buffer).setBigUint64(1, BigInt(n));
  return b;
}

export const cborUint = (n) => head(0, n);
export const cborBytes = (u8) => concat([head(2, u8.length), u8]);
export const cborText = (s) => {
  const u = new TextEncoder().encode(s);
  return concat([head(3, u.length), u]);
};
/** CBOR boolean: 0xf4/0xf5. */
export const cborBool = (b) => new Uint8Array([b ? 0xf5 : 0xf4]);

/** Map from [key, encodedValue] pairs, in the order given (callers keep
 *  the canonical key order smpclient uses, though the device does not
 *  care). */
export function cborMap(pairs) {
  const parts = [head(5, pairs.length)];
  for (const [k, v] of pairs) parts.push(cborText(k), v);
  return concat(parts);
}

function decodeItem(b, o) {
  if (o >= b.length) throw new Error('CBOR: truncated value');
  const ib = b[o];
  const major = ib >> 5;
  const info = ib & 0x1f;
  let n = 0;
  let adv = 1;
  let indef = false;
  if (info < 24) {
    n = info;
  } else if (info === 24) {
    if (o + 1 >= b.length) throw new Error('CBOR: truncated value');
    n = b[o + 1];
    adv = 2;
  } else if (info === 25) {
    if (o + 2 >= b.length) throw new Error('CBOR: truncated value');
    n = (b[o + 1] << 8) | b[o + 2];
    adv = 3;
  } else if (info === 26) {
    if (o + 4 >= b.length) throw new Error('CBOR: truncated value');
    n = ((b[o + 1] << 24) | (b[o + 2] << 16) | (b[o + 3] << 8) |
         b[o + 4]) >>> 0;
    adv = 5;
  } else if (info === 27) {
    if (o + 8 >= b.length) throw new Error('CBOR: truncated value');
    n = Number(new DataView(b.buffer, b.byteOffset + o + 1, 8)
      .getBigUint64(0));
    adv = 9;
  } else if (info === 31) {
    /* Indefinite length: strings, arrays and maps run until a 0xff
     * break byte. The device's zcbor encoder emits maps this way (the
     * mcumgr parameters answer is `bf 68 "buf_size" ... ff`), and a
     * definite-only decoder dies on the very first response. */
    if (major < 2 || major > 5) {
      throw new Error(`CBOR: unsupported indefinite value (major ${major})`);
    }
    indef = true;
  } else {
    throw new Error(`CBOR: unsupported length encoding ${info}`);
  }

  switch (major) {
    case 0:
      return [n, o + adv];
    case 1:
      return [-1 - n, o + adv];
    case 2:
    case 3: {
      const isText = major === 3;
      if (!indef) {
        if (o + adv + n > b.length) throw new Error('CBOR: truncated value');
        const part = b.subarray(o + adv, o + adv + n);
        return [isText ? new TextDecoder().decode(part) : part,
                o + adv + n];
      }
      const parts = [];
      let p = o + 1;
      for (;;) {
        if (p >= b.length) throw new Error('CBOR: truncated value');
        if (b[p] === 0xff) { p++; break; }
        const [v, q] = decodeItem(b, p);
        if (isText ? typeof v !== 'string' : !(v instanceof Uint8Array)) {
          throw new Error('CBOR: mixed indefinite string chunks');
        }
        parts.push(v);
        p = q;
      }
      return [isText ? parts.join('') : concat(parts), p];
    }
    case 4: {
      const arr = [];
      let p = o + adv;
      for (let i = 0; indef || i < n; i++) {
        if (indef) {
          if (p >= b.length) throw new Error('CBOR: truncated value');
          if (b[p] === 0xff) { p++; break; }
        }
        const [v, q] = decodeItem(b, p);
        arr.push(v);
        p = q;
      }
      return [arr, p];
    }
    case 5: {
      const map = {};
      let p = o + adv;
      for (let i = 0; indef || i < n; i++) {
        if (indef) {
          if (p >= b.length) throw new Error('CBOR: truncated value');
          if (b[p] === 0xff) { p++; break; }
        }
        const [k, p1] = decodeItem(b, p);
        const [v, p2] = decodeItem(b, p1);
        map[String(k)] = v;
        p = p2;
      }
      return [map, p];
    }
    case 7:
      if (info === 20) return [false, o + adv];
      if (info === 21) return [true, o + adv];
      if (info === 22) return [null, o + adv];
      if (info === 23) return [undefined, o + adv];
      if (info === 26) {
        return [new DataView(b.buffer, b.byteOffset + o + 1, 4)
          .getFloat32(0), o + 5];
      }
      if (info === 27) {
        return [new DataView(b.buffer, b.byteOffset + o + 1, 8)
          .getFloat64(0), o + 9];
      }
      throw new Error(`CBOR: unsupported simple value ${info}`);
    default:
      throw new Error(`CBOR: unsupported major type ${major}`);
  }
}

/** Decode the first CBOR value in `bytes`. */
export function cborDecode(bytes) {
  return decodeItem(bytes, 0)[0];
}

/** An SMP error response, with a human-readable `message`. */
export class SmpError extends Error {
  constructor(msg) {
    const err = (msg && typeof msg.err === 'object') ? msg.err : null;
    const rc = typeof msg.rc === 'number' ? msg.rc : undefined;
    let what = GENERIC_RC[rc] || 'unknown error';
    if (err) {
      const table = err.group === 1 ? IMG_RC
        : err.group === 8 ? FS_RC : null;
      what = (table && table[err.rc]) ||
        `${what} (group ${err.group} rc ${err.rc})`;
    }
    super(`device refused: ${what}`);
    this.name = 'SmpError';
    /* the image group's error code is the interesting one when both
     * shapes are present */
    this.rc = err ? err.rc : rc;
    if (err) {
      this.err = { group: err.group, rc: err.rc };
    }
  }
}

function makeFrame(op, group, seq, cmd, payload) {
  const frame = new Uint8Array(8 + payload.length);
  const dv = new DataView(frame.buffer);
  frame[0] = op | (VERSION << 3);
  frame[1] = 0;
  dv.setUint16(2, payload.length);
  dv.setUint16(4, group);
  frame[6] = seq;
  frame[7] = cmd;
  frame.set(payload, 8);
  return frame;
}

export class SmpClient {
  /**
   * @param {BluetoothRemoteGATTCharacteristic} characteristic
   *   the SMP characteristic (write without response + notify)
   */
  constructor(characteristic, { timeoutMs = 5000, retries = 2 } = {}) {
    this.char = characteristic;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.seq = 0;
    this.bufSize = 512; // refined by the mcumgr parameters read
    this.chunk = ATT_CHUNK_MAX;
    /* the first image request erases the secondary slot and can take a
     * moment longer than a file chunk */
    this.imageTimeoutMs = 20000;
    this.rx = new Uint8Array(0);
    this.waiter = null;
    this.started = false;
    /* false when the device never answered the transport probe: the page
     * hides uploads and updates instead of letting each press run into
     * a row of timeouts (see start()) */
    this.healthy = true;
    this.problem = '';
    this.onLog = () => {};
  }

  /** Subscribe and learn the device's SMP buffer size.
   *
   *  The parameters read doubles as the transport probe: an SMP link
   *  that does not answer it does not answer anything, and a page that
   *  pretends otherwise turns one broken link into 15 s of timeouts per
   *  press. A lost *first* notification looks exactly the same, so the
   *  CCC is armed once more before the link is called dead. */
  async start() {
    if (this.started) return this;
    this._listener = (ev) => {
      const v = ev.target.value;
      this._rx(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    };
    this.char.addEventListener('characteristicvaluechanged', this._listener);
    await this.char.startNotifications();
    this.started = true;

    const probe = () => this.request(OP_READ, GROUP_OS, CMD_OS_MCUMGR_PARAMS,
                                     cborMap([]), {
                                       retries: 0,
                                       timeoutMs: Math.min(this.timeoutMs,
                                                          PROBE_TIMEOUT_MS),
                                     });
    let params = null;
    let silent = null;
    for (let attempt = 0; attempt < 2 && !params; attempt++) {
      try {
        params = await probe();
      } catch (e) {
        /* an *answer* (even an error) proves the transport works */
        if (!e.timeout) {
          silent = null;
          break;
        }
        silent = e;
        if (attempt === 0) {
          this.onLog('no answer to the mcumgr parameters read; ' +
                     're-subscribing once');
          try {
            await this.char.stopNotifications();
          } catch (err) { /* the link is gone: the probe below says so */ }
          await this.char.startNotifications();
        }
      }
    }
    if (!params && silent) {
      this.healthy = false;
      this.problem = 'the device is not answering mcumgr (SMP), so tune ' +
        'uploads and firmware updates are off - reconnect; if it stays ' +
        'silent, check that the clock is in BLE R/W mode';
      this.onLog(`${this.problem} (${silent.message}); ` +
                 `using ${this.bufSize}-byte frames`);
      return this;
    }
    this.healthy = true;
    this.problem = '';
    if (params && Number.isSafeInteger(params.buf_size) &&
        params.buf_size >= 256) {
      this.bufSize = params.buf_size;
    }
    return this;
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    try {
      this.char.removeEventListener('characteristicvaluechanged',
                                    this._listener);
    } catch (e) { /* already gone */ }
    try {
      await this.char.stopNotifications();
    } catch (e) { /* already gone */ }
  }

  /* one request, one response */
  async request(op, group, cmd, payload, opts = {}) {
    const retries = opts.retries === undefined ? this.retries : opts.retries;
    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.seq = (this.seq + 1) & 0xff;
      const frame = makeFrame(op, group, this.seq, cmd, payload);
      try {
        const resp = await this._exchange(frame, timeoutMs);
        return this._parse(resp);
      } catch (e) {
        if (!e.timeout) throw e;
        last = e;
      }
    }
    /* name the request that went unanswered: "seq 5" alone says nothing
     * when the console is the only clue (group 1 = image, 8 = files) */
    if (last) last.message += ` (group ${group}, command ${cmd})`;
    throw last;
  }

  _exchange(frame, timeoutMs) {
    return new Promise((resolve, reject) => {
      const seq = frame[6];
      const timer = setTimeout(() => {
        if (this.waiter && this.waiter.seq === seq) this.waiter = null;
        /* Nothing arrived (or only part of a frame did, e.g. a lost
         * notification): whatever is buffered now can never complete
         * with this request, and a partial frame would desync every
         * later response (each one appended behind it, so no length ever
         * matches again - the link looks dead while the device answers).
         * SMP has one request in flight, so dropping it is safe. */
        this.rx = new Uint8Array(0);
        const e = new Error(`no answer to SMP request (seq ${seq})`);
        e.timeout = true;
        reject(e);
      }, timeoutMs);
      this.waiter = {
        seq,
        resolve: (f) => { clearTimeout(timer); resolve(f); },
      };
      this._write(frame).catch((e) => {
        if (this.waiter && this.waiter.seq === seq) this.waiter = null;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  _parse(frame) {
    const length = (frame[2] << 8) | frame[3];
    const isResponse = (frame[0] & 1) === 1 &&
      ((frame[0] >> 3) & 3) === VERSION;
    if (!isResponse || frame[1] !== 0) {
      throw new Error(`unexpected SMP response header (op ${frame[0]})`);
    }
    const msg = length ? cborDecode(frame.subarray(8, 8 + length)) : {};
    /* mcumgr reports group errors as a nested map (`err.group`/`err.rc`);
     * only the legacy protocol puts a non-zero `rc` at the top level.
     * Both shapes must abort the request - silently accepting an error
     * response is what turned a rejected upload chunk into a stall. */
    const failed = (typeof msg.rc === 'number' && msg.rc !== 0) ||
      (msg.err !== null && typeof msg.err === 'object');
    if (failed) throw new SmpError(msg);
    return msg;
  }

  _rx(chunk) {
    this.rx = concat([this.rx, chunk]);
    while (this.rx.length >= 8) {
      const length = (this.rx[2] << 8) | this.rx[3];
      if (this.rx.length < 8 + length) return;
      const frame = this.rx.slice(0, 8 + length);
      this.rx = this.rx.slice(8 + length);
      if (!this.waiter) {
        this.onLog('ignoring unsolicited SMP response');
        continue;
      }
      if (frame[6] !== this.waiter.seq) {
        this.onLog(`ignoring stale SMP response (seq ${frame[6]})`);
        continue;
      }
      const w = this.waiter;
      this.waiter = null;
      w.resolve(frame);
      /* keep draining: one notification can carry more than one frame
       * (the device is free to batch notifications), and a frame left
       * behind here would wait for the *next* notification */
    }
  }

  /** Send one SMP frame as ATT writes of at most `this.chunk` bytes. */
  async _write(frame) {
    for (;;) {
      let sent = 0;
      try {
        for (let off = 0; off < frame.length; off += this.chunk) {
          const part = frame.subarray(off, off + this.chunk);
          await this._attWrite(part);
          sent += part.length;
        }
        return;
      } catch (e) {
        if (sent === 0 && this.chunk > 20) {
          this.chunk = Math.max(20, this.chunk >> 1);
          this.onLog(`write rejected (${e.message}); retrying with ` +
                     `${this.chunk}-byte ATT chunks`);
          continue;
        }
        throw e;
      }
    }
  }

  _attWrite(part) {
    if (this.char.properties &&
        this.char.properties.writeWithoutResponse === false) {
      return this.char.writeValueWithResponse(part);
    }
    return this.char.writeValueWithoutResponse(part);
  }

  _uploadPayload(name, off, data, total, first) {
    const pairs = [];
    if (first) pairs.push(['len', cborUint(total)]);
    pairs.push(['off', cborUint(off)]);
    pairs.push(['data', cborBytes(data)]);
    pairs.push(['name', cborText(name)]);
    return cborMap(pairs);
  }

  /* the largest data slice whose whole frame fits the device buffer */
  _fitData(name, off, bytes, total) {
    let n = Math.min(bytes.length - off, this.bufSize);
    for (;;) {
      const payload = this._uploadPayload(name, off,
        bytes.subarray(off, off + n), total, off === 0);
      const room = this.bufSize - 8 - payload.length;
      if (room >= 0 || n <= 1) return n;
      n = Math.max(1, n + room);
    }
  }

  /**
   * Upload `bytes` to `name` (the first chunk carries the total length,
   * so the device creates/truncates the file). `onProgress(off, total)`.
   */
  async uploadFile(name, bytes, onProgress) {
    const total = bytes.length;
    let off = 0;
    do {
      const n = this._fitData(name, off, bytes, total);
      const payload = this._uploadPayload(name, off,
        bytes.subarray(off, off + n), total, off === 0);
      const r = await this.request(OP_WRITE, GROUP_FS, CMD_FS_DOWNLOAD_UPLOAD,
                                   payload);
      const next = Number.isSafeInteger(r.off) ? r.off : off + n;
      if (n > 0 && next <= off) throw new Error('upload stalled');
      off = next;
      if (onProgress) onProgress(off, total);
    } while (off < total);
    /* the device acknowledges chunks by offset, so a lost tail would
     * otherwise look like a complete upload: ask for the length it
     * really has before calling this done */
    const st = await this.status(name);
    if (!st || st.len !== total) {
      throw new Error(`upload verify failed: ${st ? st.len : 0} of ` +
                      `${total} bytes on the device`);
    }
  }

  /** Download `name` into a Uint8Array. `onProgress(got, total)`. */
  async downloadFile(name, onProgress) {
    const parts = [];
    let off = 0;
    let total = null;
    for (;;) {
      const r = await this.request(OP_READ, GROUP_FS, CMD_FS_DOWNLOAD_UPLOAD,
        cborMap([['off', cborUint(off)], ['name', cborText(name)]]));
      const data = r.data instanceof Uint8Array ? r.data : new Uint8Array(0);
      parts.push(data);
      off += data.length;
      if (total === null && Number.isSafeInteger(r.len)) total = r.len;
      if (onProgress) onProgress(off, total === null ? off : total);
      if (total !== null && off >= total) break;
      if (data.length === 0) break; // no more data and no length: done
    }
    return concat(parts);
  }

  /** File length on the device, or null when it does not exist. */
  async status(name) {
    try {
      return await this.request(OP_READ, GROUP_FS, CMD_FS_STATUS,
        cborMap([['name', cborText(name)]]));
    } catch (e) {
      if (e instanceof SmpError) return null;
      throw e;
    }
  }

  /** Let the device close the file handle (best effort). */
  async fileClose() {
    try {
      await this.request(OP_WRITE, GROUP_FS, CMD_FS_CLOSE, cborMap([]),
                         { retries: 0 });
    } catch (e) { /* the handle times out on its own */ }
  }

  /* ---------- mcumgr image management (firmware updates) ---------- */

  /** The device's slots: [{ slot, version, hash, active, pending,
   *  confirmed, permanent }], hashes as lowercase hex. */
  async imageState() {
    const r = await this.request(OP_READ, GROUP_IMG, CMD_IMG_STATE,
                                 cborMap([]));
    const list = Array.isArray(r.images) ? r.images : [];
    return list.map((im) => ({
      slot: im.slot,
      version: im.version || '',
      hash: im.hash instanceof Uint8Array ? hexOf(im.hash) : '',
      active: !!im.active,
      pending: !!im.pending,
      confirmed: !!im.confirmed,
      permanent: !!im.permanent,
    }));
  }

  _imageUploadPayload(off, data, { total, image, sha, declare }) {
    const pairs = [];
    if (declare === undefined ? off === 0 : declare) {
      /* the first request declares the session: length, image number and
       * the whole-file SHA-256 (used by the device to identify a resumed
       * upload and to verify the result) */
      pairs.push(['len', cborUint(total)]);
      pairs.push(['image', cborUint(image)]);
      if (sha && sha.length) pairs.push(['sha', cborBytes(sha)]);
    }
    pairs.push(['off', cborUint(off)]);
    pairs.push(['data', cborBytes(data)]);
    return cborMap(pairs);
  }

  /* the largest data slice whose whole frame fits the device buffer */
  _fitImageData(off, bytes, extra) {
    let n = Math.min(bytes.length - off, this.bufSize);
    for (;;) {
      const payload = this._imageUploadPayload(
        off, bytes.subarray(off, off + n), extra);
      const room = this.bufSize - 8 - payload.length;
      if (room >= 0 || n <= 1) return { n, payload };
      n = Math.max(1, n + room);
    }
  }

  /**
   * Upload `bytes` into the secondary slot, like `smpmgr upgrade --slot 1`.
   * `sha` is the SHA-256 of the whole file; every response carries the next
   * expected offset, so a stalled chunk resumes where the device stopped.
   * Arm the result with `armImage()` - this only writes the slot.
   *
   * Zephyr's img_mgmt only accepts an upload that starts at offset 0 when
   * that same request also carries `len` (and `image`) *and* at least
   * `sizeof(struct image_header)` bytes of image data: there is no
   * "declare-only" request. So the first chunk both opens the session and
   * carries the MCUboot header, exactly like smpclient's first packet.
   */
  async uploadImage(bytes, { sha = null, image = 0, onProgress } = {}) {
    const total = bytes.length;
    let off = 0;
    let first = true;
    let restarts = 0;
    if (onProgress) onProgress(0, total);
    while (off < total) {
      const { n, payload } = this._fitImageData(off, bytes,
        { total, image, sha, declare: first });
      if (first && n < IMAGE_HEADER_SIZE) {
        throw new Error(`the ${this.bufSize}-byte device buffer is too ` +
                        'small for an image header');
      }
      /* the first request erases the secondary slot: it can take longer
       * than a plain data chunk */
      const r = await this.request(OP_WRITE, GROUP_IMG, CMD_IMG_UPLOAD,
        payload, first ? { timeoutMs: this.imageTimeoutMs } : {});
      if (r.match === false) {
        throw new Error('the device rejected the image: its SHA-256 does ' +
                        'not match the manifest');
      }
      const next = Number.isSafeInteger(r.off) ? r.off : off + n;
      if (n > 0 && next < off) {
        /* the device is behind us: either our chunk lost the race with a
         * retry or it finished the image and dropped the session (a lost
         * answer to the last chunk). Rewind to where it says it is and,
         * when it lost the session entirely, declare the upload again. */
        if (++restarts > 2) {
          throw new Error('image upload stalled: the device keeps resetting ' +
                          'the upload - reconnect and try again');
        }
        off = next;
        first = next === 0;
        if (onProgress) onProgress(off, total);
        continue;
      }
      if (n > 0 && next === off) {
        throw new Error('image upload stalled: the device stopped accepting ' +
                        'chunks - reconnect and try again');
      }
      off = next;
      first = false;
      if (onProgress) onProgress(off, total);
    }
  }

  /** Mark the image with `hash` (hex) for a *test* swap: MCUboot boots it
   *  on the next reset and rolls back a bad image. This is the same thing
   *  `image state-write` does in smpmgr/flash_ota.py. */
  async armImage(hash) {
    return this.request(OP_WRITE, GROUP_IMG, CMD_IMG_STATE,
      cborMap([
        ['hash', cborBytes(bytesOfHex(hash))],
        ['confirm', cborBool(false)],
      ]));
  }

  /** Erase a slot (slot 1 by default: drop a staged update). */
  async eraseImage(slot = 1) {
    return this.request(OP_WRITE, GROUP_IMG, CMD_IMG_ERASE,
                        cborMap([['slot', cborUint(slot)]]),
                        { timeoutMs: this.imageTimeoutMs });
  }

  /** Reboot the device (MCUboot applies a swap on the way up). The link
   *  usually drops before the answer, so a timeout is success. */
  async reset() {
    try {
      await this.request(OP_WRITE, GROUP_OS, CMD_OS_RESET, cborMap([]),
                         { retries: 0, timeoutMs: 3000 });
    } catch (e) {
      if (!e.timeout) throw e;
    }
  }
}
