/**
 *    Name:         vdp2.test.mjs
 *    Description:  Tests for the VDP2 TV status registers, which the bus handles:
 *                  TVSTAT (180004H), EXTEN (180002H) and the latched counters
 *                  HCNT (180008H) and VCNT (18000AH).
 *                  Run with: node vdp2.test.mjs
 *    Version:      0.1.0
 *    Created:      16-07-2026
 *    Modified:     16-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync } from "fs";
// bus.js and vdp2.js are browser scripts (global classes). We load them with eval
// because it is the project's own, trusted code; there is no external input.
eval(readFileSync("bus.js", "utf8") + "\nglobalThis.Bus=Bus;");
eval(readFileSync("vdp2.js", "utf8") + "\nglobalThis.VDP2=VDP2;");
eval(readFileSync("vdp1.js", "utf8") + "\nglobalThis.VDP1=VDP1;");

let passed = 0, failed = 0;
function check(name, expected, obtained)
{
	if(expected === obtained) passed++;
	else { failed++; console.log("  FAIL", name, "exp", expected, "got", obtained); }
}

// VDP2 TV status registers (base 0x05F80000 = the chip's 180000H).
const EXTEN  = 0x05F80002;
const TVSTAT = 0x05F80004;
const HCNT   = 0x05F80008;
const VCNT   = 0x05F8000A;

// Bus + a fake CPU: the H/V counters are DERIVED from its cycles, so by moving
// cpu.cycles we pick the beam position without emulating scanline by scanline.
function build()
{
	const bus = new globalThis.Bus();
	const cpu = { cycles: 0, requestInterrupt() {} };
	bus.connectCpu(cpu);
	return { bus, cpu };
}

// ---------------------------------------------------------------------------
// P3: TVSTAT bit 1 (ODD). In non-interlace mode it is always 1.
// ---------------------------------------------------------------------------
{
	const { bus } = build();
	check("TVSTAT: ODD=1 from the start (we run progressive)", 0x2, bus.readWord(TVSTAT) & 0x2);
	bus._applyRegionTvstat();
	check("TVSTAT: ODD=1 still set after applying the region", 0x2, bus.readWord(TVSTAT) & 0x2);
}

// ---------------------------------------------------------------------------
// P2 + P4: HCNT/VCNT are a LATCH, and reading EXTEN with EXLTEN=0 triggers it.
// ---------------------------------------------------------------------------

// Before this fix the final "return _readRegBE(vdp2Regs, ...)" caught 0x08 and 0x0A
// and they ALWAYS returned 0: any "while(VCNT != N)" hung forever.
{
	const { bus, cpu } = build();
	cpu.cycles = bus.cyclesPerLine * 10 + 100;   // line 10, 100 cycles in
	bus.readWord(EXTEN);                          // EXLTEN=0 -> latches
	check("VCNT returns the latched line, not 0", 10, bus.readWord(VCNT));
	// In normal resolution the register is shifted left by one bit
	// (HCT9~HCT1 = H8~H0, HCT0 invalid) -> register = dot << 1.
	// 100/1708 of a line * 427 dots = 25 -> 50.
	check("HCNT returns the latched dot shifted by one bit", 50, bus.readWord(HCNT));
}

// It is a LATCH, not a live counter: unless a new latch is requested, the value does not move.
// Yabause and Mednafen behave the same way.
{
	const { bus, cpu } = build();
	cpu.cycles = bus.cyclesPerLine * 10;
	bus.readWord(EXTEN);
	check("precondition: VCNT latched at line 10", 10, bus.readWord(VCNT));
	cpu.cycles = bus.cyclesPerLine * 40;
	check("VCNT does not move on its own: it is a latch, not a live counter", 10, bus.readWord(VCNT));
	bus.readWord(EXTEN);
	check("VCNT is refreshed when latched again", 40, bus.readWord(VCNT));
}

// VCNT is the line WITHIN the frame: it has to wrap around, not grow forever.
{
	const { bus, cpu } = build();
	cpu.cycles = bus.cyclesPerLine * (bus.linesPerFrame * 3 + 7);   // 3 frames + 7 lines
	bus.readWord(EXTEN);
	check("VCNT wraps per frame (it is not an absolute counter)", 7, bus.readWord(VCNT));
}

// With EXLTEN=1 the latch is triggered by an external signal (light gun), which we do
// not emulate: reading EXTEN must no longer latch anything.
{
	const { bus, cpu } = build();
	cpu.cycles = bus.cyclesPerLine * 10;
	bus.readWord(EXTEN);
	bus.writeWord(EXTEN, 0x0200);              // EXLTEN=1
	cpu.cycles = bus.cyclesPerLine * 40;
	bus.readWord(EXTEN);
	check("with EXLTEN=1 reading EXTEN does NOT latch", 10, bus.readWord(VCNT));
}

// ---------------------------------------------------------------------------
// P4: EXLTFG (bit 9) / EXSYFG (bit 8) are cleared when TVSTAT is read.
// ---------------------------------------------------------------------------
{
	const { bus } = build();
	check("EXLTFG starts at 0", 0, bus.readWord(TVSTAT) & 0x200);
	bus.readWord(EXTEN);
	check("reading EXTEN sets EXLTFG", 0x200, bus.readWord(TVSTAT) & 0x200);
}

// The flags clear to 0 when the screen status register is read out: the FIRST read still
// returns the flag set, the second one no longer does.
{
	const { bus } = build();
	bus.readWord(EXTEN);
	bus.tvstat |= 0x0100;                         // EXSYFG, as if it had synchronized
	const first = bus.readWord(TVSTAT);
	check("the TVSTAT read returns EXLTFG/EXSYFG set", 0x300, first & 0x300);
	check("...and clears them for the next read", 0, bus.readWord(TVSTAT) & 0x300);
}

// Clearing the flags must not take the register's other bits down with them.
{
	const { bus } = build();
	bus.readWord(EXTEN);
	bus.readWord(TVSTAT);
	check("clearing EXLTFG does not touch ODD", 0x2, bus.readWord(TVSTAT) & 0x2);
}

// ---------------------------------------------------------------------------
// P2: RESOLUTION. Width/height are set by TVMD (180000H) and they were HARDCODED to
// 320x224. In TVMD, HRESO is bits 2-0 and VRESO is bits 5-4.
// ---------------------------------------------------------------------------
const TVMD = 0x05F80000;

// DISP (bit 15) set so that configFromRegisters() does not return null.
function buildVdp2(hreso, vreso)
{
	const bus = new globalThis.Bus();
	bus.connectCpu({ cycles: 0, requestInterrupt() {} });
	const vdp2 = new globalThis.VDP2(bus);
	bus.writeWord(TVMD, 0x8000 | ((vreso & 0x3) << 4) | (hreso & 0x7));
	return { bus, vdp2 };
}

// THE P2 BUG, measured on SF Alpha: TVMD=0x8011. That is TWO fields, not one: HRESO=001
// -> 352 px AND VRESO=01 -> 240 lines. So the game runs at 352x240 and we were giving
// it 320x224: 32 columns AND 16 lines were being cut off.
{
	const { bus, vdp2 } = buildVdp2(1, 1);
	check("precondition: SF Alpha sets TVMD=0x8011", 0x8011, bus.readWord(TVMD));
	vdp2.render({});
	check("HRESO=001 -> 352 px (the bug: gave 320)", 352, vdp2.width);
	check("VRESO=01 -> 240 lines (the bug: gave 224)", 240, vdp2.height);
}

// The full HRESO table: 320, 352, 640, 704, 320, 352, 640, 704.
// Hi-res modes are rasterized at the REAL width since 25-07-2026. Until then they came out at
// half width as documented debt, and these checks expected half: Sega Touring Car and
// Daytona CCE ask for 704 and were getting 352.
{
	const expected = [ 320, 352, 640, 704, 320, 352, 640, 704 ];
	for(let h = 0; h < 8; h++)
	{
		const { vdp2 } = buildVdp2(h, 0);
		vdp2.render({});
		check("HRESO=" + h + " -> width " + expected[h], expected[h], vdp2.width);
	}
}

// VRESO: 00=224, 01=240, 10=256 (PAL). 11B is not allowed, and the height is not changed.
{
	const expected = [ 224, 240, 256, 224 ];
	for(let v = 0; v < 4; v++)
	{
		const { vdp2 } = buildVdp2(0, v);
		vdp2.render({});
		check("VRESO=" + v + " -> height " + expected[v], expected[v], vdp2.height);
	}
}

// The output framebuffer has to FOLLOW the size change: index.html does
// img.data.set(vdp2.fb) against an ImageData of vdp2.width x vdp2.height, and if the fb is
// not the same size that throws "source is too large" and the video stops.
{
	const { vdp2 } = buildVdp2(1, 1);              // 352x240
	vdp2.render({});
	check("the output fb follows the size (352*240*4)", 352 * 240 * 4, vdp2.fb.length);
	check("so does the alpha buffer (352*240)", 352 * 240, vdp2._alpha.length);
}

// And it has to keep changing IF the game changes mode on the fly.
{
	const { bus, vdp2 } = buildVdp2(0, 0);
	vdp2.render({});
	check("precondition: starts at 320x224", 320 * 224 * 4, vdp2.fb.length);
	bus.writeWord(TVMD, 0x8021);               // HRESO=1 (352), VRESO=2 (256)
	vdp2.render({});
	check("mode change on the fly: width", 352, vdp2.width);
	check("mode change on the fly: height", 256, vdp2.height);
	check("mode change on the fly: the fb follows", 352 * 256 * 4, vdp2.fb.length);
}

// The VDP1 is composited ON TOP of the VDP2 pixel by pixel in the same ImageData (index.html,
// drawTv()). If the two are not the same size, the sprites come out skewed diagonally.
{
	const { bus, vdp2 } = buildVdp2(1, 1);        // 352x240
	const vdp1 = new globalThis.VDP1(bus);
	vdp2.render({});
	vdp1.compose();
	check("the VDP1 follows the VDP2 in width (otherwise, diagonal sprites)", vdp2.width, vdp1.width);
	check("the VDP1 follows the VDP2 in height", vdp2.height, vdp1.height);
	check("and its output fb is the same size", vdp2.fb.length, vdp1.fb.length);
}

// ...and they have to stay in agreement in HI-RES, which is where they can fall out of sync.
// Both go to the REAL width (640), and the VDP1 -whose bank is 512 px wide- handles it by
// DOUBLING the pixel on output, not by cropping the screen. That is what the hardware does,
// and it is the half that has to be in place before giving the VDP2 its real width: without
// it, the read runs past the end of the 512 row and the sprites come out diagonal.
{
	const { bus, vdp2 } = buildVdp2(2, 0);        // HRESO=010 = 640 px (hi-res)
	const vdp1 = new globalThis.VDP1(bus);
	vdp2.render({});
	vdp1.compose();
	check("hi-res: the VDP2 rasterizes at the REAL width", 640, vdp2.width);
	check("hi-res: the VDP1 is the SAME size as the VDP2", vdp2.width, vdp1.width);
	check("hi-res: its bank is still 512 px (it does not grow)", 512, vdp1._fbWidth);
	// The proof that nothing is read out of range: the last pixel of the row maps to a
	// column that exists inside the bank.
	check("hi-res: the last column falls INSIDE the bank", true, ((vdp1.width - 1) >> 1) < vdp1._fbWidth);
	check("hi-res: the output fb is the real width", 640 * vdp2.height * 4, vdp1.fb.length);
}

// DOUBLE-DENSITY INTERLACE (LSMD=11B): the frame has TWICE the lines. It is the mode of
// Sega Touring Car and Daytona CCE (704x448), which were getting 352x224 -a quarter of the
// image- because neither the hi-res width nor the interlaced height were there.
{
	const { bus, vdp2 } = buildVdp2(3, 0);        // HRESO=011 = 704
	// LSMD in TVMD bits 7-6, on top of what buildVdp2 already set.
	const tvmd = (bus.vdp2Regs[0] << 8) | bus.vdp2Regs[1];
	bus.vdp2Regs[0] = ((tvmd | 0x00C0) >> 8) & 0xFF;
	bus.vdp2Regs[1] = (tvmd | 0x00C0) & 0xFF;
	vdp2.render({});
	check("double-density: 704 wide", 704, vdp2.width);
	check("double-density: 448 high (224 x 2)", 448, vdp2.height);
	// And without double-density, the same height goes back to 224.
	bus.vdp2Regs[0] = (tvmd >> 8) & 0xFF;
	bus.vdp2Regs[1] = tvmd & 0xFF;
	vdp2.render({});
	check("not interlaced: back to 224 high", 224, vdp2.height);
}

// With no mode change the framebuffer is NOT reallocated: it is ~280 KB and this runs every frame.
{
	const { vdp2 } = buildVdp2(0, 0);
	vdp2.render({});
	const before = vdp2.fb;
	vdp2.render({});
	check("with no mode change the fb is NOT reallocated", true, before === vdp2.fb);
}

// ---------------------------------------------------------------------------
// TIE-BREAK BETWEEN LAYERS AT EQUAL PRIORITY (the VDP2 priority function). On hardware,
// the higher the priority number, the higher the screen priority, but if they are equal,
// the priority is determined by a fixed order between the layers. When the priority
// number value is 0H, the layer is considered transparent.
//
// The fixed order in the usual case, from highest to lowest:
//   sprite > RBG0 > NBG0 > NBG1 > NBG2 > NBG3
// With two rotation scroll screens RBG1 takes NBG0's place (see the RBG1 tests below). The
// sprite does not enter these tests: its priority is resolved PER PIXEL by vdp1.js against
// vdp2.priorities.
//
// WHY THESE TESTS GO THROUGH THE REGISTERS AND DO NOT BUILD THE LAYERS BY HAND:
// the 'order' field is decided by _configNBG0/_configNBG1/../_configRBG0, not by render(). A
// cfg written by hand in the test would carry the test's 'order' and not the code's, and the
// mutation that has to be caught (swapping NBG0 and RBG0, which was the real bug) would survive.
// The sceneOfTest() fixtures use different priorities (5/3/2), so the
// tie-break is not triggered there and that scene says nothing about this.
// ---------------------------------------------------------------------------

// VDP2 register offsets (base 0x05F80000 = the chip's 180000H).
const REG = {
	TVMD: 0x00, RAMCTL: 0x0E, BGON: 0x20, CHCTLA: 0x28, CHCTLB: 0x2A,
	PLSZ: 0x3A, MPOFN: 0x3C, MPOFR: 0x3E,
	MPABN0: 0x40, MPCDN0: 0x42, MPABN1: 0x44, MPCDN1: 0x46,
	MPABN2: 0x48, MPCDN2: 0x4A, MPABN3: 0x4C, MPCDN3: 0x4E,
	MPABRA: 0x50, MPABRB: 0x60,
	ZMXN0: 0x78, ZMYN0: 0x7C, ZMXN1: 0x88, ZMYN1: 0x8C,
	RPMD: 0xB0, KTCTL: 0xB4, RPTAU: 0xBC, RPTAL: 0xBE,
	PRINA: 0xF8, PRINB: 0xFA, PRIR: 0xFC
};

// One layer per entry, each with its BGON bit, its character cell, its
// pattern-name table and a color of its own. The color identifies unambiguously which one won.
// 'dot' is the pixel's byte in the cell, which in 256 colors is the CRAM index.
const LAYERS = {
	NBG0: { bgon: 0x01, charNo: 2,  dot: 1, plane: 1, color: [248, 0, 0]   },   // red
	NBG1: { bgon: 0x02, charNo: 4,  dot: 2, plane: 2, color: [0, 248, 0]   },   // green
	NBG2: { bgon: 0x04, charNo: 6,  dot: 3, plane: 3, color: [0, 0, 248]   },   // blue
	NBG3: { bgon: 0x08, charNo: 8,  dot: 4, plane: 4, color: [248, 248, 0] },   // yellow
	RBG0: { bgon: 0x10, charNo: 10, dot: 5, plane: 5, color: [248, 0, 248] },   // magenta
	RBG1: { bgon: 0x20, charNo: 12, dot: 6, plane: 6, color: [0, 248, 248] }    // cyan
};

// Builds a VDP2 where each layer named in 'priorities' paints the WHOLE SCREEN in its
// color (a 256-color cell with no transparent dot at all), with the priority it is
// given. Everything comes from real registers: the layers are built by configFromRegisters().
// VRAM layout:  0x40+ character cells | 0x4000+ pattern-name tables (16 KB each)
//               0x3FF00 rotation table of parameter A (B's goes 80H higher)
function buildScene(priorities)
{
	const bus = new globalThis.Bus();
	bus.connectCpu({ cycles: 0, requestInterrupt() {} });
	const vdp2 = new globalThis.VDP2(bus);
	const w = (off, v) => bus.writeWord(0x05F80000 + off, v);
	const vram = bus.vdp2Vram, cram = bus.cram;

	for(const k in LAYERS)
	{
		const c = LAYERS[k];
		// CRAM in mode 0 (RGB555, one big-endian word per index).
		const v = ((c.color[2] >> 3) << 10) | ((c.color[1] >> 3) << 5) | (c.color[0] >> 3);
		cram[c.dot * 2] = (v >> 8) & 0xFF; cram[c.dot * 2 + 1] = v & 0xFF;

		// 8x8 256-color cell (64 bytes) all of the same dot: the layer has not a single
		// transparent pixel, so it paints everything and the tie-break is the only thing that decides.
		const char = c.charNo * 0x20;
		for(let p = 0; p < 64; p++) vram[char + p] = c.dot;

		// 2-word pattern-name: word0 = 0 (palette 0, no flip), word1 = charNo.
		const pn = c.plane * 0x4000;
		for(let cy = 0; cy < 64; cy++) for(let cx = 0; cx < 64; cx++)
		{
			const a = pn + (cy * 64 + cx) * 4;
			vram[a] = 0; vram[a + 1] = 0;
			vram[a + 2] = (c.charNo >> 8) & 0xFF; vram[a + 3] = c.charNo & 0xFF;
		}
	}

	// IDENTITY rotation parameter table: maps the screen 1:1 onto the plane,
	// so that RBG0/RBG1 paint just like an NBG and the only difference is the tie-break.
	// The offsets come from _readTableRotation(); 0x10000 = 1.0 in 16.16 fixed point.
	const eL = (a, v) => {
		vram[a] = (v >>> 24) & 0xFF; vram[a + 1] = (v >>> 16) & 0xFF;
		vram[a + 2] = (v >>> 8) & 0xFF; vram[a + 3] = v & 0xFF;
	};
	for(const base of [ 0x3FF00, 0x3FF80 ])
	{
		eL(base + 16, 0x10000);   // deltaYst = 1: one plane line per screen line
		eL(base + 20, 0x10000);   // deltaX   = 1: one plane pixel per screen pixel
		eL(base + 28, 0x10000);   // A = 1
		eL(base + 44, 0x10000);   // E = 1
		eL(base + 76, 0x10000);   // kx = 1
		eL(base + 80, 0x10000);   // ky = 1
	}

	w(REG.TVMD, 0x8000);            // DISP=1, HRESO=0, VRESO=0 -> 320x224
	w(REG.RAMCTL, 0x0000);          // CRMD=0: CRAM in RGB555
	w(REG.CHCTLA, 0x1010);          // N0CHCN=1 and N1CHCN=1 (256 colors), no bitmap, 8x8 cells
	w(REG.CHCTLB, 0x1022);          // N2CHCN=1, N3CHCN=1, R0CHCN=1 (256 colors), no bitmap
	w(REG.PLSZ, 0x0000);            // 1x1-page planes; screen-over = repeat
	w(REG.MPOFN, 0x0000); w(REG.MPOFR, 0x0000);
	w(REG.ZMXN0, 0x0001); w(REG.ZMYN0, 0x0001);   // zoom 1.0 (3 integer bits + 8 of fraction)
	w(REG.ZMXN1, 0x0001); w(REG.ZMYN1, 0x0001);
	w(REG.RPMD, 0x0000);            // RBG0 with parameter A
	w(REG.KTCTL, 0x0000);           // no coefficient table
	w(REG.RPTAU, 0x0001); w(REG.RPTAL, 0xFF80);   // (0x1FF80 << 1) = 0x3FF00

	// Map: each layer's planes all point to its own pattern-name table.
	const pl = (k) => (LAYERS[k].plane << 8) | LAYERS[k].plane;
	w(REG.MPABN0, pl("NBG0")); w(REG.MPCDN0, pl("NBG0"));
	w(REG.MPABN1, pl("NBG1")); w(REG.MPCDN1, pl("NBG1"));
	w(REG.MPABN2, pl("NBG2")); w(REG.MPCDN2, pl("NBG2"));
	w(REG.MPABN3, pl("NBG3")); w(REG.MPCDN3, pl("NBG3"));
	for(let k = 0; k < 8; k++)                     // 16 planes per rotated background
	{
		w(REG.MPABRA + k * 2, pl("RBG0"));
		w(REG.MPABRB + k * 2, pl("RBG1"));
	}

	// BGON + priorities. RBG1 shares NBG0's priority register (N0PRIN).
	let bgon = 0, prina = 0, prinb = 0, prir = 0;
	for(const k in priorities)
	{
		bgon |= LAYERS[k].bgon;
		const p = priorities[k] & 0x7;
		if(k === "NBG0" || k === "RBG1") prina |= p;         // PRINA bits 2-0
		else if(k === "NBG1") prina |= p << 8;               // PRINA bits 10-8
		else if(k === "NBG2") prinb |= p;                    // PRINB bits 2-0
		else if(k === "NBG3") prinb |= p << 8;               // PRINB bits 10-8
		else if(k === "RBG0") prir |= p;                     // PRIR bits 2-0
	}
	w(REG.BGON, bgon); w(REG.PRINA, prina); w(REG.PRINB, prinb); w(REG.PRIR, prir);
	return { bus, vdp2 };
}

// Renders from the registers and returns the NAME of the layer left visible at
// (i,j), or "backdrop" if none was left.
function layerVisible(vdp2, i, j)
{
	vdp2.render(vdp2.configFromRegisters());
	const o = (j * vdp2.width + i) * 4;
	const rgb = [ vdp2.fb[o], vdp2.fb[o + 1], vdp2.fb[o + 2] ];
	for(const k in LAYERS)
	{
		const c = LAYERS[k].color;
		if(c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]) return k;
	}
	return "backdrop(" + rgb + ")";
}

// Fixture precondition: each layer ALONE has to paint its own color. If this
// fails, the tie-break tests below would not be measuring what they claim to measure.
{
	for(const k in LAYERS)
	{
		const { vdp2 } = buildScene({ [k]: 4 });
		check("precondition: " + k + " alone paints its own color", k, layerVisible(vdp2, 10, 10));
	}
}

// THE PAIR THAT WAS SWAPPED. At equal priority RBG0 goes IN FRONT of NBG0 (tie order:
// sprite / RBG0 / NBG0 / ...). This is the test that the 17-07-2026 fix was missing.
{
	const { vdp2 } = buildScene({ NBG0: 4, RBG0: 4 });
	check("equal priority: RBG0 beats NBG0 (hardware tie order)", "RBG0", layerVisible(vdp2, 10, 10));
}

// The tie-order chain, pair by pair. CAREFUL: configFromRegisters() stacks NBG0, NBG1, NBG2,
// NBG3, RBG0 — that is, for the NBGs the stacking order is almost the REVERSE of the
// tie order. Since Array.sort is stable, without the tie-break the LAST one stacked (the
// lowest in the tie order) would always win: each of these pairs fails if the tie-break is missing.
{
	const pairs = [ [ "NBG0", "NBG1" ], [ "NBG1", "NBG2" ], [ "NBG2", "NBG3" ],
	                [ "NBG0", "NBG3" ], [ "NBG1", "NBG3" ] ];
	for(const [ height, low ] of pairs)
	{
		const { vdp2 } = buildScene({ [height]: 4, [low]: 4 });
		check("equal priority: " + height + " beats " + low, height, layerVisible(vdp2, 10, 10));
	}
}

// The WHOLE chain: all of them tie and the top one is removed each time. It walks the
// usual-case tie order from top to bottom (the sprite is left out: its priority is
// PER PIXEL and vdp1.js resolves it against vdp2.priorities).
{
	const chain = [ "RBG0", "NBG0", "NBG1", "NBG2", "NBG3" ];
	for(let n = 0; n < chain.length; n++)
	{
		const prio = {};
		for(const k of chain.slice(n)) prio[k] = 3;        // ALL with the same priority
		const { vdp2 } = buildScene(prio);
		check("tie of [" + chain.slice(n).join(" ") + "] -> winner " + chain[n],
		      chain[n], layerVisible(vdp2, 10, 10));
	}
}

// RBG1 TAKES NBG0's PLACE in the tie order (the order when two rotation scroll screens
// are displayed: sprite / RBG0 / RBG1 / - / - / -). It shares NBG0's registers, so
// the two never coexist: BGON bit5 picks which of the two is drawn.
{
	const { vdp2 } = buildScene({ RBG1: 4, RBG0: 4 });
	check("equal priority: RBG0 beats RBG1 (order with 2 rotation screens)", "RBG0", layerVisible(vdp2, 10, 10));
}
{
	const { vdp2 } = buildScene({ RBG1: 4, NBG1: 4 });
	check("equal priority: RBG1 beats NBG1 (RBG1 takes NBG0's place)", "RBG1", layerVisible(vdp2, 10, 10));
}

// PRIORITY overrides the tie-break: 'order' only comes in when the priority ties.
// Without this test, sorting by 'order' first (or only by 'order') would go unnoticed.
{
	const { vdp2 } = buildScene({ RBG0: 2, NBG3: 5 });
	check("priority wins: NBG3 with priority 5 beats RBG0 with 2", "NBG3", layerVisible(vdp2, 10, 10));
}

// A priority number value of 0H is considered transparent: a layer
// with priority 0 is not drawn even when it is the only one.
{
	const { vdp2 } = buildScene({ NBG0: 0 });
	check("priority 0 = transparent: NBG0 is not drawn", "backdrop(0,0,0)", layerVisible(vdp2, 10, 10));
}

// The tie order read straight from the 'order' field that configFromRegisters() builds. It is
// the same rule as above but without going through the rasterizer: if someone rewrites the
// compositor, this test still pins the order to the hardware's.
{
	const { vdp2 } = buildScene({ NBG0: 1, NBG1: 1, NBG2: 1, NBG3: 1, RBG0: 1 });
	const [ n0, n1, n2, n3, r0 ] = vdp2.configFromRegisters().layers.map(c => c.order);
	check("tie order in 'order': RBG0 > NBG0", true, r0 > n0);
	check("tie order in 'order': NBG0 > NBG1", true, n0 > n1);
	check("tie order in 'order': NBG1 > NBG2", true, n1 > n2);
	check("tie order in 'order': NBG2 > NBG3", true, n2 > n3);
}

// The sceneOfTest() fixture had the SAME swapped constants as the original bug
// (NBG0=4, RBG0=3). It did not show because it uses different priorities (5/3/2) and the
// tie-break never triggers there, but it was an old copy of the bug waiting for someone to tie
// two layers in that scene.
{
	const { vdp2 } = buildScene({});
	const [ n0, n1, r0 ] = vdp2.sceneOfTest().layers.map(c => c.order);
	check("sceneOfTest: RBG0 has a higher 'order' than NBG0 (same as the hardware tie order)", true, r0 > n0);
	check("sceneOfTest: NBG0 has a higher 'order' than NBG1", true, n0 > n1);
}

// ---------------------------------------------------------------------------
// LINE COLOR SCREEN (LNCL). On hardware, the line color screen has no priority number
// register: it is forcibly inserted as the second image in the area where the screen it is
// enabled for is the top image, and color calculation is performed between the two.
// What the tests below pin down, in order: LNCLEN is per layer; the table holds CRAM
// addresses, not RGB; LCCLMD picks one color for the whole screen or one per line; the
// CRAM address is masked according to the CRAM mode; the top layer's CC enable governs
// the insertion; with CCRTMD the ratio comes from LCCCRT (and BKCCRT for the back screen);
// and the table is not even read when no layer asks for it.
//
// The LNCL is NOT one more layer: it has no priority and only exists as the SECOND IMAGE of
// color calculation. That is why these tests look at the color that COMES OUT of the blend and
// not at "who won", which is what the priority tests above look at.
// ---------------------------------------------------------------------------

const REGL = {
	LCTAU: 0xA8, LCTAL: 0xAA, BKTAU: 0xAC, BKTAL: 0xAE,
	LNCLEN: 0xE8, CCCTL: 0xEC, CCRNA: 0x108, CCRLB: 0x10E
};

// Line color scene: NBG0 (red 248,0,0) over a backdrop [0,128,128], with the line color
// table at VRAM 0x30000 and the LNCL colors at CRAM 8-10.
// The backdrop NOT being black is on purpose: it is what the compositor would use as the second
// image if the line color were not inserted, so the output color tells the two apart.
// CCMD=1 (add) by default because the add is EXACT (no ratio, no rounding) and lets us read
// from the final color, unambiguously, which one was used as the second image.
// On hardware, in add mode the top image and the second image are added as they are.
function buildLineColor(opts)
{
	opts = opts || {};
	const { bus, vdp2 } = buildScene({ NBG0: 4 });
	const w = (off, v) => bus.writeWord(0x05F80000 + off, v);
	const vram = bus.vdp2Vram, cram = bus.cram;
	const putCram = (i, c) => {
		const v = ((c[2] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[0] >> 3);
		cram[(i * 2) & 0xFFF] = (v >> 8) & 0xFF; cram[(i * 2 + 1) & 0xFFF] = v & 0xFF;
	};

	// Backdrop at VRAM 0x38000. The back screen stores RGB555 DIRECTLY (blue 5 bits / green
	// 5 bits / red 5 bits), unlike the LNCL.
	const bd = (16 << 10) | (16 << 5) | 0;              // [0, 128, 128]
	vram[0x38000] = (bd >> 8) & 0xFF; vram[0x38001] = bd & 0xFF;
	w(REGL.BKTAU, 0x0001); w(REGL.BKTAL, 0xC000);      // (0x1C000) * 2 = 0x38000

	// LNCL colors: they go in CRAM because the table holds COLOR RAM ADDRESSES.
	putCram(8, [0, 0, 248]);                          // blue   -> line 0 / monochrome
	putCram(9, [0, 248, 0]);                          // green  -> line 1
	putCram(10, [248, 248, 248]);                     // white  -> line 2
	putCram(0x408, [0, 248, 0]);                      // only reachable with 11 bits (mode 1)

	// Line color table at VRAM 0x30000: one word per line with the CRAM address.
	const table = opts.table || [ 8, 9, 10 ];
	for(let j = 0; j < table.length; j++)
	{
		const a = 0x30000 + j * 2;
		vram[a] = (table[j] >> 8) & 0xFF; vram[a + 1] = table[j] & 0xFF;
	}
	// LCTA: line color screen table start address = (19-bit line color screen table
	// address register value) x 2H -> 0x18000 * 2 = 0x30000.
	// LCCLMD (LCTAU bit15): 0 = monochrome, 1 = specified for each line.
	w(REGL.LCTAU, (opts.perLine ? 0x8000 : 0) | 0x0001);
	w(REGL.LCTAL, 0x8000);

	if(opts.ramctl !== undefined) w(REG.RAMCTL, opts.ramctl);
	w(REGL.LNCLEN, (opts.lnclen === undefined) ? 0x01 : opts.lnclen);    // N0LCEN
	w(REGL.CCCTL, (opts.ccctl === undefined) ? 0x0101 : opts.ccctl);     // CCMD=1 + N0CCEN
	w(REGL.CCRNA, opts.ccrna || 0);
	w(REGL.CCRLB, opts.ccrlb || 0);
	return { bus, vdp2, w };
}

// Renders from the registers and returns pixel (i,j) as "r,g,b".
function px(vdp2, i, j)
{
	vdp2.render(vdp2.configFromRegisters());
	const o = (j * vdp2.width + i) * 4;
	return vdp2.fb[o] + "," + vdp2.fb[o + 1] + "," + vdp2.fb[o + 2];
}

// THE BASE TEST: with N0LCEN the second image is the line color and NOT the backdrop.
// red(248,0,0) + blue(0,0,248) = 248,0,248 | red + backdrop(0,128,128) = 248,128,128
{
	const { vdp2 } = buildLineColor({ lnclen: 0x00 });
	check("without LNCLEN: NBG0 blends with the backdrop", "248,128,128", px(vdp2, 10, 0));
}
{
	const { vdp2 } = buildLineColor({ lnclen: 0x01 });
	check("with N0LCEN: NBG0 blends with the LINE COLOR, not with the backdrop",
	      "248,0,248", px(vdp2, 10, 0));
}

// LNCLEN is PER LAYER: with another layer's bit set the table is built anyway, but NBG0
// must not see the line color.
{
	const { vdp2 } = buildLineColor({ lnclen: 0x02 });   // N1LCEN, and NBG1 is not even enabled
	check("LNCLEN is per layer: with N1LCEN, NBG0 still gets the backdrop",
	      "248,128,128", px(vdp2, 10, 0));
}

// THE TABLE HOLDS COLOR RAM ADDRESSES, NOT RGB COLORS: each entry stores the color RAM
// address of the color used on that line. That is THE difference from the back screen, which
// does store RGB directly. The entry is 8: as a CRAM index it gives blue (248,0,248); read
// as if it were an RGB555 word it would give (64,0,0) and the result would be 255,0,0.
{
	const { vdp2 } = buildLineColor({ table: [ 8 ] });
	check("the LNCL table is a CRAM index, not an RGB555", "248,0,248", px(vdp2, 10, 0));
}

// LCCLMD=0: monochrome, the data at the beginning of the table is used for the entire
// screen -> every line uses entry 0.
{
	const { vdp2 } = buildLineColor({ perLine: false });
	check("LCCLMD=0 (monochrome): line 0 uses entry 0", "248,0,248", px(vdp2, 10, 0));
	check("LCCLMD=0 (monochrome): line 2 ALSO uses entry 0", "248,0,248", px(vdp2, 10, 2));
}

// LCCLMD=1: one color per line. Entry j for line j.
// line 0 = CRAM8 blue -> 248,0,248 | line 1 = CRAM9 green -> 248,248,0
// line 2 = CRAM10 white -> 248+248 saturates to 255 -> 255,248,248
{
	const { vdp2 } = buildLineColor({ perLine: true });
	check("LCCLMD=1: line 0 takes entry 0", "248,0,248", px(vdp2, 10, 0));
	check("LCCLMD=1: line 1 takes entry 1", "248,248,0", px(vdp2, 10, 1));
	check("LCCLMD=1: line 2 takes entry 2 (and the add saturates)", "255,248,248", px(vdp2, 10, 2));
}

// CRAM ADDRESS MASK. The entry is an 11-bit color RAM address, and when the color RAM mode
// is mode 0 or mode 2 the most significant bit of the address is ignored. That squares
// with the CRAM modes: modes 0 and 2 have 1024 colors, mode 1 has
// 2048. The SAME entry (0x408) has to give different colors depending on the CRAM mode.
{
	const { vdp2 } = buildLineColor({ table: [ 0x408 ], ramctl: 0x0000 });   // CRMD=0
	check("CRAM mode 0: the LNCL address is cut to 10 bits (0x408 -> 8)",
	      "248,0,248", px(vdp2, 10, 0));
}
{
	const { vdp2 } = buildLineColor({ table: [ 0x408 ], ramctl: 0x1000 });   // CRMD=1
	check("CRAM mode 1: the LNCL address uses all 11 bits (0x408 -> 0x408)",
	      "248,248,0", px(vdp2, 10, 0));
}

// Bits 15-11 of the entry are ignored.
{
	const { vdp2 } = buildLineColor({ table: [ 0xF808 ] });
	check("bits 15-11 of the LNCL entry are ignored", "248,0,248", px(vdp2, 10, 0));
}

// THE LINE COLOR IS GOVERNED BY THE TOP LAYER'S CC ENABLE. In CCCTL, when color
// calculation is performed between the top image and the second image, it is controlled
// by the color calculation enable bit on the top image side. Without N0CCEN there is no
// color calculation, so the line color is not inserted and the pure layer comes out.
{
	const { vdp2 } = buildLineColor({ ccctl: 0x0100 });   // CCMD=1 but N0CCEN=0
	check("without N0CCEN there is no color calculation: the line color is not inserted",
	      "248,0,0", px(vdp2, 10, 0));
}

// CCRTMD=1: the color calculation ratio is specified on the second image side. With line color
// inserted the second image IS the LNCL, so the ratio comes from CCRLB's LCCCRT and NOT from
// the layer's register. When the ratio is specified on the second image side, the color
// calculation ratio value of not only the sprite and scroll screens but also of the line color
// screen and the back screen is used.
// The two cases below cross the ratios on purpose: if the code took the layer's ratio
// instead of the LNCL's, each would give the other one's result.
{
	// LCCCRT=0 -> "31:1": the top image takes everything and nothing is blended, even though the
	// layer's ratio (0x1F = "0:32") says otherwise.
	const { vdp2 } = buildLineColor({ ccctl: 0x0201, ccrna: 0x1F, ccrlb: 0x00 });
	check("CCRTMD: LCCCRT=0 (31:1) wins, not the layer's 0x1F", "248,0,0", px(vdp2, 10, 0));
}
{
	// LCCCRT=0x1F -> "0:32": the second image takes everything. The result is almost the pure line
	// color; the "almost" (248 -> 241) is the internal 6-bit alpha, (a6 << 2) + 3.
	const { vdp2 } = buildLineColor({ ccctl: 0x0201, ccrna: 0x00, ccrlb: 0x1F });
	check("CCRTMD: LCCCRT=0x1F (0:32) wins, not the layer's 0", "6,0,241", px(vdp2, 10, 0));
}

// CCRLB also carries the BACK SCREEN ratio (BKCCRT, bits 12-8), which is used when the
// back screen is the second image and CCRTMD is in charge. The back screen has no CC enable
// bit of its own: CCCTL only has N0-N3, R0, LC and SP.
{
	// BKCCRT=0 -> "31:1" -> no blending: the pure layer comes out (and it is the default, so
	// this is also the guarantee that CCRLB=0 changes nothing of what already worked).
	const { vdp2 } = buildLineColor({ lnclen: 0, ccctl: 0x0201, ccrlb: 0x0000 });
	check("CCRTMD + BKCCRT=0 (31:1): the back screen does not blend", "248,0,0", px(vdp2, 10, 0));
}
{
	// BKCCRT=0x1F -> "0:32" -> the back screen [0,128,128] wins.
	const { vdp2 } = buildLineColor({ lnclen: 0, ccctl: 0x0201, ccrlb: 0x1F00 });
	check("CCRTMD + BKCCRT=0x1F (0:32): the back screen wins", "6,124,124", px(vdp2, 10, 0));
}

// With no layer asking for it, the line color table is NOT EVEN READ (it is up to 'height'
// VRAM + CRAM reads per frame, and LNCLEN starts at 0 after reset).
{
	const { vdp2 } = buildLineColor({ lnclen: 0x00 });
	check("without LNCLEN the line color table is not built", null, vdp2.configFromRegisters().lineColor);
}
{
	const { vdp2 } = buildLineColor({ lnclen: 0x01 });
	check("with LNCLEN it is built", true, vdp2.configFromRegisters().lineColor !== null);
}

// SPLCEN (LNCLEN bit5, the sprite as top image) is NOT enough to build the table: the sprite
// layer is composited by vdp1.js after the VDP2, and from here nothing can be inserted beneath it.
// It is declared debt (see the //? in configFromRegisters()), not an oversight.
{
	const { vdp2 } = buildLineColor({ lnclen: 0x20 });
	check("SPLCEN alone does not build the table (it belongs to the VDP1: declared debt)",
	      null, vdp2.configFromRegisters().lineColor);
}

// ============================================================================
//   THE VRAM CYCLE PATTERN REGISTERS (29-07-2026)
// ============================================================================
// 180010H-18001EH, the last 8 gaps left by the register-map sweep. Layout: four 4-bit fields
// per register, T0 in the MOST significant bits of the low one and T4 in those of the high one.
// Values: 0-3 pattern name NBG0-3 · 4-7 character pattern · 8-11 ILLEGAL ·
// 12-13 vertical cell scroll · 14 CPU data access · 15 no access to VRAM at all.
{
	const w = (bus, off, v) => {
		bus.vdp2Regs[off] = (v >> 8) & 0xFF;
		bus.vdp2Regs[off + 1] = v & 0xFF;
	};
	const buildCyc = (opts = {}) => {
		const { bus } = build();
		const vdp2 = new globalThis.VDP2(bus);
		w(bus, 0x00, 0x8000 | (opts.hreso || 0));        // TVMD: DISP=1 + HRESO
		w(bus, 0x0E, opts.ramctl || 0);                  // RAMCTL: bits 8/9 = A/B partition
		w(bus, 0x10, 0xE123); w(bus, 0x12, 0x4567);      // CYCA0L / CYCA0U
		w(bus, 0x14, 0x89AB); w(bus, 0x16, 0xCDEF);      // CYCA1L / CYCA1U
		w(bus, 0x18, 0xFFFF); w(bus, 0x1A, 0xFFFF);      // CYCB0
		w(bus, 0x1C, 0xEEEE); w(bus, 0x1E, 0xEEEE);      // CYCB1
		return vdp2._readPatternsCycle();
	};

	// THE LAYOUT: T0 in bits 15-12. With CYCA0L = 0xE123 -> T0=E, T1=1, T2=2, T3=3.
	const p = buildCyc();
	check("cycle pattern: T0 comes from the MOST significant bits", 0xE, p.banks[0].timings[0]);
	check("cycle pattern: T1, T2, T3 in order", "123", p.banks[0].timings.slice(1, 4).join(""));
	check("cycle pattern: T4-T7 come from the HIGH register (0x4567)", "4567",
		p.banks[0].timings.slice(4, 8).join(""));
	check("cycle pattern: 8 timings per pixel in normal resolution", 8, p.timings);

	// WITHOUT PARTITION only A0 and B0 count. When the VDP2 VRAM is configured as two larger
	// banks instead of four smaller ones, the cycle pattern registers for banks A1 and B1
	// are ignored.
	check("without partition: only banks A0 and B0", 2, p.banks.length);
	check("and they are A0 and B0", "A0B0", p.banks.map(b => b.bank).join(""));

	// With the VRAM partitioned, A1 and B1 show up.
	const p2 = buildCyc({ ramctl: 0x300 });
	check("with the VRAM partitioned: all four banks", 4, p2.banks.length);
	check("and in order A0 A1 B0 B1", "A0A1B0B1", p2.banks.map(b => b.bank).join(""));

	// HI-RES: four memory cycles per pixel, not eight.
	const p3 = buildCyc({ hreso: 2 });
	check("★ in hi-res there are 4 timings per pixel, not 8", 4, p3.timings);
	check("and therefore 4 values per bank", 4, p3.banks[0].timings.length);

	// THE SUMMARY THAT DECIDES THE SH-2 WAIT: how many accesses per pixel are left for the CPU
	// (value 14 = 0xE). With the VRAM partitioned:
	//   A0 (E123 4567) -> one E (T0)         = 1
	//   A1 (89AB CDEF) -> one E (T6)         = 1
	//   B0 (FFFF FFFF) -> none               = 0
	//   B1 (EEEE EEEE) -> all eight          = 8
	// (This count was first written as 9 and the test failed: I had missed the E in
	// CYCA1U. The code was right.)
	check("★ cpuPerPixel counts the timings with value 14 (CPU data)", 10, p2.cpuPerPixel);
	// Without partition B1 does not count: only A0's is left.
	check("and without partition it counts only the active banks", 1, p.cpuPerPixel);

	// The ILLEGAL ones (8-11) are counted separately: CYCA1L = 0x89AB has 8, 9, A and B.
	check("★ the illegal values (8-11) are reported", 4, p2.illegal);
	check("and with A1 ignored they are not counted", 0, p.illegal);
}


console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
