/**
 *    Name:         bus.js
 *    Description:  Sega Saturn memory map and bus arbitration. Decodes the real
 *                  regions (Boot ROM, Work RAM Low/High, backup, VDP1/2 VRAM,
 *                  CRAM, sound RAM) and routes the chips' MMIO (SMPC, VDP1/2,
 *                  SCU, SCSP, CD) to stubs with logging. Big-endian.
 *                  The CD block (0x05890000) is implemented for real when a disc
 *                  is mounted (see mountDisc / _cdExecute), including its own
 *                  ISO9660 filesystem (commands 0x70-0x75, see _cdFlsCoroutine):
 *                  with that the BIOS authenticates the disc, reads the root
 *                  directory, loads the game's first program and jumps to it.
 *    Version:      0.4.0
 *    Created:      15-07-2026
 *    Modified:     18-07-2026
 *    Author:       Sebastian Toyos
 *
 *    Attribution: the CD block (commands, statuses, buffers, partitions, filters and
 *    the filesystem state machine) is ported from Mednafen beetle-saturn
 *    (mednafen/ss/cdb.cpp), GPL v2+. See CREDITS.md.
 */

//!wip, 16-07-2026 - Real memory map + MMIO for the SMPC, CD block, SCSP and SCU.
//? The SCU DMA is NOT missing (this marker listed it as pending until
//? 17-07-2026): it is the 3 channels of _scuDma/_scuDmaCopy/_scuDmaCount, further down
//? in this same file, fired by _scuDmaPerEvent() from the VBlank and by
//? start factor 7 when DxEN is written. What IS missing: fine timing (the SCU DMA and
//? the CD one are HLE, immediate on the trigger, not cycle by cycle) and a few SMPC
//? commands that were left unimplemented on purpose (see CKCHG and SYSRES).

// ===================== SMPC area code =====================
// Console region that the SMPC reports in OREG9 of the INTBACK. It is deduced from the
// loaded BIOS (see _detectAreaBios), it is not hardcoded.
// The values are the hardware's, exactly as Mednafen lists them (ss/smpc.h). What
// matters in the full set is that BIT 3 marks the PAL regions: that is why
// isPal() is an AND against SMPC_AREA_MASK_PAL, same as Mednafen in ss.c
// ("const bool PAL = smpc_area & SMPC_AREA__PAL_MASK").
const SMPC_AREA_JAPAN     = 0x01,   // Japan                    -> NTSC
      SMPC_AREA_ASIA_NTSC = 0x02,   // Asia NTSC                -> NTSC
      SMPC_AREA_NA        = 0x04,   // North America            -> NTSC
      SMPC_AREA_CSA_NTSC  = 0x05,   // Central/S. America NTSC  -> NTSC
      SMPC_AREA_KOREA     = 0x06,   // Korea                    -> NTSC
      SMPC_AREA_ASIA_PAL  = 0x0A,   // Asia PAL                 -> PAL
      SMPC_AREA_EU_PAL    = 0x0C,   // Europe                   -> PAL
      SMPC_AREA_CSA_PAL   = 0x0D,   // Central/S. America PAL   -> PAL
      SMPC_AREA_MASK_PAL = 0x08; // bit 3 set = PAL region

// BIOS file names that give away a European (PAL) console. This is needed
// because the ROM is NOT enough to tell US from Europe: the European dump is BYTE
// FOR BYTE IDENTICAL to the American one (mpr-17933; in the repo "Bios Saturn 1.01a (U)
// [!].bin" and "Sega Saturn BIOS (EUR).bin" have the SAME md5 and the same header
// "BTR_1.000U941115"). On real hardware the region is set by jumpers on the
// board, not by the ROM, so with the file alone there is no way to know: the
// name the user gave it is the only data left.
const SMPC_RE_BIOS_PAL = /\b(eur|euro|europe|europa|pal)\b|\(e\)|\[e\]/i;

// How long an SMPC command takes, in calls to smpcTick() (one per frame). The SMPC
// is a 4-bit microcontroller and its commands are NOT instantaneous: the handshake that
// games do -write COMREG, see SF=1, wait for SF=0- depends on that. 1 = it
// answers once that many SH-2 cycles (26.8 MHz) have passed, i.e. with SUB-FRAME
// granularity: doing it per whole frame (16.6 ms) is an eternity for the SMPC and hurts
// the games that poll it often (measured: Daytona CCE dropped from 72% to 28%).
// ~300 us is what an INTBACK with one peripheral takes, which is the normal case.
const SMPC_LATENCY_CMD = 2000;   // SH-2 cycles (~75 us) — the default, see the table below

// ★ AND THE TIME IS PER COMMAND, not a single one for all of them (29-07-2026).
// Each command has its own execution time on hardware. Converted to SH-2 cycles at
// 26.8741 MHz (1 us = 26.87 cycles):
//
//   30 us  -> MSHON SSHON SSHOFF SNDON SNDOFF NMIREQ RESENAB RESDISA   (the class B ones)
//   40 us  -> CDON CDOFF SETSMEM
//   70 us  -> SETTIME
//   100 ms -> SYSRES CKCHG352 CKCHG320   (listed as "100m + alpha")
//
// ⚠ INTBACK (0x10) IS LEFT OUT ON PURPOSE, and this is the discrepancy that has to stay
// written down. Its official timing reads "320m", where "μ" means microseconds and "m"
// milliseconds — but **320 ms is incompatible with what was measured**: the 10 games issue ~0.8 INTBACK
// PER FRAME (16.68 ms) and wait for its answer, i.e. 12,058 of 12,345 commands
// (diag/smpc-commands.mjs). With 320 ms they could not.
// And the source is not enough to settle it: the original is a scan with no text, so the
// only legible copy is an HTML conversion that ALREADY got it wrong once -it gave the
// interrupts column mixed with the "prohibited for the user" one-. Changing the timing of the
// command that is issued 12,058 times on the strength of a source that already failed is not right.
//? What it would take to close this: a legible source for that table (or an OCR of the scan) that
//? confirms the unit. Two other sections of the official documentation were already searched
//? for it: neither gives timings.
const SMPC_US = 26.8741;
const SMPC_LATENCY = {
	0x00: 30 * SMPC_US,  0x02: 30 * SMPC_US,  0x03: 30 * SMPC_US,   // MSHON SSHON SSHOFF
	0x06: 30 * SMPC_US,  0x07: 30 * SMPC_US,  0x18: 30 * SMPC_US,   // SNDON SNDOFF NMIREQ
	0x19: 30 * SMPC_US,  0x1A: 30 * SMPC_US,                        // RESENAB RESDISA
	0x08: 40 * SMPC_US,  0x09: 40 * SMPC_US,  0x17: 40 * SMPC_US,   // CDON CDOFF SETSMEM
	0x16: 70 * SMPC_US,                                             // SETTIME
	// "100m + alpha": that is ~6 NTSC frames. All three reset the system clock or the whole
	// console, so on real hardware the video resyncs — it is not just any wait.
	0x0D: 100000 * SMPC_US, 0x0E: 100000 * SMPC_US, 0x0F: 100000 * SMPC_US   // SYSRES CKCHG352/320
};

// ===================== CD block constants =====================
// Ported from Mednafen beetle-saturn (cdb.cpp). They carry the CD_ prefix so as not to
// clobber anything in the browser's global scope (bus.js is loaded with <script>).

// Drive statuses: they travel in the high byte of CR1.
const CD_ST_BUSY    = 0x00,   // busy (seeking, spinning up the motor...)
      CD_ST_PAUSE   = 0x01,   // paused on a sector
      CD_ST_STANDBY = 0x02,   // motor stopped
      CD_ST_PLAY    = 0x03,   // playing/reading
      CD_ST_SEEK    = 0x04,   // seeking
      CD_ST_SCAN    = 0x05,   // scan (fast forward/rewind)
      CD_ST_OPEN    = 0x06,   // tray open
      CD_ST_NODISC  = 0x07,   // no disc
      CD_ST_RETRY   = 0x08,   // retrying a read
      CD_ST_ERROR   = 0x09,   // read error
      CD_ST_FATAL   = 0x0A;   // fatal error
// Modifiers that get OR-ed into the status in the response.
const CD_ST_PERIODIC  = 0x20,   // periodic report (not a response to a command)
      CD_ST_DTREQ     = 0x40,   // there is a data transfer pending
      CD_ST_WAIT      = 0x80,   // the block is busy, retry the command
      CD_ST_REJECTED = 0xFF;   // command rejected (invalid parameters)

// Flags of the HIRQ register (0x05890008).
const CD_HIRQ_CMOK = 0x0001,   // command accepted / finished
      CD_HIRQ_DRDY = 0x0002,   // data ready to transfer
      CD_HIRQ_CSCT = 0x0004,   // a complete sector was read
      CD_HIRQ_BFUL = 0x0008,   // buffers full
      CD_HIRQ_PENDING = 0x0010,   // playback finished
      CD_HIRQ_DCHG = 0x0020,   // disc change
      CD_HIRQ_ESEL = 0x0040,   // a selector (filters) operation finished
      CD_HIRQ_EHST = 0x0080,   // a transfer to the host finished
      CD_HIRQ_ECPY = 0x0100,   // a sector copy/move finished
      CD_HIRQ_EFLS = 0x0200,   // a filesystem operation finished
      CD_HIRQ_SCDQ = 0x0400,   // the Q subchannel was updated
      CD_HIRQ_MPED = 0x0800;   // an MPEG operation finished

// Geometry of the real CD block: 200 sector buffers and 24 partitions/filters.
const CD_BUFFERS     = 0xC8,
      CD_PARTITIONS = 0x18,
      CD_SECTOR_SIZE  = 2352;   // the buffers hold the RAW sector (sync+header+data)

// Sectors per second of the Saturn's drive (2x speed).
const CD_SECTORS_PER_SEC = 150;

// Fraction of the video line that is active picture: the rest is HBLANK. Used
// to derive the HBLANK bit of TVSTAT without emulating scanline by scanline.
const FRAC_ACTIVE_LINE = 0.80;

// Dots of a complete line in normal resolution, including the retrace.
// It is the horizontal total of the 320 mode: 0x1AB from Mednafen's HTimings table
// (md_vdp2.c:321-325, {0x140 active, 0x15B, 0x1AB total}). It is only used to scale
// the latched HCNT (see _latchHv).
// CONFIRMED BY SEGA, no longer an -ism (28-07-2026): on hardware, the range of SCU
// timer 1 counts is "1 to 1AAH" for a 320-dot line
// and "1 to 1C6H" for a 352 one. Those counts go one dot per count, so the
// line total is 0x1AB and 0x1C7 — the 0x1AB below, taken from Mednafen, is the
// official number. (See _scuTimer1Check, which uses the other end of the same fact.)
const POINTS_PER_LINE = 0x1AB;


// TVMD screen geometry (see Bus.tvGeometry). Both tables are the hardware's TVMD
// resolution modes. They live here because the VDP1 and the VDP2 both need them, and
// having them duplicated in the two already cost a bug (hi-res fixed in only one).
// ---------------------------------------------------------------------------
// CD BLOCK TIMING MODEL (25-07-2026)
//
// The CD block is NOT a register bank: it is a board with its OWN processor (an SH-1
// at 20 MHz) running firmware. We emulate it at HIGH LEVEL —we implement its commands, not
// its CPU, which is what Yabause does by default and costs 15-20% less— but that does not
// change the fact that a command TAKES TIME: the SH-1 has to read the CRs, process them and only then answer.
//
// That is why the protocol of ALL games is:
//     clear CMOK  ->  write CR1..CR4  ->  wait for CMOK  ->  read the response
// Measured on Virtua Cop: it clears CMOK before the command 126,401 times during boot, without a
// single exception. With ZERO latency that handshake means nothing — the game sees the
// response in the same cycle it asks, something the real hardware cannot do.
//
// Until today the command ran INSIDE the write to CR4. It is the same omission that
// was already fixed in the other chips (the SH-2 charging 1 cycle per instruction, the VDP1
// drawing in one go, DMA with no bus cost): the CD block simply never made it onto
// that list.
//
// The unit is cdTick's: "time sectors", 1 = 1/150 s = 6.67 ms.
//
// THE VALUE COMES FROM MEASURING, not from a source: the command time is not published.
// Sweep with diag/health.mjs over the games (rally / sonic):
//     0.02 (~133 us) -> 70% / 25%      0.15 (~1 ms)  -> 28% / 36%
//     0.05 (~333 us) -> 75% / 25%      0.30 (~2 ms)  -> 60% / 15%
// 0.05 is the only one that improves BOTH against the instantaneous model (70% / 15%), and it is
// ~6700 SH-1 cycles at 20 MHz, which is what a simple firmware command costs.
const CD_CMD_LATENCY = 0.05;   // ~333 us

// SEEK time, in drive steps (1 step = 1 time sector = 6.67 ms). See
// _cdInitSeek.
//
// THE NUMBER IS SMALLER THAN THE REAL HARDWARE'S, AND IT IS MEASURED THAT IT HAS TO BE.
// A real 2x drive gives 200-400 ms of average access time (MPC II spec: <= 400 ms) and up to
// ~1 s in the worst case. This table tops out at 200 ms (base+max = 30 steps). Raising it
// to "realistic" values was tried and it gets WORSE (sweep of 25-07-2026 with diag/health.mjs):
//     base/max/div     full stroke   rally   sonic   virtua cop
//     2 / 28 / 4500      200 ms       72%     17%      72%     <- this one
//     8 / 60 / 3000      453 ms       67%     17%      17%     <- breaks VC
//    15 / 75 / 2200      600 ms       67%     17%      17%     <- breaks
//
// AND IT MUST NOT BE RAISED. Sebas's question settles it (translated): "and when there's an
// ODE, what happens with the seek?". An ODE has no physical seek -the data comes from an SD- and ODEs have
// ZERO known compatibility problems. So there is REAL HARDWARE where the seek
// is ~0 and the games work just the same: they do not depend on the optical drive's mechanical timing.
//
// The distinction that matters, and that is ours (also from Sebas): there are two families of
// ODE and they are NOT the same case.
//   - SAROO: replaces the ENTIRE CD BLOCK. The original SH-1 takes no part.
//   - MODE / Fenrir / Rhea-Phoebe: replace ONLY THE DRIVE. The original CD block is still
//     there, with its SH-1 and its firmware, and the ODE speaks the drive protocol to it.
//
// This emulator is the SECOND case: we emulate the complete CD block -commands, filters,
// partitions, ISO9660- and what is "replaced" is the drive mechanism. That is why the
// SH-1's COMMAND latency does deserve to be modeled (this one, above) and the mechanical seek
// does not: in that configuration it does not exist. The 200 ms of this table are even conservative.
// ---------------------------------------------------------------------------

const BUS_HRESO_WIDTH = [ 320, 352, 640, 704, 320, 352, 640, 704 ];
const BUS_VRESO_HEIGHT  = [ 224, 240, 256, -1 ];   // -1 = "Not Allowed": do not touch the height

// File info table of the CD block's filesystem: 12 bytes per entry
//   [0..3] FAD (big-endian)   [4..7] size in bytes (big-endian)
//   [8] interleave unit   [9] gap size   [10] file number   [11] attributes
// The DTR delivers it in 16-bit WORDS: 6 words per entry.
const CD_FI_SIZE      = 12,
      CD_FI_WORDS = 6,
      CD_FI_BUFVIRT  = 0xF0;   // "virtual buffer" code of the table in the DTR

// Attributes of a file info entry.
const CD_FATTR_DIR = 0x02;     // the entry is a directory

// Condition modes of a filter (the ones the filesystem uses).
const CD_FMODE_FILE = 0x01,    // filter by file number (XA)
      CD_FMODE_FADR = 0x40;    // filter by FAD range

class Bus
{
	constructor()
	{
		// --- RAM/ROM type memories (each with its own buffer, big-endian) ---
		this.bootRom   = new Uint8Array(0x80000);   // 512 KB - BIOS (read only)
		this.wramLow   = new Uint8Array(0x100000);  // 1 MB   - Work RAM Low  (0x00200000)
		this.wramHigh  = new Uint8Array(0x100000);  // 1 MB   - Work RAM High (0x06000000)
		this.backupRam = new Uint8Array(0x10000);   // 64 KB  - Backup RAM (bytes at odd addresses)
		this.backupDirty = false;                   // set when the backup is written -> persist
		// Sectors the drive still needs before it is ready after a disc is inserted (see
		// mountDisc and cdTick): while it is > 0 the block answers BUSY.
		this.cdBootRest = 0;
		// Freshly created it is all zeros, which for a game is "unformatted memory". It is made
		// usable by formatBackup(), which is what the BIOS does at boot.
		this.formatBackup();
		this.soundRam  = new Uint8Array(0x80000);   // 512 KB - Sound RAM (SCSP, 68000)
		// The buffers that the VDP1 worker will rasterize in parallel (VRAM/framebuffer/
		// VDP1 registers + the CRAM and the VDP2 registers that rasterization reads for
		// the sprite color) are created on a SharedArrayBuffer when the context is
		// cross-origin-isolated, to share them with the worker without copying. If it is not
		// (COOP/COEP missing, or it is file://), they fall back to a normal ArrayBuffer and the emulator runs just the same
		// on the main thread, without a worker. Node reports crossOriginIsolated undefined -> SAB.
		const comp = (n) => (typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated !== false)
			? new Uint8Array(new SharedArrayBuffer(n)) : new Uint8Array(n);
		this.vdp1Vram  = comp(0x80000);             // 512 KB - VDP1 VRAM
		this.vdp1Fb    = comp(0x40000);             // 256 KB - VDP1 framebuffer (2 banks)
		this.vdp2Vram  = new Uint8Array(0x80000);   // 512 KB - VDP2 VRAM
		this.cram      = comp(0x1000);              // 4 KB   - Color RAM (palette)

		// --- MMIO registers (small arrays per device) ---
		this.vdp2Regs = comp(0x200);                // VDP2 registers (0x05F80000)
		this.cramMirror = true;                     // CRMD=0 (default after reset) mirrors CRAM into the upper bank
		this.vdp1Regs = comp(0x20);                 // VDP1 registers (0x05D00000)

		// VDP1 bank change and bank erase requests (Vdp1External.manualchange
		// and manualerase in Yabause). They are EDGE-triggered: they are raised by the write hook
		// for FBCR in _mmioWrite and consumed (and cleared) by vdp1.js exactly once. They live
		// here and not in vdp1.js because the one that sees the write is the bus.
		this.vdp1ChangeManual  = false;
		this.vdp1EraseManual = false;
		// VDP1 PLOT request. Same pattern and same reason as the two above:
		// starting a draw with PTM=01B is EDGE-triggered (drawing begins when the
		// register is written); it is raised by the write hook
		// for PTMR in _mmioWrite and consumed (and cleared) by vdp1.js exactly once.
		this.vdp1PlotRequest = false;

		// true while the doorbell burst (see _mmioWrite) runs the slave: prevents
		// re-entering if the burst itself rings the doorbell again. Declared here for the hidden class.
		this._doorbellInBurst = false;

		this.scuRegs  = new Uint8Array(0x100);      // SCU registers  (0x05FE0000)
		// IMS (0x25FE00A0) DOES NOT START AT ZERO. Its initial value is
		// 0000BFFFH, and the register masks with 1 (a 0 does not mask the
		// interrupt, a 1 masks it).
		// So the SCU starts with EVERYTHING masked except bit 14, and it is the
		// program that opens up what it needs.
		// Starting at zero -which is what the freshly created Uint8Array left- we had the
		// opposite state: ALL sources open from power-on, until the BIOS
		// wrote the register. Any interrupt the SCU raised in that window
		// we delivered to the SH-2 when the hardware blocks it.
		this._writeRegBE(this.scuRegs, 0xA0, 0x0000BFFF, 4);
		this.smpc     = new Uint8Array(0x80);       // SMPC registers (0x00100000)
		this.cdRegs   = new Uint8Array(0x40);       // CD block registers (0x05890000)

		// Freshly powered-on CD block (no disc: status NODISC=0x07).
		// The power-on HIRQ of the real hardware comes with ALL the "operation
		// finished" flags already raised (reset branch of the command coprocessor in
		// Mednafen's cdb.cpp). ESEL is essential: the BIOS keeps an accumulator
		// of HIRQ in RAM (0x060003A4) and requires ESEL to be in it BEFORE sending
		// any selector command (filters/partitions). Without ESEL its
		// "send command" routine returns an error, retries, times out and restarts the
		// disc check forever ("checking disc format" in a loop).
		this.cdHirq = CD_HIRQ_CMOK | CD_HIRQ_DCHG | CD_HIRQ_ESEL | CD_HIRQ_EHST |
		              CD_HIRQ_MPED | CD_HIRQ_ECPY | CD_HIRQ_EFLS;

		// The freshly powered-on CD block presents its SIGNATURE "CDBLOCK" in CR1-CR4 (see
		// _cdPresentSignature). It is the first thing the BIOS looks at: without the signature it assumes
		// there is no CD block and NEVER sends it a command -> it does not authenticate the
		// disc, does not read the filesystem and does not load the game.
		this.cdSignaturePresent = false;
		this._cdPresentSignature();

		// Mounted disc (CdReader instance from cd.js) and CD block state.
		// null = no disc: the block answers NODISC as always (see _cdCommand).
		this.cdReader = null;
		this.cd = null;

		this.cpuMaster = null;                      // reference to the SH-2 for IRQs
		this.cpuSlave = null;                       // reference to the second SH-2 (SSHON)

		// SCU internal interrupt table: IST/IMR bit -> level + vector.
		this.scuInts = [
			{ bit: 0,  level: 0xF, vec: 0x40 },   // VBlank-IN
			{ bit: 1,  level: 0xE, vec: 0x41 },   // VBlank-OUT
			{ bit: 2,  level: 0xD, vec: 0x42 },   // HBlank-IN
			{ bit: 3,  level: 0xC, vec: 0x43 },   // Timer 0
			{ bit: 4,  level: 0xB, vec: 0x44 },   // Timer 1
			{ bit: 5,  level: 0xA, vec: 0x45 },   // DSP End
			{ bit: 6,  level: 0x9, vec: 0x46 },   // Sound Request
			{ bit: 7,  level: 0x8, vec: 0x47 },   // System Manager (SMPC)
			{ bit: 8,  level: 0x8, vec: 0x48 },   // PAD
			{ bit: 9,  level: 0x6, vec: 0x49 },   // Level 2 DMA End
			// PAD (bit 8) is not fired by anyone ON PURPOSE, it is not an oversight: it is NOT
			// "the end of the peripheral INTBACK" (that is the System Manager one, bit 7,
			// which we do fire). It is a hardware PIN: bit 6 of the peripheral
			// port, and only if the game enabled it with EXLE1/EXLE2 (SMPC 0x7F).
			// EXLE sets whether bit 6 of peripheral port 1 (P1) is used as a PAD interrupt
			// or as the VDP2 external latch input, and writing '1'
			// enables it; the power-on default is 0 = "PAD interrupt,
			// VDP2 external latch disabled". The SCU's interrupt source
			// list confirms it from the other side: the SOURCE of bit 8 is
			// "P.A.D.", not the SMPC (bit 7 does say "SMPC").
			// It is the SAME signal that latches the VDP2's HV (see EXLTEN in _mmioRead):
			// that is, the LIGHT GUN, which we do not emulate. Mednafen is explicit
			// (smpc.c:258-260, UpdateIOBus):
			//     bool tmp = (!(IOBusState[0] & 0x40) & ExLatchEn[0]) |
			//                (!(IOBusState[1] & 0x40) & ExLatchEn[1]);
			//     SCU_SetInt(SCU_INT_PAD, tmp);  VDP2_SetExtLatch(timestamp, tmp);
			// With a digital pad it is NEVER asserted, and Yabause never fires it either
			// (ScuSendPadInterrupt exists in scu.c:3994 and nobody calls it).
			// Firing it from the INTBACK would be INVENTING a level 8 interrupt that
			// the hardware does not send. Without a model of the port bus (our pad is
			// two bytes, pad1a/pad1b) there is no signal that could assert it.
			// //!wip, 16-07-2026
			{ bit: 10, level: 0x6, vec: 0x4A },   // Level 1 DMA End
			{ bit: 11, level: 0x5, vec: 0x4B },   // Level 0 DMA End
			{ bit: 12, level: 0x3, vec: 0x4C },   // illegal DMA
			{ bit: 13, level: 0x2, vec: 0x4D },   // Sprite Draw End (VDP1)
			{ bit: 16, level: 0x7, vec: 0x50 }    // CD block (A-bus external 0)
		];
		// SCU DMA: channels armed and waiting for a hardware event (VBlank...).
		// The ones started by register (start factor 7) run right away.
		this.scuDmaBuilt = [false, false, false];
		// Line counter for SCU Timer 0: reset at VBlank-OUT and incremented on
		// every HBlank-IN (ScuSendVBlankOUT/ScuSendHBlankIN in Yabause, scu.c).
		this.scuTimer0 = 0;
		// SCU Timer 1 countdown, IN DOTS. The SCU loads T1S when the timer
		// is STOPPED and an HBlank-IN arrives, and counts down one dot per count; on reaching 0
		// it fires and stops. See _scuTimer1Check.
		this.scuTimer1Count = 0;
		this.scuTimer1Stopped = true;
		// SCU interrupts latched while they are masked (own bitmask).
		this.scuPending = 0;
		this.cdHirqMask = 0x0000;   // which bits of the CD HIRQ fire the interrupt
		// Command requested and not yet answered, in time sectors (see the CD block
		// timing model above). -1 = none pending.
		this.cdCmdPending = -1;
		this.cdCmdCr = null;        // captured parameters of the pending command

		// SCU DSP (scu.js): the SCU's VLIW processor. The BIOS uses it when it detects a
		// disc (loads a microprogram, starts it with EX and waits for it to finish),
		// so without the DSP the boot with a disc keeps spinning forever.
		// Its control registers (0x80-0x8C) are routed in _mmioRead/_mmioWrite.
		this.scuDsp = (typeof ScuDspEngine !== "undefined") ? new ScuDspEngine() : null;
		if(this.scuDsp)
		{
			// The DSP does its DMA against the SCU bus: we give it memory access.
			this.scuDsp.connectBus(
				(addr) => this.readLong(addr >>> 0) >>> 0,
				(addr, val) => this.writeLong(addr >>> 0, val >>> 0));
			// ENDI: end of program with interrupt -> the SCU's "DSP End" (bit 5).
			this.scuDsp.onFinish = () => this._scuIrq(5, 0xA, 0x45);
		}

		// Digital pad state (active-low: 0 = pressed). Two bytes.
		// byte A: [7]Right [6]Left [5]Down [4]Up [3]Start [2]A [1]C [0]B
		// byte B: [7]R [6]X [5]Y [4]Z [3]L [2-0]=1
		this.pad1a = 0xFF;
		this.pad1b = 0xFF;

		// --- Peripheral connected to port 1 (selectable) ---
		// The SMPC reports in the INTBACK which peripheral is present and its data. The HIGH nibble
		// of the ID is the family and the LOW nibble the number of data bytes that follow
		// (the "Saturn Peripheral Standard Format"). Supported types:
		//   "pad"   -> standard digital Control Pad    ID 0x02, 2 bytes  (default)
		//   "pad3d" -> analog 3D Control Pad           ID 0x16, 6 bytes  (the NiGHTS one)
		//   "wheel" -> Racing/Arcade Racer (wheel)     ID 0x13, 3 bytes
		//   "mouse" -> Shuttle Mouse                   ID 0xE3, 3 bytes
		//   "gun"   -> Virtua Gun / Stunner (gun)      ID 0x25, 5 bytes  (see //? below)
		// The digital buttons (pad1a/pad1b) are SHARED by pad/pad3d/wheel: all three
		// carry the same two-byte layout up front. Only what is
		// added after it changes (analog axes, wheel, etc.).
		this.peripheral1 = "pad";

		// 3D Control Pad (ID 0x16): 4 analog bytes ON TOP OF pad1a/pad1b. Unsigned,
		// center 0x80; the triggers at rest 0x00 and fully pressed 0xFF (analog device format:
		// "unsigned absolute value", "(0,0) upper-left .. (255,255)").
		this.an1x = 0x80;   // AX: horizontal stick (0=left, 0xFF=right)
		this.an1y = 0x80;   // AY: vertical stick   (0=up, 0xFF=down)
		this.an1r = 0x00;   // AR: analog R trigger (0=released, 0xFF=fully pressed)
		this.an1l = 0x00;   // AL: analog L trigger (0=released, 0xFF=fully pressed)

		// Racing Controller (ID 0x13): 1 wheel byte on top of pad1a/pad1b. Center
		// 0x80 (on hardware it is 127/0x7F; we use 0x80 as neutral, //? one LSB).
		// The shift paddles go in the Up/Down bits of pad1a ("butterfly shift").
		this.wheel1 = 0x80;

		// Shuttle Mouse (ID 0xE3): 3 bytes = [flags, dX, dY]. CAREFUL: the mouse buttons
		// are ACTIVE-HIGH (1 = pressed), the opposite of the pad (pointing device format:
		// "buttons register as 1 when pressed"). The movement is RELATIVE and goes in
		// sign+magnitude+overflow: mouse1dx/mouse1dy are SIGNED integers (encoded by
		// _reportMouse1). The harness sets them and the report consumes/clears them.
		this.mouse1btn = 0x00;   // [3]Start [2]Middle [1]Right [0]Left (1 = pressed)
		this.mouse1dx  = 0;      // relative X movement (>0 and <0; useful magnitude 0-255)
		this.mouse1dy  = 0;      // relative Y movement

		// Virtua Gun / Stunner (ID 0x25): 5 bytes = [flags, Xhi, Xlo, Yhi, Ylo].
		//? The gun has NO SMPC peripheral data format (no gun format exists among them): on the
		//? hardware the position comes from the VDP2's H/V latch, not from SMPC bytes. This
		//? format is Yabause's (peripheral.c: trigger=bit4/0x10, start=bit5/0x20
		//? active-low; X and Y in 16-bit big-endian). ID 0x25 still respects the rule of
		//? low nibble = 5 bytes. It stays as //! until confirmed against real hardware.
		this.gun1x       = 0;       // X position of the shot (0-1023, 16 bits)
		this.gun1y       = 0;       // Y position of the shot
		this.gun1trigger = false;   // trigger
		this.gun1start   = false;   // Start button

		// State of the SMPC INTBACK handshake (status -> continue -> peripherals).
		this.intbackPeriphPending = false;
		// PENDING SMPC COMMAND. The SMPC does not answer on the spot: it sets SF=1 (busy)
		// on accepting the command and clears it to 0 when it finishes, and ONLY then fires the
		// System Manager interrupt. Games poll that SF to know whether their command
		// was executed. See smpcTick().
		this.smpcPending = null;   // {remaining} or null: cycles the command in progress still needs
		// Last value of bit 7 of IREG0 within an INTBACK session. The protocol's CONTINUE
		// is a TOGGLE of that bit, not "any write": see the hook for
		// IREG0 (off 0x01) further down. -1 = not written yet in this session.
		this.intbackBit7 = -1;
		// States the BIOS turns on/off by command and queries in the status.
		this.smpcSlaveOn = false;   // second SH-2
		this.smpcDotsel = 0;        // 0 = 320 pixels wide, 1 = 352 (CKCHG320/352)
		this.smpcResetHab = true;   // reset button enabled (RESENAB/RESDISA)
		this.smpcSoundOn = false;   // sound CPU (68000)
		this.smpcCdOn    = false;   // CD block
		// SMEM: the 4 bytes of battery-backed memory that the SMPC provides. They
		// are written by the SETSMEM command (17H) and read back in the INTBACK status
		// (OREG12-15). They start at 0: the contents of SMEM are cleared to 0 on an
		// SMPC cold reset, and a cold reset is exactly what happens when the console is
		// powered on without a battery (which is our case: we do not persist SMEM
		// yet).
		//? Mednafen DOES persist it together with the RTC (smpc.c:400, same file as the
		//? clock) and also puts the language in the low nibble of SMEM4
		//? (SaveMem[3] = (SaveMem[3] & 0xF0) | lang, smpc.c:467). We have nowhere
		//? to store it: backupDirty persists the backup RAM, not the SMPC.
		//? //!wip, 16-07-2026
		this.smpcSmem = new Uint8Array(4);
		// Console region (OREG9 of the INTBACK). It is overwritten by loadBios() according to the
		// ROM header; the default only applies if a BIOS was never loaded.
		this.areaCode    = SMPC_AREA_NA;
		// RTC (SMPC clock): it is an EMULATED clock, the console's own, same as the
		// hardware's (which has its crystal and its battery). The host is NOT asked for the
		// time: `rtcMs` is the console's time and it advances with EMULATED TIME, one
		// frame at a time from the loop (see rtcTick).
		//? This used to call new Date() on every INTBACK read. Two problems:
		//? (1) the boot was NOT DETERMINISTIC -> at the same cycles, two runs
		//? gave different states, and that made two agents measure opposite things
		//? and a bug get "closed" wrongly twice; (2) the clock ran in REAL time
		//? and not in emulated time, so in turbo (or when fps dropped) it came loose from
		//? the cycles: for the console, time jumped.
		//ok, 16-07-2026
		this.rtcMs = Date.UTC(1996, 0, 1, 12, 0, 0);   // "new" console: 01/01/1996 12:00
		this.rtcRemainderMs = 0;                            // fractional frame accumulator

		// --- SCSP (sound chip): registers + timers + interrupts ---
		this.scspRam = new Uint8Array(0x1000);   // SCSP registers (0x000-0xFFF)
		// dmaRemaining: samples the internal DMA still needs to finish; dmaFrac: the share
		// of memory cycles it takes, i.e. the share the 68000 loses (see _scspDma).
		this.scsp = { sample: 0, tCount: [0, 0, 0], tReload: [-1, -1, -1], dmaInProgress: false, dmaRemaining: 0, dmaFrac: 0 };
		this.reset68k = false;      // the loop resets the 68k when the BIOS turns it on

		// SCSP audio engine: 32 PCM synthesis slots over scspRam + soundRam.
		// In the browser ScspEngine comes from scsp.js (via <script>); in Node it is required.
		const Engine = (typeof ScspEngine !== "undefined") ? ScspEngine
			: ((typeof require !== "undefined") ? require("./scsp.js").ScspEngine : null);
		this.scspEngine = Engine ? new Engine(this) : null;

		// A-bus cartridge (cart.js): set by putCartridge() when a disc that asks for it
		// is mounted. null = no cartridge: the bus decodes as always and the
		// console behaves the same as before cart.js existed.
		// It has to stay BEFORE the _buildPages() below, which queries it.
		this.cart = null;

		this._buildPages();   // page table for fast memory accesses

		// Video state for the timing (handled by the emulation loop).
		// TVSTAT (VBLANK/HBLANK/ODD/PAL...). It starts with ODD=1: we run progressive and
		// on hardware that bit is fixed at 1 in that mode (see _applyRegionTvstat).
		this.tvstat = 0x0002;
		// HBLANK derivation (overwritten by _applyRegionTvstat with the region's values).
		this.cyclesPerLine = 1708;                 // SH-2 cycles per line (NTSC)
		this.cyclesHblank   = Math.round(1708 * FRAC_ACTIVE_LINE);
		this.linesPerFrame = 262;                  // video lines per frame (NTSC)
		this.hblankLastLine = -1;                // last line that fired HBlank-IN
		// System master clock (scheduler.js). While it is not connected, the
		// beam position keeps being derived from cpuMaster.cycles as it was until 25-07-2026
		// — with the two problems that has: that counter goes to ZERO on cpu.reset()
		// (and the beam jumped with it) and it does not advance with the CPU halted (and the video
		// froze). See connectScheduler().
		this.plan = null;
		// LATCHED H/V counters returned by HCNT (180008H) and VCNT (18000AH). They are
		// not live counters: _latchHv() refreshes them when someone asks for the latch.
		this.hcntLatch = 0;
		this.vcntLatch = 0;

		// Log of accesses to unmodeled MMIO (to know what the BIOS is missing). It is read
		// through the mmioUnknown getter, which flushes the accumulator below before handing
		// it over. See _registerUnknown.
		this._mmioUnknown = new Map();
		// Accumulator for the LAST unknown address, so its key is not rebuilt on every
		// access: a game that polls hardware we do not have ALWAYS hits the same one.
		this._descAddr = -1;
		this._descType = "";
		this._descN = 0;
		this.logging = false;

		// SMPC: SF flag (status). 0 = ready. The BIOS polls it after every command.
		this.smpc[0x63] = 0x00;
	}

	// Loads the BIOS into the Boot ROM. `name` is the file name and it is optional:
	// it is only used to break the tie between US and Europe, which share the same ROM.
	loadBios(bytes, name)
	{
		this.bootRom.set(bytes.subarray(0, Math.min(bytes.length, this.bootRom.length)));
		this._detectAreaBios(name);
	}

	// Deduces the SMPC area code from the loaded BIOS.
	// On real hardware the area code is set by the BOARD (jumpers), not the ROM: that is why
	// US and EU consoles share the same BIOS (mpr-17933) and only differ
	// by the area code. But the Japanese BIOS IS a different ROM, so reporting
	// "North America" with a Japanese BIOS is inconsistent (it was a hardcoded 0x04).
	// ROM header at 0x800: "BTR" + variant + version(4) + mark + date(6).
	//   0x809 == 'U'                     -> Sega US/EU BIOS  -> North America or Europe
	//   0x809 == '1','2','H','J' or other -> Japanese BIOS (Sega/Hi-Saturn/V-Saturn)
	// Verified against the 11 BIOSes in the repo (see 0x800 of each dump).
	// Byte 0x809 is NOT enough to separate US (NTSC) from Europe (PAL): both use
	// the same dump, so there the file name breaks the tie (SMPC_RE_BIOS_PAL).
	// It is a heuristic, not data from the dump: it is the only thing there is.
	//ok, 16-07-2026
	_detectAreaBios(name)
	{
		const magic = String.fromCharCode(this.bootRom[0x800], this.bootRom[0x801], this.bootRom[0x802]);
		if(magic !== "BTR") return;   // odd dump: keep the area code that was already there
		const mark = String.fromCharCode(this.bootRom[0x809]);
		if(mark !== "U")   // Japanese BIOS: it is a different ROM, no ambiguity
			this.areaCode = SMPC_AREA_JAPAN;
		else                // US/EU BIOS: the dump is the same, the name decides
			this.areaCode = SMPC_RE_BIOS_PAL.test(name || "") ? SMPC_AREA_EU_PAL : SMPC_AREA_NA;
		this._applyRegionTvstat();
	}

	// The console is PAL (50 Hz) or NTSC (59.94 Hz) according to the area code: it is marked by
	// bit 3, same as in Mednafen (ss.c: "PAL = smpc_area & SMPC_AREA__PAL_MASK").
	// The emulation loop uses it to know what speed to limit the console to.
	//ok, 16-07-2026
	isPal()
	{
		return (this.areaCode & SMPC_AREA_MASK_PAL) !== 0;
	}

	// Advances the console clock ONE FRAME of EMULATED time. The loop calls it once
	// per frame, so the RTC runs at the Saturn's pace and not the browser's: if the
	// emulator runs slow, the clock runs slow; in turbo, it runs fast. Same as the hardware.
	// NTSC = 1000/59.94006 = 16.6833 ms per frame; PAL = 1000/50 = exactly 20 ms.
	// The fractional remainder is accumulated so as not to lose ~0.4 s every 10 minutes.
	//ok, 16-07-2026
	// Clears SF and fires the interrupt when the SMPC command has served its time.
	// The loop calls it once per frame (same as rtcTick).
	// The command's EFFECT (SNDON, CKCHG, INTBACK...) was already applied when it was written; the only thing
	// that waits here is the SIGNALING, which is what the game looks at. It is the same split as
	// the CD block: HLE with latency. That is why the descriptor only keeps `remaining`: it used to carry
	// the command number too and nobody read it (flagged by orphans.mjs, 27-07-2026).
	//ok, 26-07-2026
	smpcTick(cycles)
	{
		if(!this.smpcPending) return;
		this.smpcPending.remaining -= (cycles > 0 ? cycles : 0);
		if(this.smpcPending.remaining > 0) return;
		const withIrq = this.smpcPending.irq;
		this.smpcPending = null;
		this.smpc[0x63] = 0x00;              // SF ready: this DOES apply to every command
		// ★ BUT NOT EVERY COMMAND ASKS FOR THE INTERRUPT: ONLY INTBACK DOES.
		// The SMPC's 16 commands fall into issuance classes:
		//   class B — commands that take no command parameters and return no
		//             result parameters (except for OREG31): SSHON, SSHOFF, SNDON,
		//             SNDOFF, CDON, CDOFF, RESENAB, RESDISA
		//   class D — a command that takes command parameters, returns result
		//             parameters, and REQUESTS SMPC INTERRUPTS when the result parameters
		//             are complete: INTBACK, and it is the ONLY one in its class.
		// So the end of a class B command is detected by POLLING SF, and
		// Daytona USA itself does exactly that (disassembled at 0x0601e300: it writes COMREG=0x1A
		// and then spins reading SF until it sees it at 0).
		//
		// What sending it too often cost, measured with diag/intback-cadence.mjs: Daytona's healthy
		// cadence is 1 INTBACK and 2 IRQ 0x47 per frame; in the frames where the
		// game also sends RESENAB/RESDISA there were 3 and 4. Every extra IRQ enters the
		// INTBACK handler, which parses the OREGs —where the peripheral data of the
		// previous delivery remains— and queues a peripheral nobody asked for. The parser is left with
		// "1 peripheral pending" and none to process, spinning with IMASK=15, i.e. with
		// the VBlank-OUT that would unstick it blocked by its own mask.
		//ok, 29-07-2026
		if(withIrq) this._scuIrq(7, 8, 0x47);
	}

	rtcTick()
	{
		const msPerFrame = this.isPal() ? 20 : (1001000 / 60000);   // 16.68333... ms
		this.rtcRemainderMs += msPerFrame;
		const integers = Math.floor(this.rtcRemainderMs);
		if(integers > 0)
		{
			this.rtcMs += integers;
			this.rtcRemainderMs -= integers;
		}
	}

	// The console's time, as a Date (in UTC: the Saturn's RTC has no time zone,
	// it is whatever time the user set).
	//ok, 16-07-2026
	rtcDate()
	{
		return new Date(this.rtcMs);
	}

	// Name of the region's video standard, to show in the UI.
	//ok, 16-07-2026
	regionName()
	{
		return this.isPal() ? "PAL" : "NTSC";
	}

	// Mirrors the region into the PAL bit of the VDP2's TVSTAT (bit 0). Games
	// read it to adjust themselves (vertical resolution, speed), so it has to
	// match the fps we actually run at: if we lie to them, they
	// configure themselves for a video standard that is not the one we are emulating.
	//ok, 16-07-2026
	_applyRegionTvstat()
	{
		if(this.isPal()) this.tvstat |= 0x0001;
		else             this.tvstat &= ~0x0001;
		// ODD (bit 1): even/odd field of the interlace. We run 320x224 PROGRESSIVE and
		// for that case the hardware is unambiguous: the scan field flag
		// (odd/even field flag, ODD, bit 1) is always 1 in non-interlace mode.
		// Mednafen does the same (md_vdp2.c:448: in the non-interlaced branch, Odd = true).
		// Nobody ever asserted it: a game waiting for ODD==1 spun forever.
		this.tvstat |= 0x0002;
		// SH-2 cycles per video line, to derive the TVSTAT HBLANK
		// (see _mmioRead). NTSC: 447443 cycles / 262 lines. PAL: 537482 / 313.
		this.cyclesPerLine = this.isPal() ? 1717 : 1708;
		this.cyclesHblank   = Math.round(this.cyclesPerLine * FRAC_ACTIVE_LINE);
		this.linesPerFrame = this.isPal() ? 313 : 262;
	}

	// Connects the master SH-2 so interrupts can be injected into it.
	connectCpu(cpu)
	{
		this.cpuMaster = cpu;
	}

	// Connects the slave SH-2 (the second CPU) so it can be turned on/off with
	// SSHON/SSHOFF. SCU interrupts do NOT go to the slave: they only go to the master
	// (Yabause does the same). The slave has its own INTC, its own VBR and its
	// own on-chip peripherals (DIVU/DMAC/FRT), which it already gets by being another
	// SH2 instance.
	connectCpuSlave(cpu)
	{
		this.cpuSlave = cpu;
	}

	// Fires an SCU interrupt: marks the status and, if it is not masked
	// in the SCU's IMR, requests it from the SH-2 with its fixed level and vector.
	_scuIrq(bit, level, vector)
	{
		// IST (0xA4): interrupt STATUS register. It ALWAYS latches, whether or not
		// the interrupt is masked: the IMR only decides whether it is delivered to the SH-2, not
		// whether the event is recorded. The BIOS polls it directly (clears the IST,
		// waits, and looks at the bit) to sync with the VBlank without using interrupts,
		// so without this it keeps spinning forever.
		const ist = this._readRegBE(this.scuRegs, 0xA4, 4) >>> 0;
		this._writeRegBE(this.scuRegs, 0xA4, (ist | (1 << bit)) >>> 0, 4);

		// The MASK of an A-Bus interrupt (IST bits 16+; the CD block is
		// external 0) is BIT 15 of the IMS: the IMS ends there, it has no bits 16-31.
		// IMS bit 15 is the A-Bus interrupt mask bit, and
		// IST bit 16 = External 0. It used to test (1 << 16) against a
		// register that does not reach that bit: the CD IRQ was ALWAYS delivered, even when
		// the game had it masked (the typical IMS 0xBFFF blocks it precisely through
		// bit 15) — CD IRQs landing in the middle of critical sections of the streaming.
		const bitMask = (bit >= 16) ? 15 : bit;
		const imr = this._readRegBE(this.scuRegs, 0xA0, 4);
		if(!(imr & (1 << bitMask)))
		{
			// Unmasked: deliver to the SH-2 right away.
			if(this.cpuMaster) this.cpuMaster.requestInterrupt(level, vector);
		}
		else
		{
			// Masked: latch until the BIOS unmasks it. It is latched by the
			// REAL IST bit (16), not by the mask one: it identifies the interrupt.
			this.scuPending |= (1 << bit);
		}
	}

	// "Sprite Draw End" (bit 13): the VDP1 finished processing its command list.
	// Wired by vdp1.js (this.bus.vdp1EndDraw()) when it closes the list. Game
	// engines raise a flag in WRAM, start the plot and wait for the handler
	// of this interrupt to clear it, so without it they keep spinning forever
	// after the license screen.
	// ✖ DELAYING THIS NOTICE BY THE COST OF THE LIST WAS TRIED, AND IT BROKE THINGS (29-07-2026).
	// Do not try again along this path; the measurement and the reason are below.
	//
	// The idea was right and still stands: the VDP1 LIES to the game, because however heavy
	// the list is, the "I'm done" always lands at the same instant of the frame. The time
	// even came straight from the hardware without inventing anything — the VDP1 draws parts into the
	// frame buffer 1 PIXEL AT A TIME, and the measured cost goes from 20,000 to 180,000 pixels per
	// frame, i.e. from 12 to 105 lines out of 262.
	//
	// WHY IT CANNOT BE DONE THIS WAY: plot() does not run when the plot is triggered, it runs WHEN
	// THE FRAME IS CLOSED (which is what the decoupled render architecture requires). Adding the
	// cost to THAT instant does not delay the notice within the frame: it pushes it to the
	// NEXT frame. Measured with health.mjs: X-Men COTA 56% -> 16% picture and X-Men VS 64% -> 12%.
	// The rest did not move, which confirms it is not the number but the starting
	// point — at 1 px/cycle the maximum delay was 40% of a frame, plenty of room if it were counted
	// from the trigger.
	//
	// → For this to mean anything, the spread-out drawing has to come FIRST: the VDP1
	// consuming the list across the frame from the trigger, with COPR advancing. It is the
	// same debt ENDR has (see the comment in vdp1.js) and the "pseudo draw
	// continuation": the three get lifted together or none does.
	vdp1EndDraw()   //ok, 17-07-2026
	{
		this._scuDmaPerEvent(6);   // DMA channels armed on the VDP1 end of draw
		this._scuIrq(13, 0x2, 0x4D);
	}

	// The CD block asserts its interrupt (SCU external 0) when HIRQ & HIRQ_Mask.
	_cdUpdateIrq()
	{
		if(this.cdHirq & this.cdHirqMask)
			this._scuIrq(16, 0x7, 0x50);
	}

	// ---------------- SCU DMA (3 channels) ----------------
	// Per-channel registers (offsets in scuRegs, base = channel*0x20):
	//   DxR  0x00 read address (source)             DxW  0x04 write address (destination)
	//   DxC  0x08 byte count                        DxAD 0x0C increment (bit8=read +4; bits0-2=write)
	//   DxEN 0x10 enable (bit8) + go (bit0)         DxMD 0x14 mode (bit24=indirect) + start factor (bits0-2)
	// HLE: the transfer is immediate on the trigger (not cycle by cycle).

	// Masks the count according to the channel width (level 0: 20 bits; levels 1/2: 12 bits).
	// A count of ZERO is not "transfer nothing": on the SCU it means the channel's MAXIMUM
	// (0x100000 for level 0, 0x1000 for levels 1 and 2). The two rules are needed
	// together, because masking turns a request for the exact maximum into 0: asking for 0x1000
	// bytes through channel 1 gives 0x1000 & 0xFFF = 0, and taking it literally leaves the transfer as
	// nothing. That is how Sega Rally's GRAY SKY was taken down (24-07-2026): the game switches to CRMD=1
	// (2048 colors) and sends DMAs to Color RAM with cnt=0 (the whole CRAM, 4096 bytes = 2048
	// colors); they ran moving 0 bytes, the new palette never arrived and the old one
	// from CRMD=0 stayed, with the upper half as a pure mirror of the lower one. The sky comes in through index
	// 1413 and found the gray of 389. Secondary reference: Yabause's scu.c and Mednafen
	// do the same.
	_scuDmaCount(channel, raw)
	{
		const max = channel === 0 ? 0x100000 : 0x1000;
		const n = (channel === 0 ? (raw & 0xFFFFF) : (raw & 0xFFF)) >>> 0;
		return n === 0 ? max : n;
	}

	// Copies a block honoring the source/destination increments.
	// incRead: 0 (fixed source = fill) or 4. incEsc: 0, 2, 4, 8, 16, 32, 64 or 128.
	//
	// THE LAST STRETCH GOES BYTE BY BYTE when the count is not a multiple of 4. The SCU DMA
	// is basically long-word access through the DMA controller's buffer, but if the
	// start address and end address are not on long-word boundaries, reads and writes
	// are made in byte units and the DMA transfer can still be executed:
	// the loose edges in bytes and the middle in long words.
	//
	// Before, the loop advanced 4 at a time until it PASSED cnt, so with a count of 6 it wrote 8
	// bytes: **it clobbered up to 3 bytes beyond the requested block**. It is not theoretical — measured with
	// diag/scu-dma-alignment.mjs over 2,000 frames: Virtua Fighter 2 sends **875
	// transfers with an unaligned count (34.11 % of its own)**, SF Alpha 74
	// unaligned destinations and Sonic 3D 5 sources and 6 counts.
	//? What is still not modeled is the STARTING edge: if `src` or `dst` are not aligned,
	//? the hardware would do the first bytes loose and here an unaligned long is read/written.
	//? It is left like that because the result matches unless the access crosses a region boundary
	//? of the memory map, and that cannot be resolved without modeling the DMA's internal buffer.
	_scuDmaCopy(src, incRead, dst, incWrite, cnt)
	{
		if(cnt <= 0) return;
		let s = src >>> 0, d = dst >>> 0, i = 0;
		if(incWrite === 2)
		{
			// Write in 16-bit units (typical towards the VDP VRAM).
			while(i < cnt)
			{
				const val = this.readLong(s) >>> 0;
				const remaining = cnt - i;
				if(remaining >= 4)
				{
					this.writeWord(d, (val >>> 16) & 0xFFFF); d = (d + 2) >>> 0;
					this.writeWord(d, val & 0xFFFF);          d = (d + 2) >>> 0;
				}
				else
				{
					// Tail: only the missing bytes are delivered, from the most significant to the
					// least (the bus is big-endian).
					if(remaining >= 2){ this.writeWord(d, (val >>> 16) & 0xFFFF); d = (d + 2) >>> 0; }
					if(remaining === 1) this.writeByte(d, (val >>> 24) & 0xFF);
					if(remaining === 3) this.writeByte(d, (val >>> 8) & 0xFF);
				}
				s = (s + incRead) >>> 0;
				i += 4;
			}
			return;
		}
		while(i < cnt)
		{
			const remaining = cnt - i;
			const val = this.readLong(s) >>> 0;
			if(remaining >= 4) this.writeLong(d, val);
			else for(let k = 0; k < remaining; k++)
				this.writeByte((d + k) >>> 0, (val >>> (24 - k * 8)) & 0xFF);
			s = (s + incRead) >>> 0;
			d = (d + incWrite) >>> 0;
			i += 4;
		}
	}

	// Runs the DMA of the channel (0, 1 or 2): reads its config from scuRegs, transfers in
	// direct or indirect mode, and when done fires the DMA-End interrupt.
	_scuDma(channel)
	{
		const base = channel * 0x20;                                          // 0x00, 0x20, 0x40
		const dst  = this._readRegBE(this.scuRegs, base + 0x04, 4) >>> 0;   // DxW
		const cnt  = this._readRegBE(this.scuRegs, base + 0x08, 4) >>> 0;   // DxC
		const add  = this._readRegBE(this.scuRegs, base + 0x0C, 4) >>> 0;   // DxAD
		const mode = this._readRegBE(this.scuRegs, base + 0x14, 4) >>> 0;   // DxMD
		const src  = this._readRegBE(this.scuRegs, base + 0x00, 4) >>> 0;   // DxR

		// The hardware clears the go bit (bit0) of the enable when the transfer starts.
		const en = this._readRegBE(this.scuRegs, base + 0x10, 4) >>> 0;
		this._writeRegBE(this.scuRegs, base + 0x10, en & ~0x1, 4);
		this.scuDmaBuilt[channel] = false;

		// Read increment: 0 (fill) or +4. Write increment: 3-bit table.
		const incRead = (add & 0x100) ? 4 : 0;
		const incWrite  = [0, 2, 4, 8, 16, 32, 64, 128][add & 0x7];

		if(mode & 0x01000000)   // DxMD bit24 = indirect mode (descriptor list)
		{
			// Table pointed to by DxW; each entry is 3 longwords: [count, dst, src].
			// Bit31 of the read address (src) marks the last descriptor.
			let table = dst >>> 0;
			for(let guard = 0; guard < 0x10000; guard++)   // guard against an infinite loop
			{
				const eCnt = this.readLong(table)     >>> 0;
				const eDst = this.readLong(table + 4) >>> 0;
				const eSrc = this.readLong(table + 8) >>> 0;
				this._scuDmaCopy(eSrc & 0x07FFFFFF, incRead, eDst & 0x07FFFFFF, incWrite,
					this._scuDmaCount(channel, eCnt));
				if(eSrc & 0x80000000) break;   // last descriptor of the list
				table = (table + 0x0C) >>> 0;
			}
		}
		else                    // direct mode: one contiguous block of DxC bytes
		{
			this._scuDmaCopy(src & 0x07FFFFFF, incRead, dst & 0x07FFFFFF, incWrite,
				this._scuDmaCount(channel, cnt));
		}

		// End of DMA: interrupt of the matching level (level 0 = bit11, etc.).
		if(channel === 0)      this._scuIrq(11, 0x5, 0x4B);   // Level 0 DMA End
		else if(channel === 1) this._scuIrq(10, 0x6, 0x4A);   // Level 1 DMA End
		else                 this._scuIrq(9,  0x6, 0x49);   // Level 2 DMA End
	}

	// Runs the armed DMA channels FOR THIS activation FACTOR.
	//
	// This used to fire ALL the armed channels at VBlank-IN, whatever their
	// factor —the comment said so: "we fire them at VBlank-IN as a safe approximation
	// of the real timing"—. It is not safe: a channel armed for H-Blank-IN has to fire
	// up to 262 times per frame and we gave it ONE, at a different moment.
	//
	// The activation factors on hardware (where, in addition, ALL of them
	// require the enable bit):
	//     000 VBlank-IN   001 VBlank-OUT   010 HBlank-IN   011 timer 0
	//     100 timer 1     101 SCSP request                110 VDP1 end of draw
	//     111 the register's activation bit (immediate, resolved by the DxEN write)
	//
	// On hardware, a trigger that arrives while the channel is busy
	// is held until the DMA being executed ends, and it is held for only ONE
	// execution. We meet that by construction: scuDmaBuilt is one boolean per channel,
	// so two triggers in a row do not queue two transfers.
	//
	// MEASURED IMPACT: NONE in the 10 games. diag/scu-dma-factors.mjs says that all ten
	// use ONLY factor 7 (immediate) — rally 3,151, xmen 7,462, daytona 240... and zero of
	// all the others. It is done for accuracy and for the other discs, not to fix a
	// symptom, same as the SH-2's DRCR.
	//ok, 29-07-2026
	_scuDmaPerEvent(factor)
	{
		for(let c = 0; c < 3; c++)
		{
			if(!this.scuDmaBuilt[c]) continue;
			// The factor lives in bits 2-0 of the channel's DxMD (0x14 + channel*0x20).
			if((this._readRegBE(this.scuRegs, c * 0x20 + 0x14, 4) & 0x7) !== factor) continue;
			this._scuDma(c);
		}
	}

	// INTBACK: fills the SMPC's OREGs with the peripheral report.
	// Port 1 = a standard digital pad; port 2 empty.
	// INTBACK phase 1: SMPC status (RTC, area code, hardware flags).
	_intbackStatus()
	{
		const o = (n, v) => { this.smpc[0x21 + n * 2] = v & 0xFF; };
		// Real browser RTC, in BCD, with the EXACT layout of Mednafen smpc.c:
		//   OREG1 = year[0] (century BCD, e.g. 0x20)   OREG2 = year[1] (year BCD, e.g. 0x26)
		//   OREG3 = (day-of-week<<4) | month        (day-of-week 0=Sunday..6=Saturday; month 1-0xC)
		//   OREG4 = day of the month (BCD)   OREG5 = hour   OREG6 = minute   OREG7 = second
		// It comes from the console's EMULATED RTC (rtcMs), which advances with emulated time
		// through rtcTick(). In UTC: the Saturn's RTC has no time zone, it keeps the time
		// the user set through SETTIME.
		const f = this.rtcDate();
		const bcd = (n) => (((n / 10) | 0) << 4) | (n % 10);
		const yearTm = f.getUTCFullYear() - 1900;   // years since 1900 (equivalent to tm_year in C)
		// OREG0: bit7 = STE (RTC valid), bit6 = RESD (in the INTBACK status:
		// "0: reset enabled / 1: reset disabled"). RESD was stuck at 0 and it was the
		// only reader smpcResetHab had: the RESENAB (19H) and RESDISA
		// (1AH) commands were implemented but their effect showed up nowhere.
		// Mednafen smpc.c:1333: OREG[0] = (RTC.Valid << 7) | (!ResetNMIEnable << 6).
		//? Careful with the INITIAL VALUE: on hardware the default of RESD is 1 (reset
		//? disabled) and Mednafen starts the same way (ResetNMIEnable = false, smpc.c:626),
		//? but we start with smpcResetHab = true -> RESD = 0. It is not touched:
		//? changing it moves the BOOT's OREG0 (0x80 -> 0xC0) and there is no way to verify
		//? the boot without the browser. Since we do not emulate the physical reset button, the
		//? flag does nothing beyond this. //!wip, 16-07-2026
		o(0x0, 0x80 | (this.smpcResetHab ? 0 : 0x40));
		o(0x1, bcd(19 + ((yearTm / 100) | 0)));   // year high byte (century): 2026 -> 0x20
		o(0x2, bcd(yearTm % 100));                // year low byte: 2026 -> 0x26
		o(0x3, (f.getUTCDay() << 4) | (f.getUTCMonth() + 1));   // day-of-week | month (1-12 = 0x01-0x0C)
		o(0x4, bcd(f.getUTCDate()));         // day of the month (1-31)
		o(0x5, bcd(f.getUTCHours()));        // hour (0-23)
		o(0x6, bcd(f.getUTCMinutes()));      // minute (0-59)
		o(0x7, bcd(f.getUTCSeconds()));      // second (0-59)
		// OREG8: code of the inserted cartridge. It was stuck at 0x00 -"no cartridge"-
		// even when there was one: putCartridge() connects the RAM cart by the game's serial
		// (cart.js, CART_GAMES) but the SMPC kept reporting there was nothing. A
		// game that REQUIRES the cartridge -X-Men vs. Street Fighter asks for the 4 MB one- asks
		// through here and does not boot if we tell it it is not there.
		o(0x8, this.cart ? (this.cart.id & 0xFF) : 0x00);
		o(0x9, this.areaCode);               // area code: comes from the BIOS (_detectAreaBios)
		// OREG10 = system status 1 (INTBACK status):
		//     bit7=0 | bit6=DOTSEL | bit5=1 | bit4=1 | bit3=MSHNMI | bit2=1 | bit1=SYSRES | bit0=SNDRES
		// THIS IS WHERE DOTSEL IS READ: the DOTSEL signal indicates the current screen mode
		// (horizontal resolution) (0:320 1:352). It was stuck at 1 -> the SMPC
		// ALWAYS reported 352 even though the console boots in 320 and even when the game
		// asked for CKCHG320. Now it comes from the real state (set by CKCHG320/352).
		// Mednafen smpc.c:1340-1345 does exactly this:
		//     OREG[0xA] = 0x24 | ((CurrentClockDivisor == CLOCK_DIVISOR_28M) << 6) |
		//                 (SlaveSH2On << 4) | (true << 3) | (true << 1) | (SoundCPUOn << 0);
		// and starts at CLOCK_DIVISOR_26M (smpc.c:662), i.e. DOTSEL=0 = 320, same as
		// our smpcDotsel = 0 in the constructor.
		o(0xA, 0x24 | (this.smpcDotsel ? (1 << 6) : 0) | (this.smpcSlaveOn ? (1 << 4) : 0) |
		       (1 << 3) | (1 << 1) | (this.smpcSoundOn ? 1 : 0));
		o(0xB, (this.smpcCdOn ? (1 << 6) : 0) | (1 << 1));
		// OREG12-15 = "SMEM1~4 retained data": the SMPC's 4 bytes of battery-backed
		// memory, written by SETSMEM (17H). THIS is the only reader of SMEM: the
		// game reads it back through here (SETSMEM sets all 4 bytes
		// at the same time; to update the contents, the INTBACK command is used to read the
		// currently held data). Mednafen smpc.c:1349-1350: OREG[0xC + i] = SaveMem[i].
		for(let i = 0; i < 4; i++) o(0xC + i, this.smpcSmem[i]);
	}

	// INTBACK peripheral data, from OREG0 (overwrites the status).
	// Port 1 with the selected peripheral (see peripheral1); port 2 empty.
	// Format: IDTap(0xF1), ID, data..., 0xF0 (see Mednafen smpc.c).
	_intbackPeripheral()
	{
		const o = (n, v) => { this.smpc[0x21 + n * 2] = v & 0xFF; };
		o(0, 0xF1);                               // port 1: direct connection, 1 peripheral
		const n = this._reportPeripheral1(o, 1);   // ID + data from OREG1; returns the next index
		o(n, 0xF0);                               // port 2: no peripherals
	}

	// Emits the ID and data bytes of the port 1 peripheral starting at OREG[base]
	// (using the writer `o`). Returns the index of the next free OREG, so that the
	// caller puts the port 2 header there. The low nibble of the ID is ALWAYS the
	// number of data bytes emitted.
	_reportPeripheral1(o, base)
	{
		let i = base;
		switch(this.peripheral1)
		{
			case "pad3d":                    // analog 3D Control Pad (ID 0x16, 6 bytes)
				o(i++, 0x16);
				o(i++, this.pad1a);          // digital byte 1 (Right/Left/Down/Up/Start/A/C/B)
				o(i++, this.pad1b);          // digital byte 2 (R/X/Y/Z/L)
				o(i++, this.an1x);           // AX: horizontal stick
				o(i++, this.an1y);           // AY: vertical stick
				o(i++, this.an1r);           // AR: analog R trigger
				o(i++, this.an1l);           // AL: analog L trigger
				break;
			case "wheel":                    // Racing/Arcade Racer (ID 0x13, 3 bytes)
				o(i++, 0x13);
				o(i++, this.pad1a);          // digital byte 1 (Up/Down = shift paddles)
				o(i++, this.pad1b);          // digital byte 2 (X/Y/Z)
				o(i++, this.wheel1);         // AX: wheel (0=left, 0xFF=right, center 0x80)
				break;
			case "mouse":                    // Shuttle Mouse (ID 0xE3, 3 bytes)
			{
				const m = this._reportMouse1();
				o(i++, 0xE3);
				o(i++, m[0]);                // flags: YOver/XOver/YSign/XSign/Start/Middle/Right/Left
				o(i++, m[1]);                // XD: magnitude of the X movement (unsigned)
				o(i++, m[2]);                // YD: magnitude of the Y movement (unsigned)
				break;
			}
			case "gun":                      // Virtua Gun / Stunner (ID 0x25, 5 bytes)  //?
				o(i++, 0x25);
				o(i++, this._reportGunFlags1());   // trigger (bit4) / start (bit5), active-low
				o(i++, (this.gun1x >> 8) & 0xFF);   // Xhi
				o(i++, this.gun1x & 0xFF);          // Xlo
				o(i++, (this.gun1y >> 8) & 0xFF);   // Yhi
				o(i++, this.gun1y & 0xFF);          // Ylo
				break;
			default:                         // "pad": standard digital Control Pad (ID 0x02, 2 bytes)
				o(i++, 0x02);
				o(i++, this.pad1a);          // data byte 1 (Right/Left/Down/Up/Start/A/C/B)
				o(i++, this.pad1b);          // data byte 2 (R/X/Y/Z/L)
				break;
		}
		return i;
	}

	// Encodes the Shuttle Mouse's relative movement into the SMPC format. Returns
	// [flags, XD, YD]. The movement goes in SIGN+MAGNITUDE+OVERFLOW (pointing device
	// format): flags = [7]YOver [6]XOver [5]YSign [4]XSign [3]Start [2]Middle
	// [1]Right [0]Left; XD/YD = absolute magnitude 0-255; the Over bit is set if the
	// magnitude went past 255 (and it saturates). The buttons are active-HIGH (1 = pressed).
	//? Which physical direction is "positive" is not specified: we take negative -> sign=1.
	_reportMouse1()
	{
		const dx = this.mouse1dx | 0, dy = this.mouse1dy | 0;
		const xSign = dx < 0 ? 1 : 0, ySign = dy < 0 ? 1 : 0;
		let xMag = Math.abs(dx), yMag = Math.abs(dy);
		const xOver = xMag > 255 ? 1 : 0, yOver = yMag > 255 ? 1 : 0;
		if(xMag > 255) xMag = 255;
		if(yMag > 255) yMag = 255;
		const flags = (yOver << 7) | (xOver << 6) | (ySign << 5) | (xSign << 4) |
		              (this.mouse1btn & 0x0F);
		return [flags & 0xFF, xMag & 0xFF, yMag & 0xFF];
	}

	// Gun flags byte: trigger = bit4 (0x10), start = bit5 (0x20), active-low
	// (0 = pressed); the rest at 1. Yabause's model (see the //? in the constructor).
	_reportGunFlags1()
	{
		let f = 0xFF;
		if(this.gun1trigger) f &= ~0x10;
		if(this.gun1start)   f &= ~0x20;
		return f & 0xFF;
	}

	// There is "active" input on port 1 (for bit7/PDL of the INTBACK SR). It depends
	// on the peripheral: for the analog ones it counts the stick off center or the trigger
	// pressed; for the mouse, a button or movement; for the gun, trigger or start.
	_hasInputPeripheral1()
	{
		switch(this.peripheral1)
		{
			case "pad3d":
				return (this.pad1a !== 0xFF) || (this.pad1b !== 0xFF) ||
				       (this.an1x !== 0x80) || (this.an1y !== 0x80) ||
				       (this.an1r !== 0x00) || (this.an1l !== 0x00);
			case "wheel":
				return (this.pad1a !== 0xFF) || (this.pad1b !== 0xFF) ||
				       (this.wheel1 !== 0x80);
			case "mouse":
				return (this.mouse1btn !== 0x00) ||
				       (this.mouse1dx !== 0) || (this.mouse1dy !== 0);
			case "gun":
				return this.gun1trigger || this.gun1start;
			default:   // "pad"
				return (this.pad1a !== 0xFF) || (this.pad1b !== 0xFF);
		}
	}

	// ---------- SMPC direct mode (SH-2 direct): reading the pad through PDR ----------
	// The game sets TH (bit6) and TR (bit5)
	// as outputs (DDR), selects SH-2 direct (IOSEL) and reads the RLDU nibble of PDR: the digital
	// pad is a combinational MULTIPLEXER of the (TH,TR) pair — no clock nor ack, TL
	// (bit4) reads a fixed 1. Phases 1-2 are also the Mega Drive ID: the Saturn pad gives
	// 1100/1111 = ID 0xB.
	//ok, 18-07-2026
	_nibblePadDirect(th, tr)
	{
		switch((th << 1) | tr)
		{
			case 3: return (((this.pad1b >> 3) & 1) << 3) | 0x4;   // 1st: L,1,0,0
			case 1: return (this.pad1a >> 4) & 0xF;                // 2nd: Right,Left,Down,Up
			case 2: return this.pad1a & 0xF;                       // 3rd: Start,A,C,B
			default: return (this.pad1b >> 4) & 0xF;               // 4th: R,X,Y,Z
		}
	}

	// Read of PDR1/PDR2 (0x75/0x77): re-evaluates the port bus the way the hardware does.
	// Formula (for ports set to output, the value written into PDR1 is
	// read out rather than the terminal status; Mednafen smpc.cpp UpdateIOBus): bits
	// with DDR=1 read what was WRITTEN, bits with DDR=0 read the device; lines the
	// device does not drive, pull-up to 1; bit7 does not exist (0). With IOSEL=0 the bus is
	// driven by the SMPC firmware, not by the game: inputs at pull-up are enough.
	//? Only the digital pad speaks the direct protocol for now: pad3d/wheel/mouse use
	//? the 3-line handshake and the gun its latch — pending. Their
	//? digital buttons still come out, because they share pad1a/pad1b.
	_readPdr(port)
	{
		const pdrWritten = this.smpc[port ? 0x77 : 0x75] & 0x7F;
		const ddr = this.smpc[port ? 0x7B : 0x79] & 0x7F;
		const iosel = this.smpc[0x7D] & 0x3;
		// Port 2: no peripheral connected -> all inputs read 1 (ID 0xF).
		let device = 0x7F;
		if((iosel & (1 << port)) && port === 0)
		{
			// What the bus "shows": outputs = written value, inputs = pull-up. From
			// there come the TH/TR the pad sees to choose the phase.
			const handled = (pdrWritten | (~ddr & 0x7F)) & 0x7F;
			const th = (handled >> 6) & 1, tr = (handled >> 5) & 1;
			device = 0x70 | 0x10 | this._nibblePadDirect(th, tr);
		}
		return ((pdrWritten & ddr) | (device & ~ddr)) & 0x7F;
	}

	// Answers a CD block command. No disc: status NODISC (0x07).
	// The BIOS writes the command into CR1-4 and reads the response here.
	//ok, 16-07-2026
	_cdCommand()
	{
		// The host sent its first command: it already read the "CDBLOCK" signature, so the
		// block switches to normal operation (CR1-CR4 = responses and periodic report).
		this.cdSignaturePresent = false;

		// NO DISC: historical behavior (NODISC). The BIOS boot depends
		// on this answering exactly like this. Everything new goes behind the if.
		if(!this.cdReader)
		{
			// Which command was requested. It has to be looked at BEFORE CR1 is overwritten with NODISC.
			const cmd = (this._readRegBE(this.cdRegs, 0x18, 2) >> 8) & 0xFF;
			const w = (off, v) => this._writeRegBE(this.cdRegs, off, v & 0xFFFF, 2);
			w(0x18, 0x0700);   // CR1: (status 0x07 NODISC << 8) | is_cdrom<<7 | repcount
			w(0x1C, 0xFFFF);   // CR2: (ctrl_adr << 8) | tno  (no track)
			w(0x20, 0xFFFF);   // CR3: (idx << 8) | (fad >> 16)
			w(0x24, 0xFFFF);   // CR4: fad  (invalid position with no disc)
			this.cdHirq |= 0x0001 | 0x0002;   // CMOK (command ok) | DRDY (drive ready)

			// Abort File (0x75) CANCELS the filesystem operation in progress. With no disc
			// there is nothing to cancel, so it finishes on the spot: the hardware considers it
			// finished anyway and raises EFLS ("filesystem finished"). In Mednafen
			// (cdb.c) Abort File only sets FLS.Abort, and the COMMAND COPROCESSOR
			// -which runs on the clock, disc or no disc- is the one that fires EFLS.
			// Here that path does not exist without a disc: this stub answers and returns without
			// going through _cdExecute(), so the Abort File got lost and EFLS NEVER came
			// back. The BIOS sends Abort File in its "checking disc format" routine and
			// then POLLS EFLS, so the boot WITH NO DISC kept spinning
			// forever: BGON=0 (no layer on) and a black screen.
			if(cmd === 0x75) this.cdHirq |= CD_HIRQ_EFLS;

			this._cdUpdateIrq();          // assert the CD interrupt if appropriate
			return;
		}
		this._cdExecute();
	}

	// ==================================================================
	//                          CD BLOCK
	// Ported from Mednafen beetle-saturn (mednafen/ss/cdb.cpp), GPL v2+.
	// Model: the drive keeps reading RAW sectors (2352 bytes) and putting them into
	// buffers; each sector goes through a chain of FILTERS that route it to a
	// PARTITION (or discard it). The game reads the partitions with Get Sector
	// Data and frees the buffers with Delete Sector Data.
	// ==================================================================

	// Is A-Bus CS2 address `a` answered by the CD block, or is it cartridge area?
	//
	// The CD block does NOT take up the 64 KB of 0x05890000-0x0589FFFF. Its chip (the YGR) has
	// ONLY address lines AA[5:2] and AA[14:12] wired; the rest (including
	// A15 and A19) do not even reach it. srg320 -the author of the Saturn FPGA core- says so
	// on SegaXtreme ("A-Bus CS2"): "Only address bits AA[5:2] and AA[14:12]
	// are connected to YGR". In other words:
	//   - AA[5:2]   -> which register it is:  (a & 0x3F) ... hence the mirror every 64 bytes.
	//   - AA[14:12] -> the chip select:   it only answers if they are 0 -> (a & 0x7000) === 0.
	// Mednafen implements exactly that condition (ss/scu.inc, "if((A & 0x7FFF) <
	// 0x1000)") and the Yabause wiki describes it the same way ("mirrored every 0x40 bytes
	// until 0x25801000, then start again at 0x25808000"). A15 not reaching the chip is
	// what makes 0x05898000 the SAME DTR as 0x05818000 (that is where the BIOS reads
	// the TOC word by word; also verified in SAROO, firmware that runs on a real
	// Saturn: "for(i=0; i<102*4; i+=2) *(u16*)(buf+i) = REG16(0x25898000);").
	//
	// What is left outside belongs to the A-Bus CARTRIDGE, and that is where the
	// NETLINK modem lives: a 16550 UART at 0x05895001 + reg*4, odd byte (Yabause netlink.c:
	// "case 0x95001: // Receiver Buffer", "case 0x95019: // Modem Status Register",
	// "case 0x9501D: // Scratch"; and antime on SegaXtreme: "The external interface is
	// an 16550-style USART that is mapped into the Saturn's cartridge area").
	//
	// WITHOUT THIS DECODE the CD block was mirrored across the 64 KB and answered the Netlink
	// with its own registers. Sega Rally (Netlink Edition) does the classic
	// 16550 presence test -it writes 0x5A and 0xA1 into the Scratch (reg 7 =
	// 0x0589501D) and reads them back-, and since 0x1D is the low byte of CR2, we
	// returned them intact: the game assumed there was a modem connected. Measured
	// on 16-07-2026 with MMIO instrumentation (bus._mmioRead/_mmioWrite).
	//ok, 16-07-2026
	static _cdDecodes(a)
	{
		return (a & 0x7000) === 0;
	}

	// FORMATS THE INTERNAL BACKUP RAM, like the BIOS does at power-on.
	//
	// Freshly created, the buffer is all ZEROS, and for a game that is NOT "empty memory": it is
	// UNFORMATTED memory. SF Alpha spells it out and stops there:
	// "WARNING - THE SYSTEM MEMORY IS NOT READY FOR USE. PLEASE CLEAR ALL FILES USING SEGA
	// SATURN'S MEMORY MANAGER" (seen headless on 26-07-2026, and it is the reason the
	// game never reaches its fight screen in the probes).
	//
	// FORMAT (documented on SegaXtreme, "backup memory structure" and "Backup RAM data
	// format"): the internal backup lives at 0x00180000-0x0018FFFF and ONLY uses the ODD
	// bytes -hence 64 KB of bus give 32 KB usable-, mirrored up to 0x001FFFFF. The
	// area is divided into 512 blocks of 64 bytes:
	//   Block#0000 = header: the ASCII string "BackUpRam Format" repeated 4 times (64 bytes)
	//   Block#0001 = separator, all 0x00, cannot be used for data
	//   Block#0002..#01FF = the games' saves
	// Here the header is written and the rest is left at zero: it is a formatted and
	// EMPTY memory, which is exactly the state of a new console.
	//
	// It does not set backupDirty: it is the initial state, not a user change that has to be
	// persisted. If the user had a saved backup, it is loaded AFTERWARDS and overwrites it.
	//ok, 27-07-2026
	formatBackup()
	{
		const SIGNATURE = "BackUpRam Format";   // 16 characters
		const b = this.backupRam;
		// The 64 logical bytes of block 0 = 4 repetitions of the signature, at the ODD addresses.
		for(let i = 0; i < 64; i++)
			b[i * 2 + 1] = SIGNATURE.charCodeAt(i % SIGNATURE.length);
	}

	// Mounts a disc image (CdReader instance from cd.js) into the CD block.
	// From here on the block stops answering NODISC and behaves as with a disc.
	//ok, 16-07-2026
	mountDisc(reader)
	{
		if(!reader || !reader.tracks || reader.tracks.length === 0) return false;
		this.cdReader = reader;
		this.cd = this._cdStateInitial();
		this._cdBuildToc();
		this._cdTranslateToc();
		// DISC JUST INSERTED: THE DRIVE IS BUSY, NOT READY (27-07-2026).
		//
		// It used to be left in PAUSE instantly, i.e. "ready to work in the same
		// cycle the disc appeared". No drive can do that: the motor has to
		// spin up, lock and read the TOC.
		//
		// And it is not cosmetic. Measured with diag/dchg-sequence.mjs, comparing booting with
		// the disc inserted against a hot disc change over the SAME time
		// window: with the drive "ready" instantly, the BIOS sees it can work, launches
		// Auth Device (0xE0) BEFORE reading the TOC, it does not complete, and it RETRIES the whole
		// sequence from scratch — 33 + 44 polling GetStatus and a whole cycle lost. With
		// the disc inserted from boot that does not happen, because the BIOS arrives when the
		// drive has already settled on its own.
		// It is the pattern this project already knows by heart: THE HARDWARE TAKES TIME, and
		// games (and the BIOS) sync on transitions. A chip that answers "ready" right
		// away breaks the wait the software programmed.
		//
		// The time: ~1 second (150 data sectors, the unit in which cdTick receives the
		// time). It is the order of the motor spin-up of a real CD drive; the exact value
		// is not published, and what matters is that there IS a transition
		// BUSY -> ready for the software to see.
		this.cd.phase = "starting";
		this.cd.pos.status = CD_ST_BUSY;
		this.cdBootRest = 150;
		this._cdPositionFrom(0x800000 | 150);
		this.cd.currentSector = this.cd.pos.fad;
		// DCHG is signaled RIGHT AWAY -the disc changed at this instant, the hardware knows that
		// immediately- but EFLS (end of filesystem operation) only when it is ready.
		this._cdIrq(CD_HIRQ_DCHG);
		return true;
	}

	// Removes the disc: the CD block goes back to answering NODISC (factory state).
	//ok, 16-07-2026
	ejectDisc()
	{
		this.cdReader = null;
		this.cd = null;
		this._writeRegBE(this.cdRegs, 0x18, 0x0700, 2);   // CR1 = NODISC
		this._cdIrq(CD_HIRQ_DCHG | CD_HIRQ_EFLS);
	}

	// Internal state of the CD block with a disc mounted.
	_cdStateInitial()
	{
		const cd =
		{
			// --- Sector buffers: 200 x 2352 raw bytes in a single block ---
			data:  new Uint8Array(CD_BUFFERS * CD_SECTOR_SIZE),
			free: [],                     // stack of free buffer indices
			part:   [],                     // 24 partitions: list of buffer indices
			filters: [],                    // 24 filters
			driveConn: 0xFF,                // filter connected to the drive output
			lastDest: 0xFF,            // last partition that received a sector

			// --- Current pickup position (what is reported in CR1-CR4) ---
			pos: { status: CD_ST_BUSY, fad: 0xFFFFFF, relFad: 0xFFFFFF,
			       tno: 0xFF, idx: 0xFF, ctrlAdr: 0xFF, isCdrom: true, repcount: 0 },

			// --- Drive ---
			phase: "paused",                  // "paused" | "seeking" | "playing" | "stopped" | "starting"
			currentSector: 150,              // FAD the next step will read
			accum: 0,                        // fractional accumulator of sectors per tick
			playStart: 0x800000,           // CurPlayStart (encoded: bit23 = it is a FAD)
			playEnd: 0x800000,              // CurPlayEnd
			playRepeat: 0,                 // how many times to repeat the range
			repetitionsDone: 0,
			playEndIrq: 0,                  // HIRQ to fire on finishing (PEND / EFLS)
			seekRemaining: 0,                // drive steps the seek in progress still needs
			sectorsAfterSeek: 2,            // sectors read since the last seek (2 = already in steady state)
			playCmdStart: 0,               // last parameters of the Play command
			playCmdEnd: 0,
			playCmdRep: 0,

			// --- Scan: fast forward/rewind (command 0x12) ---
			// ScanMode/ScanCounter from Mednafen cdb.c. The scan is NOT a separate drive
			// phase: it rides on the "playing" one (over there DRIVEPHASE_SCAN exists
			// in the enum and nobody uses it, precisely because of this).
			scanMode: -1,                   // -1 = no scan, 0 = forward, 1 = backward
			scanCount: 0,                    // "cost" accumulated since the last jump
			scanBuf: new Uint8Array(CD_SECTOR_SIZE),   // attenuated audio sector of the scan

			// --- Search by FAD (commands 0x55 / 0x56) ---
			// spos = index of the sector found inside the partition (0xFFFF = there was
			// none), fad = its FAD, pnum = which partition was searched.
			fadSearch: { fad: 0, spos: 0, pnum: 0 },

			// --- Disc authentication (Get Auth Status) ---
			// 0 = not authenticated (the hardware does NOT deliver sectors), 1 = audio CD,
			// 2 = non-Saturn data, 4 = valid Saturn disc.
			authType: 0x00,

			// --- Data transfer to the host (Get Sector Data / Get TOC...) ---
			// `writing` = Put Sector Data (the host writes and the CD block receives);
			// `fnum` is the filter those buffers go out through on closing (End Data
			// Transfer). It is not used in read transfers.
			dt: { active: false, writing: false, list: [], currentIdx: 0,
			      offWord: 0, remaining: 0, total: 0, freeAtEnd: false, fnum: 0 },
			getSecLen: 0,                   // index: 0=2048 1=2336 2=2340 3=2352
			putSecLen: 0,
			computedSize: 0,                // result of Calc Actual Size, in 16-bit WORDS

			resultsRead: true,         // the game already read CR4 -> it can report

			// --- TOC and subchannel ---
			toc: null,
			tocBuf: new Uint8Array(0xCC * 2),   // TOC exactly as Get TOC delivers it (204 words)
			subQ:  new Uint8Array(5 * 2),       // Q subchannel   (Get Subcode type 0: 5 words)
			subRW: new Uint8Array(12 * 2),      // R-W subchannel (Get Subcode type 1: 12 words)

			// --- CD block filesystem (commands 0x70-0x75) ---
			// The real CD block parses the ISO9660 ON ITS OWN: the BIOS/the game do not read
			// directory sectors, they send Change Dir / Read Dir and then ask for the
			// already digested file info table. That table is 256 entries of 12 bytes
			// (FAD, size, interleave unit, gap size, file number,
			// attributes), and it is delivered through the DTR as "virtual buffer" 0xF0.
			// Entries 0 and 1 are always "." and ".." of the current directory; from 2
			// onwards goes the window the last Read Dir asked for.
			fileInfo:      new Uint8Array(256 * CD_FI_SIZE),
			fileInfoValid: false,   // a directory was already read (if not, 0x70-0x74 reject)
			fileInfoCount:  0,       // how many valid entries there are from 2 onwards (0..254)
			fileInfoOffs:  2,       // which file id corresponds to entry 2 of the table
			fileInfoMore:   false,   // the directory had more entries than fit
			rootDir:       new Uint8Array(CD_FI_SIZE),   // file info of the root directory
			rootDirValid:  false,

			// Filesystem state machine. It is asynchronous: the commands only
			// start it and the real work (reading the PVD, walking the directory) is done
			// sector by sector from cdTick, same as on the hardware. When it finishes
			// it fires EFLS, which is what the BIOS is waiting for.
			fls: { active: false, doAuth: false, abort: false, pnum: 0,
			       fioffs: 2, fiaoffs: 0, gen: null,
			       pbuf: new Uint8Array(2048), pbufOffs: 0,
			       totalCount: 0, totalMax: 0,
			       record: new Uint8Array(256), recordCount: 0 }
		};

		// Free buffers: all of them, in order.
		for(let i = CD_BUFFERS - 1; i >= 0; i--) cd.free.push(i);
		// Empty partitions.
		for(let i = 0; i < CD_PARTITIONS; i++) cd.part[i] = [];
		// Filters in their default state: "true" output to their own partition,
		// "false" output disconnected, no conditions.
		for(let i = 0; i < CD_PARTITIONS; i++)
			cd.filters[i] = { mode: 0, fad: 0, range: 0, file: 0, channel: 0,
			                  submode: 0, submodeMask: 0, cinfo: 0, cinfoMask: 0,
			                  connTrue: i, connFalse: 0xFF };
		return cd;
	}

	// CD block software reset (Initialize command with bit0). Leaves the filters,
	// buffers and the transfer as freshly powered on, without unmounting the disc.
	_cdSoftReset()
	{
		const cd = this.cd;
		cd.getSecLen = 0; cd.putSecLen = 0;
		cd.computedSize = 0;
		// The result of the last search by FAD is lost too (Mednafen's SWReset
		// resets FADSearch next to CalcedActualSize). scanMode is NOT: over there
		// SWReset does not touch it, only the power-on reset does.
		cd.fadSearch.fad = 0; cd.fadSearch.spos = 0; cd.fadSearch.pnum = 0;
		cd.driveConn = 0xFF;
		cd.lastDest = 0xFF;
		cd.dt = { active: false, writing: false, list: [], currentIdx: 0,
		          offWord: 0, remaining: 0, total: 0, freeAtEnd: false };
		for(let i = 0; i < CD_PARTITIONS; i++)
		{
			cd.filters[i].connTrue  = i;
			cd.filters[i].connFalse = 0xFF;
			this._cdResetCondFilter(i);
			cd.part[i] = [];
		}
		cd.free = [];
		for(let i = CD_BUFFERS - 1; i >= 0; i--) cd.free.push(i);
		cd.playEndIrq = 0; cd.playEnd = 0x800000; cd.playRepeat = 0;
		// The reset throws away what the filesystem had cached (Mednafen's SWReset):
		// the PVD and the directory have to be read again.
		this._cdFlsReset();
		cd.fileInfoValid = false;
		cd.rootDirValid = false;
	}

	// Leaves the filesystem machine idle (no operation in progress).
	_cdFlsReset()
	{
		const f = this.cd.fls;
		f.active = false; f.doAuth = false; f.abort = false;
		f.gen = null; f.pbufOffs = 0; f.totalCount = 0; f.totalMax = 0; f.recordCount = 0;
	}

	// ------------------------------- TOC -------------------------------

	// Builds the CD block's TOC from the reader's tracks. Index 100 is the
	// lead-out (end of the disc), same as in Mednafen.
	_cdBuildToc()
	{
		const t = { tracks: [], first: 99, last: 1, discType: 0x00 };
		for(let i = 0; i <= 100; i++) t.tracks[i] = { valid: false, lba: 0, control: 0x4, adr: 1 };

		let lbaEnd = 0;
		for(const p of this.cdReader.tracks)
		{
			const n = p.number;
			if(n < 1 || n > 99) continue;
			// control bit2 (0x4) = data track; audio ones go at 0.
			t.tracks[n] = { valid: true, lba: p.lbaStart, control: (p.type === "audio") ? 0x0 : 0x4, adr: 1 };
			if(n < t.first) t.first = n;
			if(n > t.last)  t.last  = n;
			if(p.lbaEnd + 1 > lbaEnd) lbaEnd = p.lbaEnd + 1;
		}
		if(t.first > t.last) t.first = t.last;
		// Lead-out: starts right after the last sector of the disc.
		t.tracks[100] = { valid: true, lba: lbaEnd, control: t.tracks[t.last].control, adr: 1 };
		this.cd.toc = t;
	}

	// Translates the TOC into the 408-byte format Get TOC returns: 99 track
	// entries + POINT A0 (first track) + POINT A1 (last) + lead-out.
	_cdTranslateToc()
	{
		const t = this.cd.toc, buf = this.cd.tocBuf;
		const writeFad = (o, ctrlAdr, fad) => {
			buf[o] = ctrlAdr; buf[o+1] = (fad >>> 16) & 0xFF;
			buf[o+2] = (fad >>> 8) & 0xFF; buf[o+3] = fad & 0xFF;
		};
		let o = 0;
		for(let i = 1; i < 100; i++, o += 4)
		{
			const p = t.tracks[i];
			if(p.valid) writeFad(o, (p.control << 4) | p.adr, p.lba + 150);
			else buf[o] = buf[o+1] = buf[o+2] = buf[o+3] = 0xFF;
		}
		// POINT = A0: first track + disc type.
		let p = t.tracks[t.first];
		buf[o] = (p.control << 4) | p.adr; buf[o+1] = t.first; buf[o+2] = t.discType; buf[o+3] = 0; o += 4;
		// POINT = A1: last track.
		p = t.tracks[t.last];
		buf[o] = (p.control << 4) | p.adr; buf[o+1] = t.last; buf[o+2] = 0; buf[o+3] = 0; o += 4;
		// Lead-out.
		p = t.tracks[100];
		writeFad(o, (p.control << 4) | p.adr, p.lba + 150);
	}

	// --------------------- responses and status -------------------------

	// Sets HIRQ bits and re-evaluates the CD interrupt.
	_cdIrq(bits)
	{
		this.cdHirq |= bits & 0xFFFF;
		this._cdUpdateIrq();
		// Wake the pollers RIGHT NOW: a CD event (sector delivered, transfer
		// ready, play finished) is exactly what the games' spin loops wait for
		// reading HIRQ or the sector count. With the idle skip, the sleeping CPU
		// only re-evaluated its loop at the edge of the next chunk (~1700 cycles late);
		// on real HW it leaves the loop in ~10 cycles. Arriving late at a stream
		// boundary made the sequencer see 2-3 accumulated sectors where it expected
		// 1 (Sonic's crashes at the video boundaries). Clearing idle here takes them
		// out of the skip on the next step, as it should.
		if(this.cpuMaster) this.cpuMaster.idle = false;
		if(this.cpuSlave) this.cpuSlave.idle = false;
	}

	// Base status that goes in the high byte of CR1 (Mednafen's MakeBaseStatus).
	_cdStatusBase(rejected, mod)
	{
		if(rejected) return CD_ST_REJECTED;
		if(!this.cdReader) return CD_ST_NODISC;
		return (this.cd.pos.status | mod) & 0xFF;
	}

	// Writes CR1-CR4 with the position report (MakeReport). It does not fire CMOK:
	// it is used both by command responses and by the hardware's periodic report.
	_cdMakeReport(rejected, mod)
	{
		const p = this.cd.pos;
		this._cdWriteCr(
			(this._cdStatusBase(rejected, mod) << 8) | (p.isCdrom ? 0x80 : 0x00) | (p.repcount & 0x7F),
			(p.ctrlAdr << 8) | p.tno,
			(p.idx << 8) | ((p.fad >>> 16) & 0xFF),
			p.fad & 0xFFFF);
	}

	_cdWriteCr(r0, r1, r2, r3)
	{
		this._writeRegBE(this.cdRegs, 0x18, r0 & 0xFFFF, 2);
		this._writeRegBE(this.cdRegs, 0x1C, r1 & 0xFFFF, 2);
		this._writeRegBE(this.cdRegs, 0x20, r2 & 0xFFFF, 2);
		this._writeRegBE(this.cdRegs, 0x24, r3 & 0xFFFF, 2);
	}

	// CD BLOCK SIGNATURE. The block has its own CPU (an SH-1) with firmware: on
	// power-on it leaves in CR1-CR4 the ASCII string "CDBLOCK" to announce it finished
	// booting. Values from Cs2Reset (Yabause cs2.c):
	//   CR1 = ( 0 <<8)|'C'   CR2 = ('D'<<8)|'B'   CR3 = ('L'<<8)|'O'   CR4 = ('C'<<8)|'K'
	// Read as 8 big-endian bytes they give "\0CDBLOCK", which is EXACTLY what the
	// BIOS compares (8-byte memcmp against its literal at 0x4DB0, routine 0x4A9C).
	// If it does not match, its "is there a CD block?" routine returns 0 and the BIOS never sends it a
	// single command: without commands there is no authentication, no filesystem, no game.
	// The signature stays until the host's FIRST command (see cdTick): the periodic
	// report must not overwrite it before the BIOS gets to read it.
	//ok, 16-07-2026
	_cdPresentSignature()
	{
		this._cdWriteCr(0x0043, 0x4442, 0x4C4F, 0x434B);   // "\0CDBLOCK"
		this.cdSignaturePresent = true;
	}

	// CD block reset through the console's Reset button: the block's firmware
	// boots again and presents the signature anew. Without this, a second reset
	// finds the signature already consumed and the disc does not boot. It does not unmount the disc (the
	// reset does not open the tray).
	//ok, 16-07-2026
	resetCdBlock()
	{
		this._cdPresentSignature();
	}

	// "Status" response to a command (Mednafen's CDStatusResults).
	_cdRespStatus(rejected, mod)
	{
		this._cdMakeReport(rejected, mod);
		this.cd.resultsRead = false;
		this._cdIrq(CD_HIRQ_CMOK);
	}

	// Response with the command's own values (Mednafen's BasicResults).
	_cdResp(r0, r1, r2, r3)
	{
		this._cdWriteCr(r0, r1, r2, r3);
		this.cd.resultsRead = false;
		this._cdIrq(CD_HIRQ_CMOK);
	}

	// ------------------------ buffers and filters ------------------------

	// Takes a buffer from the free stack. Returns 0xFF if there is none.
	_cdBufAlloc()
	{
		const cd = this.cd;
		return cd.free.length > 0 ? cd.free.pop() : 0xFF;
	}

	// Returns a buffer to the free stack (the special codes >= 0xF0 are
	// virtual buffers -TOC, subchannel- and are not freed).
	_cdBufFree(b)
	{
		if(b >= CD_BUFFERS) return;
		const cd = this.cd;
		if(cd.free.indexOf(b) < 0) cd.free.push(b);
	}

	// Empties a partition and returns its buffers.
	_cdClearPartition(pnum)
	{
		const cd = this.cd;
		for(const b of cd.part[pnum]) this._cdBufFree(b);
		cd.part[pnum] = [];
	}

	_cdResetCondFilter(fnum)
	{
		const f = this.cd.filters[fnum];
		f.mode = 0; f.fad = 0; f.range = 0; f.channel = 0; f.file = 0;
		f.submode = 0; f.submodeMask = 0; f.cinfo = 0; f.cinfoMask = 0;
	}

	// Connects the drive output to a filter. A filter with an occupied input cannot
	// also be the "false" destination of another (Mednafen's SetCDDeviceConn).
	_cdSetConnectionDrive(fnum)
	{
		const cd = this.cd;
		for(let i = 0; i < CD_PARTITIONS; i++)
			if(cd.filters[i].connFalse === fnum) cd.filters[i].connFalse = 0xFF;
		cd.driveConn = fnum;
	}

	// Disconnects everything that feeds into a filter (Filter_DisconnectInput).
	_cdDisconnectInput(fnum)
	{
		if(fnum === 0xFF) return;
		const cd = this.cd;
		if(cd.driveConn === fnum) cd.driveConn = 0xFF;
		for(let i = 0; i < CD_PARTITIONS; i++)
			if(cd.filters[i].connFalse === fnum) cd.filters[i].connFalse = 0xFF;
	}

	// The FAD declared by the HEADER of a buffer's raw sector: bytes 12-14 = the absolute
	// MSF in BCD. Note that it is NOT "where the pickup was": it is what the sector says,
	// which is the only thing the CD block can look at in a buffer that is already stored.
	// It is the AMSF_to_ABA(BCD_to_U8(data[12+0]), ...) that Mednafen uses the same way in the three
	// places that need this: TestFilterCond, Get Sector Info and Exec FAD Search.
	//ok, 17-07-2026
	_cdFadOfSector(b)
	{
		const d = this.cd.data, base = b * CD_SECTOR_SIZE;
		const fromBcd = (x) => (((x >> 4) & 0xF) * 10) + (x & 0xF);
		return fromBcd(d[base+12]) * 4500 + fromBcd(d[base+13]) * 75 + fromBcd(d[base+14]);
	}

	// Evaluates a filter's condition against a buffer's raw sector.
	_cdTestFilter(fnum, b)
	{
		const cd = this.cd, f = cd.filters[fnum], d = cd.data, base = b * CD_SECTOR_SIZE;

		if(f.mode & 0x40)   // selection by FAD range
		{
			const fad = this._cdFadOfSector(b);
			if(fad < f.fad || fad >= (f.fad + f.range)) return false;
		}

		// The subheader fields only exist in mode2 sectors.
		let file = 0, channel = 0, submode = 0, cinfo = 0;
		if(d[base+15] === 0x02)
		{
			file = d[base+16]; channel = d[base+17]; submode = d[base+18]; cinfo = d[base+19];
		}
		// Mode 0x10 inverts the result of the subheader conditions.
		const inv = !!(f.mode & 0x10) && !!(f.mode & 0x0F);

		if((f.mode & 0x01) && file !== f.file) return inv;                     // by file
		if((f.mode & 0x02) && channel !== f.channel) return inv;                         // by channel
		if((f.mode & 0x04) && (submode & f.submodeMask) !== f.submode) return inv;   // by submode
		if((f.mode & 0x08) && (cinfo & f.cinfoMask) !== f.cinfo) return inv;         // by coding info
		return !inv;
	}

	// Passes a freshly read buffer through the filter chain: if it meets the condition
	// it goes to the partition of its "true" output; if not, it continues through the "false" output.
	// Returns the filter that accepted it, or 0xFF if nobody wanted it (discarded).
	_cdFilterBuffer(fnum, b)
	{
		const cd = this.cd;
		let cur = fnum;
		for(let i = 0; i < CD_PARTITIONS && cur !== 0xFF; i++)
		{
			if(this._cdTestFilter(cur, b))
			{
				const dest = cd.filters[cur].connTrue;
				if(dest !== 0xFF) { cd.part[dest].push(b); return cur; }
				cur = 0xFF;
			}
			else cur = cd.filters[cur].connFalse;
		}
		this._cdBufFree(b);   // no filter accepted it
		return 0xFF;
	}

	// --------------------- pickup position -------------------------

	// Decodes a Play/Seek position and leaves the pickup there (SeekStart1).
	// bit23 = the position is a FAD; if not, it is (track << 8) | index.
	_cdPositionFrom(playStart)
	{
		const cd = this.cd, t = cd.toc, p = cd.pos;
		if(playStart & 0x800000)
		{
			let fad = playStart & 0x7FFFFF;
			const fadEnd = 150 + t.tracks[100].lba;
			if(fad < 150) fad = 150;
			else if(fad >= fadEnd) fad = fadEnd;

			// Find which track the FAD falls in.
			let tt = 1;
			for(let track = 1; track <= 100; track++)
			{
				if(!t.tracks[track].valid) continue;
				if(fad < (150 + t.tracks[track].lba)) break;
				tt = track;
			}
			p.tno = (tt === 100) ? 0xAA : tt;   // 0xAA = lead-out
			p.idx = 1;
			p.fad = fad;
			p.relFad = fad - (150 + t.tracks[tt].lba);
			p.ctrlAdr = (t.tracks[tt].control << 4) | t.tracks[tt].adr;
		}
		else
		{
			let track  = (playStart >> 8) & 0xFF;
			let index = playStart & 0xFF;
			if(track > t.last) track = t.last;
			else if(track < t.first) track = t.first;
			if(index < 1) index = 1;
			else if(index > 99) index = 99;

			p.tno = track;
			p.idx = index;
			p.fad = 150 + t.tracks[track].lba;
			p.relFad = 0;
			p.ctrlAdr = (t.tracks[track].control << 4) | t.tracks[track].adr;
		}
	}

	// Starts a seek towards `dest` playing until `end` (StartSeek).
	_cdInitSeek(dest, end, repeat, irqEnd, noMovePickup)
	{
		const cd = this.cd;
		cd.repetitionsDone = 0;
		cd.playStart = dest;
		cd.playEnd = end;
		cd.playRepeat = repeat;
		cd.playEndIrq = irqEnd;
		// "Without moving the pickup" while already playing: only the
		// range changes, there is no new seek. Unless a SCAN is in progress: then the
		// pickup is jumping around, so there is no "do not move" that holds and it seeks
		// anyway. Mednafen StartSeek: if(no_pickup_change) { if(DrivePhase ==
		// DRIVEPHASE_PLAY && ScanMode < 0) return; }
		if(noMovePickup && cd.phase === "playing" && cd.scanMode < 0) return;
		cd.scanMode = -1;   // any Play/Seek cuts the scan
		// The seek TAKES TIME, but how long depends on HOW FAR the pickup moves:
		// - Near (less than 2 seconds of disc): re-lock almost free. It is the case
		//   of streaming with consecutive Plays — Virtua Cop BOOTS like that, and a fixed
		//   floor of 10 steps (~67ms) per Play was the regression of 18-07: the boot that
		//   re-seeks sector by sector became 10x slower and the screen never
		//   came on (bisect with diag/vc-boot.mjs, T1).
		// - Far: it grows with the distance up to ~200ms (whole disc), with the SEEK
		//   status visible, which is what the games poll. This is what cured Sonic's
		//   crash when leaving a video (3 Plays in 2 frames: instantaneous, its
		//   state machine walked a branch impossible on real hardware and clobbered R14).
		// MECHANICAL SEEK = 0 (Sebas's decision, 25-07-2026). In the configuration we
		// emulate -real CD block with a MODE-type ODE in place of the drive- the pickup does not
		// exist: the data comes from flash. ONE step remains, which is not disc time but the
		// PHASE: the CD block still goes through "seeking" and reports BUSY/SEEK status for one tick,
		// which is what the games poll, and it is what cured Sonic's crash when leaving
		// a video (3 Plays in 2 frames; with the phase skipped its state machine
		// walked a branch impossible on real hardware and clobbered R14).
		cd.seekRemaining = 1;
		cd.pos.status = CD_ST_BUSY;
		cd.pos.repcount = 0;
		cd.phase = "seeking";
	}

	// Starts a scan: fast forward (mode 0) or rewind (mode 1). Ported from StartScan
	// (Mednafen cdb.c). It does NOT touch the playback range in progress: the scan runs inside
	// the range that was already there, and the end of range still cuts it the same way.
	//ok, 17-07-2026
	_cdInitScan(mode)
	{
		const cd = this.cd;
		cd.scanMode = mode;
		cd.scanCount = 0;
		cd.pos.status = CD_ST_BUSY;
		cd.playRepeat = 0;
		// If the drive was not already playing, it first has to reach the sector
		// (over there: if(DrivePhase != DRIVEPHASE_PLAY) DrivePhase = DRIVEPHASE_SEEK_START2).
		if(cd.phase !== "playing") cd.phase = "seeking";
	}

	// Did the pickup reach the end of the requested range? (Mednafen's CheckEndMet).
	_cdEndReached()
	{
		const cd = this.cd, t = cd.toc, p = cd.pos;
		let end = (p.tno === 0xAA);   // the lead-out is always an end

		if(cd.playEnd !== 0)
		{
			if(cd.playEnd & 0x800000) end = end || (p.fad >= (cd.playEnd & 0x7FFFFF));
			else
			{
				const trackEnd  = Math.min(t.last, Math.max(t.first, (cd.playEnd >> 8) & 0xFF));
				const endIndex = Math.min(99, Math.max(1, cd.playEnd & 0xFF));
				end = end || (p.tno > trackEnd) || (p.tno === trackEnd && p.idx > endIndex);
			}
		}
		// If the pickup went before the start of the range, that is an end too.
		if(cd.playStart & 0x800000) end = end || (p.fad < (cd.playStart & 0x7FFFFF));
		return end;
	}

	// The drive was paused for lack of buffers: if some were freed, it keeps reading
	// (Mednafen's CheckBufPauseResume). Called by the commands that free buffers.
	_cdVerifyResume()
	{
		const cd = this.cd;
		if(cd.phase !== "paused") return;
		if(!this._cdEndReached() && cd.free.length > 0)
		{
			cd.pos.status = CD_ST_BUSY;
			cd.phase = "playing";
		}
	}

	// ------------------------- the drive -----------------------

	// Advances the CD drive. The emulation loop calls it once per frame with
	// the number of sectors that fit in that time (150 sectors/second).
	//ok, 16-07-2026
	// Sector delivery. It can be called MANY times per frame (once per interleave
	// chunk, so the sectors land spread out as on real HW: one every
	// ~6.67ms and not 2-3 together at the edge of the frame); the fractional accumulator absorbs
	// any split. The periodic block goes separately, in cdPeriodic(), ONCE per
	// frame: running it per chunk sped it up ~30x and broke the boot (periodic report
	// overwriting responses before the game reads them).
	cdTick(sectors)
	{
		if(!this.cdReader || !this.cd) return;
		const cd = this.cd;
		// (The drive spin-up after inserting a disc is handled by _cdDriveStep, which is the
		// drive's state machine: see the "starting" phase.)
		// The pending command is resolved HERE, once its time has passed. It goes before moving the
		// drive: on real hardware the firmware answers the command and then keeps reading.
		if(this.cdCmdPending >= 0)
		{
			this.cdCmdPending -= sectors;
			if(this.cdCmdPending < 0) this._cdResolveCommand();
		}
		cd.accum += sectors;
		if(cd.accum > 400) cd.accum = 400;   // ceiling in case the loop falls behind (turbo, tab in the background)
		// Each drive step "costs" its duration in DATA sectors, which is the
		// unit in which the emulation loop passes us the time (150 per second).
		let cost;
		while(cd.accum >= (cost = this._cdCostSector()))
		{
			cd.accum -= cost;
			this._cdDriveStep();
			// The filesystem machine consumes the sectors the drive leaves behind.
			// When it finishes it signals with EFLS, which is what the BIOS waits for to continue.
			if(this._cdFlsStep()) this._cdIrq(CD_HIRQ_EFLS);
		}
	}

	// PERIODIC block of the CD block, at 60 Hz (once per frame, separate from cdTick
	// so the per-chunk sector split does not speed it up).
	cdPeriodic()
	{
		if(!this.cdReader || !this.cd) return;
		const cd = this.cd;
		// (it was the final block of cdTick; same content, same 60 Hz cadence)
		// The hardware refreshes the Q subchannel and, if the game already read the previous
		// response, leaves a periodic position report in CR1-CR4.
		//
		// That this comes out at ~60 Hz (once per frame) and not at 150 Hz is NOT a bug,
		// even though the Q subchannel is "part of every sector": in Mednafen the report, the
		// subQ refresh and SCDQ are ONE SINGLE block hanging off its own
		// timer (PeriodicIdleCounter), independent of the sector loop, with a
		// fixed reload of 187065 clocks on a 44100*256 Hz clock = 60.351 Hz.
		// That is: Mednafen does it at a flat 60 Hz, same as us.
		// Yabause does it differently (Cs2SetTiming: 20000 -> 150 Hz playing at 2x,
		// 40000 -> 75 Hz on audio/1x, 50000 -> 60 Hz stopped), so the two sources
		// contradict each other; but Yabause also moves the WHOLE block, not just SCDQ.
		// Splitting SCDQ off the report to send it at 150 Hz would be a third thing that
		// NEITHER of the two does. Measured as well: forcing SCDQ always on does not
		// change anything in the games tested. Reviewed on 16-07-2026: leave it as it is.
		this._cdUpdateSubQ();
		// Until the first command arrives, CR1-CR4 hold the "CDBLOCK" signature and the
		// report must NOT overwrite it: the BIOS polls it for hundreds of frames (its
		// intro) before looking at it, and if we overwrite it it never detects the CD block.
		if(this.cdSignaturePresent) { this._cdIrq(CD_HIRQ_SCDQ); return; }
		if(cd.resultsRead)
		{
			// While authenticating there is no position to report: the block answers all 0xFF.
			if(cd.fls.active && cd.fls.doAuth)
				this._cdWriteCr((CD_ST_PERIODIC << 8) | 0x00FF, 0xFFFF, 0xFFFF, 0xFFFF);
			else
				this._cdMakeReport(false, CD_ST_PERIODIC);
		}
		this._cdIrq(CD_HIRQ_SCDQ);
	}

	// How much time the drive's next step consumes, measured in "data sectors"
	// (the unit in which the loop passes us the time: 150 per second, the Saturn's
	// drive is 2x). An AUDIO sector lasts TWICE as long: it is 2352 bytes = 588 stereo
	// samples at 44100 Hz = 1/75 of a second, which is the rate of an audio CD and does not
	// change with the drive speed. Mednafen cdb.c Drive_Run (DRIVEPHASE_PLAY):
	//     DriveCounter += (44100 * 256) / ((SubQBuf_Safe[0] & 0x40) ? 150 : 75);
	// (bit 6 of the Q subchannel's control/ADR = DATA track).
	// Without this, CD music would play at TWICE the speed and overflow the SCSP's ring
	// buffer. On a pure data disc the cost is always 1 and the drive
	// behaves exactly as it did before this existed.
	//ok, 16-07-2026
	_cdCostSector()
	{
		return (this.cd.pos.ctrlAdr & 0x40) ? 1 : 2;
	}

	// One sector's worth of drive work. HLE version of Mednafen's Drive_Run: no
	// real seek times (the seek is resolved in one step).
	_cdDriveStep()
	{
		const cd = this.cd;

		if(cd.phase === "stopped") { cd.pos.status = CD_ST_STANDBY; return; }

		// STARTING: disc just inserted. The motor has to reach speed, the PLL
		// lock and the TOC be read; until then the block answers BUSY. It is the
		// transition the BIOS waits for before authenticating: without it, it launches
		// Auth Device before reading the TOC, it does not complete, and it retries the whole sequence
		// (measured with diag/dchg-sequence.mjs: 33 + 44 polling GetStatus lost).
		// It goes HERE and not in cdTick because this is the drive's state machine, and having the
		// same transition in two places is how they get lost.
		if(cd.phase === "starting")
		{
			cd.pos.status = CD_ST_BUSY;
			if(--this.cdBootRest > 0) return;
			this.cdBootRest = 0;
			cd.phase = "paused";
			cd.pos.status = CD_ST_PAUSE;
			// Only now has the operation finished: EFLS is what the software takes as
			// "the block can work now".
			this._cdIrq(CD_HIRQ_EFLS);
			return;
		}

		// Tray open (command 0x05): the drive neither spins nor reads. It leaves this state when
		// a disc is mounted again, which is "closing the tray".
		if(cd.phase === "bandeja") { cd.pos.status = CD_ST_OPEN; return; }

		if(cd.phase === "seeking")
		{
			// The seek consumes its steps reporting SEEK before completing (see
			// _cdInitSeek). The last step positions and starts playing.
			if(cd.seekRemaining > 1) { cd.seekRemaining--; cd.pos.status = CD_ST_SEEK; return; }
			cd.seekRemaining = 0;
			this._cdPositionFrom(cd.playStart);
			cd.currentSector = cd.pos.fad;
			// THE PLAY STATUS DOES NOT COME OUT YET. Finishing moving the pickup is not
			// reading: the PLL still has to lock and the right sector has to pass
			// underneath. Mednafen says it explicitly in its ChangeLog: "prevent the CDB
			// emulation from reporting PLAY status until the SECOND sector is read after
			// a seek completes". Until then the drive keeps reporting SEEK, which is what
			// games poll to know whether they can already ask for data.
			cd.sectorsAfterSeek = 0;
			cd.pos.status = CD_ST_SEEK;
			cd.phase = "playing";
			return;
		}

		if(cd.phase === "paused") { cd.pos.status = CD_ST_PAUSE; return; }

		// --- playing ---
		// Was the end of the requested range reached?
		if(this._cdEndReached())
		{
			if(cd.repetitionsDone >= cd.playRepeat)
			{
				cd.pos.status = CD_ST_PAUSE;
				cd.phase = "paused";
				// End-of-playback interrupt (PEND in Play Disc).
				if(cd.playEndIrq) { this._cdIrq(cd.playEndIrq); cd.playEndIrq = 0; }
			}
			else
			{
				if(cd.repetitionsDone < 0xE) cd.repetitionsDone++;
				cd.pos.repcount = cd.repetitionsDone & 0xF;
				this._cdPositionFrom(cd.playStart);
				cd.currentSector = cd.pos.fad;
			}
			return;
		}

		// The first two sectors after a seek are still "start-up": the status
		// switches to PLAY only on the second one (see the seek comment, above).
		if(cd.sectorsAfterSeek < 2)
		{
			cd.sectorsAfterSeek++;
			if(cd.sectorsAfterSeek >= 2) cd.pos.status = CD_ST_PLAY;
		}

		const isData = (cd.pos.ctrlAdr & 0x40) !== 0;

		// With no free buffers the drive pauses until the game frees some. ONLY
		// on DATA tracks: audio does not go through the buffers (it goes straight to the SCSP, see
		// below), so the music has to keep playing even if the game has all
		// 200 buffers taken up with data. Mednafen cdb.c is explicit about the condition:
		//     else if((SubQBuf_Safe[0] & 0x40) && !FreeBufferCount)  -> pause
		// Before, this paused on both and left the music muted with the buffers full.
		if(isData && cd.free.length === 0)
		{
			this._cdIrq(CD_HIRQ_BFUL);
			cd.pos.status = CD_ST_PAUSE;
			cd.phase = "paused";
			return;
		}

		// --- SCAN: fast forward/rewind ---
		// It goes AFTER the end of range and BFUL on purpose: over there both conditions
		// live in the periodic block and do not look at ScanMode, so they cut the scan
		// just as they cut normal playback.
		// During a scan the sector does NOT enter the buffers nor go through the filters, whether it is data
		// or audio: the only thing that comes out is the ATTENUATED audio (the "cue/review" you
		// hear when fast-forwarding on a CD player). That is why there is no CSCT either.
		if(cd.scanMode >= 0)
		{
			if(!isData && this.scspEngine)
			{
				// Mednafen's BufferCDDA<2>: the samples go >> 2, i.e. at 1/4 (-12 dB).
				const src = this.cdReader.readSectorRaw2352(cd.currentSector - 150);
				const dst = cd.scanBuf;
				for(let i = 0; i < CD_SECTOR_SIZE; i += 2)
				{
					// The <<16>>16 is what does the work: the sample is SIGNED 16-bit LE
					// PCM and it has to be extended to 32 bits BEFORE dividing it, otherwise a
					// negative sample is divided as if it were a huge positive one (-256 would give
					// +16320 instead of -64) and the scan audio comes out as noise.
					const m = (((src[i] | (src[i+1] << 8)) << 16) >> 16) >> 2;
					dst[i] = m & 0xFF; dst[i+1] = (m >> 8) & 0xFF;
				}
				this.scspEngine.receiveCdda(dst);
			}
			cd.pos.isCdrom = false;   // during a scan the block does not report "is CD-ROM"
			cd.pos.status = CD_ST_SCAN;
			cd.pos.repcount = cd.repetitionsDone & 0xF;

			// 6 sector "costs" are played (6 data or 3 audio) and only then
			// does the pickup jump. It is the same weight _cdCostSector() already uses -over there
			// too: ScanCounter += (SubQBuf_Safe[0] & 0x40) ? 1 : 2-, which is what
			// makes the scan advance at the same speed on data and on audio.
			cd.scanCount += this._cdCostSector();
			if(cd.scanCount >= 6)
			{
				cd.scanCount = 0;
				// The jump GROWS with the radius: the CD is constant linear velocity, so
				// one turn of the disc is more sectors at the edge than at the center.
				// The constants are the ones Mednafen measured; the "+2^31 >>32" over there is a
				// rounding in 32.32 fixed point, here Math.floor over the same computation (the values
				// fit comfortably in a double's exact integer range).
				if(cd.scanMode === 0)
					cd.currentSector += 102 + Math.floor((1773936 * cd.currentSector + 2147483648) / 4294967296);
				else
					cd.currentSector -= Math.min(cd.currentSector,
						104 + Math.floor((2180000 * cd.currentSector + 2147483648) / 4294967296));
			}
			else cd.currentSector++;
			this._cdPositionFrom(0x800000 | cd.currentSector);
			return;
		}

		// Read the raw sector and hand it to the filter chain. The hardware
		// only delivers data if the disc was authenticated (Auth Device).
		cd.pos.isCdrom = isData;
		if(isData)
		{
			if(cd.authType)
			{
				const b = this._cdBufAlloc();
				cd.data.set(this.cdReader.readSectorRaw2352(cd.currentSector - 150), b * CD_SECTOR_SIZE);
				cd.lastDest = this._cdFilterBuffer(cd.driveConn, b);
			}
			this._cdIrq(CD_HIRQ_CSCT);
			if(cd.free.length === 0) this._cdIrq(CD_HIRQ_BFUL);
		}
		else
		{
			// CDDA: the sector of an audio track is 2352 bytes of 16-bit stereo
			// little-endian PCM that go STRAIGHT to the SCSP through the external digital
			// input (EXTS0/EXTS1). It does not go through the CD block's buffers or filters:
			// it is a separate audio path, from CD playback into the SCSP. Mednafen does the same,
			// cdb.c DRIVEPHASE_PLAY:
			//     else if(!(SubQBuf_Safe[0] & 0x40)) { BufferCDDA(0, SecPreBuf); ... }
			// This was the LAST missing link: the whole rest of the path (the ring
			// buffer cddaBuf, _readCdda, dspExts and the EFSDL/EFPAN mix through slots
			// 16/17) was already written in scsp.js and NOBODY ran it, because nobody
			// ever called receiveCdda() -> cddaRemaining was always 0 and no game
			// had CD music.
			// The pace is set by _cdCostSector(): 75 sectors/s * 2352 B = 176400 B/s,
			// which is exactly what _readCdda() consumes at 44100 Hz stereo.
			if(this.scspEngine)
				this.scspEngine.receiveCdda(this.cdReader.readSectorRaw2352(cd.currentSector - 150));
		}

		cd.pos.status = CD_ST_PLAY;
		cd.pos.repcount = cd.repetitionsDone & 0xF;
		cd.currentSector++;
		this._cdPositionFrom(0x800000 | cd.currentSector);
	}

	// Refreshes the Q subchannel buffer with the current position.
	_cdUpdateSubQ()
	{
		const p = this.cd.pos, q = this.cd.subQ;
		q[0] = p.ctrlAdr; q[1] = p.tno; q[2] = p.idx;
		q[3] = (p.relFad >>> 16) & 0xFF; q[4] = (p.relFad >>> 8) & 0xFF; q[5] = p.relFad & 0xFF;
		q[6] = 0;
		q[7] = (p.fad >>> 16) & 0xFF; q[8] = (p.fad >>> 8) & 0xFF; q[9] = p.fad & 0xFF;
	}

	// ----------------------- CD block filesystem -------------------
	// Ported from Mednafen's FLS_Run (cdb.cpp). Over there it is a coroutine made with
	// macros (__COUNTER__ + goto); here it is a JS generator, which does the same
	// without tricks: each `yield` is an "I need one more sector, keep calling me".
	// The real CD block parses the ISO9660 on its own, reading the disc with its
	// own filters/partitions, and that is why all of this is asynchronous.

	// --- helpers for the file info table (12 big-endian bytes per entry) ---

	_cdFiFad(table, off)
	{
		return ((table[off] << 24) | (table[off+1] << 16) | (table[off+2] << 8) | table[off+3]) >>> 0;
	}

	_cdFiSize(table, off)
	{
		return ((table[off+4] << 24) | (table[off+5] << 16) | (table[off+6] << 8) | table[off+7]) >>> 0;
	}

	// Translates a raw ISO9660 "directory record" into a CD block file info
	// entry (Mednafen's ReadRecord). The both-endian fields of ISO9660 are taken from
	// the BIG-endian side (+6 and +14), which is the one the CD block uses. The FAD is stored already
	// converted (LBA + 150). If the record carries an XA system area, the extra
	// attributes and the file number are taken from there.
	_cdReadRecord(table, off, rec)
	{
		const be32 = (b, o) => ((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0;
		const recLen = rec[0], idLen = rec[32];

		const fad = (be32(rec, 6) + 150) >>> 0;   // extent LBA -> FAD
		const size = be32(rec, 14);                // size in bytes

		table[off]   = (fad >>> 24) & 0xFF; table[off+1] = (fad >>> 16) & 0xFF;
		table[off+2] = (fad >>> 8) & 0xFF;  table[off+3] = fad & 0xFF;
		table[off+4] = (size >>> 24) & 0xFF; table[off+5] = (size >>> 16) & 0xFF;
		table[off+6] = (size >>> 8) & 0xFF;  table[off+7] = size & 0xFF;

		let attr = rec[25] & CD_FATTR_DIR;   // bit1 of the record's flags = directory
		let fnum = 0;
		table[off+8] = rec[26];              // interleave unit (file unit size)
		table[off+9] = rec[27];              // gap size

		// XA system area of the record: "XA" as the signature at +6/+7.
		const suOff = 33 + (idLen | 1);      // the identifier is padded to even
		const suLen = recLen - suOff;
		if(suLen >= 14 && (suOff + suLen) <= 256 &&
		   rec[suOff+6] === 0x58 && rec[suOff+7] === 0x41)   // 'X','A'
		{
			attr |= rec[suOff+4] & 0xF8;
			fnum = rec[suOff+8];
		}
		table[off+10] = fnum;
		table[off+11] = attr;
	}

	// Leaves filter `fnum` as the drive's only output, with the requested condition.
	_cdFlsBuildFilter(fnum, fad, range, mode, file)
	{
		const f = this.cd.filters[fnum];
		this._cdSetConnectionDrive(fnum);
		f.connTrue = fnum;
		f.connFalse = 0xFF;
		f.fad = fad >>> 0; f.range = range >>> 0;
		f.mode = mode; f.file = file & 0xFF;
		f.channel = 0; f.submode = 0; f.submodeMask = 0; f.cinfo = 0; f.cinfoMask = 0;
	}

	// Waits for a sector to land in the filesystem partition and copies it to pbuf
	// (FLS_WAIT_GRAB_BUF). Yields control while there is nothing.
	*_cdFlsTakeBuf()
	{
		const cd = this.cd, fls = cd.fls;
		while(cd.part[fls.pnum].length === 0) yield;
		const b = cd.part[fls.pnum].shift();
		const base = b * CD_SECTOR_SIZE;
		// User data: +24 in mode2 sectors (they have a subheader), +16 in mode1 ones.
		const start = base + ((cd.data[base + 15] === 0x02) ? 24 : 16);
		fls.pbuf.set(cd.data.subarray(start, start + 2048));
		this._cdBufFree(b);
		this._cdVerifyResume();
	}

	// Reads `count` bytes of the current file/directory into `dest` (FLS_READ),
	// asking for new sectors as the current sector runs out.
	*_cdFlsRead(dest, off, mask, count)
	{
		const fls = this.cd.fls;
		for(let i = 0; i < count; i++)
		{
			if(fls.pbufOffs === 0) yield* this._cdFlsTakeBuf();
			if(dest) dest[(off + i) & mask] = fls.pbuf[fls.pbufOffs];
			fls.pbufOffs = (fls.pbufOffs + 1) % 2048;
			fls.totalCount++;
		}
	}

	// The filesystem operation itself: disc authentication, or locating the PVD
	// and walking a directory filling the file info table.
	*_cdFlsCoroutine()
	{
		const cd = this.cd, fls = cd.fls;

		if(fls.doAuth)
		{
			// --- Auth Device: read the first sector and look for the Saturn magic ---
			this._cdFlsBuildFilter(fls.pnum, 0, 0, 0, 0);
			// 0xFF marks "authenticating": the drive delivers sectors (the gate in
			// _cdDriveStep looks at authType) but no real value is ready yet.
			cd.authType = 0xFF;
			this._cdInitSeek(0x800000 | 0x96, 0, 0, 0, false);   // FAD 0x96 = 150 = LBA 0

			yield* this._cdFlsTakeBuf();
			cd.authType = 0x00;

			const magic = "SEGA SEGASATURN ";
			let ok = true;
			for(let i = 0; i < magic.length; i++)
				if(fls.pbuf[i] !== magic.charCodeAt(i)) { ok = false; break; }
			cd.authType = ok ? 0x04 : 0x02;   // 4 = valid Saturn disc, 2 = non-Saturn data

			this._cdSetConnectionDrive(0xFF);
			this._cdInitSeek(0x800000 | 0x96, 0x800000, 0, 0, false);
		}
		else
		{
			// --- Locate the root directory (only once per disc) ---
			this._cdSetConnectionDrive(fls.pnum);
			cd.filters[fls.pnum].connTrue = fls.pnum;
			cd.filters[fls.pnum].connFalse = 0xFF;

			if(!cd.rootDirValid)
			{
				this._cdFlsBuildFilter(fls.pnum, 0, 0, 0, 0);
				// FAD 0xA6 = 166 = LBA 16: start of the volume descriptors.
				this._cdInitSeek(0x800000 | 0xA6, 0, 0, 0, false);
				for(;;)
				{
					yield* this._cdFlsTakeBuf();
					// It stops on leaving the descriptors ("CD001") or at the terminator.
					const isCd001 = (fls.pbuf[1] === 0x43 && fls.pbuf[2] === 0x44 &&
					                 fls.pbuf[3] === 0x30 && fls.pbuf[4] === 0x30 && fls.pbuf[5] === 0x31);
					if(!isCd001 || fls.pbuf[0] === 0xFF) break;
					if(fls.pbuf[0] === 0x01)   // PVD: carries the root's record at +156
					{
						this._cdReadRecord(cd.rootDir, 0, fls.pbuf.subarray(156));
						cd.rootDirValid = true;
						break;
					}
				}
			}

			if(cd.rootDirValid)
			{
				// --- Walk the requested directory and fill the file info table ---
				// fiaoffs >= 256 means "the root directory"; otherwise it is the table
				// entry left by the previous Read Dir.
				const fromRoot = (fls.fiaoffs >= 256);
				const table = fromRoot ? cd.rootDir : cd.fileInfo;
				const tOff  = fromRoot ? 0 : (fls.fiaoffs * CD_FI_SIZE);
				const fad   = this._cdFiFad(table, tOff);
				const size   = this._cdFiSize(table, tOff);

				this._cdClearPartition(fls.pnum);
				this._cdFlsBuildFilter(fls.pnum, fad, (size + 2047) >>> 11,
					CD_FMODE_FADR, table[tOff + 10]);
				fls.totalMax = size;
				this._cdInitSeek(0x800000 | fad, 0, 0, 0, false);

				fls.totalCount = 0;
				fls.pbufOffs = 0;
				fls.recordCount = 0;
				cd.fileInfoValid = false;

				while(fls.totalCount < fls.totalMax)
				{
					fls.record.fill(0);
					// First byte = record length. 0 = padding up to the next sector.
					yield* this._cdFlsRead(fls.record, 0, 0xFF, 1);
					if(!fls.record[0]) continue;
					yield* this._cdFlsRead(fls.record, 1, 0xFF, fls.record[0] - 1);

					if(fls.recordCount < 2)
					{
						// The first two entries of every ISO9660 directory are "." and "..".
						this._cdReadRecord(cd.fileInfo, (fls.recordCount & 0xFF) * CD_FI_SIZE, fls.record);
					}
					else if(fls.recordCount >= fls.fioffs)
					{
						if(fls.recordCount === fls.fioffs)
						{
							cd.fileInfoOffs = fls.recordCount;
							cd.fileInfoCount = 0;
							cd.fileInfoMore = false;
						}
						else if(cd.fileInfoCount === 0xFE)
						{
							// The table is full: the game has to ask for the next batch.
							cd.fileInfoMore = true;
							break;
						}
						this._cdReadRecord(cd.fileInfo, ((2 + cd.fileInfoCount) & 0xFF) * CD_FI_SIZE, fls.record);
						cd.fileInfoCount++;
					}
					fls.recordCount++;
				}

				// A directory with only "." and ".." has no window to report.
				if(fls.recordCount <= 2)
				{
					cd.fileInfoOffs = 0;
					cd.fileInfoCount = 0;
					cd.fileInfoMore = false;
				}
				cd.fileInfoValid = true;
			}
		}

		this._cdClearPartition(fls.pnum);
	}

	// One step of the filesystem machine. Returns true when the operation
	// finished (or was aborted): the caller fires EFLS.
	_cdFlsStep()
	{
		const cd = this.cd, fls = cd.fls;
		if(!fls.active && !fls.abort) return false;

		if(!fls.abort)
		{
			if(!fls.gen) fls.gen = this._cdFlsCoroutine();
			if(!fls.gen.next().done) return false;   // continues: waits for more sectors
		}
		// Finished or aborted: release the state and leave the drive still.
		this._cdFlsReset();
		cd.playEndIrq = 0;
		cd.playEnd = 0x800000;
		cd.playRepeat = 0;
		return true;
	}

	// ------------------ data transfer to the host -----------------

	// Prepares the word counter for the buffer being transferred,
	// according to the configured sector length (Mednafen's DT_SetIBOffsCount).
	// The offsets/counters are in 16-bit WORDS.
	_cdDtConfigureBuf(b)
	{
		const cd = this.cd, dt = cd.dt, d = cd.data, base = b * CD_SECTOR_SIZE;
		if(cd.getSecLen === 1)      { dt.offWord = 8;  dt.remaining = 1168; }   // 2336
		else if(cd.getSecLen === 2) { dt.offWord = 6;  dt.remaining = 1170; }   // 2340
		else if(cd.getSecLen === 3) { dt.offWord = 0;  dt.remaining = 1176; }   // 2352
		else                                                                       // 2048
		{
			if(d[base + 15] === 0x01) { dt.offWord = 8; dt.remaining = 1024; }  // mode1
			else if(d[base + 16 + 2] & 0x20) { dt.offWord = 12; dt.remaining = 1162; }  // mode2 form2
			else { dt.offWord = 12; dt.remaining = 1024; }                      // mode2 form1
		}
	}

	// Reads the next 16-bit word of the transfer in progress. It is what
	// the CD block's data register (DTR) returns.
	_cdDtReadWord()
	{
		const cd = this.cd, dt = cd.dt;
		if(!dt.active || dt.writing || dt.remaining <= 0) return 0;

		const b = dt.list[dt.currentIdx];
		let source, off;
		// Codes >= 0xF0 are "virtual buffers" of the CD block.
		if(b === 0xFF)               { source = cd.tocBuf;   off = dt.offWord * 2; }
		else if(b === 0xFE)          { source = cd.subQ;     off = dt.offWord * 2; }
		else if(b === 0xFD)          { source = cd.subRW;    off = dt.offWord * 2; }
		else if(b === CD_FI_BUFVIRT) { source = cd.fileInfo; off = dt.offWord * 2; }
		else                         { source = cd.data;    off = b * CD_SECTOR_SIZE + dt.offWord * 2; }
		const val = ((source[off] << 8) | source[off + 1]) & 0xFFFF;

		dt.offWord++; dt.remaining--; dt.total++;
		// This buffer is done: move on to the next one in the list.
		if(dt.remaining === 0)
		{
			dt.currentIdx++;
			if(dt.currentIdx < dt.list.length) this._cdDtConfigureBuf(dt.list[dt.currentIdx]);
		}
		return val;
	}

	// CD block data register (DTR): each read takes out the next word
	// of the transfer in progress. In 32 bits two words come out, the high one first.
	_cdReadDtr(size)
	{
		const high = this._cdDtReadWord();
		if(size < 4) return high;
		const low = this._cdDtReadWord();
		return (((high << 16) | low) >>> 0);
	}

	// Write to the data register (Put Sector Data). Mirror of _cdReadDtr: a long
	// is two words, the high one first (big-endian).
	_cdWriteDtr(value, size)
	{
		if(size < 4) { this._cdDtWriteWord(value & 0xFFFF); return; }
		this._cdDtWriteWord((value >>> 16) & 0xFFFF);
		this._cdDtWriteWord(value & 0xFFFF);
	}

	// Starts a transfer to the host from a list of buffers. `offWord` lets
	// the read start in the middle of the buffer (used by Get File Info, which delivers a
	// single entry of the table).
	_cdDtInit(list, words, freeAtEnd, offWord = 0)
	{
		const dt = this.cd.dt;
		dt.active = true; dt.writing = false;
		dt.list = list; dt.currentIdx = 0;
		dt.offWord = offWord; dt.total = 0;
		dt.freeAtEnd = !!freeAtEnd;
		// Virtual buffers carry the given length; sector ones compute it.
		if(words >= 0) dt.remaining = words;
		else this._cdDtConfigureBuf(list[0]);
	}

	// Starts a transfer FROM THE HOST TO the CD block (Put Sector Data): the game
	// keeps writing words through the DTR and we put them into `list`. The buffers
	// are not filtered until End Data Transfer, which is when they go through `fnum`.
	//ok, 16-07-2026
	_cdDtInitWrite(list, fnum)
	{
		const dt = this.cd.dt;
		dt.active = true; dt.writing = true;
		dt.list = list; dt.currentIdx = 0;
		dt.total = 0; dt.freeAtEnd = false;
		dt.fnum = fnum & 0xFF;
		this._cdDtConfigureBufWrite();
	}

	// Offset and length of the buffer being WRITTEN. Unlike the read
	// side (_cdDtConfigureBuf), it does not sniff the sector mode -there is no sector
	// yet, the host is writing it-: it comes straight from putSecLen.
	// Mednafen cdb.c DT_SetIBOffsCount, branch if(DT.Writing):
	//     static const unsigned DTW_OffsTab[4]  = { 12, 8, 6, 0 };
	//     static const unsigned DTW_CountTab[4] = { 1024, 1168, 1170, 1176 };
	//ok, 16-07-2026
	_cdDtConfigureBufWrite()
	{
		const dt = this.cd.dt, n = this.cd.putSecLen & 3;
		dt.offWord = [12, 8, 6, 0][n];
		dt.remaining  = [1024, 1168, 1170, 1176][n];
	}

	// Writes the next 16-bit word of a Put Sector Data in progress. It is the
	// mirror of _cdDtReadWord: called by the write to the data register (DTR).
	//ok, 16-07-2026
	_cdDtWriteWord(val)
	{
		const cd = this.cd, dt = cd.dt;
		if(!dt.active || !dt.writing || dt.remaining <= 0) return;

		const off = dt.list[dt.currentIdx] * CD_SECTOR_SIZE + dt.offWord * 2;
		cd.data[off]     = (val >> 8) & 0xFF;
		cd.data[off + 1] = val & 0xFF;

		dt.offWord++; dt.remaining--; dt.total++;
		// This buffer is full: move on to the next one in the list.
		if(dt.remaining === 0 && ++dt.currentIdx < dt.list.length)
			this._cdDtConfigureBufWrite();
	}

	// -------------------------- the commands ---------------------------

	// Runs the command left in CR1-CR4 (with a disc mounted).
	// Ported from the CDB_Update dispatch in Mednafen cdb.cpp.
	// The ones that were missing -Scan (0x12), Get Sector Info (0x54) and the search by FAD
	// (0x55/0x56)- were implemented on 17-07-2026. None of them is requested by any of the games
	// tested (Sega Rally, X-Men CotA, Virtua Cop, Sonic 3D): they are there for completeness, and
	// the mmioUnknown radar is still what warns if a new one shows up.
	//? Of the CD block's set only 0x05 (Open Tray) is left out, and on purpose: there is
	//? nowhere to learn what it does: Yabause does not even dispatch it and Mednafen has it with an
	//? EMPTY body, commented out on top of that. It still falls into the default, which answers the status and does not
	//? hang; inventing a behavior for the tray would be worse than not having it.
	//ok, 17-07-2026
	_cdExecute()
	{
		const cd = this.cd;
		// CD[0]=CR1, CD[1]=CR2, CD[2]=CR3, CD[3]=CR4.
		const cr = [ this._readRegBE(this.cdRegs, 0x18, 2), this._readRegBE(this.cdRegs, 0x1C, 2),
		             this._readRegBE(this.cdRegs, 0x20, 2), this._readRegBE(this.cdRegs, 0x24, 2) ];
		const cmd = (cr[0] >> 8) & 0xFF;
		// Many commands carry the filter/partition number in the high byte of CR3.
		const pnum = (cr[2] >> 8) & 0xFF;
		const fls = cd.fls;

		// While the CD block is authenticating the disc it does NOT serve anything: it answers
		// everything with 0xFFFF (and the usual CMOK). Faithful to Mednafen's cdb.cpp.
		if(fls.active && fls.doAuth)
		{
			this._cdResp(0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF);
			return;
		}

		// File id / offset of the filesystem commands (0x70-0x74).
		const fileId  = (((cr[2] & 0xFF) << 16) | cr[3]) >>> 0;
		// Index inside the file info table: ids 0 and 1 are "." and ".."; from 2
		// onwards the base of the window reported by the last Read Dir has to be subtracted.
		const fiaOffs = (fileId < 2) ? fileId : ((2 + fileId - cd.fileInfoOffs) & 0xFF);
		// Does the file id fall outside the table's window?
		const outsideOfWindow = (fileId >= 2 &&
			(fileId < cd.fileInfoOffs || fileId >= (cd.fileInfoOffs + cd.fileInfoCount)));

		switch(cmd)
		{
			case 0x00:   // Get CD Status
				this._cdRespStatus(false, 0);
				break;

			case 0x01:   // Get Hardware Info: CD block version + MPEG card
				// The 4 fields CDC_GetHwInfo returns, one per byte:
				//   CR2 high = hardware flag (0x02)   CR2 low = version (0x01)
				//   CR3 high = authentication of the MPEG CARD   CR3 low = 0
				//   CR4      = drive revision (0x0400)
				// CR3 = 0 is what tells the game THAT THERE IS NO authenticated MPEG CARD,
				// and it is consistent with us rejecting commands 0x90-0xAF further down.
				// (The 0x0201 of CR2 is NOT "there is MPEG", as this comment used to say:
				// they are the CD block's flag and version.) Values from Yabause's
				// Cs2GetHardwareInfo; the BIOS really demands them: with others the disc does not boot.
				this._cdResp(this._cdStatusBase(false, 0) << 8, 0x0201, 0x0000, 0x0400);
				break;

			case 0x02:   // Get TOC: delivers the 408 bytes of the TOC through the DTR
				if(cd.dt.active) { this._cdRespStatus(false, CD_ST_WAIT); break; }
				this._cdResp(this._cdStatusBase(false, CD_ST_DTREQ) << 8, 0xCC, 0, 0);
				this._cdDtInit([0xFF], 0xCC, false);
				this._cdIrq(CD_HIRQ_DRDY);
				break;

			case 0x03:   // Get Session Info
			{
				const session = cr[0] & 0xFF;
				let fad, rsw;
				if(session === 0)      { fad = 150 + cd.toc.tracks[100].lba; rsw = 0x01; }  // whole disc
				else if(session === 1) { fad = 0; rsw = session; }
				else                  { fad = 0xFFFFFF; rsw = 0xFF; }                      // does not exist
				this._cdResp(this._cdStatusBase(false, 0) << 8, 0,
					(rsw << 8) | ((fad >>> 16) & 0xFF), fad & 0xFFFF);
				break;
			}

			case 0x04:   // Initialize CD System
				cd.playEndIrq = 0;
				cd.playEnd = 0x800000;
				cd.playRepeat = 0;
				cd.pos.status = CD_ST_BUSY;
				cd.phase = "paused";
				this._cdRespStatus(false, 0);
				if(cr[0] & 0x01)   // bit0 = CD block software reset
				{
					this._cdSoftReset();
					this._cdIrq(CD_HIRQ_MPED | CD_HIRQ_EFLS | CD_HIRQ_ECPY |
					            CD_HIRQ_EHST | CD_HIRQ_ESEL | CD_HIRQ_CMOK);
				}
				break;

			case 0x05:   // Open Tray: opens the tray
				// It is a base CD block command (not an MPEG one) and until today it fell into the
				// default, which answers "ready" without opening anything. Opening the tray stops the
				// motor, invalidates the position and DROPS the disc's AUTHENTICATION: when it is
				// closed it has to authenticate again. The notice to the host is DCHG (disc
				// change), which is what multi-disc games poll to know that the
				// user opened the lid.
				//
				// The tray stays open until a disc is mounted: mountDisc() is
				// literally "closing the tray" and already signals DCHG on its own.
				cd.phase = "bandeja";
				cd.pos.status = CD_ST_OPEN;
				cd.authType = 0x00;
				cd.playEndIrq = 0;
				cd.playRepeat = 0;
				cd.scanMode = -1;
				this._cdRespStatus(false, 0);
				this._cdIrq(CD_HIRQ_DCHG | CD_HIRQ_EFLS);
				break;

			case 0x06:   // End Data Transfer: closes the transfer in progress
			{
				const dt = cd.dt;
				if(!dt.active)
				{
					// With no active transfer the hardware returns -1.
					this._cdResp((this._cdStatusBase(false, 0) << 8) | 0xFF, 0xFFFF, 0, 0);
					break;
				}
				dt.active = false;
				// Returns how many WORDS were transferred.
				this._cdResp((this._cdStatusBase(false, 0) << 8) | ((dt.total >>> 16) & 0xFF),
					dt.total & 0xFFFF, 0, 0);
				if(dt.writing)
				{
					// Closing a Put Sector Data: ONLY NOW do the buffers the host filled
					// go through the filter and land in their partition.
					// Mednafen cdb.c COMMAND_END_DATAXFER, branch if(DT.Writing).
					this._cdDisconnectInput(dt.fnum);
					for(const b of dt.list) this._cdFilterBuffer(dt.fnum, b);
					if(cd.free.length === 0) this._cdIrq(CD_HIRQ_BFUL);
					this._cdIrq(CD_HIRQ_EHST);
					this._cdVerifyResume();
					break;
				}
				if(dt.freeAtEnd) for(const b of dt.list) this._cdBufFree(b);
				// EHST only after moving data out of a partition (not from the TOC/subchannel).
				if(dt.list.length > 0 && dt.list[0] < CD_BUFFERS) this._cdIrq(CD_HIRQ_EHST);
				this._cdVerifyResume();
				break;
			}

			case 0x10:   // Play Disc
			{
				let start = ((cr[0] & 0xFF) << 16) | cr[1];
				let end    = ((cr[2] & 0xFF) << 16) | cr[3];
				const mode = (cr[2] >> 8) & 0xFF;

				if(start === 0xFFFFFF) start = cd.playCmdStart;   // "the one from last time"
				if(end === 0xFFFFFF) end = cd.playCmdEnd;
				// With start and end in FAD mode, the "end" is actually a NUMBER
				// of sectors to read from the start.
				else if((start & 0x800000) && (end & 0x800000))
					end = 0x800000 | ((start + end) & 0x7FFFFF);

				// Start and end have to be in the same mode (FAD or track/index).
				if(((start ^ end) & 0x800000) && end !== 0) { this._cdRespStatus(true, 0); break; }

				cd.playCmdStart = start;
				cd.playCmdEnd = end;
				if(!(mode & 0x70)) cd.playCmdRep = mode & 0x0F;   // number of repetitions
				cd.pos.status = CD_ST_BUSY;
				this._cdRespStatus(false, 0);
				this._cdInitSeek(start, end, cd.playCmdRep, CD_HIRQ_PENDING, !!(mode & 0x80));
				break;
			}

			case 0x11:   // Seek Disc
			{
				cd.pos.status = CD_ST_BUSY;
				this._cdRespStatus(false, 0);
				const dest = ((cr[0] & 0xFF) << 16) | cr[1];
				if(dest === 0)   // 0 = stop the motor
				{
					const p = cd.pos;
					p.isCdrom = true; p.repcount = 0x7F; p.status = CD_ST_BUSY;
					p.fad = 0xFFFFFF; p.relFad = 0xFFFFFF;
					p.ctrlAdr = 0xFF; p.idx = 0xFF; p.tno = 0xFF;
					cd.phase = "stopped";
				}
				else if(dest === 0xFFFFFF)   // pause on the current sector
				{
					cd.playEndIrq = 0; cd.playEnd = 0x800000; cd.playRepeat = 0;
					cd.phase = "paused";
				}
				else this._cdInitSeek(dest, 0x800000, 0, 0, false);
				break;
			}

			case 0x12:   // Scan: fast forward (0) / rewind (1)
			{
				// It is the CD player's fast forward / rewind: the pickup plays a
				// little bit, jumps, plays another little bit... The real work is done by
				// _cdDriveStep(); here it is only started.
				// SECONDARY REFERENCE (the CD block has no public manual): ported from
				// Mednafen cdb.c COMMAND_SCAN + StartScan. Yabause is NO use as a source here:
				// its Cs2ScanDisc() sets the status to SCAN, says "// finish me" and does nothing
				// else, i.e. it leaves the drive playing normally but LYING that
				// it is scanning.
				const addr = cr[0] & 0xFF;
				if(addr >= 0x02) { this._cdRespStatus(true, 0); break; }
				cd.pos.status = CD_ST_BUSY;
				this._cdRespStatus(false, 0);
				this._cdInitScan(addr);
				break;
			}

			case 0x20:   // Get Subcode: delivers the Q or R-W subchannel through the DTR
			{
				if(cd.dt.active) { this._cdRespStatus(false, CD_ST_WAIT); break; }
				const type = cr[0] & 0xFF;
				if(type >= 0x02) { this._cdRespStatus(true, 0); break; }
				if(type === 0)   // Q subchannel: 5 words
				{
					this._cdResp(this._cdStatusBase(false, CD_ST_DTREQ) << 8, 0x05, 0, 0);
					this._cdDtInit([0xFE], 0x05, false);
				}
				else             // R-W subchannel: 12 words (not decoded yet)
				{
					this._cdResp(this._cdStatusBase(false, CD_ST_DTREQ) << 8, 0x0C, 0, 0);
					cd.subRW.fill(0xFF);
					this._cdDtInit([0xFD], 0x0C, false);
				}
				this._cdIrq(CD_HIRQ_DRDY);
				break;
			}

			case 0x30:   // Set CD Device Connection: which filter the drive feeds into
				if(pnum >= CD_PARTITIONS && pnum !== 0xFF) { this._cdRespStatus(true, 0); break; }
				this._cdSetConnectionDrive(pnum);
				this._cdRespStatus(false, 0);
				this._cdIrq(CD_HIRQ_ESEL);
				break;

			case 0x31:   // Get CD Device Connection
				this._cdResp(this._cdStatusBase(false, 0) << 8, 0, cd.driveConn << 8, 0);
				break;

			case 0x32:   // Get Last Buffer Destination
				this._cdResp(this._cdStatusBase(false, 0) << 8, 0, cd.lastDest << 8, 0);
				break;

			case 0x40:   // Set Filter Range: FAD range the filter accepts
			{
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				const f = cd.filters[pnum];
				f.fad   = (((cr[0] & 0xFF) << 16) | cr[1]) >>> 0;
				f.range = (((cr[2] & 0xFF) << 16) | cr[3]) >>> 0;
				this._cdRespStatus(false, 0);
				this._cdIrq(CD_HIRQ_ESEL);
				break;
			}

			case 0x41:   // Get Filter Range
			{
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				const f = cd.filters[pnum];
				this._cdResp((this._cdStatusBase(false, 0) << 8) | ((f.fad >>> 16) & 0xFF),
					f.fad & 0xFFFF, (pnum << 8) | ((f.range >>> 16) & 0xFF), f.range & 0xFFFF);
				break;
			}

			case 0x42:   // Set Filter Subheader Conditions (mode2 sectors)
			{
				// THE ORDER OF THE FIELDS IS YABAUSE'S, AND IT IS MEASURED AGAINST THE GAMES.
				//
				// The two sources contradict each other: Yabause (cs2.c) puts chan in CR1 bits 7-0
				// and fid in CR3 bits 7-0 —what is below—, while Mednafen (cdb.cpp) puts the
				// FILE IDENTIFIER in CR1 bits 7-0 and shifts everything else by one field. The battery
				// (cd.test.mjs, 179 checks) passes with BOTH, so it does not break the tie.
				//
				// TIE BROKEN BY MEASUREMENT (25-07-2026, diag/vc-cd-sequence.mjs and the
				// scratchpad harness), counting how many sectors the filter accepts in 1400 frames of
				// Virtua Cop boot:
				//     Yabause  -> 1460 accepted, reaches the title (BGON 0x17, 495 VDP1 cmds)
				//     Mednafen ->  273 accepted, does NOT reach the title, and the sound 68k
				//                  dies with "double address/bus-error" because its driver
				//                  arrives corrupted.
				// With Mednafen's order the filter discards FIVE TIMES more data and the
				// game cannot load. Do NOT propose it again without measuring like this again.
				//
				//? BUT CAREFUL, AN UNRESOLVED CONTRADICTION REMAINS, and it is noted in
				//? PENDING: with this order, Virtua Cop hangs AFTER the "PRESS
				//? START BUTTON" waiting for its partition to become empty, and with Mednafen's
				//? that wait would resolve (the sectors would not pass the filter). So
				//? each order fixes one half: there is a third wrong piece that makes one
				//? of the two look correct. See the Virtua Cop pending item.
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				const f = cd.filters[pnum];
				f.channel       = cr[0] & 0xFF;
				f.submodeMask = (cr[1] >> 8) & 0xFF;
				f.cinfoMask   = cr[1] & 0xFF;
				f.file     = cr[2] & 0xFF;
				f.submode     = (cr[3] >> 8) & 0xFF;   // CR4 bits 15-8 = Submode Value
				f.cinfo       = cr[3] & 0xFF;          // CR4 bits 7-0  = Coding Info Value
				this._cdRespStatus(false, 0);
				this._cdIrq(CD_HIRQ_ESEL);
				break;
			}

			case 0x43:   // Get Filter Subheader Conditions
			{
				// The SAME order as the Set above: if the Get returned the fields in
				// a different order, a game that reads back what it wrote would see something else.
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				const f = cd.filters[pnum];
				this._cdResp((this._cdStatusBase(false, 0) << 8) | f.channel,
					(f.submodeMask << 8) | f.cinfoMask, (pnum << 8) | f.file,
					(f.submode << 8) | f.cinfo);
				break;
			}

			case 0x44:   // Set Filter Mode: which conditions the filter applies
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				cd.filters[pnum].mode = cr[0] & 0xFF;
				if(cr[0] & 0x80) this._cdResetCondFilter(pnum);   // bit7 = clear conditions
				this._cdRespStatus(false, 0);
				this._cdIrq(CD_HIRQ_ESEL);
				break;

			case 0x45:   // Get Filter Mode
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				this._cdResp((this._cdStatusBase(false, 0) << 8) | cd.filters[pnum].mode,
					0, pnum << 8, 0);
				break;

			case 0x46:   // Set Filter Connection: true/false outputs of the filter
			{
				const flags = cr[0] & 0xFF;
				const connTrue  = (cr[1] >> 8) & 0xFF;
				const connFalse = cr[1] & 0xFF;
				if(pnum >= CD_PARTITIONS ||
				   ((flags & 0x1) && connTrue  >= CD_PARTITIONS && connTrue  !== 0xFF) ||
				   ((flags & 0x2) && connFalse >= CD_PARTITIONS && connFalse !== 0xFF))
				{
					this._cdRespStatus(true, 0);
					break;
				}
				if(flags & 0x1) cd.filters[pnum].connTrue = connTrue;
				if(flags & 0x2)
				{
					this._cdDisconnectInput(connFalse);
					cd.filters[pnum].connFalse = connFalse;
				}
				this._cdRespStatus(false, 0);
				this._cdIrq(CD_HIRQ_ESEL);
				break;
			}

			case 0x47:   // Get Filter Connection
			{
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				const f = cd.filters[pnum];
				this._cdResp(this._cdStatusBase(false, 0) << 8,
					(f.connTrue << 8) | f.connFalse, pnum << 8, 0);
				break;
			}

			case 0x48:   // Reset Selector: clears partitions / filters
			{
				const flags = cr[0] & 0xFF;
				if(flags === 0)   // no flags: clears ONLY the given partition
				{
					if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
					this._cdClearPartition(pnum);
					this._cdRespStatus(false, 0);
					this._cdIrq(CD_HIRQ_ESEL);
					this._cdVerifyResume();
					break;
				}
				this._cdRespStatus(false, 0);
				for(let i = 0; i < CD_PARTITIONS; i++)
				{
					if(flags & 0x04) this._cdClearPartition(i);            // partition data
					if(flags & 0x10) this._cdResetCondFilter(i);             // filter conditions
					if(flags & 0x20)                                         // filter inputs
					{
						if(i === cd.driveConn) cd.driveConn = 0xFF;
						if(cd.filters[i].connFalse < CD_PARTITIONS) cd.filters[i].connFalse = 0xFF;
					}
					if(flags & 0x40) cd.filters[i].connTrue  = i;            // true outputs
					if(flags & 0x80) cd.filters[i].connFalse = 0xFF;         // false outputs
				}
				this._cdIrq(CD_HIRQ_ESEL);
				this._cdVerifyResume();
				break;
			}

			case 0x50:   // Get Buffer Size: how many free buffers are left
				this._cdResp(this._cdStatusBase(false, 0) << 8, cd.free.length,
					CD_PARTITIONS << 8, CD_BUFFERS);
				break;

			case 0x51:   // Get Sector Number: how many sectors a partition has
				// CAREFUL: only CMOK, NO DRDY. Yabause sends both (Cs2GetSectorNumber:
				// HIRQ |= CDB_HIRQ_CMOK | CDB_HIRQ_DRDY) and it is a SPURIOUS DRDY: this
				// command does not transfer a single byte, it only returns a counter in CR4.
				// Mednafen routes it through BasicResults(), which fires CMOK alone -same as
				// our _cdResp-, and keeps DRDY for the commands that really
				// set up a transfer. Reviewed against both sources on 16-07-2026:
				// do NOT add DRDY to it. There is a test that catches it (cd.test.mjs, "GetSecNum").
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				this._cdResp(this._cdStatusBase(false, 0) << 8, 0, 0, cd.part[pnum].length);
				break;

			case 0x52:   // Calc Actual Size: how many words reading N sectors would take
			{
				// The game asks "how big is what I am about to read?" BEFORE asking for
				// the data, to reserve the destination. The calculation does not transfer anything:
				// it leaves the total stored and signals with ESEL; the game reads it later with
				// Get Actual Size (0x53). Without ESEL the game keeps polling
				// forever (it never sends the Get Sector Data).
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				let offs   = cr[1];
				let numsec = cr[3];
				const total = cd.part[pnum].length;
				if(offs === 0xFFFF) offs = total - 1;         // 0xFFFF = the last sector
				if(numsec === 0xFFFF) numsec = total - offs;  // 0xFFFF = until the end

				// With a write in progress (or parameters out of range) it asks to retry.
				if((cd.dt.active && cd.dt.writing) || numsec <= 0 || offs < 0 ||
				   (offs + numsec) > total)
				{
					this._cdRespStatus(false, CD_ST_WAIT);
					break;
				}
				this._cdRespStatus(false, 0);

				let accum = 0;
				for(let i = 0; i < numsec; i++)
				{
					const base = cd.part[pnum][offs + i] * CD_SECTOR_SIZE;
					if(cd.getSecLen === 1)      accum += 1168;   // 2336
					else if(cd.getSecLen === 2) accum += 1170;   // 2340
					else if(cd.getSecLen === 3) accum += 1176;   // 2352
					else                                        // 2048
					{
						//? Mednafen warns that the hardware is inconsistent with itself
						//? here: Calc Actual Size measures mode2 form1 the same as mode1
						//? (1024), while Get Sector Data treats it differently. We
						//? honor the measurement of the real hardware, not the "logic".
						if(cd.data[base + 15] === 0x02 && (cd.data[base + 16 + 2] & 0x20))
							accum += 1162;   // mode2 form2
						else
							accum += 1024;   // mode1 and mode2 form1
					}
				}
				cd.computedSize = accum >>> 0;
				this._cdIrq(CD_HIRQ_ESEL);
				break;
			}

			case 0x53:   // Get Actual Size: returns what 0x52 computed
				this._cdResp((this._cdStatusBase(false, 0) << 8) | ((cd.computedSize >>> 16) & 0xFF),
					cd.computedSize & 0xFFFF, 0, 0);
				break;

			case 0x54:   // Get Sector Info: the header of a sector that is already stored
			{
				// Returns what the sector's header DECLARES (its FAD) and, if it is mode2, its
				// subheader. The game uses it to know what landed in its partition without
				// having to transfer the whole sector to the host.
				// SECONDARY REFERENCE (the CD block has no public manual): ported from
				// Mednafen cdb.c COMMAND_GET_SECINFO.
				//? Yabause (Cs2GetSectorInfo) disagrees on three things and loses on all three:
				//?  1. it takes the offset as CR2 & 0xFF -> it does not even reach 256 sectors and it
				//?     loses the 0xFFFF = "the last one", which is the convention of ALL the
				//?     other partition commands (0x52, 0x61-0x63, 0x65/0x66).
				//?  2. it reads a block->FAD field it stores separately. The hardware has no such thing:
				//?     of a buffer it only has the 2352 raw bytes, which is where
				//?     Mednafen (and this port) get the FAD from.
				//?  3. it fires CMOK|ESEL. The ESEL is SPURIOUS, same as the DRDY it puts
				//?     on Get Sector Number (see 0x51) and the ESEL it puts on Get Actual
				//?     Size (0x53): this command does not touch the selector, it only reads a header.
				//?     Mednafen sends it through BasicResults() = CMOK alone, and the pattern holds
				//?     -the one that COMPUTES (0x52, 0x55) signals with ESEL; the one that only RETURNS what was
				//?     already computed (0x53, 0x54, 0x56) does not-.
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				const offs = cr[1];
				const total = cd.part[pnum].length;
				// An EMPTY partition rejects even if the offset is 0xFFFF: with no sectors there is no
				// "last" to return (over there it is the standalone Partitions[pnum].Count == 0).
				if(total === 0 || (offs !== 0xFFFF && offs >= total))
				{
					this._cdRespStatus(true, 0);
					break;
				}
				const b = cd.part[pnum][(offs === 0xFFFF) ? (total - 1) : offs];
				const base = b * CD_SECTOR_SIZE;
				const fad = this._cdFadOfSector(b);
				// The subheader fields only exist in mode2 sectors.
				let file = 0, channel = 0, submode = 0, cinfo = 0;
				if(cd.data[base + 15] === 0x02)
				{
					file = cd.data[base + 16]; channel   = cd.data[base + 17];
					submode = cd.data[base + 18]; cinfo   = cd.data[base + 19];
				}
				this._cdResp((this._cdStatusBase(false, 0) << 8) | ((fad >>> 16) & 0xFF),
					fad & 0xFFFF, (file << 8) | channel, (submode << 8) | cinfo);
				break;
			}

			case 0x55:   // Exec FAD Search: searches for a sector by FAD within a partition
			{
				// Searches, from `offs` onwards, for the sector whose FAD is the HIGHEST that does not
				// go past `sfad`. It is 0x52/0x53 again: this one COMPUTES and signals with ESEL,
				// and the game collects the result later with 0x56.
				// SECONDARY REFERENCE (the CD block has no public manual): ported from
				// Mednafen cdb.c COMMAND_EXEC_FADSRCH. Yabause is not a source here: its
				// Cs2ExecFadSearch() is "// finish me" and does not search anything.
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				const offs = cr[1];
				const sfad = (((cr[2] & 0xFF) << 16) | cr[3]) >>> 0;
				const total = cd.part[pnum].length;
				if(total === 0 || (offs !== 0xFFFF && offs >= total))
				{
					this._cdRespStatus(true, 0);
					break;
				}
				const fs = cd.fadSearch;
				fs.spos = 0xFFFF;   // 0xFFFF = nothing was found
				fs.pnum = pnum;
				fs.fad  = 0;
				let had = 0;
				for(let i = (offs === 0xFFFF) ? (total - 1) : offs; i < total; i++)
				{
					const fad = this._cdFadOfSector(cd.part[pnum][i]);
					// The "+ had" is Mednafen's trick (fad >= FADSearch.fad + match_made):
					// with no match yet it asks for fad >= 0 -i.e., it accepts the first one-; once it has
					// one it asks for STRICTLY greater. Result: the highest FAD that does not go past
					// sfad wins, and on a tie the one with the lowest index stays.
					if(fad <= sfad && fad >= (fs.fad + had))
					{
						fs.spos = i; fs.fad = fad; had = 1;
					}
				}
				this._cdRespStatus(false, 0);
				//? Over there the search "costs" 300 cycles (CMD_EAT_CLOCKS(300)) and ESEL comes out
				//? only afterwards. This port is HLE and does not time the commands: ESEL
				//? comes out on the spot, same as in 0x52.
				this._cdIrq(CD_HIRQ_ESEL);
				break;
			}

			case 0x56:   // Get FAD Search Results: collects what 0x55 found
				// It never rejects: it returns whatever was left from the last search
				// (spos = 0xFFFF if nothing was found). Mednafen cdb.c COMMAND_GET_FADSRCH, which
				// sends it through BasicResults() = CMOK alone, without ESEL (see 0x54).
				// Yabause is not a source here: its Cs2GetFadSearchResults() is "// finish me" and
				// fires CMOK without writing CR1-CR4, i.e. it hands the game the registers
				// of the PREVIOUS command.
				this._cdResp(this._cdStatusBase(false, 0) << 8, cd.fadSearch.spos,
					(cd.fadSearch.pnum << 8) | ((cd.fadSearch.fad >>> 16) & 0xFF),
					cd.fadSearch.fad & 0xFFFF);
				break;

			case 0x60:   // Set Sector Length: sector length for Get/Put Sector Data
			{
				const getLength = cr[0] & 0xFF;
				const putLength = (cr[1] >> 8) & 0xFF;
				// 0xFF = "do not change"; the rest has to be a valid index (0-3).
				if((getLength !== 0xFF && getLength > 3) || (putLength !== 0xFF && putLength > 3))
				{
					this._cdRespStatus(true, 0);
					break;
				}
				if(getLength !== 0xFF) cd.getSecLen = getLength;
				if(putLength !== 0xFF) cd.putSecLen = putLength;
				this._cdRespStatus(false, 0);
				this._cdIrq(CD_HIRQ_ESEL);
				break;
			}

			case 0x61:   // Get Sector Data      (read without deleting)
			case 0x62:   // Delete Sector Data   (delete without reading)
			case 0x63:   // Get Then Delete Sector Data (read and delete)
			{
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				let offs   = cr[1];
				let numsec = cr[3];
				const total = cd.part[pnum].length;
				if(offs === 0xFFFF) offs = total - 1;         // 0xFFFF = the last sector
				if(numsec === 0xFFFF) numsec = total - offs;  // 0xFFFF = until the end

				// With a transfer in progress (or parameters out of range) the
				// hardware asks to retry.
				if((cd.dt.active && cmd !== 0x62) || numsec <= 0 || offs < 0 || (offs + numsec) > total)
				{
					this._cdRespStatus(false, CD_ST_WAIT);
					break;
				}

				if(cmd === 0x62)   // delete only
				{
					const list = cd.part[pnum].splice(offs, numsec);
					for(const b of list) this._cdBufFree(b);
					this._cdRespStatus(false, 0);
					this._cdIrq(CD_HIRQ_EHST);
					this._cdVerifyResume();
					break;
				}

				// Read: 0x61 leaves the sectors in the partition; 0x63 takes them out (but
				// the buffers are only freed at End Data Transfer).
				const list = (cmd === 0x63) ? cd.part[pnum].splice(offs, numsec)
				                             : cd.part[pnum].slice(offs, offs + numsec);
				this._cdRespStatus(false, CD_ST_DTREQ);
				this._cdDtInit(list, -1, cmd === 0x63);
				this._cdIrq(CD_HIRQ_DRDY);
				break;
			}

			case 0x64:   // Put Sector Data: the HOST writes sectors into a partition
			{
				// It is Get Sector Data in reverse: instead of reading from the DTR, the game
				// WRITES through the DTR and the CD block puts what is written into its own buffers,
				// which, when the transfer is closed (End Data Transfer), go through filter
				// `fnum` and land in its partition. It is used to build sectors by hand.
				// Ported from Mednafen cdb.c COMMAND_PUT_SECDATA.
				const fnum   = (cr[2] >> 8) & 0xFF;
				const numsec = cr[3];
				if(fnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				if(numsec === 0 || numsec > cd.free.length || cd.dt.active)
				{
					this._cdRespStatus(false, CD_ST_WAIT);
					break;
				}
				this._cdDisconnectInput(fnum);
				this._cdRespStatus(false, CD_ST_DTREQ);
				// The buffers are reserved RIGHT AWAY (the hardware has to have them before
				// the host starts writing), but they are NOT filtered until End Data
				// Transfer.
				const list = [];
				for(let i = 0; i < numsec; i++) list.push(this._cdBufAlloc());
				this._cdDtInitWrite(list, fnum);
				this._cdIrq(CD_HIRQ_DRDY);
				break;
			}

			case 0x65:   // Copy Sector Data: copies sectors from a partition to a filter
			case 0x66:   // Move Sector Data: the same but TAKING THEM OUT of the source
			{
				// Copy duplicates the buffers (it needs as many free ones as sectors);
				// Move unhooks them from the source and rehooks them at the destination, so
				// it does NOT consume free buffers -that is why the space check does not
				// apply to it- and that is why the hardware does it much faster.
				// Ported from Mednafen cdb.c COMMAND_COPY_SECDATA / COMMAND_MOVE_SECDATA.
				const isMove   = (cmd === 0x66);
				const dstFnum  = cr[0] & 0xFF;
				const srcPnum  = (cr[2] >> 8) & 0xFF;
				if(srcPnum >= CD_PARTITIONS || dstFnum >= CD_PARTITIONS)
				{
					this._cdRespStatus(true, 0);
					break;
				}
				const total = cd.part[srcPnum].length;
				let offs   = cr[1];
				let numsec = cr[3];
				if(offs === 0xFFFF) offs = total - 1;         // 0xFFFF = the last sector
				if(numsec === 0xFFFF) numsec = total - offs;  // 0xFFFF = until the end
				if(cd.dt.active || numsec <= 0 || (numsec > cd.free.length && !isMove) ||
				   offs < 0 || (offs + numsec) > total)
				{
					this._cdRespStatus(false, CD_ST_WAIT);
					break;
				}
				this._cdDisconnectInput(dstFnum);
				// The list is taken out BEFORE touching anything: in the Move, filtering a buffer
				// can push it into the source partition and shift the indices.
				const origin = isMove ? cd.part[srcPnum].splice(offs, numsec)
				                      : cd.part[srcPnum].slice(offs, offs + numsec);
				for(const b of origin)
				{
					let bd = b;
					if(!isMove)   // copy: new buffer with the same bytes
					{
						bd = this._cdBufAlloc();
						cd.data.copyWithin(bd * CD_SECTOR_SIZE, b * CD_SECTOR_SIZE,
							b * CD_SECTOR_SIZE + CD_SECTOR_SIZE);
					}
					this._cdFilterBuffer(dstFnum, bd);
				}
				this._cdRespStatus(false, 0);
				if(cd.free.length === 0) this._cdIrq(CD_HIRQ_BFUL);
				this._cdIrq(CD_HIRQ_ECPY);
				break;
			}

			case 0x67:   // Get Copy Error: no sector copy/move errors
				// Yabause's Cs2GetCopyError: CR2-CR4 at zero (it is not a position
				// report like the generic status).
				//? It returns a fixed "no errors", same as Mednafen ("TODO: Implement if
				//? we ever implement proper asynch copy/moving"): our Copy/Move
				//? above is synchronous -it finishes within the same command- so there is
				//? no way for an error to be left halfway to report.
				this._cdResp(this._cdStatusBase(false, 0) << 8, 0, 0, 0);
				break;

			case 0x70:   // Change Directory: the CD block steps into a subdirectory
			{
				// fileId 0xFFFFFF = back to the root. The rest has to be a table entry
				// that is ALSO a directory.
				let reject = (pnum >= CD_PARTITIONS);
				if(fileId !== 0xFFFFFF)
				{
					if(!cd.fileInfoValid) reject = true;
					else if(outsideOfWindow) reject = true;
					else if(!(cd.fileInfo[fiaOffs * CD_FI_SIZE + 11] & CD_FATTR_DIR)) reject = true;
				}

				if(fls.active)       { this._cdRespStatus(false, CD_ST_WAIT); break; }
				if(reject)         { this._cdRespStatus(true, 0); break; }
				if(fileId === 0)     // "." = the current directory: nothing to do
				{
					this._cdRespStatus(false, 0);
					this._cdIrq(CD_HIRQ_EFLS);
					break;
				}
				this._cdRespStatus(false, 0);
				fls.fioffs  = 2;
				fls.fiaoffs = (fileId === 0xFFFFFF) ? 0xFFFFFF : fiaOffs;
				fls.pnum    = pnum;
				fls.doAuth  = false;
				fls.active  = true;
				break;
			}

			case 0x71:   // Read Directory: rereads the current directory from a file id
			{
				// The table window starts at the requested file id (minimum 2: the
				// entries 0 and 1 are always "." and "..").
				const since = (fileId < 2) ? 2 : fileId;
				if(fls.active)                            { this._cdRespStatus(false, CD_ST_WAIT); break; }
				if(pnum >= CD_PARTITIONS || !cd.fileInfoValid) { this._cdRespStatus(true, 0); break; }
				this._cdRespStatus(false, 0);
				fls.fioffs  = since;
				fls.fiaoffs = 0;        // 0 = the "." of the current directory (where we are)
				fls.pnum    = pnum;
				fls.doAuth  = false;
				fls.active  = true;
				break;
			}

			case 0x72:   // Get File System Scope: which table window was left loaded
				if(fls.active)        { this._cdRespStatus(false, CD_ST_WAIT); break; }
				if(!cd.fileInfoValid) { this._cdRespStatus(true, 0); break; }
				// CR2 = how many files there are; CR3 high = 1 if NO more were left outside;
				// CR3 low + CR4 = the file id of the first entry of the window.
				this._cdResp(this._cdStatusBase(false, 0) << 8,
					cd.fileInfoCount,
					((cd.fileInfoMore ? 0 : 1) << 8) | ((cd.fileInfoOffs >>> 16) & 0xFF),
					cd.fileInfoOffs & 0xFFFF);
				break;

			case 0x73:   // Get File Info: delivers the file info table through the DTR
			{
				// 0xFFFFFF = the whole window; otherwise, a single entry.
				const reject = !cd.fileInfoValid ||
					(fileId !== 0xFFFFFF && outsideOfWindow) ||
					(fileId === 0xFFFFFF && !cd.fileInfoCount);

				if(fls.active || cd.dt.active) { this._cdRespStatus(false, CD_ST_WAIT); break; }
				if(reject)                   { this._cdRespStatus(true, 0); break; }

				let offPal, words;
				if(fileId === 0xFFFFFF)
				{
					offPal   = CD_FI_WORDS * 2;                    // skip "." and ".."
					words = CD_FI_WORDS * cd.fileInfoCount;
				}
				else
				{
					offPal   = CD_FI_WORDS * fiaOffs;
					words = CD_FI_WORDS;
				}
				this._cdResp(this._cdStatusBase(false, CD_ST_DTREQ) << 8, words, 0, 0);
				this._cdDtInit([CD_FI_BUFVIRT], words, false, offPal);
				this._cdIrq(CD_HIRQ_DRDY);
				break;
			}

			case 0x74:   // Read File: the CD block reads a whole file into a partition
			{
				// The offset comes in SECTORS from the start of the file.
				const offset = (((cr[0] & 0xFF) << 16) | cr[1]) >>> 0;
				if(fls.active) { this._cdRespStatus(false, CD_ST_WAIT); break; }
				if(pnum >= CD_PARTITIONS || !cd.fileInfoValid || outsideOfWindow)
				{
					this._cdRespStatus(true, 0);
					break;
				}
				this._cdRespStatus(false, 0);
				this._cdClearPartition(pnum);

				const tOff    = fiaOffs * CD_FI_SIZE;
				const fadStart  = (this._cdFiFad(cd.fileInfo, tOff) + offset) & 0xFFFFFF;
				const secCount = (((this._cdFiSize(cd.fileInfo, tOff) + 2047) >>> 11) - offset) >>> 0;

				// The drive keeps dumping the file into partition `pnum`, filtering
				// by FAD range (and by file number if it is XA).
				this._cdFlsBuildFilter(pnum, fadStart, secCount,
					CD_FMODE_FADR | CD_FMODE_FILE, cd.fileInfo[tOff + 10]);
				this._cdInitSeek(0x800000 | fadStart,
					0x800000 | ((fadStart + secCount) & 0x7FFFFF), 0, CD_HIRQ_EFLS, false);
				break;
			}

			case 0x75:   // Abort File: cancels the filesystem operation in progress
				// EFLS is key: the BIOS sends Abort File inside its
				// "checking disc format" routine and waits for that flag. The filesystem machine
				// tears down whatever it was doing; we run it on the spot so as not to
				// delay the notice by a whole frame.
				this._cdRespStatus(false, 0);   // reports the status and fires CMOK
				fls.abort = true;
				if(this._cdFlsStep()) this._cdIrq(CD_HIRQ_EFLS);
				break;

			case 0xE0:   // Auth Device: authenticates the disc (copy protection)
			{
				if(pnum >= CD_PARTITIONS) { this._cdRespStatus(true, 0); break; }
				if(fls.active)             { this._cdRespStatus(false, CD_ST_WAIT); break; }
				// THE DRIVE HAS TO BE READY. Authenticating is READING the first sector for
				// real, and with the disc just inserted the motor is still getting up to
				// speed ("starting" phase, see mountDisc). Accepting the command there
				// starts the filesystem machine on a drive that cannot read.
				// Measured with diag/dchg-sequence.mjs: on a hot disc change the
				// BIOS launches Auth at frame 432 with the drive spinning up, it does not complete,
				// and it RETRIES the whole sequence (33 + 44 polling GetStatus lost);
				// only the second attempt, with the drive paused, authenticates (authType
				// 0x00 -> 0x04). Answering WAIT to the first one, the BIOS waits and authenticates
				// ONCE, which is what it does with the disc inserted from boot.
				if(cd.phase === "starting") { this._cdRespStatus(false, CD_ST_WAIT); break; }
				this._cdRespStatus(false, 0);
				if(!(cd.toc.tracks[1].control & 0x4))
				{
					// Audio CD: there is nothing to authenticate.
					cd.authType = 0x01;
					this._cdIrq(CD_HIRQ_EFLS);
					break;
				}
				// Data disc: the filesystem machine authenticates it by reading the
				// first sector for real through the drive (it fires EFLS when done).
				fls.pnum   = pnum;
				fls.doAuth = true;
				fls.active = true;
				break;
			}

			case 0xE1:   // Get Auth Status
				if(fls.active && fls.doAuth) { this._cdRespStatus(true, 0); break; }
				this._cdResp(this._cdStatusBase(false, 0) << 8, cd.authType, 0, 0);
				break;

			// --- MPEG card (Video CD Card): 0x90-0xAF and 0xE2 ---
			// This machine DOES NOT HAVE the card, and we already tell the game so in
			// Get Hardware Info (CR3 = 0, "MPEG not authenticated"). The CD block RECOGNIZES
			// these commands -they are its own, the card only decodes- but without it it cannot
			// run them, so the correct answer is REJECTED (0xFF).
			//
			// Before, they fell into the default and got a "status OK", i.e. "I already
			// did it". That is worse than not having them: a Video CD would see a successful MpegInit and
			// would carry on waiting for video that is never coming. With the rejection the
			// game finds out on the first command, which is what happens on real hardware without the
			// cartridge. (Reference for code 0xE2 = "Get MPEG Card Boot ROM": the Yabause
			// wiki, CDBlock, which also sets STATUS_REJECT = 0xFF.)
			//
			// Measured: NONE of the 9 games requests an MPEG command in 1800 frames
			// (diag/cd-commands.mjs). The only one seen in practice is 0xE2, which
			// the BIOS issues at boot — the same one MAME reports as "unknown
			// command e2" (mametesters #06843).
			case 0x90: case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96:
			case 0x9A: case 0x9B: case 0x9D: case 0x9E:
			case 0xA0: case 0xA1: case 0xA2: case 0xA3: case 0xA4: case 0xAF:
			case 0xE2:
				this._cdRespStatus(true, 0);   // CR1 = 0xFF00: rejected
				break;

			default:
				// Command that DOES NOT EXIST in the CD block. The hardware answers REJECTED
				// (0xFF), not "ready": that is the status with which the firmware signals that it
				// could not run what it was asked. It still fires CMOK — not answering it
				// would hang the game waiting for the end-of-command interrupt.
				// It also stays on the "what is missing" radar.
				if(this.logging)
				{
					const key = "CD cmd:0x" + cmd.toString(16).padStart(2, "0");
					this.mmioUnknown.set(key, (this.mmioUnknown.get(key) || 0) + 1);
				}
				this._cdRespStatus(true, 0);
				break;
		}
	}

	// ---------- SCSP: sound registers, accessible by the SH-2 and the 68k ----------
	scspRead(off, size)
	{
		off &= 0xFFF;
		// CA ($408) is dynamic: it is computed from the monitored slot when read.
		if(off < 0x40A && off + size > 0x408) this._scspRefreshCa();
		// State of the MIDI FIFOs ($404), also dynamic.
		if(off < 0x406 && off + size > 0x404) this._scspRefreshMidi();
		// DSP internal buffers ($C00-$EBF): TEMP, MEMS and MIXS.
		if(off >= 0xC00 && off < 0xEC0) this._scspRefreshDsp(off);
		return this._readRegBE(this.scspRam, off, size);
	}

	// TEMP ($C00), MEMS ($E00) and MIXS ($E80) are part of the map: the DSP internal
	// buffer map puts them there, with TEMP and MEMS at 24 bits and MIXS at 20,
	// each entry in TWO words (the high half first). Until now the raw bank was
	// returned, i.e. zeros: the DSP's live state never came out.
    //
	// They are resolved ON READ, same as CA ($408) and the MIDI flags ($404), and not by mirroring
	// per block like EFREG/SOUS. The reason is the cost: it is 128 + 32 + 16 = 176 entries, i.e.
	// 352 words, and mirroring them once per block would be ~45,000 writes per frame
	// -more than the whole rest of the chip put together- for something that none of the 10 games measured with
	// diag/scsp-fidelity.mjs ever reads. Resolved on read it costs zero when nobody
	// asks and it is exact when someone does.
	_scspRefreshDsp(off)   //ok, 28-07-2026
	{
		const m = this.scspEngine;
		if(!m) return;
		const w = (o, v) => { this.scspRam[o] = (v >> 8) & 0xFF; this.scspRam[o + 1] = v & 0xFF; };
		if(off < 0xE00)
		{
			const i = (off - 0xC00) >> 2;                 // TEMP: 128 x 24 bits
			const v = m.dspTemp[i] & 0xFFFFFF;
			w(0xC00 + i * 4, (v >> 8) & 0xFFFF);          // TEMP[23:8]
			w(0xC02 + i * 4, v & 0xFF);                   // TEMP[7:0]
		}
		else if(off < 0xE80)
		{
			const i = (off - 0xE00) >> 2;                 // MEMS: 32 x 24 bits
			const v = m.dspMems[i] & 0xFFFFFF;
			w(0xE00 + i * 4, (v >> 8) & 0xFFFF);
			w(0xE02 + i * 4, v & 0xFF);
		}
		else
		{
			const i = (off - 0xE80) >> 2;                 // MIXS: 16 x 20 bits
			const v = m.dspMixs[i] & 0xFFFFF;
			w(0xE80 + i * 4, (v >> 4) & 0xFFFF);          // MIXS[19:4]
			w(0xE82 + i * 4, v & 0xF);                    // MIXS[3:0]
		}
	}

	// $404: MOFULL(12) MOEMP(11) MIOVF(10) MIFULL(9) MIEMP(8) + MIBUF[7:0].
	// The two MIDI FIFOs are ALWAYS EMPTY, and it is not a simplification: the SCSP
	// has the 31.25 Kbps serial interface, but the Saturn includes no MIDI
	// peripheral circuit and no MIDI DIN connector, so MIDI
	// applications cannot be created. Without a connector not a single byte comes in through MIDI-IN, and whatever
	// is written to MOBUF goes out and leaves the output FIFO empty again.
	// Why it matters: the bank started at ZEROS, i.e. MOEMP=0 and MIEMP=0 -both FIFOs
	// "with data"-, which is the impossible state. A driver waiting for MOEMP to transmit
	// spins forever. Daytona and Virtua Cop READ this register (measured with
	// diag/scsp-fidelity.mjs).
	//? The associated interrupt bits (SCIPD bit 3 "MIDI input" and bit 9 "MIDI output")
	//? are never raised, and rightly so: they are defined by TRANSITION -when the
	//? MIDI-IN side FIFO captures data from an empty state, and when the
	//? MIDI-OUT side FIFO becomes empty- and without a connector there is
	//? neither of the two transitions.
	_scspRefreshMidi()   //ok, 27-07-2026
	{
		this.scspRam[0x404] = 0x09;   // MOEMP (bit 11) + MIEMP (bit 8)
		this.scspRam[0x405] = 0x00;   // MIBUF: no data
	}

	// Returns the value of a write seen as the word of register `base`, or
	// null if the write does not touch it. Covers byte access (which the 68k
	// can do; the SH-2 is prohibited from it), word and long.
	_scspWordWritten(base, off, val, size)
	{
		if(size === 1)
		{
			if(off === base)     return (val & 0xFF) << 8;
			if(off === base + 1) return val & 0xFF;
			return null;
		}
		if(size === 2) return (off === base) ? (val & 0xFFFF) : null;
		if(off === base)     return (val >>> 16) & 0xFFFF;   // high word of the long
		if(off === base - 2) return val & 0xFFFF;            // low word of the long
		return null;
	}

	// Returns the value of TIMx (the LOW byte of register `base`) that this write sets, or
	// null if it does not touch it. It is separate from _scspWordWritten because there the HIGH byte also counts
	// as "wrote the word", and the high byte of these registers is TxCTL (the prescaler): taking
	// the counter as reloaded when only TACTL is written would set it to 0. X-Men does that at
	// boot -it writes $41A (TBCTL) and $41B (TIMB) separately-, so it is not theoretical.
	_scspTimWritten(base, off, val, size)
	{
		if(size === 1) return (off === base + 1) ? (val & 0xFF) : null;
		if(size === 2) return (off === base) ? (val & 0xFF) : null;
		if(off === base)     return (val >>> 16) & 0xFF;   // high word of the long
		if(off === base - 2) return val & 0xFF;            // low word of the long
		return null;
	}

	// MSLC/CA ($408): MSLC[4:0] sits in bits 15:11
	// and CA[3:0] in bits 10:7.
	// MSLC (W), MonitorSLot Call: the slot number to monitor in the
	// 'CA' register; '0H' is SLOT0, '1FH' is SLOT31.
	// CA (R), Call Address: for the slot set in MSLC it reads
	// the address of the waveform data currently being read, as the relative number
	// of samples from 'SA'; the LSB of the value read here stands for
	// 4K (4096) samples.
	// So CA = (current sample) >> 12, and the current sample is the slot's phase
	// counter without its 10 fractional bits (SCSP_FREQ_LB in scsp.js).
	// Why it matters: a driver that waits for a sample to end or loop
	// polls CA. Always returning 0 spins forever.
	// Called by scspRead when the read touches $408 (see further up in this file).
	_scspRefreshCa()   //ok, 17-07-2026
	{
		if(!this.scspEngine) return;
		const mslc = (this.scspRam[0x408] >> 3) & 0x1F;
		const ca = (this.scspEngine.slots[mslc].fcnt >>> (10 + 12)) & 0xF;
		const w = (mslc << 11) | (ca << 7);
		this.scspRam[0x408] = (w >> 8) & 0xFF;
		this.scspRam[0x409] = w & 0xFF;
	}

	// SCSP internal DMA ($412-$416). The SCSP's built-in DMA can only transfer
	// between the SCSP's built-in control
	// registers and sound memory; during the transfer, addresses always change in
	// an increasing direction, and the transfer is word (16-bit) by word.
	// The bit map:
	//   $412: DMEA[15:1] (bits 15:1)
	//   $414: DMEA[19:16] (bits 15:12), DRGA[11:1] (bits 11:1)
	//   $416: DGATE(14), DDIR(13), DEXE(12), DTLG[11:1] (bits 11:1)
	// The [n:1] notation means bit 0 cannot be set: they are addresses
	// and a byte count, always even (hence "word units" and the cap of 0xEE4
	// bytes of the register area).
	// Why it matters: it is a HANG. The DMA transfer starts when DEXE is
	// set to 1, and when the transfer completes the bit automatically goes back to 0,
	// so a driver that starts a DMA and polls DEXE until it sees it at 0 spins
	// forever if the bit never clears.
	// Fired by scspWrite when it sees DEXE (bit 12 of $416) set. Complete: DGATE,
	// both DDIR directions, the DEXE that clears itself and the end-of-DMA IRQ.
	//
	//? WHAT IS MISSING IS THE TIME, and it is the same pattern as the CD block (where giving ~333 us
	//? to the command moved four games at once): this transfer runs ENTIRELY inside the
	//? DEXE write and returns with DEXE already at 0, so a game that starts the DMA and
	//? polls DEXE sees it finished in the same access. The hardware does two things we do not
	//? model: it takes time -it is a word (16-bit) transfer, up to 3812 bytes-
	//? and that time is CHARGED to the CPUs: the main CPU
	//? and the sound CPU may slow down during the DMA transfer, the sound CPU
	//? because of the wait states imposed on it while the SCSP's built-in DMA
	//? is in use.
	//? It was not implemented for now on purpose: none of the games measured with
	//? diag/scsp-fidelity.mjs (Rally, Daytona, Virtua Cop) writes $416, i.e. none of them
	//? uses this DMA; and the lesson of the CD -"touching one piece of the timing model without redoing the
	//? rest is patch on top of patch"- says this goes together with the rest of the
	//? SCSP timings, with the ceiling measured first.
	_scspDma()   //ok, 17-07-2026
	{
		// Accessing the DMA controller's control registers through a DMA
		// transfer is prohibited on hardware: if the DMA itself writes $416 with DEXE
		// set, it is not re-entered (nothing is guaranteed about such a transfer).
		if(this.scsp.dmaInProgress) return;
		this.scsp.dmaInProgress = true;

		const w414 = this._readRegBE(this.scspRam, 0x414, 2);
		const w416 = this._readRegBE(this.scspRam, 0x416, 2);
		// DMEA[19] would address the second 4Mbit bank; the Saturn
		// only has the first one (512 KB), so the sound RAM mirrors, same as in
		// the rest of the bus.
		const dmea  = (((w414 & 0xF000) << 4) |
		               (this._readRegBE(this.scspRam, 0x412, 2) & 0xFFFE)) & 0x7FFFF;
		const drga  = w414 & 0xFFE;
		const length = w416 & 0xFFE;          // DTLG, in bytes
		const gate  = (w416 >> 14) & 1;      // DGATE
		const addr   = (w416 >> 13) & 1;      // DDIR

		for(let i = 0; i < length; i += 2)
		{
			const a = (dmea + i) & 0x7FFFF;  // sound RAM
			const r = (drga + i) & 0xFFF;    // SCSP registers
			if(gate)
			{
				// DGATE: initializes the SCSP's built-in control registers or any area
				// of sound memory to 0; an erasing transfer (writing 0) with
				// DGATE does not affect the data at the transfer source.
				if(addr) { this.soundRam[a] = 0; this.soundRam[a + 1] = 0; }
				else this.scspWrite(r, 0, 2);
			}
			else if(addr)
			{
				// DDIR=1: transfer from the LSI's internal registers to sound memory.
				const v = this.scspRead(r, 2);
				this.soundRam[a] = (v >> 8) & 0xFF;
				this.soundRam[a + 1] = v & 0xFF;
			}
			else
			{
				// DDIR=0: transfer from sound memory to the LSI's internal registers.
				// It goes through scspWrite so that the slot region re-decodes and
				// handles KYONEX, same as if a CPU wrote it.
				this.scspWrite(r, (this.soundRam[a] << 8) | this.soundRam[a + 1], 2);
			}
		}

		this.scsp.dmaInProgress = false;

		// THE DMA TAKES TIME, and the game watches it through DEXE. The DMA transfer starts when the bit
		// is set to 1 and, when the transfer completes, it automatically goes back to 0:
		// a driver that starts the transfer and polls DEXE until it sees it at 0 has to go
		// around at least once. Clearing it in the same write turns the handshake into a
		// non-event, which is exactly what happened with the CD command before giving it its
		// ~333 us -and that change moved four games at once-.
		//
		// THE BOUND COMES FROM THE HARDWARE, not from a number picked at will. There are 128
		// memory cycles within one sample (1/44.1K = 22.68 us), of which two empty
		// cycles are required for the DRAM refresh, and the sound generator uses two
		// memory cycles to produce sound from one slot, a total of 64. The DMA is priority
		// 3, so at best it gets the 62 that are left over, and it transfers
		// one word at a time (it is a 16-bit transfer). So 62 words per sample
		// is the physical UPPER BOUND: the DMA cannot go faster than that. The bound is used and
		// not a slower value because the real split depends on how many slots are sounding and on what
		// the CPUs ask for, and nothing pins that down.
		// AND THE TIME IS CHARGED TO THE 68000, which is the other half of what the hardware does:
		// the sound CPU's operating speed decreases while the SCSP's built-in DMA is in use, because of
		// the wait states imposed on the sound CPU, and the speed of
		// the main CPU and the sound CPU may drop during the DMA transfer.
		// The factor is not picked at will: the 68000 EXECUTES FROM SOUND RAM, so every
		// memory cycle the DMA takes is a cycle in which the sound CPU cannot
		// even fetch the next instruction. `dmaFrac` is the share of the 62 free cycles
		// per sample that the DMA is using, and that same share is what the 68000 loses:
		// with a long transfer it gives 1 (the DMA takes everything and the 68000 stays halted
		// while it lasts), with a short one whatever part falls to it.
		//? The SH-2 is not charged. The main CPU "may drop" in speed too,
		//? but its traffic with the sound block is measured at 0.8 accesses per frame (see
		//? the note on the 0x05B00000 routing), so there is nothing to move.
		const words = length >> 1;
		this.scsp.dmaRemaining = Math.max(1, Math.ceil(words / 62));   // in samples
		this.scsp.dmaFrac = Math.min(1, words / (this.scsp.dmaRemaining * 62));
	}

	scspWrite(off, val, size)
	{
		off &= 0xFFF;
		// SCIRE (0x422): writing clears the matching bits of SCIPD.
		if(off >= 0x422 && off < 0x424)
		{
			let scipd = ((this.scspRam[0x420] << 8) | this.scspRam[0x421]) & ~(val & 0xFFFF);
			this.scspRam[0x420] = (scipd >> 8) & 0xFF; this.scspRam[0x421] = scipd & 0xFF;
			return;
		}
		// MCIRE (0x42E): the MAIN CPU's SCIRE. Writing a 1 to a bit clears that bit
		// of MCIPD. It is the ONLY way the Sound Request handler has to acknowledge
		// the interrupt: without it, the bit stays pending forever.
		// MCIRE[10:0], Main CPU Interrupt REset, is the interrupt request reset flag
		// for the main CPU: setting a 1 resets
		// the hardware interrupt request of the corresponding bit (it also goes from
		// 1 to 0). In the register map, MCIRE is at 10042Eh.
		// It does NOT call _scspEvalInt(): that function only REQUESTS interrupts (_scuIrq), it does not
		// cancel them, and clearing MCIPD bits can never make (mcipd & mcieb) go
		// from 0 to non-zero. So here it would have nothing to fire. Worse: with
		// MCIRE=0 -which on hardware clears no bit- re-evaluating would fire a
		// SPURIOUS Sound Request on every harmless write. Mutation testing
		// confirmed it: removing the call did not break any test (it was dead code) and the test
		// "MCIRE with 0 does not fire a spurious Sound Request" fails if it is put
		// back. Symmetric with SCIRE (0x422), which does not re-evaluate either.
		if(off >= 0x42E && off < 0x430)   //ok, 17-07-2026
		{
			let mcipd = ((this.scspRam[0x42C] << 8) | this.scspRam[0x42D]) & ~(val & 0xFFFF);
			this.scspRam[0x42C] = (mcipd >> 8) & 0xFF; this.scspRam[0x42D] = mcipd & 0xFF;
			return;
		}
		// SCIPD (0x420) and MCIPD (0x42C) are READ-ONLY except for bit 5.
		// Only bit 5 can be read and written; all
		// the others are read-only. Writing 1 to bit 5 causes an interrupt to the
		// sound CPU [the main CPU in MCIPD]; writing 0 has no effect.
		// Bit 5 is the standard IPC doorbell between the SH-2 and the 68k (CPU manual
		// interrupts: either CPU, main or sound, can interrupt the other one
		// by writing this bit).
		// Why it matters: letting them go through _writeRegBE below made a
		// doorbell write (0x20) ERASE the pending bits of the timers and of the
		// sample, which are the ones the hardware sets and only SCIRE/MCIRE can clear.
		if(off >= 0x420 && off < 0x422)   //ok, 17-07-2026
		{
			const w = this._scspWordWritten(0x420, off, val, size);
			if(w !== null && (w & 0x20)) this.scspRam[0x421] |= 0x20;
			return;
		}
		if(off >= 0x42C && off < 0x42E)   //ok, 17-07-2026
		{
			const w = this._scspWordWritten(0x42C, off, val, size);
			if(w !== null && (w & 0x20))
			{
				this.scspRam[0x42D] |= 0x20;
				this._scspEvalInt();
			}
			return;
		}
		this._writeRegBE(this.scspRam, off, val, size);
		// TIMA/TIMB/TIMC: writing the low byte loads the reload, which scspTick applies
		// on the next prescaler tick.
		//
		// ⚠ THE HARDWARE DOES SOMETHING ELSE AND THIS IS REVERTED ON PURPOSE. On hardware, counting
		// begins immediately after TIMA, TIMB and TIMC are set, i.e.
		// the counter should take the value ON THE WRITE. It was implemented that way on
		// 27-07-2026 and Sebas tested it on 28-07 — Sebas (28-07-2026, translated): "in-game, the countdown repeats the
		// numbers twice... 3,3 2,2 1,1 go go go go" on Sega Rally. Reverted per the repo's
		// rule, together with bit 10 per sample (see scspTick): both of them bring forward the
		// cadence with which the driver sees the chip, and Rally reloads TIMA/TIMB about 7 times
		// per frame, so the error shows right away.
		//? To try it again it has to be done ONE AT A TIME and with Rally alongside: the
		//? symptom comes from the driver running faster, not from the mix.
		if(off >= 0x418 && off < 0x41E)
		{
			const i = (off - 0x418) >> 1;
			this.scsp.tReload[i] = this.scspRam[0x419 + i * 2] & 0xFF;
		}
		// DEXE ($416 bit 12): the DMA transfer starts when this bit is set to 1.
		// The range starts at 0x414 because a long there overwrites both registers.
		if(off >= 0x414 && off < 0x418)
		{
			const w = this._scspWordWritten(0x416, off, val, size);
			if(w !== null && (w & 0x1000)) this._scspDma();
		}
		// MCIPD/MCIEB changed -> re-evaluate the Sound Request interrupt to the SH-2.
		if(off >= 0x42A && off < 0x42E) this._scspEvalInt();
		// Tell the audio engine. Two regions matter to it and the filter is INSIDE
		// notifyWrite: the slots ($000-$3FF), to re-decode and handle KEY-ON/OFF,
		// and the DSP registers ($700-$BFF), which it used to discover by comparing 1,280 bytes per
		// block and now learns about through the edge.
		if(this.scspEngine) this.scspEngine.notifyWrite(off, size);
	}

	// Advances the SCSP timers by `samples` samples and fires the interrupts.
	scspTick(samples)
	{
		const s = this.scsp;

		// End of the internal DMA: DEXE clears itself and only then does the end IRQ come out
		// (bit 4). See the duration bound in _scspDma().
		if(s.dmaRemaining > 0)
		{
			s.dmaRemaining -= samples;
			if(s.dmaRemaining <= 0)
			{
				s.dmaRemaining = 0;
				s.dmaFrac = 0;
				this.scspRam[0x416] &= ~0x10;   // DEXE = bit 12 of the word = bit 4 of the high byte
				this._scspSetPending(0x10);
			}
		}

		for(let n = 0; n < samples; n++)
		{
			s.sample = (s.sample + 1) & 0x7FFFFFFF;
			for(let i = 0; i < 3; i++)
			{
				// TxCTL sets every how many samples it increments (0 = once
				// per sample ... 7 = once every 128). It fires on REACHING FFH, not on
				// overflowing: when all of the bits reach 1, an interrupt request
				// occurs, and that is where the formula {255 - TIMx} x count cycle comes from.
				const control = this.scspRam[0x418 + i * 2] & 0x7;
				if(!(s.sample & ((1 << control) - 1)))
				{
					if(s.tReload[i] >= 0){ s.tCount[i] = s.tReload[i]; s.tReload[i] = -1; }
					else s.tCount[i] = (s.tCount[i] + 1) & 0xFF;
					if(s.tCount[i] === 0xFF) this._scspSetPending(0x40 << i);   // Timer i
				}
			}
		}
		// Bit 10: one interrupt each sample
		// (1 sample = 22.68 us = 1/44.1K intervals).
		//
		// ⚠ IT IS RAISED ONCE PER CALL, NOT PER SAMPLE, AND THAT IS ON PURPOSE.
		// On 27-07-2026 it was switched to per sample, which is what the circuit does. Sebas tested it
		// on 28-07 — Sebas (28-07-2026, translated): "in-game, the countdown repeats the numbers twice... 3,3 2,2 1,1
		// go go go go" on Sega Rally. Reverted per the repo's rule (if it breaks something that
		// worked, it comes out first).
		// The explanation of why it shows, so as not to fall for it again: Rally does NOT enable
		// interrupts (SCIEB = 0) but it POLLS SCIPD -129,872 reads in 1,200 frames- and
		// clears it with SCIRE. A driver that counts edges of this bit to keep its tempo
		// ends up counting ~2.81 times faster, which is exactly the grain of the interleave, and
		// fires every event several times.
		//? So the underlying bug is NOT this flag: it is that the 68000 can only observe the
		//? chip every 2-3 samples (see "the grain is set by the interleave"). Raising it per
		//? sample without the 68000 running per sample gives the driver more edges than
		//? the hardware would show it. The two things go TOGETHER or not at all.
		this._scspSetPending(0x400);
		this._scspEvalInt();
		// Generate the audio of the 32 slots for this block of samples.
		if(this.scspEngine) this.scspEngine.advance(samples);
	}

	_scspSetPending(bits)
	{
		let scipd = ((this.scspRam[0x420] << 8) | this.scspRam[0x421]) | bits;
		this.scspRam[0x420] = (scipd >> 8) & 0xFF; this.scspRam[0x421] = scipd & 0xFF;
		let mcipd = ((this.scspRam[0x42C] << 8) | this.scspRam[0x42D]) | bits;
		this.scspRam[0x42C] = (mcipd >> 8) & 0xFF; this.scspRam[0x42D] = mcipd & 0xFF;
	}

	// If (MCIPD & MCIEB), the SCSP interrupts the SH-2 through Sound Request (SCU bit 6).
	_scspEvalInt()
	{
		const mcipd = (this.scspRam[0x42C] << 8) | this.scspRam[0x42D];
		const mcieb = (this.scspRam[0x42A] << 8) | this.scspRam[0x42B];
		if(mcipd & mcieb)
		{
			this._scuDmaPerEvent(5);   // DMA channels armed on the SCSP request
			this._scuIrq(6, 0x9, 0x46);
		}
	}

	// Interrupt level the SCSP requests from the sound 68k (IPL 0-7).
	// From SCIPD & SCIEB, with the level encoded in SCILV0/1/2 (see Mednafen).
	scspLevel68k()
	{
		let mask = ((this.scspRam[0x420] << 8) | this.scspRam[0x421]) &
		           ((this.scspRam[0x41E] << 8) | this.scspRam[0x41F]);   // SCIPD & SCIEB
		if(mask & ~0xFF) mask = (mask & 0xFF) | 0x80;
		let l0 = ((this.scspRam[0x424] << 8) | this.scspRam[0x425]) & mask;
		let l1 = ((this.scspRam[0x426] << 8) | this.scspRam[0x427]) & mask;
		let l2 = ((this.scspRam[0x428] << 8) | this.scspRam[0x429]) & mask;
		let level = 0;
		if(l2) { level |= 4; l1 &= l2; l0 &= l2; }
		if(l1) { level |= 2; l0 &= l1; }
		level |= (l0 ? 1 : 0);
		return level;
	}

	// Video interrupts (called by the emulation loop every frame).
	// VBlank-IN: level 0xF vector 0x40. VBlank-OUT: level 0xE vector 0x41.
	vblankIn()
	{
		this.tvstat |= 0x0008;
		this._scuDmaPerEvent(0);   // DMA channels armed on VBlank-IN
		this._scuIrq(0, 0xF, 0x40);
		this.hblankTick();
	}
	vblankOut()
	{
		this.tvstat &= ~0x0008;
		this._scuDmaPerEvent(1);   // DMA channels armed on VBlank-OUT
		this._scuIrq(1, 0xE, 0x41);
		// The Timer 0 line counter starts from zero every frame and is compared
		// right away, in case the game programmed T0C = 0 (Yabause's ScuSendVBlankOUT).
		this.scuTimer0 = 0;
		this._scuTimer0Check();
		this.hblankTick();
	}

	// SCU Timer 0: level 0xC, vector 0x43. It fires when the line counter
	// matches T0C (0x25FE0090) and the timer is enabled by bit 0 of T1MD
	// (0x25FE0098). Ported from Yabause's ScuSendHBlankIN/ScuSendVBlankOUT/ScuSendTimer0
	// (scu.c): the counter is reset at VBlank-OUT and incremented on every HBlank-IN.
	//
	// It was missing completely (there was neither T0C nor a counter), and it is the interrupt that
	// hangs Street Fighter Alpha: the game programs T0C = 9, enables the timer
	// (T1MD = 0x101), unmasks bit 3 of the IMR and registers through SYS_SETUINT the
	// handler 0x60606a6, which does a single thing: set byte 0x6055e79 to 1. Its
	// wait routine at 0x606062c sets that byte to 0 and spins reading it until it
	// is != 0. Without Timer 0 nobody ever writes it and the game keeps spinning with the
	// screen black; as a knock-on effect it does not drain the CD block and its 200 buffers fill up
	// (BFUL), which is a CONSEQUENCE of the hang, not the cause.
	// Returns whether timer 0 MATCHED on this line: timer 1 needs it for its
	// "only on the timer 0 line" mode (see _scuTimer1Check).
	//ok, 16-07-2026
	_scuTimer0Check()
	{
		// T1MD bit 0 (TENB): enables BOTH timers, not just 0 (this bit turns
		// the timer operation ON/OFF).
		if(!(this._readRegBE(this.scuRegs, 0x98, 4) & 0x1)) return false;
		// T0C is 10 BITS (T0C9-0: bits 31-10 do not exist in
		// the register). Without the mask, a game that
		// leaves garbage above bit 9 never matched. Yabause compares the raw u32.
		if(this.scuTimer0 !== (this._readRegBE(this.scuRegs, 0x90, 4) & 0x3FF)) return false;
		this._scuDmaPerEvent(3);   // DMA channels armed on timer 0
		this._scuIrq(3, 0xC, 0x43);
		return true;
	}

	// SCU Timer 1: level 0xB, vector 0x44. It was declared in the scuInts table and
	// NOBODY ever fired it: the same hole HBlank-IN and Timer 0 had.
	//
	// On receiving H-Blank-IN the
	// SCU loads T1S (0x25FE0094, 9 bits) into timer 1, counts it down at ~7 MHz
	// -1/4 of the system clock, i.e. ONE DOT per count- and fires the interrupt
	// when the timer reaches 0. So: T1S is a DELAY IN DOTS within the line and
	// timer 1 fires at most once per line. T1MD (0x25FE0098) bit 8 chooses
	// on which ones:
	//     0 = on ALL lines
	//     1 = only on the line timer 0 matched
	// Bit 0 (TENB) enables both timers.
	//
	// HLE of the delay: there is no sub-line scheduler -the whole line is DERIVED from the
	// SH-2 cycles, see hblankTick-, so the T1S dots of delay within the
	// line cannot be represented and the interrupt comes out together with that line's H-Blank-IN.
	// The error is LESS THAN ONE LINE; never firing it is what
	// hangs the games that wait for it (same story as HBlank-IN).
	//
	// Yabause does NOT emulate it: ScuSendTimer1() exists but nobody calls it and in
	// ScuSendHBlankIN there is a "FIX ME - Should handle timer 1 as well" (scu.c:3950).
	//ok, 16-07-2026
	_scuTimer1Check(matchT0)
	{
		const t1md = this._readRegBE(this.scuRegs, 0x98, 4);
		// TENB off: the timer does not run, and it stays STOPPED so that when it is turned back on it
		// loads T1S again on the next H-Blank-IN.
		if(!(t1md & 0x1)){ this.scuTimer1Stopped = true; return; }

		// TIMER 1 IS A COUNTDOWN IN DOTS, not a "fires on every line". This
		// came as a later change to the SCU's specified behavior,
		// and it is two facts:
		//   1. The value of the timer 1 set data register is loaded into timer 1 when both
		//      of these conditions hold: timer 1 is STOPPED and HBLANK-IN
		//      occurs — i.e. the reload is NOT unconditional per line.
		//   2. If a value larger than the number of counts in one line is set in the
		//      timer 1 set data register, a timer 1 interrupt no longer occurs on EACH
		//      line, with the range per resolution (320 dots: 1 to 1AAH · 352: 1 to 1C6H), and
		//      if 0 is specified as the number of counts, the value becomes
		//      512.
		// The two together give the model: if T1S fits in the line, the count reaches 0
		// within that same line and it fires on ALL lines (which is the common case and the
		// earlier behavior); if T1S is larger, the count survives the next H-Blank-IN
		// —and by (1) it is not reloaded, because the timer is not stopped—, so
		// it fires once every ceil(T1S / dots per line) lines.
		//
		// Before, we fired on ALL lines without looking at T1S. With the reset value
		// (T1S=0, which is worth 512 and does NOT fit in a 320 line) we gave the game a
		// level 0xB interrupt per line that the hardware sends at half that
		// rate: up to 131 extra IRQs per frame.
		let t1s = this._readRegBE(this.scuRegs, 0x94, 4) & 0x1FF;   // T1S is 9 bits
		if(t1s === 0) t1s = 512;                                    // 0 is worth 512
		if(this.scuTimer1Stopped){ this.scuTimer1Count = t1s; this.scuTimer1Stopped = false; }

		// Dots of a COMPLETE line (with the retrace). HRESO (TVMD bits 2-0): the even ones
		// are the 320 family and the odd ones the 352 family; the 640/704 modes are the same
		// line time with the dot at half, so the count does not change.
		//? The EXCLUSIVE monitor modes are missing (424 dots: 1 to D3H · 426: 1 to D4H) because
		//? we do not model them: BUS_HRESO_WIDTH maps indices 6 and 7 to 640/704.
		const dotsPerLine = (this._readRegBE(this.vdp2Regs, 0x00, 2) & 0x1) ? 0x1C7 : POINTS_PER_LINE;
		this.scuTimer1Count -= dotsPerLine;
		if(this.scuTimer1Count > 0) return;   // does not reach 0 within this line

		// Reached 0: it stops until the next H-Blank-IN reloads it. It stops ANYWAY even if
		// the mode below blocks the interrupt, because the one that counts is the timer and bit
		// 8 only decides whether that count becomes an IRQ.
		this.scuTimer1Stopped = true;
		if((t1md & 0x100) && !matchT0) return;   // bit8=1: only on the timer 0 line
		this._scuDmaPerEvent(4);   // DMA channels armed on timer 1
		this._scuIrq(4, 0xB, 0x44);
	}

	// HBlank-IN: level 0xD, vector 0x42. The SCU fires it at the end of EVERY video
	// LINE (262 per frame on NTSC, 313 on PAL), not once per frame. It was in the
	// scuInts table but NOBODY ever fired it: it was the only video interrupt
	// that was missing (VBlank-IN/OUT and Sprite Draw End were already there).
	//
	// Games made with SGL hook it with SYS_SETUINT(0x42, handler) for
	// raster effects (per-line scroll) and, along the way, their handler increments a
	// counter; then the game SPINS waiting for that counter. Without the interrupt the
	// counter never goes up and the game hangs with a black screen.
	// Measured on Street Fighter Alpha (USA): it registers its handler 0x6010084 for
	// vector 0x42 via SYS_SETUINT (the BIOS table at 0x6000300), that handler
	// increments the word 0x60391ee, and its main loop at 0x6010270 spins until that
	// word reaches 2. It also unmasks bit 2 of the SCU IMR on purpose
	// (IMR = 0xFFFFF660), so it asks for it explicitly.
	//
	// There is no per-scanline scheduler: the line is DERIVED from the SH-2 cycles, same
	// as the HBLANK bit of TVSTAT (see _mmioRead). It is called by scspTick -once per
	// interleave chunk, which is ~1 video line- and by vblankIn/vblankOut.
	// Since 27-07-2026 scspTick runs ALWAYS (the SMPC resets the 68000, not the SCSP;
	// see advancePeripherals), so the HBlank no longer depends on the sound CPU
	// being on.
	//ok, 16-07-2026
	// Connects the system master clock. With it connected, the beam position
	// (line, HBLANK, HCNT/VCNT) comes from the SYSTEM clock and not from the cycle counter
	// of the master CPU, which is the counter of ONE chip: it resets with it, freezes with it,
	// and it dragged the video along in both situations.
	connectScheduler(plan)
	{
		this.plan = plan || null;
	}

	// SCREEN GEOMETRY, decoded from the VDP2 TVMD (180000H).
	//
	// It lives HERE, in the bus, and not in vdp2.js, because BOTH video chips need it and
	// they have to match EXACTLY: the VDP2 rasterizes the background and the VDP1 lays its
	// framebuffer on top, over the same image and pixel for pixel (drawTv in index.html).
	// If the widths do not match, the sprites come out skewed diagonally.
	//
	// It was DUPLICATED -the same table and the same clamp, copied into vdp1.js and
	// vdp2.js- and one copy does not find out when the other one changes: when paying off the
	// hi-res debt on 25-07-2026, fixing only vdp2.js left the VDP1 rasterizing at half and
	// the output ended up worse than before. A single source of truth.
	//
	// TVMD fields:
	//   HRESO (bits 2-0): 320 · 352 · 640 · 704 · 320 · 352 · 640 · 704
	//   VRESO (bits 5-4): 224 · 240 · 256 · "Not Allowed" (returns -1: do not touch)
	//   LSMD  (bits 7-6): 11B = double-density interlace, the frame has TWICE the lines
	tvGeometry()
	{
		const r = this.vdp2Regs;
		if(!r) return null;
		const tvmd = ((r[0x00] << 8) | r[0x01]) & 0xFFFF;
		const width = BUS_HRESO_WIDTH[tvmd & 0x7];
		let height = BUS_VRESO_HEIGHT[(tvmd >> 4) & 0x3];
		// Double-density: 224 -> 448. It is the mode of Sega Touring Car and Daytona CCE
		// (704x448), which without this got half the height.
		if(((tvmd >> 6) & 0x3) === 3 && height > 0) height *= 2;
		return { width: width, height: height };
	}

	// ★ VISIBLE LINES OF THE SCAN — what decides WHEN VBLANK-OUT FALLS.
	//
	// TVMD bits 5-4 (VRESO1/VRESO0): 00 = 224 lines (NTSC or PAL format TV) /
	// 01 = 240 lines (NTSC or PAL format TV) / 10 = 256 lines (PAL format TV) / 11 = not
	// allowed.
	//
	// WHY tvGeometry() CANNOT BE USED: it applies the x2 of double-density, and that x2 belongs
	// to the resolution of the IMAGE (two woven fields), not to the SCAN. The scheduler
	// counts FIELD lines (262 on NTSC, 313 on PAL), so the raw VRESO goes here.
	//
	// This used to be a CONSTANT 224 in `REGIONS` (headless.mjs / index.html) and the
	// VBlank-OUT always came from `lines - 224`. With 240 visible lines the V blank lasts 22
	// lines and not 38, so the VBlank-OUT would fall 16 lines LATE — and that is exactly the phase
	// that decides the software's races against the retrace.
	// ⚠ AND IT IS NOT JUST "fidelity for the other 490": TWO of the 10 games ask for 240 lines.
	// Measured with diag/resolution.mjs: **Virtua Cop 2,160 frames at 352x240** and **SF Alpha
	// 645**, both with VRESO=01. For them the VBlank-OUT moves from line 38 to 22, that is
	// **16 lines earlier**. (What this comment used to say —"all 10 run at 224"— had
	// been inherited from a document without measuring it, and it was false.)
	// Observable impact: NONE anyway. A/B with a control run on the spot on those two
	// games: `health.mjs` identical and `screen-activity.mjs` (20 samples over 4,000 frames)
	// identical in image, color peak and variance. The VBlank-OUT still arrives, only now
	// when it should.
	//? 256 is defined only for PAL, and what the chip does with 256 on NTSC is unspecified (it would be 6
	//? lines of V blank in a 262-line field). The value is passed as is: we do not invent a
	//? clamp the hardware is not known to do.
	//ok, 29-07-2026
	linesVisibleTv()
	{
		const r = this.vdp2Regs;
		if(!r) return 224;
		const tvmd = ((r[0x00] << 8) | r[0x01]) & 0xFFFF;
		const height = BUS_VRESO_HEIGHT[(tvmd >> 4) & 0x3];
		return height > 0 ? height : 224;   // 11B "Not Allowed": keep the default value
	}

	// THE EMULATED CODE READ SOMETHING THAT CHANGES ONLY WITH TIME.
	//
	// A loop that polls one of those registers -the HBLANK or VBLANK bit of TVSTAT, the
	// H/V counters- is NOT an idle loop, even if the CPU state stays identical
	// between iterations: it will exit only when the hardware advances. The SH-2 idle
	// detector looks at the CPU registers and whether it wrote memory, and by that measure a loop like this
	// seems to "make no progress" -> it skips it -> the CPU stops looking exactly during the window
	// in which the bit is asserted, and the loop NEVER exits.
	//
	// The SH-2 already had this mechanism for its internal counters (FRT/WDT/DIVU, see
	// _isInternalCounter). This extends it to the bus ones, which are the ones that really get
	// polled: it is how the Saturn BIOS syncs with HBLANK after CKCHG
	// ("MOV.W @(0x4,R3),R0 / TST #0x4 / BT", with IMASK at 15).
	//
	// It is marked on BOTH CPUs because the bus does not know which one is executing. All that is
	// lost is an idle-skip opportunity for the other one, which is recovered on the next
	// iteration.
	_markReadTemp()
	{
		if(this.cpuMaster) this.cpuMaster.readInternalReg = true;
		if(this.cpuSlave)  this.cpuSlave.readInternalReg = true;
	}

	// Starts a video line. With the scheduler it is called by the EV_HBLANK_IN event, which
	// falls on the EXACT cycle of the line; without it, it is still called per chunk and we have to
	// guess whether the line changed (the old path, below).
	hblankIn()
	{
		this._scuDmaPerEvent(2);   // DMA channels armed on HBlank-IN
		// A single IRQ even if several lines went by in one jump: the SCU does not
		// queue them (it only raises the IST bit), so N missed lines are worth to the
		// SH-2 the same as one. It is what happens on hardware if it does not get to service them.
		this._scuIrq(2, 0xD, 0x42);
		// The Timer 0 counter advances one line per HBlank-IN (ScuSendHBlankIN), and
		// Timer 1 is loaded with T1S at that same H-Blank-IN and starts its
		// countdown. The order matters: on hardware timer 0 fires AT
		// H-Blank-IN and timer 1 T1S dots LATER, already inside the line.
		this.scuTimer0++;
		this._scuTimer1Check(this._scuTimer0Check());
	}

	hblankTick()
	{
		// With the master clock connected this is not used: the line is triggered by the event.
		if(this.plan) return;
		if(!this.cpuMaster) return;
		const line = Math.floor(this.cpuMaster.cycles / this.cyclesPerLine);
		if(line === this.hblankLastLine) return;
		this.hblankLastLine = line;
		// A single IRQ even if several lines went by in one jump: the SCU does not
		// queue them (it only raises the IST bit), so N missed lines are worth to the
		// SH-2 the same as one. It is what happens on hardware if it does not get to service them.
		this._scuIrq(2, 0xD, 0x42);
		// The Timer 0 counter advances one line per HBlank-IN (ScuSendHBlankIN), and
		// Timer 1 is loaded with T1S at that same H-Blank-IN and starts its
		// countdown. The order matters: on hardware timer 0 fires AT
		// H-Blank-IN and timer 1 T1S dots LATER, already inside the line.
		this.scuTimer0++;
		this._scuTimer1Check(this._scuTimer0Check());
	}

	// Latches the H/V counters into HCNT/VCNT. They are NOT
	// live counters: on hardware they are a LATCH, and what triggers it is the
	// EXLTEN bit of EXTEN -with EXLTEN=0, reading EXTEN itself; with
	// EXLTEN=1, an external signal (light gun) we do not emulate-. Yabause (vdp2.c
	// case 0x002) and Mednafen (md_vdp2.c:725-730 -> LatchHV) do exactly this: a
	// game that reads VCNT without going through EXTEN sees a stale value, same as on the HW.
	//
	// As in hblankTick() and in the HBLANK bit of TVSTAT, the position is DERIVED from the
	// SH-2 cycles: there is no per-scanline scheduler.
	//   - VCNT: raw line number within the frame. Mednafen md_vdp2.c:362
	//     (LatchHV -> GetNLVCounter(), which returns VCounter untouched outside
	//     double-density interlace) and Yabause (VCNT = yabsys.LineCount).
	//
	//     ⚠ AN EARLY VERSION OF THIS BIT TABLE WAS WRONG, AND THIS CASE IS THE CORRECTED ONE.
	//     The early version gave, for "Normal Hi-Res (Non-Interlace, Single-Density
	//     Interlace)": VCT9=V8, VCT8=V7 ... VCT1=V0 and VCT0=Invalid, i.e. the line
	//     SHIFTED ONE BIT like HCNT. A later correction (1996) to the V-counter
	//     bit description replaces it with
	//     VCT9=V9, VCT8=V8 ... VCT0=V0: the line STRAIGHT, unshifted.
	//     Returning the raw line -which is what we do- is CORRECT according to the
	//     correction. Written down so nobody "fixes" it against the old table:
	//     the correction is later (1996) and explicitly replaces that row.
	//
	//     The DOUBLE-DENSITY row is NOT changed by the correction, and that one IS shifted:
	//     VCT9~VCT1 = V8~V0 and VCT0 = field (0 odd, 1 even). See _vcntOfLine().
	//   - HCNT: it IS SHIFTED ONE BIT. In normal resolution
	//     HCT9~HCT1 carry H8~H0 and HCT0 is invalid data, i.e. register = dot << 1.
	//     Mednafen copies the <<1 (md_vdp2.c:365-367). Yabause does not even implement it (it leaves a
	//     commented-out "HCNT = ?" and the register always at 0).
	//ok, 16-07-2026
	_latchHv()
	{
		// With the master clock, the beam position comes from IT: it is the real position of the
		// system and not that of one chip. Without it, the old path (cpuMaster.cycles).
		if(this.plan)
		{
			this.vcntLatch = this._vcntOfLine(this.plan.currentLine());
			this.hcntLatch = (Math.floor(this.plan.fractionOfLine() * POINTS_PER_LINE) << 1) & 0x3FF;
			return;
		}
		if(!this.cpuMaster) return;
		const c = this.cpuMaster.cycles;
		const cyclesPerFrame = this.cyclesPerLine * this.linesPerFrame;
		this.vcntLatch = this._vcntOfLine(Math.floor((c % cyclesPerFrame) / this.cyclesPerLine));
		const fracLine = (c % this.cyclesPerLine) / this.cyclesPerLine;
		this.hcntLatch = (Math.floor(fracLine * POINTS_PER_LINE) << 1) & 0x3FF;
	}

	// Builds the VCNT value from the line number, following the VCNT bit layout
	// with the 1996 correction (see above).
	//
	//   Normal / Hi-Res, non-interlaced or SINGLE-density interlaced (LSMD 0, 1 or 2):
	//       VCT9~VCT0 = V9~V0        -> the line straight (this is what the correction FIXES)
	//   Normal / Hi-Res, DOUBLE-density interlaced (LSMD=3):
	//       VCT9~VCT1 = V8~V0, VCT0 = field (0 = odd fields, 1 = even fields)
	//
	// Without this, in double-density we returned the line unshifted: a game that syncs
	// by raster there saw HALF the value the hardware gives it. It is used by the two
	// 704x448 games we have (Sega Touring Car and Daytona CCE, which run with LSMD=3).
	//ok, 28-07-2026
	_vcntOfLine(line)
	{
		// LSMD = TVMD bits 7-6. It is read from the raw bank and not from vdp2.js
		// because the bus has to answer the register even if the rasterizer has not
		// run yet in this frame.
		const lsmd = (this._readRegBE(this.vdp2Regs, 0x00, 2) >> 6) & 0x3;
		if(lsmd !== 3) return line & 0x3FF;
		//? THE FIELD BIT COMES FROM TVSTAT's ODD, which is the other face of the same datum:
		//? ODD is 0 while an even field is being scanned and 1 while an odd
		//? field is being scanned, and VCT0 is defined the other way around (0 = odd, 1 = even), so
		//? one is the negation of the other and the two registers cannot contradict each other.
		//? What is NOT modeled is that field ALTERNATING: the video timing always runs
		//? progressive (ODD fixed at 1) and what alternates the field is the RENDER
		//? (vdp2._field / vdp2Field in index.html), which is another clock. As long as the field
		//? lives in the painting path and not in the timing one, VCT0 stays fixed at 0.
		//? If it is ever needed, the piece goes in the timing —not here— and these two
		//? registers follow it on their own.
		return ((((line & 0x1FF) << 1) | ((this.tvstat & 0x0002) ? 0 : 1)) & 0x3FF);
	}

	// 64 KB page table (2048 pages cover the space up to 0x07FFFFFF).
	// Each RAM entry: {buf, mask, ro} and byte(a) = buf[a & mask]. null = MMIO.
	// Turns the chain of decoding ifs into a single array lookup.
	_buildPages()
	{
		this.pages = new Array(0x800).fill(null);
		const set = (since, until, buf, mask, ro) => {
			for(let p = (since >>> 16); p <= ((until - 1) >>> 16); p++)
				// All the fields in the literal -including backup/cram, which are turned on later
				// conditionally- so the entries have ONE stable hidden class. If they
				// were added later, the array would become polymorphic and the e.cram/e.backup reads of
				// EVERY CPU write would turn polymorphic (V8 does not monomorphize them).
				this.pages[p] = { buf: buf, mask: mask, ro: !!ro, backup: false, cram: false };
		};
		set(0x00000000, 0x00080000, this.bootRom,  0x7FFFF, true);   // Boot ROM (RO)
		set(0x00180000, 0x00200000, this.backupRam, 0xFFFF, false);  // Backup RAM
		set(0x00200000, 0x00300000, this.wramLow,  0xFFFFF, false);  // WRAM Low
		set(0x05A00000, 0x05B00000, this.soundRam, 0x7FFFF, false);  // Sound RAM
		set(0x05C00000, 0x05C80000, this.vdp1Vram, 0x7FFFF, false);  // VDP1 VRAM
		set(0x05C80000, 0x05D00000, this.vdp1Fb,   0x3FFFF, false);  // VDP1 framebuffer
		set(0x05E00000, 0x05E80000, this.vdp2Vram, 0x7FFFF, false);  // VDP2 VRAM
		set(0x05F00000, 0x05F80000, this.cram,     0xFFF,   false);  // Color RAM
		set(0x06000000, 0x08000000, this.wramHigh, 0xFFFFF, false);  // WRAM High (1MB mirror)

		// Mark the Backup RAM pages: their writes set backupDirty so
		// the orchestrator persists the backup memory in IndexedDB.
		for(let p = (0x00180000 >>> 16); p < (0x00200000 >>> 16); p++)
			if(this.pages[p]) this.pages[p].backup = true;

		// Mark the Color RAM pages: in CRMD=0 (RGB555 1024) the HW MIRRORS every
		// write to the upper 2KB (bank 0->4, 1->5, ...). Mednafen ss.c MEMW_BODY.
		for(let p = (0x05F00000 >>> 16); p < (0x05F80000 >>> 16); p++)
			if(this.pages[p]) this.pages[p].cram = true;

		// Cartridge: its ranges are installed over the A-bus (CS0 = 0x02000000, CS1 =
		// 0x04000000). Whatever is plain RAM goes in here (fast path); open bus,
		// the ID register and the tail of the backup cart are resolved by cart.readMmio() from
		// _mmioRead. The `backup` mark makes its writes set backupDirty, same
		// as the internal backup. See the "HOW TO HOOK IT UP" section at the bottom of cart.js.
		if(this.cart)
			for(const r of this.cart.pages())
			{
				set(r.since, r.until, r.buf, r.mask, r.ro);
				if(r.backup)
					for(let p = (r.since >>> 16); p <= ((r.until - 1) >>> 16); p++)
						if(this.pages[p]) this.pages[p].backup = true;
			}

		// The table was rebuilt: the SH-2s have cached the page they are fetching
		// instructions from (SH2._fetchSlow) and that buffer may have changed. Without this,
		// inserting or removing a cartridge would leave the CPU reading the old map.
		if(this.cpu && this.cpu.invalidateFetch) this.cpu.invalidateFetch();
		if(this.cpuSlave && this.cpuSlave.invalidateFetch) this.cpuSlave.invalidateFetch();
	}

	// Puts a cartridge in the A-bus slot (a Cartridge instance, or null to
	// remove it) and rebuilds the page table. index.html calls it when mounting the disc,
	// based on the product number in the header (see Cartridge.typeForSerial).
	//ok, 16-07-2026
	putCartridge(cart)
	{
		this.cart = cart || null;
		this._buildPages();
	}

	// --- Reads (big-endian) ---
	readByte(addr)
	{
		const a = addr & 0x07FFFFFF;
		const e = this.pages[a >>> 16];
		if(e) return e.buf[a & e.mask];
		return this._mmioRead(a, 1) & 0xFF;
	}

	readWord(addr)
	{
		const a = addr & 0x07FFFFFF;
		const e = this.pages[a >>> 16];
		if(e) { const b = e.buf, m = e.mask; return ((b[a & m] << 8) | b[(a + 1) & m]) >>> 0; }
		return this._mmioRead(a, 2) & 0xFFFF;
	}

	readLong(addr)
	{
		const a = addr & 0x07FFFFFF;
		const e = this.pages[a >>> 16];
		if(e) { const b = e.buf, m = e.mask; return ((b[a & m] << 24) | (b[(a + 1) & m] << 16) | (b[(a + 2) & m] << 8) | b[(a + 3) & m]) >>> 0; }
		return this._mmioRead(a, 4) >>> 0;
	}

	// --- Writes (big-endian) ---
	writeByte(addr, value)
	{
		const a = addr & 0x07FFFFFF;
		const e = this.pages[a >>> 16];
		if(e) { if(!e.ro) { const o = a & e.mask; e.buf[o] = value & 0xFF; if(e.cram && this.cramMirror) e.buf[o ^ 0x800] = value & 0xFF; if(e.backup) this.backupDirty = true; } return; }
		this._mmioWrite(a, value & 0xFF, 1);
	}

	writeWord(addr, value)
	{
		const a = addr & 0x07FFFFFF;
		const e = this.pages[a >>> 16];
		if(e) { if(!e.ro) { const b = e.buf, m = e.mask, o = a & m, o1 = (a + 1) & m; b[o] = (value >> 8) & 0xFF; b[o1] = value & 0xFF; if(e.cram && this.cramMirror) { b[o ^ 0x800] = (value >> 8) & 0xFF; b[o1 ^ 0x800] = value & 0xFF; } if(e.backup) this.backupDirty = true; } return; }
		this._mmioWrite(a, value & 0xFFFF, 2);
	}

	writeLong(addr, value)
	{
		const a = addr & 0x07FFFFFF;
		const e = this.pages[a >>> 16];
		if(e) { if(!e.ro) { const b = e.buf, m = e.mask, o = a & m, o1 = (a + 1) & m, o2 = (a + 2) & m, o3 = (a + 3) & m; b[o] = (value >>> 24) & 0xFF; b[o1] = (value >>> 16) & 0xFF; b[o2] = (value >>> 8) & 0xFF; b[o3] = value & 0xFF; if(e.cram && this.cramMirror) { b[o ^ 0x800] = (value >>> 24) & 0xFF; b[o1 ^ 0x800] = (value >>> 16) & 0xFF; b[o2 ^ 0x800] = (value >>> 8) & 0xFF; b[o3 ^ 0x800] = value & 0xFF; } if(e.backup) this.backupDirty = true; } return; }
		this._mmioWrite(a, value >>> 0, 4);
	}

	// ---------- MMIO: chip registers (stubs with logging) ----------
	_mmioRead(a, size)
	{
		// SMPC (0x00100000 - 0x0017FFFF): byte-wide registers at odd addresses.
		if(a >= 0x00100000 && a < 0x00180000)
		{
			const off = a & 0x7F;
			// PDR1/PDR2: the read re-evaluates the port bus (pad direct mode).
			if(off === 0x75 || off === 0x77) return this._readPdr(off === 0x77 ? 1 : 0);
			return this.smpc[off];
		}

		// VDP2 registers (0x05F80000 - 0x05FBFFFF).
		if(a >= 0x05F80000 && a < 0x05FC0000)
		{
			const off = a & 0x1FF;
			// EXTEN (180002H): with EXLTEN=0 the HV counter latch is triggered by
			// READING this same register. The EXLTEN bit:
			// 0 = latches when the external signal enable register is read / 1 =
			// latches through the external signal. We do not emulate the external signal
			// (light gun), so with EXLTEN=1 nothing is latched, which is correct.
			// Yabause vdp2.c case 0x002 and Mednafen md_vdp2.c:725-730 do the same.
			if(off === 0x02)
			{
				const exten = this._readRegBE(this.vdp2Regs, 0x02, 2);
				if(!(exten & 0x0200))
				{
					this._latchHv();
					//? EXLTFG (TVSTAT bit 9) on this path: Yabause sets it (case
					//? 0x002: TVSTAT |= 0x200) and Mednafen does NOT (it only sets it on the latch
					//? by external signal, md_vdp2.c:617). On hardware the bit shows
					//? whether the HV counter value was latched through external signals,
					//? which proves Mednafen right, but since we do not
					//? emulate external signals that bit would NEVER be set and a game
					//? that waits for it would hang. We follow Yabause: setting it cannot
					//? hang anyone, not setting it can.
					this.tvstat |= 0x0200;
				}
				return exten;
			}
			// TVSTAT: bit0 = PAL, bit1 = ODD, bit3 = VBLANK (set by vblankIn/vblankOut),
			// bit2 = HBLANK. We do not emulate scanline by scanline, so HBLANK is
			// DERIVED from the position within the line, based on the SH-2 cycles.
			// It is really needed: after CKCHG320 the BIOS syncs with
			// HBLANK by polling this bit ("MOV.W @(0x4,R3),R0 / TST #0x4 / BT") and if it
			// is never asserted it stays spinning forever.
			if(off === 0x04)
			{
				// TVSTAT changes ONLY with time (HBLANK/VBLANK/ODD): whoever polls it
				// is not in an idle loop even if it looks like it. See _markReadTemp.
				this._markReadTemp();
				let v = this.tvstat & ~0x0004;
				// The fraction of the line comes from the SYSTEM clock if it is connected (see
				// connectScheduler); if not, from the CPU counter, as before.
				const fr = this.plan ? this.plan.fractionOfLine()
					: (this.cpuMaster ? (this.cpuMaster.cycles % this.cyclesPerLine) / this.cyclesPerLine : -1);
				if(fr >= 0 && fr >= (this.cyclesHblank / this.cyclesPerLine))
					v |= 0x0004;
				// VBLANK IS ONLY VALID WITH THE DISPLAY ON, and with DISP=0 it ALWAYS reads 1.
				// The VBLANK bit of the screen status
				// register (TVSTAT:180004H) is only valid
				// when the DISP bit of the TV screen mode
				// register (TVMD:180000H) is 1. When the
				// DISP bit is 0, the VBLANK bit is always
				// 1.
				// It makes sense on the real hardware: with the display off there is no active scan,
				// so the chip is permanently in vertical retrace.
				// We derived VBLANK from the clock ALWAYS, meaning that with the
				// display off -which is what every game does while it
				// reconfigures the screen or loads- we made it blink when the
				// hardware holds it fixed at 1. A game that waits for "VBLANK==1" to touch
				// the VRAM with the screen off waited up to one extra frame per iteration.
				if(!(this._readRegBE(this.vdp2Regs, 0x00, 2) & 0x8000)) v |= 0x0008;
				// EXLTFG (bit 9) and EXSYFG (bit 8) are cleared ON READING the status
				// register: both clear to 0 when the screen status register
				// is read out. Yabause vdp2.c case 0x004 does
				// TVSTAT &= 0xFCFF; Mednafen md_vdp2.c:737 lowers HVIsExLatched on read.
				// The value returned is the one from BEFORE clearing.
				this.tvstat &= ~0x0300;
				return v;
			}
			// HCNT (180008H) and VCNT (18000AH): latched H/V counters, read-only
			// (16-bit read-exclusive registers). They are refreshed by
			// _latchHv() from the EXTEN read. They used to fall into the _readRegBE
			// below and ALWAYS returned 0: any "while(VCNT != N)" -raster
			// sync, per-scanline effects, RNG seed- hung forever.
			if(off === 0x08) return this.hcntLatch;
			if(off === 0x0A) return this.vcntLatch;
			return this._readRegBE(this.vdp2Regs, off, size);
		}

		// VDP1 registers (0x05D00000 - 0x05D7FFFF).
		if(a >= 0x05D00000 && a < 0x05D80000)
			return this._readRegBE(this.vdp1Regs, a & 0x1F, size);

		// SCU registers (0x05FE0000 - 0x05FEFFFF).
		if(a >= 0x05FE0000 && a < 0x05FF0000)
		{
			const offScu = a & 0xFF;
			// SCU DSP: the Program Control Port (0x80) and the Data RAM Data Port (0x8C)
			// are answered by the DSP, not by the register RAM. The BIOS reads 0x80 in a loop
			// waiting for the EX bit to go off when the microprogram ends.
			if(this.scuDsp && size === 4 && (offScu === 0x80 || offScu === 0x8C))
				return this.scuDsp.readRegister(offScu);
			return this._readRegBE(this.scuRegs, offScu, size);
		}

		// CD block (0x05890000 - 0x0589FFFF): HIRQ + command/response registers.
		if(a >= 0x05890000 && a < 0x058A0000)
		{
			// The block does NOT answer across the whole 64 KB: see _cdDecodes. What falls
			// outside is the A-Bus CARTRIDGE area, and without a cartridge nobody answers.
			if(!Bus._cdDecodes(a)) return 0;
			const off = a & 0x3F;
			if(off === 0x08) return this.cdHirq;              // HIRQ status
			if(off === 0x0C) return this.cdHirqMask;          // HIRQ mask
			// With a disc: the first 4 bytes are the data register (DTR), and reading
			// CR4 (0x24) marks the response as read (enables the periodic report).
			if(this.cd)
			{
				if(off < 0x04 && size >= 2) return this._cdReadDtr(size);
				if(off === 0x24) this.cd.resultsRead = true;
			}
			return this._readRegBE(this.cdRegs, off, size);
		}

		// SCSP (0x05B00000 - 0x05BFFFFF): sound registers (shared with the 68k).
		//? THIS ACCESS IS FREE AND SHOULD NOT BE, but it is NOT GOING TO BE MODELED, and this time with
		//? the number. On hardware the SH-2 eats a wait on every access: the SCSP
		//? outputs a '1' on the ready signal (MCRDYN) going to the main CPU, causing a wait
		//? that lasts until the LSI's internal processing is finished. For this
		//? reason, continuous reads and writes that cause many waits should be
		//? avoided. The length comes from how the 128 memory cycles per sample are shared out,
		//? where the generator and the DSP have priority over the main CPU.
		//? MEASURED with diag/scsp-sh2-accesses.mjs over 1,200 frames: the SH-2 touches the
		//? SCSP registers **0.8 times per frame** (Rally, Daytona and Virtua Cop) and 1.2 times
		//? SF Alpha. Even charging a whole memory cycle per access (~4.8 SH-2 cycles)
		//? that is 4-6 cycles out of the 447,443 an NTSC frame lasts: **0.001 % of the frame**.
		//? The one that talks to the SCSP is the 68000, not the SH-2, and the 68000 has its own
		//? priority. That is: implementing it touches the SH-2 hot path and changes the timing
		//? of every game to move a thousandth of a percent. It is not done.
		if(a >= 0x05B00000 && a < 0x05C00000)
			return this.scspRead(a & 0xFFF, size);

		// CD block data register seen from the A-bus (0x05818000): it is the
		// same DTR as 0x05890000 and it is the one the SCU DMA uses to bring the
		// sectors down to RAM. Without a disc it falls to the unknown-MMIO log, as before.
		if(a >= 0x05818000 && a < 0x05818004 && this.cd && size >= 2)
			return this._cdReadDtr(size);

		// Cartridge slot (A-bus CS0 + CS1): open bus, the ID register
		// (0x04FFFFFF) and the tail of the backup cart. Whatever is plain RAM was already resolved by the
		// page table and never gets here. See "HOW TO HOOK IT UP" in cart.js.
		if(this.cart && a >= 0x02000000 && a < 0x05000000)
			return this.cart.readMmio(a, size);

		// A-Bus, MINIT/SINIT: not modeled yet -> they return 0.
		this._registerUnknown("R", a, size);
		return 0;
	}

	_mmioWrite(a, value, size)
	{
		// Input capture of the SH-2s (0x21000000-0x21FFFFFF from the CPU, which the bus already
		// masked to 27 bits -> 0x01000000-0x01FFFFFF): the DOORBELL between the two CPUs.
		// A WORD write to the LOW half raises the FRT ICF on the SLAVE, and to the
		// HIGH half on the MASTER. Who it rings for is decided by the ADDRESS, not by who
		// writes: Yabause maps SSH2InputCaptureWriteWord/MSH2InputCaptureWriteWord into
		// the memory map of BOTH SH-2s (memory.c, pages 0x100-0x17F and
		// 0x180-0x1FF). Only the WORD write fires it; byte and long do nothing.
		// Without this the slave keeps POLLING ITS FTCSR FOREVER: it boots,
		// registers itself and never receives a single command.
		if(a >= 0x01000000 && a < 0x02000000)
		{
			if(size === 2)
			{
				const dest = (a < 0x01800000) ? this.cpuSlave : this.cpuMaster;
				if(dest) dest.inputCapture();
				// If the doorbell is for the SLAVE, run it RIGHT NOW until it goes back to
				// idle (or a cap). On the real HW both CPUs run IN PARALLEL and the
				// slave reacts to the ICF within microseconds; with the per-chunk interleave
				// the master ran its whole batch before yielding a single step, and the
				// DOUBLE doorbell protocol of the Cinepak player (doorbell 1 = "resync
				// with the ring reset", doorbell 2 = "take the command") merged the two
				// ICFs into a single wakeup: the slave looked at the already rewritten ring, its
				// old consumer could match the new producer and it went to sleep with
				// the command unread (deadlock of the Sonic 3D Blast video, f1525; the
				// Rally hang at 0x6070d42 is the same library). The burst ends
				// on its own: the FTCSR wait loop is a pure spin and the idle detector
				// flags it in ~3 iterations. The cap bounds a long task (Cinepak decoding):
				// whatever does not finish here continues in its normal chunk, as on the HW, where the
				// decode also takes longer than the doorbell. _doorbellInBurst avoids reentry if
				// a doorbell is issued FROM the burst.
				// SMALL cap on purpose: the burst exists so the slave OBSERVES the state
				// between the two doorbells (unblock the wakeup + resync the ring,
				// ~50-100 instructions), NOT so it runs the whole task. With a
				// big cap the slave sprints with the master FROZEN -on the real HW they advance
				// together- and it can consume beyond what the master produced (measured:
				// with cap 20000 the decoder read pointers not yet written and jumped to
				// empty memory). The long task continues in its normal chunk, interleaved.
				if(dest === this.cpuSlave && dest && this.smpcSlaveOn && !this._doorbellInBurst)
				{
					this._doorbellInBurst = true;
					const s = this.cpuSlave;
					s.idle = false;
					for(let i = 0; i < 400 && !s.halted && !s.idle; i++) s.step();
					this._doorbellInBurst = false;
				}
			}
			return;
		}

		if(a >= 0x00100000 && a < 0x00180000)
		{
			const off = a & 0x7F;
			this.smpc[off] = value & 0xFF;

			// IREG0 (0x01): after an INTBACK that returned status with peripherals
			// pending, the BIOS writes "continue" here (or "break" with bit6). On
			// continue we deliver PHASE 2: the pad overwrites OREG0+, with the SR
			// sequenced (bit7 = data ready, PDL). With the faithful status this does not
			// divert the boot, and the BIOS also reads the pad -> it navigates.
			if(off === 0x01 && this.intbackPeriphPending)
			{
				// INTBACK SESSION with peripherals: each CONTINUE (toggle
				// of IREG0 bit 7) re-delivers FRESH peripheral data — that is
				// how games poll the pad every frame (the Virtua Cop logo lives
				// on this). BREAK (bit 6) ends the session. It used to be one-shot: the
				// first continue delivered and the following ones NEVER answered (no
				// IRQ) — with the faithful SR the game entered the protocol and hung there.
				if(value & 0x40) { this.intbackPeriphPending = false; this.intbackBit7 = -1; return; }
				// CONTINUE IS A TOGGLE OF BIT 7, not just any write to IREG0.
				// Within a session, the host asks for the next peripheral
				// by INVERTING bit 7 of IREG0, and the SMPC answers when it sees the CHANGE.
				// There was an `if(true)` here: it delivered -and fired the System Manager-
				// on EVERY write. Measured on 26-07-2026 with X-Men COTA: 3,390 System
				// Manager IRQs in 2 s (28 per frame) against the 120 (1 per frame) of SF Alpha,
				// which works. The game retried its handshake forever and did not boot.
				const bit7 = (value >> 7) & 1;
				const change = (this.intbackBit7 < 0) || (bit7 !== this.intbackBit7);
				this.intbackBit7 = bit7;
				if(change)                           // continue -> deliver peripherals
				{
					this._intbackPeripheral();
					// SR FAITHFUL to the hardware: bit7 PDL (first batch of peripheral
					// data), bit6 FIXED at 1, bit5 NPE=0 (no more data left),
					// bits 3-0 port modes (00 = 15-byte mode). The previous heuristic
					// ("bit7 only if a button is pressed, otherwise SR=0") made a game
					// that parses the SR for real DISCARD the report: the
					// Virtua Cop logo polls via INTBACK and with SR=0 START never arrived.
					// Bit 4 (RESB/RESD) is NOT reported on purpose: the VC boot
					// polls the SR with TST #0x10 and expects to see it at ZERO (measured in
					// diag/vc-spin-boot.mjs, spin 0x60011f2); reporting it with RESENAB
					// disabled hung it.
					//
					// THE REST OF THE SR IS VERIFIED AGAINST THE GAME (25-07-2026). There used
					// to be a //? here saying a hardware reference was missing to model it
					// right; it was resolved the project's way, by measuring, because Virtua
					// Cop does not get past its "PRESS START BUTTON" and this was the obvious suspect.
					// The two tests, with diag/smpc-intback-protocol.mjs and diag/vc-start.mjs:
					//   - bit 6 at 0 (SR = 0x80 instead of 0xC0): changes NOTHING. It is not the one
					//     that makes the game discard the report.
					//   - bit 5 at 0 in the status phase (0x40 instead of 0x60): BREAKS, and then
					//     some: START stops registering ALSO on the previous screen,
					//     where it worked. So bit 5 is NPE ("peripherals left to
					//     deliver") and the game needs it at 1 to send the CONTINUE.
					// The model below is the one the game accepts. **The SR is not the cause of the
					// Virtua Cop bug**: see PENDING.md, the live lead is the condition at
					// 0x0600A530 that can skip the OREG copy.
					this.smpc[0x61] = 0xC0;
					// SF=1 (busy): the response and the IRQ are given by smpcTick().
					// irq:true because this IS the INTBACK (its peripheral phase), which is the
					// only class D command and the only one that asks for an interrupt. See smpcTick.
					this.smpc[0x63] = 0x01;
					this.smpcPending = { remaining: SMPC_LATENCY_CMD, irq: true };
				}
				return;
			}

			// COMREG (0x1F): execute the command and fire the System Manager IRQ.
			if(off === 0x1F)
			{
				const cmd = value & 0xFF;
				// OREG31 = COMMAND ECHO. It was NEVER written, and it is the only
				// result returned by the "category C" commands (the ones that have no
				// other output parameters): without this, for SETSMEM/SSHON/
				// NMIREQ/RESENAB/... the SMPC answered absolutely nothing.
				// On hardware, the result parameter OREG31 is set by the SMPC when
				// command processing BEGINS: the command code is output to OREG31, and
				// together with the status flag (SF) it tells which command is being
				// executed (SF=1) / which command finished (SF=0). That is
				// why it goes UP HERE and not at the end: the hardware sets it at the START.
				// It holds for ALL commands (every one of them outputs to
				// OREG31). Mednafen smpc.c:1258-1260 has the same condition:
				//     if(ExecutingCommand < 0x20) OREG[0x1F] = ExecutingCommand;
				// and Yabause closes every command with SmpcRegs->OREG[31] = <cmd>.
				// INTBACK is the partial exception: its peripheral data overwrites the
				// OREGs from top to bottom and can end up covering OREG31 (the command
				// code in OREG31 may be overwritten by peripheral
				// data); with a single pad we do not come anywhere close, so it stays.
				if(cmd < 0x20) this.smpc[0x5F] = cmd;
				switch(cmd)
				{
					case 0x00: break;                            // MSHON (master SH-2 on): already running
					// SSHON: the SMPC turns on the second SH-2. With a real BIOS, Yabause
					// (yabause.c: YabauseStartSlave) only does SH2PowerOn(SSH2): it loads PC and
					// SP from the VBR vector table, which the console reset left at 0.
					// That is, the slave starts at the SAME vector as the master
					// (0x20000200): it is the BIOS that branches off on its own when it sees the MASTER bit
					// of BCR1 (see the SH2 constructor) and starts polling the mailbox
					// 0x06000240 waiting for the master's magic "2RDY" to jump to the
					// slave code at 0x06000600.
					case 0x02:
						this.smpcSlaveOn = true;
						if(this.cpuSlave) this.cpuSlave.turnOn();
						break;
					// SSHOFF: turns the slave off. Yabause (YabauseStopSlave) gives it a full
					// reset, so the next SSHON finds it with VBR at 0 and
					// it boots again from the reset vector.
					case 0x03:
						this.smpcSlaveOn = false;
						if(this.cpuSlave) this.cpuSlave.reset();
						break;
					// CKCHG320 / CKCHG352: system clock change (320 or 352 pixels
					// wide). The SMPC changes the clock and sends an NMI to the MASTER SH-2.
					// The BIOS counts on it: it asks for CKCHG and parks itself in
					// "SLEEP; BRA self" with IMASK at 15 waiting for the NMI. Without this the
					// CPU sleeps forever, cpu.cycles stays STUCK and the emulator
					// looks hung (it does not crash: it simply does not advance anymore).
					// WATCH THE ORDER: 0EH is the 352 one and 0FH the 320 one, not the other way around.
					// The command codes: clock change 352 mode = CKCHG352 =
					// 0EH and clock change 320 mode = CKCHG320 = 0FH. Confirmed by the
					// two implementations: Yabause smpc.c (case 0xE -> SmpcCKCHG352,
					// case 0xF -> SmpcCKCHG320) and Mednafen smpc.c:78-79 (CMD_CKCHG352 =
					// 0x0E, CMD_CKCHG320 = 0x0F). They were swapped.
					case 0x0E:                                    // CKCHG352 -> dotsel 1
					case 0x0F:                                    // CKCHG320 -> dotsel 0
						this.smpcDotsel = (cmd === 0x0E) ? 1 : 0;
						//? The hardware CKCHG also TURNS OFF the slave SH-2 and the 68k and
						//? resets SCSP/VDP1/VDP2/SCU before the NMI, and waits a few
						//? vblanks (Mednafen smpc.c:1291-1325: SlaveSH2Pending=-1,
						//? TurnSoundCPUOff, SOUND_Reset, VDP1_Reset, VDP2_Reset,
						//? SCU_Reset; Yabause does the same). Not implemented: the
						//? CKCHG320 is ON THE BOOT PATH that works today, resetting
						//? VDP1/VDP2/SCSP touches other agents' files and there is no way
						//? to verify the boot without the browser. Changing it blindly could
						//? break what works. //!wip, 16-07-2026
						if(this.cpuMaster) this.cpuMaster.requestNmi();
						break;
					//? SYSRES (0x0D) is a reset of the WHOLE system (Yabause does
					//? YabauseResetNoLoad), not an NMI. Since reset() lives in index.html
					//? we would need a flag like reset68k to ask the loop for it. No
					//? tested game sends it, so it is left unimplemented rather than
					//? implemented wrong. //!wip, 16-07-2026
					case 0x17:                                    // SETSMEM: write the SMEM
						// The SMPC's 4 bytes of battery-backed memory come from IREG0-3.
						// SETSMEM = 17H, input IREG 0-3, output OREG 31: the SMPC
						// provides 4 bytes of battery-backed memory (SMEM), and this
						// command sets data into SMEM.
						// It is "category C": its ONLY result is the echo in OREG31,
						// which we already wrote above. The IREGs live at 0x01,0x03,0x05,0x07
						// (byte-wide at odd addresses).
						// Yabause smpc.c SmpcSETSMEM: for(i=0;i<4;i++) SMEM[i] = IREG[i];
						// Mednafen smpc.c:1641-1642: for(i<4) SaveMem[i] = IREG[i];
						// On hardware the 4 bytes are ALWAYS written together
						// (SETSMEM sets the 4 bytes at the same time).
						for(let i = 0; i < 4; i++)
							this.smpcSmem[i] = this.smpc[0x01 + i * 2];
						break;
					case 0x18:                                    // NMIREQ: NMI on request
						if(this.cpuMaster) this.cpuMaster.requestNmi();
						break;
					case 0x19: this.smpcResetHab = true;  break;  // RESENAB: enables reset
					case 0x1A: this.smpcResetHab = false; break;  // RESDISA: disables it
					case 0x06: this.smpcSoundOn = true; this.reset68k = true; break;   // SNDON: starts the 68k
					case 0x07: this.smpcSoundOn = false; break;                       // SNDOFF
					case 0x08: this.smpcCdOn = true;     break;   // CDON
					case 0x09: this.smpcCdOn = false;    break;   // CDOFF
					case 0x16:                                    // SETTIME: set the RTC
					{
						// The BIOS writes the date/time in BCD into IREG0-6 (same layout
						// as the status: year[2], (weekday<<4)|month, day, hour, min, sec).
						// It writes DIRECTLY to the console's emulated clock (rtcMs), just like
						// the hardware: the SMPC keeps the time in its RTC and from there it ticks
						// on its own. Nothing to do with the host's time.
						const fromBcd = (b) => (((b >> 4) & 0xF) * 10) + (b & 0xF);
						const ir = (n) => this.smpc[0x01 + n * 2];       // IREG[n]
						const year = fromBcd(ir(0)) * 100 + fromBcd(ir(1));  // 0x20,0x26 -> 2026
						const month  = (ir(2) & 0x0F) - 1;                 // month 1-12 -> 0-11 (JS)
						const day  = fromBcd(ir(3));
						const hour = fromBcd(ir(4));
						const min  = fromBcd(ir(5));
						const sec  = fromBcd(ir(6));
						const ms = Date.UTC(year, month, day, hour, min, sec);
						if(!isNaN(ms)) { this.rtcMs = ms; this.rtcRemainderMs = 0; }
						break;
					}
					case 0x10:                                    // INTBACK
					{
						const ireg1 = this.smpc[0x03];
						if(this.smpc[0x01] & 0x0F)    // asks for the SMPC status (phase 1)
						{
							// Status faithful to Mednafen: real RTC + area code + hardware
							// flags in OREG0-0xF (see _intbackStatus). The RTC goes in the
							// STATUS PHASE. The peripherals (phase 2) overwrite OREG0+.
							this._intbackStatus();
							if(ireg1 & 0x08)                      // also asks for peripherals
							{
								// bit6 fixed at 1 + NPE (peripherals left to deliver).
								this.smpc[0x61] = 0x60;
								this.intbackPeriphPending = true;
								this.intbackBit7 = -1;
							}
							else this.smpc[0x61] = 0x40;
						}
						else if(ireg1 & 0x08)         // peripherals only (single phase)
						{
							this._intbackPeripheral();
							// Faithful SR: PDL + fixed bit6 + RESD (see phase 2 above).
							this.smpc[0x61] = 0xC0;
							// Opens the session: the CONTINUEs via IREG0 re-deliver fresh data.
							this.intbackPeriphPending = true;
						}
						break;
					}
					// A COMMAND WE DO NOT IMPLEMENT IS NOT SWALLOWED SILENTLY (29-07-2026).
					// The switch had no default, so any command outside the list
					// was accepted, answered SF=0 and did nothing — no error and no log, which
					// is the blind spot the MMIO radar exists to eliminate.
					// Checked against the complete SMPC command list (16
					// commands): we have 15. The only one missing is SYSRES (0x0D), and it is
					// documented further up with its //?. The 10 games do not ask for it, but if
					// one asked for it today we would not find out.
					//? ★ TWO COMMANDS THAT NO SOURCE WE HAVE DOCUMENTS: 0x0A and 0x0B.
					//? Measured with diag/smpc-commands.mjs over the 10 games, 2,000 frames:
					//? they are issued by **Sega Rally and Daytona CCE** (which are the same engine),
					//? 2 times each and at boot, from `0x0603300e`, `0x06033062`
					//? (high WRAM) and `0x00280fd2` (low WRAM) — that is, the game, not the BIOS.
					//? They are NOT among the 16 documented commands nor in the
					//? third-party sources that were consulted. The suspicion, BECAUSE OF THE GAME THAT ISSUES THEM and
					//? because those same games probe the communications port via SCI, is
					//? that they are NetLink on/off — but **it is an unverified suspicion and nothing
					//? is implemented based on it**.
					//? What we do today (fall to the default: lower SF, do nothing, and tell
					//? the radar) breaks nothing: both games work. If the source ever turns up,
					//? the piece goes here.
					default:
						if(this.logging) this._registerUnknown("W", 0x2010001F, 1);
						break;
				}
				// THE SMPC COMMAND TAKES TIME. This used to lower SF to 0 and fire the
				// interrupt WITHIN the same COMREG write, that is with zero
				// latency: the game wrote the command and SF was already 0 when it went to
				// look. Whoever polls SF expecting to see the busy->ready cycle
				// NEVER saw it. Measured on 26-07-2026 with X-Men COTA: SF is the ONLY
				// SMPC register it reads (3,390 times in 2 s, no OREG), and that is why
				// it retried its INTBACK 28 times per frame against 0.5 for SF Alpha,
				// which works. Same problem the CD block had and same solution: the
				// command is accepted, marked busy, and answered once its time has passed.
				// And the INTERRUPT is only requested by INTBACK (0x10), which is the only
				// class D command. The rest signal by LOWERING SF and nothing else: see
				// the full explanation in smpcTick(), which is where it is decided.
				// The TIME is per command (see SMPC_LATENCY). INTBACK
				// keeps the default and its //?: the published figure is inconsistent with what was
				// measured.
				this.smpc[0x63] = 0x01;              // SF = busy
				this.smpcPending = {
					remaining: SMPC_LATENCY[cmd] || SMPC_LATENCY_CMD,
					irq: cmd === 0x10
				};
			}
			return;
		}
		if(a >= 0x05F80000 && a < 0x05FC0000)
		{
			this._writeRegBE(this.vdp2Regs, a & 0x1FF, value, size);
			// CRMD (RAMCTL 0x0E, bits 13-12): mode 0 (RGB555 1024) mirrors the Color RAM.
			this.cramMirror = ((((this.vdp2Regs[0x0E] << 8) | this.vdp2Regs[0x0F]) >> 12) & 0x3) === 0;
			return;
		}
		if(a >= 0x05D00000 && a < 0x05D80000)
		{
			const off = a & 0x1F;
			this._writeRegBE(this.vdp1Regs, off, value, size);
			// FBCR hook (offset 0x02): the bank change is a TRIGGER, not a
			// level. Replicates Vdp1WriteWord case 0x2 from vdp1.c:
			//    FBCR = val;
			//    if((FBCR & 3) == 3)      manualchange = 1;
			//    else if((FBCR & 3) == 2) manualerase  = 1;
			// Without this vdp1.js samples the level, and with FBCR=3 held (what
			// the BIOS leaves at boot) it swaps banks on EVERY frame instead of
			// just once: the wrong bank is shown and the animation ghosts.
			// It fires on any write that covers word 0x02 (the HW only
			// accepts words, but this way an aligned long at 0x00 is not lost either).
			if(off < 0x04 && off + size > 0x02)
			{
				const fbcr = (((this.vdp1Regs[0x02] << 8) | this.vdp1Regs[0x03]) & 0x3);
				if(fbcr === 3)      this.vdp1ChangeManual  = true;
				else if(fbcr === 2) this.vdp1EraseManual = true;
			}
			// TVMR hook (offset 0x00), for VBE: THIRD VDP1 register that is
			// TRIGGER and not level, for the same reason as the two above. VBE
			// (TVMR bit 3) asks for "erase with V blank": the game sets it, WAITS for the
			// VDP1 to finish -polling EDSR- and clears it; the erase happens in the V blank
			// that goes by during that wait.
			// HERE THE HARDWARE PROVES YABAUSE WRONG. vdp1.js._buildEraseVBlank() copies
			// Vdp2VBlankOUT (vdp2.c): "if((FBCR & 2) && (TVMR & 8)) manualerase = 1",
			// sampling the LEVEL of TVMR. It works for Yabause because it runs that point
			// in the real V blank, interleaved with the CPU; we close the whole frame
			// in one go, so by the time we sample it the pulse HAS ALREADY PASSED.
			// Measured on SF Alpha (27-07-2026), its sequence every frame is:
			//    TVMR=0x8 (VBE=1) -> 6 reads of EDSR (the wait) -> TVMR=0x0 -> FBCR=0x3 -> PTMR=0x1
			// VBE lasts as long as the wait and drops BEFORE FBCR, so the sampling
			// at the end finds it at 0: the erase was NEVER requested (measured: 20 plots,
			// 20 swaps and 0 erases every 40 frames) and every frame was drawn on top of the
			// previous one. That is the sprite trail you see in the game.
			// The condition is the same as _buildEraseVBlank's (FCM set): the only thing
			// that changes is WHEN it is checked, which is what the hardware defines.
			if(off < 0x02 && off + size > 0x00)
			{
				if((this.vdp1Regs[0x01] & 0x8) &&
				   (((this.vdp1Regs[0x02] << 8) | this.vdp1Regs[0x03]) & 0x2))
					this.vdp1EraseManual = true;
			}
			// PTMR hook (offset 0x04): starting the draw with PTM=01B is also a
			// TRIGGER, not a level. On hardware, when the plot trigger mode
			// bits are set to 01B, drawing begins when the register is written, and also
			// when the plot trigger bits are rewritten from 00B or 10B to 01B, drawing
			// becomes valid at that point. Replicates Vdp1WriteWord case 0x4 from vdp1.c
			// (COPR = 0; PTMR = val; if(val == 1) Vdp1Draw()) and md_vdp1.c:1226.
			// BIT 0 is checked and not "== 1" (Yabause) to also cover the forbidden 11B,
			// like Mednafen does (if(value & 0x1) StartDrawing()).
			// Without this offset 0x04 was not hooked and writing PTMR only deposited the
			// bytes: vdp1.js sampled the LEVEL once per frame, so a game that
			// writes PTMR=1 and then PTMR=0 lost the draw forever (framebuffer
			// empty, no Draw End, and the game that waits for it spinning).
			if(off < 0x06 && off + size > 0x04)
			{
				if(((this.vdp1Regs[0x04] << 8) | this.vdp1Regs[0x05]) & 0x1)
				{
					this.vdp1PlotRequest = true;
					this._writeRegBE(this.vdp1Regs, 0x14, 0, 2);   // COPR <- 0
				}
			}
			return;
		}
		if(a >= 0x05FE0000 && a < 0x05FF0000)
		{
			const off = a & 0xFF;
			// IMR (0xA0): on writing it, deliver the LATCHED IRQs that are left
			// unmasked. Key: the BIOS masks, fires the command, and
			// unmasks to receive the completion interrupt (pad INTBACK).
			if(off >= 0xA0 && off < 0xA4 && size === 4)
			{
				this._writeRegBE(this.scuRegs, 0xA0, value, 4);
				const newImr = value >>> 0;
				if(this.cpuMaster && this.scuPending)
					for(const it of this.scuInts)
					{
						const b = 1 << it.bit;
						// The A-Bus ones (bit 16+) are unmasked by bit 15 of IMS (see _scuIrq).
						const bMask = 1 << ((it.bit >= 16) ? 15 : it.bit);
						if(!(newImr & bMask) && (this.scuPending & b))
						{
							this.cpuMaster.requestInterrupt(it.level, it.vec);
							this.scuPending &= ~b;   // delivered, no longer pending
						}
					}
				return;
			}
			// IST (0xA4): interrupt status register. The hardware clears it
			// with ZEROS (IST &= value, same as the CD block HIRQ): the value written
			// is the mask of bits to KEEP. The BIOS writes 0 to clear it entirely
			// before waiting for the next VBlank.
			if(off >= 0xA4 && off < 0xA8 && size === 4)
			{
				const ist = this._readRegBE(this.scuRegs, 0xA4, 4) >>> 0;
				this._writeRegBE(this.scuRegs, 0xA4, (ist & value) >>> 0, 4);
				return;
			}
			// SCU DSP (0x80-0x8C): control, microprogram load and data RAM.
			// When the Program Control Port is written with the EX bit started, the DSP
			// has to run: the BIOS sits in a busy-wait on EX and does not advance
			// until the program ends (END instruction). It is executed right away,
			// same as the SCU DMAs (see _scuDma): HLE, without cycle timing.
			if(this.scuDsp && size === 4 && off >= 0x80 && off <= 0x8C)
			{
				this.scuDsp.writeRegister(off, value);
				if(off === 0x80 && this.scuDsp.executing)
				{
					// Step cap: a microprogram without END cannot hang the browser.
					this.scuDsp.execute(0x10000);
					if(this.scuDsp.executing && this.logging)
						this._registerUnknown("W", 0x05FE0080, 4);   // did not finish: to the radar
				}
				return;
			}
			this._writeRegBE(this.scuRegs, off, value, size);
			// DMA: if the write touched a channel enable register (DxEN: 0x10,
			// 0x30, 0x50) and enable (bit8) + go (bit0) are left set, fire.
			let channelDma = -1;
			if(off >= 0x10 && off <= 0x13)      channelDma = 0;
			else if(off >= 0x30 && off <= 0x33) channelDma = 1;
			else if(off >= 0x50 && off <= 0x53) channelDma = 2;
			if(channelDma >= 0)
			{
				const inBase = 0x10 + channelDma * 0x20;
				const en = this._readRegBE(this.scuRegs, inBase, 4) >>> 0;
				if((en & 0x100) && (en & 0x1))          // enable + go active
				{
					const md = this._readRegBE(this.scuRegs, inBase + 4, 4) >>> 0;
					// start factor 7 = trigger by register (immediate); the rest = by event.
					if((md & 0x7) === 0x7) this._scuDma(channelDma);
					else                   this.scuDmaBuilt[channelDma] = true;
				}
			}
			return;
		}
		// CD block: writing HIRQ clears bits (1=clear); writing CR4 "sends" a command.
		if(a >= 0x05890000 && a < 0x058A0000)
		{
			// Outside the block's decode it is cartridge area: without a cartridge the write
			// is lost (see _cdDecodes). Without this guard the Netlink wrote inside
			// CR1-CR4 and, at reg 9 (0x25895025 -> off 0x24), would have fired a
			// CD block command nobody asked for.
			if(!Bus._cdDecodes(a)) return;
			const off = a & 0x3F;
			// HIRQ: the hardware clears with ZEROS (HIRQ &= val in Yabause cs2.c and in
			// Mednafen cdb.cpp). The value written is the mask of bits to KEEP,
			// not the bits to clear: the BIOS writes 0xFFBE to lower CMOK (bit0) and
			// ESEL (bit6) before sending a command and leave the rest intact.
			if(off === 0x08) { this.cdHirq &= (value & 0xFFFF); this._cdUpdateIrq(); return; }
			if(off === 0x0C) { this.cdHirqMask = value & 0xFFFF; this._cdUpdateIrq(); return; }
			// With a Put Sector Data in progress, the first 4 bytes are the data
			// register (DTR) and what the host writes goes to the buffer, not to cdRegs. Mirror of
			// the DTR read in _mmioRead.
			if(off < 0x04 && size >= 2 && this.cd && this.cd.dt.active && this.cd.dt.writing)
			{
				this._cdWriteDtr(value, size);
				return;
			}
			this._writeRegBE(this.cdRegs, off, value, size);
			// Writing CR4 REQUESTS the command; the response arrives when the CD block finishes
			// processing it (see _cdCommandRequest and the timing model above).
			if(off === 0x24) this._cdCommandRequest();
			return;
		}
		// SCSP (0x05B00000 - 0x05BFFFFF): sound registers.
		if(a >= 0x05B00000 && a < 0x05C00000)
		{
			this.scspWrite(a & 0xFFF, value, size);
			return;
		}
		// The CD block DTR seen from the A-bus (0x05818000), write side: it is the
		// same register as 0x05890000 and it is where the SCU DMA UPLOADS the sectors
		// of a Put Sector Data. Mirror of the read path in _mmioRead.
		if(a >= 0x05818000 && a < 0x05818004 && size >= 2 &&
		   this.cd && this.cd.dt.active && this.cd.dt.writing)
		{
			this._cdWriteDtr(value, size);
			return;
		}
		// Cartridge slot: mirror of the read path. `dirty` is set by the
		// cartridge when it writes its backup, and from it comes the backupDirty that makes the
		// orchestrator persist it.
		if(this.cart && a >= 0x02000000 && a < 0x05000000)
		{
			this.cart.writeMmio(a, value, size);
			if(this.cart.dirty) this.backupDirty = true;
			return;
		}
		this._registerUnknown("W", a, size);
	}

	// Reads a big-endian register from a buffer according to the access size.
	_readRegBE(buf, off, size)
	{
		if(size === 1) return buf[off];
		if(size === 2) return ((buf[off] << 8) | buf[off + 1]) >>> 0;
		return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
	}

	_writeRegBE(buf, off, value, size)
	{
		if(size === 1) { buf[off] = value & 0xFF; return; }
		if(size === 2) { buf[off] = (value >> 8) & 0xFF; buf[off + 1] = value & 0xFF; return; }
		buf[off]     = (value >>> 24) & 0xFF;
		buf[off + 1] = (value >>> 16) & 0xFF;
		buf[off + 2] = (value >>> 8) & 0xFF;
		buf[off + 3] = value & 0xFF;
	}

	// Command request: the host just wrote CR4. The CD block LOWERS CMOK -it is
	// busy- and answers when it finishes (cdTick resolves it). See the timing model
	// of the CD block at the beginning of the file.
	//
	// If there was already one pending it is resolved first: the firmware serves one at a time, and a
	// game that steps on a command without waiting for CMOK is breaking the protocol — but the
	// hardware still finishes what it was doing before accepting the new one.
	_cdCommandRequest()
	{
		// One at a time: if another one was unanswered, the firmware finishes it before accepting
		// this one. It runs with ITS parameters, not with the ones just written.
		if(this.cdCmdPending >= 0) this._cdResolveCommand();
		// THE REQUEST IS CAPTURED HERE. The SH-1 reads CR1-CR4 at the moment it accepts the
		// command; after that the host can write whatever it wants, it no longer changes what was
		// requested. Without this capture, a command arriving while another one was pending
		// ran the old one READING THE NEW ONE'S REGISTERS.
		this.cdCmdCr = [ this._readRegBE(this.cdRegs, 0x18, 2), this._readRegBE(this.cdRegs, 0x1C, 2),
		                 this._readRegBE(this.cdRegs, 0x20, 2), this._readRegBE(this.cdRegs, 0x24, 2) ];
		this.cdHirq &= ~CD_HIRQ_CMOK;   // busy
		this._cdUpdateIrq();
		this.cdCmdPending = CD_CMD_LATENCY;
	}

	// Runs the pending command with the parameters captured when it was accepted.
	_cdResolveCommand()
	{
		const g = this.cdCmdCr;
		this.cdCmdPending = -1;
		if(!g) return;
		this.cdCmdCr = null;
		// Put the request back into the CRs: _cdCommand() reads them from there, and the response overwrites them.
		this._writeRegBE(this.cdRegs, 0x18, g[0], 2);
		this._writeRegBE(this.cdRegs, 0x1C, g[1], 2);
		this._writeRegBE(this.cdRegs, 0x20, g[2], 2);
		this._writeRegBE(this.cdRegs, 0x24, g[3], 2);
		this._cdCommand();
	}

	// Records an access to unmodeled hardware (for the "what is missing" radar).
	//
	// The normal case is NOT a different address each time: it is the SAME one repeated thousands of
	// times, because a game that polls hardware we do not have polls it in a loop. Measured
	// on 25-07-2026 with diag/radar-cost.mjs: Sega Rally writes 3,943 times per frame
	// to 0x0582503d — 2,760,003 accesses in 700 frames over 2 distinct addresses in
	// total. Building the key ("W:0x0582503d": a toString(16) + a padStart + two
	// concatenations, three new objects) and touching the Map on each one cost
	// 0.58 ms/frame. And it was invisible: this lives behind this.logging, which in index.html
	// is TRUE and in headless.mjs FALSE, so the browser paid for it in full and
	// no headless probe measured it.
	//
	// Now the repetition only increments a counter; the key is built when the
	// address CHANGES, or when someone reads the radar (the mmioUnknown getter flushes first).
	// The radar loses nothing: the total per address is the same.
	_registerUnknown(type, a, size)
	{
		if(!this.logging) return;
		a = a >>> 0;
		if(a === this._descAddr && type === this._descType){ this._descN++; return; }
		this._descDump();
		this._descAddr = a; this._descType = type; this._descN = 1;
	}

	// Moves the accumulator into the Map. Called by the address change and by the getter below.
	_descDump()
	{
		if(this._descN === 0) return;
		const key = this._descType + ":0x" + this._descAddr.toString(16).padStart(8, "0");
		this._mmioUnknown.set(key, (this._mmioUnknown.get(key) || 0) + this._descN);
		this._descN = 0;
	}

	// The radar, up to date. It is a getter so whoever reads it (the index.html panel, the
	// diag/ probes) does not have to know an accumulator exists: it is still a Map
	// with .entries() / .size / .clear() as always.
	get mmioUnknown()
	{
		this._descDump();
		return this._mmioUnknown;
	}
}

// In Node the class is exported; in the browser it stays as a global via <script>.
if(typeof module !== "undefined" && module.exports)
	module.exports = { Bus };
