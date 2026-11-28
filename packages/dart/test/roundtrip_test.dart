// Generated round trips of recurrence overrides and RDATE periods (the
// TypeScript package runs the same properties in
// packages/ts/test/roundtrip.test.ts). The corpus round trips of rules are in
// conformance_test.dart.
import 'dart:io';
import 'dart:math';

import 'package:morgen_rrule/morgen_rrule.dart';
import 'package:test/test.dart';

final _seed = int.parse(Platform.environment['ROUNDTRIP_SEED'] ?? '1');
const _runs = 2000;
const _hour = Duration(hours: 1);

String _fmt(DateTime d) => d.toIso8601String().substring(0, 19);

/// Zones with a time change in March 2025: the UTC instant of each change and
/// the offsets before and after it (hours).
final _zones = <String, ({DateTime change, int before, int after})>{
  'Europe/Zurich': (change: DateTime.utc(2025, 3, 30, 1), before: 1, after: 2),
  'America/New_York': (change: DateTime.utc(2025, 3, 9, 7), before: -5, after: -4),
  'Etc/UTC': (change: DateTime.utc(1970), before: 0, after: 0),
};

/// The wall clock of an instant.
DateTime _wall(String zone, DateTime instant) {
  final z = _zones[zone]!;
  return instant.add(_hour * (instant.isBefore(z.change) ? z.before : z.after));
}

/// The instant of a wall clock (a skipped time is read with the offset before the change).
DateTime _toInstant(DateTime wall, String zone) {
  final z = _zones[zone]!;
  final before = wall.subtract(_hour * z.before);
  return before.isBefore(z.change) ? before : wall.subtract(_hour * z.after);
}

ToEventTime _toEventTime(String eventZone) =>
    (wall, zone) => _wall(eventZone, _toInstant(wall, zone));

/// Parses a duration of hours, minutes and seconds (what the converter writes).
Duration _duration(String d) {
  final m = RegExp(r'^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$').firstMatch(d);
  if (m == null) throw StateError('Unexpected duration $d');
  int part(int i) => int.parse(m.group(i) ?? '0');
  return Duration(hours: part(1), minutes: part(2), seconds: part(3));
}

String _ical(DateTime d) => _fmt(d).replaceAll(RegExp('[-:]'), '');

void main() {
  group('RDATE periods keep their end instant', () {
    final random = Random(_seed);
    final zones = _zones.keys.toList();
    for (var i = 0; i < _runs; i++) {
      // Starts from Mar 7 to Apr 1, 2025, ends up to three days later, on whole minutes.
      final start = DateTime.utc(2025, 3, 7).add(Duration(minutes: random.nextInt(25 * 24 * 60)));
      final end = start.add(Duration(minutes: random.nextInt(3 * 24 * 60)));
      final source = zones[random.nextInt(zones.length)];
      final eventZone = zones[random.nextInt(2)];
      final sw = _wall(source, start), ew = _wall(source, end);
      // A wall clock in a skipped hour does not name the instant: leave it out.
      if (_toInstant(sw, source) != start || _toInstant(ew, source) != end) continue;
      final line = source == 'Etc/UTC'
          ? 'RDATE;VALUE=PERIOD:${_ical(start)}Z/${_ical(end)}Z'
          : 'RDATE;TZID=$source;VALUE=PERIOD:${_ical(sw)}/${_ical(ew)}';
      test('$i: $line in $eventZone', () {
        final got = recurrenceOverridesFromICal([line],
            toEventTime: _toEventTime(eventZone), toInstant: _toInstant, strict: true);
        final MapEntry(:key, :value) = got.entries.single;
        final s = _toInstant(DateTime.parse('${key}Z'), eventZone);
        expect(_fmt(s), _fmt(start));
        expect(_fmt(s.add(_duration(value['duration'] as String))), _fmt(end));
      });
    }
  });

  group('recurrence overrides round trip', () {
    final random = Random(_seed + 1);
    const forms = ICalDateForm.values;
    for (var i = 0; i < _runs ~/ 4; i++) {
      final form = forms[i % forms.length];
      final overrides = <String, Map<String, Object?>>{};
      final occurrences = <String>{};
      final n = 1 + random.nextInt(6);
      for (var k = 0; k < n; k++) {
        final day =
            DateTime.utc(2024, 1, 1 + random.nextInt(60), form == ICalDateForm.date ? 0 : 9);
        final key = _fmt(day);
        if (random.nextBool()) occurrences.add(key);
        final kind = random.nextInt(4);
        overrides[key] = switch (kind) {
          0 => {'excluded': true},
          1 => {},
          2 when form != ICalDateForm.date => {'duration': 'PT${1 + random.nextInt(30)}H'},
          _ => {'title': 'Moved'},
        };
      }
      test('$i: ${form.name} $overrides', () {
        ICalRecurrenceDates write(Map<String, Object?> o) => recurrenceOverridesToICal(o,
            form: form,
            timeZone: form == ICalDateForm.zoned ? 'Europe/Zurich' : null,
            isOccurrence: (id) => occurrences.contains(_fmt(id)),
            strict: true);
        final first = write(overrides);
        final back = recurrenceOverridesFromICal(first.properties, strict: true);
        for (final MapEntry(:key, value: patch) in overrides.entries) {
          final got = back[key];
          final generated = occurrences.contains(key);
          // What the lines hold comes back...
          if (patch['excluded'] == true) {
            expect(got, {'excluded': true});
          } else if (patch['duration'] != null && !generated) {
            expect(got, {'duration': patch['duration']});
          } else if (!generated) {
            expect(got, <String, Object?>{});
          }
          // ...and the rest is listed for an override component.
          final inLines = patch['excluded'] == true || !generated;
          final rest = patch['excluded'] != true &&
              (generated ? patch.isNotEmpty : patch.containsKey('title'));
          expect({'key': key, 'inLines': got != null, 'rest': first.overrides.contains(key)},
              {'key': key, 'inLines': inLines, 'rest': rest});
        }
        // ...and writing it again gives the same lines.
        expect(write(back).properties, first.properties);
      });
    }
  });
}
