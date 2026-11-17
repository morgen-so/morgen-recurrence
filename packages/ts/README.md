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
- **More fixes, from the [review of 16 November 2026](../../docs/REVIEW-2026-11-16.md):**
  - week numbers at year boundaries;
  - the first week of WEEKLY + BYSETPOS rules;
  - `DTSTART;VALUE=DATE` and DTSTART parameters in any order;
  - years 0–99 and pre-1970 milliseconds;
  - `rrulestr` sets honour `options.dtstart`/`tzid`;
  - set callbacks run in chronological order;
  - caches are invalidated (set changes, mutated query dates, adapter
    changes);
  - clones keep their configuration;
  - weekday strings and UNTIL serialize correctly.
- **Validation.** `new RRule()` (and so `rrulestr`, `fromString`) throws for
  values outside RFC 5545's ranges, where rrule.js looped forever or silently
  changed the rule: negative or non-integer INTERVAL/COUNT, `BYHOUR=25`,
  `BYMONTHDAY=0`, `BYWEEKNO=54`, and so on. `RRule.parseString` still returns
  what it parsed, unchecked, as before. `COUNT=0`/`INTERVAL=0` remain empty
  rules. `BYSECOND=60` (a leap second) is accepted but never matches.
- **SKIP** (RFC 7529): `RSCALE=GREGORIAN;SKIP=FORWARD|BACKWARD` in RRULE
  strings, or the `skip` option (`'OMIT' | 'FORWARD' | 'BACKWARD'`). For
  example, a monthly rule on the 31st falls on February 29 with BACKWARD.
  rrule.js threw on these properties.
- **Bounded iteration.** Rules that never match return quickly instead of
  iterating to year 9999 or looping forever. `rule.maxPeriods` (default
  `DEFAULT_MAX_PERIODS = 200000`) is a safety net: iteration stops after that
  many *consecutive* periods without a candidate.
- **No built-in time zone conversion.** rrule.js converted TZID results with
  `Intl` (`dateInTimeZone`). Here a TZID other than UTC goes through the
  adapter installed with `setTimeZoneAdapter()`. Without one, results are the
  floating wall-clock times, which is also what `TZID=UTC` and TZID-less rules
  give in both libraries. With an adapter, UNTIL is compared as a UTC instant
  (RFC 5545), parsed RDATE/EXDATE values are converted according to their
  own form (UTC, own TZID, or floating), and cached results are discarded
  when the adapter changes.

  ```ts
  import moment from 'moment-timezone'
  import { setTimeZoneAdapter } from '@morgen-so/rrule'

  setTimeZoneAdapter({
    fromWallTime: (wall, tzid) => moment.tz(wall.toISOString().slice(0, 23), tzid).toDate(),
  })
  ```

- **Packaging.** ES2018 output: `dist/cjs` for `require` and Node, `dist/esm`
  through the `module` condition for bundlers. There is no UMD bundle.

## API compatibility

The common call shapes below are exercised against upstream rrule 2.8.0 in
[`test/api-compat.test.ts`](test/api-compat.test.ts):

- `rrulestr('DTSTART;TZID=UTC:…\nRRULE:…')`, then `.between(a, b, true)`, `.origOptions.until/.count`, assigning `.options.until`;
- `rrulestr('DTSTART:…\n…').after(date, false)`;
- `RRule.fromString(str)`, `.origOptions`, `.toString()`, `new RRule({...origOptions, freq})`;
- `RRule.parseString(body)`, `new RRule(options)`, `.after(d, false)`, `.all(callback)`;
- `RRule.parseText(text)`, `new RRule(options)`, `.toText()`, `.options.freq`;
- `RRule.YEARLY … SECONDLY`, `Frequency`, `Weekday` (`instanceof`), types `ByWeekday`, `Options`, `RRuleSet`.

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
