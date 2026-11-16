// Independent verification of the corpus' expected values.
//
//   python -I tools/verify/dateutil_eval.py /tmp/du.json fixtures/*.json
//   node tools/verify.mjs /tmp/du.json fixtures/*.json
//
// Every case is compared with python-dateutil 4.0.0. Known, intended
// disagreements are accepted only when a second oracle confirms the fixture:
//  * mixed plain + nth BYDAY (MONTHLY/YEARLY): dateutil intersects like
//    rrule.js did; the fixture must equal a brute-force day-by-day RFC 5545
//    evaluator (bruteForce below);
//  * dateutil hangs (rule never matches, it iterates to year 9999): the
//    fixture must be empty, and the rule must also be empty by brute force
//    when it is in the brute-force scope.
// Anything else is reported as unexplained and fails.
import fs from 'node:fs';

const [duPath, ...files] = process.argv.slice(2);
const du = JSON.parse(fs.readFileSync(duPath, 'utf8'));
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const fmt = (d) => d.toISOString().slice(0, 19);

function parseRule(s) {
  const r = {};
  for (const part of s.split(';')) {
    const [k, v] = part.split('=');
    r[k] = v;
  }
  const ints = (k) => (r[k] ? r[k].split(',').map(Number) : null);
  return {
    freq: r.FREQ, interval: Number(r.INTERVAL ?? 1), count: r.COUNT ? Number(r.COUNT) : null,
    until: r.UNTIL ? r.UNTIL.replace(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d))?Z?$/, (_, y, mo, d, h = '00', mi = '00', s = '00') => `${y}-${mo}-${d}T${h}:${mi}:${s}`) : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map((x) => { const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/); return { n: m[1] ? Number(m[1]) : null, day: m[2] }; }) : null,
    bymonth: ints('BYMONTH'), bymonthday: ints('BYMONTHDAY'), byhour: ints('BYHOUR'), byminute: ints('BYMINUTE'),
    bysetpos: ints('BYSETPOS'),
    other: ['BYWEEKNO', 'BYYEARDAY', 'BYSECOND'].some((k) => r[k]),
  };
}

/** In scope: MONTHLY/YEARLY with BYDAY, no BYWEEKNO/BYYEARDAY/BYSECOND. */
function bruteScope(c) {
  const r = parseRule(c.rrule);
  return (r.freq === 'MONTHLY' || r.freq === 'YEARLY') && r.byday && !r.other && c.query.method !== 'before' && c.query.method !== 'after';
}

/** Brute-force RFC 5545 evaluation: checks every day from DTSTART on. */
function bruteForce(c) {
  const r = parseRule(c.rrule), q = c.query;
  const s = new Date(`${c.dtstart}Z`);
  const until = r.until ? new Date(`${r.until}Z`) : null;
  const after = q.method === 'between' ? new Date(`${q.after}Z`) : null;
  const before = q.method === 'between' ? new Date(`${q.before}Z`) : null;
  const limit = q.limit ?? Infinity;
  const hours = [...new Set(r.byhour ?? [s.getUTCHours()])].sort((a, b) => a - b);
  const mins = [...new Set(r.byminute ?? [s.getUTCMinutes()])].sort((a, b) => a - b);
  const y0 = s.getUTCFullYear(), m0 = s.getUTCMonth() + 1;
  const stop = new Date(Math.min(until ? until.getTime() : Infinity, before ? before.getTime() : Infinity, Date.UTC(y0 + 120, 0, 1)));
  // 1. Candidate occurrences per period (month or year), by checking every day.
  const periods = new Map();
  for (let t = r.freq === 'YEARLY' ? Date.UTC(y0, 0, 1) : Date.UTC(y0, m0 - 1, 1); t <= stop.getTime() + 366 * 86400000; t += 86400000) {
    const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, md = d.getUTCDate(), wd = DAYS[d.getUTCDay()];
    const period = r.freq === 'MONTHLY' ? y * 12 + m - (y0 * 12 + m0) : y - y0;
    if (period % r.interval) continue;
    if (r.bymonth && !r.bymonth.includes(m)) continue;
    if (r.bymonthday && !r.bymonthday.some((v) => (v > 0 ? v === md : dim(y, m) + 1 + v === md))) continue;
    const inYear = r.freq === 'YEARLY' && !r.bymonth;
    const ok = r.byday.some((b) => {
      if (b.day !== wd) return false;
      if (b.n == null) return true;
      const first = inYear ? Date.UTC(y, 0, 1) : Date.UTC(y, m - 1, 1);
      const last = inYear ? Date.UTC(y, 11, 31) : Date.UTC(y, m - 1, dim(y, m));
      const k = b.n > 0 ? Math.floor((t - first) / 86400000 / 7) + 1 : -(Math.floor((last - t) / 86400000 / 7) + 1);
      return k === b.n;
    });
    if (!ok) continue;
    if (!periods.has(period)) periods.set(period, []);
    for (const h of hours) for (const mi of mins) periods.get(period).push(Date.UTC(y, m - 1, md, h, mi, s.getUTCSeconds()));
  }
  // 2. BYSETPOS per period (RFC 5545: positions within the period's set;
  //    out-of-range positions select nothing), then DTSTART/COUNT/UNTIL.
  const out = [];
  let count = 0;
  for (const p of [...periods.keys()].sort((a, b) => a - b)) {
    let set = periods.get(p).sort((a, b) => a - b);
    if (r.bysetpos) {
      set = [...new Set(r.bysetpos.map((pos) => set[pos > 0 ? pos - 1 : set.length + pos]).filter((x) => x !== undefined))].sort((a, b) => a - b);
    }
    for (const ms of set) {
      const occ = new Date(ms);
      if (occ < s) continue;
      if (until && occ > until) return out;
      if (before && (q.inc ? occ > before : occ >= before)) return out;
      if (occ > stop) return out;
      count++;
      if (!after || (q.inc ? occ >= after : occ > after)) {
        if (out.length >= limit) return out;
        out.push(fmt(occ));
      }
      if (r.count && count >= r.count) return out;
    }
  }
  return out;
}

const isMixed = (c) => {
  const b = parseRule(c.rrule).byday ?? [];
  const f = parseRule(c.rrule).freq;
  return (f === 'MONTHLY' || f === 'YEARLY') && b.some((x) => x.n != null) && b.some((x) => x.n == null);
};
const empty = (e) => e === null || (Array.isArray(e) && e.length === 0);

const stats = { cases: 0, dateutilAgrees: 0, dateutilAgreesIgnoringMs: 0, dateutilRejectsEmptyRule: 0, mixedBydayConfirmedByBruteForce: 0, dateutilHangsOnEmptyRule: 0, bruteForceChecked: 0, bruteForceAgrees: 0 };
const unexplained = [];
for (const file of files) {
  for (const c of JSON.parse(fs.readFileSync(file, 'utf8')).cases) {
    stats.cases++;
    const exp = JSON.stringify(c.expected);
    const inBrute = bruteScope(c) && !(c.expected && c.expected.error);
    let brute = null;
    if (inBrute) {
      brute = JSON.stringify(bruteForce(c));
      stats.bruteForceChecked++;
      if (brute === exp) stats.bruteForceAgrees++;
      else unexplained.push({ why: 'brute force differs', c, brute });
    }
    const d = du[c.id];
    if (d && 'got' in d && JSON.stringify(d.got) === exp) { stats.dateutilAgrees++; continue; }
    if (c.expected && c.expected.error && d && d.error) { stats.dateutilAgrees++; continue; }
    // dateutil drops milliseconds of DTSTART (rrule.js keeps them).
    if (d && 'got' in d && /\.\d{3}$/.test(c.dtstart) && JSON.stringify(d.got) === exp.replace(/\.\d{3}"/g, '"')) { stats.dateutilAgreesIgnoringMs++; continue; }
    // dateutil rejects rules whose BY* parts can never be reached.
    if (d && d.error && /empty (set|rule)/.test(d.error) && empty(c.expected)) { stats.dateutilRejectsEmptyRule++; continue; }
    if (isMixed(c) && inBrute && brute === exp) { stats.mixedBydayConfirmedByBruteForce++; continue; }
    if (d && d.hang && empty(c.expected) && (!inBrute || brute === exp)) { stats.dateutilHangsOnEmptyRule++; continue; }
    unexplained.push({ why: 'dateutil differs', c, dateutil: d });
  }
}
console.log(stats);
const seen = new Set();
for (const u of unexplained) {
  if (seen.has(u.c.id)) continue;
  seen.add(u.c.id);
  if (seen.size > 25) break;
  console.log(`\n✗ ${u.why}: ${u.c.id} DTSTART=${u.c.dtstart} RRULE:${u.c.rrule} ${JSON.stringify(u.c.query)}`);
  console.log(`  fixture  ${JSON.stringify(u.c.expected)}`);
  if (u.dateutil) console.log(`  dateutil ${JSON.stringify(u.dateutil.got ?? u.dateutil)}`);
  if (u.brute) console.log(`  brute    ${u.brute}`);
}
console.log(`\nunexplained: ${new Set(unexplained.map((u) => u.c.id)).size}`);
process.exit(unexplained.length ? 1 : 0);
