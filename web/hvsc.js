/*
 * HVSC (the High Voltage SID Collection) helpers for the web remote.
 *
 *   - search / details / tune download through hvsc.c64.org's API
 *   - the Songlengths.md5 and STIL.txt databases, fetched on demand and
 *     cached in IndexedDB (5.2 MB + 3.8 MB, they only change with HVSC
 *     releases), with a small parser for each
 *   - the device-side `.len` / `.stil` sidecars, built exactly like
 *     tools/sid_add.py builds them
 *
 * The device keeps tune names in 24-byte buffers and its debug commands
 * take up to 23 characters, but a `.stil` sidecar is one character longer
 * than its `.sid`, so a longer HVSC file name is shortened to 20 for the
 * device (the upload map remembers the original for the info panel).
 */

import { md5 } from './md5.js';

const BASE = 'https://hvsc.c64.org';
const API = `${BASE}/api/v1`;
export const SONGLENGTHS_URL = `${BASE}/download/C64Music/DOCUMENTS/Songlengths.md5`;
export const STIL_URL = `${BASE}/download/C64Music/DOCUMENTS/STIL.txt`;

/* device .stil limits: keep in sync with tools/sid_add.py and the
 * firmware sidecar buffer (SID_STIL_MAX = 3072 in app/src/main.c) */
const NAME_CHARS = 24;
const TUNE_CHARS = 200;
const NOTE_CHARS = 160;
const MAX_BYTES = 3000;

/** Longest `.sid` name uploads use. The name-taking commands and the
 *  player accept 23 characters (the full 24-byte buffer), but a `.stil`
 *  sidecar is one character longer than its `.sid`: 20 keeps every
 *  uploaded sidecar inside the limit (<= 21). */
export const DEVICE_NAME_MAX = 20;

/** The name the tune will have on the device (<= 20 chars). */
export function deviceNameFor(file) {
  if (file.length <= DEVICE_NAME_MAX) return file;
  const stem = file.replace(/\.sid$/i, '');
  return `${stem.slice(0, DEVICE_NAME_MAX - 4)}.sid`;
}

/* ---------- hvsc.c64.org API ---------- */

async function fetchJson(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HVSC API: HTTP ${res.status}`);
  return res.json();
}

export function searchSids(query) {
  return fetchJson(`${API}/sids?q=${encodeURIComponent(query)}`);
}

/** The result fields the search boxes can restrict to. The API matches
 *  every one of them, which is why a search for "Commando" also returns
 *  tunes whose released line says "1987 Commando Frontier". */
export const SEARCH_FIELDS = ['title', 'author', 'released'];

/** Keep the results whose checked `fields` contain every query term.
 *  The API matches all the terms, in any order, across title/author/
 *  released; this repeats that same match over the fields the user kept
 *  checked, so unticking `released` drops the series-name lookalikes.
 *  An empty field selection filters nothing. */
export function filterSids(results, query, fields) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !fields.length) return results;
  return results.filter((res) => terms.every((t) => fields.some((f) =>
    String(res[f] || '').toLowerCase().includes(t))));
}

export function getSidDetails(id) {
  return fetchJson(`${API}/sids/${encodeURIComponent(id)}`);
}

export function downloadSid(id, onProgress) {
  return fetchBytes(`${BASE}/download/sids/${encodeURIComponent(id)}`,
                    onProgress);
}

async function fetchBytes(url, onProgress) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (onProgress) onProgress(got, total || got);
  }
  return concat(parts);
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/* ---------- IndexedDB cache (falls back to memory) ---------- */

const IDB_NAME = 'sidclock-web';
const IDB_STORE = 'hvsc';
const mem = new Map();
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => {
      console.warn('IndexedDB unavailable, keeping the cache in memory', e);
      return null;
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  if (!db) return mem.get(key) || null;
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || mem.get(key) || null);
    req.onerror = () => resolve(mem.get(key) || null);
  });
}

async function idbPut(key, value) {
  mem.set(key, value);
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/* documents are latin-1 (STIL.txt carries accented names) */
const latin1 = new TextDecoder('latin1');

export async function dbStatus() {
  return {
    songlengths: await slRecord(),
    stil: await stilRecord(),
  };
}

let slLoading = null;
let stilLoading = null;
let slRec = null;
let stilRec = null;
let slRecRead = false;
let stilRecRead = false;

async function slRecord() {
  if (!slRecRead) {
    slRec = await idbGet('songlengths');
    slRecRead = true;
  }
  return slRec;
}

async function stilRecord() {
  if (!stilRecRead) {
    stilRec = await idbGet('stil');
    stilRecRead = true;
  }
  return stilRec;
}

/** Fetch + cache Songlengths.md5; resolves once it is stored. */
export function loadSonglengths(onProgress) {
  if (!slLoading) {
    slLoading = (async () => {
      const bytes = await fetchBytes(SONGLENGTHS_URL, onProgress);
      slRec = { text: latin1.decode(bytes), at: Date.now(), bytes: bytes.length };
      slRecRead = true;
      await idbPut('songlengths', slRec);
      slCache = null;
    })().finally(() => { slLoading = null; });
  }
  return slLoading;
}

/** Fetch + cache STIL.txt. */
export function loadStil(onProgress) {
  if (!stilLoading) {
    stilLoading = (async () => {
      const bytes = await fetchBytes(STIL_URL, onProgress);
      stilRec = { text: latin1.decode(bytes), at: Date.now(), bytes: bytes.length };
      stilRecRead = true;
      await idbPut('stil', stilRec);
      stilCache = null;
    })().finally(() => { stilLoading = null; });
  }
  return stilLoading;
}

/* ---------- parsers (mirror tools/sid_add.py) ---------- */

/** "4:27 5:38" -> [267, 338] (0 for tokens without a time). */
export function parseLengths(v) {
  const out = [];
  for (const raw of v.split(/\s+/)) {
    if (!raw) continue;
    const tok = raw.split('(')[0];
    if (tok.includes(':')) {
      const [m, s] = tok.split(':');
      // sid_add.py: int(m * 60 + s + 0.5) - truncation, not rounding
      out.push(Math.floor(parseFloat(m) * 60 + parseFloat(s) + 0.5));
    } else {
      out.push(0);
    }
  }
  return out;
}

/** Songlengths.md5 text -> lookups by md5 / md5 prefix / file name / path. */
export function parseSonglengths(text) {
  const byMd5 = new Map();
  const byPrefix = new Map(); // 8 hex chars -> entry or [entry, ...] (collision)
  const byName = new Map();
  const byNameCount = new Map(); // how many HVSC files share a name
  const byPath = new Map();
  let path = '?';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(';')) {
      path = line.slice(1).trim();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const value = line.slice(eq + 1).trim();
    const entry = { path, value, lengths: parseLengths(value) };
    const hex = line.slice(0, eq).toLowerCase();
    byMd5.set(hex, entry);
    byPath.set(path, entry);
    const base = path.split('/').pop();
    if (base) {
      if (!byName.has(base)) byName.set(base, entry);
      byNameCount.set(base, (byNameCount.get(base) || 0) + 1);
    }
    const prefix = hex.slice(0, 8);
    const prev = byPrefix.get(prefix);
    if (prev === undefined) byPrefix.set(prefix, entry);
    else if (Array.isArray(prev)) prev.push(entry);
    else byPrefix.set(prefix, [prev, entry]);
  }
  return { byMd5, byPrefix, byName, byNameCount, byPath };
}

/** STIL.txt text -> Map(path -> {names, comment, subs}) (fields wrap). */
export function parseStil(text) {
  const KEYS = ['TITLE', 'NAME', 'AUTHOR', 'ARTIST', 'PUBLISHER', 'COMMENT',
                'RELEASED', 'MUSIC', 'INFO', 'COVER'];
  const entries = new Map();
  let cur = null;
  let sub = 0;
  let field = null;
  let chunk = [];

  const flush = () => {
    if (cur === null || field === null) {
      field = null;
      chunk = [];
      return;
    }
    let joined = chunk.map((t) => t.trim()).join(' ').trim();
    joined = joined.replace(/^"+/, '').replace(/"+$/, '').trim();
    const entry = entries.get(cur);
    if (field === 'COMMENT') {
      if (sub === 0) {
        entry.comment = entry.comment ? `${entry.comment} ${joined}` : joined;
      } else if (joined) {
        entry.subs[sub] = entry.subs[sub]
          ? `${entry.subs[sub]} ${joined}` : joined;
      }
    } else if (sub > 0 && joined && !entry.names[sub]) {
      entry.names[sub] = joined;
    }
    field = null;
    chunk = [];
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const stripped = line.trim();
    if (!stripped) {
      flush();
      continue;
    }
    if (line.startsWith('/') || line.startsWith('\\')) {
      flush();
      cur = stripped;
      entries.set(cur, { names: {}, comment: '', subs: {} });
      sub = 0;
      continue;
    }
    if (stripped.startsWith('(#') && stripped.endsWith(')')) {
      flush();
      const n = parseInt(stripped.slice(2, -1), 10);
      sub = Number.isNaN(n) ? 0 : n;
      continue;
    }
    let matched = false;
    for (const key of KEYS) {
      if (stripped.startsWith(`${key}:`)) {
        flush();
        field = key;
        chunk = [stripped.slice(key.length + 1)];
        matched = true;
        break;
      }
    }
    if (!matched && field !== null) chunk.push(stripped);
    else if (!matched) flush();
  }
  flush();
  return entries;
}

/** STIL entries by path and by file name (first match + name counts). */
export function stilIndex(text) {
  const byPath = parseStil(text);
  const byName = new Map();
  const byNameCount = new Map();
  for (const [path, entry] of byPath) {
    const base = path.split(/[\\/]/).pop();
    if (!base) continue;
    if (!byName.has(base)) byName.set(base, entry);
    byNameCount.set(base, (byNameCount.get(base) || 0) + 1);
  }
  return { byPath, byName, byNameCount };
}

/** Drop a trailing "(1:23)" / "(1:23-2:45)" time range from a STIL name. */
export function stripTimeRange(s) {
  return s.replace(/\s*\(\d+:\d+[-–]?\d*:?\d*\)\s*$/, '').trim();
}

/** The device `.stil` for a STIL entry and a tune's song count. */
export function buildStil(entry, songs) {
  const lines = [];
  for (let i = 1; i <= songs; i++) {
    lines.push(stripTimeRange(entry.names[i] || '').slice(0, NAME_CHARS));
  }
  const comment = (entry.comment || '').split(/\s+/).filter(Boolean).join(' ');
  lines.push(comment.slice(0, TUNE_CHARS));
  let used = lines.reduce((n, l) => n + l.length + 1, 0);
  const subs = Object.keys(entry.subs || {}).map(Number)
    .filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  for (const sub of subs) {
    const text = (entry.subs[sub] || '').split(/\s+/).filter(Boolean).join(' ');
    if (!text) continue;
    const line = `@${sub} ${text.slice(0, NOTE_CHARS)}`;
    if (used + line.length + 1 > MAX_BYTES) break; // device buffer is full
    lines.push(line);
    used += line.length + 1;
  }
  return `${lines.join('\n')}\n`;
}

/* ---------- parsed caches, loaded on demand ---------- */

let slCache = null;
let stilCache = null;

async function songlengths() {
  if (slCache) return slCache;
  const rec = await slRecord();
  if (!rec) return null;
  slCache = parseSonglengths(rec.text);
  return slCache;
}

async function stil() {
  if (stilCache) return stilCache;
  const rec = await stilRecord();
  if (!rec) return null;
  stilCache = stilIndex(rec.text);
  return stilCache;
}

export async function dbLoaded() {
  return {
    songlengths: !!(await songlengths()),
    stil: !!(await stil()),
  };
}

/** Songlengths entry for a whole-file md5. */
export async function lengthEntryForMd5(hex) {
  const sl = await songlengths();
  return sl ? sl.byMd5.get(hex.toLowerCase()) || null : null;
}

/** STIL entry for a full HVSC path ("/MUSICIANS/.../Tune.sid"). */
export async function stilEntryForPath(path) {
  const st = await stil();
  return st ? st.byPath.get(path) || null : null;
}

/** Whole-file MD5 as lowercase hex - the Songlengths.md5 key. */
export function fileMd5(bytes) {
  return md5(bytes);
}

/** The `.len` for a tune's bytes, or null (not in the database). */
export async function makeLen(bytes, hex = md5(bytes)) {
  const entry = await lengthEntryForMd5(hex);
  if (!entry || entry.lengths.length === 0) return null;
  return `${entry.lengths.join(' ')}\n`;
}

/** The `.stil` for a tune's HVSC path, or null (no STIL entry). */
export async function makeStil(path, songs) {
  const entry = await stilEntryForPath(path);
  return entry ? buildStil(entry, songs) : null;
}

/* ---------- what the page uploaded where ---------- */

/** Remember the HVSC identity of a device file (renamed tunes). */
export async function rememberUpload(deviceName, info) {
  const map = (await idbGet('uploads')) || {};
  map[deviceName] = { ...info, at: Date.now() };
  await idbPut('uploads', map);
}

export async function uploadInfo(deviceName) {
  const map = (await idbGet('uploads')) || {};
  return map[deviceName] || null;
}

/** The whole remembered device name -> HVSC identity map. */
export async function uploadMap() {
  return (await idbGet('uploads')) || {};
}

/** The HVSC ids of tunes uploaded from this browser whose device file is
 *  still in `files` (the /home listing). Search results use it to show
 *  "on device" instead of "upload": the id survives renaming/shortening,
 *  so a result is only marked when its own upload record is still
 *  present - two results can share one device file name, and then only
 *  the one that was actually uploaded counts. */
export function uploadedIds(uploads, files) {
  const present = new Set(files);
  const ids = new Set();
  for (const [deviceName, info] of Object.entries(uploads || {})) {
    if (info && info.id != null && present.has(deviceName)) {
      ids.add(String(info.id));
    }
  }
  return ids;
}

/** Case/punctuation-free comparison key: "RoboCop 3" and "RoboCop_3.sid"
 *  both give "robocop3"; "+" reads as "plus" ("IK+" == "IK_plus.sid"). */
export function nameKey(text) {
  return String(text || '')
    .replace(/\.sid$/i, '')
    .replace(/\+/g, 'plus')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Device listing -> keys for matching search results by title, for tunes
 *  that are on /home but have no upload record from this browser (added
 *  elsewhere, or uploaded before the page kept the map). `short` holds the
 *  16-character stems: deviceNameFor() cuts longer HVSC file names there,
 *  so "Neverending_Stor.sid" still matches "Neverending Story". */
export function deviceNameKeys(files) {
  const exact = new Set();
  const short = new Set();
  for (const f of files || []) {
    if (!/\.sid$/i.test(f)) continue;
    const stem = f.replace(/\.sid$/i, '');
    const k = nameKey(stem);
    if (!k) continue;
    exact.add(k);
    if (stem.length === 16) short.add(k);
  }
  return { exact, short };
}

/** True when a search result's title names a file in the device listing. */
export function onDeviceByTitle(keys, title) {
  const k = nameKey(title);
  if (!k) return false;
  if (keys.exact.has(k)) return true;
  for (const s of keys.short) {
    if (k.startsWith(s)) return true;
  }
  return false;
}

/**
 * The matching itself (pure - the caller supplies the parsed indexes,
 * the device file name, the device's whole-file md5 prefix and the
 * upload record from upload time):
 *
 *   1. the md5 prefix is the exact key (Songlengths.md5),
 *   2. the upload record covers tunes renamed / not yet in Songlengths,
 *   3. the case-sensitive file name is the last resort.
 *
 * Lengths and STIL always come from the same HVSC path. Returns null
 * when nothing matches; `source` says which key matched ('md5',
 * 'upload' or 'name') and `candidates` how many HVSC files share the
 * name.
 */
export function tuneLookup(sl, st, deviceName, id, remembered) {
  if (!sl && !st) return null;
  let len = null;
  let path = null;
  let source = null;
  let candidates = 0;

  if (id && sl && sl.byPrefix.has(id)) {
    const hits = sl.byPrefix.get(id);
    const list = Array.isArray(hits) ? hits : [hits];
    // 8 hex chars make a collision ~impossible (0 among the 61k HVSC
    // tunes), but keep a deterministic pick if it ever happens
    const hit = list.length === 1 ? list[0]
      : list.find((e) => e.path.split('/').pop() === deviceName) || null;
    if (hit) {
      len = hit;
      path = hit.path;
      source = 'md5';
    }
  }
  if (!path) {
    // The remembered path is a guess from upload time; drop it when the
    // device's own md5 says that name now holds a different tune.
    const stale = !!(remembered && remembered.md5 && id &&
      !remembered.md5.startsWith(id));
    if (remembered && remembered.path && !stale) {
      path = remembered.path;
      len = sl ? sl.byPath.get(path) || null : null;
      source = 'upload';
    }
  }
  if (!path && sl) {
    candidates = sl.byNameCount.get(deviceName) || 0;
    len = sl.byName.get(deviceName) || null;
    path = len ? len.path : null;
    if (len) source = 'name';
  }
  // Keep lengths and STIL from the same file: the path picks the entry
  const entry = (path && st) ? st.byPath.get(path) || null
    : (st ? st.byName.get(deviceName) || null : null);
  if (!len && !entry) return null;
  if (!source && entry) {
    source = 'name';
    candidates = candidates || (st.byNameCount.get(deviceName) || 0);
  }
  return {
    path: path || null,
    lengths: len ? len.lengths : null,
    names: entry ? entry.names : {},
    comment: entry ? entry.comment : '',
    subs: entry ? entry.subs : {},
    source,
    candidates,
  };
}

/**
 * Metadata for the tune the device is playing: lengths from
 * Songlengths, names/comment/notes from STIL, matched as described in
 * tuneLookup(). Returns null when neither database is loaded or
 * nothing matches.
 */
export async function tuneInfo(deviceName, id) {
  const [sl, st] = [await songlengths(), await stil()];
  if (!sl && !st) return null;
  const remembered = await uploadInfo(deviceName);
  return tuneLookup(sl, st, deviceName, id, remembered);
}
