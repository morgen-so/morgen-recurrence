// Generated round trips of recurrence overrides and RDATE periods, compared
// as UTC instants (the Dart package runs the same properties in
// packages/dart/test/roundtrip_test.dart). The corpus round trips of rules
// are in conformance.test.ts.
import { ICalDateForm, recurrenceOverridesFromICal, recurrenceOverridesToICal } from '../src/index'
import { representable, ZONE_NAMES, zones } from './zones'

/** A small seeded generator (mulberry32), so a failure can be replayed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SEED = Number(process.env.ROUNDTRIP_SEED ?? 1)
const RUNS = 2000
const MINUTE = 60_000
const DAY = 86_400_000

const fmt = (d: Date) => d.toISOString().slice(0, 19)
const iso = (instant: number) => fmt(new Date(instant))
const ical = (d: Date) => fmt(d).replace(/[-:]/g, '')
const icalUtc = (instant: number) => `${ical(new Date(instant))}Z`
const wallOf = (instant: number, zone: string) => zones.fromInstant(new Date(instant), zone)
const instantOf = (wall: Date, zone: string) => zones.toInstant(wall, zone).getTime()
/** A value written as `20250105T090000`. */
const parseICal = (s: string) =>
  new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`)

/**
 * The end of a JSCalendar duration from a start instant in the event's zone
 * (RFC 8984 section 1.4.6): weeks and days on the wall clock, then exact time.
 */
function addDuration(start: number, duration: string, zone: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration)
  if (!m) throw new Error(`Unexpected duration ${duration}`)
  const n = (i: number) => Number(m[i] ?? 0)
  const days = n(1) * 7 + n(2)
  const wall = new Date(wallOf(start, zone).getTime() + days * DAY)
  return instantOf(wall, zone) + (n(3) * 3600 + n(4) * 60 + n(5)) * 1000
}

/** The instants of the EXDATE and RDATE values written for an event in `zone`. */
function written(properties: string[], zone: string) {
  const out = { exdates: [] as number[], rdates: [] as number[] }
  for (const line of properties) {
    const values = line.slice(line.indexOf(':') + 1).split(',').map((v) => instantOf(parseICal(v.split('/')[0]), zone))
    ;(line.startsWith('EXDATE') ? out.exdates : out.rdates).push(...values)
  }
  return out
}

describe('RDATE periods keep their start and end instants', () => {
  const next = random(SEED)
  const int = (n: number) => Math.floor(next() * n)
  for (let i = 0; i < RUNS; i++) {
    // Starts around the time changes of March and of October/November 2025,
    // on whole minutes; ends up to three days later.
    const from = next() < 0.5 ? Date.UTC(2025, 2, 7) : Date.UTC(2025, 9, 20)
    const start = from + int(25 * 24 * 60) * MINUTE
    const source = ZONE_NAMES[int(ZONE_NAMES.length)]
    const eventZone = ZONE_NAMES[int(ZONE_NAMES.length)]
    const utc = source === 'Etc/UTC'
    // The end: an explicit one, or a duration of days (added on the wall
    // clock of the source zone, RFC 5545 section 3.3.6) and exact time.
    const days = int(3)
    const exact = int(24 * 60) * 60
    const useDuration = next() < 0.5
    const sw = wallOf(start, source)
    const end = useDuration
      ? instantOf(new Date(sw.getTime() + days * DAY), source) + exact * 1000
      : start + int(3 * 24 * 60) * MINUTE
    const ew = wallOf(end, source)
    // A wall clock that does not name its instant cannot be written: leave it out.
    if (instantOf(sw, source) !== start || (!useDuration && instantOf(ew, source) !== end)) continue
    const value = utc ? icalUtc(start) : ical(sw)
    const endValue = useDuration
      ? `P${days ? `${days}D` : ''}T${Math.floor(exact / 3600)}H${(exact % 3600) / 60}M`
      : utc ? icalUtc(end) : ical(ew)
    const line = `RDATE${utc ? '' : `;TZID=${source}`};VALUE=PERIOD:${value}/${endValue}`
    it(`${i}: ${line} in ${eventZone}`, () => {
      const read = () => recurrenceOverridesFromICal([line], { timeZone: eventZone, zones, strict: true })
      if (!representable(start, eventZone)) {
        // The second of two equal local times has no recurrence id.
        expect(read).toThrow()
        return
      }
      const [[key, patch]] = Object.entries(read()) as [string, { duration: string }][]
      const s = instantOf(new Date(`${key}Z`), eventZone)
      expect(iso(s)).toBe(iso(start))
      expect(iso(addDuration(s, patch.duration, eventZone))).toBe(iso(end))
    })
  }
})

describe('EXDATE and RDATE sets keep their instants through a round trip', () => {
  const next = random(SEED + 2)
  const int = (n: number) => Math.floor(next() * n)
  for (let i = 0; i < RUNS / 2; i++) {
    // Values every 30 minutes from 23:00Z to 03:00Z around the hour Zurich
    // repeats (Oct 26, 2025: 00:00Z-00:59Z and 01:00Z-01:59Z are both
    // 02:00-02:59), for an event in Zurich, New York or UTC.
    const pick = () => {
      const out = new Set<number>()
      const n = int(5)
      for (let k = 0; k < n; k++) out.add(Date.UTC(2025, 9, 25, 23) + int(9) * 30 * MINUTE)
      return [...out].sort((a, b) => a - b)
    }
    const rdates = pick()
    const exdates = pick()
    const zone = ZONE_NAMES[int(ZONE_NAMES.length)]
    if (!rdates.length && !exdates.length) continue
    const lines = [
      ...(rdates.length ? [`RDATE:${rdates.map(icalUtc).join(',')}`] : []),
      ...(exdates.length ? [`EXDATE:${exdates.map(icalUtc).join(',')}`] : []),
    ]
    it(`${i}: ${lines.join(' ')} in ${zone}`, () => {
      // RFC 5545: the added instants are the RDATEs without the EXDATEs.
      const added = rdates.filter((r) => !exdates.includes(r))
      // What a recurrence id cannot name: an added instant, or an excluded
      // one that is not just the removal of an RDATE.
      const lost = [...added, ...exdates.filter((e) => !rdates.includes(e))].filter((x) => !representable(x, zone))
      const warnings: string[] = []
      const options = { timeZone: zone, zones }
      const overrides = recurrenceOverridesFromICal(lines, { ...options, onWarning: (m) => warnings.push(m) })
      expect(warnings.length > 0).toBe(lost.length > 0)
      if (lost.length) expect(() => recurrenceOverridesFromICal(lines, { ...options, strict: true })).toThrow()
      else expect(recurrenceOverridesFromICal(lines, { ...options, strict: true })).toEqual(overrides)

      // Written back for the event, the lines name these instants:
      const back = recurrenceOverridesToICal(overrides, { form: 'zoned', timeZone: zone, isOccurrence: () => false })
      const got = written(back.properties, zone)
      // every added instant that has a recurrence id, and no other (an
      // excluded occurrence never comes back);
      expect(got.rdates.map(iso)).toEqual(added.filter((r) => representable(r, zone)).map(iso))
      // every excluded instant that has one, and no other.
      expect(got.exdates.map(iso)).toEqual(exdates.filter((e) => representable(e, zone)).map(iso))
      // And reading those lines gives the same overrides again.
      expect(recurrenceOverridesFromICal(back.properties, { ...options, strict: true })).toEqual(overrides)
    })
  }
})

describe('recurrence overrides round trip', () => {
  const next = random(SEED + 1)
  const forms: ICalDateForm[] = ['local', 'utc', 'zoned', 'date']
  for (let i = 0; i < RUNS / 4; i++) {
    const form = forms[i % forms.length]
    const timeZone = form === 'zoned' ? 'Europe/Zurich' : form === 'utc' ? 'Etc/UTC' : undefined
    const overrides: Record<string, Record<string, unknown>> = {}
    const occurrences = new Set<string>()
    const n = 1 + Math.floor(next() * 6)
    for (let k = 0; k < n; k++) {
      const day = new Date(Date.UTC(2024, 0, 1 + Math.floor(next() * 60), form === 'date' ? 0 : 9))
      const key = fmt(day)
      const generated = next() < 0.5
      if (generated) occurrences.add(key)
      const kind = Math.floor(next() * 4)
      overrides[key] =
        kind === 0
          ? { excluded: true }
          : kind === 1
            ? {}
            : kind === 2 && form !== 'date'
              ? { duration: `PT${1 + Math.floor(next() * 30)}H` }
              : { title: 'Moved' }
    }
    it(`${i}: ${form} ${JSON.stringify(overrides)}`, () => {
      const options = { form, timeZone, isOccurrence: (id: Date) => occurrences.has(fmt(id)), strict: true }
      const first = recurrenceOverridesToICal(overrides, options)
      const back = recurrenceOverridesFromICal(first.properties, { timeZone, zones, strict: true })
      // What the lines hold comes back...
      for (const [key, patch] of Object.entries(overrides)) {
        const got = back[key] as Record<string, unknown> | undefined
        if (patch.excluded) expect(got).toEqual({ excluded: true })
        else if (patch.duration && !occurrences.has(key)) expect(got).toEqual({ duration: patch.duration })
        else if (!occurrences.has(key)) expect(got).toEqual({})
        // ...and the rest is listed for an override component.
        const inLines = patch.excluded || !occurrences.has(key)
        const rest = !patch.excluded && (occurrences.has(key) ? Object.keys(patch).length > 0 : !!patch.title)
        expect({ key, inLines: got !== undefined, rest: first.overrides.includes(key) }).toEqual({ key, inLines, rest })
      }
      // ...and writing it again gives the same lines.
      expect(recurrenceOverridesToICal(back as Record<string, unknown>, options).properties).toEqual(first.properties)
    })
  }
})

it('reads 50,000 RDATEs and EXDATEs in linear time', () => {
  const values = (from: number) => Array.from({ length: 25_000 }, (_, k) => icalUtc(from + k * 2 * 3_600_000)).join(',')
  const lines = [`RDATE:${values(Date.UTC(2000, 0, 1))}`, `EXDATE:${values(Date.UTC(2003, 0, 1))}`]
  const started = Date.now()
  const got = recurrenceOverridesFromICal(lines, { timeZone: 'Europe/Zurich', zones })
  // A quadratic scan takes minutes here; a linear one well under a second.
  expect(Date.now() - started).toBeLessThan(5000)
  expect(Object.keys(got).length).toBeGreaterThan(25_000)
})
