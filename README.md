# morgen-recurrence

RFC 5545 recurrence rule (RRULE) expansion in two small idiomatic
implementations that must produce **identical** results:

| package | language | origin |
|---|---|---|
| [`packages/ts`](packages/ts) — `@morgen-so/rrule` | TypeScript | fork of [rrule.js](https://github.com/jkbrzt/rrule) 2.8.0, drop-in API |
| [`packages/dart`](packages/dart) — `morgen_rrule` | Dart | port of the rrule.js core |

Both run one shared conformance corpus, [`fixtures/`](fixtures), in CI, plus a
differential fuzz job on fresh random rules. Both also convert recurrence to
and from JSCalendar (RFC 8984; see [JSCalendar conversion](#jscalendar-conversion)).
Neither package contains time
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
      `byMonthDay` means the start month only).

Performance work, with identical results (see the [benchmarks](#performance)):

- iteration on epoch milliseconds instead of `Date` objects;
- a compact, reused day set instead of a fresh year-long array per period;
- year masks cached per year (rrule.js rebuilt them every period);
- precomputed lookup tables for the BY* filters;
- numeric bounds in `IterResult`.

## Layout

```
fixtures/               shared conformance corpus (JSON, one case per line)
fixtures/conversion/    hand-written JSCalendar conversion cases
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
clock. Callers that pass `DTSTART;TZID=UTC:…` and convert the results with
their own time-zone library keep working unchanged.

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

## JSCalendar conversion

Both packages convert between iCalendar recurrence (RFC 5545, RFC 7529 SKIP)
and JSCalendar (RFC 8984), as
[draft-ietf-calext-jscalendar-icalendar-31](https://datatracker.ietf.org/doc/draft-ietf-calext-jscalendar-icalendar/)
defines it (sections 2.3.18 EXDATE, 2.3.30 RDATE, 2.3.33 RRULE, 3.2). The
conversion follows the RFCs, not any product's schema: what Morgen's apps need
on top is done by the caller (see [What the caller adapts](#what-the-caller-adapts)).
The TypeScript names take an options object; Dart has the same names with
named arguments.

| | function |
|---|---|
| a whole recurrence: RRULE/EXRULE/EXDATE/RDATE lines → `recurrenceRules`, `excludedRecurrenceRules`, `recurrenceOverrides` | `recurrenceFromICal(lines, { toEventTime, toInstant, keepRRuleMeaning })` |
| and back | `recurrenceToICal({ recurrenceRules, excludedRecurrenceRules, recurrenceOverrides }, { form, timeZone, toUtc, isOccurrence, start, keepJsCalendarMeaning })` |
| one RRULE → RecurrenceRule | `rruleToJsCalendar(rrule, { toEventTime, keepRRuleMeaning })` |
| one RecurrenceRule → RRULE | `jsCalendarToRRule(rule, { untilForm, toUtc, toEventTime, start, keepJsCalendarMeaning })` |
| EXDATE/RDATE ↔ `recurrenceOverrides` | `recurrenceOverridesFromICal(lines, { toEventTime, toInstant })`, `recurrenceOverridesToICal(overrides, { form, timeZone, isOccurrence })` |

Every function also takes `strict` and `onWarning` (below).

- **Literal by default.** Each part maps to its property, as the draft says:
  values in lower case, BYDAY to NDay objects (with `@type`), BYMONTH to
  strings. Only the parts that are written are set: `interval` appears only
  when INTERVAL is written (RFC 8984's default is 1). INTERVAL=1 is left out
  on the way back. RRULE parameters before the colon
  (`RRULE;X-EVOLUTION-ENDDATE=…:FREQ=…`) are allowed, as RFC 5545 allows
  them. Non-Gregorian RSCALE rules (`RSCALE=HEBREW;BYMONTH=5L`) are
  converted, even though the engine only expands Gregorian rules.
- **COUNT and UNTIL together** are invalid in both RFCs. Strict mode throws;
  lenient mode keeps COUNT and leaves UNTIL out, with a warning.
- **UNTIL** is a LocalDateTime in the event's time zone. A date becomes
  midnight, a local time stays as written, and a UTC time goes through
  `toEventTime`. Back, it takes the form of the event's DTSTART (`form` /
  `untilForm`: `date`, `local`, `utc`, or `zoned`, which converts to UTC with
  `toUtc` as RFC 5545 requires). Without a converter the fields are kept: the
  machine's time zone is never used.
- **Implicit properties.** RFC 8984 section 4.3.3.1 (step 3) adds properties
  that RFC 5545 implementations such as rrule.js do not. So a literal mapping
  can change the occurrences of a few rules: `FREQ=YEARLY;BYMONTHDAY=15` is the
  15th of every month in rrule.js, but only of the start month as JSCalendar.
  - `keepRRuleMeaning` adds what keeps the rrule.js occurrences (here `byMonth`
    1–12; for "Friday the 13th" style rules, `byYearDay` 1–366). Only yearly
    rules with BYMONTHDAY above 28, an nth BYDAY and SKIP forward or backward
    stay literal, because a skipped day moves into another month. That is 56
    of the corpus's 9,425 rules.
  - `keepJsCalendarMeaning` adds what RFC 8984 adds for the start, so that
    rrule.js gives the JSCalendar occurrences.
  - **The start.** RFC 8984 counts the start as the first occurrence even when
    the rule does not generate it. Example: an event starting on Monday
    2024-01-01 with "weekly on Friday, `count` 2" has Jan 1 and Jan 5.
    rrule.js gives Jan 5 and Jan 12 for `FREQ=WEEKLY;COUNT=2;BYDAY=FR`. With
    `keepJsCalendarMeaning` and `start`, `recurrenceToICal` writes
    `RRULE:FREQ=WEEKLY;COUNT=1;BYDAY=FR` and `RDATE:20240101T090000`.
    `jsCalendarToRRule` cannot write that in one RRULE, so it warns.
- **Overrides.** An EXDATE is `{"excluded": true}`, an RDATE is `{}`, and an
  RDATE PERIOD is `{"duration": …}`. An EXDATE wins over an RDATE.
  - A PERIOD with an explicit end becomes whole days plus elapsed time. Pass
    `toInstant` so the elapsed time is right across a time change: in
    Europe/Zurich, `20250330T013000/20250330T033000` is `PT1H`, not `PT2H`.
  - Back, an excluded patch is an EXDATE and `{}` is an RDATE. A duration-only
    patch is an RDATE PERIOD only when `isOccurrence` says the rule does not
    generate that date. Without `isOccurrence`, it is a plain RDATE and an
    entry in `overrides`, which is right in both cases. Patches that change
    an occurrence are returned in `overrides`, for a recurrence override
    component.
  - A zero duration is never written as a PERIOD (RFC 5545 requires a
    positive one); it goes to `overrides`.
- **Lenient by default.** Data from providers and feeds is converted as well
  as it can be. Each problem is reported to `onWarning` and the rest is kept:
  - `X-` parts are ignored silently; unknown parts, malformed or out-of-range
    values and INTERVAL < 1 are left out;
  - names and values may be in any case, with spaces, trailing `;` and folded
    lines;
  - UNTIL and stored `until` values may be dates, have fractional seconds,
    `Z` or an offset;
  - impossible dates move forward within their own year, as rrule.js does
    (February 30, 2023 is March 2);
  - an EXDATE PERIOD counts by its start;
  - other lines in a recurrence are skipped.

  Only a rule without a readable frequency is null (left out of a whole
  recurrence). With `strict: true`, each of these throws instead (TS `Error`,
  Dart `FormatException`). Lenient output equals strict output for every
  rule strict accepts (checked on the corpus).
- **Not covered.** Microsoft Graph's recurrence pattern, and the rest of an
  event. Google's recurrence is RRULE lines, so it is covered.

Tests:
- [`fixtures/conversion/jscalendar.json`](fixtures/conversion/jscalendar.json)
  has hand-written cases: the draft's own examples, time zones as offsets
  (fixed, or with a change for daylight saving), strict errors, lenient
  repairs (with the expected number of warnings), and real-world quirks.
- The conformance tests also check every corpus case by its occurrences: the
  RRULE → JSCalendar → RRULE round trip, `keepRRuleMeaning` evaluated as
  JSCalendar, and `keepJsCalendarMeaning` against `jscalExpected`. They also
  check that lenient equals strict.
- Both packages give the same output for every rule in the corpus.

### What the caller adapts

The library gives what the RFCs say. These cases need a few lines in the
project that uses it, because they come from Morgen's schemas or from how a
project writes to a provider.

**Morgen's rule type.** Desktop, Kai and the backend type a rule as
`frequency: 'yearly' | 'monthly' | 'weekly' | 'daily'`, `interval: number`
(required), and `NDay.day: string`. The library's type allows HOURLY to
SECONDLY and leaves `interval` out when INTERVAL is not written. One adapter
per project covers all three:

```ts
const MORGEN_FREQUENCIES = ['yearly', 'monthly', 'weekly', 'daily'] as const

/** A library rule as Morgen stores it, or null for a rule Morgen cannot store. */
function toMorgenRule(rule: JSCalendarRecurrenceRule | null): MorgenRecurrenceRule | null {
  if (!rule || !(MORGEN_FREQUENCIES as readonly string[]).includes(rule.frequency)) return null
  return { ...rule, frequency: rule.frequency as MorgenRecurrenceRule['frequency'], interval: rule.interval ?? 1 }
}
```

- `FREQ=HOURLY;INTERVAL=2` gives `{frequency: "hourly", interval: 2}`, which
  `toMorgenRule` turns into null. Whether to drop the event's recurrence or
  reject the event is the project's choice.
- `FREQ=WEEKLY;BYDAY=MO` gives no `interval`; `toMorgenRule` sets 1.
- In the other direction, a Morgen rule passes to `jsCalendarToRRule` as it
  is: the library reads `day` case-insensitively and leaves out invalid
  values with a warning.
- Mobile compares stored rules with presets by equality. If mobile adds
  `interval: 1` on read, it must add it to the presets too (or compare
  without it), or "Weekly" shows as "Custom".

**No recurrence.** The library returns empty lists and maps
(`recurrenceFromICal([])` is `{recurrenceRules: [], excludedRecurrenceRules: [], recurrenceOverrides: {}}`),
which is valid JSCalendar. The apps use `null` for "does not repeat":

```ts
const r = recurrenceFromICal(lines, options)
const recurrenceRules = r.recurrenceRules.length ? r.recurrenceRules : null
```

**`count: 0`.** RFC 8984 allows it, so `FREQ=DAILY;COUNT=0` gives
`{count: 0}`. The integration service's write validator rejects it; the
project decides whether to drop the rule or reject the write.

**Recurrence override components.** `recurrenceToICal(...).overrides` lists
the recurrence ids whose patch changes an occurrence (a new time, title,
duration…). The library does not write them: the project writes a VEVENT
with RECURRENCE-ID (CalDAV) or updates the instance (Google). Pass
`isOccurrence` (whether the rule generates a date) so that a changed duration
on an added date becomes an RDATE PERIOD; without it, the duration goes to
`overrides`. Example: weekly Monday 09:00, Jan 8 made two hours long,
`{"2024-01-08T09:00:00": {duration: "PT2H"}}`:

| `isOccurrence` | properties | overrides |
|---|---|---|
| true for Jan 8 | none | `2024-01-08T09:00:00` |
| not given | `RDATE:20240108T090000` | `2024-01-08T09:00:00` |
| false for Jan 8 (an added date) | `RDATE;VALUE=PERIOD:20240108T090000/PT2H` | none |

**Provider writes.** The conversion has no idea of what is already stored:

- Google partial updates take the all-day flag and time zone from the stored
  event when the update does not send them. Pass `form` and `timeZone` from
  the event as it will be after the update, not from the request alone.
- A CalDAV edit that changes only the rule must keep the existing EXDATE and
  RDATE lines. Convert the whole recurrence (rule and stored overrides) with
  `recurrenceToICal`, or replace only the RRULE line; writing the rule alone
  brings deleted occurrences back.
- Microsoft Graph needs its own pattern mapper.

**Time zones.** The library never uses the machine's zone. The caller passes
`toEventTime`, `toUtc` and `toInstant`, and normalizes zone names first
(Windows names such as `Eastern Standard Time`, `UTC` vs `Etc/UTC`), for the
source zone and the event zone alike. See the adapter below.

**Mobile's product rules.** These stay in mobile's Morgen Assist checks, run
on the converted rule: no rules more frequent than daily, no BYHOUR, BYMINUTE
or BYSECOND, no COUNT on tasks, the Outlook limits, and an end date shown as
a date.

**Rules with an unmatched start.** When an event's start is not an occurrence
of its rule (common in imported events, never in rules Morgen's UI creates),
use `recurrenceToICal` with `start` and `keepJsCalendarMeaning`, not
`jsCalendarToRRule` per rule. Otherwise the start is lost in rrule.js-based
clients.

### Replacing the `ical.ts` converters

The backend, the sync service and desktop each have a copy of
`ICalendarService/ical.ts` with ical.js-based converters. Their replacements,
with the time zone converters built from moment-timezone and morgen-tz-service
(which also maps Windows zone names). Both the source zone and the event zone
go through `iana`:

```ts
const fmt = (d: Date) => d.toISOString().slice(0, 19)
const floating = (s: string) => new Date(`${s}Z`)
const iana = (tz: string) => new TimezoneService.Timezone(tz === 'Etc/UTC' ? 'UTC' : tz).ianaName
const toEventTime = (eventTz: string) => (wall: Date, tz: string) =>
  floating(moment.tz(fmt(wall), iana(tz)).tz(iana(eventTz)).format('YYYY-MM-DDTHH:mm:ss'))
const toUtc = (eventTz: string) => (wall: Date) =>
  floating(moment.tz(fmt(wall), iana(eventTz)).utc().format('YYYY-MM-DDTHH:mm:ss'))
const toInstant = (wall: Date, tz: string) =>
  floating(moment.tz(fmt(wall), iana(tz)).utc().format('YYYY-MM-DDTHH:mm:ss'))
const form = (allDay: boolean, tz?: string | null): ICalDateForm =>
  allDay ? 'date' : !tz ? 'local' : iana(tz) === 'UTC' ? 'utc' : 'zoned'
```

| old | new |
|---|---|
| `iCalendarRecurrencesToJSCalendar(lines, tz)` | `recurrenceFromICal(lines, { toEventTime: tz && toEventTime(tz), toInstant, onWarning })`, then `toMorgenRule` on each rule |
| `jsCalendarToICalendarRecurrences(rules, overrides, allDay, tz)` | `recurrenceToICal({ recurrenceRules: rules, recurrenceOverrides: overrides }, { form: form(allDay, tz), timeZone: tz, toUtc: tz && toUtc(tz), isOccurrence })`; `.properties` are the lines, `.overrides` the instances to write separately |
| `iCalRecurrenceRuleToJSCalendarRecurrenceRule(rrule, tz)` | `toMorgenRule(rruleToJsCalendar(rrule, { toEventTime: tz && toEventTime(tz), onWarning }))` |
| `jsCalendarRecurrenceRuleToICalRecurrenceRule(rule, allDay, tz)` | `'RRULE:' + jsCalendarToRRule(rule, { untilForm: form(allDay, tz), toUtc: tz && toUtc(tz), toEventTime: tz && toEventTime(tz) })` |

Differences from the `ical.ts` converters. A comparison on the corpus and on
real-world quirks found these bugs there, fixed here:

- SKIP and RSCALE were dropped when reading, so SKIP rules changed their
  occurrences (642 corpus rules).
- A single BYHOUR, BYMINUTE or BYSECOND of 0 was dropped (`FREQ=DAILY;BYHOUR=0`
  moved to the start's hour; 55 corpus rules).
- `RDATE;VALUE=PERIOD` gave the key `"Invalid date"`.
- Without an event time zone, UTC values and floating times on DST changes
  used the machine's zone (`moment.tz.guess()`).
- COUNT=0 was dropped, which made an empty rule endless.
- HOURLY, MINUTELY and SECONDLY rules gave null, and lower-case names and
  folded or lower-case `exdate` lines were rejected or lost.

Also different, by design:

- `@type` is set on RecurrenceRule and NDay (Morgen's schema requires it).
- `interval` is left out when INTERVAL is not written (`toMorgenRule` sets 1).
- WKST=MO is kept as `firstDayOfWeek: "mo"`.
- SKIP is written with RSCALE.
- `Etc/UTC` is written with `Z`, like `UTC`.
- COUNT and UNTIL together keep COUNT only.
- Sub-daily rules are returned (`toMorgenRule` drops them).

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
epoch-ms candidates). That made it about 1.3–2.7× faster than the Dart port
it started from, which already cached year masks but built two `DateTime`s per
candidate.

## Migrating from rrule.js

`@morgen-so/rrule` keeps rrule.js's API, so an npm alias is enough:
`"rrule": "npm:@morgen-so/rrule@<version>"`. Rules with values outside
RFC 5545's ranges now throw from `rrulestr`/`new RRule` instead of hanging or
producing odd dates, so catch errors per rule when expanding untrusted input.
See [docs/IMPACT.md](docs/IMPACT.md) for every behaviour change.

## Licence

BSD 3-Clause, inherited from rrule.js (Copyright 2010 Jakub Roztocil and Lars
Schöning) and python-dateutil. See `packages/*/LICENCE`.
