// RADAR: which START FACTOR do the SCU DMAs use in each game? The SCU defines 8
// triggers (DxMD bits 2-0): 0 VBlank-IN, 1 VBlank-OUT, 2 HBlank-IN, 3 Timer 0, 4
// Timer 1, 5 Sound Req, 6 Sprite Draw End, 7 immediate. Our emulator only honors 7
// (immediate); it fires ALL the rest at VBlank-IN, without looking at the factor. If games
// only use 7 and 0, the gap does not affect them; if they use HBlank-IN/Timer/Sprite-End, there
// is wrong timing there (per-scanline effects, DMA synced to an event). Measure before touching.
//
// Usage: node diag/scu-dma-factors.mjs [frames] [game1,...]
import { readFileSync } from "fs";
import { basename } from "path";
const FRAMES = parseInt(process.argv[2] || "3000", 10);
const GAMES = (process.argv[3] || "rally,vc,sfa,sonic,xmen").split(",");
const BIOS = { xmen: "jp" };
const NAME = ["VBlank-IN", "VBlank-OUT", "HBlank-IN", "Timer0", "Timer1", "SoundReq", "SpriteDrawEnd", "inmediato"];

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?f=" + encodeURIComponent(game));
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try {
		const b = resolveBios(BIOS[game] || "us");
		applyBios(basename(b), new Uint8Array(readFileSync(b)));
		loadDiscFromCue(resolveGame(game));
	} catch(e){ console.log(game.padEnd(7) + " not mounted: " + e.message); continue; }

	const count = new Array(8).fill(0);
	const orig = bus._scuDma.bind(bus);
	bus._scuDma = (channel) => {
		const md = bus._readRegBE(bus.scuRegs, channel * 0x20 + 0x14, 4) >>> 0;
		count[md & 0x7]++;
		return orig(channel);
	};
	for(let f = 0; f < FRAMES; f++) runFrame();

	const used = count.map((c, i) => c > 0 ? NAME[i] + "=" + c : null).filter(Boolean);
	const problematic = count.slice(1, 7).reduce((a, b) => a + b, 0);   // factors 1-6 (the ones that are wrong)
	console.log(game.padEnd(7) + " -> " + (used.join("  ") || "no DMA") +
		(problematic > 0 ? "   <<< " + problematic + " DMA with a mis-fired factor (neither immediate nor VBlank-IN)" : ""));
}
console.log("\nIf only 'immediate' and 'VBlank-IN' show up, the gap does not affect these games.");
console.log("If HBlank-IN/Timer0/Timer1/SpriteDrawEnd show up, the timing of those DMAs is wrong.");
