/*
 * Page-level smoke test for the web remote.
 *
 * tests.js exercises the libraries in isolation; it never executes
 * app.js, which is where the wiring bugs live (a handler the page forgot
 * to define, a result list that never renders, a status line that goes
 * missing). This driver loads web/index.html in an iframe and drives the
 * real page: types a query, clicks Search, ticks the field boxes and
 * pages through the results, checking the DOM against what hvsc.c64.org
 * really returns.
 *
 * Needs the network. A browser without Web Bluetooth is fine - the page
 * then shows its "not supported" notice and the BLE parts stay off.
 * page.html has the command line.
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

/** Evidence (status lines, counts) printed under the running test. */
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

/* ---------- drive web/index.html in an iframe ---------- */

const API = 'https://hvsc.c64.org/api/v1/sids';
const consoleErrors = [];

const frame = document.createElement('iframe');
frame.src = '../../web/index.html';
const loaded = new Promise((resolve) => frame.addEventListener('load', resolve));
document.getElementById('frame').append(frame);

let win = null;
let doc = null;

const booted = (async () => {
  await loaded;
  win = frame.contentWindow;
  doc = frame.contentDocument;
  win.addEventListener('error', (e) =>
    consoleErrors.push(`uncaught: ${e.message}`));
  win.addEventListener('unhandledrejection', (e) =>
    consoleErrors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`));
  const cerr = win.console.error.bind(win.console);
  win.console.error = (...a) => {
    consoleErrors.push(a.map((x) => (x && x.message) || String(x)).join(' '));
    cerr(...a);
  };
})();

const $ = (id) => doc.getElementById(id);
const status = () => $('hmsg').textContent;
const count = (s = status()) => Number((s.match(/^(\d+) result/) || [])[1]);
const tuneName = (r) => r.title || `SID ${r.id}`;
const rowTitles = () => [...doc.querySelectorAll('#results li .tname')]
  .map((el) => el.textContent);
const sorted = (a) => [...a].sort();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

function tick(id, on) {
  const box = $(id);
  box.checked = on;
  box.dispatchEvent(new win.Event('change'));
}

async function search(q, timeout) {
  $('q').value = q;
  $('search').click();
  await until(() => /result|no match|no results|failed/.test(status()),
              `the "${q}" search`, timeout);
  return status();
}

const api = async (q) =>
  (await fetch(`${API}?q=${encodeURIComponent(q)}`, { mode: 'cors' })).json();

/* ---------- checks ---------- */

await test('page: boots the search card', async () => {
  await booted;
  await until(() => $('search'), 'the search card');
  ok($('unsupported').hidden === false,
     'no Web Bluetooth here: the notice shows');
  ok($('f-title').checked && $('f-author').checked && !$('f-released').checked,
     'field boxes default to name+author');
  ok($('more').hidden, '"show more" is hidden before any search');
});

await test('page: the device list is above the search and starts closed', async () => {
  const card = $('libcard');
  ok(card && card.tagName === 'DETAILS', 'it is a <details> card');
  const head = card.querySelector('summary');
  ok(head, 'its header is the summary');
  ok(!card.open, 'collapsed by default');
  const pos = card.compareDocumentPosition($('q'));
  ok(pos & win.Node.DOCUMENT_POSITION_FOLLOWING, 'it comes before the search box');
  /* a probe row (the headless page has no device, so the list is empty)
   * makes the card's growth measurable: a closed <details> must not take
   * up the room its content would need */
  const ul = $('lib');
  const wasHidden = ul.hidden;
  ul.hidden = false;
  const probe = doc.createElement('li');
  probe.textContent = 'probe';
  ul.append(probe);
  const closed = card.getBoundingClientRect().height;
  head.click();
  await until(() => card.open, 'the card to open');
  const opened = card.getBoundingClientRect().height;
  ok(opened > closed + 10,
     `opening grows the card (${Math.round(closed)} -> ${Math.round(opened)} px)`);
  head.click();
  await until(() => !card.open, 'the card to close');
  ok(Math.abs(card.getBoundingClientRect().height - closed) < 2,
     'closing shrinks it back');
  probe.remove();
  ul.hidden = wasHidden;
  $('librefresh').click();
  await sleep(400);
  ok(!card.open, 'the refresh button does not toggle the card');
});

const NAME_TERM = /commando/i;
let raw = [];

await test('page: name+author search drops released-only matches', async () => {
  raw = await api('commando');
  const expected = raw.filter((r) =>
    NAME_TERM.test(r.title || '') || NAME_TERM.test(r.author || ''));
  const releasedOnly = raw.length - expected.length;
  ok(releasedOnly > 0,
     `the API matches released lines too (${releasedOnly} of ${raw.length} rows)`);
  const s = await search('commando');
  note(`status: ${s}`);
  ok(/ in name\+author\b/.test(s), 'status names the checked fields');
  ok(s.includes(`(${raw.length} server matches)`), 'status shows the server total');
  eq(count(s), expected.length, 'count == the API name+author matches');
  eq(sorted(rowTitles()), sorted(expected.map(tuneName)),
     'the rows are exactly those matches');
});

await test('page: ticking released brings them back', async () => {
  tick('f-released', true);
  const want = Math.min(raw.length, 100);
  await until(() => rowTitles().length === want, 'the unfiltered list');
  note(`status: ${status()}`);
  ok(/ in name\+author\+released\b/.test(status()), 'status names all three fields');
  if (raw.length <= 100) {
    eq(sorted(rowTitles()), sorted(raw.map(tuneName)),
       'every server row is listed again');
  }
  tick('f-released', false);
});

await test('page: a broad search pages the list', async () => {
  const s = await search('the', 60000);
  note(`status: ${s}`);
  const total = count(s);
  ok(total > 100, `more matches than one page (${total})`);
  eq(rowTitles().length, 100, 'first page holds 100 rows');
  ok(/\bshowing 100\b/.test(s), 'status says showing 100');
  const more = $('more');
  ok(!more.hidden, '"show more" appears');
  const m = more.textContent.match(/^show 100 more \((\d+) left\)$/);
  ok(m, `button text: "${more.textContent}"`);
  eq(Number(m[1]), total - 100, 'the button counts the rest');
  more.click();
  await until(() => rowTitles().length === 200, 'a second page of rows');
  ok(/\bshowing 200\b/.test(status()), 'status follows the list');
});

await test('page: no boxes = the unfiltered server list', async () => {
  const server = await api('the');
  tick('f-title', false);
  tick('f-author', false);
  note(`status: ${status()}`);
  eq(count(), server.length, 'count == every server match');
  ok(!/ in /.test(status()), 'status names no fields');
  eq(rowTitles().length, 100, 'first page again');
  tick('f-title', true);
  note(`status: ${status()}`);
  ok(/ in name\b/.test(status()), 'title only');
  eq(count(), server.filter((r) => /the/i.test(r.title || '')).length,
     'count == the API title matches');
  eq(rowTitles().length, 100, 'still one page');
});

await test('page: an empty field result says which box is off', async () => {
  /* HVSC release lines carry the publisher, so "Gremlin Graphics" matches
   * only where the filter may not look */
  const q = 'Gremlin Graphics';
  const server = await api(q);
  const terms = q.toLowerCase().split(/\s+/);
  const expected = server.filter((r) => terms.every((t) =>
    `${r.title || ''} ${r.author || ''}`.toLowerCase().includes(t)));
  tick('f-author', true);
  const s = await search(q);
  note(`status: ${s}`);
  if (!expected.length && server.length) {
    ok(/^no match/.test(s), 'no matches in name+author');
    ok(/released is off/.test(s), 'status points at the unticked box');
    eq(rowTitles().length, 0, 'the list is empty');
    ok($('results').hidden, 'and hidden');
  } else {
    note(`(empty-case check skipped: ${expected.length} of ${server.length}` +
         ' match name/author)');
  }
});

await test('page: no console errors or uncaught exceptions', () => {
  eq(consoleErrors, [], 'page console');
});

if (RECORD) {
  try {
    await fetch('/__result__?done=1', { method: 'POST', body: out.textContent });
  } catch (e) { /* the report is in the page either way */ }
}
