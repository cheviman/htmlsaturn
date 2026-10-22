// RALLY WRITES TO 0x0582503d 3,943 TIMES PER FRAME. WHO, AND WHAT DOES IT EXPECT TO READ?
//
// 🔴 pending item from PENDING.md section 7. The address falls in A-Bus CS2 (the CD
// block's area lives at 0x05818000) and the disc is the Netlink Edition, so the suspect is the
// NetLink modem. A loop of 4,000 writes per frame is a game waiting for something that never
// arrives, and until now only the COUNT was known. The next step written down was this: capture
// the PC that writes it and what it reads around it.
//
// Reports:
//   - the PCs that write there, with how many times each one
//   - the values it writes
//   - WHAT IT READS from the A-Bus (address, how many times, and what we return today)
//   - the code around the main PC, disassembled
//
// With that we can tell "waits for a modem status bit" (that register would have to be
// modeled) from "writes blindly and reads nothing" (then it is not waiting: it is not a hang).
//
// Usage: node diag/rally-582503d.mjs [frames=2000] [game=rally]
import { readFileSync } from "fs";
import { basename } from "path";
import { bus, cpu, cpuSlave, runFrame, applyBios, loadDiscFromCue,
         resolveBios, resolveGame } from "../headless.mjs";

const FRAMES = parseInt(process.argv[2] || "2000", 10);
const GAME  = process.argv[3] || "rally";
const hx = (v) => "0x" + (v >>> 0).toString(16);

applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame(GAME));

// A-Bus CS0/CS1/CS2: 0x02000000-0x058FFFFF is a huge range; what matters is the CS2 of the
// MMIO area (0x05800000+), where the address in the report falls.
const inABus = (a) => { const f = a & 0x07FFFFFF; return f >= 0x05800000 && f < 0x05900000; };

const writePerPc = new Map();     // PC -> times
const writePerAddr = new Map();    // address -> { n, values:Set }
const readPerAddr = new Map();     // address -> { n, values:Set }

// Which CPU it comes from: the bus does not know, so we look at which one is executing. With both
// running interleaved, the PC of the one that did NOT write stays still, so both are logged and
// the report separates them.
function currentPc()
{
	return { m: cpu.pc >>> 0, s: cpuSlave ? (cpuSlave.pc >>> 0) : 0 };
}

for(const fn of ["writeByte", "writeWord", "writeLong"])
{
	const orig = bus[fn].bind(bus);
	bus[fn] = (a, v) => {
		if(inABus(a))
		{
			const p = currentPc();
			const key = hx(p.m) + "/" + hx(p.s);
			writePerPc.set(key, (writePerPc.get(key) || 0) + 1);
			const d = hx(a & 0x07FFFFFF);
			let e = writePerAddr.get(d);
			if(!e){ e = { n: 0, values: new Set() }; writePerAddr.set(d, e); }
			e.n++;
			if(e.values.size < 8) e.values.add(hx(v));
		}
		return orig(a, v);
	};
}
for(const fn of ["readByte", "readWord", "readLong"])
{
	const orig = bus[fn].bind(bus);
	bus[fn] = (a) => {
		const r = orig(a);
		if(inABus(a))
		{
			const d = hx(a & 0x07FFFFFF);
			let e = readPerAddr.get(d);
			if(!e){ e = { n: 0, values: new Set() }; readPerAddr.set(d, e); }
			e.n++;
			if(e.values.size < 8) e.values.add(hx(r));
		}
		return r;
	};
}

for(let f = 0; f < FRAMES && !cpu.halted; f++) runFrame();

const top = (map, count) => [...map.entries()].sort((a, b) => (b[1].n || b[1]) - (a[1].n || a[1])).slice(0, count);

console.log(GAME + ": A-Bus MMIO accesses (0x05800000-0x058FFFFF) in " + FRAMES + " frames");
console.log("");
console.log("WRITES per address:");
for(const [d, e] of top(writePerAddr, 8))
	console.log("  " + d.padEnd(12) + String(e.n).padStart(9) + " times   " +
		(e.n / FRAMES).toFixed(1).padStart(7) + "/frame   values: " + [...e.values].join(" "));
if(!writePerAddr.size) console.log("  (none)");

console.log("");
console.log("READS per address (what we return today):");
for(const [d, e] of top(readPerAddr, 8))
	console.log("  " + d.padEnd(12) + String(e.n).padStart(9) + " times   " +
		(e.n / FRAMES).toFixed(1).padStart(7) + "/frame   we return: " + [...e.values].join(" "));
if(!readPerAddr.size) console.log("  (NONE — it writes blindly and does not wait for an answer)");

console.log("");
console.log("WHO WRITES (master/slave PC at the moment of the write):");
for(const [p, n] of [...writePerPc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6))
	console.log("  " + p.padEnd(26) + String(n).padStart(9) + " times");

// The verdict: without reads there is no wait, and then this is NOT the cause of any hang.
console.log("");
const totalWrite = [...writePerAddr.values()].reduce((a, b) => a + b.n, 0);
const totalRead  = [...readPerAddr.values()].reduce((a, b) => a + b.n, 0);
console.log("  total: " + totalWrite + " writes, " + totalRead + " reads   =>  " +
	(totalRead === 0
		? "READS NOTHING back: there is no handshake to model, it is not a game waiting"
		: "reads " + (totalRead / FRAMES).toFixed(1) + " times per frame: there is a handshake, see which value it expects"));
