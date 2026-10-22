// THE PULSE DETECTOR: which registers a game writes and REVERTS within the same frame.
//
// Sebas (26-07-2026, translated): "I'm a bit against going one by one... with 500 games are we going to
// go through them all?". This generalizes the whole class of bug that just showed up, instead of
// waiting for the next game to show it.
//
// THE PATTERN. Three times already the same mistake: a register that the hardware treats as a TRIGGER
// (something happens on the EDGE of the write) and that we read as a LEVEL (looking at its
// value once per frame, at the close). The three:
//    FBCR (VDP1 0x02)  bank switch        -> fixed, it was the ghosting with FBCR=3 held
//    PTMR (VDP1 0x04)  drawing start      -> fixed, a PTMR=1 followed by PTMR=0 lost the drawing
//    TVMR (VDP1 0x00)  the erase VBE      -> fixed 27-07-2026, it was SF Alpha's trail
//
// And the symptom is always the same: the game writes a value, does its thing, and REVERTS it
// before the frame ends. By the time we go look, the pulse has already passed.
//
// So the detector does not look for known bugs: it looks for the SHAPE. A register that within
// the same frame takes a value and goes back to the previous one is, by definition, a pulse — the game
// set it so the hardware would see it AT THAT MOMENT. If our emulator samples it at
// any other moment, it does not see it.
//
// Not every pulse is a bug, and the difference is in the FINAL VALUE:
//   - TRIGGER: the pulse IS the command. The final value says nothing, because what the hardware
//     had to see has already passed. Missing it loses the command (SF Alpha's VBE: the erase never
//     happened).
//   - RECONFIGURATION: the game clears and writes again within the frame, and the final
//     value is the correct one. Reading it at the close gives the right result. It is NOT a bug.
// The detector cannot decide which is which — that depends on how the hardware treats each register. What it does do is
// mark the ones that already have a hook, and skip the registers that are LEVEL by definition
// (priorities, color ratios): those are read whole at compose time and their pulse is noise.
//
// KNOWN FALSE POSITIVE (27-07-2026): Sonic 3D pulses PRINB (VDP2 0xEA) 5->0->5 in 856 of
// 1800 frames. It is not a trigger: one routine (PC 0x6076c22) clears PRINA and PRINB, and another
// (PC 0x606d68a) reconfigures PRINB. The final value is the good one. That is why PRINA/PRINB/PRINR
// are in LEVELS and the detector no longer reports them.
//
// Usage: node diag/pulses.mjs [game=rally] [frames=1800]
//        node diag/pulses.mjs todos [frames=1800]
import { readFileSync } from "fs";
import { basename } from "path";

const ARG1    = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "1800", 10);
const ALL   = ["rally", "vc", "sfa", "sonic", "xmen", "daytona"];
const GAMES  = ARG1 === "all" ? ALL : [ARG1];
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };
const hx = (v) => "0x" + (v >>> 0).toString(16);

// The registers that already have a trigger hook in bus.js: if they show up, that is fine.
const COVERED = new Set(["VDP1 TVMR", "VDP1 FBCR", "VDP1 PTMR"]);

// Registers that are LEVEL by definition: they are read whole at compose time, so
// a pulse inside the frame loses nothing as long as the final value is the good one.
const LEVELS = new Set(["VDP2 PRINA", "VDP2 PRINB", "VDP2 PRIR",
	"VDP2 PRISA", "VDP2 PRISB", "VDP2 PRISC", "VDP2 PRISD"]);

// Name of each register, so the report says something and not just an offset.
const VDP1 = { 0x00: "TVMR", 0x02: "FBCR", 0x04: "PTMR", 0x06: "EWDR", 0x08: "EWLR",
	0x0A: "EWRR", 0x0C: "ENDR" };
const VDP2 = { 0x00: "TVMD", 0x02: "EXTEN", 0x06: "VRSIZE", 0x08: "HCNT", 0x0A: "VCNT",
	0x0E: "RAMCTL", 0x20: "BGON", 0x22: "MZCTL", 0x24: "SFSEL", 0x26: "SFCODE",
	0x28: "CHCTLA", 0x2A: "CHCTLB", 0xE0: "PRISA", 0xE2: "PRISB", 0xE4: "PRISC",
	0xE6: "PRISD", 0xE8: "PRINA", 0xEA: "PRINB", 0xEC: "PRIR",
	0xF8: "CCRSA", 0xFC: "CCRSC" };

function name(zone, off)
{
	if(zone === "VDP1") return "VDP1 " + (VDP1[off] || hx(off));
	if(zone === "VDP2") return "VDP2 " + (VDP2[off] || hx(off));
	return zone + " " + hx(off);
}

for(const game of GAMES)
{
	let mod;
	try
	{
		mod = await import("../headless.mjs?pul=" + game);
		const b = mod.resolveBios(BIOS_PER_GAME[game] || "us");
		mod.applyBios(basename(b), new Uint8Array(readFileSync(b)));
		mod.loadDiscFromCue(mod.resolveGame(game));
	}
	catch(e){ console.log(game.toUpperCase() + " -> could not mount: " + e.message); continue; }
	const { bus, runFrame } = mod;

	// Per register: the value the frame started with, the sequence of values it took
	// within the frame, and the count of frames in which it went back to the starting value.
	const toBoot = new Map();     // key -> value at the start of the frame
	const inFrame = new Map();     // key -> [values written in this frame]
	const pulses = new Map();         // key -> { frames, example: [values] }
	let frame = 0;

	const note = (key, value) => {
		if(!inFrame.has(key)) inFrame.set(key, []);
		const l = inFrame.get(key);
		if(l.length < 12) l.push(value >>> 0);
	};

	for(const fn of ["writeWord", "writeLong", "writeByte"])
	{
		const orig = bus[fn].bind(bus);
		bus[fn] = (a, v) => {
			const d = (a >>> 0) & 0x07FFFFFF;
			if(d >= 0x05D00000 && d < 0x05D00020)      note(name("VDP1", d & 0x1E), v);
			else if(d >= 0x05F80000 && d < 0x05F80120) note(name("VDP2", d & 0x1FE), v);
			return orig(a, v);
		};
	}

	for(; frame < FRAMES; frame++)
	{
		runFrame();
		// Close of the frame: a register pulsed if it took a value different from the starting one and
		// AFTERWARDS went back to the starting one, all within this same frame.
		for(const [key, values] of inFrame)
		{
			const start = toBoot.has(key) ? toBoot.get(key) : values[0];
			const end = values[values.length - 1];
			const had = values.some((v) => v !== start);
			if(had && end === start)
			{
				if(!pulses.has(key)) pulses.set(key, { frames: 0, example: values.slice(0, 6) });
				pulses.get(key).frames++;
			}
			toBoot.set(key, end);
		}
		inFrame.clear();
	}

	console.log("");
	console.log(game.toUpperCase() + " — registers that are written and REVERTED within the same frame");
	console.log("  (" + FRAMES + " frames)");
	console.log("");
	const order = [...pulses.entries()].filter(([c]) => !LEVELS.has(c))
		.sort((a, b) => b[1].frames - a[1].frames);
	if(!order.length){ console.log("   none."); continue; }
	console.log("   register       frames    typical sequence          status");
	for(const [key, d] of order.slice(0, 14))
	{
		const covered = COVERED.has(key);
		console.log("   " + key.padEnd(14) + " " + String(d.frames).padStart(6) + "   " +
			d.example.map(hx).join(" ").padEnd(24) + "  " +
			(covered ? "has a trigger hook" : "NO HOOK <- suspicious"));
	}
	const noHook = order.filter(([c]) => !COVERED.has(c));
	console.log("");
	console.log(noHook.length
		? ("   => " + noHook.length + " register(s) pulse without a trigger hook. Each one is a request from the\n" +
		   "      game that our sampling at the close of the frame may not be seeing. Before\n" +
		   "      touching anything, check whether the hardware defines an edge for that register.")
		: "   => all the pulses are covered by a trigger hook.");
}
