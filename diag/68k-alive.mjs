// IS THE SOUND 68k STILL ALIVE, OR DID IT DIE AND WE TURNED IT OFF?
//
// Today, on ANY 68000 exception, the orchestration disables it forever
// (`m68k = null`). That turns a recoverable stumble into "no audio for the whole
// session" — and worse: a game that waits for an answer from the sound driver keeps waiting
// forever. On the real hardware the 68k takes the exception through its VECTOR and keeps running.
//
// Sebas (25-07-2026, translated) reported both sides: "Exception23 {num: 3} -> sega rally
// broke" (num 3 = ADDRESS ERROR, word/long access at an odd address) and "virtua cop
// still doesn't start". Virtua Cop, measured with diag/what-waits.mjs, spins reading
// 0x25a03c2a — Sound RAM — that is, waiting for an answer from the driver.
//
// Usage: node diag/68k-alive.mjs [game=vc] [frames=3000]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "vc";
const FRAMES = parseInt(process.argv[3] || "3000", 10);

const mod = await import("../headless.mjs?alive68k=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, get68k } = mod;
const bios = resolveBios({ xmen: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

let frameOn = -1, frameDead = -1, pcsSeen = new Set(), keyOnMax = 0;
for(let f = 0; f < FRAMES && !mod.cpu.halted; f++)
{
	runFrame();
	const k = get68k();
	if(k && frameOn < 0) frameOn = f;
	if(k)
	{
		// WATCH OUT: M68K does not expose .pc (that belongs to the EstyJs core). It is read via cpu.getRegs().
		try{ pcsSeen.add(k.cpu.getRegs().pc >>> 0); }catch(e){}
	}
	else if(frameOn >= 0 && frameDead < 0) frameDead = f;

	const m = bus.scspEngine;
	if(m && m.slots)
	{
		let n = 0;
		for(const s of m.slots) if(s && s.key) n++;
		if(n > keyOnMax) keyOnMax = n;
	}
}

console.log(GAME + ":");
console.log("  68k turned on at frame     " + (frameOn < 0 ? "NEVER (the SMPC did not send SNDON)" : frameOn));
console.log("  68k disabled at            " + (frameDead < 0 ? "it was not disabled" : "frame " + frameDead + "  <<< and from there on it had no audio forever"));
console.log("  distinct driver PCs        " + pcsSeen.size + (pcsSeen.size <= 2 ? "  <<< hung" : ""));
console.log("  SCSP slots with key-on     " + keyOnMax + (keyOnMax === 0 ? "  <<< it never triggered a note" : ""));
