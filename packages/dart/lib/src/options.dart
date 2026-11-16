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
    return RRuleOptions(
      freq: freq,
      dtstart: dtstart,
      interval: (rule['interval'] as int?) ?? 1,
      wkst: firstDay == null ? null : RRuleWeekday.values[firstDay],
      count: noMonth ? 0 : rule['count'] as int?,
      until: until == null ? null : _parseFloating(until),
      bysetpos: ints('bySetPosition'),
      bymonth: bymonth,
      bymonthday: ints('byMonthDay'),
      byyearday: ints('byYearDay'),
      byweekno: ints('byWeekNo'),
      byweekday: byweekday,
      byhour: ints('byHour'),
      byminute: ints('byMinute'),
      bysecond: ints('bySecond'),
    );
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
  });

  bool get isDailyOrGreater => freq.index < RRuleFrequency.hourly.index;
}

bool notEmpty(List? l) => l != null && l.isNotEmpty;

ParsedOptions parseOptions(RRuleOptions o) {
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

  return ParsedOptions._(
    freq: freq,
    dtstart: dtstart,
    interval: o.interval,
    wkst: o.wkst?.weekday ?? 0,
    count: o.count,
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
    bysecond: timePart(o.bysecond, RRuleFrequency.secondly, dtstart.second),
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
