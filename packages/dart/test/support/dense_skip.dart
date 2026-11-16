// Run by rrule_test.dart in a child VM with a 64 MB heap (second recheck,
// G02): every second of every day of the period, one or two results asked.
//   dart test/support/dense_skip.dart YEARLY|MONTHLY OMIT|BACKWARD|FORWARD
import 'dart:convert';

import 'package:morgen_rrule/morgen_rrule.dart';

void main(List<String> args) {
  final freq = args[0], skip = args[1];
  String range(int n, [int from = 0]) => List.generate(n, (i) => i + from).join(',');
  final spec = 'FREQ=$freq;RSCALE=GREGORIAN;SKIP=$skip;BYMONTHDAY=${range(31, 1)};'
      'BYHOUR=${range(24)};BYMINUTE=${range(60)};BYSECOND=${range(60)}';
  final start = DateTime.utc(2024);
  final rule = RRule(RRuleOptions.parse(spec, dtstart: start));
  final counted = RRule(RRuleOptions.parse('$spec;COUNT=1', dtstart: start));
  print(jsonEncode({
    'count1': counted.all().map((d) => d.toIso8601String()).toList(),
    'take2': rule.iterate().take(2).map((d) => d.toIso8601String()).toList(),
    'after': rule.after(start)?.toIso8601String(),
  }));
}
