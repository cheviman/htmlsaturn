/**
 *    Name:         path-to-write.mjs
 *    Description:  Dumps the last N PCs executed RIGHT BEFORE each write to an
 *                  address, with the value written and the point in the frame. Answers "which way
 *                  did it get here", which is what knowing who writes does not tell. Generic.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// diag/pc-literals.mjs says WHO writes an address and diag/address-trace.mjs says
// WHEN. The third one is missing: WHICH WAY IT GOT THERE. When the same instruction writes the same
// counter in two frames and one works and the other does not, the difference is not in the writer —
// it is in the CALL CHAIN that reached it.
//
// A ring of the last N PCs costs one write per instruction and is dumped only when
// the address is touched, so there is no need to know beforehand which frame to look at.
//
// THE CONTROL (Rule 0): the path of a NORMAL frame is dumped too. If the normal path
// and that of the odd frame are the same, the difference is not in the path and you have to look in
// the data that path read. Without the pair, any sequence of PCs seems to explain something.
//
// Usage: node diag/path-to-write.mjs [game] [addr] [from] [to] [length]
//   node diag/path-to-write.mjs daytona 0x60a4cb4 1104 1107 40

import { readFileSync } from "fs";
import { basename } from "path";

const GAME = process.argv[2] || "daytona";
const ADDR   = parseInt(process.argv[3] || "0x60a4cb4", 16) >>> 0;
const FROM = parseInt(process.argv[4] || "1104", 10);
const TO = parseInt(process.argv[5] || "1107", 10);
const LENGTH = parseInt(process.argv[6] || "40", 10);

const mod = await import("../headless.mjs?ce=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, plan } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

for(let f = 0; f < FROM; f++) runFrame();

// Ring of PCs. It is filled in step() and dumped when the address is touched.
const ring = new Int32Array(LENGTH);
let ri = 0, total = 0;
const cpu = bus.cpuMaster;
const origStep = cpu.step.bind(cpu);
cpu.step = function(){ ring[ri] = this.pc >>> 0; ri = (ri + 1) % LENGTH; total++; return origStep(); };

let frame = FROM;
const dumps = [];
const origLong = bus.writeLong.bind(bus);
bus.writeLong = function(a, v){
	if((a >>> 0) === ADDR)
	{
		const path = [];
		for(let k = 0; k < LENGTH; k++) path.push(ring[(ri + k) % LENGTH] >>> 0);
		dumps.push({
			frame, value: v >>> 0,
			imask: (bus.cpuMaster.sr >> 4) & 0xF,
			pct: plan.cyclesPerFrame ? (plan.cycleAlive() - plan.frameStart) / plan.cyclesPerFrame * 100 : -1,
			path
		});
	}
	return origLong(a, v);
};

for(; frame <= TO; frame++) runFrame();

console.log(GAME + ": path to each write of " + hx(ADDR)
	+ ", frames " + FROM + "-" + TO + "\n");

for(const v of dumps)
{
	console.log("── frame " + v.frame + "   writes " + hx(v.value)
		+ "   IMASK " + v.imask + "   frame at " + v.pct.toFixed(1) + "%");
	// It is printed in lines of 6 so the route can be read, with the opcode next to the
	// last stretch (which is where the decision is).
	for(let k = 0; k < v.path.length; k += 6)
		console.log("     " + v.path.slice(k, k + 6).map(p => hx(p)).join(" "));
	console.log("");
}

console.log("Read it like this: compare the path of the frame that works with that of the one that does not. If they are THE SAME,");
console.log("the difference is not in the path but in the DATA that path read.");
