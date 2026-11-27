/**
 * Conversion between iCalendar (RFC 5545, RFC 7529) recurrence and JSCalendar
 * (RFC 8984) recurrence, as draft-ietf-calext-jscalendar-icalendar-31 defines
 * it:
 *
 *  - RRULE <-> RecurrenceRule (section 2.3.33, and the UNTIL remark of 3.2);
 *  - EXDATE and RDATE <-> recurrenceOverrides (sections 2.3.18, 2.3.30 and
 *    the recurrenceOverrides remark of 3.2).
 *
 * Same behaviour as packages/dart/lib/src/jscalendar.dart; both run the
 * shared fixtures (fixtures/*.json, `jscal`, and fixtures/conversion/).
 *
 * Times are floating, as for rule expansion: `Date`s whose UTC fields hold the
 * wall clock. Time zones are the caller's: the functions take a converter
 * where the draft needs one (an UNTIL in UTC, an EXDATE with a TZID).
 *
 * Errors are thrown as `Error`s, like the rest of the package.
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

/** The values of an RRULE value (`FREQ=…;…`), parts as written. */
function ruleValues(body: string): RuleValues {
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
        o.bymonth = ints(value)
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
        if (value.toUpperCase() !== 'GREGORIAN') fail(`Unsupported RSCALE: ${value}`)
        o.rscale = value.toLowerCase()
        break
      default:
        fail(`Unknown RRULE property '${key}'`)
    }
  }
  return o
}

// DTSTART at the start of the line or after a `;`, parameters in any order
// (lists of quoted or plain values), then `:` or `=` and the value.
const DTSTART =
  /(?<=^|;)DTSTART((?:;[A-Z0-9-]+=(?:"[^"]*"|[^;:,"]*)(?:,(?:"[^"]*"|[^;:,"]*))*)*)(?::|=)([^;\s]*)/i
const PARAM = ';([A-Z0-9-]+)=((?:"[^"]*"|[^;:,"]*)(?:,(?:"[^"]*"|[^;:,"]*))*)'

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
function ruleParts(s: string): Map<string, string> {
  const merged = new Map<string, string>()
  const lines = s
    .replace(/\r?\n[ \t]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length)
  lines.forEach((line, index) => {
    const header = /^([A-Z]+?)[:;]/.exec(line.toUpperCase())?.[1] ?? null
    if (header === null || header === 'RRULE' || header === 'EXRULE') {
      let body = line.replace(/^(?:RRULE|EXRULE):/i, '')
      const inline = DTSTART.exec(body)
      if (inline) {
        checkDtstart(inline)
        body = body.slice(0, inline.index) + body.slice(inline.index + inline[0].length)
      }
      const attrs = body
        .split(';')
        .filter((a) => a.length && !a.toUpperCase().startsWith('TZID='))
        .map((a) => (a.toUpperCase().startsWith('BYWEEKDAY=') ? `BYDAY${a.slice(9)}` : a))
      ruleValues(attrs.join(';'))
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
  const d = new Date(Date.UTC(g(1), g(2) - 1, g(3), g(4), g(5), second))
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
  const d = new Date(Date.UTC(g(1), g(2) - 1, g(3), g(4), g(5), g(6)))
  return d.getUTCFullYear() === g(1) && d.getUTCMonth() + 1 === g(2) && d.getUTCDate() === g(3) &&
    d.getUTCHours() === g(4) && d.getUTCMinutes() === g(5) && d.getUTCSeconds() === g(6)
    ? d
    : null
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
// RRULE -> RecurrenceRule.

export interface RRuleToJsCalendarOptions {
  /** Converts a UTC UNTIL to the event's wall clock; without it the UTC fields are kept. */
  toEventTime?: ToEventTime
  /** Adds properties so that JSCalendar gives the rrule.js occurrences. */
  keepRRuleMeaning?: boolean
}

/**
 * An RFC 5545 RRULE as a JSCalendar RecurrenceRule (draft section 2.3.33).
 *
 * `rrule` is what `RRule.parseString` reads (a value such as
 * `FREQ=WEEKLY;BYDAY=MO`, an `RRULE:` line, with or without a DTSTART line;
 * DTSTART does not belong to the rule and is ignored).
 *
 * Each part maps to its property: values in lower case, BYDAY to NDay
 * objects, BYMONTH to strings. Only the parts in `rrule` are set, so
 * `interval` is left out unless INTERVAL is written. UNTIL becomes a
 * LocalDateTime in the event's time zone: a date is that day at midnight, a
 * local time stays as written, and a UTC time goes through `toEventTime`
 * (called with `Etc/UTC`; without it the UTC fields are kept, which is right
 * for events in UTC or without a time zone).
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
 * Throws for an RRULE the parser rejects, one without FREQ, values outside
 * RFC 5545's ranges, INTERVAL=0, or an impossible UNTIL date. COUNT and UNTIL
 * together (which RFC 5545 forbids) are both kept.
 */
export function rruleToJsCalendar(
  rrule: string,
  options: RRuleToJsCalendarOptions = {}
): JSCalendarRecurrenceRule {
  const parts = ruleParts(rrule)
  if (!parts.has('FREQ')) fail(`RRULE without FREQ: ${rrule}`)
  const o = ruleValues([...parts].map(([k, v]) => `${k}=${v}`).join(';'))
  // RFC 5545 ranges, as rule expansion checks them.
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
    byyearday: o.byyearday ?? null,
    byweekno: o.byweekno ?? null,
    byhour: o.byhour ?? null,
    byminute: o.byminute ?? null,
    bysecond: o.bysecond ?? null,
  }
  new RRule(opts)
  // RFC 8984: interval >= 1 (rrule.js takes INTERVAL=0 and repeats nothing).
  if ((o.interval ?? 1) < 1) fail(`INTERVAL must be at least 1: ${rrule}`)

  const rule: JSCalendarRecurrenceRule = { '@type': 'RecurrenceRule', frequency: o.freq }
  if (o.interval !== undefined) rule.interval = o.interval
  if (o.rscale !== undefined) rule.rscale = o.rscale
  if (o.skip !== undefined) rule.skip = o.skip
  if (o.wkst !== undefined) rule.firstDayOfWeek = DAYS[o.wkst]
  if (o.byday) {
    rule.byDay = o.byday.map((d) => ({
      '@type': 'NDay',
      day: DAYS[d.day],
      ...(d.n !== null ? { nthOfPeriod: d.n } : {}),
    }))
  }
  if (o.bymonthday) rule.byMonthDay = o.bymonthday
  if (o.bymonth) rule.byMonth = o.bymonth.map(String)
  if (o.byyearday) rule.byYearDay = o.byyearday
  if (o.byweekno) rule.byWeekNo = o.byweekno
  if (o.byhour) rule.byHour = o.byhour
  if (o.byminute) rule.byMinute = o.byminute
  if (o.bysecond) rule.bySecond = o.bysecond
  if (o.bysetpos) rule.bySetPosition = o.bysetpos
  if (o.count !== undefined) rule.count = o.count
  if (o.until !== undefined) {
    const v = icalValue(o.until)
    rule.until = formatLocal(v.utc && options.toEventTime ? options.toEventTime(v.value, 'Etc/UTC') : v.value)
  }
  return options.keepRRuleMeaning ? rruleMeaningInJsCalendar(rule) : rule
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
 *    would count it within the month.
 *
 * The properties are start-independent, so the result is the same for every
 * start. Other rules are returned unchanged (as a copy).
 *
 * One kind of rule has no JSCalendar form with the rrule.js occurrences and
 * stays as it is: yearly, with `byMonthDay`, no `byMonth`, `byWeekNo` or
 * `byYearDay`, and a `byDay` with `nthOfPeriod`. Adding `byMonth` would turn
 * "the 3rd Tuesday of the year" into "of each month".
 */
export function rruleMeaningInJsCalendar(rule: JSCalendarRecurrenceRule): JSCalendarRecurrenceRule {
  const r: JSCalendarRecurrenceRule = { ...rule }
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
        if (!has('byMonth') && !has('byWeekNo') && has('byMonthDay') && !nth) {
          r.byMonth = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
        }
        if (has('byWeekNo') && !has('byMonthDay') && !has('byDay')) r.byDay = allDays()
      }
      break
  }
  return r
}

// ---------------------------------------------------------------------------
// RecurrenceRule -> RRULE.

export interface JsCalendarToRRuleOptions {
  /** The form of the event's DTSTART, for UNTIL (default `local`). */
  untilForm?: ICalDateForm
  /** Converts the event's wall clock to UTC; required with `untilForm: 'zoned'` and an `until`. */
  toUtc?: ToUtc
  /** The event's start (floating), required with `keepJsCalendarMeaning`. */
  start?: Date
  /** Adds the properties RFC 8984 implicitly adds for `start`. */
  keepJsCalendarMeaning?: boolean
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
 * `byMonthDay` gets BYMONTH with the start month.
 *
 * Throws for a rule that is not a valid RecurrenceRule: an unknown frequency
 * or day, a value out of range, a malformed `until`. Empty arrays count as
 * absent; other unknown members are ignored.
 */
export function jsCalendarToRRule(
  rule: JSCalendarRecurrenceRule,
  options: JsCalendarToRRuleOptions = {}
): string {
  const r = checkRule(rule)
  if (options.keepJsCalendarMeaning) {
    if (!options.start) throw new TypeError('keepJsCalendarMeaning needs the start')
    addImplicitProperties(r, options.start)
  }
  const parts = [`FREQ=${r.frequency.toUpperCase()}`]
  const add = (name: string, v: unknown[] | undefined) => {
    if (v && v.length) parts.push(`${name}=${v.join(',')}`)
  }
  if (r.interval !== undefined && r.interval !== 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.count !== undefined) parts.push(`COUNT=${r.count}`)
  if (r.until !== undefined) parts.push(`UNTIL=${untilToICal(r.until, options)}`)
  add('BYMONTH', r.byMonth)
  add('BYWEEKNO', r.byWeekNo)
  add('BYYEARDAY', r.byYearDay)
  add('BYMONTHDAY', r.byMonthDay)
  add('BYDAY', r.byDay?.map((d) => `${d.nthOfPeriod ?? ''}${d.day.toUpperCase()}`))
  add('BYHOUR', r.byHour)
  add('BYMINUTE', r.byMinute)
  add('BYSECOND', r.bySecond)
  add('BYSETPOS', r.bySetPosition)
  if (r.firstDayOfWeek !== undefined) parts.push(`WKST=${r.firstDayOfWeek.toUpperCase()}`)
  if (r.rscale !== undefined || r.skip !== undefined) {
    parts.push(`RSCALE=${(r.rscale ?? 'gregorian').toUpperCase()}`)
  }
  if (r.skip !== undefined) parts.push(`SKIP=${r.skip.toUpperCase()}`)
  return parts.join(';')
}

function untilToICal(until: string, { untilForm = 'local', toUtc }: JsCalendarToRRuleOptions) {
  const d = localDateTime(until)
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

/** RFC 8984 section 4.3.3.1 step 3, the date parts. As tools/lib/jscal.mjs. */
function addImplicitProperties(r: JSCalendarRecurrenceRule, start: Date) {
  const has = (k: keyof JSCalendarRecurrenceRule) => Array.isArray(r[k]) && (r[k] as unknown[]).length > 0
  const day = DAYS[(start.getUTCDay() + 6) % 7]
  const hadByDay = has('byDay')
  const hadByMonthDay = has('byMonthDay')
  switch (r.frequency) {
    case 'weekly':
      if (!hadByDay) r.byDay = [{ '@type': 'NDay', day }]
      break
    case 'monthly':
      if (!hadByDay && !hadByMonthDay) r.byMonthDay = [start.getUTCDate()]
      break
    case 'yearly':
      if (!has('byYearDay')) {
        if (!has('byMonth') && !has('byWeekNo') && (hadByMonthDay || !hadByDay)) {
          r.byMonth = [String(start.getUTCMonth() + 1)]
        }
        if (!hadByMonthDay && !has('byWeekNo') && !hadByDay) r.byMonthDay = [start.getUTCDate()]
        if (has('byWeekNo') && !hadByMonthDay && !hadByDay) r.byDay = [{ '@type': 'NDay', day }]
      }
      break
  }
}

/** A checked copy: types and ranges of RFC 8984 section 4.3.3; empty arrays dropped. */
function checkRule(rule: JSCalendarRecurrenceRule): JSCalendarRecurrenceRule {
  const bad = (what: string): never => fail(`Invalid RecurrenceRule ${what}: ${JSON.stringify(rule)}`)
  const src = rule as unknown as Record<string, unknown>
  if (src['@type'] != null && src['@type'] !== 'RecurrenceRule') bad('@type')
  const frequency = src.frequency as JSCalendarFrequency
  if (typeof frequency !== 'string' || !FREQUENCIES.includes(frequency)) bad('frequency')
  const r: JSCalendarRecurrenceRule = { frequency }
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  const integer = (key: string, min: number) => {
    const v = src[key]
    return isInt(v) && v >= min ? v : bad(key)
  }
  const ints = (key: string, max: number, { signed = false, min = 1 } = {}) => {
    const v = src[key]
    if (v == null) return undefined
    if (!Array.isArray(v)) bad(key)
    if (!(v as unknown[]).length) return undefined
    return (v as unknown[]).map((e) =>
      isInt(e) && (signed ? e !== 0 && Math.abs(e) >= min && Math.abs(e) <= max : e >= min && e <= max)
        ? e
        : bad(key)
    )
  }
  if (src.interval != null) r.interval = integer('interval', 1)
  if (src.count != null) r.count = integer('count', 0)
  if (src.until != null) {
    if (!localDateTime(src.until)) bad('until')
    r.until = src.until as string
  }
  if (src.rscale != null) {
    const v = src.rscale
    if (typeof v !== 'string' || !/^[a-z0-9-]+$/i.test(v)) bad('rscale')
    r.rscale = (v as string).toLowerCase()
  }
  if (src.skip != null) {
    const v = src.skip
    if (v !== 'omit' && v !== 'backward' && v !== 'forward') bad('skip')
    r.skip = v as JSCalendarRecurrenceRule['skip']
  }
  if (src.firstDayOfWeek != null) {
    const v = src.firstDayOfWeek as JSCalendarDay
    if (!DAYS.includes(v)) bad('firstDayOfWeek')
    r.firstDayOfWeek = v
  }
  if (src.byDay != null) {
    const v = src.byDay
    if (!Array.isArray(v)) bad('byDay')
    if ((v as unknown[]).length) {
      r.byDay = (v as unknown[]).map((d) => {
        const nd = d as Record<string, unknown>
        const nth = nd?.nthOfPeriod
        if (typeof d !== 'object' || d === null || (nd['@type'] != null && nd['@type'] !== 'NDay') ||
            !DAYS.includes(nd.day as JSCalendarDay) ||
            (nth != null && (!isInt(nth) || nth === 0 || Math.abs(nth) > 53))) {
          bad('byDay')
        }
        return { day: nd.day as JSCalendarDay, ...(nth != null ? { nthOfPeriod: nth as number } : {}) }
      })
    }
  }
  if (src.byMonth != null) {
    const v = src.byMonth
    if (!Array.isArray(v)) bad('byMonth')
    if ((v as unknown[]).length) {
      r.byMonth = (v as unknown[]).map((m) =>
        isInt(m) && m >= 1 ? String(m) : typeof m === 'string' && /^[1-9]\d*L?$/.test(m) ? m : bad('byMonth')
      )
    }
  }
  const byMonthDay = ints('byMonthDay', 31, { signed: true })
  const byYearDay = ints('byYearDay', 366, { signed: true })
  const byWeekNo = ints('byWeekNo', 53, { signed: true })
  const byHour = ints('byHour', 23, { min: 0 })
  const byMinute = ints('byMinute', 59, { min: 0 })
  const bySecond = ints('bySecond', 60, { min: 0 })
  const bySetPosition = ints('bySetPosition', 366, { signed: true })
  if (byMonthDay) r.byMonthDay = byMonthDay
  if (byYearDay) r.byYearDay = byYearDay
  if (byWeekNo) r.byWeekNo = byWeekNo
  if (byHour) r.byHour = byHour
  if (byMinute) r.byMinute = byMinute
  if (bySecond) r.bySecond = bySecond
  if (bySetPosition) r.bySetPosition = bySetPosition
  return r
}

// ---------------------------------------------------------------------------
// EXDATE / RDATE <-> recurrenceOverrides.

export interface RecurrenceOverridesFromICalOptions {
  /** Converts a UTC value or one with a TZID to the event's wall clock. */
  toEventTime?: ToEventTime
}

/**
 * iCalendar EXDATE and RDATE properties as JSCalendar `recurrenceOverrides`
 * (draft sections 2.3.18 and 2.3.30).
 *
 * `properties` are property lines such as
 * `EXDATE;TZID=Europe/Berlin:20240102T090000,20240103T090000`,
 * `RDATE;VALUE=DATE:20240105` or `RDATE;VALUE=PERIOD:20231223T150000Z/PT2H`
 * (several per string, folded or not; other properties are rejected).
 *
 * Each value becomes a key, a LocalDateTime in the event's time zone: a date
 * is that day at midnight, a local time stays as written, and a UTC time or
 * one with a TZID goes through `toEventTime` (without it, the fields are
 * kept, which is right when they are already in the event's zone). An EXDATE
 * maps to `{"excluded": true}`, an RDATE to `{}`, or to `{"duration": …}` for
 * a PERIOD (an explicit end becomes the duration between the two wall
 * clocks). An EXDATE wins over an RDATE for the same key, as it excludes
 * RDATEs too (RFC 5545 section 3.8.5.1).
 *
 * Throws for malformed or impossible values.
 */
export function recurrenceOverridesFromICal(
  properties: string[],
  { toEventTime }: RecurrenceOverridesFromICalOptions = {}
): Record<string, JSCalendarPatch> {
  const rdates = new Map<string, JSCalendarPatch>()
  const exdates = new Set<string>()
  for (const text of properties) {
    for (const raw of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const { name, params: ps, value } = property(line)
      if (name !== 'EXDATE' && name !== 'RDATE') fail(`Not an EXDATE or RDATE: ${line}`)
      const type = ps.VALUE?.toUpperCase()
      const tzid = ps.TZID
      if ((type !== undefined && !['DATE', 'DATE-TIME', 'PERIOD'].includes(type)) ||
          (type === 'PERIOD' && name === 'EXDATE')) {
        fail(`Unsupported VALUE=${type} in ${line}`)
      }
      const key = (s: string) => {
        const v = icalValue(s)
        if ((type === 'DATE' && !v.date) || (type === 'DATE-TIME' && v.date)) {
          fail(`Value ${s} is not VALUE=${type}`)
        }
        const zone = v.utc ? 'Etc/UTC' : v.date ? undefined : tzid
        return formatLocal(zone !== undefined && toEventTime ? toEventTime(v.value, zone) : v.value)
      }
      for (const item of value.split(',')) {
        if (name === 'EXDATE') {
          exdates.add(key(item))
        } else if (type === 'PERIOD') {
          const slash = item.indexOf('/')
          if (slash < 0) fail(`Invalid PERIOD: ${item}`)
          const start = item.slice(0, slash)
          const end = item.slice(slash + 1)
          const duration = end.startsWith('P') || end.startsWith('+P')
            ? checkDuration(end.replace('+', ''))
            : durationBetween(icalValue(start).value, icalValue(end).value)
          rdates.set(key(start), { duration })
        } else {
          rdates.set(key(item), {})
        }
      }
    }
  }
  const out: Record<string, JSCalendarPatch> = {}
  for (const k of [...new Set([...rdates.keys(), ...exdates])].sort()) {
    out[k] = exdates.has(k) ? { excluded: true } : rdates.get(k)
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
}

/** The EXDATE and RDATE properties of `recurrenceOverrides`, and what they cannot hold. */
export interface ICalRecurrenceDates {
  /** Property lines: one EXDATE, one RDATE, one RDATE;VALUE=PERIOD, each only when needed, values in key order. */
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
 * empty or duration-only patch counts as an RDATE and every other patch as an
 * override. Values are written in `form` (the event's DTSTART form; with
 * `zoned`, a TZID parameter of `timeZone`). With `date` the keys must be at
 * midnight, and a duration cannot be written: such an RDATE is also listed in
 * the overrides.
 *
 * Throws for a key that is not a LocalDateTime.
 */
export function recurrenceOverridesToICal(
  overrides: Record<string, unknown>,
  { form = 'local', timeZone, isOccurrence }: RecurrenceOverridesToICalOptions = {}
): ICalRecurrenceDates {
  if (form === 'zoned' && !timeZone) throw new TypeError("form 'zoned' needs the time zone")
  const exdates: string[] = []
  const rdates: string[] = []
  const periods: string[] = []
  const rest: string[] = []
  for (const key of Object.keys(overrides).sort()) {
    const id = localDateTime(key)
    if (!id) fail(`Invalid recurrence id: ${key}`)
    if (form === 'date' && (id.getUTCHours() || id.getUTCMinutes() || id.getUTCSeconds())) {
      fail(`A date-only recurrence id must be at midnight: ${key}`)
    }
    const value = formatICal(id, { date: form === 'date', utc: form === 'utc' })
    const patch = overrides[key]
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      fail(`Invalid patch for ${key}: ${JSON.stringify(patch)}`)
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
      const period = durationOnly && typeof p.duration === 'string' && form !== 'date'
      if (period) periods.push(`${value}/${checkDuration(p.duration as string)}`)
      else rdates.push(value)
      // What the RDATE does not hold goes to an override component.
      if (!(keys.length === 0 || period)) rest.push(key)
    } else if (keys.length) {
      rest.push(key)
    }
  }
  const valueParams = form === 'date' ? ';VALUE=DATE' : form === 'zoned' ? `;TZID=${paramValue(timeZone)}` : ''
  const zone = form === 'zoned' ? valueParams : ''
  return {
    properties: [
      ...(exdates.length ? [`EXDATE${valueParams}:${exdates.join(',')}`] : []),
      ...(rdates.length ? [`RDATE${valueParams}:${rdates.join(',')}`] : []),
      ...(periods.length ? [`RDATE;VALUE=PERIOD${zone}:${periods.join(',')}`] : []),
    ],
    overrides: [...new Set(rest)],
  }
}

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
  const head = line.slice(0, colon)
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
  return { name, params: found, value: line.slice(colon + 1) }
}

const DURATION = /^P(?:\d+W|(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/
const checkDuration = (d: string) => (DURATION.test(d) ? d : fail(`Invalid duration: ${d}`))

/** The duration from `a` to `b` (wall clocks), e.g. `PT2H` or `P1DT30M`. */
function durationBetween(a: Date, b: Date): string {
  let s = Math.round((b.getTime() - a.getTime()) / 1000)
  if (s < 0) fail(`PERIOD ends before it starts: ${formatLocal(a)}/${formatLocal(b)}`)
  const days = Math.floor(s / 86400)
  s %= 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const time = `${h ? `${h}H` : ''}${m ? `${m}M` : ''}${sec ? `${sec}S` : ''}`
  if (!days && !time) return 'PT0S'
  return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`
}
