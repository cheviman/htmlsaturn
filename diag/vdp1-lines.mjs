// WHY DOES THE VDP1 RASTERIZATION HANG? (Sebas (23-07-2026, translated): "if it hangs we have to
// see why and keep it from happening" — not a failsafe that hides the symptom.)
//
// Structural suspicion in vdp1._iterateLine (the VDP1's Bresenham):
//     const ax = (dx >= 0) ? 1 : -1;
//     if(Math.abs(dx) > 999 || Math.abs(dy) > 999) return 0x7FFFFFFF;
//     for(; x1 !== x2; x1 += ax, i++)
// The loop ends ONLY if x1 lands exactly on x2. Two ways for that to never happen:
//   (a) NaN — the size guard does not catch it (Math.abs(NaN) > 999 is false, i.e. it PASSES)
//       and NaN !== NaN is always true: guaranteed infinite loop.
//   (b) non-integer coordinates — adding 1 at a time from 10.5 never reaches 20.
// A single command like that hangs the worker forever (3D frozen, background running) and in
// synchronous mode it hangs the whole tab.
//
// This probe fixes NOTHING: it measures whether those inputs really happen, in which game and how
// often. It wraps _iterateLine and classifies EACH call before executing it.
//
// Usage: node diag/vdp1-lines.mjs [frames] [game1,game2,...]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "2400", 10);
const GAMES = (process.argv[3] || "rally,vc,sfa,sonic,xmen").split(",");
const BIOS_PER_GAME = { xmen: "jp" };

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?lin=" + encodeURIComponent(game));
	const { vdp1, cpu, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;

	try
	{
		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(7) + " -> could not be mounted: " + e.message); continue; }

	const est = { total: 0, nan: 0, noInteger: 0, giant: 0, maxAbs: 0, examples: [] };
	const orig = vdp1._iterateLine.bind(vdp1);
	vdp1._iterateLine = function(x1, y1, x2, y2, greedy, cb)
	{
		est.total++;
		const vals = [x1, y1, x2, y2];
		const hasNan = vals.some((v) => !Number.isFinite(v));
		const hasFrac = !hasNan && vals.some((v) => !Number.isInteger(v));
		if(hasNan) est.nan++;
		if(hasFrac) est.noInteger++;
		const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
		if(Number.isFinite(dx) && dx > est.maxAbs) est.maxAbs = dx;
		if(Number.isFinite(dy) && dy > est.maxAbs) est.maxAbs = dy;
		if(dx > 999 || dy > 999) est.giant++;
		if((hasNan || hasFrac) && est.examples.length < 8)
			est.examples.push((hasNan ? "NO-FINITO" : "FRACTION") + " (" + x1 + "," + y1 + ")->(" + x2 + "," + y2 + ")");
		// CAREFUL: if a NaN really arrives, calling the original WOULD HANG this probe. The
		// call is skipped in that case: what we want is the diagnosis, not the hang.
		if(hasNan) return 0;
		if(hasFrac) return orig(Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2), greedy, cb);
		return orig(x1, y1, x2, y2, greedy, cb);
	};

	for(let f = 0; f < FRAMES && !cpu.halted; f++) runFrame();

	console.log(game.padEnd(7) + " calls=" + String(est.total).padStart(8) +
		"  NO-FINITAS=" + String(est.nan).padStart(6) +
		"  non-integer=" + String(est.noInteger).padStart(6) +
		"  gigantes=" + String(est.giant).padStart(5) +
		"  largest delta=" + est.maxAbs);
	for(const ej of est.examples) console.log("        " + ej);
}
console.log("\nNON-FINITE or non-integer > 0 means that the for(; x1 !== x2; x1 += ax) may");
console.log("never end: that is where the cause of the hang is, not in the failsafe.");
