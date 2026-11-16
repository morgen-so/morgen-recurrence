// Benchmark of the Dart package on the same workloads as packages/ts/bench.
//   dart run bench/bench.dart                      (JIT)
//   dart compile exe bench/bench.dart -o /tmp/b && /tmp/b   (AOT, like the app)
import 'dart:convert';
import 'dart:io';

import 'package:morgen_rrule/morgen_rrule.dart';

DateTime _parse(String s) => DateTime.parse('${s}Z');

double _median(List<double> xs) => (xs.toList()..sort())[xs.length ~/ 2];

void bench(String name, int Function() fn, {int warmup = 3, int rounds = 9}) {
  var out = 0;
  for (var i = 0; i < warmup; i++) {
    out = fn();
  }
  final times = <double>[];
  for (var i = 0; i < rounds; i++) {
    final sw = Stopwatch()..start();
    out = fn();
    times.add(sw.elapsedMicroseconds / 1000);
  }
  print('${name.padRight(58)} ${_median(times).toStringAsFixed(2).padLeft(9)} ms  ($out occurrences)');
}

List<Map<String, dynamic>> _load(String f) =>
    ((jsonDecode(File('../../fixtures/$f').readAsStringSync()) as Map)['cases'] as List)
        .cast<Map<String, dynamic>>();

int expand(List<Map<String, dynamic>> cases, int windowDays) {
  var n = 0;
  for (final c in cases) {
    final start = _parse(c['dtstart'] as String);
    final rule = RRule(RRuleOptions.parse(c['rrule'] as String, dtstart: start));
    n += rule
        .between(start.subtract(const Duration(days: 2)), start.add(Duration(days: windowDays)))
        .length;
  }
  return n;
}

void main() {
  bool nonEmpty(Map<String, dynamic> c) => c['expected'] is List && (c['expected'] as List).isNotEmpty;
  final random = _load('random.json').where(nonEmpty).toList();
  final weekno = _load('weekno.json').where(nonEmpty).toList();
  final empty = _load('random.json').where((c) => c['expected'] is List && (c['expected'] as List).isEmpty).toList();

  print('dart ${Platform.version.split(' ').first}\n');
  bench('random.json rules (${random.length}), expand 1 year', () => expand(random, 365));
  bench('random.json rules (${random.length}), expand 3 years', () => expand(random, 3 * 365), rounds: 5);
  bench('weekno.json rules (${weekno.length}), expand 1 year', () => expand(weekno, 365), rounds: 5);

  const typical = {
    'weekly MO,WE,FR': 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'daily': 'FREQ=DAILY',
    'weekdays': 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    'monthly 2nd Tuesday': 'FREQ=MONTHLY;BYDAY=2TU',
    'monthly last weekday (BYSETPOS)': 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    'yearly': 'FREQ=YEARLY',
    'every 2 weeks TU,TH': 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH',
  };
  for (final e in typical.entries) {
    final c = {'dtstart': '2020-03-02T09:30:00', 'rrule': e.value};
    bench('${e.key}: 1000 x expand 2020..2026', () {
      var n = 0;
      for (var i = 0; i < 1000; i++) {
        n += expand([c], 6 * 365);
      }
      return n ~/ 1000;
    }, rounds: 5);
  }

  bench('daily, 50 years, all() with COUNT=18250', () {
    return RRule(RRuleOptions(freq: RRuleFrequency.daily, dtstart: _parse('2000-01-01T09:00:00'), count: 18250))
        .all()
        .length;
  }, rounds: 5);
  bench('hourly, 1 year window', () {
    return RRule(RRuleOptions(freq: RRuleFrequency.hourly, dtstart: _parse('2024-01-01T00:00:00')))
        .between(_parse('2024-01-01T00:00:00'), _parse('2025-01-01T00:00:00'))
        .length;
  }, rounds: 5);
  bench('never-matching rules (${empty.length}), 10-year between', () {
    var n = 0;
    for (final c in empty) {
      final q = c['query'] as Map;
      n += RRule(RRuleOptions.parse(c['rrule'] as String, dtstart: _parse(c['dtstart'] as String)))
          .between(_parse(q['after'] as String), _parse(q['before'] as String))
          .length;
    }
    return n;
  }, rounds: 3);
}
