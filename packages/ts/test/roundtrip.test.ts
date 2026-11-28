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
    const line = utc
      ? `RDATE;VALUE=PERIOD:${icalUtc(start)}/${icalUtc(end)}`
      : `RDATE;TZID=${source};VALUE=PERIOD:${icalLocal(sw)}/${icalLocal(ew)}`
    it(`${i}: ${line} in ${eventZone}`, () => {
      const got = recurrenceOverridesFromICal([line], { toEventTime: toEventTime(eventZone), toInstant, strict: true })
      const [[key, patch]] = Object.entries(got) as [string, { duration: string }][]
      const s = toInstant(new Date(`${key}Z`), eventZone).getTime()
      expect(fmt(new Date(s))).toBe(fmt(new Date(start)))
      expect(fmt(new Date(s + seconds(patch.duration) * 1000))).toBe(fmt(new Date(end)))
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
