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
#define FLPR_PRIV_BASE 0x2003E000UL
#define FLPR_PRIV_SIZE 0x00001C00UL /* 7 KB */

/* PCM ring: int16 mono frames, written by the FLPR, drained by the M33
 * audio path. 32 KB (16384 frames, ~0.74 s at 22 kHz) absorbs RRAM
 * fetch-contention bursts: the XIP blob stalls whenever the M33 reads
 * flash (UI draws, marquee), and the ring rides through instead of
 * underrunning. Phase is a function of the absolute sample index, so
 * overruns cost samples, never continuity.
 *
 * FRAMES is derived from the byte size on purpose: it holds int16
 * samples, so the index range is exactly half the byte size. Both cores
 * bound their accesses with it, and a frames/bytes mix-up once walked
 * the ring past its reserved window into private RAM, the mailbox and
 * finally past the end of SRAM (M33 bus fault at 0x20043460).
 * blob_audit.py --check-ram enforces the relation and the layout. */
#define FLPR_RING_BASE 0x20034000UL
#define FLPR_RING_SIZE 0x00008000UL /* 32 KB of int16 frames */
#define FLPR_RING_FRAMES (FLPR_RING_SIZE / 2U) /* 16384 frames */

/* Shared control struct (1 KB at the top of SRAM). */
#define FLPR_SHARED_BASE 0x2003FC00UL
#define FLPR_SHARED_SIZE 0x00000400UL

#define FLPR_MAGIC 0x464C5052UL /* "FLPR" */

struct flpr_shared {
	uint32_t magic;     /* FLPR_MAGIC once the blob has booted */
	uint32_t heartbeat; /* ++ each blob iteration */
	uint32_t status;    /* blob-defined status flags */
	uint32_t control;   /* reserved */
	/* SID pipe (M33 writes run/rate/mode, blob writes the rest): */
	uint32_t mode;      /* 1 = SID render, 2 = one-shot bench */
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
	uint32_t scratch[2]; /* spare */
};

#define FLPR_SHARED ((volatile struct flpr_shared *)FLPR_SHARED_BASE)
#define FLPR_RING ((volatile int16_t *)FLPR_RING_BASE)

#endif /* FLPR_SHARED_H */
