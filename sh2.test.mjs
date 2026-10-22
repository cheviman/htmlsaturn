/**
 *    Name:         sh2.test.mjs
 *    Description:  Test suite for the SH-2 core. Runs against a flat test RAM
 *                  (isolated from the real memory map) to verify the
 *                  CPU itself: arithmetic, flags, shifts, division and branches
 *                  with delay slot. Run with: node sh2.test.mjs
 *    Version:      0.2.0
 *    Created:      15-07-2026
 *    Modified:     15-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync } from "fs";
// sh2.js is a browser script (global class, no export). We load it with
// eval because it is the project's own trusted code; there is no external input.
eval(readFileSync("sh2.js", "utf8") + "\nglobalThis.SH2=SH2;");

// Flat test bus: all memory is read/write RAM. It isolates the CPU test
// from the rules of the real memory map (where 0x1000 would be Boot ROM).
class FlatBus
{
	constructor()        { this.ram = new Uint8Array(0x100000); }
	readByte(d)          { return this.ram[d & 0xFFFFF]; }
	readWord(d)          { return ((this.readByte(d) << 8) | this.readByte(d + 1)) >>> 0; }
	readLong(d)          { return ((this.readByte(d) << 24) | (this.readByte(d + 1) << 16) | (this.readByte(d + 2) << 8) | this.readByte(d + 3)) >>> 0; }
	writeByte(d, v)   { this.ram[d & 0xFFFFF] = v & 0xFF; }
	writeWord(d, v)   { this.writeByte(d, v >> 8); this.writeByte(d + 1, v); }
	writeLong(d, v)   { this.writeByte(d, v >>> 24); this.writeByte(d + 1, v >>> 16); this.writeByte(d + 2, v >>> 8); this.writeByte(d + 3, v); }
}

let passed = 0, failed = 0;
function check(name, expected, obtained)
{
	if(expected === obtained) passed++;
	else { failed++; console.log("  FAIL", name, "exp", expected, "got", obtained); }
}
// mem: optional object { address: longValue } to prefill memory before running.
function run(prog, regs = {}, steps = 200, mem = {})
{
	const bus = new FlatBus();
	for(let i = 0; i < prog.length; i++) bus.writeWord(0x1000 + i * 2, prog[i]);
	for(const d in mem) bus.writeLong(d | 0, mem[d] >>> 0);
	const cpu = new SH2(bus, "test");
	cpu.pc = 0x1000; cpu.sr = 0x000000F0;
	for(const k in regs) cpu.r[k] = regs[k] | 0;
	for(let i = 0; i < steps && !cpu.halted; i++) cpu.step();
	return { cpu, bus };
}

// Basic arithmetic + store/load
{
	const { cpu, bus } = run([0xE005,0xE107,0x6203,0x321C,0xE310,0x2322,0x6432,0x3408,0xE520,0x2542,0x0009], {}, 11);
	check("R2=12", 12, cpu.r[2]); check("[0x10]=12", 12, bus.readLong(0x10)); check("R4=7", 7, cpu.r[4]);
}
// ADDC wrap 0xFFFFFFFF+1=0, T=1
{
	const { cpu } = run([0xE0FF,0xE101,0x0008,0x301E,0x0009], {}, 5);
	check("ADDC wrap R0=0", 0, cpu.r[0] | 0); check("ADDC carry T=1", 1, cpu.flagT);
}
// CMP/GT signed vs CMP/HS unsigned
{ const { cpu } = run([0xE0FF,0xE101,0x3017,0x0009], {}, 4); check("CMP/GT -1>1 = 0", 0, cpu.flagT); }
{ const { cpu } = run([0xE0FF,0xE101,0x3012,0x0009], {}, 4); check("CMP/HS 0xFFFFFFFF>=1 = 1", 1, cpu.flagT); }
// SHLL sets T with bit 31
{
	const { cpu } = run([0xE080,0x4000,0x0009], {}, 3);
	check("SHLL T=1", 1, cpu.flagT); check("SHLL R0=0xFFFFFF00", 0xFFFFFF00, cpu.r[0] >>> 0);
}
// DT + BF/S loop: sum 1..10 = 55
{
	const { cpu } = run([0x301C,0x4110,0x8FFC,0x0009,0x0009,0x0009], { 0:0, 1:10 }, 200);
	check("sum 1..10 = 55", 55, cpu.r[0]); check("counter R1=0", 0, cpu.r[1]);
}
// BSR + RTS (with self-park so the subroutine is not reentered)
{
	const prog = new Array(20).fill(0x0009);
	prog[0]=0xE005; prog[1]=0xB005; prog[2]=0x0009; prog[3]=0xAFFE; prog[4]=0x0009;
	prog[8]=0x300C; prog[9]=0x000B; prog[10]=0x0009;
	const { cpu } = run(prog, {}, 30);
	check("BSR/RTS doubles R0=10", 10, cpu.r[0]); check("PR return=0x1006", 0x1006, cpu.pr >>> 0);
}
// @-Rn pre-decrement / @Rm+ post-increment
{
	const { cpu, bus } = run([0x2106,0x6216,0x0009], { 0:0x1234, 1:0x200 }, 3);
	check("@-Rn R1 goes back to 0x200", 0x200, cpu.r[1] >>> 0);
	check("@Rm+ R2=0x1234", 0x1234, cpu.r[2]); check("[0x1FC]=0x1234", 0x1234, bus.readLong(0x1FC));
}
// Unsigned 32/16 division: 1000/7 = 142
{
	const prog = [0x4028,0x0019];
	for(let i = 0; i < 16; i++) prog.push(0x3104);
	prog.push(0x4124, 0x611D, 0x0009);
	const { cpu } = run(prog, { 0:7, 1:1000 }, 40);
	check("division 1000/7 = 142", 142, cpu.r[1]);
}
// EXTS.B / SWAP.B
{ const { cpu } = run([0x601E,0x0009], { 1:0xA5 }, 2); check("EXTS.B 0xA5", 0xFFFFFFA5, cpu.r[0] >>> 0); }
{ const { cpu } = run([0x6018,0x0009], { 1:0x1234 }, 2); check("SWAP.B 0x1234->0x3412", 0x3412, cpu.r[0] >>> 0); }
// MOV.L @(disp,PC): loads a constant from the pool (aligned)
{
	const { cpu } = run([0xD001,0x0009,0x0009,0x0009,0xDEAD,0xBEEF], {}, 1);
	check("MOV.L @(disp,PC) = 0xDEADBEEF", 0xDEADBEEF, cpu.r[0] >>> 0);
}

// ---------------------------------------------------------------------------
// DIVU: the SH7604's hardware divider (on-chip registers at 0xFFFFFF00).
// The BIOS does ALL its divisions with this; without the DIVU the accesses fell into
// WRAM and returned garbage, and the boot never turned on the display.
// Real sequence the BIOS uses:
//   MOV.L R2,@R1        -> DVSR   (divisor)
//   MOV.L R3,@(0x4,R1)  -> DVDNT  (dividend) : starts the 32/32 division
//   MOV.L @(0x4,R1),R0  -> quotient ; @(0x10,R1) -> remainder
// ---------------------------------------------------------------------------
const DIVU = 0xFFFFFF00 | 0;
const PROG_DIV32 = [0x2122, 0x1131, 0x5011, 0x5414, 0x0009];
{
	const { cpu } = run(PROG_DIV32, { 1: DIVU, 2: 7, 3: 1000 }, 5);
	check("DIVU 32/32: 1000/7 quotient=142", 142, cpu.r[0] | 0);
	check("DIVU 32/32: 1000/7 remainder=6", 6, cpu.r[4] | 0);
}
// Truncates toward zero with negatives (same as the HW, not floor)
{
	const { cpu } = run(PROG_DIV32, { 1: DIVU, 2: 7, 3: -1000 }, 5);
	check("DIVU 32/32: -1000/7 quotient=-142", -142, cpu.r[0] | 0);
	check("DIVU 32/32: -1000/7 remainder=-6", -6, cpu.r[4] | 0);
}
{
	const { cpu } = run(PROG_DIV32, { 1: DIVU, 2: -7, 3: 1000 }, 5);
	check("DIVU 32/32: 1000/-7 quotient=-142", -142, cpu.r[0] | 0);
}
// Division by zero: saturates the quotient and sets OVF in DVCR
{
	const { cpu } = run(PROG_DIV32, { 1: DIVU, 2: 0, 3: 1000 }, 5);
	check("DIVU div0: quotient saturates to 0x7FFFFFFF", 0x7FFFFFFF, cpu.r[0] >>> 0);
	check("DIVU div0: DVCR sets OVF", 1, cpu.divu.dvcr & 1);
}
{
	const { cpu } = run(PROG_DIV32, { 1: DIVU, 2: 0, 3: -1000 }, 5);
	check("DIVU div0 negative: quotient saturates to 0x80000000", 0x80000000, cpu.r[0] >>> 0);
}
// DIVU 64/32: DVDNTH:DVDNTL / DVSR. Starts when DVDNTL is written.
//   MOV.L R2,@R1 ; MOV.L R3,@(0x10,R1) ; MOV.L R4,@(0x14,R1) ; @(0x14,R1)->R0 ; @(0x10,R1)->R5
const PROG_DIV64 = [0x2122, 0x1134, 0x1145, 0x5015, 0x5514, 0x0009];
{
	// 0x0000000200000000 / 0x10000 = 0x20000
	const { cpu } = run(PROG_DIV64, { 1: DIVU, 2: 0x10000, 3: 0x2, 4: 0x0 }, 6);
	check("DIVU 64/32: 0x200000000/0x10000 = 0x20000", 0x20000, cpu.r[0] >>> 0);
	check("DIVU 64/32: remainder=0", 0, cpu.r[5] | 0);
}
{
	// -1 in 64 bits (0xFFFFFFFF_FFFFFFFF) / 2 = 0, remainder -1 (truncates toward zero)
	const { cpu } = run(PROG_DIV64, { 1: DIVU, 2: 2, 3: -1, 4: -1 }, 6);
	check("DIVU 64/32: -1/2 quotient=0", 0, cpu.r[0] | 0);
	check("DIVU 64/32: -1/2 remainder=-1", -1, cpu.r[5] | 0);
}
{
	// Quotient that does not fit in signed 32 bits -> OVF and saturates
	const { cpu } = run(PROG_DIV64, { 1: DIVU, 2: 1, 3: 0x1, 4: 0x0 }, 6);
	check("DIVU 64/32 overflow: saturates to 0x7FFFFFFF", 0x7FFFFFFF, cpu.r[0] >>> 0);
	check("DIVU 64/32 overflow: DVCR sets OVF", 1, cpu.divu.dvcr & 1);
}
// The on-chip area must NOT go out to the bus (before, it was written to WRAM through the mirror)
{
	const { cpu, bus } = run(PROG_DIV32, { 1: DIVU, 2: 7, 3: 1000 }, 5);
	check("DIVU does not touch the bus (0xFFFFFF00 does not land in RAM)", 0, bus.readLong(0xFFFFFF00 & 0xFFFFF) >>> 0);
	check("DIVU: DVSR was stored", 7, cpu.divu.dvsr | 0);
}

// MAC.W @Rm+,@Rn+ with m!=0: the dispatch by (op & 0xFF) did not match it and it fell into
// illegal(), which stops the whole core. Opcode 0x412F = MAC.W @R2+,@R1+.
{
	const { cpu } = run([0x0028, 0x412F, 0x0009], { 1: 0x2000, 2: 0x2004 }, 3,
		{ 0x2000: 0x00030000, 0x2004: 0x00050000 });   // signed words: 3 and 5
	check("MAC.W with m!=0 does not stop the core", false, cpu.halted);
	check("MAC.W with m!=0: MACL = 3*5 = 15", 15, cpu.macl | 0);
	check("MAC.W with m!=0: R1 post-incremented", 0x2002, cpu.r[1] >>> 0);
	check("MAC.W with m!=0: R2 post-incremented", 0x2006, cpu.r[2] >>> 0);
}

// DIV0U must clear M, Q and T (M=Q=T=0)
{
	const { cpu } = run([0x0018, 0x0019, 0x0009], {}, 3);   // SETT ; DIV0U
	check("DIV0U clears T", 0, cpu.flagT);
	check("DIV0U clears Q", 0, cpu.flagQ);
	check("DIV0U clears M", 0, cpu.flagM);
}

// MOV.L @Rm+,Rn with n==m: the data read overwrites the pointer, it is NOT post-incremented.
{
	const { cpu } = run([0x6116, 0x0009], { 1: 0x2000 }, 2, { 0x2000: 0xDEADBEEF });
	check("MOV.L @R1+,R1 (n==m) does not increment", 0xDEADBEEF, cpu.r[1] >>> 0);
}
{
	const { cpu } = run([0x6115, 0x0009], { 1: 0x2000 }, 2, { 0x2000: 0x12340000 });
	check("MOV.W @R1+,R1 (n==m) does not increment", 0x1234, cpu.r[1] >>> 0);
}

// MOV.L Rm,@-Rn with n==m: the ORIGINAL value is stored, not the already decremented one.
{
	const { cpu, bus } = run([0x2FF6, 0x0009], { 15: 0x3000 }, 2);
	check("MOV.L R15,@-R15 (n==m) stores the original value", 0x3000, bus.readLong(0x2FFC) >>> 0);
	check("MOV.L R15,@-R15 (n==m) R15 decremented", 0x2FFC, cpu.r[15] >>> 0);
}

// ---------------------------------------------------------------------------
// Delay slots and interrupts. SH-2 rule: an IRQ is NEVER accepted between a
// jump instruction and its delay slot (they execute atomically). If it were accepted,
// the pushed PC would be wrong and RTE would land anywhere.
// Verified against Yabause: SH2HandleInterrupts is called ONLY before the execution
// while loop, never inside it, and SH2delay() runs the slot inside the branch's opcode.
// ---------------------------------------------------------------------------
// Builds a standalone CPU to control step by step (run() is not enough for this).
function cpuWithProgram(prog, base = 0x1000)
{
	const bus = new FlatBus();
	for(const d in prog) bus.writeWord(d | 0, prog[d]);
	const cpu = new SH2(bus, "test");
	cpu.pc = base; cpu.sr = 0x000000F0;
	return { cpu, bus };
}

// A branch and its delay slot execute in a single step(): the PC is never left "in"
// a delay slot between steps, so it is impossible to interrupt there.
{
	const { cpu } = cpuWithProgram({ 0x1000: 0xA007, 0x1002: 0xE12A });   // BRA 0x1012 ; MOV #42,R1
	cpu.step();
	check("branch+delay slot: a single step executes both", 42, cpu.r[1] | 0);
	check("branch+delay slot: PC = target", 0x1012, cpu.pc >>> 0);
}
// With a servable IRQ pending, it vectors BEFORE the branch: the pushed PC is the
// branch's (0x1000), NEVER the delay slot's (0x1002).
// Note: step() vectors AND executes the first ISR instruction in the same call
// (same as Yabause: SH2HandleInterrupts() and then it enters the execution while loop).
{
	const { cpu, bus } = cpuWithProgram({ 0x1000: 0xA007, 0x1002: 0xE12A, 0x2000: 0x0009 });
	bus.writeLong(0x3000 + 0x40 * 4, 0x2000);
	cpu.sr = 0x00000000; cpu.vbr = 0x3000; cpu.r[15] = 0x8000;
	cpu.requestInterrupt(0xF, 0x40);
	cpu.step();
	check("IRQ: pushed PC = the branch, not the delay slot", 0x1000, bus.readLong(cpu.r[15]) >>> 0);
	check("IRQ: the delay slot was NOT executed on its own", 0, cpu.r[1] | 0);
	check("IRQ: vectored to the ISR (its 1st instr already ran)", 0x2002, cpu.pc >>> 0);
}
// Masked IRQ (level 15 vs IMASK 15): not served, the branch runs completely.
{
	const { cpu } = cpuWithProgram({ 0x1000: 0xA007, 0x1002: 0xE12A });
	cpu.vbr = 0x3000; cpu.r[15] = 0x8000;
	cpu.requestInterrupt(0xF, 0x40);
	cpu.step();
	check("masked IRQ does not split the branch", 42, cpu.r[1] | 0);
	check("masked IRQ: PC = target", 0x1012, cpu.pc >>> 0);
	check("masked IRQ stays pending (it is not lost)", 1, cpu.irqPending.length);
}

// Push order when vectoring: [R15]=PC, [R15+4]=SR. RTE restores them in that order.
{
	// ISR: NOP at 0x2000 (the one that runs together with the vectoring), RTE at 0x2002 + its delay slot.
	const { cpu, bus } = cpuWithProgram({ 0x1000: 0x0009, 0x2000: 0x0009, 0x2002: 0x002B, 0x2004: 0x0009 });
	bus.writeLong(0x3000 + 0x40 * 4, 0x2000);
	cpu.sr = 0x00000001; cpu.vbr = 0x3000; cpu.r[15] = 0x8000;
	cpu.requestInterrupt(0xF, 0x40);
	cpu.step();                                   // vectors + 1st instr of the ISR
	check("vectoring: [R15] = PC", 0x1000, bus.readLong(0x8000 - 8) >>> 0);
	check("vectoring: [R15+4] = SR", 0x00000001, bus.readLong(0x8000 - 4) >>> 0);
	check("vectoring: R15 went down by 8", 0x8000 - 8, cpu.r[15] >>> 0);
	check("vectoring: IMASK rose to the IRQ's level", 0xF, (cpu.sr >> 4) & 0xF);
	cpu.step();                                   // RTE + delay slot
	check("RTE: PC restored", 0x1000, cpu.pc >>> 0);
	check("RTE: SR restored", 0x00000001, cpu.sr >>> 0);
	check("RTE: R15 restored", 0x8000, cpu.r[15] >>> 0);
}

// If the delay slot modifies the jump's register, the OLD value is used.
{
	const { cpu } = cpuWithProgram({ 0x1000: 0x432B, 0x1002: 0xE300 });   // JMP @R3 ; MOV #0,R3
	cpu.r[3] = 0x1500;
	cpu.step();
	check("JMP @R3: the delay slot overwrites R3, the old value is used", 0x1500, cpu.pc >>> 0);
	check("JMP @R3: the delay slot still executed", 0, cpu.r[3] | 0);
}
{
	const { cpu } = cpuWithProgram({ 0x1000: 0x430B, 0x1002: 0xE300 });   // JSR @R3 ; MOV #0,R3
	cpu.r[3] = 0x1500;
	cpu.step();
	check("JSR @R3: uses the old R3", 0x1500, cpu.pc >>> 0);
	check("JSR @R3: PR = PC+4 (after the delay slot)", 0x1004, cpu.pr >>> 0);
}
// BRAF/BSRF add PC+4+Rn (not PC+2+Rn nor plain Rn).
{
	const { cpu } = cpuWithProgram({ 0x1000: 0x0323, 0x1002: 0x0009 });   // BRAF R3 ; NOP
	cpu.r[3] = 0x100;
	cpu.step();
	check("BRAF R3: target = PC+4+R3", 0x1104, cpu.pc >>> 0);
}
{
	const { cpu } = cpuWithProgram({ 0x1000: 0x0303, 0x1002: 0x0009 });   // BSRF R3 ; NOP
	cpu.r[3] = 0x100;
	cpu.step();
	check("BSRF R3: target = PC+4+R3", 0x1104, cpu.pc >>> 0);
	check("BSRF R3: PR = PC+4", 0x1004, cpu.pr >>> 0);
}
{
	const { cpu } = cpuWithProgram({ 0x1000: 0x0323, 0x1002: 0xE300 });   // BRAF R3 ; MOV #0,R3
	cpu.r[3] = 0x100;
	cpu.step();
	check("BRAF R3: the delay slot overwrites R3, the old value is used", 0x1104, cpu.pc >>> 0);
}
// RTS uses the PR from before the delay slot.
{
	const { cpu } = cpuWithProgram({ 0x1000: 0x000B, 0x1002: 0xE100 });   // RTS ; MOV #0,R1
	cpu.pr = 0x1500; cpu.r[1] = 7;
	cpu.step();
	check("RTS: jumps to PR", 0x1500, cpu.pc >>> 0);
	check("RTS: the delay slot executed", 0, cpu.r[1] | 0);
}

// ---------------------------------------------------------------------------
// SH7604 on-chip FRT (Free-Running Timer).
// The FRC was declared but NOBODY incremented it: it always returned the last
// value written. A game that times itself with it (start=FRC; while(FRC-start<N);)
// spins FOREVER without throwing a single error.
// Silent bug, as deadly as the DIVU one.
// ---------------------------------------------------------------------------

// Bare CPU, no program: it is run with _frtRun() directly.
function cpuFrt()
{
	const cpu = new SH2(new FlatBus(), "test");
	cpu.pc = 0x1000; cpu.sr = 0x000000F0;
	return cpu;
}
// FRC = byte pair 0xFFFFFE12 (H) / 0xFFFFFE13 (L).
function frc(cpu) { return (cpu.internalRegs[0x12] << 8) | cpu.internalRegs[0x13]; }

// --- On-chip reset values (the FRT and every other module) ---
{
	const cpu = cpuFrt();
	check("reset: TIER = H'01", 0x01, cpu.internalRegs[0x10]);
	check("reset: FTCSR = H'00", 0x00, cpu.internalRegs[0x11]);
	check("reset: FRC = H'0000", 0x0000, frc(cpu));
	check("reset: OCRA = H'FFFF", 0xFFFF, cpu.frt.ocra);
	check("reset: OCRB = H'FFFF", 0xFFFF, cpu.frt.ocrb);
	check("reset: TCR = H'00", 0x00, cpu.internalRegs[0x16]);
	check("reset: TOCR = H'E0", 0xE0, cpu.internalRegs[0x17]);
	check("reset: SSR = H'84", 0x84, cpu.internalRegs[0x04]);
	check("reset: BRR = H'FF", 0xFF, cpu.internalRegs[0x01]);
	check("reset: TDR = H'FF", 0xFF, cpu.internalRegs[0x03]);
	check("reset: WTCSR = H'18", 0x18, cpu.internalRegs[0x80]);
	check("reset: RSTCSR = H'1F", 0x1F, cpu.internalRegs[0x83]);
	check("reset: SBYCR = H'60", 0x60, cpu.internalRegs[0x91]);
	check("reset: BCR2 = H'00FC", 0x00FC, cpu.readInternal(0xFFFFFFE4, 4));
	check("reset: WCR = H'AAFF", 0xAAFF, cpu.readInternal(0xFFFFFFE8, 4));
}
// reset() has to REAPPLY the values, not leave everything at zero, and without overwriting MASTER.
{
	const cpu = new SH2(new FlatBus(), "slave");
	cpu.internalRegs.fill(0x77);                  // dirty the whole on-chip area
	cpu.frt.ocra = 0x1234; cpu.frt.ocrb = 0x5678; cpu.frt.remainder = 5;
	cpu.reset();
	check("reset(): reapplies TIER = H'01", 0x01, cpu.internalRegs[0x10]);
	check("reset(): reapplies TOCR = H'E0", 0xE0, cpu.internalRegs[0x17]);
	check("reset(): reapplies OCRA = H'FFFF", 0xFFFF, cpu.frt.ocra);
	check("reset(): reapplies OCRB = H'FFFF", 0xFFFF, cpu.frt.ocrb);
	check("reset(): clears the prescaler remainder", 0, cpu.frt.remainder);
	check("reset(): reapplies SSR = H'84", 0x84, cpu.internalRegs[0x04]);
	check("reset(): keeps the slave's MASTER bit", 0x8000, cpu.bcr1 & 0x8000);
	check("reset(): restores the rest of BCR1 to H'03F0", 0x03F0, cpu.bcr1 & 0x7FFF);
}

// --- The FRC runs, and it runs at the pace of the TCR prescaler (CKS1/CKS0) ---
{
	const cpu = cpuFrt();                        // TCR = H'00 -> f/8
	cpu._frtRun(7);
	check("prescaler /8: after 7 cycles the FRC is still at 0", 0, frc(cpu));
	cpu._frtRun(1);
	check("prescaler /8: at cycle 8 the FRC is 1", 1, frc(cpu));
	cpu._frtRun(800);
	check("prescaler /8: 800 more cycles -> FRC = 101", 101, frc(cpu));
}
{
	const cpu = cpuFrt();
	cpu.writeByte(0xFFFFFE16, 0x01);          // TCR: CKS=01 -> f/32 (through the bus: recalculates the cached prescaler)
	cpu._frtRun(31);
	check("prescaler /32: after 31 cycles the FRC is still at 0", 0, frc(cpu));
	cpu._frtRun(1);
	check("prescaler /32: at cycle 32 the FRC is 1", 1, frc(cpu));
}
{
	const cpu = cpuFrt();
	cpu.writeByte(0xFFFFFE16, 0x02);          // TCR: CKS=10 -> f/128 (through the bus: recalculates the cached prescaler)
	cpu._frtRun(127);
	check("prescaler /128: after 127 cycles the FRC is still at 0", 0, frc(cpu));
	cpu._frtRun(1);
	check("prescaler /128: at cycle 128 the FRC is 1", 1, frc(cpu));
}
{
	const cpu = cpuFrt();
	cpu.writeByte(0xFFFFFE16, 0x03);          // TCR: CKS=11 -> EXTERNAL clock (FTCI pin) (through the bus: recalculates the cached prescaler)
	cpu._frtRun(10000);
	check("CKS=11 (external clock): the FRC does not run on the CPU clock", 0, frc(cpu));
}

// --- The hookup: step() has to make the FRT run. This is what was missing. ---
{
	const bus = new FlatBus();
	for(let i = 0; i < 64; i++) bus.writeWord(0x1000 + i * 2, 0x0009);   // NOPs
	const cpu = new SH2(bus, "test");
	cpu.pc = 0x1000; cpu.sr = 0x000000F0;
	for(let i = 0; i < 8; i++) cpu.step();
	check("step(): 8 instructions -> the FRC ticked once", 1, frc(cpu));
	for(let i = 0; i < 24; i++) cpu.step();
	check("step(): 32 instructions -> FRC = 4", 4, frc(cpu));
}
// In SLEEP the CPU stops but the peripherals do NOT: the on-chip peripheral modules
// continue to run in sleep mode. If the FRC stopped, a game that
// sleeps waiting for the FRT's output compare would never wake up.
{
	const cpu = cpuFrt();
	cpu.sleeping = true;
	for(let i = 0; i < 80; i++) cpu.step();
	check("SLEEP: the FRC keeps running", 10, frc(cpu));
}

// --- FRC overflow (OVF, FTCSR bit 1) ---
{
	const cpu = cpuFrt();
	cpu.internalRegs[0x12] = 0xFF; cpu.internalRegs[0x13] = 0xFF;   // FRC = H'FFFF
	cpu._frtRun(8);
	check("overflow: the FRC wraps around to H'0000", 0, frc(cpu));
	check("overflow: raises OVF (FTCSR bit 1)", 0x02, cpu.internalRegs[0x11] & 0x02);
	check("overflow: without OVIE it does not interrupt", 0, cpu.irqPending.length);
}
{
	const cpu = cpuFrt();
	cpu.internalRegs[0x12] = 0xFF; cpu.internalRegs[0x13] = 0xFF;
	cpu.internalRegs[0x10] = 0x03;                // TIER: OVIE (bit 1) + the reserved bit
	cpu.internalRegs[0x60] = 0x0E;                // IPRB: FRTIP (bits 11-8) = 14
	cpu.internalRegs[0x68] = 0x42;                // VCRD: FOVV (bits 14-8) = 0x42
	cpu._frtRun(8);
	check("overflow with OVIE: requests an interrupt", 1, cpu.irqPending.length);
	check("overflow: level = IPRB's FRTIP", 14, cpu.irqPending[0].level);
	check("overflow: vector = VCRD's FOVV (not the input capture one)", 0x42, cpu.irqPending[0].vector);
}

// --- Output compare A/B (OCFA bit 3 / OCFB bit 2) ---
{
	const cpu = cpuFrt();
	cpu.frt.ocra = 3;
	cpu._frtRun(16);
	check("OCRA: before the match there is no OCFA", 0, cpu.internalRegs[0x11] & 0x08);
	cpu._frtRun(8);
	check("OCRA: with FRC=OCRA it raises OCFA (bit 3)", 0x08, cpu.internalRegs[0x11] & 0x08);
	check("OCRA: without CCLRA the FRC is not touched", 3, frc(cpu));
	cpu._frtRun(8);
	check("OCRA: without CCLRA the FRC keeps going", 4, frc(cpu));
}
{
	const cpu = cpuFrt();
	cpu.frt.ocra = 1;
	cpu.internalRegs[0x10] = 0x09;                // TIER: OCIAE (bit 3) + reserved
	cpu.internalRegs[0x60] = 0x0C;                // IPRB: FRTIP = 12
	cpu.internalRegs[0x66] = 0x21;                // VCRC bits 14-8: FICV (input capture) = 0x21
	cpu.internalRegs[0x67] = 0x55;                // VCRC bits 6-0: FOCV (output compare) = 0x55
	cpu._frtRun(8);
	check("OCIAE: requests an interrupt on the match", 1, cpu.irqPending.length);
	check("OCIAE: level = IPRB's FRTIP", 12, cpu.irqPending[0].level);
	check("OCIAE: vector = FOCV, NOT the input capture FICV", 0x55, cpu.irqPending[0].vector);
}
{
	const cpu = cpuFrt();
	cpu.frt.ocrb = 2;
	cpu.internalRegs[0x10] = 0x05;                // TIER: OCIBE (bit 2) + reserved
	cpu.internalRegs[0x60] = 0x08;                // IPRB: FRTIP = 8
	cpu.internalRegs[0x67] = 0x56;                // FOCV
	cpu._frtRun(16);
	check("OCRB: raises OCFB (bit 2)", 0x04, cpu.internalRegs[0x11] & 0x04);
	check("OCIBE: requests an interrupt", 1, cpu.irqPending.length);
	check("OCIBE: shares the FOCV vector with A (same OCI line)", 0x56, cpu.irqPending[0].vector);
}
// CCLRA (FTCSR bit 0): the FRC goes back to 0 on compare match A -> PERIODIC timer.
{
	const cpu = cpuFrt();
	cpu.frt.ocra = 3;
	cpu.internalRegs[0x11] = 0x01;                // FTCSR: CCLRA
	cpu._frtRun(24);
	check("CCLRA: the FRC goes back to 0 on match A", 0, frc(cpu));
	check("CCLRA: it still raises OCFA", 0x08, cpu.internalRegs[0x11] & 0x08);
	cpu._frtRun(24);
	check("CCLRA: it is periodic (it matches and clears again)", 0, frc(cpu));
}
// Without CCLRA the FRC is NOT cleared: it is the "free stopwatch" mode timeouts use.
{
	const cpu = cpuFrt();
	cpu.frt.ocra = 3;
	cpu._frtRun(24 * 2);
	check("without CCLRA the FRC is not cleared on the match", 6, frc(cpu));
}
// The hardware uses EQUALITY (when the FRC value becomes equal to OCRA), not
// crossing: with OCR=0 the match falls right when the counter wraps around. Yabause's
// crossing test (frctemp >= ocra && frcold < ocra) would never match here.
{
	const cpu = cpuFrt();
	cpu.frt.ocra = 0;
	cpu.internalRegs[0x12] = 0xFF; cpu.internalRegs[0x13] = 0xFF;   // FRC = H'FFFF
	cpu._frtRun(8);
	check("OCRA=0: matches when the FRC wraps around", 0x08, cpu.internalRegs[0x11] & 0x08);
	check("OCRA=0: the overflow is raised on the same tick", 0x02, cpu.internalRegs[0x11] & 0x02);
}
// BOTH comparators look at the same edge: the clear by A's CCLRA cannot
// force a match on B.
{
	const cpu = cpuFrt();
	cpu.frt.ocra = 3; cpu.frt.ocrb = 0;
	cpu.internalRegs[0x11] = 0x01;                // CCLRA
	cpu._frtRun(24);
	check("A's CCLRA does not fire OCFB on an OCRB=0", 0, cpu.internalRegs[0x11] & 0x04);
}

// --- OCRA and OCRB SHARE the address 0xFFFFFE14/15; OCRS breaks the tie ---
{
	const cpu = cpuFrt();
	cpu.writeInternal(0xFFFFFE14, 0x12, 1);    // reset TOCR = H'E0 -> OCRS=0 -> OCRA
	cpu.writeInternal(0xFFFFFE15, 0x34, 1);
	check("OCRS=0: the write hits OCRA", 0x1234, cpu.frt.ocra);
	check("OCRS=0: OCRB stays intact", 0xFFFF, cpu.frt.ocrb);
	check("OCRS=0: reads OCRA H", 0x12, cpu.readInternal(0xFFFFFE14, 1));
	check("OCRS=0: reads OCRA L", 0x34, cpu.readInternal(0xFFFFFE15, 1));
	cpu.writeInternal(0xFFFFFE17, 0xF0, 1);    // TOCR: OCRS (bit 4) = 1
	cpu.writeInternal(0xFFFFFE14, 0xAB, 1);
	cpu.writeInternal(0xFFFFFE15, 0xCD, 1);
	check("OCRS=1: the SAME address hits OCRB", 0xABCD, cpu.frt.ocrb);
	check("OCRS=1: OCRA was not touched", 0x1234, cpu.frt.ocra);
	check("OCRS=1: reads OCRB H", 0xAB, cpu.readInternal(0xFFFFFE14, 1));
}

// --- FTCSR is R/(W): the flags are only CLEARED by writing 0 ---
{
	const cpu = cpuFrt();
	cpu.internalRegs[0x11] = 0x08;                // OCFA was raised by the HW
	cpu.writeInternal(0xFFFFFE11, 0xFF, 1);    // attempt to raise all the flags by hand
	check("FTCSR: writing 1 does NOT raise flags", 0x09, cpu.internalRegs[0x11]);
	cpu.writeInternal(0xFFFFFE11, 0x00, 1);
	check("FTCSR: writing 0 clears them", 0x00, cpu.internalRegs[0x11]);
	cpu.writeInternal(0xFFFFFE11, 0x01, 1);
	check("FTCSR: bit 0 (CCLRA) is normal R/W", 0x01, cpu.internalRegs[0x11]);
}
// The input capture (the doorbell between the two SH-2s) has to keep copying the FRC
// that NOW runs, not a stuck zero.
{
	const cpu = cpuFrt();
	cpu._frtRun(8 * 0x123);
	cpu.inputCapture();
	check("input capture: copies the live FRC into FICR", 0x0123,
		(cpu.internalRegs[0x18] << 8) | cpu.internalRegs[0x19]);
	check("input capture: raises ICF (FTCSR bit 7)", 0x80, cpu.internalRegs[0x11] & 0x80);
}

// --- THE BUG, end-to-end: a game timing itself with the FRC ---
// It is the pattern that hangs silently if the FRC does not run. Program:
//   R1 = 0xFFFFFE12 (FRC), R2 = expected value
//   0x1000: MOV.W @R1,R0   ; R0 = FRC
//   0x1002: CMP/EQ R2,R0
//   0x1004: BF 0x1000      ; spins until the FRC gets there
//   0x1006: MOV #99,R3     ; mark that it LEFT the loop
//   0x1008: BRA 0x1008     ; self-park
{
	const { cpu } = run([0x6011, 0x3020, 0x8BFC, 0xE363, 0xAFFE, 0x0009],
		{ 1: 0xFFFFFE12, 2: 5 }, 300);
	check("timeout with the FRC: the loop ENDS", 99, cpu.r[3] | 0);
	check("timeout with the FRC: it left with the value it expected", 5, cpu.r[0] | 0);
	check("timeout with the FRC: it did not hang or blow up", false, cpu.halted);
}

// ---------------------------------------------------------------------------
// P6: SH7604 on-chip WDT (Watchdog Timer).
// The three registers were stored RAW:
// WTCNT never ran, so interval mode never fired its ITI
// and a watchdog reset never happened.
// On top of that, writing was broken: it carries a magic byte and the generic path
// stored the two bytes as they were.
// ---------------------------------------------------------------------------

// WDT addresses. CAREFUL: write and read addresses do NOT match.
const WDT_W  = 0xFFFFFE80;   // write (word) of WTCSR (A5xx) and WTCNT (5Axx)
const WDT_RC = 0xFFFFFE82;   // write (word) of RSTCSR
const WTCSR  = 0xFFFFFE80;   // read (byte)
const WTCNT  = 0xFFFFFE81;   // read (byte)
const RSTCSR = 0xFFFFFE83;   // read (byte)

const wtcnt = (cpu) => cpu.readInternal(WTCNT, 1);

// --- Reset values ---
{
	const cpu = cpuFrt();
	check("reset: WTCSR = H'18", 0x18, cpu.readInternal(WTCSR, 1));
	check("reset: WTCNT = H'00", 0x00, wtcnt(cpu));
	check("reset: RSTCSR = H'1F", 0x1F, cpu.readInternal(RSTCSR, 1));
}

// --- Register access. The strangest thing in the whole chip. ---
// The write data must be contained in the lower byte of the written word. The upper
// byte must be H'5A (for WTCNT) or H'A5 (for WTCSR).
// THE BUG: the generic path left WTCSR=0xA5 (the MAGIC byte) and WTCNT=0x18 from a
// single WTCSR write. Both registers with garbage.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA518, 2);       // WTCSR <- 0x18
	check("WTCSR: the A5xx write does NOT leave the magic byte in the register", 0x18, cpu.readInternal(WTCSR, 1));
	check("WTCSR: ...and does NOT overwrite WTCNT with the data", 0x00, wtcnt(cpu));
}
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0x5A42, 2);       // WTCNT <- 0x42
	check("WTCNT: the 5Axx write hits WTCNT", 0x42, wtcnt(cpu));
	check("WTCNT: ...and does not touch WTCSR", 0x18, cpu.readInternal(WTCSR, 1));
}
// They cannot be written by byte or longword transfer instructions.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xFF, 1);
	check("the WDT ignores a BYTE write", 0x18, cpu.readInternal(WTCSR, 1));
}
// The LONG is the one that really tests the width check: unlike the byte, it CAN
// carry a magic byte inside (here the 0x5A of the second word). Without the check,
// this long would write WTCNT = 0x42 (mutation testing caught it).
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA5185A42, 4);
	check("the WDT ignores a LONG write: WTCSR", 0x18, cpu.readInternal(WTCSR, 1));
	check("the WDT ignores a LONG write: WTCNT", 0x00, wtcnt(cpu));
}
// Invalid magic byte: neither 5A nor A5, nothing is written.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0x1234, 2);
	check("invalid magic byte: writes nothing", 0x18, cpu.readInternal(WTCSR, 1));
}
// 0xFE81 and 0xFE83 are READ addresses. Writing them would dodge the magic
// byte, which is exactly the protection the chip wants: they cannot fall through to the raw path.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WTCNT, 0x77, 1);
	check("writing to WTCNT's READ address does not hit it", 0x00, wtcnt(cpu));
	cpu.writeInternal(RSTCSR, 0x00, 1);
	check("writing to RSTCSR's READ address does not hit it", 0x1F, cpu.readInternal(RSTCSR, 1));
}
// WTCSR bits 4-3 are reserved and always read 1.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA500, 2);
	check("WTCSR: the reserved bits 4-3 read 1 even if 0 is written", 0x18, cpu.readInternal(WTCSR, 1));
}

// --- The hookup: step() has to make WTCNT run. This is what was missing. ---
// TME (bit 5) is the only thing that starts it: when the timer enable bit (TME) is set
// to 1, the watchdog timer counter starts counting.
{
	const cpu = cpuFrt();
	for(let i = 0; i < 64; i++) cpu.step();
	check("TME=0: WTCNT does NOT run", 0x00, wtcnt(cpu));
}
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA520, 2);       // TME=1, CKS=000 -> /2
	for(let i = 0; i < 8; i++) cpu.step();
	check("TME=1, CKS=000 (/2): 8 cycles -> WTCNT = 4", 4, wtcnt(cpu));
}
// Prescaler: the table is NOT a regular progression (/2 and then /64).
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA521, 2);       // TME=1, CKS=001 -> /64
	for(let i = 0; i < 64; i++) cpu.step();
	check("CKS=001 (/64): 64 cycles -> WTCNT = 1 (the /2 -> /64 jump)", 1, wtcnt(cpu));
}
// The /8192 at the end is measured at its EXACT EDGE: with "100 cycles are not enough" a /2048
// passed as well, so it proved nothing (mutation testing caught it).
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA527, 2);       // TME=1, CKS=111 -> /8192
	cpu._wdtRun(8191);
	check("CKS=111 (/8192): 8191 cycles are NOT enough for a tick", 0, wtcnt(cpu));
	cpu._wdtRun(1);
	check("CKS=111 (/8192): cycle 8192 gives the exact tick", 1, wtcnt(cpu));
}
// And the same with /4096, the table's other odd jump.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA526, 2);       // TME=1, CKS=110 -> /4096
	cpu._wdtRun(4095);
	check("CKS=110 (/4096): 4095 cycles are NOT enough", 0, wtcnt(cpu));
	cpu._wdtRun(1);
	check("CKS=110 (/4096): cycle 4096 gives the exact tick", 1, wtcnt(cpu));
}
// The prescaler cannot lose the loose cycles between calls.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA520, 2);       // /2
	for(let i = 0; i < 7; i++) cpu._wdtRun(1);
	check("prescaler: 7 cycles one at a time -> WTCNT = 3", 3, wtcnt(cpu));
	cpu._wdtRun(1);
	check("prescaler: cycle 8 completes tick 4 (the remainder is not lost)", 4, wtcnt(cpu));
}
// In SLEEP the CPU stops but the peripherals do NOT. The WDT is on-chip:
// there is no exception for it, and the ITI is one of the things that can wake the CPU.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA520, 2);       // TME=1, /2
	cpu.sleeping = true;
	for(let i = 0; i < 20; i++) cpu.step();
	check("SLEEP: WTCNT keeps running", 10, wtcnt(cpu));
}
// WTCNT is initialized to H'00 by a reset and WHEN THE TME BIT IS CLEARED TO 0.
// Yabause does not do this: it only turns off its isenable flag.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA520, 2);       // TME=1
	for(let i = 0; i < 20; i++) cpu.step();
	check("precondition: WTCNT was running", 10, wtcnt(cpu));
	cpu.writeInternal(WDT_W, 0xA500, 2);       // TME=0
	check("clearing TME sets WTCNT to H'00", 0x00, wtcnt(cpu));
}

// --- INTERVAL TIMER mode (WT/IT=0): overflow -> OVF + ITI ---
{
	const cpu = cpuFrt();
	cpu.internalRegs[0xE3] = 0xB0;                // IPRA: WDTIP (bits 7-4) = 11
	cpu.internalRegs[0xE4] = 0x4A;                // VCRWDT: WITV (bits 14-8) = 0x4A
	cpu.writeInternal(WDT_W, 0xA520, 2);       // WT/IT=0 (interval), TME=1, /2
	cpu.writeInternal(WDT_W, 0x5AFF, 2);       // WTCNT <- 0xFF (one tick away from the overflow)
	check("precondition: no pending interrupts", 0, cpu.irqPending.length);
	cpu._wdtRun(2);                           // /2 -> one tick -> 0xFF + 1 = 0x00
	check("interval: WTCNT overflowed to H'00", 0x00, wtcnt(cpu));
	check("interval: overflow raises OVF (WTCSR bit 7)", 0x80, cpu.readInternal(WTCSR, 1) & 0x80);
	check("interval: overflow requests the ITI", 1, cpu.irqPending.length);
	check("interval: level = IPRA's WDTIP (bits 7-4)", 11, cpu.irqPending[0].level);
	check("interval: vector = VCRWDT's WITV (bits 14-8)", 0x4A, cpu.irqPending[0].vector);
}
// RSTCSR's WOVF is NOT raised in interval mode: it is not set in interval timer
// mode.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA520, 2);       // interval, TME=1
	cpu.writeInternal(WDT_W, 0x5AFF, 2);
	cpu._wdtRun(2);
	check("interval: RSTCSR's WOVF is NOT raised", 0, cpu.readInternal(RSTCSR, 1) & 0x80);
}
// On the hardware an interval timer interrupt (ITI) is generated EACH TIME
// the watchdog timer counter (WTCNT) overflows: overflow after
// overflow, without the software clearing anything.
//? Yabause STOPS the counter if OVF was left set (sh2core.c:2041): with that, a game
//? that does not clear the flag gets ONE SINGLE ITI in the whole session. The hardware does
//? no such thing: counting is gated ONLY by TME. We go with the hardware.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA520, 2);       // interval, TME=1, /2
	cpu.writeInternal(WDT_W, 0x5AFF, 2);
	cpu._wdtRun(2);                           // first overflow
	check("precondition: first overflow, OVF set and not cleared", 0x80, cpu.readInternal(WTCSR, 1) & 0x80);
	cpu.irqPending = [];
	cpu._wdtRun(2 * 256);                     // 256 ticks -> full wrap
	check("interval: it KEEPS counting with OVF set", 0x00, wtcnt(cpu));
	check("interval: and fires the ITI on EVERY overflow, not just once", 1, cpu.irqPending.length);
}
// OVF is R/(W): only 0 can be written to bit 7, to clear the flag.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA520, 2);
	cpu.writeInternal(WDT_W, 0x5AFF, 2);
	cpu._wdtRun(2);                           // OVF <- 1
	cpu.writeInternal(WDT_W, 0xA5A0, 2);       // writing 1 to bit 7: it neither raises nor clears it
	check("OVF: writing 1 leaves it as it was", 0x80, cpu.readInternal(WTCSR, 1) & 0x80);
	cpu.writeInternal(WDT_W, 0xA520, 2);       // writing 0 to bit 7: clears it
	check("OVF: writing 0 clears it", 0x00, cpu.readInternal(WTCSR, 1) & 0x80);
}
// The case that really separates the hardware from Yabause (its "WTCSR = (u8)val | 0x18" lets
// a write of 1 RAISE the flag out of nowhere and fire a phantom ITI).
// The test above did not catch it because OVF was already at 1: we have to start from 0.
{
	const cpu = cpuFrt();
	check("precondition: OVF starts at 0", 0x00, cpu.readInternal(WTCSR, 1) & 0x80);
	cpu.writeInternal(WDT_W, 0xA5A0, 2);       // writing 1 to bit 7 with OVF at 0
	check("OVF: writing 1 does NOT raise it out of nowhere", 0x00, cpu.readInternal(WTCSR, 1) & 0x80);
}

// --- WATCHDOG mode (WT/IT=1): overflow -> WOVF and, with RSTE, internal reset ---
// Yabause does not even try: "not implemented".
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA560, 2);       // WT/IT=1 (watchdog), TME=1, /2
	cpu.writeInternal(WDT_W, 0x5AFF, 2);
	cpu._wdtRun(2);
	check("watchdog: overflow raises WOVF (RSTCSR bit 7)", 0x80, cpu.readInternal(RSTCSR, 1) & 0x80);
	check("watchdog: does NOT raise WTCSR's OVF", 0, cpu.readInternal(WTCSR, 1) & 0x80);
	check("watchdog: does NOT request any interrupt (there is no ITI in this mode)", 0, cpu.irqPending.length);
}
// RSTE=0 (initial value): not reset when WTCNT overflows; the LSI is not reset internally,
// but WTCNT and WTCSR are reset within the WDT.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA565, 2);       // watchdog, TME=1, CKS=101
	cpu.writeInternal(WDT_W, 0x5AFF, 2);
	cpu.pc = 0x1234;
	cpu._wdtRun(1024);
	check("watchdog RSTE=0: does NOT reset the chip (the PC does not move)", 0x1234, cpu.pc);
	check("watchdog RSTE=0: the WDT does reset itself (WTCNT)", 0x00, wtcnt(cpu));
	check("watchdog RSTE=0: ...and WTCSR goes back to H'18", 0x18, cpu.readInternal(WTCSR, 1));
}
// RSTCSR: two different write protocols.
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_RC, 0x5A60, 2);      // RSTE=1, RSTS=1
	check("RSTCSR: 5Axx writes RSTE and RSTS", 0x60, cpu.readInternal(RSTCSR, 1) & 0x60);
	check("RSTCSR: the reserved bits 4-0 read 1", 0x1F, cpu.readInternal(RSTCSR, 1) & 0x1F);
}
{
	const cpu = cpuFrt();
	cpu.writeInternal(WDT_W, 0xA560, 2);       // watchdog, TME=1
	cpu.writeInternal(WDT_W, 0x5AFF, 2);
	cpu._wdtRun(2);                           // WOVF <- 1
	check("precondition: WOVF set", 0x80, cpu.readInternal(RSTCSR, 1) & 0x80);
	cpu.writeInternal(WDT_RC, 0x5A60, 2);      // writing RSTE/RSTS does NOT touch WOVF
	check("RSTCSR: 5Axx does not touch WOVF", 0x80, cpu.readInternal(RSTCSR, 1) & 0x80);
	cpu.writeInternal(WDT_RC, 0xA500, 2);      // A500H clears WOVF
	check("RSTCSR: A500H clears WOVF", 0x00, cpu.readInternal(RSTCSR, 1) & 0x80);
	check("RSTCSR: ...and does NOT touch RSTE/RSTS", 0x60, cpu.readInternal(RSTCSR, 1) & 0x60);
}
// RSTE=1: a signal to reset the chip is generated internally simultaneously with
// the WDTOVF signal when WTCNT overflows.
{
	const bus = new FlatBus();
	bus.writeLong(0x00000000, 0x00001000);    // reset vector: PC
	bus.writeLong(0x00000004, 0x06040000);    // reset vector: SP
	const cpu = new SH2(bus, "test");
	cpu.writeInternal(WDT_RC, 0x5A40, 2);      // RSTE=1, RSTS=0 (power-on reset)
	cpu.writeInternal(WDT_W, 0xA560, 2);       // watchdog, TME=1, /2
	cpu.writeInternal(WDT_W, 0x5AFF, 2);
	cpu.pc = 0x9999; cpu.r[5] = 0x1234;
	cpu._wdtRun(2);
	check("watchdog RSTE=1: resets the chip (PC from the vector)", 0x1000, cpu.pc >>> 0);
	check("watchdog RSTE=1: the reset clears the registers", 0, cpu.r[5] | 0);
	// RSTCSR is initialized to H'1F by input of a reset signal from the RES pin, but is
	// NOT initialized by the internal reset signal generated by overflow of the WDT:
	// that way the software knows it was woken by the watchdog and not by the reset button.
	check("watchdog RSTE=1: WOVF SURVIVES the reset", 0x80, cpu.readInternal(RSTCSR, 1) & 0x80);
}

// ============================================================================
//   Cache as RAM: the data array (0xC0000000, 4 KB mirrored) belongs to the CPU
// ============================================================================
// Partition 110 exposes the 4 KB of the cache as readable and
// writable RAM (an SDK technique). The historical bug: it fell to the bus masked to 27 bits
// (Boot ROM page) — writes swallowed and reads returning BIOS, silently.
{
	const bus = new FlatBus();
	const cpu = new SH2(bus, "test");
	cpu.writeLong(0xC0000000, 0x11223344);
	check("data array: reads what was written (long)", 0x11223344, cpu.readLong(0xC0000000) | 0);
	check("data array: does NOT touch the bus (the bus RAM stays at 0)", 0, bus.ram[0]);
	cpu.writeByte(0xC0000FFF, 0xAB);
	check("data array: byte at the edge of the 4 KB", 0xAB, cpu.readByte(0xC0000FFF));
	// The 4 KB are MIRRORED across the whole partition 0xC0000000-0xDFFFFFFF.
	check("data array: mirrored (0xC0001000 = 0xC0000000)", 0x11223344, cpu.readLong(0xC0001000) | 0);
	check("data array: mirrored far away (0xD0000000)", 0x11223344, cpu.readLong(0xD0000000) | 0);
	cpu.writeWord(0xC0000010, 0xBEEF);
	check("data array: word", 0xBEEF, cpu.readWord(0xC0000010));
	// Each CPU has ITS OWN cache: what is written in one does not show up in the other.
	const other = new SH2(bus, "test2");
	check("data array: it is PER CPU (the other SH-2 reads 0)", 0, other.readLong(0xC0000000) | 0);
}

// ---------------------------------------------------------------------------
// MAC SATURATION (SR's S bit). The flagS was
// declared with no consumer at all: these tests pin down the behavior of both
// instructions in both modes.
// ---------------------------------------------------------------------------
{
	// Helper: bare CPU with flat memory, to call macWord/macLong directly.
	const macCpu = (S) => {
		const cpu = new SH2(new FlatBus(), "mac");
		cpu.pc = 0x1000; cpu.sr = S ? 0x000000F2 : 0x000000F0;   // bit 1 = S
		return cpu;
	};
	const putWord = (cpu, addr, v) => cpu.writeWord(addr, v & 0xFFFF);
	const putLong = (cpu, addr, v) => cpu.writeLong(addr, v >>> 0);

	// --- MAC.W ---
	// S=0: true 64-bit accumulation (MACH comes along). 0xFFFFFFFF + 0x3FFF0001
	// goes past 32 bits, so the carry has to go up into MACH.
	{
		const cpu = macCpu(0);
		cpu.r[1] = 0x2000; cpu.r[2] = 0x2100;
		putWord(cpu, 0x2000, 0x7FFF); putWord(cpu, 0x2100, 0x7FFF);   // 32767^2 = 0x3FFF0001
		cpu.macl = 0xFFFFFFFF | 0; cpu.mach = 0;
		cpu.macWord(1, 2);
		check("MAC.W S=0: the carry goes up into MACH", 1, cpu.mach | 0);
		check("MAC.W S=0: MACL wraps around", 0x3FFF0000, cpu.macl >>> 0);
	}
	// S=1: positive clamp to 0x7FFFFFFF and MACH is NOT touched (that is SH-1, not SH-2).
	{
		const cpu = macCpu(1);
		cpu.r[1] = 0x2000; cpu.r[2] = 0x2100;
		putWord(cpu, 0x2000, 0x7FFF); putWord(cpu, 0x2100, 0x7FFF);
		cpu.macl = 0x7FFFFFFF | 0; cpu.mach = 0x1234;
		cpu.macWord(1, 2);
		check("MAC.W S=1: positive clamp", 0x7FFFFFFF, cpu.macl >>> 0);
		check("MAC.W S=1: MACH is NOT touched (SH-2)", 0x1234, cpu.mach | 0);
	}
	// S=1: negative clamp to 0x80000000.
	{
		const cpu = macCpu(1);
		cpu.r[1] = 0x2000; cpu.r[2] = 0x2100;
		putWord(cpu, 0x2000, 0x8000); putWord(cpu, 0x2100, 0x7FFF);   // -32768 * 32767 < 0
		cpu.macl = 0x80000000 | 0; cpu.mach = 0x55;
		cpu.macWord(1, 2);
		check("MAC.W S=1: negative clamp", 0x80000000, cpu.macl >>> 0);
		check("MAC.W S=1 (neg): MACH is NOT touched", 0x55, cpu.mach | 0);
	}
	// S=1 without overflow: normal addition, no clamp.
	{
		const cpu = macCpu(1);
		cpu.r[1] = 0x2000; cpu.r[2] = 0x2100;
		putWord(cpu, 0x2000, 3); putWord(cpu, 0x2100, 5);
		cpu.macl = 100; cpu.mach = 0;
		cpu.macWord(1, 2);
		check("MAC.W S=1 without overflow: normal addition", 115, cpu.macl | 0);
	}

	// --- MAC.L ---
	// CAREFUL with the starting state: in saturation mode the accumulator is 48 bits and the
	// HIGH 16 of MACH have to be the sign extension of bit 47 (0x0000 or 0xFFFF).
	// The instruction's algorithm adds the WHOLE MACH to get Res2, so starting with
	// garbage on top flips Res2's sign and saturates toward the wrong side. The
	// tests use valid states, which is the only thing saturation mode defines.
	// S=1: positive clamp -> MACL=0xFFFFFFFF and the LOW 16 of MACH = 0x7FFF.
	{
		const cpu = macCpu(1);
		cpu.r[1] = 0x2000; cpu.r[2] = 0x2100;
		putLong(cpu, 0x2000, 0x100); putLong(cpu, 0x2100, 0x100);   // +0x10000
		cpu.macl = 0xFFFFFFF0 | 0; cpu.mach = 0x00007FFF;               // right at the positive top
		cpu.macLong(1, 2);
		check("MAC.L S=1: positive clamp on MACL", 0xFFFFFFFF, cpu.macl >>> 0);
		check("MAC.L S=1: low 16 of MACH = 0x7FFF", 0x7FFF, cpu.mach & 0xFFFF);
	}
	// S=1: negative clamp -> MACL=0 and the low 16 of MACH = 0x8000, with the high 16
	// preserved (0xFFFF, the sign extension): that is what the current definition of the instruction does.
	{
		const cpu = macCpu(1);
		cpu.r[1] = 0x2000; cpu.r[2] = 0x2100;
		putLong(cpu, 0x2000, 0x100); putLong(cpu, 0x2100, 0xFFFFFF00);   // 0x100 * -0x100
		cpu.macl = 0x0000000F; cpu.mach = 0xFFFF8000 | 0;                    // right at the floor
		cpu.macLong(1, 2);
		check("MAC.L S=1: negative clamp on MACL", 0x00000000, cpu.macl >>> 0);
		check("MAC.L S=1: low 16 of MACH = 0x8000", 0x8000, cpu.mach & 0xFFFF);
		check("MAC.L S=1 (neg): the HIGH 16 of MACH are preserved", 0xFFFF, (cpu.mach >>> 16) & 0xFFFF);
	}
	// S=0: no clamp, the full 64 bits (MACH is written whole).
	{
		const cpu = macCpu(0);
		cpu.r[1] = 0x2000; cpu.r[2] = 0x2100;
		putLong(cpu, 0x2000, 0x40000000); putLong(cpu, 0x2100, 0x40000000);
		cpu.macl = 0; cpu.mach = 0;
		cpu.macLong(1, 2);   // 0x40000000^2 = 0x1000000000000000
		check("MAC.L S=0: full MACH, no clamp", 0x10000000, cpu.mach >>> 0);
		check("MAC.L S=0: MACL", 0x00000000, cpu.macl >>> 0);
	}
	// S=1 without overflow: no clamping.
	{
		const cpu = macCpu(1);
		cpu.r[1] = 0x2000; cpu.r[2] = 0x2100;
		putLong(cpu, 0x2000, 7); putLong(cpu, 0x2100, 6);
		cpu.macl = 10; cpu.mach = 0;
		cpu.macLong(1, 2);
		check("MAC.L S=1 without overflow: normal addition", 52, cpu.macl | 0);
		check("MAC.L S=1 without overflow: MACH at 0", 0, cpu.mach | 0);
	}
}

// ================================================================================
//   SCI: the transmitter, with its character time
// ================================================================================
// The SCI did not have A SINGLE test and it turned out 7 of the 10 test games use it
// (diag/sci-usage.mjs). These pin down what the hardware does and the raw bank cannot
// represent: that TDRE is raised again by the HARDWARE when moving TDR to TSR, and that this
// transfer cannot happen before the previous character goes out.
{
	const bus = new FlatBus();
	const cpu = new globalThis.SH2(bus);
	cpu.reset();
	const SMR = 0xFFFFFE00, BRR = 0xFFFFFE01, SCR = 0xFFFFFE02, TDR = 0xFFFFFE03, SSR = 0xFFFFFE04;
	const ssr = () => cpu.readByte(SSR) & 0xFF;

	// Reset value: TDRE=1 and TEND=1 (H'84).
	check("SCI: SSR at reset is 0x84 (TDRE=1, TEND=1)", 0x84, ssr());

	// The 7 games configure exactly this: synchronous mode with clock (SMR bit 7),
	// CKS=0 and BRR=0x10. With the bit-rate formula that is 16 x 4^0 x (0x10+1) = 272 cycles per
	// bit and 8 bits per character -no start or stop in synchronous- = 2176 cycles.
	cpu.writeByte(SMR, 0x80);
	cpu.writeByte(BRR, 0x10);
	check("SCI: the character takes 2176 cycles with SMR=0x80 BRR=0x10", 2176, cpu.sci.cyclesChar);

	// The same case in ASYNCHRONOUS, which adds start and stop: 128 x 17 x 10 bits.
	cpu.writeByte(SMR, 0x00);
	check("SCI: in asynchronous the character is 10 bits and not 8", 128 * 17 * 10, cpu.sci.cyclesChar);
	cpu.writeByte(SMR, 0x80);

	// ★ WITH TE=0, TDRE IS STUCK AT 1 AND CANNOT BE CLEARED (TE bit of SCR:
	// Transmitter disabled. The transmit data register empty bit (TDRE) in the serial status
	// register (SSR) is locked at 1).
	//
	// ⚠ THIS TEST FOSSILIZED THE BUG. It required that clearing TDRE with the transmitter off left the
	// flag at 0 —"the flag stays as the game left it"—, which is what we did and not what
	// the hardware does. And the state it fossilized was not harmless: with TDRE at 0, TSR free and TE
	// turned on afterwards, there is NOBODY left to move the data from TDR to TSR, so TDRE never
	// goes back to 1. Measured on Daytona USA (diag/sci-trace.mjs, frame 1106): the game
	// does exactly that sequence and then polls the 32,767 passes of its timeout.
	cpu.writeByte(TDR, 0x55);
	cpu.writeByte(SSR, ssr() & ~0x80);
	check("SCI: with TE=0, TDRE is stuck at 1 and the write does not clear it", 0x80, ssr() & 0x80);
	// And the corollary, which is the bug's: turning TE on afterwards leaves nothing hanging, because no
	// "pending" data was left for anyone to move into TSR.
	cpu.writeByte(SCR, 0x20);                 // TE = 1
	check("SCI: and when TE is turned on the transmitter is not left with an orphan data byte", 0x80, ssr() & 0x80);
	check("SCI: with TE=0 no transmission started (TSR is still free)", 0, cpu.sci.tsrUntil);
	cpu.writeByte(SCR, 0x00);                 // left as it was for what follows

	// With TE, the transfer to TSR is immediate if the transmitter is free -> TDRE goes back to 1.
	cpu.reset();
	cpu.writeByte(SMR, 0x80); cpu.writeByte(BRR, 0x10);
	cpu.writeByte(SCR, 0x20);                 // TE = 1
	cpu.cycles = 1000;
	cpu.writeByte(TDR, 0x55);
	cpu.writeByte(SSR, ssr() & ~0x80);        // the software clears TDRE
	check("SCI: with TE and TSR free, TDRE goes back to 1 immediately", 0x80, ssr() & 0x80);
	check("SCI: and TEND drops while the character goes out", 0, ssr() & 0x04);

	// THE POINT OF THE TEST: the SECOND character CANNOT be loaded until the first one goes out.
	cpu.writeByte(TDR, 0x66);
	cpu.writeByte(SSR, ssr() & ~0x80);        // clears TDRE again
	check("SCI: the 2nd character leaves TDRE at 0 (TSR is busy)", 0, ssr() & 0x80);
	cpu.cycles = 1000 + 2175;                    // one cycle BEFORE it ends
	check("SCI: one cycle before the end, TDRE is still at 0", 0, ssr() & 0x80);
	cpu.cycles = 1000 + 2176;                    // right when the character completes
	check("SCI: once the character completes, TSR takes the 2nd and TDRE goes back to 1", 0x80, ssr() & 0x80);

	// With nothing more to send, TEND is raised when the last character ends.
	cpu.cycles += 2176;
	check("SCI: with no new data, TEND is raised at the end", 0x04, ssr() & 0x04);

	// TEND and MPB are READ ONLY: writing 0 does not clear them.
	// 0xFB is written and not 0x00 on purpose: TDRE has to be left at 1, because clearing it is the
	// "TDR has data" signal and it would start a new transmission — which DOES clear TEND, and
	// rightly so. This test measures the bit's property, not the effect of the transmission.
	cpu.writeByte(SSR, 0xFB);
	check("SCI: TEND is read only, writing 0 does not clear it", 0x04, ssr() & 0x04);

	// Turning TE off leaves the transmitter empty: TDRE is set to 1 when the TE bit is cleared.
	cpu.writeByte(TDR, 0x77);
	cpu.writeByte(SSR, ssr() & ~0x80);
	cpu.writeByte(SCR, 0x00);                 // TE = 0
	check("SCI: turning TE off sets TDRE back to 1", 0x80, ssr() & 0x80);

	// And the reset has to take the transmitter state with it: cpu.reset() sets cycles to 0,
	// so an old tsrUntil would stay in the future forever.
	cpu.writeByte(SCR, 0x20);
	cpu.cycles = 500000;
	cpu.writeByte(TDR, 0x88);
	cpu.writeByte(SSR, ssr() & ~0x80);
	cpu.reset();
	check("SCI: the reset clears the transmitter (cycles go back to 0)", 0, cpu.sci.tsrUntil);
	check("SCI: and SSR goes back to its reset value", 0x84, ssr());
}

console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
