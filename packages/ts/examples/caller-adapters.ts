// The caller-side adapters of the README ("What the caller adapts" and
// "Replacing the ical.ts converters"), compiled by `npm run typecheck` and
// checked against the README by test/readme.test.ts, so the README's code
// compiles; test/readme.test.ts also runs `recurrenceLines` and
// `ruleForWrite`. The Morgen types below are stand-ins with the shapes of the
// projects' own types (desktop, Kai, backend, integration service); the
// moment-timezone and morgen-tz-service declarations are the parts used.
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  ICalDateForm,
  jsCalendarToRRule,
  JSCalendarDay,
  JSCalendarNDay,
  JSCalendarRecurrenceRule,
  OnWarning,
  recurrenceFromICal,
  RecurrenceFromICalOptions,
  recurrenceToICal,
  TimeZones,
} from '../src/index'

// --- Stand-ins for the projects' types and dependencies. -------------------

/**
 * Desktop and Kai (`src/shared/utils/jscalendar/types.ts`), and the backend
 * (`src/interfaces/jscalendar.interface.ts`, the same with `interval`
 * optional): weekdays are plain strings.
 */
interface MorgenNDay {
  '@type'?: 'NDay'
  day: string
  nthOfPeriod?: number
}
interface MorgenRecurrenceRule {
  '@type'?: 'RecurrenceRule'
  frequency: 'yearly' | 'monthly' | 'weekly' | 'daily'
  interval: number
  skip?: 'omit' | 'backward' | 'forward'
  firstDayOfWeek?: 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su'
  byDay?: MorgenNDay[]
  byMonthDay?: number[]
  byMonth?: string[]
  byYearDay?: number[]
  byWeekNo?: number[]
  byHour?: number[]
  byMinute?: number[]
  bySecond?: number[]
  bySetPosition?: number[]
  count?: number
  until?: string
  rscale?: string
}
/**
 * The integration service (`src/types/jscalendar.interface.ts`): weekdays
 * as the library's, `interval` optional, `rscale` a CLDR calendar id (the
 * keys of cldr-core's `supplemental/calendarData.json`).
 */
type CldrCalendar =
  | 'buddhist' | 'chinese' | 'coptic' | 'dangi' | 'ethiopic' | 'ethiopic-amete-alem' | 'generic'
  | 'gregorian' | 'hebrew' | 'indian' | 'islamic' | 'islamic-civil' | 'islamic-rgsa'
  | 'islamic-tbla' | 'islamic-umalqura' | 'japanese' | 'persian' | 'roc'
interface IntegrationRecurrenceRule extends Omit<MorgenRecurrenceRule, 'interval' | 'byDay' | 'rscale'> {
  interval?: number
  byDay?: JSCalendarNDay[]
  rscale?: CldrCalendar
}
declare const moment: {
  tz(value: string, zone: string): { utc(): { format(f: string): string } }
  utc(value: string): { tz(zone: string): { format(f: string): string } }
}
declare const TimezoneService: { Timezone: new (tz: string) => { ianaName: string } }
/** The project's warning sink (here: collected, for the test). */
const warnings: string[] = []
const onWarning: OnWarning = (message) => {
  warnings.push(message)
}

// --- README: "Morgen's rule type". ------------------------------------------

const MORGEN_FREQUENCIES = ['yearly', 'monthly', 'weekly', 'daily'] as const

/** A library rule as Morgen stores it, or null for a rule Morgen cannot store. */
function toMorgenRule(rule: JSCalendarRecurrenceRule | null): MorgenRecurrenceRule | null {
  if (!rule || !(MORGEN_FREQUENCIES as readonly string[]).includes(rule.frequency)) return null
  return { ...rule, frequency: rule.frequency as MorgenRecurrenceRule['frequency'], interval: rule.interval ?? 1 }
}

const DAYS: readonly string[] = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']
const isDay = (d: string): d is JSCalendarDay => DAYS.includes(d)

/** A stored rule: desktop's and Kai's, or the backend's and the integration service's (`interval` optional). */
type StoredRule = Omit<MorgenRecurrenceRule, 'interval'> & { interval?: number }

/** A stored Morgen rule as the library's rule: weekdays checked, unknown ones left out. */
function fromMorgenRule(rule: StoredRule, warn?: OnWarning): JSCalendarRecurrenceRule {
  const byDay = rule.byDay?.flatMap((d): JSCalendarNDay[] => {
    const day = d.day.toLowerCase()
    if (isDay(day)) return [{ ...d, day }]
    warn?.(`Unknown weekday ${d.day} left out`)
    return []
  })
  return { ...rule, byDay }
}

// --- README: the integration service's `rscale`. ----------------------------

// The integration service has this list as CLDR_CALENDAR_IDS (src/cldr/calendars.ts).
const CLDR_CALENDARS: readonly string[] = [
  'buddhist', 'chinese', 'coptic', 'dangi', 'ethiopic', 'ethiopic-amete-alem', 'generic', 'gregorian',
  'hebrew', 'indian', 'islamic', 'islamic-civil', 'islamic-rgsa', 'islamic-tbla', 'islamic-umalqura',
  'japanese', 'persian', 'roc',
]
const isCldrCalendar = (c: string): c is CldrCalendar => CLDR_CALENDARS.includes(c)

/** A library rule for the integration service, or null for a calendar it does not know. */
function toIntegrationRule(rule: JSCalendarRecurrenceRule | null): IntegrationRecurrenceRule | null {
  if (!rule || !(MORGEN_FREQUENCIES as readonly string[]).includes(rule.frequency)) return null
  const { rscale, ...rest } = { ...rule, frequency: rule.frequency as MorgenRecurrenceRule['frequency'] }
  if (rscale === undefined) return rest
  return isCldrCalendar(rscale) ? { ...rest, rscale } : null
}

/**
 * A rule for an integration-service write, or null when the service does not
 * take it: its write validator (passed in, it throws) accepts less than the
 * library writes, e.g. a fifth weekday or year day 370.
 */
function ruleForWrite(
  rule: JSCalendarRecurrenceRule | null,
  validate: (rule: IntegrationRecurrenceRule) => void
): IntegrationRecurrenceRule | null {
  const r = toIntegrationRule(rule)
  if (!r) return null
  try {
    validate(r)
    return r
  } catch (e) {
    onWarning(`Rule not written: ${(e as Error).message}`)
    return null
  }
}

// --- README: "No recurrence". ------------------------------------------------

function recurrenceRulesOrNull(lines: string[], options: RecurrenceFromICalOptions) {
  const r = recurrenceFromICal(lines, options)
  const recurrenceRules = r.recurrenceRules.length ? r.recurrenceRules : null
  return recurrenceRules
}

// --- README: "Replacing the ical.ts converters". -----------------------------

const fmt = (d: Date) => d.toISOString().slice(0, 19)
const floating = (s: string) => new Date(`${s}Z`)
const iana = (tz: string) => new TimezoneService.Timezone(tz === 'Etc/UTC' ? 'UTC' : tz).ianaName
const UTC_ZONES = ['UTC', 'Etc/UTC', 'Etc/UCT', 'UCT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu',
  'GMT', 'Etc/GMT', 'Etc/GMT0', 'GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'Etc/Greenwich', 'Greenwich']
const isUtc = (tz: string) => UTC_ZONES.includes(iana(tz))
const zones: TimeZones = {
  toInstant: (wall, tz) => floating(moment.tz(fmt(wall), iana(tz)).utc().format('YYYY-MM-DDTHH:mm:ss')),
  fromInstant: (instant, tz) => floating(moment.utc(fmt(instant)).tz(iana(tz)).format('YYYY-MM-DDTHH:mm:ss')),
}
const form = (allDay: boolean, tz?: string | null): ICalDateForm =>
  allDay ? 'date' : !tz ? 'local' : isUtc(tz) ? 'utc' : 'zoned'

/** The iCalendar lines of an event's recurrence: rules, overrides or both may be absent. */
function recurrenceLines(
  rules: StoredRule[] | null | undefined,
  overrides: Record<string, unknown> | null | undefined,
  allDay: boolean,
  tz: string | null | undefined,
  isOccurrence?: (recurrenceId: Date) => boolean
) {
  return recurrenceToICal(
    { recurrenceRules: (rules ?? []).map((r) => fromMorgenRule(r, onWarning)), recurrenceOverrides: overrides },
    { form: form(allDay, tz), timeZone: tz, zones, isOccurrence, onWarning }
  )
}

// The reverse direction compiles for each project's rule type: desktop and
// Kai (`interval` required), the backend (optional) and the integration service.
const reverse = (
  stored: MorgenRecurrenceRule,
  storedBackend: Omit<MorgenRecurrenceRule, 'interval'> & { interval?: number },
  storedIntegration: IntegrationRecurrenceRule
) => [
  jsCalendarToRRule(fromMorgenRule(stored, onWarning)),
  jsCalendarToRRule(fromMorgenRule(storedBackend, onWarning)),
  jsCalendarToRRule(storedIntegration),
  recurrenceLines([stored], null, false, 'Europe/Zurich'),
  recurrenceLines([storedBackend], null, false, 'Europe/Zurich'),
  recurrenceLines([storedIntegration], null, false, 'Europe/Zurich'),
]

export {
  reverse,
  fromMorgenRule,
  toIntegrationRule,
  ruleForWrite,
  toMorgenRule,
  recurrenceRulesOrNull,
  recurrenceLines,
  zones,
  form,
  warnings,
}
