/**
 *    Name:         68k-jump.mjs
 *    Description:  Why the sound 68000 jumps out of sound RAM. Ring of the
 *                  last PCs and of the IRQ level the SCSP was requesting at each one.
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE CLASS OF BUG, not the game: the 68000 jumps to an address that is NOT sound RAM (>=
// 0x80000, i.e. outside the 512 KB) and from there on it executes garbage. That does not depend on
// which game it is, so the probe works for all 500: pass it any of them.
// Usage: node diag/68k-jump.mjs [game=xmen] [from=1600] [to=1700]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME = process.argv[2] || "xmen";
const FROM = parseInt(process.argv[3] || "1600", 10);
const TO = parseInt(process.argv[4] || "1700", 10);

const mod = await import("../headless.mjs?k68jump=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu, get68k } = mod;
const bios = resolveBios({ xmen: "jp", xmenvs: "jp", vf2: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

const RAM = 0x80000;
const ring = new Array(96).fill(null);
let ap = 0, caught = false, f = 0, wrapped = false;

// The level the SCSP asks for is checked once per instruction (doInterrupts). That is where
// the PC is sampled: it is the only point that runs ALWAYS and without taking the core apart.
const levelOrig = bus.scspLevel68k.bind(bus);
bus.scspLevel68k = function()
{
	const n = levelOrig();
	if(f >= FROM && !caught)
	{
		const s = get68k();
		const r = (s && s.cpu.getRegs) ? s.cpu.getRegs() : null;
		if(r)
		{
			// WATCH OUT: getRegs() returns the internal `regs`, which has NO `sr` field -the status
			// register is composed by getSR() from s/t/intmask/flags-. Reading r.sr gave
			// undefined -> 0 and looked like "SR = 0x0, i.e. mask at 0", which would have sent us
			// looking for a bug where there was none. The real fields are read.
			ring[ap] = { f: f, pc: r.pc >>> 0, s: r.s ? 1 : 0, im: r.intmask | 0,
				a7: (r.a ? r.a[7] : 0) >>> 0, level: n,
				scipd: (bus.scspRam[0x420] << 8) | bus.scspRam[0x421],
				scieb: (bus.scspRam[0x41E] << 8) | bus.scspRam[0x41F] };
			ap = (ap + 1) % ring.length;
			if((r.pc >>> 0) >= RAM)
			{
				caught = true;
				console.log("=== the 68000 left sound RAM at frame " + f + " ===");
				console.log("  (PC >= 0x" + RAM.toString(16) + " is not 68000 memory: there are only 512 KB)");
				console.log("");
				console.log("   frame |    PC    | S | mask |   A7   | level | SCIPD | SCIEB");
				for(let i = 0; i < ring.length; i++)
				{
					const e = ring[(ap + i) % ring.length];
					if(!e) continue;
					console.log("  " + String(e.f).padStart(6) + " | " + ("0x" + e.pc.toString(16)).padStart(8) +
						" | " + String(e.s).padStart(1) + " |  " + String(e.im).padStart(3) + " | " + ("0x" + e.a7.toString(16)).padStart(6) +
						" | " + String(e.level).padStart(5) + " | 0x" + e.scipd.toString(16).padStart(3, "0") +
						" | 0x" + e.scieb.toString(16).padStart(3, "0") + (e.pc >= RAM ? "   <-- OUTSIDE" : ""));
				}
			}
		}
	}
	return n;
};

const left = new Float32Array(4096);
for(f = 0; f < TO && !cpu.halted; f++)
{
	runFrame();
	const m = bus.scspEngine;
	if(m) while(m.count > 0) m.readAudio(left, left, Math.min(m.count, 4096));
	if(caught) break;
}
if(!caught) console.log(GAME + ": the 68000 never left sound RAM between " + FROM + " and " + TO);
