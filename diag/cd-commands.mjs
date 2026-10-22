// CD MODULE INVENTORY: which commands exist, which ones we implement and which ones
// real games ask for.
//
// The goal is not to guess what is missing. The list on the left is the CD block's full command
// set (the 4 groups: system, drive, selector/partitions, filesystem, MPEG and
// authentication). Against that we cross-check:
//   - which `case`s are in bus.js  -> what is implemented
//   - what each game asks for      -> what matters
//
// Usage: node diag/cd-commands.mjs [frames=1800]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "1800", 10);

// The COMPLETE command list. group = to group the output.
const CMDS = [
	[0x00, "GetCdStatus",              "system"],
	[0x01, "GetHardwareInfo",          "system"],
	[0x02, "GetToc",                   "system"],
	[0x03, "GetSessionInfo",           "system"],
	[0x04, "InitializeCdSystem",       "system"],
	[0x05, "OpenTray",                 "system"],
	[0x06, "EndDataTransfer",          "system"],
	[0x10, "PlayDisc",                 "reader"],
	[0x11, "SeekDisc",                 "reader"],
	[0x12, "ScanDisc",                 "reader"],
	[0x20, "GetSubcodeQ_RW",           "reader"],
	[0x30, "SetCdDeviceConnection",    "selector"],
	[0x31, "GetCdDeviceConnection",    "selector"],
	[0x32, "GetLastBufferDest",        "selector"],
	[0x40, "SetFilterRange",           "selector"],
	[0x41, "GetFilterRange",           "selector"],
	[0x42, "SetFilterSubheader",       "selector"],
	[0x43, "GetFilterSubheader",       "selector"],
	[0x44, "SetFilterMode",            "selector"],
	[0x45, "GetFilterMode",            "selector"],
	[0x46, "SetFilterConnection",      "selector"],
	[0x47, "GetFilterConnection",      "selector"],
	[0x48, "ResetSelector",            "selector"],
	[0x50, "GetBufferSize",            "buffer"],
	[0x51, "GetSectorNumber",          "buffer"],
	[0x52, "CalculateActualSize",      "buffer"],
	[0x53, "GetActualSize",            "buffer"],
	[0x54, "GetSectorInfo",            "buffer"],
	[0x55, "ExecFadSearch",            "buffer"],
	[0x56, "GetFadSearchResults",      "buffer"],
	[0x60, "SetSectorLength",          "data"],
	[0x61, "GetSectorData",            "data"],
	[0x62, "DeleteSectorData",         "data"],
	[0x63, "GetThenDeleteSectorData",  "data"],
	[0x64, "PutSectorData",            "data"],
	[0x65, "CopySectorData",           "data"],
	[0x66, "MoveSectorData",           "data"],
	[0x67, "GetCopyError",             "data"],
	[0x70, "ChangeDirectory",          "filesystem"],
	[0x71, "ReadDirectory",            "filesystem"],
	[0x72, "GetFileSystemScope",       "filesystem"],
	[0x73, "GetFileInfo",              "filesystem"],
	[0x74, "ReadFile",                 "filesystem"],
	[0x75, "AbortFile",                "filesystem"],
	[0x90, "MpegGetStatus",            "mpeg"],
	[0x91, "MpegGetInterrupt",         "mpeg"],
	[0x92, "MpegSetInterruptMask",     "mpeg"],
	[0x93, "MpegInit",                 "mpeg"],
	[0x94, "MpegSetMode",              "mpeg"],
	[0x95, "MpegPlay",                 "mpeg"],
	[0x96, "MpegSetDecodingMethod",    "mpeg"],
	[0x9A, "MpegSetConnection",        "mpeg"],
	[0x9B, "MpegGetConnection",        "mpeg"],
	[0x9D, "MpegSetStream",            "mpeg"],
	[0x9E, "MpegGetStream",            "mpeg"],
	[0xA0, "MpegDisplay",              "mpeg"],
	[0xA1, "MpegSetWindow",            "mpeg"],
	[0xA2, "MpegSetBorderColor",       "mpeg"],
	[0xA3, "MpegSetFade",              "mpeg"],
	[0xA4, "MpegSetVideoEffects",      "mpeg"],
	[0xAF, "MpegSetLSI",               "mpeg"],
	[0xE0, "AuthenticateDevice",       "auth"],
	[0xE1, "IsDeviceAuthenticated",    "auth"],
	[0xE2, "GetMpegRom",               "auth"],
];

// --- What is implemented: bus.js itself is read, not a hand-made list ---
const source = readFileSync(new URL("../bus.js", import.meta.url), "utf-8");
// The command switch lives inside _cdCommand. It is scoped to that function so as not to swallow
// the `case`s of the SMPC or of any other switch.
const since = source.indexOf("_cdCommand(");
const until = source.indexOf("scspRead(", since);
const body = source.slice(since, until);
const implemented = new Set();
for(const m of body.matchAll(/case 0x([0-9A-Fa-f]{2}):/g)) implemented.add(parseInt(m[1], 16));

// --- What each game asks for ---
const GAMES = ["rally", "vc", "sfa", "sonic", "xmen", "touring", "daycce", "daytona", "vf2"];
const requestedBy = new Map();   // cmd -> Map(game -> times)

for(const game of GAMES)
{
	let mod;
	try { mod = await import("../headless.mjs?cdcmds=" + game); }
	catch(e){ console.log("  (" + game + ": could not load) " + e.message); continue; }
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
	try
	{
		applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log("  (" + game + ": " + e.message + ")"); continue; }

	// The REAL dispatch is hooked, which is where the CRs are already resolved: that way the
	// command is counted as the CD block executes it, not as it was left written in the registers.
	const orig = bus._cdCommand.bind(bus);
	bus._cdCommand = () => {
		const cmd = (bus._readRegBE(bus.cdRegs, 0x18, 2) >> 8) & 0xFF;
		let m = requestedBy.get(cmd);
		if(!m) requestedBy.set(cmd, m = new Map());
		m.set(game, (m.get(game) || 0) + 1);
		return orig();
	};

	// With START pressed every so often: several games do not ask for anything new until they start.
	for(let f = 0; f < FRAMES; f++)
	{
		if(f > 600 && (f % 90) < 5) bus.pad1a = 0xFF & ~0x08; else bus.pad1a = 0xFF;
		try { runFrame(); } catch(e){ break; }
	}
}

// --- Output ---
const nameOf = new Map(CMDS.map(([c, n]) => [c, n]));
const grp = new Map(CMDS.map(([c, , g]) => [c, g]));
const known = new Set(CMDS.map(([c]) => c));

console.log("\n" + "=".repeat(78));
console.log("CD MODULE — inventory against the CD block's command list");
console.log("=".repeat(78));

let nImpl = 0, nMissing = 0, nMissingUsed = 0;
let grpPrev = "";
for(const [cmd, name, group] of CMDS)
{
	const has  = implemented.has(cmd);
	const uses = requestedBy.get(cmd);
	if(has) nImpl++; else { nMissing++; if(uses) nMissingUsed++; }
	if(group !== grpPrev){ console.log("\n--- " + group + " ---"); grpPrev = group; }
	const mark = has ? "[x]" : (uses ? "[!]" : "[ ]");
	const quien = uses ? [...uses.entries()].sort((a,b)=>b[1]-a[1]).map(([j,n]) => j+":"+n).join(" ") : "";
	console.log("  " + mark + " 0x" + cmd.toString(16).padStart(2,"0").toUpperCase()
		+ "  " + name.padEnd(24) + (quien || (has ? "" : "-")));
}

// Commands that games ask for and that are NOT even in the CD block's command list: either I am
// missing a command from the list, or the game sent garbage.
const outsideOfList = [...requestedBy.keys()].filter(c => !known.has(c));
if(outsideOfList.length)
{
	console.log("\n--- OUTSIDE THE COMMAND LIST (check) ---");
	for(const c of outsideOfList.sort((a,b)=>a-b))
		console.log("  [?] 0x" + c.toString(16).padStart(2,"0").toUpperCase() + "  "
			+ [...requestedBy.get(c).entries()].map(([j,n]) => j+":"+n).join(" "));
}

console.log("\n" + "-".repeat(78));
console.log("implemented: " + nImpl + "/" + CMDS.length
	+ "   missing: " + nMissing + "   of those, REQUESTED by some game: " + nMissingUsed
	+ (nMissingUsed ? "   <<< these are the ones that matter" : ""));
console.log("[x] implemented   [!] MISSING and requested   [ ] missing and nobody asked for it");
