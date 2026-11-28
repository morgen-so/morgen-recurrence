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

/// Conversions between the wall clock of a time zone and UTC, from the
/// caller's time zone library. The package has no time zone data and never
/// uses the machine's zone. Every [DateTime] holds its time in its UTC
/// fields: a wall clock is a floating time, an instant its UTC time. The
/// time zone is a TZID parameter value or the event's `timeZone`, as given:
/// the functions map other names (such as Windows zone names) themselves.
/// `UTC` and `Etc/UTC` are converted without them.
class TimeZones {
  /// The UTC instant of a wall clock in a zone. As RFC 5545 section 3.3.5: a
  /// wall clock that occurs twice (when clocks go back) is its first instant,
  /// and one that does not occur is read with the offset before the gap.
  final DateTime Function(DateTime wallClock, String timeZone) toInstant;

  /// The wall clock of a UTC instant in a zone.
  final DateTime Function(DateTime instant, String timeZone) fromInstant;

  const TimeZones({required this.toInstant, required this.fromInstant});
}

final _utcName = RegExp(r'^(etc/)?utc$', caseSensitive: false);
bool _isUtcName(String timeZone) => _utcName.hasMatch(timeZone);
bool _sameZone(String? a, String? b) =>
    a != null && b != null && (a == b || _isUtcName(a) && _isUtcName(b));

/// The instant of a wall clock, or null when [zones] is needed and not given.
DateTime? _toInstantIn(TimeZones? zones, DateTime wall, String timeZone) =>
    _isUtcName(timeZone) ? wall : zones?.toInstant(wall, timeZone);

/// The wall clock of an instant, or null when [zones] is needed and not given.
DateTime? _fromInstantIn(TimeZones? zones, DateTime instant, String timeZone) =>
    _isUtcName(timeZone) ? instant : zones?.fromInstant(instant, timeZone);

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
/// `interval` is left out unless INTERVAL is written. UNTIL becomes a
/// LocalDateTime in the event's time zone: a date is that day at midnight, a
/// local time stays as written, and a UTC time becomes the wall clock of
/// [timeZone] (through [zones], unless the zone is UTC). A UTC UNTIL without
/// them is reported (strict: throws) and keeps its UTC fields.
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
/// UNTIL together, which RFC 5545 and RFC 8984 forbid, throw with [strict];
/// otherwise COUNT is kept and UNTIL left out (reported).
Map<String, Object?>? rruleToJsCalendar(String rrule,
    {String? timeZone,
    TimeZones? zones,
    bool keepRRuleMeaning = false,
    bool strict = false,
    OnWarning? onWarning}) {
  final issue = _Issues(strict, onWarning);
  final rule = strict ? _strictRule(rrule) : _lenientRule(rrule, issue);
  if (rule == null) return null;
  if (rule.count != null && rule.until != null) {
    issue('COUNT and UNTIL together; UNTIL left out: $rrule');
    rule.until = null;
  }
  final until = rule.until;
  var untilWall = until?.value;
  if (until != null && until.utc) {
    untilWall = timeZone == null ? null : _fromInstantIn(zones, until.value, timeZone);
    if (untilWall == null) {
      issue("A UTC UNTIL needs the event's timeZone${timeZone == null ? '' : ' and zones'} to "
          'become a local time; its UTC fields are kept: $rrule');
      untilWall = until.value;
    }
  }
  final js = <String, Object?>{
    '@type': 'RecurrenceRule',
    'frequency': rule.freq,
    if (rule.interval != null) 'interval': rule.interval,
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
    if (untilWall != null) 'until': _formatLocal(untilWall),
  };
  if (!keepRRuleMeaning) return js;
  final (rule: kept, :warning) = _rruleMeaning(js);
  if (warning != null) onWarning?.call('$warning: $rrule');
  return kept;
}

/// The strict reading: [RRuleOptions.parseString]'s rules, FREQ required,
/// RFC 5545's ranges, INTERVAL >= 1.
_Rule _strictRule(String rrule) {
  final (:parts, start: _) = parseRRuleParts(rrule, dtstart: DateTime.utc(2000), anyRscale: true);
  if (!parts.containsKey('FREQ')) throw FormatException('RRULE without FREQ: $rrule');
  final o = RRuleOptions.parse(
      gregorianCheck([for (final e in parts.entries) '${e.key}=${e.value}']).join(';'),
      dtstart: DateTime.utc(2000));
  final gregorian = (parts['RSCALE'] ?? 'GREGORIAN').toUpperCase() == 'GREGORIAN';
  // Year days and week numbers of other calendars (checked by gregorianCheck).
  List<int>? ints(String? v) =>
      v?.split(',').map((e) => int.parse(e.replaceFirst('+', ''))).toList();
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
    ..byMonth = gregorian
        ? (o.bymonth == null ? null : [for (final m in o.bymonth!) '$m'])
        : parts['BYMONTH']?.split(',').map((m) {
            final n = RegExp(r'^\+?(\d+)(L?)$', caseSensitive: false).firstMatch(m)!;
            return '${int.parse(n.group(1)!)}${n.group(2)!.toUpperCase()}';
          }).toList()
    ..byYearDay = gregorian ? o.byyearday : ints(parts['BYYEARDAY'])
    ..byWeekNo = gregorian ? o.byweekno : ints(parts['BYWEEKNO'])
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
    var body = line
        .replaceFirst(ruleNamePattern, '')
        .replaceFirst(RegExp(r'^(?:RRULE|EXRULE)\s*:', caseSensitive: false), '');
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

  final gregorian = _isGregorian({'rscale': rule.rscale});
  rule
    ..interval = integer('INTERVAL', 1)
    ..count = integer('COUNT', 0)
    ..byMonthDay = ints('BYMONTHDAY', 1, 31, signed: true)
    ..byYearDay =
        ints('BYYEARDAY', 1, gregorian ? maxYearDay.gregorian : maxYearDay.other, signed: true)
    ..byWeekNo =
        ints('BYWEEKNO', 1, gregorian ? maxWeekNo.gregorian : maxWeekNo.other, signed: true)
    ..byHour = ints('BYHOUR', 0, 23)
    ..byMinute = ints('BYMINUTE', 0, 59)
    ..bySecond = ints('BYSECOND', 0, 60)
    ..bySetPos = ints('BYSETPOS', 1, 366, signed: true);
  if (parts['BYMONTH'] case final String v) {
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
///    would count it within the month;
///  * yearly, with `byMonthDay`, no `byMonth`, `byWeekNo` or `byYearDay`, and
///    a `byDay` with `nthOfPeriod`: `byYearDay` 1 to 366. It restricts
///    nothing, but stops JSCalendar from adding the start month, and keeps
///    "the 3rd Tuesday of the year" (adding `byMonth` would make it "of each
///    month").
///
/// The properties are start-independent, so the result is the same for every
/// start. Other rules are returned unchanged (as a copy).
///
/// Two kinds of rule may keep no rrule.js meaning; [rruleToJsCalendar]
/// reports them to `onWarning` (in strict mode too):
///
///  * a non-Gregorian `rscale` where a month list would be needed: the months
///    of the calendar are not known here, so the rule stays as it is;
///  * the `byYearDay` case with `skip` forward or backward and a month day
///    above 28: an invalid day that moves into another month may give other
///    dates than rrule.js.
Map<String, Object?> rruleMeaningInJsCalendar(Map<String, Object?> rule) =>
    _rruleMeaning(rule).rule;

bool _isGregorian(Map<String, Object?> r) =>
    ((r['rscale'] as String?) ?? 'gregorian').toLowerCase() == 'gregorian';

({Map<String, Object?> rule, String? warning}) _rruleMeaning(Map<String, Object?> rule) {
  final r = Map<String, Object?>.of(rule);
  String? warning;
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
        if (!has('byMonth') && !has('byWeekNo') && has('byMonthDay')) {
          final skip = r['skip'];
          final movesInvalidDays = (skip == 'forward' || skip == 'backward') &&
              (r['byMonthDay'] as List).any((d) => d is int && d.abs() > 28);
          if (!_isGregorian(r)) {
            warning = 'RFC 8984 adds the start month here; the months of '
                'RSCALE=${(r['rscale'] as String).toUpperCase()} are not known, so the rule is '
                'kept as it is';
          } else if (!nth) {
            r['byMonth'] = [for (var m = 1; m <= 12; m++) '$m'];
          } else {
            r['byYearDay'] = [for (var d = 1; d <= 366; d++) d];
            if (movesInvalidDays) {
              warning = 'SKIP can move a month day above 28 into another month; the JSCalendar '
                  'dates may differ from rrule.js';
            }
          }
        }
        if (has('byWeekNo') && !has('byMonthDay') && !has('byDay')) r['byDay'] = allDays;
      }
  }
  return (rule: r, warning: warning);
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
/// an event with a time zone, its UTC instant in [timeZone] (through [zones],
/// both required then, as RFC 5545 requires UTC with a TZID start).
///
/// RFC 5545 section 3.3.10 allows less than JSCalendar: some rule parts only
/// with some frequencies, BYSETPOS only with another BY part, and no times of
/// day when the start is a date ([ICalDateForm.date]). Such a rule is written
/// as it is and reported (strict: throws), since a calendar may reject it.
///
/// With [keepJsCalendarMeaning], the RRULE gets the properties RFC 8984
/// section 4.3.3.1 (step 3) implicitly adds for [start] (required then), so
/// that rrule.js gives the JSCalendar occurrences: e.g. a yearly rule with
/// only `byMonthDay` gets BYMONTH with the start month. Two cases are
/// reported to [onWarning] (in strict mode too) and written as they are:
///
///  * the start is not an occurrence of the rule (a weekly Friday rule from a
///    Monday). RFC 8984 and RFC 5545 both count the start as the first
///    occurrence, so COUNT is written as it is, but RFC 5545 calls such a set
///    undefined and rrule.js does not give the start;
///  * a non-Gregorian `rscale` where a month or month day would be added: the
///    start's date in that calendar is not computed here.
///
/// Lenient by default: invalid members and values are left out (reported to
/// [onWarning]); names may be in any case; `until` may also be a date
/// (`2024-01-31`), have fractional seconds, or be a UTC time (`…Z`, or with
/// an offset), which some stored rules have: it is then written as is for the
/// `utc` and `zoned` forms, and as the wall clock of [timeZone] for the
/// `local` and `date` forms. Returns null only without a valid
/// `frequency`. With [strict], a rule that is not a valid RecurrenceRule
/// throws a [FormatException]. Empty arrays count as absent; unknown members
/// are ignored either way.
String? jsCalendarToRRule(Map<String, Object?> rule,
    {ICalDateForm untilForm = ICalDateForm.local,
    String? timeZone,
    TimeZones? zones,
    DateTime? start,
    bool keepJsCalendarMeaning = false,
    bool strict = false,
    OnWarning? onWarning}) {
  final s =
      _toRRule(rule, untilForm, timeZone, zones, start, keepJsCalendarMeaning, strict, onWarning);
  if (s != null && keepJsCalendarMeaning && start != null && !_startMatches(rule, start)) {
    onWarning?.call('The start ${_formatLocal(start)} is not an occurrence of the rule: RFC 5545 '
        'calls the recurrence set undefined, and rrule.js does not give the start: $s');
  }
  return s;
}

/// Whether rrule.js gives [start] as an occurrence of [rule] (with the
/// properties RFC 8984 adds for it), ignoring `count` and `until`: the rule is
/// expanded up to [start] only. True when the rule cannot be expanded here (a
/// non-Gregorian `rscale`).
bool _startMatches(Map<String, Object?> rule, DateTime start) {
  try {
    if (!_isGregorian(rule)) return true;
    final open = {
      for (final e in rule.entries)
        if (e.key != 'count' && e.key != 'until') e.key: e.value
    };
    final s = _toRRule(open, ICalDateForm.local, null, null, start, true, false, null);
    if (s == null) return true;
    final first =
        RRule(RRuleOptions.parse('$s;UNTIL=${_formatICal(start)}', dtstart: start)).all(limit: 1);
    return first.isNotEmpty && first.first == start;
  } catch (_) {
    return true;
  }
}

String? _toRRule(
    Map<String, Object?> rule,
    ICalDateForm untilForm,
    String? timeZone,
    TimeZones? zones,
    DateTime? start,
    bool keepJsCalendarMeaning,
    bool strict,
    OnWarning? onWarning) {
  final issue = _Issues(strict, onWarning);
  final r = _checkRule(rule, issue);
  if (r == null) return null;
  if (keepJsCalendarMeaning) {
    if (start == null) throw ArgumentError('keepJsCalendarMeaning needs the start');
    if (_addImplicitProperties(r, start) case final String skipped) {
      onWarning?.call("RFC 8984 adds the start's $skipped here; the start's date in "
          'RSCALE=${(r['rscale'] as String).toUpperCase()} is not computed, so it is left out: '
          '$rule');
    }
  }
  if (_notInRfc5545(r, untilForm == ICalDateForm.date) case final String invalid) {
    issue('RFC 5545 does not allow $invalid, so a calendar may reject the rule: $rule');
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
    parts.add('UNTIL=${_untilToICal(until, untilForm, timeZone, zones)}');
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
/// RRuleOptions.fromJsCalendar. With a non-Gregorian `rscale`, the month and
/// month day (which need the start's date in that calendar) are not added:
/// returns what was left out.
String? _addImplicitProperties(Map<String, Object?> r, DateTime start) {
  bool has(String k) => r[k] is List && (r[k] as List).isNotEmpty;
  final day = _days[start.weekday - 1];
  final gregorian = _isGregorian(r);
  final hadByDay = has('byDay'), hadByMonthDay = has('byMonthDay');
  final skipped = <String>[];
  void monthDay() {
    if (gregorian) {
      r['byMonthDay'] = [start.day];
    } else {
      skipped.add('month day');
    }
  }

  switch (r['frequency']) {
    case 'weekly':
      if (!hadByDay)
        r['byDay'] = [
          {'@type': 'NDay', 'day': day}
        ];
    case 'monthly':
      if (!hadByDay && !hadByMonthDay) monthDay();
    case 'yearly':
      if (!has('byYearDay')) {
        if (!has('byMonth') && !has('byWeekNo') && (hadByMonthDay || !hadByDay)) {
          if (gregorian) {
            r['byMonth'] = ['${start.month}'];
          } else {
            skipped.add('month');
          }
        }
        if (!hadByMonthDay && !has('byWeekNo') && !hadByDay) monthDay();
        if (has('byWeekNo') && !hadByMonthDay && !hadByDay) {
          r['byDay'] = [
            {'@type': 'NDay', 'day': day}
          ];
        }
      }
  }
  return skipped.isEmpty ? null : skipped.join(' and ');
}

/// A checked copy of a RecurrenceRule: types and ranges of RFC 8984 section
/// 4.3.3, lower-case strings, empty arrays dropped, `until` read. Null for a
/// lenient rule without a valid frequency.
/// What RFC 5545 section 3.3.10 does not allow in the rule (JSCalendar allows
/// it all, and the rrule package reads it as JSCalendar does), or null: rule
/// parts that do not go with the frequency, BYSETPOS without another BY part,
/// and times of day for an event whose start is a date ([allDay]).
String? _notInRfc5545(Map<String, Object?> r, bool allDay) {
  final f = r['frequency'] as String;
  bool has(String k) => r[k] is List && (r[k] as List).isNotEmpty;
  String withFreq(String part) => '$part with FREQ=${f.toUpperCase()}';
  final days = (r['byDay'] as List?)?.cast<Map>() ?? const [];
  final nth = days.any((d) => d['nthOfPeriod'] != null);
  final times = has('byHour') || has('byMinute') || has('bySecond');
  final others = has('byMonth') ||
      has('byWeekNo') ||
      has('byYearDay') ||
      has('byMonthDay') ||
      has('byDay') ||
      times;
  final found = <String>[
    if (has('byMonthDay') && f == 'weekly') withFreq('BYMONTHDAY'),
    if (has('byYearDay') && const ['daily', 'weekly', 'monthly'].contains(f)) withFreq('BYYEARDAY'),
    if (has('byWeekNo') && f != 'yearly') withFreq('BYWEEKNO'),
    if (nth && f != 'monthly' && f != 'yearly')
      withFreq('BYDAY with a number')
    else if (nth && f == 'yearly' && has('byWeekNo'))
      withFreq('BYDAY with a number and BYWEEKNO'),
    if (has('bySetPosition') && !others) 'BYSETPOS without another BY part',
    if (allDay && times) 'BYHOUR, BYMINUTE or BYSECOND for a start that is a date',
  ];
  return found.isEmpty ? null : found.join(', ');
}

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
  final countAndUntil = r['count'] != null && rule['until'] != null;
  if (countAndUntil) bad('count with until (until left out)');
  if (rule['until'] case final Object until when !countAndUntil) {
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
  final gregorian = _isGregorian(r);
  r['byYearDay'] =
      ints('byYearDay', gregorian ? maxYearDay.gregorian : maxYearDay.other, signed: true);
  r['byWeekNo'] = ints('byWeekNo', gregorian ? maxWeekNo.gregorian : maxWeekNo.other, signed: true);
  r['byHour'] = ints('byHour', 23, min: 0);
  r['byMinute'] = ints('byMinute', 59, min: 0);
  r['bySecond'] = ints('bySecond', 60, min: 0);
  r['bySetPosition'] = ints('bySetPosition', 366, signed: true);
  r.removeWhere((_, v) => v == null);
  return r;
}

String _untilToICal(_Time until, ICalDateForm form, String? timeZone, TimeZones? zones) {
  if (until.utc) {
    // A UTC `until` (lenient): as is in UTC, else in the event's wall clock.
    if (form == ICalDateForm.utc || form == ICalDateForm.zoned) {
      return _formatICal(until.value, utc: true);
    }
    final wall =
        (timeZone == null ? null : _fromInstantIn(zones, until.value, timeZone)) ?? until.value;
    return _formatICal(wall, date: form == ICalDateForm.date);
  }
  final d = until.value;
  switch (form) {
    case ICalDateForm.date:
      return _formatICal(d, date: true);
    case ICalDateForm.local:
      return _formatICal(d);
    case ICalDateForm.utc:
      return _formatICal(d, utc: true);
    case ICalDateForm.zoned:
      final instant = timeZone == null ? null : _toInstantIn(zones, d, timeZone);
      if (instant == null) throw ArgumentError('An UNTIL in a time zone needs timeZone and zones');
      return _formatICal(instant, utc: true);
  }
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
/// The values are compared as instants, then become keys:
///
///  1. Each value gets its UTC instant: a UTC value has it, a value with a
///     TZID gets it from [zones], and a value without a zone is in the
///     event's wall clock ([timeZone]). A date, and any value of an event
///     without a time zone, has none and counts by its fields.
///  2. An EXDATE removes the RDATEs of its instant (RFC 5545 section
///     3.8.5.1); equal RDATEs are one.
///  3. Each remaining value becomes a key, a LocalDateTime in the event's
///     time zone: an EXDATE maps to `{"excluded": true}`, an RDATE to `{}`,
///     or to `{"duration": …}` for a PERIOD.
///
/// A key names one instant: of a local time that occurs twice (when clocks go
/// back), the first (RFC 8984 section 1.4.5). A value at the second one, from
/// UTC or another zone, has no key, so it is reported and left out (an
/// EXDATE that only removes an RDATE needs none).
///
/// A PERIOD's duration is kept as written when the period is in the event's
/// own wall clock or has no days or weeks. Otherwise its days are days of
/// another zone (RFC 5545 section 3.3.6), and it becomes the time elapsed,
/// in hours (`PT24H`). An explicit end always becomes the time elapsed.
///
/// A value that needs [timeZone] or [zones] and does not get them is
/// reported; its fields are then kept (and a duration is the wall-clock
/// difference). Lenient by default: what is reported goes to [onWarning],
/// and other properties and values that cannot be read are left out; names
/// may be in any case; a value may disagree with its VALUE type; an EXDATE
/// PERIOD counts by its start. With [strict], all of these throw a
/// [FormatException].
Map<String, Map<String, Object?>> recurrenceOverridesFromICal(Iterable<String> properties,
    {String? timeZone, TimeZones? zones, bool strict = false, OnWarning? onWarning}) {
  final issue = _Issues(strict, onWarning);
  final event = timeZone;

  // The zone a value is written in: null for the event's own wall clock (or a date).
  String? sourceOf(_Time v, String? tzid) {
    final source = v.date ? null : (v.utc ? 'Etc/UTC' : tzid);
    return source == null || _sameZone(source, event) ? null : source;
  }

  // A value's key, its instant if it has one, and whether the key names that instant.
  _Resolved resolve(_DateItem item) {
    final v = item.start;
    final source = sourceOf(v, item.tzid);
    if (source == null) {
      final instant = !v.date && event != null ? _toInstantIn(zones, v.value, event) : null;
      return (
        key: _formatLocal(v.value),
        instant: instant?.millisecondsSinceEpoch,
        named: true,
        text: item.text
      );
    }
    final instant = _toInstantIn(zones, v.value, source);
    final wall = instant != null && event != null ? _fromInstantIn(zones, instant, event) : null;
    if (instant == null || wall == null) {
      final missing = event == null ? "the event's timeZone" : 'zones';
      issue('${item.text} is in $source and needs $missing to become a recurrence id; '
          'its fields are kept');
      return (
        key: _formatLocal(v.value),
        instant: instant?.millisecondsSinceEpoch,
        named: true,
        text: item.text
      );
    }
    final at = instant.millisecondsSinceEpoch;
    final named = _toInstantIn(zones, wall, event!)?.millisecondsSinceEpoch == at;
    return (key: _formatLocal(wall), instant: at, named: named, text: item.text);
  }

  // The JSCalendar duration of a period.
  String? durationOf(_DateItem item) {
    final a = item.start;
    final source = sourceOf(a, item.tzid);
    final duration = item.duration, end = item.end;
    if (duration != null) {
      if (source == null || !RegExp('[DW]').hasMatch(duration)) return duration;
      if (_toInstantIn(zones, a.value, source) == null) {
        issue('The days of ${item.text} are days in $source: zones is needed for the time '
            'elapsed; the duration is kept');
        return duration;
      }
      return _exactDuration(a.value, duration, (d) => _toInstantIn(zones, d, source)!);
    }
    if (end == null) return null;
    final zone = a.date ? null : (source ?? event);
    if (zone == null) return _durationBetween(a.value, end.value);
    if (_toInstantIn(zones, a.value, zone) == null) {
      issue('${item.text} is in $zone: zones is needed for the time elapsed; the wall-clock '
          'difference is used');
      return _durationBetween(a.value, end.value);
    }
    return _durationBetween(a.value, end.value, (d) => _toInstantIn(zones, d, zone)!);
  }

  final exdates = <_Resolved>[], rdates = <_Resolved>[];
  final patches = <Map<String, Object?>>[];
  for (final item in _dateItems(properties, strict, issue)) {
    final r = resolve(item);
    if (item.exdate) {
      exdates.add(r);
    } else {
      final duration = durationOf(item);
      rdates.add(r);
      patches.add({if (duration != null) 'duration': duration});
    }
  }

  // Two values are the same occurrence when their instants are equal, or,
  // when one has none, their keys.
  bool Function(_Resolved) index(List<_Resolved> values) {
    final instants = <int>{}, keys = <String>{}, keysWithoutInstant = <String>{};
    for (final v in values) {
      keys.add(v.key);
      final i = v.instant;
      if (i != null) {
        instants.add(i);
      } else {
        keysWithoutInstant.add(v.key);
      }
    }
    return (v) => v.instant != null
        ? instants.contains(v.instant) || keysWithoutInstant.contains(v.key)
        : keys.contains(v.key);
  }

  final isExcluded = index(exdates), isAdded = index(rdates);
  String second(_Resolved v) => '${v.text} is the second ${v.key} of an hour that occurs twice '
      'in $event, which no recurrence id names';

  final out = <String, Map<String, Object?>>{};
  for (final e in exdates) {
    if (e.named) {
      out[e.key] = {'excluded': true};
    } else if (!isAdded(e)) {
      // The second of two equal local times: fine if it only removes an RDATE.
      issue('EXDATE ${second(e)}; it is left out');
    }
  }
  for (var i = 0; i < rdates.length; i++) {
    final r = rdates[i];
    if (isExcluded(r)) continue;
    if (r.named) {
      out[r.key] = patches[i];
    } else {
      issue('RDATE ${second(r)}; it is left out');
    }
  }
  return {for (final k in out.keys.toList()..sort()) k: out[k]!};
}

/// An EXDATE or RDATE value as read: a PERIOD has a [duration] or an explicit
/// [end]; [text] is the value as written, for messages.
typedef _DateItem = ({
  bool exdate,
  _Time start,
  String? tzid,
  String? duration,
  _Time? end,
  String text
});

/// A value with its key, its instant if known, and whether the key names
/// that instant.
typedef _Resolved = ({String key, int? instant, bool named, String text});

/// The values of EXDATE and RDATE lines; what cannot be read is reported and
/// left out.
List<_DateItem> _dateItems(Iterable<String> properties, bool strict, _Issues issue) {
  final out = <_DateItem>[];
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
      _Time? read(String s) {
        if (!strict) return _lenientTime(s, name, issue);
        final v = _icalValue(s);
        if (type == 'DATE' && !v.date || type == 'DATE-TIME' && v.date) {
          throw FormatException('Value $s is not VALUE=$type');
        }
        return v;
      }

      for (final raw in p.value.split(',')) {
        final item = raw.trim();
        if (item.isEmpty) continue;
        final slash = item.indexOf('/');
        if (name == 'EXDATE') {
          final start = read(slash < 0 ? item : item.substring(0, slash).trim());
          if (start != null) {
            out.add(
                (exdate: true, start: start, tzid: tzid, duration: null, end: null, text: item));
          }
        } else if (type == 'PERIOD' || (!strict && slash >= 0)) {
          if (slash < 0) {
            issue('Invalid PERIOD: $item');
            continue;
          }
          final start = read(item.substring(0, slash).trim());
          if (start == null) continue;
          final end = item.substring(slash + 1).trim();
          String? duration;
          _Time? endTime;
          if (end.startsWith('P') || end.startsWith('+P')) {
            final d = end.replaceFirst('+', '');
            if (_duration.hasMatch(d)) {
              duration = d;
            } else {
              issue('Invalid duration: $end');
            }
          } else {
            final b = strict ? _icalValue(end) : _lenientTime(end, 'RDATE', issue);
            if (b != null && b.value.isBefore(start.value)) {
              issue('PERIOD ends before it starts: $item');
            } else {
              endTime = b;
            }
          }
          out.add((
            exdate: false,
            start: start,
            tzid: tzid,
            duration: duration,
            end: endTime,
            text: item
          ));
        } else {
          final start = read(item);
          if (start != null) {
            out.add(
                (exdate: false, start: start, tzid: tzid, duration: null, end: null, text: item));
          }
        }
      }
    }
  }
  return out;
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
/// empty patch counts as an RDATE, a duration-only patch as an RDATE and an
/// override (right whether the date is added or generated: an RDATE of a
/// generated date changes nothing), and every other patch as an override.
/// Values are written in [form] (the event's DTSTART form; with
/// [ICalDateForm.zoned], a TZID parameter of [timeZone]). A duration that a
/// PERIOD cannot hold (with [ICalDateForm.date], or a zero duration, which
/// RFC 5545 does not allow) is left to the overrides, next to a plain RDATE.
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
        OnWarning? onWarning}) =>
    _overridesToICal(overrides, form, timeZone, isOccurrence, strict, onWarning);

ICalRecurrenceDates _overridesToICal(
    Map<String, Object?> overrides,
    ICalDateForm form,
    String? timeZone,
    bool Function(DateTime recurrenceId)? isOccurrence,
    bool strict,
    OnWarning? onWarning) {
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
      // A PERIOD only for a date the rule does not generate (known from
      // isOccurrence), with a positive duration (RFC 5545 section 3.3.9).
      final period = generated == false &&
          durationOnly &&
          duration is String &&
          form != ICalDateForm.date &&
          _duration.hasMatch(duration) &&
          RegExp('[1-9]').hasMatch(duration);
      if (durationOnly &&
          duration != null &&
          !(duration is String && _duration.hasMatch(duration))) {
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
  rdates.sort();
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
/// Each RRULE and EXRULE goes through [rruleToJsCalendar] (with [timeZone],
/// [zones] and [keepRRuleMeaning]); a rule without a readable
/// frequency is left out. EXDATE and RDATE go through
/// [recurrenceOverridesFromICal]. DTSTART lines are ignored. Lenient by
/// default: other lines are left out (reported to [onWarning]); with
/// [strict], they and any problem of the parts throw a [FormatException].
JsCalendarRecurrence recurrenceFromICal(Iterable<String> properties,
    {String? timeZone,
    TimeZones? zones,
    bool keepRRuleMeaning = false,
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
              timeZone: timeZone,
              zones: zones,
              keepRRuleMeaning: keepRRuleMeaning,
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
          timeZone: timeZone, zones: zones, strict: strict, onWarning: onWarning));
}

/// JSCalendar `recurrenceRules`, `excludedRecurrenceRules` and
/// `recurrenceOverrides` as iCalendar lines: `RRULE:…` and `EXRULE:…` from
/// [jsCalendarToRRule] (with `until` in [form], [timeZone], [zones],
/// [start] and [keepJsCalendarMeaning]), then EXDATE and RDATE from
/// [recurrenceOverridesToICal] (with [form], [timeZone] and [isOccurrence]).
/// A rule without a valid frequency is left out (lenient) or throws
/// ([strict]).
///
/// Each rule is written as [jsCalendarToRRule] writes it, warnings included:
/// a start that a rule does not generate stays as it is (see there).
ICalRecurrenceDates recurrenceToICal(
    {List<Map<String, Object?>>? recurrenceRules,
    List<Map<String, Object?>>? excludedRecurrenceRules,
    Map<String, Object?>? recurrenceOverrides,
    ICalDateForm form = ICalDateForm.local,
    String? timeZone,
    TimeZones? zones,
    DateTime? start,
    bool keepJsCalendarMeaning = false,
    bool Function(DateTime recurrenceId)? isOccurrence,
    bool strict = false,
    OnWarning? onWarning}) {
  String? rule(Map<String, Object?> r) => jsCalendarToRRule(r,
      untilForm: form,
      timeZone: timeZone,
      zones: zones,
      start: start,
      keepJsCalendarMeaning: keepJsCalendarMeaning,
      strict: strict,
      onWarning: onWarning);
  final rrules = [
    for (final r in recurrenceRules ?? const <Map<String, Object?>>[])
      if (rule(r) case final String s) 'RRULE:$s'
  ];
  final dates = _overridesToICal(
      recurrenceOverrides ?? const {}, form, timeZone, isOccurrence, strict, onWarning);
  return ICalRecurrenceDates([
    ...rrules,
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

/// The JSCalendar Duration (RFC 8984 section 1.4.6) of the time elapsed from
/// the wall clock [a] to [b], in hours, minutes and seconds (`PT2H`, `PT24H`):
/// RFC 8984 adds such a duration as exact time, so the end instant is kept
/// whatever the event's time zone (nominal days would be added in the
/// event's wall clock). With [instant] (the UTC instant of a wall clock) it is
/// exact across a time change; without it, it is the wall-clock difference.
String _durationBetween(DateTime a, DateTime b, [DateTime Function(DateTime)? instant]) {
  final at = instant ?? (DateTime d) => d;
  return _elapsed(at(b).difference(at(a)).inSeconds);
}

/// A Duration from the wall clock [a] as the time elapsed: its weeks and days
/// are added to the wall clock (nominal), the rest as exact time (RFC 5545
/// section 3.3.6, RFC 8984 section 1.4.6), with [instant] the UTC instant of
/// a wall clock.
String _exactDuration(DateTime a, String duration, DateTime Function(DateTime) instant) {
  final parts = duration.split('T');
  final date = parts[0], time = parts.length > 1 ? parts[1] : '';
  int n(String s, String unit) => int.parse(RegExp('(\\d+)$unit').firstMatch(s)?.group(1) ?? '0');
  final days = n(date, 'W') * 7 + n(date, 'D');
  final end = a.add(Duration(days: days));
  return _elapsed(instant(end).difference(instant(a)).inSeconds +
      n(time, 'H') * 3600 +
      n(time, 'M') * 60 +
      n(time, 'S'));
}

/// Seconds as a Duration of hours, minutes and seconds (`PT0S` for none).
String _elapsed(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  final h = s ~/ 3600, m = s % 3600 ~/ 60, sec = s % 60;
  final time = '${h > 0 ? '${h}H' : ''}${m > 0 ? '${m}M' : ''}${sec > 0 ? '${sec}S' : ''}';
  return time.isEmpty ? 'PT0S' : 'PT$time';
}
