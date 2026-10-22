// HEALTH STATUS OF ALL THE GAMES, in one run. It is the sweep that says which
// pending items are still ALIVE and which ones the document drags along for nothing.
//
// Reports per game what cannot be argued with: whether any CPU halted (illegal opcode),
// whether the sound 68k got disabled, whether the game booted from the BIOS, how much image it has
// and whether it plays sound. Written on 25-07-2026 to clean up PENDING.md against the real code.
//
// Usage: node diag/health.mjs [games] [frames=2500]
import { readFileSync } from "fs";
import { basename } from "path";

const GAMES = (process.argv[2] || "rally,vc,sfa,sonic,xmen,touring,daycce,daytona,vf2,xmenvs").split(",");
const FRAMES = parseInt(process.argv[3] || "2500", 10);
// The BIOS is NO longer chosen from a hand-made list: it comes from the REGION the disc declares
// (headless.biosForDisc). The old list only had X-Men, so Virtua Fighter 2
// -Japanese- was tested with the American BIOS. See headless.mjs, biosForDisc().

console.log("game      bios  booted   halted          image   colors   audio   notes");
for(const game of GAMES)
{
	const mod = await import("../headless.mjs?salud=" + game);
	const { bus, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, get68k, biosForDisc } = mod;
	let biosKey = "us";
	try
	{
		// The disc FIRST: it has to be mounted to read its region and know which BIOS goes.
		loadDiscFromCue(resolveGame(game));
		biosKey = biosForDisc(bus.cdReader);
		const bios = resolveBios(biosKey);
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		// applyBios resets the machine, so the disc is mounted again afterwards.
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(9) + " -> could not mount: " + e.message); continue; }

	let booted = false, consecutive = 0, m68kDied = false, poweredOn68k = false;
	let samples = 0, withImage = 0, maxColors = 0, keyOnMax = 0;
	let frameHalted = -1, frameSlaveHalted = -1;

	for(let f = 0; f < FRAMES; f++)
	{
		runFrame();
		const pc = mod.cpu.pc >>> 0;
		if(!booted && pc >= 0x06000000 && pc < 0x06100000 && ++consecutive >= 60) booted = true;
		else if(pc < 0x06000000 || pc >= 0x06100000) consecutive = 0;

		if(mod.cpu.halted && frameHalted < 0) frameHalted = f;
		if(mod.cpuSlave && mod.cpuSlave.halted && frameSlaveHalted < 0) frameSlaveHalted = f;
		if(get68k()) poweredOn68k = true;
		else if(poweredOn68k) m68kDied = true;

		const m = bus.scspEngine;
		if(m && m.slots){ let n = 0; for(const s of m.slots) if(s && s.key) n++; if(n > keyOnMax) keyOnMax = n; }

		if((f + 1) % 100) continue;
		const cfg = vdp2.configFromRegisters();
		samples++;
		if(!cfg) continue;
		vdp2.render(cfg);
		const fb = vdp2.fb;
		let n2 = 0, sum = 0, sum2 = 0;
		const colors = new Set();
		for(let i = 0; i < fb.length; i += 4 * 7)
		{
			const r = fb[i];
			sum += r; sum2 += r * r; n2++;
			colors.add((r << 16) | (fb[i + 1] << 8) | fb[i + 2]);
		}
		if(n2 && (sum2 / n2 - (sum / n2) ** 2) > 50) withImage++;
		if(colors.size > maxColors) maxColors = colors.size;
	}

	const notes = [];
	if(frameHalted >= 0)      notes.push("MASTER halted f" + frameHalted);
	if(frameSlaveHalted >= 0) notes.push("SLAVE halted f" + frameSlaveHalted);
	if(m68kDied)               notes.push("68k disabled");
	if(!poweredOn68k)            notes.push("the 68k never powered on");

	console.log(game.padEnd(9) + biosKey.padEnd(5)
		+ (booted ? "   yes  " : "   NO   ")
		+ (frameHalted < 0 && frameSlaveHalted < 0 ? "  no        " : "  YES       ")
		+ (samples ? (100 * withImage / samples).toFixed(0) : "0").padStart(4) + "%"
		+ String(maxColors).padStart(9)
		+ (keyOnMax ? "   yes " : "   NO ")
		+ "  " + notes.join(", "));
}
