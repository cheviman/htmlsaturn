/**
 *    Name:         intback-cadence.mjs
 *    Description:  How many times per frame we deliver peripheral data to the game
 *                  (INTBACK and its CONTINUEs), with which SR, and how many System Manager IRQs
 *                  come out of that. Generic.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// diag/smpc-intback-protocol.mjs answers WHAT we answer the game (the contents of the SR and
// of the OREGs) and it is written around Virtua Cop's boot. What it does not answer is
// HOW MANY TIMES, and that is a different class of bug: a chip that delivers too much does not give a bad value,
// it gives a good value TOO MANY TIMES, and the game processes it too many times.
//
// The precedent is in bus.js itself: the CONTINUE was delivered on EVERY write to IREG0
// instead of on the TOGGLE of bit 7, and that gave 28 System Manager IRQs per frame against 1. It
// was fixed, but no probe was left to watch the cadence, so a regression there
// becomes invisible again.
//
// THE CONTROL (Rule 0): an EARLIER window of the same game is run, where it is known to
// work, and both are printed. A cadence on its own says nothing: what says something is that the
// window under study has a DIFFERENT cadence from the healthy one. And the frames are listed one by one, not the
// average, because a spike in a single frame is exactly what an average hides.
//
// Usage: node diag/intback-cadence.mjs [game] [from] [frames]
//   node diag/intback-cadence.mjs daytona 1100 10

import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "daytona";
const FROM   = parseInt(process.argv[3] || "1100", 10);
const FRAMES = parseInt(process.argv[4] || "10", 10);

const mod = await import("../headless.mjs?ic=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 2) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

let nPeriph = 0, nStatus = 0, nComreg = 0, nIrq47 = 0, nIrq48 = 0, srs = new Set();

const origPeriph = bus._intbackPeripheral.bind(bus);
bus._intbackPeripheral = function(){ nPeriph++; return origPeriph(); };
const origStatus = bus._intbackStatus.bind(bus);
bus._intbackStatus = function(){ nStatus++; return origStatus(); };
const origIrq = bus._scuIrq.bind(bus);
bus._scuIrq = function(bit, level, vector){
	if(vector === 0x47) nIrq47++;
	if(vector === 0x48) nIrq48++;
	return origIrq(bit, level, vector);
};
// ALL commands are logged, not just INTBACK: the System Manager interrupt is
// fired by the end of a command, so any command can be inserting an IRQ in
// the middle of the peripheral parsing, and counting only 0x10 that would stay invisible.
let cmds = [];
const origWriteByte = bus.writeByte.bind(bus);
bus.writeByte = function(a, v){
	if((a >>> 0) === 0x2010001F){ if((v & 0xFF) === 0x10) nComreg++; cmds.push(hx(v & 0xFF)); }
	return origWriteByte(a, v);
};

const rows = [];
const run = (n, label) => {
	for(let f = 0; f < n; f++)
	{
		nPeriph = nStatus = nComreg = nIrq47 = nIrq48 = 0; srs = new Set(); cmds = [];
		const before = bus.smpc[0x61];
		runFrame();
		srs.add(bus.smpc[0x61]);
		rows.push({ label, periph: nPeriph, status: nStatus, comreg: nComreg,
			irq47: nIrq47, irq48: nIrq48, sr: hx(bus.smpc[0x61]), srBefore: hx(before),
			cmds: cmds.join(",") });
	}
};

// The control starts two windows earlier; it runs first so as not to alter the state.
const CONTROL = Math.max(0, FROM - FRAMES * 2);
for(let f = 0; f < CONTROL; f++) runFrame();
let frame = CONTROL;
run(FRAMES, "control");
for(let f = CONTROL + FRAMES; f < FROM; f++) runFrame();
const lookedStart = rows.length;
run(FRAMES, "LOOKED");

console.log(GAME + ": INTBACK cadence\n");
console.log("  frame    what       INTBACK(COMREG)  status  peripherals  IRQ 0x47  IRQ 0x48   SR");
rows.forEach((r, i) => {
	const c = (i < lookedStart) ? CONTROL + i : FROM + (i - lookedStart);
	console.log("  " + String(c).padStart(6) + "   " + r.label.padEnd(9)
		+ String(r.comreg).padStart(13) + String(r.status).padStart(8)
		+ String(r.periph).padStart(13) + String(r.irq47).padStart(10)
		+ String(r.irq48).padStart(10) + "   " + r.sr + "   cmd " + (r.cmds || "-"));
});

const sum = (a, b2) => a + b2;
const ctrl = rows.slice(0, lookedStart), mir = rows.slice(lookedStart);
const meanC = ctrl.map(r => r.periph).reduce(sum, 0) / (ctrl.length || 1);
const meanM = mir.map(r => r.periph).reduce(sum, 0) / (mir.length || 1);
console.log("\n=== CONTROL ===");
console.log("  peripheral deliveries per frame:  healthy " + meanC.toFixed(2) + "   looked " + meanM.toFixed(2));
if(Math.abs(meanC - meanM) < 0.01)
	console.log("  The cadence is THE SAME in both windows: INTBACK delivers neither too much nor too little.");
else
	console.log("  ⚠ The cadence CHANGES between the two windows. Look at which frame is out of line.");
