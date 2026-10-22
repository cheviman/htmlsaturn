// HOW MUCH OF THE TIME IS THERE AN IMAGE ON SCREEN? A robust measurement, to compare timing
// models without the result depending on the instant it is looked at.
//
// diag/smoke-games.mjs takes ONE snapshot at frame N and reports its variance. It works for "the
// emulator is alive", but NOT for comparing two timing models: if the change makes
// the game reach each screen earlier or later, the snapshot of frame N falls at another moment
// and the result reads as a regression or as an improvement without either being true.
// It happened on 25-07-2026 when the event scheduler was connected.
//
// Here it samples MANY times along the run and reports:
//   - in what % of the samples there was a real image (variance above a threshold)
//   - the maximum of distinct colors seen (the peak richness of the image)
//   - how many samples were black
//
// Usage: node diag/screen-activity.mjs [games] [frames=2400] [every=100]
import { readFileSync } from "fs";
import { basename } from "path";

const GAMES = (process.argv[2] || "rally,vc,sfa,sonic").split(",");
const FRAMES = parseInt(process.argv[3] || "2400", 10);
const EACH   = parseInt(process.argv[4] || "100", 10);
const BIOS_PER_GAME = { xmen: "jp" };

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?activ=" + game);
	const { bus, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try
	{
		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(7) + " -> could not mount: " + e.message); continue; }

	let samples = 0, withImage = 0, maxColors = 0, maxVariance = 0;
	for(let f = 0; f < FRAMES && !mod.cpu.halted; f++)
	{
		runFrame();
		if((f + 1) % EACH !== 0) continue;

		const cfg = vdp2.configFromRegisters();
		if(!cfg){ samples++; continue; }
		vdp2.render(cfg);
		const fb = vdp2.fb;
		// Variance of the red channel and distinct colors, over a grid (there is no need
		// to look at the 76,800 pixels to know whether there is an image).
		let n = 0, sum = 0, sum2 = 0;
		const colors = new Set();
		for(let i = 0; i < fb.length; i += 4 * 7)
		{
			const r = fb[i], g = fb[i + 1], b = fb[i + 2];
			sum += r; sum2 += r * r; n++;
			colors.add((r << 16) | (g << 8) | b);
		}
		const variance = n ? Math.round(sum2 / n - (sum / n) * (sum / n)) : 0;
		samples++;
		if(variance > 50) withImage++;
		if(colors.size > maxColors) maxColors = colors.size;
		if(variance > maxVariance) maxVariance = variance;
	}

	console.log(game.padEnd(7)
		+ " image in " + (samples ? (100 * withImage / samples).toFixed(0) : "0").padStart(3) + "% of the samples"
		+ "   peak colors " + String(maxColors).padStart(4)
		+ "   max variance " + String(maxVariance).padStart(6)
		+ "   (" + samples + " samples of " + FRAMES + " frames)");
}
