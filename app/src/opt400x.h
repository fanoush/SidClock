/*
 * opt400x.h - extra controls for the reconstructed OPT4001/OPT300x
 *                   ambient light sensor driver.
 */
#ifndef SAPHE_OPT400X_H_
#define SAPHE_OPT400X_H_

#include <zephyr/device.h>

/*
 * Set the conversion time (the CT toggle on the demo's button rows):
 *   OPT4001: reg 0x0A bits 9-6, ct 0 = 600 us ... 8 = 100 ms, 11 = 800 ms
 *   OPT300x: reg 0x01 bit 11,  ct >= 10 = 800 ms, otherwise 100 ms
 * Longer integration = finer low-light resolution, slower updates.
 */
int opt400x_set_conversion_time(const struct device *dev, uint8_t ct);

/* Current conversion time in ms (100 or 800), or a negative errno. */
int opt400x_get_conversion_time(const struct device *dev);

#endif /* SAPHE_OPT400X_H_ */
