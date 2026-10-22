// Analysis of Sega Rally's black sky: boots, lets attract mode go into the gameplay
// demo by itself (RBG0 = the rotated 3D terrain turns on in BGON), and ISOLATES each
// VDP2 layer, counting how many pixels it paints at the top (upper half = sky) vs the bottom.
// The layer that should paint the sky and paints 0 at the top -or the one that DOES paint it but with
// priority 0, and so render()'s filter discards it- is the culprit.
// Reuses the harness boot (headless.mjs) by importing it, without duplicating it.
import { readFileSync } from "fs";
import { basename } from "path";
import { bus, vdp2, vdp1, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "../headless.mjs";

const biosPath = resolveBios("us");
applyBios(basename(biosPath), new Uint8Array(readFileSync(biosPath)));
loadDiscFromCue(resolveGame("rally"));

// Instrument the write to CRAM: which banks of 256 does the game write? If it writes
// bank 5 (which RBG0 reads) and it shows up empty, the write is lost -> loading bug.
const banksWritten = new Set();
const addrsCram = new Set();
const ramctlWritten = [];
const patternsPlane = new Set();
let offMin = 0x7FFFFFFF, offMax = 0;
// Capture the pattern-names the game WRITES into the RBG0 plane (VRAM 0x40000/0x42000).
// If it writes 0x2000 (bank 2) and VRAM ends up with 0x5000, the bug is the write (not the read).
for(const mm of ["writeWord", "writeLong"])
{
	const orig = bus[mm].bind(bus);
	bus[mm] = (a, v) => {
		const phys = (a >>> 0) & 0x07FFFFFF;
		if(phys >= 0x05E40000 && phys < 0x05E42200)
		{
			if(mm === "writeWord") patternsPlane.add((v >>> 0) & 0xFFFF);
			else { patternsPlane.add((v >>> 16) & 0xFFFF); patternsPlane.add((v >>> 0) & 0xFFFF); }
		}
		return orig(a, v);
	};
}
// Capture the writes to RAMCTL (VDP2 reg 0x0E -> physical 0x05F8000E) to see the real CRMD.
for(const m of ["writeWord", "writeLong"])
{
	const orig = bus[m].bind(bus);
	bus[m] = (a, v) => { const phys = (a >>> 0) & 0x07FFFFFF; if(phys === 0x05F8000E || phys === 0x05F8000C) ramctlWritten.push((v >>> 0) & 0xFFFF); return orig(a, v); };
}
for(const m of ["writeByte", "writeWord", "writeLong"])
{
	const orig = bus[m].bind(bus);
	bus[m] = (a, v) => {
		const phys = (a >>> 0) & 0x07FFFFFF;   // PHYSICAL address (without the cache/alias bits)
		if(phys >= 0x05F00000 && phys < 0x05F80000)
		{
			const off = phys - 0x05F00000;                    // REAL offset within the CRAM space
			if(off < offMin) offMin = off;
			if(off > offMax) offMax = off;
			addrsCram.add((a >>> 0) & 0xFF000000);
			banksWritten.add(((off & 0xFFF) >> 9));        // bank AFTER the wrap & 0xFFF (what the emu does)
		}
		return orig(a, v);
	};
}

// Run until STABLE gameplay: RBG0 on (BGON bit4) + DISP, HELD for 25
// consecutive frames (not a transient flash from loading). Attract mode cycles title<->demo.
let f = 0, arrived = false, sustained = 0;
for(; f < 3500; f++)
{
	runFrame();
	if((vdp2._r(0x20) & 0x10) && (vdp2._r(0x00) & 0x8000)) sustained++;
	else sustained = 0;
	if(sustained >= 25){ arrived = true; break; }
}

console.log("\n=== CRAM banks WRITTEN by the game (over " + f + " frames) ===");
console.log("  banks with some write:", [...banksWritten].sort((a, b) => a - b).join(", "),
	"  <- RBG0 reads from bank 5; is it on the list?");
console.log("  alias prefixes used to write CRAM:", [...addrsCram].map(x => "0x" + x.toString(16)).join(", "));
console.log("  REAL offset written: min=0x" + offMin.toString(16) + " max=0x" + offMax.toString(16) +
	"  (the emu's CRAM is 4KB=0xFFF; if max>0xFFF, the & 0xFFF WRAPS and places it wrong)");
const rc = [...new Set(ramctlWritten)];
console.log("  RAMCTL written by the game:", rc.map(x => "0x" + x.toString(16) + "(CRMD=" + ((x >> 12) & 3) + ")").join(", "),
	"| RAMCTL now: 0x" + vdp2._r(0x0e).toString(16) + "(CRMD=" + ((vdp2._r(0x0e) >> 12) & 3) + ")");
const pp = [...patternsPlane].sort((a, b) => a - b);
console.log("  pattern-names WRITTEN to the RBG0 plane:", pp.slice(0, 12).map(x => "0x" + x.toString(16)).join(", "),
	pp.length > 12 ? "... (" + pp.length + " distinct)" : "",
	"| in VRAM NOW (0x40000):", "0x" + (vdp2._vw(0x40000) >>> 0).toString(16));

const cfg = vdp2.configFromRegisters();
console.log("frame:", f, "| reached gameplay (RBG0):", arrived);
console.log("TVMD:", "0x" + vdp2._r(0x00).toString(16), "BGON:", "0x" + vdp2._r(0x20).toString(16),
	"RAMCTL:", "0x" + vdp2._r(0x0E).toString(16));
console.log("backdrop:", JSON.stringify(cfg && cfg.backdrop));
console.log("enabled layers:");
for(const c of ((cfg && cfg.layers) || []))
	console.log("  ", c.name, "| prio:", c.priority, "| colornumber:", c.colornumber, "| bitmap:", !!c.bitmap, "| transp:", c.transparency);

const w = vdp2.width, h = vdp2.height;
const col = (y) => { const o = (y * h > 0 ? (y * w + (w >> 1)) * 4 : 0); return vdp2.fb[o] + "," + vdp2.fb[o + 1] + "," + vdp2.fb[o + 2]; };
// Framebuffer variance: high = textured image (real race), low = uniform gray.
const variance = () => {
	let s = 0, s2 = 0, n = 0;
	for(let i = 0; i < vdp2.fb.length; i += 16){ const v = vdp2.fb[i]; s += v; s2 += v * v; n++; }
	return Math.round(s2 / n - (s / n) * (s / n));
};

// Stabilize on black gameplay (BGON=0x14, variance 0).
vdp2.showAll();
for(let k = 0; k < 120; k++) runFrame();
const cfg2 = vdp2.configFromRegisters();
vdp2.render(cfg2);
console.log("\n=== STABLE GAMEPLAY: normal color =", col(112), "| variance =", variance(), "===");
console.log("layers:", (cfg2.layers || []).map(c => c.name + "(prio " + c.priority + ")").join(", "));
// Real draw order (as render() builds it) and which priority ended up in 2 pixels.
const sorted = cfg2.layers.filter(c => c && c.priority > 0).slice()
	.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
console.log("draw order (back->front):", sorted.map(c => c.name + "/pri" + c.priority + "/ord" + c.order).join("  "));
console.log("backdrop gameplay:", JSON.stringify(cfg2.backdrop),
	"| winning priority at (0,0):", vdp2.priorities[0], "at (176,112):", vdp2.priorities[112 * w + 176]);

// Config of each enabled layer + what it paints in isolation.
for(const layer of (cfg2.layers || []))
{
	console.log("\n--- " + layer.name + " ---");
	const fields = ["priority", "colornumber", "bitmap", "transparency", "charBase", "planetbl",
		"scrollX", "scrollY", "mapwh", "patternwh", "offsetCram", "rotMode", "coefEnable", "coefModo"];
	const dump = {};
	for(const c of fields) if(layer[c] !== undefined) dump[c] = (typeof layer[c] === "number" && layer[c] > 9) ? "0x" + layer[c].toString(16) : layer[c];
	console.log("  config:", JSON.stringify(dump));
	vdp2.onlyLayer(layer.name);
	vdp2.render(vdp2.configFromRegisters());
	let noBlack = 0, samplesNoBlack = [];
	for(let y = 0; y < h; y++) for(let x = 0; x < w; x++)
	{
		const o = (y * w + x) * 4;
		if(vdp2.fb[o] || vdp2.fb[o + 1] || vdp2.fb[o + 2])
		{
			noBlack++;
			if(samplesNoBlack.length < 4) samplesNoBlack.push("(" + x + "," + y + ")=[" + vdp2.fb[o] + "," + vdp2.fb[o + 1] + "," + vdp2.fb[o + 2] + "]");
		}
	}
	console.log("  pixels != black:", noBlack, "of", w * h, samplesNoBlack.length ? "| e.g.: " + samplesNoBlack.join(" ") : "| ALL BLACK");

	// For RBG0: dump the rotation table and capture which (x,y) of the plane it maps to
	// (via an instrumented _pixelTile), to see whether the mapping collapses or reads black tiles.
	if(layer.name === "rbg0" && layer.rot)
	{
		const r = layer.rot;
		console.log("  rot:", JSON.stringify({ A: r.A, B: r.B, C: r.C, D: r.D, E: r.E, F: r.F,
			kx: r.kx, ky: r.ky, Xst: r.Xst, Yst: r.Yst, coefenab: r.coefenab, screenover: r.screenover,
			xmask: layer.xmask, ymask: layer.ymask }));
		console.log("  offsets:", JSON.stringify({ Px: r.Px, Py: r.Py, Pz: r.Pz, Cx: r.Cx, Cy: r.Cy, Cz: r.Cz,
			Mx: r.Mx, My: r.My, deltaXst: r.deltaXst, deltaYst: r.deltaYst, deltaX: r.deltaX, deltaY: r.deltaY }),
			"| charBase:", "0x" + (layer.charBase || 0).toString(16), "| patterndatasize:", layer.patterndatasize);
		const orig = vdp2._pixelTile.bind(vdp2);
		const samples = [];
		vdp2._pixelTile = (c, x, y, t) => {
			const col = orig(c, x, y, t);
			if(samples.length < 8) samples.push("(" + x + "," + y + ")->" + (col ? "[" + col.join(",") + "]" : "transp"));
			return col;
		};
		vdp2.onlyLayer("rbg0");
		vdp2.render(vdp2.configFromRegisters());
		vdp2._pixelTile = orig;
		console.log("  mapping (x_plane,y_plane)->color, first 8 px:", samples.join("  "));

		// Trace the final link: for each RBG0 pixel, which charaddr the
		// pattern-name points to, which dot it reads and which color it gives. Locates where the chain breaks.
		const cellw = 8;
		const origFetch = vdp2._fetchPixelCell.bind(vdp2);
		const traces = [];
		vdp2._fetchPixelCell = (cp, charaddr, xx, yy, pal, cw) => {
			const col = origFetch(cp, charaddr, xx, yy, pal, cw);
			if(traces.length < 6)
			{
				const vr = bus.vdp2Vram;
				const dot = vr[(charaddr + (yy * cw) + xx) & 0x7FFFF];   // 256 colors: 1 byte/dot
				traces.push("charaddr=0x" + charaddr.toString(16) + " dot=" + dot + " pal=0x" + pal.toString(16) +
					" idx=" + (cp.offsetCram + pal + dot) + " -> " + (col ? "[" + col.join(",") + "]" : "transp"));
			}
			return col;
		};
		vdp2.onlyLayer("rbg0");
		vdp2.render(vdp2.configFromRegisters());
		vdp2._fetchPixelCell = origFetch;
		console.log("  chain pattern-name->charaddr->dot->color (first 6 px):");
		for(const t of traces) console.log("    " + t);
	}
}
vdp2.showAll();

// RBG0's mode and where the data is in VDP2 VRAM.
console.log("\n=== RBG0 registers and VRAM ===");
console.log("  CHCTLB(0x2A):", "0x" + vdp2._r(0x2a).toString(16), "(R0BMEN bit4 =", (vdp2._r(0x2a) & 0x10) ? "BITMAP" : "tiles", ", R0CHCN bits12-14)");
console.log("  MPABRA(0x50):", "0x" + vdp2._r(0x50).toString(16), "RPTAU/RPTAL(0xBC/BE):", "0x" + vdp2._r(0xbc).toString(16), "0x" + vdp2._r(0xbe).toString(16));
console.log("  RAMCTL VRAM parts: CYCA0(0x02):", "0x" + vdp2._r(0x02).toString(16));
const vram = bus.vdp2Vram;
console.log("  VDP2 VRAM (64KB blocks with non-zero data):");
for(let b = 0; b < 8; b++)
{
	let nz = 0;
	for(let i = b * 0x10000; i < (b + 1) * 0x10000; i += 4) if(vram[i] || vram[i + 1] || vram[i + 2] || vram[i + 3]) nz++;
	console.log("    0x" + (b * 0x10000).toString(16).padStart(5, "0") + ": " + nz + "/16384 non-zero words");
}

// The CRAM: whether RBG0 paints black because of the PALETTE (black colors) or because of the MAPPING (it reads the
// wrong index). Mode 1 = RGB555, 1 word per index. I dump 24 indices.
console.log("\n=== CRAM (RGB555, first 24 indices) ===");
const cram = bus.cram;
let row = "";
for(let i = 0; i < 24; i++)
{
	const wrd = (cram[i * 2] << 8) | cram[i * 2 + 1];
	const r = (wrd & 0x1F) * 8, g = ((wrd >> 5) & 0x1F) * 8, b = ((wrd >> 10) & 0x1F) * 8;
	row += "[" + i + "]=" + r + "," + g + "," + b + "  ";
	if(i % 4 === 3){ console.log("  " + row); row = ""; }
}
// How many CRAM indices have some color (not all 0)?
let withColor = 0;
for(let i = 0; i < 2048; i++){ const wrd = (cram[i * 2] << 8) | cram[i * 2 + 1]; if(wrd & 0x7FFF) withColor++; }
console.log("  CRAM indices with color (out of 2048):", withColor);

// RAW rotation table in VRAM vs what _readTableRotation returns (identity).
// If VRAM has perspective and the code reads identity, the bug is in the read.
const respAddr = ((vdp2._rl(0xBC) << 1) & 0x000FFF7C) >>> 0;
console.log("\n=== rotation table in VRAM (0x" + respAddr.toString(16) + ") raw ===");
const vl = (a) => (((vram[a] << 24) | (vram[a + 1] << 16) | (vram[a + 2] << 8) | vram[a + 3]) >>> 0);
const names = ["Xst", "Yst", "Zst", "dXst", "dYst", "dX", "dY", "A", "B", "C", "D", "E", "F"];
for(let k = 0; k < 13; k++) console.log("  " + names[k].padEnd(5) + "0x" + vl(respAddr + k * 4).toString(16).padStart(8, "0"));
// Colors with color per BANK of 256 (RBG0 read bank 5 = idx 1280-1535, black).
const rgb = (i) => { const wrd = (cram[i * 2] << 8) | cram[i * 2 + 1]; return (wrd & 0x1F) * 8 + "," + ((wrd >> 5) & 0x1F) * 8 + "," + ((wrd >> 10) & 0x1F) * 8; };
console.log("  colors per bank of 256:");
for(let bank = 0; bank < 8; bank++)
{
	let cc = 0;
	for(let i = bank * 256; i < (bank + 1) * 256; i++){ const wrd = (cram[i * 2] << 8) | cram[i * 2 + 1]; if(wrd & 0x7FFF) cc++; }
	console.log("    bank " + bank + " (idx " + (bank * 256) + "..): " + cc + "/256 with color  | idx" + (bank * 256 + 133) + "=" + rgb(bank * 256 + 133));
}

// Is it a real race or an empty attract-mode frame? If the VDP1 has the car/terrain
// drawn, it is a race -> the black VDP2 is the bug. If the VDP1 is empty too,
// I captured a transition screen and the analysis is of the wrong frame.
// RAW pattern-names of the RBG0 plane: do they vary (plane with data, bug in the calculation
// of the addr) or are they constant with bank 5 (data/planetbl bug)?
{
	const rbg = (vdp2.configFromRegisters().layers || []).find(c => c.name === "rbg0");
	console.log("\n=== raw pattern-names of the RBG0 plane ===");
	for(const base of [rbg.planetbl[0], rbg.planetbl[1]])
	{
		let row = "0x" + base.toString(16) + ": ";
		for(let off = 0; off < 24; off += 2) row += "0x" + vdp2._vw(base + off).toString(16).padStart(4, "0") + " ";
		console.log("  " + row);
	}
	// The char number that comes out of the pattern-name at (625,184) vs (0,0): does the addr collapse?
	console.log("  (planetbl has " + rbg.planetbl.length + " entries, mapwh=" + rbg.mapwh +
		", patternwh=" + rbg.patternwh + ", patterndatasize=" + rbg.patterndatasize +
		", supplementdata=0x" + (rbg.supplementdata || 0).toString(16) + ")");
}

// Experiment: force RBG0's color BANK to 0-3 (the ones that have color) and see whether
// the sky texture appears. If a bank gives blue/light blue, the bug is the decoding
// of the bank (pattern-name 0x5000 -> bank 5 instead of the correct one).
console.log("\n=== experiment: force RBG0's color bank ===");
for(const bank of [0, 1, 2, 3, 5])
{
	const origF = vdp2._fetchPixelCell.bind(vdp2);
	vdp2._fetchPixelCell = (cp, ca, xx, yy, pal, cw) => origF(cp, ca, xx, yy, bank << 8, cw);
	vdp2.layersOff = new Set(["nbg0", "nbg1", "nbg2", "nbg3", "rbg1"]);
	vdp2.ignorePriority = true;
	vdp2.render(vdp2.configFromRegisters());
	vdp2._fetchPixelCell = origF;
	let noBlack = 0, blue = 0;
	for(let i = 0; i < vdp2.fb.length; i += 4)
	{
		if(vdp2.fb[i] || vdp2.fb[i + 1] || vdp2.fb[i + 2]) noBlack++;
		if(vdp2.fb[i + 2] > vdp2.fb[i] + 20) blue++;
	}
	console.log("  bank " + bank + ": !=black=" + noBlack + " bluish=" + blue + " center=[" + col(112) + "] y40=[" + col(40) + "]");
	vdp2.showAll();
}

// Experiment: vary the map offset (Mx/My) of RBG0 and see whether it starts reading
// tiles with color. If sky blue appears with another offset, the bug is the offset.
console.log("\n=== experiment: vary Mx/My of RBG0's mapping ===");
for(const [mx, my] of [[0, 0], [625, 184], [625, 0], [0, 184], [-625, -184]])
{
	const cfgE = vdp2.configFromRegisters();
	const rbg = (cfgE.layers || []).find(c => c.name === "rbg0");
	if(rbg && rbg.rot){ rbg.rot.Mx = mx; rbg.rot.My = my; }
	vdp2.layersOff = new Set(["nbg0", "nbg1", "nbg2", "nbg3", "rbg1"]);
	vdp2.ignorePriority = true;
	vdp2.render(cfgE);
	let noBlack = 0, blue = 0;
	for(let i = 0; i < vdp2.fb.length; i += 4)
	{
		if(vdp2.fb[i] || vdp2.fb[i + 1] || vdp2.fb[i + 2]) noBlack++;
		if(vdp2.fb[i + 2] > vdp2.fb[i] + 30) blue++;   // b >> r = bluish (sky)
	}
	console.log("  Mx=" + mx + " My=" + my + ": !=black=" + noBlack + " bluish=" + blue + " center=[" + col(112) + "]");
	vdp2.showAll();
}

vdp1.plot();
const fbv = vdp1._fbDisplay;
let nzVdp1 = 0;
for(let i = 0; i < fbv.length; i += 2) if(fbv[i] || fbv[i + 1]) nzVdp1++;
console.log("\n=== VDP1 (car/terrain) ===");
console.log("  _fbDisplay non-zero pixels:", nzVdp1, "of", (fbv.length / 2),
	nzVdp1 > 1000 ? "-> REAL RACE (the black VDP2 IS the sky bug)" : "-> VDP1 empty: I captured a TRANSITION, not a race");

// --- Which banks RBG0 READS vs which ones the game WRITES (looks for the wrong pattern-name) ---
vdp2._dbgRBG = { banks: new Array(8).fill(0), samples: [] };
vdp2.layersOff = new Set(["nbg0", "nbg1", "nbg2", "nbg3", "rbg1"]);
vdp2.ignorePriority = true;
vdp2.render(vdp2.configFromRegisters());
vdp2.showAll();
const dbg = vdp2._dbgRBG; delete vdp2._dbgRBG;
const banksPlane = new Array(8).fill(0);
for(const p of patternsPlane) banksPlane[(p >> 12) & 7]++;
console.log("\n=== BANKS: what RBG0 READS vs what the game WRITES to the plane ===");
console.log("  RBG0 READS   (pattern>>12 & 7):", dbg.banks.join(", "));
console.log("  game WRITES (of " + patternsPlane.size + " patterns):", banksPlane.join(", "));
console.log("  samples (addr, pattern) that RBG0 reads:");
for(const [a, t] of dbg.samples) console.log("     addr=0x" + a.toString(16) + " pat=0x" + t.toString(16) + " bank=" + ((t >> 12) & 7) + " char=0x" + (t & 0x3ff).toString(16));

console.log("\n=== raw CRAOF (the piece that maps the bank to CRAM) ===");
console.log("  CRAOFA (0xE4) = 0x" + vdp2._r(0xE4).toString(16) + "  CRAOFB (0xE6) = 0x" + vdp2._r(0xE6).toString(16));
console.log("  R0CAOS (RBG0 = 0xE6 bits 2-0) =", vdp2._r(0xE6) & 0x7, " -> shifts the CRAM idx by", ((vdp2._r(0xE6) & 0x7) << 8), "colors");
console.log("  with bank 5 (pat 0x5000): idx = R0CAOS*256 + 5*256 + dot =", ((vdp2._r(0xE6) & 0x7) << 8) + 1280, "+ dot");
