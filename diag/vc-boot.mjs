// Virtua Cop BOOT probe: does it reach the title or does it stall on the way? Reports
// master/slave and the VDP1 work per checkpoint, the MMIO radar of the final stretch,
// the master's spin, and takes a PHOTO of the VDP2 to look at. It was born with the regression of
// 18-07-2026 (translated: "Virtua Cop doesn't start now"): running it the same way in a worktree at
// HEAD (broken) and in the tree with fixes, the A/B calls the verdict without guessing.
// Usage: node diag/vc-boot.mjs [frames=2400] [photoSuffix] [gamePath] [biosPath]
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { deflateSync } from "zlib";
import { bus, vdp2, vdp1, cpu, cpuSlave, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "../headless.mjs";

function crc32(buf)
{
	let c = ~0 >>> 0;
	for(let i = 0; i < buf.length; i++) { c ^= buf[i]; for(let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
	return (~c) >>> 0;
}
function chunk(type, data)
{
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length >>> 0, 0);
	const cd = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd), 0);
	return Buffer.concat([len, cd, crc]);
}
function png(w, h, rgba)
{
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for(let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for(let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = rgba[y * w * 4 + x]; }
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const hx = (v) => "0x" + (v >>> 0).toString(16);
const frames = parseInt(process.argv[2] || "2400", 10);
const suffix = process.argv[3] || "";
const gamePath = process.argv[4] || resolveGame("Virtua Cop (USA) (7S)");
const biosPath = process.argv[5] || resolveBios("us");
applyBios(basename(biosPath), new Uint8Array(readFileSync(biosPath)));
loadDiscFromCue(gamePath);

for(let f = 1; f <= frames; f++)
{
	runFrame();
	if(f % 600 === 0)
		console.log("f=" + f + " master=" + hx(cpu.pc) +
			" slave=" + (cpuSlave.halted ? "off" : hx(cpuSlave.pc)) +
			" cmdsVdp1=" + vdp1.commandsDrawn +
			" TVMD=" + hx(vdp2._r(0x00)) + " BGON=" + hx(vdp2._r(0x20)));
	// The radar starts clean for the FINAL STRETCH: whatever shows up there is what the
	// game is asking for NOW and we do not have (MMIO radar protocol).
	if(f === frames - 300) bus.mmioUnknown.clear();
}

const radar = [...bus.mmioUnknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log("radar (last 300 frames):", radar.length ? radar.map(([k, c]) => k + " x" + c).join(" | ") : "EMPTY");

// The master's spin: few unique PCs frame to frame = stuck in a loop.
const samples = new Set();
for(let i = 0; i < 60; i++) { runFrame(); samples.add(cpu.pc >>> 0); }
console.log("unique master PCs in 60 frames:", samples.size, "->", [...samples].slice(0, 6).map(hx).join(" "));

const cfg = vdp2.configFromRegisters();
if(cfg)
{
	vdp2.render(cfg);
	try { vdp1.compose(vdp2.priorities, vdp2.fb, vdp2.shadowOk); } catch(e) { console.log("compose failed:", e.message); }
	const name = "vc-boot" + suffix + ".png";
	writeFileSync(name, png(vdp2.width, vdp2.height, vdp2.fb));
	console.log("photo:", name, "(" + vdp2.width + "x" + vdp2.height + ")");
}
else console.log("no video configured yet (cfg null)");
