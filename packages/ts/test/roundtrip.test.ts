// Generated round trips of recurrence overrides and RDATE periods (the Dart
// package runs the same properties in packages/dart/test/roundtrip_test.dart).
// The corpus round trips of rules are in conformance.test.ts.
import { ICalDateForm, recurrenceOverridesFromICal, recurrenceOverridesToICal } from '../src/index'

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

const fmt = (d: Date) => d.toISOString().slice(0, 19)
const HOUR = 3_600_000

/**
 * Zones with a time change in March 2025: the UTC instant of each change and
 * the offsets before and after it (hours).
 */
const ZONES: Record<string, { change: number; before: number; after: number }> = {
  'Europe/Zurich': { change: Date.UTC(2025, 2, 30, 1), before: 1, after: 2 },
  'America/New_York': { change: Date.UTC(2025, 2, 9, 7), before: -5, after: -4 },
  'Etc/UTC': { change: 0, before: 0, after: 0 },
}
const offset = (zone: string, instant: number) => {
  const z = ZONES[zone]
  return (instant < z.change ? z.before : z.after) * HOUR
}
/** The wall clock of an instant. */
const wall = (zone: string, instant: number) => new Date(instant + offset(zone, instant))
/** The instant of a wall clock (a skipped time is read with the offset before the change). */
const toInstant = (w: Date, zone: string) => {
  const z = ZONES[zone]
  const before = w.getTime() - z.before * HOUR
  return new Date(before < z.change ? before : w.getTime() - z.after * HOUR)
}
const toEventTime = (eventZone: string) => (w: Date, zone: string) => wall(eventZone, toInstant(w, zone).getTime())

/** Parses a duration of hours, minutes and seconds (what the converter writes). */
const seconds = (d: string) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d)
  if (!m) throw new Error(`Unexpected duration ${d}`)
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}
const icalUtc = (instant: number) => fmt(new Date(instant)).replace(/[-:]/g, '') + 'Z'
const icalLocal = (w: Date) => fmt(w).replace(/[-:]/g, '')

describe('RDATE periods keep their end instant', () => {
  const next = random(SEED)
  const zones = Object.keys(ZONES)
  for (let i = 0; i < RUNS; i++) {
    // Starts from Mar 7 to Apr 1, 2025, ends up to three days later, on whole minutes.
    const start = Date.UTC(2025, 2, 7) + Math.floor(next() * 25 * 24 * 60) * 60_000
    const end = start + Math.floor(next() * 3 * 24 * 60) * 60_000
    const source = zones[Math.floor(next() * zones.length)]
    const eventZone = zones[Math.floor(next() * 2)]
    const utc = source === 'Etc/UTC'
    const sw = wall(source, start)
    const ew = wall(source, end)
    // A wall clock in a skipped hour does not name the instant: leave it out.
    if (toInstant(sw, source).getTime() !== start || toInstant(ew, source).getTime() !== end) continue
    // Half the periods end with a duration of days (added to the wall clock
    // of the source zone, RFC 5545 section 3.3.6) and exact time.
    const days = Math.floor(next() * 3)
    const exact = Math.floor(next() * 24 * 60) * 60
    const useDuration = next() < 0.5
    const dayEnd = new Date(sw.getTime() + days * 86_400_000)
    const durationEnd = toInstant(dayEnd, source).getTime() + exact * 1000
    if (useDuration && wall(source, toInstant(dayEnd, source).getTime()).getTime() !== dayEnd.getTime()) continue
    const expectedEnd = useDuration ? durationEnd : end
    const value = utc ? icalUtc(start) : icalLocal(sw)
    const endValue = useDuration
      ? `P${days ? `${days}D` : ''}T${Math.floor(exact / 3600)}H${(exact % 3600) / 60}M`
      : utc ? icalUtc(end) : icalLocal(ew)
    const line = utc
      ? `RDATE;VALUE=PERIOD:${value}/${endValue}`
      : `RDATE;TZID=${source};VALUE=PERIOD:${value}/${endValue}`
    it(`${i}: ${line} in ${eventZone}`, () => {
      const got = recurrenceOverridesFromICal([line], { toEventTime: toEventTime(eventZone), toInstant, strict: true })
      const [[key, patch]] = Object.entries(got) as [string, { duration: string }][]
      const s = toInstant(new Date(`${key}Z`), eventZone).getTime()
      expect(fmt(new Date(s))).toBe(fmt(new Date(start)))
      expect(fmt(new Date(s + seconds(patch.duration) * 1000))).toBe(fmt(new Date(expectedEnd)))
    })
  }
})

describe('recurrence overrides round trip', () => {
  const next = random(SEED + 1)
  const forms: ICalDateForm[] = ['local', 'utc', 'zoned', 'date']
  for (let i = 0; i < RUNS / 4; i++) {
    const form = forms[i % forms.length]
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
      const options = {
        form,
        timeZone: form === 'zoned' ? 'Europe/Zurich' : undefined,
        isOccurrence: (id: Date) => occurrences.has(fmt(id)),
        strict: true,
      }
      const first = recurrenceOverridesToICal(overrides, options)
      const back = recurrenceOverridesFromICal(first.properties, { strict: true })
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

describe('EXDATE and RDATE in the repeated hour', () => {
  // Zurich on Oct 26, 2025: +02:00 until 01:00Z, then +01:00, so 00:00Z to
  // 00:59Z and 01:00Z to 01:59Z have the same local times, 02:00 to 02:59.
  const change = Date.UTC(2025, 9, 26, 1)
  const local = (instant: number) => fmt(new Date(instant + (instant < change ? 2 : 1) * HOUR))
  const zurich = (w: Date, zone: string) => {
    if (zone === 'Etc/UTC') return w
    const before = w.getTime() - 2 * HOUR
    return new Date(before < change ? before : w.getTime() - HOUR)
  }
  const toEventTime = (w: Date, zone: string) => new Date(`${local(zurich(w, zone).getTime())}Z`)
  const next = random(SEED + 2)
  for (let i = 0; i < RUNS / 4; i++) {
    // Values every 30 minutes from 23:00Z to 03:00Z.
    const pick = () => {
      const out = new Set<number>()
      const n = Math.floor(next() * 5)
      for (let k = 0; k < n; k++) out.add(Date.UTC(2025, 9, 25, 23) + Math.floor(next() * 9) * HOUR / 2)
      return [...out].sort()
    }
    const rdates = pick()
    const exdates = pick()
    if (!rdates.length && !exdates.length) continue
    const lines = [
      ...(rdates.length ? [`RDATE:${rdates.map(icalUtc).join(',')}`] : []),
      ...(exdates.length ? [`EXDATE:${exdates.map(icalUtc).join(',')}`] : []),
    ]
    it(`${i}: ${lines.join(' ')}`, () => {
      // An EXDATE removes the RDATE of its instant; what is left is kept.
      const kept = rdates.filter((r) => !exdates.includes(r))
      const expected: Record<string, unknown> = {}
      for (const e of exdates) expected[local(e)] = { excluded: true }
      for (const r of kept) expected[local(r)] = {}
      const collisions = new Set(kept.map(local)).size !== kept.length
      const warnings: string[] = []
      const got = recurrenceOverridesFromICal(lines, { toEventTime, toInstant: zurich, onWarning: (m) => warnings.push(m) })
      expect(got).toEqual(expected)
      expect(warnings.length > 0).toBe(collisions)
      if (collisions) expect(() => recurrenceOverridesFromICal(lines, { toEventTime, toInstant: zurich, strict: true })).toThrow()
    })
  }
})
