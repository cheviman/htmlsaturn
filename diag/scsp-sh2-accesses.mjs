/**
 *    Name:         scsp-sh2-accesses.mjs
 *    Description:  How many times per frame the SH-2 touches the SCSP and sound RAM. It is the
 *                  ceiling of the impact of charging it the MCRDYN wait.
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE QUESTION, before writing anything (repo rule: measure the ceiling first). On the hardware
// the SH-2 eats a WAIT on every access to the SCSP: the chip drives its ready signal (MCRDYN)
// high, which stalls the access, and the wait lasts until the chip's internal processing
// is finished. Modeling it means adding cycles to the SH-2 on the hot path,
// and that changes the timing of ALL games. So first: how many accesses there are.
//
// The reference unit is the SCSP memory cycle: 22.68 us / 128 = 0.177 us, i.e.
// ~4.8 SH-2 cycles at 26.87 MHz. With that, "accesses per frame x 4.8" against the 447,443
// cycles of an NTSC frame gives the percentage that would be stolen from the CPU.
//
// Usage: node diag/scsp-sh2-accesses.mjs [game=rally] [frames=1800]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "1800", 10);

const mod = await import("../headless.mjs?acc=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu, get68k } = mod;
const bios = resolveBios({ xmen: "jp", xmenvs: "jp", vf2: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// The 68000 comes in through bus.scspRead/scspWrite just like the SH-2, so they must be told apart:
// the MCRDYN wait is the MAIN CPU's (the 68000 has its own priority, level 5).
let inThe68k = false, wrapped = false;
let regs = 0, ram = 0, frames = 0;

const lOrig = bus.scspRead.bind(bus), eOrig = bus.scspWrite.bind(bus);
bus.scspRead     = function(o, t){ if(!inThe68k) regs++; return lOrig(o, t); };
bus.scspWrite = function(o, v, t){ if(!inThe68k) regs++; return eOrig(o, v, t); };

// The SH-2 sees the sound RAM at 0x05A00000-0x05AFFFFF and it does NOT go through scspRead: it
// goes through the bus memory map. It is counted by wrapping the reads/writes of that region.
for(const m of ["readByte", "readWord", "readLong", "writeByte", "writeWord", "writeLong"])
{
	const o = bus[m].bind(bus);
	bus[m] = function(a, ...r){ if(!inThe68k && (a >>> 0) >= 0x05A00000 && (a >>> 0) < 0x05B00000) ram++; return o(a, ...r); };
}

const left = new Float32Array(4096);
for(let f = 0; f < FRAMES && !cpu.halted; f++)
{
	if(!wrapped)
	{
		const s = get68k();
		if(s){ wrapped = true; const c = s.run.bind(s); s.run = (n) => { inThe68k = true; try{ return c(n); } finally{ inThe68k = false; } }; }
	}
	runFrame();
	frames++;
	const mo = bus.scspEngine;
	if(mo) while(mo.count > 0) mo.readAudio(left, left, Math.min(mo.count, 4096));
}

const CYCLES_FRAME = 447443;        // NTSC
const CYCLES_WAIT  = 4.8;           // 1 SCSP memory cycle in SH-2 cycles
const p = (x) => x.toLocaleString("es");
const perFrame = (regs + ram) / frames;
console.log("=== SH-2 accesses to the sound block: " + GAME + " (" + p(frames) + " frames) ===");
console.log("  SCSP registers:       " + p(regs) + "   (" + (regs / frames).toFixed(1) + " per frame)");
console.log("  sound RAM:            " + p(ram) + "   (" + (ram / frames).toFixed(1) + " per frame)");
console.log("  TOTAL per frame:      " + perFrame.toFixed(1));
console.log("  if each one cost 1 SCSP memory cycle (~4.8 SH-2 cycles):");
console.log("     " + p(Math.round(perFrame * CYCLES_WAIT)) + " cycles per frame out of " + p(CYCLES_FRAME) +
	"   ->  " + (perFrame * CYCLES_WAIT * 100 / CYCLES_FRAME).toFixed(3) + " % of the frame");
