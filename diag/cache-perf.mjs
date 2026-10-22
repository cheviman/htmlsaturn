// Does the instruction cache SLOW THINGS DOWN instead of speeding up? Measures Rally's clean time with
// the cache on (normal) vs forced off (fetchInstr falls back to readWord directly).
import { readFileSync } from "fs";
import { basename } from "path";
const F = 800;
async function measure(disable){
  const mod = await import("../headless.mjs?cp=" + (disable?"off":"on"));
  const { cpu, cpuSlave, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
  applyBios(basename(resolveBios("us")), new Uint8Array(readFileSync(resolveBios("us"))));
  loadDiscFromCue(resolveGame("rally"));
  for(let f=0; f<1500; f++) runFrame();
  if(disable){ // override fetchInstr so it NEVER uses the cache (measures the cost of the cache)
    for(const c of [cpu, cpuSlave]) if(c) c.fetchInstr = function(d){ return this.readWord(d); };
  }
  const t0 = Number(process.hrtime.bigint())/1e6;
  for(let f=0; f<F; f++) runFrame();
  return (Number(process.hrtime.bigint())/1e6 - t0)/F;
}
const withCache = await measure(false);
const noCache = await measure(true);
console.log("Rally with cache:    " + withCache.toFixed(2) + " ms/frame");
console.log("Rally WITHOUT cache: " + noCache.toFixed(2) + " ms/frame");
console.log("the cache " + (withCache > noCache ? "SLOWS DOWN " + ((withCache/noCache-1)*100).toFixed(0) + "% (it is dead weight)" : "helps"));
