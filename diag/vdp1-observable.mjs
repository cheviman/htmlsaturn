/**
 *    Name:         vdp1-observable.mjs
 *    Description:  Which games WATCH the progress of VDP1 drawing within the frame: they read
 *                  COPR/EDSR/LOPR, write ENDR, or wait for Draw End. Decides whether spread-out
 *                  drawing has any observable effect or is fidelity with no consumer.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// "Spread-out VDP1 drawing" is the big fidelity debt: today `plot()` runs ATOMICALLY
// at the close of the frame, and `ENDR`, the pseudo draw continuation and the pixel budget
// hang from that. But it is an ARCHITECTURE change that touches the render, the worker and the timing of the 10
// games, and there is already a precedent that touching it halfway breaks things (the low-cost Draw End
// shortcut dropped X-Men COTA from 56% to 16%).
//
// Before taking it on we need to know WHO WATCHES IT. Drawing progress is only observable through:
//   - COPR (0x100010): the pointer to the current command. If nobody reads it, whether it advances or not makes no difference.
//   - EDSR (0x10000C read): CEF/BEF, the end of drawing.
//   - LOPR (0x10000E): the last command processed.
//   - ENDR (0x10000C write): force the end of drawing.
//   - the SCU's Sprite Draw End IRQ (vector 0x4B... actually bit 13 -> vector 0x4D).
// A game that touches NONE of them cannot tell the difference between drawing in one go at the end
// of the frame and drawing spread out: for it, the result of the frame is the same.
//
// THE CONTROL (Rule 0): the writes to PTMR/FBCR are counted too, which ALL games
// always do (they are the draw trigger and the bank change). If those came out 0, the probe is
// badly hooked and the other columns are not to be believed.
//
// Usage: node diag/vdp1-observable.mjs [games] [frames]

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAMES = (process.argv[2] || "rally,vc,sfa,sonic,xmen,touring,daycce,daytona,vf2,xmenvs").split(",");
	const FRAMES = process.argv[3] || "1500";
	const yo = fileURLToPath(import.meta.url);
	console.log("WHO WATCHES THE PROGRESS OF VDP1 DRAWING? — " + FRAMES + " cuadros\n");
	console.log("game       COPR   EDSR   LOPR   ENDR(W)   IRQ DrawEnd  |  control: PTMR/FBCR");
	for(const j of GAMES)
	{
		const r = spawnSync(process.execPath, [yo, j, FRAMES, "--child"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		process.stdout.write(r.stdout || ("  " + j + " -> failed: " + (r.stderr || "").split("\n")[0] + "\n"));
	}
	console.log("\nIf nobody reads COPR/EDSR/LOPR or writes ENDR, spread-out drawing has NO");
	console.log("consumer: the game cannot tell it apart from atomic drawing, and the refactor");
	console.log("would be pure risk with no observable effect. The only thing that would change is WHEN");
	console.log("the Draw End IRQ arrives, which is the other column.");
	process.exit(0);
}

// ---------------- child ----------------
const GAME  = process.argv[2];
const FRAMES = parseInt(process.argv[3], 10);
const mod = await import("../headless.mjs?vo=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

let copr = 0, edsr = 0, lopr = 0, endr = 0, irqDraw = 0, trigger = 0;

// The VDP1 registers live at 0x05D00000 (and their cache-through mirror 0x25D00000).
const off = (a) => {
	const d = (a & 0x1FFFFFFF) >>> 0;
	return (d >= 0x05D00000 && d < 0x05D80000) ? (d & 0x1F) : -1;
};
const hookCpu = (cpu) => {
	if(!cpu || cpu.__vo) return;
	cpu.__vo = true;
	for(const m of ["readByte", "readWord", "readLong"])
	{
		const orig = cpu[m].bind(cpu);
		// ⚠ THE MAP, verified against vdp1.js/bus.js — the first version had it SHIFTED and
		// attributed to COPR what was really EDSR:
		//   0x0C ENDR (write-only) · 0x10 EDSR · 0x12 LOPR · 0x14 COPR · 0x16 MODR
		cpu[m] = function(a){
			const o = off(a);
			if(o === 0x10) edsr++; else if(o === 0x12) lopr++; else if(o === 0x14) copr++;
			return orig(a);
		};
	}
	for(const m of ["writeByte", "writeWord", "writeLong"])
	{
		const orig = cpu[m].bind(cpu);
		cpu[m] = function(a, v){
			const o = off(a);
			if(o === 0x0C) endr++;
			else if(o === 0x00 || o === 0x02) trigger++;   // TVMR/FBCR
			else if(o === 0x04) trigger++;                 // PTMR
			return orig(a, v);
		};
	}
};
const origIrq = bus._scuIrq.bind(bus);
bus._scuIrq = function(bit, level, vec){ if(vec === 0x4D) irqDraw++; return origIrq(bit, level, vec); };

for(let f = 0; f < FRAMES; f++){ hookCpu(bus.cpuMaster); runFrame(); }

console.log(GAME.padEnd(9)
	+ String(copr).padStart(7) + String(edsr).padStart(7) + String(lopr).padStart(7)
	+ String(endr).padStart(10) + String(irqDraw).padStart(13) + "  |  "
	+ trigger + (trigger ? "" : "   ⚠ CONTROL: 0 triggers, the probe is badly hooked"));
