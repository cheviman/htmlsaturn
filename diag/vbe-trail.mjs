// THE SF ALPHA SPRITE TRAIL, MEASURED AND PHOTOGRAPHED (27-07-2026).
//
// Sebas (27-07-2026, translated): "the previous sprite is not cleared in the animation". In the game capture you can see
// the portraits of the versus screen and the "FIGHT!" stuck on top of the fight.
//
// CAUSE: VBE (TVMR bit 3) is a TRIGGER and we were reading it as a LEVEL. SF Alpha
// does, every frame and in this order:
//    TVMR=0x8 (VBE=1) -> 6 reads of EDSR (the wait) -> TVMR=0x0 -> FBCR=0x3 -> PTMR=0x1
// VBE lasts as long as the wait does and drops BEFORE FBCR. vdp1.js._buildEraseVBlank()
// copies Yabause's Vdp2VBlankOUT and samples the TVMR level at the close of the frame: by
// then the pulse had already passed, the erase was never requested and each frame was drawn on top
// of the previous one. Measured: 20 plots, 20 swaps and 0 ERASES every 40 frames.
//
// The fix is in bus.js, in the TVMR write hook (offset 0x00), next to the ones
// for FBCR and PTMR that already existed for the same reason.
//
// CONTROL (mandatory, CLAUDE.md): the "sin" (without) mode neutralizes the hook from outside
// by restoring the flag after each TVMR write, and it has to give 0 erases. If
// "sin" does not give 0, the probe is not measuring what it claims to measure.
//
// Usage: node diag/vbe-trail.mjs [with|without]     -> leaves diag/vbe-trail-<mode>.png
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { deflateSync } from "zlib";

function crc32(b){ let c = ~0 >>> 0; for(let i = 0; i < b.length; i++){ c ^= b[i]; for(let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(t, d){ const l = Buffer.alloc(4); l.writeUInt32BE(d.length >>> 0, 0); const cd = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(cd), 0); return Buffer.concat([l, cd, cr]); }
function png(w, h, rgba){ const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; const raw = Buffer.alloc((w * 4 + 1) * h); for(let y = 0; y < h; y++){ raw[y * (w * 4 + 1)] = 0; for(let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = rgba[y * w * 4 + x]; } return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]); }

const MODE = (process.argv[2] || "with").toLowerCase();
const mod = await import("../headless.mjs?estab=" + MODE);
const { bus, vdp1, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("sfa"));

if(MODE === "without")
{
	// The OLD behavior: the TVMR hook arms nothing. The flag is restored just as
	// it was before the write, which is exactly what the hook would have changed.
	const orig = bus.writeWord.bind(bus);
	bus.writeWord = (a, v) => {
		if(((a >>> 0) & 0x07FFFFFF) !== 0x05D00000) return orig(a, v);
		const before = bus.vdp1EraseManual;
		const r = orig(a, v);
		bus.vdp1EraseManual = before;
		return r;
	};
}

// Navigation up to the fight: the BIOS, the menu and the character select. Calibrated
// alternating START/A/C — without this the probe measures the intro and sees nothing.
const START = 0x08, A = 0x04, C = 0x02;
let f = 0;
for(; f < 900; f++) runFrame();
for(let k = 0; k < 120; k++)
{
	const m = (k % 3 === 0) ? START : (k % 3 === 1 ? A : C);
	bus.pad1a = 0xFF & ~m; for(let i = 0; i < 5; i++, f++) runFrame();
	bus.pad1a = 0xFF;      for(let i = 0; i < 15; i++, f++) runFrame();
}
for(let k = 0; k < 120; k++)
{
	const m = (k % 2 === 0) ? A : START;
	bus.pad1a = 0xFF & ~m; for(let i = 0; i < 5; i++, f++) runFrame();
	bus.pad1a = 0xFF;      for(let i = 0; i < 15; i++, f++) runFrame();
}
bus.pad1a = 0xFF;

// Nonzero pixels in the TOP HALF of the display bank: that is where the
// garbage of the previous screen piles up (below are the characters, which get redrawn anyway).
const pxUp = (b) => { let n = 0; for(let y = 0; y < 128; y++) for(let x = 0; x < 512; x += 4){ const o = (y * 512 + x) * 2; if(b[o] || b[o + 1]) n++; } return n; };

let erase = 0, plots = 0, swaps = 0;
for(let i = 0; i < 40; i++, f++)
{
	runFrame();
	if(vdp1.lastErase) erase++;
	if(vdp1.lastPlot) plots++;
	if(vdp1.lastSwap) swaps++;
}

const cfg = vdp2.configFromRegisters();
vdp2.render(cfg);
const output = new Uint8Array(vdp2.fb);
const spr = vdp1.compose(vdp2.priorities, vdp2.fb, vdp2.shadowOk);
for(let i = 0; i < output.length; i += 4)
	if(spr[i + 3] !== 0){ output[i] = spr[i]; output[i + 1] = spr[i + 1]; output[i + 2] = spr[i + 2]; }
writeFileSync("diag/vbe-trail-" + MODE + ".png", png(vdp2.width, vdp2.height, output));

console.log("SF ALPHA in the fight, " + (MODE === "with" ? "WITH" : "WITHOUT") + " the VBE hook:");
console.log("   " + plots + " plots   " + erase + " erased   " + swaps + " swaps   (in 40 frames)");
console.log("   garbage at the top of the bank: " + pxUp(vdp1._fbDisplay) + " pixels");
console.log("   photo: diag/vbe-trail-" + MODE + ".png");
console.log("");
console.log(MODE === "without"
	? (erase === 0
		? "   control OK: without the hook it NEVER erases, which is the original bug."
		: "   CONTROL FAILED: the 'without' mode erased " + erase + " times. The probe does not measure what it claims.")
	: (erase > 0
		? "   with the hook it erases once per plot, which is what the game asks for."
		: "   the hook did not fire: check the TVMR hook in bus.js."));
