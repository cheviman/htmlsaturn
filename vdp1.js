/**
 *    Name:         vdp1.js
 *    Description:  The Saturn's VDP1: sprite and polygon processor. It walks the
 *                  command table in its VRAM and rasterizes onto its real
 *                  double-banked framebuffer (bus.vdp1Fb), controlled by the registers
 *                  TVMR/FBCR/PTMR/EWDR/EWLR/EWRR. Supports the six drawing types
 *                  (normal/scaled/distorted sprite, polygon, polyline,
 *                  line), all sprite color formats, end codes,
 *                  gouraud shading, user/system clipping, half-transparency, mesh
 *                  and MSBON. plot() rasterizes on the console's timing;
 *                  compose(prioVdp2, fbVdp2) returns the display bank in RGBA
 *                  already RESOLVED against the VDP2 -per-pixel priority via PRISA-D and
 *                  color calculation via CCRSA-D- and index.html just pastes it on top.
 *                  The shadow is DETECTED but not yet APPLIED: SDCTL is missing, which
 *                  says per layer which ones accept it (see the //? in _composeOutput).
 *    Version:      0.4.0
 *    Created:      15-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 *
 *    Faithfully ported from Yabause's software renderer (GPL v2+),
 *    yabause/src/vdp1.c and vidsoft.c (Guillaume Duhamel, Theo Berkau, R. Danbrook).
 *    The per-scanline texture mapping (edge-walking + affine interpolation) and the
 *    gouraud shading follow the implementation of drawQuad()/getpixel()/putpixel().
 *    Bank handling follows VIDSoftVdp1DrawStartBody/SwapFrameBuffer/
 *    EraseFrameBuffer and the Vdp1Draw() sequence of vdp1.c.
 */

//ok, 15-07-2026 - command list dispatch, local coord, user/system clip.
//ok, 15-07-2026 - color formats 4bpp bank/LUT, 64/128/256 color, RGB16.
//ok, 15-07-2026 - gouraud, half-transparency, mesh, end codes, distortion.
//!wip, 15-07-2026 - real double buffer: erase/swap by FBCR, plot by PTMR.
//!wip, 15-07-2026 - MSBON and shadow against the framebuffer MSB.

// --- FRAMEBUFFER MODEL (important) ---
// The VDP1 does NOT store RGB in its framebuffer: it stores the RAW 16-bit value that
// comes out of the command (a palette INDEX in the color bank modes, or an
// RGB555 with the MSB at 1 in 16-bit mode). The one who interprets it is the VDP2
// when displaying it, according to SPCTL (sprite type + SPCLMD). Two things follow from that:
//   - The framebuffer MSB is what enables shadow and half-transparency.
//   - The CPU that reads/writes the framebuffer sees those raw values, not RGB.
// That is why the conversion to RGBA happens only at the output (_composeOutput).
class VDP1
{
	constructor(bus)
	{
		this.bus = bus;
		this.width = 320;
		this.height = 224;
		this.fb = new Uint8ClampedArray(this.width * this.height * 4);  // RGBA, alpha 0 = transparent

		// --- Real double buffer ---
		// bus.vdp1Fb (256 KB) is ALWAYS the DRAW bank ("back"): it is where
		// the commands write and it is also the one the CPU sees at 0x05C80000, same
		// as on the real HW (the CPU never sees the bank being displayed).
		// The DISPLAY bank ("front") is private to the VDP1.
		// The swap exchanges CONTENTS and not references: bus.js copied the
		// reference of bus.vdp1Fb into its page table, so reassigning it
		// would leave the memory map pointing at the old buffer.
		this._fbDisplay = new Uint8Array(0x40000);
		// true = the pixels are rasterized by the worker (vdp1-worker.js) with a copy of
		// this same state. plot() walks the list THE SAME WAY (COPR/CEF/Draw End exact
		// on the console's timing, clipping and local coords persist) but skips the
		// erase, the pixels and the swap copies. The fbDisplay that gets composed
		// comes in the worker's response (index.html pastes it over _fbDisplay when it arrives).
		this.workerMode = false;
		this._fbTmp = new Uint8Array(0x40000);

		// Bank geometry, set by TVMR on every plot. The three modes take up
		// exactly the 256 KB: 512x256x16bpp, 1024x256x8bpp and 512x512x8bpp.
		this._fbWidth = 512; this._fbHeight = 256; this._fbBpp = 2;
		this._interlaced = 1;
		this._cramMode = 0;

		// Local coordinate (command 0xA). Origin for all the vertices.
		this.localX = 0;
		this.localY = 0;

		// Clip windows. They are REGISTER STATE: they persist across frames and are not
		// reset on every render(). Night Warriors almost never reprograms them and
		// uses the end of the framebuffer as scratch: if they are reset, it gets corrupted.
		// System clipping has NO upper-left corner: the HW fixes it at (0,0)
		// and the command (type 0x9) only carries CMDXC/CMDYC. The
		// lower-right coordinates of the clipping area are defined by CMDXC, CMDYC; THE
		// UPPER-LEFT COORDINATES ARE FIXED AT (0,0). That is why _sysClipped() compares
		// against the literal 0 and there is no sysX1/sysY1 here: they would not be state, they would be two
		// constants. See the comment on _systemClipping().
		this.sysX2 = 512; this.sysY2 = 256;
		this.userX1 = 0; this.userY1 = 0; this.userX2 = 512; this.userY2 = 256;

		// Current pixel state (equivalent to vidsoft.c's globals:
		// currentPixel, currentPixelIsVisible, leftColumnColor, gouraud*).
		this._pixel = 0;        // raw 16-bit value (palette index or RGB555)
		this._pixVisible = 0;   // mask of the index's significant bits
		this._charWidth = 0; this._charHeight = 0;

		// Interpolated gouraud color of the current scanline's left column.
		this._colLeft = { r: 0, g: 0, b: 0 };
		// State of the rasterization hot path (_drawLine/_pixelDraw): declared here so
		// the instance has a stable hidden class and V8 does not reshape it at runtime.
		this._drawCmd = null; this._drawNumLine = 0; this._drawStepTex = 0;
		this._drawStepR = 0; this._drawStepG = 0; this._drawStepB = 0;
		this._drawPreviousStep = 0; this._drawEnds = 0;
		// Invariants of the current command, precomputed once per scanline in _drawLine
		// (not a million times per pixel in _getpixel/_putpixel). See _precomputeCommand.
		this._gpIsTextured = false; this._gpSPD = false; this._gpEndsOn = false;
		this._gpMode = 0; this._gpFlip = 0; this._gpAddrChar = 0;
		this._gpColorbank = 0; this._gpColorlut = 0; this._gpMaskVis = 0;
		this._gpMesh = false; this._gpMsbon = 0; this._gpSubmode = 0;
		// Gouraud table of the current command (4 vertices xBGR555).
		this._grd = [ { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 } ];

		// Reusable buffers for the quad edges (like vidsoft's xleft/yleft).
		this._xLeft = new Int32Array(1024); this._yLeft = new Int32Array(1024);
		this._xRight = new Int32Array(1024); this._yRight = new Int32Array(1024);

		// Reusable object so as not to allocate one per pixel at the output.
		this._spi = { index: 0, priority: 0, calcColor: 0, shadowMsb: false, shadowNormal: false };
		// The 8 priorities of PRISA-D. They are reread once per frame, not per pixel.
		this._pris = new Uint8Array(8);
		// The 8 color calculation ratios of CCRSA-D, already converted to the internal alpha
		// 6-bit alpha (0x3F = opaque). Also once per frame.
		this._ccrs = new Uint8Array(8);

		// Value that the BANK CHANGE latched for LOPR, not yet written to the
		// register. See _swapBanks() and plot(): the latch happens on the swap
		// (end of plot()) but the register is written only in the next plot(),
		// same as the EDSR shift and for the same reason.
		this._loprPending = 0;

		// Diagnostics of the last render(): observation windows for the tests and for
		// measuring from the console. lastSwap and lastPlot ALSO drive logic (the
		// EDSR shift and the erase+draw of plot()); lastErase drives
		// nothing, and that is why orphans.mjs flags it as a loose prop.
		//? KNOWN FALSE POSITIVE (17-07-2026): lastErase must NOT be "connected".
		//? It is the only way to count erases from the console, and with it we measured "504
		//? erases in 994 plots = 50.7%", which is correct with FCM: that is how the
		//? badly-erased-buffer hypothesis was RULED OUT. Same case as cddaPending() in scsp.js —
		//? wiring it would be inventing a consumer the hardware does not ask for.
		this.lastPlot = false;
		this.lastErase = false;
		this.lastSwap = false;
		this.commandsDrawn = 0;
		// State of the drawing IN PROGRESS, for the reentrant walk of _drawCommands().
		// With _activeDraw false each call starts a new list, which is how it used to
		// behave; with it true, it resumes where it left off.
		this._activeDraw = false;
		this._drawAddr = 0;
		this._drawGuard = 0;
		this._drawReturn = -1;
		// Pixels the frame's list costs (see _commandCost). It is the figure with which the
		// Draw End could land at its own instant -"now + pxFrame cycles"- once drawing is
		// spread over console time. Today it is computed and exposed; nobody consumes it
		// yet, on purpose: the missing piece is the spreading, not the metric.
		this.pxFrame = 0;
		this._pxSegment = 0;
	}

	// --- VDP1 VRAM reads (read only) ---
	_r8(a)  { return this.bus.vdp1Vram[a & 0x7FFFF]; }
	_r16(a) { const v = this.bus.vdp1Vram; return ((v[a & 0x7FFFF] << 8) | v[(a + 1) & 0x7FFFF]) >>> 0; }
	_s16(x) { return (x & 0x8000) ? x - 0x10000 : x; }

	// --- VDP1 registers (bus.vdp1Regs, big-endian, base 0x05D00000) ---
	_reg(off)       { const r = this.bus.vdp1Regs; return ((r[off] << 8) | r[off + 1]) & 0xFFFF; }
	_setReg(off, v) { const r = this.bus.vdp1Regs; r[off] = (v >> 8) & 0xFF; r[off + 1] = v & 0xFF; }

	_tvmr() { return this._reg(0x00); }   // TV Mode: TVM0/TVM1/TVM2 + VBE
	_fbcr() { return this._reg(0x02); }   // Frame Buffer Change Mode: FCM/FCT/DIL/DIE/EOS
	_ptmr() { return this._reg(0x04); }   // Plot Trigger
	_ewdr() { return this._reg(0x06); }   // Erase/Write Data
	_ewlr() { return this._reg(0x08); }   // Erase/Write upper-left corner
	_ewrr() { return this._reg(0x0A); }   // Erase/Write lower-right corner
	// 0x0C = ENDR (Draw Forced Termination), write-only. It has NO accessor ON PURPOSE.
	// On hardware it forces termination of the drawing currently being processed,
	// within approximately 30 clock cycles after the data is written to the register,
	// and the interrupted drawing cannot be resumed.
	// In this emulator it CAN DO NOTHING, and that is not an oversight: _drawCommands() walks
	// the ENTIRE list inside a single call to plot(), and the CPU runs BETWEEN two
	// plot() calls. So at the instant a game writes ENDR there is -never- a
	// drawing in progress to abort: this frame's has already finished and the next one's has not started.
	// An _endr() accessor that nobody calls would be exactly the garbage pattern we
	// had been cleaning up (orphans.mjs would flag it), so it is documented and that's it.
	// For ENDR to mean anything, drawing by cycles has to come FIRST (the VDP1
	// consuming commands spread over the frame, like Mednafen with its DrawingActive). That
	// would also fix the "pseudo draw continuation", which today does not work either
	// for the same underlying reason: our COPR always ends at the END command, never
	// mid-list. The two debts are THE SAME one and get paid off together.
	// (Yabause does not act either: it stores the value and nothing else. Mednafen does, because its drawing
	// is by cycles: md_vdp1.c:1247, "case 0x6: if(DrawingActive) { DrawingActive = false; ... }".)

	// --- Framebuffer: 16 bits per pixel in big-endian (that is how the CPU reads it) ---
	_fbRead(buf, i)      { const o = i * 2; return ((buf[o] << 8) | buf[o + 1]) & 0xFFFF; }
	_fbWrite(buf, i, v) { const o = i * 2; buf[o] = (v >> 8) & 0xFF; buf[o + 1] = v & 0xFF; }

	// A CRAM color returned as 5-bit components (0..31). The color
	// RAM mode is set by the VDP2 in RAMCTL (bits 12-13): 0 and 1 are RGB555, 2 is RGB888.
	_cram5(idx)
	{
		const c = this.bus.cram;
		if(this._cramMode === 2)
		{
			// RGB888 mode (1024 colors): the long is 0x00BBGGRR — RED in the low
			// bits, as in RGB555 (BLUE in 23-16, RED in 7-0). In
			// big-endian bytes: o+1=B, o+2=G, o+3=R. It used to be read backwards (assumed
			// 00RRGGBB "unverified"): vdp2.js had already been fixed on 18-07 and this half
			// had been left with the old order — palettized sprites with R and B swapped.
			const o = (idx * 4) & 0xFFF;
			return [ c[o + 3] >> 3, c[o + 2] >> 3, c[o + 1] >> 3 ];
		}
		const o = (idx * 2) & 0xFFF;
		const w = (c[o] << 8) | c[o + 1];
		return [ w & 0x1F, (w >> 5) & 0x1F, (w >> 10) & 0x1F ];
	}

	// A 16-bit VDP1 color in 5 bits: bit15=1 -> direct RGB555; otherwise, CRAM index.
	_word5(w)
	{
		if(w & 0x8000) return [ w & 0x1F, (w >> 5) & 0x1F, (w >> 10) & 0x1F ];
		return this._cram5(w & 0x7FF);
	}

	// Compat: CRAM color at 8 bits per component.
	colorCram(idx) { const [r, g, b] = this._cram5(idx); return [ r * 8, g * 8, b * 8 ]; }
	colorOf(w)     { const [r, g, b] = this._word5(w);   return [ r * 8, g * 8, b * 8 ]; }

	// Builds an RGB555 with the MSB set (COLOR macro from vidsoft.c).
	_color555(r, g, b) { return ((r & 0x1F) | ((g & 0x1F) << 5) | ((b & 0x1F) << 10) | 0x8000) & 0xFFFF; }

	// alphablend16() at 50%: averages two RGB555 values component by component.
	// Returns the color WITHOUT the MSB (the caller sets it again).
	_mix555(d, s)
	{
		const r = (((s & 0x001F) + (d & 0x001F)) >> 1) & 0x001F;
		const g = (((s & 0x03E0) + (d & 0x03E0)) >> 1) & 0x03E0;
		const b = (((s & 0x7C00) + (d & 0x7C00)) >> 1) & 0x7C00;
		return r | g | b;
	}

	// Reads a 32-byte command from VRAM (equivalent to Vdp1ReadCommand).
	_readCommand(addr)
	{
		return {
			addr: addr,
			ctrl: this._r16(addr),
			link: this._r16(addr + 0x02),
			pmod: this._r16(addr + 0x04),
			colr: this._r16(addr + 0x06),
			srca: this._r16(addr + 0x08),
			size: this._r16(addr + 0x0A),
			xa: this._s16(this._r16(addr + 0x0C)), already: this._s16(this._r16(addr + 0x0E)),
			xb: this._s16(this._r16(addr + 0x10)), yb: this._s16(this._r16(addr + 0x12)),
			xc: this._s16(this._r16(addr + 0x14)), yc: this._s16(this._r16(addr + 0x16)),
			xd: this._s16(this._r16(addr + 0x18)), yd: this._s16(this._r16(addr + 0x1A)),
			grda: this._r16(addr + 0x1C)
		};
	}

	// --- VDP1 frame cycle ---
	// Models in a single pass what the HW splits between VBlankOUT (plot:
	// erase + drawing on the back bank) and VBlankIN (bank swap), because
	// index.html calls render() once per displayed frame and expects the image already
	// done. Compared to Yabause this moves the swap one frame earlier: what is drawn
	// is seen in the same frame instead of the next. It is what we want for a
	// "give me a frame" function; the semantics of banks, erase and persistence
	// stay the same.
	// One VDP1 frame on the CONSOLE side: geometry, erase, plot of the command
	// list and bank swap. It touches the hardware (EDSR, COPR, the framebuffer and the
	// Draw End interrupt), so it runs once per Saturn frame and in the emulation
	// timing. It CANNOT hang off the canvas painting: tied to it, it plotted at the
	// monitor rate (144 Hz against the Saturn's 59.94) and with the tab in the background
	// it never plotted, because requestAnimationFrame freezes. Games wait for
	// the Draw End to continue, so without plot they spin forever.
	plot()   //!wip, 16-07-2026
	{
		this._configureGeometry();
		this._cramMode = this._readModeCram();

		// EDSR: BEF <- CEF (with the CEF <- 0 that goes with it) is triggered by the BANK
		// CHANGE, not by drawing. On hardware BEF is written with the CEF value when the
		// frame buffer is changed or at the start of drawing, and is held until the next
		// frame buffer change; CEF is reset to 0 when the frame buffers are changed or when
		// drawing is started.
		// Mednafen does it on the frame-change path (md_vdp1.c:972, EDSR >>= 1) and
		// in StartDrawing() it only clears CEF: if the shift also ran at the start of
		// drawing, it would overwrite with 0 the BEF that the bank change had just set.
		// It used to live inside _drawCommands(), reachable only if _mustPlot():
		// with PTMR=0 the EDSR stayed FROZEN FOREVER (measured in Sega Rally: it
		// sticks at 3 from frame 394 on, which is when the game writes PTMR=0).
		// It goes at the START of this frame and not inside _swapBanks() because of the
		// frame model of this file (see the comment above): the swap
		// runs at the END of plot(), one frame earlier than on the HW. Applying the shift
		// there would overwrite the CEF <- 1 that the drawing just set, and the CPU -which runs
		// AFTER plot()- would never see the end of drawing by polling. Running it here,
		// the CPU observes the same as on the HW: CEF=1 from when drawing finishes until
		// the next bank change.
		// LOPR travels with EDSR: the HW updates them TOGETHER on the bank change.
		// When the frame buffer is changed, the value obtained by dividing by 8H the
		// address of the command table that the VDP1 read from VRAM is written to this
		// register, which makes it possible to know the address
		// of the command table last processed in the previous frame. Mednafen writes them
		// on the same line of the frame-change path (md_vdp1.c:972-973: "EDSR =
		// EDSR >> 1; LOPR = CurCommandAddr >> 2;", with the comment "On fb swap, copy CEF
		// to BEF, clear CEF, and copy COPR to LOPR").
		// The VALUE is latched on the swap (_swapBanks), but the REGISTER is written
		// here, one frame later, for the same reason as the EDSR shift: our swap runs
		// one frame early. If it were written on the swap, the CPU would see LOPR == COPR
		// ALWAYS and the register would be useless, which is exactly the opposite of what
		// it exists for (the command table address processed at the END OF THE PREVIOUS
		// FRAME). Latching the value also saves it from the COPR <- 0 that the PTMR hook in
		// bus.js does on every trigger write: the CPU runs BETWEEN two plot() calls, so
		// reading COPR here would already find it overwritten with 0.
		if(this.lastSwap)
		{
			this._setReg(0x10, this._reg(0x10) >> 1);   // BEF <- CEF, CEF <- 0
			this._setReg(0x12, this._loprPending);    // LOPR <- COPR of the previous frame
		}

		this.lastPlot = this._mustPlot();
		if(this.lastPlot)
		{
			this._erase();             // VIDSoftVdp1DrawStartBody -> EraseFrameBuffer
			this._drawCommands();    // Vdp1DrawCommands on the draw bank
		}
		else this.lastErase = false;

		this._buildEraseVBlank();     // Vdp2VBlankOUT: VBE arms the erase of the next frame
		this._swapBanks();     // VIDSoftVdp1SwapFrameBuffer
		this._refreshState();
	}

	// SCREEN side: converts the display bank to RGBA. It does not touch the hardware, so it
	// can be called at the monitor rate, twice, or not at all, without moving the emulation.
	// It rereads the geometry because it composes against the registers as they are now.
	// 'prioVdp2' is the VDP2's per-pixel priority buffer (vdp2.priorities): without
	// it there is nothing to resolve sprite priority against and it composes permissively.
	// 'fbVdp2' is the VDP2's RGBA framebuffer (vdp2.fb): color calculation needs it,
	// since it blends the sprite AGAINST the background. Without background there is no blend and it composes opaque.
	// 'shadowOk' (vdp2.shadowOk) says, per pixel, whether the layer left in front ACCEPTS
	// shadow (its bit in SDCTL). The VDP1 does not know WHICH layer painted each pixel -only with what
	// priority-, so without this buffer it cannot decide whether to darken.
	// 'geoBank' ({width, height, bpp}) is the geometry the bank about to be read WAS RASTERIZED
	// WITH, and it is mandatory in worker mode. Without it TVMR is reread from the bus, i.e. the
	// state of NOW, while the bank that came from the worker was drawn with the TVMR of
	// one or two frames ago: if the game changed framebuffer mode in between (512x256 ↔
	// 1024x256 ↔ 512x512), the bank is read with the wrong width and the image comes out split,
	// shifted or with pieces of another part of the bank.
	// And it is ERRATIC by nature: it depends on whether the mode change fell between the snapshot and
	// the worker's reply, so it appears and disappears with no pattern. It is the race that
	// SF Alpha uncovers by switching from 352x240 to 320x224 to 352x224 (Sebas, 26/27-07-2026,
	// translated: "with the worker it ran badly, it's erratic"). In synchronous mode it does not exist:
	// there it rasterizes and composes in the same instant, and that is why no 1-to-1 probe could see it.
	compose(prioVdp2, fbVdp2, shadowOk, geoBank)   //!wip, 16-07-2026
	{
		if(geoBank)
		{
			this._fbWidth = geoBank.width; this._fbHeight = geoBank.height; this._fbBpp = geoBank.bpp;
			this._interlaced = geoBank.interlaced || 1;
		}
		else this._configureGeometry();
		this._cramMode = this._readModeCram();
		return this._composeOutput(prioVdp2, fbVdp2, shadowOk);  // display bank -> RGBA
	}

	// Whole frame (console + screen). The emulator calls the two halves
	// separately; this stays for the tests and for anyone who wants them together.
	render()
	{
		this.plot();
		return this._composeOutput();
	}

	// TVMR sets the size and depth of the bank (VIDSoftVdp1DrawStartBody).
	_configureGeometry()
	{
		const tvmr = this._tvmr();
		this._interlaced = (this._fbcr() & 0x8) ? 2 : 1;   // DIE: double interlace
		if(tvmr & 0x1)   // TVM0: 8 bits per pixel framebuffer
		{
			if(tvmr & 0x2) { this._fbWidth = 512;  this._fbHeight = 512; }   // TVM1: rotation
			else           { this._fbWidth = 1024; this._fbHeight = 256; }   // normal high resolution
			this._fbBpp = 1;
		}
		else             // 16 bits per pixel: RGB555 with MSB or palette index
		{
			this._fbWidth = 512; this._fbHeight = 256; this._fbBpp = 2;
		}
	}

	// VDP2 Color RAM mode (RAMCTL bits 12-13). Only used for the output.
	_readModeCram()
	{
		const r = this.bus.vdp2Regs;
		if(!r) return 0;
		return (((r[0x0E] << 8) | r[0x0F]) >> 12) & 0x3;
	}

	// OUTPUT geometry (this.width/this.height): it is NOT set by the VDP1, it is set by the
	// VDP2's TVMD (180000H), because on the HW the one that reads the VDP1 framebuffer and puts
	// it on screen is the VDP2. It is decoded here, against bus.vdp2Regs, for the same reason that
	// _readModeCram() and _composeOutput() read RAMCTL and SPCTL: the VDP1 output depends
	// on the VDP2 config and this file already reads it straight from the bus.
	// The HRESO/VRESO tables and the reason for the hi-res crop are in vdp2.js
	// (_configureResolution).
	// It MUST match vdp2.width/vdp2.height: index.html composes the two
	// outputs pixel by pixel onto the SAME ImageData (drawTv()), so if the widths
	// do not match the sprites come out shifted diagonally.
	//ok, 16-07-2026
	_configureResolutionTv()
	{
		// The geometry comes from the BUS (bus.tvGeometry), which is the only source: the VDP2 uses
		// exactly the same one. Having it copied here was the bug of 25-07-2026 — the hi-res
		// debt was paid off in vdp2.js and this file was left with the crop to half,
		// so the VDP2 rasterized 640 and the VDP1 320 onto the same image.
		const g = this.bus.tvGeometry ? this.bus.tvGeometry() : null;
		if(!g) return;
		const width = g.width, height = g.height;
		if(width === this.width && (height < 0 || height === this.height)) return;
		this.width = width;
		if(height >= 0) this.height = height;
		this.fb = new Uint8ClampedArray(this.width * this.height * 4);
	}

	// PTMR: 00B = idle, 01B = plot on write, 10B = plot on every frame change.
	// The two modes are NOT sampled the same way:
	//   - PTM=10B: drawing begins automatically at the start of the frame. It is a
	//     LEVEL and it is sampled here, once per frame. We look at BIT 1 and not "== 2"
	//     to also cover the forbidden 11B, same as Mednafen (md_vdp1.c:988,
	//     if(PTMR & 0x2) StartDrawing() on the frame-change path).
	//   - PTM=01B: drawing begins when the register is WRITTEN. It is an EDGE: one
	//     drawing per write. The one that sees the write is the bus, so the edge is
	//     detected by the PTMR hook in bus.js -same pattern as FBCR- and here the
	//     request is only consumed. Sampling the level was the bug: a game that writes
	//     PTMR=1 and then PTMR=0 lost the drawing forever.
	// The request is ALWAYS consumed, even if PTM is 10B, so that it does not leak into a
	// later frame and trigger an extra drawing.
	_mustPlot()
	{
		const request = this.bus.vdp1PlotRequest;
		this.bus.vdp1PlotRequest = false;
		return (this._ptmr() & 0x2) !== 0 || request;
	}

	// EraseFrameBuffer: paints with EWDR the rectangle (EWLR)-(EWRR) of the draw
	// bank. Literal port of VIDSoftVdp1EraseFrameBuffer (vidsoft.c):
	//    if(((regs->FBCR & 2) == 0) || manualerase) { ...erase...; manualerase = 0; }
	// FCM=0 is "1-cycle mode" and erases on every plot. With FCM=1 the erase is on the
	// EDGE and only happens if someone asked for it: the FBCR write with (val&3)==2,
	// or the VBE at the close of the previous frame (see _buildEraseVBlank).
	_erase()
	{
		if((this._fbcr() & 0x2) !== 0 && !this.bus.vdp1EraseManual) { this.lastErase = false; return false; }

		// In worker mode the actual fill is done by the worker on ITS banks; here only
		// the request is consumed and the trace is left (lastErase), as always.
		if(!this.workerMode)
		{
			const fb = this.bus.vdp1Fb;
			const ewdr = this._ewdr(), ewlr = this._ewlr(), ewrr = this._ewrr();
			const x1 = (ewlr >> 6) & 0x1F8;      // ((EWLR >> 9) & 0x3F) * 8
			const y1 = ewlr & 0x1FF;
			let h = (ewrr & 0x1FF) + 1;
			if(h > this._fbHeight) h = this._fbHeight;

			// The rectangle is painted with ONE repeated value over contiguous rows, so
			// the first row is written and the rest are block-copied with copyWithin.
			// It used to be one call to _fbWrite PER PIXEL: at 352x224 that is 78,848
			// calls per erase, and since the VBE fix (27-07-2026) SF Alpha erases
			// on EVERY frame, not once in a while. Bit-identical by construction: the
			// exact same bytes are written in the same memory order.
			if(this._fbBpp === 2)
			{
				let w = ((ewrr >> 6) & 0x3F8) + 8;   // ((EWRR >> 9) & 0x7F) * 8 + 8
				if(w > this._fbWidth) w = this._fbWidth;
				if(w > x1 && h > y1)
				{
					const hi = (ewdr >> 8) & 0xFF, lo = ewdr & 0xFF;
					const o0 = (y1 * this._fbWidth + x1) * 2;
					const bytesWidth = (w - x1) * 2;
					if(hi === lo) fb.fill(hi, o0, o0 + bytesWidth);
					else for(let o = o0; o < o0 + bytesWidth; o += 2){ fb[o] = hi; fb[o + 1] = lo; }
					const step = this._fbWidth * 2;
					for(let y = y1 + 1; y < h; y++)
						fb.copyWithin(o0 + (y - y1) * step, o0, o0 + bytesWidth);
				}
			}
			else
			{
				//? In 8bpp Yabause recomputes the width as (EWRR >> 9) * 16 and does not
				//? clamp it again (it gets away with a per-pixel range check). Here we
				//? clamp it to the bank width, which is equivalent and does not overflow rows.
				let w = (ewrr >> 9) * 16;
				if(w > this._fbWidth) w = this._fbWidth;
				const v = ewdr & 0xFF;
				for(let y = y1; y < h; y++)
				{
					const o = y * this._fbWidth;
					if(w > x1) fb.fill(v, o + x1, o + w);
				}
			}
		}
		this.bus.vdp1EraseManual = false;
		this.lastErase = true;
		return true;
	}

	// VBE (TVMR bit 3): with manual bank change, the erase is requested by the VBlank.
	// Port of Vdp2VBlankOUT (vdp2.c), which evaluates it AFTER the frame's plot:
	//    if((Vdp1Regs->FBCR & 2) && (Vdp1Regs->TVMR & 8)) manualerase = 1;
	// That is: it arms the erase of the NEXT frame, not the current one.
	_buildEraseVBlank()
	{
		if((this._fbcr() & 0x2) && (this._tvmr() & 0x8)) this.bus.vdp1EraseManual = true;
	}

	// SwapFrameBuffer: literal port of VIDSoftVdp1SwapFrameBuffer (vidsoft.c):
	//    if(((Vdp1Regs->FBCR & 2) == 0) || manualchange) { swap; manualchange = 0; }
	// FCM=0 swaps on every frame. With FCM=1 the change is on the EDGE: only if the
	// FBCR write asked for it (bus.vdp1ChangeManual, see the hook in bus.js), and the
	// request is consumed. Sampling the level here was the ghosting bug: with FBCR=3
	// held, it swapped on every frame instead of only once.
	// Swaps CONTENTS, not references (see the constructor comment).
	_swapBanks()
	{
		if((this._fbcr() & 0x2) !== 0 && !this.bus.vdp1ChangeManual) { this.lastSwap = false; return false; }

		// In worker mode the copies do not run: the banks with real content live in the
		// worker (which does this same swap on its own) and _fbDisplay is overwritten by its
		// reply. The latches and flags below do run, since they are what the CPU observes.
		if(!this.workerMode)
		{
			const fb = this.bus.vdp1Fb;
			this._fbTmp.set(fb);
			fb.set(this._fbDisplay);
			this._fbDisplay.set(this._fbTmp);
		}
		this.bus.vdp1ChangeManual = false;
		this.lastSwap = true;
		// LOPR: the bank change LATCHES COPR (the address of the last command
		// processed in this frame). The register is written in the next plot();
		// see the long comment up above.
		this._loprPending = this._reg(0x14);
		return true;
	}

	// Status registers maintained by the VDP1 itself (the rest are written by the CPU).
	// MODR = version 1 + PTM1 + FBCR(bits 4-1) + TVMR(bits 3-0), see Vdp1ReadWord.
	_refreshState()
	{
		this._setReg(0x16, 0x1000 | ((this._ptmr() & 0x2) << 7) | ((this._fbcr() & 0x1E) << 3) | (this._tvmr() & 0xF));
	}

	// Walks the VDP1 command table and draws (see Vdp1DrawCommands in vdp1.c).
	// ★ REENTRANT WITH A BUDGET (29-07-2026). Walks the list consuming up to
	// `budget` commands and, if it did not reach END, SAVES THE STATE and returns false so that
	// the caller resumes it. With `budget = Infinity` -the default- it behaves EXACTLY
	// as before: a single pass from start to end.
	//
	// WHY THIS IS THE BASE OF THREE DEBTS AT ONCE. All three ask for the same thing -that the VDP1
	// consume the list SPREAD OUT and not in one go- and that is why "they get paid off together or not at all":
	//   1. COPR advancing during drawing. On hardware the address value is continually
	//      updated during command processing. Today it is set in one go on the last command.
	//   2. ENDR (0x10000C). It forces termination of the drawing currently being processed.
	//      Today it can do nothing because at the instant the game writes it there is
	//      NEVER a drawing in progress: the frame's has already finished and the next one's has not started.
	//   3. The pseudo draw continuation: splitting a large drawing over two frames.
	//
	// ⚠ AND WHAT THIS STEP DOES NOT DO, said plainly: drawing still starts and ends inside
	// the same call to plot(), which runs WHEN THE FRAME CLOSES. Spreading it over the console's
	// TIME requires moving the start to the trigger, and that touches the whole frame model of this
	// file -the swap runs one frame early and BEF/LOPR/CEF are calibrated around
	// that- plus the worker path. It is the next step; this one leaves the machinery ready and
	// verifiable without changing a pixel.
	//ok, 29-07-2026
	_drawCommands(budget = Infinity)
	{
		// If there is a drawing IN PROGRESS, it is resumed where it left off instead of restarting.
		if(!this._activeDraw)
		{
			// Start of drawing: CEF is reset to '0'
			// when the frame buffers are changed or when drawing is started. ONLY the
			// CEF <- 0 goes here: the BEF <- CEF is triggered by the BANK CHANGE and lives in plot().
			// Mednafen does exactly this in StartDrawing() (md_vdp1.c:848, EDSR &= ~0x2).
			this._setReg(0x10, this._reg(0x10) & ~0x2);
			this._setReg(0x14, 0);

			// localX/localY are NOT reset: like the clipping, they are register state and
			// persist between frames (Vdp1Draw() only resets addr, EDSR and COPR). In
			// practice every list starts with a Local Coordinate command anyway.
			this.commandsDrawn = 0;
			this._drawAddr = 0; this._drawGuard = 0; this._drawReturn = -1;
			this.pxFrame = 0;
			this._activeDraw = true;
		}

		let addr = this._drawAddr, guard = this._drawGuard, addrReturn = this._drawReturn;
		this._pxSegment = 0;   // pixels put in THIS segment (charged by _putpixel)
		//? Yabause cuts at 2000 commands and marks it as "fix me"; we keep the
		//? 4000 limit this file already had so as not to truncate long lists.
		while(guard++ < 4000)
		{
			// Budget exhausted and the list did NOT finish: the state is saved and we exit WITHOUT
			// raising CEF and WITHOUT Draw End, which is correct — CEF is set when
			// the draw end command is FETCHED, and it has not been fetched yet.
			// The budget is measured in PIXELS ACTUALLY PUT (_pxSegment, which _putpixel
			// increments). It is checked BETWEEN commands, so a segment can overshoot by what
			// the last one costs — which is what the hardware does: it does not split a command in half.
			//
			// ⚠ AND IN WORKER MODE THIS CHARGING CANNOT WORK, which is the architectural
			// limitation of the spreading: there the draw commands do NOT rasterize on this thread
			// (the pixels are put by the worker), so _putpixel is not called and _pxSegment stays
			// at 0. With a finite budget the walk would never cut.
			// It is not papered over with the area estimate: it was measured and it underestimates the peaks at 14-40%
			// (see _commandCost). A budget that underestimates is worse than none.
			// For the spreading to exist on the browser path, the WORKER has to
			// spread too -that is, reply in segments-, and that is redesigning the
			// VDP1<->worker coupling, not adding a line here.
			if(this._pxSegment >= budget)
			{
				this._drawAddr = addr; this._drawGuard = guard - 1; this._drawReturn = addrReturn;
				this._setReg(0x14, (addr >> 3) & 0xFFFF);   // COPR: where it really stopped
				return false;
			}
			const ctrl = this._r16(addr);
			if(ctrl & 0x8000) break;                 // END bit: end of the list
			if(!(ctrl & 0x4000))                     // SKIP bit: if it is not set, it is drawn
			{
				const type = ctrl & 0x000F;
				const cmd = this._readCommand(addr);
				// pxFrame keeps the area estimate: it serves as an order of magnitude for the
				// probes, and in worker mode it is the only thing available. It does NOT drive the budget.
				this.pxFrame += this._commandCost(type, cmd);
				// In worker mode the DRAW commands (0x0-0x7) do not rasterize here: the
				// pixels are put by the worker with this same state. The system ones
				// (clipping/local coords) DO run, because they are register state that
				// persists between frames; and the whole walk runs anyway, because out of it
				// come COPR, CEF and the Draw End that the CPU waits for in console time.
				switch(type)
				{
					case 0x0: if(!this.workerMode) this._spriteNormal(cmd); break;
					case 0x1: if(!this.workerMode) this._spriteScaled(cmd); break;
					case 0x2:
					case 0x3: if(!this.workerMode) this._spriteDistorted(cmd); break;   // 3 = undocumented mirror of 2
					case 0x4: if(!this.workerMode) this._polygon(cmd); break;
					case 0x5:
					case 0x7: if(!this.workerMode) this._polyline(cmd); break;             // 7 = undocumented mirror of 5
					case 0x6: if(!this.workerMode) this._line(cmd); break;
					case 0x8:
					case 0xB: this._userClipping(cmd); break;          // B = undocumented mirror of 8
					case 0x9: this._systemClipping(cmd); break;
					case 0xA: this._localCoordinate(cmd); break;
					// Invalid command (0xC-0xF): aborts the list WITHOUT CEF and WITHOUT interrupt.
					// HERE THE HARDWARE PROVES YABAUSE WRONG. When the draw end command is
					// fetched, the VDP1 sets CEF to '1' and generates an interrupt
					// signal -the trigger is THE FETCH OF THE END COMMAND, not
					// "the list ran out"- and, even more explicitly: when there is no draw
					// end command in VRAM, or when there is one and it is defined by the jump
					// mode such that it cannot be fetched, CEF REMAINS '0'. An
					// invalid command cuts the list before reaching END: END is never
					// fetched, so CEF stays at 0 and there is no Draw End.
					// Yabause fires EDSR |= 2 + Vdp1DrawEnd() unconditionally here
					// (vdp1.c:507-510). Mednafen follows the hardware: on (CommandData[0] & 0xF)
					// >= 0xC it does "DrawingActive = false; goto Breakout;", without CEF and without IRQ,
					// and keeps the EDSR |= 0x2 + SCU_SetInt() for the END bit path
					// (md_vdp1.c:770-776). We go with the hardware.
					// LOPR does not go here either (it was another Yabause-ism): it is written
					// when the frame buffer is changed, and plot() takes care of that.
					default:
						this._setReg(0x14, (addr >> 3) & 0xFFFF);      // COPR: in the
						// case of draw forced termination, this is the address (divided by 8H)
						// of the abnormally ended command table.
						// The drawing FINISHED (badly): without CEF and without Draw End, but finished — if
						// it stayed active, the next segment would resume it and walk it again.
						this._activeDraw = false;
						return true;
				}
				this.commandsDrawn++;
			}

			// Jump (JP, bits 12-13): 0=NEXT, 1=ASSIGN(CMDLINK), 2=CALL, 3=RETURN.
			switch((ctrl >> 12) & 0x3)
			{
				case 0: addr = (addr + 0x20) >>> 0; break;
				case 1: addr = (this._r16(addr + 2) * 8) >>> 0; break;
				case 2:
					if(addrReturn === -1) addrReturn = (addr + 0x20) >>> 0;
					addr = (this._r16(addr + 2) * 8) >>> 0;
					break;
				case 3:
					if(addrReturn !== -1) { addr = addrReturn; addrReturn = -1; }
					else addr = (addr + 0x20) >>> 0;
					break;
			}
		}

		// End of drawing: CEF <- 1 and COPR stays at the last processed command.
		//? COPR is set in one go on the last command. On the chip it ADVANCES during
		//? drawing (the address value is continually updated during command
		//? processing), which is what is needed for the "pseudo draw continuation" and
		//? for ENDR to be able to abort mid-list. That requires consuming the list
		//? spread over the frame, which is the same debt as the Draw End by cost
		//? (see bus.vdp1EndDraw, where the measurement of the attempt that failed is).
		this._setReg(0x10, this._reg(0x10) | 2);
		this._setReg(0x14, (addr >> 3) & 0xFFFF);
		// Sprite Draw End: the hardware signals through the SCU that it finished the list. The
		// games' engines write a flag, start the plot and wait for the
		// handler to clear it; without this interrupt they spin forever.
		// Yabause sends it at the same point (vdp1.c, Vdp1Draw: EDSR |= 2 -> ScuSendDrawEnd).
		//? And at the same instant as the drawing, which is what the chip does NOT do. We tried
		//? delaying it by the list's cost and it broke: see bus.vdp1EndDraw.
		this.bus.vdp1EndDraw();
		this._activeDraw = false;
		return true;
	}

	// ★ COST OF A COMMAND IN PIXELS, without drawing it. It is the metric that the
	// budget of _drawCommands() was missing: with this the spreading can be PER PIXEL, which is the
	// chip's unit.
	//
	// The VDP1 draws parts in the frame buffer **1 pixel at a time**, and
	// its operating clock is 28 MHz. So the cost of a
	// list in cycles is, to a first approximation, its pixel count.
	//
	// WHY IT IS COMPUTED FROM THE AREA INSTEAD OF COUNTING THE PIXELS PUT: in worker mode the
	// draw commands do NOT rasterize on this thread -the pixels are put by the worker-, so
	// counting in _putpixel would give ZERO exactly on the browser path. The area comes from the
	// command's coordinates, which are available in both modes.
	//
	// ⚠ THE FIRST ATTEMPT USED `this._charWidth`, AND IT WAS WRONG: those fields are set by
	// _precomputeCommand PER SCANLINE, so when costing a command they still hold the size
	// of the PREVIOUS one. Now it comes from the command's own CMDSIZE.
	//
	// ⚠⚠⚠ MEASURED AGAINST THE REAL PIXELS, AND **IT DOES NOT WORK AS A TIME BUDGET**.
	// (The 8 bpp double-counting defect that diag/vdp1-load.mjs had WAS ALREADY FIXED
	// -today it wraps only _putpixel-, so its numbers are good and can be compared.)
	//
	//              REAL pixels (avg/peak)       estimated here     ratio
	//   xmenvs         88,790 / 178,621          50,712 / 71,140    57% / 40%
	//   touring        10,307 / 109,397          11,914 / 15,447   116% / 14%
	//
	// It UNDERESTIMATES the peaks at 14-40%, which is the BAD side of the error for a budget: the
	// spreading would believe the list is cheaper than it is and would not cut when it has to
	// cut.
	//
	// AND THE REASON IS HARDWARE, not a bug in the math: the VDP1 rasterizer walks
	// SCANLINES OF THE QUAD (see _spriteDistorted -> _drawLine, "total" scanlines from
	// (xL,yL) to (xR,yR)), so it **overdraws**: on a slanted quad the same pixel is painted
	// several times, and the hardware pays for every pass. The geometric area cannot see that.
	//
	//? The metric that WOULD work is counting the rasterizer's passes without painting -that is,
	//? walking the quad's scanlines and adding up their lengths, which is what _iterateLine does-.
	//? It is half of the rasterizing, so we have to measure what it costs before putting it in.
	//? The other route is for the WORKER to report the pixels it put, but that would arrive a frame
	//? late and using it would be a heuristic, not the cost.
	//
	// That is why `pxFrame` stays computed and EXPOSED but **NOBODY CONSUMES IT**: it serves as an
	// order of magnitude and for the probes, not for charging time.
	//
	//? It is still a BOUND and not the exact cost: the bounding box of a distorted quad is
	//? larger than the pixels that get painted, a sprite with transparency paints less than its
	//? rectangle, and clipping crops. The exact cost would require rasterizing, which is exactly
	//? what this is meant to avoid. What matters about a budget is that it does NOT UNDERESTIMATE.
	//ok, 29-07-2026
	_commandCost(type, cmd)
	{
		// CMDSIZE (offset 0x0A): bits 13-8 = width/8, bits 7-0 = height. From the COMMAND, not from the
		// scanline state.
		const charWidth = ((cmd.size >> 8) & 0x3F) * 8;
		const charHeight  = cmd.size & 0xFF;
		switch(type)
		{
			case 0x0:   // normal sprite: drawn at the char's size
				return Math.abs(charWidth * charHeight) || 1;
			case 0x1:   // SCALED sprite: the on-screen size comes from the coordinates, and
			{           // it can be several times the char's (that is why CMDSIZE is not enough).
				const w = Math.abs(cmd.xc - cmd.xa) + 1, h = Math.abs(cmd.yc - cmd.already) + 1;
				// The LARGER of the two is taken: with the zoom point mode the rectangle can
				// come in (xb,yb) instead of (xa,xc), and underestimating is the error we cannot
				// afford.
				return Math.max(Math.abs(w * h), Math.abs(charWidth * charHeight)) || 1;
			}
			case 0x2:
			case 0x3:   // distorted sprite: bounding box of the quad (A,B,C,D)
			case 0x4:   // polygon: same
			{
				const xs = [cmd.xa, cmd.xb, cmd.xc, cmd.xd];
				const ys = [cmd.already, cmd.yb, cmd.yc, cmd.yd];
				const w = Math.max(...xs) - Math.min(...xs);
				const h = Math.max(...ys) - Math.min(...ys);
				return Math.abs(w * h) || 1;
			}
			case 0x5:
			case 0x7:   // polyline: the four sides
			case 0x6:   // line: one side. Chebyshev, which is what Bresenham walks.
			{
				const sec = (x1, y1, x2, y2) =>
					Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
				if(type === 0x6) return sec(cmd.xa, cmd.already, cmd.xb, cmd.yb) || 1;
				return (sec(cmd.xa, cmd.already, cmd.xb, cmd.yb)
					+ sec(cmd.xb, cmd.yb, cmd.xc, cmd.yc)
					+ sec(cmd.xc, cmd.yc, cmd.xd, cmd.yd)
					+ sec(cmd.xd, cmd.yd, cmd.xa, cmd.already)) || 1;
			}
			default:    // clipping and local coords paint nothing, but they cost their fetch
				return 1;
		}
	}

	// --- System commands ---

	_localCoordinate(cmd) { this.localX = cmd.xa; this.localY = cmd.already; }

	// User clipping: rectangle (XA,YA)-(XC,YC).
	_userClipping(cmd)
	{
		this.userX1 = cmd.xa; this.userY1 = cmd.already;
		this.userX2 = cmd.xc; this.userY2 = cmd.yc;
	}

	// System clipping (command type 0x9): sets ONLY the lower-right corner (XC,YC).
	// The upper-left one is not set because the HW has it FIXED at (0,0) and the command
	// does not even carry fields for it. The lower-right
	// coordinates of the clipping area are defined by CMDXC, CMDYC and the upper-left
	// coordinates are fixed at (0,0); the coordinates are specified by defining the
	// values of the lower-right coordinates (XC, YC) in the command table, SINCE THE
	// UPPER-LEFT COORDINATES ARE FIXED AT (0,0).
	//? Here lived a sysX1 and a sysY1 that were written with 0 and read by NOBODY (they
	//? were caught by orphans.mjs). They were not a lost clip: they were a copy of Yabause, which
	//? has the same dead pair (vdp1.h:48-49; written in vidsoft.c:2384-2385 and
	//? 3431-3432 and NEVER read, because its IsSystemClipped compares against the literal
	//? 0 just like our _sysClipped, vidsoft.c:2691-2696). Mednafen simply
	//? does not have them: only VDP1_SysClipX/SysClipY, which are the lower-right corner
	//? (md_vdp1.c:291-294). Deleted: connecting them to the clip would have encoded a model
	//? of false HW (that the corner can move) to silence the detector. //ok, 16-07-2026
	_systemClipping(cmd)
	{
		this.sysX2 = cmd.xc; this.sysY2 = cmd.yc;
	}

	// --- Sprite draw commands ---

	_spriteNormal(cmd)
	{
		const w = ((cmd.size >> 8) & 0x3F) * 8;
		const h = cmd.size & 0xFF;
		const tlx = cmd.xa + this.localX, tly = cmd.already + this.localY;
		const trx = tlx + (w - 1), try_ = tly;
		const brx = tlx + (w - 1), bry = tly + (h - 1);
		const blx = tlx, bly = tly + (h - 1);
		this._drawQuad(cmd, tlx, tly, blx, bly, trx, try_, brx, bry);
	}

	// Scaled sprite: uses the zoom point (CMDCTRL bits 8-11) or two coordinates.
	_spriteScaled(cmd)
	{
		let x0 = cmd.xa + this.localX, y0 = cmd.already + this.localY;
		let x1, y1;
		switch((cmd.ctrl >> 8) & 0xF)
		{
			case 0x0: default:                         // only two coordinates (A and C)
				x1 = cmd.xc - x0 + this.localX + 1; y1 = cmd.yc - y0 + this.localY + 1; break;
			case 0x5: x1 = cmd.xb + 1; y1 = cmd.yb + 1; break;                       // top-left
			case 0x6: x1 = cmd.xb; y1 = cmd.yb; x0 -= (x1 / 2) | 0; x1++; y1++; break;   // top-center
			case 0x7: x1 = cmd.xb; y1 = cmd.yb; x0 -= x1; x1++; y1++; break;             // top-right
			case 0x9: x1 = cmd.xb; y1 = cmd.yb; y0 -= (y1 / 2) | 0; x1++; y1++; break;   // center-left
			case 0xA: x1 = cmd.xb; y1 = cmd.yb; x0 -= (x1 / 2) | 0; y0 -= (y1 / 2) | 0; x1++; y1++; break;  // center
			case 0xB: x1 = cmd.xb; y1 = cmd.yb; x0 -= x1; y0 -= (y1 / 2) | 0; x1++; y1++; break;   // center-right
			case 0xD: x1 = cmd.xb; y1 = cmd.yb; y0 -= y1; x1++; y1++; break;             // bottom-left
			case 0xE: x1 = cmd.xb; y1 = cmd.yb; x0 -= (x1 / 2) | 0; y0 -= y1; x1++; y1++; break;   // bottom-center
			case 0xF: x1 = cmd.xb; y1 = cmd.yb; x0 -= x1; y0 -= y1; x1++; y1++; break;   // bottom-right
		}
		const tlx = x0, tly = y0;
		const trx = x1 + x0 - 1, try_ = tly;
		const brx = x1 + x0 - 1, bry = y1 + y0 - 1;
		const blx = tlx, bly = y1 + y0 - 1;
		this._drawQuad(cmd, tlx, tly, blx, bly, trx, try_, brx, bry);
	}

	// Distorted sprite: arbitrary quad A,B,C,D. drawQuad(A, D, B, C).
	_spriteDistorted(cmd)
	{
		const xa = cmd.xa + this.localX, already = cmd.already + this.localY;
		const xb = cmd.xb + this.localX, yb = cmd.yb + this.localY;
		const xc = cmd.xc + this.localX, yc = cmd.yc + this.localY;
		const xd = cmd.xd + this.localX, yd = cmd.yd + this.localY;
		this._drawQuad(cmd, xa, already, xd, yd, xb, yb, xc, yc);
	}

	// Polygon: 4-vertex quad, untextured, flat color from CMDCOLR (+optional gouraud).
	_polygon(cmd)
	{
		const xa = cmd.xa + this.localX, already = cmd.already + this.localY;
		const xb = cmd.xb + this.localX, yb = cmd.yb + this.localY;
		const xc = cmd.xc + this.localX, yc = cmd.yc + this.localY;
		const xd = cmd.xd + this.localX, yd = cmd.yd + this.localY;
		this._drawQuad(cmd, xa, already, xd, yd, xb, yb, xc, yc);
	}

	// Polyline: four lines A-B, B-C, C-D, D-A with per-vertex gouraud.
	_polyline(cmd)
	{
		const X = [ cmd.xa + this.localX, cmd.xb + this.localX, cmd.xc + this.localX, cmd.xd + this.localX ];
		const Y = [ cmd.already + this.localY, cmd.yb + this.localY, cmd.yc + this.localY, cmd.yd + this.localY ];
		this._loadGouraud(cmd);
		this._lineGouraud(cmd, X[0], Y[0], X[1], Y[1], this._grd[0], this._grd[1]);
		this._lineGouraud(cmd, X[1], Y[1], X[2], Y[2], this._grd[1], this._grd[2]);
		this._lineGouraud(cmd, X[3], Y[3], X[2], Y[2], this._grd[3], this._grd[2]);
		this._lineGouraud(cmd, X[0], Y[0], X[3], Y[3], this._grd[0], this._grd[3]);
	}

	// Simple line A-B with gouraud A->B.
	_line(cmd)
	{
		const x1 = cmd.xa + this.localX, y1 = cmd.already + this.localY;
		const x2 = cmd.xb + this.localX, y2 = cmd.yb + this.localY;
		this._loadGouraud(cmd);
		this._lineGouraud(cmd, x1, y1, x2, y2, this._grd[0], this._grd[1]);
	}

	// --- Gouraud ---

	_loadGouraud(cmd)
	{
		const base = (cmd.grda << 3) >>> 0;
		for(let i = 0; i < 4; i++)
		{
			const w = this._r16(base + i * 2);
			this._grd[i] = { r: w & 0x1F, g: (w >> 5) & 0x1F, b: (w >> 10) & 0x1F };
		}
	}

	_gouraudAdjust(color, tableValue)
	{
		color += (tableValue - 0x10);
		if(color < 0) color = 0;
		if(color > 0x1F) color = 0x1F;
		return color;
	}

	// Mask of the index's significant bits according to the color mode (the global
	// currentPixelIsVisible of vidsoft.c). _putpixel uses it to know whether the pixel
	// is the transparent code (index 0) before applying the color bank.
	_maskVisible(mode)
	{
		switch(mode)
		{
			case 0x0: return 0xF;      // 16 colors, bank
			case 0x1: return 0xFFFF;   // 16 colors, LUT (the value is already a color)
			case 0x2: return 0x3F;     // 64 colors
			case 0x3: return 0x7F;     // 128 colors
			case 0x4: return 0xFF;     // 256 colors
			case 0x5:
			case 0x6: return 0xFFFF;   // 16-bit RGB
		}
		return 0;   //? mode 7 forbidden and no HW data: we leave it invisible
	}

	// Precomputes everything that depends ONLY on the command (not on the pixel): type, color mode,
	// SPD, end codes, flip, texture address, bank and LUT, mesh, MSBON, blend
	// sub-mode. It is called ONCE per scanline from _drawLine -the only entry point to
	// per-pixel drawing-, instead of being recomputed a million times per pixel inside
	// _getpixel/_putpixel. It is the hoisting of the hot path's invariants.
	_precomputeCommand(cmd)
	{
		const ctrl = cmd.ctrl, pmod = cmd.pmod, colr = cmd.colr;
		const type = ctrl & 0x7;
		this._gpIsTextured = !(type === 4 || type === 5 || type === 6);
		this._gpSPD = (pmod & 0x40) !== 0;
		this._gpEndsOn = (pmod & 0x80) === 0;
		this._gpMode = (pmod >> 3) & 0x7;
		this._gpFlip = (ctrl >> 4) & 0x3;
		this._gpAddrChar = (cmd.srca << 3) >>> 0;
		this._gpColorbank = colr;
		this._gpColorlut = (colr << 3) >>> 0;
		this._gpMaskVis = this._maskVisible(this._gpMode);
		this._gpMesh = (pmod & 0x0100) !== 0;
		this._gpMsbon = pmod & 0x8000;
		this._gpSubmode = pmod & 0x7;
	}

	// --- Texture sampling and color format (equivalent to getpixel) ---
	// Leaves the RAW 16-bit value in this._pixel and the index bit mask
	// in this._pixVisible. It does NOT resolve the color against CRAM: that happens only at
	// the output, same as on the HW. The command's invariants come already precomputed
	// in _precomputeCommand (this._gpXxx); here only what depends on the pixel.
	// Returns true if it detected an END CODE (the pixel is not drawn and the line is cut).
	_getpixel(numLine, lineIndex)
	{
		const mode = this._gpMode;

		// Polygon / polyline / line: the color comes flat from CMDCOLR and no
		// texture is read. Careful: the visibility mask is still the one of the color mode
		// of CMDPMOD, so a polygon whose low CMDCOLR bits are 0 and without
		// SPD is skipped. It is Yabause's behavior and therefore the one
		// expected by the games that depend on it.
		if(!this._gpIsTextured)
		{
			this._pixel = this._gpColorbank;
			this._pixVisible = this._gpMaskVis;
			return false;
		}

		const SPD = this._gpSPD, endsOn = this._gpEndsOn;
		let li = lineIndex, ln = numLine;
		const flip = this._gpFlip;
		if(flip === 1) li = this._charWidth - li - 1;
		else if(flip === 2) ln = this._charHeight - ln - 1;
		else if(flip === 3) { ln = this._charHeight - ln - 1; li = this._charWidth - li - 1; }

		const addrChar = this._gpAddrChar;
		const colorbank = this._gpColorbank;
		const colorlut = this._gpColorlut;
		let raw;

		switch(mode)
		{
			case 0x0:  // 16 colors, color bank (4 bpp)
				raw = this._readPattern16(addrChar + ln * (this._charWidth >> 1), li);
				if(endsOn && raw === 0xF) return true;
				if(!(raw === 0 && !SPD)) raw = (colorbank & 0xFFF0) | raw;
				this._pixel = raw; this._pixVisible = 0xF;
				return false;

			case 0x1:  // 16 colors, lookup table in VRAM (4 bpp)
				raw = this._readPattern16(addrChar + ln * (this._charWidth >> 1), li);
				if(endsOn && raw === 0xF) return true;
				if(!(raw === 0 && !SPD)) raw = this._r16((raw * 2 + colorlut) & 0x7FFFF);
				this._pixel = raw; this._pixVisible = 0xFFFF;
				return false;

			case 0x2:  // 64 colors (8 bpp), bank
				// END CODE in 64 colors: there is a HW bug that is not fully understood.
				// Yabause documents that with the "by the book" end code 63 (cutting the
				// line) dropouts appear that the HW does not have, and that without end code
				// white lines appear around Scud's sprites. The closest thing
				// to the HW they found is NOT cutting the line and leaving
				// index 63 as transparent (pixel 0). We keep that workaround.
				//? Still pending a test against real HW. Careful: with SPD=1 pixel 0
				//? is still written (it ends up black/transparent instead of being skipped),
				//? which is exactly what Yabause does.
				raw = this._r8(addrChar + ln * this._charWidth + li) & 0x3F;
				if(endsOn && raw === 63) raw = 0;
				if(!(raw === 0 && !SPD)) raw = (colorbank & 0xFFC0) | raw;
				this._pixel = raw; this._pixVisible = 0x3F;
				return false;

			case 0x3:  // 128 colors (8 bpp), bank
				raw = this._r8(addrChar + ln * this._charWidth + li) & 0x7F;
				if(endsOn && raw === 0xFF) return true;   // unreachable with the 7-bit mask, as in Yabause
				if(!(raw === 0 && !SPD)) raw = (colorbank & 0xFF80) | raw;   // Dead or Alive needs the masking
				this._pixel = raw; this._pixVisible = 0x7F;
				return false;

			case 0x4:  // 256 colors (8 bpp), bank
				raw = this._r8(addrChar + ln * this._charWidth + li) & 0xFF;
				if(endsOn && raw === 0xFF) return true;
				if(!(raw === 0 && !SPD)) raw = (colorbank & 0xFF00) | raw;
				this._pixel = raw; this._pixVisible = 0xFF;
				return false;

			case 0x5:  // Direct 16-bit RGB
			case 0x6:  // forbidden, behaves like 0x5 (used by Beach de Reach)
				raw = this._r16(addrChar + ln * this._charWidth * 2 + li * 2);
				if(endsOn && raw === 0x7FFF) return true;
				// The transparent pixel in 16bpp should be 0x0000, but some
				// games use invalid values and expect them to be transparent:
				// without MSB and without SPD -> 0.
				if(!(raw & 0x8000) && !SPD) raw = 0;
				this._pixel = raw; this._pixVisible = 0xFFFF;
				return false;
		}

		this._pixel = 0; this._pixVisible = 0;
		return false;
	}

	// 4 bpp: high nibble for the even pixel, low for the odd one.
	_readPattern16(base, offset)
	{
		let dot = this._r8(base + (offset >> 1));
		return (offset & 1) ? (dot & 0xF) : (dot >> 4);
	}

	// --- Clipping ---

	// User clipping DOES have both corners (CMDXA/YA and CMDXC/YC).
	_userClipped(x, y) { return !(x >= this.userX1 && x <= this.userX2 && y >= this.userY1 && y <= this.userY2); }
	// System clipping does NOT: its upper-left corner is FIXED at (0,0) by HW
	// (see _systemClipping), hence the literal 0. Points on
	// the clipping line are treated as being inside the clipping area and are drawn:
	// that is why the limits use <= and not <.
	_sysClipped(x, y)  { return !(x >= 0 && x <= this.sysX2 && y >= 0 && y <= this.sysY2); }

	_estaClipped(cmd, x, y)
	{
		if(cmd.pmod & 0x0400)   // user clipping enabled
		{
			let uc = this._userClipped(x, y);
			if(((cmd.pmod >> 9) & 0x3) === 0x3) uc = !uc;   // "outside the rectangle" mode
			return uc || this._sysClipped(x, y);
		}
		return this._sysClipped(x, y);
	}

	// CheckDil: in double interlace (FBCR bit 3 = DIE) only every other line is drawn
	// (one field); DIL (bit 2) picks which.
	_checkDil(y)
	{
		if(this._interlaced !== 2) return false;
		const dil = (this._fbcr() >> 2) & 1;
		return dil ? ((y & 1) === 0) : ((y & 1) !== 0);
	}

	// --- Pixel write to the draw bank (equivalent to putpixel) ---
	_putpixel(cmd, x, y)
	{
		// EXACT BUDGET CHARGING. The hardware does not estimate the list's cost in advance:
		// it draws 1 pixel at a time and stops when it runs out of time. So the
		// budget is charged HERE, per pixel actually put — which also includes the
		// OVERDRAW of the rasterizing by quad scanlines, which the hardware also pays and which
		// an area estimate cannot see (measured: it underestimated the peaks at 14-40%).
		//? This is on the hot path and its cost is NOT MEASURABLE on this machine: the A/B gives
		//? 11.48 against 10.72 ms minimum (7%), but runs of the SAME branch spread apart
		//? 15-25%, i.e. much more than the effect. And the repo rule says the criterion is the
		//? counterbalanced rep-by-rep SIGN, not the difference of minimums. What IS
		//? verified is that it does not change behavior: the bench-video hash stays identical
		//? (6b95c45d). It is an integer increment with no allocation; if some day the VDP1 becomes
		//? the measurable bottleneck, it is a candidate to revisit.
		this._pxSegment++;
		const yOrig = y;
		if(this._checkDil(y)) return;
		y = (y / this._interlaced) | 0;

		//? Yabause only checks the buffer's upper limit and lets an out-of-range x
		//? spill into the next row. Here we bound it to the bank
		//? geometry: it is equivalent when clipping is set up right and it avoids garbage.
		if(x < 0 || y < 0 || x >= this._fbWidth || y >= this._fbHeight) return;
		if(this._gpMesh && ((x ^ y) & 1)) return;    // mesh (checkerboard pattern)
		if(this._estaClipped(cmd, x, yOrig)) return;

		const idx = y * this._fbWidth + x;
		if(this._fbBpp === 1) { this._putpixel8(cmd, idx); return; }

		const fb = this.bus.vdp1Fb;
		const pix = this._pixel;
		const SPD = this._gpSPD;

		// MSBON (CMDPMOD bit 15): writes no color, only sets the MSB of the pixel that
		// was already in the framebuffer. That MSB is what later enables shadow and
		// half-transparency, and what the VDP2 reads as "sprite shadow" in sprite types
		// 2-7. It is the first stage of the VDP1->VDP2 shadow pipeline.
		if(this._gpMsbon)
		{
			if(pix) this._fbWrite(fb, idx, this._fbRead(fb, idx) | 0x8000);
			return;
		}

		if(!(SPD || (pix & this._pixVisible))) return;

		// THE FRAMEBUFFER PIXEL (dst) IS READ ONLY WHERE IT IS USED. Three of the
		// eight sub-modes use it —shadow (1), half-transparent (3) and gouraud+half-transparent
		// (7)— and it used to be read in ALL of them, i.e. one VRAM read plus one function
		// call per pixel thrown away in 100% of the Sonic video: measured,
		// 28,253,344 pixels in 300 frames, of which 76.1% replace and 23.9% gouraud
		// and ZERO needing dst (diag/vdp1-bench.mjs).
		switch(this._gpSubmode)   // blend sub-mode
		{
			case 0:  // replace
				if(!(pix === 0 && !SPD)) this._fbWrite(fb, idx, pix);
				break;

			case 1:  // shadow: darkens by half the pixel already in the
			         // framebuffer, and ONLY if it has the MSB set (that is, if it is
			         // an RGB color and not a palette index).
			{
				const dst = this._fbRead(fb, idx);
				if(dst & 0x8000) this._fbWrite(fb, idx, this._mix555(dst, 0) | 0x8000);
				break;
			}

			case 2:  // half luminance: half the brightness of the source color. The mask
			         // ~0x8421 drops the low bit of each component before the shift
			         // so that it does not leak into the neighboring component.
				this._fbWrite(fb, idx, ((pix & ~0x8421) >> 1) | 0x8000);
				break;

			case 3:  // half transparent: 50% blend with what is already in the bank,
			         // only if that pixel has the MSB. Since the bank persists between
			         // frames, it now really blends against the previous frame.
			{
				const dst = this._fbRead(fb, idx);
				if(dst & 0x8000) this._fbWrite(fb, idx, this._mix555(dst, pix) | 0x8000);
				else this._fbWrite(fb, idx, pix);
				break;
			}

			case 4:  // gouraud
				this._fbWrite(fb, idx, this._gouraudPixel(pix));
				break;

			//? 5 is FORBIDDEN (the combination does not exist among the encodings of
			//? bits 2-0) and there is no HW data: the closest DEFINED one is gouraud alone.
			case 5:
				this._fbWrite(fb, idx, this._gouraudPixel(pix));
				break;

			case 6:  // gouraud + half-luminance: FIRST the gouraud on the texture
			         // pixel, THEN half the brightness. This used to
			         // blend 50% the FLAT gouraud color against the texture — something else:
			         // the hardware chains the two operations on the same pixel.
				this._fbWrite(fb, idx, ((this._gouraudPixel(pix) & ~0x8421) >> 1) | 0x8000);
				break;

			default:  // 7: gouraud + half-transparent: the gouraud on the pixel and
			          // THEN the average against the framebuffer ONLY if the destination has
			          // the MSB (same rule as the pure half-transparent of case 3).
			{
				const g = this._gouraudPixel(pix);
				const dst = this._fbRead(fb, idx);
				if(dst & 0x8000) this._fbWrite(fb, idx, this._mix555(dst, g) | 0x8000);
				else this._fbWrite(fb, idx, g);
				break;
			}
		}
	}

	// Applies the current column's gouraud to an RGB555 pixel. Shared by
	// sub-modes 4, 5 (forbidden, it falls here), 6 and 7.
	_gouraudPixel(pix)
	{
		// Special case of the SGL "chrome" demo: in color bank modes, if green
		// and blue are left unused the INDEX is adjusted and not the RGB.
		const colorMode = this._gpMode;
		if(colorMode !== 5 && colorMode !== 1 && (this._colLeft.g | 0) === 16 && (this._colLeft.b | 0) === 16)
		{
			let c = (this._colLeft.r | 0) - 0x10;
			if(c < 0) c = 0;
			return (pix + c) & 0xFFFF;
		}
		return this._color555(
			this._gouraudAdjust(pix & 0x001F, this._colLeft.r | 0),
			this._gouraudAdjust((pix & 0x03E0) >> 5, this._colLeft.g | 0),
			this._gouraudAdjust((pix & 0x7C00) >> 10, this._colLeft.b | 0));
	}

	// 8-bit framebuffer (TVMR TVM0=1).
	//? Yabause resolves every blend mode as "replace" in 8bpp: there is no
	//? MSB to build shadow or half-transparency on.
	_putpixel8(cmd, idx)
	{
		const SPD = this._gpSPD;
		const pix = this._pixel & 0xFF;
		if(!(SPD || (pix & this._pixVisible))) return;
		if(!(pix === 0 && !SPD)) this.bus.vdp1Fb[idx] = pix;
	}

	// --- Line rasterizing (Bresenham, equivalent to iterateOverLine) ---
	// If cb is null, it only counts pixels and returns the length. greedy fills gaps.
	_iterateLine(x1, y1, x2, y2, greedy, cb)
	{
		let i = 0, a = 0;
		let dx = x2 - x1, dy = y2 - y1;
		const ax = (dx >= 0) ? 1 : -1;
		const ay = (dy >= 0) ? 1 : -1;

		// Giant shapes: cut so as not to hang (Burning Rangers).
		if(Math.abs(dx) > 999 || Math.abs(dy) > 999) return 0x7FFFFFFF;

		if(Math.abs(dx) > Math.abs(dy))
		{
			if(ax !== ay) dx = -dx;
			for(; x1 !== x2; x1 += ax, i++)
			{
				if(cb && cb(x1, y1, i) !== 0) return i + 1;
				a += dy;
				if(Math.abs(a) >= Math.abs(dx))
				{
					a -= dx; y1 += ay;
					if(greedy)
					{
						i++;
						if(ax === ay) { if(cb && cb(x1 + ax, y1 - ay, i) !== 0) return i + 1; }
						else { if(cb && cb(x1, y1, i) !== 0) return i + 1; }
					}
				}
			}
			if(cb) cb(x2, y2, i);
			i++;
		}
		else
		{
			if(ax !== ay) dy = -dy;
			for(; y1 !== y2; y1 += ay, i++)
			{
				if(cb && cb(x1, y1, i) !== 0) return i + 1;
				a += dx;
				if(Math.abs(a) >= Math.abs(dy))
				{
					a -= dy; x1 += ax;
					if(greedy)
					{
						i++;
						if(ay === ax) { if(cb && cb(x1, y1, i) !== 0) return i + 1; }
						else { if(cb && cb(x1 - ax, y1 + ay, i) !== 0) return i + 1; }
					}
				}
			}
			if(cb) cb(x2, y2, i);
			i++;
		}
		return i;
	}

	_interp(start, end, steps)
	{
		if(steps === 0) return 1;
		return (end - start) / steps;
	}

	// Draws a line sampling the texture and advancing the gouraud color.
	// numLine = texture Y coordinate; stepTex = texture X step per pixel.
	// stepR/G/B = gouraud increment per pixel for the left column.
	// Rasterizer hot path. It used to iterate with _iterateLine(...closure), but the closure
	// was NEW on every scanline and the _iterateLine call site is megamorphic (4 different
	// closures): V8 cannot inline the callback, so every pixel paid for an indirect
	// call. Here the Bresenham goes inline and the draw body is a FIXED method
	// (_pixelDraw) which, being always the same (monomorphic), V8 DOES inline. Same algorithm
	// as _iterateLine, with greedy and the cut on 2 end-codes.
	_drawLine(cmd, x1, y1, x2, y2, greedy, numLine, stepTex, stepR, stepG, stepB)
	{
		this._drawCmd = cmd; this._drawNumLine = numLine | 0; this._drawStepTex = stepTex;
		this._drawStepR = stepR; this._drawStepG = stepG; this._drawStepB = stepB;
		this._drawPreviousStep = 123456789; this._drawEnds = 0;
		this._precomputeCommand(cmd);   // hoists the command's invariants out of the pixel loop
		let i = 0, a = 0;
		let dx = x2 - x1, dy = y2 - y1;
		const ax = (dx >= 0) ? 1 : -1, ay = (dy >= 0) ? 1 : -1;
		if(Math.abs(dx) > 999 || Math.abs(dy) > 999) return;   // giant shapes: cut
		if(Math.abs(dx) > Math.abs(dy))
		{
			if(ax !== ay) dx = -dx;
			for(; x1 !== x2; x1 += ax, i++)
			{
				if(this._pixelDraw(x1, y1, i)) return;
				a += dy;
				if(Math.abs(a) >= Math.abs(dx))
				{
					a -= dx; y1 += ay;
					if(greedy) { i++; if(ax === ay) { if(this._pixelDraw(x1 + ax, y1 - ay, i)) return; } else { if(this._pixelDraw(x1, y1, i)) return; } }
				}
			}
			this._pixelDraw(x2, y2, i);
		}
		else
		{
			if(ax !== ay) dy = -dy;
			for(; y1 !== y2; y1 += ay, i++)
			{
				if(this._pixelDraw(x1, y1, i)) return;
				a += dx;
				if(Math.abs(a) >= Math.abs(dy))
				{
					a -= dy; x1 += ax;
					if(greedy) { i++; if(ay === ax) { if(this._pixelDraw(x1, y1, i)) return; } else { if(this._pixelDraw(x1 - ax, y1 + ay, i)) return; } }
				}
			}
			this._pixelDraw(x2, y2, i);
		}
	}

	// Per-pixel draw body (FIXED method -> monomorphic -> V8 inlines it). Advances the
	// column's gouraud, samples the texture and writes the pixel. Returns true to
	// cut the line when the texture's 2 end-codes were detected.
	_pixelDraw(x, y, i)
	{
		this._colLeft.r += this._drawStepR; this._colLeft.g += this._drawStepG; this._colLeft.b += this._drawStepB;
		const currentStep = (i * this._drawStepTex) | 0;
		if(this._getpixel(this._drawNumLine, currentStep))
		{
			if(currentStep !== this._drawPreviousStep) { this._drawPreviousStep = currentStep; if(++this._drawEnds === 2) return true; }
		}
		else this._putpixel(this._drawCmd, x, y);
		return false;
	}

	// Line with gouraud between two vertices of the table (for polyline/line).
	_lineGouraud(cmd, x1, y1, x2, y2, table1, table2)
	{
		const len = this._iterateLine(x1, y1, x2, y2, true, null);
		const stepR = this._interp(table1.r, table2.r, len);
		const stepG = this._interp(table1.g, table2.g, len);
		const stepB = this._interp(table1.b, table2.b, len);
		this._colLeft.r = table1.r; this._colLeft.g = table1.g; this._colLeft.b = table1.b;
		this._drawLine(cmd, x1, y1, x2, y2, false, 0, 0, stepR, stepG, stepB);
	}

	// Discards objects completely outside the system clipping.
	_preClipped(tlx, tly, blx, bly, trx, try_, brx, bry)
	{
		const yv = this.sysY2;
		if(tlx < 0 && blx < 0 && trx < 0 && brx < 0) return true;
		if(tlx > this.sysX2 && blx > this.sysX2 && trx > this.sysX2 && brx > this.sysX2) return true;
		if(tly < 0 && bly < 0 && try_ < 0 && bry < 0) return true;
		if(tly > yv && bly > yv && try_ > yv && bry > yv) return true;
		return false;
	}

	// Rasterizes the quad (tl, bl, tr, br) sampling the texture per scanline with
	// affine interpolation (edge-walking), plus gouraud. Ported from drawQuad().
	_drawQuad(cmd, tlx, tly, blx, bly, trx, try_, brx, bry)
	{
		if(this._preClipped(tlx, tly, blx, bly, trx, try_, brx, bry)) return;

		this._charWidth = ((cmd.size >> 8) & 0x3F) * 8;
		this._charHeight = cmd.size & 0xFF;

		// Walks and stores the coordinates of the left and right edges.
		const self = this;
		let ni = 0, nd = 0;
		const totalLeft = this._iterateLine(tlx, tly, blx, bly, false, function(x, y, i)
		{
			if(i < 1024) { self._xLeft[i] = x; self._yLeft[i] = y; } ni = i; return 0;
		});
		const totalRight = this._iterateLine(trx, try_, brx, bry, false, function(x, y, i)
		{
			if(i < 1024) { self._xRight[i] = x; self._yRight[i] = y; } nd = i; return 0;
		});
		if(totalLeft === 0x7FFFFFFF || totalRight === 0x7FFFFFFF) return;

		const total = Math.max(totalLeft, totalRight);
		if(total <= 0) return;

		// Gouraud: interpolates A->D (left) and B->C (right) over "total" scanlines.
		const gouraud = (cmd.pmod & 0x4) !== 0;
		let colA, colB, stepLeftR = 0, stepLeftG = 0, stepLeftB = 0, stepRightR = 0, stepRightG = 0, stepRightB = 0;
		if(gouraud)
		{
			this._loadGouraud(cmd);
			// _grd[0..3] are the vertices A,B,C,D of the table, in that order (gouraudTable
			// of vidsoft.c). The quad arrives as TL=A, BL=D, TR=B, BR=C (see the call in
			// _spriteDistorted/_polygon), so the LEFT edge goes A->D and the
			// RIGHT one goes B->C. It is the "colors[0]=A; colors[1]=D; colors[2]=B; colors[3]=C"
			// of drawQuad(). Careful with the indices: D is _grd[3] and B is _grd[1], NOT the other way around.
			colA = this._grd[0]; const colD = this._grd[3]; colB = this._grd[1]; const colC = this._grd[2];
			stepLeftR = this._interp(colA.r, colD.r, total); stepLeftG = this._interp(colA.g, colD.g, total); stepLeftB = this._interp(colA.b, colD.b, total);
			stepRightR = this._interp(colB.r, colC.r, total); stepRightG = this._interp(colB.g, colC.g, total); stepRightB = this._interp(colB.b, colC.b, total);
		}

		// The shorter side advances less than a pixel per scanline (it stretches the texture).
		let stepLeftLine = 1, stepRightLine = 1;
		if(total === totalLeft && totalLeft !== totalRight) stepRightLine = totalRight / totalLeft;
		else if(totalLeft !== totalRight) stepLeftLine = totalLeft / totalRight;

		for(let i = 0; i < total; i++)
		{
			const iLeft = Math.min(1023, (i * stepLeftLine) | 0);
			const iRight = Math.min(1023, (i * stepRightLine) | 0);
			const xL = this._xLeft[iLeft], yL = this._yLeft[iLeft];
			const xR = this._xRight[iRight], yR = this._yRight[iRight];

			// Scanline length and texture steps.
			const length = this._iterateLine(xL, yL, xR, yR, true, null);
			const stepTexX = this._interp(0, this._charWidth, length);
			const stepTexY = this._interp(0, this._charHeight, total);

			let stepLRr = 0, stepLRg = 0, stepLRb = 0;
			if(gouraud)
			{
				const leftR = colA.r + stepLeftR * i, leftG = colA.g + stepLeftG * i, leftB = colA.b + stepLeftB * i;
				const rightR = colB.r + stepRightR * i, rightG = colB.g + stepRightG * i, rightB = colB.b + stepRightB * i;
				stepLRr = this._interp(leftR, rightR, length);
				stepLRg = this._interp(leftG, rightG, length);
				stepLRb = this._interp(leftB, rightB, length);
				this._colLeft.r = leftR; this._colLeft.g = leftG; this._colLeft.b = leftB;
			}

			this._drawLine(cmd, xL, yL, xR, yR, true, stepTexY * i, stepTexX, stepLRr, stepLRg, stepLRb);
		}
	}

	// --- Output: display bank -> RGBA ---
	// The framebuffer holds raw values; the one that interprets them on the HW is the
	// VDP2 with SPCTL: bits 0-3 give the SPRITE TYPE (how the word is split into
	// priority / color calculation / color index and where the shadow
	// bit lands) and bit 5 (SPCLMD) says whether an MSB of 1 means "direct RGB".
	// We do that decoding here to return RGBA without touching vdp2.js.
	// Color offset that the VDP2 applies to the sprite layer. Exact port of
	// ReadVdp2ColorOffset(regs, info, 0x40, 0x40) from vidsoft.c: bit 6 of CLOFEN
	// enables the offset for sprites and bit 6 of CLOFSL picks register set
	// A (COAR/COAG/COAB) or B (COBR/COBG/COBB). Each COxx is a signed 9-bit
	// value. Returns [r,g,b] or null if it is disabled.
	//ok, 16-07-2026
	_readColorOffsetSprite(regs2)
	{
		if(!regs2) return null;
		const rw = (a) => (((regs2[a] << 8) | regs2[a + 1]) & 0xFFFF);
		if(!(rw(0x110) & 0x40)) return null;                            // CLOFEN
		const s9 = (v) => { v &= 0x1FF; return (v & 0x100) ? v - 0x200 : v; };
		if(rw(0x112) & 0x40)                                            // CLOFSL: 1 = set B
			return [ s9(rw(0x11A)), s9(rw(0x11C)), s9(rw(0x11E)) ];      // COBR/COBG/COBB
		return [ s9(rw(0x114)), s9(rw(0x116)), s9(rw(0x118)) ];         // COAR/COAG/COAB
	}

	// PRISA-D: the EIGHT priority registers of the sprite layer:
	// PRISA=1800F0H, PRISB=1800F2H,
	// PRISC=1800F4H, PRISD=1800F6H, each with two 3-bit fields (bits 2-0 the
	// even index, bits 10-8 the odd one). It is the same layout as PRINA/PRINB, which vdp2.js
	// already reads that way in _configNBG0/_configNBG1.
	// THE IMPORTANT PART: the PR bits of the framebuffer word are NOT the priority, they are an
	// INDEX into these eight registers. PR=5 -> the priority that register 5 says.
	//ok, 17-07-2026
	_readPrioritiesSprite(regs2)
	{
		const p = this._pris;
		for(let i = 0; i < 8; i++)
		{
			const off = 0xF0 + ((i >> 1) << 1);
			const w = regs2 ? (((regs2[off] << 8) | regs2[off + 1]) & 0xFFFF) : 0;
			p[i] = ((i & 1) ? (w >> 8) : w) & 0x7;
		}
		return p;
	}

	// CCRSA-D: the EIGHT color calculation ratio registers of the sprite layer.
	// Sprite register 0 is 180100H bits 4 to 0
	// ... sprite register 7 is 180106H bits 12 to 8. So
	// CCRSA=180100H, CCRSB=102H, CCRSC=104H, CCRSD=106H, with two fields per register
	// (bits 4-0 the even index, bits 12-8 the odd one). Same pattern as PRISA-D but the
	// fields are FIVE bits wide, not three.
	// Same as with priority: the CC bits of the word are an INDEX into these eight.
	// Returns the project's internal 6-bit alpha with the SAME formula that
	// vdp2._alphaOfRatio() uses for the NBGs (ratio 0 = opaque, 31 = the most translucent).
	// It is not re-derived here on purpose: two alpha conventions in the same compositor
	// is how the bugs that nobody finds get in.
	//ok, 17-07-2026
	// The four SPCCCS conditions, exactly:
	//   0: only when (priority number) <= (color calculation condition number)
	//   1: only when (priority number) = (color calculation condition number)
	//   2: only when (priority number) >= (color calculation condition number)
	//   3: only when the most significant bit of color data is 1
	// CAREFUL: what is compared is the priority ALREADY RESOLVED by PRISA-D, not the raw PR
	// bits of the word. The PR bits are an index; the priority is what is returned by the
	// register they index.
	//ok, 17-07-2026
	_ccApplies(spcccs, spccn, prio, pix)
	{
		if(spcccs === 0) return prio <= spccn;
		if(spcccs === 1) return prio === spccn;
		if(spcccs === 2) return prio >= spccn;
		return (pix & 0x8000) !== 0;
	}

	// Blends the sprite color with the VDP2 pixel left underneath. Same conversion
	// as vdp2._putPixelLayer (titan.c): 8-bit alpha = (alpha6 << 2) + 3, so that
	// 0x3F lands exactly on 0xFF (opaque). The clamp to 0-255 is done on its own by the
	// Uint8ClampedArray of this.fb.
	//ok, 17-07-2026
	_mixWithVdp2(out, o, fbVdp2, r, g, b, alpha6)
	{
		const a = (alpha6 << 2) + 3;
		const ra = 0xFF - a;
		out[o]     = (((r * a) / 0xFF) | 0) + (((fbVdp2[o]     * ra) / 0xFF) | 0);
		out[o + 1] = (((g * a) / 0xFF) | 0) + (((fbVdp2[o + 1] * ra) / 0xFF) | 0);
		out[o + 2] = (((b * a) / 0xFF) | 0) + (((fbVdp2[o + 2] * ra) / 0xFF) | 0);
		out[o + 3] = 255;
	}

	_readRatiosSprite(regs2)
	{
		const p = this._ccrs;
		for(let i = 0; i < 8; i++)
		{
			const off = 0x100 + ((i >> 1) << 1);
			const w = regs2 ? (((regs2[off] << 8) | regs2[off + 1]) & 0xFFFF) : 0;
			const ratio = ((i & 1) ? (w >> 8) : w) & 0x1F;
			p[i] = ((~ratio & 0x1F) << 1) + 1;
		}
		return p;
	}

	// 'fbVdp2' is the VDP2's RGBA framebuffer (vdp2.fb), which is needed to BLEND:
	// color calculation combines the sprite with what is underneath it, and without the background
	// there is nothing to blend with. Without it, it composes opaque.
	_composeOutput(prioVdp2, fbVdp2, shadowOk)
	{
		this._configureResolutionTv();   // this.fb can change size: it goes FIRST
		const out = this.fb;
		const src = this._fbDisplay;
		const regs2 = this.bus.vdp2Regs;
		//? Without VDP2 (test bus) we assume SPCLMD=1 and type 0, which is the most
		//? permissive: it lets RGB sprites show without depending on the VDP2 config.
		const spctl = regs2 ? (((regs2[0xE0] << 8) | regs2[0xE1]) & 0xFFFF) : 0x0020;
		const craofb = regs2 ? (((regs2[0xE6] << 8) | regs2[0xE7]) & 0xFFFF) : 0;
		const type = spctl & 0xF;
		const rgbMode = (spctl & 0x20) !== 0;         // SPCLMD
		const windowSprite = (spctl & 0x10) !== 0;   // SPWINEN
		const offColor = (craofb & 0x70) << 4;
		// Signed sum per channel (COLOR_ADD from vidsoft.c). The clamp to 0-255 is done on its
		// own by the Uint8ClampedArray of this.fb, same as COLOR_ADDt.
		const colorOffset = this._readColorOffsetSprite(regs2);
		const cor = colorOffset ? colorOffset[0] : 0;
		const cog = colorOffset ? colorOffset[1] : 0;
		const cov = colorOffset ? colorOffset[2] : 0;
		const bpp16 = this._fbBpp === 2;
		const spi = this._spi;
		const pris = this._readPrioritiesSprite(regs2);
		//? Without the VDP2 priority buffer there is nothing to resolve against: standalone render()
		//? and the tests compose this way. It draws permissively, in line with the //? from
		//? above about SPCTL. Applying "priority 0 = not displayed" without VDP2 would leave EVERYTHING
		//? transparent with the registers at zero -which is exactly the test bus-: it would be
		//? trading a permissive default for a black screen.
		const resolvePrio = !!prioVdp2;

		const ccrs = this._readRatiosSprite(regs2);
		const spccn  = (spctl >> 8) & 0x7;     // SPCCN: condition number
		const spcccs = (spctl >> 12) & 0x3;    // SPCCCS: which of the four conditions
		// SPCCEN, the master enable of sprite color calculation. It lives in CCCTL
		// (the conditions are valid only when the SPCCEN bit in the
		// color calculation control register is 1) but its bit is not documented. It comes from two
		// places in the project itself, which agree: vdp2._configCommon documents that the
		// bit of each layer "is the same in CCCTL, CLOFEN, CLOFSL and MZCTL", and
		// _readColorOffsetSprite (up above) uses 0x40 for the sprite in CLOFEN.
		const ccctl = regs2 ? (((regs2[0xEC] << 8) | regs2[0xED]) & 0xFFFF) : 0;
		// Without the VDP2 framebuffer there is nothing to blend with: it composes opaque.
		const makeCC = ((ccctl & 0x40) !== 0) && !!fbVdp2;
		// The shadow needs both things: the background to darken, and shadowOk to
		// know whether that layer accepts it. Without either of the two it is left transparent, which is
		// how it used to behave.
		const makeShadow = !!fbVdp2 && !!shadowOk;

		// --- BANK READOUT WHEN THE SCREEN DOES NOT MEASURE THE SAME AS THE FRAMEBUFFER ---
		//
		// The VDP1 draws into a bank of FIXED size according to its mode: 512x256 (16 bpp, the
		// normal one), 1024x256 (8 bpp) or 512x512 (rotation). The screen, on the other hand, is set by
		// the VDP2's TVMD and can ask for 640/704 wide and 448 high (double-density).
		// When the screen asks for MORE than the bank has, the hardware DOUBLES the
		// pixel; reading it 1:1 would run past the end of the row and bring in the next row, which
		// is how sprites come out "diagonal".
		//
		// The rule covers the four VDP1/VDP2 combinations at once: a 512 bank with a
		// 704 screen doubles, a 1024 bank with a 704 screen goes 1:1, and the normal
		// modes (320/352 x 224/240) touch nothing because they never exceed the bank.
		//
		// It is the missing half of hi-res: without this, putting the real width in the VDP2
		// ruins the output instead of fixing it. Sebas saw it in Sega Touring Car (translated):
		// "the broken pixels showing 3d" — the HUD reading pieces of the framebuffer that did not
		// belong to it.
		const dupX = this.width > this._fbWidth;
		const dupY = this.height  > this._fbHeight;

		for(let y = 0; y < this.height; y++)
		{
			const rowFb = (dupY ? (y >> 1) : y) * this._fbWidth;
			for(let x = 0; x < this.width; x++)
			{
				const k = y * this.width + x;
				const o = k * 4;
				const sx = dupX ? (x >> 1) : x;
				const pix = bpp16 ? this._fbRead(src, rowFb + sx) : src[rowFb + sx];

				if(pix === 0) { out[o + 3] = 0; continue; }   // 0 is always transparent

				if(bpp16 && (pix & 0x8000) && rgbMode)
				{
					// Direct RGB. 0x8000 (RGB black) is only drawn for types
					// 0-1 or for types 2-7 without sprite window; types 8-F
					// always treat it as transparent.
					if(!(pix !== 0x8000 || type < 2 || (type < 8 && !windowSprite))) { out[o + 3] = 0; continue; }
					// With RGB data the priority bit, color calculation ratio
					// bit and shadow bit are taken as 0. So the PR index is 0
					// and the priority ALWAYS comes from sprite register 0.
					if(resolvePrio && (pris[0] === 0 || pris[0] < prioVdp2[k])) { out[o + 3] = 0; continue; }
					// Same rule: the CC index is also 0, so the ratio
					// comes from sprite register 0 no matter what those bits hold (which in
					// RGB are color, not CC).
					const rD = (pix & 0x1F) * 8 + cor, gD = ((pix >> 5) & 0x1F) * 8 + cog, bD = ((pix >> 10) & 0x1F) * 8 + cov;
					if(makeCC && ccrs[0] < 0x3F && this._ccApplies(spcccs, spccn, pris[0], pix))
						this._mixWithVdp2(out, o, fbVdp2, rD, gD, bD, ccrs[0]);
					else { out[o] = rD; out[o + 1] = gD; out[o + 2] = bD; out[o + 3] = 255; }
					continue;
				}

				// Color bank: the sprite type splits the word and marks the shadows.
				this._infoPixelSprite(type, pix, spi);

				//? "Normal" shadow (the index is 0x7FE for types 0-3 and 5, 0x3FE
				//? for 4 and 6, 0x1FE for 7, 0x7E for 8, 0x3E for 9-B and 0xFE for C-F:
				//? all 16 cases verified on 17-07-2026) and
				//? MSB shadow: on the HW they are a REQUEST to the VDP2 to darken the
				//? layers below, not a color. The shadow sprite is
				//? forcibly made transparent, and the brightness of the part of the top image where the
				//? sprite was is halved. That is, half brightness.
				//?
				//? STATUS AS OF 29-07-2026 (the old comment of this block went stale
				//? twice and this is what has to be read, not that):
				//?   - NORMAL shadow is DONE, with SDCTL and shadowOk[] (below).
				//?   - MSB shadow is NOT, and what is known about it is documented here.
				//?
				//? The finer points of the MSB shadow, which are not obvious from the
				//? general shadow rules:
				//?   1. Bits 4 and 5 of the sprite control register
				//?      (0x25f800e0) must be cleared. Bit 5 (SPCLMD) turns off RGB sprites and bit 4 turns off
				//?      the sprite window. That is: an MSB shadow sprite cannot be created
				//?      without completely giving up displaying RGB sprites.
				//?   2. It only works for sprite types 2 through 7 — and since those types are
				//?      all 16-bit, the MSB cannot be used in the VDP1's high
				//?      resolution modes.
				//?   3. Pixel 0x8000 (MSB alone) is a TRANSPARENT shadow and darkens the
				//?      background **only if SDCTL bit 8 is set** (transparent shadow
				//?      enable), which is clear by default. With that bit at 0 the
				//?      transparent shadow is NOT shown over the backgrounds — which is
				//?      exactly what we do below (`shadowMsb && index === 0` ->
				//?      transparent), so in the default case we are already correct.
				//?   4. A pixel > 0x8000 (MSB at 1 and the rest NOT all zero) is interpreted as
				//?      OPAQUE but with its luminance reduced. **We do NOT do that**: today
				//?      it is drawn with normal luminance. It is the real gap of the MSB.
				//?   5. If a pixel qualifies for both, it is interpreted as a normal
				//?      shadow pixel — the order this block already has.
				//?
				//? WHY IT IS NOT IMPLEMENTED: measured with diag/vdp2-shadows.mjs over the 10
				//? games and 1,500 frames, **NONE asks for shadows of any kind**: SDCTL
				//? reads 0 in all 10 (its reset value), i.e. no layer accepts them. The
				//? probe has self-verification (it writes SDCTL/SPCTL by hand and checks that
				//? it sees them), so the 0 is the fact and not a read error. Touching the
				//? compositor —a hot path that already broke twice— for a path that nobody
				//? exercises is not warranted. If a disc that uses them shows up, point 4
				//? is the first thing to write.
				// NORMAL SHADOW. The sprite ALWAYS becomes transparent
				// -it is forcibly made transparent- and it also halves the brightness
				// of what was left underneath, but only if BOTH hold:
				//   1. Shadowing is only used when the shadowing sprite has the highest
				//      priority: it has to beat the VDP2 (a tie goes to the sprite),
				//      and priority 0 is not displayed.
				//   2. The layer underneath has to ACCEPT the shadow (its bit in SDCTL). The
				//      VDP1 does not know that -it does not know WHICH layer painted-, that is why vdp2.js passes
				//      shadowOk[], sibling of priorities[].
				// If they do not hold, transparent: the VDP2 shows without shadow. It is what it did
				// before and it is still preferable to painting a black that does not belong.
				// SDCTL is cleared to 0 on reset, so a game that does not ask for it sees
				// EXACTLY what it saw before.
				if(spi.shadowNormal)
				{
					const prioS = pris[spi.priority];
					if(makeShadow && shadowOk[k] && prioS !== 0
						&& !(resolvePrio && prioS < prioVdp2[k]))
					{
						out[o]     = fbVdp2[o]     >> 1;
						out[o + 1] = fbVdp2[o + 1] >> 1;
						out[o + 2] = fbVdp2[o + 2] >> 1;
						out[o + 3] = 255;
					}
					else out[o + 3] = 0;
					continue;
				}
				//? MSB SHADOW: still not applied, and there is an unresolved hardware
				//? question. It applies to types 2-7, where bit 15 is
				//? SD. But with SPCLMD=1 bit 15 means "direct RGB", and the RGB path
				//? above eats it BEFORE it gets here: so today, with SPCLMD=1, the
				//? MSB shadow never fires. It could not be determined whether that is correct
				//? (SPCLMD=1 = the MSB is RGB, period) or a bug. Two subtleties
				//? for when it gets resolved: the "sprite shadow" (MSB=1 with the other
				//? 15 bits NOT zero) does NOT look at SDCTL -sprite shadow sprites always use
				//? shadowing on themselves-, and the "transparent shadow" (word == 0x8000
				//? exactly) takes its priority from sprite register 0, not from its PR bits, and
				//? it is enabled by TPSDSL (SDCTL bit 8).
				if(spi.shadowMsb && spi.index === 0) { out[o + 3] = 0; continue; }

				// Priority: spi.priority holds the PR bits, which are an INDEX into PRISA-D, not
				// the priority. A tie against the VDP2 goes to the sprite (the
				// order is sprite -> RBG0 -> NBG0 -> NBG1 -> NBG2 -> NBG3), so
				// the VDP2 only covers it if its priority is STRICTLY higher.
				const prio = pris[spi.priority];
				if(resolvePrio && (prio === 0 || prio < prioVdp2[k])) { out[o + 3] = 0; continue; }

				const [r5, g5, b5] = this._cram5(offColor + spi.index);
				const rC = r5 * 8 + cor, gC = g5 * 8 + cog, bC = b5 * 8 + cov;
				// Color calculation: spi.calcColor holds the CC bits, which are an INDEX into
				// CCRSA-D just as the PR bits are into PRISA-D. It only applies if SPCCEN is
				// set AND the condition chosen by SPCCCS holds.
				const alpha6 = ccrs[spi.calcColor];
				if(makeCC && alpha6 < 0x3F && this._ccApplies(spcccs, spccn, prio, pix))
					this._mixWithVdp2(out, o, fbVdp2, rC, gC, bC, alpha6);
				else { out[o] = rC; out[o + 1] = gC; out[o + 2] = bC; out[o + 3] = 255; }
			}
		}
		return out;
	}

	// Vdp1GetSpritePixelInfo: the VDP2's 16 sprite types (SPCTL bits 0-3).
	// Each type splits the framebuffer word differently between shadow bit,
	// priority, color calculation and color index. It writes into "res" so as not to
	// allocate an object per pixel.
	_infoPixelSprite(type, pix, res)
	{
		res.priority = 0; res.calcColor = 0; res.shadowMsb = false; res.shadowNormal = false;
		switch(type)
		{
			case 0x0:  // 2 bits priority, 3 color calc, 11 color
				res.priority = pix >> 14; res.calcColor = (pix >> 11) & 0x7; res.index = pix & 0x7FF;
				res.shadowNormal = res.index === 0x7FE; break;
			case 0x1:  // 3 bits priority, 2 color calc, 11 color
				res.priority = pix >> 13; res.calcColor = (pix >> 11) & 0x3; res.index = pix & 0x7FF;
				res.shadowNormal = res.index === 0x7FE; break;
			case 0x2:  // 1 shadow, 1 priority, 3 color calc, 11 color
				res.shadowMsb = (pix >> 15) !== 0; res.priority = (pix >> 14) & 0x1;
				res.calcColor = (pix >> 11) & 0x7; res.index = pix & 0x7FF;
				res.shadowNormal = res.index === 0x7FE; break;
			case 0x3:  // 1 shadow, 2 priority, 2 color calc, 11 color
				res.shadowMsb = (pix >> 15) !== 0; res.priority = (pix >> 13) & 0x3;
				res.calcColor = (pix >> 11) & 0x3; res.index = pix & 0x7FF;
				res.shadowNormal = res.index === 0x7FE; break;
			case 0x4:  // 1 shadow, 2 priority, 3 color calc, 10 color
				res.shadowMsb = (pix >> 15) !== 0; res.priority = (pix >> 13) & 0x3;
				res.calcColor = (pix >> 10) & 0x7; res.index = pix & 0x3FF;
				res.shadowNormal = res.index === 0x3FE; break;
			case 0x5:  // 1 shadow, 3 priority, 1 color calc, 11 color
				res.shadowMsb = (pix >> 15) !== 0; res.priority = (pix >> 12) & 0x7;
				res.calcColor = (pix >> 11) & 0x1; res.index = pix & 0x7FF;
				res.shadowNormal = res.index === 0x7FE; break;
			case 0x6:  // 1 shadow, 3 priority, 2 color calc, 10 color
				res.shadowMsb = (pix >> 15) !== 0; res.priority = (pix >> 12) & 0x7;
				res.calcColor = (pix >> 10) & 0x3; res.index = pix & 0x3FF;
				res.shadowNormal = res.index === 0x3FE; break;
			case 0x7:  // 1 shadow, 3 priority, 3 color calc, 9 color
				res.shadowMsb = (pix >> 15) !== 0; res.priority = (pix >> 12) & 0x7;
				res.calcColor = (pix >> 9) & 0x7; res.index = pix & 0x1FF;
				res.shadowNormal = res.index === 0x1FE; break;
			case 0x8:  // 1 priority, 7 color
				res.priority = (pix >> 7) & 0x1; res.index = pix & 0x7F;
				res.shadowNormal = res.index === 0x7E; break;
			case 0x9:  // 1 priority, 1 color calc, 6 color
				res.priority = (pix >> 7) & 0x1; res.calcColor = (pix >> 6) & 0x1; res.index = pix & 0x3F;
				res.shadowNormal = res.index === 0x3E; break;
			case 0xA:  // 2 priority, 6 color
				res.priority = (pix >> 6) & 0x3; res.index = pix & 0x3F;
				res.shadowNormal = res.index === 0x3E; break;
			case 0xB:  // 2 color calc, 6 color
				res.calcColor = (pix >> 6) & 0x3; res.index = pix & 0x3F;
				res.shadowNormal = res.index === 0x3E; break;
			case 0xC:  // 1 special priority, 8 color (bit 7 is shared)
				res.priority = (pix >> 7) & 0x1; res.index = pix;
				res.shadowNormal = pix === 0xFE; break;
			case 0xD:  // 1 special priority, 1 special color calc, 8 color (bits 6-7 shared)
				res.priority = (pix >> 7) & 0x1; res.calcColor = (pix >> 6) & 0x1; res.index = pix;
				res.shadowNormal = pix === 0xFE; break;
			case 0xE:  // 2 special priority, 8 color (bits 6-7 shared)
				res.priority = (pix >> 6) & 0x3; res.index = pix;
				res.shadowNormal = pix === 0xFE; break;
			case 0xF:  // 2 special color calc, 8 color (bits 6-7 shared)
				res.calcColor = (pix >> 6) & 0x3; res.index = pix;
				res.shadowNormal = pix === 0xFE; break;
			default: res.index = pix; break;
		}
		return res;
	}
}

if(typeof module !== "undefined") module.exports = { VDP1 };
