// Independent brute-force evaluator of RRULEs, for checking the corpus.
//
// Written from RFC 5545 section 3.3.10 (and RFC 7529 / RFC 8984 section
// 4.3.3.1 for SKIP), sharing no code with either package. It walks every day
// of every period, applies each BY* part as a plain predicate on that day,
// then BYSETPOS, DTSTART, COUNT and UNTIL. Calendar arithmetic uses its own
// proleptic-Gregorian day numbers (not JavaScript Date); week numbers use
// the "week containing January 4" definition (ISO 8601 with WKST).
//
// Scope: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY. Returns undefined for anything
// else (sub-daily frequencies, BYEASTER).
//
// Documented choices where the RFCs leave room, matching the libraries:
//  * BYDAY ordinals only count for MONTHLY and YEARLY (within the month when
//    YEARLY has BYMONTH); for other frequencies 2MO means MO.
//  * Plain and nth BYDAY values are alternatives (a day matching either).
//  * With no BYWEEKNO/BYYEARDAY/BYMONTHDAY/BYDAY, DTSTART supplies the
//    missing parts (YEARLY: month and day; MONTHLY: day; WEEKLY: weekday).

const pymod = (a, b) => ((a % b) + b) % b;

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant). */
export function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const weekday = (z) => pymod(z + 3, 7); // Monday = 0; 1970-01-01 was a Thursday
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthLen = (y, m) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const DAYS = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const p2 = (n) => String(n).padStart(2, '0');

function parseStamp(s) {
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{3}))?$/);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], ms: m[7] ? +m[7] : 0 };
}
/** Sortable key of a floating time: milliseconds since 1970 (own arithmetic). */
const key = (z, h, mi, s, ms) => (((z * 24 + h) * 60 + mi) * 60 + s) * 1000 + ms;
function fromKey(k) {
  const z = Math.floor(k / 86400000);
  let r = k - z * 86400000;
  const h = Math.floor(r / 3600000); r -= h * 3600000;
  const mi = Math.floor(r / 60000); r -= mi * 60000;
  const s = Math.floor(r / 1000); const ms = r - s * 1000;
  const [y, mo, d] = civilFromDays(z);
  return `${String(y).padStart(4, '0')}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}${ms ? `.${String(ms).padStart(3, '0')}` : ''}`;
}
const stampKey = (st) => key(daysFromCivil(st.y, st.mo, st.d), st.h, st.mi, st.s, st.ms);

function parseUntil(v) {
  const m = v.match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d))?Z?$/);
  if (!m) return null;
  return key(daysFromCivil(+m[1], +m[2], +m[3]), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), 0);
}

/** Parses the RRULE; returns 'error' for values RFC 5545 does not allow. */
function parseRule(s) {
  const r = { interval: 1, wkst: 0 };
  const ints = (v, lo, hi, signed) => {
    const out = v.split(',').map((x) => (/^[+-]?\d+$/.test(x) ? Number(x) : NaN));
    if (out.some((x) => !Number.isInteger(x) || (signed ? Math.abs(x) : x) < lo || (signed ? Math.abs(x) : x) > hi)) throw new Error('range');
    return out;
  };
  try {
    for (const part of s.split(';')) {
      const [k, v] = part.split('=');
      switch (k) {
        case 'FREQ': r.freq = v; break;
        case 'INTERVAL': [r.interval] = ints(v, 0, 1e9, false); break;
        case 'COUNT': [r.count] = ints(v, 0, 1e9, false); break;
        case 'UNTIL': r.until = parseUntil(v); break;
        case 'WKST': r.wkst = DAYS[v]; break;
        case 'BYMONTH': r.bymonth = ints(v, 1, 12, false); break;
        case 'BYMONTHDAY': r.bymonthday = ints(v, 1, 31, true); break;
        case 'BYYEARDAY': r.byyearday = ints(v, 1, 366, true); break;
        case 'BYWEEKNO': r.byweekno = ints(v, 1, 53, true); break;
        case 'BYHOUR': r.byhour = ints(v, 0, 23, false); break;
        case 'BYMINUTE': r.byminute = ints(v, 0, 59, false); break;
        case 'BYSECOND':
          r.bysecond = ints(v, 0, 60, false);
          if (r.bysecond.includes(60)) return undefined; // leap-second policy: out of scope
          break;
        case 'BYSETPOS': r.bysetpos = ints(v, 1, 366, true); break;
        case 'BYDAY':
          r.byday = v.split(',').map((x) => {
            const m = x.match(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/);
            if (!m) throw new Error('byday');
            const n = m[1] ? Number(m[1]) : null;
            if (n !== null && Math.abs(n) > 53) throw new Error('byday');
            return { n: n || null, wd: DAYS[m[2]] };
          });
          break;
        case 'SKIP': r.skip = v; break;
        case 'RSCALE': break;
        default: return undefined; // e.g. BYEASTER: out of scope
      }
    }
  } catch {
    return 'error';
  }
  return r;
}

/** Week-year and week number of day `z` (weeks start on `wkst`). */
function weekNumber(z, wkst) {
  const weekStart = (d) => d - pymod(weekday(d) - wkst, 7);
  const week1 = (y) => weekStart(daysFromCivil(y, 1, 4)); // the week containing January 4
  const [y] = civilFromDays(z);
  let wy = y;
  if (z >= week1(y + 1)) wy = y + 1;
  else if (z < week1(y)) wy = y - 1;
  return { week: Math.floor((z - week1(wy)) / 7) + 1, weeks: (week1(wy + 1) - week1(wy)) / 7 };
}

/** nth occurrence of the weekday of `z` within [first, last] (and from the end). */
function ordinals(z, first, last) {
  return { fwd: Math.floor((z - first) / 7) + 1, back: -(Math.floor((last - z) / 7) + 1) };
}

/**
 * Evaluates a fixture case. Returns the expected value in fixture format, or
 * undefined if the case is out of scope.
 */
export function oracle(c) {
  const r = parseRule(c.rrule);
  if (r === undefined) return undefined;
  if (r === 'error') return { error: true };
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq)) return undefined;
  if (r.interval === 0 || r.count === 0) return c.query.method === 'all' || c.query.method === 'between' ? [] : null;
  const skip = r.skip === 'FORWARD' ? 1 : r.skip === 'BACKWARD' ? -1 : 0;

  const st = parseStamp(c.dtstart);
  const z0 = daysFromCivil(st.y, st.mo, st.d);
  const startKey = stampKey(st);

  // Defaults from DTSTART (RFC 5545 / rrule.js).
  if (!r.byweekno && !r.byyearday && !r.bymonthday && !r.byday) {
    if (r.freq === 'YEARLY') { r.bymonth ??= [st.mo]; r.bymonthday = [st.d]; }
    if (r.freq === 'MONTHLY') r.bymonthday = [st.d];
    if (r.freq === 'WEEKLY') r.byday = [{ n: null, wd: weekday(z0) }];
  }
  const nthCounts = r.freq === 'MONTHLY' || r.freq === 'YEARLY';
  const times = [];
  for (const h of r.byhour ?? [st.h]) for (const mi of r.byminute ?? [st.mi]) for (const s of r.bysecond ?? [st.s]) times.push(((h * 60 + mi) * 60 + s) * 1000 + st.ms);
  const timeset = [...new Set(times)].sort((a, b) => a - b);

  // Filters, as predicates on one day.
  function matches(z, { moved = false } = {}) {
    const [y, m, d] = civilFromDays(z);
    if (r.bymonth && !moved && !r.bymonth.includes(m)) return false;
    if (r.byweekno) {
      const { week, weeks } = weekNumber(z, r.wkst);
      if (!r.byweekno.some((v) => (v > 0 ? v === week : weeks + 1 + v === week))) return false;
    }
    if (r.byyearday) {
      const doy = z - daysFromCivil(y, 1, 1) + 1, ylen = leap(y) ? 366 : 365;
      if (!r.byyearday.some((v) => (v > 0 ? v === doy : ylen + 1 + v === doy))) return false;
    }
    if (r.bymonthday && !moved) {
      const ml = monthLen(y, m);
      if (!r.bymonthday.some((v) => (v > 0 ? v === d : ml + 1 + v === d))) return false;
    }
    if (r.byday) {
      const wd = weekday(z);
      const ok = r.byday.some((b) => {
        if (b.wd !== wd) return false;
        if (!b.n || !nthCounts) return true;
        const inYear = r.freq === 'YEARLY' && !r.bymonth;
        const first = inYear ? daysFromCivil(y, 1, 1) : daysFromCivil(y, m, 1);
        const last = inYear ? daysFromCivil(y, 12, 31) : daysFromCivil(y, m, monthLen(y, m));
        const o = ordinals(z, first, last);
        return b.n > 0 ? o.fwd === b.n : o.back === b.n;
      });
      if (!ok) return false;
    }
    return true;
  }

  // Query bounds.
  const q = c.query;
  const P = (s) => stampKey(parseStamp(s));
  const lower = q.method === 'between' ? P(q.after) : q.method === 'after' ? P(q.dt) : -Infinity;
  const upper = q.method === 'between' ? P(q.before) : q.method === 'before' ? P(q.dt) : Infinity;
  const limit = q.limit ?? Infinity;
  // Search horizon. Calendars repeat every 400 Gregorian years (146,097
  // days, 20,871 weeks, 4,800 months), so 400 * INTERVAL years cover every
  // period context a rule can see: nothing found by then means nothing ever.
  // If the rule does produce dates and the horizon (not UNTIL or the query)
  // ends the search before the answer is settled, the case is out of scope
  // rather than truncated. Year 9999 is also where both packages stop.
  const horizonYear = Math.min(st.y + 400 * r.interval, 9999);
  const horizon = key(daysFromCivil(horizonYear, 12, 31), 23, 59, 59, 999);
  const maxKey = Math.min(r.until ?? Infinity, upper, horizon);
  const horizonBinds = horizonYear < 9999 && horizon < Math.min(r.until ?? Infinity, upper);

  // Every candidate of every period goes into one set; the occurrences are
  // that set sorted, from DTSTART, up to UNTIL, truncated to COUNT. Nothing is
  // emitted per period: with SKIP=FORWARD a period can produce dates inside
  // the next one, earlier than some of its own.
  const cand = new Set();
  // Expansion may stop early once the answer is settled, judged only on
  // candidates before the start of the current period (no later period can
  // produce anything earlier than its start):
  //  * COUNT is resolved once that many candidates from DTSTART are settled;
  //  * otherwise every settled candidate is among the first COUNT, so the
  //    query is answered once enough settled candidates satisfy the query
  //    itself: one for after(), `limit` inside the window for all/between.
  //    Candidates before a between() window never count towards its limit.
  // before() has no early stop: its bound is part of maxKey.
  const inQuery = (k) =>
    q.method === 'after' ? (q.inc ? k >= lower : k > lower)
      : q.method === 'between' ? (q.inc ? k >= lower && k <= upper : k > lower && k < upper)
        : true;
  const queryNeed = q.method === 'after' ? 1 : q.method === 'before' ? Infinity : limit;
  const enough = (before) => {
    let fromStart = 0, matching = 0;
    for (const k of cand) {
      if (k < startKey || k >= before || (r.until !== undefined && k > r.until)) continue;
      fromStart++;
      if (inQuery(k)) matching++;
    }
    return (r.count !== undefined && fromStart >= r.count) || matching >= queryNeed;
  };
  const mayStop = r.count !== undefined || queryNeed !== Infinity;

  // Periods.
  const weekStart = (z) => z - pymod(weekday(z) - r.wkst, 7);
  for (let pi = 0; ; pi++) {
    let days = [];
    let periodStart;
    if (r.freq === 'YEARLY') {
      const y = st.y + pi * r.interval;
      periodStart = daysFromCivil(y, 1, 1);
      for (let z = periodStart; z < daysFromCivil(y + 1, 1, 1); z++) if (matches(z)) days.push(z);
      if (skip) for (let m = 1; m <= 12; m++) addSkipped(days, y, m);
    } else if (r.freq === 'MONTHLY') {
      const mIdx = st.y * 12 + st.mo - 1 + pi * r.interval;
      const y = Math.floor(mIdx / 12), m = mIdx - y * 12 + 1;
      periodStart = daysFromCivil(y, m, 1);
      for (let d = 1; d <= monthLen(y, m); d++) if (matches(periodStart + d - 1)) days.push(periodStart + d - 1);
      if (skip) addSkipped(days, y, m);
    } else if (r.freq === 'WEEKLY') {
      // RFC 5545: the whole week (from WKST) is the set; days before DTSTART
      // are removed after BYSETPOS.
      periodStart = weekStart(z0) + 7 * pi * r.interval;
      for (let z = periodStart; z < periodStart + 7; z++) if (matches(z)) days.push(z);
    } else {
      periodStart = z0 + pi * r.interval;
      if (matches(periodStart)) days.push(periodStart);
    }
    if (key(periodStart, 0, 0, 0, 0) > maxKey) {
      if (horizonBinds && [...cand].some((k) => k >= startKey)) return undefined;
      break;
    }
    if (mayStop && pi % 16 === 0 && enough(key(periodStart, 0, 0, 0, 0))) break;

    days = [...new Set(days)].sort((a, b) => a - b);
    let set = [];
    for (const z of days) for (const t of timeset) set.push(z * 86400000 + t);
    if (r.bysetpos) {
      const n = set.length;
      set = r.bysetpos.map((p) => set[p > 0 ? p - 1 : n + p]).filter((x) => x !== undefined);
    }
    for (const k of set) cand.add(k);
  }

  let occ = [...cand].filter((k) => k >= startKey && (r.until === undefined || k <= r.until)).sort((a, b) => a - b);
  if (r.count) occ = occ.slice(0, r.count);
  if (q.method === 'after') {
    const k = occ.find((k) => (q.inc ? k >= lower : k > lower));
    return k === undefined ? null : fromKey(k);
  }
  if (q.method === 'before') {
    const ks = occ.filter((k) => (q.inc ? k <= upper : k < upper));
    return ks.length ? fromKey(ks[ks.length - 1]) : null;
  }
  if (q.method === 'between') occ = occ.filter((k) => (q.inc ? k >= lower && k <= upper : k > lower && k < upper));
  return occ.slice(0, limit).map(fromKey);

  // RFC 7529 / RFC 8984 SKIP: BYMONTHDAY values past the end of month m.
  function addSkipped(days, y, m) {
    if (r.byweekno || r.byyearday || !r.bymonthday) return;
    if (r.bymonth && !r.bymonth.includes(m)) return;
    const ml = monthLen(y, m);
    if (!r.bymonthday.some((v) => v > ml)) return;
    const z = skip < 0 ? daysFromCivil(y, m, ml) : daysFromCivil(y, m, ml) + 1;
    // BYDAY applies to the moved date as a date of its own: nth weekdays count
    // within its own month (or year), not the month it came from.
    if (matches(z, { moved: true })) days.push(z);
  }
}
