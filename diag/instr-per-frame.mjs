// HOW MANY INSTRUCTIONS DOES THE SH-2 EXECUTE PER FRAME, and at how many cycles each?
//
// It is the measurement that reveals whether the CPU is charging its real cost. With 1 fixed cycle per
// instruction the number is ALWAYS the whole frame budget (447,443 in NTSC) in
// every game, which is exactly what diag/frame-profile.mjs showed on 25-07-2026:
// "447k instr/frame" pinned in rally, sfa and sonic. With SH2_CYCLES it has to drop, and the
// average of cycles per instruction has to come out > 1 (how much depends on the game's
// code: how many branches and multiplications it uses).
//
// It does not measure time on purpose: it only counts. That way it can run in parallel with something else
// without the measurements stepping on each other.
//
// Usage: node diag/instr-per-frame.mjs [frames=600] [game1,game2,...]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "600", 10);
const GAMES = (process.argv[3] || "rally,sfa,sonic,vc").split(",");
const BIOS_PER_GAME = { xmen: "jp" };

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?ipf=" + encodeURIComponent(game));
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try
	{
		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(7) + " -> could not mount: " + e.message); continue; }

	// CAREFUL: mod.cpu / mod.cpuSlave, do NOT destructure (reset() reassigns them on mount).
	// The REAL steps are separated from the IDLE-SKIP ones: when cpu.idle is set, step()
	// returns early (it neither fetches nor executes an instruction, it only charges 1 cycle). Knowing how many
	// are of each kind decides whether it is worth attacking the idle: if they are the majority, the
	// interpreter is not the bottleneck and what needs optimizing is the wait.
	let nM = 0, nS = 0, idleM = 0, idleS = 0;
	const origM = mod.cpu.step.bind(mod.cpu);
	mod.cpu.step = () => { nM++; if(mod.cpu.idle) idleM++; return origM(); };
	if(mod.cpuSlave)
	{
		const origS = mod.cpuSlave.step.bind(mod.cpuSlave);
		mod.cpuSlave.step = () => { nS++; if(mod.cpuSlave.idle) idleS++; return origS(); };
	}

	for(let f = 0; f < 200; f++) runFrame();            // reach steady state
	nM = 0; nS = 0; idleM = 0; idleS = 0;
	const cM0 = mod.cpu.cycles, cS0 = mod.cpuSlave ? mod.cpuSlave.cycles : 0;
	let frames = 0;
	for(; frames < FRAMES && !mod.cpu.halted; frames++) runFrame();
	const dM = mod.cpu.cycles - cM0, dS = mod.cpuSlave ? mod.cpuSlave.cycles - cS0 : 0;

	const fmt = (instr, cycles, idle) => (instr / frames / 1000).toFixed(0).padStart(4) + "k steps/frame"
		+ "   " + (cycles / frames / 1000).toFixed(0).padStart(4) + "k cycles/frame"
		+ "   " + (instr ? (cycles / instr).toFixed(2) : "-") + " cycles/step"
		+ "   idle " + (instr ? (100 * idle / instr).toFixed(0) : "0").padStart(3) + "%"
		+ " (" + ((instr - idle) / frames / 1000).toFixed(0) + "k real instr/frame)";
	console.log(game.padEnd(6) + " master " + fmt(nM, dM, idleM));
	if(nS) console.log("       slave  " + fmt(nS, dS, idleS));
}
