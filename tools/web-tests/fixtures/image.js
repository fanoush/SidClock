/*
 * A tiny, structurally valid MCUboot image (version 1.0.11) for the update
 * tests. 32-byte header + 512-byte body + a SHA-256 TLV, 584 bytes total:
 * small enough to commit, real enough that update.js has to parse the
 * header, walk the TLV area and verify the hash exactly as it would for a
 * release image.
 *
 * Generated once with Python:
 *   header  magic 0x96f3b83d, hdr_size 32, img_size 512, version 1.0.11
 *   tlv     magic 0x6907, total 40, type 0x10 (SHA-256) = sha256(header+body)
 */

export const IMAGE_BASE64 =
  'PbjzlgAAAAAgAAAAAAIAAAAAAAABAAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdpKAAQACAAolkjN5Y7lIHnnTD+YD9JeIYbnlk2DuVze1tilwuwshs=';

export const IMAGE_SIZE = 584;
export const IMAGE_VERSION = '1.0.11';
/** MCUboot SHA-256 TLV (header + body): what `image state-write` arms. */
export const IMAGE_HASH =
  'a2592337963b9481e79d30fe603f4978861b9e59360ee5737b5b62970bb0b21b';
/** SHA-256 of the whole file: what the manifest publishes. */
export const FILE_SHA256 =
  '7e0dbfd7b186cc64f60ad688599f8c0583ae966b7e487538a286e01d80c65b6a';

/** The fixture bytes (atob exists in every browser; tests only run there). */
export function imageBytes() {
  const raw = atob(IMAGE_BASE64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
