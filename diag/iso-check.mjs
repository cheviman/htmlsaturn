// ARE WE READING THE DISCS' FILESYSTEM CORRECTLY? Check of all 9, in one go.
//
// Sebas (translated): "there was one where the iso's filesystem was listed wrong". A badly
// parsed filesystem does not
// give an error: it gives a game that asks for one file and receives another, or that does not find the one it
// is looking for. And it looks like "boots wrong", which is the symptom we were chasing one by one.
//
// On the Saturn's boot, the BIOS loads IP.BIN from the first 15 sectors and then
// **the first file listed in the root directory**. So the order of the root is NOT a
// cosmetic detail: it defines which program boots.
//
//
// This probe does not depend on the game working: it validates the filesystem against itself, which is
// verifiable without ambiguity.
//
//   PVD           = valid descriptor, block size, root dir
//   tree          = full traversal, with detection of loops and of illegal depth
//   per entry     = LBA inside the disc, coherent size, legal ISO9660 name
//   readability   = the first and the LAST sector of each file can actually be read
//   first file    = the one the BIOS would load
//
// Usage: node diag/iso-check.mjs [games]
const ALL = ["rally", "vc", "sfa", "sonic", "xmen", "daytona", "daycce", "touring", "vf2", "xmenvs"];
const GAMES = (process.argv[2] || ALL.join(",")).split(",");

// Legal ISO9660 level 1/2 names: uppercase, digits, underscore, dot, and the ";1"
// version suffix. Anything else is a sign that the parser drifted off its offset.
const OK_NAME = /^[A-Z0-9_.\-;]+$/;

for(const game of GAMES)
{
	// Mounting is done through the SAME path as the emulator (loadDiscFromCue), not through
	// a copy: if mounting had a bug, this probe has to see it just like the game does.
	// One module per game, because headless.mjs mounts only one.
	let reader = null;
	try
	{
		const mod = await import("../headless.mjs?isov=" + game);
		mod.loadDiscFromCue(mod.resolveGame(game));
		reader = mod.bus.cdReader;
	}
	catch(e){ console.log(game.padEnd(9) + " COULD NOT MOUNT: " + e.message); continue; }
	if(!reader){ console.log(game.padEnd(9) + " mounted but the bus has no cdReader"); continue; }

	const info = (reader.info && reader.info()) || {};
	const problems = [];
	if(!reader.rootDir) problems.push("NO root dir (PVD not parsed)");

	// Total sectors of the disc, to validate that no LBA goes outside.
	let totalSectors = 0;
	for(const p of (reader.tracks || []))
		totalSectors = Math.max(totalSectors, (p.lbaEnd !== undefined ? p.lbaEnd : 0));
	if(!totalSectors && reader.tracks && reader.tracks[0] && reader.tracks[0].data)
		totalSectors = Math.floor(reader.tracks[0].data.length / 2352) || 0;

	// Tree traversal with loop detection (a directory that points to itself or
	// to an ancestor makes any reader spin forever, the game included).
	const seen = new Set();
	let files = 0, addrs = 0, maxProf = 0;
	const rare = [];
	function walk(lba, size, prof, path)
	{
		if(prof > 8){ problems.push("depth > 8 (illegal in ISO9660) at " + path); return; }
		if(maxProf < prof) maxProf = prof;
		const key = lba + ":" + size;
		if(seen.has(key)){ problems.push("directory LOOP at " + path + " (lba " + lba + ")"); return; }
		seen.add(key);
		let children;
		try { children = reader.readDirectory(lba, size); }
		catch(e){ problems.push("could not read the directory " + path + ": " + e.message); return; }
		for(const h of children)
		{
			if(!OK_NAME.test(h.name) && rare.length < 6)
				rare.push(path + h.name + " (illegal name)");
			if(totalSectors && (h.lba < 0 || h.lba >= totalSectors) && rare.length < 6)
				rare.push(path + h.name + " (LBA " + h.lba + " outside the disc of " + totalSectors + ")");
			if(h.isDirectory){ addrs++; walk(h.lba, h.size, prof + 1, path + h.name + "/"); }
			else
			{
				files++;
				if(h.size <= 0 && rare.length < 6) rare.push(path + h.name + " (size 0)");
				// REAL readability: the first and the last sector. A file whose last
				// sector falls outside the track is the symptom of a badly read extent.
				const last = h.lba + Math.max(0, Math.ceil(h.size / 2048) - 1);
				for(const s of [h.lba, last])
				{
					try { const d = reader.readSector(s); if(!d || d.length < 2048) throw new Error("short sector"); }
					catch(e){ if(rare.length < 6) rare.push(path + h.name + " (cannot read sector " + s + ")"); }
				}
			}
		}
	}
	if(reader.rootDir) walk(reader.rootDir.lba, reader.rootDir.size, 1, "/");

	// The first file of the root: the one the BIOS loads after IP.BIN.
	let first = "?";
	try
	{
		const root = reader.listFiles("/") || [];
		const f = root.find(x => !x.isDirectory);
		first = f ? (f.name + " (lba " + f.lba + ", " + f.size + " bytes)") : "NONE";
	}
	catch(e){ first = "error: " + e.message; }

	const ok = problems.length === 0 && rare.length === 0;
	console.log(game.padEnd(9) + (ok ? "OK  " : "*** ") +
		String(files).padStart(4) + " files, " + String(addrs).padStart(3) + " dirs, depth " + maxProf +
		"   region " + String(info.region || "?").padEnd(8) +
		" serial " + String(info.productNumber || "?").trim());
	console.log("          first file of the root: " + first);
	for(const p of problems) console.log("          PROBLEM: " + p);
	for(const r of rare)     console.log("          RARO: " + r);
}
