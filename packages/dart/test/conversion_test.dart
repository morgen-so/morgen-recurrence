// Runs the hand-written JSCalendar conversion cases in
// ../../fixtures/conversion/jscalendar.json (the TypeScript package runs the
// same file in packages/ts/test/jscalendar.test.ts). The conversions are also
// checked against the whole conformance corpus in conformance_test.dart.
import 'dart:convert';
import 'dart:io';

import 'package:morgen_rrule/morgen_rrule.dart';
import 'package:test/test.dart';

import 'zones.dart';

/// JSON with object keys sorted, for comparing results.
String _canonical(Object? v) => jsonEncode(_sorted(v));

Object? _sorted(Object? v) => switch (v) {
      Map() => {
          for (final k in (v.keys.map((k) => '$k').toList()..sort())) k: _sorted(v[k]),
        },
      List() => [for (final e in v) _sorted(e)],
      _ => v,
    };

DateTime _local(String s) => DateTime.parse('${s}Z');

String _fmt(DateTime d) => d.toIso8601String().substring(0, 19);

Object? _run(Map<String, dynamic> c, List<String> warnings) {
  final o = (c['options'] as Map<String, dynamic>?) ?? const {};
  final strict = o['strict'] == true;
  void warn(String m) => warnings.add(m);
  final timeZone = o['eventTimeZone'] as String?;
  final offsets = o['offsets'] as Map<String, dynamic>?;
  final zones = offsets == null ? null : zonesOf(offsets);
  final start = o['start'] == null ? null : _local(o['start'] as String);
  final occurrences = (o['occurrences'] as List?)?.cast<String>().toSet();
  final isOccurrence = occurrences == null ? null : (DateTime id) => occurrences.contains(_fmt(id));
  ICalDateForm form(String? name) =>
      name == null ? ICalDateForm.local : ICalDateForm.values.byName(name);
  final input = c['input'];
  switch (c['fn']) {
    case 'rruleToJsCalendar':
      return rruleToJsCalendar(input as String,
          timeZone: timeZone,
          zones: zones,
          keepRRuleMeaning: o['keepRRuleMeaning'] == true,
          strict: strict,
          onWarning: warn);
    case 'jsCalendarToRRule':
      return jsCalendarToRRule((input as Map).cast<String, Object?>(),
          untilForm: form(o['untilForm'] as String?),
          timeZone: timeZone,
          zones: zones,
          start: start,
          keepJsCalendarMeaning: o['keepJsCalendarMeaning'] == true,
          strict: strict,
          onWarning: warn);
    case 'recurrenceOverridesFromICal':
      return recurrenceOverridesFromICal((input as List).cast<String>(),
          timeZone: timeZone, zones: zones, strict: strict, onWarning: warn);
    case 'recurrenceOverridesToICal':
      final r = recurrenceOverridesToICal((input as Map).cast<String, Object?>(),
          form: form(o['form'] as String?),
          timeZone: o['timeZone'] as String?,
          isOccurrence: isOccurrence,
          strict: strict,
          onWarning: warn);
      return {'properties': r.properties, 'overrides': r.overrides};
    case 'recurrenceFromICal':
      final r = recurrenceFromICal((input as List).cast<String>(),
          timeZone: timeZone,
          zones: zones,
          keepRRuleMeaning: o['keepRRuleMeaning'] == true,
          strict: strict,
          onWarning: warn);
      return {
        'recurrenceRules': r.recurrenceRules,
        'excludedRecurrenceRules': r.excludedRecurrenceRules,
        'recurrenceOverrides': r.recurrenceOverrides,
      };
    case 'recurrenceToICal':
      final i = input as Map<String, dynamic>;
      final r = recurrenceToICal(
          recurrenceRules: (i['recurrenceRules'] as List?)?.cast<Map<String, Object?>>(),
          excludedRecurrenceRules:
              (i['excludedRecurrenceRules'] as List?)?.cast<Map<String, Object?>>(),
          recurrenceOverrides: (i['recurrenceOverrides'] as Map?)?.cast<String, Object?>(),
          form: form(o['form'] as String?),
          timeZone: o['timeZone'] as String? ?? timeZone,
          zones: zones,
          start: start,
          keepJsCalendarMeaning: o['keepJsCalendarMeaning'] == true,
          isOccurrence: isOccurrence,
          strict: strict,
          onWarning: warn);
      return {'properties': r.properties, 'overrides': r.overrides};
  }
  throw StateError('Unknown fn ${c['fn']}');
}

void main() {
  final file = File('../../fixtures/conversion/jscalendar.json');
  final cases =
      ((jsonDecode(file.readAsStringSync()) as Map)['cases'] as List).cast<Map<String, dynamic>>();
  for (final c in cases) {
    test('${c['fn']}: ${c['id']}', () {
      Object? got;
      final warnings = <String>[];
      try {
        got = _run(c, warnings);
      } on FormatException {
        got = {'error': true};
      }
      expect(_canonical(got), _canonical(c['expected']));
      if (got is! Map || got['error'] != true) {
        final expectedWarnings = (c['options'] as Map?)?['warnings'] ?? 0;
        expect(warnings.length, expectedWarnings, reason: warnings.join('\n'));
      }
    });
  }

  test('ICalDateForm.zoned needs the time zone for an UNTIL, and a time zone for overrides', () {
    expect(
        () => jsCalendarToRRule({'frequency': 'daily', 'until': '2024-01-31T09:00:00'},
            untilForm: ICalDateForm.zoned),
        throwsArgumentError);
    expect(() => recurrenceOverridesToICal({}, form: ICalDateForm.zoned), throwsArgumentError);
  });

  test('keepJsCalendarMeaning needs the start', () {
    expect(() => jsCalendarToRRule({'frequency': 'weekly'}, keepJsCalendarMeaning: true),
        throwsArgumentError);
  });
}
