/**
 *    Name:         scsp-fidelity.mjs
 *    Description:  What the game asks of the SCSP and which of that we do NOT consume. Audits
 *                  the chip against the hardware, not against the game.
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// THE QUESTION (Sebas, 27-07-2026, translated): "the SCSP, is it emulated right at the hardware level, or only
// to the level of what we need?". The answer cannot come from reading the code: we have to see
// which registers the game TOUCHES and which of those the emulator reads and which it throws away.
//
// It answers four things, all checkable against how the hardware behaves:
//
//   A) COVERAGE OF THE COMMON REGISTERS ($400-$4FF). How many writes/reads each
//      register gets and whether the emulator CONSUMES it. A register with traffic and no consumption is a
//      piece the game programs and we ignore.
//   B) WHICH INTERRUPTS IT ENABLES (SCIEB/MCIEB), with the hardware's name for each bit. It matters
//      because bit 10 is one interrupt per sample (1 sample = 22.68 us = 1/44.1 kHz): if
//      a game uses it, the cadence at which we raise it stops being a detail.
//   C) THE CLOCK GRAIN. scspTick() is called per scheduler slice, not per sample,
//      and raises bit 10 ONCE PER CALL. Here the real histogram of samples
//      per call is measured, and how many pulses per second come out against the hardware's 44,100.
//   D) WHERE EACH SLOT COMES OUT. On the hardware, EFSDL/EFPAN (the DSP output level stage)
//      apply to EFREG and EXTS -the DSP's output-, NEVER to the raw output
//      of the slot. So a slot has exactly two paths to the DAC: DISDL/DIPAN
//      (direct) or ISEL/IMXL -> MIXS -> DSP -> EFREG. scsp.js:1403 adds a third one that the
//      hardware does not have ("if DISDL is muted, use EFSDL"), and this counts how many slots
//      depend on that shortcut -and how many of those are FM modulators, which on the hardware
//      are inaudible ON PURPOSE (another slot points to them through MDXSL/MDYSL and only the
//      carrier is heard).
//
// MANDATORY CONTROL (repo rule): run it also where the answer is known.
// Sega Rally sounds right, so its slots have to come out mostly through the direct
// path; if the control says ALL of them depend on the shortcut, the probe is wrong and nothing is
// reported.
//
// Usage: node diag/scsp-fidelity.mjs [game=rally] [frames=1800]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "1800", 10);
const SKIP = 600;   // boot frames that do not count (booting and loading)

const mod = await import("../headless.mjs?scspfid=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu, get68k } = mod;

// Common SCSP registers. VERIFIED addresses: SCILV0=$424, SCILV1=$426, SCILV2=$428 and
// MCIEB=$42A sit at fixed absolute addresses on the hardware, and the rest of the
// chain is derived backwards from there.
// `uses` = the emulator reads that field somewhere; `no` = it is written and nobody looks at it.
const REGS = {
	0x400: { n: "MEM4MB/DAC18B/VER/MVOL", uses: "MVOL", no: "MEM4MB, DAC18B, VER" },
	0x402: { n: "RBL/RBP (DSP ring)", uses: "all" },
	0x404: { n: "MOFULL/MOEMP/MIOVF/MIFULL/MIEMP/MIBUF (MIDI in)", no: "all" },
	0x406: { n: "MOBUF (MIDI out)", no: "all" },
	0x408: { n: "MSLC/CA (slot monitor)", uses: "all" },
	0x412: { n: "DMEA[15:1]", uses: "all" },
	0x414: { n: "DMEA[19:16]/DRGA", uses: "all" },
	0x416: { n: "DGATE/DDIR/DEXE/DTLG", uses: "all" },
	0x418: { n: "TACTL/TIMA", uses: "all" },
	0x41A: { n: "TBCTL/TIMB", uses: "all" },
	0x41C: { n: "TCCTL/TIMC", uses: "all" },
	0x41E: { n: "SCIEB", uses: "all" },
	0x420: { n: "SCIPD", uses: "all" },
	0x422: { n: "SCIRE", uses: "all" },
	0x424: { n: "SCILV0", uses: "all" },
	0x426: { n: "SCILV1", uses: "all" },
	0x428: { n: "SCILV2", uses: "all" },
	0x42A: { n: "MCIEB", uses: "all" },
	0x42C: { n: "MCIPD", uses: "all" },
	0x42E: { n: "MCIRE", uses: "all" }
};

// Regions above $4FF. They are grouped: listing 128 steps of the
// microprogram one by one clutters the report and says nothing the sum does not say.
const REGIONS = [
	{ a: 0x600, b: 0x67F, n: "SOUS (sound stack, 2 generations)", est: "output mirror only, once per block; the 68000 cannot WRITE it" },
	{ a: 0x700, b: 0x77F, n: "COEF (DSP coefficients)", est: "ok" },
	{ a: 0x780, b: 0x7BF, n: "MADRS (DSP addresses)", est: "ok" },
	{ a: 0x800, b: 0xBFF, n: "MPRO (DSP microprogram, 128 steps)", est: "ok, but they are reread by POLLING once per block, not on the write" },
	{ a: 0xC00, b: 0xC7F, n: "TEMP (DSP work buffer)", est: "NOT VISIBLE to the CPUs (neither read nor write)" },
	{ a: 0xE00, b: 0xE7F, n: "MEMS (DSP memory stack)", est: "NOT VISIBLE to the CPUs (neither read nor write)" },
	{ a: 0xE80, b: 0xEBF, n: "MIXS (DSP mix stack)", est: "NOT VISIBLE to the CPUs (neither read nor write)" },
	{ a: 0xEC0, b: 0xEDF, n: "EFREG (effects output)", est: "output mirror only, once per block" }
];
function region(off)
{
	for(const r of REGIONS) if(off >= r.a && off <= r.b) return r;
	return null;
}

// Why each interrupt is requested, one name per bit.
const INT_BITS = ["INT0N external", "INT1N external", "INT2N external", "MIDI in", "end of DMA",
	"CPU-requested", "Timer A", "Timer B", "Timer C", "MIDI out", "1 per SAMPLE (1Fs)"];

const MUTE_LEVEL = 31;   // scsp.js's "muted channel" sentinel

// ---- Instrumentation: the chip's three entry points are wrapped ----
const writes = new Map(), reads = new Map();
let sciebSeen = 0, mciebSeen = 0;
let ticks = 0, samplesTot = 0, tickMin = 1e9, tickMax = 0;
const histoTick = new Map();
let measuring = false;

const origScspWrite  = bus.scspWrite.bind(bus);
const readOrig = bus.scspRead.bind(bus);
const tickOrig = bus.scspTick.bind(bus);

// Who writes each region. The 68000 comes in through its memory interface (bus.scspWrite
// called from m68k.js) and the SH-2 through the bus's MMIO; they are told apart with a flag that
// is raised around the loop's m68k.run().
let inThe68k = false;
const perQuien = new Map();
function noteQuien(key)
{
	const k = key + (inThe68k ? " · 68k" : " · SH-2");
	perQuien.set(k, (perQuien.get(k) || 0) + 1);
}

// RAW addresses as they arrive, without masking. The 68000 comes in with its
// 24-bit address (m68k.js sends the whole `a` and scspWrite does the & 0xFFF), so here we can see whether
// an access landed on the register the game intended or whether it arrived through an ALIAS of a range that
// should not route to the SCSP.
const raw = new Map();

bus.scspWrite = function(off, val, size)
{
	const o = off & 0xFFF;
	if(measuring) raw.set(off >>> 0, (raw.get(off >>> 0) || 0) + 1);
	if(measuring && o >= 0x400)
	{
		const k = o & ~1;
		writes.set(k, (writes.get(k) || 0) + 1);
		const r = region(k);
		noteQuien(r ? r.n.split(" ")[0] : ("$" + k.toString(16)));
	}
	const r = origScspWrite(off, val, size);
	// The union of everything enabled throughout the run. It is read from the REGISTER after
	// writing, not from `val`: the 68000 writes byte by byte and looking at `val` lost the
	// two halves (first version of this probe: it gave "no interrupt enabled" on
	// Rally, which is impossible — the control is what catches it).
	if(measuring && o >= 0x41C && o < 0x422) sciebSeen |= ((bus.scspRam[0x41E] << 8) | bus.scspRam[0x41F]) & 0x7FF;
	if(measuring && o >= 0x428 && o < 0x42E) mciebSeen |= ((bus.scspRam[0x42A] << 8) | bus.scspRam[0x42B]) & 0x7FF;
	return r;
};

bus.scspRead = function(off, size)
{
	const o = off & 0xFFF;
	if(measuring && o >= 0x400)
	{
		const k = o & ~1;
		reads.set(k, (reads.get(k) || 0) + 1);
	}
	return readOrig(off, size);
};

bus.scspTick = function(samples)
{
	if(measuring)
	{
		ticks++;
		samplesTot += samples;
		if(samples < tickMin) tickMin = samples;
		if(samples > tickMax) tickMax = samples;
		histoTick.set(samples, (histoTick.get(samples) || 0) + 1);
	}
	return tickOrig(samples);
};

// ---- Boot ----
const bios = resolveBios({ xmen: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// Where each slot comes out, counted per frame in which it was playing.
const way = new Array(32).fill(null).map(() => ({ alive: 0, direct: 0, mixs: 0, onlyShortcut: 0, muteTotal: 0, isModulator: 0 }));
const left = new Float32Array(4096), right = new Float32Array(4096);
let frames = 0, framesWindow = 0;
// PROBE CONTROL: if the game is not playing sound, "no live slot" is not a finding,
// it means there is nothing to audit. The energy of the generated audio says so without opinions.
let peak = 0, sum2 = 0, samplesHeard = 0, framesWithSound = 0;
const withMdl = new Set();   // slots that at some point had MDL != 0 (context for D)
let wrapped68k = false;

// WITH INPUT (INPUT=1). Without pressing START the games do not get past attract mode and NONE turns on
// a slot: the three controls gave the SAME "slot 0 alive 448 frames, peak 0.4895", which is
// the BIOS jingle, not the game. Without input, D) has nothing to audit.
const START = 0x08;
for(let f = 0; f < FRAMES && !cpu.halted; f++)
{
	if(process.env.INPUT) bus.pad1a = (f % 30 < 6) ? (0xFF & ~START) : 0xFF;
	if(!wrapped68k)
	{
		const s = get68k();
		if(s){ const c = s.run.bind(s); s.run = (n) => { inThe68k = true; try{ return c(n); } finally{ inThe68k = false; } }; wrapped68k = true; }
	}
	runFrame();
	const m = bus.scspEngine;
	if(!m) continue;
	// The ring has to be drained during the warmup too: if it fills up, it overwrites and contaminates the rest.
	let peakFrame = 0;
	while(m.count > 0)
	{
		const n = Math.min(m.count, left.length);
		const read = m.readAudio(left, right, n);
		for(let k = 0; k < read; k++)
		{
			const a = Math.abs(left[k]), b = Math.abs(right[k]);
			const v = a > b ? a : b;
			if(v > peakFrame) peakFrame = v;
			sum2 += left[k] * left[k] + right[k] * right[k];
			samplesHeard += 2;
		}
	}
	if(peakFrame > peak) peak = peakFrame;
	if(peakFrame > 0.0005) framesWithSound++;
	if(f === SKIP - 1) measuring = true;
	if(measuring) framesWindow++;
	// D) is measured FROM BOOT: the first version measured it only after the warmup and
	// gave "no slot with an active envelope" on Rally, which plays sound. The jingles of the BIOS
	// and of the boot are part of what has to be audited.
	frames++;

	// Which slots ANOTHER slot references as an FM modulation source. MDXSL/MDYSL
	// are the slot number in the sound stack, and scsp.js resolves it as (mdx + i) & 0x1F.
	const modulators = new Set();
	for(let i = 0; i < 32; i++)
	{
		const s = m.slots[i];
		if(!s.mdl) continue;
		modulators.add((s.mdx + i) & 0x1F);
		modulators.add((s.mdy + i) & 0x1F);
	}

	for(let i = 0; i < 32; i++)
	{
		const s = m.slots[i];
		if(s.ecnt >= 0x1FFFFF) continue;         // SCSP_ENV_DE: slot off
		const v = way[i];
		v.alive++;
		// CAREFUL: the fields are directGainLeft/directGainRight/gainEfLeft/gainEfRight since the gains
		// refactor of 27-07-2026. Before, they were disll/dislr/efsll/efslr and this probe kept
		// looking at the old ones: since they did not exist they gave undefined, "undefined !== 31" is TRUE and
		// so hasDirect was ALWAYS true, which means onlyShortcut always gave 0. The number
		// "5 of 32 slots" that was reported is from BEFORE the refactor.
		const hasDirect = !!(s.directGainLeft || s.directGainRight);
		const hasMixs    = (s.imxl !== MUTE_LEVEL);
		const hasEffect  = !!(s.gainEfLeft || s.gainEfRight);
		if(hasDirect) v.direct++;
		if(hasMixs) v.mixs++;
		if(!hasDirect && !hasMixs)
		{
			if(hasEffect)
			{
				v.onlyShortcut++;
				// CAREFUL, LIMIT OF THE PROBE: this does NOT discriminate on its own. If many slots
				// carry MDL != 0, between all of them they end up pointing at almost all 32 (and with
				// MDXSL = 0 a slot points at itself, which is the legitimate self-feedback
				// path). It is only worth looking at WITHIN the ones that use the shortcut:
				// there it does say "this one would not sound on the hardware because it is a modulator".
				if(modulators.has(i)) v.isModulator++;
			}
			else v.muteTotal++;
		}
		if(s.mdl) withMdl.add(i);
	}
}

// ---- Report ----
const p = (x) => x.toLocaleString("es");
console.log("=== SCSP: fidelity against the hardware — " + GAME + " (" + p(frames) + " frames measured) ===");

console.log("\nA) COMMON REGISTERS ($400-$4FF): traffic versus consumption");
const touched = new Set([...writes.keys(), ...reads.keys()]);
const common = [...touched].filter(o => o < 0x500).sort((a, b) => a - b);
if(!common.length) console.log("   (none: the game did not touch the common registers in this window)");
for(const off of common)
{
	const r = REGS[off];
	const e = writes.get(off) || 0, l = reads.get(off) || 0;
	const name = r ? r.n : "(not defined in the hardware map)";
	let state;
	if(!r) state = "UNDEFINED";
	else if(r.no && !r.uses) state = "IGNORED BY THE EMULATOR";
	else if(r.no) state = "partial — unused: " + r.no;
	else state = "ok";
	console.log("   $" + off.toString(16).toUpperCase().padStart(3, "0") +
		"  esc " + String(p(e)).padStart(9) + "  reads " + String(p(l)).padStart(9) +
		"  " + name.padEnd(46) + " [" + state + "]");
}

console.log("\nA2) REST OF THE MAP (SOUS and DSP), aggregated by region");
for(const r of REGIONS)
{
	let e = 0, l = 0;
	for(const [o, c] of writes) if(o >= r.a && o <= r.b) e += c;
	for(const [o, c] of reads)   if(o >= r.a && o <= r.b) l += c;
	if(!e && !l) continue;
	console.log("   $" + r.a.toString(16).toUpperCase() + "-$" + r.b.toString(16).toUpperCase() +
		"  esc " + String(p(e)).padStart(9) + "  reads " + String(p(l)).padStart(9) +
		"  " + r.n.padEnd(42) + " [" + r.est + "]");
}
const orphans = [...touched].filter(o => o >= 0x500 && !region(o));
if(orphans.length) console.log("   outside any known map: " + orphans.map(o => "$" + o.toString(16)).join(" "));

console.log("\nA3) RAW write ADDRESSES (unmasked), top 10");
{
	const tot = [...raw.values()].reduce((a, b) => a + b, 0);
	const outside = [...raw.entries()].filter(([a]) => (a >>> 0) > 0x100FFF).reduce((s, [, c]) => s + c, 0);
	for(const [a, c] of [...raw.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10))
		console.log("   0x" + (a >>> 0).toString(16).padStart(6, "0") + "  x" + p(c));
	console.log("   total " + p(tot) + "   ·   outside 0x100000-0x100FFF (the hardware range): " +
		p(outside) + " (" + (tot ? (outside * 100 / tot).toFixed(1) : 0) + "%)");
}

console.log("\nB) INTERRUPTS ENABLED (union over the run)");
const list = (m) => INT_BITS.map((n, i) => (m & (1 << i)) ? ("b" + i + " " + n) : null).filter(Boolean);
console.log("   SCIEB (to 68k):  " + (sciebSeen ? list(sciebSeen).join(" · ") : "none"));
console.log("   MCIEB (to SH-2): " + (mciebSeen ? list(mciebSeen).join(" · ") : "none"));
console.log("   " + ((sciebSeen | mciebSeen) & 0x400
	? "USES BIT 10 (1 per sample): the cadence from C) hits it in full."
	: "does not use bit 10 (1 per sample)."));

console.log("\nB2) WHO WRITES (sound 68000 versus SH-2), top 12");
for(const [k, v] of [...perQuien.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
	console.log("   " + k.padEnd(24) + " " + String(p(v)).padStart(11));

console.log("\nC) GRAIN AT WHICH THE 68000 CAN OBSERVE THE SCSP");
const perFrame = framesWindow ? ticks / framesWindow : 0;
const observPerSec = perFrame * 59.94;
console.log("   calls to scspTick:     " + p(ticks) + "  (" + perFrame.toFixed(1) + " per frame)");
console.log("   samples per call:      min " + (tickMin === 1e9 ? "-" : tickMin) + "  max " + tickMax +
	"  promedio " + (ticks ? (samplesTot / ticks).toFixed(2) : "-"));
// CAREFUL WITH WHAT THIS LINE MEASURES. Bit 10 of SCIPD (one interrupt per sample)
// is ALREADY raised per sample since 27-07-2026, so the pulses are 44,100/s and
// that is not what is counted here. What is counted are the CALLS: the 68000 runs between
// blocks, so it can only SEE a change in the chip every 2-3 samples. Before, this line
// said "bit 10 pulses" and, with the flag already fixed, it would have reported a nonexistent bug.
console.log("   the 68000 observes the chip " + p(Math.round(observPerSec)) + " times/s, that is every " +
	(observPerSec ? (44100 / observPerSec).toFixed(1) : "-") + " samples");
const hist = [...histoTick.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log("   histogram (samples/call -> times): " + hist.map(([k, v]) => k + "->" + p(v)).join("  "));

console.log("\nD) WHERE EACH SLOT COMES OUT (on the hardware EFSDL/EFPAN belong to EFREG/EXTS, not to the slot)");
const rms = samplesHeard ? Math.sqrt(sum2 / samplesHeard) : 0;
console.log("   CONTROL — is anything playing?  peak " + peak.toFixed(4) + "   RMS " + rms.toFixed(5) +
	"   frames with sound " + p(framesWithSound) + "/" + p(frames) +
	(peak < 0.0005 ? "   <- TOTAL SILENCE: D cannot answer anything" : ""));
let totShortcut = 0, totModul = 0, rows = 0;
for(let i = 0; i < 32; i++)
{
	const v = way[i];
	if(!v.alive) continue;
	rows++;
	if(v.onlyShortcut) totShortcut++;
	if(v.isModulator) totModul++;
	const pct = (x) => (v.alive ? (x * 100 / v.alive).toFixed(0) : "0").padStart(3) + "%";
	console.log("   slot " + String(i).padStart(2) + "  alive " + String(p(v.alive)).padStart(7) +
		" frames  |  direct " + pct(v.direct) + "  MIXS " + pct(v.mixs) +
		"  SHORTCUT-ONLY " + pct(v.onlyShortcut) + "  mute " + pct(v.muteTotal) +
		(v.onlyShortcut && v.isModulator ? "   <- and on top of that an MDXSL/MDYSL points to it" : ""));
}
if(!rows) console.log("   (no slot with an active envelope in the measured window)");
console.log("\n   slots that depend on the invented path: " + totShortcut + " of " + rows +
	"   ·   of those, pointed to as FM modulators: " + totModul +
	"   ·   slots with MDL!=0 at some point: " + withMdl.size + "/32");
