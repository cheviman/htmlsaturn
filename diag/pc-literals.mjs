/**
 *    Name:         pc-literals.mjs
 *    Description:  Resolves ALL the PC-relative literals of a stretch of code
 *                  (MOV.L/MOV.W @(disp,PC),Rn) and says, for each one, which address it loads,
 *                  what is at that address and who writes it. Generic: it does not know which
 *                  game it is dealing with.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// When a loop is disassembled, half the information stays hidden: the code says
// "MOV.L @(0x54,PC),R2" and what matters is WHICH ADDRESS that is. Resolving it by hand is
// PC arithmetic and anyone gets it wrong (the SH-2's PC is +4, and for MOV.L it is also
// aligned to 4). This probe does it by itself for a whole range.
//
// It also answers the question that always comes next: WHO WRITES that address. The recipe that
// already solved half a dozen hangs in this repo is "if nobody writes it, the piece that
// should write it is missing"; and if somebody writes it, the writer's PC is the next thread
// to pull.
//
// THE CONTROL (Rule 0): the probe checks that the requested range really has literal-load
// instructions and that the addresses that come out fall in a mapped region. If a
// literal points outside the map, or if the range has not even one load, it says so and does not report:
// it means the range is wrong or that code has not been loaded into memory yet.
//
// Usage: node diag/pc-literals.mjs [game] [from] [to] [warm] [window]
//   node diag/pc-literals.mjs daytona 0x6039de0 0x6039e30 1150 200

import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "daytona";
const FROM   = parseInt(process.argv[3] || "0x6039de0", 16);
const TO   = parseInt(process.argv[4] || "0x6039e30", 16);
const WARM    = parseInt(process.argv[5] || "1150", 10);
const WINDOW = parseInt(process.argv[6] || "200", 10);

const mod = await import("../headless.mjs?lit=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

for(let f = 0; f < WARM; f++) runFrame();
console.log(GAME + ": after " + WARM + " frames, master PC = " + hx(bus.cpuMaster.pc));
console.log("range " + hx(FROM) + " - " + hx(TO) + "\n");

// --- Resolve the literals ---
// SH-2:
//   MOV.L @(disp,PC),Rn  = 1101 nnnn dddddddd  -> addr = (PC & ~3) + 4 + disp*4   (long)
//   MOV.W @(disp,PC),Rn  = 1001 nnnn dddddddd  -> addr = PC + 4 + disp*2          (word)
// The "+4" is because the SH-2's PC points two instructions ahead.
const literales = [];
for(let pc = FROM; pc < TO; pc += 2)
{
	const op = bus.readWord(pc) & 0xFFFF;
	const height = (op >> 12) & 0xF;
	if(height !== 0xD && height !== 0x9) continue;
	const rn   = (op >> 8) & 0xF;
	const disp = op & 0xFF;
	const isLong = height === 0xD;
	const addr = isLong ? (((pc & ~3) + 4 + disp * 4) >>> 0) : ((pc + 4 + disp * 2) >>> 0);
	const value = isLong ? (bus.readLong(addr) >>> 0) : (bus.readWord(addr) & 0xFFFF);
	literales.push({ pc, op, rn, isLong, addr, value });
}

// CONTROL: with no literal loads in the range, there is nothing to resolve and the range is wrong.
if(!literales.length)
{
	console.log("⚠ CONTROL: there is not a single literal load in the stretch. Either the range is wrong, or that");
	console.log("  code is not in memory yet. Nothing is reported.");
	process.exit(0);
}

console.log("  PC          instruction                literal at    value       -> points to");
const candidates = new Set();
for(const l of literales)
{
	// The value of a LONG literal is usually a pointer; if it falls in a known region,
	// what is there is shown too, which is the datum being sought.
	let dest = "";
	const v = l.value >>> 0;
	const mapped = (v >= 0x06000000 && v < 0x06100000) || (v >= 0x00200000 && v < 0x00300000)
		|| (v >= 0x25E00000 && v < 0x25F00000) || (v >= 0x05A00000 && v < 0x06000000)
		|| (v >= 0x25A00000 && v < 0x25B00000) || (v >= 0x02000000 && v < 0x06000000);
	if(l.isLong && mapped)
	{
		dest = "  [" + hx(v) + "] = " + hx(bus.readLong(v) >>> 0)
			+ "  (word " + hx(bus.readWord(v) & 0xFFFF, 4) + ")";
		candidates.add(v);
	}
	else if(l.isLong)
		dest = "  (does not fall in a known mapped region)";

	console.log("  " + hx(l.pc) + "  "
		+ ("MOV." + (l.isLong ? "L" : "W") + " @(" + l.op % 256 + "*"
			+ (l.isLong ? "4" : "2") + ",PC),R" + l.rn).padEnd(26)
		+ hx(l.addr) + "  " + hx(l.value) + dest);
}

// --- Who writes those addresses ---
console.log("\n=== who writes those addresses, over " + WINDOW + " frames ===");
const writers = new Map();   // addr -> Map(pc -> {times, last})
const addrs = [...candidates];
const origLong = bus.writeLong.bind(bus);
const origWord = bus.writeWord.bind(bus);
const origByte = bus.writeByte.bind(bus);
const note = (a, val, width) => {
	// The write is logged if it STEPS ON the watched address, whatever its width: a
	// 32-bit counter can be touched with a MOV.B on its low byte, and looking only at the
	// longs would leave that out.
	for(const d of addrs)
		if(a >= d - 3 && a <= d + 3)
		{
			let m = writers.get(d);
			if(!m) writers.set(d, m = new Map());
			// The SH-2's PC points 2 instructions ahead of the one it executes.
			const pc = (bus.cpuMaster ? bus.cpuMaster.pc - 4 : 0) >>> 0;
			const e = m.get(pc) || { times: 0, last: 0, width: width, off: a - d };
			e.times++; e.last = val >>> 0;
			m.set(pc, e);
		}
};
bus.writeLong = function(a, v){ note(a >>> 0, v, 4); return origLong(a, v); };
bus.writeWord = function(a, v){ note(a >>> 0, v, 2); return origWord(a, v); };
bus.writeByte = function(a, v){ note(a >>> 0, v, 1); return origByte(a, v); };

const before = new Map(addrs.map(d => [d, bus.readLong(d) >>> 0]));
for(let f = 0; f < WINDOW; f++) runFrame();

for(const d of addrs)
{
	const now = bus.readLong(d) >>> 0;
	const m = writers.get(d);
	console.log("\n  " + hx(d) + "   " + hx(before.get(d)) + " -> " + hx(now)
		+ (before.get(d) === now ? "   (STUCK)" : "   (it moved)"));
	if(!m || !m.size){ console.log("      NOBODY writes it in the window."); continue; }
	[...m.entries()].sort((a, b) => b[1].times - a[1].times).slice(0, 6).forEach(([pc, e]) =>
		console.log("      written by PC=" + hx(pc) + "  x" + e.times
			+ "  last=" + hx(e.last) + "  (" + e.width + " bytes, offset +" + e.off + ")"));
}

console.log("\nRead it like this: a STUCK address that nobody writes is the candidate for 'the one that should");
console.log("write it is missing'. One that moves with a single writer gives the PC to follow the thread from.");
