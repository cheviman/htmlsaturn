/**
 *    Name:         address-trace.mjs
 *    Description:  Timeline of ONE memory address: every write with its frame,
 *                  its PC and its value, crossed against the CPU interrupt mask and the
 *                  interrupts SERVED per vector. Generic: it does not know which game it is.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// "Who writes this address" is already answered by diag/pc-literals.mjs. What it does not answer is
// WHEN, and in a timeout hang that is the whole question: the counter goes up because whoever
// should reset it stopped running, and to see it you have to put both things on the SAME
// timeline — the writes and the served interrupts.
//
// That is why this probe hooks the SH-2's _serveInterrupt(), which is where the CPU ACCEPTS the
// interrupt, and not _scuIrq(), which is where it is REQUESTED. The difference is exactly what we
// want to measure: with the mask high the SCU keeps requesting and the CPU services nothing.
//
// THE CONTROL (Rule 0): the REQUESTED interrupts are counted too. If requested and served
// are equal the whole time, nothing is being covered by the mask and the hang is something else; if
// the requested ones go on and the served ones stop, the mask is the culprit and you see the exact
// frame. Without that pair, "0 interrupts served" does not tell "nobody requests them" from "nobody
// services them".
//
// Usage: node diag/address-trace.mjs [game] [addr] [from] [to]
//   node diag/address-trace.mjs daytona 0x60a4cb4 980 1150

import { readFileSync } from "fs";
import { basename } from "path";

const GAME = process.argv[2] || "daytona";
const ADDR   = parseInt(process.argv[3] || "0x60a4cb4", 16) >>> 0;
const FROM = parseInt(process.argv[4] || "980", 10);
const TO = parseInt(process.argv[5] || "1150", 10);

const mod = await import("../headless.mjs?tz=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, plan } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

for(let f = 0; f < FROM; f++) runFrame();

// --- Hooks ---
// WATCH OUT: cpuMaster is REASSIGNED on reset (already documented in the traps). It is taken here, which
// is after mounting the disc, and bus.cpuMaster is used on each iteration just in case.
const cpu = bus.cpuMaster;
let frame = FROM;
const events = [];   // {frame, type, pc, value, imask}

const imask = () => (bus.cpuMaster ? (bus.cpuMaster.sr >> 4) & 0xF : -1);
// AT WHAT POINT OF THE FRAME each thing happens. It is the datum that was missing: the VBlank-OUT does not fall
// just anywhere, it falls on line 38 of 262 (14.5% of the frame), and what decides the race
// is whether the game's critical section has already started when the VBlank-OUT arrives.
const pct = () => plan.cyclesPerFrame
	? ((plan.cycleAlive() - plan.frameStart) / plan.cyclesPerFrame * 100) : -1;

const origLong = bus.writeLong.bind(bus);
const origWord = bus.writeWord.bind(bus);
const origByte = bus.writeByte.bind(bus);
const noteWrite = (a, v, width) => {
	if(a < ADDR - 3 || a > ADDR + 3) return;
	events.push({ frame, type: "W" + width, pc: (bus.cpuMaster.pc - 4) >>> 0,
		value: v >>> 0, imask: imask(), off: a - ADDR, pct: pct() });
};
bus.writeLong = function(a, v){ noteWrite(a >>> 0, v, 4); return origLong(a, v); };
bus.writeWord = function(a, v){ noteWrite(a >>> 0, v, 2); return origWord(a, v); };
bus.writeByte = function(a, v){ noteWrite(a >>> 0, v, 1); return origByte(a, v); };

// Served: where the CPU ACCEPTS. Requested: where the SCU REQUESTS (the control).
const served = new Map(), requested = new Map();
const count = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const origServe = cpu._serveInterrupt.bind(cpu);
cpu._serveInterrupt = function(level, vector){
	count(served, vector);
	events.push({ frame, type: "IRQ", pc: vector, value: level, imask: imask(), pct: pct() });
	return origServe(level, vector);
};
const origScuIrq = bus._scuIrq.bind(bus);
bus._scuIrq = function(bit, level, vector){ count(requested, vector); return origScuIrq(bit, level, vector); };

// --- Run the window ---
const perFrame = [];
for(; frame < TO; frame++)
{
	const s0 = new Map(served);
	runFrame();
	perFrame.push({
		frame,
		value: bus.readLong(ADDR) >>> 0,
		imask: imask(),
		vin:  (served.get(0x40) || 0) - (s0.get(0x40) || 0),
		vout: (served.get(0x41) || 0) - (s0.get(0x41) || 0)
	});
}

// --- Report ---
console.log(GAME + ": " + hx(ADDR) + " between frames " + FROM + " and " + TO + "\n");

console.log("=== writes to the address (and the IRQs served in between) ===");
console.log("  frame   what           PC            value       IMASK");
let lastIrqFrame = -1;
for(const e of events)
{
	if(e.type === "IRQ")
	{
		// Only the IRQs of the vectors this game opens are listed, so as not to flood the output.
		if(e.pc !== 0x40 && e.pc !== 0x41) continue;
		if(e.frame === lastIrqFrame) continue;   // one per frame is enough for the timeline
		lastIrqFrame = e.frame;
		console.log("  " + String(e.frame).padStart(6) + "  IRQ vector "
			+ hx(e.pc, 2) + (e.pc === 0x40 ? " (VBlank-IN) " : " (VBlank-OUT)")
			+ "  level " + e.value + "   IMASK " + e.imask
			+ "   frame at " + e.pct.toFixed(1) + "%");
	}
	else
		console.log("  " + String(e.frame).padStart(6) + "  writes " + e.type.padEnd(6)
			+ hx(e.pc) + "  " + hx(e.value) + "  IMASK " + e.imask
			+ "   frame at " + e.pct.toFixed(1) + "%"
			+ (e.off ? "   (offset +" + e.off + ")" : ""));
}

console.log("\n=== per frame: value, mask and IRQs served (only where something changes) ===");
console.log("  frame   value       IMASK  VBlank-IN  VBlank-OUT");
let prev = null;
for(const p of perFrame)
{
	const key = p.value + "|" + p.imask + "|" + p.vin + "|" + p.vout;
	if(key === prev) continue;
	prev = key;
	console.log("  " + String(p.frame).padStart(6) + "  " + hx(p.value) + "  "
		+ String(p.imask).padStart(5) + "  " + String(p.vin).padStart(9) + "  " + String(p.vout).padStart(10));
}

console.log("\n=== CONTROL: requested vs served, over the whole window ===");
for(const v of [0x40, 0x41])
	console.log("  vector " + hx(v, 2) + ":  requested " + String(requested.get(v) || 0).padStart(5)
		+ "   served " + String(served.get(v) || 0).padStart(5)
		+ ((requested.get(v) || 0) > (served.get(v) || 0) ? "   <- the CPU does not service them" : ""));
console.log("\nIf the requested ones continue and the served ones stop, what is blocking is the MASK, and the");
console.log("frame where they stop is the frame of the hang. If both stop, nobody is requesting.");
