# morgen_rrule

RFC 5545 recurrence rule expansion for Dart and Flutter. It is a port of the
rrule.js 2.8.0 expansion core with the same fixes as the TypeScript package
`@morgen-so/rrule`, and both pass the shared conformance corpus in
[`../../fixtures`](../../fixtures).

```dart
import 'package:morgen_rrule/morgen_rrule.dart';

final rule = RRule(RRuleOptions.parse('FREQ=MONTHLY;BYDAY=2WE,SA;COUNT=6',
    dtstart: DateTime.utc(2024, 1, 1, 9)));
rule.all();                                   // List<DateTime>
rule.between(from, to);                       // lazy Iterable, inclusive by default
rule.after(dt); rule.before(dt);
RRule.fromString('DTSTART:20240101T090000\nRRULE:FREQ=DAILY;COUNT=3');
RRuleOptions.parseString('RRULE:FREQ=WEEKLY', dtstart: start); // rrule.js parseString
RRuleOptions.fromJsCalendar(jsCalendarRule, dtstart);   // JSCalendar (RFC 8984)
```

Times are **floating**: `DateTime`s with `isUtc: true` whose fields hold the
wall clock. Non-UTC inputs are read by their fields. There is no time zone
support by design: convert the results with your own time zone data.

`RRuleOptions.parseString` and `RRule.fromString` read a rule line, a DTSTART
line (`TZID` and `VALUE` in any order) or both, like rrule.js `parseString`.
DTSTART is floating and TZID is ignored. Unlike rrule.js, CRLF line endings
work, and a string without DTSTART needs `dtstart:` instead of starting "now".

Supported beyond rrule.js:
- SKIP (RFC 7529 `RSCALE=GREGORIAN;SKIP=…` in `RRuleOptions.parse`; JSCalendar
  `skip`; `RRuleOptions(skip: RRuleSkip.backward)`).
- `fromJsCalendar` adds RFC 8984's implicit properties (section 4.3.3.1, step
  3). For example, a yearly rule with `byMonthDay: [15]` means January 15 when
  the rule starts in January. As an RRULE, `FREQ=YEARLY;BYMONTHDAY=15` means
  every 15th.
- Invalid values (outside RFC 5545's ranges) throw `ArgumentError` /
  `FormatException`.

Not included: TZID, RRuleSet (RDATE/EXDATE), BYEASTER, text (NLP). The RFC 8984
rule that the start is always the first occurrence (and counts towards
`count`) is left to the caller.

## Development

```bash
dart pub get
dart test                                      # focused tests + conformance corpus
FIXTURES=/tmp/fuzz.json dart test test/conformance_test.dart   # other fixture files
dart compile exe bench/bench.dart -o /tmp/bench && /tmp/bench
```

BSD 3-Clause; see [LICENCE](LICENCE).
