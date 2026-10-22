// WHAT INTERRUPTS DOES THE GAME RECEIVE, AND HOW MANY PER FRAME?
//
// It is the measurement that compares two timing models without looking at screens: if the split of
// IRQs changes, the choreography changed, and there lies the cause of a game that worked
// no longer working. It was used on 25-07-2026 to hunt down the event scheduler regression in
// SF Alpha, which depends on HBlank-IN: its vector 0x42 handler increments a
// counter and its main loop spins until it reaches 2.
//
// Usage: node diag/irqs-per-frame.mjs [game=sfa] [frames=600] [warmup=300]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "sfa";
const FRAMES = parseInt(process.argv[3] || "600", 10);
const WARM   = parseInt(process.argv[4] || "300", 10);

const VECTOR = {
	0x40: "VBlank-IN", 0x41: "VBlank-OUT", 0x42: "HBlank-IN", 0x43: "Timer-0",
	0x44: "Timer-1", 0x45: "DSP-End", 0x46: "Sound-Req", 0x47: "SMPC",
	0x48: "PAD", 0x49: "DMA-lvl2", 0x4A: "DMA-lvl1", 0x4B: "DMA-lvl0",
	0x4C: "DMA-illegal", 0x4D: "Sprite-DrawEnd",
};

const mod = await import("../headless.mjs?irqs=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const bios = resolveBios({ xmen: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// Count at the point where ALL of them pass: _scuIrq(bit, level, vector).
const count = new Map();
const orig = bus._scuIrq.bind(bus);
bus._scuIrq = (bit, level, vector) => {
	count.set(vector, (count.get(vector) || 0) + 1);
	return orig(bit, level, vector);
};

for(let f = 0; f < WARM; f++) runFrame();
count.clear();
let frames = 0;
for(; frames < FRAMES && !mod.cpu.halted; frames++) runFrame();

console.log(GAME + ": SCU interrupts per frame (" + frames + " frames after " + WARM + " of warmup)");
const order = [...count.entries()].sort((a, b) => b[1] - a[1]);
for(const [vec, n] of order)
	console.log("  " + ("0x" + vec.toString(16)).padStart(5) + " " + (VECTOR[vec] || "?").padEnd(14)
		+ (n / frames).toFixed(2).padStart(9) + " per frame   (" + n + " in total)");
if(!order.length) console.log("  (none)");
