/**
 *    Name:         bench-audio.mjs
 *    Description:  How much generating audio costs. Measures CPU ms per second of sound, with
 *                  all 32 slots playing, to know whether a change in the SCSP slows things down.
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE QUESTION: the audio engine runs 44,100 times per second for 32 slots. Any
// change in the mixing chain is paid there, so we need to know how much it costs BEFORE
// putting one in. The number to watch is the % of the budget: 1 second of audio has to cost
// quite a bit less than 1 second of CPU, because the SCSP shares the thread with everything else.
//
// THE BENCH IS THE WORST CASE ON PURPOSE: all 32 slots with the envelope open, infinite loop and
// direct output. A real game uses less.
//
// METHOD (repo rule): this machine's noise is larger than what we are looking for, so
// several rounds are run and the MINIMUM is reported, not the average. To compare two versions,
// run this same file with each one and compare the minimums.
//
// Usage: node diag/bench-audio.mjs [seconds=4] [rounds=5] [samplesPerCall=3]
//
// The third argument is for measuring the CEILING of tuning the interleave: today the emulator
// calls advance() with 2-3 samples (one video line); with 1 you would see what it would cost
// to give the 68000 the per-sample resolution the hardware calls for.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { ScspEngine } = require("../scsp.js");

const SECONDS = parseFloat(process.argv[2] || "4");
const ROUNDS   = parseInt(process.argv[3] || "5", 10);
const SAMPLES = Math.round(44100 * SECONDS);
const BLOCK   = parseInt(process.argv[4] || "3", 10);   // grain: 3 = the emulator's today

function buildBank()
{
	const bus = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	// Any waveform in sound RAM: what matters is that it is not silence, because a
	// muted slot skips the mix and the bench would measure too little.
	for(let i = 0; i < 0x40000; i++)
	{
		const v = Math.round(28000 * Math.sin(i * 0.01));
		bus.soundRam[i * 2]     = (v >> 8) & 0xFF;
		bus.soundRam[i * 2 + 1] = v & 0xFF;
	}
	const w = (off, val) => { bus.scspRam[off] = (val >> 8) & 0xFF; bus.scspRam[off + 1] = val & 0xFF; };
	for(let s = 0; s < 32; s++)
	{
		const b = s * 0x20;
		w(b + 0x00, 0x0820);          // KYONB + LPCTL = 1 (normal loop)
		w(b + 0x06, 0xFFFF);          // LEA: long loop
		w(b + 0x08, 0x001F);          // AR at maximum: the envelope opens and stays open
		w(b + 0x10, 0x1000);          // OCT/FNS
		// DISDL at maximum and a different pan per slot, alternating sides and using
		// ODD values: they are the ones that did not exist before (pan went in 6 dB steps) and the ones
		// that take the most work now, so the bench measures the expensive case.
		w(b + 0x16, 0xE000 | (((s & 1) ? 0x10 : 0x00) | (s % 15)) << 8);
	}
	bus.scspRam[0x401] = 0x0F;        // MVOL at maximum
	const m = new ScspEngine(bus);
	// KYONEX GOES LAST, and it is not a detail of the bench: the hardware consumes it on the spot
	// and fires all 32 slots at once. If it is left set in register $00 from
	// the start, the first write that slot 0 decodes triggers it while the other
	// 31 still have KYONB unread -> they start muted, and on top of that the bit is already cleared. The
	// first version of this bench did exactly that and the control catches it: it gave 1 live slot of 32.
	for(let s = 0; s < 32; s++) m.notifyWrite(s * 0x20 + 0x16, 2);
	w(0x00, 0x1820);                  // now for real: KYONEX + KYONB + LPCTL on slot 0
	m.notifyWrite(0x00, 2);
	return m;
}

const left = new Float32Array(8192), right = new Float32Array(8192);
let best = Infinity, alive = 0;

for(let round = 0; round < ROUNDS; round++)
{
	const m = buildBank();
	const t0 = process.hrtime.bigint();
	for(let n = 0; n < SAMPLES; n += BLOCK)
	{
		m.advance(BLOCK);
		while(m.count > 4096) m.readAudio(left, right, 4096);
	}
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	if(ms < best) best = ms;
	// CONTROL: if no slot was left playing, the bench measured silence and the number is not valid.
	alive = m.slots.filter(s => s.ecnt < 0x1FFFFF).length;
}

const perSec = best / SECONDS;
console.log("=== cost of the audio engine (worst case: 32 slots) ===");
console.log("  live slots at the end: " + alive + "/32" + (alive === 0 ? "   <- MUTED BENCH, the number is not valid" : ""));
console.log("  samples per call:      " + BLOCK);
console.log("  rounds:               " + ROUNDS + "  (the MINIMUM is reported)");
console.log("  " + SECONDS + " s of audio:          " + best.toFixed(1) + " ms");
console.log("  per second of audio:   " + perSec.toFixed(2) + " ms   (" + (perSec / 10).toFixed(2) + " % of one second of CPU)");
console.log("  per NTSC frame:        " + (perSec / 59.94).toFixed(3) + " ms   (out of a 16.68 ms budget)");
