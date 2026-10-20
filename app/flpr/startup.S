/* Reset entry: the blob runs EXACTLY where it is linked (bias 0 -
 * enforced by build.sh: ROM base = the flpr_blob[] address, engine
 * data symbols = the M33 instances).
 *
 * Address model:
 * - Code/rodata/functions: absolute link addresses == runtime (B=0),
 *   reached by direct PC-relative or absolute sequences - never `la`
 *   through a GOT (nothing relocates it; the build asserts zero
 *   dynamic relocations).
 * - Fixed RAM (stack, .got/.data/.bss in private RAM): absolute,
 *   initialized here from the ROM image / zeroed. M33-owned engine
 *   state is never touched: the M33 crt0 owns its init, the blob only
 *   reads/writes it during render.
 * - No gp use anywhere (-msmall-data-limit=0); gp is never set up.
 */

	.section .text.init, "ax"
	.globl _start
	.type _start, @function
_start:
	/* Fixed stack top (absolute - must not move with anything). */
	lui sp, %hi(_stack_top)
	addi sp, sp, %lo(_stack_top)

	/* Hot code: ROM image -> FLPR SRAM, before anything calls it. */
	la a1, _sicoderam
	la a2, _ecoderam
	la a3, _sicoderam_load
	bgeu a1, a2, 1f
0:
	lw t0, 0(a3)
	sw t0, 0(a1)
	addi a1, a1, 4
	addi a3, a3, 4
	bltu a1, a2, 0b
1:
	/* .got/.data are one contiguous init image (_sgot.._edata). */
	la a1, _sgot
	la a2, _edata
	la a3, _sgot_load
	bgeu a1, a2, 2f
0:
	lw t0, 0(a3)
	sw t0, 0(a1)
	addi a1, a1, 4
	addi a3, a3, 4
	bltu a1, a2, 0b
2:
	/* .bss: zero (private only - engine state is M33-owned). */
	la a0, _sbss
	la a1, _ebss
	bgeu a0, a1, 3f
0:
	sw zero, 0(a0)
	addi a0, a0, 4
	bltu a0, a1, 0b
3:
	call main

	/* main must never return; park here if it does (no wfi: no trap
	 * handler is installed on this bare-metal image). */
3:
	j 3b
