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
  TimeZones,
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

const fmt = (d: Date) => d.toISOString().slice(0, 19)

/**
 * `offsets` of a case: per zone a fixed offset (`+02:00`), or the offset
 * before the first change and then [UTC instant of a change, offset from then].
 */
type Offsets = Record<string, string | [string, ...[string, string][]]>
const ms = (o: string) => (o.startsWith('-') ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6))) * 60_000
function zonesOf(offsets: Offsets): TimeZones {
  const changes = (zone: string): [number, number][] => {
    const z = offsets[zone]
    if (!z) throw new Error(`No offset for ${zone}`)
    if (typeof z === 'string') return [[-Infinity, ms(z)]]
    const [base, ...rest] = z
    return [[-Infinity, ms(base)], ...rest.map(([at, o]): [number, number] => [Date.parse(at), ms(o)])]
  }
  const offsetAt = (zone: string, instant: number) => changes(zone).filter(([from]) => instant >= from).pop()![1]
  return {
    fromInstant: (instant, zone) => new Date(instant.getTime() + offsetAt(zone, instant.getTime())),
    // RFC 5545 section 3.3.5: the first of two instants; in a gap, the offset before it.
    toInstant: (wall, zone) => {
      const w = wall.getTime()
      const valid = changes(zone).map(([, o]) => w - o).filter((i) => i + offsetAt(zone, i) === w)
      return new Date(valid.length ? Math.min(...valid) : w - offsetAt(zone, w - 86_400_000))
    },
  }
}
function run(c: ConversionCase, warnings: string[]): unknown {
  const o = c.options ?? {}
  const strict = o.strict === true
  const onWarning = (m: string) => warnings.push(m)
  const timeZone = o.eventTimeZone as string | undefined
  const zones = o.offsets ? zonesOf(o.offsets as Offsets) : undefined
  const start = o.start ? new Date(`${o.start}Z`) : undefined
  switch (c.fn) {
    case 'rruleToJsCalendar':
      return rruleToJsCalendar(c.input as string, {
        timeZone,
        zones,
        keepRRuleMeaning: o.keepRRuleMeaning === true,
        strict,
        onWarning,
      })
    case 'jsCalendarToRRule':
      return jsCalendarToRRule(c.input as JSCalendarRecurrenceRule, {
        untilForm: o.untilForm as ICalDateForm,
        timeZone,
        zones,
        start,
        keepJsCalendarMeaning: o.keepJsCalendarMeaning === true,
        strict,
        onWarning,
      })
    case 'recurrenceOverridesFromICal':
      return recurrenceOverridesFromICal(c.input as string[], { timeZone, zones, strict, onWarning })
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
        timeZone,
        zones,
        keepRRuleMeaning: o.keepRRuleMeaning === true,
        strict,
        onWarning,
      })
    case 'recurrenceToICal':
      return recurrenceToICal(c.input as Parameters<typeof recurrenceToICal>[0], {
        form: o.form as ICalDateForm,
        timeZone: (o.timeZone as string) ?? timeZone,
        zones,
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
