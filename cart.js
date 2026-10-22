/**
 *    Name:         cart.js
 *    Description:  Sega Saturn cartridges (the A-bus slot). Models the
 *                  1 MB and 4 MB RAM carts (DRAM), the external backup RAM carts
 *                  (512K/1M/2M/4M), the ROM cart (KOF'95 / Ultraman) and the "no
 *                  cartridge" case. Resolves the mapping in CS0/CS1 and the ID register
 *                  the BIOS/game reads to know what is inserted.
 *    Version:      0.1.0
 *    Created:      16-07-2026
 *    Modified:     16-07-2026
 *    Author:       Sebastian Toyos
 *
 *    Attribution: ported from Yabause (yabause/src/cs0.c, cs0.h, cs1.c, and
 *    FormatBackupRam from memory.c) and from Mednafen beetle-saturn
 *    (mednafen/ss/cart/extram.c, cart/backup.c, cart/rom.c and the game database
 *    in ss/db.c). Both GPL v2+. See CREDITS.md.
 *
 *    ###################################################################
 *    #  HOOKED TO THE BUS on 16-07-2026. bus.js already routes it:     #
 *    #    - this.cart + putCartridge(cart)  (constructor)              #
 *    #    - _buildPages()  installs its RAM ranges                     #
 *    #    - _mmioRead/_mmioWrite  delegate CS0+CS1 to readMmio()       #
 *    #  The LAST step is MISSING, and it belongs to index.html:        #
 *    #  picking the cartridge when mounting the disc. Until that is    #
 *    #  done, bus.cart stays null = "no cartridge" and nobody runs     #
 *    #  this class.                                                    #
 *    #  See "HOW TO HOOK IT UP", patch 5, at the bottom of this file.  #
 *    ###################################################################
 */

//!wip, 16-07-2026 - Types NONE / RAM_1M / RAM_4M / BACKUP_* / ROM_16M
//? with their mapping and ID verified against Yabause and Mednafen. Missing: Action Replay
//? (PAR), Netlink, the Japanese modem and the 16 MB cart in CS1 (Heart of Darkness).

// ===================== A-bus map =====================
// The cartridge slot hangs off two A-bus chip-selects. The ranges come
// from Yabause memory.c (MappedMemoryInit), which fills the handler table like this:
//   FillMemoryArea(sh2, 0x200, 0x3FF, CartridgeArea->Cs0*)  -> CS0
//   FillMemoryArea(sh2, 0x400, 0x4FF, Cs1*)                 -> CS1
// The indices are 64 KB pages (addr >> 16), same as the bus.js table.
const CART_CS0_START = 0x02000000,   // CS0: 32 MB. The DRAM and the ROM cart live here.
      CART_CS0_END = 0x04000000,
      CART_CS1_START = 0x04000000,   // CS1: 16 MB. The backup cart and the ID live here.
      CART_CS1_END = 0x05000000;

// Cartridge ID register: it is the LAST byte of CS1 (Yabause cs1.c).
// The BIOS and the games read it to know which cartridge is inserted; if the ID is not
// the one they expect, they do not detect the cartridge and do not boot.
// Mednafen confirms it from the other side (extram.c / backup.c):
//   if((A & ~1) == 0x04FFFFFE) *DB = Cart_ID;
const CART_ADDR_ID = 0x04FFFFFF;

// Signature the BIOS expects at the start of a formatted backup memory.
// It goes in the ODD bytes; the even ones are open bus (0xFF).
const CART_SIGNATURE_BACKUP = "BackUpRam Format";

// ===================== Type table =====================
// One row per cartridge type:
//   id     value returned by the ID register (0x04FFFFFF). CRITICAL.
//   size   size of the buffer to allocate, in bytes.
//   kind   "dram" (CS0) | "backup" (CS1) | "rom" (CS0, read-only) | null.
//   win    address window mask (backup only).
//
// The IDs are verified in BOTH sources and they match:
//   Yabause cs0.c CartInit:  DRAM8MBIT=0x5A  DRAM32MBIT=0x5C
//                            BACKUPRAM 4/8/16/32 Mbit = 0x21/0x22/0x23/0x24
//                            CART_NONE (default) = 0xFF
//   Mednafen extram.c:       R4MiB ? 0x5C : 0x5A
//   Mednafen backup.c:       0x21
const CART_SPECS =
{
	// --- No cartridge ---
	// Yabause: the Dummy handlers return 0xFF/0xFFFF/0xFFFFFFFF and cartid=0xFF.
	0:  { name: "No cartridge",                  id: 0xFF, size: 0,         kind: null,     win: 0 },

	// --- Backup RAM cart (external backup memory, for saves) ---
	// The "usable" size is HALF the buffer: the chip is 8-bit on a
	// 16-bit bus, so only the ODD addresses respond (same as the
	// 64 KB internal backup in bus.js, which gives 32 KB usable).
	// The type name goes by the USABLE size; in parentheses, what
	// Yabause calls it (it names it by the chip's Mbit).
	2:  { name: "Backup RAM 512 KB (4 Mbit)",    id: 0x21, size: 0x100000,  kind: "backup", win: 0x0FFFFF },
	3:  { name: "Backup RAM 1 MB (8 Mbit)",      id: 0x22, size: 0x200000,  kind: "backup", win: 0x1FFFFF },
	4:  { name: "Backup RAM 2 MB (16 Mbit)",     id: 0x23, size: 0x400000,  kind: "backup", win: 0x3FFFFF },
	5:  { name: "Backup RAM 4 MB (32 Mbit)",     id: 0x24, size: 0x800000,  kind: "backup", win: 0x7FFFFF },

	// --- RAM cart (expansion DRAM) ---
	6:  { name: "RAM cart 1 MB (8 Mbit DRAM)",   id: 0x5A, size: 0x100000,  kind: "dram",   win: 0 },
	7:  { name: "RAM cart 4 MB (32 Mbit DRAM)",  id: 0x5C, size: 0x400000,  kind: "dram",   win: 0 },

	// --- ROM cart (KOF'95, Ultraman) ---
	// Yabause sets cartid=0xFF with the comment "I have no idea what the real
	// id is", and Mednafen (rom.c) simply registers no ID handler: so
	// the ID stays at open bus. Both sources agree on 0xFF.
	9:  { name: "ROM cart 2 MB (16 Mbit)",       id: 0xFF, size: 0x200000,  kind: "rom",    win: 0 }
};

class Cartridge
{
	// ---- Types. The values are Yabause's (cs0.h) on purpose, so that
	//      a save state or a log can be compared against that source. ----
	static NONE     = 0;   // CART_NONE
	static BACKUP_512K = 2;   // CART_BACKUPRAM4MBIT   (4 Mbit  -> 512 KB usable)
	static BACKUP_1M   = 3;   // CART_BACKUPRAM8MBIT   (8 Mbit  -> 1 MB usable)
	static BACKUP_2M   = 4;   // CART_BACKUPRAM16MBIT  (16 Mbit -> 2 MB usable)
	static BACKUP_4M   = 5;   // CART_BACKUPRAM32MBIT  (32 Mbit -> 4 MB usable)
	static RAM_1M      = 6;   // CART_DRAM8MBIT
	static RAM_4M      = 7;   // CART_DRAM32MBIT
	static ROM_16M     = 9;   // CART_ROM16MBIT

	// type: one of the constants above. Without an argument -> no cartridge.
	//ok, 16-07-2026
	constructor(type)
	{
		const spec = CART_SPECS[type];
		if(!spec) throw new Error("Cartridge: unknown type " + type);

		this.type   = type;
		this.name = spec.name;
		this.id     = spec.id;          // what readId() returns
		this.kind  = spec.kind;       // "dram" | "backup" | "rom" | null
		this.window = spec.win;       // window mask (backup only)

		// A single buffer per cartridge, with the alias that matches its kind.
		// The three aliases do NOT coexist: a cartridge is of a single kind.
		this.buf    = spec.size ? new Uint8Array(spec.size) : null;
		this.dram   = (spec.kind === "dram")   ? this.buf : null;
		this.bupram = (spec.kind === "backup") ? this.buf : null;
		this.rom    = (spec.kind === "rom")    ? this.buf : null;

		// Set when the backup is written -> the orchestrator persists it.
		// Same contract as bus.backupDirty (see "HOW TO HOOK IT UP").
		this.dirty = false;

		// A blank backup cart comes formatted, just like a newly bought one:
		// otherwise the BIOS sees it as corrupt and asks to format it by hand.
		if(this.bupram) this.formatBackup();
	}

	// ==================================================================
	//   PAGE TABLE (the fast path)
	// ==================================================================

	// Returns the cartridge's memory ranges in the format eaten by bus.js's
	// _buildPages(): 64 KB pages with {buf, mask, ro}, where
	// byte(a) = buf[a & mask]. bus.js installs them as is (see "HOW TO HOOK IT UP").
	//
	// Everything this table does NOT cover (open bus, the ID register, the tail
	// of the backup) falls to the slow path: _mmioRead/_mmioWrite -> readMmio().
	// The two paths must ALWAYS give the same result; cart.test.mjs verifies it.
	//ok, 16-07-2026
	pages()
	{
		// --- 4 MB RAM cart: 4 contiguous MB at 0x02400000-0x027FFFFF ---
		// Yabause DRAM32MBITCs0*: case 0x04..0x07 -> dram[addr & 0x3FFFFF].
		// Mednafen extram.c: ExtRAM_Mask = 0x3FFFFE (the same, word-aligned).
		if(this.type === Cartridge.RAM_4M)
			return [ { since: 0x02400000, until: 0x02800000, buf: this.dram, mask: 0x3FFFFF, ro: false } ];

		// --- 1 MB RAM cart: it is NOT contiguous. It is TWO 512 KB halves ---
		// This is the detail that breaks everything if you guess: the low half responds
		// at 0x024xxxxx and the HIGH one at 0x026xxxxx. A game that assumes 1 MB in a row
		// starting at 0x02400000 stomps the low half with itself.
		//   Yabause DRAM8MBITCs0*:  case 0x04 -> dram[addr & 0x7FFFF]
		//                           case 0x06 -> dram[0x80000 | (addr & 0x7FFFF)]
		//   Mednafen extram.c:      ExtRAM_Mask = 0x27FFFE  (bit21 picks the half,
		//                           bits 1-18 the offset; bits 19 and 20 are not
		//                           decoded -> each half is mirrored 4 times)
		// We follow Mednafen on the mirrors: Yabause returns open bus at
		// 0x025xxxxx / 0x027xxxxx, but that is a simplification of its own. The real
		// cart does not decode A19/A20, and that is where the mirrors come from (Mednafen maps
		// 512 KB over a 2 MB window, i.e. 4 mirrors).
		// The subarray shares the ArrayBuffer: writing through the page shows up in
		// this.dram and in bufferRaw(). That is why both halves go into the
		// page table without touching the bus.js fast path.
		if(this.type === Cartridge.RAM_1M)
			return [
				{ since: 0x02400000, until: 0x02600000, buf: this.dram.subarray(0, 0x80000),         mask: 0x7FFFF, ro: false },
				{ since: 0x02600000, until: 0x02800000, buf: this.dram.subarray(0x80000, 0x100000),  mask: 0x7FFFF, ro: false }
			];

		// --- ROM cart: 2 MB mirrored over the 32 MB of CS0, read-only ---
		// Yabause ROM16MBITCs0*: rom[addr & 0x1FFFFF] over pages 0x200-0x3FF.
		// Mednafen rom.c: SS_SetPhysMemMap(0x02000000, 0x03FFFFFF, ROM, 0x200000, false).
		if(this.type === Cartridge.ROM_16M)
			return [ { since: CART_CS0_START, until: CART_CS0_END, buf: this.rom, mask: 0x1FFFFF, ro: true } ];

		// --- Backup cart: the window is mirrored over the 16 MB of CS1 ---
		// Yabause BUP*Cs1*: bupram[addr & 0xFFFFF / 0x1FFFFF / 0x3FFFFF / 0x7FFFFF].
		// Mednafen backup.c: maps 0x04000000-0x04FFFFFF with (A >> 1) & 0x7FFFF.
		// WATCH OUT: the last page of CS1 (0x04FF0000) is left OUT on purpose,
		// because the ID register lives at 0x04FFFFFF and has to win over the
		// RAM (Yabause cs1.c checks the ID BEFORE delegating to the cartridge).
		// That page is resolved by hand by readMmio(): ID or backup, depending on the address.
		if(this.bupram)
			return [ { since: CART_CS1_START, until: 0x04FF0000, buf: this.bupram, mask: this.window, ro: false, backup: true } ];

		// No cartridge: not a single page. All of CS0/CS1 falls to the slow path and gives open bus.
		return [];
	}

	// ==================================================================
	//   ACCESSES (the slow path and the reference implementation)
	// ==================================================================

	// readMmio/writeMmio: what bus.js hooks into _mmioRead/_mmioWrite.
	// They are the SAME implementation as readByte/Word/Long, not a copy: that way there
	// is no way for the two paths to get out of sync.
	readMmio(addr, size)      { return this._read(addr, size); }
	writeMmio(addr, val, size) { this._write(addr, val, size); }

	// --- Direct API (tests, debugger, standalone use without a bus) ---
	readByte(addr) { return this._read(addr, 1) & 0xFF; }
	readWord(addr) { return this._read(addr, 2) & 0xFFFF; }
	readLong(addr) { return this._read(addr, 4) >>> 0; }

	writeByte(addr, val) { this._write(addr, val & 0xFF, 1); }
	writeWord(addr, val) { this._write(addr, val & 0xFFFF, 2); }
	writeLong(addr, val) { this._write(addr, val >>> 0, 4); }

	// Value of the ID register (0x04FFFFFF). It is ONE BYTE.
	readId() { return this.id; }

	// Read of the whole cartridge space (CS0 + CS1). Big-endian.
	// Ported from Yabause cs1.c (Cs1ReadByte/Word/Long) + the cs0.c handlers.
	//ok, 16-07-2026
	_read(addr, size)
	{
		const a = addr & 0x07FFFFFF;   // same masking as bus.js (cached mirrors)

		// ---------------- CS1: backup cart + ID register ----------------
		if(a >= CART_CS1_START && a < CART_CS1_END)
		{
			// The ID wins over whatever is mapped below (Yabause cs1.c).
			const off = a & 0xFFFFFF;
			if(size === 1 && off === 0xFFFFFF) return this.id;
			if(size === 2 && off === 0xFFFFFE) return (0xFF00 | this.id) & 0xFFFF;
			if(size === 4 && off === 0xFFFFFC) return (0xFF00FF00 | (this.id << 16) | this.id) >>> 0;

			if(this.bupram) return this._readBuf(this.bupram, a, this.window, size);
			return this._busOpen(size);
		}

		// ---------------- CS0: RAM cart / ROM cart ----------------
		if(a >= CART_CS0_START && a < CART_CS0_END)
		{
			if(this.rom) return this._readBuf(this.rom, a, 0x1FFFFF, size);

			if(this.dram)
			{
				const o = this._offsetDram(a);
				if(o < 0) return this._busOpen(size);   // outside the cart window
				return this._readBufOffset(this.dram, o, size);
			}
		}

		// Outside the slot, or no cartridge: open bus.
		return this._busOpen(size);
	}

	// Write to the whole cartridge space. The ID and the ROM ignore writes.
	//ok, 16-07-2026
	_write(addr, val, size)
	{
		const a = addr & 0x07FFFFFF;

		if(a >= CART_CS1_START && a < CART_CS1_END)
		{
			// Writing the ID register does nothing (Yabause cs1.c Cs1Write*).
			const off = a & 0xFFFFFF;
			if(size === 1 && off === 0xFFFFFF) return;
			if(size === 2 && off === 0xFFFFFE) return;
			if(size === 4 && off === 0xFFFFFC) return;

			if(this.bupram)
			{
				this._writeBuf(this.bupram, a, this.window, val, size);
				this.dirty = true;   // it has to be persisted (same contract as bus.backupDirty)
			}
			return;
		}

		if(a >= CART_CS0_START && a < CART_CS0_END)
		{
			if(this.rom) return;   // the ROM cart is read-only

			if(this.dram)
			{
				const o = this._offsetDram(a);
				if(o < 0) return;   // outside the window: the write is lost
				this._writeBufOffset(this.dram, o, val, size);
			}
		}
	}

	// Translates a CS0 address to the offset inside the DRAM buffer.
	// Returns -1 if the address does not fall in the cartridge window.
	//ok, 16-07-2026
	_offsetDram(a)
	{
		// Both RAM carts live in the SAME window: 0x02400000-0x027FFFFF.
		if(a < 0x02400000 || a >= 0x02800000) return -1;

		// 4 MB: 4 contiguous MB, no holes.
		if(this.type === Cartridge.RAM_4M) return a & 0x3FFFFF;

		// 1 MB: bit21 picks the 512 KB half; bits 19 and 20 are not decoded
		// (hence the mirrors). Equivalent to Mednafen's ExtRAM_Mask = 0x27FFFE,
		// but compacted into a 1 MB buffer instead of a 4 MB one.
		return ((a & 0x200000) ? 0x80000 : 0) | (a & 0x7FFFF);
	}

	// ---- big-endian access helpers ----
	// They mask byte by byte like bus.js (b[(a + i) & m]), so the slow
	// path and the page table give the same result at the end of the buffer too.

	_readBuf(buf, a, mask, size)
	{
		let v = 0;
		for(let i = 0; i < size; i++) v = ((v << 8) | buf[(a + i) & mask]) >>> 0;
		return v >>> 0;
	}

	_writeBuf(buf, a, mask, val, size)
	{
		for(let i = 0; i < size; i++)
			buf[(a + i) & mask] = (val >>> ((size - 1 - i) * 8)) & 0xFF;
	}

	// Variants with the offset already resolved (the 1 MB DRAM cannot be expressed with
	// a single mask: the half is picked by bit21).
	_readBufOffset(buf, o, size)
	{
		let v = 0;
		const m = buf.length - 1;
		for(let i = 0; i < size; i++) v = ((v << 8) | buf[(o + i) & m]) >>> 0;
		return v >>> 0;
	}

	_writeBufOffset(buf, o, val, size)
	{
		const m = buf.length - 1;
		for(let i = 0; i < size; i++)
			buf[(o + i) & m] = (val >>> ((size - 1 - i) * 8)) & 0xFF;
	}

	// Open bus: with nobody answering, the lines stay high.
	// Yabause DummyCs0Read*: 0xFF / 0xFFFF / 0xFFFFFFFF.
	_busOpen(size)
	{
		if(size === 1) return 0xFF;
		if(size === 2) return 0xFFFF;
		return 0xFFFFFFFF >>> 0;
	}

	// ==================================================================
	//   BACKUP: format and persistence
	// ==================================================================

	// Leaves the backup cart like one freshly formatted by the BIOS.
	// Ported from FormatBackupRam (Yabause memory.c): the signature "BackUpRam Format"
	// repeated 4 times in the ODD bytes, with the EVEN ones at 0xFF, and the rest
	// of the area at even=0xFF / odd=0x00.
	//ok, 16-07-2026
	formatBackup()
	{
		if(!this.bupram) return false;
		const b = this.bupram, n = b.length, f = CART_SIGNATURE_BACKUP;

		// Header: 4 repetitions x 16 characters x 2 bytes = 0x80 bytes.
		for(let rep = 0; rep < 4; rep++)
			for(let c = 0; c < f.length; c++)
			{
				b[(rep * 32) + c * 2]     = 0xFF;                  // even: open bus
				b[(rep * 32) + c * 2 + 1] = f.charCodeAt(c);       // odd: the signature
			}

		// Rest of the area: empty.
		for(let i = 0x80; i < n; i += 2) { b[i] = 0xFF; b[i + 1] = 0x00; }

		this.dirty = true;
		return true;
	}

	// Does it have the format signature? (for the UI: "formatted / unformatted")
	estaFormatted()
	{
		if(!this.bupram) return false;
		for(let c = 0; c < CART_SIGNATURE_BACKUP.length; c++)
			if(this.bupram[1 + c * 2] !== CART_SIGNATURE_BACKUP.charCodeAt(c)) return false;
		return true;
	}

	// Bytes used in the usable area (the non-zero odd ones). Approximation for the UI,
	// same as index.html's countBackupUsed().
	backupUsed()
	{
		if(!this.bupram) return 0;
		let used = 0;
		for(let i = 1; i < this.bupram.length; i += 2) if(this.bupram[i] !== 0) used++;
		return used;
	}

	// The orchestrator flushes the buffer to IndexedDB and clears the mark.
	clearDirty() { this.dirty = false; }

	// ==================================================================
	//   RAW BUFFER ACCESS (export/import to a file, IndexedDB)
	// ==================================================================

	// The cartridge's buffer as is, to persist or export it. null if there is none.
	// It is the LIVE buffer, not a copy: to save it, do .slice() (same as
	// index.html's saveBackupSiDirty() with bus.backupRam).
	bufferRaw() { return this.buf; }

	// Loads raw bytes into the cartridge (file import, IndexedDB restore,
	// or the KOF'95 / Ultraman ROM). Copies whatever fits and reports if it does not match.
	//ok, 16-07-2026
	loadBuffer(bytes)
	{
		if(!this.buf || !bytes || !bytes.length) return false;
		const n = Math.min(bytes.length, this.buf.length);
		this.buf.set(bytes.subarray ? bytes.subarray(0, n) : bytes.slice(0, n));
		this.dirty = true;
		return n === this.buf.length;   // false = the file was not the expected size
	}

	// Usable size in bytes: the backup only uses the odd ones, the rest use everything.
	utilSize()
	{
		if(!this.buf) return 0;
		return this.bupram ? (this.buf.length >> 1) : this.buf.length;
	}

	// ==================================================================
	//   GAME DATABASE: which cartridge each disc asks for
	// ==================================================================

	// Ported from Mednafen's database (mednafen/ss/db.c). The key is the product
	// number in the disc header (offset 0x20 of the first sector, which
	// cd.js already parses). The ones marked "required" DO NOT BOOT without the cartridge.
	//
	// It lets the orchestrator pick the cartridge on its own when mounting a disc,
	// instead of the user guessing (see "HOW TO HOOK IT UP", patch 5).
	//ok, 16-07-2026
	static typeForSerial(serial)
	{
		if(!serial) return Cartridge.NONE;
		const s = String(serial).trim().toUpperCase();
		const t = CART_GAMES[s];
		return (t === undefined) ? Cartridge.NONE : t;
	}

	// Readable name of a type (for the UI and the logs).
	static nameOfType(type)
	{
		const spec = CART_SPECS[type];
		return spec ? spec.name : ("unknown (" + type + ")");
	}

	// ID returned by a type, without having to instantiate it.
	static idOfType(type)
	{
		const spec = CART_SPECS[type];
		return spec ? spec.id : 0xFF;
	}
}

// Game database -> cartridge. Ported from mednafen/ss/db.c.
// Careful with the file names: the "(1M)" / "(4M)" suffix of the
// Redump sets is a disc pressing code, NOT the cartridge size. What
// counts is the product number in the header. Real example from this repo:
// "X-Men vs. Street Fighter (Japan) (1M).bin" has serial T-1226G and asks for the
// 4 MB cartridge (the game came IN THE BOX with the 4 MB cart).
const CART_GAMES =
{
	// --- 1 MB RAM cart ---
	"T-1521G":   Cartridge.RAM_1M,   // Astra Superstars (Japan)
	"T-9904G":   Cartridge.RAM_1M,   // Cotton 2 (Japan)
	"T-1217G":   Cartridge.RAM_1M,   // Cyberbots (Japan)
	"GS-9107":   Cartridge.RAM_1M,   // Fighter's History Dynamite (Japan)   [required]
	"T-20109G":  Cartridge.RAM_1M,   // Friends (Japan)
	"T-14411G":  Cartridge.RAM_1M,   // Groove on Fight (Japan)              [required]
	"T-7032H-50":Cartridge.RAM_1M,   // Marvel Super Heroes (Europe)
	"T-1215G":   Cartridge.RAM_1M,   // Marvel Super Heroes (Japan)
	"T-3111G":   Cartridge.RAM_1M,   // Metal Slug (Japan)                   [required]
	"T-22205G":  Cartridge.RAM_1M,   // Noel 3 (Japan)
	"T-20114G":  Cartridge.RAM_1M,   // Pia Carrot e Youkoso!! 2 (Japan)
	"T-3105G":   Cartridge.RAM_1M,   // Real Bout Garou Densetsu (Japan)     [required; incompatible with the 4 MB one]
	"T-99901G":  Cartridge.RAM_1M,   // Real Bout Garou Densetsu Demo        [required; incompatible with the 4 MB one]
	"T-3119G":   Cartridge.RAM_1M,   // Real Bout Garou Densetsu Special     [required]
	"T-3116G":   Cartridge.RAM_1M,   // Samurai Spirits - Amakusa Kourin     [required; incompatible with the 4 MB one]
	"T-3104G":   Cartridge.RAM_1M,   // Samurai Spirits - Zankurou Musouken  [required]
	"610636008": Cartridge.RAM_1M,   // Tech Saturn 1997.6 (Japan)
	"T-16509G":  Cartridge.RAM_1M,   // Super Real Mahjong P7 (Japan)
	"T-16510G":  Cartridge.RAM_1M,   // Super Real Mahjong P7 (Japan)
	"T-3108G":   Cartridge.RAM_1M,   // The King of Fighters '96 (Japan)     [required]
	"T-3121G":   Cartridge.RAM_1M,   // The King of Fighters '97 (Japan)     [required]
	"T-1515G":   Cartridge.RAM_1M,   // Waku Waku 7 (Japan)                  [required]

	// --- 4 MB RAM cart ---
	"T-1245G":   Cartridge.RAM_4M,   // Dungeons and Dragons Collection      [required: "Shadow over Mystara"]
	"T-1248G":   Cartridge.RAM_4M,   // Final Fight Revenge (Japan)          [required]
	"T-1238G":   Cartridge.RAM_4M,   // Marvel Super Heroes vs. Street Fighter [required]
	"T-1230G":   Cartridge.RAM_4M,   // Pocket Fighter (Japan)
	"T-1246G":   Cartridge.RAM_4M,   // Street Fighter Zero 3 (Japan)        [required]
	"T-1229G":   Cartridge.RAM_4M,   // Vampire Savior (Japan)               [required]
	"T-1226G":   Cartridge.RAM_4M,   // X-Men vs. Street Fighter (Japan)     [required]

	// --- ROM cart (the dump of the cartridge ROM has to be supplied) ---
	"MK-81088":  Cartridge.ROM_16M,  // The King of Fighters '95 (Europe)    [required]
	"T-3101G":   Cartridge.ROM_16M,  // The King of Fighters '95 (Japan)     [required]
	"T-13308G":  Cartridge.ROM_16M,  // Ultraman - Hikari no Kyojin Densetsu [required]

	// --- Backup cart (not required: it only enables/fixes saves) ---
	"T-16804G":  Cartridge.BACKUP_512K,  // Dezaemon 2 (Japan)      - allows saving
	"T-26104G":  Cartridge.BACKUP_512K,  // Kouryuu Sangoku Engi (Japan)
	"GS-9197":   Cartridge.BACKUP_512K,  // Sega Ages - Galaxy Force II - saves replays
	// These TWO hang if a RAM cart is inserted (Mednafen db.c warns about it):
	// mapping them to the backup is precisely the way to make sure no RAM cart is left in.
	"GS-9123":   Cartridge.BACKUP_512K,  // Die Hard Trilogy (Japan)
	"T-16103H":  Cartridge.BACKUP_512K   // Die Hard Trilogy (Europe/USA)
};

/*
 * ####################################################################
 *                        HOW TO HOOK IT UP
 * ####################################################################
 * Patches 1 to 4: DONE on 16-07-2026 (they stay documented because they are
 * the map of where the cartridge passes through, not a task list).
 *
 * --- PATCH 1 [DONE]: index.html, load the script ---
 *     <script src="cart.js?v=49"></script>, before bus.js.
 *
 * --- PATCH 2 [DONE]: bus.js, constructor() ---
 *     this.cart = null;  next to this.scspEngine, BEFORE
 *     this._buildPages().
 *
 * --- PATCH 3 [DONE]: bus.js, _buildPages() ---
 *     At the end of the method it installs the ranges of this.cart.pages() with
 *     the same set() as the rest of the RAM, and propagates the backup mark.
 *     Also, bus.putCartridge(cart) rebuilds the table on the fly.
 *
 * --- PATCH 4 [DONE]: bus.js, _mmioRead() and _mmioWrite() ---
 *     They delegate 0x02000000-0x04FFFFFF to cart.readMmio()/writeMmio()
 *     right before the _registerUnknown() at the end, and
 *     cart.dirty sets bus.backupDirty.
 *
 * --- PATCH 5 [MISSING - IT BELONGS TO index.html]: pick and install the cart ---
 *     It is the only one left, and it belongs to index.html: today nobody calls
 *     putCartridge(), so bus.cart stays null = no cartridge.
 *     In the function that mounts the disc, RIGHT AFTER the
 *     "if(!ok || !bus.mountDisc(reader)){ ... return; }"
 *     and BEFORE the "const h = reader.info();", add:
 *
 *         // The cartridge is asked for by the game: it comes from the product number in the
 *         // disc header, which cd.js already parses (info().productNumber, e.g. "T-1226G   ";
 *         // typeForSerial() trims it). Do NOT use the file name: the
 *         // "(1M)" of the Redump sets is a pressing code, not the cartridge.
 *         const cartType = Cartridge.typeForSerial((reader.info() || {}).productNumber);
 *         bus.putCartridge(cartType === Cartridge.NONE ? null : new Cartridge(cartType));
 *
 *     For the ROM cart (KOF'95 / Ultraman) the dump of the cartridge ROM also has
 *     to be supplied: cart.loadBuffer(bytes).
 *
 * --- VERIFY THAT IT GOT HOOKED UP (otherwise it does not count) ---
 *     With the X-Men vs. Street Fighter disc mounted, in the console:
 *
 *         bus.cart.name                -> "RAM cart 4 MB (32 Mbit DRAM)"
 *         bus.readByte(0x24FFFFFF)     -> 0x5C   (the ID; without a cartridge it gives 0)
 *         bus.writeLong(0x22400000, 0x12345678);
 *         bus.readLong(0x22400000)     -> 0x12345678
 *
 *     Patches 2-4 are covered by cd.test.mjs ("CARTRIDGE" section), which builds
 *     the real Bus and Cartridge and verifies both paths: the page table
 *     (the DRAM) and the MMIO path (the ID register and open bus).
 * ####################################################################
 */

// Loaded with <script> in the browser (globalThis) and with require() in Node
// (module.exports) for the tests, same as cd.js and scu.js.
if(typeof module !== "undefined" && module.exports)
	module.exports = Cartridge;
if(typeof globalThis !== "undefined")
	globalThis.Cartridge = Cartridge;
