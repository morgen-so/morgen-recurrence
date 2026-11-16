import { notEmpty, isPresent } from '../helpers'
import { ParsedOptions, Frequency } from '../types'
import { YearInfo, rebuildYear } from './yearinfo'
import { rebuildMonth, MonthInfo } from './monthinfo'
import { easter } from './easter'
import { Time } from '../datetime'
import { ONE_DAY, sort } from '../dateutil'

// =============================================================================
// Iterinfo
// =============================================================================
//
// Forked from rrule.js 2.8.0. Changes:
//  * the year masks are rebuilt only when the year changes (rrule.js tracked
//    the last year through the month info, which only exists for nth BYDAY,
//    so every other rule rebuilt them on every period);
//  * the day set of a period is a compact, reused list of the day-of-year
//    indices that pass the BY* filters (`fillDayset`), instead of a fresh
//    year-long array with nulls;
//  * BY* lookups use precomputed tables, and plain and nth BYDAY are OR-ed
//    (RFC 5545) instead of AND-ed.

/** Dense membership table for small non-negative integers. */
function table(values: number[] | null | undefined, size: number, sign = 1) {
  if (!notEmpty(values)) return null
  const t = new Uint8Array(size)
  for (let i = 0; i < values.length; i++) {
    const v = values[i] * sign
    if (v >= 0 && v < size) t[v] = 1
  }
  return t
}

export default class Iterinfo {
  public yearinfo: YearInfo
  public monthinfo: MonthInfo
  public eastermask: number[] | null

  /** Day-of-year indices of the current period that passed the filters. */
  public readonly days = new Int32Array(366 + 7)
  /** Whether the last day of the current period was filtered out. */
  public lastFiltered = false

  private _lastyear: number | null = null

  private readonly bymonthT: Uint8Array | null
  private readonly byweekdayT: Uint8Array | null
  private readonly hasNth: boolean
  private readonly bymonthdayT: Uint8Array | null
  private readonly bynmonthdayT: Uint8Array | null
  private readonly hasMonthday: boolean
  private readonly byyeardayPos: Uint8Array | null
  private readonly byyeardayNeg: Uint8Array | null
  private readonly hasWeekno: boolean
  private readonly hasEaster: boolean

  constructor(private options: ParsedOptions) {
    this.bymonthT = table(options.bymonth, 13)
    this.byweekdayT = table(options.byweekday, 7)
    this.hasNth = notEmpty(options.bynweekday)
    this.bymonthdayT = table(options.bymonthday, 32)
    this.bynmonthdayT = table(options.bynmonthday, 32, -1)
    this.hasMonthday =
      notEmpty(options.bymonthday) || notEmpty(options.bynmonthday)
    this.byyeardayPos = table(options.byyearday, 367)
    this.byyeardayNeg = table(options.byyearday, 367, -1)
    this.hasWeekno = notEmpty(options.byweekno)
    this.hasEaster = options.byeaster !== null && options.byeaster !== undefined
  }

  rebuild(year: number, month: number) {
    const options = this.options

    if (year !== this._lastyear) {
      this.yearinfo = rebuildYear(year, options)
    }

    if (
      this.hasNth &&
      (month !== this.lastmonth || year !== this._lastyear)
    ) {
      const { yearlen, mrange, wdaymask } = this.yearinfo
      this.monthinfo = rebuildMonth(
        year,
        month,
        yearlen,
        mrange,
        wdaymask,
        options
      )
    }

    if (isPresent(options.byeaster)) {
      this.eastermask = easter(year, options.byeaster)
    }

    this._lastyear = year
  }

  get lastyear() {
    return this._lastyear
  }

  get lastmonth() {
    return this.monthinfo ? this.monthinfo.lastmonth : null
  }

  get yearlen() {
    return this.yearinfo.yearlen
  }

  get yearordinal() {
    return this.yearinfo.yearordinal
  }

  get mrange() {
    return this.yearinfo.mrange
  }

  get wdaymask() {
    return this.yearinfo.wdaymask
  }

  get mmask() {
    return this.yearinfo.mmask
  }

  get wnomask() {
    return this.yearinfo.wnomask
  }

  get nwdaymask() {
    return this.monthinfo ? this.monthinfo.nwdaymask : []
  }

  get nextyearlen() {
    return this.yearinfo.nextyearlen
  }

  get mdaymask() {
    return this.yearinfo.mdaymask
  }

  get nmdaymask() {
    return this.yearinfo.nmdaymask
  }

  /**
   * Computes the day set of the period starting at (year, month, day),
   * removes the filtered days and stores the remaining ones in `days`.
   * Returns how many there are.
   */
  fillDayset(freq: Frequency, year: number, month: number, day: number) {
    let start: number
    let end: number
    switch (freq) {
      case Frequency.YEARLY:
        start = 0
        end = this.yearlen
        break
      case Frequency.MONTHLY:
        start = this.mrange[month - 1]
        end = this.mrange[month]
        break
      case Frequency.WEEKLY: {
        // Cross-year weeks: indices may run up to yearlen + 6.
        const wdaymask = this.wdaymask
        const wkst = this.options.wkst
        let i = Math.floor(Date.UTC(year, month - 1, day) / ONE_DAY) - this.yearordinal
        start = i
        for (let j = 0; j < 7; j++) {
          ++i
          if (wdaymask[i] === wkst) break
        }
        end = i
        break
      }
      default:
        start = Math.floor(Date.UTC(year, month - 1, day) / ONE_DAY) - this.yearordinal
        end = start + 1
    }

    const days = this.days
    let n = 0
    let filtered = false
    for (let d = start; d < end; d++) {
      filtered = this.isFiltered(d)
      if (!filtered) days[n++] = d
    }
    this.lastFiltered = filtered
    return n
  }

  isFiltered(d: number): boolean {
    const y = this.yearinfo
    if (this.bymonthT !== null && this.bymonthT[y.mmask[d]] !== 1) return true
    if (this.hasWeekno && !y.wnomask[d]) return true

    // RFC 5545: a day matches BYDAY if it matches a plain weekday OR an nth
    // weekday. rrule.js (and python-dateutil) required both.
    const byweekdayT = this.byweekdayT
    const nwdaymask = this.hasNth && this.monthinfo ? this.monthinfo.nwdaymask : null
    if (
      (byweekdayT !== null || (nwdaymask !== null && nwdaymask.length > 0)) &&
      !(byweekdayT !== null && byweekdayT[y.wdaymask[d]] === 1) &&
      !(nwdaymask !== null && nwdaymask[d] === 1)
    ) {
      return true
    }

    if (this.hasEaster && this.eastermask.indexOf(d) === -1) return true

    if (
      this.hasMonthday &&
      !(this.bymonthdayT !== null && this.bymonthdayT[y.mdaymask[d]] === 1) &&
      !(this.bynmonthdayT !== null && this.bynmonthdayT[-y.nmdaymask[d]] === 1)
    ) {
      return true
    }

    const pos = this.byyeardayPos
    if (pos !== null || this.byyeardayNeg !== null) {
      const neg = this.byyeardayNeg
      const yearlen = y.yearlen
      // Positive values v match day v - 1; negative v match yearlen + v.
      let p: number
      let q: number
      if (d < yearlen) {
        p = d + 1
        q = yearlen - d
      } else {
        p = d + 1 - yearlen
        q = y.nextyearlen - (d - yearlen)
      }
      const hit =
        (pos !== null && p < 367 && pos[p] === 1) ||
        (neg !== null && q < 367 && neg[q] === 1)
      if (!hit) return true
    }

    return false
  }

  htimeset(hour: number, _: number, second: number, millisecond: number) {
    let set: Time[] = []
    this.options.byminute.forEach((minute) => {
      set = set.concat(this.mtimeset(hour, minute, second, millisecond))
    })
    sort(set)
    return set
  }

  mtimeset(hour: number, minute: number, _: number, millisecond: number) {
    const set = this.options.bysecond.map(
      (second) => new Time(hour, minute, second, millisecond)
    )
    sort(set)
    return set
  }

  stimeset(hour: number, minute: number, second: number, millisecond: number) {
    return [new Time(hour, minute, second, millisecond)]
  }

  gettimeset(
    freq: Frequency
  ): (h: number, m: number, s: number, ms: number) => Time[] {
    switch (freq) {
      case Frequency.HOURLY:
        return this.htimeset.bind(this)
      case Frequency.MINUTELY:
        return this.mtimeset.bind(this)
      default:
        return this.stimeset.bind(this)
    }
  }
}
