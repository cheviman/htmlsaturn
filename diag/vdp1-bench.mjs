// RASTERIZATION TEST BENCH: time AND output hash.
//
// To optimize the VDP1 without changing what it draws. It runs the Sonic video -which is the
// expensive case: 94k pixels per frame, 100% textured in mode 5- and reports:
//   - ms per frame of the frames WITH video (the only ones that matter)
//   - a hash of the VDP1 framebuffer at the end
//
// The hash HAS TO STAY IDENTICAL after any optimization. If it changes, the
// optimization changed what is shown and it is useless, however fast it is.
//
// Usage: node diag/vdp1-bench.mjs [game=sonic] [frames=600]
import { readFileSync } from "fs";
import { basename } from "path";
import { createHash } from "crypto";

const GAME  = process.argv[2] || "sonic";
const FRAMES = parseInt(process.argv[3] || "600", 10);

const mod = await import("../headless.mjs?vdp1bench=1");
const { bus, vdp1, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame(GAME));

for(let f = 0; f < 2400; f++)
{
	if(f > 600 && (f % 90) < 5) bus.pad1a = 0xFF & ~0x08; else bus.pad1a = 0xFF;
	runFrame();
}
bus.pad1a = 0xFF;

// Mark the frames with video by the CD's sector delivery.
let sectors = 0;
const origFilter = bus._cdFilterBuffer.bind(bus);
bus._cdFilterBuffer = (fn, b) => { sectors++; return origFilter(fn, b); };

// Accumulated hash of the framebuffer: the last frame is not enough (it could match by
// chance), it is accumulated every 20 frames.
const h = createHash("sha1");
let withVideo = 0, noVideo = 0, msWith = 0, msNo = 0;

for(let f = 0; f < FRAMES; f++)
{
	sectors = 0;
	const t0 = process.hrtime.bigint();
	runFrame();
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	if(sectors > 0) { withVideo++; msWith += ms; } else { noVideo++; msNo += ms; }
	if((f % 20) === 0 && bus.vdp1Fb) h.update(Buffer.from(bus.vdp1Fb.buffer, bus.vdp1Fb.byteOffset, bus.vdp1Fb.byteLength));
}

console.log("frames with video: " + withVideo + "   " + (msWith / Math.max(1, withVideo)).toFixed(3) + " ms/frame");
console.log("frames w/o video:  " + noVideo + "   " + (msNo / Math.max(1, noVideo)).toFixed(3) + " ms/frame");
console.log("total            : " + ((msWith + msNo) / FRAMES).toFixed(3) + " ms/frame");
console.log("framebuffer HASH: " + h.digest("hex"));
