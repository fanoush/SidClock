/*
 * audio.c - I2S speaker output for the SidClock.
 *
 * Engine: direct register writes, polled double buffering:
 *
 *   - two EasyDMA buffers refilled by a polled service thread
 *     (EVENTS_TXPTRUPD), like the DOOM-port audio service
 *   - mute = send zeros; the stream is never stopped just for muting
 *   - MCKFREQ is a 32-bit fraction of 32 MHz, RATIO stays 64X
 *   - pins driven as outputs before PSEL is handed to the peripheral
 *
 * POWER: a class-D amp fed a continuous bit clock never enters its
 * auto-shutdown, so after ~30 s without any sound the whole stream is
 * stopped (TASKS_STOP, ENABLE=0) and the amplifier shuts down with it.
 * The next click/beep/alarm restarts it in a few milliseconds.
 *
 * THE ONE BOARD GOTCHA - AND WHY THE AMP WAS SILENT FOR SO LONG:
 * the DK default console UART (UARTE20) is mapped to P1.04 (TX), P1.05 (RX),
 * P1.06 (RTS) and P1.07 (CTS) - exactly the amplifier pins - and MCUboot
 * brings it up before the app runs. Its TX then holds P1.04 high and its RTS
 * holds P1.06 (the I2S SDOUT pad!) low, so the I2S clocked and consumed
 * buffers perfectly while no data ever reached the amp. audio_init() shuts
 * UARTE20 down and releases its pins before the I2S claims them.
 *
 * Variant: AW88082 - SCK P1.05, LRCK P1.07, SDOUT P1.06, 32-bit samples on
 * the left channel only, 22050 Hz. P1.04 is the amplifier enable pin,
 * driven high.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>
#include <hal/nrf_i2s.h>
#include <hal/nrf_clock.h>
#include <hal/nrf_gpio.h>
#include <hal/nrf_uarte.h>

#include <string.h>

#include "audio.h"
#include "sid_player.h"

LOG_MODULE_REGISTER(audio, LOG_LEVEL_INF);

#define I2S_REGS ((NRF_I2S_Type *)0x500DD000UL)

/*
 * The MCKFREQ fraction is applied to this effective source clock. Empirically
 * calibrated on this board (via the SID player's frame counter as a rate
 * meter: a nominal 22050 Hz request produced an actual 15002 Hz frame clock,
 * k = 0.6804) - 32 MHz * 0.6804 = 21.77 MHz.
 */
#define I2S_SRC_HZ 32000000ULL
#define RATIO_N 64U

/*
 * True frame clock for a requested rate, measured host-timed through the
 * EasyDMA buffer-boundary counter: the hardware runs close to the request
 * but ~4.3% high on this unit (22.05 kHz request -> 22.99 kHz observed).
 * All synthesis and the SID emulator compute in terms of this true rate.
 *
 * NOTE: an earlier "2/3 of the request" reading was an artifact - the SID
 * renderer was too slow to refill in time, so the boundary counter saw only
 * one switch per refill instead of one per buffer.
 */
#define HW_RATE_NUM 23000U
#define HW_RATE_DEN 22050U

#define AUDIO_RATE_HZ 22050U
#define AUDIO_FRAMES 320U /* ~14.5 ms per buffer at 22.05 kHz (sized for RAM: with both SID engines resident, 512 does not fit) */
#define AUDIO_BUF_BYTES (AUDIO_FRAMES * 4U)

/* suspend the stream (and let the amplifier power down) after this long
 * without any sound */
#define AUDIO_IDLE_SUSPEND_MS 30000U

/* 16-bit stereo staging (what the tone generator writes) */
static int16_t stage[AUDIO_FRAMES * 2U];
/* the two EasyDMA buffers: one 32-bit left sample per frame */
static int32_t play_buf[2][AUDIO_FRAMES];
static uint8_t next_buf;

static volatile bool stream_running;
static volatile bool muted;
static volatile uint32_t last_sound_ms;

/*
 * Bring-up test signals (audio_click/beep/tone, the rate and tone ladders):
 * debug builds only (SIDCLOCK_DEBUG=1 ./build.sh). Release images have no
 * test-tone generator at all, which also drops the 256-entry sine table
 * (512 B) and everything that feeds it.
 */
#ifdef SIDCLOCK_DEBUG
static volatile uint16_t tone_left; /* tone buffers still to play */

/* steady tone (tonestart/tonestop and the 10 s tonefreq tone) */
static volatile bool tone_hold;
static volatile bool tone_stop_req;
static int32_t tone_hold_ramp; /* 0..256 gain ramp */
static uint32_t tone_hold_hz;
static uint32_t tone_hold_until; /* k_uptime deadline; 0 = until stopped */
static uint32_t tone_hold_phase;
#endif

/* SID mode: the fill pulls samples from the emulator instead of tones */
static volatile bool sid_mode;
static int16_t sid_scratch[AUDIO_FRAMES];

static uint8_t volume = 100;
static uint8_t dbg[20];

/* verification test state (documentation pass) */
static bool cfg_lrck4;
static bool cfg_fmt32;
static bool cfg_en_high = true;
static bool cur_fmt32 = true;
static uint32_t cfg_rate = AUDIO_RATE_HZ;
static uint32_t mck_override; /* calibration: raw MCKFREQ (0 = compute) */

/* True hardware frame rate for a requested rate (see HW_RATE_NUM above). */
static uint32_t hw_rate(void)
{
	return (cfg_rate * HW_RATE_NUM + HW_RATE_DEN / 2U) / HW_RATE_DEN;
}

/*
 * Bring-up ladders and the sine table: debug builds only (see the test
 * signal block above). The release image keeps cfg_rate/mck_override and
 * the SID path; only the test generators disappear.
 */
#ifdef SIDCLOCK_DEBUG
/* sample-rate ladder for finding the amplifier's turn-on point (the lower
 * rates are out of the amplifier's accepted bit-clock window and removed
 * at the user's request - anything can be set directly instead).
 * NOTE: uint32_t - 96000 does not fit in 16 bits (it truncated to 30464). */
static const uint32_t rate_ladder[] = {
	18000, 22050, 24000, 32000, 44100, 48000, 96000,
};
static int8_t rate_idx = -1;

/* tone-frequency ladder for the audible-band top / ultrasound tests */
static const uint16_t tone_ladder[] = {
	1000, 2000, 4000, 8000, 10000, 12000, 15000, 18000,
	20000, 22000, 24000, 26000, 28000, 30000,
};
static int8_t tone_idx = -1;

/* One sine period in 256 steps (built by rotating a complex number). */
static int16_t sine_tab[256];

static void sine_init(void)
{
	const int32_t c = 1073418433; /* cos(2*pi/256) in Q30 */
	const int32_t s = 26350943;   /* sin(2*pi/256) in Q30 */
	int32_t re = 32767 << 8;
	int32_t im = 0;

	for (int i = 0; i < 256; i++) {
		int32_t re_next =
			(int32_t)(((int64_t)re * c - (int64_t)im * s) >> 30);
		int32_t im_next =
			(int32_t)(((int64_t)re * s + (int64_t)im * c) >> 30);

		sine_tab[i] = (int16_t)(re >> 8);
		re = re_next;
		im = im_next;
	}
}
#endif /* SIDCLOCK_DEBUG */

static bool hfxo_start(void)
{
	if (NRF_CLOCK->EVENTS_XOSTARTED) {
		return true;
	}

	NRF_CLOCK->EVENTS_XOSTARTED = 0;
	NRF_CLOCK->TASKS_XOSTART = 1;

	for (int i = 0; i < 2000000 && !NRF_CLOCK->EVENTS_XOSTARTED; i++) {
	}

	return NRF_CLOCK->EVENTS_XOSTARTED != 0;
}

static uint32_t mckfreq_for(uint32_t rate_hz)
{
	uint64_t mck = (uint64_t)rate_hz * RATIO_N;
	uint64_t v = (mck << 32) / I2S_SRC_HZ;

	v = (v + 0x800) & 0xFFFFF000ULL;
	if (v < 0x1000ULL) {
		v = 0x1000ULL;
	}
	if (v > 0x80000000ULL) {
		v = 0x80000000ULL;
	}
	return (uint32_t)v;
}

/* Pack the 16-bit stereo staging into the frame format under test:
 * 32-bit = one left-channel sample per frame (MSB aligned); 16-bit = stereo. */
static void pack(int32_t *dst)
{
	if (cur_fmt32) {
		for (uint32_t i = 0; i < AUDIO_FRAMES; i++) {
			dst[i] = (int32_t)stage[i * 2U] << 16;
		}
	} else {
		memcpy(dst, stage, sizeof(stage));
	}
}

static void fill_zeros(int32_t *dst)
{
	memset(dst, 0, AUDIO_BUF_BYTES);
}

#ifdef SIDCLOCK_DEBUG
/* Continuous, phase-continuous steady tone into the staging buffer, with a
 * short fade in/out (a full-amplitude onset thumps the speaker and the
 * amplifier's level detection). */
static void fill_hold_tone(void)
{
	uint32_t step = ((uint32_t)tone_hold_hz << 16) / hw_rate();
	int32_t amp = (int32_t)volume << 7;

	for (uint32_t i = 0; i < AUDIO_FRAMES; i++) {
		int32_t a = (amp * tone_hold_ramp) >> 8;
		int16_t s = (int16_t)(((int32_t)sine_tab
				       [(tone_hold_phase >> 8) & 0xFF] * a)
				      >> 15);

		stage[i * 2U] = s;
		stage[i * 2U + 1U] = s;
		tone_hold_phase += step;

		if (tone_stop_req) {
			if (tone_hold_ramp > 0) {
				tone_hold_ramp--;
			} else {
				tone_hold = false;
				tone_stop_req = false;
			}
		} else if (tone_hold_ramp < 256) {
			tone_hold_ramp++;
		}
	}
}
#endif /* SIDCLOCK_DEBUG */

static void fill_buffer(int32_t *dst)
{
	if (muted) {
		fill_zeros(dst);
	} else if (sid_mode && sid_player_is_playing() &&
		   !sid_player_is_paused()) {
		uint32_t c0 = k_cycle_get_32();
		uint32_t dt;

		sid_player_render(sid_scratch, (int)AUDIO_FRAMES);
		dt = k_cycle_get_32() - c0;
		{
			/* k_cycle_get_32() counts at
			 * CONFIG_SYS_CLOCK_HW_CYCLES_PER_SEC (1 MHz here), so
			 * the raw delta is the render time in microseconds. */
			dbg[13] = (uint8_t)(dt & 0xFFU);
			dbg[14] = (uint8_t)((dt >> 8) & 0xFFU);
		}

		/* same volume slider; quadratic curve so low settings are
		 * actually quiet for the SID's dense signal */
		for (uint32_t i = 0; i < AUDIO_FRAMES; i++) {
			int32_t s = ((int32_t)sid_scratch[i] *
				     (int32_t)volume) >> 8;

			s = (s * (int32_t)volume) >> 8;
			stage[i * 2U] = (int16_t)s;
			stage[i * 2U + 1U] = (int16_t)s;
		}
		pack(dst);
		last_sound_ms = k_uptime_get_32();
#ifdef SIDCLOCK_DEBUG
	} else if (tone_hold) {
		fill_hold_tone();
		pack(dst);
	} else if (tone_left > 0U) {
		pack(dst);
		tone_left--;
#endif
	} else {
		fill_zeros(dst);
	}
}

/* Prime both buffers with silence and start the transfer. */
static void stream_start(void)
{
	fill_zeros(play_buf[0]);
	fill_zeros(play_buf[1]);

	I2S_REGS->EVENTS_TXPTRUPD = 0;
	(void)I2S_REGS->EVENTS_TXPTRUPD;

	I2S_REGS->TXD.PTR = (uint32_t)play_buf[0];
	next_buf = 1;
	I2S_REGS->TASKS_START = 1;
	stream_running = true;
	last_sound_ms = k_uptime_get_32();
	dbg[5] = 0;
}

/* Configure the peripheral and pins for one wiring variant (peripheral
 * must be disabled): lrck4 = LRCK on P1.04 (else P1.07), fmt32 = 32-bit
 * left (else 16-bit stereo), enable_high = spare pin driven high. */
static void hw_config_variant(bool lrck4, bool fmt32, bool enable_high)
{
	uint32_t en_pin = lrck4 ? NRF_GPIO_PIN_MAP(1, 7)
				: NRF_GPIO_PIN_MAP(1, 4);
	uint32_t lr_pin = lrck4 ? NRF_GPIO_PIN_MAP(1, 4)
				: NRF_GPIO_PIN_MAP(1, 7);

	stream_running = false;
	cfg_lrck4 = lrck4;
	cfg_fmt32 = fmt32;
	cfg_en_high = enable_high;
	cur_fmt32 = fmt32;

	I2S_REGS->ENABLE = 0;

	I2S_REGS->CONFIG.MODE = 0; /* master */
	I2S_REGS->CONFIG.RXEN = 0;
	I2S_REGS->CONFIG.TXEN = 1;
	I2S_REGS->CONFIG.MCKEN = 1;
	I2S_REGS->CONFIG.MCKFREQ = mck_override ? mck_override
					      : mckfreq_for(cfg_rate);
	I2S_REGS->CONFIG.RATIO = 0x2; /* 64X */
	I2S_REGS->CONFIG.SWIDTH = fmt32 ? 3U : 1U;
	I2S_REGS->CONFIG.ALIGN = 0;  /* left */
	I2S_REGS->CONFIG.FORMAT = 0; /* I2S */
	I2S_REGS->CONFIG.CHANNELS = fmt32 ? 1U : 0U;

	/* pins are outputs before the peripheral is handed them; the spare
	 * pin is the amplifier enable (driven high) */
	nrf_gpio_cfg_output(en_pin);
	if (enable_high) {
		nrf_gpio_pin_set(en_pin);
	} else {
		nrf_gpio_pin_clear(en_pin);
	}
	nrf_gpio_cfg_output(NRF_GPIO_PIN_MAP(1, 5));
	nrf_gpio_pin_clear(NRF_GPIO_PIN_MAP(1, 5));
	nrf_gpio_cfg_output(NRF_GPIO_PIN_MAP(1, 6));
	nrf_gpio_pin_clear(NRF_GPIO_PIN_MAP(1, 6));
	nrf_gpio_cfg_output(lr_pin);
	nrf_gpio_pin_clear(lr_pin);

	I2S_REGS->PSEL.MCK = 0x80000000UL;  /* disconnected */
	I2S_REGS->PSEL.SDIN = 0x80000000UL; /* disconnected */
	I2S_REGS->PSEL.SCK = 0x25UL;	    /* P1.05 */
	I2S_REGS->PSEL.LRCK = lrck4 ? 0x24UL : 0x27UL;
	I2S_REGS->PSEL.SDOUT = 0x26UL;	    /* P1.06 */

	I2S_REGS->RXTXD.MAXCNT = AUDIO_BUF_BYTES;
	I2S_REGS->ENABLE = 1;
}

/* Stop the stream: the amplifier loses its clocks and powers down. */
static void stream_suspend(void)
{
	I2S_REGS->EVENTS_STOPPED = 0;
	I2S_REGS->TASKS_STOP = 1;
	for (int k = 0; k < 100000 && !I2S_REGS->EVENTS_STOPPED; k++) {
	}
	I2S_REGS->EVENTS_STOPPED = 0;
	I2S_REGS->ENABLE = 0;
	stream_running = false;
	dbg[5] = 1;
}

/* Restart after a suspend: the configuration registers are unchanged, so
 * just re-enable and go. A full stop/reprogram keeps the I2S clock stopped
 * for longer, and the amplifier then needs noticeably longer to re-lock
 * (audible as a short distorted/choppy start). */
static void stream_resume(void)
{
	(void)hfxo_start();
	I2S_REGS->ENABLE = 1;
	stream_start();
}

static void hw_init(void)
{
	/*
	 * The MCUboot stage leaves the DK console UART (UARTE20) initialized
	 * on P1.04/P1.05/P1.06/P1.07 - exactly the amplifier pins. It holds
	 * P1.04 (TX, idle high) and P1.06 (RTS, idle low) actively driven,
	 * so the I2S SDOUT signal never reached its pad. No UART is wired on
	 * this board - shut it down and release the pins before the I2S
	 * claims them.
	 */
	NRF_UARTE20->ENABLE = 0;
	NRF_UARTE20->PSEL.TXD = 0xFFFFFFFFUL;
	NRF_UARTE20->PSEL.RXD = 0xFFFFFFFFUL;
	NRF_UARTE20->PSEL.RTS = 0xFFFFFFFFUL;
	NRF_UARTE20->PSEL.CTS = 0xFFFFFFFFUL;

	(void)hfxo_start();
	hw_config_variant(false, true, true); /* AW wiring, verified default */
	stream_start();
}

/* Polled refill service, exactly like lp_audio_service() in the DOOM port. */
static void audio_service(void)
{
	int32_t *buf;

	if (!stream_running) {
		return;
	}
	if (!I2S_REGS->EVENTS_TXPTRUPD) {
		return;
	}

	I2S_REGS->EVENTS_TXPTRUPD = 0;
	(void)I2S_REGS->EVENTS_TXPTRUPD;

	buf = play_buf[next_buf];
	fill_buffer(buf);
	I2S_REGS->TXD.PTR = (uint32_t)buf;
	next_buf ^= 1;
	dbg[8]++; /* DMA consumption counter */
}

static void audio_thread(void *a, void *b, void *c)
{
	uint32_t loop_last = k_uptime_get_32();

	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	while (1) {
		dbg[15]++; /* loop rate diagnostic (8-bit) */
		dbg_heartbeat_audio(); /* hang-triage heartbeat (see main.c) */
		{
			uint32_t now = k_uptime_get_32();
			uint32_t gap = now - loop_last;

			if (gap > dbg[16]) {
				dbg[16] = (uint8_t)gap; /* worst stall, ms */
			}
			loop_last = now;
		}

		if (!stream_running) {
			k_sleep(K_MSEC(100));
			continue;
		}

#ifdef SIDCLOCK_DEBUG
		if (tone_hold) {
			last_sound_ms = k_uptime_get_32();
			if (tone_hold_until != 0U &&
			    (int32_t)(k_uptime_get_32() - tone_hold_until) >=
				    0) {
				tone_stop_req = true; /* fade out, then off */
				tone_hold_until = 0U;
			}
		}
#endif

		audio_service();

		/* no sound for a while: stop the stream and let the
		 * amplifier shut down */
		if ((int32_t)(k_uptime_get_32() - last_sound_ms) >
		    (int32_t)AUDIO_IDLE_SUSPEND_MS) {
			stream_suspend();
		}

		k_sleep(K_MSEC(1));
	}
}

/*
 * Cooperative priority: the refill only needs ~1% of the CPU but must never
 * be starved by the UI/main thread (priority 0), whose blocking SPI display
 * flushes otherwise stall the service past the 23 ms EasyDMA buffer period.
 */
K_THREAD_DEFINE(audio_tid, 2560, audio_thread, NULL, NULL, NULL, -1, 0, 0);

const uint8_t *audio_debug(void)
{
	return dbg;
}

/* One-off debug byte write (used by the UI for idle diagnostics). */
void audio_dbg_byte(int i, uint8_t v)
{
	if (i >= 0 && i < (int)sizeof(dbg)) {
		dbg[i] = v;
	}
}

int audio_init(void)
{
#ifdef SIDCLOCK_DEBUG
	sine_init();
#else
	/* no test-tone ladder in release builds: report the rate as directly
	 * set (the "direct" marker in the debug snapshot) */
	dbg[10] = 0xFFU;
#endif
	dbg[7] = volume;

	if (!device_is_ready(DEVICE_DT_GET(DT_NODELABEL(gpio1)))) {
		dbg[1] = 0xFE;
		return -ENODEV;
	}

	hw_init();

	dbg[0] = 1;
	dbg[1] = 0;
	dbg[6] = 1;
	LOG_INF("I2S AW88082: %u Hz, 32-bit left, LRCK P1.07", AUDIO_RATE_HZ);
	return 0;
}

void audio_set_enabled(bool enable)
{
	/* No amplifier enable pin on this board - mute by sending zeros. */
	muted = !enable;
	dbg[6] = enable ? 1 : 0;
	LOG_INF("audio %s", enable ? "on" : "off");
}

void audio_set_volume(uint8_t vol)
{
	volume = vol;
	dbg[7] = vol;
}

#ifdef SIDCLOCK_DEBUG
/*
 * Synthesise a tone into the staging buffer and queue it for the polled
 * service (returns immediately). buf_ms is the buffer length, repeats how
 * many buffers in a row.
 */
static void queue_tone(uint16_t freq_hz, uint16_t buf_ms, uint16_t repeats,
		       bool decay, bool fade)
{
	uint32_t hwr = hw_rate();
	uint32_t step = ((uint32_t)freq_hz << 16) / hwr;
	uint32_t frames = (hwr * buf_ms) / 1000U;
	uint32_t phase = 0;
	int32_t amp = (int32_t)volume << 7; /* full scale at volume 255 */

	if (muted || volume == 0U) {
		return;
	}

	/* wake the stream if the idle suspend stopped it */
	if (!stream_running) {
		stream_resume();
	}

	frames = MIN(frames, AUDIO_FRAMES);

	for (uint32_t i = 0; i < frames; i++) {
		int32_t a = amp;

		if (fade) {
			if (i < 32U) {
				a = amp * (int32_t)i / 32;
			} else if (i + 32U >= frames) {
				a = amp * (int32_t)(frames - i - 1U) / 32;
			}
		}

		{
			int16_t s = (int16_t)(((int32_t)sine_tab
					       [(phase >> 8) & 0xFF] *
					       a) >> 15);

			stage[i * 2U] = s;
			stage[i * 2U + 1U] = s;
		}

		phase += step;
		if (decay) {
			amp = (int32_t)(((int64_t)amp * 64719) >> 16);
		}
	}
	/* silence-pad the tail */
	for (uint32_t i = frames; i < AUDIO_FRAMES; i++) {
		stage[i * 2U] = 0;
		stage[i * 2U + 1U] = 0;
	}

	tone_left = repeats;
	last_sound_ms = k_uptime_get_32();
}

static void audio_play(uint16_t freq_hz, uint16_t buf_ms, uint16_t repeats,
		       bool decay, bool fade)
{
	uint32_t t0;

	dbg[9]++;
	queue_tone(freq_hz, buf_ms, repeats, decay, fade);

	/* wait until the polled service has consumed the tone */
	t0 = k_uptime_get_32();
	while (tone_left > 0U &&
	       (k_uptime_get_32() - t0) < (uint32_t)buf_ms * repeats + 200U) {
		k_sleep(K_MSEC(2));
	}
	last_sound_ms = k_uptime_get_32();
	dbg[17] = (uint8_t)tone_left;
}

void audio_click(void)
{
	audio_play(1600U, 20U, 1U, true, true);
}

void audio_beep(void)
{
	audio_play(1760U, 60U, 1U, false, true);
	audio_play(2349U, 70U, 1U, false, true);
}

void audio_long_tone(void)
{
	audio_play(1000U, 23U, 43U, false, false); /* ~1 s */
}

/* Repeats for a ~700 ms burst at the current sample rate. */
static uint16_t beep_repeats(void)
{
	uint32_t reps = (hw_rate() * 7U) / (10U * AUDIO_FRAMES);

	return (uint16_t)(reps ? reps : 1U);
}

/*
 * Sample-rate ladder (documentation pass): step to the next frame-clock
 * rate and play two 800 Hz beeps at it. Run repeatedly and listen for the
 * first rate where the amp reproduces sound. Rate in debug bytes [32..33].
 */
void audio_rate_next(void)
{
	rate_idx = (int8_t)(((uint32_t)(rate_idx + 1)) %
			    (uint32_t)ARRAY_SIZE(rate_ladder));
	cfg_rate = rate_ladder[rate_idx];
	dbg[10] = (uint8_t)rate_idx;

	(void)hfxo_start();
	hw_config_variant(cfg_lrck4, cfg_fmt32, cfg_en_high);
	stream_start();
}

/*
 * Tone-frequency ladder: step the tone pitch up (2 beeps at the current
 * sample rate). Frequencies at or above half the sample rate alias and are
 * marked as such by the host tool. Tone index in debug byte [11].
 */
void audio_tone_next(void)
{
	tone_idx = (int8_t)(((uint32_t)(tone_idx + 1)) %
			    (uint32_t)ARRAY_SIZE(tone_ladder));
	dbg[11] = (uint8_t)tone_idx;

	for (unsigned k = 0; k < 2U; k++) {
		queue_tone(tone_ladder[tone_idx], 23U, beep_repeats(),
			   false, false);
		k_sleep(K_MSEC(1000));
	}
}

/* Set an exact sample rate (1000..96000 Hz). Silent on purpose: the host
 * tool reports the new rate, and beeps here only confuse tone comparisons. */
void audio_set_rate(uint32_t hz)
{
	if (hz < 1000U || hz > 96000U) {
		return;
	}
	cfg_rate = hz;
	dbg[10] = 0xFF; /* direct set marker */

	(void)hfxo_start();
	hw_config_variant(cfg_lrck4, cfg_fmt32, cfg_en_high);
	stream_start();
}

/* Play an exact tone frequency (100..30000 Hz) as a 10 s steady tone. */
void audio_set_tone(uint32_t hz)
{
	audio_tone_hold(hz, 10U);
}

/* Steady tone, phase-continuous across buffers; seconds = 0 -> until stop. */
void audio_tone_hold(uint32_t hz, uint32_t seconds)
{
	if (hz < 100U || hz > 30000U) {
		return;
	}

	tone_hold_hz = hz;
	tone_hold_phase = 0;
	tone_hold_ramp = 0;
	tone_stop_req = false;
	tone_hold_until = seconds ? k_uptime_get_32() + seconds * 1000U : 0U;

	if (!stream_running) {
		stream_resume();
	}
	tone_hold = true;
	last_sound_ms = k_uptime_get_32();
}

void audio_tone_release(void)
{
	tone_stop_req = true;
}
#endif /* SIDCLOCK_DEBUG */

/*
 * SID playback mode. The stream is forced to 22050 Hz (the emulator's rate)
 * and kept awake while the emulator is producing samples.
 */
void audio_sid_start(void)
{
	/* SID always runs at its own rate so the render rate and the output
	 * configuration stay consistent with each other */
	if (cfg_rate != AUDIO_RATE_HZ) {
		cfg_rate = AUDIO_RATE_HZ;
		(void)hfxo_start();
		hw_config_variant(cfg_lrck4, cfg_fmt32, cfg_en_high);
		stream_start();
	} else if (!stream_running) {
		stream_resume();
	}
	sid_player_set_render_rate(hw_rate());
	sid_mode = true;
	last_sound_ms = k_uptime_get_32();
}

void audio_sid_stop(void)
{
	sid_mode = false;
}

#ifdef SIDCLOCK_DEBUG
/* Calibration: force a raw MCKFREQ value (0 = back to computed). */
void audio_set_mck_raw(uint32_t v)
{
	mck_override = v;
	(void)hfxo_start();
	hw_config_variant(cfg_lrck4, cfg_fmt32, cfg_en_high);
	stream_start();
}
#endif /* SIDCLOCK_DEBUG */

void audio_read_hw(uint8_t *out, size_t len)
{
	uint32_t words[3] = {
		I2S_REGS->PSEL.SCK,
		I2S_REGS->PSEL.SDOUT,
		I2S_REGS->PSEL.MCK,
	};

	for (size_t i = 0; i < 12U && i < len; i++) {
		out[i] = ((const uint8_t *)words)[i];
	}
	if (len > 12U) {
		out[12] = (uint8_t)(I2S_REGS->ENABLE & 1U);
	}
	if (len > 13U) {
		out[13] = (uint8_t)(I2S_REGS->CONFIG.TXEN & 1U);
	}
}

/*
 * Live diagnostics for the BLE debug read:
 *   [0]   reserved
 *   [2..3] peak |sample| in the two DMA buffers (LE)
 *   [4..7]/[8..11] first word of each DMA buffer
 *   [21..24]/[25..28] EasyDMA bus-error addresses (0 = none)
 */
void audio_diag(uint8_t *out, size_t len)
{
	uint16_t peak = 0;

	for (unsigned b = 0; b < 2U; b++) {
		for (unsigned i = 0; i < AUDIO_FRAMES; i++) {
			uint32_t w = (uint32_t)play_buf[b][i];
			int16_t l = (int16_t)(w & 0xFFFF);
			int16_t h = (int16_t)(w >> 16);
			int a = l < 0 ? -l : l;
			int c = h < 0 ? -h : h;

			if (a > peak) {
				peak = (uint16_t)a;
			}
			if (c > peak) {
				peak = (uint16_t)c;
			}
		}
	}

	if (len > 0U) {
		out[0] = 0;
	}
	if (len > 3U) {
		out[2] = (uint8_t)(peak & 0xFFU);
		out[3] = (uint8_t)(peak >> 8);
	}
	if (len > 11U) {
		uint32_t w0 = (uint32_t)play_buf[0][0];
		uint32_t w1 = (uint32_t)play_buf[1][0];

		memcpy(out + 4, &w0, 4);
		memcpy(out + 8, &w1, 4);
	}
	if (len > 12U) {
		out[12] = dbg[8]; /* DMA consumption counter */
	}
	if (len > 16U) {
		out[13] = (uint8_t)(I2S_REGS->CONFIG.RATIO & 0xFFU);
		out[14] = (uint8_t)(I2S_REGS->CONFIG.SWIDTH & 0xFFU);
		out[15] = (uint8_t)(I2S_REGS->CONFIG.CHANNELS & 0xFFU);
		out[16] = (uint8_t)(I2S_REGS->CONFIG.ALIGN & 0xFFU);
	}
	if (len > 20U) {
		uint32_t mck = I2S_REGS->CONFIG.MCKFREQ;

		memcpy(out + 17, &mck, 4);
	}
	if (len > 28U) {
		uint32_t berr0 = I2S_REGS->CHANNEL[0].BUSERRORADDRESS;
		uint32_t berr1 = I2S_REGS->CHANNEL[1].BUSERRORADDRESS;

		memcpy(out + 21, &berr0, 4);
		memcpy(out + 25, &berr1, 4);
	}
	/* NOTE: no pin probing here on purpose. Touching PIN_CNF on the live
	 * LRCK/BCK lines disturbs the bit clock, and the amplifier's clock
	 * check then mutes and re-locks (~0.5 s of audible garbage). Every
	 * debug read must stay passive. */
	if (len > 33U) {
		out[32] = (uint8_t)(cfg_rate & 0xFFU);
		out[33] = (uint8_t)((cfg_rate >> 8) & 0xFFU);
		out[34] = (uint8_t)((cfg_rate >> 16) & 0xFFU);
	}
}
