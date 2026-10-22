// HOW MUCH DOES THE MMIO RADAR COST IN THE BROWSER?
//
// The radar (bus.mmioUnknown) logs every access to unmodeled hardware. It is gated
// by bus.logging, and there lies the trap: in headless.mjs it is FALSE and in index.html it is
// TRUE. In other words, no headless probe measures this cost, and the browser pays it in full.
// Each access builds a string ("type:0x0iiiiiii", with toString(16) + padStart) and does a
// get + set on a Map — cheap one at a time, expensive if the game hits there thousands of times per
// frame, and on top of that it is GC garbage.
//
// Sebas (25-07-2026, translated): "maybe the logs affect performance by going to disk, squeeze
// every ms". They do not go to disk, but they do build strings.
//
// Measures: accesses per frame, and ms/frame with the radar on versus off.
//
// Usage: node diag/radar-cost.mjs [game=rally] [frames=800]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "800", 10);
const now  = () => Number(process.hrtime.bigint()) / 1e6;

async function run(logging)
{
	const mod = await import("../headless.mjs?radar=" + logging);
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	const bios = resolveBios({ xmen: "jp" }[GAME] || "us");
	applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
	loadDiscFromCue(resolveGame(GAME));
	bus.logging = logging;   // index.html sets it to true; headless.mjs to false

	for(let f = 0; f < 300; f++) runFrame();     // warm-up
	bus.mmioUnknown.clear();
	const t0 = now();
	for(let f = 0; f < FRAMES; f++) runFrame();
	const ms = (now() - t0) / FRAMES;

	let total = 0;
	const top = [...bus.mmioUnknown.entries()].sort((a, b) => b[1] - a[1]);
	for(const [, n] of top) total += n;
	return { ms, total, keys: bus.mmioUnknown.size, top: top.slice(0, 8) };
}

// Interleaved: the machine has more than enough noise to not believe a single run.
const r = [];
for(let i = 0; i < 2; i++)
{
	r.push(["off", await run(false)]);
	r.push(["on", await run(true)]);
}

const best = (name) => Math.min(...r.filter(x => x[0] === name).map(x => x[1].ms));
const withRadar = r.find(x => x[0] === "on")[1];

console.log(GAME + ", cost of the MMIO radar (" + FRAMES + " frames):");
console.log("  logging=false (headless today) " + best("off").toFixed(3) + " ms/frame");
console.log("  logging=true  (browser today) " + best("on").toFixed(3) + " ms/frame");
console.log("  -> the radar costs " + (best("on") - best("off")).toFixed(3) + " ms/frame");
console.log("  accesses logged: " + withRadar.total + " in " + FRAMES + " frames = "
	+ (withRadar.total / FRAMES).toFixed(1) + " per frame, over " + withRadar.keys + " distinct addresses");
for(const [k, n] of withRadar.top)
	console.log("     " + String(n).padStart(9) + "  " + k);
