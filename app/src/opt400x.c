/*
 * opt400x.c — TI OPT3007 / OPT4001 ambient light sensor driver.
 *
 * Supports both parts, auto-detected at probe:
 *   - read 0x7E == 0x5449 ("TI" manufacturer ID)
 *   - read 0x11 == 0x0121 -> OPT4001 -> write reg 0x0A |= 0x3238
 *   - else read 0x7F == 0x3001 -> OPT3007 -> write reg 0x01 |= 0x0600
 *
 * All registers are 16-bit big-endian. Lux is converted with the full
 * datasheet formula (mantissa * 2^exponent * 437.5e-6 for the SOT-5x3
 * package) and returned as sensor_value microlux.
 *
 * I2C: TWIM30, address 0x45.
 */

#define DT_DRV_COMPAT sidclock_opt4001

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(sidclock_opt4001, CONFIG_SENSOR_LOG_LEVEL);

#define OPT_MFR_ID        0x7E /* manufacturer ID ("TI" = 0x5449) */
#define OPT_DEV_ID        0x11 /* device ID (OPT4001 = 0x0121)    */
#define OPT_DEV_ID_ALT    0x7F /* device ID (OPT3007 = 0x3001)    */
#define OPT_RESULT        0x00 /* result register                 */
#define OPT_CONFIG        0x01 /* OPT300x configuration           */
#define OPT_CONFIG_4001   0x0A /* OPT4001 configuration           */

enum opt_type {
	OPT_TYPE_3007 = 0,
	OPT_TYPE_4001 = 1,
	OPT_TYPE_UNKNOWN = 2,
};

struct opt_config {
	struct i2c_dt_spec i2c;
};

struct opt_data {
	/* last measurement in millilux (1e-3 lx) */
	int32_t mlux;
};

/* Runtime part type (single global in the original, RAM 0x200068B0) */
static enum opt_type opt_part;
static bool opt_logged;

/* ------------------------------------------------------------------ */
/* Big-endian 16-bit register access                                   */
/* ------------------------------------------------------------------ */

static int opt_read16(const struct device *dev, uint8_t reg, uint16_t *val)
{
	const struct opt_config *cfg = dev->config;
	uint8_t buf[2];
	int ret;

	ret = i2c_write_read_dt(&cfg->i2c, &reg, 1, buf, sizeof(buf));
	if (ret) {
		return ret;
	}
	*val = ((uint16_t)buf[0] << 8) | buf[1];
	return 0;
}

static int opt_write16(const struct device *dev, uint8_t reg, uint16_t val)
{
	const struct opt_config *cfg = dev->config;
	uint8_t buf[3] = { reg, (uint8_t)(val >> 8), (uint8_t)val };

	return i2c_write_dt(&cfg->i2c, buf, sizeof(buf));
}

static int opt_update16(const struct device *dev, uint8_t reg, uint16_t value,
			uint16_t mask)
{
	uint16_t old;
	int ret;

	ret = opt_read16(dev, reg, &old);
	if (ret) {
		return ret;
	}
	return opt_write16(dev, reg, (uint16_t)((old & ~mask) | (value & mask)));
}

/* ------------------------------------------------------------------ */
/* Probe / configuration                                               */
/* ------------------------------------------------------------------ */

static int opt_probe(const struct device *dev)
{
	const struct opt_config *cfg = dev->config;
	uint16_t id;
	int ret;

	if (!i2c_is_ready_dt(&cfg->i2c)) {
		LOG_ERR("I2C controller device not ready");
		return -ENODEV;
	}

	/* Manufacturer must be TI */
	ret = opt_read16(dev, OPT_MFR_ID, &id);
	if (ret || id != 0x5449) {
		LOG_ERR("als read err: %d", ret);
		return -EIO;
	}
	opt_part = OPT_TYPE_3007;

	ret = opt_read16(dev, OPT_DEV_ID, &id);
	if (ret) {
		return -EIO;
	}
	if (id == 0x0121) {
		opt_part = OPT_TYPE_4001;
	}

	switch (opt_part) {
	case OPT_TYPE_4001:
		/* Observed: reg 0x0A |= 0x3238 */
		return opt_update16(dev, OPT_CONFIG_4001, 0xFFFF, 0x3238);

	case OPT_TYPE_3007:
		ret = opt_read16(dev, OPT_DEV_ID_ALT, &id);
		if (ret || id != 0x3001) {
			opt_part = OPT_TYPE_UNKNOWN;
			return -ENOTSUP;
		}
		/* Observed: reg 0x01 |= 0x0600 (continuous mode) */
		ret = opt_update16(dev, OPT_CONFIG, 0x0600, 0x0600);
		if (ret) {
			return ret;
		}
		/* Full-scale range selection stays automatic (RN = 1100b) */
		return opt_update16(dev, OPT_CONFIG, 0xC000, 0xF000);

	default:
		return -ENOTSUP;
	}
}

/* ------------------------------------------------------------------ */
/* sensor_driver_api                                                   */
/* ------------------------------------------------------------------ */

/* sensor_driver_api.sample_fetch */
static int opt_sample_fetch(const struct device *dev,
			    enum sensor_channel chan)
{
	const struct opt_config *cfg = dev->config;
	struct opt_data *data = dev->data;
	uint16_t r0;
	int ret;

	if (chan != SENSOR_CHAN_LIGHT && (int)chan != 0x3F) {
		/* original asserts in sidclock_opt4001.c line 0x76 */
		return -ENOTSUP;
	}

	if (opt_part == OPT_TYPE_3007) {
		uint32_t mant;

		ret = opt_read16(dev, OPT_RESULT, &r0);
		if (ret) {
			return ret;
		}
		/* datasheet: lux = mantissa * 2^exponent * 0.01 -> mlx */
		mant = (uint32_t)(r0 & 0xFFF) << (r0 >> 12);
		data->mlux = (int32_t)(mant * 10U);
		return 0;
	}

	if (opt_part == OPT_TYPE_4001) {
		/*
		 * Registers 0x00..0x02 form one result burst: MSB, LSB, CRC.
		 * The MSB word carries EXPONENT in bits 15-12 and the top 12
		 * mantissa bits in 11-0; the LSB word carries mantissa[7:0]
		 * in its top byte.
		 */
		uint8_t buf[3];
		uint8_t reg = OPT_RESULT;
		uint32_t mant, e, mlux;

		ret = i2c_write_read_dt(&cfg->i2c, &reg, 1, buf, sizeof(buf));
		if (ret) {
			return -EIO;
		}

		r0 = ((uint16_t)buf[0] << 8) | buf[1];
		mant = ((uint32_t)(r0 & 0xFFF) << 8) | (uint32_t)buf[2];
		e = (r0 >> 12) & 0xF;
		/* 437.5e-6 lx per code, i.e. 7/16 mlx */
		mlux = ((mant << e) * 7U) / 16U;
		data->mlux = (int32_t)mlux;

		if (!opt_logged) {
			opt_logged = true;
			LOG_INF("OPT4001: E=%u mantissa=%u -> %u mlx",
				(unsigned int)e, (unsigned int)mant,
				(unsigned int)mlux);
		}
		return 0;
	}

	return 0;
}

/* sensor_driver_api.channel_get */
static int opt_channel_get(const struct device *dev,
			   enum sensor_channel chan,
			   struct sensor_value *val)
{
	struct opt_data *data = dev->data;
	int32_t mlux;

	(void)dev;

	if (chan != SENSOR_CHAN_LIGHT) {
		return -ENOTSUP;
	}
	if (opt_part != OPT_TYPE_3007 && opt_part != OPT_TYPE_4001) {
		return -ENOTSUP;
	}

	mlux = data->mlux;
	val->val1 = mlux / 1000;
	val->val2 = (mlux % 1000) * 1000; /* microlux */
	return 0;
}

/* ------------------------------------------------------------------ */
/* Initialization                                                      */
/* ------------------------------------------------------------------ */

/* device init -> probe */
static int opt_init(const struct device *dev)
{
	int ret = opt_probe(dev);

	/* Unknown part is tolerated (driver stays idle) */
	return (ret < 0) ? ret : 0;
}

/*
 * Conversion time control (the CT button on the demo's button rows):
 *   OPT4001: reg 0x0A bits 9-6, 0 = 600 us ... 8 = 100 ms, 11 = 800 ms
 *   OPT300x: reg 0x01 bit 11, 0 = 100 ms, 1 = 800 ms
 */
int opt400x_set_conversion_time(const struct device *dev, uint8_t ct)
{
	if (ct > 11U) {
		return -EINVAL;
	}

	if (opt_part == OPT_TYPE_4001) {
		return opt_update16(dev, OPT_CONFIG_4001, (uint16_t)ct << 6,
				    0x03C0U);
	}
	if (opt_part == OPT_TYPE_3007) {
		uint16_t v = (ct >= 10U) ? 0x0800U : 0x0000U;

		return opt_update16(dev, OPT_CONFIG, v, 0x0800U);
	}

	return -ENOTSUP;
}

/* Current conversion time in ms (100 or 800), or a negative errno. */
int opt400x_get_conversion_time(const struct device *dev)
{
	uint16_t v;
	int ret;

	if (opt_part == OPT_TYPE_4001) {
		ret = opt_read16(dev, OPT_CONFIG_4001, &v);
		if (ret) {
			return ret;
		}
		return (((v >> 6) & 0xF) >= 10U) ? 800 : 100;
	}
	if (opt_part == OPT_TYPE_3007) {
		ret = opt_read16(dev, OPT_CONFIG, &v);
		if (ret) {
			return ret;
		}
		return (v & 0x0800U) ? 800 : 100;
	}

	return -ENOTSUP;
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

static const struct sensor_driver_api opt_api = {
	.attr_set = NULL,
	.attr_get = NULL,
	.trigger_set = NULL,
	.sample_fetch = opt_sample_fetch,
	.channel_get = opt_channel_get,
};

#define OPT_INIT(inst)								\
	static struct opt_data opt_data_##inst;					\
										\
	static const struct opt_config opt_config_##inst = {			\
		.i2c = I2C_DT_SPEC_INST_GET(inst),				\
	};									\
										\
	DEVICE_DT_INST_DEFINE(inst, opt_init, NULL,				\
			      &opt_data_##inst, &opt_config_##inst,		\
			      POST_KERNEL, CONFIG_SENSOR_INIT_PRIORITY,		\
			      &opt_api);

DT_INST_FOREACH_STATUS_OKAY(OPT_INIT)

/*
 * Devicetree example:
 *
 *   opt4001: als_if@45 {
 *           compatible = "sidclock,opt4001";
 *           reg = <0x45>;
 *   };
 */
