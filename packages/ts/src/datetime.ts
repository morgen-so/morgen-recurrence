import { ParsedOptions, Frequency } from './types'
import { pymod, divmod, empty, includes, notEmpty } from './helpers'

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}
import { MAXYEAR, monthRange } from './dateutil'

export class Time {
  public hour: number
  public minute: number
  public second: number
  public millisecond: number

  constructor(
    hour: number,
    minute: number,
    second: number,
    millisecond: number
  ) {
    this.hour = hour
    this.minute = minute
    this.second = second
    this.millisecond = millisecond || 0
  }

  getHours() {
    return this.hour
  }

  getMinutes() {
    return this.minute
  }

  getSeconds() {
    return this.second
  }

  getMilliseconds() {
    return this.millisecond
  }

  getTime() {
    return (
      (this.hour * 60 * 60 + this.minute * 60 + this.second) * 1000 +
      this.millisecond
    )
  }
}

export class DateTime extends Time {
  public day: number
  public month: number
  public year: number

  /**
   * Set when a sub-daily BYHOUR/BYMINUTE/BYSECOND can never be reached
   * (rrule.js looped forever there, e.g. FREQ=HOURLY;INTERVAL=6;BYHOUR=3).
   */
  public exhausted = false

  static fromDate(date: Date) {
    return new this(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.valueOf() % 1000
    )
  }

  constructor(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number
  ) {
    super(hour, minute, second, millisecond)
    this.year = year
    this.month = month
    this.day = day
  }

  getWeekday() {
    // Monday = 0; 1970-01-01 was a Thursday.
    const days = Math.floor(Date.UTC(this.year, this.month - 1, this.day) / 86400000)
    return pymod(days + 3, 7)
  }

  getTime() {
    return new Date(
      Date.UTC(
        this.year,
        this.month - 1,
        this.day,
        this.hour,
        this.minute,
        this.second,
        this.millisecond
      )
    ).getTime()
  }

  getDay() {
    return this.day
  }

  getMonth() {
    return this.month
  }

  getYear() {
    return this.year
  }

  public addYears(years: number) {
    this.year += years
  }

  public addMonths(months: number) {
    this.month += months
    if (this.month > 12) {
      const yearDiv = Math.floor(this.month / 12)
      const monthMod = pymod(this.month, 12)
      this.month = monthMod
      this.year += yearDiv
      if (this.month === 0) {
        this.month = 12
        --this.year
      }
    }
  }

  public addWeekly(days: number, wkst: number) {
    if (wkst > this.getWeekday()) {
      this.day += -(this.getWeekday() + 1 + (6 - wkst)) + days * 7
    } else {
      this.day += -(this.getWeekday() - wkst) + days * 7
    }

    this.fixDay()
  }

  public addDaily(days: number) {
    this.day += days
    this.fixDay()
  }

  // Sub-daily counters follow python-dateutil's rrule._iter. rrule.js 2.8.0
  // carried overflowing seconds/minutes by repeatedly adding the carry
  // (e.g. +780 minutes) until BYMINUTE/BYHOUR matched, which misaligned the
  // INTERVAL grid, skipped days, or looped forever
  // (FREQ=SECONDLY;INTERVAL=3;BYMINUTE=30 from hh:00:30). Unreachable
  // combinations set `exhausted` instead of looping or throwing.

  /**
   * Steps `value` by `interval` (mod `base`) until it lands in `byxxx`;
   * returns the number of base overflows, or -1 if it never does.
   */
  private modDistance(value: number, interval: number, byxxx: number[], base: number) {
    let acc = 0
    for (let i = 1; i <= base; i++) {
      value += interval
      const div = Math.floor(value / base)
      value -= div * base
      acc += div
      if (byxxx.indexOf(value) !== -1) {
        this.modValue = value
        return acc
      }
    }
    return -1
  }

  private modValue = 0

  public addHours(hours: number, filtered: boolean, byhour: number[]) {
    if (filtered) {
      // Jump to one iteration before next day
      this.hour += Math.floor((23 - this.hour) / hours) * hours
    }
    let ndays: number
    if (notEmpty(byhour)) {
      ndays = this.modDistance(this.hour, hours, byhour, 24)
      if (ndays < 0) {
        this.exhausted = true
        return
      }
      this.hour = this.modValue
    } else {
      const { div, mod } = divmod(this.hour + hours, 24)
      ndays = div
      this.hour = mod
    }
    if (ndays) this.addDaily(ndays)
  }

  public addMinutes(
    minutes: number,
    filtered: boolean,
    byhour: number[],
    byminute: number[]
  ) {
    if (filtered) {
      // Jump to one iteration before next day
      this.minute +=
        Math.floor((1439 - (this.hour * 60 + this.minute)) / minutes) * minutes
    }
    const reps = 1440 / gcd(minutes, 1440)
    for (let j = 0; j < reps; j++) {
      let nhours: number
      if (notEmpty(byminute)) {
        nhours = this.modDistance(this.minute, minutes, byminute, 60)
        if (nhours < 0) break
        this.minute = this.modValue
      } else {
        const { div, mod } = divmod(this.minute + minutes, 60)
        nhours = div
        this.minute = mod
      }
      const { div: ndays, mod: hour } = divmod(this.hour + nhours, 24)
      this.hour = hour
      if (ndays) this.addDaily(ndays)
      if (empty(byhour) || includes(byhour, this.hour)) return
      // Skip to the last step within this (non-matching) hour: same result
      // as stepping through it, much cheaper for sparse BYHOUR.
      this.minute += Math.floor((59 - this.minute) / minutes) * minutes
    }
    this.exhausted = true
  }

  public addSeconds(
    seconds: number,
    filtered: boolean,
    byhour: number[],
    byminute: number[],
    bysecond: number[]
  ) {
    if (filtered) {
      // Jump to one iteration before next day
      this.second +=
        Math.floor(
          (86399 - (this.hour * 3600 + this.minute * 60 + this.second)) /
            seconds
        ) * seconds
    }
    const reps = 86400 / gcd(seconds, 86400)
    for (let j = 0; j < reps; j++) {
      let nminutes: number
      if (notEmpty(bysecond)) {
        nminutes = this.modDistance(this.second, seconds, bysecond, 60)
        if (nminutes < 0) break
        this.second = this.modValue
      } else {
        const { div, mod } = divmod(this.second + seconds, 60)
        nminutes = div
        this.second = mod
      }
      const { div: nhours, mod: minute } = divmod(this.minute + nminutes, 60)
      this.minute = minute
      if (nhours) {
        const { div: ndays, mod: hour } = divmod(this.hour + nhours, 24)
        this.hour = hour
        if (ndays) this.addDaily(ndays)
      }
      if (notEmpty(byhour) && !includes(byhour, this.hour)) {
        // Skip to the last step within this (non-matching) hour: same result
        // as stepping through it, much cheaper for sparse BYHOUR/BYMINUTE.
        const k = Math.floor((3599 - (this.minute * 60 + this.second)) / seconds)
        const { div, mod } = divmod(this.second + k * seconds, 60)
        this.minute += div
        this.second = mod
        continue
      }
      if (notEmpty(byminute) && !includes(byminute, this.minute)) {
        this.second += Math.floor((59 - this.second) / seconds) * seconds
        continue
      }
      if (empty(bysecond) || includes(bysecond, this.second)) return
    }
    this.exhausted = true
  }

  public fixDay() {
    if (this.day <= 28) {
      return
    }

    let daysinmonth = monthRange(this.year, this.month - 1)[1]
    if (this.day <= daysinmonth) {
      return
    }

    while (this.day > daysinmonth) {
      this.day -= daysinmonth
      ++this.month
      if (this.month === 13) {
        this.month = 1
        ++this.year
        if (this.year > MAXYEAR) {
          return
        }
      }

      daysinmonth = monthRange(this.year, this.month - 1)[1]
    }
  }

  public add(options: ParsedOptions, filtered: boolean) {
    const { freq, interval, wkst, byhour, byminute, bysecond } = options

    switch (freq) {
      case Frequency.YEARLY:
        return this.addYears(interval)
      case Frequency.MONTHLY:
        return this.addMonths(interval)
      case Frequency.WEEKLY:
        return this.addWeekly(interval, wkst)
      case Frequency.DAILY:
        return this.addDaily(interval)
      case Frequency.HOURLY:
        return this.addHours(interval, filtered, byhour)
      case Frequency.MINUTELY:
        return this.addMinutes(interval, filtered, byhour, byminute)
      case Frequency.SECONDLY:
        return this.addSeconds(interval, filtered, byhour, byminute, bysecond)
    }
  }
}
