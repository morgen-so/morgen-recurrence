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

/// Whether the RRULE has rule parts RFC 5545 section 3.3.10 does not allow
/// with its FREQ (the rrule package reads them, as JSCalendar does): strict
/// jsCalendarToRRule throws on such a rule, lenient warns.
bool _notInRfc5545(String rrule) {
  final f = RegExp(r'FREQ=(\w+)').firstMatch(rrule)?.group(1) ?? '';
  bool has(String part) => RegExp('(^|;)$part=').hasMatch(rrule);
  final nth = RegExp(r'(^|;)BYDAY=[^;]*\d').hasMatch(rrule);
  return has('BYMONTHDAY') && f == 'WEEKLY' ||
      has('BYYEARDAY') && const ['DAILY', 'WEEKLY', 'MONTHLY'].contains(f) ||
      has('BYWEEKNO') && f != 'YEARLY' ||
      nth && !const ['MONTHLY', 'YEARLY'].contains(f) ||
      nth && f == 'YEARLY' && has('BYWEEKNO');
}

/// The yearly SKIP rules whose keepRRuleMeaning conversion (with its warning)
/// gives other dates than rrule.js: a month day above 28 moved by SKIP. The
/// other corpus rules with that warning must keep their dates.
const _knownChangedBySkip = {
  'skip-overlap-0415',
  'skip-overlap-0517',
  'skip-overlap-0584',
  'skip-overlap-0623',
  'skip-overlap-0753',
};

/// The list is of the committed corpus: other fixtures ($FIXTURES, e.g.
/// fuzzing) only need the warning.
final _exactSkipList = Platform.environment['FIXTURES'] == null;

Map<String, dynamic>? _tryJs(String rrule) {
  try {
    return rruleToJsCalendar(rrule, strict: true);
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
  var total = 0, jscalTotal = 0, withoutForm = 0, warnedButKept = 0;
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
        // Export: strict for rules RFC 5545 allows, else lenient (warning
        // that a calendar may reject the rule).
        final invalid = _notInRfc5545(rrule);
        final exportWarnings = <String>[];
        final strictOut = !invalid;
        void conversion(String name, RRuleOptions Function() options) {
          final got = jsonEncode(_evaluate(options, q));
          if (got != expected) {
            failures.add('${c['id']} ($name) $rrule\n  expected $expected\n  got      $got');
          }
        }

        // INTERVAL=0 has no JSCalendar form (RFC 8984: interval >= 1), and
        // COUNT with UNTIL is not a valid RecurrenceRule.
        if (RegExp(r'INTERVAL=0(;|$)').hasMatch(rrule) ||
            rrule.contains('COUNT=') && rrule.contains('UNTIL=')) {
          expect(() => rruleToJsCalendar(rrule, strict: true), throwsFormatException,
              reason: rrule);
        } else {
          conversion(
              'rrule->jscal->rrule',
              () => RRuleOptions.parse(
                  jsCalendarToRRule(rruleToJsCalendar(rrule, strict: true)!,
                      strict: strictOut, onWarning: exportWarnings.add)!,
                  dtstart: dtstart));
          // Strict export throws exactly on the rules RFC 5545 does not allow.
          if (_tryJs(rrule) case final js?) {
            var threw = false;
            try {
              jsCalendarToRRule(js, strict: true);
            } on FormatException {
              threw = true;
            }
            if (threw != invalid) failures.add('${c['id']} (strict export throws: $threw) $rrule');
          }
        }
        if (_tryJs(rrule) != null) {
          // keepRRuleMeaning, evaluated as JSCalendar: the same dates, or a
          // warning that they may differ.
          final warnings = <String>[];
          final kept = rruleToJsCalendar(rrule,
              keepRRuleMeaning: true, strict: true, onWarning: warnings.add)!;
          if (warnings.isNotEmpty) {
            // A warning allows other dates only for the known rules, and
            // those must still differ (so the list stays exact).
            withoutForm++;
            final same =
                jsonEncode(_evaluate(() => RRuleOptions.fromJsCalendar(kept, dtstart)!, q)) ==
                    expected;
            if (same) warnedButKept++;
            if (_exactSkipList && same == _knownChangedBySkip.contains(c['id'])) {
              failures.add('${c['id']} (keepRRuleMeaning with a warning, same dates: $same) '
                  '$rrule\n  ${warnings.join('; ')}');
            }
          } else {
            conversion(
                'rrule->jscal keepRRuleMeaning', () => RRuleOptions.fromJsCalendar(kept, dtstart)!);
          }
          // Round trips are stable: RRULE -> JSCalendar -> RRULE -> JSCalendar
          // gives the same rule and RRULE, and so does a whole series
          // (recurrenceToICal -> recurrenceFromICal -> recurrenceToICal, with
          // the start), so a sync loop never changes an event.
          final js1 = rruleToJsCalendar(rrule, strict: true)!;
          final s1 = jsCalendarToRRule(js1, strict: strictOut, onWarning: exportWarnings.add)!;
          final js2 = rruleToJsCalendar(s1, strict: true)!;
          final s2 = jsCalendarToRRule(js2, strict: strictOut, onWarning: exportWarnings.add)!;
          if (s1 != s2 || _normalJs(js1) != _normalJs(js2)) {
            failures.add('${c['id']} (rrule round trip) $rrule\n'
                '  $s1 ${_normalJs(js1)}\n  $s2 ${_normalJs(js2)}');
          }
          List<String> series(List<Map<String, Object?>> rules,
                  [Map<String, Object?>? overrides]) =>
              recurrenceToICal(
                      recurrenceRules: rules,
                      recurrenceOverrides: overrides,
                      start: dtstart,
                      keepJsCalendarMeaning: true,
                      isOccurrence: (_) => true,
                      strict: strictOut,
                      onWarning: exportWarnings.add)
                  .properties;
          final p1 = series([kept]);
          final back = recurrenceFromICal(p1, strict: true);
          final p2 = series(back.recurrenceRules, back.recurrenceOverrides);
          if (jsonEncode(p1) != jsonEncode(p2)) {
            failures.add('${c['id']} (series round trip) $rrule\n'
                '  ${jsonEncode(p1)}\n  ${jsonEncode(p2)}');
          }
        }
        // Lenient (the default) gives the strict result wherever strict
        // succeeds, and never throws.
        final strictJs = _tryJs(rrule);
        final lenientJs = (() {
          try {
            return rruleToJsCalendar(rrule);
          } catch (e) {
            return {'threw': '$e'};
          }
        })();
        if (strictJs != null && jsonEncode(lenientJs) != jsonEncode(strictJs) ||
            lenientJs != null && lenientJs.containsKey('threw')) {
          failures.add('${c['id']} (rrule->jscal lenient) $rrule\n'
              '  strict  ${jsonEncode(strictJs)}\n  lenient ${jsonEncode(lenientJs)}');
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
                  jsCalendarToRRule(js,
                      start: dtstart,
                      keepJsCalendarMeaning: true,
                      strict: strictOut,
                      onWarning: exportWarnings.add)!,
                  dtstart: dtstart),
              q));
          if (gotJsRRule != expectedJs) {
            failures.add('${c['id']} (jscal->rrule keepJsCalendarMeaning) ${jsonEncode(js)}\n'
                '  expected $expectedJs\n  got      $gotJsRRule');
          }
          final back = _normalJs(
              rruleToJsCalendar(jsCalendarToRRule(js, strict: strictOut)!, strict: true)!);
          if (jsCalendarToRRule(js) != jsCalendarToRRule(js, strict: strictOut)) {
            failures.add('${c['id']} (jscal->rrule lenient) ${jsonEncode(js)}');
          }
          if (back != _normalJs(js)) {
            failures.add('${c['id']} (jscal->rrule->jscal) ${jsonEncode(js)}\n  got ${back}');
          }
          if (gotJs != expectedJs) {
            failures.add('${c['id']} (jscal) ${jsonEncode(js)}\n'
                '  expected $expectedJs\n  got      $gotJs');
          }
        }
        // The RFC 5545 warning comes only for those rules.
        if (!invalid && exportWarnings.any((m) => m.startsWith('RFC 5545 does not allow'))) {
          failures.add('${c['id']} (RFC 5545 warning for a valid rule) $rrule');
        }
      }
      total += cases.length;
      jscalTotal += jscal;
      print(
          '$name: ${cases.length - failures.where((f) => !f.contains('(jscal') && !f.contains('(string)') && !f.contains('(rrule->')).length}'
          '/${cases.length} pass, jscal ${jscal - failures.where((f) => f.contains('(jscal)')).length}'
          '/$jscal (running total $total + $jscalTotal jscal, '
          '$withoutForm keepRRuleMeaning warnings, $warnedButKept of them with the rrule.js '
          'dates anyway)');
      expect(failures.take(10).toList(), isEmpty);
    });
  }
}
