// DOES ANY GAME USE THE SUB-PIXEL SCROLL OF NBG0/NBG1, AND WITH ZOOM?
//
// The NBG0/NBG1 scroll comes split across two registers: the integer in
// SCXIN0/SCYIN0 (0x70/0x74) and the 8-bit FRACTION in SCXDN0/SCYDN0 (0x72/0x76), likewise
// NBG1 at 0x80-0x86. We were reading only the integer.
//
// This probe answers whether that matters, and not by eye: the fraction ALONE does not move a pixel
// —sampling does floor(scroll + x) and adding something smaller than 1 to an integer does not change the
// floor—; what makes it visible is the layer also being ZOOMED (ZMXN != 1), because
// then the positions accumulate in fractional form and the phase drifts. That is why the
// two things are counted separately and, above all, BOTH TOGETHER.
//
// CONTROL (Rule 0): we also count how many frames have the layer ON (BGON). If
// a layer is never turned on, its registers mean nothing and its row must not be read —
// it is the usual trap, a register with garbage in it that looks like a finding.
//
// Usage: node diag/vdp2-scroll-subpixel.mjs [frames=1200] [game1,game2,...]
import { readFileSync } from "fs";
import { basename } from "path";

const FRAMES = parseInt(process.argv[2] || "1200", 10);
const GAMES = (process.argv[3] || "rally,vc,sfa,sonic,xmen,touring,daycce,daytona,vf2,xmenvs").split(",");
const BIOS_PER_GAME = { xmen: "jp", vf2: "jp", xmenvs: "jp" };

// Offsets per layer: [integer X, fraction X, integer Y, fraction Y, zoom X integer, zoom X frac, BGON bit]
const LAYERS = [
	{ name: "NBG0", scxi: 0x70, scxd: 0x72, scyi: 0x74, scyd: 0x76, zmxi: 0x78, zmxd: 0x7A, bgon: 0x0001 },
	{ name: "NBG1", scxi: 0x80, scxd: 0x82, scyi: 0x84, scyd: 0x86, zmxi: 0x88, zmxd: 0x8A, bgon: 0x0002 }
];

console.log("game      layer  on         w/ fraction    w/ zoom    FRACTION+ZOOM (what changes)");

for(const game of GAMES)
{
	let mod;
	try { mod = await import("../headless.mjs?sub=" + encodeURIComponent(game)); }
	catch(e){ console.log(game.padEnd(9) + " -> could not be loaded: " + e.message); continue; }
	const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;

	try
	{
		const bios = resolveBios(BIOS_PER_GAME[game] || "us");
		applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
		loadDiscFromCue(resolveGame(game));
	}
	catch(e){ console.log(game.padEnd(9) + " -> could not be mounted: " + e.message); continue; }

	const r = (o) => (bus.vdp2Regs[o] << 8) | bus.vdp2Regs[o + 1];   // 16-bit register, big-endian
	const count = LAYERS.map(() => ({ on: 0, frac: 0, zoom: 0, both: 0 }));

	for(let f = 0; f < FRAMES; f++)
	{
		runFrame();
		if(!(r(0x00) & 0x8000)) continue;          // DISP=0: the screen is off, it does not count
		const bgon = r(0x20);
		for(let i = 0; i < LAYERS.length; i++)
		{
			const c = LAYERS[i], acc = count[i];
			if(!(bgon & c.bgon)) continue;         // layer off: its registers mean nothing
			acc.on++;
			const hasFrac = (((r(c.scxd) >> 8) & 0xFF) !== 0) || (((r(c.scyd) >> 8) & 0xFF) !== 0);
			// Zoom "other than 1": the increment is integer (bits 2-0 of ZMXIN) + fraction
			// (bits 15-8 of ZMXDN). Exactly 1.000 is integer 1 and fraction 0.
			const zEnt = r(c.zmxi) & 0x7, zFrac = (r(c.zmxd) >> 8) & 0xFF;
			const hasZoom = !(zEnt === 1 && zFrac === 0);
			if(hasFrac) acc.frac++;
			if(hasZoom) acc.zoom++;
			if(hasFrac && hasZoom) acc.both++;
		}
	}

	for(let i = 0; i < LAYERS.length; i++)
	{
		const acc = count[i];
		console.log(game.padEnd(9) + LAYERS[i].name.padEnd(7)
			+ String(acc.on).padStart(8)
			+ String(acc.frac).padStart(15)
			+ String(acc.zoom).padStart(11)
			+ String(acc.both).padStart(15));
	}
}

console.log("\nHow to read it: the last column is the ONLY one that changes a pixel. If it is 0 for all, reading the");
console.log("fraction is fidelity that no test game exercises yet (it holds for the other 490).");
console.log("And if 'on' is 0, the whole row says nothing: the layer was never shown.");
