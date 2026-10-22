/**
 *    Name:         where-is.mjs
 *    Description:  Histogram of the master's and the slave's PCs over a window of frames, WITHOUT
 *                  assuming there is a spin-loop, plus the state that decides whether it can get out:
 *                  IMASK, interrupts requested/served and the SMPC handshake flags.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// diag/what-waits.mjs answers "which spin-loop it is stopped in" and it is the right tool when there is one,
// but when it answers "I did not detect any spin-loop" it says NOTHING: the CPU may be going
// around a long path, serving a handler that does not end, or spread across several
// routines. That empty answer cost a whole round in the Daytona thread.
//
// This probe does not classify: it dumps the raw histogram and lets it be read. And it adds the state
// that decides whether the CPU CAN get out, because a PC without its IMASK does not say whether the loop waits for something
// that arrives or for something its own mask is blocking.
//
// THE CONTROL (Rule 0): an EARLIER window (same number of frames) is run too and both
// are printed. If the histogram of the "healthy" window already looks just as concentrated, the
// concentration does not mean a hang and there is nothing to report.
//
// Usage: node diag/where-is.mjs [game] [frame] [window]
//   node diag/where-is.mjs daytona 1120 5

import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "daytona";
const FRAME  = parseInt(process.argv[3] || "1120", 10);
const WINDOW = parseInt(process.argv[4] || "5", 10);

const mod = await import("../headless.mjs?from=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const source = readFileSync(new URL("../disasm.js", import.meta.url), "utf8");
const disassemble = new Function(source + "\nreturn disassemble;")();
const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

// The CONTROL window starts 2 windows earlier: it is code of the same game running fine.
const CONTROL = Math.max(0, FRAME - WINDOW * 2);
for(let f = 0; f < CONTROL; f++) runFrame();

let hist = new Map(), steps = 0, measuring = false;
const served = new Map(), requested = new Map();
const hookCpu = (cpu) => {
	if(!cpu || cpu.__hooked) return;
	cpu.__hooked = true;
	const orig = cpu.step.bind(cpu);
	cpu.step = function(){ if(measuring){ const p = this.pc >>> 0; hist.set(p, (hist.get(p) || 0) + 1); steps++; } return orig(); };
	const origServe = cpu._serveInterrupt.bind(cpu);
	cpu._serveInterrupt = function(level, vector){
		if(measuring) served.set(vector, (served.get(vector) || 0) + 1);
		return origServe(level, vector);
	};
};
const origScuIrq = bus._scuIrq.bind(bus);
bus._scuIrq = function(bit, level, vector){
	if(measuring) requested.set(vector, (requested.get(vector) || 0) + 1);
	return origScuIrq(bit, level, vector);
};

const run = (n, title) => {
	hist = new Map(); steps = 0; served.clear(); requested.clear();
	measuring = true;
	for(let f = 0; f < n; f++){ hookCpu(bus.cpuMaster); runFrame(); }
	measuring = false;

	const cpu = bus.cpuMaster;
	console.log("=== " + title + " ===");
	console.log("  " + steps + " instructions   IMASK=" + ((cpu.sr >> 4) & 0xF)
		+ "   PC=" + hx(cpu.pc) + "   distinct PCs=" + hist.size);
	console.log("  SMPC:  SF=" + hx(bus.smpc[0x63], 2) + "  COMREG=" + hx(bus.smpc[0x1F], 2)
		+ "  pending command: " + (bus.smpcPending ? bus.smpcPending.remaining + " cycles" : "no"));
	const irq = [...new Set([...requested.keys(), ...served.keys()])].sort((a, x) => a - x);
	console.log("  IRQ (vector: requested/served): "
		+ (irq.length ? irq.map(v => hx(v, 2) + ": " + (requested.get(v) || 0) + "/" + (served.get(v) || 0)).join("  ") : "none"));
	const order = [...hist.entries()].sort((a, x) => x[1] - a[1]).slice(0, 12);
	const conc = order.reduce((s, e) => s + e[1], 0) / (steps || 1) * 100;
	console.log("  the 12 most visited PCs add up to " + conc.toFixed(1) + "%:");
	for(const [pc, n2] of order)
		console.log("     " + hx(pc) + "  x" + String(n2).padStart(8) + "  " + (n2 / (steps || 1) * 100).toFixed(1)
			+ "%   " + disassemble(bus.readWord(pc) & 0xFFFF, pc));
	console.log("");
};

run(WINDOW, "CONTROL: frames " + CONTROL + "-" + (CONTROL + WINDOW) + " (before the point looked at)");
for(let f = CONTROL + WINDOW; f < FRAME; f++) runFrame();
run(WINDOW, "LOOKED AT: frames " + FRAME + "-" + (FRAME + WINDOW));

console.log("If the CONTROL already comes out just as concentrated, the concentration does not mean a hang.");
console.log("If the IRQs are REQUESTED and not SERVED, what is blocking is the mask and we have to see who raised it.");
