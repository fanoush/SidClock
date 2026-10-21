/*
 * crsid_split_wav.c - host harness for the FLPR split engine (mode B).
 *
 * Renders the same tune twice from an identical state:
 *   reference: the stock engine, one sample per cRSID_emulateC64()
 *   split B:   the CPU side (cRSID_emulateC64 in split mode, which only
 *              records cycles + SID-write events) followed by the M33 side
 *              (cRSID_renderSplitSample: events -> registers, ADSR, SID)
 * and reports where/how much the two diverge, plus two WAV files.
 *
 * The device runs the CPU side ahead of the SID side; the harness runs
 * them per sample, which is the same ordering the device guarantees (a
 * write is applied before the sample it belongs to is rendered).
 *
 * Build (from the repo root):
 *   gcc -O2 -o /tmp/split_wav tools/crsid_split_wav.c \
 *       app/src/sid/crsid/libcRSID.c \
 *       -I app/src/sid -I app/src/sid/crsid -I app/flpr \
 *       -DCRSID_SPLIT -DCRSID_HOST_TEST -lm
 *
 * Usage: /tmp/split_wav <file.sid> <seconds> [subtune] [out-prefix]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>

#include "flpr_shared.h"
#include "crsid/libcRSID.h"
#include "crsid/C64/C64.h"

/* The device shim provides these; the harness stubs them. */
int sid_frame_calls;
int (*libcsid_stream_fill)(unsigned char *dst, int max);

extern cRSID_C64instance cRSID_C64;
extern char cRSID_splitMode;

volatile struct flpr_split host_split;
volatile uint16_t host_cycles[FLPR_SID_RING];
volatile struct flpr_event host_events[FLPR_EVENTS_MAX];
volatile uint8_t host_regcopy[FLPR_SID_REGCOPY_SIZE];

#ifndef RATE
#define RATE 22050
#endif

static void wav_write(const char *path, const int16_t *s, size_t n)
{
	FILE *f = fopen(path, "wb");
	uint32_t datasz = (uint32_t)(n * 2), riff = 36 + datasz;
	uint32_t fmt = 16, rate = RATE, byterate = RATE * 2;
	uint16_t pcm = 1, ch = 1, align = 2, bits = 16;

	if (!f) {
		perror(path);
		return;
	}
	fwrite("RIFF", 1, 4, f); fwrite(&riff, 4, 1, f); fwrite("WAVE", 1, 4, f);
	fwrite("fmt ", 1, 4, f); fwrite(&fmt, 4, 1, f); fwrite(&pcm, 2, 1, f);
	fwrite(&ch, 2, 1, f); fwrite(&rate, 4, 1, f); fwrite(&byterate, 4, 1, f);
	fwrite(&align, 2, 1, f); fwrite(&bits, 2, 1, f);
	fwrite("data", 1, 4, f); fwrite(&datasz, 4, 1, f);
	fwrite(s, 2, n, f);
	fclose(f);
}

static unsigned char *load(const char *path, int *len)
{
	FILE *f = fopen(path, "rb");
	unsigned char *d;

	if (!f) {
		perror(path);
		exit(1);
	}
	fseek(f, 0, SEEK_END);
	*len = (int)ftell(f);
	fseek(f, 0, SEEK_SET);
	d = malloc((size_t)*len);
	if (!d || fread(d, 1, (size_t)*len, f) != (size_t)*len) {
		fprintf(stderr, "read failed\n");
		exit(1);
	}
	fclose(f);
	return d;
}

static cRSID_SIDheader *start(unsigned char *data, int len, int sub)
{
	cRSID_SIDheader *hdr;

	cRSID_init(RATE, 2048);
	/* cRSID_init() forces HQ=1; the device runs Light (libcsid_init sets
	 * it after init), so default to Light here too and A/B the
	 * oversampled path with SID_HQ=1. */
	cRSID_setQuality(getenv("SID_HQ") ? 1 : 0, 0);
	hdr = cRSID_processSIDfileData(data, len);
	if (!hdr) {
		fprintf(stderr, "not a SID file\n");
		exit(1);
	}
	cRSID_initSIDtune(hdr, (char)(sub ? sub : 1)); /* subtune 1 */
	cRSID_playSIDtune();
	return hdr;
}

int main(int argc, char **argv)
{
	int len, n, i, sub = 0, statediff = 0;
	unsigned char *data;
	cRSID_SIDheader *hdr;
	int16_t *ref, *sp;
	const char *prefix = "split";
	char path[256];

	if (argc < 3) {
		fprintf(stderr, "usage: %s <file.sid> <seconds> [subtune] [prefix]\n",
			argv[0]);
		return 1;
	}
	n = (int)(atof(argv[2]) * RATE);
	if (argc > 3) sub = atoi(argv[3]);
	if (argc > 4) prefix = argv[4];

	data = load(argv[1], &len);
	ref = calloc((size_t)n, sizeof(int16_t));
	sp = calloc((size_t)n, sizeof(int16_t));

	/* reference: stock engine, with a per-sample SID state snapshot */
	int *st = calloc((size_t)n * 6, sizeof(int));

	hdr = start(data, len, sub);
	for (i = 0; i < n; i++) {
		ref[i] = cRSID_emulateC64()->L;
		st[i * 6 + 0] = cRSID_C64.SID[1].ADSRstate[0];
		st[i * 6 + 1] = cRSID_C64.SID[1].RateCounter[0];
		st[i * 6 + 2] = cRSID_C64.SID[1].EnvelopeCounter[0];
		st[i * 6 + 3] = cRSID_C64.SID[1].PhaseAccu[0];
		st[i * 6 + 4] = cRSID_C64.SID[1].PrevWavGenOut[0];
		st[i * 6 + 5] = cRSID_C64.SID[1].Output;
	}

	/* split B from the same state */
	cRSID_setSplit(1);
	host_split.prod = host_split.cons = 0;
	host_split.eprod = host_split.econs = 0;
	start(data, len, sub);
	printf("splitMode %d\n", (int)cRSID_splitMode);
	printf("after init: prod %u cons %u eprod %u regs %02x %02x %02x %02x "
	       "base %04x addr %04x\n", host_split.prod, host_split.cons,
	       host_split.eprod, host_regcopy[0], host_regcopy[1],
	       host_regcopy[2], host_regcopy[3],
	       cRSID_C64.SID[1].BaseAddress,
	       (unsigned)(uintptr_t)cRSID_C64.SID[1].BasePtr);
	for (i = 0; i < n; i++) {
		/* The device lets the CPU run up to a buffer ahead of the SID
		 * side; keep that here so races (e.g. the ADSR pass forcing)
		 * show up in the comparison. */
		while (host_split.prod - host_split.cons < 320U) {
			cRSID_emulateC64();       /* CPU side: records, no audio */
		}
		sp[i] = (int16_t)cRSID_renderSplitSample();
		if (!statediff &&
		    (st[i * 6 + 0] != cRSID_C64.SID[1].ADSRstate[0] ||
		     st[i * 6 + 1] != cRSID_C64.SID[1].RateCounter[0] ||
		     st[i * 6 + 2] != cRSID_C64.SID[1].EnvelopeCounter[0] ||
		     st[i * 6 + 3] != cRSID_C64.SID[1].PhaseAccu[0] ||
		     st[i * 6 + 4] != cRSID_C64.SID[1].PrevWavGenOut[0])) {
			statediff = i;
			printf("first SID state diff at %d (%.3f s):\n"
			       "  ADSRstate %d/%d RateCounter %d/%d "
			       "EnvCounter %d/%d PhaseAccu %d/%d WavOut %d/%d\n",
			       i, (double)i / RATE,
			       st[i * 6 + 0], cRSID_C64.SID[1].ADSRstate[0],
			       st[i * 6 + 1], cRSID_C64.SID[1].RateCounter[0],
			       st[i * 6 + 2], cRSID_C64.SID[1].EnvelopeCounter[0],
			       st[i * 6 + 3], cRSID_C64.SID[1].PhaseAccu[0],
			       st[i * 6 + 4], cRSID_C64.SID[1].PrevWavGenOut[0]);
		}
		if (i == 0) {
			printf("sample0: cyc %u prod %u cons %u regs %02x %02x "
			       "%02x %02x out %d\n",
			       host_cycles[0], host_split.prod, host_split.cons,
			       host_regcopy[0], host_regcopy[1],
			       host_regcopy[2], host_regcopy[3], sp[0]);
		}
	}

	/* compare */
	{
		long first = -1, ndiff = 0;
		double se = 0.0;
		int maxd = 0, refpeak = 0, sp_peak = 0;

		for (i = 0; i < n; i++) {
			int d = (int)ref[i] - (int)sp[i];

			if (abs((int)ref[i]) > refpeak) refpeak = abs((int)ref[i]);
			if (abs((int)sp[i]) > sp_peak) sp_peak = abs((int)sp[i]);
			if (d) {
				ndiff++;
				if (first < 0) first = i;
			}
			if (abs(d) > maxd) maxd = abs(d);
			se += (double)d * d;
		}
		printf("%s: %d samples (%.1f s)\n", argv[1], n, (double)n / RATE);
		printf("peaks: ref %d, split %d\n", refpeak, sp_peak);
		printf("differing samples: %ld (%.4f%%), first at %ld (%.3f s)\n",
		       ndiff, 100.0 * (double)ndiff / n, first,
		       first < 0 ? 0.0 : (double)first / RATE);
		printf("max |diff|: %d, RMS diff: %.1f\n", maxd,
		       sqrt(se / n));
		/* per-second difference profile: spots where whole parts of the
		 * music go missing (vs a constant phase offset) */
		printf("per-second RMS diff / max diff:\n");
		for (i = 0; i + RATE <= n; i += RATE) {
			double w = 0.0;
			int wmax = 0;

			for (int j = i; j < i + RATE; j++) {
				int d = (int)ref[j] - (int)sp[j];

				w += (double)d * d;
				if (abs(d) > wmax) wmax = abs(d);
			}
			printf("  %3d s: rms %7.1f  max %5d\n", i / RATE,
			       sqrt(w / RATE), wmax);
		}
		if (first >= 0) {
			printf("context around first diff (i: ref split diff):\n");
			for (i = (int)(first > 8 ? first - 8 : 0);
			     i < first + 8 && i < n; i++) {
				printf("  %7d: %6d %6d %5d\n", i, ref[i], sp[i],
				       (int)ref[i] - (int)sp[i]);
			}
		}
	}

	snprintf(path, sizeof(path), "%s_ref.wav", prefix);
	wav_write(path, ref, (size_t)n);
	snprintf(path, sizeof(path), "%s_split.wav", prefix);
	wav_write(path, sp, (size_t)n);
	printf("wrote %s_ref.wav / %s_split.wav\n", prefix, prefix);

	(void)hdr;
	return 0;
}
