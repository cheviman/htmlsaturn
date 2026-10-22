// THE RESET IN THE MIDDLE OF A CHUNK: the trap that broke ALL the games on 25-07-2026.
//
// Sebas (25-07-2026, translated): "sega rally does not boot now, it sends you to the bios" and then "none of them load".
//
// Cause: when `stepsBlock` was switched to spending the budget in CYCLES, the cutoff was written
// against an ABSOLUTE target:
//
//     const target = cpu.cycles + n;
//     while(cpu.cycles < target) { ... cpu.step(); }
//
// But `cpu.cycles` GOES BACK TO ZERO in `cpu.reset()` (sh2.js), and the BIOS resets the
// SH-2 right when a game boots. After that reset, `cpu.cycles` is ~0 and `target`
// is still worth the hundreds of millions the counter had accumulated: the while
// keeps going around until it spends THAT. With the relative form (counting how much THIS
// chunk spent) the reset can do nothing.
//
// WHY NO HEADLESS PROBE SAW IT: here the CPU reset happens in loadDiscFromCue,
// BEFORE starting to run frames — never in the middle of a chunk. It is a failure mode that
// only appears when the reset falls INSIDE the emulation, which is what happens in the
// browser when loading a game. That is why this probe forces it by hand.
//
// Usage: node diag/reset-in-chunk.mjs
import { readFileSync } from "fs";
import { basename } from "path";

const mod = await import("../headless.mjs?resetchunk=1");
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const bios = resolveBios("us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame("rally"));

// Accumulate cycles: the higher the counter, the bigger the hole the reset leaves.
for(let f = 0; f < 400; f++) runFrame();
const cyclesBefore = mod.cpu.cycles;
console.log("cycles accumulated before the reset: " + cyclesBefore.toLocaleString());

// The reset INSIDE the emulation: it hooks into step() so that it falls in the middle of a
// chunk, which is exactly where it falls in the browser.
let remaining = 5000;
const origStep = mod.cpu.step.bind(mod.cpu);
let reset = false;
mod.cpu.step = () => {
	if(!reset && --remaining <= 0){ reset = true; mod.cpu.reset(); console.log("  -> SH-2 reset fired in the middle of a chunk (cycles: " + mod.cpu.cycles + ")"); }
	return origStep();
};

// If the bug is there, this frame never ends. The time cap turns it into a
// verdict instead of a hang of the probe.
const t0 = Date.now();
let stepsTotals = 0;
const origStep2 = mod.cpu.step;
mod.cpu.step = () => { stepsTotals++; return origStep2(); };

runFrame();
const ms = Date.now() - t0;

console.log("the frame with the reset inside took " + ms + " ms and executed "
	+ stepsTotals.toLocaleString() + " instructions");
// A healthy frame executes ~400,000 instructions. With the bug it is hundreds of millions.
if(stepsTotals > 5e6 || ms > 5000)
{
	console.log("\nFAIL: the frame did not stop. The budget is being counted against an");
	console.log("ABSOLUTE target and the reset left it unreachable.");
	process.exit(1);
}
console.log("\nOK: the reset in the middle of a chunk does not derail the budget.");
