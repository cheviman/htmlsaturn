/**
 *    Name:         scu-dma-alignment.mjs
 *    Description:  Are the SCU DMAs long-word aligned? If they are not, the hardware accesses
 *                  the edges in BYTES, and we do not.
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// How the SCU DMA works on hardware: it moves long words through the DMA controller's
// buffer, but when the start or end address is not on a long word boundary, the
// edges are read and written in byte units and the transfer still goes through.
// For example, from 1H to 50H: 1H-3H are read as bytes, the middle as
// long words, and the last byte loose again.
//
// bus._scuDmaCopy() assumes alignment: it does readLong/writeLong stepping by 4 from the
// raw address. If a game asks for a misaligned DMA, the emulator reads and writes misaligned
// longs where the hardware would do byte accesses, and the result can differ.
//
// THE QUESTION, before writing anything: does it actually happen? We count how many transfers
// have a source, destination or count not aligned to 4.
//
// Usage: node diag/scu-dma-alignment.mjs [frames=2000] [game1,...]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "2000", 10);
const GAMES = (process.argv[3] || "rally,vc,sfa,sonic,xmen,daytona,touring,vf2").split(",");
const BIOS = { xmen: "jp", xmenvs: "jp", vf2: "jp" };

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?dmaal=" + encodeURIComponent(game));
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try {
		const b = resolveBios(BIOS[game] || "us");
		applyBios(basename(b), new Uint8Array(readFileSync(b)));
		loadDiscFromCue(resolveGame(game));
	} catch(e){ console.log(game.padEnd(8) + " not mounted: " + e.message); continue; }

	let total = 0, srcBad = 0, dstBad = 0, cntBad = 0;
	const orig = bus._scuDmaCopy.bind(bus);
	bus._scuDmaCopy = (src, incRead, dst, incWrite, cnt) => {
		if(cnt > 0)
		{
			total++;
			if(src & 3) srcBad++;
			if(dst & 3) dstBad++;
			if(cnt & 3) cntBad++;
		}
		return orig(src, incRead, dst, incWrite, cnt);
	};

	for(let f = 0; f < FRAMES && !bus.cpuMaster.halted; f++) runFrame();

	const pct = (n) => total ? (n * 100 / total).toFixed(2) + "%" : "-";
	console.log(game.padEnd(8) + " transferencias: " + String(total).padStart(7) +
		"   unaligned source: " + String(srcBad).padStart(6) + " (" + pct(srcBad) + ")" +
		"   dest: " + String(dstBad).padStart(6) + " (" + pct(dstBad) + ")" +
		"   count: " + String(cntBad).padStart(6) + " (" + pct(cntBad) + ")");
}
console.log("\nIf everything is 0, the bytes-at-the-edges case never happens and there is nothing to emulate:");
console.log("it gets documented and that is it. Any nonzero value is a real path that today");
console.log("we resolve with long word accesses where the hardware uses bytes.");
