/**
 *    Name:         bands-ceiling.mjs
 *    Description:  real ceiling of splitting vdp2.render across N threads, before writing it
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE QUESTION, BEFORE WRITING THE WORKER SYSTEM: if the render is split into N bands of
// lines, does the sum of the N passes cost the same as ONE whole pass? If so, the ceiling is
// 1/N and it is worth it; if each pass drags a large fixed cost (rereading registers, rebuilding
// the layers, dirtying the cache), the parallelism eats it up and it is not worth it.
//
// It is the project's rule: measure the ceiling BEFORE writing the refactor. It saved an entire
// VDP2 refactor (real ceiling 5%) and justified the SH-2 JIT (ceiling 25-35%).
//
// HOW IT IS MEASURED, and why this way:
//  - In EACH frame both things are done on the SAME state: one whole pass (A) and N
//    band passes (B). Between one and the other, everything that persists across frames is restored
//    (fb, priorities, shadowOk, _alpha and the interlace field), because the interlace
//    weave makes each frame depend on the previous one.
//  - Which one goes first ALTERNATES: if A always went first, B would inherit the hot cache and
//    come out cheaper with no merit of its own.
//  - The MINIMUM of each branch is compared, not the average (this machine's noise is larger than
//    what we are looking for).
//
// CONTROL: the hash of A and that of B must be IDENTICAL. If they differ, the bands do not cover
// the frame and the timing number means nothing — the failure is reported and nothing else.
//
// Usage: node diag/bands-ceiling.mjs [game=daycce] [bands=2] [frames=150] [warmup=900]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "daycce";
const N      = Math.max(2, parseInt(process.argv[3] || "2", 10));
const FRAMES = parseInt(process.argv[4] || "150", 10);
const WARM   = parseInt(process.argv[5] || "900", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };
const now = () => Number(process.hrtime.bigint()) / 1e6;

const mod = await import("../headless.mjs?bandas=" + GAME);
const { vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios(BIOS_PER_GAME[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));
for(let f = 0; f < WARM; f++) runFrame();

// What PERSISTS across frames and has to be restored between the two branches.
const save = () => ({
	fb: vdp2.fb.slice(), pr: vdp2.priorities.slice(),
	so: vdp2.shadowOk ? vdp2.shadowOk.slice() : null,
	al: vdp2._alpha ? vdp2._alpha.slice() : null,
	field: vdp2._field,
});
const restore = (s) => {
	vdp2.fb.set(s.fb); vdp2.priorities.set(s.pr);
	if(s.so) vdp2.shadowOk.set(s.so);
	if(s.al) vdp2._alpha.set(s.al);
	vdp2._field = s.field;
};
const hash = () => {
	let h = 2166136261 >>> 0;
	const fb = vdp2.fb;
	for(let i = 0; i < fb.length; i += 4){
		h ^= ((fb[i] << 16) | (fb[i + 1] << 8) | fb[i + 2]) >>> 0;
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h >>> 0;
};

const whole = [], split = [];
let frames = 0, distinct = 0, px = 0;

for(let f = 0; f < FRAMES && !cpu.halted; f++)
{
	runFrame();
	const cfg = vdp2.configFromRegisters();
	if(!cfg) continue;

	const base = save();
	const aFirst = (f & 1) === 0;   // alternates who runs first (cache)

	let tA = 0, hA = 0, tB = 0, hB = 0;
	for(let wrap = 0; wrap < 2; wrap++)
	{
		const doesA = (wrap === 0) === aFirst;
		restore(base);
		if(doesA){
			vdp2.bandStart = 0; vdp2.bandStep = 1;
			const t = now();
			vdp2.render(cfg);
			tA = now() - t;
			hA = hash();
		}else{
			const fieldBefore = vdp2._field;
			let acc = 0;
			for(let b = 0; b < N; b++){
				// The interlace field alternates ONCE per frame, not once per band:
				// without this, band 1 would rasterize the opposite field from band 0.
				vdp2._field = fieldBefore;
				vdp2.bandStart = b; vdp2.bandStep = N;
				const t = now();
				vdp2.render(cfg);
				acc += now() - t;
			}
			tB = acc;
			hB = hash();
		}
	}
	vdp2.bandStart = 0; vdp2.bandStep = 1;
	restore(base);
	vdp2.render(cfg);   // leave the state as if only the normal render had run

	whole.push(tA); split.push(tB);
	if(hA !== hB) distinct++;
	px = vdp2.width * vdp2.height;
	frames++;
}

if(!frames){ console.log(GAME + ": no frames with an image, the run is useless"); process.exit(1); }

const min = (a) => Math.min(...a);
const A = min(whole), B = min(split);
console.log(GAME + ": " + vdp2.width + "x" + vdp2.height + " (" + px.toLocaleString("es") + " px)   " +
	frames + " frames   " + N + " bandas");
console.log("   CONTROL hash A vs B: " + (distinct ? distinct + " of " + frames + " frames DIFFERENT  <-- the bands do NOT cover the frame, the timing is not valid"
	: "identical in all " + frames + "  ok"));
if(distinct) process.exit(1);
console.log("   whole pass               " + A.toFixed(2).padStart(6) + " ms");
console.log("   " + N + " band passes (sum)        " + B.toFixed(2).padStart(6) + " ms   " +
	"sobrecosto " + ((B / A - 1) * 100).toFixed(1) + "%");
console.log("   -> with " + N + " threads the render would take " + (B / N).toFixed(2) + " ms " +
	"(vs " + A.toFixed(2) + " today)   REAL CEILING " + ((1 - B / N / A) * 100).toFixed(0) + "%");
