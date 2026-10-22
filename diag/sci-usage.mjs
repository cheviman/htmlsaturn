/**
 *    Name:         sci-usage.mjs
 *    Description:  Which games use the SH7604's SCI (serial port), and how: accesses to
 *                  SMR/BRR/SCR/TDR/SSR/RDR with their values, whether they enable the transmitter, and whether
 *                  the TDRE flag stays stuck at 0 waiting for a transmission that we do not
 *                  model. One process per game.
 *    Version:      0.1.0
 *    Created:      28-07-2026
 *    Modified:     28-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// PENDING.md had the SCI down as "dev/debug, no game uses it" and the on-chip sweep
// classified it as "emulated". Both things are false and for the same reason: we store its
// registers RAW (reading returns what was written), so the sweep —which looks at whether the source
// consumes that offset— counts it as emulated even though there is not ONE single line of behavior.
// It is the same false negative that was already corrected twice in the sweeps.
//
// What the SCI does have to do, and does not do:
//   SSR bit 7 TDRE: it starts at 1, the software LOWERS it after
//   loading TDR, and the HARDWARE RAISES IT AGAIN when it moves the byte from TDR to TSR. If nobody
//   raises it, a game that waits for "TDRE==1 to send the next byte" spins until its own
//   timeout, every time.
//
// THE CONTROL (Rule 0): the value of SSR is reported, and whether TE (SCR bit 5, transmitter enabled)
// ever got turned on. If a game never turns TE on, its writes to the SCI are dead
// configuration and there is nothing more to read in that row. And ALL the games are run, not just the
// suspect: if the pattern shows up in only one, it belongs to that game; if it shows up in several, it belongs to the
// chip.
//
// Usage: node diag/sci-usage.mjs [games] [frames]

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const NAMES = { 0x00: "SMR", 0x01: "BRR", 0x02: "SCR", 0x03: "TDR", 0x04: "SSR", 0x05: "RDR" };
const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAMES = (process.argv[2] || "daytona,daycce,rally,sfa,sonic,vc,xmen,vf2,touring,xmenvs").split(",");
	const FRAMES = process.argv[3] || "1300";
	const yo = fileURLToPath(import.meta.url);
	console.log("SCI USAGE (SH7604 serial port) — " + FRAMES + " frames per game\n");
	console.log("game      TE?  SSR   SMR/BRR    character (cycles / us)  accesses per register");
	for(const j of GAMES)
	{
		const r = spawnSync(process.execPath, [yo, j, FRAMES, "--child"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		process.stdout.write(r.stdout || ("  " + j + " -> failed: " + (r.stderr || "").split("\n")[0] + "\n"));
	}
	console.log("\nRead it like this: a game with TE on and TDRE stuck at 0 is WAITING for a");
	console.log("transmission we never confirm to it. Each one of those waits costs it the game's whole");
	console.log("timeout, and that time shifts the phase of everything else in the frame.");
	process.exit(0);
}

// ---------------- child: one game ----------------
const GAME  = process.argv[2];
const FRAMES = parseInt(process.argv[3], 10);
const mod = await import("../headless.mjs?sci=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const hx = (v, n = 2) => "0x" + (v >>> 0).toString(16).padStart(n, "0");
const cpu = bus.cpuMaster;
const read = new Map(), write = new Map();
let teSeen = false;
// The values the game writes into SCR. TE only says whether it transmits; what decides whether the
// hardware RECEIVES —and therefore whether RDRF gets raised— are RE (bit 4) and the CKE1/CKE0 pair, which
// says who generates the clock. In synchronous mode with the internal clock the SCI is the master: it puts out
// the pulses and samples RxD anyway, even with nobody on the other side.
const scrSeen = new Set();

const origRead = cpu.readInternal.bind(cpu);
cpu.readInternal = function(addr, size){
	const off = addr & 0x1FF;
	if(off <= 0x05) read.set(off, (read.get(off) || 0) + 1);
	return origRead(addr, size);
};
const origWrite = cpu.writeInternal.bind(cpu);
cpu.writeInternal = function(addr, v, size){
	const off = addr & 0x1FF;
	if(off <= 0x05)
	{
		write.set(off, (write.get(off) || 0) + 1);
		// TE = SCR bit 5: without it, the transmitter is off and everything else is configuration.
		if(off === 0x02){ if(v & 0x20) teSeen = true; scrSeen.add(v & 0xFF); }
	}
	return origWrite(addr, v, size);
};

// TDRE "stuck at 0, sustained": consecutive frames in which SSR bit 7 is 0. It is
// measured per frame and not per access so it does not depend on how much the game polls.
let stuck = 0, worstStreak = 0;
for(let f = 0; f < FRAMES; f++)
{
	runFrame();
	const ssr = cpu.internalRegs[0x04];
	if(!(ssr & 0x80)){ stuck++; if(stuck > worstStreak) worstStreak = stuck; }
	else stuck = 0;
}

const detail = [];
for(const off of [0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
{
	const l = read.get(off) || 0, e = write.get(off) || 0;
	if(l || e) detail.push(NAMES[off] + " R" + l + "/W" + e);
}

// CONTROL OF THE CHARACTER ARITHMETIC (Rule 0). The Saturn's SH-2 runs at ~26.84 MHz, so
// one character has to come out in the order of tens or hundreds of microseconds. If it gave
// nanoseconds or milliseconds, the formula or the registers are misread and the rest of the
// row must not be believed.
const CYCLES_PER_US = 26.8741;
const car = cpu.sci ? cpu.sci.cyclesChar : 0;
const us = car / CYCLES_PER_US;
const suspect = teSeen && (us < 1 || us > 100000);

console.log(GAME.padEnd(9)
	+ (teSeen ? " YES " : " no ").padEnd(5)
	+ hx(cpu.internalRegs[0x04]).padEnd(6)
	+ (hx(cpu.internalRegs[0x00]) + "/" + hx(cpu.internalRegs[0x01])).padEnd(11)
	+ (car ? (car + " / " + us.toFixed(1) + " us") : "-").padEnd(25)
	+ (detail.length ? detail.join("  ") : "(does not touch it)")
	+ (suspect ? "   ⚠ CONTROL: character outside the credible range" : ""));

// SCR broken down. It is printed separately because it is several bits and on a single
// line it cannot be read. The CONTROL for this part: if the game never wrote SCR there is nothing to
// break down and that is said, instead of showing the reset value as if it were a decision of the game.
if(!scrSeen.size)
	console.log("            SCR: the game never writes it.");
else for(const v of [...scrSeen].sort((a, x) => a - x))
{
	const cke = v & 0x03;
	console.log("            SCR=" + hx(v)
		+ "  TIE=" + ((v >> 7) & 1) + " RIE=" + ((v >> 6) & 1)
		+ " TE=" + ((v >> 5) & 1)  + " RE=" + ((v >> 4) & 1)
		+ " MPIE=" + ((v >> 3) & 1) + " TEIE=" + ((v >> 2) & 1)
		+ "  CKE=" + cke + " ("
		+ ["INTERNAL clock, SCK as output", "internal clock, SCK as output",
		   "EXTERNAL clock via SCK", "external clock via SCK"][cke] + ")");
}
