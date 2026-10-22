/**
 *    Name:         baseline.mjs
 *    Description:  The translation baseline: tests, oracle, hashes and health in one run
 *    Version:      0.1.0
 *    Created:      22-10-2026
 *    Modified:     22-10-2026
 *    Author:       Sebastian Toyos
 */

// THE TRANSLATION BASELINE (step 2 of the GitHub publication plan).
//
// Translating a chip renames identifiers and comments: it cannot move a single bit. This
// run gathers what proves it —each chip's tests, the SH-2 oracle, the state, video and audio
// hashes, and the sweep of the 10 games— and prints it in the same format
// every time, so two runs can be compared with a diff.
//
// The ms/frame do NOT count: they depend on what the machine is doing. The hashes and the
// counts do. Everything runs in sequence, one heavy load at a time (~8 minutes).
//
// Usage: node diag/baseline.mjs > before.txt   (and afterwards: diff before.txt after.txt)
import { spawnSync } from "child_process";
import { readdirSync } from "fs";

// Each test with the line of its output that summarizes it. The tests have no common format:
// the last line that gives a count or a verdict is taken.
const SUMMARY_TEST = /(\d+\s*(PASS|passed)|\d+\/\d+ OK|^ℹ (pass|fail) \d+|IDENTIC|^OK:)/i;
const TESTS = [
	...readdirSync(".").filter(f => f.endsWith(".test.mjs")).sort().map(f => ({ args: [f], resumen: SUMMARY_TEST, all: true })),
	{ args: ["diag/sh2-oracle.mjs"], resumen: /passed:/ },
	...["rally", "daytona", "sfa", "vf2"].map(j => ({ args: ["diag/bench-sh2.mjs", j], resumen: /hash=/, clear: true })),
	...["touring", "sfa"].map(j => ({ args: ["diag/bench-video.mjs", j], resumen: /--- video.*hash=/, clear: true })),
	{ args: ["diag/audio-hash.mjs", "rally"], resumen: /audioHash=/ },
	{ args: ["diag/health.mjs"], table: true },
];

// Strips the ms from a bench line, which change between runs without anything having changed.
const noMs = (l) => l.replace(/[\d.]+\s*ms(\/(frame|cuadro))?/g, "").replace(/\s+/g, " ").trim();

for(const p of TESTS)
{
	const r = spawnSync(process.execPath, p.args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const lines = (r.stdout + "\n" + r.stderr).split("\n").map(l => l.trimEnd()).filter(Boolean);
	console.log("=== " + p.args.join(" ") + "  (exit " + r.status + ")");
	if(p.table)
	{
		// health.mjs prints its own table: it goes in whole.
		for(const l of lines) console.log("  " + l);
		continue;
	}
	const found = lines.filter(l => p.resumen.test(l.trim()));
	const chosen = p.all ? found : found.slice(-1);
	if(chosen.length === 0) console.log("  (no summary line)");
	for(const l of chosen) console.log("  " + (p.clear ? noMs(l) : l.trim()));
}
