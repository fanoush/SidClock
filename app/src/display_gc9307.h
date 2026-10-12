/*
 * Panel driver extensions (sidclock,gc9307 / SH8601-class).
 *
 * The generic Zephyr display API does not cover hardware rotation (MADCTL)
 * or the panel power states, which the demo UI needs.
 */
#ifndef DISPLAY_GC9307_H_
#define DISPLAY_GC9307_H_

#include <zephyr/device.h>

/* MADCTL address-space rotations (MV/MX/MY combinations). */
enum gc9307_rotation {
	GC9307_ROT_0 = 0,   /* portrait  368 x 448 */
	GC9307_ROT_90 = 1,  /* landscape 448 x 368 (MV|MX) */
	GC9307_ROT_180 = 2, /* portrait, flipped (MX|MY) */
	GC9307_ROT_270 = 3, /* landscape, flipped (MV|MY) */
};

/* Write MADCTL (0x36). The panel keeps the previous frame memory, so the
 * caller should redraw the whole screen afterwards.
 */
int gc9307_set_rotation(const struct device *dev, enum gc9307_rotation rotation);

/* DCS Idle Mode (0x39) / Off (0x38): reduces color expression to the MSBs
 * of R/G/B (8-color-ish) for low-power static content. */
int gc9307_set_idle(const struct device *dev, bool on);

/* SH8601 AOD (Always-On Display) mode: 0x49 on / 0x48 off. Dim, low-refresh
 * panel mode with its own brightness register (0x4A, left at its default). */
int gc9307_set_aod(const struct device *dev, bool on);

/* Experimental frame-rate control, 0 = panel default, 1..4 = progressively
 * slower. Uses the GC9xxx-style 0xE8 command; SH8601 does not document a
 * host frame-rate register, so this may be a no-op on AMOLED units. */
int gc9307_set_frame_rate(const struct device *dev, uint8_t level);

/*
 * Panel power states:
 *   0 -> display off + sleep in (0x28, 0x10)      - can be woken with 1
 *   1 -> full (re-)initialization (reset + init)  - also resets MADCTL
 *   2 -> display off + deep standby (0x4F)        - needs a reset to wake
 */
int gc9307_panel_state(const struct device *dev, int state);

#endif /* DISPLAY_GC9307_H_ */
