/*
 * flpr.c - FLPR (VPR RISC-V) core lifecycle.
 *
 * Start/stop of the bare-metal blob. The blob is linked into this image
 * (flpr/flpr_blob.S, .incbin) and executes where it was linked (bias 0).
 * Small blobs are copied to FLPR private RAM instead, so their
 * instruction fetches never contend with the M33's on the single RRAM
 * bank.
 *
 * NDMRESET, not CPURUN, is what actually starts/halts the core: CPURUN
 * only selects the state entered after a core reset (see the MDK field
 * docs), so clearing it on a running core changes nothing until a reset
 * happens - which is why a CPURUN-only stop never halted the blob.
 * DMACTIVE powers the debug module so DMCONTROL takes effect.
 */
#include <zephyr/kernel.h>
#include <zephyr/devicetree.h>
#include <string.h>
#include <hal/nrf_vpr.h>
#include <hal/nrf_memconf.h>
#if defined(CONFIG_SOC_NRF54L_CPUAPP_COMMON) && \
	!defined(CONFIG_TRUSTED_EXECUTION_NONSECURE)
#include <hal/nrf_spu.h>
#endif

#include "flpr.h"
#include "flpr_shared.h"

/* Embedded FLPR bare-metal blob (flpr/flpr_blob.S). */
extern const uint8_t flpr_blob[];
extern const unsigned flpr_blob_size;

static NRF_VPR_Type *const vpr =
	(NRF_VPR_Type *)DT_REG_ADDR(DT_NODELABEL(cpuflpr_vpr));

/*
 * VPR power. The block draws ~0.5 mA from the moment the core has been
 * started, no matter whether it runs, sleeps (default sleep state WAIT)
 * or is held in reset - Nordic's answer to the DevZone report is that
 * only powering the block down removes it, keeping state in RAM. The
 * power-off sequence in Zephyr's z_sys_poweroff() disables retention on
 * power block 1 (the VPR): MEMCONF.POWER[1].RET bit 0. Clearing it here
 * powers the block down; flpr_start() re-enables it first.
 */
#define VPR_POWER_BLOCK 1U
#define VPR_RET_BIT 0U

static void flpr_power(bool on)
{
	nrf_memconf_ramblock_ret_enable_set(NRF_MEMCONF, VPR_POWER_BLOCK,
					    VPR_RET_BIT, on);
}

static void flpr_core_reset(void)
{
	nrf_vpr_debugif_dmcontrol_set(vpr, NRF_VPR_DMCONTROL_DMACTIVE, true);
	nrf_vpr_debugif_dmcontrol_set(vpr, NRF_VPR_DMCONTROL_NDMRESET, true);
	k_busy_wait(10);
	nrf_vpr_debugif_dmcontrol_set(vpr, NRF_VPR_DMCONTROL_NDMRESET, false);
}

bool flpr_alive(void)
{
	return FLPR_SHARED->magic == FLPR_MAGIC;
}

void flpr_clear(void)
{
	FLPR_SHARED->magic = 0U;
}

int flpr_start(void)
{
	uint32_t entry;

	if (flpr_alive()) {
		return 0;
	}
	if (flpr_blob_size <= FLPR_PRIV_SIZE - 1024U) {
		/* Small blob: copy to private RAM and run there. */
		memcpy((void *)FLPR_PRIV_BASE, flpr_blob, flpr_blob_size);
		entry = FLPR_PRIV_BASE;
	} else {
		/* Engine blob: XIP straight from the array it was linked
		 * for; it cannot fit private RAM. */
		entry = (uint32_t)flpr_blob;
	}
	if ((entry & 0x7FUL) != 0U) {
		return -EINVAL;
	}
	flpr_power(true); /* the block may have been powered down by flpr_halt() */
#if defined(CONFIG_SOC_NRF54L_CPUAPP_COMMON) && \
	!defined(CONFIG_TRUSTED_EXECUTION_NONSECURE)
	nrf_spu_periph_perm_secattr_set(NRF_SPU00,
					nrf_address_slave_get((uint32_t)vpr),
					true);
#endif
	nrf_vpr_cpurun_set(vpr, false);
	nrf_vpr_initpc_set(vpr, entry);
	flpr_core_reset();
	nrf_vpr_cpurun_set(vpr, true);
	return 0;
}

void flpr_halt(void)
{
	nrf_vpr_cpurun_set(vpr, false);
	flpr_core_reset();
	flpr_clear();
	/* Power the block down: a stopped/reset VPR still draws ~0.5 mA
	 * (default sleep state WAIT). This is what z_sys_poweroff() does for
	 * the VPR before System OFF. */
	flpr_power(false);
}

/* The blob checks `run` between bursts of 512 frames (a burst is ~1 ms of
 * render), so the wait is short. Bounded anyway: a wedged blob must not
 * block the UI, and the mutation is safe enough after the timeout (the
 * blob would have to be stuck mid-burst forever). */
#define FLPR_ACK_TIMEOUT_US 50000

void flpr_render_stop(void)
{
	FLPR_SHARED->run = 0U;
	if (!flpr_alive()) {
		return;
	}
	for (int i = 0; i < FLPR_ACK_TIMEOUT_US / 100; i++) {
		if (FLPR_SHARED->run_ack == 0U) {
			return;
		}
		k_busy_wait(100);
	}
}

void flpr_render_start(void)
{
	/* Drop whatever queued while stopped: engine state is about to be
	 * (or just was) re-initialised, so those samples are stale. */
	FLPR_SHARED->read_idx = FLPR_SHARED->write_idx; /* retired */
	FLPR_SHARED->run = 1U;
}

bool flpr_rendering(void)
{
	return FLPR_SHARED->run != 0U;
}
