/* Bare-metal FLPR SID render pump.
 *
 * cRSID_generateSample() frames into the shared ring; the M33 audio path
 * drains it and feeds I2S. The engine state lives in the M33 image at its
 * normal addresses - the blob links the same TU with every data symbol
 * mapped onto the M33 instance (see build.sh two-phase link) - so control
 * (load/init/play on the M33) and render (here) share state with zero
 * copies.
 *
 * No writable globals of our own (see startup.S): engine state is
 * M33-owned, counters live shared.
 */
#include "flpr_shared.h"
#include "crsid/libcRSID.h"

#define BURST 512 /* frames per outer iteration (heartbeat keeps moving) */

static void pump_sid(void)
{
	uint32_t w = FLPR_SHARED->write_idx;
	uint32_t r = FLPR_SHARED->read_idx;
	int n;

	for (n = 0; n < BURST; n++) {
		/* Ring full: overwrite oldest (the M33 resyncs its
		 * reader). Phase is engine-internal, so skipped slots cost
		 * samples, never continuity. */
		if ((uint32_t)(w - r) < FLPR_RING_FRAMES) {
			cRSID_Output s = cRSID_generateSample();

			/* Same truncation the M33 render path applies
			 * before its volume curve (the M33 applies the
			 * curve on drain, so the ring holds raw int16). */
			FLPR_RING[w % FLPR_RING_FRAMES] = (int16_t)s.L;
			w++;
		}
	}
	FLPR_SHARED->write_idx = w;
	FLPR_SHARED->rendered += (uint32_t)BURST;
}

static void pump_bench(void)
{
	uint32_t n = FLPR_SHARED->bench_frames;
	uint32_t fnv = 2166136261u;
	uint32_t i;

	for (i = 0; i < n; i++) {
		cRSID_Output s = cRSID_generateSample();

		fnv ^= (uint16_t)s.L;
		fnv *= 16777619u;
	}
	FLPR_SHARED->bench_sum = fnv;
	FLPR_SHARED->bench_done = 1U;
}

int main(void)
{
	FLPR_SHARED->heartbeat = 0u;
	FLPR_SHARED->status = 0u;
	FLPR_SHARED->write_idx = 0u;
	FLPR_SHARED->read_idx = 0u;
	FLPR_SHARED->rendered = 0u;
	FLPR_SHARED->bench_done = 0u;
	FLPR_SHARED->bench_sum = 0u;
	FLPR_SHARED->bench_us = 0u;
	FLPR_SHARED->run = 0u;
	FLPR_SHARED->run_ack = 0u;
	/* Publish last: the M33 treats magic as "blob alive". */
	FLPR_SHARED->magic = FLPR_MAGIC;

	for (;;) {
		if (FLPR_SHARED->run) {
			if (FLPR_SHARED->mode == 2u) {
				pump_bench();
				FLPR_SHARED->run = 0U;
			} else {
				pump_sid();
			}
		}
		/* Acknowledge `run` after the burst: the M33 waits for 0
		 * before it touches engine state (load/play/subtune). */
		FLPR_SHARED->run_ack = FLPR_SHARED->run;
		FLPR_SHARED->heartbeat++;
	}

	/* Unreachable. */
	return 0;
}
