// Reads a V8 .cpuprofile (node --cpu-prof) and summarizes it: SELF time per function.
//
// The V8 profiler says where the time goes WITHOUT theorizing and without instrumenting (the
// wrappers in diag/frame-profile.mjs inflate what they measure; this does not). It keeps the
// SELF time, which is the only thing useful for deciding what to optimize: the "total"
// time of step() is almost the whole frame and says nothing.
//
// Usage: node diag/read-cpuprof.mjs <file.cpuprofile> [count=25]
import { readFileSync } from "fs";

const file = process.argv[2];
const CAP = parseInt(process.argv[3] || "25", 10);
if(!file){ console.error("usage: node diag/read-cpuprof.mjs <file.cpuprofile> [count]"); process.exit(1); }

const p = JSON.parse(readFileSync(file, "utf8"));

// The profile carries nodes (functions) and two parallel arrays: samples (node id) and
// timeDeltas (microseconds since the previous sample). A function's self time
// is the sum of the deltas of the samples that fell IN it.
const perNode = new Map();
for(let i = 0; i < p.samples.length; i++)
{
	const id = p.samples[i], dt = p.timeDeltas[i] || 0;
	perNode.set(id, (perNode.get(id) || 0) + dt);
}

const info = new Map();
for(const n of p.nodes) info.set(n.id, n.callFrame);

const rows = [];
let total = 0;
for(const [id, us] of perNode)
{
	const cf = info.get(id);
	if(!cf) continue;
	const fileCorto = (cf.url || "").split(/[\\/]/).pop() || "-";
	const key = (cf.functionName || "(anonima)") + "  [" + fileCorto + ":" + (cf.lineNumber + 1) + "]";
	rows.push([key, us]);
	total += us;
}

// Group by name: V8 creates one node per call site, so the same function
// appears several times and, split up, looks cheap.
const grouped = new Map();
for(const [k, us] of rows) grouped.set(k, (grouped.get(k) || 0) + us);

const order = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
console.log("total time with samples: " + (total / 1000).toFixed(0) + " ms\n");
console.log("  %      ms     function");
for(const [k, us] of order.slice(0, CAP))
	console.log("  " + (100 * us / total).toFixed(1).padStart(5) + "  " + (us / 1000).toFixed(0).padStart(6) + "   " + k);
