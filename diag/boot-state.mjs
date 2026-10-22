// WHAT ENDS UP DIFFERENT DEPENDING ON HOW IT BOOTS? Without assuming which is the good path.
//
// Sebas (27-07-2026, translated): "the boot process is badly done, it is not initializing things
// properly, until you do the soft reset not everything is ok" — and then, the correction that
// defines the method: "it can start with or without a disc, cold or hot, BUT DO NOT TAKE
// ANYTHING FOR GRANTED".
//
// Both paths are legitimate on a real console (power on with the disc inserted, or swap
// the disc with the machine running), so it is not about choosing one: it is about the
// initialization ending up COMPLETE through either one. And to know it is not complete you have to
// COMPARE, not assume.
//
// This probe runs the three paths and takes a snapshot of the state of ALL the chips. Whatever
// differs is exactly what one path initializes and the other does not:
//
//   A) COLD       -> BIOS + disc mounted, and only then the first frame
//   B) HOT        -> BIOS running N frames, the disc is mounted with the machine running
//   C) SOFT RESET -> like hot, and then a soft reset (the one that "fixes" it)
//
// The snapshot is of REGISTERS AND FLAGS, not of RAM: RAM differs by definition (each
// path executed a different amount of code) and comparing it only adds noise. What matters is
// whether some chip ended up in a state that the other path does not produce.
//
// Usage: node diag/boot-state.mjs [game=rally] [frames=1200] [mountAt=400]
import { readFileSync } from "fs";
import { basename } from "path";

const GAME   = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "1200", 10);
const MOUNT  = parseInt(process.argv[4] || "400", 10);
const BIOS_PER_GAME = { xmen: "jp", xmenvs: "jp", vf2: "jp" };
const hx = (v) => "0x" + (v >>> 0).toString(16);

// The snapshot: everything that defines "what state the chips ended up in".
function portrait(m)
{
	const { bus } = m;
	const r = {};
	const regs = (name, buf, since, until, step) => {
		for(let o = since; o < until; o += step)
		{
			let v = 0;
			for(let k = 0; k < step; k++) v = (v << 8) | buf[o + k];
			r[name + "+" + hx(o)] = hx(v);
		}
	};
	regs("vdp1reg", bus.vdp1Regs, 0x00, 0x20, 2);
	regs("vdp2reg", bus.vdp2Regs, 0x00, 0x30, 2);      // the first ones: TVMD, EXTEN, BGON...
	regs("scureg",  bus.scuRegs || new Uint8Array(0), 0x00, 0x20, 4);
	// CD block: phase, status and the flags the game polls
	if(bus.cd)
	{
		r["cd.phase"]    = String(bus.cd.phase);
		r["cd.status"]  = hx(bus.cd.pos ? bus.cd.pos.status : 0);
		r["cd.free"]  = String(bus.cd.free ? bus.cd.free.length : -1);
		r["cd.hirq"]    = hx(bus.cdHirq);
		r["cd.hirqMask"]= hx(bus.cdHirqMask);
	}
	// SMPC and system state
	r["smpc.slaveOn"] = String(!!bus.smpcSlaveOn);
	r["smpc.soundOn"] = String(!!bus.smpcSoundOn);
	r["reset68k"]     = String(!!bus.reset68k);
	// VDP1 edge flags (the ones that travel to the worker)
	r["vdp1.plotRequest"]    = String(!!bus.vdp1PlotRequest);
	r["vdp1.eraseManual"] = String(!!bus.vdp1EraseManual);
	r["vdp1.changeManual"]  = String(!!bus.vdp1ChangeManual);
	// Backup RAM: formatted or not (block 0 has to have the signature)
	let signature = "";
	for(let i = 0; i < 16; i++){ const c = bus.backupRam[i * 2 + 1]; signature += (c >= 32 && c < 127) ? String.fromCharCode(c) : "."; }
	r["backup.signature"] = signature;
	// CPUs
	r["master.halted"] = String(!!bus.cpuMaster.halted);
	r["slave.halted"]  = String(!!(bus.cpuSlave && bus.cpuSlave.halted));
	// Where they execute: BIOS (low) or disc code (high WRAM)
	r["master.zone"] = (bus.cpuMaster.pc >>> 0) >= 0x06000000 ? "disc" : "bios";
	r["slave.zone"]  = bus.cpuSlave ? ((bus.cpuSlave.pc >>> 0) >= 0x06000000 ? "disc" : "bios") : "-";
	return r;
}

async function run(mode)
{
	const m = await import("../headless.mjs?arr=" + mode + GAME);
	const b = m.resolveBios(BIOS_PER_GAME[GAME] || "us");
	m.applyBios(basename(b), new Uint8Array(readFileSync(b)));

	if(mode === "cold")
	{
		// Disc inserted BEFORE the first frame (like a console powered on with the disc in).
		m.loadDiscFromCue(m.resolveGame(GAME));
		for(let f = 0; f < FRAMES; f++) m.runFrame();
	}
	else
	{
		// The BIOS boots without a disc and the disc appears with the machine running.
		for(let f = 0; f < MOUNT; f++) m.runFrame();
		m.loadDiscFromCue(m.resolveGame(GAME));
		const extra = process.env.COMPENSATE ? MOUNT : 0;
		for(let f = MOUNT; f < FRAMES + extra; f++) m.runFrame();
		if(mode === "soft")
		{
			// Soft reset: only the SH-2 revectors (RAM is not cleared and chips are not reset).
			m.bus.cpuMaster.reset();
			if(m.bus.cpuSlave) m.bus.cpuSlave.reset();
			for(let f = 0; f < FRAMES; f++) m.runFrame();
		}
	}
	return portrait(m);
}

const A = await run("cold");
const B = await run("hot");
const C = await run("soft");

const keys = [...new Set([...Object.keys(A), ...Object.keys(B), ...Object.keys(C)])].sort();
const difs = keys.filter(k => !(A[k] === B[k] && B[k] === C[k]));

console.log(GAME.toUpperCase() + " — chip state depending on the boot path");
console.log("  (" + FRAMES + " frames; the hot path mounts the disc at frame " + MOUNT + ")");
console.log("");
console.log("  " + "key".padEnd(24) + "COLD".padEnd(18) + "HOT".padEnd(18) + "SOFT RESET");
for(const k of difs)
	console.log("  " + k.padEnd(24) + String(A[k]).padEnd(18) + String(B[k]).padEnd(18) + String(C[k]));
console.log("");
console.log("  " + difs.length + " differences out of " + keys.length + " fields.");
console.log("  Whatever differs is what one path initializes and another does not. If a chip ends up in a");
console.log("  state that only appears after the soft reset, THAT is the one missing initialization.");
