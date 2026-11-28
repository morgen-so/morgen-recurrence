// Generated round trips of recurrence overrides and RDATE periods, compared
// as UTC instants (the TypeScript package runs the same properties in
// packages/ts/test/roundtrip.test.ts). The corpus round trips of rules are in
// conformance_test.dart.
import 'dart:io';
import 'dart:math';

import 'package:morgen_rrule/morgen_rrule.dart';
import 'package:test/test.dart';

import 'zones.dart';

final _seed = int.parse(Platform.environment['ROUNDTRIP_SEED'] ?? '1');
const _runs = 2000;

String _fmt(DateTime d) => d.toIso8601String().substring(0, 19);
String _ical(DateTime d) => _fmt(d).replaceAll(RegExp('[-:]'), '');
String _icalUtc(DateTime instant) => '${_ical(instant)}Z';
DateTime _wall(DateTime instant, String zone) => zones.fromInstant(instant, zone);
DateTime _instant(DateTime wall, String zone) => zones.toInstant(wall, zone);

/// A value written as `20250105T090000`.
DateTime _parseICal(String s) => DateTime.parse('${s.substring(0, 15)}Z');

/// The end of a JSCalendar duration from a start instant in the event's zone
/// (RFC 8984 section 1.4.6): weeks and days on the wall clock, then exact time.
DateTime _addDuration(DateTime start, String duration, String zone) {
  final m = RegExp(r'^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$')
      .firstMatch(duration);
  if (m == null) throw StateError('Unexpected duration $duration');
  int n(int i) => int.parse(m.group(i) ?? '0');
  final wall = _wall(start, zone).add(Duration(days: n(1) * 7 + n(2)));
  return _instant(wall, zone).add(Duration(hours: n(3), minutes: n(4), seconds: n(5)));
}

/// The instants of the EXDATE and RDATE values written for an event in [zone].
({List<DateTime> exdates, List<DateTime> rdates}) _written(List<String> properties, String zone) {
  final exdates = <DateTime>[], rdates = <DateTime>[];
  for (final line in properties) {
    final values = line
        .substring(line.indexOf(':') + 1)
        .split(',')
        .map((v) => _instant(_parseICal(v.split('/').first), zone));
    (line.startsWith('EXDATE') ? exdates : rdates).addAll(values);
  }
  return (exdates: exdates, rdates: rdates);
}

void main() {
  group('RDATE periods keep their start and end instants', () {
    final random = Random(_seed);
    for (var i = 0; i < _runs; i++) {
      // Starts around the time changes of March and of October/November
      // 2025, on whole minutes; ends up to three days later.
      final from = random.nextBool() ? DateTime.utc(2025, 3, 7) : DateTime.utc(2025, 10, 20);
      final start = from.add(Duration(minutes: random.nextInt(25 * 24 * 60)));
      final source = zoneNames[random.nextInt(zoneNames.length)];
      final eventZone = zoneNames[random.nextInt(zoneNames.length)];
      final utc = source == 'Etc/UTC';
      // The end: an explicit one, or a duration of days (added on the wall
      // clock of the source zone, RFC 5545 section 3.3.6) and exact time.
      final days = random.nextInt(3);
      final exact = random.nextInt(24 * 60) * 60;
      final useDuration = random.nextBool();
      final explicitEnd = start.add(Duration(minutes: random.nextInt(3 * 24 * 60)));
      final sw = _wall(start, source);
      final end = useDuration
          ? _instant(sw.add(Duration(days: days)), source).add(Duration(seconds: exact))
          : explicitEnd;
      final ew = _wall(end, source);
      // A wall clock that does not name its instant cannot be written: leave it out.
      if (_instant(sw, source) != start || (!useDuration && _instant(ew, source) != end)) continue;
      final value = utc ? _icalUtc(start) : _ical(sw);
      final endValue = useDuration
          ? 'P${days > 0 ? '${days}D' : ''}T${exact ~/ 3600}H${exact % 3600 ~/ 60}M'
          : utc
              ? _icalUtc(end)
              : _ical(ew);
      final line = 'RDATE${utc ? '' : ';TZID=$source'};VALUE=PERIOD:$value/$endValue';
      test('$i: $line in $eventZone', () {
        Map<String, Map<String, Object?>> read() =>
            recurrenceOverridesFromICal([line], timeZone: eventZone, zones: zones, strict: true);
        if (!representable(start, eventZone)) {
          // The second of two equal local times has no recurrence id.
          expect(read, throwsFormatException);
          return;
        }
        final MapEntry(:key, value: patch) = read().entries.single;
        final s = _instant(DateTime.parse('${key}Z'), eventZone);
        expect(_fmt(s), _fmt(start));
        expect(_fmt(_addDuration(s, patch['duration'] as String, eventZone)), _fmt(end));
      });
    }
  });

  group('EXDATE and RDATE sets keep their instants through a round trip', () {
    final random = Random(_seed + 2);
    for (var i = 0; i < _runs ~/ 2; i++) {
      // Values every 30 minutes from 23:00Z to 03:00Z around the hour Zurich
      // repeats (Oct 26, 2025: 00:00Z-00:59Z and 01:00Z-01:59Z are both
      // 02:00-02:59), for an event in Zurich, New York or UTC.
      List<DateTime> pick() {
        final n = random.nextInt(5);
        return {
          for (var k = 0; k < n; k++)
            DateTime.utc(2025, 10, 25, 23).add(Duration(minutes: 30 * random.nextInt(9)))
        }.toList()
          ..sort();
      }

      final rdates = pick(), exdates = pick();
      final zone = zoneNames[random.nextInt(zoneNames.length)];
      if (rdates.isEmpty && exdates.isEmpty) continue;
      final lines = [
        if (rdates.isNotEmpty) 'RDATE:${rdates.map(_icalUtc).join(',')}',
        if (exdates.isNotEmpty) 'EXDATE:${exdates.map(_icalUtc).join(',')}',
      ];
      test('$i: ${lines.join(' ')} in $zone', () {
        // RFC 5545: the added instants are the RDATEs without the EXDATEs.
        final added = rdates.where((r) => !exdates.contains(r)).toList();
        // What a recurrence id cannot name: an added instant, or an excluded
        // one that is not just the removal of an RDATE.
        final lost = [...added, ...exdates.where((e) => !rdates.contains(e))]
            .where((x) => !representable(x, zone));
        final warnings = <String>[];
        final overrides = recurrenceOverridesFromICal(lines,
            timeZone: zone, zones: zones, onWarning: warnings.add);
        expect(warnings.isNotEmpty, lost.isNotEmpty);
        Map<String, Map<String, Object?>> strict(List<String> l) =>
            recurrenceOverridesFromICal(l, timeZone: zone, zones: zones, strict: true);
        if (lost.isNotEmpty) {
          expect(() => strict(lines), throwsFormatException);
        } else {
          expect(strict(lines), overrides);
        }

        // Written back for the event, the lines name these instants:
        final back = recurrenceOverridesToICal(overrides,
            form: ICalDateForm.zoned, timeZone: zone, isOccurrence: (_) => false);
        final got = _written(back.properties, zone);
        // every added instant that has a recurrence id, and no other (an
        // excluded occurrence never comes back);
        expect(got.rdates.map(_fmt), added.where((r) => representable(r, zone)).map(_fmt));
        // every excluded instant that has one, and no other.
        expect(got.exdates.map(_fmt), exdates.where((e) => representable(e, zone)).map(_fmt));
        // And reading those lines gives the same overrides again.
        expect(strict(back.properties), overrides);
      });
    }
  });

  group('recurrence overrides round trip', () {
    final random = Random(_seed + 1);
    const forms = ICalDateForm.values;
    for (var i = 0; i < _runs ~/ 4; i++) {
      final form = forms[i % forms.length];
      final timeZone = switch (form) {
        ICalDateForm.zoned => 'Europe/Zurich',
        ICalDateForm.utc => 'Etc/UTC',
        _ => null,
      };
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
            timeZone: timeZone,
            isOccurrence: (id) => occurrences.contains(_fmt(id)),
            strict: true);
        final first = write(overrides);
        final back = recurrenceOverridesFromICal(first.properties,
            timeZone: timeZone, zones: zones, strict: true);
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

  test('reads 50,000 RDATEs and EXDATEs in linear time', () {
    String values(DateTime from) =>
        [for (var k = 0; k < 25000; k++) _icalUtc(from.add(Duration(hours: 2 * k)))].join(',');
    final lines = ['RDATE:${values(DateTime.utc(2000))}', 'EXDATE:${values(DateTime.utc(2003))}'];
    final watch = Stopwatch()..start();
    final got = recurrenceOverridesFromICal(lines, timeZone: 'Europe/Zurich', zones: zones);
    // A quadratic scan takes minutes here; a linear one well under a second.
    expect(watch.elapsed, lessThan(const Duration(seconds: 5)));
    expect(got.length, greaterThan(25000));
  });
}
