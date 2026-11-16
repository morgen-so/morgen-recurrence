// Shared helpers for the fixture tools.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = path.join(ROOT, 'fixtures');
const require = createRequire(import.meta.url);

/** The fixed TypeScript package (built: `npm run build` in packages/ts). */
export function loadTs() {
  return require(path.join(ROOT, 'packages/ts/dist/cjs/index.js'));
}

/** Deterministic PRNG (mulberry32) with sampling helpers. */
export function prng(seedArg) {
  let seed = Number(seedArg) >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const chance = (p) => rnd() < p;
  const sample = (arr, n) => [...arr].sort(() => rnd() - 0.5).slice(0, n);
  return { rnd, int, pick, chance, sample };
}

export const pad = (n, w = 2) => String(n).padStart(w, '0');
/** Floating ISO string (milliseconds only when non-zero). */
export const fmt = (d) => {
  const s = d.toISOString();
  return s.endsWith('.000Z') ? s.slice(0, 19) : s.slice(0, 23);
};
export const parseFloating = (s) => new Date(`${s}Z`);

/** JSCalendar RecurrenceRule -> RFC 5545 RRULE value (floating UNTIL). */
export function toRRuleString(r) {
  const parts = [`FREQ=${r.frequency.toUpperCase()}`];
  if (r.interval) parts.push(`INTERVAL=${r.interval}`);
  if (r.count != null) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/[-:]/g, '')}`);
  if (r.byDay) {
    parts.push(`BYDAY=${r.byDay.map((d) => `${d.nthOfPeriod ?? ''}${d.day.toUpperCase()}`).join(',')}`);
  }
  if (r.byMonthDay) parts.push(`BYMONTHDAY=${r.byMonthDay.join(',')}`);
  if (r.byMonth) parts.push(`BYMONTH=${r.byMonth.join(',')}`);
  if (r.byYearDay) parts.push(`BYYEARDAY=${r.byYearDay.join(',')}`);
  if (r.byWeekNo) parts.push(`BYWEEKNO=${r.byWeekNo.join(',')}`);
  if (r.byHour) parts.push(`BYHOUR=${r.byHour.join(',')}`);
  if (r.byMinute) parts.push(`BYMINUTE=${r.byMinute.join(',')}`);
  if (r.bySecond) parts.push(`BYSECOND=${r.bySecond.join(',')}`);
  if (r.bySetPosition) parts.push(`BYSETPOS=${r.bySetPosition.join(',')}`);
  if (r.firstDayOfWeek) parts.push(`WKST=${r.firstDayOfWeek.toUpperCase()}`);
  return parts.join(';');
}

/**
 * Evaluates one fixture case with a given rrule.js-compatible module
 * (the fixed package, or upstream rrule for comparisons).
 * Returns an array of floating strings, a single string/null for
 * before/after, or {error}.
 */
export function evaluate(lib, c) {
  const { RRule } = lib;
  try {
    const opts = RRule.parseString(c.rrule);
    opts.dtstart = parseFloating(c.dtstart);
    const rule = new RRule(opts);
    const q = c.query;
    const limit = q.limit ?? Infinity;
    const cb = (_, n) => n < limit;
    switch (q.method) {
      case 'all':
        return rule.all(cb).map(fmt);
      case 'between':
        return rule.between(parseFloating(q.after), parseFloating(q.before), !!q.inc, cb).map(fmt);
      case 'before':
      case 'after': {
        const d = rule[q.method](parseFloating(q.dt), !!q.inc);
        return d ? fmt(d) : null;
      }
      default:
        throw new Error(`unknown method ${q.method}`);
    }
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}
