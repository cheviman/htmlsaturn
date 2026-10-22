/**
 *    Name:         sh2.js
 *    Description:  Core of the Saturn's Hitachi SH-2 (SH7604) CPU. Big-endian,
 *                  RISC with 16-bit instructions. Instantiated twice
 *                  (master and slave). Implements the full SH-2 ISA:
 *                  transfer, arithmetic, logic, shifts, branches with
 *                  delay slot, step-by-step division and system control.
 *                  Includes the SH7604's on-chip peripherals (DIVU, DMAC, FRT and WDT).
 *    Version:      0.6.0
 *    Created:      15-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 */

//!wip, 16-07-2026 - full SH-2 ISA + DIVU (divider) + DMAC (2 channels)
//!  + FRT (free-running timer with prescaler, output compare and overflow)
//!  + WDT (watchdog: interval mode with ITI and watchdog mode with internal reset).
//? Pending: SCI and UBC. Cycle timing is NO LONGER ~1 per instruction: see
//? SH2_CYCLES below.

// ---------------------------------------------------------------------------
// EXECUTION CYCLES PER INSTRUCTION.
//
// Until 25-07-2026 every instruction cost 1 cycle (`this.cycles++`). Since the
// budget of a frame is CYCLES (447,443 on NTSC), that made the CPU execute the
// MAXIMUM possible number of instructions per frame: 447k on the master, always, in every
// game. It is not just that extra interpretation work got done — the TIME SPLIT
// between CPU, VDP, DMA and chips was off, because the CPU used up its
// budget faster than it should. Sebas (23-07-2026, translated): "the CPU emulation is not
// accurate to their real capabilities" and "the vdp waits for the cpu to be freed after 6 cycles
// to render 2 of video, everything shifts, it loses timing".
//
// SOURCE: the SH instruction-set latency tables, the LATENCY column at the position
// that belongs to SH2 within each instruction's `compat` list —
// careful, MAC.L does not exist on SH1, so there SH2 is the first column and not the second.
// Cross-checked against the SH7604's own timings: BRA/RTS/JMP/JSR 2, RTE 4,
// SLEEP 3, TRAPA 8, TAS.B 4, MAC.W 3, BT/BF 3 if they branch and 1 if not. The extraction gave
// 142 instructions with 0 collisions.
//
// The table starts at 1 (114 of the 142 take 1 cycle) and only the exceptions are
// listed, so they can be audited at a glance against the SH-2 timings.
//
// HISTORY: this was already in on 23-07 (-33% of time per frame in
// the SF Alpha and -37% in the Rally) and was lost on 24-07 in a reset that reverted
// an ENTIRE batch of changes because one of them broke the browser. It comes back alone, without
// the other three from the original package (VDP1 by budget, DMA with bus cost, VDP2
// migrated), precisely so it can be tested in isolation.
const SH2_CYCLES = (function()
{
	const t = new Uint8Array(65536).fill(1);
	// Expands a 16-bit pattern (fixed 0/1, n/m/i/d wildcards) into all of its opcodes.
	const put = (pattern, cycles) =>
	{
		let mask = 0, val = 0;
		const free = [];
		for(let b = 0; b < 16; b++)
		{
			const c = pattern[b], bit = 15 - b;
			if(c === "0") mask |= (1 << bit);
			else if(c === "1"){ mask |= (1 << bit); val |= (1 << bit); }
			else free.push(bit);
		}
		for(let k = 0; k < (1 << free.length); k++)
		{
			let op = val;
			for(let j = 0; j < free.length; j++) if(k & (1 << j)) op |= (1 << free[j]);
			t[op] = cycles;
		}
	};
	put("11000011iiiiiiii", 8);   // TRAPA #imm
	put("0011nnnnmmmm1101", 4);   // DMULS.L Rm,Rn
	put("0011nnnnmmmm0101", 4);   // DMULU.L Rm,Rn
	put("0000nnnnmmmm1111", 4);   // MAC.L @Rm+,@Rn+
	put("0000nnnnmmmm0111", 4);   // MUL.L Rm,Rn
	put("0100nnnn00011011", 4);   // TAS.B @Rn
	put("0000000000101011", 4);   // RTE
	put("0100nnnnmmmm1111", 3);   // MAC.W @Rm+,@Rn+
	put("0010nnnnmmmm1111", 3);   // MULS.W Rm,Rn
	put("0010nnnnmmmm1110", 3);   // MULU.W Rm,Rn
	put("11001101iiiiiiii", 3);   // AND.B #imm,@(R0,GBR)
	put("11001111iiiiiiii", 3);   // OR.B  #imm,@(R0,GBR)
	put("11001100iiiiiiii", 3);   // TST.B #imm,@(R0,GBR)
	put("11001110iiiiiiii", 3);   // XOR.B #imm,@(R0,GBR)
	put("0100mmmm00000111", 3);   // LDC.L @Rm+,SR
	put("0100mmmm00010111", 3);   // LDC.L @Rm+,GBR
	put("0100mmmm00100111", 3);   // LDC.L @Rm+,VBR
	put("0000000000011011", 3);   // SLEEP
	put("1010dddddddddddd", 2);   // BRA label
	put("0000mmmm00100011", 2);   // BRAF Rm
	put("1011dddddddddddd", 2);   // BSR label
	put("0000mmmm00000011", 2);   // BSRF Rm
	put("0100mmmm00101011", 2);   // JMP @Rm
	put("0100mmmm00001011", 2);   // JSR @Rm
	put("0000000000001011", 2);   // RTS
	put("0100nnnn00000011", 2);   // STC.L SR,@-Rn
	put("0100nnnn00010011", 2);   // STC.L GBR,@-Rn
	put("0100nnnn00100011", 2);   // STC.L VBR,@-Rn
	// BT/BF and BT/S BF/S cost 1 when they do NOT branch (what the table leaves) and more when they do:
	// that extra is added by group8() at the moment the branch is taken, because it depends on the
	// T flag and cannot be known at decode time.
	return t;
})();
// EXTRA cycles when the conditional actually branches: BT/BF go from 1 to 3 (+2),
// BT/S and BF/S from 1 to 2 (+1).
const SH2_EXTRA_JUMP = 2;
const SH2_EXTRA_JUMP_S = 1;

class SH2
{
	constructor(bus, name)
	{
		this.bus = bus;
		this.name = name || "SH2";       // "master" or "slave"
		this.slave = (name === "slave");

		// BCR1 (0xFFFFFFE0): bit 15 = MASTER, the bit that tells the TWO SH-2s apart. On the
		// real chip it is set by a pin, so it is READ-ONLY: it survives reset and
		// writes. Both CPUs start at the SAME reset vector and it is the
		// BIOS itself that checks this bit to know which one it is running on
		// (disassembly of BIOS 1.01a at 0x20000204):
		//     MOV.L @(0xd0,PC),R1   ; R1 = 0xFFFFFFE0 (BCR1)
		//     MOV.L @R1,R0          ; R0 = BCR1
		//     SHLL16 R0 / SHLL R0   ; bit 15 ends up in the T flag
		//     BT 0x2000022a         ; T=1 -> I am the SLAVE
		// Without this bit the slave would take the MASTER's path and boot the whole
		// console again on top of the master. Ported from Yabause (sh2core.c: SH2Init
		// "SSH2->onchip.BCR1 = 0x8000" and OnchipReset "preserve MASTER bit").
		this.bcr1 = this.slave ? 0x8000 : 0x0000;

		this.r = new Int32Array(16);         // R0-R15 (R15 = stack pointer)

		this.pc = 0;                         // Program Counter
		// Idle-loop skip: when the CPU spins in a spin loop waiting for something external (the
		// other CPU, a DMA, an interrupt) to change an address, running the loop millions
		// of times is pure waste. We detect the loop by comparing the COMPLETE ARCHITECTURAL
		// STATE between two passes through the same target: if it is identical and no memory was
		// written, spinning again is a provable no-op and we skip it (see step()).
		this.idle = false;                   // in a confirmed idle loop (do not execute until the next event)
		this.idleBackPC = -1;                // target of the last short backward branch
		this.writeOnWrap = false;      // there was a memory write since the last back-branch
		this.readInternalReg = false;         // the loop read an internal register (FRT/WDT/DIVU): it advances on its own, it is not idle
		this.idleSnap = new Int32Array(22);  // snapshot: R0-15 + SR, GBR, VBR, PR, MACH, MACL
		this.pr = 0;                         // Procedure Register (return)
		this.gbr = 0;                        // Global Base Register
		this.vbr = 0;                        // Vector Base Register
		this.sr = 0;                         // Status Register (T/S/Q/M + IMASK)
		this.mach = 0;                       // Multiply-ACcumulate High
		this.macl = 0;                       // Multiply-ACcumulate Low

		this.cycles = 0;
		this.halted = false;               // true if it hit an illegal opcode
		this.sleeping = false;              // true after SLEEP (waits for an interrupt)
		this.nmiPending = false;                // NMI pending (IMASK does NOT filter it)

		// PC history for the illegal() post-mortem. The dump only shows WHERE
		// the core died (empty memory); this says WHERE IT CAME FROM -the jump that sent it
		// there-, which is the question the dump does not answer. Ring buffer of 16: the
		// slave does not have the external history the master builds in index.html/stepsBlock.
		// OFF by default: recording on every step() is a hot path and perf is already
		// tight. It is turned on from the console (cpuSlave.tracing = true) before
		// reproducing the hang.
		this.tracing = false;
		this.histPc = new Int32Array(16);
		this.histIdx = 0;

		// Pending interrupts: a list of {level, vector}. The one with the highest
		// level above IMASK is served; the rest keep waiting (they are NOT lost).
		this.irqPending = [];
		this.irqLevelMax = -1;         // highest level in irqPending, cached for runDry

		// --- Cache data array (0xC0000000): 4 KB usable as CPU RAM ---
		// Each SH-2 has its own (it is ITS cache). See isDataArray().
		this.cacheData = new Uint8Array(0x1000);

		// ---------- INSTRUCTION cache ----------
		// 4 KB: 4 ways x 64 sets x 16-byte lines, same as the chip. BOUNDED BY
		// CONSTRUCTION (fixed-size arrays): it cannot grow or leak memory.
		// It caches ONLY instruction fetch, never data. That is on purpose: the slave
		// polls the master's mailboxes with DATA READS, and caching that would leave it blind to
		// what the master writes (it would hang forever). Instructions alone are enough
		// for what needs fixing.
		// WHY IT IS NEEDED (measured, diag/sfa-slave-death.mjs): the SF Alpha ERASES the
		// slave's code (0x0600ff12) while the slave is executing it, without turning it off
		// first through SSHOFF -> the slave executes zeros and dies, in a loop, and the game never
		// gets to the fight. On the real hardware the slave survives because it spins from ITS cache, which
		// is NOT coherent with what the master or the DMA write (each CPU
		// has its own cache and they do not snoop each other). The SFA turns on the slave's cache (CCR=0x01,
		// measured in diag/ccr-usage.mjs), so this is the missing piece.
		this.icData = new Uint8Array(4096);        // 4 ways * 64 sets * 16 bytes
		this.icTags  = new Int32Array(256).fill(-1);// tag per (set,way); -1 = empty
		this.icWay   = new Uint8Array(64);          // round-robin replacement, per set
		this.cacheOn = false;                       // CCR bit 0 (CE), cached: not reread on every instruction
		this.icLastLine = -1;                       // shortcut: last line served (addr >>> 4)
		this.icLastIdx = -1;                         // and its (set,way) index in icData

		// Fetch PAGE shortcut (see readInstr / _fetchSlow). It keeps the buffer of the
		// 64 KB page where the PC is: the common case -staying in the same one- is resolved
		// with one comparison and two reads, without the three calls of the normal path.
		this._fetchPage  = -1;
		this._fetchBuf  = null;
		this._fetchMask = 0;

		// --- SH7604 on-chip peripherals (0xFFFFFE00-0xFFFFFFFF) ---
		// The SH-2 has its peripherals mapped at the top of the address space.
		// They do NOT go out to the bus: the CPU itself handles them. The BIOS does ALL its divisions
		// with the DIVU (hardware divider), so it is mandatory for it to boot.
		this.divu = {
			dvsr: 0,        // DVSR   (0xFFFFFF00) divisor
			dvdnth: 0,      // DVDNTH (0xFFFFFF10) dividend high / remainder when done
			dvdntl: 0,      // DVDNTL (0xFFFFFF14) dividend low / quotient when done
			dvdntuh: 0,     // DVDNTUH(0xFFFFFF18) copy of the remainder
			dvdntul: 0,     // DVDNTUL(0xFFFFFF1C) copy of the quotient
			dvcr: 0,        // DVCR   (0xFFFFFF08) control: bit0=OVF, bit1=OVFIE
			vcrdiv: 0       // VCRDIV (0xFFFFFF0C) vector of the overflow interrupt
		};
		// On-chip DMAC (2 channels). Games use it to move data (from the CD, from
		// WRAM to the VDP...) and then POLL the TE bit of CHCR waiting for the end. Without
		// the DMAC, CHCR returned the last value written (DE=1, TE=0) and the game spun
		// forever: it starts, shows the license screen, and never draws.
		this.dmac = {
			sar:    [0, 0],   // SAR0/SAR1   (0xFFFFFF80 / 0xFFFFFF90) source address
			dar:    [0, 0],   // DAR0/DAR1   (0xFFFFFF84 / 0xFFFFFF94) destination address
			tcr:    [0, 0],   // TCR0/TCR1   (0xFFFFFF88 / 0xFFFFFF98) transfer count
			chcr:   [0, 0],   // CHCR0/CHCR1 (0xFFFFFF8C / 0xFFFFFF9C) control (bit0=DE bit1=TE bit2=IE)
			vcrdma: [0, 0],   // VCRDMA0/1   (0xFFFFFFA0 / 0xFFFFFFA8) vector of the end interrupt
			// DRCR0/DRCR1 (0xFFFFFE71 / 0xFFFFFE72): which source the request comes from when the
			// channel is NOT in auto-request. Bits 1-0 = RS1/RS0. Initial H'00.
			drcr:   [0, 0],
			dmaor:  0         // DMAOR       (0xFFFFFFB0) bit0=DME bit1=NMIF bit2=AE bit3=PR
		};

		// On-chip FRT (Free-Running Timer). The FRC (0xFFFFFE12/13) lives in the raw array
		// internalRegs, which already handles the byte access the hardware requires. OCRA and
		// OCRB, on the other hand, CANNOT live there: they SHARE the address 0xFFFFFE14/15 and the
		// OCRS bit of TOCR picks which one is visible,
		// so they need state of their own.
		this.frt = {
			ocra:  0xFFFF,   // OCRA (0xFFFFFE14/15 with OCRS=0). Reset H'FFFF
			ocrb:  0xFFFF,   // OCRB (0xFFFFFE14/15 with OCRS=1). Reset H'FFFF
			remainder: 0,        // CPU cycles that have not yet completed a prescaler tick
			// CACHED prescaler: it is recalculated only when the game writes TCR (via
			// _frtRecalc), not on every instruction. Before, _frtRun read TCR and recalculated
			// the shift 642k times per frame (4.4 ms/frame measured) — it was the SH-2's bottleneck.
			shift: 3,        // TCR reset = CKS 0 -> f/8 -> shift 3
			period: 8,      // 1 << shift
			active: true     // CKS != 3 (with the internal clock; CKS=3 would be external FTCI, not wired)
		};

		// On-chip WDT (Watchdog Timer). WTCSR/WTCNT/RSTCSR live in the raw array
		// internalRegs (0x80/0x81/0x83, which are their READ addresses); here only goes
		// the prescaler remainder, same as in the FRT.
		this.wdt = {
			remainder: 0,        // CPU cycles that have not yet completed a WTCNT tick
			// CACHED prescaler, same as the FRT: it is recalculated only when WTCSR is written
			// (via _wdtRecalc). Before, _wdtRun read WTCSR and recalculated the shift on every
			// instruction (4.0 ms/frame measured).
			shift: 1,        // WTCSR reset -> CKS 0 -> /2 -> shift 1
			period: 2,      // 1 << shift
			active: false    // TME off at reset
		};

		// SCI (serial port). Its registers live in internalRegs (0x00-0x05); here goes the
		// state of the TRANSMITTER, which is what the raw bank cannot represent.
		//? Only transmission is modeled. Reception (RDRF, ORER, FER, PER) stays in the
		//? raw bank: on a stock Saturn there is nothing connected that answers, so there is
		//? no data to verify when those flags should be raised.
		this.sci = {
			tsrUntil: 0,        // CPU cycle at which TSR finishes shifting out the character (0 = free)
			cyclesChar: 0   // character length in cycles (see _sciRecalc)
		};

		// Remaining on-chip registers (cache, BSC, INTC): stored raw
		// (reading returns what was written). Enough for the BIOS to move forward.
		this.internalRegs = new Uint8Array(0x200);
		this._resetInternalReg();
	}

	// The interrupt controller (SCU) requests an interrupt with a level and a vector.
	// Dedup by vector: the line stays asserted, it is not queued twice.
	requestInterrupt(level, vector)
	{
		level &= 0xF; vector &= 0xFF;
		for(const q of this.irqPending)
			if(q.vector === vector) { q.level = level; if(level > this.irqLevelMax) this.irqLevelMax = level; return; }
		this.irqPending.push({ level: level, vector: vector });
		// Highest level in the queue, so runDry can decide in O(1) whether there is something
		// SERVABLE without walking it (see the comment on its guard).
		if(level > this.irqLevelMax) this.irqLevelMax = level;
	}

	// NMI (Non Maskable Interrupt): the SMPC uses it to wake the SH-2 up after
	// a clock change (CKCHG320/CKCHG352). Unlike normal
	// interrupts, the SR's IMASK does NOT filter it: it is always served. It is essential
	// because the BIOS does "SLEEP; BRA self" (parks itself) right after requesting the
	// CKCHG, with IMASK at 15: without NMI NOTHING wakes it up and the CPU sleeps
	// forever (the cycles stay frozen and it looks like the emulator hung).
	requestNmi()
	{
		this.nmiPending = true;
	}

	// Serves the NMI: pushes SR and PC like a normal exception, but with FIXED vector 11
	// (SH-2 table) and without looking at IMASK. The SH-2 enters with IMASK at 15.
	_serveNmi()
	{
		this.nmiPending = false;
		this.sleeping = false;
		this.idle = false;                   // waking from idle: the PC goes to the handler, not to the loop
		this.r[15] = (this.r[15] - 4) | 0;
		this.writeLong(this.r[15] >>> 0, this.sr >>> 0);
		this.r[15] = (this.r[15] - 4) | 0;
		this.writeLong(this.r[15] >>> 0, this.pc >>> 0);
		this.sr = (this.sr & ~0xF0) | 0xF0;
		this.pc = this.readLong((this.vbr + 11 * 4) >>> 0) >>> 0;
	}

	// Handles an interrupt: pushes SR and PC, raises IMASK to the level, jumps to the vector.
	_serveInterrupt(level, vector)
	{
		this.sleeping = false;
		this.idle = false;                   // waking from idle: the PC goes to the handler, not to the loop
		this.r[15] = (this.r[15] - 4) | 0;
		this.writeLong(this.r[15] >>> 0, this.sr >>> 0);
		this.r[15] = (this.r[15] - 4) | 0;
		this.writeLong(this.r[15] >>> 0, this.pc >>> 0);
		this.sr = (this.sr & ~0xF0) | ((level & 0xF) << 4);
		this.pc = this.readLong((this.vbr + vector * 4) >>> 0) >>> 0;
	}

	// --- Status Register flags ---
	get flagT()   { return this.sr & 0x1; }
	set flagT(v)  { this.sr = v ? (this.sr | 0x1) : (this.sr & ~0x1); }
	get flagS()   { return (this.sr >> 1) & 0x1; }
	set flagS(v)  { this.sr = v ? (this.sr | 0x2) : (this.sr & ~0x2); }
	get flagQ()   { return (this.sr >> 8) & 0x1; }
	set flagQ(v)  { this.sr = v ? (this.sr | 0x100) : (this.sr & ~0x100); }
	get flagM()   { return (this.sr >> 9) & 0x1; }
	set flagM(v)  { this.sr = v ? (this.sr | 0x200) : (this.sr & ~0x200); }

	// Reset: the SH-2 reads the initial PC and SP from the vector table (at boot, the BIOS).
	reset()
	{
		// Clear all state: a warm reset must not drag old registers along.
		for(let i = 0; i < 15; i++) this.r[i] = 0;
		this.pr = 0; this.gbr = 0; this.vbr = 0; this.mach = 0; this.macl = 0;

		this.pc = this.readLong(0x00000000) >>> 0;
		this.idle = false; this.idleBackPC = -1; this.writeOnWrap = false; this.readInternalReg = false;   // the PC jumped to the vector: cut idle detection
		this.r[15] = this.readLong(0x00000004) | 0;
		this.sr = 0x000000F0;                // IMASK = 15 (interrupts masked)
		this.halted = false;
		this.sleeping = false;
		this.nmiPending = false;
		this.irqPending = [];
		this.irqLevelMax = -1;
		this.cycles = 0;

		this.divu.dvsr = 0; this.divu.dvdnth = 0; this.divu.dvdntl = 0;
		this.divu.dvdntuh = 0; this.divu.dvdntul = 0; this.divu.dvcr = 0; this.divu.vcrdiv = 0;
		for(let ch = 0; ch < 2; ch++)
		{
			this.dmac.sar[ch] = 0; this.dmac.dar[ch] = 0; this.dmac.tcr[ch] = 0;
			this.dmac.chcr[ch] = 0; this.dmac.vcrdma[ch] = 0;
			this.dmac.drcr[ch] = 0;   // initialized to H'00 by a reset
		}
		this.dmac.dmaor = 0;
		this._resetInternalReg();
		// The MASTER bit (15) is NOT cleared: it is set by a pin of the chip, not by reset. The rest
		// of BCR1 returns to its power-on value H'03F0 (Yabause, OnchipReset).
		this.bcr1 = (this.bcr1 & 0x8000) | 0x03F0;
	}

	// Reset values of the on-chip registers. Most start at zero, but a
	// few do NOT, and setting them to zero is not "almost the same": with OCRA=0 instead of H'FFFF the
	// output compare A matches as soon as the FRC starts running, and if the game turned on CCLRA
	// the FRC stays STUCK at 0 forever (every timeout that looks at it hangs).
	// All the values are the SH7604's register initial values, as the chip leaves them
	// after a power-on reset.
	_resetInternalReg()
	{
		const b = this.internalRegs;
		b.fill(0);
		// --- SCI ---
		b[0x01] = 0xFF;    // BRR    (0xFFFFFE01) bit rate register
		b[0x03] = 0xFF;    // TDR    (0xFFFFFE03) transmit data register
		b[0x04] = 0x84;    // SSR    (0xFFFFFE04) TDRE=1 + TEND=1: the transmitter starts empty
		// The transmitter state goes with the reset. It is MANDATORY to restore it here and not only in
		// the constructor: cpu.reset() sets this.cycles to 0, and an old tsrUntil measured against
		// the previous counter would stay in the future forever — the transmitter would never
		// start again. It is measurement trap #2, now on the emulator side.
		if(this.sci){ this.sci.tsrUntil = 0; this._sciRecalc(); }
		// --- FRT ---
		// CAREFUL with TIER: its H'01 is NOT an enabled interrupt. Bit 0 is a
		// reserved bit that ALWAYS reads 1; ICIE/OCIAE/OCIBE/OVIE all start at 0.
		b[0x10] = 0x01;    // TIER   (0xFFFFFE10)
		b[0x17] = 0xE0;    // TOCR   (0xFFFFFE17) bits 7-5 reserved, read 1
		// ICR (0xFFFFFEE0): a reset initializes ICR to H'8000 or H'0000 depending on the level of the
		// NMI pin. At rest the line is HIGH -the NMI is triggered on the falling
		// edge-, so the reset value is H'8000. The read rebuilds it anyway (see
		// readInternal), but the raw bank has to stay consistent.
		b[0xE0] = 0x80; b[0xE1] = 0x00;
		this.frt.ocra = 0xFFFF;   // OCRA (0xFFFFFE14/15, OCRS=0)
		this.frt.ocrb = 0xFFFF;   // OCRB (0xFFFFFE14/15, OCRS=1)
		this.frt.remainder = 0;
		// --- WDT ---
		// The READ addresses are FE80/FE81/FE83 (writes go to FE80/FE82 with the
		// magic byte, see _writeWdt).
		b[0x80] = 0x18;    // WTCSR  (0xFFFFFE80). Bits 4-3 are reserved and read 1
		b[0x81] = 0x00;    // WTCNT  (0xFFFFFE81). Initialized to H'00 by a reset
		b[0x83] = 0x1F;    // RSTCSR (0xFFFFFE83). Bits 4-0 are reserved and read 1
		this.wdt.remainder = 0;
		// Sync the cached FRT/WDT prescaler with the freshly reset registers.
		this._frtRecalc(); this._wdtRecalc();
		// Instruction cache: CCR starts at 0 (cache off) and the cache empty.
		this.icTags.fill(-1); this.icWay.fill(0); this.cacheOn = false; this.icLastLine = -1; this.icLastIdx = -1;
		// And the fetch page shortcut: between the reset and now the memory map could have
		// changed (a new BIOS, a cartridge), and its buffer would be left hanging from the old one.
		this.invalidateFetch();
		// --- Power-down ---
		b[0x91] = 0x60;    // SBYCR  (0xFFFFFE91)
		// --- BSC ---
		// Like BCR1, the real register is the LOW 16 bits of the long, so the
		// value is left in the low half: both the long and the word read it correctly.
		// BCR1 does not go here: it has the MASTER bit, which reset CANNOT overwrite (see reset()).
		b[0x1E6] = 0x00; b[0x1E7] = 0xFC;   // BCR2 (0xFFFFFFE4) = H'00FC
		b[0x1EA] = 0xAA; b[0x1EB] = 0xFF;   // WCR  (0xFFFFFFE8) = H'AAFF
	}

	// FRT input capture: the DOORBELL the two SH-2s use to signal each other. On the Saturn the
	// FTI pin (input capture) of each one is wired so that the OTHER CPU triggers it
	// by writing a WORD to a bus address: 0x21000000 rings the doorbell of the
	// SLAVE and 0x21800000 that of the MASTER (see the routing in bus.js _mmioWrite).
	// Raises ICF (bit 7 of FTCSR) and copies FRC into FICR. The slave's command dispatcher
	// that the game leaves in WRAM polls EXACTLY this bit:
	//     MOV.B @R12,R2   ; R12 = 0xFFFFFE11 (FTCSR)
	//     AND R13,R2      ; R13 = 0x80 (ICF)
	//     CMP/EQ R13,R2   ; did a command arrive?
	//     MOV.B R14,@R12  ; acknowledges it (clears FTCSR) and jumps to the handler
	// NO LONGER A -ISM: this was ported from Yabause (sh2core.c,
	// SSH2InputCaptureWriteWord / MSH2InputCaptureWriteWord) and marked as such. It is
	// confirmed now, with the exact addresses: the FRT input capture signal
	// can be input to the slave CPU by writing any 16-bit value to address 21000000H.
	// The FRT input capture signal can also be input to the master CPU by writing any
	// 16-bit value to address 21800000H. That matches exactly what we already had,
	// including that it is a 16-BIT (word) write
	// and not a byte or long one.
	// How the slave is left at power-on is confirmed as well: the boot ROM
	// sets VBR=0x6000400, SP=0x6001000 and enables the FRT input capture
	// interrupt (64H, level 15) — so the doorbell comes in through vector 0x64 at
	// level 15, which is the ICIE below.
	inputCapture()
	{
		const b = this.internalRegs;
		b[0x11] |= 0x80;                       // FTCSR: ICF (Input Capture Flag)
		b[0x18] = b[0x12]; b[0x19] = b[0x13];  // FICR = copy of the current FRC
		// It also interrupts if TIER has ICIE (bit 7) enabled. The slave's dispatcher
		// leaves it OFF (TIER=0x01) and polls the flag, so in practice
		// this branch is not used; it stays anyway because Yabause has it and other games may
		// need it. Level = IPRB>>8 (0x60), vector = VCRC>>8 (0x66).
		if(b[0x10] & 0x80)
			this.requestInterrupt(b[0x60] & 0xF, b[0x66] & 0x7F);
	}

	// ---------- SH7604 on-chip FRT (Free-Running Timer) ----------
	// The FRC (free-running counter, 0xFFFFFE12/13) is a 16-bit counter that counts up
	// on its own with the CPU clock divided by the TCR prescaler. It is THE stopwatch that
	// a game has at hand without depending on the VDP or anyone else; the typical
	// pattern is:
	//     start = FRC; while((FRC - start) < N);      // wait N ticks
	// With the FRC stuck always returning the last value written, that subtraction gives 0
	// FOREVER: the game spins eternally and does NOT throw any error. It is a silent hang.
	// Level of all the FRT interrupts: IPRB bits 11-8 (FRTIP, 0xFFFFFE60).

	// Runs the FRT for the given CPU cycles. The prescaler gathers the loose cycles in
	// this.frt.remainder until a counter tick is completed.
	// Recalculates the FRT's cached prescaler from TCR. Called ONLY when the game
	// writes TCR (0xFFFFFE16) and at reset — not on every instruction.
	// TCR bits 1-0 = CKS1/CKS0: 00 = f/8, 01 = f/32, 10 = f/128, 11 = EXTERNAL clock
	// through the FTCI pin. On the Saturn FTCI is not wired, so with CKS=11 the FRC does not
	// advance (active=false, it is not an oversight).
	_frtRecalc()
	{
		const cks = this.internalRegs[0x16] & 0x3;
		this.frt.active  = (cks !== 3);
		this.frt.shift   = 3 + cks * 2;               // /8 -> 3, /32 -> 5, /128 -> 7
		this.frt.period = 1 << this.frt.shift;
	}

	// Runs the FRT for the given cycles using the CACHED prescaler. The common path
	// (total < period) is just adding to the remainder: no reading TCR or recalculating the shift.
	// The slow path (>= period, i.e. a tick) is identical to the original.
	_frtRun(cycles)
	{
		const f = this.frt;
		if(!f.active) return;
		const total = f.remainder + cycles;
		if(total < f.period){ f.remainder = total; return; }
		f.remainder = total & (f.period - 1);
		let steps = total >>> f.shift;
		while(steps-- > 0) this._frtIncrement();
	}

	// One FRC tick: increments and evaluates overflow and both output compares.
	// The flags are raised on EXACT EQUALITY, not on crossing: the set condition
	// is that the FRC value becomes equal to OCRA. The difference
	// matters with OCR=0, where the match falls right when the counter wraps around.
	//? Yabause (sh2core.c FRTExec) uses a crossing test "frctemp >= ocra && frcold < ocra",
	//? which with OCRA=0 NEVER matches, and it also sends all three interrupts to the
	//? input capture vector (vcrc >> 8). Here we follow the hardware, not Yabause. //ok, 16-07-2026
	_frtIncrement()
	{
		const b = this.internalRegs;
		let frc = (((b[0x12] << 8) | b[0x13]) + 1) & 0xFFFF;

		// Overflow: OVF (FTCSR bit 1) is raised when going from H'FFFF to H'0000.
		// Interrupts if OVIE (TIER bit 1). Vector FOVV = VCRD bits 14-8 (0xFFFFFE68).
		if(frc === 0)
		{
			b[0x11] |= 0x02;
			if(b[0x10] & 0x02) this.requestInterrupt(b[0x60] & 0xF, b[0x68] & 0x7F);
		}

		// Output compare A: OCFA (FTCSR bit 3), interrupts if OCIAE (TIER bit 3).
		// The clear by CCLRA is applied AFTER evaluating comparator B: on the chip both
		// look at the SAME FRC value on the same edge, so clearing first would
		// force a match on an OCRB=0.
		let clear = false;
		if(frc === this.frt.ocra)
		{
			b[0x11] |= 0x08;
			if(b[0x10] & 0x08) this.requestInterrupt(b[0x60] & 0xF, b[0x67] & 0x7F);
			clear = (b[0x11] & 0x01) !== 0;   // CCLRA (FTCSR bit 0): the FRC goes back to 0
		}
		// Output compare B: OCFB (FTCSR bit 2), interrupts if OCIBE (TIER bit 2). It shares
		// the FOCV vector with A (VCRC bits 6-0, 0xFFFFFE67): it is the same OCI line.
		if(frc === this.frt.ocrb)
		{
			b[0x11] |= 0x04;
			if(b[0x10] & 0x04) this.requestInterrupt(b[0x60] & 0xF, b[0x67] & 0x7F);
		}
		if(clear) frc = 0;

		b[0x12] = frc >> 8; b[0x13] = frc & 0xFF;
	}

	// OCRA and OCRB share the address 0xFFFFFE14/15: the OCRS bit (bit 4) of TOCR
	// picks which of the two the access hits. It does NOT affect the operation of the
	// comparators, only access from the CPU.
	_ocrIsB() { return (this.internalRegs[0x17] & 0x10) !== 0; }

	_readOcr(off, size)
	{
		const v = this._ocrIsB() ? this.frt.ocrb : this.frt.ocra;
		if(size === 1) return (off === 0x14) ? ((v >> 8) & 0xFF) : (v & 0xFF);
		return v & 0xFFFF;   // the hardware requires byte access, but the H:L pair reads the same
	}

	_writeOcr(off, value, size)
	{
		const previous = this._ocrIsB() ? this.frt.ocrb : this.frt.ocra;
		let v;
		if(size !== 1)         v = value & 0xFFFF;
		else if(off === 0x14) v = ((value & 0xFF) << 8) | (previous & 0xFF);
		else                  v = (previous & 0xFF00) | (value & 0xFF);
		if(this._ocrIsB()) this.frt.ocrb = v; else this.frt.ocra = v;
	}

	// ---------- SH7604 on-chip WDT (Watchdog Timer) ----------
	// A single channel, with
	// TWO modes selected by the WT/IT bit of WTCSR:
	//   - Interval timer (WT/IT=0): every WTCNT overflow raises OVF and requests an
	//     ITI interrupt. It is a normal periodic timer.
	//   - Watchdog (WT/IT=1): the software has to rewrite WTCNT before it
	//     overflows; if it does not, the chip outputs WDTOVF and -if RSTE is set- it
	//     resets itself.
	// Until today the three registers were stored raw: WTCNT never ran, so
	// interval mode never fired its IRQ and a watchdog reset never happened.
	// On top of that, writing was BROKEN (see _writeWdt).

	// WTCNT prescaler by CKS2-CKS0 (WTCSR bits 2-0):
	//   000 = /2, 001 = /64, 010 = /128, 011 = /256, 100 = /512, 101 = /1024,
	//   110 = /4096, 111 = /8192. CAREFUL: the jump from /2 to /64 is NOT a regular progression
	//   like the FRT's, it is the hardware's table as is. Matches Yabause (sh2core.c:1546-1571).
	//ok, 16-07-2026
	static get WDT_SHIFT() { return [ 1, 6, 7, 8, 9, 10, 12, 13 ]; }

	// Runs the WDT for the given CPU cycles. The prescaler gathers the loose cycles in
	// this.wdt.remainder until a tick is completed, same as the FRT.
	// Recalculates the WDT's cached prescaler from WTCSR. Called ONLY when
	// WTCSR (0x80) is written and at reset.
	// TME (WTCSR bit 5) is the ONLY thing that gates counting: when the timer enable bit (TME)
	// is set to 1, the watchdog timer counter starts counting.
	//? Yabause also stops the counter if OVF or WOVF are set (sh2core.c:2041). The
	//? hardware does NOT do that: the interval timer overflows AGAIN AND
	//? AGAIN, with an ITI on every overflow: an interval timer interrupt (ITI) is generated
	//? EACH TIME the WTCNT overflows. With Yabause's brake a game that does not clear OVF
	//? would get ONE SINGLE ITI in the whole session. We go with the hardware: here only TME stops it.
	_wdtRecalc()
	{
		const w = this.internalRegs[0x80];
		this.wdt.active  = (w & 0x20) !== 0;
		this.wdt.shift   = SH2.WDT_SHIFT[w & 0x7];
		this.wdt.period = 1 << this.wdt.shift;
	}

	// Runs the WDT for the given cycles with the CACHED prescaler (same scheme as the FRT).
	_wdtRun(cycles)
	{
		const w = this.wdt;
		if(!w.active) return;
		const total = w.remainder + cycles;
		if(total < w.period){ w.remainder = total; return; }
		w.remainder = total & (w.period - 1);
		let steps = total >>> w.shift;
		while(steps-- > 0) this._wdtIncrement();
	}

	// One WTCNT tick: increments and, if it overflowed from H'FF to H'00, acts according to the mode.
	_wdtIncrement()
	{
		const b = this.internalRegs;
		const cnt = (b[0x81] + 1) & 0xFF;
		b[0x81] = cnt;
		if(cnt !== 0) return;   // overflows (changes from H'FF to H'00)

		if(b[0x80] & 0x40) this._wdtOverflowWatchdog();
		else               this._wdtOverflowInterval();
	}

	// Overflow in INTERVAL TIMER mode (WT/IT=0): OVF + ITI interrupt.
	_wdtOverflowInterval()
	{
		const b = this.internalRegs;
		b[0x80] |= 0x80;   // OVF (WTCSR bit 7). It is not set in watchdog timer mode
		// Level = IPRA bits 7-4 (WDTIP, 0xFFFFFEE2) and vector = VCRWDT bits 14-8
		// (WITV, 0xFFFFFEE4). IPRA is a big-endian word: its bits 7-4 are the
		// HIGH nibble of the byte at 0xFEE3.
		this.requestInterrupt((b[0xE3] >> 4) & 0xF, b[0xE4] & 0x7F);
	}

	// Overflow in WATCHDOG mode (WT/IT=1): WOVF and, with RSTE, internal reset of the chip.
	// Yabause does not even try: "Watchdog Timer
	// Mode(untested) / LOG(Watchdog timer(WDT mode) overflow not implemented)"
	// (sh2core.c:2065-2068).
	_wdtOverflowWatchdog()
	{
		const b = this.internalRegs;
		b[0x83] |= 0x80;   // WOVF (RSTCSR bit 7). It is not set in interval timer mode
		// RSTE=0 (initial value) means not reset when WTCNT overflows: the LSI is not reset
		// internally, but WTCNT and WTCSR are reset within the WDT. The chip stays alive
		// but the WDT itself resets.
		if(!(b[0x83] & 0x40))
		{
			b[0x81] = 0x00;   // WTCNT
			b[0x80] = 0x18;   // WTCSR (the reserved bits 4-3 read 1 again)
			this.wdt.remainder = 0;
			return;
		}
		// RSTE=1: a signal to reset the chip is generated internally simultaneously
		// with the WDTOVF signal when WTCNT overflows. RSTS selects power-on or
		// manual reset; here both fall into the same reset() (we do not model the difference,
		// which is that a manual reset respects the bus transfers in progress).
		// RSTCSR is NOT reinitialized: it is initialized to H'1F by input of a reset
		// signal on the RES pin, but is NOT initialized by the internal reset signal
		// generated by a WDT overflow. Thanks to that the software can read
		// WOVF=1 at boot and know it was woken by the watchdog and not by the reset button.
		const rstcsr = b[0x83];
		this.reset();
		this.internalRegs[0x83] = rstcsr;
	}

	// Writing the WDT registers. IT IS DIFFERENT FROM ALL THE REST OF THE CHIP:
	// these registers must be written by a WORD
	// transfer instruction, and WTCNT and WTCSR both have the same write address. The write
	// data goes in the LOWER byte of the written word. The upper byte must be
	// H'5A (for WTCNT) or H'A5 (for WTCSR).
	// WITHOUT this the generic path stored the two raw bytes: a "MOV.W R0,@R1" with
	// R0=0xA518 (that is, WTCSR <- 0x18, the most ordinary thing in the world) left WTCSR=0xA5 -the
	// MAGIC byte- and WTCNT=0x18. Both registers ended up with garbage from a single write.
	// It takes the WHOLE range 0x80-0x83 so that no access slips through to the raw
	// path: the only valid WDT writes are a word to 0x80 and a word to 0x82.
	// 0x81 (WTCNT) and 0x83 (RSTCSR) are READ addresses, and writing them
	// would dodge the magic byte, which is exactly the protection the chip wants.
	//ok, 16-07-2026
	_writeWdt(off, value, size)
	{
		const b = this.internalRegs;
		// Word only. It cannot be written by byte or longword transfer instructions.
		if(size !== 2) return;
		const high = (value >> 8) & 0xFF, data = value & 0xFF;

		if(off === 0x80)
		{
			if(high === 0x5A) { b[0x81] = data; return; }               // WTCNT
			if(high !== 0xA5) return;                                   // invalid magic byte
			// WTCSR, bit by bit:
			//   7   OVF   R/(W): only 0 can be written to bit 7, to clear the flag
			//             -> new = old AND written,
			//             so a 0 clears it and a 1 leaves it as it was. It is the same pattern
			//             as the FRT's FTCSR.
			//             //? Yabause does "WTCSR = (u8)val | 0x18" (sh2core.c:1577), which
			//             //? lets a write of 1 RAISE OVF by hand and fire an ITI on its own.
			//             //? The hardware does not allow it.
			//   6-5 WT/IT and TME: normal R/W.
			//   4-3 reserved: always read 1.
			//   2-0 CKS2-CKS0: normal R/W.
			const tmeBefore = b[0x80] & 0x20;
			b[0x80] = ((b[0x80] & data) & 0x80) | (data & 0x67) | 0x18;
			// WTCNT is initialized to H'00 by a reset and WHEN THE TME BIT IS CLEARED TO
			// 0. Yabause does not do this: it only turns off its isenable flag and WTCNT
			// stays where it was.
			if(tmeBefore && !(b[0x80] & 0x20)) { b[0x81] = 0x00; this.wdt.remainder = 0; }
			this._wdtRecalc();   // TME/CKS may have changed the cached prescaler
			return;
		}
		if(off === 0x82)
		{
			// RSTCSR. Two different protocols:
			//   A500H  -> clears WOVF and does NOT touch RSTE/RSTS.
			//   5AxxH  -> writes RSTE (bit 6) and RSTS (bit 5) and does NOT touch WOVF.
			if(value === 0xA500) { b[0x83] &= 0x7F; return; }
			if(high === 0x5A) b[0x83] = (b[0x83] & 0x80) | (data & 0x60) | 0x1F;
		}
	}

	// CPU power-on (Yabause's SH2PowerOn): loads the PC and the stack pointer from the
	// vector table VBR points to. It is NOT a reset: it is what the SMPC does when it
	// sends SSHON to start the slave running (which was left reset, with VBR=0, since
	// the console reset) without touching the rest of its state.
	turnOn()
	{
		this.pc = this.readLong(this.vbr >>> 0) >>> 0;
		this.r[15] = this.readLong((this.vbr + 4) >>> 0) | 0;
	}

	// --- Sign extension helpers ---
	sign8(v)  { return (v & 0x80)   ? (v | 0xFFFFFF00) : v; }
	sign12(v) { return (v & 0x800)  ? (v | 0xFFFFF000) : v; }
	sign16(v) { return (v & 0x8000) ? (v | 0xFFFF0000) : v; }

	// ---------- CPU memory accesses ----------
	// Every access goes through here: if it falls in the SH7604's on-chip peripheral area
	// the CPU itself handles it; if not, it goes out to the bus.
	isInternalReg(addr) { return (addr >>> 0) >= 0xFFFFFE00; }

	// Cache DATA ARRAY (partition 110 = 0xC0000000-0xDFFFFFFF): the 4 KB of the
	// cache addressable as RAM ("cache-as-RAM", an SDK technique with the cache in
	// two-way mode; data array, read/write space, 4 KB, mirrored across
	// the whole partition). BEFORE, it fell to the bus masked to 27 bits -> the Boot
	// ROM page: writes were silently swallowed and reads returned bytes from the
	// BIOS — SILENT corruption that the MMIO radar cannot see (the page is valid).
	//ok, 18-07-2026
	isDataArray(addr) { return (addr >>> 29) === 6; }

	// CACHE PURGE area (0x40000000-0x5FFFFFFF, i.e. addr>>>29 === 2): writing there
	// invalidates the cache line that contains the mirrored address; it does NOT write to
	// memory. It is a NO-OP (Yabause, memory.c MappedMemoryWrite*Nocache: "case 0x2:
	// // Purge Area / return;").
	// It is ESSENTIAL for the slave: the BIOS boot loop purges and polls
	//     MOV.L R0,@R3   ; R3 = 0x46000240, R0 = 0  -> purges the mailbox line
	//     MOV.L @R1,R4   ; R1 = 0x06000240          -> reads the mailbox
	//     CMP/EQ R4,R6   ; R6 = 0x32524459 ("2RDY") -> the magic value the master leaves
	// Since the bus masks to 27 bits (addr & 0x07FFFFFF), without this 0x46000240
	// would fall on WRAM 0x06000240 and the slave would ERASE the mailbox it polls on every
	// pass: it would never boot.
	isPurge(addr) { return ((addr >>> 0) >>> 29) === 2; }

	// A loop that polls an internal COUNTER that goes up on its own with the clock -the timer's FRC
	// (0x12-0x13) or the watchdog's WTCNT (0x81)- is NOT idle even if the CPU state looks
	// stable for an instant: the counter advances anyway and the loop is waiting for it. Status flags,
	// on the other hand (FTCSR/ICF at 0x11, TIER...), are events set by ANOTHER chip, not by the passing of
	// time, so polling them IS idle. Telling the three offsets apart is what makes
	// the slave's spin on ICF get skipped but the FRC timeout not.
	_isInternalCounter(addr) { const o = addr & 0x1FF; return o === 0x12 || o === 0x13 || o === 0x81; }

	// ---------- Instruction cache: fetch, invalidation and purge ----------
	// FETCH. With the cache off (CE=0) or outside the cacheable partition (addr>>>29 != 0)
	// it goes straight to the bus, same as before: a game that does not turn it on changes in nothing.
	// A word never crosses a line (instructions are aligned to 2 and the line is
	// 16), so reading the two bytes from the same line is enough.
	readInstr(addr)
	{
		if(!this.cacheOn || (addr >>> 29) !== 0)
		{
			// PAGE SHORTCUT. Fetch is 13% of the frame (V8 profile, 25-07-2026) and almost
			// all of that cost is PATH, not work: readInstr -> SH2.readWord (two
			// range checks) -> Bus.readWord (the page table). Three calls and four
			// tests to get two bytes out of a Uint8Array.
			// But the PC does not jump pages: it stays in the SAME 64 KB page as the previous
			// fetch except on a long jump. Remembering its buffer, the common case comes down to
			// one comparison and two reads, with no calls. It is the same pattern that already worked
			// with the timers' prescaler and with icLastLine below: cache what almost
			// never changes and recalculate only when it changes.
			if((addr >>> 16) === this._fetchPage)
			{
				const b = this._fetchBuf, m = this._fetchMask;
				return ((b[addr & m] << 8) | b[(addr + 1) & m]) >>> 0;
			}
			return this._fetchSlow(addr);
		}
		// LAST LINE shortcut: code runs almost always in order, so two
		// consecutive fetches fall in the same 16-byte line. Remembering it avoids redoing the
		// search through the 4 ways in the common case (without this the cache cost ~4% of the frame).
		if((addr >>> 4) === this.icLastLine)
		{
			const du = this.icData, bu = (this.icLastIdx << 4) + (addr & 0xF);
			return ((du[bu] << 8) | du[bu + 1]) >>> 0;
		}
		const setIdx = (addr >>> 4) & 0x3F;
		const tag = (addr >>> 10) | 0;
		const i0 = setIdx << 2;                      // 4 contiguous ways per set
		const t = this.icTags;
		let idx = -1;
		if(t[i0] === tag)          idx = i0;
		else if(t[i0 + 1] === tag) idx = i0 + 1;
		else if(t[i0 + 2] === tag) idx = i0 + 2;
		else if(t[i0 + 3] === tag) idx = i0 + 3;
		if(idx < 0)
		{
			// Miss: the line is filled from memory and replaced round-robin (the chip
			// uses LRU; for what matters to us -that a hot loop stays resident- it makes no difference).
			const way = this.icWay[setIdx];
			this.icWay[setIdx] = (way + 1) & 3;
			idx = i0 + way;
			const line = (addr & ~0xF) >>> 0;
			const d = this.icData, b = idx << 4;
			for(let j = 0; j < 16; j++) d[b + j] = this.bus.readByte((line + j) >>> 0) & 0xFF;
			t[idx] = tag;
		}
		this.icLastLine = addr >>> 4; this.icLastIdx = idx;   // feeds the shortcut above
		const d = this.icData, b = (idx << 4) + (addr & 0xF);
		return ((d[b] << 8) | d[b + 1]) >>> 0;
	}

	// Long path of the fetch: resolves the address and, if it fell in flat memory (RAM or ROM
	// from the bus page table), leaves that page cached for the next fetches.
	//
	// NOTHING that is not flat memory is cached, and that is why the shortcut is safe:
	//   - the CPU's own internal registers (0xFFFFFE00+) and the cache data array
	//     (0xC0000000): they do not go out to the bus, SH2.readWord resolves them.
	//   - MMIO: it has no entry in the page table (this.bus.pages[p] is undefined),
	//     so it goes through readWord and is NOT cached.
	// The cache is invalidated when the bus rebuilds its pages (Bus._buildPages, e.g.
	// when a cartridge is inserted) and on CPU reset.
	//
	// A word never crosses a page: instructions are aligned to 2 and pages are
	// 64 KB, so addr and addr+1 always fall in the same one.
	_fetchSlow(addr)
	{
		if(this.isInternalReg(addr) || this.isDataArray(addr)) return this.readWord(addr);
		const a = addr & 0x07FFFFFF;
		// A bus WITHOUT a page table cannot provide the shortcut, and they exist: the SH-2 tests
		// run it against a fake bus that only implements read/write. There the answer goes
		// through the normal path and the shortcut simply never kicks in.
		const pages = this.bus.pages;
		const e = pages ? pages[a >>> 16] : null;
		if(!e) return this.bus.readWord(addr);      // MMIO (or a bus without pages): no shortcut possible
		this._fetchPage  = addr >>> 16;
		this._fetchBuf  = e.buf;
		this._fetchMask = e.mask;
		const b = e.buf, m = e.mask;
		return ((b[a & m] << 8) | b[(a + 1) & m]) >>> 0;
	}

	// Drops the fetch page shortcut. Called by reset and by the bus when it rebuilds its
	// pages: if that page's buffer changed, the shortcut would be reading the old one.
	invalidateFetch()
	{
		this._fetchPage = -1;
		this._fetchBuf = null;
		this._fetchMask = 0;
	}

	// Invalidates the line that contains the address, if it is cached. Called by the
	// writes of THIS CPU (self-modifying code) and by the purge area. CAREFUL: it is NOT called by
	// the other CPU or the DMA — that NON-coherence is precisely what saves the slave when
	// the master erases its code.
	_icInvalidate(addr)
	{
		if((addr >>> 29) !== 0) return;
		const setIdx = (addr >>> 4) & 0x3F, tag = (addr >>> 10) | 0, i0 = setIdx << 2, t = this.icTags;
		if(t[i0] === tag)          t[i0] = -1;
		else if(t[i0 + 1] === tag) t[i0 + 1] = -1;
		else if(t[i0 + 2] === tag) t[i0 + 2] = -1;
		else if(t[i0 + 3] === tag) t[i0 + 3] = -1;
		else return;
		if((addr >>> 4) === this.icLastLine) this.icLastLine = -1;   // the shortcut cannot outlive its line
	}

	// Full purge (CCR bit 4 = CP) and sync of the cached CE flag.
	_ccrChange()
	{
		const ccr = this.internalRegs[0x92];
		// SWITCH: the instruction cache stays OFF (25-07-2026). It fixed the
		// SF Alpha slave crash (9-10 crashes -> 0, and headless gave an IDENTICAL
		// result in the 5 games), but in Sebas's browser the Sega Rally stopped
		// loading. Since the symptom is on the browser path and does not reproduce headless,
		// it is turned off until it can be tested in isolation with the browser in front. Set to true
		// to test it again; the rest of the cache code stays intact.
		const CACHE_INSTR_ENABLED = true;
		this.cacheOn = CACHE_INSTR_ENABLED && (ccr & 0x01) !== 0;   // CE
		if(ccr & 0x10)                              // CP: purges everything and the bit reads 0
		{
			this.icTags.fill(-1);
			this.icLastLine = -1;
			this.internalRegs[0x92] = ccr & ~0x10;
		}
	}

	readByte(addr)  { if(this.isInternalReg(addr)){ if(this._isInternalCounter(addr)) this.readInternalReg = true; return this.readInternal(addr, 1) & 0xFF; }   if(this.isDataArray(addr)) return this.cacheData[addr & 0xFFF]; return this.bus.readByte(addr); }
	readWord(addr)  { if(this.isInternalReg(addr)){ if(this._isInternalCounter(addr)) this.readInternalReg = true; return this.readInternal(addr, 2) & 0xFFFF; } if(this.isDataArray(addr)){ const c = this.cacheData, o = addr & 0xFFF; return ((c[o] << 8) | c[(o + 1) & 0xFFF]) >>> 0; } return this.bus.readWord(addr); }
	readLong(addr)  { if(this.isInternalReg(addr)){ if(this._isInternalCounter(addr)) this.readInternalReg = true; return this.readInternal(addr, 4) >>> 0; }    if(this.isDataArray(addr)){ const c = this.cacheData, o = addr & 0xFFF; return ((c[o] << 24) | (c[(o + 1) & 0xFFF] << 16) | (c[(o + 2) & 0xFFF] << 8) | c[(o + 3) & 0xFFF]) >>> 0; } return this.bus.readLong(addr); }

	// this.writeOnWrap marks that the loop pass touched memory: if it wrote, it is NOT
	// an idle loop (it moves state forward outside the registers), so it is not skipped.
	// Writes from THIS CPU invalidate its own cache line (self-modifying code),
	// and those to the purge area invalidate the mirrored line. Those from the OTHER CPU and from the DMA do not
	// invalidate anything: that non-coherence is what saves the slave (see readInstr).
	writeByte(addr, v) { this.writeOnWrap = true; if(this.isInternalReg(addr)) this.writeInternal(addr, v, 1); else if(this.isDataArray(addr)) this.cacheData[addr & 0xFFF] = v & 0xFF; else if(this.isPurge(addr)){ if(this.cacheOn) this._icInvalidate((addr & 0x1FFFFFFF) >>> 0); } else { this.bus.writeByte(addr, v); if(this.cacheOn) this._icInvalidate(addr >>> 0); } }
	writeWord(addr, v) { this.writeOnWrap = true; if(this.isInternalReg(addr)) this.writeInternal(addr, v, 2); else if(this.isDataArray(addr)){ const c = this.cacheData, o = addr & 0xFFF; c[o] = (v >> 8) & 0xFF; c[(o + 1) & 0xFFF] = v & 0xFF; } else if(this.isPurge(addr)){ if(this.cacheOn) this._icInvalidate((addr & 0x1FFFFFFF) >>> 0); } else { this.bus.writeWord(addr, v); if(this.cacheOn) this._icInvalidate(addr >>> 0); } }
	writeLong(addr, v) { this.writeOnWrap = true; if(this.isInternalReg(addr)) this.writeInternal(addr, v, 4); else if(this.isDataArray(addr)){ const c = this.cacheData, o = addr & 0xFFF; c[o] = (v >>> 24) & 0xFF; c[(o + 1) & 0xFFF] = (v >>> 16) & 0xFF; c[(o + 2) & 0xFFF] = (v >>> 8) & 0xFF; c[(o + 3) & 0xFFF] = v & 0xFF; } else if(this.isPurge(addr)){ if(this.cacheOn) this._icInvalidate((addr & 0x1FFFFFFF) >>> 0); } else { this.bus.writeLong(addr, v); if(this.cacheOn) this._icInvalidate(addr >>> 0); } }

	// ---------- On-chip peripherals: read ----------
	// The DIVU registers are mirrored at 0x100-0x11C and 0x120-0x13C, hence
	// the & ~0x20 to normalize the offset.
	// THE SCI CHARACTER TIME. It is resolved ON THE READ of SSR and not with a tick per
	// instruction: the transmitter state is only observable through that register, so
	// as long as nobody asks it costs nothing — the same criterion CA and the SCSP's MIDI
	// flags already use, and the one that avoids the fat the timers had before 24-07.
	//
	// The model comes entirely from the chip's specified SCI behavior, not from an emulator:
	//  - TSR: the SCI loads transmit data from TDR into TSR, then transmits the data
	//    serially from the TxD pin. After transmitting one data byte, the SCI automatically
	//    loads the next transmit data from TDR into TSR and starts transmitting again. If the
	//    TDRE bit in SSR is 1, however, the SCI does not load the TDR contents into TSR.
	//  - TDRE: it is set to 1 when the chip is reset, when the TE bit in SCR is
	//    cleared to 0, or when the TDR contents are loaded into TSR.
	// In other words: TDRE is released by the TRANSFER TO TSR, and that transfer can only happen when TSR
	// has finished shifting out the previous character. That is what sets the pace of the burst.
	//ok, 29-07-2026
	_sciPutToDay()
	{
		const s = this.sci;
		if(s.tsrUntil === 0) return;              // transmitter stopped: nothing to bring up to date
		if(this.cycles < s.tsrUntil) return;      // the character is still going out
		s.tsrUntil = 0;                           // TSR became free
		const b = this.internalRegs;
		// With TDRE at 0 there is valid data waiting in TDR: it is loaded and the next one starts.
		// With TDRE at 1 there is nothing to send, and only then is TEND raised.
		if(!(b[0x04] & 0x80) && (b[0x02] & 0x20)) this._sciLoadTsr();
		else b[0x04] |= 0x04;                     // TEND: the transmission finished
	}

	// Moves TDR to TSR: TDRE goes back to 1 and TSR stays busy for as long as the character lasts.
	_sciLoadTsr()
	{
		const b = this.internalRegs;
		b[0x04] |= 0x80;                          // TDRE = 1 (TDR became free)
		b[0x04] &= ~0x04;                         // TEND = 0 (a transmission is in progress)
		this.sci.tsrUntil = this.cycles + this.sci.cyclesChar;
	}

	// Character length IN CPU CYCLES, recalculated only when the game touches SMR or BRR
	// (it writes them once per session). Caching it is the same lesson as the timers'
	// prescaler, which was recalculated 642k times per frame.
	//
	// Solving the chip's bit-rate formula:
	//     asynchronous:  N = f / (256 x 2^(2n-1) x B) x 10^6 - 1
	//     synchronous:   N = f / ( 32 x 2^(2n-1) x B) x 10^6 - 1
	// The value we need is not B but the CYCLES PER BIT, which are f/B — and there the
	// frequency CANCELS OUT, so there is no need to know at how many MHz the chip runs:
	//     cycles per bit = 256 x 2^(2n-1) x (N+1)  =  128 x 4^n x (N+1)   (asynchronous)
	//     cycles per bit =  32 x 2^(2n-1) x (N+1)  =   16 x 4^n x (N+1)   (synchronous)
	// VERIFIED against the chip's own bit-rate table: with f=14.7456 MHz and 9600 bit/s it gives
	// n=0, N=11 with 0.00% error, and 14.7456e6 / (128 x 12) = 9600 exactly.
	//
	// Bits per character (SMR):
	//   asynchronous: 1 start + 8 or 7 data (CHR) + parity if PE + 1 or 2 stop (STOP)
	//   synchronous:  8, with no start or stop (no stop bits are added)
	_sciRecalc()
	{
		const b = this.internalRegs;
		const smr = b[0x00], n = smr & 0x3, brr = b[0x01];
		const sync = (smr & 0x80) !== 0;
		const cyclesPerBit = (sync ? 16 : 128) * Math.pow(4, n) * (brr + 1);
		const bits = sync ? 8
			: 1 + ((smr & 0x40) ? 7 : 8) + ((smr & 0x20) ? 1 : 0) + ((smr & 0x08) ? 2 : 1);
		this.sci.cyclesChar = cyclesPerBit * bits;
	}

	readInternal(addr, size)
	{
		const off = (addr & 0x1FF);
		// SSR: it is the only point through which the transmitter is observed. See _sciPutToDay.
		if(off === 0x04) this._sciPutToDay();
		// The DMAC is resolved BEFORE the switch: its registers are NOT mirrored and the
		// DIVU's & ~0x20 would clobber them (VCRDMA0, at 0x1A0, would fall on SAR0, at 0x180).
		if(off >= 0x180 && off <= 0x1B3) return this._readDmac(off, size);
		// BCR1: also before the switch (the & ~0x20 would send it to 0x1C0). The real
		// register is the LOW 16 bits of the long at 0x1E0, so the long is read at 0x1E0
		// and the word at 0x1E2 (Yabause: "real BCR1 register is located at 0x1E2-0x1E3;
		// Sega Rally OK"). This is where the MASTER bit lives, which the BIOS checks to know whether it is the
		// slave: see the constructor's comment.
		if(off === 0x1E0 && size === 4) return this.bcr1 >>> 0;
		if(off === 0x1E2 && size === 2) return this.bcr1 & 0xFFFF;
		// OCRA/OCRB: they share an address, the OCRS bit of TOCR breaks the tie.
		if(off === 0x14 || off === 0x15) return this._readOcr(off, size);
		// ICR (0xFFFFFEE0): the last value written is NOT returned. It is built like this:
		//   bit 15 NMIL  (R)   level of the NMI pin — this bit cannot be modified
		//   bits 14-9         reserved: these bits always read 0
		//   bit  8 NMIE  (R/W) NMI edge (0 = falling, initial)
		//   bits 7-1          reserved: always read 0
		//   bit  0 VECMD (R/W) 0 = auto-vector (initial), 1 = external vector
		// Returning the written value broke all three things: NMIL came out with whatever the game
		// had put there, the reserved bits did not read 0, and the reset did not leave H'8000.
		//? NMIL is ALWAYS answered as 1 (pin high = NMI inactive, which is its rest state: the NMI is
		//? detected on the FALLING edge). We do not model the interval during which the line is low
		//? during the pulse because our NMI comes in through requestNmi(), which is an edge with no
		//? duration. If some day a game measures the pulse width, the missing piece goes here.
		if(off === 0xE0 || off === 0xE1)
		{
			const b = this.internalRegs;
			const icr = 0x8000 | (b[0xE0] & 0x01 ? 0x0100 : 0) | (b[0xE1] & 0x01);
			if(size === 1) return (off === 0xE0) ? (icr >> 8) & 0xFF : icr & 0xFF;
			return icr & 0xFFFF;
		}
		switch(off & ~0x20)
		{
			case 0x100: return this.divu.dvsr >>> 0;      // DVSR
			case 0x104: return this.divu.dvdntl >>> 0;    // DVDNT: returns the quotient
			case 0x108: return this.divu.dvcr >>> 0;      // DVCR
			case 0x10C: return this.divu.vcrdiv >>> 0;    // VCRDIV
			case 0x110: return this.divu.dvdnth >>> 0;    // DVDNTH: remainder
			case 0x114: return this.divu.dvdntl >>> 0;    // DVDNTL: quotient
			case 0x118: return this.divu.dvdntuh >>> 0;   // DVDNTUH
			case 0x11C: return this.divu.dvdntul >>> 0;   // DVDNTUL
		}
		// Remaining registers: the last value written is returned (big-endian).
		const b = this.internalRegs;
		if(size === 1) return b[off];
		if(size === 2) return (b[off] << 8) | b[(off + 1) & 0x1FF];
		return (((b[off] << 24) | (b[(off + 1) & 0x1FF] << 16) |
			(b[(off + 2) & 0x1FF] << 8) | b[(off + 3) & 0x1FF]) >>> 0);
	}

	// ---------- On-chip peripherals: write ----------
	writeInternal(addr, value, size)
	{
		const off = (addr & 0x1FF);
		if(off >= 0x180 && off <= 0x1B3) { this._writeDmac(off, value, size); return; }
		// BCR1: only written as a LONG (Yabause has no word case). The high 16 bits
		// of the value are the write key 0xA55A and are discarded; bit 15
		// (MASTER) CANNOT be overwritten: the chip sets it. The BIOS writes 0xA55A03F1.
		if(off === 0x1E0 && size === 4) { this.bcr1 = (this.bcr1 & 0x8000) | (value & 0x1FF7); return; }
		// OCRA/OCRB: they share an address, the OCRS bit of TOCR breaks the tie.
		if(off === 0x14 || off === 0x15) { this._writeOcr(off, value, size); return; }
		// WDT (0x80-0x83): the write carries a magic byte and cannot be resolved with the
		// generic path.
		if(off >= 0x80 && off <= 0x83) { this._writeWdt(off, value, size); return; }
		// FTCSR (0xFFFFFE11): it is R/(W). The flags (bits 7 and 3-1) can ONLY be CLEARED
		// by writing a 0; writing a 1 does NOT raise them, it leaves them as they were (the only
		// value that can be written is a 0, which is used to clear flags).
		// Bit 0 (CCLRA) is normal R/W. Without this a game that writes FTCSR to
		// turn on CCLRA could raise flags by hand and fire interrupts on its own.
		if(off === 0x11 && size === 1)
		{
			const f = this.internalRegs;
			f[0x11] = (f[0x11] & (value & 0xFE)) | (value & 0x01);
			return;
		}
		// The SCI's SSR (0xFFFFFE04): SAME CLASS AS FTCSR, and we stored it raw.
		//
		// WHY IT MATTERS, measured on 28-07-2026 with diag/sci-usage.mjs: **7 of the 10 games
		// use the SCI** (daytona, daycce, rally, vc, vf2, touring, xmenvs). They all do the
		// same: configure SMR/BRR, turn on TE in SCR, load TDR and then POLL
		// SSR waiting for TDRE. With the register stored raw, the TDRE the game clears is
		// raised again by NOBODY, so that wait runs until the game's own timeout:
		// the SSR reads came out at 32,770, 65,538 and 98,306 — exact multiples of 32,768,
		// which is the game's retry counter reaching its limit IN FULL, again and again.
		// That is ~262,000 instructions thrown away per attempt, i.e. ALMOST A FRAME AND A HALF of
		// CPU each time, and that shifts the phase of everything else in the frame.
		// (PENDING.md had the SCI down as "dev/debug, no game uses it". It was false.)
		//
		// The Serial Status Register:
		//   bit 7 TDRE  R/(W)  can only be cleared by writing 0 after reading 1
		//   bit 6 RDRF  R/(W)  same      bits 5-3 ORER/FER/PER  R/(W)  same
		//   bit 2 TEND  (R)    READ ONLY
		//   bit 1 MPB   (R)    READ ONLY
		//   bit 0 MPBT  R/W
		// And what was missing altogether: **TDRE is set back to 1 by the HARDWARE when it moves
		// the data from TDR to TSR**. That transfer is immediate if the transmitter is free; what
		// takes time is shifting the character out of the pin, and that is signaled by TEND, not TDRE.
		if(off === 0x04 && size === 1)
		{
			const b = this.internalRegs;
			const CLR = 0xF8, RO = 0x06, RW = 0x01;   // "write 0 to clear" / read only / R/W
			// The clear-with-zero ones: writing 1 leaves them as they were, writing 0 clears them.
			let n = (b[0x04] & ~CLR) | (b[0x04] & CLR & value);
			n = (n & ~RW) | (value & RW);             // MPBT is normal R/W
			n = (n & ~RO) | (b[0x04] & RO);           // TEND and MPB are not overwritten
			b[0x04] = n & 0xFF;
			// ★ WITH THE TRANSMITTER OFF, TDRE CANNOT BE CLEARED. The TE bit of SCR
			// works like this:
			//   0 — Transmitter disabled. The transmit data register empty bit (TDRE) in the
			//    serial status register (SSR) is LOCKED AT 1.
			//   1 — Transmitter enabled. Serial transmission starts when the transmit data
			//    register empty (TDRE) bit in SSR is cleared to 0 after writing of transmit
			//    data into TDR.
			// Without this the chip enters a state it never leaves, and it is MEASURED
			// (diag/sci-trace.mjs, Daytona USA frame 1106): the game clears TDRE with TE=0, and
			// only AFTERWARDS turns on TE. Since the load from TDR to TSR is triggered by clearing TDRE and
			// that trigger had already gone by, it was left at TDRE=0 / TEND=1 / TSR free, i.e. "there is data
			// waiting" with nobody ever moving it — and the game polled the 32,767 passes
			// of its timeout INSIDE a critical section with IMASK=15. It never came back from there.
			// With the lock, that write clears nothing, the game sees TDRE=1, sends the byte with TE
			// already on, and the flow continues the way the hardware does it.
			//ok, 29-07-2026
			if(!(b[0x02] & 0x20)) b[0x04] |= 0x80;
			// TDR -> TSR: clearing TDRE is the signal that TDR holds valid data. The SCI moves it
			// to TSR *when TSR is free*, and only then does TDRE go back to 1.
			// If TSR is still busy with the previous character, TDRE stays at 0 and it is raised by
			// _sciPutToDay when the character time is up: THAT is the real pace of
			// the burst, and it is what did not exist before.
			if((b[0x02] & 0x20) && !(b[0x04] & 0x80) && this.sci.tsrUntil === 0)
				this._sciLoadTsr();
			return;
		}
		const v = value | 0;
		switch(off & ~0x20)
		{
			case 0x100: this.divu.dvsr = v; return;                       // DVSR
			case 0x104: this.divide32(v); return;                        // DVDNT: starts 32/32
			case 0x108: this.divu.dvcr = value & 0x3; return;             // DVCR
			case 0x10C: this.divu.vcrdiv = value & 0xFFFF; return;        // VCRDIV
			case 0x110: this.divu.dvdnth = v; return;                     // DVDNTH
			case 0x114: this.divide64(v); return;                        // DVDNTL: starts 64/32
			case 0x118: this.divu.dvdntuh = v; return;                    // DVDNTUH
			case 0x11C: this.divu.dvdntul = v; return;                    // DVDNTUL
		}
		// SMR (0x00) and BRR (0x01) set the character length; SCR (0x02) the TE bit. All three
		// go through the raw path below and then the transmitter is readjusted.
		if(off <= 0x02)
		{
			const b = this.internalRegs;
			const teBefore = (b[0x02] & 0x20) !== 0;
			if(size === 1) b[off] = value & 0xFF;
			else { b[off] = (value >> 8) & 0xFF; b[(off + 1) & 0x1FF] = value & 0xFF; }
			if(off <= 0x01) this._sciRecalc();
			// TDRE is set to 1 when the TE bit in SCR is cleared to 0: turning off
			// the transmitter leaves it empty and stops TSR.
			if(teBefore && !(b[0x02] & 0x20)){ b[0x04] |= 0x84; this.sci.tsrUntil = 0; }
			return;
		}
		const b = this.internalRegs;
		if(size === 1) b[off] = value & 0xFF;
		else if(size === 2) { b[off] = (value >> 8) & 0xFF; b[(off + 1) & 0x1FF] = value & 0xFF; }
		else {
			b[off] = (value >>> 24) & 0xFF; b[(off + 1) & 0x1FF] = (value >>> 16) & 0xFF;
			b[(off + 2) & 0x1FF] = (value >>> 8) & 0xFF; b[(off + 3) & 0x1FF] = value & 0xFF;
		}
		// TCR (0x16) sets the FRT's cached prescaler: if the write touches it, recalculate.
		if(off <= 0x16 && off + size > 0x16) this._frtRecalc();
		// CCR (0x92) turns the cache on/off (CE) and purges it (CP).
		if(off <= 0x92 && off + size > 0x92) this._ccrChange();
	}

	// ---------- SH7604 on-chip DMAC (0xFFFFFF80-0xFFFFFFB3) ----------
	// Ported from Yabause (sh2core.c: OnchipRead/WriteLong, DMAExec, DMATransfer).
	//? HLE: the transfer is INSTANTANEOUS when armed, not cycle by cycle. Yabause does
	//? the same unless asked for fine timing (use_sh2_dma_timing). //!wip, 16-07-2026

	// Full value (32 bits) of the DMAC register that contains the offset.
	_dmacValue(off)
	{
		switch(off & ~0x3)
		{
			case 0x180: return this.dmac.sar[0]    >>> 0;   // SAR0
			case 0x184: return this.dmac.dar[0]    >>> 0;   // DAR0
			case 0x188: return this.dmac.tcr[0]    >>> 0;   // TCR0
			case 0x18C: return this.dmac.chcr[0]   >>> 0;   // CHCR0
			case 0x190: return this.dmac.sar[1]    >>> 0;   // SAR1
			case 0x194: return this.dmac.dar[1]    >>> 0;   // DAR1
			case 0x198: return this.dmac.tcr[1]    >>> 0;   // TCR1
			case 0x19C: return this.dmac.chcr[1]   >>> 0;   // CHCR1
			case 0x1A0: return this.dmac.vcrdma[0] >>> 0;   // VCRDMA0
			case 0x1A8: return this.dmac.vcrdma[1] >>> 0;   // VCRDMA1
			case 0x1B0: return this.dmac.dmaor     >>> 0;   // DMAOR
		}
		return 0;   // reserved holes in the map (0x1A4, 0x1AC...)
	}

	// Read of a DMAC register respecting the access width (big-endian).
	_readDmac(off, size)
	{
		const v = this._dmacValue(off);
		if(size === 4) return v;
		const offset = (4 - size - (off & 3)) * 8;
		return (v >>> offset) & (size === 2 ? 0xFFFF : 0xFF);
	}

	// Write of a DMAC register. 8/16-bit accesses are read-modify-write
	// on the whole register so as not to lose the rest of the bits.
	_writeDmac(off, value, size)
	{
		let v = value >>> 0;
		if(size !== 4)
		{
			const offset = (4 - size - (off & 3)) * 8;
			const m = (((size === 2 ? 0xFFFF : 0xFF) << offset) >>> 0);
			v = ((this._dmacValue(off) & ~m) | ((value << offset) & m)) >>> 0;
		}
		switch(off & ~0x3)
		{
			case 0x180: this.dmac.sar[0] = v; return;
			case 0x184: this.dmac.dar[0] = v; return;
			case 0x188: this.dmac.tcr[0] = v & 0xFFFFFF; return;
			case 0x190: this.dmac.sar[1] = v; return;
			case 0x194: this.dmac.dar[1] = v; return;
			case 0x198: this.dmac.tcr[1] = v & 0xFFFFFF; return;
			case 0x1A0: this.dmac.vcrdma[0] = v & 0xFFFF; return;
			case 0x1A8: this.dmac.vcrdma[1] = v & 0xFFFF; return;
			// CHCR: arming the channel (DE=1, TE=0) with the DMAC enabled starts the
			// transfer. It is THE trigger games wait for.
			case 0x18C:
			case 0x19C:
			{
				const channel = ((off & ~0x3) === 0x18C) ? 0 : 1;
				this.dmac.chcr[channel] = v & 0xFFFF;
				if((this.dmac.dmaor & 7) === 1 && (v & 0x3) === 1) this._dmaExecute();
				return;
			}
			// DRCR0/DRCR1: which source the transfer request comes from (see _dmaExecute).
			// They are 8-bit R/W, bits 7-2 reserved, bits 1-0 = RS1/RS0.
			case 0x71:
			case 0x72:
				this.dmac.drcr[off - 0x71] = value & 0x3;
				return;
			// DMAOR: enabling the DMAC (DME) starts the channels that were already armed.
			case 0x1B0:
				this.dmac.dmaor = v & 0xF;
				if((v & 7) === 1) this._dmaExecute();
				return;
		}
	}

	// DMAExec: runs the armed channels (DE=1, TE=0). With AE (address error) or NMIF
	// on, the DMAC does not start.
	// THE CHANNEL ONLY STARTS BY ITSELF IN AUTO-REQUEST. CHCR bit 9 = AR:
	// 0 = module request mode (initial value) / 1 = auto-request mode, and it selects whether
	// auto-request (generated within the DMAC) or module request (an external request or from
	// the on-chip SCI module) is used for the transfer request.
	// With AR=0 the request has to be brought by the source DRCR selects:
	// RS1/RS0 = 00 DREQ (external pin), 01 SCI RXI, 10 SCI TXI, 11 prohibited.
	//? On the Saturn the SCI is not used (no game touches it) and there is no record of the DREQ pin being
	//? wired, same as the FRT's FTCI: that is why a channel with AR=0 is started by NOBODY here.
	//? If some day a game shows up that arms with AR=0 and expects it to transfer, the missing
	//? piece is whoever asserts DREQ, and it goes in that place — not by loosening this gate.
	// Before, it ALWAYS started with DE=1, i.e. treating everything as auto-request. Measured on
	// 28-07-2026 over 6 games and 1,500 frames: **all 4,025 armed channels have AR=1**
	// (sfa 292, sonic 629, vc 3,006, touring 76, rally 22; daytona does not use the on-chip DMAC),
	// so the gate does not change the behavior of any of them — it is there for accuracy and for the
	// other 490 discs, not to fix a symptom.
	// ✔ AUDITED AGAINST THE CHIP'S SPEC AND CORRECT (29-07-2026) — do not re-audit.
	// The gate is `chcr & 0x203 === 0x201`, i.e. DE=1 (bit 0), TE=0 (bit 1) and **AR=1** (bit 9).
	// The DE bit: in auto-request mode, the transfer starts when this
	// bit or the DME bit in DMAOR is set to 1... **In external request mode or on-chip peripheral
	// module request mode, the transfer begins when the DMA transfer request is received from the
	// relevant device or on-chip peripheral module**, provided this bit and the DME bit are set
	// to 1.
	// In other words: with AR=0 writing DE=1 starts NOTHING, and that is exactly what we do.
	//
	// The THREE request sources that would remain with AR=0 (DRCR) and why none of them fires:
	//   RS=00 external DREQ  -> there is no record of the pin being wired on the Saturn (same case as
	//                          the FRT's FTCI).
	//   RS=01 SCI RXI        -> **impossible, and now measured**: the 7 games that use the SCI
	//                          ask for `SCR=0x12`, i.e. RE=1 with CKE=2 (EXTERNAL clock). Without a cable
	//                          there is no clock, no reception, and RXI is never generated.
	//   RS=10 SCI TXI        -> this one COULD happen (the transmitter works since 28-07), but
	//                          no game arms a channel with AR=0: measured over 6 games and 1,500
	//                          frames, **all 4,025 armed channels have AR=1**.
	//? What is still missing from this chip is not the gate but the TIME: the transfer runs
	//? entirely inside the CHCR write, with zero latency. It is the "the hardware
	//? TAKES TIME" pattern unresolved here, but there is no measured symptom that can be attributed to it.
	//ok, 29-07-2026
	_dmaExecute()
	{
		if(this.dmac.dmaor & 0x6) return;
		if((this.dmac.chcr[0] & 0x203) === 0x201) this._dmaTransfer(0);
		if((this.dmac.chcr[1] & 0x203) === 0x201) this._dmaTransfer(1);
	}

	// DMATransfer: moves a channel's block and, when done, SETS TE (bit 1) in
	// CHCR. That bit is the one games poll ("spin while CHCR & 3 == 1"), so
	// without setting it they are left waiting forever.
	_dmaTransfer(channel)
	{
		const chcr = this.dmac.chcr[channel];
		if(!(chcr & 0x2))   // TE off: there is transfer left to do
		{
			// SM (bits 13-12) and DM (bits 15-14): 0 = fixed, 1 = increment, 2 = decrement.
			let incSrc = 0, incDst = 0;
			switch(chcr & 0x3000) { case 0x1000: incSrc = 1; break; case 0x2000: incSrc = -1; break; }
			switch(chcr & 0xC000) { case 0x4000: incDst = 1; break; case 0x8000: incDst = -1; break; }

			// TS (bits 11-10): 0 = byte, 1 = word, 2 = long, 3 = 16-byte block (by longs).
			const ts = (chcr >> 10) & 0x3;
			const width = (ts === 0) ? 1 : (ts === 1) ? 2 : 4;
			incSrc *= width; incDst *= width;

			let sar = this.dmac.sar[channel] >>> 0;
			let dar = this.dmac.dar[channel] >>> 0;
			const cnt = this.dmac.tcr[channel] >>> 0;
			for(let i = 0; i < cnt; i++)
			{
				if(width === 1)      this.bus.writeByte(dar, this.bus.readByte(sar));
				else if(width === 2) this.bus.writeWord(dar, this.bus.readWord(sar));
				else                 this.bus.writeLong(dar, this.bus.readLong(sar));
				sar = (sar + incSrc) >>> 0;
				dar = (dar + incDst) >>> 0;
			}
			this.dmac.sar[channel] = sar;
			this.dmac.dar[channel] = dar;
			this.dmac.tcr[channel] = 0;
		}

		// IE (bit 2): transfer end interrupt. The level comes from IPRA
		// (bits 11-8) and the vector from the channel's VCRDMA.
		if(chcr & 0x4)
		{
			const ipra = this.readInternal(0xFFFFFEE2, 2) & 0xFFFF;
			this.requestInterrupt((ipra >> 8) & 0xF, this.dmac.vcrdma[channel] & 0x7F);
		}

		this.dmac.chcr[channel] |= 0x2;   // TE: transfer finished
	}

	// Division overflow: sets OVF and, if OVFIE is active, requests the interrupt.
	// The level comes from IPRA (bits 15-12), which lives in the on-chip area (0xFFFFFEE2).
	_divOverflow()
	{
		this.divu.dvcr |= 1;
		if(this.divu.dvcr & 0x2)
		{
			const ipra = this.readInternal(0xFFFFFEE2, 2) & 0xFFFF;
			this.requestInterrupt((ipra >> 12) & 0xF, this.divu.vcrdiv & 0x7F);
		}
	}

	// DIVU: 32/32 division (triggered by writing DVDNT). Quotient -> DVDNTL/DVDNT,
	// remainder -> DVDNTH. Truncates toward zero, same as the HW.
	divide32(dividend)
	{
		const divisor = this.divu.dvsr | 0;
		if(divisor === 0)
		{
			// Division by zero: saturates and uses the dividend's 3 high bits for DVDNTH.
			if(dividend & 0x80000000)
			{
				this.divu.dvdntl = 0x80000000 | 0;
				this.divu.dvdnth = (0xFFFFFFFC | ((dividend >>> 29) & 0x3)) | 0;
			}
			else
			{
				this.divu.dvdntl = 0x7FFFFFFF;
				this.divu.dvdnth = (dividend >>> 29) | 0;
			}
			this._divOverflow();
		}
		else
		{
			const d = dividend | 0;
			this.divu.dvdntl = (d / divisor) | 0;   // the | 0 truncates toward zero
			this.divu.dvdnth = (d % divisor) | 0;
		}
		this.divu.dvdntul = this.divu.dvdntl;
		this.divu.dvdntuh = this.divu.dvdnth;
	}

	// DIVU: 64/32 division (triggered by writing DVDNTL). The dividend is
	// DVDNTH:DVDNTL, signed. Quotient -> DVDNTL, remainder -> DVDNTH.
	divide64(low)
	{
		const divisor = this.divu.dvsr | 0;
		const dividend = BigInt.asIntN(64, (BigInt(this.divu.dvdnth >>> 0) << 32n) | BigInt(low >>> 0));

		if(divisor === 0)
		{
			this.divu.dvdntl = (this.divu.dvdnth & 0x80000000) ? (0x80000000 | 0) : 0x7FFFFFFF;
			this.divu.dvdnth = (this.divu.dvdnth << 3) | 0;
			this._divOverflow();
		}
		else
		{
			const q = dividend / BigInt(divisor);   // BigInt also truncates toward zero
			const r = dividend % BigInt(divisor);
			if(q > 0x7FFFFFFFn)
			{
				this.divu.dvdntl = 0x7FFFFFFF;
				this.divu.dvdnth = 0xFFFFFFFE | 0;
				this._divOverflow();
			}
			else if((q >> 32n) < -1n)
			{
				this.divu.dvdntl = 0x80000000 | 0;
				this.divu.dvdnth = 0xFFFFFFFE | 0;
				this._divOverflow();
			}
			else
			{
				this.divu.dvdntl = Number(BigInt.asIntN(32, q)) | 0;
				this.divu.dvdnth = Number(BigInt.asIntN(32, r)) | 0;
			}
		}
		this.divu.dvdntul = this.divu.dvdntl;
		this.divu.dvdntuh = this.divu.dvdnth;
	}

	// Executes one instruction. Returns the cycles consumed (approx).
	step()
	{
		// The FRT runs on the CPU clock, and it goes BEFORE everything for two reasons:
		// 1) It does NOT stop in SLEEP: although the CPU halts
		//    immediately after executing the SLEEP instruction, the on-chip peripheral
		//    modules continue to run in sleep mode. An output compare or
		//    the FRC overflow are among the few things that can WAKE the CPU, so
		//    it has to keep counting even if below we exit through sleeping.
		// 2) Running it first, the interrupt it raises is handled in this same
		//    step() and not in the next one.
		this._frtRun(1);
		// The WDT goes next to the FRT and for the same two reasons. It is another on-chip module,
		// so it does not stop in SLEEP either: the on-chip peripheral modules continue to
		// run in sleep mode, with no exception, and the interval mode's ITI
		// is one of the things that can WAKE the CPU. Careful with STANDBY,
		// which is something else: there everything does stop, but to enter standby the hardware
		// requires TME=0 (the chip cannot enter standby mode while the TME bit is set to
		// 1), so the WDT is already stopped by TME before entering.
		this._wdtRun(1);

		// The NMI goes FIRST and IMASK does not filter it: it is the only one that can bring the
		// CPU out of a SLEEP done with IMASK at 15 (see requestNmi).
		if(this.nmiPending)
			this._serveNmi();
		// Serve the pending interrupt with the HIGHEST level above IMASK.
		else if(this.irqPending.length)
		{
			const imask = (this.sr >> 4) & 0xF;
			let best = -1, bestLevel = imask;
			for(let i = 0; i < this.irqPending.length; i++)
				if(this.irqPending[i].level > bestLevel) { bestLevel = this.irqPending[i].level; best = i; }
			if(best >= 0)
			{
				const irq = this.irqPending.splice(best, 1)[0];
				// Recalculate the maximum: the highest one was just removed. It is O(n) but
				// happens once per interrupt served, not per step.
				let mx = -1;
				for(let i = 0; i < this.irqPending.length; i++)
					if(this.irqPending[i].level > mx) mx = this.irqPending[i].level;
				this.irqLevelMax = mx;
				this._serveInterrupt(irq.level, irq.vector);
			}
		}

		if(this.halted || this.sleeping)
			return 0;

		// Idle skip: in a spin loop confirmed idle, spinning is a no-op (same state, no
		// writes). The timers and IRQs already ran above, so the CPU spends the cycle
		// without executing the loop. this.idle is cleared every chunk (stepsBlock) and when serving an IRQ.
		if(this.idle){ this.cycles++; return 1; }

		// The PC is recorded BEFORE the fetch: that way the second to last in the history is the
		// instruction that jumped into nothing, and the last one the first opcode of zeros.
		if(this.tracing){ this.histPc[this.histIdx] = this.pc >>> 0; this.histIdx = (this.histIdx + 1) & 15; }

		const pcBefore = this.pc;
		const op = this.readInstr(this.pc);   // through the instruction cache (or directly if it is off)
		this.pc = (this.pc + 2) >>> 0;
		this.execute(op);
		// REAL cost of the instruction (see SH2_CYCLES above), not a fixed 1. The
		// conditionals that branch add their extra from group8(), so here the table is read
		// AFTER executing: if it were added before, group8's += would be overwritten.
		this.cycles += SH2_CYCLES[op & 0xFFFF];

		// Idle loop detection: if it was a short branch BACKWARD (delta <= 16 bytes, a
		// loop of <= 8 instructions) and the complete architectural state was IDENTICAL to that of
		// the previous pass through the same target, WITHOUT having written memory, the loop is not
		// progressing -> it is provably idle (not a heuristic) and we mark it to skip it.
		const delta = (pcBefore - this.pc) >>> 0;
		// Limit of the back-branch we consider an idle loop: 44 bytes (<= 22 instructions).
		// Proven transparent (final state hash IDENTICAL at 16, 32 and 44 in the 5 games):
		// _snapEqual() gates EVERY skip, so a larger limit only enables skipping
		// slightly longer loops, it never skips too much. At 32 the 24-byte spin-wait of the
		// SF Alpha's slave falls into the idle-skip (Sebas: "+100%").
		// At 44 the DAYTONA's slave one falls in too, which measures 42 bytes (0x6034f34-0x6034f5e, 8
		// instructions) and spun 40,680 times per frame -325,437 steps- burning 27.7%
		// of the frame to do nothing. Measured interleaved A/B with the minimum of each branch:
		//    daytona +46.4%   sonic +0.4%   rally -0.1%   sfa -2.5%
		// The SF Alpha's -2.5% is the real price: more back-branches qualify, i.e. more
		// calls to _snapEqual() (22 registers) in loops that are NOT idle. It is paid because
		// it is on the order of the noise and on the other side there are 46 points.
		//? Do NOT raise it "just in case": at 64 the SF Alpha sinks -29.1% from that same cost,
		//? and the Daytona gains nothing more (its loop already fits in 44). The limit is raised when
		//? there is a measured loop that does not fit, not before.
		if(delta !== 0 && delta <= 44)
		{
			if(this.pc === this.idleBackPC && !this.writeOnWrap && !this.readInternalReg && this._snapEqual())
				this.idle = true;
			else { this.idleBackPC = this.pc >>> 0; this._saveSnap(); }
			this.writeOnWrap = false;
			this.readInternalReg = false;
		}
		return 1;
	}

	// ------------------------------------------------------------------------------
	// DRY RUN: spend in one go the cycles in which the CPU is not going to do ANYTHING.
	//
	// Measured on 25-07-2026 with diag/instr-per-frame.mjs: 58-74% of the master's steps
	// are IDLE-SKIP (the SF Alpha's slave, 97%). In the Rally that is ~235,000 passes per
	// frame that enter step(), run two timers ONE cycle at a time, check for an IRQ, charge
	// one cycle and leave. The useful work of those passes is "let time go by".
	//
	// Here we compute HOW MANY cycles can go by without anything in the chip changing state, and
	// charge them in one go. It is transparent BY CONSTRUCTION, not by luck: the cap is the
	// cycle BEFORE the next tick that could do something observable, so inside the
	// jump there is no event to miss. The tick itself is still executed by step(),
	// on its exact cycle and through the usual path.
	//
	// Returns the cycles skipped (0 = nothing to skip, keep going step by step).
	// It can only be called by someone who knows the CPU is not going to execute instructions: idle
	// (spin-loop proven by _snapEqual) or sleeping (SLEEP waiting for an IRQ).
	runDry(cyclesMax)
	{
		if(cyclesMax <= 0) return 0;
		// With something pending to serve NOTHING is skipped: step() handles that right away,
		// and besides it is what brings the CPU out of idle or SLEEP.
		if(this.nmiPending) return 0;
		// BUT "pending" is NOT "there is something in the queue": it is that there is something that can be SERVED.
		// The SAME criterion as step() a few lines above —level > IMASK— is used, and not one
		// of its own, because any difference between the two jams this again.
		//
		// THE BUG IT FIXES (27-07-2026, Sebas sent it for review): looking at irqPending.length
		// alone SELF-BLOCKS with a masked IRQ. Measured on the Rally's master: the queue
		// stays with levels 14 and 15 while SR has IMASK at 15, i.e. NEITHER of the
		// two exceeds the mask and step() is never going to serve them. With the old check,
		// 100% of the 17,845,320 calls over 40 frames left through here without even evaluating
		// the jump: the CPU stayed marked idle, step() came in through its early-return and left, and
		// the runFrame loop called it 446,919 TIMES PER FRAME to spend one cycle
		// each time.
		//
		// Jumping with masked IRQs in the queue is correct: in a dry run NO code is executed,
		// so SR does not change and those IRQs remain unservable for the whole jump.
		// The ones that could appear in the middle are those of the on-chip timers, and the jump is already
		// capped at their next event (the FRT/WDT calculation below); external ones
		// arrive through requestInterrupt and at most wait as long as the chunk lasts, same as today.
		// The check goes against irqLevelMax (cached) and NOT by walking the queue: this path
		// runs millions of times per frame and walking it cost -8.5% in the SF Alpha,
		// so the fix was eating its own gain.
		if(this.irqLevelMax > ((this.sr >> 4) & 0xF)) return 0;

		let k = cyclesMax;

		// FRT: the FRC goes up by 1 every `period` cycles. It does something observable when it reaches
		// OCRA, OCRB or 0 (overflow -> OVF, and it may interrupt). The closest one is taken.
		const f = this.frt;
		if(f.active)
		{
			const b = this.internalRegs;
			const frc = ((b[0x12] << 8) | b[0x13]) & 0xFFFF;
			// Distance in ticks. A 0 means "it is already there", i.e. it goes all the way
			// around (65536) before matching again.
			const dist = (obj) => { const d = (obj - frc) & 0xFFFF; return d === 0 ? 0x10000 : d; };
			const ticks = Math.min(dist(f.ocra), dist(f.ocrb), dist(0));
			// Cycles until THAT tick: what is left to complete the tick in progress, plus the
			// whole periods of the ticks that follow. 1 is subtracted to stay on the cycle
			// BEFORE: step() does the tick.
			const until = (f.period - f.remainder) + (ticks - 1) * f.period - 1;
			if(until < k) k = until;
		}

		// WDT: same, but its counter is 8 bits and the only event is the overflow
		// (H'FF -> H'00), which depending on the mode interrupts (interval) or resets the chip
		// (watchdog). With TME off it does not count and there is nothing to wait for.
		const w = this.wdt;
		if(w.active)
		{
			const cnt = this.internalRegs[0x81] & 0xFF;
			const ticks = 0x100 - cnt;             // the ones left to wrap around to 0
			const until = (w.period - w.remainder) + (ticks - 1) * w.period - 1;
			if(until < k) k = until;
		}

		if(k <= 0) return 0;
		// The timers advance anyway (they keep counting in SLEEP: the on-chip peripheral
		// modules continue to run in sleep mode). With the cap above, none of them
		// reaches a tick with consequences inside this block.
		this._frtRun(k);
		this._wdtRun(k);
		this.cycles += k;
		return k;
	}

	// Snapshot of the complete architectural state (R0-15 + SR, GBR, VBR, PR, MACH, MACL).
	// Unrolled on purpose: it is called on every short back-branch, it is a hot path.
	_saveSnap()
	{
		const s = this.idleSnap, r = this.r;
		s[0]=r[0];s[1]=r[1];s[2]=r[2];s[3]=r[3];s[4]=r[4];s[5]=r[5];s[6]=r[6];s[7]=r[7];
		s[8]=r[8];s[9]=r[9];s[10]=r[10];s[11]=r[11];s[12]=r[12];s[13]=r[13];s[14]=r[14];s[15]=r[15];
		s[16]=this.sr; s[17]=this.gbr; s[18]=this.vbr; s[19]=this.pr; s[20]=this.mach; s[21]=this.macl;
	}
	// true if the current state is identical to the last snapshot: the CPU came back to the same exact
	// point, so the loop did nothing observable in that pass.
	_snapEqual()
	{
		const s = this.idleSnap, r = this.r;
		return s[0]===r[0]&&s[1]===r[1]&&s[2]===r[2]&&s[3]===r[3]&&s[4]===r[4]&&s[5]===r[5]&&s[6]===r[6]&&s[7]===r[7]&&
			s[8]===r[8]&&s[9]===r[9]&&s[10]===r[10]&&s[11]===r[11]&&s[12]===r[12]&&s[13]===r[13]&&s[14]===r[14]&&s[15]===r[15]&&
			s[16]===this.sr&&s[17]===this.gbr&&s[18]===this.vbr&&s[19]===this.pr&&s[20]===this.mach&&s[21]===this.macl;
	}

	// Executes the "delay slot" (instruction following a branch) and then jumps.
	// At the moment the branch executes, this.pc points to the delay slot.
	jumpDelayed(dest)
	{
		// The delay slot is an INSTRUCTION: it goes through the cache just like the normal fetch. Reading it
		// with readWord skipped the cache, and with that the SF Alpha's slave died anyway
		// even though its loop was cached (the bra came out of the cache but its delay slot was
		// read from memory already erased by the master).
		const slot = this.readInstr(this.pc);
		this.pc = (this.pc + 2) >>> 0;
		this.execute(slot);
		this.pc = dest >>> 0;
	}

	// Decodes by top nibble and dispatches.
	execute(op)
	{
		const n = (op >> 8) & 0xF;
		const m = (op >> 4) & 0xF;

		switch(op >> 12)
		{
			case 0x0: this.group0(op, n, m); break;
			case 0x1: // MOV.L Rm, @(disp,Rn)
				this.writeLong((this.r[n] + ((op & 0xF) << 2)) >>> 0, this.r[m] >>> 0);
				break;
			case 0x2: this.group2(op, n, m); break;
			case 0x3: this.group3(op, n, m); break;
			case 0x4: this.group4(op, n, m); break;
			case 0x5: // MOV.L @(disp,Rm), Rn
				this.r[n] = this.readLong((this.r[m] + ((op & 0xF) << 2)) >>> 0) | 0;
				break;
			case 0x6: this.group6(op, n, m); break;
			case 0x7: // ADD #imm, Rn
				this.r[n] = (this.r[n] + this.sign8(op & 0xFF)) | 0;
				break;
			case 0x8: this.group8(op, n, m); break;
			case 0x9: // MOV.W @(disp,PC), Rn
				this.r[n] = this.sign16(this.readWord(((this.pc + 2) + ((op & 0xFF) << 1)) >>> 0)) | 0;
				break;
			case 0xA: // BRA disp
				this.jumpDelayed(((this.pc + 2) + (this.sign12(op & 0xFFF) << 1)) >>> 0);
				break;
			case 0xB: // BSR disp
				this.pr = (this.pc + 2) | 0;
				this.jumpDelayed(((this.pc + 2) + (this.sign12(op & 0xFFF) << 1)) >>> 0);
				break;
			case 0xC: this.groupC(op, n, m); break;
			case 0xD: // MOV.L @(disp,PC), Rn
				this.r[n] = this.readLong(((((this.pc + 2) & 0xFFFFFFFC) >>> 0) + ((op & 0xFF) << 2)) >>> 0) | 0;
				break;
			case 0xE: // MOV #imm, Rn
				this.r[n] = this.sign8(op & 0xFF) | 0;
				break;
			default:
				this.illegal(op);
		}
	}

	// ---------- Group 0x0nnn ----------
	group0(op, n, m)
	{
		switch(op & 0xF)
		{
			case 0x2: // STC (various control registers to Rn)
				switch((op >> 4) & 0xF)
				{
					case 0x0: this.r[n] = this.sr | 0; break;   // STC SR, Rn
					case 0x1: this.r[n] = this.gbr | 0; break;  // STC GBR, Rn
					case 0x2: this.r[n] = this.vbr | 0; break;  // STC VBR, Rn
					default: this.illegal(op);
				}
				break;

			case 0x3: // indirect branches with delay slot
				switch((op >> 4) & 0xF)
				{
					case 0x0: // BSRF Rm
						this.pr = (this.pc + 2) | 0;
						this.jumpDelayed(((this.pc + 2) + this.r[n]) >>> 0);
						break;
					case 0x2: // BRAF Rm
						this.jumpDelayed(((this.pc + 2) + this.r[n]) >>> 0);
						break;
					case 0x8: // PREF @Rn: prefetch of the cache line that contains @Rn.
						// It is only a performance hint: with no cache model it does nothing
						// (same as Yabause). SH-2 compilers emit it, so
						// treating it as illegal stops the core on perfectly valid code.
						break;
					default: this.illegal(op);
				}
				break;

			case 0x4: // MOV.B Rm, @(R0,Rn)
				this.writeByte((this.r[n] + this.r[0]) >>> 0, this.r[m] & 0xFF);
				break;
			case 0x5: // MOV.W Rm, @(R0,Rn)
				this.writeWord((this.r[n] + this.r[0]) >>> 0, this.r[m] & 0xFFFF);
				break;
			case 0x6: // MOV.L Rm, @(R0,Rn)
				this.writeLong((this.r[n] + this.r[0]) >>> 0, this.r[m] >>> 0);
				break;

			case 0x7: // MUL.L Rm, Rn -> MACL
				this.macl = Math.imul(this.r[n], this.r[m]) | 0;
				break;

			case 0x8: // instructions with no operand
				switch(op)
				{
					case 0x0008: this.flagT = 0; break;             // CLRT
					case 0x0018: this.flagT = 1; break;             // SETT
					case 0x0028: this.mach = 0; this.macl = 0; break; // CLRMAC
					default: this.illegal(op);
				}
				break;

			case 0x9:
				if(op === 0x0009)      { /* NOP */ }
				else if(op === 0x0019) { this.flagQ = 0; this.flagM = 0; this.flagT = 0; }   // DIV0U (M=Q=T=0)
				else if((op & 0xF0FF) === 0x0029) { this.r[n] = this.flagT | 0; } // MOVT Rn
				else this.illegal(op);
				break;

			case 0xA: // STS (MACH/MACL/PR to Rn)
				switch((op >> 4) & 0xF)
				{
					case 0x0: this.r[n] = this.mach | 0; break;  // STS MACH, Rn
					case 0x1: this.r[n] = this.macl | 0; break;  // STS MACL, Rn
					case 0x2: this.r[n] = this.pr | 0; break;    // STS PR, Rn
					default: this.illegal(op);
				}
				break;

			case 0xB: // RTS / RTE / SLEEP
				if(op === 0x000B)      { this.jumpDelayed(this.pr >>> 0); }        // RTS
				else if(op === 0x002B) { this.rte(); }                                 // RTE
				else if(op === 0x001B) { this.sleeping = true; }                      // SLEEP
				else this.illegal(op);
				break;

			case 0xC: // MOV.B @(R0,Rm), Rn (signed)
				this.r[n] = (this.readByte((this.r[m] + this.r[0]) >>> 0) << 24) >> 24;
				break;
			case 0xD: // MOV.W @(R0,Rm), Rn (signed)
				this.r[n] = (this.readWord((this.r[m] + this.r[0]) >>> 0) << 16) >> 16;
				break;
			case 0xE: // MOV.L @(R0,Rm), Rn
				this.r[n] = this.readLong((this.r[m] + this.r[0]) >>> 0) | 0;
				break;

			case 0xF: // MAC.L @Rm+, @Rn+
				this.macLong(n, m);
				break;

			default:
				this.illegal(op);
		}
	}

	// ---------- Group 0x2nnn ----------
	group2(op, n, m)
	{
		switch(op & 0xF)
		{
			case 0x0: this.writeByte(this.r[n] >>> 0, this.r[m] & 0xFF); break;   // MOV.B Rm,@Rn
			case 0x1: this.writeWord(this.r[n] >>> 0, this.r[m] & 0xFFFF); break; // MOV.W Rm,@Rn
			case 0x2: this.writeLong(this.r[n] >>> 0, this.r[m] >>> 0); break;    // MOV.L Rm,@Rn

			// Pre-decrement: the ORIGINAL value of Rm is written. With n==m it has to be
			// read before decrementing, otherwise the already decremented pointer is stored.
			case 0x4: // MOV.B Rm, @-Rn
			{
				const v = this.r[m] & 0xFF;
				this.r[n] = (this.r[n] - 1) | 0;
				this.writeByte(this.r[n] >>> 0, v);
				break;
			}
			case 0x5: // MOV.W Rm, @-Rn
			{
				const v = this.r[m] & 0xFFFF;
				this.r[n] = (this.r[n] - 2) | 0;
				this.writeWord(this.r[n] >>> 0, v);
				break;
			}
			case 0x6: // MOV.L Rm, @-Rn
			{
				const v = this.r[m] >>> 0;
				this.r[n] = (this.r[n] - 4) | 0;
				this.writeLong(this.r[n] >>> 0, v);
				break;
			}

			case 0x7: // DIV0S Rm, Rn
				this.flagQ = (this.r[n] >>> 31) & 1;
				this.flagM = (this.r[m] >>> 31) & 1;
				this.flagT = this.flagQ ^ this.flagM;
				break;

			case 0x8: // TST Rm, Rn
				this.flagT = ((this.r[n] & this.r[m]) === 0) ? 1 : 0;
				break;
			case 0x9: this.r[n] = (this.r[n] & this.r[m]) | 0; break;   // AND Rm,Rn
			case 0xA: this.r[n] = (this.r[n] ^ this.r[m]) | 0; break;   // XOR Rm,Rn
			case 0xB: this.r[n] = (this.r[n] | this.r[m]) | 0; break;   // OR Rm,Rn

			case 0xC: // CMP/STR Rm, Rn (some byte equal)
			{
				const x = (this.r[n] ^ this.r[m]) >>> 0;
				const hasZero =
					((x & 0xFF000000) === 0) || ((x & 0x00FF0000) === 0) ||
					((x & 0x0000FF00) === 0) || ((x & 0x000000FF) === 0);
				this.flagT = hasZero ? 1 : 0;
				break;
			}

			case 0xD: // XTRCT Rm, Rn
				this.r[n] = (((this.r[m] << 16) & 0xFFFF0000) | ((this.r[n] >>> 16) & 0xFFFF)) | 0;
				break;

			case 0xE: // MULU.W Rm, Rn -> MACL (unsigned, 16x16)
				this.macl = ((this.r[n] & 0xFFFF) * (this.r[m] & 0xFFFF)) | 0;
				break;
			case 0xF: // MULS.W Rm, Rn -> MACL (signed, 16x16)
				this.macl = (((this.r[n] << 16) >> 16) * ((this.r[m] << 16) >> 16)) | 0;
				break;

			default:
				this.illegal(op);
		}
	}

	// ---------- Group 0x3nnn (register-register arithmetic and comparison) ----------
	group3(op, n, m)
	{
		switch(op & 0xF)
		{
			case 0x0: this.flagT = (this.r[n] === this.r[m]) ? 1 : 0; break;                       // CMP/EQ
			case 0x2: this.flagT = ((this.r[n] >>> 0) >= (this.r[m] >>> 0)) ? 1 : 0; break;        // CMP/HS
			case 0x3: this.flagT = (this.r[n] >= this.r[m]) ? 1 : 0; break;                        // CMP/GE
			case 0x6: this.flagT = ((this.r[n] >>> 0) >  (this.r[m] >>> 0)) ? 1 : 0; break;        // CMP/HI
			case 0x7: this.flagT = (this.r[n] >  this.r[m]) ? 1 : 0; break;                        // CMP/GT

			case 0x4: this.div1(m, n); break;                                                     // DIV1

			case 0x5: // DMULU.L (unsigned, 64 bits)
				this.dmul(n, m, false);
				break;
			case 0xD: // DMULS.L (signed, 64 bits)
				this.dmul(n, m, true);
				break;

			case 0x8: this.r[n] = (this.r[n] - this.r[m]) | 0; break;                             // SUB
			case 0xA: this.subc(n, m); break;                                                     // SUBC
			case 0xB: this.subv(n, m); break;                                                     // SUBV
			case 0xC: this.r[n] = (this.r[n] + this.r[m]) | 0; break;                             // ADD
			case 0xE: this.addc(n, m); break;                                                     // ADDC
			case 0xF: this.addv(n, m); break;                                                     // ADDV

			default:
				this.illegal(op);
		}
	}

	// ---------- Group 0x4nnn (shifts, system control, indirect jumps) ----------
	group4(op, n, m)
	{
		// MAC.W @Rm+,@Rn+ is 0100nnnnmmmm1111: the m field varies, so it cannot be
		// dispatched by (op & 0xFF) like the rest of the group. It is handled separately.
		if((op & 0xF) === 0xF)
		{
			this.macWord(n, m);
			return;
		}

		switch(op & 0xFF)
		{
			case 0x00: this.shll(n); break;                 // SHLL Rn
			case 0x01: this.shlr(n); break;                 // SHLR Rn
			case 0x04: this.rotl(n); break;                 // ROTL Rn
			case 0x05: this.rotr(n); break;                 // ROTR Rn
			case 0x08: this.r[n] = (this.r[n] << 2) | 0; break;    // SHLL2
			case 0x09: this.r[n] = (this.r[n] >>> 2) | 0; break;   // SHLR2
			case 0x18: this.r[n] = (this.r[n] << 8) | 0; break;    // SHLL8
			case 0x19: this.r[n] = (this.r[n] >>> 8) | 0; break;   // SHLR8
			case 0x28: this.r[n] = (this.r[n] << 16) | 0; break;   // SHLL16
			case 0x29: this.r[n] = (this.r[n] >>> 16) | 0; break;  // SHLR16
			case 0x20: this.shal(n); break;                 // SHAL Rn
			case 0x21: this.shar(n); break;                 // SHAR Rn
			case 0x24: this.rotcl(n); break;                // ROTCL Rn
			case 0x25: this.rotcr(n); break;                // ROTCR Rn

			case 0x10: // DT Rn
				this.r[n] = (this.r[n] - 1) | 0;
				this.flagT = (this.r[n] === 0) ? 1 : 0;
				break;
			case 0x11: this.flagT = (this.r[n] >= 0) ? 1 : 0; break;   // CMP/PZ
			case 0x15: this.flagT = (this.r[n] >  0) ? 1 : 0; break;   // CMP/PL

			case 0x0B: // JSR @Rn (saves the return address in PR)
				this.pr = (this.pc + 2) | 0;
				this.jumpDelayed(this.r[n] >>> 0);
				break;
			case 0x2B: this.jumpDelayed(this.r[n] >>> 0); break;                     // JMP @Rn

			case 0x1B: this.tas(n); break;                  // TAS.B @Rn

			// LDC (Rn -> control register)
			case 0x0E: this.sr = this.r[n] & 0x000003F3; break;   // LDC Rm,SR
			case 0x1E: this.gbr = this.r[n] | 0; break;           // LDC Rm,GBR
			case 0x2E: this.vbr = this.r[n] | 0; break;           // LDC Rm,VBR

			// LDS (Rn -> MACH/MACL/PR)
			case 0x0A: this.mach = this.r[n] | 0; break;          // LDS Rm,MACH
			case 0x1A: this.macl = this.r[n] | 0; break;          // LDS Rm,MACL
			case 0x2A: this.pr = this.r[n] | 0; break;            // LDS Rm,PR

			// STS.L (MACH/MACL/PR -> @-Rn)
			case 0x02: this.r[n] = (this.r[n]-4)|0; this.writeLong(this.r[n]>>>0, this.mach>>>0); break; // STS.L MACH
			case 0x12: this.r[n] = (this.r[n]-4)|0; this.writeLong(this.r[n]>>>0, this.macl>>>0); break; // STS.L MACL
			case 0x22: this.r[n] = (this.r[n]-4)|0; this.writeLong(this.r[n]>>>0, this.pr>>>0); break;   // STS.L PR

			// STC.L (SR/GBR/VBR -> @-Rn)
			case 0x03: this.r[n] = (this.r[n]-4)|0; this.writeLong(this.r[n]>>>0, this.sr>>>0); break;   // STC.L SR
			case 0x13: this.r[n] = (this.r[n]-4)|0; this.writeLong(this.r[n]>>>0, this.gbr>>>0); break;  // STC.L GBR
			case 0x23: this.r[n] = (this.r[n]-4)|0; this.writeLong(this.r[n]>>>0, this.vbr>>>0); break;  // STC.L VBR

			// LDS.L (@Rn+ -> MACH/MACL/PR)
			case 0x06: this.mach = this.readLong(this.r[n]>>>0)|0; this.r[n]=(this.r[n]+4)|0; break; // LDS.L MACH
			case 0x16: this.macl = this.readLong(this.r[n]>>>0)|0; this.r[n]=(this.r[n]+4)|0; break; // LDS.L MACL
			case 0x26: this.pr   = this.readLong(this.r[n]>>>0)|0; this.r[n]=(this.r[n]+4)|0; break; // LDS.L PR

			// LDC.L (@Rn+ -> SR/GBR/VBR)
			case 0x07: this.sr  = this.readLong(this.r[n]>>>0) & 0x000003F3; this.r[n]=(this.r[n]+4)|0; break; // LDC.L SR
			case 0x17: this.gbr = this.readLong(this.r[n]>>>0)|0; this.r[n]=(this.r[n]+4)|0; break; // LDC.L GBR
			case 0x27: this.vbr = this.readLong(this.r[n]>>>0)|0; this.r[n]=(this.r[n]+4)|0; break; // LDC.L VBR

			default:
				this.illegal(op);
		}
	}

	// ---------- Group 0x6nnn (register/indirect MOV and unary ops) ----------
	group6(op, n, m)
	{
		switch(op & 0xF)
		{
			case 0x0: this.r[n] = (this.readByte(this.r[m]>>>0) << 24) >> 24; break;   // MOV.B @Rm,Rn
			case 0x1: this.r[n] = (this.readWord(this.r[m]>>>0) << 16) >> 16; break;   // MOV.W @Rm,Rn
			case 0x2: this.r[n] = this.readLong(this.r[m]>>>0) | 0; break;             // MOV.L @Rm,Rn
			case 0x3: this.r[n] = this.r[m] | 0; break;                                   // MOV Rm,Rn

			// Post-increment: if n==m the register is left with the data read, it is NOT
			// incremented (the data overwrites the pointer). It is the SH-2's rule.
			case 0x4: // MOV.B @Rm+, Rn
				this.r[n] = (this.readByte(this.r[m]>>>0) << 24) >> 24;
				if(n !== m) this.r[m] = (this.r[m] + 1) | 0;
				break;
			case 0x5: // MOV.W @Rm+, Rn
				this.r[n] = (this.readWord(this.r[m]>>>0) << 16) >> 16;
				if(n !== m) this.r[m] = (this.r[m] + 2) | 0;
				break;
			case 0x6: // MOV.L @Rm+, Rn
				this.r[n] = this.readLong(this.r[m]>>>0) | 0;
				if(n !== m) this.r[m] = (this.r[m] + 4) | 0;
				break;

			case 0x7: this.r[n] = ~this.r[m] | 0; break;                                  // NOT Rm,Rn
			case 0x8: // SWAP.B Rm,Rn
				this.r[n] = ((this.r[m] & 0xFFFF0000) | ((this.r[m] & 0xFF) << 8) | ((this.r[m] >> 8) & 0xFF)) | 0;
				break;
			case 0x9: // SWAP.W Rm,Rn
				this.r[n] = (((this.r[m] << 16) | ((this.r[m] >>> 16) & 0xFFFF))) | 0;
				break;
			case 0xA: this.negc(n, m); break;                                             // NEGC Rm,Rn
			case 0xB: this.r[n] = (0 - this.r[m]) | 0; break;                             // NEG Rm,Rn
			case 0xC: this.r[n] = this.r[m] & 0xFF; break;                               // EXTU.B
			case 0xD: this.r[n] = this.r[m] & 0xFFFF; break;                             // EXTU.W
			case 0xE: this.r[n] = (this.r[m] << 24) >> 24; break;                        // EXTS.B
			case 0xF: this.r[n] = (this.r[m] << 16) >> 16; break;                        // EXTS.W

			default:
				this.illegal(op);
		}
	}

	// ---------- Group 0x8nnn (MOV with R0 disp, CMP/EQ imm, conditional branches) ----------
	group8(op, n, m)
	{
		switch((op >> 8) & 0xF)
		{
			case 0x0: // MOV.B R0, @(disp,Rn)
				this.writeByte((this.r[m] + (op & 0xF)) >>> 0, this.r[0] & 0xFF);
				break;
			case 0x1: // MOV.W R0, @(disp,Rn)
				this.writeWord((this.r[m] + ((op & 0xF) << 1)) >>> 0, this.r[0] & 0xFFFF);
				break;
			case 0x4: // MOV.B @(disp,Rm), R0 (signed)
				this.r[0] = (this.readByte((this.r[m] + (op & 0xF)) >>> 0) << 24) >> 24;
				break;
			case 0x5: // MOV.W @(disp,Rm), R0 (signed)
				this.r[0] = (this.readWord((this.r[m] + ((op & 0xF) << 1)) >>> 0) << 16) >> 16;
				break;

			case 0x8: // CMP/EQ #imm, R0
				this.flagT = (this.r[0] === this.sign8(op & 0xFF)) ? 1 : 0;
				break;

			// The 4 conditionals cost MORE when they take the branch (SH7604:
			// BT/BF 3 versus 1, BT/S and BF/S 2 versus 1). The SH2_CYCLES table has the
			// "does not branch" case; the extra is added here, which is where the T flag is known.
			case 0x9: // BT disp (no delay slot)
				if(this.flagT)
				{
					this.pc = ((this.pc + 2) + (this.sign8(op & 0xFF) << 1)) >>> 0;
					this.cycles += SH2_EXTRA_JUMP;
				}
				break;
			case 0xB: // BF disp
				if(!this.flagT)
				{
					this.pc = ((this.pc + 2) + (this.sign8(op & 0xFF) << 1)) >>> 0;
					this.cycles += SH2_EXTRA_JUMP;
				}
				break;
			case 0xD: // BT/S disp (with delay slot)
				if(this.flagT)
				{
					this.jumpDelayed(((this.pc + 2) + (this.sign8(op & 0xFF) << 1)) >>> 0);
					this.cycles += SH2_EXTRA_JUMP_S;
				}
				break;
			case 0xF: // BF/S disp
				if(!this.flagT)
				{
					this.jumpDelayed(((this.pc + 2) + (this.sign8(op & 0xFF) << 1)) >>> 0);
					this.cycles += SH2_EXTRA_JUMP_S;
				}
				break;

			default:
				this.illegal(op);
		}
	}

	// ---------- Group 0xCnnn (GBR accesses, MOVA, TRAPA, immediate logic) ----------
	groupC(op, n, m)
	{
		const imm = op & 0xFF;
		switch((op >> 8) & 0xF)
		{
			case 0x0: this.writeByte((this.gbr + imm) >>> 0, this.r[0] & 0xFF); break;        // MOV.B R0,@(disp,GBR)
			case 0x1: this.writeWord((this.gbr + (imm << 1)) >>> 0, this.r[0] & 0xFFFF); break; // MOV.W
			case 0x2: this.writeLong((this.gbr + (imm << 2)) >>> 0, this.r[0] >>> 0); break;   // MOV.L
			case 0x4: this.r[0] = (this.readByte((this.gbr + imm) >>> 0) << 24) >> 24; break;     // MOV.B @(disp,GBR),R0
			case 0x5: this.r[0] = (this.readWord((this.gbr + (imm << 1)) >>> 0) << 16) >> 16; break; // MOV.W
			case 0x6: this.r[0] = this.readLong((this.gbr + (imm << 2)) >>> 0) | 0; break;        // MOV.L

			case 0x7: // MOVA @(disp,PC), R0
				this.r[0] = ((((this.pc + 2) & 0xFFFFFFFC) >>> 0) + (imm << 2)) | 0;
				break;

			case 0x3: this.trapa(imm); break;                                                        // TRAPA #imm

			case 0x8: this.flagT = ((this.r[0] & imm) === 0) ? 1 : 0; break;                          // TST #imm,R0
			case 0x9: this.r[0] = (this.r[0] & imm) | 0; break;                                       // AND #imm,R0
			case 0xA: this.r[0] = (this.r[0] ^ imm) | 0; break;                                       // XOR #imm,R0
			case 0xB: this.r[0] = (this.r[0] | imm) | 0; break;                                       // OR #imm,R0

			case 0xC: // TST.B #imm, @(R0,GBR)
				this.flagT = ((this.readByte((this.r[0] + this.gbr) >>> 0) & imm) === 0) ? 1 : 0;
				break;
			case 0xD: // AND.B #imm, @(R0,GBR)
			{
				const d = (this.r[0] + this.gbr) >>> 0;
				this.writeByte(d, this.readByte(d) & imm);
				break;
			}
			case 0xE: // XOR.B #imm, @(R0,GBR)
			{
				const d = (this.r[0] + this.gbr) >>> 0;
				this.writeByte(d, this.readByte(d) ^ imm);
				break;
			}
			case 0xF: // OR.B #imm, @(R0,GBR)
			{
				const d = (this.r[0] + this.gbr) >>> 0;
				this.writeByte(d, this.readByte(d) | imm);
				break;
			}

			default:
				this.illegal(op);
		}
	}

	// ---------- Arithmetic with carry/overflow ----------
	addc(n, m)
	{
		const sum = (this.r[n] >>> 0) + (this.r[m] >>> 0) + this.flagT;
		this.flagT = (sum > 0xFFFFFFFF) ? 1 : 0;
		this.r[n] = sum | 0;
	}

	addv(n, m)
	{
		const dst = this.r[n], src = this.r[m];
		const res = (dst + src) | 0;
		this.flagT = (((dst ^ res) & (src ^ res)) < 0) ? 1 : 0;
		this.r[n] = res;
	}

	subc(n, m)
	{
		const remaining = (this.r[n] >>> 0) - (this.r[m] >>> 0) - this.flagT;
		this.flagT = (remaining < 0) ? 1 : 0;
		this.r[n] = remaining | 0;
	}

	subv(n, m)
	{
		const dst = this.r[n], src = this.r[m];
		const res = (dst - src) | 0;
		this.flagT = (((dst ^ src) & (dst ^ res)) < 0) ? 1 : 0;
		this.r[n] = res;
	}

	negc(n, m)
	{
		const remaining = (0 - (this.r[m] >>> 0) - this.flagT);
		this.flagT = (remaining < 0) ? 1 : 0;
		this.r[n] = remaining | 0;
	}

	// ---------- Step-by-step division (the SH-2's DIV1 algorithm) ----------
	div1(m, n)
	{
		const oldQ = this.flagQ;
		const M = this.flagM;
		this.flagQ = (this.r[n] >>> 31) & 1;
		//? Known divergence vs Yabause, only with n==m: the SH-2 reads Rm
		//? BEFORE the shift of Rn (tmp2 = R[m]) and Yabause reads it after. We follow
		//? the hardware. With n!=m they are identical and no compiler emits DIV1 Rn,Rn.
		const tmp2 = this.r[m] >>> 0;
		this.r[n] = ((this.r[n] << 1) | this.flagT) | 0;
		const tmp0 = this.r[n] >>> 0;
		let tmp1;

		// Subtract if oldQ==M, add otherwise.
		if(oldQ === M)
		{
			this.r[n] = (this.r[n] - tmp2) | 0;
			tmp1 = ((this.r[n] >>> 0) > tmp0) ? 1 : 0;
		}
		else
		{
			this.r[n] = (this.r[n] + tmp2) | 0;
			tmp1 = ((this.r[n] >>> 0) < tmp0) ? 1 : 0;
		}

		// The Q update rule depends on M (not on whether it subtracted or added).
		if(M === 0)
			this.flagQ = this.flagQ ? (tmp1 ? 0 : 1) : tmp1;
		else
			this.flagQ = this.flagQ ? tmp1 : (tmp1 ? 0 : 1);

		this.flagT = (this.flagQ === M) ? 1 : 0;
	}

	// ---------- 64-bit multiplications ----------
	dmul(n, m, withSign)
	{
		// 64-bit product without BigInt (avoids ~7 heap allocs per MUL/DMUL). The core is the
		// UNSIGNED product by 16-bit halves; for signed, the adjustment subtracts each negative
		// operand from hi. Verified bit by bit vs BigInt in the mul64 oracle (1.2M cases, 0 failures).
		const a = this.r[n] | 0, b = this.r[m] | 0;
		const aLo = a & 0xFFFF, aHi = a >>> 16, bLo = b & 0xFFFF, bHi = b >>> 16;
		const p0 = aLo * bLo, p1 = aHi * bLo, p2 = aLo * bHi, p3 = aHi * bHi;
		const c = (p0 >>> 16) + (p1 & 0xFFFF) + (p2 & 0xFFFF);
		this.macl = (((c & 0xFFFF) << 16) | (p0 & 0xFFFF)) | 0;
		let hi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (c >>> 16)) >>> 0;
		if(withSign) { if(a < 0) hi = (hi - (b >>> 0)) >>> 0; if(b < 0) hi = (hi - (a >>> 0)) >>> 0; }
		this.mach = hi | 0;
	}

	// MAC.W @Rm+, @Rn+ : multiplies signed words and accumulates into MACH:MACL.
	macWord(n, m)
	{
		const valN = (this.readWord(this.r[n] >>> 0) << 16) >> 16;
		this.r[n] = (this.r[n] + 2) | 0;
		const valM = (this.readWord(this.r[m] >>> 0) << 16) >> 16;
		this.r[m] = (this.r[m] + 2) | 0;
		const prod = valN * valM;
		// SATURATION MODE (SR's S bit): with S=1, MAC.W is 16x16+32 -> 32
		// ONLY on MACL, clamped to H'80000000..H'7FFFFFFF. Overflow detection is
		// by SIGNS, exactly as in the instruction's pseudocode: dest = sign of the old MACL, src =
		// sign of the product + dest, ans = sign of the new MACL + dest; there was overflow if ans==1,
		// and src tells the side (0 = it went over the top, 2 = under the bottom).
		// MACH IS NOT TOUCHED: the "MACH |= 1" in the pseudocode is SH-1 ONLY (it is marked
		// as SH-1-specific, under #if SH1).
		// The descriptive text contradicts it without distinguishing CPUs; the specific annotation wins.
		if(this.sr & 0x2)
		{
			const dest = (this.macl | 0) < 0 ? 1 : 0;
			const src  = ((prod | 0) < 0 ? 1 : 0) + dest;
			const newMacl = ((this.macl | 0) + (prod | 0)) | 0;
			const ans = (newMacl < 0 ? 1 : 0) + dest;
			this.macl = newMacl;
			if(ans === 1)
			{
				if(src === 0)      this.macl = 0x7FFFFFFF | 0;
				else if(src === 2) this.macl = 0x80000000 | 0;
			}
			return;
		}
		// 64-bit accumulation without BigInt: the 16x16 product fits in 32 and is added to mach:macl
		// with a manual carry (verified bit by bit vs BigInt in the mul64 oracle).
		const pLo = prod | 0, pHi = prod < 0 ? -1 : 0;
		const sumLo = (this.macl >>> 0) + (pLo >>> 0);
		const carry = sumLo >= 4294967296 ? 1 : 0;
		this.macl = sumLo | 0;
		this.mach = (this.mach + pHi + carry) | 0;
	}

	// MAC.L @Rm+, @Rn+ : multiplies signed longs and accumulates.
	macLong(n, m)
	{
		const valN = this.readLong(this.r[n] >>> 0) | 0;
		this.r[n] = (this.r[n] + 4) | 0;
		const valM = this.readLong(this.r[m] >>> 0) | 0;
		this.r[m] = (this.r[m] + 4) | 0;
		// Signed 64-bit product (valN*valM) + accumulation, without BigInt. Same core as
		// signed dmul, plus the manual carry of the 64-bit addition (verified vs BigInt).
		const aLo = valN & 0xFFFF, aHi = valN >>> 16, bLo = valM & 0xFFFF, bHi = valM >>> 16;
		const p0 = aLo * bLo, p1 = aHi * bLo, p2 = aLo * bHi, p3 = aHi * bHi;
		const c = (p0 >>> 16) + (p1 & 0xFFFF) + (p2 & 0xFFFF);
		const pLo = (((c & 0xFFFF) << 16) | (p0 & 0xFFFF)) >>> 0;
		let pHi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (c >>> 16)) >>> 0;
		if(valN < 0) pHi = (pHi - (valM >>> 0)) >>> 0;
		if(valM < 0) pHi = (pHi - (valN >>> 0)) >>> 0;
		const sumLo = (this.macl >>> 0) + pLo;
		const carry = sumLo >= 4294967296 ? 1 : 0;
		const res0 = sumLo | 0;
		const res2 = (this.mach + (pHi | 0) + carry) | 0;
		// SATURATION MODE (S bit): with S=1 the MAC.L accumulator is 48 BITS
		// -(MACH & 0xFFFF) << 32 | MACL- and it is clamped to H'FFFF800000000000..H'00007FFFFFFFFFFF.
		// The exact conditions on Res2 (the low 16 of MACH already added):
		// negative if (long)Res2 < 0 && Res2 < 0xFFFF8000; positive if (long)Res2 > 0 &&
		// Res2 > 0x00007FFF (the bounds are compared UNSIGNED).
		// DISCREPANCY BETWEEN VERSIONS, chosen and commented: two versions of this pseudocode exist. The older one writes
		// MACH = Res2 whole, and its own negative clamp prints 0x00008000, which contradicts the
		// description that goes with it. We follow the CURRENT version, which fixes the negative
		// clamp to 0xFFFF8000 and PRESERVES the high 16 of MACH
		// (MACH = (Res2 & 0xFFFF) | (MACH & 0xFFFF0000)). The 48 valid bits -which are the
		// only ones saturation mode defines- come out IDENTICAL in both versions.
		if(this.sr & 0x2)
		{
			// THE SATURATED ACCUMULATOR IS 48 BITS, AND IT HAS TO BE BUILT AS SUCH. The
			// MAC.L operation with S=1 starts like this:
			//     Res2 = MACH & 0x0000FFFF;
			//     if (Res2 & 0x00008000) Res2 |= 0xFFFF0000;   // sign extension of bit 15
			//     Res2 += ...
			// i.e. it adds onto the LOW 16 bits of MACH WITH THE SIGN EXTENDED, not onto the
			// raw 32. The difference is not cosmetic: the high 16 of MACH are garbage that
			// saturation mode itself PRESERVES without using (see the final MACH, below), so
			// adding them in brings in a gigantic value and both clamp comparisons fire
			// when they should not.
			//
			// THIS WAS THE SEGA TOURING CAR BLACK CAR BUG (25-07-2026). The slave does
			// geometry and lighting with MAC.L and S=1: 34,680 per 10 frames, of which
			// 2,300 over-saturated (typical: MACH 0xFFFF0000 -> clamp to 0xFFFF8000,
			// when in 48 bits 0xFFFF0000 has its low 16 at ZERO and is not negative). The
			// light level always came out at the minimum, the slave always wrote CMDCOLR=0x200
			// (a bank whose index 6 is 0x0001, black) and the car was drawn as a silhouette.
			let r0 = res0;
			let r2 = ((((this.mach << 16) >> 16) + (pHi | 0) + carry) | 0);
			if(r2 < 0 && (r2 >>> 0) < 0xFFFF8000)      { r2 = 0xFFFF8000 | 0; r0 = 0x00000000 | 0; }
			else if(r2 > 0 && (r2 >>> 0) > 0x00007FFF) { r2 = 0x00007FFF | 0; r0 = 0xFFFFFFFF | 0; }
			this.macl = r0;
			this.mach = ((r2 & 0xFFFF) | (this.mach & 0xFFFF0000)) | 0;
			return;
		}
		this.macl = res0;
		this.mach = res2;
	}

	// ---------- Shifts and rotations (set T with the bit shifted out) ----------
	shll(n)  { this.flagT = (this.r[n] >>> 31) & 1; this.r[n] = (this.r[n] << 1) | 0; }
	shlr(n)  { this.flagT = this.r[n] & 1; this.r[n] = (this.r[n] >>> 1) | 0; }
	shal(n)  { this.flagT = (this.r[n] >>> 31) & 1; this.r[n] = (this.r[n] << 1) | 0; }
	shar(n)  { this.flagT = this.r[n] & 1; this.r[n] = (this.r[n] >> 1) | 0; }
	rotl(n)  { this.flagT = (this.r[n] >>> 31) & 1; this.r[n] = ((this.r[n] << 1) | this.flagT) | 0; }
	rotr(n)  { this.flagT = this.r[n] & 1; this.r[n] = ((this.r[n] >>> 1) | (this.flagT << 31)) | 0; }

	rotcl(n)
	{
		const bit = (this.r[n] >>> 31) & 1;
		this.r[n] = ((this.r[n] << 1) | this.flagT) | 0;
		this.flagT = bit;
	}
	rotcr(n)
	{
		const bit = this.r[n] & 1;
		this.r[n] = ((this.r[n] >>> 1) | (this.flagT << 31)) | 0;
		this.flagT = bit;
	}

	// TAS.B @Rn : atomic test-and-set. T = (byte==0), then sets bit 7.
	tas(n)
	{
		const addr = this.r[n] >>> 0;
		const val = this.readByte(addr);
		this.flagT = (val === 0) ? 1 : 0;
		this.writeByte(addr, val | 0x80);
	}

	// TRAPA #imm : software exception.
	trapa(imm)
	{
		this.r[15] = (this.r[15] - 4) | 0;
		this.writeLong(this.r[15] >>> 0, this.sr >>> 0);
		this.r[15] = (this.r[15] - 4) | 0;
		this.writeLong(this.r[15] >>> 0, this.pc >>> 0);
		this.pc = this.readLong((this.vbr + (imm << 2)) >>> 0) >>> 0;
	}

	// RTE : return from exception (with delay slot). Restores PC and SR from the stack.
	rte()
	{
		const newPc = this.readLong(this.r[15] >>> 0) >>> 0;
		this.r[15] = (this.r[15] + 4) | 0;
		const newSr = this.readLong(this.r[15] >>> 0) & 0x000003F3;
		this.r[15] = (this.r[15] + 4) | 0;
		this.sr = newSr;
		this.jumpDelayed(newPc);
	}

	// Unimplemented opcode: stops the core and reports it (radar of what the BIOS is missing).
	// It also dumps WHERE it came from: a 0x0000 is not an opcode left to implement, it is
	// the core executing empty RAM because someone sent it there. The PC says where it died;
	// PR says who called it, and the pointer-looking registers, with what data.
	// Costs zero on the hot path: it only runs once it has already failed.
	illegal(op)
	{
		this.halted = true;
		const hex = (v, n) => (v >>> 0).toString(16).padStart(n, "0");
		const addr = (this.pc - 2) >>> 0;

		let msg = "[" + this.name + "] illegal/unimplemented opcode: 0x" + hex(op & 0xFFFF, 4)
			+ " at PC=0x" + hex(addr, 8);

		// 0x0000 does not exist as an instruction: the core is not missing it, the core got lost.
		if((op & 0xFFFF) === 0x0000)
			msg += "\n  (0x0000 is not an opcode: it is executing empty memory)";

		msg += "\n  PR=0x" + hex(this.pr, 8) + " (who called it)"
			+ "   VBR=0x" + hex(this.vbr, 8) + "   SR=0x" + hex(this.sr, 4);

		const regs = [];
		for(let i = 0; i < 16; i++) regs.push("R" + i + "=0x" + hex(this.r[i], 8));
		msg += "\n  " + regs.slice(0, 8).join("  ") + "\n  " + regs.slice(8).join("  ");

		// The jump trail, if tracing was on (cpuSlave.tracing = true). From the
		// oldest to the newest: the second to last is the instruction that jumped into empty memory.
		if(this.tracing)
		{
			const h = [];
			for(let i = 0; i < 16; i++) h.push("0x" + hex(this.histPc[(this.histIdx + i) & 15], 8));
			msg += "\n  last PCs (old -> new):\n  " + h.slice(0, 8).join(" ")
				+ "\n  " + h.slice(8).join(" ");
		}

		console.warn(msg);
	}
}
