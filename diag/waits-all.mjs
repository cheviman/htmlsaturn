// ALL THE WAITS OF ALL THE GAMES, GROUPED BY CAUSE.
//
// Asked by Sebas (26-07-2026, translated): "I'm a bit against going one by one... with 500 games
// are we going to go through them all?". He is right: fixing game by game is not a strategy, and it also
// hides that many broken boots are THE SAME bug under a different name. The proof already
// exists: making the CD command take ~333 us moved four games at once.
//
// This does NOT reimplement anything: it runs diag/what-waits.mjs -which already detects the spin-loop and says
// which address it polls and what its value is- over all the discs, and groups its output by CHIP.
// The question it answers is not "what is wrong with this game" but:
//
//     WHICH CHIP IS MISSING A TRANSITION, AND HOW MANY GAMES ARE WAITING FOR IT?
//
// A chip that shows up in several games is a missing piece of the model, and fixing it
// moves all of them -including the 500 we have not tried yet-. A chip that shows up in only one
// is, that one yes, a particular case.
//
// Usage: node diag/waits-all.mjs [frames=1200] [from=600]
import { execFileSync } from "child_process";

const FRAMES = process.argv[2] || "1200";
const FROM  = process.argv[3] || "600";
const GAMES = ["rally", "vc", "sfa", "sonic", "xmen", "daytona", "daycce", "touring", "vf2", "xmenvs"];

// Same memory map the rest of the project uses.
function chipOf(a)
{
	const f = a & 0x07FFFFFF;
	if(f < 0x00100000)                    return "BIOS";
	if(f >= 0x00100000 && f < 0x00180000) return "SMPC";
	if(f >= 0x00180000 && f < 0x00200000) return "BACKUP-RAM";
	if(f >= 0x00200000 && f < 0x00300000) return "WRAM-low";
	if(f >= 0x01000000 && f < 0x02000000) return "input-capture (doorbell)";
	if(f >= 0x02000000 && f < 0x05000000) return "cartridge";
	if(f >= 0x05890000 && f < 0x058A0000) return ((f & 0x7000) === 0) ? "CD-block" : "A-Bus (NetLink)";
	if(f >= 0x05800000 && f < 0x05900000) return "A-Bus";
	if(f >= 0x05A00000 && f < 0x05B00000) return "Sound RAM (68k driver)";
	if(f >= 0x05B00000 && f < 0x05C00000) return "SCSP";
	if(f >= 0x05C00000 && f < 0x05D00000) return "VDP1";
	if(f >= 0x05D00000 && f < 0x05E00000) return "VDP1-regs";
	if(f >= 0x05E00000 && f < 0x05F80000) return "VDP2";
	if(f >= 0x05F80000 && f < 0x05FE0000) return "VDP2-regs";
	if(f >= 0x05FE0000 && f < 0x06000000) return "SCU-regs";
	if(f >= 0x06000000)                   return "WRAM-high (game flag)";
	return "?";
}

const perChip = new Map();   // chip -> Map(game -> Set(addresses))
const perGame = new Map();  // game -> number of distinct waits

for(const game of GAMES)
{
	let output = "";
	try
	{
		output = execFileSync(process.execPath,
			["diag/what-waits.mjs", game, FRAMES, FROM],
			{ encoding: "utf8", maxBuffer: 1 << 26, timeout: 20 * 60 * 1000 });
	}
	catch(e){ output = (e.stdout || "") + ""; }

	// The probe's lines: "   reads 0x25a03c2a (R3) = 0x0   <- if nobody writes it..." ("reads" is matched below)
	const addrs = new Set();
	for(const m of output.matchAll(/reads (0x[0-9a-f]+) \([^)]*\) = (0x[0-9a-f]+)/g))
		addrs.add(m[1] + "=" + m[2]);
	perGame.set(game, addrs.size);

	for(const d of addrs)
	{
		const addr = parseInt(d.split("=")[0], 16) >>> 0;
		const chip = chipOf(addr);
		if(!perChip.has(chip)) perChip.set(chip, new Map());
		const m = perChip.get(chip);
		if(!m.has(game)) m.set(game, new Set());
		m.get(game).add(d);
	}
	console.log(game.padEnd(9) + String(addrs.size).padStart(3) + " distinct waits   " +
		[...addrs].slice(0, 3).join("  "));
}

console.log("");
console.log("=======================================================================");
console.log("  WHICH CHIP IS MISSING THE TRANSITION, AND HOW MANY GAMES ARE WAITING FOR IT");
console.log("=======================================================================");
const rows = [...perChip.entries()].sort((a, b) => b[1].size - a[1].size);
for(const [chip, m] of rows)
{
	let addrs = 0;
	for(const s of m.values()) addrs += s.size;
	console.log("");
	console.log("  " + chip + "   -> " + m.size + " game(s), " + addrs + " address(es)");
	for(const [game, s] of m)
		console.log("      " + game.padEnd(9) + [...s].join("  "));
}
console.log("");
console.log("  READING: a chip with SEVERAL games is a missing piece of the model that,");
console.log("  fixed once, moves all of them (and the ones we have not tried). One with a");
console.log("  single game is a particular case and goes later.");
