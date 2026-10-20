/*
 * SidClock — SID music player firmware for the Saphe T device (nRF54L15).
 *
 *   - landscape UI on the 368x448 AMOLED (software rotation: the panel stays
 *     in its native portrait address space and every window is transposed)
 *   - main screen: header (clock/date + lux/battery), navigation tiles
 *     (SID player / alarms / sensors / settings), AUTO ROT / AUTO BRI /
 *     SND / BLE mode / SLEEP buttons and the volume/brightness sliders
 *   - SID player screen: track info, HOME/TUNE/PLAY/SUB transport buttons,
 *     volume + brightness sliders and the same header
 *   - idle face after the configured timeout (15 s .. 5 min): big clock that
 *     jumps to a random spot once a minute; SLEEP blanks the panel while SID
 *     playback and alarms keep running
 *   - alarms: five ONCE/REPEAT alarms, ringtone captured from a SID
 *   - BLE: Battery Service, Current Time Service, MCUmgr/SMP OTA (secondary
 *     slot on the external MX25R64) and a debug characteristic (fs_mgmt
 *     uploads .sid files into /home)
 *
 * Update with:
 *   smpmgr --ble <addr> upgrade zephyr.signed.bin
 */

#include <zephyr/kernel.h>
#include <zephyr/irq.h>
#include <zephyr/device.h>
#include <zephyr/drivers/display.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/mgmt/mcumgr/transport/smp_bt.h>
#include <zephyr/mgmt/mcumgr/mgmt/callbacks.h>
#include <zephyr/mgmt/mcumgr/grp/fs_mgmt/fs_mgmt_callbacks.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/logging/log.h>
#include <zephyr/init.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/watchdog.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/linker/section_tags.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/fs/fs.h>
#include <zephyr/fs/littlefs.h>
#include <SEGGER_RTT.h>
#include <string.h>
#include <stdio.h>

#include "font1524.h"
#include "sid_player.h"
#include "display_gc9307.h"
#include "opt400x.h"
#include "audio.h"

LOG_MODULE_REGISTER(sidclock, LOG_LEVEL_INF);

/* Set by CMake (-DSIDCLOCK_VERSION=...), kept in sync with the signed image
 * version by build.sh.
 */
#ifndef SIDCLOCK_VERSION
#define SIDCLOCK_VERSION "dev"
#endif
/* SID engine tag for A/B builds (set by CMake, display only - the signed
 * image version above stays engine-independent for OTA comparison). */
#ifndef SID_ENGINE_SUFFIX
#define SID_ENGINE_SUFFIX ""
#endif
/* Debug-build tag (set by CMake): "-dbg" for SIDCLOCK_DEBUG=1 builds, so a
 * bench image with the test commands enabled cannot be mistaken for a
 * release one (the signed image version stays the same). */
#ifndef SIDCLOCK_DEBUG_SUFFIX
#define SIDCLOCK_DEBUG_SUFFIX ""
#endif

#define SCR_W 448
#define SCR_H 368
#define NAT_W 368
#define NAT_H 448
/* Native 15x24 DroidSansMono (font1524.h). This used to be the 10x16 font
 * scaled 3/2, which looked rough; Zephyr's cfb_fonts.c also ships a native
 * 20x32 version if even bigger text is ever wanted.
 */
#define FONT_W 15
#define FONT_H 24
#define TEXT_CW FONT_W
#define TEXT_CH FONT_H

#define COL_BG     0x0000
#define COL_WHITE  0xFFFF
#define COL_GREEN  0x07E0
#define COL_CYAN   0x07FF
#define COL_YELLOW 0xFFE0
#define COL_RED    0xF800
#define COL_BLUE   0x001F
#define COL_BTN    0x3186  /* dark slate button */
#define COL_BORDER 0x9CF3  /* light grey border  */
#define COL_TRACK  0x8410  /* mid grey slider track (turns white in idle mode) */

/* Landscape UI layout (software-rotated 448x368 logical frame):
 * the main screen = header (clock/date/version + lux/battery block),
 * navigation tiles (SID player / alarms / sensors / settings), utility
 * buttons (AUTO ROT / AUTO BRI / SND / BLE mode / SLEEP) and the volume +
 * brightness sliders. Sub-screens share the same header and a centred
 * HOME button on the second header line; the idle clock face is
 * unchanged. */

/* Shared HOME button, centred between the date and the charging status */
#define HOME_X 184
#define HOME_Y 26
#define HOME_W 80
#define HOME_H 28

/* Main screen: utility buttons in a 3x2 grid between the tiles and the
 * sliders (columns align with the sliders below, the middle cell of the
 * second row is intentionally empty) */
#define UB_W 136
#define UB_H 34
#define UB_X1 8
#define UB_X2 156
#define UB_X3 304
#define UB_Y1 198
#define UB_Y2 244

/* Main screen: navigation tiles (SID / alarms / sensors / settings) */
#define TILE_Y 96
#define TILE_W 106
#define TILE_H 92
#define TILE_SID_X 6
#define TILE_ALM_X 116
#define TILE_SENS_X 226
#define TILE_SET_X 336

/* SID screen: transport + subtune buttons first, then four text lines
 * (metadata + a scrolling STIL comment line) */
#define SID_ROW1_Y 84
#define SID_ROW1_H 42
#define SID_TUNEL_X 10
#define SID_TUNEL_W 96
#define SID_PLAY_X 114
#define SID_PLAY_W 150
#define SID_STOP_X 272
#define SID_STOP_W 70
#define SID_TUNER_X 350
#define SID_TUNER_W 88
#define SID_ROW2_Y 134
#define SID_SUB_W 136
#define SID_SUB_H 38
#define SID_SUBL_X 8
#define SID_END_X 156
#define SID_SUBR_X 304

/* text lines under the buttons */
#define SID_LINE1_Y 182
#define SID_LINE2_Y 206
#define SID_LINE3_Y 230
#define SID_LINE4_Y 254

/* SID screen: chip-model button on the author line */
#define SID_CHIP_X 280
#define SID_CHIP_Y 230
#define SID_CHIP_W 155
#define SID_CHIP_H 24

/* Settings screen: the three ambient profiles [NIGHT] [INDOOR] [OUTDOOR]
 * on top, then the LUX + brightness level sliders, a gap, the idle
 * timeout, and the SAVE STATE button (time + configs, in the
 * old frame-rate slot). */
#define SET_BTN_W 136
#define SET_BTN_H 38
#define SET_ROW1_Y 82
#define SET_NIGHT_X 8
#define SET_INDOOR_X 156
#define SET_OUTDOOR_X 304
#define SET_SLD_LUX_Y 142
#define SET_SLD_BRI_Y 186
#define SET_SLD_IDLE_Y 264 /* idle-timeout row: same -/+ style as alarms */
#define SET_SAVE_X 114
#define SET_SAVE_Y 306
#define SET_SAVE_W 220
#define SET_SAVE_H 34

/* Alarms screen: 5 tiles along the bottom, mode + ringtone row, repeat
 * days row and hour/minute/length sliders. */
#define ALM_TILE_W 80
#define ALM_TILE_H 34
#define ALM_TILE_Y 305 /* moved up by half its height for the LEN row */
#define ALM_TILE_X0 8
#define ALM_TILE_DX 88
#define ALM_MODE_Y 84
#define ALM_MODE_W 136
#define ALM_MODE_H 34
#define ALM_MODE_X 8
#define ALM_RING_X 156
#define ALM_RING_W 280
#define ALM_DAY_Y 124
#define ALM_DAY_W 56
#define ALM_DAY_H 32
#define ALM_DAY_X0 16
#define ALM_DAY_DX 60
#define ALM_SLD_HOUR_Y 172
#define ALM_SLD_MIN_Y 208
#define ALM_SLD_LEN_Y 244

/* Rows with -/+ step buttons on both sides of the slider (the slider
 * alone is too coarse): alarm hour/minute/length, settings idle timeout. */
#define ALM_ARR_W 40
#define ALM_ARR_X0 8
#define ALM_SLD_X 56
#define ALM_SLD_W 336
#define ALM_ARR_X1 400

/* Auto brightness: three ambient profiles (night/indoor/outdoor). The lux
 * thresholds and brightness levels are editable on the settings screen and
 * persisted in /home/bright.cfg. The display's own light leaks into the ALS
 * (about 0.05 lx at the night preset, 0.3 lx at 120 and 0.9 lx at full), so
 * the upward thresholds are meant to sit above those floors and downward
 * switching lags: outdoor->indoor at bri_lux[2] (default 75% of the indoor
 * threshold) and indoor->night at 75% of bri_lux[0]. */
#define BRI_NIGHT 20
#define BRI_DIM 120
#define BRI_DAY 240

/* Battery / lux readout, top right (clear of the rounded corner) */
#define BATT_X0 260
#define BATT_X1 419
#define BATT_Y0 4
#define BATT_Y1 76

/* Sliders: volume + brightness on the main and SID screens; LUX level +
 * brightness for the profile and the idle timeout on the settings
 * screen. The value is drawn inside the track. */
#define SLD_X 8
#define SLD_W 432
#define SLD_H 26
#define SLD_VOL_Y 290
#define SLD_BRI_Y 326

/* Idle timeout (no touch) + countdown bar. Settable on the settings
 * screen in 15 s steps from 15 s to 5 min (default 60 s). */
#define IDLE_TIMEOUT_DEF_S 60U
#define IDLE_TIMEOUT_MIN_S 15U
#define IDLE_TIMEOUT_MAX_S 300U
#define CNT_X0 40
#define CNT_X1 408
#define CNT_Y 361

/* 7-segment clock geometry (idle face) */
#define SEG_W 52
#define SEG_H 92
#define SEG_T 10
#define SEG_GAP 10
#define SEG_COLON_W 18
#define CLOCK_TOTAL_W (4 * SEG_W + 3 * SEG_GAP + SEG_COLON_W)
#define CLOCK_DATE_GAP 8
#define CLOCK_BLOCK_H (SEG_H + CLOCK_DATE_GAP + TEXT_CH)
#define CLOCK_AREA_Y 80 /* idle clock+date area (battery strip above) */

/* Accelerometer bars, below the value line */
#define BAR_X 24
#define BAR_W 406
#define BAR_CX (BAR_X + BAR_W / 2)
#define BAR_H 16
#define BAR_Y0 136
#define BAR_DY 26
#define ACCEL_MAX_MG 2000

/* LIS2DH registers (direct fallback path) */
#define ACC_ADDR       0x19
#define ACC_ALT_ADDR   0x18     /* SA0 tied low instead of high */
#define ACC_WHO_AM_I   0x0F
#define ACC_CTRL_REG1  0x20
#define ACC_CTRL_REG2  0x21     /* high-pass filter config */
#define ACC_CTRL_REG3  0x22     /* interrupt routing */
#define ACC_CTRL_REG4  0x23
#define ACC_CTRL_REG5  0x24     /* bit 7: BOOT - reload from OTP */
#define ACC_CTRL_REG6  0x25
#define ACC_REFERENCE  0x26
#define ACC_STATUS_REG 0x27
#define ACC_OUT_X_L    0x28
#define ACC_FIFO_CTRL  0x2E
#define ACC_FIFO_SRC   0x2F

static const struct device *disp;
static const struct device *accel;

/* accelerometer register dump, requested over BLE (debug command 0x1F) */
static void accel_dump(void);
#ifdef SIDCLOCK_DEBUG
static void accel_revive(void);
static void accel_rail_cycle(void);
#endif

static const struct i2c_dt_spec touch_i2c =
	I2C_DT_SPEC_GET(DT_NODELABEL(ft3168));
static const struct gpio_dt_spec touch_rst =
	GPIO_DT_SPEC_GET(DT_NODELABEL(ft3168), reset_gpios);
static const struct gpio_dt_spec touch_irq =
	GPIO_DT_SPEC_GET(DT_NODELABEL(ft3168), irq_gpios);
static struct gpio_callback touch_irq_cb;
static volatile bool touch_irq_flag;
static K_SEM_DEFINE(touch_sem, 0, 1);

static void touch_irq_handler(const struct device *port,
			      struct gpio_callback *cb, uint32_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(cb);
	ARG_UNUSED(pins);
	touch_irq_flag = true;
	k_sem_give(&touch_sem);
}

/*
 * Sensor rail / I2C bus enable.
 * P1.11 must be driven high before the touch controller and accelerometer
 * are powered; otherwise they clamp the I2C bus. Runs before the sensor and
 * display drivers (POST_KERNEL priority 45).
 */
static int sensor_rail_init(void)
{
	const struct device *p1 = DEVICE_DT_GET(DT_NODELABEL(gpio1));

	if (!device_is_ready(p1)) {
		return -ENODEV;
	}

	gpio_pin_configure(p1, 11, GPIO_OUTPUT_ACTIVE);
	return 0;
}

SYS_INIT(sensor_rail_init, POST_KERNEL, 45);

/*
 * Diagnostic: dump the geometry and trailer state of a slot as the
 * application sees it. Comparing this with the bootloader's view tells us
 * whether both agree on where the MCUboot trailer lives.
 */
static void trailer_dump(uint32_t id, const char *name)
{
	const struct flash_area *fa;
	uint8_t b[64] = { 0 };

	if (flash_area_open(id, &fa) != 0) {
		LOG_ERR("%s: flash_area_open failed", name);
		return;
	}

	/* the info block sits in the last 48 bytes of the area */
	off_t base = (off_t)fa->fa_size - (off_t)sizeof(b);

	if (flash_area_read(fa, base, b, sizeof(b)) != 0) {
		LOG_ERR("%s: read failed", name);
		flash_area_close(fa);
		return;
	}

	/* indices inside the 64-byte window */
	uint8_t swap_info = b[24];
	uint8_t copy_done = b[32];
	uint8_t image_ok  = b[40];
	uint8_t magic0    = b[48];

	LOG_INF("%s: off=0x%lx size=0x%lx magic0=0x%02x ok=0x%02x done=0x%02x swap=0x%02x",
		name, (unsigned long)fa->fa_off, (unsigned long)fa->fa_size,
		magic0, image_ok, copy_done, swap_info);

	flash_area_close(fa);
}

static uint8_t band_buf[SCR_W * 16 * 2];
static uint8_t rot_buf[SCR_W * 16 * 2]; /* transposed window (software rot) */

static bool accel_direct;   /* use the direct-poll fallback */
static bool display_on = true;
static bool touch_was_down;
static bool rot_270;         /* landscape mapping: false = 90, true = 270 */
static bool auto_rot = true; /* AUTO ROT: follow the device orientation */
static bool idle_mode;
static bool idle_blank;     /* dark idle (SLEEP): no drawing, alarms on */
static bool sleep_armed;    /* dark idle: wait for the SLEEP tap release */
static int idle_rot;        /* idle face orientation: 0/2 landscape, 1/3 portrait */
static uint8_t idle_quad;   /* last accelerometer quadrant (debug) */

/* Logical frame of the idle face (portrait for rotations 1 and 3). */
static int idle_fw(void)
{
	return (idle_rot & 1) ? NAT_W : SCR_W;
}

static int idle_fh(void)
{
	return (idle_rot & 1) ? NAT_H : SCR_H;
}
static uint8_t brightness = 0x80U;
static uint16_t idle_timeout_s = IDLE_TIMEOUT_DEF_S; /* 15..300 s */
static bool bri_auto = true;     /* brightness follows the ambient profiles */
static uint8_t auto_step = 1;    /* 0 = night, 1 = dim, 2 = day */

/* Ambient profiles, editable on the settings screen and persisted in
 * /home/bright.cfg:
 *   bri_lux[]: mlx levels - [0] night->indoor, [1] indoor->outdoor,
 *              [2] outdoor->indoor (downward safety threshold),
 *   bri_lvl[]: display brightness for night/indoor/outdoor.
 * Defaults reproduce the original fixed presets. */
static uint16_t bri_lux[3] = { 600, 2500, 1875 };
static uint8_t bri_lvl[3] = { BRI_NIGHT, BRI_DIM, BRI_DAY };
static uint8_t bri_manual = 0x80; /* last manual brightness (AUTO off) */
static int bri_sel;        /* profile being edited on the settings screen */
static bool bri_cfg_dirty; /* needs saving to /home/bright.cfg */

/* Alarms (5), edited on the alarms screen, persisted in /home/alarms.cfg.
 * They trigger only while the idle face is up and nothing is playing, and
 * stop when the playback length expires or the screen is touched. */
struct alarm_cfg {
	uint8_t mode;     /* 0 = off, 1 = once, 2 = repeat */
	uint8_t hour;
	uint8_t min;
	uint16_t len_sec; /* playback length, 15..300 s (15 s steps) */
	uint8_t days;     /* repeat: bit 0 = Monday .. bit 6 = Sunday */
	uint8_t sub;      /* ringtone subsong, 0-based */
	char sid[24];     /* ringtone file name ("" = none) */
	char title[20];   /* ringtone title for display */
};
static struct alarm_cfg alarms[5];
static int alm_sel;         /* alarm being edited */
static bool alm_cfg_dirty;  /* needs saving to /home/alarms.cfg */
static bool alarm_ringing;
static uint32_t alarm_until;      /* k_uptime deadline of the ringing alarm */
static uint32_t alarm_fired_min = 0xFFFFFFFFU; /* wall minute already fired */
static uint8_t volume = 26; /* ~10% default: Commando at full blast is loud */
static bool sound_on = true;
static bool fs_ready;
static int fs_mount_err; /* last LittleFS mount failure, 0 when mounted */

/* Active UI screen (the idle clock face is a separate mode: idle_mode) */
enum ui_screen { SCR_MAIN = 0, SCR_SID, SCR_SENSORS, SCR_SETTINGS, SCR_ALARMS };
static enum ui_screen ui_scr;
static char sid_cur_name[24]; /* current /home/<name>.sid ("" = none yet) */
static int sid_end_mode; /* at song end: 0 = next sub (default),
			  * 1 = next tune, 2 = loop the subtune */
static uint16_t sid_lengths[32]; /* <stem>.len values (s); 0 = unknown */
static void sid_load_lengths(const char *name); /* defined with the UI below */
static void sid_stil_load(const char *name); /* defined with the UI below */
static void sid_remember_save(void); /* defined with the UI below */
static void sid_scroll_restart(void); /* defined with the UI below */
static void sid_step(int dir, bool first_sub); /* defined with the UI below */
static void sid_toggle_play(void); /* defined with the UI below */
static void sid_sub_step(int dir); /* defined with the UI below */
static void sid_play_sub(uint8_t sub); /* defined with the UI below */
static uint32_t sid_length_cur(void); /* defined with the UI below */
static int home_list(uint16_t start, uint8_t *dst, int size); /* below */
static void home_list_cache_stale(void); /* below */
static void home_list_cache_remove(const char *name); /* below */
static int16_t ls_start = -1; /* pending /home listing request (page start) */

/* Stack telemetry (debug command 0x1D [+ u8 page]): the interrupt stack
 * first, then per-thread stack (size, free) pairs in creation order, 4
 * rows per page. Only the requested page is latched: the 0xAA sentinel
 * scan runs for those 4 rows instead of all ~10, and the latch keeps the
 * thread handle rather than a copy of its name - the kernel already owns
 * the name (thread->name), so it is read when the snapshot is built.
 * Snapshot [34] marker, [35] page | 0x80 (bit 7 = names present) |
 * 0x40 (bit 6 = last page), [36..51] 4 x (size, free) u16 LE,
 * [52..95] the matching 11-byte names. Bit 7 tells an older host that
 * these bytes are names; bit 6 tells a newer one where the list ends. */
#define STACKS_MAX 12U /* 1 + 11 threads over 3 pages */
#define STACKS_PER_PAGE 4U
#define STACKS_NAME_MAX 11U /* including the terminator */
#define STACKS_NAME_OFF 52U

/* the interrupt stack array (declared the same way in thread_analyzer.c)
 * and the kernel-internal helper behind k_thread_stack_space_get(),
 * neither of which has a public header */
K_KERNEL_STACK_ARRAY_DECLARE(z_interrupt_stacks, CONFIG_MP_MAX_NUM_CPUS,
			     CONFIG_ISR_STACK_SIZE);
extern int z_stack_space_get(const uint8_t *stack_start, size_t size,
			     size_t *unused_ptr);

static bool stacks_pending;
static bool stacks_valid;
static uint8_t stacks_page;
static uint8_t stacks_latched; /* rows stored for the requested page */
static uint8_t stacks_total;   /* rows in the whole listing */
static uint8_t stacks_index;   /* row cursor while latching */
static uint16_t stacks_size[STACKS_PER_PAGE];
static uint16_t stacks_free[STACKS_PER_PAGE];
static const struct k_thread *stacks_thread[STACKS_PER_PAGE]; /* NULL: ISR */

/* True when row idx of the listing belongs to the requested page. */
static bool stacks_row_here(uint8_t idx)
{
	uint8_t base = stacks_page * STACKS_PER_PAGE;

	return idx >= base && (uint8_t)(idx - base) < STACKS_PER_PAGE;
}

/* Store row idx of the listing (thread == NULL for the interrupt stack)
 * in the requested page's slots; `unused` is what the kernel's 0xAA scan
 * counts, i.e. the free high-water mark. */
static void stacks_save(uint8_t idx, const struct k_thread *thread,
			size_t size, size_t unused)
{
	uint8_t slot = idx - stacks_page * STACKS_PER_PAGE;

	stacks_size[slot] = (uint16_t)MIN(size, 0xFFFFU);
	stacks_free[slot] = (uint16_t)MIN(unused, 0xFFFFU);
	stacks_thread[slot] = thread;
	stacks_latched = slot + 1U;
}

static void stacks_walk_cb(const struct k_thread *thread, void *user_data)
{
	uint8_t idx = stacks_index;

	ARG_UNUSED(user_data);
	if (idx >= STACKS_MAX) {
		return; /* listing full: stop counting */
	}
	stacks_index = idx + 1U;
	stacks_total = stacks_index;
	if (stacks_row_here(idx)) {
		size_t unused = 0U;

		if (k_thread_stack_space_get(thread, &unused) != 0) {
			unused = 0U;
		}
		stacks_save(idx, thread, thread->stack_info.size, unused);
	}
}

/* Latch the rows of the requested page: interrupt stack, then threads in
 * creation order (the same order the kernel's thread list uses). Only the
 * rows on that page pay for the 0xAA sentinel scan. */
static void stacks_latch(void)
{
	const uint8_t *buf = K_KERNEL_STACK_BUFFER(z_interrupt_stacks[0]);
	size_t size = K_KERNEL_STACK_SIZEOF(z_interrupt_stacks[0]);
	size_t unused = 0U;

	stacks_latched = 0U;
	stacks_index = 1U; /* row 0: the interrupt stack */
	stacks_total = 1U;
	if (z_stack_space_get(buf, size, &unused) != 0) {
		unused = 0U;
	}
	if (stacks_row_here(0U)) {
		stacks_save(0U, NULL, size, unused);
	}
	k_thread_foreach_unlocked(stacks_walk_cb, NULL);
}

/* Log drain (debug command 0x1E): the log backend writes the LOG_* lines
 * into the SEGGER RTT up-buffer (channel 0) and nothing on the device ever
 * reads it back, so without a debug probe those lines are invisible. This
 * serves them to the BLE snapshot read instead: up to 60 bytes of text at
 * [36..95], byte count in [35], [34] = marker. Modes:
 *   0x1E            consume: the read pointer advances, the bytes are gone
 *   0x1E 0x01       peek: start again at the oldest unread byte
 *   0x1E 0x02       peek: continue after the previous peek chunk
 * A peek never touches the read pointer, so a later consume still sees the
 * window; if the writer ran past the cursor, the next chunk re-syncs to the
 * oldest unread byte. The backend pairs every RTT write with the RTT lock,
 * which is Zephyr's irq_lock (CONFIG_SEGGER_RTT_CUSTOM_LOCKING), so a copy
 * under the same lock can never catch a half-written line. */
#define LOG_CHUNK 60U
static int8_t log_req = -1;   /* pending 0x1E mode, -1 = none */
static uint16_t log_peek_off; /* peek cursor (offset in the RTT buffer) */

static unsigned rtt_log_read(unsigned mode, uint8_t *dst, unsigned want)
{
	const SEGGER_RTT_BUFFER_UP *up = &_SEGGER_RTT.aUp[0];
	unsigned key, size, rd, wr, len, cur, off, n, first;

	if (mode == 0U) {
		/* up-buffer read: advances RdOff, so the bytes are gone.
		 * (SEGGER_RTT_Read() would read the down-buffer instead.) */
		return SEGGER_RTT_ReadUpBuffer(0, dst, want);
	}

	key = irq_lock();
	size = up->SizeOfBuffer;
	rd = up->RdOff;
	wr = up->WrOff;
	/* unread bytes: RdOff == WrOff means empty (one byte stays unused) */
	len = (wr >= rd) ? (wr - rd) : (wr + size - rd);
	cur = (mode == 1U) ? rd : (unsigned)log_peek_off;
	off = (cur >= rd) ? (cur - rd) : (cur + size - rd);
	if (off > len) {
		cur = rd; /* the writer ran past the cursor: re-sync */
		off = 0U;
	}
	n = MIN(len - off, want);
	first = MIN(n, size - cur);
	memcpy(dst, up->pBuffer + cur, first);
	if (n > first) {
		memcpy(dst + first, up->pBuffer, n - first);
	}
	cur += n;
	if (cur >= size) {
		cur -= size;
	}
	log_peek_off = (uint16_t)cur;
	irq_unlock(key);
	return n;
}

/*
 * /home LittleFS (external MX25R64). Mounted WITHOUT auto-format so a dirty
 * or foreign filesystem is never wiped behind the user's back; the explicit
 * "fsformat" debug
 * command (0x0D) formats and mounts when a fresh filesystem is wanted.
 * Served over BLE by MCUmgr fs_mgmt (smpmgr file ...).
 */
FS_LITTLEFS_DECLARE_DEFAULT_CONFIG(sidclock_lfs_data);
static struct fs_mount_t sidclock_fs_mp = {
	.type = FS_LITTLEFS,
	.fs_data = &sidclock_lfs_data,
	.storage_dev = (void *)FIXED_PARTITION_ID(storage_partition),
	.mnt_point = "/home",
	.flags = FS_MOUNT_FLAG_NO_FORMAT,
};

static void fs_storage_init(bool format)
{
	int rc;

	if (fs_ready) {
		LOG_INF("LittleFS already mounted");
		return;
	}

	sidclock_fs_mp.flags = format ? 0 : FS_MOUNT_FLAG_NO_FORMAT;
	rc = fs_mount(&sidclock_fs_mp);
	if (rc < 0) {
		fs_mount_err = rc;
		LOG_WRN("LittleFS mount failed (%d)%s", rc,
			format ? "" :
			" - use the 'fsformat' debug command to recreate it");
		return;
	}
	fs_mount_err = 0;
	fs_ready = true;
	home_list_cache_stale(); /* rebuilt lazily after a format */
	LOG_INF("LittleFS mounted at /home");
}
static uint32_t last_touch_ms;
static uint32_t countdown_second = 0xFFFFFFFFU;

/* Battery / charger (AIN7, P1.12 = CHG, P1.13) */
static const struct adc_dt_spec batt_adc =
	ADC_DT_SPEC_GET(DT_PATH(zephyr_user));
static const struct device *gpio1 = DEVICE_DT_GET(DT_NODELABEL(gpio1));
static const struct device *als = DEVICE_DT_GET(DT_NODELABEL(als_if));
static uint16_t battery_mv;
static uint8_t battery_pct;
static bool charger_on;
static bool ext_power;
static uint8_t chg_pin12;
static uint8_t chg_pin13;
static int32_t als_mlux;
static bool als_ok;
static uint16_t batt_right = BATT_X1; /* moves in idle (burn-in) */

/* ------------------------------------------------------------------ */
/* Graphics helpers (RGB565, big-endian on the wire)                   */
/* ------------------------------------------------------------------ */

/*
 * Software rotation.
 *
 * The panel stays in its native 368x448 portrait address space (MADCTL 0x00,
 * exactly like the stock firmware - its MADCTL handling only produced
 * mirrored/transposed images on this unit). Every window we send is
 * transposed into the native space instead, so the UI can be laid out in a
 * logical 448x368 landscape frame:
 *
 *   rot_270 == false: logical (u,v) -> physical px = v,        py = 447 - u
 *   rot_270 == true : logical (u,v) -> physical px = 367 - v,  py = u
 */
static void write_rect(int x, int y, int w, int h, const uint8_t *buf)
{
	struct display_buffer_descriptor d = { 0 };
	/* The normal UI is landscape; the idle face can be rotated to
	 * portrait or the other landscape orientation (auto rotation). */
	int rot = idle_mode ? idle_rot : (rot_270 ? 2 : 0);

	if (rot == 1) {
		/* portrait, identity: the source buffer is already in panel
		 * layout */
		d.buf_size = (size_t)w * h * 2U;
		d.width = (uint16_t)w;
		d.height = (uint16_t)h;
		d.pitch = 0U;
		display_write(disp, (uint16_t)x, (uint16_t)y, &d, buf);
		return;
	}

	/* src is h rows x w cols, dst is transposed (RGB565) */
	for (int du = 0; du < w; du++) {
		for (int dv = 0; dv < h; dv++) {
			const uint8_t *s = &buf[(dv * w + du) * 2];
			uint8_t *t;

			if (rot == 0) {
				t = &rot_buf[((w - 1 - du) * h + dv) * 2];
			} else if (rot == 2) {
				t = &rot_buf[(du * h + (h - 1 - dv)) * 2];
			} else { /* 3: portrait, 180 deg */
				t = &rot_buf[((h - 1 - dv) * w +
					      (w - 1 - du)) * 2];
			}
			t[0] = s[0];
			t[1] = s[1];
		}
	}

	if (rot == 0) {
		d.buf_size = (size_t)h * w * 2U;
		d.width = (uint16_t)h;
		d.height = (uint16_t)w;
		display_write(disp, (uint16_t)y, (uint16_t)(NAT_H - x - w),
			      &d, rot_buf);
	} else if (rot == 2) {
		d.buf_size = (size_t)h * w * 2U;
		d.width = (uint16_t)h;
		d.height = (uint16_t)w;
		display_write(disp, (uint16_t)(NAT_W - y - h), (uint16_t)x,
			      &d, rot_buf);
	} else {
		d.buf_size = (size_t)w * h * 2U;
		d.width = (uint16_t)w;
		d.height = (uint16_t)h;
		display_write(disp, (uint16_t)(NAT_W - x - w),
			      (uint16_t)(NAT_H - y - h), &d, rot_buf);
	}
}

static void fill_rect(int x, int y, int w, int h, uint16_t color)
{
	const int rows = 16;

	for (int i = 0; i < w * rows; i++) {
		band_buf[2 * i] = (uint8_t)(color >> 8);
		band_buf[2 * i + 1] = (uint8_t)color;
	}

	for (int yy = 0; yy < h; yy += rows) {
		int rh = MIN(rows, h - yy);

		write_rect(x, y + yy, w, rh, band_buf);
	}
}

static uint8_t glyph_bit(char c, int x, int y)
{
	if (c < 32 || c > 126) {
		c = ' ';
	}
	const uint8_t *g = font1524[(uint8_t)c - 32];

	return (g[x * 3 + (y >> 3)] >> (y & 7)) & 1U;
}

static void draw_text(int x, int y, const char *s, uint16_t fg, uint16_t bg)
{
	int n = (int)strlen(s);
	int maxn = (SCR_W - x) / TEXT_CW;
	int w, h;

	if (n > maxn) {
		n = maxn;
	}
	if (n <= 0) {
		return;
	}

	w = n * TEXT_CW;
	h = TEXT_CH;

	/* native glyphs, drawn in 16-row bands (band_buf is 16 rows tall) */
	for (int ry = 0; ry < h; ry += 16) {
		int rh = MIN(16, h - ry);

		for (int py = 0; py < rh; py++) {
			int sy = ry + py;

			for (int px = 0; px < w; px++) {
				char c = s[px / FONT_W];
				uint16_t col = glyph_bit(c, px % FONT_W, sy)
						       ? fg : bg;

				band_buf[(py * w + px) * 2] = (uint8_t)(col >> 8);
				band_buf[(py * w + px) * 2 + 1] = (uint8_t)col;
			}
		}
		write_rect(x, y + ry, w, rh, band_buf);
	}
}

/* ------------------------------------------------------------------ */
/* Text cache: skip drawing identical text and erase residue           */
/* ------------------------------------------------------------------ */
/*
 * Every draw_text() call is one SPI window write straight to the panel.
 * Redrawing unchanged text (battery block every 2 s, song time every
 * second) makes the region visibly blink, so cache the last string per
 * slot: identical text = no panel traffic at all, and a shortened string
 * is padded with background so no separate "clear" pass is needed.
 */
enum {
	TC_TIME = 0, TC_DATE, TC_VER, TC_BATT1, TC_BATT2, TC_BATT3,
	TC_SID_TITLE, TC_SID_AUTHOR, TC_SID_SONG, TC_SID_FILE, TC_SID_CNT,
	TC_SID_CMT, TC_ACCEL, TC_COUNT
};

static struct {
	char s[40];
	uint16_t x, y;
	bool ok;
} tcache[TC_COUNT];

static void text_cache_reset(void)
{
	for (int i = 0; i < TC_COUNT; i++) {
		tcache[i].ok = false;
	}
}

static void draw_text_cached(int slot, int x, int y, const char *s,
			     uint16_t fg, uint16_t bg)
{
	if (slot < 0 || slot >= TC_COUNT) {
		draw_text(x, y, s, fg, bg);
		return;
	}
	if (tcache[slot].ok && tcache[slot].x == (uint16_t)x &&
	    tcache[slot].y == (uint16_t)y &&
	    strcmp(tcache[slot].s, s) == 0) {
		return; /* identical: leave the panel alone */
	}
	if (tcache[slot].ok) {
		/* erase what the previous (possibly wider or shifted) string
		 * covered and the new one does not */
		int old_x = tcache[slot].x;
		int old_w = (int)strlen(tcache[slot].s) * TEXT_CW;
		int new_w = (int)strlen(s) * TEXT_CW;

		if (old_x < x) {
			fill_rect(old_x, y, x - old_x, TEXT_CH, bg);
		}
		if (old_x + old_w > x + new_w) {
			fill_rect(x + new_w, y, old_x + old_w - (x + new_w),
				  TEXT_CH, bg);
		}
	}
	snprintf(tcache[slot].s, sizeof(tcache[slot].s), "%s", s);
	tcache[slot].x = (uint16_t)x;
	tcache[slot].y = (uint16_t)y;
	tcache[slot].ok = true;
	draw_text(x, y, s, fg, bg);
}

/* ------------------------------------------------------------------ */
/* Landscape UI: tiles, buttons, sliders, rotation, sleep              */
/* ------------------------------------------------------------------ */

static bool hit(int x, int y, int x0, int y0, int w, int h)
{
	return x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
}

static void draw_button(int x, int y, int w, int h, const char *label,
			bool active)
{
	/* "active" (toggled/pushed) buttons are inverted: light grey like the
	 * slider track with dark text - green+white was unreadable. */
	uint16_t bg = active ? COL_TRACK : COL_BTN;
	uint16_t fg = active ? COL_BG : COL_WHITE;

	fill_rect(x, y, w, h, bg);
	fill_rect(x, y, w, 1, COL_BORDER);
	fill_rect(x, y + h - 1, w, 1, COL_BORDER);
	fill_rect(x, y, 1, h, COL_BORDER);
	fill_rect(x + w - 1, y, 1, h, COL_BORDER);
	draw_text(x + (w - (int)strlen(label) * TEXT_CW) / 2,
		  y + (h - TEXT_CH) / 2, label, fg, bg);
}

/* Navigation tile: light slate with a centred one- or two-line label. */
static void draw_tile(int x, int y, const char *l1, const char *l2, bool active)
{
	uint16_t bg = active ? COL_TRACK : COL_BTN;
	uint16_t fg = active ? COL_BG : COL_WHITE;
	int yy;

	fill_rect(x, y, TILE_W, TILE_H, bg);
	fill_rect(x, y, TILE_W, 1, COL_BORDER);
	fill_rect(x, y + TILE_H - 1, TILE_W, 1, COL_BORDER);
	fill_rect(x, y, 1, TILE_H, COL_BORDER);
	fill_rect(x + TILE_W - 1, y, 1, TILE_H, COL_BORDER);

	if (l2 != NULL) {
		yy = y + (TILE_H - (2 * TEXT_CH + 8)) / 2;
		draw_text(x + (TILE_W - (int)strlen(l1) * TEXT_CW) / 2, yy, l1,
			  fg, bg);
		draw_text(x + (TILE_W - (int)strlen(l2) * TEXT_CW) / 2,
			  yy + TEXT_CH + 8, l2, fg, bg);
	} else {
		yy = y + (TILE_H - TEXT_CH) / 2;
		draw_text(x + (TILE_W - (int)strlen(l1) * TEXT_CW) / 2, yy, l1,
			  fg, bg);
	}
}

/* ------------------------------------------------------------------ */
/* Wall time: defaults to uptime starting 00:00 on 1 Jan 2000;         */
/* settable over BLE through the standard Current Time Service (CTS)   */
/* ------------------------------------------------------------------ */

static const char *const month_names[12] = {
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
};

static struct k_spinlock time_lock;
static uint32_t epoch_set = 946684800U; /* 2000-01-01 00:00:00 UTC */
static int64_t uptime_set;              /* grtc_ms() of the set */
static uint32_t epoch_last;             /* last wall clock handed out */
static int64_t uptime_last;             /* grtc_ms() of that reading */
static bool time_guard_on;              /* epoch_last/uptime_last valid */
static uint32_t time_glitches;          /* timebase discontinuities seen */

/* Longest the app ever goes without sampling the clock (the dark-panel
 * fallback polls touch every 5 s); more counter time than this between
 * two readings is a timebase jump, not elapsed time. */
#define TIME_MAX_STEP_MS 120000

/* Wall-clock timebase: the raw GRTC system counter (64-bit, 1 MHz).
 *
 * Do NOT go back to k_uptime_get() here: on this port the kernel uptime
 * is seeded through a 32-bit tick count, so it steps by a whole 2^32-tick
 * wrap (137,439 s) whenever the GRTC's absolute tick count crosses such a
 * boundary - seen as a bogus wall-clock jump and a missed alarm on
 * 2026-10-13 (k_uptime 55,157 s vs raw GRTC 192,596 s on the unit). The
 * raw counter is monotonic; only a real GRTC reset (bootloader or driver
 * clear) can move it backwards. */
static int64_t grtc_ms(void)
{
	return (int64_t)(k_cycle_get_64() / 1000U);
}

/* Must be called with time_lock held. Keep the last trusted wall clock
 * across counter resets/jumps: re-anchoring beats inventing time. */
static uint32_t epoch_now_locked(void)
{
	int64_t now = grtc_ms();
	int64_t d = now - uptime_set;
	int64_t step = now - uptime_last;
	uint32_t e;

	if (d < 0) {
		/* Counter restarted under us: re-anchor it to the last
		 * trusted wall clock, never add the wrapped delta. */
		e = time_guard_on ? epoch_last : epoch_set;
		epoch_set = e;
		uptime_set = now;
		time_glitches++;
	} else if (time_guard_on &&
		   (step < 0 || step > TIME_MAX_STEP_MS)) {
		/* Counter jumped: freeze at the last trusted reading. */
		e = epoch_last;
		epoch_set = e;
		uptime_set = now;
		time_glitches++;
	} else {
		e = epoch_set + (uint32_t)(d / 1000);
	}

	epoch_last = e;
	uptime_last = now;
	time_guard_on = true;

	return e;
}

static uint32_t epoch_now(void)
{
	k_spinlock_key_t key = k_spin_lock(&time_lock);
	uint32_t e = epoch_now_locked();

	k_spin_unlock(&time_lock, key);

	return e;
}

/* Days since 1970-01-01 from a civil date (Howard Hinnant's algorithm). */
static int64_t days_from_civil(int y, unsigned m, unsigned d)
{
	int64_t era;
	unsigned yoe, doy, doe;

	y -= (m <= 2U);
	era = (y >= 0 ? y : y - 399) / 400;
	yoe = (unsigned)(y - era * 400);
	doy = (153U * (m > 2U ? m - 3U : m + 9U) + 2U) / 5U + d - 1U;
	doe = yoe * 365U + yoe / 4U - yoe / 100U + doy;

	return era * 146097 + (int64_t)doe - 719468;
}

static void epoch_to_date(uint32_t epoch, int *year, int *month, int *day)
{
	uint32_t days = epoch / 86400U;
	int64_t z = (int64_t)days + 719468;
	int64_t era = z / 146097;
	uint32_t doe = (uint32_t)(z - era * 146097);
	uint32_t yoe = (doe - doe / 1460U + doe / 36524U - doe / 146096U) / 365U;
	int64_t y = (int64_t)yoe + era * 400;
	uint32_t doy = doe - (365U * yoe + yoe / 4U - yoe / 100U);
	uint32_t mp = (5U * doy + 2U) / 153U;
	uint32_t dd = doy - (153U * mp + 2U) / 5U + 1U;
	uint32_t mm = (mp < 10U) ? mp + 3U : mp - 9U;

	*day = (int)dd;
	*month = (int)mm;
	*year = (int)(y + (mm <= 2U));
}

static void time_cfg_save(void); /* defined below */

static void time_set_from_host(uint16_t year, uint8_t mon, uint8_t day,
			       uint8_t hh, uint8_t mm, uint8_t ss)
{
	uint32_t secs = (uint32_t)(days_from_civil(year, mon, day) * 86400 +
				   hh * 3600 + mm * 60 + ss);
	k_spinlock_key_t key = k_spin_lock(&time_lock);

	epoch_set = secs;
	uptime_set = grtc_ms();
	epoch_last = secs;
	uptime_last = uptime_set;
	time_guard_on = true;
	k_spin_unlock(&time_lock, key);

	time_cfg_save(); /* survive reboots (no RTC on the board) */
	LOG_INF("time set: %04u-%02u-%02u %02u:%02u:%02u", year, mon, day, hh,
		mm, ss);
}

/*
 * Wall-clock persistence: /home/time.cfg holds "epoch counter_s uptime_s",
 * sampled together by time_cfg_save() - the epoch is the actual wall clock
 * (not the clock base), the counter is the GRTC timebase in seconds and
 * the uptime field is only diagnostic (people got bitten by k_uptime). At
 * boot the elapsed counter time is added back; if the counter moved
 * backwards (cold boot / GRTC reset) the saved wall clock is kept as-is
 * (no RTC on the board, never invent time). Two-field files from older
 * builds are migrated on the next boot.
 */
static void time_cfg_save(void)
{
	char buf[48];
	struct fs_file_t f;
	k_spinlock_key_t key;
	uint32_t e, u, k;
	int n;

	if (!fs_ready) {
		return;
	}
	key = k_spin_lock(&time_lock);
	e = epoch_now_locked();
	u = (uint32_t)(grtc_ms() / 1000);
	k = (uint32_t)(k_uptime_get() / 1000);
	k_spin_unlock(&time_lock, key);

	n = snprintf(buf, sizeof(buf), "%u %u %u\n", e, u, k);
	fs_file_t_init(&f);
	if (fs_open(&f, "/home/time.cfg",
		    FS_O_WRITE | FS_O_CREATE | FS_O_TRUNC) == 0) {
		(void)fs_write(&f, buf, (size_t)n);
		fs_close(&f);
	}
}

static void time_cfg_load(void)
{
	char buf[48];
	struct fs_file_t f;
	ssize_t rd;
	char *p;
	uint32_t v[3];
	uint32_t base;
	int ntok = 0;
	int64_t now, saved_ms;

	if (!fs_ready) {
		return;
	}
	fs_file_t_init(&f);
	if (fs_open(&f, "/home/time.cfg", FS_O_READ) < 0) {
		return;
	}
	rd = fs_read(&f, buf, sizeof(buf) - 1U);
	fs_close(&f);
	if (rd <= 0) {
		return;
	}
	buf[rd] = '\0';

	p = buf;
	for (int i = 0; i < 3; i++) {
		v[i] = 0;
		while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') {
			p++;
		}
		if (*p < '0' || *p > '9') {
			break;
		}
		while (*p >= '0' && *p <= '9') {
			v[i] = v[i] * 10U + (uint32_t)(*p++ - '0');
		}
		ntok++;
	}
	if (ntok < 2 || v[0] == 0U) {
		return;
	}

	base = v[0];
	if (ntok >= 3) {
		/* Current format: epoch + GRTC seconds (+ k_uptime seconds,
		 * diagnostics only). */
		now = grtc_ms();
		saved_ms = (int64_t)v[1] * 1000;
		if (now >= saved_ms) {
			base += (uint32_t)(now - saved_ms) / 1000U;
		}
	} else {
		/* Pre-GRTC file: the seconds field came from the broken
		 * k_uptime source. Add the elapsed time once (best effort)
		 * and re-save in the current format below. */
		now = k_uptime_get();
		saved_ms = (int64_t)v[1] * 1000;
		if (now >= saved_ms) {
			base += (uint32_t)(now - saved_ms) / 1000U;
		}
		now = grtc_ms();
	}

	k_spinlock_key_t key = k_spin_lock(&time_lock);

	epoch_set = base;
	uptime_set = now;
	epoch_last = base;
	uptime_last = now;
	time_guard_on = true;
	k_spin_unlock(&time_lock, key);
	LOG_INF("time restored: epoch %u counter %u s", base,
		(uint32_t)(now / 1000));

	if (ntok < 3) {
		time_cfg_save(); /* migrate the old k_uptime-based file */
	}
}

/*
 * 24-hour clock. Before the host sets the time this runs from uptime,
 * starting 00:00 on 1 Jan 2000: no RTC, so wall time only lasts until
 * the next power cycle unless the host re-sends it.
 */
static void clock_string(char *buf, size_t len)
{
	uint32_t mins = (epoch_now() / 60U) % (24U * 60U);

	snprintf(buf, len, "%02u:%02u", (unsigned)(mins / 60U),
		 (unsigned)(mins % 60U));
}

/* ------------------------------------------------------------------ */
/* BLE GATT: standard Battery Service + Current Time Service (write)   */
/* ------------------------------------------------------------------ */

static uint8_t ble_batt_level;

static void batt_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);
	ARG_UNUSED(value);
}

static ssize_t ble_batt_read(struct bt_conn *conn,
			     const struct bt_gatt_attr *attr, void *buf,
			     uint16_t len, uint16_t offset)
{
	return bt_gatt_attr_read(conn, attr, buf, len, offset, &ble_batt_level,
				 sizeof(ble_batt_level));
}

BT_GATT_SERVICE_DEFINE(bas_svc,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_DECLARE_16(0x180F)),
	BT_GATT_CHARACTERISTIC(BT_UUID_DECLARE_16(0x2A19),
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ, ble_batt_read, NULL, NULL),
	BT_GATT_CCC(batt_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/*
 * BLE access mode, cycled by the main-screen BLE button:
 *   R/W - everything as usual (time set, debug writes, OTA/SMP)
 *   R/O - no writes at all: CTS and debug writes are rejected and the
 *         mcumgr/SMP service (OTA, file transfer, os reset) is
 *         unregistered; reads keep working
 *   OFF - additionally stop advertising and drop existing connections
 * The mode is intentionally NOT persisted: every boot starts in R/W so
 * OTA and development always work.
 */
enum ble_mode { BLE_MODE_RW = 0, BLE_MODE_RO, BLE_MODE_OFF };

static uint8_t ble_mode = BLE_MODE_RW;
static bool ble_adv_on;        /* connectable advertising is running */
static bool ble_smp_on = true; /* mcumgr transport registers at boot */

static const char *ble_mode_label(void)
{
	return ble_mode == BLE_MODE_OFF ? "BLE OFF" :
	       ble_mode == BLE_MODE_RO ? "BLE R/O" : "BLE R/W";
}

static void ble_apply_mode(void);
static void ble_ui_sync(void);
static void sound_set(bool on);


static uint8_t cts_value[10];

static void cts_fill(void)
{
	uint32_t now = epoch_now();
	uint32_t days = now / 86400U;
	uint32_t rem = now % 86400U;
	int y, m, d;

	epoch_to_date(now, &y, &m, &d);

	sys_put_le16((uint16_t)y, &cts_value[0]);
	cts_value[2] = (uint8_t)m;
	cts_value[3] = (uint8_t)d;
	cts_value[4] = (uint8_t)(rem / 3600U);
	cts_value[5] = (uint8_t)((rem / 60U) % 60U);
	cts_value[6] = (uint8_t)(rem % 60U);
	/* 1 = Monday .. 7 = Sunday; Unix day 0 was a Thursday */
	cts_value[7] = (uint8_t)(((days + 3U) % 7U) + 1U);
	cts_value[8] = 0U; /* fractions of a second (256ths) */
	cts_value[9] = 0U; /* adjust reason: manual time update */
}

static ssize_t ble_cts_read(struct bt_conn *conn,
			    const struct bt_gatt_attr *attr, void *buf,
			    uint16_t len, uint16_t offset)
{
	cts_fill();

	return bt_gatt_attr_read(conn, attr, buf, len, offset, cts_value,
				 sizeof(cts_value));
}

static ssize_t ble_cts_write(struct bt_conn *conn,
			     const struct bt_gatt_attr *attr, const void *buf,
			     uint16_t len, uint16_t offset, uint8_t flags)
{
	const uint8_t *p = buf;
	uint16_t year;
	uint8_t mon, day, hh, mm, ss;

	if (ble_mode != BLE_MODE_RW) {
		return BT_GATT_ERR(BT_ATT_ERR_WRITE_NOT_PERMITTED);
	}
	if (offset != 0U || len != 10U) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}

	year = sys_get_le16(p);
	mon = p[2];
	day = p[3];
	hh = p[4];
	mm = p[5];
	ss = p[6];

	if (year < 1970U || mon < 1U || mon > 12U || day < 1U || day > 31U ||
	    hh > 23U || mm > 59U || ss > 59U) {
		return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
	}

	time_set_from_host(year, mon, day, hh, mm, ss);

	return len;
}

BT_GATT_SERVICE_DEFINE(cts_svc,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_DECLARE_16(0x1805)),
	BT_GATT_CHARACTERISTIC(BT_UUID_DECLARE_16(0x2A2B),
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE |
				       BT_GATT_CHRC_WRITE_WITHOUT_RESP,
			       BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
			       ble_cts_read, ble_cts_write, NULL),
);

/* Ambient light: standard Illuminance characteristic (0.01 lx units) */
static uint8_t ble_lux_value[3]; /* uint24, little-endian */

static ssize_t ble_lux_read(struct bt_conn *conn,
			    const struct bt_gatt_attr *attr, void *buf,
			    uint16_t len, uint16_t offset)
{
	int32_t cl = als_ok ? als_mlux / 10 : 0; /* 0.01 lx units */

	if (cl < 0) {
		cl = 0;
	} else if (cl > 0xFFFFFF) {
		cl = 0xFFFFFF;
	}
	ble_lux_value[0] = (uint8_t)(cl & 0xFF);
	ble_lux_value[1] = (uint8_t)((cl >> 8) & 0xFF);
	ble_lux_value[2] = (uint8_t)((cl >> 16) & 0xFF);

	return bt_gatt_attr_read(conn, attr, buf, len, offset, ble_lux_value,
				 sizeof(ble_lux_value));
}

BT_GATT_SERVICE_DEFINE(ess_svc,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_DECLARE_16(0x181A)),
	/* 0x2AFB = Illuminance (unit: lux, uint24, 0.01 lx resolution).
	 * 0x2A77 would be Irradiance (W/m2) - nRF Connect is right. */
	BT_GATT_CHARACTERISTIC(BT_UUID_DECLARE_16(0x2AFB),
			       BT_GATT_CHRC_READ, BT_GATT_PERM_READ,
			       ble_lux_read, NULL, NULL),
);

/*
 * Debug service (custom UUID): reads the status snapshot; writes trigger
 * sounds (0x01 click, 0x02 beep, 0x03 sound on/off, 0x50 1 s tone) and
 * other developer commands (see docs/ble-services.md).
 */
#define SIDCLOCK_DBG_SVC_UUID                                                  \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x73696463, 0x6c6f, 0x4b01,     \
					       0x9c1d, 0x77ce3f41a5c0))
#define SIDCLOCK_DBG_CHR_UUID                                                  \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x73696463, 0x6c6f, 0x4b02,     \
					       0x9c1d, 0x77ce3f41a5c0))
/* Player status for the web UI (same service): a small state value that
 * notifies (see player_ble_tick) and the strings that only change when a
 * tune loads (re-read when the state generation byte moves). */
#define SIDCLOCK_PLAYER_STATE_CHR_UUID                                         \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x73696463, 0x6c6f, 0x4b03,     \
					       0x9c1d, 0x77ce3f41a5c0))
#define SIDCLOCK_PLAYER_INFO_CHR_UUID                                          \
	BT_UUID_DECLARE_128(BT_UUID_128_ENCODE(0x73696463, 0x6c6f, 0x4b04,     \
					       0x9c1d, 0x77ce3f41a5c0))

/* [0..19] audio status/format/timing, [20..33] I2S registers,
 * [34..95] diag, [96..127] timekeeping telemetry, [128] BLE access mode,
 * [129..139] crash telemetry (see below) */
static uint8_t ble_dbg[140];

/* Crash telemetry in retained RAM (survives watchdog resets): which boot
 * this is, why the last reset happened, thread heartbeats (a stalled
 * counter names the hung thread) and what was playing. Read from the
 * snapshot bytes [129..139] after an unexpected reboot. */
#define CRASH_MAGIC 0xC8A4C1AAu
struct crash_log {
	uint32_t magic;
	uint8_t boots;        /* [129] boot counter (wraps) */
	uint8_t cause_lo;     /* [130] hwinfo reset-cause flags low byte */
	uint8_t cause_hi;     /* [131] ... high byte */
	uint16_t audio_hb;    /* [132..133] audio-thread heartbeat */
	uint16_t main_hb;     /* [134..135] main-thread heartbeat */
	uint8_t engine;       /* [136] 0 = new core, 1 = legacy, 0xFF = none */
	char tune[20];        /* current tune file name (not in snapshot) */
};
static struct crash_log __noinit crash_log;

static const struct device *wdt_dev;
static int wdt_chan = -1;

/* Called once at boot: count boots, latch the reset cause. */
static void crash_log_boot(void)
{
	uint32_t cause = 0U;

	if (crash_log.magic != CRASH_MAGIC) {
		memset(&crash_log, 0, sizeof(crash_log));
		crash_log.magic = CRASH_MAGIC;
	}
	crash_log.boots++;
	if (hwinfo_get_reset_cause(&cause) == 0) {
		crash_log.cause_lo = (uint8_t)cause;
		crash_log.cause_hi = (uint8_t)(cause >> 8);
		(void)hwinfo_clear_reset_cause();
	}
	crash_log.engine = 0xFFU;
}

/* Watchdog: 30 s window fed from the main loop (worst legit gap is ~5 s).
 * Any wedged thread stops the loop directly or via a stuck lock and the
 * device reboots instead of freezing; the retained log tells what died. */
static void watchdog_start(void)
{
	struct wdt_timeout_cfg cfg = {
		.window = { .min = 0U, .max = 30000U },
		.callback = NULL,
		.flags = WDT_FLAG_RESET_SOC,
	};

	wdt_dev = DEVICE_DT_GET(DT_ALIAS(watchdog0));
	if (!device_is_ready(wdt_dev)) {
		wdt_dev = NULL;
		return;
	}
	wdt_chan = wdt_install_timeout(wdt_dev, &cfg);
	if (wdt_chan < 0) {
		wdt_dev = NULL;
		return;
	}
	if (wdt_setup(wdt_dev, WDT_OPT_PAUSE_HALTED_BY_DBG) != 0) {
		wdt_dev = NULL;
	}
}

/* Record what is playing (called on every successful tune load). */
void dbg_record_tune(const char *name, int engine)
{
	size_t nl = strlen(name);

	if (nl >= sizeof(crash_log.tune)) {
		nl = sizeof(crash_log.tune) - 1U;
	}
	memcpy(crash_log.tune, name, nl);
	crash_log.tune[nl] = '\0';
	crash_log.engine = engine ? 1U : 0U;
}

/* Heartbeats for the hang triage (called from the watched threads). */
void dbg_heartbeat_main(void)
{
	crash_log.main_hb++;
}

void dbg_heartbeat_audio(void)
{
	crash_log.audio_hb++;
}

/* Timekeeping telemetry: the wall-clock timebase (GRTC), the kernel uptime
 * (which can step on this port) and the clock guard state - lets a host
 * spot a timebase glitch and see which counter moved. */
static void ble_dbg_time(uint8_t *p)
{
	k_spinlock_key_t key = k_spin_lock(&time_lock);
	uint64_t up = (uint64_t)k_uptime_get();
	uint64_t cyc = k_cycle_get_64();
	uint32_t glitches = time_glitches;
	uint32_t enow = epoch_now_locked();
	uint32_t eset = epoch_set;
	int64_t uset = uptime_set;

	k_spin_unlock(&time_lock, key);

	sys_put_le64(up, p);                            /* k_uptime ms */
	sys_put_le64(cyc, p + 8);                       /* GRTC cycles */
	sys_put_le32(glitches, p + 16);                 /* guard trips */
	sys_put_le32(enow, p + 20);                     /* clock now */
	sys_put_le32(eset, p + 24);                     /* clock base */
	sys_put_le32((uint32_t)(uset / 1000), p + 28);  /* anchor seconds */
}

static ssize_t ble_dbg_read(struct bt_conn *conn,
			    const struct bt_gatt_attr *attr, void *buf,
			    uint16_t len, uint16_t offset)
{
	memcpy(ble_dbg, audio_debug(), 20U);
	audio_read_hw(ble_dbg + 20, 14U);
	audio_diag(ble_dbg + 34, sizeof(ble_dbg) - 34U);
	sid_player_info(ble_dbg + 72, sizeof(ble_dbg) - 72U);

	/* log drain (command 0x1E): replace the diag block with the next
	 * 60-byte chunk of RTT log text; [35] = byte count. Served inline -
	 * a copy under the RTT lock is cheap (unlike the thread walk). */
	bool log_ready = log_req >= 0;

	if (log_ready) {
		unsigned n = rtt_log_read((unsigned)log_req, ble_dbg + 36,
					  LOG_CHUNK);

		memset(ble_dbg + 36 + n, 0, LOG_CHUNK - n);
		ble_dbg[34] = 0x1EU;
		ble_dbg[35] = (uint8_t)n;
		log_req = -1;
	}

	/* pending /home listing (command 0x13): replace the diag block with
	 * "name\n" entries; [95] = next page index or 0xFF when done */
	if (ls_start >= 0 && !log_ready) {
		int next = home_list((uint16_t)ls_start, ble_dbg + 34, 61);

		ble_dbg[95] = (next < 0 || next > 254) ? 0xFFU : (uint8_t)next;
		ls_start = -1;
	}

	if (stacks_valid && !log_ready && ls_start < 0) {
		/* stack telemetry (command 0x1D): [34] marker, [35] page |
		 * 0x80 (names) | 0x40 (last page), [36..51] up to 4 x
		 * (size, free) u16 LE pairs and [52..95] the matching
		 * 11-byte names, 4 rows per page. Row 0 of the listing is
		 * the interrupt stack; its name is filled in here. */
		uint8_t n = 0U;

		ble_dbg[34] = 0x1DU;
		ble_dbg[35] = (uint8_t)(stacks_page | 0x80U);
		if ((stacks_page + 1U) * STACKS_PER_PAGE >= stacks_total) {
			ble_dbg[35] |= 0x40U;
		}
		memset(ble_dbg + 36, 0, 60);
		while (n < stacks_latched) {
			const char *nm;
			size_t k = 0U;

			if (stacks_thread[n] != NULL) {
				nm = k_thread_name_get((k_tid_t)stacks_thread[n]);
				if (nm == NULL || nm[0] == '\0') {
					nm = "?";
				}
			} else {
				nm = "ISR0"; /* single core on this port */
			}
			ble_dbg[36 + 4U * n] = (uint8_t)stacks_size[n];
			ble_dbg[37 + 4U * n] =
				(uint8_t)(stacks_size[n] >> 8);
			ble_dbg[38 + 4U * n] = (uint8_t)stacks_free[n];
			ble_dbg[39 + 4U * n] =
				(uint8_t)(stacks_free[n] >> 8);
			while (k < STACKS_NAME_MAX - 1U && nm[k] != '\0') {
				ble_dbg[STACKS_NAME_OFF + STACKS_NAME_MAX * n + k] =
					nm[k];
				k++;
			}
			n++;
		}
		stacks_valid = false;
	}

	ble_dbg_time(ble_dbg + 96);
	sys_put_le32(ble_mode, ble_dbg + 128); /* [128] mode, rest spare */
	ble_dbg[129] = crash_log.boots; /* crash telemetry [129..139] */
	ble_dbg[130] = crash_log.cause_lo;
	ble_dbg[131] = crash_log.cause_hi;
	ble_dbg[132] = (uint8_t)crash_log.audio_hb;
	ble_dbg[133] = (uint8_t)(crash_log.audio_hb >> 8);
	ble_dbg[134] = (uint8_t)crash_log.main_hb;
	ble_dbg[135] = (uint8_t)(crash_log.main_hb >> 8);
	ble_dbg[136] = crash_log.engine;
	/* [137] filesystem state (0 = /home mounted, 1 = not mounted) and
	 * [138] the mount error code, so `status`/`ls` can say that saves
	 * are going nowhere instead of showing an empty directory */
	ble_dbg[137] = fs_ready ? 0U : 1U;
	ble_dbg[138] = (uint8_t)(fs_mount_err < 0 ? -fs_mount_err : 0);
	/* [139] worst audio-loop gap (ms, low byte) since the previous
	 * snapshot read: a stall that starts after the counter above */
	ble_dbg[139] = audio_take_stall();

	return bt_gatt_attr_read(conn, attr, buf, len, offset, ble_dbg,
				 sizeof(ble_dbg));
}

/* True when `name` ends with `ext` (and is longer than the extension). */
static bool name_has_ext(const char *name, const char *ext)
{
	size_t nl = strlen(name);
	size_t el = strlen(ext);

	return nl > el && strcmp(name + nl - el, ext) == 0;
}

/* Player commands from the BLE write handler are parked here and run by
 * the main loop (sid_req_take): the GATT handlers run on the BT RX
 * workqueue, whose 2 KB stack the SID loader already used at 96 % before
 * "next tune" added a directory scan on top - and the main loop owns the
 * emulator, the sidecars and the filesystem anyway. */
static volatile uint8_t sid_req_op; /* 0 = idle, else the opcode */
static uint8_t sid_req_arg;         /* subtune / chip mode / engine */
static char sid_req_name[24];       /* 0x11 and 0x20 file name */

/* Longest file name the name-taking commands (0x11/0x16/0x20) accept: the
 * buffers are 24 bytes and /home names run up to 23 characters. Anything
 * shorter would lock a tune's sidecars out of the delete command: a
 * `.stil` is one character longer than the `.sid` it belongs to, so the
 * old 20-character cap left e.g. Turrican_intro_s.stil (21) behind. */
#define SID_CMD_NAME_MAX 23U

static int sid_req_post(uint8_t op, uint8_t arg, const char *name)
{
	if (sid_req_op != 0U) {
		return -1; /* one at a time; a host retries or waits */
	}
	if (name != NULL) {
		snprintf(sid_req_name, sizeof(sid_req_name), "%s", name);
	}
	sid_req_arg = arg;
	sid_req_op = op;
	return 0;
}

static ssize_t ble_dbg_write(struct bt_conn *conn,
			     const struct bt_gatt_attr *attr, const void *buf,
			     uint16_t len, uint16_t offset, uint8_t flags)
{
	const uint8_t *p = buf;

	if (ble_mode != BLE_MODE_RW) {
		return BT_GATT_ERR(BT_ATT_ERR_WRITE_NOT_PERMITTED);
	}
	if (offset != 0U ||
	    !(len == 1U ||
	      (len == 2U && p[0] == 0x0EU) ||
	      (len == 2U && p[0] == 0x12U) ||
	      (len == 2U && p[0] == 0x14U) ||
	      (len == 2U && p[0] == 0x15U) ||
	      (len == 3U && p[0] == 0x13U) ||
	      (len == 2U && p[0] == 0x1DU) ||
	      (len == 2U && p[0] == 0x1EU) ||
	      (len == 2U && p[0] == 0x1FU) ||
	      (len >= 2U && len <= SID_CMD_NAME_MAX + 1U && p[0] == 0x11U) ||
	      (len >= 2U && len <= SID_CMD_NAME_MAX + 1U && p[0] == 0x16U) ||
	      (len == 2U && p[0] >= 0x18U && p[0] <= 0x1CU) ||
	      (len >= 3U && len <= SID_CMD_NAME_MAX + 2U && p[0] == 0x20U) ||
	      (len == 2U && p[0] == 0x21U) ||
#ifdef SID_ENGINE_DUAL
	      (len == 2U && p[0] == 0x17U) ||
#endif
	      (len == 5U && (p[0] == 0x09U || p[0] == 0x0AU ||
			     p[0] == 0x0BU || p[0] == 0x10U)))) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}

	switch (p[0]) {
	/* Bring-up test signals (test tones, rate/tone ladders, raw MCKFREQ):
	 * compiled in for debug builds only (SIDCLOCK_DEBUG=1 ./build.sh).
	 * Release builds fall through to default and reject the codes. */
#ifdef SIDCLOCK_DEBUG
	case 0x0B:
		if (len != 5U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		audio_tone_hold((uint32_t)p[1] | ((uint32_t)p[2] << 8) |
				((uint32_t)p[3] << 16) |
				((uint32_t)p[4] << 24), 0U);
		break;
	case 0x0C:
		audio_tone_release();
		break;
	case 0x09:
		if (len != 5U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		audio_set_rate((uint32_t)p[1] | ((uint32_t)p[2] << 8) |
			       ((uint32_t)p[3] << 16) | ((uint32_t)p[4] << 24));
		break;
	case 0x0A:
		if (len != 5U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		audio_set_tone((uint32_t)p[1] | ((uint32_t)p[2] << 8) |
			       ((uint32_t)p[3] << 16) | ((uint32_t)p[4] << 24));
		break;
	case 0x01:
		audio_click();
		break;
	case 0x02:
		audio_beep();
		break;
#endif /* SIDCLOCK_DEBUG */
	case 0x03:
		sound_set(!sound_on);
		break;
	case 0x0D:
		fs_storage_init(true); /* DESTRUCTIVE: formats /home if needed */
		break;
	case 0x0E:
		if (len != 2U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		if (sid_req_post(0x0E, (uint8_t)(p[1] % 10U), NULL) != 0) {
			return BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
		}
		break;
	case 0x11: {
		char name[24];

		if (len < 2U || len > SID_CMD_NAME_MAX + 1U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		memcpy(name, p + 1, len - 1U);
		name[len - 1U] = '\0';
		if (sid_req_post(0x11, 0U, name) != 0) {
			return BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
		}
		break;
	}

	case 0x16: {
		/* Delete a song file from /home (the .sid plus its .len and
		 * .stil sidecars). Restricted to those extensions so the
		 * config files cannot be removed by accident. */
		char name[24], path[40];

		if (len < 2U || len > SID_CMD_NAME_MAX + 1U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		memcpy(name, p + 1, len - 1U);
		name[len - 1U] = '\0';
		if (strchr(name, '/') != NULL || strstr(name, "..") != NULL ||
		    !(name_has_ext(name, ".sid") ||
		      name_has_ext(name, ".len") ||
		      name_has_ext(name, ".stil"))) {
			return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
		}
		snprintf(path, sizeof(path), "/home/%s", name);
		if (fs_unlink(path) != 0) {
			return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
		}
		home_list_cache_remove(name);
		if (strcmp(name, sid_cur_name) == 0) {
			/* the loaded tune is gone: stop it and forget it */
			sid_player_stop();
			audio_sid_stop();
			sid_cur_name[0] = '\0';
			sid_stil_load("");
			sid_remember_save();
		}
		LOG_INF("file deleted: %s", path);
		break;
	}
#ifdef SID_ENGINE_DUAL
	case 0x17:
		/* Global SID engine (0 = new cRSID, 1 = legacy cSID-light);
		 * the main loop stops, flips and restarts the current tune
		 * if one was playing (same as the main-screen button). */
		if (len != 2U || p[1] > 1U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		if (sid_req_post(0x17, p[1], NULL) != 0) {
			return BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
		}
		break;
#endif
	case 0x12:
		if (len != 2U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		if (sid_req_post(0x12, (uint8_t)(p[1] % 3U), NULL) != 0) {
			return BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
		}
		break;
	case 0x13:
		if (len != 3U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		ls_start = (int16_t)((uint16_t)p[1] | ((uint16_t)p[2] << 8));
		break;
	case 0x1D:
		/* Stack telemetry for the overflow hunt: latch the 4 rows of
		 * the requested page (interrupt stack + threads in creation
		 * order) for the snapshot read. The optional 2nd byte
		 * selects page 0..2. */
		if (len != 1U && len != 2U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		if (stacks_pending) {
			return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
		}
		stacks_page = (len == 2U) ? (p[1] & 3U) : 0U;
		stacks_pending = true;
		stacks_valid = false;
		LOG_INF("stack telemetry armed (page %u)", stacks_page);
		break;
	case 0x1E:
		/* Log drain: bare opcode (or 0) consumes a chunk; 1 starts a
		 * peek at the oldest unread byte and 2 continues it. The
		 * snapshot read serves the bytes (see rtt_log_read). */
		if (len == 2U && p[1] > 2U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		log_req = (len == 2U) ? (int8_t)p[1] : 0;
		break;
	case 0x0F:
		sid_player_stop();
		audio_sid_stop();
		break;
	case 0x18:
	case 0x19:
	case 0x1A:
	case 0x1B:
	case 0x1C:
		/* transport for the web UI (play/pause, tune and subtune
		 * steps) - the same actions as the SID screen buttons,
		 * parked for the main loop */
		if (sid_req_post(p[0], 0U, NULL) != 0) {
			return BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
		}
		break;
	case 0x20: {
		/* play /home/<name> at subtune `sub` (1-based, like the
		 * UI counts; 0xFF = the PSID startSong) - `11` plus a
		 * subtune */
		char name[24];

		if (len < 3U || len > SID_CMD_NAME_MAX + 2U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		memcpy(name, p + 2, len - 2U);
		name[len - 2U] = '\0';
		if (sid_req_post(0x20, p[1], name) != 0) {
			return BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
		}
		break;
	}
	case 0x21:
		/* play subtune `sub` (1-based) of the loaded tune */
		if (len != 2U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		if (sid_player_songs() <= 0) {
			return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
		}
		if (sid_req_post(0x21, p[1], NULL) != 0) {
			return BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
		}
		break;
#ifdef SIDCLOCK_DEBUG
	case 0x10:
		if (len != 5U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		audio_set_mck_raw((uint32_t)p[1] | ((uint32_t)p[2] << 8) |
				  ((uint32_t)p[3] << 16) |
				  ((uint32_t)p[4] << 24));
		break;
#endif /* SIDCLOCK_DEBUG */
	case 0x14: {
		/* Developer test: fake a timebase glitch. 0 = counter reset
		 * (anchor pushed ahead of the counter), 1 = forward jump.
		 * The clock guard must absorb both: the snapshot glitch
		 * counter increases and the wall clock must not move. */
		k_spinlock_key_t key;

		if (len != 2U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		key = k_spin_lock(&time_lock);
		if (p[1] == 0U) {
			uptime_set += 200000000; /* ~2.3 days ahead */
		} else {
			uptime_last -= 200000; /* 200 s forward step */
		}
		k_spin_unlock(&time_lock, key);
		break;
	}
	case 0x15:
		/* BLE access mode: 0 = R/W, 1 = R/O, 2 = off. Only reachable
		 * in R/W - the write gate at the top rejects it otherwise. */
		if (len != 2U) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		ble_mode = (uint8_t)(p[1] % 3U);
		ble_apply_mode();
		break;
	case 0x1F:
		/* Accelerometer diagnosis into the log: a read-only register
		 * dump, so a release image can always identify the chip. Bench
		 * builds also take a mode byte: 0x1F 01 reboots the chip and
		 * sweeps ODR settings, 0x1F 02 power-cycles the sensor rail
		 * (touch/ALS are brought back up afterwards). */
#ifdef SIDCLOCK_DEBUG
		if (len == 2U && p[1] == 1U) {
			accel_revive();
			break;
		}
		if (len == 2U && p[1] == 2U) {
			accel_rail_cycle();
			break;
		}
#endif
		accel_dump();
		break;
#ifdef SIDCLOCK_DEBUG
	case 0x07:
		audio_rate_next();
		break;
	case 0x08:
		audio_tone_next();
		break;
	case 0x50:
		audio_long_tone();
		break;
#endif /* SIDCLOCK_DEBUG */
	default:
		return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
	}

	return len;
}

/* --- player status for the web UI ----------------------------------- */
/*
 * Two read characteristics next to the debug snapshot, so a host can
 * follow the player without parsing the developer layout and without
 * polling:
 *
 * state `4b03` (read + notify, 16 bytes):
 *   [0]  flags: b0 playing, b1 paused, b2 sound on, b3 legacy engine
 *   [1]  subtune (0-based), [2] song count, [3] end mode (0..2),
 *   [4]  chip model mode (0 = auto, 1 = 6581, 2 = 8580), [5] chip in
 *        use (1 = 6581, 2 = 8580), [6] info generation, [7] reserved
 *   [8..11] elapsed s (u32 LE), [12..15] current subsong length s
 *
 * info `4b04` (read, 96 bytes): title[32] name[24] author[32] id[8],
 * NUL padded strings. id is the first 4 bytes of the loaded file's
 * whole-file MD5 as 8 lowercase hex characters (all zeros when unknown);
 * HVSC's Songlengths.md5 is keyed on that digest, so a host can match
 * the tune exactly where the file name is not unique. The strings only
 * change when a tune loads - the generation byte in the state tells a
 * subscriber when to re-read them.
 *
 * The state value notifies on any change and once per second while a
 * tune plays (elapsed); a client ticks between notifications. Nothing is
 * sent while there is no subscriber.
 */
static uint8_t player_state[16];
static char player_info[96];
static char player_info_last[96]; /* strings at the last generation bump */
static bool player_state_sub;
static bool player_state_dirty; /* force one notify on (re)subscribe */
static uint8_t player_info_gen;

static void player_copy(char *dst, size_t cap, const char *src)
{
	size_t n = strlen(src);

	if (n > cap) {
		n = cap;
	}
	memcpy(dst, src, n);
}

static void player_info_fill(void)
{
	static const char hex[] = "0123456789abcdef";
	uint8_t id[4];
	unsigned i;

	memset(player_info, 0, sizeof(player_info));
	player_copy(player_info, 32U, sid_player_title());
	player_copy(player_info + 32, 24U, sid_cur_name);
	player_copy(player_info + 56, 32U, sid_player_author());
	/* [88..95] whole-file MD5 prefix as 8 lowercase hex characters -
	 * all zeros when no tune is loaded (no HVSC file has that prefix,
	 * so hosts treat it as "unknown" and fall back to the file name). */
	sid_player_md5_prefix(id);
	for (i = 0; i < ARRAY_SIZE(id); i++) {
		player_info[88 + 2 * i] = hex[id[i] >> 4];
		player_info[89 + 2 * i] = hex[id[i] & 0x0FU];
	}
}

/* Bump the generation byte as soon as the strings change, so even a host
 * that only reads (never subscribes) gets a correct re-read hint. */
static void player_info_check(void)
{
	player_info_fill();
	if (memcmp(player_info, player_info_last, sizeof(player_info)) != 0) {
		memcpy(player_info_last, player_info, sizeof(player_info));
		player_info_gen++;
	}
}

static void player_state_fill(void)
{
	uint8_t flags = 0U;

	if (sid_player_is_playing()) {
		flags |= 0x01U;
	}
	if (sid_player_is_paused()) {
		flags |= 0x02U;
	}
	if (sound_on) {
		flags |= 0x04U;
	}
#ifdef SID_ENGINE_DUAL
	if (sid_player_engine_legacy()) {
		flags |= 0x08U;
	}
#endif
	player_state[0] = flags;
	player_state[1] = (uint8_t)sid_player_subtune();
	player_state[2] = (uint8_t)sid_player_songs();
	player_state[3] = (uint8_t)sid_end_mode;
	player_state[4] = (uint8_t)sid_player_model_mode();
	/* the engine reports the chip as 6581/8580; the wire carries 1/2 */
	player_state[5] = (sid_player_chip() == 8580) ? 2U : 1U;
	player_state[6] = player_info_gen;
	player_state[7] = 0U;
	sys_put_le32(sid_player_elapsed_s(), player_state + 8);
	sys_put_le32(sid_length_cur(), player_state + 12);
}

static ssize_t player_state_read(struct bt_conn *conn,
				 const struct bt_gatt_attr *attr, void *buf,
				 uint16_t len, uint16_t offset)
{
	player_info_check();
	player_state_fill();
	return bt_gatt_attr_read(conn, attr, buf, len, offset, player_state,
				 sizeof(player_state));
}

static ssize_t player_info_read(struct bt_conn *conn,
				const struct bt_gatt_attr *attr, void *buf,
				uint16_t len, uint16_t offset)
{
	player_info_check();
	return bt_gatt_attr_read(conn, attr, buf, len, offset, player_info,
				 sizeof(player_info));
}

static void player_state_ccc_changed(const struct bt_gatt_attr *attr,
				     uint16_t value)
{
	player_state_sub = (value & BT_GATT_CCC_NOTIFY) != 0U;
	if (player_state_sub) {
		player_state_dirty = true; /* one notify right away */
	}
}

BT_GATT_SERVICE_DEFINE(dbg_svc,
	BT_GATT_PRIMARY_SERVICE(SIDCLOCK_DBG_SVC_UUID),
	BT_GATT_CHARACTERISTIC(SIDCLOCK_DBG_CHR_UUID,
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
			       BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
			       ble_dbg_read, ble_dbg_write, NULL),
	/* attrs[4] is this value attribute (player_ble_tick notifies it) */
	BT_GATT_CHARACTERISTIC(SIDCLOCK_PLAYER_STATE_CHR_UUID,
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ,
			       player_state_read, NULL, NULL),
	BT_GATT_CCC(player_state_ccc_changed,
		    BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
	BT_GATT_CHARACTERISTIC(SIDCLOCK_PLAYER_INFO_CHR_UUID,
			       BT_GATT_CHRC_READ, BT_GATT_PERM_READ,
			       player_info_read, NULL, NULL),
);

/* Push the state value when the player moved, plus a 1 Hz elapsed update
 * while a tune plays. Called from the main loop; a no-op while nobody
 * subscribes. */
static void player_ble_tick(void)
{
	static uint8_t last[16];

	if (!player_state_sub) {
		return;
	}

	player_info_check();
	player_state_fill();
	if (player_state_dirty ||
	    memcmp(player_state, last, sizeof(player_state)) != 0) {
		player_state_dirty = false;
		memcpy(last, player_state, sizeof(last));
		(void)bt_gatt_notify(NULL, &dbg_svc.attrs[4], player_state,
				     sizeof(player_state));
	}
}

/*
 * Big 7-segment clock drawn as filled rectangles (no font scaling), moved
 * to a random spot every minute to avoid AMOLED burn-in.
 */
/*
 * 7-segment clock, vector drawn: all geometry derives from a base design
 * (digit 52x92, 10 px bars, 10 px gaps, colon 18 -> total 256 wide) scaled
 * so the clock spans CLOCK_W_PCT_LAND/PORT percent of the active idle
 * frame width. Segments are bars with 45-degree corner chamfers (old
 * calculator look); every 16-row band is composed in band_buf and pushed
 * with a single write_rect.
 */
#define CLOCK_W_PCT_LAND 75 /* clock width, percent of the frame width */
#define CLOCK_W_PCT_PORT 75
#define CLOCK_CHAMFER_PCT 40 /* corner cut, percent of the bar thickness */

/* Ink width of the base design ("HH:MM" = 4 digits + colon + 4 gaps; the
 * colon's own gap sits inside). Scaling by this (not the smaller layout
 * box) keeps the last digit from being clipped by the band write. */
#define CLOCK_BASE_W 266

static int clock_total_w(int fw)
{
	return fw * ((idle_rot & 1) ? CLOCK_W_PCT_PORT : CLOCK_W_PCT_LAND) /
	       100;
}

/* scaled base value (scale is in 1/1000 units) */
static int sc(int v, int sm)
{
	return v * sm / 1000;
}

/* Fill the rows of a chamfered bar that fall inside the band starting at
 * clock row `by` (bar coords are relative to the clock block). */
static void chamfer_rect_band(uint8_t *buf, int bw, int by, int rows,
			      int sx, int sy, int sw, int sh, int c)
{
	int r0 = MAX(sy, by);
	int r1 = MIN(sy + sh, by + rows);

	for (int r = r0; r < r1; r++) {
		int inset = 0;
		int x0, x1;

		if (r - sy < c) {
			inset = c - (r - sy);
		} else if (sy + sh - 1 - r < c) {
			inset = c - (sy + sh - 1 - r);
		}
		x0 = sx + inset;
		x1 = sx + sw - 1 - inset;
		if (x0 < 0) {
			x0 = 0;
		}
		if (x1 >= bw) {
			x1 = bw - 1;
		}
		for (int px = x0; px <= x1; px++) {
			size_t o = ((size_t)(r - by) * (size_t)bw +
				    (size_t)px) *
				   2U;

			buf[o] = 0xFF;
			buf[o + 1] = 0xFF;
		}
	}
}

static void draw_clock_at(int x, int y)
{
	static const uint8_t segs[10] = {
		0x3F, 0x06, 0x5B, 0x4F, 0x66,
		0x6D, 0x7D, 0x07, 0x7F, 0x6F,
	};
	char clk[8];
	char date[16];
	int year, month, day, w;
	int fw = idle_fw();
	int total_w = clock_total_w(fw);
	int sm = total_w * 1000 / CLOCK_BASE_W;
	int t = sc(SEG_T, sm); /* bar thickness */
	int c = t * CLOCK_CHAMFER_PCT / 100;
	int dh = sc(SEG_H, sm);
	int dw = sc(SEG_W, sm);
	int dgap = sc(SEG_GAP, sm);
	int cw = sc(SEG_COLON_W, sm);

	if (c < 1) {
		c = 1;
	}

	clock_string(clk, sizeof(clk));

	for (int by = 0; by < dh; by += 16) {
		int rows = MIN(16, dh - by);
		int cx = 0;

		memset(band_buf, 0, (size_t)total_w * (size_t)rows * 2U);

		for (int i = 0; clk[i] != '\0'; i++) {
			if (clk[i] == ':') {
				int dotx = cx + (cw - t) / 2;

				chamfer_rect_band(band_buf, total_w, by, rows,
						  dotx, dh / 2 - 2 * t, t, t,
						  c);
				chamfer_rect_band(band_buf, total_w, by, rows,
						  dotx, dh / 2 + t, t, t, c);
				cx += cw + dgap;
				continue;
			}
			{
				uint8_t m = segs[clk[i] - '0'];
				int ym = dh / 2;
				/* gap between the upper and lower verticals:
				 * a quarter bar per side (keeps digits without
				 * the middle segment like 0/1 from looking
				 * split while 8/9/5 stay seamless) */
				int mh = MAX(1, t / 4);

				if (m & 0x01) {
					chamfer_rect_band(band_buf, total_w, by,
							  rows, cx + t, 0,
							  dw - 2 * t, t, c);
				}
				if (m & 0x02) {
					chamfer_rect_band(band_buf, total_w, by,
							  rows, cx + dw - t, t,
							  t, dh / 2 - t - mh, c);
				}
				if (m & 0x04) {
					chamfer_rect_band(band_buf, total_w, by,
							  rows, cx + dw - t,
							  dh / 2 + mh, t,
							  dh / 2 - t - mh, c);
				}
				if (m & 0x08) {
					chamfer_rect_band(band_buf, total_w, by,
							  rows, cx + t,
							  dh - t, dw - 2 * t,
							  t, c);
				}
				if (m & 0x10) {
					chamfer_rect_band(band_buf, total_w, by,
							  rows, cx, dh / 2 + mh, t,
							  dh / 2 - t - mh, c);
				}
				if (m & 0x20) {
					chamfer_rect_band(band_buf, total_w, by,
							  rows, cx, t, t,
							  dh / 2 - t - mh, c);
				}
				if (m & 0x40) {
					chamfer_rect_band(band_buf, total_w, by,
							  rows, cx + t,
							  ym - t / 2,
							  dw - 2 * t, t, c);
				}
				cx += dw + dgap;
			}
		}
		write_rect(x, y + by, total_w, rows, band_buf);
	}

	/* date centred under the digits, moving with the clock */
	epoch_to_date(epoch_now(), &year, &month, &day);
	snprintf(date, sizeof(date), "%d %s %d", day, month_names[month - 1],
		 year);
	w = (int)strlen(date) * TEXT_CW;
	draw_text(x + (total_w - w) / 2, y + dh + CLOCK_DATE_GAP, date,
		  COL_WHITE, COL_BG);
}

/*
 * Screen-jitter PRNG (xorshift32). Deliberately NOT sys_rand32_get(): the
 * only entropy device on this board is the BT HCI RNG, so the first call
 * makes the host send an HCI LE Rand command; if that response is late the
 * BT assert (CONFIG_BT_ASSERT) halts the system - blank screen, dead touch,
 * dead BLE. The positions only need to look scattered, so a local generator
 * seeded from the cycle counter is plenty.
 */
static uint32_t jitter_state;

static uint32_t jitter_next(void)
{
	uint32_t x = jitter_state;

	if (x == 0U) {
		x = k_cycle_get_32() ^ 0x9e3779b9U;
	}
	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	jitter_state = x;

	return x;
}

/* True while the idle face should show the clock alone (night profile):
 * the battery/lux block is hidden and the clock may use the whole frame. */
static bool idle_night(void)
{
	if (!idle_mode) {
		return false;
	}
	return bri_auto ? (auto_step == 0U) : (brightness <= BRI_NIGHT);
}

static bool idle_night_last; /* last drawn idle face variant */

static void draw_clock_random(void)
{
	int fw = idle_fw();
	int fh = idle_fh();
	int night = idle_night();
	int tw = clock_total_w(fw);
	int sm = tw * 1000 / CLOCK_BASE_W;
	int dh = sc(SEG_H, sm);
	int block_h = dh + CLOCK_DATE_GAP + TEXT_CH;
	int y0 = night ? 2 : (CLOCK_AREA_Y + 2);
	int x = 12 + (int)(jitter_next() % (unsigned)(fw - tw - 24));
	int y = y0 + (int)(jitter_next() %
			   (unsigned)(fh - y0 - block_h - 8));

	/* clear the area the clock can use (the whole frame in night mode,
	 * below the battery strip otherwise) */
	if (night) {
		fill_rect(0, 0, fw, fh, COL_BG);
	} else {
		fill_rect(0, CLOCK_AREA_Y, fw, fh - CLOCK_AREA_Y, COL_BG);
	}
	draw_clock_at(x, y);
}

/* Sliders: the value is drawn inside the track (the small labels on the
 * left were removed; the settings status line too). */
static void draw_slider_bar_at(int x, int y, int w, uint32_t val,
			       uint32_t max_val, const char *text)
{
	const uint32_t track = (uint32_t)w - 6U;
	int fill = (int)((track * val) / max_val);
	int tw = (int)strlen(text) * TEXT_CW;
	int tx = x + (w - tw) / 2;

	fill_rect(x - 2, y - 2, w + 4, SLD_H + 4, COL_BORDER);
	fill_rect(x, y, w, SLD_H, COL_TRACK);
	fill_rect(x + 2, y + 2, fill, SLD_H - 4, COL_GREEN);
	fill_rect(x + 2 + fill, y + 2, 2, SLD_H - 4, COL_WHITE);
	/* value on a small dark pill for contrast over fill and track */
	fill_rect(tx - 3, y + 1, tw + 6, SLD_H - 2, COL_BG);
	draw_text(tx, y + 1, text, COL_WHITE, COL_BG);
}

static void draw_slider_bar(int y, uint32_t val, uint32_t max_val,
			    const char *text)
{
	draw_slider_bar_at(SLD_X, y, SLD_W, val, max_val, text);
}

/* Brightness slider (continuous) */
static void draw_slider_brightness(void)
{
	char t[16];

	snprintf(t, sizeof(t), "BRI %u%%", brightness * 100U / 255U);
	draw_slider_bar(SLD_BRI_Y, brightness, 255U, t);
}

/* Volume slider (software volume of the synthesised tones) */
static void draw_slider_volume(void)
{
	char t[16];

	snprintf(t, sizeof(t), "VOL %u%%", volume * 100U / 255U);
	draw_slider_bar(SLD_VOL_Y, volume, 255U, t);
}

/* Settings: lux level and brightness of the profile being edited. */
static void draw_slider_lux(void)
{
	char t[16];
	uint16_t v = bri_lux[bri_sel];

	snprintf(t, sizeof(t), "LUX %u.%02u", v / 1000U, (v % 1000U) / 10U);
	draw_slider_bar(SET_SLD_LUX_Y, v, 10000U, t);
}

static void draw_slider_set_bri(void)
{
	char t[16];

	snprintf(t, sizeof(t), "BRI %u%%", bri_lvl[bri_sel] * 100U / 255U);
	draw_slider_bar(SET_SLD_BRI_Y, bri_lvl[bri_sel], 255U, t);
}

/* Idle timeout: 15 s steps, 15 s .. 5 min (same -/+ style as alarms). */
static void draw_slider_idle(void)
{
	char t[16];

	snprintf(t, sizeof(t), "IDLE %u:%02u", idle_timeout_s / 60U,
		 idle_timeout_s % 60U);
	draw_button(ALM_ARR_X0, SET_SLD_IDLE_Y, ALM_ARR_W, SLD_H, "-", false);
	draw_slider_bar_at(ALM_SLD_X, SET_SLD_IDLE_Y, ALM_SLD_W,
			   (uint32_t)(idle_timeout_s / 15U - 1U), 19U, t);
	draw_button(ALM_ARR_X1, SET_SLD_IDLE_Y, ALM_ARR_W, SLD_H, "+", false);
}

/* Grey bar at the bottom edge: shrinks as the idle timeout approaches. */
static void draw_countdown(uint32_t elapsed_ms)
{
	uint32_t total = (uint32_t)idle_timeout_s * 1000U;
	uint32_t remain = (elapsed_ms >= total) ? 0U : (total - elapsed_ms);
	int w = (int)(((uint32_t)(CNT_X1 - CNT_X0) * remain) / total);

	fill_rect(CNT_X0, CNT_Y, CNT_X1 - CNT_X0, 3, COL_BG);
	if (w > 0) {
		fill_rect(CNT_X0, CNT_Y, w, 3, COL_BORDER);
	}
}

static void draw_accel_bars(const int mg[3]);
static void show_accel(void);

static void draw_battery(void);
static void draw_clock_random(void);
static void enter_idle(void);
static void exit_idle(void);
static void accel_resume(void);
static void accel_suspend(void);
static int accel_ui_rot(void);
static void batt_move_random(void);
static bool alarm_any_armed(void);
static void alarm_service(void);
static void alarm_capture_ringtone(void);
static void alm_cfg_save(void);
static void alm_cfg_load(void);
static void sound_set(bool on);

/* --- header shared by all screens ---------------------------------- */

static void date_string(char *buf, size_t len)
{
	static const char *const wd[7] = {
		"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
	};
	uint32_t epoch = epoch_now();
	uint32_t days = epoch / 86400U;
	int y, m, d;

	epoch_to_date(epoch, &y, &m, &d);
	/* Unix day 0 (1970-01-01) was a Thursday: index 4 in this Sun-first table */
	snprintf(buf, len, "%s %02d %s", wd[(days + 4U) % 7U], d,
		 month_names[m - 1]);
}

/* Time + date lines only: cheap redraw when the minute changes. */
static void redraw_clock(void)
{
	char line[32];

	/* only the first line needs to clear the rounded corner */
	clock_string(line, sizeof(line));
	draw_text_cached(TC_TIME, 23, 4, line, COL_WHITE, COL_BG);
	date_string(line, sizeof(line));
	draw_text_cached(TC_DATE, 8, 28, line, COL_WHITE, COL_BG);
}

static void draw_header(void)
{
	redraw_clock();
	draw_text_cached(TC_VER, 8, 52, "v" SIDCLOCK_VERSION SID_ENGINE_SUFFIX SIDCLOCK_DEBUG_SUFFIX, COL_CYAN, COL_BG);
	draw_battery();
}

/* --- screens -------------------------------------------------------- */

static void draw_main_screen(void)
{
	draw_header();

	draw_tile(TILE_SID_X, TILE_Y, "SID", "PLAYER", false);
	draw_tile(TILE_ALM_X, TILE_Y, "ALARMS",
		  alarm_any_armed() ? "(ON)" : "(OFF)", false);
	draw_tile(TILE_SENS_X, TILE_Y, "SENSOR", NULL, false);
	draw_tile(TILE_SET_X, TILE_Y, "SETUP", NULL, false);

	draw_button(UB_X1, UB_Y1, UB_W, UB_H,
		    auto_rot ? "AUTO ROT" : "ROT OFF", auto_rot);
	draw_button(UB_X2, UB_Y1, UB_W, UB_H, "AUTO BRI", bri_auto);
	draw_button(UB_X3, UB_Y1, UB_W, UB_H,
		    sound_on ? "SND ON" : "SND OFF", sound_on);
	draw_button(UB_X1, UB_Y2, UB_W, UB_H, ble_mode_label(),
		    ble_mode != BLE_MODE_OFF);
#ifdef SID_ENGINE_DUAL
	draw_button(UB_X2, UB_Y2, UB_W, UB_H,
		    sid_player_engine_legacy() ? "cSID" : "cRSID",
		    false); /* neither engine is "selected": it is an A/B toggle */
#endif
	draw_button(UB_X3, UB_Y2, UB_W, UB_H, "SLEEP", false);

	draw_slider_volume();
	draw_slider_brightness();
}

/* SID player screen: track info + transport, sliders and header. */
static void sid_text(char *dst, size_t len, const char *src)
{
	snprintf(dst, len, "%.16s", src);
}

/* Song lengths for the loaded file: optional sidecar /home/<name>.len with
 * space/comma-separated seconds per subtune (a single value applies to all
 * subtunes). PSID itself carries no lengths, so without this file the
 * player cannot know when a tune has "ended". */
static void sid_load_lengths(const char *name)
{
	char path[32], buf[128];
	struct fs_file_t f;
	ssize_t rd;
	char *p;
	int i;
	size_t l = strlen(name);

	memset(sid_lengths, 0, sizeof(sid_lengths));
	if (l <= 4U) {
		return;
	}
	/* "<name>.sid" -> "/home/<name>.len" */
	snprintf(path, sizeof(path), "/home/%.*s.len", (int)(l - 4U), name);
	fs_file_t_init(&f);
	if (fs_open(&f, path, FS_O_READ) < 0) {
		return;
	}
	rd = fs_read(&f, buf, sizeof(buf) - 1U);
	fs_close(&f);
	if (rd <= 0) {
		return;
	}
	buf[rd] = '\0';

	p = buf;
	for (i = 0; i < (int)ARRAY_SIZE(sid_lengths); i++) {
		long v = 0;

		while (*p != '\0' && (*p < '0' || *p > '9')) {
			p++;
		}
		if (*p == '\0') {
			break;
		}
		while (*p >= '0' && *p <= '9') {
			v = v * 10 + (*p++ - '0');
			if (v > 3600) {
				v = 3600;
			}
		}
		sid_lengths[i] = (uint16_t)v;
	}
	LOG_INF("sid lengths for %s: %us...", name, sid_lengths[0]);
}

/*
 * STIL metadata sidecar <stem>.stil (built by tools/sid_add.py from HVSC's
 * STIL.txt): one subsong name per line in subsong order, then an optional
 * tune comment line, then optional "@<subsong> <comment>" lines with the
 * per-subsong notes (HVSC's "(#N) COMMENT"). PSID itself has no names.
 */
#define SID_STIL_MAX 3072
static char sid_stil_buf[SID_STIL_MAX];
static uint16_t sid_stil_off[32];     /* subsong name offsets */
static uint16_t sid_stil_sub_off[32]; /* per-subsong comment offsets, 0 none */
static uint8_t sid_stil_names;
static char *sid_stil_comment;        /* tune-level comment, may be NULL */
static bool sid_stil_has_cmt;         /* any comment: tune or per-subsong */

static void sid_stil_load(const char *name)
{
	struct fs_file_t f;
	char path[32];
	size_t l = strlen(name);
	ssize_t rd;
	char *p;
	int songs;

	sid_stil_names = 0;
	sid_stil_comment = NULL;
	sid_stil_has_cmt = false;
	memset(sid_stil_sub_off, 0, sizeof(sid_stil_sub_off));
	sid_scroll_restart(); /* restart scrolling */
	if (l <= 4U) {
		return;
	}
	snprintf(path, sizeof(path), "/home/%.*s.stil", (int)(l - 4U), name);
	fs_file_t_init(&f);
	if (fs_open(&f, path, FS_O_READ) < 0) {
		return;
	}
	rd = fs_read(&f, sid_stil_buf, SID_STIL_MAX - 1U);
	fs_close(&f);
	if (rd <= 0) {
		return;
	}
	sid_stil_buf[rd] = '\0';

	songs = sid_player_songs();
	if (songs > (int)ARRAY_SIZE(sid_stil_off)) {
		songs = (int)ARRAY_SIZE(sid_stil_off);
	}
	p = sid_stil_buf;
	for (int i = 0; i < songs; i++) {
		char *nl = strchr(p, '\n');

		sid_stil_off[sid_stil_names++] = (uint16_t)(p - sid_stil_buf);
		if (nl == NULL) {
			p = p + strlen(p);
			break;
		}
		*nl = '\0';
		p = nl + 1;
	}
	while (*p == '\n' || *p == '\r') {
		p++;
	}
	/* the tune-level comment, then "@<sub> <text>" per-subsong notes */
	if (*p != '\0') {
		char *nl = strchr(p, '\n');
		char *next = (nl != NULL) ? nl + 1 : p + strlen(p);
		size_t len;

		if (nl != NULL) {
			*nl = '\0';
		}
		len = strlen(p);
		if (len > 0U && p[len - 1U] == '\r') {
			p[len - 1U] = '\0';
		}
		if (*p != '\0') {
			sid_stil_comment = p;
			sid_stil_has_cmt = true;
		}
		p = next;
	}
	while (*p != '\0') {
		char *nl, *q;
		int n = 0;

		while (*p == '\n' || *p == '\r') {
			p++;
		}
		if (*p == '\0') {
			break;
		}
		nl = strchr(p, '\n');
		q = p + 1;
		if (*p == '@') {
			while (*q >= '0' && *q <= '9') {
				n = n * 10 + (*q - '0');
				q++;
			}
		}
		if (*p == '@' && n >= 1 &&
		    n <= (int)ARRAY_SIZE(sid_stil_sub_off) && *q == ' ') {
			char *c = q + 1;
			size_t len = (nl != NULL) ? (size_t)(nl - c)
						  : strlen(c);

			while (len > 0U && c[len - 1U] == '\r') {
				len--;
			}
			if (len > 0U) {
				c[len] = '\0';
				sid_stil_sub_off[n - 1] =
					(uint16_t)(c - sid_stil_buf);
				sid_stil_has_cmt = true;
			}
		}
		if (nl == NULL) {
			break;
		}
		p = nl + 1;
	}
	{
		uint32_t notes = 0;

		for (int i = 0; i < (int)ARRAY_SIZE(sid_stil_sub_off); i++) {
			if (sid_stil_sub_off[i] != 0U) {
				notes++;
			}
		}
		LOG_INF("stil %s: %u names, comment %s, %u subsongs with notes",
			name, sid_stil_names,
			sid_stil_comment != NULL ? "yes" : "no", notes);
	}
}

static const char *sid_sub_name(int sub)
{
	if (sub < 0 || sub >= (int)sid_stil_names) {
		return "";
	}
	return &sid_stil_buf[sid_stil_off[sub]];
}

/* Comment text for the SID screen: the current subsong's own STIL note,
 * else the tune-level comment ("" when the tune has none). */
static const char *sid_comment_text(void)
{
	int sub = sid_player_subtune();

	if (sub >= 0 && sub < (int)ARRAY_SIZE(sid_stil_sub_off) &&
	    sid_stil_sub_off[sub] != 0U) {
		return &sid_stil_buf[sid_stil_sub_off[sub]];
	}
	return sid_stil_comment != NULL ? sid_stil_comment : "";
}

/*
 * Remember the last loaded tune across restarts: /home/sid.cfg holds the
 * file name; at boot it is re-loaded (metadata visible, PLAY starts it)
 * but intentionally NOT started.
 */
static void sid_remember_save(void)
{
	struct fs_file_t f;

	if (!fs_ready || sid_cur_name[0] == '\0') {
		return;
	}
	fs_file_t_init(&f);
	if (fs_open(&f, "/home/sid.cfg",
		    FS_O_WRITE | FS_O_CREATE | FS_O_TRUNC) == 0) {
		(void)fs_write(&f, sid_cur_name, strlen(sid_cur_name));
		fs_close(&f);
	}
}

static void sid_remember_load(void)
{
	struct fs_file_t f;
	char name[24];
	char path[40];
	ssize_t rd;

	if (!fs_ready) {
		return;
	}
	fs_file_t_init(&f);
	if (fs_open(&f, "/home/sid.cfg", FS_O_READ) < 0) {
		return;
	}
	rd = fs_read(&f, name, sizeof(name) - 1U);
	fs_close(&f);
	if (rd <= 0) {
		return;
	}
	name[rd] = '\0';
	while (rd > 0 && (name[rd - 1] == '\n' || name[rd - 1] == '\r' ||
			  name[rd - 1] == ' ')) {
		name[--rd] = '\0';
	}
	if (rd < 5 || strstr(name, ".sid") == NULL) {
		return;
	}
	snprintf(path, sizeof(path), "/home/%s", name);
	if (sid_player_load(path) != 0) {
		return;
	}
	snprintf(sid_cur_name, sizeof(sid_cur_name), "%s", name);
	sid_load_lengths(sid_cur_name);
	sid_stil_load(sid_cur_name);
	/* left stopped on purpose: PLAY starts it */
	LOG_INF("last SID restored (stopped): %s", sid_cur_name);
}

static uint32_t sid_length_cur(void)
{
	int total = sid_player_songs();
	int sub = sid_player_subtune();

	if (sid_lengths[0] == 0U) {
		return 0U; /* unknown: no auto advance */
	}
	if (total > 1 && sid_lengths[1] != 0U &&
	    sub < (int)ARRAY_SIZE(sid_lengths)) {
		return sid_lengths[sub]; /* per-subtune table */
	}
	return sid_lengths[0]; /* single value: all subtunes */
}

/* --- SID info block with marquee scrolling -------------------------- */

/* Layout: line 1 = title + song x/y (right), line 2 = subsong name (from
 * the STIL sidecar; the file name when STIL has none) + elapsed/length
 * (right), line 3 = author + chip button, line 4 = STIL comment. Texts
 * that do not fit their window scroll left one letter per second and
 * back. */
#define SID_TITLE_CHARS 24
#define SID_SUB_CHARS 16
#define SID_CMT_CHARS 28

/*
 * Marquee scrolling: each marquee (title / subsong name / comment) has its
 * own phase and only restarts when its text changes, so the tune comment
 * keeps scrolling while stepping through subsongs that fall back to it (a
 * subsong's own note starts from the beginning). New tunes restart all
 * three via sid_scroll_restart(). The offset accumulates one second per
 * second only while the SID screen is visible, so time on the idle face
 * (or any other screen) pauses the scroll instead of silently running it
 * on. `tail` adds extra travel so the last words stay readable (the
 * comment keeps its last word at 1/3 from the window end).
 */
enum { SID_SCRL_TITLE, SID_SCRL_SUB, SID_SCRL_CMT, SID_SCRL_N };

struct sid_scroll {
	uint32_t ms;   /* accumulated visible ms since the text changed */
	uint32_t last; /* k_uptime at the last accumulation */
	bool started;
};

static struct sid_scroll sid_scrolls[SID_SCRL_N];
static const char *sid_scroll_text[SID_SCRL_N]; /* last text per marquee */

/* True while the painted comment row matches sid_comment_text(), so a
 * repaint that does not change the text can leave the row (and its scroll
 * position) alone. Cleared whenever the row could have been clobbered
 * (full-screen repaint, slider-layout erase). */
static bool sid_cmt_painted;

static void sid_scroll_reset(struct sid_scroll *s)
{
	s->ms = 0;
	s->last = k_uptime_get_32();
	s->started = true;
}

/* True when the marquee text differs from its last painted value. */
static bool sid_scroll_text_changed(int which, const char *text)
{
	const char *old = sid_scroll_text[which];

	return old == NULL || strcmp(old, text) != 0;
}

/* Restart a marquee when its text changed (compare content: covers fresh
 * pointers as well as buffers rewritten in place). */
static void sid_scroll_sync(int which, const char *text)
{
	if (sid_scroll_text_changed(which, text)) {
		sid_scroll_text[which] = text;
		sid_scroll_reset(&sid_scrolls[which]);
	}
}

/* New tune: restart every marquee. */
static void sid_scroll_restart(void)
{
	for (int i = 0; i < SID_SCRL_N; i++) {
		sid_scroll_text[i] = NULL;
		sid_scroll_reset(&sid_scrolls[i]);
	}
}

/* Called from the main loop: bank the time since the last call when the
 * marquee is on show. */
static void sid_scroll_advance(bool visible)
{
	uint32_t now = k_uptime_get_32();

	for (int i = 0; i < SID_SCRL_N; i++) {
		struct sid_scroll *s = &sid_scrolls[i];

		if (!s->started) {
			s->started = true;
			s->last = now;
			continue;
		}
		if (visible) {
			s->ms += now - s->last;
		}
		s->last = now;
	}
}

static int sid_scroll_off(int which, int n, int win, int tail)
{
	const struct sid_scroll *s = &sid_scrolls[which];
	int maxo = n - win + tail;

	if (maxo <= 0) {
		return 0;
	}
	return (int)((s->ms / 1000U) % (uint32_t)(maxo + 1));
}

/* Build a `win`-wide window of `s` starting at `off` (padded with spaces)
 * and draw it via the given cache slot. */
static void draw_marquee(int slot, int x, int y, const char *s, int win,
			 int off, uint16_t fg)
{
	char buf[48];
	int n = (int)strlen(s);

	/* Clamp against the REAL string length: clamping to the buffer size
	 * would pin every offset past buf[] to the same window and make the
	 * marquee appear to stop there. The %.s precision below already
	 * bounds how much snprintf copies, so buf[] cannot overflow. */
	if (off > n) {
		off = n;
	}
	snprintf(buf, sizeof(buf), "%-*.*s", win, win, s + off);
	draw_text_cached(slot, x, y, buf, fg, COL_BG);
}

/* Text shown on the subsong line: the STIL subsong name when available,
 * else the loaded file name. */
static const char *sid_sub_text(void)
{
	const char *n = sid_sub_name(sid_player_subtune());

	if (n[0] != '\0') {
		return n;
	}
	return sid_cur_name[0] ? sid_cur_name : "-";
}

static void draw_sid_title_line(void)
{
	const char *t = sid_player_title();
	const char *disp = t[0] ? t : "(no sid)";

	sid_scroll_sync(SID_SCRL_TITLE, disp);
	draw_marquee(TC_SID_TITLE, 8, SID_LINE1_Y, disp, SID_TITLE_CHARS,
		     sid_scroll_off(SID_SCRL_TITLE, (int)strlen(disp),
				    SID_TITLE_CHARS, 0),
		     COL_WHITE);
}

/* Song counter (x/y) on the right of the title line. */
static void draw_sid_counter_line(void)
{
	char cnt[16];
	int w;

	if (sid_player_songs() <= 0) {
		snprintf(cnt, sizeof(cnt), "-/-");
	} else {
		snprintf(cnt, sizeof(cnt), "%d/%d",
			 sid_player_subtune() + 1, sid_player_songs());
	}
	w = (int)strlen(cnt) * TEXT_CW;
	draw_text_cached(TC_SID_CNT, 440 - w, SID_LINE1_Y, cnt, COL_WHITE,
			 COL_BG);
}

static void draw_sid_sub_line(void)
{
	const char *s = sid_sub_text();

	sid_scroll_sync(SID_SCRL_SUB, s);
	draw_marquee(TC_SID_FILE, 8, SID_LINE2_Y, s, SID_SUB_CHARS,
		     sid_scroll_off(SID_SCRL_SUB, (int)strlen(s),
				    SID_SUB_CHARS, 0),
		     COL_CYAN);
}

/* Elapsed / length, right-aligned on the subsong line (words removed). */
static void draw_sid_song_line(void)
{
	char line[24];
	uint32_t el = sid_player_elapsed_s();
	uint32_t len = sid_length_cur();
	int w;

	if (sid_player_songs() <= 0) {
		line[0] = '\0';
	} else if (len > 0U) {
		snprintf(line, sizeof(line), "%u:%02u/%u:%02u", el / 60U,
			 el % 60U, len / 60U, len % 60U);
	} else {
		snprintf(line, sizeof(line), "%u:%02u", el / 60U, el % 60U);
	}
	w = (int)strlen(line) * TEXT_CW;
	draw_text_cached(TC_SID_SONG, 440 - w, SID_LINE2_Y, line, COL_WHITE,
			 COL_BG);
}

/* STIL comment on the 4th line (scrolling when long; erases itself when
 * the tune has no comment). */
static void draw_sid_comment_line(void)
{
	const char *c = sid_comment_text();

	sid_scroll_sync(SID_SCRL_CMT, c);
	draw_marquee(TC_SID_CMT, 8, SID_LINE4_Y, c, SID_CMT_CHARS,
		     sid_scroll_off(SID_SCRL_CMT, (int)strlen(c), SID_CMT_CHARS,
				    SID_CMT_CHARS / 3),
		     COL_CYAN);
	sid_cmt_painted = true;
}

/* One marquee tick (called once a second while the SID screen is up): the
 * offsets come from the clock, so the draw functions do the work. */
static void sid_marquee_tick(void)
{
	if ((int)strlen(sid_player_title()) > SID_TITLE_CHARS) {
		draw_sid_title_line();
	}
	if ((int)strlen(sid_sub_text()) > SID_SUB_CHARS) {
		draw_sid_sub_line();
	}
	if ((int)strlen(sid_comment_text()) > SID_CMT_CHARS) {
		draw_sid_comment_line();
	}
}

static void draw_sid_info(void)
{
	char a[20];
	bool cmt = sid_stil_has_cmt;
	bool cmt_ok = cmt && sid_cmt_painted &&
		      !sid_scroll_text_changed(SID_SCRL_CMT, sid_comment_text());

	/* clear the text area; the sliders (drawn right after on screen
	 * redraws) then cover the tail of the previous comment line. When
	 * the comment text is unchanged its row is left alone - stepping
	 * between subsongs that share it must not flash or restart it. */
	fill_rect(0, SID_LINE1_Y, SCR_W,
		  cmt_ok ? (SID_LINE4_Y - SID_LINE1_Y) : (cmt ? 96 : 92),
		  COL_BG);
	text_cache_reset();

	draw_sid_title_line();
	draw_sid_counter_line();
	draw_sid_sub_line();
	draw_sid_song_line();

	sid_text(a, sizeof(a), sid_player_author());
	draw_text_cached(TC_SID_AUTHOR, 8, SID_LINE3_Y, a, COL_CYAN, COL_BG);

	{
		char label[16];
		int mode = sid_player_model_mode();

		if (mode == 0) {
			if (sid_player_songs() > 0) {
				snprintf(label, sizeof(label), "AUTO(%d)",
					 sid_player_chip());
			} else {
				strcpy(label, "AUTO");
			}
		} else {
			snprintf(label, sizeof(label), "FORCE %d",
				 mode == 1 ? 6581 : 8580);
		}
		draw_button(SID_CHIP_X, SID_CHIP_Y, SID_CHIP_W, SID_CHIP_H,
			    label, mode != 0);
	}

	if (cmt && !cmt_ok) {
		draw_sid_comment_line();
	}
}

/* SID screen sliders: their position moves up when the STIL comment line
 * is absent, to fill the freed space evenly. */
static int sid_sld_vol_y = SLD_VOL_Y;
static int sid_sld_bri_y = SLD_BRI_Y;

static void sid_draw_volume(void)
{
	char t[16];

	snprintf(t, sizeof(t), "VOL %u%%", volume * 100U / 255U);
	draw_slider_bar(sid_sld_vol_y, volume, 255U, t);
}

static void sid_draw_bri(void)
{
	char t[16];

	snprintf(t, sizeof(t), "BRI %u%%", brightness * 100U / 255U);
	draw_slider_bar(sid_sld_bri_y, brightness, 255U, t);
}

static void draw_sid_buttons(void)
{
	static const char *const end_labels[3] = {
		"NEXT SUB", "NEXT TUNE", "LOOP"
	};
	bool playing = sid_player_is_playing();
	bool is_paused = sid_player_is_paused();

	draw_button(SID_TUNEL_X, SID_ROW1_Y, SID_TUNEL_W, SID_ROW1_H, "TUNE<",
		    false);
	draw_button(SID_PLAY_X, SID_ROW1_Y, SID_PLAY_W, SID_ROW1_H,
		    !playing ? "PLAY" : is_paused ? "RESUME" : "PAUSE",
		    playing && !is_paused);
	draw_button(SID_STOP_X, SID_ROW1_Y, SID_STOP_W, SID_ROW1_H, "STOP",
		    false);
	draw_button(SID_TUNER_X, SID_ROW1_Y, SID_TUNER_W, SID_ROW1_H, "TUNE>",
		    false);
	draw_button(SID_SUBL_X, SID_ROW2_Y, SID_SUB_W, SID_SUB_H, "SUB<", false);
	draw_button(SID_END_X, SID_ROW2_Y, SID_SUB_W, SID_SUB_H,
		    end_labels[sid_end_mode], false);
	draw_button(SID_SUBR_X, SID_ROW2_Y, SID_SUB_W, SID_SUB_H, "SUB>", false);
}

static void draw_sid_screen(void)
{
	static int sid_layout_drawn = -1;
	bool cmt = sid_stil_has_cmt;
	int layout = cmt ? 1 : 0;

	/* erase the previous slider position when the layout changes (the
	 * sliders cover the band 268..358 completely in either variant) */
	if (layout != sid_layout_drawn) {
		if (sid_layout_drawn >= 0) {
			fill_rect(0, 268, SCR_W, 90, COL_BG);
			text_cache_reset();
			sid_cmt_painted = false; /* clips the comment row too */
		}
		sid_layout_drawn = layout;
	}

	/* the sliders move up when the STIL comment line is absent; both
	 * variants leave clear space above the timeout bar */
	sid_sld_vol_y = cmt ? 290 : 274;
	sid_sld_bri_y = cmt ? 326 : 314;

	draw_header();
	draw_button(HOME_X, HOME_Y, HOME_W, HOME_H, "HOME", false);
	draw_sid_buttons();
	draw_sid_info();
	sid_draw_volume();
	sid_draw_bri();
}

static void draw_sensors_screen(void)
{
	draw_header();
	draw_button(HOME_X, HOME_Y, HOME_W, HOME_H, "HOME", false);
	draw_text(8, 84, "ACCELEROMETER", COL_CYAN, COL_BG);
	show_accel(); /* live value line + bars */
}

static void draw_settings_screen(void)
{
	draw_header();
	draw_button(HOME_X, HOME_Y, HOME_W, HOME_H, "HOME", false);

	{
		static const char *const prof[3] = {
			"NIGHT", "INDOOR", "OUTDOOR"
		};

		draw_button(SET_NIGHT_X, SET_ROW1_Y, SET_BTN_W, SET_BTN_H,
			    prof[0], bri_sel == 0);
		draw_button(SET_INDOOR_X, SET_ROW1_Y, SET_BTN_W, SET_BTN_H,
			    prof[1], bri_sel == 1);
		draw_button(SET_OUTDOOR_X, SET_ROW1_Y, SET_BTN_W, SET_BTN_H,
			    prof[2], bri_sel == 2);
	}

	draw_slider_lux();
	draw_slider_set_bri();
	draw_slider_idle();
	draw_button(SET_SAVE_X, SET_SAVE_Y, SET_SAVE_W, SET_SAVE_H,
		    "SAVE STATE", false);
}

/* --- alarms screen -------------------------------------------------- */

static bool alarm_any_armed(void)
{
	for (int i = 0; i < 5; i++) {
		if (alarms[i].mode != 0) {
			return true;
		}
	}
	return false;
}

static void draw_alarms_screen(void)
{
	static const char *const dn[7] = {
		"Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"
	};
	struct alarm_cfg *a = &alarms[alm_sel];
	char t[36];

	draw_header();
	draw_button(HOME_X, HOME_Y, HOME_W, HOME_H, "HOME", false);

	/* mode + ringtone */
	draw_button(ALM_MODE_X, ALM_MODE_Y, ALM_MODE_W, ALM_MODE_H,
		    a->mode == 1 ? "ONCE" : a->mode == 2 ? "REPEAT" : "OFF",
		    a->mode != 0);
	if (a->title[0] != '\0') {
		snprintf(t, sizeof(t), "%.16s  %u", a->title, a->sub + 1);
	} else if (a->sid[0] != '\0') {
		snprintf(t, sizeof(t), "%.16s  %u", a->sid, a->sub + 1);
	} else {
		strcpy(t, "SET SID");
	}
	draw_button(ALM_RING_X, ALM_MODE_Y, ALM_RING_W, ALM_MODE_H, t,
		    a->sid[0] != '\0');

	/* repeat days, only meaningful in repeat mode */
	if (a->mode == 2) {
		for (int i = 0; i < 7; i++) {
			draw_button(ALM_DAY_X0 + i * ALM_DAY_DX, ALM_DAY_Y,
				    ALM_DAY_W, ALM_DAY_H, dn[i],
				    (a->days >> i) & 1U);
		}
	}

	/* time + playback length (hour/minute have -/+ step buttons) */
	snprintf(t, sizeof(t), "HOUR %02u", a->hour);
	draw_button(ALM_ARR_X0, ALM_SLD_HOUR_Y, ALM_ARR_W, SLD_H, "-", false);
	draw_slider_bar_at(ALM_SLD_X, ALM_SLD_HOUR_Y, ALM_SLD_W, a->hour, 23U,
			   t);
	draw_button(ALM_ARR_X1, ALM_SLD_HOUR_Y, ALM_ARR_W, SLD_H, "+", false);

	snprintf(t, sizeof(t), "MIN %02u", a->min);
	draw_button(ALM_ARR_X0, ALM_SLD_MIN_Y, ALM_ARR_W, SLD_H, "-", false);
	draw_slider_bar_at(ALM_SLD_X, ALM_SLD_MIN_Y, ALM_SLD_W, a->min, 59U,
			   t);
	draw_button(ALM_ARR_X1, ALM_SLD_MIN_Y, ALM_ARR_W, SLD_H, "+", false);

	snprintf(t, sizeof(t), "LEN %u:%02u", a->len_sec / 60U,
		 a->len_sec % 60U);
	draw_button(ALM_ARR_X0, ALM_SLD_LEN_Y, ALM_ARR_W, SLD_H, "-", false);
	draw_slider_bar_at(ALM_SLD_X, ALM_SLD_LEN_Y, ALM_SLD_W,
			   (uint32_t)(a->len_sec / 15U - 1U), 19U, t);
	draw_button(ALM_ARR_X1, ALM_SLD_LEN_Y, ALM_ARR_W, SLD_H, "+", false);

	/* the five alarm tiles: number when off, time when armed */
	for (int i = 0; i < 5; i++) {
		struct alarm_cfg *b = &alarms[i];

		if (b->mode != 0) {
			snprintf(t, sizeof(t), "%02u:%02u", b->hour, b->min);
		} else {
			snprintf(t, sizeof(t), "%d", i + 1);
		}
		draw_button(ALM_TILE_X0 + i * ALM_TILE_DX, ALM_TILE_Y,
			    ALM_TILE_W, ALM_TILE_H, t, i == alm_sel);
	}
}

/* Capture the currently playing/paused tune (file + subsong) as the
 * ringtone of the selected alarm. */
static void alarm_capture_ringtone(void)
{
	struct alarm_cfg *a = &alarms[alm_sel];

	if (!sid_player_is_playing() || sid_cur_name[0] == '\0') {
		return; /* only a loaded, playing or paused tune can be set */
	}
	snprintf(a->sid, sizeof(a->sid), "%s", sid_cur_name);
	snprintf(a->title, sizeof(a->title), "%.16s", sid_player_title());
	a->sub = (uint8_t)sid_player_subtune();
	alm_cfg_dirty = true;
	draw_alarms_screen();
	LOG_INF("alarm %d ringtone: %s sub %u", alm_sel + 1, a->sid,
		a->sub + 1);
}

/*
 * Idle-time alarm service: fire matching alarms (idle face up, nothing
 * playing), stop the ringtone when its length expires or the screen is
 * touched (the touch handler calls alarm_stop()).
 */
static void alarm_stop(void)
{
	if (alarm_ringing) {
		sid_player_stop();
		audio_sid_stop();
		alarm_ringing = false;
		LOG_INF("alarm stopped");
	}
}

static void alarm_service(void)
{
	uint32_t epoch = epoch_now();
	uint32_t minute = epoch / 60U;
	uint32_t mins = minute % (24U * 60U);
	uint8_t hh = (uint8_t)(mins / 60U);
	uint8_t mm = (uint8_t)(mins % 60U);
	/* 0 = Monday; Unix day 0 (1970-01-01) was a Thursday = index 3 */
	uint32_t wd_mon = (epoch / 86400U + 3U) % 7U;

	if (alarm_ringing) {
		if ((int32_t)(k_uptime_get_32() - alarm_until) >= 0) {
			alarm_stop();
			LOG_INF("alarm playback finished");
		}
		return;
	}
	if (sid_player_is_playing() && !sid_player_is_paused()) {
		return; /* actively playing music: never interrupt */
	}
	/* a paused tune is silent and does NOT block the alarm (it gets
	 * replaced by the ringtone) */

	for (int i = 0; i < 5; i++) {
		struct alarm_cfg *a = &alarms[i];

		if (a->mode == 0 || a->hour != hh || a->min != mm ||
		    minute == alarm_fired_min) {
			continue;
		}
		if (a->mode == 2 && !((a->days >> wd_mon) & 1U)) {
			continue;
		}
		if (a->sid[0] == '\0') {
			continue; /* no ringtone set: stay armed, do nothing */
		}
		{
			char path[40];

			snprintf(path, sizeof(path), "/home/%s", a->sid);
			if (sid_player_load(path) != 0) {
				continue; /* ringtone file missing: stay armed */
			}
			alarm_fired_min = minute;
			if (a->mode == 1) {
				a->mode = 0; /* one-shot */
				alm_cfg_dirty = true;
			}
			if (a->sub < (uint8_t)sid_player_songs()) {
				sid_player_play(a->sub);
			} else {
				sid_player_play_default();
			}
			audio_sid_start();
			alarm_ringing = true;
			alarm_until = k_uptime_get_32() +
				      (uint32_t)a->len_sec * 1000U;
			LOG_INF("alarm %d: %s sub %u, %u s", i + 1, a->sid,
				a->sub + 1, a->len_sec);
			return;
		}
	}
}

/* Alarm persistence: one line per alarm,
 * "mode hour min len days sub name title". */
static void alm_cfg_save(void)
{
	static char buf[400];
	struct fs_file_t f;
	int n = 0;

	if (!fs_ready) {
		return;
	}
	for (int i = 0; i < 5; i++) {
		struct alarm_cfg *a = &alarms[i];

		n += snprintf(buf + n, sizeof(buf) - (size_t)n,
			      "%u %u %u %u %u %u %s %s\n", a->mode, a->hour,
			      a->min, a->len_sec, a->days, a->sub,
			      a->sid[0] ? a->sid : "-",
			      a->title[0] ? a->title : "-");
		if (n >= (int)sizeof(buf) - 1) {
			break;
		}
	}
	fs_file_t_init(&f);
	if (fs_open(&f, "/home/alarms.cfg",
		    FS_O_WRITE | FS_O_CREATE | FS_O_TRUNC) == 0) {
		(void)fs_write(&f, buf, (size_t)n);
		fs_close(&f);
	}
}

static void alm_cfg_load(void)
{
	static char buf[400];
	struct fs_file_t f;
	ssize_t rd;
	char *p;

	if (!fs_ready) {
		return;
	}
	fs_file_t_init(&f);
	if (fs_open(&f, "/home/alarms.cfg", FS_O_READ) < 0) {
		return;
	}
	rd = fs_read(&f, buf, sizeof(buf) - 1U);
	fs_close(&f);
	if (rd <= 0) {
		return;
	}
	buf[rd] = '\0';

	p = buf;
	for (int i = 0; i < 5; i++) {
		struct alarm_cfg *a = &alarms[i];
		unsigned v[6];
		char name[24] = "", title[20] = "";

		/* six numbers */
		for (int k = 0; k < 6; k++) {
			v[k] = 0;
			while (*p == ' ' || *p == '\t') {
				p++;
			}
			if (*p < '0' || *p > '9') {
				return; /* incomplete: keep the defaults */
			}
			while (*p >= '0' && *p <= '9') {
				v[k] = v[k] * 10U + (unsigned)(*p++ - '0');
				if (v[k] > 10000U) {
					v[k] = 10000U;
				}
			}
		}
		/* ringtone file name (single token, "-" = none) */
		while (*p == ' ') {
			p++;
		}
		for (int k = 0; k < 23 && *p > ' ' && *p != '\0'; k++) {
			name[k] = *p++;
			name[k + 1] = '\0';
		}
		/* display title = rest of the line */
		while (*p == ' ') {
			p++;
		}
		for (int k = 0; k < 19 && *p != '\n' && *p != '\0'; k++) {
			title[k] = *p++;
			title[k + 1] = '\0';
		}
		while (*p != '\n' && *p != '\0') {
			p++;
		}
		if (*p == '\n') {
			p++;
		}

		a->mode = (uint8_t)(v[0] % 3U);
		a->hour = (uint8_t)(v[1] % 24U);
		a->min = (uint8_t)(v[2] % 60U);
		/* pre-0.10 files stored whole minutes (1..5); now seconds in
		 * 15 s steps (15..300) */
		if (v[3] < IDLE_TIMEOUT_MIN_S) {
			v[3] *= 60U;
		}
		v[3] = CLAMP(v[3], (unsigned)IDLE_TIMEOUT_MIN_S,
			     (unsigned)IDLE_TIMEOUT_MAX_S);
		a->len_sec = (uint16_t)(v[3] / 15U * 15U);
		a->days = (uint8_t)(v[4] & 0x7FU);
		a->sub = (uint8_t)(v[5] & 0x1FU);
		if (strcmp(name, "-") != 0) {
			snprintf(a->sid, sizeof(a->sid), "%s", name);
		}
		if (strcmp(title, "-") != 0) {
			snprintf(a->title, sizeof(a->title), "%s", title);
		}
		LOG_INF("alarm %d: mode %u %02u:%02u len %us days 0x%02X [%s]",
			i + 1, a->mode, a->hour, a->min, a->len_sec, a->days,
			a->sid);
	}
}

static void draw_ui(void)
{
	fill_rect(0, 0, SCR_W, SCR_H, COL_BG);
	text_cache_reset();
	sid_cmt_painted = false; /* nothing survives a full repaint */

	switch (ui_scr) {
	case SCR_SID:
		draw_sid_screen();
		break;
	case SCR_SENSORS:
		draw_sensors_screen();
		break;
	case SCR_SETTINGS:
		draw_settings_screen();
		break;
	case SCR_ALARMS:
		draw_alarms_screen();
		break;
	default:
		draw_main_screen();
		break;
	}

	countdown_second = 0xFFFFFFFFU; /* force a countdown redraw */
	draw_countdown(0);
}

/* --- SID transport actions ----------------------------------------- */

/* --- /home listing cache ------------------------------------------- */

/*
 * A LittleFS directory scan is expensive: the Zephyr port re-reads the
 * metadata pair from the start for every entry it returns, and the tiny
 * 64-byte cache turned that into a burst of small SPI transactions per
 * file (~0.5 s for the ~90 files in /home). The 0x13 listing serves
 * 60-byte pages, so a per-page scan kept the audio refill thread off the
 * CPU for most of a transfer and playback stuttered for seconds.
 *
 * The listing is therefore built once into RAM (at boot, and again after
 * a format) and pages are served from it. fs_mgmt uploads append their
 * file name through the MCUmgr file-access hook and 0x16 deletes drop
 * it, so neither needs a scan; a library refresh right after an upload
 * or delete stays scan-free too.
 *
 * Entries are stored as "name\n"; if a directory ever outgrows the
 * buffer the flag makes that listing fall back to the live scan.
 */
#define HOME_LIST_CACHE_SIZE 2048
static K_MUTEX_DEFINE(home_list_lock);
static char home_list_cache[HOME_LIST_CACHE_SIZE];
static uint16_t home_list_cache_used; /* publish after the bytes are in */
static bool home_list_cache_valid;
static bool home_list_cache_overflow;

static void home_list_cache_stale(void)
{
	k_mutex_lock(&home_list_lock, K_FOREVER);
	home_list_cache_valid = false;
	home_list_cache_overflow = false;
	k_mutex_unlock(&home_list_lock);
}

/* Caller holds home_list_lock. Returns the start of the cache line for
 * name, or NULL. */
static char *home_list_cache_line_locked(const char *name, size_t l)
{
	char *p = home_list_cache;
	char *end = home_list_cache + home_list_cache_used;

	while (p < end) {
		char *nl = memchr(p, '\n', (size_t)(end - p));

		if (nl == NULL) {
			break;
		}
		if ((size_t)(nl - p) == l && memcmp(p, name, l) == 0) {
			return p;
		}
		p = nl + 1;
	}
	return NULL;
}

/* Append one name. Runs on the SMP workqueue while a GATT read may be
 * serving a page on the BT workqueue, hence the lock. Copy first, then
 * publish the length, so a partially copied name is never visible. */
static void home_list_cache_add(const char *name)
{
	size_t l = strlen(name);

	if (l == 0U || l > 23U) {
		return;
	}
	k_mutex_lock(&home_list_lock, K_FOREVER);
	if (home_list_cache_valid && !home_list_cache_overflow &&
	    home_list_cache_line_locked(name, l) == NULL) {
		if ((size_t)home_list_cache_used + l + 1U >
		    sizeof(home_list_cache)) {
			home_list_cache_overflow = true;
		} else {
			memcpy(home_list_cache + home_list_cache_used, name, l);
			home_list_cache[home_list_cache_used + l] = '\n';
			home_list_cache_used =
				(uint16_t)(home_list_cache_used + l + 1U);
		}
	}
	k_mutex_unlock(&home_list_lock);
}

/* Drop one name (0x16 delete); keeps the cache usable without a rescan. */
static void home_list_cache_remove(const char *name)
{
	size_t l = strlen(name);

	if (l == 0U) {
		return;
	}
	k_mutex_lock(&home_list_lock, K_FOREVER);
	if (home_list_cache_valid && !home_list_cache_overflow) {
		char *line = home_list_cache_line_locked(name, l);

		if (line != NULL) {
			char *end = home_list_cache + home_list_cache_used;
			char *nl = memchr(line, '\n', (size_t)(end - line));

			if (nl != NULL) {
				memmove(line, nl + 1,
					(size_t)(end - (nl + 1)));
				home_list_cache_used = (uint16_t)
					(home_list_cache_used - (l + 1U));
			}
		}
	}
	k_mutex_unlock(&home_list_lock);
}

/* Caller holds home_list_lock. */
static void home_list_cache_build_locked(void)
{
	struct fs_dir_t dirp;
	static struct fs_dirent ent;
	uint16_t used = 0;

	home_list_cache_valid = false;
	home_list_cache_overflow = false;
	home_list_cache_used = 0;
	if (!fs_ready) {
		return;
	}
	fs_dir_t_init(&dirp);
	if (fs_opendir(&dirp, "/home") != 0) {
		return;
	}
	while (fs_readdir(&dirp, &ent) == 0 && ent.name[0] != '\0') {
		size_t l;

		if (ent.type != FS_DIR_ENTRY_FILE) {
			continue;
		}
		l = strlen(ent.name);
		if (used + (int)l + 1 > (int)sizeof(home_list_cache)) {
			home_list_cache_overflow = true;
			break;
		}
		memcpy(home_list_cache + used, ent.name, l);
		home_list_cache[used + l] = '\n';
		used = (uint16_t)(used + l + 1U);
	}
	fs_closedir(&dirp);
	if (!home_list_cache_overflow) {
		home_list_cache_used = used;
		home_list_cache_valid = true;
	}
}

static void home_list_cache_build(void)
{
	k_mutex_lock(&home_list_lock, K_FOREVER);
	home_list_cache_build_locked();
	k_mutex_unlock(&home_list_lock);
}

/* One page of the /home listing as "name\n" entries (never splitting a
 * name; the caller keeps one spare byte for the next index). Returns the
 * next entry index to continue from, or -1 when done. */
static int home_list_live(uint16_t start, uint8_t *dst, int size)
{
	struct fs_dir_t dirp;
	static struct fs_dirent ent;
	int idx = 0;
	int used = 0;

	fs_dir_t_init(&dirp);
	if (fs_opendir(&dirp, "/home") != 0) {
		dst[0] = '\0';
		return -1;
	}
	while (fs_readdir(&dirp, &ent) == 0 && ent.name[0] != '\0') {
		size_t l;

		if (ent.type != FS_DIR_ENTRY_FILE) {
			continue;
		}
		if (idx++ < (int)start) {
			continue;
		}
		l = strlen(ent.name);
		if (used + (int)l + 1 > size - 1) {
			/* doesn't fit: this entry goes to the next page */
			fs_closedir(&dirp);
			dst[used] = '\0';
			return idx - 1;
		}
		memcpy(dst + used, ent.name, l);
		dst[used + l] = '\n';
		used += (int)l + 1;
	}
	fs_closedir(&dirp);
	dst[used] = '\0';
	return -1;
}

static int home_list(uint16_t start, uint8_t *dst, int size)
{
	const char *p, *end;
	int used = 0;
	int idx = 0;

	k_mutex_lock(&home_list_lock, K_FOREVER);
	if (!home_list_cache_valid) {
		if (!home_list_cache_overflow) {
			home_list_cache_build_locked();
		}
		if (!home_list_cache_valid) {
			int next = home_list_live(start, dst, size);

			k_mutex_unlock(&home_list_lock);
			return next;
		}
	}
	p = home_list_cache;
	end = home_list_cache + home_list_cache_used;
	while (p < end) {
		const char *nl = memchr(p, '\n', (size_t)(end - p));
		size_t l;

		if (nl == NULL) {
			break;
		}
		l = (size_t)(nl - p);
		if (idx++ < (int)start) {
			p = nl + 1;
			continue;
		}
		if (used + (int)l + 1 > size - 1) {
			dst[used] = '\0';
			k_mutex_unlock(&home_list_lock);
			return idx - 1;
		}
		memcpy(dst + used, p, l);
		dst[used + l] = '\n';
		used += (int)l + 1;
		p = nl + 1;
	}
	k_mutex_unlock(&home_list_lock);
	dst[used] = '\0';
	return -1;
}

#if defined(CONFIG_MCUMGR_GRP_FS_FILE_ACCESS_HOOK)
/* fs_mgmt uploads (web page, smpmgr, sid_add.py) append their file name
 * to the listing cache: no directory scan on the next listing, so audio
 * keeps playing while the library refreshes after an upload. */
static enum mgmt_cb_return home_fs_access_cb(uint32_t event,
					     enum mgmt_cb_return prev_status,
					     int32_t *rc, uint16_t *group,
					     bool *abort_more, void *data,
					     size_t data_size)
{
	const struct fs_mgmt_file_access *fa = data;

	ARG_UNUSED(prev_status);
	ARG_UNUSED(rc);
	ARG_UNUSED(group);
	ARG_UNUSED(abort_more);

	if (event == MGMT_EVT_OP_FS_MGMT_FILE_ACCESS &&
	    data_size >= sizeof(*fa) &&
	    fa->access == FS_MGMT_FILE_ACCESS_WRITE &&
	    fa->filename != NULL) {
		const char *name = fa->filename;

		if (strncmp(name, "/home/", 6) == 0) {
			name += 6;
		}
		if (name[0] != '\0' && strchr(name, '/') == NULL) {
			home_list_cache_add(name);
		}
	}
	return MGMT_CB_OK;
}

static struct mgmt_callback home_fs_access_mgmt_cb = {
	.callback = home_fs_access_cb,
	.event_id = MGMT_EVT_OP_FS_MGMT_FILE_ACCESS,
};
#endif /* CONFIG_MCUMGR_GRP_FS_FILE_ACCESS_HOOK */

/* Alphabetically next (dir > 0) or previous .sid in /home, wrapping around.
 * Only the current name is kept as state; the directory is rescanned on
 * every step, so newly uploaded tunes show up immediately. */
static bool sid_find_next(int dir, char *out, size_t len)
{
	struct fs_dir_t dirp;
	static struct fs_dirent ent;
	char after[24] = { 0 }, first[24] = { 0 }, last[24] = { 0 };
	bool have = false;

	fs_dir_t_init(&dirp);
	if (fs_opendir(&dirp, "/home") != 0) {
		return false;
	}
	while (fs_readdir(&dirp, &ent) == 0 && ent.name[0] != '\0') {
		size_t l = strlen(ent.name);

		if (ent.type != FS_DIR_ENTRY_FILE || l < 5U || l > 23U) {
			continue;
		}
		if (!(ent.name[l - 4U] == '.' &&
		      (ent.name[l - 3U] == 's' || ent.name[l - 3U] == 'S') &&
		      (ent.name[l - 2U] == 'i' || ent.name[l - 2U] == 'I') &&
		      (ent.name[l - 1U] == 'd' || ent.name[l - 1U] == 'D'))) {
			continue;
		}
		if (first[0] == '\0' || strcmp(ent.name, first) < 0) {
			strncpy(first, ent.name, sizeof(first) - 1U);
		}
		if (last[0] == '\0' || strcmp(ent.name, last) > 0) {
			strncpy(last, ent.name, sizeof(last) - 1U);
		}
		if (sid_cur_name[0] != '\0') {
			int c = strcmp(ent.name, sid_cur_name);

			if (dir > 0 ? (c <= 0) : (c >= 0)) {
				continue;
			}
		}
		if (!have || (dir > 0 ? (strcmp(ent.name, after) < 0)
				      : (strcmp(ent.name, after) > 0))) {
			strncpy(after, ent.name, sizeof(after) - 1U);
			have = true;
		}
	}
	fs_closedir(&dirp);

	if (!have) {
		strncpy(after, dir > 0 ? first : last, sizeof(after) - 1U);
	}
	if (after[0] == '\0') {
		return false;
	}
	snprintf(out, len, "%s", after);
	return true;
}

/* Load the next (dir = +1) or previous (dir = -1) tune in file-name order.
 *
 * first_sub starts the fresh tune at its first subsong instead of the PSID
 * startSong: the automatic end-of-tune advance in "next sub" mode has to
 * play every subsong in order, so starting at the metadata default would
 * skip the ones before it. A manual tune change (and "next tune" mode)
 * keeps the author's intended subtune. */
static void sid_step(int dir, bool first_sub)
{
	char path[40], name[24];

	if (!fs_ready) {
		return;
	}
	if (!sid_find_next(dir, name, sizeof(name))) {
		LOG_WRN("no .sid files in /home");
		return;
	}
	/* advance the cursor even if this particular file fails to load */
	snprintf(sid_cur_name, sizeof(sid_cur_name), "%s", name);
	snprintf(path, sizeof(path), "/home/%s", name);
	if (sid_player_load(path) == 0) {
		sid_load_lengths(name);
		sid_stil_load(name);
		sid_remember_save();
		if (first_sub) {
			sid_player_play(0);
		} else {
			sid_player_play_default();
		}
		audio_sid_start();
	} else {
		LOG_WRN("sid load failed: %s", path);
	}
}

static void sid_toggle_play(void)
{
	if (!sid_player_is_playing()) {
		if (sid_player_songs() <= 0) {
			sid_step(1, false); /* nothing loaded yet: first tune */
			return;
		}
		sid_player_play(sid_player_subtune()); /* start/restart */
		audio_sid_start();
	} else if (sid_player_is_paused()) {
		sid_player_resume();
		audio_sid_start(); /* the stream may have suspended */
	} else {
		sid_player_pause(); /* silence; the amp suspends after 30 s */
	}
}

static void sid_sub_step(int dir)
{
	int total = sid_player_songs();
	int sub;

	if (total <= 0) {
		sid_step(1, false);
		return;
	}
	sub = (sid_player_subtune() + dir) % total;
	if (sub < 0) {
		sub += total;
	}
	sid_player_play(sub);
	audio_sid_start();
}

/* Play subtune `sub`, 1-based like the UI and the BLE commands count;
 * 0xFF = the PSID startSong. Out-of-range values clamp to the last
 * subtune so a stale host cannot fall off the tune. */
static void sid_play_sub(uint8_t sub)
{
	int songs = sid_player_songs();

	if (sub == 0xFFU || songs <= 0) {
		sid_player_play_default();
		return;
	}
	if (sub == 0U) {
		sub = 1U;
	}
	if ((int)sub > songs) {
		sub = (uint8_t)songs;
	}
	sid_player_play((int)sub - 1);
}

/* Run one player command parked by the BLE write handler (sid_req_post):
 * the main thread owns the emulator, the sidecars and the filesystem, so
 * these run exactly like the equivalent button presses. */
static void sid_req_take(void)
{
	uint8_t op = sid_req_op;
	uint8_t arg = sid_req_arg;
	char name[24];
	char path[40];

	if (op == 0U) {
		return;
	}
	memcpy(name, sid_req_name, sizeof(name));
	sid_req_op = 0U; /* released; the arguments are local now */

	switch (op) {
	case 0x0E:
		snprintf(sid_cur_name, sizeof(sid_cur_name), "%u.sid",
			 arg % 10U);
		snprintf(path, sizeof(path), "/home/%s", sid_cur_name);
		if (sid_player_load(path) != 0) {
			LOG_WRN("sid load failed: %s", path);
			break;
		}
		sid_load_lengths(sid_cur_name);
		sid_stil_load(sid_cur_name);
		sid_remember_save();
		sid_player_play_default();
		audio_sid_start();
		break;
	case 0x11:
	case 0x20:
		snprintf(path, sizeof(path), "/home/%s", name);
		if (sid_player_load(path) != 0) {
			LOG_WRN("sid load failed: %s", path);
			break;
		}
		snprintf(sid_cur_name, sizeof(sid_cur_name), "%s", name);
		sid_load_lengths(sid_cur_name);
		sid_stil_load(sid_cur_name);
		sid_remember_save();
		if (op == 0x20) {
			sid_play_sub(arg);
		} else {
			sid_player_play_default();
		}
		audio_sid_start();
		break;
	case 0x12:
		sid_player_set_model(arg % 3U);
		break;
#ifdef SID_ENGINE_DUAL
	case 0x17:
		if (arg != (uint8_t)sid_player_engine_legacy()) {
			bool was = sid_player_is_playing();

			sid_player_stop();
			audio_sid_stop();
			sid_player_set_engine_mode((int)arg);
			if (was && sid_cur_name[0] != '\0') {
				snprintf(path, sizeof(path), "/home/%s",
					 sid_cur_name);
				if (sid_player_load(path) == 0) {
					sid_player_play_default();
					audio_sid_start();
				}
			}
		}
		LOG_INF("sid engine: %s", arg ? "legacy" : "new");
		break;
#endif
	case 0x18:
		sid_toggle_play();
		break;
	case 0x19:
		sid_step(1, false);
		break;
	case 0x1A:
		sid_step(-1, false);
		break;
	case 0x1B:
		sid_sub_step(1);
		break;
	case 0x1C:
		sid_sub_step(-1);
		break;
	case 0x21:
		sid_play_sub(arg);
		audio_sid_start();
		break;
	default:
		break;
	}
}

/* Advance when the current (sub)song passed its known length (from the
 * optional /home/N.len sidecar). */
static void sid_check_end(void)
{
	uint32_t len = sid_length_cur();

	if (alarm_ringing) {
		return; /* never advance while an alarm ringtone plays */
	}
	if (len == 0U || !sid_player_is_playing() || sid_player_is_paused() ||
	    sid_player_elapsed_s() < len) {
		return;
	}

	if (sid_end_mode == 2) {
		sid_player_play(sid_player_subtune()); /* loop the subtune */
	} else if (sid_end_mode == 1) {
		sid_step(1, false); /* next tune: the PSID startSong */
	} else if (sid_player_subtune() + 1 < sid_player_songs()) {
		sid_sub_step(1); /* next subtune */
	} else {
		/* last subtune of this tune: the next one starts from its
		 * first subsong so that none before the startSong are
		 * skipped in this mode */
		sid_step(1, true);
	}
}

/* The BLE debug commands can start/stop tunes behind the UI's back; poll
 * the state and repaint the affected screen when something changed. */
static void sid_ui_sync(void)
{
	static char last[160];
	static uint32_t last_elapsed = 0xFFFFFFFFU;
	char now[160];
	uint32_t el = sid_player_elapsed_s();

	snprintf(now, sizeof(now), "%d|%d|%d|%d|%d|%s|%s|%s",
		 sid_player_is_playing(), sid_player_is_paused(),
		 sid_player_subtune(), sid_player_songs(), sid_end_mode,
		 sid_player_title(), sid_player_author(), sid_cur_name);
	if (strcmp(now, last) != 0) {
		strncpy(last, now, sizeof(last) - 1);
		last[sizeof(last) - 1] = '\0';
		last_elapsed = el;
		if (ui_scr == SCR_MAIN) {
			draw_tile(TILE_SID_X, TILE_Y, "SID", "PLAYER", false);
			draw_tile(TILE_ALM_X, TILE_Y, "ALARMS",
				  alarm_any_armed() ? "(ON)" : "(OFF)", false);
		} else if (ui_scr == SCR_SID) {
			/* full re-layout: the comment line decides where
			 * the sliders sit */
			draw_sid_screen();
		}
	} else if (ui_scr == SCR_SID && el != last_elapsed) {
		last_elapsed = el;
		draw_sid_song_line(); /* only the time line: no title blinking */
	}

	/* long titles scroll one letter per second; the text cache skips
	 * windows that did not change, so this is cheap */
	if (ui_scr == SCR_SID) {
		sid_marquee_tick();
	}
}

/* Idle face: the clock alone in night profile, clock + battery otherwise;
 * both moved for burn-in. */
static void draw_idle_face(void)
{
	fill_rect(0, 0, idle_fw(), idle_fh(), COL_BG); /* hide everything */
	text_cache_reset();
	idle_night_last = idle_night();
	if (!idle_night_last) {
		batt_move_random();
		draw_battery();
	}
	draw_clock_random();
}

/*
 * Inverse of write_rect()'s transpose: the FT3168 reports in the native
 * 368x448 address space, the UI works in the logical 448x368 frame.
 */
static void map_touch(uint16_t tx, uint16_t ty, uint16_t *lx, uint16_t *ly)
{
	if (rot_270) {
		*lx = ty;
		*ly = (uint16_t)(NAT_W - 1 - tx);
	} else {
		*lx = (uint16_t)(NAT_H - 1 - ty);
		*ly = tx;
	}
}

/* ------------------------------------------------------------------ */
/* Live clock: only redraw the HH:MM text when the minute changes      */
/* ------------------------------------------------------------------ */

static uint32_t clock_last_min = 0xFFFFFFFFU;

static bool clock_tick(void)
{
	uint32_t mins = (epoch_now() / 60U) % (24U * 60U);

	if (mins == clock_last_min) {
		return false;
	}
	clock_last_min = mins;
	return true;
}

/* Apply a brightness value; "fade" ramps to it in a few steps so automatic
 * changes are not a hard flash. */
static void bri_apply(uint8_t value, bool fade)
{
	if (fade && value != brightness) {
		uint8_t from = brightness;

		for (int i = 1; i <= 8; i++) {
			(void)display_set_brightness(
				disp, (uint8_t)(from + (value - from) * i / 8));
			k_sleep(K_MSEC(15));
		}
	}
	brightness = value;
	(void)display_set_brightness(disp, value);
	if (!idle_mode) {
		if (ui_scr == SCR_MAIN) {
			draw_slider_brightness();
		} else if (ui_scr == SCR_SID) {
			sid_draw_bri();
		}
	}
}

/*
 * Manual brightness change: take over from the automatic mode (tap AUTO to
 * hand control back).
 */
static void set_brightness(uint8_t value)
{
	if (value != bri_manual) {
		bri_manual = value; /* remembered for when AUTO goes off */
		bri_cfg_dirty = true;
	}
	if (bri_auto) {
		bri_auto = false;
		if (ui_scr == SCR_MAIN) {
			draw_button(UB_X2, UB_Y1, UB_W, UB_H, "AUTO BRI",
				    false);
		}
		LOG_INF("auto brightness off (manual slider)");
	}
	bri_apply(value, false);
}

/* Volume slider: software gain for the synthesised tones. */
static void set_volume(uint8_t value)
{
	volume = value;
	audio_set_volume(value);
	if (ui_scr == SCR_MAIN) {
		draw_slider_volume();
	} else if (ui_scr == SCR_SID) {
		sid_draw_volume();
	}
	LOG_INF("volume %u", value);
}

/*
 * Pick the ambient profile from the measured light, using the editable
 * levels. Upward transitions need the full threshold; downward ones lag
 * (outdoor->indoor at bri_lux[2], indoor->night at 75% of bri_lux[0]) so
 * the display's own light leaking into the ALS cannot make the loop
 * oscillate.
 */
static void brightness_auto_apply(void)
{
	uint8_t step = auto_step;
	int32_t n = (int32_t)bri_lux[0];
	int32_t d = (int32_t)bri_lux[1];
	int32_t hyst = (int32_t)bri_lux[2];

	if (!als_ok) {
		return;
	}

	if (step == 0U) {
		if (als_mlux > n) {
			step = 1U;
		}
	} else if (step == 2U) {
		if (als_mlux < hyst) {
			step = 1U;
		}
	} else {
		if (als_mlux > d) {
			step = 2U;
		} else if (als_mlux < n * 3 / 4) {
			step = 0U;
		}
	}

	if (step != auto_step || brightness != bri_lvl[step]) {
		auto_step = step;
		LOG_INF("auto bri: %d mlx -> profile %u (bri %u)", (int)als_mlux,
			step, bri_lvl[step]);
		bri_apply(bri_lvl[step], true);
	}
}

/* Ambient profile persistence: "lux0 lux1 lux2 bri0 bri1 bri2". */
static void bri_cfg_save(void)
{
	char buf[64];
	struct fs_file_t f;
	int n;

	if (!fs_ready) {
		return;
	}
	n = snprintf(buf, sizeof(buf), "%u %u %u %u %u %u %u %u\n",
		     bri_lux[0], bri_lux[1], bri_lux[2],
		     bri_lvl[0], bri_lvl[1], bri_lvl[2], bri_manual,
		     idle_timeout_s);
	fs_file_t_init(&f);
	if (fs_open(&f, "/home/bright.cfg",
		    FS_O_WRITE | FS_O_CREATE | FS_O_TRUNC) == 0) {
		(void)fs_write(&f, buf, (size_t)n);
		fs_close(&f);
	}
}

static void bri_cfg_load(void)
{
	struct fs_file_t f;
	char buf[64];
	ssize_t rd;
	unsigned v[8];
	char *p;
	int got = 0;

	if (!fs_ready) {
		return;
	}
	fs_file_t_init(&f);
	if (fs_open(&f, "/home/bright.cfg", FS_O_READ) < 0) {
		return;
	}
	rd = fs_read(&f, buf, sizeof(buf) - 1U);
	fs_close(&f);
	if (rd <= 0) {
		return;
	}
	buf[rd] = '\0';

	p = buf;
	for (int i = 0; i < 8; i++) {
		while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') {
			p++;
		}
		if (*p < '0' || *p > '9') {
			break;
		}
		v[i] = 0;
		while (*p >= '0' && *p <= '9') {
			v[i] = v[i] * 10U + (unsigned)(*p++ - '0');
			if (v[i] > 10000U) {
				v[i] = 10000U;
			}
		}
		got++;
	}
	if (got < 6) {
		return; /* incomplete: keep the defaults */
	}
	bri_lux[0] = (uint16_t)v[0];
	bri_lux[1] = (uint16_t)v[1];
	bri_lux[2] = (uint16_t)v[2];
	bri_lvl[0] = (uint8_t)v[3];
	bri_lvl[1] = (uint8_t)v[4];
	bri_lvl[2] = (uint8_t)v[5];
	if (got >= 7) {
		bri_manual = (uint8_t)v[6];
	}
	if (got >= 8) {
		unsigned s = CLAMP(v[7], (unsigned)IDLE_TIMEOUT_MIN_S,
				   (unsigned)IDLE_TIMEOUT_MAX_S);

		idle_timeout_s = (uint16_t)(s / 15U * 15U);
	}
	LOG_INF("brightness profiles: lux %u/%u/%u bri %u/%u/%u manual %u idle %us",
		bri_lux[0], bri_lux[1], bri_lux[2], bri_lvl[0], bri_lvl[1],
		bri_lvl[2], bri_manual, idle_timeout_s);
}

/* SAVE STATE: flush the clock, brightness profiles, alarms and the last
 * tune to /home in one go. */
static void save_all_state(void)
{
	if (!fs_ready) {
		/* Every writer below no-ops without a mounted filesystem, so
		 * this used to log a successful save and then lose the lot. */
		LOG_WRN("state NOT saved: /home not mounted (%d) - 'fsformat' recreates it",
			fs_mount_err);
		return;
	}
	time_cfg_save();
	bri_cfg_dirty = false;
	alm_cfg_dirty = false;
	bri_cfg_save();
	alm_cfg_save();
	sid_remember_save();
	LOG_INF("state saved (time brightness alarms sid)");
}

/* LiPo discharge curve (mV -> percent), clamped. */
static uint8_t mv_to_percent(uint16_t mv)
{
	static const uint16_t lim_mv[] = {
		3400, 3500, 3600, 3650, 3700, 3750,
		3800, 3900, 4000, 4100, 4200,
	};
	static const uint8_t lim_pct[] = {
		0, 5, 15, 25, 40, 50, 60, 70, 80, 90, 100,
	};

	if (mv <= lim_mv[0]) {
		return 0;
	}
	for (int i = 1; i < (int)ARRAY_SIZE(lim_mv); i++) {
		if (mv <= lim_mv[i]) {
			int span_mv = lim_mv[i] - lim_mv[i - 1];
			int span_pct = lim_pct[i] - lim_pct[i - 1];

			return (uint8_t)(lim_pct[i - 1] +
					 (mv - lim_mv[i - 1]) * span_pct / span_mv);
		}
	}
	return 100;
}

static void draw_battery(void)
{
	char l1[24], l2[8], l3[24];
	int w;

	if (idle_mode && idle_night()) {
		return; /* night face: clock only, no status block */
	}

	if (idle_mode) {
		/* idle face: the block moves along the upper edge, so clear
		 * the strip and redraw the (cached) lines fresh */
		fill_rect(0, BATT_Y0, SCR_W, 76, COL_BG);
		text_cache_reset();
	}

	snprintf(l1, sizeof(l1), "%u%% %u.%02uV", battery_pct,
		 battery_mv / 1000U, (battery_mv % 1000U) / 10U);
	w = (int)strlen(l1) * TEXT_CW;
	draw_text_cached(TC_BATT1, batt_right - w, BATT_Y0, l1, COL_WHITE,
			 COL_BG);

	if (charger_on) {
		strcpy(l2, battery_pct >= 99U ? "FULL" : "CHG");
	} else if (ext_power) {
		strcpy(l2, "AC");
	} else {
		l2[0] = '\0';
	}
	w = (int)strlen(l2) * TEXT_CW;
	draw_text_cached(TC_BATT2, batt_right - w, BATT_Y0 + 24, l2,
			 charger_on ? COL_GREEN : COL_CYAN, COL_BG);

	if (!als_ok) {
		strcpy(l3, "lux -");
	} else {
		int cl = als_mlux / 10; /* 0.01 lx units */

		if (cl < 10000) {
			snprintf(l3, sizeof(l3), "lux %d.%02d", cl / 100,
				 cl % 100);
		} else {
			snprintf(l3, sizeof(l3), "lux %d", cl / 100);
		}
	}
	w = (int)strlen(l3) * TEXT_CW;
	draw_text_cached(TC_BATT3, batt_right - w, BATT_Y0 + 48, l3,
			 COL_WHITE, COL_BG);
}

/* Random horizontal position along the upper edge (burn-in), clear of the
 * rounded corners and inside the active idle frame. */
static void batt_move_random(void)
{
	int span = idle_fw() - 190 - 15;

	if (span < 40) {
		span = 40;
	}
	batt_right = (uint16_t)(190U + (jitter_next() % (unsigned)span));
}

static int battery_init(void)
{
	if (!adc_is_ready_dt(&batt_adc)) {
		LOG_ERR("battery ADC not ready");
		return -ENODEV;
	}
	if (adc_channel_setup_dt(&batt_adc) != 0) {
		LOG_ERR("battery ADC channel setup failed");
		return -EIO;
	}
	(void)gpio_pin_configure(gpio1, 12, GPIO_INPUT | GPIO_PULL_UP);
	(void)gpio_pin_configure(gpio1, 13, GPIO_INPUT | GPIO_PULL_UP);
	als_ok = device_is_ready(als);
	LOG_INF("battery monitor ready (AIN7), als ready=%d", als_ok);
	return 0;
}

static void battery_poll(void)
{
	uint16_t raw = 0;
	int32_t sum = 0;
	int n = 0;
	struct adc_sequence seq = {
		.channels = BIT(batt_adc.channel_id),
		.buffer = &raw,
		.buffer_size = sizeof(raw),
		.resolution = batt_adc.resolution,
		.oversampling = batt_adc.oversampling,
	};
	uint8_t old_pct = battery_pct;
	uint16_t old_mv = battery_mv;
	bool old_chg = charger_on;

	if (!adc_is_ready_dt(&batt_adc)) {
		return;
	}

	for (int i = 0; i < 16; i++) {
		if (adc_read_dt(&batt_adc, &seq) == 0) {
			sum += raw;
			n++;
		}
	}
	if (n == 0) {
		return;
	}

	/* Battery scaling: average raw * 4.7643 (10-bit, gain 2/3, int. ref) */
	battery_mv = (uint16_t)((sum / n) * 4764 / 1000);
	battery_pct = mv_to_percent(battery_mv);

	chg_pin12 = (uint8_t)(gpio_pin_get_raw(gpio1, 12) != 0);
	chg_pin13 = (uint8_t)(gpio_pin_get_raw(gpio1, 13) != 0);

	/* Charger status pins are open-drain/active low: high = idle. */
	charger_on = (chg_pin12 == 0U) || (chg_pin13 == 0U);
	ext_power = (chg_pin13 == 0U) && (chg_pin12 != 0U);

	if (als_ok) {
		struct sensor_value sv;

		if (sensor_sample_fetch(als) == 0 &&
		    sensor_channel_get(als, SENSOR_CHAN_LIGHT, &sv) == 0) {
			als_mlux = (int32_t)sensor_value_to_milli(&sv);
		}
	}

	if (battery_pct != old_pct || charger_on != old_chg ||
	    (battery_mv / 50) != (old_mv / 50)) {
		LOG_INF("battery raw=%d mV=%u pct=%u chg=%d ext=%d lux_mlx=%d",
			(int)(sum / n), battery_mv, battery_pct,
			charger_on, ext_power, (int)als_mlux);
	}

	if (ble_batt_level != battery_pct) {
		ble_batt_level = battery_pct;
		(void)bt_gatt_notify(NULL, &bas_svc.attrs[1],
				     &ble_batt_level, sizeof(ble_batt_level));
	}

	if (bri_auto) {
		brightness_auto_apply();
	}

	draw_battery();
}

static void toggle_auto_rot(void)
{
	auto_rot = !auto_rot;
	draw_button(UB_X1, UB_Y1, UB_W, UB_H,
		    auto_rot ? "AUTO ROT" : "ROT OFF", auto_rot);
	LOG_INF("auto rotation %s", auto_rot ? "on" : "off");
}

/* The ambient profiles were tuned with the 800 ms conversion time; pin it
 * at boot (the OPT4001 starts at 100 ms, the OPT300x defaults to 800). */
static void als_ct_init(void)
{
	int ret = opt400x_set_conversion_time(als, 11U); /* 800 ms */

	LOG_INF("als conversion time set to 800 ms (ret %d)", ret);
}

static void toggle_bri_auto(void)
{
	bri_auto = !bri_auto;
	draw_button(UB_X2, UB_Y1, UB_W, UB_H, "AUTO BRI", bri_auto);
	LOG_INF("auto brightness %s", bri_auto ? "on" : "off");
	if (bri_auto) {
		brightness_auto_apply();
	} else {
		/* restore the last manual choice */
		bri_apply(bri_manual, false);
		LOG_INF("brightness back to manual %u", bri_manual);
	}
}

/* Sound enable: gates the synthesized sounds and the SID output. Turning
 * the sound off pauses an actively playing tune; turning it back on
 * resumes it if the mute is what paused it. */
static bool mute_paused; /* SND OFF paused the tune -> SND ON resumes it */

static void sound_set(bool on)
{
	sound_on = on;
	audio_set_enabled(on);
	if (!on && sid_player_is_playing() && !sid_player_is_paused()) {
		sid_player_pause();
		mute_paused = true;
	} else if (on && mute_paused) {
		mute_paused = false;
		if (sid_player_is_playing() && sid_player_is_paused()) {
			sid_player_resume();
		}
	}
	sid_ui_sync(); /* keep the SID screen transport button honest */
	if (ui_scr == SCR_MAIN) {
		draw_button(UB_X3, UB_Y1, UB_W, UB_H,
			    on ? "SND ON" : "SND OFF", on);
	}
	LOG_INF("sound %s", on ? "on" : "off");
}

static void toggle_sound(void)
{
	sound_set(!sound_on);
}

/* SLEEP: idle mode with the panel dark. No clock is drawn and no lux /
 * orientation checks run; the SID player and the (armed) alarms keep
 * working. A touch wakes straight to the UI; an alarm brings up the idle
 * face. */
static void enter_sleep(void)
{
	idle_mode = true;
	idle_blank = true;
	sleep_armed = false;
	idle_rot = rot_270 ? 2 : 0;
	k_sem_reset(&touch_sem);
	accel_suspend();
	(void)gc9307_panel_state(disp, 0); /* display off + sleep in */
	display_on = false;
	LOG_INF("sleep: dark idle (touch wakes, alarms armed)");
}

static void wake_display(void)
{
	/* State 1 = full reset + re-init; panel modes are reset too. */
	(void)gc9307_panel_state(disp, 1);
	(void)display_set_brightness(disp, brightness);
	idle_mode = false;
	idle_blank = false;
	accel_resume();
	display_on = true;
	last_touch_ms = k_uptime_get_32();
	draw_ui();
	LOG_INF("display wake");
}

/* ------------------------------------------------------------------ */
/* I2C diagnostics                                                     */
/* ------------------------------------------------------------------ */

/* The nRF TWIM driver recovers a stuck bus on transfer timeouts; do it
 * explicitly at startup too (a slave can hold SDA low after an MCU-only
 * reset, which turns every transfer into a ~500 ms timeout). */
static void i2c_bus_recover(void)
{
	int rc;

	if (!device_is_ready(touch_i2c.bus)) {
		return;
	}
	rc = i2c_recover_bus(touch_i2c.bus);
	LOG_INF("i2c bus recover: %d", rc);
}

static void i2c_scan(void)
{
	LOG_INF("I2C30 scan:");

	for (uint8_t a = 0x08; a < 0x78; a++) {
		if (i2c_write(touch_i2c.bus, NULL, 0, a) == 0) {
			LOG_INF("  device at 0x%02X", a);
		}
	}
}

/* ------------------------------------------------------------------ */
/* FT3168 touch (polled, reset + init sequence)                     */
/* ------------------------------------------------------------------ */

static int tch_rd(uint8_t reg, uint8_t *buf, size_t len)
{
	return i2c_write_read_dt(&touch_i2c, &reg, 1, buf, len);
}

static int tch_wr(uint8_t reg, uint8_t val)
{
	uint8_t b[2] = { reg, val };

	return i2c_write_dt(&touch_i2c, b, sizeof(b));
}

static int touch_init(void)
{
	if (!device_is_ready(touch_i2c.bus)) {
		LOG_ERR("touch I2C not ready");
		return -ENODEV;
	}

	gpio_pin_configure_dt(&touch_rst, GPIO_OUTPUT_ACTIVE);
	gpio_pin_set_dt(&touch_rst, 1); /* assert (active low) */
	k_sleep(K_MSEC(20));
	gpio_pin_set_dt(&touch_rst, 0); /* release */
	k_sleep(K_MSEC(30));

	(void)tch_wr(0x87, 0x28);
	k_sleep(K_MSEC(5));
	(void)tch_wr(0x87, 0x17);
	(void)tch_wr(0xB0, 0x01);

	uint8_t a0 = 0, a3 = 0, a6 = 0, a8 = 0;

	(void)tch_rd(0xA0, &a0, 1);
	(void)tch_rd(0xA3, &a3, 1);
	(void)tch_rd(0xA6, &a6, 1);
	(void)tch_rd(0xA8, &a8, 1);
	LOG_INF("touch: A0=%02X A3=%02X vendor=%02X fw=%02X", a0, a3, a6, a8);

	/* P1.09: FT3168 interrupt (active high edge) - wakes the CPU from
	 * idle mode without polling. */
	if (gpio_is_ready_dt(&touch_irq)) {
		gpio_pin_configure_dt(&touch_irq, GPIO_INPUT);
		gpio_init_callback(&touch_irq_cb, touch_irq_handler,
				   BIT(touch_irq.pin));
		gpio_add_callback(touch_irq.port, &touch_irq_cb);
		gpio_pin_interrupt_configure_dt(&touch_irq,
						GPIO_INT_EDGE_TO_ACTIVE);
	}

	return 0;
}

/* Single status-register read: is a finger down? (no coordinate read) */
static bool tch_touched(void)
{
	uint8_t st;

	return (tch_rd(0x02, &st, 1) == 0) && ((st & 0x0F) != 0);
}

static void touch_poll(void)
{
	uint8_t st, xy[4];
	uint16_t tx, ty, x = 0, y = 0;

	if (tch_rd(0x02, &st, 1) < 0 || (st & 0x0F) == 0) {
		touch_was_down = false;
		return;
	}
	last_touch_ms = k_uptime_get_32();
	if (tch_rd(0x03, xy, 4) < 0) {
		return;
	}

	tx = ((xy[0] & 0x0F) << 8) | xy[1];
	ty = ((xy[2] & 0x0F) << 8) | xy[3];
	uint8_t ev = xy[0] >> 6;

	if (ev == 1) { /* lift up */
		touch_was_down = false;
		return;
	}
	if (ev != 0 && ev != 2) { /* only down / contact */
		return;
	}

	if (!display_on) {
		/* Any touch wakes the panel; swallow this touch. */
		touch_was_down = true;
		wake_display();
		return;
	}

	map_touch(tx, ty, &x, &y);

	bool first = !touch_was_down;

	if (first) {
		touch_was_down = true;
		LOG_INF("touch raw %u,%u -> ui %u,%u (screen %d)", tx, ty, x, y,
			(int)ui_scr);
	}

	/* Tap actions per screen (first touch-down only). */
	switch (ui_scr) {
	case SCR_MAIN:
		if (first && hit(x, y, TILE_SID_X, TILE_Y, TILE_W, TILE_H)) {
			ui_scr = SCR_SID;
			draw_ui();
			return;
		}
		if (first && hit(x, y, TILE_SENS_X, TILE_Y, TILE_W, TILE_H)) {
			ui_scr = SCR_SENSORS;
			draw_ui();
			return;
		}
		if (first && hit(x, y, TILE_ALM_X, TILE_Y, TILE_W, TILE_H)) {
			ui_scr = SCR_ALARMS;
			draw_ui();
			return;
		}
		if (first && hit(x, y, TILE_SET_X, TILE_Y, TILE_W, TILE_H)) {
			ui_scr = SCR_SETTINGS;
			draw_ui();
			return;
		}
		if (first && hit(x, y, UB_X1, UB_Y1, UB_W, UB_H)) {
			toggle_auto_rot();
			return;
		}
		if (first && hit(x, y, UB_X2, UB_Y1, UB_W, UB_H)) {
			toggle_bri_auto();
			return;
		}
		if (first && hit(x, y, UB_X3, UB_Y1, UB_W, UB_H)) {
			toggle_sound(); /* plays its own click */
			return;
		}
		if (first && hit(x, y, UB_X1, UB_Y2, UB_W, UB_H)) {
			ble_mode = (uint8_t)((ble_mode + 1U) % 3U);
			ble_apply_mode();
			ble_ui_sync(); /* redraw the button right away */
			return;
		}
#ifdef SID_ENGINE_DUAL
		if (first && hit(x, y, UB_X2, UB_Y2, UB_W, UB_H)) {
			/* Engine A/B: full stop, flip the core, restart the
			 * same tune if one was playing. */
			bool was = sid_player_is_playing();
			char path[40];

			sid_player_stop();
			audio_sid_stop();
			sid_player_set_engine_mode(
				!sid_player_engine_legacy());
			if (was && sid_cur_name[0] != '\0') {
				snprintf(path, sizeof(path), "/home/%s",
					 sid_cur_name);
				if (sid_player_load(path) == 0) {
					sid_player_play_default();
					audio_sid_start();
				}
			}
			draw_ui(); /* redraw the button right away */
			return;
		}
#endif
		if (first && hit(x, y, UB_X3, UB_Y2, UB_W, UB_H)) {
			enter_sleep();
			return;
		}
		break;
	case SCR_SID:
		if (first && hit(x, y, HOME_X, HOME_Y, HOME_W, HOME_H)) {
			ui_scr = SCR_MAIN;
			draw_ui();
			return;
		}
		if (first &&
		    hit(x, y, SID_CHIP_X, SID_CHIP_Y, SID_CHIP_W, SID_CHIP_H)) {
			sid_player_set_model((sid_player_model_mode() + 1) % 3);
			draw_sid_screen();
			return;
		}
		if (first &&
		    hit(x, y, SID_TUNEL_X, SID_ROW1_Y, SID_TUNEL_W, SID_ROW1_H)) {
			sid_step(-1, false);
			return;
		}
		if (first &&
		    hit(x, y, SID_PLAY_X, SID_ROW1_Y, SID_PLAY_W, SID_ROW1_H)) {
			sid_toggle_play();
			return;
		}
		if (first &&
		    hit(x, y, SID_STOP_X, SID_ROW1_Y, SID_STOP_W, SID_ROW1_H)) {
			sid_player_stop();
			audio_sid_stop();
			sid_ui_sync(); /* repaint info + buttons immediately */
			return;
		}
		if (first &&
		    hit(x, y, SID_TUNER_X, SID_ROW1_Y, SID_TUNER_W, SID_ROW1_H)) {
			sid_step(1, false);
			return;
		}
		if (first &&
		    hit(x, y, SID_SUBL_X, SID_ROW2_Y, SID_SUB_W, SID_SUB_H)) {
			sid_sub_step(-1);
			return;
		}
		if (first &&
		    hit(x, y, SID_END_X, SID_ROW2_Y, SID_SUB_W, SID_SUB_H)) {
			sid_end_mode = (sid_end_mode + 1) % 3;
			draw_sid_buttons();
			return;
		}
		if (first &&
		    hit(x, y, SID_SUBR_X, SID_ROW2_Y, SID_SUB_W, SID_SUB_H)) {
			sid_sub_step(1);
			return;
		}
		break;
	case SCR_SENSORS:
		if (first && hit(x, y, HOME_X, HOME_Y, HOME_W, HOME_H)) {
			ui_scr = SCR_MAIN;
			draw_ui();
			return;
		}
		break;
	case SCR_SETTINGS:
		if (first && hit(x, y, HOME_X, HOME_Y, HOME_W, HOME_H)) {
			ui_scr = SCR_MAIN;
			draw_ui();
			return;
		}
		if (first &&
		    hit(x, y, SET_NIGHT_X, SET_ROW1_Y, SET_BTN_W, SET_BTN_H)) {
			bri_sel = 0;
			draw_settings_screen();
			return;
		}
		if (first &&
		    hit(x, y, SET_INDOOR_X, SET_ROW1_Y, SET_BTN_W, SET_BTN_H)) {
			bri_sel = 1;
			draw_settings_screen();
			return;
		}
		if (first &&
		    hit(x, y, SET_OUTDOOR_X, SET_ROW1_Y, SET_BTN_W, SET_BTN_H)) {
			bri_sel = 2;
			draw_settings_screen();
			return;
		}
		if (first && hit(x, y, SET_SAVE_X, SET_SAVE_Y, SET_SAVE_W,
				SET_SAVE_H)) {
			save_all_state(); /* time + configs */
			return;
		}
		if (first && hit(x, y, ALM_ARR_X0, SET_SLD_IDLE_Y, ALM_ARR_W,
				SLD_H)) {
			if (idle_timeout_s > IDLE_TIMEOUT_MIN_S) {
				idle_timeout_s -= 15U;
				bri_cfg_dirty = true;
				draw_slider_idle();
			}
			return;
		}
		if (first && hit(x, y, ALM_ARR_X1, SET_SLD_IDLE_Y, ALM_ARR_W,
				SLD_H)) {
			if (idle_timeout_s < IDLE_TIMEOUT_MAX_S) {
				idle_timeout_s += 15U;
				bri_cfg_dirty = true;
				draw_slider_idle();
			}
			return;
		}
		break;
	case SCR_ALARMS:
		if (first && hit(x, y, HOME_X, HOME_Y, HOME_W, HOME_H)) {
			ui_scr = SCR_MAIN;
			draw_ui();
			return;
		}
		if (first && hit(x, y, ALM_MODE_X, ALM_MODE_Y, ALM_MODE_W,
				ALM_MODE_H)) {
			alarms[alm_sel].mode =
				(uint8_t)((alarms[alm_sel].mode + 1U) % 3U);
			alm_cfg_dirty = true;
			draw_alarms_screen();
			return;
		}
		if (first && hit(x, y, ALM_RING_X, ALM_MODE_Y, ALM_RING_W,
				ALM_MODE_H)) {
			alarm_capture_ringtone();
			return;
		}
		if (alarms[alm_sel].mode == 2) {
			for (int i = 0; i < 7; i++) {
				if (first &&
				    hit(x, y, ALM_DAY_X0 + i * ALM_DAY_DX,
					ALM_DAY_Y, ALM_DAY_W, ALM_DAY_H)) {
					alarms[alm_sel].days ^=
						(uint8_t)(1U << i);
					alm_cfg_dirty = true;
					draw_alarms_screen();
					return;
				}
			}
		}
		for (int i = 0; i < 5; i++) {
			if (first &&
			    hit(x, y, ALM_TILE_X0 + i * ALM_TILE_DX,
				ALM_TILE_Y, ALM_TILE_W, ALM_TILE_H)) {
				alm_sel = i;
				draw_alarms_screen();
				return;
			}
		}
		/* -/+ step buttons of the hour, minute and length sliders */
		if (first && hit(x, y, ALM_ARR_X0, ALM_SLD_HOUR_Y, ALM_ARR_W,
				SLD_H)) {
			alarms[alm_sel].hour = (uint8_t)((alarms[alm_sel].hour +
							  23U) % 24U);
			alm_cfg_dirty = true;
			draw_alarms_screen();
			return;
		}
		if (first && hit(x, y, ALM_ARR_X1, ALM_SLD_HOUR_Y, ALM_ARR_W,
				SLD_H)) {
			alarms[alm_sel].hour = (uint8_t)((alarms[alm_sel].hour +
							  1U) % 24U);
			alm_cfg_dirty = true;
			draw_alarms_screen();
			return;
		}
		if (first && hit(x, y, ALM_ARR_X0, ALM_SLD_MIN_Y, ALM_ARR_W,
				SLD_H)) {
			alarms[alm_sel].min = (uint8_t)((alarms[alm_sel].min +
							 59U) % 60U);
			alm_cfg_dirty = true;
			draw_alarms_screen();
			return;
		}
		if (first && hit(x, y, ALM_ARR_X1, ALM_SLD_MIN_Y, ALM_ARR_W,
				SLD_H)) {
			alarms[alm_sel].min = (uint8_t)((alarms[alm_sel].min +
							 1U) % 60U);
			alm_cfg_dirty = true;
			draw_alarms_screen();
			return;
		}
		if (first && hit(x, y, ALM_ARR_X0, ALM_SLD_LEN_Y, ALM_ARR_W,
				SLD_H)) {
			if (alarms[alm_sel].len_sec > IDLE_TIMEOUT_MIN_S) {
				alarms[alm_sel].len_sec =
					(uint16_t)(alarms[alm_sel].len_sec -
						   15U);
				alm_cfg_dirty = true;
				draw_alarms_screen();
			}
			return;
		}
		if (first && hit(x, y, ALM_ARR_X1, ALM_SLD_LEN_Y, ALM_ARR_W,
				SLD_H)) {
			if (alarms[alm_sel].len_sec < IDLE_TIMEOUT_MAX_S) {
				alarms[alm_sel].len_sec =
					(uint16_t)(alarms[alm_sel].len_sec +
						   15U);
				alm_cfg_dirty = true;
				draw_alarms_screen();
			}
			return;
		}
		break;
	}

	/* Volume/brightness sliders: main uses the fixed slots, the SID
	 * screen moves its sliders with the metadata block. Press and drag. */
	if (ui_scr == SCR_MAIN || ui_scr == SCR_SID) {
		int y0 = (ui_scr == SCR_SID) ? sid_sld_vol_y : SLD_VOL_Y;

		if (y >= y0 - 8 && y < y0 + SLD_H + 8 &&
		    x >= SLD_X - 8 && x < SLD_X + SLD_W + 8) {
			int v = ((int)x - SLD_X) * 255 / (SLD_W - 1);

			v = CLAMP(v, 0, 255);
			if ((uint8_t)v != volume) {
				set_volume((uint8_t)v);
			}
			return;
		}
		y0 = (ui_scr == SCR_SID) ? sid_sld_bri_y : SLD_BRI_Y;
		if (y >= y0 - 8 && y < y0 + SLD_H + 8 &&
		    x >= SLD_X - 8 && x < SLD_X + SLD_W + 8) {
			int v = ((int)x - SLD_X) * 255 / (SLD_W - 1);

			v = CLAMP(v, 0, 255);
			if ((uint8_t)v != brightness) {
				set_brightness((uint8_t)v);
			}
			return;
		}
	}

	/* Settings sliders: LUX + brightness of the edited profile, then the
	 * display frame rate (all press and drag). */
	if (ui_scr == SCR_SETTINGS &&
	    y >= SET_SLD_LUX_Y - 8 && y < SET_SLD_LUX_Y + SLD_H + 8 &&
	    x >= SLD_X - 8 && x < SLD_X + SLD_W + 8) {
		int v = ((int)x - SLD_X) * 10000 / (SLD_W - 1);

		v = CLAMP(v, 0, 10000);
		v = (v + 25) / 50 * 50; /* 0.05 lx steps */
		if ((uint16_t)v != bri_lux[bri_sel]) {
			bri_lux[bri_sel] = (uint16_t)v;
			bri_cfg_dirty = true;
			draw_slider_lux();
		}
		return;
	}
	if (ui_scr == SCR_SETTINGS &&
	    y >= SET_SLD_BRI_Y - 8 && y < SET_SLD_BRI_Y + SLD_H + 8 &&
	    x >= SLD_X - 8 && x < SLD_X + SLD_W + 8) {
		int v = ((int)x - SLD_X) * 255 / (SLD_W - 1);
		uint8_t nv;

		v = CLAMP(v, 0, 255);
		nv = (uint8_t)v;
		if (nv != bri_lvl[bri_sel]) {
			bri_lvl[bri_sel] = nv;
			bri_cfg_dirty = true;
			draw_slider_set_bri();
			/* live feedback when editing the active profile */
			if (bri_auto && bri_sel == auto_step) {
				bri_apply(nv, false);
			}
		}
		return;
	}
	if (ui_scr == SCR_SETTINGS &&
	    y >= SET_SLD_IDLE_Y - 8 && y < SET_SLD_IDLE_Y + SLD_H + 8 &&
	    x >= ALM_SLD_X - 4 && x < ALM_SLD_X + ALM_SLD_W + 4) {
		int lv = ((int)x - ALM_SLD_X) * 19 / (ALM_SLD_W - 1);
		uint16_t s = (uint16_t)((lv + 1) * 15);

		if (lv < 0) {
			s = IDLE_TIMEOUT_MIN_S;
		}
		if (s > IDLE_TIMEOUT_MAX_S) {
			s = IDLE_TIMEOUT_MAX_S;
		}
		if (s != idle_timeout_s) {
			idle_timeout_s = s;
			bri_cfg_dirty = true;
			draw_slider_idle();
		}
		return;
	}

	/* Alarms screen sliders: hour, minute and playback length (the hour
	 * and minute rows have -/+ buttons handled above). */
	if (ui_scr == SCR_ALARMS) {
		struct alarm_cfg *a = &alarms[alm_sel];
		int v;

		if (y >= ALM_SLD_HOUR_Y - 8 && y < ALM_SLD_HOUR_Y + SLD_H + 8 &&
		    x >= ALM_SLD_X - 4 && x < ALM_SLD_X + ALM_SLD_W + 4) {
			v = ((int)x - ALM_SLD_X) * 23 / (ALM_SLD_W - 1);
			v = CLAMP(v, 0, 23);
			if ((uint8_t)v != a->hour) {
				a->hour = (uint8_t)v;
				alm_cfg_dirty = true;
				draw_alarms_screen();
			}
			return;
		}
		if (y >= ALM_SLD_MIN_Y - 8 && y < ALM_SLD_MIN_Y + SLD_H + 8 &&
		    x >= ALM_SLD_X - 4 && x < ALM_SLD_X + ALM_SLD_W + 4) {
			v = ((int)x - ALM_SLD_X) * 59 / (ALM_SLD_W - 1);
			v = CLAMP(v, 0, 59);
			if ((uint8_t)v != a->min) {
				a->min = (uint8_t)v;
				alm_cfg_dirty = true;
				draw_alarms_screen();
			}
			return;
		}
		if (y >= ALM_SLD_LEN_Y - 8 && y < ALM_SLD_LEN_Y + SLD_H + 8 &&
		    x >= ALM_SLD_X - 4 && x < ALM_SLD_X + ALM_SLD_W + 4) {
			v = ((int)x - ALM_SLD_X) * 19 / (ALM_SLD_W - 1) + 1;
			v = CLAMP(v, 1, 20);
			v *= 15;
			if ((uint16_t)v != a->len_sec) {
				a->len_sec = (uint16_t)v;
				alm_cfg_dirty = true;
				draw_alarms_screen();
			}
			return;
		}
	}
}

/* ------------------------------------------------------------------ */
/* LIS2DH accelerometer                                                */
/* ------------------------------------------------------------------ */

static int abs_i(int v)
{
	return v < 0 ? -v : v;
}

/*
 * Full LIS2DH initialization before live samples: CTRL3/2, the FIFO, a
 * REFERENCE read to reset the high-pass filter, then CTRL6 and finally
 * CTRL1. The upstream driver only clears CTRL1..CTRL6 and never touches the
 * filter or the FIFO, and a part whose filter was never initialized keeps
 * answering every read with its power-on zeros.
 */
static void accel_config(void)
{
	uint8_t ref;

	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG3, 0x00);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG2, 0x1A);
	/* BDU so a sample is never read half-updated, +-2g, high resolution:
	 * `raw >> 4` is mg on this path */
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG4, 0x88);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG5, 0x00);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_FIFO_CTRL, 0x00);
	/* Reading REFERENCE resets the high-pass filter (LIS2DH12 datasheet
	 * rev 6 section 8.9 footnote 1 - the step the Zephyr driver itself
	 * does on PM resume); without it the filter keeps a stale reference. */
	(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_REFERENCE, &ref);
	/* filter off the data path (0x30), INT2 on the INT1 pad (inert: CTRL6
	 * routes no interrupt to a pin), axes on, then 100 Hz with all three
	 * axes */
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG2, 0x30);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG3, 0x10);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG6, 0x00);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1, 0x07);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1, 0x57);
}

/* Direct-poll fallback: standard LIS2DH setup, 100 Hz, BDU, +-2g, HR */
static int accel_direct_init(void)
{
	static uint32_t probe_last;
	static int probe_ret = -1;
	static uint8_t probe_who;
	uint8_t who = 0;
	uint32_t now;
	int ret;

	ret = i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_WHO_AM_I, &who);

	/* Rate limited: this also runs on every idle orientation check. */
	now = k_uptime_get_32();
	if (ret != probe_ret || who != probe_who ||
	    now - probe_last >= 30000U) {
		probe_last = now;
		probe_ret = ret;
		probe_who = who;
		LOG_INF("accel probe 0x%02X: ret=%d WHO_AM_I=0x%02X",
			ACC_ADDR, ret, who);
	}

	if (ret < 0 || who != 0x33) {
		return -ENODEV;
	}

	accel_config();

	/* 100 Hz: a conversion takes 10 ms, so without the wait the first
	 * read after a resume still returns the power-on zeros. */
	k_sleep(K_MSEC(20));
	return 0;
}

/* The six output bytes, auto-increment set in the sub-address. */
static int accel_raw_read(uint8_t b[6])
{
	uint8_t r = ACC_OUT_X_L | 0x80;

	return i2c_write_read(touch_i2c.bus, ACC_ADDR, &r, 1, b, 6);
}

static int accel_direct_read(int mg[3])
{
	uint8_t b[6];

	if (accel_raw_read(b) < 0) {
		mg[0] = mg[1] = mg[2] = 0;
		return -EIO;
	}

	for (int i = 0; i < 3; i++) {
		int16_t raw = (int16_t)((b[i * 2 + 1] << 8) | b[i * 2]);

		mg[i] = raw >> 4; /* HR mode, +-2g: 1 mg/LSB */
	}
	return 0;
}

/*
 * A read that came back all-zero (with no error anywhere) is what makes the
 * sensor screen show 0.000 and the idle face never turn on a unit whose
 * accelerometer never got the full initialization (see accel_config()): the
 * driver reports data-ready but the output registers never move. Say so,
 * once per 10 s, with the raw bytes.
 */
static void accel_zero_note(const char *src)
{
	static uint32_t last;
	uint8_t b[6];
	uint32_t now = k_uptime_get_32();

	if (now - last < 10000U) {
		return;
	}
	last = now;

	if (accel_raw_read(b) == 0) {
		LOG_WRN("accel: %s sample shows no gravity, raw %02X%02X %02X%02X %02X%02X",
			src, b[0], b[1], b[2], b[3], b[4], b[5]);
	} else {
		LOG_WRN("accel: %s sample shows no gravity, raw read failed",
			src);
	}
}

/*
 * Upstream driver path. False covers both a failed read and the "data ready,
 * data zero" answer of an unconfigured chip - gravity is always visible on
 * some axis, so an all-zero triple is never a live sample.
 */
static bool accel_driver_read(struct sensor_value xyz[3])
{
	if (!device_is_ready(accel) ||
	    sensor_sample_fetch(accel) != 0 ||
	    sensor_channel_get(accel, SENSOR_CHAN_ACCEL_X, &xyz[0]) != 0 ||
	    sensor_channel_get(accel, SENSOR_CHAN_ACCEL_Y, &xyz[1]) != 0 ||
	    sensor_channel_get(accel, SENSOR_CHAN_ACCEL_Z, &xyz[2]) != 0) {
		return false;
	}

	return true;
}

/*
 * A live accelerometer sample always shows gravity: at rest one axis carries
 * ~1 g, so the axes add up to roughly 1000 mg anywhere between upright and
 * flat. A chip whose output registers never move sums to nearly nothing -
 * that (rather than an exact 0.000) is what a part without the filter
 * configuration reports.
 */
static bool accel_live_mg(int x, int y, int z)
{
	return abs_i(x) + abs_i(y) + abs_i(z) >= 500;
}

/*
 * One accelerometer sample in mg (1 g = 1000), from whichever path can
 * serve a live one: the upstream driver when it returns real data, else the
 * direct poller (after resyncing the chip). Returns 0 on success.
 */
static int accel_sample(int mg[3])
{
	if (!accel_direct) {
		struct sensor_value xyz[3];

		if (accel_driver_read(xyz)) {
			for (int i = 0; i < 3; i++) {
				/* m/s2 -> mg: 9810 milli-m/s2 is 1 g */
				int v = xyz[i].val1 * 1000 + xyz[i].val2 / 1000;

				mg[i] = v * 100 / 981;
			}
			if (accel_live_mg(mg[0], mg[1], mg[2])) {
				return 0;
			}
			accel_zero_note("driver");
		}

		/* upstream driver cannot serve a live sample -> own poller */
		if (accel_direct_init() != 0) {
			return -1;
		}
		accel_direct = true;
	}

	if (accel_direct_read(mg) != 0) {
		return -1;
	}
	if (!accel_live_mg(mg[0], mg[1], mg[2])) {
		accel_zero_note("direct");
		return -1;
	}
	return 0;
}

/*
 * Diagnostic (BLE debug command 0x1F): put the accelerometer's identity and
 * whole register file in the log. Reads only, so it is safe to run on a
 * device in the field; the lines show which chip answers at 0x19 and whether
 * it is holding the configuration a live sample needs.
 */
static void accel_dump(void)
{
	uint8_t b[8];

	for (uint8_t a = 0x08; a < 0x78; a++) {
		if (i2c_write(touch_i2c.bus, NULL, 0, a) == 0) {
			LOG_INF("accel: i2c device at 0x%02X", a);
		}
	}

	for (uint8_t a = ACC_ALT_ADDR; a <= ACC_ADDR; a++) {
		uint8_t who = 0;
		int ret = i2c_reg_read_byte(touch_i2c.bus, a, ACC_WHO_AM_I,
					    &who);

		LOG_INF("accel: addr 0x%02X who_am_i ret=%d 0x%02X",
			a, ret, who);
	}

	LOG_INF("accel: driver ready=%d direct=%d",
		device_is_ready(accel), accel_direct);

	if (!accel_direct) {
		struct sensor_value xyz[3];

		if (accel_driver_read(xyz)) {
			LOG_INF("accel: driver %d.%06d %d.%06d %d.%06d m/s2",
				xyz[0].val1, abs_i(xyz[0].val2),
				xyz[1].val1, abs_i(xyz[1].val2),
				xyz[2].val1, abs_i(xyz[2].val2));
		} else {
			LOG_INF("accel: driver sample unusable");
		}
	} else {
		int mg[3];

		(void)accel_direct_read(mg);
		LOG_INF("accel: direct %d %d %d mg", mg[0], mg[1], mg[2]);
	}

	for (uint8_t r = 0; r < 0x60U; r += 8U) {
		uint8_t a = (uint8_t)(r | 0x80);

		if (i2c_write_read(touch_i2c.bus, ACC_ADDR, &a, 1, b, 8) < 0) {
			LOG_INF("accel: reg 0x%02X read failed", r);
			continue;
		}
		LOG_INF("accel: reg %02X: %02X %02X %02X %02X %02X %02X %02X %02X",
			r, b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]);
	}

	/* Single-register reads of the control block, to compare with the
	 * burst rows above (a part whose auto-increment misbehaves would
	 * show the same value eight times, or zeros). */
	{
		uint8_t r1 = 0, r4 = 0, r5 = 0, st = 0, ref = 0;

		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1,
					&r1);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG4,
					&r4);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG5,
					&r5);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_STATUS_REG,
					&st);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_REFERENCE,
					&ref);
		LOG_INF("accel: single ctrl1=%02X ctrl4=%02X ctrl5=%02X status=%02X ref=%02X",
			r1, r4, r5, st, ref);
	}

	/* The remaining registers the init sequence touches, so a unit that
	 * only serves zeros can be compared against a working one. */
	{
		uint8_t r2 = 0, r3 = 0, r6 = 0, fc = 0, fs = 0, i2 = 0;

		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG2,
					&r2);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG3,
					&r3);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG6,
					&r6);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_FIFO_CTRL,
					&fc);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_FIFO_SRC,
					&fs);
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, 0x34, &i2);
		LOG_INF("accel: single ctrl2=%02X ctrl3=%02X ctrl6=%02X fifo=%02X/%02X int2cfg=%02X",
			r2, r3, r6, fc, fs, i2);
	}

	/* Single-register reads of the six output bytes, so a broken burst
	 * cannot be mistaken for a frozen sensor. */
	{
		uint8_t o[6];

		for (uint8_t i = 0; i < 6; i++) {
			(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR,
						ACC_OUT_X_L + i, &o[i]);
		}
		LOG_INF("accel: single out X=%02X%02X Y=%02X%02X Z=%02X%02X",
			o[1], o[0], o[3], o[2], o[5], o[4]);
	}

	/* Do control writes stick at all? (0x57 = 100 Hz, 0x08 = +-2g HR) */
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1,
				 0x57);
	(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1, &b[0]);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG4,
				 0x08);
	(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG4, &b[1]);
	LOG_INF("accel: wrote ctrl1=57 ctrl4=08, read back %02X %02X",
		b[0], b[1]);
}

#ifdef SIDCLOCK_DEBUG
/*
 * Diagnostic (BLE 0x1F 01): try to bring a silent accelerometer back.
 * Reboots the register file from OTP (CTRL5 BOOT bit) and then walks the
 * ODR settings, logging the data registers after each - a part that only
 * needs a reset sequence starts producing gravity somewhere in the list.
 */
static void accel_revive(void)
{
	static const uint8_t odr[] = { 0x17, 0x27, 0x2F, 0x37, 0x47, 0x57,
				       0x67, 0x87 };
	uint8_t b[6];

	LOG_INF("accel: revive: power down, BOOT, then ODR sweep");

	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1, 0x00);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG4, 0x08);
	/* BOOT: reload the register file from OTP (self-clearing). */
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG5, 0x80);
	k_sleep(K_MSEC(30));

	for (size_t i = 0; i < ARRAY_SIZE(odr); i++) {
		uint8_t st = 0;

		(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR,
					 ACC_CTRL_REG4, 0x08);
		(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR,
					 ACC_CTRL_REG1, odr[i]);
		k_sleep(K_MSEC(60));
		(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR,
					ACC_STATUS_REG, &st);

		if (accel_raw_read(b) < 0) {
			LOG_INF("accel: odr %02X status %02X raw read failed",
				odr[i], st);
			continue;
		}
		LOG_INF("accel: odr %02X status %02X raw %02X%02X %02X%02X %02X%02X",
			odr[i], st, b[0], b[1], b[2], b[3], b[4], b[5]);
	}

	/* leave it at 100 Hz, all axes, +-2g, high resolution */
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1, 0x57);
}

/*
 * Diagnostic (BLE 0x1F 02): power-cycle the sensor rail (P1.11) and bring
 * touch, ambient light and the accelerometer back up, watching the data
 * registers. A latched bad power-up state - the "first boot after flashing
 * / flat battery" case - shows up as data that starts moving here.
 */
static void accel_rail_cycle(void)
{
	const struct device *p1 = DEVICE_DT_GET(DT_NODELABEL(gpio1));
	uint8_t m1 = 0, m4 = 0, st = 0;
	int tr, ar;

	/* Marker: CTRL4 = 0x88 / CTRL1 = 0x27 are not values the app ever
	 * writes. If they survive the rail drop the chip's supply was not
	 * actually cut (P1.11 gates something else), so the cycle below is
	 * not a power-on-reset of the accelerometer. */
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG4, 0x88);
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1, 0x27);

	LOG_INF("accel: power-cycling the sensor rail (P1.11 low 150 ms)");
	(void)gpio_pin_set(p1, 11, 0);
	k_sleep(K_MSEC(150));
	(void)gpio_pin_set(p1, 11, 1);
	k_sleep(K_MSEC(150));

	(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1, &m1);
	(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG4, &m4);
	(void)i2c_reg_read_byte(touch_i2c.bus, ACC_ADDR, ACC_STATUS_REG, &st);

	tr = touch_init();
	als_ct_init();
	ar = accel_direct_init();
	accel_direct = true;

	for (int i = 0; i < 6; i++) {
		uint8_t b[6];

		k_sleep(K_MSEC(60));
		if (accel_raw_read(b) < 0) {
			LOG_INF("accel: after rail cycle %d: raw read failed", i);
			continue;
		}
		LOG_INF("accel: after rail cycle %d: raw %02X%02X %02X%02X %02X%02X",
			i, b[0], b[1], b[2], b[3], b[4], b[5]);
	}

	accel_dump();

	/* This handler blocks the log drain until it returns and the release
	 * buffer is only ~2 KB, so the summary goes last, after the dump. */
	LOG_INF("accel: rail summary: marker ctrl1=%02X ctrl4=%02X status=%02X power-cycled=%d touch_init=%d accel_init=%d",
		m1, m4, st, !(m1 == 0x27 && m4 == 0x88), tr, ar);
}
#endif /* SIDCLOCK_DEBUG */

/* Accelerometer power save for idle mode: CTRL_REG1 = 0 (power down). */
static void accel_suspend(void)
{
	(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR, ACC_CTRL_REG1, 0x00);
}

static void accel_resume(void)
{
	if (accel_direct) {
		(void)accel_direct_init();
	} else {
		/* The chip keeps its configuration across power-down (a working
		 * unit never needed more than this), so the filter sequence is
		 * only applied once at boot. If a part ever does lose it, the
		 * sample check in accel_sample() notices, falls back to the
		 * poller and configures it again. */
		(void)i2c_reg_write_byte(touch_i2c.bus, ACC_ADDR,
					ACC_CTRL_REG1, 0x57);
	}
}

/*
 * Idle mode: accelerometer powered down, display updates only the clock and
 * the battery/lux block once a minute. Any touch (FT3168 INT or the 1 s
 * fallback poll) returns to the full UI.
 */
/*
 * Idle face auto-rotation: read the display-plane tilt (one fresh sample)
 * and pick the idle orientation. The accelerometer is otherwise powered
 * down in idle, so the caller resumes it for this (~20 ms once a minute)
 * and suspends it again right after.
 *
 * The accel is only trusted when gravity clearly lies in the display plane
 * (|x| or |y| > 350 mg); when the device lies flat the current face is kept.
 * The quadrant -> rotation table is the only hardware-dependent part
 * (device mounting) and is easy to permute if a rotation comes out 90 deg
 * off.
 */
static int accel_orientation(void)
{
	/* quadrants: 0 = +X, 1 = -X, 2 = +Y, 3 = -Y */
	static const uint8_t quad2rot[4] = { 1, 3, 2, 0 };
	int mg[3] = { 0, 0, 0 };
	int q;

	accel_resume();
	k_sleep(K_MSEC(20)); /* let one sample settle */

	if (accel_sample(mg) != 0) {
		return -1;
	}

	if (abs_i(mg[0]) < 350 && abs_i(mg[1]) < 350) {
		return -1; /* lying flat: keep the current face */
	}
	q = (abs_i(mg[0]) >= abs_i(mg[1])) ? (mg[0] > 0 ? 0 : 1)
					   : (mg[1] > 0 ? 2 : 3);
	idle_quad = (uint8_t)q;
	return quad2rot[q];
}

/* Normal-UI auto rotation (AUTO ROT): pick the landscape mapping (90/270)
 * that matches the orientation. Portrait holds and a flat device keep the
 * current mapping; the full four-way rotation above is idle-only. */
static int accel_ui_rot(void)
{
	int mg[3] = { 0, 0, 0 };

	if (accel_sample(mg) != 0) {
		return -1;
	}

	if (abs_i(mg[0]) < 350 && abs_i(mg[1]) < 350) {
		return -1; /* flat: keep the current mapping */
	}
	if (abs_i(mg[1]) <= abs_i(mg[0])) {
		return -1; /* held upright: the UI stays landscape */
	}
	return (mg[1] > 0) ? 2 : 0;
}

static void enter_idle(void)
{
	int rot = -1;

	if (auto_rot) {
		rot = accel_orientation();
	}
	idle_mode = true;
	idle_blank = false;
	if (bri_auto) {
		brightness_auto_apply();
	}
	/* flat, unreadable or ROT OFF: keep the landscape mapping */
	idle_rot = (rot >= 0) ? rot : (rot_270 ? 2 : 0);
	accel_suspend();
	audio_dbg_byte(18, (uint8_t)idle_rot);
	audio_dbg_byte(19, idle_quad);
	/*
	 * The face is drawn right below at a fresh random position. Line the
	 * minute counter up with the current minute so the next move happens
	 * exactly at the next minute boundary - forcing 0xFFFFFFFF made the
	 * clock jump again within a second of entering idle.
	 */
	clock_last_min = (epoch_now() / 60U) % (24U * 60U);
	k_sem_reset(&touch_sem);
	draw_idle_face();
	LOG_INF("idle mode on (rot %d, quad %u)", idle_rot, idle_quad);
}

static void exit_idle(void)
{
	idle_mode = false;
	batt_right = BATT_X1;
	accel_resume();
	touch_was_down = true; /* swallow the waking touch */
	touch_irq_flag = false;
	last_touch_ms = k_uptime_get_32();
	draw_ui();
	LOG_INF("idle mode off");
}

/* One bar per axis: coloured from the centre line to the current value.
 * X = green, Y = blue, Z = red, so the reduced-color idle mode is easy to
 * spot.
 */
static const uint16_t accel_bar_colors[3] = {
	COL_GREEN, COL_BLUE, COL_RED,
};

static void draw_accel_bar(int row, int mg, uint16_t color)
{
	const int half = BAR_W / 2;
	int len = (mg < 0) ? -mg : mg;
	int y = BAR_Y0 + row * BAR_DY;

	len = len * half / ACCEL_MAX_MG;
	if (len > half) {
		len = half;
	}

	fill_rect(BAR_X, y, BAR_W, BAR_H, COL_TRACK);
	fill_rect(BAR_CX, y, 1, BAR_H, COL_BORDER);
	if (len > 0) {
		fill_rect((mg >= 0) ? BAR_CX : BAR_CX - len, y, len, BAR_H,
			  color);
	}
}

static void draw_accel_bars(const int mg[3])
{
	for (int i = 0; i < 3; i++) {
		draw_accel_bar(i, mg[i], accel_bar_colors[i]);
	}
}

static void show_accel(void)
{
	char line[56];
	int mg[3] = { 0, 0, 0 };

	if (accel_sample(mg) != 0) {
		static const int zero[3] = { 0, 0, 0 };

		/* no live sample from either path: say so instead of a
		 * plausible-looking 0.000 */
		draw_text_cached(TC_ACCEL, 8, 108, "ACCEL: no sample",
				 COL_CYAN, COL_BG);
		draw_accel_bars(zero);
		return;
	}

	snprintf(line, sizeof(line), "g X%+d.%03d Y%+d.%03d Z%+d.%03d",
		 mg[0] / 1000, abs_i(mg[0]) % 1000,
		 mg[1] / 1000, abs_i(mg[1]) % 1000,
		 mg[2] / 1000, abs_i(mg[2]) % 1000);

	draw_text_cached(TC_ACCEL, 8, 108, line, COL_CYAN, COL_BG);
	draw_accel_bars(mg);
}

/* ------------------------------------------------------------------ */
/* Bluetooth advertising (SMP/mcumgr service is registered by Zephyr)  */
/* ------------------------------------------------------------------ */

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME,
		sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

/* Advertising restart is deferred: inside the disconnect callback the HCI
 * command buffer may still be in use (-ENOMEM). */
static struct k_work_delayable adv_work;
static void adv_work_handler(struct k_work *work);

static void bt_setup(void)
{
	int err;

	k_work_init_delayable(&adv_work, adv_work_handler);

	err = bt_enable(NULL);

	if (err) {
		LOG_ERR("bt_enable: %d", err);
		return;
	}

	err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), NULL, 0);
	if (err) {
		LOG_ERR("advertising start failed: %d", err);
	} else {
		ble_adv_on = true;
		LOG_INF("BLE advertising as \"%s\"", CONFIG_BT_DEVICE_NAME);
	}
}

/* Re-advertise when a central disconnects; otherwise advertising stays off. */
/* Boost the link for OTA when a central connects: max data length,
 * 2M PHY and a 15 ms connection interval. */
static void bt_connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		LOG_ERR("BLE connect failed (%u)", err);
		return;
	}
	if (ble_mode == BLE_MODE_OFF) {
		/* racing a mode change: no BLE in OFF */
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		return;
	}

	ble_adv_on = false; /* connectable advertising stops on connect */
	LOG_INF("BLE connected (MTU %u)", bt_gatt_get_mtu(conn));

	(void)bt_conn_le_data_len_update(conn, BT_LE_DATA_LEN_PARAM_MAX);
	(void)bt_conn_le_phy_update(conn, BT_CONN_LE_PHY_PARAM_2M);
	(void)bt_conn_le_param_update(conn, BT_LE_CONN_PARAM(12, 12, 0, 400));
}

static void bt_le_param_updated(struct bt_conn *conn, uint16_t interval,
				uint16_t latency, uint16_t timeout)
{
	ARG_UNUSED(conn);
	LOG_INF("LE conn: interval %u.%02u ms, latency %u, timeout %u ms",
		((uint32_t)interval * 125) / 100,
		(uint32_t)((interval * 125) % 100), latency, timeout * 10);
}

static void bt_le_data_len_updated(struct bt_conn *conn,
				   struct bt_conn_le_data_len_info *info)
{
	ARG_UNUSED(conn);
	LOG_INF("LE data len: tx %u rx %u", info->tx_max_len, info->rx_max_len);
}

static void bt_le_phy_updated(struct bt_conn *conn, struct bt_conn_le_phy_info *info)
{
	ARG_UNUSED(conn);
	LOG_INF("LE PHY: tx %u rx %u", info->tx_phy, info->rx_phy);
}

static void adv_work_handler(struct k_work *work)
{
	int err;

	if (ble_mode == BLE_MODE_OFF) {
		return; /* BLE switched off from the UI */
	}
	err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), NULL, 0);

	if (err) {
		LOG_WRN("re-advertising failed: %d, retrying", err);
		k_work_reschedule(&adv_work, K_MSEC(500));
	} else {
		ble_adv_on = true;
		LOG_INF("BLE advertising restarted");
	}
}

static void bt_disconnected(struct bt_conn *conn, uint8_t reason)
{
	ARG_UNUSED(conn);
	LOG_INF("BLE disconnected (reason %u)", reason);
	if (ble_mode != BLE_MODE_OFF) {
		k_work_reschedule(&adv_work, K_MSEC(200));
	}
}

/* Register/unregister the mcumgr BLE service (OTA + fs_mgmt + os_mgmt). */
static void ble_smp_set(bool on)
{
	int rc;

	if (on == ble_smp_on) {
		return;
	}
	rc = on ? smp_bt_register() : smp_bt_unregister();
	if (rc == 0) {
		ble_smp_on = on;
		LOG_INF("SMP service %s", on ? "registered" : "unregistered");
	} else {
		LOG_WRN("SMP %s failed: %d", on ? "register" : "unregister", rc);
	}
}

static void ble_disconnect_conn(struct bt_conn *conn, void *data)
{
	ARG_UNUSED(data);

	(void)bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
}

static void ble_mode_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);

	if (ble_mode == BLE_MODE_OFF) {
		ble_smp_set(false);
		if (ble_adv_on) {
			(void)bt_le_adv_stop();
			ble_adv_on = false;
		}
		bt_conn_foreach(BT_CONN_TYPE_LE, ble_disconnect_conn, NULL);
		return;
	}

	ble_smp_set(ble_mode == BLE_MODE_RW);
	if (!ble_adv_on) {
		k_work_reschedule(&adv_work, K_NO_WAIT);
	}
}

/* Deferred on purpose: the debug command runs in the BT RX thread, where
 * the HCI calls above could stall, and an immediate disconnect would eat
 * the ATT response of the very write that changed the mode. */
static K_WORK_DELAYABLE_DEFINE(ble_mode_work, ble_mode_work_handler);

/* Apply the current BLE mode to advertising, connections and the SMP
 * service. Safe from any context (the work item is ISR/thread-safe). */
static void ble_apply_mode(void)
{
	k_work_reschedule(&ble_mode_work, K_MSEC(100));
}

/* Repaint the main-screen BLE button if the mode changed. The BLE debug
 * command runs in the BT thread, so drawing is deferred to a call from the
 * main loop or the tap handler. */
static void ble_ui_sync(void)
{
	static uint8_t shown = 0xFFU;

	if (shown == ble_mode) {
		return;
	}
	shown = ble_mode;
	if (ui_scr == SCR_MAIN && !idle_mode) {
		draw_button(UB_X1, UB_Y2, UB_W, UB_H, ble_mode_label(),
			    ble_mode != BLE_MODE_OFF);
	}
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = bt_connected,
	.disconnected = bt_disconnected,
	.le_param_updated = bt_le_param_updated,
	.le_data_len_updated = bt_le_data_len_updated,
	.le_phy_updated = bt_le_phy_updated,
};

/* ------------------------------------------------------------------ */

int main(void)
{
	crash_log_boot();
	watchdog_start();
	disp = DEVICE_DT_GET(DT_CHOSEN(zephyr_display));
	if (!device_is_ready(disp)) {
		LOG_ERR("display not ready");
		return 0;
	}

	/* Landscape UI: the panel stays in its native portrait address space
	 * and every window is transposed (software rotation, like the stock
	 * firmware). */
	(void)gc9307_set_rotation(disp, GC9307_ROT_0);
	(void)display_set_brightness(disp, brightness);
	als_ct_init();
	draw_ui();
	LOG_INF("display ready (rot %s, bri %u)", rot_270 ? "270" : "90",
		brightness);

	/*
	 * Confirm as early as possible so an OTA test swap cannot revert.
	 * On an image flashed directly over SWD this returns BOOT_EBADVECT (4)
	 * because no bootloader swap has initialized the trailer yet; that is
	 * expected and harmless (there is no pending swap to confirm). After
	 * any MCUboot swap the trailer is valid and this succeeds.
	 */
#if defined(CONFIG_MCUBOOT_IMG_MANAGER)
	if (!boot_is_img_confirmed()) {
		int rc = boot_write_img_confirmed();

		LOG_INF("image confirm: %d", rc);
	}
#endif

	i2c_bus_recover();
	touch_init();
	i2c_scan();

	/* show both slot geometries + current trailer state once at boot */
	trailer_dump(FIXED_PARTITION_ID(slot0_partition), "slot0");
	trailer_dump(FIXED_PARTITION_ID(slot1_partition), "slot1");

	accel = DEVICE_DT_GET(DT_NODELABEL(lis2dh));
	LOG_INF("accel device ready: %d", device_is_ready(accel));

	/* Configure the chip before the first read. The Zephyr driver's init
	 * clears CTRL1..CTRL6 to their boot values but never touches the
	 * high-pass filter or the FIFO, and an unconfigured part answers
	 * every read with its power-on zeros; accel_config() applies the
	 * full sequence instead. The driver path is kept when it is ready,
	 * the built-in poller takes over when it is not. */
	if (accel_direct_init() != 0 && !device_is_ready(accel)) {
		accel_direct = true;
	}

#if defined(CONFIG_MCUMGR_GRP_FS_FILE_ACCESS_HOOK)
	mgmt_callback_register(&home_fs_access_mgmt_cb);
#endif
	bt_setup();

	(void)battery_init();
	battery_poll();

	if (audio_init() == 0) {
		audio_set_volume(volume);
		audio_set_enabled(sound_on);
	}

	fs_storage_init(false); /* mount /home (no format); see the BLE docs */
	/* dir.txt was a generated index for hosts without a listing command;
	 * 0x13 now serves from the RAM cache. Drop the stale copy and build
	 * the cache once, before playback can start. */
	(void)fs_unlink("/home/dir.txt");
	home_list_cache_build();
	bri_cfg_load();   /* restore the ambient brightness profiles */
	for (int i = 0; i < 5; i++) {
		alarms[i].hour = 7;
		alarms[i].len_sec = 300;
		alarms[i].days = 0x7F;
	}
	alm_cfg_load();   /* restore the alarms (overrides the defaults) */
	time_cfg_load();  /* restore the wall clock across warm resets */
	sid_remember_load(); /* reload the last tune (stopped, metadata on) */

	uint32_t t_acc = 0;
#ifdef SIDCLOCK_DEBUG
	uint32_t t_dump = 0;
#endif
	uint32_t t_batt = 0;
	uint32_t t_sidui = 0;
	uint32_t t_bricfg = 0;
	uint32_t t_timecfg = 0;
	uint32_t t_idlechk = 0;
	uint32_t t_autorot = 0;

	while (1) {
		/* hang safety net + triage heartbeat (see watchdog_start) */
		dbg_heartbeat_main();
		if (wdt_dev != NULL) {
			(void)wdt_feed(wdt_dev, wdt_chan);
		}
		/* stack telemetry (command 0x1D) */
		if (stacks_pending) {
			stacks_pending = false;
			stacks_latch();
			stacks_valid = true;
			LOG_INF("stacks latched: page %u rows %u of %u",
				stacks_page, stacks_latched, stacks_total);
		}
		/* the SID marquee only advances while its screen is on
		 * show (idle face, other screens and the dark panel pause
		 * it instead of silently running it on) */
		sid_scroll_advance(display_on && !idle_mode &&
				   ui_scr == SCR_SID);

		/* BLE player commands and status: run what the GATT write
		 * handler parked (the BT RX workqueue cannot afford the SID
		 * loader on its 2 KB stack), then push the state to a
		 * subscribed host */
		sid_req_take();
		player_ble_tick();

		if (!display_on) {
			if (idle_mode && idle_blank) {
				/*
				 * SLEEP: idle with the panel dark. Alarms
				 * and the SID player stay alive; the clock
				 * is not drawn and no lux/orientation
				 * checks run. A touch wakes straight to
				 * the UI; a firing alarm brings up the
				 * idle face.
				 */
				(void)k_sem_take(&touch_sem, K_MSEC(1000));
				touch_irq_flag = false;
				if (!tch_touched()) {
					sleep_armed = true; /* released */
				} else if (sleep_armed) {
					alarm_stop();
					wake_display();
					continue;
				}
				alarm_service(); /* fire due alarms */
				if (alarm_ringing) {
					idle_blank = false;
					(void)gc9307_panel_state(disp, 1);
					(void)display_set_brightness(
						disp, brightness);
					display_on = true;
					battery_poll(); /* lux + AUTO bri */
					clock_last_min =
						(epoch_now() / 60U) %
						(24U * 60U);
					draw_idle_face();
					LOG_INF("sleep: alarm -> idle face");
				} else {
					sid_check_end(); /* SIDs advance */
				}
				continue;
			}
			/* fallback: dark panel outside idle */
			(void)k_sem_take(&touch_sem, K_MSEC(5000));
			touch_irq_flag = false;
			if (tch_touched()) {
				alarm_stop();
				wake_display();
			}
			/* keep the clock guard baseline warm (no display
			 * updates run in this state) */
			(void)epoch_now();
			continue;
		}

		if (idle_mode) {
			/*
			 * The FT3168 INT gives the semaphore and wakes the
			 * thread immediately; 1 s timeout is the fallback.
			 * A status read confirms a real finger so spurious
			 * edges cannot exit idle.
			 */
			(void)k_sem_take(&touch_sem, K_MSEC(1000));
			touch_irq_flag = false;
			if (tch_touched()) {
				alarm_stop(); /* touch silences a ringing alarm */
				exit_idle();
				continue;
			}
			alarm_service(); /* fire due alarms (idle only) */

			/* lux + orientation check every 15 s (the accel is
			 * awake ~20 ms per check - negligible energy).
			 * Unsigned modular delta: the uptime base is large
			 * (GRTC keeps counting across warm resets), so a
			 * signed cast would never fire. */
			if (k_uptime_get_32() - t_idlechk >= 15000U) {
				int rot = -1;

				t_idlechk = k_uptime_get_32();
				if (auto_rot) {
					rot = accel_orientation();
				}
				accel_suspend();
				battery_poll(); /* lux + ambient profile */
				if ((rot >= 0 && rot != idle_rot) ||
				    idle_night() != idle_night_last) {
					/* device turned or light profile
					 * changed: re-lay the whole face */
					if (rot >= 0) {
						idle_rot = rot;
						LOG_INF("idle face rot %d (quad %u)",
							idle_rot, idle_quad);
					}
					audio_dbg_byte(18,
						       (uint8_t)idle_rot);
					audio_dbg_byte(19, idle_quad);
					draw_idle_face();
				}
			}
			if (clock_tick()) {
				audio_dbg_byte(18, (uint8_t)idle_rot);
				audio_dbg_byte(19, idle_quad);
				batt_move_random();
				if (!idle_night()) {
					draw_battery();
				}
				draw_clock_random();
			}
			sid_check_end(); /* auto-advance keeps running idle */
			continue;
		}

		touch_poll();

		/* keep the header clock/date current */
		if (clock_tick()) {
			redraw_clock();
		}

		/* auto idle after the configured timeout; countdown bar */
		uint32_t elapsed = k_uptime_get_32() - last_touch_ms;

		if (elapsed >= (uint32_t)idle_timeout_s * 1000U) {
			enter_idle();
			t_idlechk = k_uptime_get_32(); /* first poll 15 s in */
			continue;
		}
		if ((k_uptime_get_32() / 1000U) != countdown_second) {
			countdown_second = k_uptime_get_32() / 1000U;
			draw_countdown(elapsed);
		}

		if (k_uptime_get_32() - t_acc > 200U) {
			t_acc = k_uptime_get_32();
			if (ui_scr == SCR_SENSORS) {
				show_accel();
			}
		}

		/* AUTO ROT: follow the orientation between the two landscape
		 * mappings, also in the normal UI */
		if (auto_rot && (k_uptime_get_32() - t_autorot > 2000U)) {
			int r;

			t_autorot = k_uptime_get_32();
			r = accel_ui_rot();
			if ((r == 0 && rot_270) || (r == 2 && !rot_270)) {
				rot_270 = (r == 2);
				LOG_INF("auto rot -> %s (quad %u)",
					rot_270 ? "270" : "90", idle_quad);
				draw_ui();
			}
		}

		/* persist edited ambient profiles / alarms (throttled) */
		if ((bri_cfg_dirty || alm_cfg_dirty) &&
		    (k_uptime_get_32() - t_bricfg > 3000U)) {
			t_bricfg = k_uptime_get_32();
			if (bri_cfg_dirty) {
				bri_cfg_dirty = false;
				bri_cfg_save();
			}
			if (alm_cfg_dirty) {
				alm_cfg_dirty = false;
				alm_cfg_save();
			}
		}

		/* keep the persisted wall clock fresh (every 30 min) */
		if (k_uptime_get_32() - t_timecfg > 1800000U) {
			t_timecfg = k_uptime_get_32();
			time_cfg_save();
		}

		/* repaint the SID screens if playback changed elsewhere
		 * (e.g. the BLE debug commands) and the BLE mode button if
		 * it was changed over BLE */
		if (k_uptime_get_32() - t_sidui > 300U) {
			t_sidui = k_uptime_get_32();
			sid_check_end();
			sid_ui_sync();
			ble_ui_sync();
		}

		if (k_uptime_get_32() - t_batt > 2000U) {
			t_batt = k_uptime_get_32();
			battery_poll();
		}

#ifdef SIDCLOCK_DEBUG
		/* periodic view of what the bootloader ought to see (bench
		 * only: in a release image this fills the ~2 KB log buffer
		 * with two lines every five seconds and hides everything
		 * else) */
		if (k_uptime_get_32() - t_dump > 5000U) {
			t_dump = k_uptime_get_32();
			trailer_dump(FIXED_PARTITION_ID(slot0_partition), "slot0");
			trailer_dump(FIXED_PARTITION_ID(slot1_partition), "slot1");
		}
#endif

		k_sleep(K_MSEC(100));
	}

	return 0;
}
