cmake_minimum_required(VERSION 3.20.0)

project(flpr_baremetal C ASM)

# FLPR_WITH_ENGINE=1 links the cRSID render core (phase 2 of build.sh,
# with memmap.ld/datamap.ld generated from the M33 link). =0 builds the
# sine-only test blob (phase 1).
option(FLPR_WITH_ENGINE "Link the cRSID SID engine" OFF)

# Generated address map (written by build.sh before configuring):
# memmap.ld defines MEMORY ROM at the array address the M33 link gave
# flpr_blob[]; datamap.ld places every engine data section at the M33
# instance address (absolute, so M33 control and blob render share state
# with zero copies). Both live next to this file, gitignored.
set(FLPR_GEN_DIR "${CMAKE_CURRENT_SOURCE_DIR}" CACHE PATH
    "Directory holding generated memmap.ld/datamap.ld")

add_executable(flpr.elf startup.S main.c stubs.c)
target_include_directories(flpr.elf PRIVATE
	${CMAKE_CURRENT_SOURCE_DIR}
	${CMAKE_CURRENT_SOURCE_DIR}/../src/sid)

if(FLPR_WITH_ENGINE)
	target_compile_definitions(flpr.elf PRIVATE FLPR_WITH_ENGINE=1)
	target_sources(flpr.elf PRIVATE
		${CMAKE_CURRENT_SOURCE_DIR}/../src/sid/crsid/libcRSID.c)
	# Same hot-path flags the M33 build proved (-O3 -funroll-loops).
	# Absolute codegen: the blob runs exactly where it is linked
	# (build.sh pins ROM base to the array address), so
	# position-independence buys nothing and costs a GOT (-fno-pie).
	# -msmall-data-limit=0: gp is never set up, so no gp-relative
	# access may be generated.
	set_source_files_properties(
		${CMAKE_CURRENT_SOURCE_DIR}/../src/sid/crsid/libcRSID.c
		PROPERTIES COMPILE_OPTIONS
		"-O3;-funroll-loops;-std=gnu99;-fno-pie;-msmall-data-limit=0;-ffunction-sections;-fdata-sections")
endif()

# No libc, no syscalls: pure number crunching on shared memory.
target_compile_options(flpr.elf PRIVATE
	-O2 -fno-pie -msmall-data-limit=0 -ffreestanding -nostdlib
	-Wall -Wextra -ffunction-sections -fdata-sections)
target_link_options(flpr.elf PRIVATE
	-nostdlib -static -T ${CMAKE_CURRENT_SOURCE_DIR}/linker.ld
	-L ${FLPR_GEN_DIR}
	-Wl,--gc-sections -Wl,-Map=${CMAKE_CURRENT_BINARY_DIR}/flpr.map)
