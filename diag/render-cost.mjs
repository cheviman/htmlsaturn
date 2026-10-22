// HOW MUCH DOES PAINTING A FRAME COST, AND IN WHICH PART?
//
// The profiler in Sebas's browser (25-07-2026, SF Alpha) gave:
//     emul 7.32  render 27.54  tot 34.88  2.14 f/raf  27.8 raf/s
// That is 3.4 ms per Saturn frame of EMULATION (against a 16.68 budget) and 27.5 ms
// of RENDER. After cutting the CPU by 30-44%, the bottleneck moved entirely to video: 80%
// of the main thread's time goes into painting.
//
// The pieces of the render live in the chips (vdp2.render and vdp1.compose), so they
// can be measured headless even though the bottleneck only shows in the browser. What does NOT go in here
// is the putImageData and the canvas memcpy, which belong to the browser.
//
// Usage: node diag/render-cost.mjs [game=sfa] [frames=600] [warmup=400]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "sfa";
const FRAMES = parseInt(process.argv[3] || "600", 10);
const WARM   = parseInt(process.argv[4] || "400", 10);
const now  = () => Number(process.hrtime.bigint()) / 1e6;

const mod = await import("../headless.mjs?render=" + GAME);
const { bus, vdp1, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const bios = resolveBios({ xmen: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

for(let f = 0; f < WARM; f++) runFrame();

let tRender = 0, tCompose = 0, tPlot = 0, n = 0;
for(let f = 0; f < FRAMES && !mod.cpu.halted; f++)
{
	const t0 = now();
	runFrame();                       // includes the VDP1 plot
	const t1 = now();

	const cfg = vdp2.configFromRegisters();
	if(!cfg) continue;
	const t2 = now();
	vdp2.render(cfg);                      // the background: layers, priorities, color calc
	const t3 = now();
	vdp1.compose(vdp2.priorities, vdp2.fb, vdp2.shadowOk);   // the sprites on top
	const t4 = now();

	tPlot     += t1 - t0;
	tRender   += t3 - t2;
	tCompose += t4 - t3;
	n++;
}

const ms = (v) => (v / n).toFixed(2).padStart(7) + " ms";
const px = vdp2.width * vdp2.height;
console.log(GAME + ": cost of the video, " + n + " frames of " + vdp2.width + "x" + vdp2.height
	+ " (" + px.toLocaleString() + " px)");
console.log("   emulation+plot   " + ms(tPlot));
console.log("   vdp2.render      " + ms(tRender) + "   " + (1e6 * tRender / n / px).toFixed(0) + " ns/px");
console.log("   vdp1.compose    " + ms(tCompose) + "   " + (1e6 * tCompose / n / px).toFixed(0) + " ns/px");
console.log("   --- video total  " + ms(tRender + tCompose));
