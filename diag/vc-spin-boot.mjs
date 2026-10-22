// The VC boot (with the faithful SR) gets stuck in a 4-PC spin at 0x60011f8-0x6001200.
// Dump of the code + spy on which address that spin reads and what value it sees.
import { readFileSync } from "fs";
import { basename } from "path";
import { bus, cpu, cpuSlave, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "../headless.mjs";

const hx = (v, p) => "0x" + (v >>> 0).toString(16).padStart(p || 1, "0");
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("Virtua Cop (USA) (7S)"));
for(let f = 0; f < 500; f++) runFrame();

let line = "";
console.log("spin code:");
for(let a = 0x060011E0; a < 0x06001210; a += 2)
{
	if((a & 0xF) === 0 || line === "") { if(line) console.log(line); line = hx(a, 8) + ": "; }
	line += (bus.readWord(a) >>> 0).toString(16).padStart(4, "0") + " ";
}
if(line) console.log(line);

const reads = new Map();
let isMaster = false;
for(const fn of ["readByte", "readWord", "readLong"])
{
	const orig = bus[fn].bind(bus);
	bus[fn] = (d) => {
		const v = orig(d);
		if(isMaster)
		{
			const a = d & 0x07FFFFFF;
			if(a < 0x060011E0 || a > 0x06001210)   // without the spin's own fetch
			{
				const e = reads.get(a) || { times: 0, value: 0 };
				e.times++; e.value = v; reads.set(a, e);
			}
		}
		return v;
	};
}
const oM = cpu.step.bind(cpu);
cpu.step = function() { const pc = cpu.pc >>> 0; isMaster = (pc >= 0x060011E0 && pc <= 0x06001210); return oM(); };
const oS = cpuSlave.step.bind(cpuSlave);
cpuSlave.step = function() { isMaster = false; return oS(); };
for(let f = 0; f < 60; f++) runFrame();
console.log("spin reads:");
for(const [a, e] of [...reads.entries()].sort((x, y) => y[1].times - x[1].times).slice(0, 6))
	console.log("  " + hx(a) + " x" + e.times + " value=" + hx(e.value));
