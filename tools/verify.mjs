// Independent verification of the corpus' expected values.
//
//   node tools/verify.mjs [--dateutil /tmp/du.json] fixtures/*.json
//
// 1. Every case in its scope (DAILY..YEARLY, all BY* parts, BYSETPOS, SKIP,
//    validation) must equal the brute-force oracle in tools/verify/oracle.mjs,
//    written from the RFCs and sharing no code with either package. This is
//    the primary check and needs nothing installed.
// 2. With --dateutil (output of tools/verify/dateutil_eval.py, python-dateutil
//    4.0.0), the remaining cases (sub-daily frequencies, the leap-second
//    policy) are compared with dateutil. Accepted differences are reported
//    separately: dateutil rejects rules that can never match ("empty set") or
//    spins on them (timeout) where the fixture is empty, and drops DTSTART
//    milliseconds. dateutil also disagrees on cases the oracle confirmed
//    (mixed BYDAY, week numbers, weekly BYSETPOS, SKIP); those are counted
//    only for information.
// Anything else is unexplained and fails.
import fs from 'node:fs';
import { oracle } from './verify/oracle.mjs';

const args = process.argv.slice(2);
let du = null;
const di = args.indexOf('--dateutil');
if (di >= 0) {
  du = JSON.parse(fs.readFileSync(args[di + 1], 'utf8'));
  args.splice(di, 2);
}

const empty = (e) => e === null || (Array.isArray(e) && e.length === 0);
const stats = {
  cases: 0,
  oracleChecked: 0,
  oracleAgrees: 0,
  outOfOracleScope: 0,
  dateutilAgrees: 0,
  dateutilAgreesIgnoringMs: 0,
  dateutilRejectsEmptyRule: 0,
  dateutilTimesOutOnEmptyRule: 0,
  dateutilRejectsLeapSecond: 0,
  notChecked: 0,
  infoDateutilDiffersWhereOracleConfirms: 0,
};
const unexplained = [];
for (const file of args) {
  for (const c of JSON.parse(fs.readFileSync(file, 'utf8')).cases) {
    stats.cases++;
    const exp = JSON.stringify(c.expected);
    const o = oracle(c);
    const d = du?.[c.id];
    const dGot = d && 'got' in d ? JSON.stringify(d.got) : null;
    if (o !== undefined) {
      stats.oracleChecked++;
      if (JSON.stringify(o) === exp) {
        stats.oracleAgrees++;
        if (du && dGot !== exp && !(c.expected?.error && d?.error)) stats.infoDateutilDiffersWhereOracleConfirms++;
      } else {
        unexplained.push({ why: 'oracle differs', c, other: o });
      }
      continue;
    }
    stats.outOfOracleScope++;
    if (!du) {
      stats.notChecked++;
      continue;
    }
    if (dGot === exp || (c.expected?.error && d?.error)) {
      stats.dateutilAgrees++;
      continue;
    }
    // dateutil drops milliseconds of DTSTART (both libraries keep them).
    if (dGot && /\.\d{3}$/.test(c.dtstart) && dGot === exp.replace(/\.\d{3}"/g, '"')) {
      stats.dateutilAgreesIgnoringMs++;
      continue;
    }
    if (d?.error && /empty (set|rule)/.test(d.error) && empty(c.expected)) {
      stats.dateutilRejectsEmptyRule++;
      continue;
    }
    // Leap-second policy: BYSECOND=60 is accepted and never matches here;
    // dateutil rejects it.
    if (d?.error && /second must be in 0\.\.59/.test(d.error) && /BYSECOND=[^;]*\b60\b/.test(c.rrule)) {
      stats.dateutilRejectsLeapSecond++;
      continue;
    }
    if (d?.hang && empty(c.expected)) {
      stats.dateutilTimesOutOnEmptyRule++;
      continue;
    }
    unexplained.push({ why: 'dateutil differs', c, other: d });
  }
}
console.log(stats);
for (const u of unexplained.slice(0, 25)) {
  console.log(`\n✗ ${u.why}: ${u.c.id} DTSTART=${u.c.dtstart} RRULE:${u.c.rrule} ${JSON.stringify(u.c.query)}`);
  console.log(`  fixture ${JSON.stringify(u.c.expected)}`);
  console.log(`  other   ${JSON.stringify(u.other?.got ?? u.other)}`);
}
console.log(`\nunexplained: ${unexplained.length}`);
process.exit(unexplained.length ? 1 : 0);
