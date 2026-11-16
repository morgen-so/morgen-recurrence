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
//    and after [maxPeriods] periods, instead of running to year 9999.
import 'dateutil.dart';
import 'iterinfo.dart';
import 'options.dart';

/// Lazily yields the occurrences of [o] in chronological order.
///
/// [stopAfter] ends the iteration once no later period can produce an
/// occurrence <= [stopAfter]. [maxPeriods] bounds the number of iterated
/// periods (years, months, weeks, days… depending on the frequency).
Iterable<DateTime> iterate(ParsedOptions o, {DateTime? stopAfter, required int maxPeriods}) sync* {
  final dtstart = o.dtstart, freq = o.freq, until = o.until, bysetpos = o.bysetpos;
  var count = o.count;
  if (count == 0 || o.interval == 0) return;

  DateTime? limit = stopAfter;
  if (until != null && (limit == null || until.isBefore(limit))) limit = until;

  final counter = _Counter(dtstart);
  final ii = IterInfo(o);
  ii.rebuild(counter.year, counter.month);
  var timeset = _makeTimeset(ii, counter, o);
  for (var periods = 0;; periods++) {
    if (periods >= maxPeriods) return;
    if (limit != null && counter.periodStart(freq).isAfter(limit)) return;

    final ds = ii.getdayset(freq, counter.year, counter.month, counter.day);
    final filtered = _removeFilteredDays(ds, ii, o);
    final Iterable<DateTime> candidates = notEmpty(bysetpos)
        ? _buildPoslist(bysetpos!, timeset, ds, ii)
        : [
            for (final day in ds.days)
              if (day != null)
                for (final time in timeset) combine(fromOrdinal(ii.yearordinal + day), time),
          ];
    for (final res in candidates) {
      if (until != null && res.isAfter(until)) return;
      if (!res.isBefore(dtstart)) {
        yield res;
        if (count != null) {
          --count;
          if (count == 0) return;
        }
      }
    }

    // Handle frequency and interval.
    counter.add(o, filtered);
    if (counter.exhausted || counter.year > maxYear) return;
    if (!o.isDailyOrGreater) {
      timeset = ii.gettimeset(freq, counter.hour, counter.minute, counter.second, 0);
    }
    ii.rebuild(counter.year, counter.month);
  }
}

bool _isFiltered(IterInfo ii, int currentDay, ParsedOptions o) {
  final y = ii.yearinfo;
  final bymonth = o.bymonth, byweekno = o.byweekno, byweekday = o.byweekday;
  final byyearday = o.byyearday;
  final nwdaymask = ii.nwdaymask;
  return (notEmpty(bymonth) && !bymonth!.contains(y.mmask[currentDay])) ||
      (notEmpty(byweekno) && y.wnomask![currentDay] == 0) ||
      // RFC 5545: a day matches BYDAY if it matches a plain weekday OR an nth
      // weekday. rrule.js (and python-dateutil) require both.
      ((notEmpty(byweekday) || nwdaymask.isNotEmpty) &&
          !(byweekday?.contains(y.wdaymask[currentDay]) ?? false) &&
          !(currentDay < nwdaymask.length && nwdaymask[currentDay] == 1)) ||
      ((o.bymonthday.isNotEmpty || o.bynmonthday.isNotEmpty) &&
          !o.bymonthday.contains(y.mdaymask[currentDay]) &&
          !o.bynmonthday.contains(y.nmdaymask[currentDay])) ||
      (notEmpty(byyearday) &&
          ((currentDay < ii.yearlen &&
                  !byyearday!.contains(currentDay + 1) &&
                  !byyearday.contains(-ii.yearlen + currentDay)) ||
              (currentDay >= ii.yearlen &&
                  !byyearday!.contains(currentDay + 1 - ii.yearlen) &&
                  !byyearday.contains(-ii.nextyearlen + currentDay - ii.yearlen))));
}

/// Nulls out filtered days; returns whether the *last* day was filtered
/// (only used to skip ahead in sub-daily frequencies, like rrule.js).
bool _removeFilteredDays(DaySet ds, IterInfo ii, ParsedOptions o) {
  var filtered = false;
  for (var k = 0; k < ds.days.length; k++) {
    filtered = _isFiltered(ii, ds.days[k]!, o);
    if (filtered) ds.days[k] = null;
  }
  return filtered;
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

List<DateTime> _buildPoslist(List<int> bysetpos, List<Time> timeset, DaySet ds, IterInfo ii) {
  if (timeset.isEmpty) return const [];
  final days = [
    for (final d in ds.days)
      if (d != null) d
  ];
  final poslist = <DateTime>{};
  for (final pos in bysetpos) {
    final int daypos, timepos;
    if (pos < 0) {
      daypos = floorDiv(pos, timeset.length);
      timepos = pymod(pos, timeset.length);
    } else {
      daypos = floorDiv(pos - 1, timeset.length);
      timepos = pymod(pos - 1, timeset.length);
    }
    final idx = daypos < 0 ? days.length + daypos : daypos;
    if (idx < 0 || idx >= days.length) continue;
    poslist.add(combine(fromOrdinal(ii.yearordinal + days[idx]), timeset[timepos]));
  }
  return poslist.toList()..sort();
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

  /// Earliest instant an occurrence of the period starting here can have.
  DateTime periodStart(RRuleFrequency freq) => switch (freq) {
        RRuleFrequency.yearly => DateTime.utc(year),
        RRuleFrequency.monthly => DateTime.utc(year, month),
        RRuleFrequency.weekly || RRuleFrequency.daily => DateTime.utc(year, month, day),
        RRuleFrequency.hourly => DateTime.utc(year, month, day, hour),
        RRuleFrequency.minutely => DateTime.utc(year, month, day, hour, minute),
        RRuleFrequency.secondly => DateTime.utc(year, month, day, hour, minute, second),
      };

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

  void addHours(int hours, bool filtered, List<int>? byhour) {
    if (filtered) {
      // Jump to one iteration before next day.
      hour += floorDiv(23 - hour, hours) * hours;
    }
    // The hour sequence repeats after at most 24 steps.
    for (var steps = 0;; steps++) {
      if (steps > 24) {
        exhausted = true;
        return;
      }
      hour += hours;
      final dayDiv = floorDiv(hour, 24), hourMod = pymod(hour, 24);
      if (dayDiv != 0) {
        hour = hourMod;
        addDaily(dayDiv);
      }
      if (!notEmpty(byhour) || byhour!.contains(hour)) break;
    }
  }

  void addMinutes(int minutes, bool filtered, List<int>? byhour, List<int>? byminute) {
    if (filtered) {
      // Jump to one iteration before next day.
      minute += floorDiv(1439 - (hour * 60 + minute), minutes) * minutes;
    }
    // (hour, minute) has 1440 states.
    for (var steps = 0;; steps++) {
      if (steps > 1440) {
        exhausted = true;
        return;
      }
      minute += minutes;
      final hourDiv = floorDiv(minute, 60), minuteMod = pymod(minute, 60);
      if (hourDiv != 0) {
        minute = minuteMod;
        addHours(hourDiv, false, byhour);
        if (exhausted) return;
      }
      if ((!notEmpty(byhour) || byhour!.contains(hour)) &&
          (!notEmpty(byminute) || byminute!.contains(minute))) {
        break;
      }
    }
  }

  void addSeconds(
      int seconds, bool filtered, List<int>? byhour, List<int>? byminute, List<int>? bysecond) {
    if (filtered) {
      // Jump to one iteration before next day.
      second += floorDiv(86399 - (hour * 3600 + minute * 60 + second), seconds) * seconds;
    }
    // (hour, minute, second) has 86400 states.
    for (var steps = 0;; steps++) {
      if (steps > 86400) {
        exhausted = true;
        return;
      }
      second += seconds;
      final minuteDiv = floorDiv(second, 60), secondMod = pymod(second, 60);
      if (minuteDiv != 0) {
        second = secondMod;
        addMinutes(minuteDiv, false, byhour, byminute);
        if (exhausted) return;
      }
      if ((!notEmpty(byhour) || byhour!.contains(hour)) &&
          (!notEmpty(byminute) || byminute!.contains(minute)) &&
          (!notEmpty(bysecond) || bysecond!.contains(second))) {
        break;
      }
    }
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
