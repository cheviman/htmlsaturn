/**
 *    Name:         vdp1-worker.test.mjs
 *    Description:  Validates the VDP1 worker (vdp1-worker.js) with Node's worker_threads.
 *                  Boots the Sega Rally attract mode and gives the worker a SEQUENCE of
 *                  consecutive frames -as the browser does- comparing its display bank against
 *                  that of a fresh reference VDP1 fed with the same sequence. If
 *                  it comes out bit-identical AND WITH CONTENT, rasterizing on a separate thread gives
 *                  exactly the same result.
 *    Version:      0.2.0
 *    Created:      18-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY A SEQUENCE AND NOT A STANDALONE FRAME (27-07-2026).
// Until 0.1.0 this test sent ONE snapshot and compared the display bank. It gave
// "bit-identical" with 0 non-zero pixels, i.e. comparing two EMPTY buffers, and the guard that
// was added to it left it FAILING — correctly, but without saying why.
//
// The cause was not the worker: it was the test. The display bank is ACCUMULATED STATE. The swap
// exchanges CONTENTS, not references (see _swapBanks in vdp1.js), and a fresh VDP1
// starts with _fbDisplay at ZERO (constructor, vdp1.js:60). The snapshot carries
// bus.vdp1Fb -the DRAW bank- but the display bank is not on the bus: it lives inside the
// chip. With a standalone frame, if that frame does not swap, both sides stay at zero and
// "identical" proves nothing.
//
// So we do what the browser does: the worker receives N frames IN ORDER, the framebuffer
// seed goes ONLY in the first one (from then on the banks evolve inside with each frame's
// erase + plot + swap, see the comment on processFrame) and the banks are
// compared at the end. It is also the only thing that exercises the swap's PARITY, which is where
// the SF Alpha's sprite trail lived.
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { bus, vdp1, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "./headless.mjs";
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("rally"));

const FRAMES = 30;   // frames in the sequence; with the Rally's attract mode it is more than enough

// A FRAME WITH REAL CONTENT IS SEARCHED FOR, not assumed.
// Until 27-07-2026 this navigated with START/A/UP "to get to the race" and the snapshot
// came out with an EMPTY framebuffer: the test compared two zeroed buffers and said
// "bit-identical", which is true and proves nothing. Worse, the held input leaves the Rally without
// a VDP2 configuration (configFromRegisters() gives NULL for the next 3600 frames),
// so there was nothing to compose with either.
// Without input the game reaches its attract mode with an image on its own. We advance to the first frame that
// meets BOTH conditions -the VDP2 with a configuration and the VDP1 with pixels- and if it does not
// show up, the test FAILS instead of measuring nothing.
//
// History of two criteria that were not enough, because the test passed them without proving anything:
//  1. Navigating with START/A/UP "to get to the race" left the snapshot EMPTY, and on top of that the
//     held input leaves the Rally without a VDP2 configuration (NULL for 3600 frames).
//  2. Asking for "VDP2 configured + some pixel" stopped at frame 99 —the BIOS logo—,
//     where the 1068 pixels counted were SPRITE ALPHA over a black background: the VDP2
//     rendered 0 pixels with color and the two images compared were empty again.
// From the sweep: the Rally's attract mode gives 71,662 background pixels and 10,219 sprite pixels around
// frame 400. The thresholds are comfortably below that.
let f = 0, ready = false, pxBackground = 0, pxSpr = 0;
for(; f < 2000 && !ready; f++)
{
	runFrame();
	const cfg = vdp2.configFromRegisters();
	if(!cfg) continue;
	vdp2.render(cfg);
	const spr = vdp1.compose(vdp2.priorities, vdp2.fb, vdp2.shadowOk);
	pxBackground = 0; pxSpr = 0;
	for(let i = 0; i < vdp2.fb.length; i += 4)
	{
		if(vdp2.fb[i] || vdp2.fb[i+1] || vdp2.fb[i+2]) pxBackground++;
		if(spr[i+3]) pxSpr++;
	}
	if(pxBackground > 10000 && pxSpr > 1000) ready = true;
}
if(!ready)
{
	console.log("NO frame was found with a VDP2 background WITH COLOR (>10000 px) and sprites");
	console.log("from the VDP1 (>1000 px) in 2000 frames. Without that the test would compare empty");
	console.log("images and say 'bit-identical' without having proven anything.");
	process.exit(1);
}
console.log("chosen frame: " + f + "   VDP2 background " + pxBackground + " px with color, VDP1 sprites " + pxSpr + " px");

// --- THE SEQUENCE, captured RIGHT BEFORE each plot ---
// The three flags are EDGE flags and plot() CONSUMES them, so they have to be read before it
// runs. They are captured by wrapping plot() instead of guessing at what point of the frame
// index.html does it: the wrapper grabs exactly the instant of consumption, which is the one that matters,
// and if a frame plotted twice the sequence would have both entries -which is the truth.
const sequence = [];
const plotOriginal = vdp1.plot.bind(vdp1);
vdp1.plot = function()
{
	if(sequence.length < FRAMES)
		sequence.push({
			vram:     bus.vdp1Vram.slice(),
			vdp2Vram: bus.vdp2Vram.slice(),
			cram:     bus.cram.slice(),
			vdp2Regs: bus.vdp2Regs.slice(),
			vdp1Regs: bus.vdp1Regs.slice(),
			plotRequest:    bus.vdp1PlotRequest,
			eraseManual: bus.vdp1EraseManual,
			changeManual:  bus.vdp1ChangeManual,
			geo: bus.tvGeometry(),
		});
	return plotOriginal();
};
// The banks' seed: the framebuffer state right before the first captured plot.
const seed = bus.vdp1Fb.slice();
for(let k = 0; k < 4000 && sequence.length < FRAMES; k++) runFrame();
vdp1.plot = plotOriginal;
if(sequence.length < FRAMES)
{
	console.log("FAIL: captured only " + sequence.length + " frames out of " + FRAMES + ".");
	process.exit(1);
}
const plots = sequence.filter(s => s.plotRequest).length;
const changes = sequence.filter(s => s.changeManual).length;
console.log("sequence: " + FRAMES + " frames   (" + plots + " with a plot requested, " + changes + " with a bank change)");

// --- REFERENCE: a FRESH VDP1 on the main thread, with the SAME sequence ---
// Fresh vs fresh + same input in the same order = same deterministic result. It starts
// the same as the worker (banks at zero + the same seed) so the comparison is legitimate.
const busRef = {
	vdp1Vram: new Uint8Array(0x80000), vdp1Fb: seed.slice(), cram: new Uint8Array(0x1000),
	vdp2Regs: new Uint8Array(0x200), vdp1Regs: new Uint8Array(0x20), vdp2Vram: new Uint8Array(0x80000),
	vdp1PlotRequest: false, vdp1EraseManual: false, vdp1ChangeManual: false,
	vdp1EndDraw() {},
	_geo: null,
	tvGeometry() { return this._geo; },
};
const vdp1Ref = new globalThis.VDP1(busRef);
for(const s of sequence)
{
	busRef.vdp1Vram.set(s.vram);
	busRef.vdp2Vram.set(s.vdp2Vram);
	busRef.cram.set(s.cram);
	busRef.vdp2Regs.set(s.vdp2Regs);
	busRef.vdp1Regs.set(s.vdp1Regs);
	busRef._geo = s.geo;
	busRef.vdp1PlotRequest    = s.plotRequest;
	busRef.vdp1EraseManual = s.eraseManual;
	busRef.vdp1ChangeManual  = s.changeManual;
	vdp1Ref.plot();
}
const refFb = vdp1Ref._fbDisplay.slice();
let refNoEmpty = 0;
for(let i = 0; i < refFb.length; i++) if(refFb[i]) refNoEmpty++;

// --- workerMode (step 3): the main thread walks the list WITHOUT rasterizing and the state ---
// The contract: with workerMode=true, plot() leaves EDSR/LOPR/COPR/MODR and the Draw End
// EXACTLY the same as normal mode (it is what the CPU observes in console time),
// but does NOT touch a single byte of the framebuffer (the pixels belong to the worker).
{
	const one = sequence[0];
	const buildBus = (counter) => ({
		vdp1Vram: one.vram.slice(), vdp1Fb: seed.slice(), cram: one.cram.slice(),
		vdp2Regs: one.vdp2Regs.slice(), vdp1Regs: one.vdp1Regs.slice(),
		vdp1PlotRequest: one.plotRequest, vdp1EraseManual: one.eraseManual, vdp1ChangeManual: one.changeManual,
		vdp1EndDraw() { counter.n++; },
	});
	const cN = { n: 0 }, cW = { n: 0 };
	const busN = buildBus(cN);
	const vdp1N = new globalThis.VDP1(busN);
	vdp1N.plot();
	const busW = buildBus(cW);
	const vdp1W = new globalThis.VDP1(busW);
	vdp1W.workerMode = true;
	const fbBefore = busW.vdp1Fb.slice();
	vdp1W.plot();

	let regsEqual = true;
	for(const off of [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17])
		if(busN.vdp1Regs[off] !== busW.vdp1Regs[off]) regsEqual = false;
	let fbIntact = true;
	for(let i = 0; i < fbBefore.length; i++)
		if(busW.vdp1Fb[i] !== fbBefore[i]) { fbIntact = false; break; }

	console.log("=== workerMode: bookkeeping on the thread, pixels in the worker ===");
	console.log("  EDSR/LOPR/COPR/MODR identical to normal mode: " + (regsEqual ? "YES" : "NO"));
	console.log("  Draw End fired the same (" + cN.n + " vs " + cW.n + "): " + (cN.n === cW.n ? "YES" : "NO"));
	console.log("  local framebuffer INTACT in worker mode: " + (fbIntact ? "YES" : "NO"));
	if(!regsEqual || cN.n !== cW.n || !fbIntact) process.exitCode = 1;
}

// --- THE WORKER: the same sequence, in order, on its thread ---
const worker = new Worker(new URL("./vdp1-worker.js", import.meta.url));
const t0 = performance.now();
let last = null;
const finished = new Promise((resolve) => {
	worker.on("message", (msg) => {
		if(msg.ready) return;   // startup handshake, not the response to a frame
		// The worker reports its exceptions as {error} instead of dying silently: without this check
		// the test blew up with "Cannot read properties of undefined" and hid the real message.
		if(msg.error){
			console.log("=== THE WORKER FAILED (frame " + msg.id + ") ===");
			console.log("  " + String(msg.error).split("\n").slice(0, 4).join("\n  "));
			process.exitCode = 1; resolve(null); return;
		}
		if(msg.id === FRAMES){ last = msg; resolve(msg); }
	});
	worker.on("error", (e) => { console.log("  ERROR in the worker:", e.message); process.exitCode = 1; resolve(null); });
});
// The framebuffer seed goes ONLY in the first one: from then on the banks evolve
// inside the worker. It is the same contract as the browser (see processFrame in the worker),
// and sending it in all of them would cover up exactly the swap parity bug this comes to cover.
sequence.forEach((s, k) => {
	worker.postMessage({
		id: k + 1,
		vram: s.vram, vdp2Vram: s.vdp2Vram, cram: s.cram,
		vdp2Regs: s.vdp2Regs, vdp1Regs: s.vdp1Regs,
		fb: k === 0 ? seed : null,
		plotRequest: s.plotRequest, eraseManual: s.eraseManual, changeManual: s.changeManual,
		geo: s.geo,
	});
});
await finished;
if(!last){ worker.terminate(); process.exit(process.exitCode || 1); }

const ms = (performance.now() - t0).toFixed(1);
let equal = last.fbDisplay.length === refFb.length, diffs = 0;
if(equal) for(let i = 0; i < refFb.length; i++) if(last.fbDisplay[i] !== refFb[i]) { diffs++; equal = false; }
let noEmpty = 0; for(let i = 0; i < last.fbDisplay.length; i++) if(last.fbDisplay[i]) noEmpty++;

console.log("=== VDP1 worker (rasterized on a separate thread, " + FRAMES + " consecutive frames) ===");
console.log("  the " + FRAMES + " frames in " + ms + " ms (startup + postMessage + plot + return)");
console.log("  the worker says: plot " + last.diag.plot + ", erase " + last.diag.erase +
	", swap " + last.diag.swap + ", " + last.diag.cmds + " commands drawn");
console.log("  display bank: " + noEmpty.toLocaleString("es") + " non-zero bytes (reference: " +
	refNoEmpty.toLocaleString("es") + ")");
console.log("  bit-identical to the reference VDP1: " + (equal ? "YES -> the worker rasterizes EXACTLY the same" : "NO (" + diffs + " different bytes)"));
if(!equal) process.exitCode = 1;
// CONTENT IS REQUIRED, NOT REPORTED. Until 27-07-2026 this 'noEmpty' was computed,
// printed and NOBODY LOOKED AT IT: with both framebuffers at zero, 'equal' gave true and the test
// sang "bit-identical" having compared two EMPTY buffers. It is the same mistake that had already
// been fixed in the frame selection criterion and that was left half done here — comparing
// nothing against nothing always passes.
if(noEmpty === 0){
	console.log("  FAIL: the display bank came back EMPTY, so the comparison above");
	console.log("         proves nothing (two zeroed buffers are 'identical'). With a sequence");
	console.log("         of " + FRAMES + " frames this can no longer be 'the frame was not drawing':");
	console.log("         either the worker did not rasterize, or the sequence carries no plot.");
	process.exitCode = 1;
}

// --- STEP 2: the FULL FRAME composed in the worker ---
// The reference is built in the SAME order as drawTv() on the main thread: VDP2
// render, memcpy of the background, and on top the VDP1 sprites where alpha is not zero, keeping
// the destination's alpha. If it comes out bit-identical, moving the composition to the worker does not change a single
// pixel — which is the only way to accept the change.
console.log("");
console.log("=== step 2: the WHOLE FRAME composed in the worker ===");
if(!last.image){ console.log("  the worker did NOT return a composed image"); process.exitCode = 1; }
else
{
	const vdp2Ref = new globalThis.VDP2(busRef);
	const cfg = vdp2Ref.configFromRegisters();
	vdp2Ref.render(cfg);
	const expected = new Uint8Array(vdp2Ref.fb.length);
	expected.set(vdp2Ref.fb);
	const spr = vdp1Ref.compose(vdp2Ref.priorities, vdp2Ref.fb, vdp2Ref.shadowOk);
	const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
	const ALPHA = LE ? 0xFF000000 : 0x000000FF, RGB = ~ALPHA;
	const d32 = new Uint32Array(expected.buffer, 0, expected.length >> 2);
	const s32 = new Uint32Array(spr.buffer, spr.byteOffset, spr.length >> 2);
	let pxSprite = 0;
	for(let k = 0; k < Math.min(d32.length, s32.length); k++)
	{
		const v = s32[k];
		if(v & ALPHA) { d32[k] = (v & RGB) | (d32[k] & ALPHA); pxSprite++; }
	}

	let imgEqual = last.image.length === expected.length, imgDiffs = 0, withColor = 0;
	if(!imgEqual) console.log("  DIFFERENT SIZE: worker " + last.image.length + " vs reference " + expected.length);
	else for(let i = 0; i < expected.length; i++) if(last.image[i] !== expected[i]) { imgDiffs++; imgEqual = false; }
	for(let i = 0; i < last.image.length; i += 4)
		if(last.image[i] || last.image[i+1] || last.image[i+2]) withColor++;

	console.log("  resolution: " + last.width + "x" + last.height + "   pixels with color: " + withColor +
		"   from sprites: " + pxSprite.toLocaleString("es"));
	console.log("  bit-identical to the frame composed on the main thread: " +
		(imgEqual ? "YES -> moving the composition to the worker does not change a pixel" : "NO (" + imgDiffs + " different bytes)"));
	// NOW IT DOES COVER SPRITE BLENDING OVER THE BACKGROUND, which a standalone frame did not: the
	// sequence leaves the display bank WITH CONTENT, so the compared pixels are not
	// only the VDP2 background. Real sprites are required in the blend, because if
	// pxSprite were 0 this would go back to validating only the VDP2 render.
	if(!imgEqual || withColor === 0) process.exitCode = 1;
	if(pxSprite === 0){
		console.log("  FAIL: the composition did not blend A SINGLE sprite pixel, so this step");
		console.log("         validates the VDP2 render and nothing else.");
		process.exitCode = 1;
	}
}
worker.terminate();
