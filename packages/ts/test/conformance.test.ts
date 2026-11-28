// Runs the shared conformance corpus (../../fixtures/*.json, or the files /
// directories listed in $FIXTURES, comma-separated). The Dart package runs
// the same corpus in packages/dart/test/conformance_test.dart.
import * as fs from 'fs'
import * as path from 'path'
import {
  jsCalendarToRRule,
  JSCalendarRecurrenceRule,
  recurrenceFromICal,
  recurrenceToICal,
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

/**
 * Whether the RRULE has rule parts RFC 5545 section 3.3.10 does not allow
 * with its FREQ (rrule.js reads them, as JSCalendar does): strict
 * jsCalendarToRRule throws on such a rule, lenient warns.
 */
function notInRfc5545(rrule: string): boolean {
  const f = /FREQ=(\w+)/.exec(rrule)?.[1] ?? ''
  const has = (part: string) => new RegExp(`(^|;)${part}=`).test(rrule)
  const nth = /(^|;)BYDAY=[^;]*\d/.test(rrule)
  return (
    (has('BYMONTHDAY') && f === 'WEEKLY') ||
    (has('BYYEARDAY') && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(f)) ||
    (has('BYWEEKNO') && f !== 'YEARLY') ||
    (nth && !['MONTHLY', 'YEARLY'].includes(f)) ||
    (nth && f === 'YEARLY' && has('BYWEEKNO'))
  )
}

/**
 * The yearly SKIP rules whose keepRRuleMeaning conversion (with its warning)
 * gives other dates than rrule.js: a month day above 28 moved by SKIP. The
 * other corpus rules with that warning must keep their dates.
 */
const KNOWN_CHANGED_BY_SKIP = new Set<string>([
  'skip-overlap-0415',
  'skip-overlap-0517',
  'skip-overlap-0584',
  'skip-overlap-0623',
  'skip-overlap-0753',
])

/** The list is of the committed corpus: other fixtures ($FIXTURES, e.g. fuzzing) only need the warning. */
const EXACT_SKIP_LIST = !process.env.FIXTURES

const tryJs = (rrule: string) => {
  try {
    return rruleToJsCalendar(rrule, { strict: true })
  } catch {
    return null
  }
}

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
  let warnedButKept = 0
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
        // Export options: strict for rules RFC 5545 allows, else lenient
        // (warning that a calendar may reject the rule).
        const invalid = notInRfc5545(c.rrule)
        const exportWarnings: string[] = []
        const warned = (m: string) => exportWarnings.push(m)
        const out = { strict: !invalid, onWarning: warned }

        // JSCalendar conversion, checked by the occurrences (as the Dart
        // conformance test). INTERVAL=0 has no JSCalendar form, and COUNT
        // with UNTIL is not a valid RecurrenceRule.
        const start = parse(c.dtstart)
        if (/INTERVAL=0(;|$)/.test(c.rrule) || (/COUNT=/.test(c.rrule) && /UNTIL=/.test(c.rrule))) {
          expect(() => rruleToJsCalendar(c.rrule, { strict: true })).toThrow()
        } else {
          check(
            'rrule->jscal->rrule',
            evaluate(c, () => jsCalendarToRRule(rruleToJsCalendar(c.rrule, { strict: true }), { strict: !invalid, onWarning: warned }))
          )
          // Strict export throws exactly on the rules RFC 5545 does not allow.
          const js = tryJs(c.rrule)
          if (js) {
            let threw = false
            try {
              jsCalendarToRRule(js, { strict: true })
            } catch {
              threw = true
            }
            if (threw !== invalid) failures.push(`${c.id} (strict export throws: ${threw}) ${c.rrule}`)
          }
        }
        if (tryJs(c.rrule)) {
          // keepRRuleMeaning, evaluated as JSCalendar (keepJsCalendarMeaning):
          // the same dates, or a warning that they may differ.
          const warnings: string[] = []
          const kept = rruleToJsCalendar(c.rrule, { keepRRuleMeaning: true, strict: true, onWarning: (m) => warnings.push(m) })
          const keptDates = evaluate(c, () => jsCalendarToRRule(kept, { start, keepJsCalendarMeaning: true, ...out }))
          if (warnings.length) {
            // A warning allows other dates only for the known rules, and
            // those must still differ (so the list stays exact).
            withoutForm++
            const same = JSON.stringify(keptDates) === JSON.stringify(c.expected)
            if (same) warnedButKept++
            if (EXACT_SKIP_LIST && same === KNOWN_CHANGED_BY_SKIP.has(c.id)) {
              failures.push(`${c.id} (keepRRuleMeaning with a warning, same dates: ${same}) ${c.rrule}\n  ${warnings.join('; ')}`)
            }
          } else check('rrule->jscal keepRRuleMeaning', keptDates)

          // Round trips are stable: RRULE -> JSCalendar -> RRULE -> JSCalendar
          // gives the same rule and RRULE, and so does a whole series
          // (recurrenceToICal -> recurrenceFromICal -> recurrenceToICal, with
          // the start), so a sync loop never changes an event.
          const js1 = rruleToJsCalendar(c.rrule, { strict: true })
          const s1 = jsCalendarToRRule(js1, out)
          const js2 = rruleToJsCalendar(s1, { strict: true })
          const s2 = jsCalendarToRRule(js2, out)
          if (s1 !== s2 || normalJs(js1) !== normalJs(js2)) {
            failures.push(`${c.id} (rrule round trip) ${c.rrule}\n  ${s1} ${normalJs(js1)}\n  ${s2} ${normalJs(js2)}`)
          }
          const series = (r: Parameters<typeof recurrenceToICal>[0]) =>
            recurrenceToICal(r, { start, keepJsCalendarMeaning: true, isOccurrence: () => true, ...out }).properties
          const p1 = series({ recurrenceRules: [kept] })
          const p2 = series(recurrenceFromICal(p1, { strict: true }))
          if (JSON.stringify(p1) !== JSON.stringify(p2)) {
            failures.push(`${c.id} (series round trip) ${c.rrule}\n  ${JSON.stringify(p1)}\n  ${JSON.stringify(p2)}`)
          }
        }
        // Lenient (the default) gives the strict result wherever strict
        // succeeds, and never throws.
        const strictJs = tryJs(c.rrule)
        let lenientJs: unknown
        try {
          lenientJs = rruleToJsCalendar(c.rrule)
        } catch (e) {
          lenientJs = { threw: String(e) }
        }
        if ((strictJs && JSON.stringify(lenientJs) !== JSON.stringify(strictJs)) ||
            (lenientJs && typeof lenientJs === 'object' && 'threw' in lenientJs)) {
          failures.push(`${c.id} (rrule->jscal lenient) ${c.rrule}\n  strict  ${JSON.stringify(strictJs)}\n  lenient ${JSON.stringify(lenientJs)}`)
        }
        if (c.jscal) {
          jscal++
          const expectedJs = c.jscalExpected !== undefined ? c.jscalExpected : c.expected
          check(
            'jscal->rrule keepJsCalendarMeaning',
            evaluate(c, () => jsCalendarToRRule(c.jscal, { start, keepJsCalendarMeaning: true, ...out })),
            expectedJs
          )
          const back = normalJs(rruleToJsCalendar(jsCalendarToRRule(c.jscal, out), { strict: true }))
          if (jsCalendarToRRule(c.jscal) !== jsCalendarToRRule(c.jscal, out)) {
            failures.push(`${c.id} (jscal->rrule lenient) ${JSON.stringify(c.jscal)}`)
          }
          if (back !== normalJs(c.jscal)) failures.push(`${c.id} (jscal->rrule->jscal) ${JSON.stringify(c.jscal)}\n  got ${back}`)
        }
        // The RFC 5545 warning comes only for those rules.
        if (!invalid && exportWarnings.some((m) => m.startsWith('RFC 5545 does not allow'))) {
          failures.push(`${c.id} (RFC 5545 warning for a valid rule) ${c.rrule}`)
        }
      }
      total += cases.length
      // eslint-disable-next-line no-console
      console.log(`${path.basename(file)}: ${failures.length} failures in ${cases.length} cases (running total ${total}, ${jscal} jscal, ${withoutForm} keepRRuleMeaning warnings, ${warnedButKept} of them with the rrule.js dates anyway)`)
      expect(failures.slice(0, 10)).toEqual([])
    })
  }
})
