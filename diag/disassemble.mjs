/**
 *    Name:         disassemble.mjs
 *    Description:  Disassembled dump of a range of SH-2 memory, with the PC-relative literals
 *                  ALREADY RESOLVED to their value. Generic, for any game.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// Until today disassembly was done by hand over a hex dump (diag/sonic-code-dump.mjs)
// and the result was copied into PENDING.md. That cost hours in the Daytona thread and, worse,
// it leaves the literals unresolved: on the SH-2 almost every interesting address comes in through
// "MOV.L @(disp,PC),Rn", so the dump says "loads something" and not WHAT it loads. The two
// addresses of the Daytona deadlock (counter and threshold) were exactly that.
//
// This probe resolves the literal on the spot, reading the memory already loaded by the game.
//
// THE CONTROL (Rule 0): it counts how many instructions came out as ".word" (unrecognized). If
// they exceed 40% the range is NOT code — it is data, or the game has not loaded it yet — and we have to
// say so instead of reporting a made-up disassembly. It also reports whether the range is
// entirely zero, which is the "not loaded yet" case.
//
// Usage: node diag/disassemble.mjs [game] [from] [bytes] [warm]
//   node diag/disassemble.mjs daytona 0x60971c0 0x40 1105

import { readFileSync } from "fs";
import { basename } from "path";

const GAME = process.argv[2] || "daytona";
const FROM = parseInt(process.argv[3] || "0x60971c0", 16) >>> 0;
const BYTES = parseInt(process.argv[4] || "0x40", 16);
const WARM  = parseInt(process.argv[5] || "1105", 10);

const mod = await import("../headless.mjs?ds=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

// The disassembler lives in disasm.js, which is a browser script and exports nothing. It is
// loaded by evaluation instead of duplicating it: a copy drifts out of sync and lies.
const source = readFileSync(new URL("../disasm.js", import.meta.url), "utf8");
const disassemble = new Function(source + "\nreturn disassemble;")();

const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

for(let f = 0; f < WARM; f++) runFrame();

console.log(GAME + ": " + hx(FROM) + " + " + BYTES + " bytes, after " + WARM + " cuadros\n");

let words = 0, zeros = 0, total = 0;
for(let a = FROM; a < FROM + BYTES; a += 2)
{
	const op = bus.readWord(a) & 0xFFFF;
	total++;
	if(!op) zeros++;
	let txt = disassemble(op, a);
	if(txt.startsWith(".word")) words++;

	// The PC-relative literals: the SH-2 aligns the PC to a long for MOV.L and adds 4.
	// (@(disp,PC) with disp in longs for MOV.L, in words for MOV.W).
	let extra = "";
	const n = (op >> 8) & 0xF;
	const d8 = op & 0xFF;
	if((op >> 12) === 0xD)          // MOV.L @(disp,PC),Rn
	{
		const addr = ((a + 4) & ~3) + d8 * 4;
		extra = "   ; R" + n + " = " + hx(bus.readLong(addr)) + "   (literal at " + hx(addr) + ")";
	}
	else if((op >> 12) === 0x9)     // MOV.W @(disp,PC),Rn
	{
		const addr = a + 4 + d8 * 2;
		const v = bus.readWord(addr) & 0xFFFF;
		extra = "   ; R" + n + " = " + hx(v, 4) + " (" + ((v & 0x8000) ? v - 65536 : v) + ")   (literal at " + hx(addr) + ")";
	}
	else if((op >> 12) === 0xC && ((op >> 8) & 0xF) === 0x7)   // MOVA @(disp,PC),R0
	{
		extra = "   ; R0 = " + hx(((a + 4) & ~3) + d8 * 4);
	}

	console.log("  " + hx(a) + "  " + (op >>> 0).toString(16).padStart(4, "0")
		+ "   " + txt.padEnd(24) + extra);
}

// CONTROL
const pctWord = words / total * 100;
console.log("");
if(zeros === total)
	console.log("⚠ CONTROL: the range is ENTIRELY ZERO. The game has not loaded it yet (raise warm).");
else if(pctWord > 40)
	console.log("⚠ CONTROL: " + pctWord.toFixed(0) + "% came out as '.word'. This is NOT code: it is data, or the range is shifted.");
else
	console.log("CONTROL ok: " + pctWord.toFixed(0) + "% unrecognized opcodes (" + words + " of " + total + ").");
