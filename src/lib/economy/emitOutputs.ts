// src/lib/economy/emitOutputs.ts
//
// Writes RUN_OUTPUT.txt and SWEEP_OUTPUT.txt. Kept as a library function rather
// than a script so it goes through the same TS pipeline as everything else —
// a second toolchain is a second thing that can disagree with the first.

import { writeFileSync } from 'node:fs';
import { runDefaultWorld, renderWorldRun } from './worldRun';
import { sweepWorlds, renderSweep } from './worldSweep';

export function emitOutputs(now: string, dir = '.'): { run: string; sweep: string } {
  const run = renderWorldRun(runDefaultWorld(now));
  const sweep = renderSweep(sweepWorlds(now));
  writeFileSync(`${dir}/RUN_OUTPUT.txt`, run);
  writeFileSync(`${dir}/SWEEP_OUTPUT.txt`, sweep);
  return { run, sweep };
}
