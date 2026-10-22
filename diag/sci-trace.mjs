/**
 *    Name:         sci-trace.mjs
 *    Description:  Timeline of the accesses to the SCI (SMR/BRR/SCR/TDR/SSR/RDR) in a
 *                  window of frames, with the PC, the value and the transmitter's internal state.
 *                  Collapses the repeated polling so the sequence can be read.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// diag/sci-usage.mjs answers WHICH games use the SCI and with what configuration, but it counts
// accesses: it gives totals, not ORDER. And in a handshake register order is everything — "turn off TE
// and then lower TDRE" and "lower TDRE and then turn off TE" leave different states, and one of
// the two can be a state the chip never leaves.
//
// The SSR polling is tens of thousands of reads per frame (measured: 49,837 on Daytona),
// so the raw trace is unreadable. Consecutive reads that return THE
// SAME from the same PC are collapsed: what is left is the sequence of CHANGES, which is what gets read.
//
// THE CONTROL (Rule 0): an EARLIER window of the same game is run and printed the same way. If
// the suspicious sequence also shows up there —where the game keeps working— it is not the cause.
//
// Usage: node diag/sci-trace.mjs [game] [from] [frames]
//   node diag/sci-trace.mjs daytona 1104 4

import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "daytona";
const FROM   = parseInt(process.argv[3] || "1104", 10);
const FRAMES = parseInt(process.argv[4] || "4", 10);

const mod = await import("../headless.mjs?st=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 2) => "0x" + (v >>> 0).toString(16).padStart(n, "0");
const NAMES = { 0x00: "SMR", 0x01: "BRR", 0x02: "SCR", 0x03: "TDR", 0x04: "SSR", 0x05: "RDR" };
const bitsSsr = (v) => "TDRE=" + ((v >> 7) & 1) + " RDRF=" + ((v >> 6) & 1)
	+ " ORER=" + ((v >> 5) & 1) + " TEND=" + ((v >> 2) & 1);
const bitsScr = (v) => "TIE=" + ((v >> 7) & 1) + " RIE=" + ((v >> 6) & 1)
	+ " TE=" + ((v >> 5) & 1) + " RE=" + ((v >> 4) & 1) + " CKE=" + (v & 3);

// The control starts one window earlier; the window under study, at DESDE.
const CONTROL = Math.max(0, FROM - FRAMES * 2);
for(let f = 0; f < CONTROL; f++) runFrame();

let cpu = bus.cpuMaster, measuring = false, frame = 0;
const lines = [];
let last = null, repeats = 0;

const emit = (txt, key) => {
	if(!measuring) return;
	if(key === last){ repeats++; return; }
	if(repeats){ lines.push("            ... x" + repeats + " same"); repeats = 0; }
	last = key;
	lines.push("  " + String(frame).padStart(5) + "  " + txt);
};

const origRead = cpu.readInternal.bind(cpu);
cpu.readInternal = function(addr, size){
	const off = addr & 0x1FF;
	const v = origRead(addr, size);
	if(off <= 0x05)
		emit("reads " + NAMES[off] + " = " + hx(v) + (off === 0x04 ? "   " + bitsSsr(v) : "")
			+ "   PC " + hx(this.pc >>> 0, 8) + "   tsrHasta " + (this.sci ? this.sci.tsrUntil : "?"),
			"L" + off + ":" + v + ":" + (this.pc >>> 0));
	return v;
};
const origWrite = cpu.writeInternal.bind(cpu);
cpu.writeInternal = function(addr, v, size){
	const off = addr & 0x1FF;
	const r = origWrite(addr, v, size);
	if(off <= 0x05)
	{
		const ssr = this.internalRegs[0x04];
		emit("WRITES " + NAMES[off] + " = " + hx(v & 0xFF)
			+ (off === 0x02 ? "   " + bitsScr(v) : "") + (off === 0x04 ? "   " + bitsSsr(v) : "")
			+ "   PC " + hx(this.pc >>> 0, 8)
			+ "   -> SSR stays " + hx(ssr) + " (" + bitsSsr(ssr) + ")"
			+ "  tsrHasta " + (this.sci ? this.sci.tsrUntil : "?"),
			"E" + off + ":" + (v & 0xFF) + ":" + (this.pc >>> 0) + ":" + ssr);
	}
	return r;
};

const run = (title) => {
	lines.length = 0; last = null; repeats = 0;
	console.log("=== " + title + " ===");
	measuring = true;
	for(let f = 0; f < FRAMES; f++){ frame++; runFrame(); }
	measuring = false;
	if(repeats) lines.push("            ... x" + repeats + " same");
	if(!lines.length) console.log("  (no access to the SCI in this window)");
	else for(const l of lines) console.log(l);
	const s = cpu.internalRegs;
	console.log("  state at close: SSR=" + hx(s[0x04]) + " (" + bitsSsr(s[0x04]) + ")   SCR="
		+ hx(s[0x02]) + " (" + bitsScr(s[0x02]) + ")   tsrUntil=" + cpu.sci.tsrUntil
		+ "   cycles=" + cpu.cycles);
	console.log("");
};

frame = CONTROL;
run("CONTROL: frames " + CONTROL + "-" + (CONTROL + FRAMES) + " (the game keeps working)");
for(let f = CONTROL + FRAMES; f < FROM; f++){ runFrame(); }
frame = FROM;
run("UNDER STUDY: frames " + FROM + "-" + (FROM + FRAMES));

console.log("If the window UNDER STUDY ends with TDRE=0 and TEND=1 and tsrUntil=0, the transmitter is left");
console.log("frozen: there is a byte waiting in TDR and nobody to ever move it to TSR again.");
