/**
 *    Name:         cd.test.mjs
 *    Description:  Tests of the CdReader and of the bus's CD block / SCU / SMPC / cartridge.
 *                  Builds a minimal synthetic ISO9660 image (Saturn header in sector
 *                  0, PVD at LBA 16, a root directory with one file) and checks:
 *                    - the parsing of the header, of the PVD and the file listing/search
 *                    - the A-bus CS2 decode (which addresses the CD block answers)
 *                    - Put/Copy/Move Sector Data and Get Sector Number of the CD block
 *                    - the routing of the audio sectors (CDDA) to the SCSP
 *                    - Get Sector Info, the search by FAD and the Scan of the CD block
 *                    - the SCU Timer 1
 *                    - CKCHG320/352, OREG31, SETSMEM and the SMPC INTBACK status
 *                    - the A-bus cartridge slot (cart.js hooked to the bus)
 *                  Run with: node cd.test.mjs
 *    Version:      0.3.0
 *    Created:      15-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 */

import { readFileSync } from "fs";
// cd.js and bus.js are browser scripts (global class). We load them with eval
// because it is the project's own trusted code; there is no external input.
eval(readFileSync("cd.js", "utf8") + "\nglobalThis.CdReader=CdReader;");
eval(readFileSync("cart.js", "utf8") + "\nglobalThis.Cartridge=Cartridge;");
eval(readFileSync("bus.js", "utf8") + "\nglobalThis.Bus=Bus;");

let passed = 0, failed = 0;
function check(name, expected, obtained)
{
	if(expected === obtained) passed++;
	else { failed++; console.log("  FAIL", name, "exp", expected, "got", obtained); }
}

// ---- Builder of the synthetic ISO9660 image (2048-byte logical sectors) ----
const SEC = 2048;
const img = new Uint8Array(22 * SEC);   // 22 sectors are enough for the minimal tree

function put(str, off)
{
	for(let i = 0; i < str.length; i++) img[off + i] = str.charCodeAt(i);
}
// little-endian u32 (ISO9660 "both-endian" field, the LE side the parser uses).
function u32le(v, off)
{
	img[off]     = v & 0xFF;
	img[off + 1] = (v >>> 8) & 0xFF;
	img[off + 2] = (v >>> 16) & 0xFF;
	img[off + 3] = (v >>> 24) & 0xFF;
}
function u16le(v, off) { img[off] = v & 0xFF; img[off + 1] = (v >>> 8) & 0xFF; }

// --- Sector 0: Saturn CD-ROM header ("SEGA SEGASATURN ") ---
put("SEGA SEGASATURN ", 0x00);           // system
put("SEGA TP T-000  ", 0x10);            // maker
put("T-00000G  ", 0x20);                 // product number
put("V1.000", 0x2A);                     // version
put("20260715", 0x30);                   // date YYYYMMDD
put("CD-1/1  ", 0x38);                   // device
put("J               ", 0x40);           // region (Japan)
put("J               ", 0x50);           // peripherals
put("TEST GAME SATURN", 0x60);           // title

// --- LBA 16 (offset 16*2048): Primary Volume Descriptor ---
const pvd = 16 * SEC;
img[pvd + 0] = 1;                          // type 1 = PVD
put("CD001", pvd + 1);                   // ISO9660 magic
img[pvd + 6] = 1;                          // version
u16le(SEC, pvd + 128);                     // logical block size = 2048
// Directory record of the root at offset 156 (34 bytes)
const root = 18;                           // LBA of the root directory
img[pvd + 156 + 0]  = 34;                  // record len
u32le(root, pvd + 156 + 2);                // extent LBA (LE)
u32le(SEC,  pvd + 156 + 10);               // data length (LE)
img[pvd + 156 + 25] = 0x02;                // flags: bit1 = directory
img[pvd + 156 + 32] = 1;                   // idLen
img[pvd + 156 + 33] = 0x00;                // identifier "." (root)

// --- LBA 17: descriptor set terminator (type 255) ---
const term = 17 * SEC;
img[term + 0] = 255;
put("CD001", term + 1);
img[term + 6] = 1;

// --- LBA 18: root directory (. / .. / TEST.TXT) ---
const addr = root * SEC;
let o = addr;
// "." (self)
img[o + 0] = 34; u32le(root, o + 2); u32le(SEC, o + 10); img[o + 25] = 0x02;
img[o + 32] = 1; img[o + 33] = 0x00; o += 34;
// ".." (parent)
img[o + 0] = 34; u32le(root, o + 2); u32le(SEC, o + 10); img[o + 25] = 0x02;
img[o + 32] = 1; img[o + 33] = 0x01; o += 34;
// "TEST.TXT;1" (file at LBA 19, 12 bytes)
const fileName = "TEST.TXT;1";
const lenFile = 33 + fileName.length;                 // 43 -> padded to even (44)
const lenFilePad = lenFile + (lenFile & 1);
img[o + 0] = lenFilePad; u32le(19, o + 2); u32le(12, o + 10); img[o + 25] = 0x00;
img[o + 32] = fileName.length; put(fileName, o + 33);

// --- LBA 19: file content ---
put("HOLA SATURN\n", 19 * SEC);

// ------------------------------- Test run -------------------------------
const reader = new CdReader();
const mounted = reader.loadImage(img, "test.iso");
check("image mounted", true, mounted);
check("one data track", 1, reader.tracks.length);
check("detected sector size 2048", 2048, reader.tracks[0].sectorSize);

// Saturn header
const info = reader.info();
check("header parsed (not null)", true, info !== null);
check("game title", "TEST GAME SATURN", info ? info.title : null);
check("product number", "T-00000G", info ? info.productNumber : null);
check("region includes Japan", true, !!info && info.regions.indexOf("Japan") >= 0);

// ISO9660: listing and search
const listing = reader.listFiles("/");
check("root lists 1 file", 1, listing.length);
check("file name (without ;1)", "TEST.TXT", listing[0] ? listing[0].name : null);
check("file lba", 19, listing[0] ? listing[0].lba : null);

const found = reader.findFile("TEST.TXT");
check("findFile finds it", true, found !== null);
check("file size", 12, found ? found.size : null);

// Reading the content
const content = found ? reader.readFile(found.lba, found.size) : null;
const txt = content ? String.fromCharCode.apply(null, content) : null;
check("file content", "HOLA SATURN\n", txt);

// ================================================================================
//   A-BUS CS2 DECODE: which addresses the CD block answers and which it does NOT
// ================================================================================
// The CD block chip (the YGR) has ONLY the lines AA[5:2] (which
// register) and AA[14:12] (chip select) wired: "Only address bits AA[5:2] and AA[14:12] are
// connected to YGR" (srg320, author of the Saturn FPGA core, SegaXtreme "A-Bus CS2").
// Everything that falls outside is A-Bus CARTRIDGE area, where the NETLINK modem lives
// (UART 16550 at 0x05895001 + reg*4, odd byte; see Yabause netlink.c).
// See Bus._cdDecodes in bus.js.

// --- The decode itself ---
check("decode: HIRQ 0x05890008",          true,  Bus._cdDecodes(0x05890008));
check("decode: HIRQ mask 0x0589000C",     true,  Bus._cdDecodes(0x0589000C));
check("decode: CR1 0x05890018",           true,  Bus._cdDecodes(0x05890018));
check("decode: CR4 0x05890024",           true,  Bus._cdDecodes(0x05890024));
// A15 does NOT reach the chip: 0x05898000 is the SAME DTR as 0x05818000 (the BIOS
// reads the TOC through there in 16-bit words).
check("decode: DTR 0x05898000 (A15 does not reach the chip)", true, Bus._cdDecodes(0x05898000));
check("decode: DTR 0x05818000",           true,  Bus._cdDecodes(0x05818000));
// AA[14:12] != 0 -> the chip does not answer: it belongs to the cartridge.
check("decode: Netlink RBR 0x05895001 is NOT the CD block",     false, Bus._cdDecodes(0x05895001));
check("decode: Netlink MSR 0x05895019 is NOT the CD block",     false, Bus._cdDecodes(0x05895019));
check("decode: Netlink Scratch 0x0589501D is NOT the CD block", false, Bus._cdDecodes(0x0589501D));
check("decode: 0x05891000 (AA12=1) is NOT the CD block",        false, Bus._cdDecodes(0x05891000));
check("decode: 0x0589F000 (AA[14:12]=7) is NOT the CD block",   false, Bus._cdDecodes(0x0589F000));

// --- Observable behavior on the bus ---
const bus = new Bus();
bus.mountDisc(reader);

// The CD block still answers where it should: the power-on HIRQ carries the
// "operation finished" flags (see the Bus constructor).
check("bus: 0x05890008 returns the HIRQ", bus.cdHirq, bus.readWord(0x05890008));
// ...and in its mirror every 64 bytes within the same 4 KB block.
check("bus: 0x05890048 mirrors the HIRQ (every 64 B)", bus.cdHirq, bus.readWord(0x05890048));

// THE SEGA RALLY BUG (Netlink Edition): the game runs the classic presence test
// of the 16550 UART -it writes 0x5A and 0xA1 to the Scratch (reg 7 = 0x0589501D) and reads them back-.
// With the CD block mirrored across the 64 KB, 0x1D is the low byte of CR2 and it
// gave them back intact: the game took for granted that a modem was connected.
// Without a cartridge nobody answers -> open bus (Mednafen models it as 0: ss.c pre-clears
// the data bus with "*DB = 0" and the dummy handler does not touch it).
const cr2Before = bus._readRegBE(bus.cdRegs, 0x1C, 2);
bus.writeByte(0x0589501D, 0x5A);
check("Netlink: the scratch does NOT return what was written (there is no modem)", 0, bus.readByte(0x0589501D));
bus.writeByte(0x0589501D, 0xA1);
check("Netlink: the scratch still returns nothing", 0, bus.readByte(0x0589501D));
check("Netlink: writing the scratch does NOT stomp the CD block's CR2", cr2Before, bus._readRegBE(bus.cdRegs, 0x1C, 2));
// The Modem Status Register: with 0x80 (DCD=1, CTS=0) Rally keeps waiting for a
// carrier forever. Without a modem it has to read open bus.
check("Netlink: MSR 0x05895019 reads open bus, not the low byte of CR1", 0, bus.readByte(0x05895019));

// A write in the cartridge area must NOT be able to fire a CD block command:
// UART reg 9 would land at 0x25895025 -> off 0x24 (CR4), which is the trigger.
const hirqBefore = bus.cdHirq;
bus.cdHirq = 0;
bus.writeWord(0x05895024, 0x0000);
check("cartridge: writing to 0x05895024 does NOT fire a CD command", 0, bus.cdHirq);
bus.cdHirq = hirqBefore;

// ================================================================================
//   CD BLOCK: Put / Copy / Move Sector Data (0x64-0x66)
// ================================================================================
// Ported from Mednafen cdb.c (COMMAND_PUT_SECDATA / COPY_SECDATA / MOVE_SECDATA).
// All three were missing, but the Get Copy Error (0x67) that reports how they
// went WAS there: we had the error report of an operation that did not exist.

// --- Helper: send a command to the CD block the way the game does ---
// The command is built in CR1-CR4 and it is FIRED by the write to CR4 (offset 0x24).
//
// And THEN CMOK IS AWAITED, which is the other half of the protocol: the CD block has its
// own processor and does NOT answer in the same cycle (see the timing model in bus.js).
// Until 25-07-2026 the command was resolved inside the CR4 write, so this
// helper read the response without waiting for anything — and that left 64 checks in this file
// written against an instantaneous CD block, which is what the real hardware is not. Waiting here is
// exactly what a real game does, and it leaves the checks measuring the behavior and
// not the implementation.
function cdCmd(cr1, cr2, cr3, cr4)
{
	bus.cdHirq = 0;
	bus.writeWord(0x05890018, cr1);
	bus.writeWord(0x0589001C, cr2);
	bus.writeWord(0x05890020, cr3);
	bus.writeWord(0x05890024, cr4);   // trigger
	// Run time forward until the CD block answers (CMOK). The guard avoids hanging the
	// test if a command does not answer: that would be a bug and the check has to fail, not
	// keep spinning.
	for(let i = 0; i < 500 && !(bus.cdHirq & 0x0001); i++) bus.cdTick(0.05);
}
const CR = (n) => bus._readRegBE(bus.cdRegs, 0x18 + n * 4, 2);

// The CD block starts unauthenticated and with the "CDBLOCK" signature set; the buffer
// commands do not need it, but it does need to not be authenticating.
const cd = bus.cd;

// --- Put Sector Data: the HOST writes a sector and the CD block stores it ---
// 2 sectors are requested through filter 3. The filters start with mode=0 (pass everything)
// and connTrue=i, so filter 3 deposits into partition 3.
const freeBefore = cd.free.length;
cdCmd(0x6400, 0, 3 << 8, 2);
check("PutSecData: answers DTREQ (not rejected)", 0x40, (CR(0) >> 8) & 0x40);
check("PutSecData: fires DRDY", 0x0002, bus.cdHirq & 0x0002);
check("PutSecData: the transfer is left in WRITE mode", true, cd.dt.active && cd.dt.writing);
check("PutSecData: reserves one buffer per sector", freeBefore - 2, cd.free.length);
check("PutSecData: nothing lands in the partition until End Data Transfer", 0, cd.part[3].length);
// putSecLen=0 (2048): the hardware writes 1024 words starting at word 12
// (Mednafen DTW_OffsTab/DTW_CountTab). We write the 2048 words of the 2 sectors.
check("PutSecData: starts at word 12 of the buffer", 12, cd.dt.offWord);
check("PutSecData: expects 1024 words per sector", 1024, cd.dt.remaining);
const buf0 = cd.dt.list[0], buf1 = cd.dt.list[1];
for(let i = 0; i < 2048; i++) bus.writeWord(0x05890000, (i + 1) & 0xFFFF);
check("PutSecData: the first word landed on byte 24 of the buffer (word 12)",
	0x0001, (cd.data[buf0 * 2352 + 24] << 8) | cd.data[buf0 * 2352 + 25]);
check("PutSecData: word 1024 closed the sector and continued in the 2nd buffer",
	0x0401, (cd.data[buf1 * 2352 + 24] << 8) | cd.data[buf1 * 2352 + 25]);
check("PutSecData: nothing was written before word 12 (the mode's offset)",
	0, cd.data[buf0 * 2352 + 22]);
check("PutSecData: total counter = 2048 words", 2048, cd.dt.total);
// End Data Transfer: ONLY NOW do the buffers go through the filter.
cdCmd(0x0600, 0, 0, 0);
check("PutSecData: End Data Transfer returns the transferred words", 2048, CR(1));
check("PutSecData: the 2 sectors go into the filter's partition", 2, cd.part[3].length);
check("PutSecData: fires EHST on closing", 0x0080, bus.cdHirq & 0x0080);
check("PutSecData: the transfer is left closed", false, cd.dt.active);

// --- Copy Sector Data: duplicates the sectors, the source keeps them ---
const freePreCopy = cd.free.length;
cdCmd(0x6505, 0, 3 << 8, 2);   // dst filter 5, src partition 3, offset 0, 2 sectors
check("CopySecData: the SOURCE partition keeps its sectors", 2, cd.part[3].length);
check("CopySecData: the destination partition gets the copy", 2, cd.part[5].length);
check("CopySecData: consumes 2 free buffers (they are new copies)", freePreCopy - 2, cd.free.length);
check("CopySecData: fires ECPY", 0x0100, bus.cdHirq & 0x0100);
check("CopySecData: copies the BYTES, not the reference", false, cd.part[3][0] === cd.part[5][0]);
check("CopySecData: the copied content is identical",
	(cd.data[cd.part[3][0] * 2352 + 24] << 8) | cd.data[cd.part[3][0] * 2352 + 25],
	(cd.data[cd.part[5][0] * 2352 + 24] << 8) | cd.data[cd.part[5][0] * 2352 + 25]);

// --- Move Sector Data: takes them out of the source. It does NOT consume free buffers ---
const freePreMove = cd.free.length;
const bufMoved = cd.part[3][0];
cdCmd(0x6607, 0, 3 << 8, 2);   // dst filter 7, src partition 3, offset 0, 2 sectors
check("MoveSecData: the SOURCE partition is left empty", 0, cd.part[3].length);
check("MoveSecData: the destination partition gets the sectors", 2, cd.part[7].length);
check("MoveSecData: does NOT consume free buffers (it moves, it does not copy)", freePreMove, cd.free.length);
check("MoveSecData: it is the SAME buffer, not a copy", bufMoved, cd.part[7][0]);
check("MoveSecData: fires ECPY", 0x0100, bus.cdHirq & 0x0100);

// --- Rejections and retries (the limits Mednafen sets) ---
cdCmd(0x6400, 0, 0x18 << 8, 1);   // filter 0x18: out of range
check("PutSecData: filter >= 24 -> rejected (status 0xFF)", 0xFF, (CR(0) >> 8) & 0xFF);
cdCmd(0x6400, 0, 3 << 8, 0);      // 0 sectors
check("PutSecData: 0 sectors -> WAIT, it does not start", false, cd.dt.active);
cdCmd(0x6505, 0, 0x18 << 8, 1);
check("CopySecData: source partition >= 24 -> rejected", 0xFF, (CR(0) >> 8) & 0xFF);
cdCmd(0x6518, 0, 3 << 8, 1);
check("CopySecData: destination filter >= 24 -> rejected", 0xFF, (CR(0) >> 8) & 0xFF);

// --- Get Sector Number (0x51): CMOK and NOTHING ELSE ---
// Yabause sends CMOK|DRDY (Cs2GetSectorNumber: HIRQ |= CDB_HIRQ_CMOK|CDB_HIRQ_DRDY),
// but it is a SPURIOUS DRDY: the command does not transfer a single byte, it only returns a
// counter in CR4. Mednafen sends it through BasicResults(), which fires CMOK alone.
// This check nails the decision down: if someone "fixes" this by copying Yabause,
// the test catches it.
cdCmd(0x5100, 0, 7 << 8, 0);
check("GetSecNum: returns the number of sectors in the partition", 2, CR(3));
check("GetSecNum: fires CMOK", 0x0001, bus.cdHirq & 0x0001);
check("GetSecNum: does NOT fire DRDY (it transfers nothing; Yabause does, and it is wrong)",
	0, bus.cdHirq & 0x0002);

// --- Copy vs Move with the buffers exhausted: the two sides of the same condition ---
// Copy needs one free buffer per sector (they are new copies); Move allocates
// nothing, it only relinks, and that is why the hardware lets it through anyway (and it is faster).
// Mednafen: (numsec > FreeBufferCount && CTR.Command != COMMAND_MOVE_SECDATA).
const freeSaved = cd.free.slice();
cd.free.length = 0;
cdCmd(0x6509, 0, 7 << 8, 2);   // Copy: partition 7 -> filter 9
check("CopySecData: without free buffers it asks to retry (WAIT)", 0x80, (CR(0) >> 8) & 0x80);
check("CopySecData: ...and copies nothing", 0, cd.part[9].length);
cdCmd(0x6609, 0, 7 << 8, 2);   // Move: the same, but moving
check("MoveSecData: without free buffers it works anyway (it moves, it does not allocate)", 2, cd.part[9].length);
check("MoveSecData: ...and empties the source", 0, cd.part[7].length);
cd.free.push(...freeSaved);

// ================================================================================
//   CDDA: the audio tracks go to the SCSP, at 75 sectors/second
// ================================================================================
// The CD delivers the audio sectors DIRECTLY to the SCSP through the external digital input
// (EXTS0/1): they do not go through the buffers or the filters. The whole path existed in
// scsp.js (cddaBuf, _readCdda, the EFSDL/EFPAN mix) and NOBODY ran it because
// the CD never called receiveCdda(): no game had CD music.

// Bit 6 of the subchannel Q control/ADR tells data from audio.
check("cost: a DATA sector lasts 1 (150/s, the drive is 2x)",
	1, (bus.cd.pos.ctrlAdr = 0x41, bus._cdCostSector()));
check("cost: an AUDIO sector lasts 2 (75/s = 1/75 s per sector)",
	2, (bus.cd.pos.ctrlAdr = 0x01, bus._cdCostSector()));

// SCSP spy: the signature scsp.js already exposes (receiveCdda) is enough for us.
const received = [];
bus.scspEngine = { receiveCdda: (s) => received.push(s.slice(0, 4)) };
// The reader has to be playing a REAL range: freshly mounted, its
// playEnd is 0x800000 (FAD 0), i.e. "end reached", and the drive does not advance.
bus.cd.playStart = 0x800000 | 150;        // from the first sector of the disc
bus.cd.playEnd    = 0x800000 | 0x7FFFFF;   // to the end
bus.cd.pos.ctrlAdr = 0x01;          // AUDIO track
bus.cd.phase = "playing";
bus.cd.free.length = 0;           // without a single free buffer: audio does not care
bus._cdDriveStep();
check("CDDA: the audio sector is delivered to the SCSP", 1, received.length);
check("CDDA: it is 2352 bytes of raw PCM (not a CD block buffer)",
	true, received.length > 0 && received[0].length === 4);
check("CDDA: without free buffers AUDIO does not pause the reader (Mednafen only pauses data)",
	"playing", bus.cd.phase);
check("CDDA: audio does NOT consume CD block buffers", 0, bus.cd.free.length);
// A DATA track without free buffers DOES have to pause (BFUL): it is the other side
// of the same condition, and breaking it would leave the CD block reading into the void.
bus.cd.pos.ctrlAdr = 0x41;          // DATA track
bus.cd.phase = "playing";
bus.cdHirq = 0;
bus._cdDriveStep();
check("CDDA: whereas DATA without free buffers DOES pause", "paused", bus.cd.phase);
check("CDDA: ...and signals it with BFUL", 0x0008, bus.cdHirq & 0x0008);

// ================================================================================
//   CD BLOCK: Get Sector Info (0x54) and search by FAD (0x55 / 0x56)
// ================================================================================
// All three were missing: they fell into the default (which answers the status and does not hang).
// SECONDARY REFERENCE: there is no public documentation of the CD block, so the source is
// Mednafen cdb.c (COMMAND_GET_SECINFO / EXEC_FADSRCH / GET_FADSRCH). Yabause is no use
// here: its Cs2ExecFadSearch/Cs2GetFadSearchResults are literally "// finish me".

// The reader left the buffers exhausted in the previous section: they have to be given back.
cd.free.length = 0;
for(let i = 199; i >= 0; i--) cd.free.push(i);

// Leaves in buffer `b` the header of a raw sector, which is the ONLY thing the CD block
// has of an already stored sector: bytes 12-14 = absolute MSF in BCD (that is where the
// FAD comes from), byte 15 = mode, and in mode2 sectors the subheader (file, channel, submode, coding
// info) at 16-19.
function putSector(b, fad, mode, sub)
{
	const base = b * 2352;
	const aBcd = (v) => (((v / 10) | 0) << 4) | (v % 10);
	cd.data[base + 12] = aBcd((fad / 4500) | 0);        // M
	cd.data[base + 13] = aBcd(((fad / 75) | 0) % 60);   // S
	cd.data[base + 14] = aBcd(fad % 75);                // F
	cd.data[base + 15] = mode;
	for(let i = 0; i < 4; i++) cd.data[base + 16 + i] = sub ? sub[i] : 0;
}

// --- Get Sector Info: the header of a sector that is already in a partition ---
// FAD 74565 = 0x012345 on purpose: it does not fit in 16 bits, so it splits the high byte
// into CR1 and the low 16 into CR2. In MSF it is 16:34:15.
cd.part[4] = [30, 31, 32];
putSector(30, 74565, 0x02, [0x11, 0x22, 0x44, 0x55]);   // mode2: it has a subheader
putSector(31, 150, 0x01, null);                          // mode1: it does not
putSector(32, 300, 0x02, [0x77, 0x88, 0x99, 0xAA]);

cdCmd(0x5400, 0, 4 << 8, 0);
check("GetSecInfo: CR1 carries the HIGH byte of the header's FAD", 0x01, CR(0) & 0xFF);
check("GetSecInfo: CR2 carries the low 16 bits of the FAD", 0x2345, CR(1));
check("GetSecInfo: CR3 = file<<8 | channel (mode2 subheader)", 0x1122, CR(2));
check("GetSecInfo: CR4 = submode<<8 | coding info", 0x4455, CR(3));
check("GetSecInfo: fires CMOK", 0x0001, bus.cdHirq & 0x0001);
// Same case as the Get Sector Number DRDY: Yabause sends CMOK|ESEL and the ESEL is
// SPURIOUS -this command does not touch the selector, it only reads a header-. Mednafen sends it
// through BasicResults() = CMOK alone. If someone "fixes" it by copying Yabause, this catches it.
check("GetSecInfo: does NOT fire ESEL (it does not touch the selector; Yabause does, and it is wrong)",
	0, bus.cdHirq & 0x0040);

cdCmd(0x5400, 1, 4 << 8, 0);
check("GetSecInfo: a mode1 sector has NO subheader -> CR3/CR4 at zero", 0, CR(2) | CR(3));
check("GetSecInfo: ...but the header's FAD comes out anyway", 150, CR(1));

cdCmd(0x5400, 0xFFFF, 4 << 8, 0);
check("GetSecInfo: offset 0xFFFF = the LAST sector of the partition", 300, CR(1));
check("GetSecInfo: ...with its subheader", 0x7788, CR(2));

cdCmd(0x5400, 0, 0x18 << 8, 0);
check("GetSecInfo: partition >= 24 -> rejected", 0xFF, (CR(0) >> 8) & 0xFF);
cdCmd(0x5400, 3, 4 << 8, 0);   // the partition has 3 sectors: index 3 does not exist
check("GetSecInfo: offset outside the partition -> rejected", 0xFF, (CR(0) >> 8) & 0xFF);
// 0xFFFF on an EMPTY partition is also rejected: with no sectors there is no "last" one.
// It is a separate check (Partitions[pnum].Count == 0), the one above does not cover it.
cd.part[6] = [];
cdCmd(0x5400, 0xFFFF, 6 << 8, 0);
check("GetSecInfo: 0xFFFF on an EMPTY partition -> rejected", 0xFF, (CR(0) >> 8) & 0xFF);

// --- Exec FAD Search (0x55) + Get FAD Search Results (0x56) ---
// Searches, from the offset onward, for the sector with the HIGHEST FAD that does not exceed the requested one.
// It is the same pair as 0x52/0x53: one COMPUTES and signals with ESEL, the other RETRIEVES.
cd.part[8] = [40, 41, 42, 43];
putSector(40, 150, 0x01, null);
putSector(41, 300, 0x01, null);
putSector(42, 450, 0x01, null);
putSector(43, 300, 0x01, null);   // TIE with index 1, on purpose

// CR2 = offset, CR3 = partition<<8 | FAD high, CR4 = FAD low.
cdCmd(0x5500, 0, 8 << 8, 400);
check("ExecFadSearch: fires ESEL (it COMPUTES, same as 0x52)", 0x0040, bus.cdHirq & 0x0040);
cdCmd(0x5600, 0, 0, 0);
check("GetFadSearch: CR2 = index of the sector found", 1, CR(1));
check("GetFadSearch: CR3 high = the partition that was searched", 8, (CR(2) >> 8) & 0xFF);
check("GetFadSearch: CR4 = the FAD found (the HIGHEST that does not exceed the requested one)", 300, CR(3));
// Mednafen's "+match_made": once a match has been found it demands STRICTLY greater,
// so on a tie the lowest index stays (3 also has FAD 300).
check("GetFadSearch: on a tie the LOWEST index wins", 1, CR(1));
check("GetFadSearch: fires CMOK", 0x0001, bus.cdHirq & 0x0001);
check("GetFadSearch: does NOT fire ESEL (it only RETRIEVES what was already computed, same as 0x53)",
	0, bus.cdHirq & 0x0040);

cdCmd(0x5500, 0, 8 << 8, 100);
cdCmd(0x5600, 0, 0, 0);
check("ExecFadSearch: with no FAD <= the requested one -> spos 0xFFFF (not found)", 0xFFFF, CR(1));
check("ExecFadSearch: ...and the FAD stays at 0", 0, CR(3));

cdCmd(0x5500, 0, 8 << 8, 300);
cdCmd(0x5600, 0, 0, 0);
check("ExecFadSearch: the EXACT FAD is included (the condition is <=, not <)", 1, CR(1));

cdCmd(0x5500, 0, 8 << 8, 299);
cdCmd(0x5600, 0, 0, 0);
check("ExecFadSearch: with 299 it no longer takes the 300 and keeps the 150", 0, CR(1));
check("ExecFadSearch: ...and returns its FAD", 150, CR(3));

cdCmd(0x5500, 0, 8 << 8, 1000);
cdCmd(0x5600, 0, 0, 0);
check("ExecFadSearch: from offset 0 it finds the 450 (the highest of all)", 2, CR(1));
// The offset STARTS the search: from 3 onward the 450 (index 2) is already behind.
cdCmd(0x5500, 3, 8 << 8, 1000);
cdCmd(0x5600, 0, 0, 0);
check("ExecFadSearch: the offset STARTS the search (from 3 on, the 450 is behind)", 3, CR(1));
check("ExecFadSearch: ...and returns that sector's FAD", 300, CR(3));
cdCmd(0x5500, 0xFFFF, 8 << 8, 1000);
cdCmd(0x5600, 0, 0, 0);
check("ExecFadSearch: offset 0xFFFF starts at the LAST sector", 3, CR(1));

cdCmd(0x5500, 0, 0x18 << 8, 400);
check("ExecFadSearch: partition >= 24 -> rejected", 0xFF, (CR(0) >> 8) & 0xFF);
cdCmd(0x5500, 4, 8 << 8, 400);
check("ExecFadSearch: offset outside the partition -> rejected", 0xFF, (CR(0) >> 8) & 0xFF);
cdCmd(0x5500, 0xFFFF, 6 << 8, 400);
check("ExecFadSearch: 0xFFFF on an EMPTY partition -> rejected", 0xFF, (CR(0) >> 8) & 0xFF);

// The software reset wipes out the search result, alongside
// computedSize (Mednafen's SWReset resets FADSearch together with CalcedActualSize).
cdCmd(0x5500, 0, 8 << 8, 1000);
cdCmd(0x0401, 0, 0, 0);   // Initialize CD System with bit0 = software reset
cdCmd(0x5600, 0, 0, 0);
check("GetFadSearch: the software reset clears the search result", 0, CR(1));
check("GetFadSearch: ...all three fields", 0, CR(2) | CR(3));

// ================================================================================
//   CD BLOCK: Scan (0x12), fast forward/rewind
// ================================================================================
// The CD player's fast forward / rewind: the pickup plays a little bit,
// makes a jump, plays another little bit. SECONDARY REFERENCE (there is no public documentation
// of the CD block): Mednafen cdb.c COMMAND_SCAN + StartScan + DRIVEPHASE_PLAY. Yabause is no
// use as a source: its Cs2ScanDisc() sets the status to SCAN, says "// finish me" and leaves
// the reader playing normally, that is, LYING that it scans.

cdCmd(0x1202, 0, 0, 0);
check("Scan: direction >= 2 -> rejected (there is only forward and backward)", 0xFF, (CR(0) >> 8) & 0xFF);
check("Scan: ...and no scan starts", -1, cd.scanMode);

// The test disc is DATA: each sector "costs" 1 (an audio one would cost 2).
bus._cdPositionFrom(0x800000 | 150);
check("Scan: (the test disc is a data track)", 1, bus._cdCostSector());

cd.playStart = 0x800000 | 150;        // open range: so it does not stop at the end of the range
cd.playEnd    = 0x800000 | 0x7FFFFF;
cd.currentSector = 150;
cd.phase = "playing";
cdCmd(0x1200, 0, 0, 0);
check("Scan: starts the forward scan", 0, cd.scanMode);
check("Scan: answers CMOK", 0x0001, bus.cdHirq & 0x0001);
check("Scan: the reader was already playing, it does not seek again", "playing", cd.phase);

// 6 "costs" are played and ONLY THEN does it jump: the first 5 steps advance by 1.
for(let i = 0; i < 5; i++) bus._cdDriveStep();
check("Scan: until it reaches the jump it advances one sector at a time", 155, cd.currentSector);
check("Scan: and it reports the SCAN status (0x05), not PLAY (0x03)", 0x05, cd.pos.status);
// The 6th completes the count and makes the jump: 155 + 102 (near the center the term
// that scales with the radius still gives 0).
bus._cdDriveStep();
check("Scan: at the 6th sector it makes the jump (155 + 102)", 257, cd.currentSector);
check("Scan: ...and the count goes back to zero", 0, cd.scanCount);

// The end of range stops the scan just like it stops normal playback: the jump already
// went past this disc's lead-out (22 sectors).
bus._cdDriveStep();
check("Scan: the end of the disc stops the scan (like normal playback)", "paused", cd.phase);

// The jump GROWS with the radius: the CD is constant linear velocity, so one
// revolution at the edge is more sectors than at the center. Without the term that scales with
// the position the jump would always be 102.
cd.scanMode = 0; cd.scanCount = 5;   // the next step completes the 6
cd.currentSector = 300000;
cd.phase = "playing";
bus._cdPositionFrom(0x800000 | 150);
bus._cdDriveStep();
check("Scan: the jump grows with the radius (at 300000 it is +226, not +102)", 300226, cd.currentSector);

// Backward, the jump goes the other way and must NOT leave the sector negative.
cd.scanMode = 1; cd.scanCount = 5;
cd.currentSector = 50;              // less than the 104 jump: it has to clamp at 0
cd.phase = "playing";
bus._cdPositionFrom(0x800000 | 150);
bus._cdDriveStep();
check("Scan backward: the jump goes backward and clamps at 0 (does not go negative)", 0, cd.currentSector);

// While scanning, DATA sectors do not go into the buffers or through the filters.
cd.driveConn = 0; cd.authType = 4; cd.part[0] = [];
cd.scanMode = 0; cd.scanCount = 0; cd.currentSector = 150;
cd.phase = "playing";
bus._cdPositionFrom(0x800000 | 150);
const freePreScan = cd.free.length;
bus.cdHirq = 0;
bus._cdDriveStep();
check("Scan: a DATA sector does not go into the buffers", freePreScan, cd.free.length);
check("Scan: ...nor lands in any partition", 0, cd.part[0].length);
check("Scan: ...nor fires CSCT (no sector was stored)", 0, bus.cdHirq & 0x0004);

// Audio DOES come out, but ATTENUATED to 1/4 (-12 dB): it is Mednafen's BufferCDDA<2>, the
// "cue/review" you hear when fast-forwarding on a CD player.
const scanRx = [];
bus.scspEngine = { receiveCdda: (s) => scanRx.push(s.slice()) };
const raw = reader.readSectorRaw2352(0);
const sample = (b, i) => (((b[i] | (b[i + 1] << 8)) << 16) >> 16);   // signed 16-bit LE PCM
cd.scanMode = 0; cd.scanCount = 0; cd.currentSector = 150;
cd.phase = "playing";
bus._cdPositionFrom(0x800000 | 150);
cd.pos.ctrlAdr = 0x01;   // AUDIO track (the step reads it before repositioning)
bus._cdDriveStep();
check("Scan: the audio reaches the SCSP same as when playing", 1, scanRx.length);
// Sample 0 of this sector is NEGATIVE (-256), so this check does two things:
// it catches that the attenuation exists (without it, it would give -256) and catches that the sample is extended
// to 32 bits WITH SIGN before dividing it (without the extension it would give +16320, not -64).
check("Scan: ...attenuated to 1/4 and signed (a negative sample stays negative)",
	sample(raw, 0) >> 2, scanRx.length ? sample(scanRx[0], 0) : null);
// A POSITIVE sample from deep inside the sector: the attenuation has to cover it
// whole, not just the first sample.
check("Scan: ...across the whole sector, not just the first sample",
	sample(raw, 112) >> 2, scanRx.length ? sample(scanRx[0], 112) : null);

// Any Play or Seek stops the scan (StartSeek sets ScanMode = -1).
cd.scanMode = 0;
cdCmd(0x1100, 150, 0, 0);   // Seek Disc to FAD 150
check("Scan: a Seek stops the scan", -1, cd.scanMode);

// A Play "without moving the pickup" while playing does NOT seek again... unless there is a scan
// in progress, because then the pickup is making jumps and it has to be brought back. Mednafen
// StartSeek: if(no_pickup_change) { if(DrivePhase == DRIVEPHASE_PLAY && ScanMode < 0) return; }
cd.phase = "playing"; cd.scanMode = -1;
bus._cdInitSeek(0x800000 | 150, 0x800000 | 200, 0, 0, true);
check("Seek without moving the pickup: playing and no scan -> does not seek again",
	"playing", cd.phase);
cd.phase = "playing"; cd.scanMode = 0;
bus._cdInitSeek(0x800000 | 150, 0x800000 | 200, 0, 0, true);
check("Seek without moving the pickup: with a scan in progress it DOES seek again", "seeking", cd.phase);
check("Seek without moving the pickup: ...and stops the scan", -1, cd.scanMode);

// With the reader paused, the scan first has to get to the sector.
cd.phase = "paused"; cd.scanMode = -1;
cdCmd(0x1201, 0, 0, 0);
check("Scan: from pause the reader seeks first", "seeking", cd.phase);
check("Scan: ...and stays scanning backward (direction 1)", 1, cd.scanMode);

// ================================================================================
//   SCU: Timer 1 (bit 4, level 0xB, vector 0x44)
// ================================================================================
// On every H-Blank-IN the SCU loads T1S into
// timer 1, counts it down at ~7 MHz and fires when it reaches 0. T1MD (0x25FE0098) bit 0 =
// TENB (enables the timers), bit 8 = 0 on every line / 1 only on the timer 0 line.
// It was declared in the scuInts table and NOBODY fired it.
const bus2 = new Bus();
const irqs = [];
bus2.cpuMaster = { cycles: 0, requestInterrupt: (n, v) => irqs.push(v), requestNmi: () => {} };
bus2._writeRegBE(bus2.scuRegs, 0xA0, 0x00000000, 4);   // IMR: everything unmasked
const line = (n) => { bus2.cpuMaster.cycles = n * bus2.cyclesPerLine; irqs.length = 0; bus2.hblankTick(); };

// TENB=0: the timers are off, none of them fires.
bus2._writeRegBE(bus2.scuRegs, 0x98, 0x00000000, 4);
bus2.scuTimer0 = 0;
line(1);
check("Timer1: with TENB=0 it does not fire", false, irqs.indexOf(0x44) >= 0);

// ⚠ THESE TESTS WERE REWRITTEN ON 28-07-2026 BECAUSE THEY FOSSILIZED THE OLD MODEL.
// They required that with T1S = 0 (the reset value, which they NEVER set) the timer fire on
// EVERY line — which is what the code did, not what the chip does. A later hardware
// correction states two things that the original timer description leaves out:
//   - T1S is loaded into the timer only when the timer is STOPPED and an H-Blank-IN arrives.
//   - With T1S greater than the dots of a line, a timer 1 interrupt no longer occurs at
//     EACH line, and if 0 is specified as the number of counts, the value becomes 512.
// That is, the reset value (0 -> 512) does NOT fit in a 320-dot line (0x1AB = 427)
// and it fires every other line. Now the tests demand that.

// T1S INSIDE THE LINE: the count reaches 0 within the same line -> it fires on
// ALL of them. It is the common case and the only one the old model got right.
bus2._writeRegBE(bus2.scuRegs, 0x98, 0x00000001, 4);
bus2._writeRegBE(bus2.scuRegs, 0x94, 100, 4);          // T1S = 100 dots (fits in the line)
bus2._writeRegBE(bus2.scuRegs, 0x90, 5, 4);            // T0C = 5
bus2.scuTimer0 = 0;
bus2.scuTimer1Stopped = true;
line(2);
check("Timer1: with T1S inside the line it fires (vector 0x44)", true, irqs.indexOf(0x44) >= 0);
check("Timer1: level/vector 0x44 and not timer 0's", false, irqs.indexOf(0x43) >= 0);
line(3);
check("Timer1: and on the next one too", true, irqs.indexOf(0x44) >= 0);

// T1S OUTSIDE THE LINE: with the reset value (0, which is worth 512) the count survives the
// H-Blank-IN, it is not reloaded because the timer is not stopped, and it only fires on the
// second line. This is the case the old model got wrong.
bus2._writeRegBE(bus2.scuRegs, 0x94, 0, 4);            // T1S = 0 -> worth 512 dots
bus2.scuTimer1Stopped = true;
line(4);
check("Timer1: with T1S=0 (512 dots) it does NOT fire on the first line", false, irqs.indexOf(0x44) >= 0);
line(5);
check("Timer1: and it DOES on the second (512 > the line's 427 dots)", true, irqs.indexOf(0x44) >= 0);

// TENB=1, T1MD bit8=1: ONLY on the line that matched timer 0.
bus2._writeRegBE(bus2.scuRegs, 0x98, 0x00000101, 4);
bus2._writeRegBE(bus2.scuRegs, 0x94, 100, 4);          // T1S that fits in the line
bus2.scuTimer1Stopped = true;
bus2.scuTimer0 = 0;
line(4);
check("Timer1: with T1MD bit8=1 it does NOT fire on just any line", false, irqs.indexOf(0x44) >= 0);
bus2.scuTimer0 = 4;                                       // the next line will be 5 = T0C
line(5);
check("Timer1: with T1MD bit8=1 it fires on the timer 0 line", true, irqs.indexOf(0x44) >= 0);
check("Timer1: on that line timer 0 fires too", true, irqs.indexOf(0x43) >= 0);

// T0C is 10 bits wide (bits 31-10 do not exist).
bus2._writeRegBE(bus2.scuRegs, 0x98, 0x00000001, 4);
bus2._writeRegBE(bus2.scuRegs, 0x90, 0xFFFFFC08, 4);   // garbage on top + 8 at the bottom
bus2.scuTimer0 = 7;
line(6);
check("Timer0: T0C is compared on 10 bits, the garbage on top does not count", true, irqs.indexOf(0x43) >= 0);

// ================================================================================
//   SMPC: CKCHG320/352, OREG31 and SETSMEM
// ================================================================================
// The SMPC reads its byte-wide registers at
// ODD addresses: IREG0-3 = 0x01,0x03,0x05,0x07; COMREG = 0x1F; OREG0-31 = 0x21+n*2.
const smpcCmd = (c) => bus2.writeByte(0x0010001F, c);
const oreg = (n) => bus2.smpc[0x21 + n * 2];

// --- CKCHG: 0EH is 352 and 0FH is 320, NOT the other way around ---
// Command codes: clock change 352 mode = CKCHG352 = 0EH / clock change 320 mode =
// CKCHG320 = 0FH. Confirmed by Yabause (case 0xE -> SmpcCKCHG352) and Mednafen
// (CMD_CKCHG352 = 0x0E). They were swapped.
check("SMPC: the console boots at 320 (DOTSEL=0)", 0, bus2.smpcDotsel);
smpcCmd(0x0E);
check("SMPC: CKCHG352 (0EH) -> DOTSEL=1 (352)", 1, bus2.smpcDotsel);
smpcCmd(0x0F);
check("SMPC: CKCHG320 (0FH) -> DOTSEL=0 (320)", 0, bus2.smpcDotsel);

// --- OREG31: the command echo ---
// The command code is output to OREG31. For the commands that
// return no other result it is the ONLY thing they answer. It was never written.
smpcCmd(0x19);   // RESENAB
check("SMPC: OREG31 returns the echo of the executed command", 0x19, bus2.smpc[0x5F]);
smpcCmd(0x0F);
check("SMPC: OREG31 is updated on every command", 0x0F, bus2.smpc[0x5F]);
smpcCmd(0x20);   // >= 0x20: not a valid command
check("SMPC: codes >= 0x20 do NOT stomp OREG31 (Mednafen: if(cmd < 0x20))",
	0x0F, bus2.smpc[0x5F]);

// --- SETSMEM (17H): the SMPC's 4 bytes of battery-backed memory ---
// The SMPC provides 4 bytes of battery-backed memory (SMEM), and this command sets
// data into SMEM. The whole command was missing and there was nowhere to store it.
check("SMPC: SMEM starts at 0 (cold reset)", 0, bus2.smpcSmem[0] | bus2.smpcSmem[3]);
bus2.writeByte(0x00100001, 0xDE);   // IREG0
bus2.writeByte(0x00100003, 0xAD);   // IREG1
bus2.writeByte(0x00100005, 0xBE);   // IREG2
bus2.writeByte(0x00100007, 0xEF);   // IREG3
smpcCmd(0x17);
check("SETSMEM: SMEM1 <- IREG0", 0xDE, bus2.smpcSmem[0]);
check("SETSMEM: SMEM2 <- IREG1", 0xAD, bus2.smpcSmem[1]);
check("SETSMEM: SMEM3 <- IREG2", 0xBE, bus2.smpcSmem[2]);
check("SETSMEM: SMEM4 <- IREG3", 0xEF, bus2.smpcSmem[3]);
check("SETSMEM: it is category C, its only result is the echo in OREG31", 0x17, bus2.smpc[0x5F]);

// --- INTBACK: the status is what READS BACK SMEM and DOTSEL ---
// OREG12-15 = SMEM1~4 retained data; OREG10 bit6 = DOTSEL (0:320 1:352).
// Without this SETSMEM would be write-only (dead state) and nobody would read
// DOTSEL.
bus2.writeByte(0x00100001, 0x01);   // IREG0: ask for status
bus2.writeByte(0x00100003, 0x00);   // IREG1: no peripherals
smpcCmd(0x10);                          // INTBACK
check("INTBACK: OREG12 returns the SMEM1 that SETSMEM left", 0xDE, oreg(12));
check("INTBACK: OREG13 returns SMEM2", 0xAD, oreg(13));
check("INTBACK: OREG14 returns SMEM3", 0xBE, oreg(14));
check("INTBACK: OREG15 returns SMEM4", 0xEF, oreg(15));
check("INTBACK: OREG10 bit6 (DOTSEL) = 0 after CKCHG320", 0, oreg(10) & 0x40);
smpcCmd(0x0E);                          // CKCHG352
bus2.writeByte(0x00100001, 0x01);
smpcCmd(0x10);
check("INTBACK: OREG10 bit6 (DOTSEL) = 1 after CKCHG352", 0x40, oreg(10) & 0x40);
check("INTBACK: OREG10 keeps the hardware's fixed bits (5,3,2,1)", 0x2E, oreg(10) & 0x2E);
// OREG0 bit6 = RESD (0: reset enable / 1: reset disabled). It is the ONLY reader of the
// RESENAB (19H) / RESDISA (1AH) commands, which were implemented and went unnoticed.
check("INTBACK: OREG0 bit6 (RESD) = 0 with reset enabled", 0, oreg(0) & 0x40);
smpcCmd(0x1A);   // RESDISA
bus2.writeByte(0x00100001, 0x01);
smpcCmd(0x10);
check("INTBACK: RESDISA (1AH) shows in OREG0 bit6", 0x40, oreg(0) & 0x40);
smpcCmd(0x19);   // RESENAB
bus2.writeByte(0x00100001, 0x01);
smpcCmd(0x10);
check("INTBACK: RESENAB (19H) lowers it again", 0, oreg(0) & 0x40);
check("INTBACK: OREG0 bit7 (STE, RTC valid) stays at 1", 0x80, oreg(0) & 0x80);

// ================================================================================
//   CARTRIDGE: the A-bus slot (cart.js hooked to the bus)
// ================================================================================
// cart.js existed in full and NOBODY called it: bus.js neither instantiated it nor
// routed it. See "HOW TO HOOK IT UP" at the bottom of cart.js.
const bus3 = new Bus();
check("cart: without a cartridge the ID register gives open bus", 0, bus3.readByte(0x24FFFFFF));
check("cart: without a cartridge bus.cart is null", null, bus3.cart);

// X-Men vs. Street Fighter (serial T-1226G) asks for the 4 MB RAM cart.
const cartType = Cartridge.typeForSerial("T-1226G");
bus3.putCartridge(new Cartridge(cartType));
check("cart: the game's serial resolves to the cartridge it asks for",
	"RAM cart 4 MB (32 Mbit DRAM)", bus3.cart.name);
// MMIO path: the ID register lives in the LAST byte of CS1 and it is not RAM.
check("cart: the ID register (0x04FFFFFF) returns 0x5C", 0x5C, bus3.readByte(0x24FFFFFF));
// Fast path: the DRAM has to go into the PAGE TABLE, not be resolved by
// hand on every access. Without this the cartridge still "works" (readMmio does the same),
// but it eats the slow path on every read of the 4 MB: the table has to be
// verified, not just the result.
const pageDram = bus3.pages[0x02400000 >>> 16];
check("cart: the DRAM goes into the page table (fast path)", true, pageDram !== null);
check("cart: ...pointing to the cartridge's buffer", true, !!pageDram && pageDram.buf === bus3.cart.dram);
check("cart: ...and it is writable", false, !!pageDram && pageDram.ro);
bus3.writeLong(0x22400000, 0x12345678);
check("cart: the cartridge DRAM keeps what is written to it", 0x12345678, bus3.readLong(0x22400000));
check("cart: ...and it goes to the cartridge's buffer, not into limbo", 0x12, bus3.cart.dram[0]);
bus3.writeLong(0x227FFFFC, 0xCAFEBABE);
check("cart: the whole 4 MB respond (0x027FFFFC is the last long)",
	0xCAFEBABE, bus3.readLong(0x227FFFFC) >>> 0);
// Removing it has to leave the bus as it was: if putCartridge does not rebuild the table,
// the old cartridge's pages are left dangling, pointing to its DRAM.
bus3.putCartridge(null);
check("cart: on removal the ID gives open bus again", 0, bus3.readByte(0x24FFFFFF));
check("cart: on removal the DRAM stops responding", 0, bus3.readLong(0x22400000));
check("cart: on removal the page table is rebuilt (the old page does not stay)",
	null, bus3.pages[0x02400000 >>> 16]);

console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
