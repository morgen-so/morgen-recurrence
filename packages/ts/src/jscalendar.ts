/**
 * Conversion between iCalendar (RFC 5545, RFC 7529) recurrence and JSCalendar
 * (RFC 8984) recurrence, as draft-ietf-calext-jscalendar-icalendar-31 defines
 * it:
 *
 *  - RRULE <-> RecurrenceRule (section 2.3.33, and the UNTIL remark of 3.2);
 *  - EXDATE and RDATE <-> recurrenceOverrides (sections 2.3.18, 2.3.30 and
 *    the recurrenceOverrides remark of 3.2);
 *  - a whole recurrence (RRULE, EXRULE, EXDATE, RDATE lines) <->
 *    recurrenceRules, excludedRecurrenceRules and recurrenceOverrides.
 *
 * Same behaviour as packages/dart/lib/src/jscalendar.dart; both run the
 * shared fixtures (fixtures/*.json, `jscal`, and fixtures/conversion/).
 *
 * Times are floating, as for rule expansion: `Date`s whose UTC fields hold the
 * wall clock. Time zones are the caller's: the functions take a converter
 * where the draft needs one (an UNTIL in UTC, an EXDATE with a TZID).
 *
 * Lenient by default: data from calendar providers is converted as well as it
 * can be. What cannot be read (an unknown or malformed part, a value out of
 * range) is left out and reported to `onWarning`, and an impossible date is
 * moved to the next valid one (as rrule.js does). Only a rule without a
 * readable frequency gives null. With `strict: true`, the same problems throw
 * an `Error` instead.
 */
import { RRule } from './rrule'
import { Weekday } from './weekday'
import { Frequency, Options } from './types'

export type JSCalendarDay = 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su'
export type JSCalendarFrequency =
  | 'yearly'
  | 'monthly'
  | 'weekly'
  | 'daily'
  | 'hourly'
  | 'minutely'
  | 'secondly'

export interface JSCalendarNDay {
  '@type'?: 'NDay'
  day: JSCalendarDay
  nthOfPeriod?: number
}

/** A JSCalendar (RFC 8984 section 4.3.3) RecurrenceRule. */
export interface JSCalendarRecurrenceRule {
  '@type'?: 'RecurrenceRule'
  frequency: JSCalendarFrequency
  interval?: number
  rscale?: string
  skip?: 'omit' | 'backward' | 'forward'
  firstDayOfWeek?: JSCalendarDay
  byDay?: JSCalendarNDay[]
  byMonthDay?: number[]
  byMonth?: string[]
  byYearDay?: number[]
  byWeekNo?: number[]
  byHour?: number[]
  byMinute?: number[]
  bySecond?: number[]
  bySetPosition?: number[]
  count?: number
  /** LocalDateTime, e.g. "2024-01-31T09:00:00". */
  until?: string
}

/** A JSCalendar PatchObject of `recurrenceOverrides`. */
export type JSCalendarPatch = Record<string, unknown>

/**
 * Converts the wall-clock fields of `wallClock` in `timeZone` to the wall
 * clock of the event's time zone (JSCalendar `timeZone`). `timeZone` is a
 * TZID parameter value, or `Etc/UTC` for a value ending in `Z`.
 */
export type ToEventTime = (wallClock: Date, timeZone: string) => Date

/** Converts the wall clock of the event's time zone to UTC (fields of the instant). */
export type ToUtc = (wallClock: Date) => Date

/**
 * The UTC instant (its fields) of the wall clock `wallClock` in `timeZone`, a
 * TZID parameter value. Used for the duration of an RDATE PERIOD with an
 * explicit end, which is elapsed time (RFC 5545 section 3.3.9).
 */
export type ToInstant = (wallClock: Date, timeZone: string) => Date

/**
 * The form of the iCalendar date-time values of a calendar object (draft
 * section 3.2, after RFC 5545 section 3.3.5):
 *  - `date`: DATE (`20240101`), for `showWithoutTime` without `timeZone`;
 *  - `local`: DATE WITH LOCAL TIME (`20240101T090000`), without `timeZone`;
 *  - `utc`: DATE WITH UTC TIME (`20240101T090000Z`), `timeZone` `Etc/UTC`;
 *  - `zoned`: DATE WITH LOCAL TIME AND TIME ZONE REFERENCE (`TZID=…:…`).
 */
export type ICalDateForm = 'date' | 'local' | 'utc' | 'zoned'

const DAYS: JSCalendarDay[] = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']
const FREQUENCIES: JSCalendarFrequency[] = [
  'yearly',
  'monthly',
  'weekly',
  'daily',
  'hourly',
  'minutely',
  'secondly',
]
const RFC_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

const fail = (what: string): never => {
  throw new Error(what)
}

// ---------------------------------------------------------------------------
// Reading RRULE strings (the same rules as the Dart RRuleOptions.parseString).

interface RuleValues {
  freq?: JSCalendarFrequency
  interval?: number
  count?: number
  until?: string
  wkst?: number
  byday?: { day: number; n: number | null }[]
  bysetpos?: number[]
  bymonth?: number[]
  /** BYMONTH as written (`5L`), with `anyRscale`. */
  bymonthNames?: string[]
  bymonthday?: number[]
  byyearday?: number[]
  byweekno?: number[]
  byhour?: number[]
  byminute?: number[]
  bysecond?: number[]
  skip?: 'omit' | 'forward' | 'backward'
  rscale?: string
}

const ints = (v: string): number[] =>
  v.split(',').map((p) => (/^[+-]?\d+$/.test(p) ? Number(p) : fail(`Invalid number in RRULE: ${p}`)))

/**
 * The values of an RRULE value (`FREQ=…;…`), parts as written. With
 * `anyRscale` (conversion), any RSCALE is read and, with a non-Gregorian one,
 * BYMONTH may have leap months (RFC 7529 section 4.2); the parser itself
 * expands only Gregorian rules.
 */
function ruleValues(body: string, anyRscale = false): RuleValues {
  const o: RuleValues = {}
  for (const attr of body.split(';')) {
    if (!attr) continue
    const eq = attr.indexOf('=')
    if (eq < 0) fail(`Invalid RRULE part: ${attr}`)
    const key = attr.slice(0, eq).toUpperCase()
    const value = attr.slice(eq + 1)
    const one = () => {
      const v = ints(value)
      return v.length === 1 ? v[0] : fail(`Invalid ${key}: ${value}`)
    }
    switch (key) {
      case 'FREQ': {
        const f = value.toLowerCase() as JSCalendarFrequency
        o.freq = FREQUENCIES.includes(f) ? f : fail(`Invalid FREQ: ${value}`)
        break
      }
      case 'INTERVAL':
        o.interval = one()
        break
      case 'COUNT':
        o.count = one()
        break
      case 'UNTIL':
        if (!/^\d{8}(T\d{6}Z?)?$/.test(value)) fail(`Invalid UNTIL value: ${value}`)
        o.until = value
        break
      case 'WKST': {
        const d = RFC_DAYS.indexOf(value.toUpperCase())
        o.wkst = d >= 0 ? d : fail(`Invalid WKST: ${value}`)
        break
      }
      case 'BYDAY':
      case 'BYWEEKDAY':
        o.byday = value.split(',').map((day) => {
          const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(day)
          const d = m ? RFC_DAYS.indexOf(m[2]) : -1
          if (d < 0) fail(`Invalid weekday string: ${day}`)
          const n = m[1] === undefined ? null : Number(m[1])
          return { day: d, n: n === 0 ? null : n }
        })
        break
      case 'BYSETPOS':
        o.bysetpos = ints(value)
        break
      case 'BYMONTH':
        if (anyRscale) {
          o.bymonthNames = value.split(',').map((m) => {
            const n = /^\+?(\d+)(L?)$/i.exec(m)
            return n && Number(n[1]) >= 1 ? `${Number(n[1])}${n[2].toUpperCase()}` : fail(`Invalid BYMONTH: ${value}`)
          })
        } else o.bymonth = ints(value)
        break
      case 'BYMONTHDAY':
        o.bymonthday = ints(value)
        break
      case 'BYYEARDAY':
        o.byyearday = ints(value)
        break
      case 'BYWEEKNO':
        o.byweekno = ints(value)
        break
      case 'BYHOUR':
        o.byhour = ints(value)
        break
      case 'BYMINUTE':
        o.byminute = ints(value)
        break
      case 'BYSECOND':
        o.bysecond = ints(value)
        break
      case 'SKIP': {
        const s = value.toLowerCase()
        o.skip =
          s === 'omit' || s === 'forward' || s === 'backward' ? s : fail(`Invalid SKIP: ${value}`)
        break
      }
      case 'RSCALE':
        if (anyRscale ? !/^[A-Za-z0-9-]+$/.test(value) : value.toUpperCase() !== 'GREGORIAN') {
          fail(`Unsupported RSCALE: ${value}`)
        }
        o.rscale = value.toLowerCase()
        break
      default:
        fail(`Unknown RRULE property '${key}'`)
    }
  }
  if (o.bymonthNames) {
    const gregorian = (o.rscale ?? 'gregorian') === 'gregorian'
    // Gregorian months are checked by the parser's ranges below; other
    // calendars have up to 13 months (RFC 7529).
    if (gregorian) o.bymonth = o.bymonthNames.map((m) => (/L$/.test(m) ? fail(`Invalid BYMONTH: ${m}`) : Number(m)))
    else if (o.bymonthNames.some((m) => parseInt(m, 10) > 13)) fail(`Invalid BYMONTH: ${o.bymonthNames}`)
  }
  return o
}

/**
 * The largest year day and week number: RFC 5545 for Gregorian rules, and
 * for other calendars (RFC 7529) those of the longest years (a Hebrew or
 * Chinese leap year has up to 385 days).
 */
const MAX_YEAR_DAY = { gregorian: 366, other: 385 }
const MAX_WEEK_NO = { gregorian: 53, other: 55 }

// DTSTART at the start of the line or after a `;`, parameters in any order
// (lists of quoted or plain values), then `:` or `=` and the value.
const DTSTART =
  /(?<=^|;)DTSTART((?:;[A-Z0-9-]+=(?:"[^"]*"|[^;:,"]*)(?:,(?:"[^"]*"|[^;:,"]*))*)*)(?::|=)([^;\s]*)/i
const PARAM = ';([A-Z0-9-]+)=((?:"[^"]*"|[^;:,"]*)(?:,(?:"[^"]*"|[^;:,"]*))*)'
// An RRULE or EXRULE property name, with its parameters (RFC 5545 rrulparam,
// e.g. Evolution's `RRULE;X-EVOLUTION-ENDDATE=…:`), and the colon.
const RULE_NAME = new RegExp(`^(?:RRULE|EXRULE)(?:${PARAM})*:`, 'i')

/** The parameters in `s` (`;NAME=value…`), in order. */
function params(s: string): RegExpExecArray[] {
  const re = new RegExp(PARAM, 'gi')
  const out: RegExpExecArray[] = []
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m)
  return out
}

function checkDtstart(m: RegExpExecArray) {
  const value = m[2]
  let type: string | null = null
  for (const p of params(m[1])) {
    if (p[1].toUpperCase() === 'VALUE') type = p[2].replace(/"/g, '').toUpperCase()
  }
  if (type !== null && type !== 'DATE' && type !== 'DATE-TIME') fail(`Unsupported DTSTART;VALUE=${type}`)
  if (type === 'DATE' && !/^\d{8}$/.test(value)) fail(`Invalid DTSTART;VALUE=DATE value: ${value}`)
  if (type === 'DATE-TIME' && !/^\d{8}T\d{6}Z?$/.test(value)) {
    fail(`Invalid DTSTART;VALUE=DATE-TIME value: ${value}`)
  }
  icalValue(value)
}

/**
 * The rule parts of an iCalendar recurrence string: every line checked, the
 * first two merged (upper-case keys, values as written, BYWEEKDAY as BYDAY,
 * TZID and DTSTART left out). As the Dart parseRRuleParts.
 */
function ruleParts(s: string, anyRscale = false): Map<string, string> {
  const merged = new Map<string, string>()
  const lines = s
    .replace(/\r?\n[ \t]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length)
  lines.forEach((line, index) => {
    const header = /^([A-Z]+?)[:;]/.exec(line.toUpperCase())?.[1] ?? null
    if (header === null || header === 'RRULE' || header === 'EXRULE') {
      let body = line.replace(RULE_NAME, '')
      const inline = DTSTART.exec(body)
      if (inline) {
        checkDtstart(inline)
        body = body.slice(0, inline.index) + body.slice(inline.index + inline[0].length)
      }
      const attrs = body
        .split(';')
        .filter((a) => a.length && !a.toUpperCase().startsWith('TZID='))
        .map((a) => (a.toUpperCase().startsWith('BYWEEKDAY=') ? `BYDAY${a.slice(9)}` : a))
      ruleValues(attrs.join(';'), anyRscale)
      if (index >= 2) return
      for (const attr of attrs) {
        const eq = attr.indexOf('=')
        merged.set(attr.slice(0, eq).toUpperCase(), attr.slice(eq + 1))
      }
    } else if (header === 'DTSTART') {
      const m = DTSTART.exec(line)
      if (!m || m.index !== 0 || m[0].length !== line.length) fail(`Invalid DTSTART: ${line}`)
      checkDtstart(m)
    } else {
      fail(`Unsupported RFC prop ${header} in ${line}`)
    }
  })
  return merged
}

// ---------------------------------------------------------------------------
// Date-time values.

/** An iCalendar DATE or DATE-TIME; impossible dates throw, second 60 is 59. */
function icalValue(s: string): { value: Date; utc: boolean; date: boolean } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(s)
  if (!m) fail(`Invalid date-time: ${s}`)
  const g = (i: number) => Number(m[i] ?? 0)
  const second = g(6) === 60 ? 59 : g(6)
  const d = utc(g(1), g(2), g(3), g(4), g(5), second)
  if (d.getUTCFullYear() !== g(1) || d.getUTCMonth() + 1 !== g(2) || d.getUTCDate() !== g(3) ||
      d.getUTCHours() !== g(4) || d.getUTCMinutes() !== g(5)) {
    fail(`Impossible date-time: ${s}`)
  }
  return { value: d, utc: m[7] !== undefined, date: m[4] === undefined }
}

/** A JSCalendar LocalDateTime (`2024-01-31T09:00:00`), or null. */
function localDateTime(s: unknown): Date | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s)
  if (!m) return null
  const g = (i: number) => Number(m[i])
  const d = utc(g(1), g(2), g(3), g(4), g(5), g(6))
  return d.getUTCFullYear() === g(1) && d.getUTCMonth() + 1 === g(2) && d.getUTCDate() === g(3) &&
    d.getUTCHours() === g(4) && d.getUTCMinutes() === g(5) && d.getUTCSeconds() === g(6)
    ? d
    : null
}

/**
 * A floating date-time; month 1-12, out-of-range fields carried over in year
 * `y` itself (February 30, 2023 is March 2), years below 100 kept (Date.UTC
 * maps them to 19xx).
 */
function utc(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  const date = new Date(0)
  date.setUTCFullYear(y, mo - 1, d)
  date.setUTCHours(h, mi, s, 0)
  return date
}

const two = (n: number) => String(n).padStart(2, '0')
const formatLocal = (d: Date) =>
  `${String(d.getUTCFullYear()).padStart(4, '0')}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}` +
  `T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
function formatICal(d: Date, { date = false, utc = false } = {}) {
  const day = `${String(d.getUTCFullYear()).padStart(4, '0')}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`
  return date
    ? day
    : `${day}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}${utc ? 'Z' : ''}`
}

// ---------------------------------------------------------------------------
// Lenient reading.

/** Receives what lenient conversion left out or changed. */
export type OnWarning = (message: string) => void

/** Reports a problem: throws in strict mode, warns otherwise. */
type Issues = ((message: string) => void) & { strict: boolean }
function issues(strict: boolean, onWarning?: OnWarning): Issues {
  const f = ((message: string) => {
    if (strict) throw new Error(message)
    onWarning?.(message)
  }) as Issues
  f.strict = strict
  return f
}

interface Time {
  value: Date
  utc: boolean
  date: boolean
}

const ANY_DATE_TIME =
  /^(\d{4})-?(\d{2})-?(\d{2})(?:[Tt ]?(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * A date-time in iCalendar or ISO 8601 form (lenient): fractional seconds
 * dropped, an offset converted to UTC, an impossible date moved to the next
 * valid one (reported). Null (reported) when it cannot be read.
 */
function lenientTime(s: string, what: string, issue: Issues): Time | null {
  const m = ANY_DATE_TIME.exec(s.trim())
  if (!m) {
    issue(`Ignored ${what} ${s}`)
    return null
  }
  const g = (i: number) => Number(m[i] ?? 0)
  const second = g(6) === 60 ? 59 : g(6)
  let d = utc(g(1), g(2), g(3), g(4), g(5), second)
  if (d.getUTCFullYear() !== g(1) || d.getUTCMonth() + 1 !== g(2) || d.getUTCDate() !== g(3) ||
      d.getUTCHours() !== g(4) || d.getUTCMinutes() !== g(5)) {
    issue(`Impossible ${what} ${s}, read as ${formatLocal(d)}`)
  }
  const zone = m[7]?.toUpperCase()
  if (zone !== undefined && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const minutes = Number(digits.slice(0, 2)) * 60 + (digits.length > 2 ? Number(digits.slice(2)) : 0)
    d = new Date(d.getTime() - sign * minutes * 60_000)
  }
  return { value: d, utc: zone !== undefined, date: m[4] === undefined }
}

/** Content lines of `text`: unfolded (RFC 5545 section 3.1), trimmed, non-empty. */
const lines = (text: string) =>
  text
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length)

/** The parts of a rule, typed. */
interface Rule {
  freq: JSCalendarFrequency
  interval?: number
  count?: number
  until?: Time
  wkst?: number
  byDay?: { day: number; n: number | null }[]
  byMonthDay?: number[]
  byYearDay?: number[]
  byWeekNo?: number[]
  byHour?: number[]
  byMinute?: number[]
  bySecond?: number[]
  bySetPos?: number[]
  byMonth?: string[]
  rscale?: string
  skip?: 'omit' | 'forward' | 'backward'
}

// ---------------------------------------------------------------------------
// RRULE -> RecurrenceRule.

export interface RRuleToJsCalendarOptions {
  /** Converts a UTC UNTIL to the event's wall clock; without it the UTC fields are kept. */
  toEventTime?: ToEventTime
  /** Adds properties so that JSCalendar gives the rrule.js occurrences. */
  keepRRuleMeaning?: boolean
  /** Throw on any problem instead of leaving it out. */
  strict?: boolean
  /** Receives what lenient conversion left out or changed. */
  onWarning?: OnWarning
}

/**
 * An RFC 5545 RRULE as a JSCalendar RecurrenceRule (draft section 2.3.33).
 *
 * `rrule` is a rule value such as `FREQ=WEEKLY;BYDAY=MO`, an `RRULE:` or
 * `EXRULE:` line, with or without a DTSTART line (DTSTART does not belong to
 * the rule and is ignored).
 *
 * Each part maps to its property: values in lower case, BYDAY to NDay
 * objects, BYMONTH to strings. Only the parts in `rrule` are set, so
 * `interval` is left out unless INTERVAL is written (RFC 8984's default is
 * 1). UNTIL becomes a LocalDateTime in the event's time zone: a date is that day at midnight, a local time stays as
 * written, and a UTC time goes through `toEventTime` (called with `Etc/UTC`;
 * without it the UTC fields are kept, which is right for events in UTC or
 * without a time zone).
 *
 * The result is a literal mapping, as the draft defines. Evaluated as
 * JSCalendar, a few rules then have other occurrences than rrule.js gives the
 * RRULE, because RFC 8984 section 4.3.3.1 (step 3) adds properties RFC 5545
 * implementations do not, e.g. `FREQ=YEARLY;BYMONTHDAY=15` is the 15th of
 * every month for rrule.js but only of the start month in JSCalendar. With
 * `keepRRuleMeaning`, properties are added so that the JSCalendar rule has
 * the rrule.js occurrences (here `byMonth` "1" to "12"); see
 * `rruleMeaningInJsCalendar`.
 *
 * Lenient by default: unknown parts (such as `X-` extensions), malformed or
 * out-of-range values and an INTERVAL below 1 are left out (reported to
 * `onWarning`); an impossible UNTIL date moves to the next valid one; UNTIL
 * may have fractional seconds or an offset; names and values may be in any
 * case. Returns null only without a readable FREQ. With `strict`, the rule
 * must be what `RRule.parseString` accepts, with FREQ, within RFC 5545's
 * ranges and INTERVAL >= 1, or an error is thrown. COUNT and UNTIL together,
 * which RFC 5545 and RFC 8984 forbid, throw with `strict`; otherwise COUNT
 * is kept and UNTIL left out (reported).
 */
export function rruleToJsCalendar(
  rrule: string,
  options: RRuleToJsCalendarOptions = {}
): JSCalendarRecurrenceRule | null {
  const issue = issues(!!options.strict, options.onWarning)
  const rule = options.strict ? strictRule(rrule) : lenientRule(rrule, issue)
  if (!rule) return null
  if (rule.count !== undefined && rule.until) {
    issue(`COUNT and UNTIL together; UNTIL left out: ${rrule}`)
    delete rule.until
  }
  const js: JSCalendarRecurrenceRule = { '@type': 'RecurrenceRule', frequency: rule.freq }
  if (rule.interval !== undefined) js.interval = rule.interval
  if (rule.rscale !== undefined) js.rscale = rule.rscale
  if (rule.skip !== undefined) js.skip = rule.skip
  if (rule.wkst !== undefined) js.firstDayOfWeek = DAYS[rule.wkst]
  if (rule.byDay) {
    js.byDay = rule.byDay.map((d) => ({
      '@type': 'NDay',
      day: DAYS[d.day],
      ...(d.n !== null ? { nthOfPeriod: d.n } : {}),
    }))
  }
  if (rule.byMonthDay) js.byMonthDay = rule.byMonthDay
  if (rule.byMonth) js.byMonth = rule.byMonth
  if (rule.byYearDay) js.byYearDay = rule.byYearDay
  if (rule.byWeekNo) js.byWeekNo = rule.byWeekNo
  if (rule.byHour) js.byHour = rule.byHour
  if (rule.byMinute) js.byMinute = rule.byMinute
  if (rule.bySecond) js.bySecond = rule.bySecond
  if (rule.bySetPos) js.bySetPosition = rule.bySetPos
  if (rule.count !== undefined) js.count = rule.count
  if (rule.until) {
    const u = rule.until
    js.until = formatLocal(u.utc && options.toEventTime ? options.toEventTime(u.value, 'Etc/UTC') : u.value)
  }
  if (!options.keepRRuleMeaning) return js
  const kept = rruleMeaning(js)
  if (kept.warning) options.onWarning?.(`${kept.warning}: ${rrule}`)
  return kept.rule
}

/** The strict reading: the parser's rules, FREQ required, RFC 5545's ranges, INTERVAL >= 1. */
function strictRule(rrule: string): Rule {
  const parts = ruleParts(rrule, true)
  if (!parts.has('FREQ')) fail(`RRULE without FREQ: ${rrule}`)
  const o = ruleValues([...parts].map(([k, v]) => `${k}=${v}`).join(';'), true)
  // RFC 5545 ranges, as rule expansion checks them. Year days and week
  // numbers of other calendars go further (RFC 7529): checked here.
  const gregorian = (o.rscale ?? 'gregorian') === 'gregorian'
  if (!gregorian) {
    const check = (name: string, v: number[] | undefined, max: number) => {
      if (v?.some((n) => n === 0 || Math.abs(n) > max)) fail(`Invalid ${name}: ${v}`)
    }
    check('BYYEARDAY', o.byyearday, MAX_YEAR_DAY.other)
    check('BYWEEKNO', o.byweekno, MAX_WEEK_NO.other)
  }
  const opts: Partial<Options> = {
    freq: Frequency[o.freq.toUpperCase() as keyof typeof Frequency] as Frequency,
    dtstart: new Date(Date.UTC(2000, 0, 1)),
    interval: o.interval ?? 1,
    count: o.count ?? null,
    wkst: o.wkst ?? null,
    byweekday: o.byday ? o.byday.map((d) => new Weekday(d.day, d.n ?? undefined)) : null,
    bysetpos: o.bysetpos ?? null,
    bymonth: o.bymonth ?? null,
    bymonthday: o.bymonthday ?? null,
    byyearday: gregorian ? o.byyearday ?? null : null,
    byweekno: gregorian ? o.byweekno ?? null : null,
    byhour: o.byhour ?? null,
    byminute: o.byminute ?? null,
    bysecond: o.bysecond ?? null,
  }
  new RRule(opts)
  // RFC 8984: interval >= 1 (rrule.js takes INTERVAL=0 and repeats nothing).
  if ((o.interval ?? 1) < 1) fail(`INTERVAL must be at least 1: ${rrule}`)
  return {
    freq: o.freq,
    interval: o.interval,
    count: o.count,
    until: o.until !== undefined ? icalValue(o.until) : undefined,
    wkst: o.wkst,
    byDay: o.byday,
    byMonthDay: o.bymonthday,
    byYearDay: o.byyearday,
    byWeekNo: o.byweekno,
    byHour: o.byhour,
    byMinute: o.byminute,
    bySecond: o.bysecond,
    bySetPos: o.bysetpos,
    byMonth: o.bymonthNames,
    rscale: o.rscale,
    skip: o.skip,
  }
}

const KNOWN_PARTS = new Set([
  'FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST', 'BYDAY', 'BYMONTH', 'BYMONTHDAY', 'BYYEARDAY',
  'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYSETPOS', 'RSCALE', 'SKIP', 'TZID',
])

/** The lenient reading: every part that can be read, the rest reported. */
function lenientRule(rrule: string, issue: Issues): Rule | null {
  const parts = new Map<string, string>()
  for (const line of lines(rrule)) {
    const header = /^([A-Za-z-]+)\s*[:;]/.exec(line)?.[1]?.toUpperCase()
    if (header === 'DTSTART') continue
    if (header !== undefined && header !== 'RRULE' && header !== 'EXRULE') {
      issue(`Ignored ${header} in a recurrence rule: ${line}`)
      continue
    }
    const body = line
      .replace(RULE_NAME, '')
      .replace(/^(?:RRULE|EXRULE)\s*:/i, '')
      .replace(/(?<=^|;)\s*DTSTART(?:;[^:=]*)?[:=][^;]*/gi, '')
    for (const raw of body.split(';')) {
      const attr = raw.trim()
      if (!attr) continue
      const eq = attr.indexOf('=')
      if (eq <= 0) {
        issue(`Ignored malformed RRULE part "${attr}"`)
        continue
      }
      let key = attr.slice(0, eq).trim().toUpperCase()
      if (key === 'BYWEEKDAY') key = 'BYDAY'
      parts.set(key, attr.slice(eq + 1).trim())
    }
  }
  const freq = parts.get('FREQ')?.toLowerCase() as JSCalendarFrequency | undefined
  if (freq === undefined || !FREQUENCIES.includes(freq)) {
    issue(freq === undefined ? `RRULE without FREQ: ${rrule}` : `Unknown FREQ in RRULE: ${rrule}`)
    return null
  }
  const rule: Rule = { freq }
  const rscale = parts.get('RSCALE')?.toLowerCase()
  if (rscale !== undefined) {
    if (/^[a-z0-9-]+$/.test(rscale)) rule.rscale = rscale
    else issue(`Ignored RSCALE=${parts.get('RSCALE')}`)
  }
  const integer = (key: string, min: number) => {
    const v = parts.get(key)
    if (v === undefined) return undefined
    const n = /^[+]?\d+$/.test(v) ? Number(v.replace('+', '')) : null
    if (n === null || n < min) {
      issue(`Ignored ${key}=${v}`)
      return undefined
    }
    return n
  }
  const ints = (key: string, min: number, max: number, signed = false) => {
    const v = parts.get(key)
    if (v === undefined) return undefined
    const out: number[] = []
    for (const raw of v.split(',')) {
      const e = raw.trim()
      const n = /^[+-]?\d+$/.test(e) ? Number(e.replace('+', '')) : null
      const ok = n !== null && (signed ? n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max : n >= min && n <= max)
      if (ok) out.push(n)
      else issue(`Ignored ${key} value "${e}"`)
    }
    return out.length ? out : undefined
  }
  const set = <K extends keyof Rule>(k: K, v: Rule[K] | undefined) => {
    if (v !== undefined) rule[k] = v
  }
  set('interval', integer('INTERVAL', 1))
  set('count', integer('COUNT', 0))
  set('byMonthDay', ints('BYMONTHDAY', 1, 31, true))
  const ranges = (rule.rscale ?? 'gregorian') === 'gregorian' ? 'gregorian' : 'other'
  set('byYearDay', ints('BYYEARDAY', 1, MAX_YEAR_DAY[ranges], true))
  set('byWeekNo', ints('BYWEEKNO', 1, MAX_WEEK_NO[ranges], true))
  set('byHour', ints('BYHOUR', 0, 23))
  set('byMinute', ints('BYMINUTE', 0, 59))
  set('bySecond', ints('BYSECOND', 0, 60))
  set('bySetPos', ints('BYSETPOS', 1, 366, true))
  const byMonth = parts.get('BYMONTH')
  if (byMonth !== undefined) {
    const gregorian = (rule.rscale ?? 'gregorian') === 'gregorian'
    const months: string[] = []
    for (const raw of byMonth.split(',')) {
      const e = raw.trim().toUpperCase()
      const m = /^\+?(\d+)(L?)$/.exec(e)
      const n = m ? Number(m[1]) : 0
      if (m && n >= 1 && (gregorian ? n <= 12 && !m[2] : true)) months.push(`${n}${m[2]}`)
      else issue(`Ignored BYMONTH value "${e}"`)
    }
    if (months.length) rule.byMonth = months
  }
  const byDay = parts.get('BYDAY')
  if (byDay !== undefined) {
    const days: { day: number; n: number | null }[] = []
    for (const raw of byDay.split(',')) {
      const e = raw.trim().toUpperCase()
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(e)
      const n = m?.[1] !== undefined ? Number(m[1].replace('+', '')) : null
      if (!m || (n !== null && Math.abs(n) > 53)) issue(`Ignored BYDAY value "${e}"`)
      else days.push({ day: RFC_DAYS.indexOf(m[2]), n: n === 0 ? null : n })
    }
    if (days.length) rule.byDay = days
  }
  const wkst = parts.get('WKST')
  if (wkst !== undefined) {
    const d = RFC_DAYS.indexOf(wkst.toUpperCase())
    if (d < 0) issue(`Ignored WKST=${wkst}`)
    else rule.wkst = d
  }
  const skip = parts.get('SKIP')
  if (skip !== undefined) {
    const s = skip.toLowerCase()
    if (s === 'omit' || s === 'forward' || s === 'backward') rule.skip = s
    else issue(`Ignored SKIP=${skip}`)
  }
  const until = parts.get('UNTIL')
  if (until !== undefined) {
    const t = lenientTime(until, 'UNTIL', issue)
    if (t) rule.until = t
  }
  for (const key of parts.keys()) {
    if (!KNOWN_PARTS.has(key) && !key.startsWith('X-')) issue(`Ignored unknown RRULE part ${key}`)
  }
  return rule
}

/**
 * A copy of the JSCalendar `rule` (a literal mapping of an RRULE) with the
 * properties that give it, under RFC 8984 semantics, the occurrences rrule.js
 * gives the RRULE. Without them, RFC 8984 section 4.3.3.1 (step 3) would add a
 * start-dependent value that RFC 5545 implementations do not add:
 *
 *  - yearly, with `byMonthDay` but no `byMonth`, `byWeekNo` or `byYearDay`:
 *    `byMonth` "1" to "12" (JSCalendar would add the start month);
 *  - yearly with `byWeekNo` (no `byYearDay`), and monthly with `byYearDay` or
 *    `byWeekNo`, without `byDay` or `byMonthDay`; weekly with `byMonthDay`,
 *    `byYearDay` or `byWeekNo` but no `byDay`: `byDay` with all seven days
 *    (JSCalendar would add the start weekday or day of the month);
 *  - `nthOfPeriod` is dropped from `byDay` unless the frequency is monthly or
 *    yearly: rrule.js ignores it there (RFC 5545 forbids it), JSCalendar
 *    would count it within the month;
 *  - yearly, with `byMonthDay`, no `byMonth`, `byWeekNo` or `byYearDay`, and
 *    a `byDay` with `nthOfPeriod`: `byYearDay` 1 to 366. It restricts
 *    nothing, but stops JSCalendar from adding the start month, and keeps
 *    "the 3rd Tuesday of the year" (adding `byMonth` would make it "of each
 *    month").
 *
 * The properties are start-independent, so the result is the same for every
 * start. Other rules are returned unchanged (as a copy).
 *
 * Two kinds of rule may keep no rrule.js meaning; `rruleToJsCalendar` reports
 * them to `onWarning` (in strict mode too):
 *
 *  - a non-Gregorian `rscale` where a month list would be needed: the months
 *    of the calendar are not known here, so the rule stays as it is;
 *  - the `byYearDay` case with `skip` forward or backward and a month day
 *    above 28: an invalid day that moves into another month may give other
 *    dates than rrule.js.
 */
export function rruleMeaningInJsCalendar(rule: JSCalendarRecurrenceRule): JSCalendarRecurrenceRule {
  return rruleMeaning(rule).rule
}

const isGregorian = (r: { rscale?: string }) => (r.rscale ?? 'gregorian').toLowerCase() === 'gregorian'

/**
 * Whether `skip` can move an invalid day (a month day above 28) to another
 * month, where `byYearDay` may give other results than rrule.js.
 */
const movesInvalidDays = (r: JSCalendarRecurrenceRule) =>
  (r.skip === 'forward' || r.skip === 'backward') && (r.byMonthDay ?? []).some((d) => Math.abs(d) > 28)

function rruleMeaning(rule: JSCalendarRecurrenceRule): { rule: JSCalendarRecurrenceRule; warning?: string } {
  const r: JSCalendarRecurrenceRule = { ...rule }
  let warning: string | undefined
  const has = (k: keyof JSCalendarRecurrenceRule) => Array.isArray(r[k]) && (r[k] as unknown[]).length > 0
  const allDays = (): JSCalendarNDay[] => DAYS.map((day) => ({ '@type': 'NDay', day }))
  if (r.frequency !== 'monthly' && r.frequency !== 'yearly' && has('byDay')) {
    r.byDay = r.byDay.map(({ nthOfPeriod: _, ...d }) => d)
  }
  switch (r.frequency) {
    case 'weekly':
      if (!has('byDay') && (has('byMonthDay') || has('byYearDay') || has('byWeekNo'))) r.byDay = allDays()
      break
    case 'monthly':
      if (!has('byDay') && !has('byMonthDay') && (has('byYearDay') || has('byWeekNo'))) r.byDay = allDays()
      break
    case 'yearly':
      if (!has('byYearDay')) {
        const nth = has('byDay') && r.byDay.some((d) => d.nthOfPeriod != null)
        if (!has('byMonth') && !has('byWeekNo') && has('byMonthDay')) {
          if (!isGregorian(r)) {
            warning = `RFC 8984 adds the start month here; the months of RSCALE=${r.rscale.toUpperCase()} are not known, so the rule is kept as it is`
          } else if (!nth) r.byMonth = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
          else {
            r.byYearDay = Array.from({ length: 366 }, (_, i) => i + 1)
            if (movesInvalidDays(r)) {
              warning = 'SKIP can move a month day above 28 into another month; the JSCalendar dates may differ from rrule.js'
            }
          }
        }
        if (has('byWeekNo') && !has('byMonthDay') && !has('byDay')) r.byDay = allDays()
      }
      break
  }
  return { rule: r, warning }
}

// ---------------------------------------------------------------------------
// RecurrenceRule -> RRULE.

export interface JsCalendarToRRuleOptions {
  /** The form of the event's DTSTART, for UNTIL (default `local`). */
  untilForm?: ICalDateForm
  /** Converts the event's wall clock to UTC; required with `untilForm: 'zoned'` and a local `until`. */
  toUtc?: ToUtc
  /** Converts a UTC `until` (lenient) to the event's wall clock, for the `local` and `date` forms. */
  toEventTime?: ToEventTime
  /** The event's start (floating), required with `keepJsCalendarMeaning`. */
  start?: Date
  /** Adds the properties RFC 8984 implicitly adds for `start`. */
  keepJsCalendarMeaning?: boolean
  /** Throw on any problem instead of leaving it out. */
  strict?: boolean
  /** Receives what lenient conversion left out or changed. */
  onWarning?: OnWarning
}

/**
 * A JSCalendar RecurrenceRule as an RFC 5545 RRULE value (without the
 * `RRULE:` prefix), as the draft maps it back (section 2.3.33 and the UNTIL
 * remark of section 3.2).
 *
 * Parts are written in a fixed order (FREQ first) in upper case. INTERVAL is
 * left out when it is 1, and RSCALE=GREGORIAN is added when only `skip` is
 * set, since RFC 7529 allows SKIP only with RSCALE. `until` is written in
 * `untilForm`, the form of the event's DTSTART: a date (its date part), a
 * local time, a UTC time (the wall clock of an event in `Etc/UTC`), or, for an
 * event with a time zone, the UTC instant that `toUtc` gives (required then,
 * as RFC 5545 requires UTC with a TZID start).
 *
 * With `keepJsCalendarMeaning`, the RRULE gets the properties RFC 8984 section
 * 4.3.3.1 (step 3) implicitly adds for `start` (required then), so that
 * rrule.js gives the JSCalendar occurrences: e.g. a yearly rule with only
 * `byMonthDay` gets BYMONTH with the start month. Two cases are reported to
 * `onWarning` (in strict mode too) and written as they are:
 *
 *  - the start is not an occurrence of the rule (a weekly Friday rule from a
 *    Monday). RFC 8984 and RFC 5545 both count the start as the first
 *    occurrence, so COUNT is written as it is, but RFC 5545 calls such a set
 *    undefined and rrule.js does not give the start;
 *  - a non-Gregorian `rscale` where a month or month day would be added: the
 *    start's date in that calendar is not computed here.
 *
 * Lenient by default: invalid members and values are left out (reported to
 * `onWarning`); names may be in any case; `until` may also be a date
 * (`2024-01-31`), have fractional seconds, or be a UTC time (`…Z`, or with an
 * offset), which some stored rules have: it is then written as is for the
 * `utc` and `zoned` forms, and through `toEventTime` (called with `Etc/UTC`)
 * for the `local` and `date` forms. Returns null only without a valid
 * `frequency`. With `strict`, a rule that is not a valid RecurrenceRule
 * throws. Empty arrays count as absent; unknown members are ignored either
 * way.
 */
export function jsCalendarToRRule(
  rule: JSCalendarRecurrenceRule,
  options: JsCalendarToRRuleOptions = {}
): string | null {
  const s = toRRule(rule, options)
  if (s !== null && options.keepJsCalendarMeaning && options.start && !startMatches(rule, options.start)) {
    options.onWarning?.(
      `The start ${formatLocal(options.start)} is not an occurrence of the rule: RFC 5545 calls the ` +
        `recurrence set undefined, and rrule.js does not give the start: ${s}`
    )
  }
  return s
}

/**
 * Whether rrule.js gives `start` as an occurrence of `rule` (with the
 * properties RFC 8984 adds for it), ignoring `count` and `until`: the rule
 * is expanded up to `start` only. True when the rule cannot be expanded here
 * (a non-Gregorian `rscale`).
 */
function startMatches(rule: JSCalendarRecurrenceRule, start: Date): boolean {
  try {
    if (!isGregorian(rule)) return true
    const { count: _count, until: _until, ...open } = rule
    const s = toRRule(open, { start, keepJsCalendarMeaning: true })
    if (s === null) return true
    const first = new RRule({ ...RRule.parseString(s), dtstart: start, until: start }).all()[0]
    return first?.getTime() === start.getTime()
  } catch {
    return true
  }
}

function toRRule(rule: JSCalendarRecurrenceRule, options: JsCalendarToRRuleOptions): string | null {
  const issue = issues(!!options.strict, options.onWarning)
  const r = checkRule(rule, issue)
  if (!r) return null
  if (options.keepJsCalendarMeaning) {
    if (!options.start) throw new TypeError('keepJsCalendarMeaning needs the start')
    const skipped = addImplicitProperties(r.rule, options.start)
    if (skipped) {
      options.onWarning?.(
        `RFC 8984 adds the start's ${skipped} here; the start's date in RSCALE=${r.rule.rscale.toUpperCase()} ` +
          `is not computed, so it is left out: ${JSON.stringify(rule)}`
      )
    }
  }
  const js = r.rule
  const invalid = notInRfc5545(js)
  if (invalid) {
    issue(`RFC 5545 does not allow ${invalid}, so a calendar may reject the rule: ${JSON.stringify(rule)}`)
  }
  const parts = [`FREQ=${js.frequency.toUpperCase()}`]
  const add = (name: string, v: unknown[] | undefined) => {
    if (v && v.length) parts.push(`${name}=${v.join(',')}`)
  }
  if (js.interval !== undefined && js.interval !== 1) parts.push(`INTERVAL=${js.interval}`)
  if (js.count !== undefined) parts.push(`COUNT=${js.count}`)
  if (r.until) parts.push(`UNTIL=${untilToICal(r.until, options)}`)
  add('BYMONTH', js.byMonth)
  add('BYWEEKNO', js.byWeekNo)
  add('BYYEARDAY', js.byYearDay)
  add('BYMONTHDAY', js.byMonthDay)
  add('BYDAY', js.byDay?.map((d) => `${d.nthOfPeriod ?? ''}${d.day.toUpperCase()}`))
  add('BYHOUR', js.byHour)
  add('BYMINUTE', js.byMinute)
  add('BYSECOND', js.bySecond)
  add('BYSETPOS', js.bySetPosition)
  if (js.firstDayOfWeek !== undefined) parts.push(`WKST=${js.firstDayOfWeek.toUpperCase()}`)
  if (js.rscale !== undefined || js.skip !== undefined) {
    parts.push(`RSCALE=${(js.rscale ?? 'gregorian').toUpperCase()}`)
  }
  if (js.skip !== undefined) parts.push(`SKIP=${js.skip.toUpperCase()}`)
  return parts.join(';')
}

/**
 * The rule parts RFC 5545 section 3.3.10 does not allow with the rule's
 * frequency (JSCalendar allows them: they limit the occurrences), or
 * undefined. rrule.js reads them as JSCalendar does.
 */
function notInRfc5545(r: JSCalendarRecurrenceRule): string | undefined {
  const f = r.frequency
  const found: string[] = []
  const has = (v: unknown[] | undefined) => !!v && v.length > 0
  if (has(r.byMonthDay) && f === 'weekly') found.push('BYMONTHDAY')
  if (has(r.byYearDay) && (f === 'daily' || f === 'weekly' || f === 'monthly')) found.push('BYYEARDAY')
  if (has(r.byWeekNo) && f !== 'yearly') found.push('BYWEEKNO')
  if (r.byDay?.some((d) => d.nthOfPeriod != null)) {
    if (f !== 'monthly' && f !== 'yearly') found.push('BYDAY with a number')
    else if (f === 'yearly' && has(r.byWeekNo)) found.push('BYDAY with a number and BYWEEKNO')
  }
  return found.length ? `${found.join(', ')} with FREQ=${f.toUpperCase()}` : undefined
}

function untilToICal(until: Time, { untilForm = 'local', toUtc, toEventTime }: JsCalendarToRRuleOptions) {
  if (until.utc) {
    // A UTC `until` (lenient): as is in UTC, else in the event's wall clock.
    if (untilForm === 'utc' || untilForm === 'zoned') return formatICal(until.value, { utc: true })
    const wall = toEventTime ? toEventTime(until.value, 'Etc/UTC') : until.value
    return formatICal(wall, { date: untilForm === 'date' })
  }
  const d = until.value
  switch (untilForm) {
    case 'date':
      return formatICal(d, { date: true })
    case 'local':
      return formatICal(d)
    case 'utc':
      return formatICal(d, { utc: true })
    case 'zoned':
      if (!toUtc) throw new TypeError('An UNTIL in a time zone needs toUtc')
      return formatICal(toUtc(d), { utc: true })
  }
}

/**
 * RFC 8984 section 4.3.3.1 step 3, the date parts. As tools/lib/jscal.mjs.
 * With a non-Gregorian `rscale`, the month and month day (which need the
 * start's date in that calendar) are not added: returns what was left out.
 */
function addImplicitProperties(r: JSCalendarRecurrenceRule, start: Date): string | undefined {
  const has = (k: keyof JSCalendarRecurrenceRule) => Array.isArray(r[k]) && (r[k] as unknown[]).length > 0
  const day = DAYS[(start.getUTCDay() + 6) % 7]
  const gregorian = isGregorian(r)
  const hadByDay = has('byDay')
  const hadByMonthDay = has('byMonthDay')
  const skipped: string[] = []
  const monthDay = () => (gregorian ? (r.byMonthDay = [start.getUTCDate()]) : skipped.push('month day'))
  switch (r.frequency) {
    case 'weekly':
      if (!hadByDay) r.byDay = [{ '@type': 'NDay', day }]
      break
    case 'monthly':
      if (!hadByDay && !hadByMonthDay) monthDay()
      break
    case 'yearly':
      if (!has('byYearDay')) {
        if (!has('byMonth') && !has('byWeekNo') && (hadByMonthDay || !hadByDay)) {
          if (gregorian) r.byMonth = [String(start.getUTCMonth() + 1)]
          else skipped.push('month')
        }
        if (!hadByMonthDay && !has('byWeekNo') && !hadByDay) monthDay()
        if (has('byWeekNo') && !hadByMonthDay && !hadByDay) r.byDay = [{ '@type': 'NDay', day }]
      }
      break
  }
  return skipped.length ? skipped.join(' and ') : undefined
}

/**
 * A checked copy: types and ranges of RFC 8984 section 4.3.3, lower-case
 * strings, empty arrays dropped, `until` read. Null for a lenient rule without
 * a valid frequency.
 */
function checkRule(rule: JSCalendarRecurrenceRule, issue: Issues): { rule: JSCalendarRecurrenceRule; until?: Time } | null {
  const src = rule as unknown as Record<string, unknown>
  const bad = (what: string) => issue(`Invalid RecurrenceRule ${what}: ${JSON.stringify(rule)}`)
  if (src['@type'] != null && src['@type'] !== 'RecurrenceRule') bad('@type')
  const f = src.frequency
  const frequency = (issue.strict || typeof f !== 'string' ? f : f.toLowerCase()) as JSCalendarFrequency
  if (typeof frequency !== 'string' || !FREQUENCIES.includes(frequency)) {
    bad('frequency')
    return null
  }
  const r: JSCalendarRecurrenceRule = { frequency }
  let until: Time | undefined
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  const integer = (key: string, min: number) => {
    const v = src[key]
    if (v == null) return undefined
    if (isInt(v) && v >= min) return v
    bad(key)
    return undefined
  }
  const ints = (key: string, max: number, { signed = false, min = 1 } = {}) => {
    const v = src[key]
    if (v == null) return undefined
    if (!Array.isArray(v)) {
      bad(key)
      return undefined
    }
    const out: number[] = []
    for (const e of v as unknown[]) {
      if (isInt(e) && (signed ? e !== 0 && Math.abs(e) >= min && Math.abs(e) <= max : e >= min && e <= max)) out.push(e)
      else bad(`${key} value ${String(e)}`)
    }
    return out.length ? out : undefined
  }
  const lower = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const v = src[key]
    if (v == null) return undefined
    const s = typeof v === 'string' ? (issue.strict ? v : v.toLowerCase()) : undefined
    if (s !== undefined && (allowed as readonly string[]).includes(s)) return s as T
    bad(key)
    return undefined
  }
  const interval = integer('interval', 1)
  if (interval !== undefined) r.interval = interval
  const count = integer('count', 0)
  if (count !== undefined) r.count = count
  const countAndUntil = count !== undefined && src.until != null
  if (countAndUntil) bad('count with until (until left out)')
  if (src.until != null && !countAndUntil) {
    const local = localDateTime(src.until)
    if (local) until = { value: local, utc: false, date: false }
    else if (issue.strict || typeof src.until !== 'string') bad('until')
    else until = lenientTime(src.until, 'until', issue) ?? undefined
    if (until) r.until = formatLocal(until.value)
  }
  if (src.rscale != null) {
    const v = src.rscale
    if (typeof v === 'string' && /^[a-z0-9-]+$/i.test(v)) r.rscale = v.toLowerCase()
    else bad('rscale')
  }
  const skip = lower('skip', ['omit', 'backward', 'forward'] as const)
  if (skip !== undefined) r.skip = skip
  const firstDayOfWeek = lower('firstDayOfWeek', DAYS)
  if (firstDayOfWeek !== undefined) r.firstDayOfWeek = firstDayOfWeek
  if (src.byDay != null) {
    const v = src.byDay
    if (!Array.isArray(v)) bad('byDay')
    else {
      const days: JSCalendarNDay[] = []
      for (const d of v as unknown[]) {
        const nd = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>
        const name = typeof nd.day === 'string' ? (issue.strict ? nd.day : nd.day.toLowerCase()) : undefined
        const dayOk = DAYS.includes(name as JSCalendarDay)
        if (typeof d !== 'object' || d === null || !dayOk || (nd['@type'] != null && nd['@type'] !== 'NDay')) {
          bad(`byDay value ${JSON.stringify(d)}`)
          if (typeof d !== 'object' || d === null || !dayOk) continue
        }
        const nth = nd.nthOfPeriod
        const nthOk = nth == null || (isInt(nth) && nth !== 0 && Math.abs(nth) <= 53)
        if (!nthOk) bad(`nthOfPeriod ${String(nth)}`)
        days.push({ day: name as JSCalendarDay, ...(nth != null && nthOk ? { nthOfPeriod: nth as number } : {}) })
      }
      if (days.length) r.byDay = days
    }
  }
  if (src.byMonth != null) {
    const v = src.byMonth
    if (!Array.isArray(v)) bad('byMonth')
    else {
      const months: string[] = []
      for (const m of v as unknown[]) {
        if (isInt(m) && m >= 1) months.push(String(m))
        else if (typeof m === 'string' && /^[1-9]\d*L?$/.test(m)) months.push(m)
        else bad(`byMonth value ${String(m)}`)
      }
      if (months.length) r.byMonth = months
    }
  }
  const ranges = (r.rscale ?? 'gregorian') === 'gregorian' ? 'gregorian' : 'other'
  const lists: [keyof JSCalendarRecurrenceRule, number, { signed?: boolean; min?: number }][] = [
    ['byMonthDay', 31, { signed: true }],
    ['byYearDay', MAX_YEAR_DAY[ranges], { signed: true }],
    ['byWeekNo', MAX_WEEK_NO[ranges], { signed: true }],
    ['byHour', 23, { min: 0 }],
    ['byMinute', 59, { min: 0 }],
    ['bySecond', 60, { min: 0 }],
    ['bySetPosition', 366, { signed: true }],
  ]
  for (const [key, max, o] of lists) {
    const v = ints(key, max, o)
    if (v) (r as unknown as Record<string, unknown>)[key] = v
  }
  return { rule: r, until }
}

// ---------------------------------------------------------------------------
// EXDATE / RDATE <-> recurrenceOverrides.

export interface RecurrenceOverridesFromICalOptions {
  /** Converts a UTC value or one with a TZID to the event's wall clock. */
  toEventTime?: ToEventTime
  /** The instant of a wall clock with a TZID, for a PERIOD that ends across a time change. */
  toInstant?: ToInstant
  /** Throw on any problem instead of leaving it out. */
  strict?: boolean
  /** Receives what lenient conversion left out or changed. */
  onWarning?: OnWarning
}

/**
 * iCalendar EXDATE and RDATE properties as JSCalendar `recurrenceOverrides`
 * (draft sections 2.3.18 and 2.3.30).
 *
 * `properties` are property lines such as
 * `EXDATE;TZID=Europe/Berlin:20240102T090000,20240103T090000`,
 * `RDATE;VALUE=DATE:20240105` or `RDATE;VALUE=PERIOD:20231223T150000Z/PT2H`
 * (several per string, folded or not).
 *
 * Each value becomes a key, a LocalDateTime in the event's time zone: a date
 * is that day at midnight, a local time stays as written, and a UTC time or
 * one with a TZID goes through `toEventTime` (without it, the fields are
 * kept, which is right when they are already in the event's zone). An EXDATE
 * maps to `{"excluded": true}`, an RDATE to `{}`, or to `{"duration": …}` for
 * a PERIOD. A PERIOD in UTC or with a TZID gets the time elapsed in its own
 * zone, in hours (exact across a time change with `toInstant`), from an
 * explicit end or from a duration with days or weeks (RFC 5545 adds those
 * in the value's zone); a floating PERIOD keeps its duration as written.
 *
 * An EXDATE excludes RDATEs too (RFC 5545 section 3.8.5.1). It is matched
 * by instant when both values have one (UTC, or a TZID with `toInstant`),
 * else by key, before the keys are formed: in the repeated hour of a time
 * change, two instants have one local time, and excluding one keeps the
 * other. Two RDATE instants left with one key are reported (lenient: one is
 * kept; strict: throws), since a key names one occurrence.
 *
 * Lenient by default: other properties and values that cannot be read are
 * left out (reported to `onWarning`); names may be in any case; a value may
 * disagree with its VALUE type; an EXDATE PERIOD counts by its start. With
 * `strict`, these throw.
 */
export function recurrenceOverridesFromICal(
  properties: string[],
  { toEventTime, toInstant, strict = false, onWarning }: RecurrenceOverridesFromICalOptions = {}
): Record<string, JSCalendarPatch> {
  const issue = issues(strict, onWarning)
  // Each value with its key and, when known, its instant: an EXDATE removes
  // the RDATEs of its instant (two instants can have one local time, in the
  // repeated hour of a time change), then what is left becomes the keys.
  const rdates: { key: string; instant?: number; patch: JSCalendarPatch }[] = []
  const exdates: { key: string; instant?: number }[] = []
  for (const text of properties) {
    for (const line of lines(text)) {
      let p: ReturnType<typeof property>
      try {
        p = property(line)
      } catch (e) {
        issue((e as Error).message)
        continue
      }
      const { name } = p
      if (name !== 'EXDATE' && name !== 'RDATE') {
        issue(`Not an EXDATE or RDATE: ${line}`)
        continue
      }
      const type = p.params.VALUE?.toUpperCase()
      const tzid = p.params.TZID
      if ((type !== undefined && !['DATE', 'DATE-TIME', 'PERIOD'].includes(type)) ||
          (type === 'PERIOD' && name === 'EXDATE')) {
        issue(`Unsupported VALUE=${type} in ${line}`)
        if (type !== 'PERIOD') continue
      }
      const read = (s: string): Time | null => {
        if (!strict) return lenientTime(s, name, issue)
        const v = icalValue(s)
        if ((type === 'DATE' && !v.date) || (type === 'DATE-TIME' && v.date)) fail(`Value ${s} is not VALUE=${type}`)
        return v
      }
      // The instant of a value (UTC, or with a TZID and toInstant), if known.
      const zoneOf = (v: Time) => (v.utc ? 'Etc/UTC' : v.date ? undefined : tzid)
      const instantOf = (v: Time) => {
        if (v.utc) return (d: Date) => d
        const zone = zoneOf(v)
        return zone !== undefined && toInstant ? (d: Date) => toInstant(d, zone) : undefined
      }
      const id = (v: Time) => {
        const zone = zoneOf(v)
        return {
          key: formatLocal(zone !== undefined && toEventTime ? toEventTime(v.value, zone) : v.value),
          instant: instantOf(v)?.(v.value).getTime(),
        }
      }
      for (const item of p.value.split(',')) {
        if (!item.trim()) continue
        const slash = item.indexOf('/')
        if (name === 'EXDATE') {
          const v = read(slash < 0 ? item.trim() : item.slice(0, slash).trim())
          if (v) exdates.push(id(v))
        } else if (type === 'PERIOD' || (!strict && slash >= 0)) {
          if (slash < 0) {
            issue(`Invalid PERIOD: ${item}`)
            continue
          }
          const a = read(item.slice(0, slash).trim())
          if (!a) continue
          const end = item.slice(slash + 1).trim()
          // The local time of a value without a time zone is the event's.
          const instant = a.utc || zoneOf(a) !== undefined ? instantOf(a) ?? ((d: Date) => d) : undefined
          let duration: string | undefined
          if (end.startsWith('P') || end.startsWith('+P')) {
            const d = end.replace('+', '')
            if (!DURATION.test(d)) issue(`Invalid duration: ${end}`)
            // Days and weeks are added in the value's time zone (RFC 5545
            // section 3.3.6), so they become the time elapsed there.
            else duration = instant && /[DW]/.test(d) ? exactDuration(a.value, d, instant) : d
          } else {
            const b = strict ? icalValue(end) : lenientTime(end, 'RDATE', issue)
            if (b) {
              if (b.value < a.value) issue(`PERIOD ends before it starts: ${item}`)
              else duration = durationBetween(a.value, b.value, a.date ? undefined : instant)
            }
          }
          rdates.push({ ...id(a), patch: duration !== undefined ? { duration } : {} })
        } else {
          const v = read(item.trim())
          if (v) rdates.push({ ...id(v), patch: {} })
        }
      }
    }
  }
  const same = (a: { key: string; instant?: number }, b: { key: string; instant?: number }) =>
    a.instant !== undefined && b.instant !== undefined ? a.instant === b.instant : a.key === b.key
  const kept = rdates.filter((r) => !exdates.some((e) => same(e, r)))
  const out: Record<string, JSCalendarPatch> = {}
  for (const k of [...new Set([...rdates.map((r) => r.key), ...exdates.map((e) => e.key)])].sort()) {
    const here = kept.filter((r) => r.key === k)
    if (!here.length) {
      if (exdates.some((e) => e.key === k)) out[k] = { excluded: true }
      continue
    }
    const instants = new Set(here.map((r) => r.instant))
    if (instants.size > 1) {
      issue(`RDATE values at ${instants.size} instants have the same local time ${k} in the event's time zone; one is kept`)
    }
    out[k] = here[here.length - 1].patch
  }
  return out
}

export interface RecurrenceOverridesToICalOptions {
  /** The form of the event's DTSTART (default `local`). */
  form?: ICalDateForm
  /** The event's time zone, for the TZID parameter of `form: 'zoned'`. */
  timeZone?: string
  /** Whether the rule generates the recurrence id (floating). */
  isOccurrence?: (recurrenceId: Date) => boolean
  /** Throw on any problem instead of leaving it out. */
  strict?: boolean
  /** Receives what lenient conversion left out or changed. */
  onWarning?: OnWarning
}

/** The iCalendar properties of a recurrence, and what they cannot hold. */
export interface ICalRecurrenceDates {
  /**
   * Property lines. From `recurrenceToICal`: RRULE and EXRULE lines first;
   * then, as from `recurrenceOverridesToICal`, one EXDATE, one RDATE and one
   * RDATE;VALUE=PERIOD, each only when needed, values in key order.
   */
  properties: string[]
  /** Recurrence ids whose patch changes the occurrence: for a recurrence override component (the caller's). */
  overrides: string[]
}

/**
 * JSCalendar `recurrenceOverrides` as EXDATE and RDATE properties (draft
 * section 3.2): an `excluded` patch is an EXDATE; a recurrence id that the
 * rule does not generate is an RDATE (a PERIOD when the patch only sets
 * `duration`); any other patch is left to `overrides`.
 *
 * Without `isOccurrence` (whether the rule generates a recurrence id), an
 * empty patch counts as an RDATE, a duration-only patch as an RDATE and an
 * override (right whether the date is added or generated: an RDATE of a
 * generated date changes nothing), and every other patch as an override.
 * Values are written in `form` (the event's DTSTART form; with `zoned`, a
 * TZID parameter of `timeZone`). A duration that a PERIOD cannot hold (with
 * `date`, or a zero duration, which RFC 5545 does not allow) is left to the
 * overrides, next to a plain RDATE.
 *
 * Lenient by default: a key that is not a LocalDateTime is read as well as it
 * can be (a date, fractional seconds, a `Z` that is dropped), a key with a
 * time in the `date` form gives its date, and a patch that is not an object
 * is left out (all reported to `onWarning`). With `strict`, these throw.
 */
export function recurrenceOverridesToICal(
  overrides: Record<string, unknown>,
  options: RecurrenceOverridesToICalOptions = {}
): ICalRecurrenceDates {
  return overridesToICal(overrides, options)
}

function overridesToICal(
  overrides: Record<string, unknown>,
  { form = 'local', timeZone, isOccurrence, strict = false, onWarning }: RecurrenceOverridesToICalOptions
): ICalRecurrenceDates {
  if (form === 'zoned' && !timeZone) throw new TypeError("form 'zoned' needs the time zone")
  const issue = issues(strict, onWarning)
  const exdates: string[] = []
  const rdates: string[] = []
  const periods: string[] = []
  const rest: string[] = []
  for (const key of Object.keys(overrides).sort()) {
    let id = localDateTime(key)
    if (!id) {
      if (strict) fail(`Invalid recurrence id: ${key}`)
      const t = lenientTime(key, 'recurrence id', issue)
      if (!t) continue
      if (t.utc) issue(`Recurrence id ${key} is not a LocalDateTime; its UTC time is used`)
      id = t.value
    }
    if (form === 'date' && (id.getUTCHours() || id.getUTCMinutes() || id.getUTCSeconds())) {
      issue(`A date-only recurrence id must be at midnight: ${key}`)
    }
    const value = formatICal(id, { date: form === 'date', utc: form === 'utc' })
    const patch = overrides[key]
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      issue(`Invalid patch for ${key}: ${JSON.stringify(patch)}`)
      continue
    }
    const p = patch as JSCalendarPatch
    if (p.excluded === true) {
      exdates.push(value)
      continue
    }
    const keys = Object.keys(p)
    const durationOnly = keys.every((k) => k === 'duration')
    const generated = isOccurrence ? isOccurrence(id) : null
    if (generated === null ? durationOnly : !generated) {
      // A PERIOD only for a date the rule does not generate (known from
      // isOccurrence), with a positive duration (RFC 5545 section 3.3.9).
      const period = generated === false && durationOnly && typeof p.duration === 'string' &&
        form !== 'date' && DURATION.test(p.duration) && /[1-9]/.test(p.duration)
      if (durationOnly && p.duration != null && !(typeof p.duration === 'string' && DURATION.test(p.duration))) {
        issue(`Invalid duration for ${key}: ${String(p.duration)}`)
      }
      if (period) periods.push(`${value}/${p.duration as string}`)
      else rdates.push(value)
      // What the RDATE does not hold goes to an override component.
      if (!(keys.length === 0 || period)) rest.push(key)
    } else if (keys.length) {
      rest.push(key)
    }
  }
  rdates.sort()
  const valueParams = form === 'date' ? ';VALUE=DATE' : form === 'zoned' ? `;TZID=${paramValue(timeZone)}` : ''
  const zone = form === 'zoned' ? valueParams : ''
  return {
    properties: [
      ...(exdates.length ? [`EXDATE${valueParams}:${[...new Set(exdates)].join(',')}`] : []),
      ...(rdates.length ? [`RDATE${valueParams}:${[...new Set(rdates)].join(',')}`] : []),
      ...(periods.length ? [`RDATE;VALUE=PERIOD${zone}:${periods.join(',')}`] : []),
    ],
    overrides: [...new Set(rest)],
  }
}

// ---------------------------------------------------------------------------
// Whole recurrences.

/** The recurrence properties of a JSCalendar object. */
export interface JSCalendarRecurrence {
  /** One RecurrenceRule per RRULE. */
  recurrenceRules: JSCalendarRecurrenceRule[]
  /** RFC 8984 section 4.3.4: one per EXRULE. */
  excludedRecurrenceRules: JSCalendarRecurrenceRule[]
  /** From EXDATE and RDATE. */
  recurrenceOverrides: Record<string, JSCalendarPatch>
}

export interface RecurrenceFromICalOptions {
  toEventTime?: ToEventTime
  toInstant?: ToInstant
  keepRRuleMeaning?: boolean
  strict?: boolean
  onWarning?: OnWarning
}

/**
 * The recurrence of an iCalendar component (its RRULE, EXRULE, EXDATE and
 * RDATE lines, e.g. a Google event's `recurrence` array) as JSCalendar
 * `recurrenceRules`, `excludedRecurrenceRules` and `recurrenceOverrides`.
 *
 * Each RRULE and EXRULE goes through `rruleToJsCalendar` (with
 * `toEventTime` and `keepRRuleMeaning`); a rule without a readable
 * frequency is left out. EXDATE and RDATE go through
 * `recurrenceOverridesFromICal`. DTSTART lines are ignored. Lenient by
 * default: other lines are left out (reported to `onWarning`); with `strict`,
 * they and any problem of the parts throw.
 */
export function recurrenceFromICal(properties: string[], options: RecurrenceFromICalOptions = {}): JSCalendarRecurrence {
  const issue = issues(!!options.strict, options.onWarning)
  const recurrenceRules: JSCalendarRecurrenceRule[] = []
  const excludedRecurrenceRules: JSCalendarRecurrenceRule[] = []
  const dates: string[] = []
  for (const text of properties) {
    for (const line of lines(text)) {
      const name = /^([A-Za-z-]+)/.exec(line)?.[1]?.toUpperCase()
      if (name === 'RRULE' || name === 'EXRULE') {
        const rule = rruleToJsCalendar(line, options)
        if (rule) (name === 'RRULE' ? recurrenceRules : excludedRecurrenceRules).push(rule)
      } else if (name === 'EXDATE' || name === 'RDATE') {
        dates.push(line)
      } else if (name !== 'DTSTART') {
        issue(`Ignored ${name ?? 'line'} in a recurrence: ${line}`)
      }
    }
  }
  return {
    recurrenceRules,
    excludedRecurrenceRules,
    recurrenceOverrides: recurrenceOverridesFromICal(dates, options),
  }
}

export interface RecurrenceToICalOptions {
  /** The form of the event's DTSTART (default `local`), for UNTIL and the dates. */
  form?: ICalDateForm
  timeZone?: string
  toUtc?: ToUtc
  toEventTime?: ToEventTime
  start?: Date
  keepJsCalendarMeaning?: boolean
  isOccurrence?: (recurrenceId: Date) => boolean
  strict?: boolean
  onWarning?: OnWarning
}

/**
 * JSCalendar `recurrenceRules`, `excludedRecurrenceRules` and
 * `recurrenceOverrides` as iCalendar lines: `RRULE:…` and `EXRULE:…` from
 * `jsCalendarToRRule` (with `until` in `form`, `toUtc`, `toEventTime`,
 * `start` and `keepJsCalendarMeaning`), then EXDATE and RDATE from
 * `recurrenceOverridesToICal` (with `form`, `timeZone` and `isOccurrence`).
 * A rule without a valid frequency is left out (lenient) or throws (`strict`).
 *
 * Each rule is written as `jsCalendarToRRule` writes it, warnings included:
 * a start that a rule does not generate stays as it is (see there).
 */
export function recurrenceToICal(
  recurrence: {
    recurrenceRules?: JSCalendarRecurrenceRule[] | null
    excludedRecurrenceRules?: JSCalendarRecurrenceRule[] | null
    recurrenceOverrides?: Record<string, unknown> | null
  },
  options: RecurrenceToICalOptions = {}
): ICalRecurrenceDates {
  const rule = (r: JSCalendarRecurrenceRule) => jsCalendarToRRule(r, { ...options, untilForm: options.form })
  const properties: string[] = []
  for (const r of recurrence.recurrenceRules ?? []) {
    const s = rule(r)
    if (s !== null) properties.push(`RRULE:${s}`)
  }
  for (const r of recurrence.excludedRecurrenceRules ?? []) {
    const s = rule(r)
    if (s !== null) properties.push(`EXRULE:${s}`)
  }
  const dates = overridesToICal(recurrence.recurrenceOverrides ?? {}, options)
  return { properties: [...properties, ...dates.properties], overrides: dates.overrides }
}

// ---------------------------------------------------------------------------
// Helpers.

/** A parameter value, quoted when it contains `;`, `:` or `,`. */
const paramValue = (v: string) => (/[;:,]/.test(v) ? `"${v}"` : v)

/** Name, parameters (upper-case names, unquoted values) and value of a content line. */
function property(line: string): { name: string; params: Record<string, string>; value: string } {
  let inQuotes = false
  let colon = -1
  for (let i = 0; i < line.length && colon < 0; i++) {
    if (line[i] === '"') inQuotes = !inQuotes
    if (line[i] === ':' && !inQuotes) colon = i
  }
  if (colon < 0) fail(`Invalid property: ${line}`)
  const head = line.slice(0, colon).trim()
  const name = /^[A-Za-z0-9-]+/.exec(head)?.[0]?.toUpperCase()
  if (!name) fail(`Invalid property: ${line}`)
  const found: Record<string, string> = {}
  const rest = head.slice(name.length)
  let at = 0
  for (const m of params(rest)) {
    if (m.index !== at) fail(`Invalid parameters: ${line}`)
    found[m[1].toUpperCase()] = m[2].replace(/"/g, '')
    at = m.index + m[0].length
  }
  if (at !== rest.length) fail(`Invalid parameters: ${line}`)
  return { name, params: found, value: line.slice(colon + 1).trim() }
}

const DURATION = /^P(?:\d+W|(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/

/**
 * The JSCalendar Duration (RFC 8984 section 1.4.6) of the time elapsed from
 * the wall clock `a` to `b`, in hours, minutes and seconds (`PT2H`, `PT24H`):
 * RFC 8984 adds such a duration as exact time, so the end instant is kept
 * whatever the event's time zone (nominal days would be added in the event's
 * wall clock). With `instant` (the UTC instant of a wall clock) it is exact
 * across a time change; without it, it is the wall-clock difference.
 */
function durationBetween(a: Date, b: Date, instant: (d: Date) => Date = (d) => d): string {
  return elapsed((instant(b).getTime() - instant(a).getTime()) / 1000)
}

/**
 * A Duration from the wall clock `a` as the time elapsed: its weeks and days
 * are added to the wall clock (nominal), the rest as exact time (RFC 5545
 * section 3.3.6, RFC 8984 section 1.4.6), with `instant` the UTC instant of
 * a wall clock.
 */
function exactDuration(a: Date, duration: string, instant: (d: Date) => Date): string {
  const [date, time = ''] = duration.split('T')
  const days = Number(/(\d+)W/.exec(date)?.[1] ?? 0) * 7 + Number(/(\d+)D/.exec(date)?.[1] ?? 0)
  const t = (unit: string) => Number(new RegExp(`(\\d+)${unit}`).exec(time)?.[1] ?? 0)
  const end = new Date(a.getTime() + days * 86_400_000)
  return elapsed((instant(end).getTime() - instant(a).getTime()) / 1000 + t('H') * 3600 + t('M') * 60 + t('S'))
}

/** Seconds as a Duration of hours, minutes and seconds (`PT0S` for none). */
function elapsed(seconds: number): string {
  const s = Math.max(Math.round(seconds), 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const time = `${h ? `${h}H` : ''}${m ? `${m}M` : ''}${sec ? `${sec}S` : ''}`
  return time ? `PT${time}` : 'PT0S'
}
