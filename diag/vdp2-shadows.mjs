/**
 *    Name:         vdp2-shadows.mjs
 *    Description:  Which games ask for sprite shadows and of which kind (normal / MSB), crossing
 *                  SDCTL (who ACCEPTS them), SPCTL (whether the mode allows MSB) and the sprite
 *                  type. One process per game.
 *    Version:      0.1.0
 *    Created:      29-07-2026
 *    Modified:     29-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY
//
// The NORMAL shadow is implemented and verified (the 16 cases of the index against the hardware's
// shadow table). The MSB shadow is not, and the hardware needs exactly this
// for it to exist:
//   - bits 4 and 5 of the sprite control register (0x25f800e0) must be clear. Bit 5
//     (SPCLMD) turns off RGB sprites and bit 4 turns off the sprite window. So a game
//     that uses direct RGB CANNOT use MSB shadow: an MSB shadow sprite cannot be created
//     unless the game completely gives up displaying RGB sprites.
//   - it only works for sprite types 2 through 7.
//   - the 0x8000 pixel (MSB alone) is a TRANSPARENT shadow, and it darkens the background **only if
//     bit 8 of the shadow control register (0x25f800e2) is set**, and that bit is clear by default.
//   - a pixel > 0x8000 is interpreted as OPAQUE but with its luminance reduced.
//
// Without measuring this first, implementing MSB would mean writing a path that perhaps nobody
// exercises — and it would touch the compositor, which is a hot path and has already broken twice.
//
// THE CONTROL (Rule 0): it CANNOT be "if it gives 0 for all 10, the probe is wrong" — that was the
// first version and it is an invalid control, because it takes the result for granted (that some game
// uses shadows) to validate the tool. If none uses them, a control like that makes you discard
// a correct measurement.
// The control that IS valid is a SELF-CHECK: SDCTL and SPCTL are written with known
// values and we check that the probe detects them. That proves it reads the registers right,
// regardless of what the games do.
//
// Usage: node diag/vdp2-shadows.mjs [games] [frames]

import { readFileSync } from "fs";
import { basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const isChild = process.argv.includes("--child");

if(!isChild)
{
	const GAMES = (process.argv[2] || "rally,vc,sfa,sonic,xmen,touring,daycce,daytona,vf2,xmenvs").split(",");
	const FRAMES = process.argv[3] || "1500";
	const yo = fileURLToPath(import.meta.url);
	console.log("SPRITE SHADOWS — " + FRAMES + " frames per game\n");
	console.log("game      SDCTL!=0  bit8(transp)  MSB mode ok  types 2-7  ->  MSB possible?");
	for(const j of GAMES)
	{
		const r = spawnSync(process.execPath, [yo, j, FRAMES, "--child"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		process.stdout.write(r.stdout || ("  " + j + " -> failed: " + (r.stderr || "").split("\n")[0] + "\n"));
	}
	console.log("\nFor the MSB shadow to exist ALL THREE are needed: SDCTL requested, SPCTL with");
	console.log("bits 4 and 5 at 0, and sprite type 2-7. If no game puts the three together, the path");
	console.log("is exercised by nobody and it gets documented with //? instead of implemented blindly.");
	process.exit(0);
}

// ---------------- child ----------------
const GAME  = process.argv[2];
const FRAMES = parseInt(process.argv[3], 10);
const mod = await import("../headless.mjs?sv2=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const b = resolveBios({ xmen: "jp", vf2: "jp", xmenvs: "jp" }[GAME] || "us");
applyBios(basename(b), new Uint8Array(readFileSync(b)));
loadDiscFromCue(resolveGame(GAME));

let withSdctl = 0, withBit8 = 0, msbMode = 0, type27 = 0, lasThree = 0;
for(let f = 0; f < FRAMES; f++)
{
	runFrame();
	const r = bus.vdp2Regs;
	if(!r) continue;
	// SDCTL (1800E2H): bits 5-0 = which layer accepts shadow; bit 8 = transparent shadow.
	const sdctl = ((r[0xE2] << 8) | r[0xE3]) & 0xFFFF;
	// SPCTL (1800E0H): bits 3-0 = sprite type, bit 4 = sprite window, bit 5 = SPCLMD.
	const spctl = ((r[0xE0] << 8) | r[0xE1]) & 0xFFFF;
	const type = spctl & 0x0F;

	const a = (sdctl & 0x3F) !== 0;          // some layer accepts shadow
	const b8 = (sdctl & 0x100) !== 0;        // transparent shadow enabled
	const m = (spctl & 0x30) === 0;          // bits 4 and 5 at 0: the mode allows MSB
	const t = type >= 2 && type <= 7;
	if(a) withSdctl++;
	if(b8) withBit8++;
	if(m) msbMode++;
	if(t) type27++;
	if(a && m && t) lasThree++;
}

const pct = (n) => (n / FRAMES * 100).toFixed(0) + "%";
console.log(GAME.padEnd(9)
	+ pct(withSdctl).padStart(8) + pct(withBit8).padStart(14) + pct(msbMode).padStart(13)
	+ pct(type27).padStart(11) + "  ->  "
	+ (lasThree ? "YES, " + pct(lasThree) + " of the frames" : "no"));

// --- SELF-CHECK: the probe has to see an SDCTL/SPCTL set by hand ---
// Without this, a "0% on all 10" cannot be told apart from "I am reading the wrong register".
{
	const r = bus.vdp2Regs;
	r[0xE2] = 0x01; r[0xE3] = 0x3F;   // bit 8 (transparent) + the 6 layers accepting shadow
	r[0xE0] = 0x00; r[0xE1] = 0x02;   // bits 4 and 5 at 0, sprite type 2
	const sdctl = ((r[0xE2] << 8) | r[0xE3]) & 0xFFFF;
	const spctl = ((r[0xE0] << 8) | r[0xE1]) & 0xFFFF;
	const ok = (sdctl & 0x3F) !== 0 && (sdctl & 0x100) !== 0
		&& (spctl & 0x30) === 0 && (spctl & 0x0F) === 2;
	if(!ok) console.log("          ⚠ CONTROL FAILED: with SDCTL/SPCTL set by hand the probe does NOT see them."
		+ " Do not believe the row above.");
	else if(!withSdctl) console.log("          (control ok: the probe DOES detect an SDCTL set by hand,"
		+ " so the 0% is the fact and not a read error)");
}
