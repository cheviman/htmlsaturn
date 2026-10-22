// HOW MANY LINES THE VDP2 REALLY RASTERIZES PER FRAME.
// The question: Daytona/Touring are listed as 448 lines tall, but with LSMD=3 the
// hardware shows ONE FIELD (224) per frame. If the render does all 448, there is a 2x.
// CONTROL: a progressive game (rally, 224 lines) has to give step=1 and height=lines.
import { readFileSync } from "fs";
import { basename } from "path";
const GAME = process.argv[2] || "daycce";
const WARM = parseInt(process.argv[3] || "900", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };
const mod = await import("../headless.mjs?lin=" + GAME);
const { vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios(BIOS_PER_GAME[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));
for(let f = 0; f < WARM; f++) runFrame();
let n = 0, stepSum = 0, linesSum = 0, height = 0, width = 0, tvmd = 0;
for(let f = 0; f < 120 && !cpu.halted; f++){
	runFrame();
	const cfg = vdp2.configFromRegisters();
	if(!cfg) continue;
	vdp2.render(cfg);
	const step = vdp2._fieldStep, start = vdp2._fieldStart;
	stepSum += step;
	linesSum += Math.ceil((vdp2.height - start) / step);
	height = vdp2.height; width = vdp2.width; tvmd = vdp2._r(0x00);
	n++;
}
if(!n){ console.log(GAME + ": no frames"); process.exit(1); }
const lsmd = (tvmd >> 6) & 0x3;
console.log(GAME + ": " + width + "x" + height + "   TVMD=0x" + tvmd.toString(16) + "  LSMD=" + lsmd +
	(lsmd === 3 ? " (double-density)" : lsmd === 2 ? " (single-density)" : lsmd ? " (?)" : " (progresivo)"));
console.log("   field step avg      " + (stepSum / n).toFixed(2));
console.log("   lines per frame     " + Math.round(linesSum / n) + "  of " + height + " of the declared height");
console.log("   -> " + (linesSum / n < height * 0.75 ? "ALREADY rasterizes one field: the interlace 2x IS TAKEN"
	: "rasterizes the WHOLE frame: there is a 2x available if LSMD=3"));
