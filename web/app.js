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

import { SidClock } from './ble.js';
import { SmpClient } from './smp.js';
import * as hvsc from './hvsc.js';
import {
  loadManifest, planUpdate, fetchRelease, verifyRelease, cmpVersion,
  bytesOfHex,
} from './update.js';

const $ = (id) => document.getElementById(id);
const sc = new SidClock();

const CONTROLS = ['prev', 'play', 'next', 'stop', 'subprev', 'subnext',
                  'subtune', 'ends', 'settime', 'volume'];

let lastGeneration = -1;
let noteTimer = null;
let deviceBase = null;       // { ms, at } of the last device clock read
let deviceTimeUnset = false; // the device answered "unset" (fresh reset)
let volDragging = false;     // ignore pushed volume while the slider is used
let currentInfo = null;      // last info read (title / name / author)
let currentState = null;     // last pushed player state
let smp = null;              // SMP client while connected in R/W mode
let library = null;          // names in /home, or null when unknown
let deviceIds = new Set();   // HVSC ids uploaded into a name still in /home
let deviceKeys = { exact: new Set(), short: new Set() }; // /home names by title
let busy = null;             // what long operation is running, if any
let metaKey = '';            // what the HVSC info card currently shows
let infoReading = null;      // an info read in flight
let infoAgain = false;       // another read was asked for meanwhile
let recovering = false;      // a silent reconnect, no disconnect note

let updateManifest = null;   // the published release manifest (or null)
let updatePlan = null;       // what the update card currently offers
let updateStaged = null;     // { version, hash } armed in slot 1

/* the device card (firmware + clocks) collapses to one line. `systemChoice`
 * is the user's explicit open/closed choice, `systemApplied` what the page
 * last set (so the toggle event can tell our own change from a click), and
 * `systemAuto` the last "something needs attention" verdict. */
let systemChoice = null;
let systemApplied = false;
let systemAuto = false;

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

/* ---------- firmware capabilities ---------- */

/** A value label from the connected firmware's descriptor (end-of-tune
 *  modes, chip models, ...) - no hardcoded enum copies on this side. */
function label(set, value) {
  return sc.protocol ? sc.protocol.valueLabel(set, value) : String(value);
}

const supports = (feature) => sc.supports(feature);

/** Show only what the connected firmware can actually do, and say what is
 *  missing once instead of letting a button fail on every press. */
function applyCapabilities() {
  const live = supports('state');
  const transport = supports('transport');
  const subplay = supports('subplay');

  $('prev').hidden = !transport;
  $('play').hidden = !transport;
  $('next').hidden = !transport;
  $('subprev').hidden = !subplay;
  $('subnext').hidden = !subplay;
  $('subtune').hidden = !subplay;
  /* display-only badges decoded from the state value */
  $('chip').hidden = !live;
  $('engine').hidden = !live;
  $('snd').hidden = !live;
  $('ends').hidden = !supports('end_mode');
  $('volume').disabled = !supports('volume');
  document.querySelector('.volrow').hidden = !supports('volume');
  document.querySelector('.progress').hidden = !live;
  document.querySelector('.progressrow').hidden = !live;

  const missing = [];
  if (!live) missing.push('live player status');
  if (!transport) missing.push('play/pause and tune stepping');
  if (!subplay) missing.push('subtune selection');
  if (!supports('end_mode')) missing.push('end-of-tune mode');
  if (!supports('volume')) missing.push('volume control');
  if (!supports('md5_id')) missing.push('tune ids (exact HVSC match)');
  if (!supports('delete')) missing.push('deleting tunes');
  if (!supports('listing')) missing.push('the device library');

  /* the version itself lives in the device card; here only what the
   * connected firmware cannot do, once, instead of a button that fails */
  const line = $('fwline');
  line.textContent = missing.length
    ? `this firmware has no ${missing.join(', ')}` : '';
  line.hidden = !missing.length;

  $('systemcard').hidden = false;
  $('sysfw').textContent = `firmware ${sc.firmware || '--'}`;
  $('sysproto').textContent = sc.protocol
    ? `protocol ${sc.protocol.protocol} · ${sc.protocol.source === 'hello'
      ? 'hello characteristic' : 'legacy probe (approximate version)'}`
    : '';
  if (sc.notes.length) note(sc.notes.join(' · '));
  refreshControls();
  renderSystem();
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
    $('fwline').hidden = true;
    deviceBase = null;
    deviceTimeUnset = false;
    $('devtime').textContent = '--:--:--';
    $('devtime').classList.remove('warn');
    /* the device card disappears with the link; the next connect fills it
     * again from scratch (and decides by itself whether to open) */
    $('systemcard').hidden = true;
    $('systemcard').classList.remove('attention');
    $('systemcard').open = false;
    systemChoice = null;
    systemApplied = false;
    systemAuto = false;
    $('sysfw').textContent = 'firmware --';
    $('updstate').textContent = '';
    $('systime').textContent = '--:--:--';
    $('systime').classList.remove('warn');
    $('sysoff').textContent = '';
    $('sysproto').textContent = '';
    $('updtitle').textContent = '';
    $('updsub').textContent = '';
    $('updwhy').hidden = true;
    updatePlan = null;
    smp = null;
    library = null;
    deviceIds = new Set();
    deviceKeys = { exact: new Set(), short: new Set() };
    /* a firmware reboot drops the link on purpose: the reconnect loop owns
     * busy until it is done, so it must not be cleared here */
    if (busy !== 'reboot') busy = null;
    renderLibrary();
  }
  refreshControls();
}

/* Chrome on Android sits on the platform GATT client, which can reject the
 * CCC write on a fresh link and keep rejecting it on that client; BlueZ
 * (Chrome on Linux) tolerates the same sequence. A disconnect + connect
 * hands us a clean client - exactly what a manual Reconnect did in the
 * field - so do that once by itself instead of leaving the page without
 * pushed state. Returns null on success, the last error otherwise. */
async function startLiveUpdates() {
  try {
    await sc.startUpdates();
    return null;
  } catch (e) {
    console.warn('state subscribe failed', e);
  }
  recovering = true;
  try {
    await sc.disconnect();
    await sc.connect();
    await sc.startUpdates();
    return null;
  } catch (e) {
    console.warn('state subscribe still failing', e);
    return e;
  } finally {
    recovering = false;
  }
}

$('connect').addEventListener('click', async () => {
  if (sc.connected) {
    await sc.disconnect();
    setConnected(false);
    return;
  }
  const btn = $('connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  setStatus('connecting…', 'busy');
  try {
    const name = await sc.connect();
    await afterLink(name);
  } catch (e) {
    console.error(e);
    setConnected(false);
    note(errorText(e), true);
  } finally {
    btn.disabled = false;
  }
});

/** Everything that follows a new GATT link. Shared by the Connect button
 *  and the reconnect loop that waits out a firmware-update reboot. */
async function afterLink(name) {
  /* The GATT link is up: enable the controls now, before the setup
   * below. On a fresh Android connection a read or the CCC write can
   * fail transiently ("GATT operation failed") while the link is fine;
   * leaving the page half-connected used to make the next Connect
   * click disconnect it. */
  setConnected(true);
  setStatus(name, 'ok');
  applyCapabilities();
  lastGeneration = -1;

  const failed = await startLiveUpdates();
  if (failed) {
    console.error('state updates', failed);
    note(`live updates failed: ${errorText(failed)}`, true);
    if (!sc.connected) {
      /* the recovery reconnect failed: there is no link left */
      setConnected(false);
      return;
    }
  }
  try {
    await refreshInfo();
  } catch (e) {
    console.error('info', e);
    note(`tune info failed: ${errorText(e)}`, true);
  }
  await readClock();
  try {
    showVolume(await sc.readVolume());
  } catch (e) {
    console.error('volume', e);
  }
  await setupSmp();
  refreshControls();
  refreshLibrary();

  /* A link that died while the page was setting it up (typical right
   * after the device rebooted for an update) must not leave a green
   * "connected" page whose every press fails with "GATT Server is
   * disconnected". Report it so the connect button / reboot loop can
   * retry with a clean link. */
  if (!sc.connected || !sc.device || !sc.device.gatt.connected) {
    setConnected(false);
    throw new Error('the Bluetooth link dropped while connecting');
  }

  /* the update check and the staged-image probe are not on the critical
   * path of "the remote works now": run them after the controls are live */
  checkUpdate()
    .then(readStagedImage)
    .then(renderUpdate)
    .catch((e) => console.warn('update check', e));
}

sc.onDisconnect = () => {
  if (recovering) return; // our own recovery reconnect, not a lost link
  setConnected(false);
  /* a firmware reboot drops the link on purpose; waitForFirmware() is
   * already reporting the reboot */
  if (busy !== 'reboot') note('device disconnected');
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
  currentState = st;
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
  sel.disabled = st.songs <= 0 || !sc.connected || !supports('subplay');

  if (!st.degraded) {
    $('chip').textContent =
      `chip ${st.chip ? label('chip', st.chip) : '?'} · ${label('model_mode', st.modelMode)}`;
    $('engine').textContent = st.legacyEngine ? 'legacy engine'
      : st.splitEngine ? 'cRSID split (FLPR CPU)' : 'cRSID';
    $('snd').textContent = st.sound ? 'snd on' : 'muted';
    $('ends').textContent = `ends: ${label('end_mode', st.endMode)}`;
  }
  showVolume(st.volume);

  const pct = st.length > 0
    ? Math.min(100, (st.elapsed / st.length) * 100) : 0;
  $('progressbar').style.width = `${pct}%`;
  $('pos').textContent = fmtSeconds(st.elapsed);
  $('len').textContent = st.length > 0 ? fmtSeconds(st.length) : '--:--';

  updateTrackHighlight();
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

async function readInfoOnce() {
  const i = await sc.readInfo();
  if (!i) return;
  currentInfo = i;
  $('title').textContent = i.title || i.name || 'nothing loaded';
  const bits = [];
  if (i.author) bits.push(i.author);
  if (i.name) bits.push(i.name);
  $('subtitle').textContent = bits.join(' · ');
  renderMetadata().catch((e) => console.warn('hvsc info', e));
}

/** Read the info value, one read at a time. The connect flow and the
 *  first state notification both ask for it; overlapping GATT reads are
 *  what a fresh Android link rejects. */
function refreshInfo() {
  if (infoReading) {
    infoAgain = true;
    return infoReading;
  }
  infoReading = (async () => {
    do {
      infoAgain = false;
      await readInfoOnce();
    } while (infoAgain);
  })().finally(() => {
    infoReading = null;
  });
  return infoReading;
}

/* ---------- clocks: device vs. this browser ---------- */

function fmtClock(d) {
  return d.toTimeString().slice(0, 8);
}

/** Device epoch milliseconds from a Current Time value (local fields, like
 *  the device keeps them). The 1/256 s fraction is rounded to ms - the
 *  display still shows whole seconds, it just flips at the device's own
 *  second boundary instead of an arbitrary browser phase. */
function timeMs(t) {
  const d = new Date(t.year, t.month - 1, t.day,
                     t.hours, t.minutes, t.seconds);
  return d.getTime() + Math.round(((t.fraction || 0) * 1000) / 256);
}

function deviceNow() {
  if (!deviceBase) return null;
  return new Date(deviceBase.ms + (performance.now() - deviceBase.at));
}

function showTime(t) {
  if (!t || t.year < 2020) {
    deviceBase = null;
    deviceTimeUnset = true;
    tickClocks();
    return;
  }
  deviceTimeUnset = false;
  /* The value was sampled about half a round trip before it arrived, so
   * the device clock at `at` was that much further on. Without the
   * correction the page ran up to a second behind the device. */
  const at = (typeof t.at === 'number') ? t.at : performance.now();
  deviceBase = { ms: timeMs(t) + (t.rtt || 0) / 2, at };
  tickClocks();
}

let clockTimer = 0;

/** Offset between the device clock and the browser one, short enough for
 *  the collapsed line. Empty while they agree - the line is already full -
 *  and `+0.2 s` / `-64 s` when they do not. */
function fmtOffset(ms) {
  if (Math.abs(ms) < 200) return '';
  const sec = Math.abs(ms) / 1000;
  const text = sec < 10 ? sec.toFixed(1) : String(Math.round(sec));
  return `${ms < 0 ? '-' : '+'}${text} s`;
}

/* Repaint the clocks, then re-arm for just after the next second boundary
 * of the clock being displayed: the device's when it is known, so the
 * seconds flip together with the device's own panel instead of on an
 * arbitrary phase (which made one clock look a second ahead). */
function tickClocks() {
  clearTimeout(clockTimer);
  const now = new Date();
  $('hosttime').textContent = fmtClock(now);

  const dev = deviceNow();
  let wait;

  if (dev) {
    const devMs = dev.getTime();
    const offset = devMs - now.getTime();
    $('devtime').textContent = fmtClock(dev);
    // a second and a half of slack: the read is accurate to a few ms now,
    // so anything more is a real disagreement
    $('devtime').classList.toggle('warn', Math.abs(offset) > 1500);
    $('systime').textContent = fmtClock(dev);
    $('systime').classList.toggle('warn', Math.abs(offset) > 1500);
    $('sysoff').textContent = fmtOffset(offset);
    wait = 1000 - (((devMs % 1000) + 1000) % 1000) + 15;
  } else {
    $('devtime').textContent = deviceTimeUnset ? 'unset' : '--:--:--';
    $('devtime').classList.toggle('warn', deviceTimeUnset);
    $('systime').textContent = deviceTimeUnset ? 'clock unset' : '--:--:--';
    $('systime').classList.toggle('warn', deviceTimeUnset);
    $('sysoff').textContent = '';
    wait = 1000 - (performance.now() % 1000) + 15;
  }
  renderSystem();
  clockTimer = setTimeout(tickClocks, wait);
}

async function readClock() {
  try {
    showTime(await sc.readTime());
  } catch (e) {
    console.error('time', e);
  }
}

/* ---------- device card (firmware + clocks) ---------- */

/** Anything the collapsed line should not hide: a release to apply, an
 *  image already staged, a clock that was never set or is more than a
 *  minute off. */
function systemAttention() {
  if (!sc.connected) return false;
  if (updateStaged) return true;
  if (updatePlan && updatePlan.state === 'available') return true;
  if (deviceTimeUnset) return true;
  const dev = deviceNow();
  return !!dev && Math.abs(dev.getTime() - Date.now()) > 60000;
}

function setSystemOpen(open) {
  const card = $('systemcard');
  systemApplied = open;
  if (card.open !== open) card.open = open;
}

/** Keep the card open only while something needs doing (unless the user
 *  made a choice): a new attention state wins over a manual collapse, but
 *  a card the user opened stays open while that state is unchanged. */
function renderSystem() {
  const card = $('systemcard');
  if (!sc.connected) return;
  const attention = systemAttention();
  card.classList.toggle('attention', attention);
  if (attention !== systemAuto) {
    systemAuto = attention;
    systemChoice = null;
  }
  setSystemOpen(systemChoice === null ? attention : systemChoice);
}

$('systemcard').addEventListener('toggle', () => {
  const card = $('systemcard');
  if (card.open === systemApplied) return; // a renderSystem() open/close
  systemChoice = card.open;
  systemApplied = card.open;
});

/* ---------- hvsc: databases, search, upload, library, info ---------- */

const fmtBytes = (n) => (n >= 1024 * 1024
  ? `${(n / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(n / 1024))} KB`);

function throttled(fn, ms = 120) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

/** Button enable/disable for everything outside the transport row. */
function refreshControls() {
  const ready = sc.connected && !busy;
  $('search').disabled = !!busy;
  $('dbload').disabled = !!busy;
  $('stilopt').disabled = !!busy;
  $('librefresh').disabled = !ready;
  $('metastil').disabled = !!busy;
  const upd = sc.connected && !busy && smpReady();
  $('updinstall').disabled = !upd || !updatePlan ||
    updatePlan.state !== 'available';
  $('updreboot').disabled = !upd || !updateStaged;
  $('upddiscard').disabled = !upd || !updateStaged;
  $('updfile').disabled = !upd;
  for (const b of document.querySelectorAll('#results .tune button, ' +
                                           '#lib button')) {
    if (b.dataset.locked) {
      b.disabled = true;
    } else if (b.classList.contains('upload')) {
      b.disabled = !ready || !smpReady();
      b.title = smpReady() ? ''
        : (smp && smp.problem) || 'needs Bluetooth access in R/W mode';
    } else {
      b.disabled = !ready;
    }
  }
}

async function setupSmp() {
  /* A client left over from an earlier link keeps its listener on the
   * same GATT characteristic object (Chrome hands out the same one again
   * after a reconnect), so it must be stopped, not just dropped. */
  const prev = smp;
  smp = null;
  if (prev) {
    try {
      await prev.stop();
    } catch (e) { /* the link is going away anyway */ }
  }
  if (!sc.smp) return; // R/O or OFF: the SMP service is not registered
  try {
    const client = new SmpClient(sc.smp);
    /* set before start(): it reports the transport probe there */
    client.onLog = (m) => console.info(`smp: ${m}`);
    smp = await client.start();
  } catch (e) {
    console.warn('SMP setup failed', e);
    smp = null;
    return;
  }
  if (!smp.healthy) note(smp.problem, true);
}

/** True when SMP is subscribed *and* the device answered the transport
 *  probe - tune uploads and firmware updates need both. */
function smpReady() {
  return !!(smp && smp.healthy);
}

/* ---------- firmware update ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The firmware version the device reports. Hello carries the exact one;
 *  the legacy probe only identifies a descriptor, so its version is the
 *  best guess the page has. */
function runningFirmware() {
  if (sc.helloInfo && sc.helloInfo.firmware) return sc.helloInfo.firmware;
  return sc.firmware;
}

function setUpdateProgress(what, got, total) {
  const line = $('updprog');
  line.hidden = !what;
  if (!what) {
    $('updprogbar').style.width = '0%';
    $('updproglabel').textContent = '';
    return;
  }
  const pct = total > 0 ? Math.min(100, (got / total) * 100) : 0;
  $('updprogbar').style.width = `${pct}%`;
  $('updproglabel').textContent = total > 0
    ? `${what} ${fmtBytes(got)} / ${fmtBytes(total)}` : what;
}

/** Draw the firmware part of the device card. The summary line always
 *  carries the version and the state; the block below is always there when
 *  the card is open (a local build can be flashed even when the installed
 *  firmware is the latest release) and only fills with release details for
 *  an update, a staged image or an unusual state. */
function renderUpdate() {
  const plan = planUpdate({
    manifest: updateManifest,
    running: runningFirmware(),
    connected: sc.connected,
    smp: smpReady(),
  });
  updatePlan = plan;

  const state = $('updstate');
  const title = $('updtitle');
  const sub = $('updsub');
  const why = $('updwhy');
  const notes = $('updnotes');
  $('sysfw').textContent = sc.connected
    ? `firmware ${runningFirmware() || '--'}` : 'firmware --';
  $('updinstall').hidden = true;
  $('updreboot').hidden = true;
  $('upddiscard').hidden = true;
  notes.hidden = true;
  why.hidden = true;
  title.textContent = '';
  sub.textContent = '';

  if (!sc.connected) {
    state.textContent = '';
    refreshControls();
    renderSystem();
    return;
  }

  if (updateStaged) {
    state.textContent = 'staged';
    title.textContent = `firmware ${updateStaged.version} is staged`;
    sub.textContent = `the device keeps running ${runningFirmware()} until the ` +
      'next reboot, which is when MCUboot swaps it in';
    $('updreboot').hidden = false;
    $('upddiscard').hidden = false;
  } else if (plan.state === 'up-to-date') {
    state.textContent = 'up to date';
  } else if (plan.state === 'available') {
    state.textContent = 'update available';
    title.textContent = `update to ${plan.release.version}`;
    sub.textContent = `${fmtBytes(plan.release.size || 0)} · app firmware ` +
      'only - tunes, settings and the clock are not touched';
    $('updinstall').hidden = false;
    if (plan.release.page) {
      notes.href = plan.release.page;
      notes.hidden = false;
    }
  } else if (plan.state === 'ahead') {
    state.textContent = 'dev build';
    title.textContent = `development build ${runningFirmware()}`;
    sub.textContent = `the latest release is ${plan.release.version} - ` +
      'older than this device, so no update is offered';
  } else if (plan.state === 'unknown') {
    state.textContent = 'version unknown';
    title.textContent = 'firmware version unknown';
    sub.textContent = 'the device did not report its version - the latest ' +
      `release is ${plan.release.version}`;
  } else {
    /* no manifest: stay quiet rather than show a permanent "unknown" */
    state.textContent = '';
  }

  /* the local-build button is here in every state, so explain a dead SMP
   * link even when no release is offered */
  if (!smpReady()) {
    const what = updateStaged ? 'before rebooting'
      : plan.state === 'available' ? 'before updating' : 'before uploading';
    why.textContent = `${what}: ${smp && smp.problem
      ? smp.problem
      : 'the device must be in BLE R/W mode (its main screen says so)'}`;
    why.hidden = false;
  }

  /* a running update needs its progress and buttons even when the plan
   * says "up to date" (a local file chosen by hand), and it must be
   * visible even if the card was collapsed when the button was pressed */
  if (busy === 'firmware update' || busy === 'discard update' ||
      busy === 'reboot') {
    if (!title.textContent) title.textContent = 'firmware update';
    if (!sub.textContent) {
      sub.textContent = 'the device keeps running the current image until ' +
        'it reboots';
    }
    systemChoice = true;
    setSystemOpen(true);
  }

  refreshControls();
  renderSystem();
}

async function checkUpdate(fresh = false) {
  if (!sc.connected) {
    updateManifest = null;
    renderUpdate();
    return;
  }
  updateManifest = await loadManifest({ fresh });
  renderUpdate();
}

/** Slot 1's pending image, if one is already armed (e.g. staged by an
 *  earlier session or by tools/flash_ota.py). */
async function readStagedImage() {
  if (!smpReady()) return;
  try {
    const slots = await smp.imageState();
    const sec = slots.find((s) => s.slot === 1 && s.pending);
    updateStaged = sec ? { version: sec.version, hash: sec.hash } : null;
  } catch (e) {
    console.warn('image state', e);
  }
}

/** Verify, upload and arm one image (`source.release` from the manifest, or
 *  `source.file` from the local picker). The device keeps running the old
 *  image until the reboot button (or any other reset). */
async function installFirmware(source) {
  if (busy) return;
  if (!sc.connected) {
    note('connect to the device first', true);
    return;
  }
  if (!smpReady()) {
    note(smp && smp.problem
      ? smp.problem
      : 'firmware updates need Bluetooth access in R/W mode', true);
    return;
  }
  busy = 'firmware update';
  renderUpdate();
  refreshControls();

  try {
    let bytes;
    let info;
    if (source.file) {
      setUpdateProgress(`reading ${source.file.name}`, 0, 0);
      bytes = new Uint8Array(await source.file.arrayBuffer());
      const v = await verifyRelease(bytes, {});
      if (!v.ok) throw new Error(v.reason);
      info = v.info;
      if (cmpVersion(info.version, runningFirmware()) === 0) {
        note(`this file is the running version (${info.version}) - ` +
             'flashing it anyway');
      }
    } else {
      const release = source.release;
      setUpdateProgress('downloading firmware', 0, release.size || 0);
      bytes = await fetchRelease(release,
        throttled((got, total) =>
          setUpdateProgress('downloading firmware', got, total)));
      setUpdateProgress('verifying firmware', bytes.length, bytes.length);
      const v = await verifyRelease(bytes, release);
      if (!v.ok) throw new Error(v.reason);
      info = v.info;
    }

    setUpdateProgress('checking the device slots', 0, 0);
    const slots = await smp.imageState();
    const active = slots.find((s) => s.active) ||
      slots.find((s) => s.slot === 0);
    const secondary = slots.find((s) => s.slot === 1);
    if (active && active.hash === info.imageHash) {
      throw new Error(`the device already runs this image (${info.version})`);
    }
    if (secondary && secondary.hash === info.imageHash && secondary.pending) {
      updateStaged = { version: info.version, hash: info.imageHash };
      note(`firmware ${info.version} is already staged`);
      return;
    }

    /* an earlier attempt may have uploaded the image but failed before
     * arming it: reuse the slot instead of sending half a megabyte again */
    if (!secondary || secondary.hash !== info.imageHash) {
      setUpdateProgress('uploading firmware', 0, bytes.length);
      await smp.uploadImage(bytes, {
        sha: bytesOfHex(info.fileHash),
        onProgress: throttled((got, total) =>
          setUpdateProgress('uploading firmware', got, total)),
      });
    }

    setUpdateProgress('checking the uploaded image', 0, 0);
    const after = await smp.imageState();
    const slot1 = after.find((s) => s.slot === 1);
    if (!slot1 || slot1.hash !== info.imageHash) {
      throw new Error('the upload did not land in slot 1' +
        (slot1 && slot1.hash
          ? ` (the slot holds ${slot1.hash.slice(0, 16)}…)`
          : ' (the slot is empty)'));
    }

    setUpdateProgress('arming the update', 0, 0);
    await smp.armImage(info.imageHash);
    const armed = await smp.imageState();
    const check = armed.find((s) => s.slot === 1);
    if (!check || !check.pending) {
      throw new Error('the device did not mark the image as pending - ' +
        'a reset would boot the old image again');
    }
    updateStaged = { version: info.version, hash: info.imageHash };
    note(`firmware ${info.version} staged - it boots on the next reboot`);
  } catch (e) {
    console.error('firmware update', e);
    /* Arming the *running* image is refused; tools/flash_ota.py reports
     * the same case in one line instead of failing. */
    const activeDenied = e && e.name === 'SmpError' && e.err &&
      e.err.group === 1 && e.err.rc === 33;
    note(activeDenied
      ? 'that image is already the running one - nothing to apply'
      : commandError(e, 'firmware update'), true);
  } finally {
    setUpdateProgress(null);
    busy = null;
    refreshControls();
    renderUpdate();
  }
}

/** Apply the staged image: `os reset`, then wait for the swapped app. */
async function rebootForUpdate() {
  if (busy || !sc.connected || !smp) return;
  const target = updateStaged;
  if (!target) return;

  busy = 'reboot';
  $('connect').disabled = true;
  renderUpdate();
  refreshControls();
  setUpdateProgress('rebooting', 0, 0);
  try {
    await smp.reset();
  } catch (e) {
    console.warn('reset', e);
  }
  setStatus('rebooting…', 'busy');

  /* Drop the link ourselves. `os reset` reboots the device without a
   * clean disconnect, and the stack can keep the dead connection
   * "connected" for seconds: reconnecting into that window hands the
   * page a client that fails every operation. A manual Disconnect ->
   * Connect used to be the field workaround. */
  try {
    await sc.disconnect();
  } catch (e) {
    console.warn('disconnect for reboot', e);
  }

  const booted = await waitForFirmware(target);
  setUpdateProgress(null);
  busy = null;
  $('connect').disabled = false;
  refreshControls();
  renderUpdate();
  if (booted) {
    note(`firmware ${target.version} is running - the clock needs setting`);
  }
}

/** Poll the link until the new image answers (the swap takes a few
 *  seconds and the device does not advertise while MCUboot runs). */
async function waitForFirmware(target) {
  const deadline = Date.now() + 120000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    await sleep(attempt < 6 ? 1500 : 3000);
    try {
      if (smp) {
        try {
          await smp.stop();
        } catch (e) { /* the link is gone anyway */ }
      }
      /* Never reconnect into a link the browser still believes in: it
       * would be served from a stale GATT client. */
      await sc.disconnect();
      const epoch = sc.linkEpoch;
      const name = await sc.connect();
      await afterLink(name);
      if (!sc.connected || sc.linkEpoch === epoch) {
        /* the link died before the identity was read: try again */
        continue;
      }
      if (cmpVersion(runningFirmware(), target.version) >= 0) {
        updateStaged = null;
        return true;
      }
      /* the old image answered: either the swap never happened or
       * MCUboot reverted it */
      const slots = smpReady() ? await smp.imageState() : [];
      const sec = slots.find((s) => s.slot === 1);
      note(sec && sec.pending
        ? 'still on the old firmware with the update armed - reboot again'
        : 'the device came back on the old firmware and the new image ' +
          'is no longer pending: MCUboot reverted the test swap - check ' +
          'the boot log (tools/sidclock_ble.py log --peek)', true);
      return false;
    } catch (e) {
      console.info('waiting for the device', e.message || e);
      if (!sc.connected || !sc.device || !sc.device.gatt.connected) {
        setConnected(false);
      }
    }
  }
  note('the device did not come back with the new firmware within two ' +
       'minutes - reconnect and check its screen', true);
  return false;
}

async function discardUpdate() {
  if (busy || !smpReady()) return;
  busy = 'discard update';
  renderUpdate();
  refreshControls();
  try {
    await smp.eraseImage(1);
    updateStaged = null;
    note('staged firmware discarded (slot 1 erased)');
  } catch (e) {
    console.error('erase', e);
    note(commandError(e, 'discard update'), true);
  } finally {
    busy = null;
    refreshControls();
    renderUpdate();
  }
}

$('updinstall').addEventListener('click', () => {
  if (!updatePlan || updatePlan.state !== 'available') return;
  installFirmware({ release: updatePlan.release });
});
$('updreboot').addEventListener('click', rebootForUpdate);
$('upddiscard').addEventListener('click', discardUpdate);
$('updfile').addEventListener('click', () => $('updfileinput').click());
$('updfileinput').addEventListener('change', async () => {
  const file = $('updfileinput').files[0];
  $('updfileinput').value = '';
  if (file) await installFirmware({ file });
});

async function refreshDbState() {
  const st = await hvsc.dbStatus();
  $('dbstate').textContent = [
    st.songlengths ? `lengths ${fmtBytes(st.songlengths.bytes)}` : 'no lengths',
    st.stil ? `stil ${fmtBytes(st.stil.bytes)}` : 'no stil',
  ].join(' · ');
  $('dbload').textContent = (st.songlengths && st.stil)
    ? 'reload databases' : 'load databases';
}

/** Fetch whichever HVSC databases `which` asks for and are missing. */
async function loadDbs(which, onProgress) {
  const have = await hvsc.dbLoaded();
  if (which.songlengths && !have.songlengths) {
    await hvsc.loadSonglengths((got, total) =>
      onProgress('songlengths.md5', got, total));
  }
  if (which.stil && !have.stil) {
    await hvsc.loadStil((got, total) => onProgress('stil.txt', got, total));
  }
  await refreshDbState();
}

/* --- search --- */

/** Results drawn per "show more" click (large searches return thousands:
 *  the API has no paging parameters, so the page holds them all and
 *  renders in pages). */
const SEARCH_PAGE = 100;

let searchRaw = [];     // the API's match list, unfiltered
let searchResults = []; // after the field boxes
let searchShown = 0;    // rows currently in the list

const FIELD_NAMES = { title: 'name', author: 'author', released: 'released' };

function searchFields() {
  return hvsc.SEARCH_FIELDS.filter((f) => $(`f-${f}`).checked);
}

function searchFieldNames() {
  const sel = searchFields();
  return sel.length ? ` in ${sel.map((f) => FIELD_NAMES[f]).join('+')}` : '';
}

/** Names the boxes that are unticked, for the "nothing here" status. */
function searchFieldsOff() {
  const off = hvsc.SEARCH_FIELDS.filter((f) => !$(`f-${f}`).checked);
  return off.length ? ` - ${off.map((f) => FIELD_NAMES[f]).join('/')} is off` : '';
}

function applyFieldFilter() {
  searchResults = hvsc.filterSids(searchRaw, $('q').value.trim(),
                                  searchFields());
  renderResults();
}

async function doSearch() {
  const q = $('q').value.trim();
  if (!q || busy) return;
  $('hmsg').hidden = false;
  $('hmsg').textContent = 'searching…';
  $('more').hidden = true;
  try {
    searchRaw = await hvsc.searchSids(q);
    applyFieldFilter();
  } catch (e) {
    console.error(e);
    searchRaw = [];
    searchResults = [];
    renderResults();
    $('hmsg').textContent = `search failed: ${errorText(e)}`;
  }
}

function renderResults() {
  $('results').innerHTML = '';
  searchShown = 0;
  appendResults();
}

function appendResults() {
  const ul = $('results');
  const end = Math.min(searchResults.length, searchShown + SEARCH_PAGE);
  for (let i = searchShown; i < end; i++) ul.append(tuneRow(searchResults[i]));
  searchShown = end;
  ul.hidden = searchResults.length === 0;
  syncResultsOnDevice();
  updateSearchStatus();
  refreshControls();
}

/** Toggle the "on device" marker / upload button on every search row for
 *  the current /home listing (called on render and after a listing). */
function syncResultsOnDevice() {
  for (const li of $('results').children) {
    const on = deviceIds.has(li.dataset.id) ||
      hvsc.onDeviceByTitle(deviceKeys, li.dataset.title);
    li.querySelector('.ondevice').hidden = !on;
    li.querySelector('.upload').hidden = on;
  }
}

function updateSearchStatus() {
  const n = searchResults.length;
  const hidden = searchRaw.length - n;
  const from = hidden > 0 ? ` (${searchRaw.length} server matches)` : '';
  let text;
  if (!n) {
    text = searchRaw.length
      ? `no match${searchFieldNames()} (${searchRaw.length} server matches` +
        `${searchFieldsOff()})`
      : `no results for "${$('q').value.trim()}"`;
  } else {
    text = `${n} result${n === 1 ? '' : 's'}${searchFieldNames()}${from}`;
    if (searchShown < n) text += ` · showing ${searchShown}`;
  }
  $('hmsg').textContent = text;
  const left = n - searchShown;
  const more = $('more');
  more.hidden = left <= 0;
  more.textContent = `show ${Math.min(left, SEARCH_PAGE)} more (${left} left)`;
}

function tuneRow(res) {
  const li = document.createElement('li');
  li.className = 'tune';
  li.dataset.id = String(res.id);
  li.dataset.title = res.title || '';

  const name = document.createElement('div');
  name.className = 'tname';
  name.textContent = res.title || `SID ${res.id}`;

  const metaBase = [res.author, res.released].filter(Boolean).join(' · ');
  const meta = document.createElement('div');
  meta.className = 'tmeta';
  meta.textContent = metaBase;

  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('div');
  fill.className = 'bar';
  bar.append(fill);
  bar.hidden = true;

  const row = document.createElement('div');
  row.className = 'trow';
  const state = document.createElement('span');
  state.className = 'tstate';
  const ondev = document.createElement('span');
  ondev.className = 'ondevice';
  ondev.textContent = 'on device ✓';
  ondev.title = 'already in /home (uploaded from this browser, or the file name matches)';
  ondev.hidden = true;
  const upload = document.createElement('button');
  upload.type = 'button';
  upload.className = 'btn small upload';
  upload.textContent = 'upload';
  row.append(state, ondev, upload);
  li.append(name, meta, bar, row);

  const ui = {
    setState(text, cls = '') {
      state.textContent = text;
      state.className = `tstate ${cls}`;
    },
    metaNote(text) {
      meta.textContent = metaBase ? `${metaBase} · ${text}` : text;
    },
    progress(what, got, total) {
      bar.hidden = false;
      const pct = total > 0 ? Math.min(100, (got / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      this.setState(total > 0
        ? `${what} ${fmtBytes(got)} / ${fmtBytes(total)}` : what);
    },
    stop() {
      bar.hidden = true;
      fill.style.width = '0%';
    },
  };
  upload.addEventListener('click', () => uploadTune(res, ui));
  return li;
}

/* --- upload --- */

async function uploadTune(res, ui) {
  if (busy) return;
  if (!sc.connected) {
    note('connect to the device first', true);
    return;
  }
  if (!smpReady()) {
    note(smp && smp.problem
      ? smp.problem
      : 'uploads need Bluetooth access in R/W mode', true);
    return;
  }
  busy = `upload ${res.id}`;
  refreshControls();
  ui.setState('loading tune details…');
  let partial = null; // device name of a tune upload that may be incomplete
  try {
    const det = await hvsc.getSidDetails(res.id);
    if (!det || !det.filename) throw new Error('HVSC returned no file name');
    const name = hvsc.deviceNameFor(det.filename);
    const stem = name.replace(/\.sid$/i, '');
    const songs = det.numberOfSongs || 1;
    const path = det.filePath ? `${det.filePath}${det.filename}` : null;
    if (name !== det.filename) ui.metaNote(`device name: ${name}`);

    const bytes = await hvsc.downloadSid(res.id, throttled((got, total) =>
      ui.progress('downloading', got, total)));
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'PSID' && magic !== 'RSID') {
      throw new Error('not a PSID/RSID tune');
    }

    const wantStil = $('stilopt').checked;
    const have = await hvsc.dbLoaded();
    if (!have.songlengths || (wantStil && !have.stil)) {
      ui.setState('loading HVSC databases…');
      await loadDbs(
        { songlengths: !have.songlengths, stil: wantStil && !have.stil },
        throttled((what, got, total) =>
          ui.progress(`downloading ${what}`, got, total)));
    }
    const md5hex = hvsc.fileMd5(bytes);
    const lenText = await hvsc.makeLen(bytes, md5hex);
    const stilText = (wantStil && path)
      ? await hvsc.makeStil(path, songs) : null;

    partial = name; // from here on a failure can leave a half-written tune
    await smp.uploadFile(`/home/${name}`, bytes,
      throttled((got, total) => ui.progress('uploading tune', got, total)));
    partial = null; // the tune itself is on the device (verified by size)
    if (lenText) {
      await smp.uploadFile(`/home/${stem}.len`,
        new TextEncoder().encode(lenText),
        throttled((got, total) => ui.progress('uploading .len', got, total)));
    }
    if (stilText) {
      await smp.uploadFile(`/home/${stem}.stil`,
        new TextEncoder().encode(stilText),
        throttled((got, total) => ui.progress('uploading .stil', got, total)));
    }
    await smp.fileClose();
    await hvsc.rememberUpload(name,
      { file: det.filename, id: res.id, path, title: det.title, md5: md5hex });

    ui.stop();
    ui.setState(name === det.filename ? 'uploaded ✓'
      : `uploaded as ${name} ✓`, 'ok');
    note(`${name}: uploaded${lenText ? '' : ' - no .len (not in Songlengths)'}`);
    refreshLibrary();
  } catch (e) {
    console.error('upload', e);
    ui.stop();
    /* a failed upload leaves the first chunk on the device, and a tune
     * with a truncated file plays as silence: remove it so the library
     * never looks right while being wrong */
    let cleanup = '';
    if (partial) {
      try {
        await sc.deleteFile(partial);
        cleanup = ' (the partial file was removed)';
      } catch (e2) {
        cleanup = ` (check ${partial}: it may be incomplete)`;
      }
    }
    ui.setState(`failed: ${errorText(e)}`, 'err');
    note(errorText(e) + cleanup, true);
  } finally {
    busy = null;
    refreshControls();
  }
}

/* --- the device library --- */

async function refreshLibrary() {
  if (!sc.connected) {
    library = null;
    deviceIds = new Set();
    deviceKeys = { exact: new Set(), short: new Set() };
    renderLibrary();
    return;
  }
  try {
    library = new Set(await sc.listFiles());
    /* which HVSC tunes are already there: the upload map covers tunes
     * this browser put in /home (the id survives renaming), the name
     * keys cover everything else that is on the device */
    deviceIds = hvsc.uploadedIds(await hvsc.uploadMap(), library);
    deviceKeys = hvsc.deviceNameKeys(library);
    renderLibrary();
  } catch (e) {
    console.warn('listing failed', e);
    library = null;
    deviceIds = new Set();
    deviceKeys = { exact: new Set(), short: new Set() };
    renderLibrary(true);
  }
}

function renderLibrary(failed = false) {
  const ul = $('lib');
  ul.innerHTML = '';
  const nameMax = (sc.protocol && sc.protocol.limits.name_max) || 23;
  const deleteMax = (sc.protocol && sc.protocol.commandNameMax)
    ? sc.protocol.commandNameMax('delete') : nameMax;
  const sids = library
    ? [...library].filter((f) => /\.sid$/i.test(f))
        .sort((a, b) => a.localeCompare(b))
    : [];
  for (const name of sids) {
    const li = document.createElement('li');
    li.className = 'librow';
    const nm = document.createElement('span');
    nm.className = 'lname';
    nm.textContent = name;

    const side = document.createElement('span');
    side.className = 'lside';
    const stem = name.slice(0, -4);
    side.textContent = [library.has(`${stem}.len`) ? 'len' : '',
                        library.has(`${stem}.stil`) ? 'stil' : '']
      .filter(Boolean).join(' ');

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn small';
    play.textContent = 'play';
    if (name.length > nameMax) {
      play.dataset.locked = '1';
      play.title = 'name too long for the play command';
    } else {
      play.addEventListener('click', () => run(sc.playFile(name), 'play file'));
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small';
    del.textContent = '✕';
    if (name.length > deleteMax) {
      del.dataset.locked = '1';
      del.title = 'name too long for the delete command';
    } else {
      del.title = 'delete from the device (with sidecars)';
      del.addEventListener('click', () => deleteTune(name));
    }
    li.append(nm, side, play, del);
    ul.append(li);
  }
  ul.hidden = sids.length === 0;
  $('libinfo').textContent = failed ? 'needs R/W mode'
    : library ? `${sids.length} tune${sids.length === 1 ? '' : 's'}`
    : sc.connected ? 'not listed' : 'not connected';
  syncResultsOnDevice();
  refreshControls();
}

async function deleteTune(name) {
  if (busy) return;
  if (!window.confirm(`Delete ${name} from the device?`)) return;
  busy = `delete ${name}`;
  refreshControls();
  try {
    const missing = await sc.deleteFile(name);
    note(`${name} deleted${missing.length
      ? ` (could not remove ${missing.join(', ')})` : ''}`);
  } catch (e) {
    console.error(e);
    note(commandError(e, 'delete'), true);
  } finally {
    busy = null;
    refreshControls();
    refreshLibrary();
  }
}

/* --- HVSC info for the tune the device is playing --- */

function updateTrackHighlight() {
  const sub = currentState ? currentState.subtune + 1 : 0;
  for (const li of $('tracks').children) {
    const b = li.firstElementChild;
    if (b) b.classList.toggle('cur', Number(b.dataset.sub) === sub);
  }
}

function trackCount(info) {
  let n = currentState && currentState.songs > 0 ? currentState.songs : 0;
  if (info.lengths) n = Math.max(n, info.lengths.length);
  for (const k of Object.keys(info.names || {})) {
    const i = Number(k);
    if (Number.isFinite(i)) n = Math.max(n, i);
  }
  return n;
}

function renderTracks(info) {
  const ol = $('tracks');
  ol.innerHTML = '';
  const songs = trackCount(info);
  for (let i = 1; i <= songs; i++) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'track';
    b.dataset.sub = String(i);
    const n = document.createElement('span');
    n.className = 'tn';
    n.textContent = String(i);
    const t = document.createElement('span');
    t.className = 'tt';
    t.textContent = hvsc.stripTimeRange(info.names[i] || '') ||
      `subsong ${i}`;
    const d = document.createElement('span');
    d.className = 'td';
    const len = info.lengths ? info.lengths[i - 1] : 0;
    d.textContent = len ? fmtSeconds(len) : '';
    b.append(n, t, d);
    if (supports('subplay')) {
      b.addEventListener('click', () => run(sc.playSubtune(i), 'play subtune'));
    } else {
      b.disabled = true;
      b.title = `subtune selection needs a newer firmware ` +
        `(connected: ${sc.firmware})`;
    }
    li.append(b);
    ol.append(li);
  }
  updateTrackHighlight();
}

/** One-line provenance of an HVSC match (shown as the path's tooltip;
 *  an ambiguous name match also gets a visible marker - see below). */
function metaSource(info) {
  if (info.source === 'md5') return 'matched by the tune file md5';
  if (info.source === 'upload') return 'matched by the upload record';
  if (info.source === 'name') {
    return info.candidates > 1
      ? `matched by file name only - ${info.candidates} HVSC files share it`
      : 'matched by file name';
  }
  return '';
}

async function renderMetadata(force = false) {
  const card = $('hvscinfo');
  const name = currentInfo ? currentInfo.name : '';
  const id = currentInfo && currentInfo.id ? currentInfo.id : '';
  const have = await hvsc.dbLoaded();
  if (!name || (!have.songlengths && !have.stil)) {
    card.hidden = true;
    metaKey = '';
    return;
  }
  const key = [name, id, currentState ? currentState.songs : 0,
               have.songlengths, have.stil].join('|');
  if (!force && key === metaKey) {
    updateTrackHighlight();
    return;
  }
  metaKey = key;

  let info = null;
  try {
    info = await hvsc.tuneInfo(name, id || null);
  } catch (e) {
    console.warn('tune info', e);
  }
  card.hidden = false;
  const hint = $('metahint');
  const stilBtn = $('metastil');
  const meta = $('metapath');
  meta.textContent = info && info.path ? info.path : '';
  meta.title = info ? metaSource(info) : '';
  if (info && info.source === 'name' && info.candidates > 1) {
    // several HVSC files share this name and the device gave no md5: the
    // metadata may belong to another one, so say so instead of guessing
    meta.textContent = info.path
      ? `name match of ${info.candidates} · ${info.path}`
      : `name match of ${info.candidates}`;
  }
  if (!info) {
    $('tracks').innerHTML = '';
    $('metanote').hidden = true;
    $('metacomment').hidden = true;
    hint.hidden = false;
    $('metahinttext').textContent = have.stil
      ? `no HVSC entry for ${name}`
      : `no HVSC entry for ${name} yet - STIL.txt is not loaded`;
    stilBtn.hidden = have.stil;
    return;
  }
  renderTracks(info);

  const sub = currentState ? currentState.subtune + 1 : 0;
  const noteText = sub > 0 && info.subs ? info.subs[sub] || '' : '';
  $('metanote').textContent = noteText ? `subsong ${sub}: ${noteText}` : '';
  $('metanote').hidden = !noteText;
  $('metacomment').textContent = info.comment || '';
  $('metacomment').hidden = !info.comment;

  const wantStil = !have.stil;
  hint.hidden = !wantStil;
  $('metahinttext').textContent = wantStil
    ? 'subsong names and notes come from STIL.txt' : '';
  stilBtn.hidden = !wantStil;
}

/* --- database / search / library action wiring --- */

async function loadDbsFromCard(which, label) {
  if (busy) return;
  busy = `load ${label}`;
  refreshControls();
  $('hprog').hidden = false;
  const onP = throttled((source, got, total) => {
    const pct = total > 0 ? Math.min(100, (got / total) * 100) : 0;
    $('hprogbar').style.width = `${pct}%`;
    $('hproglabel').textContent = total > 0
      ? `downloading ${source} ${fmtBytes(got)} / ${fmtBytes(total)}`
      : `downloading ${source}`;
  });
  try {
    await loadDbs(which, onP);
    note(`${label} cached`);
    await renderMetadata(true);
  } catch (e) {
    console.error(e);
    note(`${label} download failed: ${errorText(e)}`, true);
  } finally {
    busy = null;
    refreshControls();
    $('hprog').hidden = true;
    $('hprogbar').style.width = '0%';
    $('hproglabel').textContent = '';
  }
}

$('search').addEventListener('click', doSearch);
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
$('more').addEventListener('click', appendResults);
/* the field boxes re-filter the list already fetched - no new search */
for (const f of hvsc.SEARCH_FIELDS) {
  $(`f-${f}`).addEventListener('change', () => {
    if (searchRaw.length) applyFieldFilter();
  });
}
$('dbload').addEventListener('click', () =>
  loadDbsFromCard({ songlengths: true, stil: true }, 'HVSC databases'));
$('metastil').addEventListener('click', () =>
  loadDbsFromCard({ stil: true }, 'STIL.txt'));
$('librefresh').addEventListener('click', () => refreshLibrary());

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

/* ---------- volume ---------- */

function fmtVolume(v) {
  return `${Math.round(v * 100 / 255)}%`;
}

/* The device pushes its volume back in the player state; a drag would fight
 * that, so ignore pushes while the pointer is on the slider. */
function showVolume(v) {
  if (v == null || volDragging) return;
  const el = $('volume');
  if (Number(el.value) !== v) el.value = String(v);
  $('volpct').textContent = fmtVolume(v);
}

/* A drag produces far more values than the link can carry, so send the
 * latest one and drop the rest: one write in flight at a time, and a value
 * that arrives while it runs replaces the queued one. */
let volSending = false;
let volNext = null;

async function pushVolume(v) {
  if (volSending) {
    volNext = v;
    return;
  }
  volSending = true;
  try {
    await sc.setVolume(v);
  } catch (e) {
    note(commandError(e, 'volume'), true);
  } finally {
    volSending = false;
    if (volNext != null) {
      const next = volNext;
      volNext = null;
      pushVolume(next);
    }
  }
}

const sendVolume = throttled((v) => { pushVolume(v); }, 80);

$('volume').addEventListener('pointerdown', () => {
  volDragging = true;
});
window.addEventListener('pointerup', () => {
  volDragging = false;
});
window.addEventListener('pointercancel', () => {
  volDragging = false;
});

$('volume').addEventListener('input', () => {
  const v = Number($('volume').value);
  $('volpct').textContent = fmtVolume(v);
  sendVolume(v);
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

/* the end-mode badge cycles: next sub -> next tune -> loop. The device
 * pushes the new state, which updates the label. */
$('ends').addEventListener('click', () => {
  if (!sc.connected || !currentState || !supports('end_mode')) return;
  const modes = sc.protocol.valueItems('end_mode').length || 3;
  run(sc.setEndMode((currentState.endMode + 1) % modes), 'end mode');
});

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
refreshDbState().catch((e) => console.warn('db state', e));

if (!SidClock.available) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
} else {
  setConnected(false);
}
