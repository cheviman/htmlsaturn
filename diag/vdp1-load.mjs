// VDP1 BY CYCLES — step 1: measure the real load. How many pixels and commands does the
// VDP1 draw per frame in each game? If some game goes over the chip's real budget, that is
// where the slowdown is that our games are missing (they draw instantly). It serves to
// size the cycle budget before implementing the spread-out drawing.
//
// The VDP1 runs at the system clock (~26.84 MHz NTSC). A pixel costs on the order of 1 cycle
// (plus per-command overhead). In a 59.94 Hz frame there are ~447,443 cycles, but the VDP1
// only draws during a window (not the whole frame). Rough reference from Mednafen: the
// VDP1 draws ~a few hundred thousand pixels per frame as a ceiling. We measure the real
// peak to know how much over budget there is.
//
// Usage: node diag/vdp1-load.mjs [frames] [game1,game2,...]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "2000", 10);
const GAMES = (process.argv[3] || "rally,vc,sfa,sonic,xmen").split(",");
const BIOS_PER_GAME = { xmen: "jp" };

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?vc=" + encodeURIComponent(game));
	const { bus, vdp1, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try
	{
		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(7) + " -> could not be mounted: " + e.message); continue; }

	// Count pixels per frame: wrap the two writers of the VDP1 framebuffer.
	let pixFrame = 0, cmdFrame = 0;
	let pixMax = 0, cmdMax = 0, pixTotal = 0, cmdTotal = 0, framesWithDraw = 0;
	const histoPix = [0, 0, 0, 0, 0, 0];   // <32k, <64k, <128k, <256k, <512k, more

	// ONLY _putpixel. Both used to be wrapped and in 8 bpp mode each pixel was counted
	// TWICE: the only caller of _putpixel8 is _putpixel (vdp1.js, "if(this._fbBpp === 1)").
	// With 16 bpp it did not show —_putpixel8 is never called— and that is why it survived: a game
	// in 8 bpp would have given double the load looking like data.
	const origPut = vdp1._putpixel.bind(vdp1);
	vdp1._putpixel = (cmd, x, y) => { pixFrame++; return origPut(cmd, x, y); };

	// commandsDrawn is reset on every plot(): we read it after each frame.
	for(let f = 0; f < FRAMES; f++)
	{
		pixFrame = 0;
		runFrame();
		cmdFrame = vdp1.commandsDrawn | 0;
		if(pixFrame > 0 || cmdFrame > 0)
		{
			framesWithDraw++;
			pixTotal += pixFrame; cmdTotal += cmdFrame;
			if(pixFrame > pixMax) pixMax = pixFrame;
			if(cmdFrame > cmdMax) cmdMax = cmdFrame;
			const b = pixFrame < 32768 ? 0 : pixFrame < 65536 ? 1 : pixFrame < 131072 ? 2 :
				pixFrame < 262144 ? 3 : pixFrame < 524288 ? 4 : 5;
			histoPix[b]++;
		}
	}

	const avgPix = framesWithDraw ? Math.round(pixTotal / framesWithDraw) : 0;
	const avgCmd = framesWithDraw ? Math.round(cmdTotal / framesWithDraw) : 0;
	console.log("\n=== " + game + " (" + FRAMES + " frames, " + framesWithDraw + " with drawing) ===");
	console.log("   pixels/frame: average " + avgPix.toLocaleString() + "   PEAK " + pixMax.toLocaleString());
	console.log("   commands/frame: average " + avgCmd + "   peak " + cmdMax);
	console.log("   pixels/frame histogram: <32k=" + histoPix[0] + " <64k=" + histoPix[1] +
		" <128k=" + histoPix[2] + " <256k=" + histoPix[3] + " <512k=" + histoPix[4] + " >512k=" + histoPix[5]);
	// The framebuffer is 512x256 = 131072 pixels. Going over that = heavy overdraw.
	console.log("   (framebuffer = 131,072 px; peak/fb = " + (pixMax / 131072).toFixed(1) + "x the framebuffer)");
}
