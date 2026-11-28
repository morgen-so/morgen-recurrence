// Runs the hand-written JSCalendar conversion cases in
// ../../../fixtures/conversion/jscalendar.json (the Dart package runs the same
// file in packages/dart/test/conversion_test.dart). The conversions are also
// checked against the whole conformance corpus in conformance.test.ts.
import * as fs from 'fs'
import * as path from 'path'
import {
  ICalDateForm,
  jsCalendarToRRule,
  JSCalendarRecurrenceRule,
  recurrenceFromICal,
  recurrenceOverridesFromICal,
  recurrenceOverridesToICal,
  recurrenceToICal,
  rruleToJsCalendar,
} from '../src/index'

interface ConversionCase {
  id: string
  fn: string
  input: unknown
  options?: Record<string, unknown>
  expected: unknown
}

/** JSON with object keys sorted, for comparing results. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x
  )

type Offsets = Record<string, string | [string, string][]>
const fmt = (d: Date) => d.toISOString().slice(0, 19)

/** The offset of `zone` at the wall clock `wall`: a fixed one, or the last change at or before it. */
const offsetMs = (offsets: Offsets, zone: string, wall: Date) => {
  const z = offsets[zone] ?? (zone === 'Etc/UTC' ? '+00:00' : undefined)
  if (!z) throw new Error(`No offset for ${zone}`)
  const o = typeof z === 'string' ? z : [...z].reverse().find(([from]) => from <= fmt(wall))![1]
  const sign = o.startsWith('-') ? -1 : 1
  return sign * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6))) * 60_000
}
function run(c: ConversionCase, warnings: string[]): unknown {
  const o = c.options ?? {}
  const strict = o.strict === true
  const onWarning = (m: string) => warnings.push(m)
  const offsets = (o.offsets as Offsets) ?? {}
  const zone = o.eventTimeZone as string | undefined
  const toInstantFn = (wall: Date, tz: string) => new Date(wall.getTime() - offsetMs(offsets, tz, wall))
  const toEventTime = zone
    ? (wall: Date, tz: string) => {
        const instant = toInstantFn(wall, tz)
        // The event wall clock of the instant: try the offset at the instant's own wall clock.
        const guess = new Date(instant.getTime() + offsetMs(offsets, zone, instant))
        return new Date(instant.getTime() + offsetMs(offsets, zone, guess))
      }
    : undefined
  const toUtc = zone ? (wall: Date) => toInstantFn(wall, zone) : undefined
  const toInstant = o.toInstant === true ? toInstantFn : undefined
  const start = o.start ? new Date(`${o.start}Z`) : undefined
  switch (c.fn) {
    case 'rruleToJsCalendar':
      return rruleToJsCalendar(c.input as string, {
        toEventTime,
        keepRRuleMeaning: o.keepRRuleMeaning === true,
        strict,
        onWarning,
      })
    case 'jsCalendarToRRule':
      return jsCalendarToRRule(c.input as JSCalendarRecurrenceRule, {
        untilForm: o.untilForm as ICalDateForm,
        toUtc,
        toEventTime,
        start,
        keepJsCalendarMeaning: o.keepJsCalendarMeaning === true,
        strict,
        onWarning,
      })
    case 'recurrenceOverridesFromICal':
      return recurrenceOverridesFromICal(c.input as string[], { toEventTime, toInstant, strict, onWarning })
    case 'recurrenceOverridesToICal': {
      const occurrences = o.occurrences ? new Set(o.occurrences as string[]) : undefined
      return recurrenceOverridesToICal(c.input as Record<string, unknown>, {
        form: o.form as ICalDateForm,
        timeZone: o.timeZone as string,
        isOccurrence: occurrences ? (id) => occurrences.has(fmt(id)) : undefined,
        strict,
        onWarning,
      })
    }
    case 'recurrenceFromICal':
      return recurrenceFromICal(c.input as string[], {
        toEventTime,
        toInstant,
        keepRRuleMeaning: o.keepRRuleMeaning === true,
        strict,
        onWarning,
      })
    case 'recurrenceToICal':
      return recurrenceToICal(c.input as Parameters<typeof recurrenceToICal>[0], {
        form: o.form as ICalDateForm,
        timeZone: o.timeZone as string,
        toUtc,
        toEventTime,
        start,
        keepJsCalendarMeaning: o.keepJsCalendarMeaning === true,
        isOccurrence: o.occurrences ? (id) => (o.occurrences as string[]).includes(fmt(id)) : undefined,
        strict,
        onWarning,
      })
  }
  throw new Error(`Unknown fn ${c.fn}`)
}

describe('JSCalendar conversion fixtures', () => {
  const file = path.join(__dirname, '../../../fixtures/conversion/jscalendar.json')
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: ConversionCase[] }
  for (const c of cases) {
    it(`${c.fn}: ${c.id}`, () => {
      let got: unknown
      const warnings: string[] = []
      try {
        got = run(c, warnings)
      } catch (e) {
        if (e instanceof TypeError) throw e
        got = { error: true }
      }
      expect(canonical(got)).toBe(canonical(c.expected))
      if (canonical(got) !== canonical({ error: true })) {
        expect({ id: c.id, warnings: warnings.length }).toEqual({ id: c.id, warnings: (c.options?.warnings as number) ?? 0 })
      }
    })
  }

  it('zoned needs toUtc for an UNTIL, and a time zone for overrides', () => {
    expect(() =>
      jsCalendarToRRule({ frequency: 'daily', until: '2024-01-31T09:00:00' }, { untilForm: 'zoned' })
    ).toThrow(TypeError)
    expect(() => recurrenceOverridesToICal({}, { form: 'zoned' })).toThrow(TypeError)
  })

  it('keepJsCalendarMeaning needs the start', () => {
    expect(() => jsCalendarToRRule({ frequency: 'weekly' }, { keepJsCalendarMeaning: true })).toThrow(
      TypeError
    )
  })
})
