/* libcrsid_shim.c - libcsid_* API over the SID cores.
 *
 * Default core is the slimmed cRSID-1.58 in Light profile at the SID render
 * rate (see sid_player.cpp SID_RATE): integer-only wave generation with the
 * fast averaging resampler. cSID-light by Hermit (2017, WTFPL) is replaced
 * by cRSID-1.58 by Hermit (2026, WTFPL), slimmed for the nRF54L15 (4 KB IO
 * banks, no ROM banks, computed memory banking - see crsid/ and the
 * "Embedded slim-down" notes there).
 *
 * In dual-engine builds (SID_ENGINE_DUAL) the legacy cSID-light core is
 * linked too and selectable per tune: both cores share one 64 KB C64 RAM
 * (only one runs at a time; every load re-initialises it).
 *
 * Behaviour notes vs the old core:
 * - libcsid_load() ends by starting the default tune, like the old core
 *   did (including its raw-header-byte indexing).
 * - libcsid_stream_fill keeps working the same way (128-byte header buffer
 *   plus a positional payload stream); the engine copies straight into its
 *   C64 RAM, with no extra buffering.
 * - sid_cpu_calls used to count emulated 6510 instructions; with cRSID it
 *   counts rendered samples (legacy path keeps instructions). The BLE debug
 *   bytes carrying it are display-only.
 * - cRSID output level is ~3.6 dB lower (MainVolume scaling); the volume
 *   control compensates.
 */
#include <string.h>

#include "libcsid.h"
#include "crsid/libcRSID.h"

#ifdef SID_ENGINE_DUAL
/* Renamed legacy core API (see COMPILE_DEFINITIONS on libcsidlight.cpp). */
extern void csid_init(int samplerate, int sidmodel);
extern void csid_free(void);
extern int csid_load(unsigned char *buffer, int bufferlen);
extern void csid_play(int tune_index);
extern const char *csid_getauthor(void);
extern const char *csid_getinfo(void);
extern const char *csid_gettitle(void);
extern uint8_t csid_get_total_tunes_number(void);
extern uint8_t csid_get_default_tune_number(void);
extern void csid_render(unsigned short *output, int numsamples);
extern int csid_subtune;
extern int csid_SID_model[3];
extern int csid_frame_calls;
extern unsigned int csid_sid_cpu_calls;
extern int (*csid_stream_fill)(unsigned char *dst, int max);

/* 0 = cRSID Light, 1 = legacy cSID-light. Set per tune (see
 * libcsid_select_engine); the next load initialises that core. */
static int use_legacy;

void libcsid_select_engine(int legacy)
{
	use_legacy = legacy ? 1 : 0;
}

int libcsid_selected_engine(void)
{
	return use_legacy;
}
#endif /* SID_ENGINE_DUAL */

static cRSID_SIDheader *sh_hdr;
static char sh_title[33];
static char sh_author[33];
static char sh_info[33];

/* Current 0-based subtune, like the old core's `subtune`. Owned by the
 * audio thread while rendering, like the rest of the emulator state. */
int subtune;

/* Effective SID models, like the old core's `SID_model[3]`. [0] is what
 * sid_player_chip() reports. */
int SID_model[3] = { SIDMODEL_8580, SIDMODEL_8580, SIDMODEL_8580 };

/* Rendered-sample counter (cRSID; legacy path mirrors the core counter,
 * see below). */
unsigned int sid_cpu_calls;

/* Play-routine call counter, bumped by the engine (see C64.c). */
int sid_frame_calls;

/* Payload stream for files too large to buffer; set by sid_player before
 * libcsid_load(), cleared after (same contract as with cSID-light). */
int (*libcsid_stream_fill)(unsigned char *dst, int max) = 0;

static void copy32(char *dst, const char *src)
{
	memcpy(dst, src, 32);
	dst[32] = '\0';
}

#ifdef SID_ENGINE_DUAL
static void sync_legacy_state(void)
{
	int i;

	subtune = csid_subtune;
	for (i = 0; i < 3; i++) {
		SID_model[i] = csid_SID_model[i];
	}
	sid_cpu_calls = csid_sid_cpu_calls;
	sid_frame_calls = csid_frame_calls;
}
#endif

static void refresh_models(void)
{
	unsigned short m1 = cRSID_getSIDmodel(1);
	unsigned short m2 = cRSID_getSIDmodel(2);
	unsigned short m3 = cRSID_getSIDmodel(3);

	if (m1 != SIDMODEL_6581 && m1 != SIDMODEL_8580) {
		m1 = SIDMODEL_8580;
	}
	SID_model[0] = (int)m1;
	SID_model[1] = (m2 == SIDMODEL_6581 || m2 == SIDMODEL_8580) ?
		(int)m2 : SID_model[0];
	SID_model[2] = (m3 == SIDMODEL_6581 || m3 == SIDMODEL_8580) ?
		(int)m3 : SID_model[0];
}

void libcsid_init(int samplerate, int sidmodel)
{
#ifdef SID_ENGINE_DUAL
	if (use_legacy) {
		csid_stream_fill = libcsid_stream_fill;
		csid_init(samplerate, sidmodel);
		sync_legacy_state();
		return;
	}
#endif
	cRSID_init((unsigned short)samplerate, 2048);
	cRSID_setQuality(0, 0); /* Light */
	cRSID.SelectedSIDmodel =
		(sidmodel == SIDMODEL_6581 || sidmodel == SIDMODEL_8580) ?
			(unsigned short)sidmodel : 0; /* 0: model from the SID header */
	sh_hdr = 0;
	subtune = 0;
	sh_title[0] = sh_author[0] = sh_info[0] = '\0';
}

void libcsid_free(void)
{
#ifdef SID_ENGINE_DUAL
	if (use_legacy) {
		csid_free();
		return;
	}
#endif
	sh_hdr = 0;
}

int libcsid_load(unsigned char *buffer, int bufferlen)
{
#ifdef SID_ENGINE_DUAL
	if (use_legacy) {
		int rc;

		csid_stream_fill = libcsid_stream_fill;
		rc = csid_load(buffer, bufferlen);
		sync_legacy_state();
		sh_title[0] = sh_author[0] = sh_info[0] = '\0';
		if (rc == 0 && bufferlen >= 0x76) {
			/* header strings live in the first 128 bytes */
			copy32(sh_title, (const char *)buffer + 0x16);
			copy32(sh_author, (const char *)buffer + 0x36);
			copy32(sh_info, (const char *)buffer + 0x56);
		}
		return rc;
	}
#endif
	sh_hdr = cRSID_processSIDfileData(buffer, bufferlen);
	if (sh_hdr == 0) {
		return -1;
	}
	copy32(sh_title, sh_hdr->Title);
	copy32(sh_author, sh_hdr->Author);
	copy32(sh_info, sh_hdr->ReleaseInfo);
	/* Like the old core, leave the default tune started (raw header byte,
	 * same indexing): playback itself stays stopped, see sid_player.
	 * Models refresh inside play(), once initSIDtune() applied the header. */
	libcsid_play((int)sh_hdr->DefaultSubtune);
	return 0;
}

void libcsid_play(int tune_index)
{
#ifdef SID_ENGINE_DUAL
	if (use_legacy) {
		csid_play(tune_index);
		sync_legacy_state();
		return;
	}
#endif
	{
		int sub = tune_index + 1; /* libcsid is 0-based, cRSID 1-based */

		if (sh_hdr == 0) {
			return;
		}
		subtune = tune_index;
		/* cRSID_initSIDtune clamps to 1..SubtuneAmount itself. */
		cRSID_initSIDtune(sh_hdr, (char)sub);
		refresh_models();
		cRSID_playSIDtune(); /* initSIDtune leaves Paused set */
	}
}

const char *libcsid_getauthor(void)
{
	return sh_author;
}

const char *libcsid_getinfo(void)
{
	return sh_info;
}

const char *libcsid_gettitle(void)
{
	return sh_title;
}

uint8_t libcsid_get_total_tunes_number(void)
{
#ifdef SID_ENGINE_DUAL
	if (use_legacy) {
		return csid_get_total_tunes_number();
	}
#endif
	return sh_hdr ? sh_hdr->SubtuneAmount : 0;
}

uint8_t libcsid_get_default_tune_number(void)
{
#ifdef SID_ENGINE_DUAL
	if (use_legacy) {
		return csid_get_default_tune_number();
	}
#endif
	return sh_hdr ? sh_hdr->DefaultSubtune : 1;
}

void libcsid_render(unsigned short *output, int numsamples)
{
#ifdef SID_ENGINE_DUAL
	if (use_legacy) {
		csid_render(output, numsamples);
		sid_cpu_calls = csid_sid_cpu_calls;
		sid_frame_calls = csid_frame_calls;
		return;
	}
#endif
	{
		int i;
		int16_t *out = (int16_t *)output;

		for (i = 0; i < numsamples; i++) {
			out[i] = (int16_t)cRSID_generateSample().L;
		}
		sid_cpu_calls += (unsigned int)numsamples;
	}
}
