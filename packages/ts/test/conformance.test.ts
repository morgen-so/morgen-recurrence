// Runs the shared conformance corpus (../../fixtures/*.json, or the files /
// directories listed in $FIXTURES, comma-separated). The Dart package runs
// the same corpus in packages/dart/test/conformance_test.dart.
import * as fs from 'fs'
import * as path from 'path'
import {
  jsCalendarToRRule,
  JSCalendarRecurrenceRule,
  RRule,
  rruleToJsCalendar,
} from '../src/index'
import { setTimeZoneAdapter } from '../src/timezone'

interface Query {
  method: 'all' | 'between' | 'before' | 'after'
  after?: string
  before?: string
  dt?: string
  inc?: boolean
  limit?: number
}
interface Case {
  id: string
  dtstart: string
  rrule: string
  query: Query
  expected: string[] | string | null | { error: true }
  jscal?: JSCalendarRecurrenceRule
  jscalExpected?: Case['expected']
}

const fmt = (d: Date) => {
  const s = d.toISOString()
  return s.endsWith('.000Z') ? s.slice(0, 19) : s.slice(0, 23)
}
const parse = (s: string) => new Date(`${s}Z`)

function evaluate(c: Case, rrule: () => string = () => c.rrule): Case['expected'] {
  try {
    const opts = RRule.parseString(rrule())
    opts.dtstart = parse(c.dtstart)
    const rule = new RRule(opts)
    const q = c.query
    const limit = q.limit ?? Infinity
    const cb = (_: Date, n: number) => n < limit
    switch (q.method) {
      case 'all':
        return rule.all(cb).map(fmt)
      case 'between':
        return rule.between(parse(q.after), parse(q.before), !!q.inc, cb).map(fmt)
      case 'before':
      case 'after': {
        const d = rule[q.method](parse(q.dt), !!q.inc)
        return d ? fmt(d) : null
      }
    }
  } catch (e) {
    return { error: true }
  }
}

/** A RecurrenceRule without `@type`s and defaults, for comparing. */
function normalJs(rule: JSCalendarRecurrenceRule): string {
  const r: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rule)) {
    if (k === '@type' || (k === 'interval' && v === 1) || (k === 'rscale' && v === 'gregorian')) continue
    r[k] = k === 'byDay' ? (v as object[]).map(({ '@type': _, ...d }: Record<string, unknown>) => d) : v
  }
  return JSON.stringify(Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]])))
}

const tryJs = (rrule: string) => {
  try {
    return rruleToJsCalendar(rrule)
  } catch {
    return null
  }
}

/** Yearly BYMONTHDAY with an nth BYDAY and no BYMONTH: no meaning-keeping JSCalendar form. */
const unkeepable = (js: JSCalendarRecurrenceRule | null) =>
  !!js &&
  js.frequency === 'yearly' &&
  !!js.byMonthDay &&
  !js.byMonth &&
  !js.byWeekNo &&
  !js.byYearDay &&
  (js.byDay ?? []).some((d) => d.nthOfPeriod != null)

function fixtureFiles(): string[] {
  const spec = process.env.FIXTURES || path.join(__dirname, '../../../fixtures')
  return spec.split(',').flatMap((p) =>
    fs.statSync(p).isDirectory()
      ? fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(p, f))
      : [p]
  )
}

describe('conformance fixtures', () => {
  beforeAll(() => setTimeZoneAdapter(null))

  let total = 0
  let jscal = 0
  let withoutForm = 0
  for (const file of fixtureFiles()) {
    it(path.basename(file), () => {
      const { cases } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: Case[] }
      const failures: string[] = []
      for (const c of cases) {
        const check = (name: string, got: Case['expected'], expected = c.expected) => {
          if (JSON.stringify(got) !== JSON.stringify(expected)) {
            failures.push(`${c.id} (${name}) DTSTART=${c.dtstart} ${c.rrule}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(got)}`)
          }
        }
        check('rrule', evaluate(c))

        // JSCalendar conversion, checked by the occurrences (as the Dart
        // conformance test). INTERVAL=0 has no JSCalendar form.
        const start = parse(c.dtstart)
        if (/INTERVAL=0(;|$)/.test(c.rrule)) {
          expect(() => rruleToJsCalendar(c.rrule)).toThrow()
        } else {
          check('rrule->jscal->rrule', evaluate(c, () => jsCalendarToRRule(rruleToJsCalendar(c.rrule))))
          // keepRRuleMeaning, evaluated as JSCalendar (keepJsCalendarMeaning).
          if (unkeepable(tryJs(c.rrule))) withoutForm++
          else {
            check(
              'rrule->jscal keepRRuleMeaning',
              evaluate(c, () =>
                jsCalendarToRRule(rruleToJsCalendar(c.rrule, { keepRRuleMeaning: true }), {
                  start,
                  keepJsCalendarMeaning: true,
                })
              )
            )
          }
        }
        if (c.jscal) {
          jscal++
          const expectedJs = c.jscalExpected !== undefined ? c.jscalExpected : c.expected
          check(
            'jscal->rrule keepJsCalendarMeaning',
            evaluate(c, () => jsCalendarToRRule(c.jscal, { start, keepJsCalendarMeaning: true })),
            expectedJs
          )
          const back = normalJs(rruleToJsCalendar(jsCalendarToRRule(c.jscal)))
          if (back !== normalJs(c.jscal)) failures.push(`${c.id} (jscal->rrule->jscal) ${JSON.stringify(c.jscal)}\n  got ${back}`)
        }
      }
      total += cases.length
      // eslint-disable-next-line no-console
      console.log(`${path.basename(file)}: ${failures.length} failures in ${cases.length} cases (running total ${total}, ${jscal} jscal, ${withoutForm} without a meaning-keeping JSCalendar form)`)
      expect(failures.slice(0, 10)).toEqual([])
    })
  }
})
