// Regenerates the shared conformance corpus in fixtures/.
//
//   (cd packages/ts && npm run build) && node tools/gen-fixtures.mjs
//
// Expected values come from the fixed TypeScript package. Hand-verified
// expectations (regressions, RFC 5545 examples, rrule.js's own suite) are
// asserted here, so a regenerated corpus can never silently drift from them.
// Independent verification against python-dateutil and a brute-force
// evaluator: tools/verify.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, loadTs, evaluate } from './lib/common.mjs';
import { randomCases, weeknoCases, subdailyCases } from './lib/random.mjs';
import { rrulejsSuiteCases } from './lib/rrulejs-suite.mjs';
import { RFC5545, REGRESSIONS } from './lib/handwritten.mjs';

const lib = loadTs();
const SCHEMA = 1;
let failures = 0;

function fill(cases, prefix, check) {
  return cases.map((c, i) => {
    const got = evaluate(lib, c);
    const expected = got && got.error ? { error: true } : got;
    if (check) {
      const msg = check(c, got);
      if (msg) {
        failures++;
        console.error(`✗ ${prefix}-${i} ${c.rrule}: ${msg}\n   got ${JSON.stringify(got)}`);
      }
    }
    const { upstreamExpected, rfcExpected, ...rest } = c;
    return { id: `${prefix}-${String(i).padStart(4, '0')}`, ...rest, expected };
  });
}

function write(name, description, cases) {
  const file = path.join(FIXTURES, `${name}.json`);
  const body = { schema: SCHEMA, name, description, generatedBy: 'tools/gen-fixtures.mjs', cases };
  // One case per line: diffable and still plain JSON.
  const json = `{\n${Object.entries(body)
    .filter(([k]) => k !== 'cases')
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join('\n')}\n  "cases": [\n${cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`;
  fs.writeFileSync(file, json);
  console.log(`${name}.json: ${cases.length} cases`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

fs.mkdirSync(FIXTURES, { recursive: true });

write(
  'regressions',
  'One or more cases per rrule.js 2.8.0 bug fixed in this fork; expected values verified by hand.',
  fill(REGRESSIONS, 'regression', (c, got) => (same(got, c.expected) ? null : `expected ${JSON.stringify(c.expected)}`)),
);

write(
  'rfc5545',
  'Examples of RFC 5545 section 3.8.5.3 (floating times; EXDATE/RDATE omitted). rfcExpected prefixes are checked at generation.',
  fill(RFC5545, 'rfc', (c, got) => {
    if (!c.rfcExpected) return null;
    const head = Array.isArray(got) ? got.slice(0, c.rfcExpected.length) : got;
    return same(head, c.rfcExpected) ? null : `RFC lists ${JSON.stringify(c.rfcExpected)}`;
  }),
);

const suite = rrulejsSuiteCases(lib);
console.log('rrule.js suite skipped:', suite.skipped);
write(
  'rrulejs-suite',
  "rrule.js 2.8.0's own testRecurring cases (test/rrule.test.ts), excluding TZID, BYEASTER and RRuleSet.",
  fill(suite.cases, 'rrulejs', (c, got) => (same(got, c.upstreamExpected) ? null : `upstream test expects ${JSON.stringify(c.upstreamExpected)}`)),
);

write(
  'random',
  'Random DAILY..YEARLY rules biased towards edge cases (seed 1), first 40 occurrences within 10 years.',
  fill([...randomCases(4000, 1)], 'random'),
);
write(
  'weekno',
  'Random BYWEEKNO/BYYEARDAY rules with every WKST (seed 11).',
  fill([...weeknoCases(1500, 11)], 'weekno'),
);
write(
  'subdaily',
  'Random HOURLY/MINUTELY/SECONDLY rules, including unreachable BYHOUR/BYMINUTE (seed 21).',
  fill([...subdailyCases(800, 21)], 'subdaily'),
);

if (failures) {
  console.error(`\n${failures} hand-verified expectation(s) failed`);
  process.exit(1);
}
