// HOW MUCH WOULD AN SH-2 JIT GIVE? The ceiling, measured BEFORE writing it.
//
// The interpreter is 54% of the frame and within that fetch+decode+dispatch weighs ~40%
// (stepsBlock 21.3% + execute 8.8% + readInstr 6.9% + step 3.1%, Rally's V8 profile).
// A JIT attacks exactly that part: it translates a block of instructions into a JS function
// where the opcodes are already resolved, without a loop, without a switch and without fetch.
//
// But "it should give a lot" is not a number. The lesson of 26-07 with the VDP2 was expensive: three
// "obvious" optimizations failed and the real ceiling of that route was 5%. Before investing in a
// JIT we need to know how much it can give AT MOST.
//
// THE EXPERIMENT. A REAL trace of Rally is taken (the opcodes it actually executes, in the
// order it executes them) and it is run in two ways on the SAME state:
//
//   A) through the interpreter's path: readInstr + execute for each instruction
//   B) through a GENERATED JS function that calls the same handlers, already resolved, without fetch
//      and without switch (the floor of what a JIT could achieve without changing the semantics)
//
// B is NOT a JIT: it is its ceiling. A real JIT also has to emit the FRT/WDT ticks and
// handle branches, delay slots and the invalidation of self-modifying code, so it will
// always yield LESS than this. If B does not beat A comfortably, the JIT does not pay off.
//
// Usage: node diag/jit-ceiling.mjs [frames=900] [instructions=200000]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "900", 10);
const NINSTR = parseInt(process.argv[3] || "200000", 10);
const now = () => Number(process.hrtime.bigint()) / 1e6;

const mod = await import("../headless.mjs?jit=1");
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("rally"));
const cpu = bus.cpuMaster;

// --- Real trace: which opcodes the game executes, and from which PC ---
for(let f = 0; f < FRAMES; f++) runFrame();
const pcs = new Int32Array(NINSTR);
const ops = new Uint16Array(NINSTR);
let n = 0;
{
	const orig = cpu.step.bind(cpu);
	cpu.step = () => {
		if(n < NINSTR)
		{
			const pc = cpu.pc >>> 0;
			pcs[n] = pc;
			try { ops[n] = cpu.readInstr(pc) & 0xFFFF; } catch(e) { ops[n] = 0x0009; }
			n++;
		}
		return orig();
	};
	while(n < NINSTR && !cpu.halted) runFrame();
	cpu.step = orig;
}
console.log("real trace of Rally: " + n + " instructions");

// How many DISTINCT opcodes there are: it is what decides whether a JIT can really specialize.
const distinct = new Set();
for(let i = 0; i < n; i++) distinct.add(ops[i]);
console.log("distinct opcodes in the trace: " + distinct.size);

// --- A) the interpreter's path: fetch + dispatch per instruction ---
// ONLY fetch+dispatch is measured (not the prologue of step(), which a JIT has to emit anyway),
// which is exactly the part the JIT eliminates.
function runInterpreter(times)
{
	let acc = 0;
	for(let v = 0; v < times; v++)
		for(let i = 0; i < n; i++)
		{
			const op = cpu.readInstr(pcs[i] >>> 0) & 0xFFFF;   // FETCH
			acc += op;                                          // (use the value: so it does not get eliminated)
		}
	return acc;
}

// --- B) the ceiling: the opcodes ALREADY resolved, without fetch and without switch ---
// The trace is walked reading the opcode from a flat array, which is what a compiled block
// would have "hardwired" in its code. Same useful work, without the fetch and decode machinery.
function runCeiling(times)
{
	let acc = 0;
	for(let v = 0; v < times; v++)
		for(let i = 0; i < n; i++)
			acc += ops[i];
	return acc;
}

// A/B INTERLEAVED and by the MINIMUM, which is this repo's measurement rule (this machine's
// noise is larger than what we are looking for).
let bestA = Infinity, bestB = Infinity;
runInterpreter(1); runCeiling(1);            // warm-up of V8's JIT
for(let r = 0; r < 5; r++)
{
	let t = now(); runInterpreter(3); const a = (now() - t) / 3;
	t = now();     runCeiling(3);      const b = (now() - t) / 3;
	if(a < bestA) bestA = a;
	if(b < bestB) bestB = b;
}

const nsA = bestA * 1e6 / n, nsB = bestB * 1e6 / n;
console.log("");
console.log("  A) fetch per instruction (readInstr):   " + bestA.toFixed(2).padStart(7) + " ms   " + nsA.toFixed(1) + " ns/instr");
console.log("  B) opcode pre-resolved (JIT ceiling):    " + bestB.toFixed(2).padStart(7) + " ms   " + nsB.toFixed(1) + " ns/instr");
console.log("  savings from the fetch ALONE: " + (bestA - bestB).toFixed(2) + " ms every " + n + " instructions   (" +
	(100 - nsB * 100 / nsA).toFixed(0) + "% of that part)");

// How much that is in a real frame: Rally's instructions per frame.
const instrPerFrame = 226085;   // measured with diag/rally-netlink-loop.mjs
const msPerFrame = (bestA - bestB) * instrPerFrame / n;
console.log("");
console.log("  a " + instrPerFrame.toLocaleString("es") + " instructions per frame, the fetch alone costs " +
	msPerFrame.toFixed(2) + " ms/frame");
console.log("  (the V8 profile gives readInstr 6.9% of 16.75 ms = 1.16 ms: if these two numbers");
console.log("   do not resemble each other, the experiment is not measuring what it thinks and must NOT be believed)");
