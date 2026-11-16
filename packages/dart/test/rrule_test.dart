// Focused tests of the Dart port (copied from the mobile app).
// The shared conformance fixtures run in conformance_test.dart.
//
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:morgen_rrule/morgen_rrule.dart';

DateTime _d(String s) => DateTime.parse('${s}Z');

String _fmt(DateTime d) => d.toIso8601String().substring(0, 19);

List<String> _all(RRuleOptions o, {int limit = 100}) =>
    RRule(o).all(limit: limit).map(_fmt).toList();

List<String> _between(RRuleOptions o, String after, String before, {bool inclusive = true}) =>
    RRule(o).between(_d(after), _d(before), inclusive: inclusive).map(_fmt).toList();

List<String> _js(Map<String, dynamic> rule, String start, {int limit = 100}) =>
    _all(RRuleOptions.fromJsCalendar(rule, _d(start))!, limit: limit);

void main() {
  group('floating times', () {
    test('keeps the wall-clock time across DST changes', () {
      // 2024-03-31 and 2024-10-27 are DST switches in Europe, 2024-03-10 in the US.
      final got = _between(
          RRuleOptions(freq: RRuleFrequency.daily, dtstart: _d('2024-03-09T09:30:00')),
          '2024-03-09T00:00:00',
          '2024-04-01T23:59:59');
      expect(got, hasLength(24));
      expect(got.every((s) => s.endsWith('T09:30:00')), isTrue);
    });

    test('results are UTC DateTimes; local inputs are read by their fields', () {
      final rule = RRule(
          RRuleOptions(freq: RRuleFrequency.weekly, dtstart: DateTime(2024, 3, 25, 8), count: 2));
      final got = rule.all();
      expect(got.every((d) => d.isUtc), isTrue);
      expect(got.map(_fmt), ['2024-03-25T08:00:00', '2024-04-01T08:00:00']);
    });
  });

  group('COUNT and UNTIL', () {
    test('COUNT limits the number of occurrences', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.monthly, dtstart: _d('2024-01-31T10:00:00'), count: 3)),
          ['2024-01-31T10:00:00', '2024-03-31T10:00:00', '2024-05-31T10:00:00']);
    });

    test('UNTIL is inclusive', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.daily,
              dtstart: _d('2024-01-01T10:00:00'),
              until: _d('2024-01-03T10:00:00'))),
          ['2024-01-01T10:00:00', '2024-01-02T10:00:00', '2024-01-03T10:00:00']);
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.daily,
              dtstart: _d('2024-01-01T10:00:00'),
              until: _d('2024-01-03T09:59:59'))),
          hasLength(2));
    });

    test('COUNT counts occurrences before the between() window', () {
      final o =
          RRuleOptions(freq: RRuleFrequency.daily, dtstart: _d('2024-01-01T10:00:00'), count: 5);
      expect(_between(o, '2024-01-04T00:00:00', '2024-12-31T00:00:00'),
          ['2024-01-04T10:00:00', '2024-01-05T10:00:00']);
    });

    test('DTSTART not matching the rule is not an occurrence', () {
      // 2024-01-01 is a Monday.
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.weekly,
              dtstart: _d('2024-01-01T10:00:00'),
              byweekday: [RRuleWeekday.we],
              count: 2)),
          ['2024-01-03T10:00:00', '2024-01-10T10:00:00']);
    });

    test('exclusive between() drops occurrences on the bounds', () {
      final o = RRuleOptions(freq: RRuleFrequency.daily, dtstart: _d('2024-01-01T10:00:00'));
      expect(_between(o, '2024-01-02T10:00:00', '2024-01-04T10:00:00', inclusive: false),
          ['2024-01-03T10:00:00']);
    });
  });

  group('BYSETPOS', () {
    test('last weekday of the month', () {
      expect(
          _js({
            'frequency': 'monthly',
            'byDay': [
              for (final d in ['mo', 'tu', 'we', 'th', 'fr']) {'day': d}
            ],
            'bySetPosition': [-1],
            'count': 3,
          }, '2024-01-01T09:00:00'),
          ['2024-01-31T09:00:00', '2024-02-29T09:00:00', '2024-03-29T09:00:00']);
    });

    test('several positions, also with times', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.weekly,
              dtstart: _d('2024-01-01T00:00:00'),
              byweekday: [RRuleWeekday.mo, RRuleWeekday.fr],
              byhour: [9, 17],
              byminute: [0],
              bysetpos: [2, -1],
              count: 4)),
          [
            '2024-01-01T17:00:00',
            '2024-01-05T17:00:00',
            '2024-01-08T17:00:00',
            '2024-01-12T17:00:00'
          ]);
    });

    test('positions beyond the set select nothing and are not duplicated', () {
      // rrule.js returns the first Monday for -6 and emits the last one twice.
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.monthly,
              dtstart: _d('2024-01-01T09:00:00'),
              byweekday: [RRuleWeekday.mo],
              bysetpos: [-1, -6, 5],
              count: 3)),
          ['2024-01-29T09:00:00', '2024-02-26T09:00:00', '2024-03-25T09:00:00']);
    });
  });

  group('week start', () {
    // RFC 5545 section 3.3.10 example.
    RRuleOptions rule(RRuleWeekday wkst) => RRuleOptions(
        freq: RRuleFrequency.weekly,
        dtstart: _d('1997-08-05T09:00:00'),
        interval: 2,
        count: 4,
        byweekday: [RRuleWeekday.tu, RRuleWeekday.su],
        wkst: wkst);

    test('WKST=MO', () {
      expect(_all(rule(RRuleWeekday.mo)), [
        '1997-08-05T09:00:00',
        '1997-08-10T09:00:00',
        '1997-08-19T09:00:00',
        '1997-08-24T09:00:00'
      ]);
    });

    test('WKST=SU', () {
      expect(_all(rule(RRuleWeekday.su)), [
        '1997-08-05T09:00:00',
        '1997-08-17T09:00:00',
        '1997-08-19T09:00:00',
        '1997-08-31T09:00:00'
      ]);
    });
  });

  group('year-based rules', () {
    test('BYWEEKNO=20;BYDAY=MO (RFC 5545)', () {
      expect(
          _js({
            'frequency': 'yearly',
            'byWeekNo': [20],
            'byDay': [
              {'day': 'mo'}
            ],
            'count': 3,
          }, '1997-05-12T09:00:00'),
          ['1997-05-12T09:00:00', '1998-05-11T09:00:00', '1999-05-17T09:00:00']);
    });

    test('BYWEEKNO=1 can fall in the previous year', () {
      // ISO week 1 of 2025 starts on Monday 2024-12-30.
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.yearly,
              dtstart: _d('2024-06-01T09:00:00'),
              byweekno: [1],
              byweekday: [RRuleWeekday.mo],
              count: 2)),
          ['2024-12-30T09:00:00', '2025-12-29T09:00:00']);
    });

    test('negative BYYEARDAY', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.yearly,
              dtstart: _d('2023-01-01T09:00:00'),
              byyearday: [-1, -366],
              count: 4)),
          [
            '2023-12-31T09:00:00',
            '2024-01-01T09:00:00',
            '2024-12-31T09:00:00',
            '2025-12-31T09:00:00'
          ]);
    });

    test('Feb 29 yearly only occurs in leap years', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.yearly, dtstart: _d('2096-02-29T12:00:00'), count: 3)),
          ['2096-02-29T12:00:00', '2104-02-29T12:00:00', '2108-02-29T12:00:00']);
    });

    test('monthly on the 31st skips shorter months', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.monthly, dtstart: _d('2024-08-31T08:00:00'), count: 3)),
          ['2024-08-31T08:00:00', '2024-10-31T08:00:00', '2024-12-31T08:00:00']);
    });
  });

  group('BYDAY with plain and nth weekdays (union, RFC 5545)', () {
    test('MONTHLY;BYDAY=2WE,SA', () {
      // rrule.js yields nothing here.
      expect(
          _js({
            'frequency': 'monthly',
            'byDay': [
              {'day': 'we', 'nthOfPeriod': 2},
              {'day': 'sa'},
            ],
            'count': 7,
          }, '2024-01-01T09:00:00'),
          [
            '2024-01-06T09:00:00',
            '2024-01-10T09:00:00',
            '2024-01-13T09:00:00',
            '2024-01-20T09:00:00',
            '2024-01-27T09:00:00',
            '2024-02-03T09:00:00',
            '2024-02-10T09:00:00',
          ]);
    });

    test('YEARLY;BYMONTH=3;BYDAY=-1SU,MO', () {
      final got = _js({
        'frequency': 'yearly',
        'byMonth': ['3'],
        'byDay': [
          {'day': 'su', 'nthOfPeriod': -1},
          {'day': 'mo'},
        ],
        'until': '2024-03-31T23:00:00',
      }, '2024-01-01T09:00:00');
      expect(got, [
        '2024-03-04T09:00:00',
        '2024-03-11T09:00:00',
        '2024-03-18T09:00:00',
        '2024-03-25T09:00:00',
        '2024-03-31T09:00:00',
      ]);
    });
  });

  group('time parts', () {
    test('BYHOUR/BYMINUTE are emitted in chronological order', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.daily,
              dtstart: _d('2024-01-01T00:00:00'),
              byhour: [18, 9, 9],
              byminute: [30, 0],
              count: 5)),
          [
            '2024-01-01T09:00:00',
            '2024-01-01T09:30:00',
            '2024-01-01T18:00:00',
            '2024-01-01T18:30:00',
            '2024-01-02T09:00:00',
          ]);
    });

    test('hourly with BYHOUR', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.hourly,
              dtstart: _d('2024-01-01T07:15:00'),
              interval: 4,
              byhour: [11, 19],
              count: 4)),
          [
            '2024-01-01T11:15:00',
            '2024-01-01T19:15:00',
            '2024-01-02T11:15:00',
            '2024-01-02T19:15:00'
          ]);
    });
  });

  group('never hangs', () {
    final impossible = {
      'DAILY;BYDAY=SA,MO;BYSETPOS=2': RRuleOptions(
          freq: RRuleFrequency.daily,
          dtstart: _d('2024-01-01T09:00:00'),
          byweekday: [RRuleWeekday.sa, RRuleWeekday.mo],
          bysetpos: [2]),
      'YEARLY;BYMONTH=2;BYMONTHDAY=30': RRuleOptions(
          freq: RRuleFrequency.yearly,
          dtstart: _d('2024-01-01T09:00:00'),
          bymonth: [2],
          bymonthday: [30]),
      'MONTHLY;BYDAY=5MO;BYMONTH=2;BYMONTHDAY=1': RRuleOptions(
          freq: RRuleFrequency.monthly,
          dtstart: _d('2024-01-01T09:00:00'),
          byweekday: [RRuleWeekday.mo.nth(5)],
          bymonth: [2],
          bymonthday: [1]),
    };

    impossible.forEach((name, o) {
      test('$name stops at the between() bound', () {
        final sw = Stopwatch()..start();
        expect(RRule(o).between(_d('2024-01-01T00:00:00'), _d('2034-01-01T00:00:00')), isEmpty);
        expect(sw.elapsedMilliseconds, lessThan(500));
      });

      test('$name with COUNT stops at maxPeriods', () {
        final sw = Stopwatch()..start();
        expect(RRule(o, maxPeriods: 10000).all(), isEmpty);
        expect(sw.elapsedMilliseconds, lessThan(2000));
      });
    });

    test('unreachable sub-daily BYHOUR terminates (rrule.js loops forever)', () {
      final o = RRuleOptions(
          freq: RRuleFrequency.hourly,
          dtstart: _d('2024-01-01T00:00:00'),
          interval: 6,
          byhour: [3],
          count: 10);
      expect(RRule(o).all(), isEmpty);
    });

    test('INTERVAL=0 yields nothing', () {
      expect(
          _all(RRuleOptions(
              freq: RRuleFrequency.daily, dtstart: _d('2024-01-01T00:00:00'), interval: 0)),
          isEmpty);
    });
  });

  group('fromJsCalendar', () {
    test('converts all rule parts', () {
      final o = RRuleOptions.fromJsCalendar({
        '@type': 'RecurrenceRule',
        'frequency': 'monthly',
        'interval': 2,
        'firstDayOfWeek': 'su',
        'byDay': [
          {'@type': 'NDay', 'day': 'mo', 'nthOfPeriod': -1},
          {'@type': 'NDay', 'day': 'fr'},
        ],
        'byMonthDay': [1, -1],
        'byMonth': ['1', '2L', '12'],
        'byYearDay': [100],
        'byWeekNo': [3],
        'byHour': [9],
        'byMinute': [30],
        'bySecond': [0],
        'bySetPosition': [1, -1],
        'until': '2025-01-01T00:00:00',
      }, _d('2024-01-01T09:30:00'))!;
      expect(o.freq, RRuleFrequency.monthly);
      expect(o.interval, 2);
      expect(o.wkst, RRuleWeekday.su);
      expect(o.byweekday, [RRuleWeekday.mo.nth(-1), RRuleWeekday.fr]);
      expect(o.bymonthday, [1, -1]);
      expect(o.bymonth, [1, 12]);
      expect(o.byyearday, [100]);
      expect(o.byweekno, [3]);
      expect(o.byhour, [9]);
      expect(o.byminute, [30]);
      expect(o.bysecond, [0]);
      expect(o.bysetpos, [1, -1]);
      expect(o.until, _d('2025-01-01T00:00:00'));
      expect(o.count, isNull);
    });

    test('unsupported rules', () {
      final start = _d('2024-01-01T09:00:00');
      expect(RRuleOptions.fromJsCalendar({'frequency': 'fortnightly'}, start), isNull);
      expect(
          RRuleOptions.fromJsCalendar({'frequency': 'yearly', 'rscale': 'hebrew'}, start), isNull);
      expect(RRuleOptions.fromJsCalendar({'frequency': 'yearly', 'rscale': 'GREGORIAN'}, start),
          isNotNull);
      // Only leap months: never occurs in the gregorian calendar.
      expect(
          _js({
            'frequency': 'yearly',
            'byMonth': ['5L']
          }, '2024-01-01T09:00:00'),
          isEmpty);
    });

    test('nthOfPeriod is ignored for weekly rules (like rrule.js)', () {
      expect(
          _js({
            'frequency': 'weekly',
            'byDay': [
              {'day': 'tu', 'nthOfPeriod': 2}
            ],
            'count': 2,
          }, '2024-01-01T09:00:00'),
          ['2024-01-02T09:00:00', '2024-01-09T09:00:00']);
    });
  });

  group('iterate(before:) (review R04)', () {
    RRule rule(String r) => RRule(RRuleOptions.parse(r, dtstart: _d('2024-01-01T09:00:00')));
    List<String> it(RRule r, String before) =>
        r.iterate(before: _d(before)).take(10).map(_fmt).toList();

    test('bound before DTSTART yields nothing', () {
      expect(it(rule('FREQ=DAILY'), '2024-01-01T08:00:00'), isEmpty);
    });
    test('bound equal to an occurrence includes it', () {
      expect(it(rule('FREQ=DAILY'), '2024-01-02T09:00:00'),
          ['2024-01-01T09:00:00', '2024-01-02T09:00:00']);
    });
    test('no dates after the bound inside a monthly period', () {
      expect(it(rule('FREQ=MONTHLY;BYDAY=MO'), '2024-01-08T09:00:00'),
          ['2024-01-01T09:00:00', '2024-01-08T09:00:00']);
    });
    test('no dates after the bound inside a yearly period', () {
      expect(it(rule('FREQ=YEARLY;BYMONTH=1;BYDAY=MO'), '2024-01-10T00:00:00'),
          ['2024-01-01T09:00:00', '2024-01-08T09:00:00']);
    });
    test('BYSETPOS branch respects the bound', () {
      expect(it(rule('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1,-1'), '2024-01-08T09:00:00'),
          ['2024-01-01T09:00:00']);
    });
  });
  // Recheck F01: SKIP=FORWARD moves Feb 31 into March, inside the next period.
  // February: Feb 1 09/18, Mar 1 09/18 (moved) -> BYSETPOS 1,-1 = Feb 1 09:00,
  // Mar 1 18:00. March: Mar 1 09/18, Mar 31 09/18 -> Mar 1 09:00, Mar 31
  // 18:00. Hand-checked; the same cases are in fixtures/regressions.json.
  group('SKIP across periods (recheck F01)', () {
    const spec = 'FREQ=MONTHLY;BYMONTHDAY=1,31;BYHOUR=9,18;BYSETPOS=1,-1;'
        'RSCALE=GREGORIAN;SKIP=FORWARD';
    RRule rule(String rest) =>
        RRule(RRuleOptions.parse('$spec;$rest', dtstart: _d('2024-02-01T09:00:00')));
    final until = rule('UNTIL=20240401T000000Z');

    test('all in chronological order', () {
      expect(until.all().map(_fmt), [
        '2024-02-01T09:00:00',
        '2024-03-01T09:00:00',
        '2024-03-01T18:00:00',
        '2024-03-31T18:00:00',
      ]);
    });
    test('after, before, between', () {
      expect(_fmt(until.after(_d('2024-02-01T09:00:00'))!), '2024-03-01T09:00:00');
      expect(_fmt(until.before(_d('2024-03-01T18:00:00'))!), '2024-03-01T09:00:00');
      expect(
          until
              .between(_d('2024-03-01T00:00:00'), _d('2024-03-01T12:00:00'), inclusive: true)
              .map(_fmt),
          ['2024-03-01T09:00:00']);
    });
    test('iterate(before:) inside the overlap', () {
      expect(until.iterate(before: _d('2024-03-01T12:00:00')).map(_fmt),
          ['2024-02-01T09:00:00', '2024-03-01T09:00:00']);
    });
    test('UNTIL inside the overlap and COUNT', () {
      expect(rule('UNTIL=20240301T120000Z').all().map(_fmt),
          ['2024-02-01T09:00:00', '2024-03-01T09:00:00']);
      expect(rule('COUNT=3').all().map(_fmt),
          ['2024-02-01T09:00:00', '2024-03-01T09:00:00', '2024-03-01T18:00:00']);
    });
    test('a date selected by both periods is yielded once', () {
      final r = RRule(RRuleOptions.parse(
          'FREQ=MONTHLY;BYMONTHDAY=1,31;BYSETPOS=1,-1;RSCALE=GREGORIAN;SKIP=FORWARD;COUNT=4',
          dtstart: _d('2024-02-01T09:00:00')));
      expect(r.all().map(_fmt), [
        '2024-02-01T09:00:00',
        '2024-03-01T09:00:00',
        '2024-03-31T09:00:00',
        '2024-04-01T09:00:00',
      ]);
    });
  });

  // Recheck F06: a moved date is tested against the nth weekdays of the month
  // it lands in. 2023: Jan 31 is a Tuesday, May 1 a Monday (first of May).
  group('SKIP with nth BYDAY (recheck F06)', () {
    test('Apr 31 -> May 1 matches 1MO of May', () {
      final r = RRule(RRuleOptions.parse(
          'FREQ=MONTHLY;BYMONTHDAY=31;BYDAY=1MO,TU;RSCALE=GREGORIAN;SKIP=FORWARD;'
          'UNTIL=20230502T000000Z',
          dtstart: _d('2023-01-31T09:00:00')));
      expect(r.all().map(_fmt), ['2023-01-31T09:00:00', '2023-05-01T09:00:00']);
    });
    test('JSCalendar form', () {
      expect(
          _js({
            '@type': 'RecurrenceRule',
            'frequency': 'monthly',
            'byMonthDay': [31],
            'byDay': [
              {'@type': 'NDay', 'day': 'mo', 'nthOfPeriod': 1},
              {'@type': 'NDay', 'day': 'tu'},
            ],
            'skip': 'forward',
            'until': '2023-05-02T00:00:00',
          }, '2023-01-31T09:00:00'),
          ['2023-01-31T09:00:00', '2023-05-01T09:00:00']);
    });
  });
  // Second recheck G02: SKIP rules must not materialize a whole period
  // before yielding. A child VM with a 64 MB heap runs the densest rule.
  group('dense SKIP rules stay bounded (recheck G02)', () {
    for (final freq in ['YEARLY', 'MONTHLY']) {
      for (final skip in ['OMIT', 'BACKWARD', 'FORWARD']) {
        test('$freq SKIP=$skip', () {
          final r = Process.runSync(Platform.resolvedExecutable, [
            '--old-gen-heap-size=64',
            '--packages=.dart_tool/package_config.json',
            'test/support/dense_skip.dart',
            freq,
            skip,
          ]);
          expect(r.exitCode, 0, reason: '${r.stderr}');
          expect(jsonDecode(r.stdout as String), {
            'count1': ['2024-01-01T00:00:00.000Z'],
            'take2': ['2024-01-01T00:00:00.000Z', '2024-01-01T00:00:01.000Z'],
            'after': '2024-01-01T00:00:01.000Z',
          });
        });
      }
    }
  });
}
