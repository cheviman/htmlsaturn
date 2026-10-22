// SH-2 ORACLE: compares our instructions against their REFERENCE PSEUDOCODE.
//
// It is born from a pattern, not from a symptom (asked by Sebas (26-07-2026, translated): "look
// in the docs for a pattern"). On 25-07 the Sega Touring Car car came out black because of the MAC.L
// SATURATION: we added the raw 32 bits of MACH where the hardware sign-extends
// from bit 15. One odd instruction, wrong in an edge case, and the symptom showed up
// three layers further up (in a color).
//
// If that happened once it can happen in the others. Here is the reference pseudocode for the
// "odd" instructions -the ones with flags, carries, saturation or
// mixing of halves- and it is run against the implementation with EDGE cases, which is where
// they fail: 0, -1, 0x80000000, 0x7FFFFFFF, sign crossings.
//
// Usage: node diag/sh2-oracle.mjs
import { readFileSync } from "fs";

eval(readFileSync("sh2.js", "utf8") + "\nglobalThis.SH2 = SH2;");

// Minimal bus: 1 MB of flat RAM, enough for the arithmetic instructions.
const RAM = new Uint8Array(0x100000);
const fakeBus = {
	readByte:  (a) => RAM[a & 0xFFFFF],
	readWord:  (a) => ((RAM[a & 0xFFFFF] << 8) | RAM[(a + 1) & 0xFFFFF]) & 0xFFFF,
	readLong:  (a) => (((RAM[a & 0xFFFFF] << 24) | (RAM[(a+1) & 0xFFFFF] << 16) |
	                    (RAM[(a+2) & 0xFFFFF] << 8) | RAM[(a+3) & 0xFFFFF]) >>> 0),
	writeByte: (a, v) => { RAM[a & 0xFFFFF] = v & 0xFF; },
	writeWord: (a, v) => { RAM[a & 0xFFFFF] = (v >> 8) & 0xFF; RAM[(a+1) & 0xFFFFF] = v & 0xFF; },
	writeLong: (a, v) => { RAM[a & 0xFFFFF] = (v>>>24)&0xFF; RAM[(a+1)&0xFFFFF] = (v>>>16)&0xFF;
	                          RAM[(a+2)&0xFFFFF] = (v>>>8)&0xFF; RAM[(a+3)&0xFFFFF] = v&0xFF; },
	markReadTemp: () => {},
	_markReadTemp: () => {},
};

const EDGES = [0, 1, -1, 2, -2, 0x7FFFFFFF, -0x80000000, 0x0000FFFF, -0x10000,
                0x00008000, -0x8000, 0x12345678, -0x12345678, 0x80000000 | 0, 0xFFFF0000 | 0];

let ok = 0, bad = 0;
const failures = [];

// Runs ONE instruction (16-bit opcode) with the given state and returns the final state.
function run(op, state)
{
	const cpu = new SH2(fakeBus, "test");
	cpu.pc = 0x1000;
	if(state.r) for(let i = 0; i < 16; i++) if(state.r[i] !== undefined) cpu.r[i] = state.r[i] | 0;
	if(state.sr   !== undefined) cpu.sr   = state.sr;
	if(state.macl !== undefined) cpu.macl = state.macl | 0;
	if(state.mach !== undefined) cpu.mach = state.mach | 0;
	fakeBus.writeWord(0x1000, op);
	fakeBus.writeWord(0x1002, 0x0009);   // NOP in case there is a delay slot
	cpu.step();
	return { r: [...cpu.r], sr: cpu.sr, macl: cpu.macl | 0, mach: cpu.mach | 0, t: cpu.sr & 1 };
}

function test(name, op, state, expected)
{
	const got = run(op, state);
	for(const k of Object.keys(expected))
	{
		let a, b;
		if(k === "t")    { a = expected.t; b = got.t; }
		else if(k === "macl") { a = expected.macl | 0; b = got.macl | 0; }
		else if(k === "mach") { a = expected.mach | 0; b = got.mach | 0; }
		else             { a = expected[k] | 0; b = got.r[parseInt(k.slice(1))] | 0; }
		if(a !== b)
		{
			bad++;
			failures.push(name + ": " + k + " expected 0x" + (a >>> 0).toString(16)
				+ ", got 0x" + (b >>> 0).toString(16));
			return;
		}
	}
	ok++;
}

// ---------------------------------------------------------------------------
// The reference pseudocode, transcribed. Each block names its instruction.
// ---------------------------------------------------------------------------

for(const x of EDGES) for(const y of EDGES)
{
	const a = x | 0, b = y | 0;

	// ADDV Rm,Rn  (0x3nmF): add with SIGNED OVERFLOW detection in T.
	{
		const s = (a + b) | 0;
		const ovf = (((a < 0) === (b < 0)) && ((s < 0) !== (a < 0))) ? 1 : 0;
		test("ADDV " + a + "," + b, 0x310F, { r: { 0: b, 1: a } }, { r1: s, t: ovf });
	}
	// SUBV Rm,Rn  (0x3nmB): subtract with signed overflow.
	{
		const s = (a - b) | 0;
		const ovf = (((a < 0) !== (b < 0)) && ((s < 0) !== (a < 0))) ? 1 : 0;
		test("SUBV " + a + "," + b, 0x310B, { r: { 0: b, 1: a } }, { r1: s, t: ovf });
	}
	// ADDC Rm,Rn  (0x3nmE): add with UNSIGNED carry; T = carry out.
	for(const tin of [0, 1])
	{
		const sum = (a >>> 0) + (b >>> 0) + tin;
		test("ADDC " + a + "," + b + " T=" + tin, 0x310E,
			{ r: { 0: b, 1: a }, sr: tin }, { r1: sum | 0, t: sum > 0xFFFFFFFF ? 1 : 0 });
	}
	// SUBC Rm,Rn  (0x3nmA): subtract with UNSIGNED borrow.
	for(const tin of [0, 1])
	{
		const diff = (a >>> 0) - (b >>> 0) - tin;
		test("SUBC " + a + "," + b + " T=" + tin, 0x310A,
			{ r: { 0: b, 1: a }, sr: tin }, { r1: diff | 0, t: diff < 0 ? 1 : 0 });
	}
	// NEGC Rm,Rn  (0x6nmA): Rn = 0 - Rm - T, with borrow in T.
	for(const tin of [0, 1])
	{
		const diff = 0 - (a >>> 0) - tin;
		test("NEGC " + a + " T=" + tin, 0x610A, { r: { 0: a }, sr: tin },
			{ r1: diff | 0, t: diff < 0 ? 1 : 0 });
	}
	// XTRCT Rm,Rn (0x2nmD): the middle 16 bits of the Rm:Rn pair.
	test("XTRCT " + a + "," + b, 0x210D, { r: { 0: a, 1: b } },
		{ r1: (((a << 16) & 0xFFFF0000) | ((b >>> 16) & 0xFFFF)) | 0 });
	// DMULS.L Rm,Rn (0x3nmD): SIGNED 32x32 product -> MACH:MACL.
	{
		const p = BigInt(a) * BigInt(b);
		const u = BigInt.asUintN(64, p);
		test("DMULS " + a + "," + b, 0x310D, { r: { 0: b, 1: a } },
			{ macl: Number(BigInt.asIntN(32, u & 0xFFFFFFFFn)), mach: Number(BigInt.asIntN(32, u >> 32n)) });
	}
	// DMULU.L Rm,Rn (0x3nm5): UNSIGNED 32x32 product.
	{
		const p = BigInt(a >>> 0) * BigInt(b >>> 0);
		test("DMULU " + (a>>>0) + "," + (b>>>0), 0x3105, { r: { 0: b, 1: a } },
			{ macl: Number(BigInt.asIntN(32, p & 0xFFFFFFFFn)), mach: Number(BigInt.asIntN(32, p >> 32n)) });
	}
	// MUL.L Rm,Rn (0x0nm7): 32x32 -> the low 32 bits in MACL.
	test("MUL.L " + a + "," + b, 0x0107, { r: { 0: b, 1: a } },
		{ macl: Number(BigInt.asIntN(32, BigInt(a) * BigInt(b) & 0xFFFFFFFFn)) });
	// CMP/GT (signed) and CMP/HI (unsigned), which are easy to mix up.
	test("CMP/GT " + a + "," + b, 0x3107, { r: { 0: a, 1: b } }, { t: b > a ? 1 : 0 });
	test("CMP/HI " + a + "," + b, 0x3106, { r: { 0: a, 1: b } }, { t: (b >>> 0) > (a >>> 0) ? 1 : 0 });
	test("CMP/GE " + a + "," + b, 0x3103, { r: { 0: a, 1: b } }, { t: b >= a ? 1 : 0 });
	test("CMP/HS " + a + "," + b, 0x3102, { r: { 0: a, 1: b } }, { t: (b >>> 0) >= (a >>> 0) ? 1 : 0 });
	// SWAP.B / SWAP.W
	test("SWAP.B " + a, 0x6108, { r: { 0: a } },
		{ r1: ((a & 0xFFFF0000) | ((a & 0xFF) << 8) | ((a >> 8) & 0xFF)) | 0 });
	test("SWAP.W " + a, 0x6109, { r: { 0: a } },
		{ r1: (((a << 16) | ((a >>> 16) & 0xFFFF)) ) | 0 });
	// EXTS/EXTU
	test("EXTS.B " + a, 0x610E, { r: { 0: a } }, { r1: ((a << 24) >> 24) | 0 });
	test("EXTS.W " + a, 0x610F, { r: { 0: a } }, { r1: ((a << 16) >> 16) | 0 });
	test("EXTU.B " + a, 0x610C, { r: { 0: a } }, { r1: a & 0xFF });
	test("EXTU.W " + a, 0x610D, { r: { 0: a } }, { r1: a & 0xFFFF });
	// DT Rn (0x4n10): decrements and T=1 if it ended at 0.
	test("DT " + a, 0x4010, { r: { 0: a } }, { r0: (a - 1) | 0, t: ((a - 1) | 0) === 0 ? 1 : 0 });
	// ROTCL / ROTCR (rotate THROUGH T)
	for(const tin of [0, 1])
	{
		test("ROTCL " + a + " T=" + tin, 0x4024, { r: { 0: a }, sr: tin },
			{ r0: ((a << 1) | tin) | 0, t: (a >>> 31) & 1 });
		test("ROTCR " + a + " T=" + tin, 0x4025, { r: { 0: a }, sr: tin },
			{ r0: (((a >>> 1) & 0x7FFFFFFF) | (tin << 31)) | 0, t: a & 1 });
	}
	// SHAR / SHLR (arithmetic vs logical: the classic)
	test("SHAR " + a, 0x4021, { r: { 0: a } }, { r0: (a >> 1) | 0, t: a & 1 });
	test("SHLR " + a, 0x4001, { r: { 0: a } }, { r0: (a >>> 1) | 0, t: a & 1 });
	test("SHAL " + a, 0x4020, { r: { 0: a } }, { r0: (a << 1) | 0, t: (a >>> 31) & 1 });
}

// --- MAC.L and MAC.W: what already failed once. With and without saturation. ---
for(const s of [0, 1])
	for(const [va, vb, ml, mh] of [
		[2, 3, 0, 0], [-2, 3, 0, 0], [0x7FFFFFFF, 2, 0, 0], [-0x80000000, -1, 0, 0],
		[1, 1, -1, -1], [0x10000, 0x10000, 0, 0], [3, 5, 0x7FFFFFFF, 0],
		[1, 1, 0, 0xFFFF0000 | 0], [1, 1, 0, 0x00010000], [-1, -1, 0, 0xFFFF8000 | 0]])
	{
		fakeBus.writeLong(0x2000, va >>> 0);
		fakeBus.writeLong(0x3000, vb >>> 0);
		const cpu = new SH2(fakeBus, "t");
		cpu.pc = 0x1000; cpu.r[0] = 0x2000; cpu.r[1] = 0x3000;
		cpu.macl = ml | 0; cpu.mach = mh | 0; cpu.sr = s ? 2 : 0;
		fakeBus.writeWord(0x1000, 0x001F);   // MAC.L @R1+,@R0+  (0x0nmF, n=0 m=1)
		cpu.step();
		// Reference pseudocode for S=1: 48-BIT accumulator -> the low 16 bits of MACH
		// SIGN-EXTENDED from bit 15, not the raw 32.
		const prod = BigInt(va) * BigInt(vb);
		if(!s)
		{
			const acc = ((BigInt(mh | 0) << 32n) | BigInt((ml | 0) >>> 0)) + prod;
			const u = BigInt.asUintN(64, acc);
			const eMacl = Number(BigInt.asIntN(32, u & 0xFFFFFFFFn));
			const eMach = Number(BigInt.asIntN(32, u >> 32n));
			if((cpu.macl | 0) !== eMacl || (cpu.mach | 0) !== eMach)
			{ bad++; failures.push("MAC.L S=0 " + va + "*" + vb + " macl/mach"); } else ok++;
		}
		else
		{
			const mh48 = BigInt(((mh | 0) << 16) >> 16);              // sign from bit 15
			let acc = ((mh48 << 32n) | BigInt((ml | 0) >>> 0)) + prod;
			const MAX = (1n << 47n) - 1n, MIN = -(1n << 47n);
			if(acc > MAX) acc = MAX; else if(acc < MIN) acc = MIN;
			const u = BigInt.asUintN(48, acc);
			const eMacl = Number(BigInt.asIntN(32, u & 0xFFFFFFFFn));
			const eMach16 = Number(u >> 32n) & 0xFFFF;
			if((cpu.macl | 0) !== eMacl || ((cpu.mach | 0) & 0xFFFF) !== eMach16)
			{ bad++; failures.push("MAC.L S=1 " + va + "*" + vb + " (mh=0x" + ((mh|0)>>>0).toString(16)
				+ " ml=0x" + ((ml|0)>>>0).toString(16) + "): macl expected 0x" + (eMacl>>>0).toString(16)
				+ " got 0x" + ((cpu.macl|0)>>>0).toString(16)
				+ " | mach16 expected 0x" + eMach16.toString(16) + " got 0x" + (((cpu.mach|0)&0xFFFF)).toString(16)); }
			else ok++;
		}
	}

console.log("\nSH-2 ORACLE against the reference pseudocode");
console.log("  passed: " + ok + "   FAILED: " + bad);
if(failures.length)
{
	console.log("\n  the first 25 failures:");
	const views = new Set();
	let n = 0;
	for(const f of failures)
	{
		const key = f.split(" ")[0];
		if(views.has(key) && n > 8) continue;
		views.add(key);
		console.log("    " + f);
		if(++n >= 25) break;
	}
	console.log("\n  instructions with at least one failure: " + [...views].join(" "));
}
