/**
 *    Name:         slave-what-waits.mjs
 *    Description:  Disassembles the loop the slave is spinning in and says WHAT it reads and
 *                  whether that moves. Useful for any game with the slave stuck.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// THE QUESTION: `diag/stuck-waits.mjs` says THAT the slave is stuck and `daytona-despacho`
// says that NOBODY wakes it up (0 doorbells, 0 input capture, 0 IRQ in 1,200 frames). What is missing is the
// only thing that decides how it gets fixed: WHAT that loop is looking at. A loop that polls a
// MMIO address asks for a piece of the chip; one that polls WRAM asks for the OTHER CPU to
// write there, and then the bug is on the side of the one that does not write.
//
// The dominant loop is disassembled, the addresses it READS are listed and we check whether any
// changes value while it spins. It is the same idea that made stuck-waits.mjs reliable:
// a wait is dead only if NONE of the values it watches advances.
//
// Usage: node diag/slave-what-waits.mjs [game=daytona] [frames=1200] [cpu=slave|master]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "daytona";
const FRAMES = parseInt(process.argv[3] || "1200", 10);
const WHICH   = (process.argv[4] || 'slave').toLowerCase();

const mod = await import("../headless.mjs?slvq=" + GAME);
const { bus, cpuSlave, cpu, runFrame, applyBios, loadDiscFromCue,
	resolveBios, resolveGame } = mod;
const bios = resolveBios({ xmen: "jp", xmenvs: "jp", vf2: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// Histogram of the slave's PC in the last part of the run.
//
// CAREFUL WITH WHAT YOU HOOK: headless RECREATES the slave on every reset (cpuSlave = new SH2...),
// so wrapping the reference the module exports leaves the wrapper on a dead object and
// the probe reports "the slave executed NOTHING" with the slave running right next to it. It hooks
// bus.cpuSlave -which the bus repoints with connectCpuSlave()- and is checked every frame.
const hist = new Map();
let measuring = false;
let wrapped = null;
function hookSlave()
{
	const s = (WHICH === 'master') ? bus.cpuMaster : bus.cpuSlave;
	if(!s || s === wrapped) return;
	wrapped = s;
	const stepOrig = s.step.bind(s);
	s.step = function(){
		if(measuring){ const k = this.pc >>> 0; hist.set(k, (hist.get(k) || 0) + 1); }
		return stepOrig();
	};
}

const left = new Float32Array(4096);
for(let f = 0; f < FRAMES && !cpu.halted; f++)
{
	if(f === FRAMES - 200) measuring = true;
	hookSlave();
	runFrame();
	const m = bus.scspEngine;
	if(m) while(m.count > 0) m.readAudio(left, left, Math.min(m.count, 4096));
}

const order = [...hist.entries()].sort((a, b) => b[1] - a[1]);
if(!order.length){ console.log(GAME + ": the " + WHICH + " executed NOTHING (off)"); process.exit(0); }

const total = order.reduce((s, [, n]) => s + n, 0);
const pcs = order.slice(0, 12).map(([pc]) => pc).sort((a, b) => a - b);
console.log("=== " + GAME + ": the loop of the " + WHICH + " (last 200 frames) ===");
console.log("  instructions executed: " + total.toLocaleString("es"));
console.log("  the dominant loop takes: " + (order[0][1] * 100 / total).toFixed(1) + "% at 0x" +
	order[0][0].toString(16));
console.log("");

// Disassembly of the stretch and reading of what it touches.
const { disassemble } = await import("../disasm.js").catch(() => ({ disassemble: null }));
console.log("  PC          times   instruction");
for(const pc of pcs)
{
	const op = bus.readWord(pc) & 0xFFFF;
	let txt = "0x" + op.toString(16).padStart(4, "0");
	try { if(disassemble) txt = disassemble(op, pc); } catch(e){}
	console.log("  0x" + pc.toString(16).padStart(7, "0") + "  " +
		String(hist.get(pc) || 0).padStart(7) + "   " + txt);
}
