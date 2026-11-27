// Runs the shared conformance corpus (../../fixtures/*.json, or the files /
// directories listed in $FIXTURES, comma-separated). The TypeScript package
// runs the same corpus in packages/ts/test/conformance.test.ts.
//
// Every case is evaluated from its RRULE value (RRuleOptions.parse) and as a
// `DTSTART:…\nRRULE:…` string (RRuleOptions.parseString); cases that also
// carry a JSCalendar rule (`jscal`) are evaluated through fromJsCalendar too.
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

/// A RecurrenceRule without `@type`s and a default interval, for comparing.
String _normalJs(Map<String, dynamic> rule) {
  final r = {
    for (final e in rule.entries)
      if (e.key != '@type' &&
          !(e.key == 'interval' && e.value == 1) &&
          !(e.key == 'rscale' && e.value == 'gregorian'))
        e.key: e.key == 'byDay'
            ? [
                for (final d in e.value as List)
                  {
                    for (final f in (d as Map).entries)
                      if (f.key != '@type') f.key: f.value
                  }
              ]
            : e.value
  };
  return jsonEncode(Map.fromEntries(r.entries.toList()..sort((a, b) => a.key.compareTo(b.key))));
}

Map<String, dynamic>? _tryJs(String rrule) {
  try {
    return rruleToJsCalendar(rrule);
  } on FormatException {
    return null;
  }
}

List<File> _fixtureFiles() {
  final spec = Platform.environment['FIXTURES'] ?? '../../fixtures';
  return [
    for (final p in spec.split(','))
      if (FileSystemEntity.isDirectorySync(p))
        ...(Directory(p)
            .listSync()
            .whereType<File>()
            .where((f) => f.path.endsWith('.json'))
            .toList()
          ..sort((a, b) => a.path.compareTo(b.path)))
      else
        File(p)
  ];
}

void main() {
  var total = 0, jscalTotal = 0, withoutForm = 0;
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
        // The same rule as an iCalendar string, through parseString.
        final start = c['dtstart'] as String;
        final string = start.length == 19
            ? 'DTSTART:${start.replaceAll(RegExp('[-:]'), '')}\nRRULE:${c['rrule']}'
            : 'RRULE:${c['rrule']}';
        final gotString = jsonEncode(_evaluate(
            () => RRuleOptions.parseString(string, dtstart: start.length == 19 ? null : dtstart),
            q));
        if (gotString != expected) {
          failures.add('${c['id']} (string) ${jsonEncode(string)}\n'
              '  expected $expected\n  got      $gotString');
        }
        // JSCalendar conversion, checked by the occurrences:
        //  * RRULE -> JSCalendar -> RRULE gives the RRULE's occurrences;
        //  * RRULE -> JSCalendar with keepRRuleMeaning, evaluated as JSCalendar
        //    (fromJsCalendar adds RFC 8984's implicit properties), too.
        final rrule = c['rrule'] as String;
        void conversion(String name, RRuleOptions Function() options) {
          final got = jsonEncode(_evaluate(options, q));
          if (got != expected) {
            failures.add('${c['id']} ($name) $rrule\n  expected $expected\n  got      $got');
          }
        }

        // INTERVAL=0 has no JSCalendar form (RFC 8984: interval >= 1).
        if (RegExp(r'INTERVAL=0(;|$)').hasMatch(rrule)) {
          expect(() => rruleToJsCalendar(rrule), throwsFormatException, reason: rrule);
        } else {
          conversion(
              'rrule->jscal->rrule',
              () => RRuleOptions.parse(jsCalendarToRRule(rruleToJsCalendar(rrule)),
                  dtstart: dtstart));
          // Yearly BYMONTHDAY with an nth BYDAY and no BYMONTH has no
          // meaning-keeping form (see rruleMeaningInJsCalendar).
          final literal = _tryJs(rrule);
          final unkeepable = literal != null &&
              literal['frequency'] == 'yearly' &&
              literal['byMonthDay'] != null &&
              literal['byMonth'] == null &&
              literal['byWeekNo'] == null &&
              literal['byYearDay'] == null &&
              ((literal['byDay'] as List?) ?? const [])
                  .any((d) => (d as Map)['nthOfPeriod'] != null);
          if (unkeepable) {
            withoutForm++;
          } else {
            conversion(
                'rrule->jscal keepRRuleMeaning',
                () => RRuleOptions.fromJsCalendar(
                    rruleToJsCalendar(rrule, keepRRuleMeaning: true), dtstart)!);
          }
        }
        final js = c['jscal'] as Map<String, dynamic>?;
        if (js != null) {
          jscal++;
          // JSCalendar semantics (RFC 8984 implicit properties) can differ from
          // the plain RRULE: then the case carries its own jscalExpected.
          final expectedJs =
              c.containsKey('jscalExpected') ? jsonEncode(c['jscalExpected']) : expected;
          final gotJs = jsonEncode(_evaluate(() => RRuleOptions.fromJsCalendar(js, dtstart)!, q));
          // JSCalendar -> RRULE with keepJsCalendarMeaning has the JSCalendar
          // occurrences; a literal JSCalendar -> RRULE -> JSCalendar keeps the rule.
          final gotJsRRule = jsonEncode(_evaluate(
              () => RRuleOptions.parse(
                  jsCalendarToRRule(js, start: dtstart, keepJsCalendarMeaning: true),
                  dtstart: dtstart),
              q));
          if (gotJsRRule != expectedJs) {
            failures.add('${c['id']} (jscal->rrule keepJsCalendarMeaning) ${jsonEncode(js)}\n'
                '  expected $expectedJs\n  got      $gotJsRRule');
          }
          final back = _normalJs(rruleToJsCalendar(jsCalendarToRRule(js)));
          if (back != _normalJs(js)) {
            failures.add('${c['id']} (jscal->rrule->jscal) ${jsonEncode(js)}\n  got ${back}');
          }
          if (gotJs != expectedJs) {
            failures.add('${c['id']} (jscal) ${jsonEncode(js)}\n'
                '  expected $expectedJs\n  got      $gotJs');
          }
        }
      }
      total += cases.length;
      jscalTotal += jscal;
      print(
          '$name: ${cases.length - failures.where((f) => !f.contains('(jscal') && !f.contains('(string)') && !f.contains('(rrule->')).length}'
          '/${cases.length} pass, jscal ${jscal - failures.where((f) => f.contains('(jscal)')).length}'
          '/$jscal (running total $total + $jscalTotal jscal, '
          '$withoutForm without a meaning-keeping JSCalendar form)');
      expect(failures.take(10).toList(), isEmpty);
    });
  }
}
