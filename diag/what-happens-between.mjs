/**
 *    Name:         what-happens-between.mjs
 *    Description:  Histogram of PCs between the moment an interrupt vector is served and the moment an
 *                  address is written, within a frame. Answers whether in that stretch the
 *                  CPU WORKS or WAITS, and waiting for what. Generic.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// A race hang is explained with a single question: the code that arrived late/early,
// was it WORKING or WAS IT WAITING? Both look the same from outside (time passes) and
// call for opposite fixes:
//   - if it WORKS, the stretch lasts as long as the work and what has to be checked is how much
//     we charge for that work (instruction cycles, memory waits, VDP1 time);
//   - if it WAITS, the stretch lasts until a signal arrives, and what has to be checked is WHEN
//     we deliver that signal.
// A PC histogram separates them unambiguously: waiting concentrates 90%+ of the steps in
// a handful of PCs; working spreads them out.
//
// THE CONTROL (Rule 0): TWO frames are run and compared. If the stretch is a wait, the
// frame with the long stretch and the one with the short stretch have to show THE SAME loop with
// a different number of iterations. If they show different loops, it is not a wait: it is another
// path, and we have to go back to divergence-frame.
//
// Usage: node diag/what-happens-between.mjs [game] [addr] [vector] [frameA] [frameB]
//   node diag/what-happens-between.mjs daytona 0x60a4cb4 0x40 1105 1106

import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "daytona";
const ADDR     = parseInt(process.argv[3] || "0x60a4cb4", 16) >>> 0;
const VECTOR  = parseInt(process.argv[4] || "0x40", 16);
const FRAMES = [parseInt(process.argv[5] || "1105", 10), parseInt(process.argv[6] || "1106", 10)];

const mod = await import("../headless.mjs?qh=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");
const FIRST = Math.min(...FRAMES);

for(let f = 0; f < FIRST; f++) runFrame();

const cpu = bus.cpuMaster;
let measuring = false;
let hist = null, steps = 0;
const results = new Map();

const origStep = cpu.step.bind(cpu);
cpu.step = function(){
	if(measuring){ const p = this.pc >>> 0; hist.set(p, (hist.get(p) || 0) + 1); steps++; }
	return origStep();
};

// WHAT the stretch READS. Without this the histogram says "waits" but not what for, which is the half
// that matters: the address read is the one that says which chip the signal depends on.
let reads = null;
const noteRead = (a, v) => {
	if(!measuring) return;
	const k = a >>> 0;
	const e = reads.get(k);
	if(e){ e.n++; if(v !== e.last){ e.changes++; e.last = v >>> 0; } }
	else reads.set(k, { n: 1, changes: 0, last: v >>> 0 });
};
for(const m of ["readByte", "readWord", "readLong"])
{
	const orig = bus[m].bind(bus);
	bus[m] = function(a){ const v = orig(a); noteRead(a, v); return v; };
}
const origServe = cpu._serveInterrupt.bind(cpu);
cpu._serveInterrupt = function(level, vector){
	if(vector === VECTOR && !measuring){ measuring = true; hist = new Map(); reads = new Map(); steps = 0; }
	return origServe(level, vector);
};
const origLong = bus.writeLong.bind(bus);
bus.writeLong = function(a, v){
	// It cuts at the FIRST write to the address: it is the arrival point being compared.
	if((a >>> 0) === ADDR && measuring){ measuring = false; results.set(currentFrame, { hist, reads, steps, value: v >>> 0 }); }
	return origLong(a, v);
};

let currentFrame = FIRST;
for(; currentFrame <= Math.max(...FRAMES); currentFrame++)
{
	measuring = false;
	runFrame();
}

console.log(GAME + ": from vector " + hx(VECTOR, 2) + " to the write of " + hx(ADDR) + "\n");

for(const c of FRAMES)
{
	const r = results.get(c);
	if(!r){ console.log("frame " + c + ": no write after that vector.\n"); continue; }
	// ⚠ 24 PCs ARE LOOKED AT, NOT 8. With 8 the probe classified as "WORKS (spread)" a
	// 16-instruction wait loop that took 76% of the steps: the cutoff cannot be
	// smaller than the loops we want to detect, and the wait loops of these games run from
	// 8 to 20 instructions. It is the same class of error as a threshold chosen by eye.
	const order = [...r.hist.entries()].sort((a, b) => b[1] - a[1]);
	const top = order.slice(0, 24);
	const concentration = top.reduce((s, e) => s + e[1], 0) / r.steps * 100;
	console.log("── frame " + c + "   " + r.steps + " instructions   wrote " + hx(r.value));
	console.log("   the 24 most visited PCs add up to " + concentration.toFixed(1) + "% -> "
		+ (concentration > 70 ? "WAITS (loop)" : concentration > 35 ? "mixto" : "WORKS (spread)")
		+ "   (distinct PCs: " + order.length + ")");
	for(const [pc, n] of top.slice(0, 8))
		console.log("      " + hx(pc) + "  x" + String(n).padStart(7)
			+ "   " + (n / r.steps * 100).toFixed(1) + "%   op " + hx(bus.readWord(pc) & 0xFFFF, 4));
	// The most read addresses of the stretch: the signal that ends the wait is among the ones that
	// are read a lot AND CHANGE value.
	const tops = [...r.reads.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
	console.log("   most read addresses in the stretch:");
	for(const [a, e] of tops)
		console.log("      " + hx(a) + "  x" + String(e.n).padStart(6)
			+ "   change " + e.changes + " times   last " + hx(e.last));
	console.log("");
}

console.log("If both frames show THE SAME loop with a different number of iterations, the stretch");
console.log("is a WAIT and what has to be checked is when we deliver the signal that ends it.");
