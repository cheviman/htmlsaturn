// Is the instruction cache ACTIVE after boot? (if cacheOn=false or the icache is empty,
// it does nothing and would not fix the slave crash).
import { readFileSync } from "fs";
import { basename } from "path";
import { cpu, cpuSlave, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } from "../headless.mjs";
applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
loadDiscFromCue(resolveGame("rally"));
for(let f=0; f<2000; f++) runFrame();
console.log("master: cacheOn="+cpu.cacheOn+" icache.size="+cpu.icache.size);
console.log("slave:  cacheOn="+(cpuSlave?cpuSlave.cacheOn:"n/a")+" icache.size="+(cpuSlave?cpuSlave.icache.size:"n/a"));
