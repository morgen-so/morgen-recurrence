// Conversion between iCalendar (RFC 5545, RFC 7529) recurrence and JSCalendar
// (RFC 8984) recurrence, as draft-ietf-calext-jscalendar-icalendar-31 defines
// it:
//
//  * RRULE <-> RecurrenceRule (section 2.3.33, and the UNTIL remark of 3.2);
//  * EXDATE and RDATE <-> recurrenceOverrides (sections 2.3.18, 2.3.30 and
//    the recurrenceOverrides remark of 3.2).
//
// Same behaviour as packages/ts/src/jscalendar.ts; both run the shared
// fixtures (fixtures/*.json, `jscal`, and fixtures/conversion.json).
//
// Times are floating, as everywhere in this package: DateTime values with
// isUtc=true holding wall-clock fields. Time zones are the caller's: the
// functions take a converter where the draft needs one (an UNTIL in UTC, an
// EXDATE with a TZID).
import 'options.dart';
import 'rrule.dart' show RRule;

/// Converts the wall-clock fields [wallClock] in [timeZone] to the wall clock
/// of the event's time zone (JSCalendar `timeZone`). [timeZone] is a TZID
/// parameter value, or `Etc/UTC` for a value ending in `Z`.
typedef ToEventTime = DateTime Function(DateTime wallClock, String timeZone);

/// Converts the wall-clock fields [wallClock] of the event's time zone to
/// UTC (fields of the UTC instant).
typedef ToUtc = DateTime Function(DateTime wallClock);

/// The form of the iCalendar date-time values of a calendar object
/// (draft section 3.2, after RFC 5545 section 3.3.5):
enum ICalDateForm {
  /// DATE (`20240101`): `showWithoutTime` and no `timeZone`.
  date,

  /// DATE WITH LOCAL TIME (`20240101T090000`): no `timeZone`.
  local,

  /// DATE WITH UTC TIME (`20240101T090000Z`): `timeZone` is `Etc/UTC`.
  utc,

  /// DATE WITH LOCAL TIME AND TIME ZONE REFERENCE (`TZID=…:20240101T090000`).
  zoned,
}

const _days = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const _frequencies = ['yearly', 'monthly', 'weekly', 'daily', 'hourly', 'minutely', 'secondly'];

/// An RFC 5545 RRULE as a JSCalendar RecurrenceRule (draft section 2.3.33).
///
/// [rrule] is what [RRuleOptions.parseString] reads (a value such as
/// `FREQ=WEEKLY;BYDAY=MO`, an `RRULE:` line, with or without a DTSTART line;
/// DTSTART does not belong to the rule and is ignored).
///
/// Each part maps to its property: values in lower case, BYDAY to NDay
/// objects, BYMONTH to strings. Only the parts in [rrule] are set, so
/// `interval` is left out unless INTERVAL is written. UNTIL becomes a
/// LocalDateTime in the event's time zone: a date is that day at midnight, a
/// local time stays as written, and a UTC time goes through [toEventTime]
/// (called with `Etc/UTC`; without it the UTC fields are kept, which is right
/// for events in UTC or without a time zone).
///
/// The result is a literal mapping, as the draft defines. Evaluated as
/// JSCalendar, a few rules then have other occurrences than rrule.js gives the
/// RRULE, because RFC 8984 section 4.3.3.1 (step 3) adds properties RFC 5545
/// implementations do not, e.g. `FREQ=YEARLY;BYMONTHDAY=15` is the 15th of
/// every month for rrule.js but only of the start month in JSCalendar. With
/// [keepRRuleMeaning], properties are added so that the JSCalendar rule has
/// the rrule.js occurrences (here `byMonth` "1" to "12"); see
/// [rruleMeaningInJsCalendar].
///
/// Throws [FormatException] for an RRULE [RRuleOptions.parseString] rejects,
/// one without FREQ, values outside RFC 5545's ranges, INTERVAL=0, or an
/// impossible UNTIL date. COUNT and UNTIL together (which RFC 5545 forbids) are both kept.
Map<String, Object?> rruleToJsCalendar(String rrule,
    {ToEventTime? toEventTime, bool keepRRuleMeaning = false}) {
  final (:parts, start: _) = parseRRuleParts(rrule, dtstart: DateTime.utc(2000));
  if (!parts.containsKey('FREQ')) throw FormatException('RRULE without FREQ: $rrule');
  final o = RRuleOptions.parse([for (final e in parts.entries) '${e.key}=${e.value}'].join(';'),
      dtstart: DateTime.utc(2000));
  try {
    RRule(o);
  } on ArgumentError catch (e) {
    throw FormatException('${e.message}: ${e.invalidValue}');
  }
  // RFC 8984: interval >= 1 (rrule.js takes INTERVAL=0 and repeats nothing).
  if (o.interval < 1) throw FormatException('INTERVAL must be at least 1: $rrule');
  final rule = <String, Object?>{
    '@type': 'RecurrenceRule',
    'frequency': o.freq.name,
    if (parts.containsKey('INTERVAL')) 'interval': o.interval,
    if (parts.containsKey('RSCALE')) 'rscale': parts['RSCALE']!.toLowerCase(),
    if (parts.containsKey('SKIP')) 'skip': o.skip.name,
    if (o.wkst != null) 'firstDayOfWeek': _days[o.wkst!.weekday],
    if (o.byweekday != null)
      'byDay': [
        for (final w in o.byweekday!)
          {'@type': 'NDay', 'day': _days[w.weekday], if (w.n != null) 'nthOfPeriod': w.n},
      ],
    if (o.bymonthday != null) 'byMonthDay': o.bymonthday,
    if (o.bymonth != null) 'byMonth': [for (final m in o.bymonth!) '$m'],
    if (o.byyearday != null) 'byYearDay': o.byyearday,
    if (o.byweekno != null) 'byWeekNo': o.byweekno,
    if (o.byhour != null) 'byHour': o.byhour,
    if (o.byminute != null) 'byMinute': o.byminute,
    if (o.bysecond != null) 'bySecond': o.bysecond,
    if (o.bysetpos != null) 'bySetPosition': o.bysetpos,
    if (o.count != null) 'count': o.count,
    if (parts['UNTIL'] case final until?) 'until': _untilToJs(until, toEventTime),
  };
  return keepRRuleMeaning ? rruleMeaningInJsCalendar(rule) : rule;
}

/// A copy of the JSCalendar [rule] (a literal mapping of an RRULE) with the
/// properties that give it, under RFC 8984 semantics, the occurrences rrule.js
/// gives the RRULE. Without them, RFC 8984 section 4.3.3.1 (step 3) would add
/// a start-dependent value that RFC 5545 implementations do not add:
///
///  * yearly, with `byMonthDay` but no `byMonth`, `byWeekNo` or `byYearDay`:
///    `byMonth` "1" to "12" (JSCalendar would add the start month);
///  * yearly with `byWeekNo` (no `byYearDay`), and monthly with `byYearDay` or
///    `byWeekNo`, without `byDay` or `byMonthDay`; weekly with `byMonthDay`,
///    `byYearDay` or `byWeekNo` but no `byDay`: `byDay` with all seven days
///    (JSCalendar would add the start weekday or day of the month);
///  * `nthOfPeriod` is dropped from `byDay` unless the frequency is monthly or
///    yearly: rrule.js ignores it there (RFC 5545 forbids it), JSCalendar
///    would count it within the month.
///
/// The properties are start-independent, so the result is the same for every
/// start. Other rules are returned unchanged (as a copy).
///
/// One kind of rule has no JSCalendar form with the rrule.js occurrences and
/// stays as it is: yearly, with `byMonthDay`, no `byMonth`, `byWeekNo` or
/// `byYearDay`, and a `byDay` with `nthOfPeriod`. Adding `byMonth` would turn
/// "the 3rd Tuesday of the year" into "of each month".
Map<String, Object?> rruleMeaningInJsCalendar(Map<String, Object?> rule) {
  final r = Map<String, Object?>.of(rule);
  bool has(String k) => r[k] is List && (r[k] as List).isNotEmpty;
  final allDays = [
    for (final d in _days) {'@type': 'NDay', 'day': d}
  ];
  final freq = r['frequency'];
  if (freq != 'monthly' && freq != 'yearly' && has('byDay')) {
    r['byDay'] = [
      for (final d in r['byDay'] as List)
        {
          for (final e in (d as Map).entries)
            if (e.key != 'nthOfPeriod') e.key: e.value
        }
    ];
  }
  switch (freq) {
    case 'weekly':
      if (!has('byDay') && (has('byMonthDay') || has('byYearDay') || has('byWeekNo'))) {
        r['byDay'] = allDays;
      }
    case 'monthly':
      if (!has('byDay') && !has('byMonthDay') && (has('byYearDay') || has('byWeekNo'))) {
        r['byDay'] = allDays;
      }
    case 'yearly':
      if (!has('byYearDay')) {
        final nth =
            has('byDay') && (r['byDay'] as List).any((d) => d is Map && d['nthOfPeriod'] != null);
        if (!has('byMonth') && !has('byWeekNo') && has('byMonthDay') && !nth) {
          r['byMonth'] = [for (var m = 1; m <= 12; m++) '$m'];
        }
        if (has('byWeekNo') && !has('byMonthDay') && !has('byDay')) r['byDay'] = allDays;
      }
  }
  return r;
}

/// A JSCalendar RecurrenceRule as an RFC 5545 RRULE value (without the
/// `RRULE:` prefix), as the draft maps it back (section 2.3.33 and the UNTIL
/// remark of section 3.2).
///
/// Parts are written in a fixed order (FREQ first) in upper case. INTERVAL is
/// left out when it is 1, and RSCALE=GREGORIAN is added when only `skip` is
/// set, since RFC 7529 allows SKIP only with RSCALE. `until` is written in
/// [untilForm], the form of the event's DTSTART: a date (its date part), a
/// local time, a UTC time (the wall clock of an event in `Etc/UTC`), or, for
/// an event with a time zone, the UTC instant that [toUtc] gives (required
/// then, as RFC 5545 requires UTC with a TZID start).
///
/// With [keepJsCalendarMeaning], the RRULE gets the properties RFC 8984
/// section 4.3.3.1 (step 3) implicitly adds for [start] (required then), so
/// that rrule.js gives the JSCalendar occurrences: e.g. a yearly rule with
/// only `byMonthDay` gets BYMONTH with the start month.
///
/// Throws [FormatException] for a rule that is not a valid RecurrenceRule:
/// an unknown frequency or day, a value out of range, a malformed `until`.
/// Empty arrays count as absent; other unknown members are ignored.
String jsCalendarToRRule(Map<String, Object?> rule,
    {ICalDateForm untilForm = ICalDateForm.local,
    ToUtc? toUtc,
    DateTime? start,
    bool keepJsCalendarMeaning = false}) {
  final r = _checkRule(rule);
  if (keepJsCalendarMeaning) {
    if (start == null) throw ArgumentError('keepJsCalendarMeaning needs the start');
    _addImplicitProperties(r, start);
  }
  final parts = <String>['FREQ=${(r['frequency'] as String).toUpperCase()}'];
  void add(String name, String key) {
    final v = r[key];
    if (v is List && v.isNotEmpty) parts.add('$name=${v.join(',')}');
  }

  final interval = r['interval'] as int?;
  if (interval != null && interval != 1) parts.add('INTERVAL=$interval');
  if (r['count'] != null) parts.add('COUNT=${r['count']}');
  if (r['until'] case final String until) {
    parts.add('UNTIL=${_untilToICal(until, untilForm, toUtc)}');
  }
  add('BYMONTH', 'byMonth');
  add('BYWEEKNO', 'byWeekNo');
  add('BYYEARDAY', 'byYearDay');
  add('BYMONTHDAY', 'byMonthDay');
  if (r['byDay'] case final List days when days.isNotEmpty) {
    parts.add('BYDAY=${[
      for (final d in days.cast<Map>())
        '${d['nthOfPeriod'] ?? ''}${(d['day'] as String).toUpperCase()}'
    ].join(',')}');
  }
  add('BYHOUR', 'byHour');
  add('BYMINUTE', 'byMinute');
  add('BYSECOND', 'bySecond');
  add('BYSETPOS', 'bySetPosition');
  if (r['firstDayOfWeek'] case final String d) parts.add('WKST=${d.toUpperCase()}');
  final rscale = r['rscale'] as String?, skip = r['skip'] as String?;
  if (rscale != null || skip != null) parts.add('RSCALE=${(rscale ?? 'gregorian').toUpperCase()}');
  if (skip != null) parts.add('SKIP=${skip.toUpperCase()}');
  return parts.join(';');
}

/// RFC 8984 section 4.3.3.1 step 3, the date parts (the time parts are what
/// RFC 5545 implementations add too). Same as tools/lib/jscal.mjs and
/// RRuleOptions.fromJsCalendar.
void _addImplicitProperties(Map<String, Object?> r, DateTime start) {
  bool has(String k) => r[k] is List && (r[k] as List).isNotEmpty;
  final day = _days[start.weekday - 1];
  final hadByDay = has('byDay'), hadByMonthDay = has('byMonthDay');
  switch (r['frequency']) {
    case 'weekly':
      if (!hadByDay)
        r['byDay'] = [
          {'@type': 'NDay', 'day': day}
        ];
    case 'monthly':
      if (!hadByDay && !hadByMonthDay) r['byMonthDay'] = [start.day];
    case 'yearly':
      if (!has('byYearDay')) {
        if (!has('byMonth') && !has('byWeekNo') && (hadByMonthDay || !hadByDay)) {
          r['byMonth'] = ['${start.month}'];
        }
        if (!hadByMonthDay && !has('byWeekNo') && !hadByDay) r['byMonthDay'] = [start.day];
        if (has('byWeekNo') && !hadByMonthDay && !hadByDay) {
          r['byDay'] = [
            {'@type': 'NDay', 'day': day}
          ];
        }
      }
  }
}

/// A checked copy of a RecurrenceRule: types and ranges of RFC 8984 section
/// 4.3.3, lower-case strings; empty arrays dropped.
Map<String, Object?> _checkRule(Map<String, Object?> rule) {
  Never fail(String what) => throw FormatException('Invalid RecurrenceRule $what: $rule');
  final type = rule['@type'];
  if (type != null && type != 'RecurrenceRule') fail('@type');
  final frequency = rule['frequency'];
  if (frequency is! String || !_frequencies.contains(frequency)) fail('frequency');
  final r = <String, Object?>{'frequency': frequency};

  int integer(String key, {int min = 0}) {
    final v = rule[key];
    if (v is! int || v < min) fail(key);
    return v;
  }

  List<int>? ints(String key, int max, {bool signed = false, int min = 1}) {
    final v = rule[key];
    if (v == null) return null;
    if (v is! List) fail(key);
    if (v.isEmpty) return null;
    return [
      for (final e in v)
        if (e is int &&
            (signed ? e != 0 && e.abs() >= min && e.abs() <= max : e >= min && e <= max))
          e
        else
          fail(key)
    ];
  }

  if (rule['interval'] != null) r['interval'] = integer('interval', min: 1);
  if (rule['count'] != null) r['count'] = integer('count');
  if (rule['until'] != null) {
    final until = rule['until'];
    if (until is! String || _localDateTime(until) == null) fail('until');
    r['until'] = until;
  }
  if (rule['rscale'] != null) {
    final v = rule['rscale'];
    if (v is! String || !RegExp(r'^[a-z0-9-]+$', caseSensitive: false).hasMatch(v)) {
      fail('rscale');
    }
    r['rscale'] = v.toLowerCase();
  }
  if (rule['skip'] != null) {
    final v = rule['skip'];
    if (v is! String || !const ['omit', 'backward', 'forward'].contains(v)) fail('skip');
    r['skip'] = v;
  }
  if (rule['firstDayOfWeek'] != null) {
    final v = rule['firstDayOfWeek'];
    if (v is! String || !_days.contains(v)) fail('firstDayOfWeek');
    r['firstDayOfWeek'] = v;
  }
  if (rule['byDay'] case final Object v) {
    if (v is! List) fail('byDay');
    if (v.isNotEmpty) {
      r['byDay'] = [
        for (final d in v)
          if (d is Map &&
              (d['@type'] == null || d['@type'] == 'NDay') &&
              _days.contains(d['day']) &&
              (d['nthOfPeriod'] == null ||
                  (d['nthOfPeriod'] is int &&
                      d['nthOfPeriod'] != 0 &&
                      (d['nthOfPeriod'] as int).abs() <= 53)))
            {'day': d['day'], if (d['nthOfPeriod'] != null) 'nthOfPeriod': d['nthOfPeriod']}
          else
            fail('byDay'),
      ];
    }
  }
  if (rule['byMonth'] case final Object v) {
    if (v is! List) fail('byMonth');
    if (v.isNotEmpty) {
      r['byMonth'] = [
        for (final m in v)
          if (m is int && m >= 1)
            '$m'
          else if (m is String && RegExp(r'^[1-9]\d*L?$').hasMatch(m))
            m
          else
            fail('byMonth')
      ];
    }
  }
  r['byMonthDay'] = ints('byMonthDay', 31, signed: true);
  r['byYearDay'] = ints('byYearDay', 366, signed: true);
  r['byWeekNo'] = ints('byWeekNo', 53, signed: true);
  r['byHour'] = ints('byHour', 23, min: 0);
  r['byMinute'] = ints('byMinute', 59, min: 0);
  r['bySecond'] = ints('bySecond', 60, min: 0);
  r['bySetPosition'] = ints('bySetPosition', 366, signed: true);
  r.removeWhere((_, v) => v == null);
  return r;
}

final _icalDateTime = RegExp(r'^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$');

/// An iCalendar DATE or DATE-TIME: its floating fields and whether it ended
/// in `Z` / was a date. Impossible dates throw; second 60 is 59.
({DateTime value, bool utc, bool date}) _icalValue(String s) {
  final m = _icalDateTime.firstMatch(s);
  if (m == null) throw FormatException('Invalid date-time: $s');
  int g(int i) => int.parse(m.group(i) ?? '0');
  final second = g(6) == 60 ? 59 : g(6);
  final d = DateTime.utc(g(1), g(2), g(3), g(4), g(5), second);
  if (d.year != g(1) || d.month != g(2) || d.day != g(3) || d.hour != g(4) || d.minute != g(5)) {
    throw FormatException('Impossible date-time: $s');
  }
  return (value: d, utc: m.group(7) != null, date: m.group(4) == null);
}

/// A JSCalendar LocalDateTime (`2024-01-31T09:00:00`), or null.
DateTime? _localDateTime(String s) {
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$').firstMatch(s);
  if (m == null) return null;
  int g(int i) => int.parse(m.group(i)!);
  final d = DateTime.utc(g(1), g(2), g(3), g(4), g(5), g(6));
  return d.year == g(1) &&
          d.month == g(2) &&
          d.day == g(3) &&
          d.hour == g(4) &&
          d.minute == g(5) &&
          d.second == g(6)
      ? d
      : null;
}

String _two(int n) => n.toString().padLeft(2, '0');

String _formatLocal(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${_two(d.month)}-'
    '${_two(d.day)}T${_two(d.hour)}:${_two(d.minute)}:${_two(d.second)}';

String _formatICal(DateTime d, {bool date = false, bool utc = false}) {
  final day = '${d.year.toString().padLeft(4, '0')}${_two(d.month)}${_two(d.day)}';
  return date ? day : '${day}T${_two(d.hour)}${_two(d.minute)}${_two(d.second)}${utc ? 'Z' : ''}';
}

String _untilToJs(String until, ToEventTime? toEventTime) {
  final v = _icalValue(until);
  return _formatLocal(v.utc && toEventTime != null ? toEventTime(v.value, 'Etc/UTC') : v.value);
}

String _untilToICal(String until, ICalDateForm form, ToUtc? toUtc) {
  final d = _localDateTime(until)!;
  return switch (form) {
    ICalDateForm.date => _formatICal(d, date: true),
    ICalDateForm.local => _formatICal(d),
    ICalDateForm.utc => _formatICal(d, utc: true),
    ICalDateForm.zoned => toUtc == null
        ? throw ArgumentError('An UNTIL in a time zone needs toUtc')
        : _formatICal(toUtc(d), utc: true),
  };
}

/// iCalendar EXDATE and RDATE properties as JSCalendar `recurrenceOverrides`
/// (draft sections 2.3.18 and 2.3.30).
///
/// [properties] are property lines such as
/// `EXDATE;TZID=Europe/Berlin:20240102T090000,20240103T090000`,
/// `RDATE;VALUE=DATE:20240105` or `RDATE;VALUE=PERIOD:20231223T150000Z/PT2H`
/// (several per string, folded or not; other properties are rejected).
///
/// Each value becomes a key, a LocalDateTime in the event's time zone: a date
/// is that day at midnight, a local time stays as written, and a UTC time or
/// one with a TZID goes through [toEventTime] (without it, the fields are
/// kept, which is right when they are already in the event's zone). An EXDATE
/// maps to `{"excluded": true}`, an RDATE to `{}`, or to `{"duration": …}`
/// for a PERIOD (an explicit end becomes the duration between the two wall
/// clocks). An EXDATE wins over an RDATE for the same key, as it excludes
/// RDATEs too (RFC 5545 section 3.8.5.1).
///
/// Throws [FormatException] for malformed or impossible values.
Map<String, Map<String, Object?>> recurrenceOverridesFromICal(Iterable<String> properties,
    {ToEventTime? toEventTime}) {
  final rdates = <String, Map<String, Object?>>{}, exdates = <String>{};
  for (final text in properties) {
    for (final line in text.replaceAll(RegExp(r'\r?\n[ \t]'), '').split(RegExp(r'\r?\n'))) {
      if (line.trim().isEmpty) continue;
      final (:name, :params, :value) = _property(line.trim());
      if (name != 'EXDATE' && name != 'RDATE') {
        throw FormatException('Not an EXDATE or RDATE: $line');
      }
      final type = params['VALUE']?.toUpperCase();
      final tzid = params['TZID'];
      if (type != null && !const ['DATE', 'DATE-TIME', 'PERIOD'].contains(type) ||
          type == 'PERIOD' && name == 'EXDATE') {
        throw FormatException('Unsupported VALUE=$type in $line');
      }
      String key(String s) {
        final v = _icalValue(s);
        if (type == 'DATE' && !v.date || type == 'DATE-TIME' && v.date) {
          throw FormatException('Value $s is not VALUE=$type');
        }
        final zone = v.utc ? 'Etc/UTC' : (v.date ? null : tzid);
        return _formatLocal(
            zone != null && toEventTime != null ? toEventTime(v.value, zone) : v.value);
      }

      for (final item in value.split(',')) {
        if (name == 'EXDATE') {
          exdates.add(key(item));
        } else if (type == 'PERIOD') {
          final slash = item.indexOf('/');
          if (slash < 0) throw FormatException('Invalid PERIOD: $item');
          final start = item.substring(0, slash), end = item.substring(slash + 1);
          final duration = end.startsWith('P') || end.startsWith('+P')
              ? _checkDuration(end.replaceFirst('+', ''))
              : _durationBetween(_icalValue(start).value, _icalValue(end).value);
          rdates[key(start)] = {'duration': duration};
        } else {
          rdates[key(item)] = {};
        }
      }
    }
  }
  return {
    for (final k in ({...rdates.keys, ...exdates}.toList()..sort()))
      k: exdates.contains(k) ? {'excluded': true} : rdates[k]!,
  };
}

/// The EXDATE and RDATE properties of JSCalendar `recurrenceOverrides`, and
/// the overrides they cannot hold (draft section 3.2, `recurrenceOverrides`
/// remark).
class ICalRecurrenceDates {
  /// Property lines: one EXDATE, one RDATE, one RDATE;VALUE=PERIOD, each only
  /// when needed, with the values in key order.
  final List<String> properties;

  /// Recurrence ids whose patch changes the occurrence: they belong in a
  /// recurrence override component (a VEVENT with RECURRENCE-ID), which is
  /// the caller's.
  final List<String> overrides;

  const ICalRecurrenceDates(this.properties, this.overrides);
}

/// JSCalendar `recurrenceOverrides` as EXDATE and RDATE properties (draft
/// section 3.2): an `excluded` patch is an EXDATE; a recurrence id that the
/// rule does not generate is an RDATE (a PERIOD when the patch only sets
/// `duration`); any other patch is left to [ICalRecurrenceDates.overrides].
///
/// Without [isOccurrence] (whether the rule generates a recurrence id), an
/// empty or duration-only patch counts as an RDATE and every other patch as
/// an override. Values are written in [form] (the event's DTSTART form; with
/// [ICalDateForm.zoned], a TZID parameter of [timeZone]). With
/// [ICalDateForm.date] the keys must be at midnight, and a duration cannot be
/// written: such an RDATE is also listed in the overrides.
///
/// Throws [FormatException] for a key that is not a LocalDateTime.
ICalRecurrenceDates recurrenceOverridesToICal(Map<String, Object?> overrides,
    {ICalDateForm form = ICalDateForm.local,
    String? timeZone,
    bool Function(DateTime recurrenceId)? isOccurrence}) {
  if (form == ICalDateForm.zoned && (timeZone == null || timeZone.isEmpty)) {
    throw ArgumentError('ICalDateForm.zoned needs the time zone');
  }
  final exdates = <String>[], rdates = <String>[], periods = <String>[], rest = <String>[];
  for (final key in overrides.keys.toList()..sort()) {
    final id = _localDateTime(key);
    if (id == null) throw FormatException('Invalid recurrence id: $key');
    if (form == ICalDateForm.date && (id.hour != 0 || id.minute != 0 || id.second != 0)) {
      throw FormatException('A date-only recurrence id must be at midnight: $key');
    }
    final value = _formatICal(id, date: form == ICalDateForm.date, utc: form == ICalDateForm.utc);
    final patch = overrides[key];
    if (patch is! Map) throw FormatException('Invalid patch for $key: $patch');
    if (patch['excluded'] == true) {
      exdates.add(value);
      continue;
    }
    final durationOnly = patch.keys.every((k) => k == 'duration');
    final generated = isOccurrence?.call(id);
    if (generated == null ? durationOnly : !generated) {
      final duration = patch['duration'];
      final period = durationOnly && duration is String && form != ICalDateForm.date;
      if (period) {
        periods.add('$value/${_checkDuration(duration)}');
      } else {
        rdates.add(value);
      }
      // What the RDATE does not hold goes to an override component.
      if (!(patch.isEmpty || period)) rest.add(key);
    } else if (patch.isNotEmpty) {
      rest.add(key);
    }
  }
  final params = switch (form) {
    ICalDateForm.date => ';VALUE=DATE',
    ICalDateForm.zoned => ';TZID=${_paramValue(timeZone!)}',
    _ => '',
  };
  final zone = form == ICalDateForm.zoned ? params : '';
  return ICalRecurrenceDates([
    if (exdates.isNotEmpty) 'EXDATE$params:${exdates.join(',')}',
    if (rdates.isNotEmpty) 'RDATE$params:${rdates.join(',')}',
    if (periods.isNotEmpty) 'RDATE;VALUE=PERIOD$zone:${periods.join(',')}',
  ], {...rest}.toList());
}

/// A parameter value, quoted when it contains `;`, `:` or `,`.
String _paramValue(String v) => RegExp(r'[;:,]').hasMatch(v) ? '"$v"' : v;

/// Name, parameters (upper-case names, unquoted values) and value of a
/// content line; quoted parameter values may contain `;`, `:` and `,`.
({String name, Map<String, String> params, String value}) _property(String line) {
  var inQuotes = false, colon = -1;
  for (var i = 0; i < line.length && colon < 0; i++) {
    if (line[i] == '"') inQuotes = !inQuotes;
    if (line[i] == ':' && !inQuotes) colon = i;
  }
  if (colon < 0) throw FormatException('Invalid property: $line');
  final head = line.substring(0, colon);
  final name = RegExp(r'^[A-Za-z0-9-]+').firstMatch(head)?.group(0)?.toUpperCase();
  if (name == null) throw FormatException('Invalid property: $line');
  final params = <String, String>{};
  final rest = head.substring(name.length);
  final param = RegExp(r';([A-Za-z0-9-]+)=((?:"[^"]*"|[^;:,"]*)(?:,(?:"[^"]*"|[^;:,"]*))*)');
  var at = 0;
  for (final m in param.allMatches(rest)) {
    if (m.start != at) throw FormatException('Invalid parameters: $line');
    params[m.group(1)!.toUpperCase()] = m.group(2)!.replaceAll('"', '');
    at = m.end;
  }
  if (at != rest.length) throw FormatException('Invalid parameters: $line');
  return (name: name, params: params, value: line.substring(colon + 1));
}

final _duration = RegExp(r'^P(?:\d+W|(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$');

String _checkDuration(String d) =>
    _duration.hasMatch(d) ? d : throw FormatException('Invalid duration: $d');

/// The duration from [a] to [b] (wall clocks), e.g. `PT2H` or `P1DT30M`.
String _durationBetween(DateTime a, DateTime b) {
  var s = b.difference(a).inSeconds;
  if (s < 0) throw FormatException('PERIOD ends before it starts: $a/$b');
  final days = s ~/ 86400;
  s %= 86400;
  final h = s ~/ 3600, m = s % 3600 ~/ 60, sec = s % 60;
  final time = '${h > 0 ? '${h}H' : ''}${m > 0 ? '${m}M' : ''}${sec > 0 ? '${sec}S' : ''}';
  if (days == 0 && time.isEmpty) return 'PT0S';
  return 'P${days > 0 ? '${days}D' : ''}${time.isEmpty ? '' : 'T$time'}';
}
