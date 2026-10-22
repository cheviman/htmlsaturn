/**
 *    Name:         scu.js
 *    Description:  Sega Saturn SCU DSP (32-bit VLIW processor for vertex
 *                  geometry/transformation). Self-contained: bus.js
 *                  instantiates it and routes the control registers 0x25FE0080+.
 *    Version:      0.1.0
 *    Created:      15-07-2026
 *    Modified:     15-07-2026
 *    Author:       Sebastian Toyos
 *
 *    Ported from the Yabause interpreter (scu.c / scu.h, GPL v2+).
 *    Attribution: Yabause Team. This file is distributed under GPL v2+.
 *
 *    ---------------------------------------------------------------------
 *    PUBLIC API (what bus.js needs):
 *
 *      const dsp = new ScuDspEngine();
 *      dsp.connectBus(readLong, writeLong);   // SCU bus callbacks
 *
 *      // Memory-mapped control registers. bus.js must route the
 *      // LONG (32-bit) writes/reads of these offsets (relative to the
 *      // SCU base 0x25FE0080, "addr & 0xFF" is used):
 *      //   0x80  DSP Program Control Port   (R/W)
 *      //   0x84  DSP Program RAM Data Port   (W)  -> loads the microprogram
 *      //   0x88  DSP Data RAM Address Port   (W)  -> selects page/offset
 *      //   0x8C  DSP Data RAM Data Port      (R/W)
 *      dsp.writeRegister(off, value);
 *      const v = dsp.readRegister(off);
 *
 *      // Microprogram execution. It only fires when the game sets the
 *      // EX bit of the Program Control Port. bus.js can call execute()
 *      // periodically (e.g. one batch per scanline/frame).
 *      dsp.execute(maxSteps);    // runs up to maxSteps instructions or END
 *      dsp.step();               // executes exactly one instruction
 *      dsp.executing;            // getter: EX bit active?
 *
 *      // Introspection (debug/tests):
 *      dsp.programRam            // Uint32Array(256)
 *      dsp.md[bank][cell]        // 4 banks (CT0-3) of 64 32-bit words
 *      dsp.rx / dsp.ry / dsp.pc / dsp.flagZ / ...
 *
 *      // Optional callback on finishing with an interrupt (ENDI instruction):
 *      dsp.onFinish = () => { ... };   // bus.js hooks up the SCU IRQ
 *    ---------------------------------------------------------------------
 */

"use strict";

// BigInt masks for the 48-bit registers (AC/P/ALU/MUL are s64 with a
// 32-bit L field and a 16-bit H field in the hardware).
const SCU_MASK32 = 0xFFFFFFFFn;
const SCU_UPPER16 = 0xffff00000000n;       // bits 32..47 (high part of 48)
const SCU_MASK_MH = 0x0000ffffffff0000n;   // bits 16..47 (to read ALH)
const SCU_BIT47 = 0x800000000000n;         // sign of a 48-bit value
const SCU_BIT48 = 0x1000000000000n;        // carry of a 48-bit addition
const SCU_MASK48 = 0xFFFFFFFFFFFFn;

// Bit positions of the Program Control Port (little-endian layout of the struct).
const PCP_LE = 15; // Program counter load enable
const PCP_EX = 16; // Program execute control (starts the DSP)
const PCP_ES = 17; // Program step execute control
const PCP_E  = 18; // Program end interrupt flag
const PCP_V  = 19; // Overflow
const PCP_C  = 20; // Carry
const PCP_Z  = 21; // Zero
const PCP_S  = 22; // Sign
const PCP_T0 = 23; // D0 bus use / DMA execute flag
const PCP_EP = 25; // Temporary stop (pause)
const PCP_PR = 26; // Pause cancel

class ScuDspEngine
{
	constructor()
	{
		// Program RAM: 256 32-bit words (the game's microprogram).
		this.programRam = new Uint32Array(256);

		// Data RAM: 4 banks (CT0..CT3) of 64 32-bit words.
		this.md = [
			new Uint32Array(64),
			new Uint32Array(64),
			new Uint32Array(64),
			new Uint32Array(64)
		];

		// SCU bus callbacks (bus.js injects them). No-op by default.
		this.readLong = (addr) => 0;         //? with no bus connected, it reads 0
		this.writeLong = (addr, val) => {};

		// Optional callback for the end-of-program IRQ (ENDI).
		this.onFinish = null;

		this.reset();
	}

	//ok, 15-07-2026 - hooks up the SCU bus accesses (for the DSP DMAs)
	connectBus(readLong, writeLong)
	{
		if (typeof readLong === "function")
			this.readLong = readLong;
		if (typeof writeLong === "function")
			this.writeLong = writeLong;
	}

	//ok, 15-07-2026 - initial DSP state
	reset()
	{
		this.programRam.fill(0);
		for (let b = 0; b < 4; b++)
			this.md[b].fill(0);

		this.pcp = 0;                 // Program Control Port (u32, source of truth for the flags)
		this.pc = 0;                  // program counter (0..255)
		this.top = 0;                 // loop top address (for BTM)
		this.lop = 0;                 // loop counter
		this.jmpaddr = -1;            // -1 == no pending jump (0xFFFFFFFF in C)
		this.delayed = 0;             // handling of the jumps' delay slot

		this.dataRamPage = 0;         // page selected by the Data RAM Address Port
		this.dataRamReadAddress = 0;  // offset within the page

		this.ct = [0, 0, 0, 0];       // pointers of each Data RAM bank (0..63)

		this.rx = 0;                  // multiplier X register (s32)
		this.ry = 0;                  // multiplier Y register (s32)

		// 48-bit registers (BigInt, signed).
		this.ac = 0n;                 // accumulator (ALU input)
		this.p = 0n;                  // P register (product/ALU operand)
		this.alu = 0n;                // ALU output
		this.mul = 0n;                // multiplier output (RX*RY)

		// CT auto-increment flags used by the MC0..MC3 sources.
		this.incFlg = [0, 0, 0, 0];
	}

	// ------------------------------------------------------------------
	//  Program Control Port flag helpers
	// ------------------------------------------------------------------

	_bit(b)
	{
		return (this.pcp >>> b) & 1;
	}

	_setBit(b, v)
	{
		if (v)
			this.pcp = (this.pcp | (1 << b)) >>> 0;
		else
			this.pcp = (this.pcp & ~(1 << b)) >>> 0;
	}

	get executing() { return this._bit(PCP_EX) === 1; }
	get flagZ()   { return this._bit(PCP_Z); }
	get flagS()   { return this._bit(PCP_S); }
	get flagC()   { return this._bit(PCP_C); }
	get flagT0()  { return this._bit(PCP_T0); }

	// ------------------------------------------------------------------
	//  Memory-mapped control registers (0x80..0x8C)
	//  bus.js calls these methods.
	// ------------------------------------------------------------------

	//ok, 15-07-2026 - write of a DSP control register (LONG)
	writeRegister(offset, value)
	{
		value = value >>> 0;
		switch (offset & 0xFF)
		{
			case 0x80: // Program Control Port
				this._writeControl(value);
				break;
			case 0x84: // Program RAM Data Port (loads one microprogram word)
				this._writeProgram(value);
				break;
			case 0x88: // Data RAM Address Port (selects page + offset)
				this.dataRamPage = (value >> 6) & 3;
				this.dataRamReadAddress = value & 0x3F;
				break;
			case 0x8C: // Data RAM Data Port (writes into the selected data RAM)
				this._writeDataDataRam(value);
				break;
			default:
				//? unrecognized control offset; bus.js should not route it here
				break;
		}
	}

	//ok, 15-07-2026 - read of a DSP control register (LONG)
	readRegister(offset)
	{
		switch (offset & 0xFF)
		{
			case 0x80: // Program Control Port
			{
				// Yabause exposes only these bits on read.
				const v = (this.pcp & 0x00FD00FF) >>> 0;
				// READING THIS PORT CLEARS THE V FLAG. On hardware, when the DSP program
				// control port (address 25FE0080H) is read, the following phenomena
				// occur: the V flag (overflow flag) is cleared, and therefore the V flag
				// cannot be checked during DSP execution. It is easy to miss: it is not
				// part of the port's bit description, it is a side effect of the read
				// itself.
				// The value from BEFORE clearing is returned, which is the same treatment
				// EXLTFG/EXSYFG of TVSTAT already get in bus.js: whoever reads learns
				// about the overflow once, and the second read already gives 0.
				this._setBit(PCP_V, 0);
				//? Also, a DSP termination interrupt factor "may not occur" if this port is
				//? polled during execution. That is not modeled:
				//? it is a "may", that is a hardware race with no published condition, and
				//? making up a deterministic rule for it would be worse than not having one.
				return v;
			}
			case 0x8C: // Data RAM Data Port
				return this._readDataDataRam();
			default:
				//? only 0x80 and 0x8C are readable on the hardware
				return 0;
		}
	}

	//ok, 15-07-2026 - Program Control Port: starts/stops the DSP, sets PC, flags
	_writeControl(val)
	{
		// Only certain bits are writable; the rest are preserved.
		//   writable (val & 0x060380FF): P, LE, EX, ES, EP, PR
		//   preserved (pcp & 0x00FC0000): E, V, C, Z, S, T0
		this.pcp = ((this.pcp & 0x00FC0000) | (val & 0x060380FF)) >>> 0;

		if (this._bit(PCP_LE))
		{
			// Load the program counter with the P field (bits 0..7).
			this.pc = this.pcp & 0xFF;
		}
	}

	//ok, 15-07-2026 - sequential load of the microprogram into Program RAM
	_writeProgram(val)
	{
		this.programRam[this.pc] = val >>> 0;
		this.pc = (this.pc + 1) & 0xFF;
		// Reflect the new PC in the P field of the control port.
		this.pcp = ((this.pcp & ~0xFF) | (this.pc & 0xFF)) >>> 0;
	}

	//ok, 15-07-2026 - write to Data RAM through the Data Ram Data Port
	_writeDataDataRam(val)
	{
		// Only allowed while the DSP is NOT executing.
		if (!this.executing)
		{
			this.md[this.dataRamPage][this.dataRamReadAddress & 0x3F] = val >>> 0;
			this.dataRamReadAddress = (this.dataRamReadAddress + 1) & 0x3F; //? the HW uses u8 without a mask
		}
	}

	//ok, 15-07-2026 - read of Data RAM through the Data Ram Data Port
	_readDataDataRam()
	{
		if (!this.executing)
		{
			const v = this.md[this.dataRamPage][this.dataRamReadAddress & 0x3F];
			this.dataRamReadAddress = (this.dataRamReadAddress + 1) & 0x3F; //? the HW uses u8 without a mask
			return v >>> 0;
		}
		return 0;
	}

	// ------------------------------------------------------------------
	//  Internal buses: sources (readgensrc) and destinations (writed1busdest,
	//  writeloadimdest) of the DSP.
	// ------------------------------------------------------------------

	//ok, 15-07-2026 - reads a generic source (MD0..MC3, ALL, ALH). Returns u32.
	_readSource(num)
	{
		if (num <= 7)
		{
			const bank = num & 3;
			// num 4..7 == MC0..MC3: flags auto-increment of the CT pointer.
			this.incFlg[bank] |= (num >> 2) & 1;
			return this.md[bank][this.ct[bank] & 0x3F] >>> 0;
		}
		if (num === 0x9) // ALL: low part (32 bits) of the ALU
			return Number(this.alu & SCU_MASK32) >>> 0;
		if (num === 0xA) // ALH: bits 16..47 of the ALU
			return Number((this.alu & SCU_MASK_MH) >> 16n & SCU_MASK32) >>> 0;
		return 0; //? other sources not defined by the ISA
	}

	//ok, 15-07-2026 - D1 bus destination (MOV [s],[d] / MOV SImm,[d])
	_writeD1(num, val)
	{
		switch (num)
		{
			case 0x0: // MC0 (with auto-increment)
			case 0x1: // MC1
			case 0x2: // MC2
			case 0x3: // MC3
				this.md[num][this.ct[num] & 0x3F] = val >>> 0;
				this.ct[num] = (this.ct[num] + 1) & 0x3F;
				return;
			case 0x4: // RX
				this.rx = val | 0;
				return;
			case 0x5: // P (sign extension from 32 to 48 bits)
				this.p = BigInt(val | 0);
				return;
			case 0x6: // RA0
				this.ra0 = val >>> 0;
				return;
			case 0x7: // WA0
				this.wa0 = val >>> 0;
				return;
			case 0xA: // LOP
				this.lop = val & 0xFFFF;
				return;
			case 0xB: // TOP
				this.top = val & 0xFF;
				return;
			case 0xC: // CT0
				this.ct[0] = val & 0x3F; //? the HW stores u8; we mask to 6 bits
				return;
			case 0xD: // CT1
				this.ct[1] = val & 0x3F;
				return;
			case 0xE: // CT2
				this.ct[2] = val & 0x3F;
				return;
			case 0xF: // CT3
				this.ct[3] = val & 0x3F;
				return;
			default:
				return;
		}
	}

	//ok, 15-07-2026 - MVI (load immediate) destination. val already comes sign-extended.
	_writeLoadImm(num, val)
	{
		switch (num)
		{
			case 0x0: // MC0
			case 0x1: // MC1
			case 0x2: // MC2
			case 0x3: // MC3
				this.md[num][this.ct[num] & 0x3F] = val >>> 0;
				this.ct[num] = (this.ct[num] + 1) & 0x3F;
				return;
			case 0x4: // RX
				this.rx = val | 0;
				return;
			case 0x5: // PL
				this.p = BigInt(val | 0);
				return;
			case 0x6: // RA0
				this.ra0 = (val & 0x1FFFFFF) >>> 0;
				return;
			case 0x7: // WA0
				this.wa0 = (val & 0x1FFFFFF) >>> 0;
				return;
			case 0xA: // LOP
				this.lop = val & 0xFFFF;
				return;
			case 0xC: // PC -> TOP, jumps to val
				this.top = (this.pc + 1) & 0xFF;
				this.jmpaddr = val & 0xFF;
				this.delayed = 0;
				return;
			default:
				return;
		}
	}

	// ------------------------------------------------------------------
	//  Execution core
	// ------------------------------------------------------------------

	//ok, 15-07-2026 - executes up to maxSteps instructions while EX is active
	execute(maxSteps)
	{
		if (maxSteps === undefined)
			maxSteps = 0x10000;
		let n = 0;
		while (this.executing && n < maxSteps)
		{
			this.step();
			n++;
		}
		return n;
	}

	//ok, 15-07-2026 - executes exactly one VLIW instruction of the microprogram
	step()
	{
		if (!this.executing)
			return false;

		const instruction = this.programRam[this.pc] >>> 0;

		this.incFlg[0] = 0;
		this.incFlg[1] = 0;
		this.incFlg[2] = 0;
		this.incFlg[3] = 0;

		this._executeAlu(instruction);

		switch (instruction >>> 30)
		{
			case 0x0: // Operation Commands (X/Y/D1 buses)
				this._executeOperation(instruction);
				break;
			case 0x2: // Load Immediate Commands (MVI)
				this._executeLoadImm(instruction);
				break;
			case 0x3: // Other (DMA / JMP / LOOP / END)
				this._executeOthers(instruction);
				break;
			default:
				//? invalid DSP opcode
				break;
		}

		// The multiplier is updated every cycle with the current RX/RY.
		this.mul = BigInt(this.rx | 0) * BigInt(this.ry | 0);

		this.pc = (this.pc + 1) & 0xFF;

		// Handling of the delayed jump (1 delay slot).
		if (this.jmpaddr !== -1)
		{
			if (this.delayed)
			{
				this.pc = this.jmpaddr & 0xFF;
				this.jmpaddr = -1;
			}
			else
			{
				this.delayed = 1;
			}
		}

		return true;
	}

	//ok, 15-07-2026 - ALU commands (bits 26..29 of the instruction)
	_executeAlu(inst)
	{
		const op = (inst >>> 26) & 0xF;
		const acLu = this.ac & SCU_MASK32;      // low part (unsigned 32) of AC
		const acHi = this.ac & SCU_UPPER16;     // bits 32..47 of AC (preserved)
		const pLu = this.p & SCU_MASK32;        // low part of P

		let low;

		switch (op)
		{
			case 0x0: // NOP: AC passes as is to the ALU (low part only)
				this.alu = acLu;
				break;

			case 0x1: // AND
				low = (acLu & pLu);
				this.alu = low | acHi;
				this._fixZS32(low);
				this._setBit(PCP_C, 0);
				break;

			case 0x2: // OR
				low = (acLu | pLu);
				this.alu = low | acHi;
				this._fixZS32(low);
				this._setBit(PCP_C, 0);
				break;

			case 0x3: // XOR
				low = (acLu ^ pLu);
				this.alu = low | acHi;
				this._fixZS32(low);
				this._setBit(PCP_C, 0);
				break;

			case 0x4: // ADD
			{
				const sum = acLu + pLu;
				low = sum & SCU_MASK32;
				this.alu = low | acHi;
				this._fixZS32(low);
				// carry = bit 32 of the unsigned sum
				this._setBit(PCP_C, (sum & 0x100000000n) !== 0n ? 1 : 0);
				break;
			}

			case 0x5: // SUB
			{
				const remaining = acLu - pLu; // BigInt: it can be negative
				low = remaining & SCU_MASK32;
				this.alu = low | acHi;
				this._fixZS32(low);
				// carry if there was a borrow (AC.L < P.L)
				this._setBit(PCP_C, acLu < pLu ? 1 : 0);
				break;
			}

			case 0x6: // AD2 (full 48-bit addition)
			{
				this.alu = this.ac + this.p;
				this._setBit(PCP_Z, this.alu === 0n ? 1 : 0);
				this._setBit(PCP_S, (this.alu & SCU_BIT47) !== 0n ? 1 : 0);
				const carry = ((this.ac & SCU_MASK48) + (this.p & SCU_MASK48)) & SCU_BIT48;
				this._setBit(PCP_C, carry !== 0n ? 1 : 0);
				break;
			}

			case 0x8: // SR (arithmetic shift right: preserves the sign bit)
				this._setBit(PCP_C, Number(acLu & 0x1n));
				low = ((acLu & 0x80000000n) | (acLu >> 1n));
				this.alu = low | acHi;
				this._setBit(PCP_Z, this.alu === 0n ? 1 : 0);
				this._setBit(PCP_S, (low & 0x80000000n) !== 0n ? 1 : 0);
				break;

			case 0x9: // RR (rotate right)
			{
				const c = Number(acLu & 0x1n);
				this._setBit(PCP_C, c);
				low = ((BigInt(c) << 31n) | (acLu >> 1n));
				this.alu = low | acHi;
				this._setBit(PCP_Z, this.alu === 0n ? 1 : 0);
				this._setBit(PCP_S, (low & 0x80000000n) !== 0n ? 1 : 0);
				break;
			}

			case 0xA: // SL (shift left)
				this._setBit(PCP_C, Number((acLu >> 31n) & 0x1n));
				low = (acLu << 1n) & SCU_MASK32;
				this.alu = low | acHi;
				this._fixZS32(low);
				break;

			case 0xB: // RL (rotate left by 1)
			{
				const c = Number((acLu >> 31n) & 0x1n);
				this._setBit(PCP_C, c);
				low = ((acLu << 1n) | BigInt(c)) & SCU_MASK32;
				this.alu = low | acHi;
				this._setBit(PCP_Z, this.alu === 0n ? 1 : 0);
				this._setBit(PCP_S, (low & 0x80000000n) !== 0n ? 1 : 0);
				break;
			}

			case 0xF: // RL8 (rotate left by 8)
				low = ((acLu << 8n) | ((acLu >> 24n) & 0xFFn)) & SCU_MASK32;
				this.alu = low | acHi;
				this._setBit(PCP_Z, this.alu === 0n ? 1 : 0);
				this._setBit(PCP_S, (low & 0x80000000n) !== 0n ? 1 : 0);
				this._setBit(PCP_C, Number((acLu >> 24n) & 0x1n));
				break;

			default:
				//? undefined ALU sub-opcode (7, C, D, E): no-op
				break;
		}
	}

	//ok, 15-07-2026 - sets Z and S looking at the low 32-bit part (BigInt)
	_fixZS32(low)
	{
		this._setBit(PCP_Z, (low & SCU_MASK32) === 0n ? 1 : 0);
		this._setBit(PCP_S, (low & 0x80000000n) !== 0n ? 1 : 0);
	}

	//ok, 15-07-2026 - Operation Commands: X, Y and D1 buses
	_executeOperation(inst)
	{
		// --- X bus ---
		if ((inst >>> 23) & 0x4)
			this.rx = this._readSource((inst >>> 20) & 0x7) | 0; // MOV [s], X

		switch ((inst >>> 23) & 0x3)
		{
			case 2: // MOV MUL, P
				this.p = this.mul;
				break;
			case 3: // MOV [s], P (with sign extension)
				this.p = BigInt(this._readSource((inst >>> 20) & 0x7) | 0);
				break;
			default:
				break;
		}

		// --- Y bus ---
		if ((inst >>> 17) & 0x4)
			this.ry = this._readSource((inst >>> 14) & 0x7) | 0; // MOV [s], Y

		switch ((inst >>> 17) & 0x3)
		{
			case 1: // CLR A
				this.ac = 0n;
				break;
			case 2: // MOV ALU, A
				this.ac = this.alu;
				break;
			case 3: // MOV [s], A (with sign extension)
				this.ac = BigInt(this._readSource((inst >>> 14) & 0x7) | 0);
				break;
			default:
				break;
		}

		// Apply pending CT auto-increments (MC0..MC3 sources).
		this._applyIncrements();

		// --- D1 bus ---
		switch ((inst >>> 12) & 0x3)
		{
			case 1: // MOV SImm, [d]  (signed 8-bit immediate)
				this._writeD1((inst >>> 8) & 0xF, (inst & 0x80) ? (inst | 0xFFFFFF00) : (inst & 0xFF));
				break;
			case 3: // MOV [s], [d]
				this._writeD1((inst >>> 8) & 0xF, this._readSource(inst & 0xF));
				this._applyIncrements();
				break;
			default:
				break;
		}
	}

	//ok, 15-07-2026 - applies the CT auto-increments flagged by incFlg
	_applyIncrements()
	{
		for (let i = 0; i < 4; i++)
		{
			if (this.incFlg[i] !== 0)
			{
				this.ct[i] = (this.ct[i] + 1) & 0x3F;
				this.incFlg[i] = 0;
			}
		}
	}

	//ok, 15-07-2026 - Load Immediate Commands (MVI, with or without condition)
	_executeLoadImm(inst)
	{
		const dst = (inst >>> 26) & 0xF;
		// Signed 19-bit immediate (bit 18 is the sign).
		const imm19 = (inst & 0x7FFFF) | ((inst & 0x40000) ? 0xFFF80000 : 0);

		if ((inst >>> 25) & 1)
		{
			// Conditional MVI: the condition code is in bits 19..24.
			const cond = (inst >>> 19) & 0x3F;
			let ok = false;
			switch (cond)
			{
				case 0x01: ok = !this.flagZ; break;                    // NZ
				case 0x02: ok = !this.flagS; break;                    // NS
				case 0x03: ok = !this.flagZ || !this.flagS; break;  // NZS
				case 0x04: ok = !this.flagC; break;                    // NC
				case 0x08: ok = !this.flagT0; break;                   // NT0
				case 0x21: ok = !!this.flagZ; break;                   // Z
				case 0x22: ok = !!this.flagS; break;                   // S
				case 0x23: ok = this.flagZ || this.flagS; break;    // ZS
				case 0x24: ok = !!this.flagC; break;                   // C
				case 0x28: ok = !!this.flagT0; break;                  // T0
				default: ok = false; break;                              //? undefined condition
			}
			if (ok)
				this._writeLoadImm(dst, imm19 | 0);
		}
		else
		{
			// Unconditional MVI: signed 25-bit immediate.
			let value = inst & 0x1FFFFFF;
			if (value & 0x1000000)
				value |= 0xFE000000;
			this._writeLoadImm(dst, value | 0);
		}
	}

	//ok, 15-07-2026 - "Other" commands: DMA, JMP, LOOP (BTM/LPS) and END/ENDI
	_executeOthers(inst)
	{
		switch ((inst >>> 28) & 0xF)
		{
			case 0x0C: // DMA Commands
				this._executeDma(inst);
				break;

			case 0x0D: // Jump Commands
			{
				const cond = (inst >>> 19) & 0x7F;
				let jumps = false;
				switch (cond)
				{
					case 0x00: jumps = true; break;                            // JMP
					case 0x41: jumps = !this.flagZ; break;                  // JMP NZ
					case 0x42: jumps = !this.flagS; break;                  // JMP NS
					case 0x43: jumps = !this.flagZ || !this.flagS; break;// JMP NZS
					case 0x44: jumps = !this.flagC; break;                  // JMP NC
					case 0x48: jumps = !this.flagT0; break;                 // JMP NT0
					case 0x61: jumps = !!this.flagZ; break;                 // JMP Z
					case 0x62: jumps = !!this.flagS; break;                 // JMP S
					case 0x63: jumps = this.flagZ || this.flagS; break;  // JMP ZS
					case 0x64: jumps = !!this.flagC; break;                 // JMP C
					case 0x68: jumps = !!this.flagT0; break;                // JMP T0
					default: jumps = false; break;                            //? unrecognized JMP
				}
				if (jumps)
				{
					this.jmpaddr = inst & 0xFF;
					this.delayed = 0;
				}
				break;
			}

			case 0x0E: // Loop bottom (BTM / LPS)
				if (inst & 0x8000000)
				{
					// LPS: repeats the last block (jumps to the current PC)
					if (this.lop !== 0)
					{
						this.jmpaddr = this.pc;
						this.delayed = 0;
						this.lop--;
					}
				}
				else
				{
					// BTM: goes back to the loop TOP
					if (this.lop !== 0)
					{
						this.jmpaddr = this.top;
						this.delayed = 0;
						this.lop--;
					}
				}
				break;

			case 0x0F: // End Commands (END / ENDI)
				this._setBit(PCP_EX, 0); // stops execution
				if (inst & 0x8000000)
				{
					// ENDI: finishes with an interrupt.
					// BUT IF THE E FLAG WAS ALREADY 1, IT IS NOT ISSUED. It is easy to miss,
					// because it is not in the basic description of ENDI: when activating
					// the DSP, the program termination interrupt flag (bit 18: E) of the DSP
					// program control port has to be set to 0. When the flag is 1, the DSP
					// program termination interrupt is NOT issued even if the DSP program
					// is terminated with the ENDI
					// instruction.
					// So E is not a simple "I finished" notice: it is also the gate of
					// its own interrupt, and whoever wants it again has to clear it
					// before starting the DSP. We fired it ALWAYS, so a game
					// that does not clear it got an IRQ the hardware holds back.
					const alreadyWas = (this.pcp >>> PCP_E) & 1;
					this._setBit(PCP_E, 1);
					if (!alreadyWas && typeof this.onFinish === "function")
						this.onFinish();
				}
				// Reflect PC+1 in the P field of the control port.
				this.pcp = ((this.pcp & ~0xFF) | ((this.pc + 1) & 0xFF)) >>> 0;
				break;

			default:
				//? undefined "Other" sub-command
				break;
		}
	}

	// ------------------------------------------------------------------
	//  DSP DMA instructions (transfers with the SCU bus)
	//  The immediate path is implemented (without per-cycle timing).
	// ------------------------------------------------------------------

	//ok, 15-07-2026 - decodes which of the 8 DMA types it is and executes it
	_executeDma(inst)
	{
		const sub10 = (inst >>> 10) & 0x1F;
		const sub11 = (inst >>> 11) & 0x0F;

		if (sub10 === 0x00)      this._dspDma01(inst);
		else if (sub10 === 0x04) this._dspDma02(inst);
		else if (sub11 === 0x04) this._dspDma03(inst);
		else if (sub10 === 0x0C) this._dspDma04(inst);
		else if (sub11 === 0x08) this._dspDma05(inst);
		else if (sub10 === 0x14) this._dspDma06(inst);
		else if (sub11 === 0x0C) this._dspDma07(inst);
		else if (sub10 === 0x1C) this._dspDma08(inst);
		//? else: unrecognized DMA pattern
	}

	// "add" table (address step) according to bits 15..17
	_addDma(inst)
	{
		switch ((inst >>> 15) & 0x07)
		{
			case 0: return 0;
			case 1: return 1;
			case 2: return 2;
			case 3: return 4;
			case 4: return 8;
			case 5: return 16;
			case 6: return 32;
			case 7: return 64;
		}
		return 0;
	}

	// checks whether an address falls on the A-Bus (affects the increment step)
	_isABus(addr)
	{
		const chk = addr & 0x0FF00000;
		return (chk >= 0x02000000 && chk < 0x05900000);
	}

	//ok, 15-07-2026 - DMA01: bus -> Data RAM, immediate count (imm)
	_dspDma01(inst)
	{
		const imm = inst & 0xFF;
		const sel = (inst >> 8) & 0x03;
		let add = this._addDma(inst);

		if (this._isABus(this.ra0 << 2))
		{
			if (add > 1) add = 1;
			for (let i = 0; i < imm; i++)
			{
				this.md[sel][this.ct[sel] & 0x3F] = this.readLong((this.ra0 << 2) >>> 0) >>> 0;
				this.ct[sel] = (this.ct[sel] + 1) & 0x3F;
				this.ra0 = (this.ra0 + add) >>> 0;
			}
		}
		else
		{
			for (let i = 0; i < imm; i++)
			{
				this.md[sel][this.ct[sel] & 0x3F] = this.readLong((this.ra0 << 2) >>> 0) >>> 0;
				this.ct[sel] = (this.ct[sel] + 1) & 0x3F;
				this.ra0 = (this.ra0 + (add >> 1)) >>> 0;
			}
		}
		this._setBit(PCP_T0, 0);
	}

	//ok, 15-07-2026 - DMA02: Data RAM -> bus, immediate count (imm)
	_dspDma02(inst)
	{
		const imm = inst & 0xFF;
		const sel = (inst >> 8) & 0x03;
		const add = this._addDma(inst);

		if (add !== 1)
		{
			for (let i = 0; i < imm; i++)
			{
				const val = this.md[sel][this.ct[sel] & 0x3F] >>> 0;
				this.writeLong((this.wa0 << 2) >>> 0, val);
				this.ct[sel] = (this.ct[sel] + 1) & 0x3F;
				this.wa0 = (this.wa0 + (add >> 1)) >>> 0;
			}
		}
		else
		{
			for (let i = 0; i < imm; i++)
			{
				const val = this.md[sel][this.ct[sel] & 0x3F] >>> 0;
				this.writeLong((this.wa0 << 2) >>> 0, val);
				this.ct[sel] = (this.ct[sel] + 1) & 0x3F;
				this.wa0 = (this.wa0 + 1) >>> 0;
			}
		}
		this._setBit(PCP_T0, 0);
	}

	//ok, 15-07-2026 - DMA03: bus -> Data RAM, indirect count (from MD)
	_dspDma03(inst)
	{
		let count = this._readCounterMd(inst);
		let add = this._addDma(inst);
		const sel = (inst >> 8) & 0x3;

		if (this._isABus(this.ra0 << 2))
		{
			if (add > 1) add = 1;
			for (let i = 0; i < count; i++)
			{
				this.md[sel][this.ct[sel] & 0x3F] = this.readLong((this.ra0 << 2) >>> 0) >>> 0;
				this.ct[sel] = (this.ct[sel] + 1) & 0x3F;
				this.ra0 = (this.ra0 + add) >>> 0;
			}
		}
		else
		{
			for (let i = 0; i < count; i++)
			{
				this.md[sel][this.ct[sel] & 0x3F] = this.readLong((this.ra0 << 2) >>> 0) >>> 0;
				this.ct[sel] = (this.ct[sel] + 1) & 0x3F;
				this.ra0 = (this.ra0 + (add >> 1)) >>> 0;
			}
		}
		this._setBit(PCP_T0, 0);
	}

	//ok, 15-07-2026 - DMA04: Data RAM -> bus, indirect count (from MD)
	_dspDma04(inst)
	{
		let count = this._readCounterMd(inst);
		const add = this._addDma(inst);
		const sel = (inst >> 8) & 0x03;

		for (let i = 0; i < count; i++)
		{
			const val = this.md[sel][this.ct[sel] & 0x3F] >>> 0;
			this.writeLong((this.wa0 << 2) >>> 0, val);
			this.ct[sel] = (this.ct[sel] + 1) & 0x3F;
			this.wa0 = (this.wa0 + add) >>> 0;
		}
		this._setBit(PCP_T0, 0);
	}

	// DMA05..08: "hold" variants (they restore RA0/WA0 when done)
	_dspDma05(inst) { const s = this.ra0; this._dspDma01(inst); this.ra0 = s; }
	_dspDma06(inst) { const s = this.wa0; this._dspDma02(inst); this.wa0 = s; }
	_dspDma07(inst) { const s = this.ra0; this._dspDma03(inst); this.ra0 = s; }
	_dspDma08(inst) { const s = this.wa0; this._dspDma04(inst); this.wa0 = s; }

	// reads the count of an indirect DMA from Data RAM (with optional CT++)
	_readCounterMd(inst)
	{
		const idx = inst & 0x7;
		const bank = idx & 0x3;
		const count = this.md[bank][this.ct[bank] & 0x3F] >>> 0;
		if (idx >= 0x04) // 4..7: increments the bank pointer
			this.ct[bank] = (this.ct[bank] + 1) & 0x3F;
		return count;
	}
}

// The RA0/WA0 registers are initialized lazily; we make sure they exist.
ScuDspEngine.prototype.ra0 = 0;
ScuDspEngine.prototype.wa0 = 0;

// Flexible export: module (Node/tests) or global (browser via bus.js).
if (typeof module !== "undefined" && module.exports)
	module.exports = ScuDspEngine;
if (typeof globalThis !== "undefined")
	globalThis.ScuDspEngine = ScuDspEngine;
