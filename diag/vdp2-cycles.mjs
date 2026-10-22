/**
 *    Name:         vdp2-cycles.mjs
 *    Description:  Which split of VRAM accesses each game asks for in the VDP2 cycle pattern
 *                  registers, and how many accesses per pixel it leaves to the CPU.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// The cycle pattern registers (180010H-18001EH) were the last 8 gaps in the VDP2 sweep, and
// they are now decoded (vdp2._readPatternsCycle). This probe says WHAT the games asked for, which is
// what is needed to decide two things:
//
//   1. How long the SH-2 waits when it touches VDP2 VRAM. These registers control how much
//      access the CPU has to VDP2 VRAM while the screen is being displayed (during the vertical
//      blanking interval the CPU can access VRAM freely). The value 14 is "CPU data": if
//      a game reserves NO timing for it, the CPU has to wait for V blank.
//   2. Whether any game uses the ILLEGAL values (8-11), which are forbidden on hardware.
//
// THE CONTROL (Rule 0): we report how many frames had the screen ON. The cycle
// patterns of a screen that is off mean nothing -the VDP2 is not rasterizing-, so without
// that figure a "0 accesses for the CPU" cannot be told apart from "nothing was configured".

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAMES = (process.argv[2] || "rally,vc,sfa,sonic,xmen,touring,daycce,daytona,vf2,xmenvs").split(",");
	const FRAMES = process.argv[3] || "1200";
	const yo = fileURLToPath(import.meta.url);
	console.log("VDP2 CYCLE PATTERNS — " + FRAMES + " frames per game\n");
	console.log("game      display   timings   banks    CPU/pixel   illegal    most used pattern");
	for(const j of GAMES)
	{
		const r = spawnSync(process.execPath, [yo, j, FRAMES, "--child"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		process.stdout.write(r.stdout || ("  " + j + " -> failed: " + (r.stderr || "").split("\n")[0] + "\n"));
	}
	console.log("\nValues: 0-3 pattern name NBG0-3 · 4-7 character pattern · 8-11 ILLEGAL");
	console.log("         12-13 vertical cell scroll · 14 CPU · 15 nobody");
	console.log("\nA game with CPU/pixel = 0 leaves the SH-2 ONLY V blank to touch the VDP2's");
	console.log("VRAM. That is what would have to be charged as a wait, and the number in this column is the");
	console.log("one that decides how much.");
	process.exit(0);
}

// ---------------- child ----------------
const GAME  = process.argv[2];
const FRAMES = parseInt(process.argv[3], 10);
const mod = await import("../headless.mjs?vc=" + GAME);
const { bus, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const patterns = new Map();
let withDisplay = 0, sumCpu = 0, illegal = 0, timings = 0, banks = 0;
for(let f = 0; f < FRAMES; f++)
{
	runFrame();
	const cfg = vdp2.configFromRegisters();
	if(!cfg || !cfg.patternsCycle) continue;   // DISP off: it means nothing
	withDisplay++;
	const p = cfg.patternsCycle;
	sumCpu += p.cpuPerPixel; illegal += p.illegal;
	timings = p.timings; banks = p.banks.length;
	const k = p.banks.map(b2 => b2.bank + ":" + b2.timings.map(v => v.toString(16)).join("")).join(" ");
	patterns.set(k, (patterns.get(k) || 0) + 1);
}

const top = [...patterns.entries()].sort((a, b2) => b2[1] - a[1])[0];
console.log(GAME.padEnd(9)
	+ String(withDisplay).padStart(8) + String(timings).padStart(10) + String(banks).padStart(9)
	+ (withDisplay ? (sumCpu / withDisplay).toFixed(1) : "-").padStart(12)
	+ String(illegal).padStart(11) + "   " + (top ? top[0] : "(no display)"));
