// Does the mirror (CRMD=0) step on a bank 4-7 that was written earlier in CRMD=1 (the letters)?
import { readFileSync } from "fs";
import { basename } from "path";
import { bus, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "../headless.mjs";
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("rally"));
const write = Array.from({ length: 8 }, () => ({ c0: 0, c1: 0 }));
for(const mm of ["writeByte", "writeWord", "writeLong"])
{
	const orig = bus[mm].bind(bus);
	bus[mm] = (a, v) => {
		const phys = (a >>> 0) & 0x07FFFFFF;
		if(phys >= 0x05F00000 && phys < 0x05F80000)
		{
			const bank = ((phys - 0x05F00000) & 0xFFF) >> 9;
			const crmd = (vdp2._r(0x0e) >> 12) & 3;
			write[bank][crmd === 0 ? "c0" : "c1"]++;
		}
		return orig(a, v);
	};
}
const START = 0x08, A = 0x04, UP = 0x10;
for(let f = 0; f < 600; f++) runFrame();
for(let k = 0; k < 60; k++) { bus.pad1a = 0xFF & ~START; for(let i = 0; i < 6; i++) runFrame(); bus.pad1a = 0xFF; for(let i = 0; i < 24; i++) runFrame(); }
bus.pad1a = 0xFF & ~(A | UP);
for(let i = 0; i < 400; i++) runFrame();
console.log("=== writes to each CRAM bank, per mode ===");
for(let b = 0; b < 8; b++)
{
	const collision = b < 4 && write[b].c0 > 0 && write[b + 4].c1 > 0;
	console.log("  bank " + b + ": mode1024=" + write[b].c0 + " mode2048=" + write[b].c1 + (b >= 4 && write[b].c1 > 0 ? "  (HIGH bank in mode 2048)" : "") + (collision ? "  <-- COLLISION: mode1024 here MIRRORS onto bank " + (b + 4) + " that was written in mode 2048" : ""));
}
