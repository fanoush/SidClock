/*
 * display_gc9307.c — SPI panel driver for the 368x448 AMOLED/LCD display
 *                    (SH8601-class and GC9307 panels).
 *
 * The panel is driven with QSPI-style framing over SPIM (no D/C pin): every
 * transfer is prefixed with a 4-byte header (0x02 0x00 <cmd> 0x00) and the
 * panel is selected by CS index 1 of the SPI controller's cs-gpios. The
 * driver implements the Zephyr display API (write, blanking, brightness,
 * orientation) plus panel_state() for the power states used by the UI:
 * 0 = off/sleep-in, 1 = full reset + re-init, 2 = standby.
 *
 * Hardware:
 *   - Panel: 368x448, RGB565, SPIM00 at 32 MHz.
 *   - Reset: P0.04 (active low).
 *   - Panel power enable: P0.02 (plain GPIO, driven high at init).
 *
 * Panel revisions differ (AMOLED vs LCD, two vendor variants); the init
 * sequence below matches this hardware. See docs/hardware.md for variants.
 */

#define DT_DRV_COMPAT sidclock_gc9307

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/display.h>
#include <zephyr/logging/log.h>

#include "display_gc9307.h"

LOG_MODULE_REGISTER(sidclock_gc9307, CONFIG_DISPLAY_LOG_LEVEL);

/* Fill-screen geometry (92-pixel column bands) */
#define GC9307_FILL_BAND_WIDTH   0x5CU /* 92 pixels per column band           */
#define GC9307_FILL_CHUNK_SIZE   0x170U/* 368 bytes = 2 rows x 92 px x 2 bytes */
#define GC9307_FILL_ROW_STEP     2U    /* rows written per window              */
#define GC9307_FILL_ROWS         0x1C0U/* 448 rows in total                    */

/* Delay values observed in the binary (k_sleep() argument, in ticks) */
#define GC9307_DELAY_RESET_MS     0x291U /* 657 ticks ~ 20.0 ms */
#define GC9307_DELAY_POWER_MS     0x1D5U /* 469 ticks ~ 14.3 ms */
#define GC9307_DELAY_SLEEP_OUT    0xC35U /* 3125 ticks ~ 95.4 ms */
#define GC9307_DELAY_PANEL_OFF    0x139U /* 313 ticks ~ 9.6 ms */

struct gc9307_config {
	/* SPI bus + config + CS (CS index 1 on the shared SPIM00) */
	struct spi_dt_spec spi;
	/* Panel reset line (P0.04) */
	struct gpio_dt_spec reset;
	/* Panel geometry (368x448) */
	uint16_t width;  /* 0x170 = 368 */
	uint16_t height; /* 0x1C0 = 448 */
};

struct gc9307_data {
	uint16_t x_offset;   /* added to every window X (0 in the original) */
	uint16_t y_offset;   /* added to every window Y (0 in the original) */
	uint8_t brightness;  /* last brightness written via cmd 0x51 */
	uint8_t orientation; /* enum display_orientation, stored only */
	uint8_t rotation;    /* last MADCTL rotation (enum gc9307_rotation) */
};

/* Forward declarations (panel_state is referenced from outside this file) */
static int gc9307_init(const struct device *dev);
int gc9307_panel_state(const struct device *dev, int state);

/* ---------------------------------------------------------------- */
/* Low level transport                                              */
/* ---------------------------------------------------------------- */

/* Low-level transfer on the panel bus */
static int gc9307_spi_tx(const struct gc9307_config *config,
			 const struct spi_buf_set *tx)
{
	return spi_transceive(config->spi.bus, &config->spi.config, tx, NULL);
}

/*
 * Send one command frame:
 *   buffer 0: 02 00 <cmd> 00     (QSPI-style write opcode + command)
 *   buffer 1: <data>, len bytes  (optional)
 * The frame is repeated `repeat` times when needed (used for the 0x3C
 * "memory write continue" path).
 */
static int gc9307_write_bufs(const struct device *dev, uint8_t cmd,
			     const void *data, size_t len, uint32_t repeat)
{
	const struct gc9307_config *config = dev->config;
	uint8_t header[4] = {0x02U, 0x00U, cmd, 0x00U};
	struct spi_buf bufs[2] = {
		{ .buf = header,       .len = sizeof(header) },
		{ .buf = (void *)data, .len = len            },
	};
	struct spi_buf_set tx = { .buffers = bufs, .count = ARRAY_SIZE(bufs) };
	int ret = 0;

	do {
		ret = gc9307_spi_tx(config, &tx);
	} while (--repeat > 0U);

	return ret;
}

static int gc9307_write_cmd(const struct device *dev, uint8_t cmd,
			    const void *data, size_t len)
{
	return gc9307_write_bufs(dev, cmd, data, len, 1U);
}

/*
 * Set the column (0x2A) and row (0x2B) address window.
 * Both coordinates are byteswapped to big-endian before transmission.
 */
static int gc9307_set_window(const struct device *dev, uint16_t x, uint16_t y,
			     uint16_t width, uint16_t height)
{
	const struct gc9307_data *data = dev->data;
	uint16_t x0 = x + data->x_offset;
	uint16_t x1 = x0 + width - 1U;
	uint16_t y0 = y + data->y_offset;
	uint16_t y1 = y0 + height - 1U;
	uint8_t buf[4];

	buf[0] = (uint8_t)(x0 >> 8);
	buf[1] = (uint8_t)x0;
	buf[2] = (uint8_t)(x1 >> 8);
	buf[3] = (uint8_t)x1;
	gc9307_write_cmd(dev, 0x2AU, buf, sizeof(buf));

	buf[0] = (uint8_t)(y0 >> 8);
	buf[1] = (uint8_t)y0;
	buf[2] = (uint8_t)(y1 >> 8);
	buf[3] = (uint8_t)y1;
	return gc9307_write_cmd(dev, 0x2BU, buf, sizeof(buf));
}

/* ---------------------------------------------------------------- */
/* display_driver_api                                               */
/* ---------------------------------------------------------------- */

/* display_driver_api.write */
static int gc9307_write(const struct device *dev, const uint16_t x,
			const uint16_t y,
			const struct display_buffer_descriptor *desc,
			const void *buf)
{
	gc9307_set_window(dev, x, y, desc->width, desc->height);

	if (desc->pitch == 0U) {
		/* Tightly packed frame: one 0x2C transfer, RGB565 bytes */
		uint32_t bytes = (uint32_t)desc->width * desc->height * 2U;

		return gc9307_write_bufs(dev, 0x2CU, buf, bytes, 1U);
	}

	/*
	 * Row-wise path (pitch != 0): first row with 0x2C, then 0x3C
	 * ("memory write continue") repeated height-1 times with the same
	 * row buffer (pitch == 0 in practice).
	 */
	gc9307_write_bufs(dev, 0x2CU, buf, (uint32_t)desc->width * 2U, 1U);

	if (desc->height > 1U) {
		return gc9307_write_bufs(dev, 0x3CU, buf,
					 (uint32_t)desc->width * 2U,
					 desc->height - 1U);
	}

	return 0;
}

/* blanking is not supported by this panel */
static int gc9307_blanking_on(const struct device *dev)
{
	ARG_UNUSED(dev);
	return -ENOTSUP;
}

static int gc9307_blanking_off(const struct device *dev)
{
	ARG_UNUSED(dev);
	return -ENOTSUP;
}

/* reading back the panel is not supported */
static int gc9307_read(const struct device *dev, const uint16_t x,
		       const uint16_t y,
		       const struct display_buffer_descriptor *desc, void *buf)
{
	ARG_UNUSED(dev); ARG_UNUSED(x); ARG_UNUSED(y);
	ARG_UNUSED(desc); ARG_UNUSED(buf);
	return -ENOTSUP;
}

/* no framebuffer: the UI writes directly to the panel */
static void *gc9307_get_framebuffer(const struct device *dev)
{
	ARG_UNUSED(dev);
	return NULL;
}

/* brightness: cmd 0x51 + one data byte */
static int gc9307_set_brightness(const struct device *dev, uint8_t brightness)
{
	struct gc9307_data *data = dev->data;

	data->brightness = brightness;
	return gc9307_write_cmd(dev, 0x51U, &brightness, 1U);
}

/*
 * "Contrast" is implemented as a brightness offset:
 *   contrast == 0 -> re-send stored brightness
 *   contrast != 0 -> send stored brightness + 0x64, or - 0x64 if > 0x9A
 */
static int gc9307_set_contrast(const struct device *dev, uint8_t contrast)
{
	struct gc9307_data *data = dev->data;
	uint8_t value = data->brightness;

	if (contrast != 0U) {
		value = (value > 0x9AU) ? (uint8_t)(value - 0x64U)
					: (uint8_t)(value + 0x64U);
	}

	return gc9307_write_cmd(dev, 0x51U, &value, 1U);
}

/* orientation is stored in driver data (software rotation in the app) */
static int gc9307_set_orientation(const struct device *dev,
				  const enum display_orientation orientation)
{
	struct gc9307_data *data = dev->data;

	data->orientation = (uint8_t)orientation;
	return 0;
}

/*
 * Hardware rotation: 0x36 (MADCTL) swaps the column/row address space and
 * mirrors axes, so a 368x448 panel can be addressed as 448x368 landscape
 * without touching pixel data.
 */
static const uint8_t gc9307_madctl[4] = {
	0x00U, /* 0 deg                 */
	0x60U, /* 90 deg  (MV|MX)       */
	0xC0U, /* 180 deg (MX|MY)       */
	0xA0U, /* 270 deg (MV|MY)       */
};

int gc9307_set_rotation(const struct device *dev, enum gc9307_rotation rotation)
{
	struct gc9307_data *data = dev->data;
	uint8_t value = gc9307_madctl[(uint8_t)rotation & 0x03U];
	int rc = gc9307_write_cmd(dev, 0x36U, &value, 1U);

	if (rc == 0) {
		data->rotation = (uint8_t)rotation;
	}
	return rc;
}

/* 0x39 idle on / 0x38 idle off (reduced color expression). */
int gc9307_set_idle(const struct device *dev, bool on)
{
	return gc9307_write_cmd(dev, on ? 0x39U : 0x38U, NULL, 0U);
}

/* 0x49 AOD on / 0x48 AOD off (SH8601 always-on display mode). */
int gc9307_set_aod(const struct device *dev, bool on)
{
	return gc9307_write_cmd(dev, on ? 0x49U : 0x48U, NULL, 0U);
}

/*
 * Experimental frame-rate control. The GC9xxx family uses 0xE8 with a
 * "frame rate" parameter; SH8601 does not document a host-visible frame-rate
 * register, so on AMOLED units this is most likely ignored. Level 0 sends
 * the common default seen in GC9A01 inits, levels 1..4 step the division
 * parameter up (slower refresh).
 */
static const uint8_t gc9307_fr_table[5] = { 0x34U, 0x38U, 0x3CU, 0x3EU, 0x3FU };

int gc9307_set_frame_rate(const struct device *dev, uint8_t level)
{
	uint8_t value;

	if (level > 4U) {
		return -EINVAL;
	}
	value = gc9307_fr_table[level];
	return gc9307_write_cmd(dev, 0xE8U, &value, 1U);
}

/* display capabilities */
static void gc9307_get_capabilities(const struct device *dev,
				    struct display_capabilities *caps)
{
	const struct gc9307_config *config = dev->config;
	const struct gc9307_data *data = dev->data;

	memset(caps, 0, sizeof(*caps));
	caps->current_orientation = (enum display_orientation)data->orientation;

	/* Exactly as in the binary: normal/180 report HxW, 90/270 report WxH */
	if (data->orientation == DISPLAY_ORIENTATION_NORMAL ||
	    data->orientation == DISPLAY_ORIENTATION_ROTATED_180) {
		caps->x_resolution = config->height;
		caps->y_resolution = config->width;
	} else {
		caps->x_resolution = config->width;
		caps->y_resolution = config->height;
	}

	caps->supported_pixel_formats = PIXEL_FORMAT_RGB_565;
	caps->current_pixel_format = PIXEL_FORMAT_RGB_565;
	caps->screen_info = 0U;
}

/* pixel format: RGB565 only */
static int gc9307_set_pixel_format(const struct device *dev,
				   const enum display_pixel_format format)
{
	ARG_UNUSED(dev);
	if (format == PIXEL_FORMAT_RGB_565) {
		return 0;
	}
	LOG_ERR("Pixel format change not implemented");
	return -ENOTSUP;
}

/* ---------------------------------------------------------------- */
/* Panel initialization                                             */
/* ---------------------------------------------------------------- */

/* Clear the whole panel with black RGB565 pixels */
static void gc9307_clear_screen(const struct device *dev)
{
	uint8_t line[GC9307_FILL_CHUNK_SIZE];

	memset(line, 0, sizeof(line));

	for (uint16_t y = 0U; y < GC9307_FILL_ROWS; y += GC9307_FILL_ROW_STEP) {
		for (uint16_t x = 0U; x < 368U; x += GC9307_FILL_BAND_WIDTH) {
			gc9307_set_window(dev, x, y, GC9307_FILL_BAND_WIDTH,
					  GC9307_FILL_ROW_STEP);
			gc9307_write_bufs(dev, 0x2CU, line, sizeof(line), 1U);
		}
	}
}

/* Panel command initialization (runs after reset + power-up) */
static int gc9307_panel_init(const struct device *dev)
{
	struct gc9307_data *data = dev->data;
	uint8_t value;

	/* Sleep out, then wait for the panel to become ready */
	gc9307_write_cmd(dev, 0x11U, NULL, 0U);
	k_sleep(K_TICKS(GC9307_DELAY_SLEEP_OUT));

	/* Inter-register / command page enable */
	value = 0x00U;
	gc9307_write_cmd(dev, 0xFEU, &value, 1U);

	/* Panel specific control */
	value = 0x80U;
	gc9307_write_cmd(dev, 0xC4U, &value, 1U);

	/* Blank while clearing */
	value = 0x00U;
	gc9307_write_cmd(dev, 0x51U, &value, 1U);

	/* Pixel format: RGB565 */
	value = 0x55U;
	gc9307_write_cmd(dev, 0x3AU, &value, 1U);

	/* Full black frame */
	gc9307_clear_screen(dev);

	/* Display on */
	gc9307_write_cmd(dev, 0x29U, NULL, 0U);

	/* Driver state, then final brightness */
	data->orientation = DISPLAY_ORIENTATION_NORMAL;
	data->rotation = (uint8_t)GC9307_ROT_0;
	data->brightness = 0x80U;
	value = 0x80U;
	gc9307_write_cmd(dev, 0x51U, &value, 1U);

	return 0;
}

/*
 * Panel power states, exported for the UI:
 *   0 -> display off  (0x28, 0x10)
 *   1 -> full (re-)initialization (same as device init)
 *   2 -> display off + 0x4F/0x01 deep standby
 */
int gc9307_panel_state(const struct device *dev, int state)
{
	uint8_t standby = 0x01U;

	switch (state) {
	case 0:
		gc9307_write_cmd(dev, 0x28U, NULL, 0U);
		k_sleep(K_TICKS(GC9307_DELAY_PANEL_OFF));
		gc9307_write_cmd(dev, 0x10U, NULL, 0U);
		k_sleep(K_TICKS(GC9307_DELAY_PANEL_OFF));
		return 0;

	case 1:
		return gc9307_init(dev);

	case 2:
		gc9307_write_cmd(dev, 0x28U, NULL, 0U);
		k_sleep(K_TICKS(GC9307_DELAY_PANEL_OFF));
		gc9307_write_cmd(dev, 0x10U, NULL, 0U);
		k_sleep(K_TICKS(GC9307_DELAY_PANEL_OFF));
		gc9307_write_cmd(dev, 0x4FU, &standby, 1U);
		return 0;

	default:
		return -ENOTSUP;
	}
}

/*
 * Device init: reset pulse, panel power enable, panel command init.
 *   1. check SPI + reset GPIO ready
 *   2. configure reset as output
 *   3. reset = 1, sleep ~20 ms
 *   4. drive P0.02 high (panel power enable)
 *   5. sleep ~14 ms
 *   6. reset = 0, sleep ~14 ms
 *   7. panel command init
 */
static int gc9307_init(const struct device *dev)
{
	const struct gc9307_config *config = dev->config;

	if (!spi_is_ready_dt(&config->spi)) {
		LOG_ERR("SPI device not ready");
		return -ENODEV;
	}

	if (config->reset.port != NULL) {
		if (!gpio_is_ready_dt(&config->reset)) {
			LOG_ERR("Reset GPIO device not ready");
			return -ENODEV;
		}
		if (gpio_pin_configure_dt(&config->reset,
					  GPIO_OUTPUT_ACTIVE) != 0) {
			LOG_ERR("Couldn't configure reset pin");
			return -EIO;
		}

		gpio_pin_set_dt(&config->reset, 1);
	}
	k_sleep(K_TICKS(GC9307_DELAY_RESET_MS));

	/* Panel power enable: P0.02 (not present in the original DT) */
	{
		const struct device *p0 = DEVICE_DT_GET(DT_NODELABEL(gpio0));

		if (device_is_ready(p0)) {
			gpio_pin_configure(p0, 2, GPIO_OUTPUT_ACTIVE);
			gpio_pin_set(p0, 2, 1);
		}
	}

	k_sleep(K_TICKS(GC9307_DELAY_POWER_MS));

	if (config->reset.port != NULL) {
		gpio_pin_set_dt(&config->reset, 0);
	}
	k_sleep(K_TICKS(GC9307_DELAY_POWER_MS));

	/* The binary discards the panel init status and returns 0 */
	(void)gc9307_panel_init(dev);
	return 0;
}

/* ---------------------------------------------------------------- */
/* Driver registration                                              */
/* ---------------------------------------------------------------- */

static const struct display_driver_api gc9307_api = {
	.blanking_on = gc9307_blanking_on,
	.blanking_off = gc9307_blanking_off,
	.write = gc9307_write,
	.read = gc9307_read,
	.get_framebuffer = gc9307_get_framebuffer,
	.set_brightness = gc9307_set_brightness,
	.set_contrast = gc9307_set_contrast,
	.get_capabilities = gc9307_get_capabilities,
	.set_pixel_format = gc9307_set_pixel_format,
	.set_orientation = gc9307_set_orientation,
};

/*
 * Example devicetree node:
 *
 *   amo_disp: amo_disp@1 {
 *           compatible = "sidclock,gc9307";
 *           reg = <1>;                       // CS index 1 on SPIM00
 *           spi-max-frequency = <32000000>;
 *           reset-gpios = <&gpio0 4 GPIO_ACTIVE_HIGH>;
 *           width  = <368>;
 *           height = <448>;
 *   };
 */
#define GC9307_INIT(inst)							\
	static struct gc9307_data gc9307_data_##inst;				\
										\
	static const struct gc9307_config gc9307_config_##inst = {		\
		.spi = SPI_DT_SPEC_INST_GET(inst, SPI_WORD_SET(8), 0),		\
		.reset = GPIO_DT_SPEC_INST_GET(inst, reset_gpios),		\
		.width = DT_INST_PROP(inst, width),				\
		.height = DT_INST_PROP(inst, height),				\
	};									\
										\
	DEVICE_DT_INST_DEFINE(inst, gc9307_init, NULL,				\
			      &gc9307_data_##inst, &gc9307_config_##inst,	\
			      POST_KERNEL, CONFIG_DISPLAY_INIT_PRIORITY,	\
			      &gc9307_api);

DT_INST_FOREACH_STATUS_OKAY(GC9307_INIT)
