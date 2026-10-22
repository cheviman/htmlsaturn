/**
 *    Name:         vdp1-worker.js
 *    Description:  Worker that rasterizes the VDP1 command list in parallel with the CPU
 *                  thread. It receives through postMessage a COPY of the state (VDP1 VRAM and registers,
 *                  plus the VDP2's CRAM, registers and VRAM); it plots onto banks of its OWN
 *                  that persist and returns the display framebuffer and, since 0.4.0, THE
 *                  WHOLE FRAME ALREADY COMPOSED (VDP2 render + VDP1 sprites on top), so
 *                  the main thread only does putImageData. It is a CLASSIC script on purpose, not a module
 *                  worker: classic workers do not require a strict MIME type (a host serving
 *                  .mjs without a Content-Type broke the module worker, seen on the web on 18-07) and
 *                  they have importScripts() to load vdp1.js. Same code in Node
 *                  (worker_threads, as CJS, for the test) and in the browser.
 *    Version:      0.4.0
 *    Created:      18-07-2026
 *    Modified:     27-07-2026
 *    Author:       Sebastian Toyos
 */

// Browser or Node? In the browser's classic worker importScripts exists; in Node it does not.
// CAREFUL: no speculative import() of "node:..." when running in the browser — Chrome
// tries to fetch that specifier, blocks it by CORS, and the worker was left dead WITHOUT firing
// 'error' (the real cause of the "5 frames without responding" on 18-07 on localhost).
var parentPort = null;
if(typeof importScripts === "function")
{
	// Browser: defines the VDP1 class in the worker's global (the page's <script>s
	// do not exist in here — each worker has its own global).
	// THE VERSION TRAVELS IN THE WORKER URL (?v=NN) AND IS PASSED ON TO THE importScripts. Without
	// this the page loaded "vdp1.js?v=63" and the worker loaded bare "vdp1.js": two different
	// URLs, i.e. TWO different CACHE ENTRIES, and the worker could keep an
	// old version of the same chip the main thread already had new.
	const ver = (self.location && self.location.search) || "";
	importScripts("vdp1.js" + ver);
	importScripts("vdp2.js" + ver);
}
else
{
	// Node: the file runs as CJS (there is no package.json with type:module), so there is
	// a synchronous require. Security: the eval evaluates EXCLUSIVELY vdp1.js and vdp2.js,
	// the project's own files read from disk — never user data or data from the
	// network. It is the same loading shim headless.mjs uses for all the chips.
	parentPort = require("node:worker_threads").parentPort;
	const fs = require("node:fs");
	const path = require("node:path");
	const code1 = fs.readFileSync(path.join(__dirname, "vdp1.js"), "utf8");
	eval(code1 + "\nglobalThis.VDP1 = VDP1;");
	const code2 = fs.readFileSync(path.join(__dirname, "vdp2.js"), "utf8");
	eval(code2 + "\nglobalThis.VDP2 = VDP2;");
}

// Mock bus: the buffers the VDP1 touches, persistent across frames. The flags are plain
// fields; vdp1EndDraw (the Draw End) is handled by the main thread, here it is a no-op.
const bus = {
	vdp1Vram: new Uint8Array(0x80000),
	vdp1Fb:   new Uint8Array(0x40000),
	cram:     new Uint8Array(0x1000),
	vdp2Regs: new Uint8Array(0x200),
	vdp1Regs: new Uint8Array(0x20),
	vdp2Vram: new Uint8Array(0x80000),   // 512 KB, for the VDP2 render (step 2)
	vdp1PlotRequest: false, vdp1EraseManual: false, vdp1ChangeManual: false,
	vdp1EndDraw() {},
	// THE GEOMETRY ARRIVES COMPUTED, it is not recomputed here. The main thread's bus.tvGeometry()
	// is a pure function of vdp2Regs, but duplicating its tables in the worker is
	// exactly the kind of divergence that already cost dearly (two copies of the same data that
	// drift out of sync). Both chips read it from here, same as on the real bus.
	_geo: null,
	tvGeometry() { return this._geo; },
};
// BARE references: in the browser importScripts leaves them as global lexical bindings
// (not as properties of globalThis); in Node the eval publishes them on globalThis. The
// bare identifier resolves in both cases.
const vdp1 = new VDP1(bus);
const vdp2 = new VDP2(bus);

// Resolution of the last composed frame, so the main thread knows what size
// the image it receives is without having to reread the registers.
let imgWidth = 0, imgHeight = 0;

// Views over the SharedArrayBuffer slots, if the main thread sent it. While it is
// null the message path is used (non-isolated context, or the test).
let slots = null;
// Output slots for the composed image: it is written there instead of allocating per frame.
let imgSlots = null, imgSlot = 0;
// Shared counter of finished frames (see the Atomics.add further down).
let endCount = null;

// Byte order of THIS machine, for the composition's alpha masks. It is the same thing
// index.html (ES_LITTLE_ENDIAN) and vdp2.js (VDP2_LITTLE_ENDIAN) do, and it is repeated on
// purpose: those modules' constants do not reach here (see the comment in
// composeFrame).
const IS_LITTLE_ENDIAN = (() => {
	const b = new ArrayBuffer(4);
	new Uint32Array(b)[0] = 1;
	return new Uint8Array(b)[0] === 1;
})();

// STEP 2: the WHOLE frame, composed here. Before, the main thread did this on top of the
// rAF and it cost 5.9 ms in the Rally, 13.2 in Virtua Cop and 16.5 in the Touring Car — with the
// emulation already eating almost the whole 16.68 budget.
// It goes in the SAME worker as the VDP1 and not in a separate one because composition needs the
// THREE VDP2 outputs (fb, priorities, shadowOk) together with the VDP1 bank: splitting them
// would force sending ~1.9 MB per frame back and syncing two threads with different
// latencies.
function composeFrame()
{
	const cfg = vdp2.configFromRegisters();
	if(!cfg) return null;
	vdp2.render(cfg);
	imgWidth = vdp2.width; imgHeight = vdp2.height;

	// Same order and same masks as drawTv() on the main thread: memcpy of the VDP2
	// background and on top the VDP1 sprites where alpha is not zero, keeping the destination's
	// alpha. Done 32 bits at a time (4x fewer iterations than byte by byte, identical).
	// With an output SAB it writes DIRECTLY into the slot: no allocation and no transfer. Without it,
	// it allocates as before (message path).
	const output = imgSlots ? imgSlots[imgSlot].subarray(0, vdp2.fb.length) : new Uint8Array(vdp2.fb.length);
	output.set(vdp2.fb);
	// vdp2.fb is kept apart from the output: the VDP1 needs the ORIGINAL background to blend the color
	// calculation, not the half-composed output.
	const spr = vdp1.compose(vdp2.priorities, vdp2.fb, vdp2.shadowOk);
	const d32 = new Uint32Array(output.buffer, output.byteOffset, output.length >> 2);
	const s32 = new Uint32Array(spr.buffer, spr.byteOffset, spr.length >> 2);
	// The masks depend on ENDIANNESS, same as in index.html: alpha is the high byte
	// of the u32 on little-endian and the low one on big-endian. Hardcoding 0xFF000000 would give an
	// image different from the main thread's on a big-endian machine, and the
	// bit-identity test would not see it because it runs on the same machine.
	// It is computed HERE and VDP2_LITTLE_ENDIAN is not reused: in Node the chips come in through eval, which
	// publishes the CLASS on globalThis but leaves its module constants in the eval's scope
	// (tested: "ReferenceError: VDP2_LITTLE_ENDIAN is not defined"). And it is not duplicating
	// emulator logic — it is a property of the machine it runs on.
	const ALPHA = IS_LITTLE_ENDIAN ? 0xFF000000 : 0x000000FF;
	const RGB = ~ALPHA;
	const n = Math.min(d32.length, s32.length);
	for(let k = 0; k < n; k++)
	{
		const v = s32[k];
		if(v & ALPHA) d32[k] = (v & RGB) | (d32[k] & ALPHA);
	}
	return output;
}

const postToMain = parentPort ? (m, t) => parentPort.postMessage(m, t) : (m, t) => self.postMessage(m, t);

// One frame: copy the received state into our own buffers, plot, return the display framebuffer
// (the result, which the main thread composes with the VDP2). The display
// framebuffer is copied into a new buffer so it can be transferred.
// HOW LONG THE WORKER TAKES INSIDE, measured BY THE WORKER (27-07-2026). From outside only
// the round trip is visible (diagRT), which INCLUDES what the message waited in the queue and what the thread
// took to wake up: with the queue stuck at 2 it may be measuring two frames and not one.
// The Daytona ingame gives 15-27 ms of RT for a worker that with compose:false ONLY does
// vdp1.plot() — 0.12 ms headless. Without this number there is no way to know whether it is work,
// queue or competition for the CPU, and deducing it from outside is exactly the mistake that was just
// made with the paint filter.
let _t0Inside = 0;
function processFrame(msg)
{
	_t0Inside = performance.now();
	try
	{
		// --- SHARED SNAPSHOT: the message carries the slot INDEX, not the data ---
		// It is COPIED from the slot into our own buffers. It looks wasteful -the data is already in
		// shared memory- but repointing is worse, and it took a measurement to understand this:
		//
		// THE FIRST VERSION REPOINTED (bus.vdp1Vram = v.vram) because "the VDP1 reads
		// this.bus.vdp1Vram on every access, so changing the reference is free". With
		// 3 rotating slots, those fields end up pointing to THREE different objects per round:
		// V8 sees the accesses as POLYMORPHIC, drops the VDP1's and VDP2's inline caches and
		// the code deoptimizes progressively. Measured in Sebas's browser, the worker's round
		// trip GREW frame after frame —median 3.1 -> 37 -> 64 -> 134 ms, p95
		// up to 231— until 79% of the dispatches were skipped. A GC gives SPIKES; that
		// monotonic degradation is deoptimization.
		// Copying keeps the objects' identity (a single shape, live caches) and still
		// avoids structured clone, which was 1.0 of the 1.274 ms. The local copy is ~0.27.
		// The VDP1 banks (vdp1Fb) are NOT touched: they are the worker's OWN persistent
		// state, they do not come from the snapshot.
		if(msg.slot !== undefined && slots)
		{
			const v = slots[msg.slot];
			bus.vdp1Vram.set(v.vram);
			bus.vdp2Vram.set(v.vdp2Vram);
			bus.cram.set(v.cram);
			bus.vdp2Regs.set(v.vdp2Regs);
			bus.vdp1Regs.set(v.vdp1Regs);
			if(msg.fb) bus.vdp1Fb.set(msg.fb);      // the seed still comes copied
			bus._geo = msg.geo || null;
			// compose:false = the VDP2 threads take care of the render and the main thread of the
		// composition. Only the plot is left here, which is what this worker exists for (0.12 ms
		// of the 20.90 the full frame cost).
		return processPlot(msg, msg.compose !== false);
		}
		bus.vdp1Vram.set(msg.vram);
		// STEP 2 (optional): if the snapshot carries the VDP2 VRAM, this worker composes the
		// whole frame. If it does not, it behaves like step 1 and returns only the VDP1
		// bank — that way the step 1 test and any old caller keep working.
		if(msg.vdp2Vram) bus.vdp2Vram.set(msg.vdp2Vram);
		bus._geo = msg.geo || null;
		// The framebuffer comes only in the FIRST message or after a reset (seed): from then
		// on the banks evolve HERE, with each frame's erase + plot + swap in order,
		// which is what keeps them coherent. (The test does send it every time: each of its
		// runs is a standalone frame.) The main thread does NOT rasterize in worker mode, so
		// its local copy of the framebuffer is stale and overwriting it here every frame would be a bug.
		if(msg.fb) bus.vdp1Fb.set(msg.fb);
		bus.cram.set(msg.cram);
		bus.vdp2Regs.set(msg.vdp2Regs);
		bus.vdp1Regs.set(msg.vdp1Regs);
		return processPlot(msg, !!msg.vdp2Vram);
	}
	catch(e)
	{
		// Report instead of dying silently: the main thread drops to synchronous mode when it sees it.
		postToMain({ id: msg.id, error: String((e && e.stack) || e) });
	}
}

// The part common to both paths (shared snapshot or by message): the plot cycles and
// the response. The only thing that changes above is WHERE the buffers come from.
function processPlot(msg, composes)
{
		bus.vdp1PlotRequest = msg.plotRequest;
		bus.vdp1EraseManual = msg.eraseManual;
		bus.vdp1ChangeManual = msg.changeManual;

		// ONE CYCLE PER FRAME THE MAIN THREAD LIVED THROUGH, not one per message. With FCM=1 the
		// erase and the bank change go by EDGE, and the swap is a PERMUTATION: if the
		// main thread skipped N dispatches, N cycles are missing here and the bank's PARITY ends up
		// backwards — the worker returns the bank it did NOT draw. That is the sprite trail
		// of the SF Alpha, which runs with FBCR=0x3 (FCM=1) in 79% of its frames.
		// The extra cycles use the same registers and the same list (it is the only state there
		// is, the last snapshot's), which is what the hardware would have drawn if the game
		// did not change the list in between.
		// Compat: a message without `cycles` counts as 1 — the step 1 test sends standalone frames.
		const cycles = Math.max(1, Math.min(8, (msg.cycles | 0) || 1));
		for(let c = 0; c < cycles; c++)
		{
			// The edges last ONE frame and plot() CONSUMES them: they have to be restored on every
			// pass, or the second cycle would find them already false and would neither erase nor change
			// bank (which is exactly what this comes to fix).
			if(c > 0)
			{
				bus.vdp1PlotRequest    = msg.plotRequest;
				bus.vdp1EraseManual = msg.eraseManual;
				bus.vdp1ChangeManual  = msg.changeManual;
			}
			vdp1.plot();
		}

		const fbDisplay = vdp1._fbDisplay.slice();   // the display bank, result of the plot + swap

		// WHAT THE WORKER DID, counted BY THE WORKER. Without this, from outside only the
		// framebuffer it returns is visible, and when it came back empty we had to guess whether it did not rasterize,
		// whether it rasterized and it did not arrive, or whether the probe measured wrong — three sessions of hypotheses. It is
		// cheap (four numbers) and answers the question on the first run.
		let nz = 0;
		for(let i = 0; i < fbDisplay.length; i += 8) if(fbDisplay[i]) nz++;
		const diag = {
			plot: vdp1.lastPlot, erase: vdp1.lastErase, swap: vdp1.lastSwap,
			cmds: vdp1.commandsDrawn, nz: nz,
			// It is taken BEFORE composeFrame() and the postMessage on purpose: it measures the plot,
			// which is the only thing this worker does when the VDP2 threads are active.
			msPlot: performance.now() - _t0Inside,
		};
		// THE BANK'S GEOMETRY TRAVELS WITH THE BANK. The main thread composes this
		// framebuffer one or two frames later, and if by then the game changed TVMR
		// (512x256 ↔ 1024x256 ↔ 512x512) reading it with THAT moment's geometry splits it.
		// See the comment on vdp1.compose(): it is the "it is erratic" race.
		const geoBank = {
			width: vdp1._fbWidth, height: vdp1._fbHeight, bpp: vdp1._fbBpp,
			interlaced: vdp1._interlaced,
		};

		// The composed image, if this message asked for step 2. It is composed AFTER the
		// plot cycles, with the bank left as display: it is the same order as the main
		// thread (plot in runFrame, compose when painting).
		const image = composes ? composeFrame() : null;

		// "DONE" NOTICE THROUGH SHARED MEMORY, apart from the postMessage.
		// The main thread decrements the queue in its onmessage, and that handler does not run until
		// the main thread lets go of the CPU: while it is emulating, a frame ALREADY FINISHED
		// still counts as in flight and triggers backpressure with the worker free. Measured
		// in Chrome on 28-07-2026: "worker median 28.4 ms" versus "inside 12.16 ms" -i.e. 16
		// ms of pure waiting- with brakes at 35/s, and on the results screen, with the main
		// thread light, the same 9.7 ms of worker gave brakes at 0/s.
		// With this the counter goes up as soon as the work is done and the brake looks at the REAL queue.
		// It goes BEFORE the postMessage on purpose: the message can wait, this cannot.
		if(endCount) Atomics.add(endCount, 0, 1);
		if(image && imgSlots)
		{
			// Only the INDEX travels: the image is already in the memory the main thread sees.
			const used = imgSlot;
			imgSlot = (imgSlot + 1) % imgSlots.length;
			postToMain({ id: msg.id, fbDisplay, diag, geoBank, imgSlot: used, width: imgWidth, height: imgHeight },
				[fbDisplay.buffer]);
			return;
		}
		if(image)
		{
			postToMain({ id: msg.id, fbDisplay, diag, geoBank, image, width: imgWidth, height: imgHeight },
				[fbDisplay.buffer, image.buffer]);
			return;
		}
		postToMain({ id: msg.id, fbDisplay, diag, geoBank }, [fbDisplay.buffer]);
}

// The startup message with the SharedArrayBuffer: it arrives ONCE only, together with the main
// thread's {ready}. The slot views are built and from then on each snapshot is only
// an index — no structured clone, which was 1.0 of the 1.274 ms it cost to send the MB.
function receive(msg)
{
	if(msg && msg.sab)
	{
		if(msg.sabCount) endCount = new Int32Array(msg.sabCount);
		if(msg.imgSab)
		{
			imgSlots = [];
			for(let k = 0; k < msg.imgSlots; k++) imgSlots.push(new Uint8Array(msg.imgSab, k * msg.imgSize, msg.imgSize));
		}
		const size = msg.size, n = msg.slots;
		slots = [];
		for(let s = 0; s < n; s++)
		{
			const b = s * size;
			slots.push({
				vram:     new Uint8Array(msg.sab, b + 0,        0x80000),
				vdp2Vram: new Uint8Array(msg.sab, b + 0x80000,  0x80000),
				cram:     new Uint8Array(msg.sab, b + 0x100000, 0x1000),
				vdp2Regs: new Uint8Array(msg.sab, b + 0x101000, 0x200),
				vdp1Regs: new Uint8Array(msg.sab, b + 0x101200, 0x20),
			});
		}
		return;
	}
	processFrame(msg);
}

if(parentPort) parentPort.on("message", receive);
else self.onmessage = e => receive(e.data);

// Startup handshake: report that the worker already loaded vdp1.js and can rasterize.
// The main thread rasterizes SYNCHRONOUSLY until it sees this (if it dispatched from frame 1,
// its "N frames without responding" failsafe would kill the worker during the warmup).
postToMain({ ready: true });
