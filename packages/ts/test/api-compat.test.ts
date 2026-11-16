// Drop-in compatibility with rrule.js 2.8.0 for the calls made by Morgen's
// repos (minetime, omnia, morgen-backend, morgen-integration-service). Each
// test mirrors a call site and compares the fork with upstream rrule 2.8.0
// (devDependency) on ordinary rules, where none of the fixed bugs apply.
import * as fork from '../src/index'
import { setTimeZoneAdapter } from '../src/timezone'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const upstream = require('rrule') as typeof fork

const libs = { fork, upstream }
const iso = (d: Date | null) => (d ? d.toISOString() : null)
const isoAll = (ds: Date[]) => ds.map(iso)

beforeAll(() => setTimeZoneAdapter(null))

function same<T>(fn: (lib: typeof fork) => T) {
  expect(fn(libs.fork)).toEqual(fn(libs.upstream))
}

const RULES = [
  'FREQ=WEEKLY;BYDAY=MO,WE,FR',
  'FREQ=DAILY;INTERVAL=2;COUNT=20',
  'FREQ=MONTHLY;BYDAY=2TU',
  'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
  'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20250630T000000Z',
  'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=12',
]

describe('recurrenceExpand.ts (desktop, Kai, backend, sync service)', () => {
  // rrulestr with a DTSTART;TZID=UTC line, options.until mutated after
  // parsing, between(..., true), origOptions.until/count read back.
  it.each(RULES)('%s', (rule) => {
    same((lib) => {
      const set = lib.rrulestr(['DTSTART;TZID=UTC:20240115T093000', `RRULE:${rule}`].join('\n'))
      if (set.origOptions.until) {
        set.options.until = new Date(set.origOptions.until.getTime() + 2 * 86400000)
      }
      return {
        between: isoAll(set.between(new Date('2024-01-13T00:00:00Z'), new Date('2026-01-01T00:00:00Z'), true)),
        until: iso(set.origOptions.until ?? null),
        count: set.origOptions.count ?? null,
      }
    })
  })

  it('all-day DTSTART (date only)', () => {
    same((lib) =>
      isoAll(lib.rrulestr('DTSTART;TZID=UTC:20240115\nRRULE:FREQ=WEEKLY;COUNT=3').between(new Date(0), new Date('2030-01-01'), true))
    )
  })
})

describe('tasks: rrulestr(DTSTART + RRULE).after(date, false) (TaskObservable, backend morgen provider)', () => {
  it.each(RULES)('%s', (rule) => {
    same((lib) => iso(lib.rrulestr(`DTSTART:20240115\n${rule}`).after(new Date('2024-03-01T00:00:00Z'), false)))
  })
})

describe('RRule.fromString / toString (calendars.ts, scripts/recurrence)', () => {
  it.each(RULES)('%s', (rule) => {
    same((lib) => {
      const r = lib.RRule.fromString(`RRULE:${rule}`)
      return { str: r.toString(), orig: JSON.stringify(r.origOptions), freq: r.options.freq }
    })
  })

  it('origOptions keeps Weekday instances (isGenericWeekday uses instanceof)', () => {
    const r = fork.RRule.fromString('RRULE:FREQ=MONTHLY;BYDAY=+2MO,FR')
    const days = r.origOptions.byweekday as fork.Weekday[]
    expect(days.every((d) => d instanceof fork.Weekday)).toBe(true)
    expect(days.map((d) => d.n ?? null)).toEqual([2, null])
  })

  it('sanitizeRecurrence: new RRule({...origOptions, freq}).toString()', () => {
    same((lib) => {
      const r = lib.RRule.fromString('RRULE:FREQ=MONTHLY;BYDAY=MO,WE')
      return new lib.RRule({ ...r.origOptions, freq: lib.RRule.WEEKLY }).toString()
    })
  })

  it('expandRRuleToNextDates: rrulestr(dtStart + rule.toString()).between', () => {
    same((lib) => {
      const r = lib.RRule.fromString('FREQ=WEEKLY;BYDAY=TU')
      return isoAll(lib.rrulestr(`DTSTART:20240102T080000Z\n${r.toString()}`).between(new Date('2024-01-01'), new Date('2024-03-01'), true))
    })
  })
})

describe('RRule.parseString + new RRule + after/all (backend & Kai workflow schedules)', () => {
  it('parseRRule: parseString, defaulted BY* parts, after()', () => {
    same((lib) => {
      const options = lib.RRule.parseString('FREQ=DAILY;BYHOUR=8,12')
      options.dtstart = new Date('2024-05-01T07:13:00Z')
      if (options.freq <= lib.RRule.DAILY && options.byhour === undefined) options.byhour = [0]
      if (options.freq <= lib.RRule.HOURLY && options.byminute === undefined) options.byminute = [0]
      if (options.freq <= lib.RRule.MINUTELY && options.bysecond === undefined) options.bysecond = [0]
      const r = new lib.RRule(options)
      return [iso(r.after(new Date('2024-06-01T09:00:00Z'), false)), iso(r.after(new Date('2024-06-01T12:00:00Z'), false))]
    })
  })

  it('validateScheduleRRule: all(callback) with an early stop', () => {
    same((lib) => {
      const options = lib.RRule.parseString('FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0;BYSECOND=0')
      const out: Date[] = []
      new lib.RRule({ ...options, dtstart: new Date('2024-05-01T00:00:00Z') }).all((d) => {
        out.push(d)
        return out.length < 5
      })
      return isoAll(out)
    })
  })

  it('frequency constants and the Frequency enum', () => {
    for (const k of ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'] as const) {
      expect(fork.RRule[k]).toBe(upstream.RRule[k])
      expect(fork.Frequency[k]).toBe(upstream.Frequency[k])
    }
  })
})

describe('NLP: RRule.parseText / toText (inferEventProps, obsidian tasks plugin)', () => {
  it.each(['every week on monday', 'every 2 days', 'every month on the 3rd', 'every weekday'])('%s', (text) => {
    same((lib) => {
      const options = lib.RRule.parseText(text)
      const r = new lib.RRule({ ...options, dtstart: new Date('2024-01-01T10:00:00Z') })
      return { str: r.toString(), text: r.toText(), next: iso(r.after(new Date('2024-01-02T00:00:00Z'))) }
    })
  })
})

describe('time zones are pluggable', () => {
  afterEach(() => setTimeZoneAdapter(null))

  it('without an adapter, TZID rules yield floating wall-clock times', () => {
    const r = fork.rrulestr('DTSTART;TZID=Europe/Zurich:20240330T090000\nRRULE:FREQ=DAILY;COUNT=2')
    expect(isoAll(r.all())).toEqual(['2024-03-30T09:00:00.000Z', '2024-03-31T09:00:00.000Z'])
  })

  it('an adapter converts wall-clock times of non-UTC TZIDs', () => {
    const calls: string[] = []
    setTimeZoneAdapter({
      fromWallTime: (wall, tzid) => {
        calls.push(tzid)
        // Fake fixed-offset zone: wall time - 1h (enough to test the plumbing).
        return new Date(wall.getTime() - 3600000)
      },
    })
    const r = fork.rrulestr('DTSTART;TZID=Europe/Zurich:20240330T090000\nRRULE:FREQ=DAILY;COUNT=2')
    expect(isoAll(r.all())).toEqual(['2024-03-30T08:00:00.000Z', '2024-03-31T08:00:00.000Z'])
    expect(calls).toEqual(['Europe/Zurich', 'Europe/Zurich'])
  })

  it('UTC and floating rules never call the adapter', () => {
    setTimeZoneAdapter({ fromWallTime: () => { throw new Error('should not be called') } })
    expect(fork.rrulestr('DTSTART;TZID=UTC:20240101T090000\nRRULE:FREQ=DAILY;COUNT=2').all()).toHaveLength(2)
    expect(fork.rrulestr('DTSTART:20240101T090000Z\nRRULE:FREQ=DAILY;COUNT=2').all()).toHaveLength(2)
  })
})
