// BOOT AS IN THE BROWSER: the disc is mounted HOT, with the BIOS running.
//
// This is the structural difference that on 25-07-2026 let through a bug that broke ALL
// the games (see PENDING.md, "the bug that broke every game"):
//
//   browser    -> applyBios() resets and boots; the user drops the disc in AFTERWARDS,
//                 with the BIOS already running. loadDisc() does NOT reset: the BIOS detects it
//                 by itself and jumps to the game, and THAT is where the reset hits the SH-2.
//   headless   -> applyBios() + loadDiscFromCue() and only then the first frame.
//                 The CPU reset never falls INSIDE the emulation.
//
// In other words, the whole path "the BIOS discovers a disc and boots the game" -which is the one that
// broke- was not exercised by any probe. Test battery 8/8, smoke test fine and stable hashes with the
// emulator broken.
//
// And WATCH OUT with the smoke test for this: it measures variance and colors of the screen, but the BIOS
// menu has MORE colors than a game's black boot screen, so "it did not boot" can
// look like an improvement. Here we look at WHERE THE CPU EXECUTES, which cannot be misread:
//   BootROM 0x00000000-0x0007FFFF = BIOS    high WRAM 0x06000000+ = disc code
//
// It is tested by mounting at SEVERAL moments, because the instant of mounting decides which
// part of its routine the BIOS is in when the disc appears.
//
// Usage: node diag/hot-boot.mjs [games=rally,vc,sfa,sonic] [waits=60,300,600]
import { readFileSync } from "fs";
import { basename } from "path";

const GAMES  = (process.argv[2] || "rally,vc,sfa,sonic").split(",");
const WAITS = (process.argv[3] || "60,300,600").split(",").map(Number);
const FRAMES_AFTER_MOUNT = 2500;
const BIOS_PER_GAME = { xmen: "jp" };

let failures = 0;
for(const game of GAMES)
{
	for(const wait of WAITS)
	{
		const mod = await import("../headless.mjs?hot=" + game + "-" + wait);
		const { runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;

		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));

		// 1) The BIOS runs ALONE, without a disc. Like when the page opens.
		for(let f = 0; f < wait; f++) runFrame();

		// 2) The disc appears HOT. Without resetting: same as the browser's loadDisc().
		const t0 = Date.now();
		try{ loadDiscFromCue(resolveGame(game)); }
		catch(e){ console.log(game.padEnd(6) + " waits " + String(wait).padStart(4) + " -> could not mount: " + e.message); continue; }

		// 3) Run and see whether the BIOS picks it up. We count where the CPU executes, and also
		//    how long each frame takes: the absolute-target bug did not hang forever,
		//    it made ONE frame of 6.4 seconds. A slow frame is as much a symptom as a hung one.
		let inWram = 0, worstFrameMs = 0;
		for(let f = 0; f < FRAMES_AFTER_MOUNT && !mod.cpu.halted; f++)
		{
			const t = Date.now();
			runFrame();
			const dt = Date.now() - t;
			if(dt > worstFrameMs) worstFrameMs = dt;
			const pc = mod.cpu.pc >>> 0;
			if(pc >= 0x06000000 && pc < 0x06100000) inWram++;
		}
		const pctWram = 100 * inWram / FRAMES_AFTER_MOUNT;
		const seconds = ((Date.now() - t0) / 1000).toFixed(1);

		// Verdict: a game that booted lives in WRAM. Below 50% it did not boot.
		// The frame ceiling is generous on purpose (200 ms): it looks for PATHOLOGICAL frames,
		// not slowness.
		const booted = pctWram >= 50;
		const frameHealthy = worstFrameMs < 200;
		if(!booted || !frameHealthy) failures++;
		console.log(game.padEnd(6) + " waits " + String(wait).padStart(4) + " frames"
			+ " -> WRAM " + pctWram.toFixed(0).padStart(3) + "%"
			+ "  worst frame " + String(worstFrameMs).padStart(4) + " ms"
			+ "  (" + seconds + "s)  "
			+ (booted ? (frameHealthy ? "OK" : "OK but ONE PATHOLOGICAL FRAME") : "<<< DID NOT BOOT: it stayed in the BIOS"));
	}
}

console.log("\n" + (failures ? failures + " combination(s) with a problem" : "all of them booted, no pathological frames"));
process.exit(failures ? 1 : 0);
