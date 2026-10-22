// WHICH CD COMMANDS THE BIOS SENDS AFTER A DISC CHANGE, COLD AND HOT.
// The difference between the two sequences is the missing circuit.
import { readFileSync } from "fs";
import { basename } from "path";
const GAME = process.argv[2] || "rally";
const MOUNT = parseInt(process.argv[3] || "400", 10);
const VER = parseInt(process.argv[4] || "400", 10);
const hx = (v) => "0x" + (v >>> 0).toString(16);
const NAME = { 0x00:"GetStatus",0x01:"GetHwInfo",0x02:"GetToc",0x03:"GetSession",0x04:"InitCd",
  0x05:"OpenTray",0x06:"EndDataTr",0x10:"Play",0x11:"Seek",0x20:"GetSubQ",0x30:"SetCdDevConn",
  0x31:"GetCdDevConn",0x32:"GetLastBuf",0x40:"SetFilterRange",0x41:"GetFilterRange",
  0x42:"SetFilterSub",0x43:"GetFilterSub",0x44:"SetFilterMode",0x45:"GetFilterMode",
  0x46:"SetFilterConn",0x47:"GetFilterConn",0x48:"ResetSel",0x50:"GetBufSize",0x51:"GetSectNum",
  0x52:"CalcActSize",0x53:"GetActSize",0x54:"GetSectInfo",0x55:"ExecFadSearch",0x60:"SetSectLen",
  0x61:"GetSectData",0x62:"DelSectData",0x63:"GetDelSectData",0x64:"PutSectData",0x65:"CopySectData",
  0x66:"MoveSectData",0x67:"GetCopyErr",0x70:"ChangeDir",0x71:"ReadDir",0x72:"GetFileScope",
  0x73:"GetFileInfo",0x74:"ReadFile",0x75:"AbortFile" };
async function run(mode){
  const m = await import("../headless.mjs?dseq=" + mode + GAME);
  const b = m.resolveBios("us");
  m.applyBios(basename(b), new Uint8Array(readFileSync(b)));
  const cmds = [];
  let watching = false, frame = 0;
  const orig = m.bus._cdCommandRequest.bind(m.bus);
  m.bus._cdCommandRequest = () => {
    if(watching && cmds.length < 500){
      const cr1 = ((m.bus.cdRegs[0x18] << 8) | m.bus.cdRegs[0x19]) & 0xFFFF;
      cmds.push({ f: frame, c: cr1 >> 8 });
    }
    return orig();
  };
  if(mode === "cold"){
    m.loadDiscFromCue(m.resolveGame(GAME));
    for(; frame < MOUNT; frame++) m.runFrame();
    watching = true;
    for(; frame < MOUNT + VER; frame++) m.runFrame();
  } else {
    for(; frame < MOUNT; frame++) m.runFrame();
    m.loadDiscFromCue(m.resolveGame(GAME));
    watching = true;
    for(; frame < MOUNT + VER; frame++) m.runFrame();
  }
  // Compressed sequence: consecutive identical commands are collapsed
  const seq = [];
  for(const x of cmds){
    const n = NAME[x.c] || hx(x.c);
    if(seq.length && seq[seq.length-1].n === n) seq[seq.length-1].times++;
    else seq.push({ n: n, times: 1, f: x.f });
  }
  return { total: cmds.length, seq: seq, zone: (m.bus.cpuMaster.pc >>> 0) >= 0x06000000 ? "disc" : "bios" };
}
const F = await run("cold"), C = await run("hot");
const fmt = (s) => s.seq.slice(0, 22).map(x => x.n + (x.times > 1 ? "x" + x.times : "")).join(" -> ");
console.log(GAME.toUpperCase() + " — CD commands in the " + VER + " frames after the disc appears");
console.log("");
console.log("  COLD     (" + F.total + " commands, ends at " + F.zone + "):");
console.log("     " + fmt(F));
console.log("");
console.log("  HOT      (" + C.total + " commands, ends at " + C.zone + "):");
console.log("     " + fmt(C));
console.log("");
const fs_ = F.seq.map(x=>x.n), cs = C.seq.map(x=>x.n);
let i = 0; while(i < fs_.length && i < cs.length && fs_[i] === cs[i]) i++;
console.log(i >= Math.min(fs_.length, cs.length)
  ? "  => both sequences start the same as far as they can be compared"
  : "  => they DIVERGE at step " + (i+1) + ": cold does " + (fs_[i]||"-") + " and hot does " + (cs[i]||"-"));
