// SEGA RALLY'S SOUND EFFECTS IN-GAME (Sebas's report, 26-07-2026, translated:
// "in-game there is no car noise"; the music works).
//
// The previous probes looked at attract mode and the home screen, where the game has NO reason to
// play effects. This one GETS INTO THE GAME with input (Start to navigate, A+up to
// accelerate) and compares three windows:
//
//   1. BOOT      (no input)       <- CONTROL: here Sebas CONFIRMS it can be heard
//   2. MENU      (after the Starts)
//   3. INGAME    (accelerating)   <- where the engine noise is missing
//
// The control is mandatory (see diag/control.mjs): if window 1 gave a peak of 0, the
// probe would be broken and there would be nothing to report. Only if 1 sounds and 3 does not is the finding
// real.
//
// Per window it measures:
//   keyons     = SCSP KYONEX (bit 12 of word 0 of a slot): the driver ORDERS a note
//   slotsOn    = slots with KEY-ON held at the end of the window
//   soundRam   = SH-2 writes to the driver's command ring (0x05A00000+)
//   picoAudio  = maximum amplitude of the PCM coming out of the engine
//
// The combination says where the break is:
//   soundRam=0            -> the game does not request effects (the bug is further up: it does not reach
//                            in-game, or the master does not dispatch)
//   soundRam>0, keyons=0  -> the 68k driver receives and does not play (sequencer)
//   keyons>0, pico=0      -> the SCSP does not synthesize those slots
//
// Usage: node diag/rally-effects.mjs
import { readFileSync } from "fs";
import { basename } from "path";
import { bus, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "../headless.mjs";

applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("rally"));

const START = 0x08, A = 0x04, UP = 0x10;

let keyons = 0, soundRam = 0;
const examples = [];

// KEY-ON MEASURED IN THE CHIP, NOT ON THE BUS. Hooking the writes to the SCSP and looking for KYONEX
// gave 0 in all three windows -including the control one-, which is the sign that the probe
// measures wrong: a key-on the bus sees does not always start a slot (scsp.js _keyOn returns
// immediately if the slot is not in RELEASE), and on top of that the driver can write through a path
// that does not go through that hook. We count the slots that really START PLAYING, which is
// exactly what we need to know.
const engine = bus.scspEngine;
const origKeyOn = engine._keyOn.bind(engine);
engine._keyOn = (s) => {
	const before = s.ecurp;
	const r = origKeyOn(s);
	if(before === PHASE_RELEASE && s.ecurp !== PHASE_RELEASE)
	{
		keyons++;
		const n = engine.slots.indexOf(s);
		if(examples.length < 8 && !examples.includes("slot " + n)) examples.push("slot " + n);
	}
	return r;
};
const PHASE_RELEASE = 3;   // scsp.js: 0 attack, 1 decay, 2 sustain, 3 release (off)
// Driver command ring: the master talks to the 68k by writing Sound RAM.
for(const fn of ["writeByte", "writeWord", "writeLong"])
{
	const orig = bus[fn].bind(bus);
	bus[fn] = (d, v) => {
		const a = d & 0x07FFFFFF;
		if(a >= 0x05A00000 && a < 0x05B00000) soundRam++;
		return orig(d, v);
	};
}

// Slots actually playing: the ones NOT in release.
function slotsPlaying()
{
	if(!engine || !engine.slots) return -1;
	let n = 0;
	for(const s of engine.slots) if(s && s.ecurp !== PHASE_RELEASE) n++;
	return n;
}

// PEAK OF THE WHOLE WINDOW, not of the final instant. Looking at the ring only once when closing
// the window gave 0 in the CONTROL window -where Sebas confirms it can be heard-, that is,
// the probe said "there is no audio" when there was: the ring empties as it is
// consumed and the snapshot fell into a gap. It is sampled on EVERY frame and the maximum is kept.
// Besides the peak, ENERGY (RMS) is accumulated. The peak alone is useless for comparing two
// versions of the routing: with the music playing it is already close to saturating, and adding or
// removing the effects does not move it. The RMS does.
let peak = 0, slotsMax = 0, sum2 = 0, nSamples = 0;
function sample()
{
	const b = engine && engine.bufLeft;
	if(b) for(let i = 0; i < b.length; i += 7)
	{
		const v = b[i], a = Math.abs(v);
		if(a > peak) peak = a;
		sum2 += v * v; nSamples++;
	}
	const s = slotsPlaying();
	if(s > slotsMax) slotsMax = s;
	// Energy per slot, read from the SOUND STACK (SOUS). engine.outputSlot is no good: it is
	// emptied when each sample closes (scsp.js rotates it into the stack and sets it to 0), so
	// between frames it is always zero. The stack keeps the last two generations.
	// It is a sampling of one sample per frame, but over 600 frames that is more than enough
	// to know WHICH slots are working.
	const ps = engine.soundStack;
	if(ps) for(let i = 0; i < 32; i++){ const v = ps[i + 32]; if(v) slotEnergy[i] += Math.abs(v); }
}
const slotEnergy = new Float64Array(32);

let f = 0;
function run(n){ for(let i = 0; i < n; i++, f++){ runFrame(); sample(); } }
function measure(name)
{
	console.log("  " + name.padEnd(22) +
		" keyons " + String(keyons).padStart(6) +
		"   soundRam " + String(soundRam).padStart(7) +
		"   slotsMax " + String(slotsMax).padStart(3) +
		"   picoAudio " + peak.toFixed(4) +
		"   RMS " + (nSamples ? Math.sqrt(sum2 / nSamples) : 0).toFixed(5));
	keyons = 0; soundRam = 0; peak = 0; slotsMax = 0; sum2 = 0; nSamples = 0;
}

console.log("SEGA RALLY — sound effects per stage");
console.log("");

run(900);
measure("1. BOOT (control)");

// Repeated Start to get past attract mode, the home screen and the car/track selection.
for(let k = 0; k < 60; k++)
{
	bus.pad1a = 0xFF & ~START; run(6);
	bus.pad1a = 0xFF;          run(24);
}
measure("2. MENU (Start x60)");

// Accelerate. RBG0 active = the track's rotated plane, meaning the race STARTED:
// without that we are not in-game and any conclusion about effects is invalid.
bus.pad1a = 0xFF & ~(A | UP);
slotEnergy.fill(0);   // measure the energy per slot ONLY during the race
let rbg0 = 0;
for(let i = 0; i < 600; i++, f++){ runFrame(); sample(); if(vdp2._r(0x20) & 0x10) rbg0++; }
bus.pad1a = 0xFF;
measure("3. INGAME (throttle)");

console.log("");
console.log("  did it reach in-game?  RBG0 (rotated track) active in " + rbg0 + " of 600 frames   " +
	(rbg0 > 300 ? "-> YES, it is the race" : "-> NO, careful: window 3 is not in-game"));
console.log("  slots with key-on seen: " + (examples.join(", ") || "none"));

// --- WHERE EACH SLOT THAT IS PLAYING COMES OUT ---
// An SCSP slot has TWO paths to the output:
//   DIRECT    (DISDL/DIPAN -> disll/dislr): goes straight to the mixer.
//   VIA EFFECT (IMXL/ISEL -> the DSP's MIXS, and EFSDL/EFPAN on the way back): goes through the DSP.
// If a slot has its direct output MUTED and only sends to the DSP, it is heard only if
// the DSP returns its result. It is the way "the music works and the effects do not"
// can happen without anything being wrong with the synthesis.
const MUTE_LEVEL = 31;
console.log("");
console.log("  slots playing at the end of in-game (level: 31 = muted, lower = louder):");
console.log("    slot   directL   directR    toDSP(imxl)  fromDSP(efsll)");
let onlyDsp = 0, withDirect = 0;
for(let i = 0; i < engine.slots.length; i++)
{
	const s = engine.slots[i];
	if(!s || s.ecurp === PHASE_RELEASE) continue;
	const directMute = (s.disll >= MUTE_LEVEL && s.dislr >= MUTE_LEVEL);
	const vaDsp   = (s.imxl < MUTE_LEVEL) || (s.efsll < MUTE_LEVEL);
	if(directMute && vaDsp) onlyDsp++; else if(!directMute) withDirect++;
	console.log("    " + String(i).padStart(4) + "   " + String(s.disll).padStart(8) +
		String(s.dislr).padStart(10) + String(s.imxl).padStart(13) + String(s.efsll).padStart(15) +
		(directMute && vaDsp ? "   <<< ONLY through the DSP" : ""));
}
console.log("");
console.log("  with direct output: " + withDirect + "   only through the DSP: " + onlyDsp);
// Does the DSP produce anything? If its output is zero, everything that depends on it is silence.
let efregAlive = 0, efregPeak = 0;
for(let i = 0; i < engine.dspEfreg.length; i++)
{
	const v = Math.abs(engine.dspEfreg[i] | 0);
	if(v) efregAlive++;
	if(v > efregPeak) efregPeak = v;
}
console.log("  DSP output (EFREG): " + efregAlive + "/16 registers with a value, peak " + efregPeak +
	(efregAlive === 0 ? "   <<< THE DSP RETURNS NOTHING" : ""));

// ARE THEY FM MODULATORS? A slot without its own output can legitimately be inaudible: it exists
// only to modulate the phase of another one (MDL/MDXSL/MDYSL, scsp.js:1273). If any of the
// muted ones shows up as a modulation source for another slot, then it must NOT be made to sound
// and the bug is something else. This is the hypothesis to rule out before touching the routing.
const usedAsModulator = new Set();
for(const s of engine.slots)
	if(s && s.mdl){ usedAsModulator.add(s.mdx); usedAsModulator.add(s.mdy); }
const muted = [];
for(let i = 0; i < engine.slots.length; i++)
{
	const s = engine.slots[i];
	if(s && s.ecurp !== PHASE_RELEASE && s.disll >= MUTE_LEVEL && s.dislr >= MUTE_LEVEL && s.imxl >= MUTE_LEVEL)
		muted.push(i);
}
console.log("");
console.log("  slots with NO output (direct muted + not routed to MIXS): [" + muted.join(", ") + "]");
console.log("  slots used as an FM modulator by another:                 [" +
	[...usedAsModulator].join(", ") + "]");
const mutedNoModulators = muted.filter(i => !usedAsModulator.has(i));
console.log("  => without output AND not modulators: [" + mutedNoModulators.join(", ") + "]   " +
	(mutedNoModulators.length
		? "<<< the game started them with key-on so they would play, and they do not play"
		: "(all the muted ones are modulators: it is correct that they do not play)"));

// WHICH SLOT WORKS DURING THE RACE. If a slot produces samples but its routing leaves it
// out, it shows up with high energy and no path: that is the missing effect.
// WHAT PART OF THE AUDIO IS THE EFFECTS AND WHAT PART THE MUSIC? In Sega Rally the music
// is CDDA -it comes from the CD and enters the SCSP through EXTS, another path- and the effects are synthesized
// slots. Sebas hears music and no effects, so they have to be separated: another
// stretch of the race is run with the slots MUTED and the energy is compared. If muting the
// slots barely lowers the RMS, what is heard is CDDA and the effects are not getting through.
bus.pad1a = 0xFF & ~(A | UP);
const saved = engine.slots.map(s => ({ l: s.disll, r: s.dislr }));
for(const s of engine.slots){ s.disll = 31; s.dislr = 31; }
for(let i = 0; i < 200; i++, f++){ runFrame(); sample(); }
const rmsNoSlots = nSamples ? Math.sqrt(sum2 / nSamples) : 0;
peak = 0; sum2 = 0; nSamples = 0; slotsMax = 0;
for(let i = 0; i < engine.slots.length; i++){ engine.slots[i].disll = saved[i].l; engine.slots[i].dislr = saved[i].r; }
for(let i = 0; i < 200; i++, f++){ runFrame(); sample(); }
const rmsWithSlots = nSamples ? Math.sqrt(sum2 / nSamples) : 0;
bus.pad1a = 0xFF;
console.log("");
console.log("  race with the slots MUTED (CDDA/external only): RMS " + rmsNoSlots.toFixed(5));
console.log("  normal race (slots + CDDA):                     RMS " + rmsWithSlots.toFixed(5));
console.log("  => the SCSP slots contribute " +
	(rmsWithSlots > 0 ? ((1 - rmsNoSlots / rmsWithSlots) * 100).toFixed(0) : "?") + "% of the energy   " +
	(rmsNoSlots / (rmsWithSlots || 1) > 0.9
		? "<<< almost all of it is CDDA: the effects are NOT reaching the output"
		: "(the effects DO reach the output in the engine)"));

console.log("");
console.log("  energy produced per slot during the race (the 8 largest):");
const order = [...slotEnergy.keys()].sort((a, b) => slotEnergy[b] - slotEnergy[a]).slice(0, 8);
const total = slotEnergy.reduce((a, b) => a + b, 0) || 1;
for(const i of order)
{
	if(!slotEnergy[i]) continue;
	const s = engine.slots[i];
	const directMute = s.disll >= MUTE_LEVEL && s.dislr >= MUTE_LEVEL;
	const vaMixs  = s.imxl < MUTE_LEVEL;
	console.log("    slot " + String(i).padStart(2) + "   " +
		(slotEnergy[i] * 100 / total).toFixed(1).padStart(5) + "% of the energy   " +
		"direct " + (directMute ? "MUTE" : "yes ") + "   MIXS " + (vaMixs ? "yes" : "no") +
		(directMute && !vaMixs ? "   <<< PRODUCES AND DOES NOT REACH THE OUTPUT" : ""));
}
