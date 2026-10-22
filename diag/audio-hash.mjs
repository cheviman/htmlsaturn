// HASH OF THE GENERATED AUDIO. The verification criterion for touching the SCSP.
//
// The hash in diag/bench-sh2.mjs looks at the CPU and the WRAM: a change in the sound engine
// can leave it IDENTICAL and still ruin the audio. This probe pulls the samples out through the
// same path as the browser (engine.readAudio, the SCSP ring) and hashes them.
//
// An SCSP optimization is transparent if it leaves this hash UNCHANGED. If it changes, what
// you hear changed — no matter what the other numbers say.
//
// Usage: node diag/audio-hash.mjs [game=rally] [frames=1200]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "1200", 10);

const mod = await import("../headless.mjs?audiohash=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const bios = resolveBios({ xmen: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// FNV-1a over the raw bits of the float: comparing floats for exact equality is
// precisely what we want (bit for bit), not an approximate comparison.
let h = 2166136261 >>> 0;
const viewF = new Float32Array(1);
const viewI = new Uint32Array(viewF.buffer);
const mix = (x) => { h ^= (x >>> 0); h = Math.imul(h, 16777619) >>> 0; };
const mixFloat = (f) => { viewF[0] = f; mix(viewI[0]); };

const left = new Float32Array(2048), right = new Float32Array(2048);
let samples = 0, peakAbs = 0, noZero = 0;

for(let f = 0; f < FRAMES; f++)
{
	runFrame();
	const m = bus.scspEngine;
	if(!m) continue;
	// Drain the same way pumpAudio() does in the browser: in blocks, everything available.
	while(m.count >= 1024)
	{
		m.readAudio(left, right, 1024);
		for(let i = 0; i < 1024; i++)
		{
			mixFloat(left[i]); mixFloat(right[i]);
			const a = Math.abs(left[i]), b = Math.abs(right[i]);
			if(a > peakAbs) peakAbs = a;
			if(b > peakAbs) peakAbs = b;
			if(left[i] !== 0 || right[i] !== 0) noZero++;
		}
		samples += 1024;
	}
}

console.log(GAME + ": audioHash=" + h.toString(16)
	+ "   samples=" + samples
	+ "   peak=" + peakAbs.toFixed(4)
	+ "   nonZero=" + (samples ? (100 * noZero / samples).toFixed(1) : "0") + "%"
	+ "   (" + FRAMES + " frames)");
// A peak at 0 means absolute silence: the hash would come out the same with the engine off, so
// the comparison would prove nothing. We warn so as not to believe a false OK.
if(peakAbs === 0) console.log("  WARNING: absolute silence — this hash distinguishes nothing, try another game or more frames");
