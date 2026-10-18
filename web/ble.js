/*
 * SidClock Web Bluetooth client: connection + protocol only, no DOM.
 *
 * The wire format is documented in docs/ble-services.md. Short version:
 *
 *   service  73696463-6c6f-4b01-9c1d-77ce3f41a5c0
 *     dbg    73696463-6c6f-4b02-...  read+write   snapshot / commands
 *     state  73696463-6c6f-4b03-...  read+notify  16-byte player state
 *     info   73696463-6c6f-4b04-...  read         88-byte title/name/author
 *
 * Commands are one opcode byte plus arguments, written to the debug
 * characteristic: 0x18 play/pause, 0x19/0x1A next/prev tune,
 * 0x1B/0x1C next/prev subtune, 0x21 sub play (1-based, 255 = startSong),
 * 0x20 sub+name play file at subtune, 0x0F stop, 0x13 listing page,
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

/** Decode the 88-byte info value (title|name|author). */
export function parseInfo(view) {
  const b = bytesOf(view);
  if (b.length < 88) return null;
  return {
    title: cstr(b, 0, 32),
    name: cstr(b, 32, 24),
    author: cstr(b, 56, 32),
  };
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
  async connect() {
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
    this.server = await this.device.gatt.connect();

    const svc = await this.server.getPrimaryService(SIDCLOCK_SERVICE);
    this.dbg = await svc.getCharacteristic(DBG_CHAR);
    this.state = await svc.getCharacteristic(STATE_CHAR);
    this.info = await svc.getCharacteristic(INFO_CHAR);

    this.battery = await this._optional(BATTERY_SERVICE, BATTERY_LEVEL_CHAR);
    this.cts = await this._optional(CTS_SERVICE, CTS_CHAR);
    // SMP is only registered in R/W mode; without it, no file transfers
    this.smp = await this._optional(SMP_SERVICE, SMP_CHARACTERISTIC);

    this.connected = true;
    return this.device.name || 'SidClock';
  }

  async _optional(service, characteristic) {
    try {
      const s = await this.server.getPrimaryService(service);
      return await s.getCharacteristic(characteristic);
    } catch (e) {
      return null; // service not present: the rest still works
    }
  }

  /** Subscribe to the pushed values; reads the initial ones so the page
   *  is correct before the first notification arrives. */
  async startUpdates() {
    this.state.addEventListener('characteristicvaluechanged', (e) => {
      const st = parseState(e.target.value);
      if (st) this.onState(st);
    });
    await this.state.startNotifications();
    const initial = parseState(await this.state.readValue());
    if (initial) this.onState(initial);

    if (this.battery) {
      this.battery.addEventListener('characteristicvaluechanged', (e) =>
        this.onBattery(e.target.value.getUint8(0))
      );
      try {
        await this.battery.startNotifications();
      } catch (e) {
        /* notifications unsupported: fall back to a one-shot read */
      }
      try {
        this.onBattery((await this.battery.readValue()).getUint8(0));
      } catch (e) {}
    }
  }

  async readInfo() {
    return parseInfo(await this.info.readValue());
  }

  async readTime() {
    return this.cts ? parseTime(await this.cts.readValue()) : null;
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
  /** Play /home/<name> at subtune `sub` (1-based; 255 = startSong). */
  playFile(name, sub = 0xff) {
    const data = new TextEncoder().encode(name);
    return this._cmd([0x20, sub & 0xff, ...data]);
  }

  /* ---------- /home listing and maintenance (0x13 / 0x16) ---------- */

  /** The debug snapshot; a pending listing fills bytes [34..95]. */
  async readSnapshot() {
    return bytesOf(await this.dbg.readValue());
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
      if (data.length > 20) throw new Error('file name too long (max 20)');
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
      if (this.device && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
    } catch (e) {}
  }
}
