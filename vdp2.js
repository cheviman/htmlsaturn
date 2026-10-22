/**
 *    Name:         vdp2.js
 *    Description:  Saturn VDP2: background/layer processor and final video
 *                  composition. Supports back screen (single color or per line),
 *                  NBG0-3 (tiles and bitmap), rotated RBG0 and RBG1 (affine matrix A-F,
 *                  coefficient tables and A/B parameter blending), windows
 *                  W0/W1 + sprite window, color calculation (blending between
 *                  layers) and color offset, line color screen (LNCL: inserted as
 *                  second image), line scroll, vertical cell scroll,
 *                  mosaic, per-layer zoom and composition by priority (PRINA/B/R).
 *                  The bits of each register are ported from Yabause (vidsoft.c /
 *                  vidshared.c / titan.c, GPL v2+) so as not to guess them.
 *    Version:      0.4.0
 *    Created:      15-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 *
 *    Reference (GPL attribution): Yabause - vdp2/vidsoft/titan (Guillaume Duhamel,
 *    Theo Berkau and contributors). The pattern-name decoding, the computation of
 *    plane/page/cell addresses, the window logic (TestWindow /
 *    WindowLogic / TestBothWindow), the color calculation and color
 *    offset formulas and the reading of the rotation tables follow the implementation of
 *    that emulator.
 */

//ok, 16-07-2026 - Multilayer composition by priority, windows, color calculation
//                 and affine rotation of RBG0/RBG1.
//
// //? Still missing (none of it blocks basic 2D):
// //  - Special color calculation (SFCCMD/SFCODE/SFSEL) and special priority
// //    (SFPRMD): per-pixel priority and blending according to the color code.
// //  - From the line screen: SPLCEN (line color under a SPRITE left as top image, which
// //    depends on vdp1.js) and the line color that can come in the coefficient table
// //    of the rotated backgrounds. The rest (LNCLEN, LCTA, CCRLB) is already
// //    there: see _readLineScreen() and the LINE COLOR in _putPixelLayer().
// //  - Sprite layer and shadows (SPCTL/SDCTL/PRISA-D/CCRSA-D): in this emulator
// //    the VDP1 is composed separately, outside the VDP2.
// //  - Interlace (TVMD LSMD) and hi-res RASTERIZING: TVMD's width/height are already
// //    honored (see _configureResolution), but the 640/704 modes are rasterized
// //    at half resolution. See the //? in _configureResolution().
// //  - ZMCTL (reduction limit): it only affects the VRAM access patterns,
// //    which are not emulated here; Yabause does not use it when drawing either.
// The framebuffer is filled 32 bits at a time on some fast paths; the byte order
// is always RGBA, so the machine's endianness has to be known.
const VDP2_LITTLE_ENDIAN = (() => {
	const b = new ArrayBuffer(4);
	new Uint32Array(b)[0] = 1;
	return new Uint8Array(b)[0] === 1;
})();

// Screen width by HRESO (TVMD bits 2-0), the "Horizontal resolution"
// field:
//   000 320 px Normal Graphic A            100 320 px Exclusive Normal Graphic A
//   001 352 px Normal Graphic B            101 352 px Exclusive Normal Graphic B
//   010 640 px Hi-Res Graphic A            110 640 px Exclusive Hi-Res Graphic A
//   011 704 px Hi-Res Graphic B            111 704 px Exclusive Hi-Res Graphic B
// Matches Yabause's VIDSoftVdp2SetResolution (vidsoft.c:4082).
const VDP2_HRESO_WIDTH = [ 320, 352, 640, 704, 320, 352, 640, 704 ];
// Height by VRESO (TVMD bits 5-4), in the same register: 00 = 224 lines,
// 01 = 240, 10 = 256 (PAL only) and 11 = "Not Allowed" (-1: ignored, not changed).
const VDP2_VRESO_HEIGHT = [ 224, 240, 256, -1 ];

class VDP2
{
	constructor(bus)
	{
		this.bus = bus;
		// Startup values; _configureResolution() overwrites them with what TVMD says on
		// every render(). 320x224 is mode 0 of HRESO/VRESO, i.e. what is left if the
		// register is zero (test bus, synthetic scene, before the first frame).
		this.width = 320;
		this.height = 224;
		this.fb = new Uint8ClampedArray(this.width * this.height * 4);   // output RGBA
		// Color calculation ratio (6 bits) of the layer that ended up on top at each
		// pixel. The CCRTMD mode needs it (blending with the ratio of the layer
		// below), and it is equivalent to the alpha channel that Titan stores per pixel in Yabause.
		this._alpha = new Uint8Array(this.width * this.height);
		// Priority (0-7) of the layer that ended up IN FRONT at each pixel, so that the sprite
		// layer knows what to compare against. It is per pixel and not per layer because the
		// sprite priority is ALSO per pixel: the PR bits of the VDP1 word
		// index PRISA-D, so the sprite layer cannot
		// enter the render() sort as one more layer. 0 = backdrop.
		this.priorities = new Uint8Array(this.width * this.height);
		// Shadow: 1 if the layer that ended up IN FRONT at that pixel accepts having
		// a shadow cast on it (SDCTL). It is separate from priorities[] because they are
		// two different questions: priorities[] says WHICH PRIORITY won, and the sprite
		// layer also needs to know whether that layer enabled shadow. The VDP1 does not
		// know WHICH layer painted each pixel -only with what priority-, so we give it
		// the answer from here.
		this.shadowOk = new Uint8Array(this.width * this.height);

		// --- Layer isolation (debug) ---
		// Bisection by layers: turn layers off one at a time to see which one draws what, and by
		// elimination which one is MISSING (the one that should paint something and does not show up). It is the only
		// way to know which layer is Rally's "sky" without guessing. Each layer carries
		// its 'name' (nbg0..nbg3, rbg0, rbg1), which is labeled in configFromRegisters.
		this.layersOff = new Set();       // layer names that are NOT drawn
		// Also show the layers the priority filter would discard (priority 0):
		// if the sky is on a layer with priority 0, it only shows up with this set to true.
		this.ignorePriority = false;

		// Interlace field for double-density (see render()): it toggles 0/1 per frame and
		// says which half of the lines is rasterized. Outside that mode it is not used: the
		// walk stays at start 0 / step 1, identical to always.
		this._field = 0;
		this._fieldStart = 0;
		this._fieldStep = 1;
		// Band of this rasterizer when the render is split among several threads: this one
		// rasterizes lines bandStart, bandStart+bandStep, ... See render(). With step 1
		// (the default) it does the whole frame, which is the usual behavior.
		this.bandStart = 0;
		this.bandStep = 1;
		// Interlace field imposed from outside; -1 = toggle on its own (see render()).
		this.fieldForced = -1;
	}

	// --- Low-level readers (READ ONLY on the bus) ---

	// Reads a 16-bit VDP2 register (big-endian). 'o' is the offset within
	// vdp2Regs (0x00..0x1FF), equivalent to address 0x25F800xx.
	_r(o)
	{
		return ((this.bus.vdp2Regs[o] << 8) | this.bus.vdp2Regs[o + 1]);
	}

	// Reads a pair of 16-bit registers as a 32-bit value (the register at
	// 'o' is the high part). That is how LSTA0/LSTA1/VCSTA/LWTA0/LWTA1/RPTA are defined.
	_rl(o)
	{
		return (((this._r(o) << 16) | this._r(o + 2)) >>> 0);
	}

	// Big-endian 16-bit word from VRAM (with wrap at 512 KB).
	_vw(a)
	{
		const v = this.bus.vdp2Vram;
		return ((v[a & 0x7FFFF] << 8) | v[(a + 1) & 0x7FFFF]);
	}

	// Big-endian 32-bit long from VRAM (with wrap at 512 KB).
	_vl(a)
	{
		const v = this.bus.vdp2Vram;
		return (((v[a & 0x7FFFF] << 24) | (v[(a + 1) & 0x7FFFF] << 16) |
		         (v[(a + 2) & 0x7FFFF] << 8) | v[(a + 3) & 0x7FFFF]) >>> 0);
	}

	// Packs [r,g,b] into the matching uint32 of the RGBA framebuffer (alpha 255).
	// The framebuffer byte order is always RGBA, so the uint32 depends
	// on the machine's endianness.
	_packRgb(c)
	{
		return VDP2_LITTLE_ENDIAN
			? (((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0)
			: (((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | 255) >>> 0);
	}

	// Converts a Saturn RGB555 word (0BBBBBGGGGGRRRRR) to [r,g,b] 0-255.
	_rgb555(w)
	{
		return [ (w & 0x1F) * 8, ((w >> 5) & 0x1F) * 8, ((w >> 10) & 0x1F) * 8 ];
	}

	// Converts a Color RAM index to [r,g,b]. 'mode' is the CRAM mode
	// (RAMCTL CRMD): 0/1 = RGB555 (word), 2 = RGB888 (long).
	colorFromCram(index, mode)
	{
		if(mode === 2)
		{
			// The CRAM long in mode 2 is 0x00BBGGRR: RED in the LOW bits,
			// same as in RGB555 (R in 0-4, B in 10-14). The Saturn's convention is
			// consistent across all color formats. This used to read R from bits
			// 16-23 citing Yabause, and the channels came out swapped (the FMV
			// Sonic showed up RED): it was another Yabause-ism, the hardware has the last word.
			// In big-endian bytes of the long: o+0=flag, o+1=B, o+2=G, o+3=R.
			const o = (index * 4) & 0xFFF;
			const c = this.bus.cram;
			return [ c[o + 3], c[o + 2], c[o + 1] ];
		}
		const o = (index * 2) & 0xFFF;
		const w = (this.bus.cram[o] << 8) | this.bus.cram[o + 1];
		return this._rgb555(w);
	}

	// Fills a ONE BYTE PER PIXEL buffer only on the lines of the current field. Outside
	// double-density the step is 1 and it does exactly the same single-pass fill() as
	// before; with step 2 it respects the lines of the other field, which are the previous frame's.
	_fillField(buf, value)
	{
		if(this._fieldStep === 1){ buf.fill(value); return; }
		for(let j = this._fieldStart; j < this.height; j += 2)
		{
			const o = j * this.width;
			buf.fill(value, o, o + this.width);
		}
	}

	// Writes an RGB pixel to the output framebuffer (no windows or blending).
	_putPixel(i, j, rgb)
	{
		const o = (j * this.width + i) * 4;
		const fb = this.fb;
		fb[o] = rgb[0]; fb[o + 1] = rgb[1]; fb[o + 2] = rgb[2]; fb[o + 3] = 255;
	}

	// ---------------------------------------------------------------------------
	// Writes a layer's pixel applying color offset and color calculation.
	// Composition goes back to front, so "the layer below" is what
	// is already in the framebuffer. 'ccMode': 0 = ratio of the top layer,
	// 1 = add (CCCTL CCMD), 2 = ratio of the layer below (CCCTL CCRTMD).
	// 'makeCC' comes from the color calculation window test.
	//
	// //? The hardware does color calculation only between the top layer and the
	// //  second one; here, painting back to front, every layer with CC
	// //  blends with everything underneath it. It matches in the usual case (one
	// //  translucent layer over an opaque background) and differs with three or more
	// //  overlapping translucent layers. The extended mode (CCCTL EXCCEN, bit 10, which
	// //  blends three layers) is not implemented either.
	//
	// //? With LINE COLOR inserted (layer.lncEnable) the blend is against the LNCL and not
	// //  against the framebuffer, which is what the hardware does for the layer that ended up
	// //  TOP IMAGE. Where it does not match is with sprites: vdp1.js composes afterwards, so
	// //  if the sprite ends up on top and does color calculation it blends against the
	// //  result already blended with LNCL instead of against the layer's raw color.
	// //  It is the same case as the //? above, not a new one.
	//
	// //? The hardware applies the COLOR OFFSET after color calculation, not before:
	// //  since the color offset function is processed after the
	// //  color calculation function, the color offset value is added
	// //  to the color data resulting from the color calculation; and since the color
	// //  operation result screen is considered the top image screen, the color
	// //  offset enable register is specified using the top image screen bits.
	// //  Here it is applied BEFORE and per layer. It is a debt
	// //  PRIOR to line color and it is left as it was: flipping it changes the color of
	// //  any game that uses both things at once and it cannot be verified without
	// //  looking at the screen. Noted, not touched.
	// ---------------------------------------------------------------------------
	_putPixelLayer(i, j, rgb, layer, ccMode, makeCC)
	{
		const p = j * this.width + i;
		const o = p * 4;
		const fb = this.fb;
		let r = rgb[0], g = rgb[1], b = rgb[2];

		// Color offset (CLOFEN/CLOFSL + COAR..COBB): signed add per channel and
		// saturation to 0-255 (COLOR_ADD from vidsoft.c).
		const off = layer.offsetColor;
		if(off)
		{
			r += off[0]; if(r < 0) r = 0; else if(r > 255) r = 255;
			g += off[1]; if(g < 0) g = 0; else if(g > 255) g = 255;
			b += off[2]; if(b < 0) b = 0; else if(b > 255) b = 255;
		}

		const alphaLayer = (layer.alpha === undefined) ? 0x3F : layer.alpha;

		if(makeCC && layer.ccEnable)
		{
			// LINE COLOR (LNCL): if this layer has its bit in LNCLEN, the second image is
			// NOT what is underneath but the line color of THIS line. The line color
			// screen is a screen that has no priority number register, and it is
			// forcibly inserted as a second image in the area where the specified
			// screen is the top image, where it takes part in the color
			// calculation.
			// That the insertion happens only where the layer is the TOP IMAGE comes for free with this
			// compositor: it paints back to front, so if another layer overwrites the
			// pixel this result is discarded and only the one from the layer that ended up
			// on top survives. See the //? below for the only case where it does not match (sprites).
			const lnc = (layer.lncEnable && this._lnc)
				? (this._lnc.lines ? this._lnc.lines[j] : this._lnc.color) : null;
			const s0 = lnc ? lnc[0] : fb[o];
			const s1 = lnc ? lnc[1] : fb[o + 1];
			const s2 = lnc ? lnc[2] : fb[o + 2];

			if(ccMode === 1)
			{
				// CCMD=1: saturated add with the second image (TitanBlendPixelsAdd).
				r += s0; if(r > 255) r = 255;
				g += s1; if(g > 255) g = 255;
				b += s2; if(b > 255) b = 255;
			}
			else
			{
				// Ratio: the second image's if CCRTMD, otherwise its own. With line color
				// inserted the second image is the LNCL, so the ratio is the LNCL's own
				// (CCRLB LCCCRT) and not the one of the layer that was covered.
				const a6 = (ccMode === 2) ? (lnc ? this._lnc.alpha : this._alpha[p]) : alphaLayer;
				if(a6 < 0x3F)
				{
					// titan.c: 8-bit alpha = (alpha6 << 2) + 3 (0x3F -> 0xFF = opaque).
					const a = (a6 << 2) + 3;
					const ra = 0xFF - a;
					r = (((r * a) / 0xFF) | 0) + (((s0 * ra) / 0xFF) | 0);
					g = (((g * a) / 0xFF) | 0) + (((s1 * ra) / 0xFF) | 0);
					b = (((b * a) / 0xFF) | 0) + (((s2 * ra) / 0xFF) | 0);
				}
			}
		}

		fb[o] = r; fb[o + 1] = g; fb[o + 2] = b; fb[o + 3] = 255;
		this._alpha[p] = makeCC ? alphaLayer : 0x3F;
		// It paints back to front, so the last one to write is the one that
		// ended up furthest in front: its priority is the one the sprite layer has to see.
		this.priorities[p] = layer.priority;
		this.shadowOk[p] = layer.sdEnable ? 1 : 0;
	}

	// ---------------------------------------------------------------------------
	// WINDOWS (window clipping). Port of vidshared.h (ReadWindowCoordinates /
	// ReadWindowData / ReadLineWindowData / ReadLineWindowClip) and of vidsoft.c
	// (TestWindow / TestSpriteWindow / WindowLogic / TestBothWindow).
	//
	// Bits of a WCTLx byte (one per layer):
	//   0x01 W0 inside(1)/outside(0)   0x02 W0 enabled
	//   0x04 W1 inside/outside         0x08 W1 enabled
	//   0x10 sprite window inside/outside   0x20 sprite window enabled
	//   0x80 logic AND(1) / OR(0)
	// ---------------------------------------------------------------------------

	// Coordinates of W0 (num=0, WPSX0/WPSY0/WPEX0/WPEY0) or W1 (num=1).
	// The horizontal scaling depends on the screen mode (TVMD HRESO).
	//
	//? MISSING an edge case of the chip: when normal windows are used in
	//?   interlaced high resolution video mode and the vertical end coordinate window
	//?   position registers (WPEY0: 1800C6H, WPEY: 1800CEH) are set
	//?   between 1FCH and 1FFH, THE WINDOW BECOMES INVALID.
	//? It is not a restriction on the programmer like the other documented caveats: it says the chip
	//? INVALIDATES the window, i.e. it is behavior. We leave it valid and the window
	//? clips anyway.
	//? It is not implemented because the case needs all three conditions at once (normal window + INTERLACED
	//? hi-res + `yend` in the last 4 of the 512 possible values), and modeling it wrong —
	//? invalidating a window that the hardware does apply— is worse than not modeling it: it shows as a
	//? layer that appears where it should not. It stays written down here, in its place.
	_readCoordWindow(num)
	{
		const c = {};
		if(num === 0)
		{
			c.xstart = this._r(0xC0); c.ystart = this._r(0xC2) & 0x1FF;
			c.xend   = this._r(0xC4); c.yend   = this._r(0xC6) & 0x1FF;
		}
		else
		{
			c.xstart = this._r(0xC8); c.ystart = this._r(0xCA) & 0x1FF;
			c.xend   = this._r(0xCC); c.yend   = this._r(0xCE) & 0x1FF;
		}
		switch((this._r(0x00) >> 1) & 0x3)
		{
			case 0:                                 // normal
				c.xstart = (c.xstart >> 1) & 0x1FF; c.xend = (c.xend >> 1) & 0x1FF;
				break;
			case 1:                                 // hi-res
				c.xstart &= 0x3FF; c.xend &= 0x3FF;
				break;
			case 2:                                 // exclusive normal
				c.xstart &= 0x1FF; c.xend &= 0x1FF;
				break;
			case 3:                                 // exclusive hi-res
				c.xstart = (c.xstart & 0x3FF) >> 1; c.xend = (c.xend & 0x3FF) >> 1;
				break;
		}
		return c;
	}

	// Prepares a layer's window state from its WCTLx byte:
	// W0/W1 coordinates and addresses of the per-line window tables.
	_prepareWindows(wctl)
	{
		wctl = (wctl || 0) & 0xFF;
		const v = {
			wctl: wctl,
			clips: [ { xstart: 0, ystart: 0, xend: 0, yend: 0 },
			         { xstart: 0, ystart: 0, xend: 0, yend: 0 } ],
			lineFlags: 0, lineAddr0: 0, lineAddr1: 0
		};
		if(wctl & 0x2) v.clips[0] = this._readCoordWindow(0);
		if(wctl & 0x8) v.clips[1] = this._readCoordWindow(1);

		// Per-line window table: only if bit 31 of LWTA0/LWTA1 is set.
		const lwta0 = this._rl(0xD8), lwta1 = this._rl(0xDC);
		if((wctl & 0x2) && (lwta0 & 0x80000000) !== 0)
		{
			v.lineFlags |= 0x1;
			v.lineAddr0 = (lwta0 & 0x7FFFE) << 1;
		}
		if((wctl & 0x8) && (lwta1 & 0x80000000) !== 0)
		{
			v.lineFlags |= 0x2;
			v.lineAddr1 = (lwta1 & 0x7FFFE) << 1;
		}
		return v;
	}

	// Reads from VRAM the xstart/xend of one line of the window table.
	_readClipLine(clip, addr)
	{
		let xs = this._vw(addr);
		let xe = this._vw(addr + 2);

		// 3D Baseball and Panzer Dragoon Saga set xend=0xFFFF to invalidate the
		// window on those lines (case documented in Yabause).
		if(xe === 0xFFFF) { clip.xstart = 0; clip.xend = 0; return; }

		xs &= 0x3FF; xe &= 0x3FF;
		switch((this._r(0x00) >> 1) & 0x3)
		{
			case 0: clip.xstart = (xs >> 1) & 0x1FF; clip.xend = (xe >> 1) & 0x1FF; break;
			case 1: clip.xstart = xs & 0x3FF;        clip.xend = xe & 0x3FF;        break;
			case 2: clip.xstart = xs & 0x1FF;        clip.xend = xe & 0x1FF;        break;
			case 3: clip.xstart = (xs & 0x3FF) >> 1; clip.xend = (xe & 0x3FF) >> 1; break;
		}
	}

	// Adjusts the clips of 'v' with the per-line window table for line 'j'.
	// Each line takes 4 bytes (xstart, xend) per window.
	_clipOfLine(v, j)
	{
		if(v.lineFlags & 0x1) this._readClipLine(v.clips[0], v.lineAddr0 + j * 4);
		if(v.lineFlags & 0x2) this._readClipLine(v.clips[1], v.lineAddr1 + j * 4);
	}

	// TestWindow: 0 = pixel clipped, 1 = active and does not clip, 3 = disabled.
	_testWindow(wctl, maskEnable, maskInOut, clip, x, y)
	{
		if(wctl & maskEnable)
		{
			if(wctl & maskInOut)
			{
				// Draw inside the window.
				if(x < clip.xstart || x > clip.xend || y < clip.ystart || y > clip.yend)
					return 0;
			}
			else
			{
				// Draw outside the window.
				if(x >= clip.xstart && x <= clip.xend && y >= clip.ystart && y <= clip.yend)
					return 0;
				// On hardware the window overflows vertically (Yabause note).
				if(clip.yend > this.height && x >= clip.xstart && x <= clip.xend)
					return 0;
			}
			return 1;
		}
		return 3;
	}

	// Sprite window: the mask is generated by the VDP1 when drawing the sprites with
	// the shadow/window bit. This emulator does not publish it yet, so it is
	// taken from bus.vdp2SpriteWin if it exists (1 = pixel inside the window) and otherwise
	// it is assumed empty. //? sprite window mask (depends on the VDP1)
	_testWindowSprite(wctl, x, y)
	{
		if(!(wctl & 0x20)) return 3;
		const m = this.bus.vdp2SpriteWin;
		const mask = (m && m.length > (y * this.width + x)) ? m[y * this.width + x] : 0;
		if(wctl & 0x10)
		{
			if(mask === 0) return 0;                // inside the window
		}
		else if(mask)
		{
			return 0;                               // outside the window
		}
		return 1;
	}

	// WindowLogic: combines the result of two windows according to the logic bit.
	_logicWindow(wctl, w0, w1)
	{
		// AND: it only clips if both windows clip. OR: it clips with just one.
		if((wctl & 0x80) === 0x80) return (w0 || w1) ? 1 : 0;
		return (w0 && w1) ? 1 : 0;
	}

	// Tells whether a WCTLx byte enables no window at all. In that case the
	// result of _testBothWindows is constant and can be hoisted out of the pixel
	// loop (0 with AND logic, 1 with OR logic).
	_noWindows(v)
	{
		return (v.wctl & 0x2A) === 0;
	}

	// TestBothWindow: combines W0, W1 and the sprite window. 0 = pixel clipped.
	_testBothWindows(v, x, y)
	{
		const wctl = v.wctl;
		const w0 = this._testWindow(wctl, 0x2, 0x1, v.clips[0], x, y);
		const w1 = this._testWindow(wctl, 0x8, 0x4, v.clips[1], x, y);
		const spr = this._testWindowSprite(wctl, x, y);

		// No window enabled.
		if((wctl & 0x2A) === 0)
			return ((wctl & 0x80) === 0x80) ? 0 : 1;

		if((w1 & 2) && (spr & 2)) return w0 & 1;    // W0 only
		if((w0 & 2) && (spr & 2)) return w1 & 1;    // W1 only
		if(spr & 2) return this._logicWindow(wctl, w0, w1);   // W0 and W1
		if((w1 & 2) && (w0 & 2)) return spr & 1;    // sprite window only
		if((wctl & 0x2A) === 0x22) return this._logicWindow(wctl, w0, spr);
		if((wctl & 0x2A) === 0x28) return this._logicWindow(wctl, w1, spr);
		if((wctl & 0x2A) === 0x2A)
		{
			if((wctl & 0x80) === 0x80) return (w0 || w1 || spr) ? 1 : 0;
			return (w0 && w1 && spr) ? 1 : 0;
		}
		return 1;
	}

	// ---------------------------------------------------------------------------
	// Screen resolution: it is set by TVMD (180000H) and until today it was HARDCODED
	// at 320x224. HRESO (bits 2-0) gives the
	// width and VRESO (bits 5-4) the height. MEASURED: SF Alpha sets TVMD=0x8011 -> HRESO=1
	// -> 352 px, and we gave it 320: it lost 32 columns on the right.
	// Returns true if the geometry changed (useful for the tests).
	// CONSOLE side of the resolution: TVMD sets it and it has to be known BEFORE the
	// VDP1 plots, because the VDP1 follows the VDP2 (otherwise index.html composes with a different
	// stride and the sprites come out diagonal). runFrame() calls it once per
	// Saturn frame. It also runs inside render(), but render() lives on the
	// canvas path: hanging only from there, a frame without painting left the VDP1
	// rasterizing with the previous frame's resolution. Games change
	// resolution live (SF Alpha goes from 320x224 on the license screen to 352x240 in the
	// intro), so the moment of the change is exactly the worst one to have it stale.
	//!wip, 16-07-2026
	configureResolution() { return this._configureResolution(); }

	//ok, 16-07-2026
	_configureResolution()
	{
		// The geometry comes from the BUS (bus.tvGeometry), which is the only source: the VDP1 uses
		// exactly the same one to put its framebuffer over this image. See the
		// comment on Bus.tvGeometry about why it CANNOT be duplicated.
		const g = this.bus.tvGeometry ? this.bus.tvGeometry() : null;
		if(g) return this._resize(g.width, g.height < 0 ? this.height : g.height);

		// Fallback path for a bus without tvGeometry (the test mocks).
		const tvmd = this._r(0x00);
		let width = VDP2_HRESO_WIDTH[tvmd & 0x7];

		// HI-RES (640/704, HRESO=010/011/110/111): rasterized at the REAL width since
		// 25-07-2026. Until then it was rasterized at half (320/352) as a debt
		// bounded on purpose, because asking _composeOutput() in vdp1.js for 640 columns
		// without scaling the read made it read PAST the end of the bank's 512 row and
		// the sprites came out shifted diagonally. That is already solved over there: the read
		// step is computed against the bank size (the HW doubles the pixel when the
		// screen asks for more than the bank has).
		// Sebas reported it on 25-07 in Sega Touring Car and Daytona CCE, which ask for
		// 704x448 and got 352x224 — a QUARTER of the image, stretched. Measured with
		// diag/resolution.mjs: Touring spends 2255 of 3000 frames in that mode.
		//? Point 2 of the old debt is still pending: the hi-res VDP2 has its own
		//? paths on the HW (Yabause: Rbg0PutHiresPixel, and the vertical scroll "seems to be
		//? ignored in hi res", vidsoft.c:958). It is rasterized with the normal path at the real
		//? width, which is much closer than giving a quarter of the screen.

		let height = VDP2_VRESO_HEIGHT[(tvmd >> 4) & 0x3];
		// LSMD (bits 7-6) = interlace mode. In DOUBLE-DENSITY (11B) the frame has
		// TWICE the lines: 224 -> 448. It is the mode of AM2's
		// racing games (Touring Car and Daytona CCE ask for 704x448) and without this the height
		// came out halved.
		// The 448 lines are rasterized as a progressive frame: it is not really interlaced
		// (even/odd fields are not alternated), which is fidelity still missing, but the
		// GEOMETRY ends up right and that is what was breaking the image.
		const lsmd = (tvmd >> 6) & 0x3;
		if(lsmd === 3 && height > 0) height *= 2;

		// VRESO=11B is "Not Allowed": what the HW does there is not documented, so the previous height
		// is kept instead of inventing one (Yabause does the same: "default: break").
		return this._resize(width, height < 0 ? this.height : height);
	}

	// Changes the output geometry. The buffers are reallocated ONLY if something changed: they are
	// ~280 KB and this runs on every frame.
	_resize(width, height)
	{
		if(width === this.width && height === this.height) return false;
		this.width = width;
		this.height = height;
		this.fb = new Uint8ClampedArray(width * height * 4);
		this._alpha = new Uint8Array(width * height);
		this.priorities = new Uint8Array(width * height);
		this.shadowOk = new Uint8Array(width * height);
		this._fb32 = null;   // the 32-bit view was hanging off the old buffer
		return true;
	}

	// Debug: shows ONLY 'name' (nbg0..nbg3, rbg0, rbg1) and ignores the priority
	// filter, so the layer shows up even if the game gave it priority 0. It is the
	// bisection by layers to find out which one is the "sky": you isolate each one and see which one
	// paints it (or, if none does, the problem is that the game does not enable it).
	// showAll() reverts. Meant for the console (vdp2.onlyLayer("nbg1")) and the harness.
	onlyLayer(name)
	{
		this.layersOff = new Set(["nbg0", "nbg1", "nbg2", "nbg3", "rbg0", "rbg1"].filter(n => n !== name));
		this.ignorePriority = true;
	}
	showAll()
	{
		this.layersOff = new Set();
		this.ignorePriority = false;
	}

	// ---------------------------------------------------------------------------
	// RENDER: composes the back screen and all the layers according to their priority.
	// cfg = { backdrop:[r,g,b], backdropLines:[[r,g,b],...]|null, ccMode:0-2,
	//         alphaBack:0-63, lineColor:{color,lines,alpha}|null,
	//         layers:[ {type, priority, order, ...}, ... ] }.
	// Public signature: fills this.fb (do not change). The new fields are optional: without
	// them (render({}) or an old cfg) the result is identical to before.
	// ---------------------------------------------------------------------------
	render(cfg)
	{
		// The geometry is reread HERE, before rasterizing: this.fb can change
		// size and all the loops below go against this.width/this.height.
		// index.html already reads vdp2.width/vdp2.height AFTER render() and rebuilds its
		// ImageData only when they change (see imageDataTv()), so it follows the change.
		this._configureResolution();
		cfg = cfg || {};
		const bd = cfg.backdrop || [0, 0, 0];
		const lines = cfg.backdropLines || null;
		const fb = this.fb;

		// --- DOUBLE-DENSITY: ONE FIELD PER FRAME (what the hardware does) ---
		//
		// With LSMD=3 (TVMD bits 7-6) the screen has 448 lines, but the Saturn does NOT
		// show them all on every frame: it shows one FIELD -the even or the odd lines- every
		// 1/60 s, and the CRT weaves the two. Rasterizing all 448 on every frame was doing
		// TWICE the work of the console, and it is what put Sega Touring Car and
		// Daytona CCE at 31 ms of video against the 16.68 budget (measured with
		// diag/bench-video.mjs; the ceiling of this optimization was measured before writing it
		// and gave exactly 2x: 30.89 -> 15.16 ms).
		//
		// The weaving comes for free: this.fb, priorities, shadowOk and _alpha PERSIST between
		// frames, so by writing only the current field's lines the other field's lines
		// stay as the previous frame's. Same as the CRT.
		//
		// Outside double-density -the other 7 games of the bench- start=0 and step=1, i.e.
		// exactly the usual walk: their output stays bit-identical.
		// THE FIELD CAN BE FORCED FROM OUTSIDE (fieldForced >= 0) and then it is NOT toggled.
		// It is needed when the render is split among several threads: each one has its own
		// instance, and if each toggled its _field on its own, a single frame
		// missed by one of them would be enough for them to rasterize OPPOSITE fields and the frame would come out
		// mixed. The one that knows how many frames went by is the main thread, so the field
		// is decided by it and travels in the message.
		// With -1 (the default) it toggles on its own, exactly as always.
		const interlaced = ((this._r(0x00) >> 6) & 0x3) === 3;
		const fieldStart  = interlaced ? (this.fieldForced >= 0 ? this.fieldForced : (this._field ^= 1)) : 0;
		const fieldStep = interlaced ? 2 : 1;

		// --- BAND: THE SAME MECHANISM, TO SPLIT THE RENDER AMONG SEVERAL THREADS ---
		//
		// The walk above already knows how to rasterize a SUBSET of lines (it is what
		// interlacing does). Splitting the render among N threads is exactly the same thing with another
		// step: thread k does lines k, k+N, k+2N... It COMPOSES with the field, it does not
		// replace it — an interlaced game split across 2 threads ends up with step 4.
        //
		// Interleaved and not contiguous bands on purpose: lines do not all cost the same
		// (one with three layers costs much more than one of sky), so splitting into contiguous
		// halves would unbalance the threads. Alternating, each thread gets an even
		// sample of the frame without having to measure anything.
		//
		// bandStep = 1 (the default value) is the usual walk: bit-identical output.
		this._fieldStart  = fieldStart + this.bandStart * fieldStep;
		this._fieldStep = fieldStep * this.bandStep;

		// Back screen: uniform color or one per line (BKTAU bit15). It is filled with
		// a 32-bit view (one fill per line, or a single one if the color is
		// uniform) instead of writing the 4 bytes of each pixel by hand.
		const fb32 = (this._fb32 && this._fb32.buffer === fb.buffer)
			? this._fb32 : (this._fb32 = new Uint32Array(fb.buffer));
		// The fill also goes per field: a whole fill would erase the lines of the previous
		// field, which are exactly the ones being preserved.
		if(!lines && this._fieldStep === 1)
		{
			fb32.fill(this._packRgb(bd));
		}
		else
		{
			const pk = lines ? null : this._packRgb(bd);
			for(let j = this._fieldStart; j < this.height; j += this._fieldStep)
			{
				const o = j * this.width;
				fb32.fill(lines ? this._packRgb(lines[j] || bd) : pk, o, o + this.width);
			}
		}
		// Line screen: color per line (or a single one) + its ratio. _putPixelLayer() reads it
		// as the SECOND IMAGE in the layers that have their bit in LNCLEN. With no layers asking
		// for it, it stays null and the compositor behaves the same as before.
		this._lnc = cfg.lineColor || null;

		// Ratio of the back screen as second image (CCRLB BKCCRT); see _readBackScreen().
		// Without cfg.alphaBack (render({}) in the tests) it stays 0x3F = opaque, as always.
		this._fillField(this._alpha, cfg.alphaBack === undefined ? 0x3F : cfg.alphaBack);
		// Priority 0 = "considered transparent and not displayed".
		// It is the right value for the backdrop, which is always behind everything: it lets
		// any sprite with priority >= 1 beat it without any special case.
		this._fillField(this.priorities, 0);
		// The backdrop has its own shadow bit: BKSDEN (SDCTL bit 5,
		// 1800E2H, "for BACK"). It is filled with it because the backdrop is
		// what is left if no layer paints the pixel.
		this._fillField(this.shadowOk, (this._r(0xE2) & 0x20) ? 1 : 0);

		if(!cfg.layers) return fb;

		const ccMode = cfg.ccMode || 0;

		// Composition by priority: layers with priority 0 are discarded (on
		// the Saturn they are not displayed) and drawing goes back to front. At equal
		// priority 'order' is used as the tiebreaker (higher order = further in front).
		// The tiebreak is fixed in hardware: when priorities are equal, the
		// priority is decided by a fixed order. From front to
		// back: sprite -> RBG0 -> NBG0 -> NBG1 -> NBG2 -> NBG3. Hence RBG0=4, NBG0=3,
		// NBG1=2, NBG2=1, NBG3=0. The sprite does not enter this sort: its priority is PER
		// PIXEL and vdp1.js resolves it against this.priorities.
		// The other three configurations of that order do NOT reorder anything: they REPLACE who
		// occupies each rank (RBG1 replaces NBG0, EXBG replaces NBG1), so a fixed 'order'
		// is enough and there is no need to recompute it per configuration.
		// 17-07-2026: NBG0 and RBG0 were SWAPPED. 'order' is a transcription of the
		// TITAN_* constants of Yabause (titan.h: SPRITE=5, RBG0=4, NBG0=3, NBG1=2,
		// NBG2=1, NBG3=0), which THIS TIME match the hardware; when copying them
		// those two got inverted. That NBG1/NBG2/NBG3 land exactly on 2/1/0 is the proof
		// that this scheme was being copied.
		const layers = cfg.layers
			.filter(c => c && (this.ignorePriority || c.priority > 0) && !this.layersOff.has(c.name))
			.slice()
			.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));

		for(const layer of layers)
		{
			if(layer.type === "rbg")
				this._renderRBG(layer, ccMode);
			else
				this._renderNBG(layer, ccMode);
		}

		return fb;
	}

	// ---------------------------------------------------------------------------
	// configFromRegisters(): decodes the real registers and builds the cfg.
	// Returns null if the display is off (TVMD DISP=0). Public signature.
	// ---------------------------------------------------------------------------
	configFromRegisters()
	{
		const tvmd = this._r(0x00);
		if(!(tvmd & 0x8000)) return null;          // DISP off -> no signal

		const ramctl = this._r(0x0E);
		const colorMode = (ramctl >> 12) & 0x3;    // CRMD: Color RAM mode
		const vramBig = (this._r(0x06) & 0x8000) !== 0;   // VRSIZE VRAMSZ

		// ★ THE VRAM CYCLE PATTERN REGISTERS, decoded (29-07-2026).
		// `CYCA0L/U` `CYCA1L/U` `CYCB0L/U` `CYCB1L/U` — 180010H to 18001EH. They were the only 8
		// gaps left from the register sweep.
		//
		// Layout: each register carries FOUR 4-bit fields, one per
		// pixel "timing", from most significant to least:
		//     CYCxxL: T0 (bits 15-12), T1 (11-8), T2 (7-4), T3 (3-0)
		//     CYCxxU: T4, T5, T6, T7
		// and there is a pair for each VRAM bank: A0, A1, B0, B1.
		//
		// What each value means:
		//   0-3   pattern name data of NBG0-NBG3
		//   4-7   character pattern data (or bitmap) of NBG0-NBG3
		//   8-11  illegal value
		//   12-13 vertical cell scroll table of NBG0 / NBG1
		//   14    CPU data (the CPU may either read from or write to VRAM)
		//   15    nobody can access VRAM
		//
		// And the fact that makes this matter: there are EIGHT MEMORY CYCLES PER PIXEL (four in
		// hi-res mode), with VRAM split into up to 4 banks, i.e. up to 32 accesses per pixel.
		//? WHAT IS NOT DONE WITH THIS YET, and why:
		//? 1. ✖ CHARGING THE SH-2 THE VDP2 VRAM WAIT — **the model does NOT explain what was measured**,
		//?    so it is not implemented. These registers control how much
		//?    access the CPU has to VDP2 VRAM while the screen is being displayed (the CPU may
		//?    access VRAM freely during the vertical blanking interval), and value 14 is the
		//?    only one that says "CPU data". From that it follows that a game with cpuPerPixel = 0
		//?    should not be able to touch the VDP2 VRAM during display.
		//?    THAT PREDICTION WAS TESTED AND IT FAILS (diag/vdp2-cycles.mjs crossed with
		//?    diag/bbus-when.mjs, accesses per frame to the VDP2 VRAM during display):
		//?        game      cpuPerPixel   in display   in vblank
		//?        sfa           0.0          3,036         66
		//?        touring       0.0            886        270
		//?        rally         0.0            317         28
		//?        xmen          0.0             20          6
		//?        vc            5.5            114          8
		//?        sonic         3.7            243         58
		//?    The four with ZERO reserved cycles touch it anyway, and SF Alpha 3,036 times per
		//?    frame. If the hardware blocked the CPU, that would be impossible.
		//?    The reading that would close it: the cycle patterns RESERVE accesses for the VDP2's
		//?    consumers and the CPU uses the gaps left over -i.e. 15 ("nobody can access
		//?    VRAM") means "no VDP2 consumer", not "not the CPU either"-. With 8 cycles x
		//?    320 x 224 there are 573,440 memory cycles per frame, and SFA's 3,036 are 0.5%:
		//?    it slips in easily. But THAT IS NOT IN ANY SOURCE, so it is a hypothesis.
		//?    → Charging a wait on a model that does not explain what is observed would be inventing the
		//?    number, which is the same thing that already killed the Mednafen rates hypothesis.
		//? 2. Validating the configuration. The number of accesses needed per data type is known
		//?    (1 for pattern name; 1/2/4/8 for character depending on the colors; 1 for vertical cell
		//?    scroll; x2 or x4 if the layer is reduced). If the game does not reserve enough for
		//?    a layer, the real chip does not draw it right and we draw it anyway.
		//? See PENDING.md section 2.2.

		const bs = this._readBackScreen(colorMode, vramBig);
		const cfg = { backdrop: bs.color, backdropLines: bs.lines, alphaBack: bs.alpha, layers: [] };
		cfg.patternsCycle = this._readPatternsCycle();   // see the block above

		// Line screen (LNCLEN 1800E8H). The table is only built if some VDP2 layer
		// asks for it: it is up to 'height' VRAM + CRAM reads per frame and the register starts at
		// 0 (it is cleared to 0 after power-on or reset).
		// //? SPLCEN (LNCLEN bit 5, "for sprites") is left out on purpose: in this
		// //  emulator the sprite layer is composed by vdp1.js after the VDP2, so the
		// //  insertion of line color under a sprite left as top image cannot be done
		// //  from this file. That is why the mask is 0x1F and not 0x3F.
		const lnclen = this._r(0xE8);
		cfg.lineColor = (lnclen & 0x1F) ? this._readLineScreen(colorMode, vramBig) : null;

		// Global color calculation mode (CCCTL): CCMD (bit8) takes priority
		// over CCRTMD (bit9), same as in vidsoft.c.
		const ccctl = this._r(0xEC);
		cfg.ccMode = (ccctl & 0x100) ? 1 : ((ccctl & 0x200) ? 2 : 0);

		const bgon = this._r(0x20);

		// Labels each layer with its name (for debug layer isolation) and
		// adds it. The name travels in the layer object to render(), which skips the ones
		// that are in this.layersOff.
		const add = (name, layer) => { layer.name = name; cfg.layers.push(layer); };

		// NBG0 and RBG1 share registers: if BGON bit5 is set RBG1 is drawn
		// (rotated with parameter B) instead of NBG0.
		if(bgon & 0x20)
			add("rbg1", this._configRBG1(colorMode, vramBig));
		else if(bgon & 0x01)
			add("nbg0", this._configNBG0(colorMode, vramBig));

		if(bgon & 0x02) add("nbg1", this._configNBG1(colorMode, vramBig));
		if(bgon & 0x04) add("nbg2", this._configNBG2(colorMode, vramBig));
		if(bgon & 0x08) add("nbg3", this._configNBG3(colorMode, vramBig));
		if(bgon & 0x10) add("rbg0", this._configRBG0(colorMode, vramBig));

		return cfg;
	}

	// Back screen (BKTAU/BKTAL). Returns { color:[r,g,b], lines:[[r,g,b],...] }.
	// With BKTAU bit15 the color is per line; otherwise, uniform (lines = null).
	_readBackScreen(colorMode, vramBig)
	{
		const bktau = this._r(0xAC);
		const bktal = this._r(0xAE);
		// VRSIZE widens the BKTAU range from 2 to 3 bits (vidsoft.c).
		const addr = (((bktau & (vramBig ? 0x7 : 0x3)) << 16) | bktal) * 2;
		const off = this._readColorOffset(1 << 5);      // the back screen uses CLOFEN bit5

		const conv = (dot) => {
			const c = this._rgb555(dot);
			return off ? this._addOffset(c, off) : c;
		};

		// The back screen does NOT have its own CC enable bit: CCCTL only has N0-N3, R0, LC and
		// SP. It is never the top image, so its ratio (CCRLB BKCCRT, bits 12-8) is
		// used only when the back screen is the SECOND image and CCRTMD is in charge.
		// In normal color calculation, when specifying on the
		// second image side, the color calculation ratio can change depending on the
		// screen of the second image, and the ratio value of not only the
		// sprite and scroll screens but also the line color screen and back screen is used.
		// _alphaOfRatio with bitIn=0 does exactly that: it returns the ratio only if CCRTMD.
		const alpha = this._alphaOfRatio(0, (this._r(0x10E) >> 8) & 0x1F);   // CCRLB BKCCRT

		if(bktau & 0x8000)
		{
			const lines = [];
			for(let j = 0; j < this.height; j++) lines.push(conv(this._vw(addr + j * 2)));
			return { color: lines[0], lines: lines, alpha: alpha };
		}
		return { color: conv(this._vw(addr)), lines: null, alpha: alpha };
	}

	// ---------------------------------------------------------------------------
	// LINE COLOR SCREEN (LNCL). Returns { color:[r,g,b], lines:[[r,g,b],...]|null, alpha }.
	// configFromRegisters() calls it ONLY if some layer asks for it in LNCLEN.
	// It is the relative of the back screen, but with two differences:
	//
	// 1) The table stores a COLOR RAM ADDRESS, not an RGB color: each entry is the
	//    color RAM address of the color used in
	//    that line, and its format is
	//    an 11-bit color RAM address (bits 15-11 are ignored). The back screen, on the
	//    other hand, stores direct RGB (BLUE data 5 bits / GREEN data 5 bits /
	//    RED data 5 bits).
	// 2) Additionally, when the color RAM mode is mode 0 or mode 2, the most significant
	//    bit of the address is ignored. That fits the CRAM modes: modes 0 and 2
	//    have 1024 colors (10-bit index) and mode 1 has 2048 (11 bits).
	//
	// LCCLMD (LCTAU bit15) picks a single color or one per line: 0 = make it monochrome /
	// 1 = specify for each line, and in monochrome the data at the beginning of the table
	// is used for the entire screen.
	//!wip, 17-07-2026
	_readLineScreen(colorMode, vramBig)
	{
		const lctau = this._r(0xA8);
		const lctal = this._r(0xAA);
		// (Line color screen table start address) = (line color screen table address
		// register value, 19 bits) x 2H (LCTA18-16 in 1800A8H bits 2-0 and LCTA15-0
		// in 1800AAH). If the VRAM capacity is 4 Mbits, the most significant bit of the
		// address is ignored: same criterion as BKTAU in _readBackScreen().
		const addr = (((lctau & (vramBig ? 0x7 : 0x3)) << 16) | lctal) * 2;
		const mask = (colorMode === 1) ? 0x7FF : 0x3FF;
		// Ratio of the LNCL as second image (CCRLB LCCCRT, bits 4-0). Its bit in CCCTL is
		// LCCCEN (bit 5), same as the rest of the layers in _configCommon().
		const alpha = this._alphaOfRatio(0x20, this._r(0x10E) & 0x1F);

		// //? The line color screen can also be rotated using
		// //  the line color screen data in the coefficient data: the coefficient table
		// //  of RBG0/RBG1 can carry its own line color address per pixel. That is not
		// //  here: here the line color is always the line's. Without hard data on that case
		// //  nothing is invented.
		if(lctau & 0x8000)                          // LCCLMD: one color per line
		{
			const lines = [];
			for(let j = 0; j < this.height; j++)
				lines.push(this.colorFromCram(this._vw(addr + j * 2) & mask, colorMode));
			return { color: lines[0], lines: lines, alpha: alpha };
		}
		return { color: this.colorFromCram(this._vw(addr) & mask, colorMode), lines: null, alpha: alpha };
	}

	// Adds a color offset [cor,cog,cob] to an [r,g,b] with saturation.
	_addOffset(rgb, off)
	{
		const cl = (v) => (v < 0 ? 0 : (v > 255 ? 255 : v));
		return [ cl(rgb[0] + off[0]), cl(rgb[1] + off[1]), cl(rgb[2] + off[2]) ];
	}

	// --- Register decoding helpers (ported from vidshared.h) ---

	// ReadVdp2ColorOffset: returns [cor,cog,cob] (signed 9 bits, -256..255) or
	// null if the layer has no color offset. 'mask' is the layer's bit in
	// CLOFEN; the same bit in CLOFSL picks register set A or B.
	_readColorOffset(mask)
	{
		if(!(this._r(0x110) & mask)) return null;          // CLOFEN
		const s9 = (v) => { v &= 0x1FF; return (v & 0x100) ? v - 0x200 : v; };
		if(this._r(0x112) & mask)                          // CLOFSL: 1 = offset B
			return [ s9(this._r(0x11A)), s9(this._r(0x11C)), s9(this._r(0x11E)) ];   // COBR/COBG/COBB
		return [ s9(this._r(0x114)), s9(this._r(0x116)), s9(this._r(0x118)) ];       // COAR/COAG/COAB
	}

	// Color calculation ratio of a layer: 6 bits, 0x3F = opaque. 'bitIn' is the
	// layer's bit in CCCTL and 'ratio' the 5-bit field of the CCRxx register.
	// Yabause takes the ratio also when CCRTMD (bit9) is active, because in
	// that mode any layer can contribute its own as "second image".
	_alphaOfRatio(bitIn, ratio)
	{
		const ccctl = this._r(0xEC);
		if((ccctl & bitIn) || (ccctl & 0x200))
			return ((~ratio & 0x1F) << 1) + 1;
		return 0x3F;
	}

	// Fills in the color calculation / color offset / window / mosaic fields
	// common to all layers. 'bit' is the layer's bit (0x1 NBG0 ... 0x10 RBG0),
	// which is the same in CCCTL, CLOFEN, CLOFSL and MZCTL.
	_configCommon(layer, bit, ratio, wctl)
	{
		layer.ccEnable = (this._r(0xEC) & bit) !== 0;       // CCCTL xxCCEN
		// SDCTL (1800E2H) lays out the bits THE SAME as CCCTL/CLOFEN/LNCLEN: N0SDEN bit0,
		// N1SDEN bit1, N2SDEN bit2, N3SDEN bit3, R0SDEN bit4 (the
		// "Shadow enable bits"), so 'bit' works as is. It says whether THIS layer accepts
		// a shadow sprite halving its brightness. The register is cleared to 0
		// on reset (the game has to set it), i.e. by default NOBODY accepts shadow.
		layer.sdEnable = (this._r(0xE2) & bit) !== 0;      // SDCTL xxSDEN
		layer.alpha = this._alphaOfRatio(bit, ratio);
		layer.offsetColor = this._readColorOffset(bit);
		// LNCLEN (1800E8H) uses EXACTLY the same bit layout as CCCTL/CLOFEN for
		// the 5 layers: N0LCEN bit0, N1LCEN bit1, N2LCEN bit2, N3LCEN bit3, R0LCEN bit4,
		// so 'bit' works as is. RBG1 goes in through bit0
		// because N0LCEN (1800E8H bit 0) is for NBG0 (or for RBG1).
		layer.lncEnable = (this._r(0xE8) & bit) !== 0;      // LNCLEN xxLCEN
		layer.wctl = wctl & 0xFF;
		this._readMosaic(layer, bit);
	}

	// ReadMosaicData: mosaic size (MZCTL). Bits 0-4 enable the layer,
	// bits 8-11 give the width and 12-15 the height (minus 1).
	_readMosaic(layer, bit)
	{
		const mz = this._r(0x22);
		if(mz & bit)
		{
			layer.mosaicX = ((mz >> 8) & 0xF) + 1;
			layer.mosaicY = ((mz >> 12) & 0xF) + 1;
		}
		else
		{
			layer.mosaicX = 1;
			layer.mosaicY = 1;
		}
	}

	// ReadLineScrollData: line scroll of NBG0/NBG1. 'ctl' is the layer's SCRCTL byte
	// and 'tbl' the value of LSTA0/LSTA1.
	//   bit1 = X scroll per line, bit2 = Y scroll per line, bit3 = zoom per line
	//   bits 4-5 = line interval per table entry (1, 2, 4 or 8)
	_readLineScroll(layer, ctl, tbl)
	{
		if(ctl & 0xE)
		{
			layer.lineScroll = (ctl >> 1) & 0x7;
			layer.lineScrollTbl = (tbl & 0x7FFFE) << 1;
			layer.lineInc = 1 << ((ctl >> 4) & 0x3);
		}
		else
		{
			layer.lineScroll = 0;
			layer.lineInc = 0;
		}
	}

	// Vertical cell scroll (SCRCTL bit0 = NBG0, bit8 = NBG1). The table VCSTA points to
	// has one long per cell column (8 px) and per enabled layer, with
	// the layers interleaved (NBG0 first).
	_readVerticalCellScroll(layer, isNbg0)
	{
		const scrctl = this._r(0x9A);
		const in0 = (scrctl & 0x1) !== 0;
		const in1 = (scrctl & 0x100) !== 0;
		if(isNbg0 ? !in0 : !in1) { layer.vcsc = false; return; }

		layer.vcsc = true;
		layer.vcscBase = (this._rl(0x9C) & 0x7FFFE) << 1;
		layer.vcscStep = ((in0 ? 1 : 0) + (in1 ? 1 : 0)) * 4;   // bytes per column
		layer.vcscSlot = (isNbg0 || !in0) ? 0 : 4;              // offset within the column
	}

	// Layer zoom (ZMXNx/ZMYNx): 3 integer bits + 8 fraction bits. It is the increment
	// in background pixels per screen pixel (1 = 1:1, 0.5 = double size).
	// Decodes the 8 cycle pattern registers into something consumable. Returns, per bank, the
	// timings (8, or 4 in hi-res), plus the summary that matters: how many accesses per pixel are
	// left to the CPU (value 14) and whether the configuration uses any illegal value (8-11).
	//
	// THE WIDTH MATTERS: banks A1 and B1 only count if VRAM is SPLIT. If
	// VDP2 VRAM is configured as two larger banks instead of four smaller ones, the cycle
	// pattern registers for banks A1 and B1 are ignored. The split is given by RAMCTL (0x0E):
	// bit 8 = VRAMD (bank A), bit 9 = VRBMD (bank B).
	//ok, 29-07-2026
	_readPatternsCycle()
	{
		const ramctl = this._r(0x0E);
		const splitA = (ramctl & 0x100) !== 0;
		const splitB = (ramctl & 0x200) !== 0;
		// In hi-res (HRESO >= 2) there are FOUR memory cycles per pixel, not eight.
		const timings = ((this._r(0x00) & 0x7) >= 2) ? 4 : 8;

		const defs = [
			{ name: "A0", regL: 0x10, active: true },
			{ name: "A1", regL: 0x14, active: splitA },
			{ name: "B0", regL: 0x18, active: true },
			{ name: "B1", regL: 0x1C, active: splitB }
		];
		const banks = [];
		let cpuPerPixel = 0, illegal = 0;
		for(const d of defs)
		{
			if(!d.active) continue;
			const lo = this._r(d.regL), hi = this._r(d.regL + 2);
			const t = [];
			for(let k = 0; k < timings; k++)
			{
				// T0 is in the MOST significant bits of the low register; T4 in those of the high one.
				const reg = (k < 4) ? lo : hi;
				const v = (reg >> (12 - (k % 4) * 4)) & 0xF;
				t.push(v);
				if(v === 14) cpuPerPixel++;
				if(v >= 8 && v <= 11) illegal++;
			}
			banks.push({ bank: d.name, timings: t });
		}
		return { banks: banks, timings: timings, cpuPerPixel: cpuPerPixel, illegal: illegal };
	}
	//? MISSING: `ZMCTL` (180098H), the Zoom Half bits — `N0ZMQT`/`N0ZMHF` and `N1ZMQT`/`N1ZMHF`.
	//? The zoom we read here is the 11.8-bit fractional factor (integer + fraction, both
	//? halves since 28-07-2026). What 180098H adds is which reduction STEP the
	//? layer is at —half or quarter—, and the chip does not use that only for the size:
	//? it changes HOW MANY VRAM ACCESSES have to be reserved for it
	//? (reducing the screen by a factor of more than one but not more than two doubles the
	//? number of pattern name data and character pattern data accesses required;
	//? reducing it by as much as a factor of four quadruples them).
	//? So its natural consumer is the cycle patterns, which are not there either (see the //? on
	//? the CYCxxx). As long as the VRAM access split does not exist, this register has nobody
	//? to report to. It came out of the register sweep.
	_readZoom(layer, regX, regY)
	{
		layer.coordincx = (this._rl(regX) & 0x7FF00) / 65536;
		layer.coordincy = (this._rl(regY) & 0x7FF00) / 65536;
	}

	// ReadPlaneSize: plane size (in pages) according to the 2 PLSZ bits.
	_readSizePlane(layer, reg)
	{
		switch(reg & 0x3)
		{
			case 1:
				layer.planew = 2; layer.planew_bits = 1;
				layer.planeh = 1; layer.planeh_bits = 0;
				break;
			case 3:
				layer.planew = layer.planeh = 2;
				layer.planew_bits = layer.planeh_bits = 1;
				break;
			default:                                // 0 and 2
				layer.planew = layer.planeh = 1;
				layer.planew_bits = layer.planeh_bits = 0;
				break;
		}
	}

	// ReadPatternData: format of the pattern-name table (PNCNx).
	_readPatternData(layer, pnc, chctlwh)
	{
		layer.patterndatasize = (pnc & 0x8000) ? 1 : 2;          // 1 or 2 words per cell
		layer.patterndatasize_bits = (pnc & 0x8000) ? 0 : 1;
		layer.patternwh = chctlwh ? 2 : 1;                        // 16x16 or 8x8 cell
		layer.patternwh_bits = chctlwh ? 1 : 0;
		layer.pagewh_bits = 6 - layer.patternwh_bits;              // 6 (8x8) or 5 (16x16)
		layer.supplementdata = pnc & 0x3FF;
		layer.auxmode = (pnc & 0x4000) >> 14;
	}

	// ReadBitmapSize: bitmap dimensions according to bits of CHCTLA/B.
	_readSizeBitmap(layer, bm, mask)
	{
		switch(bm & mask)
		{
			case 0: layer.cellw = 512;  layer.cellh = 256;  break;
			case 1: layer.cellw = 512;  layer.cellh = 512;  break;
			case 2: layer.cellw = 1024; layer.cellh = 256;  break;
			case 3: layer.cellw = 1024; layer.cellh = 512;  break;
		}
		// SetupScreenVars uses the bitmap dimensions as screen masks.
		layer.xmask = layer.cellw - 1;
		layer.ymask = layer.cellh - 1;
	}

	// CalcPlaneAddr: base address (in VRAM bytes) of a plane from the
	// value of its map register. Yabause always uses the large VRSIZE branch.
	_calcPlaneAddr(layer, tmp)
	{
		const deca = layer.planeh + layer.planew - 2;
		const multi = layer.planeh * layer.planew;
		if(layer.patterndatasize === 1)
		{
			if(layer.patternwh === 1)
				return ((tmp & 0x3F) >> deca) * (multi * 0x2000);
			return (tmp >> deca) * (multi * 0x800);
		}
		if(layer.patternwh === 1)
			return ((tmp & 0x1F) >> deca) * (multi * 0x4000);
		return ((tmp & 0x7F) >> deca) * (multi * 0x1000);
	}

	// Computes the derived screen variables (SetupScreenVars) for a tile
	// layer: plane/screen masks used when mapping coordinates.
	_prepareLayerTile(layer)
	{
		layer.planepixelwidth_bits = 8 + layer.planew;            // 9 (1 page) or 10 (2)
		layer.planepixelwidth_mask = (1 << layer.planepixelwidth_bits) - 1;
		layer.planepixelheight_bits = 8 + layer.planeh;
		layer.planepixelheight_mask = (1 << layer.planepixelheight_bits) - 1;
		const screenwidth = layer.mapwh * layer.planew * 512;
		const screenheight = layer.mapwh * layer.planeh * 512;
		layer.xmask = screenwidth - 1;
		layer.ymask = screenheight - 1;
	}

	// Builds the plane address table (GeneratePlaneAddrTable). 'regs'
	// is the list of map register values (MPABNx/MPCDNx or the 8 for
	// rotation), each one contributes 2 entries (low and high byte). 'offset' comes from
	// MPOFN/MPOFR.
	_planesTable(layer, offset, regs)
	{
		const tbl = [];
		const total = layer.mapwh * layer.mapwh;
		for(let i = 0; i < total; i++)
		{
			const w = regs[i >> 1];
			const tmp = offset | ((i & 1) ? (w >> 8) : (w & 0xFF));
			tbl.push(this._calcPlaneAddr(layer, tmp));
		}
		return tbl;
	}

	// --- Configuration of each scroll layer (NBG0-3) ---

	_configNBG0(colorMode, vramBig)
	{
		const chctla = this._r(0x28);
		const layer = {
			type: "nbg", order: 3,
			priority: this._r(0xF8) & 0x7,                     // PRINA bits 0-2
			colornumber: (chctla & 0x70) >> 4,                  // CHCTLA N0CHCN
			offsetCram: (this._r(0xE4) & 0x7) << 8,            // CRAOFA
			transparency: !(this._r(0x20) & 0x100),            // BGON N0TPON
			colorMode: colorMode, vramBig: vramBig,
			// SCROLL WITH ITS FRACTIONAL PART (sub-pixel). The hardware splits the value across
			// TWO registers: SCXIN0 (0x70) carries the integer in bits
			// 10-0 and SCXDN0 (0x72) the fraction in bits 15-8 -8 bits, i.e. 1/256 of a
			// pixel-; bits 7-0 of that second register do not exist.
			// We read ONLY the integer, which is like having the sub-pixel always at 0.
			//
			// ⚠ Where it DOES show and where it does NOT, so as not to over-read it: with increment 1 (no
			// zoom) not a single pixel changes, because sampling does floor(scroll + x) and adding
			// a fraction smaller than 1 to an integer does not move the floor. What changes is the
			// PHASE when the layer is ZOOMED (ZMXN != 1) or with line scroll, which is
			// exactly where the hardware shows the smooth movement. That is why the zoom was already
			// fractional (_readZoom) and this was not: half of the math was missing.
			scrollX: (this._r(0x70) & 0x7FF) + ((this._r(0x72) >> 8) & 0xFF) / 256,   // SCXIN0 + SCXDN0
			scrollY: (this._r(0x74) & 0x7FF) + ((this._r(0x76) >> 8) & 0xFF) / 256    // SCYIN0 + SCYDN0
		};

		if(chctla & 0x2)                                        // N0BMEN: bitmap
		{
			layer.bitmap = true;
			this._readSizeBitmap(layer, chctla >> 2, 0x3);        // N0BMSZ
			layer.charBase = (this._r(0x3C) & 0x7) * 0x20000;    // MPOFN
			layer.paladdr = (this._r(0x2C) & 0x7) << 8;          // BMPNA
		}
		else
		{
			layer.bitmap = false;
			layer.mapwh = 2;
			this._readSizePlane(layer, this._r(0x3A));            // PLSZ N0PLSZ
			this._readPatternData(layer, this._r(0x30), chctla & 0x1);   // PNCN0, N0CHSZ
			this._prepareLayerTile(layer);
			const offset = (this._r(0x3C) & 0x7) << 6;          // MPOFN N0MP
			layer.planetbl = this._planesTable(layer, offset,
				[ this._r(0x40), this._r(0x42) ]);              // MPABN0, MPCDN0
		}

		this._configCommon(layer, 0x1, this._r(0x108) & 0x1F, this._r(0xD0));   // CCRNA, WCTLA
		this._readZoom(layer, 0x78, 0x7C);                       // ZMXN0, ZMYN0
		this._readLineScroll(layer, this._r(0x9A) & 0xFF, this._rl(0xA0));     // SCRCTL, LSTA0
		this._readVerticalCellScroll(layer, true);
		return layer;
	}

	_configNBG1(colorMode, vramBig)
	{
		const chctla = this._r(0x28);
		const layer = {
			type: "nbg", order: 2,
			priority: (this._r(0xF8) >> 8) & 0x7,              // PRINA bits 8-10
			colornumber: (chctla & 0x3000) >> 12,               // N1CHCN
			offsetCram: (this._r(0xE4) & 0x70) << 4,           // CRAOFA
			transparency: !(this._r(0x20) & 0x200),            // N1TPON
			colorMode: colorMode, vramBig: vramBig,
			// Same as NBG0: integer + 8-bit fraction. See the note in _configNBG0.
			scrollX: (this._r(0x80) & 0x7FF) + ((this._r(0x82) >> 8) & 0xFF) / 256,   // SCXIN1 + SCXDN1
			scrollY: (this._r(0x84) & 0x7FF) + ((this._r(0x86) >> 8) & 0xFF) / 256    // SCYIN1 + SCYDN1
		};

		if(chctla & 0x200)                                      // N1BMEN
		{
			layer.bitmap = true;
			this._readSizeBitmap(layer, chctla >> 10, 0x3);       // N1BMSZ
			layer.charBase = ((this._r(0x3C) & 0x70) >> 4) * 0x20000;
			layer.paladdr = this._r(0x2C) & 0x700;               // BMPNA
		}
		else
		{
			layer.bitmap = false;
			layer.mapwh = 2;
			this._readSizePlane(layer, this._r(0x3A) >> 2);       // PLSZ N1PLSZ
			this._readPatternData(layer, this._r(0x32), chctla & 0x100);  // PNCN1, N1CHSZ
			this._prepareLayerTile(layer);
			const offset = (this._r(0x3C) & 0x70) << 2;         // MPOFN N1MP
			layer.planetbl = this._planesTable(layer, offset,
				[ this._r(0x44), this._r(0x46) ]);              // MPABN1, MPCDN1
		}

		this._configCommon(layer, 0x2, (this._r(0x108) >> 8) & 0x1F, this._r(0xD0) >> 8);
		this._readZoom(layer, 0x88, 0x8C);                       // ZMXN1, ZMYN1
		this._readLineScroll(layer, this._r(0x9A) >> 8, this._rl(0xA4));       // SCRCTL, LSTA1
		this._readVerticalCellScroll(layer, false);
		return layer;
	}

	_configNBG2(colorMode, vramBig)
	{
		const chctlb = this._r(0x2A);
		const layer = {
			type: "nbg", order: 1, bitmap: false,
			priority: this._r(0xFA) & 0x7,                     // PRINB bits 0-2
			colornumber: (chctlb & 0x2) >> 1,                   // N2CHCN (16/256 only)
			offsetCram: this._r(0xE4) & 0x700,                 // CRAOFA
			transparency: !(this._r(0x20) & 0x400),            // N2TPON
			colorMode: colorMode, vramBig: vramBig,
			mapwh: 2,
			scrollX: this._r(0x90) & 0x7FF,                     // SCXN2
			scrollY: this._r(0x92) & 0x7FF                      // SCYN2
		};
		this._readSizePlane(layer, this._r(0x3A) >> 4);           // PLSZ N2PLSZ
		this._readPatternData(layer, this._r(0x34), chctlb & 0x1);   // PNCN2, N2CHSZ
		this._prepareLayerTile(layer);
		const offset = (this._r(0x3C) & 0x700) >> 2;            // MPOFN N2MP
		layer.planetbl = this._planesTable(layer, offset,
			[ this._r(0x48), this._r(0x4A) ]);                  // MPABN2, MPCDN2

		this._configCommon(layer, 0x4, this._r(0x10A) & 0x1F, this._r(0xD2));   // CCRNB, WCTLB
		return layer;                                            // NBG2/NBG3 have no zoom
	}

	_configNBG3(colorMode, vramBig)
	{
		const chctlb = this._r(0x2A);
		const layer = {
			type: "nbg", order: 0, bitmap: false,
			priority: (this._r(0xFA) >> 8) & 0x7,              // PRINB bits 8-10
			colornumber: (chctlb & 0x20) >> 5,                  // N3CHCN (16/256 only)
			offsetCram: (this._r(0xE4) & 0x7000) >> 4,         // CRAOFA
			transparency: !(this._r(0x20) & 0x800),            // N3TPON
			colorMode: colorMode, vramBig: vramBig,
			mapwh: 2,
			scrollX: this._r(0x94) & 0x7FF,                     // SCXN3
			scrollY: this._r(0x96) & 0x7FF                      // SCYN3
		};
		this._readSizePlane(layer, this._r(0x3A) >> 6);           // PLSZ N3PLSZ
		this._readPatternData(layer, this._r(0x36), chctlb & 0x10);  // PNCN3, N3CHSZ
		this._prepareLayerTile(layer);
		const offset = (this._r(0x3C) & 0x7000) >> 6;           // MPOFN N3MP
		layer.planetbl = this._planesTable(layer, offset,
			[ this._r(0x4C), this._r(0x4E) ]);                  // MPABN3, MPCDN3

		this._configCommon(layer, 0x8, (this._r(0x10A) >> 8) & 0x1F, this._r(0xD2) >> 8);
		return layer;
	}

	// Plane table of a rotated background. 'which' = 0 (parameter A: MPOFR bits 0-2
	// and MPABRA..MPOPRA) or 1 (parameter B: MPOFR bits 4-6 and MPABRB..MPOPRB).
	_tablePlanesRot(layer, which)
	{
		const mpofr = this._r(0x3E);
		const offset = (which === 0) ? ((mpofr & 0x7) << 6) : ((mpofr & 0x70) << 2);
		const baseReg = (which === 0) ? 0x50 : 0x60;
		const regs = [];
		for(let k = 0; k < 8; k++) regs.push(this._r(baseReg + k * 2));
		return this._planesTable(layer, offset, regs);
	}

	// --- RBG0 configuration (rotated background) ---
	_configRBG0(colorMode, vramBig)
	{
		const chctlb = this._r(0x2A);
		const layer = {
			type: "rbg", order: 4,
			priority: this._r(0xFC) & 0x7,                     // PRIR
			colornumber: (chctlb & 0x7000) >> 12,               // R0CHCN
			offsetCram: (this._r(0xE6) & 0x7) << 8,            // CRAOFB
			transparency: !(this._r(0x20) & 0x1000),           // R0TPON
			colorMode: colorMode, vramBig: vramBig
		};

		// RPMD: 0 = parameter A, 1 = parameter B, 2 = A/B according to the msb of the
		// coefficient, 3 = A/B according to the rotation parameter window.
		const rpmd = this._r(0xB0) & 0x3;
		const which = (rpmd === 1) ? 1 : 0;
		layer.rotMode = (rpmd < 2) ? 0 : (rpmd - 1);             // 0 = simple, 1 = coef, 2 = window
		layer.rot = this._readTableRotation(which);
		if(layer.rotMode) layer.rot2 = this._readTableRotation(1 - which);

		if(chctlb & 0x200)                                      // R0BMEN
		{
			layer.bitmap = true;
			this._readSizeBitmap(layer, chctlb >> 10, 0x1);       // R0BMSZ
			// MPOFR: parameter A uses bits 0-2 (x0x20000), B uses bits 4-6 (x0x2000)
			layer.charBase = (which === 0)
				? (this._r(0x3E) & 0x7) * 0x20000
				: (this._r(0x3E) & 0x70) * 0x2000;
			layer.paladdr = (this._r(0x2E) & 0x7) << 8;          // BMPNB
		}
		else
		{
			layer.bitmap = false;
			layer.mapwh = 4;
			// PLSZ: parameter A bits 8-9, B bits 12-13. Yabause uses the size of the
			// primary parameter for the secondary one too in RPMD 2/3, so
			// both tables share masks and only change base address.
			this._readSizePlane(layer, this._r(0x3A) >> (which === 0 ? 8 : 12));
			this._readPatternData(layer, this._r(0x38), chctlb & 0x100);   // PNCR, R0CHSZ
			this._prepareLayerTile(layer);
			layer.planetbl = this._tablePlanesRot(layer, which);
			if(layer.rotMode) layer.planetbl2 = this._tablePlanesRot(layer, 1 - which);
		}

		this._configCommon(layer, 0x10, this._r(0x10C) & 0x1F, this._r(0xD4));  // CCRR, WCTLC
		return layer;
	}

	// --- RBG1 configuration (rotated background that replaces NBG0) ---
	// It shares all of NBG0's registers (CHCTLA, PNCN0, CRAOFA, PRINA, WCTLA,
	// CCRNA) but it is always drawn with rotation parameter B.
	_configRBG1(colorMode, vramBig)
	{
		const chctla = this._r(0x28);
		const layer = {
			type: "rbg", order: 3, rotMode: 0,
			priority: this._r(0xF8) & 0x7,                     // PRINA bits 0-2
			colornumber: (chctla & 0x70) >> 4,                  // N0CHCN
			offsetCram: (this._r(0xE4) & 0x7) << 8,            // CRAOFA
			transparency: !(this._r(0x20) & 0x100),            // N0TPON
			colorMode: colorMode, vramBig: vramBig
		};

		layer.rot = this._readTableRotation(1);                  // always parameter B

		if(chctla & 0x2)                                        // N0BMEN
		{
			layer.bitmap = true;
			this._readSizeBitmap(layer, chctla >> 2, 0x3);        // N0BMSZ
			layer.charBase = (this._r(0x3E) & 0x70) * 0x2000;    // MPOFR parameter B
			layer.paladdr = (this._r(0x2C) & 0x7) << 8;          // BMPNA
		}
		else
		{
			layer.bitmap = false;
			layer.mapwh = 4;
			this._readSizePlane(layer, this._r(0x3A) >> 12);      // PLSZ parameter B
			this._readPatternData(layer, this._r(0x30), chctla & 0x1);   // PNCN0, N0CHSZ
			this._prepareLayerTile(layer);
			layer.planetbl = this._tablePlanesRot(layer, 1);
		}

		this._configCommon(layer, 0x1, this._r(0x108) & 0x1F, this._r(0xD0));   // CCRNA, WCTLA
		return layer;
	}

	// Reads the rotation parameter table from VRAM (Vdp2ReadRotationTable,
	// float version). 'which' = 0 (parameter A) or 1 (parameter B). Returns an
	// object with the affine matrix A-F, the reference points and, if applicable, the
	// coefficient table data.
	_readTableRotation(which)
	{
		const resp = this._rl(0xBC);
		let addr = (resp << 1) >>> 0;
		const ktctl = this._r(0xB4);
		const plsz = this._r(0x3A);
		const rot = { msb: 0 };
		if(which === 0)
		{
			addr &= 0x000FFF7C;
			rot.coefenab = (ktctl & 0x1) !== 0;
			rot.screenover = (plsz >> 10) & 0x3;
		}
		else
		{
			addr = (addr & 0x000FFFFC) | 0x00000080;
			rot.coefenab = (ktctl & 0x100) !== 0;
			rot.screenover = (plsz >> 14) & 0x3;
		}

		// Sign extension of a value with mask 'mask' and sign bit 'sb'.
		const sx = (i, mask, sb) => {
			let v = i & mask;
			if(i & sb) v |= ~(mask | (mask - 1)) & 0xFFFFFFFF;   // high bits to 1
			return v | 0;                                        // interpret as int32
		};

		//? MISSING: `RxxxSTRE` (1800B2H), the Parameter Read Enable. This table is read ONCE PER
		//? FRAME, and three of its fields can be reread PER LINE:
		//?   Parameter Read Enable (RxxxSTRE, 1800B2H), for rotation parameter A: Xst
		//?    (RAXSTRE, bit 0), Yst (RAYSTRE, bit 1), KAst (RAKASTRE, bit 2)
		//?    [and bits 8/9/10 for parameter B]
		//?    0 : the selected parameter is not read per line
		//?    1 : the selected parameter is read per line
		//? With those bits at 1 the chip fetches Xst, Yst and KAst again on EVERY LINE, i.e. the
		//? rotation can change row by row — which is how a floor in perspective is
		//? done. We freeze all three when the frame opens.
		//? It is not implemented today because moving this read to per-line is a change on the hot
		//? path of the rotation render; it stays written down here, in its place. It came out of the
		//? register sweep.
		let i;
		i = this._vl(addr); rot.Xst = sx(i, 0x1FFFFFC0, 0x10000000) / 65536; addr += 4;
		i = this._vl(addr); rot.Yst = sx(i, 0x1FFFFFC0, 0x10000000) / 65536; addr += 4;
		i = this._vl(addr); rot.Zst = sx(i, 0x1FFFFFC0, 0x10000000) / 65536; addr += 4;
		i = this._vl(addr); rot.deltaXst = sx(i, 0x0007FFC0, 0x00040000) / 65536; addr += 4;
		i = this._vl(addr); rot.deltaYst = sx(i, 0x0007FFC0, 0x00040000) / 65536; addr += 4;
		i = this._vl(addr); rot.deltaX = sx(i, 0x0007FFC0, 0x00040000) / 65536; addr += 4;
		i = this._vl(addr); rot.deltaY = sx(i, 0x0007FFC0, 0x00040000) / 65536; addr += 4;
		i = this._vl(addr); rot.A = sx(i, 0x000FFFC0, 0x00080000) / 65536; addr += 4;
		i = this._vl(addr); rot.B = sx(i, 0x000FFFC0, 0x00080000) / 65536; addr += 4;
		i = this._vl(addr); rot.C = sx(i, 0x000FFFC0, 0x00080000) / 65536; addr += 4;
		i = this._vl(addr); rot.D = sx(i, 0x000FFFC0, 0x00080000) / 65536; addr += 4;
		i = this._vl(addr); rot.E = sx(i, 0x000FFFC0, 0x00080000) / 65536; addr += 4;
		i = this._vl(addr); rot.F = sx(i, 0x000FFFC0, 0x00080000) / 65536; addr += 4;

		// Px/Py/Pz, Cx/Cy/Cz are signed 14-bit integers (unscaled).
		const sxw = (w) => { let v = w & 0x3FFF; if(w & 0x2000) v |= 0xFFFFC000; return v | 0; };
		i = this._vw(addr); rot.Px = sxw(i); addr += 2;
		i = this._vw(addr); rot.Py = sxw(i); addr += 2;
		i = this._vw(addr); rot.Pz = sxw(i); addr += 4;
		i = this._vw(addr); rot.Cx = sxw(i); addr += 2;
		i = this._vw(addr); rot.Cy = sxw(i); addr += 2;
		i = this._vw(addr); rot.Cz = sxw(i); addr += 4;

		i = this._vl(addr); rot.Mx = sx(i, 0x3FFFFFC0, 0x20000000) / 65536; addr += 4;
		i = this._vl(addr); rot.My = sx(i, 0x3FFFFFC0, 0x20000000) / 65536; addr += 4;
		i = this._vl(addr); rot.kx = sx(i, 0x00FFFFFF, 0x00800000) / 65536; addr += 4;
		i = this._vl(addr); rot.ky = sx(i, 0x00FFFFFF, 0x00800000) / 65536; addr += 4;

		if(rot.coefenab)
		{
			i = this._vl(addr); rot.KAst = (i & 0xFFFFFFC0) >>> 0; rot.KAst /= 65536; addr += 4;
			i = this._vl(addr); rot.deltaKAst = sx(i, 0x03FFFFC0, 0x02000000) / 65536; addr += 4;
			i = this._vl(addr); rot.deltaKAx = sx(i, 0x03FFFFC0, 0x02000000) / 65536; addr += 4;
			const ktaof = this._r(0xB6);
			if(which === 0)
			{
				rot.coefdatasize = (ktctl & 0x2) ? 2 : 4;
				rot.coeftbladdr = ((ktaof & 0x7) * 0x10000 + (rot.KAst | 0)) * rot.coefdatasize;
				rot.coefmode = (ktctl >> 2) & 0x3;
			}
			else
			{
				rot.coefdatasize = (ktctl & 0x200) ? 2 : 4;
				rot.coeftbladdr = (((ktaof >> 8) & 0x7) * 0x10000 + (rot.KAst | 0)) * rot.coefdatasize;
				rot.coefmode = (ktctl >> 10) & 0x3;
			}
		}
		return rot;
	}

	// ---------------------------------------------------------------------------
	// Scroll layer render (NBG0-3): walks the screen applying zoom,
	// mosaic, line scroll, vertical cell scroll and windows, and looks up the matching
	// tile or bitmap pixel.
	// ---------------------------------------------------------------------------
	_renderNBG(layer, ccMode)
	{
		const win = this._prepareWindows(layer.wctl);
		const winCC = this._prepareWindows(this._r(0xD6) >> 8);   // WCTLD: color calc window
		const ls = layer.lineScroll ? this._tablesLineScroll(layer) : null;
		const vcs = this._tableVerticalCellScroll(layer);
		const mzx = layer.mosaicX || 1;
		const mzy = layer.mosaicY || 1;
		const incx0 = (layer.coordincx === undefined) ? 1 : layer.coordincx;
		const incy = (layer.coordincy === undefined) ? 1 : layer.coordincy;
		// With no windows configured the test always gives the same result: it is evaluated once.
		const winFixed = this._noWindows(win) ? this._testBothWindows(win, 0, 0) : -1;
		const ccFixed = this._noWindows(winCC) ? (this._testBothWindows(winCC, 0, 0) !== 0) : null;
		if(winFixed === 0) return;                   // the whole layer is clipped

		for(let j = this._fieldStart; j < this.height; j += this._fieldStep)
		{
			const jm = (mzy > 1) ? (Math.floor(j / mzy) * mzy) : j;

			// Vertical scroll: per line (table) or the layer's fixed one, with zoom.
			let y = (ls && (layer.lineScroll & 0x2)) ? ls.y[j] : (layer.scrollY + incy * jm);
			y = Math.floor(y) & layer.ymask;

			const incx = (ls && (layer.lineScroll & 0x4)) ? ls.zoom[j] : incx0;
			const offsetX = (ls && (layer.lineScroll & 0x1)) ? ls.x[j] : 0;

			if(win.lineFlags) this._clipOfLine(win, j);
			if(winCC.lineFlags) this._clipOfLine(winCC, j);

			for(let i = 0; i < this.width; i++)
			{
				// Layer windows: if they clip, the pixel is not drawn.
				if(winFixed < 0 && !this._testBothWindows(win, i, j)) continue;

				const im = (mzx > 1) ? (Math.floor(i / mzx) * mzx) : i;
				let x = Math.floor(layer.scrollX + im * incx) & layer.xmask;
				if(offsetX) x = (x + offsetX) & 0x3FF;

				// Vertical cell scroll: one offset per cell column.
				let yy = y;
				if(vcs) yy = (yy + vcs[i >> 3]) & 0x1FF;

				const color = layer.bitmap
					? this._fetchPixelCell(layer, layer.charBase, x, yy, layer.paladdr, layer.cellw)
					: this._pixelTile(layer, x, yy);
				if(!color) continue;

				// Color calculation window: where the window test passes the pixel is
				// blended, where it clips the pixel stays opaque. The "inside/outside" bit
				// of WCTLD is what picks which side gets blended (vidsoft.c).
				const makeCC = (ccFixed !== null) ? ccFixed : (this._testBothWindows(winCC, i, j) !== 0);
				this._putPixelLayer(i, j, color, layer, ccMode, makeCC);
			}
		}
	}

	// Pre-generates a layer's line scroll tables (X, Y and zoom). Each entry of
	// the table in VRAM has one long per enabled component, and there is one entry
	// every 'lineInc' lines.
	// Note: Yabause advances a single shared pointer and ends up one entry out of
	// step in the first lines; here the entry is indexed directly.
	_tablesLineScroll(layer)
	{
		const n = ((layer.lineScroll & 1) ? 1 : 0) + ((layer.lineScroll & 2) ? 1 : 0) +
		          ((layer.lineScroll & 4) ? 1 : 0);
		const size = n * 4;                                  // bytes per entry
		const t = { x: new Int32Array(this.height), y: new Int32Array(this.height),
		            zoom: new Float64Array(this.height) };

		for(let j = 0; j < this.height; j++)
		{
			let a = layer.lineScrollTbl + Math.floor(j / layer.lineInc) * size;
			// The three fields are 11 integer bits (bits 26-16) + 8 of fraction.
			if(layer.lineScroll & 0x1) { t.x[j] = (this._vl(a) >>> 16) & 0x7FF; a += 4; }
			if(layer.lineScroll & 0x2) { t.y[j] = (this._vw(a) & 0x7FF) + layer.scrollY; a += 4; }
			if(layer.lineScroll & 0x4) { t.zoom[j] = (this._vl(a) & 0x7FF00) / 65536; a += 4; }
		}
		return t;
	}

	// Vertical cell scroll table: one value per cell column of the screen.
	// Returns null if the layer does not use it.
	// //? on hardware the table is reread at every HBlank; here it is read once per
	// //  frame, so if a game rewrites it mid-frame, the change is not seen.
	_tableVerticalCellScroll(layer)
	{
		if(!layer.vcsc) return null;
		const n = (this.width >> 3) + 1;
		const t = new Int32Array(n);
		for(let c = 0; c < n; c++)
			t[c] = (this._vl(layer.vcscBase + c * layer.vcscStep + layer.vcscSlot) >>> 16) & 0x7FF;
		return t;
	}

	// ---------------------------------------------------------------------------
	// Render of RBG0/RBG1 (affine rotation). For each screen pixel it computes the
	// coordinate in the rotation plane with the A-F matrix (and kx/ky, optionally
	// via the coefficient table) and looks up the resulting tile/bitmap.
	// With RPMD 2/3 it switches between parameter A and B per pixel.
	// ---------------------------------------------------------------------------
	_renderRBG(layer, ccMode)
	{
		const p = layer.rot;
		const p2 = layer.rot2 || null;
		const mode = layer.rotMode || 0;             // 0 = simple, 1 = by msb, 2 = by window
		const win = this._prepareWindows(layer.wctl);
		const winCC = this._prepareWindows(this._r(0xD6) >> 8);
		// RPMD 3: the rotation parameter window is the low byte of WCTLD.
		const winRP = (mode === 2) ? this._prepareWindows(this._r(0xD6) & 0xFF) : null;

		const pre = this._preRotation(p);
		const pre2 = p2 ? this._preRotation(p2) : null;
		const winFixed = this._noWindows(win) ? this._testBothWindows(win, 0, 0) : -1;
		const ccFixed = this._noWindows(winCC) ? (this._testBothWindows(winCC, 0, 0) !== 0) : null;
		if(winFixed === 0) return;

		for(let j = this._fieldStart; j < this.height; j += this._fieldStep)
		{
			const lin = this._lineRotation(p, j);
			const lin2 = p2 ? this._lineRotation(p2, j) : null;

			if(win.lineFlags) this._clipOfLine(win, j);
			if(winCC.lineFlags) this._clipOfLine(winCC, j);
			if(winRP && winRP.lineFlags) this._clipOfLine(winRP, j);

			for(let i = 0; i < this.width; i++)
			{
				if(winFixed < 0 && !this._testBothWindows(win, i, j)) continue;

				// Read each parameter's coefficients for this pixel (leaves the
				// msb in rot.msb, which is what decides the A/B switch with RPMD 2).
				this._coefOfPixel(p, i, j);
				if(p2) this._coefOfPixel(p2, i, j);

				// Pick the parameter. With RPMD 0/1 and RPMD 2 the msb of A's
				// coefficient decides; with RPMD 3, the rotation parameter window.
				const useB = (mode === 2)
					? (this._testBothWindows(winRP, i, j) === 0)
					: (p.msb !== 0);

				let cur, curPre, curLin, tbl;
				if(useB)
				{
					// Without parameter B (RPMD 0/1) the msb marks the pixel transparent.
					if(!p2 || (p2.coefenab && p2.msb)) continue;
					cur = p2; curPre = pre2; curLin = lin2; tbl = layer.planetbl2 || layer.planetbl;
				}
				else
				{
					if(p.msb) continue;
					cur = p; curPre = pre; curLin = lin; tbl = layer.planetbl;
				}

				let x = Math.floor(cur.kx * (curLin.Xsp + curPre.dX * i) + cur.Xp);
				let y = Math.floor(cur.ky * (curLin.Ysp + curPre.dY * i) + cur.Yp);

				// screen-over: 0/1 = repeat (mask), 2/3 = transparent outside.
				// //? screen-over 1 (fill with the OVPNRA/OVPNRB pattern) is
				// //  treated as 0, same as in Yabause.
				if(cur.screenover === 0 || cur.screenover === 1)
				{
					x &= layer.xmask; y &= layer.ymask;
				}
				else if(cur.screenover === 2)
				{
					if(x < 0 || x > layer.xmask || y < 0 || y > layer.ymask) continue;
				}
				else
				{
					if(x < 0 || x > 512 || y < 0 || y > 512) continue;
				}

				const color = layer.bitmap
					? this._fetchPixelCell(layer, layer.charBase, x, y, layer.paladdr, layer.cellw)
					: this._pixelTile(layer, x, y, tbl);
				if(!color) continue;

				const makeCC = (ccFixed !== null) ? ccFixed : (this._testBothWindows(winCC, i, j) !== 0);
				this._putPixelLayer(i, j, color, layer, ccMode, makeCC);
			}
		}
	}

	// CalculateRotationValues: precomputes Xp/Yp and the dX/dY increments of a
	// rotation parameter. Xp/Yp are stored in the parameter itself because the
	// coefficient in mode 3 rewrites them per pixel.
	_preRotation(p)
	{
		p.Xp = p.A * (p.Px - p.Cx) + p.B * (p.Py - p.Cy) + p.C * (p.Pz - p.Cz) + p.Cx + p.Mx;
		p.Yp = p.D * (p.Px - p.Cx) + p.E * (p.Py - p.Cy) + p.F * (p.Pz - p.Cz) + p.Cy + p.My;
		return {
			dX: p.A * p.deltaX + p.B * p.deltaY,
			dY: p.D * p.deltaX + p.E * p.deltaY
		};
	}

	// Per-line term (GenerateRotatedVar + the fixed part of X/YPos).
	_lineRotation(p, j)
	{
		const xmul = (p.Xst + p.deltaXst * j) - p.Px;
		const ymul = (p.Yst + p.deltaYst * j) - p.Py;
		return {
			Xsp: p.A * xmul + p.B * ymul + p.C * (p.Zst - p.Pz),
			Ysp: p.D * xmul + p.E * ymul + p.F * (p.Zst - p.Pz)
		};
	}

	// Reads the coefficient for pixel (i,j) and applies it to the parameter.
	// Without a coefficient table it does nothing (kx/ky stay as the rotation table
	// left them) and the msb is cleared.
	_coefOfPixel(p, i, j)
	{
		if(!p.coefenab) { p.msb = 0; return; }
		// Yabause accumulates the integer and fractional parts separately; in floating
		// point that is equivalent to truncating the total advance per line and per column.
		const idx = Math.floor(p.deltaKAst * j + p.deltaKAx * i);
		this._readCoef(p, idx);
	}

	// Reads a coefficient from the rotation table (Vdp2ReadCoefficient) and applies it
	// according to coefmode. Leaves the msb in rot.msb (1 = pixel outside the plane), which
	// is what the compositing of rotated layers further up consumes.
	// There was also a this._msbCoef with the same value "for compatibility" that NOBODY read
	// (orphans.mjs flagged it, 27-07-2026): it duplicated the state and could only drift apart.
	_readCoef(rot, idx)
	{
		let addr = rot.coeftbladdr + idx * rot.coefdatasize;
		let msb, val;

		if(rot.coefmode === 3)
		{
			// Mode 3: the coefficient offsets Xp instead of scaling kx/ky.
			if(rot.coefdatasize === 2)
			{
				addr &= 0x7FFFE;
				const i = this._vw(addr);
				msb = (i >> 15) & 0x1;
				let v = i & 0x7FFF; if(v & 0x4000) v -= 0x8000;
				val = v / 4;
			}
			else
			{
				addr &= 0x7FFFC;
				const i = this._vl(addr);
				msb = (i >>> 31) & 0x1;
				let v = i & 0x007FFFFF; if(v & 0x00800000) v -= 0x01000000;
				val = v / 256;
			}
			rot.msb = msb;
			rot.Xp = val;
			return val;
		}

		if(rot.coefdatasize === 2)
		{
			addr &= 0x7FFFE;
			const i = this._vw(addr);
			msb = (i >> 15) & 0x1;
			let v = i & 0x7FFF; if(v & 0x4000) v -= 0x8000;
			val = v / 1024;
		}
		else
		{
			addr &= 0x7FFFC;
			const i = this._vl(addr);
			msb = (i >>> 31) & 0x1;
			let v = i & 0x00FFFFFF; if(v & 0x00800000) v -= 0x01000000;
			val = v / 65536;
		}

		rot.msb = msb;
		switch(rot.coefmode)
		{
			case 0: rot.kx = rot.ky = val; break;   // coefficient for kx and ky
			case 1: rot.kx = val; break;            // coefficient for kx only
			case 2: rot.ky = val; break;            // coefficient for ky only
		}
		return val;
	}

	// ---------------------------------------------------------------------------
	// Looks up the pixel of a tile layer at coordinate (x,y) of the background
	// (already masked to the screen size). Implements Vdp2MapCalcXY +
	// Vdp2PatternAddr + Vdp2FetchPixel. 'planetbl' lets the caller pass parameter
	// B's table for rotated backgrounds with RPMD 2/3.
	// Returns [r,g,b] or null (transparent).
	// ---------------------------------------------------------------------------
	_pixelTile(layer, x, y, planetbl)
	{
		const tbl = planetbl || layer.planetbl;

		// --- Vdp2MapCalcXY: locate plane, page and cell ---
		const cellwh = 2 + layer.patternwh;                      // 3 (8x8) or 4 (16x16)
		const pagesize_bits = layer.pagewh_bits * 2;
		const planenum = ((y >> layer.planepixelheight_bits) * layer.mapwh) +
		                 (x >> layer.planepixelwidth_bits);
		const lx = x & layer.planepixelwidth_mask;
		const ly = y & layer.planepixelheight_mask;

		let addr = tbl[planenum] | 0;
		addr += ((((ly >> 9) << pagesize_bits) << layer.planew_bits) +
		         ((lx >> 9) << pagesize_bits) +
		         (((ly & 511) >> cellwh) << layer.pagewh_bits) +
		         ((lx & 511) >> cellwh)) << (layer.patterndatasize_bits + 1);

		// --- Vdp2PatternAddr: decode the pattern-name ---
		let charaddr, paladdr, flip;
		if(layer.patterndatasize === 2)
		{
			const t1 = this._vw(addr);
			const t2 = this._vw(addr + 2);
			charaddr = t2 & 0x7FFF;
			flip = (t1 >> 14) & 0x3;
			paladdr = (layer.colornumber === 0) ? ((t1 & 0x7F) << 4) : ((t1 & 0x70) << 4);
		}
		else
		{
			const t = this._vw(addr);
			const sup = layer.supplementdata;
			if(layer.colornumber === 0)
				paladdr = ((t & 0xF000) >> 8) | ((sup & 0xE0) << 3);
			else
				paladdr = (t & 0x7000) >> 4;

			if(layer.auxmode === 0)
			{
				flip = (t & 0xC00) >> 10;
				if(layer.patternwh === 1)
					charaddr = (t & 0x3FF) | ((sup & 0x1F) << 10);
				else
					charaddr = ((t & 0x3FF) << 2) | (sup & 0x3) | ((sup & 0x1C) << 10);
			}
			else
			{
				flip = 0;
				if(layer.patternwh === 1)
					charaddr = (t & 0xFFF) | ((sup & 0x1C) << 10);
				else
					charaddr = ((t & 0xFFF) << 2) | (sup & 0x3) | ((sup & 0x10) << 10);
			}
		}

		if(!layer.vramBig) charaddr &= 0x3FFF;
		charaddr *= 0x20;

		// --- pixel within the cell (with flip) ---
		let px, py;
		if(layer.patternwh === 1)
		{
			px = lx & 7; py = ly & 7;
			if(flip & 1) px = 7 - px;
			if(flip & 2) py = 7 - py;
		}
		else
		{
			// 16x16 cell = 4 consecutive 8x8 sub-cells; the flip moves between them.
			px = lx; py = ly & 15;
			if(flip)
			{
				if(flip & 2)
				{
					if(!(py & 8)) py = 8 - 1 - py + 16;
					else py = 16 - 1 - py;
				}
				else if(py & 8) py += 8;

				if(flip & 1)
				{
					if(!(px & 8)) py += 8;
					px &= 7; px = 7 - px;
				}
				else if(px & 8) { py += 8; px &= 7; }
				else px &= 7;
			}
			else
			{
				if(py & 8) py += 8;
				if(px & 8) py += 8;
				px &= 7;
			}
		}

		return this._fetchPixelCell(layer, charaddr, px, py, paladdr, 8);
	}

	// ---------------------------------------------------------------------------
	// Reads pixel (x,y) of a character cell or of a bitmap (Vdp2FetchPixel).
	// 'cellw' is the row width in pixels (8 for tiles, the bitmap width otherwise).
	// Returns [r,g,b] or null if transparent.
	// ---------------------------------------------------------------------------
	_fetchPixelCell(layer, charaddr, x, y, paladdr, cellw)
	{
		const vram = this.bus.vdp2Vram;
		switch(layer.colornumber)
		{
			case 0:                                             // 16 colors (4 bpp)
			{
				let dot = vram[(charaddr + (((y * cellw) + x) >> 1)) & 0x7FFFF];
				if(!(x & 1)) dot >>= 4;
				dot &= 0xF;
				if(dot === 0 && layer.transparency) return null;
				return this.colorFromCram(layer.offsetCram + (paladdr | dot), layer.colorMode);
			}
			case 1:                                             // 256 colors (8 bpp)
			{
				const dot = vram[(charaddr + (y * cellw) + x) & 0x7FFFF];
				if(dot === 0 && layer.transparency) return null;
				return this.colorFromCram(layer.offsetCram + (paladdr | dot), layer.colorMode);
			}
			case 2:                                             // 2048 colors (16 bpp palette)
			{
				const dot = this._vw(charaddr + ((y * cellw) + x) * 2);
				if(dot === 0 && layer.transparency) return null;
				return this.colorFromCram(layer.offsetCram + dot, layer.colorMode);
			}
			case 3:                                             // RGB555 (16 bpp direct)
			{
				const dot = this._vw(charaddr + ((y * cellw) + x) * 2);
				if(!(dot & 0x8000) && layer.transparency) return null;
				return this._rgb555(dot);
			}
			case 4:                                             // RGB888 (32 bpp direct)
			{
				const dot = this._vl(charaddr + ((y * cellw) + x) * 4);
				if(!(dot & 0x80000000) && layer.transparency) return null;
				// 0x00BBGGRR: red in the low bits, as in RGB555. Read the other way round,
				// the Sonic FMV showed Sonic red with a blue face.
				return [ dot & 0xFF, (dot >> 8) & 0xFF, (dot >> 16) & 0xFF ];
			}
			default:
				return null;
		}
	}

	// ---------------------------------------------------------------------------
	// Test scene: builds synthetic VRAM/CRAM with several layers (NBG0 256c,
	// NBG1 16c and an RBG0 rotated 30°) to verify tiles, palette, scroll,
	// priority and rotation without depending on a ROM. Returns the ready cfg.
	// ---------------------------------------------------------------------------
	sceneOfTest()
	{
		const vram = this.bus.vdp2Vram;
		const cram = this.bus.cram;
		vram.fill(0);

		// Palette (CRAM RGB555). Bank 0 (indices 0-15) for NBG1's 16 colors and as
		// the first indices of NBG0; RBG0 uses the same bank.
		const putColor = (i, r, g, b) => {
			const w = ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3);
			cram[i * 2] = (w >> 8) & 0xFF; cram[i * 2 + 1] = w & 0xFF;
		};
		putColor(0, 0, 0, 0);
		putColor(1, 92, 140, 255);    // accent blue
		putColor(2, 87, 194, 107);    // green
		putColor(3, 226, 179, 64);    // yellow
		putColor(4, 224, 85, 97);     // red
		putColor(5, 230, 232, 236);   // white

		// --- NBG0: 256-color tiles (8x8), 2-word pattern-name ---
		const nbg0Char = 0x00000;       // character data
		const nbg0Name = 0x40000;       // pattern-name table
		// Cell A: fill color 1. Cell B: border color 3, center color 2.
		// Each 256c cell takes 64 bytes (2 units of 0x20 -> even charNo).
		for(let p = 0; p < 64; p++) vram[nbg0Char + 0x40 + p] = 1;            // charNo 2 -> cell A
		for(let ty = 0; ty < 8; ty++) for(let tx = 0; tx < 8; tx++)
		{
			const border = (tx === 0 || ty === 0 || tx === 7 || ty === 7);
			vram[nbg0Char + 0x80 + ty * 8 + tx] = border ? 3 : 2;             // charNo 4 -> cell B
		}
		// Pattern-name (2 BE words): word0 = palette/flip, word1 = charNo.
		const write2w = (base, cellX, cellY, charNo, palette) => {
			const a = base + (cellY * 64 + cellX) * 4;
			const w0 = (palette & 0x70) << 4;               // 256c: (t1&0x70)<<4
			vram[a] = (w0 >> 8) & 0xFF; vram[a + 1] = w0 & 0xFF;
			vram[a + 2] = (charNo >> 8) & 0xFF; vram[a + 3] = charNo & 0xFF;
		};
		for(let cy = 0; cy < 64; cy++) for(let cx = 0; cx < 64; cx++)
			write2w(nbg0Name, cx, cy, ((cx + cy) & 1) ? 2 : 4, 0);        // A/B checkerboard

		const layerN0 = {
			type: "nbg", order: 3, priority: 5, bitmap: false,
			colornumber: 1, offsetCram: 0, transparency: true,
			colorMode: 0, vramBig: false, mapwh: 2,
			patterndatasize: 2, patterndatasize_bits: 1,
			patternwh: 1, patternwh_bits: 0, pagewh_bits: 6,
			supplementdata: 0, auxmode: 0,
			planew: 1, planeh: 1, planew_bits: 0, planeh_bits: 0,
			scrollX: 0, scrollY: 0
		};
		this._prepareLayerTile(layerN0);
		// 4 planes pointing to the same page (nbg0Name). With datasize=2,wh=1 the
		// plane step is 0x4000; nbg0Name/0x4000 = 0x10.
		layerN0.planetbl = this._planesTable(layerN0, 0, [ 0x1010, 0x1010 ]);

		// --- NBG1: 16-color tiles, 1 word, diagonal stripe ---
		const nbg1Char = 0x10000;
		const nbg1Name = 0x50000;
		// 16c cell (32 bytes): diagonal gradient using colors 1..5.
		for(let ty = 0; ty < 8; ty++) for(let tx = 0; tx < 8; tx++)
		{
			const c = 1 + ((tx + ty) % 5);
			const o = nbg1Char + 0x20 + (ty * 8 + tx >> 1);     // charNo 1 -> +0x20
			if((tx & 1) === 0) vram[o] = (vram[o] & 0x0F) | (c << 4);
			else vram[o] = (vram[o] & 0xF0) | c;
		}
		// 1-word pattern-name: low charNo, palette in supplement. We use charNo=1.
		for(let cy = 0; cy < 64; cy++) for(let cx = 0; cx < 64; cx++)
		{
			const a = nbg1Name + (cy * 64 + cx) * 2;
			const w = 0x0001;                                    // charNo 1, no flip
			vram[a] = (w >> 8) & 0xFF; vram[a + 1] = w & 0xFF;
		}
		const layerN1 = {
			type: "nbg", order: 2, priority: 3, bitmap: false,
			colornumber: 0, offsetCram: 0, transparency: true,
			colorMode: 0, vramBig: false, mapwh: 2,
			patterndatasize: 1, patterndatasize_bits: 0,
			patternwh: 1, patternwh_bits: 0, pagewh_bits: 6,
			supplementdata: (nbg1Char >> 15) & 0x1F,            // char base (bits 10-14) via supplement
			auxmode: 0,
			planew: 1, planeh: 1, planew_bits: 0, planeh_bits: 0,
			scrollX: 0, scrollY: 0
		};
		this._prepareLayerTile(layerN1);
		// datasize=1,wh=1 -> plane step 0x2000; nbg1Name/0x2000 = 0x28.
		layerN1.planetbl = this._planesTable(layerN1, 0, [ 0x2828, 0x2828 ]);

		// --- RBG0: tile plane rotated 30° (affine matrix, no coefficients) ---
		const rbg0Char = 0x20000;
		const rbg0Name = 0x60000;
		// 16c cell, checkered in colors 4/5.
		for(let ty = 0; ty < 8; ty++) for(let tx = 0; tx < 8; tx++)
		{
			const c = ((tx ^ ty) & 1) ? 4 : 5;
			const o = rbg0Char + 0x20 + (ty * 8 + tx >> 1);
			if((tx & 1) === 0) vram[o] = (vram[o] & 0x0F) | (c << 4);
			else vram[o] = (vram[o] & 0xF0) | c;
		}
		for(let cy = 0; cy < 128; cy++) for(let cx = 0; cx < 128; cx++)
		{
			const a = rbg0Name + (cy * 64 + cx) * 2;            // mapwh=4 but we write page 0
			const w = 0x0001;
			vram[a] = (w >> 8) & 0xFF; vram[a + 1] = w & 0xFF;
		}
		const ang = Math.PI / 6;                                // 30°
		const layerR0 = {
			type: "rbg", order: 4, priority: 2, bitmap: false, rotMode: 0,
			colornumber: 0, offsetCram: 0, transparency: true,
			colorMode: 0, vramBig: false, mapwh: 4,
			patterndatasize: 1, patterndatasize_bits: 0,
			patternwh: 1, patternwh_bits: 0, pagewh_bits: 6,
			supplementdata: (rbg0Char >> 15) & 0x1F, auxmode: 0,
			planew: 1, planeh: 1, planew_bits: 0, planeh_bits: 0,
			rot: {
				A: Math.cos(ang), B: -Math.sin(ang), C: 0,
				D: Math.sin(ang), E: Math.cos(ang), F: 0,
				Xst: 0, Yst: 0, Zst: 0,
				deltaXst: 0, deltaYst: 1, deltaX: 1, deltaY: 0,
				Px: this.width / 2, Py: this.height / 2, Pz: 0,
				Cx: this.width / 2, Cy: this.height / 2, Cz: 0,
				Mx: 0, My: 0, kx: 1, ky: 1,
				coefenab: false, screenover: 0, msb: 0
			}
		};
		this._prepareLayerTile(layerR0);
		// datasize=1,wh=1 -> step 0x2000; rbg0Name/0x2000 = 0x30. 16 planes -> page 0.
		layerR0.planetbl = this._planesTable(layerR0, 0, [ 0x3030, 0x3030, 0x3030, 0x3030, 0x3030, 0x3030, 0x3030, 0x3030 ]);

		return {
			backdrop: [22, 24, 29],
			backdropLines: null,
			ccMode: 0,
			layers: [ layerN0, layerN1, layerR0 ]
		};
	}
}

if(typeof module !== "undefined") module.exports = { VDP2 };
