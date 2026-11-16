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
import { MAXYEAR, ONE_DAY } from '../dateutil'
import Iterinfo from '../iterinfo/index'
import { buildTimeset } from '../parseoptions'
import { notEmpty } from '../helpers'
import { rezone, needsRezone } from '../timezone'
import { buildPoslist } from './poslist'
import { Time, DateTime } from '../datetime'

/**
 * Default safety net on the number of iterated periods (years for YEARLY,
 * days for DAILY, hours for HOURLY…). Same value as the Dart package.
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

  // Floating upper bound: no period starting after it can produce a result.
  let limitMs = untilMs
  if (iterResult.maxDate) {
    const maxMs =
      iterResult.maxDate.getTime() + (doRezone ? REZONE_SLACK : 0)
    if (maxMs < limitMs) limitMs = maxMs
  }

  const counterDate = DateTime.fromDate(dtstart)
  const ii = new Iterinfo(options)
  ii.rebuild(counterDate.year, counterDate.month)

  let timeset = toMillis(makeTimeset(ii, counterDate, options))
  const hasSetpos = notEmpty(bysetpos)
  const days = ii.days

  for (let periods = 0; ; periods++) {
    if (periods >= maxPeriods) return emitResult(iterResult)
    if (limitMs !== Infinity && periodStart(counterDate, freq) > limitMs) {
      return emitResult(iterResult)
    }

    const n = ii.fillDayset(freq, counterDate.year, counterDate.month, counterDate.day)
    const filtered = ii.lastFiltered
    const base = ii.yearordinal * ONE_DAY

    if (hasSetpos) {
      const poslist = buildPoslist(bysetpos, timeset, days, n, base)
      for (let j = 0; j < poslist.length; j++) {
        const res = poslist[j]
        if (res > untilMs) return emitResult(iterResult)
        if (res >= dtstartMs) {
          if (!iterResult.accept(emit(res, tzid, doRezone))) {
            return emitResult(iterResult)
          }
          if (count) {
            --count
            if (!count) return emitResult(iterResult)
          }
        }
      }
    } else {
      for (let j = 0; j < n; j++) {
        const dayMs = base + days[j] * ONE_DAY
        for (let k = 0; k < timeset.length; k++) {
          const res = dayMs + timeset[k]
          if (res > untilMs) return emitResult(iterResult)
          if (res >= dtstartMs) {
            if (!iterResult.accept(emit(res, tzid, doRezone))) {
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
      return emitResult(iterResult)
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

function emit(ms: number, tzid: string | null | undefined, doRezone: boolean) {
  const date = new Date(ms)
  return doRezone ? rezone(date, tzid) : date
}

/** Earliest instant an occurrence of the period starting at `c` can have. */
function periodStart(c: DateTime, freq: Frequency) {
  switch (freq) {
    case Frequency.YEARLY:
      return Date.UTC(c.year, 0, 1)
    case Frequency.MONTHLY:
      return Date.UTC(c.year, c.month - 1, 1)
    case Frequency.WEEKLY:
    case Frequency.DAILY:
      return Date.UTC(c.year, c.month - 1, c.day)
    case Frequency.HOURLY:
      return Date.UTC(c.year, c.month - 1, c.day, c.hour)
    case Frequency.MINUTELY:
      return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute)
    default:
      return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second)
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
