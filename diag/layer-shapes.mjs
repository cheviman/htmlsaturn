// HOW MANY SHAPES (hidden classes) DOES THE VDP2 'layer' OBJECT HAVE?
//
// _pixelTile reads ~15 properties of 'layer' PER PIXEL (315,392 pixels per frame at
// 704x448). If all the layers share ONE shape, V8 resolves each access with a
// monomorphic inline cache -practically free-. If there are several, the access becomes
// polymorphic or megamorphic and each read costs a lookup.
//
// configFromRegisters builds 'layer' by adding properties PER BRANCH (layer.vcscBase and
// layer.vcscStep only if there is vertical cell scroll, layer.lineScrollTbl only with line
// scroll, layer.coordincx only with zoom...), which is exactly the recipe for having several
// shapes. The VDP1 already learned this lesson and declares everything in the constructor "so that the
// instance has a stable hidden class and V8 does not re-morph it at runtime".
//
// This is NOT guessed: it is asked. %HaveSameMap is V8's own answer.
// Run with:  node --allow-natives-syntax diag/layer-shapes.mjs [game] [frames]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME  = process.argv[2] || "touring";
const FRAMES = parseInt(process.argv[3] || "900", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };

const mod = await import("../headless.mjs?shapes=" + GAME);
const { vdp2, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame, cpu } = mod;
const bios = resolveBios(BIOS_PER_GAME[GAME] || "us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(resolveGame(GAME));

// %HaveSameMap is V8 NATIVE syntax: written directly in the module, the file does not
// parse if --allow-natives-syntax is missing. That is why it is compiled separately, with the try to give
// a clear message instead of a SyntaxError. The body is a literal constant -there is no
// interpolation and no outside data goes in-, so there is no injection surface.
let sameMap;
try { sameMap = new Function("a", "b", "return %HaveSameMap(a, b);"); }
catch(e){ console.error("It has to be run with --allow-natives-syntax"); process.exit(1); }

// A "shape" = a representative with its map. The list of keys is also kept to
// be able to say IN WHAT they differ, which is the actionable part.
const shapes = [];
for(let f = 0; f < FRAMES && !cpu.halted; f++)
{
	runFrame();
	const cfg = vdp2.configFromRegisters();
	if(!cfg || !cfg.layers) continue;
	for(const layer of cfg.layers)
	{
		let view = false;
		for(const fo of shapes)
			if(sameMap(layer, fo.rep)){ fo.n++; fo.names.add(layer.name); view = true; break; }
		if(!view) shapes.push({ rep: layer, n: 1, names: new Set([layer.name]), keys: Object.keys(layer) });
	}
}

console.log(GAME + ": " + shapes.length + " distinct shape(s) of 'layer' in " + FRAMES + " frames");
console.log("");
shapes.sort((a, b) => b.n - a.n);
for(let i = 0; i < shapes.length; i++)
{
	const fo = shapes[i];
	console.log("  forma " + (i + 1) + ": " + String(fo.n).padStart(6) + " layers  " +
		fo.keys.length + " props   [" + [...fo.names].join(",") + "]");
}
// The actionable part: which keys are NOT in every shape. Those are the ones that have to be
// always declared (with their neutral value) so that there is a single shape.
if(shapes.length > 1)
{
	const all = new Set();
	for(const fo of shapes) for(const k of fo.keys) all.add(k);
	const partial = [...all].filter(k => !shapes.every(fo => fo.keys.includes(k)));
	console.log("");
	console.log("  keys that are NOT in every shape (" + partial.length + "):");
	console.log("    " + partial.join(" "));
}
