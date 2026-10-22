// DOES THE CPU WRITE THE VDP1 FRAMEBUFFER BY HAND?
//
// A concrete question, with a concrete consequence. The VDP1 framebuffer is mapped at
// 0x05C80000 (bus.js: set(0x05C80000, 0x05D00000, this.vdp1Fb, ...)), so a game
// can draw there with the CPU instead of with VDP1 commands.
//
// WHY IT MATTERS: in worker mode the banks with real content live in the WORKER, and what
// the CPU writes into bus.vdp1Fb (main thread) does not get there. If a game writes the
// framebuffer by hand, the copy protocol is eating those pixels.
//
// This is NOT a performance measurement nor a "how it looks" one: it is a fact about the game
// (how many writes and to which addresses), and that is why headless is the right tool.
//
// Usage: node diag/cpu-writes-fb.mjs [games] [frames=1200]
import { readFileSync } from "fs";
import { basename } from "path";

const GAMES = (process.argv[2] || "rally,touring,sfa,sonic").split(",");
const FRAMES = parseInt(process.argv[3] || "1200", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };

const FB_START = 0x05C80000, FB_END = 0x05D00000;

for(const game of GAMES)
{
	const mod = await import("../headless.mjs?fbw=" + game);
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
	try
	{
		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(8) + " -> could not mount: " + e.message); continue; }

	// Counters per access width. The bus's three writers are wrapped: it is the only
	// path through which the CPU (and the SCU DMA, which also goes through here) touches memory.
	let nB = 0, nW = 0, nL = 0, bytes = 0;
	const pcs = new Map();
	const note = (n) =>
	{
		bytes += n;
		// Where the write comes from: the master's PC is enough to locate it in the code.
		const pc = cpu.pc >>> 0;
		pcs.set(pc, (pcs.get(pc) || 0) + 1);
	};
	const oB = bus.writeByte.bind(bus), oW = bus.writeWord.bind(bus), oL = bus.writeLong.bind(bus);
	bus.writeByte = (a, v) => { if(a >= FB_START && a < FB_END){ nB++; note(1); } return oB(a, v); };
	bus.writeWord = (a, v) => { if(a >= FB_START && a < FB_END){ nW++; note(2); } return oW(a, v); };
	bus.writeLong = (a, v) => { if(a >= FB_START && a < FB_END){ nL++; note(4); } return oL(a, v); };

	for(let f = 0; f < FRAMES && !cpu.halted; f++) runFrame();

	const total = nB + nW + nL;
	const top = [...pcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
		.map(([pc, n]) => "0x" + pc.toString(16) + "(" + n + ")").join(" ");
	console.log(game.padEnd(8) +
		" writes to the VDP1 FB: " + String(total).padStart(9) +
		"   (byte " + nB + ", word " + nW + ", long " + nL + ")" +
		"   " + (total / FRAMES).toFixed(1) + "/frame, " + (bytes / FRAMES / 1024).toFixed(1) + " KB/frame" +
		(top ? "   PCs: " + top : ""));
}
