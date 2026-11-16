// The RRULE iteration loop.
//
// Ported from rrule.js 2.8.0 (dist/esm/iter/index.js, iter/poslist.js and the
// DateTime counter of datetime.js). rrule.js: Copyright 2010, Jakub Roztocil
// and Lars Schöning. Based on python-dateutil: Copyright (c) 2003-2011 Gustavo
// Niemeyer, Copyright (c) 2012 Tomi Pieviläinen. Distributed under the BSD
// 3-Clause licence reproduced in full in the LICENCE file next to this file.
//
// Deviations from rrule.js (all intentional, see rrule.dart):
//  * plain and nth BYDAY values are OR-ed (RFC 5545), rrule.js AND-s them;
//  * BYSETPOS positions past either end of the set select nothing and equal
//    results are de-duplicated (rrule.js wraps negative ones to the first
//    element and emits duplicates);
//  * iteration stops as soon as a period starts after [stopAfter] or UNTIL,
//    after [maxPeriods] consecutive periods without candidates, and when a
//    sub-daily BYHOUR/BYMINUTE/BYSECOND is unreachable, instead of running
//    to year 9999 (or forever);
//  * MINUTELY/SECONDLY counters advance like python-dateutil (rrule.js
//    misaligned the INTERVAL grid when carrying into BYMINUTE/BYHOUR).
import 'dart:typed_data';

import 'dateutil.dart';
import 'iterinfo.dart';
import 'options.dart';

/// Lazily yields the occurrences of [o] in chronological order.
///
/// [stopAfter] ends the iteration once no later period can produce an
/// occurrence <= [stopAfter]. [maxPeriods] stops it after that many
/// consecutive periods (years, months, weeks, days… depending on the
/// frequency) without a single candidate, i.e. for rules that never match.
Iterable<DateTime> iterate(ParsedOptions o, {DateTime? stopAfter, required int maxPeriods}) sync* {
  final freq = o.freq, bysetpos = o.bysetpos;
  var count = o.count ?? -1; // -1: no COUNT
  if (count == 0 || o.interval == 0) return;
  if (notEmpty(bysetpos) && _setposNeverMatches(o)) return;

  // Candidates are handled as epoch milliseconds: one DateTime per emitted
  // occurrence.
  final dtstartMs = o.dtstart.millisecondsSinceEpoch;
  final until = o.until;
  final untilMs = until?.millisecondsSinceEpoch;
  int? limitMs = stopAfter?.millisecondsSinceEpoch;
  if (untilMs != null && (limitMs == null || untilMs < limitMs)) limitMs = untilMs;

  final counter = _Counter(o.dtstart);
  if (freq == RRuleFrequency.weekly) {
    // The first weekly period is the whole week containing DTSTART (from
    // WKST), as for every other period. rrule.js started it at DTSTART, so
    // BYSETPOS counted positions in a truncated week (RFC 8984 section
    // 4.3.3.1: candidates before DTSTART are removed after BYSETPOS). Days
    // before DTSTART are still never emitted.
    final delta = pymod(counter.weekday - o.wkst, 7);
    if (delta != 0) {
      final start = DateTime.utc(counter.year, counter.month, counter.day - delta);
      counter
        ..year = start.year
        ..month = start.month
        ..day = start.day;
    }
  }
  final ii = IterInfo(o);
  ii.rebuild(counter.year, counter.month);
  var timeset = _millis(_makeTimeset(ii, counter, o));
  final days = ii.days;
  // SKIP=FORWARD moves an invalid day of a MONTHLY period to the 1st of the
  // next month, so a period can produce occurrences inside the next one, and
  // after some of that period's own (BYSETPOS=-1 picking a moved 18:00 while
  // the next period's BYSETPOS=1 picks 09:00 of the same day). Only those
  // moved results are deferred: they are merged in order with the next
  // period's results as these are generated, and exact duplicates are
  // yielded once (RFC 8984 section 4.3.3.1 removes dates already produced).
  // Everything else is yielded as it is generated, so memory never grows
  // with the period. BACKWARD and YEARLY never leave their period (December
  // has 31 days) and use the plain loop.
  final spills = ii.spillsForward;
  var pending = <int>[], next = <int>[];
  var pi = 0;
  int? lastEmitted;
  var lastStart = -1 << 62;
  // 0: skip, 1: yield, 2: stop (UNTIL or [stopAfter] passed).
  int status(int res) {
    if (limitMs != null && res > limitMs) return 2;
    if (res < dtstartMs || res == lastEmitted) return 0;
    lastEmitted = res;
    return 1;
  }

  for (var emptyPeriods = 0;;) {
    if (emptyPeriods >= maxPeriods) break;
    final start = counter.periodStartMs(freq);
    if (limitMs != null && start > limitMs) break;
    // Defensive: the counter must move forward (validated options ensure it).
    if (start <= lastStart) break;
    lastStart = start;

    final n = ii.fillDayset(freq, counter.year, counter.month, counter.day);
    final filtered = ii.lastFiltered;
    final base = ii.yearordinal * _dayMs;
    if (spills) {
      final boundary = base + ii.yearinfo.mrange[counter.month] * _dayMs;
      final ts = timeset;
      Iterable<int> results() sync* {
        if (notEmpty(bysetpos)) {
          yield* _buildPoslist(bysetpos!, ts, days, n, base);
        } else {
          for (var j = 0; j < n; j++) {
            final dayMs = base + days[j] * _dayMs;
            for (final t in ts) {
              yield dayMs + t;
            }
          }
        }
      }

      var produced = 0;
      for (final r in results()) {
        produced++;
        if (r >= boundary) {
          next.add(r);
          continue;
        }
        while (pi < pending.length && pending[pi] < r) {
          final p = pending[pi++];
          final st = status(p);
          if (st == 2) return;
          if (st == 1) {
            yield DateTime.fromMillisecondsSinceEpoch(p, isUtc: true);
            if (count > 0 && --count == 0) return;
          }
        }
        final st = status(r);
        if (st == 2) return;
        if (st == 1) {
          yield DateTime.fromMillisecondsSinceEpoch(r, isUtc: true);
          if (count > 0 && --count == 0) return;
        }
      }
      emptyPeriods = produced == 0 ? emptyPeriods + 1 : 0;
      while (pi < pending.length) {
        final p = pending[pi++];
        final st = status(p);
        if (st == 2) return;
        if (st == 1) {
          yield DateTime.fromMillisecondsSinceEpoch(p, isUtc: true);
          if (count > 0 && --count == 0) return;
        }
      }
      final t = pending;
      pending = next;
      next = t..clear();
      pi = 0;
    } else if (notEmpty(bysetpos)) {
      final poslist = _buildPoslist(bysetpos!, timeset, days, n, base);
      emptyPeriods = poslist.isEmpty ? emptyPeriods + 1 : 0;
      for (final res in poslist) {
        // limitMs is the smaller of UNTIL and [stopAfter]: nothing after it is
        // yielded, even when its period started before it.
        if (limitMs != null && res > limitMs) return;
        if (res >= dtstartMs) {
          yield DateTime.fromMillisecondsSinceEpoch(res, isUtc: true);
          if (count > 0 && --count == 0) return;
        }
      }
    } else {
      emptyPeriods = n == 0 || timeset.isEmpty ? emptyPeriods + 1 : 0;
      for (var j = 0; j < n; j++) {
        final dayMs = base + days[j] * _dayMs;
        for (var k = 0; k < timeset.length; k++) {
          final res = dayMs + timeset[k];
          if (limitMs != null && res > limitMs) return;
          if (res >= dtstartMs) {
            yield DateTime.fromMillisecondsSinceEpoch(res, isUtc: true);
            if (count > 0 && --count == 0) return;
          }
        }
      }
    }

    // Handle frequency and interval.
    counter.add(o, filtered);
    if (counter.exhausted || counter.year > maxYear) break;
    if (!o.isDailyOrGreater) {
      timeset = _millis(ii.gettimeset(freq, counter.hour, counter.minute, counter.second, 0));
    }
    ii.rebuild(counter.year, counter.month);
  }
  // Results moved past the last period.
  while (pi < pending.length) {
    final p = pending[pi++];
    final st = status(p);
    if (st == 2) return;
    if (st == 1) {
      yield DateTime.fromMillisecondsSinceEpoch(p, isUtc: true);
      if (count > 0 && --count == 0) return;
    }
  }
}

const _dayMs = 86400000;

List<int> _millis(List<Time> timeset) =>
    [for (final t in timeset) ((t.hour * 60 + t.minute) * 60 + t.second) * 1000 + t.millisecond];

/// True when every BYSETPOS position lies beyond the largest set a period can
/// have (e.g. FREQ=DAILY;BYDAY=SA,MO;BYSETPOS=2): the rule has no occurrences.
bool _setposNeverMatches(ParsedOptions o) {
  final days = switch (o.freq) {
    RRuleFrequency.yearly => 366,
    RRuleFrequency.monthly => 31,
    RRuleFrequency.weekly => 7,
    _ => 1,
  };
  int len(List<int>? a) => a?.length ?? 1;
  final times = switch (o.freq) {
    RRuleFrequency.hourly => len(o.byminute) * len(o.bysecond),
    RRuleFrequency.minutely => len(o.bysecond),
    RRuleFrequency.secondly => 1,
    _ => len(o.byhour) * len(o.byminute) * len(o.bysecond),
  };
  final max = days * times;
  return o.bysetpos!.every((p) => p.abs() > max);
}

List<Time> _makeTimeset(IterInfo ii, _Counter c, ParsedOptions o) {
  if (o.isDailyOrGreater) return buildTimeset(o);
  final f = o.freq.index;
  if ((f >= RRuleFrequency.hourly.index && notEmpty(o.byhour) && !o.byhour!.contains(c.hour)) ||
      (f >= RRuleFrequency.minutely.index &&
          notEmpty(o.byminute) &&
          !o.byminute!.contains(c.minute)) ||
      (f >= RRuleFrequency.secondly.index &&
          notEmpty(o.bysecond) &&
          !o.bysecond!.contains(c.second))) {
    return const [];
  }
  return ii.gettimeset(o.freq, c.hour, c.minute, c.second, c.millisecond);
}

/// Applies BYSETPOS to one period: [days] holds the [n] filtered
/// day-of-year indexes, [timeset] the times of day in ms, [base] the epoch ms
/// of January 1st. Positions past either end of the set select nothing, and
/// equal results are returned once (rrule.js wrapped and duplicated them).
List<int> _buildPoslist(List<int> bysetpos, List<int> timeset, Int32List days, int n, int base) {
  if (timeset.isEmpty || n == 0) return const [];
  final poslist = <int>[];
  for (final pos in bysetpos) {
    final int daypos, timepos;
    if (pos < 0) {
      daypos = floorDiv(pos, timeset.length);
      timepos = pymod(pos, timeset.length);
    } else {
      daypos = floorDiv(pos - 1, timeset.length);
      timepos = pymod(pos - 1, timeset.length);
    }
    final idx = daypos < 0 ? n + daypos : daypos;
    if (idx < 0 || idx >= n) continue;
    final res = base + days[idx] * _dayMs + timeset[timepos];
    if (!poslist.contains(res)) poslist.add(res);
  }
  return poslist..sort();
}

/// Mutable date-time counter (rrule.js `DateTime`), advanced by one period
/// per iteration.
class _Counter {
  int year, month, day, hour, minute, second, millisecond;

  /// Set when a sub-daily BYHOUR/BYMINUTE/BYSECOND can never be reached
  /// (rrule.js loops forever there, e.g. FREQ=HOURLY;INTERVAL=6;BYHOUR=3).
  bool exhausted = false;

  _Counter(DateTime d)
      : year = d.year,
        month = d.month,
        day = d.day,
        hour = d.hour,
        minute = d.minute,
        second = d.second,
        millisecond = d.millisecond;

  int get weekday => pyWeekday(year, month, day);

  /// Earliest instant (epoch ms) an occurrence of the period starting here
  /// can have.
  int periodStartMs(RRuleFrequency freq) => switch (freq) {
        RRuleFrequency.yearly => DateTime.utc(year),
        RRuleFrequency.monthly => DateTime.utc(year, month),
        RRuleFrequency.weekly || RRuleFrequency.daily => DateTime.utc(year, month, day),
        RRuleFrequency.hourly => DateTime.utc(year, month, day, hour),
        RRuleFrequency.minutely => DateTime.utc(year, month, day, hour, minute),
        RRuleFrequency.secondly => DateTime.utc(year, month, day, hour, minute, second),
      }
          .millisecondsSinceEpoch;

  void addYears(int years) => year += years;

  void addMonths(int months) {
    month += months;
    if (month > 12) {
      final yearDiv = floorDiv(month, 12);
      final monthMod = pymod(month, 12);
      month = monthMod;
      year += yearDiv;
      if (month == 0) {
        month = 12;
        --year;
      }
    }
  }

  void addWeekly(int days, int wkst) {
    final wd = weekday;
    if (wkst > wd) {
      day += -(wd + 1 + (6 - wkst)) + days * 7;
    } else {
      day += -(wd - wkst) + days * 7;
    }
    fixDay();
  }

  void addDaily(int days) {
    day += days;
    fixDay();
  }

  // Sub-daily counters follow python-dateutil's rrule._iter (rrule.js 2.8.0
  // carried overflowing seconds/minutes by repeatedly adding the carry until
  // BYMINUTE/BYHOUR matched, which misaligned the INTERVAL grid, skipped days
  // or looped forever). Unreachable combinations set [exhausted].

  int _modValue = 0;

  /// Steps [value] by [interval] (mod [base]) until it lands in [byxxx];
  /// returns the number of base overflows, or -1 if it never does.
  int _modDistance(int value, int interval, List<int> byxxx, int base) {
    var acc = 0;
    for (var i = 1; i <= base; i++) {
      value += interval;
      final div = floorDiv(value, base);
      value -= div * base;
      acc += div;
      if (byxxx.contains(value)) {
        _modValue = value;
        return acc;
      }
    }
    return -1;
  }

  void addHours(int hours, bool filtered, List<int>? byhour) {
    if (filtered) {
      // Jump to one iteration before next day.
      hour += floorDiv(23 - hour, hours) * hours;
    }
    int ndays;
    if (notEmpty(byhour)) {
      ndays = _modDistance(hour, hours, byhour!, 24);
      if (ndays < 0) {
        exhausted = true;
        return;
      }
      hour = _modValue;
    } else {
      ndays = floorDiv(hour + hours, 24);
      hour = pymod(hour + hours, 24);
    }
    if (ndays != 0) addDaily(ndays);
  }

  void addMinutes(int minutes, bool filtered, List<int>? byhour, List<int>? byminute) {
    if (filtered) {
      // Jump to one iteration before next day.
      minute += floorDiv(1439 - (hour * 60 + minute), minutes) * minutes;
    }
    final reps = 1440 ~/ minutes.gcd(1440);
    for (var j = 0; j < reps; j++) {
      int nhours;
      if (notEmpty(byminute)) {
        nhours = _modDistance(minute, minutes, byminute!, 60);
        if (nhours < 0) break;
        minute = _modValue;
      } else {
        nhours = floorDiv(minute + minutes, 60);
        minute = pymod(minute + minutes, 60);
      }
      final ndays = floorDiv(hour + nhours, 24);
      hour = pymod(hour + nhours, 24);
      if (ndays != 0) addDaily(ndays);
      if (!notEmpty(byhour) || byhour!.contains(hour)) return;
      // Skip to the last step within this (non-matching) hour: same result
      // as stepping through it, much cheaper for sparse BYHOUR.
      minute += floorDiv(59 - minute, minutes) * minutes;
    }
    exhausted = true;
  }

  void addSeconds(
      int seconds, bool filtered, List<int>? byhour, List<int>? byminute, List<int>? bysecond) {
    if (filtered) {
      // Jump to one iteration before next day.
      second += floorDiv(86399 - (hour * 3600 + minute * 60 + second), seconds) * seconds;
    }
    final reps = 86400 ~/ seconds.gcd(86400);
    for (var j = 0; j < reps; j++) {
      int nminutes;
      if (notEmpty(bysecond)) {
        nminutes = _modDistance(second, seconds, bysecond!, 60);
        if (nminutes < 0) break;
        second = _modValue;
      } else {
        nminutes = floorDiv(second + seconds, 60);
        second = pymod(second + seconds, 60);
      }
      final nhours = floorDiv(minute + nminutes, 60);
      minute = pymod(minute + nminutes, 60);
      if (nhours != 0) {
        final ndays = floorDiv(hour + nhours, 24);
        hour = pymod(hour + nhours, 24);
        if (ndays != 0) addDaily(ndays);
      }
      if (notEmpty(byhour) && !byhour!.contains(hour)) {
        // Skip to the last step within this (non-matching) hour: same result
        // as stepping through it, much cheaper for sparse BYHOUR/BYMINUTE.
        final k = floorDiv(3599 - (minute * 60 + second), seconds);
        final s = second + k * seconds;
        minute += floorDiv(s, 60);
        second = pymod(s, 60);
        continue;
      }
      if (notEmpty(byminute) && !byminute!.contains(minute)) {
        second += floorDiv(59 - second, seconds) * seconds;
        continue;
      }
      if (!notEmpty(bysecond) || bysecond!.contains(second)) return;
    }
    exhausted = true;
  }

  void fixDay() {
    if (day <= 28) return;
    var dim = daysInMonth(year, month);
    if (day <= dim) return;
    while (day > dim) {
      day -= dim;
      ++month;
      if (month == 13) {
        month = 1;
        ++year;
        if (year > maxYear) return;
      }
      dim = daysInMonth(year, month);
    }
  }

  void add(ParsedOptions o, bool filtered) {
    switch (o.freq) {
      case RRuleFrequency.yearly:
        addYears(o.interval);
      case RRuleFrequency.monthly:
        addMonths(o.interval);
      case RRuleFrequency.weekly:
        addWeekly(o.interval, o.wkst);
      case RRuleFrequency.daily:
        addDaily(o.interval);
      case RRuleFrequency.hourly:
        addHours(o.interval, filtered, o.byhour);
      case RRuleFrequency.minutely:
        addMinutes(o.interval, filtered, o.byhour, o.byminute);
      case RRuleFrequency.secondly:
        addSeconds(o.interval, filtered, o.byhour, o.byminute, o.bysecond);
    }
  }
}
