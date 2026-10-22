/**
 *    Name:         audio-throughput.mjs
 *    Description:  How many samples the SCSP generates per emulated frame, at full speed.
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE QUESTION: when a game sounds choppy, is it because the emulator runs slow (and so the
// SCSP generates fewer samples than Web Audio consumes) or because the SCSP does not generate right?
// Headless runs WITHOUT a limiter and WITHOUT back-pressure, that is, at full speed: if the
// throughput is fine here, the problem is pacing in the browser and not the sound engine.
//
// THE NUMBER TO BEAT: Web Audio consumes 44100 samples per second of WALL-CLOCK time, fixed. At
// 59.94 frames per second that is 735.7 samples per emulated frame. A game that generates
// fewer CANNOT sound continuous no matter how fast the machine runs.
//
// MANDATORY CONTROL (repo rule): it is also run with a game where the answer is already
// known. Sega Rally was left sounding right on 27-07-2026, so it has to give ~735.7. If the
// control gives anything else, the probe is wrong and nothing is reported.
//
// Usage: node diag/audio-throughput.mjs [game=daytona] [frames=1800]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "daytona";
const FRAMES = parseInt(process.argv[3] || "1800", 10);
const SKIP = 600;   // boot frames that do not count (booting, loading, initial silence)

const mod = await import("../headless.mjs?caudal=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios({ xmen: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

const left = new Float32Array(4096), right = new Float32Array(4096);
let samples = 0, frames = 0, empty = 0, withAudio = 0, peakRing = 0;
let cddaSeen = 0;

for(let f = 0; f < FRAMES && !cpu.halted; f++)
{
	runFrame();
	const m = bus.scspEngine;
	if(!m) continue;
	// WATCH THE WARMUP: the ring still has to be drained (otherwise it overflows and the boot
	// contaminates the measurement), but WITHOUT counting those samples. The first version added them and
	// the Rally control gave 1072 per frame with the ring peak at 736 — impossible, and that is
	// why the rule says that without a control nothing is reported.
	if(f < SKIP){ drain(m, false); continue; }
	frames++;
	if(m.cddaRemaining > 0) cddaSeen++;
	if(m.count > peakRing) peakRing = m.count;
	// The ring EMPTY at the end of a frame is the direct symptom of the dropout: in the browser
	// that is what the worklet fills with silence.
	if(m.count === 0) empty++;
	const before = samples;
	drain(m, true);
	if(samples > before) withAudio++;
}

function drain(m, count)
{
	while(m.count > 0)
	{
		const n = Math.min(m.count, left.length);
		const read = m.readAudio(left, right, n);
		if(count) samples += read;
	}
}

const perFrame = frames ? samples / frames : 0;
const TARGET = 44100 / 59.94;
console.log("=== audio throughput: " + GAME + " ===");
console.log("  frames measured:      " + frames.toLocaleString("es") + "  (skipped the first " + SKIP + ")");
console.log("  samples generated:    " + samples.toLocaleString("es"));
console.log("  PER FRAME:            " + perFrame.toFixed(1) + "   (target " + TARGET.toFixed(1) + ")");
console.log("  deficit:              " + ((perFrame / TARGET - 1) * 100).toFixed(1) + "%");
console.log("  frames with ring at 0: " + empty.toLocaleString("es") + "  (" + (frames ? (empty * 100 / frames).toFixed(1) : 0) + "%)");
console.log("  frames that generated: " + withAudio.toLocaleString("es") + "  (" + (frames ? (withAudio * 100 / frames).toFixed(1) : 0) + "%)");
console.log("  ring peak:            " + peakRing.toLocaleString("es") + " samples");
console.log("  frames with CDDA:     " + cddaSeen.toLocaleString("es"));
console.log("");
console.log(Math.abs(perFrame / TARGET - 1) < 0.02
	? "  Throughput is FINE at full speed: what sounds choppy is the browser's PACING."
	: "  Throughput does NOT keep up at full speed: the problem is the sound engine, not the pacing.");
