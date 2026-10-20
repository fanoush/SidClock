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

/* Split mode: one SID-only sample (defined in the engine's C64.c). */
extern cRSID_Output cRSID_emulateSplitSample(void);

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

/* The VPR resets with its counters inhibited (Nordic's HAL has an
 * explicit enable); without this mcycle/minstret read 0. */
static inline void counters_enable(void)
{
	__asm__ volatile("csrw mcountinhibit, zero");
}

/* VPR machine counters (standard RISC-V CSRs, see nrf_vpr_csr.h). */
static inline uint32_t mcycle(void)
{
	uint32_t v;

	__asm__ volatile("csrr %0, mcycle" : "=r"(v));
	return v;
}

static inline uint32_t minstret(void)
{
	uint32_t v;

	__asm__ volatile("csrr %0, minstret" : "=r"(v));
	return v;
}

static void pump_bench(void)
{
	uint32_t n = FLPR_SHARED->bench_frames;
	uint32_t fnv = 2166136261u;
	uint32_t c0 = mcycle();
	uint32_t i0 = minstret();
	uint32_t i;

	for (i = 0; i < n; i++) {
		cRSID_Output s = cRSID_generateSample();

		fnv ^= (uint16_t)s.L;
		fnv *= 16777619u;
	}
	FLPR_SHARED->bench_cycles = mcycle() - c0;
	FLPR_SHARED->bench_instr = minstret() - i0;
	FLPR_SHARED->bench_sum = fnv;
	FLPR_SHARED->bench_done = 1U;
}

/* Split mode: the M33 has already run the CPU for each sample and
 * recorded its instruction cycles; advance the ADSR and run the SID
 * stage, one sample per cycle-ring entry, into the audio ring. */
static void pump_split(void)
{
	while (FLPR_SPLIT->cons != FLPR_SPLIT->prod) {
		uint32_t w = FLPR_SHARED->write_idx;
		uint32_t r = FLPR_SHARED->read_idx;
		cRSID_Output o;

		if ((uint32_t)(w - r) >= FLPR_RING_FRAMES) {
			break; /* ring full: the M33 drains first */
		}
		o = cRSID_emulateSplitSample();
		FLPR_RING[w % FLPR_RING_FRAMES] = (int16_t)o.L;
		FLPR_SHARED->write_idx = w + 1;
	}
}

static void pump_alu(void)
{
	uint32_t n = FLPR_SHARED->bench_frames;
	uint32_t c0 = mcycle();
	uint32_t i0 = minstret();
	uint32_t acc = 0;
	uint32_t i;

	/* Register-only loop: a handful of always-hot instructions, no data
	 * traffic. Its cycles/instruction is the core's baseline IPC, which
	 * tells a slow-by-design core apart from fetch/memory stalls in the
	 * engine. */
	for (i = 0; i < n; i++) {
		acc += i ^ 0x5a5a5a5au;
	}
	FLPR_SHARED->bench_cycles = mcycle() - c0;
	FLPR_SHARED->bench_instr = minstret() - i0;
	FLPR_SHARED->bench_sum = acc;
	FLPR_SHARED->bench_done = 1U;
}

int main(void)
{
	counters_enable();
	FLPR_SHARED->heartbeat = 0u;
	FLPR_SHARED->status = 0u;
	FLPR_SHARED->write_idx = 0u;
	FLPR_SHARED->read_idx = 0u;
	FLPR_SHARED->rendered = 0u;
	FLPR_SHARED->bench_done = 0u;
	FLPR_SHARED->bench_sum = 0u;
	FLPR_SHARED->bench_us = 0u;
	FLPR_SHARED->bench_cycles = 0u;
	FLPR_SHARED->bench_instr = 0u;
	FLPR_SHARED->run = 0u;
	FLPR_SHARED->run_ack = 0u;
	/* Publish last: the M33 treats magic as "blob alive". */
	FLPR_SHARED->magic = FLPR_MAGIC;

	for (;;) {
		if (FLPR_SHARED->run) {
			if (FLPR_SHARED->mode == 2u) {
				pump_bench();
				FLPR_SHARED->run = 0U;
			} else if (FLPR_SHARED->mode == 3u) {
				pump_alu();
				FLPR_SHARED->run = 0U;
			} else if (FLPR_SHARED->mode == 4u) {
				pump_split();
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
