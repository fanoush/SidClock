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
  cborUint, cborBytes, cborText, cborMap, cborDecode, SmpClient, SmpError,
} from '../../web/smp.js';
import {
  parseLengths, parseSonglengths, stilIndex, buildStil, stripTimeRange,
  deviceNameFor, searchSids, getSidDetails, downloadSid, loadSonglengths,
  loadStil, makeLen, makeStil, tuneInfo, rememberUpload,
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
`;

const STIL_FIXTURE = `; STIL test fixture
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
});

await test('hvsc: STIL entry parsing', () => {
  const idx = stilIndex(STIL_FIXTURE);
  const e = idx.byPath.get('/MUSICIANS/T/Test/Test_Tune.sid');
  ok(e, 'entry found');
  eq(e.names[2], 'Second Level', 'wrapped NAME');
  eq(e.names[1], undefined, 'sub 0 NAME is dropped (sid_add.py)');
  eq(e.comment, 'A tune-wide comment that wraps', 'tune comment');
  eq(e.subs[2], 'Second level note here', 'subsong note');
  eq(e.subs[3], 'Third note', 'second note');
  const t = idx.byName.get('Times.sid');
  eq(t.comment, 'quoted comment', 'quotes stripped');
  eq(Object.keys(t.names).length, 0, 'no sub-0 names');
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
    eq(info.lengths.length, 13, 'lengths from Songlengths');
    eq(info.names[2], 'Central Park (in-game)', 'names from STIL');
    ok(info.comment.length > 100, 'tune comment');
    ok(info.subs[9].startsWith('Bits and pieces'), 'subsong note');

    await rememberUpload('LN2.sid', { file: 'Last_Ninja_2.sid', id: hit.id,
      path: LN2_PATH });
    const renamed = await tuneInfo('LN2.sid');
    eq(renamed.path, LN2_PATH, 'renamed uploads still match');
    eq(renamed.names[13], 'The Final Battle (loader)', 'name 13');
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
