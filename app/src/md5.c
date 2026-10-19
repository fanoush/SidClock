/*
 * md5.c - small MD5 (RFC 1321) for identifying the loaded tune.
 *
 * Written from the standard formulation (no allocation; the whole
 * context lives on the caller's stack). See md5.h.
 */

#include "md5.h"

#include <string.h>

#define F(x, y, z) (((x) & (y)) | (~(x) & (z)))
#define G(x, y, z) (((x) & (z)) | ((y) & ~(z)))
#define H(x, y, z) ((x) ^ (y) ^ (z))
#define I(x, y, z) ((y) ^ ((x) | ~(z)))
#define ROTL(x, n) (((x) << (n)) | ((x) >> (32 - (n))))

/* T[i] = floor(2^32 * abs(sin(i + 1))) (RFC 1321). */
static const uint32_t md5_t[64] = {
	0xd76aa478U, 0xe8c7b756U, 0x242070dbU, 0xc1bdceeeU,
	0xf57c0fafU, 0x4787c62aU, 0xa8304613U, 0xfd469501U,
	0x698098d8U, 0x8b44f7afU, 0xffff5bb1U, 0x895cd7beU,
	0x6b901122U, 0xfd987193U, 0xa679438eU, 0x49b40821U,
	0xf61e2562U, 0xc040b340U, 0x265e5a51U, 0xe9b6c7aaU,
	0xd62f105dU, 0x02441453U, 0xd8a1e681U, 0xe7d3fbc8U,
	0x21e1cde6U, 0xc33707d6U, 0xf4d50d87U, 0x455a14edU,
	0xa9e3e905U, 0xfcefa3f8U, 0x676f02d9U, 0x8d2a4c8aU,
	0xfffa3942U, 0x8771f681U, 0x6d9d6122U, 0xfde5380cU,
	0xa4beea44U, 0x4bdecfa9U, 0xf6bb4b60U, 0xbebfbc70U,
	0x289b7ec6U, 0xeaa127faU, 0xd4ef3085U, 0x04881d05U,
	0xd9d4d039U, 0xe6db99e5U, 0x1fa27cf8U, 0xc4ac5665U,
	0xf4292244U, 0x432aff97U, 0xab9423a7U, 0xfc93a039U,
	0x655b59c3U, 0x8f0ccc92U, 0xffeff47dU, 0x85845dd1U,
	0x6fa87e4fU, 0xfe2ce6e0U, 0xa3014314U, 0x4e0811a1U,
	0xf7537e82U, 0xbd3af235U, 0x2ad7d2bbU, 0xeb86d391U,
};

/* Per-step left rotation (RFC 1321). */
static const uint8_t md5_s[64] = {
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
};

static uint32_t rd32le(const uint8_t *p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
	       ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void wr32le(uint8_t *p, uint32_t v)
{
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
	p[2] = (uint8_t)(v >> 16);
	p[3] = (uint8_t)(v >> 24);
}

/* Compress one 64-byte block. */
static void md5_block(struct md5_ctx *ctx, const uint8_t *p)
{
	uint32_t m[16];
	uint32_t a = ctx->a, b = ctx->b, c = ctx->c, d = ctx->d;
	int i;

	for (i = 0; i < 16; i++) {
		m[i] = rd32le(p + 4 * i);
	}
	for (i = 0; i < 64; i++) {
		uint32_t f, g;

		if (i < 16) {
			f = F(b, c, d);
			g = (uint32_t)i;
		} else if (i < 32) {
			f = G(b, c, d);
			g = (5U * (uint32_t)i + 1U) & 15U;
		} else if (i < 48) {
			f = H(b, c, d);
			g = (3U * (uint32_t)i + 5U) & 15U;
		} else {
			f = I(b, c, d);
			g = (7U * (uint32_t)i) & 15U;
		}
		f += a + md5_t[i] + m[g];
		a = d;
		d = c;
		c = b;
		b += ROTL(f, md5_s[i]);
	}
	ctx->a += a;
	ctx->b += b;
	ctx->c += c;
	ctx->d += d;
}

void md5_init(struct md5_ctx *ctx)
{
	ctx->a = 0x67452301U;
	ctx->b = 0xefcdab89U;
	ctx->c = 0x98badcfeU;
	ctx->d = 0x10325476U;
	ctx->nbytes = 0U;
	ctx->fill = 0U;
}

void md5_update(struct md5_ctx *ctx, const void *data, size_t len)
{
	const uint8_t *p = data;

	if (len == 0U) {
		return;
	}
	ctx->nbytes += len;
	if (ctx->fill != 0U) {
		size_t take = 64U - ctx->fill;

		if (take > len) {
			take = len;
		}
		memcpy(ctx->buf + ctx->fill, p, take);
		ctx->fill += (uint8_t)take;
		p += take;
		len -= take;
		if (ctx->fill == 64U) {
			md5_block(ctx, ctx->buf);
			ctx->fill = 0U;
		}
	}
	while (len >= 64U) {
		md5_block(ctx, p);
		p += 64U;
		len -= 64U;
	}
	if (len > 0U) {
		memcpy(ctx->buf, p, len);
		ctx->fill = (uint8_t)len;
	}
}

void md5_final(struct md5_ctx *ctx, uint8_t out[16])
{
	uint64_t bits = ctx->nbytes << 3;
	uint8_t pad[72];
	size_t padlen;
	int i;

	/* 0x80, then zeros so that the length lands in bytes 56..63. */
	padlen = (ctx->fill < 56U) ? (56U - ctx->fill) : (120U - ctx->fill);
	memset(pad, 0, padlen);
	pad[0] = 0x80U;
	for (i = 0; i < 8; i++) {
		pad[padlen + (size_t)i] = (uint8_t)(bits >> (8 * i));
	}
	md5_update(ctx, pad, padlen + 8U);

	wr32le(out, ctx->a);
	wr32le(out + 4, ctx->b);
	wr32le(out + 8, ctx->c);
	wr32le(out + 12, ctx->d);
	memset(ctx, 0, sizeof(*ctx));
}
