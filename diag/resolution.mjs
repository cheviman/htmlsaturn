// WHAT RESOLUTION DOES EACH GAME ASK FOR, AND WHICH ONE ARE WE GIVING IT?
//
// Sebas (25-07-2026, translated), about Daytona and Sega Touring Car: "the output resolution
// is wrong". Before touching anything we need to know what the game asks for (VDP2's TVMD) and what
// the emulator resolves, and whether there is a difference.
//
// TVMD (VDP2 reg 0x00):
//   HRESO (bits 2-0): 0=320  1=352  2=640  3=704  4=320(excl)  5=352(excl)  6=640  7=704
//   VRESO (bits 5-4): 0=224  1=240  2=256
//   LSMD  (bits 7-6): 0=non-interlaced  2=single-density  3=double-density (height x2)
//
// The emulator rasterizes the 640/704 modes AT HALF (see the //? in
// _configureResolution in vdp2.js), so a hi-res game comes out with half of the
// image stretched: exactly the reported symptom.
//
// Usage: node diag/resolution.mjs [games] [frames=3000]
import { readFileSync } from "fs";
import { basename } from "path";

const GAMES = (process.argv[2] || "rally,vc,sfa,sonic,daytona,daycce,touring,vf2").split(",");
const FRAMES = parseInt(process.argv[3] || "3000", 10);
const BIOS_PER_GAME = { xmen: "jp", rally: "us" };

const HRESO_WIDTH = [320, 352, 640, 704, 320, 352, 640, 704];
const VRESO_HEIGHT  = [224, 240, 256, 256];
const LSMD = ["non-interlaced", "?", "single-density", "double-density"];

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?reso=" + game);
	const { bus, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try
	{
		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(8) + " -> could not mount: " + e.message); continue; }

	// We count how many frames it spends in EACH mode: a game changes resolution between the
	// intro, the menus and in-game, so a single sample says nothing.
	const modes = new Map();
	for(let f = 0; f < FRAMES && !mod.cpu.halted; f++)
	{
		runFrame();
		const tvmd = vdp2._r(0x00) >>> 0;
		if(!(tvmd & 0x8000)) continue;              // DISP off: there is no image
		const key = tvmd & 0x00FF;                 // HRESO + VRESO + LSMD
		modes.set(key, (modes.get(key) || 0) + 1);
	}

	const order = [...modes.entries()].sort((a, b) => b[1] - a[1]);
	if(!order.length){ console.log(game.padEnd(8) + " -> never turned DISP on"); continue; }

	console.log("\n=== " + game + " ===");
	for(const [key, n] of order.slice(0, 5))
	{
		const hreso = key & 0x7, vreso = (key >> 4) & 0x3, lsmd = (key >> 6) & 0x3;
		const request = HRESO_WIDTH[hreso] + "x" + (VRESO_HEIGHT[vreso] * (lsmd === 3 ? 2 : 1));
		// What the emulator resolves TODAY for that TVMD.
		bus.vdp2Regs[0x00] = (0x80 | ((key >> 8) & 0x7F)); bus.vdp2Regs[0x01] = key & 0xFF;
		vdp2.configureResolution();
		const give = vdp2.width + "x" + vdp2.height;
		const bad = (HRESO_WIDTH[hreso] !== vdp2.width);
		console.log("  " + String(n).padStart(5) + " frames  TVMD=..." + key.toString(16).padStart(2, "0")
			+ "  asks " + request.padEnd(8)
			+ "  gives " + give.padEnd(8)
			+ "  " + LSMD[lsmd]
			+ (bad ? "   <<< WRONG: it is rasterized at half the width" : ""));
	}
}
