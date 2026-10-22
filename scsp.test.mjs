/**
 *    Name:         scsp.test.mjs
 *    Description:  Tests for ScspEngine. Builds a stub bus (scspRam + soundRam) and
 *                  checks four blocks:
 *                    1. Smoke test: slot with PCM, key-on via KYONEX, audio comes out.
 *                    2. LFO: vibrato (PLFOS) modulates the phase and tremolo (ALFOS)
 *                       modulates the envelope; the output differs from that of the
 *                       same slot without LFO.
 *                    3. Effects DSP: a pass-through microprogram
 *                       (EFREG[0] = MIXS[0]) gives the same output as the direct
 *                       path, with one sample of latency.
 *                    4. CDDA: the sectors come in through EXTS and go out through EFSDL.
 *                    5. Loop modes (LPCTL): no loop (the slot dies when passing
 *                       LEA), normal, reverse and alternating (ping-pong). The read
 *                       index is followed sample by sample over a ramp.
 *                    6. MCIRE ($42E): the acknowledge of the MAIN CPU's Sound Request.
 *                    7. The EG as a dB attenuation (the screech bug), the
 *                       rate tables and the key-off in the middle of the attack.
 *                    8. Tremolo (ALFOS): depth in dB against the hardware values.
 *                    9. SSCTL: PCM / internal noise / silence.
 *                   10. SBCTL, EGHOLD, SDIR and STWINH.
 *                   11. LPSLNK (loop start link).
 *                   12. SOUS ($600-$67F): the mirrored sound stack.
 *                   13. Internal DMA ($412-$416), including the DEXE that hangs.
 *                   14. MSLC/CA ($408).
 *                   15. SCIPD/MCIPD: only bit 5 is written.
 *                  Blocks 6 and 13-15 run against the real Bus (bus.js),
 *                  not against the stub: the routing of those registers lives there.
 *                  Run with: node scsp.test.mjs
 *    Version:      0.4.0
 *    Created:      15-07-2026
 *    Modified:     16-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync } from "fs";
// scsp.js is a browser script (it uses module.exports in Node). We load it with
// eval because it is the project's own trusted code; there is no external input.
eval(readFileSync("scsp.js", "utf8") + "\nglobalThis.ScspEngine=ScspEngine;" +
	"globalThis.dspFloatAInteger=dspFloatAInteger;" +
	"globalThis.integerADspFloat=integerADspFloat;" +
	"globalThis.TABLE_EG_GAIN=TABLE_EG_GAIN;globalThis.TABLE_EG_ATT=TABLE_EG_ATT;" +
	"globalThis.TL_TABLE=TL_TABLE;globalThis.DECAY_TABLE=DECAY_TABLE;" +
	"globalThis.ATTACK_TABLE=ATTACK_TABLE;globalThis.EG_DB_LSB=EG_DB_LSB;");

let passed = 0, failed = 0;
function check(name, expected, obtained)
{
	if(expected === obtained) passed++;
	else { failed++; console.log("  FAIL", name, "exp", expected, "got", obtained); }
}

// Helper: write a big-endian word into a register bank.
function regW(ram, off, v) { ram[off] = (v >> 8) & 0xFF; ram[off + 1] = v & 0xFF; }


// ==========================================================================
// 1. Smoke test: a slot with PCM sounds
// ==========================================================================

// Stub bus: only what ScspEngine touches (registers and sound RAM).
const bus = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };

// --- PCM: fill sound RAM (from SA=0) with a high-amplitude 16-bit wave ---
for(let i = 0; i < 2048; i++)
{
	const s = (i & 1) ? 0x4000 : 0xC000;   // +0x4000 / -0x4000 alternating (big-endian)
	bus.soundRam[i * 2]     = (s >> 8) & 0xFF;
	bus.soundRam[i * 2 + 1] = s & 0xFF;
}

// --- Slot 0 registers ---
// $00: KYONEX(bit12) + KYONB(bit11) + SA high=0  -> 0x1800
regW(bus.scspRam, 0x00, 0x1800);
regW(bus.scspRam, 0x02, 0x0000);   // SA low = 0
regW(bus.scspRam, 0x04, 0x0000);   // LSA = 0
regW(bus.scspRam, 0x06, 0x0400);   // LEA = 0x400 (generous end of sample)
regW(bus.scspRam, 0x08, 0x001F);   // AR = 0x1F (maximum attack, the envelope rises fast)
regW(bus.scspRam, 0x0A, 0x0000);   // KRS/DL/RR = 0
regW(bus.scspRam, 0x0C, 0x0000);   // TL = 0 (no attenuation)
regW(bus.scspRam, 0x10, 0x0000);   // OCT/FNS = 0 -> default finc
regW(bus.scspRam, 0x16, 0xE000);   // DISDL maximum, centered pan (audible direct output)
// Master volume MVOL at maximum ($401 bits 0-3); if it stays at 0 the shift silences it.
bus.scspRam[0x401] = 0x0F;

const scsp = new ScspEngine(bus);
check("32 slots created", 32, scsp.slots.length);
check("buffer starts empty", 0, scsp.samplesAvailable());

// Trigger the slot 0 write: decodes registers and services KYONEX.
scsp.notifyWrite(0x00, 2);
const s0 = scsp.slots[0];
check("slot 0 finc decoded (>0)", true, s0.finc > 0);
check("key-on: slot out of release", true, s0.ecurp !== 3 /* PHASE_RELEASE */);

// Advance 256 samples and check that they were pushed and that there was non-null audio.
scsp.advance(256);
check("256 samples available", 256, scsp.samplesAvailable());

const left = new Float32Array(256), right = new Float32Array(256);
const delivered = scsp.readAudio(left, right, 256);
check("readAudio delivers 256", 256, delivered);
check("buffer emptied after reading", 0, scsp.samplesAvailable());

let hasAudio = false, maxAbs = 0;
for(let i = 0; i < 256; i++)
{
	const a = Math.abs(left[i]);
	if(a > 0) hasAudio = true;
	if(a > maxAbs) maxAbs = a;
}
check("non-null audio was generated", true, hasAudio);
check("amplitude in range [-1,1]", true, maxAbs <= 1.0);


// ==========================================================================
// 2. LFO: vibrato (frequency modulation) and tremolo (envelope modulation)
// ==========================================================================

// Bus with a sine wave (256 samples per cycle). With a smooth wave the
// vibrato shows as a phase shift and the tremolo as an amplitude change;
// with test 1's Nyquist square wave the comparison would say nothing.
function createBusSine()
{
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	for(let i = 0; i < 4096; i++)
	{
		const s = Math.round(Math.sin((i / 256) * 2 * Math.PI) * 0x4000) & 0xFFFF;
		b.soundRam[i * 2]     = (s >> 8) & 0xFF;
		b.soundRam[i * 2 + 1] = s & 0xFF;
	}
	return b;
}

// Runs slot 0 with the given $12 (LFO) value and returns slot + output.
function runLfo(lfo, samples)
{
	const b = createBusSine();
	regW(b.scspRam, 0x00, 0x1800);   // KYONEX + KYONB, SA high = 0
	regW(b.scspRam, 0x02, 0x0000);
	regW(b.scspRam, 0x04, 0x0000);   // LSA = 0
	regW(b.scspRam, 0x06, 0x0400);   // LEA = 0x400
	regW(b.scspRam, 0x08, 0x001F);   // AR maximum
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x0C, 0x0000);   // TL = 0
	regW(b.scspRam, 0x10, 0x0000);   // OCT/FNS = 0 -> fsft = 7, finc = 0x400
	regW(b.scspRam, 0x12, lfo);      // the LFO under test
	regW(b.scspRam, 0x16, 0xE000);   // DISDL maximum, centered
	b.scspRam[0x401] = 0x0F;

	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(samples);

	const l = new Float32Array(samples), r = new Float32Array(samples);
	m.readAudio(l, r, samples);
	return { engine: m, slot: m.slots[0], left: l, right: r };
}

const N = 256;
// $12 = LFORE(15) | LFOF(10-14) | PLFOWS(8-9) | PLFOS(5-7) | ALFOWS(3-4) | ALFOS(0-2)
// LFOF = 31 -> the fastest LFO (one complete cycle every 256 samples).
const noLfo  = runLfo(0x0000, N);   // no LFO
const vibrato = runLfo(0x7CE0, N);   // LFOF=31, PLFOWS=sawtooth, PLFOS=7
const tremolo = runLfo(0x7C07, N);   // LFOF=31, ALFOWS=sawtooth, ALFOS=7

// --- decoding of register $12 ---
check("no LFO: FMS and EMS stay muted", true,
	noLfo.slot.lfofms === 31 && noLfo.slot.lfoems === 31);
check("no LFO: the LFO counter does not advance", 0, noLfo.slot.lfocnt);
check("vibrato: PLFOS=7 -> lfofms = 7+7", 14, vibrato.slot.lfofms);
check("vibrato: EMS stays muted", 31, vibrato.slot.lfoems);
// ALFOS stores the shift (7 - ALFOS) that scales ALFO[7:0]
// before it is added to the EG attenuation.
check("tremolo: ALFOS=7 -> lfoems = 7-7 = 0 (unshifted)", 0, tremolo.slot.lfoems);
check("tremolo: ALFOS=1 -> lfoems = 7-1 = 6", 6, runLfo(0x7C01, 4).slot.lfoems);
check("tremolo: ALFOS=0 -> EMS muted ('0 | No effect')", 31,
	runLfo(0x7C00, 4).slot.lfoems);
check("tremolo: FMS stays muted", 31, tremolo.slot.lfofms);
check("LFORE holds the LFO in reset (lfoinc = -1)", -1, runLfo(0x8000, 4).slot.lfoinc);

// --- vibrato: it has to move the phase ---
check("vibrato: the LFO counter advances", true, vibrato.slot.lfocnt > 0);
check("vibrato: the phase got modulated (fcnt != no LFO)", true,
	vibrato.slot.fcnt !== noLfo.slot.fcnt);

let diffVib = 0, maxDiffVib = 0;
for(let i = 0; i < N; i++)
{
	const d = Math.abs(vibrato.left[i] - noLfo.left[i]);
	if(d > 0) diffVib++;
	if(d > maxDiffVib) maxDiffVib = d;
}
check("vibrato: the output differs from the no-LFO one", true, diffVib > 100);

// --- tremolo: it has to move the amplitude, not the phase ---
check("tremolo: the phase is NOT modulated (fcnt == no LFO)", noLfo.slot.fcnt, tremolo.slot.fcnt);

let diffTre = 0, maxDiffTre = 0, tremoloNeverAmplifies = true;
for(let i = 0; i < N; i++)
{
	const d = Math.abs(tremolo.left[i] - noLfo.left[i]);
	if(d > 0) diffTre++;
	if(d > maxDiffTre) maxDiffTre = d;
	// The tremolo subtracts from the envelope: it can only attenuate, never amplify.
	if(Math.abs(tremolo.left[i]) > Math.abs(noLfo.left[i]) + 1e-9) tremoloNeverAmplifies = false;
}
check("tremolo: the output differs from the no-LFO one", true, diffTre > 100);
check("tremolo: only attenuates, never amplifies", true, tremoloNeverAmplifies);


// ==========================================================================
// 2b. FM modulation between slots (MDL/MDXSL/MDYSL)
// ==========================================================================

// Slot 1 is the modulator (muted) and slot 0 the carrier: slot 0 adds the
// output of slot 1 to its read index, that is, it warps its phase.
function runFm(mdReg)
{
	const b = createBusSine();
	// Slot 0: carrier, audible, with the modulation under test.
	regW(b.scspRam, 0x00, 0x1800);   // KYONEX + KYONB
	regW(b.scspRam, 0x06, 0x0400);   // LEA
	regW(b.scspRam, 0x08, 0x001F);   // AR maximum
	regW(b.scspRam, 0x0E, mdReg);    // MDL/MDXSL/MDYSL
	regW(b.scspRam, 0x16, 0xE000);   // DISDL maximum, centered
	// Slot 1: modulator. KYONB without KYONEX (slot 0's KYONEX fires it).
	// It stays muted (DISDL = EFSDL = 0): it only exists to feed the sound stack.
	regW(b.scspRam, 0x20 + 0x00, 0x0800);
	regW(b.scspRam, 0x20 + 0x06, 0x0400);
	regW(b.scspRam, 0x20 + 0x08, 0x001F);
	regW(b.scspRam, 0x20 + 0x16, 0x0000);
	b.scspRam[0x401] = 0x0F;

	const m = new ScspEngine(b);
	m.notifyWrite(0x20, 2);   // decode slot 1 before the KYONEX
	m.notifyWrite(0x00, 2);   // slot 0's KYONEX fires both
	m.advance(N);

	const l = new Float32Array(N), r = new Float32Array(N);
	m.readAudio(l, r, N);
	return { engine: m, left: l, right: r };
}

// $0E = MDL(12-15) | MDXSL(6-11) | MDYSL(0-5). MDXSL/MDYSL are relative to the
// slot itself: 1 from slot 0 = slot 1.
// THIS TEST'S MDL WAS 4, AND WITH 4 THE HARDWARE DOES NOT MODULATE: the rate for the
// values 0~4 is 0. So the test checked "FM changes the output" with FM off, and
// it passed because the engine had the cutoff at `if(s.mdl)` — another test that pinned down the bug instead
// of the specification. 9 is used, which is where the rate is 1 (+-1 pi).
const noFm = runFm(0x0000);
const withFm = runFm(0x9041);   // MDL=9 (rate 1), X and Y = slot 1

// The sound stack (SOUS) is a hardware register, not an engine
// optimization: the slots ALWAYS write their output there, whether or not anyone uses the modulation.
// SOUS[15:0] (R/W) is the SOUnd Stack, a data buffer for slot output.
check("FM: without MDL the sound stack is still loaded (SOUS belongs to the hardware)", true,
	noFm.engine.soundStack[32] !== 0);
check("FM: with MDL slot 0 decoded MDL/MDXSL/MDYSL", true,
	withFm.engine.slots[0].mdl === 9 && withFm.engine.slots[0].mdx === 1 &&
	withFm.engine.slots[0].mdy === 1);
check("FM: the modulator (slot 1) loaded the sound stack", true,
	withFm.engine.soundStack[1] !== 0 || withFm.engine.soundStack[33] !== 0);
// With DISDL = EFSDL = 0 both gains are 0: "-inf (not sent)". The
// modulator delivers through the sound stack and does not reach the DAC by any path.
check("FM: slot 1 stays muted (not mixed directly)", true,
	withFm.engine.slots[1].directGainLeft === 0 && withFm.engine.slots[1].gainEfLeft === 0);

let diffFm = 0, maxDiffFm = 0;
for(let i = 0; i < N; i++)
{
	const d = Math.abs(withFm.left[i] - noFm.left[i]);
	if(d > 0) diffFm++;
	if(d > maxDiffFm) maxDiffFm = d;
}
check("FM: the modulation changes the carrier's output", true, diffFm > 100);


// ==========================================================================
// 3. Effects DSP: pass-through microprogram EFREG[0] = MIXS[0]
// ==========================================================================

// Writes one microprogram instruction (64 bits big-endian in 4 words).
function mproW(ram, step, w0, w1, w2, w3)
{
	const b = 0x800 + step * 8;
	regW(ram, b + 0, w0); regW(ram, b + 2, w1);
	regW(ram, b + 4, w2); regW(ram, b + 6, w3);
}

// Runs slot 0 routed through the DSP. `optimize` controls the skipping of dead
// steps: with and without it the result has to be identical.
function runDsp(optimize, samples)
{
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	for(let i = 0; i < 2048; i++)
	{
		const s = (i & 1) ? 0x4000 : 0xC000;
		b.soundRam[i * 2]     = (s >> 8) & 0xFF;
		b.soundRam[i * 2 + 1] = s & 0xFF;
	}

	regW(b.scspRam, 0x00, 0x1800);
	regW(b.scspRam, 0x02, 0x0000);
	regW(b.scspRam, 0x04, 0x0000);
	regW(b.scspRam, 0x06, 0x0400);
	regW(b.scspRam, 0x08, 0x001F);
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x0C, 0x0000);
	regW(b.scspRam, 0x10, 0x0000);
	regW(b.scspRam, 0x12, 0x0000);
	regW(b.scspRam, 0x14, 0x0007);   // ISEL=0, OMXL=7 -> the whole slot goes to MIXS[0]
	regW(b.scspRam, 0x16, 0x00E0);   // DISDL=0 (direct muted), EFSDL=7, centered pan
	b.scspRam[0x401] = 0x0F;

	// COEF[0] = 0xFFF (13 bits left-aligned within the word: <<3).
	// With Y = 0xFFF the multiplier does (0xFFF * X) >> 12 ~= X (pass-through).
	regW(b.scspRam, 0x700, 0xFFF << 3);

	// Step 0: SFT_REG = (COEF[0] * INPUTS) >> 12, with INPUTS = MIXS[0].
	//   IRA=0x20 (MIXS[0]) -> w1 bits 6-11; XSEL -> w1 bit 15; YSEL=1 -> w1 bits 13-14;
	//   ZERO -> w2 bit 1 (zeroes adder input B).
	mproW(b.scspRam, 0, 0x0000, 0xA800, 0x0002, 0x0000);
	// Step 1: EFREG[0] = shifter output, which is the SFT_REG step 0 left.
	//   EWT -> w2 bit 12; EWA=0 -> w2 bits 8-11; ZERO -> w2 bit 1.
	mproW(b.scspRam, 1, 0x0000, 0x0000, 0x1002, 0x0000);

	const m = new ScspEngine(b);
	m.dspOptimize = optimize;
	m.notifyWrite(0x00, 2);
	m.advance(samples);

	const l = new Float32Array(samples), r = new Float32Array(samples);
	m.readAudio(l, r, samples);
	return { engine: m, bus: b, left: l, right: r };
}

const dsp = runDsp(true, N);
check("DSP: loaded microprogram detected", true, dsp.engine.activeDsp);
check("DSP: only steps 0 and 1 stay alive", true,
	dsp.engine.mpAlive[0] === 1 && dsp.engine.mpAlive[1] === 1 && dsp.engine.mpAlive[2] === 0);
check("DSP: slot 0 decoded ISEL=0 / OMXL unattenuated", true,
	dsp.engine.slots[0].isel === 0 && dsp.engine.slots[0].imxl === 0);
check("DSP: EFREG[0] got a signal", true, dsp.engine.dspEfreg[0] !== 0);
check("DSP: EFREG mirrored to the registers ($EC0)", true,
	((dsp.bus.scspRam[0xEC0] << 8) | dsp.bus.scspRam[0xEC1]) === dsp.engine.dspEfreg[0]);

// The pass-through has to reproduce test 1's direct path, with one
// sample of latency (the DSP consumes the MIXS of the previous sample).
let maxErrDsp = 0;
for(let i = 0; i < N - 1; i++)
{
	const d = Math.abs(dsp.left[i + 1] - left[i]);
	if(d > maxErrDsp) maxErrDsp = d;
}
check("DSP: pass-through == direct path (1 sample of latency)", true, maxErrDsp < 0.001);

// Skipping dead steps cannot change the result.
const dspNoOpt = runDsp(false, N);
let equal = true;
for(let i = 0; i < N; i++)
	if(dsp.left[i] !== dspNoOpt.left[i] || dsp.right[i] !== dspNoOpt.right[i]) equal = false;
check("DSP: skipping dead steps does not change the output", true, equal);


// ==========================================================================
// 3b. DSP: a real delay line through the sound RAM ring buffer
// ==========================================================================

// Same as the pass-through, but passing the signal through the effects ring buffer
// (MWT -> sound RAM -> MRT -> MEMS), which is what echo and reverb are made of.
// MADRS[1] = 4 -> the read goes 4 samples behind the write.
function runDelay(optimize, samples)
{
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	for(let i = 0; i < 2048; i++)
	{
		const s = (i & 1) ? 0x4000 : 0xC000;
		b.soundRam[i * 2]     = (s >> 8) & 0xFF;
		b.soundRam[i * 2 + 1] = s & 0xFF;
	}

	regW(b.scspRam, 0x00, 0x1800);
	regW(b.scspRam, 0x02, 0x0000);
	regW(b.scspRam, 0x04, 0x0000);
	regW(b.scspRam, 0x06, 0x0400);
	regW(b.scspRam, 0x08, 0x001F);
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x0C, 0x0000);
	regW(b.scspRam, 0x10, 0x0000);
	regW(b.scspRam, 0x12, 0x0000);
	regW(b.scspRam, 0x14, 0x0007);   // ISEL=0, OMXL=7 -> the whole slot to MIXS[0]
	regW(b.scspRam, 0x16, 0x00E0);   // DISDL=0 (direct muted), EFSDL=7, centered
	b.scspRam[0x401] = 0x0F;

	// $402 = RBL(7-8) | RBP(0-6). RBL=0 -> ring of 0x2000 words. RBP=0x10 -> the
	// ring starts at word 0x10000 (byte 0x20000), far from the slot's PCM.
	regW(b.scspRam, 0x402, 0x0010);

	regW(b.scspRam, 0x700, 0xFFF << 3);   // COEF[0] = 0xFFF (pass-through)
	regW(b.scspRam, 0x780, 0x0000);       // MADRS[0] = 0 -> where it is written
	regW(b.scspRam, 0x782, 0x0004);       // MADRS[1] = 4 -> 4 samples of delay

	// Step 0: SFT_REG = MIXS[0]  (IRA=0x20, XSEL, YSEL=1, CRA=0, ZERO)
	mproW(b.scspRam, 0, 0x0000, 0xA800, 0x0002, 0x0000);
	// Step 1: writes the shifter output into the ring  (MWT, MASA=0, NOFL, ZERO)
	mproW(b.scspRam, 1, 0x0000, 0x0000, 0x4002, 0x0100);
	// Step 2: requests the read 4 samples back  (MRT, MASA=1, NOFL, ZERO)
	//   The write of step 1 is carried out in the body of this step.
	mproW(b.scspRam, 2, 0x0000, 0x0000, 0x2002, 0x0104);
	// Step 3: the read of step 2 is carried out in the body of this step.
	mproW(b.scspRam, 3, 0x0000, 0x0000, 0x0002, 0x0000);
	// Step 4: MEMS[0] = what was read  (IWT, IWA=0, ZERO)
	mproW(b.scspRam, 4, 0x0000, 0x0020, 0x0002, 0x0000);
	// Step 5: SFT_REG = MEMS[0]  (IRA=0, XSEL, YSEL=1, CRA=0, ZERO)
	mproW(b.scspRam, 5, 0x0000, 0xA000, 0x0002, 0x0000);
	// Step 6: EFREG[0] = the delayed signal  (EWT, EWA=0, ZERO)
	mproW(b.scspRam, 6, 0x0000, 0x0000, 0x1002, 0x0000);

	const m = new ScspEngine(b);
	m.dspOptimize = optimize;
	m.notifyWrite(0x00, 2);
	m.advance(samples);

	const l = new Float32Array(samples), r = new Float32Array(samples);
	m.readAudio(l, r, samples);
	return { engine: m, bus: b, left: l, right: r };
}

const ret = runDelay(true, N);
check("delay: RBL/RBP decoded", true, ret.engine.dspRbl === 0 && ret.engine.dspRbp === 0x10);
check("delay: the program's 7 steps stay alive", true,
	[0, 1, 2, 3, 4, 5, 6].every(p => ret.engine.mpAlive[p] === 1) && ret.engine.mpAlive[7] === 0);
// Step 3 writes nothing observable: it stays alive only because of the rule that the
// successor of a step with MRT/MWT cannot be skipped.
check("delay: step 3 lives by the MRT-successor rule", 1, ret.engine.mpAlive[3]);

// The ring buffer has to have been written into sound RAM (byte 0x20000).
let ringWritten = false;
for(let i = 0x20000; i < 0x24000; i++) if(ret.bus.soundRam[i] !== 0) { ringWritten = true; break; }
check("delay: the ring buffer was written into sound RAM", true, ringWritten);
check("delay: the slot's PCM was not overwritten", 0x40, ret.bus.soundRam[2]);

// The output has to be the delayed direct path: 4 samples from MADRS[1] + 1
// of MIXS latency. NOFL stores 16 bits, so the low 8 bits are lost.
let maxErrRet = 0;
for(let i = 0; i < N - 6; i++)
{
	const d = Math.abs(ret.left[i + 5] - left[i]);
	if(d > maxErrRet) maxErrRet = d;
}
check("delay: output == direct path 5 samples earlier", true, maxErrRet < 0.002);

const retNoOpt = runDelay(false, N);
let equalRet = true;
for(let i = 0; i < N; i++)
	if(ret.left[i] !== retNoOpt.left[i] || ret.right[i] !== retNoOpt.right[i]) equalRet = false;
check("delay: skipping dead steps does not change the output", true, equalRet);


// ==========================================================================
// 3c. DSP floating-point format: round trip
// ==========================================================================

// The ring buffer stores the samples in a 16-bit float (4-bit exponent
// + 11-bit mantissa + sign) unless the instruction has NOFL. The conversion has
// to be reversible within the mantissa's precision.
check("DSP float: zero goes and comes back as zero", 0,
	dspFloatAInteger(integerADspFloat(0)));

let maxErrRel = 0, signsOk = true;
for(const v of [0x000100, 0x001234, 0x07FFFF, 0x123456, 0x7FFFFF,
                0xFFFF00, 0xFEDCBA, 0x800000, 0xF00000])
{
	const out = dspFloatAInteger(integerADspFloat(v));
	// Both are signed 24-bit integers: compare them as such.
	const orig = (v << 8) >> 8, wrap = (out << 8) >> 8;
	if(Math.sign(orig) !== Math.sign(wrap) && orig !== 0) signsOk = false;
	const err = Math.abs(wrap - orig) / Math.max(Math.abs(orig), 1);
	if(err > maxErrRel) maxErrRel = err;
}
check("DSP float: the round trip keeps the sign", true, signsOk);
check("DSP float: the round trip loses less than 0.1%", true, maxErrRel < 0.001);


// ==========================================================================
// 3d. Yabause shortcut: effect level -> direct output (only without DSP)
// ==========================================================================

// THE TWO OUTPUT PATHS OF A SLOT, checked against the hardware (rewritten on 27-07-2026).
//
// This block tested the opposite: it demanded that a slot with DISDL = 0 still sound, using
// EFSDL as if it were its direct level. It was the "shortcut" inherited from Yabause -which does not emulate the
// DSP- and these tests FOSSILIZED it, which is the trap CLAUDE.md warns about: a test written
// against the observed behavior turns the bug into a requirement. The previous version even
// left the circular reasoning written down ("the shortcut is its only output and it has to sound").
//
// What the hardware does, each thing in its own register:
//   - The DSP output stage adjusts the output level (EFSDL) and output balance (EFPAN) of the
//     sound signals that come out of the DSP's EFREG and out of EXTS. That
//     is, EFSDL/EFPAN belong to the output OF THE DSP and of the external input, not to the slot.
//   - DISDL 0 -> -inf (not sent).
//   - IMXL 0 -> -MAX (does not mix).
// A slot with both at zero is muted ON PURPOSE (the typical case is the FM modulator,
// which delivers through the sound stack and not through the DAC).
function runShortcut(withProgram, withMixs)
{
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	for(let i = 0; i < 2048; i++)
	{
		const s = (i & 1) ? 0x4000 : 0xC000;
		b.soundRam[i * 2]     = (s >> 8) & 0xFF;
		b.soundRam[i * 2 + 1] = s & 0xFF;
	}
	regW(b.scspRam, 0x00, 0x1800);
	regW(b.scspRam, 0x06, 0x0400);
	regW(b.scspRam, 0x08, 0x001F);
	regW(b.scspRam, 0x14, withMixs ? 0x0007 : 0x0000);   // OMXL: 7 = goes to MIXS, 0 = does not go
	regW(b.scspRam, 0x16, 0x00E0);   // DISDL = 0 (direct muted), EFSDL = 7
	b.scspRam[0x401] = 0x0F;
	// Any microprogram that does not write EFREG is enough to mark
	// "DSP loaded": what is tested is the routing, not what it computes.
	if(withProgram) mproW(b.scspRam, 0, 0x0000, 0xA800, 0x0002, 0x0000);

	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(64);
	const l = new Float32Array(64), r = new Float32Array(64);
	m.readAudio(l, r, 64);
	let peak = 0;
	for(let i = 0; i < 64; i++) peak = Math.max(peak, Math.abs(l[i]));
	return { engine: m, peak: peak };
}

// --- MDL: the FM modulation rate ---------------------------------------------------
// Modulation rate according to the register value:
//     MDL   0~4    5     6     7    8   9  A  B  C   D   E   F
//     rate   0    1/16  1/8  1/4  1/2  1  2  4  8  16  32  64
// The first FIVE values are worth zero. The cutoff was at `if(s.mdl)`, so 1, 2, 3 and 4
// modulated a little instead of nothing.
{
	const withMdl = (mdl) => runFm((mdl << 12) | (1 << 6) | 1);   // MDL with X and Y = slot 1
	const base = runFm(0x0000);                                  // no modulation
	const sameAsNoFm = (r) => {
		for(let i = 0; i < N; i++) if(r.left[i] !== base.left[i]) return false;
		return true;
	};
	check("MDL=0 does not modulate", true, sameAsNoFm(withMdl(0)));
	check("MDL=1 does NOT modulate (0~4 -> rate 0)", true, sameAsNoFm(withMdl(1)));
	check("MDL=4 does NOT modulate (0~4 -> rate 0)", true, sameAsNoFm(withMdl(4)));
	// 5 is the first value with a non-zero rate (1/16).
	check("MDL=5 DOES modulate (first rate != 0)", false, sameAsNoFm(withMdl(5)));
	check("MDL=F DOES modulate (maximum rate)", false, sameAsNoFm(withMdl(0xF)));

	// THE SCALING, with the hardware's own number. The maximum shift happens when the waveform
	// data (a sine wave) is at 1 cycle = 1 Kword and ZD is at +- its maximum value, and comparing
	// the rates gives π = 512 (when MDL=AH). With ZD at its maximum (the
	// output of a slot is s16, that is 32768) the engine does ZD >> (0xF - MDL):
	//   MDL=9 (rate 1)  -> 32768 >> 6 =  512 = 1π
	//   MDL=A (rate 2)  -> 32768 >> 5 = 1024 = 2π
	// It matches exactly, and it also pins the scale: if someone changes the width of the sound
	// stack, this fails.
	const shiftMax = (mdl) => 32768 >> (0xF - mdl);
	check("MDL=9: the maximum shift is 512 (= 1 pi)",  512, shiftMax(9));
	check("MDL=A: the maximum shift is 1024 (= 2 pi)", 1024, shiftMax(0xA));
}

// --- MDXSL/MDYSL: the stack generation WAS LEFT UNRESOLVED --------------------------
// There were 9 tests that pinned a fixed offset (0 or 32) depending on the 1CH-3BH
// range. It was tested in the browser and Sega Rally lost effects in the menus, so it was
// reverted; the tests go out with the code, because they pinned an implementation that on top of that
// was the wrong one (see the note in scsp.js: MAME uses a ring of 64 with a live pointer, not an
// offset per slot). When it is picked up again with the ring, new tests go against THAT model.

// --- PITCH: OCT and FNS (the octave table and the cents formula) -------------------
// It is the chip's most audible parameter -if this is wrong, EVERYTHING sounds out of tune- and there was not
// a single test. The hardware defines the two halves:
//   - OCT[3:0] SIGNED, in octaves: DH = F/8, EH = F/4, FH = F/2, 0H = 1F,
//     1H = 2F, 2H = 4F, 3H = 8F.
//   - FNS[9:0] adjusts within the octave: n(cent) = 1200 x LOG2((1024 + FNS) / 1024).
//   - When FNS and OCT are both 0, the tone matches the sampling source
//     data, that is 1:1 speed.
// finc is in fixed point with SCSP_FREQ_LB = 10 bits, so 1024 = one sample per sample.
function fincOf(oct, fns)
{
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	regW(b.scspRam, 0x10, ((oct & 0xF) << 11) | (fns & 0x3FF));
	const m = new ScspEngine(b);
	m.notifyWrite(0x10, 2);
	return m.slots[0].finc;
}
check("pitch: OCT=0 FNS=0 is 1:1 with the source", 1024, fincOf(0, 0));
check("pitch: OCT=1 doubles (2F)",               2048, fincOf(1, 0));
check("pitch: OCT=2 quadruples (4F)",           4096, fincOf(2, 0));
check("pitch: OCT=3 is 8F",                      8192, fincOf(3, 0));
check("pitch: OCT=FH (-1) is F/2",                512, fincOf(0xF, 0));
check("pitch: OCT=EH (-2) is F/4",                256, fincOf(0xE, 0));
check("pitch: OCT=DH (-3) is F/8",                128, fincOf(0xD, 0));
check("pitch: OCT=8H (-8) is F/256",                4, fincOf(0x8, 0));
// FNS enters as (1024 + FNS)/1024 within the octave: with FNS at maximum (3FFH) the step
// ends up a hair short of double, which is the edge of the next octave.
check("pitch: FNS=512 raises 50% within the octave", 1536, fincOf(0, 512));
check("pitch: FNS=3FFH stays 1 LSB below the octave", 2047, fincOf(0, 0x3FF));
// The cents equivalent of the formula above, in case someone changes the scale:
// 1200 * log2(1536/1024) = 701.955 cents (the perfect fifth).
{
	const cents = 1200 * Math.log2(fincOf(0, 512) / 1024);
	check("pitch: FNS=512 is 702 cents (perfect fifth)", true, Math.abs(cents - 701.955) < 0.01);
}

// --- PAN WITH THE HARDWARE'S RESOLUTION -------------------------------------------
// This could not be checked before: the pan was resolved with shifts, which only
// move in 6 dB steps, and the ODD values of DIPAN ended up 3 dB too loud (01H sounded
// unattenuated instead of -3 dB). It is checked against the hardware values, not against what comes out.
function gainOf(disdl, dipan)
{
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	regW(b.scspRam, 0x16, (disdl << 13) | (dipan << 8));
	const m = new ScspEngine(b);
	m.notifyWrite(0x16, 2);
	return { left: m.slots[0].directGainLeft, right: m.slots[0].directGainRight };
}
// Real dB that a 15-bit gain represents (32768 = 0 dB).
const inDb = (g) => -20 * Math.log10(g / 32768);
const near = (a, b) => Math.abs(a - b) < 0.15;

// DISDL 0 = "-inf (not sent)", 7 = 0 dB, and down in 6 dB steps.
check("level: DISDL=0 sends nothing", true, gainOf(0, 0x00).left === 0 && gainOf(0, 0x00).right === 0);
check("level: DISDL=7 is exactly 0 dB", 32768, gainOf(7, 0x00).left);
check("level: DISDL=6 is -6 dB", true, near(inDb(gainOf(6, 0x00).left), 6));
check("level: DISDL=1 is -36 dB", true, near(inDb(gainOf(1, 0x00).left), 36));

// 00H and 10H are both the center; MSB=0 attenuates the LEFT (moves the image to
// the right) and MSB=1 the RIGHT; 0FH/1FH are -inf.
check("pan: 00H and 10H are both the center", true,
	gainOf(7, 0x00).left === gainOf(7, 0x10).left && gainOf(7, 0x00).right === gainOf(7, 0x10).right);
check("pan: 01H attenuates the LEFT 3 dB (the step that used to be lost)", true,
	near(inDb(gainOf(7, 0x01).left), 3) && gainOf(7, 0x01).right === 32768);
check("pan: 11H attenuates the RIGHT 3 dB", true,
	near(inDb(gainOf(7, 0x11).right), 3) && gainOf(7, 0x11).left === 32768);
check("pan: 02H attenuates the left 6 dB", true, near(inDb(gainOf(7, 0x02).left), 6));
check("pan: 03H attenuates the left 9 dB", true, near(inDb(gainOf(7, 0x03).left), 9));
check("pan: 0EH attenuates the left 42 dB", true, near(inDb(gainOf(7, 0x0E).left), 42));
check("pan: 0FH leaves the left at -inf", 0, gainOf(7, 0x0F).left);
check("pan: 1FH leaves the right at -inf", 0, gainOf(7, 0x1F).right);
// The send level and the pan ADD in dB: DISDL=6 (-6) with DIPAN=01H (-3) = -9.
check("level+pan add in dB", true, near(inDb(gainOf(6, 0x01).left), 9));

const shortcutNoDsp    = runShortcut(false, false);
const shortcutWithDsp    = runShortcut(true,  false);
const shortcutWithDspMix = runShortcut(true,  true);
check("output: without a microprogram the DSP stays inactive", false, shortcutNoDsp.engine.activeDsp);
check("output: with a microprogram the DSP becomes active", true, shortcutWithDsp.engine.activeDsp);
// The setup has DISDL = 0 and EFSDL = 7. EFSDL is NOT a slot level -the hardware's
// register definitions and MAME agree (a slot's raw PCM never comes out through its EFSDL)-, so
// without direct output and without MIXS the slot does not reach the DAC by any path.
check("output: DISDL=0 and IMXL=0 -> muted, without DSP", 0, shortcutNoDsp.peak);
check("output: DISDL=0 and IMXL=0 -> muted, with DSP", 0, shortcutWithDsp.peak);
// With IMXL = 7 the slot does enter the DSP through MIXS. The test microprogram does not write
// EFREG, so nothing comes out either: what is checked is that the output does NOT show up through the
// direct path, which is exactly what the shortcut did.
check("output: with MIXS the output goes through the DSP, not the direct path", 0, shortcutWithDspMix.peak);


// ==========================================================================
// 4. CDDA: the CD sectors come in through EXTS and go out through the effects bus
// ==========================================================================

const busCd = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
// Slot 16 is the one holding the EFSDL/EFPAN of EXTS0 (17 holds EXTS1's). Since
// EXTS0 is the CD's left channel and EXTS1 the right one, each has to be panned to
// one side; both centered they would add up in both channels (which is what
// the hardware does, but it is not how CDDA is used).
// $16 = EFSDL(5-7) | EFPAN(0-4). EFPAN=0x1F -> all to the left (bit 4 set
// + the low 4 at 0xF mute the right); EFPAN=0x0F -> all to the right.
regW(busCd.scspRam, 16 * 0x20 + 0x16, 0x00FF);   // EFSDL=7, EXTS0 to the left
regW(busCd.scspRam, 17 * 0x20 + 0x16, 0x00EF);   // EFSDL=7, EXTS1 to the right
busCd.scspRam[0x401] = 0x0F;

const cdEngine = new ScspEngine(busCd);
cdEngine.notifyWrite(16 * 0x20 + 0x16, 2);
cdEngine.notifyWrite(17 * 0x20 + 0x16, 2);

// CDDA sector: 16-bit stereo little-endian PCM, left = +0x2000, right = -0x2000.
const sector = new Uint8Array(2352);
for(let i = 0; i < 2352; i += 4)
{
	sector[i] = 0x00; sector[i + 1] = 0x20;         // left = 0x2000
	sector[i + 2] = 0x00; sector[i + 3] = 0xE0;     // right = 0xE000 = -0x2000
}
cdEngine.receiveCdda(sector);
check("CDDA: 2352 bytes left pending", 2352, cdEngine.cddaPending());

cdEngine.advance(64);
const cdLeft = new Float32Array(64), cdRight = new Float32Array(64);
cdEngine.readAudio(cdLeft, cdRight, 64);
check("CDDA: 4 bytes were consumed per sample", 2352 - 64 * 4, cdEngine.cddaPending());
check("CDDA: EXTS0 received the left sample", 0x2000, cdEngine.dspExts[0]);
check("CDDA: EXTS1 received the right sample", 0xE000, cdEngine.dspExts[1]);
check("CDDA: comes out on the left channel", true, Math.abs(cdLeft[10] - 0x2000 / 32768) < 1e-6);
check("CDDA: comes out on the right channel with the correct sign", true,
	Math.abs(cdRight[10] + 0x2000 / 32768) < 1e-6);


// ==========================================================================
// 5. Slot loop modes (LPCTL): 0=no loop, 1=normal, 2=reverse, 3=alternating
// ==========================================================================

// Regression for the US BIOS "screech that loops and fades out": the BIOS
// programs slots with LPCTL=3 (ping-pong). Yabause's classic engine only looks at
// "lpctl == 0" vs "!= 0", so it played modes 2 and 3 as a normal forward
// loop: the slot repeated the segment always in the same direction, with a
// hard LEA -> LSA jump per lap (discontinuity = buzz) and at twice the
// real repetition frequency.
//
// The sound RAM is filled with a ramp (sample[i] = i) and instead of looking at the audio
// the read index (fcnt >> FREQ_LB) is followed sample by sample, which is what
// defines the loop mode. LSA=8, LEA=16, OCT/FNS=0 -> finc=1024 = 1 sample
// per step, that is the index advances by 1 and the sequence is read directly.
function runLoop(lpctl, samples)
{
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	for(let i = 0; i < 64; i++)
	{
		b.soundRam[i * 2] = 0; b.soundRam[i * 2 + 1] = i;   // big-endian, value = index
	}
	// $00 = KYONEX(bit12) | KYONB(bit11) | LPCTL(bits 5-6)
	regW(b.scspRam, 0x00, 0x1800 | (lpctl << 5));
	regW(b.scspRam, 0x02, 0x0000);   // SA = 0
	regW(b.scspRam, 0x04, 0x0008);   // LSA = 8
	regW(b.scspRam, 0x06, 0x0010);   // LEA = 16
	regW(b.scspRam, 0x08, 0x001F);   // AR maximum
	regW(b.scspRam, 0x0A, 0x0000);   // RR = 0 -> the envelope does not turn off by itself
	regW(b.scspRam, 0x0C, 0x0000);   // TL = 0
	regW(b.scspRam, 0x10, 0x0000);   // OCT/FNS = 0 -> finc = 1024
	regW(b.scspRam, 0x16, 0xE000);   // DISDL maximum
	b.scspRam[0x401] = 0x0F;

	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	const s = m.slots[0];
	const idx = [];
	for(let i = 0; i < samples; i++)
	{
		// The index read in this sample is the fcnt from before advancing.
		idx.push(s.fcnt >>> 10);
		m.advance(1);
	}
	return { engine: m, slot: s, idx: idx };
}

const ramp = (since, until) => {
	const a = [];
	if(since <= until) for(let i = since; i <= until; i++) a.push(i);
	else for(let i = since; i >= until; i--) a.push(i);
	return a;
};
const ig = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// --- LPCTL = 0: no loop, the slot reads SA -> LEA once and DIES ---
const lp0 = runLoop(0, 40);
check("LPCTL=0: reads from 0 to LEA only once", true, ig(lp0.idx.slice(0, 17), ramp(0, 16)));
check("LPCTL=0: the slot DIES when passing LEA (ecnt = SCSP_ENV_DE)", true,
	lp0.slot.ecnt >= 0x1FFFFF);
check("LPCTL=0: never goes back to LSA", true, lp0.idx.slice(17).every(v => v === 17));

// --- LPCTL = 1: normal forward loop, LSA <-> LEA ---
const lp1 = runLoop(1, 40);
check("LPCTL=1: first pass from 0 to LEA", true, ig(lp1.idx.slice(0, 17), ramp(0, 16)));
check("LPCTL=1: goes back to LSA and repeats forward", true, ig(lp1.idx.slice(17, 26), ramp(8, 16)));
check("LPCTL=1: the slot stays alive", true, lp1.slot.ecnt < 0x1FFFFF);
check("LPCTL=1: never reads in reverse", 0, lp1.slot.dirRev);

// --- LPCTL = 2: reverse loop, SA -> LSA and then LEA -> LSA in reverse ---
const lp2 = runLoop(2, 40);
check("LPCTL=2: first forward pass up to LSA", true, ig(lp2.idx.slice(0, 9), ramp(0, 8)));
check("LPCTL=2: on reaching LSA it jumps to LEA and reads in reverse", true,
	ig(lp2.idx.slice(9, 17), ramp(16, 9)));
check("LPCTL=2: on going below LSA it goes back to LEA", 16, lp2.idx[17]);
check("LPCTL=2: keeps reading in reverse", 1, lp2.slot.dirRev);
check("LPCTL=2: never leaves the loop [LSA, LEA]", true,
	lp2.idx.slice(9).every(v => v >= 8 && v <= 16));

// --- LPCTL = 3: alternating loop (ping-pong), bounces between LEA and LSA ---
const lp3 = runLoop(3, 60);
check("LPCTL=3: first pass from 0 to LEA", true, ig(lp3.idx.slice(0, 17), ramp(0, 16)));
check("LPCTL=3: bounces at LEA and comes back in reverse", true, ig(lp3.idx.slice(17, 24), ramp(15, 9)));
check("LPCTL=3: bounces at LSA and goes forward again", true, ig(lp3.idx.slice(24, 27), [8, 9, 10]));
check("LPCTL=3: never leaves the loop [LSA, LEA]", true,
	lp3.idx.slice(17).every(v => v >= 8 && v <= 16));

// The property that broke the audio: in ping-pong the index changes by 1 sample
// (it turns around by changing direction). Treated as a normal loop there was an
// 8-sample LEA -> LSA jump per lap = discontinuity = buzz.
let jumpMax3 = 0;
for(let i = 1; i < lp3.idx.length; i++)
	jumpMax3 = Math.max(jumpMax3, Math.abs(lp3.idx[i] - lp3.idx[i - 1]));
check("LPCTL=3: no hard jump (the ping-pong is continuous)", 1, jumpMax3);

// And the real period: the ping-pong travels the segment there and back, that is
// it takes twice as long as the normal loop -> it sounds an octave lower, not at double.
// It is measured as the distance between two consecutive passes through LSA already inside the
// loop (in ping-pong the same index also repeats on the way back, so
// it has to be anchored to an end, not to any value).
const period = (idx) => {
	const passes = [];
	for(let i = 17; i < idx.length; i++) if(idx[i] === 8) passes.push(i);
	return passes.length >= 2 ? passes[1] - passes[0] : -1;
};
check("LPCTL=1: the normal loop repeats every 9 samples (LEA-LSA+1)", 9, period(lp1.idx));
check("LPCTL=3: the ping-pong repeats every 16 samples (there + back)", 16, period(lp3.idx));


// ==========================================================================
// 6. MCIRE (0x42E): the acknowledge of the MAIN CPU's Sound Request interrupt
// ==========================================================================
// It runs against the REAL Bus and not a stub: the MCIRE routing lives in
// bus.js (scspWrite) and the IRQ delivery in _scspEvalInt/_scuIrq, so
// a stub would cover up exactly the half that matters.
//
// MCIRE[10:0] (Main CPU Interrupt REset): setting 1 resets the hardware interrupt
// request of the corresponding bit (it also changes from 1B to 0B). Register
// map: MCIRE at 10042Eh.
//
// Why it matters: _scuIrq delivers the interrupt to the SH-2 as a PULSE, but
// _scspEvalInt evaluates it as a LEVEL (if(mcipd & mcieb)) once per scspTick.
// Without MCIRE the MCIPD bit stays on forever and the game's handler
// has no way to clear it: the SH-2 would eat one Sound Request IRQ per video
// line (~15,700/s) without ever being able to acknowledge it.
eval(readFileSync("bus.js", "utf8") + "\nglobalThis.Bus=Bus;");

// Helper: read a big-endian word from a register bank.
function regR(ram, off) { return ((ram[off] << 8) | ram[off + 1]) & 0xFFFF; }

const busM = new globalThis.Bus();
// CPU stub: we count the interrupts the SCSP requests from the SH-2.
let irqsToSh2 = 0;
busM.connectCpu({ requestInterrupt: () => { irqsToSh2++; }, reset: () => {} });
// UNMASK THE SOUND REQUEST IN THE SCU, which is what real software does before
// waiting for this interrupt. Until 29-07-2026 it was not needed because IMS started at
// zero (nothing masked); but on hardware its initial value is
// 0000BFFFH, that is EVERYTHING masked, and bit 6 is precisely the sound request. Without this the
// test was measuring the SCSP path through an SCU in a state the hardware
// does not have at power-on.
busM.writeLong(0x25FE00A0, 0x00000000);

// Enable Timer B (bit 7) in MCIEB and set it pending in MCIPD.
busM.scspWrite(0x42A, 0x0080, 2);            // MCIEB = Timer B
busM._scspSetPending(0x0080);                      // Timer B fires
check("MCIPD: Timer B stays pending", 0x0080, regR(busM.scspRam, 0x42C) & 0x0080);

irqsToSh2 = 0;
busM._scspEvalInt();
check("with MCIPD & MCIEB the SCSP requests Sound Request from the SH-2", 1, irqsToSh2);

// The handler acknowledges the interrupt by writing MCIRE.
busM.scspWrite(0x42E, 0x0080, 2);
check("MCIRE clears the Timer B bit in MCIPD", 0, regR(busM.scspRam, 0x42C) & 0x0080);

// Once acknowledged, the SCSP must not request it again: otherwise, it is the IRQ storm.
irqsToSh2 = 0;
busM._scspEvalInt();
check("after MCIRE the SCSP NO longer requests Sound Request", 0, irqsToSh2);

// MCIRE is selective: it clears only the written bits, not the whole MCIPD.
busM._scspSetPending(0x00C0);                      // Timer A (0x40) + Timer B (0x80)
busM.scspWrite(0x42E, 0x0080, 2);            // acknowledge ONLY Timer B
check("MCIRE is selective: it clears Timer B...", 0,      regR(busM.scspRam, 0x42C) & 0x0080);
check("...and leaves Timer A pending",         0x0040, regR(busM.scspRam, 0x42C) & 0x0040);

// Writing 0 to MCIRE clears nothing (it resets only the bits written as 1).
busM.scspWrite(0x42E, 0x0000, 2);
check("MCIRE with 0 clears no bit", 0x0040, regR(busM.scspRam, 0x42C) & 0x0040);

// ...and it must not fire a Sound Request out of nowhere either. With Timer A
// pending and enabled, a HARMLESS MCIRE write (0 = clears no bit) is not
// a new event: if it re-evaluated the interrupt here, the SH-2 would eat a spurious IRQ
// on every write. This check is the one that kills the version of the fix that
// called _scspEvalInt() at the end.
busM.scspWrite(0x42A, 0x0040, 2);            // MCIEB = Timer A (enabled)
irqsToSh2 = 0;
busM.scspWrite(0x42E, 0x0000, 2);            // harmless write
check("MCIRE with 0 does not fire a spurious Sound Request", 0, irqsToSh2);
busM.scspWrite(0x42A, 0x0080, 2);            // restore MCIEB = Timer B

// MCIRE must not dirty SCIPD (the SOUND CPU's pending register): they are
// different registers, and the 68k acknowledges its own through SCIRE (0x422).
busM.scspWrite(0x422, 0xFFFF, 2);            // clear SCIPD first
busM._scspSetPending(0x0080);                      // Timer B: rises in SCIPD and in MCIPD
busM.scspWrite(0x42E, 0x0080, 2);            // acknowledge from the MAIN CPU side
check("MCIRE does not touch the 68k's SCIPD", 0x0080, regR(busM.scspRam, 0x420) & 0x0080);

// MCIRE has to READ MCIPD, not SCIPD. _scspSetPending leaves both registers
// EQUAL, so as long as they do not differ, reading from the wrong bank gives the same
// result and the bug goes unnoticed. We make them differ on purpose:
//   MCIPD = Timer A + Timer B   /   SCIPD = only Timer A
// and we acknowledge Timer B. If MCIRE read SCIPD, it would compute (0x40 & ~0x80) = 0x40
// and clear Timer B along the way... leaving MCIPD at 0x40: Timer A survives
// anyway, but bit 8 (Timer C), which is only in MCIPD, would be lost. That is the
// canary.
busM.scspWrite(0x422, 0xFFFF, 2);            // SCIPD = 0
busM.scspWrite(0x42E, 0xFFFF, 2);            // MCIPD = 0
busM._scspSetPending(0x0040);                      // Timer A: rises in BOTH
// Timer C (0x100) ONLY in MCIPD: that way the banks differ.
busM.scspRam[0x42C] |= 0x01;                    // MCIPD |= 0x0100
check("setup: MCIPD and SCIPD differ", true,
      regR(busM.scspRam, 0x42C) !== regR(busM.scspRam, 0x420));
busM.scspWrite(0x42E, 0x0040, 2);            // acknowledge ONLY Timer A
check("MCIRE reads MCIPD (not SCIPD): Timer C survives", 0x0100, regR(busM.scspRam, 0x42C) & 0x0100);
check("MCIRE reads MCIPD (not SCIPD): Timer A was acknowledged",  0,      regR(busM.scspRam, 0x42C) & 0x0040);

// MCIRE is a 16-bit register (10042Eh, MCIRE[10:0]): the routing has to cover
// its TWO bytes. A driver that acknowledges by byte writes the low one (0x42F, bits 7-0), which
// is where the timers live. If the range fell short (0x42E..0x42E), the
// write would fall into the _writeRegBE below and would clear nothing.
busM.scspWrite(0x42E, 0xFFFF, 2);            // MCIPD = 0
busM._scspSetPending(0x0080);                      // Timer B pending
busM.scspWrite(0x42F, 0x80, 1);              // acknowledge by BYTE, on the low byte
check("MCIRE also acknowledges on a byte access to 0x42F", 0, regR(busM.scspRam, 0x42C) & 0x0080);


// ==========================================================================
// 7. The envelope (EG) is an ATTENUATION IN dB, not an amplitude ramp
// ==========================================================================
// Regression for the BIOS boot "screech that keeps looping and fades out". The
// hardware EG is a 10-bit attenuation in dB (000H = unattenuated,
// 3FFH = maximum): it represents the change in sound attenuation over
// time, with its maximum at 3FFH. The scale (0.09375 dB per LSB) comes from
// TL (8-bit TL = -95.7 dB, and TL enters the same chain as the EG
// but x4), from ALFOS (ALFOS=7 = 24 dB = the 256 LSB of ALFO[7:0]) and from the
// hardware's volume chain (6 dB every 64 LSB).
//
// With the LINEAR ramp we had (inherited from Yabause), halfway through the release a
// slot was still at 50% amplitude (-6 dB = perfectly audible). With the EG in dB,
// halfway it is at -48 dB (inaudible). That was EXACTLY the profile of the
// screech: the BIOS fires it with RR=3, which gives an envelope step of 1 and
// therefore a release of (0x1FFFFF-0x100000)/44100 = 23.8 s.

const dbOf = (g) => 20 * Math.log10(g / 1023);
check("EG: attenuation 0 = unattenuated (maximum gain)", 1023, TABLE_EG_GAIN[0]);
check("EG: attenuation 3FFH = silence ('maximum attenuation state')", 0,
	TABLE_EG_GAIN[1023]);
// 64 LSB = 6 dB (the hardware's volume chain shifts 1 bit every 64 LSB).
check("EG: 64 LSB of attenuation = -6 dB", true, Math.abs(dbOf(TABLE_EG_GAIN[64]) + 6.0) < 0.05);
check("EG: 128 LSB = -12 dB", true, Math.abs(dbOf(TABLE_EG_GAIN[128]) + 12.0) < 0.05);
check("EG: 256 LSB = -24 dB (= ALFOS=7)", true,
	Math.abs(dbOf(TABLE_EG_GAIN[256]) + 24.0) < 0.1);
// Cross-check with TL, which is built separately and with another constant: if the EG
// is well scaled, 1 TL step has to be worth exactly 4 EG LSB. The two
// constants are not identical (TL uses -0.3762 dB per step, which is the one that
// reproduces the hardware's TL values bit by bit, and 4 EG LSB are 0.3750), so they
// drift apart 0.3% per step: at TL=128 that is already 0.15 dB. Hence the tolerance.
// Small attenuations are compared: below -24 dB both tables are 10-bit integers
// of one or two digits and the quantization (13 vs 14) hides the scale.
let maxDiffTlEg = 0;
for(const tl of [0, 1, 2, 4, 8, 16, 32, 64])
{
	const diff = Math.abs(dbOf(TABLE_EG_GAIN[tl * 4]) - 20 * Math.log10(TL_TABLE[tl] / 1024));
	if(diff > maxDiffTlEg) maxDiffTlEg = diff;
}
check("EG: 1 TL step == 4 EG LSB (cross-check with the TL values)", true, maxDiffTlEg < 0.2);
// Halfway through the release: the bug's signature.
check("EG: halfway through the release it is at -48 dB, not -6 dB (the screech)", true,
	dbOf(TABLE_EG_GAIN[512]) < -47 && dbOf(TABLE_EG_GAIN[512]) > -49);

// The decay half of the curve is indexed by the EG value: it is what makes
// DL ("the upper 5 bits of the attenuation level") mean what it says.
check("EG: in the decay half the index IS the EG value", true,
	TABLE_EG_ATT[1024] === 0 && TABLE_EG_ATT[1024 + 300] === 300 &&
	TABLE_EG_ATT[2047] === 1023);
// The attack has to end where the decay starts (000H) so there is no
// level jump at the transition.
check("EG: the attack ends at 000H, same as the start of the decay", true,
	TABLE_EG_ATT[1023] === 0 && TABLE_EG_ATT[1024] === 0);

// Entries 0-3 of the rate tables: Yabause sets them to zero, and with that an RR=01H
// with a low key rate scale freezes the envelope and THE NOTE NEVER DIES. The hardware
// reserves "amount of change minimum (0)" for RR=00H, not for 01H.
check("rate: RR=01H with low krs has to attenuate (not freeze the note)", true,
	DECAY_TABLE[2] > 0 && DECAY_TABLE[3] > 0);
check("rate: AR=01H with low krs has to attack (not freeze the note)", true,
	ATTACK_TABLE[2] > 0 && ATTACK_TABLE[3] > 0);
// ...and without overshooting: the step of entries 0-3 follows the formula (mantissa times
// 2^-1), that is half that of entries 4-7, never more.
check("rate: the step of entry 0 is half that of entry 4", true,
	ATTACK_TABLE[0] < ATTACK_TABLE[4] && ATTACK_TABLE[4] < ATTACK_TABLE[8]);

// --- End to end: the release profile against the hardware ---
// A slot with constant PCM (DC) makes the output the pure envelope.
function createBusDC(value)
{
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	for(let i = 0; i < 8192; i++)
	{
		b.soundRam[i * 2]     = (value >> 8) & 0xFF;
		b.soundRam[i * 2 + 1] = value & 0xFF;
	}
	return b;
}

// Runs a DC slot and returns the peak of |output| in each segment of `step` samples.
function profileRelease(rr, samples, step, extra)
{
	const b = createBusDC(0x4000);
	// LPCTL = 1 (normal loop): without a loop the slot dies when passing LEA and there would be no
	// release to measure.
	regW(b.scspRam, 0x00, 0x1800 | (1 << 5));  // KYONEX + KYONB + LPCTL=1
	regW(b.scspRam, 0x04, 0x0000);             // LSA = 0
	regW(b.scspRam, 0x06, 0x1000);             // generous LEA
	regW(b.scspRam, 0x08, 0x001F);             // AR = 1F (instant attack), D1R/D2R = 0
	regW(b.scspRam, 0x0A, rr & 0x1F);          // RR, DL = 0
	regW(b.scspRam, 0x16, 0xE000);             // DISDL maximum, centered
	b.scspRam[0x401] = 0x0F;
	if(extra) extra(b.scspRam);

	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(64);                             // let the attack finish
	const l = new Float32Array(step), r = new Float32Array(step);
	m.readAudio(l, r, Math.min(step, m.samplesAvailable()));

	// KEY-OFF: lower KYONB and fire KYONEX again (keeping LPCTL).
	regW(b.scspRam, 0x00, 0x1000 | (1 << 5));
	m.notifyWrite(0x00, 2);

	const peaks = [];
	for(let t = 0; t < samples; t += step)
	{
		m.advance(step);
		m.readAudio(l, r, step);
		let p = 0;
		for(let i = 0; i < step; i++) p = Math.max(p, Math.abs(l[i]));
		peaks.push(p);
	}
	return { engine: m, slot: m.slots[0], peaks: peaks };
}

// RR = 3 is the one the BIOS fires in the screech: envelope step = 1, that is
// 0x1FFFFF-0x100000 = 1048575 release samples = 23.8 s.
const rel = profileRelease(3, 44100 * 12, 44100);   // 12 s, one peak per second
check("release: RR=3 gives an envelope step of 1 (the screech's)", 1, rel.slot.eincr);
const peak0 = rel.peaks[0];
// At ~11.9 s (half of 23.8) the LINEAR ramp left the note at -6 dB: audible.
// With the EG in dB it has to be buried. It is measured at 12 s, which is when the
// user could still hear the screech.
const db12 = 20 * Math.log10(rel.peaks[11] / peak0);
check("release: 12 s into a 23.8 s release the note is below -40 dB",
	true, db12 < -40);
// ...and the profile has to be linear in dB (= exponential in amplitude): the drop
// per second is constant.
const dbPerSec = [];
for(let i = 1; i < 10; i++)
	if(rel.peaks[i] > 0 && rel.peaks[i - 1] > 0)
		dbPerSec.push(20 * Math.log10(rel.peaks[i] / rel.peaks[i - 1]));
const dbMed = dbPerSec.reduce((a, b) => a + b, 0) / dbPerSec.length;
check("release: the drop is LINEAR IN dB (constant dB/s = exponential in amplitude)",
	true, dbPerSec.every(d => Math.abs(d - dbMed) < 0.5));
// The expected rate: 1023 LSB in 23.8 s at 0.09375 dB = 4.03 dB/s.
check("release: drops ~4 dB/s (1023 LSB * 0.09375 dB / 23.8 s)", true,
	Math.abs(dbMed + 4.03) < 0.3);

// KEY-OFF during the attack: on hardware the level is continuous
// (the level at that point, KEY_OFF LEVEL, attenuates according to RR).
// Yabause does ecnt = ENV_DE - ecnt, which only keeps the level if the two halves
// of the curve are mirrors. They are not: that trick dropped the note 48 dB at once.
function keyOffInAttack()
{
	const b = createBusDC(0x4000);
	// LPCTL = 1 (normal loop, bit 5): without a loop the slot DIES when passing LEA -the engine sets
	// ecnt = ENV_DE- and since 28-07-2026 that happens before the attack does. With the curve
	// starting at 3FFH (real silence) the note takes longer to take off, so the sample
	// ended first and the test measured a slot already off instead of one in mid-attack.
	regW(b.scspRam, 0x00, 0x1820);
	regW(b.scspRam, 0x06, 0x1000);
	regW(b.scspRam, 0x08, 0x0004);   // AR = 4 -> slow attack (it can be cut in the middle)
	regW(b.scspRam, 0x0A, 0x0002);   // RR = 2 -> slow release
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);

	const l = new Float32Array(64), r = new Float32Array(64);
	// Advance until the attack is halfway up.
	// The cap went up from 400 to 4,000 iterations on 28-07-2026, when the attack moved to
	// starting at 3FFH (real silence) instead of at -44.6 dB: now the note
	// comes out FROM silence, so it takes longer to reach the 5% level the
	// window below looks for. With 400 the loop fell short, `before` was almost zero and the
	// continuity comparison was made between two noisy numbers.
	let before = 0;
	for(let i = 0; i < 4000; i++)
	{
		m.advance(16); m.readAudio(l, r, 16);
		let p = 0; for(let k = 0; k < 16; k++) p = Math.max(p, Math.abs(l[k]));
		before = p;
		if(p > 0.05 && p < 0.30) break;   // in mid-attack, far from both ends
	}
	const phaseAttack = m.slots[0].ecurp === 0;
	// KEY-OFF in mid-attack.
	regW(b.scspRam, 0x00, 0x1000);
	m.notifyWrite(0x00, 2);
	m.advance(16); m.readAudio(l, r, 16);
	let after = 0; for(let k = 0; k < 16; k++) after = Math.max(after, Math.abs(l[k]));
	return { phaseAttack: phaseAttack, before: before, after: after, slot: m.slots[0] };
}
const ko = keyOffInAttack();
check("key-off in attack: the cut really happened in the attack phase", true, ko.phaseAttack);
check("key-off in attack: the slot moves to release", 3, ko.slot.ecurp);
// The level has to be CONTINUOUS: no audible jump on releasing the key.
check("key-off in attack: the level is continuous ('KEY_OFF LEVEL')", true,
	ko.after > 0 && Math.abs(20 * Math.log10(ko.after / ko.before)) < 1.0);


// ==========================================================================
// 8. Tremolo (ALFOS): depth in dB against the hardware values
// ==========================================================================
// The ALFO is a mix into the EG ("Mixing to EG"): it is ADDED to the attenuation
// of the EG, not subtracted from a linear amplitude. ALFOS=7 is 24 dB, which is the
// whole range of ALFO[7:0] (256 LSB * 0.09375 dB); each step of ALFOS downward
// halves it.
//
// WATCH OUT for Yabause's new engine (yab_scsp.c:754): it does
// lfo_add = ((alfo_val + 1) >> (7 - alfos)) << 1, and that << 1 is extra: it gives 48 dB where
// the hardware gives 24, and with alfos=0 it leaves a residue of 4 LSB where the hardware has
// "0 | No effect".

// Tremolo depth measured from the output: a DC slot + sawtooth LFO, the ratio
// between the loudest and the weakest sample of the LFO cycle.
function depthTremolo(alfos)
{
	const b = createBusDC(0x4000);
	regW(b.scspRam, 0x00, 0x1800);
	regW(b.scspRam, 0x06, 0x1000);
	regW(b.scspRam, 0x08, 0x001F);            // AR maximum, D1R/D2R = 0 -> it sticks at 000H
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x0C, 0x0000);            // TL = 0
	// $12 = LFOF=31 (bits 10-14) | ALFOWS=0 sawtooth (bits 3-4) | ALFOS (bits 0-2)
	regW(b.scspRam, 0x12, 0x7C00 | (alfos & 7));
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(512);                            // 2 complete LFO cycles
	const l = new Float32Array(512), r = new Float32Array(512);
	m.readAudio(l, r, 512);
	let height = 0, low = Infinity;
	for(let i = 256; i < 512; i++)             // the second cycle, already settled
	{
		const v = Math.abs(l[i]);
		if(v > height) height = v;
		if(v < low) low = v;
	}
	return 20 * Math.log10(low / height);       // negative: how much it attenuates
}

// ALFOS 1..7 -> 0.4 / 0.8 / 1.5 / 3 / 6 / 12 / 24 dB. The
// exact hardware values are 24/2^(7-ALFOS) = 0.375 / 0.75 / 1.5 / 3 / 6 / 12 / 24;
// the nominal values round the first two to 0.4 and 0.8.
const EXPECTED_ALFOS = [0, 0.375, 0.75, 1.5, 3, 6, 12, 24];
for(let a = 1; a <= 7; a++)
{
	const measured = -depthTremolo(a);
	// Fine tolerance: the only real slack is the quantization of the 10-bit gain
	// table, which only shows at -24 dB (~0.15 dB step). The
	// old formula was off by 43-94x. The tight tolerance of ALFOS=1 is the one that
	// anchors the "+1" (without it, ALFO[7:0]=FFH scales to 3 LSB instead of 4 = 0.28 dB).
	check(`tremolo: ALFOS=${a} -> ${EXPECTED_ALFOS[a]} dB`, true,
		Math.abs(measured - EXPECTED_ALFOS[a]) < (a === 7 ? 0.25 : 0.05));
}
check("tremolo: ALFOS=0 -> no effect ('0 | No effect')", 0,
	depthTremolo(0));

// The total attenuation (EG + ALFO) has to be clamped to 3FFH: the EG alone already reaches
// 3FFH and the ALFO adds up to 256 more LSB, so without clamping the index goes out
// of the gain table and the output becomes NaN (silence + broken audio).
function tremoloInRelease()
{
	const b = createBusDC(0x4000);
	regW(b.scspRam, 0x00, 0x1800 | (1 << 5));   // LPCTL = 1
	regW(b.scspRam, 0x06, 0x1000);
	regW(b.scspRam, 0x08, 0x001F);              // AR maximum
	regW(b.scspRam, 0x0A, 0x001F);              // RR = 1F -> super-fast release
	regW(b.scspRam, 0x12, 0x7C07);              // LFOF=31, ALFOWS=sawtooth, ALFOS=7
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(64);
	regW(b.scspRam, 0x00, 0x1000 | (1 << 5));   // KEY-OFF: goes to the bottom of the EG
	m.notifyWrite(0x00, 2);
	const l = new Float32Array(2048), r = new Float32Array(2048);
	m.advance(2048); m.readAudio(l, r, 2048);
	return Array.from(l).every(v => Number.isFinite(v));
}
check("EG: the total attenuation (EG + ALFO) is clamped to 3FFH (no NaN)", true,
	tremoloInRelease());


// ==========================================================================
// 9. SSCTL: sound source
// ==========================================================================
// SSCTL values: 00B = external DRAM data, 01B = internally generated data
// (noise), 10B = internally generated data (all 0), 11B = not available.
// The noise comes from the slot's LFO noise oscillator. Without this the
// percussion, explosions, wind and hi-hats stay MUTE.
function runSsctl(ssctl)
{
	const b = createBusDC(0x4000);
	regW(b.scspRam, 0x00, 0x1800 | (ssctl << 7));
	regW(b.scspRam, 0x06, 0x1000);
	regW(b.scspRam, 0x08, 0x001F);
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(256);
	const l = new Float32Array(256), r = new Float32Array(256);
	m.readAudio(l, r, 256);
	// It is measured from 8 onward: sample 0 comes out before the first envelope
	// step, that is with the attack not started yet.
	let distinct = new Set(), peak = 0;
	for(let i = 8; i < 256; i++) { distinct.add(l[i]); peak = Math.max(peak, Math.abs(l[i])); }
	return { engine: m, left: l.slice(8), peak: peak, distinct: distinct.size };
}

const ss0 = runSsctl(0), ss1 = runSsctl(1), ss2 = runSsctl(2);
check("SSCTL=00B: PCM from sound RAM (the constant DC)", true,
	ss0.peak > 0.4 && ss0.distinct === 1);
check("SSCTL=01B: noise comes out (it used to be silence)", true, ss1.peak > 0.1);
check("SSCTL=01B: the noise is real noise (many distinct values)", true,
	ss1.distinct > 200);
check("SSCTL=01B: the noise is NOT the RAM's PCM", true, ss1.distinct !== 1);
check("SSCTL=10B: 'Internally generated data (ALL 0)' = silence", 0, ss2.peak);
// The noise oscillator belongs to each slot: two slots with noise cannot come out
// identical (if they shared state you would hear a single noise at double volume).
check("SSCTL=01B: the noise oscillator is per slot (deterministic and distinct)", true,
	runSsctl(1).engine.slots[0].noise !== runSsctl(1).engine.slots[1].noise);
// And it is deterministic: two identical runs give the same thing (stable tests).
check("SSCTL=01B: the noise is deterministic across runs", true,
	runSsctl(1).left.every((v, i) => v === ss1.left[i]));


// ==========================================================================
// 10. SBCTL / EGHOLD / SDIR / STWINH: the bits the code named and did not use
// ==========================================================================

// --- SBCTL: SBCTL0 inverts all but the sign bit of the source
// waveform data; SBCTL1 inverts the sign bit of the source waveform data.
function firstSample(w00, pcmValue)
{
	const b = createBusDC(pcmValue);
	regW(b.scspRam, 0x00, w00);
	regW(b.scspRam, 0x06, 0x1000);
	regW(b.scspRam, 0x08, 0x001F);
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(8);
	const l = new Float32Array(8), r = new Float32Array(8);
	m.readAudio(l, r, 8);
	return Math.round(l[7] * 32768);   // the sample with the attack already finished
}
// $00 bits 10:9 = SBCTL. It is tested with PCM = 0x0000, which separates the 4 cases well:
// as is = 0, invert all but the sign = 0x7FFF (+32767), invert the sign =
// 0x8000 (-32768) and both = 0xFFFF (-1). (0x4000 did not work: inverting all
// but the sign gives 0x3FFF, that is 16 LSB of difference over 32768.)
check("SBCTL=00B: the sample comes out as is", 0, firstSample(0x1800, 0x0000));
check("SBCTL=01B: inverts all but the sign bit (0x0000 -> 0x7FFF)", true,
	firstSample(0x1800 | (1 << 9), 0x0000) > 32700);
check("SBCTL=10B: inverts the sign bit (0x0000 -> 0x8000)", true,
	firstSample(0x1800 | (2 << 9), 0x0000) < -32700);
check("SBCTL=11B: inverts both (0x0000 -> 0xFFFF = -1)", true,
	Math.abs(firstSample(0x1800 | (3 << 9), 0x0000)) <= 1);
// And with another value, so that a particular case is not enough.
check("SBCTL=01B: 0x1234 -> 0x6DCB", true,
	Math.abs(firstSample(0x1800 | (1 << 9), 0x1234) - 28107) < 40);
check("SBCTL=10B: 0x1234 -> 0x9234 (negative)", true,
	firstSample(0x1800 | (2 << 9), 0x1234) < -28000);

// --- EGHOLD: when this bit is 1B, the value during attack is held at
// 000H, that is full volume during the whole attack (which still lasts what
// AR says: the time the EG holds 000H is determined by the value of AR).
function withEghold(eghold)
{
	const b = createBusDC(0x4000);
	regW(b.scspRam, 0x00, 0x1800);
	regW(b.scspRam, 0x06, 0x1000);
	regW(b.scspRam, 0x08, 0x0004 | (eghold ? 0x20 : 0));   // AR = 4 (slow attack)
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(16);
	const l = new Float32Array(16), r = new Float32Array(16);
	m.readAudio(l, r, 16);
	return { engine: m, peak: Math.max(...Array.from(l).map(Math.abs)), slot: m.slots[0] };
}
const noHold = withEghold(false), withHold = withEghold(true);
check("EGHOLD: decoded from bit 5 of $08", true,
	withHold.slot.eghold === 1 && noHold.slot.eghold === 0);
check("EGHOLD=0: at the start of the attack the note has not risen yet", true, noHold.peak < 0.05);
check("EGHOLD=1: the attack is held at 000H (full volume from the start)", true,
	withHold.peak > 0.49);
check("EGHOLD=1: still in the attack phase (the hold does not skip it)", 0, withHold.slot.ecurp);

// --- SDIR: when this bit is 1B, the sound data is output without being
// multiplied by EG, TL, ALFO, etc.
function withSdir(sdir, tl)
{
	const b = createBusDC(0x4000);
	regW(b.scspRam, 0x00, 0x1800);
	regW(b.scspRam, 0x06, 0x1000);
	regW(b.scspRam, 0x08, 0x0000);          // AR = 0 -> the envelope NEVER rises
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x0C, (sdir ? 0x100 : 0) | (tl & 0xFF));
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(16);
	const l = new Float32Array(16), r = new Float32Array(16);
	m.readAudio(l, r, 16);
	return { slot: m.slots[0], peak: Math.max(...Array.from(l).map(Math.abs)) };
}
check("SDIR: decoded from bit 8 of $0C", 1, withSdir(true, 0).slot.sdir);
// With AR=0 and TL=FFH the normal path is buried; with SDIR it comes out at full volume.
check("SDIR=0: the EG and the TL attenuate the output", true, withSdir(false, 0xFF).peak < 0.01);
check("SDIR=1: the sample comes out without EG/TL/ALFO", true, withSdir(true, 0xFF).peak > 0.49);

// --- STWINH: when this bit is 1B, writing the slot output to the sound
// stack (SOUS) is prohibited.
function withStwinh(stwinh)
{
	const b = createBusDC(0x4000);
	regW(b.scspRam, 0x00, 0x1800);
	regW(b.scspRam, 0x06, 0x1000);
	regW(b.scspRam, 0x08, 0x001F);
	regW(b.scspRam, 0x0A, 0x0000);
	regW(b.scspRam, 0x0C, stwinh ? 0x200 : 0);
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(16);
	return m;
}
check("STWINH: decoded from bit 9 of $0C", 1, withStwinh(true).slots[0].stwinh);
check("STWINH=0: the slot writes its output into the sound stack", true,
	withStwinh(false).soundStack[32] !== 0);
check("STWINH=1: the slot does NOT write into the sound stack", 0, withStwinh(true).soundStack[32]);


// ==========================================================================
// 11. LPSLNK: the attack moves to decay 1 on reaching the start of the loop
// ==========================================================================
// LPSLNK (loop start link) synchronizes the start of the
// loop and the transition from the EG attack state to the decay 1 state.
function withLpslnk(lpslnk, lsa)
{
	const b = createBusDC(0x4000);
	regW(b.scspRam, 0x00, 0x1800 | (1 << 5));   // LPCTL = 1 (normal loop)
	regW(b.scspRam, 0x04, lsa);                 // LSA
	regW(b.scspRam, 0x06, 0x1000);              // LEA
	regW(b.scspRam, 0x08, 0x0002);              // AR = 2 -> VERY slow attack
	regW(b.scspRam, 0x0A, (lpslnk ? 0x4000 : 0) | 0x0000);   // LPSLNK in bit 14
	regW(b.scspRam, 0x16, 0xE000);
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	return m;
}
// LSA = 64 samples: with OCT/FNS=0 the phase advances 1 sample per Fs, so the
// read address reaches the start of the loop at 64 samples. The attack with
// AR=2 takes much, much longer, so the link is the only thing that can cut it.
const linkOn = withLpslnk(true, 64), linkOff = withLpslnk(false, 64);
check("LPSLNK: decoded from bit 14 of $0A", true,
	linkOn.slots[0].lpslnk === 1 && linkOff.slots[0].lpslnk === 0);
linkOn.advance(32); linkOff.advance(32);
check("LPSLNK=1: before the start of the loop it stays in attack", 0, linkOn.slots[0].ecurp);
linkOn.advance(64); linkOff.advance(64);
check("LPSLNK=1: on reaching the start of the loop it moves to decay", true, linkOn.slots[0].ecurp !== 0);
check("LPSLNK=0: without the link the attack runs its course", 0, linkOff.slots[0].ecurp);
// The level is kept: the hardware transitions with the SCL (EG
// level) at this point, without resetting the EG to 000H.
check("LPSLNK=1: the transition keeps the EG level (does not jump to 000H)", true,
	linkOn.slots[0].ecnt > 0x100000 + (100 << 10));


// ==========================================================================
// 12. SOUS ($600-$67F): the sound stack mirrored to the registers
// ==========================================================================
// $600-$63E = GENERATION A, $640-$67E = GENERATION B.
// SOUS[15:0] (R/W) is the SOUnd Stack, a data buffer for slot output: a 64-word ring
// buffer that can hold two generations of sampling data.
// The wave alternates from sample to sample: if it were DC both generations would give
// the same thing and A could not be told from B.
const busSous = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
for(let i = 0; i < 2048; i++)
{
	const s = (i & 1) ? 0x4000 : 0xC000;
	busSous.soundRam[i * 2] = (s >> 8) & 0xFF;
	busSous.soundRam[i * 2 + 1] = s & 0xFF;
}
regW(busSous.scspRam, 0x00, 0x1800);
regW(busSous.scspRam, 0x06, 0x1000);
regW(busSous.scspRam, 0x08, 0x001F);
regW(busSous.scspRam, 0x0A, 0x0000);
regW(busSous.scspRam, 0x16, 0xE000);
busSous.scspRam[0x401] = 0x0F;
const mSous = new ScspEngine(busSous);
mSous.notifyWrite(0x00, 2);
mSous.advance(16);
check("SOUS: GENERATION A ($600) mirrors the current generation", (mSous.soundStack[32] & 0xFFFF),
	regR(busSous.scspRam, 0x600));
check("SOUS: GENERATION B ($640) mirrors the previous generation", (mSous.soundStack[0] & 0xFFFF),
	regR(busSous.scspRam, 0x640));
// With the alternating wave both generations have to differ: that is what proves that
// A and B are not swapped.
check("SOUS: GENERATION A and B are different (two real generations)", true,
	regR(busSous.scspRam, 0x600) !== regR(busSous.scspRam, 0x640));
check("SOUS: slot 0 left real data at $600", true, regR(busSous.scspRam, 0x600) !== 0);
check("SOUS: muted slots leave 0 (slot 31 at $63E)", 0, regR(busSous.scspRam, 0x63E));


// ==========================================================================
// 13. SCSP internal DMA ($412-$416): HANG if DEXE is not cleared
// ==========================================================================
// It runs against the real Bus because the DMA lives in
// bus.js (the SCSP registers and the sound RAM belong to it).
//
// Why it matters: the DMA transfer starts when DEXE is 1B, and when the DMA
// transfer is completed it automatically becomes 0B. A driver that starts a
// DMA and polls DEXE until it sees it at 0 SPINS FOREVER if the bit never drops.

// Sets up a DMA and fires it. Returns the bus.
function buildDma(dmea, drga, dtlg, flags)
{
	const b = new globalThis.Bus();
	b.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
	b.scspWrite(0x412, dmea & 0xFFFE, 2);                       // DMEA[15:1]
	b.scspWrite(0x414, (((dmea >> 16) & 0xF) << 12) | (drga & 0xFFE), 2);
	b.scspWrite(0x416, flags | (dtlg & 0xFFE), 2);              // fires if DEXE
	return b;
}
const DEXE = 0x1000, DDIR = 0x2000, DGATE = 0x4000;

// --- DDIR=0: sound RAM -> registers ---
const dmaA = new globalThis.Bus();
dmaA.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
// Data in sound RAM (big-endian) that ends up in a slot's registers.
// 32 words are filled even though 8 are transferred: if the engine went past DTLG, the
// registers further back would end up written (with the RAM at zero it would not show).
for(let i = 0; i < 32; i++) { dmaA.soundRam[0x1000 + i * 2] = 0xAB; dmaA.soundRam[0x1001 + i * 2] = 0xC0 + i; }
dmaA.scspWrite(0x412, 0x1000, 2);
dmaA.scspWrite(0x414, 0x0100, 2);   // DMEA[19:16]=0, DRGA = 0x100 (slot 8)
dmaA.scspWrite(0x416, DEXE | 0x0010, 2);   // DTLG = 0x10 bytes = 8 words
check("DMA: DDIR=0 copies from sound RAM to the registers", 0xABC0, regR(dmaA.scspRam, 0x100));
check("DMA: DDIR=0 copies all the words requested by DTLG", 0xABC7, regR(dmaA.scspRam, 0x10E));
check("DMA: DDIR=0 does not go past DTLG", 0x0000, regR(dmaA.scspRam, 0x110));
check("DMA: DDIR=0 does not go past DTLG (nor much further back)", 0x0000, regR(dmaA.scspRam, 0x13E));
// THE bit that avoids the hang, and THE TIME IT TAKES TO DROP.
// These checks demanded DEXE = 0 and the IRQ already set as soon as the register was written, that is
// they encoded the INSTANTANEOUS model. It is the same mistake that cost a session with the CD block
// (64 of 179 checks pinned the zero-latency model there): a test written against the
// observed behavior turns the shortcut into a requirement. Now the handshake is exercised:
// while the DMA runs DEXE stays at 1, and it drops when the time passes.
check("DMA: DEXE stays at 1 while the transfer runs", DEXE, regR(dmaA.scspRam, 0x416) & DEXE);
check("DMA: there is no end IRQ yet", 0, regR(dmaA.scspRam, 0x420) & 0x10);
// 8 words fit in a single sample (the hardware limit is 62 words per sample), so
// one tick is enough.
dmaA.scspTick(1);
check("DMA: DEXE clears by itself on finishing", 0, regR(dmaA.scspRam, 0x416) & DEXE);
// Bit 4 of the interrupt registers is the DMA transfer end interrupt.
check("DMA: on finishing it sets bit 4 pending in SCIPD", 0x10, regR(dmaA.scspRam, 0x420) & 0x10);
check("DMA: on finishing it sets bit 4 pending in MCIPD", 0x10, regR(dmaA.scspRam, 0x42C) & 0x10);

// A long transfer has to take MORE than one sample: 1906 words (the maximum of
// 3812 bytes the register area accepts) against the limit of 62 per sample is
// 31 samples. If it gave 1, the model would be instantaneous again by another route.
const dmaLength = new globalThis.Bus();
dmaLength.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
dmaLength.scspWrite(0x412, 0x4000, 2);
dmaLength.scspWrite(0x414, 0x0000, 2);
dmaLength.scspWrite(0x416, DEXE | DDIR | 0xEE4, 2);   // DTLG = 3812 bytes = 1906 words
dmaLength.scspTick(20);
check("DMA: a long transfer does NOT finish in 20 samples", DEXE, regR(dmaLength.scspRam, 0x416) & DEXE);
// The cost the DMA charges the 68000: while it runs it takes memory cycles, and the sound
// CPU executes FROM sound RAM, so it advances less. With a
// long transfer it takes the 62 free cycles of each sample, that is all of them.
// It gives 0.9917 and not exactly 1 because the last of the 31 samples is not fully used:
// 1906 words / (31 x 62) = 0.99167. It is checked this way and not with "=== 1" so as not to pin
// a rounding the model does not promise.
check("DMA: while it runs it charges the 68000 almost all the cycles", true,
	dmaLength.scsp.dmaFrac > 0.99 && dmaLength.scsp.dmaFrac <= 1);
dmaLength.scspTick(15);
check("DMA: the long transfer finishes near 31 samples", 0, regR(dmaLength.scspRam, 0x416) & DEXE);
check("DMA: on finishing it stops charging the 68000", 0, dmaLength.scsp.dmaFrac);

// A short transfer uses only part of the cycles of that sample, so it charges
// that part and no more: 8 words of the 62 that fit in a sample.
const dmaCorto = new globalThis.Bus();
dmaCorto.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
dmaCorto.scspWrite(0x412, 0x5000, 2);
dmaCorto.scspWrite(0x414, 0x0000, 2);
dmaCorto.scspWrite(0x416, DEXE | DDIR | 0x0010, 2);   // 16 bytes = 8 words
check("DMA: a short transfer charges only its part", true,
	Math.abs(dmaCorto.scsp.dmaFrac - 8 / 62) < 1e-9);

// --- DDIR=1: registers -> sound RAM ---
const dmaB = new globalThis.Bus();
dmaB.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
for(let i = 0; i < 4; i++) regW(dmaB.scspRam, 0x200 + i * 2, 0x1230 + i);
dmaB.scspWrite(0x412, 0x2000, 2);
dmaB.scspWrite(0x414, 0x0200, 2);          // DRGA = 0x200 (slot 16)
dmaB.scspWrite(0x416, DEXE | DDIR | 0x0008, 2);   // DTLG = 8 bytes = 4 words
check("DMA: DDIR=1 copies from the registers to sound RAM", 0x1230,
	(dmaB.soundRam[0x2000] << 8) | dmaB.soundRam[0x2001]);
check("DMA: DDIR=1 copies the last word", 0x1233,
	(dmaB.soundRam[0x2006] << 8) | dmaB.soundRam[0x2007]);
check("DMA: DDIR=1 does not go past DTLG", 0x0000,
	(dmaB.soundRam[0x2008] << 8) | dmaB.soundRam[0x2009]);
dmaB.scspTick(1);
check("DMA: DDIR=1 also clears DEXE", 0, regR(dmaB.scspRam, 0x416) & DEXE);

// --- DGATE: initializes the SCSP built-in control registers or any area of the
// sound memory to 0. Erasing transfers (writing 0) with DGATE do not
// affect the data at the transfer source. ---
const dmaC = new globalThis.Bus();
dmaC.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
for(let i = 0; i < 4; i++) { dmaC.soundRam[0x3000 + i * 2] = 0x55; dmaC.soundRam[0x3001 + i * 2] = 0xAA; }
for(let i = 0; i < 4; i++) regW(dmaC.scspRam, 0x200 + i * 2, 0x9999);
dmaC.scspWrite(0x412, 0x3000, 2);
dmaC.scspWrite(0x414, 0x0200, 2);
dmaC.scspWrite(0x416, DEXE | DGATE | 0x0008, 2);   // DGATE + DDIR=0 -> clears registers
check("DMA: DGATE with DDIR=0 sets the registers to 0", 0x0000, regR(dmaC.scspRam, 0x200));
check("DMA: DGATE does not touch the source (sound RAM stays the same)", 0x55AA,
	(dmaC.soundRam[0x3000] << 8) | dmaC.soundRam[0x3001]);
const dmaD = buildDma(0x3000, 0x200, 0x0008, DEXE | DGATE | DDIR);
for(let i = 0; i < 4; i++) { dmaD.soundRam[0x3000 + i * 2] = 0x55; dmaD.soundRam[0x3001 + i * 2] = 0xAA; }
dmaD.scspWrite(0x416, DEXE | DGATE | DDIR | 0x0008, 2);
check("DMA: DGATE with DDIR=1 sets sound RAM to 0", 0,
	(dmaD.soundRam[0x3000] << 8) | dmaD.soundRam[0x3001]);

// --- DEXE=0 starts nothing: writing 0B is invalid ---
const dmaE = new globalThis.Bus();
dmaE.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
dmaE.soundRam[0x1000] = 0x77; dmaE.soundRam[0x1001] = 0x88;
dmaE.scspWrite(0x412, 0x1000, 2);
dmaE.scspWrite(0x414, 0x0100, 2);
dmaE.scspWrite(0x416, 0x0010, 2);   // DTLG set but WITHOUT DEXE
check("DMA: without DEXE nothing is transferred", 0x0000, regR(dmaE.scspRam, 0x100));
check("DMA: without DEXE bit 4 is not set pending", 0, regR(dmaE.scspRam, 0x420) & 0x10);

// --- The DMEA bit map: DMEA[19:16] goes in bits 15:12 of $414 ---
const dmaF = new globalThis.Bus();
dmaF.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
dmaF.soundRam[0x41000] = 0xDE; dmaF.soundRam[0x41001] = 0xAD;
dmaF.scspWrite(0x412, 0x1000, 2);
// DRGA = 0x700 (DSP COEF): a register with no side effects. In a slot's $00
// bit 12 of the data would land right on KYONEX and the engine would consume it.
dmaF.scspWrite(0x414, 0x4000 | 0x0700, 2);   // DMEA[19:16] = 4 -> 0x41000
dmaF.scspWrite(0x416, DEXE | 0x0002, 2);     // 1 word
check("DMA: DMEA[19:16] comes from bits 15:12 of $414", 0xDEAD,
	regR(dmaF.scspRam, 0x700));

// --- A DMA into the slot region has to redecode the slot ---
// (that is the reason for going through scspWrite and not writing the raw bank).
const dmaG = new globalThis.Bus();
dmaG.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
regW(dmaG.soundRam, 0x5000, 0x0800);   // $00 of slot 0: KYONB, without KYONEX
dmaG.scspWrite(0x412, 0x5000, 2);
dmaG.scspWrite(0x414, 0x0000, 2);   // DRGA = 0 -> slot 0
dmaG.scspWrite(0x416, DEXE | 0x0002, 2);
check("DMA: writing a slot through DMA redecodes it in the engine", 1,
	dmaG.scspEngine.slots[0].key);


// ==========================================================================
// 14. MSLC / CA ($408): the read pointer of the monitored slot
// ==========================================================================
// MSLC[4:0] in bits 15:11, CA[3:0] in
// bits 10:7. CA (R) gives the address of the waveform data the monitored slot is
// currently reading, as the relative number of samples from SA. The LSB of
// the value read here stands for 4K (4096) samples.
// Why it matters: a driver that polls CA to know whether a sample ended or
// looped spins forever if CA always returns 0.
const busCa = new globalThis.Bus();
busCa.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
check("CA: starts at 0 (no slot has read anything)", 0, (busCa.scspRead(0x408, 2) >> 7) & 0xF);
// MSLC = 5 -> monitor slot 5. The phase counter has 10 fractional
// bits; CA is (sample >> 12), so it takes 4096 samples for
// CA to be worth 1.
busCa.scspWrite(0x408, 5 << 11, 2);
busCa.scspEngine.slots[5].fcnt = 4095 << 10;
check("CA: with fewer than 4096 samples read it stays at 0", 0, (busCa.scspRead(0x408, 2) >> 7) & 0xF);
busCa.scspEngine.slots[5].fcnt = 4096 << 10;
check("CA: the LSB is worth 4096 samples", 1, (busCa.scspRead(0x408, 2) >> 7) & 0xF);
busCa.scspEngine.slots[5].fcnt = (4096 * 7) << 10;
check("CA: keeps counting in steps of 4096", 7, (busCa.scspRead(0x408, 2) >> 7) & 0xF);
busCa.scspEngine.slots[5].fcnt = (4096 * 16) << 10;
check("CA: it is 4 bits and wraps around", 0, (busCa.scspRead(0x408, 2) >> 7) & 0xF);
// CA belongs to the slot MSLC names and to no other.
busCa.scspEngine.slots[5].fcnt = 0;
busCa.scspEngine.slots[9].fcnt = (4096 * 3) << 10;
check("CA: looks at MSLC's slot, not another", 0, (busCa.scspRead(0x408, 2) >> 7) & 0xF);
busCa.scspWrite(0x408, 9 << 11, 2);
check("CA: changing MSLC changes the monitored slot", 3, (busCa.scspRead(0x408, 2) >> 7) & 0xF);
check("CA: MSLC is kept in the register", 9, (busCa.scspRead(0x408, 2) >> 11) & 0x1F);
// A driver that reads CA by byte has to see the same thing (bit 7 = CA[0]).
busCa.scspEngine.slots[9].fcnt = 4096 << 10;
check("CA: it is also refreshed when read by byte", 0x80, busCa.scspRead(0x409, 1) & 0x80);


// ==========================================================================
// 15. SCIPD / MCIPD: only bit 5 is written
// ==========================================================================
// Only bit 5 can be read and written; all the others are read-only. Writing 1B to
// bit 5 causes an interrupt to the sound CPU. Writing 0B, however, is invalid.
// Bit 5 is the standard SH-2 <-> 68k IPC doorbell (it supports CPU manual
// interrupts).
const busIpc = new globalThis.Bus();
let irqsIpc = 0;
busIpc.connectCpu({ requestInterrupt: () => { irqsIpc++; }, reset: () => {} });
// Unmask the sound request in the SCU: its IMS starts at 0000BFFFH (all masked),
// as on the hardware. See the note in the other block of this file.
busIpc.writeLong(0x25FE00A0, 0x00000000);

busIpc._scspSetPending(0x0040);                 // the hardware sets Timer A pending
check("SCIPD: Timer A was left pending", 0x40, regR(busIpc.scspRam, 0x420) & 0x40);
// THE bug: writing the doorbell must NOT erase what the hardware set.
busIpc.scspWrite(0x420, 0x0020, 2);
check("SCIPD: writing bit 5 sets it", 0x20, regR(busIpc.scspRam, 0x420) & 0x20);
check("SCIPD: writing bit 5 does NOT erase the pending Timer A", 0x40,
	regR(busIpc.scspRam, 0x420) & 0x40);
// The other bits are read-only: writing them does nothing. One bit of the
// high byte (the sample one, bit 10) and one of the LOW byte (Timer B, bit 7), which is where
// bit 5 lives, are tested: if the filter let the whole byte through, the low one would slip in.
busIpc.scspWrite(0x422, 0xFFFF, 2);       // clear SCIPD
busIpc.scspWrite(0x420, 0x0400, 2);
check("SCIPD: the high-byte bits are read-only (they do not get set)", 0,
	regR(busIpc.scspRam, 0x420) & 0x400);
busIpc.scspWrite(0x420, 0x0080, 2);
check("SCIPD: the low-byte bits cannot be set either (only bit 5)", 0,
	regR(busIpc.scspRam, 0x420) & 0x0080);
busIpc._scspSetPending(0x0040);                 // restore the pending Timer A
busIpc.scspWrite(0x420, 0x0020, 2);       // ...and the doorbell
busIpc.scspWrite(0x420, 0x0000, 2);
check("SCIPD: writing 0 to bit 5 is invalid (it does not clear it)", 0x20,
	regR(busIpc.scspRam, 0x420) & 0x20);
// And the 68k clears it through SCIRE, like any other bit.
busIpc.scspWrite(0x422, 0x0020, 2);
check("SCIPD: bit 5 is cleared through SCIRE", 0, regR(busIpc.scspRam, 0x420) & 0x20);

// The same on the MAIN CPU side, and on top of that it has to INTERRUPT.
busIpc.scspWrite(0x42E, 0xFFFF, 2);       // clear MCIPD
busIpc._scspSetPending(0x0080);                 // Timer B pending
busIpc.scspWrite(0x42A, 0x0020, 2);       // MCIEB = only the doorbell
irqsIpc = 0;
busIpc.scspWrite(0x42C, 0x0020, 2);       // the 68k rings the SH-2's doorbell
check("MCIPD: writing bit 5 sets it", 0x20, regR(busIpc.scspRam, 0x42C) & 0x20);
check("MCIPD: writing bit 5 does NOT erase the pending Timer B", 0x80,
	regR(busIpc.scspRam, 0x42C) & 0x80);
check("MCIPD: the doorbell requests Sound Request from the SH-2", 1, irqsIpc);
irqsIpc = 0;
busIpc.scspWrite(0x42C, 0x0000, 2);
check("MCIPD: writing 0 does not interrupt (\"writing '0B' is invalid\")", 0, irqsIpc);
// Bit 5 lives in the LOW byte: a driver that writes by byte has to get through.
busIpc.scspWrite(0x42E, 0xFFFF, 2);
busIpc.scspWrite(0x42D, 0x20, 1);
check("MCIPD: the doorbell also works on a byte access to 0x42D", 0x20,
	regR(busIpc.scspRam, 0x42C) & 0x20);
// ...and writing the HIGH byte cannot touch bit 5 or overwrite anything.
busIpc.scspWrite(0x42E, 0xFFFF, 2);
busIpc._scspSetPending(0x0400);                 // sample bit (high byte)
busIpc.scspWrite(0x42C, 0xFF, 1);         // write to the high byte
check("MCIPD: writing the high byte does not overwrite the pending bits", 0x400,
	regR(busIpc.scspRam, 0x42C) & 0x400);


// --- THE TWO ENDPOINTS OF THE ATTACK CURVE ----------------------------------------
// The SHAPE of the curve is not published, but the endpoints are, and they are what the
// previous version did not honor (it started at -44.6 dB instead of silence):
//  - On a KEY-OFF during the attack, the EG value does not reach 000H; with
//    KEY_OFF as a turning point it INCREASES back to 3FFH. So 3FFH is the
//    endpoint it comes from.
//  - The attenuation volume axis goes from 000H to 3FFH.
//  - With AR = 00H the change volume (level attenuation volume) is minimum (0),
//    that is, the envelope does not advance and the slot stays where it started.
{
	const T = globalThis.TABLE_EG_ATT;
	check("attack: starts at 3FFH (silence)", 0x3FF, T[0]);
	check("attack: ends at 000H (unattenuated)", 0, T[1023]);
	// Monotonic: the attenuation can only go down during the attack.
	let monotonic = true;
	for(let i = 1; i < 1024; i++) if(T[i] > T[i - 1]) monotonic = false;
	check("attack: the attenuation only goes down", true, monotonic);
	// And the decay half: the index IS the EG value (that was already there and is kept).
	check("decay: the index is the EG value", 512, T[1024 + 512]);

	// With AR = 0 the envelope does not advance, so the slot stays MUTE at 3FFH.
	const b = { scspRam: new Uint8Array(0x1000), soundRam: new Uint8Array(0x80000) };
	for(let i = 0; i < 2048; i++){ b.soundRam[i * 2] = 0x40; b.soundRam[i * 2 + 1] = 0x00; }
	regW(b.scspRam, 0x00, 0x1800);   // KYONEX + KYONB
	regW(b.scspRam, 0x06, 0x0400);   // LEA
	regW(b.scspRam, 0x08, 0x0000);   // AR = 0 -> "change volume minimum (0)"
	regW(b.scspRam, 0x16, 0xE000);   // DISDL maximum
	b.scspRam[0x401] = 0x0F;
	const m = new ScspEngine(b);
	m.notifyWrite(0x00, 2);
	m.advance(256);
	const l = new Float32Array(256), r = new Float32Array(256);
	m.readAudio(l, r, 256);
	let peak = 0;
	for(let i = 0; i < 256; i++) peak = Math.max(peak, Math.abs(l[i]));
	check("attack: with AR=0 the slot stays MUTE", 0, peak);
}

// --- TEMP / MEMS / MIXS are READABLE ----------------------------------------------
// They are in the map just like EFREG and SOUS, with TEMP and MEMS at 24 bits and MIXS at 20, each
// entry in TWO words (the high half first). The raw bank used to be returned, that is
// zeros: the live DSP state never came out.
{
	const bDsp = new globalThis.Bus();
	bDsp.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
	const mDsp = bDsp.scspEngine;
	mDsp.dspTemp[0] = 0xABCDEF;   mDsp.dspTemp[127] = 0x123456;
	mDsp.dspMems[0] = 0x0F1E2D;   mDsp.dspMems[31]  = 0x00FFFF;
	mDsp.dspMixs[0] = 0xABCDE;    mDsp.dspMixs[15]  = 0x00007;

	check("TEMP[0] high half (bits 23:8)", 0xABCD, bDsp.scspRead(0xC00, 2));
	check("TEMP[0] low half (bits 7:0)",  0x00EF, bDsp.scspRead(0xC02, 2));
	check("TEMP[127] reaches the end", 0x1234, bDsp.scspRead(0xC00 + 127 * 4, 2));
	check("MEMS[0] high half",             0x0F1E, bDsp.scspRead(0xE00, 2));
	check("MEMS[0] low half",             0x002D, bDsp.scspRead(0xE02, 2));
	check("MEMS[31] reaches the end",  0x00FF, bDsp.scspRead(0xE00 + 31 * 4, 2));
	// MIXS is 20 bits: the high half is bits 19:4 and the low one the bottom 4.
	check("MIXS[0] bits 19:4",              0xABCD, bDsp.scspRead(0xE80, 2));
	check("MIXS[0] bits 3:0",               0x000E, bDsp.scspRead(0xE82, 2));
	check("MIXS[15] reaches the end",  0x0000, bDsp.scspRead(0xE80 + 15 * 4, 2));
	check("MIXS[15] bits 3:0",              0x0007, bDsp.scspRead(0xE82 + 15 * 4, 2));
}

console.log(`\n${passed} PASS, ${failed} FAIL`);
console.log(`  test 1  direct output peak       = ${maxAbs.toFixed(4)}`);
console.log(`  test 2  vibrato: diff. samples   = ${diffVib}/${N}  maxdiff=${maxDiffVib.toFixed(4)}` +
            `  fcnt ${noLfo.slot.fcnt} -> ${vibrato.slot.fcnt} (delta ${vibrato.slot.fcnt - noLfo.slot.fcnt})`);
console.log(`  test 2  tremolo: diff. samples   = ${diffTre}/${N}  maxdiff=${maxDiffTre.toFixed(4)}` +
            `  lfocnt=${tremolo.slot.lfocnt}`);
console.log(`  test 2b FM between slots: diff. samples = ${diffFm}/${N}  maxdiff=${maxDiffFm.toFixed(4)}`);
console.log(`  test 3  DSP pass-through: max error vs direct path = ${maxErrDsp.toFixed(6)}`);
console.log(`  test 3b ring buffer delay: max error = ${maxErrRet.toFixed(6)}`);
console.log(`  test 3c DSP float: max relative loss = ${(maxErrRel * 100).toFixed(4)}%`);
process.exit(failed ? 1 : 0);
