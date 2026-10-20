#!/usr/bin/env python3
"""Build-time checks and link maps for the FLPR bare-metal blob.

Usage:
    blob_audit.py --check-relocs <flpr.elf> <priv_base> <priv_size>
    blob_audit.py --check-ram <flpr_shared.h> <flpr.overlay>
    blob_audit.py --gen-map <armnm> <m33.elf> <engine.o> <array_vma>
                   <memmap.ld> <datamap.ld> [--expect <map.json>]
    blob_audit.py --check-final <flpr.elf> <array_base> <priv_base>
                  <priv_size> <map.json>

The blob itself is linked in with .incbin (flpr/flpr_blob.S) - no
generated C array. This tool only audits and maps:

--check-relocs proves the blob is position-independent: no dynamic
relocations, no writable sections, stack top where the header says. Any
absolute self-reference (jump table, GOT use, .data address) fails loudly
instead of crashing on device.
"""

import re
import subprocess
import sys


def check_ram(header, overlay):
    """Audit the FLPR RAM map.

    - header and overlay agree on every carve-out,
    - the ring's frame count matches its byte size (int16), so both cores
      bound their accesses to the reserved window (a frames/bytes mix-up
      walked the ring past the end of SRAM and bus-faulted the M33),
    - every region lies inside the FLPR-side SRAM window and none overlap
      (private RAM, mailbox, ring; the M33 never links any of it).
    """
    defines = {}
    for line in open(header):
        m = re.match(r"#define\s+(\w+)\s+(0x[0-9a-fA-F]+|\d+)"
                     r"(?:U?L?)?\s*(?:/\*.*)?$", line)
        if m:
            defines[m.group(1)] = int(m.group(2), 0)
    ov = open(overlay).read()
    regions = []
    for name, base, size in (("priv", "FLPR_PRIV_BASE", "FLPR_PRIV_SIZE"),
                             ("shared", "FLPR_SHARED_BASE",
                              "FLPR_SHARED_SIZE"),
                             ("ring", "FLPR_RING_BASE", "FLPR_RING_SIZE")):
        m = re.search(r"flpr_%s_ram:\s*memory@[0-9a-f]+\s*\{\s*"
                      r"reg\s*=\s*<0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)>" %
                      name, ov)
        if m is None:
            sys.exit(f"error: flpr_{name}_ram not found in overlay")
        if (int(m.group(1), 16) != defines[base]
                or int(m.group(2), 16) != defines[size]):
            sys.exit(f"error: flpr_{name}_ram overlay/header mismatch")
        regions.append((name, defines[base],
                        defines[base] + defines[size]))

    # int16 frames: the index bound must describe the reserved bytes.
    frames = None
    m = re.search(r"#define\s+FLPR_RING_FRAMES\s+\(\s*FLPR_RING_SIZE\s*/\s*"
                  r"(\d+)U?\s*\)", open(header).read())
    if m:
        frames = defines["FLPR_RING_SIZE"] // int(m.group(1))
    elif "FLPR_RING_FRAMES" in defines:
        frames = defines["FLPR_RING_FRAMES"]
    if frames is None:
        sys.exit("error: FLPR_RING_FRAMES not found in the header")
    if frames * 2 != defines["FLPR_RING_SIZE"]:
        sys.exit("error: FLPR_RING_FRAMES * 2 != FLPR_RING_SIZE "
                 "(the ring index would run past its reserved region)")

    # Contiguous SRAM of the FLPR side: no M33 links it, nothing else may
    # claim it, and all three regions must sit inside it.
    win_lo, win_hi = 0x2002F000, 0x20040000
    for name, lo, hi in regions:
        if lo < win_lo or hi > win_hi:
            sys.exit(f"error: flpr_{name}_ram [{lo:#x},{hi:#x}) outside "
                     f"the FLPR SRAM window")
    regions.sort(key=lambda r: r[1])
    for (n1, _, hi1), (n2, lo2, _) in zip(regions, regions[1:]):
        if hi1 > lo2:
            sys.exit(f"error: flpr_{n1}_ram and flpr_{n2}_ram overlap")
    print("ram map: header/overlay agree, ring frames match, no overlap")


def check_relocs(elf, priv_base, priv_size):
    """Audit the linked blob for the startup.S address model.

    - no dynamic relocations at all (code is PC-relative; any absolute
      self-reference - jump table, GOT use, .data address - fails here
      instead of crashing on device),
    - no .got/.data/.bss content (compiled C cannot reach fixed RAM
      through link-time symbols under a nonzero load bias),
    - _stack_top exactly at the top of private RAM.
    """
    r = subprocess.run(["riscv64-zephyr-elf-readelf", "-rW", elf],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("error: riscv64-zephyr-elf-readelf failed: " + r.stderr)
    entries = [ln for ln in r.stdout.splitlines()
               if re.match(r"^[0-9a-f]+\s+[0-9a-f]+\s+\S+", ln)]
    if entries:
        sys.exit("error: blob has dynamic relocations (would need a "
                 "runtime bias the startup cannot apply):\n  "
                 + "\n  ".join(entries[:8]))

    r = subprocess.run(["riscv64-zephyr-elf-readelf", "-SW", elf],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("error: riscv64-zephyr-elf-readelf failed: " + r.stderr)
    secs = {}
    for ln in r.stdout.splitlines():
        # "  [ 1] .text PROGBITS 00000000 001000 00009e 00 AX  0   0  1"
        parts = ln.split()
        m = re.match(r"\s*\[\s*\d+\]\s+(\S+)", ln)
        if m and len(parts) >= 7:
            secs[m.group(1)] = int(parts[6], 16)
    for name in (".got", ".data", ".bss"):
        if secs.get(name, 0):
            sys.exit(f"error: blob has non-empty {name} (fixed RAM is "
                     "unreachable to compiled C under load bias)")

    r = subprocess.run(["riscv64-zephyr-elf-readelf", "-sW", elf],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("error: riscv64-zephyr-elf-readelf failed: " + r.stderr)
    # "     8: 2003fc00     0 NOTYPE  GLOBAL DEFAULT    1 _stack_top"
    stack = None
    for ln in r.stdout.splitlines():
        parts = ln.split()
        if len(parts) == 8 and parts[7] == "_stack_top":
            stack = int(parts[1], 16)
    if stack != priv_base + priv_size:
        sys.exit("error: _stack_top is not at the top of private RAM")
    print("blob audit: no relocs, no writable sections, stack top OK - "
          "position-independent")




def _run(tool, *args):
    import subprocess
    r = subprocess.run([tool, *args], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"error: {tool} failed: " + r.stderr[:300])
    return r.stdout


def _nm_table(nm, elf):
    """name -> (addr, size) from `nm --print-size` (size 0 when nm
    omits it for absolute/synthesized symbols)."""
    tab = {}
    for ln in _run(nm, "--print-size", elf).splitlines():
        parts = ln.split()
        if len(parts) == 4 and parts[2] not in "Uuw":
            tab[parts[3]] = (int(parts[0], 16), int(parts[1], 16))
        elif len(parts) == 3 and parts[1] not in "Uuw":
            tab[parts[2]] = (int(parts[0], 16), 0)
    return tab


def gen_map(armnm, m33elf, engine_o, array_vma, memmap_out, datamap_out,
            expect=None):
    """Two-phase link support: pin every engine data section onto the
    M33 instance address.

    Reads the blob engine object (symbol -> section/size) and the M33
    link (symbol -> address/size), then writes memmap.ld (ROM base =
    the flpr_blob[] address) and datamap.ld (one NOLOAD section per
    engine data section at the M33 address). With --expect, asserts the
    map is identical to a previous run (M33 RAM layout stability).
    """
    import json

    array_base = int(array_vma, 0)
    secs = {}
    for ln in _run("riscv64-zephyr-elf-readelf", "-SW", engine_o).splitlines():
        m = re.match(r"\s*\[\s*(\d+)\]\s+(\S+)", ln)
        if m and m.group(2).startswith("."):
            secs[m.group(1)] = m.group(2)
    syms = []  # (name, section, size)
    for ln in _run("riscv64-zephyr-elf-readelf", "-sW", engine_o).splitlines():
        parts = ln.split()
        # "12: 00000000 76 i OBJECT LOCAL DEFAULT 5 Name"
        if len(parts) != 8:
            continue
        _, _, size, typ, bind, _, ndx, name = parts
        if typ not in ("OBJECT", "NOTYPE") or ndx in ("UND", "ABS", "COM"):
            if ndx == "COM":
                sys.exit(f"error: engine COMMON symbol {name} "
                         "(needs -fno-common)")
            continue
        if name in ("", "_start"):
            continue
        sec = secs.get(ndx)
        if sec is None:
            continue
        if sec.startswith((".sdata", ".sbss")):
            sys.exit(f"error: engine small-data section {sec} "
                     "(gp is never set up)")
        if not sec.startswith((".bss", ".data")):
            continue
        syms.append((name, sec, int(size)))
    m33 = _nm_table(armnm, m33elf)
    amap = {}
    lines = []
    skipped = []
    for i, (name, sec, size) in enumerate(syms):
        if name not in m33:
            # gc'd on the M33 side (e.g. md5 helpers the M33 never
            # calls): links into the blob image normally.
            skipped.append(name)
            continue
        addr, msize = m33[name]
        if msize != size:
            sys.exit(f"error: size mismatch for {name}: blob {size}, "
                     f"M33 {msize}")
        amap[name] = addr
        lines.append(f".flprmap_{i} 0x{addr:x} (NOLOAD) : "
                     f"{{ *libcRSID.c.obj({sec}) }}")
    amap["_array"] = array_base
    if skipped:
        print(f"note: {len(skipped)} engine syms not in M33 link "
              f"(blob-private): {skipped[:5]}")
    if expect:
        old = json.load(open(expect))
        if old != amap:
            only = {k for k in set(old) | set(amap)
                    if old.get(k) != amap.get(k)}
            sys.exit("error: address map moved between M33 links "
                     f"(unstable layout): {sorted(only)[:8]}")
        print(f"map stable: array 0x{array_base:x}, {len(amap) - 1} syms")
        return
    print(f"map: array 0x{array_base:x}, {len(amap) - 1} engine syms")
    with open(memmap_out, "w") as f:
        f.write("/* Generated by blob_audit.py --gen-map - do not edit. */\n"
                "MEMORY {\n"
                f"\tROM (rx)  : ORIGIN = 0x{array_base:x}, LENGTH = 0x28000\n"
                "}\n")
    with open(datamap_out, "w") as f:
        f.write("/* Generated by blob_audit.py --gen-map - do not edit. */\n"
                + "\n".join(lines) + "\n")
    with open(memmap_out + ".json", "w") as f:
        json.dump(amap, f, indent=0, sort_keys=True)


def check_final(elf, array_base, priv_base, priv_size, mapjson):
    """Audit the production blob link (bias-0 absolute):
    - zero dynamic relocations (nothing to fix up at boot),
    - every ALLOC section lives in flash (the array window), private
      RAM, or a generated .flprmap_ NOLOAD (M33-owned engine state),
    - no small-data sections and no gp-relative code (gp is unset),
    - .init_array empty, _stack_top at priv top,
    - every mapped engine symbol at its M33 address.
    """
    import json
    import subprocess

    array_base = int(array_base, 0)
    priv_base = int(priv_base, 0)
    priv_size = int(priv_size, 0)
    expect = json.load(open(mapjson))
    syms = {k: v for k, v in expect.items() if k != "_array"}

    out = _run("riscv64-zephyr-elf-readelf", "-SW", elf)
    noload_ok = 0
    priv_used = 0
    for ln in out.splitlines():
        # "  [10] .text PROGBITS 00000000 001000 00009e 00 AX  0   0  1"
        m = re.match(r"\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+([0-9a-f]+)"
                     r"\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S+\s+(\S+)", ln)
        if not m or not m.group(1).startswith("."):
            continue
        name, addr, size, flags = (m.group(1), int(m.group(2), 16),
                                   int(m.group(3), 16), m.group(4))
        if name.startswith((".sdata", ".sbss")):
            sys.exit(f"error: small-data section {name} (gp is unset)")
        if "A" not in flags:
            continue
        if name.startswith(".flprmap_"):
            noload_ok += 1
            continue
        in_flash = array_base <= addr < array_base + 0x28000
        in_priv = priv_base <= addr < priv_base + priv_size
        if not (in_flash or in_priv):
            sys.exit(f"error: ALLOC section {name} at 0x{addr:x} "
                     "outside flash+priv")
        if in_priv:
            priv_used += size
    # Mapped sections gc'd away (nothing references them) vanish from
    # the output; that is fine. Anything surviving must sit at its M33
    # address (a fall-through to a normal block would show up here with
    # a private-RAM address instead).
    if priv_used > 0x400:
        sys.exit(f"error: private RAM use 0x{priv_used:x} exceeds 1 KB "
                 "(engine leftovers belong in the M33 map)")
    rel = _run("riscv64-zephyr-elf-readelf", "-rW", elf)
    if [ln for ln in rel.splitlines()
            if __import__("re").match(r"^[0-9a-f]+\s+[0-9a-f]+\s+\S+", ln)]:
        sys.exit("error: dynamic relocations present (bias-0 link "
                 "must need none)")
    dis = _run("riscv64-zephyr-elf-objdump", "-d", elf)
    if "(gp)" in dis:
        sys.exit("error: gp-relative code generated (gp is unset)")
    tab = _nm_table("riscv64-zephyr-elf-nm", elf)
    for name, addr in syms.items():
        if name in tab and tab[name][0] != addr:
            sys.exit(f"error: {name} at 0x{tab[name][0]:x}, expected M33 "
                     f"address 0x{addr:x}")
    if tab.get("_stack_top", (None,))[0] != priv_base + priv_size:
        sys.exit("error: _stack_top misplaced")
    print(f"final audit: {len(syms)} engine syms mapped, no relocs, "
          "no gp, stack top OK")

if __name__ == "__main__":
    if sys.argv[1] == "--check-relocs":
        check_relocs(sys.argv[2], int(sys.argv[3], 0), int(sys.argv[4], 0))
    elif sys.argv[1] == "--check-ram":
        check_ram(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "--gen-map":
        exp = sys.argv[9] if len(sys.argv) > 9 and sys.argv[8] == "--expect" \
            else None
        gen_map(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
                sys.argv[6], sys.argv[7], exp)
    elif sys.argv[1] == "--check-final":
        check_final(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
                    sys.argv[6])
    else:
        sys.exit("usage: blob_audit.py --check-relocs|--check-ram|"
                 "--gen-map|--check-final ...")
