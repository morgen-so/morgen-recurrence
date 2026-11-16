// Direct tests of the oracle, with hand-checked expectations (not taken from
// either package): early termination of limited queries.
//   node --test tools/verify/oracle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { oracle } from './oracle.mjs';

const q = (dtstart, rrule, query) => oracle({ dtstart, rrule, query });
const between = (after, before, inc, limit) => ({ method: 'between', after, before, inc, limit });
// Daily at 09:00 from January 1, 2024: the 32nd occurrence is February 1.
const D = '2024-01-01T09:00:00';

test('between with a limit, window long after DTSTART (recheck G03)', () => {
  assert.deepEqual(q(D, 'FREQ=DAILY', between('2024-02-01T00:00:00', '2024-02-05T00:00:00', true, 2)),
    ['2024-02-01T09:00:00', '2024-02-02T09:00:00']);
  assert.deepEqual(q(D, 'FREQ=DAILY', between('2024-06-10T09:00:00', '2024-06-20T00:00:00', false, 3)),
    ['2024-06-11T09:00:00', '2024-06-12T09:00:00', '2024-06-13T09:00:00']);
});

test('COUNT below, across and above the window', () => {
  const w = between('2024-02-01T00:00:00', '2024-02-05T00:00:00', true, 5);
  assert.deepEqual(q(D, 'FREQ=DAILY;COUNT=10', w), []);
  assert.deepEqual(q(D, 'FREQ=DAILY;COUNT=33', w), ['2024-02-01T09:00:00', '2024-02-02T09:00:00']);
  assert.deepEqual(q(D, 'FREQ=DAILY;COUNT=40', { ...w, limit: 2 }), ['2024-02-01T09:00:00', '2024-02-02T09:00:00']);
});

test('after and all with limits', () => {
  assert.equal(q(D, 'FREQ=DAILY;COUNT=5', { method: 'after', dt: '2024-01-10T00:00:00', inc: false }), null);
  assert.equal(q(D, 'FREQ=DAILY', { method: 'after', dt: '2024-03-01T09:00:00', inc: true }), '2024-03-01T09:00:00');
  assert.deepEqual(q(D, 'FREQ=DAILY', { method: 'all', limit: 2 }), ['2024-01-01T09:00:00', '2024-01-02T09:00:00']);
});

test('SKIP overlap at the window bounds', () => {
  // Feb: Feb 1 09:00 and the moved Mar 1 18:00; March: Mar 1 09:00, Mar 31 18:00.
  const O = 'FREQ=MONTHLY;BYMONTHDAY=1,31;BYHOUR=9,18;BYSETPOS=1,-1;RSCALE=GREGORIAN;SKIP=FORWARD;UNTIL=20240401T000000';
  const S = '2024-02-01T09:00:00';
  assert.deepEqual(q(S, O, between('2024-03-01T09:00:00', '2024-03-31T18:00:00', true, 2)),
    ['2024-03-01T09:00:00', '2024-03-01T18:00:00']);
  assert.deepEqual(q(S, O, between('2024-03-01T09:00:00', '2024-03-31T18:00:00', false, 5)),
    ['2024-03-01T18:00:00']);
  assert.equal(q(S, O, { method: 'after', dt: '2024-03-01T09:00:00', inc: true }), '2024-03-01T09:00:00');
  assert.equal(q(S, O, { method: 'before', dt: '2024-03-01T18:00:00', inc: true }), '2024-03-01T18:00:00');
});

test('search horizon: 400 * INTERVAL years, else out of scope', () => {
  // February 29 on a Monday: 2044, 2072, then 2112 (2100 is not a leap year).
  assert.deepEqual(q('2024-01-01T09:00:00', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO;COUNT=3', { method: 'all' }),
    ['2044-02-29T09:00:00', '2072-02-29T09:00:00', '2112-02-29T09:00:00']);
  // 20 such dates need more than 400 years: not answered rather than truncated.
  assert.equal(q('2024-01-01T09:00:00', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO;COUNT=20', { method: 'all' }), undefined);
  // A rule that never matches is proven empty by one full cycle.
  assert.deepEqual(q('2024-01-01T09:00:00', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', { method: 'all' }), []);
});
