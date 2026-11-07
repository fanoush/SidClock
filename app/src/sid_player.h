/*
 * sid_player.h - SID player bridge API (implementation in sid_player.cpp).
 */
#ifndef SID_PLAYER_H_
#define SID_PLAYER_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Generated wire protocol (protocol/current.json): engine values below. */
#include "proto_gen.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Read a .sid file into the emulator. Returns 0 on success. */
int sid_player_load(const char *path);

/* Set the true hardware render rate (re-inits emulator if changed). */
void sid_player_set_render_rate(uint32_t hz);

/* Start a subtune (0-based). */
void sid_player_play(int song);
/* Start the tune's default subtune (PSID startSong). */
void sid_player_play_default(void);
void sid_player_pause(void);
void sid_player_resume(void);
void sid_player_stop(void);

/* SID chip model: 0 = auto (follow the PSID file flags), 1 = force 6581,
 * 2 = force 8580. Switching re-inits and reloads the current tune. */
void sid_player_set_model(int mode);
int sid_player_model_mode(void);
/* The chip model actually in use (6581/8580) - meaningful in auto mode. */
int sid_player_chip(void);

/* Engine values come from the generated protocol (SC_ENGINE_MODE_*). */
#define SID_ENGINE_CRSID SC_ENGINE_MODE_CRSID
#define SID_ENGINE_LEGACY SC_ENGINE_MODE_LEGACY
#define SID_ENGINE_SPLIT SC_ENGINE_MODE_SPLIT /* M33 SID, FLPR C64/CPU */

#ifdef SID_ENGINE_DUAL
/* Engine choice for all tunes (default: cRSID on the M33). The engine
 * button cycles it; the next load (or reload) applies it. */
void sid_player_set_engine_mode(int mode);
int sid_player_engine_mode(void);

#else
int sid_player_engine_mode(void);
void sid_player_set_engine_mode(int mode);
#endif

/* SID waveform quality: 0 = light (default, ~9 us/frame on the M33 in
 * split mode), 1 = oversampled (HQ, ~4.6x - only for A/B listening). */
void sid_player_set_quality(int hq);

bool sid_player_is_playing(void);
bool sid_player_is_paused(void);
uint32_t sid_player_elapsed_s(void); /* seconds since the (sub)song started */
void sid_player_add_elapsed(int frames); /* FLPR pipe drain mirror (audio.c) */
int sid_player_songs(void);
int sid_player_sid_count(void); /* SID chips in the loaded tune (1..4) */
const char *sid_player_title(void);
const char *sid_player_author(void);
int sid_player_subtune(void);

/* First 4 bytes of the loaded file's whole-file MD5 (all zero when the
 * hash is unknown). HVSC's Songlengths.md5 is keyed on this digest; the
 * BLE info characteristic reports the prefix as 8 hex characters. */
void sid_player_md5_prefix(uint8_t out[4]);

/* Produce `frames` mono 16-bit samples at 22050 Hz. */
void sid_player_render(int16_t *dst, int frames);

/* Fill the SID block of the BLE debug snapshot (absolute offsets from
 * proto_gen.h): playing/songs/last_rc, title, call counters. */
void sid_player_info(uint8_t *snap);

/* Crash telemetry (see main.c): record what is playing. */
void dbg_record_tune(const char *name, int engine);

#ifdef __cplusplus
}
#endif

#endif /* SID_PLAYER_H_ */
