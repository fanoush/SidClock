/* Blob-private odds and ends (all in private RAM, M33 never touches).
 *
 * sid_frame_calls: the engine (C64.c) expects the app to define this
 * play-routine frame counter. The M33 has its own instance for its own
 * renders; this one counts blob-side frames for diagnostics.
 *
 * memcpy/memset: the engine TU references them (kept or dropped by
 * --gc-sections depending on the render closure); freestanding
 * implementations so the blob links no libc.
 *
 * libcsid_stream_fill: the engine's file loader calls it when non-NULL;
 * only the M33 runs the loader, so the blob's instance stays NULL (the
 * loader checks before calling). Present so the link never needs the
 * M33 shim object.
 */
#include <stddef.h>
#include "crsid/libcRSID.h"

int sid_frame_calls;

#ifndef FLPR_WITH_ENGINE
/* Phase-1 link (engine TU absent): keep the pump linkable. Silence. */
cRSID_Output cRSID_generateSample(void)
{
	cRSID_Output s;

	s.L = 0;
	s.R = 0;
	return s;
}
#endif

int (*libcsid_stream_fill)(unsigned char *dst, int max);

int abs(int x)
{
	return x < 0 ? -x : x;
}

void *memcpy(void *dst, const void *src, size_t n)
{
	unsigned char *d = dst;
	const unsigned char *s = src;

	while (n--) {
		*d++ = *s++;
	}
	return dst;
}

void *memset(void *dst, int c, size_t n)
{
	unsigned char *d = dst;

	while (n--) {
		*d++ = (unsigned char)c;
	}
	return dst;
}
