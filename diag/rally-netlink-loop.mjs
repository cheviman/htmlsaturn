// HOW MUCH DOES THE LOOP OF THE NON-EXISTENT NETLINK MODEM COST RALLY?
//
// diag/rally-582503d.mjs already said WHO: the master, from 0x6051d44/0x6051e54/0x6051e5a,
// bit-banging a 16550 (writes 0xff/0x0 to 0x0582503d = line toggle, and 0x5a/0x22 to
// 0x0589501d = the UART's Scratch register) and always reading 0x0 because there is no modem connected.
//
// What is missing is the actionable part: HOW MUCH of the frame goes there. A wait loop against an absent
// device is CPU time the game does not use for the game, and this one makes 12,300 bus
// accesses per frame. It is measured in two independent ways:
//
//   1. how many INSTRUCTIONS per frame fall in the loop's PC range
//   2. how many SH-2 CYCLES are charged there
//
// And the loop is disassembled, to know whether it is a bounded wait (it exits by itself) or an infinite one.
//
// Usage: node diag/rally-netlink-loop.mjs [frames=1200]
import { readFileSync } from "fs";
import { basename } from "path";
import { bus, cpu, runFrame, applyBios, loadDiscFromCue,
         resolveBios, resolveGame } from "../headless.mjs";

const FRAMES = parseInt(process.argv[2] || "1200", 10);
const hx = (v) => "0x" + (v >>> 0).toString(16);

applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("rally"));

// The loop's range comes from the PCs that write to the A-Bus (previous probe). It is taken with
// slack: the whole routine, not just the three instructions that write.
const LOOP_START = 0x6051d00, LOOP_END = 0x6051f00;

// EXPERIMENT (BUS=ff): make the A-Bus area WITHOUT a device read as all ones instead
// of as zero. On the hardware, a bus with nothing connected stays high because of the pull-ups and
// reads 0xFF; today bus.js:3883 returns 0. If the modem scan switches off with this, the 12.7%
// of cycles it eats is an ARTIFACT of what we answer it, not fidelity.
// It is patched from outside so as not to touch bus.js until the result is known.
// The counter is part of the experiment, not decoration: if it comes out 0, the patch was not applied and the
// A/B compares nothing (two identical runs would read as "the change makes no difference"
// when in reality the change never happened). It is RULE 0 of the document.
let intercepted = 0;
if(process.env.BUS === "ff")
{
	const orig = bus._mmioRead.bind(bus);
	bus._mmioRead = (a, size) => {
		const f = a & 0x07FFFFFF;
		// Only the A-Bus cartridge area that the CD block does NOT decode.
		if(f >= 0x05890000 && f < 0x058A0000 && !globalThis.Bus._cdDecodes(f))
		{
			intercepted++;
			return size === 1 ? 0xFF : (size === 2 ? 0xFFFF : 0xFFFFFFFF);
		}
		return orig(a, size);
	};
}

let instrTotal = 0, instrLoop = 0, cyclesTotal = 0, cyclesLoop = 0;
const origStep = cpu.step.bind(cpu);
cpu.step = () => {
	const pc = cpu.pc >>> 0;
	const c0 = cpu.cycles;
	const r = origStep();
	const d = cpu.cycles - c0;
	instrTotal++; cyclesTotal += d;
	if(pc >= LOOP_START && pc < LOOP_END){ instrLoop++; cyclesLoop += d; }
	return r;
};

// BY STAGES, NOT AN AVERAGE. With 1200 frames the loop gave 12.7% and with 900 it gave 17.6%: the
// average depends on where it is cut, which is exactly the measurement trap the document already
// has written down. What matters is whether the loop is still alive DURING THE RACE, which is where the
// game needs the CPU. It navigates with input, same as diag/rally-effects.mjs.
const START = 0x08, A = 0x04, UP = 0x10;
console.log("SEGA RALLY — weight of the NetLink modem loop, per stage" +
	(process.env.BUS === "ff" ? "   [empty A-Bus reading 0xFF]" : "   [empty A-Bus reading 0x00, as today]"));
console.log("");
console.log("   stage                    instr/frame    %instr   cycles/frame    %cycles");
let f = 0;
function stage(name, frames, run)
{
	instrTotal = instrLoop = cyclesTotal = cyclesLoop = 0;
	run();
	console.log("   " + name.padEnd(24) +
		(instrLoop / frames).toFixed(0).padStart(9) + "   " +
		(instrTotal ? (instrLoop * 100 / instrTotal).toFixed(1) : "0").padStart(6) + "%   " +
		(cyclesLoop / frames).toFixed(0).padStart(11) + "   " +
		(cyclesTotal ? (cyclesLoop * 100 / cyclesTotal).toFixed(1) : "0").padStart(6) + "%");
}
stage("1. boot", 600, () => { for(let i = 0; i < 600; i++, f++) runFrame(); });
stage("2. menu (Start x60)", 1800, () => {
	for(let k = 0; k < 60; k++){
		bus.pad1a = 0xFF & ~START; for(let i = 0; i < 6; i++, f++) runFrame();
		bus.pad1a = 0xFF;          for(let i = 0; i < 24; i++, f++) runFrame();
	}
});
stage("3. RACE (accelerating)", 600, () => {
	bus.pad1a = 0xFF & ~(A | UP);
	for(let i = 0; i < 600; i++, f++) runFrame();
	bus.pad1a = 0xFF;
});
console.log("");
console.log("  reads to the empty A-Bus intercepted: " + intercepted +
	(process.env.BUS === "ff" && intercepted === 0 ? "   <<< THE PATCH WAS NOT APPLIED, the comparison is not valid" : ""));

// The code, to know what shape the wait has. disassemble() comes from disasm.js, which
// headless.mjs already loads as a global.
console.log("");
console.log("  the loop, disassembled:");
for(let a = 0x6051d34; a < 0x6051d60; a += 2)
{
	let op = 0;
	try { op = bus.readWord(a) & 0xFFFF; } catch(e){ break; }
	let txt = "?";
	try { txt = globalThis.disassemble ? globalThis.disassemble(op, a) : "?"; } catch(e){}
	console.log("    " + hx(a) + "  " + op.toString(16).padStart(4, "0") + "  " + txt);
}
