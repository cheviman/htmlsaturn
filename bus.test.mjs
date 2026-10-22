/**
 *    Name:         bus.test.mjs
 *    Description:  Tests of the SMPC peripheral report (INTBACK command). For
 *                  each peripheral type supported on port 1 (digital pad, 3D
 *                  Control Pad, Racing Wheel, Shuttle Mouse and Virtua Gun) it checks the
 *                  emitted ID, the data bytes for a given state, the port 2 header
 *                  (0xF0) in the right OREG and the "data ready" bit (SR/OREG49).
 *                  It drives INTBACK through the real MMIO path (COMREG 0x10), same
 *                  as the hardware. Run with: node bus.test.mjs
 *    Version:      0.1.0
 *    Created:      17-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync } from "fs";
// bus.js is a browser script (global class). We load it with eval because it is
// the project's own trusted code; there is no external input. With eval, the SCSP
// engine stays null (scsp.js is not loaded), which is exactly what we want: these
// tests only touch the SMPC.
eval(readFileSync("bus.js", "utf8") + "\nglobalThis.Bus=Bus;");

let passed = 0, failed = 0;
function check(name, expected, obtained)
{
	if(expected === obtained) passed++;
	else { failed++; console.log("  FAIL", name, "exp", expected, "got", obtained); }
}
// Compares a span of OREG (byte array) against the expected one. Reports in hex.
function checkBytes(name, expected, obtained)
{
	const hex = (a) => "[" + a.map((x) => x.toString(16).padStart(2, "0")).join(" ") + "]";
	if(expected.length === obtained.length && expected.every((v, i) => v === obtained[i])) passed++;
	else { failed++; console.log("  FAIL", name, "exp", hex(expected), "got", hex(obtained)); }
}

const bus = new Bus();
// INTBACK fires the SCU "System Manager" IRQ: without a cpuMaster, _scuIrq
// throws. Minimal stub, same as in cd.test.mjs.
bus.cpuMaster = { cycles: 0, requestInterrupt: () => {}, requestNmi: () => {} };

// The SMPC reads its byte-wide registers at ODD addresses:
// IREG0-3 = 0x01,0x03,...; COMREG = 0x1F; OREG0-31 = 0x21+n*2.
const oreg = (n) => bus.smpc[0x21 + n * 2];

// Runs a peripherals-ONLY INTBACK (single phase) through the real MMIO path and
// returns the first `count` OREGs plus the SR (OREG49 = 0x61). `setup` sets the
// peripheral's state before the command.
function intback(type, setup, count)
{
	bus.peripheral1 = type;
	// Everything at rest (each peripheral's default) to isolate each test.
	bus.pad1a = 0xFF; bus.pad1b = 0xFF;
	bus.an1x = 0x80; bus.an1y = 0x80; bus.an1r = 0x00; bus.an1l = 0x00;
	bus.wheel1 = 0x80;
	bus.mouse1btn = 0x00; bus.mouse1dx = 0; bus.mouse1dy = 0;
	bus.gun1x = 0; bus.gun1y = 0; bus.gun1trigger = false; bus.gun1start = false;
	if(setup) setup(bus);
	bus.writeByte(0x00100001, 0x00);   // IREG0: no status phase
	bus.writeByte(0x00100003, 0x08);   // IREG1: ask for peripherals
	bus.writeByte(0x0010001F, 0x10);   // COMREG: INTBACK
	const out = [];
	for(let i = 0; i < count; i++) out.push(oreg(i));
	return { oreg: out, sr: bus.smpc[0x61] };
}

// ============================================================================
//   Standard digital pad (ID 0x02, 2 bytes) - the DEFAULT
// ============================================================================
{
	const r = intback("pad", null, 5);
	checkBytes("pad at rest: F1 02 FF FF F0", [0xF1, 0x02, 0xFF, 0xFF, 0xF0], r.oreg);
	check("pad at rest: faithful SR = 0xC0 (PDL + bit6 fixed at 1)", 0xC0, r.sr);
}
{
	// A = pad1a bit2. Start = pad1a bit3. Pressed = 0 (active-low): 0xFF & ~0x0C.
	const r = intback("pad", (b) => { b.pad1a = 0xFF & ~0x0C; }, 5);
	checkBytes("pad with A+Start: byte1 = 0xF3", [0xF1, 0x02, 0xF3, 0xFF, 0xF0], r.oreg);
	check("pad with a button: SR = 0xC0 (data ready)", 0xC0, r.sr);
}

// ============================================================================
//   Analog 3D Control Pad (ID 0x16, 6 bytes) - the NiGHTS one
// ============================================================================
{
	// pad1a with A pressed (0xFB); stick and triggers at arbitrary values.
	const r = intback("pad3d", (b) => {
		b.pad1a = 0xFB; b.an1x = 0x40; b.an1y = 0xC0; b.an1r = 0xFF; b.an1l = 0x10;
	}, 9);
	checkBytes("pad3d: F1 16 [pad1a pad1b AX AY AR AL] F0",
		[0xF1, 0x16, 0xFB, 0xFF, 0x40, 0xC0, 0xFF, 0x10, 0xF0], r.oreg);
	check("pad3d: port 2 header (0xF0) lands in OREG8", 0xF0, r.oreg[8]);
	check("pad3d: SR = 0xC0 because of the off-center stick", 0xC0, r.sr);
}
{
	// Everything at rest (stick centered 0x80, triggers 0x00): there is no active input.
	const r = intback("pad3d", null, 9);
	checkBytes("pad3d at rest: axes centered",
		[0xF1, 0x16, 0xFF, 0xFF, 0x80, 0x80, 0x00, 0x00, 0xF0], r.oreg);
	check("pad3d at rest: faithful SR = 0xC0", 0xC0, r.sr);
}

// ============================================================================
//   Racing / Arcade Racer (ID 0x13, 3 bytes) - steering wheel
// ============================================================================
{
	// Shift paddle = Up (pad1a bit4 -> 0xEF); wheel turned to the right.
	const r = intback("wheel", (b) => { b.pad1a = 0xEF; b.wheel1 = 0xE0; }, 6);
	checkBytes("wheel: F1 13 [pad1a pad1b wheel] F0",
		[0xF1, 0x13, 0xEF, 0xFF, 0xE0, 0xF0], r.oreg);
	check("wheel: port 2 header lands in OREG5", 0xF0, r.oreg[5]);
	check("wheel: SR = 0xC0 because of the off-center wheel", 0xC0, r.sr);
}
{
	const r = intback("wheel", null, 6);
	check("wheel at rest: wheel centered at 0x80", 0x80, r.oreg[4]);
	check("wheel at rest: faithful SR = 0xC0", 0xC0, r.sr);
}

// ============================================================================
//   Shuttle Mouse (ID 0xE3, 3 bytes) - sign + magnitude + overflow
// ============================================================================
{
	// dX = +10 (sign 0), dY = -5 (sign 1, bit5), Left button (bit0, active-HIGH).
	const r = intback("mouse", (b) => { b.mouse1dx = 10; b.mouse1dy = -5; b.mouse1btn = 0x01; }, 6);
	// flags = YSign(0x20) | Left(0x01) = 0x21; XD = 10; YD = 5.
	checkBytes("mouse: F1 E3 [flags XD YD] F0", [0xF1, 0xE3, 0x21, 0x0A, 0x05, 0xF0], r.oreg);
	check("mouse: port 2 header lands in OREG5", 0xF0, r.oreg[5]);
	check("mouse: SR = 0xC0 with button/movement", 0xC0, r.sr);
}
{
	// dX = -300: negative (XSign bit4) and over 255 (XOver bit6), the magnitude saturates at 255.
	const r = intback("mouse", (b) => { b.mouse1dx = -300; }, 6);
	check("mouse overflow: flags = XOver|XSign = 0x50", 0x50, r.oreg[2]);
	check("mouse overflow: XD saturates at 255", 0xFF, r.oreg[3]);
	check("mouse overflow: YD = 0", 0x00, r.oreg[4]);
}
{
	const r = intback("mouse", null, 6);
	checkBytes("mouse at rest: flags/XD/YD at 0", [0xF1, 0xE3, 0x00, 0x00, 0x00, 0xF0], r.oreg);
	check("mouse at rest: faithful SR = 0xC0", 0xC0, r.sr);
}

// ============================================================================
//   Virtua Gun / Stunner (ID 0x25, 5 bytes) - light gun  //?
// ============================================================================
{
	// Trigger (bit4) + Start (bit5) pressed -> flags 0xFF & ~0x30 = 0xCF.
	// X = 0x1234, Y = 0x00AB (big-endian: Xhi Xlo Yhi Ylo).
	const r = intback("gun", (b) => {
		b.gun1trigger = true; b.gun1start = true; b.gun1x = 0x1234; b.gun1y = 0x00AB;
	}, 8);
	checkBytes("gun: F1 25 [flags Xhi Xlo Yhi Ylo] F0",
		[0xF1, 0x25, 0xCF, 0x12, 0x34, 0x00, 0xAB, 0xF0], r.oreg);
	check("gun: port 2 header lands in OREG7", 0xF0, r.oreg[7]);
	check("gun: SR = 0xC0 with the trigger pulled", 0xC0, r.sr);
}
{
	// Trigger only -> flags 0xEF.
	const r = intback("gun", (b) => { b.gun1trigger = true; }, 8);
	check("gun: trigger only -> flags 0xEF (bit4 at 0)", 0xEF, r.oreg[2]);
}
{
	// At rest (no trigger and no start), even with a position, it does not count as input.
	const r = intback("gun", (b) => { b.gun1x = 0x100; }, 8);
	check("gun at rest: flags = 0xFF", 0xFF, r.oreg[2]);
	check("gun at rest: faithful SR = 0xC0 (PDL does not depend on a button being pressed)", 0xC0, r.sr);
}

// ============================================================================
//   The default is still the digital pad (do not break the historical report)
// ============================================================================
{
	const fresh = new Bus();
	check("default: peripheral1 starts as 'pad'", "pad", fresh.peripheral1);
	fresh._intbackPeripheral();
	checkBytes("default: _intbackPeripheral gives F1 02 FF FF F0",
		[0xF1, 0x02, 0xFF, 0xFF, 0xF0],
		[0, 1, 2, 3, 4].map((n) => fresh.smpc[0x21 + n * 2]));
}

// ============================================================================
//   SCU: the mask of the A-Bus interrupts is BIT 15 of IMS
// ============================================================================
// IST records the CD block on bit 16 (external 0), but IMS ends at
// bit 15, which masks ALL the A-Bus interrupts.
// The historical bug: (1 << 16) was tested against IMS -> the CD IRQ was delivered
// ALWAYS, even if the game had it masked (the typical IMS 0xBFFF covers it).
{
	const b = new Bus();
	const irqs = [];
	b.cpuMaster = { cycles: 0, requestInterrupt: (n, v) => irqs.push([n, v]), requestNmi: () => {} };

	b.writeLong(0x05FE00A0, 0x00008000);   // IMS: only bit 15 (A-Bus masked)
	b._scuIrq(16, 0x7, 0x50);                 // the CD block asserts its interrupt
	check("A-Bus: with IMS bit 15 set the CD IRQ is NOT delivered", 0, irqs.length);
	check("A-Bus: ...it stays latched as pending (bit 16)", true, (b.scuPending & (1 << 16)) !== 0);
	check("A-Bus: ...and IST still records it (bit 16)", true, (b.readLong(0x05FE00A4) & (1 << 16)) !== 0);

	b.writeLong(0x05FE00A0, 0x00000000);   // unmask: the pending one goes out now
	check("A-Bus: clearing bit 15 delivers the pending one", 1, irqs.length);
	check("A-Bus: ...with level 7", 0x7, irqs.length ? irqs[0][0] : -1);
	check("A-Bus: ...and vector 0x50", 0x50, irqs.length ? irqs[0][1] : -1);
	check("A-Bus: ...and it is no longer pending", 0, b.scuPending & (1 << 16));

	irqs.length = 0;
	b._scuIrq(16, 0x7, 0x50);
	check("A-Bus: without a mask it is delivered directly", 1, irqs.length);

	// Bit 15 covers ONLY the A-Bus ones: an internal one with its own bit clear still goes through.
	b.writeLong(0x05FE00A0, 0x00008000);
	irqs.length = 0;
	b._scuIrq(0, 0xF, 0x40);                  // VBlank-IN (bit 0, unmasked)
	check("A-Bus: bit 15 does NOT cover the internal ones (VBlank goes through)", 1, irqs.length);
}

// ============================================================================
//   SMPC direct mode: the digital pad through PDR/DDR/IOSEL
// ============================================================================
// The pad is a combinational multiplexer of the (TH,TR) pair; TL reads a fixed 1; phases
// 1-2 form the Mega Drive ID (Saturn pad = 0xB). Bits with DDR=1 read what was written.
{
	const b = new Bus();
	b.pad1a = 0xFF & ~0x08;   // Start pressed (active-low), the rest released
	b.pad1b = 0xFF;
	const PDR1 = 0x00100075, PDR2 = 0x00100077, DDR1 = 0x00100079, DDR2 = 0x0010007B, IOSEL = 0x0010007D;

	b.writeByte(DDR1, 0x60);    // TH and TR as outputs
	b.writeByte(IOSEL, 0x01);   // port 1 in SH-2 direct mode

	b.writeByte(PDR1, 0x60);    // TH=1 TR=1
	check("direct: 1st phase (TH1 TR1) = L,1,0,0 -> 0x7C", 0x7C, b.readByte(PDR1));
	b.writeByte(PDR1, 0x20);    // TH=0 TR=1
	check("direct: 2nd phase (TH0 TR1) = D-pad released -> 0x3F", 0x3F, b.readByte(PDR1));
	b.writeByte(PDR1, 0x40);    // TH=1 TR=0
	check("direct: 3rd phase (TH1 TR0) = Start pressed -> 0x57", 0x57, b.readByte(PDR1));
	b.writeByte(PDR1, 0x00);    // TH=0 TR=0
	check("direct: 4th phase (TH0 TR0) = R,X,Y,Z released -> 0x1F", 0x1F, b.readByte(PDR1));

	// Mega Drive ID with DDR=0x40 (only TH as output; TR stays on pull-up = 1):
	// ID3=R|L and ID2=D|U with TH=1; ID1=R|L and ID0=D|U with TH=0. Saturn pad: 1100/1111 = 0xB.
	b.writeByte(DDR1, 0x40);
	b.writeByte(PDR1, 0x40);
	const withTh1 = b.readByte(PDR1);
	b.writeByte(PDR1, 0x00);
	const withTh0 = b.readByte(PDR1);
	const id = ((((withTh1 >> 3) | (withTh1 >> 2)) & 1) << 3) | ((((withTh1 >> 1) | withTh1) & 1) << 2) |
	           ((((withTh0 >> 3) | (withTh0 >> 2)) & 1) << 1) | (((withTh0 >> 1) | withTh0) & 1);
	check("direct: Mega Drive ID of the Saturn pad = 0xB", 0xB, id);

	// Port 2 with no peripheral: all inputs read 1 (that is where ID 0xF would come from).
	b.writeByte(DDR2, 0x60);
	b.writeByte(IOSEL, 0x03);
	b.writeByte(PDR2, 0x60);
	check("direct: empty port 2 reads the pull-ups -> 0x7F", 0x7F, b.readByte(PDR2));

	// IOSEL=0 (SMPC mode): the game does not drive the bus; the inputs stay on pull-up.
	b.writeByte(IOSEL, 0x00);
	b.writeByte(PDR1, 0x00);
	check("direct: with IOSEL=0 the inputs read pull-up (not the pad)", 0x3F, b.readByte(PDR1));
}

// SCU DMA: a count of ZERO means the channel MAXIMUM, not "nothing". Regression test for the
// Sega Rally GRAY SKY (24-07-2026): the game loaded the whole Color RAM (4096 bytes
// = 2048 colors) through channel 1 with cnt=0 and nothing arrived. The two halves of the rule
// are needed together: the 12-bit masking turns a request for the exact maximum
// (0x1000) into 0, so without "0 = maximum" the full CRAM cannot be requested either.
{
	const b = new Bus();
	b.cpuMaster = { cycles: 0, requestInterrupt: () => {}, requestNmi: () => {} };
	check("DMA count: channel 0, zero = 1 MB",       0x100000, b._scuDmaCount(0, 0));
	check("DMA count: channel 0, 0x100000 -> 1 MB",  0x100000, b._scuDmaCount(0, 0x100000));
	check("DMA count: channel 0, normal value",      0x1234,   b._scuDmaCount(0, 0x1234));
	check("DMA count: channel 1, zero = 4 KB",       0x1000,   b._scuDmaCount(1, 0));
	check("DMA count: channel 1, 0x1000 -> 4 KB",    0x1000,   b._scuDmaCount(1, 0x1000));
	check("DMA count: channel 2, zero = 4 KB",       0x1000,   b._scuDmaCount(2, 0));
	check("DMA count: channel 1, normal value",      0x200,    b._scuDmaCount(1, 0x200));
	check("DMA count: channel 1, 0x1200 -> 0x200",   0x200,    b._scuDmaCount(1, 0x1200));

	// And the full path: a channel 1 DMA with cnt=0 moves the 4096 bytes to the CRAM.
	const SOURCE = 0x00200000;
	for(let i = 0; i < 0x1000; i++) b.wramLow[i] = (i * 7) & 0xFF;
	b.cram.fill(0);
	const reg = (off, val) => b._writeRegBE(b.scuRegs, off, val >>> 0, 4);
	reg(0x20, SOURCE); reg(0x24, 0x05F00000); reg(0x28, 0); reg(0x2C, 0x101); reg(0x34, 0x7);
	b._scuDma(1);
	let copied = 0;
	for(let i = 0; i < 0x1000; i++) if(b.cram[i] === b.wramLow[i]) copied++;
	check("DMA channel 1 with cnt=0 copies the 4096 bytes to the Color RAM", 0x1000, copied);
}

// --- SCU DMA with the count NOT ALIGNED to a long word ------------------------------------
// On hardware, if the start address and end address are not on long word
// boundaries, reads and writes are made in byte units. The loop advanced by 4 until it PASSED
// the count, so with 6 bytes requested it wrote 8: it stomped up to 3 bytes beyond the
// block. Measured with diag/scu-dma-alignment.mjs, Virtua Fighter 2 issues 875 transfers
// like that (34 % of its own), SF Alpha 74 and Sonic 3D 6.
{
	const b = new globalThis.Bus();
	b.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
	// Source in high work RAM, with a recognizable pattern.
	for(let i = 0; i < 16; i++) b.writeByte(0x06000000 + i, 0x11 * (i + 1));
	// Sentinels at the destination: if the DMA overshoots, it stomps them.
	for(let i = 0; i < 16; i++) b.writeByte(0x06001000 + i, 0xEE);

	b._scuDmaCopy(0x06000000, 4, 0x06001000, 4, 6);   // 6 bytes: one and a half long words

	check("unaligned DMA: copies the first long word whole", 0x11223344, b.readLong(0x06001000) >>> 0);
	check("unaligned DMA: copies the 5th byte", 0x55, b.readByte(0x06001004));
	check("unaligned DMA: copies the 6th byte", 0x66, b.readByte(0x06001005));
	check("unaligned DMA: does NOT stomp the 7th byte", 0xEE, b.readByte(0x06001006));
	check("unaligned DMA: does NOT stomp the 8th byte", 0xEE, b.readByte(0x06001007));

	// Same case through the word write path (incEsc = 2, typical toward VRAM).
	const c = new globalThis.Bus();
	c.connectCpu({ requestInterrupt: () => {}, reset: () => {} });
	for(let i = 0; i < 16; i++) c.writeByte(0x06000000 + i, 0x11 * (i + 1));
	for(let i = 0; i < 16; i++) c.writeByte(0x06001000 + i, 0xEE);
	c._scuDmaCopy(0x06000000, 4, 0x06001000, 2, 6);
	check("unaligned DMA (words): copies the first long word", 0x11223344, c.readLong(0x06001000) >>> 0);
	check("unaligned DMA (words): copies the tail word", 0x5566, c.readWord(0x06001004) & 0xFFFF);
	check("unaligned DMA (words): does NOT stomp what follows", 0xEE, c.readByte(0x06001006));
}

// ================================================================================
//   SCU DSP: the two behaviors of a later hardware correction (28-07-2026)
// ================================================================================
// The SCU DSP engine did not have A SINGLE test. These two pin down what the correction
// adds and the original register description lacks — which is exactly the kind of thing that gets lost
// in the next refactor if it is not written down as a test.
{
	// scu.js does `module.exports = ScuDspEngine` (the class directly, not a named
	// property), so through Node's interop it comes in .default.
	const ScuDspEngine = (await import("./scu.js")).default;
	const fresh = () => {
		const d = new ScuDspEngine();
		d.connectBus(() => 0, () => {});
		return d;
	};
	const PCP_E = 18, PCP_V = 19;
	// ENDI = command 0x0F ("End Commands") with bit 27 set. The opcode goes in
	// bits 31-28 of the microprogram; the rest of the instruction plays no part.
	const ENDI = ((0x0F << 28) | 0x8000000) >>> 0;

	// --- Reading the Program Control Port clears the V flag ---
	{
		const d = fresh();
		d.pcp = (d.pcp | (1 << PCP_V)) >>> 0;
		const read = d.readRegister(0x80);
		check("SCU DSP: reading the control port returns the V that WAS there", 1, (read >>> PCP_V) & 1);
		check("SCU DSP: and leaves it clear for the next read", 0, (d.pcp >>> PCP_V) & 1);
		check("SCU DSP: the second read already gives V=0", 0, (d.readRegister(0x80) >>> PCP_V) & 1);
	}

	// --- With E already at 1, ENDI does NOT issue the interrupt ---
	{
		const d = fresh();
		let warnings = 0;
		d.onFinish = () => { warnings++; };
		d.programRam[0] = ENDI;
		d.writeRegister(0x80, (1 << 16));      // EX = 1: starts the DSP
		d.execute(16);
		check("SCU DSP: with E at 0, ENDI DOES interrupt", 1, warnings);
		check("SCU DSP: and leaves E at 1", 1, (d.pcp >>> PCP_E) & 1);

		// Second run WITHOUT lowering E, which is the step software is required to take.
		d.pc = 0;
		d.writeRegister(0x80, (1 << 16));
		d.execute(16);
		check("SCU DSP: with E already at 1, ENDI does NOT interrupt again", 1, warnings);

		// And lowering E before starting, it interrupts again: it is the gate, not a dead latch.
		d.pc = 0;
		d.pcp = (d.pcp & ~(1 << PCP_E)) >>> 0;
		d.writeRegister(0x80, (1 << 16));
		d.execute(16);
		check("SCU DSP: lowering E before starting, it interrupts again", 2, warnings);
	}
}

// ============================================================================
//   WHICH SMPC COMMANDS ASK FOR AN INTERRUPT: ONLY INTBACK
// ============================================================================
// The SMPC's 16 commands fall into classes, and the class is
// defined by whether the command returns result parameters:
//   class B — commands that do not require command parameter settings and do not return
//             result parameters (except for OREG31): SSHON, SSHOFF, SNDON, SNDOFF, CDON,
//             CDOFF, RESENAB, RESDISA
//   class C — SETTIME, SETSMEM
//   class D — a command that requires command parameter setting, returns result parameters,
//             and REQUESTS SMPC INTERRUPTS when the result parameters are complete: INTBACK,
//             and it is the ONLY one in its class.
// That is: the end of a command other than INTBACK is detected by POLLING SF, not by interrupt.
//
// ⚠ THIS IS NOT COSMETIC, and that is why it has a test: sending the extra IRQ HUNG Daytona USA.
// The game writes COMREG=RESDISA and then spins reading SF (disassembled at 0x0601e300);
// the extra interrupt entered the INTBACK handler, which parses the OREGs —where the
// peripheral data from the previous delivery is left— and queued a peripheral nobody asked for. The
// parser was left with "1 pending" and none to process, spinning with IMASK=15, that is with the
// VBlank-OUT that would unstick it covered by its own mask. Measured with
// diag/intback-cadence.mjs: 2 IRQ 0x47 per frame in the healthy frames, 3 and 4 in the ones where the
// game also sent RESENAB/RESDISA.
{
	const b2 = new Bus();
	let irqs = 0;
	b2.cpuMaster = { cycles: 0, requestInterrupt: () => {}, requestNmi: () => {} };
	const origIrq = b2._scuIrq.bind(b2);
	b2._scuIrq = function(bit, level, vec){ if(vec === 0x47) irqs++; return origIrq(bit, level, vec); };
	// The SCU starts with IMS at its reset value (everything masked except what the
	// software opens), so the System Manager source is unmasked to be able to count it.
	b2.writeLong(0x25FE00A0, 0x00000000);

	// The command is issued and given more than enough time to finish.
	const emit = (cmd) => {
		irqs = 0;
		b2.writeByte(0x0010001F, cmd);
		b2.smpcTick(1000000);
		return irqs;
	};

	check("SMPC: RESDISA (1AH, class B) does NOT ask for an interrupt", 0, emit(0x1A));
	check("SMPC: and it still lowers SF, which is how its end is detected", 0x00, b2.smpc[0x63]);
	check("SMPC: RESENAB (19H, class B) does NOT ask for an interrupt", 0, emit(0x19));
	check("SMPC: SNDON (06H, class B) does NOT ask for an interrupt", 0, emit(0x06));
	check("SMPC: SSHON (02H, class B) does NOT ask for an interrupt", 0, emit(0x02));
	check("SMPC: SETTIME (16H, class C) does NOT ask for an interrupt", 0, emit(0x16));

	// And the only one that DOES: INTBACK.
	b2.writeByte(0x00100001, 0x01);   // IREG0: status phase
	b2.writeByte(0x00100003, 0x00);   // IREG1: no peripherals
	check("SMPC: INTBACK (10H, class D) DOES ask for an interrupt", 1, emit(0x10));

	// The other side of the same protocol: the CONTINUE of an INTBACK session also asks for it,
	// because it is still INTBACK delivering its result parameters.
	const b3 = new Bus();
	let irqs3 = 0;
	b3.cpuMaster = { cycles: 0, requestInterrupt: () => {}, requestNmi: () => {} };
	const origIrq3 = b3._scuIrq.bind(b3);
	b3._scuIrq = function(bit, level, vec){ if(vec === 0x47) irqs3++; return origIrq3(bit, level, vec); };
	b3.writeLong(0x25FE00A0, 0x00000000);
	b3.writeByte(0x00100001, 0x01);   // status + pending peripherals
	b3.writeByte(0x00100003, 0x08);
	b3.writeByte(0x0010001F, 0x10);
	b3.smpcTick(1000000);
	irqs3 = 0;
	b3.writeByte(0x00100001, 0x80);   // CONTINUE: toggle of bit 7
	b3.smpcTick(1000000);
	check("SMPC: the INTBACK CONTINUE also asks for an interrupt", 1, irqs3);
}

// ============================================================================
//   THE VISIBLE LINES COME FROM VRESO, NOT FROM A CONSTANT
// ============================================================================
// TVMD bits 5-4: 00 = 224 lines (NTSC or PAL format TV) / 01 = 240 lines (NTSC or PAL
// format TV) / 10 = 256 lines (PAL format TV) / 11 = not allowed.
// It matters because the scheduler schedules VBlank-OUT at `lines - linesVisible`: with 240 the
// V blank lasts 22 lines and not 38, i.e. a 16-line difference in the phase the
// software syncs with. This used to be the constant 224 for every mode.
{
	const b4 = new Bus();
	b4.cpuMaster = { cycles: 0, requestInterrupt: () => {}, requestNmi: () => {} };
	const tvmd = (v) => { b4.vdp2Regs[0x00] = (v >> 8) & 0xFF; b4.vdp2Regs[0x01] = v & 0xFF; };

	tvmd(0x0000); check("VDP2: VRESO=00 -> 224 visible lines", 224, b4.linesVisibleTv());
	tvmd(0x0010); check("VDP2: VRESO=01 -> 240 visible lines", 240, b4.linesVisibleTv());
	tvmd(0x0020); check("VDP2: VRESO=10 -> 256 visible lines", 256, b4.linesVisibleTv());
	// 11B is "Not Allowed": no height is invented, the default one is kept.
	tvmd(0x0030); check("VDP2: VRESO=11 (Not Allowed) -> 224 is kept", 224, b4.linesVisibleTv());

	// ★ AND DOUBLE-DENSITY DOES NOT DOUBLE IT. That x2 belongs to the resolution of the IMAGE (two woven
	// fields), not of the SCAN, and the scheduler counts FIELD lines. Mixing them up would put
	// the VBlank-OUT at `262 - 448`, i.e. negative. It is the mode of Touring and Daytona CCE
	// (TVMD = 0xC3), so it is not a theoretical case.
	tvmd(0x00C3);
	check("VDP2: in double-density the SCAN stays at 224 lines", 224, b4.linesVisibleTv());
	check("VDP2: and the IMAGE does measure 448 (tvGeometry, which is a different question)",
		448, b4.tvGeometry().height);
}

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
