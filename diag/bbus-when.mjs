/**
 *    Name:         bbus-when.mjs
 *    Description:  WHEN the SH-2 accesses the B-Bus (VDP1/VDP2): during active display or in
 *                  V blank. It is the real ceiling of charging B-Bus wait states, measured before
 *                  writing a single line of the model.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// Wait states are listed as "the biggest performance lever left" with this arithmetic:
// the SH-2 makes 62,647 data accesses per frame, of which 29,177 go to the B-Bus, and each
// wait cycle we do not charge is 14% of the frame. **But that arithmetic assumes ALL
// accesses pay wait states**, and on the hardware they do not:
//
//   The cycle pattern registers also govern how much access the CPU gets to VDP2 VRAM while
//   the screen is being displayed, and **during the vertical blanking interval the CPU
//   accesses VRAM freely**.
//
// In other words: in V blank the CPU has the VRAM to itself and does NOT wait. During active
// display it waits until it gets one of the 8 memory cycles per pixel, and only if the game
// reserved one for it (value 14 in the cycle pattern registers).
//
// And games write VRAM in V blank PRECISELY because of that. So before modeling anything we
// need to know what fraction of the accesses falls on each side: if the bulk falls in V blank, the
// real wait is a small fraction of those 29,177 and the lever is not what it looked like.
//
// THE CONTROL (Rule 0), two of them:
//   1. The sum of the accesses must be of the same order as the 29,177/frame already measured. If
//      it came out ten times higher or lower, the probe is counting something else.
//   2. The % of the frame that V blank lasts is also reported (38 of 262 lines = 14.5% in NTSC
//      with 224 visible). If the accesses fell RANDOMLY spread, the % in V blank would have to
//      resemble that 14.5%. The further above it, the more deliberate the pattern.
//
// Usage: node diag/bbus-when.mjs [games] [frames]

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAMES = (process.argv[2] || "rally,vc,sfa,sonic,daytona,vf2").split(",");
	const FRAMES = process.argv[3] || "600";
	const yo = fileURLToPath(import.meta.url);
	console.log("SH-2 ACCESSES TO THE B-BUS: during active display or in V blank? — "
		+ FRAMES + " cuadros\n");
	console.log("game      acc/frame    in V blank   in display   VRAM VDP2   regs+other   |  "
		+ "VRAM/frame:  display  vblank   other-display");
	for(const j of GAMES)
	{
		const r = spawnSync(process.execPath, [yo, j, FRAMES, "--child"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		process.stdout.write(r.stdout || ("  " + j + " -> failed: " + (r.stderr || "").split("\n")[0] + "\n"));
	}
	console.log("\nOnly the accesses DURING DISPLAY can pay wait states (in V blank the CPU");
	console.log("accesses VRAM freely). That is the real ceiling of modeling the B-Bus wait states.");
	process.exit(0);
}

// ---------------- child ----------------
const GAME  = process.argv[2];
const FRAMES = parseInt(process.argv[3], 10);
const mod = await import("../headless.mjs?bb=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, plan } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

// The region x moment CROSS, which is what resolves the contradiction: it is not enough to know
// how many accesses fall during display, we need to know how many of THOSE go to VDP2 VRAM —
// which is the only region whose access the cycle patterns govern.
let inVblank = 0, inDisplay = 0, vramVdp2 = 0, others = 0, measuring = false;
let vramInDisplay = 0, vramInVblank = 0, othersInDisplay = 0;

// V blank goes from line 0 to `lines - visible`: it is where the scheduler schedules the
// VBlank-OUT. `linesVisible` does not live in the scheduler (it was cleaned up as an orphan), so it
// is taken from bus.linesVisibleTv(), which is the source since 29-07-2026 (it comes from VRESO in TVMD).
const inVb = () => {
	if(!plan.cyclesPerFrame) return false;
	const l = plan.currentLine();
	return l < (plan.lines - bus.linesVisibleTv());
};

const count = (a) => {
	if(!measuring) return;
	// ⚠ THE CACHE REGION HAS TO BE NORMALIZED. On the Saturn's SH-2 the top 3 bits select the
	// access mode (cached 0x0..., cache-through 0x2..., purge 0x4...), and the physical address
	// is `a & 0x1FFFFFFF`. Filtering only by 0x25C..... —the cache-through view— loses
	// ALL the cached accesses, which are the common path: it gave 94-976 per frame against the
	// 29,177 already measured. Second time the control catches this same probe.
	const d = (a & 0x1FFFFFFF) >>> 0;
	// B-Bus: VDP1 (VRAM/FB/regs) and VDP2 (VRAM/CRAM/regs). The SCU (0x05FE....) is NOT B-Bus.
	if(d < 0x05C00000 || d >= 0x05FC0000) return;
	const vb = inVb();
	const isVram = d >= 0x05E00000 && d < 0x05E80000;
	if(vb) inVblank++; else inDisplay++;
	if(isVram) vramVdp2++; else others++;
	if(isVram){ if(vb) vramInVblank++; else vramInDisplay++; }
	else if(!vb) othersInDisplay++;
};
// ⚠ YOU HAVE TO HOOK INTO THE CPU, NOT THE BUS. It is trap 7 in PENDING.md, and the first
// version of this probe fell into it: the SH-2 **does not resolve its accesses through `bus.readByte`** —
// the common path goes through its own page table (`this.pages[a >>> 16]`). Counting in the
// bus gave 158-1,042 accesses/frame against the 29,177 already measured, that is 30-180 times fewer, and
// the control catches it right away.
const hookCpu = (cpu) => {
	if(!cpu || cpu.__bb) return;
	cpu.__bb = true;
	for(const m of ["readByte", "readWord", "readLong", "writeByte", "writeWord", "writeLong"])
	{
		const orig = cpu[m].bind(cpu);
		cpu[m] = function(a, v){ count(a); return orig(a, v); };
	}
};

// Warm-up without counting, so as not to measure the BIOS boot. The hook goes per frame because the
// reset RECREATES the SH-2 (trap 7).
const START = 0x08;
for(let f = 0; f < 300; f++)
{
	hookCpu(bus.cpuMaster);
	if(process.env.INPUT) bus.pad1a = (f % 30 < 6) ? (0xFF & ~START) : 0xFF;
	runFrame();
}
if(process.env.INPUT) bus.pad1a = 0xFF;
measuring = true;
for(let f = 0; f < FRAMES; f++){ hookCpu(bus.cpuMaster); runFrame(); }

const tot = inVblank + inDisplay;
const pct = (n) => tot ? (n / tot * 100).toFixed(1) + "%" : "-";
console.log(GAME.padEnd(9)
	+ String(Math.round(tot / FRAMES)).padStart(11)
	+ (pct(inVblank) + " ").padStart(13) + pct(inDisplay).padStart(12)
	+ pct(vramVdp2).padStart(12) + pct(others).padStart(12)
	+ "   |  " + String(Math.round(vramInDisplay / FRAMES)).padStart(7)
	+ String(Math.round(vramInVblank / FRAMES)).padStart(9)
	+ String(Math.round(othersInDisplay / FRAMES)).padStart(9));
