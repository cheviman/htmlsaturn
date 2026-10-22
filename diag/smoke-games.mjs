// Multi-game SMOKE TEST: a change in the SCU DMA touches ALL games, so
// fixing Sega Rally is not enough — we have to see that the others still boot.
// For each game: boots N frames and reports whether the CPU is still alive, whether the screen has
// content (framebuffer variance) and how many bytes the DMA moved. It does not judge colors:
// it only detects disaster (core halted, black screen, silent DMA).
//
// Usage: node diag/smoke-games.mjs [frames] [game1,game2,...]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "900", 10);
const GAMES = (process.argv[3] || "rally,vc,sfa,sonic").split(",");

for(const game of GAMES)
{
	// Fresh import per game: headless.mjs has global state (bus, cpu, vdp).
	const mod = await import("../headless.mjs?j=" + encodeURIComponent(game));
	const { bus, vdp2, cpu, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	let path = null;
	try { path = resolveGame(game); }
	catch(e){ console.log(game.padEnd(7) + " -> game not found, skipped"); continue; }

	try
	{
		applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
		loadDiscFromCue(path);
	}
	catch(e){ console.log(game.padEnd(7) + " -> could not be mounted: " + e.message); continue; }

	// Count the bytes the SCU DMA moves, to see that the count fix really moves them
	// and no transfers are left at zero.
	let bytesDma = 0, dmas = 0;
	const origCopy = bus._scuDmaCopy.bind(bus);
	bus._scuDmaCopy = (s, il, d, ie, cnt) => { dmas++; bytesDma += cnt | 0; return origCopy(s, il, d, ie, cnt); };

	for(let f = 0; f < FRAMES && !cpu.halted; f++) runFrame();

	// Framebuffer variance: high = image with content, 0 = flat screen.
	let variance = 0, colors = 0;
	try
	{
		const cfg = vdp2.configFromRegisters();
		if(cfg) vdp2.render(cfg);
		let s = 0, s2 = 0, n = 0;
		const seen = new Set();
		for(let i = 0; i < vdp2.fb.length; i += 16)
		{
			const v = vdp2.fb[i]; s += v; s2 += v * v; n++;
			if(seen.size < 500) seen.add((vdp2.fb[i] << 16) | (vdp2.fb[i + 1] << 8) | vdp2.fb[i + 2]);
		}
		variance = Math.round(s2 / n - (s / n) * (s / n));
		colors = seen.size;
	}
	catch(e){ variance = -1; }

	const state = cpu.halted ? "HALTED" : "alive";
	console.log(game.padEnd(7) + " -> cpu " + state.padEnd(9) +
		" variance " + String(variance).padStart(6) +
		"  colors " + String(colors).padStart(4) +
		"  DMA " + String(dmas).padStart(5) + " transfers / " +
		String(bytesDma).padStart(9) + " bytes" +
		(cpu.halted ? "   <<< IT HALTED" : (variance === 0 ? "   <<< FLAT SCREEN" : "")));
}
