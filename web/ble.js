/*
 * SidClock Web Bluetooth client: connection + protocol only, no DOM.
 *
 * Every UUID, offset, opcode and value on the wire comes from the protocol
 * descriptor of the firmware that is actually connected (see protocol.js).
 * `protocol/current.json` is the single source of truth; older descriptors
 * are frozen per release, so an old device keeps working even after the
 * page is updated. Short version of the current layout:
 *
 *   service  73696463-6c6f-4b01-9c1d-77ce3f41a5c0
 *     dbg    73696463-6c6f-4b02-...  read+write  snapshot / commands (1.0.7+)
 *     state  73696463-6c6f-4b03-...  read+notify player state (1.0.9+)
 *     info   73696463-6c6f-4b04-...  read        title/name/author/id (1.0.9+)
 *     hello  73696463-6c6f-4b05-...  read        protocol/layout/caps (new)
 *
 * Commands are one opcode byte plus arguments, written to the debug
 * characteristic (play/pause, tune and subtune steps, sub play, file play,
 * end mode, stop, listing page, delete...). Feature names below match the
 * `features` list in the descriptors and the capability bits in
 * protocol/caps.json; `supports()` is the only check the UI needs.
 *
 * The device runs player commands in its main loop, so a command is
 * accepted immediately but takes effect a moment later - the state
 * notification is the acknowledgement. Firmware without the state
 * characteristic (1.0.7) gets a degraded mode: the page polls the debug
 * snapshot instead, and the controls that need the state are disabled.
 *
 * File transfers use mcumgr SMP (see smp.js) on the standard SMP
 * characteristic; the device unregisters that service unless Bluetooth
 * access is R/W.
 */

import { SMP_SERVICE, SMP_CHARACTERISTIC } from './smp.js';
import {
  Protocol, select, parseHello, DEBUG_UUID, STATE_UUID, INFO_UUID,
  HELLO_UUID,
} from './protocol.js';

export { DEBUG_UUID as DBG_CHAR, STATE_UUID as STATE_CHAR, INFO_UUID as INFO_CHAR };

export const SIDCLOCK_SERVICE = '73696463-6c6f-4b01-9c1d-77ce3f41a5c0';

const u32 = (b, o) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function bytesOf(view) {
  if (view instanceof Uint8Array) return view;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Decode the player state value with `protocol` (a Protocol instance). */
export function parseState(view, protocol) {
  const b = bytesOf(view);
  const p = protocol;
  if (!p || !p.hasField('state', 'flags')) return null;
  if (b.length < (p.charSize('state') || 16)) return null;
  const f = p.flags('state');
  const flags = p.int(b, 'state', 'flags') || 0;
  return {
    playing: !!(flags & (f.playing || 0x01)),
    paused: !!(flags & (f.paused || 0x02)),
    sound: !!(flags & (f.sound || 0x04)),
    legacyEngine: !!(flags & (f.legacy_engine || 0x08)),
    splitEngine: !!(flags & (f.split_engine || 0x20)),
    subtune: p.int(b, 'state', 'subtune') || 0, // 0-based; +1 to display
    songs: p.int(b, 'state', 'songs') || 0,
    endMode: p.int(b, 'state', 'end_mode') || 0,
    modelMode: p.int(b, 'state', 'model_mode') || 0,
    chip: p.int(b, 'state', 'chip') || 0,
    generation: p.int(b, 'state', 'generation') || 0,
    volume: p.int(b, 'state', 'volume'),
    elapsed: p.int(b, 'state', 'elapsed') || 0,
    length: p.int(b, 'state', 'length') || 0,
  };
}

/** Decode the info value: title|name|author, plus the tune id when the
 *  firmware sends it (the first 4 bytes of the loaded file's whole-file MD5
 *  as 8 lowercase hex characters, the key HVSC's Songlengths.md5 uses;
 *  null means "unknown"). */
export function parseInfo(view, protocol) {
  const b = bytesOf(view);
  const p = protocol;
  if (!p || !p.hasChar('info')) return null;
  const title = p.text(b, 'info', 'title');
  const name = p.text(b, 'info', 'name');
  const author = p.text(b, 'info', 'author');
  if (!title && !name && !author) return null;
  const info = { title, name, author, id: null };
  if (p.hasField('info', 'md5_id')) {
    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += String.fromCharCode(b[p.offset('info', 'md5_id') + i] || 0);
    }
    hex = hex.toLowerCase();
    if (/^[0-9a-f]{8}$/.test(hex) && hex !== '00000000') info.id = hex;
  }
  return info;
}

/** Decode the 10-byte Current Time value. `fraction` is the sub-second part
 *  in 1/256 s (the device fills it; many hosts leave it at zero), and
 *  readTime() adds `at`/`rtt` so the caller can place the device's seconds
 *  on the local timeline. */
export function parseTime(view) {
  const b = bytesOf(view);
  if (b.length < 10) return null;
  return {
    year: b[0] | (b[1] << 8),
    month: b[2],
    day: b[3],
    hours: b[4],
    minutes: b[5],
    seconds: b[6],
    dow: b[7],
    fraction: b[8],
  };
}

/** The 10-byte Current Time value for a JS Date (local fields, like the
 *  device keeps them - there is no RTC and no timezone on the wire). The
 *  fraction byte carries the milliseconds so a set keeps sub-second
 *  precision instead of snapping to the whole second. */
export function timePayload(d = new Date()) {
  const dow = ((d.getDay() + 6) % 7) + 1; // Monday = 1
  /* 256 steps per second; clamp - rounding 999 ms gives 256, which would
   * wrap to 0 and put the clock a second behind */
  const frac = Math.min(255, Math.round((d.getMilliseconds() * 256) / 1000));
  return new Uint8Array([
    d.getFullYear() & 0xff,
    (d.getFullYear() >> 8) & 0xff,
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    dow,
    frac,
    0,
  ]);
}

/** Standard services the page also uses (optional - a page still works
 *  without them). */
const BATTERY_SERVICE = 0x180f;
const BATTERY_LEVEL_CHAR = 0x2a19;
const CTS_SERVICE = 0x1805;
const CTS_CHAR = 0x2a2b;

export class SidClock {
  constructor() {
    this.device = null;
    this.server = null;
    this.connected = false;
    this._connecting = null;
    /* bumped by every successful `_open()`: the update reconnect loop uses
     * it to be sure the identity it reads belongs to the new link */
    this.linkEpoch = 0;
    this._stateChar = null;
    this._stateHandler = null;
    this._batteryChar = null;
    this._batteryHandler = null;
    this._pollTimer = null;
    this._lastSnapshotState = null;
    this.protocol = null;   // Protocol of the connected firmware
    this.firmware = null;
    this.notes = [];        // how the descriptor was selected (for the UI)
    this._loadedName = '';  // last file this page played (no info char)
    this.onState = () => {};
    this.onInfo = () => {};
    this.onBattery = () => {};
    this.onDisconnect = () => {};
  }

  static get available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  /** True when the connected firmware offers `feature` (a name from the
   *  descriptor's `features` list, e.g. 'state', 'volume', 'end_mode'). */
  supports(feature) {
    return !!(this.protocol && this.protocol.has(feature));
  }

  /** Open (or re-open) the device. Shows the browser's picker on the
   *  first call, reconnects silently afterwards. */
  connect() {
    /* A double click or a retry while the first attempt is still in
     * progress must not start a second gatt.connect() - the loser of that
     * race comes back as "connected to another app". */
    if (!this._connecting) {
      this._connecting = this._open().finally(() => {
        this._connecting = null;
      });
    }
    return this._connecting;
  }

  async _open() {
    this.connected = false;
    if (!this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        // The device advertises flags + name only, so the name is the
        // filter; services have to be declared as optional.
        filters: [{ namePrefix: 'SidClock' }],
        optionalServices: [
          SIDCLOCK_SERVICE,
          SMP_SERVICE,
          BATTERY_SERVICE,
          CTS_SERVICE,
        ],
      });
      this.device.addEventListener('gattserverdisconnected', () => {
        this.connected = false;
        this._stopPolling();
        this.onDisconnect();
      });
    }
    this.server = await this._connectGatt();

    const svc = await this._service(SIDCLOCK_SERVICE);
    this.dbg = await this._retryGatt(() => svc.getCharacteristic(DEBUG_UUID));
    /* 1.0.7 has neither state nor info; 1.0.11 added hello. Missing ones
     * are simply null - the descriptor says what the firmware can do. */
    this.state = await this._optionalChar(svc, STATE_UUID);
    this.info = await this._optionalChar(svc, INFO_UUID);
    this.hello = await this._optionalChar(svc, HELLO_UUID);

    this.battery = await this._optional(BATTERY_SERVICE, BATTERY_LEVEL_CHAR);
    this.cts = await this._optional(CTS_SERVICE, CTS_CHAR);
    // SMP is only registered in R/W mode; without it, no file transfers
    this.smp = await this._optional(SMP_SERVICE, SMP_CHARACTERISTIC, true);

    await this._selectProtocol();
    /* The descriptor reads above can be served by a link that the device
     * has already dropped (a reboot tears the connection down without a
     * clean disconnect): do not mark that zombie as a working link. */
    if (!this.device.gatt.connected) {
      throw new DOMException('the link dropped while connecting',
                             'NetworkError');
    }
    this.connected = true;
    this.linkEpoch++;
    return this.device.name || 'SidClock';
  }

  /** Pick the descriptor this firmware speaks: hello when it has one,
   *  otherwise the legacy probe (which characteristics exist + the debug
   *  value size). Throws when neither identifies the device. */
  async _selectProtocol() {
    const present = ['debug'];
    if (this.state) present.push('state');
    if (this.info) present.push('info');
    if (this.hello) present.push('hello');

    let helloBytes = null;
    if (this.hello) {
      try {
        helloBytes = bytesOf(await this._read(this.hello));
      } catch (e) {
        /* a flaky first read must not look like "no hello": fall through
         * to the legacy probe, which still identifies the layout */
        console.warn('hello read failed', e);
      }
    }
    let debugSize = null;
    if (!helloBytes) {
      try {
        debugSize = bytesOf(await this._read(this.dbg)).length;
      } catch (e) {
        /* The debug value length is what separates 1.0.9 (140) from
         * 1.0.10 (160) once hello is gone, and Chrome on Android likes
         * to fail the first operation of a fresh link ("GATT operation
         * failed for unknown reason"): one more try after the queue
         * settles, instead of guessing the newer firmware. */
        console.warn('debug size read failed; retrying once', e);
        try {
          await new Promise((resolve) => setTimeout(resolve, 500));
          debugSize = bytesOf(await this._read(this.dbg)).length;
        } catch (again) {
          console.warn('debug size still unreadable - the firmware ' +
                       'version is a guess', again);
        }
      }
    }
    /* A hello characteristic whose value could not be read says nothing
     * about the layout; drop it so the legacy probe can still identify the
     * device by the other characteristics. */
    const probe = helloBytes ? present
      : present.filter((name) => name !== 'hello');
    const p = await select({ helloBytes, present: probe, debugSize });
    if (!p) {
      throw new Error('unrecognised SidClock firmware layout ' +
        `(characteristics: ${probe.join(', ')}, debug ` +
        `${debugSize == null ? '?' : debugSize} bytes) - this page is too old ` +
        'for the device');
    }
    this.protocol = p;
    this.firmware = p.firmware;
    this.notes = p.notes;
    this.helloInfo = helloBytes ? parseHello(helloBytes) : null;
    return p;
  }

  /** Connect the GATT link, retrying a failed attempt once: right after
   *  a page reload the previous page's link can still be up, and Android
   *  answers the new connect with "connected to another app" until the
   *  stack has dropped it. */
  async _connectGatt() {
    try {
      return await this.device.gatt.connect();
    } catch (e) {
      if (e.name !== 'NetworkError' && e.name !== 'InvalidStateError') throw e;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return this.device.gatt.connect();
    }
  }

  /** One retry for a GATT operation that failed while the link is up.
   *  Chrome on Android sometimes rejects the first operation on a fresh
   *  connection ("GATT operation failed") even though it is fine; the
   *  retry after the queue settles is enough. A real disconnect fails
   *  the retry too. */
  async _retryGatt(fn, delayMs = 250) {
    try {
      return await fn();
    } catch (e) {
      if (!this.device || !this.device.gatt.connected) throw e;
      if (e.name !== 'NetworkError' && e.name !== 'InvalidStateError') throw e;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return fn();
    }
  }

  _read(char) {
    return this._retryGatt(() => char.readValue(), 200);
  }

  /** Look up a service, retrying once when the link is fresh: Chrome on
   *  Android has answered "No Services matching UUID ... found in
   *  Device" for the SidClock service right after gatt.connect() while
   *  the service table was still filling in. */
  async _service(uuid) {
    try {
      return await this._retryGatt(() => this.server.getPrimaryService(uuid));
    } catch (e) {
      if (e.name !== 'NotFoundError' || !this.device ||
          !this.device.gatt.connected) throw e;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return this.server.getPrimaryService(uuid);
    }
  }

  /** Subscribe to notifications, retrying the CCC write once for the
   *  same reason as _read(). */
  _subscribe(char) {
    return this._retryGatt(() => char.startNotifications());
  }

  async _optional(service, characteristic, retryNotFound = false) {
    try {
      const s = retryNotFound
        ? await this._service(service)
        : await this._retryGatt(() => this.server.getPrimaryService(service));
      return await this._retryGatt(() => s.getCharacteristic(characteristic));
    } catch (e) {
      return null; // service not present: the rest still works
    }
  }

  async _optionalChar(service, uuid) {
    try {
      return await this._retryGatt(() => service.getCharacteristic(uuid));
    } catch (e) {
      return null; // firmware predates this characteristic
    }
  }

  /** Start pushing player state to `onState`.
   *
   *  With the state characteristic (1.0.9+): no initial read - the device
   *  forces a notification as soon as the CCC is written (player_state_dirty
   *  in the firmware), and a read issued before that CCC write is what made
   *  a fresh Android connection fail. Without it (1.0.7), poll the debug
   *  snapshot instead and synthesize the fields it does not carry. */
  async startUpdates() {
    if (this._stateChar && this._stateHandler) {
      this._stateChar.removeEventListener('characteristicvaluechanged',
                                          this._stateHandler);
    }
    if (this.battery) {
      if (this._batteryChar && this._batteryHandler) {
        this._batteryChar.removeEventListener('characteristicvaluechanged',
                                              this._batteryHandler);
      }
      this._batteryChar = this.battery;
      this._batteryHandler = (e) => this.onBattery(e.target.value.getUint8(0));
      this.battery.addEventListener('characteristicvaluechanged',
                                    this._batteryHandler);
      try {
        await this._subscribe(this.battery);
      } catch (e) {
        /* notifications unsupported: fall back to a one-shot read */
      }
      try {
        this.onBattery((await this._read(this.battery)).getUint8(0));
      } catch (e) {}
    }

    if (this.state) {
      this._stateChar = this.state;
      this._stateHandler = (e) => {
        const st = parseState(e.target.value, this.protocol);
        if (st) this.onState(st);
      };
      this.state.addEventListener('characteristicvaluechanged',
                                  this._stateHandler);
      await this._subscribe(this.state);
      return;
    }

    /* degraded mode: no pushed state, poll the snapshot */
    this._stopPolling();
    const tick = async () => {
      try {
        const st = this._snapshotState(await this.readSnapshot());
        if (st) this.onState(st);
      } catch (e) {
        console.warn('snapshot poll failed', e);
      }
    };
    await tick();
    this._pollTimer = setInterval(tick, 2000);
  }

  _stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  /** The subset of the player state the debug snapshot carries (1.0.7). */
  _snapshotState(raw) {
    const p = this.protocol;
    if (!p || !p.hasField('snapshot', 'sid_playing')) return null;
    const playing = p.int(raw, 'snapshot', 'sid_playing') || 0;
    const songs = p.int(raw, 'snapshot', 'sid_songs') || 0;
    const title = p.text(raw, 'snapshot', 'sid_title');
    const volume = p.int(raw, 'snapshot', 'audio_volume');
    const gen = `${playing}|${songs}|${title}`;
    const changed = !this._lastSnapshotState ||
      this._lastSnapshotState.generation !== gen;
    this._lastSnapshotState = {
      degraded: true,
      playing: !!playing,
      paused: false,
      sound: true,
      legacyEngine: false,
      splitEngine: false,
      subtune: 0,
      songs,
      endMode: 0,
      modelMode: 0,
      chip: 0,
      volume,
      elapsed: 0,
      length: 0,
      generation: gen,
    };
    /* the title is the only tune string an old firmware exposes */
    if (changed && this.lastTitle !== title) {
      this.lastTitle = title;
      this.onInfo({ title, name: this._loadedName, author: '', id: null });
    }
    return this._lastSnapshotState;
  }

  async readInfo() {
    if (!this.info || !this.protocol.hasChar('info')) {
      /* 1.0.7: only the title in the snapshot, and only the name this page
       * played (the device never sends a file name) */
      const raw = await this.readSnapshot();
      return {
        title: this.protocol.text(raw, 'snapshot', 'sid_title'),
        name: this._loadedName,
        author: '',
        id: null,
      };
    }
    return parseInfo(await this._read(this.info), this.protocol);
  }

  /** The device clock plus the timing of the read: `at` is the local
   *  performance.now() when the value arrived and `rtt` the round trip, so
   *  the caller knows the value was sampled about rtt/2 before `at` and can
   *  line the device's seconds up with its own clock. */
  async readTime() {
    if (!this.cts) return null;
    const t0 = performance.now();
    const t = parseTime(await this._read(this.cts));
    const at = performance.now();
    if (!t) return null;
    t.at = at;
    t.rtt = at - t0;
    return t;
  }

  /** Set the device clock from `d` (default: now), with the BLE delay
   *  compensated: the payload carries the time at which the write should
   *  arrive, not the time it was built, so the two clocks end up agreeing
   *  instead of the device being one link delay behind.
   *
   *  Returns the read-back value (with `at`/`rtt`); if the link hiccups
   *  between the write and the read, it returns what was sent instead, so
   *  the page still shows the new time. */
  async setTime(d = new Date()) {
    if (!this.cts) throw new Error('no Current Time service');
    const start = performance.now();
    /* one quick round trip to estimate the one-way delay: the connection
     * interval changes the latency, so a value from the last read is
     * stale */
    let rtt = 0;
    try {
      const t0 = performance.now();
      await this._read(this.cts);
      rtt = performance.now() - t0;
    } catch (e) {
      /* no estimate: send the sample time as-is */
    }
    const target = d.getTime() + (performance.now() - start) + rtt / 2;
    await this.cts.writeValue(timePayload(new Date(target)));
    try {
      return await this.readTime();
    } catch (e) {
      const t = parseTime(timePayload(new Date(target)));
      t.at = performance.now();
      t.rtt = 0;
      return t;
    }
  }

  /** Current software volume (0-255) from the debug snapshot. */
  async readVolume() {
    const b = await this.readSnapshot();
    return this.protocol.int(b, 'snapshot', 'audio_volume');
  }

  /** Set the software volume (0-255), the same as the VOL slider. */
  setVolume(v) {
    return this._cmd('set_volume', v & 0xff);
  }

  /** Write one command. Throws when the connected firmware lacks it. */
  async _cmd(name, ...args) {
    const payload = this.protocol ? this.protocol.build(name, ...args) : null;
    if (!payload) {
      throw new Error(`${name.replace(/_/g, ' ')} is not supported by ` +
        `firmware ${this.firmware || '(unknown)'}`);
    }
    await this.dbg.writeValue(payload);
  }

  playPause() {
    return this._cmd('play_pause');
  }
  nextTune() {
    return this._cmd('next_tune');
  }
  prevTune() {
    return this._cmd('prev_tune');
  }
  nextSubtune() {
    return this._cmd('next_subtune');
  }
  prevSubtune() {
    return this._cmd('prev_subtune');
  }
  stop() {
    return this._cmd('stop');
  }
  /** Play subtune `n` (1-based; 255 = the PSID startSong). */
  playSubtune(n) {
    return this._cmd('subplay', n & 0xff);
  }
  /** What happens when the tune ends (the SID screen END button). */
  setEndMode(mode) {
    return this._cmd('set_end_mode', mode & 0xff);
  }
  /** Play /home/<name> at subtune `sub` (1-based; 255 = startSong).
   *  Firmware that predates play_file_with_sub plays the default subtune
   *  (0x11), which is the same thing for sub = 255. */
  playFile(name, sub = 0xff) {
    this._loadedName = name;
    if (this.supports('play_file_with_sub')) {
      return this._cmd('play_file', sub & 0xff, name);
    }
    if (sub !== 0xff) {
      return Promise.reject(new Error(
        `playing a specific subtune needs a newer firmware ` +
        `(connected: ${this.firmware})`));
    }
    return this._cmd('play_file_default', name);
  }

  /* ---------- /home listing and maintenance ---------- */

  /** The debug snapshot. A pending listing fills the `listing` overlay. */
  async readSnapshot() {
    return bytesOf(await this._read(this.dbg));
  }

  /** Every name in /home, fetched one listing page at a time. */
  async listFiles() {
    const p = this.protocol;
    const textOff = p.offset('listing', 'text');
    const textLen = p.length('listing', 'text');
    const names = [];
    let idx = 0;
    for (let page = 0; page < 256; page++) {
      await this._cmd('list_page', idx & 0xffff);
      const b = await this.readSnapshot();
      let end = textOff;
      while (end < textOff + textLen && b[end] !== 0) end++;
      const text = new TextDecoder().decode(b.subarray(textOff, end));
      for (const line of text.split('\n')) {
        if (line) names.push(line);
      }
      const next = p.int(b, 'listing', 'next');
      if (next === 0xff || next <= idx) return names;
      idx = next;
    }
    return names;
  }

  /** Delete a /home file; a .sid also drops its .len and .stil sidecars.
   *  Returns the sidecars that were already missing. */
  async deleteFile(name) {
    const targets = [name];
    if (/\.sid$/i.test(name)) {
      targets.push(`${name.slice(0, -4)}.len`, `${name.slice(0, -4)}.stil`);
    }
    /* delete takes any name a listing page can carry, not just what the
     * loader plays, so an over-long upload can still be removed */
    const max = this.protocol && this.protocol.commandNameMax
      ? this.protocol.commandNameMax('delete')
      : ((this.protocol && this.protocol.limits.name_max) || 23);
    const missing = [];
    for (let i = 0; i < targets.length; i++) {
      const data = new TextEncoder().encode(targets[i]);
      if (data.length > max) {
        /* the device takes up to `name_max` characters; a sidecar that is
         * over cannot be removed - report it instead of aborting the delete
         * half way through (the .sid is already gone at that point) */
        if (i === 0) throw new Error(`file name too long (max ${max})`);
        missing.push(targets[i]);
        continue;
      }
      try {
        await this._cmd('delete', targets[i]);
      } catch (e) {
        if (i === 0) throw e;
        missing.push(targets[i]);
      }
    }
    return missing;
  }

  async disconnect() {
    this.connected = false;
    this._stopPolling();
    try {
      if (this.state) await this.state.stopNotifications();
    } catch (e) {}
    try {
      if (this.battery) await this.battery.stopNotifications();
    } catch (e) {}
    try {
      if (this.device && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
    } catch (e) {}
  }
}
