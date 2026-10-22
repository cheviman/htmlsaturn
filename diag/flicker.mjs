// DOES THE VDP1 FLICKER, AND IS IT THE ENGINE? Erase/plot/swap cycle per frame, without a worker.
//
// Sebas reports the SAME symptom in every game (Sega Rally, Daytona CCE, Sega Touring Car, SF
// Alpha), translated: "the sky flickers" and "it does not clear the old sprites properly",
// broken "since yesterday".
// There are two possible causes and the fixes are opposite:
//
//   A) the WORKER protocol (the main thread sends it garbage or skips dispatches)
//   B) the ENGINE's erase/plot/swap cycle (plot at the end of the frame, new scheduler)
//
// This probe runs WITHOUT a worker and WITHOUT a browser: whatever shows up here is (B) for sure, and
// it serves to bisect against yesterday's commit. It measures a FACT of the engine -how many times per frame
// the VDP1 erases, draws and swaps banks-, not "how it looks" (that only counts in the
// browser and Sebas tests it).
//
// Summary by windows so two commits can be compared at a glance:
//   plot%   = frames in which the VDP1 drew the list
//   erase%  = frames in which it erased the draw bank BEFORE drawing
//   swap%   = frames in which it swapped the banks
//   live    = non-zero pixels of the display bank (min..max in the window)
//   crossings = times the display went from "with image" to "almost empty" = FLICKER
//
// The relationship that matters: a game that draws has to ERASE. High plot with erase% at zero
// is exactly "it does not clear the old sprites", measured.
//
// Usage: node diag/flicker.mjs [game=rally] [frames=2400] [window=300]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "rally";
const FRAMES  = parseInt(process.argv[3] || "2400", 10);
const WINDOW = parseInt(process.argv[4] || "300", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };

const mod = await import("../headless.mjs?parp=" + GAME);
const { vdp1, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios(BIOS_PER_GAME[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// Non-zero pixels of the display bank. Subsampled every 8 bytes: more than enough to
// tell "there is an image" from "it is empty" and it does not distort the run.
function alive(buf)
{
	let n = 0;
	for(let i = 0; i < buf.length; i += 8) if(buf[i] || buf[i + 1]) n++;
	return n;
}

console.log("GAME " + GAME + "   " + FRAMES + " frames, windows of " + WINDOW);
console.log("");
console.log("   frames        plot%  erase%   swap%         live min..max   crossings");

let acc = { p: 0, b: 0, s: 0, n: 0, min: Infinity, max: 0, crossings: 0, prev: null };
let peakGlobal = 0, crossingsTotal = 0;

for(let f = 1; f <= FRAMES && !cpu.halted; f++)
{
	runFrame();
	const v = alive(vdp1._fbDisplay);
	acc.n++;
	if(vdp1.lastPlot)    acc.p++;
	if(vdp1.lastErase) acc.b++;
	if(vdp1.lastSwap)    acc.s++;
	if(v < acc.min) acc.min = v;
	if(v > acc.max) acc.max = v;
	if(v > peakGlobal) peakGlobal = v;

	// Crossing = the display went from having an image to being almost empty (or the other way) against a
	// threshold relative to the peak of THIS window. Flickering is crossing repeatedly.
	const full = v > acc.max * 0.25;
	if(acc.prev !== null && acc.prev !== full) acc.crossings++;
	acc.prev = full;

	if(acc.n === WINDOW || f === FRAMES)
	{
		const pc = (x) => (x * 100 / acc.n).toFixed(0).padStart(3) + "%";
		console.log("  " + String(f - acc.n + 1).padStart(5) + ".." + String(f).padStart(5) +
			"    " + pc(acc.p) + "    " + pc(acc.b) + "    " + pc(acc.s) +
			"    " + String(acc.min).padStart(7) + ".." + String(acc.max).padStart(7) +
			"   " + String(acc.crossings).padStart(4) + (acc.crossings > 4 ? "  <<<" : ""));
		crossingsTotal += acc.crossings;
		acc = { p: 0, b: 0, s: 0, n: 0, min: Infinity, max: 0, crossings: 0, prev: null };
	}
}

console.log("");
console.log("  peak of the run: " + peakGlobal + " pixels   total crossings: " + crossingsTotal +
	(crossingsTotal > 8 ? "   <<< IT FLICKERS, and it is the ENGINE (there is no worker here)" : "   (stable in the engine)"));
