// Do games TURN ON the instruction cache? CCR (0xFFFFFE92): bit0 CE (enable),
// bit4 CP (purge). If CE never turns on, implementing the cache changes nothing.
// Records the writes to the CCR from EACH CPU (master and slave) and the final value.
import { readFileSync } from "fs";
import { basename } from "path";
const GAME = process.argv[2] || "sfa";
const FRAMES = parseInt(process.argv[3] || "2000", 10);
const PATHS = {
  sfa:   "roms/Street Fighter Alpha - Warriors Dreams (USA)",
  sonic: "roms/Sonic 3D Blast (USA)",
  vc:    "roms/Virtua Cop (USA) (7S)",
  rally: "roms/Sega Rally Championship Plus Netlink Edition (USA)",
};
const mod = await import("../headless.mjs?ccr=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios } = mod;
const bios = resolveBios("us");
applyBios(basename(bios), new Uint8Array(readFileSync(bios)));
loadDiscFromCue(PATHS[GAME] || GAME);
const writes = { master: [], slave: [] };
const purges = { master: 0, slave: 0 };
function instrument(cpu, name){
  if(!cpu) return;
  const orig = cpu.writeInternal.bind(cpu);
  cpu.writeInternal = (addr, value, size) => {
    const off = addr & 0x1FF;
    if(off === 0x92 || (off <= 0x92 && off + size > 0x92)){
      const v = value & 0xFF;
      if(writes[name].length < 12) writes[name].push("0x" + v.toString(16) + (v & 1 ? " (CE ON)" : " (CE off)") + (v & 0x10 ? " +PURGE" : ""));
      if(v & 0x10) purges[name]++;
    }
    return orig(addr, value, size);
  };
}
instrument(mod.cpu, "master");
const START = 0x08;
for(let f=1; f<=FRAMES; f++){
  if(mod.cpuSlave && !mod.cpuSlave._instr){ instrument(mod.cpuSlave, "slave"); mod.cpuSlave._instr = true; }
  bus.pad1a = (f % 30 < 8) ? (0xFF & ~START) : 0xFF;
  runFrame();
}
console.log("=== " + GAME + " (" + FRAMES + " frames) ===");
for(const n of ["master","slave"]){
  const cpu = n === "master" ? mod.cpu : mod.cpuSlave;
  const ccr = cpu ? (cpu.internalRegs[0x92] & 0xFF) : -1;
  console.log(n + ": final CCR = 0x" + (ccr>>>0).toString(16) + "  -> cache " + (ccr & 1 ? "ON" : "off") + "   purges=" + purges[n]);
  console.log("   writes to the CCR: " + (writes[n].length ? writes[n].join(", ") : "NONE"));
}
