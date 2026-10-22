// Tests for the event scheduler (scheduler.js).
//
// It is the piece that ALL the new timing rests on, so its rules are tested
// separately: if the queue order or the expiry are wrong, the symptoms show up much
// further away (an IRQ that arrives late, a video line that gets skipped) and are very costly to
// diagnose.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(ROOT, "scheduler.js"), "utf8");
eval(code + "\nglobalThis.Scheduler=Scheduler;"
	+ "globalThis.EV_HBLANK_IN=EV_HBLANK_IN;globalThis.EV_VBLANK_IN=EV_VBLANK_IN;"
	+ "globalThis.EV_VBLANK_OUT=EV_VBLANK_OUT;globalThis.EV_CD_SECTOR=EV_CD_SECTOR;");

test("scheduler", () => {
	let passed = 0, failed = 0;
	const ok = (cond, name) => {
		if(cond) passed++;
		else { failed++; console.log("  FAIL: " + name); }
	};

	// --- The queue comes out SORTED by cycle, regardless of the insertion order ---
	{
		const p = new Scheduler();
		p.scheduleIn(EV_VBLANK_IN, 500);
		p.scheduleIn(EV_HBLANK_IN, 100);
		p.scheduleIn(EV_CD_SECTOR, 300);
		ok(p.nextCycle() === 100, "the next one is the one with the lowest cycle");
		p.cycle = 100; ok(p.takeExpired() === EV_HBLANK_IN, "the one at 100 comes out first");
		p.cycle = 300; ok(p.takeExpired() === EV_CD_SECTOR, "then the one at 300");
		p.cycle = 500; ok(p.takeExpired() === EV_VBLANK_IN, "then the one at 500");
		ok(p.takeExpired() === -1, "empty queue returns -1");
	}

	// --- An event does NOT expire before its cycle ---
	{
		const p = new Scheduler();
		p.scheduleIn(EV_HBLANK_IN, 1000);
		p.cycle = 999;
		ok(p.takeExpired() === -1, "at 999 the one at 1000 has not expired yet");
		p.cycle = 1000;
		ok(p.takeExpired() === EV_HBLANK_IN, "at 1000 it expires");
	}

	// --- Rescheduling the SAME type replaces it (it is not queued twice) ---
	// It is the rule that avoids firing the same video line twice.
	{
		const p = new Scheduler();
		p.scheduleIn(EV_HBLANK_IN, 100);
		p.scheduleIn(EV_HBLANK_IN, 200);
		ok(p.queue.length === 1, "a single HBlank in the queue");
		ok(p.nextCycle() === 200, "the last one scheduled remains");
	}

	// --- Several events expired in the SAME cycle all come out ---
	// It really happens: VBlank-OUT and the HBlank of line 0 fall together.
	{
		const p = new Scheduler();
		p.scheduleIn(EV_VBLANK_OUT, 50);
		p.scheduleIn(EV_HBLANK_IN, 50);
		p.cycle = 50;
		const seen = [];
		let t;
		while((t = p.takeExpired()) !== -1) seen.push(t);
		ok(seen.length === 2, "both from the same cycle come out");
	}

	// --- Events already expired (scheduled in the past) still come out, they are not lost ---
	// If the CPU overshot -a segment longer than the next event- the event
	// has to fire anyway, late but not lost.
	{
		const p = new Scheduler();
		p.cycle = 1000;
		p.scheduleIn(EV_HBLANK_IN, 500);   // in the past
		ok(p.takeExpired() === EV_HBLANK_IN, "a late event is still dispatched");
	}

	// --- cancel() removes only the requested type ---
	{
		const p = new Scheduler();
		p.scheduleIn(EV_HBLANK_IN, 100);
		p.scheduleIn(EV_VBLANK_IN, 200);
		p.cancel(EV_HBLANK_IN);
		ok(p.queue.length === 1 && p.nextCycle() === 200, "cancel removes only its own");
	}

	// --- With no events, the CPU can run with no cap ---
	{
		const p = new Scheduler();
		ok(p.nextCycle() === Infinity, "empty queue -> no cap");
	}

	// --- The clock is MONOTONIC: clear() does not rewind it ---
	// It is the difference from cpuMaster.cycles, which went to zero on every reset and took
	// the video line with it.
	{
		const p = new Scheduler();
		p.cycle = 123456;
		p.scheduleIn(EV_HBLANK_IN, 200000);
		p.clear();
		ok(p.cycle === 123456, "clear() does not touch the clock");
		ok(p.queue.length === 0, "clear() empties the queue");
	}

	// --- relative schedule() counts from the current clock ---
	{
		const p = new Scheduler();
		p.cycle = 5000;
		p.schedule(EV_CD_SECTOR, 1700);
		ok(p.nextCycle() === 6700, "schedule() is relative to the current cycle");
	}

	// ------------------------------------------------------------------------------
	// VIDEO TIMING
	// ------------------------------------------------------------------------------

	// --- The 262 lines of the NTSC frame fall evenly spread, with no accumulated drift ---
	// The cycles per line do not come out whole (447443/262 = 1707.8). If each line were scheduled
	// by adding a rounded delta, by the end of the frame the error would be tens of cycles.
	{
		const p = new Scheduler();
		p.bootFrame(447443, 262, 224);
		ok(p.cycleOfLine(0) === 0, "line 0 starts at cycle 0 of the frame");
		ok(p.cycleOfLine(262) === 447443, "line 262 falls EXACTLY at the end of the frame");
		// No line strays more than one cycle from its ideal position.
		let worst = 0;
		for(let n = 0; n <= 262; n++)
			worst = Math.max(worst, Math.abs(p.cycleOfLine(n) - n * 447443 / 262));
		ok(worst <= 1, "no line deviates more than 1 cycle (worst: " + worst.toFixed(2) + ")");
		// And the start cycle of a line ALWAYS belongs to that line: it is the
		// coherence between cycleOfLine (ceil) and currentLine (floor).
		let incoherent = 0;
		for(let n = 0; n < 262; n++)
		{
			p.cycle = p.cycleOfLine(n);
			if(p.currentLine() !== n) incoherent++;
		}
		p.cycle = 0;
		ok(incoherent === 0, "the start cycle of each line falls INSIDE that line ("
			+ incoherent + " incoherent)");
	}

	// --- Walking a whole frame gives EXACTLY 262 HBlanks, and VBlank lasts what it should ---
	// The frame STARTS at VBlank-IN (the loop fires it, not the scheduler) and
	// VBlank-OUT falls when the retrace lines end: 262-224 = 38 on NTSC, 14.5% of the
	// frame. With the 85% VBlank the phase model had, this gave 0.855.
	{
		const p = new Scheduler();
		p.bootFrame(447443, 262, 224);
		let hblanks = 0, vblankOut = -1;
		const end = p.cycle + 447443;
		let guarda = 0;
		while(p.cycle < end && guarda++ < 10000)
		{
			p.cycle = Math.min(p.nextCycle(), end);
			let t;
			while((t = p.takeExpired()) !== -1)
			{
				if(t === EV_HBLANK_IN){ hblanks++; p.nextLine(); }
				else if(t === EV_VBLANK_OUT) vblankOut = p.cycle;
			}
		}
		ok(hblanks === 262, "262 HBlank-IN in an NTSC frame (got " + hblanks + ")");
		ok(vblankOut === Math.ceil(38 * 447443 / 262), "VBlank-OUT falls when the 38 retrace lines end");
		const fraction = vblankOut / 447443;
		ok(fraction > 0.14 && fraction < 0.15, "VBlank lasts 14.5% of the frame (got "
			+ (100 * fraction).toFixed(1) + "%)");
	}

	// --- PAL: 313 lines ---
	{
		const p = new Scheduler();
		p.bootFrame(537482, 313, 240);
		ok(p.cycleOfLine(313) === 537482, "PAL: line 313 falls at the end of the frame");
	}

	// --- currentLine() derives the line from the SYSTEM CLOCK ---
	// It is what used to come from cpuMaster.cycles. That it depends on no chip is the point
	// of all this: the CPU resets (cycles goes back to 0) and the beam has no reason to jump.
	{
		const p = new Scheduler();
		p.bootFrame(447443, 262, 224);
		ok(p.currentLine() === 0, "at the start of the frame, line 0");
		p.cycle = p.cycleOfLine(100) + 5;
		ok(p.currentLine() === 100, "halfway through line 100, currentLine() = 100");
		p.cycle = p.cycleOfLine(261);
		ok(p.currentLine() === 261, "the last line of the frame");
		// And the horizontal fraction, for HCNT.
		p.cycle = p.cycleOfLine(50);
		ok(p.fractionOfLine() < 0.01, "at the start of a line, the fraction is ~0");
		p.cycle = p.cycleOfLine(50) + Math.round(447443 / 262 / 2);
		const fr = p.fractionOfLine();
		ok(fr > 0.45 && fr < 0.55, "halfway through a line, the fraction is ~0.5 (got " + fr.toFixed(3) + ")");
	}

	// --- Two frames in a row: the second starts where the first ended ---
	{
		const p = new Scheduler();
		p.bootFrame(447443, 262, 224);
		p.cycle = 447443;
		p.bootFrame(447443, 262, 224);
		ok(p.frameStart === 447443, "frame 2 starts where frame 1 ended");
		ok(p.cycleOfLine(262) === 447443 * 2, "and its last line falls at cycle 894886");
		ok(p.line === 0, "the line counter goes back to 0");
	}

	console.log("\n" + passed + " passed, " + failed + " failed");
	assert.strictEqual(failed, 0);
});
