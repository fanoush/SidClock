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

/* Event ring region (8 KB). The whole-engine mode used this as an int16
 * PCM ring; it was removed (too slow on the FLPR), and the split engine
 * uses the same window for SID-write events (FLPR_EVENTS below).
 *
 * The size is still expressed as int16 frames because blob_audit.py
 * --check-ram validates the FLPR RAM map through FLPR_RING_BASE/SIZE
 * (and a frames/bytes mix-up once walked this window into private RAM,
 * the mailbox and past the end of SRAM: M33 bus fault at 0x20043460). */
#define FLPR_RING_BASE 0x2003C000UL
#define FLPR_RING_SIZE 0x00002000UL /* 8 KB event window */
#define FLPR_RING_FRAMES (FLPR_RING_SIZE / 2U) /* 4096 entries */

/* --- split engine (B): FLPR runs the C64/CPU, the M33 the SID stage --
 *
 * The 6510 interpreter is ~41% of the emulation and is cheaper on the
 * FLPR (18 us/frame) than on the M33 (25.5 us), while the SID stage is
 * ~5 us on the M33 but ~26 us on the FLPR. So the blob runs the
 * per-instruction cycle loop (CPU, CIA/VIC, memory) ahead of the M33 and
 * records each sample's instruction cycles plus every SID register
 * write as a timestamped event; the M33 applies the events and runs the
 * per-sample SID waveform/filter stage into I2S in its fill path.
 *
 * The SID instances stay in the M33 image (the blob never touches
 * them); only the register copy below is shared, so the blob can record
 * "$D4xx = value" events without knowing which SID chip is mapped where.
 */
#define FLPR_SPLIT_BASE 0x2003E000UL
#define FLPR_SPLIT_SIZE 0x00001000UL /* 4 KB */

#define FLPR_SID_CYCLES (FLPR_SPLIT_BASE + 0x0000UL) /* u16 per sample */
/* Cycle ring: lead + one audio buffer of look-ahead, sized for the
 * 44.1 kHz split rate (640 + 320 = 960, rounded to 1280) so the
 * 22.05 kHz mode has room to spare. 1280 * 2 B = 2.5 KB, which is why
 * the register copy below starts at +0xC00. */
#define FLPR_SID_RING 1280U
/* M33 SID register copy: 32 bytes per chip, so 2SID/3SID tunes see their
 * extra chips' writes (the blob cannot touch the M33's IO bank). */
#define FLPR_SID_REGCOPY (FLPR_SPLIT_BASE + 0x0C00UL)
#define FLPR_SID_REGCOPY_SIZE 128U /* 4 chips x 32 registers (CRSID_SIDCOUNT_MAX) */

/* SID register-write events, FLPR -> M33. The blob (CPU) runs ahead of
 * the M33's SID rendering, so a write must carry the sample it belongs
 * to; the M33 applies it to its own register copy right before it
 * renders that sample. `cyc` is the cycle offset inside that sample
 * (cycles elapsed since the sample started), so the M33 can replay the
 * sample's envelope cycles up to the write, apply it, and continue:
 * without it a gate-off/gate-on pair (hard restart) in one sample
 * collapses and the note-on is lost. The ring shares the PCM ring
 * region: the two modes (whole engine on the blob, split) never run
 * together. */
#define FLPR_EVENTS_MAX 1024U /* 8 KB / sizeof(struct flpr_event) */
struct flpr_event {
	uint32_t pos; /* sample index */
	uint8_t cyc;  /* cycle offset inside the sample (0..~50) */
	uint8_t reg;  /* offset in the chip's 32-byte register file */
	uint8_t val;
	uint8_t chip; /* SID instance 1..CRSID_SIDCOUNT_MAX */
};
/* Shared split control (same page). */
#define FLPR_SPLIT_CTRL (FLPR_SPLIT_BASE + 0x0E00UL)

struct flpr_split {
	uint32_t enable;   /* 1 = split mode active */
	uint32_t prod;     /* samples the blob has emulated (CPU) */
	uint32_t cons;     /* samples the M33 has rendered (SID) */
	uint32_t eprod;    /* SID write events produced */
	uint32_t econs;    /* SID write events consumed */
	/* Cycles elapsed in the sample being emulated (blob writes it after
	 * every instruction): the cycle offset tagged on each SID write. */
	uint32_t cur_cyc;
	/* Health, all written by the M33's SID side:
	 * lead = prod - cons (samples the blob is ahead). The blob pumps
	 * to 320, so `lead_min` near 320 over a window means it keeps up
	 * easily; a lead that collapses towards 0 is the FLPR running at
	 * (or past) 100% and the M33 starting to starve. `starved` counts
	 * fill buffers that found no samples at all. */
	uint32_t lead_min; /* lowest lead seen since the last start */
	uint32_t starved;  /* buffers rendered with no data ready */
	/* Samples the blob keeps ahead of the M33 (written by the M33 when
	 * playback starts): ~14.5 ms of look-ahead at whatever rate the SID
	 * stage runs, so 320 at 22.05 kHz and 640 at 44.1 kHz. */
	uint32_t lead;
};

/* Split roles: the blob runs the CPU, the M33 (or the host harness) runs
 * the SID side. The host harness simulates both in one binary. */
#if defined(CRSID_SPLIT) && (defined(FLPR_BLOB) || defined(CRSID_HOST_TEST))
#define CRSID_SPLIT_CPU_SIDE
#endif
#if defined(CRSID_SPLIT) && !defined(FLPR_BLOB)
#define CRSID_SPLIT_SID_SIDE
#endif

#ifdef CRSID_HOST_TEST
/* Host harness (tools/crsid_split_wav.c): the shared regions become plain
 * arrays instead of absolute SRAM addresses. */
extern volatile struct flpr_split host_split;
extern volatile uint16_t host_cycles[FLPR_SID_RING];
extern volatile struct flpr_event host_events[FLPR_EVENTS_MAX];
extern volatile uint8_t host_regcopy[FLPR_SID_REGCOPY_SIZE];

#undef FLPR_SID_REGCOPY
#define FLPR_SPLIT (&host_split)
#define FLPR_SID_CYC (host_cycles)
#define FLPR_EVENTS (host_events)
#define FLPR_SID_REGCOPY ((uintptr_t)host_regcopy)
#else
#define FLPR_SPLIT ((volatile struct flpr_split *)FLPR_SPLIT_CTRL)
#define FLPR_SID_CYC ((volatile uint16_t *)FLPR_SID_CYCLES)
#define FLPR_EVENTS ((volatile struct flpr_event *)FLPR_RING_BASE)
#endif
#define FLPR_SHARED_BASE 0x2003FC00UL
#define FLPR_SHARED_SIZE 0x00000400UL

#define FLPR_MAGIC 0x464C5052UL /* "FLPR" */

struct flpr_shared {
	uint32_t magic;     /* FLPR_MAGIC once the blob has booted */
	uint32_t heartbeat; /* ++ each blob iteration */
	uint32_t status;    /* blob-defined status flags */
	uint32_t control;   /* reserved */
	/* Split control (M33 writes run/mode, blob writes the rest): */
	uint32_t mode;      /* 3 = ALU probe, 4 = split CPU pump */
	uint32_t rate_hz;   /* render rate (retired with the PCM ring) */
	uint32_t run;       /* 1 = run the pump (M33 writes) */
	uint32_t run_ack;   /* blob mirrors `run` each iteration, so the
			     * M33 can wait for the pump to actually stop
			     * before it mutates engine state (load/play) */
	uint32_t write_idx; /* retired (whole-engine PCM ring) */
	uint32_t read_idx;  /* retired */
	uint32_t underruns; /* retired; split health is in flpr_split */
	uint32_t rendered;  /* retired */
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
	/* Split: fraction of wall cycles the blob spent inside the CPU
	 * pump, in permille over a ~0.25 s window (blob writes). 1000 means
	 * the blob is saturated; the M33's lead starts shrinking there. */
	uint32_t cpu_load;
	/* Split profiling: cycles per audio frame in each section, as an
	 * exponential average (alpha 1/16). Only a blob built with
	 * FLPR_PROF=1 writes these; otherwise they stay 0. */
	uint32_t prof[4]; /* CPU interpreter, CIAs, VIC, publish/glue */
	uint32_t scratch;
};

#define FLPR_SHARED ((volatile struct flpr_shared *)FLPR_SHARED_BASE)

#endif /* FLPR_SHARED_H */
