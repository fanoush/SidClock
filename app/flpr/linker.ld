/*
 * flpr/linker.ld - bare-metal FLPR blob: absolute link, XIP from flash.
 *
 * The blob runs EXACTLY where it is linked (bias 0, enforced by
 * build.sh): ROM base comes from the generated memmap.ld (the
 * flpr_blob[] address the M33 link assigned), engine data sections from
 * datamap.ld (the M33 instances, so M33 control and blob render share
 * state with zero copies). Only RAM addresses are fixed here (they must
 * match app/flpr/flpr_shared.h).
 * VMA/LMA split: code VMA = ROM base, file offsets from 0, so the
 * binary embeds 1:1 as flpr_blob[] with _start at offset 0.
 */
OUTPUT_ARCH(riscv)
ENTRY(_start)

INCLUDE "memmap.ld"

MEMORY {
	/* Hot engine code: executed from the FLPR's own SRAM. Code fetched
	 * from RRAM costs ~3 cycles per instruction on this core (no
	 * instruction cache), from SRAM ~1; see docs/flpr.md. */
	CODERAM (rx) : ORIGIN = 0x2002F000, LENGTH = 0xE000
	RAM (rwx) : ORIGIN = 0x2003F000, LENGTH = 0xC00
}

SECTIONS {
	/* Engine data homes first: each mapped section wins here, the
	 * small unmapped remainder falls through to the normal blocks
	 * below (and trips the private-RAM cap in the build audit if it
	 * ever grows past leftovers). */
	INCLUDE "datamap.ld"

	/* LMA follows the VMA (the array address the M33 link assigned), so
	 * load-time symbols like _sicoderam_load are real runtime addresses.
	 * objcopy -O binary starts at the lowest LMA, so the image is still
	 * 0-based with _start first. */
	.text : {
		KEEP(*(.text.init))
		*(.text .text.*)
		*(.rodata .rodata.*)
		*(.data.rel.ro .data.rel.ro.*)
		*(.eh_frame .eh_frame.*)
		*(.init_array .init_array.*)
	} > ROM

	/* Hot functions copied to SRAM by startup.S before main. The load
	 * image follows .text, so objcopy -O binary keeps them contiguous.
	 * The section name (.flprhot) does not match the .text wildcard in
	 * the block above, so the engine can claim it first. */
	.text_hot : AT(LOADADDR(.text) + SIZEOF(.text)) {
		_sicoderam = .;
		*(.flprhot)
		_ecoderam = .;
	} > CODERAM
	_sicoderam_load = LOADADDR(.text_hot);

	/* Blob-private writable sections (engine sections all have
	 * datamap homes above; the small unmapped remainder lands here
	 * and is capped by the build audit). .got contents are absolute
	 * link values, correct as-is (bias 0), but must exist in RAM. */

	.got : AT(LOADADDR(.text_hot) + SIZEOF(.text_hot)) {
		_sgot = .;
		*(.got .got.*)
		_egot = .;
	} > RAM
	_sgot_load = LOADADDR(.got);

	.data : AT(LOADADDR(.got) + SIZEOF(.got)) {
		_sdata = .;
		*(.data .data.*)
		_edata = .;
	} > RAM

	.bss (NOLOAD) : {
		_sbss = .;
		*(.bss .bss.* COMMON)
		_ebss = .;
	} > RAM

	/* 1 KB stack at the top of the private region. */
	PROVIDE(_stack_top = ORIGIN(RAM) + LENGTH(RAM));
}
