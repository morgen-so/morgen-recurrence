# morgen-recurrence

RFC 5545 recurrence rule (RRULE) expansion for Morgen, in two small idiomatic
implementations that must produce **identical** results:

| package | language | used by | origin |
|---|---|---|---|
| [`packages/ts`](packages/ts) — `@morgen-so/rrule` | TypeScript | desktop (`minetime`), Kai (`omnia`), `morgen-backend`, `morgen-integration-service` | fork of [rrule.js](https://github.com/jkbrzt/rrule) 2.8.0, drop-in API |
| [`packages/dart`](packages/dart) — `morgen_rrule` | Dart | mobile app | port of the rrule.js core, previously in `lib/services/LocalEventStore/rrule` |

Both run one shared conformance corpus, [`fixtures/`](fixtures), in CI, plus a
differential fuzz job on fresh random rules. Neither package contains time
zone data: rules are expanded on floating (wall-clock) times, and the
TypeScript package takes TZID conversions from an injected adapter (see
[Time zones](#time-zones)).

## What changes compared with rrule.js 2.8.0

All are fixed identically in both packages and pinned by
[`fixtures/regressions.json`](fixtures/regressions.json):

1. **Mixed plain and nth BYDAY** in MONTHLY/YEARLY rules (`BYDAY=2WE,SA`) produced
   no occurrences (rrule.js intersected the two sets). Now a day matches if it
   matches either, as RFC 5545 says.
2. **BYSETPOS**: a negative position beyond the size of the set returned the
   first element of the set, and equal results were emitted twice.
   `MONTHLY;BYDAY=MO;BYSETPOS=-1,-6,5;COUNT=4` from 2024-01-01 gave Jan 1, Jan 29,
   Jan 29, Feb 5. Now it gives Jan 29, Feb 26, Mar 25, Apr 29.
3. **Unsorted BYHOUR/BYMINUTE/BYSECOND** (`DAILY;BYHOUR=18,9`) emitted times out of
   order, which also made UNTIL/COUNT cut the series at the wrong place. Values
   are now sorted and de-duplicated.
4. **Runaway iteration**: rules that never match iterated to year 9999 (seconds
   per call; for example `DAILY;BYDAY=SA,MO;BYSETPOS=2`), and some sub-daily rules
   looped forever (`HOURLY;INTERVAL=6;BYHOUR=3` from 00:00). Iteration now stops:
   - past the query's upper bound or UNTIL;
   - when the BYSETPOS positions cannot exist;
   - when a sub-daily BYHOUR/BYMINUTE/BYSECOND is unreachable;
   - after 200,000 consecutive periods without any candidate (`maxPeriods`).

   Productive rules are not capped.
5. **MINUTELY/SECONDLY with BYHOUR/BYMINUTE**: the counter now advances like
   python-dateutil. rrule.js misaligned the INTERVAL grid when carrying into the
   next minute or hour (it gave 09:10:03 instead of 09:10:04), skipped days, or
   looped. This was found while verifying the corpus. Calendar events
   practically never use these frequencies.

Performance work, with identical results (see the [benchmarks](#performance)):

- iteration on epoch milliseconds instead of `Date` objects;
- a compact, reused day set instead of a fresh year-long array per period;
- year masks cached per year (rrule.js rebuilt them every period);
- precomputed lookup tables for the BY* filters;
- numeric bounds in `IterResult`.

## Layout

```
fixtures/               shared conformance corpus (JSON, one case per line)
packages/ts/            @morgen-so/rrule: src/, test/ (rrule.js suite + conformance + API compat), bench/
packages/dart/          morgen_rrule: lib/, test/ (focused tests + conformance), bench/
tools/gen-fixtures.mjs  regenerates fixtures/ from the TypeScript package
tools/verify.mjs        checks every fixture against python-dateutil and a brute-force RFC evaluator
tools/fuzz.mjs          fresh random rules for TS-vs-Dart differential runs
tools/impact.mjs        which rules behave differently from an upstream rrule.js version
docs/IMPACT.md          what changes for real events after switching, and how to count them
docs/PERFORMANCE.md     benchmarks and where the time went
.github/workflows/ci.yml
```

## Running the tests

```bash
cd packages/ts && npm ci && npm run build && npm test
```

```bash
cd packages/dart && dart pub get && dart test
```

Current status: both packages pass all **6,588** corpus cases (Dart also runs
the 6,300 cases that carry a JSCalendar rule through `fromJsCalendar`). The TS
package also passes rrule.js's own 381 unit tests and 35 API compatibility
checks against upstream. Local differential fuzzing matched on 100,000 fresh
random rules.

## The fixture corpus

| file | cases | content |
|---|---|---|
| `regressions.json` | 17 | one or more per fixed bug, expected values verified by hand |
| `rfc5545.json` | 42 | the examples of RFC 5545 §3.8.5.3; the dates printed in the RFC are asserted |
| `rrulejs-suite.json` | 229 | rrule.js's own `testRecurring` cases (without TZID, BYEASTER, RRuleSet) |
| `random.json` | 4,000 | random DAILY to YEARLY rules biased to edge cases (month ends, leap days, nth weekdays, BYSETPOS, WKST) |
| `weekno.json` | 1,500 | BYWEEKNO/BYYEARDAY with every WKST |
| `subdaily.json` | 800 | HOURLY/MINUTELY/SECONDLY, including unreachable BYHOUR/BYMINUTE |

Format of a case (see [`fixtures/README.md`](fixtures/README.md)):

```json
{"id":"regression-0003","bug":"bysetpos","dtstart":"2024-01-01T09:00:00",
 "rrule":"FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1,-6,5;COUNT=4",
 "query":{"method":"all"},
 "expected":["2024-01-29T09:00:00","2024-02-26T09:00:00","2024-03-25T09:00:00","2024-04-29T09:00:00"]}
```

### Regenerating

```bash
(cd packages/ts && npm run build)
node tools/gen-fixtures.mjs
```

Expected values come from the TypeScript package. The generator fails if any
hand-verified expectation does not hold (regressions, RFC dates, rrule.js's own
expected values). CI fails if the committed corpus differs from a fresh
generation. To add a case, append it to `tools/lib/handwritten.mjs` (with
`expected` checked by hand) or change a generator in `tools/lib/random.mjs`.

### Independent verification

```bash
pip install python-dateutil==4.0.0
python -I tools/verify/dateutil_eval.py /tmp/du.json fixtures/*.json   # ~6 min: dateutil spins on never-matching rules
node tools/verify.mjs /tmp/du.json fixtures/*.json
```

Current result, with no unexplained differences:

| outcome | cases |
|---|---|
| identical to python-dateutil 4.0.0 | 6,336 |
| mixed-BYDAY cases where dateutil intersects like rrule.js; all match the brute-force RFC evaluator | 98 |
| rules dateutil rejects as empty ("byxxx generates an empty set"); fixture is empty | 86 |
| rules where dateutil spins without finding anything; fixture is empty | 66 |

The brute-force evaluator also agrees on all 530 cases in its scope
(MONTHLY/YEARLY with BYDAY, including BYSETPOS).

### Differential fuzzing

```bash
node tools/fuzz.mjs /tmp/fuzz.json 12345 50000
(cd packages/dart && FIXTURES=/tmp/fuzz.json dart test test/conformance_test.dart)
```

## Time zones

Neither library contains time zone data or calls `Intl`. Rules are expanded
on floating times: `Date`/`DateTime` values whose UTC fields hold the wall
clock. That is how every Morgen caller already uses rrule.js: it passes
`DTSTART;TZID=UTC:…` and converts with moment-timezone or morgen-tz-service.

The TypeScript package keeps rrule.js's TZID syntax. When a rule or set has a
TZID other than UTC, it asks an injected adapter to convert. Without an
adapter, the wall-clock time is returned as it is:

```ts
import moment from 'moment-timezone'
import { setTimeZoneAdapter } from '@morgen-so/rrule'

setTimeZoneAdapter({
  fromWallTime: (wall, tzid) => moment.tz(wall.toISOString().slice(0, 23), tzid).toDate(),
})
```

The Dart package has no TZID at all; callers convert the floating results.

## Performance

Median of several rounds on an Apple Silicon Mac: Node 22 for TS, Dart 3.13
AOT (as in the app) for Dart. Full table and analysis:
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

| workload | rrule.js 2.8.0 | @morgen-so/rrule | morgen_rrule (Dart) |
|---|---:|---:|---:|
| weekly MO,WE,FR, 6 years: 1,000 expansions | 1,045 ms | 155 ms (6.7×) | 165 ms |
| daily, 6 years: 1,000 expansions | 3,963 ms | 314 ms (13×) | 365 ms |
| monthly 2nd Tuesday, 6 years: 1,000 expansions | 235 ms | 25 ms (9.4×) | 58 ms |
| 3,722 random corpus rules, 1-year window | 12,931 ms | 79 ms (165×) | 71 ms |
| `DAILY;BYDAY=SA,MO;BYSETPOS=2`, 2 years | ~4 s | < 1 ms | < 1 ms |
| `HOURLY;INTERVAL=6;BYHOUR=3` from 00:00 | never returns | < 1 ms | < 1 ms |

## How each repository switches

The TypeScript package is API-compatible with rrule.js for every call our
repos make. These are listed in [packages/ts/README.md](packages/ts/README.md#api-used-by-morgen)
and exercised by `packages/ts/test/api-compat.test.ts`.

- **minetime, omnia, morgen-backend**: change only `package.json`. Keep every
  `import … from 'rrule'` with an npm alias:
  `"rrule": "npm:@morgen-so/rrule@2.8.0-morgen.1"`. Alternatively, depend on
  `@morgen-so/rrule` and replace the 7 / 7 / 3 imports. Run the existing
  `recurrenceExpand.spec.ts` suites.
- **morgen-integration-service** (rrule.js 2.6.4 today): the same alias. Between
  2.6.4 and 2.8.0 the expansion core did not change; the Luxon dependency was
  dropped and `daysBetween` no longer applies the local UTC offset. The service
  imports named exports only, so 2.7's removal of the default export does not
  affect it. `isRecurrenceExpansionSafe` can stay, but it is no longer needed
  to avoid hangs.
- **mobile**: add the dependency
  `morgen_rrule: {git: {url: …/morgen-recurrence.git, path: packages/dart, ref: <tag>}}`.
  Change the imports of `lib/services/LocalEventStore/rrule/rrule.dart` to
  `package:morgen_rrule/morgen_rrule.dart`, then delete the local copy and its
  three `test/rrule_*` files (now covered here). The API is the same, plus
  `RRuleOptions.parse`, `after` and `before`.

Publishing (`@morgen-so/rrule` to npm or GitHub Packages, a git tag for the
Dart package) and creating the GitHub repository have not been done yet.

## Licence

BSD 3-Clause, inherited from rrule.js (Copyright 2010 Jakub Roztocil and Lars
Schöning) and python-dateutil. See `packages/*/LICENCE`.
