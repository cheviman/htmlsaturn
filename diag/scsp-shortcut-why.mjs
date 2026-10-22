/**
 *    Name:         scsp-shortcut-why.mjs
 *    Description:  Why a slot ends up with DISDL=0, IMXL=0 and a nonzero EFSDL. Dumps the
 *                  whole context of the slot the first time it depends on the shortcut.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// THE PROBLEM: scsp.js has a shortcut that makes a slot whose direct output is muted sound
// through EFSDL. On hardware that path DOES NOT EXIST (EFSDL/EFPAN are the level of
// EFREG and EXTS, not of the slot; DISDL 0 = "-inf (not sent)"; IMXL 0 =
// "-MAX (does not mix)"). It was removed on 27-07-2026 and Sega Rally lost effects in the menus,
// so it came back. Which means SOMETHING of ours needs that wire, and we have to find what.
//
// The two possible explanations, and how to tell them apart:
//
//   A) The sound SHOULD come out through EFREG. The slot sends to the DSP and the DSP returns it
//      through EFREG[n], which is mixed with slot n's EFSDL. If EFREG[n] is ZERO while the
//      slot is playing, the DSP is not delivering and the bug is there: the shortcut hides it by
//      sending the raw slot out through the direct path.
//   B) We lose a write. The game would set DISDL or IMXL at some point and we
//      do not decode it, so the slot stays muted because of a misread register.
//
// They are told apart by looking at EFREG[n] and the slot's write history. The probe dumps
// both things the FIRST time a slot depends on the shortcut.
//
// Usage: INPUT=1 node diag/scsp-shortcut-why.mjs [game=rally] [frames=3000]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "3000", 10);

const mod = await import("../headless.mjs?shortcut=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios({ xmen: "jp", xmenvs: "jp", vf2: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

const m = bus.scspEngine;
const MUTE = 31;

// History of writes to each slot's mix registers ($14 = ISEL/IMXL,
// $16 = DISDL/DIPAN/EFSDL/EFPAN). That is what decides hypothesis B.
const hist = new Array(32).fill(null).map(() => []);
const origScspWrite = bus.scspWrite.bind(bus);
let frame = 0;
bus.scspWrite = function(off, val, size)
{
	const o = off & 0xFFF;
	if(o < 0x400)
	{
		const n = (o >> 5) & 0x1F, reg = o & 0x1F;
		if(reg >= 0x14 && reg <= 0x17 && hist[n].length < 40)
			hist[n].push("f" + frame + " $" + reg.toString(16) + "=0x" + (val >>> 0).toString(16) + " (size " + size + ")");
	}
	return origScspWrite(off, val, size);
};

const START = 0x08;
const left = new Float32Array(4096);
let caught = -1;

for(frame = 0; frame < FRAMES && !cpu.halted && caught < 0; frame++)
{
	if(process.env.INPUT) bus.pad1a = (frame % 30 < 6) ? (0xFF & ~START) : 0xFF;
	runFrame();
	while(m.count > 0) m.readAudio(left, left, Math.min(m.count, 4096));

	for(let i = 0; i < 32 && caught < 0; i++)
	{
		const s = m.slots[i];
		if(s.ecnt >= 0x1FFFFF) continue;                       // off
		if(s.directGainLeft || s.directGainRight) continue;               // has direct output: does not use the shortcut
		if(m.activeDsp && s.imxl !== MUTE) continue;            // goes to the DSP through MIXS: neither
		if(!s.gainEfLeft && !s.gainEfRight) continue;               // no effect level: it would stay muted
		caught = i;
	}
}

if(caught < 0){ console.log(GAME + ": no slot depended on the shortcut in " + FRAMES + " frames" +
	(process.env.INPUT ? " (with input)" : " (NO input: try with INPUT=1)")); process.exit(0); }

const i = caught, s = m.slots[i], base = i * 0x20;
const w = (o) => ((bus.scspRam[base + o] << 8) | bus.scspRam[base + o + 1]) & 0xFFFF;
const p = (x) => "0x" + (x >>> 0).toString(16);

console.log("=== " + GAME + ": slot " + i + " depends on the shortcut (frame " + frame + ") ===");
console.log("");
console.log("  MIX REGISTERS");
console.log("    $14 = " + p(w(0x14)) + "   ISEL=" + ((w(0x14) >> 3) & 0xF) + "  IMXL=" + (w(0x14) & 7) +
	"   (IMXL 0 = 'does not mix')");
console.log("    $16 = " + p(w(0x16)) + "   DISDL=" + ((w(0x16) >> 13) & 7) + "  DIPAN=" + ((w(0x16) >> 8) & 0x1F) +
	"  EFSDL=" + ((w(0x16) >> 5) & 7) + "  EFPAN=" + (w(0x16) & 0x1F));
console.log("    (DISDL 0 = '-inf (not sent)')");
console.log("");
console.log("  STATE OF THE EFFECTS PATH");
console.log("    DSP active: " + m.activeDsp);
if(i < 16)
{
	const ef = (m.dspEfreg[i] << 16) >> 16;
	console.log("    EFREG[" + i + "] = " + ef + "   <- THIS slot's EFSDL controls THIS DSP output");
	console.log("    " + (ef !== 0
		? "The DSP DOES deliver on that output: the shortcut would be DUPLICATING (hypothesis A ruled out)."
		: "The DSP delivers NOTHING there: the sound the game expects to hear DOES NOT ARRIVE (hypothesis A)."));
}
else console.log("    (slot >= 16: its EFSDL controls EXTS" + (i - 16) + ", the external input, not a DSP output)");
// Which slots DO send to MIXS? If nobody sends, the DSP has nothing to take from.
const aMixs = [];
for(let k = 0; k < 32; k++) if(m.slots[k].imxl !== MUTE) aMixs.push(k + "->MIXS" + m.slots[k].isel);
console.log("    slots feeding the DSP: " + (aMixs.length ? aMixs.join(" ") : "NONE"));
console.log("");
console.log("  HISTORY of writes to $14-$17 of this slot (hypothesis B)");
console.log(hist[i].length ? "    " + hist[i].join("\n    ") : "    (none: the slot kept what it had)");
