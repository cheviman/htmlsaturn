# HTMLSATURN — Pending

The single working document: **what is missing, what has already been measured, what the next step
is**.

> **The project's rules are in `CLAUDE.md`** (faithful to the hardware, from general to specific
> with the hardware's behavior as the source, the correctness criterion, the measurement method and
> the commit rule). They are not duplicated here: this file holds only the state.
>
> **And the rule that governs this file: if it's done, it goes.** This is what is MISSING, not a
> history — finished work is already in git, in the commit message and in the code comments, which
> is where people look. The only two exceptions are the **dead hypotheses with their measurement**
> (so nobody proposes them again) and the **design decisions in force** (what is modeled and what
> isn't, and why).

---

## 0. State of the 10 games (`diag/health.mjs`, 2,500 frames)

| game | boots | a CPU halted | image | colors | audio |
|---|---|---|---|---|---|
| Sega Rally | yes | no | 80 % | 231 | yes |
| Virtua Cop | yes | no | 80 % | 229 | yes |
| SF Alpha | yes | no | 60 % | 1435 | yes |
| Sonic 3D | yes | no | 40 % | 5217 | yes |
| X-Men COTA | yes | no | 56 % | 79 | yes |
| Sega Touring Car | yes | no | 80 % | 275 | yes |
| Daytona CCE | yes | no | 76 % | 383 | yes |
| Daytona USA | yes | no | 56 % | 144 | yes |
| Virtua Fighter 2 | yes | no | 64 % | 1129 | yes |
| X-Men VS | yes | no | 64 % | 79 | yes |

⚠ `health.mjs` runs **headless and without pressing START**, so it doesn't exercise the worker, the
audio, the canvas, or the gameplay path. The browser side is measured with the `[frames]` log (see
§5).

**Server:** `node serve.mjs --sab` → http://localhost:8099/index.html. The `--sab` is not optional
for measuring: without it there is no `SharedArrayBuffer`, and without that neither the VDP1 worker
nor the 4 VDP2 threads start, which means a different path is being tested.

### How each game runs in Chrome, measured (29-07-2026)

| game | state | the number |
|---|---|---|
| **SF Alpha** | 60/60 | `throttles 0/s`, `emul` 1.3-6.6 ms |
| **Virtua Cop** | 58-60/s | `throttles 0-5/s` |
| **Sega Rally** | runs well | it is the most sensitive control there is: the one that broke most often |
| **Touring Car** | *"much better"* (Sebas, translated) | and it had the decision "it is not tackled" |
| **Daytona USA** | **44-50/s**, playable | both bottlenecks maxed out: see §1 |


## 1. ★ THE MAIN FRONT: PERFORMANCE

Sebas (translated), comparing against real gameplay: ***"it's missing a huge amount of speed"***.

**Today ONE case is left, and it is measured: Daytona USA at 44-50 of 60 frames (73-83 %).** The
other four that were tested in Chrome run at 58-60/s. What sets USA apart is that **both
bottlenecks are saturated at the same time**:

```
inside median 12-17 ms, p95 25        <- the VDP1 plot (headless gives 12.7-15.3: it matches)
[PERF] emul 15-18 ms x 50-59 raf/s    <- the main thread at 90-106%
SKIPPED 0/s · 100% DISTINCT frames · AUDIO-SKIP 0/s · late == throttles
```

Daytona **CCE** had the main thread at 44-70 %; **USA** has it maxed out. That fits with USA using
the slave for 3D and CCE not — that is, twice the SH-2 work. And the idle-skip, which is set to 44
precisely because of the Daytona slave's wait loop (+46 % back then), **doesn't help it in
gameplay**: there the slave isn't idle any more, it is working.

✔ The healthy part, so nobody looks at it again: not a single frame is lost (`SKIPPED 0/s`,
`100 % distinct`) nor an audio sample, and `late` matches `throttles`, which means throttling is the
only cause of the delay. **Nothing is lost: it is just slow.**

### ⚠ AND THE TWO KNOWN WAYS OUT ARE MEASURED AND DON'T GET THERE

| way out | measured ceiling |
|---|---|
| split the VDP1 plot across 4 threads | **1.45×** (the VDP2 gave 3.94×) — see below |
| the five SH-2 avenues | **all negative** — see §7 |
| micro-optimize the VDP2 | ceiling **5 %** — see §7 |

**This is not fixed by anything identified so far.** It needs a new idea, not more effort on the
known ones. The only two threads not yet exhausted:

1. **The 57-59 % COMMON part of the VDP1 plot** (walking the list, interpolating, reading textures).
   It is per-pixel work, not splitting overhead, and nobody has tackled it yet.
2. ~~The master/slave split~~ → **DEAD with measurement**: the USA slave never goes above 15 % and
   CCE uses it MORE (22 %). See below.

### ✖ Splitting the VDP1 plot across threads: DEAD, with the ceiling measured (29-07-2026)

Measured **before writing the refactor**, with `diag/vdp1-plot-ceiling.mjs`.

**The reason is structural: a VDP1 "scanline" is NOT a framebuffer row.** The VDP2 rasterizes
independent rows, so thread *k* takes lines *k, k+N, k+2N*. The VDP1 walks a **command list** and,
in a distorted sprite, each iteration goes from `(xL,yL)` to `(xR,yR)`: a **diagonal** crossing
several rows. It can't be split by skipping iterations — only by filtering **per pixel**, and then
**every thread pays in full** for the walk, the interpolation and the textures.

| scene | common | splittable | **ceiling with 4 threads** |
|---|---|---|---|
| xmenvs (attract) | 58.8 % | 41.2 % | **1.45×** |
| daycce (`INPUT=1`, in-game) | 57.4 % | 42.6 % | **1.47×** |
| *(the VDP2, for comparison)* | — | — | **3.94×** (98 % efficiency) |

**Two different scenes, the same proportion: it belongs to the CHIP.** And it is an **upper** bound,
with no synchronization or contention.

⚠ **The trap the probe had to dodge:** the right ablation is `_putpixel`, **not** `_pixelDraw`. The
cut-off of the drawing is governed by `_getpixel` from inside `_pixelDraw`, so neutralizing it
entirely would make the loop run too long — it would change the load and measure something else.
⚠ **And without `INPUT=1` it can't be measured:** the headless daycce plot costs **0.042 ms** and
the vf2 one **0.128 ms**, buried in noise (the probe's control rejected both runs, which is what it
has to do). Where the plot weighs is **in-game**.

### ✖ AND THE SLAVE WAS NOT THE CULPRIT: DEAD, with measurement (29-07-2026)

It was the only thread left unexhausted, and it came from this very document: *"USA uses the slave
for 3D and CCE doesn't, that is, twice the SH-2 work"*, backed by an outside source (*"Daytona USA
is one of the games that uses 100% slave CPU"*). **It is false.**

`diag/cpu-split.mjs` (new probe), time and instructions per CPU:

| | master | **slave** | instr master | instr slave |
|---|---|---|---|---|
| **daytona** (attract) | 87 % | **13 %** | 172,797 | 19,985 |
| **daytona** (`INPUT=1`) | 85 % | **15 %** | 94,049 | 12,437 |
| **daycce** (`INPUT=1`) | 78 % | **22 %** | 153,878 | 38,032 |
| daycce (attract, control) | 99 % | 1 % | 182,278 | 508 |
| rally | 95 % | 5 % | 240,102 | 10,667 |
| sfa | 92 % | 8 % | 187,385 | 14,552 |

**The USA slave never goes above 15 % in any scene, and CCE uses it MORE (22 %).** So the difference
between the two Daytonas is not in the master/slave split.

✔ **Both controls pass:** daycce in attract gives **1 % and 508 instructions**, so the probe does
separate the CPUs; and `ns/instr` comes out even between master and slave (90 vs 113 in Daytona),
which means **the cycle split is healthy** — no CPU costs disproportionately. Both SH-2s run at the
same frequency and the same work costs the same.

⚠ And an honest note on the scope: with `INPUT=1` USA executes **fewer** instructions than in
attract (94k against 172k), which means pressing START every 30 frames takes it to **some** screen,
not necessarily the race gameplay Sebas saw in Chrome. What the data does support, in the two
scenes measured, is that **the slave is not the one in charge**.

→ **With this the performance front is left without any identified thread.** The bottleneck is the
master, and the master's five avenues are measured and lost (§7). The only thing not yet tackled is
the **57-59 % common part of the VDP1 plot** (walk, interpolation and textures), which is per-pixel
work. **It needs a new idea, not more effort on the known ones.**


### 1.2 ⚠ THE STRUCTURAL COST OF BACKPRESSURE — a design decision, keep it written down

Throttling the emulation **keeps every video frame** —which is what was asked for— **but steals
samples from the audio**, because audio runs in real time and video doesn't. With
`throttles 21-25/s` the console emulates 50 of 60 frames (83 %): the SCSP generates 83 % of the
samples while Web Audio consumes 44,100 Hz of wall-clock time, and the worklet fills the rest with silence. An
effect that sounds, cuts out and comes back **is heard as repeated** — which was the Rally report.

**No audio tweak fixes it: the only cure is having no throttling.** It checks itself: in the
stretches with `throttles 0/s` and `emulated 60/s` there are no cuts and no repetition.

### 1.3 The fifth VDP2 band: ON HOLD, not discarded

The main thread has headroom in most games, but **splitting the VDP2 better is useless while the
one throttling is the VDP1 worker**: milliseconds would be gained on the chip that already keeps up.
It is picked up again **if and only if** the VDP1 plot comes down and the VDP2 is the ceiling again.

What was thought through, so it isn't derived again:
- It doesn't contradict the *"with 5 threads it gets worse"* of `diag/threads-ceiling.mjs`: there it
  was 5 workers **in addition to** the main thread, that is, six rasterizers competing. These would
  be five, and one is the thread that's already there.
- **The delicate part:** the main thread can't block waiting for the workers (it would hang the rAF).
  It has to rasterize its band right after dispatching and leave the composition asynchronous.
- Measure the ceiling before writing it, as was done with the 4 threads.

### ⚠ Touring Car is not tackled (Sebas's decision, 27-07-2026) — and it improved on its own

Its problem is not a huntable bug: it asks for **twice the pixels of any other game** (315,392
against 78,848) with the field optimization already applied — of its 15.35 ms, **13.68 are
`vdp2.render`** at 704x448 with `LSMD=3`; without the optimization it would be ~26.

★ **And its symptom went down with no specific work.** It had *"still slow, the 3D disappears when
accelerating, the render isn't consistent"* (Sebas, translated), and when the counter's spurious
throttles went away, so did the skipping that froze the whole frame. Its own diagnosis predicted
it. It is what the repo's rule says happens when the general cause is fixed instead of the
particular case.


## 2. FIDELITY: WHAT IS MISSING, WITH ITS SOURCE

Sweeps of each chip's full register and command map **against the code**, with their probes. The
five chips are swept; the only one missing is the SCU, and its sweep is not valid (§2.5).

| chip | registers / commands | emulated | missing |
|---|---|---|---|
| SH-2 (on-chip) | 97 | 58 | **39, and they are ONLY TWO MODULES**: the **UBC** (30, debugging) and the **BSC** (9, wait states and refresh). Everything else is at 100 % |
| VDP2 | 144 | 93 | **51**, grouped into features |
| **VDP1** | 11 | 10 | **1: `ENDR`** |
| **SMPC** | 16 commands | 15 | **1: `SYSRES`** |
| **CD block** | 64 commands | **64** | **0** — closed |

Re-measured on 29-07-2026 with the register sweep: the **DMAC (19/19)** and the **INTC (3/3)**
became complete with `DRCR0`/`DRCR1` and the `ICR`, and the old table didn't reflect it. Per module:
`SCI 4/4 · FRT 8/8 · WDT 4/4 · DIVU 7/7 · DMAC 19/19 · INTC 3/3 · Cache 1/1 · Power 2/2`.

⚠ **Limits of the parser, so as not to read too much into it:** some rows glue the name to its bits
(`ICRNIMIL` is `ICR`) and the module column carries over when a row doesn't repeat it
(`VCRA`/`VCRB` come out under BSC and are INTC). **The addresses and the cross-check are right**;
the names, sometimes truncated.

### 2.1 ★ VDP1 TIME-SLICED DRAWING — the machinery is there, the worker coupling is missing

**What was done on 29-07-2026:**

- `_drawCommands(budget)` is **reentrant**: it consumes commands until it has spent `budget` pixels
  and, if it didn't reach the `END`, it saves the state (`addr`, guard, the CALL/RETURN stack) and
  returns `false` so the caller resumes it. With the default it behaves as before.
- **`COPR` advances during drawing**: on hardware it is continually updated during command
  processing, and we didn't do that.
- Cutting off mid-list **neither raises `CEF` nor fires Draw End**, which is how the hardware
  behaves: CEF is set when the draw end command is **fetched**.
- The budget **is charged per pixel actually put** (`_putpixel`), not by an estimate.
- 13 tests, verified in reverse (with the old `vdp1.js` they give 6 failures).

### ⚠ THE REAL KNOT, and why "one more batch" isn't enough: THE WORKER

**In worker mode the charging can't work.** There the drawing commands don't rasterize on the main
thread —the worker puts the pixels—, so `_putpixel` isn't called, the counter stays at 0 and with a
finite budget the walk **would never stop**.

And it can't be papered over with an estimate: the one based on the command's area was tried and
**it underestimates the peaks at 14-40 %**, measured against the real pixels from
`diag/vdp1-load.mjs`:

| | real (avg / peak) | estimated | ratio |
|---|---|---|---|
| xmenvs | 88,790 / **178,621** | 50,712 / 71,140 | 57 % / **40 %** |
| touring | 10,307 / **109,397** | 11,914 / 15,447 | 116 % / **14 %** |

**The reason is in the hardware:** rasterization walks the **quad's scanlines**, so it
**overdraws** — in a tilted quad the same pixel is painted several times and the hardware pays for
every pass. The geometric area can't see that. **A budget that underestimates is worse than none.**

→ **For the split to exist on the browser path, the worker has to split too** —that is, answer in
slices—, and that means **redesigning the VDP1↔worker coupling**, not adding a line. That coupling
has today: the snapshot that freezes the frame state, `vdp1WorkerPlotPending` accumulating edges
between dispatches, and races already documented as *"erratic by nature"* (the `geoBank`). It is
the next step of this item and **goes alone in its own batch**.

### ⚠ And a correction of what this document said about the item

It is not *"delay the notification by the cost of the list"*. The comment on `vdp1.plot()` is
explicit: **the swap is executed at the end of `plot()`, one frame earlier than on hardware**, and
`BEF`, `LOPR` and `CEF` are all calibrated around that. So the missing step **touches the chip's
frame model**, and that explains why the earlier shortcut broke two games halfway (X-Men COTA
56 % → 16 %, X-Men VS 64 % → 12 %).

**The other two hang from this**, and they come with the split and not before:
- **`ENDR`** (`0x10000C`). On hardware it forces termination of the drawing currently being
  processed, and interrupted drawing cannot be resumed. Today it can't do anything because at the
  moment the game writes it there **is no** drawing in progress. ⚠ And its consumer is minimal:
  **2 writes** in 10 games × 1,500 frames.
- **The pseudo draw continuation.**


### ✖ 2.2 WAIT STATES: the B-Bus model does NOT explain what was measured. Not implemented.

It was *"the biggest performance lever left"*, with this arithmetic: the SH-2 makes 62,647 data
accesses per frame, 29,177 to the B-Bus, and every wait cycle we don't charge is 14 % of the frame.
**Today it is closed as not implementable with what there is**, and the road there is worth having
written down because three things died in order.

**1. First it looked like the data was missing.** No known source gives the B-Bus penalty. What is
specified are the **A-Bus** waits (`ASR0`/`ASR1`), and the A-Bus is **268 of the 62,647** accesses:
0.4 %, it doesn't move the needle.

**2. Then the model turned up: the VDP2 VRAM access model.** There are eight memory cycles per pixel
(four in hi-res mode), VRAM is split into up to 4 banks, and the **cycle pattern registers**
(`0x010`-`0x01E`) say who accesses which bank in which cycle — with value **14 = "CPU data"** and
**15 = "nobody can access VRAM"**. The registers were decoded (`vdp2._readPatternsCycle`, 18
tests).

**3. And the prediction the model implies FAILS.** If the CPU only accesses in the cycles with
value 14, a game with `cpuPerPixel = 0` shouldn't be able to touch VDP2 VRAM during display.
Measured by crossing `diag/vdp2-cycles.mjs` with `diag/bbus-when.mjs` (accesses **to VDP2 VRAM** per
frame, separated by moment):

| game | `cpuPerPixel` | in display | in vblank |
|---|---|---|---|
| **sfa** | **0.0** | **3,036** | 66 |
| **touring** | **0.0** | **886** | 270 |
| **rally** | **0.0** | **317** | 28 |
| **xmen** | **0.0** | **20** | 6 |
| vc | 5.5 | 114 | 8 |
| sonic | 3.7 | 243 | 58 |

**The four with zero reserved cycles touch it anyway**, and SF Alpha 3,036 times per frame. If the
hardware blocked the CPU, that would be impossible with the game running.

**The reading that would fit** —and which **no known source states**, so it is a hypothesis: the
cycle patterns **reserve** accesses for the VDP2's consumers and **the CPU uses the gaps left
over**, that is, `15` means *"no VDP2 consumer"* and not *"not the CPU either"*. With 8 cycles × 320
× 224 there are **573,440 memory cycles per frame**, and SFA's 3,036 are **0.5 %**: it slips in
easily.

→ **Not implemented.** Charging a wait on a model that doesn't explain what is observed would be
making up the number — the same thing that already killed the Mednafen-rates hypothesis.
`cpuPerPixel` stays exposed and without a consumer, with this measurement written at the site
(`vdp2.js`).

⚠ **And there is a ceiling that bounds the expectation even if the model turned up:** slowing the
SH-2 down by **+40 %** —which covers the whole estimated range of 14-42 %— **did not unstick
Daytona**, it only moved its hang by 43 frames. Wait states would be fidelity and **more slowness**,
not performance: charging them makes the SH-2 execute fewer instructions per frame, not the
emulator run faster.


### ~~2.3 The SMPC per-command timings~~ → **DONE on 29-07-2026, except INTBACK**

Each SMPC command has its own execution time on hardware, and we were giving **2,000 cycles
(~75 µs) to all of them**. Now it comes from the per-command table (`SMPC_LATENCY` in `bus.js`),
converted to SH-2 cycles:

| time | commands |
|---|---|
| **30 µs** | MSHON, SSHON, SSHOFF, SNDON, SNDOFF, NMIREQ, RESENAB, RESDISA (the class B ones) |
| **40 µs** | CDON, CDOFF, SETSMEM |
| **70 µs** | SETTIME |
| **100 ms + α** | SYSRES, CKCHG352, CKCHG320 — that is **~6 NTSC frames** |

**Observable impact: none.** A/B with a control run on the spot (`git stash`):
`screen-activity.mjs` with 20 samples over 4,000 frames gives **identical results in all three
metrics** (image, color peak and variance) for sonic, daycce and rally. `health.mjs` only moves the
color peak (+100 sonic, +5 daycce, nothing goes down), and that is the snapshot of **one** frame —
the metric this document has noted as invalid for comparing timings.

The CKCHGs were the only big change (×1,300), but they are issued **once per game and at boot**
(measured: 10 CKCHG352 and 1 CKCHG320 across the 10 games), that is, exactly when real hardware
also resynchronizes the video.

### ⚠ 2.3-bis WHAT IS LEFT: the INTBACK's unit

**INTBACK (0x10) was left out on purpose.** Its nominal time is given as **"320m"**, where *"μ"*
stands for microseconds and *"m"* for milliseconds — but **320 ms is incompatible with what was
measured**: the 10 games issue **~0.8 INTBACK per frame** (16.68 ms) and wait for its answer. They
are **12,058 of 12,345 commands** (`diag/smpc-commands.mjs`): with 320 ms they couldn't.

⚠ **Already searched, so the search isn't repeated:** no other figure for the INTBACK's time turned
up anywhere; the "320m" is the only one there is, and it can't be read reliably.
→ **What would close it:** a reliable figure for the INTBACK's execution time.

### 2.3-ter ★ TWO SMPC COMMANDS NO SOURCE DOCUMENTS: `0x0A` and `0x0B`

**Sega Rally and Daytona CCE issue them** (they are the same engine), twice each and at boot, from
`0x0603300e`, `0x06033062` (high WRAM) and `0x00280fd2` (low WRAM) — that is, **the game, not the
BIOS**.

**They are not among the 16 known SMPC commands** **nor in the third-party sources** consulted. The
suspicion —because of the game that issues them, and because those same games probe the
communications port through the SCI— is that they are **NetLink on/off**, but **it is an
unverified suspicion and nothing was implemented on it**.

Today they fall into the switch's `default`: they lower SF, do nothing and report to the radar. **It
breaks nothing** (both games run). It stays with a `//?` at the exact spot in `bus.js`.
→ It is also the proof that the switch's `default` was worth it: before, it swallowed them silently
and this would never have been seen.


### ~~2.4 The VDP2 registers nobody reads~~ → **CLOSED on 29-07-2026**

All 144 registers of the chip **have their decision written down**. The number went down from 71 →
51 → 38 → **19**, and not because anything was implemented: because **the sweep was lying in four
different ways**, all now corrected in the VDP2 register sweep:

| what the probe didn't see | what it wrongly flagged as missing |
|---|---|
| the access **width** (`_rl` reads a LONG: it consumes `off` **and** `off+2`) | the fractional zoom, which WAS there |
| the **file**: it only looked at `vdp2.js` | `PRISA-D` and `CCRSA-D` — the sprite layer is composed by **`vdp1.js`** |
| the offset computed from a **literal** (`0xF0 + ((i>>1)<<1)`) | the same 8 |
| the offset computed from a **variable** (`baseReg = 0x50 / 0x60`) | the **16** pattern name maps of the rotation screens |

**The lesson, which is already a pattern:** in a sweep the access width lies, the file being
searched lies, and the computed offset lies — from a literal and from a variable. A parser can't
follow the last one without interpreting the program, so there goes a list of **exceptions
verified by hand**, each one with its site in the source so it can be re-checked.

And of the 19 that were left, **none was new debt**:

| offsets | what it is | decision |
|---|---|---|
| `0x002` `0x004` | `EXTEN` / `EXLTFG` — external signals | already decided: the external latch is the **light gun**, which we don't emulate (`bus.js`) |
| `0x024` `0x026` `0x0EA` `0x0EE` | `SFSEL` / `SFCODE` / `SFPRMD` / `SFCCMD` — **special color calculation** | already documented at the top of `vdp2.js` |
| `0x0B8` `0x0BA` | `OVPNRA` / `RBOPN` — screen over pattern name | already with `//?`: mode 1 is treated as 0, and it is marked as a Yabause-ism |
| `0x0FE` | — | **Reserved** on hardware. It is not a gap |
| **`0x010`-`0x01E`** (8) | **VRAM cycle patterns** | ★ **the big missing feature.** `//?` in place, see §2.2 |
| `0x098` | `ZMCTL` — zoom half / quarter | `//?` in place: its natural consumer is the cycle patterns |
| `0x0B2` | `RxxxSTRE` — parameter read enable | `//?` in place: see below |

→ **All that is left of the VDP2 are two features, both with their note at the site:**

**a) The cycle patterns (`0x010`-`0x01E`).** There are eight memory cycles per pixel (four in
hi-res mode), VRAM is split into up to 4 banks (up to 32 accesses per pixel) and each 4-bit field
says who accesses which bank in which cycle — with value **14 = "CPU data"**. We read VRAM when we
need it, without modeling the allocation. **It is the model the wait states are missing** (§2.2).

**b) `RxxxSTRE` (`0x0B2`), the Parameter Read Enable.** On hardware, 0 means the selected parameter
is not read per line and 1 means it is read per line, for `Xst`, `Yst` and `KAst` of the two
rotation parameters. With those bits at 1 **the chip fetches all three again on EVERY LINE**, so
the rotation can change row by row — which is how a perspective floor is done. We freeze them when
the frame opens (`_readTableRotation`, one read per frame). It wasn't implemented because moving
that read to per-line is a change on the hot path of the rotation render.


### 2.5 Cross-checks: what is left unchecked

✔ **Cross-checked and CLOSED** (written down so nobody reopens them): `ARFEN` (the A-bus refresh
register, `25FE00B8`) is `(W)` write-only, so its initial value isn't observable, and we don't
model A-bus refresh — unlike `IMS`, which was readable **and** governed behavior; `RSEL` (SDRAM
select, `25FE00C4`) is correct by construction: it starts at 0 and the boot ROM sets it to 1; and
the byte count of a DMA in progress is write-only, so reading it is a restriction on the
programmer, not behavior to model. Sprite shadows and the VRAM cycle patterns are cross-checked and
their conclusions live in §2.4, §2.2 and §4.6. The window that becomes invalid with a vertical end
coordinate of `1FCH`-`1FFH` in interlaced hi-res was left with a `//?` in `_readCoordWindow`.

⚠ **The only thing not cross-checked: the ~40 hardware notes that don't touch pieces we already
emulate.** They weren't swept whole; they were cross-checked by topic. If it ever pays to go back,
the method that worked was searching by register (`grep` for the address), not reading them in
order.

⚠ **The SCU sweep is NOT valid and can't be cited.** Two attempts: v1 only took
`(Register: XXXX)` (12 registers of a chip that has many more) and gave false positives; v2 gives
*"61 registers, 37 emulated"* **but the map is contaminated** with offsets that are noise from the
bit diagrams (`0x17`, `0x37`, `0x57`) and repeated names. **The SCU's register map can't be parsed
with this method.** The SCU is already audited by hand.


## 3. SEBAS'S OPEN REPORTS

### 3.1 Sprite priority/order — needs Sebas, 10 seconds

**Already audited against the hardware's behavior, and the logic CHECKS OUT**: the sprite wins a
tie, the PR bits index PRISA-D, the direct-RGB path uses register 0, and `_readPrioritiesSprite`
reads all four registers correctly.

**It couldn't be reproduced headless**: blind input doesn't navigate the menus to those screens. On
the Sonic screen that can be reached, NBG2/NBG3 (the priority-7 layers, the ones that would go **in
front of** the sprites) contribute **zero pixels** because their pattern name tables
(0x68000/0x6C000) are **empty in VRAM** — the addresses were verified against MPABN2/MPABN3 and the
page size from PNCN2/PNCN3, and they come out right.

→ **NEXT STEP:** get to the bad screen and run **`window._prioDiag()`**. It returns the sprite type,
the 8 priorities, the VDP2 layers **with how many pixels each one contributes**, and the per-pixel
cross-check. With that it can be told whether the HUD isn't drawn (a layer with 0 pixels) or loses
priority.

### ~~3.2 The desynchronized start~~ → **DONE on 29-07-2026** (tested in Chrome)

It was: when switching to worker mode the main thread **stops rasterizing**, but the worker's first
frame hasn't arrived yet, so for a few rAFs what was left from the warmup gets painted.

**The cause was that `vdp1.workerMode` did TWO things at once:** enable dispatching to the worker
**and** turn off rasterizing on the main thread. Now they are separated:

- with the `{ready}` the **dispatching** starts (`vdp1WorkerDispatch`) and the main thread **keeps
  rasterizing**;
- `vdp1.workerMode` is turned on only when **the worker's first complete frame arrives** (in
  `publishComplete()`, which is the only point that knows the frame is whole).

It costs a few frames of duplicated work at startup and in exchange **not a single frame is left
without an owner**.

⚠ And the backpressure now looks at `vdp1WorkerDispatch` and not at `workerMode`: during those
frames dispatching happens with `workerMode` still false, and if the throttle were driven by
`workerMode` the queue would grow without bound right there.

**Tested in Chrome** (`node serve.mjs --sab`, Daytona USA loaded): `workerMode` starts **false**
and becomes **true** when the first complete frame arrives, with both console messages in order.
The control with the old code gives `workerMode = true` from the `{ready}` on, which is exactly the
difference being looked for.

⚠ **And a measurement trap to remember for testing the browser from here:** with the tab out of
focus **Chrome freezes `requestAnimationFrame`** and the emulator doesn't advance a single cycle
(`cyclesAdvanced: 0` with `running: true`). It is false positive no. 7 of Rule 0. The way that
works is calling `runFrame()` by hand, yielding with **`MessageChannel`**, which Chrome doesn't
throttle.
⚠ And to load a disc from JS you have to pass it **all** the tracks: the `.cue` references them by
name and with only the cue + track 1 the reader fails silently (it stays at `disc: no disc`).

---

## 4. DESIGN DECISIONS IN FORCE (what is modeled and what isn't, and why)

This is not finished work: it is the frame. It is here so it doesn't get reopened or "fixed" the
wrong way.

### 4.1 ★ This emulates a Saturn with a MODE-type ODE

In an **ODE** there is no physical seek —the data comes from an SD card— and **ODEs have no known
compatibility problems**. That is: **real hardware** exists where the seek is ~0 and the games run
just the same, so raising it isn't "more faithful", it is moving away from a regime that works.

And the fine distinction, from Sebas (translated) (*"the SAROO goes through a card, here it
should be like the MODE, which sits on the drive"*), which defines what has to be modeled:

| family | what it replaces | does the CD block's SH-1 stay? |
|---|---|---|
| **SAROO** | the **whole CD block** | no |
| **MODE / Fenrir / Rhea-Phoebe** | **only the drive** | **yes** |

**This emulator is the second case**: we emulate the complete CD block (commands, filters,
partitions, ISO9660) and what is replaced is the drive mechanism. From that it follows, without
ambiguity:

- **The SH-1's command latency: YES** — the CD block is there in both configurations. It is what
  moved four games at once.
- **The mechanical seek: NO** — it doesn't exist in that configuration. The current 200 ms are even
  conservative.
- **The optical drive's cache/read-ahead: NO** — it comes off the list, it is not debt.

Also verified in the SAROO firmware (`Firm_Saturn/cdblock.c`): it doesn't simulate seek times or
rotational latency; it serves the sectors as soon as they are available.

### 4.2 The fallback to synchronous does NOT exist, on purpose

The video worker is no longer turned off for slowness or for an exception in a frame. The only thing
that turns it off is `new Worker()` failing, and then synchronous isn't a fallback: it is the only
mode there is. **Why** (Sebas, translated: *"it must not fall back to synchronous, we already talked
about this"*):

- **it changes the mode behind your back**, and everything measured afterwards measures something
  else;
- **it goes back to a stale path**: in worker mode the main thread rasterizes nothing, so
  `bus.vdp1Fb` stays frozen on the warmup screen;
- and above all **it covers up the bug** right when it shows up. A worker that doesn't answer has to
  look like what it is —the video freezes— and not be disguised as *"it works, but weird"*.

**Accepted risk:** with a truly HUNG worker each frame queues a snapshot that its queue retains, and
that is a leak. That's why there is the 32-frame warning. It doesn't cut itself off, on purpose.

### 4.3 No URL parameters to choose the path

Sebas rejected it explicitly (translated): *"if you send it a parameter you're doing a hack"*. Two
paths make the old one rot without anybody testing it. (The diagnostic ones remain:
`?noworker=1`, `?queuecap=2`.)

### 4.4 Numbers that depend on another are written IN TERMS of that other

Lesson from the third time it broke: the SAB slots had been sized for the UNBOUNDED queue and became
decoupled when the backpressure bounded it. Today `SNAP_SLOTS = VDP1_THROTTLE_QUEUE + 1`, not a
copied number.

### 4.5 Publishing on a host: the headers don't break anything

If the host doesn't send COOP/COEP, `crossOriginIsolated` is false, the usual copy path is used and
the emulator works **exactly the same** — it only loses ~1.0 ms. It turns on by itself where it
can.

| where | SAB? | |
|---|---|---|
| Netlify / Vercel / Cloudflare Pages | **yes** | `_headers`, `vercel.json` or `netlify.toml` |
| Own Apache / nginx | **yes** | two lines of config |
| **GitHub Pages** | **no** | doesn't allow configuring headers → fallback |
| `file://` | no | there isn't even a worker there (Chrome blocks it) |

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The external resources the page uses already cooperate (measured): `cdn.jsdelivr.net`,
`fonts.googleapis.com` and `fonts.gstatic.com` answer with
`Cross-Origin-Resource-Policy: cross-origin`. ⚠ The downside is for the future: a new external resource that does **not** send
CORP (a YouTube iframe, analytics) **is** blocked by `require-corp`.

### 4.6 Hardware features no game uses

Measured that none of the test games asks for them → documented with `//?` **at the exact spot in
the code** where they would go, without implementing them blindly.

| chip | feature | note |
|---|---|---|
| VDP2 | Special color calc (SFCCMD/SFCODE/SFSEL/SFPRMD) | only **Rally**, and it is a visible no-op (CCCTL off) |
| VDP2 | Sprite window | mask assumed empty; `//?` in `vdp2.js` |
| VDP1 | HSS (High Speed Shrink) | check whether any game asks for it |
| SH-2 | UBC (break controller) | dev/debug, no game (the 30 registers, measured) |
| SH-2 | `VCRA`/`VCRB` (SCI vectors) | 11 writes, **0 reads**. We don't generate SCI IRQs —the games poll `SSR`—, so the vector isn't needed. If `TIE`/`RIE` are ever modeled, the piece goes here |
| SH-2 | `MCR`, `RTCSR`, `RTCOR` (BSC refresh) | 0 reads. We don't model bus timing |
| SMPC | full CKCHG + `SYSRES` | partial: the 320/352 dot-select is there |
| SCU | cost of DMA to the cartridge from ASR0 | fixed at ~5 today |

**The SCU is audited entirely: that is not where the remaining bugs live. Don't re-audit it.**
**Complete (don't touch):** SCSP · CD block (commands + ISO9660) · SCU.

### 4.7 Verified and RIGHT — so nobody "fixes" it the wrong way

- **The V-Counter in normal mode.** It returns the line straight (`VCT9=V9 … VCT0=V0`), not the
  one-bit-shifted layout (`VCT9=V8 … VCT0=Invalid`) found in some register tables. We already
  returned the raw line: we were right, and **the reference we had said otherwise**. It is written
  down in `bus.js`.
- **The SCU registers that were REMOVED.** The DMA status (`25FE0070`-`007C`) and DMA forced
  termination (`25FE0060`) registers **were removed from the hardware's specification**, though
  older register maps still list them. **We act on neither**: they fall into the raw bank and do
  nothing, which is correct. → Written down **so nobody implements them from an old register map**,
  which is the real risk here.
- **The SCU indirect DMA table**: 3 long words in the order `[count, write, read]`, the table is
  pointed to by `DxW` and the end is bit 31 of the read address. **It matches entirely.**
- **A DMA activation trigger that occurs during DMA execution is held for only ONE execution**:
  we comply **by construction**, `scuDmaBuilt` is one boolean per channel.

---

## 5. Diagnostic tools

| Tool | What for |
|---|---|
| **`diag/sh2-oracle.mjs`** | **THE MODEL FOR THE CORRECTNESS CRITERION** (`CLAUDE.md`): 6,770 edge cases against each instruction's specified behavior. That is why the SH-2 never shows up as a suspect. **An oracle against the specification can't fossilize a bug**, because its reference is external to the emulator — it is the form to copy for the other chips |
| **`diag/health.mjs`** | **The sweep: the 10 games, boot / CPU halted / image / audio.** It is the one that says which item is still alive |
| `diag/screen-activity.mjs` | % of samples with an image. **It is what to use to compare two timing models**, not the smoke test (see trap 3) |
| **`diag/disassemble.mjs`** | **Dumps a disassembled range WITH THE PC-relative LITERALS ALREADY RESOLVED.** It uncovered that Daytona's "task counter" was the SMPC's `OREG0` |
| **`diag/speed-sensitivity.mjs`** | **Separates "phase race" from "missing piece"**: slows the SH-2 down by a given % and says whether the frame of the hang moves. Useful for measuring the wait-state ceiling before writing them |
| **`diag/vdp1-plot-ceiling.mjs`** | **The ceiling of splitting the VDP1 plot across N threads, BEFORE writing the refactor.** Separates what each thread would pay in full (walk, interpolation, textures) from what is splittable (writing the pixel). Three controls: identical load, `control-2`, and counterbalancing. **With `INPUT=1`**, otherwise the headless plot doesn't weigh anything and the noise buries it |
| **`diag/intback-cadence.mjs`** | **HOW MANY times per frame we deliver peripherals and how many System Manager IRQs come out of that**, with the commands that caused them |
| **`diag/smpc-commands.mjs`** | Inventory of SMPC commands per game, against the 16 known commands: which are used, how many times, and **which fall OUTSIDE the table** with the PC that wrote them. It found `0x0A`/`0x0B` |
| **`diag/vdp2-shadows.mjs`** | Which games ask for sprite shadows and of what kind, crossing `SDCTL` (who accepts them), `SPCTL` (whether the mode allows the MSB) and the type. **It self-verifies**: it writes the registers by hand and checks it sees them, so a "0 %" isn't confused with reading the wrong register |
| **`diag/vdp2-cycles.mjs`** | Which VRAM access allocation each game asks for in the cycle pattern registers, and how many per pixel it leaves to the CPU. Control: it counts the frames with the screen ON, because the cycle patterns of a display that is off mean nothing |
| **`diag/cpu-split.mjs`** | **How much of the emulation time EACH CPU takes**, with instructions and ns/instruction. Answers whether the bottleneck is the master, the slave or the split. Two controls: a game that doesn't use the slave, and an even `ns/instr` (which is what says the split is healthy). ⚠ The absolutes are inflated by the wrapper: the proportion is what counts |
| **`diag/vdp1-observable.mjs`** | **Who WATCHES the VDP1's drawing progress** (`COPR`/`EDSR`/`LOPR`/`ENDR` and the Draw End IRQ). Answers whether time-sliced drawing would have a consumer before taking on the refactor. Control: it counts the triggers (`PTMR`/`FBCR`), which everybody writes |
| **`diag/bbus-when.mjs`** | **WHEN** the SH-2 accesses the B-Bus: active display or V blank. It is the ceiling of charging wait states, because during V blank the CPU accesses VRAM freely. ⚠ Its absolute value is not validated; **the proportion is what counts**. It hooks on the **CPU** (not on the bus) and normalizes the cache region |
| `diag/where-is.mjs` | Where the CPU is parked **without assuming there's a spin loop**, with IMASK and requested/serviced IRQs. What to run when `what-waits.mjs` answers "none detected", which says nothing |
| `diag/divergence-since.mjs` | Compares the path of two frames **starting at a precise event** (a write of a certain value, or passing through a PC) |
| `diag/sci-trace.mjs` | Timeline of SCI accesses with the transmitter's state, collapsing the polling. It answers the ORDER, which is what `sci-usage.mjs` doesn't give |
| **`diag/pulses.mjs`** | **Registers a game writes and REVERTS within the same frame**: it looks for the shape of the trigger-vs-level bug without knowing which game it is |
| **`diag/stuck-waits.mjs`** | **DEAD waits in all the games, without knowing which game it is. The detector that scales.** Today all 10 pass |
| `diag/what-waits.mjs` | The game is spinning: **which address it polls and what its value is**. If nobody writes it, whoever should is missing |
| **`diag/full-loop.mjs`** | The loop a CPU is locked in, WHOLE: PCs, disassembly and **every** read with its values. Useful where `what-waits.mjs` doesn't reach |
| **`diag/address-trace.mjs`** | Timeline of an address: every write with frame, PC, value, `IMASK` and **at what % of the frame** it lands, against the **serviced** IRQs. Control: it also counts the **requested** ones |
| **`diag/pc-literals.mjs`** | Resolves **all** the PC-relative literals of a stretch: which address each one loads, what's there and **who writes it** |
| **`diag/register-at-pc.mjs`** | What the SH-2 registers hold when passing through a PC. **Resolves pointer accesses that bus probes don't see** |
| **`diag/what-happens-between.mjs`** | Between an IRQ and a write: is the CPU **working or waiting**? Histogram of PCs plus the addresses read |
| `diag/path-to-write.mjs` | The last N PCs **before** each write: how it got there |
| **`diag/radar-onchip.mjs`** | **The SH-2's on-chip blind spot**: which registers the games touch and which ones we DON'T consume, crossing against the source. It found `DRCR0`/`DRCR1` |
| **`diag/sci-usage.mjs`** | **Which games use the serial port and how**, with the `SCR` broken down (RE/TE/CKE). It found that 7 of 10 use it |
| **`diag/sh2-ablation-ceiling.mjs`** | **The ceiling of optimizing the SH-2, BEFORE writing anything.** Each branch in its own process, interleaved and **counterbalanced**, with a contamination control (steps/frame and hash) |
| `diag/bench-sh2.mjs` | ms/frame + state hash. Every optimization has to **speed up AND leave the hash identical** |
| `diag/bench-video.mjs` | The same for VIDEO. **The criterion for touching the VDP2** |
| `diag/bench-audio.mjs` | Cost of the audio engine (worst case, 32 slots) |
| `diag/audio-hash.mjs` | Hash of the PCM. **The criterion for touching the SCSP** |
| `diag/thread-split.mjs` | How much work per frame falls to **each thread**. Interleaved control by minimums |
| `diag/threads-ceiling.mjs` | Ceiling of splitting `vdp2.render` into N bands with **real threads** over SAB. Reports the synchronization floor and verifies the hash against 1 thread |
| `diag/bands-ceiling.mjs` | The same **in a single thread**. It is an UPPER BOUND: it doesn't see memory contention |
| `diag/interleave-cost.mjs` | How much `cdTick`/`hblankTick`/`scspTick` weigh. **Wraps, doesn't remove**, counterbalanced and with a wrapper control |
| `diag/instr-per-frame.mjs` | Instructions, cycles and **% of idle-skip**. Gives away whether the CPU charges a fixed 1 cycle |
| `diag/read-cpuprof.mjs` | Summarizes a V8 `.cpuprofile` by self time. It found almost everything on perf |
| `diag/scsp-fidelity.mjs` | Which SCSP registers the game touches and which we consume; where each slot comes out. With `INPUT=1` |
| `diag/68k-alive.mjs` / `68k-jump.mjs` | Whether the sound 68k is alive, and why it jumps outside sound RAM |
| `diag/slave-what-waits.mjs` | Disassembles a CPU's dominant loop and says what it reads. 3rd argument `slave` or `master` |
| `diag/hot-boot.mjs` | Boots **like the browser**: mounts the disc hot |
| `diag/reset-in-chunk.mjs` | Forces an SH-2 reset in the middle of a chunk. Verified in reverse |
| `diag/resolution.mjs` | Which resolution each game asks for and which one we give it |
| `diag/cd-commands.mjs` | Inventory of CD commands requested against implemented (64/64) |
| `diag/iso-check.mjs` | Validates the filesystem of the 10 discs. All 10 are OK |
| `diag/vdp1-load.mjs` | Pixels per frame the VDP1 asks for. ✔ The double counting in 8 bpp **is already fixed** (it wraps only `_putpixel`), so its numbers serve as a reference |
| `diag/vdp2-scroll-subpixel.mjs` | Whether any game uses sub-pixel scroll **and with zoom**, which is the only thing that changes a pixel |
| `diag/vbe-trail.mjs` | The SF Alpha trail, with its control |
| `diag/layer-shapes.mjs` | How many hidden classes `layer` has. Run with `--allow-natives-syntax` |
| `diag/render-cost.mjs` | How much painting a frame costs and in which part |
| `diag/rasterized-lines.mjs` | How many lines the VDP2 rasterizes per frame. Answers whether the interlace 2x is taken (it is) |
| `diag/irqs-per-frame.mjs` | Rate of SCU IRQs **per vector**: compares timing models |
| `diag/scu-dma-factors.mjs` | Which activation factor each DMA channel uses. The 10 games use **only 7** (immediate) |
| `diag/scu-dma-alignment.mjs` | How many SCU DMAs come unaligned to a long word |
| `diag/dma-cycles.mjs` | DMA bytes per frame: the ceiling of the bus cost |
| `diag/scsp-sh2-accesses.mjs` | How many times per frame the SH-2 touches the sound block — the ceiling of the MCRDYN wait |
| `diag/dsp-live.mjs` | Live steps of the SCSP DSP's microprogram |
| `diag/audio-throughput.mjs` | Sample throughput and silent frames |
| `diag/cache-active.mjs` / `cache-perf.mjs` | Whether the instruction cache is doing anything and how much it costs |
| `diag/flicker.mjs` | The VDP1's erase/plot/swap cycle per frame, without the worker. Separates "the engine flickers" from "the browser flickers" |
| `diag/cpu-writes-fb.mjs` | Does the CPU draw by hand into the VDP1 framebuffer? (0 in rally/touring/daycce) |
| `diag/waits-all.mjs` | Runs `what-waits.mjs` over the 10 discs and groups **by CHIP**: which piece is missing the transition and how many games wait for it |
| `diag/jump-to-bios.mjs` | How the CPU got to the BIOS: dumps the path, not the destination |
| `diag/radar-cost.mjs` | Cost of the MMIO radar + ranking of unknown addresses |
| `diag/control.mjs` | Rule 0 in code: the control scaffolding every probe must use |
| `node orphans.mjs` | Declared pieces nobody connects (17 today) |
| `bus.mmioUnknown` | MMIO radar. **On.** Protocol: `clear()` at the hang and wait |
| `window._perf` / `[PERF]` | Browser profiler per rAF |
| `window._audioDiag()` | Audio state **with `latencyMs`** |
| `window._prioDiag()` | Sprite order, on the screen that looks wrong |

### How to read the browser log (`[frames]`, every 2 s)

- **`emulated`** — the REAL speed of the emulator. It dropping below 60 **is not frame loss**: it
  is the backpressure doing its job.
- **`SKIPPED`** — it has to be **0/s**. Each one would be a game frame that doesn't exist.
- **`throttles`** — how many rAFs per second throttled waiting for the worker.
- **`queue max`** — can't go above `VDP1_THROTTLE_QUEUE`.
- **`worker median / p95 / max`** against **`inside`** — `worker` includes the time waiting in the
  queue; `inside` is the work alone. **A median that grows without coming back = V8
  deoptimization; a stable median with a high max = GC.**
- ⚠ **`drawTv NOT painted` is NOT a bug** (it was wrongly flagged once): the rAF runs at the
  monitor's rate and the emulation at 60, so many rAFs legitimately have no new frame.
- ⚠ **Don't look at the `% seen`**: at 144 Hz the same frame is repainted. Look at `painted/s`
  against 60.

---

## 6. Known measurement traps

### ★ RULE 0 — no probe reports without a control

Sebas's request after **seven false positives in one session** (translated): *"you keep getting
false positives, your measurement system is no good, you have to change it"*. The pattern was always
the same: write a probe, run it **once** and believe the first number.

| what I "found" | what it was |
|---|---|
| "the drive doesn't deliver sectors" | the FAD bit goes in the low byte of CR1, not in CR3 |
| "Play doesn't reach the end of the range" | I asked for 250 sectors with 200 buffers: they fill up first |
| "BFUL doesn't go up" | `0xFFFFFF` means "the range from last time" |
| "the filter doesn't connect" | the flags go in the low byte of CR1; with 0 nothing connects |
| "the SH-2 executes nothing" | I hooked the wrong object (`mod.cpu` vs `bus.cpuMaster`) |
| "the audio generates 2229 % of the samples" | I read the buffer's SIZE, not what was generated |
| "the emulator runs at 0.1 fps in Chrome" | the tab was in the background and Chrome **freezes the rAF** |

**The three rules that come out of that** (in code: `diag/control.mjs`):

1. **Every probe needs a CONTROL**: run it also where the answer is ALREADY known.
2. **If the measurement says something basic is broken, the suspect is the probe.** The 10 games
   boot, read from the CD and draw. An absurd value (negative, infinite, 2229 %) is **always** a
   measurement bug, never a finding.
3. **Measure where the problem shows.** Drawing conclusions about the browser by measuring headless
   is invalid, however tidy the number.

**And how the browser CAN be measured without Sebas:** don't use the rAF. Chrome freezes it in
background tabs, but **`MessageChannel` isn't throttled**. Calling `runFrame()` by hand and yielding
with `MessageChannel` measures the real cost per frame with the worker active — and to see the
screen you have to call `drawTv()` explicitly.

### ⚠⚠ Interleaved A/B is NOT ENOUGH: the order has to be COUNTERBALANCED

It applies to **any** measurement with separate processes. With the fixed order `A,B,C` the branch
that runs **first in each round performs systematically better** (CPU state, caches and turbo after
the previous process): the bias reached **4.5 %**, the same order as many effects we look for. The
case in point: measuring the page shortcut on the data path, the change came out worse in 4/4
reps… **and the control —IDENTICAL code— also came out worse in 4/4**. Rotating the order of the
branches in each rep, the same experiment gave **control vs control-2 = 0.0 % and MIXED**, and only
then was the result readable.

**And the criterion that holds is the SIGN rep by rep, not the difference of minimums.** Raw runs of
the SAME branch spread **6-18 %** between processes. A control/control-2 pair that gives 2.2 % isn't
measuring "the noise": it is measuring the order.

### ⚠ A test written against observed behavior FOSSILIZES the bug

It happened **four documented times**: 64 of 179 CD checks encoded the instantaneous model, SCSP
test 3d required a muted slot to stay muted, the FM one tested modulation with `MDL=4` (which on
hardware is off), and the SCI one required that clearing `TDRE` without `TE` leave the flag at 0 —
which is what we did and not what the hardware does. **An oracle against the specification can't
fossilize anything**, because its reference is external to the emulator.

### The rest of the traps, numbered

1. **Headless does NOT see the browser path.** Not the worker, not the audio, not the canvas, not
   the hot boot. On 25-07 the battery was green, the smoke test fine and the hashes stable **with
   the emulator broken** (no game loaded).
2. **A loop cut-off against a cumulative CPU counter is written RELATIVE.** The SH-2 counters get
   reset (`cpu.reset()` sets `cycles = 0`) and the reset gives no warning. An absolute target left
   one frame executing **147 million instructions**.
3. **The smoke test is useless for comparing two timing models.** It takes ONE snapshot at frame N:
   if the change makes the game reach each screen earlier or later, the snapshot lands at another
   moment. Worse: **the BIOS menu has MORE colors than a game's boot**, so going off to the BIOS can
   read as an improvement. Use `screen-activity.mjs`.
4. **Verify the probe IN REVERSE, with the old code.** A probe or a test that doesn't reproduce the
   bug is worth nothing.
5. **`M68K` doesn't expose `.pc`** (that belongs to the EstyJs core): it is read with
   `k.cpu.getRegs().pc`. `k.pc` gives `undefined`, and `undefined >>> 0` is **0** — it looks dead
   at PC=0 and runs fine.
6. **`vdp1._fbDisplay` is a `Uint8Array`**: the pixel's word is built with `vdp1._fbRead()`.
   Reading it as bytes gives PR=0 everywhere and makes you believe sprite priority was lost.
7. **Don't destructure `cpu`/`cpuSlave`** from the `headless.mjs` import: `reset()` reassigns them,
   and besides **the reset CREATES A NEW SH-2**. Use `bus.cpuMaster` / `bus.cpuSlave` **and re-take
   them every frame**. It is the mistake that gave *"the slave executed NOTHING"* with the slave
   running right next to it.
8. Probes that navigate **by frame number** land on a different screen every run. Navigate by
   STATE (wait for the signature).
9. **`vdp1.compose()` returns the SPRITES WITH ALPHA**, not the final composite. Comparing its RGB
   against `vdp2.fb` gives 99.7 % false differences: you have to look at **the alpha**.
10. `while(...) runFrame()` **blocks the thread** → the rAF doesn't run. Set `running = false`
    before measuring.
11. `cpu.step()` in a `for` **doesn't fire VBlank or HBlank**: a `uniquePcs: 3` obtained that way
    doesn't mean "hung".
12. **Never rewrite files with accents via PowerShell** (`Set-Content`/`-replace`): it corrupts the
    encoding.
13. **A round trip with queuing inside doesn't measure the cost of the service.** That is where the
    inflated count that justified the unbounded queue came from. Measure `inside`, not `worker`.
14. **A probe that removes the bug's condition can't find it.** The 1-to-1 worker/synchronous
    comparisons waited for each answer —that is, with no latency— and gave "0 differences" with a
    latency bug inside. The same with the ablation of the idle-loop snapshot and of the timers: set
    to no-op they give **335,595 steps/frame against 7,385**, because without them the idle-skip
    never fires. **Those two pieces can't be measured by ablation.**
15. **A histogram's cut-off can't be smaller than the loops you want to detect.**
    `what-happens-between.mjs` classified a **16**-instruction wait loop as *"WORKING (spread
    out)"* because it looked at the **8** most visited PCs. Now it looks at 24.
16. **A probe that survives a refactor without being updated lies with the face of data.** The
    SCSP's *"5 of 32 slots depend on the shortcut"* came from looking at `s.disll`/`s.efsll`, fields
    the gains refactor had deleted: `undefined !== 31` is true.
17. **The access width matters in sweeps.** A parser that only looks at the literal offset accuses a
    register that is read as part of a long (`_rl`) or of a pair of bytes of being "never read". It
    happened on the SH-2 on-chip registers (IPRA/IPRB/VCRD) and on the VDP2 (the fractional zoom).
18. **A register that is present is not a register that is modeled.** Sweeps that ask "does the
    source consume that offset?" count as emulated a raw bank with **not a single line of
    behavior**. It is how the SCI passed for "emulated" for months.
19. **A streak without activity isn't a hang if it ends.** The detector in
    `speed-sensitivity.mjs` said "hung" even for Rally until it was required that the streak
    **reach the end of the run**; and the boot has to be skipped, where hundreds of frames go by
    without a single serviced IRQ.
20. **A counter has to be able to ADD UP with the others and give the total.**
    `rAF = painted + NOT painted + AUDIO-SKIP`: a counter placed **inside** a function doesn't see
    the times the function wasn't called, and that is what kept an entire false trail alive (the "skip because of audio"
    that didn't exist). And watch the **units**: a report that mixes "per second" with "window
    total" makes the count not add up and sends you looking for an emulator bug that is in the log.
21. **When the code and a statistical signature contradict each other, the signature can be a
    coincidence and the code can't.** `48 painted with the rAF at 144` is exactly `144/3` and came
    out spot on in four samples — it looked conclusive and was false. The right move was to
    instrument, not "fix": a fix there would have touched a branch that never executes.
22. **The noise of this machine is bigger than what is being looked for**: the same code measured
    15.2 / 15.5 / 11.3 ms.

---

## 7. DEAD hypotheses with measurement — don't propose them again

### On the Daytona USA hang (solved on 29-07-2026)

- **"It is a phase race that gets fixed with wait states."** It is a race —the frame of the hang
  moved with the CPU's speed: 1097 (−15 %), 1107 (0 %), 1115 (+10 %), 1133 (+25 %), **1150
  (+40 %)**—, but **slowing the CPU by 40 %, which covers the whole estimated range (14-42 %), only
  postponed it by 43 frames.**
- **"SCI RECEPTION (`RDRF`/`ORER`/`FER`/`PER`) is missing."** The loop where the game was waiting
  IS the reception loop, so it looked like a sure thing. **There is nothing to implement:** the 7
  games configure `SCR=0x12`, that is, **RE=1 with `CKE=2`, EXTERNAL clock through SCK**. In
  synchronous mode with an external clock the SCI generates no pulses: with no cable there is no
  clock and `RDRF` never goes up — which is what we already did. **Implementing "receive garbage"
  would have been a mistake.**
- **"The dispatcher wins the race against VBlank-OUT and that's why the timeout fires."** The
  timeout counter reaches 3 in frames **1097, 1099, 1103 and 1106**, and **only the last one
  hung**; and the VBlank-OUT reset happens at 14.5 % **also** in the frame that hung.
- **"The master waits for the SMPC's `SF`."** With the master already hung, `SF=0` and no command
  pending.
- **"The dead slave is the cause."** It was a symptom: the slave **starts already inside** its wait
  loop on the FRT's ICF (with SSHON at frame 664 its initial PC is the loop's first instruction),
  that is, the game designed it that way. There was never anything to fix on its side.
- ⚠ **"CCE and USA are the same engine."** **False** (Sebas, translated): *"Daytona CCE's engine is
  Sega Rally's, the regular Daytona's isn't"*. CCE running **never said anything** about USA. The
  reasoning came back twice.
- **"It runs in PAL"** (with the European BIOS it gave 80 % against 12 %): false, all of them were
  on the BIOS's *"disc from another region"* screen, which runs from high WRAM, and that's why the
  high PC is misleading.

### SH-2 performance — the five avenues, all measured and lost

All with **steps/frame and hash identical to the control**, so they don't execute anything
different: they cost more.

| avenue | result | why |
|---|---|---|
| **The JIT** (3 variants, a prototype that executes) | **−20 to −38.5 %**, worse in 3/3 reps | and the 25-35 % ceiling that justified it **didn't exist**: the probe only measured the fetch (~8-9 %) |
| **Cached interpreter** by address (from Kronos) | **−22.5 %**, worse in 3/3 | `readInstr` already solves the common case with one page comparison; a 2 MB `Int32Array` per CPU adds cache pressure without removing work |
| **Event-driven timers** instead of per instruction | **−15/−48 %**, worse in 6/6 | the flush has to be done at the 3 points where the state is observed, and with the idle-skip calling `runDry` it comes out more expensive than the tick |
| **Page shortcut on the DATA path** | **−11.3 %**, worse in 6/6 | **41 % hit rate** against the ~100 % of the fetch. Locality is what made the fetch one work, not saving calls: data jumps between stack, globals, VRAM and MMIO |
| *inline fetch skipping `readWord`'s checks* · *moving the instruction loop inside the SH-2* | slower (6 %) | V8 already optimizes the original loop better |

**The general lesson: the per-instruction toll isn't the fat; the fat is the interpreter's work
itself.** The only thing left of the data shortcut would be a 2- or 4-way version (one slot for the
stack and another for the data), and it would have to raise the hit rate a lot to pay for the extra
comparison.

⚠ **And don't raise the idle-skip "just in case":** it is at 44 because Daytona's loop measures 42
(+46.4 % in that game, identical hashes). At **64** SF Alpha sinks **−29.1 %**. The limit is raised
when there is a measured loop that doesn't fit, not before.

### VDP2 performance — closed with a number

The three micro-optimizations failed with interleaved A/B and identical hash: *color without
allocating* (**33 % slower** — V8 already does escape analysis of the short-lived `[r,g,b]` and
forcing a heap buffer adds real writes with a GC barrier), *memo of the pattern name per cell* (+2 %,
noise) and *a single hidden class for `layer`* (no effect).

**And the one that closes the door: the ceiling of removing ALL of the pixel's location work** (plane,
page, pattern name and its decoding, stubbed to a fixed color) **is 5 %**. The time isn't in the
logic: it is in the **VRAM and CRAM reads**, that is, genuine per-pixel work.

→ **Corollary: the only lever on the VDP2 is to rasterize FEWER PIXELS** (what double-density did)
**or spread them over more threads** (what multithreading did). What is left on that line: skip
rasterizing layers that end up entirely under an opaque layer — today they are computed and
discarded in the compositor.

### On the SCSP

- **"The SH-2 has to be charged the SCSP's wait."** The hardware has it, and it looked like the same
  pattern that moved four games with the CD. **It isn't:** the SH-2 touches the SCSP registers
  **0.8 times per frame** (1.2 for SF Alpha). Even charging a whole memory cycle per access that is
  **4-6 cycles of the 447,443**, that is, **0.001 % of the frame**. The one that talks to the SCSP
  is the **68000**. Implementing it would touch the SH-2's hot path to move a thousandth of a
  percent.
- **"Interleave the SCSP and the 68000 per sample."** The cost was measured and was cheap (+0.03 ms
  per frame of 16.68). **It was implemented and it broke Sega Rally**: from 80 % image and 230
  colors to **28 % and 144**, without moving the other 9. Reverted. What stays noted: **Rally is
  sensitive to the ORDER in which cycles are handed to the 68000**, not just to how many — and that
  holds for any future change to the interleave.
- **The SCSP DSP (9 %) is closed with a number.** Two attempts (compacting the live steps; moving
  the state into locals) gave 0.2-0.9 %, within noise. The reason: the microprogram has **107 of
  128 steps alive**, 78,752 steps per frame at **16 ns** each — genuine work, not overhead. The only
  thing that would lower it is compiling the microprogram into a JS function (3-4 % of the frame,
  high risk). **Don't propose the two attempts again.**
- **And the output shortcut the hardware doesn't have** (*"if DISDL is muted, use EFSDL as the
  direct level"*, inherited from Yabause) **is removed and confirmed by listening to it.** If an
  effect goes missing again, the bug is **earlier** —in how that slot reaches the DSP— and it gets
  fixed there. The real culprit the first time was the **generation of the sound stack for FM**,
  implemented as a fixed offset per slot when it uses a 64-entry ring.

### On the SCU and DMA

- **"Charge the SH-2 the DMA's bus cost with Mednafen's rates."** **No known source gives a DMA
  transfer rate for the SCU**: the only cycle figures are the A-Bus's *configurable wait states*,
  not the DMA's speed. Taking the rates from `ss/scu.inc` would be a **-ism**. The ceiling is
  measured (**5-56 KB per frame on average, peaks of 368-524 KB**, that is, up to 82-117 % of the
  frame as an upper bound), so the piece matters — but **it isn't implemented with made-up
  numbers**.
- **"The SCU's `IMS` delay"** (Mednafen hangs *Loaded* for not modeling it): ⚠ **no known source
  gives that delay**, so copying it would be a `-ism`. What did come out of looking into it, and is
  already done, is the **IMS reset value**.

### On the VDP1

- **"Delay only Draw End by the cost of the list."** It was the obvious shortcut to avoid taking on
  time-sliced drawing. The time wasn't made up (the VDP1 draws into the framebuffer one pixel at a
  time, at a known clock) and the load was measured — the maximum delay was 40 % of a frame, plenty
  of room. **And it still broke**: `health.mjs` took **X-Men COTA from 56 % to 16 %** and **X-Men VS
  from 64 % to 12 %**. **The cause isn't the number, it is the starting point, and it is
  architectural:** `plot()` doesn't run when the plot is triggered, it runs **when the frame is
  closed**, so adding the cost to *that* instant doesn't delay the notification within the frame —
  **it pushes it to the next frame**. It is written down in `bus.vdp1EndDraw` so nobody repeats the
  shortcut.
- **Worker hang:** NaN or non-integer coordinates in the Bresenham — **0 cases in 19 million
  calls**.

### Ghosting and trail (closed)

- **Video ghosting** (it was the worker's cache and the bank geometry): the five on the path were
  real bugs but **none was the cause** — re-seeding the framebuffer on every skip · losing the
  swap's parity when merging edges with OR · the worker's banks not being cleared when switching
  games · the erases not reaching it · the cap `VDP1_WAIT_MAX = 2`.
  And what was firmly measured: **the worker rasterizes EXACTLY the same as synchronous mode** (504
  plots, 163 erases, 556 swaps, 112,165 commands in 900 frames of Rally).
  → **If something erratic comes back, the next suspect is the same mechanism in another table: the
  CRAM.** Colors are also read at composition time, with the same lag of one or two frames.
- **SF Alpha's sprite trail** (it was the VBE read as a level): looking at VBE at the moment the
  **FBCR** is written fixes nothing — **it was already tried and it doesn't fire**, because SFA
  lowers VBE **before** writing FBCR. What has to be captured is **the TVMR's edge**.
- **Rally's gray sky** (it was the SCU DMA's count): CRKTE=0 · CC off · color offset at identity ·
  fresh CRAM mirror · line color from the coefficient table · raster effect · CRAM bank/offset ·
  palette extraction from the pattern name.

### Pulses that are NOT triggers

Sonic pulses `PRINB` (VDP2 `0xEA`) `5→0→5` in 856 of 1800 frames and it looks huge — **it is
reconfiguration, not a trigger**: one routine (`0x6076c22`) clears PRINA/PRINB and another
(`0x606d68a`) reconfigures PRINB, and the **final** value is the right one. **Discriminant:** in a
trigger the pulse **is** the command and the final value says nothing; in a reconfiguration the final
value is correct and there is no bug.

### Assorted, from across the project

`vdp1.sysX1/sysY1` (the hardware fixes that corner at 0,0) · `cddaPending()` (the hardware doesn't
apply backpressure) · `setVblank`/`setHblank` (unobservable) · `intbackNextCont` (a flag that only
goes up is not a flag) · illegal-instruction exception (tried and reverted: it jumps to a handler
that is also erased) · **input as a cause of slowness** (INTBACK writes 2-7 bytes to the OREGs; what
weighs when spamming is the game's logic) · **the ISO and the seeks** (the whole CD costs 0.08
ms/frame and the image is in RAM) · duplicated rAF loops when switching games · structure leaks
(`irqPending` 0-1, `cd.free + cd.part` always 200 because it is a fixed pool, `mmioUnknown` 0:
nothing grows) · erasing the VDP1 pixel by pixel (optimized to a block copy with identical hash,
but the win is ~0.1 % of the frame) · **`0xFFFFFFB8`** (not a register: `H'FFFFFFB4`-`H'FFFFFFDF`
is **reserved** on hardware; the last real one is `DMAOR`).
