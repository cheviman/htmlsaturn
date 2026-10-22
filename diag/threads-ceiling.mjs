/**
 *    Name:         threads-ceiling.mjs
 *    Description:  how much the VDP2 render REALLY scales with N real threads
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE QUESTION THIS PROBE ANSWERS, and that diag/bands-ceiling.mjs CANNOT answer:
// bands-ceiling measured the N passes SEQUENTIALLY on a single thread and gave 2.8-4.4% overhead,
// i.e. "it splits almost perfectly". But that is an UPPER BOUND, not a promise: with N real
// threads the N read the SAME VRAM and the SAME CRAM from different cores and compete for
// memory bandwidth. And about the VDP2 we already know that **the time is in the
// VRAM/CRAM reads, not in the logic** (it is the conclusion of the 5% ceiling: stubbing out ALL of the
// pixel lookup saved only 5%). Precisely what does not scale with cores.
//
// So this is the measurement that decides whether splitting into threads is worth it or not.
//
// HOW: the state of a frame is frozen in a SharedArrayBuffer, N threads are spun up, each with its
// own VDP2 reading THAT SAME SAB (no per-thread copies: copying it would hide the
// contention, which is precisely the question), each one rasterizing its band of interleaved lines.
// We measure the WALL CLOCK of the full round —launching the N and waiting for the last one—, which is what
// a frame would really take.
//
// CONTROLS (without them nothing is reported):
//  1. The framebuffer assembled by the N threads has to be IDENTICAL to the 1-thread one. If not,
//     the bands do not cover the frame and the time means nothing.
//  2. An EMPTY round (the N threads without rasterizing) is also measured, to know how much of what is
//     measured is the postMessage round trip and not real work.
//  3. The scene is reported: if the 1-thread render takes less than 3 ms, the scene is cheap and the
//     percentage says nothing useful about the case that hurts.
//
// Usage: node diag/threads-ceiling.mjs [game=touring] [maxThreads=4] [rounds=60] [warmup=900]
import { readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { Worker } from "node:worker_threads";

const GAME  = process.argv[2] || "touring";
const MAXH   = parseInt(process.argv[3] || "4", 10);
const ROUNDS = parseInt(process.argv[4] || "60", 10);
const WARM   = parseInt(process.argv[5] || "900", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };
const now = () => Number(process.hrtime.bigint()) / 1e6;
const HERE = dirname(fileURLToPath(import.meta.url));

const mod = await import("../headless.mjs?thilos=" + GAME);
const { bus, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios(BIOS_PER_GAME[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));
for(let f = 0; f < WARM && !cpu.halted; f++) runFrame();

// The state of the frame, frozen. It is exactly what the snapshot sends to the worker today.
const OFF_CRAM = 0x80000, OFF_REGS = 0x81000, SAB_SIZE = 0x81200;
const sab = new SharedArrayBuffer(SAB_SIZE);
new Uint8Array(sab, 0, 0x80000).set(bus.vdp2Vram);
new Uint8Array(sab, OFF_CRAM, 0x1000).set(bus.cram);
new Uint8Array(sab, OFF_REGS, 0x200).set(bus.vdp2Regs);

const cfg0 = vdp2.configFromRegisters();
if(!cfg0){ console.log(GAME + ": the warmup frame has no image, raise the warmup"); process.exit(1); }
vdp2.render(cfg0);
const WIDTH = vdp2.width, HEIGHT = vdp2.height;
const OUTPUT_SIZE = 704 * 448 * 4;

const hash = (b, length) => {
	let h = 2166136261 >>> 0;
	for(let i = 0; i < length; i += 4){
		h ^= ((b[i] << 16) | (b[i + 1] << 8) | b[i + 2]) >>> 0;
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h >>> 0;
};

// Spins up N threads, runs ROUNDS rounds and returns {ms, hash, empty}.
async function measure(n)
{
	const outputSab = new SharedArrayBuffer(OUTPUT_SIZE);
	const output = new Uint8Array(outputSab);
	const threads = [];
	await Promise.all(Array.from({ length: n }, (_, k) => new Promise((ok, bad) => {
		const w = new Worker(join(HERE, "threads-ceiling-worker.cjs"), {
			workerData: { sab, outputSab, start: k, step: n, OFF_CRAM, OFF_REGS, OUTPUT_SIZE },
		});
		w.once("error", bad);
		w.once("message", () => ok());   // the {ready}
		threads.push(w);
	})));

	// One round = send to the N and wait for the LAST one to answer. It is the wall clock that
	// a frame would really take.
	const round = (empty) => new Promise((ok) => {
		let missing = n;
		const t0 = now();
		for(const w of threads){
			w.once("message", () => { if(--missing === 0) ok(now() - t0); });
			w.postMessage({ empty });
		}
	});

	await round(false); await round(false);          // JIT warmup of the threads
	const times = [];
	for(let r = 0; r < ROUNDS; r++) times.push(await round(false));
	const h = hash(output, WIDTH * HEIGHT * 4);
	// CONTROL: the floor of synchronizing N threads, without rasterizing anything.
	const emptyRuns = [];
	for(let r = 0; r < ROUNDS; r++) emptyRuns.push(await round(true));
	for(const w of threads) w.postMessage({ end: true });
	await Promise.all(threads.map(w => new Promise(ok => w.once("exit", ok))));
	return { ms: Math.min(...times), empty: Math.min(...emptyRuns), hash: h };
}

console.log(GAME + ": " + WIDTH + "x" + HEIGHT + " (" + (WIDTH * HEIGHT).toLocaleString("es") + " px)   " +
	ROUNDS + " rounds, the minimum is taken");

const base = await measure(1);
console.log("   1 thread  " + base.ms.toFixed(2).padStart(6) + " ms   hash=" + base.hash.toString(16) +
	"   (synchronization floor " + base.empty.toFixed(2) + " ms)");
if(base.ms < 3)
	console.log("   CAREFUL: under 3 ms, this scene is CHEAP — the percentage says nothing about the case that hurts");

for(let n = 2; n <= MAXH; n++)
{
	const r = await measure(n);
	const ok = r.hash === base.hash;
	console.log("   " + n + " threads " + r.ms.toFixed(2).padStart(6) + " ms   " +
		"scaling " + (base.ms / r.ms).toFixed(2) + "x of " + n + "x ideal   " +
		"(" + Math.round(base.ms / r.ms / n * 100) + "% efficiency)   " +
		"floor " + r.empty.toFixed(2) + " ms   " +
		(ok ? "hash ok" : "DIFFERENT HASH (" + r.hash.toString(16) + ") <-- the time is NOT valid"));
}
