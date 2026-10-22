/**
 *    Name:         scheduler.js
 *    Description:  MASTER CLOCK of the system and event queue. It is the piece the
 *                  emulator was missing: until 25-07-2026 there was no system clock, there
 *                  were PHASES. runFrame() ran a fixed sequence (vblankIn -> 400,000
 *                  cycles -> vblankOut -> plot -> 47,443 cycles) and correrInterleaved
 *                  split that into ~281 chunks of 1700 cycles, calling cdTick, hblankTick,
 *                  scspTick and m68k.run at each boundary.
 *                  With that, NO event happened on its cycle: it happened at the nearest chunk
 *                  boundary. And worse, the bus derived the video line from
 *                  cpuMaster.cycles -the counter of ONE chip used as the system clock-,
 *                  which goes to zero in cpu.reset() and does not advance with the CPU halted.
 *                  Here there is a clock of its own, in SH-2 cycles, and a queue of events
 *                  scheduled on THEIR exact cycle. The CPU runs from event to event.
 *    Version:      0.1.0
 *    Created:      25-07-2026
 *    Modified:     25-07-2026
 *    Author:       Sebastian Toyos
 */

// Event types. They are integers and not strings because the dispatch is a hot path
// (~265 events per frame) and a switch over integers is a jump table.
const EV_HBLANK_IN  = 0;   // a new video line starts
const EV_VBLANK_IN  = 1;   // active display ended
const EV_VBLANK_OUT = 2;   // the next frame starts
const EV_CD_SECTOR  = 3;   // the reader delivers a sector
const EV_NAMES = ["HBlank-IN", "VBlank-IN", "VBlank-OUT", "CD-sector"];

class Scheduler
{
	constructor()
	{
		// SYSTEM clock, in SH-2 cycles (26.84 MHz in NTSC 320 mode). It is MONOTONIC:
		// nobody resets it. That is exactly the difference with cpuMaster.cycles, which
		// goes back to zero on every cpu.reset() and carried the video line with it.
		this.cycle = 0;

		// Event queue. They are FEW and always the same ones (one per live type at a time), so
		// a small array sorted by insertion beats a heap: less indirection and
		// no allocations per event.
		this.queue = [];

		// Statistics for the probes: how many events of each type were dispatched.
		this.dispatched = new Uint32Array(EV_NAMES.length);

		// Video timing (see bootFrame). Startup values = NTSC 320x224.
		this.frameStart    = 0;
		this.cyclesPerFrame = 0;
		this.lines         = 262;
		this.line          = 0;

		// --- TIME WITHIN THE SEGMENT (see cycleAlive) ---
		// The clock above advances IN JUMPS: it updates when the CPU reaches the next
		// event. But WHILE the CPU runs that segment -1708 cycles, a whole line- the
		// emulated code can ask where the beam is, and with the clock frozen at the
		// edge the answer is always "the line is just starting".
		// That is not theoretical: the Saturn BIOS syncs with HBLANK by polling bit
		// 2 of TVSTAT ("MOV.W @(0x4,R3),R0 / TST #0x4 / BT") with IMASK at 15. If the bit
		// is never asserted, it spins forever — which is exactly where SF Alpha got stuck
		// (a 3-instruction loop at 0x2000056c) when the scheduler was hooked up.
		this.cpu     = null;   // the master SH-2, which is the one that consumes the segment
		this.cpuBase = 0;      // cpu.cycles at the start of the current segment
	}

	// The CPU whose progress the clock interpolates within the segment.
	connectCpu(cpu)
	{
		this.cpu = cpu || null;
		this.cpuBase = cpu ? cpu.cycles : 0;
	}

	// Starts a segment: sets the counter the CPU's progress is measured against.
	markSegment()
	{
		if(this.cpu) this.cpuBase = this.cpu.cycles;
	}

	// THE SYSTEM CYCLE NOW, counting what the CPU has run so far of the current segment.
	// It is what every POSITION query (line, HBLANK, HCNT/VCNT) has to use:
	// the plain `cycle` clock is only exact at event edges.
	cycleAlive()
	{
		if(!this.cpu) return this.cycle;
		// The progress can come out negative if the CPU was reset mid-segment (cpu.cycles
		// goes back to zero): then there is no progress to add.
		const advance = this.cpu.cycles - this.cpuBase;
		return advance > 0 ? this.cycle + advance : this.cycle;
	}

	// Leaves the queue empty and the clock where it is (a console reset does not rewind
	// time: the console does not travel to the past, only the chips are reinitialized).
	clear()
	{
		this.queue.length = 0;
	}

	// Schedules an event for the given ABSOLUTE cycle. If there was already one of that type,
	// it is replaced: the periodic events (HBlank, VBlank) are unique by definition and
	// queuing two would fire the line twice.
	scheduleIn(type, cycle)
	{
		this.cancel(type);
		// Insertion ordered by cycle. The queue has 3-4 elements: searching from the end
		// is faster than any more sophisticated structure.
		let i = this.queue.length;
		while(i > 0 && this.queue[i - 1].cycle > cycle) i--;
		this.queue.splice(i, 0, { type: type, cycle: cycle });
	}

	// Schedules the event `inside` cycles from NOW.
	schedule(type, inside)
	{
		this.scheduleIn(type, this.cycle + inside);
	}

	cancel(type)
	{
		for(let i = 0; i < this.queue.length; i++)
			if(this.queue[i].type === type){ this.queue.splice(i, 1); return; }
	}

	// The cycle of the next event, or Infinity if there is none. It is what decides how
	// far the CPU can run in one go.
	nextCycle()
	{
		return this.queue.length ? this.queue[0].cycle : Infinity;
	}

	// Takes the next event IF IT HAS ALREADY EXPIRED (its cycle <= the clock). Returns its type, or -1.
	// It is called in a while: more than one can expire in the same cycle.
	takeExpired()
	{
		if(!this.queue.length || this.queue[0].cycle > this.cycle) return -1;
		const ev = this.queue.shift();
		this.dispatched[ev.type]++;
		return ev.type;
	}

	// ------------------------------------------------------------------------------
	// VIDEO TIMING. It lives here and not in the orchestration because index.html and headless.mjs
	// had it duplicated ("faithful copies"), and that duplication already cost bugs: a fix
	// applied on one side and not the other is seen by no probe.
	//
	// The frame is divided into `lines` scanlines (262 NTSC, 313 PAL). The cycles per line
	// do NOT come out whole (447443/262 = 1707.8), so line N is not scheduled by adding a
	// rounded delta -that would accumulate drift along the frame- but by computing its
	// exact cycle from the start of the frame and rounding there.
	// ------------------------------------------------------------------------------

	// Starts a video frame: sets its origin and schedules the periodic events.
	//
	// THE FRAME STARTS AT VBLANK, not at the active display. That is: cycle 0 of the frame
	// is VBlank-IN, VBlank lasts its real lines (262-224 = 38 on NTSC, 14.5%) and
	// the active display takes the rest.
	//
	// It is the hardware's geometry AND the order games sync with, which is not
	// the same thing and took effort to find. Measured on 25-07-2026 with diag/screen-activity.mjs,
	// trying the three ways:
	//   - frame starting at active display, VBlank at the end (the "obvious" one): Virtua Cop with
	//     an image in 17% of the samples, Rally 33%. Both get stuck waiting.
	//   - the emulator's old order (VBlank at 85% of the frame, a magic fraction): 72% and 72%,
	//     but with an unreal VBlank.
	//   - this one: VBlank-IN at the start of the frame and a 38-line VBlank.
	// The game uses VBlank-IN as its tick: it does its frame work in that handler and
	// counts on the WHOLE frame ahead. Starting the frame at active display, the
	// VBlank-IN lands at 85% and it runs out of time before the next one.
	//
	// linesVisible = how many lines the active display lasts (224/240/256).
	bootFrame(cyclesPerFrame, lines, linesVisible)
	{
		this.frameStart   = this.cycle;
		this.cyclesPerFrame = cyclesPerFrame;
		this.lines        = lines;
		this.line         = 0;
		// Line 0 starts NOW: its HBlank-IN is immediate. The following ones are scheduled
		// from the dispatch of the previous one (see nextLine()).
		this.scheduleIn(EV_HBLANK_IN, this.cycle);
		// VBlank-OUT falls when the retrace lines end and the display comes back.
		this.scheduleIn(EV_VBLANK_OUT, this.cycleOfLine(lines - linesVisible));
	}

	// ABSOLUTE cycle at which line n of this frame starts.
	//
	// It is CEIL and not ROUND, and it is not a detail: line n occupies the interval
	// [n*T/L, (n+1)*T/L), so its first whole cycle is the ceil. With round, the scheduled
	// cycle could land one cycle BEFORE the theoretical start of the line and then
	// currentLine() -which takes the inverse path with floor- returned the PREVIOUS line:
	// the event said "261 starts" and the position counter answered "I am on
	// 260". The test "the last line of the frame" caught it.
	cycleOfLine(n)
	{
		return this.frameStart + Math.ceil(n * this.cyclesPerFrame / this.lines);
	}

	// Called by the HBlank-IN dispatch: advances the line counter and schedules the one
	// that follows. Returns the line that has JUST started.
	nextLine()
	{
		const laThatStarts = this.line;
		this.line++;
		if(this.line < this.lines) this.scheduleIn(EV_HBLANK_IN, this.cycleOfLine(this.line));
		return laThatStarts;
	}

	// CURRENT video line, derived from the system clock. It is what used to be taken from
	// cpuMaster.cycles — the counter of one chip used as everyone's clock, which on top of that
	// goes to zero on every cpu.reset() and dragged the beam position along with it.
	// Both POSITION queries go through cycleAlive(), not `cycle`: otherwise, within
	// a segment they would always answer the same thing (see the cycleAlive comment).
	currentLine()
	{
		if(!this.cyclesPerFrame) return 0;
		const inside = this.cycleAlive() - this.frameStart;
		return Math.floor(inside * this.lines / this.cyclesPerFrame);
	}

	// Fraction of the current line already traveled (0..1), for the horizontal counter HCNT and
	// for the HBLANK bit of TVSTAT.
	fractionOfLine()
	{
		if(!this.cyclesPerFrame) return 0;
		const perLine = this.cyclesPerFrame / this.lines;
		const inside = this.cycleAlive() - this.frameStart;
		const inLine = inside - Math.floor(inside / perLine) * perLine;
		return inLine / perLine;
	}

	// For the probes and the panel: what is scheduled and for when.
	state()
	{
		return {
			cycle: this.cycle,
			queue: this.queue.map(e => ({ event: EV_NAMES[e.type], en: e.cycle - this.cycle })),
			dispatched: EV_NAMES.map((n, i) => n + ":" + this.dispatched[i]).join(" "),
		};
	}
}

// In Node it is exported; in the browser it stays a global via <script>, like the chips.
if(typeof module !== "undefined" && module.exports)
	module.exports = { Scheduler, EV_HBLANK_IN, EV_VBLANK_IN, EV_VBLANK_OUT, EV_CD_SECTOR, EV_NAMES };
