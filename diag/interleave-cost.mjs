// HOW MUCH DOES THE INTERLEAVE MACHINERY COST? cdTick, hblankTick and scspTick, measured
// by WRAPPING, not by removing.
//
// The frame is split into ~281 chunks (fixed at 1700 cycles) and each chunk calls cdTick,
// hblankTick, scspTick and m68k.run. This probe says how much each one weighs.
//
// ⚠ WHY IT WAS REWRITTEN ENTIRELY (28-07-2026). The old version measured by ABLATION:
// it replaced each Tick with a no-op and compared ms/frame. That does NOT measure the cost of the
// piece, because removing it CHANGES THE GAME'S BEHAVIOR: without cdTick the game does not
// progress and stays on another screen, so the two branches rasterize DIFFERENT
// SCENES. It reported "without cdTick it costs -3.21 ms", that is, removing it would make it
// slower — an absurd value, which by Rule 0 in CLAUDE.md is ALWAYS a measurement
// bug and never a finding. It is the same trap already noted for the idle-loop
// snapshot: an ablation that ELIMINATES THE CONDITION does not measure the piece, it measures another game.
//
// The right way is to wrap without removing, like diag/frame-profile.mjs: the game does
// EXACTLY the same thing in both branches and the only thing added is the clock.
//
// ⚠ And the cost of the wrapper ADDS to what is measured, so the absolutes are inflated.
// That is why the probe brings its own CONTROL: a branch with the same wrappers but without
// accumulating. If the control strays far from the clean run, what is being measured
// is the clock and not the chip, and nothing should be reported.
//
// Usage: node diag/interleave-cost.mjs [game] [frames]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "1500", 10);
const WARM   = 500;
const now  = () => Number(process.hrtime.bigint()) / 1e6;

// Mounts the emulator in a fresh module. 'mode' decides which wrappers are installed:
//   "clean"    - none, it is the reference ms/frame
//   "control"  - the same wrappers as "measured" but without reading the clock
//   "measured" - wrappers that accumulate time per piece
async function run(mode)
{
	const mod = await import("../headless.mjs?il=" + mode + "&j=" + encodeURIComponent(GAME));
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	const bios = resolveBios(GAME === "xmen" ? "jp" : "us");
	applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
	loadDiscFromCue(resolveGame(GAME));

	const t = { cd: 0, hblank: 0, scsp: 0 };
	const n = { cd: 0, hblank: 0, scsp: 0 };

	if(mode !== "clean")
	{
		// The SAME number of pieces is ALWAYS wrapped, and with the same function
		// shape: the only thing that changes between control and measured is whether the clock is read.
		for(const piece of ["cd", "hblank", "scsp"])
		{
			const method = piece + "Tick";
			const orig = bus[method].bind(bus);
			bus[method] = (mode === "measured")
				? function(...a){ const t0 = now(); const r = orig(...a); t[piece] += now() - t0; n[piece]++; return r; }
				: function(...a){ const r = orig(...a); n[piece]++; return r; };
		}
	}

	for(let f = 0; f < WARM; f++) runFrame();
	// The accumulators are zeroed AFTER the warmup: otherwise we measure V8 compiling
	// cold and the split comes out skewed toward the first piece that runs.
	t.cd = t.hblank = t.scsp = 0; n.cd = n.hblank = n.scsp = 0;
	const t0 = now();
	for(let f = 0; f < FRAMES; f++) runFrame();
	const msFrame = (now() - t0) / FRAMES;

	return { msFrame, t, n };
}

// The order is COUNTERBALANCED (clean, control, measured and then reversed): the branch that
// runs first in each round performs systematically better —up to 4.5%— because of the state of
// the caches and the turbo, and that bias is of the same order as what we are looking for. See the
// A/B rule in CLAUDE.md.
const r = {};
for(const mode of ["clean", "control", "measured"]) r[mode] = await run(mode);
for(const mode of ["measured", "control", "clean"])
{
	const b = await run(mode);
	if(b.msFrame < r[mode].msFrame) r[mode] = b;   // the MINIMUM of each branch is compared
}

console.log(GAME + ", cost of the interleave machinery (" + FRAMES + " frames, minimum of 2 runs):");
console.log("  clean   (no wrappers)         = " + r.clean.msFrame.toFixed(3) + " ms/frame");
console.log("  control (wrapped, not timed)  = " + r.control.msFrame.toFixed(3) + " ms/frame");
console.log("  measured (wrapped and timed)  = " + r.measured.msFrame.toFixed(3) + " ms/frame");

// THE CONTROL. If putting on the wrappers already costs a lot, the split below is measuring
// the clock and not the chips: we warn and do not report it as data.
const bias = (r.control.msFrame - r.clean.msFrame) / r.clean.msFrame * 100;
console.log("\n  CONTROL: the wrappers alone cost " + bias.toFixed(1) + "%");
if(Math.abs(bias) > 5)
	console.log("  ⚠ The control strays more than 5%: the split below is NOT reliable, do not report it.");

console.log("\n  split (careful: absolutes INFLATED by the wrapper, what counts is the proportion):");
let total = 0;
for(const piece of ["cd", "hblank", "scsp"])
{
	const ms = r.measured.t[piece] / FRAMES;
	total += ms;
	console.log("    " + (piece + "Tick").padEnd(11)
		+ ms.toFixed(3) + " ms/frame"
		+ "   " + (ms / r.clean.msFrame * 100).toFixed(1).padStart(5) + "% of the frame"
		+ "   " + (r.measured.n[piece] / FRAMES).toFixed(1) + " calls/frame");
}
console.log("    " + "TOTAL".padEnd(11) + total.toFixed(3) + " ms/frame   "
	+ (total / r.clean.msFrame * 100).toFixed(1) + "% of the frame");
