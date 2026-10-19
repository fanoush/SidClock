/*
 * md5.h - small MD5 (RFC 1321) for identifying the loaded tune.
 *
 * The context is ~96 bytes with no allocation, so callers keep it on the
 * stack for the duration of one hash and retain only the result. Used to
 * report a whole-file MD5 prefix over BLE: HVSC's Songlengths.md5 is
 * keyed on exactly this digest, which makes a tune's identity exact
 * where the file name is not (HVSC has thousands of duplicate names).
 */
#ifndef MD5_H_
#define MD5_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct md5_ctx {
	uint32_t a, b, c, d; /* running state */
	uint64_t nbytes;     /* total input length */
	uint8_t buf[64];     /* partial block */
	uint8_t fill;        /* bytes buffered, 0..63 */
};

void md5_init(struct md5_ctx *ctx);
void md5_update(struct md5_ctx *ctx, const void *data, size_t len);
/* Writes the 16-byte digest; the context is spent afterwards. */
void md5_final(struct md5_ctx *ctx, uint8_t out[16]);

#ifdef __cplusplus
}
#endif

#endif /* MD5_H_ */
