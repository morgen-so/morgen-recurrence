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
  recurrenceOverridesFromICal,
  recurrenceOverridesToICal,
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

const offsetMs = (offsets: Record<string, string>, zone: string) => {
  const o = offsets[zone] ?? (zone === 'Etc/UTC' ? '+00:00' : undefined)
  if (!o) throw new Error(`No offset for ${zone}`)
  const sign = o.startsWith('-') ? -1 : 1
  return sign * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6))) * 60_000
}
const fmt = (d: Date) => d.toISOString().slice(0, 19)

function run(c: ConversionCase): unknown {
  const o = c.options ?? {}
  const offsets = (o.offsets as Record<string, string>) ?? {}
  const zone = o.eventTimeZone as string | undefined
  const toEventTime = zone
    ? (wall: Date, tz: string) => new Date(wall.getTime() - offsetMs(offsets, tz) + offsetMs(offsets, zone))
    : undefined
  const toUtc = zone ? (wall: Date) => new Date(wall.getTime() - offsetMs(offsets, zone)) : undefined
  switch (c.fn) {
    case 'rruleToJsCalendar':
      return rruleToJsCalendar(c.input as string, {
        toEventTime,
        keepRRuleMeaning: o.keepRRuleMeaning === true,
      })
    case 'jsCalendarToRRule':
      return jsCalendarToRRule(c.input as JSCalendarRecurrenceRule, {
        untilForm: o.untilForm as ICalDateForm,
        toUtc,
        start: o.start ? new Date(`${o.start}Z`) : undefined,
        keepJsCalendarMeaning: o.keepJsCalendarMeaning === true,
      })
    case 'recurrenceOverridesFromICal':
      return recurrenceOverridesFromICal(c.input as string[], { toEventTime })
    case 'recurrenceOverridesToICal': {
      const occurrences = o.occurrences ? new Set(o.occurrences as string[]) : undefined
      return recurrenceOverridesToICal(c.input as Record<string, unknown>, {
        form: o.form as ICalDateForm,
        timeZone: o.timeZone as string,
        isOccurrence: occurrences ? (id) => occurrences.has(fmt(id)) : undefined,
      })
    }
  }
  throw new Error(`Unknown fn ${c.fn}`)
}

describe('JSCalendar conversion fixtures', () => {
  const file = path.join(__dirname, '../../../fixtures/conversion/jscalendar.json')
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: ConversionCase[] }
  for (const c of cases) {
    it(`${c.fn}: ${c.id}`, () => {
      let got: unknown
      try {
        got = run(c)
      } catch (e) {
        if (e instanceof TypeError) throw e
        got = { error: true }
      }
      expect(canonical(got)).toBe(canonical(c.expected))
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
