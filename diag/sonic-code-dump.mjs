// Dump of the LIVE code (f4770, before the clear-loop erases it) of: the callers
// (0x0601aa60-0x0601ac20, includes 0x0601aa88, the one on the fatal path), and the helper + the unwind
// function (0x0601b8a0-0x0601bb40). To decode by hand the conditional epilogue that
// pops 25 longs (the abort/longjmp) and the condition that triggers it.
import { readFileSync } from "fs";
import { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "../headless.mjs";
import { basename } from "path";
const hx = (v, p) => "0x" + (v >>> 0).toString(16).padStart(p || 1, "0");
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("sonic"));

for(let f = 0; f < 4770; f++) runFrame();

function dumpState(since, until, title)
{
	console.log("=== " + title + " ===");
	for(let base = since; base < until; base += 16)
	{
		let s = hx(base, 8) + ": ";
		for(let i = 0; i < 16; i += 2) s += (bus.readWord(base + i) >>> 0).toString(16).padStart(4, "0") + " ";
		console.log(s);
	}
}
dumpState(0x0601aa60, 0x0601aad0, "fatal caller 0x0601aa88");
dumpState(0x0601bab0, 0x0601bb20, "unwind function (enters 0x0601bae4, returns 0x0601bafa)");
dumpState(0x0601b8a0, 0x0601b8f0, "helper 0x0601b8d0");
