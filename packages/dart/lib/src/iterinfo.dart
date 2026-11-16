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

/// Ordinal (days since 1970-01-01) of the first day of week 1 of [year]: the
/// first week starting on [wkst] with at least 4 days in the year.
int _week1Start(int year, int wkst) {
  final jan1 = toOrdinal(year, 1, 1);
  final delta = pymod(pymod(jan1 + 3, 7) - wkst, 7); // days since week start
  return delta <= 3 ? jan1 - delta : jan1 + 7 - delta;
}

/// BYWEEKNO mask for the days of [year] (plus 7 days of the next year). Every
/// day gets its week-year (previous, current or next) and week number, and
/// matches positive values directly and negative values counted from the end
/// of its own week-year. rrule.js (and python-dateutil) computed the previous
/// year's week count from the current year's values and only spilled week 1
/// into the next year for a literal 1.
List<int> _weekNoMask(int year, int yearlen, int yearordinal, ParsedOptions options) {
  final wkst = options.wkst;
  final starts = [for (var y = year - 1; y <= year + 2; y++) _week1Start(y, wkst)];
  final byweekno = options.byweekno!;
  final mask = List.filled(yearlen + 7, 0);
  // Walk week by week through the week-years overlapping the mask.
  final end = yearordinal + yearlen + 7;
  for (var w = 0; w < 3; w++) {
    final numweeks = (starts[w + 1] - starts[w]) ~/ 7;
    for (var week = 1; week <= numweeks; week++) {
      final first = starts[w] + (week - 1) * 7;
      if (first + 7 <= yearordinal || first >= end) continue;
      if (!byweekno.contains(week) && !byweekno.contains(week - numweeks - 1)) continue;
      final from = first > yearordinal ? first : yearordinal;
      final to = first + 7 < end ? first + 7 : end;
      for (var ord = from; ord < to; ord++) {
        mask[ord - yearordinal] = 1;
      }
    }
  }
  return mask;
}

YearInfo rebuildYear(int year, ParsedOptions options) {
  final leap = isLeapYear(year);
  final yearlen = leap ? 366 : 365;
  final nextyearlen = isLeapYear(year + 1) ? 366 : 365;
  final yearordinal = toOrdinal(year, 1, 1);
  final yearweekday = pyWeekday(year, 1, 1);
  final wdaymask = wdayMask.sublist(yearweekday);

  final byweekno = options.byweekno;
  final wnomask = notEmpty(byweekno) ? _weekNoMask(year, yearlen, yearordinal, options) : null;

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

  /// RFC 7529 SKIP: 0 = omit, 1 = forward, -1 = backward (when applicable).
  late final int _skipMode = _computeSkipMode();

  int _computeSkipMode() {
    // SKIP only changes anything for invalid month days generated by positive
    // BYMONTHDAY values in MONTHLY/YEARLY rules. Invalid dates never pass
    // BYWEEKNO or BYYEARDAY (RFC 8984 section 4.3.3.1).
    final o = options;
    if ((o.freq != RRuleFrequency.monthly && o.freq != RRuleFrequency.yearly) ||
        o.bymonthday.isEmpty ||
        _hasWeekno ||
        notEmpty(o.byyearday)) {
      return 0;
    }
    return switch (o.skip) {
      RRuleSkip.forward => 1,
      RRuleSkip.backward => -1,
      RRuleSkip.omit => 0,
    };
  }

  /// Whether SKIP=FORWARD/BACKWARD is in effect (see [_addSkipped]).
  bool get skips => _skipMode != 0;

  /// Whether a period can produce dates in the next period: only MONTHLY
  /// with SKIP=FORWARD (YEARLY moves stay in the year, December has 31 days).
  bool get spillsForward => _skipMode > 0 && options.freq == RRuleFrequency.monthly;

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
    if (_skipMode != 0) n = _addSkipped(freq, month, n);
    return n;
  }

  /// RFC 7529 / RFC 8984 SKIP: a BYMONTHDAY value beyond the end of a month
  /// (February 30) is an invalid date that is moved to the first day of the
  /// next month (FORWARD) or the last day of the month (BACKWARD), then
  /// checked against BYDAY, and de-duplicated within the period.
  int _addSkipped(RRuleFrequency freq, int month, int n) {
    final y = yearinfo;
    final first = freq == RRuleFrequency.monthly ? month : 1;
    final last = freq == RRuleFrequency.monthly ? month : 12;
    // A date moved FORWARD lands in the next month. Where nth weekdays count
    // within a month (MONTHLY, YEARLY with BYMONTH), it is checked against
    // that month's, not the source month's (RFC 7529 section 4.1: BYDAY
    // applies to the adjusted date). YEARLY nth weekdays count within the
    // year, which the move never leaves (December has 31 days).
    final crossMonth = _skipMode > 0 && (freq == RRuleFrequency.monthly || _bymonth != null);
    var added = false;
    for (var m = first; m <= last; m++) {
      final bymonth = _bymonth;
      if (bymonth != null && bymonth[m] != 1) continue;
      final start = y.mrange[m - 1], end = y.mrange[m];
      if (!options.bymonthday.any((v) => v > end - start)) continue;
      final idx = _skipMode < 0 ? end - 1 : end;
      if (!_matchesByday(idx, crossMonth)) continue;
      var dup = false;
      for (var j = 0; j < n; j++) {
        if (days[j] == idx) dup = true;
      }
      if (!dup) {
        days[n++] = idx;
        added = true;
      }
    }
    if (added) {
      final sorted = days.sublist(0, n)..sort();
      days.setRange(0, n, sorted);
    }
    return n;
  }

  /// BYDAY (plain or nth) check of one day. With [ownMonth], nth weekdays
  /// count within the day's own month rather than the period's mask.
  bool _matchesByday(int d, bool ownMonth) {
    final byweekday = _byweekday;
    if (byweekday == null && !_hasNth) return true;
    if (byweekday != null && byweekday[yearinfo.wdaymask[d]] == 1) return true;
    if (!_hasNth) return false;
    if (!ownMonth) {
      final nw = monthinfo?.nwdaymask;
      return nw != null && d < nw.length && nw[d] == 1;
    }
    final y = yearinfo;
    final m = y.mmask[d];
    final first = y.mrange[m - 1], last = y.mrange[m] - 1;
    for (final (wday, n) in options.bynweekday!) {
      int i;
      if (n < 0) {
        i = last + (n + 1) * 7;
        i -= pymod(y.wdaymask[i] - wday, 7);
      } else {
        i = first + (n - 1) * 7;
        i += pymod(7 - y.wdaymask[i] + wday, 7);
      }
      if (i == d) return true;
    }
    return false;
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
