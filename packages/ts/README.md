# @morgen-so/rrule

Morgen's fork of [rrule.js](https://github.com/jkbrzt/rrule) 2.8.0. It is a
drop-in replacement with the same exports, options and query methods. It adds
bug fixes, bounded iteration, faster expansion and pluggable time zones. The
Dart package in this repository passes the same conformance corpus.

```ts
import { RRule, rrulestr } from '@morgen-so/rrule'

const rule = rrulestr('DTSTART;TZID=UTC:20240101T090000\nRRULE:FREQ=MONTHLY;BYDAY=2WE,SA')
rule.between(new Date('2024-01-01'), new Date('2024-03-01'), true)
```

All of rrule.js's documentation applies, with the differences below. Bugs 1–5
are described in the [repository README](../../README.md#what-changes-compared-with-rrulejs-280).

## Differences from rrule.js 2.8.0

- **Fixed expansion bugs:**
  - mixed plain and nth BYDAY;
  - BYSETPOS out of range and duplicates;
  - unsorted BYHOUR/BYMINUTE/BYSECOND;
  - sub-daily counters.

  As a result, `rule.options.byhour`, `byminute` and `bysecond` are sorted and
  de-duplicated.
- **Bounded iteration.** Rules that never match return quickly instead of
  iterating to year 9999 or looping forever. `rule.maxPeriods` (default
  `DEFAULT_MAX_PERIODS = 200000`) is a safety net: iteration stops after that
  many *consecutive* periods without a candidate.
- **No built-in time zone conversion.** rrule.js converted TZID results with
  `Intl` (`dateInTimeZone`). Here a TZID other than UTC goes through the
  adapter installed with `setTimeZoneAdapter()`. Without one, results are the
  floating wall-clock times, which is also what `TZID=UTC` and TZID-less rules
  give in both libraries.

  ```ts
  import moment from 'moment-timezone'
  import { setTimeZoneAdapter } from '@morgen-so/rrule'

  setTimeZoneAdapter({
    fromWallTime: (wall, tzid) => moment.tz(wall.toISOString().slice(0, 23), tzid).toDate(),
  })
  ```

- **Packaging.** ES2018 output: `dist/cjs` for `require` and Node, `dist/esm`
  through the `module` condition for bundlers. There is no UMD bundle.

## API used by Morgen

Every call shape below is exercised against upstream rrule 2.8.0 in
[`test/api-compat.test.ts`](test/api-compat.test.ts):

| call | where |
|---|---|
| `rrulestr('DTSTART;TZID=UTC:…\nRRULE:…')`, then `.between(a, b, true)`, `.origOptions.until/.count`, assigning `.options.until` | `recurrenceExpand.ts` in minetime, omnia, morgen-backend, morgen-integration-service |
| `rrulestr('DTSTART:…\n…').after(date, false)` | `TaskObservable.ts` (minetime, omnia), `integrations/providers/morgen/utils.ts` (backend) |
| `RRule.fromString(str)`, `.origOptions`, `.toString()`, `new RRule({...origOptions, freq})` | `utils/calendars/calendars.ts`, `scripts/recurrence/utils.ts` (minetime, omnia) |
| `RRule.parseString(body)`, `new RRule(options)`, `.after(d, false)`, `.all(callback)` | `agenticWorkflows/rrule.ts` (backend), `validateScheduleRRule.ts` (omnia) |
| `RRule.parseText(text)`, `new RRule(options)`, `.toText()`, `.options.freq` | `CmdMenu/utils/inferEventProps.tsx`, `obsidian/tasksPlugin/Recurrence.ts` (minetime, omnia) |
| `RRule.YEARLY … SECONDLY`, `Frequency`, `Weekday` (`instanceof`), types `ByWeekday`, `Options` | throughout |
| `RRuleSet` | imported in `TaskObservable.ts` |

The rest of the rrule.js API is unchanged and covered by rrule.js's own
tests in `test/`: `RRuleSet` with `rdate`/`exdate`/`exrule`, `before`, `count`,
`clone`, `toText`/`fromText`, caching and `noCache`.

## Development

```bash
npm ci
npm run build       # dist/esm + dist/cjs
npm test            # rrule.js suite + conformance fixtures + API compatibility
npm run bench       # vs upstream rrule 2.8.0
```

BSD 3-Clause; see [LICENCE](LICENCE).
