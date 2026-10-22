/**
 *    Name:         register-at-pc.mjs
 *    Description:  What value the SH-2 registers hold every time it passes through a given PC.
 *                  Resolves the pointer accesses (MOV.B @Rn) that the bus probes do not see.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// It is the flip side of a trap already documented: the SH-2 does NOT resolve all its accesses through
// bus.readByte/readWord — the common path goes through its own page table. A probe that
// counts reads on the bus sees 38 accesses where the loop went around 4,849 times, and more than one
// false "that address is never read" came out of that.
//
// When the loop accesses through a pointer (MOV.B @R14,R2), the only honest way to know WHICH
// address it touches is to read the REGISTER at the moment it executes that instruction.
//
// THE CONTROL (Rule 0): it reports how many times the PC was passed. If it gives 0, the PC is wrong or
// that code did not run in the window, and there is nothing to read — which is different from "the register
// is 0".
//
// Usage: node diag/register-at-pc.mjs [game] [pc] [warm] [window] [samples]
//   node diag/register-at-pc.mjs daytona 0x60971e8 1104 2 6

import { readFileSync } from "fs";
import { basename } from "path";

const GAME    = process.argv[2] || "daytona";
const PC       = parseInt(process.argv[3] || "0x60971e8", 16) >>> 0;
const WARM     = parseInt(process.argv[4] || "1104", 10);
const WINDOW  = parseInt(process.argv[5] || "2", 10);
const SAMPLES = parseInt(process.argv[6] || "6", 10);

const mod = await import("../headless.mjs?rp=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

for(let f = 0; f < WARM; f++) runFrame();

const cpu = bus.cpuMaster;
let times = 0;
const samples = [];
const pointers = new Map();   // value of each Rn used as a pointer -> times

const origStep = cpu.step.bind(cpu);
cpu.step = function(){
	if((this.pc >>> 0) === PC)
	{
		times++;
		// The first ones are kept and ALL are counted by value of R14/R13, which is what
		// usually acts as pointer and mask in these loops.
		if(samples.length < SAMPLES)
			samples.push({ r: Array.from(this.r), pr: this.pr >>> 0 });
		for(const n of [13, 14])
		{
			const k = n + ":" + (this.r[n] >>> 0);
			pointers.set(k, (pointers.get(k) || 0) + 1);
		}
	}
	return origStep();
};

for(let f = 0; f < WINDOW; f++) runFrame();

console.log(GAME + ": registers at PC=" + hx(PC) + ", frames " + WARM + "-" + (WARM + WINDOW) + "\n");
if(!times)
{
	console.log("⚠ CONTROL: that PC was not passed even once. The PC is wrong or that code did not");
	console.log("  run in the window. There is nothing to read.");
	process.exit(0);
}
console.log("  passed " + times + " veces\n");

console.log("  values used as pointer/mask:");
for(const [k, n] of [...pointers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
{
	const [reg, val] = k.split(":");
	console.log("      R" + reg + " = " + hx(parseInt(val, 10)) + "   x" + n);
}

console.log("\n  first " + samples.length + " passes (full registers):");
for(const m of samples)
{
	// ALL of them are listed: choosing four registers in advance already forced running the probe twice
	// more than once, and the pointer of interest was R0 as many times as R13/R14.
	console.log("      PR=" + hx(m.pr) + "  "
		+ m.r.map((v, i) => "R" + i + "=" + hx(v)).join(" "));
}
