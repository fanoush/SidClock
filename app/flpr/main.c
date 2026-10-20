/* Bare-metal FLPR CPU pump for the split engine.
 *
 * The blob runs the C64/CPU emulation (cRSID_generateSample with the SID
 * stage compiled out, see C64.c) ahead of the M33: each sample's
 * instruction cycle count goes into the shared cycle ring and every SID
 * register write becomes a timestamped event. The M33 (SID side) renders
 * the audio from those into I2S. Engine state lives in the M33 image at
 * its normal addresses - the blob links the same TU with every data
 * symbol mapped onto the M33 instance (see build.sh two-phase link).
 *
 * No writable globals of our own (see startup.S): engine state is
 * M33-owned, counters live shared.
 */
#include "flpr_shared.h"
#include "crsid/libcRSID.h"
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

/* Split mode: run the C64/CPU ahead of the M33's SID rendering. Each
 * sample's instruction cycles go into the shared ring and every SID
 * register write becomes a timestamped event (see C64.c). */
#define SPLIT_LEAD 320U /* samples of lookahead the M33 keeps buffered */

/* Returns the cycles spent producing samples, 0 when the lead was already
 * full: charging the empty calls would make the spin between buffers read
 * as ~100% load. No writable globals allowed in the blob (.bss check).
 *
 * In SRAM with the interpreter: this is where cRSID_generateSample() is
 * inlined, i.e. called once per audio frame. */
static __attribute__((section(".flprhot"), noinline)) uint32_t pump_split(void)
{
	uint32_t c0 = mcycle();
	uint32_t n = 0U;

	while ((uint32_t)(FLPR_SPLIT->prod - FLPR_SPLIT->cons) < SPLIT_LEAD) {
		cRSID_generateSample(); /* CPU only in split mode: no SID, no audio */
		n++;
	}

	return n != 0U ? mcycle() - c0 : 0U;
}

/* Permille of wall cycles in the CPU pump over a window. Reads the same
 * mcycle counter the ALU probe uses; the window (32 M cycles, ~0.25 s at
 * 128 MHz) is short against the 32-bit wrap (33 s). Scaled before the
 * multiply so 32-bit math cannot overflow. */
#define LOAD_WINDOW 32000000U

static uint32_t load_permille(uint32_t busy, uint32_t total)
{
	uint32_t b = busy >> 15;
	uint32_t t = total >> 15;

	return t ? (b * 1000U) / t : 0U;
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
	FLPR_SHARED->bench_done = 0u;
	FLPR_SHARED->bench_sum = 0u;
	FLPR_SHARED->bench_us = 0u;
	FLPR_SHARED->bench_cycles = 0u;
	FLPR_SHARED->bench_instr = 0u;
	FLPR_SHARED->run = 0u;
	FLPR_SHARED->run_ack = 0u;
	/* Publish last: the M33 treats magic as "blob alive". */
	FLPR_SHARED->magic = FLPR_MAGIC;

	uint32_t w0 = mcycle();
	uint32_t wbusy = 0U;

	for (;;) {
		if (FLPR_SHARED->run) {
			if (FLPR_SHARED->mode == 3u) {
				pump_alu(); /* core-speed probe */
				FLPR_SHARED->run = 0U;
			} else {
				/* split: run the C64/CPU ahead */
				wbusy += pump_split();
			}
		}
		{
			uint32_t now = mcycle();

			if ((uint32_t)(now - w0) >= LOAD_WINDOW) {
				/* Production time over wall time. Only the
				 * generating calls are charged (split_busy),
				 * so the idle spin between buffers does not
				 * read as load. */
				FLPR_SHARED->cpu_load =
					load_permille(wbusy, now - w0);
				wbusy = 0U;
				w0 = now;
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
