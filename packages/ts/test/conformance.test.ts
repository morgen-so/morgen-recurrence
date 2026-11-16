// Runs the shared conformance corpus (../../fixtures/*.json, or the files /
// directories listed in $FIXTURES, comma-separated). The Dart package runs
// the same corpus in packages/dart/test/conformance_test.dart.
import * as fs from 'fs'
import * as path from 'path'
import { RRule } from '../src/index'
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
}

const fmt = (d: Date) => {
  const s = d.toISOString()
  return s.endsWith('.000Z') ? s.slice(0, 19) : s.slice(0, 23)
}
const parse = (s: string) => new Date(`${s}Z`)

function evaluate(c: Case): Case['expected'] {
  try {
    const opts = RRule.parseString(c.rrule)
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
  for (const file of fixtureFiles()) {
    it(path.basename(file), () => {
      const { cases } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: Case[] }
      const failures: string[] = []
      for (const c of cases) {
        const got = evaluate(c)
        if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
          failures.push(`${c.id} DTSTART=${c.dtstart} ${c.rrule}\n  expected ${JSON.stringify(c.expected)}\n  got      ${JSON.stringify(got)}`)
        }
      }
      total += cases.length
      // eslint-disable-next-line no-console
      console.log(`${path.basename(file)}: ${cases.length - failures.length}/${cases.length} pass (running total ${total})`)
      expect(failures.slice(0, 10)).toEqual([])
    })
  }
})
