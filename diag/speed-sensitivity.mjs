/**
 *    Name:         speed-sensitivity.mjs
 *    Description:  Runs a game varying the SH-2 SPEED (extra cycles per instruction,
 *                  in %) and reports at which frame it stops serving interrupts. Answers whether a
 *                  hang is a phase race or is deterministic.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// A hang can be of two kinds and they call for opposite work:
//   - PHASE RACE: two things that compete and one arrives earlier than it would on
//     real hardware. It is fixed by emulating right what sets the timing (wait states, VDP1 cost,
//     latencies). Changing the CPU speed moves it to another frame or makes it disappear.
//   - MISSING OR WRONG PIECE: the game asks for something we do not give it. Changing the speed does NOT move it:
//     it hangs anyway, earlier or later but for the same reason.
//
// This probe separates them without having to understand the game, which is exactly what the repo's rule
// asks to avoid. And the number it returns serves the other thing needed before working:
// measuring the CEILING. If slowing the CPU down by 40% does not move the hang, implementing the wait states will not
// fix it, however faithful to the hardware they are for other reasons.
//
// The brake is applied as extra cycles per instruction, which is exactly the shape of
// a memory wait state: it does not change WHAT gets executed, it changes how much system TIME it
// takes. That is why video, CD and SCSP keep running at their real pace.
//
// THE CONTROL (Rule 0), two of them:
//   1. 0% has to reproduce the already known hang frame. If not, hooking the
//      brake broke something and no row is to be believed.
//   2. A game that WORKS is run too. If the control also "hangs" at some %, the
//      detector is wrong (or that % breaks the whole emulator) and it is not reported either.
//
// Usage: node diag/speed-sensitivity.mjs [games] [percentages] [frames]
//   node diag/speed-sensitivity.mjs daytona,rally 0,10,25,40,-15 1800

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAMES = (process.argv[2] || "daytona,rally").split(",");
	const PCTS   = (process.argv[3] || "0,10,25,40,-15").split(",");
	const FRAMES = process.argv[4] || "1800";
	const yo = fileURLToPath(import.meta.url);
	console.log("HANG SENSITIVITY TO SH-2 SPEED — " + FRAMES + " cuadros\n");
	console.log("(the % is how much LONGER each instruction takes; negative = the CPU runs faster)\n");
	console.log("game      brake    frame w/o IRQ     instructions/frame     result");
	for(const j of GAMES)
	{
		for(const p of PCTS)
		{
			const r = spawnSync(process.execPath, [yo, j, p, FRAMES, "--child"],
				{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
			process.stdout.write(r.stdout || ("  " + j + " " + p + "% -> failed: " + (r.stderr || "").split("\n")[0] + "\n"));
		}
		console.log("");
	}
	console.log("How to read it: if the hang frame MOVES with the brake, it is a phase race and");
	console.log("what is missing is time charged right. If it does NOT move, slowing the CPU down does not fix it and");
	console.log("we have to look for a missing or badly modeled piece.");
	process.exit(0);
}

// ---------------- child ----------------
const GAME  = process.argv[2];
const PCT    = parseFloat(process.argv[3]);
const FRAMES = parseInt(process.argv[4], 10);

const mod = await import("../headless.mjs?sv=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

// The brake, with a fractional accumulator so that 10% is 10% and not "1 cycle every 1".
// It hooks into step() and not into the cycle table because the table is a shared hot path
// and touching it would also change the bench hash.
let debt = 0, steps = 0;
const hookThrottle = (cpu) => {
	if(!cpu || cpu.__throttle) return;
	cpu.__throttle = true;
	const orig = cpu.step.bind(cpu);
	const f = PCT / 100;
	cpu.step = function(){
		const before = this.cycles;
		const r = orig();
		steps++;
		debt += (this.cycles - before) * f;
		// Whole cycles only: the remainder stays as debt for the next instruction.
		const ent = debt | 0;
		if(ent){ this.cycles += ent; debt -= ent; }
		return r;
	};
};

let servedFrame = 0;
const hookIrq = (cpu) => {
	if(!cpu || cpu.__irq) return;
	cpu.__irq = true;
	const orig = cpu._serveInterrupt.bind(cpu);
	cpu._serveInterrupt = function(n, v){ servedFrame++; return orig(n, v); };
};

// Hung = MANY consecutive frames without serving a single interrupt. The threshold is 30 and not 2
// because a game can spend frames masked on purpose (loading, scene change).
//
// ⚠ AND THE BOOT HAS TO BE SKIPPED. The first version did not do it and its own control
// refuted it: it said "hung at frame 0" even for Rally, which works. During the BIOS
// boot hundreds of frames go by without a single interrupt served, so the streak is
// met there and the detector always fires. The brake hooks from frame 0 anyway —what
// is skipped is LOOKING, not braking.
// ⚠ AND THE STREAK HAS TO REACH THE END. The second version cut at the first
// streak of 30 and its control refuted it again: Rally, which works, said "hung at 1044".
// It was true that it was not serving interrupts there —it is loading from the CD with everything masked— and
// false that it was hung, because it carries on afterwards. A hang is not "a while without IRQ": it is a
// while without IRQ THAT NEVER ENDS. That is why the whole strip is now run and we look at the FINAL
// streak, which is the only one we do not know whether it ends.
const STREAK = 30;
const WARM  = 700;
let dry = 0, firstDry = -1, shifted = 0;
const pauses = [];   // streaks that DID end: the control that the detector sees too much
// WITH INPUT (INPUT=1): without pressing START the games do not get past the attract mode, and there are hangs that only
// show up in-game (the second one of Daytona USA, reported in Chrome by Sebas (29-07-2026, translated):
// "it got to a point where it hung, but the music keeps going" — i.e. the master stuck and the sound
// 68000 running on its own).
const START = 0x08;
for(let f = 0; f < FRAMES; f++)
{
	hookThrottle(bus.cpuMaster);
	hookIrq(bus.cpuMaster);
	if(process.env.INPUT) bus.pad1a = (f % 30 < 6) ? (0xFF & ~START) : 0xFF;
	servedFrame = 0;
	runFrame();
	shifted++;
	if(f < WARM) continue;
	if(servedFrame === 0)
	{
		if(dry === 0) firstDry = f;
		dry++;
	}
	else
	{
		if(dry >= STREAK) pauses.push(firstDry + "+" + dry);
		dry = 0; firstDry = -1;
	}
}
const hung = (dry >= STREAK) ? firstDry : -1;

const perFrame = Math.round(steps / shifted);
console.log(GAME.padEnd(9)
	+ ((PCT > 0 ? "+" : "") + PCT + "%").padStart(6) + "   "
	+ (hung >= 0 ? String(hung).padStart(11) : "     none") + "    "
	+ String(perFrame).padStart(18) + "   "
	+ (hung >= 0 ? "HUNG until the end" : "still alive after " + FRAMES)
	+ (pauses.length ? "   (pauses that DID end: " + pauses.join(" ") + ")" : ""));
