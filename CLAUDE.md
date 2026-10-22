# HTMLSATURN — a Sega Saturn emulator in JavaScript

## MAIN RULE: AS FAITHFUL TO THE HARDWARE AS POSSIBLE

This emulates hardware. **When in doubt, what the real circuit does wins**, not what makes a game
run. A shortcut that fixes a symptom and departs from the hardware is debt that gets paid with
interest: every new game asks for another shortcut, and the shortcuts contradict each other.

Practical consequences, all learned the hard way on this project:

- **The source of truth is how the real hardware behaves, not what other emulators do.** Yabause
  and Mednafen serve as hints, but **seven times the real hardware proved them wrong**, and seven
  times the hardware was right. If something is copied from an emulator, the comment says it is a
  "-ism" and it is marked for verification.
- **If two descriptions of the hardware's behavior disagree, one is chosen AND THE COMMENT SAYS
  WHY.** They aren't averaged and the easy one isn't picked (example: the MAC saturation in
  `sh2.js`).
- **The hardware TAKES TIME, and games synchronize on TRANSITIONS.** Any chip that answers with
  zero latency breaks the handshake the game programmed
  (`lower CMOK → write the command → wait for CMOK`). It was THE common cause of almost every failed boot: making the CD command take ~333 µs
  moved four games at once. Before adding a special case, ask whether what is missing is time.
- **If a circuit is emulated wrong, say so and fix the circuit** — not the symptom. It is better to
  say "this is not modeled" than to plug the hole with a heuristic: the heuristic becomes invisible
  and the next person inherits it as if it were the hardware.
- **What isn't known about the hardware isn't made up.** It is marked with `//?` at the exact spot
  in the code where it would go, with what is known.

## FROM GENERAL TO SPECIFIC: EMULATE THE HARDWARE, DON'T GO GAME BY GAME

It is the MAIN RULE applied to the order of work. **The general first, the particular after**, and
the general is always *"what does the circuit do?"* — never *"what does this game need?"*.

**The facts that back it, all from this repo:** making the CD command take ~333 µs moved **four
games at once**. VBE read as a level was SF Alpha's trail **and** the third case of the same
pattern. The framebuffer mode table explained in one go what three per-game hypotheses had not been
able to. The reverse never happened: every per-game shortcut asked for another shortcut, and the
shortcuts contradict each other.

In practice:

- **The source of truth is how the hardware behaves.** Faced with a symptom, the first stop is what
  the chip does, not the game or another emulator. A fix that can only be explained by naming a game
  is suspect; one that is explained by how the chip works holds for all 500.
- Before fixing a symptom, ask **what class it belongs to** and whether the class can be detected on
  its own. If it can, **the tool comes first** — that way it finds the missing ones without knowing
  which game it is (`diag/pulses.mjs`, `diag/stuck-waits.mjs`, `orphans.mjs`).
- **Before writing new code, look for whether the piece already exists unconnected.** It is the
  pattern of almost every bug in this repo: the value is computed and nobody reads it, the flag is
  raised and nobody consumes it. `orphans.mjs` finds them on its own.
- **Once an optimization is found, look for where ELSE it applies before calling it closed.** An
  optimization is a pattern, not a patch: if it worked in one place, there are almost always two or
  three more with the same shape. The case in point is the on-chip timers, which recomputed the
  prescaler 642k times per frame — the same question ("what else is recomputed per instruction or
  per chunk when it could be cached?") is the one that pays off, not micro-optimizing the dispatch.
  Look for the same shape in the other chips and write down where it was looked for, even if
  nothing turned up.

### Two patterns that have already come back, to look at FIRST

1. **The hardware TAKES TIME** — chips that answered with zero latency broke the handshake
   (`lower CMOK → write → wait for CMOK`). See the hardware section.
2. **EDGE-TRIGGERED, NOT LEVEL** — a register that the hardware consumes on the EDGE of the write
   and that we read as a level, once per frame. **Three have fallen already**: `FBCR` (the
   ghosting), `PTMR` (the lost drawing) and the **VBE of `TVMR`** (SF Alpha's trail, 27-07-2026).
   All three were literal ports from Yabause, which samples at the real V blank interleaved with
   the CPU while we close the frame in one go, so any short pulse from the game is already gone by
   the time we look. `diag/pulses.mjs` looks for the missing ones.

## ARCHITECTURE: RENDERING IS DECOUPLED

Everything that has **effects on the hardware** (registers, framebuffers, interrupts, edge flags)
goes in `runFrame()`, which is the console's timing. The canvas (`drawTv()` / `compose()`) **only
composes the output** and can run at the monitor's rate, twice or not at all, without moving the
emulation.

Hanging logic off the painting makes the emulation depend on the browser's fps: in a background tab
the rAF freezes and the console stops with it.

## CORRECTNESS CRITERION: THE SPEC, NOT THE GAMES

"Does this game run?" doesn't scale: the Saturn library has hundreds of titles, and fixing them one
at a time hides that many symptoms are the SAME bug. The criterion is **"does the chip meet its
specification?"**, and the model to follow is `diag/sh2-oracle.mjs`: 6,770 edge cases against each
instruction's specified behavior. That is why the SH-2 never shows up as a suspect.

**Uncomfortable corollary: a test written against observed behavior FOSSILIZES the bug.** It
happened twice on record — 64 of 179 CD checks encoded the instantaneous model, and SCSP test 3d
required a muted slot to stay muted. An oracle against the specification can't fossilize anything,
because its reference is external to the emulator.

## MEASUREMENT METHOD (this is not optional)

- **No probe reports without a CONTROL**: run it also where the answer is already known. If the
  control gives an absurd value, the probe is wrong and nothing gets reported. Without this rule
  half a dozen false positives piled up in a single session.
- **If the measurement says something basic is broken, the suspect is the probe.** The games boot,
  read from the CD and draw.
- **Every optimization has to speed up AND leave the hash identical** (`diag/bench-sh2.mjs` for the
  CPU, `diag/bench-video.mjs` for the video). If the hash changes, it is not an optimization: it is
  different behavior.
- **The measurement noise on this machine is bigger than what is being looked for.** Every A/B is
  interleaved (A,B,A,B) and the **minimum** of each branch is compared.
- **And interleaving is NOT ENOUGH: the order has to be COUNTERBALANCED.** With the fixed order
  `A,B,C` the branch that runs **first in each round performs systematically better** —CPU state,
  caches and turbo after the previous process—, and the bias reached **4.5 %**, the same order as
  many effects we look for. The case in point: measuring the page shortcut on the data path, the
  change came out worse in 4/4 reps… **and the control —IDENTICAL code— also came out worse in
  4/4**. Rotating the order of the branches in each rep (so each one takes every position) the same
  experiment gave **control vs control-2 = 0.0 % and MIXED**, which is what a control has to give,
  and only then was the result readable.
- **The criterion that holds is the SIGN rep by rep, not the difference of minimums.** Raw runs of
  the SAME branch spread **6-18 %** between processes (V8 warm-up, the OS scheduler). A
  control/control-2 pair that gives 2.2 % isn't measuring "the noise": it is measuring the order.
- **Measure the ceiling BEFORE writing the refactor.** It saved an entire VDP2 refactor (real
  ceiling: 5 %) and —by measuring first— avoided accepting the SH-2 JIT avenue: the 25-35 % ceiling
  that justified it **didn't exist** (the probe only measured the fetch, ~8-9 %), and the prototype
  that does execute came out **20-38 % slower**. See `PENDING.md`, section 7.
- **A probe that removes the bug's condition can't find it.** The 1-to-1 worker/synchronous
  comparisons waited for each answer, that is, with no latency, and gave "0 differences" with a
  latency bug inside.

## COMMIT RULE (broken twice, don't break it again)

**No change to the browser path is committed without Sebas testing it**, and **one at a time**.
Headless doesn't exercise the worker, the audio, the canvas or the browser's caches. Stacking three
untested changes made it impossible to know which one broke what.

And if a fix breaks something that worked, **it comes out first and the thinking comes after**:
nobody argues about who is right in the analysis.

## WHERE THE STATE IS

**`PENDING.md` at the root** is the single working document: what is missing, what has already been
measured, what the next step is, and the list of **dead hypotheses with their measurement** so they
aren't proposed again. **Read it before proposing work.** The probes live in `diag/` and are indexed
there with one line on what each one answers.

**IF IT'S DONE, IT GOES.** `PENDING.md` is what is MISSING, not a history. Finished work is deleted
from the document in the same commit that finishes it — it is already in git, in the commit message
and in the code comments, which is where people look. A file full of `✅ DONE` hides what is missing
and makes every session reread closed work.

The only two exceptions, because they save repeating work:
- **The dead hypotheses with their measurement** — so they aren't proposed again.
- **The design decisions in force** (what is modeled and what isn't, and why) — they are the frame,
  not finished tasks.

## STYLE

The repository is in **English**: identifiers, comments and documentation. Tabs; a file header with
name/description/version/dates/author; markers `//ok, DD-MM-YYYY`, `//!wip, DD-MM-YYYY` and `//?`
for open questions.

And one particularity of this repo: **comments explain WHY, with the hardware fact or the
measurement that backs it.** A comment that says what the code does is worth nothing; one that says
"this goes this way because the hardware does X, and we tried Y and it failed" saves an entire
session. It is the reason the files have the comment density they have.
