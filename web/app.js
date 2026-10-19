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
import { SmpClient } from './smp.js';
import * as hvsc from './hvsc.js';

const $ = (id) => document.getElementById(id);
const sc = new SidClock();

const CONTROLS = ['prev', 'play', 'next', 'stop', 'subprev', 'subnext',
                  'subtune', 'settime'];

let lastGeneration = -1;
let noteTimer = null;
let deviceBase = null;       // { time, at } of the last device clock read
let deviceTimeUnset = false; // the device answered "unset" (fresh reset)
let currentInfo = null;      // last info read (title / name / author)
let currentState = null;     // last pushed player state
let smp = null;              // SMP client while connected in R/W mode
let library = null;          // names in /home, or null when unknown
let busy = null;             // what long operation is running, if any
let metaKey = '';            // what the HVSC info card currently shows

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
    smp = null;
    library = null;
    busy = null;
    renderLibrary();
  }
  refreshControls();
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
    await setupSmp();
    refreshControls();
    refreshLibrary();
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

async function refreshInfo() {
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
  for (const b of document.querySelectorAll('#results .tune button, ' +
                                           '#lib button')) {
    if (b.dataset.locked) {
      b.disabled = true;
    } else if (b.classList.contains('upload')) {
      b.disabled = !ready || !smp;
      b.title = smp ? '' : 'needs Bluetooth access in R/W mode';
    } else {
      b.disabled = !ready;
    }
  }
}

async function setupSmp() {
  smp = null;
  if (!sc.smp) return; // R/O or OFF: the SMP service is not registered
  try {
    const client = new SmpClient(sc.smp);
    /* set before start(): it reports a failed parameters read there */
    client.onLog = (m) => console.info(`smp: ${m}`);
    smp = await client.start();
  } catch (e) {
    console.warn('SMP setup failed', e);
    smp = null;
  }
}

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
  updateSearchStatus();
  refreshControls();
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
  const upload = document.createElement('button');
  upload.type = 'button';
  upload.className = 'btn small upload';
  upload.textContent = 'upload';
  row.append(state, upload);
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
  if (!smp) {
    note('uploads need Bluetooth access in R/W mode', true);
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
    const lenText = await hvsc.makeLen(bytes);
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
      { file: det.filename, id: res.id, path, title: det.title });

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
    renderLibrary();
    return;
  }
  try {
    library = new Set(await sc.listFiles());
    renderLibrary();
  } catch (e) {
    console.warn('listing failed', e);
    library = null;
    renderLibrary(true);
  }
}

function renderLibrary(failed = false) {
  const ul = $('lib');
  ul.innerHTML = '';
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
    if (name.length > 20) {
      play.dataset.locked = '1';
      play.title = 'name too long for the play command';
    } else {
      play.addEventListener('click', () => run(sc.playFile(name), 'play file'));
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small';
    del.textContent = '✕';
    if (name.length > 20) {
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
  refreshControls();
}

async function deleteTune(name) {
  if (busy) return;
  if (!window.confirm(`Delete ${name} from the device?`)) return;
  busy = `delete ${name}`;
  refreshControls();
  try {
    const missing = await sc.deleteFile(name);
    note(`${name} deleted${missing.length ? ' (sidecars were missing)' : ''}`);
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
    b.addEventListener('click', () => run(sc.playSubtune(i), 'play subtune'));
    li.append(b);
    ol.append(li);
  }
  updateTrackHighlight();
}

async function renderMetadata(force = false) {
  const card = $('hvscinfo');
  const name = currentInfo ? currentInfo.name : '';
  const have = await hvsc.dbLoaded();
  if (!name || (!have.songlengths && !have.stil)) {
    card.hidden = true;
    metaKey = '';
    return;
  }
  const key = [name, currentState ? currentState.songs : 0,
               have.songlengths, have.stil].join('|');
  if (!force && key === metaKey) {
    updateTrackHighlight();
    return;
  }
  metaKey = key;

  let info = null;
  try {
    info = await hvsc.tuneInfo(name);
  } catch (e) {
    console.warn('tune info', e);
  }
  card.hidden = false;
  const hint = $('metahint');
  const stilBtn = $('metastil');
  $('metapath').textContent = info && info.path ? info.path : '';
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
refreshDbState().catch((e) => console.warn('db state', e));

if (!SidClock.available) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
} else {
  setConnected(false);
}
