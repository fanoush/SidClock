/*
 * SidClock wire-protocol descriptors for the web remote.
 *
 * `protocol/index.json` lists one frozen descriptor per released firmware;
 * `protocol/current.json` is the single source of truth they are generated
 * from (tools/proto_gen.py). Everything the page puts on the wire - UUIDs,
 * characteristic sizes, snapshot/state/info offsets, command opcodes and
 * their argument layout - comes from the descriptor of the firmware that is
 * actually connected, so an older device keeps working and a newer one can
 * add fields without breaking this page.
 *
 * Selection mirrors tools/protocol.py:
 *   1. the hello characteristic (protocol + layout + caps), exact;
 *   2. otherwise the legacy probe: which characteristics exist plus the
 *      length of the debug value (see the `legacy` block of each entry).
 *
 * The descriptors are plain JSON fetched at runtime - not generated JS
 * modules - so a frozen version can be dropped in without touching code.
 */

/* Permanent UUIDs. The hello characteristic was added with protocol 5 and
 * is never allowed to move again; the older three are the original layout.
 * They are repeated in every descriptor - these copies let a client look
 * for them before it knows which descriptor applies. */
export const DEBUG_UUID = '73696463-6c6f-4b02-9c1d-77ce3f41a5c0';
export const STATE_UUID = '73696463-6c6f-4b03-9c1d-77ce3f41a5c0';
export const INFO_UUID = '73696463-6c6f-4b04-9c1d-77ce3f41a5c0';
export const HELLO_UUID = '73696463-6c6f-4b05-9c1d-77ce3f41a5c0';

const TYPE_SIZE = {
  u8: 1, i8: 1, u16: 2, i16: 2, u24: 3, u32: 4, i32: 4, u64: 8,
};
const VARIABLE_TYPES = ['string', 'bytes', 'hex'];

/** Decode the 12-byte hello value. Returns null when it is too short. */
export function parseHello(value) {
  const b = bytes(value);
  if (b.length < 12) return null;
  const u16 = (o) => b[o] | (b[o + 1] << 8);
  const u32 = (o) =>
    (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  return {
    protocol: u16(0),
    layout: u16(2),
    caps: u32(4),
    firmware: `${b[8]}.${b[9]}.${b[10]}`,
    flags: b[11],
    debug: !!(b[11] & 0x01),
    legacyEngine: !!(b[11] & 0x02),
    splitEngine: !!(b[11] & 0x04),
  };
}

function bytes(view) {
  if (view instanceof Uint8Array) return view;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function semver(text) {
  return String(text).split('.').map((x) => parseInt(x, 10) || 0);
}

function cmpSemver(a, b) {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** One firmware's wire protocol, with typed accessors. */
export class Protocol {
  constructor(data, source = 'hello') {
    this.data = data;
    this.source = source;
    this.firmware = data.firmware;
    this.protocol = data.protocol;
    this.layout = parseInt(data.layout, 16);
    this.features = new Set(data.features || []);
    this.characteristics = data.characteristics || {};
    this.limits = data.limits || {};
    this.notes = [];
    this._snapshot = data.snapshot || { size: 0, fields: [] };
    this._snapFields = Protocol._map(this._snapshot.fields);
    this._overlays = {};
    for (const [name, ov] of Object.entries(this._snapshot.overlays || {})) {
      this._overlays[name] = Protocol._map(ov.fields);
    }
    this._stateFields = Protocol._map((data.state || {}).fields);
    const info = data.info || {};
    this._infoFields = Protocol._map([].concat(info.strings || [],
                                              info.hex || []));
    this._helloFields = Protocol._map((data.hello || {}).fields);
    this._commands = {};
    for (const c of data.commands || []) this._commands[c.name] = c;
  }

  static _map(fields) {
    const out = {};
    for (const f of fields || []) out[f.name] = f;
    return out;
  }

  /* ---------- capabilities ---------- */

  has(feature) {
    return this.features.has(feature);
  }

  hasChar(name) {
    return !!this.characteristics[name];
  }

  char(name) {
    const c = this.characteristics[name];
    return c ? c.uuid : null;
  }

  charSize(name) {
    const c = this.characteristics[name];
    return c ? c.size : null;
  }

  /* ---------- field access ---------- */

  _fields(area) {
    if (area === 'snapshot') return this._snapFields;
    if (area === 'state') return this._stateFields;
    if (area === 'info') return this._infoFields;
    if (area === 'hello') return this._helloFields;
    return this._overlays[area] || null;
  }

  field(area, name) {
    const f = this._fields(area);
    return f ? f[name] || null : null;
  }

  hasField(area, name) {
    return !!this.field(area, name);
  }

  offset(area, name) {
    const f = this.field(area, name);
    return f ? f.offset : null;
  }

  length(area, name) {
    const f = this.field(area, name);
    if (!f) return 0;
    if (VARIABLE_TYPES.includes(f.type)) return f.size;
    return TYPE_SIZE[f.type] || 0;
  }

  /** Integer field from a device value; null when it is not described. */
  int(raw, area, name) {
    const f = this.field(area, name);
    if (!f) return null;
    const size = this.length(area, name);
    const b = bytes(raw);
    if (f.offset + size > b.length) return null;
    let v = 0;
    for (let i = size - 1; i >= 0; i--) v = v * 256 + b[f.offset + i];
    if (f.type[0] === 'i' && v >= 2 ** (8 * size - 1)) v -= 2 ** (8 * size);
    return v;
  }

  /** NUL-terminated string field from a device value. */
  text(raw, area, name) {
    const f = this.field(area, name);
    if (!f) return '';
    const b = bytes(raw);
    const end = Math.min(b.length, f.offset + f.size);
    let stop = f.offset;
    while (stop < end && b[stop] !== 0) stop++;
    return new TextDecoder().decode(b.subarray(f.offset, stop));
  }

  snapshotSize() {
    return this._snapshot.size || 0;
  }

  flags(area) {
    const src = area === 'snapshot' ? this._snapshot
      : area === 'state' ? this.data.state
        : area === 'hello' ? this.data.hello : null;
    const out = {};
    for (const f of (src && src.flags) || []) out[f.name] = f.mask;
    return out;
  }

  /* ---------- values and commands ---------- */

  valueItems(setName) {
    return (this.data.values || {})[setName] || [];
  }

  valueLabel(setName, value) {
    for (const item of this.valueItems(setName)) {
      if (item.value === value) return item.label || item.name;
    }
    return String(value);
  }

  /** Protocol value for a named value set (e.g. 'end_mode'). */
  value(setName, name) {
    const want = String(name).toLowerCase();
    for (const item of this.valueItems(setName)) {
      if (item.name.toLowerCase() === want ||
          String(item.label || '').toLowerCase() === want) {
        return item.value;
      }
    }
    return null;
  }

  command(name) {
    return this._commands[name] || null;
  }

  hasCommand(name) {
    return !!this._commands[name];
  }

  opcode(name) {
    const c = this.command(name);
    return c ? c.opcode : null;
  }

  /** Longest name `name` accepts (its name arg's max, else name_max).
   *  Only delete takes longer names than the loader can play. */
  commandNameMax(name) {
    const c = this.command(name);
    for (const arg of (c && c.args) || []) {
      if (arg.type === 'name') return arg.max || this.limits.name_max || 23;
    }
    return this.limits.name_max || 23;
  }

  /** Encode a command write: opcode followed by its declared arguments. */
  build(name, ...args) {
    const c = this.command(name);
    if (!c) return null;
    const out = [c.opcode];
    const declared = c.args || [];
    for (let i = 0; i < declared.length; i++) {
      const arg = declared[i];
      const value = args[i];
      if (arg.type === 'name') {
        if (value == null) continue;
        const data = typeof value === 'string'
          ? new TextEncoder().encode(value) : Uint8Array.from(value);
        const max = arg.max || this.limits.name_max || 23;
        for (let k = 0; k < Math.min(data.length, max); k++) out.push(data[k]);
        continue;
      }
      if (value == null) continue;
      const size = { u8: 1, u16: 2, u32: 4 }[arg.type] || 1;
      for (let k = 0; k < size; k++) out.push((value >> (8 * k)) & 0xff);
    }
    return new Uint8Array(out);
  }
}

/* ---------- descriptor loading and selection ---------- */

/** Where the descriptors live, resolved against this module so the page
 *  works from /web/ and from the test harness under tools/web-tests/. */
export const PROTOCOL_BASE = new URL('./protocol/', import.meta.url);

/** Fetch protocol/index.json. */
export async function loadIndex(base = PROTOCOL_BASE) {
  const r = await fetch(new URL('index.json', base), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`protocol index: HTTP ${r.status}`);
  const index = await r.json();
  index._base = base;
  return index;
}

async function loadEntry(index, entry, notes = [], source = 'hello') {
  const base = index._base || PROTOCOL_BASE;
  const r = await fetch(new URL(entry.file, base), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`protocol ${entry.firmware}: HTTP ${r.status}`);
  const p = new Protocol(await r.json(), source);
  /* the layout id lives in the index entry, not in the frozen descriptor */
  p.layout = parseInt(entry.layout, 16);
  p.notes = notes;
  return p;
}

function byNewest(a, b) {
  const d = (b.protocol || 0) - (a.protocol || 0);
  return d || cmpSemver(b.firmware, a.firmware);
}

/** Pick the descriptor for a hello value. */
async function selectForHello(index, helloBytes) {
  const hello = parseHello(helloBytes);
  if (!hello) throw new Error('hello value is too short');
  const exact = (index.versions || []).find((e) =>
    e.protocol === hello.protocol && parseInt(e.layout, 16) === hello.layout);
  if (exact) return loadEntry(index, exact);

  const same = (index.versions || [])
    .filter((e) => e.protocol === hello.protocol).sort(byNewest);
  if (same.length) {
    const notes = [`device layout 0x${hello.layout.toString(16)} has no ` +
      `descriptor; using ${same[0].firmware}`];
    return loadEntry(index, same[0], notes);
  }

  const older = (index.versions || [])
    .filter((e) => e.protocol < hello.protocol).sort(byNewest);
  if (older.length) {
    const notes = [`device speaks protocol ${hello.protocol}, newest ` +
      `descriptor is ${older[0].firmware}; newer commands are disabled`];
    return loadEntry(index, older[0], notes);
  }
  throw new Error(`device speaks protocol ${hello.protocol}, older than ` +
    'every descriptor this page ships');
}

/** Pick the descriptor for a device without hello. `present` is an array of
 *  characteristic names ('debug', 'state', 'info'); `debugSize` is the
 *  length of the debug value (null when it could not be read). */
async function selectLegacy(index, present, debugSize) {
  const notes = ['device has no hello characteristic; the firmware version ' +
    'is approximate (legacy probe)'];
  const entries = (index.versions || []).slice().sort(byNewest);
  for (const entry of entries) {
    const legacy = entry.legacy;
    if (!legacy) continue;
    if (!(legacy.has || []).every((n) => present.includes(n))) continue;
    if (!(legacy.missing || []).every((n) => !present.includes(n))) continue;
    const bounds = legacy.debug_size;
    if (bounds && debugSize != null &&
        (debugSize < bounds[0] || debugSize > bounds[1])) continue;
    notes.push(`matched ${entry.firmware} (protocol ${entry.protocol}): ` +
      `debug ${debugSize == null ? '?' : debugSize} bytes, ` +
      `state ${present.includes('state') ? 'yes' : 'no'}, ` +
      `info ${present.includes('info') ? 'yes' : 'no'}`);
    return loadEntry(index, entry, notes, 'legacy');
  }
  return null;
}

/** Select the descriptor for a connected device.
 *
 *  `helloBytes` is the hello value (null when the characteristic is
 *  missing); `present` lists the SidClock characteristics found; `debugSize`
 *  is the debug value length, used only by the legacy probe.
 *  Resolves to a Protocol, or null when nothing matches. */
export async function select({ helloBytes, present, debugSize, base = PROTOCOL_BASE }) {
  const index = await loadIndex(base);
  if (helloBytes) return selectForHello(index, helloBytes);
  return selectLegacy(index, present || ['debug'], debugSize);
}
