# Bare-metal RV32EMC toolchain (no Zephyr, no west).
# The riscv64-zephyr-elf bin dir must be on PATH (build.sh does that).
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR riscv)

set(CMAKE_C_COMPILER riscv64-zephyr-elf-gcc)
set(CMAKE_ASM_COMPILER riscv64-zephyr-elf-gcc)
set(CMAKE_OBJCOPY riscv64-zephyr-elf-objcopy CACHE FILEPATH "objcopy")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# VPR core: RV32E + M + C (see riscv,isa in the SoC DTS).
add_compile_options(-march=rv32emc -mabi=ilp32e)
add_link_options(-march=rv32emc -mabi=ilp32e)
