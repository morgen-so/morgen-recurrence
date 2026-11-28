// A small time zone model for the conversion tests: the real 2025 changes of
// two zones, as UTC instants (zones.test.ts checks them against Intl). The
// Dart tests have the same model in test/zones.dart.
import { TimeZones } from '../src/index'

const HOUR = 3_600_000

/** Per zone: the offset (hours) before the first change, then [UTC instant of a change, offset from then]. */
const ZONES: Record<string, { base: number; changes: [number, number][] }> = {
  'Europe/Zurich': { base: 1, changes: [[Date.UTC(2025, 2, 30, 1), 2], [Date.UTC(2025, 9, 26, 1), 1]] },
  'America/New_York': { base: -5, changes: [[Date.UTC(2025, 2, 9, 7), -4], [Date.UTC(2025, 10, 2, 6), -5]] },
  'Etc/UTC': { base: 0, changes: [] },
}
export const ZONE_NAMES = Object.keys(ZONES)

/** The offset of `zone` at a UTC instant, in milliseconds. */
export function offsetAt(zone: string, instant: number): number {
  const z = ZONES[zone]
  if (!z) throw new Error(`Unknown time zone ${zone}`)
  let offset = z.base
  for (const [from, o] of z.changes) if (instant >= from) offset = o
  return offset * HOUR
}

/**
 * RFC 5545 section 3.3.5: a wall clock that occurs twice is its first
 * instant; one that does not occur is read with the offset before the gap.
 */
export const zones: TimeZones = {
  fromInstant: (instant, zone) => new Date(instant.getTime() + offsetAt(zone, instant.getTime())),
  toInstant: (wall, zone) => {
    const z = ZONES[zone]
    if (!z) throw new Error(`Unknown time zone ${zone}`)
    const w = wall.getTime()
    const offsets = [...new Set([z.base, ...z.changes.map(([, o]) => o)])].map((o) => o * HOUR)
    const valid = offsets.map((o) => w - o).filter((i) => i + offsetAt(zone, i) === w)
    if (valid.length) return new Date(Math.min(...valid))
    return new Date(w - offsetAt(zone, w - 24 * HOUR))
  },
}

/** Whether the event zone's wall clock of `instant` names that instant (not the second of a repeated hour). */
export const representable = (instant: number, zone: string) =>
  zones.toInstant(zones.fromInstant(new Date(instant), zone), zone).getTime() === instant
