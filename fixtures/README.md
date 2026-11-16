# Conformance fixtures

Every file is `{"schema": 1, "name", "description", "generatedBy", "cases": [...]}`
with one case per line. Both packages must reproduce `expected` exactly:
`packages/ts/test/conformance.test.ts` and
`packages/dart/test/conformance_test.dart`.

**Do not edit by hand.** Regenerate with `node tools/gen-fixtures.mjs`.

## Case fields

| field | meaning |
|---|---|
| `id` | unique, stable across regenerations |
| `dtstart` | floating local date-time, `YYYY-MM-DDTHH:MM:SS[.mmm]` |
| `rrule` | RFC 5545 RRULE value without the `RRULE:` prefix; `UNTIL` is read as floating whether or not it ends in `Z`. May contain RFC 7529 `RSCALE=GREGORIAN;SKIP=…` |
| `jscal` | optional: the same rule as a JSCalendar (RFC 8984) `RecurrenceRule`; Dart also runs it through `RRuleOptions.fromJsCalendar` |
| `jscalExpected` | optional: the expected value of the `jscal` path when it differs from `expected`, because RFC 8984 adds implicit properties that RFC 5545 does not (e.g. a yearly rule with `byMonthDay` only means the start month). Computed from `tools/lib/jscal.mjs`, written independently of the Dart converter |
| `query` | what to compute (see below) |
| `expected` | `["YYYY-MM-DDTHH:MM:SS", …]` for `all`/`between`; a single string or `null` for `before`/`after`; `{"error": true}` if the rule must be rejected |
| `features`, `note`, `bug` | informational |

### Queries

| `method` | parameters | TS call | Dart call |
|---|---|---|---|
| `all` | `limit?` | `rule.all((d, n) => n < limit)` | `rule.all(limit: limit)` |
| `between` | `after`, `before`, `inc`, `limit?` | `rule.between(after, before, inc, (d, n) => n < limit)` | `rule.between(after, before, inclusive: inc).take(limit)` |
| `before` / `after` | `dt`, `inc` | `rule.before(dt, inc)` / `rule.after(dt, inc)` | `rule.before(dt, inclusive: inc)` / `rule.after(dt, inclusive: inc)` |

Rules are built from `RRule.parseString(rrule)` (TS) or
`RRuleOptions.parse(rrule)` (Dart), with `dtstart` set to the floating
date-time.
