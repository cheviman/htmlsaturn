// THE INTBACK PROTOCOL, COMPLETE: what the game ASKS FOR and what we ANSWER.
//
// Clears the debt declared in bus.js (`//? the exact polarity and timing are missing
// to model it right`) about the SMPC's SR. A `//?` that admits
// that something is not modeled right, right on the path of an open bug, cannot be let
// slide: either it is confirmed harmless, or it is the cause.
//
// INTBACK is requested by writing IREG0/IREG1/IREG2 and the SMPC answers in SR + OREG0..31:
//   IREG0: 0x01 = fetch the SMPC STATUS (RTC, area, cartridge)
//   IREG1: peripheral data enable (bit 3) + port MODE (bits 1-0):
//          00 = 15 bytes · 01 = 255 bytes · 10 = 0 bytes · 11 = 15 bytes
//   IREG2: 0xF0 fixed
//   SR:    bit7 PDL (first batch) · bit6 NPE (more data remains) · bit5 RESB (reset button)
//          · bits 3-0 the PORT MODES the SMPC returns
// If the game asks for one mode and the SR answers another, a strict parser discards the
// whole report — and then the button never arrives, which is the Virtua Cop symptom.
//
// Usage: node diag/smpc-intback-protocol.mjs [game=vc]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME = process.argv[2] || "vc";
const mod = await import("../headless.mjs?intback=" + GAME);
const { bus, vdp1, vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame(GAME));

const hx2 = (v) => "0x" + (v & 0xFF).toString(16).padStart(2, "0");
const displayOn = () => vdp2.configFromRegisters() !== null;

// Navigate by STATE up to the logo.
let frame = 0, consecutive = 0, ok = false;
for(; frame < 4000 && !ok; frame++){ runFrame(); if(vdp2._r(0x20) === 0x17 && vdp1.commandsDrawn > 400){ if(++consecutive >= 30) ok = true; } else consecutive = 0; }
bus.pad1a = 0xFF & ~0x08; for(let i = 0; i < 10; i++, frame++) runFrame(); bus.pad1a = 0xFF;
consecutive = 0; ok = false;
for(let i = 0; i < 1500 && !ok; i++, frame++){ runFrame(); if(displayOn() && vdp2._r(0x20) === 0x7){ if(++consecutive >= 30) ok = true; } else consecutive = 0; }
if(!ok){ console.log("did not reach the logo"); process.exit(1); }
console.log(GAME + ": logo stable at f" + frame + "\n");

// Spy on the whole protocol: what the game WRITES to the IREGs and to COMREG, and what
// it READS from SR.
const requests = new Map();
const srRead = new Map();
const origWriteByte = bus.writeByte.bind(bus);
bus.writeByte = (addr, value) => {
	const a = addr & 0x07FFFFFF;
	// IREG0..2 are at 0x00100001, 0x00100003, 0x00100005 (SMPC, odd offsets)
	if(a === 0x00100001 || a === 0x00100003 || a === 0x00100005 || a === 0x0010001F)
	{
		const name = a === 0x0010001F ? "COMREG" : "IREG" + ((a - 1) / 2);
		const key = name + "=" + hx2(value);
		requests.set(key, (requests.get(key) || 0) + 1);
	}
	return origWriteByte(addr, value);
};
const origRead = bus.readByte.bind(bus);
bus.readByte = (addr) => {
	const v = origRead(addr);
	if((addr & 0x07FFFFFF) === 0x00100061) srRead.set(hx2(v), (srRead.get(hx2(v)) || 0) + 1);
	return v;
};

bus.pad1a = 0xFF & ~0x08;   // START held
for(let i = 0; i < 180; i++, frame++) runFrame();
bus.pad1a = 0xFF;

console.log("what the game ASKS FOR (writes to the SMPC):");
for(const [k, n] of [...requests.entries()].sort((a, b) => b[1] - a[1]))
	console.log("   " + String(n).padStart(6) + "  " + k);

console.log("\nwhat it READS from SR:");
for(const [k, n] of [...srRead.entries()].sort((a, b) => b[1] - a[1]))
	console.log("   " + String(n).padStart(6) + "  SR=" + k);
if(!srRead.size) console.log("   (it never read SR)");

// The verdict that matters: the MODE it asked for against the one we return.
const ireg1 = [...requests.keys()].filter(k => k.startsWith("IREG1="));
console.log("\nPORT MODE:");
console.log("   requested in IREG1: " + (ireg1.length ? ireg1.join(" ") : "(it never wrote IREG1)"));
console.log("   returned in SR (bits 3-0): " + [...srRead.keys()].map(k => "0x" + (parseInt(k, 16) & 0xF).toString(16)).join(" "));
