/* Bare-metal FLPR spike step 3: SID render pump + sine test.
 *
 * Mode 0 (sine): the step-2 test tone, kept as a pipe self-test.
 * Mode 1 (SID): cRSID_generateSample() frames into the shared ring.
 * The engine state lives in the M33 image at its normal addresses -
 * the blob links the same TU with every data symbol mapped onto the
 * M33 instance (see build.sh two-phase link) - so control (load/init/
 * play on the M33) and render (here) share state with zero copies.
 *
 * No writable globals of our own (see startup.S): the sine table lives
 * on the stack, engine state is M33-owned, counters live shared.
 */
#include "flpr_shared.h"
#include "crsid/libcRSID.h"

#define SINE_STEPS 256
#define SINE_AMP 30000
#define BURST 512 /* frames per outer iteration (heartbeat keeps moving) */

static void sine_table(int16_t *tab)
{
	/* One period via complex rotation in Q15 (32-bit products stay
	 * below 2^31 by Cauchy-Schwarz, so no 64-bit math - the blob
	 * links no libgcc and any hidden libcall fails the build). */
	int32_t c = 32758; /* cos(2*pi/256) */
	int32_t s = 804;   /* sin(2*pi/256) */
	int32_t re = 32767;
	int32_t im = 0;
	int i;

	for (i = 0; i < SINE_STEPS; i++) {
		int32_t re_next = (re * c - im * s) >> 15;
		int32_t im_next = (re * s + im * c) >> 15;

		tab[i] = (int16_t)re;
		re = re_next;
		im = im_next;
	}
}

static void pump_sine(const int16_t *tab, uint32_t step)
{
	uint32_t w = FLPR_SHARED->write_idx;
	uint32_t r = FLPR_SHARED->read_idx;
	int n;

	for (n = 0; n < BURST; n++) {
		/* Ring full: overwrite oldest. Phase is a pure function
		 * of the absolute index in 16.16 fixed point (table
		 * index = top 8 bits of the integer part), so skipped
		 * slots cost samples,
		 * never continuity; the M33 resyncs its reader. */
		if ((uint32_t)(w - r) < FLPR_RING_FRAMES) {
			uint32_t ph = w * step;
			int32_t v = ((int32_t)tab[(ph >> 8) & 0xFF]
				     * SINE_AMP) >> 15;

			FLPR_RING[w % FLPR_RING_FRAMES] = (int16_t)v;
			w++;
		}
	}
	FLPR_SHARED->write_idx = w;
	FLPR_SHARED->rendered += (uint32_t)BURST;
}

static void pump_sid(void)
{
	uint32_t w = FLPR_SHARED->write_idx;
	uint32_t r = FLPR_SHARED->read_idx;
	int n;

	for (n = 0; n < BURST; n++) {
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
	int16_t tab[SINE_STEPS];
	uint32_t step = 0;
	uint32_t last_freq = 0;
	uint32_t last_rate = 0;

	sine_table(tab);
	FLPR_SHARED->heartbeat = 0u;
	FLPR_SHARED->status = 0u;
	FLPR_SHARED->write_idx = 0u;
	FLPR_SHARED->read_idx = 0u;
	FLPR_SHARED->rendered = 0u;
	FLPR_SHARED->bench_done = 0u;
	FLPR_SHARED->bench_sum = 0u;
	FLPR_SHARED->bench_us = 0u;
	/* Publish last: the M33 treats magic as "blob alive". */
	FLPR_SHARED->magic = FLPR_MAGIC;

	for (;;) {
		if (FLPR_SHARED->run) {
			if (FLPR_SHARED->mode == 2u) {
				pump_bench();
				FLPR_SHARED->run = 0U;
			} else if (FLPR_SHARED->mode == 1u) {
				pump_sid();
			} else {
				uint32_t freq = FLPR_SHARED->freq_hz;
				uint32_t rate = FLPR_SHARED->rate_hz;

				if (freq != last_freq || rate != last_rate) {
					/* freq <= 30000: (freq << 16) fits
					 * 32 bits, so no 64-bit division
					 * (no libgcc). */
					step = rate ? ((freq << 16) +
						       (rate >> 1)) / rate :
						    0u;
					last_freq = freq;
					last_rate = rate;
				}
				pump_sine(tab, step);
			}
		}
		FLPR_SHARED->heartbeat++;
	}

	/* Unreachable. */
	return 0;
}
