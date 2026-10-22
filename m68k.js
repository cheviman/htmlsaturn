/**
 *    Name:         m68k.js
 *    Description:  Adapter for the Saturn's Motorola 68EC000 sound CPU.
 *                  It wraps the EstyJs.Processor core (GPL, see vendor/) and
 *                  connects the SCSP's sound RAM to it as its memory space.
 *                  The 68000 runs the sound driver the SH-2 uploads to the RAM.
 *    Version:      0.2.0
 *    Created:      15-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 *
 *    LICENSE NOTE: this adapter uses EstyJs (GPL v2+, Darren Coles / Kai
 *    Eckert). That is why HTMLSATURN is distributed under GPL v2+. See LICENSE.
 */

//ok, 17-07-2026 - complete adapter: sound RAM + SCSP registers, reset/halt
// via the SMPC and interleave with the SH-2. The three "Missing" items this marker listed
// until 17-07-2026 were already done, and they sent two agents to redo them:
//   - SCSP registers: they are mapped by the memory interface down below, not just
//     the sound RAM (a & 0x100000 -> bus.scspRead / bus.scspWrite).
//   - reset/halt via the SMPC: SNDON/SNDOFF are handled by bus.js:3233-3234. SNDON
//     raises bus.reset68k and index.html:3357 creates/resets the 68k; SNDOFF clears
//     bus.smpcSoundOn, which is the condition index.html:3345 runs it under
//     (that gate IS the halt: without the flag it gets no cycles).
//   - sync with the SH-2: it is done by the chunk interleave in index.html:3329-3350,
//     which splits the frame's cycles between SH-2, SCSP and 68k. The cycle debt
//     EstyJs leaves because it cannot cut an instruction short is explained in run().

// EstyJs expects the global namespace and a global sprintf. We define them if missing.
var EstyJs = (typeof EstyJs !== "undefined") ? EstyJs : {};
if(typeof globalThis !== "undefined") globalThis.EstyJs = EstyJs;

if(typeof sprintf === "undefined")
{
	// minimal sprintf for EstyJs's logging/disassembler (%d %x %0Nx %s %c).
	var sprintf = function(fmt){
		const args = Array.prototype.slice.call(arguments, 1);
		let i = 0;
		return String(fmt).replace(/%(0\d+)?([dxsc%])/g, (m, pad, ty)=>{
			if(ty === "%") return "%";
			let v = args[i++], s;
			if(ty === "d") s = String(v | 0);
			else if(ty === "x") s = (v >>> 0).toString(16);
			else if(ty === "s") s = String(v);
			else s = String.fromCharCode(v);
			if(pad) s = s.padStart(parseInt(pad, 10), "0");
			return s;
		});
	};
	if(typeof globalThis !== "undefined") globalThis.sprintf = sprintf;
}

class M68K
{
	// bus: the Saturn's Bus. The 68k sees the sound RAM at 0x000000-0x07FFFF and the
	// SCSP registers at 0x100000+ (shared with the SH-2).
	constructor(bus)
	{
		this.bus = bus;
		const R = bus.soundRam, M = 0x7FFFF;   // sound RAM: 512 KB

		// Memory interface EstyJs expects (big-endian, like the 68000).
		const memory = {
			readByte:  (a)=> (a & 0x100000) ? bus.scspRead(a, 1) : R[a & M],
			readWord:  (a)=> (a & 0x100000) ? bus.scspRead(a, 2) : (((R[a & M] << 8) | R[(a + 1) & M]) >>> 0),
			readLong:  (a)=> (a & 0x100000) ? bus.scspRead(a, 4) : (((R[a & M] << 24) | (R[(a + 1) & M] << 16) | (R[(a + 2) & M] << 8) | R[(a + 3) & M]) >>> 0),
			writeByte: (a, v)=>{ if(a & 0x100000) bus.scspWrite(a, v, 1); else R[a & M] = v & 0xFF; },
			writeWord: (a, v)=>{ if(a & 0x100000) bus.scspWrite(a, v, 2); else { R[a & M] = (v >> 8) & 0xFF; R[(a + 1) & M] = v & 0xFF; } },
			writeLong: (a, v)=>{ if(a & 0x100000) bus.scspWrite(a, v, 4); else { R[a & M] = (v >>> 24) & 0xFF; R[(a + 1) & M] = (v >>> 16) & 0xFF; R[(a + 2) & M] = (v >>> 8) & 0xFF; R[(a + 3) & M] = v & 0xFF; } }
		};

		// The SCSP interrupts the 68k. We reuse EstyJs's "mfp" hook to
		// hand it the SCSP's interrupt level (SCIPD & SCIEB via SCILV).
		//
		// getInterrupt() = 30 (the level 6 autovector), NOT 0:
		// EstyJs is an Atari ST core and in interrupt(nr) it treats level 6 as the
		// ST MFP's VECTORED interrupt -> it does exception(mfp.getInterrupt())
		// instead of exception(nr + 24) like the other levels. On the Saturn the SCSP is
		// AUTOVECTORED on all 7 levels (Yabause: C68K_INTERRUPT_AUTOVECTOR_EX = 24 and
		// C68K_AUTOVECTOR_CALLBACK commented out -> vector = level + 24 always; scsp.c only
		// does M68K->SetIRQ(level) without installing an ack callback). With getInterrupt()=>0
		// a level 6 IRQ did exception(0) -> memory.readLong(0) = the initial stack pointer
		// from the vector table, and the 68k jumped off to execute garbage. Returning 30
		// (= 6 + 24) reproduces the correct autovector without touching the vendor code.
		const mfp = { doInterrupts:()=> bus.scspLevel68k(), getInterrupt:()=> 30, timerCycles:()=>{} };
		// BUG is EstyJs's debug logger. By default it is a no-op, but if a
		// sink is installed (this.sinkLog) the logger hands it every line. It is useful for
		// using the disassembler EstyJs already ships: since Processor() is called WITHOUT
		// `new`, its `this.diss(addr, n)` / `this.dissFault(n)` end up hanging off the
		// global object and spit the text out through BUG.say(). With the sink in place you
		// can disassemble the routine the sound driver is running.
		const yo = this;
		const bug = { say:(s)=>{ if(yo.sinkLog) yo.sinkLog(s); }, col:()=>{}, info:()=>{} };

		// The memory interface is kept: EstyJs resolves it by property on every
		// access (memory.readWord(...)), so wrapping m68k.memory.readWord from
		// the outside is enough to instrument/trace the 68k's accesses without touching the
		// vendor code. The tests and the debug probes use it.
		this.memory = memory;

		this.cpu = EstyJs.Processor({ memory: memory, mfp: mfp, bug: bug });
		this.cpu.setup();
		this.halted = false;
	}

	// Reset: reads SP and PC from the vector table at address 0 (like the real 68000).
	// RESET is also the ONLY way out of the HALT state (see run()).
	reset()
	{
		this.halted = false;
		this.cpu.reset(0);
	}

	// Runs `cycles` cycles of the 68000. EstyJs cannot cut an instruction in
	// half, so the block overshoots a bit and the leftover is carried to the next one
	// (the core's tot_cycles): amortized, it delivers exactly the cycles requested, which
	// is what it takes to mesh it with the SH-2 without running it ahead or behind.
	// The default of 512 is EstyJs's historical block (one Atari ST scanline).
	run(cycles = 512)
	{
		// HALT: the 68000 with the HALT line asserted executes nothing and only leaves through RESET.
		// Handing it cycles would be making it
		// run; doing nothing is what the real hardware does.
		if(this.halted) return;

		this.cpu.setRowCycles(cycles);
		try{ this.cpu.runCode(); }
		catch(e)
		{
			// DOUBLE BUS FAULT: an access failed while a group 0 exception was being processed
			// (bus/address error). The real MC68000 halts and asserts the HALT line
			// and stays there until the next RESET; it does NOT disappear.
			// Before, this reached index.html/headless, which did m68k = null: the chip
			// vanished because of a state the hardware does have, and on top of that with no way back.
			// The rest of the exceptions are rethrown ON PURPOSE: a FatalError from the core
			// ('invalid size', invalid addressing mode) is a bug of OURS and covering it
			// with a halt would make it invisible.
			if(e && e.message === "double address/bus-error")
			{
				this.halted = true;
				const r = this.cpu.getRegs ? this.cpu.getRegs() : null;
				console.warn("HTMLSATURN: double bus fault in the sound 68000 -> HALT" +
					" (it leaves with the next SMPC reset)" +
					(r ? ", PC=0x" + (r.pc >>> 0).toString(16) : ""));
				return;
			}
			throw e;
		}
	}
}

if(typeof module !== "undefined") module.exports = { M68K };
