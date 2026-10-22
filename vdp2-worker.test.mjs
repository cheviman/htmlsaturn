/**
 *    Name:         vdp2-worker.test.mjs
 *    Description:  N threads rasterizing bands must build THE SAME frame as a single one
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE CRITERION IS THE PIXEL, NOT "IT LOOKS SIMILAR". The frame assembled by the N threads is
// compared BYTE BY BYTE against the one vdp2.render() builds on a single thread — framebuffer,
// priorities and shadowOk, which are the three outputs that the VDP1 composition consumes.
//
// AND A FRAME WITH REAL CONTENT IS SOUGHT. The VDP1 worker test already fooled itself
// once by comparing two EMPTY buffers and declaring them "bit-identical": if there are no pixels with
// color, the comparison proves nothing. Here a minimum is required and it FAILS if it does not show up.
import { readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = process.argv[2] || "touring";
const THREADS = parseInt(process.argv[3] || "4", 10);

// Same memory map as index.html: the threads read THE SAME slot as the VDP1 worker.
const OFF_VRAM2 = 0x80000, OFF_CRAM = 0x100000, OFF_R2 = 0x101000;
const SNAP_SIZE = 0x101220, SNAP_SLOTS = 3;
const FB_SIZE = 704 * 448 * 4, PLANE_SIZE = 704 * 448;
const OUT_SIZE = FB_SIZE + PLANE_SIZE * 2, OUT_SLOTS = 2;

const mod = await import("../htmlsaturn/headless.mjs?vdp2wt=" + GAME).catch(() => import("./headless.mjs?vdp2wt=" + GAME));
const { bus, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios("us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// Look for a frame WITH CONTENT: a VDP2 background with real color.
let cfg = null, withColor = 0, frame = -1;
for(let f = 0; f < 2500 && !cpu.halted; f++)
{
	runFrame();
	if(f < 900) continue;
	const c = vdp2.configFromRegisters();
	if(!c) continue;
	vdp2.render(c);
	let n = 0;
	for(let i = 0; i < vdp2.fb.length; i += 4) if(vdp2.fb[i] | vdp2.fb[i + 1] | vdp2.fb[i + 2]) n++;
	if(n > 10000){ cfg = c; withColor = n; frame = f; break; }
}
if(!cfg)
{
	console.log("FAIL: no frame with a colored VDP2 background was found in 2500 frames.");
	console.log("Without content the comparison proves nothing (it is the mistake the VDP1 test already made).");
	process.exit(1);
}
console.log("chosen frame: " + frame + "   " + vdp2.width + "x" + vdp2.height +
	"   colored background " + withColor.toLocaleString("es") + " px");

// --- REFERENCE: a single thread, the usual path ---
// The interlace field is set by hand so that the reference and the threads rasterize THE
// SAME field: render() toggles it on every call.
const fieldRef = 1;
vdp2.fieldForced = fieldRef;
vdp2.bandStart = 0; vdp2.bandStep = 1;
vdp2.render(cfg);
const refFb = vdp2.fb.slice(), refPri = vdp2.priorities.slice();
const refShadow = vdp2.shadowOk ? vdp2.shadowOk.slice() : null;
const WIDTH = vdp2.width, HEIGHT = vdp2.height;

// --- THE N THREADS ---
const sab = new SharedArrayBuffer(SNAP_SIZE * SNAP_SLOTS);
new Uint8Array(sab, OFF_VRAM2, 0x80000).set(bus.vdp2Vram);
new Uint8Array(sab, OFF_CRAM, 0x1000).set(bus.cram);
new Uint8Array(sab, OFF_R2, 0x200).set(bus.vdp2Regs);
const outSab = new SharedArrayBuffer(OUT_SIZE * OUT_SLOTS);

const threads = [];
await Promise.all(Array.from({ length: THREADS }, (_, k) => new Promise((ok, bad) => {
	const w = new Worker(join(HERE, "vdp2-worker.js"));
	w.once("error", bad);
	w.once("message", (m) => { if(m.ready) ok(); else bad(new Error("unexpected reply: " + JSON.stringify(m))); });
	w.postMessage({
		sab, size: SNAP_SIZE, slots: SNAP_SLOTS, offVram2: OFF_VRAM2, offCram: OFF_CRAM, offR2: OFF_R2,
		outSab, outSize: OUT_SIZE, outSlots: OUT_SLOTS, fbSize: FB_SIZE, planeSize: PLANE_SIZE,
		band: k, threads: THREADS,
	});
	threads.push(w);
})));

const errors = [];
await Promise.all(threads.map((w, k) => new Promise((ok) => {
	w.once("message", (m) => { if(m.error) errors.push("band " + k + ": " + m.error); ok(); });
	w.postMessage({ id: 1, slot: 0, output: 0, field: fieldRef, geo: bus.tvGeometry ? bus.tvGeometry() : null });
})));
for(const w of threads) await w.terminate();

if(errors.length){ console.log("FAIL: the threads reported errors:\n  " + errors.join("\n  ")); process.exit(1); }

// --- BYTE-BY-BYTE COMPARISON ---
const outFb  = new Uint8Array(outSab, 0, FB_SIZE);
const outPri = new Uint8Array(outSab, FB_SIZE, PLANE_SIZE);
const outShadow = new Uint8Array(outSab, FB_SIZE + PLANE_SIZE, PLANE_SIZE);

const compare = (name, ref, got, length) => {
	if(!ref) return { name, ok: true, note: "(not applicable)" };
	let diff = 0, first = -1;
	for(let i = 0; i < length; i++) if(ref[i] !== got[i]){ if(first < 0) first = i; diff++; }
	return { name, ok: diff === 0, diff, first };
};
const r = [
	compare("framebuffer", refFb, outFb, WIDTH * HEIGHT * 4),
	compare("priorities", refPri, outPri, WIDTH * HEIGHT),
	compare("shadowOk", refShadow, outShadow, WIDTH * HEIGHT),
];

console.log("=== " + THREADS + " threads rasterizing interleaved bands ===");
let fail = false;
for(const x of r)
{
	if(x.note){ console.log("  " + x.name.padEnd(12) + " " + x.note); continue; }
	console.log("  " + x.name.padEnd(12) + (x.ok ? " IDENTICAL to the single-thread one"
		: " " + x.diff.toLocaleString("es") + " bytes differ (first at " + x.first + ")  <-- FAIL"));
	if(!x.ok) fail = true;
}
console.log(fail ? "\nFAIL: the bands do not rebuild the frame."
	: "\nOK: " + THREADS + " threads build the SAME frame as a single one, byte by byte.");
process.exit(fail ? 1 : 0);
