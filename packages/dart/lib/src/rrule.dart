// Recurrence rule (RFC 5545 RRULE) expansion engine.
//
// A port of the expansion core of rrule.js 2.8.0
// (https://github.com/jkbrzt/rrule), the engine used by Morgen desktop and the
// sync service, so that mobile produces the same occurrences.
// rrule.js: Copyright 2010, Jakub Roztocil and Lars Schöning.
// Based on python-dateutil: Copyright (c) 2003-2011 Gustavo Niemeyer,
// Copyright (c) 2012 Tomi Pieviläinen. Distributed under the BSD 3-Clause
// licence reproduced in full in the LICENCE file next to this file.
//
// Rules are evaluated on floating times: DateTime values with isUtc=true
// holding wall-clock fields (like desktop, which converts to the event's time
// zone afterwards). There is no TZID, RRuleSet, string parsing or caching.
//
// Differences from rrule.js, verified by test/rrule_diff_test.dart:
//  * BYDAY mixing plain and nth weekdays (MONTHLY;BYDAY=2WE,SA) matches days
//    satisfying either, per RFC 5545. rrule.js requires both, so such rules
//    produce no occurrences there.
//  * BYSETPOS positions beyond the size of the set select nothing, and equal
//    results are emitted once. rrule.js maps a too-large negative position to
//    the first element of the set and emits duplicates
//    (e.g. MONTHLY;BYDAY=MO;BYSETPOS=-1,-6).
//  * BYHOUR/BYMINUTE/BYSECOND values are sorted and de-duplicated, so
//    occurrences come out in chronological order.
//  * Iteration never runs away: it stops as soon as no later period can
//    produce an occurrence before the requested bound (or UNTIL), after
//    [RRule.maxPeriods] periods, and for unreachable sub-daily BYHOUR/BYMINUTE
//    combinations. rrule.js iterates up to year 9999 (seconds) for rules that
//    never match and loops forever on e.g. FREQ=HOURLY;INTERVAL=6;BYHOUR=3.
import 'iter.dart' as engine;
import 'options.dart';

export 'options.dart' show RRuleFrequency, RRuleOptions, RRuleWeekday;

class RRule {
  final RRuleOptions options;
  final ParsedOptions _parsed;

  /// Safety net on the number of iterated periods (years for YEARLY, days for
  /// DAILY…), on top of the bounds given to [between] / [all].
  final int maxPeriods;

  /// Throws [ArgumentError] for invalid options (BYSETPOS 0 or beyond ±366).
  RRule(this.options, {this.maxPeriods = 200000}) : _parsed = parseOptions(options);

  /// Occurrences in chronological order, lazily, up to [before] included.
  /// Without [before], the iteration is only bounded by COUNT, UNTIL and
  /// [maxPeriods].
  Iterable<DateTime> iterate({DateTime? before}) => engine.iterate(_parsed,
      stopAfter: before == null ? null : floating(before), maxPeriods: maxPeriods);

  /// Occurrences between [after] and [before] (rrule.js `between`). With
  /// [inclusive], occurrences equal to a bound are included.
  Iterable<DateTime> between(DateTime after, DateTime before, {bool inclusive = true}) sync* {
    final a = floating(after), b = floating(before);
    for (final d in iterate(before: b)) {
      if (inclusive ? d.isBefore(a) : !d.isAfter(a)) continue;
      if (inclusive ? d.isAfter(b) : !d.isBefore(b)) return;
      yield d;
    }
  }

  /// All occurrences, at most [limit]. Meant for COUNT/UNTIL-bounded rules;
  /// unbounded rules stop after [maxPeriods] periods.
  List<DateTime> all({int? limit}) {
    final it = iterate();
    return (limit == null ? it : it.take(limit)).toList();
  }
}
