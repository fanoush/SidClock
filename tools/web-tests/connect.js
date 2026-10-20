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
  const clock = {
    requests: 0, connects: 0, stateReads: 0, infoReads: 0, subs: 0,
    failConnect: 0, failState: 0, failInfo: 0, failSub: 0,
    writes: [], poisoned: false, subscribed: false,
  };
  const stateBytes = new Uint8Array(16);
  stateBytes.set([1, 0, 2, 0, 0, 2, 1, 0, 5, 0, 0, 0, 100, 0, 0, 0]);
  const infoBytes = new Uint8Array(96);
  const put = (s, off, n) =>
    infoBytes.set(new TextEncoder().encode(s).subarray(0, n - 1), off);
  put('Test Tune', 0, 32);
  put('test.sid', 32, 24);
  put('Tester', 56, 32);
  put('deadbeef', 88, 8);
  const snapshot = new Uint8Array(132);
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

  const dbg = {
    value: view(snapshot),
    async readValue() {
      return view(snapshot);
    },
    async writeValue(value) {
      clock.writes.push([...value]);
    },
  };

  const chars = new Map([
    ['73696463-6c6f-4b02-9c1d-77ce3f41a5c0', dbg],
    ['73696463-6c6f-4b03-9c1d-77ce3f41a5c0', state],
    ['73696463-6c6f-4b04-9c1d-77ce3f41a5c0', info],
  ]);
  const sid = {
    async getCharacteristic(uuid) { return chars.get(uuid); },
  };
  const server = {
    async getPrimaryService(uuid) {
      if (uuid === '73696463-6c6f-4b01-9c1d-77ce3f41a5c0') return sid;
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
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (clock.failConnect > 0) {
          clock.failConnect--;
          throw err();
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
  clock.emitState = (bytes) => state.emit(bytes);
  clock.disconnect = () => device.gatt.disconnect();
  window.__ble = clock;
}

/* ---------- load web/index.html with the mock in front of app.js ---------- */

const webBase = new URL('../../web/', location.href).href;
const indexHtml = await (await fetch('../../web/index.html')).text();
const pageHtml = indexHtml
  .replace('<head>', `<head><base href="${webBase}">`)
  .replace('<script type="module" src="app.js"></script>',
    '<script>(' + installBleMock.toString() + ')();</script>\n' +
    '<script type="module" src="app.js"></script>');

async function loadPage() {
  const host = document.getElementById('frame');
  host.textContent = '';
  const frame = document.createElement('iframe');
  host.append(frame);
  const loaded = new Promise((resolve) =>
    frame.addEventListener('load', resolve, { once: true }));
  frame.srcdoc = pageHtml;
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

if (RECORD) {
  try {
    await fetch('/__result__?done=1', { method: 'POST', body: out.textContent });
  } catch (e) { /* the report is in the page either way */ }
}
