/**
 *    Name:         cd.js
 *    Description:  Sega Saturn disc image reader/parser. Standalone (it does not
 *                  depend on the bus yet): detects the image format (.iso,
 *                  .cue+.bin, and basic .ccd/.img), builds the track table, reads
 *                  sectors by LBA returning the 2048 user bytes, parses
 *                  the ISO9660 filesystem (PVD -> directory tree) and the header
 *                  of the Saturn CD-ROM ("SEGA SEGASATURN "). The bus.js CD block
 *                  hooks this class up with bus.mountDisc(reader).
 *    Version:      0.2.1
 *    Created:      15-07-2026
 *    Modified:     16-07-2026
 *    Author:       Sebastian Toyos
 *
 *    Attribution: Saturn header offsets and the cue/bin parsing taken from Yabause
 *    (yabause/src/cs2.c and yabause/src/cdbase.c), GPL v2+. See CREDITS.md.
 *
 *    ===================== PUBLIC API (used by the CD block) =====================
 *
 *    const reader = new CdReader();
 *
 *    reader.loadImage(bytesImage, fileName)
 *        Loads a single-file image (.iso or a standalone .bin/.img). Detects the
 *        sector size (2048 plain mode1 vs 2352 raw with sync+header). Returns
 *        true if it got mounted.
 *
 *    reader.loadCue(textCue, mapOfBins)
 *        Loads a .cue (text) + its .bins. mapOfBins is an object
 *        { "game.bin": Uint8Array, ... } with the binaries referenced by the cue.
 *        Builds the multi-track table (data + CDDA audio). Returns true.
 *
 *    reader.readSector(lba) -> Uint8Array(2048)
 *        Returns the 2048 user data bytes of logical sector LBA,
 *        resolving the track and the offset according to the format (2048 vs 2352). For
 *        audio tracks it returns the raw data (no mode1/2 extraction applies).
 *        NOTE FAD<->LBA: the Saturn CD block works in FAD; FAD = LBA + 150.
 *        Use readSectorFad(fad) if you have the FAD directly.
 *
 *    reader.readSectorFad(fad) -> Uint8Array(2048)   // = readSector(fad - 150)
 *    reader.readSectorRaw(lba) -> Uint8Array(sectorSize)  // full raw sector
 *    reader.readSectorRaw2352(lba) -> Uint8Array(2352)  // raw sector normalized to
 *        2352 (sync + header + data), synthesizing the sync/header if the image is
 *        2048. It is what the CD block keeps in its buffers (see bus.js).
 *
 *    reader.info() -> { ... }   // parsed game header (see parseHeader)
 *
 *    reader.listFiles(path="/") -> [ {name, lba, size, isDirectory} ]
 *    reader.findFile(name)      -> {name, lba, size} | null
 *
 *    reader.tracks   // array of mounted tracks (see the structure in buildTrack)
 *    ============================================================================
 */

//!wip, 15-07-2026 - formats .iso / .cue+.bin / .ccd. ISO9660 + Saturn header.
//? pending: .mds/.mdf (structure defined in Yabause but not parsed here),
//? subchannel; mode2 form2 sectors (2324) are truncated to 2048 in readSector.

//? The cue pregap is accumulated but its "air" sectors are not generated (there are no
//? bytes in the bin); it only shifts the fad_starts like Yabause does.

// WHEN MEASURING A BOOT: GIVE THE CD TIME BEFORE DIAGNOSING (16-07-2026)
// The emulated drive runs at 1x (150 sectors/s = 2.5 sectors per frame), so the
// game's first file takes MANY frames to come in. Sega Rally's is 213
// sectors (435 KB): ~85 frames of reading alone, and since the CD block has 200
// buffers, the file comes in several batches -> only at ~2000 frames is it
// complete in WRAM and the CD fires EFLS.
// Measuring at ~330 frames shows the game WAITING for the load, and that reads as a
// hang that does not exist: you see the binary "half loaded" with zeroed holes, zeroed
// callback pointers, zeroed flags and a loop "nobody unsticks". All of that
// resolves itself later on. Verified on 16-07-2026 on both games:
//   Sega Rally  at 330 frames: binary 5% loaded, PC stuck at 0x6011250.
//               at 2000 frames: binary 100% identical to the ISO file, EFLS ok,
//               PC running through 0x605xxxx (70 unique PCs in 120 frames).
//   SF Alpha    at 330 frames: 0x6060d8a=0, 0x6055e70=0, 0x60391ee=0 ("nobody
//               writes them"); at 3830 frames: 0xd307432b, 0x1 and 0xf4ac respectively.
// Rule: run >= 4000 frames before claiming a game hung, and confirm
// with the count of unique PCs over a window of frames (a single repeated PC is not enough).

class CdReader
{
	constructor()
	{
		this.tracks = [];        // track table (one per TRACK on the disc)
		this.headerGame = null; // cache of the parsed Saturn header
		// ISO9660 logical block size, taken from the PVD. Today nobody consumes it, and that is
		// fine: the emulator reads by LBA (2048-byte physical sector), and the logical block
		// would only be needed if some disc declared another value, which does not happen on Saturn. It is
		// kept available for the file API (findFile/readFile).
		this.sizeBlockIso = 2048;
		this.rootDir = null;     // {lba, size} of the ISO9660 root directory
	}

	// ------------------------------------------------------------------ helpers

	// Decodes a byte range as ASCII and trims spaces/nulls.
	static text(bytes, start, length)
	{
		let s = "";
		for(let i = 0; i < length; i++)
		{
			const c = bytes[start + i];
			if(c === 0) break;
			s += String.fromCharCode(c);
		}
		return s.replace(/\s+$/, "");
	}

	// Reads a big-endian u32 (Saturn header format).
	static u32be(bytes, off)
	{
		return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
	}

	// Reads a little-endian u32 (format of the ISO9660 "both-endian" fields).
	static u32le(bytes, off)
	{
		return ((bytes[off]) | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
	}

	static u16le(bytes, off)
	{
		return ((bytes[off]) | (bytes[off + 1] << 8)) & 0xFFFF;
	}

	// Builds the structure of a track and adds it to the table. Internal work in LBA.
	// - type: 'data' | 'audio'
	// - sectorSize: 2048 | 2352 | 2336 | 2448
	// - lbaStart: first LBA of the track (fad_start - 150)
	// - offsetFile: byte inside `bytes` where lbaStart begins
	// - bytes: Uint8Array with the content of the track's file
	//ok, 15-07-2026
	buildTrack(number, type, sectorSize, lbaStart, offsetFile, bytes)
	{
		const track =
		{
			number:        number,
			type:          type,
			sectorSize:     sectorSize,
			lbaStart:     lbaStart,
			offsetFile: offsetFile,
			bytes:         bytes,
			// how many sectors fit from offsetFile to the end of the file
			// (clamped to 0: an offset outside the file must not give a negative track)
			sectorsCount:  Math.max(0, Math.floor((bytes.length - offsetFile) / sectorSize))
		};
		track.lbaEnd = lbaStart + track.sectorsCount - 1; // last valid LBA
		this.tracks.push(track);
		return track;
	}

	// Finds the track that contains a given LBA.
	trackOf(lba)
	{
		for(let i = 0; i < this.tracks.length; i++)
		{
			const p = this.tracks[i];
			if(lba >= p.lbaStart && lba <= p.lbaEnd) return p;
		}
		return null;
	}

	// ---------------------------------------------------------- image loading

	// Detects the format of a standalone file (.iso or .bin/.img) and mounts a single
	// data track that covers the whole file. No audio tracks.
	//ok, 15-07-2026
	loadImage(bytesImage, fileName)
	{
		const bytes = (bytesImage instanceof Uint8Array) ? bytesImage : new Uint8Array(bytesImage);
		this.reset();

		const sectorSize = this.detectSizeSector(bytes);
		// Data track 1, starts at LBA 0 (FAD 150), offset 0.
		this.buildTrack(1, "data", sectorSize, 0, 0, bytes);

		this.postMount();
		return this.tracks.length > 0;
	}

	// Heuristic for the sector size of a standalone file:
	//  - 2352: the first 12 bytes are the sync 00 FF*10 00, or the file is a
	//          multiple of 2352 (and not a "clean" multiple of 2048).
	//  - 2048: "SEGA SEGASATURN " or "CD001" show up where they belong for 2048.
	//ok, 15-07-2026
	detectSizeSector(bytes)
	{
		// sync of a raw sector (mode1/mode2)
		const sync = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];
		let isSync = true;
		for(let i = 0; i < 12; i++) if(bytes[i] !== sync[i]) { isSync = false; break; }
		if(isSync) return 2352;

		// If the Saturn magic is at offset 0 -> plain user data (2048).
		if(CdReader.text(bytes, 0, 15) === "SEGA SEGASATURN") return 2048;

		// ISO9660 PVD check: for 2048 the "CD001" is at LBA16 (+1 byte).
		if(bytes.length > 16 * 2048 + 6 && CdReader.text(bytes, 16 * 2048 + 1, 5) === "CD001") return 2048;
		// For 2352 mode1 the "CD001" is at LBA16 with offset 16 (sync+header).
		if(bytes.length > 16 * 2352 + 22 && CdReader.text(bytes, 16 * 2352 + 16 + 1, 5) === "CD001") return 2352;

		// Last resort: by divisibility of the size.
		if(bytes.length % 2352 === 0) return 2352;
		return 2048;
	}

	// Loads a .cue (text) + its binaries. mapOfBins = { "file.bin": Uint8Array }.
	// Takes from Yabause's LoadBinCue the arithmetic of a SINGLE-FILE cue (it accumulates
	// PREGAP, builds fad_start with INDEX 01, and gets the offset inside the bin), and adds
	// the multi-FILE support that Yabause does NOT have (there LoadBinCue bails out with
	// "Unsupported cue format" as soon as it sees a second FILE).
	//
	// THE TWO CUE FORMATS AND WHY THEY ARE NOT PARSED THE SAME WAY:
	//  - ONE-FILE cue (all the tracks in one .bin): the INDEXes are ABSOLUTE
	//    positions on the disc -> "TRACK 02 / INDEX 01 16:00:58" starts at that FAD.
	//  - "Split" cue (redump format: one .bin PER TRACK): each FILE starts from zero,
	//    so its INDEXes are RELATIVE TO THE FILE. All the audio tracks say
	//    "INDEX 01 00:02:00" and that does NOT mean they all start at second 2:
	//    it means "2 seconds into MY file". On the disc each track goes right
	//    AFTER the previous one.
	// Taking the INDEXes of a split cue as absolute stacks all the audio tracks
	// on the same LBA and leaves an impossible TOC (which is what this function used to do:
	// the 16 audio tracks of Sega Rally all landed on LBA 150). baseDisc is the
	// shift that places them: how much the already closed FILEs take up, in sectors.
	//ok, 16-07-2026
	loadCue(textCue, mapOfBins)
	{
		this.reset();

		const lines = textCue.split(/\r?\n/);
		let currentBin = null;          // Uint8Array of the FILE in progress
		let baseDisc = 0;             // FAD of byte 0 of the FILE in progress (0 = first FILE)
		let pregap = 0;                // accumulated in FAD (frames)
		let numTrack = 0;
		let trackType = "data";
		let sizeSectorTrack = 2352;
		let pending = [];           // tracks before resolving fad_end

		const msfAFad = (m, s, f) => (m * 4500) + (s * 75) + f;

		for(let ln = 0; ln < lines.length; ln++)
		{
			const line = lines[ln].trim();
			if(line === "") continue;
			const parts = line.split(/\s+/);
			const word = parts[0].toUpperCase();

			if(word === "FILE")
			{
				// Close the previous FILE: its bytes take up REAL sectors on the disc,
				// so the next one starts after it. sizeSectorTrack still holds the one
				// from the last TRACK read, which is exactly that of the file being closed.
				// In a single-FILE cue this never runs (currentBin is null the
				// first time) and baseDisc stays at 0 -> the INDEXes are still
				// absolute, same as before.
				if(currentBin) baseDisc += Math.floor(currentBin.length / sizeSectorTrack);

				// FILE "name.bin" BINARY  -> extract the name between quotes
				const m = line.match(/"([^"]+)"/);
				const name = m ? m[1] : parts[1];
				currentBin = this.resolveBin(name, mapOfBins);
				if(!currentBin)
				{
					// Fallback: first bin in the map if the name does not match.
					const keys = Object.keys(mapOfBins || {});
					if(keys.length === 1) currentBin = this.normUint8(mapOfBins[keys[0]]);
				}
			}
			else if(word === "TRACK")
			{
				numTrack = parseInt(parts[1], 10);
				const mode = (parts[2] || "").toUpperCase();
				if(mode.indexOf("AUDIO") === 0)
				{
					trackType = "audio";
					sizeSectorTrack = 2352;
				}
				else // MODE1/xxxx or MODE2/xxxx
				{
					trackType = "data";
					const bar = mode.indexOf("/");
					sizeSectorTrack = (bar >= 0) ? parseInt(mode.slice(bar + 1), 10) : 2352;
				}
			}
			else if(word === "PREGAP")
			{
				const t = this.parseMsf(parts[1]);
				if(t) pregap += msfAFad(t.m, t.s, t.f);
			}
			else if(word === "INDEX")
			{
				const idx = parseInt(parts[1], 10);
				const t = this.parseMsf(parts[2]);
				if(idx === 1 && t && currentBin)
				{
					const fadMsf   = msfAFad(t.m, t.s, t.f);
					// The INDEX places the track INSIDE its file; baseDisc places the
					// file inside the disc. Added together they give the absolute FAD of INDEX 01.
					const fadStart = baseDisc + fadMsf + pregap + 150;
					const offset   = fadMsf * sizeSectorTrack;  // byte inside the bin
					pending.push(
					{
						number: numTrack,
						type: trackType,
						sectorSize: sizeSectorTrack,
						lbaStart: fadStart - 150,             // we work in LBA
						offsetFile: offset,
						bytes: currentBin
					});
				}
			}
		}

		// Materialize the tracks (buildTrack computes lbaEnd from the file size).
		pending.sort((a, b) => a.lbaStart - b.lbaStart);
		for(const p of pending)
			this.buildTrack(p.number, p.type, p.sectorSize, p.lbaStart, p.offsetFile, p.bytes);

		// buildTrack stretches each track to the END OF ITS FILE. In a split cue that
		// is already correct (one file = one track), but in a single-FILE one it leaves
		// ALL the tracks ending at the end of the bin: track 1 eats the whole
		// disc and trackOf() returns it for any LBA, hiding the audio ones.
		// A track ends where the next one starts: trim (it only shrinks).
		for(let i = 0; i < this.tracks.length - 1; i++)
		{
			const p = this.tracks[i], limit = this.tracks[i + 1].lbaStart - 1;
			if(p.lbaEnd <= limit) continue;
			p.lbaEnd = limit;
			p.sectorsCount = Math.max(0, limit - p.lbaStart + 1);
		}

		this.postMount();
		return this.tracks.length > 0;
	}

	// Returns the file names referenced by the FILEs of a .cue, in order
	// and without the path (a .cue is just text: the data is in the .bins next to it).
	// The UI uses it to compare against what the user dropped and say exactly
	// which ones are missing, instead of failing silently.
	//ok, 16-07-2026
	static filesOfCue(textCue)
	{
		const names = [];
		const lines = String(textCue || "").split(/\r?\n/);
		for(const line of lines)
		{
			const l = line.trim();
			if(!/^FILE\b/i.test(l)) continue;
			// FILE "name.bin" BINARY  |  FILE name.bin BINARY (no quotes)
			const m = l.match(/"([^"]+)"/);
			const name = m ? m[1] : l.split(/\s+/)[1];
			if(name) names.push(name.replace(/^.*[\\/]/, ""));
		}
		return names;
	}

	// Looks up the bin by name (case-insensitive, ignoring the path) in the map.
	resolveBin(name, mapOfBins)
	{
		if(!mapOfBins) return null;
		const base = name.replace(/^.*[\\/]/, "").toLowerCase();
		for(const key of Object.keys(mapOfBins))
		{
			if(key.replace(/^.*[\\/]/, "").toLowerCase() === base)
				return this.normUint8(mapOfBins[key]);
		}
		return null;
	}

	normUint8(x)
	{
		if(!x) return null;
		return (x instanceof Uint8Array) ? x : new Uint8Array(x);
	}

	// Parses "mm:ss:ff" -> {m,s,f}
	parseMsf(str)
	{
		if(!str) return null;
		const p = str.split(":");
		if(p.length < 3) return null;
		return { m: parseInt(p[0], 10), s: parseInt(p[1], 10), f: parseInt(p[2], 10) };
	}

	reset()
	{
		this.tracks = [];
		this.headerGame = null;
		this.rootDir = null;
		this.sizeBlockIso = 2048;
	}

	// After mounting the tracks: parse the ISO9660 PVD and the Saturn header (best-effort).
	postMount()
	{
		try { this.parsePvd(); }      catch(e) { /* image without a valid ISO9660 */ }
		try { this.parseHeader(); }   catch(e) { /* image without a Saturn header */ }
	}

	// ------------------------------------------------------------ sector reading

	// Returns the 2048 user data bytes of sector LBA.
	//ok, 15-07-2026
	readSector(lba)
	{
		const p = this.trackOf(lba);
		if(!p) return new Uint8Array(2048);

		const base = p.offsetFile + (lba - p.lbaStart) * p.sectorSize;
		const out  = new Uint8Array(2048);

		if(p.type === "audio")
		{
			// CDDA: there is no "user" data; we return the first 2048 raw bytes.
			out.set(p.bytes.subarray(base, base + 2048));
			return out;
		}

		if(p.sectorSize === 2048)
		{
			out.set(p.bytes.subarray(base, base + 2048));
			return out;
		}

		if(p.sectorSize === 2352)
		{
			// sync(12) + header(4: min,sec,frame,mode). The mode is in byte 15.
			const mode = p.bytes[base + 15];
			let start;
			if(mode === 2)
			{
				// Mode2: if it is Form1/Form2 there is a subheader(8). Data at +24.
				// (Form2 is 2324 bytes; truncated to 2048 -> see the //? note at the top.)
				start = base + 24;
			}
			else
			{
				// Mode1 (or unknown): sync(12)+header(4) -> data at +16.
				start = base + 16;
			}
			out.set(p.bytes.subarray(start, start + 2048));
			return out;
		}

		if(p.sectorSize === 2336)
		{
			// Mode2 without sync/header: subheader(8) + data.
			out.set(p.bytes.subarray(base + 8, base + 8 + 2048));
			return out;
		}

		if(p.sectorSize === 2448)
		{
			// 2352 (data) + 96 (subchannel). Data as in the 2352 case.
			const mode = p.bytes[base + 15];
			const start = base + (mode === 2 ? 24 : 16);
			out.set(p.bytes.subarray(start, start + 2048));
			return out;
		}

		// odd size: return whatever is there.
		out.set(p.bytes.subarray(base, base + 2048));
		return out;
	}

	// Same as readSector but taking the CD block's FAD (Frame Address).
	readSectorFad(fad)
	{
		return this.readSector(fad - 150);
	}

	// ALWAYS returns a 2352-byte raw sector (sync + header + data), which is
	// the format in which the real CD block keeps the sectors in its buffers: the
	// filters look at the MSF header and at the subheader of mode2 sectors, so the
	// 2048 user bytes are not enough. If the image is 2048 (.iso), the sync and the
	// mode1 header are synthesized from the LBA. The EDC/ECC stays at zero (nobody looks at it).
	//ok, 16-07-2026
	readSectorRaw2352(lba)
	{
		const p = this.trackOf(lba);
		const out = new Uint8Array(2352);
		if(!p) return out;

		const base = p.offsetFile + (lba - p.lbaStart) * p.sectorSize;

		// 2352 and 2448 (2352 + subchannel) already start with the raw sector.
		if(p.sectorSize === 2352 || p.sectorSize === 2448)
		{
			out.set(p.bytes.subarray(base, base + 2352));
			return out;
		}

		// Sync of a raw sector: 00 FF*10 00.
		out[0] = 0x00;
		for(let i = 1; i <= 10; i++) out[i] = 0xFF;
		out[11] = 0x00;

		// Header: absolute MSF in BCD (FAD = LBA + 150) + mode byte.
		const fad = lba + 150;
		const bcd = (n) => (((n / 10) | 0) << 4) | (n % 10);
		out[12] = bcd(Math.floor(fad / 4500));
		out[13] = bcd(Math.floor(fad / 75) % 60);
		out[14] = bcd(fad % 75);

		if(p.sectorSize === 2336)
		{
			// Mode2 without sync/header: the rest (subheader + data) goes as is.
			out[15] = 0x02;
			out.set(p.bytes.subarray(base, base + 2336), 16);
			return out;
		}

		// 2048 (.iso): mode1, user data from byte 16.
		out[15] = 0x01;
		out.set(p.bytes.subarray(base, base + 2048), 16);
		return out;
	}

	// Returns the full raw sector (sectorSize bytes) of a track. Useful for the
	// CD block when the game asks for raw sectors (2352) instead of user data.
	readSectorRaw(lba)
	{
		const p = this.trackOf(lba);
		if(!p) return new Uint8Array(2352);
		const base = p.offsetFile + (lba - p.lbaStart) * p.sectorSize;
		return p.bytes.slice(base, base + p.sectorSize);
	}

	// ----------------------------------------------------------- Saturn header (IP)

	// Parses the Saturn CD-ROM header in sector 0 of the data track (LBA 0).
	// Offsets taken from Yabause cs2.c (Cs2GetIP). The IP.BIN (Initial Program) takes up
	// space from LBA 0 and its size is in the ipsize field (offset 0xE0).
	//ok, 15-07-2026
	parseHeader()
	{
		const s = this.readSector(0);
		if(CdReader.text(s, 0, 15) !== "SEGA SEGASATURN")
		{
			this.headerGame = null;
			return null;
		}

		const region = CdReader.text(s, 0x40, 16).replace(/\s+/g, "");
		// Date stored as YYYYMMDD (0x30..0x37).
		const yyyymmdd = CdReader.text(s, 0x30, 8);
		const date = (yyyymmdd.length === 8)
			? yyyymmdd.slice(6, 8) + "/" + yyyymmdd.slice(4, 6) + "/" + yyyymmdd.slice(0, 4)
			: yyyymmdd;

		const h =
		{
			system:       CdReader.text(s, 0x00, 16),                 // "SEGA SEGASATURN "
			maker:         CdReader.text(s, 0x10, 16),                 // company / maker id
			productNumber:CdReader.text(s, 0x20, 10),                 // T-xxxx / GS-xxxx
			version:       CdReader.text(s, 0x2A, 6),                  // V1.000
			date:         date,                                       // DD/MM/YYYY
			rawDate:      yyyymmdd,
			device:   CdReader.text(s, 0x38, 8),                  // CD-1/1
			region:        region,                                     // JTUBKAEL
			regions:      CdReader.mapRegions(region),
			peripherals:   CdReader.text(s, 0x50, 16),                 // J M A ...
			title:        CdReader.text(s, 0x60, 112),                // name of the game
			// IP (Initial Program) fields, big-endian u32:
			ipSize:         CdReader.u32be(s, 0xE0),                     // size of the IP.BIN
			mSh2Stack:     CdReader.u32be(s, 0xE8),                     // master SH-2 stack
			sSh2Stack:     CdReader.u32be(s, 0xEC),                     // slave SH-2 stack
			firstProgAddr:CdReader.u32be(s, 0xF0),                     // 1st read address
			firstProgSize: CdReader.u32be(s, 0xF4),                     // 1st read size
			ipLba:         0                                            // the IP starts at LBA 0
		};
		this.headerGame = h;
		return h;
	}

	// Maps the Saturn area symbols to readable names.
	static mapRegions(symbols)
	{
		const names = { J: "Japan", T: "Taiwan/Asia", U: "USA", B: "Brazil",
		                  K: "Korea", A: "Asia (NTSC)", E: "Europe", L: "Latin America" };
		const r = [];
		for(const c of (symbols || ""))
			if(names[c]) r.push(names[c]);
		return r;
	}

	// Returns the game header (parsing it if needed).
	info()
	{
		if(!this.headerGame) this.parseHeader();
		return this.headerGame;
	}

	// Returns a copy of the IP.BIN (Initial Program) as a Uint8Array. Its size is
	// ipSize (rounded to sectors). The CD block can load it into WRAM at boot.
	getIpBin()
	{
		const h = this.info();
		if(!h) return null;
		const size = h.ipSize > 0 ? h.ipSize : 0x8000;      // fallback 32KB (16 sectors)
		const sectors = Math.ceil(size / 2048);
		const out = new Uint8Array(sectors * 2048);
		for(let i = 0; i < sectors; i++)
			out.set(this.readSector(i), i * 2048);
		return out.subarray(0, size);
	}

	// --------------------------------------------------------------- ISO9660 (FS)

	// Parses the Primary Volume Descriptor (LBA 16) and stores the root directory.
	// ISO9660 layout: 2048-byte descriptor; type(0)=1, "CD001"(1..5), version(6)=1.
	// Logical block size at 128 (both-endian u16). Root dir record at 156 (34 b).
	//ok, 15-07-2026
	parsePvd()
	{
		// Look for the PVD (type 1) from LBA 16; stop at the terminator (type 255).
		let pvd = null;
		for(let lba = 16; lba < 32; lba++)
		{
			const s = this.readSector(lba);
			if(CdReader.text(s, 1, 5) !== "CD001") break;
			const type = s[0];
			if(type === 1) { pvd = s; break; }
			if(type === 255) break; // set terminator
		}
		if(!pvd) { this.rootDir = null; return null; }

		this.sizeBlockIso = CdReader.u16le(pvd, 128) || 2048;

		// Directory record of the root starting at offset 156.
		const rr = this.parseDirRecord(pvd, 156);
		this.rootDir = { lba: rr.lba, size: rr.size };
		return this.rootDir;
	}

	// Parses an ISO9660 "directory record" starting at an offset inside a buffer.
	// Structure: [0]=len, [1]=extAttrLen, [2..9]=extent LBA (both-endian, LE at 2),
	// [10..17]=data length (both-endian, LE at 10), [25]=flags (bit1=directory),
	// [32]=identifier len, [33..]=identifier.
	parseDirRecord(buf, off)
	{
		const len = buf[off];
		if(len === 0) return { len: 0 };
		const lba    = CdReader.u32le(buf, off + 2);
		const size = CdReader.u32le(buf, off + 10);
		const flags  = buf[off + 25];
		const idLen  = buf[off + 32];
		let name;
		if(idLen === 1 && buf[off + 33] === 0x00)      name = ".";
		else if(idLen === 1 && buf[off + 33] === 0x01) name = "..";
		else
		{
			name = CdReader.text(buf, off + 33, idLen);
			// Strip the ";1" version suffix that ISO9660 adds to files.
			const pv = name.indexOf(";");
			if(pv >= 0) name = name.slice(0, pv);
		}
		return {
			len: len,
			lba: lba,
			size: size,
			isDirectory: (flags & 0x02) !== 0,
			name: name
		};
	}

	// Reads a complete ISO9660 directory (it can take up several sectors) and returns
	// the list of its entries. Records do not cross a sector boundary: a len=0
	// means "skip to the next sector".
	//ok, 15-07-2026
	readDirectory(lba, size)
	{
		const sectors = Math.max(1, Math.ceil(size / 2048));
		const buf = new Uint8Array(sectors * 2048);
		for(let i = 0; i < sectors; i++) buf.set(this.readSector(lba + i), i * 2048);

		const inputs = [];
		let off = 0;
		while(off < size)
		{
			const len = buf[off];
			if(len === 0)
			{
				// skip to the next sector boundary
				const nextBoundary = (Math.floor(off / 2048) + 1) * 2048;
				if(nextBoundary <= off) break;
				off = nextBoundary;
				continue;
			}
			const rec = this.parseDirRecord(buf, off);
			if(rec.len > 0 && rec.name !== "." && rec.name !== "..")
				inputs.push({ name: rec.name, lba: rec.lba, size: rec.size, isDirectory: rec.isDirectory });
			off += len;
		}
		return inputs;
	}

	// Walks the ISO9660 tree down to the requested path (e.g. "/", "/MPEG", "/DATA/X.BIN")
	// and returns the directory record of the last component. Returns null if it does not exist.
	resolvePath(path)
	{
		if(!this.rootDir) return null;
		let current = { lba: this.rootDir.lba, size: this.rootDir.size, isDirectory: true };
		const parts = (path || "/").split("/").filter(x => x !== "");
		for(const part of parts)
		{
			if(!current.isDirectory) return null;
			const children = this.readDirectory(current.lba, current.size);
			const found = children.find(h => h.name.toUpperCase() === part.toUpperCase());
			if(!found) return null;
			current = found;
		}
		return current;
	}

	// Lists the files/directories of a path. path="/" is the root directory.
	//ok, 15-07-2026
	listFiles(path = "/")
	{
		const addr = (path === "/" || path === "")
			? (this.rootDir ? { lba: this.rootDir.lba, size: this.rootDir.size, isDirectory: true } : null)
			: this.resolvePath(path);
		if(!addr || !addr.isDirectory) return [];
		return this.readDirectory(addr.lba, addr.size);
	}

	// Looks up a file by name in the WHOLE tree (recursive). Returns the first one
	// that matches (case-insensitive, without the ";1"). null if it does not exist.
	//ok, 15-07-2026
	findFile(name)
	{
		if(!this.rootDir) return null;
		const target = name.replace(/^.*[\\/]/, "").toUpperCase();
		const visited = new Set();

		const findIn = (lba, size) =>
		{
			if(visited.has(lba)) return null; // anti-loop guard
			visited.add(lba);
			const children = this.readDirectory(lba, size);
			// Files at this level first.
			for(const h of children)
				if(!h.isDirectory && h.name.toUpperCase() === target)
					return { name: h.name, lba: h.lba, size: h.size };
			// Then recursion into subdirectories.
			for(const h of children)
				if(h.isDirectory)
				{
					const r = findIn(h.lba, h.size);
					if(r) return r;
				}
			return null;
		};
		return findIn(this.rootDir.lba, this.rootDir.size);
	}

	// Reads the full content of a file (by its record) as a Uint8Array.
	readFile(lba, size)
	{
		const sectors = Math.ceil(size / 2048);
		const out = new Uint8Array(sectors * 2048);
		for(let i = 0; i < sectors; i++) out.set(this.readSector(lba + i), i * 2048);
		return out.subarray(0, size);
	}
}

// Dual export: browser (global/window) so bus.js can hook it up, and CommonJS
// (module.exports) for the sanity check with node.
if(typeof module !== "undefined" && module.exports)
	module.exports = CdReader;
if(typeof globalThis !== "undefined")
	globalThis.CdReader = CdReader;
