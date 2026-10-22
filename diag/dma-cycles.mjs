// How much DMA costs the SH-2 per frame (after modeling bus stealing, 24-07-2026).
// A frame budget is ~448,000 cycles; if DMA eats a large fraction the
// CPU slows down (correct), but if it ate the WHOLE frame the game would hang. This
// probe measures the cost in cycles of DMA per frame to confirm it is healthy.
// Usage: node diag/dma-cycles.mjs [frames] [game1,...]
import { readFileSync } from "fs";
import { basename } from "path";
const FRAMES = parseInt(process.argv[2] || "2000", 10);
const GAMES = (process.argv[3] || "rally,vc,sfa,sonic,xmen").split(",");
const BIOS = { xmen: "jp" };
const CYCLES_FRAME = 447443;
for(const game of GAMES)
{
	const mod = await import("../headless.mjs?dc=" + encodeURIComponent(game));
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try {
		const b = resolveBios(BIOS[game] || "us");
		applyBios(basename(b), new Uint8Array(readFileSync(b)));
		loadDiscFromCue(resolveGame(game));
	} catch(e){ console.log(game.padEnd(7) + " not mounted: " + e.message); continue; }

	let cycleFrame = 0, total = 0, maxFrame = 0, framesWithDma = 0;
	// ORPHAN PROBE, ADAPTED (27-07-2026): it expected bus._scuDmaCiclos, which does NOT EXIST -the
	// piece was lost in a reset and the document took it as done-, so it blew up
	// with "Cannot read properties of undefined". Now it measures the only thing that can be counted without
	// inventing rates: the BYTES the DMA moves per frame. That is the CEILING of the cost, because
	// the bus cannot move more than one byte per cycle: bytes/frame over 447,443 is the upper
	// bound of the fraction of the frame that DMA could steal from the SH-2.
	const orig = bus._scuDmaCopy.bind(bus);
	bus._scuDmaCopy = (src, incRead, dst, incWrite, cnt) => { cycleFrame += cnt; return orig(src, incRead, dst, incWrite, cnt); };
	for(let f = 0; f < FRAMES; f++)
	{
		cycleFrame = 0;
		runFrame();
		if(cycleFrame > 0){ framesWithDma++; total += cycleFrame; if(cycleFrame > maxFrame) maxFrame = cycleFrame; }
	}
	const avg = framesWithDma ? Math.round(total / framesWithDma) : 0;
	console.log(game.padEnd(7) +
		" DMA bytes/frame: avg=" + avg.toLocaleString().padStart(9) +
		"  PEAK=" + maxFrame.toLocaleString().padStart(9) +
		"  (" + (100 * maxFrame / CYCLES_FRAME).toFixed(1) + "% of the frame at the peak, UPPER BOUND)");
}
console.log("\nHealthy if the peak is a fraction of the frame (~448k). If the peak > 448k, DMA");
console.log("eats entire frames: check it (it could be correct for a massive load, or");
console.log("a miscalculated cost).");
