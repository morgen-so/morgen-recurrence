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

Unless marked otherwise, each is fixed identically in both packages and pinned
by [`fixtures/regressions.json`](fixtures/regressions.json):

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

These came out of the [correctness review of 16 November 2026](docs/REVIEW-2026-11-16.md):

6. **Invalid values are rejected** (RFC 5545 ranges). rrule.js looped forever
   on `INTERVAL=-1` or `INTERVAL=wat`, treated `COUNT=-1` as unbounded, rolled
   `BYHOUR=25` into the next day, and dropped `BYMONTHDAY=0`. Such rules now
   throw. `COUNT=0`/`INTERVAL=0` remain empty rules, and `BYSECOND=60` (a leap
   second) never matches.
7. **Week numbers at year boundaries** (BYWEEKNO, also wrong in python-dateutil):
   January 1–2, 2022 are in week 52 of 2021, and December 30, 2024 is in week
   1 = week −52 of 2025.
8. **WEEKLY + BYSETPOS**: the first week is the whole week containing DTSTART,
   so positions count the same as in every other week. rrule.js counted from
   DTSTART.
9. **SKIP** (RFC 7529 `RSCALE=GREGORIAN;SKIP=FORWARD|BACKWARD`, JSCalendar
   `skip`): February 31 can become March 1 or February 29 instead of being
   dropped. A date moved into the next month is ordered among that month's
   own dates, and its nth BYDAY is checked within the month it lands in.
10. **TS only**:
    - `DTSTART;VALUE=DATE` and DTSTART parameters in any order (rrule.js fell
      back to "now");
    - years 0–99 and milliseconds before 1970;
    - `rrulestr` sets honour `options.dtstart`/`tzid`;
    - set callbacks see dates in chronological order; rules are expanded in
      batches of at most 65,536 dates and EXRULEs seek to each candidate, so
      memory does not grow with how far or how densely a rule runs (CPU
      still does, as for any query);
    - caches are invalidated by set changes, by mutated query dates and by
      adapter changes;
    - clones keep their configuration;
    - weekday strings and UNTIL serialize correctly.

    With a time-zone adapter: UNTIL is compared as a UTC instant, and each
    RDATE/EXDATE value keeps its own time domain (UTC, its own TZID, or the
    set's) when it is converted, ordered, de-duplicated and serialized. An
    RDATE's TZID no longer becomes the zone of a UTC DTSTART.
11. **Dart only**:
    - `iterate(before:)` never yields past its bound;
    - `fromJsCalendar` adds RFC 8984's implicit properties (a yearly rule with
      `byMonthDay` means the start month only, as desktop already does through
      `ensureValidYearlyRecurrence`).

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
tools/verify.mjs        checks every fixture against an independent RFC oracle (and python-dateutil)
tools/verify/oracle.mjs brute-force RRULE evaluator written from the RFCs, sharing no code with the packages
tools/fuzz.mjs          fresh random rules for TS-vs-Dart differential runs
tools/impact.mjs        which rules behave differently from an upstream rrule.js version
docs/IMPACT.md          what changes for real events after switching, and how to count them
docs/PERFORMANCE.md     benchmarks and where the time went
docs/REVIEW-2026-11-16.md  response to the correctness review: verdicts, fixes, tests
.github/workflows/ci.yml
```

## Running the tests

```bash
cd packages/ts && npm ci && npm run build && npm test
```

```bash
cd packages/dart && dart pub get && dart test
```

Current status:

- Both packages pass all **9,425** corpus cases. Dart also runs the 9,107
  cases that carry a JSCalendar rule through `fromJsCalendar`, with their
  RFC 8984 expectations.
- The TS package also passes rrule.js's own unit tests, the API compatibility
  checks against upstream, and the review regression tests: 483 tests in
  total.
- Differential fuzzing (seed 16112030, 50,000 fresh rules): TS and Dart
  agree on all of them, and the independent oracle agrees on all 44,475 in
  its scope.

## The fixture corpus

| file | cases | content |
|---|---|---|
| `regressions.json` | 47 | one or more per fixed bug, expected values verified by hand |
| `rfc5545.json` | 42 | the examples of RFC 5545 §3.8.5.3; the dates printed in the RFC are asserted |
| `rrulejs-suite.json` | 229 | rrule.js's own `testRecurring` cases (without TZID, BYEASTER, RRuleSet) |
| `random.json` | 4,000 | random DAILY to YEARLY rules biased to edge cases (month ends, leap days, nth weekdays, BYSETPOS, WKST) |
| `weekno.json` | 1,500 | BYWEEKNO/BYYEARDAY with every WKST |
| `subdaily.json` | 800 | HOURLY/MINUTELY/SECONDLY, including unreachable BYHOUR/BYMINUTE |
| `skip.json` | 1,200 | MONTHLY/YEARLY with SKIP=FORWARD/BACKWARD (RFC 7529 / JSCalendar `skip`) |
| `skip-overlap.json` | 1,000 | SKIP with several hours, BYSETPOS and nth BYDAY: moved dates inside the next period, all four queries |
| `historical.json` | 600 | DTSTART before 1970 (with milliseconds) and in years 1–999 |
| `jscalendar.json` | 7 | JSCalendar rules whose meaning differs from the plain RRULE mapping (RFC 8984), verified by hand |

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

Expected values come from the TypeScript package, so they are checked
against implementations that share none of its code:

```bash
node tools/verify.mjs fixtures/*.json   # the RFC oracle alone: seconds, no dependencies
pip install python-dateutil==4.0.0
python -I tools/verify/dateutil_eval.py /tmp/du.json fixtures/*.json   # ~6 min: dateutil spins on never-matching rules
node tools/verify.mjs --dateutil /tmp/du.json fixtures/*.json
```

**Primary check: `tools/verify/oracle.mjs`.** A brute-force evaluator written
from RFC 5545 (plus RFC 7529/8984 for SKIP). It walks every day of every
period and applies each BY* part as a plain predicate, then BYSETPOS. It
collects the candidates of all periods, sorts them, and only then applies
DTSTART, UNTIL, COUNT and the query. It uses its own calendar arithmetic, with week 1
defined as the week containing January 4. It covers DAILY to YEARLY rules
with every BY* part, BYSETPOS, SKIP and invalid values. Result: **8,421 of
8,421** in-scope corpus cases agree.

**Secondary check: python-dateutil 4.0.0,** for the 1,004 sub-daily and
leap-second cases outside the oracle's scope. Known differences are reported
separately:
- dateutil rejects rules whose BY* parts can never match (fixture: empty);
- it spins on never-matching rules (fixture: empty);
- it drops DTSTART milliseconds.

It also disagrees with the oracle where the oracle confirmed this package:
mixed BYDAY, week numbers, weekly BYSETPOS and SKIP. Those are bugs or gaps
in dateutil.

CI runs the oracle on the corpus and on every fresh fuzz batch, and the
dateutil check on every push.

### Differential fuzzing

```bash
node tools/fuzz.mjs /tmp/fuzz.json 12345 50000
node tools/verify.mjs /tmp/fuzz.json   # the oracle checks the TS expectations
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

With an adapter, UNTIL is compared as the UTC instant RFC 5545 requires for
zoned rules. Each parsed RDATE/EXDATE value is converted once, according to
its own form: a UTC `…Z` value as is, a `;TZID=` value with its own zone, a
floating value with the set's zone. Changing the adapter discards cached
results.

DST gaps and folds are the adapter's business; the engine is floating by
design.

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

### Why it is faster

The algorithm is still rrule.js's (itself python-dateutil's): iterate period
by period (a year, month, week, day…), work out which days of the period pass
the BY* filters, combine them with the times of day, and emit the results in
order. The output is the same. What changed is how much work each step does.
I profiled with `node --cpu-prof` on real call shapes, removed the largest
cost, and repeated. After every change, both packages had to pass the full
corpus and a 100,000-rule TS-vs-Dart fuzz run unchanged.

1. **Stop when the answer is known.**
   - *Past the requested window.* rrule.js's `between(a, b)` only stopped
     after it *accepted* an occurrence later than `b`. For a rule whose next
     occurrence is years away, or that never occurs again, it kept iterating
     up to year 9999. Now each period first checks its earliest possible
     instant against the upper bound (and UNTIL), and the loop ends as soon as
     no later period can contribute. This alone accounts for most of the
     ~150× on the random corpus, which contains many such rules.
   - *Impossible BYSETPOS.* If every position is larger than the most
     candidates a period can hold (`DAILY;BYDAY=SA,MO;BYSETPOS=2`: at most one
     per day), the rule is empty, which is known before iterating.
   - *Unreachable sub-daily rules* (`HOURLY;INTERVAL=6;BYHOUR=3` from 00:00).
     The counter's state space is finite, so the search stops after one full
     cycle. rrule.js looped forever here.
   - *Runaway safety net.* After 200,000 consecutive periods without a single
     candidate, iteration stops. Periods that produce candidates reset the
     count, so productive rules are never cut short.

2. **Don't rebuild what didn't change.**
   - *Year masks.* rrule.js recomputes per-year tables (month, weekday and
     month-day of each day) when the year changes. But it tracked "the last
     year" through the nth-weekday month info, which only exists for rules
     like `BYDAY=2TU`. So for every other rule it re-sliced several
     366-entry arrays on *every* period: once per day for DAILY. They are now
     cached by year.
   - *nth-weekday mask.* For "2nd Tuesday"-style rules, rrule.js allocated a
     fresh year-long array every month. One buffer is now reused, and only
     the few entries set the previous month are cleared. This made that case
     about 6× faster, mostly by removing garbage-collection time.

3. **Allocate less on the hot path.**
   - *Day set.* rrule.js built a year-long array (366 entries, mostly
     `null`) for every period, even for DAILY, where a period is one day. Now
     a single typed buffer holds just the day indexes that passed the
     filters, and it is reused for every period.
   - *Dates.* rrule.js created several `Date` objects per *candidate*:
     `fromOrdinal` for the day, `Date.UTC` in `combine` for day plus time, and
     a `DateWithZone` wrapper per result. Candidates are now plain epoch
     milliseconds: `yearStart + day × 86,400,000 + timeOfDay`. Comparisons
     with DTSTART, UNTIL and the window are integer comparisons, and a single
     `Date` (`DateTime` in Dart) is created only for each occurrence actually
     returned.

4. **Make the inner checks cheap.**
   - *Filters.* Each candidate day is checked against BYMONTH, BYDAY,
     BYMONTHDAY, BYYEARDAY and so on. rrule.js destructured the options and
     ran `Array.indexOf` per day and per filter. Each filter is now a small
     precomputed lookup table (`Uint8Array` / `Uint8List`), so a check is one
     indexed read.
   - *Bounds in `IterResult.accept`.* rrule.js compared `Date` objects with
     `<` and `>`, which converts both through `valueOf()` on every call. In
     the profile of a weekly expansion this was about 60% of the remaining
     time. The bounds are now precomputed numbers compared with `getTime()`:
     2× on its own.
   - *Sub-daily rules.* When stepping by seconds or minutes, an hour (or
     minute) that BYHOUR (or BYMINUTE) excludes is skipped in one jump to its
     last step. The skipped steps all share the excluded hour or minute, so
     the output is identical.

The Dart package uses the same structure (lookup tables, reused buffers,
epoch-ms candidates). That made it about 1.3–2.7× faster than the port
previously in the mobile app, which already cached year masks but built two
`DateTime`s per candidate.

## How each repository switches

**First, in every repository:** wrap each event's `expandEventRecurrence`
call in `try/catch`. Rules with values outside RFC 5545's ranges now throw
instead of hanging or producing odd dates; see
[docs/IMPACT.md](docs/IMPACT.md#required-before-rollout).

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
