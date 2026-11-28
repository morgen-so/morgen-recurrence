// A small time zone model for the conversion tests (the TypeScript tests
// have the same in test/zones.ts and the harness of jscalendar.test.ts, where
// the 2025 changes are checked against real zone data).
import 'package:morgen_rrule/morgen_rrule.dart';

Duration _offset(String o) =>
    Duration(hours: int.parse(o.substring(1, 3)), minutes: int.parse(o.substring(4, 6))) *
    (o.startsWith('-') ? -1 : 1);

/// Time zones from `offsets`: per zone a fixed UTC offset (`+02:00`), or a
/// list of the offset before the first change and then [UTC instant of a
/// change, offset from then].
TimeZones zonesOf(Map<String, dynamic> offsets) {
  List<(DateTime?, Duration)> changes(String zone) {
    final z = offsets[zone];
    if (z == null) throw StateError('No offset for $zone');
    if (z is String) return [(null, _offset(z))];
    final list = z as List;
    return [
      (null, _offset(list.first as String)),
      for (final c in list.skip(1).cast<List>())
        (DateTime.parse(c[0] as String), _offset(c[1] as String)),
    ];
  }

  Duration offsetAt(String zone, DateTime instant) =>
      changes(zone).lastWhere((c) => c.$1 == null || !instant.isBefore(c.$1!)).$2;

  return TimeZones(
    fromInstant: (instant, zone) => instant.add(offsetAt(zone, instant)),
    // RFC 5545 section 3.3.5: the first of two instants; in a gap, the offset before it.
    toInstant: (wall, zone) {
      final valid = [
        for (final c in changes(zone))
          if (wall.subtract(c.$2).add(offsetAt(zone, wall.subtract(c.$2))) == wall)
            wall.subtract(c.$2)
      ]..sort();
      return valid.isNotEmpty
          ? valid.first
          : wall.subtract(offsetAt(zone, wall.subtract(const Duration(days: 1))));
    },
  );
}

/// The real 2025 changes of two zones.
const zoneNames = ['Europe/Zurich', 'America/New_York', 'Etc/UTC'];
final zones = zonesOf({
  'Europe/Zurich': [
    '+01:00',
    ['2025-03-30T01:00:00Z', '+02:00'],
    ['2025-10-26T01:00:00Z', '+01:00']
  ],
  'America/New_York': [
    '-05:00',
    ['2025-03-09T07:00:00Z', '-04:00'],
    ['2025-11-02T06:00:00Z', '-05:00']
  ],
  'Etc/UTC': '+00:00',
});

/// Whether the event zone's wall clock of [instant] names that instant (not
/// the second of a repeated hour).
bool representable(DateTime instant, String zone) =>
    zones.toInstant(zones.fromInstant(instant, zone), zone) == instant;
