/*
 * SidClock web remote - UI logic.
 *
 * Everything the page shows arrives as a notification from the device
 * (the state characteristic pushes on every change and once per second
 * while a tune plays), so there is no polling and no timer-driven reads:
 * commands are fire-and-forget ATT writes and the pushed state is the
 * acknowledgement. The exceptions are the battery percentage and the
 * device clock, which are read once per connection (the clock is then
 * ticked locally and compared against the browser clock).
 */

import { SidClock, END_MODES, MODEL_MODES, CHIP_NAMES } from './ble.js';

const $ = (id) => document.getElementById(id);
const sc = new SidClock();

const CONTROLS = ['prev', 'play', 'next', 'stop', 'subprev', 'subnext',
                  'subtune', 'settime'];

let lastGeneration = -1;
let noteTimer = null;
let deviceBase = null;       // { time, at } of the last device clock read
let deviceTimeUnset = false; // the device answered "unset" (fresh reset)

/* ---------- helpers ---------- */

function fmtSeconds(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = `status ${cls}`;
  $('dot').className = `dot ${cls}`;
}

function note(text, isError = false) {
  const el = $('note');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function errorText(e) {
  if (!e) return 'unknown error';
  if (e.name === 'NotFoundError') return 'no device selected';
  if (e.name === 'SecurityError') return 'Bluetooth access was blocked';
  if (e.name === 'NetworkError' || e.name === 'InvalidStateError') {
    return 'connection failed - connected to another app, or out of range?';
  }
  return e.message || String(e);
}

function commandError(e, what) {
  const m = String((e && e.message) || e).toLowerCase();
  if (m.includes('gatt operation failed') || m.includes('notallowederror')) {
    return `${what}: rejected by the device (busy, or Bluetooth access is R/O?)`;
  }
  return `${what} failed: ${errorText(e)}`;
}

function run(promise, what) {
  return promise.catch((e) => {
    console.error(what, e);
    note(commandError(e, what), true);
  });
}

/* ---------- connection ---------- */

function setConnected(ok) {
  for (const id of CONTROLS) $(id).disabled = !ok;
  $('connect').textContent =
    ok ? 'Disconnect' : (sc.device ? 'Reconnect' : 'Connect');
  document.body.classList.toggle('connected', ok);
  if (!ok) {
    setStatus(sc.device ? 'disconnected' : 'not connected');
    $('play').textContent = '▶';
    deviceBase = null;
    deviceTimeUnset = false;
    $('devtime').textContent = '--:--:--';
    $('devtime').classList.remove('warn');
  }
}

$('connect').addEventListener('click', async () => {
  if (sc.connected) {
    await sc.disconnect();
    setConnected(false);
    return;
  }
  $('connect').disabled = true;
  setStatus('connecting…', 'busy');
  try {
    const name = await sc.connect();
    await sc.startUpdates();
    lastGeneration = -1;
    await refreshInfo();
    await readClock();
    setConnected(true);
    setStatus(name, 'ok');
  } catch (e) {
    console.error(e);
    setStatus('not connected');
    note(errorText(e), true);
  } finally {
    $('connect').disabled = false;
  }
});

sc.onDisconnect = () => {
  setConnected(false);
  note('device disconnected');
};

/* ---------- pushed player state ---------- */

sc.onState = (st) => {
  if (!st) return;
  renderState(st);
  if (st.generation !== lastGeneration) {
    lastGeneration = st.generation;
    refreshInfo().catch((e) => console.error('info', e));
  }
};

sc.onBattery = (pct) => {
  $('battery').textContent = `${pct} %`;
};

function renderState(st) {
  const playing = st.playing && !st.paused;
  $('play').textContent = playing ? '⏸' : '▶';
  $('play').title = playing ? 'pause' : 'play';

  const sel = $('subtune');
  if (Number(sel.dataset.songs) !== st.songs) {
    rebuildSubtune(st.songs);
  }
  if (st.songs > 0) {
    sel.value = String(st.subtune + 1);
  }
  sel.disabled = st.songs <= 0 || !sc.connected;

  $('chip').textContent =
    `chip ${CHIP_NAMES[st.chip] || '?'} · ${MODEL_MODES[st.modelMode] || 'auto'}`;
  $('engine').textContent = st.legacyEngine ? 'legacy engine' : 'cRSID';
  $('snd').textContent = st.sound ? 'snd on' : 'muted';

  const pct = st.length > 0
    ? Math.min(100, (st.elapsed / st.length) * 100) : 0;
  $('progressbar').style.width = `${pct}%`;
  $('pos').textContent = fmtSeconds(st.elapsed);
  $('len').textContent = st.length > 0 ? fmtSeconds(st.length) : '--:--';
  $('ends').textContent = END_MODES[st.endMode] || '';
}

function rebuildSubtune(songs) {
  const sel = $('subtune');
  sel.innerHTML = '';
  if (songs <= 0) {
    const o = document.createElement('option');
    o.value = '0';
    o.textContent = '--';
    sel.append(o);
  } else {
    for (let i = 1; i <= songs; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = String(i);
      sel.append(o);
    }
  }
  sel.dataset.songs = String(songs);
}

/* ---------- tune strings ---------- */

async function refreshInfo() {
  const i = await sc.readInfo();
  if (!i) return;
  $('title').textContent = i.title || i.name || 'nothing loaded';
  const bits = [];
  if (i.author) bits.push(i.author);
  if (i.name) bits.push(i.name);
  $('subtitle').textContent = bits.join(' · ');
}

/* ---------- clocks: device vs. this browser ---------- */

function fmtClock(d) {
  return d.toTimeString().slice(0, 8);
}

function deviceNow() {
  if (!deviceBase) return null;
  return new Date(deviceBase.time.getTime() +
                  (performance.now() - deviceBase.at));
}

function showTime(t) {
  if (!t || t.year < 2020) {
    deviceBase = null;
    deviceTimeUnset = true;
    tickClocks();
    return;
  }
  deviceTimeUnset = false;
  deviceBase = {
    time: new Date(t.year, t.month - 1, t.day,
                   t.hours, t.minutes, t.seconds),
    at: performance.now(),
  };
  tickClocks();
}

function tickClocks() {
  const now = new Date();
  $('hosttime').textContent = fmtClock(now);

  const dev = deviceNow();
  if (dev) {
    $('devtime').textContent = fmtClock(dev);
    // a couple of seconds of slack: clock reads truncate sub-second time
    $('devtime').classList.toggle('warn', Math.abs(dev - now) > 2500);
  } else {
    $('devtime').textContent = deviceTimeUnset ? 'unset' : '--:--:--';
    $('devtime').classList.toggle('warn', deviceTimeUnset);
  }
}

setInterval(tickClocks, 1000);

async function readClock() {
  try {
    showTime(await sc.readTime());
  } catch (e) {
    console.error('time', e);
  }
}

/* ---------- theme ---------- */

const THEME_KEY = 'sidclock-theme';

function applyTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f3f5f9' : '#0f141b';
  $('theme').textContent = theme === 'light' ? '☾' : '☀';
  $('theme').title = theme === 'light' ? 'switch to dark theme'
                                       : 'switch to light theme';
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) { /* private mode: only this visit */ }
  }
}

$('theme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light'
    ? 'dark' : 'light', true);
});

/* ---------- controls ---------- */

$('play').addEventListener('click', () => run(sc.playPause(), 'play/pause'));
$('prev').addEventListener('click', () => run(sc.prevTune(), 'previous tune'));
$('next').addEventListener('click', () => run(sc.nextTune(), 'next tune'));
$('subprev').addEventListener('click',
  () => run(sc.prevSubtune(), 'previous subtune'));
$('subnext').addEventListener('click',
  () => run(sc.nextSubtune(), 'next subtune'));
$('stop').addEventListener('click', () => run(sc.stop(), 'stop'));

$('subtune').addEventListener('change', () => {
  const n = Number($('subtune').value);
  if (n > 0) run(sc.playSubtune(n), 'play subtune');
});

$('settime').addEventListener('click', async () => {
  try {
    showTime(await sc.setTime(new Date()));
    note('device clock set');
  } catch (e) {
    console.error(e);
    note(commandError(e, 'set time'), true);
  }
});

/* ---------- startup ---------- */

applyTheme(document.documentElement.dataset.theme === 'light'
  ? 'light' : 'dark', false);
tickClocks();

if (!SidClock.available) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
} else {
  setConnected(false);
}
