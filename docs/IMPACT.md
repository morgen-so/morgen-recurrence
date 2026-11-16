# What changes for real events after switching

Comparison of upstream rrule.js with this fork (both packages behave
identically). Measured with `tools/impact.mjs` on the corpus. rrule.js 2.6.4
(sync service) and 2.8.0 (desktop, Kai, backend) give **exactly the same
numbers**: the expansion core did not change between them.

## Summary

The occurrences of an event change **only** if its RRULE has one of the shapes
below. On the 6,588-case corpus, every result difference falls into these
shapes; every other rule gives identical results, apart from finishing faster.
The corpus is deliberately biased towards edge cases, so its 10.7% difference
rate says nothing about production; the shapes are what matter.

| # | rule shape | before (rrule.js) | after | how common in real calendars |
|---|---|---|---|---|
| 1 | MONTHLY/YEARLY with **plain and nth weekdays mixed** in BYDAY, e.g. `BYDAY=2WE,SA` | no occurrences at all | days matching either part (RFC 5545) | rare: Google, Outlook and Apple UIs cannot create it; it comes from hand-written or imported ICS. Events that were invisible appear. |
| 2 | **BYSETPOS** with a negative position larger than the set (`BYDAY=MO;BYSETPOS=-5` in a 4-Monday month), or positions that hit the same occurrence (`BYSETPOS=1,-1` on a one-element set) | first element of the set / duplicates | nothing / one occurrence | uncommon. The usual provider shapes (`BYSETPOS=-1` or `1`..`4` with a weekday list, "last weekday", "first Monday") are **not** affected unless the period has fewer candidates than the position. Most likely real case: "5th/last-but-4 X" rules. |
| 3 | **unsorted or duplicate BYHOUR/BYMINUTE/BYSECOND**, e.g. `DAILY;BYHOUR=18,9` | times out of order; with COUNT or UNTIL the series ends at the wrong place (one occurrence too few or too many on the last day) | sorted; COUNT/UNTIL exact | very rare: calendar providers do not emit BYHOUR for events, and desktop/Kai reject rules with several times per day. Mostly agentic-workflow schedules (`BYHOUR=8,12,18`). Only multi-value lists in non-ascending order are affected. |
| 4 | **MINUTELY/SECONDLY with BYHOUR or BYMINUTE** that must carry into the next hour/minute | wrong times (INTERVAL grid misaligned), skipped days, or an infinite loop | python-dateutil's results | essentially none for events. Workflow schedules could use it; desktop/Kai reject sub-daily rules. |
| 5 | rules that **never match**, or unreachable sub-daily combinations (`HOURLY;INTERVAL=6;BYHOUR=3` from 00:00) | same empty result after seconds of CPU, or a hang | empty result immediately | rare, but each one costs seconds of CPU per expansion, on desktop's main path or in a backend request. `isRecurrenceExpansionSafe` in the sync service exists partly because of this. |
| 6 | **values outside RFC 5545's ranges**: `INTERVAL=-1`, `INTERVAL=abc`, `COUNT=-1`, `BYHOUR=25`, `BYMONTHDAY=0`, `BYWEEKNO=54`… | a hang (negative or non-numeric INTERVAL), an unbounded series (negative COUNT), or silently shifted dates | **an exception** | rare, from hand-written or broken ICS feeds. **See "Required before rollout" below.** |
| 7 | **BYWEEKNO** whose weeks cross a year boundary (week 1, 52, 53, negative weeks) | days of the week that falls in the neighbouring year are lost or invented | ISO 8601 week numbering with WKST | rare: providers almost never emit BYWEEKNO. |
| 8 | **WEEKLY + BYSETPOS** with DTSTART not on the first day of the week | in the first week, positions counted from DTSTART: one extra or different first occurrence | positions counted over the whole week, as in later weeks | rare. Only the first week changes. |
| 9 | **SKIP** (`RSCALE=GREGORIAN;SKIP=…`, RFC 7529) | rrule.js throws "Unknown RRULE property" | supported | rare; from RFC 7529-aware servers. Events that could not be expanded at all now are. |
| 10 | **mobile: JSCalendar yearly rules with `byMonthDay` and no `byMonth`** | mobile expanded them *monthly* (e.g. every 15th) | the start month only, per RFC 8984; desktop and the backend already did this via `ensureValidYearlyRecurrence` | removes a real mobile/desktop divergence. Also yearly + `byWeekNo` only: now only the start weekday (RFC 8984), whereas desktop expands all 7 days of the week. That is very rare; the JSCalendar converter in the sync service should add `byDay` explicitly. |

TS-only fixes that cannot change our current call sites (none of them uses
these features), but matter for future ones:
- `DTSTART;VALUE=DATE` (rrule.js used "now");
- years 0–99 and pre-1970 milliseconds;
- `rrulestr(..., {dtstart})` for sets;
- RRuleSet callbacks;
- caches and clones;
- serialization of weekday strings and UNTIL with a TZID (now with `Z`);
- UNTIL, RDATE and EXDATE with a time-zone adapter.

See [REVIEW-2026-11-16.md](REVIEW-2026-11-16.md).

What does **not** change:

- every rule using only FREQ/INTERVAL/COUNT/UNTIL, plain BYDAY, a single nth
  BYDAY, BYMONTHDAY, BYMONTH, BYYEARDAY or WKST, and BYWEEKNO away from year
  boundaries;
- `BYSETPOS` within the size of the set;
- `TZID=UTC` and floating rules;
- text (`toText`/`parseText`) and string output (`toString`).

`packages/ts/test/api-compat.test.ts` checks the call shapes our repos use
against upstream.

One behaviour change concerns time zones, not rules. A TZID other than UTC
used to be converted with `Intl`; it is now returned as floating unless an
adapter is installed. No Morgen code passes such a TZID to rrule.js: every
`rrulestr` call builds `DTSTART;TZID=UTC:` or a TZID-less DTSTART. Check for
`TZID=` in any new call site.

## Required before rollout

Invalid rules now **throw** from `rrulestr`/`new RRule` (shape 6) where
rrule.js returned odd dates or hung. rrule.js already threw on some input
(unknown properties, `BYSETPOS=0`), but the set is now larger. None of the
current `expandEventRecurrence` call sites catches per event: for example
`events.forEach(event => expandEventRecurrence(event, …))` in the backend's
feed adapter, or the desktop `EventCollection`. One malformed rule in a user's
ICS feed could therefore abort the whole batch.

Before switching a repository, wrap each event's expansion in `try/catch`
and treat a throwing rule as non-recurring (or skip it), logging the rule
shape, not the rule.

### Corpus numbers (for reference, not representative of production)

Measured on the original 6,588-case corpus, before the review fixes (shapes
1–5). `node tools/impact.mjs packages/ts/node_modules/rrule` on the current
corpus also reports shapes 6–9. A case can count under
several shapes. "Hang" means it took longer than 3 s: either an infinite loop
or iteration to year 9999.

| shape | different | none → some | hang |
|---|---:|---:|---:|
| BYSETPOS | 335 | 16 | 54 |
| unsorted/duplicate BYHOUR | 103 | 2 | 29 |
| mixed plain+nth BYDAY | — | 98 | — |
| unsorted/duplicate BYMINUTE | 34 | 2 | 13 |
| MINUTELY with BYHOUR/BYMINUTE | 24 | — | 44 |
| SECONDLY with BYHOUR/BYMINUTE | 15 | 3 | 24 |
| unsorted/duplicate BYSECOND | 5 | 1 | 5 |
| any other rule | **0** | **0** | 33 (never-matching / unreachable) |

Total: 703 of 6,588 cases differ.

## How to count affected events in production

Events are not stored centrally. Desktop and Kai keep them in their local
databases, and the backend and sync service expand provider events on the fly
(`recurrenceExpand.ts`, called from the feed/DAV adapters). So count where
expansion happens. Two complementary ways:

### 1. Shadow mode (exact, recommended)

Before switching, ship a release in which `expandEventRecurrence` (backend,
sync service and desktop) also runs `@morgen-so/rrule` next to `rrule`. For a
sample of calls (say 1%, and always for rules matching the regexes below),
compare the occurrence lists. When they differ, emit a metric or a Sentry
breadcrumb with:

- the rule shape (as classified in `tools/impact.mjs`);
- a hash of the RRULE string;
- the provider;
- whether the difference was "none → some", "different" or "old took > 1 s".

Never log the RRULE with the event, or anything identifying the user. A week
of data gives the share of affected expansions per shape and per provider.
Time each library too: that also measures the performance win in the field.

### 2. Offline count on exported rules

Rule strings carry no personal data, but the export must still be approved
like any production data access. Export distinct `(DTSTART, RRULE)` pairs, for
example from the sync service's event cache or a desktop debug export. Write
one JSON object per line, `{"dtstart":"2024-01-01T09:00:00","rrule":"FREQ=..."}`,
and run:

```bash
node tools/impact.mjs packages/ts/node_modules/rrule rules.ndjson
```

This expands every rule over [now − 1 year, now + 2 years] with both libraries
and prints the differing rules grouped by shape.

### Pre-filter regexes

The RRULE string alone is enough to find candidates; a rule that matches none
of these regexes cannot change:

| shape | regex on the RRULE line |
|---|---|
| mixed BYDAY | `FREQ=(MONTHLY\|YEARLY)` and `BYDAY=(?=[^;]*[+-]?\d[A-Z]{2})(?=[^;]*(?:^\|[=,])[A-Z]{2}(?:[,;]\|$))` |
| BYSETPOS | `BYSETPOS=` (then check with `impact.mjs`: most are unaffected) |
| unsorted/duplicate time lists | `BY(HOUR\|MINUTE\|SECOND)=\d+,` (then check the order) |
| sub-daily carries | `FREQ=(MINUTELY\|SECONDLY)` and `BY(HOUR\|MINUTE)=` |
