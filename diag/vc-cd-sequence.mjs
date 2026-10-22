// THE VIRTUA COP CD BLOCK COMMAND SEQUENCE, from START onward.
//
// Where the diagnosis stands (confirmed in Chrome with the worker active): the game gets past
// "PRESS START BUTTON" -it responds to the first PULSE of the button, not to the held level-, the
// screen stays black with 1 VDP1 command, and the CD is left in `pausa` having arrived
// RIGHT at the end of the range it was asked for (fad 2010 == playEnd), with 110 free buffers and
// all its interrupts masked (HIRQ_mask = 0, i.e. it polls HIRQ).
// The game is NOT hung: its main loop keeps running. It simply finished a
// read and does not ask for the next one.
//
// This probe records ALL the commands the game sends to the CD block and the answer
// we give it, to see which is the last one it does not recover from.
//
// Usage: node diag/vc-cd-sequence.mjs [last=40]
import { readFileSync } from "fs";
import { basename } from "path";

const LAST = parseInt(process.argv[2] || "40", 10);

const mod = await import("../headless.mjs?vccdseq=1");
const { bus, vdp1, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("vc"));

const NAME = {
	0x00:"GetCdStatus", 0x01:"GetHardwareInfo", 0x02:"GetToc", 0x03:"GetSessionInfo",
	0x04:"InitializeCd", 0x05:"OpenTray", 0x06:"EndDataTransfer", 0x10:"PlayDisc",
	0x11:"SeekDisc", 0x12:"ScanDisc", 0x20:"GetSubcodeQ", 0x30:"SetCdDeviceConnection",
	0x31:"GetCdDeviceConnection", 0x32:"GetLastBufferDest", 0x40:"SetFilterRange",
	0x41:"GetFilterRange", 0x42:"SetFilterSubheader", 0x43:"GetFilterSubheader",
	0x44:"SetFilterMode", 0x45:"GetFilterMode", 0x46:"SetFilterConnection",
	0x47:"GetFilterConnection", 0x48:"ResetSelector", 0x50:"GetBufferSize",
	0x51:"GetSectorNumber", 0x52:"CalculateActualSize", 0x53:"GetActualSize",
	0x54:"GetSectorInfo", 0x55:"ExecFadSearch", 0x56:"GetFadSearchResults",
	0x60:"SetSectorLength", 0x61:"GetSectorData", 0x62:"DeleteSectorData",
	0x63:"GetThenDeleteSectorData", 0x64:"PutSectorData", 0x65:"CopySectorData",
	0x66:"MoveSectorData", 0x67:"GetCopyError", 0x70:"ChangeDirectory",
	0x71:"ReadDirectory", 0x72:"GetFileSystemScope", 0x73:"GetFileInfo",
	0x74:"ReadFile", 0x75:"AbortFile", 0x93:"MpegInit",
};
const hx4 = (v) => (v >>> 0 & 0xFFFF).toString(16).padStart(4, "0");
const bg = () => vdp2._r(0x20);
const displayOn = () => vdp2.configFromRegisters() !== null;

// Navigate by STATE up to the title.
let frame = 0, sec = 0, ok = false;
for(; frame < 4000 && !ok; frame++){ runFrame(); if(bg() === 0x17 && vdp1.commandsDrawn > 400){ if(++sec >= 30) ok = true; } else sec = 0; }
if(!ok){ console.log("did not reach the title"); process.exit(1); }
console.log("title at f" + frame + " — from here on the CD commands are recorded\n");

// Hook the command dispatch: CR1-CR4 are read BEFORE (the request) and AFTER (the
// answer), which is how the game sees them.
const log = [];
const origCmd = bus._cdCommand.bind(bus);
bus._cdCommand = () => {
	const cr = () => [bus._readRegBE(bus.cdRegs, 0x18, 2), bus._readRegBE(bus.cdRegs, 0x1C, 2),
	                  bus._readRegBE(bus.cdRegs, 0x20, 2), bus._readRegBE(bus.cdRegs, 0x24, 2)];
	const request = cr();
	const cmd = (request[0] >> 8) & 0xFF;
	const r = origCmd();
	const resp = cr();
	log.push({ f: frame, cmd,
		name: NAME[cmd] || "?",
		asks: request.map(hx4).join(" "),
		resp: resp.map(hx4).join(" "),
		phase: bus.cd ? bus.cd.phase : "?",
		hirq: bus.cdHirq >>> 0 });   // CAREFUL: HIRQ lives in bus.cdHirq, NOT in bus.cd.hirq
	return r;
};

// PRESS START (the game responds to the edge, not to the level) and run.
for(let p = 0; p < 60; p++){
	bus.pad1a = 0xFF & ~0x08; for(let i = 0; i < 6; i++, frame++) runFrame();
	bus.pad1a = 0xFF;         for(let i = 0; i < 24; i++, frame++) runFrame();
}
// And then, a long while idle: if the game was going to ask for something else, it asks here.
for(let i = 0; i < 1200; i++, frame++) runFrame();

console.log("total commands: " + log.length + "   the POSITION/READ ones (Play/Seek/Scan/CalcSize/GetData), last " + LAST + ":");
console.log(" frame  cmd  name                   CR1-CR4 request       ->  CR1-CR4 answer        phase");
for(const e of log.filter(e => [0x10,0x11,0x12,0x30,0x40,0x42,0x44,0x46,0x48,0x60].includes(e.cmd)).slice(-LAST))
	console.log(String(e.f).padStart(6) + "  " + ("0x" + e.cmd.toString(16).padStart(2, "0"))
		+ "  " + e.name.padEnd(22) + " " + e.asks + "  ->  " + e.resp + "  " + e.phase);

console.log("\nfinal state: BGON=0x" + bg().toString(16) + "  cmdsVDP1=" + vdp1.commandsDrawn
	+ "  cdFase=" + (bus.cd ? bus.cd.phase : "?") + "  fad=" + (bus.cd ? bus.cd.pos.fad : "?"));
// How many times it asked for each command AFTER START: if the game stopped asking, it shows.
const perCmd = new Map();
for(const e of log) perCmd.set(e.name, (perCmd.get(e.name) || 0) + 1);
console.log("\ncount per command: " + [...perCmd.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v]) => k+":"+v).join("  "));

// HIRQ EVOLUTION. The game has ALL the CD interrupts masked
// (HIRQ_mask = 0), i.e. it POLLS these flags. If the one it waits for never rises -or
// rises and is cleared before it looks- it keeps waiting forever.
const B = { CMOK:0x0001, DRDY:0x0002, CSCT:0x0004, BFUL:0x0008, PENDING:0x0010, DCHG:0x0020,
            ESEL:0x0040, EHST:0x0080, ECPY:0x0100, EFLS:0x0200, SCDQ:0x0400 };
const name = (v) => Object.keys(B).filter(k => v & B[k]).join("|") || "(empty)";
console.log("\nHIRQ, every time it changes:");
let prev = -1, n = 0;
for(const e of log)
{
	if(e.hirq === prev) continue;
	if(++n <= 22) console.log("   f" + String(e.f).padStart(5) + "  after " + e.name.padEnd(18)
		+ " HIRQ=0x" + (e.hirq >>> 0).toString(16).padStart(3, "0") + "  " + name(e.hirq));
	prev = e.hirq;
}
console.log("   (" + n + " changes in total)");
console.log("\nthe PEND flag (end of playback) was seen raised:  "
	+ (log.some(e => e.hirq & B.PENDING) ? "YES" : "NO  <<<"));
console.log("the CSCT flag (a sector arrived) was seen raised: "
	+ (log.some(e => e.hirq & B.CSCT) ? "YES" : "NO  <<<"));
