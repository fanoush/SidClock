/*
 * Tests for the web remote's protocol/database libraries. Run the page
 * over http (module imports need a real origin), add ?live for the
 * hvsc.c64.org checks - see index.html for the command line.
 *
 * Expected values come from the Python side: hashlib.md5, cbor2's
 * canonical dumps, the smp package's header bytes and sid_add.py's
 * STIL/Songlengths helpers.
 */

import { md5 } from '../../web/md5.js';
import {
  SidClock, parseInfo, parseState, parseTime, timePayload,
  DBG_CHAR, STATE_CHAR, INFO_CHAR, SIDCLOCK_SERVICE,
} from '../../web/ble.js';
import {
  HELLO_UUID, PROTOCOL_BASE, loadIndex, parseHello, select,
} from '../../web/protocol.js';
import {
  cborUint, cborBytes, cborText, cborMap, cborDecode, SmpClient, SmpError,
} from '../../web/smp.js';
import {
  cmpVersion, parseImageHeader, verifyImage, verifyRelease,
  normalizeManifest, loadManifest, fetchRelease, planUpdate,
  bytesOfHex, hexOf,
} from '../../web/update.js';
import {
  imageBytes, IMAGE_SIZE, IMAGE_VERSION, IMAGE_HASH, FILE_SHA256,
} from './fixtures/image.js';
import {
  parseLengths, parseSonglengths, stilIndex, buildStil, stripTimeRange,
  deviceNameFor, searchSids, getSidDetails, downloadSid, loadSonglengths,
  loadStil, makeLen, makeStil, tuneInfo, tuneLookup, rememberUpload,
  uploadedIds, nameKey, deviceNameKeys, onDeviceByTitle,
  SEARCH_FIELDS, filterSids, fileMd5,
} from '../../web/hvsc.js';

/* ---------- tiny harness ---------- */

const out = document.getElementById('out');
const results = [];
let current = null;
/* ?record posts each report to the run's own server (tools/web-tests/
 * record.py), so an automated headless run can read the result file
 * instead of racing --dump-dom. Harmless when the server ignores it. */
const RECORD = new URLSearchParams(location.search).has('record');

async function test(name, fn) {
  current = { name, ok: false, error: '' };
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

function report() {
  const failed = results.filter((r) => !r.ok);
  out.textContent = results.map((r) => (r.ok
    ? `ok   ${r.name}`
    : `FAIL ${r.name}\n     ${r.error.split('\n').join('\n     ')}`
  )).join('\n') + `\n\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? ` - ${failed.length} FAILED` : '') + '\n';
  document.title = failed.length
    ? `FAIL ${failed.length}/${results.length}`
    : `PASS ${results.length}`;
  if (RECORD) {
    fetch('/__result__', { method: 'POST', body: out.textContent })
      .catch(() => {});
  }
}

function ok(cond, what = 'expected true') {
  if (!cond) throw new Error(what);
}

/** Extra context for a passing test: the report only keeps failures, so a
 *  note goes to the browser console (the page-level harness prints its
 *  own into the report). */
function note(message) {
  console.info(`note: ${message}`);
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${what ? `${what}: ` : ''}${a} !== ${b}`);
  }
}

function throws(fn, re) {
  return (async () => {
    try {
      await fn();
    } catch (e) {
      if (!re || re.test(String(e && e.message || e))) return;
      throw new Error(`wrong error: ${e && e.message}`);
    }
    throw new Error('expected an error');
  })();
}

const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Bytes from a hex string, for vectors captured off the wire. */
const hexBytes = (s) => new Uint8Array(
  s.match(/../g).map((b) => parseInt(b, 16)));

function pattern(n, fn) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = fn(i) & 0xff;
  return b;
}

const te = new TextEncoder();

/* ---------- fake Web Bluetooth device for the SidClock tests ---------- */

const gattError = () =>
  new DOMException('GATT operation failed', 'NetworkError');

function mockClock() {
  const clock = {
    requests: 0, connects: 0, stateReads: 0, infoReads: 0, helloReads: 0,
    subs: 0, failConnect: 0, failState: 0, failInfo: 0, failSub: 0,
    failHello: 0, failService: 0, poisoned: false, subscribed: false,
  };
  const stateBytes = new Uint8Array(16);
  stateBytes.set([1, 0, 2, 0, 0, 2, 1, 0, 5, 0, 0, 0, 100, 0, 0, 0]);
  const infoBytes = new Uint8Array(96);
  const put = (s, off, n) =>
    infoBytes.set(te.encode(s).subarray(0, n - 1), off);
  put('Test Tune', 0, 32);
  put('test.sid', 32, 24);
  put('Tester', 56, 32);
  put('deadbeef', 88, 8);
  /* 1.0.11 hello: protocol 5, layout 0x6820, all capability bits, 1.0.11 */
  const helloBytes = new Uint8Array([5, 0, 0x20, 0x68,
                                     0xff, 0xff, 0xff, 0x0f,
                                     1, 0, 11, 0]);
  const dbgBytes = new Uint8Array(160);
  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  const listeners = new Set();
  const stateChar = {
    value: view(stateBytes),
    properties: {},
    async readValue() {
      clock.stateReads++;
      /* a read before the CCC write wedges a fresh Android link: the
       * CCC write that follows is then rejected too */
      if (!clock.subscribed) clock.poisoned = true;
      if (clock.failState > 0) {
        clock.failState--;
        throw gattError();
      }
      return view(stateBytes);
    },
    async startNotifications() {
      clock.subs++;
      if (clock.poisoned) throw gattError();
      if (clock.failSub > 0) {
        clock.failSub--;
        throw gattError();
      }
      clock.subscribed = true;
    },
    async stopNotifications() {
      clock.subscribed = false;
    },
    addEventListener(type, fn) {
      if (type === 'characteristicvaluechanged') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.delete(fn);
    },
    emit(bytes) {
      if (bytes) stateBytes.set(bytes);
      stateChar.value = view(stateBytes);
      for (const fn of [...listeners]) fn({ target: stateChar });
    },
  };
  const infoChar = {
    async readValue() {
      clock.infoReads++;
      if (clock.failInfo > 0) {
        clock.failInfo--;
        throw gattError();
      }
      return view(infoBytes);
    },
  };
  const helloChar = {
    async readValue() {
      clock.helloReads++;
      if (clock.failHello > 0) {
        clock.failHello--;
        throw gattError();
      }
      return view(helloBytes);
    },
  };
  const dbgChar = {
    async readValue() { return view(dbgBytes); },
    async writeValue(bytes) { dbgChar.writes.push([...bytes]); },
    writes: [],
  };

  const chars = new Map([
    [DBG_CHAR, dbgChar], [STATE_CHAR, stateChar], [INFO_CHAR, infoChar],
    [HELLO_UUID, helloChar],
  ]);
  const sid = {
    async getCharacteristic(uuid) { return chars.get(uuid); },
  };
  const server = {
    async getPrimaryService(uuid) {
      if (uuid === SIDCLOCK_SERVICE) {
        if (clock.failService > 0) {
          clock.failService--;
          throw new DOMException('No Services matching UUID ' + uuid +
                                 ' found in Device.', 'NotFoundError');
        }
        return sid;
      }
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
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (clock.failConnect > 0) {
          clock.failConnect--;
          throw gattError();
        }
        this.connected = true;
        return server;
      },
      disconnect() {
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
  clock.device = device;
  clock.stateChar = stateChar;
  clock.dbgChar = dbgChar;
  return clock;
}

/** Run `fn(clock)` with navigator.bluetooth backed by mockClock(). */
async function withMockClock(fn) {
  const clock = mockClock();
  const saved = Object.getOwnPropertyDescriptor(navigator, 'bluetooth');
  Object.defineProperty(navigator, 'bluetooth', {
    value: {
      requestDevice: async () => {
        clock.requests++;
        return clock.device;
      },
    },
    configurable: true,
  });
  try {
    await fn(clock);
  } finally {
    if (saved) Object.defineProperty(navigator, 'bluetooth', saved);
    else delete navigator.bluetooth;
  }
}

async function main() {

/* ---------- md5 ---------- */

await test('md5: RFC 1321 vectors', () => {
  eq(md5(new Uint8Array(0)), 'd41d8cd98f00b204e9800998ecf8427e', 'empty');
  eq(md5(te.encode('abc')), '900150983cd24fb0d6963f7d28e17f72', 'abc');
  eq(md5(te.encode('message digest')),
     'f96b697d7cb7938d525a2f31aaf161d0', 'message digest');
  eq(md5(new Uint8Array(64)), '3b5d3c7d207e37dceeedd301e35e2e58',
     '64 zero bytes');
  eq(md5(pattern(256, (i) => i)), 'e2c865db4162bed963bfaa9ef6ac18f0',
     'bytes 0..255');
  eq(md5(pattern(1500, (i) => i)), 'e0a857a2aba6c24d8fb580f0b272077f',
     '1500-byte pattern');
});

await test('md5: padding block boundaries', () => {
  const vectors = {
    0: 'd41d8cd98f00b204e9800998ecf8427e',
    1: '8666683506aacd900bbd5a74ac4edf68',
    55: '52c0e574e1198de5fe3f8f11440dcb1b',
    56: '46c9907fc908ee68b1e7b8e71286a518',
    57: '1c805dd236c35cab25fcb1bc73802c51',
    63: 'a62f6d59e837867693f042f5b8f5a236',
    64: '7160b8fb5e9e4023d549c3971fbaeead',
    65: '70bd662e7aefbda85a0f7244167b7897',
    119: 'e84905d4214f4d1ca56c2cdcc152b143',
    120: 'e3eb5a6c8669ea01a8c185b8abc8a5dc',
    127: 'acce2474d6cc8302120d09c818d17ef7',
    128: '10b2da1a82f16d99a81a7203fe9f02cb',
    129: '03fefbbcebe2959cf2270241aafe0250',
  };
  for (const [n, want] of Object.entries(vectors)) {
    eq(md5(pattern(Number(n), (i) => i * 7 + 3)), want, `${n} bytes`);
  }
});

/* ---------- CBOR (expected bytes from cbor2, canonical) ---------- */

await test('cbor: encode matches cbor2 canonical', () => {
  eq(hex(cborMap([])), 'a0', 'empty map');
  eq(hex(cborUint(4321)), '1910e1');
  eq(hex(cborUint(0x10000)), '1a00010000');
  eq(hex(cborUint(0)), '00');
  eq(hex(cborUint(23)), '17');
  eq(hex(cborUint(24)), '1818');
  eq(hex(cborBytes(new Uint8Array([0xfe, 0xff]))), '42feff');
  eq(hex(cborText('x.sid')), '65782e736964');
  eq(hex(cborMap([
    ['len', cborUint(4321)],
    ['off', cborUint(0)],
    ['data', cborBytes(new Uint8Array([1, 2, 3]))],
    ['name', cborText('Commando.sid')],
  ])), 'a4636c656e1910e1636f666600646461746143010203646e616d656c' +
       '436f6d6d616e646f2e736964', 'upload, first chunk');
  eq(hex(cborMap([
    ['off', cborUint(244)],
    ['data', cborBytes(new Uint8Array([0xfe, 0xff]))],
    ['name', cborText('x.sid')],
  ])), 'a3636f666618f4646461746142feff646e616d6565782e736964',
     'upload, later chunk');
  eq(hex(cborMap([['off', cborUint(0)], ['name', cborText('x.sid')]])),
     'a2636f666600646e616d6565782e736964', 'download request');
  eq(hex(cborMap([['name', cborText('x.sid')]])),
     'a1646e616d6565782e736964', 'status request');
});

await test('cbor: decode device responses', () => {
  eq(cborDecode(new Uint8Array([0xa0])), {}, 'empty map');
  eq(cborDecode(new Uint8Array([0x19, 0x12, 0x34])), 0x1234, 'uint');
  eq(cborDecode(new Uint8Array([0x20])), -1, 'negative int');
  eq(cborDecode(new Uint8Array([0xf5])), true, 'true');
  eq(Array.from(cborDecode(new Uint8Array([0x43, 1, 2, 3]))), [1, 2, 3],
     'byte string');
  eq(cborDecode(new Uint8Array([
    0xa2, 0x68, 0x62, 0x75, 0x66, 0x5f, 0x73, 0x69, 0x7a, 0x65,
    0x19, 0x08, 0x00, 0x69, 0x62, 0x75, 0x66, 0x5f, 0x63, 0x6f,
    0x75, 0x6e, 0x74, 0x02,
  ])), { buf_size: 2048, buf_count: 2 }, 'mcumgr parameters response');
  eq(cborDecode(new Uint8Array([
    0xa2, 0x62, 0x72, 0x63, 0x02, 0x63, 0x65, 0x72, 0x72, 0xa2,
    0x62, 0x72, 0x63, 0x03, 0x65, 0x67, 0x72, 0x6f, 0x75, 0x70, 0x08,
  ])), { rc: 2, err: { rc: 3, group: 8 } }, 'error response');
});

await test('cbor: indefinite lengths (what the device sends)', () => {
  // raw bytes captured from the device: the mcumgr parameters answer to
  // 0800000100000106a0 is bf 68"buf_size" 19 0800 69"buf_count" 04 ff -
  // zcbor writes maps as indefinite length, which the first decoder
  // rejected ("unsupported length encoding 31") and every upload died on
  eq(cborDecode(hexBytes('bf686275665f73697a65190800696275665f636f756e7404ff')),
     { buf_size: 2048, buf_count: 4 }, 'real parameters response');
  eq(cborDecode(hexBytes('bf636f66661901cbff')), { off: 459 },
     'real chunk-ack shape');
  eq(cborDecode(hexBytes('9f0102ff')), [1, 2], 'indefinite array');
  eq(Array.from(cborDecode(hexBytes('5f43616263426465ff'))), [0x61, 0x62, 0x63,
    0x64, 0x65], 'chunked byte string');
  eq(cborDecode(hexBytes('7f63616263626465ff')), 'abcde', 'chunked text');
  eq(cborDecode(hexBytes(
    'bf676d6573736167657f63616263626465ff656572726f72f5ff')),
     { message: 'abcde', error: true }, 'indefinite values inside');
  let err = null;
  try {
    // text chunk inside a byte string: not a valid encoder output
    cborDecode(hexBytes('5f63616263ff'));
  } catch (e) { err = e; }
  ok(err && /mixed/.test(err.message), 'mixed chunk types rejected');
  eq(cborDecode(hexBytes('bf636f66661901cbff') ), { off: 459 },
     'trailing break consumed');
});

await test('cbor: one-shot hex vectors from Python', () => {
  eq(hex(cborMap([['off', cborUint(0)], ['name', cborText('x.sid')]]))
     + hex(cborMap([['name', cborText('x.sid')]])),
     'a2636f666600646e616d6565782e736964a1646e616d6565782e736964');
});

/* ---------- SMP client against a fake device ---------- */

function concatBytes(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function respFrame(req, payload) {
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = ((req[0] & 7) | 1) | 8; // response op, SMPv2
  frame[2] = payload.length >> 8;
  frame[3] = payload.length & 0xff;
  frame[4] = req[4];
  frame[5] = req[5];
  frame[6] = req[6];
  frame[7] = req[7];
  frame.set(payload, 8);
  return frame;
}

/** Re-encode a definite map as the device's zcbor emits it: indefinite
 *  length (0xbf ... 0xff). Every mock response then goes through the
 *  decoder the same way a real one does. */
function indefiniteMap(payload) {
  if ((payload[0] >> 5) !== 5 || (payload[0] & 0x1f) >= 24) return payload;
  return concatBytes([new Uint8Array([0xbf]), payload.subarray(1),
                      new Uint8Array([0xff])]);
}

const FS_ERR_FILE_NOT_FOUND = cborMap([
  ['rc', cborUint(2)],
  ['err', cborMap([['rc', cborUint(3)], ['group', cborUint(8)]])],
]);

/* an mcumgr image-group error: Zephyr reports the group code in a nested
 * map (the legacy top-level `rc` is only present with
 * CONFIG_MCUMGR_SMP_LEGACY_RC_BEHAVIOUR) */
const smpErr = (group, rc) => cborMap([
  ['err', cborMap([['group', cborUint(group)], ['rc', cborUint(rc)]])],
]);

const cborBool = (b) => new Uint8Array([b ? 0xf5 : 0xf4]);

const cborArray = (items) => concatBytes([
  new Uint8Array([0x80 + items.length]), ...items,
]);

class FakeSmpDevice {
  constructor({ bufSize = 512, downloadChunk = 256,
                activeVersion = '1.0.7', activeHash = null, imageVersion = '',
                imageHash = null } = {}) {
    this.bufSize = bufSize;
    this.downloadChunk = downloadChunk;
    this.files = new Map();
    this.rx = new Uint8Array(0);
    this.frames = [];
    this.requests = [];
    this.dropNext = 0;
    this.silent = false;              // swallow every request (dead transport)
    this.paramsError = false;         // answer the parameters read with an error
    this.statusMissBy = 0; // report a shorter file than uploaded
    this.notify = () => {};
    /* image slots: the running one plus an empty secondary */
    this.slots = [
      {
        slot: 0,
        version: activeVersion,
        hash: activeHash || new Uint8Array(32).fill(0x11),
        active: true,
        confirmed: true,
      },
      { slot: 1, version: '', hash: null, pending: false },
    ];
    this.imageVersion = imageVersion; // reported for a completed upload
    this.imageHash = imageHash;       // 32 bytes, same
    this.upload = null;               // the open upload session, if any
    this.uploaded = null;             // bytes of the last completed upload
    this.dropFinalResponse = false;   // lose the answer to the last chunk
    this.resets = 0;
    this.onReset = () => {};
  }

  feed(bytes) {
    this.rx = concatBytes([this.rx, bytes]);
    while (this.rx.length >= 8) {
      const len = (this.rx[2] << 8) | this.rx[3];
      if (this.rx.length < 8 + len) return;
      const frame = this.rx.slice(0, 8 + len);
      this.rx = this.rx.slice(8 + len);
      this.frames.push(frame);
      this.handle(frame);
    }
  }

  handle(frame) {
    const op = frame[0] & 7;
    const group = (frame[4] << 8) | frame[5];
    const cmd = frame[7];
    const msg = cborDecode(frame.subarray(8));
    this.requests.push({ op, group, cmd, seq: frame[6], msg });
    if (this.silent) return;

    if (group === 0 && op === 0 && cmd === 6) {
      if (this.paramsError) return this.reply(frame, smpErr(0, 8));
      return this.reply(frame, cborMap([
        ['buf_size', cborUint(this.bufSize)],
        ['buf_count', cborUint(2)],
      ]));
    }
    if (group === 0 && op === 2 && cmd === 5) { // os reset
      this.resets++;
      this.reply(frame, cborMap([]));
      setTimeout(() => this.onReset(), 0);
      return;
    }
    if (group === 1) return this.handleImage(frame, op, cmd, msg);
    if (group !== 8) return this.reply(frame, cborMap([]));

    const name = msg.name || '';
    if (op === 2 && cmd === 0) { // upload
      if (name.includes('bad')) return this.reply(frame, FS_ERR_FILE_NOT_FOUND);
      let entry = this.files.get(name);
      if (msg.off === 0 && typeof msg.len === 'number') {
        entry = { size: msg.len, data: new Uint8Array(msg.len) };
      }
      if (!entry) entry = { size: 0, data: new Uint8Array(0) };
      const end = msg.off + msg.data.length;
      if (end > entry.data.length) {
        const grown = new Uint8Array(end);
        grown.set(entry.data);
        entry.data = grown;
      }
      entry.data.set(msg.data, msg.off);
      entry.size = Math.max(entry.size, end);
      this.files.set(name, entry);
      return this.reply(frame, cborMap([['off', cborUint(end)]]));
    }
    if (op === 2 && cmd === 4) { // close
      return this.reply(frame, cborMap([]));
    }
    if (op === 0 && cmd === 0) { // download
      const entry = this.files.get(name);
      if (!entry) return this.reply(frame, FS_ERR_FILE_NOT_FOUND);
      const chunk = entry.data.subarray(msg.off,
        Math.min(entry.size, msg.off + this.downloadChunk));
      const pairs = [['data', cborBytes(chunk)]];
      if (msg.off === 0) pairs.push(['len', cborUint(entry.size)]);
      pairs.push(['off', cborUint(msg.off)]);
      return this.reply(frame, cborMap(pairs));
    }
    if (op === 0 && cmd === 1) { // status
      const entry = this.files.get(name);
      if (!entry) return this.reply(frame, FS_ERR_FILE_NOT_FOUND);
      const size = Math.max(0, entry.size - this.statusMissBy);
      return this.reply(frame, cborMap([['len', cborUint(size)]]));
    }
    return this.reply(frame, cborMap([]));
  }

  /* image management: just enough of Zephyr's img_mgmt for the update
   * tests (state read, chunked upload, test-swap arming, erase) */
  handleImage(frame, op, cmd, msg) {
    const stateReply = () => cborMap([['images', cborArray(this.slots.map(
      (s) => cborMap([
        ['slot', cborUint(s.slot)],
        ['version', cborText(s.version || '')],
        ['hash', cborBytes(s.hash || new Uint8Array(0))],
        ['active', cborBool(!!s.active)],
        ['pending', cborBool(!!s.pending)],
        ['confirmed', cborBool(!!s.confirmed)],
      ])))]]);

    if (op === 0 && cmd === 0) return this.reply(frame, stateReply());

    if (op === 2 && cmd === 1) { // upload
      if (msg.off === 0) {
        /* Zephyr treats offset 0 as "start a new upload": the request must
         * carry the length and at least an image header (it parses the
         * MCUboot magic from the data). A matching SHA resumes the session
         * that is still open by answering with its offset. */
        if (msg.data.length < 32) return this.reply(frame, smpErr(1, 22));
        if (typeof msg.len !== 'number') return this.reply(frame, smpErr(1, 21));
        if (msg.data[0] !== 0x3d || msg.data[1] !== 0xb8) {
          return this.reply(frame, smpErr(1, 23));
        }
        if (this.upload && msg.sha && this.upload.sha &&
            hex(msg.sha) === hex(this.upload.sha)) {
          return this.reply(frame, cborMap([
            ['off', cborUint(this.upload.off)]]));
        }
        this.upload = {
          size: msg.len,
          data: new Uint8Array(msg.len),
          sha: msg.sha || null,
          off: 0,
        };
      } else {
        const at = this.upload ? this.upload.off : 0;
        if (msg.off !== at) {
          /* wrong offset: drop the data and report what is expected */
          return this.reply(frame, cborMap([['off', cborUint(at)]]));
        }
        if (msg.off + msg.data.length > this.upload.size) {
          return this.reply(frame, smpErr(1, 31));
        }
      }
      this.upload.data.set(msg.data, msg.off);
      const off = msg.off + msg.data.length;
      this.upload.off = off;
      if (off === this.upload.size) {
        this.uploaded = this.upload.data;
        this.slots[1] = {
          slot: 1,
          version: this.imageVersion ||
            `${this.upload.data[20]}.${this.upload.data[21]}.` +
            `${this.upload.data[22] | (this.upload.data[23] << 8)}`,
          hash: this.imageHash || new Uint8Array(32).fill(0x22),
          pending: false,
        };
        this.upload = null;
        /* the device drops the session on completion; optionally lose the
         * answer so the retried chunk meets a reset session */
        if (this.dropFinalResponse) {
          this.dropFinalResponse = false;
          return;
        }
      }
      return this.reply(frame, cborMap([['off', cborUint(off)]]));
    }

    if (op === 2 && cmd === 0) { // state write: arm (test) or confirm
      const active = this.slots[0];
      const want = msg.hash || new Uint8Array(0);
      const same = (h) => h && hex(h) === hex(want);
      if (msg.confirm) {
        const img = active;
        if (!want.length || same(img.hash)) {
          img.confirmed = true;
          return this.reply(frame, stateReply());
        }
        return this.reply(frame, smpErr(1, 3));
      }
      if (same(active.hash)) return this.reply(frame, smpErr(1, 33));
      const sec = this.slots[1];
      if (!same(sec.hash)) return this.reply(frame, smpErr(1, 3));
      sec.pending = true;
      return this.reply(frame, stateReply());
    }

    if (op === 2 && cmd === 5) { // erase
      for (const s of this.slots) {
        if (s.slot === (msg.slot == null ? 1 : msg.slot) && !s.active) {
          s.hash = null;
          s.version = '';
          s.pending = false;
        }
      }
      return this.reply(frame, cborMap([]));
    }

    return this.reply(frame, cborMap([]));
  }

  reply(req, payload) {
    if (this.dropNext > 0) {
      this.dropNext--;
      return;
    }
    const frame = respFrame(req, indefiniteMap(payload));
    // two notifications, like a response split over the link
    const half = Math.ceil(frame.length / 2);
    this.notify(frame.subarray(0, half));
    this.notify(frame.subarray(half));
  }
}

class FakeChar {
  constructor(device, { maxWrite = 244 } = {}) {
    this.device = device;
    this.maxWrite = maxWrite;
    this.properties = { writeWithoutResponse: true };
    this.listeners = [];
    this.writes = 0;
    this.starts = 0;
    this.stops = 0;
    device.notify = (bytes) => this.emit(bytes);
  }

  addEventListener(type, fn) {
    if (type === 'characteristicvaluechanged') this.listeners.push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  async startNotifications() { this.starts++; }
  async stopNotifications() { this.stops++; }

  async writeValueWithoutResponse(bytes) {
    if (bytes.length > this.maxWrite) {
      throw new Error(`write of ${bytes.length} bytes exceeds MTU`);
    }
    this.writes++;
    this.device.feed(bytes.slice());
  }

  emit(bytes) {
    const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const fn of this.listeners) fn({ target: { value } });
  }
}

async function connectedClient(opts, clientOpts = {}) {
  const dev = new FakeSmpDevice(opts);
  const ch = new FakeChar(dev, opts);
  const cli = new SmpClient(ch, { timeoutMs: 250, ...clientOpts });
  await cli.start();
  return { dev, ch, cli };
}

await test('smp: mcumgr parameters + frame header', async () => {
  const { dev, cli } = await connectedClient({ bufSize: 512 });
  eq(cli.bufSize, 512, 'buf size from the device');
  // smp.header.Header(op=READ, version=V2, length=1, group=OS, sequence=1,
  // command_id=MCUMGR_PARAMETERS).BYTES -> 0800000100000106, payload a0
  eq(hex(dev.frames[0]), '0800000100000106a0', 'parameters request frame');
  const uploads = dev.requests.filter((r) => r.group === 8 && r.cmd === 0);
  eq(uploads.length, 0, 'no uploads yet');
});

await test('smp: upload round trip', async () => {
  const { dev, cli } = await connectedClient({ bufSize: 512 });
  const data = pattern(3000, (i) => i * 13 + 7);
  let last = 0;
  let updates = 0;
  await cli.uploadFile('/home/Test.sid', data, (off, total) => {
    ok(off <= total, 'progress order');
    last = off;
    updates++;
  });
  eq(last, 3000, 'progress reaches the end');
  ok(updates >= 7, `progress updates (${updates})`);
  eq(Array.from(dev.files.get('/home/Test.sid').data), Array.from(data),
     'file bytes');

  const uploadFrames = dev.frames.filter((f) => (f[0] & 7) === 2 && f[7] === 0);
  ok(uploadFrames.every((f) => f.length <= 512),
     'frames stay within the device buffer');
  const first = uploadFrames[0];
  eq([first[0], first[1], first[4], first[5], first[7]],
     [0x0a, 0x00, 0x00, 0x08, 0x00], 'upload frame header');
  const uploads = dev.requests.filter((r) => r.group === 8 && r.cmd === 0);
  eq(uploads[0].msg.len, 3000, 'first chunk carries the total length');
  eq(uploads[0].msg.off, 0, 'first chunk offset');
  eq(uploads[1].msg.len, undefined, 'later chunks do not carry len');
  ok(uploads[1].msg.off === uploads[0].msg.data.length, 'later chunk offset');
  eq(hex(first.subarray(8)), hex(cborMap([
    ['len', cborUint(3000)],
    ['off', cborUint(0)],
    ['data', cborBytes(data.subarray(0, uploads[0].msg.data.length))],
    ['name', cborText('/home/Test.sid')],
  ])), 'first chunk payload');
  const offsets = uploads.map((u) => u.msg.off);
  eq(offsets, [...offsets].sort((a, b) => a - b), 'offsets increase');
});

await test('smp: upload empty file', async () => {
  const { dev, cli } = await connectedClient({ bufSize: 512 });
  await cli.uploadFile('/home/Empty.sid', new Uint8Array(0));
  const entry = dev.files.get('/home/Empty.sid');
  ok(entry, 'file created');
  eq(entry.size, 0, 'size 0');
});

await test('smp: small MTU adaptation', async () => {
  const { dev, cli } = await connectedClient({ bufSize: 512, maxWrite: 20 });
  const data = pattern(500, (i) => i);
  await cli.uploadFile('/home/Small.sid', data);
  eq(cli.chunk, 20, 'chunk size adapted');
  eq(Array.from(dev.files.get('/home/Small.sid').data), Array.from(data),
     'file bytes');
});

await test('smp: lost response is retried', async () => {
  const { dev, cli } = await connectedClient({ bufSize: 512 });
  dev.dropNext = 1; // the first upload request gets no answer
  const data = pattern(400, (i) => i ^ 0x5a);
  await cli.uploadFile('/home/Retry.sid', data);
  eq(Array.from(dev.files.get('/home/Retry.sid').data), Array.from(data),
     'file bytes');
  const uploads = dev.requests.filter((r) => r.group === 8 && r.cmd === 0);
  ok(uploads.length >= 2, 'request was resent');
  eq(uploads[0].msg.off, uploads[1].msg.off, 'resent from the same offset');
});

await test('smp: a silent transport is reported, not hidden', async () => {
  const dev = new FakeSmpDevice({ bufSize: 512 });
  dev.silent = true;
  const ch = new FakeChar(dev);
  const logs = [];
  const cli = new SmpClient(ch, { timeoutMs: 250 });
  cli.onLog = (m) => logs.push(m);
  await cli.start();
  eq(cli.healthy, false, 'the link is marked unhealthy');
  ok(/not answering/.test(cli.problem), `problem: ${cli.problem}`);
  eq(ch.starts, 2, 'the CCC is armed again before giving up');
  eq(ch.stops, 1, 'the first subscription was dropped');
  eq(cli.bufSize, 512, 'the buffer guess is kept');
  ok(logs.some((m) => /re-subscribing/.test(m)), 'the retry is logged');
  ok(logs.some((m) => /not answering/.test(m)), 'the verdict is logged');
  ok(/group 0, command 6/.test(logs.join(' ')), 'the request is named');
});

await test('smp: an error answer still proves the transport works', async () => {
  /* the parameters command is a probe, not a requirement: a firmware
   * that rejects it answers over a perfectly good link */
  const dev = new FakeSmpDevice({ bufSize: 512 });
  dev.paramsError = true;
  const ch = new FakeChar(dev);
  const cli = new SmpClient(ch, { timeoutMs: 250 });
  await cli.start();
  eq(cli.healthy, true, 'healthy');
  eq(cli.problem, '', 'no complaint');
  eq(cli.bufSize, 512, 'the old guess survives');
  eq(ch.starts, 1, 'no extra subscription');
});

await test('smp: replacing a client leaves one subscription', async () => {
  /* setupSmp() runs on every connect: the retired client must let go of
   * the (shared) characteristic object, or its listener keeps reading
   * notifications that belong to the live client */
  const dev = new FakeSmpDevice({ bufSize: 512 });
  const ch = new FakeChar(dev);
  const first = new SmpClient(ch, { timeoutMs: 250 });
  await first.start();
  await first.stop();
  const second = new SmpClient(ch, { timeoutMs: 250 });
  await second.start();
  eq(ch.listeners.length, 1, 'one listener on the characteristic');
  eq(ch.starts, 2, 'subscribed twice in total');
  eq(ch.stops, 1, 'the retired client unsubscribed');
  const slots = await second.imageState();
  eq(slots.length, 2, 'the live client still gets answers');
});

await test('smp: a desynced receive buffer heals after a timeout', async () => {
  /* A lost notification leaves half a frame behind; the next response is
   * appended behind it, no length matches any more and the link looks
   * dead while the device keeps answering ("ignoring unsolicited SMP
   * response" in the console). The timeout must drop the fragment. */
  const { dev, ch, cli } = await connectedClient({ bufSize: 512 });
  dev.silent = true;
  const pending = cli.imageState();
  ch.emit(new Uint8Array([0x09, 0, 0, 90, 0, 1, 7, 0, 0x01]));
  let err = null;
  try {
    await pending;
  } catch (e) { err = e; }
  ok(err && err.timeout, `the silent request timed out: ${err && err.message}`);
  dev.silent = false;
  const slots = await cli.imageState();
  eq(slots.length, 2, 'the buffer is clean again');
});

await test('smp: frames batched in one notification are all read', async () => {
  const dev = new FakeSmpDevice({ bufSize: 512 });
  const ch = new FakeChar(dev);
  const logs = [];
  const cli = new SmpClient(ch, { timeoutMs: 250 });
  cli.onLog = (m) => logs.push(m);
  await cli.start();
  dev.silent = true; // answer by hand, batched
  const pending = cli.imageState();
  const req = dev.frames[dev.frames.length - 1];
  const answer = respFrame(req, indefiniteMap(cborMap([
    ['images', cborArray([])],
  ])));
  const stray = respFrame(req, indefiniteMap(cborMap([])));
  ch.emit(concatBytes([answer, stray]));
  eq((await pending).length, 0, 'the first frame answers the request');
  ok(logs.some((m) => /unsolicited/.test(m)),
     'the leftover frame is drained straight away');
});

await test('smp: upload verifies the device copy', async () => {
  const { dev, cli } = await connectedClient({ bufSize: 512 });
  dev.statusMissBy = 100; // the device kept 100 bytes less than sent
  const data = pattern(700, (i) => i + 1);
  let err = null;
  try {
    await cli.uploadFile('/home/Short.sid', data);
  } catch (e) { err = e; }
  ok(err && /verify failed/.test(err.message),
     `truncation reported: ${err && err.message}`);
  ok(/600 of 700/.test(err && err.message), 'both sizes in the message');
});

await test('smp: device error surfaces as SmpError', async () => {
  const { cli } = await connectedClient({ bufSize: 512 });
  eq(await cli.status('/home/nope.sid'), null, 'missing file -> null');
  let err = null;
  try {
    await cli.uploadFile('/home/bad.sid', new Uint8Array([1, 2, 3]));
  } catch (e) {
    err = e;
  }
  ok(err instanceof SmpError, 'SmpError thrown');
  ok(/file not found/.test(err.message), `message: ${err && err.message}`);
  eq(err.err, { group: 8, rc: 3 }, 'error details');
});

await test('smp: download round trip', async () => {
  const { dev, cli } = await connectedClient({ bufSize: 512 });
  const data = pattern(700, (i) => i * 3);
  dev.files.set('/home/D.sid', { size: data.length, data });
  const got = await cli.downloadFile('/home/D.sid');
  eq(Array.from(got), Array.from(data), 'downloaded bytes');
  const status = await cli.status('/home/D.sid');
  eq(status.len, 700, 'status length');
});

/* ---------- firmware update: image parsing, manifest, plan ---------- */

await test('update: dotted versions compare numerically', () => {
  ok(cmpVersion('1.0.7', '1.0.10') < 0, '1.0.7 < 1.0.10');
  ok(cmpVersion('1.0.10', '1.0.9') > 0, '1.0.10 > 1.0.9');
  eq(cmpVersion('1.0.10', '1.0.10'), 0, 'equal');
  eq(cmpVersion('v1.0.10', '1.0.10'), 0, 'tag prefix ignored');
  eq(cmpVersion('1.0', '1.0.0'), 0, 'missing fields count as zero');
  ok(cmpVersion('1.0.11-dbg', '1.0.11') === 0, 'suffix ignored');
  ok(cmpVersion('2.0.0', '1.9.9') > 0, 'major dominates');
});

await test('update: a valid MCUboot image parses', async () => {
  const bytes = imageBytes();
  eq(bytes.length, IMAGE_SIZE, 'fixture size');
  const head = parseImageHeader(bytes);
  ok(head.ok, head.reason);
  eq(head.version, IMAGE_VERSION, 'version from the header');
  eq(head.hdrSize, 32, 'header size');
  eq(head.imgSize, 512, 'body size');
  eq(head.tlvHash, IMAGE_HASH, 'the SHA-256 TLV is found');

  const v = await verifyImage(bytes);
  ok(v.ok, v.reason);
  eq(v.info.imageHash, IMAGE_HASH, 'image hash (header + body)');
  eq(v.info.fileHash, FILE_SHA256, 'whole-file hash');
  note(`image ${IMAGE_VERSION}, sha256 ${FILE_SHA256.slice(0, 16)}...`);
});

await test('update: broken images are rejected with a reason', async () => {
  const bytes = imageBytes();

  const short = await verifyImage(bytes.subarray(0, 20));
  ok(!short.ok && /too short/.test(short.reason), 'short file');

  const wrongMagic = bytes.slice();
  wrongMagic[0] = 0;
  ok(/magic/.test(parseImageHeader(wrongMagic).reason), 'bad magic');

  const truncated = await verifyImage(bytes.subarray(0, bytes.length - 8));
  ok(!truncated.ok && /length/.test(truncated.reason), 'truncated');

  const corrupt = bytes.slice();
  corrupt[100] ^= 0xff;
  const broken = await verifyImage(corrupt);
  ok(!broken.ok && /hash TLV/.test(broken.reason), 'body change');

  const noTlv = bytes.slice();
  noTlv[32 + 512] = 0; // TLV magic
  ok(!parseImageHeader(noTlv).ok, 'missing TLV area');
});

await test('update: verifyRelease checks every manifest field', async () => {
  const bytes = imageBytes();
  const release = {
    version: IMAGE_VERSION,
    size: IMAGE_SIZE,
    sha256: FILE_SHA256,
    image_hash: IMAGE_HASH,
  };
  const good = await verifyRelease(bytes, release);
  ok(good.ok, good.reason);

  ok(!(await verifyRelease(bytes, { ...release, size: IMAGE_SIZE + 1 })).ok,
     'wrong size');
  ok(!(await verifyRelease(bytes, { ...release, sha256: '00'.repeat(32) })).ok,
     'wrong file checksum');
  ok(!(await verifyRelease(bytes, { ...release, version: '1.0.10' })).ok,
     'wrong version');
  ok(!(await verifyRelease(bytes, { ...release, image_hash: '00'.repeat(32) })).ok,
     'wrong image hash');

  // the local-file path passes an empty release: checks it cannot make are
  // skipped, the structure must still be right
  const bare = await verifyRelease(bytes, {});
  ok(bare.ok, bare.reason);
});

await test('update: manifest normalisation and URL resolution', async () => {
  const raw = {
    schema: 1,
    generated: '2026-11-05T00:00:00+00:00',
    latest: {
      version: '1.0.10',
      file: 'sidclock-v1.0.10.signed.bin',
      size: 536183,
      sha256: 'a'.repeat(64),
      image_hash: 'b'.repeat(64),
      page: 'https://example.invalid/r',
    },
  };
  const m = normalizeManifest(raw, 'https://fanoush.github.io/SidClock/firmware/index.json');
  eq(m.latest.url,
     'https://fanoush.github.io/SidClock/firmware/sidclock-v1.0.10.signed.bin',
     'the file resolves against the manifest');
  eq(m.latest.version, '1.0.10', 'version kept');
  eq(m.latest.page, 'https://example.invalid/r', 'release notes kept');

  const evil = normalizeManifest({
    ...raw,
    latest: { ...raw.latest, page: 'javascript:alert(1)' },
  }, 'https://fanoush.github.io/SidClock/firmware/index.json');
  eq(evil.latest.page, '', 'a non-http release link is dropped');

  await throws(() => normalizeManifest({ schema: 2 }, 'https://x/'),
               /manifest/);
  await throws(() => normalizeManifest({ schema: 1 }, 'https://x/'),
               /latest/);
});

await test('update: loadManifest caches and falls back', async () => {
  const doc = {
    schema: 1,
    latest: { version: '1.0.10', file: 'f.bin', size: 1 },
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('missing')) return { ok: false, status: 404 };
    return { ok: true, json: async () => doc };
  };
  const store = new Map();
  const cache = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };

  const first = await loadManifest({
    urls: ['https://a/missing/index.json', 'https://b/index.json'],
    fetchImpl, cache, now: 1000,
  });
  eq(first.latest.version, '1.0.10', 'the fallback URL is used');
  eq(calls, ['https://a/missing/index.json', 'https://b/index.json'], 'both tried');

  const cached = await loadManifest({
    urls: ['https://c/never.json'], fetchImpl, cache, now: 2000,
  });
  eq(cached.latest.version, '1.0.10', 'served from the cache');
  eq(calls.length, 2, 'no second fetch');

  const stale = await loadManifest({
    urls: ['https://c/index.json'], fetchImpl, cache, now: 1000 + 3 * 3600e3,
  });
  ok(stale && calls.length === 3, 'a stale cache is refetched');

  const none = await loadManifest({
    urls: ['https://a/missing/index.json'], fetchImpl, cache: null,
  });
  eq(none, null, 'nothing reachable gives null');
});

await test('update: planUpdate states', () => {
  const manifest = {
    schema: 1,
    latest: {
      version: '1.0.10',
      file: 'f.bin',
      url: 'https://x/f.bin',
      size: 100,
    },
  };
  eq(planUpdate({ manifest: null, running: '1.0.7' }).state, 'no-manifest');
  eq(planUpdate({ manifest, running: null }).state, 'unknown');

  const older = planUpdate({ manifest, running: '1.0.7', smp: true });
  eq(older.state, 'available');
  eq(older.running, '1.0.7');
  ok(older.canInstall, 'installable in R/W');

  const ro = planUpdate({ manifest, running: '1.0.7', smp: false });
  eq(ro.state, 'available');
  ok(!ro.canInstall && /R\/W/.test(ro.why), 'R/O blocks with a reason');

  eq(planUpdate({ manifest, running: '1.0.10', smp: true }).state, 'up-to-date');
  eq(planUpdate({ manifest, running: '1.0.11', smp: true }).state, 'ahead');
});

await test('update: fetchRelease streams the image with progress', async () => {
  const bytes = imageBytes();
  let fetched = null;
  const fetchImpl = async (url) => {
    fetched = url;
    return {
      ok: true,
      headers: { get: () => String(bytes.length) },
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: bytes };
            },
          };
        },
      },
    };
  };
  const seen = [];
  const got = await fetchRelease(
    { url: 'https://x/f.bin', size: bytes.length },
    (off, total) => seen.push([off, total]), fetchImpl);
  eq(hex(got), hex(bytes), 'bytes');
  eq(fetched, 'https://x/f.bin', 'requested the release URL');
  eq(seen.at(-1), [bytes.length, bytes.length], 'progress reaches the end');
});

/* ---------- firmware update: the image management group ---------- */

await test('smp: image state read', async () => {
  const { cli } = await connectedClient({ activeVersion: '1.0.7' });
  const slots = await cli.imageState();
  eq(slots.length, 2, 'two slots');
  eq(slots[0].slot, 0, 'primary');
  eq(slots[0].version, '1.0.7', 'running version');
  ok(slots[0].active && slots[0].confirmed, 'running image is active/confirmed');
  eq(slots[0].hash, '11'.repeat(32), 'hash as hex');
  eq(slots[1].hash, '', 'the secondary slot is empty');
});

await test('smp: image upload, arm, erase and reset', async () => {
  const { dev, cli } = await connectedClient({
    bufSize: 512,
    activeVersion: '1.0.7',
    imageVersion: IMAGE_VERSION,
    imageHash: bytesOfHex(IMAGE_HASH),
  });
  const bytes = imageBytes();
  let last = 0;
  await cli.uploadImage(bytes, { sha: bytesOfHex(FILE_SHA256),
                                 onProgress: (off) => { last = off; } });
  eq(last, bytes.length, 'progress reaches the end');
  eq(hex(dev.slots[1].hash), IMAGE_HASH, 'slot 1 holds the image');
  eq(hex(dev.uploaded), hex(bytes), 'every byte landed in the slot');
  eq(dev.slots[1].version, IMAGE_VERSION, 'slot 1 version');

  const uploads = dev.requests.filter((r) => r.group === 1 && r.cmd === 1);
  eq(uploads[0].msg.len, bytes.length, 'first request declares the length');
  eq(uploads[0].msg.image, 0, 'first request declares the image number');
  eq(hex(uploads[0].msg.sha), FILE_SHA256, 'first request carries the SHA-256');
  eq(uploads[0].msg.off, 0, 'first request starts at offset 0');
  ok(uploads[0].msg.data.length >= 32 &&
     uploads[0].msg.data[0] === 0x3d && uploads[0].msg.data[1] === 0xb8,
     'first request carries the MCUboot header (no declare-only request)');
  ok(uploads[1].msg.off > 0 &&
     uploads[1].msg.data.length > 0 &&
     uploads[1].msg.len === undefined &&
     uploads[1].msg.image === undefined &&
     uploads[1].msg.sha === undefined,
     'later requests are offset + data only');
  ok(uploads.length > 1, 'the image needs several chunks');
  const frames = dev.frames.filter((f) => f[4] === 0 && f[5] === 1 &&
                                         (f[0] & 7) === 2);
  ok(frames.every((f) => f.length <= 512),
     'frames stay within the device buffer');

  await cli.armImage(IMAGE_HASH);
  ok(dev.slots[1].pending, 'the image is armed for a test swap');
  const writes = dev.requests.filter((r) => r.group === 1 && r.cmd === 0 &&
                                             r.op === 2);
  eq(hex(writes[0].msg.hash), IMAGE_HASH, 'armed by image hash');
  eq(writes[0].msg.confirm, false, 'a test swap, never confirmed up front');

  await cli.eraseImage(1);
  eq(dev.slots[1].hash, null, 'erase drops the staged image');

  await cli.reset();
  eq(dev.resets, 1, 'os reset sent');
});

await test('smp: an interrupted upload resumes at the device offset', async () => {
  const { dev, cli } = await connectedClient({
    bufSize: 512,
    imageVersion: IMAGE_VERSION,
    imageHash: bytesOfHex(IMAGE_HASH),
  });
  const bytes = imageBytes();
  const prefix = 200;
  /* what an interrupted upload leaves behind: the session is still open
   * and the device knows how far it got */
  dev.upload = {
    size: bytes.length,
    data: new Uint8Array(bytes.length),
    sha: bytesOfHex(FILE_SHA256),
    off: prefix,
  };
  dev.upload.data.set(bytes.subarray(0, prefix));

  await cli.uploadImage(bytes, { sha: bytesOfHex(FILE_SHA256) });
  eq(hex(dev.uploaded), hex(bytes), 'the whole image is in the slot');
  const uploads = dev.requests.filter((r) => r.group === 1 && r.cmd === 1);
  eq(uploads[0].msg.off, 0, 'the first request still starts at 0');
  ok(uploads[0].msg.data.length >= 32, 'and carries a header');
  eq(uploads[1].msg.off, prefix, 'the next request resumes where it stopped');
  ok(uploads[1].msg.len === undefined &&
     uploads[1].msg.image === undefined &&
     uploads[1].msg.sha === undefined, 'the session is already declared');
});

await test('smp: a lost final answer does not lose the upload', async () => {
  const { dev, cli } = await connectedClient({
    bufSize: 512,
    imageVersion: IMAGE_VERSION,
    imageHash: bytesOfHex(IMAGE_HASH),
  });
  const bytes = imageBytes();
  /* the device finishes the image and drops the session, but the answer
   * to the last chunk is lost: the retry meets a device at offset 0 */
  dev.dropFinalResponse = true;
  await cli.uploadImage(bytes, { sha: bytesOfHex(FILE_SHA256) });
  eq(hex(dev.uploaded), hex(bytes), 'the image still lands complete');
  const uploads = dev.requests.filter((r) => r.group === 1 && r.cmd === 1);
  ok(uploads.some((r) => r.msg.off === 0 && typeof r.msg.len === 'number'),
     'the upload was declared again after the reset session');
});

await test('smp: arming the running image is refused with a name', async () => {
  const { dev, cli } = await connectedClient({ activeVersion: '1.0.7' });
  let err = null;
  try {
    await cli.armImage(hex(dev.slots[0].hash));
  } catch (e) {
    err = e;
  }
  ok(err instanceof SmpError, 'SmpError thrown');
  eq(err.err, { group: 1, rc: 33 }, 'image group error');
  ok(/active slot to test/.test(err.message), `message: ${err.message}`);
});

/* ---------- HVSC parsing (expected values from sid_add.py) ---------- */

const SL_FIXTURE = `[Database]
; /MUSICIANS/T/Test/Test_Tune.sid
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=4:27 5:38
; /MUSICIANS/T/Test/Times.sid
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=0:31
; /MUSICIANS/U/Other/Times.sid
cccccccccccccccccccccccccccccccc=1:00
; /MUSICIANS/U/Other/Alpha.sid
dddddddd000000000000000000000000=0:12
; /MUSICIANS/V/Various/Alpha.sid
ddddddddffffffffffffffffffffffff=0:13
`;

const STIL_FIXTURE = `; STIL test fixture
/MUSICIANS/U/Other/Times.sid
TITLE: Other Times
COMMENT: other comment

/MUSICIANS/T/Test/Test_Tune.sid
TITLE: Test Tune
AUTHOR: Test Author
COMMENT: A tune-wide comment
         that wraps
(#2)
NAME: Second Level
COMMENT: Second level
         note here
(#3)
COMMENT: Third note

/MUSICIANS/T/Test/Times.sid
TITLE: Times
NAME: Name with (1:23)
COMMENT: "quoted comment"
`;

await test('hvsc: parseLengths', () => {
  eq(parseLengths('4:27 5:38'), [267, 338]);
  eq(parseLengths('0:31'), [31]);
  eq(parseLengths(''), []);
  eq(parseLengths('4:27 (G) 1:17 (M)'), [267, 0, 77, 0],
     'attribute tokens (legacy format quirk, matches sid_add.py)');
  eq(parseLengths('7:53'), [473]);
});

await test('hvsc: songlengths lookups', () => {
  const sl = parseSonglengths(SL_FIXTURE);
  const a = sl.byMd5.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  eq(a.lengths, [267, 338], 'lengths');
  eq(a.path, '/MUSICIANS/T/Test/Test_Tune.sid', 'path from the ; line');
  eq(a.value, '4:27 5:38', 'raw value');
  eq(sl.byName.get('Times.sid').lengths, [31], 'by name');
  eq(sl.byPath.get('/MUSICIANS/T/Test/Times.sid').value, '0:31', 'by path');
  eq(sl.byMd5.get('ffffffffffffffffffffffffffffffff'), undefined,
     'missing key');
  eq(sl.byPrefix.get('aaaaaaaa').lengths, [267, 338], 'by md5 prefix');
  const col = sl.byPrefix.get('dddddddd');
  ok(Array.isArray(col) && col.length === 2, 'prefix collision -> list');
  eq(col[0].path, '/MUSICIANS/U/Other/Alpha.sid', 'first collision entry');
  eq(sl.byPrefix.get('12345678'), undefined, 'unknown prefix');
  eq(sl.byNameCount.get('Alpha.sid'), 2, 'name candidate count');
  eq(sl.byNameCount.get('Test_Tune.sid'), 1, 'unique name count');
});

let currentProtocol = null;

/** The 1.0.11 descriptor, as the page selects it from a hello value. */
async function proto() {
  if (!currentProtocol) {
    currentProtocol = await select({
      helloBytes: new Uint8Array([5, 0, 0x20, 0x68,
                                  0xff, 0xff, 0xff, 0x0f, 1, 0, 11, 0]),
      present: ['debug', 'state', 'info', 'hello'],
    });
  }
  return currentProtocol;
}

await test('ble: parseInfo (88-byte and 96-byte info reads)', async () => {
  const p = await proto();
  const infoBytes = ({ title = '', name = '', author = '', id = null }) => {
    const b = new Uint8Array(id === null ? 88 : 96);
    const put = (s, off, n) =>
      b.set(new TextEncoder().encode(s).subarray(0, n - 1), off);
    put(title, 0, 32);
    put(name, 32, 24);
    put(author, 56, 32);
    if (id !== null) b.set(new TextEncoder().encode(id), 88);
    return b;
  };

  const full = parseInfo(infoBytes({
    title: 'To be on Top', name: 'To_be_on_Top.sid',
    author: 'Chris Hulsbeck', id: 'b9fcd75b',
  }), p);
  eq(full.title, 'To be on Top', 'title');
  eq(full.name, 'To_be_on_Top.sid', 'name');
  eq(full.author, 'Chris Hulsbeck', 'author');
  eq(full.id, 'b9fcd75b', 'whole-file md5 prefix');

  eq(parseInfo(infoBytes({ name: 'X.sid' }), p).id, null,
     '88-byte value from an older firmware: no id');
  eq(parseInfo(infoBytes({ name: 'X.sid', id: '00000000' }), p).id, null,
     'all-zero id means unknown');
  eq(parseInfo(infoBytes({ name: 'X.sid', id: 'ABCDEF01' }), p).id, 'abcdef01',
     'normalized to lower case');
  eq(parseInfo(infoBytes({ name: 'X.sid', id: '\0\0\0\0\0\0\0\0' }), p).id, null,
     'NUL-filled id');
  eq(parseInfo(new Uint8Array(40), p), null, 'short value rejected');
  eq(parseInfo(infoBytes({ name: 'X.sid' }), null), null,
     'no descriptor -> null');
});

await test('ble: time payload carries the sub-second fraction', () => {
  const d = new Date(2026, 10, 2, 13, 45, 30, 500);
  const p = timePayload(d);
  eq(p.length, 10, '10 bytes');
  eq(p[8], 128, '500 ms -> 128/256');
  const t = parseTime(p);
  eq(t.hours, 13, 'hours');
  eq(t.minutes, 45, 'minutes');
  eq(t.seconds, 30, 'seconds');
  eq(t.dow, 1, 'Monday = 1');
  eq(Math.round((t.fraction * 1000) / 256), 500, 'fraction back to ms');
  eq(timePayload(new Date(2026, 10, 2, 13, 45, 30, 0))[8], 0, '0 ms');
  /* 999 ms must not round to 256 and wrap to 0 (a whole second off) */
  eq(timePayload(new Date(2026, 10, 2, 13, 45, 30, 999))[8], 255, '999 ms');
  eq(parseTime(new Uint8Array(9)), null, 'short value rejected');
});

await test('ble: parseState reports the volume', async () => {
  const p = await proto();
  const b = new Uint8Array(16);
  b[0] = 0x01;
  b[7] = 200;
  const st = parseState(b, p);
  eq(st.playing, true, 'flags still decoded');
  eq(st.volume, 200, 'volume at [7]');
  eq(parseState(new Uint8Array(8), p), null, 'short value rejected');
  eq(parseState(b, null), null, 'no descriptor -> null');
});

await test('protocol: descriptor index and hello selection', async () => {
  const index = await loadIndex(PROTOCOL_BASE);
  eq(index.latest, '1.0.11', 'newest frozen descriptor');
  eq(index.capability_bits.state, 0, 'state capability bit');
  eq(index.capability_bits.hello, 21, 'hello capability bit');
  ok(index.versions.some((v) => v.firmware === '1.0.7'),
     'the oldest supported firmware is still described');

  const p = await proto();
  eq(p.firmware, '1.0.11', 'firmware');
  eq(p.protocol, 5, 'protocol');
  eq(p.layout, 0x6820, 'layout id from the index');
  eq(p.source, 'hello', 'selected by hello');
  eq(p.notes.length, 0, 'no fallback note');
  const hello = parseHello(new Uint8Array([5, 0, 0x20, 0x68,
                                           0xff, 0xff, 0xff, 0x0f,
                                           1, 0, 11, 3]));
  eq(hello.protocol, 5, 'hello protocol');
  eq(hello.layout, 0x6820, 'hello layout');
  eq(hello.firmware, '1.0.11', 'hello firmware');
  eq([hello.debug, hello.legacyEngine, hello.splitEngine],
     [true, true, false], 'hello build flags');
  eq(parseHello(new Uint8Array(4)), null, 'short hello rejected');
  ok(p.has('hello'), 'hello capability');
  eq(p.char('debug'), DBG_CHAR, 'debug uuid from the descriptor');
  eq(p.charSize('debug'), 160, 'debug value size');
  eq(p.offset('snapshot', 'sid_playing'), 72, 'sid_playing offset');
  eq(p.opcode('set_end_mode'), 0x22, 'end-mode opcode');
  eq(p.build('set_end_mode', 2), new Uint8Array([0x22, 2]),
     'end-mode command bytes');
});

await test('protocol: delete takes names the loader cannot play', async () => {
  const p = await proto();
  const long = 'Yet_Bigger_Beat_2SID.sid'; /* 24 chars */
  eq(p.commandNameMax('play_file_default'), 23, 'play limit is the loader');
  eq(p.commandNameMax('delete'), 59, 'delete limit is a listing page');
  const bytes = p.build('delete', long);
  eq(bytes.length, 1 + long.length, 'opcode + name, not truncated');
  eq(new TextDecoder().decode(bytes.subarray(1)), long, 'full name on the wire');
});

await test('protocol: unknown layout falls back with a note', async () => {
  const p = await select({
    helloBytes: new Uint8Array([5, 0, 0x99, 0x99, 0xff, 0xff, 0xff, 0x0f,
                                1, 0, 11, 0]),
    present: ['debug', 'state', 'info', 'hello'],
  });
  eq(p.firmware, '1.0.11', 'newest descriptor of the same protocol');
  ok(p.notes.some((n) => /no descriptor/.test(n)), 'says why');
});

await test('protocol: newer protocol falls back to the newest older one',
  async () => {
    const p = await select({
      helloBytes: new Uint8Array([9, 0, 1, 2, 0xff, 0xff, 0xff, 0x0f,
                                  2, 0, 0, 0]),
      present: ['debug', 'state', 'info', 'hello'],
    });
    eq(p.firmware, '1.0.11', 'newest older descriptor');
    ok(p.notes.some((n) => /newer commands are disabled/.test(n)),
       'says why');
  });

await test('protocol: legacy probe without hello', async () => {
  const newish = await select({
    present: ['debug', 'state', 'info'], debugSize: 160,
  });
  eq(newish.firmware, '1.0.10', 'state+info, 160-byte debug');
  eq(newish.source, 'legacy', 'legacy source tag');
  ok(newish.notes.some((n) => /legacy probe/.test(n)), 'approximate version');
  eq(newish.opcode('set_end_mode'), 0x22, 'opcodes still decoded');

  const old = await select({ present: ['debug'], debugSize: 140 });
  eq(old.firmware, '1.0.7', 'debug only, 140-byte debug');
  ok(!old.has('state') && !old.has('info'), 'no state/info');
  ok(!old.has('transport'), 'no transport commands');
});

await test('protocol: no matching descriptor returns null', async () => {
  eq(await select({ present: ['debug'], debugSize: 99 }), null,
     'unknown debug size');
});

await test('protocol: an unreadable hello value falls back to the probe',
  () => withMockClock(async (clock) => {
    const sc = new SidClock();
    clock.failHello = 2; // the read and its retry
    await sc.connect();
    eq(sc.firmware, '1.0.10', 'state+info with a 160-byte debug value');
    eq(sc.protocol.source, 'legacy', 'identified by the legacy probe');
    ok(sc.notes.some((n) => /legacy probe/.test(n)), 'says it is approximate');
    ok(sc.supports('state'), 'state is still usable');
    ok(!sc.supports('hello'), 'does not claim the unread hello feature');
  }));

await test('ble: SidClock coalesces concurrent connect() calls', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    const [a, b] = await Promise.all([sc.connect(), sc.connect()]);
    eq(a, 'SidClock', 'first name');
    eq(b, 'SidClock', 'same in-flight attempt');
    eq(clock.requests, 1, 'picker shown once');
    eq(clock.connects, 1, 'gatt.connect() called once');
    ok(sc.connected, 'connected');
  }));

await test('ble: SidClock subscribes before reading the state', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    const seen = [];
    sc.onState = (st) => seen.push(st);
    await sc.connect();
    await sc.startUpdates();
    eq(clock.stateReads, 0, 'no read before the CCC write');
    ok(!clock.poisoned, 'the link is not wedged');
    eq(clock.subs, 1, 'one CCC write');
    clock.stateChar.emit([1, 0, 2, 0, 0, 2, 1, 0, 42, 0, 0, 0, 100, 0, 0, 0]);
    eq(seen.length, 1, 'notification reaches the page');
    eq(seen[0].elapsed, 42, 'pushed value');
  }));

await test('ble: SidClock retries the CCC write once', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    await sc.connect();
    clock.failSub = 1;
    await sc.startUpdates();
    eq(clock.subs, 2, 'startNotifications attempted twice');
  }));

await test('ble: SidClock end-mode command', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    await sc.connect();
    await sc.setEndMode(2);
    eq(clock.dbgChar.writes, [[0x22, 2]], 'opcode 0x22 + mode');
  }));

await test('ble: SidClock retries a read but not after disconnect', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    await sc.connect();
    clock.failInfo = 1;
    eq((await sc.readInfo()).title, 'Test Tune', 'retry recovers');
    eq(clock.infoReads, 2, 'one retry');

    clock.failInfo = 2;
    await throws(() => sc.readInfo(), /GATT operation failed/);
    eq(clock.infoReads, 4, 'gives up after one retry');

    clock.device.gatt.connected = false;
    clock.failInfo = 1;
    await throws(() => sc.readInfo(), /GATT operation failed/);
    eq(clock.infoReads, 5, 'no retry on a dead link');
  }));

await test('ble: SidClock replaces listeners on reconnect', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    const seen = [];
    sc.onState = (st) => seen.push(st);
    await sc.connect();
    await sc.startUpdates();
    await sc.connect();
    await sc.startUpdates();
    clock.stateChar.emit();
    eq(seen.length, 1, 'one listener after two connects');
  }));

await test('ble: SidClock retries the first GATT connect once', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    clock.failConnect = 1;
    eq(await sc.connect(), 'SidClock', 'second attempt succeeds');
    eq(clock.connects, 2, 'one retry');
    ok(sc.connected, 'connected');
  }));

await test('ble: a service table that is still filling in retries', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    /* Android has reported "No Services matching UUID ..." right after
     * a fresh connect even though the device has the service */
    clock.failService = 1;
    eq(await sc.connect(), 'SidClock', 'the retry finds the service');
    ok(sc.connected, 'connected');
    eq(clock.connects, 1, 'the same link is reused');
  }));

await test('ble: SidClock can retry after a failed connect', () =>
  withMockClock(async (clock) => {
    const sc = new SidClock();
    clock.failConnect = 2; // the attempt and its retry
    await throws(() => sc.connect(), /GATT operation failed/);
    ok(!sc.connected, 'not connected');
    eq(clock.requests, 1, 'device picked once');
    eq(clock.connects, 2, 'first attempt and retry failed');
    await sc.connect();
    ok(sc.connected, 'next connect call works');
    eq(clock.connects, 3, 'a fresh GATT attempt');
    eq(clock.requests, 1, 'same device, no picker');
  }));

await test('hvsc: STIL entry parsing', () => {
  const idx = stilIndex(STIL_FIXTURE);
  const e = idx.byPath.get('/MUSICIANS/T/Test/Test_Tune.sid');
  ok(e, 'entry found');
  eq(e.names[2], 'Second Level', 'wrapped NAME');
  eq(e.names[1], undefined, 'sub 0 NAME is dropped (sid_add.py)');
  eq(e.comment, 'A tune-wide comment that wraps', 'tune comment');
  eq(e.subs[2], 'Second level note here', 'subsong note');
  eq(e.subs[3], 'Third note', 'second note');
  const t = idx.byPath.get('/MUSICIANS/T/Test/Times.sid');
  eq(t.comment, 'quoted comment', 'quotes stripped');
  eq(Object.keys(t.names).length, 0, 'no sub-0 names');
  eq(idx.byName.get('Times.sid'),
     idx.byPath.get('/MUSICIANS/U/Other/Times.sid'),
     'by name keeps the first entry in file order');
  eq(idx.byNameCount.get('Times.sid'), 2, 'name candidate count');
  eq(idx.byNameCount.get('Test_Tune.sid'), 1, 'unique name count');
});

await test('hvsc: tune matching (md5 / upload / name)', () => {
  const sl = parseSonglengths(SL_FIXTURE);
  const st = stilIndex(STIL_FIXTURE);

  // the md5 prefix the device reports is the exact key: here the file
  // name matches nothing at all, the id still resolves
  const byMd5 = tuneLookup(sl, st, 'Totally_Wrong.sid', 'bbbbbbbb', null);
  eq(byMd5.source, 'md5', 'source');
  eq(byMd5.path, '/MUSICIANS/T/Test/Times.sid', 'path from the md5');
  eq(byMd5.lengths, [31], 'lengths');
  eq(byMd5.comment, 'quoted comment', 'STIL of the same path');
  eq(byMd5.candidates, 0, 'exact match needs no name candidates');

  // upload record (renamed tune) when the device sends no id
  const up = tuneLookup(sl, st, 'Renamed.sid', null,
    { path: '/MUSICIANS/T/Test/Times.sid' });
  eq(up.source, 'upload', 'source');
  eq(up.path, '/MUSICIANS/T/Test/Times.sid', 'path from the record');
  eq(up.lengths, [31], 'lengths');

  // ...but a record whose md5 disagrees with the device is just a guess
  const stale = { path: '/MUSICIANS/T/Test/Times.sid',
                  md5: 'aaaaaaaa000000000000000000000000' };
  eq(tuneLookup(sl, st, 'Nowhere.sid', '00000000', stale), null,
     'stale record dropped, nothing else matches');
  const still = tuneLookup(sl, st, 'Times.sid', '00000000', stale);
  eq(still.source, 'name', 'stale record ignored, name match used');
  eq(still.path, '/MUSICIANS/T/Test/Times.sid', 'name match path');

  // name fallback: the ambiguity is counted, and lengths + STIL come
  // from the same HVSC path (not from two first-wins lookups)
  const amb = tuneLookup(sl, st, 'Times.sid', null, null);
  eq(amb.source, 'name', 'source');
  eq(amb.candidates, 2, 'two HVSC files share the name');
  eq(amb.path, '/MUSICIANS/T/Test/Times.sid', 'first entry in file order');
  eq(amb.comment, 'quoted comment', 'STIL for that same path');

  // 8-hex collision (never happens in practice): the name picks one
  const col = tuneLookup(sl, st, 'Alpha.sid', 'dddddddd', null);
  eq(col.source, 'md5', 'source');
  eq(col.path, '/MUSICIANS/U/Other/Alpha.sid', 'first collision entry');
  eq(col.lengths, [12], 'its lengths');

  eq(tuneLookup(null, null, 'Times.sid', null, null), null, 'no databases');
  eq(tuneLookup(sl, st, 'Unknown.sid', null, null), null, 'no match');
});

await test('hvsc: buildStil matches sid_add.py output', () => {
  const idx = stilIndex(STIL_FIXTURE);
  eq(buildStil(idx.byPath.get('/MUSICIANS/T/Test/Test_Tune.sid'), 3),
     '\nSecond Level\n\nA tune-wide comment that wraps\n' +
     '@2 Second level note here\n@3 Third note\n', 'entry 1');
  eq(buildStil(idx.byPath.get('/MUSICIANS/T/Test/Times.sid'), 3),
     '\n\n\nquoted comment\n', 'entry 2');
});

await test('hvsc: stripTimeRange', () => {
  eq(stripTimeRange('Name with (1:23)'), 'Name with');
  eq(stripTimeRange('Central Park (loader)'), 'Central Park (loader)');
  eq(stripTimeRange('Song (1:23-2:45)'), 'Song');
  eq(stripTimeRange('Song (0:59\u20131:05)'), 'Song');
});

await test('hvsc: device file names', () => {
  eq(deviceNameFor('Commando.sid'), 'Commando.sid');
  eq(deviceNameFor('1234567890123456.sid'), '1234567890123456.sid');
  eq(deviceNameFor('12345678901234567.sid'), '1234567890123456.sid');
  eq(deviceNameFor('The_Great_Giana_Sisters.sid'), 'The_Great_Giana_.sid');
  ok(deviceNameFor('a_very_long_hvsc_file_name.sid').length <= 20,
     'never longer than 20');
});

await test('hvsc: uploadedIds marks what is still on the device', () => {
  const uploads = {
    'Short.sid': { id: 11, file: 'Short.sid' },
    'A_Very_Long_Name.sid': { id: 22, file: 'A_Very_Long_Name_Original.sid' },
    'Gone.sid': { id: 33, file: 'Gone.sid' },
    'No_Id.sid': { file: 'No_Id.sid' },
  };
  const ids = uploadedIds(uploads, ['Short.sid', 'A_Very_Long_Name.sid',
                                    'No_Id.sid', 'Other.sid']);
  eq([...ids].sort(), ['11', '22'], 'ids of files still listed');
  ok(!ids.has('33'), 'deleted file is not marked');
  eq([...uploadedIds(null, ['Short.sid'])], [], 'no upload log');
  eq([...uploadedIds(uploads, [])], [], 'nothing on the device');
});

await test('hvsc: name keys mark files that are already on the device', () => {
  eq(nameKey('RoboCop 3'), 'robocop3', 'space');
  eq(nameKey('RoboCop_3.sid'), 'robocop3', 'underscore + .sid');
  eq(nameKey('IK+'), 'ikplus', 'plus reads as plus');
  eq(nameKey('IK_plus.sid'), 'ikplus', 'IK_plus');
  eq(nameKey(''), '', 'empty');

  const keys = deviceNameKeys([
    'RoboCop_3.sid', 'Supremacy.sid', 'IK_plus.sid', 'Neverending_Stor.sid',
    'Gone.len', 'RoboCop_3.len',
  ]);
  ok(onDeviceByTitle(keys, 'RoboCop 3'), 'exact title');
  ok(onDeviceByTitle(keys, 'Supremacy'), 'exact title 2');
  ok(onDeviceByTitle(keys, 'robocop 3'), 'case-insensitive');
  ok(onDeviceByTitle(keys, 'IK+'), 'plus variant');
  ok(onDeviceByTitle(keys, 'Neverending Story'), '16-char stem prefix');
  ok(!onDeviceByTitle(keys, 'RoboCop 2'), 'different sequel is not marked');
  ok(!onDeviceByTitle(keys, 'Last Ninja'), 'not in the listing');
  ok(!onDeviceByTitle(keys, ''), 'empty title');
  // the listing is authoritative: an empty /home marks nothing
  const empty = deviceNameKeys([]);
  ok(!onDeviceByTitle(empty, 'Supremacy'), 'empty listing');
});

await test('hvsc: search field filter', () => {
  eq(SEARCH_FIELDS.join(','), 'title,author,released', 'the API match fields');
  // the shape the API returns, and the complaint that started this:
  // a title search for "commando" also brings back rows whose *released*
  // line says "1987 Commando Frontier"
  const r = [
    { id: 1, title: 'Bubble Bobble', author: 'Kent Patfield (Patto)',
      released: '2020 Onslaught' },
    { id: 2, title: 'Alpha', author: 'Geert Vandevenne (Cavi)',
      released: '1987 Commando Frontier' },
    { id: 3, title: 'Commando', author: 'Rob Hubbard',
      released: '1985 Elite' },
  ];
  const ids = (rows) => rows.map((x) => x.id).join(',');
  eq(ids(filterSids(r, 'commando', ['title', 'author'])), '3',
     'released-only match dropped');
  eq(ids(filterSids(r, 'commando', ['title', 'author', 'released'])), '2,3',
     'ticking released keeps it');
  eq(ids(filterSids(r, 'commando', ['released'])), '2',
     'released-only search still possible');
  eq(ids(filterSids(r, 'commando', [])), '1,2,3', 'no box: no filter');
  eq(ids(filterSids(r, 'bobble bubble', ['title'])), '1', 'word order free');
  eq(ids(filterSids(r, 'BUBBLE', ['title'])), '1', 'case insensitive');
  eq(ids(filterSids(r, 'patfield', ['author'])), '1', 'author match');
  eq(ids(filterSids(r, 'patfield', ['title'])), '', 'field respected');
  eq(ids(filterSids(r, '   ', ['title'])), '1,2,3', 'blank query: no filter');
  eq(ids(filterSids(r, 'xia', ['title'])), '', 'substring only');
});

/* ---------- live checks (network) ---------- */

const LIVE = new URLSearchParams(location.search).has('live');

if (LIVE) {
  const LN2_PATH = '/MUSICIANS/G/Gray_Matt/Last_Ninja_2.sid';

  await test('live: search + details', async () => {
    const res = await searchSids('last ninja 2');
    ok(res.length > 0, 'results');
    const hit = res.find((r) => r.title === 'Last Ninja 2' &&
      (r.author || '').includes('Matt Gray'));
    ok(hit, 'Matt Gray hit');
    const det = await getSidDetails(hit.id);
    eq(det.filename, 'Last_Ninja_2.sid', 'file name');
    eq(det.numberOfSongs, 13, 'song count');
    eq(det.filePath, '/MUSICIANS/G/Gray_Matt/', 'path');
  });

  await test('live: search field filter against the API', async () => {
    // the API searches title, author *and* released: "commando" comes back
    // with tunes from "1987 Commando Frontier" that are not Commandos
    const raw = await searchSids('commando');
    ok(raw.length > 0, `server matches (${raw.length})`);
    const releasedOnly = raw.find((r) =>
      !/commando/i.test(r.title || '') && !/commando/i.test(r.author || ''));
    ok(releasedOnly, 'the API really matches the released line too');
    const kept = filterSids(raw, 'commando', ['title', 'author']);
    ok(kept.length > 0 && kept.length < raw.length,
       `name+author filter keeps ${kept.length} of ${raw.length}`);
    ok(kept.every((r) => /commando/i.test(r.title || '') ||
                        /commando/i.test(r.author || '')),
       'every kept row matches a checked field');
    ok(!kept.some((r) => r.id === releasedOnly.id),
       'the released-only row is gone');
  });

  await test('live: download + Songlengths sidecar + STIL info', async () => {
    const res = await searchSids('last ninja 2');
    const hit = res.find((r) => r.title === 'Last Ninja 2' &&
      (r.author || '').includes('Matt Gray'));
    const bytes = await downloadSid(hit.id);
    eq(md5(bytes), '69ecd5a4c3632079159df4205cb22055', 'whole-file md5');

    await loadSonglengths();
    eq(await makeLen(bytes),
       '267 338 303 332 237 368 226 304 228 276 126 473 211\n', '.len');

    await loadStil();
    const stil = await makeStil(LN2_PATH, 13);
    ok(stil && stil.startsWith('Central Park (loader)\n' +
      'Central Park (in-game)\nThe Street (loader)\n'), 'stil names');

    // three HVSC files share this basename - the upload map resolves it
    await rememberUpload('Last_Ninja_2.sid', { file: 'Last_Ninja_2.sid',
      id: hit.id, path: LN2_PATH });
    const info = await tuneInfo('Last_Ninja_2.sid');
    eq(info.path, LN2_PATH, 'matched path via the upload map');
    eq(info.source, 'upload', 'match source');
    eq(info.lengths.length, 13, 'lengths from Songlengths');
    eq(info.names[2], 'Central Park (in-game)', 'names from STIL');
    ok(info.comment.length > 100, 'tune comment');
    ok(info.subs[9].startsWith('Bits and pieces'), 'subsong note');

    await rememberUpload('LN2.sid', { file: 'Last_Ninja_2.sid', id: hit.id,
      path: LN2_PATH });
    const renamed = await tuneInfo('LN2.sid');
    eq(renamed.path, LN2_PATH, 'renamed uploads still match');
    eq(renamed.names[13], 'The Final Battle (loader)', 'name 13');

    // the whole-file md5 the device reports is the exact key: this name
    // matches nothing in HVSC, the id (from the md5 every host computes
    // the same way) resolves it anyway
    const byId = await tuneInfo('No_Such_Tune_At_All.sid', '69ecd5a4');
    eq(byId.source, 'md5', 'id wins over the file name');
    eq(byId.path, LN2_PATH, 'path from the id');
    eq(byId.lengths.length, 13, 'lengths from the id');
    eq(byId.names[2], 'Central Park (in-game)', 'STIL from the id');
    eq(byId.candidates, 0, 'no name guessing involved');

    // a stale upload record loses to the device's own md5
    await rememberUpload('Stale.sid', { file: 'Last_Ninja_2.sid',
      id: hit.id, path: LN2_PATH, md5: md5(bytes) });
    const fresh = await tuneInfo('Stale.sid', '69ecd5a4');
    eq(fresh.path, LN2_PATH, 'matching md5 keeps the record usable');
    const stale = await tuneInfo('Stale.sid', '00000000');
    eq(stale, null, 'disagreeing md5 drops the record and finds nothing');
  });
}

} // main

main().catch((e) => {
  current = { name: 'harness', ok: false, error: (e && e.stack) || String(e) };
  results.push(current);
  report();
}).finally(() => {
  if (RECORD) {
    fetch('/__result__?done=1', { method: 'POST', body: out.textContent })
      .catch(() => {});
  }
});
