// RRULE options and their normalisation.
//
// Ported from rrule.js 2.8.0 (dist/esm/parseoptions.js, weekday.js, rrule.js).
// rrule.js: Copyright 2010, Jakub Roztocil and Lars Schöning.
// Based on python-dateutil: Copyright (c) 2003-2011 Gustavo Niemeyer,
// Copyright (c) 2012 Tomi Pieviläinen. Distributed under the BSD 3-Clause
// licence reproduced in full in the LICENCE file next to this file.
import 'dateutil.dart';

/// Same order (and index) as rrule.js `Frequency`.
enum RRuleFrequency { yearly, monthly, weekly, daily, hourly, minutely, secondly }

/// RFC 7529 SKIP / JSCalendar `skip`: what happens to invalid dates generated
/// by BYMONTHDAY (e.g. February 30). [omit] drops them, [forward] moves them
/// to the first day of the next month, [backward] to the last day of the
/// month.
enum RRuleSkip { omit, forward, backward }

/// A weekday (MO=0 … SU=6), optionally with an ordinal ("2nd Monday",
/// "last Friday") that is honoured for MONTHLY and YEARLY rules only.
class RRuleWeekday {
  final int weekday;
  final int? n;

  const RRuleWeekday(this.weekday, [this.n]) : assert(weekday >= 0 && weekday <= 6);

  static const mo = RRuleWeekday(0);
  static const tu = RRuleWeekday(1);
  static const we = RRuleWeekday(2);
  static const th = RRuleWeekday(3);
  static const fr = RRuleWeekday(4);
  static const sa = RRuleWeekday(5);
  static const su = RRuleWeekday(6);
  static const values = [mo, tu, we, th, fr, sa, su];

  RRuleWeekday nth(int n) => RRuleWeekday(weekday, n);

  @override
  bool operator ==(Object other) =>
      other is RRuleWeekday && other.weekday == weekday && other.n == n;

  @override
  int get hashCode => Object.hash(weekday, n);

  @override
  String toString() => '${n == null ? '' : n! > 0 ? '+$n' : '$n'}'
      '${const ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][weekday]}';
}

/// Options of a recurrence rule, mirroring rrule.js `Options`.
///
/// Dates are floating: wall-clock values in DateTime objects with isUtc=true
/// (non-UTC DateTimes are reinterpreted by their wall-clock fields).
/// `null` means "not set"; an empty list is kept as given (like rrule.js).
class RRuleOptions {
  final RRuleFrequency freq;
  final DateTime dtstart;
  final int interval;
  final RRuleWeekday? wkst;
  final int? count;
  final DateTime? until;
  final List<int>? bysetpos;
  final List<int>? bymonth;

  /// Positive and negative month days.
  final List<int>? bymonthday;
  final List<int>? byyearday;
  final List<int>? byweekno;
  final List<RRuleWeekday>? byweekday;
  final List<int>? byhour;
  final List<int>? byminute;
  final List<int>? bysecond;
  final RRuleSkip skip;

  const RRuleOptions({
    required this.freq,
    required this.dtstart,
    this.interval = 1,
    this.wkst,
    this.count,
    this.until,
    this.bysetpos,
    this.bymonth,
    this.bymonthday,
    this.byyearday,
    this.byweekno,
    this.byweekday,
    this.byhour,
    this.byminute,
    this.bysecond,
    this.skip = RRuleSkip.omit,
  });

  static const _frequencies = {
    'yearly': RRuleFrequency.yearly,
    'monthly': RRuleFrequency.monthly,
    'weekly': RRuleFrequency.weekly,
    'daily': RRuleFrequency.daily,
    'hourly': RRuleFrequency.hourly,
    'minutely': RRuleFrequency.minutely,
    'secondly': RRuleFrequency.secondly,
  };

  static const _days = {'mo': 0, 'tu': 1, 'we': 2, 'th': 3, 'fr': 4, 'sa': 5, 'su': 6};

  /// Converts a JSCalendar (RFC 8984) `RecurrenceRule` object.
  ///
  /// Returns null when the rule cannot be evaluated: unknown frequency or
  /// weekday, or a non-gregorian `rscale`. Leap months (`byMonth` values ending
  /// in "L") do not exist in the gregorian calendar and are dropped; a rule
  /// listing only leap months has no occurrences. COUNT and UNTIL are both
  /// honoured if a provider sends both (like rrule.js).
  static RRuleOptions? fromJsCalendar(Map<String, dynamic> rule, DateTime dtstart) {
    final freq = _frequencies[(rule['frequency'] as String?)?.toLowerCase()];
    if (freq == null) return null;
    final rscale = rule['rscale'] as String?;
    if (rscale != null && rscale.toLowerCase() != 'gregorian') return null;

    List<int>? ints(String key) {
      final v = rule[key] as List?;
      if (v == null || v.isEmpty) return null;
      return [for (final e in v) e is int ? e : int.parse(e.toString())];
    }

    List<RRuleWeekday>? byweekday;
    final byDay = rule['byDay'] as List?;
    if (byDay != null && byDay.isNotEmpty) {
      byweekday = [];
      for (final d in byDay) {
        final day = _days[(d['day'] as String?)?.toLowerCase()];
        if (day == null) return null;
        final n = d['nthOfPeriod'] as int?;
        byweekday.add(RRuleWeekday(day, n == 0 ? null : n));
      }
    }

    List<int>? bymonth;
    var noMonth = false;
    final byMonth = rule['byMonth'] as List?;
    if (byMonth != null && byMonth.isNotEmpty) {
      final months = byMonth.map((e) => e.toString()).where((s) => !s.toUpperCase().endsWith('L'));
      bymonth = [for (final m in months) int.parse(m)];
      noMonth = bymonth.isEmpty;
      if (noMonth) bymonth = null;
    }

    final firstDay = _days[(rule['firstDayOfWeek'] as String?)?.toLowerCase()];
    final until = rule['until'] as String?;

    final skipValue = (rule['skip'] as String?)?.toLowerCase() ?? 'omit';
    final skip = switch (skipValue) {
      'omit' => RRuleSkip.omit,
      'forward' => RRuleSkip.forward,
      'backward' => RRuleSkip.backward,
      _ => null,
    };
    if (skip == null) return null;

    // RFC 8984 section 4.3.3.1, step 3: properties implicitly added to a
    // JSCalendar rule. They differ from RFC 5545's (and rrule.js's) defaults,
    // e.g. a yearly rule with byMonthDay [15] means January 15 only (an
    // implicit byMonth), where FREQ=YEARLY;BYMONTHDAY=15 means every 15th.
    // byHour/byMinute/bySecond defaults are the same in both.
    final start = floating(dtstart);
    var bymonthday = ints('byMonthDay');
    final byyearday = ints('byYearDay');
    final byweekno = ints('byWeekNo');
    if (!noMonth) {
      final hadByMonthDay = bymonthday != null, hadByDay = byweekday != null;
      final startDay = RRuleWeekday.values[start.weekday - 1];
      switch (freq) {
        case RRuleFrequency.weekly:
          byweekday ??= [startDay];
        case RRuleFrequency.monthly:
          if (!hadByDay && !hadByMonthDay) bymonthday = [start.day];
        case RRuleFrequency.yearly when byyearday == null:
          if (bymonth == null && byweekno == null && (hadByMonthDay || !hadByDay)) {
            bymonth = [start.month];
          }
          if (!hadByMonthDay && byweekno == null && !hadByDay) bymonthday = [start.day];
          if (byweekno != null && !hadByMonthDay && !hadByDay) byweekday = [startDay];
        default:
      }
    }

    return RRuleOptions(
      freq: freq,
      dtstart: dtstart,
      interval: (rule['interval'] as int?) ?? 1,
      wkst: firstDay == null ? null : RRuleWeekday.values[firstDay],
      count: noMonth ? 0 : rule['count'] as int?,
      until: until == null ? null : _parseFloating(until),
      bysetpos: ints('bySetPosition'),
      bymonth: bymonth,
      bymonthday: bymonthday,
      byyearday: byyearday,
      byweekno: byweekno,
      byweekday: byweekday,
      byhour: ints('byHour'),
      byminute: ints('byMinute'),
      bysecond: ints('bySecond'),
      skip: skip,
    );
  }

  static const _rfcDays = {'MO': 0, 'TU': 1, 'WE': 2, 'TH': 3, 'FR': 4, 'SA': 5, 'SU': 6};

  /// Parses an RFC 5545 RRULE value such as `FREQ=MONTHLY;BYDAY=2WE,SA;COUNT=5`
  /// (an `RRULE:` prefix is accepted), like rrule.js `RRule.parseString`.
  ///
  /// UNTIL may be `YYYYMMDD`, `YYYYMMDDTHHMMSS` or `YYYYMMDDTHHMMSSZ`; it is
  /// read as a floating time either way. Throws [FormatException] on unknown
  /// properties or malformed values (rrule.js throws too). BYEASTER, DTSTART
  /// and TZID are not supported: time zones are the caller's business.
  static RRuleOptions parse(String rrule, {required DateTime dtstart}) {
    var body = rrule.trim();
    if (body.toUpperCase().startsWith('RRULE:')) body = body.substring(6);
    RRuleFrequency? freq;
    var interval = 1;
    int? count;
    DateTime? until;
    RRuleWeekday? wkst;
    List<int>? bysetpos, bymonth, bymonthday, byyearday, byweekno, byhour, byminute, bysecond;
    List<RRuleWeekday>? byweekday;
    var skip = RRuleSkip.omit;

    List<int> ints(String v) => [
          for (final p in v.split(','))
            if (RegExp(r'^[+-]?\d+$').hasMatch(p))
              int.parse(p.startsWith('+') ? p.substring(1) : p)
            else
              throw FormatException('Invalid number in RRULE: $p')
        ];

    int one(String key, String v) {
      final values = ints(v);
      if (values.length != 1) throw FormatException('Invalid $key: $v');
      return values.single;
    }

    for (final attr in body.split(';')) {
      if (attr.isEmpty) continue;
      final eq = attr.indexOf('=');
      if (eq < 0) throw FormatException('Invalid RRULE part: $attr');
      final key = attr.substring(0, eq).toUpperCase(), value = attr.substring(eq + 1);
      switch (key) {
        case 'FREQ':
          freq =
              _frequencies[value.toLowerCase()] ?? (throw FormatException('Invalid FREQ: $value'));
        case 'INTERVAL':
          interval = one(key, value);
        case 'COUNT':
          count = one(key, value);
        case 'UNTIL':
          final m = RegExp(r'^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$').firstMatch(value);
          if (m == null) throw FormatException('Invalid UNTIL value: $value');
          int g(int i) => int.parse(m.group(i) ?? '0');
          until = DateTime.utc(g(1), g(2), g(3), g(5), g(6), g(7));
        case 'WKST':
          final d = _rfcDays[value.toUpperCase()];
          if (d == null) throw FormatException('Invalid WKST: $value');
          wkst = RRuleWeekday.values[d];
        case 'BYDAY' || 'BYWEEKDAY':
          byweekday = [
            for (final day in value.split(','))
              () {
                final m = RegExp(r'^([+-]?\d{1,2})?([A-Z]{2})$').firstMatch(day);
                final d = m == null ? null : _rfcDays[m.group(2)];
                if (d == null) throw FormatException('Invalid weekday string: $day');
                final n = m!.group(1) == null ? null : int.parse(m.group(1)!.replaceFirst('+', ''));
                return RRuleWeekday(d, n == 0 ? null : n);
              }()
          ];
        case 'BYSETPOS':
          bysetpos = ints(value);
        case 'BYMONTH':
          bymonth = ints(value);
        case 'BYMONTHDAY':
          bymonthday = ints(value);
        case 'BYYEARDAY':
          byyearday = ints(value);
        case 'BYWEEKNO':
          byweekno = ints(value);
        case 'BYHOUR':
          byhour = ints(value);
        case 'BYMINUTE':
          byminute = ints(value);
        case 'BYSECOND':
          bysecond = ints(value);
        case 'SKIP':
          skip = switch (value.toUpperCase()) {
            'OMIT' => RRuleSkip.omit,
            'FORWARD' => RRuleSkip.forward,
            'BACKWARD' => RRuleSkip.backward,
            _ => throw FormatException('Invalid SKIP: $value'),
          };
        case 'RSCALE':
          if (value.toUpperCase() != 'GREGORIAN') {
            throw FormatException('Unsupported RSCALE: $value');
          }
        default:
          throw FormatException("Unknown RRULE property '$key'");
      }
    }
    return RRuleOptions(
      freq: freq ?? RRuleFrequency.yearly,
      dtstart: dtstart,
      interval: interval,
      wkst: wkst,
      count: count,
      until: until,
      bysetpos: bysetpos,
      bymonth: bymonth,
      bymonthday: bymonthday,
      byyearday: byyearday,
      byweekno: byweekno,
      byweekday: byweekday,
      byhour: byhour,
      byminute: byminute,
      bysecond: bysecond,
      skip: skip,
    );
  }

  /// Parses an iCalendar recurrence string, like rrule.js `RRule.parseString`
  /// (parsestring.js): a bare RRULE value, an `RRULE:` or `EXRULE:` line, a
  /// `DTSTART` line, or a `DTSTART` line followed by a rule line, for example
  ///
  /// ```text
  /// DTSTART;TZID=Europe/Zurich:20240101T090000
  /// RRULE:FREQ=WEEKLY;COUNT=3
  /// ```
  ///
  /// DTSTART takes `TZID`, `VALUE` and other (ignored) parameters in any
  /// order, quoted or not, and may also be written inside the rule line
  /// (`RRULE:FREQ=DAILY;DTSTART=20240101T090000Z`, accepted by rrule.js for
  /// backwards compatibility). Its value is read as a floating time, `Z` or
  /// not. TZID is accepted and ignored: time zones are the caller's business.
  ///
  /// The start is, as in rrule.js `rrulestr`: a DTSTART inside the rule line,
  /// else [dtstart], else a DTSTART line.
  ///
  /// Like rrule.js, every line is checked but only the first two non-empty
  /// lines are used, and a rule property in the second overrides the same
  /// property in the first.
  ///
  /// Throws [FormatException] for anything [parse] rejects, a malformed or
  /// impossible DTSTART (`20240230`), or another property on any line
  /// (`RDATE`, `EXDATE`: there is no RRuleSet). Throws [ArgumentError] when
  /// there is no DTSTART at all.
  ///
  /// Differences from rrule.js:
  ///  * Folded lines (a line break followed by a space or tab, RFC 5545
  ///    section 3.1) are unfolded first, and lines are trimmed at both ends,
  ///    so CRLF line endings work (rrule.js only strips the first match of
  ///    `/^\s+|\s+$/`, keeping a trailing `\r` that then breaks the last
  ///    value).
  ///  * A DTSTART line must be a whole DTSTART: rrule.js reads
  ///    `DTSTART:20240101 090000` as midnight.
  ///  * Parameter names may contain digits (`X-SLOT2`): rrule.js then ignores
  ///    the whole DTSTART.
  ///  * An impossible DTSTART date is rejected (rrule.js moves 20240230 to
  ///    March 1); second 60 (a leap second) is read as 59.
  ///  * Without any DTSTART it throws instead of starting the rule "now".
  static RRuleOptions parseString(String s, {DateTime? dtstart}) {
    DateTime? inlineStart, lineStart;
    final merged = <String, String>{};
    // RFC 5545 section 3.1: a line break followed by a space or tab continues
    // the previous line.
    final lines = [
      for (final line in s.replaceAll(RegExp(r'\r?\n[ \t]'), '').split('\n'))
        if (line.trim().isNotEmpty) line.trim()
    ];
    for (final (index, line) in lines.indexed) {
      final header = RegExp(r'^([A-Z]+?)[:;]').firstMatch(line.toUpperCase())?.group(1);
      switch (header) {
        case null || 'RRULE' || 'EXRULE':
          var body = line.replaceFirst(RegExp(r'^(?:RRULE|EXRULE):', caseSensitive: false), '');
          final inline = _dtstartPattern.firstMatch(body);
          DateTime? start;
          if (inline != null) {
            start = _parseDtstart(inline);
            body = body.replaceRange(inline.start, inline.end, '');
          }
          // The parts as written, so that parse() sees every value, even one
          // that a later duplicate overrides (rrule.js parses them all).
          final attrs = [
            for (final attr in body.split(';'))
              if (attr.isNotEmpty && !attr.toUpperCase().startsWith('TZID='))
                attr.toUpperCase().startsWith('BYWEEKDAY=') ? 'BYDAY${attr.substring(9)}' : attr
          ];
          parse(attrs.join(';'), dtstart: DateTime.utc(2000));
          if (index >= 2) continue;
          if (start != null) inlineStart = start;
          for (final attr in attrs) {
            final eq = attr.indexOf('=');
            merged[attr.substring(0, eq).toUpperCase()] = attr.substring(eq + 1);
          }
        case 'DTSTART':
          final m = _dtstartPattern.firstMatch(line);
          if (m == null || m.start != 0 || m.end != line.length) {
            throw FormatException('Invalid DTSTART: $line');
          }
          final start = _parseDtstart(m);
          if (index < 2) lineStart = start;
        default:
          throw FormatException('Unsupported RFC prop $header in $line');
      }
    }
    final begin = inlineStart ?? dtstart ?? lineStart;
    if (begin == null) throw ArgumentError('No DTSTART in the string and no dtstart given');
    return parse([for (final e in merged.entries) '${e.key}=${e.value}'].join(';'), dtstart: begin);
  }

  // parsestring.js parseDtstart: `DTSTART`, parameters in any order (quoted
  // values may contain `;` and `:`), then `:` or `=` and the value.
  static final _dtstartPattern =
      RegExp(r'DTSTART((?:;[A-Z0-9-]+=(?:"[^"]*"|[^;:]*))*)(?::|=)([^;\s]*)', caseSensitive: false);
  static final _paramPattern = RegExp(r';([A-Z0-9-]+)=("[^"]*"|[^;:]*)', caseSensitive: false);

  static DateTime _parseDtstart(RegExpMatch m) {
    final value = m.group(2)!;
    String? valueType;
    for (final param in _paramPattern.allMatches(m.group(1)!)) {
      if (param.group(1)!.toUpperCase() == 'VALUE') {
        valueType = param.group(2)!.replaceAll('"', '').toUpperCase();
      }
    }
    if (valueType == 'DATE' && !RegExp(r'^\d{8}$').hasMatch(value)) {
      throw FormatException('Invalid DTSTART;VALUE=DATE value: $value');
    }
    if (valueType == 'DATE-TIME' && !RegExp(r'^\d{8}T\d{6}Z?$').hasMatch(value)) {
      throw FormatException('Invalid DTSTART;VALUE=DATE-TIME value: $value');
    }
    final d = RegExp(r'^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$').firstMatch(value);
    if (d == null) throw FormatException('Invalid DTSTART value: $value');
    int g(int i) => int.parse(d.group(i) ?? '0');
    // RFC 5545 section 3.3.5: without leap second support, second 60 is 59.
    final second = g(7) == 60 ? 59 : g(7);
    final start = DateTime.utc(g(1), g(2), g(3), g(5), g(6), second);
    if (start.year != g(1) ||
        start.month != g(2) ||
        start.day != g(3) ||
        start.hour != g(5) ||
        start.minute != g(6) ||
        start.second != second) {
      throw FormatException('Impossible DTSTART value: $value');
    }
    return start;
  }

  /// LocalDateTime ("2024-01-31T09:00:00"); a trailing "Z" or a date-only
  /// value are tolerated.
  static DateTime _parseFloating(String s) {
    final d = DateTime.parse(s.length == 10 ? '${s}T00:00:00Z' : (s.endsWith('Z') ? s : '${s}Z'));
    return d;
  }
}

/// Floating copy of [d] (wall-clock fields as UTC), truncated to milliseconds
/// like JavaScript dates.
DateTime floating(DateTime d) =>
    DateTime.utc(d.year, d.month, d.day, d.hour, d.minute, d.second, d.millisecond);

/// Normalised options, as produced by rrule.js `parseOptions`.
class ParsedOptions {
  final RRuleFrequency freq;
  final DateTime dtstart;
  final int interval;
  final int wkst;
  final int? count;
  final DateTime? until;
  final List<int>? bysetpos;
  final List<int>? bymonth;
  final List<int> bymonthday;
  final List<int> bynmonthday;
  final List<int>? byyearday;
  final List<int>? byweekno;
  final List<int>? byweekday;
  final List<(int, int)>? bynweekday;
  final List<int>? byhour;
  final List<int>? byminute;
  final List<int>? bysecond;
  final RRuleSkip skip;

  ParsedOptions._({
    required this.freq,
    required this.dtstart,
    required this.interval,
    required this.wkst,
    required this.count,
    required this.until,
    required this.bysetpos,
    required this.bymonth,
    required this.bymonthday,
    required this.bynmonthday,
    required this.byyearday,
    required this.byweekno,
    required this.byweekday,
    required this.bynweekday,
    required this.byhour,
    required this.byminute,
    required this.bysecond,
    required this.skip,
  });

  bool get isDailyOrGreater => freq.index < RRuleFrequency.hourly.index;
}

bool notEmpty(List? l) => l != null && l.isNotEmpty;

/// Rejects values that cannot be evaluated (RFC 5545 section 3.3.10 ranges).
/// rrule.js accepted them: INTERVAL=-1 looped forever, COUNT=-1 was
/// unbounded, BYHOUR=25 rolled into the next day, BYMONTHDAY=0 was dropped.
/// COUNT=0 and INTERVAL=0 stay allowed as empty rules, like rrule.js.
void _validate(RRuleOptions o) {
  Never fail(String what, Object? v) => throw ArgumentError('Invalid $what: $v');
  if (o.interval < 0) fail('interval', o.interval);
  if (o.count != null && o.count! < 0) fail('count', o.count);
  void range(String name, List<int>? values, int min, int max, {bool signed = false}) {
    for (final v in values ?? const <int>[]) {
      final a = signed ? v.abs() : v;
      if (a < min || a > max) fail(name, v);
    }
  }

  range('bymonth', o.bymonth, 1, 12);
  range('bymonthday', o.bymonthday, 1, 31, signed: true);
  range('byyearday', o.byyearday, 1, 366, signed: true);
  range('byweekno', o.byweekno, 1, 53, signed: true);
  range('byhour', o.byhour, 0, 23);
  range('byminute', o.byminute, 0, 59);
  range('bysecond', o.bysecond, 0, 60);
  for (final w in o.byweekday ?? const <RRuleWeekday>[]) {
    if (w.n != null && w.n!.abs() > 53) fail('byweekday', w);
  }
}

ParsedOptions parseOptions(RRuleOptions o) {
  _validate(o);
  final dtstart = floating(o.dtstart);
  final freq = o.freq;

  final bysetpos = o.bysetpos;
  if (bysetpos != null) {
    for (final v in bysetpos) {
      if (v == 0 || !(v >= -366 && v <= 366)) {
        throw ArgumentError('bysetpos must be between 1 and 366, or between -366 and -1');
      }
    }
  }

  var bymonth = o.bymonth;
  List<int>? bymonthdayIn = o.bymonthday;
  List<RRuleWeekday>? byweekdayIn = o.byweekday;
  List<int>? defaultWeekday;
  if (!(o.byweekno != null ||
      notEmpty(o.byyearday) ||
      o.bymonthday != null ||
      o.byweekday != null)) {
    switch (freq) {
      case RRuleFrequency.yearly:
        bymonth ??= [dtstart.month];
        bymonthdayIn = [dtstart.day];
      case RRuleFrequency.monthly:
        bymonthdayIn = [dtstart.day];
      case RRuleFrequency.weekly:
        defaultWeekday = [dtstart.weekday - 1];
      default:
    }
  }

  // bymonthday / bynmonthday
  final bymonthday = <int>[], bynmonthday = <int>[];
  for (final v in bymonthdayIn ?? const <int>[]) {
    if (v > 0) {
      bymonthday.add(v);
    } else if (v < 0) {
      bynmonthday.add(v);
    }
  }

  // byweekday / bynweekday: ordinals only count for MONTHLY and YEARLY.
  List<int>? byweekday = defaultWeekday;
  List<(int, int)>? bynweekday;
  if (byweekdayIn != null) {
    final plain = <int>[];
    final nth = <(int, int)>[];
    for (final w in byweekdayIn) {
      if (w.n == null || freq.index > RRuleFrequency.monthly.index) {
        plain.add(w.weekday);
      } else {
        nth.add((w.weekday, w.n!));
      }
    }
    byweekday = plain.isNotEmpty ? plain : null;
    bynweekday = nth.isNotEmpty ? nth : null;
  }

  // Time parts default to DTSTART's for coarser frequencies. Deviation from
  // rrule.js: they are sorted and de-duplicated, so that occurrences within a
  // day are emitted in chronological order (rrule.js keeps the given order,
  // e.g. BYHOUR=18,9 emits 18:00 before 9:00, and repeats duplicates).
  List<int>? timePart(List<int>? given, RRuleFrequency finer, int fallback) {
    if (given == null) return freq.index < finer.index ? [fallback] : null;
    return sortedUnique(given);
  }

  // A leap second (BYSECOND=60, allowed by RFC 5545) never occurs in floating
  // time: Dart and JavaScript dates cannot represent it. It is ignored, and a
  // rule whose only BYSECOND value is 60 has no occurrences.
  var bysecond = timePart(o.bysecond, RRuleFrequency.secondly, dtstart.second);
  var count = o.count;
  if (bysecond != null && bysecond.contains(60)) {
    bysecond = bysecond.where((v) => v != 60).toList();
    if (bysecond.isEmpty) count = 0;
  }

  return ParsedOptions._(
    freq: freq,
    dtstart: dtstart,
    interval: o.interval,
    wkst: o.wkst?.weekday ?? 0,
    count: count,
    until: o.until == null ? null : floating(o.until!),
    bysetpos: bysetpos,
    bymonth: bymonth,
    bymonthday: bymonthday,
    bynmonthday: bynmonthday,
    byyearday: o.byyearday,
    byweekno: o.byweekno,
    byweekday: byweekday,
    bynweekday: bynweekday,
    byhour: timePart(o.byhour, RRuleFrequency.hourly, dtstart.hour),
    byminute: timePart(o.byminute, RRuleFrequency.minutely, dtstart.minute),
    bysecond: bysecond,
    skip: o.skip,
  );
}

/// Times of day for DAILY and coarser frequencies (parseoptions.js
/// buildTimeset).
List<Time> buildTimeset(ParsedOptions o) {
  if (!o.isDailyOrGreater) return const [];
  final ms = o.dtstart.millisecond;
  return [
    for (final h in o.byhour!)
      for (final m in o.byminute!)
        for (final s in o.bysecond!) Time(h, m, s, ms),
  ];
}
