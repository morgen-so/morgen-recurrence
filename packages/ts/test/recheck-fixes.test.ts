// Regression tests for the API-level findings of the recheck of the review
// fixes (2026-11-16): F02-F05. F01 and F06 (SKIP) are engine-level and are
// covered by hand-checked cases in fixtures/regressions.json and by
// fixtures/skip-overlap.json, run by both packages and the oracle.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { RRule, RRuleSet, rrulestr } from '../src/index'
import { setTimeZoneAdapter, TimeZoneAdapter } from '../src/timezone'

const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 19))
const isoOne = (d: Date | null) => (d ? d.toISOString().slice(0, 19) : null)
const P = (s: string) => new Date(`${s}Z`)
const H = 3600000
// Fixed-offset fake zones (no DST involved): Zurich is UTC+1 in January,
// New York UTC-5.
const zones: TimeZoneAdapter = {
  fromWallTime: (w, tzid) =>
    new Date(
      w.getTime() + (tzid === 'Europe/Zurich' ? -H : tzid === 'America/New_York' ? 5 * H : 0)
    ),
}

beforeEach(() => setTimeZoneAdapter(zones))
afterAll(() => setTimeZoneAdapter(null))

/** Every query of a set, as plain values. */
function queries(set: RRule) {
  return {
    all: iso(set.all()),
    after: isoOne(set.after(P('2024-01-01T00:00:00'))),
    before: isoOne(set.before(P('2024-01-03T00:00:00'))),
    between: iso(set.between(P('2024-01-01T00:00:00'), P('2024-01-03T00:00:00'), true)),
  }
}

describe('F02: serialization keeps each value in its time domain', () => {
  const excluded =
    'DTSTART;TZID=Europe/Zurich:20240101T090000\nRRULE:FREQ=DAILY;COUNT=2\nEXDATE:20240102T080000Z'

  it('a UTC EXDATE in a zoned set still excludes after a round trip', () => {
    const set = rrulestr(excluded)
    expect(iso(set.all())).toEqual(['2024-01-01T08:00:00'])
    expect(set.toString()).toContain('EXDATE:20240102T080000Z')
    expect(iso(rrulestr(set.toString()).all())).toEqual(['2024-01-01T08:00:00'])
  })

  it('RDATE mixtures: UTC, the set TZID, another TZID, floating', () => {
    const s = [
      'DTSTART;TZID=Europe/Zurich:20240101T090000',
      'RRULE:FREQ=DAILY;COUNT=1',
      'RDATE:20240102T090000Z',
      'RDATE;TZID=Europe/Zurich:20240102T100000',
      'RDATE;TZID=America/New_York:20240102T050000',
      'RDATE:20240102T120000',
      'EXDATE;TZID=America/New_York:20240101T030000',
    ].join('\n')
    const set = rrulestr(s)
    // 08:00Z rule date is excluded by New York 03:00 (= 08:00Z). Floating
    // 12:00 follows the set's zone (11:00Z).
    const expected = ['2024-01-02T09:00:00', '2024-01-02T10:00:00', '2024-01-02T11:00:00']
    expect(iso(set.all())).toEqual(expected)
    const text = set.toString()
    expect(text).toContain('RDATE:20240102T090000Z')
    expect(text).toContain('RDATE;TZID=America/New_York:20240102T050000')
    expect(text).toContain('EXDATE;TZID=America/New_York:20240101T030000')
    expect(iso(rrulestr(text).all())).toEqual(expected)
    expect(iso(rrulestr(set.clone().toString()).all())).toEqual(expected)
  })

  it('the round trip keeps the domains when the adapter changes before expansion', () => {
    const text = rrulestr(excluded).toString()
    const other: TimeZoneAdapter = { fromWallTime: (w) => new Date(w.getTime() - 2 * H) }
    setTimeZoneAdapter(other)
    // Zurich now UTC+2: rule dates 07:00Z; the UTC exclusion (08:00Z) no
    // longer matches January 2, in the original text or after the trip.
    const expected = iso(rrulestr(excluded).all())
    expect(expected).toEqual(['2024-01-01T07:00:00', '2024-01-02T07:00:00'])
    expect(iso(rrulestr(text).all())).toEqual(expected)
  })

  it('programmatic values follow the set TZID, as in rrule.js', () => {
    const set = new RRuleSet()
    set.tzid('Europe/Zurich')
    set.rdate(P('2024-01-02T09:00:00'))
    expect(set.toString()).toBe('RDATE;TZID=Europe/Zurich:20240102T090000')
    expect(iso(set.all())).toEqual(['2024-01-02T08:00:00'])
  })
})

describe('F03: RDATE instants are ordered before query bounds apply', () => {
  // 09:00Z and Zurich 09:30 (08:30Z): raw order differs from instant order.
  const mixed = 'RDATE:20240101T090000Z\nRDATE;TZID=Europe/Zurich:20240101T093000'
  const reversed = 'RDATE;TZID=Europe/Zurich:20240101T093000\nRDATE:20240101T090000Z'

  for (const [name, text] of [['input order', mixed], ['reversed', reversed]]) {
    for (const cache of [true, false]) {
      it(`every query on a fresh set (${name}, cache ${cache})`, () => {
        const fresh = () => rrulestr(text, { cache })
        expect(iso(fresh().all())).toEqual(['2024-01-01T08:30:00', '2024-01-01T09:00:00'])
        expect(isoOne(fresh().after(P('2024-01-01T00:00:00')))).toBe('2024-01-01T08:30:00')
        expect(isoOne(fresh().before(P('2024-01-01T09:00:00')))).toBe('2024-01-01T08:30:00')
        expect(iso(fresh().between(P('2024-01-01T08:00:00'), P('2024-01-01T08:45:00'), true))).toEqual([
          '2024-01-01T08:30:00',
        ])
      })
    }
  }

  it('two explicit TZIDs and an RRULE', () => {
    const text = [
      'DTSTART:20240101T060000Z',
      'RRULE:FREQ=HOURLY;INTERVAL=4;COUNT=3', // 06:00, 10:00, 14:00Z
      'RDATE;TZID=America/New_York:20240101T030000', // 08:00Z
      'RDATE;TZID=Europe/Zurich:20240101T080000', // 07:00Z
    ].join('\n')
    expect(queries(rrulestr(text))).toEqual({
      all: ['2024-01-01T06:00:00', '2024-01-01T07:00:00', '2024-01-01T08:00:00', '2024-01-01T10:00:00', '2024-01-01T14:00:00'],
      after: '2024-01-01T06:00:00',
      before: '2024-01-01T14:00:00',
      between: ['2024-01-01T06:00:00', '2024-01-01T07:00:00', '2024-01-01T08:00:00', '2024-01-01T10:00:00', '2024-01-01T14:00:00'],
    })
    expect(isoOne(rrulestr(text).after(P('2024-01-01T06:00:00')))).toBe('2024-01-01T07:00:00')
    expect(isoOne(rrulestr(text).before(P('2024-01-01T08:00:00')))).toBe('2024-01-01T07:00:00')
  })
})

describe('F04: values with equal raw fields in different domains stay distinct', () => {
  it('RDATE, both insertion orders', () => {
    const a = 'RDATE:20240101T090000Z\nRDATE;TZID=Europe/Zurich:20240101T090000'
    const b = 'RDATE;TZID=Europe/Zurich:20240101T090000\nRDATE:20240101T090000Z'
    for (const text of [a, b]) {
      const set = rrulestr(text) as RRuleSet
      expect(iso(set.all())).toEqual(['2024-01-01T08:00:00', '2024-01-01T09:00:00'])
      expect(set.rdates()).toHaveLength(2)
      expect(iso(set.clone().all())).toEqual(['2024-01-01T08:00:00', '2024-01-01T09:00:00'])
      expect(iso(rrulestr(set.toString()).all())).toEqual(['2024-01-01T08:00:00', '2024-01-01T09:00:00'])
    }
  })

  it('EXDATE: both exclusions apply', () => {
    const text =
      'DTSTART:20240101T080000Z\nRRULE:FREQ=HOURLY;COUNT=2\nEXDATE:20240101T090000Z\nEXDATE;TZID=Europe/Zurich:20240101T090000'
    expect(rrulestr(text).all()).toEqual([])
    expect(rrulestr(rrulestr(text).toString()).all()).toEqual([])
  })

  it('different TZIDs with the same raw fields', () => {
    const set = rrulestr('RDATE;TZID=Europe/Zurich:20240101T090000\nRDATE;TZID=America/New_York:20240101T090000')
    expect(iso(set.all())).toEqual(['2024-01-01T08:00:00', '2024-01-01T14:00:00'])
  })

  it('exact duplicates in one domain are kept once', () => {
    const set = rrulestr('RDATE:20240101T090000Z,20240101T090000Z\nRDATE:20240101T090000Z') as RRuleSet
    expect(set.rdates()).toHaveLength(1)
    expect(iso(set.all())).toEqual(['2024-01-01T09:00:00'])
  })

  it('values one adapter maps to the same instant are emitted once, and kept apart for another', () => {
    const set = rrulestr('RDATE:20240101T090000Z\nRDATE;TZID=Europe/Zurich:20240101T090000')
    setTimeZoneAdapter(null) // Zurich 09:00 is now taken as 09:00Z
    expect(iso(set.all())).toEqual(['2024-01-01T09:00:00'])
    setTimeZoneAdapter(zones)
    expect(iso(set.all())).toEqual(['2024-01-01T08:00:00', '2024-01-01T09:00:00'])
  })
})

describe('F05: callback expansion is bounded by demand', () => {
  const dist = path.join(__dirname, '..', 'dist', 'cjs')

  // A year-old RDATE before a SECONDLY rule: time windows that double over
  // the empty year reach the dense rule with a window of months.
  function runCapped(body: string) {
    if (!fs.existsSync(dist)) throw new Error('run `npm run build` first (dist/cjs is used)')
    const code = `const {RRule,RRuleSet}=require(${JSON.stringify(dist)});const s=new RRuleSet();${body}`
    const r = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', code], {
      timeout: 6000,
      encoding: 'utf8',
    })
    return r.status === 0 ? JSON.parse(r.stdout) : { status: r.status, signal: r.signal, stderr: r.stderr.slice(0, 200) }
  }
  const dense = "s.rdate(new Date('2023-01-01T00:00:00Z'));s.rrule(new RRule({freq:RRule.SECONDLY,dtstart:new Date('2024-01-01T00:00:00Z')}));"

  it('all() with a callback stopping after two dates', () => {
    expect(runCapped(`${dense}console.log(JSON.stringify(s.all((d,i)=>i<2)))`)).toEqual([
      '2023-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
    ])
  })

  it('between() with a callback stopping after two dates', () => {
    expect(
      runCapped(
        `${dense}console.log(JSON.stringify(s.between(new Date('2022-06-01T00:00:00Z'),new Date('2030-01-01T00:00:00Z'),true,(d,i)=>i<2)))`
      )
    ).toEqual(['2023-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'])
  })

  it('a callback rejecting the first date gets nothing', () => {
    const set = new RRuleSet()
    set.rdate(P('2023-01-01T00:00:00'))
    set.rrule(new RRule({ freq: RRule.SECONDLY, dtstart: P('2024-01-01T00:00:00') }))
    expect(set.all(() => false)).toEqual([])
  })

  it('mixed sparse and dense rules, exclusions and duplicates, in order', () => {
    const set = new RRuleSet()
    set.rrule(new RRule({ freq: RRule.MINUTELY, interval: 20, dtstart: P('2024-01-01T00:00:00') }))
    set.rrule(new RRule({ freq: RRule.HOURLY, dtstart: P('2024-01-01T00:00:00'), count: 3 }))
    set.rrule(new RRule({ freq: RRule.YEARLY, dtstart: P('2023-06-01T00:00:00') }))
    set.rdate(P('2024-01-01T00:30:00'))
    set.exdate(P('2024-01-01T00:20:00'))
    set.exrule(new RRule({ freq: RRule.HOURLY, dtstart: P('2024-01-01T01:00:00'), count: 1 }))
    const got = iso(set.all((_, i) => i < 7))
    expect(got).toEqual([
      '2023-06-01T00:00:00',
      '2024-01-01T00:00:00', // minutely and hourly: once
      '2024-01-01T00:30:00', // 00:20 excluded
      '2024-01-01T00:40:00',
      // 01:00 excluded by the EXRULE
      '2024-01-01T01:20:00',
      '2024-01-01T01:40:00',
      '2024-01-01T02:00:00',
    ])
  })

  it('agrees with the non-callback queries on bounded sets', () => {
    const set = rrulestr(
      [
        'DTSTART;TZID=Europe/Zurich:20240101T090000',
        'RRULE:FREQ=DAILY;COUNT=40',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,SA;COUNT=12',
        'EXRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=3',
        'RDATE:20240103T120000Z',
        'RDATE;TZID=America/New_York:20231231T200000',
        'EXDATE:20240105T080000Z',
      ].join('\n'),
      { forceset: true }
    ) as RRuleSet
    expect(iso(set.all(() => true))).toEqual(iso(set.all()))
    const a = P('2024-01-04T00:00:00')
    const b = P('2024-01-20T08:00:00')
    for (const inc of [true, false]) {
      expect(iso(set.between(a, b, inc, () => true))).toEqual(iso(set.between(a, b, inc)))
    }
  })
})

describe('F07: an RDATE TZID does not become the TZID of a UTC DTSTART', () => {
  it('DTSTART with Z keeps its rule in UTC', () => {
    const set = rrulestr('DTSTART:20240101T060000Z\nRRULE:FREQ=DAILY;COUNT=1\nRDATE;TZID=America/New_York:20240101T030000')
    expect(iso(set.all())).toEqual(['2024-01-01T06:00:00', '2024-01-01T08:00:00'])
  })
  it('without DTSTART, the RDATE TZID is still the set TZID (rrule.js)', () => {
    const set = rrulestr('RDATE;TZID=America/New_York:20240101T030000') as RRuleSet
    expect(set.tzid()).toBe('America/New_York')
  })
})
