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
RRuleOptions.fromJsCalendar(jsCalendarRule, dtstart);   // JSCalendar (RFC 8984)
```

Times are **floating**: `DateTime`s with `isUtc: true` whose fields hold the
wall clock. Non-UTC inputs are read by their fields. There is no time zone
support by design: convert the results with your own time zone data.

Not included: TZID, RRuleSet (RDATE/EXDATE), BYEASTER, text (NLP).

## Development

```bash
dart pub get
dart test                                      # focused tests + conformance corpus
FIXTURES=/tmp/fuzz.json dart test test/conformance_test.dart   # other fixture files
dart compile exe bench/bench.dart -o /tmp/bench && /tmp/bench
```

BSD 3-Clause; see [LICENCE](LICENCE).
