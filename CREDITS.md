# Third-party credits and licenses

HTMLSATURN is distributed under the **GPL v2 or later** (see LICENSE), because it incorporates
and/or ports the following GPL components.

## EstyJS — Motorola 68000 CPU core

- File: `vendor/estyjs-processor.js`
- Use: core of the Saturn's 68EC000 sound coprocessor (wrapped by `m68k.js`).
- Original author (2013-2024): Darren Coles
- Maintainer (since 2024): Kai Eckert
- Repo: https://github.com/kaiec/EstyJS
- License: GNU GPL v2 or later (UAE/WinUAE lineage).
- **HTMLSATURN's modifications** (marked in the file):
  - Interrupts are delivered at the level returned by `mfp.doInterrupts()` (the original delivered
    them fixed at level 6). The Saturn's sound driver uses level 2 (Timer B via SCILV1).
  - `exII()`: the 68EC000 is a 68000 and does NOT have the "full extension index" (that is
    68020+). The original aborted with `Fatal(SAEE_CPU_68020_Required, ...)`, a constant that
    isn't even defined in the core, so it blew up with a ReferenceError. It now always decodes as
    a brief extension.
  - `getRegs()`: a new read-only accessor to the register bank (`regs`). The original core only
    exposed `setSnapshotRegs()` (write) and kept `regs` locked inside the closure, so it was
    impossible to observe the 68000's state from outside: neither to debug the BIOS's sound driver
    nor to write tests for the core (see `m68k.test.mjs`). It doesn't change any execution logic.
  - `setRowCycles(n)`: a new method to set `frameRowCycles`, the size of the block `runCode()`
    executes. The original had it hard-wired at 512, which is one scanline of the Atari ST (the
    machine EstyJs emulates). The Saturn's 68EC000 has no scanlines: its clock hangs off the audio
    crystal (11.2896 MHz) and has to mesh with the SH-2, so we need blocks of exactly N cycles. It
    doesn't change the logic of `runCode()`: the `tot_cycles` carry the core already had means the
    leftover from the last instruction is neither lost nor duplicated even if N changes between
    calls.

## Yabause — ports of several chips

- Repo: https://github.com/Yabause/yabause
- License: GNU GPL v2 or later.
- Authors: (c) 2004 Stephane Dallongeville, (c) 2004-2007 Theo Berkau,
  (c) 2006 Guillaume Duhamel, (c) 2012 Chris Lord, and contributors.
- HTMLSATURN files with code ported from Yabause:
  - `scsp.js` — the SCSP's audio engine: synthesis core of the 32 slots (phase/pitch, EG
    envelope, 8/16-bit PCM reading, key-on/off, TL, panning and stereo mixing). Port of the
    "classic" engine (`slot_t`) from `scsp.c`.
  - `vdp1.js` — sprite/polygon renderer: color formats, Gouraud, clipping, half-transparency,
    mesh, end codes and affine texture mapping. Ported from `vdp1.c` / `vidsoft.c`.
  - `vdp2.js` — background renderer: NBG0-3 (tiles and bitmap), priorities, scroll, backdrop and
    rotated RBG0 (parameter and coefficient tables). Ported from `vdp2.c` / `vidsoft.c` /
    `vidshared.c`.
  - `cd.js` — disc image reader: offsets of the Saturn CD-ROM header (`Cs2GetIP` from `cs2.c`)
    and cue/bin parsing (`LoadBinCue` from `cdbase.c`).
  - `scu.js` — the SCU's DSP: instruction set and control registers, ported from `scudsp.c`.

## Mednafen / Beetle Saturn — reference and ports of the SMPC, CD block and SCU

- Repo: https://mednafen.github.io/ — libretro port:
  https://github.com/libretro/beetle-saturn-libretro
- License: GNU GPL v2.
- Authors: Mednafen Team (Ryphecha and contributors).
- HTMLSATURN files with code/layout ported from Mednafen:
  - `bus.js` — SMPC: the INTBACK's two-phase handshake, the exact layout of the status block, RTC
    (date/time in BCD) and the SETTIME command (from `smpc.c`).
  - `bus.js` — CD block: command codes and their dispatch, drive states, HIRQ flags, the 200
    sector buffers, the 24 partitions and the filter chain (conditions and true/false
    connections), the TOC format, the transfer to the host (DTR) and disc authentication (from
    `cdb.cpp`).
  - `bus.js` — SCU: interrupt table (bits/levels/vectors) and the 3 DMA channels (from
    `scu.inc`).
  - `scsp.js` — SCSP: timers, interrupts (SCIPD/SCIEB/SCILV, MCIPD/MCIEB) and the IRQ level
    delivered to the 68k, plus the effects DSP (from `scsp.inc` / `scsp.h`).

## Dexie.js — IndexedDB wrapper

- File: `dexie.min.js`
- Use: persistence of the BIOS and the backup RAM (memory card) in the browser.
- Repo: https://github.com/dexie/Dexie.js
- License: Apache-2.0 (GPL-compatible).

## What is NOT distributed

The Sega Saturn **BIOS** and the **games' disc images** are the property of their respective owners
and **are not part of this repository** (see `.gitignore`). Everyone must use their own.
