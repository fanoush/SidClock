/*
 * flpr.h - FLPR (VPR RISC-V) core lifecycle.
 *
 * The blob is embedded in the image (flpr/flpr_blob.S) and never starts
 * at boot (NORDIC_VPR_LAUNCHER=n). flpr_start() boots it on demand; the
 * render/stop decision itself lives in the shared mailbox
 * (flpr/flpr_shared.h), so the core can stay running between tunes.
 */
#ifndef FLPR_H_
#define FLPR_H_

#include <stdbool.h>

/* Boot the embedded blob and release the core. Does nothing (returns 0)
 * when the blob is already alive. Returns a negative errno when it cannot
 * be started (blob too big for private RAM and not aligned for XIP). */
int flpr_start(void);

/* Halt the core: reset it into the stopped state. The blob's magic is
 * cleared so the next flpr_start() boots it fresh. */
void flpr_halt(void);

/* Stop/resume the render pump. The blob owns no lock, so the M33 must
 * call flpr_render_stop() (which waits for the blob to acknowledge that
 * it left its current burst) before it mutates engine state, then
 * flpr_render_start() afterwards. */
void flpr_render_stop(void);
void flpr_render_start(void);

/* True when the blob is currently rendering (the M33's `run` request). */
bool flpr_rendering(void);

/* True when the blob has published its magic since the last halt/reset. */
bool flpr_alive(void);

/* Clear the rendezvous without touching the core (boot: a stale magic
 * from retained SRAM must never fake a live blob). */
void flpr_clear(void);

#endif /* FLPR_H_ */
