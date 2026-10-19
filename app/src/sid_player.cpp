/*
 * sid_player.cpp - SID tune player bridge for the SidClock.
 *
 * Wraps the vendored cSID-light core (Hermit/Mihaly Horvath, GPLv3, via
 * pschatzmann/SIDPlayer) with a small, Arduino-free API:
 *
 *   sid_player_load(path)   - read a .sid file from /home into the C64 map
 *   sid_player_play(song)   - start a subtune (0-based)
 *   sid_player_is_playing() - playback state for the audio engine
 *   sid_player_render(dst, n) - produce n mono 16-bit samples at 22050 Hz
 *   sid_player_info(buf, n) - compact status for the BLE debug read
 *   sid_player_md5_prefix(buf) - whole-file MD5 prefix of the loaded tune
 *
 * The C64 memory map (64 KB static) and the file buffer live here; the
 * audio engine in audio.c pulls samples whenever SID mode is active.
 */

#include <zephyr/kernel.h>
#include <zephyr/fs/fs.h>
#include <zephyr/logging/log.h>
#include <string.h>

#include "md5.h"
#include "sid_player.h"

extern "C" {
#include "sid/libcsid.h"
}

LOG_MODULE_REGISTER(sid_player, LOG_LEVEL_INF);

/* Render rate = the true hardware playback rate for a 22050 request,
 * measured host-timed through the EasyDMA buffer-boundary counter
 * (22.05 kHz request -> ~23.0 kHz actual on this unit). Rendering for
 * anything else makes the tune play slow/fast once the audio service
 * keeps up with the DMA. */
#define SID_RATE 23000
#define SID_MODEL SIDMODEL_6581

/* Files are streamed into the C64 map in 512-byte chunks; the cap is just
 * a sanity limit (HVSC files reach ~200 kB, the 64 kB map keeps the first
 * 64 kB of the payload). */
#define SID_MAX_FILE 262144
#define SID_HDR_LEN 128

static bool loaded;
static volatile bool playing;
static volatile bool paused;
static uint32_t sid_elapsed_samples; /* emulated samples since song start */
static volatile int8_t last_rc;
static char sid_path[40]; /* kept for rate-change reloads */
static unsigned char sid_hdr[SID_HDR_LEN];
static int sid_file_len;
static int sid_stream_pos;
static struct fs_file_t sid_pf;
static uint16_t render_calls; /* sid_player_render() calls (512 frames each) */
static int model_mode; /* 0 = auto (PSID flags), 1 = 6581, 2 = 8580 */

/* Whole-file MD5 of the loaded tune, first 4 bytes only (HVSC's
 * Songlengths.md5 is keyed on this digest; the host looks the prefix up
 * to identify the tune exactly). Valid after a successful load. */
static uint8_t sid_id[4];
static bool sid_id_ok;

/* The emulator state is owned by the audio thread while it renders; every
 * mutation (load/play/pause/chip/rate) must be serialised against that.
 * Without this, a subtune switch from the UI or BLE running the tune's init
 * routine concurrently with a render corrupted the C64 state - heard as
 * missing instruments, silence or a "looping sample" until a lucky reload. */
static K_MUTEX_DEFINE(sid_lock);

static int model_arg(void)
{
	return model_mode == 1 ? SIDMODEL_6581 :
	       model_mode == 2 ? SIDMODEL_8580 : -1; /* -1: use file's flag */
}

#ifdef SID_ENGINE_DUAL
/* Global engine mode, switched from the main-screen button (default is the
 * new core). Applied on every load; see libcsid_select_engine(). */
static int sid_engine_legacy;

extern "C" void sid_player_set_engine_mode(int legacy)
{
	sid_engine_legacy = legacy ? 1 : 0;
}

extern "C" int sid_player_engine_legacy(void)
{
	return sid_engine_legacy;
}
#endif /* SID_ENGINE_DUAL */

extern "C" {
extern int sid_frame_calls; /* engine state (see sid/) */
extern unsigned int sid_cpu_calls; /* engine state (see sid/) */
extern int subtune; /* engine state (see sid/) */
extern int SID_model[3]; /* engine state (see sid/) */
extern int (*libcsid_stream_fill)(unsigned char *, int); /* in libcsidlight.cpp */
}

static uint16_t sid_cpu_delta; /* 6510 instructions in the last render */

/* Streams the C64 payload from the file: first the tail of the 128-byte
 * header buffer (when the payload starts inside it), then the file. */
static int sid_stream_read(unsigned char *dst, int max)
{
	int n = 0;

	while (n < max && sid_stream_pos < (int)sizeof(sid_hdr)) {
		dst[n++] = sid_hdr[sid_stream_pos++];
	}
	if (n < max) {
		ssize_t rd = fs_read(&sid_pf, dst + n, (size_t)(max - n));

		if (rd > 0) {
			n += (int)rd;
			sid_stream_pos += (int)rd;
		}
	}
	return n;
}

/* Actual load body - callers must hold sid_lock. */
static int sid_load_file(const char *path)
{
	struct fs_dirent st;
	off_t sz;
	ssize_t rd;
	int offs, skip;
	unsigned char junk[64];

	if (fs_stat(path, &st) < 0) {
		LOG_WRN("SID stat failed: %s", path);
		last_rc = -1;
		return -1;
	}
	sz = (off_t)st.size;
	if (st.type != FS_DIR_ENTRY_FILE || sz <= 0 || sz > SID_MAX_FILE) {
		LOG_WRN("SID size %d not supported (max %d)", (int)sz,
			SID_MAX_FILE);
		last_rc = -2;
		return -2;
	}

	fs_file_t_init(&sid_pf);
	if (fs_open(&sid_pf, path, FS_O_READ) < 0) {
		LOG_WRN("SID open failed: %s", path);
		last_rc = -1;
		return -1;
	}

	memset(sid_hdr, 0, sizeof(sid_hdr));
	rd = fs_read(&sid_pf, sid_hdr, sizeof(sid_hdr));
	if (rd <= 0) {
		fs_close(&sid_pf);
		last_rc = -3;
		return -3;
	}
	sid_file_len = (int)sz;

	/* payload starts at the header offset + 2 (the core reads the low
	 * offset byte only - match it) */
	offs = sid_hdr[7];
	sid_stream_pos = offs + 2;
	skip = sid_stream_pos - SID_HDR_LEN;
	while (skip > 0) {
		size_t want = (size_t)(skip > (int)sizeof(junk) ?
					      (int)sizeof(junk) : skip);

		rd = fs_read(&sid_pf, junk, want);
		if (rd <= 0) {
			break;
		}
		skip -= (int)rd;
	}

#ifdef SID_ENGINE_DUAL
	libcsid_select_engine(sid_engine_legacy);
#endif
	libcsid_init(SID_RATE, model_arg());
	libcsid_stream_fill = sid_stream_read;
	libcsid_load(sid_hdr, sid_file_len);
	libcsid_stream_fill = 0;

	/* Hash the whole file for the BLE host. The context is stack-local
	 * (~96 B), only the 4-byte prefix is kept; the pass is sequential
	 * and bounded by SID_MAX_FILE. A failure just leaves the prefix at
	 * zero, i.e. "unknown", and the host falls back to name matching. */
	sid_id_ok = false;
	memset(sid_id, 0, sizeof(sid_id));
	if (fs_seek(&sid_pf, 0, FS_SEEK_SET) == 0) {
		struct md5_ctx ctx;
		uint8_t chunk[64];
		uint8_t digest[16];
		off_t left = sz;

		md5_init(&ctx);
		while (left > 0) {
			size_t want = (left > (off_t)sizeof(chunk)) ?
					      sizeof(chunk) : (size_t)left;

			rd = fs_read(&sid_pf, chunk, want);
			if (rd <= 0) {
				break;
			}
			md5_update(&ctx, chunk, (size_t)rd);
			left -= rd;
		}
		if (left == 0) {
			md5_final(&ctx, digest);
			memcpy(sid_id, digest, sizeof(sid_id));
			sid_id_ok = true;
		} else {
			LOG_WRN("SID id hash failed: %s", path);
		}
	} else {
		LOG_WRN("SID id seek failed: %s", path);
	}
	fs_close(&sid_pf);

	snprintf(sid_path, sizeof(sid_path), "%s", path);
	loaded = true;
	playing = false;
	paused = false;
	sid_elapsed_samples = 0;
	last_rc = 0;
#ifdef SID_ENGINE_DUAL
	{
		const char *base = strrchr(path, '/');

		dbg_record_tune(base != NULL ? base + 1 : path,
				sid_engine_legacy);
	}
#endif
	LOG_INF("SID: %s (%d B) \"%s\" by \"%s\", %u song(s)", path, (int)sz,
		libcsid_gettitle(), libcsid_getauthor(),
		libcsid_get_total_tunes_number());
	return 0;
}

extern "C" int sid_player_load(const char *path)
{
	int rc;

	k_mutex_lock(&sid_lock, K_FOREVER);
	rc = sid_load_file(path);
	k_mutex_unlock(&sid_lock);
	return rc;
}



/* Re-initialise the emulator for a new true hardware rate and reload the
 * current tune into the fresh map (streamed from the filesystem again). */
extern "C" void sid_player_set_render_rate(uint32_t hz)
{
	static uint32_t cur;
	int was_playing, was_sub, was_paused;
	uint32_t was_elapsed;

	if (hz == cur) {
		return;
	}

	k_mutex_lock(&sid_lock, K_FOREVER);
	cur = hz;
	was_playing = playing;
	was_sub = subtune;
	was_paused = paused;
	was_elapsed = sid_elapsed_samples;

	if (loaded) {
		sid_load_file(sid_path);
		playing = was_playing;
		paused = was_paused;
		sid_elapsed_samples = was_elapsed;
		if (playing) {
			libcsid_play(was_sub);
		}
	} else {
		libcsid_init((int)hz, model_arg());
	}
	k_mutex_unlock(&sid_lock);
}

/* Switch the SID chip model at runtime: re-init + reload the current tune
 * (preserving playback position and pause state). */
extern "C" void sid_player_set_model(int mode)
{
	int was_playing, was_sub, was_paused;
	uint32_t was_elapsed;

	if (mode < 0 || mode > 2 || mode == model_mode) {
		return;
	}

	k_mutex_lock(&sid_lock, K_FOREVER);
	model_mode = mode;

	if (!loaded) {
		libcsid_init(SID_RATE, model_arg());
		k_mutex_unlock(&sid_lock);
		return;
	}

	was_playing = playing;
	was_sub = subtune;
	was_paused = paused;
	was_elapsed = sid_elapsed_samples;

	sid_load_file(sid_path);
	playing = was_playing;
	paused = was_paused;
	sid_elapsed_samples = was_elapsed;
	if (playing) {
		libcsid_play(was_sub);
	}
	k_mutex_unlock(&sid_lock);
}

extern "C" int sid_player_model_mode(void)
{
	return model_mode;
}

extern "C" int sid_player_chip(void)
{
	return SID_model[0];
}

extern "C" void sid_player_play(int song)
{
	k_mutex_lock(&sid_lock, K_FOREVER);
	if (loaded) {
		libcsid_play(song);
		playing = true;
		paused = false;
		sid_elapsed_samples = 0;
	}
	k_mutex_unlock(&sid_lock);
}

extern "C" void sid_player_play_default(void)
{
	/* PSID startSong is 1-based; the tune's init routine (A register) is
	 * 0-based like cSID's subtune. */
	int song = (int)libcsid_get_default_tune_number() - 1;

	k_mutex_lock(&sid_lock, K_FOREVER);
	if (!loaded) {
		k_mutex_unlock(&sid_lock);
		return;
	}
	if (song < 0 || song >= (int)libcsid_get_total_tunes_number()) {
		song = 0;
	}
	libcsid_play(song);
	playing = true;
	paused = false;
	sid_elapsed_samples = 0;
	k_mutex_unlock(&sid_lock);
}

extern "C" void sid_player_pause(void)
{
	k_mutex_lock(&sid_lock, K_FOREVER);
	paused = true;
	k_mutex_unlock(&sid_lock);
}

extern "C" void sid_player_resume(void)
{
	k_mutex_lock(&sid_lock, K_FOREVER);
	paused = false;
	k_mutex_unlock(&sid_lock);
}

extern "C" void sid_player_stop(void)
{
	k_mutex_lock(&sid_lock, K_FOREVER);
	playing = false;
	paused = false;
	k_mutex_unlock(&sid_lock);
}

extern "C" bool sid_player_is_playing(void)
{
	return playing;
}

extern "C" bool sid_player_is_paused(void)
{
	return paused;
}

extern "C" uint32_t sid_player_elapsed_s(void)
{
	return sid_elapsed_samples / SID_RATE;
}

extern "C" void sid_player_render(int16_t *dst, int frames)
{
	unsigned int c0;

	if (paused || !playing) {
		memset(dst, 0, (size_t)frames * sizeof(int16_t));
		return;
	}

	k_mutex_lock(&sid_lock, K_FOREVER);
	c0 = sid_cpu_calls;
	render_calls++;
	libcsid_render((unsigned short *)dst, frames);
	sid_cpu_delta = (uint16_t)(sid_cpu_calls - c0);
	sid_elapsed_samples += (uint32_t)frames;
	k_mutex_unlock(&sid_lock);
}

extern "C" int sid_player_songs(void)
{
	return loaded ? libcsid_get_total_tunes_number() : 0;
}

extern "C" const char *sid_player_title(void)
{
	return loaded ? libcsid_gettitle() : "";
}

extern "C" const char *sid_player_author(void)
{
	return loaded ? libcsid_getauthor() : "";
}

extern "C" int sid_player_subtune(void)
{
	return loaded ? subtune : 0;
}

/* First 4 bytes of the loaded file's MD5 (all zero when unknown). */
extern "C" void sid_player_md5_prefix(uint8_t out[4])
{
	if (sid_id_ok) {
		memcpy(out, sid_id, 4U);
	} else {
		memset(out, 0, 4U);
	}
}

extern "C" void sid_player_info(uint8_t *out, size_t len)
{
	if (len == 0U) {
		return;
	}
	memset(out, 0, len);
	out[0] = playing ? 1 : 0;
	if (len > 1U) {
		out[1] = (uint8_t)sid_player_songs();
	}
	if (len > 2U) {
		out[2] = (uint8_t)last_rc;
	}
	if (len > 3U) {
		strncpy((char *)out + 3, sid_player_title(), 15U);
	}
	if (len > 19U) {
		out[18] = (uint8_t)(render_calls & 0xFFU);
		out[19] = (uint8_t)(render_calls >> 8);
	}
	if (len > 21U) {
		out[20] = (uint8_t)((unsigned)sid_frame_calls & 0xFFU);
		out[21] = (uint8_t)(((unsigned)sid_frame_calls >> 8) & 0xFFU);
	}
	if (len > 23U) {
		out[22] = (uint8_t)(sid_cpu_delta & 0xFFU);
		out[23] = (uint8_t)(sid_cpu_delta >> 8);
	}
}
