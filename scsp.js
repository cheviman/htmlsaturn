/**
 *    Name:         scsp.js
 *    Description:  SCSP (Saturn Custom Sound Processor) audio engine. Emulates
 *                  the 32 PCM synthesis slots: phase accumulator (pitch from
 *                  OCT/FNS), the 4 loop modes (LPCTL: no loop / normal /
 *                  reverse / alternating), envelope generator (EG attack/
 *                  decay1/decay2/release with rate tables), 8/16-bit PCM reads
 *                  from sound RAM, key-on/key-off, total level (TL), LFO
 *                  (vibrato + tremolo), FM modulation between slots, the effects
 *                  DSP with its ring buffer, the external digital input (CDDA),
 *                  panning and mixing into a stereo buffer. Advances per sample at 44100 Hz.
 *
 *                  Port of the "classic" engine (slot_t) of Yabause scsp.c (GPL v2+):
 *                  (c) 2004 Stephane Dallongeville, (c) 2004-2007 Theo Berkau,
 *                  (c) 2006 Guillaume Duhamel, (c) 2012 Chris Lord. The original
 *                  field/algorithm names are kept.
 *
 *                  The effects DSP (MPRO microprogram + ring buffer) is
 *                  ported from Mednafen scsp.inc (GPL v2+): (c) 2015-2021 Mednafen
 *                  Team, because Yabause's DSP lives separately in scspdsp.c. The
 *                  hardware register names (MPRO, TEMP, MEMS, COEF, MADRS, MIXS,
 *                  EFREG) and the semantics of their fields are kept.
 *
 *                  Deliberate differences from Yabause, all of them following the
 *                  real hardware:
 *                   - Loop modes 2 (reverse) and 3 (alternating/ping-pong) are
 *                     really emulated. Yabause's classic engine only looks at
 *                     "lpctl == 0" vs "!= 0" and plays both as a normal
 *                     forward loop. See _limitPhase().
 *                   - The envelope (EG) is an ATTENUATION IN dB, like the hardware,
 *                     and not a linear amplitude ramp. See EG_DB_LSB.
 *                   - The tremolo (ALFO) is ADDED to that dB attenuation, instead
 *                     of being subtracted from a linear amplitude.
 *                   - SBCTL, EGHOLD, LPSLNK, STWINH, SDIR, SSCTL=noise and the sound
 *                     stack (SOUS) are implemented; Yabause decodes them and
 *                     does not use them (or does not even decode them).
 *    Version:      0.4.0
 *    Created:      15-07-2026
 *    Modified:     17-07-2026
 *    Author:       Sebastian Toyos
 */

//!wip, 16-07-2026 - Slot core + LFO + effects DSP + FM + CDDA.
// The 68000 read of TEMP ($C00), MEMS ($E00) and MIXS ($E80) IS DONE (28-07-2026):
// bus.js resolves it at the moment of the read (_scspRefreshDsp), like CA and the
// MIDI flags, and not by mirroring per block -they are 176 entries, ~45,000 writes per frame
// for something that none of the 10 games reads-. That way it costs zero when nobody asks.
//? Writing that state FROM the 68000 is still not supported: those registers are
//? R/W, but what the DSP does if a temporary is overwritten mid-microprogram is unknown.
//? Pending: the SHAPE of the EG attack curve. Both endpoints are already fixed by the
//? hardware (it starts at 3FFH and ends at 000H, see the TABLE_EG_ATT note), but the
//? equation is not published: the exponential over the attenuation from the Yamaha
//? family is used. The decay/sustain/release is the hardware's logarithmic one.

// ---- SCSP fixed-point constants (see scsp.c: SCSP_FREQ_LB, SCSP_ENV_*) ----
const SCSP_FREQ     = 44100;                    // SCSP output frequency
const SCSP_FREQ_LB  = 10;                       // fractional bits of the phase counter
const SCSP_ENV_LB   = 10;                       // fractional bits of the envelope counter
const SCSP_ENV_HB   = 10;                       // integer bits of the envelope counter
const SCSP_ENV_LEN  = 1 << SCSP_ENV_HB;         // 1024 entries per table half
const SCSP_ENV_MASK = SCSP_ENV_LEN - 1;         // 0x3FF
const SCSP_ENV_AS   = 0;                                        // attack start
const SCSP_ENV_DS   = SCSP_ENV_LEN << SCSP_ENV_LB;             // decay start (0x100000)
const SCSP_ENV_AE   = SCSP_ENV_DS - 1;                         // attack end (0xFFFFF)
const SCSP_ENV_DE   = ((2 * SCSP_ENV_LEN) << SCSP_ENV_LB) - 1; // decay end/slot off (0x1FFFFF)
const SCSP_ATTACK_R = 8 * 44100;                // attack time constant
const SCSP_DECAY_R  = 12 * SCSP_ATTACK_R;       // decay time constant
const SCSP_RAM_MASK = 0x7FFFF;                  // 512 KB of sound RAM

// LFO counter: 10 integer bits (index into the wave tables) + 10 fractional.
const SCSP_LFO_HB   = 10;
const SCSP_LFO_LB   = 10;
const SCSP_LFO_LEN  = 1 << SCSP_LFO_HB;         // 1024 entries per wave table
const SCSP_LFO_MASK = SCSP_LFO_LEN - 1;         // 0x3FF

// Envelope generator (EG) phases.
const PHASE_ATTACK  = 0;
const PHASE_DECAY   = 1;
const PHASE_SUSTAIN = 2;
const PHASE_RELEASE = 3;

// Code of the active envelope step (equivalent to Yabause's slot->einc pointer,
// which points to einca/eincd/eincs/eincr; 0 = none / envelope stopped).
const EINC_NULL    = 0;
const EINC_ATTACK  = 1;
const EINC_DECAY   = 2;
const EINC_SUSTAIN = 3;
const EINC_RELEASE = 4;

// Next envelope event (equivalent to the slot->enxt function pointer).
const NEXT_NULL    = 0;
const NEXT_ATTACK  = 1;
const NEXT_DECAY   = 2;
const NEXT_SUSTAIN = 3;
const NEXT_RELEASE = 4;

// "Muted channel" value for the level/pan shifts. It is the same
// sentinel Yabause uses (31 = infinite attenuation, not added to the mix).
const MUTE_LEVEL = 31;

// ---- DSP microprogram flags (one per instruction bit) ----
// The DSP instruction is 64 bits; these flags are the single bits, and the
// fields (IRA/IWA/EWA/MASA/CRA/TWA/TRA/YSEL) are stored separately, already decoded.
const DSPF_NXADDR = 1 << 0;    // adds 1 to the RAM address
const DSPF_ADRGB  = 1 << 1;    // adds ADRS_REG to the RAM address
const DSPF_NOFL   = 1 << 2;    // RAM access without floating-point format
const DSPF_BSEL   = 1 << 3;    // adder input B: SFT_REG instead of TEMP
const DSPF_ZERO   = 1 << 4;    // forces adder input B to 0
const DSPF_NEGB   = 1 << 5;    // negates adder input B
const DSPF_YRL    = 1 << 6;    // latches INPUTS into Y_REG
const DSPF_SHFT0  = 1 << 7;    // shifter control (bit 0)
const DSPF_SHFT1  = 1 << 8;    // shifter control (bit 1)
const DSPF_FRCL   = 1 << 9;    // latches the shifter output into FRC_REG
const DSPF_ADRL   = 1 << 10;   // latches into ADRS_REG
const DSPF_EWT    = 1 << 11;   // writes EFREG[EWA]
const DSPF_MRT    = 1 << 12;   // reads from sound RAM
const DSPF_MWT    = 1 << 13;   // writes to sound RAM
const DSPF_TABLE  = 1 << 14;   // absolute address (does not add MDEC_CT nor wrap to the ring)
const DSPF_IWT    = 1 << 15;   // writes MEMS[IWA] with what was read from RAM
const DSPF_XSEL   = 1 << 16;   // multiplier input X: INPUTS instead of TEMP
const DSPF_TWT    = 1 << 17;   // writes TEMP[TWA]

// State that a step consumes from the previous step.
const DSPR_SFT   = 1 << 0;     // consumes SFT_REG
// State that a step produces (for the dead-step analysis).
const DSPW_SFT   = 1 << 0;
const DSPW_FRC   = 1 << 1;
const DSPW_Y     = 1 << 2;
const DSPW_ADRS  = 1 << 3;
const DSPW_TEMP  = 1 << 4;
const DSPW_MEMS  = 1 << 5;
const DSPW_EFREG = 1 << 6;
const DSPW_RAM   = 1 << 7;

// ---- Global tables (built only once; they do not depend on the instance) ----

// dB per LSB of the EG attenuation. The hardware EG is NOT an amplitude
// ramp: it is a 10-bit ATTENUATION in dB (000H = unattenuated, 3FFH = maximum).
// The EG represents the change in sound attenuation over time, and 3FFH is the
// maximum attenuation.
// The scale comes from three sources that agree with each other:
//   - TL is 8 bits, bit7 = -48 dB ... bit0 = -0.4 dB, that is
//     FFH = -95.7 dB. TL enters the SAME attenuation chain as the EG but
//     multiplied by 4 (tl_att = tl*4 + slot_att), so 1 LSB of the EG is 1/4
//     of a TL LSB = 0.375/4 = 0.09375 dB.
//   - ALFOS=7 mixes 24 dB into the EG, and the whole range of
//     ALFO[7:0] is 256 LSB -> 24/256 = 0.09375 dB per LSB.
//   - The volume chain is implemented as (128 - att[5:0])/128 >> (att>>6),
//     that is 6 dB every 64 LSB -> 6/64 = 0.09375 dB per LSB.
const EG_DB_LSB = 0.09375;

// Envelope curve -> EG ATTENUATION (0..3FFH). It is indexed with
// (ecnt >> SCSP_ENV_LB): the first half is the attack and the second the
// decay/sustain/release, where the index IS the EG value.
const TABLE_EG_ATT = new Int32Array(SCSP_ENV_LEN * 2);
// EG attenuation (0..3FFH) -> linear gain (0..1023). It is the table that makes
// the envelope logarithmic.
const TABLE_EG_GAIN = new Int32Array(SCSP_ENV_LEN);
// Envelope steps per rate for attack and for decay/sustain/release.
const ATTACK_TABLE = new Int32Array(0x40 + 0x20);   // 96 entries
const DECAY_TABLE  = new Int32Array(0x40 + 0x20);   // 96 entries
// Attenuation per Total Level (256 steps of 0.3762 dB).
const TL_TABLE = new Int32Array(256);

// LFO waves. The "_E" ones modulate the envelope (tremolo) and are always positive
// (they are subtracted from the envelope); the "_F" ones modulate the frequency (vibrato) and are
// centered on zero (they add and subtract phase).
const TABLE_LFO_SAWT_E = new Int32Array(SCSP_LFO_LEN);
const TABLE_LFO_SQUA_E = new Int32Array(SCSP_LFO_LEN);
const TABLE_LFO_TRI_E  = new Int32Array(SCSP_LFO_LEN);
const TABLE_LFO_NOI_E  = new Int32Array(SCSP_LFO_LEN);
const TABLE_LFO_SAWT_F = new Int32Array(SCSP_LFO_LEN);
const TABLE_LFO_SQUA_F = new Int32Array(SCSP_LFO_LEN);
const TABLE_LFO_TRI_F  = new Int32Array(SCSP_LFO_LEN);
const TABLE_LFO_NOI_F  = new Int32Array(SCSP_LFO_LEN);
// LFO counter step for each LFOF value (0-31).
const TABLE_LFO_STEP   = new Int32Array(32);
// Wave selection by PLFOWS/ALFOWS: 0=sawtooth 1=square 2=triangle 3=noise.
const LFO_WAVES_F = [TABLE_LFO_SAWT_F, TABLE_LFO_SQUA_F, TABLE_LFO_TRI_F, TABLE_LFO_NOI_F];
const LFO_WAVES_E = [TABLE_LFO_SAWT_E, TABLE_LFO_SQUA_E, TABLE_LFO_TRI_E, TABLE_LFO_NOI_E];

(function buildTables()
{
	// Linear gain for each EG attenuation value. THIS is the table that
	// makes the envelope logarithmic (see the EG_DB_LSB note). With 3FFH the
	// gain is 0 = silence: the "maximum attenuation state". When the EG is in the
	// maximum attenuation state (3FFH), the sound source does not access
	// memory.
	for(let i = 0; i < SCSP_ENV_LEN; i++)
		TABLE_EG_GAIN[i] = Math.round(Math.pow(10, (i * -EG_DB_LSB) / 20) * SCSP_ENV_MASK);

	for(let i = 0; i < SCSP_ENV_LEN; i++)
	{
		// ATTACK CURVE: exponential over the ATTENUATION, starting at 3FFH.
		//
		// What IS fixed on the hardware, and the previous curve did not honor:
		//  - The attack goes FROM 3FFH TOWARD 000H. Key-off proves it from the other side:
		//    on a KEY-OFF during the attack the EG value does not reach 000H; with
		//    KEY_OFF as a turning point it INCREASES back to 3FFH. So 3FFH is the
		//    endpoint it comes from and the one it returns to.
		//    The change in attenuation volume uses that same axis for all four phases,
		//    000H at the top and 3FFH at the bottom.
		//  - With AR = 00H the change volume (level attenuation volume) is minimum (0):
		//    the envelope does NOT advance. Combined with the above, a slot with
		//    AR = 0 stays at 3FFH, that is MUTE.
		//
		// The old curve (x^7 over the amplitude, from Yabause's classic engine) started
		// at 6/1023 = -44.6 dB instead of -95.9 dB. That broke both things: the attack did not
		// start at the endpoint fixed above, and a slot with AR = 0 sounded
		// quiet instead of staying mute. The very comment that was here had it
		// noted as a "known side effect"; it was a symptom of the curve, not a
		// separate detail.
		//
		//? The SHAPE is still unknown: AR only sets the change volume of the EG in the
		//? attack state, and the equation is not public. The exponential is taken
		//? over the attenuation, which is the Yamaha family's (the SCSP is the YMF292) and
		//? the one Yabause's new engine uses (yab_scsp.c:690), tested against hardware:
		//? attenuation -= (attenuation >> rate) + 1. Here its continuous form is tabulated
		//? -exp(-k) normalized to close at 000H- because the engine indexes the curve by
		//? the EG counter and does not iterate it. Marked as a "-ism" until it can be measured
		//? against a real Saturn; what is NO longer a -ism are the two endpoints, which are
		//? fixed by the hardware.
		// The exponential is NORMALIZED so it closes exactly at the two endpoints the
		// hardware fixes: 3FFH on the first step and 000H on the last. Without normalizing, the end
		// landed at 1 LSB of attenuation instead of 0 -inaudible, but it broke the continuity
		// with the decay, which starts at 000H, and the key-off during the attack, which reindexes
		// through this same table-.
		const K_ATTACK = Math.log(SCSP_ENV_LEN);
		const E_END = Math.exp(-K_ATTACK);
		const e = Math.exp(-K_ATTACK * i / SCSP_ENV_MASK);
		TABLE_EG_ATT[i] = Math.max(0, Math.min(SCSP_ENV_MASK,
			Math.round(SCSP_ENV_MASK * (e - E_END) / (1 - E_END))));

		// Decay/sustain/release: the index IS the EG value. The rest of the engine
		// already took it for granted -s.sl compares (ecnt - ENV_DS) >> ENV_LB against
		// DL<<5, which is exactly the "upper 5 bits of the attenuation level" the hardware
		// uses-, but the table mapped it to a LINEAR amplitude ramp.
		TABLE_EG_ATT[i + SCSP_ENV_LEN] = i;
	}

	// Envelope steps per rate. The index is (rate << 1) + key rate scale, so
	// entries 0-3 are only reached with rate = 1: rate = 0 is caught by
	// _refreshEinc with an explicit 0, which is the "amount of change minimum (0)"
	// the hardware reserves for AR/D1R/D2R/RR = 00H. Yabause sets all 4 to zero, and with
	// that an RR=01H with a low key rate scale leaves the envelope FROZEN: the note
	// NEVER dies. The hardware does not reserve "no attenuation" for 01H (only for
	// 00H), so entries 0-3 carry the step the formula gives them:
	// mantissa 1.00/1.25/1.50/1.75 with the next exponent down (2^-1),
	// that is half the step of entries 4-7.
	for(let i = 0; i < 4; i++)
	{
		const x = (1.0 + (i * 0.25)) * 0.5 * (SCSP_ENV_LEN << SCSP_ENV_LB);
		ATTACK_TABLE[i] = Math.max(1, Math.round(x / SCSP_ATTACK_R));
		DECAY_TABLE[i]  = Math.max(1, Math.round(x / SCSP_DECAY_R));
	}

	for(let i = 0; i < 60; i++)
	{
		let x = 1.0 + ((i & 3) * 0.25);                 // bits 0-1: x1.00, x1.25, x1.50, x1.75
		x *= (1 << (i >> 2));                           // bits 2-5: shift (x2^0 .. x2^14)
		x *= (SCSP_ENV_LEN << SCSP_ENV_LB);             // scaled to the envelope counter's range

		ATTACK_TABLE[i + 4] = Math.round(x / SCSP_ATTACK_R);
		DECAY_TABLE[i + 4]  = Math.round(x / SCSP_DECAY_R);

		if(ATTACK_TABLE[i + 4] === 0) ATTACK_TABLE[i + 4] = 1;
		if(DECAY_TABLE[i + 4]  === 0) DECAY_TABLE[i + 4]  = 1;
	}

	ATTACK_TABLE[63] = SCSP_ENV_AE;
	DECAY_TABLE[61]  = DECAY_TABLE[60];
	DECAY_TABLE[62]  = DECAY_TABLE[60];
	DECAY_TABLE[63]  = DECAY_TABLE[60];

	for(let i = 64; i < 96; i++)
	{
		ATTACK_TABLE[i] = ATTACK_TABLE[63];
		DECAY_TABLE[i]  = DECAY_TABLE[63];
	}

	for(let i = 0; i < 256; i++)
		TL_TABLE[i] = Math.round(Math.pow(10, (i * -0.3762) / 20) * 1024.0);

	// LFO counter step: LFOF picks one of 32 frequencies. The table is
	// filled backwards (31-i) because LFOF=0 is the slowest.
	for(let i = 0, j = 0; i < 32; i++)
	{
		j += 1 << (i >> 2);
		const freq = (SCSP_FREQ / 256.0) / j;                   // LFO frequency in Hz
		TABLE_LFO_STEP[31 - i] = Math.round(freq * (SCSP_LFO_LEN / SCSP_FREQ) * (1 << SCSP_LFO_LB));
	}

	// Deterministic PRNG (xorshift32) for the LFO noise tables. Yabause
	// uses rand(), which depends on the libc and is not reproducible; with a fixed seed
	// the engine always gives the same output and the tests are stable.
	let seed = 0x12345678;
	const random = function()
	{
		seed ^= seed << 13;  seed >>>= 0;
		seed ^= seed >>> 17;
		seed ^= seed << 5;   seed >>>= 0;
		return seed;
	};

	const HALF = SCSP_LFO_LEN / 2;
	for(let i = 0; i < SCSP_LFO_LEN; i++)
	{
		// --- Envelope modulation (tremolo): values 0..0x3FF, subtracted ---
		TABLE_LFO_SAWT_E[i] = SCSP_LFO_MASK - i;
		TABLE_LFO_SQUA_E[i] = (i < HALF) ? SCSP_LFO_MASK : 0;
		TABLE_LFO_TRI_E[i]  = (i < HALF) ? (SCSP_LFO_MASK - (i * 2)) : ((i - HALF) * 2);
		TABLE_LFO_NOI_E[i]  = random() & SCSP_LFO_MASK;

		// --- Frequency modulation (vibrato): signed values ---
		TABLE_LFO_SAWT_F[(i + 512) & SCSP_LFO_MASK] = i - HALF;
		TABLE_LFO_SQUA_F[i] = (i < HALF) ? (SCSP_LFO_MASK - HALF - 128) : (0 - HALF + 128);
		if(i < HALF)
			TABLE_LFO_TRI_F[(i + 768) & SCSP_LFO_MASK] = (i * 2) - HALF;
		else
			TABLE_LFO_TRI_F[(i + 768) & SCSP_LFO_MASK] = (SCSP_LFO_MASK - ((i - HALF) * 2)) - HALF + 1;
		TABLE_LFO_NOI_F[i] = TABLE_LFO_NOI_E[i] - HALF;
	}
})();


// --------------------------------------------------------------------------
// SEND LEVEL + PAN -> LINEAR GAIN.
//
// This used to be resolved with SHIFTS, and that is why the pan had half the
// resolution: the pan goes in 3 dB steps with 4 bits (01H = -3, 02H = -6 ... 0EH =
// -42, 0FH = -inf) and a shift can only move in 6 dB steps, so the odd values
// ended up 3 dB too loud (01H sounded unattenuated instead of -3 dB). The send level does fit
// exactly in shifts -0 dB to -36 dB in steps of 6- but it shares the computation with the pan.
//
// The two tables, together:
//   SDL (DISDL or EFSDL, 3 bits): 0 -> "-inf (not sent)" ; 1-7 -> -36, -30, -24, -18, -12,
//                                -6, 0 dB, that is 6 x (7 - SDL).
//   PAN (DIPAN or EFPAN, 5 bits): bit 4 picks the side and bits 3:0 the amount.
//                                MSB = 0 moves the image to the RIGHT (attenuates the left);
//                                MSB = 1 moves it to the LEFT (attenuates the right).
//                                Amount 0-14 -> 3 dB per step; 15 (0FH) -> -inf.
//                                That is why 00H and 10H are both the unattenuated center.
//
// The gain is returned as a 15-bit integer (32768 = 0 dB) in `output`, which is an array
// of 2 reused so as not to allocate per register write. It is 15 and not 16 bits so that the most
// common case -unattenuated- comes out EXACT: the consumer does Math.imul(sample16, gain) >> 15, and
// with gain = 32768 that returns the sample intact. Besides, it cannot overflow: the worst product
// is 32768 x 32768 = 2^30, comfortably inside the signed integer.
const DIRECT_GAIN = new Int32Array(2);

function _gainPan(output, sdl, pan)
{
	if(!sdl){ output[0] = output[1] = 0; return; }      // "-inf (not sent)"

	const dbSend = 6 * (7 - sdl);
	const count = pan & 0x0F;
	const aLaLeft = (pan & 0x10) !== 0;

	// dB of each channel: the one that is NOT attenuated keeps the bare send level.
	let dbLeft = dbSend, dbRight = dbSend;
	if(count === 0x0F)
	{
		if(aLaLeft) dbRight = Infinity;
		else             dbLeft = Infinity;
	}
	else if(aLaLeft) dbRight += 3 * count;
	else                  dbLeft += 3 * count;

	output[0] = dbLeft === Infinity ? 0 : Math.round(32768 * Math.pow(10, -dbLeft / 20));
	output[1] = dbRight === Infinity ? 0 : Math.round(32768 * Math.pow(10, -dbRight / 20));
}


// --------------------------------------------------------------------------
// DSP floating-point format: the sound RAM stores the samples of the effects ring buffer
// in a 16-bit format with a 4-bit exponent + an 11-bit mantissa plus sign
// (unless the instruction has NOFL, which treats them as raw integers).
// --------------------------------------------------------------------------

// Converts a DSP float (16 bits) to the internal signed 24-bit integer.
function dspFloatAInteger(v)
{
	const signXor = ((v & 0x8000) << 16) >> 1;
	const exp = (v >> 11) & 0xF;
	let r = v & 0x7FF;
	if(exp < 12) r |= 0x800;         // implicit bit, except in the high exponents
	r <<= (11 + 8);
	r ^= signXor;                   // negatives come in inverted complement
	r >>= (8 + (exp < 11 ? exp : 11));
	return r & 0xFFFFFF;
}

// Converts the internal 24-bit integer to the RAM's 16-bit float.
function integerADspFloat(v)
{
	const v8 = v << 8;
	const signXor = v8 >> 31;
	// Leading zero count -> exponent. The OR with (1<<19) caps exp at 12.
	const exp = Math.clz32(((v8 ^ signXor) << 1) | (1 << 19));
	const offset = exp - (exp === 12 ? 1 : 0);
	let r = v8 >> (19 - offset);
	r &= 0x87FF;
	r |= exp << 11;
	return r & 0xFFFF;
}


class ScspEngine
{
	// The engine operates on bus.scspRam (big-endian registers) and bus.soundRam (PCM).
	constructor(bus)
	{
		this.bus = bus;
		this.reg = bus.scspRam;      // SCSP registers (0x000-0xFFF)
		this.ram = bus.soundRam;     // sound RAM (512 KB) the samples are read from

		// 32 synthesis slots.
		this.slots = new Array(32);
		for(let i = 0; i < 32; i++) this.slots[i] = this._newSlot(i);

		// Stereo ring buffer (Float32 in [-1,1]) for Web Audio to consume.
		this.CAP = 16384;
		this.bufLeft = new Float32Array(this.CAP);
		this.bufRight = new Float32Array(this.CAP);
		this.writePos = 0;             // write position
		this.posRead = 0;             // read position
		this.count = 0;           // samples available

		// --- Sound stack (SCSP STACK): output of the slots from the last two
		// generations, which is where FM modulation (mdx/mdy) reads from. Indices
		// 0-31 are the previous generation and 32-63 the current one. It is an Int16Array because
		// the hardware stores the slot output as s16 (Yabause's sound_stack).
		this.soundStack = new Int16Array(64);
		// Output of each slot in the current sample, to dump it into the stack only
		// once all 32 are done (that way all of them read the same previous generation).
		this.outputSlot = new Int16Array(32);

		// --- Effects DSP state ---
		this.dspTemp  = new Int32Array(0x80);   // work buffer (24 bits)
		this.dspMems  = new Int32Array(0x20);   // RAM read stack (24 bits)
		this.dspCoef  = new Int32Array(64);     // multiplier coefficients (13 bits)
		this.dspMadrs = new Int32Array(32);     // RAM addresses (16 bits)
		this.dspMixs  = new Int32Array(0x10);   // input mix stack (20 bits)
		this.dspEfreg = new Int32Array(0x10);   // effects output (16 bits)
		this.dspExts  = new Int32Array(2);      // external digital input (CDDA)

		// Decoded microprogram (128 steps), field by field so that the loop
		// does not have to take apart the 64-bit instruction on every sample.
		this.mpIra   = new Uint8Array(128);
		this.mpIwa   = new Uint8Array(128);
		this.mpEwa   = new Uint8Array(128);
		this.mpMasa  = new Uint8Array(128);
		this.mpCra   = new Uint8Array(128);
		this.mpTwa   = new Uint8Array(128);
		this.mpTra   = new Uint8Array(128);
		this.mpYsel  = new Uint8Array(128);
		this.mpFlags = new Int32Array(128);
		this.mpReads   = new Uint8Array(128);     // state it consumes from the previous step
		this.mpWrites = new Uint8Array(128);   // state it produces
		this.mpAlive  = new Uint8Array(128);     // 0 = dead step, skipped

		this.dspDirty = true;        // forces the first decode
		this.activeDsp = false;      // a microprogram is loaded
		this.dspOptimize = true;    // skip dead steps (see _analyzeStepsAlive)

		// CDDA buffer: 150 sectors of 2352 bytes, same as Yabause.
		this.cddaBuf = new Uint8Array(2 * 75 * 2352);
		this.cddaNextEnt = 0;        // next write offset
		this.cddaRemaining = 0;       // CDDA bytes pending playback

		this.reset();
	}

	// Structure of a slot (equivalent to Yabause's slot_t). Fields derived from the
	// registers + internal synthesis state.
	_newSlot(num)
	{
		return {
			num: num,
			// --- derived from registers ---
			pcm8b: 0, lpctl: 0, ssctl: 0, key: 0,
			sbctl: 0,                         // source bit inversion ($00 b10:9)
			eghold: 0, lpslnk: 0,             // attack hold ($08 b5) / loop start link ($0A b14)
			stwinh: 0, sdir: 0,               // inhibit SOUS ($0C b9) / direct output ($0C b8)
			sa: 0, lsa: 0, lea: 0,            // addresses (lsa/lea in fixed point <<FREQ_LB)
			fsft: 7, finc: 0,                 // frequency shift and phase step
			ar: 0, dr: 0, sr: 0, rr: 0,       // attack/decay1/decay2(sustain)/release rates
			krs: 0, sl: SCSP_ENV_DS, tl: 1024,// key rate scale, sustain level, total level
			// 16-bit linear gains (65535 = 0 dB, 0 = mute). See _gainPan().
			directGainLeft: 0, directGainRight: 0,       // DISDL/DIPAN: direct output of the slot to the DAC
			gainEfLeft: 0, gainEfRight: 0,         // EFSDL/EFPAN: level of EFREG/EXTS to the DAC
			isel: 0, imxl: MUTE_LEVEL,        // destination and send level to the DSP (MIXS)
			mdl: 0, mdx: 0, mdy: 0,           // FM modulation: level and source slots X/Y
			// --- LFO ---
			lfocnt: 0, lfoinc: 0,             // LFO counter and step
			lfofmw: 0, lfoemw: 0,             // frequency / envelope waveform
			lfofms: MUTE_LEVEL,               // frequency modulation sensitivity
			lfoems: MUTE_LEVEL,               // envelope modulation sensitivity
			// --- envelope steps per phase (recomputed by _refreshEinc) ---
			einca: 0, eincd: 0, eincs: 0, eincr: 0,
			// --- internal synthesis state ---
			fcnt: 0,                          // phase counter
			dirRev: 0,                        // read direction: 0 = forward, 1 = in reverse
			noise: 0x2A5F | (num << 16),      // noise oscillator state (SSCTL=01B)
			ecnt: SCSP_ENV_DE,                // envelope counter (DE = slot off)
			ecmp: SCSP_ENV_DE + 1,            // threshold to move to the next phase
			ecurp: PHASE_RELEASE,              // current EG phase
			einc: EINC_NULL,                  // which envelope step is active
			nextEvent: NEXT_NULL,            // which transition happens on reaching ecmp
			env: 0                            // envelope multiplier (last sample)
		};
	}

	// Resets all slots to "off" (envelope at DE, muted output) and all
	// the DSP / CDDA state.
	reset()
	{
		for(const s of this.slots)
		{
			s.pcm8b = 0; s.lpctl = 0; s.ssctl = 0; s.key = 0;
			s.sbctl = 0; s.eghold = 0; s.lpslnk = 0; s.stwinh = 0; s.sdir = 0;
			s.noise = 0x2A5F | (s.num << 16);
			s.sa = 0; s.lsa = 0; s.lea = 0;
			s.fsft = 7; s.finc = 0;
			s.ar = 0; s.dr = 0; s.sr = 0; s.rr = 0;
			s.krs = 0; s.sl = SCSP_ENV_DS; s.tl = 1024;
			s.directGainLeft = 0; s.directGainRight = 0;
			s.gainEfLeft = 0; s.gainEfRight = 0;
			s.isel = 0; s.imxl = MUTE_LEVEL;
			s.mdl = 0; s.mdx = 0; s.mdy = 0;
			s.lfocnt = 0; s.lfoinc = 0; s.lfofmw = 0; s.lfoemw = 0;
			//? Yabause does memset(slot,0) and leaves lfofms/lfoems at 0, which makes
			//? the dispatcher pick the LFO path and then shift by
			//? (lfofms-7) = -7 (undefined behavior in C). We start at
			//? MUTE_LEVEL (LFO off), which is the sane state and also the one that lets
			//? $12 be decoded with value 0.
			s.lfofms = MUTE_LEVEL; s.lfoems = MUTE_LEVEL;
			s.einca = 0; s.eincd = 0; s.eincs = 0; s.eincr = 0;
			s.fcnt = 0; s.dirRev = 0; s.ecnt = SCSP_ENV_DE; s.ecmp = SCSP_ENV_DE + 1;
			s.ecurp = PHASE_RELEASE; s.einc = EINC_NULL; s.nextEvent = NEXT_NULL;
			s.env = 0;
		}
		this.writePos = 0; this.posRead = 0; this.count = 0;

		this.soundStack.fill(0);
		this.outputSlot.fill(0);

		this.dspTemp.fill(0); this.dspMems.fill(0); this.dspCoef.fill(0);
		this.dspMadrs.fill(0); this.dspMixs.fill(0); this.dspEfreg.fill(0);
		this.dspExts.fill(0);
		this.dspInputs = 0;          // last input read (24 bits)
		this.dspSftReg = 0;          // adder accumulator (26 bits)
		this.dspFrcReg = 0;          // latched fraction (13 bits)
		this.dspYReg = 0;            // latched Y multiplicand (24 bits)
		this.dspAdrsReg = 0;         // latched address offset (12 bits)
		this.dspMdecCt = 0;          // ring buffer down-counter
		this.dspRwAddr = 0;          // pending RAM address (in words)
		this.dspReadsPending = 0;         // 1 = read pending, 2 = pending with NOFL
		this.dspWritePending = false;     // write pending
		this.dspWriteValue = 0;
		this.dspReadsValue = 0;
		this.dspRbl = 0; this.dspRbp = 0;
		this.dspDirty = true;
		this.activeDsp = false;

		this.cddaNextEnt = 0; this.cddaRemaining = 0;
	}

	// Reads a big-endian word from the SCSP registers.
	_word(off)
	{
		return ((this.reg[off] << 8) | this.reg[off + 1]) & 0xFFFF;
	}

	// --------------------------------------------------------------------------
	// Decoding of a slot's registers -> slot fields.
	// Reproduces Yabause's scsp_slot_set_w but reading directly from the register
	// bank (big-endian). It does NOT touch the live EG state (ecnt/ecmp/ecurp/
	// einc/nextEvent/fcnt): those only change on key-on/off and by advancing.
	// --------------------------------------------------------------------------
	_decodeSlot(num)
	{
		const s = this.slots[num];
		const base = num * 0x20;

		// $00: KYONEX/KYONB/SBCTL/SSCTL/LPCTL/PCM8B/SA(4 high bits)
		// Layout: -,-,-,KX(12),KB(11),SBCTL(10:9),SSCTL(8:7),LPCTL(6:5),
		// 8B(4),SA[19:16](3:0).
		const w0 = this._word(base + 0x00);
		s.key   = (w0 >> 11) & 1;
		s.sbctl = (w0 >> 9) & 3;
		s.ssctl = (w0 >> 7) & 3;
		s.lpctl = (w0 >> 5) & 3;
		s.pcm8b = (w0 >> 4) & 1;
		s.sa    = (((w0 & 0xF) << 16) | this._word(base + 0x02)) & SCSP_RAM_MASK;

		// $04/$06: LSA/LEA (in fixed point, <<FREQ_LB)
		s.lsa = this._word(base + 0x04) << SCSP_FREQ_LB;
		s.lea = this._word(base + 0x06) << SCSP_FREQ_LB;

		// $08: D2R(sr)/D1R(dr)/EGHOLD/AR
		const w4 = this._word(base + 0x08);
		s.sr = (w4 >> 11) & 0x1F;
		s.dr = (w4 >> 6) & 0x1F;
		s.eghold = (w4 >> 5) & 1;
		s.ar = w4 & 0x1F;

		// $0A: LPSLNK/KRS/DL/RR
		const w5 = this._word(base + 0x0A);
		s.lpslnk = (w5 >> 14) & 1;
		let krs = (w5 >> 10) & 0xF;
		s.krs = (krs === 0xF) ? 4 : (krs >> 2);
		// Sustain level (DL) adjusted to compare against ecnt. DL is "the
		// upper 5 bits of the attenuation level", and in the decay half
		// the ecnt index IS the attenuation: ecnt >= sl <=> (att >> 5) >= DL.
		s.sl = ((w5 & 0x3E0) << SCSP_ENV_LB) + SCSP_ENV_DS;
		s.rr = w5 & 0x1F;

		// $0C: STWINH/SDIR/TL
		const w6 = this._word(base + 0x0C);
		s.stwinh = (w6 >> 9) & 1;
		s.sdir = (w6 >> 8) & 1;
		s.tl = TL_TABLE[w6 & 0xFF];

		// $0E: MDL/MDXSL/MDYSL -> FM modulation between slots.
		const w7 = this._word(base + 0x0E);
		s.mdl = (w7 >> 12) & 0xF;
		s.mdx = (w7 >> 6) & 0x3F;
		s.mdy = w7 & 0x3F;
		//? THE STACK GENERATION IS STILL UNRESOLVED, and the attempt of 28-07-2026 was
		//? reverted. For MDXSL and MDYSL, when the value is within the range 1CH to 3BH
		//? it selects the latest generation; out of that range it selects one sample past
		//? the latest generation. The reason is the time lag until a slot is written to
		//? the sound stack.
		//? It was implemented as a fixed offset per slot (0 or 32 depending on the range) and tested in the
		//? browser together with the rest of the batch: Sega Rally lost sound effects in
		//? the menus. Reverted.
		//? And NOW WE KNOW WHY IT WAS NOT ENOUGH, which is what has to be respected if it is picked up again:
		//? MAME (src/devices/sound/scsp.cpp) does not separate generations, it uses ONE RING OF 64 and
		//? indexes it with the live ring position:
		//?     smp = (RINGBUF[(BUFPTR + MDXSL) & 63] + RINGBUF[(BUFPTR + MDYSL) & 63]) / 2
		//? That "& 63" walks BOTH generations continuously -BUFPTR advances with each
		//? processed slot-, so the 1CH-3BH window falls out of the arithmetic on its own instead of
		//? being a special case. A fixed offset of 0 or 32 plus "(mdx + i) & 0x1F" is NOT the
		//? same: it changes which sample each source comes from.
		//? To pick it up again, soundStack has to become a ring of 64 with a live pointer, not
		//? patch the index.

		// $10: OCT/FNS -> frequency shift and phase step (finc).
		const w8 = this._word(base + 0x10);
		if(w8 & 0x4000)
			s.fsft = 23 - ((w8 >> 11) & 0xF);
		else
			s.fsft = ((w8 >> 11) & 7) ^ 7;
		s.finc = ((0x400 + (w8 & 0x3FF)) << 7) >>> s.fsft;

		// $12: LFORE/LFOF/PLFOWS/PLFOS/ALFOWS/ALFOS
		this._decodeLfo(s, this._word(base + 0x12));

		// $14: ISEL/OMXL -> which DSP MIXS the slot goes to and at what level.
		const wA = this._word(base + 0x14);
		s.isel = (wA >> 3) & 0xF;
		// The send level is a shift: 0 = mute, 7 = unattenuated.
		s.imxl = (wA & 7) ? ((wA & 7) ^ 7) : MUTE_LEVEL;

		// $16: DISDL/DIPAN/EFSDL/EFPAN -> levels and pan (as shifts).
		// DISDL/EFSDL fit exactly: the level goes from 0 dB to -36 dB in steps of 6, which is
		// exactly one shift per step, and 0 is "-inf (not sent)".
		//? NOT THE PAN: DIPAN/EFPAN go in 3 dB steps with 4 bits (01H = -3,
		//? 02H = -6 ... 0EH = -42, 0FH = -inf), and here it is resolved with `(d >> 9) & 7`, that is
		//? taking 3 bits and applying them as a 6 dB shift. The EVEN values land exactly
		//? (02H -> -6, 04H -> -12, 06H -> -18...) and the ODD ones end up 3 dB too loud: 01H sounds
		//? unattenuated instead of -3 dB, 03H gives -6 instead of -9. It is Yabause's approximation.
		//? Fixing it means taking the whole volume chain out of the shift domain
		//? (`v >> nl`) and moving it to multiplication, which is the hot path -per sample and
		//? per slot- and on top of that it CHANGES the output, so it goes with a cost measurement and a
		//? listening test of its own, not dragged along with other changes.
		const d = this._word(base + 0x16);
		// Direct output: DISDL[2:0] in 15:13, DIPAN[4:0] in 12:8.
		_gainPan(DIRECT_GAIN, (d >> 13) & 7, (d >> 8) & 0x1F);
		s.directGainLeft = DIRECT_GAIN[0];
		s.directGainRight = DIRECT_GAIN[1];
		// Effects output: EFSDL[2:0] in 7:5, EFPAN[4:0] in 4:0. It is applied to EFREG/EXTS
		// (which already come at 16-bit scale), not to the slot: see the big note in advance().
		_gainPan(DIRECT_GAIN, (d >> 5) & 7, d & 0x1F);
		s.gainEfLeft = DIRECT_GAIN[0];
		s.gainEfRight = DIRECT_GAIN[1];

		this._refreshEinc(s);
	}

	// Decodes the slot's $12 register (LFO). Equivalent to case 0x12 of
	// scsp_slot_set_w. Watch out for LFORE: when it is set, Yabause returns without touching
	// sensitivities or waveforms, so they keep their previous value.
	_decodeLfo(s, d)
	{
		if(d & 0x8000)          // LFORE: LFO held in reset
		{
			s.lfoinc = -1;
			return;
		}
		else if(s.lfoinc === -1)
		{
			s.lfocnt = 0;       // on leaving reset it starts from zero
		}

		s.lfoinc = TABLE_LFO_STEP[(d >> 10) & 0x1F];       // LFOF: frequency

		// PLFOS: vibrato sensitivity. 0 = no frequency modulation.
		s.lfofms = ((d >> 5) & 7) ? (((d >> 5) & 7) + 7) : MUTE_LEVEL;
		// ALFOS: tremolo sensitivity. 0 = no envelope modulation ("No
		// effect"). For the rest the shift (7 - ALFOS) is stored, which scales
		// ALFO[7:0] before it is ADDED to the EG
		// attenuation; see the tremolo note in advance().
		s.lfoems = (d & 7) ? (7 - (d & 7)) : MUTE_LEVEL;

		s.lfofmw = (d >> 8) & 3;   // PLFOWS: vibrato waveform
		s.lfoemw = (d >> 3) & 3;   // ALFOWS: tremolo waveform
	}

	// Recomputes the envelope steps (einca/d/s/r) from the rates, the
	// frequency shift and the key rate scale (scsp_slot_refresh_einc).
	//
	// About clamping (14 - fsft) to >= 0 (quirk reviewed on 16-07-2026):
	// Yabause does arp[(14 - slot->fsft) >> slot->krs], where arp points to
	// &scsp_attack_rate[ar << 1]. Going through every possible OCT/FNS,
	// (14 - fsft) goes from -1 to 14: -1 only comes out with OCT = -8 (the lowest
	// octave, fsft = 15). So the negative index reaches -1, no further.
	//   - With ar >= 1 the final index (ar<<1) + (-1) >> krs still lands INSIDE
	//     the table (minimum 1): Yabause does not read out of range, it simply
	//     takes a lower entry = an envelope one step slower.
	//   - With ar == 0 Yabause uses scsp_null_rate[], and scsp_null_rate[-1] would be
	//     truly out of range; here it does not happen because the ar == 0 case is
	//     resolved with 0 without touching the table.
	// Clamping at 0 is correct: Mednafen computes the same key rate
	// scale contribution as clamp(KRS + OCT, 0x00, 0x0F), that is, it also clamps it at 0 from below.
	// The only difference from Yabause remains at OCT = -8, where the envelope
	// advances one rate step faster (inaudible, and it matches Mednafen).
	_refreshEinc(s)
	{
		let offset = 14 - s.fsft;
		if(offset < 0) offset = 0;                 // see the note above
		const idx = offset >> s.krs;
		s.einca = s.ar ? ATTACK_TABLE[(s.ar << 1) + idx] : 0;
		s.eincd = s.dr ? DECAY_TABLE[(s.dr << 1) + idx] : 0;
		s.eincs = s.sr ? DECAY_TABLE[(s.sr << 1) + idx] : 0;
		s.eincr = s.rr ? DECAY_TABLE[(s.rr << 1) + idx] : 0;
	}

	// The bus reports that a register was written. If it falls in the slot region
	// (0x000-0x3FF) the affected slot is redecoded and the KEY-ON is serviced on the spot.
	notifyWrite(off, size)
	{
		// DSP registers ($700-$BFF: COEF, MADRS and the 128 microprogram steps). They are
		// marked dirty ON THE EDGE of the write and redecoded on the next block.
		// They used to be detected by comparing the 1,280 bytes against a copy once per block:
		// that is reading a LEVEL to discover an event, which is the pattern that already bit three
		// times in this repo (FBCR, PTMR, the VBE of TVMR). Here no pulses were lost because
		// the state stays written, but it cost 1,280 comparisons x ~260 blocks per frame
		// -333,000 per frame- to detect something the bus already knows.
		// The range is checked by OVERLAP: a long written at $6FE overwrites $700-$701.
		if(off + size > 0x700 && off < 0xC00){ this.dspDirty = true; return; }
		if(off >= 0x400) return;                 // rest of the common registers: not slots

		const num = (off >> 5) & 0x1F;
		this._decodeSlot(num);

		// KYONEX (bit 12 of word $00): fires key-on/off on ALL slots.
		const base = num * 0x20;
		if(this._word(base) & 0x1000)
		{
			this._keyOnOff();
			// KYONEX is not stored in the hardware (it reads back masked): it is cleared.
			this.reg[base] &= ~0x10;             // bit 12 of the word = bit 4 of the high byte
		}
	}

	// --------------------------------------------------------------------------
	// Key ON / OFF (scsp_slot_keyon / keyoff / keyonoff).
	// --------------------------------------------------------------------------
	_keyOnOff()
	{
		for(const s of this.slots)
		{
			if(s.key) this._keyOn(s);
			else      this._keyOff(s);
		}
	}

	_keyOn(s)
	{
		// The key has to be released before it is pressed again.
		if(s.ecurp !== PHASE_RELEASE) return;

		// Clamp the loop end address against the end of sound RAM.
		if(s.pcm8b)
		{
			if((s.sa + (s.lea >>> SCSP_FREQ_LB)) > SCSP_RAM_MASK)
				s.lea = (SCSP_RAM_MASK - s.sa) << SCSP_FREQ_LB;
		}
		else
		{
			if((s.sa + (s.lea >>> (SCSP_FREQ_LB - 1))) > SCSP_RAM_MASK)
				s.lea = (SCSP_RAM_MASK - s.sa) << (SCSP_FREQ_LB - 1);
		}

		s.fcnt = 0;                    // reset phase counter
		s.dirRev = 0;                  // all modes start reading forward
		s.ecnt = SCSP_ENV_AS;          // reset envelope counter
		s.env = 0;
		s.einc = EINC_ATTACK;          // the active step is the attack one
		s.ecurp = PHASE_ATTACK;         // current phase: attack
		s.ecmp = SCSP_ENV_AE;          // threshold: end of attack
		s.nextEvent = NEXT_ATTACK;    // event on arrival: end of attack
	}

	_keyOff(s)
	{
		// The key has to be pressed before it is released.
		if(s.ecurp === PHASE_RELEASE) return;

		// If we are still in attack the counter has to move to the decay half
		// KEEPING the EG value. On KEY-OFF, the level at that point (KEY_OFF LEVEL)
		// attenuates (increases as an EG value) according to the release rate (RR)
		// setting, so the level is continuous and from there it grows
		// up to 3FFH.
		//
		// Yabause does ecnt = SCSP_ENV_DE - ecnt, which only keeps the level if the
		// two halves of the curve are mirrors of each other. They are not (the attack is
		// x^7 and the decay is the EG value), so that trick puts a level jump
		// in the key-off: with the old curve it dropped the note 6 dB at once, and with
		// the envelope already logarithmic it would drop it 48 dB. Reindexing through TABLE_EG_ATT
		// leaves the exact level whatever the shape of the attack curve.
		if(s.ecurp === PHASE_ATTACK)
			s.ecnt = SCSP_ENV_DS + (TABLE_EG_ATT[s.ecnt >>> SCSP_ENV_LB] << SCSP_ENV_LB);
		s.einc = EINC_RELEASE;
		s.ecmp = SCSP_ENV_DE;
		s.ecurp = PHASE_RELEASE;
		s.nextEvent = NEXT_RELEASE;
	}

	// EG phase transition when ecnt reaches ecmp (scsp_*_next functions).
	_eventEnv(s)
	{
		switch(s.nextEvent)
		{
			case NEXT_ATTACK:    // end of attack -> decay 1
				s.ecnt = SCSP_ENV_DS;
				s.einc = EINC_DECAY;
				s.ecmp = s.sl;
				s.ecurp = PHASE_DECAY;
				s.nextEvent = NEXT_DECAY;
				break;
			case NEXT_DECAY:     // end of decay 1 -> sustain (decay 2)
				s.ecnt = s.sl;
				s.einc = EINC_SUSTAIN;
				s.ecmp = SCSP_ENV_DE;
				s.ecurp = PHASE_SUSTAIN;
				s.nextEvent = NEXT_SUSTAIN;
				break;
			case NEXT_SUSTAIN:   // end of sustain -> silence
			case NEXT_RELEASE:   // end of release -> silence
				s.ecnt = SCSP_ENV_DE;
				s.einc = EINC_NULL;
				s.ecmp = SCSP_ENV_DE + 1;
				s.nextEvent = NEXT_NULL;
				break;
			default:
				break;
		}
	}

	// --------------------------------------------------------------------------
	// Loop limits according to LPCTL, applied after moving the phase counter.
	// Returns false if the slot turned off (only happens with LPCTL = 0).
	//
	// The hardware's 4 modes (bits 5-6 of the slot's $00 register):
	//   0 = no loop       : SA -> LEA once and the slot DIES (ecnt = SCSP_ENV_DE).
	//   1 = normal loop   : SA -> LEA and then LSA -> LEA forward, always.
	//   2 = reverse loop  : SA -> LSA forward and then LEA -> LSA in reverse.
	//   3 = alternating loop (ping-pong): SA -> LEA, then bounces between LEA and LSA
	//       changing direction at each end.
	//
	// Yabause's "classic" engine (scsp.c) only distinguishes "lpctl == 0" from "lpctl
	// != 0" and treats modes 2 and 3 as a normal forward loop. That makes a
	// ping-pong slot repeat the segment always in the same direction, with a hard
	// LEA -> LSA jump on every lap (a discontinuity) and at twice the real repetition
	// frequency. Here the 4 modes are emulated like the hardware. The direction lives in
	// slot.dirRev, which key-on always resets to "forward".
	//
	// Note on the bounce of modes 2/3: in reverse the phase step is subtracted with
	// normal JS arithmetic (not with >>> 0) so that crossing below LSA can
	// be detected with a comparison; mode 1 keeps Yabause's >>> 0
	// (it matters because the LFO vibrato can subtract phase and depends on that wrap).
	_limitPhase(s)
	{
		switch(s.lpctl)
		{
			case 0:                        // no loop: the slot dies when it passes LEA
				if(s.fcnt > s.lea) { s.ecnt = SCSP_ENV_DE; return false; }
				break;

			case 1:                        // normal forward loop
				if(s.fcnt > s.lea) s.fcnt = s.lsa;
				break;

			case 2:                        // reverse loop
				if(!s.dirRev)
				{
					// First forward pass: on passing LSA it jumps to the end of the
					// loop and from there on it always reads in reverse.
					if(s.fcnt > s.lsa) { s.dirRev = 1; s.fcnt = s.lea; }
				}
				else if(s.fcnt <= s.lsa) s.fcnt = s.lea;   // back to the end of the loop
				break;

			case 3:                        // alternating loop (ping-pong)
				if(!s.dirRev)
				{
					if(s.fcnt > s.lea)
					{
						s.dirRev = 1;
						s.fcnt = s.lea - (s.fcnt - s.lea);     // bounce at LEA
						if(s.fcnt < s.lsa) s.fcnt = s.lsa;     // loop shorter than the step
					}
				}
				else if(s.fcnt <= s.lsa)
				{
					s.dirRev = 0;
					s.fcnt = s.lsa + (s.lsa - s.fcnt);         // bounce at LSA
					if(s.fcnt > s.lea) s.fcnt = s.lea;
				}
				break;
		}
		return true;
	}

	// Returns the active envelope step (or null if the envelope is stopped).
	_stepEinc(s)
	{
		switch(s.einc)
		{
			case EINC_ATTACK:  return s.einca;
			case EINC_DECAY:   return s.eincd;
			case EINC_SUSTAIN: return s.eincs;
			case EINC_RELEASE: return s.eincr;
			default:           return null;
		}
	}

	// --------------------------------------------------------------------------
	// Effects DSP: microprogram decoding.
	// The flag is raised by notifyWrite() on the edge of the write (see there).
	//? A delay of up to one block remains: if a game rewrites the microprogram in
	//? the middle of a block of samples, the change is taken when the next one starts. The
	//? hardware does not fix any timing for this; the only thing known is that while
	//? it is being rewritten the DSP operation becomes unstable and the sound is not output
	//? properly from EFREG, so the hardware does not guarantee anything there either.
	// --------------------------------------------------------------------------
	_syncDsp()
	{
		if(!this.dspDirty) return;
		this.dspDirty = false;
		this._decodeDsp();
	}

	// Rereads COEF/MADRS and decodes the 128 microprogram steps.
	_decodeDsp()
	{
		// COEF ($700): 13 bits left-aligned within the word.
		for(let i = 0; i < 64; i++) this.dspCoef[i] = this._word(0x700 + i * 2) >> 3;
		// MADRS ($780): 16-bit base addresses.
		for(let i = 0; i < 32; i++) this.dspMadrs[i] = this._word(0x780 + i * 2);

		// MPRO ($800): 128 64-bit big-endian instructions (8 bytes each).
		// They are read as 4 words: w0 = bits 48-63, w1 = 32-47, w2 = 16-31, w3 = 0-15.
		let hasProgram = false;
		for(let step = 0; step < 128; step++)
		{
			const b = 0x800 + step * 8;
			const w0 = this._word(b + 0), w1 = this._word(b + 2);
			const w2 = this._word(b + 4), w3 = this._word(b + 6);

			if(w0 | w1 | w2 | w3) hasProgram = true;

			// Fields (bit positions within the 64-bit instruction).
			this.mpMasa[step] = (w3 >> 2) & 0x1F;    // bits 2-6
			this.mpCra[step]  = (w3 >> 9) & 0x3F;    // bits 9-14
			this.mpEwa[step]  = (w2 >> 8) & 0x0F;    // bits 24-27
			this.mpIwa[step]  = w1 & 0x1F;           // bits 32-36
			this.mpIra[step]  = (w1 >> 6) & 0x3F;    // bits 38-43
			this.mpYsel[step] = (w1 >> 13) & 0x03;   // bits 45-46
			this.mpTwa[step]  = w0 & 0x7F;           // bits 48-54
			this.mpTra[step]  = (w0 >> 8) & 0x7F;    // bits 56-62

			let f = 0;
			if(w3 & (1 << 0))  f |= DSPF_NXADDR;     // bit 0
			if(w3 & (1 << 1))  f |= DSPF_ADRGB;      // bit 1
			if(w3 & (1 << 8))  f |= DSPF_NOFL;       // bit 8
			if(w2 & (1 << 0))  f |= DSPF_BSEL;       // bit 16
			if(w2 & (1 << 1))  f |= DSPF_ZERO;       // bit 17
			if(w2 & (1 << 2))  f |= DSPF_NEGB;       // bit 18
			if(w2 & (1 << 3))  f |= DSPF_YRL;        // bit 19
			if(w2 & (1 << 4))  f |= DSPF_SHFT0;      // bit 20
			if(w2 & (1 << 5))  f |= DSPF_SHFT1;      // bit 21
			if(w2 & (1 << 6))  f |= DSPF_FRCL;       // bit 22
			if(w2 & (1 << 7))  f |= DSPF_ADRL;       // bit 23
			if(w2 & (1 << 12)) f |= DSPF_EWT;        // bit 28
			if(w2 & (1 << 13)) f |= DSPF_MRT;        // bit 29
			if(w2 & (1 << 14)) f |= DSPF_MWT;        // bit 30
			if(w2 & (1 << 15)) f |= DSPF_TABLE;      // bit 31
			if(w1 & (1 << 5))  f |= DSPF_IWT;        // bit 37
			if(w1 & (1 << 15)) f |= DSPF_XSEL;       // bit 47
			if(w0 & (1 << 7))  f |= DSPF_TWT;        // bit 55
			this.mpFlags[step] = f;

			this.mpReads[step] = (f & (DSPF_EWT | DSPF_TWT | DSPF_FRCL | DSPF_ADRL |
			                         DSPF_MWT | DSPF_BSEL)) ? DSPR_SFT : 0;

			let esc = DSPW_SFT;
			if(f & DSPF_FRCL)              esc |= DSPW_FRC;
			if(f & DSPF_YRL)               esc |= DSPW_Y;
			if(f & DSPF_ADRL)              esc |= DSPW_ADRS;
			if(f & DSPF_TWT)               esc |= DSPW_TEMP;
			if(f & DSPF_IWT)               esc |= DSPW_MEMS;
			if(f & DSPF_EWT)               esc |= DSPW_EFREG;
			if(f & (DSPF_MRT | DSPF_MWT))  esc |= DSPW_RAM;
			this.mpWrites[step] = esc;
		}

		this.activeDsp = hasProgram;
		this._analyzeStepsAlive();
	}

	// Marks which microprogram steps can be skipped. A step is "dead" if
	// the only observable thing it writes is SFT_REG and/or INPUTS, and the next step does not
	// look at either of them. Real microprograms leave most of the 128
	// steps at zero, so this saves a lot of work per sample.
	_analyzeStepsAlive()
	{
		for(let step = 0; step < 128; step++)
		{
			const nextStep = (step + 1) & 0x7F;
			const nf = this.mpFlags[nextStep];

			const otherWrites = (this.mpWrites[step] & ~DSPW_SFT) !== 0;
			const sftObserved    = (this.mpReads[nextStep] & DSPR_SFT) !== 0;

			// INPUTS is preserved when IRA is in [0x32..0x3F]; otherwise, the step overwrites it.
			const iraCur = this.mpIra[step], iraNext = this.mpIra[nextStep];
			const writesInputs   = !((iraCur & 0x30) === 0x30 && (iraCur & 0x0E) !== 0);
			const preservesInputs  =  ((iraNext & 0x30) === 0x30 && (iraNext & 0x0E) !== 0);
			const usesInputs       = (nf & DSPF_YRL) || (nf & DSPF_XSEL) ||
			                        ((nf & DSPF_ADRL) && !((nf & DSPF_SHFT0) && (nf & DSPF_SHFT1)));
			const inputsObserved = writesInputs && preservesInputs && usesInputs;

			this.mpAlive[step] = (otherWrites || sftObserved || inputsObserved) ? 1 : 0;
		}

		// The RAM access a step fires (MRT/MWT) is not served in that step: it
		// latches at the end and the next step completes it. If that next one were
		// skipped, the read would resolve late and the IWT that consumes it would read an
		// old value. So the successor stays alive no matter what.
		for(let step = 0; step < 128; step++)
		{
			if(this.mpFlags[step] & (DSPF_MRT | DSPF_MWT))
				this.mpAlive[(step + 1) & 0x7F] = 1;
		}
	}

	// --------------------------------------------------------------------------
	// Effects DSP: execution of one complete pass (128 steps = 1 sample).
	// Port of Mednafen's SS_SCSP_RunDSP. It takes MIXS (what the slots sent it
	// in the previous sample) + EXTS (CDDA) + the sound RAM, and leaves the result in
	// EFREG, which is then mixed into the output with EFSDL/EFPAN.
	// --------------------------------------------------------------------------
	_executeDsp()
	{
		const ram = this.ram;
		const maskRing = (0x2000 << this.dspRbl) - 1;
		const baseRing = this.dspRbp << 12;      // in 16-bit words
		const optimize = this.dspOptimize;

		for(let step = 0; step < 128; step++)
		{
			if(optimize && !this.mpAlive[step]) continue;

			const f = this.mpFlags[step];
			const ira = this.mpIra[step];
			const addrWriteTemp = (this.mpTwa[step] + this.dspMdecCt) & 0x7F;
			const addrReadTemp = (this.mpTra[step] + this.dspMdecCt) & 0x7F;

			// --- INPUTS: where this step's input comes from ---
			if(ira & 0x20)
			{
				if(ira & 0x10)
				{
					// IRA 0x30/0x31 = EXTS (CDDA). 0x32-0x3F preserve INPUTS.
					if(!(ira & 0xE)) this.dspInputs = (this.dspExts[ira & 1] << 8) & 0xFFFFFF;
				}
				else this.dspInputs = (this.dspMixs[ira & 0xF] << 4) & 0xFFFFFF;
			}
			else this.dspInputs = this.dspMems[ira & 0x1F];

			const inputs = (this.dspInputs << 8) >> 8;      // sign-extended to 24 bits

			// --- Y: multiplicand, chosen by YSEL ---
			const ysel = this.mpYsel[step];
			let yInput;
			if(ysel === 0)      yInput = this.dspFrcReg;
			else if(ysel === 1) yInput = this.dspCoef[this.mpCra[step]];
			else if(ysel === 2) yInput = (this.dspYReg >> 11) & 0x1FFF;
			else                yInput = (this.dspYReg >> 4) & 0x0FFF;

			if(f & DSPF_YRL) this.dspYReg = inputs & 0xFFFFFF;

			// --- Shifter: shifts and saturates the adder output ---
			const shft0 = (f >> 7) & 1;
			const shft1 = (f >> 8) & 1;
			let outShifter = ((this.dspSftReg << 6) >> 6) << (shft0 ^ shft1);
			if(!shft1)
			{
				if(outShifter > 0x7FFFFF) outShifter = 0x7FFFFF;
				else if(outShifter < -0x800000) outShifter = 0x800000;
			}
			outShifter &= 0xFFFFFF;

			if(f & DSPF_FRCL)
				this.dspFrcReg = (shft0 & shft1) ? (outShifter & 0xFFF) : (outShifter >> 11);

			// --- Multiplier + adder -> SFT_REG ---
			const temp = (this.dspTemp[addrReadTemp] << 8) >> 8;   // sign-extended to 24 bits
			const xInput = (f & DSPF_XSEL) ? inputs : temp;
			// y is 13 bits signed; the product can exceed 32 bits, so
			// the shift is done with division (>> would truncate to 32 bits in JS).
			const product = Math.floor((((yInput << 19) >> 19) * xInput) / 4096);

			let outSum = (f & DSPF_BSEL) ? this.dspSftReg : temp;
			if(f & DSPF_NEGB) outSum = -outSum;
			if(f & DSPF_ZERO) outSum = 0;

			this.dspSftReg = (product + outSum) & 0x3FFFFFF;

			// --- Writes of the shifter output ---
			if(f & DSPF_EWT) this.dspEfreg[this.mpEwa[step]] = (outShifter >> 8) & 0xFFFF;
			if(f & DSPF_TWT) this.dspTemp[addrWriteTemp] = outShifter;
			if(f & DSPF_IWT) this.dspMems[this.mpIwa[step]] = this.dspReadsValue;

			// --- The RAM access latched by the previous step is resolved ---
			if(this.dspReadsPending)
			{
				const addr = this.dspRwAddr;
				let raw = 0;
				// Above 0x40000 words there is no real RAM (it is 512 KB): it reads zero.
				if(!(addr & 0x40000))
				{
					const a = (addr << 1) & SCSP_RAM_MASK;
					raw = ((ram[a] << 8) | ram[a + 1]) & 0xFFFF;
				}
				this.dspReadsValue = (this.dspReadsPending === 2) ? ((raw << 8) & 0xFFFFFF)
				                                          : dspFloatAInteger(raw);
				this.dspReadsPending = 0;
			}
			else if(this.dspWritePending)
			{
				if(!(this.dspRwAddr & 0x40000))
				{
					const a = (this.dspRwAddr << 1) & SCSP_RAM_MASK;
					ram[a] = (this.dspWriteValue >> 8) & 0xFF;
					ram[a + 1] = this.dspWriteValue & 0xFF;
				}
				this.dspWritePending = false;
			}

			// --- Address for the next RAM access ---
			let addr = this.dspMadrs[this.mpMasa[step]];
			if(f & DSPF_NXADDR) addr = (addr + 1) & 0xFFFF;
			if(f & DSPF_ADRGB)  addr = (addr + ((this.dspAdrsReg << 20) >> 20)) & 0xFFFF;
			if(!(f & DSPF_TABLE))
			{
				// Without TABLE the address wraps inside the effects ring buffer.
				addr = (addr + this.dspMdecCt) & 0xFFFF;
				addr &= maskRing;
			}
			this.dspRwAddr = (addr + baseRing) & 0x7FFFF;

			if(f & DSPF_MRT) this.dspReadsPending = (f & DSPF_NOFL) ? 2 : 1;
			if(f & DSPF_MWT)
			{
				this.dspWritePending = true;
				this.dspWriteValue = (f & DSPF_NOFL) ? ((outShifter >> 8) & 0xFFFF)
				                                   : integerADspFloat(outShifter);
			}

			if(f & DSPF_ADRL)
			{
				this.dspAdrsReg = ((shft0 & shft1) ? (outShifter >> 12) : ((inputs >> 16) & 0xFFF)) & 0xFFF;
			}
		}

		// MDEC_CT rotates the ring buffer: one position per sample.
		if(!this.dspMdecCt) this.dspMdecCt = (0x2000 << this.dspRbl);
		this.dspMdecCt--;
	}

	// Copies EFREG to the registers ($EC0) so the 68000 can read the DSP
	// output. Done once per block, not per sample.
	_mirrorEfreg()
	{
		for(let i = 0; i < 16; i++)
		{
			const v = this.dspEfreg[i];
			this.reg[0xEC0 + i * 2] = (v >> 8) & 0xFF;
			this.reg[0xEC1 + i * 2] = v & 0xFF;
		}
	}

	// --------------------------------------------------------------------------
	// CDDA: audio from the CD tracks. The CD delivers 2352-byte sectors of
	// 16-bit stereo little-endian PCM, which enter the SCSP through EXTS0/EXTS1.
	// bus.js wires it (_cdDriveStep -> scspEngine.receiveCdda) for each sector of an
	// audio track. The pace is set by the CD clock, not by backpressure: it is
	// 75 sectors/s * 2352 B = 176400 B/s, exactly what _readCdda() consumes
	// at 44100 Hz stereo. The hardware does not ask either: the CD block sends continuous
	// serial digital audio to the SCSP.
	// --------------------------------------------------------------------------
	receiveCdda(sector)
	{
		const buf = this.cddaBuf;
		buf.set(sector.subarray(0, 2352), this.cddaNextEnt);

		if(buf.length - this.cddaNextEnt <= 2352) this.cddaNextEnt = 0;
		else this.cddaNextEnt += 2352;

		this.cddaRemaining += 2352;
		if(this.cddaRemaining > buf.length) this.cddaRemaining = buf.length;   // overrun
	}

	// Takes one stereo sample from the CDDA buffer and leaves it in EXTS.
	_readCdda()
	{
		const buf = this.cddaBuf;
		let pos = this.cddaNextEnt - this.cddaRemaining;
		if(pos < 0) pos += buf.length;

		this.dspExts[0] = ((buf[pos + 1] << 8) | buf[pos]) & 0xFFFF;
		this.dspExts[1] = ((buf[pos + 3] << 8) | buf[pos + 2]) & 0xFFFF;

		this.cddaRemaining -= 4;
		if(this.cddaRemaining < 0) this.cddaRemaining = 0;
	}

	// CDDA bytes pending playback. An observation window for the tests:
	// the emulator does not use it and has no reason to (the CD does not regulate its pace against the SCSP,
	// the clock paces it). It is not an unconnected piece.
	cddaPending()
	{
		return this.cddaRemaining;
	}

	// --------------------------------------------------------------------------
	// Generates `n` stereo samples (44100 Hz) and pushes them into the ring buffer.
	// Order per sample (the same as Mednafen's SS_SCSP_RunSample):
	//   1. runs the DSP, which consumes the MIXS of the previous sample -> EFREG
	//   2. clears MIXS
	//   3. walks the 32 slots: PCM + envelope + LFO -> direct output and MIXS
	//   4. mixes the effects output (EFREG + EXTS) with EFSDL/EFPAN
	//   5. applies the master volume
	// --------------------------------------------------------------------------
	advance(n)
	{
		const ram = this.ram;
		const slots = this.slots;
		const stack = this.soundStack;
		const outputSlot = this.outputSlot;

		// Check once per block whether the DSP microprogram changed.
		this._syncDsp();

		// $402: RBL (length of the effects ring buffer) / RBP (its base address).
		const w402 = this._word(0x402);
		this.dspRbl = (w402 >> 7) & 3;
		this.dspRbp = w402 & 0x7F;

		// Master volume (register $400: MEM4MB/DAC18B/VER/MVOL). MVOL in bits 0-3.
		// ONLY MVOL is used from that register. The other three fields, and why:
		//? MEM4MB (bit 9): picks the size of the sound DRAM. With 0 it is 1 Mbit and the
		//? memory sits at 000000H-01FFFFH (128 KB); with 1 it is
		//? 4 Mbit and you get the 512 KB we ALWAYS provide. It is not modeled: the BIOS sets it
		//? to 1 before downloading the driver because that is a requirement: MEM4MB must be 1
		//? and DAC18B must be 0 before anything is downloaded. So
		//? the MEM4MB=0 case does not happen; but if some disc left it at 0, the hardware
		//? would mirror every 128 KB and we would not.
		//? DAC18B (bit 8): width of the interface to the external DAC (18 bits vs 16). It is not
		//? observable from inside -it does not change the mix, only the wiring, and the Saturn
		//? carries a 16-bit DAC with this bit at 0-, so there is
		//? nothing to emulate.
		//? VER[3:0] (bits 4-7, R): chip version number. We return 0 because the value the
		//? Saturn's SCSP carries is not published, and it is not made up.
		const mvol = this.reg[0x401] & 0xF;
		const mvolShift = 0xF - mvol;

		const activeDsp = this.activeDsp;
		// It is only worth walking the effects bus if there is something that can sound through it.
		const hasEffects = activeDsp || this.cddaRemaining > 0;

		for(let m = 0; m < n; m++)
		{
			let mixLeft = 0, mixRight = 0;

			// --- EXTS: external digital input (CDDA) ---
			if(this.cddaRemaining > 0) this._readCdda();
			else { this.dspExts[0] = 0; this.dspExts[1] = 0; }

			// --- Effects DSP ---
			if(activeDsp)
			{
				this._executeDsp();
				this.dspMixs.fill(0);
			}

			for(let i = 0; i < 32; i++)
			{
				const s = slots[i];

				if(s.ecnt >= SCSP_ENV_DE) continue;   // slot off (null envelope)

				// SSCTL = 10B: internally generated data, all 0s, that is
				// silence. Only the phase advances. (11B = not available.)
				if(s.ssctl >= 2)
				{
					if(s.dirRev) s.fcnt = s.fcnt - s.finc;
					else         s.fcnt = (s.fcnt + s.finc) >>> 0;
					this._limitPhase(s);
					continue;
				}

				// LFO paths: vibrato (FMS) and/or tremolo (EMS). With both
				// sensitivities at 0 the LFO touches nothing and is not evaluated.
				const withFm = s.lfofms !== MUTE_LEVEL;
				const withEm = s.lfoems !== MUTE_LEVEL;
				const posLfo = (s.lfocnt >>> SCSP_LFO_LB) & SCSP_LFO_MASK;

				// --- FM modulation between slots (MDL/MDXSL/MDYSL) ---
				// Averages the output of two slots from the previous generation and adds it to the
				// read index, that is, it warps the phase with another wave. The average is
				// exactly the hardware's: with XD the data input into X and YD the data input
				// into Y, the averaging block outputs
				// ZD = (XD + YD) / 2.
				//
				// MDL FROM 0 TO 4 DOES NOT MODULATE. The modulation rate according to the
				// register value is +-n(pi), per MDL value:
				//     MDL   0~4    5     6     7    8   9  A  B  C   D   E   F
				//     rate   0    1/16  1/8  1/4  1/2  1  2  4  8  16  32  64
				// so the first five values share the same entry and are worth
				// ZERO. The shift >> (0xF - mdl) reproduces the progression above exactly
				// -each step doubles-, but the cutoff was at `if(s.mdl)`, so
				// MDL = 1, 2, 3 and 4 modulated a tiny bit instead of nothing.
				let offsetFm = 0;
				if(s.mdl > 4)
				{
					const xd = stack[(s.mdx + i) & 0x1F];
					const yd = stack[(s.mdy + i) & 0x1F];
					offsetFm = ((xd + yd) / 2) | 0;
					offsetFm >>= (0xF - s.mdl);
				}
				
				// --- sample read: PCM from sound RAM or internal noise ---
				// The sample width stays at its format's scale: 8 bits
				// signed if PCM8B, 16 bits signed otherwise (the shifts
				// below compensate with SCSP_ENV_HB - 8).
				const idx = (s.fcnt >>> SCSP_FREQ_LB) + offsetFm;
				let raw, maskSign;
				if(s.ssctl === 1)
				{
					// SSCTL = 01B: internally generated data (noise). The
					// source is the slot's LFO noise oscillator.
					// The LFO parameters (LFORE, LFOF,
					// ALFOWS, ALFOS, PLFOWS, PLFOS) have no effect on the noise as
					// audio data, LFORE's reset does not apply to the noise, and its
					// frequency cannot be changed: it runs free and
					// at a fixed frequency, that is one new sample per Fs.
					//? Neither the width nor the polynomial of the
					//? oscillator is published, so the generator is our own (a 32-bit
					//? xorshift seeded per slot). The character is right (white
					//? noise with no audible period), but the exact sequence is not
					//? the hardware's.
					s.noise ^= s.noise << 13;  s.noise >>>= 0;
					s.noise ^= s.noise >>> 17;
					s.noise ^= s.noise << 5;   s.noise >>>= 0;
					raw = s.pcm8b ? (s.noise & 0xFF) : (s.noise & 0xFFFF);
					maskSign = s.pcm8b ? 0x80 : 0x8000;
				}
				else if(s.pcm8b)
				{
					// 8 bits signed, byte addressing.
					raw = ram[(s.sa + idx) & SCSP_RAM_MASK];
					maskSign = 0x80;
				}
				else
				{
					// 16 bits signed, big-endian (high byte first).
					const a = ((s.sa & ~1) + idx * 2) & SCSP_RAM_MASK;
					raw = (ram[a] << 8) | ram[a + 1];
					maskSign = 0x8000;
				}

				// SBCTL: source bit inversion. SBCTL0 inverts all but the sign bit of the
				// source waveform data. SBCTL1 inverts the sign bit of the source
				// waveform data.
				if(s.sbctl)
				{
					if(s.sbctl & 1) raw ^= maskSign - 1;   // everything but the sign
					if(s.sbctl & 2) raw ^= maskSign;       // the sign bit
				}
				// Sign extension according to the format.
				const out = s.pcm8b ? ((raw << 24) >> 24) : ((raw << 16) >> 16);

				// --- envelope ---
				// The EG attenuation, the TL and the ALFO all live in the same
				// 10-bit logarithmic domain (see EG_DB_LSB). Here the EG and the
				// ALFO are added in dB and the TL is applied as an already converted gain
				// (multiplying gains == adding attenuations).
				let att = TABLE_EG_ATT[s.ecnt >>> SCSP_ENV_LB];
				// EGHOLD: when this bit is 1B, the value during attack is held at
				// 000H. The counter still keeps running at the AR pace,
				// which is what sets how long the hold lasts (the time the EG holds
				// 000H is determined by the value of AR).
				if(s.eghold && s.ecurp === PHASE_ATTACK) att = 0;
				// Tremolo: it is a mix into the EG, that is, it is
				// ADDED to the attenuation (it never amplifies). ALFOS is the depth:
				// 7 -> 24 dB, which is the whole 256 LSB of ALFO[7:0]; each step
				// of ALFOS downward halves it (12/6/3/1.5/0.8/0.4 dB), that
				// is ALFO[7:0] >> (7 - ALFOS). The +1 makes the top of the wave
				// (FFH) reach the exact table value instead of falling 1 LSB
				// short. The LFO waves are 10 bits, so they are trimmed to the
				// 8 of ALFO.
				if(withEm) att += ((LFO_WAVES_E[s.lfoemw][posLfo] >> 2) + 1) >> s.lfoems;
				// The EG alone already reaches 3FFH and the ALFO adds up to 256 more LSB, so
				// the sum is clamped to the hardware maximum (3FFH).
				//? Mutation testing does not catch it, and that is on purpose: today removing this
				//? clamp does not change a single sample, because the gain at 3FFH is already
				//? 0 and an index out of the table gives undefined -> (NaN >> 10) = 0, that
				//? is, the same silence by accident. It stays anyway because it is
				//? the hardware's limit and because the accident breaks on its own: if the volume
				//? chain moved to floating point, that NaN would go straight into the audio
				//? buffer and nothing would come out anymore.
				if(att > SCSP_ENV_MASK) att = SCSP_ENV_MASK;

				let env = (TABLE_EG_GAIN[att] * s.tl) >> 10;
				// SDIR: when this bit is 1B, the sound data is output without
				// being multiplied by EG, TL, ALFO, etc.
				if(s.sdir) env = SCSP_ENV_LEN;
				s.env = env;

				let output16 = 0;
				if(out !== 0 && env > 0)
				{
					const v = out * env;
					// Slot sample at 16-bit scale (post envelope, pre pan).
					output16 = s.pcm8b ? (v >> (SCSP_ENV_HB - 8)) : (v >> SCSP_ENV_HB);

					// Send to the DSP (MIXS) according to ISEL/OMXL.
					if(activeDsp && s.imxl !== MUTE_LEVEL)
					{
						this.dspMixs[s.isel] =
							(this.dspMixs[s.isel] + ((output16 << 4) >> s.imxl)) & 0xFFFFF;
					}

					// DIRECT OUTPUT, and ONLY through DISDL/DIPAN. A slot has exactly two
					// paths to the DAC and this is one; the other is ISEL/IMXL -> MIXS -> DSP ->
					// EFREG, which is mixed further down with the EFSDL/EFPAN of the corresponding
					// slot 0-15.
					//
					// THERE WAS A THIRD PATH HERE THAT THE HARDWARE DOES NOT HAVE (removed on
					// 27-07-2026): "if DISDL is muted, use EFSDL as if it were the slot's direct
					// level". It came from Yabause, which does not emulate the DSP. The hardware
					// says otherwise: the DSP output stage adjusts the output level (EFSDL)
					// and output balance (EFPAN) of the sound signals that come out of the
					// DSP's EFREG and out of EXTS.
					// So EFSDL/EFPAN are the level of the output OF THE DSP and of the
					// external input, never of the raw output of a
					// slot.
					//
					// And that a slot with DISDL = 0 and IMXL = 0 does not sound is not a side effect:
					// it is what the hardware defines, each value in its own register:
					// "DISDL 0 -> -inf (not sent)" and "IMXL 0 -> -MAX (does not
					// mix)". A slot like that is muted ON PURPOSE, and the typical use is the
					// FM MODULATOR: its output is consumed through the sound stack (SOUS) to
					// warp the carrier's phase, and it never goes to the DAC (that is how
					// the FM algorithm connections are wired).
					//
					// THE SHORTCUT WAS REMOVED (second attempt, 28-07-2026), and this time in isolation.
					//
					// The first attempt was on 27-07 and Sega Rally lost effects in the
					// menus, so it came back. But that attempt went together with the WHOLE SCSP
					// batch, and later the real culprit showed up: the GENERATION of the sound
					// stack for FM, which had been implemented as a fixed offset per
					// slot when it actually goes with a ring of 64 (see the MDXSL note in
					// _decodeSlot). With the FM reverted the effects came back.
					//
					// Two sources say this shortcut does not exist, not one:
					//  - The hardware's register definitions: EFSDL/EFPAN are the level of EFREG and EXTS,
					//    and DISDL 0 = "-inf (not sent)".
					//  - MAME (src/devices/sound/scsp.cpp): the slot goes to the direct mix ONLY through
					//    DISDL/DIPAN, and EFSDL/EFPAN is applied in a separate loop, only to
					//    EFREG[i]. A slot's raw PCM never comes out through its EFSDL.
					// And measured with diag/scsp-shortcut-why.mjs (with the fields already fixed):
					// **no Rally slot depends on this shortcut** in 3,000 frames with
					// input. The "5 of 32" that had been reported came from a probe that looked at
					// fields deleted by the gains refactor.
					// `v` is (sample x envelope), so it carries SCSP_ENV_HB extra fractional
					// bits; 8-bit PCM also comes in 8 bits smaller.
					// It is normalized to a signed 16-bit sample and then the
					// 15-bit gain is applied: Math.imul(+-32768, 32768) = +-2^30, comfortably within range.
					const v16 = s.pcm8b ? (v >> (SCSP_ENV_HB - 8)) : (v >> SCSP_ENV_HB);
					if(s.directGainLeft) mixLeft += Math.imul(v16, s.directGainLeft) >> 15;
					if(s.directGainRight) mixRight += Math.imul(v16, s.directGainRight) >> 15;
				}

				// The slot output is recorded for the sound stack (SOUS). STWINH:
				// when this bit is 1B, writing the slot output to the sound stack
				// (SOUS) is prohibited, so in that case the slot leaves in
				// its place in the stack whatever was already there. The stack is rotated at the end of
				// the sample, once all 32 have gone by (see below).
				outputSlot[i] = s.stwinh ? stack[i + 32] : output16;

				// --- phase advance (with vibrato, loop and end of sample) ---
				if(withFm)
				{
					// The vibrato shifts the phase before the normal step is added. The
					// shift by fsft scales the modulation according to the octave.
					const mod = (LFO_WAVES_F[s.lfofmw][posLfo] << (s.lfofms - 7)) >> (s.fsft + 1);
					s.fcnt = (s.fcnt + mod) >>> 0;
				}
				// In reverse (LPCTL 2/3) the phase goes down; see _limitPhase.
				if(s.dirRev) s.fcnt = s.fcnt - s.finc;
				else         s.fcnt = (s.fcnt + s.finc) >>> 0;
				if(!this._limitPhase(s)) continue;   // LPCTL = 0: the sample is over

				// --- envelope advance ---
				const step = this._stepEinc(s);
				if(step !== null) s.ecnt += step;

				if(s.lpslnk && s.ecurp === PHASE_ATTACK)
				{
					// LPSLNK (loop start link): its function is to synchronize the start
					// of the loop and the transition from the EG attack state to the
					// decay 1 state. So the attack
					// does NOT move to decay 1 on its own: it moves when the read
					// address reaches the start of the loop (SA + LSA).
					//   - If the EG reaches 000H first, the EG continues
					//     to hold the MAX level until that point: it sticks at the end
					//     of the attack.
					//   - If the address arrives first, it moves to
					//     decay 1 with whatever level it has at that moment.
					if(s.ecnt > SCSP_ENV_AE) s.ecnt = SCSP_ENV_AE;
					if(s.fcnt >= s.lsa)
					{
						// EG level right when the start of the loop is reached.
						const attLoop = TABLE_EG_ATT[s.ecnt >>> SCSP_ENV_LB];
						this._eventEnv(s);
						// _eventEnv starts the decay at 000H (complete attack); with
						// LPSLNK the level the EG carried at this point (SCL, the EG
						// level) has to be respected.
						s.ecnt = SCSP_ENV_DS + (attLoop << SCSP_ENV_LB);
						if(s.ecnt >= s.ecmp)
						{
							// If on reaching the start of the loop the EG has already
							// passed DL, the EG value will never reach DL (decay
							// level), so it keeps maintaining level 0 (EG
							// value 3FFH) without transitioning to the Decay 2
							// state: it stays in decay 1 (with D1R) until
							// maximum attenuation. Without this, the _eventEnv of the next
							// sample would re-latch ecnt = sl and give full volume back
							// to a note that was already attenuated.
							s.ecmp = SCSP_ENV_DE;
							s.nextEvent = NEXT_SUSTAIN;
						}
					}
				}
				else if(s.ecnt >= s.ecmp)
				{
					this._eventEnv(s);
					if(s.ecnt >= SCSP_ENV_DE) continue;
				}

				// --- LFO advance ---
				if(withFm || withEm) s.lfocnt = (s.lfocnt + s.lfoinc) >>> 0;
			}

			// --- sound stack (SOUS): the current generation becomes the previous one ---
			// It is done after walking the 32 slots so that all of them have read the
			// same previous generation (if it rotated inside the loop, slot i
			// would see slots < i already rotated). The slots that are off leave 0, which is
			// what is right: they are not sounding.
			for(let i = 0; i < 32; i++)
			{
				stack[i] = stack[i + 32];
				stack[i + 32] = outputSlot[i];
				outputSlot[i] = 0;
			}

			// --- effects bus: EFREG[0..15] + EXTS[0..1] ---
			// Each one uses the EFSDL/EFPAN of the slot with the same number (0-15 are the
			// 16 DSP outputs; 16 and 17 are the external inputs / CDDA).
			if(hasEffects)
			{
				for(let i = 0; i < 18; i++)
				{
					const s = slots[i];
					if(!s.gainEfLeft && !s.gainEfRight) continue;

					const raw = (i < 16) ? this.dspEfreg[i] : this.dspExts[i - 16];
					const v = (raw << 16) >> 16;      // sign-extended to 16 bits
					if(v === 0) continue;

					if(s.gainEfLeft) mixLeft += Math.imul(v, s.gainEfLeft) >> 15;
					if(s.gainEfRight) mixRight += Math.imul(v, s.gainEfRight) >> 15;
				}
			}

			// Apply the master volume and normalize to [-1, 1].
			mixLeft >>= mvolShift;
			mixRight >>= mvolShift;
			this._push(mixLeft / 32768, mixRight / 32768);
		}

		if(activeDsp) this._mirrorEfreg();
		this._mirrorSous();
	}

	// Copies the sound stack to the SOUS registers ($600) so the 68000 can
	// read the slots' output. $600-$63E is GENERATION A (the
	// current generation) and $640-$67E GENERATION B (the previous one); together they
	// form a 64-word ring buffer that holds two generations of sampling data.
	// Like EFREG, it is mirrored once per block and not per sample.
	_mirrorSous()
	{
		for(let i = 0; i < 32; i++)
		{
			const a = this.soundStack[i + 32] & 0xFFFF;    // current generation
			this.reg[0x600 + i * 2] = (a >> 8) & 0xFF;
			this.reg[0x601 + i * 2] = a & 0xFF;
			const b = this.soundStack[i] & 0xFFFF;         // previous generation
			this.reg[0x640 + i * 2] = (b >> 8) & 0xFF;
			this.reg[0x641 + i * 2] = b & 0xFF;
		}
	}

	// Pushes a stereo sample into the ring buffer (drops the oldest if it fills up).
	_push(l, r)
	{
		this.bufLeft[this.writePos] = l;
		this.bufRight[this.writePos] = r;
		this.writePos = (this.writePos + 1) % this.CAP;
		if(this.count < this.CAP) this.count++;
		else this.posRead = (this.posRead + 1) % this.CAP;   // buffer full: overwrite the oldest
	}

	// Stereo samples available to consume.
	samplesAvailable()
	{
		return this.count;
	}

	// Dumps up to `n` samples into the pair of output arrays (Float32, [-1,1]).
	// Fills with silence on underrun. Returns how many real samples
	// were delivered (the rest are zeros). Meant for the Web Audio callback.
	readAudio(outputLeft, outputRight, n)
	{
		let delivered = 0;
		for(let i = 0; i < n; i++)
		{
			if(this.count > 0)
			{
				outputLeft[i] = this.bufLeft[this.posRead];
				outputRight[i] = this.bufRight[this.posRead];
				this.posRead = (this.posRead + 1) % this.CAP;
				this.count--;
				delivered++;
			}
			else
			{
				outputLeft[i] = 0;
				outputRight[i] = 0;
			}
		}
		return delivered;
	}
}

// In Node the class is exported; in the browser it stays a global via <script>.
if(typeof module !== "undefined" && module.exports)
	module.exports = { ScspEngine };
