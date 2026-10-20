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
	RAM (rwx) : ORIGIN = 0x2003E000, LENGTH = 0x1C00
}

SECTIONS {
	/* Engine data homes first: each mapped section wins here, the
	 * small unmapped remainder falls through to the normal blocks
	 * below (and trips the private-RAM cap in the build audit if it
	 * ever grows past leftovers). */
	INCLUDE "datamap.ld"

	.text : AT(0x0) {
		KEEP(*(.text.init))
		*(.text .text.*)
		*(.rodata .rodata.*)
		*(.data.rel.ro .data.rel.ro.*)
		*(.eh_frame .eh_frame.*)
		*(.init_array .init_array.*)
	} > ROM

	/* Blob-private writable sections (engine sections all have
	 * datamap homes above; the small unmapped remainder lands here
	 * and is capped by the build audit). .got contents are absolute
	 * link values, correct as-is (bias 0), but must exist in RAM. */
	.got : AT(LOADADDR(.text) + SIZEOF(.text)) {
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
