cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(sidclock)

# The panel driver is out-of-tree (custom SPI framing); compile it with the
# application.
# SID emulator selection: "crsid" (default, cRSID-1.58 Light, integer-only,
# more accurate), "csid" (the original cSID-light) or "dual" (both linked,
# per-tune switchable at runtime sharing one 64 KB C64 RAM - only one runs
# at a time). For A/B comparison or heavy-tune fallback.
# From build.sh (-DSIDCLOCK_SID_ENGINE=, env-backed) or plain CMake -D; the
# cache persists across rebuilds (change with -D, not the environment).
if(NOT SIDCLOCK_SID_ENGINE MATCHES "^(csid|dual|crsid)$")
    set(SIDCLOCK_SID_ENGINE "$ENV{SIDCLOCK_SID_ENGINE}")
endif()
if(NOT SIDCLOCK_SID_ENGINE MATCHES "^(csid|dual|crsid)$")
    set(SIDCLOCK_SID_ENGINE "dual")
endif()
message(STATUS "SidClock SID engine: ${SIDCLOCK_SID_ENGINE}")

if(SIDCLOCK_SID_ENGINE STREQUAL "csid")
    set(SID_ENGINE_SRCS src/sid/libcsidlight.cpp)
    set(SID_ENGINE_FLAGS "-O3;-funroll-loops")
    set(SID_ENGINE_SUFFIX "-csid")
elseif(SIDCLOCK_SID_ENGINE STREQUAL "dual")
    set(SID_ENGINE_SRCS src/sid/libcrsid_shim.c src/sid/crsid/libcRSID.c src/sid/libcsidlight.cpp)
    set(SID_ENGINE_FLAGS "-O3;-funroll-loops")
    set(SID_ENGINE_SUFFIX "")
    target_compile_definitions(app PRIVATE SID_ENGINE_DUAL)
else()
    set(SID_ENGINE_SRCS src/sid/libcrsid_shim.c src/sid/crsid/libcRSID.c)
    set(SID_ENGINE_FLAGS "-O3;-funroll-loops;-std=gnu99")
    set(SID_ENGINE_SUFFIX "-crsid")
endif()
target_compile_definitions(app PRIVATE SID_ENGINE_SUFFIX="${SID_ENGINE_SUFFIX}")

target_sources(app PRIVATE
    src/main.c
    src/display_gc9307.c
    src/opt400x.c
    src/audio.c
    src/md5.c
    src/sid_player.cpp
    ${SID_ENGINE_SRCS}
)

# The SID emulator is the only real-time-critical code in the app.
# "-O3;-funroll-loops" was A/B-proven on this M33 with the old core and
# re-validated for the cRSID core under M33 emulation (bit-identical output,
# ~1% faster than plain -O3). Render time is visible in debug bytes
# [13]/[14] (microseconds per 512 samples).
# The cRSID core also needs -std=gnu99 (it uses old-style declarations,
# which are hard errors under the toolchain default C23).
if(SIDCLOCK_SID_ENGINE STREQUAL "csid")
    set_source_files_properties(src/sid/libcsidlight.cpp
        PROPERTIES COMPILE_OPTIONS "${SID_ENGINE_FLAGS}")
elseif(SIDCLOCK_SID_ENGINE STREQUAL "dual")
    set_source_files_properties(src/sid/crsid/libcRSID.c
        PROPERTIES COMPILE_OPTIONS "-O3;-funroll-loops;-std=gnu99")
    # Dual build: the legacy core's libcsid_* API and shared globals are
    # renamed so the shim can dispatch between both engines; its C64 RAM
    # aliases cRSID's (see SID_ENGINE_DUAL in libcsidlight.cpp).
    set_source_files_properties(src/sid/libcsidlight.cpp
        PROPERTIES COMPILE_OPTIONS "-O3;-funroll-loops"
        COMPILE_DEFINITIONS "SID_ENGINE_DUAL;libcsid_init=csid_init;libcsid_free=csid_free;libcsid_load=csid_load;libcsid_play=csid_play;libcsid_render=csid_render;libcsid_getauthor=csid_getauthor;libcsid_getinfo=csid_getinfo;libcsid_gettitle=csid_gettitle;libcsid_get_total_tunes_number=csid_get_total_tunes_number;libcsid_get_default_tune_number=csid_get_default_tune_number;libcsid_stream_fill=csid_stream_fill;subtune=csid_subtune;SID_model=csid_SID_model;sid_frame_calls=csid_frame_calls;sid_cpu_calls=csid_sid_cpu_calls")
else()
    set_source_files_properties(src/sid/crsid/libcRSID.c
        PROPERTIES COMPILE_OPTIONS "${SID_ENGINE_FLAGS}")
endif()

# Version string shown on the display; build.sh passes -DSIDCLOCK_VERSION=<x.y.z>
# and uses the same value for the MCUboot image header.
if(NOT DEFINED SIDCLOCK_VERSION)
    set(SIDCLOCK_VERSION "dev")
endif()
target_compile_definitions(app PRIVATE SIDCLOCK_VERSION="${SIDCLOCK_VERSION}")

# Debug build (build.sh: SIDCLOCK_DEBUG=1 ./build.sh): compiles the bring-up
# test commands (test tones, rate/tone ladders, raw MCKFREQ) back in and
# selects the larger RTT log buffer via app/prj_debug.conf. Release builds
# leave them out (-0.5 KB RAM, and no test surface on a shipped unit) and
# show no suffix; debug images show "-dbg" next to the version. The signed
# image version stays the same either way, so OTA compares like-for-like.
if(SIDCLOCK_DEBUG)
    set(SIDCLOCK_DEBUG_SUFFIX "-dbg")
    target_compile_definitions(app PRIVATE SIDCLOCK_DEBUG=1)
else()
    set(SIDCLOCK_DEBUG_SUFFIX "")
endif()
message(STATUS "SidClock debug build: ${SIDCLOCK_DEBUG_SUFFIX}")
target_compile_definitions(app PRIVATE SIDCLOCK_DEBUG_SUFFIX="${SIDCLOCK_DEBUG_SUFFIX}")
