/**
 *    Name:         headless.mjs
 *    Description:  HEADLESS Node harness for the HTMLSATURN emulator: boots a game
 *                  (BIOS + CUE/BIN disc), runs frames without a browser and dumps the
 *                  internal state (SH-2 master/slave, SCU IRQs, IMR, VDP2) to a JSON.
 *                  Ports the orchestration of index.html (reset / loadDisc /
 *                  runFrame / correrInterleaved / stepsBlock) WITHOUT touching the chips.
 *                  Usage:  node headless.mjs [game] [frames] [bios]
 *                    game   = "xmen" | "rally" | path to a folder with .cue+.bin
 *                    frames = cap on frames to run (default 4000)
 *                    bios   = "eur"|"us"|"jp"|... or path to a .bin (default: the disc's
 *                             native region -> xmen=jp, rally=us)
 *                  X-Men (Japanese disc) reaches the documented hang ONLY with the jp BIOS;
 *                  with EUR/US it boots but takes another path and stays on the title.
 *    Version:      0.1.0
 *    Created:      17-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, basename } from "path";

const ROOT = dirname(fileURLToPath(import.meta.url));

// ============================================================================
//   Browser STUBS. The orchestration we port does NOT use rAF or the UI,
//   but we leave performance in case some chip touched it (none does today).
// ============================================================================
if(typeof globalThis.performance === "undefined")
	globalThis.performance = { now: () => Date.now() };

// ============================================================================
//   LOADING THE CHIPS. Same order as the <script> tags of index.html. They are browser
//   scripts (global classes): they are loaded with eval and published on globalThis,
//   just as the *.test.mjs do (see vdp1.test.mjs / cd.test.mjs as the template).
//   Each chip refers to the previous ones as free variables (typeof ScspEngine,
//   etc.): being on globalThis they resolve as properties of the global object.
// ============================================================================
function loadChip(file, ...names)
{
	const code = readFileSync(join(ROOT, file), "utf8");
	const publish = names.map(n => "globalThis." + n + "=" + n + ";").join("");
	// direct eval: the classes stay in the eval's scope and the tail copies them to
	// globalThis. In Node ESM (strict) this does not leak the classes by itself, hence the tail.
	eval(code + "\n" + publish);
}

loadChip("scheduler.js", "Scheduler", "EV_HBLANK_IN", "EV_VBLANK_IN", "EV_VBLANK_OUT", "EV_CD_SECTOR");
loadChip("scsp.js", "ScspEngine");
loadChip("cd.js", "CdReader");
loadChip("cart.js", "Cartridge");
loadChip("scu.js", "ScuDspEngine");
loadChip("bus.js", "Bus");
loadChip("sh2.js", "SH2");
loadChip("vdp2.js", "VDP2");
loadChip("vdp1.js", "VDP1");
loadChip("m68k.js", "M68K");
loadChip("vendor/estyjs-processor.js");   // the 68k uses it from m68k.js through its global
loadChip("disasm.js", "disassemble");    // to dump the loops of the hang as opcodes

// ============================================================================
//   GLOBAL STATE AND TIMING CONSTANTS (ported from index.html as is).
// ============================================================================
const bus = new Bus();
bus.logging = false;               // no console spam; we measure the state by hand
// The system master clock. It is connected to the bus so that the beam position (line,
// HBLANK, HCNT/VCNT) comes from IT and not from the master CPU's cycle counter.
const plan = new Scheduler();
bus.connectScheduler(plan);
let cpu = new SH2(bus, "master");
bus.connectCpu(cpu);
plan.connectCpu(cpu);   // its progress interpolates the clock within each segment
let cpuSlave = new SH2(bus, "slave");
bus.connectCpuSlave(cpuSlave);
const vdp2 = new VDP2(bus);
const vdp1 = new VDP1(bus);
let cfgVideo = null;
let biosLoaded = false;
let m68k = null;
let framesEmulated = 0;

const HISTORY_PC_SIZE = 64;
const pcHistory = new Uint32Array(HISTORY_PC_SIZE);
let historyPcWritten = 0;

const HZ_AUDIO = 44100;
const HZ_M68K = HZ_AUDIO * 256;
const REGIONS = {
	ntsc: { name: "NTSC", fps: 60000 / 1001, cyclesPerFrame: 447443, lines: 262, vertical: 224 },
	pal:  { name: "PAL",  fps: 50,           cyclesPerFrame: 537482, lines: 313, vertical: 240 }
};
for(const r of Object.values(REGIONS))
{
	r.samplesPerFrame  = HZ_AUDIO / r.fps;
	r.cycles68kPerFrame = HZ_M68K / r.fps;
}
function currentRegion(){ return bus.isPal() ? REGIONS.pal : REGIONS.ntsc; }

// The two frame "phases" and the fixed chunk went away on 25-07-2026, with the event
// scheduler: the frame is no longer split into magic fractions (400000/446880) or into chunks
// of 1700 cycles, but into the REAL hardware events, each one on its cycle.
const CD_SECTORS_PER_SEC = 150;   // in bus.js it is a script const; the orchestration needs it here
let remainderSamples = 0;
let remainder68k = 0;

// ============================================================================
//   ORCHESTRATION PORTED FROM index.html (without the UI). Faithful copies of:
//   stepsBlock / correrInterleaved / runFrame / reset.
// ============================================================================
function lastPc(n)
{
	const total = historyPcWritten;
	if(n > total) n = total;
	if(n > HISTORY_PC_SIZE) n = HISTORY_PC_SIZE;
	const output = new Array(n);
	for(let k = 0; k < n; k++)
		output[k] = pcHistory[(total - n + k) & (HISTORY_PC_SIZE - 1)];
	return output;
}

function stepsBlock(n)
{
	cpu.idle = false; if(cpuSlave) cpuSlave.idle = false;   // re-evaluate idle every chunk: the other CPU/DMA may have touched the polled memory
	const h = pcHistory, mask = HISTORY_PC_SIZE - 1;
	let e = historyPcWritten;
	// By CYCLES, not by steps (faithful copy of index.html: see the long comment there).
	// It is counted RELATIVE: the cycle counter goes back to zero on cpu.reset(), and against an
	// absolute target that reset left the while spinning. The `d <= 0` covers the CPU
	// asleep (SLEEP, it consumes no cycles) and the reset.
	let spentM = 0;
	while(spentM < n && !cpu.halted)
	{
		// Dry jump (see SH2.runDry): 58-74% of the steps are idle-skip, i.e.
		// iterations that only make time pass. They are charged in one go up to the cycle before
		// the next timer event, without changing anything of what happens.
		if(cpu.idle || cpu.sleeping)
		{
			const jump = cpu.runDry(n - spentM);
			if(jump > 0){ spentM += jump; continue; }
		}
		h[e++ & mask] = cpu.pc >>> 0;
		const before = cpu.cycles;
		cpu.step();
		const d = cpu.cycles - before;
		spentM += d > 0 ? d : 1;
	}
	historyPcWritten = e;
	if(bus.smpcSlaveOn && cpuSlave)
	{
		let spentS = 0;
		while(spentS < n && !cpuSlave.halted)
		{
			if(cpuSlave.idle || cpuSlave.sleeping)
			{
				const jump = cpuSlave.runDry(n - spentS);
				if(jump > 0){ spentS += jump; continue; }
			}
			const before = cpuSlave.cycles;
			cpuSlave.step();
			const d = cpuSlave.cycles - before;
			spentS += d > 0 ? d : 1;
		}
	}
}

// Advances the chips that do NOT need cycle precision -the sound 68k, the SCSP and the
// CD reader- by their share of the SH-2's `cycles`. It is "catch-up": they are brought up to
// date every time the CPU stops at an event, instead of running them on their own
// event. One event per audio sample would be 735 per frame, more cuts than the 281
// chunks we came here precisely to remove; and audio does not depend on the exact cycle.
//
// The fractional accumulators (remainderSamples, remainder68k, and the internal cd.accum) make sure
// nothing is lost between segments: it is the same reason they existed before.
function advancePeripherals(cycles)
{
	if(cycles <= 0) return;
	const region = currentRegion();
	const cpf = region.cyclesPerFrame;

	remainderSamples += cycles * region.samplesPerFrame / cpf;
	const samples = Math.floor(remainderSamples);
	remainderSamples -= samples;

	remainder68k += cycles * region.cycles68kPerFrame / cpf;
	const cycles68k = Math.floor(remainder68k);
	remainder68k -= cycles68k;

	// The CD delivers SPREAD OUT over time (one sector every ~6.67 ms on the real HW), not in a
	// burst: in a burst, 2-3 sectors arrived TOGETHER at the frame edge and the games'
	// sequencer saw impossible states at the end of a stream.
	bus.cdTick(cycles * (CD_SECTORS_PER_SEC / region.fps) / cpf);
	bus.smpcTick(cycles);   // the SMPC command takes time: see bus.smpcTick

	// THE SCSP ALWAYS RUNS, whether or not the sound 68000 is on. On power-up
	// the SMPC first releases the reset of the SCSP -the sound system
	// operates once the SMPC has released the SCSP reset- and only afterwards, with
	// the driver already downloaded, it resets the 68000 so that it starts (once the download has finished,
	// the SMPC resets the sound CPU, which enables it to operate). That is, SNDON/
	// SNDOFF gate the CPU, not the chip.
	// Hanging it off the 68k left MUTE everything the SCSP does on its own: the envelopes in progress
	// froze and CD audio -which comes in through EXTS and does not go through the 68000- did not play.
	// The SCSP's internal DMA steals memory cycles from the 68000, which executes from the sound
	// RAM: while it runs, the sound CPU advances less.
	const withSound = !!(m68k && bus.smpcSoundOn);
	if(withSound && bus.scsp.dmaRemaining > 0)
		cycles68k = Math.floor(cycles68k * (1 - bus.scsp.dmaFrac));

	const run68k = (c) => {
		if(!withSound || !m68k) return;
		try{ m68k.run(c); }
		catch(e){ console.error("HEADLESS: the sound 68k failed, it is disabled:", e.message); m68k = null; m68kDied = true; }
	};

	// ✖ DEAD HYPOTHESIS (27-07-2026): interleaving the SCSP and the 68000 PER SAMPLE.
	// The idea was to give the sound CPU the resolution the chip asks for -the timers and bit 10
	// of SCIPD, one interrupt per sample (1 sample = 22.68 us), change at
	// 44,100 Hz, and advancing the whole segment in one go the 68000 only sees the state every 2-3
	// samples-. The cost was measured and it was cheap: diag/bench-audio.mjs gave 18.21 -> 19.95
	// ms per second of audio with grain 1, i.e. +0.03 ms per 16.68 ms frame.
	// BUT IT BROKE SEGA RALLY: `health.mjs` dropped it from 80% image and 230 colors to 28% and
	// 144, which is exactly where it was before the SCSP always ran. The rest of
	// the 10 games did not move. It was not investigated further: the repo's rule is to first remove the
	// change that breaks something that worked. It is noted that Rally is sensitive to the ORDER in which
	// the cycles are handed to the 68000, not only to how many.
	bus.scspTick(samples);
	run68k(cycles68k);
}

// Dispatches a scheduler event. It is the only place where WHAT happens at each
// moment of the frame is decided; the WHEN belongs to the scheduler.
function dispatchEvent(ev)
{
	switch(ev)
	{
		case EV_HBLANK_IN:
			plan.nextLine();
			bus.hblankIn();
			break;
		case EV_VBLANK_OUT:
			// The vertical retrace ended: the active display comes back.
			bus.vblankOut();
			break;
	}
}

// ONE FRAME, BY EVENTS.
//
// Replaces correrInterleaved and the two "phases" with their magic fractions
// (FRAC_CICLOS_FASE_LARGA = 400000/446880). Now the CPU runs from event to event and each
// event lands on ITS cycle, taken from the real geometry of the frame.
//
// Along the way it fixes something that was gross: with the phases, VBlank lasted 89.5% of the
// frame (vblankIn started the frame and vblankOut only arrived after the long phase).
// On the hardware it is 38 lines out of 262 = 14.5%, and now it comes from there: the frame starts in
// active display (VBlank-OUT) and enters VBlank on reaching line 224.
function runFrame()
{
	if(bus.reset68k)
	{
		bus.reset68k = false;
		try{ if(!m68k) m68k = new M68K(bus); m68k.reset(); }
		catch(e){ console.error("HEADLESS: the sound 68k failed to start:", e.message); m68k = null; m68kDied = true; }
	}
	const region = currentRegion();

	// Starts the frame: leaves VBlank and the video events of this frame are scheduled.
	// The frame STARTS at VBlank-IN (see Scheduler.bootFrame): it is the tick the games
	// sync to, and it leaves the whole frame ahead for their work.
	bus.vblankIn();
	// The VISIBLE lines come from the TVMD's VRESO, not from a per-region constant: with 240
	// or 256 the V blank lasts less and VBlank-OUT lands earlier. See bus.linesVisibleTv().
	plan.bootFrame(region.cyclesPerFrame, region.lines, bus.linesVisibleTv());
	const frameEnd = plan.cycle + region.cyclesPerFrame;

	while(plan.cycle < frameEnd && !cpu.halted)
	{
		// The CPU runs in one go up to the next event. That segment is what used to be
		// a fixed chunk of 1700 cycles, but now its length is decided by the HARDWARE (when
		// the next line is due, the next VBlank...), not by a constant.
		const until = Math.min(plan.nextCycle(), frameEnd);
		const segment = until - plan.cycle;
		if(segment > 0)
		{
			// markSegment: while the CPU runs, beam position queries
			// interpolate with its progress (see Scheduler.cycleAlive). Without this the clock
			// stays frozen at the edge during the whole line.
			plan.markSegment();
			stepsBlock(segment);
			advancePeripherals(segment);
			plan.cycle = until;
		}
		let ev;
		while((ev = plan.takeExpired()) !== -1) dispatchEvent(ev);
	}
	// If the CPU ended up halted, the system clock carries on the same: time does not stop
	// because a chip hangs. That is exactly what did not happen when the clock was
	// cpuMaster.cycles.
	if(plan.cycle < frameEnd){ advancePeripherals(frameEnd - plan.cycle); plan.cycle = frameEnd; }

	// THE VDP1 PLOT GOES AT THE END OF THE FRAME, not at the VBlank-IN event.
	//
	// It looks more faithful to put it at VBlank-IN -that is when the real chip starts drawing
	// with PTMR=2- but it breaks: the VBlank-IN IRQ gets QUEUED, the game's handler runs
	// afterwards, and the game requests the plot (writes PTMR) INSIDE that handler. Plotting at
	// the same instant as VBlank-IN, the plot runs BEFORE the request and lags a whole
	// frame. Measured on 25-07-2026: with the plot at VBlank-IN SF Alpha falls into the
	// BootROM (PC 0x2000056c) at ~750 frames; at the end of the frame, it keeps running.
	// Here the game has already had the whole VBlank to request it, which is the window it uses.
	if(biosLoaded && !cfgVideo){ vdp2.configureResolution(); vdp1.plot(); }

	bus.cdPeriodic();
	bus.rtcTick();
	framesEmulated++;
}

let m68kDied = false;

// reset() from index.html, without setRunUI/refresh.
function reset()
{
	cpu = new SH2(bus, "master");
	bus.connectCpu(cpu);
	// The scheduler interpolates its clock with the progress of THIS CPU: if it is not reconnected,
	// it keeps the old object -which no longer runs- and the clock stops advancing within the
	// segment. It is the same trap the probes have documented ("do not destructure
	// cpu/cpuSlave: reset() reassigns them").
	plan.connectCpu(cpu);
	cpuSlave = new SH2(bus, "slave");
	bus.connectCpuSlave(cpuSlave);
	bus.smpcSlaveOn = false;
	bus.resetCdBlock();
	if(biosLoaded){ cpu.reset(); cpuSlave.reset(); }
	historyPcWritten = 0;
	if(bus.scspEngine) bus.scspEngine.reset();
}

// applyBios() from index.html, without the UI.
function applyBios(name, data)
{
	bus.loadBios(data, name);
	biosLoaded = true;
	reset();
}

// loadDisc() from index.html, adapted to files from the Node filesystem.
// folder = the game's directory; the .cue lists the .bin files that are read from there.
function loadDiscFromCue(path)
{
	// ACCEPTS A FOLDER OR A LOOSE FILE (.cue/.iso/.bin/.img). It used to be folders only:
	// a game saved as "X-Men vs. Street Fighter (Japan).cue" + its .bin next to it
	// threw "ENOTDIR: not a directory" and NO probe could mount it (26-07-2026,
	// Sebas asked for all the Japanese games to boot). With a file we work
	// on its containing folder, which is where the .bin files the cue references live.
	let folder = path;
	try { if(!statSync(path).isDirectory()) folder = dirname(path); }
	catch(e){ /* if it does not exist, let it fail below with the usual message */ }
	const files = readdirSync(folder);
	// If we were given a specific .cue, IT IS THAT ONE. If we were given a folder, the first one there is.
	const cueName = (path !== folder && /\.cue$/i.test(path))
		? basename(path)
		: files.find(n => /\.cue$/i.test(n));
	const reader = new CdReader();
	let ok = false;

	if(cueName)
	{
		const text = readFileSync(join(folder, cueName), "utf8");
		const requests = CdReader.filesOfCue(text);
		// Map name->bytes, resolving each .bin relative to the game's folder.
		const available = new Map();
		for(const n of files) available.set(n.toLowerCase(), n);
		const mapOfBins = {};
		for(const n of requests)
		{
			const real = available.get(n.toLowerCase());
			if(!real) throw new Error("The .bin the cue asks for is missing: " + n);
			mapOfBins[n] = new Uint8Array(readFileSync(join(folder, real)));
		}
		ok = reader.loadCue(text, mapOfBins);
	}
	else
	{
		// No cue: first loose .iso/.bin/.img.
		const loose = files.find(n => /\.(iso|bin|img)$/i.test(n));
		if(!loose) throw new Error("The folder has no .cue or .iso/.bin/.img: " + folder);
		ok = reader.loadImage(new Uint8Array(readFileSync(join(folder, loose))), loose);
	}

	if(!ok || !bus.mountDisc(reader))
		throw new Error("Could not mount the disc (image without readable tracks)");

	const info = reader.info() || {};
	const cartType = Cartridge.typeForSerial(info.productNumber);
	bus.putCartridge(cartType === Cartridge.NONE ? null : new Cartridge(cartType));
	return reader;
}

// ============================================================================
//   STATE DUMP
// ============================================================================
const hex = (v, width) => "0x" + ((v >>> 0).toString(16).padStart(width || 0, "0"));
const bin32 = (v) => (v >>> 0).toString(2).padStart(32, "0");

// VDP2 TVMD (reg 0x00). DISP bit = 0x8000.
function tvmd(){ return vdp2._r(0x00) >>> 0; }
function bgon(){ return vdp2._r(0x20) >>> 0; }

// SCU IMR (mask) and IST (status): 32-bit big-endian registers.
function scuImr(){ return bus._readRegBE(bus.scuRegs, 0xA0, 4) >>> 0; }
function scuIst(){ return bus._readRegBE(bus.scuRegs, 0xA4, 4) >>> 0; }

// Translates an SCU bit mask into the list of interrupts it represents.
function namesScu(mask)
{
	const NAME = {
		0: "VBlank-IN", 1: "VBlank-OUT", 2: "HBlank-IN", 3: "Timer0", 4: "Timer1",
		5: "DSP-End", 6: "Sound-Request", 7: "System-Manager(SMPC)", 8: "PAD",
		9: "L2-DMA-End", 10: "L1-DMA-End", 11: "L0-DMA-End", 12: "DMA-illegal",
		13: "Sprite-Draw-End(VDP1)", 16: "CD-block"
	};
	const output = [];
	for(let b = 0; b < 32; b++)
		if(mask & (1 << b)) output.push({ bit: b, name: NAME[b] || ("bit" + b) });
	return output;
}

// histPc ring of an SH-2 (16 PCs, the oldest at histIdx), from oldest to newest.
function histPcSorted(sh2)
{
	const out = [];
	for(let k = 0; k < 16; k++)
		out.push(hex(sh2.histPc[(sh2.histIdx + k) & 15] >>> 0, 8));
	return out;
}

// Disassembles a window of memory around an address (to see the loop of the
// hang as opcodes, not just as PCs). It reads from the real bus, so it shows what
// the CPU is executing right now (including "0x0000" = zeros = jump into nowhere).
function disasmWindow(center, beforeW, afterW)
{
	const out = [];
	const start = (center - beforeW * 2) >>> 0;
	for(let i = 0; i < beforeW + afterW; i++)
	{
		const a = (start + i * 2) >>> 0;
		let op = -1;
		try{ op = bus.readWord(a) & 0xFFFF; }catch(e){ op = -1; }
		const ins = (op >= 0 && typeof disassemble === "function") ? disassemble(op, a) : "?";
		out.push((a === (center >>> 0) ? "> " : "  ") + hex(a, 8) + "  " + (op >= 0 ? hex(op, 4) : "ERR") + "  " + ins);
	}
	return out;
}

// Resolves the PC-relative operands (MOV.L/MOV.W @(disp,PC),Rn) of a window of
// code: it says WHICH address each literal points to and what value it has. With this we name
// the mailbox the master polls (the pointer loaded in Rn and the byte it points to).
function resolveLiteralesPC(center, beforeW, afterW)
{
	const out = [];
	const start = (center - beforeW * 2) >>> 0;
	for(let i = 0; i < beforeW + afterW; i++)
	{
		const pc = (start + i * 2) >>> 0;
		let op = -1;
		try{ op = bus.readWord(pc) & 0xFFFF; }catch(e){ continue; }
		const height = (op >> 12) & 0xF, reg = (op >> 8) & 0xF, kk = op & 0xFF;
		if(height === 0xD)   // MOV.L @(disp,PC),Rn
		{
			const ea = (((pc & ~3) >>> 0) + 4 + kk * 4) >>> 0;
			const val = bus.readLong(ea) >>> 0;
			let bytePoints = null;
			try{ bytePoints = bus.readByte(val) & 0xFF; }catch(e){}
			out.push({ pc: hex(pc, 8), ins: "MOV.L @(PC),R" + reg, literalIn: hex(ea, 8), R: reg, value: hex(val, 8),
				byteInThatPointer: bytePoints === null ? "?" : hex(bytePoints, 2) });
		}
		else if(height === 0x9)   // MOV.W @(disp,PC),Rn
		{
			const ea = ((pc + 4 + kk * 2)) >>> 0;
			const val = bus.readWord(ea) & 0xFFFF;
			out.push({ pc: hex(pc, 8), ins: "MOV.W @(PC),R" + reg, literalIn: hex(ea, 8), R: reg, value: hex(val, 4) });
		}
	}
	return out;
}

function dumpState(reason, extra)
{
	const imr = scuImr(), ist = scuIst(), pending = bus.scuPending >>> 0;
	// Interrupts latched but blocked by the IMR: that is what the game
	// would be waiting to unmask. And the ones that were not even generated.
	const pendingMasked = pending & imr;

	const d = {
		reason,
		reasonHang: extra.reasonHang,
		game: extra.game,
		region: currentRegion().name,
		frames: framesEmulated,
		booted: {
			tvmdSawDisp: extra.tvmdSawDisp,
			cyclesMaster: cpu.cycles,
			cyclesMasterPeak: extra.cyclesPeak
		},
		tvmd: { value: hex(tvmd(), 4), disp: (tvmd() & 0x8000) ? 1 : 0, bgon: hex(bgon(), 4) },
		master: {
			pc: hex(cpu.pc, 8),
			sr: hex(cpu.sr, 8),
			imask: (cpu.sr >> 4) & 0xF,
			pr: hex(cpu.pr, 8),
			vbr: hex(cpu.vbr, 8),
			halted: cpu.halted,
			sleeping: cpu.sleeping,
			irqPending: cpu.irqPending.map(q => ({ level: q.level, vector: hex(q.vector, 2) })),
			last16Pc: lastPc(16).map(p => hex(p, 8)),
			disasmLoop: disasmWindow(cpu.pc >>> 0, 6, 6),
			literalesPC: resolveLiteralesPC(cpu.pc >>> 0, 8, 8)
		},
		slave: {
			on: bus.smpcSlaveOn,
			pc: hex(cpuSlave.pc, 8),
			pr: hex(cpuSlave.pr, 8),
			sr: hex(cpuSlave.sr, 8),
			halted: cpuSlave.halted,
			sleeping: cpuSlave.sleeping,
			cycles: cpuSlave.cycles,
			histPc: cpuSlave.tracing ? histPcSorted(cpuSlave) : "tracing not enabled",
			disasmCrash: disasmWindow(cpuSlave.pc >>> 0, 6, 6),
			disasmLoop: cpuSlave.tracing ? disasmWindow(cpuSlave.histPc[cpuSlave.histIdx] >>> 0, 4, 10) : "tracing not enabled"
		},
		scu: {
			imr: { hex: hex(imr, 8), bin: bin32(imr), masked: namesScu(imr) },
			ist: { hex: hex(ist, 8), bin: bin32(ist), active: namesScu(ist) },
			scuPending: { hex: hex(pending, 8), bin: bin32(pending), latched: namesScu(pending) },
			pendingBlockedPerImr: namesScu(pendingMasked),
			smpcSoundOn: bus.smpcSoundOn
		},
		m68k: { instantiated: !!m68k, died: m68kDied },
		cd: extra.cd
	};
	return d;
}

// CD block state for the dump.
function cdState()
{
	const cd = bus.cd;
	if(!cd) return { mounted: false };
	const AUTH = { 0x00: "not authenticated", 0x01: "audio CD", 0x02: "non-Saturn data", 0x04: "valid Saturn", 0xFF: "authenticating" };
	return {
		mounted: true,
		authType: hex(cd.authType || 0, 2),
		authName: AUTH[cd.authType] || "?",
		status: hex(cd.pos.status & 0xFF, 2),
		fad: cd.pos.fad,
		phase: cd.phase
	};
}

// ============================================================================
//   MAIN PROGRAM
// ============================================================================
const GAMES = {
	xmen:  "roms/X-Men - Children of the Atom (Japan)",
	rally: "roms/Sega Rally Championship Plus Netlink Edition (USA)",
	sfa:   "roms/Street Fighter Alpha - Warriors Dreams (USA)",
	sonic: "roms/Sonic 3D Blast (USA)",
	vc:    "roms/Virtua Cop (USA) (7S)",
	// Added on 25-07-2026: Sebas reported that both come out with the wrong output
	// resolution. Without an entry here, the multi-game probes could not even mount them.
	daytona: "roms/Daytona USA (USA)",
	daycce:  "roms/Daytona USA C.C.E. Net Link Edition (USA)",
	touring: "roms/Sega Touring Car Championship (USA)",
	vf2:     "roms/Virtua Fighter 2 (Japan) (Rev C) (42M)",
	// 26-07-2026: Sebas asked for ALL the Japanese games to boot. This one was not
	// registered, so no multi-game probe could mount it.
	xmenvs:  "roms/X-Men vs. Street Fighter (Japan) (1M).cue"
};
const BIOSES = {
	eur: "bios/Sega Saturn BIOS (EUR).bin",
	us:  "bios/Bios Saturn 1.01a (U) [!].bin",
	uses: "bios/Bios Saturn 1.01a (U) [!].bin",
	us100: "bios/Bios Saturn 1.00a (U) [!].bin",
	jp:  "bios/Bios Saturn 1.00 (J) [!].bin",
	jp101: "bios/Bios Saturn 1.01 (J) [!].bin"
};

function resolveBios(key)
{
	if(!key) key = "eur";
	const path = BIOSES[key] ? join(ROOT, BIOSES[key]) : (key.includes("/") || key.includes("\\") ? key : join(ROOT, "bios", key));
	return path;
}
// WHICH BIOS A DISC GETS, by the region IT declares in its header
// (offset 0x40, the JTUBKAEL symbols). It comes from here and not from a hand-made list per game:
// that list only had X-Men, so Virtua Fighter 2 -which is Japanese (JT)- had
// been tested with the AMERICAN BIOS, and any new game came in wrong by omission.
// Asked by Sebas (26-07-2026, translated): "from general to specific".
//
// Priority: if the disc accepts USA, the US one is used (it is the project's reference
// console and the most tested dump). If not, Japanese, and if not, European.
//ok, 26-07-2026
function biosForDisc(reader)
{
	const r = (reader && reader.info && reader.info() ? reader.info().region : "") || "";
	if(r.includes("U")) return "us";
	if(r.includes("J")) return "jp";
	if(r.includes("E")) return "eur";
	return "us";
}

function resolveGame(key)
{
	if(!key) key = "xmen";
	return GAMES[key] ? join(ROOT, GAMES[key]) : (key.includes("/") || key.includes("\\") ? key : join(ROOT, "roms", key));
}

function main()
{
	// Default BIOS = the disc's NATIVE region (X-Men is Japan, Rally USA).
	// With the wrong region the disc still boots, but the game takes another path and
	// does not reach the documented hang. It can be overridden with the bios argument (argv[4]).
	const BIOS_PER_GAME = { xmen: "jp", rally: "us" };
	const argGame = process.argv[2] || "xmen";
	const maxFrames = parseInt(process.argv[3] || "4000", 10);
	const argBios = process.argv[4] || BIOS_PER_GAME[argGame] || "eur";

	const biosPath = resolveBios(argBios);
	const gamePath = resolveGame(argGame);
	const outputName = "headless-" + (GAMES[argGame] ? argGame : "game") + ".json";

	console.log("HEADLESS: BIOS =", basename(biosPath));
	console.log("HEADLESS: game =", gamePath);
	console.log("HEADLESS: frame cap =", maxFrames);

	// --- Boot: BIOS, disc, reset (same order as the browser) ---
	const biosBytes = new Uint8Array(readFileSync(biosPath));
	applyBios(basename(biosPath), biosBytes);
	console.log("HEADLESS: detected region =", currentRegion().name, "(esPal=" + bus.isPal() + ")");

	let reader;
	try{ reader = loadDiscFromCue(gamePath); }
	catch(e){ console.error("HEADLESS: failed to mount disc:", e.message); process.exit(1); }
	const info = reader.info() || {};
	console.log("HEADLESS: disc mounted ->", (info.title || "(no header)"), "|", info.productNumber || "-",
		"| tracks:", reader.tracks.length, "| disc region:", (info.regions || []).join(",") || "-");

	// Slave tracing from now on: when X-Men stops the slave (halted), its histPc
	// keeps the last 16 PCs BEFORE dying (where it jumped into nowhere from).
	cpuSlave.tracing = true;
	cpu.tracing = true;

	// --- Run frames, instrumenting the boot and detecting the hang ---
	let tvmdSawDisp = false;
	let cyclesPeak = 0;
	let hangDetected = false, reasonHang = "";
	let candidateLogged = false;
	const START = Date.now();
	const CAP_MS = 8 * 60 * 1000;   // wall-clock guard: never hang for more than 8 min

	// Window of end-of-frame PCs to detect the tight loop by its MODE (not by
	// range): that way it tolerates the frame occasionally cutting inside the VBlank handler,
	// which brings in a distant PC and used to break the range-based detector.
	const WINDOW_PC = 96;
	const ringPc = new Int32Array(WINDOW_PC).fill(-1);
	let ringIdx = 0, ringFull = 0;
	let tightLoop = false, pcMode = 0, cntMode = 0;

	for(let f = 0; f < maxFrames; f++)
	{
		runFrame();

		if(tvmd() & 0x8000) tvmdSawDisp = true;
		if(cpu.cycles > cyclesPeak) cyclesPeak = cpu.cycles;

		// Periodic log of the boot.
		if(f < 20 || f % 200 === 0)
		{
			const t = tvmd();
			console.log("f=" + f,
				"pc=" + hex(cpu.pc, 8),
				"cycles=" + cpu.cycles,
				"TVMD=" + hex(t, 4), (t & 0x8000) ? "DISP" : "----",
				"BGON=" + hex(bgon(), 4),
				"slaveOn=" + bus.smpcSlaveOn,
				"sndOn=" + bus.smpcSoundOn,
				"auth=" + (bus.cd ? (bus.cd.authType || 0) : "-"),
				"cdSt=" + (bus.cd ? hex(bus.cd.pos.status & 0xFF, 2) : "-"));
		}

		// Hang detection by the MODE of the end-of-frame PCs.
		ringPc[ringIdx] = cpu.pc >>> 0; ringIdx = (ringIdx + 1) % WINDOW_PC;
		if(ringFull < WINDOW_PC) ringFull++;
		if(ringFull === WINDOW_PC && (f & 15) === 0)
		{
			// Most populated cluster: for each PC, how many land in [pc, pc+0x40).
			cntMode = 0; pcMode = 0;
			for(let i = 0; i < WINDOW_PC; i++)
			{
				const base = ringPc[i] >>> 0;
				let c = 0;
				for(let j = 0; j < WINDOW_PC; j++){ const d = (ringPc[j] >>> 0) - base; if(d >= 0 && d < 0x40) c++; }
				if(c > cntMode){ cntMode = c; pcMode = base; }
			}
			tightLoop = cntMode >= Math.floor(WINDOW_PC * 0.78);   // >= ~75 out of 96 in a loop of <0x40
		}

		// REAL hang: a tight master loop + a DEAD CPU that corroborates that something
		// broke (the slave jumping into nowhere, or the sound 68k). A CD loading
		// wait is also a tight loop, but there no CPU dies: that is NOT a hang.
		if(tightLoop && tvmdSawDisp && (cpuSlave.halted || m68kDied))
		{
			hangDetected = true;
			reasonHang = "master in loop " + hex(pcMode, 8) + " (" + cntMode + "/" + WINDOW_PC + " frames)" +
				(cpuSlave.halted ? " + slave HALTED at " + hex(cpuSlave.pc, 8) : "") +
				(m68kDied ? " + sound 68k DEAD" : "");
			console.log("HEADLESS: hang detected at frame", f, "->", reasonHang);
			break;
		}
		// Tight loop without a dead CPU: probably a loading wait. Warn once and carry on.
		if(tightLoop && tvmdSawDisp && !candidateLogged)
		{
			console.log("HEADLESS: master confined to", hex(pcMode, 8),
				"but no CPU died (probably a CD loading wait, not a hang); still running");
			candidateLogged = true;
		}

		if(Date.now() - START > CAP_MS)
		{
			console.log("HEADLESS: cut by wall clock (" + (CAP_MS / 1000) + "s) at frame", f);
			break;
		}
	}

	const reason = hangDetected ? "hang-detected" : (tvmdSawDisp ? "frame-cap" : "video-never-started");
	const dump = dumpState(reason, {
		game: basename(gamePath),
		reasonHang: reasonHang || null,
		tvmdSawDisp,
		cyclesPeak,
		cd: cdState()
	});

	const outputPath = join(ROOT, outputName);
	writeFileSync(outputPath, JSON.stringify(dump, null, "\t"), "utf8");

	console.log("\n===================== SUMMARY =====================");
	console.log("reason:", reason);
	console.log("frames run:", framesEmulated);
	console.log("TVMD ever saw DISP:", tvmdSawDisp, "| TVMD now:", hex(tvmd(), 4));
	console.log("master cycles (peak):", cyclesPeak);
	console.log("master pc:", hex(cpu.pc, 8), "sr:", hex(cpu.sr, 8), "imask:", (cpu.sr >> 4) & 0xF, "halted:", cpu.halted);
	console.log("slave on:", bus.smpcSlaveOn, "pc:", hex(cpuSlave.pc, 8), "halted:", cpuSlave.halted);
	console.log("scuPending:", hex(bus.scuPending, 8), "| IMR:", hex(scuImr(), 8), "| IST:", hex(scuIst(), 8));

	console.log("\n--- MASTER: loop around pc " + hex(cpu.pc, 8) + " ---");
	for(const l of dump.master.disasmLoop) console.log(l);
	console.log("--- MASTER: PC-relative literals (the mailbox it polls) ---");
	for(const l of dump.master.literalesPC)
		console.log("  " + l.pc + "  " + l.ins + " = " + l.value + (l.byteInThatPointer !== undefined ? "  -> byte[" + l.value + "]=" + l.byteInThatPointer : ""));
	if(bus.smpcSlaveOn)
	{
		console.log("\n--- SLAVE: site of the hang (pc " + hex(cpuSlave.pc, 8) + ", halted=" + cpuSlave.halted + ") ---");
		for(const l of dump.slave.disasmCrash) console.log(l);
		if(cpuSlave.tracing)
		{
			console.log("--- SLAVE: loop it jumped from (oldest histPc " + hex(cpuSlave.histPc[cpuSlave.histIdx], 8) + ") ---");
			for(const l of dump.slave.disasmLoop) console.log(l);
		}
	}
	console.log("\ndump written to:", outputPath);
}

// It only starts when invoked directly (node headless.mjs). Imported as a module -to
// reuse the boot in other analyses, e.g. rally-sky.mjs- it does NOT run by itself.
if(process.argv[1] && basename(process.argv[1]) === "headless.mjs") main();

// get68k(): the 68k is only created at SNDON, so it is exposed through a function
// (the sound diag/ probes need it to spy on the driver's PC).
function get68k() { return m68k; }
export { bus, vdp2, vdp1, cpu, cpuSlave, runFrame, applyBios,
	loadDiscFromCue, resolveBios, resolveGame, currentRegion, get68k, plan,
	biosForDisc };
