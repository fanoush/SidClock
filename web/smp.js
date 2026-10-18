/*
 * Minimal SMP (mcumgr Simple Management Protocol) client over the
 * Bluetooth SMP characteristic, used for file uploads to /home.
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
 */

export const SMP_SERVICE = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHARACTERISTIC = 'da2e7828-fbce-4e01-ae9e-261174997c48';

const GROUP_OS = 0;
const GROUP_FS = 8;

const OP_READ = 0;
const OP_WRITE = 2;

const VERSION = 1; // SMPv2, what smpclient sends

const CMD_OS_MCUMGR_PARAMS = 6;
const CMD_FS_DOWNLOAD_UPLOAD = 0;
const CMD_FS_STATUS = 1;
const CMD_FS_CLOSE = 4;

/* the largest ATT write to the device: its 247-byte ATT MTU minus the
 * 3-byte ATT header. Only a starting guess - if a write fails the client
 * halves it and retries the frame from the start (nothing was sent). */
const ATT_CHUNK_MAX = 244;

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
  } else {
    throw new Error(`CBOR: unsupported length encoding ${info}`);
  }

  switch (major) {
    case 0:
      return [n, o + adv];
    case 1:
      return [-1 - n, o + adv];
    case 2:
      return [b.subarray(o + adv, o + adv + n), o + adv + n];
    case 3:
      return [new TextDecoder().decode(b.subarray(o + adv, o + adv + n)),
              o + adv + n];
    case 4: {
      const arr = [];
      let p = o + adv;
      for (let i = 0; i < n; i++) {
        const [v, q] = decodeItem(b, p);
        arr.push(v);
        p = q;
      }
      return [arr, p];
    }
    case 5: {
      const map = {};
      let p = o + adv;
      for (let i = 0; i < n; i++) {
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
    const rc = msg.rc;
    let what = GENERIC_RC[rc] || `rc ${rc}`;
    if (msg.err && typeof msg.err === 'object') {
      what = FS_RC[msg.err.rc] || `${what} (group ${msg.err.group})`;
    }
    super(`device refused: ${what}`);
    this.name = 'SmpError';
    this.rc = rc;
    if (msg.err && typeof msg.err === 'object') {
      this.err = { group: msg.err.group, rc: msg.err.rc };
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
    this.rx = new Uint8Array(0);
    this.waiter = null;
    this.started = false;
    this.onLog = () => {};
  }

  /** Subscribe and learn the device's SMP buffer size. */
  async start() {
    if (this.started) return this;
    this._listener = (ev) => {
      const v = ev.target.value;
      this._rx(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    };
    this.char.addEventListener('characteristicvaluechanged', this._listener);
    await this.char.startNotifications();
    this.started = true;
    try {
      const p = await this.request(OP_READ, GROUP_OS, CMD_OS_MCUMGR_PARAMS,
                                   cborMap([]), { retries: 1 });
      if (Number.isSafeInteger(p.buf_size) && p.buf_size >= 256) {
        this.bufSize = p.buf_size;
      }
    } catch (e) {
      this.onLog(`mcumgr parameters unavailable (${e.message}); ` +
                 `using ${this.bufSize}-byte frames`);
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
    throw last;
  }

  _exchange(frame, timeoutMs) {
    return new Promise((resolve, reject) => {
      const seq = frame[6];
      const timer = setTimeout(() => {
        if (this.waiter && this.waiter.seq === seq) this.waiter = null;
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
    if (typeof msg.rc === 'number' && msg.rc !== 0) throw new SmpError(msg);
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
      return;
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
}
