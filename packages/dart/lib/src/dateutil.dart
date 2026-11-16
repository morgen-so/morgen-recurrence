// Date helpers, masks and the mutable iteration counter of the RRULE engine.
//
// Ported from rrule.js 2.8.0 (dist/esm/dateutil.js, datetime.js, masks.js,
// helpers.js). rrule.js: Copyright 2010, Jakub Roztocil and Lars Schöning.
// Based on python-dateutil: Copyright (c) 2003-2011 Gustavo Niemeyer,
// Copyright (c) 2012 Tomi Pieviläinen. Distributed under the BSD 3-Clause
// licence reproduced in full in the LICENCE file next to this file.
//
// All dates are "floating": DateTime values with isUtc=true holding wall-clock
// fields, so no time zone or DST logic is involved.

/// Same as python's datetime.MAXYEAR; iteration stops past this year.
const int maxYear = 9999;

bool isLeapYear(int year) => (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;

int daysInMonth(int year, int month) => month == 2 && isLeapYear(year) ? 29 : _monthDays[month - 1];

const _monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/// Python-like modulo: the result has the sign of [b].
int pymod(int a, int b) {
  final r = a.remainder(b);
  return r != 0 && (r < 0) != (b < 0) ? r + b : r;
}

/// Python-like floor division.
int floorDiv(int a, int b) => (a - pymod(a, b)) ~/ b;

final DateTime _ordinalBase = DateTime.utc(1970);

/// Days since 1970-01-01 (rrule.js uses that base instead of python's 1-1-1).
int toOrdinal(int year, int month, int day) =>
    DateTime.utc(year, month, day).difference(_ordinalBase).inDays;

DateTime fromOrdinal(int ordinal) => DateTime.utc(1970, 1, 1 + ordinal);

/// Python weekday: MO=0 … SU=6.
int pyWeekday(int year, int month, int day) => DateTime.utc(year, month, day).weekday - 1;

/// Time of day used to build the occurrences of a day.
class Time implements Comparable<Time> {
  final int hour, minute, second, millisecond;
  const Time(this.hour, this.minute, this.second, [this.millisecond = 0]);

  int get _ms => ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;

  @override
  int compareTo(Time other) => _ms.compareTo(other._ms);

  @override
  bool operator ==(Object other) => other is Time && other._ms == _ms;

  @override
  int get hashCode => _ms;
}

/// python's datetime.combine. Out-of-range time fields overflow into the
/// next day exactly like JavaScript's Date.UTC.
DateTime combine(DateTime date, Time time) => DateTime.utc(
    date.year, date.month, date.day, time.hour, time.minute, time.second, time.millisecond);

/// Sorted list without duplicates.
List<T> sortedUnique<T extends Comparable<dynamic>>(Iterable<T> values) {
  final list = values.toSet().toList()..sort();
  return list;
}

// =============================================================================
// Masks (masks.js). Every mask is 7 days longer to handle cross-year weekly
// periods.
// =============================================================================

List<int> _monthLengths(bool leap) => [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

List<int> _range(int start, int end) => [for (var i = start; i < end; i++) i];

List<int> _mmask(bool leap) => [
      for (final (i, len) in _monthLengths(leap).indexed) ...List.filled(len, i + 1),
      ...List.filled(7, 1),
    ];

List<int> _mdaymask(bool leap) => [
      for (final len in _monthLengths(leap)) ..._range(1, len + 1),
      ..._range(1, 8),
    ];

List<int> _nmdaymask(bool leap) => [
      for (final len in _monthLengths(leap)) ..._range(-len, 0),
      ..._range(-31, -24),
    ];

final List<int> m365Mask = List.unmodifiable(_mmask(false));
final List<int> m366Mask = List.unmodifiable(_mmask(true));
final List<int> mday365Mask = List.unmodifiable(_mdaymask(false));
final List<int> mday366Mask = List.unmodifiable(_mdaymask(true));
final List<int> nmday365Mask = List.unmodifiable(_nmdaymask(false));
final List<int> nmday366Mask = List.unmodifiable(_nmdaymask(true));
const List<int> m365Range = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const List<int> m366Range = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];
final List<int> wdayMask = List.unmodifiable([for (var i = 0; i < 55; i++) ..._range(0, 7)]);
