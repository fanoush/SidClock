/*
 * sid_player.h - SID player bridge API (implementation in sid_player.cpp).
 */
#ifndef SID_PLAYER_H_
#define SID_PLAYER_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

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

bool sid_player_is_playing(void);
bool sid_player_is_paused(void);
uint32_t sid_player_elapsed_s(void); /* seconds since the (sub)song started */
int sid_player_songs(void);
const char *sid_player_title(void);
const char *sid_player_author(void);
int sid_player_subtune(void);

/* Produce `frames` mono 16-bit samples at 22050 Hz. */
void sid_player_render(int16_t *dst, int frames);

/* Compact status for the BLE debug read: [0] playing, [1] songs, [2..] title */
void sid_player_info(uint8_t *out, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* SID_PLAYER_H_ */
