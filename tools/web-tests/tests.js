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
  SidClock, parseInfo, DBG_CHAR, STATE_CHAR, INFO_CHAR, SIDCLOCK_SERVICE,
} from '../../web/ble.js';
import {
  cborUint, cborBytes, cborText, cborMap, cborDecode, SmpClient, SmpError,
} from '../../web/smp.js';
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
    requests: 0, connects: 0, stateReads: 0, infoReads: 0, subs: 0,
    failConnect: 0, failState: 0, failInfo: 0, failSub: 0,
    poisoned: false, subscribed: false,
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
  const dbgBytes = new Uint8Array(132);
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
  const dbgChar = {
    async readValue() { return view(dbgBytes); },
    async writeValue(bytes) { dbgChar.writes.push([...bytes]); },
    writes: [],
  };

  const chars = new Map([
    [DBG_CHAR, dbgChar], [STATE_CHAR, stateChar], [INFO_CHAR, infoChar],
  ]);
  const sid = {
    async getCharacteristic(uuid) { return chars.get(uuid); },
  };
  const server = {
    async getPrimaryService(uuid) {
      if (uuid === SIDCLOCK_SERVICE) return sid;
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

class FakeSmpDevice {
  constructor({ bufSize = 512, downloadChunk = 256 } = {}) {
    this.bufSize = bufSize;
    this.downloadChunk = downloadChunk;
    this.files = new Map();
    this.rx = new Uint8Array(0);
    this.frames = [];
    this.requests = [];
    this.dropNext = 0;
    this.statusMissBy = 0; // report a shorter file than uploaded
    this.notify = () => {};
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

    if (group === 0 && op === 0 && cmd === 6) {
      return this.reply(frame, cborMap([
        ['buf_size', cborUint(this.bufSize)],
        ['buf_count', cborUint(2)],
      ]));
    }
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
    device.notify = (bytes) => this.emit(bytes);
  }

  addEventListener(type, fn) {
    if (type === 'characteristicvaluechanged') this.listeners.push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  async startNotifications() {}
  async stopNotifications() {}

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

await test('ble: parseInfo (88-byte and 96-byte info reads)', () => {
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
  }));
  eq(full.title, 'To be on Top', 'title');
  eq(full.name, 'To_be_on_Top.sid', 'name');
  eq(full.author, 'Chris Hulsbeck', 'author');
  eq(full.id, 'b9fcd75b', 'whole-file md5 prefix');

  eq(parseInfo(infoBytes({ name: 'X.sid' })).id, null,
     '88-byte value from an older firmware: no id');
  eq(parseInfo(infoBytes({ name: 'X.sid', id: '00000000' })).id, null,
     'all-zero id means unknown');
  eq(parseInfo(infoBytes({ name: 'X.sid', id: 'ABCDEF01' })).id, 'abcdef01',
     'normalized to lower case');
  eq(parseInfo(infoBytes({ name: 'X.sid', id: '\0\0\0\0\0\0\0\0' })).id, null,
     'NUL-filled id');
  eq(parseInfo(new Uint8Array(40)), null, 'short value rejected');
});

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
