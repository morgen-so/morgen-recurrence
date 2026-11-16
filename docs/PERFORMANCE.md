# Performance

Medians of several rounds on an Apple Silicon Mac (2026-11-16). TypeScript runs
on Node 22.23; the TS benchmark ran alongside another job, so absolute times
are slightly pessimistic. Dart runs as an AOT executable (Dart 3.13.7), as in
the app.

"Expand" means what `recurrenceExpand.ts` does for each event: `rrulestr` with
a `DTSTART;TZID=UTC` line, then `between(dtstart − 2 days, dtstart + window,
true)`.

Reproduce:

```bash
cd packages/ts && npm run bench
```

```bash
cd packages/dart && dart compile exe bench/bench.dart -o /tmp/bench && /tmp/bench
```

| workload | rrule.js 2.8.0 | **@morgen-so/rrule** | speedup | Dart port as copied from mobile | **morgen_rrule** |
|---|---:|---:|---:|---:|---:|
| 3,722 random corpus rules, 1-year window (192,641 occurrences) | 12,931 ms | 79 ms | 165× | 112 ms | 71 ms |
| same, 3-year window (411,569 occurrences) | 19,704 ms | 140 ms | 141× | 194 ms | 123 ms |
| 1,310 BYWEEKNO/BYYEARDAY rules, 1-year window | 439 ms | 33 ms | 13× | 32 ms | 22 ms |
| weekly MO,WE,FR, 6 years: 1,000 expansions | 1,045 ms | 155 ms | 6.7× | 275 ms | 165 ms |
| daily, 6 years: 1,000 expansions | 3,963 ms | 314 ms | 13× | 545 ms | 365 ms |
| weekdays, 6 years: 1,000 expansions | 1,161 ms | 172 ms | 6.8× | 413 ms | 239 ms |
| monthly 2nd Tuesday, 6 years: 1,000 expansions | 235 ms | 25 ms | 9.4× | 126 ms | 58 ms |
| monthly last weekday (BYSETPOS), 6 years: 1,000 expansions | 252 ms | 30 ms | 8.3× | 120 ms | 62 ms |
| yearly, 6 years: 1,000 expansions | 66 ms | 15 ms | 4.3× | 77 ms | 40 ms |
| every 2 weeks TU,TH, 6 years: 1,000 expansions | 487 ms | 68 ms | 7.1× | 136 ms | 99 ms |
| daily, `all()` with COUNT=18250 | 29 ms | 1.9 ms | 15× | 6.0 ms | 2.5 ms |
| hourly, 1-year window (8,785 occurrences) | 15 ms | 1.4 ms | 11× | 3.3 ms | 2.8 ms |
| never-matching rules, 10-year `between` | 21 ms for 3 rules | 0.3 ms | 68× | 16 ms for 278 rules | 10 ms for 278 rules |
| `FREQ=DAILY;BYDAY=SA,MO;BYSETPOS=2`, `between` over 2 years | ~4 s (to year 9999) | < 1 ms | — | — | < 1 ms |
| `FREQ=HOURLY;INTERVAL=6;BYHOUR=3` from 00:00, `all()` | never returns | < 1 ms | — | — | < 1 ms |

Upstream is slow on the random corpus mostly because of rules whose next
occurrence lies far outside the window, or that never match: `between()` only
stops after accepting an occurrence past the window. The fork stops as soon as
a period starts after the window.

## Where the time went in rrule.js

- **Year masks rebuilt every period.** Iterinfo tracked the last year through
  the month info, which only exists for nth BYDAY rules, so every other rule
  re-sliced its 366-entry masks once per day, week or month.
- **A fresh year-long day-set array per period**, even for DAILY (one day).
- **Several `Date` objects per candidate** (`fromOrdinal`, then `combine`
  through `Date.UTC`), and a `DateWithZone` per result.
- **`IterResult.accept` compared `Date` objects with `<` and `>`**, which
  coerces through `valueOf` on every candidate. This was about 60% of the
  remaining time in the weekly case.
- **A fresh 366-entry nth-weekday mask per month** for rules like "2nd
  Tuesday", which was mostly garbage-collection time.
- No early exit: iteration continued to year 9999 when nothing matched.

The fork handles candidates as epoch milliseconds, keeps one reused buffer of
the days that pass the BY* filters, uses precomputed lookup tables for the
BY* checks, and builds a single `Date` per emitted occurrence. The Dart
package has the same structure.
