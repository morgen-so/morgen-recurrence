// Benchmark: upstream rrule.js 2.8.0 vs this fork, same workloads.
//   npm run bench            (builds first)
// Each workload runs a few warm-up rounds, then reports the median of the
// measured rounds. Rules that never match are measured separately: upstream
// iterates them to year 9999.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const fork = require(path.join(here, '../dist/cjs/index.js'));
const upstream = require('rrule');
const fixtures = path.join(here, '../../../fixtures');

const parse = (s) => new Date(`${s}Z`);
const load = (f) => JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8')).cases;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function bench(name, fn, { warmup = 3, rounds = 9 } = {}) {
  const res = {};
  for (const [label, lib] of [['rrule.js 2.8.0', upstream], ['@morgen-so/rrule', fork]]) {
    let out;
    for (let i = 0; i < warmup; i++) out = fn(lib);
    const times = [];
    for (let i = 0; i < rounds; i++) {
      const t = process.hrtime.bigint();
      out = fn(lib);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    res[label] = { ms: median(times), out };
  }
  const [a, b] = Object.values(res);
  console.log(
    `${name.padEnd(58)} ${a.ms.toFixed(2).padStart(9)} ms ${b.ms.toFixed(2).padStart(9)} ms  ${(a.ms / b.ms).toFixed(1).padStart(5)}x  (${b.out} occurrences)`,
  );
}

// Typical event expansion: rrulestr with a UTC DTSTART
// line, between() over a window, no limit.
function expand(lib, cases, windowDays) {
  let n = 0;
  for (const c of cases) {
    const start = parse(c.dtstart);
    const set = lib.rrulestr(`DTSTART;TZID=UTC:${c.dtstart.replace(/[-:]/g, '')}\nRRULE:${c.rrule}`);
    n += set.between(new Date(start.getTime() - 2 * 86400000), new Date(start.getTime() + windowDays * 86400000), true).length;
  }
  return n;
}

const random = load('random.json').filter((c) => Array.isArray(c.expected) && c.expected.length > 0);
const emptyRules = load('random.json').filter((c) => Array.isArray(c.expected) && c.expected.length === 0);
const weekno = load('weekno.json').filter((c) => Array.isArray(c.expected) && c.expected.length > 0);

console.log(`node ${process.version}\n`);
console.log(`${'workload'.padEnd(58)} ${'rrule.js'.padStart(12)} ${'fork'.padStart(12)}  speedup`);

bench(`random.json rules (${random.length}), expand 1 year`, (lib) => expand(lib, random, 365));
bench(`random.json rules (${random.length}), expand 3 years`, (lib) => expand(lib, random, 3 * 365), { rounds: 5 });
bench(`weekno.json rules (${weekno.length}), expand 1 year`, (lib) => expand(lib, weekno, 365), { rounds: 5 });

const typical = [
  ['weekly MO,WE,FR', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'],
  ['daily', 'FREQ=DAILY'],
  ['weekdays', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  ['monthly 2nd Tuesday', 'FREQ=MONTHLY;BYDAY=2TU'],
  ['monthly last weekday (BYSETPOS)', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'],
  ['yearly', 'FREQ=YEARLY'],
  ['every 2 weeks TU,TH', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH'],
].map(([name, rrule]) => ({ name, dtstart: '2020-03-02T09:30:00', rrule }));
for (const t of typical) {
  bench(`${t.name}: 1000 x expand 2020..2026`, (lib) => {
    let n = 0;
    for (let i = 0; i < 1000; i++) n += expand(lib, [t], 6 * 365);
    return n / 1000;
  }, { rounds: 5 });
}

bench('daily, 50 years, all() with COUNT=18250', (lib) => {
  const r = new lib.RRule({ freq: lib.RRule.DAILY, dtstart: parse('2000-01-01T09:00:00'), count: 18250 }, true);
  return r.all().length;
}, { rounds: 5 });

bench('hourly, 1 year window', (lib) => {
  const r = new lib.RRule({ freq: lib.RRule.HOURLY, dtstart: parse('2024-01-01T00:00:00') }, true);
  return r.between(parse('2024-01-01T00:00:00'), parse('2025-01-01T00:00:00'), true).length;
}, { rounds: 5 });

const subset = emptyRules.slice(0, 3);
bench(`never-matching rules (${subset.length} of ${emptyRules.length}), 10-year between`, (lib) => {
  let n = 0;
  for (const c of subset) {
    const o = lib.RRule.parseString(c.rrule);
    o.dtstart = parse(c.dtstart);
    n += new lib.RRule(o, true).between(parse(c.query.after), parse(c.query.before), true).length;
  }
  return n;
}, { warmup: 1, rounds: 1 });
