/**
 *    Name:         m68k.test.mjs
 *    Description:  Test battery for the 68000 core (EstyJs) through the M68K
 *                  adapter. It builds a stub bus with flat sound RAM, assembles a
 *                  small program per case and compares result + CCR (X,N,Z,V,C)
 *                  against the 68000's specified behavior. Covers shifts/rotations (the 8
 *                  families, the 3 sizes, immediate and register count),
 *                  DIVU/DIVS (including division by zero and overflow), MULU/MULS,
 *                  EXT, SWAP, NEG/NEGX/ADDX/SUBX and addressing modes.
 *                  Run with: node m68k.test.mjs
 *    Version:      0.3.0
 *    Created:      15-07-2026
 *    Modified:     16-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync } from "fs";
// Load the adapter (defines EstyJs, sprintf, M68K) and then the EstyJs core.
eval(readFileSync("m68k.js","utf8") + "\nglobalThis.M68K=M68K;globalThis.EstyJs=EstyJs;globalThis.sprintf=sprintf;");
eval(readFileSync("vendor/estyjs-processor.js","utf8"));

// Stub bus: the whole program lives in sound RAM (< 0x80000), so the
// SCSP hooks are not used (no-op / 0).
const bus = {
	soundRam: new Uint8Array(0x80000),
	scspRead:     ()=> 0,
	scspWrite: ()=>{},
	scspLevel68k: ()=> 0
};
const ram = bus.soundRam;
const w16 = (a, v)=>{ ram[a] = (v >> 8) & 0xFF; ram[a+1] = v & 0xFF; };
const w32 = (a, v)=>{ ram[a] = (v >>> 24) & 0xFF; ram[a+1] = (v >>> 16) & 0xFF; ram[a+2] = (v >>> 8) & 0xFF; ram[a+3] = v & 0xFF; };
const r32 = (a)=> (((ram[a] << 24) | (ram[a+1] << 16) | (ram[a+2] << 8) | ram[a+3]) >>> 0);

const m68k = new M68K(bus);
const regs = m68k.cpu.getRegs();

// ---------- minimal assembler ----------
const PROG = 0x400, TRAP = 0x600;
const BRA_HERE = 0x60FE;              // BRA.S * -> infinite loop, does not touch the CCR

// Shift/rotation, immediate form: 1110 ccc dr ss 0 tt rrr (ccc=0 => 8)
const SH_AS = 0, SH_LS = 1, SH_ROX = 2, SH_RO = 3;
const shImm = (count, left, size, type, reg)=>
	0xE000 | ((count & 7) << 9) | (left << 8) | (size << 6) | (type << 3) | reg;
// Register form: the ccc field is the count register and bit 5 is set to 1.
const shReg = (regCount, left, size, type, reg)=>
	0xE000 | (regCount << 9) | (left << 8) | (size << 6) | (1 << 5) | (type << 3) | reg;

const SIZE_B = 0, SIZE_W = 1, SIZE_L = 2;

// Runs a case: loads D0-D7, sets the CCR, executes `ops` and returns the state.
function execute(testCase)
{
	ram.fill(0);
	w32(0x00, 0x00010000);            // initial SP
	w32(0x04, PROG);                  // initial PC
	w32(0x14, TRAP);                // vector 5 = division by zero
	w16(TRAP, BRA_HERE);

	let p = PROG;
	// MOVE.L #imm,Dn for each requested register
	for(const k of Object.keys(testCase.d || {}))
	{
		const n = +k;
		w16(p, 0x203C | (n << 9)); p += 2;
		w32(p, testCase.d[k] >>> 0);   p += 4;
	}
	// MOVE.L #imm,An
	for(const k of Object.keys(testCase.a || {}))
	{
		const n = +k;
		w16(p, 0x207C | (n << 9)); p += 2;   // MOVEA.L #imm,An
		w32(p, testCase.a[k] >>> 0);   p += 4;
	}
	// MOVE #imm,CCR (sets X,N,Z,V,C before the instruction under test)
	w16(p, 0x44FC); p += 2;
	w16(p, testCase.ccr || 0); p += 2;
	// instruction(s) under test
	for(const w of testCase.ops){ w16(p, w); p += 2; }
	w16(p, BRA_HERE);

	// memory set up beforehand (for addressing modes)
	for(const [addr, val] of Object.entries(testCase.mem || {})) w32(+addr, val >>> 0);

	m68k.reset();
	for(let i = 0; i < 12; i++) m68k.run(64);

	return {
		d: Array.from(regs.d, x=> x >>> 0),
		a: Array.from(regs.a, x=> x >>> 0),
		pc: regs.pc >>> 0,
		X: regs.x ? 1 : 0, N: regs.n ? 1 : 0, Z: regs.z ? 1 : 0, V: regs.v ? 1 : 0, C: regs.c ? 1 : 0
	};
}

// ---------- cases ----------
// The expected CCRs are computed by hand from the 68000's instruction definitions.
const cases = [];
const t = (name, testCase, wait)=> cases.push({ name, testCase, wait });

// --- LSR/LSL immediate. A count of 0 in the field encodes 8 (not 0). ---
// It is exactly the LSR.W #8,D6 ($E04E) the BIOS sound driver uses
// to split an 8.8 pitch into its integer part: if count 0 were taken as 0,
// the 68k would read an absurd note.
t("LSR.W #8,D6 (count 0 = 8)", { d:{6:0x0000DC00}, ops:[shImm(0,0,SIZE_W,SH_LS,6)] },
	{ d:{6:0x000000DC}, X:0,N:0,Z:0,V:0,C:0 });
t("LSR.W #8,D6 with C=1 shifted out", { d:{6:0x0000DC80}, ops:[shImm(0,0,SIZE_W,SH_LS,6)] },
	{ d:{6:0x000000DC}, X:1,N:0,Z:0,V:0,C:1 });
t("LSL.W #8,D0 (count 0 = 8)", { d:{0:0x000000FF}, ops:[shImm(0,1,SIZE_W,SH_LS,0)] },
	{ d:{0:0x0000FF00}, X:0,N:1,Z:0,V:0,C:0 });
t("LSL.W #7,D6", { d:{6:0x00000044}, ops:[shImm(7,1,SIZE_W,SH_LS,6)] },
	{ d:{6:0x00002200}, X:0,N:0,Z:0,V:0,C:0 });
t("LSR.L #1,D0 keeps the high bits", { d:{0:0x80000001}, ops:[shImm(1,0,SIZE_L,SH_LS,0)] },
	{ d:{0:0x40000000}, X:1,N:0,Z:0,V:0,C:1 });
t("LSR.B #4,D0 leaves the rest alone", { d:{0:0x1234FF00 | 0xF0}, ops:[shImm(4,0,SIZE_B,SH_LS,0)] },
	{ d:{0:0x1234FF0F}, X:0,N:0,Z:0,V:0,C:0 });

// --- ASL: V is set if the sign bit changes at ANY step ---
t("ASL.W #1,D0 V=1 (0x4000->0x8000)", { d:{0:0x00004000}, ops:[shImm(1,1,SIZE_W,SH_AS,0)] },
	{ d:{0:0x00008000}, X:0,N:1,Z:0,V:1,C:0 });
t("ASL.W #1,D0 V=0 (0xC000->0x8000)", { d:{0:0x0000C000}, ops:[shImm(1,1,SIZE_W,SH_AS,0)] },
	{ d:{0:0x00008000}, X:1,N:1,Z:0,V:0,C:1 });
t("ASL.W #2,D0 V=1 halfway through", { d:{0:0x00002000}, ops:[shImm(2,1,SIZE_W,SH_AS,0)] },
	{ d:{0:0x00008000}, X:0,N:1,Z:0,V:1,C:0 });
t("ASL.W #1,D0 Z=1", { d:{0:0x00008000}, ops:[shImm(1,1,SIZE_W,SH_AS,0)] },
	{ d:{0:0x00000000}, X:1,N:0,Z:1,V:1,C:1 });

// --- ASR: replicates the sign, V always 0 ---
t("ASR.W #1,D0 replicates the sign", { d:{0:0x00008001}, ops:[shImm(1,0,SIZE_W,SH_AS,0)] },
	{ d:{0:0x0000C000}, X:1,N:1,Z:0,V:0,C:1 });
t("ASR.L #4,D0 negative", { d:{0:0xFFFFFF00}, ops:[shImm(4,0,SIZE_L,SH_AS,0)] },
	{ d:{0:0xFFFFFFF0}, X:0,N:1,Z:0,V:0,C:0 });
t("ASR.B #8,D0 (count 0 = 8)", { d:{0:0x00000080}, ops:[shImm(0,0,SIZE_B,SH_AS,0)] },
	{ d:{0:0x000000FF}, X:1,N:1,Z:0,V:0,C:1 });

// --- ROL/ROR: do not touch X, V=0 ---
t("ROL.W #1,D0", { d:{0:0x00008001}, ccr:0x10, ops:[shImm(1,1,SIZE_W,SH_RO,0)] },
	{ d:{0:0x00000003}, X:1,N:0,Z:0,V:0,C:1 });   // X stays as it was (1)
t("ROR.W #1,D0", { d:{0:0x00000001}, ops:[shImm(1,0,SIZE_W,SH_RO,0)] },
	{ d:{0:0x00008000}, X:0,N:1,Z:0,V:0,C:1 });
t("ROR.B #8,D0 (count 0 = 8, comes back the same)", { d:{0:0x000000A5}, ops:[shImm(0,0,SIZE_B,SH_RO,0)] },
	{ d:{0:0x000000A5}, X:0,N:1,Z:0,V:0,C:1 });

// --- ROXL/ROXR: rotate through X; C=X=last bit shifted out ---
t("ROXL.W #1,D0 with X=1", { d:{0:0x00000000}, ccr:0x10, ops:[shImm(1,1,SIZE_W,SH_ROX,0)] },
	{ d:{0:0x00000001}, X:0,N:0,Z:0,V:0,C:0 });
t("ROXR.W #1,D0 with X=1", { d:{0:0x00000000}, ccr:0x10, ops:[shImm(1,0,SIZE_W,SH_ROX,0)] },
	{ d:{0:0x00008000}, X:0,N:1,Z:0,V:0,C:0 });
t("ROXL.W #1,D0 shifts 1 out to X/C", { d:{0:0x00008000}, ops:[shImm(1,1,SIZE_W,SH_ROX,0)] },
	{ d:{0:0x00000000}, X:1,N:0,Z:1,V:0,C:1 });

// --- register form: count 0 does not shift and clears C; count mod 64 ---
t("LSL.W D1,D0 with count 0 -> C=0, X untouched", { d:{0:0x00001234, 1:0}, ccr:0x10, ops:[shReg(1,1,SIZE_W,SH_LS,0)] },
	{ d:{0:0x00001234}, X:1,N:0,Z:0,V:0,C:0 });
t("ROXL.W D1,D0 with count 0 -> C=X", { d:{0:0x00001234, 1:0}, ccr:0x10, ops:[shReg(1,1,SIZE_W,SH_ROX,0)] },
	{ d:{0:0x00001234}, X:1,N:0,Z:0,V:0,C:1 });
t("LSR.L D1,D0 with count 32", { d:{0:0xFFFFFFFF, 1:32}, ops:[shReg(1,0,SIZE_L,SH_LS,0)] },
	{ d:{0:0x00000000}, X:1,N:0,Z:1,V:0,C:1 });
t("LSL.W D1,D0 count 64 = 0 (mod 64)", { d:{0:0x00001234, 1:64}, ops:[shReg(1,1,SIZE_W,SH_LS,0)] },
	{ d:{0:0x00001234}, X:0,N:0,Z:0,V:0,C:0 });

// --- MULU/MULS (16x16 -> 32) ---
t("MULU.W #$FFFF,D0", { d:{0:0x0000FFFF}, ops:[0xC0FC, 0xFFFF] },
	{ d:{0:0xFFFE0001}, X:0,N:1,Z:0,V:0,C:0 });
t("MULS.W #-1,D0 with D0=-1", { d:{0:0x0000FFFF}, ops:[0xC1FC, 0xFFFF] },
	{ d:{0:0x00000001}, X:0,N:0,Z:0,V:0,C:0 });
t("MULS.W #-2,D0 with D0=3", { d:{0:0x00000003}, ops:[0xC1FC, 0xFFFE] },
	{ d:{0:0xFFFFFFFA}, X:0,N:1,Z:0,V:0,C:0 });
t("MULU.W #0,D0 -> Z=1", { d:{0:0x00001234}, ops:[0xC0FC, 0x0000] },
	{ d:{0:0x00000000}, X:0,N:0,Z:1,V:0,C:0 });

// --- DIVU/DIVS ---
t("DIVU.W #7,D0 with D0=100", { d:{0:100}, ops:[0x80FC, 0x0007] },
	{ d:{0:0x0002000E}, X:0,N:0,Z:0,V:0,C:0 });   // remainder 2 : quotient 14
t("DIVU.W overflow leaves D0 untouched", { d:{0:0x00100000}, ops:[0x80FC, 0x0001] },
	{ d:{0:0x00100000}, V:1,C:0 });
t("DIVS.W #-7,D0 with D0=100", { d:{0:100}, ops:[0x81FC, 0xFFF9] },
	{ d:{0:0x0002FFF2}, X:0,N:1,Z:0,V:0,C:0 });   // remainder 2 (sign of the dividend), quotient -14
t("DIVS.W #7,D0 with D0=-100", { d:{0:0xFFFFFF9C}, ops:[0x81FC, 0x0007] },
	{ d:{0:0xFFFEFFF2}, X:0,N:1,Z:0,V:0,C:0 });   // remainder -2, quotient -14

// --- EXT / SWAP ---
t("EXT.W D0 (negative byte)", { d:{0:0x00000080}, ops:[0x4880] },
	{ d:{0:0x0000FF80}, X:0,N:1,Z:0,V:0,C:0 });
t("EXT.L D0 (negative word)", { d:{0:0x00008000}, ops:[0x48C0] },
	{ d:{0:0xFFFF8000}, X:0,N:1,Z:0,V:0,C:0 });
t("EXT.W D0 (positive byte)", { d:{0:0x0000007F}, ops:[0x4880] },
	{ d:{0:0x0000007F}, X:0,N:0,Z:0,V:0,C:0 });
t("SWAP D0", { d:{0:0x12345678}, ops:[0x4840] },
	{ d:{0:0x56781234}, X:0,N:0,Z:0,V:0,C:0 });
t("SWAP D0 sets N", { d:{0:0x00008000}, ops:[0x4840] },
	{ d:{0:0x80000000}, X:0,N:1,Z:0,V:0,C:0 });

// --- NEG / NEGX / ADDX / SUBX ---
t("NEG.W D0", { d:{0:0x00000001}, ops:[0x4440] },
	{ d:{0:0x0000FFFF}, X:1,N:1,Z:0,V:0,C:1 });
t("NEG.W D0 with 0 -> Z=1,C=0", { d:{0:0x00000000}, ops:[0x4440] },
	{ d:{0:0x00000000}, X:0,N:0,Z:1,V:0,C:0 });
t("NEGX.W D0 with X=1", { d:{0:0x00000001}, ccr:0x10, ops:[0x4040] },
	{ d:{0:0x0000FFFE}, X:1,N:1,Z:0,V:0,C:1 });
t("ADDX.W D1,D0 with X=1", { d:{0:0x00000001, 1:0x00000001}, ccr:0x10, ops:[0xD141] },
	{ d:{0:0x00000003}, X:0,N:0,Z:0,V:0,C:0 });
t("SUBX.W D1,D0 with X=1", { d:{0:0x00000005, 1:0x00000001}, ccr:0x10, ops:[0x9141] },
	{ d:{0:0x00000003}, X:0,N:0,Z:0,V:0,C:0 });

// --- addressing modes ---
t("MOVE.L (A0),D0", { a:{0:0x1000}, mem:{0x1000:0xDEADBEEF}, ops:[0x2010] },
	{ d:{0:0xDEADBEEF}, N:1,Z:0,V:0,C:0 });
t("MOVE.L (A0)+,D0 increments A0", { a:{0:0x1000}, mem:{0x1000:0x11223344}, ops:[0x2018] },
	{ d:{0:0x11223344}, a:{0:0x1004}, N:0,Z:0,V:0,C:0 });
t("MOVE.L -(A0),D0 decrements A0", { a:{0:0x1004}, mem:{0x1000:0x11223344}, ops:[0x2020] },
	{ d:{0:0x11223344}, a:{0:0x1000}, N:0,Z:0,V:0,C:0 });
t("MOVE.L (d16,A0),D0", { a:{0:0x1000}, mem:{0x1010:0xCAFEBABE}, ops:[0x2028, 0x0010] },
	{ d:{0:0xCAFEBABE}, N:1,Z:0,V:0,C:0 });
// (d8,An,Xn.W) -- the mode the sound driver uses to hit the SCSP slot
t("MOVE.L (d8,A0,D1.W),D0", { a:{0:0x1000}, d:{1:0x0020}, mem:{0x1030:0x0BADF00D}, ops:[0x2030, 0x1010] },
	{ d:{0:0x0BADF00D}, N:0,Z:0,V:0,C:0 });
// negative index: the 68000 sign-extends the word
t("MOVE.L (d8,A0,D1.W) with a negative index", { a:{0:0x1000}, d:{1:0x0000FFF0}, mem:{0x0FF0:0x5A5A5A5A}, ops:[0x2030, 0x1000] },
	{ d:{0:0x5A5A5A5A}, N:0,Z:0,V:0,C:0 });

// ---------- run ----------
let ok = 0, failures = [];
for(const { name, testCase, wait } of cases)
{
	const r = execute(testCase);
	const errors = [];
	for(const k of Object.keys(wait.d || {}))
		if(r.d[+k] !== (wait.d[k] >>> 0))
			errors.push("D" + k + " = 0x" + r.d[+k].toString(16) + " (expected 0x" + (wait.d[k] >>> 0).toString(16) + ")");
	for(const k of Object.keys(wait.a || {}))
		if(r.a[+k] !== (wait.a[k] >>> 0))
			errors.push("A" + k + " = 0x" + r.a[+k].toString(16) + " (expected 0x" + (wait.a[k] >>> 0).toString(16) + ")");
	for(const f of ["X","N","Z","V","C"])
		if(wait[f] !== undefined && r[f] !== wait[f])
			errors.push(f + " = " + r[f] + " (expected " + wait[f] + ")");

	if(errors.length){ failures.push({ name, errors }); }
	else ok++;
}

// Division by zero is separate: it does not compare registers, it checks that the 68k takes
// vector 5 and ends up executing the trap.
{
	const r = execute({ d:{0:100}, ops:[0x80FC, 0x0000] });
	// after the trap the PC stays in the trap (BRA.S * at TRAP)
	if(r.pc >= TRAP && r.pc <= TRAP + 4) ok++;
	else failures.push({ name:"DIVU.W #0 takes vector 5 (division by zero)", errors:["PC = 0x" + r.pc.toString(16) + " (expected ~0x" + TRAP.toString(16) + ")"] });
}

// ---------- SCSP interrupt: LEVEL-SENSITIVE, not latched ----------
// Regression of the sound 68k's Address Error (a GENERAL driver-reload bug):
// an SCSP IRQ request that arrives with the 68k's IRQs MASKED must not stay
// latched and fire late once the level has already dropped. On hardware the 68000's
// IPL0-2 is level-sensitive; if the core latches, on unmasking it jumps through a vector that
// the new driver has already overwritten with something else (odd address) -> Exception 3.
const HANDLER_IRQ = 0x800;
function runWithLevel(fnLevel)
{
	ram.fill(0);
	w32(0x00, 0x00010000);            // initial SP
	w32(0x04, PROG);                  // initial PC
	w32(0x68, HANDLER_IRQ);           // level 2 autovector (vector 26 @ 0x68)
	// IRQ handler: marks D7 and spins. If it runs, it shows in D7.
	w16(HANDLER_IRQ,     0x2E3C); w16(HANDLER_IRQ + 2, 0x0000); w16(HANDLER_IRQ + 4, 0xDEAD);  // MOVE.L #$DEAD,D7
	w16(HANDLER_IRQ + 6, 0x60FE);     // BRA.S *
	// Program: masks, spins masked, unmasks, spins, marks D6 and spins.
	const prog = [
		0x46FC, 0x2700,                              // MOVE #$2700,SR  (masks everything)
		0x4E71, 0x4E71, 0x4E71, 0x4E71,              // NOP x4 (with IRQs masked)
		0x46FC, 0x2000,                              // MOVE #$2000,SR  (unmasks)
		0x4E71, 0x4E71, 0x4E71, 0x4E71,              // NOP x4 (the latched one would fire here)
		0x2C3C, 0x0000, 0xC0DE,                      // MOVE.L #$C0DE,D6  (reached the end cleanly)
		0x60FE                                       // BRA.S *  (spin)
	];
	let p = PROG;
	for(const w of prog){ w16(p, w); p += 2; }
	const before = bus.scspLevel68k;
	bus.scspLevel68k = fnLevel;
	try{ m68k.reset(); for(let i = 0; i < 20; i++) m68k.run(64); }
	finally{ bus.scspLevel68k = before; }
	return { d: Array.from(regs.d, x => x >>> 0), pc: regs.pc >>> 0 };
}

// (A) REGRESSION: the SCSP requests level 2 ONLY while the 68k is masked (intmask=7)
// and drops it to 0 on unmasking. The old level must NOT fire: the handler does not run.
{
	const r = runWithLevel(() => (regs.intmask === 7 ? 2 : 0));
	if(r.d[7] !== 0x0000DEAD && r.d[6] === 0x0000C0DE) ok++;
	else failures.push({ name:"SCSP IRQ masked and then dropped does NOT fire late (level-sensitive)",
		errors:["D7 = 0x" + r.d[7].toString(16) + " (expected != 0xdead: the handler should not run), D6 = 0x" + r.d[6].toString(16) + " (expected 0xc0de)"] });
}

// (B) SANITY: if the SCSP keeps the level 2 request, on unmasking it IS serviced
// (so the fix does not break normal interrupts). The handler runs -> D7 = 0xDEAD.
{
	const r = runWithLevel(() => 2);
	if(r.d[7] === 0x0000DEAD) ok++;
	else failures.push({ name:"SCSP IRQ present on unmasking IS serviced",
		errors:["D7 = 0x" + r.d[7].toString(16) + " (expected 0xdead: the handler should run)"] });
}

const total = cases.length + 3;
for(const f of failures)
{
	console.log("FAIL  " + f.name);
	for(const e of f.errors) console.log("        " + e);
}
console.log((failures.length ? "\n" : "") + "m68k: " + ok + "/" + total + " OK" + (failures.length ? " -- " + failures.length + " FAIL" : ""));
process.exit(failures.length ? 1 : 0);
