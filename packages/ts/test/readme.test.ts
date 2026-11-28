// The README's caller-side code ("What the caller adapts" and "Replacing the
// ical.ts converters") is the code of examples/caller-adapters.ts, which
// `npm run typecheck` compiles.
import * as fs from 'fs'
import * as path from 'path'
import { recurrenceLines, ruleForWrite, warnings } from '../examples/caller-adapters'

it('the README adapters are the compiled examples', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../../../README.md'), 'utf8')
  const section = readme.slice(readme.indexOf('### What the caller adapts'), readme.indexOf('## Performance'))
  const blocks = [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1])
  expect(blocks.length).toBeGreaterThanOrEqual(4)
  const example = fs.readFileSync(path.join(__dirname, '../examples/caller-adapters.ts'), 'utf8')
  const lines = new Set(example.split('\n').map((l) => l.trim()))
  const missing = blocks.flatMap((b) => b.split('\n').map((l) => l.trim()).filter((l) => l && !lines.has(l)))
  expect(missing).toEqual([])
})

it('the writer recipe takes an event with overrides and no rules', () => {
  const r = recurrenceLines(undefined, { '2024-01-05T09:00:00': {} }, false, undefined)
  expect(r).toEqual({ properties: ['RDATE:20240105T090000'], overrides: [] })
  expect(recurrenceLines(null, null, false, undefined)).toEqual({ properties: [], overrides: [] })
  // A backend or integration-service rule has no `interval`.
  const weekly = { frequency: 'weekly' as const, byDay: [{ day: 'mo' }] }
  expect(recurrenceLines([weekly], null, true, null).properties).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO'])
})

it('a rule the integration service rejects is not written', () => {
  // A stand-in for the service's validator: nthOfPeriod in 1..4 or -1.
  const validate = (rule: { byDay?: { nthOfPeriod?: number }[] }) => {
    if (rule.byDay?.some((d) => d.nthOfPeriod !== undefined && ![1, 2, 3, 4, -1].includes(d.nthOfPeriod))) {
      throw new Error('byDay[i].nthOfPeriod must be an integer in [1, 2, 3, 4, -1]')
    }
  }
  warnings.length = 0
  const fifth = { frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: 5 }] } as const
  expect(ruleForWrite({ ...fifth, byDay: [...fifth.byDay] }, validate)).toBeNull()
  expect(warnings).toEqual(['Rule not written: byDay[i].nthOfPeriod must be an integer in [1, 2, 3, 4, -1]'])
  expect(ruleForWrite({ frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: -1 }] }, validate)).not.toBeNull()
})
