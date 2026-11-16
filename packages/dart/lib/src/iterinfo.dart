// Per-year and per-month lookup tables used to filter candidate days.
//
// Ported from rrule.js 2.8.0 (dist/esm/iterinfo/index.js, yearinfo.js,
// monthinfo.js). rrule.js: Copyright 2010, Jakub Roztocil and Lars Schöning.
// Based on python-dateutil: Copyright (c) 2003-2011 Gustavo Niemeyer,
// Copyright (c) 2012 Tomi Pieviläinen. Distributed under the BSD 3-Clause
// licence reproduced in full in the LICENCE file next to this file.
import 'dateutil.dart';
import 'options.dart';

class YearInfo {
  final int yearlen;
  final int nextyearlen;
  final int yearordinal;
  final int yearweekday;
  final List<int> mmask;
  final List<int> mdaymask;
  final List<int> nmdaymask;
  final List<int> wdaymask;
  final List<int> mrange;

  /// Week-number mask (1 = selected), only with BYWEEKNO.
  final List<int>? wnomask;

  YearInfo._(this.yearlen, this.nextyearlen, this.yearordinal, this.yearweekday, this.mmask,
      this.mdaymask, this.nmdaymask, this.wdaymask, this.mrange, this.wnomask);
}

YearInfo rebuildYear(int year, ParsedOptions options) {
  final leap = isLeapYear(year);
  final yearlen = leap ? 366 : 365;
  final nextyearlen = isLeapYear(year + 1) ? 366 : 365;
  final yearordinal = toOrdinal(year, 1, 1);
  final yearweekday = pyWeekday(year, 1, 1);
  final wdaymask = wdayMask.sublist(yearweekday);

  List<int>? wnomask;
  final byweekno = options.byweekno;
  if (notEmpty(byweekno)) {
    final wkst = options.wkst;
    // JavaScript arrays grow on out-of-range writes; leave room for that.
    wnomask = List.filled(yearlen + 7 + 14, 0);
    var no1wkst = pymod(7 - yearweekday + wkst, 7);
    final firstwkst = no1wkst;
    int wyearlen;
    if (no1wkst >= 4) {
      no1wkst = 0;
      // Number of days in the year, plus the days we got from last year.
      wyearlen = yearlen + pymod(yearweekday - wkst, 7);
    } else {
      // Number of days in the year, minus the days we left in last year.
      wyearlen = yearlen - no1wkst;
    }
    final div = wyearlen ~/ 7;
    final mod = pymod(wyearlen, 7);
    final numweeks = div + mod ~/ 4;
    for (var n in byweekno!) {
      if (n < 0) n += numweeks + 1;
      if (!(n > 0 && n <= numweeks)) continue;
      int i;
      if (n > 1) {
        i = no1wkst + (n - 1) * 7;
        if (no1wkst != firstwkst) i -= 7 - firstwkst;
      } else {
        i = no1wkst;
      }
      for (var k = 0; k < 7; k++) {
        wnomask[i] = 1;
        i++;
        if (wdaymask[i] == wkst) break;
      }
    }

    if (byweekno.contains(1)) {
      // Check week number 1 of next year as well.
      var i = no1wkst + numweeks * 7;
      if (no1wkst != firstwkst) i -= 7 - firstwkst;
      if (i < yearlen) {
        // If week starts in next year, we don't care about it.
        for (var j = 0; j < 7; j++) {
          wnomask[i] = 1;
          i += 1;
          if (wdaymask[i] == wkst) break;
        }
      }
    }

    if (no1wkst != 0) {
      // Check last week number of last year as well. If no1wkst is 0, either
      // the year started on week start, or week number 1 got days from last
      // year, so there are no days from last year's last week number in this
      // year.
      int lnumweeks;
      if (!byweekno.contains(-1)) {
        final lyearweekday = pyWeekday(year - 1, 1, 1);
        var lno1wkst = pymod(7 - lyearweekday + wkst, 7);
        final lyearlen = isLeapYear(year - 1) ? 366 : 365;
        int weekst;
        if (lno1wkst >= 4) {
          lno1wkst = 0;
          weekst = lyearlen + pymod(lyearweekday - wkst, 7);
        } else {
          weekst = yearlen - no1wkst;
        }
        lnumweeks = 52 + pymod(weekst, 7) ~/ 4;
      } else {
        lnumweeks = -1;
      }
      if (byweekno.contains(lnumweeks)) {
        for (var i = 0; i < no1wkst; i++) {
          wnomask[i] = 1;
        }
      }
    }
  }

  return YearInfo._(
    yearlen,
    nextyearlen,
    yearordinal,
    yearweekday,
    leap ? m366Mask : m365Mask,
    leap ? mday366Mask : mday365Mask,
    leap ? nmday366Mask : nmday365Mask,
    wdaymask,
    leap ? m366Range : m365Range,
    wnomask,
  );
}

class MonthInfo {
  final int lastyear;
  final int lastmonth;

  /// Nth-weekday mask (1 = selected), only with ordinal BYDAY values.
  final List<int> nwdaymask;

  MonthInfo._(this.lastyear, this.lastmonth, this.nwdaymask);
}

MonthInfo rebuildMonth(
    int year, int month, int yearlen, List<int> mrange, List<int> wdaymask, ParsedOptions options) {
  var ranges = <(int, int)>[];
  if (options.freq == RRuleFrequency.yearly) {
    if (!notEmpty(options.bymonth)) {
      ranges = [(0, yearlen)];
    } else {
      for (final m in options.bymonth!) {
        // mrange.slice(m - 1, m + 1); out-of-range months give no range.
        if (m >= 1 && m <= 12) ranges.add((mrange[m - 1], mrange[m]));
      }
    }
  } else if (options.freq == RRuleFrequency.monthly) {
    ranges = [(mrange[month - 1], mrange[month])];
  }
  if (ranges.isEmpty) return MonthInfo._(year, month, const []);

  // Weekly frequency won't get here, so we may not care about cross-year
  // weekly periods.
  final nwdaymask = List.filled(yearlen, 0);
  for (final (first, end) in ranges) {
    final last = end - 1;
    for (final (wday, n) in options.bynweekday!) {
      int i;
      if (n < 0) {
        i = last + (n + 1) * 7;
        // JavaScript reads undefined (NaN) outside the mask: no match.
        if (i < 0 || i >= wdaymask.length) continue;
        i -= pymod(wdaymask[i] - wday, 7);
      } else {
        i = first + (n - 1) * 7;
        if (i < 0 || i >= wdaymask.length) continue;
        i += pymod(7 - wdaymask[i] + wday, 7);
      }
      if (first <= i && i <= last) nwdaymask[i] = 1;
    }
  }
  return MonthInfo._(year, month, nwdaymask);
}

/// Candidate days of one period: day-of-year indexes (relative to
/// [IterInfo.yearordinal]) starting at [start]; filtered days are set to null.
class DaySet {
  final int start;
  final List<int?> days;
  DaySet(this.start, int end) : days = [for (var i = start; i < end; i++) i];
}

class IterInfo {
  final ParsedOptions options;
  late YearInfo yearinfo;
  MonthInfo? monthinfo;
  int? _yearinfoYear;

  IterInfo(this.options);

  void rebuild(int year, int month) {
    // rrule.js rebuilds the year tables whenever `lastyear` (taken from the
    // month info) differs, i.e. every period without nth weekdays. The tables
    // only depend on the year, so caching them is equivalent.
    if (year != _yearinfoYear) {
      yearinfo = rebuildYear(year, options);
      _yearinfoYear = year;
    }
    if (notEmpty(options.bynweekday) &&
        (month != monthinfo?.lastmonth || year != monthinfo?.lastyear)) {
      monthinfo =
          rebuildMonth(year, month, yearinfo.yearlen, yearinfo.mrange, yearinfo.wdaymask, options);
    }
  }

  int get yearlen => yearinfo.yearlen;
  int get nextyearlen => yearinfo.nextyearlen;
  int get yearordinal => yearinfo.yearordinal;
  List<int> get nwdaymask => monthinfo?.nwdaymask ?? const [];

  DaySet getdayset(RRuleFrequency freq, int year, int month, int day) {
    switch (freq) {
      case RRuleFrequency.yearly:
        return DaySet(0, yearlen);
      case RRuleFrequency.monthly:
        return DaySet(yearinfo.mrange[month - 1], yearinfo.mrange[month]);
      case RRuleFrequency.weekly:
        // We need to handle cross-year weeks here.
        var i = toOrdinal(year, month, day) - yearordinal;
        final start = i;
        for (var j = 0; j < 7; j++) {
          ++i;
          if (yearinfo.wdaymask[i] == options.wkst) break;
        }
        return DaySet(start, i);
      default:
        final i = toOrdinal(year, month, day) - yearordinal;
        return DaySet(i, i + 1);
    }
  }

  List<Time> gettimeset(RRuleFrequency freq, int hour, int minute, int second, int millisecond) {
    switch (freq) {
      case RRuleFrequency.hourly:
        return sortedUnique([
          for (final m in options.byminute!)
            for (final s in options.bysecond!) Time(hour, m, s, millisecond),
        ]);
      case RRuleFrequency.minutely:
        return sortedUnique(
            [for (final s in options.bysecond!) Time(hour, minute, s, millisecond)]);
      case RRuleFrequency.secondly:
        return [Time(hour, minute, second, millisecond)];
      default:
        return const [];
    }
  }
}
