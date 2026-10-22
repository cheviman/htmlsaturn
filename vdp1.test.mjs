/**
 *    Name:         vdp1.test.mjs
 *    Description:  Tests of the VDP1 frame cycle: the plot trigger by PTMR
 *                  (level with PTM=10B, EDGE with PTM=01B) and the status register
 *                  EDSR (CEF on drawing, BEF <- CEF on bank change). It runs
 *                  against the REAL Bus, not a stub: the PTMR edge is split
 *                  between the write hook of bus.js and the consumption in vdp1.js, and a
 *                  stub would hide exactly the half that broke.
 *                  Also: the system clipping (P1) and the PRIORITY of the sprite
 *                  layer against the VDP2 (P2, PRISA-D).
 *                  Run with: node vdp1.test.mjs
 *    Version:      0.2.0
 *    Created:      16-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync } from "fs";
// bus.js and vdp1.js are browser scripts (global classes). We load them with eval
// because it is the project's own trusted code; there is no external input.
eval(readFileSync("bus.js", "utf8") + "\nglobalThis.Bus=Bus;");
eval(readFileSync("vdp1.js", "utf8") + "\nglobalThis.VDP1=VDP1;");

let passed = 0, failed = 0;
function check(name, expected, obtained)
{
	if(expected === obtained) passed++;
	else { failed++; console.log("  FAIL", name, "exp", expected, "got", obtained); }
}

// VDP1 register addresses (100000H in the chip's address space).
const PTMR = 0x05D00004;
const FBCR = 0x05D00002;
const EDSR = 0x05D00010;
const LOPR = 0x05D00012;
const COPR = 0x05D00014;

// Minimal console for the VDP1: real bus + a fake CPU so that the Draw End's _scuIrq()
// has someone to request the interrupt from (it only needs requestInterrupt/cycles).
function build()
{
	const bus = new globalThis.Bus();
	bus.connectCpu({ cycles: 0, requestInterrupt() {} });
	const vdp1 = new globalThis.VDP1(bus);
	// Minimal but VALID command list: a single command with the END bit (0x8000).
	// Enough to walk the whole path of _drawCommands() -> CEF <- 1 ->
	// Draw End, which is what these tests look at.
	bus.vdp1Vram[0] = 0x80; bus.vdp1Vram[1] = 0x00;
	return { bus, vdp1 };
}

const read = (bus, addr) => bus.readWord(addr);

// Writes the CMDCTRL (word 0 of the command) of the table that starts at 'addr'.
const putCmd = (bus, addr, ctrl) =>
{
	bus.vdp1Vram[addr] = (ctrl >> 8) & 0xFF;
	bus.vdp1Vram[addr + 1] = ctrl & 0xFF;
};

// Counts the Sprite Draw End interrupts that the VDP1 requests from the bus.
function spyEndDraw(bus)
{
	// WRAPS, DOES NOT REPLACE. Replacing it left out what the bus really does when
	// drawing finishes —firing the DMA channels armed for end of drawing and requesting the
	// Sprite Draw End IRQ—, so a spy that overwrote the method turned off half of the
	// behavior the test was there to verify.
	// It is the same lesson as the diag/interleave-cost.mjs probe: wrap, do not remove.
	//
	// ⚠ This comment used to say "since the Draw End started taking as long as the list takes".
	// IT WAS FALSE: that shortcut was tried on 29-07-2026 and it BROKE (X-Men COTA 56% -> 16% of image),
	// it was reverted, and the reason was written down in bus.vdp1EndDraw. The comment outlived the
	// attempt. It is the kind of lie that a half-cleaned-up reverted change leaves behind.
	const count = { n: 0 };
	const orig = bus.vdp1EndDraw.bind(bus);
	bus.vdp1EndDraw = () => { count.n++; return orig(); };
	return count;
}

// Writes a whole command table (16 words of 16 bits) at 'addr'. 'fields' is an
// {offset: value} object with the command table offsets (CMDCTRL=0x00, CMDPMOD=0x04,
// CMDCOLR=0x06, CMDXA=0x0C, ... CMDYC=0x16).
function putTable(bus, addr, fields)
{
	for(let i = 0; i < 0x20; i++) bus.vdp1Vram[addr + i] = 0;
	for(const off of Object.keys(fields))
	{
		const o = addr + (+off);
		bus.vdp1Vram[o] = (fields[off] >> 8) & 0xFF;
		bus.vdp1Vram[o + 1] = fields[off] & 0xFF;
	}
}

// A pixel of the DRAW bank (bus.vdp1Fb, 512x256 at 16 bits big-endian).
const pixelFb = (bus, x, y) =>
{
	const o = (y * 512 + x) * 2;
	return ((bus.vdp1Fb[o] << 8) | bus.vdp1Fb[o + 1]) & 0xFFFF;
};

// ---------------------------------------------------------------------------
// P1: PTM=01B is an EDGE TRIGGER.
// ---------------------------------------------------------------------------

// The write -not the level- is what triggers it: drawing begins when the register
// is written.
{
	const { bus } = build();
	check("the plot request starts low", false, bus.vdp1PlotRequest);
	bus.writeWord(PTMR, 1);
	check("PTMR=1: the write raises the plot request", true, bus.vdp1PlotRequest);
}

// Yabause does COPR = 0 on the trigger write (vdp1.c case 0x4).
{
	const { bus } = build();
	bus.writeWord(COPR, 0x1234);
	bus.writeWord(PTMR, 1);
	check("PTMR=1: the write sets COPR to 0", 0, read(bus, COPR));
}

// PTMR=0 does NOT raise the request (it is the idle mode).
{
	const { bus } = build();
	bus.writeWord(PTMR, 0);
	check("PTMR=0: does not raise the plot request", false, bus.vdp1PlotRequest);
}

// The forbidden 11B has bit 0 set: Mednafen fires it anyway (md_vdp1.c:1226,
// if(value & 0x1)). Yabause, with its "if(val == 1)", misses it.
{
	const { bus } = build();
	bus.writeWord(PTMR, 3);
	check("PTMR=3 (forbidden 11B): fires anyway, bit 0 is what counts", true, bus.vdp1PlotRequest);
}

// THE P1 BUG: the game writes PTMR=1 and then PTMR=0. Sampling the LEVEL once
// per frame read 0 and the drawing was lost forever. The edge already happened:
// the drawing goes.
{
	const { bus, vdp1 } = build();
	bus.writeWord(PTMR, 1);
	bus.writeWord(PTMR, 0);
	vdp1.plot();
	check("PTMR=1 then 0 in the same frame: the drawing is NOT lost", true, vdp1.lastPlot);
}

// ...and one write = ONE drawing: the request is consumed.
{
	const { bus, vdp1 } = build();
	bus.writeWord(PTMR, 1);
	bus.writeWord(PTMR, 0);
	vdp1.plot();
	vdp1.plot();
	check("the edge is consumed: the next frame no longer draws", false, vdp1.lastPlot);
}

// No write, no drawing: PTM=00B sets an idling condition.
{
	const { bus, vdp1 } = build();
	bus.writeWord(PTMR, 0);
	vdp1.plot();
	vdp1.plot();
	check("PTMR=0 without a write: never draws", false, vdp1.lastPlot);
}

// PTM=10B is still a LEVEL: drawing begins automatically at the start of the
// frame, frame after frame and without rewriting the register.
{
	const { bus, vdp1 } = build();
	bus.writeWord(PTMR, 2);
	vdp1.plot();
	check("PTMR=2: draws on the first frame (level)", true, vdp1.lastPlot);
	vdp1.plot();
	check("PTMR=2: keeps drawing without rewriting the register", true, vdp1.lastPlot);
}

// ---------------------------------------------------------------------------
// P6: EDSR. CEF <- 0 when drawing starts; BEF <- CEF on bank change.
// ---------------------------------------------------------------------------

// With FBCR=0 (FCM=0) the bank is swapped on EVERY frame, without a manual request.
{
	const { bus, vdp1 } = build();
	bus.writeWord(FBCR, 0);
	bus.writeWord(PTMR, 2);

	// Frame 1: there was no previous swap, so there is no shift. The drawing sets CEF <- 1.
	vdp1.plot();
	check("the drawing leaves CEF=1 and it SURVIVES plot() (the CPU has to see it)",
		0x2, read(bus, EDSR));

	// Frame 2: the previous frame's swap shifts EDSR (BEF <- CEF) and this frame's
	// drawing sets CEF <- 1 again.
	vdp1.plot();
	check("BEF <- CEF on the bank change", 0x3, read(bus, EDSR));
}

// THE P6 BUG: with PTMR=0 the shift lived inside _drawCommands() and never
// ran -> EDSR frozen forever (measured in Sega Rally: stuck at 3).
{
	const { bus, vdp1 } = build();
	bus.writeWord(FBCR, 0);        // swap on every frame
	bus.writeWord(PTMR, 2);
	vdp1.plot(); vdp1.plot();   // leave EDSR at 3, like Rally
	check("precondition: EDSR at 3 (BEF=1, CEF=1)", 0x3, read(bus, EDSR));

	bus.writeWord(PTMR, 0);        // the game goes idle, like Rally at frame 394
	vdp1.plot();
	check("with PTMR=0 EDSR NO longer stays frozen: the bank change shifts it",
		0x1, read(bus, EDSR));
	vdp1.plot();
	check("with PTMR=0 EDSR keeps shifting down to 0", 0x0, read(bus, EDSR));
}

// No bank change, no shift: BEF is held until the next frame buffer
// change. With FBCR=2 (FCM=1) and no manual request the swap NEVER happens, so
// CEF can stay at 1 for many frames without BEF noticing.
{
	const { bus, vdp1 } = build();
	bus.writeWord(FBCR, 2);        // FCM=1 with no change request -> there is never a swap
	bus.writeWord(PTMR, 2);
	vdp1.plot();
	check("precondition: the drawing set CEF=1 and BEF is still 0", 0x2, read(bus, EDSR));
	vdp1.plot();
	vdp1.plot();
	check("without a bank change BEF does not move", 0x2, read(bus, EDSR));
}

// The start of drawing clears ONLY CEF and does not overwrite BEF (Mednafen StartDrawing()
// does EDSR &= ~0x2, not a shift). If the shift also ran here, this BEF=1
// just set by the bank change would go to 0.
{
	const { bus, vdp1 } = build();
	bus.writeWord(FBCR, 0);
	bus.writeWord(PTMR, 2);
	vdp1.plot();                   // CEF <- 1  (EDSR=2)
	vdp1.plot();                   // swap: BEF <- 1; drawing: CEF <- 0 and then 1
	check("the start of drawing does not overwrite BEF", 0x1, (read(bus, EDSR) >> 0) & 0x1);
}

// ---------------------------------------------------------------------------
// P1: SYSTEM CLIPPING (command type 0x9). The item said the corner was stored and
// "is NEVER used for clipping" (orphans.mjs flagged sysX1/sysY1). That fell apart against the
// hardware: the upper-left corner is FIXED
// at (0,0) and the command only carries CMDXC/CMDYC. So sysX1/sysY1 were not a
// lost clip, they were two constants (copied from Yabause's dead pair). The one that
// really clips is the lower-right corner, and these tests PROVE it.
// ---------------------------------------------------------------------------

// Polygon from (0,0)-(7,7) with the system clipping at (0,0)-(3,3): inside it is drawn,
// outside it is not. The lines of the rectangle defined by the upper-left coordinates
// (0,0) and the lower-right coordinates (XC, YC), and the inside of the rectangle, make up the
// drawing area.
{
	const { bus, vdp1 } = build();
	// FBCR=2 (FCM=1): no swap and no erase, so the draw bank stays inspectable.
	bus.writeWord(FBCR, 2);
	putTable(bus, 0x00, { 0x00: 0x0009, 0x14: 3, 0x16: 3 });          // system clip (0,0)-(3,3)
	putTable(bus, 0x20, { 0x00: 0x0004, 0x04: 0x0028, 0x06: 0x8FFF,  // RGB16 polygon, replace
		0x0C: 0, 0x0E: 0, 0x10: 7, 0x12: 0, 0x14: 7, 0x16: 7, 0x18: 0, 0x1A: 7 });
	putTable(bus, 0x40, { 0x00: 0x8000 });                            // END
	bus.writeWord(PTMR, 2);
	vdp1.plot();

	check("system clipping: the pixel INSIDE (2,2) is drawn", 0x8FFF, pixelFb(bus, 2, 2));
	check("system clipping: the edge (3,3) is drawn (it is inside)", 0x8FFF, pixelFb(bus, 3, 3));
	check("system clipping: the pixel OUTSIDE (5,5) is NOT drawn", 0x0000, pixelFb(bus, 5, 5));
	check("system clipping: (4,0) is outside in X", 0x0000, pixelFb(bus, 4, 0));
	check("system clipping: (0,4) is outside in Y", 0x0000, pixelFb(bus, 0, 4));
}

// Control: without a system clipping command the SAME polygon is drawn whole. If this
// test and the one above do not contradict each other, the clip is doing nothing.
{
	const { bus, vdp1 } = build();
	bus.writeWord(FBCR, 2);
	putTable(bus, 0x00, { 0x00: 0x0004, 0x04: 0x0028, 0x06: 0x8FFF,
		0x0C: 0, 0x0E: 0, 0x10: 7, 0x12: 0, 0x14: 7, 0x16: 7, 0x18: 0, 0x1A: 7 });
	putTable(bus, 0x20, { 0x00: 0x8000 });
	bus.writeWord(PTMR, 2);
	vdp1.plot();
	check("without system clipping the polygon reaches (5,5)", 0x8FFF, pixelFb(bus, 5, 5));
}

// ---------------------------------------------------------------------------
// P5: INVALID command (0xC-0xF). The hardware proves Yabause wrong: CEF is set by the
// FETCH OF THE END COMMAND, not by "the list was cut".
// ---------------------------------------------------------------------------

// When there is no draw end command in VRAM, or when there is one and it is defined
// by the jump mode such that it cannot be fetched, CEF remains '0'. An
// invalid command aborts the list BEFORE END: END is never fetched.
// Yabause does EDSR |= 2 + Vdp1DrawEnd() here (vdp1.c:507-510); Mednafen does not (only
// "DrawingActive = false; goto Breakout;"). We go with the hardware.
{
	const { bus, vdp1 } = build();
	const end = spyEndDraw(bus);
	putCmd(bus, 0x00, 0x000C);      // type 0xC = invalid, no END bit
	bus.writeWord(PTMR, 2);
	vdp1.plot();
	check("invalid command: CEF stays at 0 (END was not fetched)", 0x0, read(bus, EDSR) & 0x2);
	check("invalid command: there is NO Draw End interrupt", 0, end.n);
}

// The contrast that gives the test above its meaning: with the END bit CEF IS set
// and the interrupt DOES fire (when the draw end command is fetched, the VDP1 sets CEF
// to '1' and generates an interrupt signal).
{
	const { bus, vdp1 } = build();
	const end = spyEndDraw(bus);
	bus.writeWord(PTMR, 2);
	vdp1.plot();
	check("END command: CEF is set to 1", 0x2, read(bus, EDSR) & 0x2);
	check("END command: the Draw End interrupt fires", 1, end.n);
}

// COPR IS updated on the invalid path: in the case of draw forced
// termination, it holds the address (divided by 8H) of the abnormally ended command
// table. The invalid command goes second (0x20) to tell it apart from a COPR at 0.
{
	const { bus, vdp1 } = build();
	putCmd(bus, 0x00, 0x000A);      // local coordinate (does not rasterize), JP=NEXT
	putCmd(bus, 0x20, 0x000D);      // type 0xD = invalid
	bus.writeWord(PTMR, 2);
	vdp1.plot();
	check("invalid command: COPR stays at the address of the aborted command", 0x20 >> 3, read(bus, COPR));
}

// ---------------------------------------------------------------------------
// P4: LOPR. This register is updated when the frame buffer is changed, so it is
// possible to know the address of the command table last processed in the previous
// frame. It used to be written only on the invalid command path, which is exactly
// where the hardware does NOT write it.
// ---------------------------------------------------------------------------

// Two-command list: a harmless one and END at 0x20 -> COPR = 0x20/8 = 4.
function buildList(endIn)
{
	const { bus, vdp1 } = build();
	for(let a = 0; a < endIn; a += 0x20) putCmd(bus, a, 0x000A);   // local coordinate
	putCmd(bus, endIn, 0x8000);                                    // END bit
	return { bus, vdp1 };
}

{
	const { bus, vdp1 } = buildList(0x20);
	bus.writeWord(FBCR, 0);        // FCM=0: bank change on every frame
	bus.writeWord(PTMR, 2);

	vdp1.plot();                   // draws (COPR=4) and changes bank
	check("precondition: the drawing left COPR at the END command", 0x20 >> 3, read(bus, COPR));
	check("LOPR has not moved yet (the bank change only just latched it)", 0, read(bus, LOPR));

	vdp1.plot();                   // the previous bank change writes LOPR
	check("LOPR <- COPR on the bank change", 0x20 >> 3, read(bus, LOPR));
}

// THE P4 BUG: LOPR was written ONLY on the invalid command path. With a
// valid list it NEVER moved.
{
	const { bus, vdp1 } = buildList(0x40);
	bus.writeWord(FBCR, 0);
	bus.writeWord(PTMR, 2);
	vdp1.plot(); vdp1.plot();
	check("a VALID list also moves LOPR", 0x40 >> 3, read(bus, LOPR));
}

// No bank change, no LOPR: it is updated when the frame buffer is changed.
// With FBCR=2 (FCM=1) and no manual request the swap never happens.
{
	const { bus, vdp1 } = buildList(0x20);
	bus.writeWord(FBCR, 2);        // FCM=1 with no change request -> there is never a swap
	bus.writeWord(PTMR, 2);
	vdp1.plot(); vdp1.plot(); vdp1.plot();
	check("without a bank change LOPR does not move", 0, read(bus, LOPR));
}

// LOPR belongs to the PREVIOUS frame: if it were the current one's it would be a DUPLICATE of COPR and
// would be useless. Here the list CHANGES length between frames, which is the only case
// where the two registers can be told apart.
{
	const { bus, vdp1 } = buildList(0x20);   // frame 1: END at 0x20 -> COPR = 4
	bus.writeWord(FBCR, 0);
	bus.writeWord(PTMR, 2);
	vdp1.plot();

	putCmd(bus, 0x20, 0x000A);              // frame 2: the list stretches, END at 0x40
	putCmd(bus, 0x40, 0x8000);
	vdp1.plot();
	check("LOPR is the PREVIOUS frame's...", 0x20 >> 3, read(bus, LOPR));
	check("...and COPR the current one's: they are NOT the same register", 0x40 >> 3, read(bus, COPR));
}

// LOPR survives the COPR <- 0 that the PTMR hook of bus.js does on every trigger
// write. The CPU runs BETWEEN two plot() calls, so a "LOPR <- COPR" read late
// would find COPR already overwritten with 0.
{
	const { bus, vdp1 } = buildList(0x20);
	bus.writeWord(FBCR, 0);
	bus.writeWord(PTMR, 1);        // PTM=01B: edge
	vdp1.plot();                   // draws (COPR=4) and changes bank (latches 4)
	bus.writeWord(PTMR, 1);        // the CPU triggers again: COPR <- 0
	check("precondition: the PTMR write overwrote COPR with 0", 0, read(bus, COPR));
	vdp1.plot();
	check("LOPR uses the value LATCHED on the swap, not the overwritten COPR", 0x20 >> 3, read(bus, LOPR));
}

// ---------------------------------------------------------------------------
// P2: PRIORITY OF THE SPRITE LAYER (PRISA-D). The bug: index.html composed the VDP1
// on top of the VDP2 with a binary overlay ("alpha != 0 overwrites"), NEVER looking at
// priority. PRISA-D was not read anywhere in the project and _infoPixelSprite()
// computed spi.priority for every pixel only to throw it away. Measured by Sebas in Sega
// Rally: the 3D covered the rankings.
// The PR bits of the word are an INDEX into the eight priority
// registers, NOT the priority. At equal priority the sprite wins (the order
// is sprite -> RBG0 -> NBG0 -> NBG1 -> NBG2 -> NBG3). Priority 0 =
// "considered transparent and not displayed".
// ---------------------------------------------------------------------------

// Writes a 16-bit VDP2 register (big-endian) into the bus array.
function putReg2(bus, off, v)
{
	bus.vdp2Regs[off] = (v >> 8) & 0xFF;
	bus.vdp2Regs[off + 1] = v & 0xFF;
}

// Puts a RAW word into the display bank. We go straight to the bank instead of
// rasterizing: what is tested here is the priority RESOLUTION, not the drawing (already covered by
// the tests above). _fbWidth is set by _configureGeometry().
function putPixelDisplay(vdp1, x, y, w)
{
	vdp1._configureGeometry();
	const o = (y * vdp1._fbWidth + x) * 2;
	vdp1._fbDisplay[o] = (w >> 8) & 0xFF;
	vdp1._fbDisplay[o + 1] = w & 0xFF;
}

// Alpha of pixel (0,0) when composing against a uniform background of priority 'prioBackground'.
// null = do not pass a buffer (the path of standalone render() and of all the old tests).
// The buffer is oversized on purpose: the test does not depend on the geometry.
function alphaSprite(vdp1, prioBackground)
{
	const prio = (prioBackground === null) ? undefined
		: new Uint8Array(1024 * 512).fill(prioBackground);
	return vdp1.compose(prio)[3];
}

// SPCTL = 0x23 (SPTYPE=3 + SPCLMD=1) is what we MEASURED SF Alpha setting.
// Type 3 word: SD=bit15, PR=bits14-13, CC=bits12-11, DC=bits10-0.
// 0x2100 -> SD=0, PR=01B (index 1), CC=0, DC=0x100.
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x0023);
	putReg2(bus, 0xF0, (5 << 8) | 1);        // PRISA: S0PRIN=1, S1PRIN=5
	putPixelDisplay(vdp1, 0, 0, 0x2100);     // index 1 -> priority 5

	check("sprite prio 5 vs background 3: the sprite wins", 255, alphaSprite(vdp1, 3));
	check("sprite prio 5 vs background 5: TIE, the sprite wins", 255, alphaSprite(vdp1, 5));
	check("sprite prio 5 vs background 6: the VDP2 wins, the sprite is NOT drawn", 0, alphaSprite(vdp1, 6));
	check("sprite prio 5 vs backdrop (prio 0): the sprite wins", 255, alphaSprite(vdp1, 0));
}

// The PR bits are an INDEX, not a value: the SAME word changes priority if the
// register it indexes changes. If this fails, someone confused the index with the priority.
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x0023);
	putPixelDisplay(vdp1, 0, 0, 0x2100);     // PR = index 1, fixed

	putReg2(bus, 0xF0, (7 << 8) | 1);
	check("index 1 reads S1PRIN: with 7 it beats a background of 6", 255, alphaSprite(vdp1, 6));
	putReg2(bus, 0xF0, (2 << 8) | 1);
	check("the SAME word with S1PRIN=2 no longer beats a background of 6", 0, alphaSprite(vdp1, 6));
	putReg2(bus, 0xF0, (0 << 8) | 1);
	check("priority 0 = transparent, not displayed", 0, alphaSprite(vdp1, 0));
}

// Index 2 has to read PRISB bits 2-0 (1800F2H), not keep reading PRISA.
// PRISA stays at 7: if the indexing is wrong and reads it from there, the sprite wins and it fails.
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x0023);
	putPixelDisplay(vdp1, 0, 0, 0x4100);     // PR = 10B -> index 2
	putReg2(bus, 0xF0, (7 << 8) | 7);
	putReg2(bus, 0xF2, 2);                   // PRISB: S2PRIN = 2
	check("index 2 reads PRISB (1800F2H), not PRISA", 0, alphaSprite(vdp1, 6));
}

// Direct RGB: there the priority bit, color calculation ratio
// bit and shadow bit are taken as 0, so the index is ALWAYS 0 and the
// priority comes from sprite register 0 no matter what bits 14-13 hold (which in
// RGB are color). 0xFC00 = MSB + blue: its bits 14-13 are 11B, which as an index would be
// 3. If someone uses them as PR, this test catches it.
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x0023);
	putReg2(bus, 0xF0, (0 << 8) | 4);        // S0PRIN=4, S1PRIN=0
	putReg2(bus, 0xF2, (0 << 8) | 7);        // S2PRIN=7, S3PRIN=0  (index 3 would give 0)
	putPixelDisplay(vdp1, 0, 0, 0xFC00);
	check("direct RGB: the priority comes from register 0 (PR bits taken as 0)",
		255, alphaSprite(vdp1, 4));
	check("direct RGB: against background 5, register 0 (=4) loses", 0, alphaSprite(vdp1, 5));
}

// Without the VDP2 buffer it composes permissively. It is the decision of the //? in _composeOutput
// and it is written here so that it breaks if someone changes it by accident: PRISA at 0
// would leave EVERYTHING transparent, and all the tests above compose through this path.
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x0023);
	putReg2(bus, 0xF0, 0);                   // PRISA = 0 -> priority 0 for all
	putPixelDisplay(vdp1, 0, 0, 0x2100);
	check("without the VDP2 buffer it draws anyway (permissive, deliberate //?)",
		255, alphaSprite(vdp1, null));
}

// ---------------------------------------------------------------------------
// P3: COLOR CALCULATION OF THE SPRITE LAYER (CCRSA-D). Same family as P2: the
// CC bits of the word are an INDEX into eight ratio registers, just as the PR bits index
// PRISA-D. _infoPixelSprite() computed spi.calcColor for every pixel and NOBODY read it.
// The eight registers sit at
// 180100H-180106H, with FIVE-bit fields (bits 4-0 the even one, bits 12-8 the odd one). It is
// conditional: the conditions are valid only when the SPCCEN bit in the color
// calculation control register is 1, and SPCCCS picks among four conditions.
// ---------------------------------------------------------------------------

// Uniform VDP2 background, so there is something to blend against. Oversized: the test
// only looks at pixel (0,0) and so it does not depend on the geometry.
function backgroundVdp2(r, g, b)
{
	const fb = new Uint8ClampedArray(1024 * 512 * 4);
	for(let i = 0; i < fb.length; i += 4) { fb[i] = r; fb[i + 1] = g; fb[i + 2] = b; fb[i + 3] = 255; }
	return fb;
}

function putCram(bus, idx, w)
{
	bus.cram[idx * 2] = (w >> 8) & 0xFF;
	bus.cram[idx * 2 + 1] = w & 0xFF;
}

// [r,g,b] of pixel (0,0) when composing against a background of priority 3. fb = null to
// NOT pass the VDP2 framebuffer (the path with nothing to blend with).
function rgbSprite(vdp1, fb)
{
	const prio = new Uint8Array(1024 * 512).fill(3);
	const out = vdp1.compose(prio, fb || undefined);
	return [out[0], out[1], out[2]];
}

// Base scene: pure RED sprite over a pure BLUE background. The colors are opposite on
// purpose: any blend shows in both channels at once and there is no way for
// a correct result to come out by chance.
//   SPCTL = 0x2023: SPTYPE=3, SPCLMD=1, SPCCN=0, SPCCCS=2 ("only when prio >= SPCCN").
//   SPCCCS=2 with SPCCN=0 ALWAYS holds: it isolates the ratio from the condition.
//   Word 0x2100 type 3: SD=0, PR=01B (index 1), CC=00B (index 0), DC=0x100.
function sceneCC()
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x2023);
	putReg2(bus, 0xF0, (5 << 8) | 1);        // PRISA: S1PRIN=5 -> the sprite beats background 3
	putReg2(bus, 0xEC, 0x0040);              // CCCTL: SPCCEN (bit 6)
	putCram(bus, 0x100, 0x001F);             // pure red: r5=31 -> (248,0,0)
	putPixelDisplay(vdp1, 0, 0, 0x2100);
	return { bus, vdp1 };
}

const BLUE = backgroundVdp2(0, 0, 248);

// ratio 31 -> alpha6 = ((~31 & 0x1F) << 1) + 1 = 1 -> a = (1<<2)+3 = 7, ra = 248.
// r = (248*7/255|0) + (0*248/255|0) = 6   |   b = 0 + (248*248/255|0) = 241
{
	const { bus, vdp1 } = sceneCC();
	putReg2(bus, 0x100, 31);                 // CCRSA: S0CCRT = 31 (the most translucent)
	const [r, g, b] = rgbSprite(vdp1, BLUE);
	check("CC ratio 31: the red almost disappears (r)", 6, r);
	check("CC ratio 31: the green stays at 0", 0, g);
	check("CC ratio 31: the VDP2 blue dominates (b)", 241, b);
}

// ratio 0 = OPAQUE (the formula of vdp2._alphaOfRatio: 0 -> alpha6 = 0x3F). If someone
// inverts the direction of the ratio, this test catches it.
{
	const { bus, vdp1 } = sceneCC();
	putReg2(bus, 0x100, 0);
	check("CC ratio 0 = opaque: the sprite covers completely", "248,0,0", rgbSprite(vdp1, BLUE).join(","));
}

// SPCCEN is the master enable: without that bit there is no blend, whatever the ratio.
{
	const { bus, vdp1 } = sceneCC();
	putReg2(bus, 0x100, 31);
	putReg2(bus, 0xEC, 0x0000);              // CCCTL without SPCCEN
	check("without SPCCEN there is no color calculation", "248,0,0", rgbSprite(vdp1, BLUE).join(","));
}

// Without the VDP2 framebuffer there is nothing to blend with: opaque. It is the path of all the
// old tests and of standalone render(); it is written so that it breaks if someone changes it.
{
	const { bus, vdp1 } = sceneCC();
	putReg2(bus, 0x100, 31);
	check("without the VDP2 fb it composes opaque", "248,0,0", rgbSprite(vdp1, null).join(","));
}

// The CC bits are an INDEX: word 0x3100 has CC=10B -> index 2 -> CCRSB bits 4-0
// (1800102H), NOT CCRSA. CCRSA stays at 31: if the indexing is wrong and reads it from there,
// the pixel gets blended and the test fails.
{
	const { bus, vdp1 } = sceneCC();
	putPixelDisplay(vdp1, 0, 0, 0x3100);     // PR=01B (index 1), CC=10B (index 2)
	putReg2(bus, 0x100, 31);                 // CCRSA all translucent
	putReg2(bus, 0x102, 0);                  // CCRSB: S2CCRT = 0 -> opaque
	check("CC index 2 reads CCRSB (180102H), not CCRSA", "248,0,0", rgbSprite(vdp1, BLUE).join(","));
}

// The four SPCCCS conditions. The sprite has priority 5 (PRISA S1PRIN=5).
{
	const { bus, vdp1 } = sceneCC();
	putReg2(bus, 0x100, 31);

	putReg2(bus, 0xE0, 0x0023 | (0 << 12) | (5 << 8));   // SPCCCS=0 (prio <= SPCCN), SPCCN=5
	check("SPCCCS=0 (prio<=cond): 5<=5 holds, blends", 6, rgbSprite(vdp1, BLUE)[0]);
	putReg2(bus, 0xE0, 0x0023 | (0 << 12) | (4 << 8));   // SPCCN=4
	check("SPCCCS=0 (prio<=cond): 5<=4 does NOT hold, opaque", 248, rgbSprite(vdp1, BLUE)[0]);

	putReg2(bus, 0xE0, 0x0023 | (1 << 12) | (5 << 8));   // SPCCCS=1 (prio == SPCCN)
	check("SPCCCS=1 (prio==cond): 5==5 holds, blends", 6, rgbSprite(vdp1, BLUE)[0]);
	putReg2(bus, 0xE0, 0x0023 | (1 << 12) | (4 << 8));
	check("SPCCCS=1 (prio==cond): 5!=4, opaque", 248, rgbSprite(vdp1, BLUE)[0]);

	putReg2(bus, 0xE0, 0x0023 | (2 << 12) | (6 << 8));   // SPCCCS=2 (prio >= SPCCN)
	check("SPCCCS=2 (prio>=cond): 5>=6 does NOT hold, opaque", 248, rgbSprite(vdp1, BLUE)[0]);
}

// SPCCCS=3 is the only one that does NOT look at the priority: only when the most significant bit of
// the color data is 1. Word 0x2100 has the MSB at 0 -> it never blends, even if the ratio and
// the priority say it should.
{
	const { bus, vdp1 } = sceneCC();
	putReg2(bus, 0x100, 31);
	putReg2(bus, 0xE0, 0x0023 | (3 << 12) | (0 << 8));   // SPCCCS=3 (MSB of the data)
	check("SPCCCS=3 with MSB=0: does not blend", 248, rgbSprite(vdp1, BLUE)[0]);
}

// ---------------------------------------------------------------------------
// P4: NORMAL SHADOW (SDCTL). The shadow sprite becomes
// transparent ALWAYS (it is forcibly made transparent) and it halves the
// brightness of what was left underneath, but only if (1) shadowing is only used
// when the shadowing sprite has the highest priority and (2) the layer underneath accepts
// the shadow (its bit in SDCTL). (2) has to be told by the VDP2: the VDP1 knows with
// what PRIORITY each pixel was painted, not WHICH LAYER painted it.
// The normal shadow data of type 3 is DC == 0x7FE.
// ---------------------------------------------------------------------------

// [r,g,b,a] of pixel (0,0). shadowOk: uniform 1/0, or null to NOT pass the buffer.
function rgbaShadow(vdp1, fb, shadowOk)
{
	const prio = new Uint8Array(1024 * 512).fill(3);
	const so = (shadowOk === null) ? undefined : new Uint8Array(1024 * 512).fill(shadowOk);
	const out = vdp1.compose(prio, fb, so);
	return [out[0], out[1], out[2], out[3]];
}

// Word 0x27FE, type 3: SD=0, PR=01B (index 1), CC=00B, DC=0x7FE -> normal shadow.
// Blue background (0,0,248): at half it gives (0,0,124). That 124 is what proves the
// shadow DARKENS instead of just being covered or painting black.
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x0023);
	putReg2(bus, 0xF0, (5 << 8) | 1);        // PRISA: S1PRIN=5, beats background 3
	putPixelDisplay(vdp1, 0, 0, 0x27FE);

	check("normal shadow with SDEN: the background is at half brightness",
		"0,0,124,255", rgbaShadow(vdp1, BLUE, 1).join(","));
	check("normal shadow WITHOUT SDEN: transparent, the VDP2 shows without shadow",
		0, rgbaShadow(vdp1, BLUE, 0)[3]);
	check("normal shadow without shadowOk buffer: transparent (the old behavior)",
		0, rgbaShadow(vdp1, BLUE, null)[3]);
}

// Shadowing is only used when the shadowing sprite has the highest priority.
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x0023);
	putPixelDisplay(vdp1, 0, 0, 0x27FE);

	putReg2(bus, 0xF0, (2 << 8) | 1);        // S1PRIN=2 < background 3: loses
	check("normal shadow that LOSES on priority: does not darken", 0, rgbaShadow(vdp1, BLUE, 1)[3]);
	putReg2(bus, 0xF0, (3 << 8) | 1);        // S1PRIN=3 == background 3: tie
	check("normal shadow that TIES: the sprite wins and darkens",
		"0,0,124,255", rgbaShadow(vdp1, BLUE, 1).join(","));
	putReg2(bus, 0xF0, (0 << 8) | 1);        // S1PRIN=0: not displayed
	check("normal shadow with priority 0: not displayed, does not darken",
		0, rgbaShadow(vdp1, BLUE, 1)[3]);
}

// A word that is NOT a normal shadow must not darken anything: its color is drawn.
// If someone loosens the spi.shadowNormal test, this one catches it.
{
	const { bus, vdp1 } = build();
	putReg2(bus, 0xE0, 0x0023);
	putReg2(bus, 0xF0, (5 << 8) | 1);
	putCram(bus, 0x7FF, 0x001F);             // pure red at the neighboring index
	putPixelDisplay(vdp1, 0, 0, 0x27FF);     // DC=0x7FF: ONE bit different from 0x7FE
	check("DC=0x7FF (one bit off from the shadow) is NOT a shadow: the color is drawn",
		"248,0,0,255", rgbaShadow(vdp1, BLUE, 1).join(","));
}

// ============================================================================
//   Color calculation 6 and 7: gouraud CHAINED with half-lum / half-transp
// ============================================================================
// In the CMDPMOD bits 2-0 encoding, mode 6 applies gouraud to the pixel and
// THEN half the brightness; 7 applies gouraud and THEN the average against the
// framebuffer only if the destination has the MSB. The historical bug: both blended 50%
// the FLAT gouraud color against the texture (neither gouraud on the pixel nor the
// destination MSB rule).
{
	const bus = new Bus();
	const v = new VDP1(bus);
	// Minimal state to call _putpixel directly: 16bpp geometry, no mesh/clip/DIL.
	v._fbWidth = 512; v._fbHeight = 256; v._fbBpp = 2; v._interlaced = 1;
	v._gpMesh = false; v._gpMsbon = false; v._gpSPD = true; v._pixVisible = 0xFFFF;
	v._gpMode = 5;                            // RGB color mode (the "chrome" case does not apply)
	v._checkDil = () => false;
	v._estaClipped = () => false;
	v._colLeft = { r: 16, g: 16, b: 16 };      // NEUTRAL gouraud (0x10 = no adjustment)
	const read = (x) => v._fbRead(bus.vdp1Fb, x);

	// Mode 6 with neutral gouraud = pure half-luminance of the source pixel.
	v._pixel = 0x8000 | (10) | (20 << 5) | (30 << 10);   // R=10 G=20 B=30
	v._gpSubmode = 6;
	v._putpixel(null, 0, 0);
	check("cc6: neutral gouraud + half-lum = components halved",
		(0x8000 | 5 | (10 << 5) | (15 << 10)) >>> 0, read(0) >>> 0);

	// Mode 7 on a destination WITHOUT MSB: writes the gouraud-shaded pixel as is (no blend).
	v._pixel = 0x8000 | 10;                   // R=10
	v._gpSubmode = 7;
	v._fbWrite(bus.vdp1Fb, 1, 0x001F);     // destination without MSB
	v._putpixel(null, 1, 0);
	check("cc7: destination without MSB -> the gouraud-shaded pixel, unblended",
		(0x8000 | 10) >>> 0, read(1) >>> 0);

	// Mode 7 on a destination WITH MSB: component-by-component average against the destination.
	v._pixel = 0x8000 | 10;                   // source R=10
	v._fbWrite(bus.vdp1Fb, 2, 0x8000 | 30);// destination R=30, with MSB
	v._putpixel(null, 2, 0);
	check("cc7: destination with MSB -> average (R=(10+30)/2=20)",
		(0x8000 | 20) >>> 0, read(2) >>> 0);

	// The gouraud IS applied before the halving: with a +15 adjustment in R (table 0x10+15).
	v._colLeft = { r: 16 + 15, g: 16, b: 16 };
	v._pixel = 0x8000 | 10;                   // R=10 -> gouraud R=25 -> half 12
	v._gpSubmode = 6;
	v._putpixel(null, 3, 0);
	check("cc6: the gouraud is applied BEFORE the halving (R: (10+15)>>1 = 12)",
		(0x8000 | 12) >>> 0, read(3) >>> 0);
}


// ============================================================================
//   THE REENTRANT WALK WITH A BUDGET IN PIXELS (29-07-2026)
// ============================================================================
// _drawCommands(budget) consumes commands until it spends `budget` PIXELS and, if it did not
// reach END, it saves the state and returns false so that the caller resumes it. It is the base
// of the three debts that get paid off together: COPR advancing during drawing (on hardware it is
// continually updated during command processing), ENDR -which today cannot abort anything because
// there is never a drawing in progress- and the pseudo draw continuation.
//
// ⚠ THE BUDGET IS CHARGED PER PIXEL ACTUALLY PUT, not per command estimate, and
// these tests were REWRITTEN because of that: the first version used "local coordinate" commands
// -which do not paint- and counted COMMANDS. With exact charging those commands consume nothing,
// which is correct: the hardware draws 1 pixel at a time and what costs is the pixels.
// (The area estimate was tried and it underestimates the peaks at 14-40%: see _commandCost.)
{
	// Three 8x8 polygons that DO paint (64 px each) + END.
	const buildPoli = () => {
		const { bus, vdp1 } = build();
		bus.writeWord(FBCR, 2);   // FCM=1: no swap nor erase, the bank stays inspectable
		for(let i = 0; i < 3; i++)
			putTable(bus, i * 0x20, { 0x00: 0x0004, 0x04: 0x0028, 0x06: 0x8FFF,
				0x0C: 0, 0x0E: i * 8, 0x10: 7, 0x12: i * 8, 0x14: 7, 0x16: i * 8 + 7,
				0x18: 0, 0x1A: i * 8 + 7 });
		putTable(bus, 0x60, { 0x00: 0x8000 });   // END
		bus.writeWord(PTMR, 1);
		return { bus, vdp1 };
	};

	// In a single pass: the default (Infinity) behaves as before the refactor.
	const a = buildPoli();
	check("default budget: finishes in ONE pass", true, a.vdp1._drawCommands());
	check("and leaves CEF at 1", 2, read(a.bus, EDSR) & 2);
	const coprOfOne = read(a.bus, COPR);
	check("with COPR at the END command", 0x60 >> 3, coprOfOne);
	check("and the three polygons painted", 0x8FFF, pixelFb(a.bus, 3, 19));

	// ★ THE POINT OF THE SPREADING: with a 64 px budget it cuts after the FIRST polygon.
	const b = buildPoli();
	const continues = b.vdp1._drawCommands(64);
	check("★ with a 64 px budget the walk did NOT finish", false, continues);
	check("★ and it does NOT raise CEF: END was not fetched", 0, read(b.bus, EDSR) & 2);
	const coprMid = read(b.bus, COPR);
	check("★ COPR advanced mid-drawing", true, coprMid > 0 && coprMid < coprOfOne);
	check("the first polygon WAS painted", 0x8FFF, pixelFb(b.bus, 3, 3));
	check("and the third one NOT yet", 0x0000, pixelFb(b.bus, 3, 19));

	// Resuming in segments until the end: SAME result as in a single pass. It is the only thing
	// that makes the spreading trustworthy — if the saved state were incomplete, the bug would be
	// invisible until a game with a long list stepped on it.
	let wraps = 1, end = false;
	while(!end && wraps < 20){ end = b.vdp1._drawCommands(64); wraps++; }
	check("★ in segments the list is resumed and finishes", true, end);
	check("★ the final COPR is THE SAME as in a single pass", coprOfOne, read(b.bus, COPR));
	check("★ and CEF stays at 1", 2, read(b.bus, EDSR) & 2);
	check("★ and the three polygons ended up painted the same", 0x8FFF, pixelFb(b.bus, 3, 19));
}


console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);