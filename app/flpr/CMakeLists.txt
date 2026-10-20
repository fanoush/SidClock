cmake_minimum_required(VERSION 3.20.0)

project(flpr_baremetal C ASM)

# FLPR_WITH_ENGINE=1 links the cRSID render core (phase 2 of build.sh,
# with memmap.ld/datamap.ld generated from the M33 link). =0 builds the
# blob without the engine (phase 1: it only reserves the array slot and
# proves the layout; the stub in stubs.c keeps the pump linkable).
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

# Engine optimisation flags: one knob, shared with build.sh's standalone
# engine object (the two must agree or the two-phase section map drifts).
# Default -O2 (fetch-bound core, see docs/flpr.md); override with
# FLPR_ENGINE_OPT to A/B
# variants on the device (the bench reports cycles/frame and IPC).
if(NOT DEFINED FLPR_ENGINE_OPT OR FLPR_ENGINE_OPT STREQUAL "")
	set(FLPR_ENGINE_OPT "-O2")
endif()
# Arrives as one string (e.g. "-Os"), split into a real list.
separate_arguments(FLPR_ENGINE_OPT UNIX_COMMAND "${FLPR_ENGINE_OPT}")
message(STATUS "FLPR engine opt: ${FLPR_ENGINE_OPT}")

if(NOT DEFINED FLPR_PROF OR FLPR_PROF STREQUAL "")
	set(FLPR_PROF 0)
endif()

if(FLPR_WITH_ENGINE)
	target_compile_definitions(flpr.elf PRIVATE FLPR_WITH_ENGINE=1)
	target_sources(flpr.elf PRIVATE
		${CMAKE_CURRENT_SOURCE_DIR}/../src/sid/crsid/libcRSID.c)
	set_source_files_properties(
		${CMAKE_CURRENT_SOURCE_DIR}/../src/sid/crsid/libcRSID.c
		PROPERTIES COMPILE_OPTIONS
		"${FLPR_ENGINE_OPT};-std=gnu99;-fno-pie;-msmall-data-limit=0;-ffunction-sections;-fdata-sections"
		COMPILE_DEFINITIONS
		"CRSID_HOT_CODE=__attribute__((section(\".flprhot\"),noinline,optimize(\"O2\")));CRSID_HOT_CODE_SPEED=__attribute__((section(\".flprhot\"),noinline));CRSID_SPLIT;FLPR_BLOB=1")
	if(FLPR_PROF)
		# Split-section cycle counters into FLPR_SHARED->prof[]; the
		# M33 logs them when the debug snapshot is read (see
		# docs/flpr.md, "Profiling the split CPU half"). Costs a few
		# percent, so it is opt-in.
		target_compile_definitions(flpr.elf PRIVATE CRSID_SPLIT_PROF=1)
	endif()
endif()

# No libc, no syscalls: pure number crunching on shared memory.
target_compile_options(flpr.elf PRIVATE
	-O2 -fno-pie -msmall-data-limit=0 -ffreestanding -nostdlib
	-Wall -Wextra -ffunction-sections -fdata-sections)
target_link_options(flpr.elf PRIVATE
	-nostdlib -static -T ${CMAKE_CURRENT_SOURCE_DIR}/linker.ld
	-L ${FLPR_GEN_DIR}
	-Wl,--gc-sections -Wl,-Map=${CMAKE_CURRENT_BINARY_DIR}/flpr.map)
