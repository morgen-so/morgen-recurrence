// Regression tests for the API-level findings of the correctness review of
// 2026-11-16 (R02, R07-R11, R13-R15). Engine-level findings are covered by
// the shared fixtures (fixtures/regressions.json, skip.json, historical.json,
// weekno.json).
import { RRule, RRuleSet, rrulestr } from '../src/index'
import { setTimeZoneAdapter, TimeZoneAdapter } from '../src/timezone'

const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 19))
const P = (s: string) => new Date(`${s}Z`)
// Fixed-offset fake zones: enough to test where the adapter is applied.
const utcPlus1: TimeZoneAdapter = { fromWallTime: (w) => new Date(w.getTime() - 3600000) }
const utcMinus5: TimeZoneAdapter = { fromWallTime: (w) => new Date(w.getTime() + 5 * 3600000) }

beforeEach(() => setTimeZoneAdapter(null))
afterAll(() => setTimeZoneAdapter(null))

describe('R02: DTSTART property parameters', () => {
  it('VALUE=DATE', () => {
    expect(iso(rrulestr('DTSTART;VALUE=DATE:20240101\nRRULE:FREQ=DAILY;COUNT=2').all())).toEqual([
      '2024-01-01T00:00:00',
      '2024-01-02T00:00:00',
    ])
  })
  it('VALUE=DATE-TIME and TZID in any order', () => {
    const a = rrulestr('DTSTART;VALUE=DATE-TIME;TZID=UTC:20240101T090000\nRRULE:FREQ=DAILY;COUNT=1')
    const b = rrulestr('DTSTART;TZID=UTC;VALUE=DATE-TIME:20240101T090000\nRRULE:FREQ=DAILY;COUNT=1')
    expect(iso(a.all())).toEqual(['2024-01-01T09:00:00'])
    expect(iso(b.all())).toEqual(['2024-01-01T09:00:00'])
    expect(a.options.tzid).toBe('UTC')
  })
  it('rejects an unparseable DTSTART instead of using "now"', () => {
    expect(() => rrulestr('DTSTART:2024-01-01\nRRULE:FREQ=DAILY;COUNT=1')).toThrow()
    expect(() => rrulestr('DTSTART;VALUE=DATE:20240101T090000\nRRULE:FREQ=DAILY')).toThrow()
  })
})

describe('R07: rrulestr options for sets', () => {
  it('options.dtstart is used when an EXDATE makes it a set', () => {
    const set = rrulestr('RRULE:FREQ=DAILY;COUNT=2\nEXDATE:20240102T090000Z', {
      dtstart: P('2024-01-01T09:00:00'),
    })
    expect(iso(set.all())).toEqual(['2024-01-01T09:00:00'])
  })
  it('forceset and compatible use options.dtstart too', () => {
    const opts = { dtstart: P('2024-01-01T09:00:00') }
    expect(iso(rrulestr('RRULE:FREQ=DAILY;COUNT=2', { ...opts, forceset: true }).all())).toEqual([
      '2024-01-01T09:00:00',
      '2024-01-02T09:00:00',
    ])
    expect(iso(rrulestr('RRULE:FREQ=DAILY;COUNT=2', { ...opts, compatible: true }).all())).toEqual([
      '2024-01-01T09:00:00',
      '2024-01-02T09:00:00',
    ])
  })
})

describe('R08: UNTIL is a UTC instant for zoned rules', () => {
  it('UTC+1: 09:00 Zurich on Jan 2 is 08:00Z, before UNTIL 08:30Z', () => {
    setTimeZoneAdapter(utcPlus1)
    const r = rrulestr('DTSTART;TZID=Europe/Zurich:20240101T090000\nRRULE:FREQ=DAILY;UNTIL=20240102T083000Z')
    expect(iso(r.all())).toEqual(['2024-01-01T08:00:00', '2024-01-02T08:00:00'])
  })
  it('UTC-5: 09:00 New York on Jan 2 is 14:00Z, after UNTIL 10:00Z', () => {
    setTimeZoneAdapter(utcMinus5)
    const r = rrulestr('DTSTART;TZID=America/New_York:20240101T090000\nRRULE:FREQ=DAILY;UNTIL=20240102T100000Z')
    expect(iso(r.all())).toEqual(['2024-01-01T14:00:00'])
  })
  it('floating and TZID=UTC rules are unchanged', () => {
    setTimeZoneAdapter(utcPlus1)
    const r = rrulestr('DTSTART;TZID=UTC:20240101T090000\nRRULE:FREQ=DAILY;UNTIL=20240102T090000Z')
    expect(iso(r.all())).toEqual(['2024-01-01T09:00:00', '2024-01-02T09:00:00'])
  })
})

describe('R09: RDATE/EXDATE values keep their own time domain', () => {
  const base = 'DTSTART;TZID=Europe/Zurich:20240101T090000\nRRULE:FREQ=DAILY;COUNT=2\n'
  beforeEach(() => setTimeZoneAdapter(utcPlus1))
  it('a UTC EXDATE removes the occurrence at that instant', () => {
    expect(iso(rrulestr(base + 'EXDATE:20240102T080000Z').all())).toEqual(['2024-01-01T08:00:00'])
  })
  it('a UTC RDATE is not converted again', () => {
    const r = rrulestr('DTSTART;TZID=Europe/Zurich:20240101T090000\nRRULE:FREQ=DAILY;COUNT=1\nRDATE:20240103T080000Z')
    expect(iso(r.all())).toEqual(['2024-01-01T08:00:00', '2024-01-03T08:00:00'])
  })
  it('a zoned EXDATE is converted with its own TZID', () => {
    expect(iso(rrulestr(base + 'EXDATE;TZID=Europe/Zurich:20240102T090000').all())).toEqual([
      '2024-01-01T08:00:00',
    ])
  })
  it('programmatic rdate() keeps meaning "wall time in the set\'s TZID"', () => {
    const set = new RRuleSet()
    set.tzid('Europe/Zurich')
    set.rdate(P('2024-01-01T09:00:00'))
    expect(iso(set.all())).toEqual(['2024-01-01T08:00:00'])
  })
})

describe('R10: caches', () => {
  it('set mutations invalidate cached results', () => {
    const set = new RRuleSet()
    set.rdate(P('2024-01-01T09:00:00'))
    expect(iso(set.all())).toEqual(['2024-01-01T09:00:00'])
    set.exdate(P('2024-01-01T09:00:00'))
    expect(set.all()).toEqual([])
    set.rrule(new RRule({ freq: RRule.DAILY, count: 1, dtstart: P('2024-02-01T09:00:00') }))
    expect(iso(set.all())).toEqual(['2024-02-01T09:00:00'])
  })
  it('mutating a query Date after the query does not corrupt the cache', () => {
    const r = new RRule({ freq: RRule.DAILY, dtstart: P('2024-01-01T09:00:00') })
    const before = P('2024-01-02T10:00:00')
    expect(r.between(P('2024-01-01T00:00:00'), before, true)).toHaveLength(2)
    before.setTime(P('2024-01-04T10:00:00').getTime())
    expect(r.between(P('2024-01-01T00:00:00'), before, true)).toHaveLength(4)
  })
  it('cached and uncached queries agree', () => {
    const opts = { freq: RRule.WEEKLY, count: 5, dtstart: P('2024-01-01T09:00:00') }
    const cached = new RRule(opts)
    const uncached = new RRule(opts, true)
    for (let i = 0; i < 2; i++) {
      expect(cached.all()).toEqual(uncached.all())
      expect(cached.after(P('2024-01-10T00:00:00'))).toEqual(uncached.after(P('2024-01-10T00:00:00')))
      expect(cached.before(P('2024-01-10T00:00:00'))).toEqual(uncached.before(P('2024-01-10T00:00:00')))
    }
  })
})

describe('R11: set callbacks see dates in chronological order', () => {
  const set = () => {
    const s = new RRuleSet()
    s.rrule(new RRule({ freq: RRule.DAILY, count: 3, dtstart: P('2024-01-02T09:00:00') }))
    s.rrule(new RRule({ freq: RRule.DAILY, count: 3, dtstart: P('2024-01-01T09:00:00') }))
    s.rdate(P('2023-12-31T09:00:00'))
    return s
  }
  it('all() with a limiting callback returns the earliest dates', () => {
    expect(iso(set().all((_, i) => i < 3))).toEqual([
      '2023-12-31T09:00:00',
      '2024-01-01T09:00:00',
      '2024-01-02T09:00:00',
    ])
  })
  it('the callback prefix equals the uncapped sorted set', () => {
    const full = iso(set().all())
    for (let n = 0; n <= full.length; n++) {
      expect(iso(set().all((_, i) => i < n))).toEqual(full.slice(0, n))
    }
  })
  it('between() with a limiting callback', () => {
    expect(iso(set().between(P('2024-01-01T00:00:00'), P('2024-12-31T00:00:00'), true, (_, i) => i < 2))).toEqual([
      '2024-01-01T09:00:00',
      '2024-01-02T09:00:00',
    ])
  })
  it('unbounded rules are not expanded eagerly', () => {
    const s = new RRuleSet()
    s.rrule(new RRule({ freq: RRule.SECONDLY, dtstart: P('2024-01-01T00:00:00') }))
    s.rrule(new RRule({ freq: RRule.DAILY, dtstart: P('2023-01-01T00:00:00') }))
    expect(iso(s.all((_, i) => i < 2))).toEqual(['2023-01-01T00:00:00', '2023-01-02T00:00:00'])
  })
})

describe('R13: clones keep their configuration', () => {
  it('RRule.clone keeps maxPeriods and cache enablement', () => {
    const r = new RRule({ freq: RRule.DAILY, dtstart: P('2024-01-01T09:00:00') }, true)
    r.maxPeriods = 7
    const c = r.clone()
    expect(c.maxPeriods).toBe(7)
    expect(c._cache).toBeNull()
  })
  it('RRuleSet.clone keeps TZID, DTSTART, maxPeriods and cache enablement', () => {
    setTimeZoneAdapter(utcPlus1)
    const s = new RRuleSet()
    s.tzid('Europe/Zurich')
    s.rdate(P('2024-01-01T09:00:00'))
    s.maxPeriods = 9
    const c = s.clone()
    expect(iso(c.all())).toEqual(iso(s.all()))
    expect(c.tzid()).toBe('Europe/Zurich')
    expect(c.maxPeriods).toBe(9)
    expect(!!c._cache).toBe(true)
    expect(new RRuleSet(true).clone()._cache).toBeNull()
  })
})

describe('R14: changing the adapter discards cached results', () => {
  it('a cached rule follows the adapter like a fresh one', () => {
    const text = 'DTSTART;TZID=Europe/Zurich:20240101T090000\nRRULE:FREQ=DAILY;COUNT=1'
    const r = rrulestr(text, { cache: true })
    expect(iso(r.all())).toEqual(['2024-01-01T09:00:00'])
    setTimeZoneAdapter(utcPlus1)
    expect(iso(r.all())).toEqual(iso(rrulestr(text).all()))
    expect(iso(r.all())).toEqual(['2024-01-01T08:00:00'])
  })
})

describe('R15: serialization round-trips', () => {
  it('weekday strings', () => {
    expect(RRule.optionsToString({ freq: RRule.WEEKLY, byweekday: ['MO', 'FR'] })).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=MO,FR'
    )
  })
  it('UNTIL is written in UTC for UTC and zoned rules', () => {
    for (const tzid of ['UTC', 'Europe/Zurich']) {
      const s = RRule.optionsToString({
        freq: RRule.DAILY,
        tzid,
        dtstart: P('2024-01-01T09:00:00'),
        until: P('2024-01-02T09:00:00'),
      })
      expect(s).toContain('UNTIL=20240102T090000Z')
    }
  })
  it('parse -> serialize -> parse is stable for every weekday representation', () => {
    for (const byweekday of [['MO', 'FR'], [0, 4], [RRule.MO, RRule.FR], [RRule.MO.nth(2), RRule.FR.nth(-1)]]) {
      const freq = RRule.MONTHLY
      const s1 = new RRule({ freq, byweekday: byweekday as never, count: 3, dtstart: P('2024-01-01T09:00:00') }).toString()
      const r2 = RRule.fromString(s1)
      expect(r2.toString()).toBe(s1)
    }
  })
  it('SKIP is written with RSCALE (RFC 7529)', () => {
    const r = new RRule({ freq: RRule.MONTHLY, skip: 'BACKWARD', dtstart: P('2024-01-31T09:00:00'), count: 2 })
    expect(r.toString()).toContain('SKIP=BACKWARD')
    expect(r.toString()).toContain('RSCALE=GREGORIAN')
    expect(iso(RRule.fromString(r.toString()).all())).toEqual(['2024-01-31T09:00:00', '2024-02-29T09:00:00'])
  })
})
