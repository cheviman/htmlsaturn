/**
 *    Name:         disasm.js
 *    Description:  Compact SH-2 disassembler. Translates a 16-bit opcode
 *                  to its mnemonic for the emulator's debug panel.
 *                  Covers the bulk of the ISA; anything unrecognized falls into .word.
 *    Version:      0.1.0
 *    Created:      15-07-2026
 *    Modified:     15-07-2026
 *    Author:       Sebastian Toyos
 */

//!wip, 15-07-2026 - covers the common instructions. Extend as needed.
function disassemble(op, pc)
{
	op = op & 0xFFFF;
	const n = (op >> 8) & 0xF;
	const m = (op >> 4) & 0xF;
	const d4 = op & 0xF;
	const d8 = op & 0xFF;
	const s8 = (d8 & 0x80) ? d8 - 256 : d8;
	const s12 = (op & 0x800) ? (op & 0xFFF) - 4096 : (op & 0xFFF);
	const R = (x) => "R" + x;
	const hx = (x) => "0x" + (x >>> 0).toString(16);

	switch(op >> 12)
	{
		case 0x0:
			if(op === 0x0009) return "NOP";
			if(op === 0x000B) return "RTS";
			if(op === 0x0008) return "CLRT";
			if(op === 0x0018) return "SETT";
			if(op === 0x0019) return "DIV0U";
			if(op === 0x001B) return "SLEEP";
			if(op === 0x0028) return "CLRMAC";
			if(op === 0x002B) return "RTE";
			if(d4 === 0x2) return ["STC SR,","STC GBR,","STC VBR,"][m] ? ["STC SR,","STC GBR,","STC VBR,"][m] + R(n) : ".word " + hx(op);
			if(d4 === 0x3 && m === 0x0) return "BSRF " + R(n);
			if(d4 === 0x3 && m === 0x2) return "BRAF " + R(n);
			if(d4 === 0x7) return "MUL.L " + R(m) + "," + R(n);
			if(d4 === 0xA) return ["STS MACH,","STS MACL,","STS PR,"][m] + R(n);
			if(d4 === 0xC) return "MOV.B @(R0," + R(m) + ")," + R(n);
			if(d4 === 0xD) return "MOV.W @(R0," + R(m) + ")," + R(n);
			if(d4 === 0xE) return "MOV.L @(R0," + R(m) + ")," + R(n);
			if(d4 === 0x4) return "MOV.B " + R(m) + ",@(R0," + R(n) + ")";
			if(d4 === 0x5) return "MOV.W " + R(m) + ",@(R0," + R(n) + ")";
			if(d4 === 0x6) return "MOV.L " + R(m) + ",@(R0," + R(n) + ")";
			if(d4 === 0xF) return "MAC.L @" + R(m) + "+,@" + R(n) + "+";
			if((op & 0xF0FF) === 0x0029) return "MOVT " + R(n);
			return ".word " + hx(op);

		case 0x1: return "MOV.L " + R(m) + ",@(" + hx(d4 << 2) + "," + R(n) + ")";
		case 0x2:
		{
			const t = ["MOV.B","MOV.W","MOV.L",null,"MOV.B","MOV.W","MOV.L","DIV0S","TST","AND","XOR","OR","CMP/STR","XTRCT","MULU.W","MULS.W"][d4];
			if(d4 <= 2) return t + " " + R(m) + ",@" + R(n);
			if(d4 >= 4 && d4 <= 6) return t + " " + R(m) + ",@-" + R(n);
			return t + " " + R(m) + "," + R(n);
		}
		case 0x3:
		{
			const t = {0:"CMP/EQ",2:"CMP/HS",3:"CMP/GE",4:"DIV1",5:"DMULU.L",6:"CMP/HI",7:"CMP/GT",8:"SUB",10:"SUBC",11:"SUBV",12:"ADD",13:"DMULS.L",14:"ADDC",15:"ADDV"}[d4];
			return (t || ".word " + hx(op)) + " " + R(m) + "," + R(n);
		}
		case 0x4: return group4Dis(op, n, m, R, hx);
		case 0x5: return "MOV.L @(" + hx(d4 << 2) + "," + R(m) + ")," + R(n);
		case 0x6:
		{
			const t = ["MOV.B @","MOV.W @","MOV.L @","MOV ","MOV.B @","MOV.W @","MOV.L @","NOT ","SWAP.B ","SWAP.W ","NEGC ","NEG ","EXTU.B ","EXTU.W ","EXTS.B ","EXTS.W "][d4];
			if(d4 <= 2) return t + R(m) + "," + R(n);
			if(d4 >= 4 && d4 <= 6) return t + R(m) + "+," + R(n);
			return t + R(m) + "," + R(n);
		}
		case 0x7: return "ADD #" + s8 + "," + R(n);
		case 0x8:
			switch(n)
			{
				case 0x0: return "MOV.B R0,@(" + hx(d4) + "," + R(m) + ")";
				case 0x1: return "MOV.W R0,@(" + hx(d4 << 1) + "," + R(m) + ")";
				case 0x4: return "MOV.B @(" + hx(d4) + "," + R(m) + "),R0";
				case 0x5: return "MOV.W @(" + hx(d4 << 1) + "," + R(m) + "),R0";
				case 0x8: return "CMP/EQ #" + s8 + ",R0";
				case 0x9: return "BT " + hx(pc + 4 + (s8 << 1));
				case 0xB: return "BF " + hx(pc + 4 + (s8 << 1));
				case 0xD: return "BT/S " + hx(pc + 4 + (s8 << 1));
				case 0xF: return "BF/S " + hx(pc + 4 + (s8 << 1));
			}
			return ".word " + hx(op);
		case 0x9: return "MOV.W @(" + hx(d8 << 1) + ",PC)," + R(n);
		case 0xA: return "BRA " + hx(pc + 4 + (s12 << 1));
		case 0xB: return "BSR " + hx(pc + 4 + (s12 << 1));
		case 0xC:
			switch(n)
			{
				case 0x0: return "MOV.B R0,@(" + hx(d8) + ",GBR)";
				case 0x1: return "MOV.W R0,@(" + hx(d8 << 1) + ",GBR)";
				case 0x2: return "MOV.L R0,@(" + hx(d8 << 2) + ",GBR)";
				case 0x3: return "TRAPA #" + hx(d8);
				case 0x4: return "MOV.B @(" + hx(d8) + ",GBR),R0";
				case 0x5: return "MOV.W @(" + hx(d8 << 1) + ",GBR),R0";
				case 0x6: return "MOV.L @(" + hx(d8 << 2) + ",GBR),R0";
				case 0x7: return "MOVA @(" + hx(d8 << 2) + ",PC),R0";
				case 0x8: return "TST #" + hx(d8) + ",R0";
				case 0x9: return "AND #" + hx(d8) + ",R0";
				case 0xA: return "XOR #" + hx(d8) + ",R0";
				case 0xB: return "OR #" + hx(d8) + ",R0";
				case 0xC: return "TST.B #" + hx(d8) + ",@(R0,GBR)";
				case 0xD: return "AND.B #" + hx(d8) + ",@(R0,GBR)";
				case 0xE: return "XOR.B #" + hx(d8) + ",@(R0,GBR)";
				case 0xF: return "OR.B #" + hx(d8) + ",@(R0,GBR)";
			}
			return ".word " + hx(op);
		case 0xD: return "MOV.L @(" + hx(d8 << 2) + ",PC)," + R(n);
		case 0xE: return "MOV #" + s8 + "," + R(n);
	}
	return ".word " + hx(op);
}

function group4Dis(op, n, m, R, hx)
{
	const t = {
		0x00:"SHLL",0x01:"SHLR",0x04:"ROTL",0x05:"ROTR",0x08:"SHLL2",0x09:"SHLR2",
		0x18:"SHLL8",0x19:"SHLR8",0x28:"SHLL16",0x29:"SHLR16",0x20:"SHAL",0x21:"SHAR",
		0x24:"ROTCL",0x25:"ROTCR",0x10:"DT",0x11:"CMP/PZ",0x15:"CMP/PL",0x1B:"TAS.B @"
	}[op & 0xFF];
	if(t) return (t === "TAS.B @" ? "TAS.B @" + R(n) : t + " " + R(n));
	switch(op & 0xFF)
	{
		case 0x0B: return "JSR @" + R(n);
		case 0x2B: return "JMP @" + R(n);
		case 0x0E: return "LDC " + R(n) + ",SR";
		case 0x1E: return "LDC " + R(n) + ",GBR";
		case 0x2E: return "LDC " + R(n) + ",VBR";
		case 0x0A: return "LDS " + R(n) + ",MACH";
		case 0x1A: return "LDS " + R(n) + ",MACL";
		case 0x2A: return "LDS " + R(n) + ",PR";
		case 0x07: return "LDC.L @" + R(n) + "+,SR";
		case 0x17: return "LDC.L @" + R(n) + "+,GBR";
		case 0x27: return "LDC.L @" + R(n) + "+,VBR";
		case 0x06: return "LDS.L @" + R(n) + "+,MACH";
		case 0x16: return "LDS.L @" + R(n) + "+,MACL";
		case 0x26: return "LDS.L @" + R(n) + "+,PR";
		case 0x02: return "STS.L MACH,@-" + R(n);
		case 0x12: return "STS.L MACL,@-" + R(n);
		case 0x22: return "STS.L PR,@-" + R(n);
		case 0x03: return "STC.L SR,@-" + R(n);
		case 0x13: return "STC.L GBR,@-" + R(n);
		case 0x23: return "STC.L VBR,@-" + R(n);
		case 0x0F: return "MAC.W @" + R(m) + "+,@" + R(n) + "+";
	}
	return ".word " + hx(op);
}
