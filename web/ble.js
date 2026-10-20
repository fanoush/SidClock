/*
 * SidClock Web Bluetooth client: connection + protocol only, no DOM.
 *
 * The wire format is documented in docs/ble-services.md. Short version:
 *
 *   service  73696463-6c6f-4b01-9c1d-77ce3f41a5c0
 *     dbg    73696463-6c6f-4b02-...  read+write   snapshot / commands
 *     state  73696463-6c6f-4b03-...  read+notify  16-byte player state
 *     info   73696463-6c6f-4b04-...  read         96-byte title/name/author/id
 *
 * Commands are one opcode byte plus arguments, written to the debug
 * characteristic: 0x18 play/pause, 0x19/0x1A next/prev tune,
 * 0x1B/0x1C next/prev subtune, 0x21 sub play (1-based, 255 = startSong),
 * 0x20 sub+name play file at subtune, 0x22 end-of-tune mode (0 = next
 * subtune, 1 = next tune, 2 = loop), 0x0F stop, 0x13 listing page,
 * 0x16 delete file.
 *
 * The device runs player commands in its main loop, so a command is
 * accepted immediately but takes effect a moment later - the state
 * notification is the acknowledgement. Listing pages replace the diag
 * block of the next snapshot read (names in [34..94], [95] = next page
 * index or 0xFF when done).
 *
 * File transfers use mcumgr SMP (see smp.js) on the standard SMP
 * characteristic; the device unregisters that service unless Bluetooth
 * access is R/W.
 */

import { SMP_SERVICE, SMP_CHARACTERISTIC } from './smp.js';

export const SIDCLOCK_SERVICE = '73696463-6c6f-4b01-9c1d-77ce3f41a5c0';
export const DBG_CHAR = '73696463-6c6f-4b02-9c1d-77ce3f41a5c0';
export const STATE_CHAR = '73696463-6c6f-4b03-9c1d-77ce3f41a5c0';
export const INFO_CHAR = '73696463-6c6f-4b04-9c1d-77ce3f41a5c0';

export const END_MODES = ['next sub', 'next tune', 'loop sub'];
export const MODEL_MODES = ['auto', '6581', '8580'];
export const CHIP_NAMES = ['?', '6581', '8580'];

// Standard services the page also uses (optional - a page still works
// without them).
const BATTERY_SERVICE = 0x180f;
const BATTERY_LEVEL_CHAR = 0x2a19;
const CTS_SERVICE = 0x1805;
const CTS_CHAR = 0x2a2b;

const u32 = (b, o) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function cstr(bytes, off, len) {
  let end = off;
  const max = off + len;
  while (end < max && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(off, end));
}

function bytesOf(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Decode the 16-byte player state value. */
export function parseState(view) {
  const b = bytesOf(view);
  if (b.length < 16) return null;
  return {
    playing: !!(b[0] & 0x01),
    paused: !!(b[0] & 0x02),
    sound: !!(b[0] & 0x04),
    legacyEngine: !!(b[0] & 0x08),
    subtune: b[1], // 0-based; +1 for display
    songs: b[2],
    endMode: b[3],
    modelMode: b[4],
    chip: b[5],
    generation: b[6],
    elapsed: u32(b, 8),
    length: u32(b, 12),
  };
}

/** Decode the info value: title|name|author, plus the tune id when the
 *  firmware sends the 96-byte form (bytes [88..95]: the first 4 bytes of
 *  the loaded file's whole-file MD5 as 8 lowercase hex characters, the
 *  key HVSC's Songlengths.md5 uses; null means "unknown"). */
export function parseInfo(view) {
  const b = bytesOf(view);
  if (b.length < 88) return null;
  const info = {
    title: cstr(b, 0, 32),
    name: cstr(b, 32, 24),
    author: cstr(b, 56, 32),
    id: null,
  };
  if (b.length >= 96) {
    let hex = '';
    for (let i = 88; i < 96; i++) hex += String.fromCharCode(b[i]);
    hex = hex.toLowerCase();
    if (/^[0-9a-f]{8}$/.test(hex) && hex !== '00000000') info.id = hex;
  }
  return info;
}

/** Decode the 10-byte Current Time value into a sorted object. */
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
  };
}

/** The 10-byte Current Time value for a JS Date (local fields, like the
 *  device keeps them - there is no RTC and no timezone on the wire). */
export function timePayload(d = new Date()) {
  const dow = ((d.getDay() + 6) % 7) + 1; // Monday = 1
  return new Uint8Array([
    d.getFullYear() & 0xff,
    (d.getFullYear() >> 8) & 0xff,
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    dow,
    0,
    0,
  ]);
}

export class SidClock {
  constructor() {
    this.device = null;
    this.server = null;
    this.connected = false;
    this._connecting = null;
    this._stateChar = null;
    this._stateHandler = null;
    this._batteryChar = null;
    this._batteryHandler = null;
    this.onState = () => {};
    this.onInfo = () => {};
    this.onBattery = () => {};
    this.onDisconnect = () => {};
  }

  static get available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
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
        this.onDisconnect();
      });
    }
    this.server = await this._connectGatt();

    const svc = await this._retryGatt(() =>
      this.server.getPrimaryService(SIDCLOCK_SERVICE));
    this.dbg = await this._retryGatt(() => svc.getCharacteristic(DBG_CHAR));
    this.state = await this._retryGatt(() => svc.getCharacteristic(STATE_CHAR));
    this.info = await this._retryGatt(() => svc.getCharacteristic(INFO_CHAR));

    this.battery = await this._optional(BATTERY_SERVICE, BATTERY_LEVEL_CHAR);
    this.cts = await this._optional(CTS_SERVICE, CTS_CHAR);
    // SMP is only registered in R/W mode; without it, no file transfers
    this.smp = await this._optional(SMP_SERVICE, SMP_CHARACTERISTIC);

    this.connected = true;
    return this.device.name || 'SidClock';
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

  /** Subscribe to notifications, retrying the CCC write once for the
   *  same reason as _read(). */
  _subscribe(char) {
    return this._retryGatt(() => char.startNotifications());
  }

  async _optional(service, characteristic) {
    try {
      const s = await this._retryGatt(() =>
        this.server.getPrimaryService(service));
      return await this._retryGatt(() => s.getCharacteristic(characteristic));
    } catch (e) {
      return null; // service not present: the rest still works
    }
  }

  /** Subscribe to the pushed values. No initial read: the device forces
   *  a notification as soon as the CCC is written (player_state_dirty in
   *  the firmware), and a read issued before that CCC write is what made
   *  a fresh Android connection fail - the read is rejected and the CCC
   *  write that follows it too ("GATT operation failed"), leaving a live
   *  link with no notifications. Subscribe first, then let the device
   *  push. */
  async startUpdates() {
    /* Replace the previous connection's listener (if any): a reconnect
     * hands us new characteristic objects, and the old ones must not keep
     * feeding the UI. */
    if (this._stateChar && this._stateHandler) {
      this._stateChar.removeEventListener('characteristicvaluechanged',
                                          this._stateHandler);
    }
    this._stateChar = this.state;
    this._stateHandler = (e) => {
      const st = parseState(e.target.value);
      if (st) this.onState(st);
    };
    this.state.addEventListener('characteristicvaluechanged',
                                this._stateHandler);

    await this._subscribe(this.state);

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
  }

  async readInfo() {
    return parseInfo(await this._read(this.info));
  }

  async readTime() {
    return this.cts ? parseTime(await this._read(this.cts)) : null;
  }

  async setTime(d = new Date()) {
    if (!this.cts) throw new Error('no Current Time service');
    await this.cts.writeValue(timePayload(d));
    return this.readTime();
  }

  async _cmd(bytes) {
    await this.dbg.writeValue(new Uint8Array(bytes));
  }

  playPause() {
    return this._cmd([0x18]);
  }
  nextTune() {
    return this._cmd([0x19]);
  }
  prevTune() {
    return this._cmd([0x1a]);
  }
  nextSubtune() {
    return this._cmd([0x1b]);
  }
  prevSubtune() {
    return this._cmd([0x1c]);
  }
  stop() {
    return this._cmd([0x0f]);
  }
  /** Play subtune `n` (1-based; 255 = the PSID startSong). */
  playSubtune(n) {
    return this._cmd([0x21, n & 0xff]);
  }
  /** What happens when the tune ends (the SID screen END button):
   *  0 = next subtune, 1 = next tune, 2 = loop the subtune. */
  setEndMode(mode) {
    return this._cmd([0x22, mode & 0xff]);
  }
  /** Play /home/<name> at subtune `sub` (1-based; 255 = startSong). */
  playFile(name, sub = 0xff) {
    const data = new TextEncoder().encode(name);
    return this._cmd([0x20, sub & 0xff, ...data]);
  }

  /* ---------- /home listing and maintenance (0x13 / 0x16) ---------- */

  /** The debug snapshot; a pending listing fills bytes [34..95]. */
  async readSnapshot() {
    return bytesOf(await this._read(this.dbg));
  }

  /** Every name in /home, fetched one 0x13 listing page at a time. */
  async listFiles() {
    const names = [];
    let idx = 0;
    for (let page = 0; page < 256; page++) {
      await this._cmd([0x13, idx & 0xff, (idx >> 8) & 0xff]);
      const b = await this.readSnapshot();
      let end = 34;
      while (end < 95 && b[end] !== 0) end++;
      const text = new TextDecoder().decode(b.subarray(34, end));
      for (const line of text.split('\n')) {
        if (line) names.push(line);
      }
      const next = b[95];
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
    const missing = [];
    for (let i = 0; i < targets.length; i++) {
      const data = new TextEncoder().encode(targets[i]);
      if (data.length > 23) {
        /* the device takes up to 23 characters; a sidecar that is over
         * cannot be removed - report it instead of aborting the delete
         * half way through (the .sid is already gone at that point) */
        if (i === 0) throw new Error('file name too long (max 23)');
        missing.push(targets[i]);
        continue;
      }
      try {
        await this._cmd([0x16, ...data]);
      } catch (e) {
        if (i === 0) throw e;
        missing.push(targets[i]);
      }
    }
    return missing;
  }

  async disconnect() {
    this.connected = false;
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
