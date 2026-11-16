import { Options, ParsedOptions, freqIsDailyOrGreater } from './types'
import {
  includes,
  notEmpty,
  isPresent,
  isNumber,
  isArray,
  isWeekdayStr,
} from './helpers'
import { RRule, defaultKeys, DEFAULT_OPTIONS } from './rrule'
import { getWeekday, isDate, isValidDate } from './dateutil'
import { Weekday } from './weekday'
import { Time } from './datetime'

export function initializeOptions(options: Partial<Options>) {
  const invalid: string[] = []
  const keys = Object.keys(options) as (keyof Options)[]

  // Shallow copy for options and origOptions and check for invalid
  for (const key of keys) {
    if (!includes(defaultKeys, key)) invalid.push(key)
    if (isDate(options[key]) && !isValidDate(options[key])) {
      invalid.push(key)
    }
  }

  if (invalid.length) {
    throw new Error('Invalid options: ' + invalid.join(', '))
  }

  return { ...options }
}

export function parseOptions(options: Partial<Options>) {
  const opts = { ...DEFAULT_OPTIONS, ...initializeOptions(options) }

  if (isPresent(opts.byeaster)) opts.freq = RRule.YEARLY

  if (!(isPresent(opts.freq) && RRule.FREQUENCIES[opts.freq])) {
    throw new Error(`Invalid frequency: ${opts.freq} ${options.freq}`)
  }

  if (!opts.dtstart) opts.dtstart = new Date(new Date().setMilliseconds(0))

  validateOptions(opts)

  if (!isPresent(opts.wkst)) {
    opts.wkst = RRule.MO.weekday
  } else if (isNumber(opts.wkst)) {
    // cool, just keep it like that
  } else {
    opts.wkst = opts.wkst.weekday
  }

  if (isPresent(opts.bysetpos)) {
    if (isNumber(opts.bysetpos)) opts.bysetpos = [opts.bysetpos]

    for (let i = 0; i < opts.bysetpos.length; i++) {
      const v = opts.bysetpos[i]
      if (v === 0 || !(v >= -366 && v <= 366)) {
        throw new Error(
          'bysetpos must be between 1 and 366,' + ' or between -366 and -1'
        )
      }
    }
  }

  if (
    !(
      Boolean(opts.byweekno as number) ||
      notEmpty(opts.byweekno as number[]) ||
      notEmpty(opts.byyearday as number[]) ||
      Boolean(opts.bymonthday) ||
      notEmpty(opts.bymonthday as number[]) ||
      isPresent(opts.byweekday) ||
      isPresent(opts.byeaster)
    )
  ) {
    switch (opts.freq) {
      case RRule.YEARLY:
        if (!opts.bymonth) opts.bymonth = opts.dtstart.getUTCMonth() + 1
        opts.bymonthday = opts.dtstart.getUTCDate()
        break
      case RRule.MONTHLY:
        opts.bymonthday = opts.dtstart.getUTCDate()
        break
      case RRule.WEEKLY:
        opts.byweekday = [getWeekday(opts.dtstart)]
        break
    }
  }

  // bymonth
  if (isPresent(opts.bymonth) && !isArray(opts.bymonth)) {
    opts.bymonth = [opts.bymonth]
  }

  // byyearday
  if (
    isPresent(opts.byyearday) &&
    !isArray(opts.byyearday) &&
    isNumber(opts.byyearday)
  ) {
    opts.byyearday = [opts.byyearday]
  }

  // bymonthday
  if (!isPresent(opts.bymonthday)) {
    opts.bymonthday = []
    opts.bynmonthday = []
  } else if (isArray(opts.bymonthday)) {
    const bymonthday = []
    const bynmonthday = []

    for (let i = 0; i < opts.bymonthday.length; i++) {
      const v = opts.bymonthday[i]
      if (v > 0) {
        bymonthday.push(v)
      } else if (v < 0) {
        bynmonthday.push(v)
      }
    }
    opts.bymonthday = bymonthday
    opts.bynmonthday = bynmonthday
  } else if (opts.bymonthday < 0) {
    opts.bynmonthday = [opts.bymonthday]
    opts.bymonthday = []
  } else {
    opts.bynmonthday = []
    opts.bymonthday = [opts.bymonthday]
  }

  // byweekno
  if (isPresent(opts.byweekno) && !isArray(opts.byweekno)) {
    opts.byweekno = [opts.byweekno]
  }

  // byweekday / bynweekday
  if (!isPresent(opts.byweekday)) {
    opts.bynweekday = null
  } else if (isNumber(opts.byweekday)) {
    opts.byweekday = [opts.byweekday]
    opts.bynweekday = null
  } else if (isWeekdayStr(opts.byweekday)) {
    opts.byweekday = [Weekday.fromStr(opts.byweekday).weekday]
    opts.bynweekday = null
  } else if (opts.byweekday instanceof Weekday) {
    if (!opts.byweekday.n || opts.freq > RRule.MONTHLY) {
      opts.byweekday = [opts.byweekday.weekday]
      opts.bynweekday = null
    } else {
      opts.bynweekday = [[opts.byweekday.weekday, opts.byweekday.n]]
      opts.byweekday = null
    }
  } else {
    const byweekday: number[] = []
    const bynweekday = []

    for (let i = 0; i < opts.byweekday.length; i++) {
      const wday = opts.byweekday[i]

      if (isNumber(wday)) {
        byweekday.push(wday)
        continue
      } else if (isWeekdayStr(wday)) {
        byweekday.push(Weekday.fromStr(wday).weekday)
        continue
      }

      if (!wday.n || opts.freq > RRule.MONTHLY) {
        byweekday.push(wday.weekday)
      } else {
        bynweekday.push([wday.weekday, wday.n])
      }
    }
    opts.byweekday = notEmpty(byweekday) ? byweekday : null
    opts.bynweekday = notEmpty(bynweekday) ? bynweekday : null
  }

  // byhour
  if (!isPresent(opts.byhour)) {
    opts.byhour = opts.freq < RRule.HOURLY ? [opts.dtstart.getUTCHours()] : null
  } else if (isNumber(opts.byhour)) {
    opts.byhour = [opts.byhour]
  } else {
    opts.byhour = sortedUnique(opts.byhour)
  }

  // byminute
  if (!isPresent(opts.byminute)) {
    opts.byminute =
      opts.freq < RRule.MINUTELY ? [opts.dtstart.getUTCMinutes()] : null
  } else if (isNumber(opts.byminute)) {
    opts.byminute = [opts.byminute]
  } else {
    opts.byminute = sortedUnique(opts.byminute)
  }

  // bysecond
  if (!isPresent(opts.bysecond)) {
    opts.bysecond =
      opts.freq < RRule.SECONDLY ? [opts.dtstart.getUTCSeconds()] : null
  } else if (isNumber(opts.bysecond)) {
    opts.bysecond = [opts.bysecond]
  } else {
    opts.bysecond = sortedUnique(opts.bysecond)
  }

  // A leap second (BYSECOND=60, allowed by RFC 5545) never occurs in
  // floating time: neither JavaScript nor Dart dates represent it. It is
  // ignored, and a rule whose only BYSECOND value is 60 has no occurrences.
  if (opts.bysecond && opts.bysecond.indexOf(60) !== -1) {
    opts.bysecond = opts.bysecond.filter((v) => v !== 60)
    if (!opts.bysecond.length) opts.count = 0
  }

  return { parsedOptions: opts as ParsedOptions }
}

/**
 * Morgen fix: rejects values that cannot be evaluated (rrule.js accepted
 * them silently: INTERVAL=-1 or INTERVAL=wat looped forever, COUNT=-1 was
 * unbounded, BYHOUR=25 rolled into the next day, BYMONTHDAY=0 silently
 * dropped). Ranges follow RFC 5545 section 3.3.10. COUNT=0 and INTERVAL=0
 * stay allowed: they are rrule.js's empty rule.
 */
function validateOptions(opts: Partial<Options>) {
  const fail = (what: string, value: unknown) => {
    throw new Error(`Invalid ${what}: ${String(value)}`)
  }
  const isInt = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v)

  // INTERVAL=0 stays rrule.js's empty rule (like COUNT=0); negative or
  // non-integer intervals used to loop forever.
  if (!isInt(opts.interval) || opts.interval < 0) fail('interval', opts.interval)
  if (isPresent(opts.count) && (!isInt(opts.count) || opts.count < 0)) {
    fail('count', opts.count)
  }
  if (isPresent(opts.byeaster) && !isInt(opts.byeaster)) {
    fail('byeaster', opts.byeaster)
  }
  if (isPresent(opts.wkst)) {
    const w = isNumber(opts.wkst) ? opts.wkst : (opts.wkst as Weekday).weekday
    if (!isInt(w) || w < 0 || w > 6) fail('wkst', opts.wkst)
  }

  const ranges: [keyof Options, number, number, boolean][] = [
    // name, min, max, signed (negative values allowed, 0 never)
    ['bymonth', 1, 12, false],
    ['bymonthday', 1, 31, true],
    ['byyearday', 1, 366, true],
    ['byweekno', 1, 53, true],
    ['byhour', 0, 23, false],
    ['byminute', 0, 59, false],
    ['bysecond', 0, 60, false],
  ]
  for (const [name, min, max, signed] of ranges) {
    const value = opts[name] as number | number[] | null | undefined
    if (!isPresent(value)) continue
    for (const v of isArray(value) ? value : [value]) {
      const abs = signed && isInt(v) ? Math.abs(v) : v
      if (!isInt(v) || abs < min || abs > max) fail(name, v)
    }
  }

  if (isPresent(opts.byweekday)) {
    const days = isArray(opts.byweekday) ? opts.byweekday : [opts.byweekday]
    for (const d of days) {
      if (isNumber(d)) {
        if (!isInt(d) || d < 0 || d > 6) fail('byweekday', d)
      } else if (typeof d === 'string') {
        if (!isWeekdayStr(d)) fail('byweekday', d)
      } else if (d instanceof Weekday) {
        if (!isInt(d.weekday) || d.weekday < 0 || d.weekday > 6) fail('byweekday', d)
        if (isPresent(d.n) && (!isInt(d.n) || Math.abs(d.n) > 53)) fail('byweekday', d)
      } else {
        fail('byweekday', d)
      }
    }
  }

  if (isPresent(opts.skip) && !/^(OMIT|FORWARD|BACKWARD)$/.test(opts.skip)) {
    fail('skip', opts.skip)
  }
  if (isPresent(opts.rscale) && !/^GREGORIAN$/i.test(opts.rscale)) {
    fail('rscale (only GREGORIAN is supported)', opts.rscale)
  }
}

/**
 * Morgen fix: BYHOUR/BYMINUTE/BYSECOND are sorted and de-duplicated so that
 * occurrences within a day come out in chronological order (rrule.js kept the
 * given order: BYHOUR=18,9 emitted 18:00 before 9:00, which also made UNTIL
 * stop the iteration early, and repeated duplicates).
 */
function sortedUnique(values: number[]): number[] {
  return values
    .filter((v, i) => values.indexOf(v) === i)
    .sort((a, b) => a - b)
}

export function buildTimeset(opts: ParsedOptions) {
  const millisecondModulo = opts.dtstart.getUTCMilliseconds()
  if (!freqIsDailyOrGreater(opts.freq)) {
    return []
  }

  const timeset: Time[] = []
  opts.byhour.forEach((hour) => {
    opts.byminute.forEach((minute) => {
      opts.bysecond.forEach((second) => {
        timeset.push(new Time(hour, minute, second, millisecondModulo))
      })
    })
  })

  return timeset
}
