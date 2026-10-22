// BENCH FOR OPTIMIZING THE VIDEO: ms per frame + HASH of the output image.
//
// The equivalent of diag/bench-sh2.mjs for the VDP2/VDP1. The rule is the same and it is the
// only thing that makes a render optimization trustworthy: it has to SPEED UP and leave the
// hash IDENTICAL. A different hash means a pixel moved, and then it is not an
// optimization but a change of behavior.
//
// The hash covers the composited RGBA framebuffer (VDP2 + VDP1 sprites on top), which
// is exactly what ends up on the canvas, and ALL the measured frames: if an
// optimization breaks a rare case that shows up in 1 out of 400 frames, the hash gives it away.
//
// Usage: node diag/bench-video.mjs [game=touring] [frames=250] [warmup=900]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "touring";
const FRAMES = parseInt(process.argv[3] || "250", 10);
const WARM   = parseInt(process.argv[4] || "900", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };
const now = () => Number(process.hrtime.bigint()) / 1e6;

const mod = await import("../headless.mjs?bvid=" + GAME);
const { vdp1, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios(BIOS_PER_GAME[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// Warm-up: reach the scene of interest and let the JIT settle.
for(let f = 0; f < WARM; f++) runFrame();

let h = 2166136261 >>> 0;
const mix = (x) => { h ^= (x >>> 0); h = Math.imul(h, 16777619) >>> 0; };

let msVdp2 = 0, msComp = 0, frames = 0, px = 0;
for(let f = 0; f < FRAMES && !cpu.halted; f++)
{
	runFrame();
	const cfg = vdp2.configFromRegisters();
	if(!cfg) continue;

	let t = now();
	vdp2.render(cfg);
	msVdp2 += now() - t;

	t = now();
	const spr = vdp1.compose(vdp2.priorities, vdp2.fb, vdp2.shadowOk);
	msComp += now() - t;

	// Hash of the final image: the VDP2 background with the VDP1 sprites on top, same
	// as drawTv(). 4 bytes at a time (one pixel), without skipping any.
	const fb = vdp2.fb;
	for(let i = 0; i < fb.length; i += 4)
		mix(spr[i + 3] !== 0 ? ((spr[i] << 16) | (spr[i + 1] << 8) | spr[i + 2]) | 0x1000000
		                     : ((fb[i]  << 16) | (fb[i + 1]  << 8) | fb[i + 2]));
	frames++;
	px = vdp2.width * vdp2.height;
}

const tot = (msVdp2 + msComp) / frames;
console.log(GAME + ": " + vdp2.width + "x" + vdp2.height + " (" + px.toLocaleString("es") + " px)   " + frames + " frames");
console.log("   vdp2.render     " + (msVdp2 / frames).toFixed(2).padStart(6) + " ms   " +
	Math.round(msVdp2 * 1e6 / frames / px) + " ns/px");
console.log("   vdp1.compose   " + (msComp / frames).toFixed(2).padStart(6) + " ms   " +
	Math.round(msComp * 1e6 / frames / px) + " ns/px");
console.log("   --- video       " + tot.toFixed(2).padStart(6) + " ms/frame      hash=" + h.toString(16));
