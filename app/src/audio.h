/*
 * audio.h - speaker output for the SidClock (DOOM-port engine model:
 * direct I2S register writes, polled double buffering, no interrupts).
 */
#ifndef AUDIO_H_
#define AUDIO_H_

#include <stdbool.h>
#include <stdint.h>

int audio_init(void);

/* Mute/unmute by sending zeros - the board's amp has no enable pin. */
void audio_set_enabled(bool enable);

/* 0..255, applied when tones are synthesised. */
void audio_set_volume(uint8_t volume);

/* Write a single byte of the debug snapshot (e.g. UI diagnostics). */
void audio_dbg_byte(int i, uint8_t v);

void audio_click(void);
void audio_beep(void);
void audio_long_tone(void);

/* Sample-rate ladder step for finding the amplifier's turn-on point. */
void audio_rate_next(void);

/* Tone-frequency ladder step (2 beeps at the current sample rate). */
void audio_tone_next(void);

/* Direct set: sample rate (1000..96000) / tone frequency (100..30000). */
void audio_set_rate(uint32_t hz);
void audio_set_tone(uint32_t hz);

/* Steady tone: seconds = 0 plays until audio_tone_release(). */
void audio_tone_hold(uint32_t hz, uint32_t seconds);
void audio_tone_release(void);

/* SID emulator playback mode (see sid_player.h). */
void audio_sid_start(void);
void audio_sid_stop(void);

/* Calibration: raw MCKFREQ override (0 restores the computed value). */
void audio_set_mck_raw(uint32_t v);

/*
 * Debug snapshot for the BLE debug characteristic:
 *   [0] ready  [1] init_rc  [6] enabled  [7] volume  [9] play attempts
 *   [17] tone buffers left  [18] amp combo  [19] combo flags
 */
const uint8_t *audio_debug(void);

/* [0..3] PSEL.SCK  [4..7] PSEL.SDOUT  [8..11] PSEL.MCK
 * [12] ENABLE  [13] TXEN */
void audio_read_hw(uint8_t *out, size_t len);

/* [0] pin activity mask (P1.04..P1.07)  [2..3] DMA buffer peak
 * [4..7]/[8..11] first word of each DMA buffer */
void audio_diag(uint8_t *out, size_t len);

#endif /* AUDIO_H_ */
