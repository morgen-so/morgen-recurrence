// Runs the shared conformance corpus (../../fixtures/*.json, or the files /
// directories listed in $FIXTURES, comma-separated). The TypeScript package
// runs the same corpus in packages/ts/test/conformance.test.ts.
//
// Every case is evaluated from its RRULE string; cases that also carry a
// JSCalendar rule (`jscal`) are evaluated through fromJsCalendar as well.
import 'dart:convert';
import 'dart:io';

import 'package:morgen_rrule/morgen_rrule.dart';
import 'package:test/test.dart';

String _fmt(DateTime d) {
  final s = d.toIso8601String();
  return d.millisecond == 0 ? s.substring(0, 19) : s.substring(0, 23);
}

DateTime _parse(String s) => DateTime.parse('${s}Z');

Object? _evaluate(RRuleOptions Function() options, Map<String, dynamic> q) {
  try {
    final rule = RRule(options());
    final limit = q['limit'] as int?;
    final inc = q['inc'] == true;
    switch (q['method']) {
      case 'all':
        return rule.all(limit: limit).map(_fmt).toList();
      case 'between':
        final it = rule.between(_parse(q['after'] as String), _parse(q['before'] as String),
            inclusive: inc);
        return (limit == null ? it : it.take(limit)).map(_fmt).toList();
      case 'before':
        final d = rule.before(_parse(q['dt'] as String), inclusive: inc);
        return d == null ? null : _fmt(d);
      case 'after':
        final d = rule.after(_parse(q['dt'] as String), inclusive: inc);
        return d == null ? null : _fmt(d);
    }
    throw StateError('unknown method ${q['method']}');
  } on StateError {
    rethrow;
  } catch (_) {
    return {'error': true};
  }
}

List<File> _fixtureFiles() {
  final spec = Platform.environment['FIXTURES'] ?? '../../fixtures';
  return [
    for (final p in spec.split(','))
      if (FileSystemEntity.isDirectorySync(p))
        ...(Directory(p).listSync().whereType<File>().where((f) => f.path.endsWith('.json')).toList()
          ..sort((a, b) => a.path.compareTo(b.path)))
      else
        File(p)
  ];
}

void main() {
  var total = 0, jscalTotal = 0;
  for (final file in _fixtureFiles()) {
    final name = file.uri.pathSegments.last;
    test(name, () {
      final data = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      final cases = (data['cases'] as List).cast<Map<String, dynamic>>();
      final failures = <String>[];
      var jscal = 0;
      for (final c in cases) {
        final dtstart = _parse(c['dtstart'] as String);
        final q = c['query'] as Map<String, dynamic>;
        final expected = jsonEncode(c['expected']);
        final got = jsonEncode(
            _evaluate(() => RRuleOptions.parse(c['rrule'] as String, dtstart: dtstart), q));
        if (got != expected) {
          failures.add('${c['id']} DTSTART=${c['dtstart']} ${c['rrule']}\n'
              '  expected $expected\n  got      $got');
        }
        final js = c['jscal'] as Map<String, dynamic>?;
        if (js != null) {
          jscal++;
          final gotJs = jsonEncode(_evaluate(() => RRuleOptions.fromJsCalendar(js, dtstart)!, q));
          if (gotJs != expected) {
            failures.add('${c['id']} (jscal) ${jsonEncode(js)}\n'
                '  expected $expected\n  got      $gotJs');
          }
        }
      }
      total += cases.length;
      jscalTotal += jscal;
      print('$name: ${cases.length - failures.where((f) => !f.contains('(jscal)')).length}'
          '/${cases.length} pass, jscal ${jscal - failures.where((f) => f.contains('(jscal)')).length}'
          '/$jscal (running total $total + $jscalTotal jscal)');
      expect(failures.take(10).toList(), isEmpty);
    });
  }
}
