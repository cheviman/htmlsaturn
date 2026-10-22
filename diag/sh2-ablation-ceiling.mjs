/**
 *    Name:         sh2-ablation-ceiling.mjs
 *    Description:  The CEILING of optimizing the SH-2, measured BEFORE writing anything. Neutralizes
 *                  the pieces of the "per-instruction toll" one at a time and measures ms/frame. Each
 *                  branch runs in ITS OWN PROCESS (the SFA image weighs 600 MB: several
 *                  headless instances do not fit in memory) and the branches are INTERLEAVED,
 *                  comparing the MINIMUM of each one, which is the repo's measurement rule.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY THIS PROBE EXISTS
//
// SFA "runs VERY well, but slow" and its bottleneck is the SH-2: 130k real instructions per
// frame with 0% idle (diag/instr-per-frame.mjs), which means idle-skip has nothing left
// to take out. The cost is PER INSTRUCTION, and before reading the opcode every step() pays a
// fixed toll: two calls to the timers, the NMI/IRQ checks, four flags, the cycle table
// and -on every short back-branch- a snapshot of 22 values.
//
// The repo's rule is MEASURE THE CEILING BEFORE WRITING THE REFACTOR: it saved a whole VDP2
// refactor (real ceiling 5%) and justified taking on the JIT (25-35%). This probe answers
// "how much is saved AT MOST by each piece", which is what decides whether it gets touched.
//
// THE BRANCHES
//   control       nothing patched. It is the baseline.
//   control-2     nothing patched, AGAIN. It is the NOISE CONTROL: it runs where we already know
//                 the answer (it has to come out equal to control). If control and control-2
//                 drift apart more than the real branches, the whole table is noise and is NOT reported.
//   timers-evento the two timers accumulate and flush at the next observable event, instead
//                 of ticking per instruction. It keeps the effect: the no-op version was
//                 tried first and came out 3x SLOWER with the load moved 45x (see below).
//   fetch-cache   readInstr with the opcode ALREADY RESOLVED by address (an Int32Array over the
//                 high WRAM). It is Kronos's "cached interpreter", which reports 30% less
//                 CPU than a classic interpreter.
//   todo          the three together: the ceiling of the set.
//
// THE CONTAMINATION CONTROL, which is what makes each number credible
//
// An ablation that CHANGES THE WORK does not measure a saving: it measures another game. Removing
// the timers also removes the FRT interrupts, and the game may execute more or less code. That
// is why each branch also reports STEPS/FRAME and a HASH of the state:
//   - steps/frame within +-1% of control  -> the number is a clean saving.
//   - steps/frame moved                   -> it is ANOTHER load: the number is NOT valid as a ceiling.
//   - identical hash                      -> the ablation was also TRANSPARENT.
// It is the same trap that already cost us dearly: "a probe that removes the condition of the bug
// cannot find it".
//
// ✖ THE BRANCH THAT CANNOT BE MEASURED THIS WAY, noted so it is not retried: the idle loop
// SNAPSHOT (_saveSnap/_snapEqual, 22 values on every back-branch of <= 44 bytes). Turned
// into a no-op it gives 335,595 steps/frame against 7,385 — without _snapEqual there is no idle
// detection, so idle-skip never fires and the CPU spins instead of jumping. The ablation REMOVES
// THE CONDITION. To measure that piece you have to write a cheaper but EQUIVALENT detection
// (e.g. saving the snapshot only when the same back-branch target repeats), and that
// is no longer a ceiling: it is the optimization.
//
// Usage: node diag/sh2-ablation-ceiling.mjs [game=sfa] [reps=3] [warm=1500] [measure=300]

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";

const THIS  = fileURLToPath(import.meta.url);
const BRANCHES = (process.env.BRANCHES || "control,control-2,wrapper-only,timers-event,fetch-cache").split(",");

// V8 warm-up frames AFTER patching: the code changed, so TurboFan has to be
// given the chance to recompile before timing. Without this the first branch
// measures the deoptimization, not the cost.
const JIT_WARM = 120;

const now = () => Number(process.hrtime.bigint()) / 1e6;

// ============================================================================
//   CHILD: one branch, one process.
// ============================================================================
async function child(branch, game, warm, measure)
{
	const mod = await import("../headless.mjs?ab=" + branch);
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	const BIOS = { xmen: "jp" }[game] || "us";
	applyBios(basename(resolveBios(BIOS)), new Uint8Array(readFileSync(resolveBios(BIOS))));
	loadDiscFromCue(resolveGame(game));

	// GAME warm-up: all branches start from the SAME point, with the original
	// code. Only then is it patched, so the divergence starts the same for all of them.
	for(let f = 0; f < warm; f++) runFrame();

	applyAblation(branch);
	for(let f = 0; f < JIT_WARM; f++) runFrame();

	const t0 = now();
	for(let f = 0; f < measure; f++) runFrame();
	const ms = (now() - t0) / measure;

	// Load control: counted SEPARATELY and WITHOUT the stopwatch, because the counting wrapper
	// costs time and would contaminate the ms/frame above.
	const steps = countSteps(mod, 60);
	const P = globalThis.SH2.prototype;
	const cov = P._jitCoverage ? P._jitCoverage() : null;
	if(P._datCoverage)
	{
		const d = P._datCoverage();
		console.log("   data shortcut: " + (100 * d.hit / Math.max(1, d.hit + d.miss)).toFixed(1) +
			"% hit rate   (" + d.hit.toLocaleString("es") + " hits / " + d.miss.toLocaleString("es") + " failures)");
	}
	console.log("@@" + JSON.stringify({ branch, ms, steps, hash: hashState(mod), cov }));
	if(cov)
		console.log("   coverage: " + cov.blocks.toLocaleString("es") + " compiled blocks   " +
			(100 * cov.inside / (cov.inside + cov.outside)).toFixed(1) + "% of instructions inside a block" +
			"   (mean length " + (cov.inside / Math.max(1, cov.blocks)).toFixed(0) + " runs/block)");
}

// The ablations go on SH2.prototype and NOT on the instance: headless RECREATES the SH-2
// on every reset (a trap noted in PENDING.md), so a patch on the object gets lost
// on its own and the probe would report "nothing changes" with the ablation off.
function applyAblation(branch)
{
	const P = globalThis.SH2.prototype;
	const nothing = function(){};

	// THE CONTROL FOR THE TIMERS BRANCH, and without it its number cannot be read. This branch puts
	// THE SAME WRAPPERS on the same three hot paths, but WITHOUT changing anything:
	// they call the original and that is it. What it costs is exactly the price of patching through
	// the prototype, which the real implementation (inside sh2.js) would not pay.
	//   timers-evento - solo-envoltorio = the real cost of the IDEA.
	// If solo-envoltorio already eats the difference, the idea was left UNMEASURED and has to be
	// written in place to be judged.
	if(branch === "wrapper-only")
	{
		const readOrig = P.readInternal, writeOrig = P.writeInternal, dryOrig = P.runDry;
		P.readInternal     = function(addr, size){ return readOrig.call(this, addr, size); };
		P.writeInternal = function(addr, v, size){ return writeOrig.call(this, addr, v, size); };
		P.runDry    = function(k){ return dryOrig.call(this, k); };
	}

	// PAGE SHORTCUT FOR THE DATA PATH.
	//
	// Where it comes from: CLAUDE.md says that an optimization that worked in one place must be looked
	// for in the others ("an optimization is a pattern, not a patch"). The FETCH has had a page
	// shortcut since 25-07 —_fetchPage, sh2.js:759— because measured it was 13% of the frame and almost
	// all of it was PATH and not work: readInstr -> SH2.readWord (two range checks) ->
	// Bus.readWord (page table), three calls and four tests to get two bytes.
	// **The DATA path never got it**: readByte/readWord/readLong walk the whole
	// way to this.pages[a >>> 16] on every access.
	//
	// READS only: the bus writes look at ro/backup/cram and mark the VRAM dirty, so
	// a shortcut there would not be transparent. The reads return the buffer without looking at anything.
	// And it is safe for the same reason as the fetch one: the page is learned ONLY when the
	// address resolved to flat memory, so an internal register, the data array or the MMIO
	// can never end up cached. It is dropped with invalidateFetch(), which is what the
	// bus calls when it rebuilds the pages.
	if(branch === "data-page")
	{
		const lbOrig = P.readByte, lwOrig = P.readWord, llOrig = P.readLong;
		const invOrig = P.invalidateFetch;
		// HIT RATE: it is what decides whether the idea can work. The fetch shortcut
		// wins because the PC stays in the same 64 KB page for long stretches; if the data
		// does NOT have that locality, every access pays for the comparison plus the
		// learning path. Without this number, "it loses" cannot be explained.
		let hit = 0, miss = 0;
		P._datCoverage = () => ({ hit, miss });
		P.invalidateFetch = function(){ this._datPage = -1; this._datBuf = null; this._datMask = 0; return invOrig.call(this); };

		// Slow path: learns the page, same as _fetchSlow.
		const learn = (cpu, d) =>
		{
			if(cpu.isInternalReg(d) || cpu.isDataArray(d)) return null;
			const a = d & 0x07FFFFFF;
			const p = cpu.bus.pages ? cpu.bus.pages[a >>> 16] : null;
			if(!p) return null;
			cpu._datPage = d >>> 16; cpu._datBuf = p.buf; cpu._datMask = p.mask;
			return p;
		};

		P.readByte = function(addr)
		{
			const d = addr >>> 0;
			if((d >>> 16) === this._datPage){ hit++; return this._datBuf[(d & 0x07FFFFFF) & this._datMask]; }
			miss++;
			const p = learn(this, d);
			if(p !== null) return p.buf[(d & 0x07FFFFFF) & p.mask];
			return lbOrig.call(this, d);
		};
		P.readWord = function(addr)
		{
			const d = addr >>> 0;
			if((d >>> 16) === this._datPage)
			{
				hit++;
				const b = this._datBuf, m = this._datMask, a = d & 0x07FFFFFF;
				return ((b[a & m] << 8) | b[(a + 1) & m]) >>> 0;
			}
			miss++;
			const p = learn(this, d);
			if(p !== null){ const b = p.buf, m = p.mask, a = d & 0x07FFFFFF; return ((b[a & m] << 8) | b[(a + 1) & m]) >>> 0; }
			return lwOrig.call(this, d);
		};
		P.readLong = function(addr)
		{
			const d = addr >>> 0;
			if((d >>> 16) === this._datPage)
			{
				hit++;
				const b = this._datBuf, m = this._datMask, a = d & 0x07FFFFFF;
				return ((b[a & m] << 24) | (b[(a + 1) & m] << 16) | (b[(a + 2) & m] << 8) | b[(a + 3) & m]) >>> 0;
			}
			miss++;
			const p = learn(this, d);
			if(p !== null){ const b = p.buf, m = p.mask, a = d & 0x07FFFFFF; return ((b[a & m] << 24) | (b[(a + 1) & m] << 16) | (b[(a + 2) & m] << 8) | b[(a + 3) & m]) >>> 0; }
			return llOrig.call(this, d);
		};
	}

	// ------------------------------------------------------------------------------
	//   THE JIT PROTOTYPE. Straight blocks compiled to a JS function.
	//
	// WHY IT IS NEEDED, and what we had was not enough: the 25-35% ceiling that was listed
	// as justification comes from diag/jit-ceiling.mjs, which compares "readInstr per instruction"
	// against "reading an array" — that is, it measures ONLY THE FETCH and neither of its two branches
	// executes an instruction. Run today it gives 1.54 ms/frame of fetch in Rally (~8-9% of the
	// frame), not 25-35. And the fetch-cache branch of this same probe showed that removing the fetch
	// that way comes out MORE EXPENSIVE. So the JIT has to be judged by the OTHER things it removes:
	// the switch in execute(), the PC handling, the cycle table lookup and the loop.
	//
	// WHAT IT KEEPS (otherwise it would not be comparable): the per-instruction prelude comes out THE SAME as
	// in step() —timers, NMI/IRQ, halted/sleeping, idle— via _prelBlock(), which is a
	// faithful copy. The block only removes the fetch, the PC, the cycle table and the loop.
	//
	// WHAT IT DOES NOT KEEP, and it is an architecture finding worth noting: stepsBlock gives the CPU
	// a budget in cycles and cuts at the next cycle. A block does not know how much it has left,
	// so it can OVERSHOOT by up to the block's length. That shifts the scheduler's events
	// and the hash changes. A real JIT has to decrement the budget inside the block
	// (that is what Yabause's dynarec does: it accumulates cycles and compares before each branch).
	// That is why the block is limited to 16 instructions: it bounds the overshoot so the speed
	// number can still be read.
	if(branch === "jit-op" || branch === "jit-group" || branch === "jit-hot")
	{
		const CYCLES  = cyclesTable();
		const stepOrig = P.step;
		const MAX = 16;
		// THRESHOLD: how many times the CPU has to go through a PC before compiling it. With 0
		// everything stepped on once gets compiled, which is what jit-op and jit-grupo do — and that
		// is what makes V8 end up with thousands of COLD generated functions competing against a
		// step() that has been hot for thousands of frames. It is the "code cache saturation" that
		// O'Callahan notes and the reason v86 generates WebAssembly and not JS. With a threshold, code
		// comes out only for what is hot and V8 can tier it.
		const THRESHOLD = (branch === "jit-hot") ? 30 : 0;

		// FAITHFUL copy of the step() prelude (sh2.js:1194-1238). Returns true if the block
		// has to bail out: an interrupt was served and the PC moved, the CPU ended up
		// halted/asleep/idle, or it is tracing. Being a copy is known debt: the
		// control is the hash, which has to come out equal except for the overshoot above.
		P._prelBlock = function(pcExpected)
		{
			this._frtRun(1);
			this._wdtRun(1);
			if(this.nmiPending) this._serveNmi();
			else if(this.irqPending.length)
			{
				const imask = (this.sr >> 4) & 0xF;
				let best = -1, bestLevel = imask;
				for(let i = 0; i < this.irqPending.length; i++)
					if(this.irqPending[i].level > bestLevel){ bestLevel = this.irqPending[i].level; best = i; }
				if(best >= 0)
				{
					const irq = this.irqPending.splice(best, 1)[0];
					let mx = -1;
					for(let i = 0; i < this.irqPending.length; i++)
						if(this.irqPending[i].level > mx) mx = this.irqPending[i].level;
					this.irqLevelMax = mx;
					this._serveInterrupt(irq.level, irq.vector);
				}
			}
			if(this.halted || this.sleeping) return true;
			if(this.idle){ this.cycles++; return true; }
			if(this.tracing) return true;
			return this.pc !== pcExpected;
		};

		// The block CUTS before anything that can move the PC: those are executed by the slow
		// path, with its delay slot and its idle detection intact. The list is conservative
		// —too many, never too few— and there is also a runtime GUARD (`if(c.pc
		// !== next) return`) that catches any I may have missed. Correctness
		// does not depend on this table being complete.
		const movesPc = (op) =>
		{
			const g = op >> 12;
			if(g === 0xA || g === 0xB) return true;                                  // BRA / BSR
			if(g === 0x8){ const s = (op >> 8) & 0xF; return s === 0x9 || s === 0xB || s === 0xD || s === 0xF; }
			if(g === 0xC && ((op >> 8) & 0xF) === 0x3) return true;                  // TRAPA
			if(g === 0x0)
			{
				const lo = op & 0xFF;
				if(lo === 0x0B || lo === 0x2B) return true;                          // RTS / RTE
				if((op & 0xF) === 0x3) return true;                                  // BSRF / BRAF (and neighbors)
				if(op === 0x001B) return true;                                       // SLEEP
			}
			if(g === 0x4){ const lo = op & 0xFF; if(lo === 0x0B || lo === 0x2B) return true; }   // JSR / JMP
			return false;
		};

		// Compiles the straight block that starts at pc0. Returns null if there are not even two
		// instructions worth it (a block of a single one saves nothing).
		const compile = function(cpu, pc0)
		{
			const ops = [], pcs = [];
			let pc = pc0 >>> 0;
			for(let k = 0; k < MAX; k++)
			{
				let op;
				try{ op = cpu.readInstr(pc) & 0xFFFF; }catch(e){ break; }
				if(movesPc(op)) break;
				ops.push(op); pcs.push(pc);
				pc = (pc + 2) >>> 0;
			}
			if(ops.length < 2) return null;
			const end = pc;

			let src = "";
			for(let k = 0; k < ops.length; k++)
			{
				const op = ops[k], nextPc = (pcs[k] + 2) >>> 0;
				src += "if(c._prelBlock(" + pcs[k] + ")) return;\n";
				src += "c.pc=" + nextPc + ";";
				if(branch === "jit-op")
					src += "c.execute(" + op + ");";
				else
				{
					// One more step: the switch in execute() is skipped and the group's method is
					// called with n and m already resolved. The four cases that execute()
					// resolves inline (1, 5, 7 and 9-F) are emitted inline as well.
					src += emitGroup(op);
				}
				src += "c.cycles+=" + CYCLES[op] + ";\n";
				if(k < ops.length - 1) src += "if(c.pc!==" + nextPc + ") return;\n";
			}
			const f = new Function("c", src);
			f.n = ops.length;
			f.pc0 = pc0 >>> 0;
			f.end = end;
			return f;
		};

		// How many INSTRUCTIONS it ran: with blocks, counting calls to step() no longer measures the
		// load (one call is up to 16 instructions) and the probe's contamination control
		// was left blind. With this it is comparable against the interpreter again.
		let nInstr = 0;
		P._jitInstr = () => nInstr;
		// COVERAGE: without this we cannot say WHY it loses. If almost everything ran through the
		// slow path, what was measured is the overhead of the attempt and not the generated code;
		// if coverage is high and it still loses, then the generated JS is genuinely worse
		// than our interpreter and the front is closed on solid grounds.
		let nBlocks = 0, nInBlock = 0, nOutside = 0;
		P._jitCoverage = () => ({ blocks: nBlocks, inside: nInBlock, outside: nOutside });

		P.step = function()
		{
			if(this.idle || this.sleeping || this.halted || this.tracing){ nInstr++; nOutside++; return stepOrig.call(this); }
			let m = this._blq;
			if(m === undefined){ m = this._blq = new Map(); this._blqLine = new Map(); this._blqCnt = new Map(); }
			const pc = this.pc >>> 0;
			let b = m.get(pc);
			if(b === undefined)
			{
				if(THRESHOLD > 0)
				{
					const cnt = (this._blqCnt.get(pc) | 0) + 1;
					if(cnt < THRESHOLD){ this._blqCnt.set(pc, cnt); nInstr++; nOutside++; return stepOrig.call(this); }
					this._blqCnt.delete(pc);
				}
				b = compile(this, pc);
				if(b !== null) nBlocks++;
				m.set(pc, b === null ? 0 : b);      // 0 = "no block here", so as not to recompile
				// Index by 16-byte LINE, which is the granularity at which the chip invalidates.
				// Without this the whole map had to be dropped on every write, and that recompilation
				// storm cost 3x: 19.32 ms against 6.49 with invalidation turned off.
				if(b !== null)
					for(let L = pc >>> 4; L <= (b.end - 1) >>> 4; L++)
					{
						let l = this._blqLine.get(L);
						if(l === undefined) this._blqLine.set(L, l = []);
						l.push(pc);
					}
			}
			if(b === 0 || b === null){ nInstr++; nOutside++; return stepOrig.call(this); }
			nInstr += b.n; nInBlock += b.n;
			b(this);
			return 1;
		};

		// Self-modifying code: the block is dropped where the chip already invalidates its instruction
		// cache. It does not cover writes from the OTHER CPU nor DMA — the control is the hash.
		// DIAGNOSTIC, not a real option: with JIT_SIN_INVAL=1 NO block is dropped.
		// It is incorrect (self-modifying code goes stale) and so it only serves to
		// isolate how much of the slowness is the recompilation storm. The hash gives it away.
		const invOrig = P._icInvalidate;
		const noInval = process.env.JIT_NO_INVAL === "1";
		P._icInvalidate = function(addr)
		{
			if(!noInval && this._blq !== undefined)
			{
				const L = (addr >>> 0) >>> 4;
				const l = this._blqLine.get(L);
				if(l !== undefined)
				{
					for(let i = 0; i < l.length; i++) this._blq.delete(l[i]);
					this._blqLine.delete(L);
				}
			}
			return invOrig.call(this, addr);
		};
	}

	if(branch === "timers-event" || branch === "all")
	{
		// ✖ FIRST ATTEMPT, DEAD AND NOTED: turning _frtRun/_wdtRun into no-ops.
		// It is 3x SLOWER and 335,595 steps/frame against 7,385 for control. Without the FRT the FRC
		// never advances, the game polls a stuck counter and spins forever. It was not
		// measuring a saving: it was measuring another game. It was caught by the load control of this same
		// probe, which is what it is there for.
		//
		// The good ablation KEEPS THE EFFECT and removes only the cost: instead of ticking the
		// two timers on every instruction, the cycles accumulate and are flushed only when
		// the next OBSERVABLE event arrives. It is exact by construction -inside that
		// window no tick can do anything- and it is the SAME arithmetic that runDry already
		// does (sh2.js:1328-1356). Per instruction what is left is one addition and one comparison.
		const frtOrig = P._frtRun, wdtOrig = P._wdtRun;
		const readOrig = P.readInternal, writeOrig = P.writeInternal;

		// Cycles until the next observable event of the two timers.
		P._tUntilNext = function()
		{
			let k = 0x3FFFFFFF;
			const f = this.frt;
			if(f.active)
			{
				const b = this.internalRegs;
				const frc = ((b[0x12] << 8) | b[0x13]) & 0xFFFF;
				const dist = (o) => { const d = (o - frc) & 0xFFFF; return d === 0 ? 0x10000 : d; };
				const ticks = Math.min(dist(f.ocra), dist(f.ocrb), dist(0));
				const until = (f.period - f.remainder) + (ticks - 1) * f.period;
				if(until < k) k = until;
			}
			const w = this.wdt;
			if(w.active)
			{
				const ticks = 0x100 - (this.internalRegs[0x81] & 0xFF);
				const until = (w.period - w.remainder) + (ticks - 1) * w.period;
				if(until < k) k = until;
			}
			return k;
		};
		P._tFlush = function()
		{
			const c = this._tPending | 0;
			if(c > 0){ this._tPending = 0; frtOrig.call(this, c); wdtOrig.call(this, c); }
			this._tUntil = this._tUntilNext();
		};
		// The WDT travels inside the same flush, so its per-instruction call is left empty.
		// With _tUntil uninitialized, `| 0` gives 0 and the first call flushes and computes it:
		// there is no need to touch the constructor (and reset recreates the CPU, so better this way).
		P._frtRun = function(c){ const p = (this._tPending | 0) + c; this._tPending = p; if(p >= (this._tUntil | 0)) this._tFlush(); };
		P._wdtRun = function(c){};
		// The two points through which the timers' state can be OBSERVED: reading FRC /
		// FTCSR / WTCNT, and writing any register that moves the next due date (TCR, OCRA,
		// OCRB, WTCSR). Before reading, it flushes; after writing, it recomputes.
		P.readInternal = function(addr, size){ this._tFlush(); return readOrig.call(this, addr, size); };
		// And the third observer, which almost slipped through: runDry reads the RAW FRC from
		// internalRegs to compute how far it can jump. With unflushed cycles it sees a
		// lagging counter, computes a longer distance than the real one and could jump RIGHT
		// OVER an event. It shows in the steps/frame (0.02% difference with the hash
		// already identical), which is exactly what the load control is for.
		const dryOrig = P.runDry;
		P.runDry = function(k){ this._tFlush(); return dryOrig.call(this, k); };
		P.writeInternal = function(addr, v, size)
		{
			this._tFlush();
			const r = writeOrig.call(this, addr, v, size);
			this._tUntil = this._tUntilNext();
			return r;
		};
	}

	if(branch === "no-snapshot" || branch === "all")
	{
		P._saveSnap = nothing;
		P._snapEqual   = function(){ return false; };
	}

	if(branch === "fetch-cache" || branch === "all")
	{
		// The opcode already resolved by address, like Kronos's cacheCode[cpu][region][PC>>1].
		// Only the high WRAM (0x06000000-0x060FFFFF), which is where the games' code
		// runs from: it is enough for the ceiling and it is 2 MB of table per CPU instead of mapping 27 bits.
		const readOrig = P.readInstr;
		P.readInstr = function(addr)
		{
			const d = addr >>> 0;
			if((d & 0xFFF00000) === 0x06000000)
			{
				let t = this._abTable;
				if(t === undefined){ t = this._abTable = new Int32Array(0x80000).fill(-1); }
				const i = (d & 0xFFFFF) >>> 1;
				const v = t[i];
				if(v >= 0) return v;
				const op = readOrig.call(this, d);
				t[i] = op;
				return op;
			}
			return readOrig.call(this, d);
		};
		// Invalidation: it hooks where the chip already invalidates its instruction cache, which
		// is what `notify()` does in Kronos. It does NOT cover writes from the OTHER CPU nor DMA
		// -that is precisely what a real cached interpreter would have to solve-, and
		// that is why this branch is read as a CEILING: if the hash changes, this is why.
		const invOrig = P._icInvalidate;
		P._icInvalidate = function(addr)
		{
			const t = this._abTable;
			if(t !== undefined)
			{
				const d = addr >>> 0;
				if((d & 0xFFF00000) === 0x06000000)
				{
					const b = ((d & 0xFFFFF) & ~0xF) >>> 1;      // the 8 words of the 16-byte line
					for(let k = 0; k < 8; k++) t[b + k] = -1;
				}
			}
			return invOrig.call(this, addr);
		};
	}
}

// The cycle table lives as a module const in sh2.js and is not published on globalThis, so
// it is taken by evaluating the file separately. It is the SAME source, not a hand copy: if the
// table changes, this probe follows it on its own.
function cyclesTable()
{
	const src = readFileSync(new URL("../sh2.js", import.meta.url), "utf8");
	return new Function(src + "\nreturn SH2_CYCLES;")();
}

// Emits the body of ONE instruction, copying the dispatch of execute() (sh2.js:1402-1443)
// but with n, m and the displacements ALREADY RESOLVED: that is what a JIT really gains, and
// it is what jit-ceiling.mjs was not measuring. The four cases that execute() resolves inline are
// emitted inline as well; the rest call the group's method, skipping the switch.
// Everything interpolated is NUMBERS derived from `op` (16 bits) — no text comes in from
// anywhere, so the generated code cannot bring in anything from outside.
function emitGroup(op)
{
	const n = (op >> 8) & 0xF, m = (op >> 4) & 0xF;
	const s8 = (v) => (v & 0x80) ? (v | 0xFFFFFF00) : v;
	switch(op >> 12)
	{
		case 0x0: return "c.group0(" + op + "," + n + "," + m + ");";
		case 0x1: return "c.writeLong((c.r[" + n + "]+" + ((op & 0xF) << 2) + ")>>>0,c.r[" + m + "]>>>0);";
		case 0x2: return "c.group2(" + op + "," + n + "," + m + ");";
		case 0x3: return "c.group3(" + op + "," + n + "," + m + ");";
		case 0x4: return "c.group4(" + op + "," + n + "," + m + ");";
		case 0x5: return "c.r[" + n + "]=c.readLong((c.r[" + m + "]+" + ((op & 0xF) << 2) + ")>>>0)|0;";
		case 0x6: return "c.group6(" + op + "," + n + "," + m + ");";
		case 0x7: return "c.r[" + n + "]=(c.r[" + n + "]+" + s8(op & 0xFF) + ")|0;";
		case 0x8: return "c.group8(" + op + "," + n + "," + m + ");";
		case 0x9: return "c.r[" + n + "]=c.sign16(c.readWord(((c.pc+2)+" + ((op & 0xFF) << 1) + ")>>>0))|0;";
		case 0xC: return "c.groupC(" + op + "," + n + "," + m + ");";
		case 0xD: return "c.r[" + n + "]=c.readLong(((((c.pc+2)&0xFFFFFFFC)>>>0)+" + ((op & 0xFF) << 2) + ")>>>0)|0;";
		case 0xE: return "c.r[" + n + "]=" + s8(op & 0xFF) + "|0;";
		// 0xA and 0xB (BRA/BSR) do not get here: movesPc cuts them first. 0xF is illegal.
		default:  return "c.execute(" + op + ");";
	}
}

// Steps per frame: the proxy for HOW MUCH WORK the game does. It is the control that separates
// "I saved time" from "I executed something else".
function countSteps(mod, frames)
{
	const P = globalThis.SH2.prototype;
	// With blocks, counting calls to step() counts BLOCKS, not instructions: the branch keeps
	// its own counter so the load control stays comparable with control.
	if(P._jitInstr)
	{
		const a = P._jitInstr();
		for(let f = 0; f < frames; f++) mod.runFrame();
		return (P._jitInstr() - a) / frames;
	}
	const orig = P.step;
	let n = 0;
	P.step = function(){ n++; return orig.call(this); };
	for(let f = 0; f < frames; f++) mod.runFrame();
	P.step = orig;
	return n / frames;
}

// Same hash as diag/bench-sh2.mjs, so the numbers can be crossed with the usual bench.
// It is read through bus.cpuMaster/bus.cpuSlave and NOT through the module exports: reset recreates the
// CPUs and the exports are left pointing to dead objects.
function hashState(mod)
{
	const bus = mod.bus;
	let h = 2166136261 >>> 0;
	const mix = (x) => { h ^= (x >>> 0); h = Math.imul(h, 16777619) >>> 0; };
	const c = bus.cpuMaster;
	mix(c.pc); for(let i = 0; i < 16; i++) mix(c.r[i]);
	mix(c.sr); mix(c.pr); mix(c.gbr); mix(c.vbr); mix(c.cycles);
	const s = bus.cpuSlave;
	if(s){ mix(s.pc); for(let i = 0; i < 16; i++) mix(s.r[i]); mix(s.sr); mix(s.cycles); }
	for(let a = 0x06000000; a < 0x06100000; a += 0x800){ try{ mix(bus.readLong(a)); }catch(e){} }
	return h.toString(16);
}

// ============================================================================
//   ORCHESTRATOR: launches the branches INTERLEAVED and compares by the MINIMUM.
// ============================================================================
function orchestrate(game, reps, warm, measure)
{
	console.log("SH-2 CEILING BY ABLATION   game=" + game + "   " + reps + " reps x " +
		measure + " frames   (warm " + warm + " + " + JIT_WARM + " of JIT)");
	console.log("each branch in its own process, interleaved, and the MINIMUM of each one is compared\n");

	const res = {};
	for(const r of BRANCHES) res[r] = { ms: [], steps: 0, hash: "?" };

	for(let rep = 0; rep < reps; rep++)
	{
		// COUNTERBALANCING: the order of the branches ROTATES on every rep.
		// On 28-07-2026 this probe reported `datos-pag` worse in 4/4 reps... and `control-2`
		// -code IDENTICAL to control- also came out worse in 4/4. That is, the branch that runs
		// first in each rep comes out systematically better: there is a POSITIONAL bias (CPU
		// state, caches and turbo after the previous process) and the sign test was reading it
		// as if it were the ablation. Rotating, each branch takes each position and the bias
		// cancels out. Without this the repo's interleaved A/B measures the order, not the change.
		const order = BRANCHES.slice(rep % BRANCHES.length).concat(BRANCHES.slice(0, rep % BRANCHES.length));
		for(const branch of order)
		{
			const p = spawnSync(process.execPath, [THIS, game, "--branch", branch,
				String(warm), String(measure)], { encoding: "utf8", maxBuffer: 1 << 24 });
			const line = (p.stdout || "").split("\n").find(l => l.startsWith("@@"));
			if(!line)
			{
				console.log("  " + branch.padEnd(13) + " FAILED: " + ((p.stderr || "").trim().split("\n").pop() || "no output"));
				continue;
			}
			const d = JSON.parse(line.slice(2));
			res[branch].ms.push(d.ms);
			res[branch].steps = d.steps;
			res[branch].hash  = d.hash;
			process.stdout.write("  rep " + (rep + 1) + "  " + branch.padEnd(13) + d.ms.toFixed(3) + " ms/frame\n");
		}
		console.log("");
	}

	const min = (r) => res[r].ms.length ? Math.min(...res[r].ms) : NaN;
	const base = min("control");
	const baseSteps = res["control"].steps;
	const baseHash  = res["control"].hash;

	console.log("RESULT (minimum of " + reps + " corridas)\n");
	console.log("  branch         ms/frame    saving    steps/frame    load      hash");
	for(const r of BRANCHES)
	{
		const m = min(r);
		if(!isFinite(m)){ console.log("  " + r.padEnd(14) + " no data"); continue; }
		const saving = (100 * (base - m) / base);
		const dSteps = baseSteps ? (100 * (res[r].steps - baseSteps) / baseSteps) : 0;
		const load  = Math.abs(dSteps) <= 1 ? "same    " : ("MOVED " + (dSteps > 0 ? "+" : "") + dSteps.toFixed(1) + "%");
		console.log("  " + r.padEnd(14) + m.toFixed(3).padStart(8) + "   " +
			(saving >= 0 ? "+" : "") + saving.toFixed(1).padStart(5) + "%   " +
			Math.round(res[r].steps).toLocaleString("es").padStart(10) + "   " + load + "  " +
			res[r].hash + (res[r].hash === baseHash ? " =" : " ~"));
	}

	// THE CONTROL, and it is explicit: without it the table is not reported.
	console.log("");
	if(res["control-2"])
	{
		const noise = Math.abs(100 * (min("control-2") - base) / base);
		console.log("  NOISE CONTROL (control vs control-2): " + noise.toFixed(1) + "%");
		if(res["control-2"].hash !== baseHash)
			console.log("  ⚠ the two controls give a DIFFERENT HASH: the run is not deterministic, the table is not valid");
	}
	else console.log("  ⚠ NO control-2 in this run: there is no measure of the noise, read the spread below");

	// THE SPREAD OF EACH BRANCH, and it is not decorative: on 28-07-2026 the minimum of control vs
	// control-2 gave 2.2% and it looked like that was the noise, but the raw runs of the same
	// branch spread 6-17% between processes (V8 warm-up, the OS scheduler, how
	// memory landed). With that spread, ONE pair of minimums is not enough to call anything noise.
	// The criterion that does hold is the SIGN: a branch only counts as worse (or better) if it
	// is in ALL the reps, one by one.
	console.log("\n  SPREAD PER BRANCH (raw of each rep) and sign against control:");
	for(const r of BRANCHES)
	{
		if(!res[r] || !res[r].ms.length) continue;
		const v = res[r].ms;
		const disp = 100 * (Math.max(...v) - Math.min(...v)) / Math.min(...v);
		let worst = 0, best = 0;
		for(let i = 0; i < v.length && i < res["control"].ms.length; i++)
		{
			if(v[i] > res["control"].ms[i]) worst++;
			else if(v[i] < res["control"].ms[i]) best++;
		}
		const sign = (r === "control") ? "" :
			(worst === v.length ? "  WORSE in " + worst + "/" + v.length + " reps" :
			 best === v.length ? "  BETTER in " + best + "/" + v.length + " reps" :
			 "  MIXED (" + worst + " worse / " + best + " better) -> it is noise");
		console.log("    " + r.padEnd(16) + v.map(x => x.toFixed(2)).join("  ").padEnd(24) +
			"  dispersion " + disp.toFixed(1) + "%" + sign);
	}
	console.log("\n  'load MOVED' = the branch executes something else, so its ms/frame is not a");
	console.log("  ceiling but another game.");
}

// ============================================================================
const args = process.argv.slice(2);
const iR   = args.indexOf("--branch");
const game = (args[0] && !args[0].startsWith("--")) ? args[0] : "sfa";

if(iR >= 0)
{
	const branch  = args[iR + 1];
	const warm  = parseInt(args[iR + 2] || "1500", 10);
	const measure = parseInt(args[iR + 3] || "300", 10);
	await child(branch, game, warm, measure);
}
else
{
	const reps  = parseInt(args[1] || "3", 10);
	const warm  = parseInt(args[2] || "1500", 10);
	const measure = parseInt(args[3] || "300", 10);
	orchestrate(game, reps, warm, measure);
}
