/**
 *    Name:         smpc-commands.mjs
 *    Description:  Inventory of SMPC commands per game: which ones each game issues, how many
 *                  times, and how long they would take with the hardware's per-command execution
 *                  times against the single value we give today.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// The hardware has an execution time PER COMMAND (30 us the class B ones, 40 us
// CDON/CDOFF and SETSMEM, 70 us SETTIME, 100 ms+alpha SYSRES/CKCHG) and we give 2,000 cycles
// (~75 us) to ALL of them. Before changing that we need to know WHICH COMMANDS ARE ACTUALLY USED: a
// change in SMPC timing touches the 10 games, and the ones that jump from 75 us to 100 ms do so
// by three orders of magnitude.
//
// THE CONTROL (Rule 0): the 10 games are run, not the suspect. A command that shows up in
// only one belongs to that game; one that shows up in all of them belongs to the BIOS boot. And the
// TOTAL of commands is reported: if it came out 0 the probe is badly hooked, because the BIOS always
// boots with MSHON/SNDON.
//
// Usage: node diag/smpc-commands.mjs [games] [frames]

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

// The command table: name and declared execution time.
const CMDS = {
	0x00: ["MSHON",    "30u"],  0x02: ["SSHON",    "30u"],  0x03: ["SSHOFF",   "30u"],
	0x06: ["SNDON",    "30u"],  0x07: ["SNDOFF",   "30u"],  0x08: ["CDON",     "40u"],
	0x09: ["CDOFF",    "40u"],  0x0D: ["SYSRES",   "100m"], 0x0E: ["CKCHG352", "100m"],
	0x0F: ["CKCHG320", "100m"], 0x10: ["INTBACK",  "320?"], 0x16: ["SETTIME",  "70u"],
	0x17: ["SETSMEM",  "40u"],  0x18: ["NMIREQ",   "30u"],  0x19: ["RESENAB",  "30u"],
	0x1A: ["RESDISA",  "30u"]
};

const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAMES = (process.argv[2] || "rally,vc,sfa,sonic,xmen,touring,daycce,daytona,vf2,xmenvs").split(",");
	const FRAMES = process.argv[3] || "2000";
	const yo = fileURLToPath(import.meta.url);
	console.log("SMPC COMMANDS PER GAME — " + FRAMES + " cuadros\n");
	console.log("game       total   detail (command xtimes)");
	const global = new Map();
	for(const j of GAMES)
	{
		const r = spawnSync(process.execPath, [yo, j, FRAMES, "--child"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		const out = (r.stdout || "").trim();
		process.stdout.write(out ? out + "\n" : "  " + j + " -> failed: " + (r.stderr || "").split("\n")[0] + "\n");
		for(const p of out.split("|").slice(1))
		{
			const [c, n] = p.split(":");
			if(c) global.set(parseInt(c, 10), (global.get(parseInt(c, 10)) || 0) + parseInt(n, 10));
		}
	}

	console.log("\n=== WHAT DECIDES THE RISK: the ones that would jump from ~75 us to 100 ms ===");
	let danger = 0;
	for(const [c, n] of [...global.entries()].sort((a, b) => b[1] - a[1]))
	{
		const d = CMDS[c] || ["?", "?"];
		if(d[1] === "100m"){ console.log("  ⚠ " + d[0] + " (" + hx(c) + "): " + n + " times in total"); danger += n; }
	}
	if(!danger) console.log("  none: NO game issues SYSRES or CKCHG. The change cannot introduce a 100 ms jump.");

	console.log("\n=== CONTROL: total commands seen ===");
	const tot = [...global.values()].reduce((a, b) => a + b, 0);
	console.log("  " + tot + (tot ? "" : "   ⚠ ZERO: the probe is badly hooked, the BIOS always boots with MSHON/SNDON"));
	console.log("\n  all of them, by frequency:");
	for(const [c, n] of [...global.entries()].sort((a, b) => b[1] - a[1]))
		console.log("     " + ((CMDS[c] || ["?"])[0]).padEnd(10) + hx(c) + "   " + String(n).padStart(7)
			+ "   declared time: " + (CMDS[c] || ["", "?"])[1]);
	process.exit(0);
}

function hx(v){ return "0x" + (v >>> 0).toString(16).padStart(2, "0"); }

// ---------------- child ----------------
const GAME  = process.argv[2];
const FRAMES = parseInt(process.argv[3], 10);
const mod = await import("../headless.mjs?sc=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

const count = new Map();
// For the commands that are NOT in the command table, the PC that wrote them is kept: without it, an
// unknown command is a loose number and we cannot decide whether it is a missing piece or whether
// the game is writing garbage into COMREG.
const unknown = new Map();
const origWriteByte = bus.writeByte.bind(bus);
bus.writeByte = function(a, v){
	if((a >>> 0) === 0x2010001F)
	{
		const c = v & 0xFF;
		count.set(c, (count.get(c) || 0) + 1);
		if(!CMDS[c])
		{
			const pc = bus.cpuMaster ? (bus.cpuMaster.pc - 4) >>> 0 : 0;
			const k = hx(c) + "@0x" + pc.toString(16).padStart(8, "0");
			unknown.set(k, (unknown.get(k) || 0) + 1);
		}
	}
	return origWriteByte(a, v);
};

for(let f = 0; f < FRAMES; f++) runFrame();

const order = [...count.entries()].sort((a, b2) => b2[1] - a[1]);
const tot = [...count.values()].reduce((a, b2) => a + b2, 0);
let line = GAME.padEnd(10) + String(tot).padStart(6) + "   "
	+ order.map(([c, n]) => ((CMDS[c] || ["?" + hx(c)])[0]) + " x" + n).join("  ");
for(const [c, n] of order) line += "|" + c + ":" + n;
if(unknown.size)
	line += "\n" + " ".repeat(10) + "⚠ NOT IN THE COMMAND TABLE: "
		+ [...unknown.entries()].map(([k, n]) => k + " x" + n).join("  ");
console.log(line);
