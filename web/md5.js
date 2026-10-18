/*
 * MD5 (RFC 1321) over bytes.
 *
 * HVSC's Songlengths.md5 database is keyed on the MD5 of the whole tune
 * file, and WebCrypto has no MD5, so the page brings its own. Tunes are
 * ~50 KB, so a plain one-shot implementation is plenty.
 */

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

/* per-round left-rotation amounts, grouped by round */
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

const rotl = (x, c) => (x << c) | (x >>> (32 - c));

/* the state words are serialized little-endian */
function hex32(v) {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += ((v >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

/** MD5 of a Uint8Array, as a lowercase hex string. */
export function md5(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array((len + 9 + 63) & ~63);
  padded.set(bytes);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 4294967296) >>> 0, true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a;
    let B = b;
    let C = c;
    let D = d;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      B = (B + rotl((A + f + K[i] + M[g]) | 0, S[(i >> 4) * 4 + (i & 3)])) | 0;
      A = tmp;
    }
    a = (a + A) | 0;
    b = (b + B) | 0;
    c = (c + C) | 0;
    d = (d + D) | 0;
  }
  return hex32(a) + hex32(b) + hex32(c) + hex32(d);
}
