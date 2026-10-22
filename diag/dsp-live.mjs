// How many LIVE steps does each game's effects DSP microprogram have?
//
// Decides whether it is worth continuing to optimize _executeDsp (9% of Rally's frame in the
// V8 profile). With FEW live steps and a lot of time, the cost is overhead and there is something
// to remove; with the microprogram full, it is genuine work and the only thing left would be to
// do LESS work (compile the microprogram), not the same work faster.
//
// Usage: node diag/dsp-live.mjs [frames=1200]
import { readFileSync } from "fs";
import { basename } from "path";
const FRAMES = parseInt(process.argv[2] || "1200", 10);
for(const game of ["rally", "sfa", "sonic", "vc"])
{
	const mod = await import("../headless.mjs?alive=" + game);
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	const b = resolveBios("us");
	applyBios(basename(b), new Uint8Array(readFileSync(b)));
	loadDiscFromCue(resolveGame(game));
	let maxAlive = 0, activeFrames = 0;
	for(let f = 0; f < FRAMES; f++)
	{
		runFrame();
		const m = bus.scspEngine;
		if(!m || !m.activeDsp) continue;
		activeFrames++;
		let v = 0;
		for(let i = 0; i < 128; i++) if(m.mpAlive[i]) v++;
		if(v > maxAlive) maxAlive = v;
	}
	console.log(game.padEnd(6) + " DSP active in " + activeFrames + "/" + FRAMES
		+ " frames, max live steps: " + maxAlive + "/128");
}
