// WHAT IS THE GAME WAITING FOR? Detects the spin-loop and says WHICH ADDRESS IT POLLS and WHAT
// ITS VALUE IS. It is the headless port of analyzeWait()/cardWait() from the index.html panel,
// which was written precisely because that recipe -"if nobody writes that address, the piece
// that should write it is missing"- solved half a dozen hangs by hand.
//
// It serves for what the other probes do not: "the game does not reach the screen" says nothing,
// but "spins at 0x6010270 reading 0x60391ee, which is 0" says exactly what is missing.
//
// Usage: node diag/what-waits.mjs [game=vc] [frames=2400] [from=600]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "vc";
const FRAMES = parseInt(process.argv[3] || "2400", 10);
const FROM  = parseInt(process.argv[4] || "600", 10);

const mod = await import("../headless.mjs?waits=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const bios = resolveBios({ xmen: "jp" }[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

mod.cpu.tracing = true;
const hx = (v) => "0x" + (v >>> 0).toString(16).padStart(8, "0");

// Where the pointer the loop reads comes from: MOV.L @(disp,PC),Rn = 1101nnnndddddddd loads
// a literal from the pool. The literal is resolved and not the register because the loop itself usually
// overwrites it ("MOV.W @R2,R2" leaves the VALUE in R2, not the address).
function analyze(pcs)
{
	const pointerOf = {};
	for(const addr of pcs)
	{
		const op = bus.readWord(addr) & 0xFFFF;
		if((op & 0xF000) !== 0xD000) continue;
		pointerOf[(op >> 8) & 0xF] = bus.readLong(((addr & ~3) + 4 + (op & 0xFF) * 4) >>> 0) >>> 0;
	}
	// What it reads with that pointer: MOV.B/W/L @Rm,Rn = 0110nnnnmmmm00tt
	const output = [];
	for(const addr of [...pcs].sort((a, b) => a - b))
	{
		const op = bus.readWord(addr) & 0xFFFF;
		if((op & 0xF000) !== 0x6000) continue;
		const size = op & 0xF;
		if(size > 2) continue;
		const m = (op >> 4) & 0xF;
		const p = (pointerOf[m] !== undefined ? pointerOf[m] : mod.cpu.r[m]) >>> 0;
		const val = size === 0 ? bus.readByte(p) : size === 1 ? bus.readWord(p) : bus.readLong(p);
		output.push({ addr: p, reg: m, size, val });
	}
	return output;
}

let lastWarning = -1, warnings = 0;
for(let f = 0; f < FRAMES && !mod.cpu.halted; f++)
{
	runFrame();
	if(f < FROM) continue;

	const c = mod.cpu;
	const hist = [];
	for(let i = 0; i < 16; i++) hist.push(c.histPc[(c.histIdx + i) & 15] >>> 0);
	const unique = [...new Set(hist)];
	// Spinning = the whole history fits in a few instructions and they are close together.
	if(unique.length > 6) continue;
	const range = Math.max(...unique) - Math.min(...unique);
	if(range > 40) continue;

	const key = Math.min(...unique);
	if(key === lastWarning) continue;   // the same loop, do not repeat
	lastWarning = key;
	if(++warnings > 6) break;

	console.log("\nframe " + f + ": spinning at " + hx(key) + ".." + hx(Math.max(...unique))
		+ "  (" + unique.length + " instructions)   PR=" + hx(c.pr) + " SR=" + hx(c.sr));
	const reads = analyze(unique);
	if(!reads.length) console.log("   the loop does not read memory through a pointer (look at the disassembler)");
	for(const e of reads)
		console.log("   reads " + hx(e.addr) + " (R" + e.reg + ") = 0x" + (e.val >>> 0).toString(16)
			+ (e.val === 0 ? "   <- if nobody writes it, whoever should do it is missing" : ""));
}
if(!warnings) console.log(GAME + ": no spin-loop detected between frame " + FROM + " and " + FRAMES);
