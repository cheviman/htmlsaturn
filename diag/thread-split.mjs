/**
 *    Name:         thread-split.mjs
 *    Description:  how much work per frame falls to each thread, broken down
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE QUESTION: the browser says the main thread uses 2.6-4.8 ms of its 16.68 and the
// worker ~22 ms of its own (measured by Sebas on 27-07-2026: 40-54 emulated/s with the queue
// capped at 3). That is, the total work FITS in two threads and is badly split. To
// move something back we need to know WHAT, and that is this breakdown.
//
// TODAY's split, which is the one measured here:
//   main thread -> runFrame() minus the plot: SH-2, SCU, SCSP, CD, SMPC, scheduler
//   worker      -> vdp1.plot() + vdp2.render() + vdp1.compose() + the 32-bit merge
//
// CONTROL (without it nothing is reported, CLAUDE.md): the FULL frame is also measured without
// instrumentation, and the sum of the parts has to come out roughly that. If it is off by more than
// 15%, the instrumentation costs more than what it measures and the number is not valid.
// Second control: if vdp2.render gives ~0 ms the game is not drawing and the run is useless.
//
// THE CONTROL IS INTERLEAVED (A,B,A,B) AND THE MINIMUM IS COMPARED. The first version ran the
// control on one range of frames and the measurement on another, that is COMPARING DIFFERENT SCENES:
// in SF Alpha it gave a 19.5% deviation with the instrumented one coming out CHEAPER than the
// control, which is impossible. It is the same trap that ruined diag/interleave-cost.mjs and the
// measurement of the reset cost. The project's rule is explicit: "every A/B is interleaved
// (A,B,A,B) and the MINIMUM of each branch is compared".
//
// Usage: node diag/thread-split.mjs [game=rally] [frames=250] [warmup=900]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "250", 10);
const WARM   = parseInt(process.argv[4] || "900", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };
const now = () => Number(process.hrtime.bigint()) / 1e6;

const mod = await import("../headless.mjs?reparto=" + GAME);
const { vdp1, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios(BIOS_PER_GAME[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

for(let f = 0; f < WARM; f++) runFrame();

// The plot is timed by wrapping the method. Wrapping it makes the call polymorphic and
// a bit more expensive: that is why the wrapper is PUT ON AND TAKEN OFF, and the blocks are interleaved.
let msPlot = 0, plotN = 0;
const plotOrig = vdp1.plot.bind(vdp1);
const withWrapper = () => { vdp1.plot = function(){ const t = now(); const r = plotOrig(); msPlot += now() - t; plotN++; return r; }; };
const noWrapper = () => { vdp1.plot = plotOrig; };

const BLOCKS = 6, PER_BLOCK = Math.max(20, Math.round(FRAMES / BLOCKS));
let msVdp2 = 0, msComp = 0, msMerge = 0, frames = 0, px = 0;
const output = new Uint8Array(704 * 448 * 4);
// One average per block in each branch; then the MINIMUM of each one is compared.
const branchControl = [], branchMeasure = [];

for(let b = 0; b < BLOCKS && !cpu.halted; b++)
{
	// --- branch A: control, the full frame with NOTHING instrumented ---
	noWrapper();
	let acc = 0, n = 0;
	for(let f = 0; f < PER_BLOCK && !cpu.halted; f++)
	{
		const t = now();
		runFrame();
		acc += now() - t;
		n++;
	}
	if(n) branchControl.push(acc / n);

	// --- branch B: measurement, with the wrapper and the video breakdown ---
	withWrapper();
	acc = 0; n = 0;
	for(let f = 0; f < PER_BLOCK && !cpu.halted; f++)
	{
		let t = now();
		runFrame();
		acc += now() - t;
		n++;

		const cfg = vdp2.configFromRegisters();
		if(!cfg) continue;

		t = now();
		vdp2.render(cfg);
		msVdp2 += now() - t;

		t = now();
		const spr = vdp1.compose(vdp2.priorities, vdp2.fb, vdp2.shadowOk);
		msComp += now() - t;

		// The 32-bit merge, just as composeFrame() does it in the worker: copy the
		// VDP2 background to the output and overwrite it with the VDP1 pixels with alpha.
		t = now();
		const view = output.subarray(0, vdp2.fb.length);
		view.set(vdp2.fb);
		const d32 = new Uint32Array(view.buffer, view.byteOffset, view.length >> 2);
		const s32 = new Uint32Array(spr.buffer, spr.byteOffset, spr.length >> 2);
		for(let i = 0; i < d32.length; i++){ const s = s32[i]; if(s & 0xFF000000) d32[i] = s; }
		msMerge += now() - t;

		frames++;
		px = vdp2.width * vdp2.height;
	}
	if(n) branchMeasure.push(acc / n);
}
noWrapper();

if(!frames){ console.log(GAME + ": 0 frames with an image, the run is useless"); process.exit(1); }

const p = (x) => (x / frames).toFixed(2).padStart(6);
const plot = plotN ? msPlot / plotN : 0;
const vdp2ms = msVdp2 / frames, comp = msComp / frames, merge = msMerge / frames;
const control = Math.min(...branchControl);   // minimum of each branch, not the average: there is noise
const frame = Math.min(...branchMeasure);
const main = frame - plot;            // what stays on the main thread today
const worker = plot + vdp2ms + comp + merge;

console.log(GAME + ": " + vdp2.width + "x" + vdp2.height + " (" + px.toLocaleString("es") + " px)   " + frames + " frames");
console.log("   MAIN THREAD today    " + main.toFixed(2).padStart(6) + " ms   (CPU + chips, without the plot)");
console.log("   WORKER today         " + worker.toFixed(2).padStart(6) + " ms");
console.log("      vdp1.plot      " + p(msPlot)  + " ms");
console.log("      vdp2.render       " + p(msVdp2)  + " ms");
console.log("      vdp1.compose     " + p(msComp)  + " ms");
console.log("      32-bit merge      " + p(msMerge) + " ms");
console.log("   TOTAL of both        " + (main + worker).toFixed(2).padStart(6) + " ms   (budget: 16.68 per thread)");

// --- CONTROLS ---
const deviation = Math.abs(frame - control) / control * 100;
console.log("   control: uninstrumented frame " + control.toFixed(2) + " ms against " + frame.toFixed(2) +
	" instrumented (minimum of " + branchControl.length + " interleaved blocks)  ->  deviation " +
	deviation.toFixed(1) + "%" + (deviation > 15 ? "   <-- UNRELIABLE MEASUREMENT" : "   ok"));
if(vdp2ms < 0.01) console.log("   control: vdp2.render ~0 ms, the game is NOT drawing -> the run is useless");
