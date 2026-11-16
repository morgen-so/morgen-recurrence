// The RRULE iteration loop.
//
// Forked from rrule.js 2.8.0 (src/iter/index.ts). Differences, all shared with
// the Dart package and pinned by the conformance fixtures:
//  * plain and nth BYDAY values are OR-ed (RFC 5545); rrule.js AND-s them, so
//    e.g. MONTHLY;BYDAY=2WE,SA produced nothing;
//  * BYSETPOS positions past either end of the set select nothing and equal
//    results are emitted once (see poslist.ts);
//  * iteration stops as soon as a period starts after the requested upper
//    bound or UNTIL, after `maxPeriods` periods, and when a sub-daily
//    BYHOUR/BYMINUTE/BYSECOND can never be reached (rrule.js ran to year
//    9999, or forever for FREQ=HOURLY;INTERVAL=6;BYHOUR=3).
//
// Performance: candidates are handled as epoch milliseconds (one Date per
// emitted occurrence), the day set is a compact list of day-of-year indices
// reused across periods, and year masks are rebuilt only when the year
// changes.
import IterResult from '../iterresult'
import { ParsedOptions, freqIsDailyOrGreater, QueryMethodTypes, Frequency } from '../types'
import { MAXYEAR, ONE_DAY, utcMs } from '../dateutil'
import Iterinfo from '../iterinfo/index'
import { buildTimeset } from '../parseoptions'
import { notEmpty, pymod } from '../helpers'
import { rezone, needsRezone } from '../timezone'
import { buildPoslist } from './poslist'
import { Time, DateTime } from '../datetime'

/**
 * Default safety net: iteration stops after this many consecutive periods
 * (years for YEARLY, days for DAILY, hours for HOURLY…) without a single
 * candidate occurrence, i.e. for rules that never match. Periods that produce
 * candidates (even before DTSTART or the query window) reset the count, so
 * productive rules iterate as far as needed. Same value as the Dart package.
 */
export const DEFAULT_MAX_PERIODS = 200000

/** Largest UTC offset difference a time zone adapter can introduce (ms). */
const REZONE_SLACK = 2 * ONE_DAY

export function iter<M extends QueryMethodTypes>(
  iterResult: IterResult<M>,
  options: ParsedOptions,
  maxPeriods: number = DEFAULT_MAX_PERIODS
) {
  const { dtstart, freq, until, bysetpos, tzid } = options

  let count = options.count
  if (count === 0 || options.interval === 0) {
    return emitResult(iterResult)
  }

  const dtstartMs = dtstart.getTime()
  const untilMs = until ? until.getTime() : Infinity
  const doRezone = needsRezone(tzid)
  // With a TZID converted by the adapter, UNTIL is a UTC instant (RFC 5545
  // section 3.3.10) while candidates are wall-clock times: compare converted
  // instants with UNTIL, and use bounds that are conservative by the largest
  // possible offset on the wall-clock side.
  const slack = doRezone ? REZONE_SLACK : 0
  const untilWallMs = untilMs + slack

  // Floating upper bound: no period starting after it can produce a result.
  let limitMs = untilWallMs
  if (iterResult.maxDate) {
    const maxMs = iterResult.maxDate.getTime() + slack
    if (maxMs < limitMs) limitMs = maxMs
  }

  if (notEmpty(bysetpos) && setposNeverMatches(options)) {
    return emitResult(iterResult)
  }

  const counterDate = DateTime.fromDate(dtstart)
  if (freq === Frequency.WEEKLY) {
    // Morgen fix: the first weekly period is the whole week containing
    // DTSTART (from WKST), as for every other period. rrule.js started it at
    // DTSTART, so BYSETPOS counted positions in a truncated week (RFC 8984
    // section 4.3.3.1: candidates before DTSTART are removed after BYSETPOS).
    // Days before DTSTART are still never emitted.
    const delta = pymod(counterDate.getWeekday() - options.wkst, 7)
    if (delta) {
      const weekStart = new Date(utcMs(counterDate.year, counterDate.month - 1, counterDate.day - delta))
      counterDate.year = weekStart.getUTCFullYear()
      counterDate.month = weekStart.getUTCMonth() + 1
      counterDate.day = weekStart.getUTCDate()
    }
  }
  const ii = new Iterinfo(options)
  ii.rebuild(counterDate.year, counterDate.month)

  let timeset = toMillis(makeTimeset(ii, counterDate, options))
  const hasSetpos = notEmpty(bysetpos)
  const days = ii.days

  // SKIP=FORWARD moves an invalid day of a MONTHLY period to the 1st of the
  // next month, so a period can produce occurrences inside the next one, and
  // after some of that period's own (BYSETPOS=-1 picking a moved 18:00 while
  // the next period's BYSETPOS=1 picks 09:00 of the same day). Only those
  // moved results are deferred: they are merged in order with the next
  // period's results as these are generated, and exact duplicates are
  // emitted once (RFC 8984 section 4.3.3.1 removes dates already produced).
  // Everything else is emitted as it is generated, so memory never grows
  // with the period. BACKWARD and YEARLY never leave their period (December
  // has 31 days) and use the plain loop.
  const spills = ii.spillsForward
  let pending: number[] = []
  let next: number[] = []
  let pi = 0
  let lastEmitted = NaN
  // Emits one result in order. Returns true when iteration must stop (UNTIL,
  // COUNT, or the query is satisfied).
  const put = (res: number): boolean => {
    if (res > untilWallMs) return true
    if (res < dtstartMs || res === lastEmitted) return false
    lastEmitted = res
    const out = emit(res, tzid, doRezone)
    if (doRezone && out.getTime() > untilMs) return true
    if (!iterResult.accept(out)) return true
    if (count) {
      --count
      if (!count) return true
    }
    return false
  }
  // Emits the deferred results before `below`.
  const flush = (below: number): boolean => {
    while (pi < pending.length && pending[pi] < below) {
      if (put(pending[pi++])) return true
    }
    return false
  }
  // A result of a spilling period: deferred past the month's end, else
  // emitted after the earlier deferred ones.
  const take = (res: number, boundary: number): boolean => {
    if (res >= boundary) {
      next.push(res)
      return false
    }
    return flush(res) || put(res)
  }
  const finish = () => {
    if (spills) flush(Infinity)
    return emitResult(iterResult)
  }

  let lastStart = -Infinity
  for (let emptyPeriods = 0; ; ) {
    if (emptyPeriods >= maxPeriods) return finish()
    const start = periodStart(counterDate, freq)
    if (start > limitMs) return finish()
    // Defensive: the counter must move forward (validated options ensure it).
    if (start <= lastStart) return finish()
    lastStart = start

    const n = ii.fillDayset(freq, counterDate.year, counterDate.month, counterDate.day)
    const filtered = ii.lastFiltered
    const base = ii.yearordinal * ONE_DAY

    if (spills) {
      const boundary = base + ii.mrange[counterDate.month] * ONE_DAY
      let produced = 0
      if (hasSetpos) {
        const poslist = buildPoslist(bysetpos, timeset, days, n, base)
        produced = poslist.length
        for (let j = 0; j < poslist.length; j++) {
          if (take(poslist[j], boundary)) return emitResult(iterResult)
        }
      } else if (timeset.length !== 0) {
        produced = n
        for (let j = 0; j < n; j++) {
          const dayMs = base + days[j] * ONE_DAY
          for (let k = 0; k < timeset.length; k++) {
            if (take(dayMs + timeset[k], boundary)) return emitResult(iterResult)
          }
        }
      }
      emptyPeriods = produced === 0 ? emptyPeriods + 1 : 0
      if (flush(Infinity)) return emitResult(iterResult)
      const t = pending
      pending = next
      next = t
      next.length = 0
      pi = 0
    } else if (hasSetpos) {
      const poslist = buildPoslist(bysetpos, timeset, days, n, base)
      emptyPeriods = poslist.length === 0 ? emptyPeriods + 1 : 0
      for (let j = 0; j < poslist.length; j++) {
        const res = poslist[j]
        if (res > untilWallMs) return emitResult(iterResult)
        if (res >= dtstartMs) {
          const out = emit(res, tzid, doRezone)
          if (doRezone && out.getTime() > untilMs) return emitResult(iterResult)
          if (!iterResult.accept(out)) {
            return emitResult(iterResult)
          }
          if (count) {
            --count
            if (!count) return emitResult(iterResult)
          }
        }
      }
    } else {
      emptyPeriods = n === 0 || timeset.length === 0 ? emptyPeriods + 1 : 0
      for (let j = 0; j < n; j++) {
        const dayMs = base + days[j] * ONE_DAY
        for (let k = 0; k < timeset.length; k++) {
          const res = dayMs + timeset[k]
          if (res > untilWallMs) return emitResult(iterResult)
          if (res >= dtstartMs) {
            const out = emit(res, tzid, doRezone)
            if (doRezone && out.getTime() > untilMs) return emitResult(iterResult)
            if (!iterResult.accept(out)) {
              return emitResult(iterResult)
            }
            if (count) {
              --count
              if (!count) return emitResult(iterResult)
            }
          }
        }
      }
    }

    // Handle frequency and interval
    counterDate.add(options, filtered)

    if (counterDate.exhausted || counterDate.year > MAXYEAR) {
      return finish()
    }

    if (!freqIsDailyOrGreater(freq)) {
      timeset = toMillis(
        ii.gettimeset(freq)(
          counterDate.hour,
          counterDate.minute,
          counterDate.second,
          0
        )
      )
    }

    ii.rebuild(counterDate.year, counterDate.month)
  }
}

/**
 * True when every BYSETPOS position lies beyond the largest set a period can
 * have (e.g. FREQ=DAILY;BYDAY=SA,MO;BYSETPOS=2): the rule has no occurrences.
 */
function setposNeverMatches(o: ParsedOptions) {
  const days =
    o.freq === Frequency.YEARLY ? 366
      : o.freq === Frequency.MONTHLY ? 31
        : o.freq === Frequency.WEEKLY ? 7
          : 1
  const len = (a: number[] | null) => (a ? a.length : 1)
  const times = freqIsDailyOrGreater(o.freq)
    ? len(o.byhour) * len(o.byminute) * len(o.bysecond)
    : o.freq === Frequency.HOURLY ? len(o.byminute) * len(o.bysecond)
      : o.freq === Frequency.MINUTELY ? len(o.bysecond)
        : 1
  const max = days * times
  return o.bysetpos.every((p) => Math.abs(p) > max)
}

function emit(ms: number, tzid: string | null | undefined, doRezone: boolean) {
  const date = new Date(ms)
  return doRezone ? rezone(date, tzid) : date
}

/** Earliest instant an occurrence of the period starting at `c` can have. */
function periodStart(c: DateTime, freq: Frequency) {
  switch (freq) {
    case Frequency.YEARLY:
      return utcMs(c.year, 0, 1)
    case Frequency.MONTHLY:
      return utcMs(c.year, c.month - 1, 1)
    case Frequency.WEEKLY:
    case Frequency.DAILY:
      return utcMs(c.year, c.month - 1, c.day)
    case Frequency.HOURLY:
      return utcMs(c.year, c.month - 1, c.day, c.hour)
    case Frequency.MINUTELY:
      return utcMs(c.year, c.month - 1, c.day, c.hour, c.minute)
    default:
      return utcMs(c.year, c.month - 1, c.day, c.hour, c.minute, c.second)
  }
}

function toMillis(timeset: Time[]): number[] {
  const out = new Array<number>(timeset.length)
  for (let i = 0; i < timeset.length; i++) {
    const t = timeset[i]
    out[i] =
      ((t.hour * 60 + t.minute) * 60 + t.second) * 1000 + t.millisecond
  }
  return out
}

function emitResult<M extends QueryMethodTypes>(iterResult: IterResult<M>) {
  return iterResult.getValue()
}

function makeTimeset(
  ii: Iterinfo,
  counterDate: DateTime,
  options: ParsedOptions
): Time[] {
  const { freq, byhour, byminute, bysecond } = options

  if (freqIsDailyOrGreater(freq)) {
    return buildTimeset(options)
  }

  if (
    (freq >= Frequency.HOURLY &&
      notEmpty(byhour) &&
      byhour.indexOf(counterDate.hour) === -1) ||
    (freq >= Frequency.MINUTELY &&
      notEmpty(byminute) &&
      byminute.indexOf(counterDate.minute) === -1) ||
    (freq >= Frequency.SECONDLY &&
      notEmpty(bysecond) &&
      bysecond.indexOf(counterDate.second) === -1)
  ) {
    return []
  }

  return ii.gettimeset(freq)(
    counterDate.hour,
    counterDate.minute,
    counterDate.second,
    counterDate.millisecond
  )
}
