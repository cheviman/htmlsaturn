/**
 *    Name:         threads-ceiling-worker.cjs
 *    Description:  a rasterizer thread for diag/threads-ceiling.mjs
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// Its own VDP2 reading the SAME VRAM/CRAM/registers as the other threads (SharedArrayBuffer,
// no copying), rasterizing ONLY its band of lines. It is exactly what the real design
// would do; here it serves to measure whether it scales with cores or memory contention eats it.
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");

// Same loading shim as vdp1-worker.js: it evaluates EXCLUSIVELY vdp2.js, the project's own file
// read from disk.
const code = fs.readFileSync(path.join(__dirname, "..", "vdp2.js"), "utf8");
eval(code + "\nglobalThis.VDP2 = VDP2;");

const { sab, outputSab, start, step, OFF_CRAM, OFF_REGS, OUTPUT_SIZE } = workerData;

// The three buffers are VIEWS over shared memory: the N threads read the same bytes.
// That is what makes the test representative — if there were one copy per thread, we
// would not be measuring the contention, which is precisely the question.
const bus = {
	vdp2Vram: new Uint8Array(sab, 0, 0x80000),
	cram:     new Uint8Array(sab, OFF_CRAM, 0x1000),
	vdp2Regs: new Uint8Array(sab, OFF_REGS, 0x200),
	vdp1Vram: new Uint8Array(0x80000),
	vdp1Regs: new Uint8Array(0x20),
	_geo: null,
	tvGeometry(){ return this._geo; },
};

const vdp2 = new VDP2(bus);
vdp2.bandStart = start;
vdp2.bandStep = step;
const output = new Uint8Array(outputSab, 0, OUTPUT_SIZE);

parentPort.on("message", (msg) => {
	if(msg.end){ process.exit(0); }
	// EMPTY round: answers without rasterizing. It is the control that says how much of what is measured is the
	// postMessage round trip and how much is work — without it, a small number could be
	// all synchronization and we would not know.
	if(msg.empty){ parentPort.postMessage({ ms: 0 }); return; }
	const t0 = Number(process.hrtime.bigint()) / 1e6;
	const cfg = vdp2.configFromRegisters();
	if(!cfg){ parentPort.postMessage({ ms: 0, empty: true }); return; }
	vdp2.render(cfg);
	// Dump ONLY the lines of this band to the shared framebuffer. They are disjoint between
	// threads (each one has its own start with the same stride), so there is no race: two
	// threads never write the same byte.
	const width4 = vdp2.width * 4;
	for(let j = vdp2._fieldStart; j < vdp2.height; j += vdp2._fieldStep)
	{
		const o = j * width4;
		output.set(vdp2.fb.subarray(o, o + width4), o);
	}
	const ms = Number(process.hrtime.bigint()) / 1e6 - t0;
	parentPort.postMessage({ ms, width: vdp2.width, height: vdp2.height });
});
parentPort.postMessage({ ready: true });
