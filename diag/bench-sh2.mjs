// Bench for optimizing the SH-2: measures ms/frame (with warm-up for the JIT) and a hash of the
// final state. A valid optimization SPEEDS UP and leaves the hash IDENTICAL to the baseline.
// Usage: node diag/bench-sh2.mjs [game=rally] [frames=2000] [warmup=500]
import { readFileSync } from "fs";
import { basename } from "path";
const GAME = process.argv[2] || "rally";
const FRAMES = parseInt(process.argv[3] || "2000", 10);
const WARM = parseInt(process.argv[4] || "500", 10);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const mod = await import("../headless.mjs?bench=" + GAME);
const { bus, runFrame, applyBios, loadDiscFromCue, resolveBios, resolveGame } = mod;
const BIOS = { xmen:"jp" }[GAME] || "us";
applyBios(basename(resolveBios(BIOS)), new Uint8Array(readFileSync(resolveBios(BIOS))));
loadDiscFromCue(resolveGame(GAME));
for(let f=0; f<WARM; f++) runFrame();          // warm-up (JIT + reaching steady state)
const t0 = now();
for(let f=0; f<FRAMES; f++) runFrame();
const ms = (now() - t0) / FRAMES;
// hash of the final state
let h = 2166136261 >>> 0;
const mix = (x) => { h ^= (x>>>0); h = Math.imul(h, 16777619) >>> 0; };
const c = mod.cpu; mix(c.pc); for(let i=0;i<16;i++) mix(c.r[i]); mix(c.sr); mix(c.pr); mix(c.gbr); mix(c.vbr); mix(c.cycles);
if(mod.cpuSlave){ const s=mod.cpuSlave; mix(s.pc); for(let i=0;i<16;i++) mix(s.r[i]); mix(s.sr); mix(s.cycles); }
for(let a=0x06000000; a<0x06100000; a+=0x800) { try{ mix(bus.readLong(a)); }catch(e){} }
console.log(GAME + ": " + ms.toFixed(3) + " ms/frame   hash=" + h.toString(16) + "   (" + FRAMES + "f, warm " + WARM + ")");
