// The test time zone model against the real zone data (Intl).
import { offsetAt, zones } from './zones'

const wallOf = (instant: number, timeZone: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant)).map((x) => [x.type, x.value])
  )
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
}

it.each(['Europe/Zurich', 'America/New_York'])('%s matches Intl for every half hour of 2025', (zone) => {
  const wrong: string[] = []
  for (let i = Date.UTC(2025, 0, 1); i < Date.UTC(2026, 0, 1); i += 1_800_000) {
    if (i + offsetAt(zone, i) !== wallOf(i, zone)) wrong.push(new Date(i).toISOString())
  }
  expect(wrong).toEqual([])
})

it('reads repeated and skipped wall clocks as RFC 5545 says', () => {
  const at = (s: string) => zones.toInstant(new Date(`${s}Z`), 'Europe/Zurich').toISOString()
  expect(at('2025-10-26T02:30:00')).toBe('2025-10-26T00:30:00.000Z') // twice: the first
  expect(at('2025-03-30T02:30:00')).toBe('2025-03-30T01:30:00.000Z') // skipped: offset before
  expect(at('2025-07-01T12:00:00')).toBe('2025-07-01T10:00:00.000Z')
})
