// WHERE DOES A FRAME'S TIME GO? Per-subsystem profile, headless.
//
// Sebas (23-07-2026, translated): "sf alpha runs SLOW with and without the thread". That the
// VDP1 worker does not
// improve it already says its bottleneck is NOT the VDP1 — and the measurement in diag/vdp1-lines.mjs
// confirms it: SFA makes 645,317 calls to the rasterizer in 2400 frames against
// Virtua Cop's 10,540,957, 16 times fewer. What is missing is where it DOES go.
//
// Measures the real cost of each piece by wrapping it: SH-2 (both), 68k, SCSP, CD, VDP1
// (plot) and VDP2 (render). It does not use an external profiler on purpose: the wrappers measure
// exactly the boundaries we care about and the result is comparable across games.
//
// WATCH OUT for the trap: the cost of instrumenting adds to what is measured, so the
// ABSOLUTE numbers are inflated. What counts is the SPLIT (%) and the comparison across games.
//
// Usage: node diag/frame-profile.mjs [frames] [game1,game2,...]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "1200", 10);
const GAMES = (process.argv[3] || "rally,vc,sfa,sonic").split(",");
const BIOS_PER_GAME = { xmen: "jp" };
const now = () => Number(process.hrtime.bigint()) / 1e6;   // ms

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?perf=" + encodeURIComponent(game));
	// CAREFUL: do NOT destructure cpu/cpuSlave. reset() REASSIGNS them when the disc is mounted, and a
	// destructuring freezes the old reference: wrapping that one measures nothing (it gave 0 instr
	// per frame). They are used through mod.cpu / mod.cpuSlave, which is the module's live binding.
	const { bus, vdp1, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;

	try
	{
		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(7) + " -> could not mount: " + e.message); continue; }

	const t = { sh2m: 0, sh2s: 0, m68k: 0, scsp: 0, cd: 0, vdp1: 0, vdp2: 0 };
	const n = { sh2m: 0, sh2s: 0 };

	// Wrap each piece. The SH-2's step() is called ~450k times per frame, so
	// measuring it call by call would distort everything: it is measured per BLOCK, wrapping
	// the method only once and accumulating inside.
	const wrap = (obj, met, key, count) => {
		if(!obj || typeof obj[met] !== "function") return;
		const orig = obj[met].bind(obj);
		obj[met] = (...a) => { const t0 = now(); const r = orig(...a); t[key] += now() - t0; if(count) n[key]++; return r; };
	};

	// The SH-2 hot path: the whole block is measured, not each step.
	wrap(vdp1, "plot", "vdp1");
	wrap(vdp2, "render", "vdp2");
	wrap(bus, "scspTick", "scsp");
	wrap(bus, "cdTick", "cd");
	wrap(bus, "cdPeriodic", "cd");

	// The CPUs: we wrap step() but accumulate with our own counter to know
	// how many instructions were executed (the cost per instruction is what is comparable).
	for(const [c, key] of [[mod.cpu, "sh2m"], [mod.cpuSlave, "sh2s"]])
	{
		if(!c) continue;
		const orig = c.step.bind(c);
		c.step = () => { const t0 = now(); orig(); t[key] += now() - t0; n[key]++; };
	}
	if(bus.m68k) wrap(bus.m68k, "run", "m68k");

	const tTotal0 = now();
	let frames = 0;
	for(; frames < FRAMES && !mod.cpu.halted; frames++) runFrame();
	const tTotal = now() - tTotal0;

	const measured = t.sh2m + t.sh2s + t.m68k + t.scsp + t.cd + t.vdp1 + t.vdp2;
	const pct = (v) => (100 * v / tTotal).toFixed(1).padStart(5) + "%";
	const ms = (v) => (v / frames).toFixed(2).padStart(7) + " ms/f";

	console.log("\n=== " + game + " (" + frames + " frames, " + (tTotal / frames).toFixed(2) + " ms/frame) ===");
	console.log("   SH-2 master " + ms(t.sh2m) + "  " + pct(t.sh2m) + "   " + (n.sh2m / frames / 1000).toFixed(0) + "k instr/frame");
	console.log("   SH-2 slave  " + ms(t.sh2s) + "  " + pct(t.sh2s) + "   " + (n.sh2s / frames / 1000).toFixed(0) + "k instr/frame");
	console.log("   VDP1 plot   " + ms(t.vdp1) + "  " + pct(t.vdp1));
	console.log("   VDP2 render " + ms(t.vdp2) + "  " + pct(t.vdp2));
	console.log("   SCSP        " + ms(t.scsp) + "  " + pct(t.scsp));
	console.log("   68k         " + ms(t.m68k) + "  " + pct(t.m68k));
	console.log("   CD          " + ms(t.cd) + "  " + pct(t.cd));
	console.log("   --- measured" + ms(measured) + "  " + pct(measured) + "   (the rest is runFrame itself + measuring overhead)");
}
