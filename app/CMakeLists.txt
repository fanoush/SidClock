cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(sidclock)

# The panel driver is out-of-tree (custom SPI framing); compile it with the
# application.
target_sources(app PRIVATE
    src/main.c
    src/display_gc9307.c
    src/opt400x.c
    src/audio.c
    src/sid_player.cpp
    src/sid/libcsidlight.cpp
)

# The SID emulator is the only real-time-critical code in the app. A/B
# measurement on this M33: "-O3;-funroll-loops" renders 512 samples in
# ~4.7 ms vs ~5.5 ms with -Os (the code fits the 2 kB I-cache well enough
# that -O3's better code wins). Render time is visible in debug bytes
# [13]/[14] (microseconds per 512 samples).
set_source_files_properties(src/sid/libcsidlight.cpp
    PROPERTIES COMPILE_OPTIONS "-O3;-funroll-loops")

# Version string shown on the display; build.sh passes -DSIDCLOCK_VERSION=<x.y.z>
# and uses the same value for the MCUboot image header.
if(NOT DEFINED SIDCLOCK_VERSION)
    set(SIDCLOCK_VERSION "dev")
endif()
target_compile_definitions(app PRIVATE SIDCLOCK_VERSION="${SIDCLOCK_VERSION}")
