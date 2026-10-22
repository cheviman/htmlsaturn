// HOW DID THE GAME GET TO THE BIOS? Dumps the path, not the destination.
//
// A PC at 0x2000xxxx (cache-through mirror of the BootROM) says nothing by itself: the
// games call BIOS routines all the time. What matters is when it STAYS there,
// and above all WHERE IT CAME FROM. This probe waits until the PC has spent N frames without leaving the
// BIOS and only then dumps the SH-2's own PC history (cpu.tracing), the
// registers and PR — which is the question the destination does not answer.
//
// Written on 25-07-2026 for SF Alpha, which with the event scheduler falls to
// 0x2000056c at ~750 frames and without it keeps running.
//
// Usage: node diag/jump-to-bios.mjs [game=sfa] [frames=1200] [framesStuck=20]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "sfa";
const FRAMES = parseInt(process.argv[3] || "1200", 10);
const STUCK = parseInt(process.argv[4] || "20", 10);

const mod = await import("../headless.mjs?saltobios=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const bios = resolveBios({ xmen: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// The SH-2's own ring of 16 PCs. It is OFF by default (it is a hot path).
mod.cpu.tracing = true;

const inBios = (pc) => (pc >>> 0) < 0x00080000 || ((pc >>> 0) >= 0x20000000 && (pc >>> 0) < 0x20080000);
const hx = (v) => "0x" + (v >>> 0).toString(16).padStart(8, "0");

// We only watch AFTER the game has really booted. At the start the CPU
// lives in the BIOS by definition (and parks in its CKCHG parking spot with IMASK at
// 15), so without this the probe fires at frame 19 with a false positive.
let booted = false, consecutive = 0, dump = false;
for(let f = 0; f < FRAMES && !mod.cpu.halted; f++)
{
	runFrame();
	const pc = mod.cpu.pc >>> 0;
	if(!booted)
	{
		// "Booted" = 60 consecutive frames executing in high WRAM (the disc code).
		if(pc >= 0x06000000 && pc < 0x06100000){ if(++consecutive >= 60){ booted = true; consecutive = 0; console.log("(the game booted at frame " + f + ")"); } }
		else consecutive = 0;
		continue;
	}
	if(inBios(pc)) consecutive++;
	else consecutive = 0;

	if(consecutive >= STUCK && !dump)
	{
		dump = true;
		const c = mod.cpu;
		console.log(GAME + ": the CPU has spent " + STUCK + " frames in the BIOS (frame " + f + ")");
		console.log("  PC = " + hx(c.pc) + "   PR = " + hx(c.pr) + "   SR = " + hx(c.sr)
			+ "   VBR = " + hx(c.vbr));
		// The history: from oldest to newest. The SECOND-TO-LAST is usually the jump.
		const hist = [];
		for(let i = 0; i < 16; i++) hist.push(c.histPc[(c.histIdx + i) & 15] >>> 0);
		console.log("  last PCs (old -> new):");
		for(let i = 0; i < hist.length; i += 4)
			console.log("    " + hist.slice(i, i + 4).map(hx).join("  "));
		console.log("  registers:");
		for(let i = 0; i < 16; i += 4)
			console.log("    R" + String(i).padStart(2) + "-" + String(i + 3).padStart(2) + ": "
				+ [0, 1, 2, 3].map(k => hx(c.r[i + k])).join("  "));
		// If it is spinning in a short loop, say WHICH one and what it reads.
		const unique = [...new Set(hist)];
		console.log("  distinct PCs in the history: " + unique.length
			+ (unique.length <= 4 ? "  -> SPINNING in a loop of " + unique.length : ""));
		break;
	}
}
if(!dump) console.log(GAME + ": did not get stuck in the BIOS in " + FRAMES + " frames");
