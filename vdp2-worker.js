/**
 *    Name:         vdp2-worker.js
 *    Description:  A thread that rasterizes ONE BAND of VDP2 lines. Several are spawned and
 *                  together they build the frame: thread k does lines k, k+N, k+2N...
 *                  They all read the SAME snapshot in shared memory (no per-thread copies) and
 *                  write DISJOINT lines of the output framebuffer, so there is no race
 *                  and they do not need to synchronize with each other: the main thread
 *                  orchestrates them, same as the VDP1 worker.
 *                  CLASSIC script on purpose, for the same reason as vdp1-worker.js: module
 *                  workers demand strict MIME, and a host that serves .mjs without Content-Type
 *                  kills them. Same code in Node (worker_threads, as CJS) for the test.
 *    Version:      0.1.0
 *    Created:      27-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// WHY THIS EXISTS, with the number (27-07-2026, diag/thread-split.mjs and diag/threads-ceiling.mjs):
// vdp2.render was 73-93% of the video worker's work in the five games measured, and in
// Daytona CCE it ate 15.75 of the frame's 16.68 ms by itself. Optimizing it is CLOSED
// with a number (ceiling 5%: the time is in the VRAM/CRAM reads, not in the logic), so
// the only lever left was rasterizing fewer pixels PER THREAD.
//
// Measured with real threads over SharedArrayBuffer, with identical hash in every
// combination — i.e. the SAME pixel, bit for bit:
//    Daytona CCE 704x448:  1 thread 15.75 ms · 2 threads 7.68 · 3 threads 5.58 · 4 threads 4.00 (3.94x)
//    Sega Touring 704x448: 1 thread  9.11 ms · 4 threads 3.12
// With 5 threads it gets WORSE (5.30 in Daytona): that is where memory contention shows up. The
// synchronization floor is 0.03 ms, negligible.
//
// INTERLEAVED AND NOT CONTIGUOUS BANDS: lines do not all cost the same (one with three layers
// costs much more than one of sky), so splitting into contiguous halves would unbalance the
// threads. Alternating, each thread gets an even sample of the frame without measuring anything.

var parentPort = null;
if(typeof importScripts === "function")
{
	// THE VERSION TRAVELS IN THE URL (?v=NN) and is passed to importScripts, for the same reason as in
	// vdp1-worker.js: without it the page loads "vdp2.js?v=NN" and the worker a bare "vdp2.js",
	// which are TWO different cache entries, and the worker can end up with an old version
	// of the same chip.
	const ver = (self.location && self.location.search) || "";
	importScripts("vdp2.js" + ver);
}
else
{
	// Node: the file runs as CJS. The eval evaluates EXCLUSIVELY vdp2.js, the project's own file
	// read from disk — never user or network data. It is the same loading shim
	// used by headless.mjs and vdp1-worker.js.
	parentPort = require("node:worker_threads").parentPort;
	const fs = require("node:fs");
	const path = require("node:path");
	eval(fs.readFileSync(path.join(__dirname, "vdp2.js"), "utf8") + "\nglobalThis.VDP2 = VDP2;");
}

// Bus mock: only what the VDP2 touches. The buffers are REPOINTED only once, when the
// SharedArrayBuffer arrives, and are not touched again — repointing them per frame is what
// deoptimized V8 in the VDP1 worker (polymorphic accesses, median growing 3 -> 134 ms).
const bus = {
	vdp2Vram: new Uint8Array(0x80000),
	cram:     new Uint8Array(0x1000),
	vdp2Regs: new Uint8Array(0x200),
	// The VDP2 does not use them, but the constructor shares code with the VDP1 path.
	vdp1Vram: new Uint8Array(0x80000),
	vdp1Regs: new Uint8Array(0x20),
	_geo: null,
	tvGeometry(){ return this._geo; },
};
const vdp2 = new VDP2(bus);

// INPUT slots (the snapshot, shared with the VDP1 worker and the main thread) and
// OUTPUT slots (the half-built frame). While they are null, the thread has not started yet.
let input = null;    // [{vdp2Vram, cram, vdp2Regs}, ...]
let output = null;     // [{fb, priorities, shadowOk}, ...]
let myBand = 0, countThreads = 1;

function postToMain(m){ parentPort ? parentPort.postMessage(m) : self.postMessage(m); }

function rasterize(msg)
{
	const e = input[msg.slot];
	// The three reads go by copy and not by repointing, for the reason in the bus comment.
	// It costs ~0.27 ms and it is what keeps V8 from deoptimizing the rasterizer.
	bus.vdp2Vram.set(e.vdp2Vram);
	bus.cram.set(e.cram);
	bus.vdp2Regs.set(e.vdp2Regs);
	bus._geo = msg.geo || null;

	// THE INTERLACE FIELD COMES FROM OUTSIDE. Each thread has its own VDP2 instance, and
	// if each one toggled its _field on its own, a single frame missed by one of
	// them would be enough for them to rasterize OPPOSITE fields and the frame would come out mixed. It is
	// kept by the main thread, which is the only one that knows how many frames went by.
	vdp2.fieldForced = msg.field ? 1 : 0;
	vdp2.bandStart = myBand;
	vdp2.bandStep = countThreads;

	const cfg = vdp2.configFromRegisters();
	if(!cfg){ postToMain({ id: msg.id, band: myBand, empty: true }); return; }
	vdp2.render(cfg);

	// Dump ONLY the lines of this band. They are disjoint between threads, so two threads never
	// write the same byte and no lock is needed.
	const s = output[msg.output];
	const width4 = vdp2.width * 4, width = vdp2.width;
	for(let j = vdp2._fieldStart; j < vdp2.height; j += vdp2._fieldStep)
	{
		const o4 = j * width4, o = j * width;
		s.fb.set(vdp2.fb.subarray(o4, o4 + width4), o4);
		s.priorities.set(vdp2.priorities.subarray(o, o + width), o);
		if(vdp2.shadowOk) s.shadowOk.set(vdp2.shadowOk.subarray(o, o + width), o);
	}
	postToMain({ id: msg.id, band: myBand, width: vdp2.width, height: vdp2.height });
}

function receive(msg)
{
	try
	{
		if(msg && msg.sab)
		{
			// Startup: the views are built ONCE. From then on each frame is a message
			// of four numbers — no structured clone, which was 1.0 ms of the 1.274 that
			// sending the MB cost.
			myBand = msg.band | 0;
			countThreads = Math.max(1, msg.threads | 0);
			input = [];
			for(let k = 0; k < msg.slots; k++)
			{
				const b = k * msg.size;
				input.push({
					vdp2Vram: new Uint8Array(msg.sab, b + msg.offVram2, 0x80000),
					cram:     new Uint8Array(msg.sab, b + msg.offCram,  0x1000),
					vdp2Regs: new Uint8Array(msg.sab, b + msg.offR2,    0x200),
				});
			}
			output = [];
			for(let k = 0; k < msg.outSlots; k++)
			{
				const b = k * msg.outSize;
				output.push({
					fb:          new Uint8Array(msg.outSab, b,                    msg.fbSize),
					priorities: new Uint8Array(msg.outSab, b + msg.fbSize,        msg.planeSize),
					shadowOk:    new Uint8Array(msg.outSab, b + msg.fbSize + msg.planeSize, msg.planeSize),
				});
			}
			postToMain({ ready: true, band: myBand });
			return;
		}
		if(!input) return;   // not started yet: the frame is lost, there is nothing to work with
		rasterize(msg);
	}
	catch(e)
	{
		// Report instead of dying silently, same as the VDP1 worker.
		postToMain({ id: msg && msg.id, band: myBand, error: String((e && e.stack) || e) });
	}
}

if(parentPort) parentPort.on("message", receive);
else self.onmessage = e => receive(e.data);
