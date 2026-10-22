// WAITS THAT NEVER RESOLVE. The detector that scales to 500 games.
//
// diag/what-waits.mjs says WHAT a game polls when it spins. Run over the 10 discs
// (diag/waits-all.mjs) it gave something that looked huge -0x06002d84 polled by 8 out of 10
// games- and it turned out to be a FALSE POSITIVE: that flag IS WRITTEN in all of them, so the wait
// resolves. It is the normal wait routine of the shared library (all games
// use the same one, hence the common address). Spinning while the CD works is the right thing.
//
// What tells a hang apart from a healthy wait is not WHAT is waited for: it is HOW LONG. This probe
// measures the STREAK OF CONSECUTIVE FRAMES the CPU spends in the SAME loop. A healthy wait
// lasts a few frames; a hang lasts until the end of the run.
//
// That is why it scales: there is no need to know which game it is or what should happen. It is run, and what
// comes out is "this CPU was stuck N frames in this loop reading this address" — which is
// actionable without knowing the game. With 500 discs, this is a table; going one by one is not.
//
// CONTROL (rule 0): Daytona USA has to show up with the master stuck from ~f848 and the
// slave stuck at 0x6034f3x. Both were found by hand on 26-07-2026, disassembling.
// If they do not come out, the probe is wrong and nothing is reported.
//
// Usage: node diag/stuck-waits.mjs [games] [frames=1400] [minFrames=60]
import { readFileSync } from "fs";
import { basename } from "path";

const ALL = ["rally", "vc", "sfa", "sonic", "xmen", "daytona", "daycce", "touring", "vf2", "xmenvs"];
const GAMES = (process.argv[2] || ALL.join(",")).split(",");
const FRAMES = parseInt(process.argv[3] || "1400", 10);
const LSQ = parseInt(process.argv[4] || "60", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };
const hx = (v) => "0x" + (v >>> 0).toString(16);

// A "loop" is identified by the PC rounded to 32 bytes: enough not to confuse two
// different routines and for the iterations of the same loop to always land on the same key.
const key = (pc) => (pc >>> 5);

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?colg=" + game);
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try
	{
		const b = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(b), new Uint8Array(readFileSync(b)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(9) + " could not be mounted: " + e.message); continue; }

	// The live CPUs come from the BUS: mounting the disc resets and creates new instances.
	const cpus = [["master", bus.cpuMaster], ["slave", bus.cpuSlave]].filter(([, c]) => c);

	// Per CPU: which loop it spends most of EACH frame in, and how many consecutive
	// frames it has been in the same one. It is counted per frame with a small histogram, not with a
	// snapshot of the PC: a single sample per frame cannot tell "spins here" from "was passing through here".
	const state = cpus.map(() => ({ current: -1, streak: 0, worst: 0, worstKey: -1, worstFrom: 0, since: 0 }));
	const hist = cpus.map(() => new Map());

	// WHAT THE LOOP READS, AND WHETHER ANY OF THOSE VALUES MOVES. Without this the probe flags
	// HEALTHY waits as hung: all 10 games spend ~115 frames in a BIOS loop
	// that waits on a counter (reads 0x60408ec and it advances 0x19, 0x1a, 0x1b...) until it passes
	// 0x82 — a deliberate 1.75 s delay that the real hardware does too. The difference
	// with a real hang is exactly this: if some value ADVANCES, the wait is going to
	// end; if none moves, it never ends.
	const read = cpus.map(() => new Map());   // addr -> {first, change}
	let activeCpu = -1;
	for(const fn of ["readByte", "readWord", "readLong"])
	{
		const orig = bus[fn].bind(bus);
		bus[fn] = (a) => {
			const v = orig(a);
			// We only care about what a CPU reads once it has ALREADY been spinning in the same loop for a while.
			if(activeCpu >= 0 && state[activeCpu].streak > 8)
			{
				const m = read[activeCpu];
				const d = (a >>> 0) & 0x07FFFFFF;
				const e = m.get(d);
				if(e === undefined){ if(m.size < 4000) m.set(d, { first: v, change: false }); }
				else if(!e.change && e.first !== v) e.change = true;
			}
			return v;
		};
	}

	const wrapped = cpus.map(([, c], i) => {
		const orig = c.step.bind(c);
		c.step = () => {
			const k = key(c.pc >>> 0);
			hist[i].set(k, (hist[i].get(k) || 0) + 1);
			activeCpu = i;
			const r = orig();
			activeCpu = -1;
			return r;
		};
		return orig;
	});

	// WITH INPUT (INPUT=1). Mandatory control: several games do not dispatch anything to the slave
	// until the menu is navigated (Rally without input gives 0 doorbells and with input 2,730). A
	// dead wait that DISAPPEARS with input is not an emulator bug: it is headless without
	// pressing buttons. The one that survives the input is.
	const START = 0x08;
	for(let f = 0; f < FRAMES && !bus.cpuMaster.halted; f++)
	{
		if(process.env.INPUT) bus.pad1a = (f % 30 < 6) ? (0xFF & ~START) : 0xFF;
		runFrame();
		for(let i = 0; i < cpus.length; i++)
		{
			// The frame's dominant loop: if it takes more than 60% of the steps, the CPU
			// was spinning there and not just passing through.
			let best = -1, bestN = 0, total = 0;
			for(const [k, n] of hist[i]){ total += n; if(n > bestN){ bestN = n; best = k; } }
			hist[i].clear();
			const e = state[i];
			const domina = total > 0 && (bestN / total) > 0.6 ? best : -1;
			if(domina !== -1 && domina === e.current)
			{
				if(++e.streak > e.worst){ e.worst = e.streak; e.worstKey = e.current; e.worstFrom = e.since; }
			}
			else { e.current = domina; e.streak = domina === -1 ? 0 : 1; e.since = f; }
		}
	}
	// Put back the original step() functions (in case the module is reused).
	cpus.forEach(([, c], i) => { c.step = wrapped[i]; });

	const lines = [];
	for(let i = 0; i < cpus.length; i++)
	{
		const e = state[i];
		if(e.worst < LSQ) continue;
		// Did any of the values the loop watches move? If so, the wait is progressing.
		let advances = 0, quiet = 0;
		for(const v of read[i].values()){ if(v.change) advances++; else quiet++; }
		const dead = advances === 0;
		lines.push({
			dead: dead,
			txt: "   " + cpus[i][0].padEnd(7) + (dead ? "DEAD    " : "waiting ") +
				String(e.worst).padStart(5) + " frames at " + hx(e.worstKey << 5) + ".." +
				hx((e.worstKey << 5) + 31) + "   since f" + String(e.worstFrom).padStart(4) +
				"   values it watches: " + advances + " advance, " + quiet + " quietos" +
				(dead ? "   <<< NONE ADVANCES: it will not get out on its own" : "")
		});
	}
	const deadCount = lines.filter(l => l.dead).length;
	console.log(game.padEnd(9) +
		(deadCount ? "*** " + deadCount + " DEAD wait(s)" : (lines.length ? "ok  (" + lines.length + " wait(s), all progressing)" : "ok  (no long waits)")));
	for(const l of lines) console.log(l.txt);
}
