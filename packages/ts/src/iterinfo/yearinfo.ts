import { ParsedOptions } from '../types'
import { datetime, getWeekday, isLeapYear, toOrdinal, utcMs, ONE_DAY } from '../dateutil'
import { empty, repeat, pymod, includes } from '../helpers'
import {
  M365MASK,
  MDAY365MASK,
  NMDAY365MASK,
  WDAYMASK,
  M365RANGE,
  M366MASK,
  MDAY366MASK,
  NMDAY366MASK,
  M366RANGE,
} from '../masks'

export interface YearInfo {
  yearlen: 365 | 366
  nextyearlen: 365 | 366
  yearordinal: number
  yearweekday: number
  mmask: number[]
  mrange: number[]
  mdaymask: number[]
  nmdaymask: number[]
  wdaymask: number[]
  wnomask: number[] | null
}

export function rebuildYear(year: number, options: ParsedOptions) {
  const firstyday = datetime(year, 1, 1)

  const yearlen = isLeapYear(year) ? 366 : 365
  const nextyearlen = isLeapYear(year + 1) ? 366 : 365
  const yearordinal = toOrdinal(firstyday)
  const yearweekday = getWeekday(firstyday)

  const result: YearInfo = {
    yearlen,
    nextyearlen,
    yearordinal,
    yearweekday,
    ...baseYearMasks(year),
    wnomask: null,
  }

  if (empty(options.byweekno)) {
    return result
  }

  result.wnomask = buildWeekNoMask(year, yearlen, yearordinal, options)
  return result
}

/**
 * Ordinal (days since 1970-01-01) of the first day of week 1 of `year`:
 * the first week starting on `wkst` with at least 4 days in the year.
 */
function week1Start(year: number, wkst: number) {
  const jan1 = Math.round(utcMs(year, 0, 1) / ONE_DAY)
  const delta = pymod(pymod(jan1 + 3, 7) - wkst, 7) // days since week start
  return delta <= 3 ? jan1 - delta : jan1 + 7 - delta
}

/**
 * BYWEEKNO mask for the days of `year` (plus 7 days of the next year, for
 * weeks crossing into it). Morgen fix (also wrong in python-dateutil): every
 * day gets its week-year (previous, current or next) and week number, and
 * matches positive values directly and negative values counted from the end
 * of *its* week-year. rrule.js computed the previous year's week count from
 * the current year's values and only spilled week 1 into the next year for a
 * literal 1, so e.g. January 1-2, 2022 (week 52 of 2021) were lost for
 * BYWEEKNO=52 and taken as week 53.
 */
function buildWeekNoMask(
  year: number,
  yearlen: number,
  yearordinal: number,
  options: ParsedOptions
) {
  const wkst = options.wkst
  const starts = [
    week1Start(year - 1, wkst),
    week1Start(year, wkst),
    week1Start(year + 1, wkst),
    week1Start(year + 2, wkst),
  ]
  const byweekno = options.byweekno
  const mask = repeat(0, yearlen + 7) as number[]
  // Walk week by week through the week-years overlapping the mask.
  const end = yearordinal + yearlen + 7
  for (let w = 0; w < 3; w++) {
    const numweeks = (starts[w + 1] - starts[w]) / 7
    for (let week = 1; week <= numweeks; week++) {
      const first = starts[w] + (week - 1) * 7
      if (first + 7 <= yearordinal || first >= end) continue
      if (!includes(byweekno, week) && !includes(byweekno, week - numweeks - 1)) continue
      for (let ord = Math.max(first, yearordinal); ord < Math.min(first + 7, end); ord++) {
        mask[ord - yearordinal] = 1
      }
    }
  }
  return mask
}

function baseYearMasks(year: number) {
  const yearlen = isLeapYear(year) ? 366 : 365
  const firstyday = datetime(year, 1, 1)
  const wday = getWeekday(firstyday)

  if (yearlen === 365) {
    return {
      mmask: M365MASK as number[],
      mdaymask: MDAY365MASK,
      nmdaymask: NMDAY365MASK,
      wdaymask: WDAYMASK.slice(wday),
      mrange: M365RANGE,
    }
  }

  return {
    mmask: M366MASK as number[],
    mdaymask: MDAY366MASK,
    nmdaymask: NMDAY366MASK,
    wdaymask: WDAYMASK.slice(wday),
    mrange: M366RANGE,
  }
}
