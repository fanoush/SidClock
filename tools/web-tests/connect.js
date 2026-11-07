/*
 * Page-level connection test for the web remote, with a fake Web
 * Bluetooth device (no hardware or Bluetooth permission needed).
 *
 * The fake link behaves like a fresh Android connection: the first
 * confirmation-based GATT operation (here the CCC descriptor write) can
 * fail with "GATT operation failed" while the link itself is fine, and it
 * stays wedged until the client reconnects. The page must keep the
 * connection and the transport controls usable, and it heals the failed
 * subscription with one silent reconnect; it used to stay on "Connect",
 * so the next click disconnected the live link instead.
 */

/* ---------- tiny harness (same report format as tests.js) ---------- */

import { clearManifestCache } from '../../web/update.js';
import {
  IMAGE_BASE64, IMAGE_SIZE, IMAGE_VERSION, IMAGE_HASH, FILE_SHA256,
} from './fixtures/image.js';

const out = document.getElementById('out');
const results = [];
let current = null;
const RECORD = new URLSearchParams(location.search).has('record');

async function test(name, fn) {
  current = { name, ok: false, error: '', notes: [] };
  results.push(current);
  try {
    await fn();
    current.ok = true;
  } catch (e) {
    current.error = (e && e.stack) || String(e);
  }
  current = null;
  report();
}

function note(...parts) {
  if (current) current.notes.push(parts.join(' '));
}

function report() {
  const failed = results.filter((r) => !r.ok);
  out.textContent = results.map((r) => {
    const head = r.ok
      ? `ok   ${r.name}`
      : `FAIL ${r.name}\n     ${r.error.split('\n').join('\n     ')}`;
    const notes = r.notes.map((n) => `     · ${n}`).join('\n');
    return notes ? `${head}\n${notes}` : head;
  }).join('\n') + `\n\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? ` - ${failed.length} FAILED` : '') + '\n';
  document.title = failed.length
    ? `FAIL ${failed.length}/${results.length}`
    : `PASS ${results.length}`;
  if (RECORD) fetch('/__result__', { method: 'POST', body: out.textContent })
    .catch(() => {});
}

function ok(cond, what = 'expected true') {
  if (!cond) throw new Error(what);
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${what ? `${what}: ` : ''}${a} !== ${b}`);
  }
}

function waitFor(cond, what, ms = 5000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    (function poll() {
      let value;
      try {
        value = cond();
      } catch (e) {
        reject(e);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (performance.now() - start > ms) {
        reject(new Error(`timeout: ${what}`));
        return;
      }
      setTimeout(poll, 20);
    })();
  });
}

/* ---------- fake Web Bluetooth device ---------- */

/* Runs inside the iframe before app.js; must be self-contained (it is
 * stringified and inlined into the page). */
function installBleMock() {
  /* Which firmware the fake device pretends to be. The page has to pick a
   * protocol descriptor for each of these (hello, legacy probe, and a
   * firmware older than the state characteristic). */
  const OPTS = window.__bleOptions || {};
  const PROFILE = window.__bleProfile || 'hello';
  const HELLO = PROFILE === 'hello';
  const HAS_STATE = PROFILE !== '1.0.7';
  const HAS_INFO = PROFILE !== '1.0.7';
  const DEBUG_SIZE = (PROFILE === '1.0.7' || PROFILE === '1.0.9') ? 140 : 160;
  const SMP = !!OPTS.smp;
  /* the field failure: the SMP characteristic is there, the CCC write is
   * accepted, but the device never answers a request on it */
  const SMP_SILENT = !!OPTS.silentSmp;
  const REBOOT_TO = OPTS.rebootTo || null;
  /* the field failure: after `os reset` the device stops answering, but
   * the browser keeps the old link "connected" for a while; every
   * operation on it fails with NetworkError until the page disconnects */
  let zombie = false;

  const clock = {
    profile: PROFILE,
    requests: 0, connects: 0, stateReads: 0, infoReads: 0, helloReads: 0,
    subs: 0, failConnect: 0, failState: 0, failInfo: 0, failSub: 0,
    failHello: 0, failDbgReads: 0, writes: [], poisoned: false,
    subscribed: false,
    smpSubs: 0, uploads: 0, arms: 0, erases: 0, resets: 0, reboots: 0,
  };

  /* ---------- CBOR + SMP framing, for the fake image-management group ---------- */

  const cat = (parts) => {
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
  const head = (major, n) => {
    if (n < 24) return new Uint8Array([(major << 5) | n]);
    if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
    if (n < 65536) {
      return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
    }
    return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff,
                            (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  };
  const cbor = (v) => {
    if (typeof v === 'number') return head(0, v);
    if (typeof v === 'boolean') return new Uint8Array([v ? 0xf5 : 0xf4]);
    if (typeof v === 'string') {
      const u = new TextEncoder().encode(v);
      return cat([head(3, u.length), u]);
    }
    if (v instanceof Uint8Array) return cat([head(2, v.length), v]);
    if (Array.isArray(v)) return cat([head(4, v.length), ...v.map(cbor)]);
    if (v && typeof v === 'object') {
      const pairs = Object.entries(v);
      return cat([head(5, pairs.length),
                  ...pairs.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
    }
    return new Uint8Array([0xf6]);
  };
  const decAt = (b, o) => {
    const ib = b[o];
    const major = ib >> 5;
    const info = ib & 31;
    let n = info;
    let p = o + 1;
    if (info === 24) { n = b[p]; p++; }
    else if (info === 25) { n = (b[p] << 8) | b[p + 1]; p += 2; }
    else if (info === 26) {
      n = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
      p += 4;
    }
    if (major === 0) return [n, p];
    if (major === 2) return [b.slice(p, p + n), p + n];
    if (major === 3) {
      return [new TextDecoder().decode(b.subarray(p, p + n)), p + n];
    }
    if (major === 4) {
      const a = [];
      for (let i = 0; i < n; i++) {
        const [v, q] = decAt(b, p);
        a.push(v);
        p = q;
      }
      return [a, p];
    }
    if (major === 5) {
      const m = {};
      for (let i = 0; i < n; i++) {
        const [k, q] = decAt(b, p);
        const [v, r] = decAt(b, q);
        m[String(k)] = v;
        p = r;
      }
      return [m, p];
    }
    if (major === 7) return [info === 21, p];
    return [null, p];
  };
  const cborDecode = (b) => decAt(b, 0)[0];

  const stateBytes = new Uint8Array(16);
  stateBytes.set([1, 0, 2, 0, 0, 2, 1, 0, 5, 0, 0, 0, 100, 0, 0, 0]);
  const infoBytes = new Uint8Array(96);
  const put = (s, off, n) =>
    infoBytes.set(new TextEncoder().encode(s).subarray(0, n - 1), off);
  put('Test Tune', 0, 32);
  put('test.sid', 32, 24);
  put('Tester', 56, 32);
  put('deadbeef', 88, 8);
  const snapshot = new Uint8Array(DEBUG_SIZE);
  /* the fields 1.0.7 still reports through the debug snapshot */
  snapshot[0] = 1;                       // audio_ready
  snapshot[7] = 100;                     // audio_volume
  snapshot[72] = 1;                      // sid_playing
  snapshot[73] = 3;                      // sid_songs
  snapshot[74] = 0;                      // sid_last_rc
  snapshot.set(new TextEncoder().encode('Old Tune'), 75); // sid_title
  let helloBytes = new Uint8Array([5, 0, 0x20, 0x68,
                                   0xff, 0xff, 0xff, 0x0f,
                                   1, 0, 11, 0]);
  const helloFor = (version) => {
    const [a, b, c] = String(version).split('.').map(Number);
    return new Uint8Array([5, 0, 0x20, 0x68, 0xff, 0xff, 0xff, 0x0f,
                           a || 0, b || 0, (c || 0) & 0xff,
                           ((c || 0) >> 8) & 0xff]);
  };
  if (OPTS.helloVersion) helloBytes = helloFor(OPTS.helloVersion);
  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const err = () => new DOMException('GATT operation failed', 'NetworkError');

  const stateListeners = new Set();
  const state = {
    value: view(stateBytes),
    properties: {},
    async readValue() {
      clock.stateReads++;
      /* like a fresh Android link: a read before the CCC write wedges
       * the connection and the CCC write that follows fails too */
      if (!clock.subscribed) clock.poisoned = true;
      if (clock.failState > 0) {
        clock.failState--;
        throw err();
      }
      return view(stateBytes);
    },
    async startNotifications() {
      clock.subs++;
      if (clock.poisoned) throw err();
      if (clock.failSub > 0) {
        clock.failSub--;
        throw err();
      }
      clock.subscribed = true;
      /* the device forces one notification when the CCC is written */
      setTimeout(() => state.emit(), 0);
    },
    async stopNotifications() {
      clock.subscribed = false;
    },
    addEventListener(type, fn) {
      if (type === 'characteristicvaluechanged') stateListeners.add(fn);
    },
    removeEventListener(type, fn) {
      stateListeners.delete(fn);
    },
    emit(bytes) {
      if (bytes) stateBytes.set(bytes);
      state.value = view(stateBytes);
      for (const fn of [...stateListeners]) fn({ target: state });
    },
  };

  const info = {
    value: view(infoBytes),
    async readValue() {
      clock.infoReads++;
      if (clock.failInfo > 0) {
        clock.failInfo--;
        throw err();
      }
      return view(infoBytes);
    },
  };

  const hello = {
    value: view(helloBytes),
    async readValue() {
      clock.helloReads++;
      if (clock.failHello > 0) {
        clock.failHello--;
        throw err();
      }
      return view(helloBytes);
    },
  };

  const dbg = {
    value: view(snapshot),
    async readValue() {
      /* the first operation of a fresh link can be rejected by Chrome;
       * failDbgReads lets a test drive that path */
      if (clock.failDbgReads > 0) {
        clock.failDbgReads--;
        throw new DOMException('GATT operation failed for unknown reason.',
                               'NotSupportedError');
      }
      return view(snapshot);
    },
    async writeValue(value) {
      clock.writes.push([...value]);
    },
  };

  /* Current Time (0x1805/0x2A2B): a fixed 2026-11-02 12:00:00 that a write
   * replaces, so the page's clock alignment and set-time path can be
   * driven offline. */
  const ctsBytes = new Uint8Array([0xea, 0x07, 11, 2, 12, 0, 0, 1, 0, 0]);
  const cts = {
    value: view(ctsBytes),
    async readValue() {
      return view(ctsBytes);
    },
    async writeValue(value) {
      ctsBytes.set(value);
      clock.ctsWrites = clock.ctsWrites || [];
      clock.ctsWrites.push([...value]);
    },
  };

  /* ---------- the SMP characteristic ---------- */

  const HELLO_UUID = '73696463-6c6f-4b05-9c1d-77ce3f41a5c0';
  const smpListeners = new Set();
  let smpRx = new Uint8Array(0);

  /* image slots: the running image plus an empty secondary */
  const smpSlots = [
    {
      slot: 0,
      version: OPTS.activeVersion || PROFILE,
      hash: new Uint8Array(32).fill(0x11),
      active: true,
      confirmed: true,
    },
    { slot: 1, version: '', hash: null, pending: false },
  ];
  if (OPTS.stagedVersion) {
    smpSlots[1] = {
      slot: 1,
      version: OPTS.stagedVersion,
      hash: OPTS.stagedHash
        ? Uint8Array.from(OPTS.stagedHash.match(/../g),
                          (x) => parseInt(x, 16))
        : new Uint8Array(32).fill(0x33),
      pending: true,
    };
  }
  let smpUpload = null;

  const smpChar = {
    value: null,
    properties: {},
    async startNotifications() {
      clock.smpSubs++;
      clock.smpSubscribed = true;
    },
    async stopNotifications() {
      clock.smpSubscribed = false;
    },
    addEventListener(type, fn) {
      if (type === 'characteristicvaluechanged') smpListeners.add(fn);
    },
    removeEventListener(type, fn) {
      smpListeners.delete(fn);
    },
    async writeValue(value) {
      const b = value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      smpFeed(b);
    },
    async writeValueWithoutResponse(value) {
      return this.writeValue(value);
    },
    async writeValueWithResponse(value) {
      return this.writeValue(value);
    },
  };

  const smpEmit = (bytes) => {
    smpChar.value = view(bytes);
    for (const fn of [...smpListeners]) fn({ target: smpChar });
  };

  const smpFrame = (op, seq, group, cmd, value) => {
    const payload = cbor(value);
    const frame = new Uint8Array(8 + payload.length);
    frame[0] = (op | 1) | 8; // response | SMPv2, mirroring the request op
    frame[2] = payload.length >> 8;
    frame[3] = payload.length & 0xff;
    frame[4] = group;
    frame[5] = 0;
    frame[6] = seq;
    frame[7] = cmd;
    frame.set(payload, 8);
    return frame;
  };
  const smpError = (group, rc) => ({
    rc: 6,
    err: { group, rc },
  });
  const smpState = () => ({
    images: smpSlots.map((s) => ({
      slot: s.slot,
      version: s.version || '',
      hash: s.hash || new Uint8Array(0),
      active: !!s.active,
      pending: !!s.pending,
      confirmed: !!s.confirmed,
    })),
  });

  const smpReboot = () => {
    const sec = smpSlots[1];
    if (sec && sec.pending && !OPTS.revertOnReboot) {
      smpSlots[0] = {
        slot: 0,
        version: sec.version,
        hash: sec.hash,
        active: true,
        confirmed: true,
      };
    }
    smpSlots[1] = { slot: 1, version: '', hash: null, pending: false };
    if (REBOOT_TO) {
      helloBytes = helloFor(REBOOT_TO);
      chars.set(HELLO_UUID, hello);
    }
    clock.reboots++;
    if (OPTS.zombieReboot) {
      /* the device rebooted but the central has not noticed: the link
       * still looks connected and fails every operation */
      zombie = true;
    } else {
      device.gatt.disconnect();
    }
  };

  const smpImage = async (op, cmd, msg, reply) => {
    if (op === 0 && cmd === 0) return reply(smpState());

    if (op === 2 && cmd === 1) { // upload
      if (msg.off === 0) {
        /* Zephyr's img_mgmt: offset 0 starts (or resumes) an upload and
         * needs `len` plus at least an image header in the same request */
        if (!msg.data || msg.data.length < 32) return reply(smpError(1, 22));
        if (typeof msg.len !== 'number') return reply(smpError(1, 21));
        if (msg.data[0] !== 0x3d || msg.data[1] !== 0xb8) {
          return reply(smpError(1, 23));
        }
        smpUpload = { size: msg.len, data: new Uint8Array(msg.len), off: 0 };
      } else {
        const at = smpUpload ? smpUpload.off : 0;
        if (msg.off !== at) return reply({ off: at });
        if (msg.off + msg.data.length > smpUpload.size) {
          return reply(smpError(1, 31));
        }
      }
      smpUpload.data.set(msg.data, msg.off);
      const off = msg.off + msg.data.length;
      smpUpload.off = off;
      if (off === smpUpload.size) {
        clock.uploads++;
        /* the slot reports what the uploaded image says about itself,
         * exactly like the real img_mgmt group */
        const data = smpUpload.data;
        const hdr = data[8] | (data[9] << 8);
        const img = data[12] | (data[13] << 8) | (data[14] << 16) |
          (data[15] << 24);
        const body = data.subarray(0, hdr + img);
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', body));
        smpSlots[1] = {
          slot: 1,
          version: `${data[20]}.${data[21]}.${data[22] | (data[23] << 8)}`,
          hash: digest,
          pending: false,
        };
        smpUpload = null;
      }
      return reply({ off });
    }

    if (op === 2 && cmd === 0) { // state write: arm (test swap) or confirm
      const want = msg.hash || new Uint8Array(0);
      const same = (h) => {
        const b = h || new Uint8Array(0);
        if (b.length !== want.length) return false;
        for (let i = 0; i < b.length; i++) if (b[i] !== want[i]) return false;
        return true;
      };
      if (msg.confirm) {
        if (!want.length || same(smpSlots[0].hash)) {
          smpSlots[0].confirmed = true;
          return reply(smpState());
        }
        return reply(smpError(1, 3));
      }
      clock.arms++;
      if (same(smpSlots[0].hash)) return reply(smpError(1, 33));
      if (!same(smpSlots[1].hash)) return reply(smpError(1, 3));
      smpSlots[1].pending = true;
      return reply(smpState());
    }

    if (op === 2 && cmd === 5) { // erase
      clock.erases++;
      const slot = msg.slot == null ? 1 : msg.slot;
      for (const s of smpSlots) {
        if (s.slot === slot && !s.active) {
          s.hash = null;
          s.version = '';
          s.pending = false;
        }
      }
      return reply({});
    }

    return reply({});
  };

  const smpHandle = async (frame, reply) => {
    if (SMP_SILENT) {
      clock.smpSilent = (clock.smpSilent || 0) + 1;
      return;
    }
    const op = frame[0] & 7;
    const group = (frame[4] << 8) | frame[5];
    const cmd = frame[7];
    const len = (frame[2] << 8) | frame[3];
    let msg = {};
    try {
      msg = cborDecode(frame.subarray(8, 8 + len)) || {};
    } catch (e) { /* an empty payload is a valid empty map */ }
    const send = (value) => reply(smpFrame(op, frame[6], group, cmd, value));
    if (group === 0 && op === 0 && cmd === 6) {
      return send({ buf_size: 2048, buf_count: 2 });
    }
    if (group === 0 && op === 2 && cmd === 5) { // os reset
      clock.resets++;
      send({});
      /* the link drops and the device boots the staged image */
      setTimeout(smpReboot, 40);
      return;
    }
    if (group === 1) return smpImage(op, cmd, msg, send);
    return send({});
  };

  function smpFeed(chunk) {
    smpRx = cat([smpRx, chunk]);
    while (smpRx.length >= 8) {
      const len = (smpRx[2] << 8) | smpRx[3];
      if (smpRx.length < 8 + len) return;
      const frame = smpRx.slice(0, 8 + len);
      smpRx = smpRx.slice(8 + len);
      try {
        smpHandle(frame, smpEmit).catch((e) => console.error('smp mock', e));
      } catch (e) {
        console.error('smp mock', e);
      }
    }
  }

  const smpSvc = {
    async getCharacteristic(uuid) {
      const id = String(uuid).toLowerCase();
      if (id === 'da2e7828-fbce-4e01-ae9e-261174997c48') return smpChar;
      throw new DOMException('not found', 'NotFoundError');
    },
  };

  const chars = new Map([['73696463-6c6f-4b02-9c1d-77ce3f41a5c0', dbg]]);
  if (HAS_STATE) chars.set('73696463-6c6f-4b03-9c1d-77ce3f41a5c0', state);
  if (HAS_INFO) chars.set('73696463-6c6f-4b04-9c1d-77ce3f41a5c0', info);
  if (HELLO) chars.set(HELLO_UUID, hello);
  const sid = {
    async getCharacteristic(uuid) {
      if (!chars.has(uuid)) {
        throw new DOMException('not found', 'NotFoundError');
      }
      return chars.get(uuid);
    },
  };
  const ctsSvc = {
    async getCharacteristic(uuid) {
      if (uuid === 0x2a2b ||
          uuid === '00002a2b-0000-1000-8000-00805f9b34fb') return cts;
      throw new DOMException('not found', 'NotFoundError');
    },
  };
  const server = {
    async getPrimaryService(uuid) {
      if (zombie) {
        throw new DOMException(
          'GATT Server is disconnected. Cannot perform GATT operations. ' +
          '(Re)connect first with `device.gatt.connect`.', 'NetworkError');
      }
      if (uuid === '73696463-6c6f-4b01-9c1d-77ce3f41a5c0') return sid;
      if (SMP && String(uuid).toLowerCase() ===
          '8d53dc1d-1db7-4cd3-868b-8a527460aa84') return smpSvc;
      if (uuid === 0x1805 ||
          uuid === '00001805-0000-1000-8000-00805f9b34fb') return ctsSvc;
      throw new DOMException('not found', 'NotFoundError');
    },
  };

  const gone = new Set();
  const device = {
    name: 'SidClock',
    gatt: {
      connected: false,
      async connect() {
        clock.connects++;
        /* Chrome resolves immediately with the existing server while it
         * still believes the link is up - even a dead one */
        if (this.connected) return server;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (clock.failConnect > 0) {
          clock.failConnect--;
          throw err();
        }
        zombie = false;
        this.connected = true;
        return server;
      },
      disconnect() {
        zombie = false;
        this.connected = false;
        clock.subscribed = false;
        for (const fn of [...gone]) fn();
      },
    },
    addEventListener(type, fn) {
      if (type === 'gattserverdisconnected') gone.add(fn);
    },
    removeEventListener(type, fn) {
      gone.delete(fn);
    },
  };

  Object.defineProperty(navigator, 'bluetooth', {
    value: {
      requestDevice: async () => {
        clock.requests++;
        return device;
      },
    },
    configurable: true,
  });
  clock.device = device;
  clock.state = state;
  clock.smpSlots = smpSlots;
  clock.smpChar = smpChar;
  clock.emitState = (bytes) => state.emit(bytes);
  clock.disconnect = () => device.gatt.disconnect();
  window.__ble = clock;
}

/* ---------- load web/index.html with the mock in front of app.js ---------- */

const webBase = new URL('../../web/', location.href).href;
const indexHtml = await (await fetch('../../web/index.html')).text();

/** The real page with the fake device injected ahead of app.js.
 *  `profile` is 'hello' (1.0.11), '1.0.10' or '1.0.7'; `options.ble` is the
 *  mock configuration (smp, rebootTo, stagedVersion...), `options.manifest`
 *  a firmware manifest fixture served through a fetch override. */
function pageHtmlFor(profile, options = {}) {
  const manifest = options.manifest || null;
  const manifestUrl = options.manifestUrl ||
    'https://fixture.invalid/SidClock/firmware/index.json';
  let firmware = '';
  if (manifest) {
    const target = new URL(manifest.latest.file, manifestUrl).href;
    firmware = `<script>
window.__sidclockFirmwareUrl=${JSON.stringify(manifestUrl)};
(function () {
  const manifest = ${JSON.stringify(manifest)};
  const image = Uint8Array.from(atob(${JSON.stringify(IMAGE_BASE64)}),
                                (c) => c.charCodeAt(0));
  const target = ${JSON.stringify(target)};
  const real = window.fetch;
  window.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url === ${JSON.stringify(manifestUrl)}) {
      return new Response(JSON.stringify(manifest),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === target) {
      return new Response(image, { status: 200 });
    }
    if (real) return real(input, init);
    throw new Error('unexpected fetch ' + url);
  };
})();
</script>\n`;
  }
  const bleOptions = options.ble || {};
  return indexHtml
    .replace('<head>', `<head><base href="${webBase}">`)
    .replace('<script type="module" src="app.js"></script>',
      `<script>window.__bleProfile=${JSON.stringify(profile)};\n` +
      `window.__bleOptions=${JSON.stringify(bleOptions)};</script>\n` +
      firmware +
      '<script>(' + installBleMock.toString() + ')();</script>\n' +
      '<script type="module" src="app.js"></script>');
}

async function loadPage(profile = 'hello', options = {}) {
  clearManifestCache();
  const host = document.getElementById('frame');
  host.textContent = '';
  const frame = document.createElement('iframe');
  host.append(frame);
  const loaded = new Promise((resolve) =>
    frame.addEventListener('load', resolve, { once: true }));
  frame.srcdoc = pageHtmlFor(profile, options);
  await loaded;

  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  const $ = (id) => doc.getElementById(id);
  return {
    frame, win, doc, $,
    ble: win.__ble,
  };
}

/* ---------- tests ---------- */

await test('connect: an info failure leaves the page connected', async () => {
  const p = await loadPage();
  const ble = p.ble;
  ble.failInfo = 99;

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect',
                 'page marks the link connected');
  eq(p.$('status').textContent, 'SidClock', 'status');
  ok(!p.$('play').disabled, 'transport enabled');
  ok(!p.$('librefresh').disabled, 'library refresh enabled');

  await waitFor(() => !p.$('note').hidden &&
    /tune info failed/.test(p.$('note').textContent), 'info error is reported');
  note(`note: ${p.$('note').textContent}`);

  ble.emitState([1, 0, 2, 0, 0, 2, 1, 0, 42, 0, 0, 0, 100, 0, 0, 0]);
  await waitFor(() => p.$('pos').textContent === '0:42',
                 'notifications still update the page');
  eq(p.$('play').textContent, '⏸', 'playing state rendered');

  p.$('play').click();
  await waitFor(() => ble.writes.some((w) => w[0] === 0x18),
                 'play command reaches the device');
});

await test('connect: transient CCC/info failures recover', async () => {
  const p = await loadPage();
  const ble = p.ble;
  ble.failSub = 1;   // first CCC write
  ble.failInfo = 1;  // first info read

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => p.$('title').textContent === 'Test Tune',
                 'title after the info retry');
  await waitFor(() => p.$('pos').textContent === '0:05',
                 'state from the forced notification');
  eq(p.$('subtitle').textContent, 'Tester · test.sid', 'author and file name');
  eq(ble.stateReads, 0, 'no state read before the CCC write');
  eq(ble.connects, 1, 'the in-place retry did not reconnect');
  note(`state reads ${ble.stateReads}, CCC writes ${ble.subs}, ` +
       `info reads ${ble.infoReads}`);
});

await test('connect: the end-mode badge cycles over Bluetooth', async () => {
  const p = await loadPage();
  const ble = p.ble;

  ok(p.$('ends').disabled, 'badge disabled while disconnected');
  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => p.$('ends').textContent === 'ends: next sub',
                 'mode from the pushed state');
  ok(!p.$('ends').disabled, 'badge enabled while connected');

  p.$('ends').click();
  await waitFor(() => ble.writes.some((w) => w[0] === 0x22 && w[1] === 1),
                 'command 0x22 sends the next mode');
  ble.emitState([1, 0, 2, 1, 0, 2, 1, 0, 5, 0, 0, 0, 100, 0, 0, 0]);
  await waitFor(() => p.$('ends').textContent === 'ends: next tune',
                 'device push relabels the badge');

  p.$('ends').click();
  await waitFor(() => ble.writes.some((w) => w[0] === 0x22 && w[1] === 2),
                 'cycles to loop');
  ble.emitState([1, 0, 2, 2, 0, 2, 1, 0, 5, 0, 0, 0, 100, 0, 0, 0]);
  await waitFor(() => p.$('ends').textContent === 'ends: loop sub', 'loops');
});

await test('connect: the volume slider writes 0x37 and follows the state', async () => {
  const p = await loadPage();
  const ble = p.ble;

  ok(p.$('volume').disabled, 'slider disabled while disconnected');
  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => p.$('volume').value === '0', 'volume from the device');
  eq(p.$('volpct').textContent, '0%', 'label matches');

  p.$('volume').value = '128';
  p.$('volume').dispatchEvent(new Event('input'));
  await waitFor(() => ble.writes.some((w) => w[0] === 0x37 && w[1] === 128),
                 'command 0x37 carries the slider value');
  eq(p.$('volpct').textContent, '50%', 'percentage label');

  ble.emitState([1, 0, 2, 0, 0, 2, 1, 200, 5, 0, 0, 0, 100, 0, 0, 0]);
  await waitFor(() => p.$('volume').value === '200', 'device push moves it');
  eq(p.$('volpct').textContent, '78%', 'label follows the push');
});

await test('connect: the clock uses the sub-second field and set time', async () => {
  const p = await loadPage();
  const ble = p.ble;

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => /^12:00:0/.test(p.$('devtime').textContent),
                 'device clock from the CTS read');
  ok(p.$('devtime').classList.contains('warn'),
     'the fixed test clock disagrees with the browser');

  p.$('settime').click();
  await waitFor(() => (ble.ctsWrites || []).length > 0, 'time written');
  const w = ble.ctsWrites[ble.ctsWrites.length - 1];
  eq(w.length, 10, '10-byte Current Time value');
  eq(w[0] | (w[1] << 8), new Date().getFullYear(), 'current year');
  ok(w[8] >= 0 && w[8] <= 255, 'fraction byte present');
  await waitFor(() => !p.$('devtime').classList.contains('warn'),
                 'the clocks agree after a set');
});

await test('connect: the device card collapses to one line when all is well',
  async () => {
    const p = await loadPage();

    p.$('connect').click();
    await waitFor(() => p.$('connect').textContent === 'Disconnect',
                   'connected');
    await waitFor(() => !p.$('systemcard').hidden, 'device card shown');
    /* the fixed test clock is days off, so the card opens by itself */
    await waitFor(() => p.$('systemcard').open, 'opened for the wrong clock');
    ok(p.$('systemcard').classList.contains('attention'),
       'the card is flagged while the clock disagrees');
    ok(/ s$/.test(p.$('sysoff').textContent),
       `offset shown (${p.$('sysoff').textContent})`);

    p.$('settime').click();
    await waitFor(() => !p.$('systemcard').open,
                   'collapsed once the clock is set');
    ok(!p.$('systemcard').classList.contains('attention'),
       'no longer flagged');
    ok(p.$('sysoff').textContent === '' ||
       /^[+-]0\.[0-9] s$/.test(p.$('sysoff').textContent),
       `small offset stays (${p.$('sysoff').textContent})`);

    /* the collapsed line still carries the version and the device time */
    ok(/^firmware 1\.0\.11/.test(p.$('sysfw').textContent), 'version in line');
    ok(/^\d\d:\d\d:\d\d$/.test(p.$('systime').textContent), 'time in line');

    /* a click opens it, and the once-a-second tick must not close it */
    p.$('systemcard').querySelector('summary').click();
    await waitFor(() => p.$('systemcard').open, 'the user can open it');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    ok(p.$('systemcard').open, 'it stays open until the user closes it');

    p.$('systemcard').querySelector('summary').click();
    await waitFor(() => !p.$('systemcard').open, 'the user can close it');
  });

await test('connect: firmware, clock and the tune list share one card',
  async () => {
    const p = await loadPage();

    p.$('connect').click();
    await waitFor(() => p.$('connect').textContent === 'Disconnect',
                   'connected');
    await waitFor(() => !p.$('systemcard').hidden, 'device card shown');
    const card = p.$('systemcard');
    const summary = card.querySelector('summary');
    ok(summary.contains(p.$('sysfw')), 'firmware version in the summary');
    ok(summary.contains(p.$('systime')), 'device time in the summary');
    ok(summary.contains(p.$('libinfo')), 'tune count in the summary');
    ok(card.contains(p.$('devtime')) && card.contains(p.$('settime')),
       'the clock and set-time are inside');
    ok(card.contains(p.$('lib')) && card.contains(p.$('librefresh')),
       'the tune list and refresh are inside');
    /* it sits under the player, not above it */
    const player = p.$('title').closest('section');
    ok(player.compareDocumentPosition(card) & 4,
       'the now-playing card comes first');
  });

await test('connect: a local build can be flashed while up to date',
  async () => {
    const p = await loadPage('hello', {
      manifest: releaseManifest(IMAGE_VERSION),
      ble: { smp: true },
    });

    p.$('connect').click();
    await waitFor(() => p.$('connect').textContent === 'Disconnect',
                   'connected');
    await waitFor(() => p.$('updstate').textContent === 'up to date',
                   'up to date');
    ok(p.$('updinstall').hidden, 'no release update offered');
    ok(!p.$('updfile').hidden, 'local firmware button still visible');
    ok(!p.$('updfile').disabled, 'and enabled over R/W');
    ok(/Flash local build/.test(p.$('updfile').textContent),
       'the button says what it does on its own');
    if (!p.$('systemcard').open) {
      p.$('systemcard').querySelector('summary').click();
      await waitFor(() => p.$('systemcard').open, 'the card opens');
    }
    ok(!p.$('updblock').hidden, 'the update block is part of the open card');
  });

await test('connect: a rejected CCC write recovers with a reconnect', async () => {
  const p = await loadPage();
  const ble = p.ble;
  ble.failSub = 2;   // CCC write and its in-place retry

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => p.$('pos').textContent === '0:05',
                 'state from the forced notification after recovery');
  eq(ble.connects, 2, 'one silent recovery reconnect');
  eq(ble.requests, 1, 'no second picker');
  eq(p.$('note').hidden, true, 'no error or disconnect notice');
  ok(!p.$('play').disabled, 'transport enabled');
});

await test('connect: a failed recovery leaves controls usable', async () => {
  const p = await loadPage();
  const ble = p.ble;
  ble.failSub = 4;   // both attempts, before and after the reconnect

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => !p.$('note').hidden &&
    /live updates failed/.test(p.$('note').textContent), 'update error note');
  eq(ble.connects, 2, 'one silent recovery reconnect');
  ok(!p.$('play').disabled, 'transport still enabled');

  p.$('play').click();
  await waitFor(() => ble.writes.some((w) => w[0] === 0x18),
                 'commands still reach the device');
});

await test('connect: disconnect and reconnect stay in sync', async () => {
  const p = await loadPage();
  const ble = p.ble;

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Reconnect', 'disconnected');
  eq(p.$('status').textContent, 'disconnected', 'status after disconnect');
  ok(p.$('play').disabled, 'transport disabled while disconnected');

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'reconnected');
  eq(ble.requests, 1, 'same device, no picker');
  eq(ble.connects, 2, 'a fresh GATT link');
  ok(!p.$('play').disabled, 'transport enabled again');
});

await test('connect: a failed first link retries transparently', async () => {
  const p = await loadPage();
  const ble = p.ble;
  ble.failConnect = 1;

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect',
                 'connected after the retry');
  eq(ble.connects, 2, 'one automatic retry');
  eq(ble.requests, 1, 'no second picker');
  ok(!p.$('play').disabled, 'transport enabled');
});

await test('connect: a dead attempt can be retried', async () => {
  const p = await loadPage();
  const ble = p.ble;
  ble.failConnect = 2; // the attempt and its automatic retry

  p.$('connect').click();
  await waitFor(() => !p.$('note').hidden &&
    /connection failed/.test(p.$('note').textContent), 'connection error');
  eq(p.$('connect').textContent, 'Reconnect', 'device remembered');
  ok(p.$('play').disabled, 'transport disabled');

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  eq(ble.requests, 1, 'no second picker');
  eq(ble.connects, 3, 'failed attempt, retry, then a working connect');
});

await test('connect: a hello device reports its protocol', async () => {
  const p = await loadPage('hello');

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => /firmware 1\.0\.11/.test(p.$('sysfw').textContent),
                 'firmware line shown');
  ok(/protocol 5/.test(p.$('sysproto').textContent),
     'firmware and protocol from the hello value');
  ok(!p.$('play').hidden && !p.$('play').disabled, 'transport usable');
  ok(!p.$('ends').disabled, 'end-mode badge usable');
  ok(!p.$('volume').disabled, 'volume usable');
  ok(p.$('note').hidden, 'no fallback note');
  eq(p.ble.helloReads, 1, 'hello read once');
});

await test('connect: a 1.0.10 device is identified by the legacy probe',
  async () => {
    const p = await loadPage('1.0.10');
    const ble = p.ble;

    p.$('connect').click();
    await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
    await waitFor(() => /firmware 1\.0\.10/.test(p.$('sysfw').textContent),
                   'firmware line');
    eq(ble.helloReads, 0, 'no hello characteristic on this firmware');
    ok(/legacy probe/.test(p.$('sysproto').textContent),
       'the card says the id is approximate');
    await waitFor(() => !p.$('note').hidden &&
      /legacy probe/.test(p.$('note').textContent), 'the page says the id is approximate');
    ok(!p.$('play').hidden, 'transport stays usable');
    ok(!p.$('ends').disabled, 'end-of-tune mode stays usable');
    ok(!p.$('volume').disabled, 'volume stays usable');
    ok(p.$('fwline').hidden, 'nothing is missing on 1.0.10');

    p.$('play').click();
    await waitFor(() => ble.writes.some((w) => w[0] === 0x18),
                   'play/pause opcode still reaches the device');
  });

await test('connect: a flaky debug read still identifies 1.0.9', async () => {
  /* the debug value length is the only thing that separates 1.0.9 (140)
   * from 1.0.10 (160) without hello; Chrome fails the first operation of
   * a fresh link often enough that a single failure must not turn a
   * 1.0.9 clock into "1.0.10, up to date" */
  const p = await loadPage('1.0.9', {
    manifest: releaseManifest(),
    ble: { smp: true },
  });
  p.ble.failDbgReads = 1; // the first read of the fresh link

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => /firmware 1\.0\.9/.test(p.$('sysfw').textContent),
                 `version from the debug value length ` +
                 `(line: ${p.$('sysfw').textContent})`);
  await waitFor(() => p.$('updstate').textContent === 'update available',
                 'update block shown');
  eq(p.$('updtitle').textContent, 'update to 1.0.11', 'title');
});

await test('connect: a 1.0.7 device gets a degraded remote', async () => {
  const p = await loadPage('1.0.7');
  const ble = p.ble;

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => /firmware 1\.0\.7/.test(p.$('sysfw').textContent),
                 'firmware line from the legacy probe');
  ok(/no live player status/.test(p.$('fwline').textContent),
     'the page says live status is missing');
  ok(p.$('play').hidden, 'play/pause hidden');
  ok(p.$('next').hidden, 'tune stepping hidden');
  ok(p.$('subtune').hidden, 'subtune selection hidden');
  ok(p.$('ends').hidden, 'end-of-tune mode hidden');
  ok(p.$('volume').disabled, 'volume disabled');
  ok(p.doc.querySelector('.volrow').hidden, 'volume row hidden');
  ok(p.doc.querySelector('.progressrow').hidden, 'progress hidden');
  eq(ble.subs, 0, 'no state characteristic, so no CCC write');

  /* degraded state comes from the debug snapshot instead */
  await waitFor(() => p.$('title').textContent === 'Old Tune',
                 'title from the snapshot');
  eq(p.$('pos').textContent, '0:00', 'position from the snapshot poll');
  eq(ble.stateReads, 0, 'the state read is never attempted');
  ok(!p.$('note').hidden && /legacy probe/.test(p.$('note').textContent),
     'legacy note');
});

/* ---------- firmware update over the page ---------- */

function releaseManifest(version = IMAGE_VERSION) {
  return {
    schema: 1,
    generated: '2026-11-06T00:00:00+00:00',
    latest: {
      version,
      file: `sidclock-${version}.signed.bin`,
      size: IMAGE_SIZE,
      sha256: FILE_SHA256,
      image_hash: IMAGE_HASH,
      page: 'https://example.invalid/releases',
    },
  };
}

await test('connect: a 1.0.7 device is offered the latest release', async () => {
  const p = await loadPage('1.0.7', {
    manifest: releaseManifest(),
    ble: { smp: true, rebootTo: IMAGE_VERSION },
  });
  const ble = p.ble;

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => p.$('updstate').textContent === 'update available',
                 'update card shown');
  ok(p.$('systemcard').open, 'an offered update opens the card by itself');
  eq(p.$('updtitle').textContent, 'update to 1.0.11', 'title');
  ok(!p.$('updinstall').hidden, 'update button visible');
  ok(!p.$('updinstall').disabled, 'update button enabled in R/W');
  ok(p.$('updreboot').hidden, 'no reboot button before staging');
  ok(p.$('updwhy').hidden, 'no blocker');
  ok(!p.$('updnotes').hidden, 'release notes link shown');
  note(`card: ${p.$('updtitle').textContent} · ${p.$('updsub').textContent}`);
});

await test('connect: update downloads, uploads, arms, reboots, comes back',
  async () => {
    const p = await loadPage('1.0.7', {
      manifest: releaseManifest(),
      ble: { smp: true, rebootTo: IMAGE_VERSION },
    });
    const ble = p.ble;

    p.$('connect').click();
    await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
    await waitFor(() => !p.$('updinstall').hidden &&
      !p.$('updinstall').disabled, 'install offered');

    p.$('updinstall').click();
    await waitFor(() => p.$('updstate').textContent === 'staged',
                   'image staged', 20000);
    eq(ble.uploads, 1, 'one upload');
    eq(ble.arms, 1, 'one arm request');
    ok(ble.smpSlots[1].pending, 'slot 1 is pending');
    eq(p.$('updreboot').hidden, false, 'reboot button shown');
    note(`staged: ${p.$('updtitle').textContent}`);

    p.$('updreboot').click();
    await waitFor(() => p.$('updstate').textContent === 'up to date',
                   'device is back on the new firmware', 20000);
    eq(ble.resets, 1, 'os reset sent');
    eq(ble.reboots, 1, 'the fake device rebooted once');
    ok(ble.connects >= 2, 'the page reconnected after the reboot');
    eq(p.$('sysfw').textContent, 'firmware 1.0.11', 'new version');
    note(`reconnected after ${ble.connects} connects; ` +
         `note: ${p.$('note').textContent}`);
  });

await test('connect: a dead link after the reboot still comes back',
  async () => {
    const p = await loadPage('1.0.7', {
      manifest: releaseManifest(),
      ble: { smp: true, rebootTo: IMAGE_VERSION, zombieReboot: true },
    });
    const ble = p.ble;

    p.$('connect').click();
    await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
    await waitFor(() => !p.$('updinstall').hidden &&
      !p.$('updinstall').disabled, 'install offered');

    p.$('updinstall').click();
    await waitFor(() => p.$('updstate').textContent === 'staged', 'staged', 20000);
    p.$('updreboot').click();

    /* the device rebooted but the old link still looks connected and
     * fails every operation: without dropping it first the page never
     * gets past this and wrongly reports a revert */
    await waitFor(() => p.$('updstate').textContent === 'up to date',
                   'the page recovered from the dead link', 30000);
    eq(ble.reboots, 1, 'one reboot');
    eq(ble.smpSlots[1].hash, null, 'the swap consumed slot 1');
    eq(p.$('sysfw').textContent, 'firmware 1.0.11', 'new version shown');
    note(`note after the recovery: ${p.$('note').textContent}`);
  });

await test('connect: a reverted test swap is reported', async () => {
  const p = await loadPage('1.0.7', {
    manifest: releaseManifest(),
    ble: { smp: true, revertOnReboot: true },
  });
  const ble = p.ble;

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => !p.$('updinstall').hidden &&
    !p.$('updinstall').disabled, 'install offered');

  p.$('updinstall').click();
  await waitFor(() => p.$('updstate').textContent === 'staged', 'staged', 20000);
  p.$('updreboot').click();

  await waitFor(() => /MCUboot reverted/.test(p.$('note').textContent),
                 'the page reports the revert', 20000);
  eq(p.$('updstate').textContent, 'update available',
     'the update is offered again');
  ok(ble.smpSlots[1].hash === null, 'slot 1 was dropped by the revert');
  note(`note: ${p.$('note').textContent}`);
});

await test('connect: an image staged earlier is offered for reboot', async () => {
  const p = await loadPage('1.0.7', {
    manifest: releaseManifest(),
    ble: {
      smp: true,
      stagedVersion: IMAGE_VERSION,
      stagedHash: IMAGE_HASH,
    },
  });
  const ble = p.ble;

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => p.$('updstate').textContent === 'staged',
                 'staged image detected on connect');
  ok(/1\.0\.11 is staged/.test(p.$('updtitle').textContent), 'title names it');
  ok(!p.$('updreboot').hidden, 'reboot offered');
  ok(!p.$('upddiscard').hidden, 'discard offered');

  p.$('upddiscard').click();
  await waitFor(() => p.$('updstate').textContent === 'update available',
                 'discard falls back to the released update');
  eq(ble.erases, 1, 'slot 1 erased');
  eq(ble.smpSlots[1].hash, null, 'no staged image left');
});

await test('connect: R/O mode explains why the update cannot install',
  async () => {
    const p = await loadPage('1.0.7', {
      manifest: releaseManifest(),
      ble: { smp: false },
    });

    p.$('connect').click();
    await waitFor(() => p.$('connect').textContent === 'Disconnect',
                   'connected');
    await waitFor(() => p.$('updstate').textContent === 'update available',
                   'update card shown');
    ok(!p.$('updinstall').hidden, 'the button is visible');
    ok(p.$('updinstall').disabled, 'but disabled without SMP');
    ok(!p.$('updwhy').hidden && /R\/W/.test(p.$('updwhy').textContent),
       'the card says the device must be R/W');
    ok(p.$('updreboot').hidden, 'no reboot on an empty slot');
    note(`why: ${p.$('updwhy').textContent}`);
  });

await test('connect: a silent SMP link is reported, not retried forever',
  async () => {
    const p = await loadPage('1.0.7', {
      manifest: releaseManifest(),
      ble: { smp: true, silentSmp: true },
    });
    const ble = p.ble;

    p.$('connect').click();
    await waitFor(() => p.$('connect').textContent === 'Disconnect',
                   'connected', 15000);
    /* the remote itself works: only the SMP-backed features are off */
    ok(!p.$('play').disabled, 'transport stays usable');
    await waitFor(() => p.$('updstate').textContent === 'update available',
                   'update card shown', 5000);
    ok(p.$('updinstall').disabled, 'install disabled on a dead SMP link');
    ok(/not answering mcumgr/.test(p.$('updwhy').textContent),
       `the card explains it: ${p.$('updwhy').textContent}`);
    ok(!p.$('note').hidden && /not answering mcumgr/.test(p.$('note').textContent),
       'and so does the status line');
    ok(ble.smpSilent >= 2, `the transport was probed (${ble.smpSilent} writes)`);
    eq(ble.uploads, 0, 'nothing was uploaded');
    note(`note: ${p.$('note').textContent}`);
  });

await test('connect: a dev build ahead of the release gets no update', async () => {
  const p = await loadPage('hello', { manifest: releaseManifest('1.0.10') });

  p.$('connect').click();
  await waitFor(() => p.$('connect').textContent === 'Disconnect', 'connected');
  await waitFor(() => p.$('updstate').textContent === 'dev build', 'card shown');
  ok(/development build 1\.0\.11/.test(p.$('updtitle').textContent),
     'title says dev build');
  ok(p.$('updinstall').hidden, 'no update button');
  ok(/older than this device/.test(p.$('updsub').textContent),
     'explains why no update is offered');
});

if (RECORD) {
  try {
    await fetch('/__result__?done=1', { method: 'POST', body: out.textContent });
  } catch (e) { /* the report is in the page either way */ }
}
