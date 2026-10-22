// The SF Alpha slave dies executing zeros at 0x0600ff12 (its spin-wait). Who erases
// the code under its feet? Watch that address: find the frame where the word
// turns 0 and through which path it was written (master CPU, SCU DMA, SH-2 DMA).
import { readFileSync } from "fs";
import { basename } from "path";
const ADDR = 0x0600ff12;
const mod = await import("../headless.mjs?slavemuerte=1");
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios } = mod;
const bios = resolveBios("us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue("roms/Street Fighter Alpha - Warriors Dreams (USA)");
const START = 0x08, BTN_A = 0x04;
// instrument the bus writes that land in the spin zone (0x0600ff00-0x0600ff40)
let writes = [];
const inZone = (d) => { const a = d >>> 0; return a >= 0x0600ff00 && a < 0x0600ff40; };
for(const fn of ["writeByte","writeWord","writeLong"]){
  const orig = bus[fn].bind(bus);
  bus[fn] = (d,v) => { if(inZone(d) && writes.length < 40) writes.push({fn, d:(d>>>0).toString(16), v:(v>>>0).toString(16), f:currentFrame}); return orig(d,v); };
}
let currentFrame = 0;
let lastOp = -1, warned = false;
for(let f=1; f<=12000; f++){
  currentFrame = f;
  bus.pad1a = (f % 30 < 8) ? (0xFF & ~(START|BTN_A)) : 0xFF;
  runFrame();
  let op = -1; try{ op = bus.readWord(ADDR) & 0xFFFF; }catch(e){}
  if(op !== lastOp){
    console.log("f=" + String(f).padStart(5) + "  word@0x600ff12 = 0x" + (op>>>0).toString(16).padStart(4,'0') + (op===0 ? "   <<< ERASED" : ""));
    lastOp = op;
  }
  const s = mod.cpuSlave;
  if(s && s.halted && !warned){ console.log("  >>> the slave STOPPED at frame " + f + " (pc=0x"+(s.pc>>>0).toString(16)+")"); warned = true; }
}
console.log("\nwrites to the spin zone (0x600ff00-0x600ff40), first " + writes.length + ":");
for(const e of writes.slice(0,20)) console.log("   f=" + e.f + "  " + e.fn + "(0x" + e.d + ", 0x" + e.v + ")");
