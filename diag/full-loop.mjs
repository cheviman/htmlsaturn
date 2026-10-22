/**
 *    Name:         full-loop.mjs
 *    Description:  Extracts the ENTIRE loop a CPU is trapped in: the PCs it visits
 *                  with their count, the disassembly of each stretch, and EVERY memory read
 *                  it makes inside with its values and whether they change. Generic: it does
 *                  not know which game it is dealing with.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY, and why what we had was not enough
//
// diag/what-waits.mjs detects the spin and says "spins at X reading Y". It works when the loop is
// 4-5 instructions long and reads through a pointer. It does not work when the loop CALLS routines (the PC
// goes far away and comes back) nor when what it waits for is not read with the typical pattern: on Daytona
// USA it reported "does not read memory through a pointer" and the loop turned out to be a memset called in a
// bigger iteration.
//
// This probe assumes nothing: it records the REAL PCs visited and all the reads, and
// splits them into the ones that MOVE and the ones that are STUCK. The recipe that already solved half a
// dozen hangs in this repo is "if nobody writes that address, the piece that
// should write it is missing", and to apply it you first have to know which address it is.
//
// THE CONTROL: if ALL the reads move, the loop is not waiting for anything from outside and
// the hang is somewhere else (or it is a work loop, not a wait loop). If there are stuck
// reads, those are the candidates, and the probe also says whether anyone ever writes them.
//
// Usage: node diag/full-loop.mjs [game=daytona] [warm=1200] [window=90]

import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "daytona";
const WARM    = parseInt(process.argv[3] || "1200", 10);
const WINDOW = parseInt(process.argv[4] || "90", 10);

const mod = await import("../headless.mjs?bc=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v) => "0x" + (v >>> 0).toString(16);
for(let f = 0; f < WARM; f++) runFrame();

const P = globalThis.SH2.prototype;
const master = bus.cpuMaster;

// --- PCs visited ---
const pcs = new Map();
const stepOrig = P.step;
P.step = function(){ if(this === bus.cpuMaster) pcs.set(this.pc >>> 0, (pcs.get(this.pc >>> 0) | 0) + 1); return stepOrig.call(this); };

// --- Reads: address -> {pc, values, n} ---
const reads = new Map();
const note = (cpu, addr, val, width) => {
	if(cpu !== bus.cpuMaster) return;
	const d = addr >>> 0;
	let e = reads.get(d);
	if(!e){ e = { n: 0, width: width, values: new Set(), pcs: new Set() }; reads.set(d, e); }
	e.n++;
	if(e.values.size < 8) e.values.add(val >>> 0);
	if(e.pcs.size < 3) e.pcs.add(cpu.pc >>> 0);
};
for(const [fn, width] of [["readByte", 1], ["readWord", 2], ["readLong", 4]])
{
	const orig = P[fn];
	P[fn] = function(addr){ const v = orig.call(this, addr); note(this, addr, v, width); return v; };
}

// --- Writes: to answer "does anyone write that address?" ---
const writes = new Map();
for(const [fn, width] of [["writeByte", 1], ["writeWord", 2], ["writeLong", 4]])
{
	const orig = bus[fn].bind(bus);
	bus[fn] = (a, v) => { const d = (a >>> 0); writes.set(d, (writes.get(d) | 0) + 1); return orig(a, v); };
}

for(let f = 0; f < WINDOW; f++) runFrame();
P.step = stepOrig;

// ============================================================================
console.log(GAME.toUpperCase() + " — MASTER loop, frames " + WARM + ".." + (WARM + WINDOW));
console.log("current PC " + hx(master.pc) + "   distinct PCs: " + pcs.size);
console.log("");

// --- Disassembly of the contiguous stretches ---
const order = [...pcs.keys()].sort((a, b) => a - b);
console.log("THE LOOP, disassembled (with how many times it went through each instruction):");
let prev = -99;
for(const pc of order)
{
	if(pc - prev > 8) console.log("  ---");
	prev = pc;
	let op = 0;
	try{ op = bus.readWord(pc) >>> 0; }catch(e){ continue; }
	console.log("  " + hx(pc).padEnd(12) + op.toString(16).padStart(4, "0") + "  " +
		globalThis.disassemble(op, pc).padEnd(30) + String(pcs.get(pc)).padStart(9) + "x");
}

// --- What it reads, split by what matters ---
const moved = [], stuck = [];
for(const [d, e] of reads) (e.values.size > 1 ? moved : stuck).push([d, e]);
stuck.sort((a, b) => b[1].n - a[1].n);
moved.sort((a, b) => b[1].n - a[1].n);

console.log("");
console.log("STUCK READS (candidates: the loop looks at them and they NEVER change):");
for(const [d, e] of stuck.slice(0, 14))
	console.log("  " + hx(d).padEnd(14) + "(" + e.width + "b) " + String(e.n).padStart(8) + "x   value " +
		[...e.values].map(hx).join(",").padEnd(12) + "   escrita " + (writes.get(d) | 0) + " times   from PC " +
		[...e.pcs].map(hx).join(" "));
if(!stuck.length) console.log("  (none: EVERYTHING it looks at moves — the loop is not waiting for anything from outside)");

console.log("");
console.log("READS THAT MOVE (the wait advances through here):");
for(const [d, e] of moved.slice(0, 10))
	console.log("  " + hx(d).padEnd(14) + "(" + e.width + "b) " + String(e.n).padStart(8) + "x   values " +
		[...e.values].map(hx).join(",").slice(0, 46));
if(!moved.length) console.log("  (none: NOTHING advances — the piece that should write something is missing)");

console.log("");
console.log("  " + stuck.length + " stuck addresses / " + moved.length + " that move");
