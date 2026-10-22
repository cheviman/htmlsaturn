/**
 *    Name:         vdp1-plot-ceiling.mjs
 *    Description:  The CEILING of splitting the VDP1 plot across N threads, measured BEFORE writing
 *                  the refactor. Separates what each thread would have to pay IN FULL (walking the
 *                  list and the textures) from what gets split (writing the pixel).
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// Measuring the ceiling before writing is the repo's rule, and it already saved a whole
// VDP2 refactor (real ceiling: 5%) and kept us from accepting the JIT avenue. The VDP1 plot is the measured
// bottleneck in-game (10-12 ms out of 16.68), and the obvious way out —splitting it into bands like the VDP2—
// has a problem that has to be quantified FIRST:
//
// **A VDP1 "scanline" is NOT a framebuffer row.** The VDP2 rasterizes independent
// rows, so thread k takes lines k, k+N, k+2N and that is it. The VDP1 walks a
// COMMAND LIST and, in a distorted sprite, each iteration goes from (xL,yL) to (xR,yR): an
// arbitrary DIAGONAL that crosses several rows. So it cannot be split by skipping
// iterations of the loop — the split can only filter PER PIXEL, and then each thread pays
// the walk, the interpolation and the texture read in full.
//
// That is exactly the split this probe measures:
//    T        = the full plot
//    common   = what ALL threads would pay the same (everything except writing the pixel)
//    split    = T - common
//    ceiling(N) = T / (common + split/N)
//
// THE RIGHT ABLATION IS `_putpixel`, NOT `_pixelDraw`. The drawing cutoff is governed by
// `_getpixel` from inside `_pixelDraw` (it counts the texture's "ends" and returns true),
// so neutralizing all of `_pixelDraw` would make the loop run too long: it would change the
// LOAD and measure something else. It is the trap of "a probe that removes the condition".
//
// THE CONTROL (Rule 0), three of them:
//   1. The calls to `_pixelDraw` and to `_putpixel` are counted in both branches. If they do not come out
//      IDENTICAL, the ablation changed the load and nothing is reported.
//   2. A `control-2` branch is run, which is the full one again. It has to give ~0% against the
//      full one; if it gives a value similar to the effect sought, what is being measured is the order.
//   3. The order of the branches is COUNTERBALANCED (it rotates on each rep), because with a fixed order the
//      first one runs systematically better and the bias reached 4.5% in this repo.
//
// Usage: node diag/vdp1-plot-ceiling.mjs [game] [reps] [warm] [measure]
//   node diag/vdp1-plot-ceiling.mjs xmenvs 3 900 300

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const BRANCHES = ["completa", "no-putpixel", "control-2"];
const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAME = process.argv[2] || "xmenvs";
	const REPS  = parseInt(process.argv[3] || "3", 10);
	const WARM  = process.argv[4] || "900";
	const MEASURE = process.argv[5] || "300";
	const yo = fileURLToPath(import.meta.url);

	console.log("CEILING OF SPLITTING THE VDP1 PLOT — " + GAME
		+ "   (warm " + WARM + ", measure " + MEASURE + ", " + REPS + " counterbalanced reps)\n");

	const res = {};
	for(const r of BRANCHES) res[r] = [];
	let load = {};
	for(let rep = 0; rep < REPS; rep++)
	{
		// COUNTERBALANCING: the order rotates on each rep so that each branch takes each position.
		const order = BRANCHES.map((_, i) => BRANCHES[(i + rep) % BRANCHES.length]);
		for(const branch of order)
		{
			const p = spawnSync(process.execPath, [yo, GAME, branch, WARM, MEASURE, "--child"],
				{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
			const line = (p.stdout || "").trim().split("\n").pop() || "";
			const m = line.match(/^([\d.]+) (\d+) (\d+)$/);
			if(!m){ console.log("  " + branch + " -> failed: " + ((p.stderr || line).split("\n")[0])); continue; }
			res[branch].push(parseFloat(m[1]));
			load[branch] = { pixelDraw: parseInt(m[2], 10), putpixel: parseInt(m[3], 10) };
		}
	}

	const min = (a) => a.length ? Math.min(...a) : NaN;
	console.log("branch          min ms/frame    runs");
	for(const r of BRANCHES)
		console.log("  " + r.padEnd(14) + min(res[r]).toFixed(4).padStart(11) + "      "
			+ res[r].map(v => v.toFixed(3)).join("  "));

	// --- CONTROL 1: the load has to be identical ---
	console.log("\n=== CONTROL 1: the ablation cannot change the load ===");
	const c1 = load["completa"], c2 = load["no-putpixel"];
	if(!c1 || !c2){ console.log("  runs missing: no conclusion."); process.exit(0); }
	console.log("  calls to _pixelDraw:   completa " + c1.pixelDraw + "   no-putpixel " + c2.pixelDraw);
	console.log("  calls to _putpixel:    completa " + c1.putpixel + "   no-putpixel " + c2.putpixel);
	const loadOk = c1.pixelDraw === c2.pixelDraw && c1.putpixel === c2.putpixel;
	if(!loadOk)
	{
		console.log("\n  ⚠ THE LOAD CHANGED: the ablation removed work it did not mean to remove.");
		console.log("  No ceiling is reported. The ablation has to be fixed first.");
		process.exit(0);
	}
	console.log("  ok: identical.");

	// --- CONTROL 2: the noise/order ---
	const T = min(res["completa"]), C2 = min(res["control-2"]), A = min(res["no-putpixel"]);
	const bias = Math.abs(C2 - T) / T * 100;
	console.log("\n=== CONTROL 2: completa against control-2 (IDENTICAL code) ===");
	console.log("  diferencia: " + bias.toFixed(2) + "%");
	const effect = (T - A) / T * 100;
	if(bias > effect / 3)
	{
		console.log("  ⚠ The control drifts " + bias.toFixed(2) + "% and the effect sought is "
			+ effect.toFixed(2) + "%. Same order of magnitude: it CANNOT be read. Raise the reps.");
		process.exit(0);
	}
	console.log("  ok: the control is well below the effect (" + effect.toFixed(2) + "%).");

	// --- The ceiling ---
	const common = A, split = T - A;
	console.log("\n=== THE SPLIT OF THE COST ===");
	console.log("  full plot:                            " + T.toFixed(4) + " ms/frame");
	console.log("  COMMON (each thread pays it IN FULL): " + common.toFixed(4) + " ms   ("
		+ (common / T * 100).toFixed(1) + "%)");
	console.log("  SPLITTABLE (writing the pixel):       " + split.toFixed(4) + " ms   ("
		+ (split / T * 100).toFixed(1) + "%)");
	console.log("\n=== THE CEILING, filtering per pixel (UPPER BOUND: does not count synchronization or contention) ===");
	console.log("  threads ms/frame    speedup");
	for(const n of [2, 3, 4])
	{
		const t = common + split / n;
		console.log("  " + String(n).padStart(5) + "   " + t.toFixed(4).padStart(9)
			+ "   " + (T / t).toFixed(2) + "x");
	}
	console.log("\nIt is an UPPER BOUND, and an optimistic one: it does not include the cost of synchronizing the threads");
	console.log("or memory contention, which on the VDP2 we already saw eat part of it. If the");
	console.log("ceiling with 4 threads is not enough to bring the plot within budget, splitting");
	console.log("per pixel is NOT the way and the per-pixel cost has to be attacked.");
	process.exit(0);
}

// ---------------- child: one branch ----------------
const GAME = process.argv[2];
const BRANCH  = process.argv[3];
const WARM  = parseInt(process.argv[4], 10);
const MEASURE = parseInt(process.argv[5], 10);

const mod = await import("../headless.mjs?tp=" + GAME + BRANCH);
const { bus, vdp1, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

let nPixelDraw = 0, nPutpixel = 0;

// The counters go in BOTH branches: they are the control that the load did not change.
const origPixelDraw = vdp1._pixelDraw.bind(vdp1);
vdp1._pixelDraw = function(x, y, i){ nPixelDraw++; return origPixelDraw(x, y, i); };

const origPutpixel = vdp1._putpixel.bind(vdp1);
if(BRANCH === "no-putpixel")
	// It is counted the same and NOT written: that is exactly what a thread whose band
	// does not include this pixel would save. Everything else (walk, interpolation, texture) was already paid.
	vdp1._putpixel = function(){ nPutpixel++; };
else
	vdp1._putpixel = function(cmd, x, y){ nPutpixel++; return origPutpixel(cmd, x, y); };

// WITH INPUT (INPUT=1): without pressing START the games do not get past the attract mode, and the headless VDP1
// plot costs 0.04-0.13 ms — i.e. NOTHING, buried in the machine's noise. Where the plot
// weighs (10-12 ms measured in Chrome) is IN-GAME, and that is only reached by navigating.
const START = 0x08;
for(let f = 0; f < WARM; f++)
{
	if(process.env.INPUT) bus.pad1a = (f % 30 < 6) ? (0xFF & ~START) : 0xFF;
	runFrame();
}
if(process.env.INPUT) bus.pad1a = 0xFF;

// ONLY plot() is measured, not the whole frame.
let ms = 0;
const origPlot = vdp1.plot.bind(vdp1);
vdp1.plot = function(){
	const t0 = process.hrtime.bigint();
	const r = origPlot();
	ms += Number(process.hrtime.bigint() - t0) / 1e6;
	return r;
};
nPixelDraw = 0; nPutpixel = 0;
for(let f = 0; f < MEASURE; f++) runFrame();

console.log((ms / MEASURE).toFixed(4) + " " + nPixelDraw + " " + nPutpixel);
