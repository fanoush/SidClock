/*
 * flpr_shared.h - M33 <-> FLPR shared-memory contract (bare-metal SID render).
 *
 * The M33 side is wired in app/flpr.overlay (reserved RAM + mailbox);
 * the FLPR blob side in flpr/linker.ld. The blob's code has no fixed
 * address: it is embedded in the M33 image as flpr_blob[] (see
 * flpr/blob_to_c.py) and the M33 starts it with INITPC = its address.
 *
 * Data sharing is by runtime pointer, never by linked symbol: the two
 * images are separate ELFs, and the M33 .bss addresses shift with every
 * rebuild. The M33 owns all state; the blob only touches the regions
 * below. Single producer (FLPR) / single consumer (M33): the index
 * words are each written by one side only, so no lock is needed (both
 * cores see the same SRAM with no data cache; indices are volatile).
 */
#ifndef FLPR_SHARED_H
#define FLPR_SHARED_H

#include <stdint.h>

/* FLPR private RAM: the blob is copied here by the M33 and executed
 * from here (RAM01 fetches never contend with M33 RRAM fetches), with a
 * 1 KB stack on top. */
#define FLPR_PRIV_BASE 0x2003F000UL
#define FLPR_PRIV_SIZE 0x00000C00UL /* 3 KB: 1 KB stack on top, rest slack */

/* Hot engine code: executed from the FLPR's own SRAM instead of RRAM.
 * Code fetched from RRAM costs ~3 cycles per instruction on this core
 * (it has no instruction cache); from SRAM it is ~1. Measured with the
 * same 4-instruction loop: 15.3 vs 5.1 cycles/iteration (see
 * docs/flpr.md). The M33 keeps its own SRAM - this is the FLPR-side
 * window. */
#define FLPR_CODERAM_BASE 0x2002F000UL
#define FLPR_CODERAM_SIZE 0x0000D000UL /* 52 KB: cRSID_emulateC64 */

/* PCM ring: int16 mono frames, written by the FLPR, drained by the M33
 * audio path. 8 KB (4096 frames, ~0.19 s at 22 kHz) rides out the M33's
 * flash/UI stalls now that the hot engine code runs from SRAM and keeps
 * up with realtime.
 *
 * FRAMES is derived from the byte size on purpose: it holds int16
 * samples, so the index range is exactly half the byte size. Both cores
 * bound their accesses with it, and a frames/bytes mix-up once walked
 * the ring past its reserved window into private RAM, the mailbox and
 * finally past the end of SRAM (M33 bus fault at 0x20043460).
 * blob_audit.py --check-ram enforces the relation and the layout. */
#define FLPR_RING_BASE 0x2003C000UL
#define FLPR_RING_SIZE 0x00002000UL /* 8 KB of int16 frames */
#define FLPR_RING_FRAMES (FLPR_RING_SIZE / 2U) /* 4096 frames */

/* --- split mode: M33 runs the C64/CPU, the FLPR runs the SID ---------
 *
 * The SID stage is ~59% of the emulation and the 6510 interpreter ~41%,
 * so the engine is split at the existing boundary: the M33 runs the
 * per-instruction cycle loop (CPU, CIA/VIC, memory) and records the
 * instruction cycles of every sample, the FLPR advances the ADSR and
 * runs the per-sample SID waveform/filter stage into the audio ring.
 *
 * The SID instances live here (FLPR SRAM) so the blob touches them
 * locally; the M33 creates/initialises them through the same pointer
 * (both cores see all SRAM). The register block is mirrored by the M33
 * on every SID write, so the blob reads registers locally too.
 */
#define FLPR_SPLIT_BASE 0x2003E000UL
#define FLPR_SPLIT_SIZE 0x00001000UL /* 4 KB */

#define FLPR_SID_BASE (FLPR_SPLIT_BASE + 0x0000UL) /* 5 x 448 B instances */
#define FLPR_SID_REGS (FLPR_SPLIT_BASE + 0x08C0UL) /* $D400..$D41F mirror */
#define FLPR_SID_RDBK (FLPR_SPLIT_BASE + 0x08E0UL) /* $D419..$D41F readback */
#define FLPR_SID_CYCLES (FLPR_SPLIT_BASE + 0x0900UL) /* u16 per sample */
#define FLPR_SID_RING 640U /* two audio buffers of cycle counts */

/* Shared split control (same page). */
#define FLPR_SPLIT_CTRL (FLPR_SPLIT_BASE + 0x0E00UL)

struct flpr_split {
	uint32_t enable;  /* 1 = split mode active */
	uint32_t prod;    /* samples the M33 has emulated */
	uint32_t cons;    /* samples the FLPR has rendered */
	uint32_t reinit;  /* bumped by the M33 on load/reset */
	uint32_t reinit_ack;
};

#define FLPR_SPLIT ((volatile struct flpr_split *)FLPR_SPLIT_CTRL)
#define FLPR_SID_CYC ((volatile uint16_t *)FLPR_SID_CYCLES)
#define FLPR_SID_REGP ((volatile uint8_t *)FLPR_SID_REGS)
#define FLPR_SHARED_BASE 0x2003FC00UL
#define FLPR_SHARED_SIZE 0x00000400UL

#define FLPR_MAGIC 0x464C5052UL /* "FLPR" */

struct flpr_shared {
	uint32_t magic;     /* FLPR_MAGIC once the blob has booted */
	uint32_t heartbeat; /* ++ each blob iteration */
	uint32_t status;    /* blob-defined status flags */
	uint32_t control;   /* reserved */
	/* SID pipe (M33 writes run/rate/mode, blob writes the rest): */
	uint32_t mode;      /* 1 = SID render, 2 = engine bench, 3 = ALU loop */
	uint32_t rate_hz;   /* render rate (M33 hw_rate) */
	uint32_t run;       /* 1 = render into the ring (M33 writes) */
	uint32_t run_ack;   /* blob mirrors `run` each iteration, so the
			     * M33 can wait for the render to actually stop
			     * before it mutates engine state (load/play) */
	uint32_t write_idx; /* absolute frames produced (blob) */
	uint32_t read_idx;  /* absolute frames consumed (M33) */
	uint32_t underruns; /* M33-side shortfall counter */
	uint32_t rendered;  /* total frames produced (blob) */
	/* One-shot bench (mode 2): M33 sets frames, blob renders that many
	 * into the checksum (not the ring) and raises done; the M33 waiter
	 * stamps bench_us and copies both to the snapshot tail. Advances
	 * tune state (replay the tune after). */
	uint32_t bench_frames;
	uint32_t bench_done;
	uint32_t bench_sum;
	uint32_t bench_us;
	/* Hardware counters around the same render (blob writes): cycles and
	 * retired instructions let the host compare code variants exactly
	 * (cycles/frame, IPC) and derive the effective core clock. */
	uint32_t bench_cycles;
	uint32_t bench_instr;
	uint32_t scratch[2]; /* spare */
};

#define FLPR_SHARED ((volatile struct flpr_shared *)FLPR_SHARED_BASE)
#define FLPR_RING ((volatile int16_t *)FLPR_RING_BASE)

#endif /* FLPR_SHARED_H */
