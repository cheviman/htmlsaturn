/**
 *    Name:         orphans.mjs
 *    Description:  looks for "declared pieces nobody connects": properties that are
 *                  written and never read, and methods nobody calls. It is the pattern
 *                  behind almost every bug of this session (HBlank-IN and Draw End in the
 *                  SCU table never firing, the nonexistent Timer 0, the FRC
 *                  declared and never incremented, VCNT/HCNT always returning 0,
 *                  scuTimer0 declared and unused, the whole of cart.js with no <script>).
 *                  We found each of them through a hung game; these get detected on their own.
 *                  It looks at the props of this.X and also at the KEYS of the literals that
 *                  are assigned to a field (this._spi = { priority: 0, ... }): those are
 *                  written on a local object (res.priority = ...) and the this.X check
 *                  did not see them. A blind spot that cost dearly: _spi.priority was
 *                  calculated for every pixel and NOBODY read it, so the sprites were
 *                  composed without priority and Sega Rally's 3D covered the HUD
 *                  (vdp1.js, 17-07-2026). The detector failed on exactly the bug it existed
 *                  to find.
 *                  It also looks for names that differ ONLY in case: they are not
 *                  loose pieces, they are the trap next door (layer.coloroffset vs
 *                  layer.colorOffset in vdp2.js, 17-07-2026).
 *    Version:      0.3.0
 *    Created:      16-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync, readdirSync } from "fs";

const FILES = readdirSync(".").filter(f => /\.js$/.test(f) && !/\.min\./.test(f));
const SOURCE = {};
for(const f of FILES) SOURCE[f] = readFileSync(f, "utf8");
// index.html counts too: it uses the chips from the outside (vdp1.plot(), bus.hblankTick()...)
let html = "";
try { html = readFileSync("index.html", "utf8"); } catch(e) {}
const ALL = Object.values(SOURCE).join("\n") + "\n" + html;

// Tests are consumers, but of ANOTHER kind: they exercise a piece without the
// emulator using it. They are read separately so we can tell "nobody calls it" (loose piece)
// from "only the tests call it" (an observation accessor... or a test that gives false
// confidence about something the real emulator never runs). Mixing them with the console
// would trade the noise of a false positive for a blind spot.
const FILES_TEST = readdirSync(".").filter(f => /\.test\.mjs$/.test(f));
const ALL_TEST = FILES_TEST.map(f => readFileSync(f, "utf8")).join("\n");

// Comments out: a mention in a comment is NOT a connection. The bug is precisely
// that the piece is documented and not wired.
const noComentarios = (s) => s
	.replace(/\/\*[\s\S]*?\*\//g, " ")
	.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const CODE = noComentarios(ALL);
const CODE_TEST = noComentarios(ALL_TEST);

// PascalCase for classes and camelCase for their instances is the project's
// convention (ScspEngine/scspEngine, Bus/bus). That pair is NOT a collision, it is the style:
// reporting it would be noise in every file and would bury the real finding.
const isKindVsInstance = (a, b) =>
	(/^[A-Z]/.test(a) && /^[a-z]/.test(b)) || (/^[A-Z]/.test(b) && /^[a-z]/.test(a));

// An identifier can contain non-ASCII letters (an older cd.js declared a key with an n-tilde). With a
// bare \w such a key does not match whole and the regex ends up grabbing its lone last letter
// as if it were a key: it invents a prop that does not exist and reports it as an orphan. The noise
// does not only come from looking too much, it also comes from misreading what is looked at.
const IDENT = "[A-Za-zÀ-ÿ_$][\\wÀ-ÿ$]*";

const findings = { propsOrphans: [], methodsOrphans: [], onlyTests: [], collisions: [] };

// Triage shared by the two prop checks (this.X and literal keys): they are the
// SAME finding in a different package, so they have to measure with the same yardstick or the
// report stops being comparable with itself.
// Mind how conservative it is: it counts .key on ANY object as a read, not
// only on ours. That means a generic key is never reported (_colLeft.r
// has 332 ".r" in the project, almost none of them its own). It is a false negative on purpose:
// there were already two false positives here (sysX1/sysY1, cddaPending()) and connecting the piece
// would have invented hardware that does not exist. A loose piece we don't see costs another
// session; a detector that cries wolf is read by nobody and dies.
const classifyPerReads = (file, key, piece) =>
{
	// Reads across the WHOLE project: this.prop / obj.prop, not counting assignments.
	// $ is legal in a JS identifier and is a regex metachar: escape it or the
	// pattern gets built wrong and lies.
	const pattern = new RegExp("\\.(" + key.replace(/\$/g, "\\$") + ")\\b(?!\\s*=(?!=))", "g");
	if([...CODE.matchAll(pattern)].length > 0) return;

	if([...CODE_TEST.matchAll(pattern)].length > 0)
		findings.onlyTests.push({ file, piece, what: "only the tests read it" });
	else
		findings.propsOrphans.push({ file, piece, what: "written and NOBODY reads it" });
};

// Returns the LEVEL 1 keys of the literal that opens at "ini" (or null if it does not close).
// It counts braces/brackets/parentheses so as not to confuse a nested object with the
// outer one, and skips strings: a "{" inside a string would unbalance the count and the
// scan would eat half the file spitting out made-up keys.
const keysLiteral = (code, start) =>
{
	const reKey = new RegExp("^\\s*(" + IDENT + ")\\s*:");
	const boots = [];   // positions where a level 1 key can start
	let prof = 0, i = start;

	for(; i < code.length; i++)
	{
		const c = code[i];
		if(c === '"' || c === "'" || c === "`")
		{
			const quote = c;
			for(i++; i < code.length && code[i] !== quote; i++)
				if(code[i] === "\\") i++;
			continue;
		}
		if(c === "{" || c === "[" || c === "(") prof++;
		else if(c === "}" || c === "]" || c === ")") { prof--; if(prof === 0) break; }
		// A level 1 key starts when the literal opens or after one of its own commas.
		if(prof === 1 && (c === "{" || c === ",")) boots.push(i + 1);
	}
	if(prof !== 0) return null;

	const keys = [];
	for(const p of boots)
	{
		const m = code.slice(p, p + 120).match(reKey);
		if(m) keys.push(m[1]);
	}
	return keys;
};

for(const [file, src] of Object.entries(SOURCE))
{
	const code = noComentarios(src);

	// --- Properties that are WRITTEN and never READ ---
	const props = new Set();
	for(const m of code.matchAll(/this\.([a-zA-Z_]\w*)\s*=(?!=)/g)) props.add(m[1]);

	for(const prop of props) classifyPerReads(file, prop, "this." + prop);

	// --- Keys of a literal assigned to a field: the props that do NOT live on this ---
	// The check above only sees this.X, so it was blind to what is written on a
	// local object: _infoPixelSprite(type, pix, res) does res.priority = ... on this._spi
	// (vdp1.js:97), and "res" is not "this". Result: a priority calculated per pixel that nobody
	// ever read, for months.
	//
	// Why ONLY the literals assigned to a field of this, and not every "something.prop = ":
	//   1. The literal is the explicit DECLARATION of the shape. this._spi = { index: 0,
	//      priority: 0, ... } is the author writing down which fields exist — same status
	//      as this.X = , a declared piece. The write site (res.priority = ) does not
	//      add anything about which fields there are: the one that lists them is the literal.
	//   2. It is OUR state, from a class in this file. It will never catch array.length,
	//      obj.style or a library's cfg.width, because we never look at a lone
	//      "something.prop = ". That is where 99% of the noise is, and we don't look at it.
	//   3. The set is bounded by construction: there are 8 literals like that in the whole
	//      project. It cannot blow up to 200 findings and kill the tool.
	// The alternative was following the parameter's dataflow (that "res" is this._spi) to
	// accept "res.X = " as a write. It was discarded: it needs real analysis, it breaks with
	// any alias, and it is not needed — the literal already says everything we need to know.
	for(const m of code.matchAll(new RegExp("this\\.(" + IDENT + ")\\s*=\\s*\\{", "g")))
	{
		const field = m[1];
		const keys = keysLiteral(code, m.index + m[0].length - 1);
		if(!keys) continue;   // a literal that does not close: we don't invent keys

		for(const key of keys) classifyPerReads(file, key, field + "." + key);
	}

	// --- Declared methods nobody calls ---
	// Class methods: indentation + name( ... ) {  -- excludes the language's keywords.
	const RESERVED = /^(if|for|while|switch|catch|return|function|constructor|typeof|new|do|else)$/;
	for(const m of code.matchAll(/^\t(_?[a-zA-Z]\w*)\s*\([^)]*\)\s*$/gm))
	{
		const name = m[1];
		if(RESERVED.test(name)) continue;
		const pattern = new RegExp("\\." + name + "\\s*\\(", "g");
		const calls = [...CODE.matchAll(pattern)];
		if(calls.length > 0) continue;

		const inTests = [...CODE_TEST.matchAll(pattern)];
		if(inTests.length > 0)
			findings.onlyTests.push({ file, piece: name + "()",
				what: "only the tests call it" });
		else
			findings.methodsOrphans.push({ file, piece: name + "()",
				what: "declared and NOBODY calls it" });
	}

	// --- Names that differ ONLY in capitalization ---
	// Another family, not the orphans': here the piece IS connected, but to the
	// wrong neighbor. And it fails SILENTLY, which is what makes it worse than a common
	// typo: the name exists, so there is no exception or noisy undefined —
	// it returns the wrong type and keeps going.
	// Real case (vdp2.js, 17-07-2026): layer.coloroffset was the CRAM ADDRESS offset
	// (a number, name copied from Yabause's struct) and layer.colorOffset the
	// Color Offset registers (an array). Mixing them up gave NaN -> CRAM[0] -> black,
	// without a single line in the console. The hardware's own names set the same trap: CRAOFA is the
	// "Color RAM Address Offset" and CLOFEN/COAR are the "Color Offset".
	// It looks file by file: two different objects in different files that use
	// the same word with another capitalization do not step on each other.
	const names = new Set();
	for(const m of code.matchAll(/\.([A-Za-z_]\w*)\b/g)) names.add(m[1]);        // .prop reads
	for(const m of code.matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)) names.add(m[1]);   // prop at the start of a line
	for(const m of code.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*:/g)) names.add(m[1]); // and after { or , (compact format)

	const perLowercase = {};
	for(const n of names)
	{
		const k = n.toLowerCase();
		(perLowercase[k] = perLowercase[k] || []).push(n);
	}
	for(const variants of Object.values(perLowercase))
	{
		if(variants.length < 2) continue;
		if(variants.length === 2 && isKindVsInstance(variants[0], variants[1])) continue;
		findings.collisions.push({ file, piece: variants.join(" vs "),
			what: "differ ONLY in case" });
	}
}

// --- .js files nobody loads (the cart.js case: 619 dead lines) ---
const noLoad = FILES.filter(f =>
	!/\.(test|config)\./.test(f) && f !== "orphans.mjs" &&
	!html.includes(f) && !CODE.includes('"' + f.replace(/\.js$/, "") + '"'));

const line = (h) => "  " + h.file.padEnd(14) + h.piece.padEnd(30) + h.what;
console.log("=== ORPHAN PROPERTIES (written, nobody reads them) ===");
console.log(findings.propsOrphans.length ? findings.propsOrphans.map(line).join("\n") : "  none");
console.log("\n=== ORPHAN METHODS (declared, nobody calls them) ===");
console.log(findings.methodsOrphans.length ? findings.methodsOrphans.map(line).join("\n") : "  none");
console.log("\n=== FILES NOBODY LOADS ===");
console.log(noLoad.length ? noLoad.map(f => "  " + f).join("\n") : "  none");
console.log("\n=== ONLY THE TESTS USE IT (the emulator does not) ===");
console.log("  They are not loose pieces: the test is a legitimate consumer. But a test that");
console.log("  exercises something the emulator never runs does not test the real path either.");
console.log(findings.onlyTests.length ? findings.onlyTests.map(line).join("\n") : "  none");

console.log("\n=== NAMES THAT DIFFER ONLY IN CASE ===");
console.log("  They are not loose pieces: they are connected to the wrong neighbor. No linter");
console.log("  catches them and they fail silently — the name exists, so there is no exception:");
console.log("  it returns the wrong type and keeps going.");
console.log(findings.collisions.length ? findings.collisions.map(line).join("\n") : "  none");

const total = findings.propsOrphans.length + findings.methodsOrphans.length + noLoad.length;
console.log("\nTOTAL: " + total + " loose pieces, "
	+ findings.onlyTests.length + " used only by tests, "
	+ findings.collisions.length + " case collisions");
