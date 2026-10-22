// Does Virtua Cop get past the START of the title screen? (Report 18-07: it stays there,
// with no sounds.) NAVIGATES BY STATE, not by counted frame (the lesson of tajadas-64):
// waits for the title SIGNATURE (BGON=0x17 with a fat VDP1 list, held 30 frames),
// presses START, waits for the transition blackout, and the verdict is whether the display
// COMES BACK on. With a hang: autopsy (radar, PCs, slave, CD).
// Usage: node diag/vc-start.mjs [gamePath] [biosPath]
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { deflateSync } from "zlib";
import { bus, cpu, cpuSlave, vdp2, vdp1, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "../headless.mjs";

function crc32(buf){ let c = ~0 >>> 0; for(let i = 0; i < buf.length; i++){ c ^= buf[i]; for(let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(t, d){ const l = Buffer.alloc(4); l.writeUInt32BE(d.length >>> 0, 0); const cd = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(cd), 0); return Buffer.concat([l, cd, cr]); }
function png(w, h, rgba){ const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; const raw = Buffer.alloc((w * 4 + 1) * h); for(let y = 0; y < h; y++){ raw[y * (w * 4 + 1)] = 0; for(let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = rgba[y * w * 4 + x]; } return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]); }
function snapshot(name){ const cfg = vdp2.configFromRegisters(); if(!cfg) return false; vdp2.render(cfg); try { vdp1.compose(vdp2.priorities, vdp2.fb, vdp2.shadowOk); } catch(e) {} writeFileSync(name, png(vdp2.width, vdp2.height, vdp2.fb)); return true; }

const hx = (v) => "0x" + (v >>> 0).toString(16);
const gamePath = process.argv[2] || resolveGame("Virtua Cop (USA) (7S)");
const biosPath = process.argv[3] || resolveBios("us");
applyBios(basename(biosPath), new Uint8Array(readFileSync(biosPath)));
loadDiscFromCue(gamePath);

let frame = 0;
const displayOn = () => vdp2.configFromRegisters() !== null;

// 1. Wait for the title SIGNATURE, held (BGON=0x17 + fat VDP1 list).
let consecutive = 0, inTitle = false;
for(; frame < 4000; frame++)
{
	runFrame();
	if(vdp2._r(0x20) === 0x17 && vdp1.commandsDrawn > 400)
	{
		if(++consecutive >= 30) { inTitle = true; break; }
	}
	else consecutive = 0;
}
if(!inTitle) { console.log("did NOT reach the title in 4000 frames"); process.exit(1); }
console.log("title detected at f" + frame + " (signature held 30 frames)");
snapshot("diag/vc-title.png");

// 2. START on the title.
bus.pad1a = 0xFF & ~0x08;
for(let i = 0; i < 10; i++, frame++) runFrame();
bus.pad1a = 0xFF;

// 3. Wait for the transition blackout (max 300 frames).
let blackout = -1;
for(let i = 0; i < 300; i++, frame++) { runFrame(); if(!displayOn()) { blackout = frame; break; } }
console.log(blackout < 0 ? "no transition blackout (did START not register?)" : ("transition blackout at f" + blackout));

// 4. Does the display COME BACK? (max 1200 frames)
let returned = -1;
for(let i = 0; i < 1200; i++, frame++) { runFrame(); if(displayOn()) { returned = frame; break; } }
if(returned >= 0)
{
	for(let i = 0; i < 60; i++, frame++) runFrame();   // let the new screen settle
	snapshot("diag/vc-after-start.png");
	console.log("step 1: ADVANCED to the title with logo at f" + returned + " (photo diag/vc-after-start.png)");
}
else
{
	console.log("VERDICT: HUNG on the first START");
	process.exit(1);
}

// 5. SECOND START: on the title with the logo (the screen of Sebas's report).
// Logo signature: display ON with BGON=0x7 held.
let inLogo = false; consecutive = 0;
for(let i = 0; i < 900; i++, frame++)
{
	runFrame();
	if(displayOn() && vdp2._r(0x20) === 0x7) { if(++consecutive >= 30) { inLogo = true; break; } }
	else consecutive = 0;
}
if(!inLogo) { console.log("the logo did not stabilize (BGON=0x7)"); process.exit(1); }
console.log("logo stable at f" + frame + " -> try the buttons on the logo");
// The logo ignores START (measured the same on the baseline): try each pad button
// (active-low) until one triggers the transition. VC is a gun game: the
// candidate is the trigger (A or C depending on the game's mapping).
const BUTTONS = [["START", 0x08], ["A", 0x04], ["C", 0x02], ["B", 0x01], ["Up", 0x10]];
let blackout2 = -1, buttonThatAdvances = null;
for(const [name, bit] of BUTTONS)
{
	bus.pad1a = 0xFF & ~bit;
	for(let i = 0; i < 10; i++, frame++) runFrame();
	bus.pad1a = 0xFF;
	for(let i = 0; i < 200; i++, frame++) { runFrame(); if(!displayOn()) { blackout2 = frame; break; } }
	if(blackout2 >= 0) { buttonThatAdvances = name; break; }
	console.log("  " + name + ": no transition");
}
console.log(blackout2 < 0 ? "NO pad button triggers the transition on the logo" :
	("blackout 2 at f" + blackout2 + " with button " + buttonThatAdvances));
let returned2 = -1;
for(let i = 0; i < 1500; i++, frame++) { runFrame(); if(displayOn()) { returned2 = frame; break; } }
if(returned2 >= 0)
{
	for(let i = 0; i < 90; i++, frame++) runFrame();
	snapshot("diag/vc-after-start2.png");
	console.log("VERDICT 2: ADVANCED — display back at f" + returned2 + " (photo diag/vc-after-start2.png)");
}
else
{
	console.log("VERDICT 2: HUNG after the 2nd START (Sebas's report)" );
	console.log("  master PC=" + hx(cpu.pc) + " | slave " + (cpuSlave.halted ? "HALTED" : hx(cpuSlave.pc)) +
		" | CD phase=" + bus.cd.phase + " fad=" + hx(bus.cd.pos.fad) + " hirq=" + hx(bus.cdHirq) + " mask=" + hx(bus.cdHirqMask));
}
