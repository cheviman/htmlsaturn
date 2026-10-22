/**
 *    Name:         cpu-split.mjs
 *    Description:  How much of the emulation time EACH CPU takes (master, slave, 68000) and
 *                  how many instructions each one executes. Answers whether a game's bottleneck
 *                  is the master, the slave, or the split between the two.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// Daytona USA runs at 44-50 of 60 frames with BOTH BOTTLENECKS maxed out: the VDP1 plot
// (12-17 ms) and the main thread (emul 15-18 ms, that is 90-106%). And what separates it from Daytona
// CCE -which has the main thread at 44-70%- is that **USA uses the slave for 3D and CCE
// does not**. That is in external sources ("Daytona USA is one of the games that uses 100%
// slave CPU") and it fits the symptom, but **IT WAS NEVER MEASURED how much of emul is the slave**.
//
// It matters because it changes what can be done:
//   - if the slave is a small fraction, the bottleneck is the master and everything about the SH-2 is
//     already measured and exhausted (see PENDING.md section 7);
//   - if the slave is half, then USA's work is genuinely double and the
//     idle-skip -which exists precisely because of Daytona's slave wait loop- does not help it
//     in gameplay, because there the slave is NOT idle.
//
// And there is a third thing only this measurement can answer: whether the cycle SPLIT between
// master and slave is the right one. The Saturn's two SH-2s run at the same frequency, so
// for equal work they should take similar times.
//
// THE CONTROL (Rule 0), two of them:
//   1. A game that does NOT use the slave for anything heavy (Daytona CCE, same engine as
//      Rally) is run as the control: there the slave has to come out as a small fraction. If it comes out as in
//      USA, the probe is not separating the CPUs.
//   2. The INSTRUCTIONS of each one are reported, not just the time. Time without instructions
//      says nothing: a CPU can take a lot of clock because of the measurement wrapper. If the
//      time/instruction ratio differs a lot between the two, it is the probe and not the split.
//
// ⚠ The absolutes are INFLATED by the wrapper (same case as frame-profile.mjs and
// interleave-cost.mjs). What counts is the PROPORTION.
//
// Usage: node diag/cpu-split.mjs [games] [frames]
//   INPUT=1 node diag/cpu-split.mjs daytona,daycce 1200

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAMES = (process.argv[2] || "daytona,daycce,rally,sfa").split(",");
	const FRAMES = process.argv[3] || "1200";
	const yo = fileURLToPath(import.meta.url);
	console.log("SPLIT OF EMULATION TIME AMONG THE CPUs — " + FRAMES + " frames"
		+ (process.env.INPUT ? "   (WITH INPUT)" : "   (no input: attract mode)") + "\n");
	console.log("game       master        slave         68000        instr master   instr slave   ns/instr M:S");
	for(const j of GAMES)
	{
		const r = spawnSync(process.execPath, [yo, j, FRAMES, "--child"],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: process.env });
		process.stdout.write(r.stdout || ("  " + j + " -> failed: " + (r.stderr || "").split("\n")[0] + "\n"));
	}
	console.log("\nThe CONTROL is daycce: same engine as Rally and it does NOT use the slave for 3D,");
	console.log("so its slave has to come out as a small fraction. If it comes out the same as USA,");
	console.log("the probe does not separate the CPUs and no row should be believed.");
	console.log("And similar ns/instr between master and slave is what says the split is healthy:");
	console.log("both SH-2s run at the same frequency, so equal work, equal cost.");
	process.exit(0);
}

// ---------------- child ----------------
const GAME  = process.argv[2];
const FRAMES = parseInt(process.argv[3], 10);
const mod = await import("../headless.mjs?rc=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, get68k } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

let nsM = 0, nsS = 0, ns68 = 0, iM = 0, iS = 0, measuring = false;

// ⚠ THE CPUs DO NOT HAVE A `run()` TO WRAP. The cycle split lives in the loop of
// headless.mjs / index.html, which calls `cpu.step()` DIRECTLY (and `runDry()` for the
// idle-skip). So we have to measure in those two, which get called hundreds of thousands of times per
// frame: the wrapper INFLATES the absolutes.
// It does not matter for what is being asked: it inflates both CPUs EQUALLY, so the PROPORTION —which is the
// datum— holds. It is the same criterion as frame-profile.mjs and interleave-cost.mjs.
const hookSh2 = (cpu, isMaster) => {
	if(!cpu || cpu.__rc) return;
	cpu.__rc = true;
	const origStep = cpu.step.bind(cpu);
	cpu.step = function(){
		if(!measuring) return origStep();
		const t0 = process.hrtime.bigint();
		const r = origStep();
		const d = Number(process.hrtime.bigint() - t0);
		if(isMaster){ nsM += d; iM++; } else { nsS += d; iS++; }
		return r;
	};
	// The idle-skip does NOT go through step() and takes 58-74% of the iterations: without this half of the
	// CPU time would go uncounted.
	const origDry = cpu.runDry.bind(cpu);
	cpu.runDry = function(n){
		if(!measuring) return origDry(n);
		const t0 = process.hrtime.bigint();
		const r = origDry(n);
		const d = Number(process.hrtime.bigint() - t0);
		if(isMaster) nsM += d; else nsS += d;
		return r;
	};
};

const hook68k = () => {};   //? the 68000 is left out: the question is master versus slave

const START = 0x08;
const warm = Math.min(900, Math.floor(FRAMES / 2));
for(let f = 0; f < warm; f++)
{
	hookSh2(bus.cpuMaster, true); hookSh2(bus.cpuSlave, false); hook68k();
	if(process.env.INPUT) bus.pad1a = (f % 30 < 6) ? (0xFF & ~START) : 0xFF;
	runFrame();
}
if(process.env.INPUT) bus.pad1a = 0xFF;

measuring = true;
for(let f = 0; f < FRAMES; f++)
{
	hookSh2(bus.cpuMaster, true); hookSh2(bus.cpuSlave, false); hook68k();
	runFrame();
}

const tot = nsM + nsS + ns68;
const ms = (n) => (n / 1e6 / FRAMES).toFixed(2);
const pct = (n) => tot ? " (" + (n / tot * 100).toFixed(0) + "%)" : "";
const nsPerInstr = (n, i) => i ? (n / i).toFixed(1) : "-";
console.log(GAME.padEnd(9)
	+ (ms(nsM) + " ms" + pct(nsM)).padStart(13)
	+ (ms(nsS) + " ms" + pct(nsS)).padStart(14)
	+ (ms(ns68) + " ms" + pct(ns68)).padStart(13)
	+ String(Math.round(iM / FRAMES)).padStart(15)
	+ String(Math.round(iS / FRAMES)).padStart(14)
	+ ("   " + nsPerInstr(nsM, iM) + " : " + nsPerInstr(nsS, iS)).padStart(16));
