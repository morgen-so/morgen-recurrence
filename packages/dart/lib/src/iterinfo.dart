// Per-year and per-month lookup tables used to filter candidate days.
//
// Ported from rrule.js 2.8.0 (dist/esm/iterinfo/index.js, yearinfo.js,
// monthinfo.js). rrule.js: Copyright 2010, Jakub Roztocil and Lars Schöning.
// Based on python-dateutil: Copyright (c) 2003-2011 Gustavo Niemeyer,
// Copyright (c) 2012 Tomi Pieviläinen. Distributed under the BSD 3-Clause
// licence reproduced in full in the LICENCE file next to this file.
import 'dart:typed_data';

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

/// [buffer] and [previouslySet] let callers reuse one mask across months:
/// only the indexes set last time are cleared.
MonthInfo rebuildMonth(
    int year, int month, int yearlen, List<int> mrange, List<int> wdaymask, ParsedOptions options,
    {Uint8List? buffer, List<int>? previouslySet}) {
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
  final List<int> nwdaymask;
  if (buffer != null) {
    for (final i in previouslySet!) {
      buffer[i] = 0;
    }
    previouslySet.clear();
    nwdaymask = buffer;
  } else {
    nwdaymask = List.filled(yearlen, 0);
  }
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
      if (first <= i && i <= last) {
        nwdaymask[i] = 1;
        previouslySet?.add(i);
      }
    }
  }
  return MonthInfo._(year, month, nwdaymask);
}

Uint8List? _table(List<int>? values, int size, [int sign = 1]) {
  if (values == null || values.isEmpty) return null;
  final t = Uint8List(size);
  for (final v in values) {
    final x = v * sign;
    if (x >= 0 && x < size) t[x] = 1;
  }
  return t;
}

class IterInfo {
  final ParsedOptions options;
  late YearInfo yearinfo;
  MonthInfo? monthinfo;
  int? _yearinfoYear;

  /// Day-of-year indexes of the current period that passed the filters
  /// (see [fillDayset]); reused across periods.
  final Int32List days = Int32List(366 + 7);

  /// Whether the last day of the current period was filtered out (used to
  /// skip ahead in sub-daily frequencies, like rrule.js).
  bool lastFiltered = false;

  // Reused nth-weekday mask (see rebuildMonth).
  final Uint8List _nwBuf = Uint8List(366 + 7);
  final List<int> _nwSet = [];

  // Precomputed BY* membership tables.
  final Uint8List? _bymonth, _byweekday, _bymonthday, _bynmonthday, _byyeardayPos, _byyeardayNeg;
  final bool _hasNth, _hasMonthday, _hasWeekno;

  IterInfo(this.options)
      : _bymonth = _table(options.bymonth, 13),
        _byweekday = _table(options.byweekday, 7),
        _bymonthday = _table(options.bymonthday, 32),
        _bynmonthday = _table(options.bynmonthday, 32, -1),
        _byyeardayPos = _table(options.byyearday, 367),
        _byyeardayNeg = _table(options.byyearday, 367, -1),
        _hasNth = notEmpty(options.bynweekday),
        _hasMonthday = options.bymonthday.isNotEmpty || options.bynmonthday.isNotEmpty,
        _hasWeekno = notEmpty(options.byweekno);

  void rebuild(int year, int month) {
    // rrule.js rebuilds the year tables whenever `lastyear` (taken from the
    // month info) differs, i.e. every period without nth weekdays. The tables
    // only depend on the year, so caching them is equivalent.
    if (year != _yearinfoYear) {
      yearinfo = rebuildYear(year, options);
      _yearinfoYear = year;
    }
    if (_hasNth && (month != monthinfo?.lastmonth || year != monthinfo?.lastyear)) {
      monthinfo = rebuildMonth(
          year, month, yearinfo.yearlen, yearinfo.mrange, yearinfo.wdaymask, options,
          buffer: _nwBuf, previouslySet: _nwSet);
    }
  }

  int get yearlen => yearinfo.yearlen;
  int get nextyearlen => yearinfo.nextyearlen;
  int get yearordinal => yearinfo.yearordinal;
  List<int> get nwdaymask => monthinfo?.nwdaymask ?? const [];

  /// Computes the candidate days of the period starting at (year, month,
  /// day), keeps those passing the BY* filters in [days] and returns how many
  /// there are.
  int fillDayset(RRuleFrequency freq, int year, int month, int day) {
    int start, end;
    switch (freq) {
      case RRuleFrequency.yearly:
        start = 0;
        end = yearlen;
      case RRuleFrequency.monthly:
        start = yearinfo.mrange[month - 1];
        end = yearinfo.mrange[month];
      case RRuleFrequency.weekly:
        // We need to handle cross-year weeks here.
        var i = toOrdinal(year, month, day) - yearordinal;
        start = i;
        for (var j = 0; j < 7; j++) {
          ++i;
          if (yearinfo.wdaymask[i] == options.wkst) break;
        }
        end = i;
      default:
        start = toOrdinal(year, month, day) - yearordinal;
        end = start + 1;
    }
    var n = 0;
    var filtered = false;
    for (var d = start; d < end; d++) {
      filtered = isFiltered(d);
      if (!filtered) days[n++] = d;
    }
    lastFiltered = filtered;
    return n;
  }

  bool isFiltered(int d) {
    final y = yearinfo;
    final bymonth = _bymonth;
    if (bymonth != null && bymonth[y.mmask[d]] != 1) return true;
    if (_hasWeekno && y.wnomask![d] == 0) return true;

    // RFC 5545: a day matches BYDAY if it matches a plain weekday OR an nth
    // weekday. rrule.js (and python-dateutil) require both.
    final byweekday = _byweekday;
    final nw = _hasNth ? monthinfo?.nwdaymask : null;
    if ((byweekday != null || (nw != null && nw.isNotEmpty)) &&
        !(byweekday != null && byweekday[y.wdaymask[d]] == 1) &&
        !(nw != null && d < nw.length && nw[d] == 1)) {
      return true;
    }

    if (_hasMonthday &&
        !(_bymonthday != null && _bymonthday[y.mdaymask[d]] == 1) &&
        !(_bynmonthday != null && _bynmonthday[-y.nmdaymask[d]] == 1)) {
      return true;
    }

    final pos = _byyeardayPos, neg = _byyeardayNeg;
    if (pos != null || neg != null) {
      final yl = y.yearlen;
      // Positive values v match day v - 1; negative ones yearlen + v.
      final p = d < yl ? d + 1 : d + 1 - yl;
      final q = d < yl ? yl - d : y.nextyearlen - (d - yl);
      final hit =
          (pos != null && p < 367 && pos[p] == 1) || (neg != null && q < 367 && neg[q] == 1);
      if (!hit) return true;
    }
    return false;
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
