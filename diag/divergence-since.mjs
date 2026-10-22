/**
 *    Name:         divergence-since.mjs
 *    Description:  Compares the instruction path of two frames STARTING at a precise event
 *                  (a write of a certain value to a certain address), and says at which
 *                  step they split, with the disassembly around it.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// diag/divergence-frame.mjs compares from VBlank-IN and ITS OWN CONTROL DISPROVED IT: two
// normal frames already diverge at step 274 (the handler's RTE), so the result does not
// distinguish "the bad frame" from "any pair of frames". The problem was not the idea, it was the
// STARTING POINT: start at an event that always happens in the same state.
//
// Here the start is the write of the exact value that triggers the path under investigation. Both
// frames enter that instruction with the same PC, so what is compared afterwards is
// truly comparable.
//
// THE CONTROL (Rule 0): THREE frames are run — two that are known to end well and the
// suspect. If the two good ones also diverge from each other right away, the probe separates nothing and
// nothing is reported. The control pair is passed on the command line, not picked by eye.
//
// Usage: node diag/divergence-since.mjs [game] [addr] [value] [ctrlA] [ctrlB] [bad] [steps]
//   node diag/divergence-since.mjs daytona 0x60a4cb4 3 1099 1103 1106 4000
//
// With value = "pc" the start is PASSING THROUGH THAT ADDRESS instead of writing it. It is the mode
// that works when the event is "enters the critical section", which writes nothing:
//   node diag/divergence-since.mjs daytona 0x6039942 pc 1036 1071 1106 20000

import { readFileSync } from "fs";
import { basename } from "path";

const GAME = process.argv[2] || "daytona";
const ADDR   = parseInt(process.argv[3] || "0x60a4cb4", 16) >>> 0;
const PER_PC = (process.argv[4] || "").toLowerCase() === "pc";
const VALUE = PER_PC ? 0 : (parseInt(process.argv[4] || "3", 10) >>> 0);
const FRAMES = [parseInt(process.argv[5] || "1099", 10), parseInt(process.argv[6] || "1103", 10),
                 parseInt(process.argv[7] || "1106", 10)];
const STEPS = parseInt(process.argv[8] || "4000", 10);

const mod = await import("../headless.mjs?dd=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const source = readFileSync(new URL("../disasm.js", import.meta.url), "utf8");
const disassemble = new Function(source + "\nreturn disassemble;")();
const hx = (v, n = 8) => "0x" + (v >>> 0).toString(16).padStart(n, "0");

const FIRST = Math.min(...FRAMES), LAST = Math.max(...FRAMES);
for(let f = 0; f < FIRST; f++) runFrame();

const cpu = bus.cpuMaster;
let recording = false, trace = null;
const traces = new Map();
let frame = FIRST;

// The trace stores PC + the registers that decide branches (SR for the T flag and the mask).
const origStep = cpu.step.bind(cpu);
cpu.step = function(){
	if(PER_PC && !recording && !traces.has(frame) && (this.pc >>> 0) === ADDR){ recording = true; trace = []; }
	if(recording)
	{
		if(trace.length < STEPS) trace.push([this.pc >>> 0, this.sr >>> 0, this.r[0] >>> 0, this.r[2] >>> 0]);
		else { recording = false; traces.set(frame, trace); }
	}
	return origStep();
};

const origLong = bus.writeLong.bind(bus);
bus.writeLong = function(a, v){
	if(!PER_PC && (a >>> 0) === ADDR && (v >>> 0) === VALUE && !recording && !traces.has(frame))
	{ recording = true; trace = []; }
	return origLong(a, v);
};

for(; frame <= LAST; frame++)
{
	runFrame();
	if(recording){ recording = false; traces.set(frame, trace); }
}

console.log(GAME + ": path from the write of " + VALUE + " at " + hx(ADDR) + "\n");
for(const c of FRAMES)
	console.log("  frame " + c + ": " + (traces.has(c) ? traces.get(c).length + " steps recorded" : "⚠ that write did NOT happen"));
console.log("");

const compare = (a, bq, na, nb) => {
	const ta = traces.get(a), tb = traces.get(bq);
	if(!ta || !tb) return -1;
	const n = Math.min(ta.length, tb.length);
	let i = 0;
	while(i < n && ta[i][0] === tb[i][0]) i++;
	console.log("── " + na + " vs " + nb + ": they split at step " + (i >= n ? "(none in " + n + ")" : i));
	if(i < n)
	{
		const since = Math.max(0, i - 6);
		console.log("     step      " + na.padEnd(16) + "   " + nb);
		for(let k = since; k <= Math.min(i + 2, n - 1); k++)
		{
			const pa = ta[k][0], pb = tb[k][0];
			const da = disassemble(bus.readWord(pa) & 0xFFFF, pa);
			const db = disassemble(bus.readWord(pb) & 0xFFFF, pb);
			console.log("     " + String(k).padStart(6) + (k === i ? " *" : "  ") + "  "
				+ (hx(pa) + " " + da).padEnd(30) + "   " + hx(pb) + " " + db
				+ (k === i ? "   <- HERE" : ""));
		}
		// The T flag of the previous step is what decides almost every SH-2 branch.
		if(i > 0)
			console.log("     T at step " + (i - 1) + ":  " + na + " = " + (ta[i - 1][1] & 1)
				+ "   " + nb + " = " + (tb[i - 1][1] & 1)
				+ "   |  R0 " + hx(ta[i - 1][2]) + " vs " + hx(tb[i - 1][2])
				+ "   R2 " + hx(ta[i - 1][3]) + " vs " + hx(tb[i - 1][3]));
	}
	console.log("");
	return i;
};

// CONTROL first: the two good ones against each other. If they diverge as early as the bad one, it separates nothing.
const iCtrl = compare(FRAMES[0], FRAMES[1], "ctrl " + FRAMES[0], "ctrl " + FRAMES[1]);
const iBad = compare(FRAMES[1], FRAMES[2], "ctrl " + FRAMES[1], "BAD " + FRAMES[2]);

console.log("=== CONTROL ===");
if(iCtrl < 0 || iBad < 0) console.log("  Some trace is missing: no conclusion can be drawn.");
else if(iCtrl <= iBad)
	console.log("  ⚠ The two GOOD frames diverge at step " + iCtrl + ", as early as or earlier than the bad one ("
		+ iBad + "). The probe does NOT separate: the starting point is still bad.");
else
	console.log("  ok: the good ones stay together for " + iCtrl + " steps and the bad one splits at " + iBad
		+ ". The divergence at step " + iBad + " is real.");
