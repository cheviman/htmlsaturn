// SANITY CONTROL FOR THE PROBES. Mandatory use before reporting a number.
//
// WHY IT EXISTS (Sebas, 25-07-2026, translated: "you keep getting false positives, your
// measurement system is not good, you have to change it"). In a single session I gave SIX
// false positives, all with the same pattern: write a probe, run it once and
// believe the first number.
//
//   - "the drive does not deliver sectors"      -> it was the FAD bit in the wrong CR
//   - "Play never reaches the end of the range" -> I asked for more sectors than there are buffers
//   - "BFUL is never raised"                    -> 0xFFFFFF means "the range from last time"
//   - "the filter does not connect"             -> the flags go in the low byte of CR1
//   - "the SH-2 executes nothing"               -> I hooked the wrong object
//   - "the audio generates 2229% of samples"    -> I read the buffer SIZE, not what was generated
//
// The two rules that come out of that, and that this module enforces:
//
//   1. EVERY PROBE NEEDS A CONTROL: run it also where I ALREADY KNOW the answer. If the
//      control gives an absurd value, the probe is wrong and NOTHING is reported. The only
//      measurement of the day that did not fail -the frame rate- was the only one with a control
//      (rally 54.8/s and vf2 60/s, which are credible values; sonic 0.5/s really did stand out).
//
//   2. IF THE MEASUREMENT SAYS SOMETHING BASIC IS BROKEN, THE SUSPECT IS THE PROBE. The 9
//      games boot, read from the CD and draw. A probe that says otherwise is the one that is
//      wrong until proven otherwise.
//
// And a third one that is not code but counts just the same: MEASURE WHERE THE PROBLEM SHOWS.
// Drawing conclusions about the browser by measuring headless is invalid, however tidy the
// number: headless has no worker, no canvas, no audio, and not the +21% overhead.

// Range in which a value is credible. Outside it nothing is reported: we warn that the probe
// is wrong. Absurd values (negative, infinite, orders of magnitude too large) are ALWAYS
// measurement bugs, never findings.
export function credible(name, value, min, max)
{
	if(!Number.isFinite(value))
		return { ok: false, reason: name + " gave " + value + " (not a number): the probe is broken" };
	if(value < min || value > max)
		return { ok: false, reason: name + " gave " + value + ", outside the credible range ["
			+ min + ", " + max + "]: it is almost certainly the probe and not the emulator" };
	return { ok: true };
}

// Sanity control of a run: the minimum that HAS to be true if the emulator
// is alive. If any of this fails, any number the probe produces is worthless.
//
//   bus, vdp1  : the emulator objects, already run for a good number of frames
//   expected   : { sectors, commandsVdp1, frames } counters the probe gathered
export function controlOfSanity(bus, vdp1, expected)
{
	const failures = [];
	if(!bus)                       failures.push("there is no bus");
	if(bus && !bus.cdReader)       failures.push("no disc mounted");
	if(bus && !bus.cd)             failures.push("the CD block has no state");
	if(bus && bus.cd && !bus.cd.authType)
		failures.push("the disc is NOT authenticated: the drive spins but does not deliver a single "
			+ "sector (bus.js only delivers data with authType != 0). Send 0xE0 and wait "
			+ "for fls.active to drop");
	if(expected && expected.frames > 60)
	{
		if(expected.sectors === 0)
			failures.push("zero sectors delivered in " + expected.frames + " frames: all 9 "
				+ "games read from the CD, so this is the probe");
		if(vdp1 && expected.commandsVdp1 === 0)
			failures.push("zero VDP1 commands in " + expected.frames + " frames: the emulator "
				+ "always draws, so this is the probe");
	}
	return { ok: failures.length === 0, failures };
}

// Prints the result and returns whether it can be reported. Use it like this:
//     if(!reportable(controlOfSanity(bus, vdp1, {sectors, commandsVdp1, frames}))) process.exit(1);
export function reportable(res)
{
	if(res.ok) return true;
	console.log("\n" + "!".repeat(70));
	console.log("INVALID PROBE — no number is reported.");
	for(const f of res.failures || [res.reason]) console.log("   - " + f);
	console.log("!".repeat(70));
	return false;
}

// Runs the same measurement on games I ALREADY KNOW work and returns their values, to
// compare. `measure` receives the name of the game and returns a number.
export async function againstControl(measure, gamesControl = ["rally", "vf2"])
{
	const out = [];
	for(const j of gamesControl)
	{
		let v = NaN;
		try { v = await measure(j); } catch(e) { v = NaN; }
		out.push({ game: j, value: v });
	}
	return out;
}
