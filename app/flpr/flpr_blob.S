/*
 * flpr_blob.S - embed the built FLPR blob in the M33 image.
 *
 * .incbin, not a generated C array: the binary is linked byte-for-byte,
 * with no per-byte source file to regenerate (see
 * https://elm-chan.org/junk/32bit/binclude.html, "Using .incbin in C
 * code" - the same trick as a plain assembly TU). build.sh passes the
 * blob path as FLPR_BLOB_FILE and CMake makes this object depend on it,
 * so a rebuilt blob relinks without touching any source.
 *
 * 128-byte alignment is what flpr_start_blob() requires for XIP: the blob
 * runs exactly where it was linked (bias 0), so the array address it was
 * linked against must be reproducible and aligned.
 */
	.section .rodata.flpr_blob, "a"
	.balign 128
	.global flpr_blob
flpr_blob:
	.incbin FLPR_BLOB_FILE

	.global flpr_blob_end
flpr_blob_end:

	/* Size as a data word (not an absolute symbol), so C keeps reading
	 * `flpr_blob_size` as a value. */
	.section .rodata.flpr_blob_size, "a"
	.balign 4
	.global flpr_blob_size
flpr_blob_size:
	.word flpr_blob_end - flpr_blob
