/**
 *    Name:         radar-onchip.mjs
 *    Description:  The blind-spot radar: which ON-CHIP SH7604 registers the games touch
 *                  and which of those we do NOT consume. It does not guess — it cross-checks what
 *                  the game asks for against what sh2.js actually reads.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY IT EXISTS, and why no probe covered it
//
// The MMIO radar (bus) answers "what did the game ask the BUS for that we do not have". But the
// on-chip registers of the SH7604 itself (0xFFFFFE00-0xFFFFFFFF) do NOT go out to the bus: the
// CPU handles them in readInternal/writeInternal. And the fallback of those two functions is generic:
//
//     // Remaining registers: the last value written is returned (big-endian).
//
// In other words, a register with BEHAVIOR that we do not model **is silently swallowed and
// returns what the game wrote**. It is exactly the class of hole that this repo
// documents as the worst: invisible, no error, no log.
//
// And it is the tool that the "from general to specific" rule calls for: it does not know which game
// it is dealing with, so it works for the 500 discs just as for these 10 — which is the suspicion of
// Sebas (28-07-2026, translated): *"the boot process of all the games has things in common"* and
// *"there is something we are missing to emulate correctly at the hardware level"*.
//
// HOW IT DECIDES WHETHER WE CONSUME IT, without a hand-made list that goes stale: sh2.js is parsed and
// the set of offsets that the code REALLY looks at is built, in three ways:
//   1. explicit comparisons       off === 0xNN   /   off >= 0xNN && off <= 0xMM
//   2. labels                     case 0xNNN:
//   3. indexed accesses to the bank internalRegs[0xNN] / b[0xNN]  (that is how TIER, IPRA, etc. count,
//      which have no case of their own but the FRT and the WDT do read them)
// Whatever the game touches and does not fall into any of the three is reported as NOT CONSUMED.
//
// THE CONTROL, without which nothing is reported: the registers we DO know we consume (FRC,
// TCR, DMAC, DIVU, BCR1) must come out classified as consumed. If the cross-check marks
// as "not consumed" something the code obviously uses, the parser is wrong and the whole table
// is worthless.
//
// ⚠⚠ WHAT THIS PROBE CANNOT SEE, AND IT ALREADY COST DEARLY (29-07-2026):
// "consumed" means that the source LOOKS AT that offset. It does NOT mean the register's
// behavior is modeled. The test case is the SCI: its registers came out classified as
// EMULATED —the code touches them— and in reality they were stored RAW, without a single line of
// behavior. Result: the TDRE the game lowered was raised by nobody, and **7 of the 10 games**
// kept spinning until their own timeout, ~262,000 instructions per attempt.
// This radar is for finding ABSENT registers, not BADLY MODELED registers. For the
// latter you have to go through the module's real hardware behavior and compare it behavior by behavior, which is what
// diag/sci-usage.mjs did. A "0 missing" in this table does NOT close a chip.
//
// Usage: node diag/radar-onchip.mjs [games=all] [frames=1500]

import { readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GAMES = (process.argv[2] || "daytona,daycce,rally,sfa,sonic,vc,xmen,vf2,touring,xmenvs").split(",");
const FRAMES = parseInt(process.argv[3] || "1500", 10);
const hx = (v) => "0x" + (v >>> 0).toString(16);

// ---------------------------------------------------------------------------
//  Names of the SH7604 on-chip map. Only the ones sh2.js itself names in its
//  comments, so as not to invent labels.
// ---------------------------------------------------------------------------
const NAME = {
	0x00:"SMR (SCI)", 0x01:"BRR (SCI)", 0x02:"SCR (SCI)", 0x03:"TDR (SCI)",
	0x04:"SSR (SCI)", 0x05:"RDR (SCI)",
	0x10:"TIER (FRT)", 0x11:"FTCSR (FRT)", 0x12:"FRC high", 0x13:"FRC low",
	0x14:"OCRA/B high", 0x15:"OCRA/B low", 0x16:"TCR (FRT)", 0x17:"TOCR (FRT)",
	0x18:"ICR high (FRT)", 0x19:"ICR low (FRT)",
	0x60:"IPRB (INTC)", 0x62:"VCRA", 0x64:"VCRB", 0x66:"VCRC", 0x68:"VCRD",
	0x71:"DRCR0 (DMAC req)", 0x72:"DRCR1 (DMAC req)",
	0x80:"WTCSR", 0x81:"WTCNT", 0x82:"RSTCSR high", 0x83:"RSTCSR low",
	0x92:"CCR (cache)",
	0xE0:"ICR (INTC)", 0xE2:"IPRA (INTC)", 0xE4:"VCRWDT",
	0x1E0:"BCR1", 0x1E4:"BCR2", 0x1E8:"WCR", 0x1EC:"MCR",
	0x1F0:"RTCSR", 0x1F4:"RTCNT", 0x1F8:"RTCOR",
};
const zone = (off) => {
	if(off <= 0x05) return "SCI (serial)";
	if(off >= 0x10 && off <= 0x19) return "FRT";
	if(off >= 0x60 && off <= 0x69) return "INTC";
	if(off >= 0x71 && off <= 0x72) return "DMAC (req)";
	if(off >= 0x80 && off <= 0x83) return "WDT";
	if(off === 0x92) return "CACHE";
	if(off >= 0xE0 && off <= 0xE5) return "INTC";
	if(off >= 0x100 && off <= 0x11F) return "DIVU";
	if(off >= 0x140 && off <= 0x17F) return "UBC";
	if(off >= 0x180 && off <= 0x1B3) return "DMAC";
	if(off >= 0x1E0) return "BSC (bus)";
	return "?";
};

// ---------------------------------------------------------------------------
//  Which offsets sh2.js REALLY consumes, taken from the source and not from a hand-made list.
// ---------------------------------------------------------------------------
function offsetsConsumed()
{
	const src = readFileSync(join(ROOT, "sh2.js"), "utf8");
	const s = new Set();
	const add = (v) => { if(!isNaN(v)) s.add(v); };
	// 1. off === 0xNN
	for(const m of src.matchAll(/off\s*===?\s*(0x[0-9A-Fa-f]+)/g)) add(parseInt(m[1], 16));
	// 2. ranges off >= 0xNN && off <= 0xMM
	for(const m of src.matchAll(/off\s*>=\s*(0x[0-9A-Fa-f]+)\s*&&\s*off\s*<=\s*(0x[0-9A-Fa-f]+)/g))
		for(let v = parseInt(m[1], 16); v <= parseInt(m[2], 16); v++) add(v);
	// 3. case 0xNNN:
	for(const m of src.matchAll(/case\s+(0x[0-9A-Fa-f]+)\s*:/g)) add(parseInt(m[1], 16));
	// 4. indexed accesses to the bank: internalRegs[0xNN], b[0xNN], f[0xNN]
	for(const m of src.matchAll(/(?:regInternos|\bb|\bf)\[\s*(0x[0-9A-Fa-f]+)/g)) add(parseInt(m[1], 16));
	// 5. the special case written as off <= 0x16 && off + size > 0x16
	for(const m of src.matchAll(/off\s*\+\s*tam\s*>\s*(0x[0-9A-Fa-f]+)/g)) add(parseInt(m[1], 16));
	return s;
}
const RAW = offsetsConsumed();

// ⚠ CORRECTION OF A FALSE POSITIVE OF OUR OWN, found when running it the first time: the
// SH7604 registers are 16 and 32 bits wide, and the code reads ONE byte of the pair. IPRA lives at
// 0xE2-0xE3 and sh2.js reads `b[0xE3]`; looking byte by byte, 0xE2 came out as "not consumed"
// when it is the same register. Same for 0x60/0x61 (IPRB), 0x64/0x65 (VCRB), 0x68/0x69 (VCRD) and
// 0xE4/0xE5 (VCRWDT). The PAIR is consumed: if the code looks at any byte of the register, the
// register is consumed. Without this the probe reports half a dozen holes that do not exist
// — the same old trap, a datum that looks like a datum.
const CONSUMED = new Set(RAW);
for(const o of RAW){ CONSUMED.add(o ^ 1); if(o >= 0x100) CONSUMED.add(o & ~3); }

// The CONTROL: the code uses these beyond any doubt. If any of them comes out "not consumed", the
// parser above is broken and the table must NOT be believed.
const CONTROL = [0x11, 0x12, 0x13, 0x16, 0x80, 0x100, 0x180, 0x1E0];
const failControl = CONTROL.filter(o => !CONSUMED.has(o));

// ---------------------------------------------------------------------------
const global = new Map();   // off -> { games:Set, r:0, w:0 }

// ONE PROCESS PER GAME. It is not a preference: a disc image weighs up to 600 MB and
// headless loads it whole into memory, so 10 instances do not fit in one process.
// (Same reason as in diag/sh2-ablation-ceiling.mjs.)
const THIS = fileURLToPath(import.meta.url);
const isChild = process.argv.includes("--child");

if(isChild)
{
	const GAME = process.argv[2];
	const mod = await import("../headless.mjs?ro=" + GAME);
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	const bi = resolveBios({ xmen: "jp" }[GAME] || "us");
	applyBios(basename(bi), new Uint8Array(readFileSync(bi)));
	loadDiscFromCue(resolveGame(GAME));

	const P = globalThis.SH2.prototype;
	const readOrig = P.readInternal, writeOrig = P.writeInternal;
	const touched = new Map();
	const note = (off, isWrite) => {
		let e = touched.get(off);
		if(!e){ e = { r: 0, w: 0 }; touched.set(off, e); }
		if(isWrite) e.w++; else e.r++;
	};
	P.readInternal     = function(addr, size){ note(addr & 0x1FF, false); return readOrig.call(this, addr, size); };
	P.writeInternal = function(addr, v, size){ note(addr & 0x1FF, true); return writeOrig.call(this, addr, v, size); };
	for(let f = 0; f < FRAMES && !bus.cpuMaster.halted; f++) runFrame();
	console.log("@@" + JSON.stringify([...touched.entries()]));
	process.exit(0);
}

const { spawnSync } = await import("child_process");
for(const GAME of GAMES)
{
	const p = spawnSync(process.execPath, [THIS, GAME, String(FRAMES), "--child"],
		{ encoding: "utf8", maxBuffer: 1 << 26 });
	const line = (p.stdout || "").split("\n").find(l => l.startsWith("@@"));
	if(!line){ console.log("  " + GAME + ": FAILED — " + ((p.stderr || "").trim().split("\n").pop() || "no output")); continue; }
	for(const [off, e] of JSON.parse(line.slice(2)))
	{
		let g = global.get(+off);
		if(!g){ g = { games: new Set(), r: 0, w: 0 }; global.set(+off, g); }
		g.games.add(GAME); g.r += e.r; g.w += e.w;
	}
	console.log("  " + GAME + " done");
}

// ---------------------------------------------------------------------------
console.log("");
console.log("SH7604 ON-CHIP RADAR — " + GAMES.length + " games x " + FRAMES + " frames");
if(failControl.length)
{
	console.log("");
	console.log("⚠⚠ THE CONTROL FAILED: " + failControl.map(hx).join(" ") + " come out as NOT consumed");
	console.log("   and the code obviously uses them. The parser is wrong: do NOT believe the table.");
	process.exit(1);
}
console.log("control: the " + CONTROL.length + " registers we know we consume come out correctly classified ✔");
console.log("");

const rows = [...global.entries()].sort((a, b) => a[0] - b[0]);
const orphans = rows.filter(([off]) => !CONSUMED.has(off));

console.log("★ TOUCHED AND NOT CONSUMED (silently swallowed, they return what was written):");
if(!orphans.length) console.log("  (none: everything the games touch has code that looks at it)");
for(const [off, e] of orphans)
	console.log("  " + hx(0xFFFFFE00 + off).padEnd(12) + "off " + hx(off).padEnd(7) +
		(NAME[off] || "").padEnd(18) + zone(off).padEnd(13) +
		"R" + String(e.r).padStart(7) + " W" + String(e.w).padStart(7) + "   " +
		[...e.games].join(","));

console.log("");
console.log("the rest (touched AND consumed): " + (rows.length - orphans.length) + " offsets");
