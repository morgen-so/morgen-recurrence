// Differential fuzzing input: fresh random rules (not in fixtures/) with
// expected values from the TypeScript package, written in the fixture format
// so the Dart conformance runner can check them.
//
//   node tools/fuzz.mjs <out.json> [seed] [count]
//   (cd packages/dart && FIXTURES=<out.json> dart test test/conformance_test.dart)
//
// Seed defaults to the current time; it is printed so failures can be
// reproduced.
import fs from 'node:fs';
import { loadTs, evaluate } from './lib/common.mjs';
import { randomCases, weeknoCases, subdailyCases } from './lib/random.mjs';

const [out, seedArg, countArg] = process.argv.slice(2);
if (!out) {
  console.error('usage: node tools/fuzz.mjs <out.json> [seed] [count]');
  process.exit(2);
}
const seed = Number(seedArg ?? Date.now() % 2 ** 31);
const count = Number(countArg ?? 20000);
const lib = loadTs();

const gens = [
  ['random', randomCases(Math.round(count * 0.7), seed)],
  ['weekno', weeknoCases(Math.round(count * 0.2), seed + 1)],
  ['subdaily', subdailyCases(Math.round(count * 0.1), seed + 2)],
];
const cases = [];
for (const [name, gen] of gens) {
  let i = 0;
  for (const c of gen) {
    const got = evaluate(lib, c);
    cases.push({ id: `fuzz-${seed}-${name}-${i++}`, ...c, expected: got && got.error ? { error: true } : got });
  }
}
fs.writeFileSync(out, JSON.stringify({ schema: 1, name: `fuzz-${seed}`, description: `tools/fuzz.mjs seed ${seed}`, cases }));
console.log(`fuzz seed ${seed}: ${cases.length} cases -> ${out}`);
