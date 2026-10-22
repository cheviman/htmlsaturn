/**
 *    Name:         divergence-frame.mjs
 *    Description:  Compares the EXECUTION PATH of two frames from the same trigger and
 *                  says at which EXACT instruction they fork, with the context of both
 *                  branches. Generic: it does not know which game it is dealing with.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// When a game does the same thing for 100 frames in a row and on the 101st does something else, the
// question is not "where is it stuck" (what-waits / full-loop already answer that): it is "WHICH BRANCH
// DID IT TAKE DIFFERENTLY". And that is answered in only one way — recording the path of a good frame
// and that of a bad one from the SAME starting point, and looking for the first PC where they differ.
//
// The first different PC is, by construction, the branch instruction that decided; and the
// surrounding context says what it was looking at.
//
// THE CONTROL (Rule 0): TWO GOOD FRAMES are compared with each other first. If two frames that
// behave the same already diverge, the method is useless for this case (the path depends on
// something that always changes, like a time counter) and the result of the good/bad pair
// must not be read. Without that control, any difference looks like THE finding.
//
// Usage: node diag/divergence-frame.mjs [game] [frameA] [frameB] [vector] [cap]
//   node diag/divergence-frame.mjs daytona 1105 1106 0x40 400000

import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "daytona";
const FRAME_A = parseInt(process.argv[3] || "1105", 10);
const FRAME_B = parseInt(process.argv[4] || "1106", 10);
const VECTOR  = parseInt(process.argv[5] || "0x40", 16);
const CAP    = parseInt(process.argv[6] || "400000", 10);

const mod = await import("../headless.mjs?dv=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

// The start frame is the first one recorded; all of them are recorded up to the largest one requested.
const FIRST = Math.min(FRAME_A, FRAME_B) - 2;   // two extra, to have the control
const LAST  = Math.max(FRAME_A, FRAME_B);

for(let f = 0; f < FIRST; f++) runFrame();

// --- Record the path of each frame from when the vector is served ---
const paths = new Map();   // frame -> Int32Array of PCs
let frame = FIRST, recording = false, buf = null, n = 0;

const cpu = bus.cpuMaster;
const origStep = cpu.step.bind(cpu);
cpu.step = function(){
	if(recording && n < CAP) buf[n++] = this.pc >>> 0;
	return origStep();
};
const origServe = cpu._serveInterrupt.bind(cpu);
cpu._serveInterrupt = function(level, vector){
	// Recording starts on SERVING the requested vector: it is the same starting point in both
	// frames, which is what makes the paths comparable.
	if(vector === VECTOR && !recording){ recording = true; buf = new Int32Array(CAP); n = 0; }
	return origServe(level, vector);
};

for(; frame <= LAST; frame++)
{
	recording = false; buf = null; n = 0;
	runFrame();
	if(buf) paths.set(frame, buf.subarray(0, n));
}

// --- Compare ---
function compare(a, b, label)
{
	const ca = paths.get(a), cb = paths.get(b);
	if(!ca || !cb){ console.log(label + ": the path of one of the two frames is missing."); return -1; }
	const min = Math.min(ca.length, cb.length);
	let i = 0;
	while(i < min && ca[i] === cb[i]) i++;
	console.log(label + ":  " + ca.length + " and " + cb.length + " instructions recorded"
		+ "   -> first different PC at step " + (i < min ? i : "(none: one is a prefix of the other)"));
	return i < min ? i : -1;
}

console.log(GAME + ": path from vector " + hx(VECTOR, 2) + "\n");

// CONTROL: two frames that behave the same.
console.log("=== CONTROL: two normal frames against each other ===");
const iCtrl = compare(FIRST, FIRST + 1, "  frames " + FIRST + " vs " + (FIRST + 1));

console.log("\n=== THE PAIR THAT MATTERS ===");
const i = compare(FRAME_A, FRAME_B, "  frames " + FRAME_A + " vs " + FRAME_B);

if(iCtrl >= 0 && i >= 0 && iCtrl < i / 10)
{
	console.log("\n⚠ CONTROL FAILED: two NORMAL frames already diverge at step " + iCtrl + ",");
	console.log("  well before the pair that matters. The path depends on something that changes in");
	console.log("  every frame and this comparison distinguishes nothing. Do not read what follows.");
}

if(i >= 0)
{
	const ca = paths.get(FRAME_A), cb = paths.get(FRAME_B);
	console.log("\n=== the context of the fork ===");
	console.log("  the last 8 EQUAL PCs (the common path up to there):");
	for(let k = Math.max(0, i - 8); k < i; k++)
		console.log("      step " + k + "   " + hx(ca[k]) + "   " + hx(bus.readWord(ca[k]) & 0xFFFF, 4));
	console.log("\n  and there they split:");
	console.log("      frame " + FRAME_A + ":  " + [...ca.subarray(i, i + 8)].map(v => hx(v)).join(" "));
	console.log("      frame " + FRAME_B + ":  " + [...cb.subarray(i, i + 8)].map(v => hx(v)).join(" "));
	console.log("\n  The instruction at the LAST common PC is the one that decided. If it is a branch, what");
	console.log("  you need to look at is what it read just before (full-loop / pc-literals).");
}
