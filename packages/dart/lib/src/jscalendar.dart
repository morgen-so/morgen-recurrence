// Conversion between iCalendar (RFC 5545, RFC 7529) recurrence and JSCalendar
// (RFC 8984) recurrence, as draft-ietf-calext-jscalendar-icalendar-31 defines
// it:
//
//  * RRULE <-> RecurrenceRule (section 2.3.33, and the UNTIL remark of 3.2);
//  * EXDATE and RDATE <-> recurrenceOverrides (sections 2.3.18, 2.3.30 and
//    the recurrenceOverrides remark of 3.2);
//  * a whole recurrence (RRULE, EXRULE, EXDATE, RDATE lines) <->
//    recurrenceRules, excludedRecurrenceRules and recurrenceOverrides.
//
// Same behaviour as packages/ts/src/jscalendar.ts; both run the shared
// fixtures (fixtures/*.json, `jscal`, and fixtures/conversion/).
//
// Times are floating, as everywhere in this package: DateTime values with
// isUtc=true holding wall-clock fields. Time zones are the caller's: the
// functions take a converter where the draft needs one (an UNTIL in UTC, an
// EXDATE with a TZID).
//
// Lenient by default: data from calendar providers is converted as well as it
// can be. What cannot be read (an unknown or malformed part, a value out of
// range) is left out and reported to `onWarning`, and an impossible date is
// moved to the next valid one (as rrule.js does). Only a rule without a
// readable frequency gives null. With `strict: true`, the same problems throw
// a FormatException instead.
import 'options.dart';
import 'rrule.dart' show RRule;

/// Converts the wall-clock fields [wallClock] in [timeZone] to the wall clock
/// of the event's time zone (JSCalendar `timeZone`). [timeZone] is a TZID
/// parameter value, or `Etc/UTC` for a value ending in `Z`.
typedef ToEventTime = DateTime Function(DateTime wallClock, String timeZone);

/// Converts the wall-clock fields [wallClock] of the event's time zone to
/// UTC (fields of the UTC instant).
typedef ToUtc = DateTime Function(DateTime wallClock);

/// Receives what lenient conversion left out or changed.
typedef OnWarning = void Function(String message);

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
const _rfcDays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const _frequencies = ['yearly', 'monthly', 'weekly', 'daily', 'hourly', 'minutely', 'secondly'];

/// Reports a problem: throws in strict mode, warns otherwise.
class _Issues {
  final bool strict;
  final OnWarning? onWarning;
  const _Issues(this.strict, this.onWarning);
  void call(String message) {
    if (strict) throw FormatException(message);
    onWarning?.call(message);
  }
}

/// A date-time as read: floating fields, and whether it was UTC (`Z` or an
/// offset, converted to UTC) or a date.
typedef _Time = ({DateTime value, bool utc, bool date});

/// The parts of a rule, typed.
class _Rule {
  String freq = 'yearly';
  int? interval, count;
  _Time? until;
  int? wkst;
  List<({int day, int? n})>? byDay;
  List<int>? byMonthDay, byYearDay, byWeekNo, byHour, byMinute, bySecond, bySetPos;
  List<String>? byMonth;
  String? rscale, skip;
}

// ---------------------------------------------------------------------------
// RRULE -> RecurrenceRule.

/// An RFC 5545 RRULE as a JSCalendar RecurrenceRule (draft section 2.3.33).
///
/// [rrule] is a rule value such as `FREQ=WEEKLY;BYDAY=MO`, an `RRULE:` or
/// `EXRULE:` line, with or without a DTSTART line (DTSTART does not belong to
/// the rule and is ignored).
///
/// Each part maps to its property: values in lower case, BYDAY to NDay
/// objects, BYMONTH to strings. Only the parts in [rrule] are set, so
/// `interval` is left out unless INTERVAL is written, or [alwaysSetInterval]
/// is set (Morgen's event schema requires it). UNTIL becomes a LocalDateTime
/// in the event's time zone: a date is that day at midnight, a local time
/// stays as written, and a UTC time goes through [toEventTime] (called with
/// `Etc/UTC`; without it the UTC fields are kept, which is right for events in
/// UTC or without a time zone).
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
/// Lenient by default: unknown parts (such as `X-` extensions), malformed or
/// out-of-range values and an INTERVAL below 1 are left out (reported to
/// [onWarning]); an impossible UNTIL date moves to the next valid one; UNTIL
/// may have fractional seconds or an offset; names and values may be in any
/// case. Returns null only without a readable FREQ. With [strict], the rule
/// must be what [RRuleOptions.parseString] accepts, with FREQ, within RFC 5545's
/// ranges and INTERVAL >= 1, or a [FormatException] is thrown. COUNT and
/// UNTIL together (which RFC 5545 forbids) are both kept either way.
Map<String, Object?>? rruleToJsCalendar(String rrule,
    {ToEventTime? toEventTime,
    bool keepRRuleMeaning = false,
    bool alwaysSetInterval = false,
    bool strict = false,
    OnWarning? onWarning}) {
  final rule = strict ? _strictRule(rrule) : _lenientRule(rrule, _Issues(false, onWarning));
  if (rule == null) return null;
  final until = rule.until;
  final js = <String, Object?>{
    '@type': 'RecurrenceRule',
    'frequency': rule.freq,
    if (rule.interval != null || alwaysSetInterval) 'interval': rule.interval ?? 1,
    if (rule.rscale != null) 'rscale': rule.rscale,
    if (rule.skip != null) 'skip': rule.skip,
    if (rule.wkst != null) 'firstDayOfWeek': _days[rule.wkst!],
    if (rule.byDay != null)
      'byDay': [
        for (final d in rule.byDay!)
          {'@type': 'NDay', 'day': _days[d.day], if (d.n != null) 'nthOfPeriod': d.n},
      ],
    if (rule.byMonthDay != null) 'byMonthDay': rule.byMonthDay,
    if (rule.byMonth != null) 'byMonth': rule.byMonth,
    if (rule.byYearDay != null) 'byYearDay': rule.byYearDay,
    if (rule.byWeekNo != null) 'byWeekNo': rule.byWeekNo,
    if (rule.byHour != null) 'byHour': rule.byHour,
    if (rule.byMinute != null) 'byMinute': rule.byMinute,
    if (rule.bySecond != null) 'bySecond': rule.bySecond,
    if (rule.bySetPos != null) 'bySetPosition': rule.bySetPos,
    if (rule.count != null) 'count': rule.count,
    if (until != null)
      'until': _formatLocal(
          until.utc && toEventTime != null ? toEventTime(until.value, 'Etc/UTC') : until.value),
  };
  return keepRRuleMeaning ? rruleMeaningInJsCalendar(js) : js;
}

/// The strict reading: [RRuleOptions.parseString]'s rules, FREQ required,
/// RFC 5545's ranges, INTERVAL >= 1.
_Rule _strictRule(String rrule) {
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
  return _Rule()
    ..freq = o.freq.name
    ..interval = parts.containsKey('INTERVAL') ? o.interval : null
    ..rscale = parts['RSCALE']?.toLowerCase()
    ..skip = parts.containsKey('SKIP') ? o.skip.name : null
    ..wkst = o.wkst?.weekday
    ..byDay = o.byweekday == null ? null : [for (final w in o.byweekday!) (day: w.weekday, n: w.n)]
    ..byMonthDay = o.bymonthday
    ..byMonth = o.bymonth == null ? null : [for (final m in o.bymonth!) '$m']
    ..byYearDay = o.byyearday
    ..byWeekNo = o.byweekno
    ..byHour = o.byhour
    ..byMinute = o.byminute
    ..bySecond = o.bysecond
    ..bySetPos = o.bysetpos
    ..count = o.count
    ..until = parts['UNTIL'] == null ? null : _icalValue(parts['UNTIL']!);
}

/// The lenient reading: every part that can be read, the rest reported.
_Rule? _lenientRule(String rrule, _Issues issue) {
  final parts = <String, String>{};
  for (final line in _lines(rrule)) {
    final header = RegExp(r'^([A-Za-z-]+)\s*[:;]').firstMatch(line)?.group(1)?.toUpperCase();
    if (header == 'DTSTART') continue;
    if (header != null && header != 'RRULE' && header != 'EXRULE') {
      issue('Ignored $header in a recurrence rule: $line');
      continue;
    }
    var body = line.replaceFirst(RegExp(r'^(?:RRULE|EXRULE)\s*:', caseSensitive: false), '');
    body = body.replaceAll(
        RegExp(r'(?<=^|;)\s*DTSTART(?:;[^:=]*)?[:=][^;]*', caseSensitive: false), '');
    for (final raw in body.split(';')) {
      final attr = raw.trim();
      if (attr.isEmpty) continue;
      final eq = attr.indexOf('=');
      if (eq <= 0) {
        issue('Ignored malformed RRULE part "$attr"');
        continue;
      }
      var key = attr.substring(0, eq).trim().toUpperCase();
      if (key == 'BYWEEKDAY') key = 'BYDAY';
      parts[key] = attr.substring(eq + 1).trim();
    }
  }
  final freq = parts['FREQ']?.toLowerCase();
  if (freq == null || !_frequencies.contains(freq)) {
    issue(freq == null ? 'RRULE without FREQ: $rrule' : 'Unknown FREQ in RRULE: $rrule');
    return null;
  }
  final rule = _Rule()..freq = freq;
  final rscale = parts['RSCALE']?.toLowerCase();
  if (rscale != null) {
    if (RegExp(r'^[a-z0-9-]+$').hasMatch(rscale)) {
      rule.rscale = rscale;
    } else {
      issue('Ignored RSCALE=${parts['RSCALE']}');
    }
  }
  int? integer(String key, int min) {
    final v = parts[key];
    if (v == null) return null;
    final n = RegExp(r'^[+]?\d+$').hasMatch(v) ? int.parse(v.replaceFirst('+', '')) : null;
    if (n == null || n < min) issue('Ignored $key=$v');
    return n != null && n >= min ? n : null;
  }

  List<int>? ints(String key, int min, int max, {bool signed = false}) {
    final v = parts[key];
    if (v == null) return null;
    final out = <int>[];
    for (final raw in v.split(',')) {
      final e = raw.trim();
      final n = RegExp(r'^[+-]?\d+$').hasMatch(e) ? int.parse(e.replaceFirst('+', '')) : null;
      final ok =
          n != null && (signed ? n != 0 && n.abs() >= min && n.abs() <= max : n >= min && n <= max);
      if (ok) {
        out.add(n);
      } else {
        issue('Ignored $key value "$e"');
      }
    }
    return out.isEmpty ? null : out;
  }

  rule
    ..interval = integer('INTERVAL', 1)
    ..count = integer('COUNT', 0)
    ..byMonthDay = ints('BYMONTHDAY', 1, 31, signed: true)
    ..byYearDay = ints('BYYEARDAY', 1, 366, signed: true)
    ..byWeekNo = ints('BYWEEKNO', 1, 53, signed: true)
    ..byHour = ints('BYHOUR', 0, 23)
    ..byMinute = ints('BYMINUTE', 0, 59)
    ..bySecond = ints('BYSECOND', 0, 60)
    ..bySetPos = ints('BYSETPOS', 1, 366, signed: true);
  if (parts['BYMONTH'] case final String v) {
    final gregorian = (rule.rscale ?? 'gregorian') == 'gregorian';
    final months = <String>[];
    for (final raw in v.split(',')) {
      final e = raw.trim().toUpperCase();
      final m = RegExp(r'^\+?(\d+)(L?)$').firstMatch(e);
      final n = m == null ? 0 : int.parse(m.group(1)!);
      if (m != null && n >= 1 && (gregorian ? n <= 12 && m.group(2)!.isEmpty : true)) {
        months.add('$n${m.group(2)}');
      } else {
        issue('Ignored BYMONTH value "$e"');
      }
    }
    rule.byMonth = months.isEmpty ? null : months;
  }
  if (parts['BYDAY'] case final String v) {
    final days = <({int day, int? n})>[];
    for (final raw in v.split(',')) {
      final e = raw.trim().toUpperCase();
      final m = RegExp(r'^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$').firstMatch(e);
      final n = m?.group(1) == null ? null : int.parse(m!.group(1)!.replaceFirst('+', ''));
      if (m == null || (n != null && n.abs() > 53)) {
        issue('Ignored BYDAY value "$e"');
      } else {
        days.add((day: _rfcDays.indexOf(m.group(2)!), n: n == 0 ? null : n));
      }
    }
    rule.byDay = days.isEmpty ? null : days;
  }
  if (parts['WKST'] case final String v) {
    final d = _rfcDays.indexOf(v.toUpperCase());
    if (d < 0) issue('Ignored WKST=$v');
    rule.wkst = d < 0 ? null : d;
  }
  if (parts['SKIP'] case final String v) {
    final s = v.toLowerCase();
    if (!const ['omit', 'forward', 'backward'].contains(s)) issue('Ignored SKIP=$v');
    rule.skip = const ['omit', 'forward', 'backward'].contains(s) ? s : null;
  }
  if (parts['UNTIL'] case final String v) rule.until = _lenientTime(v, 'UNTIL', issue);
  const known = {
    'FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST', 'BYDAY', 'BYMONTH', 'BYMONTHDAY', //
    'BYYEARDAY', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYSETPOS', 'RSCALE', 'SKIP',
    'TZID',
  };
  for (final key in parts.keys) {
    if (!known.contains(key) && !key.startsWith('X-')) issue('Ignored unknown RRULE part $key');
  }
  return rule;
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

// ---------------------------------------------------------------------------
// RecurrenceRule -> RRULE.

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
/// Lenient by default: invalid members and values are left out (reported to
/// [onWarning]); names may be in any case; `until` may also be a date
/// (`2024-01-31`), have fractional seconds, or be a UTC time (`…Z`, or with
/// an offset), which some stored rules have: it is then written as is for the
/// `utc` and `zoned` forms, and through [toEventTime] (called with `Etc/UTC`)
/// for the `local` and `date` forms. Returns null only without a valid
/// `frequency`. With [strict], a rule that is not a valid RecurrenceRule
/// throws a [FormatException]. Empty arrays count as absent; unknown members
/// are ignored either way.
String? jsCalendarToRRule(Map<String, Object?> rule,
    {ICalDateForm untilForm = ICalDateForm.local,
    ToUtc? toUtc,
    ToEventTime? toEventTime,
    DateTime? start,
    bool keepJsCalendarMeaning = false,
    bool strict = false,
    OnWarning? onWarning}) {
  final r = _checkRule(rule, _Issues(strict, onWarning));
  if (r == null) return null;
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
  if (r['until'] case final _Time until) {
    parts.add('UNTIL=${_untilToICal(until, untilForm, toUtc, toEventTime)}');
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
/// 4.3.3, lower-case strings, empty arrays dropped, `until` read. Null for a
/// lenient rule without a valid frequency.
Map<String, Object?>? _checkRule(Map<String, Object?> rule, _Issues issue) {
  void bad(String what) => issue('Invalid RecurrenceRule $what: $rule');
  final type = rule['@type'];
  if (type != null && type != 'RecurrenceRule') bad('@type');
  final f = rule['frequency'];
  final frequency = issue.strict || f is! String ? f : f.toLowerCase();
  if (frequency is! String || !_frequencies.contains(frequency)) {
    bad('frequency');
    return null;
  }
  final r = <String, Object?>{'frequency': frequency};

  int? integer(String key, {int min = 0}) {
    final v = rule[key];
    if (v == null) return null;
    if (v is int && v >= min) return v;
    bad(key);
    return null;
  }

  List<int>? ints(String key, int max, {bool signed = false, int min = 1}) {
    final v = rule[key];
    if (v == null) return null;
    if (v is! List) {
      bad(key);
      return null;
    }
    final out = <int>[];
    for (final e in v) {
      if (e is int &&
          (signed ? e != 0 && e.abs() >= min && e.abs() <= max : e >= min && e <= max)) {
        out.add(e);
      } else {
        bad('$key value $e');
      }
    }
    return out.isEmpty ? null : out;
  }

  String? lower(String key, List<String> allowed) {
    final v = rule[key];
    if (v == null) return null;
    final s = v is String ? (issue.strict ? v : v.toLowerCase()) : null;
    if (s != null && allowed.contains(s)) return s;
    bad(key);
    return null;
  }

  r['interval'] = integer('interval', min: 1);
  r['count'] = integer('count');
  if (rule['until'] case final Object until) {
    final local = until is String ? _localDateTime(until) : null;
    if (local != null) {
      r['until'] = (value: local, utc: false, date: false);
    } else if (issue.strict || until is! String) {
      bad('until');
    } else {
      r['until'] = _lenientTime(until, 'until', issue);
    }
  }
  if (rule['rscale'] case final Object v) {
    if (v is String && RegExp(r'^[a-z0-9-]+$', caseSensitive: false).hasMatch(v)) {
      r['rscale'] = v.toLowerCase();
    } else {
      bad('rscale');
    }
  }
  r['skip'] = lower('skip', const ['omit', 'backward', 'forward']);
  r['firstDayOfWeek'] = lower('firstDayOfWeek', _days);
  if (rule['byDay'] case final Object v) {
    if (v is! List) {
      bad('byDay');
    } else {
      final days = <Map<String, Object?>>[];
      for (final d in v) {
        final day = d is Map ? d['day'] : null;
        final name = day is String ? (issue.strict ? day : day.toLowerCase()) : null;
        if (d is! Map || !_days.contains(name) || (d['@type'] != null && d['@type'] != 'NDay')) {
          bad('byDay value $d');
          if (d is! Map || !_days.contains(name)) continue;
        }
        final nth = d['nthOfPeriod'];
        final nthOk = nth == null || (nth is int && nth != 0 && nth.abs() <= 53);
        if (!nthOk) bad('nthOfPeriod $nth');
        days.add({'day': name, if (nth != null && nthOk) 'nthOfPeriod': nth});
      }
      if (days.isNotEmpty) r['byDay'] = days;
    }
  }
  if (rule['byMonth'] case final Object v) {
    if (v is! List) {
      bad('byMonth');
    } else {
      final months = <String>[];
      for (final m in v) {
        if (m is int && m >= 1) {
          months.add('$m');
        } else if (m is String && RegExp(r'^[1-9]\d*L?$').hasMatch(m)) {
          months.add(m);
        } else {
          bad('byMonth value $m');
        }
      }
      if (months.isNotEmpty) r['byMonth'] = months;
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

String _untilToICal(_Time until, ICalDateForm form, ToUtc? toUtc, ToEventTime? toEventTime) {
  if (until.utc) {
    // A UTC `until` (lenient): as is in UTC, else in the event's wall clock.
    if (form == ICalDateForm.utc || form == ICalDateForm.zoned) {
      return _formatICal(until.value, utc: true);
    }
    final wall = toEventTime == null ? until.value : toEventTime(until.value, 'Etc/UTC');
    return _formatICal(wall, date: form == ICalDateForm.date);
  }
  final d = until.value;
  return switch (form) {
    ICalDateForm.date => _formatICal(d, date: true),
    ICalDateForm.local => _formatICal(d),
    ICalDateForm.utc => _formatICal(d, utc: true),
    ICalDateForm.zoned => toUtc == null
        ? throw ArgumentError('An UNTIL in a time zone needs toUtc')
        : _formatICal(toUtc(d), utc: true),
  };
}

// ---------------------------------------------------------------------------
// Date-time values.

final _icalDateTime = RegExp(r'^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$');

/// An iCalendar DATE or DATE-TIME (strict): impossible dates throw, second 60
/// is 59.
_Time _icalValue(String s) {
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

final _anyDateTime =
    RegExp(r'^(\d{4})-?(\d{2})-?(\d{2})(?:[Tt ]?(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?)?'
        r'\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$');

/// A date-time in iCalendar or ISO 8601 form (lenient): fractional seconds
/// dropped, an offset converted to UTC, an impossible date moved to the next
/// valid one (reported). Null (reported) when it cannot be read.
_Time? _lenientTime(String s, String what, _Issues issue) {
  final m = _anyDateTime.firstMatch(s.trim());
  if (m == null) {
    issue('Ignored $what $s');
    return null;
  }
  int g(int i) => int.parse(m.group(i) ?? '0');
  final second = g(6) == 60 ? 59 : g(6);
  var d = DateTime.utc(g(1), g(2), g(3), g(4), g(5), second);
  if (d.year != g(1) || d.month != g(2) || d.day != g(3) || d.hour != g(4) || d.minute != g(5)) {
    issue('Impossible $what $s, read as ${_formatLocal(d)}');
  }
  final zone = m.group(7)?.toUpperCase();
  if (zone != null && zone != 'Z') {
    final sign = zone.startsWith('-') ? -1 : 1;
    final digits = zone.substring(1).replaceAll(':', '');
    final minutes = int.parse(digits.substring(0, 2)) * 60 +
        (digits.length > 2 ? int.parse(digits.substring(2)) : 0);
    d = d.subtract(Duration(minutes: sign * minutes));
  }
  return (value: d, utc: zone != null, date: m.group(4) == null);
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

/// Content lines of [text]: unfolded (RFC 5545 section 3.1), trimmed, non-empty.
List<String> _lines(String text) => [
      for (final l in text.replaceAll(RegExp(r'\r?\n[ \t]'), '').split(RegExp(r'\r?\n|\r')))
        if (l.trim().isNotEmpty) l.trim()
    ];

// ---------------------------------------------------------------------------
// EXDATE / RDATE <-> recurrenceOverrides.

/// iCalendar EXDATE and RDATE properties as JSCalendar `recurrenceOverrides`
/// (draft sections 2.3.18 and 2.3.30).
///
/// [properties] are property lines such as
/// `EXDATE;TZID=Europe/Berlin:20240102T090000,20240103T090000`,
/// `RDATE;VALUE=DATE:20240105` or `RDATE;VALUE=PERIOD:20231223T150000Z/PT2H`
/// (several per string, folded or not).
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
/// Lenient by default: other properties and values that cannot be read are
/// left out (reported to [onWarning]); names may be in any case; a value may
/// disagree with its VALUE type; an EXDATE PERIOD counts by its start. With
/// [strict], these throw a [FormatException].
Map<String, Map<String, Object?>> recurrenceOverridesFromICal(Iterable<String> properties,
    {ToEventTime? toEventTime, bool strict = false, OnWarning? onWarning}) {
  final issue = _Issues(strict, onWarning);
  final rdates = <String, Map<String, Object?>>{}, exdates = <String>{};
  for (final text in properties) {
    for (final line in _lines(text)) {
      final ({String name, Map<String, String> params, String value}) p;
      try {
        p = _property(line);
      } on FormatException catch (e) {
        issue(e.message);
        continue;
      }
      final name = p.name;
      if (name != 'EXDATE' && name != 'RDATE') {
        issue('Not an EXDATE or RDATE: $line');
        continue;
      }
      final type = p.params['VALUE']?.toUpperCase();
      final tzid = p.params['TZID'];
      if (type != null && !const ['DATE', 'DATE-TIME', 'PERIOD'].contains(type) ||
          type == 'PERIOD' && name == 'EXDATE') {
        issue('Unsupported VALUE=$type in $line');
        if (type != 'PERIOD') continue;
      }
      String? key(String s) {
        final _Time v;
        if (strict) {
          v = _icalValue(s);
          if (type == 'DATE' && !v.date || type == 'DATE-TIME' && v.date) {
            throw FormatException('Value $s is not VALUE=$type');
          }
        } else {
          final t = _lenientTime(s, name, issue);
          if (t == null) return null;
          v = t;
        }
        final zone = v.utc ? 'Etc/UTC' : (v.date ? null : tzid);
        return _formatLocal(
            zone != null && toEventTime != null ? toEventTime(v.value, zone) : v.value);
      }

      for (final item in p.value.split(',')) {
        if (item.trim().isEmpty) continue;
        final slash = item.indexOf('/');
        if (name == 'EXDATE') {
          final k = key(slash < 0 ? item.trim() : item.substring(0, slash).trim());
          if (k != null) exdates.add(k);
        } else if (type == 'PERIOD' || (!strict && slash >= 0)) {
          if (slash < 0) {
            issue('Invalid PERIOD: $item');
            continue;
          }
          final start = item.substring(0, slash).trim(), end = item.substring(slash + 1).trim();
          final k = key(start);
          if (k == null) continue;
          String? duration;
          if (end.startsWith('P') || end.startsWith('+P')) {
            duration =
                _duration.hasMatch(end.replaceFirst('+', '')) ? end.replaceFirst('+', '') : null;
            if (duration == null) issue('Invalid duration: $end');
          } else {
            final a = strict ? _icalValue(start) : _lenientTime(start, 'RDATE', issue);
            final b = strict ? _icalValue(end) : _lenientTime(end, 'RDATE', issue);
            if (a != null && b != null) {
              if (b.value.isBefore(a.value)) {
                issue('PERIOD ends before it starts: $item');
              } else {
                duration = _durationBetween(a.value, b.value);
              }
            }
          }
          rdates[k] = {if (duration != null) 'duration': duration};
        } else {
          final k = key(item.trim());
          if (k != null) rdates[k] = {};
        }
      }
    }
  }
  return {
    for (final k in ({...rdates.keys, ...exdates}.toList()..sort()))
      k: exdates.contains(k) ? {'excluded': true} : rdates[k]!,
  };
}

/// The iCalendar properties of a recurrence, and the overrides they cannot
/// hold (draft section 3.2, `recurrenceOverrides` remark).
class ICalRecurrenceDates {
  /// Property lines. From [recurrenceToICal]: RRULE and EXRULE lines first;
  /// then, as from [recurrenceOverridesToICal], one EXDATE, one RDATE and one
  /// RDATE;VALUE=PERIOD, each only when needed, values in key order.
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
/// [ICalDateForm.date], a duration cannot be written: such an RDATE is also
/// listed in the overrides.
///
/// Lenient by default: a key that is not a LocalDateTime is read as well as
/// it can be (a date, fractional seconds, a `Z` that is dropped), a key with a
/// time in [ICalDateForm.date] gives its date, and a patch that is not an
/// object is left out (all reported to [onWarning]). With [strict], these
/// throw a [FormatException].
ICalRecurrenceDates recurrenceOverridesToICal(Map<String, Object?> overrides,
    {ICalDateForm form = ICalDateForm.local,
    String? timeZone,
    bool Function(DateTime recurrenceId)? isOccurrence,
    bool strict = false,
    OnWarning? onWarning}) {
  if (form == ICalDateForm.zoned && (timeZone == null || timeZone.isEmpty)) {
    throw ArgumentError('ICalDateForm.zoned needs the time zone');
  }
  final issue = _Issues(strict, onWarning);
  final exdates = <String>[], rdates = <String>[], periods = <String>[], rest = <String>[];
  for (final key in overrides.keys.toList()..sort()) {
    var id = _localDateTime(key);
    if (id == null) {
      if (strict) throw FormatException('Invalid recurrence id: $key');
      final t = _lenientTime(key, 'recurrence id', issue);
      if (t == null) continue;
      if (t.utc) issue('Recurrence id $key is not a LocalDateTime; its UTC time is used');
      id = t.value;
    }
    if (form == ICalDateForm.date && (id.hour != 0 || id.minute != 0 || id.second != 0)) {
      issue('A date-only recurrence id must be at midnight: $key');
    }
    final value = _formatICal(id, date: form == ICalDateForm.date, utc: form == ICalDateForm.utc);
    final patch = overrides[key];
    if (patch is! Map) {
      issue('Invalid patch for $key: $patch');
      continue;
    }
    if (patch['excluded'] == true) {
      exdates.add(value);
      continue;
    }
    final durationOnly = patch.keys.every((k) => k == 'duration');
    final generated = isOccurrence?.call(id);
    if (generated == null ? durationOnly : !generated) {
      final duration = patch['duration'];
      final period = durationOnly &&
          duration is String &&
          form != ICalDateForm.date &&
          _duration.hasMatch(duration);
      if (durationOnly && duration != null && !period && form != ICalDateForm.date) {
        issue('Invalid duration for $key: $duration');
      }
      if (period) {
        periods.add('$value/$duration');
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
    if (exdates.isNotEmpty) 'EXDATE$params:${{...exdates}.join(',')}',
    if (rdates.isNotEmpty) 'RDATE$params:${{...rdates}.join(',')}',
    if (periods.isNotEmpty) 'RDATE;VALUE=PERIOD$zone:${periods.join(',')}',
  ], {...rest}.toList());
}

// ---------------------------------------------------------------------------
// Whole recurrences.

/// The recurrence properties of a JSCalendar object.
class JsCalendarRecurrence {
  /// `recurrenceRules`: one RecurrenceRule per RRULE.
  final List<Map<String, Object?>> recurrenceRules;

  /// `excludedRecurrenceRules` (RFC 8984 section 4.3.4): one per EXRULE.
  final List<Map<String, Object?>> excludedRecurrenceRules;

  /// `recurrenceOverrides`: from EXDATE and RDATE.
  final Map<String, Map<String, Object?>> recurrenceOverrides;

  const JsCalendarRecurrence(
      this.recurrenceRules, this.excludedRecurrenceRules, this.recurrenceOverrides);
}

/// The recurrence of an iCalendar component (its RRULE, EXRULE, EXDATE and
/// RDATE lines, e.g. a Google event's `recurrence` array) as JSCalendar
/// `recurrenceRules`, `excludedRecurrenceRules` and `recurrenceOverrides`.
///
/// Each RRULE and EXRULE goes through [rruleToJsCalendar] (with
/// [toEventTime], [keepRRuleMeaning] and [alwaysSetInterval]); a rule without
/// a readable frequency is left out. EXDATE and RDATE go through
/// [recurrenceOverridesFromICal]. DTSTART lines are ignored. Lenient by
/// default: other lines are left out (reported to [onWarning]); with
/// [strict], they and any problem of the parts throw a [FormatException].
JsCalendarRecurrence recurrenceFromICal(Iterable<String> properties,
    {ToEventTime? toEventTime,
    bool keepRRuleMeaning = false,
    bool alwaysSetInterval = false,
    bool strict = false,
    OnWarning? onWarning}) {
  final issue = _Issues(strict, onWarning);
  final rules = <Map<String, Object?>>[], excluded = <Map<String, Object?>>[];
  final dates = <String>[];
  for (final text in properties) {
    for (final line in _lines(text)) {
      final name = RegExp(r'^([A-Za-z-]+)').firstMatch(line)?.group(1)?.toUpperCase();
      switch (name) {
        case 'RRULE' || 'EXRULE':
          final rule = rruleToJsCalendar(line,
              toEventTime: toEventTime,
              keepRRuleMeaning: keepRRuleMeaning,
              alwaysSetInterval: alwaysSetInterval,
              strict: strict,
              onWarning: onWarning);
          if (rule != null) (name == 'RRULE' ? rules : excluded).add(rule);
        case 'EXDATE' || 'RDATE':
          dates.add(line);
        case 'DTSTART':
          break;
        default:
          issue('Ignored ${name ?? 'line'} in a recurrence: $line');
      }
    }
  }
  return JsCalendarRecurrence(
      rules,
      excluded,
      recurrenceOverridesFromICal(dates,
          toEventTime: toEventTime, strict: strict, onWarning: onWarning));
}

/// JSCalendar `recurrenceRules`, `excludedRecurrenceRules` and
/// `recurrenceOverrides` as iCalendar lines: `RRULE:…` and `EXRULE:…` from
/// [jsCalendarToRRule] (with `until` in [form], [toUtc], [toEventTime],
/// [start] and [keepJsCalendarMeaning]), then EXDATE and RDATE from
/// [recurrenceOverridesToICal] (with [form], [timeZone] and [isOccurrence]).
/// A rule without a valid frequency is left out (lenient) or throws
/// ([strict]).
ICalRecurrenceDates recurrenceToICal(
    {List<Map<String, Object?>>? recurrenceRules,
    List<Map<String, Object?>>? excludedRecurrenceRules,
    Map<String, Object?>? recurrenceOverrides,
    ICalDateForm form = ICalDateForm.local,
    String? timeZone,
    ToUtc? toUtc,
    ToEventTime? toEventTime,
    DateTime? start,
    bool keepJsCalendarMeaning = false,
    bool Function(DateTime recurrenceId)? isOccurrence,
    bool strict = false,
    OnWarning? onWarning}) {
  String? rule(Map<String, Object?> r) => jsCalendarToRRule(r,
      untilForm: form,
      toUtc: toUtc,
      toEventTime: toEventTime,
      start: start,
      keepJsCalendarMeaning: keepJsCalendarMeaning,
      strict: strict,
      onWarning: onWarning);
  final dates = recurrenceOverridesToICal(recurrenceOverrides ?? const {},
      form: form,
      timeZone: timeZone,
      isOccurrence: isOccurrence,
      strict: strict,
      onWarning: onWarning);
  return ICalRecurrenceDates([
    for (final r in recurrenceRules ?? const <Map<String, Object?>>[])
      if (rule(r) case final String s) 'RRULE:$s',
    for (final r in excludedRecurrenceRules ?? const <Map<String, Object?>>[])
      if (rule(r) case final String s) 'EXRULE:$s',
    ...dates.properties,
  ], dates.overrides);
}

// ---------------------------------------------------------------------------
// Helpers.

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
  final head = line.substring(0, colon).trim();
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
  return (name: name, params: params, value: line.substring(colon + 1).trim());
}

final _duration = RegExp(r'^P(?:\d+W|(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$');

/// The duration from [a] to [b] (wall clocks), e.g. `PT2H` or `P1DT30M`.
String _durationBetween(DateTime a, DateTime b) {
  var s = b.difference(a).inSeconds;
  final days = s ~/ 86400;
  s %= 86400;
  final h = s ~/ 3600, m = s % 3600 ~/ 60, sec = s % 60;
  final time = '${h > 0 ? '${h}H' : ''}${m > 0 ? '${m}M' : ''}${sec > 0 ? '${sec}S' : ''}';
  if (days == 0 && time.isEmpty) return 'PT0S';
  return 'P${days > 0 ? '${days}D' : ''}${time.isEmpty ? '' : 'T$time'}';
}
